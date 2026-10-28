/* ═══════════════════════════════════════
   RESTART RECOVERY
   Render's free tier wipes state.json and trade-log.json on every redeploy,
   so a trade that is still open on Bybit can vanish from the dashboard and
   logbook even though the position, stop and take profit are all still live.
   Bybit remembers; this reads its open positions and puts back any the bot
   no longer knows about. Signal details (which daily pattern, the 30m
   confirmation) are gone for good, so those are labelled as unavailable.
   Adopted trades live in state.adopted until their position closes.
═══════════════════════════════════════ */
const stateMod = require('./state');
const bybit = require('./bybit');
const tradelog = require('./tradelog');

// A position this young may belong to a confirmation that is still mid-flight
// (order placed, log row not written yet) — leave it for the next pass.
const SETTLE_MS = 3 * 60 * 1000;

function pct(a, b) {
  return Math.abs((a - b) / b * 100).toFixed(2);
}

function buildItem(p) {
  const entry = p.avgPrice;
  const dir = p.direction;
  const tpOk = p.takeProfit && (dir === 'bull' ? p.takeProfit > entry : p.takeProfit < entry);
  const trailingPct = p.trailingStop && entry ? parseFloat((p.trailingStop / entry * 100).toFixed(2)) : null;
  return {
    symbol: p.symbol,
    direction: dir,
    signal1d: 'Recovered from Bybit after a restart. Original signal details are unavailable.',
    confirmed: true,
    recovered: true,
    alerted: true,
    confirmedAt: p.createdTime || Date.now(),
    confirmationPrice: entry,
    entryPrice: entry,
    tpLevel: tpOk ? p.takeProfit : null,
    tpGain: tpOk ? pct(p.takeProfit, entry) : null,
    tpSource: null,
    slLevel: p.stopLoss || null,
    slRisk: p.stopLoss ? pct(p.stopLoss, entry) : null,
    slSource: null,
    sizeQty: p.size,
    sizeNotional: p.size * entry,
    sizeLeverage: p.leverage || null,
    trailingPct,
    bybitResult: {
      placed: true,
      symbol: p.symbol,
      qty: p.size,
      entry,
      sl: p.stopLoss || null,
      tp: tpOk ? p.takeProfit : null,
      trailing: p.trailingStop || null,
      trailingActivePrice: p.activePrice || null
    }
  };
}

// The trade log row survived (only the dashboard list was reset by the daily
// rollover), so rebuild the item from it: the real signal text, sources and
// confirmation time are all still there. Live levels come from Bybit.
function buildItemFromRow(row, p) {
  const item = buildItem(p);
  item.recovered = false;
  item.signal1d = row.signal1d && row.signal1d !== '—' ? row.signal1d : item.signal1d;
  item.confirmedAt = row.confirmedAtMs || item.confirmedAt;
  if (row.confirmationPrice) item.confirmationPrice = row.confirmationPrice;
  if (row.entryPrice) item.entryPrice = row.entryPrice;
  for (const f of ['tpLevel', 'tpGain', 'tpSource', 'slLevel', 'slRisk', 'slSource', 'trailingPct', 'sizeLeverage']) {
    if (row[f] != null) item[f] = row[f];
  }
  item.exhaustedEntry = !!(row.notes && /exhausted/i.test(row.notes));
  item.bybitResult.orderId = row.bybitOrderId || null;
  return item;
}

// Pure-ish core, exported for testing: takes the open positions, updates
// state + trade log, returns how many were adopted / dropped.
function reconcile(positions, now = Date.now()) {
  const st = stateMod.state;
  const before = Array.isArray(st.adopted) ? st.adopted : [];
  const openKey = new Set(positions.map(p => `${p.symbol}:${p.direction}`));

  // Closed since last time → no longer shown as an open trade. (Its logbook
  // row gets its real result from the normal Bybit outcome check.)
  let adopted = before.filter(a => openKey.has(`${a.symbol}:${a.direction}`));
  const dropped = before.length - adopted.length;
  let added = 0;

  for (const p of positions) {
    if (!p.avgPrice || p.avgPrice <= 0) continue;
    if (p.createdTime && now - p.createdTime < SETTLE_MS) continue;
    if (adopted.some(a => a.symbol === p.symbol && a.direction === p.direction)) continue;

    const row = (stateMod.tradeLog || []).find(t =>
      t.symbol === p.symbol && t.direction === p.direction && t.bybitPlaced && (!t.autoOutcome || t.autoOutcome === 'open'));
    if (row) {
      // Already in the logbook: just put it back on the Confirmed page.
      const it = buildItemFromRow(row, p);
      it.restored = true;
      adopted.push(it);
      try {
        const sets = stateMod.alertSets();
        sets.confirmed.add(p.symbol);
        stateMod.saveAlertSets(sets);
      } catch (_) {}
      added++;
      console.log(`[recover] restored ${p.symbol} ${p.direction} to the Confirmed page (still open on Bybit)`);
      continue;
    }

    const item = buildItem(p);
    item.restored = true;
    const newRow = tradelog.logTrade(item, null, 'confirmed');
    newRow.notes = 'Stop loss and take profit shown are the ones on Bybit now.';
    newRow.recovered = true;
    stateMod.saveTradeLog();
    adopted.push(item);

    // Stop the scan treating this symbol as fresh.
    try {
      const sets = stateMod.alertSets();
      sets.confirmed.add(p.symbol);
      stateMod.saveAlertSets(sets);
    } catch (_) {}
    added++;
    console.log(`[recover] adopted open ${p.symbol} ${p.direction} from Bybit (qty ${p.size}, entry ${p.avgPrice})`);
  }

  if (added || dropped || before.length !== adopted.length) {
    st.adopted = adopted;
    stateMod.save();
  } else if (!Array.isArray(st.adopted)) {
    st.adopted = adopted;
  }
  return { added, dropped };
}

async function recoverOpenPositions() {
  if (!bybit.AUTO_TRADE) return null;
  let positions;
  try {
    positions = await bybit.listOpenPositions();
  } catch (e) {
    console.log('[recover] could not read Bybit positions:', e.message);
    return null; // never touch state on a failed read
  }
  return reconcile(positions);
}

// Dashboard view: adopted trades appear as confirmed entries. A waiting tile
// for the same pair is replaced, since the trade is already open.
function mergeAdopted(list) {
  const adopted = stateMod.state.adopted || [];
  if (!adopted.length) return list;
  const have = new Set(adopted.map(a => `${a.symbol}:${a.direction}`));
  const kept = (list || []).filter(i =>
    !have.has(`${i.symbol}:${i.direction}`) || (i.confirmed && !i.restored));
  const keptKeys = new Set(kept.filter(i => i.confirmed).map(i => `${i.symbol}:${i.direction}`));
  return kept.concat(adopted.filter(a => !keptKeys.has(`${a.symbol}:${a.direction}`)));
}

module.exports = { recoverOpenPositions, reconcile, mergeAdopted, buildItem };

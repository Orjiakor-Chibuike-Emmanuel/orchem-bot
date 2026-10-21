/* ═══════════════════════════════════════
   TRADE LOG — ported from index-v15.html
═══════════════════════════════════════ */
const stateMod = require('./state');
const { fetchKlines } = require('./bybitMarket');
const { getSignalAge } = require('./boundary');
const bybit = require('./bybit');

function fmt(p) {
  if (!p) return '—';
  return p >= 1
    ? p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
    : p.toPrecision(4);
}

function logTrade(item, result2h, entryStatus = 'confirmed') {
  const age = item.detectedAt ? getSignalAge(item.detectedAt) : null;
  const entry = {
    id: Date.now() + Math.floor(Math.random() * 1000), // avoid same-ms collisions across symbols
    loggedAt: Date.now(),
    date: new Date().toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
    symbol: item.symbol,
    direction: item.direction,
    signal1d: item.signal1d || '—',
    entryStatus,
    // confirmationPrice is the 30min candle close everything was planned
    // against — fixed, never overwritten. entryPrice is the real Bybit
    // fill when the trade actually executed (falls back to the same
    // confirmation price when it didn't, e.g. auto-trading was off).
    confirmationPrice: item.confirmationPrice || (result2h ? result2h.closePrice : item.entryPrice),
    entryPrice: item.entryPrice || (result2h ? result2h.closePrice : null),
    tpLevel: item.tpLevel,
    tpGain: item.tpGain,
    tpSource: item.tpSource || null,
    slLevel: item.slLevel,
    slRisk: item.slRisk,
    slSource: item.slSource || null,
    sizeQty: item.sizeQty || null,
    sizeNotional: item.sizeNotional || null,
    sizeLeverage: item.sizeLeverage || null,
    trailingPct: item.trailingPct,
    signalAge: age ? `${age.hours}h (${age.label})` : '—',
    confirmTime: result2h ? result2h.dateStr : '—',
    confirmedAtMs: item.confirmedAt || null,
    // Whether this trade actually executed on Bybit — if it did, its real
    // outcome (win/loss, exit price, realized PnL) should come straight
    // from the exchange once the position closes, not from replaying
    // candles against SL/TP numbers that may be stale now that a trailing
    // stop can move them after the fact.
    bybitPlaced: !!(item.bybitResult && item.bybitResult.placed),
    bybitOrderId: (item.bybitResult && item.bybitResult.orderId) || null,
    outcomeSource: null, // set to 'bybit' once a real result is matched, 'candle-estimate' for the fallback heuristic
    actualExitPrice: null,
    actualPnl: null,
    autoOutcome: entryStatus === 'confirmed' ? 'open' : 'n/a',
    outcome: entryStatus === 'confirmed' ? 'pending' : 'n/a',
    // For invalidated entries, why (e.g. TP too close); editable later like any note.
    notes: item.invalidReason || ''
  };
  stateMod.tradeLog.unshift(entry);
  stateMod.saveTradeLog();
  return entry;
}

// Fallback heuristic for trades that never actually executed on Bybit
// (auto-trading off, or the order was skipped) — there's no real position
// to ask about, so this is the best available guess: replay candles since
// the trade against the SL/TP recorded at confirmation time. For a trade
// WITHOUT a TP this can only ever resolve to 'loss' (if the SL is hit) or
// stay 'open' forever — there's no level for a 'win' to trigger against.
async function checkTradeOutcome(trade) {
  if (!trade.tpLevel && !trade.slLevel) return;
  if (trade.autoOutcome && trade.autoOutcome !== 'open') return;

  try {
    const since = trade.loggedAt || Date.now() - (24 * 60 * 60 * 1000);
    const allCandles = await fetchKlines(trade.symbol, 50, '30m');
    if (!Array.isArray(allCandles)) return;

    const candles = allCandles.filter(c => c.time >= since).map(c => ({ high: c.high, low: c.low }));
    if (!candles.length) return;

    const isBull = trade.direction === 'bull';
    let tpHit = false, slHit = false, tpTime = Infinity, slTime = Infinity;

    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (!tpHit && trade.tpLevel) {
        if (isBull && c.high >= trade.tpLevel) { tpHit = true; tpTime = i; }
        if (!isBull && c.low <= trade.tpLevel) { tpHit = true; tpTime = i; }
      }
      if (!slHit && trade.slLevel) {
        if (isBull && c.low <= trade.slLevel) { slHit = true; slTime = i; }
        if (!isBull && c.high >= trade.slLevel) { slHit = true; slTime = i; }
      }
      if (tpHit && slHit) break;
    }

    let autoOutcome = 'open';
    if (tpHit && slHit) autoOutcome = tpTime <= slTime ? 'win' : 'loss';
    else if (tpHit) autoOutcome = 'win';
    else if (slHit) autoOutcome = 'loss';

    trade.autoOutcome = autoOutcome;
    trade.outcomeSource = autoOutcome === 'open' ? null : 'candle-estimate';
    stateMod.saveTradeLog();
  } catch (e) {
    console.log('[tradelog] auto outcome check error:', e.message);
  }
}

// The real result, straight from Bybit, for a trade that actually executed
// there — checks whether the position is still open, and if not, finds its
// closed-PnL record (real exit price, real realized PnL) instead of
// guessing from candles. This is what makes a win actually detectable for
// a no-TP trade: the position closing in profit (via the trailing stop,
// say) IS the win, whether or not there was ever a price target.
async function checkBybitOutcome(trade) {
  if (!trade.bybitPlaced) return false;
  if (trade.autoOutcome && trade.autoOutcome !== 'open') return false;

  try {
    const openPos = await bybit.getOpenPosition(trade.symbol);
    if (openPos) return false; // still open on the exchange — stays pending

    const since = (trade.confirmedAtMs || trade.loggedAt) - 5000;
    const closed = await bybit.getClosedPnl(trade.symbol, since);
    if (!closed.length) return false; // not closed yet, or not found this pass — try again next cycle

    // Closed-pnl entries come back newest first — take the earliest one
    // that closed after this trade was confirmed, since that's the
    // position this bot actually opened (not some earlier manual trade
    // on the same symbol).
    const match = closed
      .filter(c => Number(c.updatedTime) >= since)
      .sort((a, b) => Number(a.updatedTime) - Number(b.updatedTime))[0];
    if (!match) return false;

    const pnl = parseFloat(match.closedPnl);
    trade.autoOutcome = pnl > 0 ? 'win' : 'loss';
    trade.outcomeSource = 'bybit';
    trade.actualExitPrice = parseFloat(match.avgExitPrice);
    trade.actualPnl = pnl;
    stateMod.saveTradeLog();
    return true;
  } catch (e) {
    console.log(`[tradelog] bybit outcome check error for ${trade.symbol}:`, e.message);
    return false;
  }
}

async function runAutoOutcomeChecks() {
  // Bybit-executed trades: check often and from the start — a trailing
  // stop or SL can close a position within minutes, and there's no reason
  // to wait when the real exchange has the real answer.
  const pendingBybit = stateMod.tradeLog.filter(t =>
    t.bybitPlaced && (!t.autoOutcome || t.autoOutcome === 'open')
  );
  for (const trade of pendingBybit) {
    await checkBybitOutcome(trade);
    await new Promise(r => setTimeout(r, 200));
  }

  // Trades that never executed on Bybit (auto-trading off, order refused or
  // skipped, e.g. a contract that needs a signed agreement) have no real
  // position to ask about. They are deliberately left PENDING for the user
  // to mark WIN/LOSS by hand — replaying candles against SL/TP only ever
  // produced a guess. (checkTradeOutcome is kept for reference/manual use.)
}

function setOutcome(id, outcome) {
  const trade = stateMod.tradeLog.find(t => t.id === id);
  if (!trade) return null;
  trade.outcome = trade.outcome === outcome ? 'pending' : outcome;
  stateMod.saveTradeLog();
  return trade;
}

function saveNote(id, note) {
  const trade = stateMod.tradeLog.find(t => t.id === id);
  if (!trade) return null;
  trade.notes = note;
  stateMod.saveTradeLog();
  return trade;
}

function clearLog() {
  stateMod.tradeLog = [];
  stateMod.saveTradeLog();
}

function exportCsv() {
  const tradeLog = stateMod.tradeLog;
  const headers = ['Date', 'Status', 'Symbol', 'Direction', 'Signal', 'Confirmation Price', 'Entry Price (fill)', 'TP Level', 'TP %', 'TP Source', 'SL Level', 'SL %', 'SL Source', 'Size (qty)', 'Size (notional $)', 'Leverage (x)', 'Trailing %', 'Signal Age', 'Confirm Time', 'Outcome', 'Outcome Source', 'Actual Exit', 'Actual PnL ($)', 'Notes'];
  const rows = tradeLog.map(t => [
    t.date, t.entryStatus || 'confirmed', t.symbol, t.direction === 'bull' ? 'LONG' : 'SHORT',
    t.signal1d, t.confirmationPrice || '', t.entryPrice || '', t.tpLevel || '', t.tpGain || '', t.tpSource || '',
    t.slLevel || '', t.slRisk || '', t.slSource || '', t.sizeQty || '', t.sizeNotional ? t.sizeNotional.toFixed(2) : '',
    t.sizeLeverage ? t.sizeLeverage.toFixed(1) : '',
    t.trailingPct || '', t.signalAge, t.confirmTime, t.outcome,
    t.outcomeSource || '', t.actualExitPrice || '', t.actualPnl != null ? t.actualPnl.toFixed(2) : '',
    `"${(t.notes || '').replace(/"/g, '""')}"`
  ]);
  return [headers, ...rows].map(r => r.join(',')).join('\n');
}

module.exports = {
  fmt, logTrade, checkTradeOutcome, checkBybitOutcome, runAutoOutcomeChecks, setOutcome, saveNote, clearLog, exportCsv
};

/* ═══════════════════════════════════════
   MAIN SCAN + 30MIN CONFIRMATION LOOP
   Ported from index-v15.html's startScan() /
   run2HConfirmation(), adapted to run on a
   server timer instead of a button click +
   browser-tab-lifetime timers. This is the
   actual fix for "Telegram almost never
   fires" — this loop runs as long as the
   Render service is up, with no dependency
   on any browser tab, phone, or device at all.
═══════════════════════════════════════ */
const stateMod = require('./state');
const { fetchSymbols, fetchKlines, fetch2HKlines, RateLimitError } = require('./bybitMarket');
const {
  analyseSymbol, analyse2H, findSwingLevels, resolveTP, auxRangeStopLevel, fourHourTpCandidates
} = require('./boundary');
const {
  calcPairExhaustionThreshold, isRecentMoveExhausted,
  calcPositionSize, calcSuggestedTrailing, RECENT_MOVE_EXHAUSTION_PCT
} = require('./filters');
const { sendTelegram, escHtml } = require('./telegram');
const bybit = require('./bybit');
const { fmt, logTrade } = require('./tradelog');
const { calcRR } = require('./boundary');

const MAX_RISK_USD = parseFloat(process.env.MAX_RISK_USD || '35');
// An exhausted move (big drop/pump just before confirmation) is no longer
// skipped: the trade is taken at this fraction of the normal risk.
const EXHAUSTED_RISK_FACTOR = parseFloat(process.env.EXHAUSTED_RISK_FACTOR || '0.5');
const MARGIN_PER_TRADE_USD = parseFloat(process.env.MARGIN_PER_TRADE_USD || '150');
const MAX_SENSIBLE_LEVERAGE = parseFloat(process.env.MAX_SENSIBLE_LEVERAGE || '50');
// A target this close to entry isn't worth chasing: the nearer a pair is to
// its TP, the less that level means and the easier it is to get pushed
// around or reversed (1000PEPE, 21 Oct: 0.98% TP, stopped out within 15
// minutes). Below this, the signal is invalidated at confirmation time.
// Confirmations whose 30m candle closes within this many hours of the daily
// close (00:00 UTC = 01:00 Lagos) are skipped: the daily picture is about to
// be replaced and the watchlist rebuilds at that moment. 0 disables the rule.
const END_OF_DAY_CUTOFF_HOURS = parseFloat(process.env.END_OF_DAY_CUTOFF_HOURS || '2');

const MIN_CONFIRM_TP_PCT = parseFloat(process.env.MIN_CONFIRM_TP_PCT || '3.5');

const sleep = ms => new Promise(r => setTimeout(r, ms));

let scanning = false;

// Bybit's public IP limit (600 req/5s) returns a 403 if exceeded, with a
// documented ~10min auto-lifting cooldown — far more forgiving than
// Binance's old escalating-ban policy, but still worth tracking: once
// limited, every further request gets instantly rejected again, and
// continuing to send them only delays recovery. So: track the cooldown
// here, and refuse to start any new scan/confirmation cycle until it's over.
function isBanned() {
  return !!(stateMod.state.bannedUntil && Date.now() < stateMod.state.bannedUntil);
}

function bannedSecondsLeft() {
  return Math.max(0, Math.ceil((stateMod.state.bannedUntil - Date.now()) / 1000));
}

function registerBan(retryAfterSec) {
  const ms = Math.max(retryAfterSec || 120, 60) * 1000;
  const until = Date.now() + ms;
  // Only ever extend, never shorten, in case two calls race.
  if (!stateMod.state.bannedUntil || until > stateMod.state.bannedUntil) {
    stateMod.state.bannedUntil = until;
    stateMod.save();
  }
  console.log(`[scan] Bybit rate-limited this IP — pausing ALL market-data requests until ${new Date(stateMod.state.bannedUntil).toISOString()}`);
}

async function startScan() {
  if (scanning) {
    console.log('[scan] already running, skipping overlapping scan');
    return;
  }
  if (isBanned()) {
    console.log(`[scan] skipping — Bybit rate-limit cooldown still in effect for ${bannedSecondsLeft()}s`);
    return;
  }
  scanning = true;
  stateMod.state.status = 'SCANNING';
  stateMod.save();

  const { flushTgQueue } = require('./telegram');
  await flushTgQueue();

  let engulfResults = [];
  let auxResults = [];

  try {
    const symbols = await fetchSymbols();
    const total = symbols.length;
    console.log(`[scan] scanning ${total} pairs...`);

    // Paced deliberately slow: Bybit's public IP limit is 600 requests/5s
    // (~120/sec), far above what this needs — 4 requests every 800ms
    // (~5/sec, ~300 req/min) stays well clear of it with a wide margin,
    // same conservative pacing kept from the Binance version on purpose.
    const BATCH = 4;
    const BATCH_DELAY_MS = 800;
    for (let i = 0; i < total; i += BATCH) {
      const batch = symbols.slice(i, i + BATCH);
      await Promise.all(batch.map(async sym => {
        try {
          const klines = await fetchKlines(sym, 60, '1d');
          const { engulf, aux } = analyseSymbol(sym, klines);
          if (engulf) engulfResults.push(engulf);
          if (aux) auxResults.push(aux);
        } catch (e) {
          if (e instanceof RateLimitError) throw e;
        }
      }));
      await sleep(BATCH_DELAY_MS);
    }

    const seenEngulf = new Set();
    engulfResults = engulfResults.filter(r => {
      if (seenEngulf.has(r.symbol)) return false;
      seenEngulf.add(r.symbol);
      return true;
    });
    const seenAux = new Set();
    auxResults = auxResults.filter(r => {
      if (seenAux.has(r.symbol)) return false;
      seenAux.add(r.symbol);
      return true;
    });

    stateMod.state.engulfResults = engulfResults;
    stateMod.state.auxResults = auxResults;

    const allSignals = [...engulfResults, ...auxResults.filter(r => r.direction !== null)];

    const todayUTC = new Date();
    todayUTC.setUTCHours(0, 0, 0, 0);
    const dailyOpenTimestamp = todayUTC.getTime();

    const trailingMap = {};
    for (const r of allSignals) {
      trailingMap[r.symbol] = await calcSuggestedTrailing(r.symbol);
      await sleep(50);
    }

    const exhaustionThresholdMap = {};
    for (const r of allSignals) {
      exhaustionThresholdMap[r.symbol] = await calcPairExhaustionThreshold(r.symbol);
      await sleep(50);
    }

    const sets = stateMod.alertSets();

    // The watchlist is rebuilt from scratch every scan, so anything learned
    // AFTER the first sighting of a signal (its confirmation: the real SL/TP,
    // fill, size, Bybit result, source tags) would be wiped and replaced by
    // the 1D scan's rough pre-confirmation estimates on the next rebuild. That
    // is why a confirmed trade's SL on the dashboard could "change" ~30 min
    // after the alert. Carry those fields over from the previous entry for the
    // same signal (same symbol, direction and day).
    const CARRY_FIELDS = [
      'confirmed', 'confirmedAt', 'confirmationPrice', 'entryPrice',
      'tpLevel', 'tpGain', 'tpEstimated', 'tpSource',
      'slLevel', 'slRisk', 'slEstimated', 'slSource',
      'sizeQty', 'sizeNotional', 'sizeLeverage',
      'bybitResult', 'invalidatedLogged', 'exhaustedEntry', 'tp4h', 'tp4hGain', 'tp4hMin', 'tp4hMinGain'
    ];
    const prevBySymbol = new Map((stateMod.state.watchlist || []).map(i => [i.symbol, i]));

    const newWatchlist = allSignals.map(r => ({
      symbol: r.symbol,
      direction: r.direction,
      signal1d: r.label || r.signal,
      signalTimestamp: dailyOpenTimestamp,
      signalHigh: r.signalHigh != null ? r.signalHigh : null,
      signalLow: r.signalLow != null ? r.signalLow : null,
      tpLevel: r.tpLevel || null,
      tpGain: r.tpGain || null,
      tpEstimated: r.tpEstimated || false,
      slLevel: r.slLevel || null,
      slRisk: r.slRisk || null,
      slEstimated: r.slEstimated || false,
      trailingPct: trailingMap[r.symbol] || null,
      exhaustionPct: exhaustionThresholdMap[r.symbol] || RECENT_MOVE_EXHAUSTION_PCT,
      entryPrice: r.price || r.closePrice || null,
      detectedAt: Date.now(),
      alerted: sets.confirmed.has(r.symbol),
      invalidated: sets.invalidated.has(r.symbol)
    }));

    for (const item of newWatchlist) {
      const prev = prevBySymbol.get(item.symbol);
      if (!prev || prev.direction !== item.direction || prev.signalTimestamp !== item.signalTimestamp) continue;
      // First-seen time, so signal age keeps counting instead of resetting
      // to "fresh" on every scan.
      if (prev.detectedAt) item.detectedAt = prev.detectedAt;
      if (prev.alerted) {
        for (const f of CARRY_FIELDS) {
          if (prev[f] !== undefined) item[f] = prev[f];
        }
      }
    }

    stateMod.state.watchlist = newWatchlist;
    stateMod.state.lastScan = Date.now();
    stateMod.save();

    console.log(`[scan] done — ${engulfResults.length} engulfing, ${auxResults.length} aux, ${newWatchlist.length} on watchlist`);

    if (newWatchlist.length) {
      await run2HConfirmation();
    }
  } catch (e) {
    if (e instanceof RateLimitError) {
      registerBan(e.retryAfterSec);
    } else {
      console.log('[scan] error:', e.message);
    }
  }

  stateMod.state.status = 'IDLE';
  stateMod.save();
  scanning = false;
}

// Permanently skip a confirmed breakout (no order, no entry alert). It stays
// in the logbook with the reason, and its price excursion is tracked so the
// rule can be judged later against what price actually did.
function skipConfirmation(sets, item, result2h, status, reason) {
  item.invalidated = true;
  item.invalidReason = reason;
  item.confirmationPrice = result2h.closePrice;
  item.confirmedAt = result2h.confirmTime + (30 * 60 * 1000);
  sets.invalidated.add(item.symbol);
  sets.exhaustedLogged.add(item.symbol);
  stateMod.saveAlertSets(sets);
  console.log(`[confirm] ${item.symbol} skipped (${status}): ${reason}`);
  if (!item.invalidatedLogged) {
    item.invalidatedLogged = true;
    logTrade(item, result2h, status);
  }
}

// True when the confirming 30m candle closed inside the end-of-day window.
function inEndOfDayWindow(confirmTime) {
  if (!(END_OF_DAY_CUTOFF_HOURS > 0)) return false;
  const DAY = 24 * 60 * 60 * 1000;
  const closeTime = confirmTime + 30 * 60 * 1000;
  const dailyClose = Math.floor((closeTime - 1) / DAY) * DAY + DAY; // next 00:00 UTC at/after the candle close
  return dailyClose - closeTime < END_OF_DAY_CUTOFF_HOURS * 60 * 60 * 1000;
}

async function run2HConfirmation() {
  if (isBanned()) {
    console.log(`[confirm] skipping — Bybit rate-limit cooldown still in effect for ${bannedSecondsLeft()}s`);
    return;
  }
  const watchlist = stateMod.state.watchlist;
  if (!watchlist.length) return;

  const sets = stateMod.alertSets();
  const confirmResults = [];

  try {
  for (const item of watchlist) {
    if (item.invalidated) {
      confirmResults.push({ ...item, confirmed: false, signal2h: null, currentPrice: item.entryPrice });
      continue;
    }

    try {
      const klines2h = await fetch2HKlines(item.symbol, item.signalTimestamp);
      const candles2h = klines2h ? klines2h.filtered : null;
      const allCandles2h = klines2h ? klines2h.all : null;
      const result2h = candles2h
        ? analyse2H(item.symbol, candles2h, item.direction, item.signalHigh, item.signalLow, fmt)
        : null;

      const latestPrice = allCandles2h && allCandles2h.length >= 2
        ? allCandles2h[allCandles2h.length - 2].close
        : item.entryPrice;

      if (result2h && result2h.invalidated) {
        item.invalidated = true;
        sets.invalidated.add(item.symbol);
        stateMod.saveAlertSets(sets);
        if (!item.invalidatedLogged) {
          item.invalidatedLogged = true;
          logTrade(item, null, 'invalidated');
        }
        confirmResults.push({ ...item, confirmed: false, signal2h: null, currentPrice: latestPrice });
        await sleep(80);
        continue;
      }

      if (result2h && !item.alerted && inEndOfDayWindow(result2h.confirmTime)) {
        skipConfirmation(sets, item, result2h, 'invalidated',
          `Confirmed too close to the daily close (within ${END_OF_DAY_CUTOFF_HOURS}h of 01:00 Lagos) — skipped`);
        confirmResults.push({ ...item, confirmed: false, signal2h: null, currentPrice: latestPrice });
        await sleep(80);
        continue;
      }

      // Exhausted = a big move already happened just before this confirmation.
      // Not skipped any more (PTB, 23 Oct, kept running ~45% after being
      // skipped) — the trade is taken at reduced size instead.
      const isExhausted = !!(result2h && !item.alerted &&
        isRecentMoveExhausted(allCandles2h, item.direction, item.exhaustionPct));

      if (result2h && !item.alerted) {
        item.alerted = true;
        sets.confirmed.add(item.symbol);
        stateMod.saveAlertSets(sets);

        const dir = result2h.direction === 'bull' ? '▲ LONG' : '▼ SHORT';
        const dirEmoji = result2h.direction === 'bull' ? '🟢' : '🔴';
        const entryPrice = result2h.closePrice;

        let confirmTp = null, confirmSl = null;
        try {
          const freshKlines = await fetchKlines(item.symbol, 60, '1d');
          if (freshKlines && freshKlines.length > 5) {
            const freshClosed = freshKlines.slice(0, -1);
            const freshLevels = findSwingLevels(freshClosed);
            confirmTp = resolveTP(entryPrice, freshLevels, freshClosed, item.direction);
          }
        } catch (e) {
          if (e instanceof RateLimitError) throw e;
        }

        // SL is the far edge of the 30min auxiliary range leading into the
        // confirmation candle: the lowest shadow of the whole aux market for
        // a long, the highest shadow for a short (see findAuxRange). One
        // method, every time — no silent fallback to swing/range levels.
        // Uses the full fetched window (not only candles since the 1D signal)
        // because the range can start before UTC midnight. If the range
        // can't give a valid stop there is no SL: "none found, size manually".
        const beforeConfirm = (allCandles2h || []).filter(c => c.time < result2h.confirmTime);
        confirmSl = auxRangeStopLevel(entryPrice, beforeConfirm, item.direction);

        // 4h-chart levels: (1) logged for the forward test, and (2) the
        // fallback TP when the daily chart gives none.
        item.tp4h = item.tp4hGain = item.tp4hMin = item.tp4hMinGain = null;
        let c4 = null;
        try {
          const k4 = await fetchKlines(item.symbol, 500, '4h');
          if (k4 && k4.length > 10) {
            c4 = fourHourTpCandidates(entryPrice, findSwingLevels(k4.slice(0, -1)), item.direction, MIN_CONFIRM_TP_PCT);
            if (c4.nearest) { item.tp4h = c4.nearest.price; item.tp4hGain = calcRR(entryPrice, c4.nearest.price); }
            if (c4.nearestMin) { item.tp4hMin = c4.nearestMin.price; item.tp4hMinGain = calcRR(entryPrice, c4.nearestMin.price); }
          }
        } catch (e) {
          if (e instanceof RateLimitError) throw e;
        }

        let tpValid = confirmTp && (
          (item.direction === 'bull' && confirmTp.price > entryPrice) ||
          (item.direction === 'bear' && confirmTp.price < entryPrice)
        );

        // No usable daily TP, or only an ESTIMATED one (range-extreme guess)
        // -> prefer a real 4h swing level when one exists.
        if ((!tpValid || confirmTp.estimated) && c4 && c4.nearest) {
          confirmTp = { price: c4.nearest.price, estimated: false, source: '4h-swing-level' };
          tpValid = true;
        }

        // Neither timeframe has a TP -> not a trade: invalidate, keep it in
        // the log with the reason (no order, no entry alert).
        if (!tpValid) {
          sets.confirmed.delete(item.symbol);
          item.alerted = false;
          item.invalidated = true;
          sets.invalidated.add(item.symbol);
          stateMod.saveAlertSets(sets);
          item.confirmationPrice = entryPrice;
          item.entryPrice = entryPrice;
          item.confirmedAt = result2h.confirmTime + (30 * 60 * 1000);
          item.tpLevel = null;
          item.tpGain = null;
          item.invalidReason = 'TP not found in both 1D TF and 4hr TF — skipped';
          console.log(`[confirm] ${item.symbol} invalidated: ${item.invalidReason}`);
          if (!item.invalidatedLogged) {
            item.invalidatedLogged = true;
            logTrade(item, result2h, 'invalidated');
          }
          confirmResults.push({ ...item, confirmed: false, signal2h: null, currentPrice: latestPrice });
          await sleep(80);
          continue;
        }

        // TP too close to the confirmed entry -> not a trade worth taking.
        // Undo the "confirmed" marking made above and invalidate it instead:
        // no order, no entry alert, logged as INVALIDATED with the reason.
        // (No TP at all is handled just above.)
        if (tpValid) {
          const tpPctAtEntry = parseFloat(calcRR(entryPrice, confirmTp.price));
          if (tpPctAtEntry < MIN_CONFIRM_TP_PCT) {
            sets.confirmed.delete(item.symbol);
            item.alerted = false;
            item.invalidated = true;
            sets.invalidated.add(item.symbol);
            stateMod.saveAlertSets(sets);
            item.confirmationPrice = entryPrice;
            item.entryPrice = entryPrice;
            item.confirmedAt = result2h.confirmTime + (30 * 60 * 1000);
            item.tpLevel = confirmTp.price;
            item.tpGain = String(tpPctAtEntry);
            item.invalidReason = `TP only ${tpPctAtEntry}% away at confirmation (minimum ${MIN_CONFIRM_TP_PCT}%) — skipped`;
            console.log(`[confirm] ${item.symbol} invalidated: ${item.invalidReason}`);
            if (!item.invalidatedLogged) {
              item.invalidatedLogged = true;
              logTrade(item, result2h, 'invalidated');
            }
            confirmResults.push({ ...item, confirmed: false, signal2h: null, currentPrice: latestPrice });
            await sleep(80);
            continue;
          }
        }
        const slValid = confirmSl && (
          (item.direction === 'bull' && confirmSl.price < entryPrice) ||
          (item.direction === 'bear' && confirmSl.price > entryPrice)
        );
        // CRITICAL: item.tpLevel/slLevel at this point are still whatever
        // the 1D scan guessed BEFORE confirmation, computed against that
        // scan-time price — not this candle's confirmed entry. If the
        // fresh confirm-time TP/SL isn't valid, we must clear the stale
        // ones rather than leave them in place: price has moved since the
        // scan, so a pre-confirmation TP can end up on the WRONG SIDE of
        // the real entry (e.g. "take profit" above entry on a short) and
        // get sent to Telegram, the dashboard, and Bybit as if it were
        // current and correct. "No level found" is the honest result here.
        if (tpValid) {
          item.tpLevel = confirmTp.price;
          item.tpGain = calcRR(entryPrice, confirmTp.price);
          item.tpEstimated = confirmTp.estimated;
          item.tpSource = confirmTp.source || null;
        } else {
          item.tpLevel = null;
          item.tpGain = null;
          item.tpEstimated = false;
          item.tpSource = null;
        }
        if (slValid) {
          item.slLevel = confirmSl.price;
          item.slRisk = calcRR(entryPrice, confirmSl.price);
          item.slEstimated = confirmSl.estimated;
          // 'tight-prior-candle' | 'swing-level' | 'range-extreme' — exactly
          // which of the three SL methods produced this number, recorded so
          // it never has to be reverse-engineered from a chart after the
          // fact again.
          item.slSource = confirmSl.source || null;
        } else {
          item.slLevel = null;
          item.slRisk = null;
          item.slEstimated = false;
          item.slSource = null;
        }

        item.exhaustedEntry = isExhausted;
        const riskUsd = isExhausted ? MAX_RISK_USD * EXHAUSTED_RISK_FACTOR : MAX_RISK_USD;
        const sizing = calcPositionSize(entryPrice, item.slLevel, riskUsd, MARGIN_PER_TRADE_USD);
        if (sizing) {
          item.sizeQty = sizing.qty;
          item.sizeNotional = sizing.notional;
          // Floor, never round up — a rounded-up leverage figure understates
          // the risk you'd actually be taking on, which is the wrong
          // direction to be wrong in. 8.9x floors to 8x, not 9x.
          item.sizeLeverage = Math.floor(sizing.leverage);
        } else {
          item.sizeQty = item.sizeNotional = item.sizeLeverage = null;
        }

        // The watchlist's entryPrice was only ever the 1D signal's close —
        // a placeholder from before confirmation. confirmationPrice is the
        // fixed, never-overwritten record of what the 30min candle closed
        // at — the number everything (SL/TP sizing, "did we get a good
        // fill") was originally planned against. entryPrice starts the
        // same but gets replaced below with the REAL Bybit fill once one
        // exists, so the two can be shown side by side: what we planned
        // for vs. what actually happened.
        item.confirmationPrice = entryPrice;
        item.entryPrice = entryPrice;
        item.confirmedAt = result2h.confirmTime + (30 * 60 * 1000); // candle CLOSE time, not open

        // Auto-execute on Bybit Demo Trading — no-ops (returns
        // {skipped: true, reason}) unless BYBIT_AUTO_TRADE=true and keys
        // are set, so this is silent and harmless when auto-trading is off.
        // A Bybit failure here must never break the confirmation loop or
        // stop the Telegram alert from going out — it's reported IN the
        // alert, not instead of it.
        let bybitResult = { skipped: true, reason: 'auto-trading off' };
        try {
          bybitResult = await bybit.placeOrder({
            symbol: item.symbol,
            direction: item.direction,
            qty: item.sizeQty,
            entryPrice,
            tpLevel: item.tpLevel,
            slLevel: item.slLevel,
            leverage: item.sizeLeverage,
            trailingPct: item.trailingPct
          });
        } catch (e) {
          bybitResult = { error: true, reason: e.message };
          console.log(`[bybit] order failed for ${item.symbol}:`, e.message);
        }
        item.bybitResult = bybitResult;

        // A filled market order can land at a different price than our
        // pre-trade estimate (and bybit.js re-anchors SL/TP to that real
        // fill when it does) — once that's happened, the real numbers on
        // the exchange ARE the truth, so show those everywhere else
        // (dashboard, Telegram, trade log) instead of the estimate that
        // was only ever a sizing input.
        if (bybitResult.placed) {
          if (bybitResult.entry) item.entryPrice = bybitResult.entry;
          if (bybitResult.sl) {
            item.slLevel = bybitResult.sl;
            item.slRisk = calcRR(item.entryPrice, bybitResult.sl);
          }
          item.tpLevel = bybitResult.tp || null;
          item.tpGain = bybitResult.tp ? calcRR(item.entryPrice, bybitResult.tp) : null;
        }

        logTrade(item, result2h);

        const tpTag = item.tpEstimated ? ' ⚠️est.' : '';
        const slTag = item.slEstimated ? ' ⚠️est.' : '';
        const srcLabel = s => s === 'aux-range' ? ' [aux range edge]' : s === 'tight-prior-candle' ? ' [tight: prior candle]' : s === 'swing-level' ? ' [swing level]' : s === 'range-extreme' ? ' [range extreme]' : s === '4h-swing-level' ? ' [4h swing level]' : '';
        const tpText = item.tpLevel ? `\n🎯 TP: $${fmt(item.tpLevel)} (+${item.tpGain}%)${tpTag}${srcLabel(item.tpSource)}` : '\n🎯 TP: none found — size manually';
        const slText = item.slLevel ? `\n🛑 SL: $${fmt(item.slLevel)} (-${item.slRisk}%)${slTag}${srcLabel(item.slSource)}` : '\n🛑 SL: none found — size manually';
        const levTag = item.sizeLeverage && item.sizeLeverage > MAX_SENSIBLE_LEVERAGE ? ' ⚠️ SL too tight for this margin — consider skipping or a wider stop' : '';
        const sizeText = item.sizeLeverage
          ? `\n⚙️ Leverage needed on $${MARGIN_PER_TRADE_USD} margin: ${item.sizeLeverage}x${levTag}`
          : '';
        // Only claim it's live on Bybit when bybitResult actually confirms
        // the trailingStop call succeeded — a suggested % with no exchange
        // confirmation is not "set on Bybit", it's just a number.
        const trailingText = bybitResult.trailing
          ? `\n📌 Trailing Stop: $${bybitResult.trailing} (${item.trailingPct}%) — arms once in profit at $${bybitResult.trailingActivePrice}, then locks break-even and trails (set on Bybit)`
          : item.trailingPct
            ? `\n📌 Suggested trailing: ${item.trailingPct}% (not applied automatically — set manually)`
            : '';
        const bybitText = bybitResult.placed
          ? `\n🤖 Bybit Demo: order placed (qty ${bybitResult.qty}, SL $${bybitResult.sl}${bybitResult.tp ? `, TP $${bybitResult.tp}` : ''})`
          : bybitResult.error
            ? `\n🤖 Bybit Demo: FAILED — ${escHtml(bybitResult.reason)} (manual entry needed)`
            : (bybit.AUTO_TRADE ? `\n🤖 Bybit Demo: skipped — ${escHtml(bybitResult.reason)}` : '');
        sets.tg.add(item.symbol);
        stateMod.saveAlertSets(sets);
        const exhaustedText = item.exhaustedEntry
          ? `\n⚠️ Exhausted move before entry — reduced size (risk $${(MAX_RISK_USD * EXHAUSTED_RISK_FACTOR).toFixed(2)} instead of $${MAX_RISK_USD})`
          : '';
        const tgMsg = `${dirEmoji} <b>ENTRY CONFIRMED</b>\n`
          + `<b>${item.symbol.replace('USDT', '')}/USDT</b> · ${dir}\n`
          + `Signal: ${escHtml(item.signal1d)}\n`
          + `Confirmation: ${escHtml(result2h.label)}\n`
          + `Confirmation Price: $${fmt(item.confirmationPrice)} · ${result2h.dateStr}`
          + (bybitResult.placed && item.entryPrice !== item.confirmationPrice
              ? `\nEntry (actual fill): $${fmt(item.entryPrice)}`
              : '')
          + tpText + slText + sizeText + exhaustedText + trailingText + bybitText;
        await sendTelegram(tgMsg);
      }

      confirmResults.push({
        ...item,
        confirmed: !!result2h,
        signal2h: result2h,
        currentPrice: latestPrice
      });
    } catch (e) {
      if (e instanceof RateLimitError) throw e;
      // This used to fail silently — if confirmation logic threw partway
      // through (after alerted/confirmed flags were already set, say),
      // the item would just vanish from this cycle's results with no
      // trace of why, and whatever came after the failure point (Telegram,
      // Bybit) would never run. Logging it is the only way a one-off
      // failure like that is ever diagnosable from the Render logs.
      console.log(`[confirm] error processing ${item.symbol}:`, e.message);
      confirmResults.push({ ...item, confirmed: false, signal2h: null });
    }
    await sleep(80);
  }
  } catch (e) {
    if (e instanceof RateLimitError) {
      registerBan(e.retryAfterSec);
    } else {
      console.log('[confirm] error:', e.message);
    }
  }

  stateMod.state.watchlist = watchlist; // mutated in place (alerted/invalidated flags)
  stateMod.state.confirmResults = confirmResults;
  stateMod.save();
}

module.exports = { startScan, run2HConfirmation, MAX_RISK_USD, MARGIN_PER_TRADE_USD, MAX_SENSIBLE_LEVERAGE };

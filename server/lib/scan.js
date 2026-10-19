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
const { fetchSymbols, fetchKlines, fetch2HKlines, RateLimitError } = require('./binance');
const {
  analyseSymbol, analyse2H, findSwingLevels, resolveTP, resolveSL
} = require('./boundary');
const {
  calcPairExhaustionThreshold, isRecentMoveExhausted, tightStopLevel,
  calcPositionSize, calcSuggestedTrailing, RECENT_MOVE_EXHAUSTION_PCT
} = require('./filters');
const { sendTelegram } = require('./telegram');
const bybit = require('./bybit');
const { fmt, logTrade } = require('./tradelog');
const { calcRR } = require('./boundary');

const MAX_RISK_USD = parseFloat(process.env.MAX_RISK_USD || '35');
const MARGIN_PER_TRADE_USD = parseFloat(process.env.MARGIN_PER_TRADE_USD || '150');
const MAX_SENSIBLE_LEVERAGE = parseFloat(process.env.MAX_SENSIBLE_LEVERAGE || '50');

const sleep = ms => new Promise(r => setTimeout(r, ms));

let scanning = false;

// Binance bans an IP (HTTP 418) for a while — 2 minutes up to 3 days for
// repeat offenders — if it sees requests coming in too fast. Once banned,
// every further request gets an instant 418, and continuing to send them
// only extends the ban. So: track the ban here, and refuse to start any
// new scan/confirmation cycle until it's over.
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
  console.log(`[scan] Binance rate-limited/banned this IP — pausing ALL Binance requests until ${new Date(stateMod.state.bannedUntil).toISOString()}`);
}

async function startScan() {
  if (scanning) {
    console.log('[scan] already running, skipping overlapping scan');
    return;
  }
  if (isBanned()) {
    console.log(`[scan] skipping — Binance ban still in effect for ${bannedSecondsLeft()}s`);
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

    // Paced deliberately slow: Binance futures gives an IP a 2400
    // request-weight/min budget, but it also bans IPs that burst through
    // hundreds of requests in a few seconds even if the total weight is
    // within budget. 4 requests every 800ms (~5/sec, ~300 req/min) stays
    // well clear of both the weight budget and that burst detection.
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

async function run2HConfirmation() {
  if (isBanned()) {
    console.log(`[confirm] skipping — Binance ban still in effect for ${bannedSecondsLeft()}s`);
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

      if (result2h && !item.alerted && isRecentMoveExhausted(allCandles2h, item.direction, item.exhaustionPct)) {
        if (!sets.exhaustedLogged.has(item.symbol)) {
          sets.exhaustedLogged.add(item.symbol);
          stateMod.saveAlertSets(sets);
          logTrade(item, result2h, 'exhausted');
        }
        confirmResults.push({ ...item, confirmed: false, signal2h: null, currentPrice: latestPrice, exhausted: true });
        await sleep(80);
        continue;
      }

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
            confirmSl = resolveSL(entryPrice, freshLevels, freshClosed, item.direction);
          }
        } catch (e) {
          if (e instanceof RateLimitError) throw e;
        }

        const tightSl = tightStopLevel(entryPrice, result2h.priorCandle, item.direction);
        if (tightSl) confirmSl = tightSl;

        const tpValid = confirmTp && (
          (item.direction === 'bull' && confirmTp.price > entryPrice) ||
          (item.direction === 'bear' && confirmTp.price < entryPrice)
        );
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

        const sizing = calcPositionSize(entryPrice, item.slLevel, MAX_RISK_USD, MARGIN_PER_TRADE_USD);
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
        const srcLabel = s => s === 'tight-prior-candle' ? ' [tight: prior candle]' : s === 'swing-level' ? ' [swing level]' : s === 'range-extreme' ? ' [range extreme]' : '';
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
          ? `\n📌 Trailing Stop: $${bybitResult.trailing} (${item.trailingPct}%, active from entry — set on Bybit)`
          : item.trailingPct
            ? `\n📌 Suggested trailing: ${item.trailingPct}% (not applied automatically — set manually)`
            : '';
        const bybitText = bybitResult.placed
          ? `\n🤖 Bybit Demo: order placed (qty ${bybitResult.qty}, SL $${bybitResult.sl}${bybitResult.tp ? `, TP $${bybitResult.tp}` : ''})`
          : bybitResult.error
            ? `\n🤖 Bybit Demo: FAILED — ${bybitResult.reason} (manual entry needed)`
            : (bybit.AUTO_TRADE ? `\n🤖 Bybit Demo: skipped — ${bybitResult.reason}` : '');
        sets.tg.add(item.symbol);
        stateMod.saveAlertSets(sets);
        const tgMsg = `${dirEmoji} <b>ENTRY CONFIRMED</b>\n`
          + `<b>${item.symbol.replace('USDT', '')}/USDT</b> · ${dir}\n`
          + `Signal: ${item.signal1d}\n`
          + `Confirmation: ${result2h.label}\n`
          + `Confirmation Price: $${fmt(item.confirmationPrice)} · ${result2h.dateStr}`
          + (bybitResult.placed && item.entryPrice !== item.confirmationPrice
              ? `\nEntry (actual fill): $${fmt(item.entryPrice)}`
              : '')
          + tpText + slText + sizeText + trailingText + bybitText;
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

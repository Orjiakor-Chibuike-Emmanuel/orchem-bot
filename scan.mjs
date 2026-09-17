// ═══════════════════════════════════════════════════════════
// Orchem Bot — server-side scanner
//
// Ports the SAME detection logic as index-v12.html (boundary
// candle system, MA50 trend filter, volume filter, extreme zone
// filter, swing S/R with range-extreme fallback, 30min confirmation)
// to run headless on a schedule via GitHub Actions — independent
// of any browser tab being open.
//
// State (watchlist, alerted pairs, failed Telegram queue) persists
// in state.json, committed back to the repo after each run by the
// workflow — this replaces what localStorage did in the browser.
// ═══════════════════════════════════════════════════════════

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';

const STATE_PATH = new URL('./state.json', import.meta.url);

/* ── CONFIG (mirrors index-v12.html) ── */
const SR_PROXIMITY_PCT = 5;
const SWING_LOOKBACK   = 60;
const BOUNDARY_LOOKBACK = 50;
// Bybit host list + request headers are defined near apiFetch() below

const MA_PERIOD      = 50;
const VOL_LOOKBACK    = 20;
const VOL_MULTIPLIER  = 1.2;
const EXTREME_NEAR_PCT = 5;
const EXTREME_MOVE_PCT = 70;
const MIN_TP_PCT      = 4;

// ── SECRETS — NEVER hardcode these. Passed as env vars by the
// GitHub Actions workflow, sourced from repo Secrets. ──
const TG_TOKEN = process.env.TG_BOT_TOKEN;
if (!TG_TOKEN) {
  console.error('Missing TG_BOT_TOKEN env var. Set it as a GitHub repo secret and pass it in the workflow.');
  process.exit(1);
}
const TG_RECIPIENTS = [
  '1742837981',       // Nuel personal
  '-1004304777856',   // The Oracle supergroup
];
const MAX_TG_RETRY_ATTEMPTS = 12;

/* ── STATE ── */
async function loadState() {
  if (!existsSync(STATE_PATH)) {
    return {
      watchlist: [],
      tgAlertedPairs: [],
      confirmedAlertedPairs: [],
      tgQueue: [],
      lastDailyResetUTCDate: null,
      tradeLog: []
    };
  }
  const raw = await readFile(STATE_PATH, 'utf-8');
  return JSON.parse(raw);
}
async function saveState(state) {
  await writeFile(STATE_PATH, JSON.stringify(state, null, 2));
}

/* ── BYBIT HELPERS (no CORS proxy needed server-side) ── */
// Two things GitHub Actions runners commonly trip on with Cloudflare-fronted
// APIs: (1) no browser-like headers, (2) a single host with no fallback if
// that host's IP reputation is flagged. Address both: send realistic
// headers, and try a second Bybit domain if the first is blocked.
const BYBIT_HOSTS = ['https://api.bybit.com', 'https://api.bytick.com'];
const REQUEST_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json'
};

async function apiFetch(path) {
  for (const host of BYBIT_HOSTS) {
    try {
      const r = await fetch(host + path, { headers: REQUEST_HEADERS, signal: AbortSignal.timeout(9000) });
      if (r.ok) return r;
      console.log('Bybit non-OK status', r.status, host + path);
    } catch (e) {
      console.log('Bybit fetch failed:', e.message, host + path);
    }
  }
  return null;
}
async function safeJson(r) {
  if (!r) return null;
  try { return await r.json(); } catch (_) { return null; }
}
async function fetchSymbols() {
  const r = await apiFetch(`/v5/market/instruments-info?category=linear`);
  const d = await safeJson(r);
  if (!d || d.retCode !== 0 || !d.result || !Array.isArray(d.result.list)) {
    throw new Error('Could not reach Bybit instruments-info API.');
  }
  return d.result.list
    .filter(s => s.quoteCoin === 'USDT' && s.status === 'Trading' && s.contractType === 'LinearPerpetual')
    .map(s => s.symbol);
}
// Bybit returns klines NEWEST-first — reverse to ascending chronological
// order so the rest of the logic (which assumes the last candle is the
// most recent/still-forming one, same as Binance's native order) works
// unchanged.
function parseBybitKlines(raw) {
  if (!raw || !Array.isArray(raw.list)) return null;
  return raw.list
    .slice()
    .reverse()
    .map(k => ({
      time: parseInt(k[0], 10), open: parseFloat(k[1]), high: parseFloat(k[2]),
      low: parseFloat(k[3]), close: parseFloat(k[4]), volume: parseFloat(k[5]),
      isBullish: parseFloat(k[4]) >= parseFloat(k[1])
    }));
}
async function fetchKlines(symbol, limit = SWING_LOOKBACK) {
  const r = await apiFetch(`/v5/market/kline?category=linear&symbol=${symbol}&interval=D&limit=${limit}`);
  const d = await safeJson(r);
  if (!d || d.retCode !== 0) return null;
  return parseBybitKlines(d.result);
}
async function fetch2HKlines(symbol, sinceTimestamp) {
  const r = await apiFetch(`/v5/market/kline?category=linear&symbol=${symbol}&interval=30&limit=100`);
  const d = await safeJson(r);
  if (!d || d.retCode !== 0) return null;
  const all = parseBybitKlines(d.result);
  if (!all) return null;
  return all.filter(c => c.time >= sinceTimestamp);
}
async function calcSuggestedTrailing(symbol) {
  try {
    const r = await apiFetch(`/v5/market/kline?category=linear&symbol=${symbol}&interval=30&limit=20`);
    const d = await safeJson(r);
    if (!d || d.retCode !== 0 || !d.result || !Array.isArray(d.result.list) || d.result.list.length < 5) return null;
    const ranges = d.result.list.map(k => {
      const high = parseFloat(k[2]), low = parseFloat(k[3]), close = parseFloat(k[4]);
      return ((high - low) / close) * 100;
    });
    const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    return parseFloat(Math.max(0.5, avgRange * 1.5).toFixed(1));
  } catch (_) { return null; }
}

/* ── CORE DETECTION LOGIC (ported verbatim from index-v12.html) ── */
function classifyPattern(parent, curr) {
  const parentRed = !parent.isBullish, parentGreen = parent.isBullish;
  const currGreen = curr.isBullish, currRed = !curr.isBullish;
  if (curr.close > parent.high) {
    if (parentRed && currGreen) return { label: 'Bull Reversal', patternType: 'rev-bull', direction: 'bull' };
    if (parentGreen && currGreen) return { label: 'Bull Engulfing', patternType: 'eng-bull', direction: 'bull' };
    if (parentRed && currRed) return { label: 'Bull Reversal', patternType: 'rev-bull', direction: 'bull' };
    if (parentGreen && currRed) return { label: 'Bull Engulfing', patternType: 'eng-bull', direction: 'bull' };
  }
  if (curr.close < parent.low) {
    if (parentGreen && currRed) return { label: 'Bear Reversal', patternType: 'rev-bear', direction: 'bear' };
    if (parentRed && currRed) return { label: 'Bear Engulfing', patternType: 'eng-bear', direction: 'bear' };
    if (parentGreen && currGreen) return { label: 'Bear Reversal', patternType: 'rev-bear', direction: 'bear' };
    if (parentRed && currGreen) return { label: 'Bear Engulfing', patternType: 'eng-bear', direction: 'bear' };
  }
  return null;
}

function findBoundary(closed) {
  const n = closed.length;
  if (n < 4) return null;
  const windowStart = Math.max(0, n - 1 - BOUNDARY_LOOKBACK);
  const window = closed.slice(windowStart, n - 1);
  const wn = window.length;
  if (wn < 2) return null;
  let parentIdx = 0, boundaryHigh = window[0].high, boundaryLow = window[0].low;
  for (let i = 1; i < wn; i++) {
    const c = window[i];
    if (c.close > boundaryHigh || c.close < boundaryLow) {
      parentIdx = i; boundaryHigh = c.high; boundaryLow = c.low;
    } else {
      if (c.high > boundaryHigh) boundaryHigh = c.high;
      if (c.low < boundaryLow) boundaryLow = c.low;
    }
  }
  const auxCount = (wn - 1) - parentIdx;
  return { parentCandle: window[parentIdx], boundaryHigh, boundaryLow, auxCount };
}

function findSwingLevels(candles) {
  const levels = [];
  for (let i = 2; i < candles.length - 2; i++) {
    if (candles[i].high > candles[i-1].high && candles[i].high > candles[i-2].high &&
        candles[i].high > candles[i+1].high && candles[i].high > candles[i+2].high) {
      levels.push({ price: candles[i].high, type: 'resistance' });
    }
    if (candles[i].low < candles[i-1].low && candles[i].low < candles[i-2].low &&
        candles[i].low < candles[i+1].low && candles[i].low < candles[i+2].low) {
      levels.push({ price: candles[i].low, type: 'support' });
    }
  }
  return levels;
}
function nearestLevel(price, levels) {
  let best = null, bestDist = Infinity;
  for (const lvl of levels) {
    const dist = Math.abs(price - lvl.price) / lvl.price * 100;
    if (dist <= SR_PROXIMITY_PCT && dist < bestDist) { best = { ...lvl, proximity: dist }; bestDist = dist; }
  }
  return best;
}
function isTooCloseToExtreme(closed, direction) {
  if (!closed || closed.length < 2) return false;
  const price = closed[closed.length - 1].close;
  const highestHigh = Math.max(...closed.map(c => c.high));
  const lowestLow = Math.min(...closed.map(c => c.low));
  if (direction === 'bear') {
    const nearLow = ((price - lowestLow) / lowestLow * 100) <= EXTREME_NEAR_PCT;
    const alreadyCrashed = ((highestHigh - price) / highestHigh * 100) >= EXTREME_MOVE_PCT;
    return nearLow || alreadyCrashed;
  } else {
    const nearHigh = ((highestHigh - price) / highestHigh * 100) <= EXTREME_NEAR_PCT;
    const alreadyPumped = ((price - lowestLow) / lowestLow * 100) >= EXTREME_MOVE_PCT;
    return nearHigh || alreadyPumped;
  }
}
function calcMA(candles, period) {
  if (candles.length < period) return null;
  const slice = candles.slice(-period);
  return slice.reduce((sum, c) => sum + c.close, 0) / period;
}
function avgVolume(candles, lookback) {
  const slice = candles.slice(-lookback - 1, -1);
  if (!slice.length) return 0;
  return slice.reduce((sum, c) => sum + c.volume, 0) / slice.length;
}
function findTPLevel(price, levels, direction) {
  if (direction === 'bull') {
    const above = levels.filter(l => l.price > price * 1.005).sort((a, b) => a.price - b.price);
    return above[0] || null;
  } else {
    const below = levels.filter(l => l.price < price * 0.995).sort((a, b) => b.price - a.price);
    return below[0] || null;
  }
}
function findSLLevel(price, levels, direction) {
  if (direction === 'bull') {
    const below = levels.filter(l => l.type === 'support' && l.price < price * 0.995).sort((a, b) => b.price - a.price);
    return below[0] || null;
  } else {
    const above = levels.filter(l => l.type === 'resistance' && l.price > price * 1.005).sort((a, b) => a.price - b.price);
    return above[0] || null;
  }
}
function rangeExtremeLevel(closed, direction, kind) {
  if (!closed || !closed.length) return null;
  const highs = closed.map(c => c.high), lows = closed.map(c => c.low);
  if (kind === 'tp') return direction === 'bull' ? Math.max(...highs) : Math.min(...lows);
  return direction === 'bull' ? Math.min(...lows) : Math.max(...highs);
}
function resolveTP(price, levels, closed, direction) {
  const lvl = findTPLevel(price, levels, direction);
  if (lvl) return { price: lvl.price, estimated: false };
  const fb = rangeExtremeLevel(closed, direction, 'tp');
  if (fb == null) return null;
  const valid = direction === 'bull' ? fb > price * 1.005 : fb < price * 0.995;
  return valid ? { price: fb, estimated: true } : null;
}
function resolveSL(price, levels, closed, direction) {
  const lvl = findSLLevel(price, levels, direction);
  if (lvl) return { price: lvl.price, estimated: false };
  const fb = rangeExtremeLevel(closed, direction, 'sl');
  if (fb == null) return null;
  const valid = direction === 'bull' ? fb < price * 0.995 : fb > price * 1.005;
  return valid ? { price: fb, estimated: true } : null;
}
function calcRR(entryPrice, tpPrice) {
  return Math.abs((tpPrice - entryPrice) / entryPrice * 100).toFixed(2);
}
function fmt(p) {
  if (!p) return '—';
  return p >= 1
    ? p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
    : p.toPrecision(4);
}

function analyseSymbol(symbol, candles) {
  if (!candles || candles.length < 5) return { engulf: null, aux: null };
  const closed = candles.slice(0, -1);
  const curr = closed[closed.length - 1];
  const dateStr = new Date(curr.time).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
  const levels = findSwingLevels(closed);
  const ma50 = calcMA(closed, MA_PERIOD);
  const avgVol = avgVolume(closed, VOL_LOOKBACK);
  const currVol = curr.volume || 0;
  const volOk = avgVol === 0 || currVol >= avgVol * VOL_MULTIPLIER;
  const volRatio = avgVol > 0 ? (currVol / avgVol).toFixed(1) : null;

  const boundary = findBoundary(closed);
  if (!boundary) return { engulf: null, aux: null };
  const { parentCandle, boundaryHigh, boundaryLow, auxCount } = boundary;

  const breaksBull = curr.close > boundaryHigh;
  const breaksBear = curr.close < boundaryLow;

  if (breaksBull && isTooCloseToExtreme(closed, 'bull')) return { engulf: null, aux: null };
  if (breaksBear && isTooCloseToExtreme(closed, 'bear')) return { engulf: null, aux: null };

  let engulf = null, aux = null;

  if (breaksBull || breaksBear) {
    const trendOk = !ma50 || (breaksBull ? curr.close > ma50 : curr.close < ma50);
    if (auxCount === 0) {
      const pattern = classifyPattern(parentCandle, curr);
      if (pattern && trendOk && volOk) {
        const lvl = nearestLevel(curr.close, levels);
        const tpRes = resolveTP(curr.close, levels, closed, pattern.direction);
        const slRes = resolveSL(curr.close, levels, closed, pattern.direction);
        if (tpRes) {
          const tpPct = Math.abs((tpRes.price - curr.close) / curr.close * 100);
          if (tpPct < MIN_TP_PCT) return { engulf: null, aux: null };
        }
        engulf = {
          symbol, price: curr.close, dateStr,
          boundaryHigh, boundaryLow, auxCandles: auxCount,
          signalHigh: curr.high, signalLow: curr.low,
          ...pattern,
          srLevel: lvl ? lvl.price : 0, srType: lvl ? lvl.type : 'none',
          proximity: lvl ? lvl.proximity : 999, hasSR: !!lvl,
          tpLevel: tpRes ? tpRes.price : null, tpGain: tpRes ? calcRR(curr.close, tpRes.price) : null,
          tpEstimated: tpRes ? tpRes.estimated : false,
          slLevel: slRes ? slRes.price : null, slRisk: slRes ? calcRR(curr.close, slRes.price) : null,
          slEstimated: slRes ? slRes.estimated : false,
          volRatio, ma50: ma50 ? ma50.toFixed(4) : null
        };
      }
    } else {
      const direction = breaksBull ? 'bull' : 'bear';
      if (trendOk && volOk) {
        const lvl = nearestLevel(curr.close, levels);
        const tpRes = resolveTP(curr.close, levels, closed, direction);
        const slRes = resolveSL(curr.close, levels, closed, direction);
        if (tpRes) {
          const tpPct = Math.abs((tpRes.price - curr.close) / curr.close * 100);
          if (tpPct < MIN_TP_PCT) return { engulf: null, aux: null };
        }
        aux = {
          symbol, direction,
          signal: breaksBull ? '▲ Aux Bull Breakout' : '▼ Aux Bear Breakout',
          closePrice: curr.close, rangeHigh: boundaryHigh, rangeLow: boundaryLow,
          signalHigh: curr.high, signalLow: curr.low,
          candlesSinceEngulf: auxCount, dateStr,
          srLevel: lvl ? lvl.price : 0, srType: lvl ? lvl.type : 'none',
          proximity: lvl ? lvl.proximity : 999, hasSR: !!lvl,
          tpLevel: tpRes ? tpRes.price : null, tpGain: tpRes ? calcRR(curr.close, tpRes.price) : null,
          tpEstimated: tpRes ? tpRes.estimated : false,
          slLevel: slRes ? slRes.price : null, slRisk: slRes ? calcRR(curr.close, slRes.price) : null,
          slEstimated: slRes ? slRes.estimated : false,
          volRatio, ma50: ma50 ? ma50.toFixed(4) : null
        };
      }
    }
  }
  return { engulf, aux };
}

function analyse2H(symbol, candles2h, requiredDirection, signalHigh, signalLow) {
  if (!candles2h || candles2h.length < 2) return null;
  const closed = candles2h.slice(0, -1);
  if (closed.length < 1) return null;
  let boundaryHigh = signalHigh, boundaryLow = signalLow, parentIdx = -1;
  for (let i = 0; i < closed.length; i++) {
    const c = closed[i];
    const breaksBull = c.close > boundaryHigh, breaksBear = c.close < boundaryLow;
    if (breaksBull || breaksBear) {
      const direction = breaksBull ? 'bull' : 'bear';
      if (direction === requiredDirection) {
        const closeTime = c.time + (30 * 60 * 1000);
        const dateStr = new Date(closeTime).toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
        const auxCount = parentIdx === -1 ? i : i - parentIdx - 1;
        const label = breaksBull ? `30min Bull Breakout > $${fmt(boundaryHigh)}` : `30min Bear Breakout < $${fmt(boundaryLow)}`;
        return { direction: requiredDirection, label, closePrice: c.close, dateStr, targetLevel: breaksBull ? boundaryHigh : boundaryLow, auxCount };
      } else {
        parentIdx = i; boundaryHigh = c.high; boundaryLow = c.low;
      }
    } else {
      if (c.high > boundaryHigh) boundaryHigh = c.high;
      if (c.low < boundaryLow) boundaryLow = c.low;
    }
  }
  return null;
}

/* ── TELEGRAM (with the same persistent retry queue as index-v12.html) ── */
async function sendTelegramOne(chatId, message) {
  try {
    const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
    const res = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: 'HTML' })
    });
    if (res.ok) return true;
    const body = await res.text().catch(() => '');
    console.log('Telegram send FAILED for', chatId, res.status, body);
    return false;
  } catch (e) {
    console.log('Telegram network error for', chatId, ':', e.message);
    return false;
  }
}
async function sendTelegram(state, message) {
  for (const chatId of TG_RECIPIENTS) {
    const ok = await sendTelegramOne(chatId, message);
    if (!ok) {
      state.tgQueue.push({ chatId, message, attempts: 1, queuedAt: Date.now() });
      console.log(`Queued failed send for ${chatId}`);
    }
  }
}
async function flushTgQueue(state) {
  if (!state.tgQueue.length) return;
  const stillFailed = [];
  for (const item of state.tgQueue) {
    const ok = await sendTelegramOne(item.chatId, item.message);
    if (ok) {
      console.log(`Queued alert to ${item.chatId} finally delivered`);
    } else {
      item.attempts++;
      if (item.attempts <= MAX_TG_RETRY_ATTEMPTS) stillFailed.push(item);
      else console.log(`Giving up on queued alert to ${item.chatId} after ${MAX_TG_RETRY_ATTEMPTS} tries`);
    }
    await sleep(200);
  }
  state.tgQueue = stillFailed;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── MAIN ── */
async function main() {
  const state = await loadState();

  // Daily reset — same boundary as the browser version (midnight UTC)
  const todayUTC = new Date().toISOString().slice(0, 10);
  if (state.lastDailyResetUTCDate !== todayUTC) {
    console.log('New UTC day — resetting alerted pairs and watchlist');
    state.tgAlertedPairs = [];
    state.confirmedAlertedPairs = [];
    state.watchlist = [];
    state.lastDailyResetUTCDate = todayUTC;
  }
  const tgAlertedPairs = new Set(state.tgAlertedPairs);
  const confirmedAlertedPairs = new Set(state.confirmedAlertedPairs);

  // Retry anything stuck from a previous run FIRST
  await flushTgQueue(state);

  // ── 1D SCAN ──
  console.log('Fetching symbols...');
  const symbols = await fetchSymbols();
  console.log(`Scanning ${symbols.length} pairs...`);
  let engulfResults = [], auxResults = [];
  const BATCH = 10;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH);
    await Promise.all(batch.map(async sym => {
      try {
        const klines = await fetchKlines(sym);
        const { engulf, aux } = analyseSymbol(sym, klines);
        if (engulf) engulfResults.push(engulf);
        if (aux) auxResults.push(aux);
      } catch (_) {}
    }));
    await sleep(120);
  }
  console.log(`Scan done: ${engulfResults.length} engulfing, ${auxResults.length} aux breakouts`);

  // Dedup
  const seenE = new Set();
  engulfResults = engulfResults.filter(r => (seenE.has(r.symbol) ? false : (seenE.add(r.symbol), true)));
  const seenA = new Set();
  auxResults = auxResults.filter(r => (seenA.has(r.symbol) ? false : (seenA.add(r.symbol), true)));

  // ── SCAN SUMMARY TELEGRAM (new pairs only) ──
  const allNew = [...engulfResults, ...auxResults];
  const newPairs = allNew.filter(r => !tgAlertedPairs.has(r.symbol));
  if (newPairs.length) {
    const newEngulfBull = engulfResults.filter(r => r.direction === 'bull' && newPairs.includes(r));
    const newEngulfBear = engulfResults.filter(r => r.direction === 'bear' && newPairs.includes(r));
    const newAuxBull = auxResults.filter(r => r.direction === 'bull' && newPairs.includes(r));
    const newAuxBear = auxResults.filter(r => r.direction === 'bear' && newPairs.includes(r));
    let tgSummary = `🤖 <b>ORCHEM BOT — NEW SIGNALS</b>\n${allNew.length} new setups found\n\n`;
    if (newEngulfBull.length) tgSummary += `🟢 Bull Engulfing: ${newEngulfBull.map(r => r.symbol.replace('USDT', '')).join(', ')}\n`;
    if (newEngulfBear.length) tgSummary += `🔴 Bear Engulfing: ${newEngulfBear.map(r => r.symbol.replace('USDT', '')).join(', ')}\n`;
    if (newAuxBull.length) tgSummary += `🟢 Aux Bull Breakout: ${newAuxBull.map(r => r.symbol.replace('USDT', '')).join(', ')}\n`;
    if (newAuxBear.length) tgSummary += `🔴 Aux Bear Breakout: ${newAuxBear.map(r => r.symbol.replace('USDT', '')).join(', ')}\n`;
    tgSummary += `\n⏳ Watching for 30min confirmations...`;
    await sendTelegram(state, tgSummary);
    newPairs.forEach(r => tgAlertedPairs.add(r.symbol));
  } else {
    console.log('No new pairs this cycle — skipping summary message');
  }

  // ── BUILD WATCHLIST ──
  const allSignals = [...engulfResults, ...auxResults.filter(r => r.direction !== null)];
  const todayUTCms = new Date(); todayUTCms.setUTCHours(0, 0, 0, 0);
  const dailyOpenTimestamp = todayUTCms.getTime();

  const trailingMap = {};
  for (const r of allSignals) {
    trailingMap[r.symbol] = await calcSuggestedTrailing(r.symbol);
    await sleep(50);
  }

  const watchlist = allSignals.map(r => ({
    symbol: r.symbol, direction: r.direction, signal1d: r.label || r.signal,
    signalTimestamp: dailyOpenTimestamp,
    signalHigh: r.signalHigh != null ? r.signalHigh : null,
    signalLow: r.signalLow != null ? r.signalLow : null,
    tpLevel: r.tpLevel || null, tpGain: r.tpGain || null, tpEstimated: r.tpEstimated || false,
    slLevel: r.slLevel || null, slRisk: r.slRisk || null, slEstimated: r.slEstimated || false,
    trailingPct: trailingMap[r.symbol] || null,
    entryPrice: r.price || r.closePrice || null,
    detectedAt: Date.now(),
    alerted: confirmedAlertedPairs.has(r.symbol)
  }));

  // ── 30MIN CONFIRMATION ──
  console.log(`Checking ${watchlist.length} watchlist pairs for 30min confirmation...`);
  for (const item of watchlist) {
    try {
      const candles2h = await fetch2HKlines(item.symbol, item.signalTimestamp);
      const result2h = candles2h ? analyse2H(item.symbol, candles2h, item.direction, item.signalHigh, item.signalLow) : null;

      if (result2h && !item.alerted) {
        item.alerted = true;
        confirmedAlertedPairs.add(item.symbol);
        const dir = result2h.direction === 'bull' ? '▲ LONG' : '▼ SHORT';
        const dirEmoji = result2h.direction === 'bull' ? '🟢' : '🔴';
        const entryPrice = result2h.closePrice;

        let confirmTp = null, confirmSl = null;
        try {
          const freshKlines = await fetchKlines(item.symbol);
          if (freshKlines && freshKlines.length > 5) {
            const freshClosed = freshKlines.slice(0, -1);
            const freshLevels = findSwingLevels(freshClosed);
            confirmTp = resolveTP(entryPrice, freshLevels, freshClosed, item.direction);
            confirmSl = resolveSL(entryPrice, freshLevels, freshClosed, item.direction);
          }
        } catch (_) {}

        const tpValid = confirmTp && ((item.direction === 'bull' && confirmTp.price > entryPrice) || (item.direction === 'bear' && confirmTp.price < entryPrice));
        const slValid = confirmSl && ((item.direction === 'bull' && confirmSl.price < entryPrice) || (item.direction === 'bear' && confirmSl.price > entryPrice));
        if (tpValid) { item.tpLevel = confirmTp.price; item.tpGain = calcRR(entryPrice, confirmTp.price); item.tpEstimated = confirmTp.estimated; }
        if (slValid) { item.slLevel = confirmSl.price; item.slRisk = calcRR(entryPrice, confirmSl.price); item.slEstimated = confirmSl.estimated; }

        state.tradeLog.unshift({
          symbol: item.symbol, direction: item.direction, signal1d: item.signal1d,
          confirmation: result2h.label, entryPrice, tpLevel: item.tpLevel, slLevel: item.slLevel,
          confirmedAt: Date.now()
        });
        state.tradeLog = state.tradeLog.slice(0, 200); // cap log size

        const tpTag = item.tpEstimated ? ' ⚠️est.' : '';
        const slTag = item.slEstimated ? ' ⚠️est.' : '';
        const tpText = item.tpLevel ? `\n🎯 TP: $${fmt(item.tpLevel)} (+${item.tpGain}%)${tpTag}` : '\n🎯 TP: none found — size manually';
        const slText = item.slLevel ? `\n🛑 SL: $${fmt(item.slLevel)} (-${item.slRisk}%)${slTag}` : '\n🛑 SL: none found — size manually';
        const trailingText = item.trailingPct ? `\n📌 Trailing Stop: ${item.trailingPct}% (set on Bybit)` : '';
        tgAlertedPairs.add(item.symbol);
        const tgMsg = `${dirEmoji} <b>ENTRY CONFIRMED</b>\n`
          + `<b>${item.symbol.replace('USDT', '')}/USDT</b> · ${dir}\n`
          + `Signal: ${item.signal1d}\n`
          + `Confirmation: ${result2h.label}\n`
          + `Entry: $${fmt(entryPrice)} · ${result2h.dateStr}`
          + tpText + slText + trailingText;
        console.log('ENTRY CONFIRMED:', item.symbol);
        await sendTelegram(state, tgMsg);
      }
    } catch (e) {
      console.log('Confirmation check failed for', item.symbol, e.message);
    }
    await sleep(80);
  }

  // Persist state for next run
  state.watchlist = watchlist;
  state.tgAlertedPairs = [...tgAlertedPairs];
  state.confirmedAlertedPairs = [...confirmedAlertedPairs];
  await saveState(state);
  console.log('Run complete. State saved.');
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });

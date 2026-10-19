/* ═══════════════════════════════════════
   RECENT-MOVE EXHAUSTION FILTER + TIGHT SL +
   POSITION SIZING — ported from index-v15.html
═══════════════════════════════════════ */
const { apiFetch, safeJson, BINANCE, RateLimitError } = require('./binance');

const RECENT_MOVE_LOOKBACK_CANDLES = 8; // 8 x 30min = last ~4 hours
const RECENT_MOVE_EXHAUSTION_PCT = 10;  // flat fallback only

const EXHAUSTION_VOLATILITY_MULTIPLIER = 4;
const EXHAUSTION_PCT_FLOOR = 6;
const EXHAUSTION_PCT_CEILING = 20;

async function calcPairExhaustionThreshold(symbol) {
  try {
    const r = await apiFetch(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=30m&limit=48`);
    const raw = await safeJson(r);
    if (!Array.isArray(raw) || raw.length < 10) return RECENT_MOVE_EXHAUSTION_PCT;
    const ranges = raw.map(k => {
      const high = parseFloat(k[2]), low = parseFloat(k[3]), close = parseFloat(k[4]);
      return close > 0 ? ((high - low) / close) * 100 : 0;
    });
    const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    const scaled = avgRange * EXHAUSTION_VOLATILITY_MULTIPLIER;
    return Math.min(EXHAUSTION_PCT_CEILING, Math.max(EXHAUSTION_PCT_FLOOR, scaled));
  } catch (e) {
    if (e instanceof RateLimitError) throw e;
    return RECENT_MOVE_EXHAUSTION_PCT;
  }
}

function isRecentMoveExhausted(candles, direction, thresholdPct = RECENT_MOVE_EXHAUSTION_PCT) {
  if (!candles || candles.length < 2) return false;
  const recent = candles.slice(-RECENT_MOVE_LOOKBACK_CANDLES);
  if (recent.length < 2) return false;
  const recentHigh = Math.max(...recent.map(c => c.high));
  const recentLow = Math.min(...recent.map(c => c.low));
  if (recentHigh <= 0) return false;
  if (direction === 'bear') {
    const recentDropPct = ((recentHigh - recentLow) / recentHigh) * 100;
    return recentDropPct >= thresholdPct;
  } else {
    if (recentLow <= 0) return false;
    const recentPumpPct = ((recentHigh - recentLow) / recentLow) * 100;
    return recentPumpPct >= thresholdPct;
  }
}

// Tight stop-loss: prior 30min candle's own extreme.
function tightStopLevel(entryPrice, priorCandle, direction) {
  if (!priorCandle) return null;
  const level = direction === 'bull' ? priorCandle.low : priorCandle.high;
  const valid = direction === 'bull' ? level < entryPrice * 0.999 : level > entryPrice * 1.001;
  return valid ? { price: level, estimated: false, tight: true } : null;
}

// Position size for a fixed max-risk amount + suggested leverage for a
// fixed margin commitment. All three numbers (MAX_RISK_USD,
// MARGIN_PER_TRADE_USD, MAX_SENSIBLE_LEVERAGE) come from env so they can be
// changed without touching code.
function calcPositionSize(entryPrice, slLevel, maxRiskUsd, marginUsd) {
  if (!entryPrice || !slLevel) return null;
  const riskPerUnit = Math.abs(entryPrice - slLevel);
  if (riskPerUnit <= 0) return null;
  const qty = maxRiskUsd / riskPerUnit;
  const notional = qty * entryPrice;
  const leverage = marginUsd ? notional / marginUsd : null;
  return { qty, notional, riskUsd: maxRiskUsd, leverage };
}

async function calcSuggestedTrailing(symbol) {
  try {
    const r = await apiFetch(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=30m&limit=20`);
    if (!r) {
      console.log(`[trailing] ${symbol}: apiFetch returned null (request failed or non-OK — see [binance] log above)`);
      return null;
    }
    const raw = await safeJson(r);
    if (!Array.isArray(raw) || raw.length < 5) {
      console.log(`[trailing] ${symbol}: bad/short klines response, got ${Array.isArray(raw) ? raw.length : typeof raw}`);
      return null;
    }
    const ranges = raw.map(k => {
      const high = parseFloat(k[2]), low = parseFloat(k[3]), close = parseFloat(k[4]);
      return ((high - low) / close) * 100;
    });
    const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
    const suggested = Math.max(0.5, (avgRange * 1.5)).toFixed(1);
    return parseFloat(suggested);
  } catch (e) {
    if (e instanceof RateLimitError) throw e;
    console.log(`[trailing] ${symbol}: threw — ${e.message}`);
    return null;
  }
}

module.exports = {
  RECENT_MOVE_LOOKBACK_CANDLES, RECENT_MOVE_EXHAUSTION_PCT,
  EXHAUSTION_VOLATILITY_MULTIPLIER, EXHAUSTION_PCT_FLOOR, EXHAUSTION_PCT_CEILING,
  calcPairExhaustionThreshold, isRecentMoveExhausted, tightStopLevel,
  calcPositionSize, calcSuggestedTrailing
};

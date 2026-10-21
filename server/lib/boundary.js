/* ═══════════════════════════════════════
   CORE BOUNDARY / SIGNAL LOGIC
   Ported verbatim from index-v15.html — this
   is the tested trading logic, unchanged.
═══════════════════════════════════════ */
const SR_PROXIMITY_PCT = 5;
const BOUNDARY_LOOKBACK = 50;
const MA_PERIOD = 50;
const VOL_LOOKBACK = 20;
const VOL_MULTIPLIER = 1.2;
const EXTREME_NEAR_PCT = 5;
const EXTREME_MOVE_PCT = 70;
const MIN_TP_PCT = 4;

function classifyPattern(parent, curr) {
  const parentRed = !parent.isBullish;
  const parentGreen = parent.isBullish;
  const currGreen = curr.isBullish;
  const currRed = !curr.isBullish;

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

  let parentIdx = 0;
  let boundaryHigh = window[0].high;
  let boundaryLow = window[0].low;

  for (let i = 1; i < wn; i++) {
    const c = window[i];
    if (c.close > boundaryHigh || c.close < boundaryLow) {
      parentIdx = i;
      boundaryHigh = c.high;
      boundaryLow = c.low;
    } else {
      if (c.high > boundaryHigh) boundaryHigh = c.high;
      if (c.low < boundaryLow) boundaryLow = c.low;
    }
  }

  const auxCount = (wn - 1) - parentIdx;
  const parentCandle = window[parentIdx];

  return { parentCandle, boundaryHigh, boundaryLow, auxCount };
}

function findSwingLevels(candles) {
  const levels = [];
  for (let i = 2; i < candles.length - 2; i++) {
    if (candles[i].high > candles[i - 1].high && candles[i].high > candles[i - 2].high &&
        candles[i].high > candles[i + 1].high && candles[i].high > candles[i + 2].high) {
      levels.push({ price: candles[i].high, type: 'resistance' });
    }
    if (candles[i].low < candles[i - 1].low && candles[i].low < candles[i - 2].low &&
        candles[i].low < candles[i + 1].low && candles[i].low < candles[i + 2].low) {
      levels.push({ price: candles[i].low, type: 'support' });
    }
  }
  return levels;
}

function nearestLevel(price, levels) {
  let best = null, bestDist = Infinity;
  for (const lvl of levels) {
    const dist = Math.abs(price - lvl.price) / lvl.price * 100;
    if (dist <= SR_PROXIMITY_PCT && dist < bestDist) {
      best = { ...lvl, proximity: dist };
      bestDist = dist;
    }
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

function calcRR(entryPrice, tpPrice) {
  return Math.abs((tpPrice - entryPrice) / entryPrice * 100).toFixed(2);
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
  const highs = closed.map(c => c.high);
  const lows = closed.map(c => c.low);
  if (kind === 'tp') {
    return direction === 'bull' ? Math.max(...highs) : Math.min(...lows);
  } else {
    return direction === 'bull' ? Math.min(...lows) : Math.max(...highs);
  }
}

// 'source' on every returned level says exactly which method produced it
// (swing-level | range-extreme | tight-prior-candle) — without this,
// there's no way to answer "how was this SL actually calculated?" for any
// specific past trade after the fact.
function resolveTP(price, levels, closed, direction) {
  const lvl = findTPLevel(price, levels, direction);
  if (lvl) return { price: lvl.price, estimated: false, source: 'swing-level' };
  const fb = rangeExtremeLevel(closed, direction, 'tp');
  if (fb == null) return null;
  const valid = direction === 'bull' ? fb > price * 1.005 : fb < price * 0.995;
  return valid ? { price: fb, estimated: true, source: 'range-extreme' } : null;
}

function resolveSL(price, levels, closed, direction) {
  const lvl = findSLLevel(price, levels, direction);
  if (lvl) return { price: lvl.price, estimated: false, source: 'swing-level' };
  const fb = rangeExtremeLevel(closed, direction, 'sl');
  if (fb == null) return null;
  const valid = direction === 'bull' ? fb < price * 0.995 : fb > price * 1.005;
  return valid ? { price: fb, estimated: true, source: 'range-extreme' } : null;
}

/* AUXILIARY RANGE (30min), used for the stop-loss.
   Same idea as the 1D boundary: a "parent" candle, then candles that CLOSE
   inside the range are auxiliary and stretch the range with their wicks;
   a close outside the range starts a new parent. A bullish break is a close
   above the stretched high, a bearish break a close below the stretched low.
   The stop sits at the far edge: the lowest shadow of the whole aux market
   for a long, the highest shadow for a short. That is exactly the level
   whose break would invalidate the setup. `candles` must be oldest-first
   and must NOT include the confirmation candle itself. */
function findAuxRange(candles) {
  if (!candles || !candles.length) return null;
  let parentIdx = 0;
  let high = candles[0].high;
  let low = candles[0].low;
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    if (c.close > high || c.close < low) {
      parentIdx = i;
      high = c.high;
      low = c.low;
    } else {
      if (c.high > high) high = c.high;
      if (c.low < low) low = c.low;
    }
  }
  return { parentIdx, parentTime: candles[parentIdx].time, high, low, auxCount: candles.length - 1 - parentIdx };
}

function auxRangeStopLevel(entryPrice, candles, direction) {
  const r = findAuxRange(candles);
  if (!r) return null;
  const level = direction === 'bull' ? r.low : r.high;
  const valid = direction === 'bull' ? level < entryPrice * 0.999 : level > entryPrice * 1.001;
  return valid ? { price: level, estimated: false, source: 'aux-range', parentTime: r.parentTime, auxCount: r.auxCount } : null;
}

function getSignalAge(signalTimestamp) {
  if (!signalTimestamp) return null;
  const hours = (Date.now() - signalTimestamp) / (1000 * 60 * 60);
  let color, label;
  if (hours <= 8) { color = 'bull'; label = 'Fresh'; }
  else if (hours <= 16) { color = 'warn'; label = 'Aging'; }
  else { color = 'bear'; label = 'Stale'; }
  return { hours: hours.toFixed(1), color, label };
}

function calcStrength(candle, levels) {
  const count = levels.filter(l => Math.abs(l.price - candle.close) / candle.close * 100 < 10).length;
  return Math.min(100, count * 18 + 28);
}

/* ANALYSE ONE SYMBOL (1D scan) */
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

  let engulf = null;
  let aux = null;

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
          srLevel: lvl ? lvl.price : 0,
          srType: lvl ? lvl.type : 'none',
          proximity: lvl ? lvl.proximity : 999,
          hasSR: !!lvl,
          tpLevel: tpRes ? tpRes.price : null,
          tpGain: tpRes ? calcRR(curr.close, tpRes.price) : null,
          tpEstimated: tpRes ? tpRes.estimated : false,
          slLevel: slRes ? slRes.price : null,
          slRisk: slRes ? calcRR(curr.close, slRes.price) : null,
          slEstimated: slRes ? slRes.estimated : false,
          volRatio,
          ma50: ma50 ? ma50.toFixed(4) : null,
          strength: calcStrength(curr, levels)
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
          closePrice: curr.close,
          rangeHigh: boundaryHigh, rangeLow: boundaryLow,
          signalHigh: curr.high, signalLow: curr.low,
          candlesSinceEngulf: auxCount, dateStr,
          srLevel: lvl ? lvl.price : 0,
          srType: lvl ? lvl.type : 'none',
          proximity: lvl ? lvl.proximity : 999,
          hasSR: !!lvl,
          tpLevel: tpRes ? tpRes.price : null,
          tpGain: tpRes ? calcRR(curr.close, tpRes.price) : null,
          tpEstimated: tpRes ? tpRes.estimated : false,
          slLevel: slRes ? slRes.price : null,
          slRisk: slRes ? calcRR(curr.close, slRes.price) : null,
          slEstimated: slRes ? slRes.estimated : false,
          volRatio,
          ma50: ma50 ? ma50.toFixed(4) : null
        };
      }
    }
  } else if (auxCount >= 1) {
    aux = {
      symbol, direction: null,
      signal: '⏳ Awaiting Breakout',
      closePrice: curr.close,
      rangeHigh: boundaryHigh, rangeLow: boundaryLow,
      candlesSinceEngulf: auxCount, dateStr
    };
  }

  return { engulf, aux };
}

/* 30MIN CONFIRMATION — invalidation-based boundary (the fixed version) */
function analyse2H(symbol, candles2h, requiredDirection, signalHigh, signalLow, fmt) {
  if (!candles2h || candles2h.length < 2) return null;

  const closed = candles2h.slice(0, -1);
  if (closed.length < 1) return null;

  let boundaryHigh = signalHigh;
  let boundaryLow = signalLow;

  for (let i = 0; i < closed.length; i++) {
    const c = closed[i];

    const breaksBull = c.close > boundaryHigh;
    const breaksBear = c.close < boundaryLow;

    if (breaksBull || breaksBear) {
      const direction = breaksBull ? 'bull' : 'bear';

      if (direction === requiredDirection) {
        const closeTime = c.time + (30 * 60 * 1000);
        // Server runs in UTC, which made Telegram show 02:30 for a candle that
        // closed at 03:30 Lagos time. Format in the user's timezone instead
        // (override with DISPLAY_TZ if it ever changes).
        const dateStr = new Date(closeTime).toLocaleString('en-GB', {
          day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit',
          timeZone: process.env.DISPLAY_TZ || 'Africa/Lagos'
        });
        const label = breaksBull
          ? `30min Bull Breakout > $${fmt(boundaryHigh)}`
          : `30min Bear Breakout < $${fmt(boundaryLow)}`;

        return {
          direction: requiredDirection,
          label,
          closePrice: c.close,
          dateStr,
          targetLevel: breaksBull ? boundaryHigh : boundaryLow,
          auxCount: i,
          priorCandle: closed[i - 1] || null,
          confirmTime: c.time
        };
      } else {
        return { invalidated: true, invalidatedAt: c.time };
      }
    } else {
      if (c.high > boundaryHigh) boundaryHigh = c.high;
      if (c.low < boundaryLow) boundaryLow = c.low;
    }
  }

  return null;
}

module.exports = {
  SR_PROXIMITY_PCT, BOUNDARY_LOOKBACK, MA_PERIOD, VOL_LOOKBACK, VOL_MULTIPLIER,
  EXTREME_NEAR_PCT, EXTREME_MOVE_PCT, MIN_TP_PCT,
  classifyPattern, findBoundary, findSwingLevels, nearestLevel, isTooCloseToExtreme,
  calcMA, avgVolume, findTPLevel, calcRR, findSLLevel, rangeExtremeLevel,
  resolveTP, resolveSL, findAuxRange, auxRangeStopLevel, getSignalAge, calcStrength, analyseSymbol, analyse2H
};

/* ═══════════════════════════════════════
   BINANCE HELPERS
   Server-side: no CORS, so this is a plain
   fetch straight to Binance — no proxy
   fallback chain needed (that chain only
   existed to work around the browser's
   CORS restrictions, which don't apply here).
═══════════════════════════════════════ */
const BINANCE = 'https://fapi.binance.com';

async function apiFetch(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
    if (r.ok) return r;
    console.log(`[binance] non-OK response ${r.status} for ${url}`);
    return null;
  } catch (e) {
    console.log(`[binance] fetch error for ${url}:`, e.message);
    return null;
  }
}

async function safeJson(r) {
  if (!r) return null;
  try {
    return await r.json();
  } catch (_) {
    return null;
  }
}

async function fetchSymbols() {
  const r = await apiFetch(`${BINANCE}/fapi/v1/exchangeInfo`);
  const d = await safeJson(r);
  if (!d || !Array.isArray(d.symbols)) throw new Error('Could not reach Binance API.');
  return d.symbols
    .filter(s => s.quoteAsset === 'USDT' && s.status === 'TRADING' && s.contractType === 'PERPETUAL')
    .map(s => s.symbol);
}

async function fetchKlines(symbol, limit = 60, interval = '1d') {
  const r = await apiFetch(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=${interval}&limit=${limit}`);
  const raw = await safeJson(r);
  if (!Array.isArray(raw)) return null;
  return raw.map(k => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    isBullish: parseFloat(k[4]) >= parseFloat(k[1])
  }));
}

// Returns both the signal-window-filtered candles (for the boundary logic,
// which must only look at candles since the 1D signal closed) AND the full
// unfiltered 100-candle history (the exhaustion check needs this so a
// signal that closed right after UTC midnight still has real lookback).
async function fetch2HKlines(symbol, sinceTimestamp) {
  const r = await apiFetch(`${BINANCE}/fapi/v1/klines?symbol=${symbol}&interval=30m&limit=100`);
  const raw = await safeJson(r);
  if (!Array.isArray(raw)) return null;
  const all = raw.map(k => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    isBullish: parseFloat(k[4]) >= parseFloat(k[1])
  }));
  return {
    filtered: all.filter(c => c.time >= sinceTimestamp),
    all
  };
}

module.exports = { BINANCE, apiFetch, safeJson, fetchSymbols, fetchKlines, fetch2HKlines };

/* ═══════════════════════════════════════
   BYBIT MARKET DATA
   Replaces binance.js as the data source for signal
   detection. Uses Bybit's public market-data endpoints
   on api.bybit.com — no API key needed, and the real
   mainnet market-data host (not api-demo.bybit.com,
   which is documented only for order/account endpoints;
   Bybit's own docs say demo trading's public data
   mirrors live mainnet anyway, so there's no accuracy
   loss in using the mainnet host here).

   Why switch off Binance: the bot already trades on
   Bybit, so detecting signals from Bybit's own candles
   means the price feed that produces a signal is the
   exact same one the order fills against — no more
   cross-exchange mismatch. It also sidesteps Binance's
   harsher rate-limit/ban policy (up to 3 days for repeat
   offenders) — Bybit's public IP limit is a much more
   forgiving 600 requests/5s, and a breach is a ~10min
   auto-lifting cooldown, not an escalating multi-day ban.

   Candle shape returned matches binance.js's exactly —
   {time, open, high, low, close, volume, isBullish},
   oldest-first — so boundary.js/filters.js need ZERO
   changes; only this fetch layer differs.
═══════════════════════════════════════ */
const BYBIT_MARKET = 'https://api.bybit.com';

// Thrown instead of returning null on a rate-limit/ban response — same
// contract as binance.js's RateLimitError (status + retryAfterSec), so
// every existing `e instanceof RateLimitError` check elsewhere in the
// codebase keeps working once those files import it from here instead.
class RateLimitError extends Error {
  constructor(status, retryAfterSec) {
    super(`Bybit rate limit (${status}), retry after ${retryAfterSec}s`);
    this.status = status;
    this.retryAfterSec = retryAfterSec;
  }
}

async function apiFetch(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(9000) });
    // Bybit's documented IP-ban response for the public HTTP limit.
    if (r.status === 403) {
      console.log('[bybit-market] 403 (access too frequent) — backing off 600s before any further requests');
      throw new RateLimitError(403, 600);
    }
    if (!r.ok) {
      console.log(`[bybit-market] non-OK response ${r.status} for ${url}`);
      return null;
    }
    const json = await r.json().catch(() => null);
    if (!json) return null;
    if (json.retCode !== 0) {
      // retCode 10006 = "Too many visits!" (the per-second API limit).
      if (json.retCode === 10006) {
        console.log('[bybit-market] retCode 10006 (too many visits) — backing off 60s');
        throw new RateLimitError(10006, 60);
      }
      console.log(`[bybit-market] non-zero retCode ${json.retCode} (${json.retMsg}) for ${url}`);
      return null;
    }
    return json.result;
  } catch (e) {
    if (e instanceof RateLimitError) throw e;
    console.log(`[bybit-market] fetch error for ${url}:`, e.message);
    return null;
  }
}

// USDT linear perpetuals, trading status only — paginated via cursor
// since Bybit has well over 500 linear symbols (the single-page limit).
async function fetchSymbols() {
  const symbols = [];
  let cursor = '';
  for (let page = 0; page < 10; page++) { // generous cap; real catalog needs 1-2 pages at limit=1000
    const url = `${BYBIT_MARKET}/v5/market/instruments-info?category=linear&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const result = await apiFetch(url);
    if (!result || !Array.isArray(result.list)) break;
    for (const s of result.list) {
      if (s.quoteCoin === 'USDT' && s.status === 'Trading' && s.contractType === 'LinearPerpetual') {
        symbols.push(s.symbol);
      }
    }
    if (!result.nextPageCursor) break;
    cursor = result.nextPageCursor;
  }
  if (!symbols.length) throw new Error('Could not reach Bybit market data API.');
  return symbols;
}

// interval keeps the same '1d' / '30m' strings the rest of the codebase
// already calls this with (ported from binance.js's signature) — mapped
// here to Bybit's own interval tokens ('D', '30').
const INTERVAL_MAP = { '1d': 'D', '30m': '30' };

async function fetchKlines(symbol, limit = 60, interval = '1d') {
  const bybitInterval = INTERVAL_MAP[interval];
  if (!bybitInterval) throw new Error(`[bybit-market] unsupported interval "${interval}"`);
  const url = `${BYBIT_MARKET}/v5/market/kline?category=linear&symbol=${symbol}&interval=${bybitInterval}&limit=${limit}`;
  const result = await apiFetch(url);
  if (!result || !Array.isArray(result.list)) return null;
  // Bybit returns candles NEWEST-first. Every bit of boundary/swing-level
  // logic in this codebase walks the array forward in time by index, so
  // this reverse is the single most important line in this file — get it
  // wrong and every signal silently corrupts with no error thrown.
  return result.list.slice().reverse().map(k => ({
    time: Number(k[0]),
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    isBullish: parseFloat(k[4]) >= parseFloat(k[1])
  }));
}

// Same {filtered, all} shape binance.js's fetch2HKlines returned — filtered
// is candles since the 1D signal closed (for the boundary logic), all is
// the full fetched window (the exhaustion check's lookback).
async function fetch2HKlines(symbol, sinceTimestamp) {
  const all = await fetchKlines(symbol, 100, '30m');
  if (!all) return null;
  return {
    filtered: all.filter(c => c.time >= sinceTimestamp),
    all
  };
}

module.exports = { BYBIT_MARKET, apiFetch, fetchSymbols, fetchKlines, fetch2HKlines, RateLimitError };

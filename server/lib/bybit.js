/* ═══════════════════════════════════════
   BYBIT DEMO-TRADING EXECUTION
   Places real orders — on Bybit's Demo Trading
   account, never live. This talks ONLY to
   api-demo.bybit.com, a separate domain from
   Bybit's live API (api.bybit.com). A key
   generated for Demo Trading only works here;
   it physically cannot touch a live balance.

   Signals still come from Binance (that's
   where the boundary-candle logic reads
   candles from) — this module just takes a
   CONFIRMED signal and opens the matching
   position on Bybit's linear USDT-perpetual
   market, since Bybit is where the account
   actually lives.

   Auto-trading is OFF unless BYBIT_AUTO_TRADE=true
   is explicitly set — the bot stays alert-only
   (Telegram) by default even with keys present.
═══════════════════════════════════════ */
const crypto = require('crypto');

const BYBIT_BASE = 'https://api-demo.bybit.com';
const API_KEY = process.env.BYBIT_API_KEY || '';
const API_SECRET = process.env.BYBIT_API_SECRET || '';
const AUTO_TRADE = (process.env.BYBIT_AUTO_TRADE || 'false').toLowerCase() === 'true';
const RECV_WINDOW = '5000';

if (AUTO_TRADE && (!API_KEY || !API_SECRET)) {
  console.log('[bybit] WARNING: BYBIT_AUTO_TRADE is true but BYBIT_API_KEY/BYBIT_API_SECRET are missing — auto-trading will fail every attempt.');
}

function sign(payload) {
  return crypto.createHmac('sha256', API_SECRET).update(payload).digest('hex');
}

// One signer for both GET (query string) and POST (JSON body) — Bybit V5
// concatenates timestamp + apiKey + recvWindow + (queryString OR jsonBody)
// in that exact order, then HMAC-SHA256s it with the API secret.
async function bybitRequest(method, path, params = {}) {
  const timestamp = Date.now().toString();
  let url = `${BYBIT_BASE}${path}`;
  let body = undefined;
  let signPayload;

  if (method === 'GET') {
    const qs = new URLSearchParams(params).toString();
    if (qs) url += `?${qs}`;
    signPayload = timestamp + API_KEY + RECV_WINDOW + qs;
  } else {
    body = JSON.stringify(params);
    signPayload = timestamp + API_KEY + RECV_WINDOW + body;
  }

  const headers = {
    'X-BAPI-API-KEY': API_KEY,
    'X-BAPI-TIMESTAMP': timestamp,
    'X-BAPI-RECV-WINDOW': RECV_WINDOW,
    'X-BAPI-SIGN': sign(signPayload),
    'Content-Type': 'application/json'
  };

  const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(10000) });
  const data = await res.json().catch(() => null);
  if (!data) throw new Error(`Bybit ${path}: non-JSON response (HTTP ${res.status})`);
  // retCode 0 is Bybit's success code across all V5 endpoints.
  if (data.retCode !== 0) {
    const err = new Error(`Bybit ${path}: ${data.retMsg} (retCode ${data.retCode})`);
    err.retCode = data.retCode;
    throw err;
  }
  return data.result;
}

// Instrument filters (qty step, min qty, price tick) rarely change — cache
// per process lifetime instead of fetching before every single order.
const instrumentCache = new Map();

async function getInstrumentInfo(symbol) {
  if (instrumentCache.has(symbol)) return instrumentCache.get(symbol);
  const result = await bybitRequest('GET', '/v5/market/instruments-info', { category: 'linear', symbol });
  const info = result && result.list && result.list[0];
  if (!info) return null; // symbol doesn't exist on Bybit's linear market
  const parsed = {
    qtyStep: parseFloat(info.lotSizeFilter.qtyStep),
    minOrderQty: parseFloat(info.lotSizeFilter.minOrderQty),
    tickSize: parseFloat(info.priceFilter.tickSize)
  };
  instrumentCache.set(symbol, parsed);
  return parsed;
}

function roundToStep(value, step) {
  if (!step) return value;
  const decimals = (step.toString().split('.')[1] || '').length;
  return parseFloat((Math.floor(value / step) * step).toFixed(decimals));
}

// Best-effort — "leverage not modified" (Bybit retCode 110043) just means
// it's already set to this value, which is fine, not an error worth
// aborting the trade over.
async function setLeverage(symbol, leverage) {
  try {
    // Floor, never round up — same reasoning as the dashboard figure:
    // understating leverage is the safe direction to be wrong in.
    const lev = String(Math.max(1, Math.floor(leverage)));
    await bybitRequest('POST', '/v5/position/set-leverage', {
      category: 'linear', symbol, buyLeverage: lev, sellLeverage: lev
    });
  } catch (e) {
    if (e.retCode !== 110043) {
      console.log(`[bybit] set-leverage warning for ${symbol}:`, e.message);
    }
  }
}

// Opens a market position with TP/SL attached in the same request (Bybit's
// "Full" tpslMode — simpler and more reliable than separate conditional
// orders, and avoids a window where the position is open with no stop).
async function placeOrder({ symbol, direction, qty, entryPrice, tpLevel, slLevel, leverage }) {
  if (!AUTO_TRADE) return { skipped: true, reason: 'BYBIT_AUTO_TRADE is off' };
  if (!API_KEY || !API_SECRET) return { skipped: true, reason: 'Bybit API keys not configured' };
  if (!slLevel) return { skipped: true, reason: 'no stop-loss level — refusing to open a position with no stop' };

  // Never trust an incoming TP/SL blindly, even from our own upstream code
  // — this is the last line of defense before real money (demo or not)
  // moves. A stop on the wrong side of entry is refused outright (Bybit
  // would reject it anyway, but better to know why). A bad take-profit is
  // dropped rather than refusing the whole trade over it — the position
  // still opens with its stop, just without an automatic TP.
  const slOnRightSide = direction === 'bull' ? slLevel < entryPrice : slLevel > entryPrice;
  if (!slOnRightSide) {
    return { skipped: true, reason: `stop-loss $${slLevel} is on the wrong side of entry $${entryPrice} for a ${direction === 'bull' ? 'long' : 'short'} — refusing to place` };
  }
  let safeTp = tpLevel;
  if (safeTp) {
    const tpOnRightSide = direction === 'bull' ? safeTp > entryPrice : safeTp < entryPrice;
    if (!tpOnRightSide) safeTp = null;
  }

  const info = await getInstrumentInfo(symbol);
  if (!info) return { skipped: true, reason: `${symbol} not available on Bybit's linear market` };

  const roundedQty = roundToStep(qty, info.qtyStep);
  if (roundedQty < info.minOrderQty) {
    return { skipped: true, reason: `position size ${roundedQty} below Bybit's minimum ${info.minOrderQty} for ${symbol}` };
  }

  if (leverage) {
    await setLeverage(symbol, leverage);
  }

  const side = direction === 'bull' ? 'Buy' : 'Sell';
  const roundedTp = safeTp ? roundToStep(safeTp, info.tickSize) : undefined;
  const roundedSl = roundToStep(slLevel, info.tickSize);

  const params = {
    category: 'linear',
    symbol,
    side,
    orderType: 'Market',
    qty: String(roundedQty),
    stopLoss: String(roundedSl),
    tpslMode: 'Full',
    slOrderType: 'Market'
  };
  if (roundedTp) {
    params.takeProfit = String(roundedTp);
    params.tpOrderType = 'Market';
  }

  const result = await bybitRequest('POST', '/v5/order/create', params);
  return { placed: true, orderId: result.orderId, symbol, side, qty: roundedQty, tp: roundedTp, sl: roundedSl };
}

module.exports = { AUTO_TRADE, placeOrder, getInstrumentInfo, bybitRequest };

/* ═══════════════════════════════════════
   BYBIT DEMO-TRADING EXECUTION
   Places real orders — on Bybit's Demo Trading
   account, never live. This talks ONLY to
   api-demo.bybit.com, a separate domain from
   Bybit's live API (api.bybit.com). A key
   generated for Demo Trading only works here;
   it physically cannot touch a live balance.

   Signals now also come from Bybit (see
   bybitMarket.js — the boundary-candle logic
   reads its candles from Bybit's public
   mainnet market data, api.bybit.com, not
   this module's api-demo.bybit.com) — this
   module just takes a CONFIRMED signal and
   opens the matching position on Bybit's
   linear USDT-perpetual market, since Bybit
   is where the account actually lives.

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

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function getPosition(symbol) {
  const result = await bybitRequest('GET', '/v5/position/list', { category: 'linear', symbol });
  return result && result.list && result.list[0];
}

async function updateTradingStop(symbol, { stopLoss, takeProfit, trailingStop, activePrice }) {
  const params = { category: 'linear', symbol, tpslMode: 'Full', positionIdx: 0 };
  if (stopLoss) params.stopLoss = String(stopLoss);
  if (takeProfit) params.takeProfit = String(takeProfit);
  if (trailingStop) params.trailingStop = String(trailingStop);
  // Trailing only starts working once the market reaches this price.
  if (activePrice) params.activePrice = String(activePrice);
  await bybitRequest('POST', '/v5/position/trading-stop', params);
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

// Whether a position is still open RIGHT NOW on the exchange — used to
// decide whether a logged trade is still "pending" or has actually closed,
// instead of guessing from replayed candles against stale SL/TP numbers.
async function getOpenPosition(symbol) {
  const pos = await getPosition(symbol);
  return pos && parseFloat(pos.size) > 0 ? pos : null;
}

// The real, closed result of a position that's no longer open — exit
// price and realized PnL, straight from Bybit, not inferred from candles.
async function getClosedPnl(symbol, startTimeMs) {
  const result = await bybitRequest('GET', '/v5/position/closed-pnl', {
    category: 'linear', symbol, startTime: String(startTimeMs), limit: '20'
  });
  return (result && result.list) || [];
}

// Every open linear position in ONE request, for the live P&L view. Numbers
// come back as strings from Bybit; "" or "0" on stopLoss/takeProfit/trailing
// fields means "not set".
async function listOpenPositions() {
  const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
  const level = v => { const n = num(v); return n && n > 0 ? n : null; };
  const out = [];
  let cursor = '';
  for (let page = 0; page < 5; page++) {
    const params = { category: 'linear', settleCoin: 'USDT', limit: '200' };
    if (cursor) params.cursor = cursor;
    const result = await bybitRequest('GET', '/v5/position/list', params);
    for (const p of (result && result.list) || []) {
      if (!(parseFloat(p.size) > 0)) continue;
      out.push({
        symbol: p.symbol,
        direction: p.side === 'Sell' ? 'bear' : 'bull',
        size: num(p.size),
        avgPrice: num(p.avgPrice),
        markPrice: num(p.markPrice),
        unrealisedPnl: num(p.unrealisedPnl),
        leverage: num(p.leverage),
        stopLoss: level(p.stopLoss),
        takeProfit: level(p.takeProfit),
        trailingStop: level(p.trailingStop),
        activePrice: level(p.activePrice)
      });
    }
    if (!result || !result.nextPageCursor) break;
    cursor = result.nextPageCursor;
  }
  return out;
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
async function placeOrder({ symbol, direction, qty, entryPrice, tpLevel, slLevel, leverage, trailingPct }) {
  if (!AUTO_TRADE) return { skipped: true, reason: 'BYBIT_AUTO_TRADE is off' };
  if (!API_KEY || !API_SECRET) return { skipped: true, reason: 'Bybit API keys not configured' };
  if (!slLevel) return { skipped: true, reason: 'no stop-loss level — refusing to open a position with no stop' };

  // The last line of defense against a DUPLICATE entry — our own local
  // "have we already confirmed this symbol today" tracking lives in a
  // state file that is NOT durable on Render's free tier (no persistent
  // disk), so a redeploy mid-day wipes it and a symbol that already has a
  // real open position can look "fresh" again to the next scan cycle.
  // Bybit's own position list can't be wiped by our redeploys — ask it
  // directly instead of trusting local memory, and refuse to stack a
  // second entry on top of one that's already open.
  try {
    const existing = await getOpenPosition(symbol);
    if (existing) {
      return { skipped: true, reason: `a position for ${symbol} is already open on Bybit (qty ${existing.size}) — refusing to open a duplicate` };
    }
  } catch (e) {
    console.log(`[bybit] could not check for an existing position in ${symbol} before placing — proceeding anyway:`, e.message);
  }

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

  // A MARKET order fills at whatever the live price is, not the
  // confirmation-candle close we estimated when sizing this trade — on a
  // fast-moving breakout the two can differ by a meaningful amount. Read
  // back the actual average entry so SL/TP (and the trailing distance
  // below) can be anchored to where we really got in, not the estimate.
  let realEntry = entryPrice;
  let finalSl = roundedSl;
  let finalTp = roundedTp;
  let trailingSet = null;
  try {
    let pos = null;
    for (let i = 0; i < 4; i++) {
      await sleep(400);
      pos = await getPosition(symbol);
      if (pos && parseFloat(pos.avgPrice) > 0) break;
    }
    const avgPrice = pos && parseFloat(pos.avgPrice);
    if (avgPrice) realEntry = avgPrice;

    const priceShifted = avgPrice && Math.abs(avgPrice - entryPrice) > info.tickSize;
    if (priceShifted) {
      // Fill landed away from our estimate — re-anchor SL/TP to the real
      // entry, preserving the same price distance (so the dollar risk
      // tracks back close to what qty was built for) rather than leaving
      // a stop that was only correct for a price we never actually got.
      const slDistance = Math.abs(entryPrice - slLevel);
      finalSl = roundToStep(
        direction === 'bull' ? realEntry - slDistance : realEntry + slDistance,
        info.tickSize
      );
      if (safeTp) {
        const tpDistance = Math.abs(entryPrice - safeTp);
        finalTp = roundToStep(
          direction === 'bull' ? realEntry + tpDistance : realEntry - tpDistance,
          info.tickSize
        );
      }
    }

    // Re-anchored SL/TP go in their own call, so nothing about the trailing
    // stop below can ever prevent them from being applied.
    if (priceShifted) {
      await updateTradingStop(symbol, { stopLoss: finalSl, takeProfit: finalTp });
      console.log(`[bybit] re-anchored ${symbol} SL/TP to actual fill $${realEntry} (estimated $${entryPrice}) — SL now $${finalSl}${finalTp ? `, TP $${finalTp}` : ''}`);
    }
  } catch (e) {
    console.log(`[bybit] could not re-anchor SL/TP for ${symbol} — stop stays at the pre-trade estimate:`, e.message);
  }

  // Trailing stop — a price DISTANCE (not a %) that only ARMS once the trade
  // is in profit: activePrice sits one trailing distance beyond the entry, so
  // by the time it starts working its trigger is already at break-even, and
  // it can never turn a trade that hasn't first moved into profit into a
  // trailing-stop loss. Until then only the SL protects the position. (It
  // used to start from entry, which let ordinary noise shake a trade out
  // long before the SL level — 1000PEPE, 21 Oct.) Separate call and its own
  // try/catch: if Bybit rejects it, SL/TP are unaffected and we simply
  // report no trailing.
  let trailingActivePrice = null;
  if (trailingPct && trailingPct > 0) {
    try {
      const trailingDistance = roundToStep(realEntry * (trailingPct / 100), info.tickSize);
      if (trailingDistance > 0) {
        const activePrice = roundToStep(
          direction === 'bull' ? realEntry + trailingDistance : realEntry - trailingDistance,
          info.tickSize
        );
        await updateTradingStop(symbol, { trailingStop: trailingDistance, activePrice });
        trailingSet = trailingDistance;
        trailingActivePrice = activePrice;
        console.log(`[bybit] trailing stop set for ${symbol}: $${trailingDistance} (${trailingPct}%), arms at $${activePrice} (entry $${realEntry})`);
      }
    } catch (e) {
      console.log(`[bybit] could not set trailing stop for ${symbol} — no trailing on this trade:`, e.message);
    }
  }

  return { placed: true, orderId: result.orderId, symbol, side, qty: roundedQty, entry: realEntry, tp: finalTp, sl: finalSl, trailing: trailingSet, trailingActivePrice };
}

module.exports = { AUTO_TRADE, placeOrder, getInstrumentInfo, bybitRequest, getOpenPosition, getClosedPnl, listOpenPositions };

/* ═══════════════════════════════════════
   TRADE LOG — ported from index-v15.html
═══════════════════════════════════════ */
const stateMod = require('./state');
const { apiFetch, safeJson, BINANCE } = require('./binance');
const { getSignalAge } = require('./boundary');

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
    entryPrice: result2h ? result2h.closePrice : item.entryPrice,
    tpLevel: item.tpLevel,
    tpGain: item.tpGain,
    slLevel: item.slLevel,
    slRisk: item.slRisk,
    sizeQty: item.sizeQty || null,
    sizeNotional: item.sizeNotional || null,
    sizeLeverage: item.sizeLeverage || null,
    trailingPct: item.trailingPct,
    signalAge: age ? `${age.hours}h (${age.label})` : '—',
    confirmTime: result2h ? result2h.dateStr : '—',
    autoOutcome: entryStatus === 'confirmed' ? 'open' : 'n/a',
    outcome: entryStatus === 'confirmed' ? 'pending' : 'n/a',
    notes: ''
  };
  stateMod.tradeLog.unshift(entry);
  stateMod.saveTradeLog();
  return entry;
}

async function checkTradeOutcome(trade) {
  if (!trade.tpLevel && !trade.slLevel) return;
  if (trade.autoOutcome && trade.autoOutcome !== 'open') return;

  try {
    const since = trade.loggedAt || Date.now() - (24 * 60 * 60 * 1000);
    const r = await apiFetch(`${BINANCE}/fapi/v1/klines?symbol=${trade.symbol}&interval=30m&limit=50`);
    const raw = await safeJson(r);
    if (!Array.isArray(raw)) return;

    const candles = raw.filter(k => k[0] >= since).map(k => ({ high: parseFloat(k[2]), low: parseFloat(k[3]) }));
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
    stateMod.saveTradeLog();
  } catch (e) {
    console.log('[tradelog] auto outcome check error:', e.message);
  }
}

async function runAutoOutcomeChecks() {
  const pending = stateMod.tradeLog.filter(t =>
    (!t.autoOutcome || t.autoOutcome === 'open') &&
    t.loggedAt && (Date.now() - t.loggedAt) >= (2 * 60 * 60 * 1000)
  );
  for (const trade of pending) {
    await checkTradeOutcome(trade);
    await new Promise(r => setTimeout(r, 200));
  }
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
  const headers = ['Date', 'Status', 'Symbol', 'Direction', 'Signal', 'Entry Price', 'TP Level', 'TP %', 'SL Level', 'SL %', 'Size (qty)', 'Size (notional $)', 'Leverage (x)', 'Trailing %', 'Signal Age', 'Confirm Time', 'Outcome', 'Notes'];
  const rows = tradeLog.map(t => [
    t.date, t.entryStatus || 'confirmed', t.symbol, t.direction === 'bull' ? 'LONG' : 'SHORT',
    t.signal1d, t.entryPrice, t.tpLevel || '', t.tpGain || '',
    t.slLevel || '', t.slRisk || '', t.sizeQty || '', t.sizeNotional ? t.sizeNotional.toFixed(2) : '',
    t.sizeLeverage ? t.sizeLeverage.toFixed(1) : '',
    t.trailingPct || '', t.signalAge, t.confirmTime, t.outcome, `"${(t.notes || '').replace(/"/g, '""')}"`
  ]);
  return [headers, ...rows].map(r => r.join(',')).join('\n');
}

module.exports = {
  fmt, logTrade, checkTradeOutcome, runAutoOutcomeChecks, setOutcome, saveNote, clearLog, exportCsv
};

// dotenv is only for local testing (loading .env). On Render, env vars are
// set in the dashboard directly, so this is optional there — guarded so a
// missing dependency never crashes boot.
try {
  require('dotenv').config({ path: require('path').join(__dirname, '.env') });
} catch (_) {}

const express = require('express');
const cors = require('cors');
const path = require('path');

const stateMod = require('./lib/state');
const { startScan, run2HConfirmation } = require('./lib/scan');
const { runAutoOutcomeChecks } = require('./lib/tradelog');
const tradelog = require('./lib/tradelog');
const { flushTgQueue } = require('./lib/telegram');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const SCAN_INTERVAL_MS = parseInt(process.env.SCAN_INTERVAL_MS || '1800000', 10); // 30 min — matches the 30min confirmation candle, so a fresh 1D signal doesn't sit unseen for up to an hour before it's even on the watchlist
const CONFIRM_INTERVAL_MS = parseInt(process.env.CONFIRM_INTERVAL_MS || '300000', 10); // 5 min

/* ═══════════════════════════════════════
   API
═══════════════════════════════════════ */

// Full dashboard state in one call: watchlist + confirm results + recent
// trade log + bot status. The frontend polls this.
app.get('/api/state', (req, res) => {
  const bannedUntil = stateMod.state.bannedUntil;
  const bannedMsLeft = bannedUntil ? Math.max(0, bannedUntil - Date.now()) : 0;
  res.json({
    status: bannedMsLeft > 0 ? 'BANNED' : stateMod.state.status,
    bannedMsLeft,
    lastScan: stateMod.state.lastScan,
    nextScanIn: stateMod.state.lastScan ? Math.max(0, SCAN_INTERVAL_MS - (Date.now() - stateMod.state.lastScan)) : null,
    engulfResults: stateMod.state.engulfResults || [],
    auxResults: stateMod.state.auxResults || [],
    watchlist: stateMod.state.watchlist || [],
    confirmResults: stateMod.state.confirmResults || [],
    tradeLog: (stateMod.tradeLog || []).slice(0, 100)
  });
});

app.get('/api/trade-log', (req, res) => {
  res.json(stateMod.tradeLog || []);
});

app.get('/api/trade-log/export', (req, res) => {
  const csv = tradelog.exportCsv();
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="orchem-trade-log.csv"');
  res.send(csv);
});

app.post('/api/trade-log/:id/outcome', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { outcome } = req.body || {};
  if (!['win', 'loss', 'skip'].includes(outcome)) return res.status(400).json({ error: 'invalid outcome' });
  const trade = tradelog.setOutcome(id, outcome);
  if (!trade) return res.status(404).json({ error: 'not found' });
  res.json(trade);
});

app.post('/api/trade-log/:id/notes', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { notes } = req.body || {};
  const trade = tradelog.saveNote(id, notes || '');
  if (!trade) return res.status(404).json({ error: 'not found' });
  res.json(trade);
});

// Manual trigger — useful for testing after deploy, or if you want to
// force a rescan without waiting for the next timer tick.
app.post('/api/scan', async (req, res) => {
  res.json({ started: true });
  startScan().catch(e => console.log('[scan] manual trigger error:', e.message));
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

/* ═══════════════════════════════════════
   BOOT
═══════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`Orchem Bot server listening on port ${PORT}`);
  console.log(`Scan interval: ${SCAN_INTERVAL_MS / 60000}min · Confirm interval: ${CONFIRM_INTERVAL_MS / 60000}min`);

  // Kick off an immediate scan on boot, then keep rescanning on the
  // interval — this replaces the manual "SCAN MARKET" button + AUTO-SCAN
  // toggle from the browser version. There's no concept of "off" here:
  // an always-on bot that isn't scanning defeats the point of moving it
  // to a server.
  startScan().catch(e => console.log('[scan] boot scan error:', e.message));
  setInterval(() => {
    startScan().catch(e => console.log('[scan] scheduled scan error:', e.message));
  }, SCAN_INTERVAL_MS);

  // Confirmation loop runs independently and more often than the scan —
  // the whole point is to notice a 30min candle closing as soon as
  // possible, not wait for the next full rescan.
  setInterval(() => {
    run2HConfirmation().catch(e => console.log('[confirm] error:', e.message));
  }, CONFIRM_INTERVAL_MS);

  // Check pending trade outcomes — every 10 min, not once an hour. A
  // Bybit-executed trade (SL, trailing stop, or TP hitting) can close in
  // minutes, and checking its real outcome is a cheap, targeted API call
  // (only for symbols still open), so there's no reason to wait an hour
  // to find out. The candle-replay fallback still only runs after its
  // original 2h grace period either way.
  setInterval(() => {
    runAutoOutcomeChecks().catch(e => console.log('[tradelog] outcome check error:', e.message));
  }, 10 * 60 * 1000);

  // Retry any Telegram alerts that failed on their first attempt — without
  // this, a single transient failure (network blip, Telegram rate-limit)
  // leaves the alert queued forever and silently never delivered, since
  // nothing else was pulling from that queue.
  setInterval(() => {
    flushTgQueue().catch(e => console.log('[telegram] queue flush error:', e.message));
  }, 2 * 60 * 1000);
});

process.on('unhandledRejection', (e) => console.log('[unhandled]', e));

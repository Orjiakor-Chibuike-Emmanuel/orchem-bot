// dotenv is only for local testing (loading .env). On Render, env vars are
// set in the dashboard directly, so this is optional there — guarded so a
// missing dependency never crashes boot.
try {
  require('dotenv').config({ path: require('path').join(__dirname, '.env') });
} catch (_) {}

const crypto = require('crypto');
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
const CONFIRM_INTERVAL_MS = parseInt(process.env.CONFIRM_INTERVAL_MS || '300000', 10); // 5 min — now only a safety-net fallback; the real checks are aligned to candle closes below

// 30-min candles close exactly on :00 and :30 (UTC, same boundaries in any
// timezone with a whole/half-hour offset, Lagos included). Checking on a
// timer that merely started whenever the server booted meant an alert could
// land up to a full interval after the candle actually closed. These fire
// right at each close instead.
const HALF_HOUR_MS = 30 * 60 * 1000;
// Offsets after the close at which to check. The first is just a few
// seconds after close; the later ones are retries in case the exchange hadn't
// finalised the candle yet (a just-closed candle can briefly still look like
// the forming one, which the confirmation logic deliberately ignores).
const CONFIRM_OFFSETS_MS = [5000, 20000, 45000, 90000];
// The full 1D scan runs a minute after each close, so it never competes with
// the confirmation checks above for the first seconds, which matter most.
const SCAN_OFFSET_MS = 60000;

function msUntilNextBoundary(offsetMs = 0) {
  const now = Date.now();
  let t = Math.floor(now / HALF_HOUR_MS) * HALF_HOUR_MS + offsetMs;
  if (t <= now) t += HALF_HOUR_MS;
  return t - now;
}

// Calls fn at each half-hour close + each offset. Recomputes the next
// boundary from the real clock every time, so timer drift never accumulates.
function onEveryCandleClose(offsetsMs, fn) {
  const arm = () => {
    // +1s so a timer that fires a hair early can't re-arm for the same boundary.
    const next = Math.ceil((Date.now() + 1000) / HALF_HOUR_MS) * HALF_HOUR_MS;
    setTimeout(() => {
      offsetsMs.forEach(o => setTimeout(fn, o));
      arm();
    }, next - Date.now());
  };
  arm();
}

// Only one confirmation pass at a time: the aligned bursts, the fallback
// interval and the tail end of a scan can otherwise overlap.
let confirming = false;
async function guardedConfirm() {
  if (confirming) return;
  confirming = true;
  try {
    await run2HConfirmation();
  } catch (e) {
    console.log('[confirm] error:', e.message);
  } finally {
    confirming = false;
  }
}

/* ═══════════════════════════════════════
   ADMIN ACCESS
   The dashboard link gets shared (e.g. with the Telegram group), so
   reading is open to anyone — watchlist, logbook, win rate, CSV — but
   anything that CHANGES something or sends something (marking WIN/LOSS,
   editing notes, forcing a scan, the Telegram test) requires ADMIN_KEY.
   If ADMIN_KEY isn't set on the server those actions are disabled
   entirely rather than left open.
═══════════════════════════════════════ */
const ADMIN_KEY = process.env.ADMIN_KEY || '';

function adminKeyMatches(given) {
  if (!ADMIN_KEY || !given) return false;
  // Compare fixed-length digests so the check is constant-time.
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(ADMIN_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

// Key goes in the x-admin-key header. `allowQuery` additionally accepts
// ?key=... (only used for the Telegram test, so it can be opened straight
// from a browser tab).
function requireAdmin(allowQuery = false) {
  return (req, res, next) => {
    if (!ADMIN_KEY) {
      return res.status(503).json({ error: 'ADMIN_KEY is not set on the server, so admin actions are disabled' });
    }
    const given = req.get('x-admin-key') || (allowQuery ? req.query.key : '');
    if (!adminKeyMatches(given)) return res.status(401).json({ error: 'admin key required' });
    next();
  };
}

/* ═══════════════════════════════════════
   API
═══════════════════════════════════════ */

// Lets the dashboard check whether a stored key is valid.
app.get('/api/admin-check', requireAdmin(), (req, res) => res.json({ admin: true }));

// Full dashboard state in one call: watchlist + confirm results + recent
// trade log + bot status. The frontend polls this.
app.get('/api/state', (req, res) => {
  const bannedUntil = stateMod.state.bannedUntil;
  const bannedMsLeft = bannedUntil ? Math.max(0, bannedUntil - Date.now()) : 0;
  res.json({
    status: bannedMsLeft > 0 ? 'BANNED' : stateMod.state.status,
    bannedMsLeft,
    lastScan: stateMod.state.lastScan,
    nextScanIn: msUntilNextBoundary(SCAN_OFFSET_MS),
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

app.post('/api/trade-log/:id/outcome', requireAdmin(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { outcome } = req.body || {};
  if (!['win', 'loss', 'skip'].includes(outcome)) return res.status(400).json({ error: 'invalid outcome' });
  const trade = tradelog.setOutcome(id, outcome);
  if (!trade) return res.status(404).json({ error: 'not found' });
  res.json(trade);
});

app.post('/api/trade-log/:id/notes', requireAdmin(), (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { notes } = req.body || {};
  const trade = tradelog.saveNote(id, notes || '');
  if (!trade) return res.status(404).json({ error: 'not found' });
  res.json(trade);
});

// Manual trigger — useful for testing after deploy, or if you want to
// force a rescan without waiting for the next timer tick.
app.post('/api/scan', requireAdmin(), async (req, res) => {
  res.json({ started: true });
  startScan().catch(e => console.log('[scan] manual trigger error:', e.message));
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: process.uptime() });
});

// Self-diagnostic for "no Telegram notifications" — actually sends a test
// message and reports back exactly what happened (missing token/recipient
// env vars, a Telegram API error, a network error), instead of a log line
// you can't see. Open this URL directly in a browser or curl it.
app.get('/api/test-telegram', requireAdmin(true), async (req, res) => {
  const result = await require('./lib/telegram').testSend();
  res.json(result);
});

/* ═══════════════════════════════════════
   BOOT
═══════════════════════════════════════ */
app.listen(PORT, () => {
  console.log(`Orchem Bot server listening on port ${PORT}`);
  console.log(`Scan: every 30min candle close +${SCAN_OFFSET_MS / 1000}s · Confirm: every 30min candle close at +${CONFIRM_OFFSETS_MS.map(o => o / 1000).join('s/+')}s, plus a ${CONFIRM_INTERVAL_MS / 60000}min fallback`);

  // Kick off an immediate scan on boot, then keep rescanning on the
  // interval — this replaces the manual "SCAN MARKET" button + AUTO-SCAN
  // toggle from the browser version. There's no concept of "off" here:
  // an always-on bot that isn't scanning defeats the point of moving it
  // to a server.
  startScan().catch(e => console.log('[scan] boot scan error:', e.message));
  onEveryCandleClose([SCAN_OFFSET_MS], () => {
    startScan().catch(e => console.log('[scan] scheduled scan error:', e.message));
  });

  // Confirmation loop runs independently and more often than the scan —
  // the whole point is to notice a 30min candle closing as soon as
  // possible, not wait for the next full rescan.
  onEveryCandleClose(CONFIRM_OFFSETS_MS, guardedConfirm);
  // Safety net in case an aligned check is ever missed (server was busy,
  // exchange hiccup) — the aligned checks above are the ones that matter.
  setInterval(guardedConfirm, CONFIRM_INTERVAL_MS);

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

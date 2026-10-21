/* ═══════════════════════════════════════
   TELEGRAM
   Server-side, so the CORS-preflight problem
   that forced the GET workaround in the
   browser version doesn't exist here — a
   server calling another server's API has no
   CORS restriction at all. Using a normal
   POST with a JSON body (Telegram's documented
   way), which is also safer: a GET put the
   bot token AND message text in the URL
   query string, which gets logged by any
   proxy or access log along the way.
═══════════════════════════════════════ */
const stateMod = require('./state');

const TG_TOKEN = process.env.TG_TOKEN || '';
const TG_RECIPIENTS = (process.env.TG_RECIPIENTS || '').split(',').map(s => s.trim()).filter(Boolean);
const MAX_TG_RETRY_ATTEMPTS = 12;

if (!TG_TOKEN) {
  console.log('[telegram] WARNING: TG_TOKEN is not set — alerts will not be sent.');
}
if (!TG_RECIPIENTS.length) {
  console.log('[telegram] WARNING: TG_RECIPIENTS is not set — alerts will not be sent.');
}

// Messages are sent in HTML mode (for the <b> tags), so any literal <, > or &
// in dynamic text must be escaped or Telegram rejects the WHOLE message with
// "can't parse entities". Every bearish alert contains a literal "<" in its
// confirmation line ("Bear Breakout < $X"), which is why short alerts were
// silently failing while long ones went through.
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function postTelegram(chatId, text, parseMode) {
  const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
  const payload = { chat_id: chatId, text };
  if (parseMode) payload.parse_mode = parseMode;
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000)
  });
}

async function sendTelegramOne(chatId, message) {
  if (!TG_TOKEN) return false;
  try {
    const res = await postTelegram(chatId, message, 'HTML');
    if (res.ok) return true;
    const body = await res.text().catch(() => '');
    console.log('[telegram] send FAILED for', chatId, res.status, body);
    // Safety net: if Telegram rejected the formatting itself, resend as plain
    // text (tags stripped, entities unescaped) instead of losing the alert —
    // an unformatted alert beats no alert.
    if (res.status === 400 && /parse entities/i.test(body)) {
      const plain = message.replace(/<\/?[a-z][^>]*>/gi, '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
      const res2 = await postTelegram(chatId, plain, null);
      if (res2.ok) {
        console.log('[telegram] resent as plain text for', chatId);
        return true;
      }
    }
    return false;
  } catch (e) {
    console.log('[telegram] network error for', chatId, ':', e.message);
    return false;
  }
}

async function sendTelegram(message) {
  for (const chatId of TG_RECIPIENTS) {
    const ok = await sendTelegramOne(chatId, message);
    if (!ok) {
      stateMod.state.tgQueue.push({ chatId, message, attempts: 1, queuedAt: Date.now() });
      stateMod.save();
      console.log(`[telegram] queued failed alert for ${chatId}`);
    }
  }
}

async function flushTgQueue() {
  const queue = stateMod.state.tgQueue;
  if (!queue.length) return;
  const stillFailed = [];
  for (const item of queue) {
    const ok = await sendTelegramOne(item.chatId, item.message);
    if (!ok) {
      item.attempts++;
      if (item.attempts <= MAX_TG_RETRY_ATTEMPTS) {
        stillFailed.push(item);
      } else {
        console.log(`[telegram] giving up on a queued alert to ${item.chatId} after ${MAX_TG_RETRY_ATTEMPTS} tries`);
      }
    }
    await new Promise(r => setTimeout(r, 200));
  }
  stateMod.state.tgQueue = stillFailed;
  stateMod.save();
}

// Diagnostic — actually tries to send a real message and reports exactly
// what happened for each recipient, instead of just a log line nobody can
// see. Hit /api/test-telegram to self-diagnose: missing token, missing
// recipients, a bad chat ID, or "Forbidden" (the bot's never been started
// by that chat — Telegram won't deliver to a chat that hasn't messaged
// the bot first) all come back as a specific, readable reason here.
async function testSend() {
  if (!TG_TOKEN) return { ok: false, reason: 'TG_TOKEN is not set on this deploy' };
  if (!TG_RECIPIENTS.length) return { ok: false, reason: 'TG_RECIPIENTS is not set on this deploy' };

  const results = [];
  for (const chatId of TG_RECIPIENTS) {
    try {
      const url = `https://api.telegram.org/bot${TG_TOKEN}/sendMessage`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: '✅ Orchem Bot test message — if this reached you, Telegram delivery to this chat is working.'
        }),
        signal: AbortSignal.timeout(10000)
      });
      const body = await res.json().catch(() => ({}));
      results.push({
        chatId,
        ok: res.ok,
        httpStatus: res.status,
        telegramError: body.description || null
      });
    } catch (e) {
      results.push({ chatId, ok: false, networkError: e.message });
    }
  }
  return { ok: results.every(r => r.ok), tokenConfigured: true, recipients: TG_RECIPIENTS, results };
}

module.exports = { escHtml, sendTelegram, sendTelegramOne, flushTgQueue, testSend, TG_RECIPIENTS };

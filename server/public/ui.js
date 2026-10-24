/* ═══════════════════════════════════════
   ORCHEM — helpers shared by both pages
   Formatting, HTML escaping, and the top bar
   (status pill + tab badges), which both the
   watchlist page and the confirmed page show.
═══════════════════════════════════════ */

const POLL_MS = 15000;

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ESC_MAP[c]);
}

function fmt(p) {
  if (p == null || p === 0) return '—';
  return p >= 1
    ? p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 4 })
    : p.toPrecision(4);
}

function timeAgo(ts) {
  if (!ts) return '—';
  const mins = Math.round((Date.now() - ts) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${(mins / 60).toFixed(1)}h ago`;
}

function msToClock(ms) {
  if (ms == null) return '—';
  const totalSec = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(totalSec / 60)}:${String(totalSec % 60).padStart(2, '0')}`;
}

function shortDateTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('en-GB', {
    day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
  });
}

// "Confirmed" = confirmed and not since invalidated.
function confirmedItems(list) {
  return (list || []).filter(item => item.confirmed && !item.invalidated);
}

// The status pill and the tab badges. `state` is one of:
// watching | scanning | banned | confirmed | offline — pages also use it
// (via body[data-state]) to colour the break line under the hero.
function renderChrome(data, list) {
  const dot = document.getElementById('led-status');
  const text = document.getElementById('status-text');
  const confirmedCount = confirmedItems(list).length;

  let state = 'watching';
  if (!data) {
    state = 'offline';
    dot.className = 'dot';
    text.textContent = 'Offline';
  } else if (data.status === 'BANNED') {
    state = 'banned';
    dot.className = 'dot on-red';
    text.textContent = `Rate-limited · ${Math.ceil((data.bannedMsLeft || 0) / 60000)}m`;
  } else if (data.status === 'SCANNING') {
    state = 'scanning';
    dot.className = 'dot on-blue';
    text.textContent = 'Scanning';
  } else {
    dot.className = 'dot on-green';
    text.textContent = 'Watching';
  }
  if (state !== 'offline' && state !== 'banned' && confirmedCount > 0) state = 'confirmed';
  document.body.dataset.state = state;

  const badge = document.getElementById('confirmed-badge');
  if (badge) {
    badge.textContent = confirmedCount;
    badge.classList.toggle('is-live', confirmedCount > 0);
  }
  return { state, confirmedCount };
}

// What the server already has: the live confirmed/invalidated/held-back flags
// live on confirmResults; the raw watchlist is only the fallback.
function pickList(data) {
  return data.confirmResults && data.confirmResults.length ? data.confirmResults : data.watchlist || [];
}

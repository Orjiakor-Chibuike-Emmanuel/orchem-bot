/* ═══════════════════════════════════════
   ORCHEM PANEL — frontend
   Polls /api/state and renders the watchlist
   as instrument channels + the trade logbook.
   All trading logic lives server-side; this
   file only displays what the server computed.
═══════════════════════════════════════ */

const POLL_MS = 15000;
let prevConfirmed = new Set(); // to detect newly-confirmed channels for the "snap" animation

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
  const hrs = (mins / 60).toFixed(1);
  return `${hrs}h ago`;
}

function msToClock(ms) {
  if (ms == null) return '—';
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ── TRACE GAUGE ──
   Visualizes the actual mechanic of the bot: a price trace approaching
   and breaking a boundary wall. For an unconfirmed pair the wall is the
   1D signal's own high/low; once confirmed, it's the 30min level that
   actually broke. */
function renderTrace(item) {
  const isBull = item.direction === 'bull';
  const wall = item.confirmed && item.signal2h ? item.signal2h.targetLevel
    : (isBull ? item.signalHigh : item.signalLow);
  const price = item.currentPrice ?? item.entryPrice;

  if (wall == null || price == null) {
    return `<div class="trace"></div>`;
  }

  const spread = Math.abs(wall - price) || wall * 0.02 || 1;
  const pad = spread * 1.4;
  const low = Math.min(wall, price) - pad;
  const high = Math.max(wall, price) + pad;
  const range = (high - low) || 1;

  const pct = v => Math.max(1, Math.min(99, ((v - low) / range) * 100));
  const wallPct = pct(wall);
  const dotPct = pct(price);

  let fillLeft, fillWidth;
  if (isBull) { fillLeft = 0; fillWidth = wallPct; }
  else { fillLeft = wallPct; fillWidth = 100 - wallPct; }

  const dotClass = item.invalidated ? 'invalidated' : item.exhausted ? 'exhausted' : item.confirmed ? 'confirmed' : '';
  const wallClass = isBull ? 'long' : 'short';

  return `<div class="trace">
    <div class="trace-fill" style="left:${fillLeft}%;width:${fillWidth}%"></div>
    <div class="trace-wall ${wallClass}" style="left:${wallPct}%"></div>
    <div class="trace-dot ${dotClass}" style="left:${dotPct}%"></div>
  </div>`;
}

function stateTag(item) {
  if (item.invalidated) return `<span class="state-tag invalidated">INVALIDATED</span>`;
  if (item.exhausted) return `<span class="state-tag exhausted">HELD BACK</span>`;
  if (item.confirmed) return `<span class="state-tag confirmed">CONFIRMED</span>`;
  return `<span class="state-tag">awaiting confirmation</span>`;
}

function renderChannel(item, idx) {
  const isBull = item.direction === 'bull';
  const cls = item.invalidated ? 'invalidated' : item.exhausted ? 'exhausted' : item.confirmed ? 'confirmed' : '';
  const isNew = item.confirmed && !prevConfirmed.has(item.symbol);
  const price = item.currentPrice ?? item.entryPrice;

  // Confirmed items never reach here (renderChannels filters them to the
  // dedicated Confirmed page) — this card only ever shows a pending or
  // invalidated/exhausted pair, waiting on its 1D label.
  const detail = `<span>${item.signal1d || ''}</span>`;

  return `<div class="channel ${cls} ${isNew ? 'fresh-confirm' : ''}">
    <span class="channel-id">CH${String(idx + 1).padStart(2, '0')}</span>
    <div class="channel-main">
      <div class="channel-top">
        <span class="pair-name">${item.symbol.replace('USDT', '')}<span class="pair-quote">/USDT</span></span>
        <span class="dir-tag ${isBull ? 'long' : 'short'}">${isBull ? 'LONG' : 'SHORT'}</span>
        ${stateTag(item)}
      </div>
      ${renderTrace(item)}
      <div class="channel-detail">${detail}</div>
    </div>
    <div class="channel-right">
      <span class="price-readout">$${fmt(price)}</span>
      <span class="age-readout">${timeAgo(item.detectedAt)}</span>
    </div>
  </div>`;
}

// Confirmed signals get their own page (confirmed.html/confirmed.js) —
// once a pair confirms, it comes OFF this list entirely rather than
// staying mixed in with everything still waiting, so the watchlist here
// is always just "what's still in play", however many have confirmed
// today.
function renderChannels(watchlist) {
  const el = document.getElementById('channels');
  const pending = (watchlist || []).filter(item => !item.confirmed);
  document.getElementById('watchlist-count').textContent = `${pending.length} channel${pending.length === 1 ? '' : 's'}`;

  if (!pending.length) {
    el.innerHTML = `<div class="empty-state">No pairs on watch right now — the next scan cycle will populate this.</div>`;
    return;
  }

  el.innerHTML = pending.map((item, i) => renderChannel(item, i)).join('');
  prevConfirmed = new Set((watchlist || []).filter(w => w.confirmed).map(w => w.symbol));
}

function renderConfirmedBadge(watchlist) {
  const count = (watchlist || []).filter(item => item.confirmed && !item.invalidated).length;
  const badge = document.getElementById('confirmed-badge');
  const link = document.getElementById('confirmed-link');
  if (!badge || !link) return;
  badge.textContent = count;
  link.classList.toggle('btn-confirmed-active', count > 0);
}

function renderStats(tradeLog) {
  const confirmed = tradeLog.filter(t => t.entryStatus === 'confirmed');
  // One effective result per trade: a manual mark wins over any automatic
  // result, so a trade marked by hand is never counted twice (or against
  // itself) when the auto-check disagrees.
  const effective = t => (t.outcome && t.outcome !== 'pending' && t.outcome !== 'n/a')
    ? t.outcome
    : (t.autoOutcome === 'win' || t.autoOutcome === 'loss') ? t.autoOutcome : 'pending';
  const wins = confirmed.filter(t => effective(t) === 'win').length;
  const losses = confirmed.filter(t => effective(t) === 'loss').length;
  const pending = confirmed.filter(t => effective(t) === 'pending').length;
  const invalidated = tradeLog.filter(t => t.entryStatus === 'invalidated').length;
  const exhausted = tradeLog.filter(t => t.entryStatus === 'exhausted').length;
  const winRate = (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : null;

  const el = document.getElementById('stats-row');
  el.innerHTML = `
    <div class="stat"><span class="stat-value">${confirmed.length}</span><span class="stat-label">TRADES TAKEN</span></div>
    <div class="stat"><span class="stat-value">${winRate != null ? winRate + '%' : '—'}</span><span class="stat-label">WIN RATE</span></div>
    <div class="stat"><span class="stat-value">${pending}</span><span class="stat-label">PENDING</span></div>
    <div class="stat"><span class="stat-value">${invalidated}</span><span class="stat-label">INVALIDATED</span></div>
    <div class="stat"><span class="stat-value">${exhausted}</span><span class="stat-label">HELD BACK</span></div>
  `;
}

async function setOutcome(id, outcome) {
  await fetch(`/api/trade-log/${id}/outcome`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ outcome })
  });
  poll();
}

function renderLog(tradeLog) {
  document.getElementById('log-count').textContent = `${tradeLog.length} entries`;
  renderStats(tradeLog);

  const el = document.getElementById('log-rows');
  if (!tradeLog.length) {
    el.innerHTML = `<div class="empty-state">No trades logged yet.</div>`;
    return;
  }

  el.innerHTML = tradeLog.slice(0, 40).map(t => {
    const isBull = t.direction === 'bull';
    const outcome = t.outcome === 'pending' ? (t.autoOutcome === 'win' ? 'win' : t.autoOutcome === 'loss' ? 'loss' : null) : t.outcome;
    const showButtons = t.entryStatus === 'confirmed';
    // 'bybit' = the real closed result read back from the exchange;
    // 'candle-estimate' = a guess from replayed candles (only used when
    // this trade never actually executed on Bybit) — worth knowing which
    // one you're looking at before trusting the win/loss count.
    const sourceTag = t.outcomeSource === 'bybit' ? ' <span class="outcome-src real">✓bybit</span>'
      : t.outcomeSource === 'candle-estimate' ? ' <span class="outcome-src est">est.</span>' : '';
    const pnlNote = t.actualPnl != null ? ` · ${t.actualPnl >= 0 ? '+' : ''}$${t.actualPnl.toFixed(2)}` : '';
    // Show both prices only when they actually differ (a real Bybit fill
    // away from the confirmation-candle estimate) — otherwise one number
    // is enough and a second identical one is just noise.
    const fillNote = (t.entryPrice && t.confirmationPrice && t.entryPrice !== t.confirmationPrice)
      ? ` · conf $${fmt(t.confirmationPrice)} → fill $${fmt(t.entryPrice)}`
      : t.confirmationPrice ? ` · $${fmt(t.confirmationPrice)}` : '';
    return `<div class="log-row">
      <span class="log-time">${t.date}</span>
      <span class="log-sym">${t.symbol.replace('USDT', '')}</span>
      <span class="log-dir ${isBull ? 'long' : 'short'}">${isBull ? 'L' : 'S'}</span>
      <span class="log-status ${t.entryStatus}">${t.entryStatus.toUpperCase()}</span>
      <span class="log-note">${t.signal1d || ''}${t.notes ? ' · ' + t.notes : ''}${fillNote}${pnlNote}</span>
      ${showButtons ? `<span class="log-outcome">
        <button class="out-btn ${outcome === 'win' ? 'active win' : ''}" onclick="setOutcome(${t.id},'win')">WIN</button>
        <button class="out-btn ${outcome === 'loss' ? 'active loss' : ''}" onclick="setOutcome(${t.id},'loss')">LOSS</button>${sourceTag}
      </span>` : '<span></span>'}
    </div>`;
  }).join('');
}

async function poll() {
  try {
    const res = await fetch('/api/state');
    const data = await res.json();

    const dot = document.getElementById('led-status');
    const text = document.getElementById('status-text');
    if (data.status === 'BANNED') {
      dot.className = 'led on-red';
      const mins = Math.ceil((data.bannedMsLeft || 0) / 60000);
      text.textContent = `BYBIT RATE-LIMITED — ${mins}m`;
    } else if (data.status === 'SCANNING') {
      dot.className = 'led on-blue';
      text.textContent = 'SCANNING';
    } else {
      dot.className = 'led on-green';
      text.textContent = 'WATCHING';
    }

    document.getElementById('last-scan').textContent = data.lastScan ? timeAgo(data.lastScan) : '—';
    document.getElementById('next-scan').textContent = msToClock(data.nextScanIn);

    // Prefer confirmResults — it carries the live confirmed/invalidated/
    // exhausted flags; watchlist alone is only the raw pre-confirmation list.
    const list = data.confirmResults && data.confirmResults.length ? data.confirmResults : data.watchlist || [];
    renderConfirmedBadge(list);
    renderChannels(list);
    renderLog(data.tradeLog || []);
  } catch (e) {
    const text = document.getElementById('status-text');
    text.textContent = 'UNREACHABLE';
    console.log('poll error', e);
  }
}

document.getElementById('scan-btn').addEventListener('click', async () => {
  await fetch('/api/scan', { method: 'POST' });
  poll();
});

poll();
setInterval(poll, POLL_MS);

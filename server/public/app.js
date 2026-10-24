/* ═══════════════════════════════════════
   ORCHEM — watchlist page
   Polls /api/state and draws the hero sentence, the watchlist tiles,
   the dropped list and the logbook. All trading logic lives on the
   server; this file only displays what the server computed.
   (Shared helpers — esc, fmt, timeAgo, renderChrome — are in ui.js.)
═══════════════════════════════════════ */

// Admin mode: the dashboard is viewable by anyone with the link, but marking
// win/loss and forcing a scan need the admin key (stored only in this
// browser). Without it those controls are hidden.
let adminKey = '';
try { adminKey = localStorage.getItem('orchemAdminKey') || ''; } catch (_) {}
let isAdmin = false;

function adminHeaders(extra) {
  return Object.assign({ 'x-admin-key': adminKey }, extra || {});
}

function updateAdminUi() {
  const scanBtn = document.getElementById('scan-btn');
  const adminBtn = document.getElementById('admin-btn');
  if (scanBtn) scanBtn.hidden = !isAdmin;
  if (adminBtn) {
    adminBtn.classList.toggle('is-on', isAdmin);
    adminBtn.setAttribute('aria-label', isAdmin ? 'Admin signed in — tap to sign out' : 'Admin sign-in');
    adminBtn.title = isAdmin ? 'Admin signed in — tap to sign out' : 'Admin';
  }
}

async function verifyAdmin() {
  isAdmin = false;
  if (adminKey) {
    try {
      const res = await fetch('/api/admin-check', { headers: adminHeaders() });
      isAdmin = res.ok;
      if (res.status === 401) {
        adminKey = '';
        try { localStorage.removeItem('orchemAdminKey'); } catch (_) {}
      }
    } catch (_) {}
  }
  updateAdminUi();
  poll();
}

async function toggleAdmin() {
  if (isAdmin) {
    adminKey = '';
    try { localStorage.removeItem('orchemAdminKey'); } catch (_) {}
    return verifyAdmin();
  }
  const entered = prompt('Admin key');
  if (!entered) return;
  adminKey = entered.trim();
  try { localStorage.setItem('orchemAdminKey', adminKey); } catch (_) {}
  await verifyAdmin();
  if (!isAdmin) alert('That key was not accepted.');
}

/* ── LEVEL GAUGE ──
   The tile's coloured edge is the line the price has to break. The dot
   shows where price sits against the daily signal level: further from the
   centre = further from the line (scaled to ±6%, pinned at the ends beyond
   that). A dot that has already crossed turns amber — the 30-minute close
   that confirms it hasn't happened yet. */
const GAUGE_SPAN = 0.06;

function renderGauge(item) {
  const isBull = item.direction === 'bull';
  const wall = isBull ? item.signalHigh : item.signalLow;
  const price = item.currentPrice ?? item.entryPrice;
  if (wall == null || price == null || wall === 0) {
    return `<div class="gauge" aria-hidden="true"><div class="gauge-wall"></div></div>`;
  }
  const delta = (price - wall) / wall;                      // + = price above the line
  const clamped = Math.max(-1, Math.min(1, delta / GAUGE_SPAN));
  const top = 50 - clamped * 44;                            // higher price = higher on screen
  const past = isBull ? price > wall : price < wall;
  const pct = Math.abs(delta * 100).toFixed(1);
  const label = past
    ? `Price is ${pct}% beyond the daily level — waiting for a 30-minute close`
    : `Price is ${pct}% ${isBull ? 'below' : 'above'} the daily level`;
  return `<div class="gauge" role="img" aria-label="${esc(label)}" title="${esc(label)}">
    <span class="gauge-arrow">${isBull ? '▲' : '▼'}</span>
    <div class="gauge-wall"></div>
    <div class="gauge-dot ${past ? 'past' : ''}" style="top:${top.toFixed(1)}%"></div>
  </div>`;
}

function renderTile(item) {
  const isBull = item.direction === 'bull';
  const price = item.currentPrice ?? item.entryPrice;
  const signal = (item.signal1d || '').replace(/^[▲▼]\s*/, '');
  return `<article class="tile ${isBull ? 'long' : 'short'}">
    <div class="tile-body">
      <span class="tile-dir ${isBull ? 'long' : 'short'}">${isBull ? '▲ Long' : '▼ Short'}</span>
      <div class="tile-sym ${item.symbol.replace('USDT', '').length > 6 ? 'is-long' : ''}">${esc(item.symbol.replace('USDT', ''))}</div>
      <div class="tile-signal">${esc(signal)}</div>
      <div class="tile-foot">
        <span class="tile-price">$${fmt(price)}</span>
        <span class="tile-age">${timeAgo(item.detectedAt).replace(' ago', '')}</span>
      </div>
    </div>
    ${renderGauge(item)}
  </article>`;
}

/* Why a pair was dropped. Newest log entry for the same pair and direction
   wins (it carries the reason the bot wrote); with no note, the only way a
   pair gets dropped without one is a 30-minute close on the wrong side. */
function dropReason(item, tradeLog) {
  if (item.invalidReason) return item.invalidReason;
  const row = (tradeLog || []).find(t =>
    t.symbol === item.symbol && t.direction === item.direction &&
    (t.entryStatus === 'invalidated' || t.entryStatus === 'exhausted') && t.notes);
  if (row) return row.notes;
  if (item.exhausted) return 'Held back: the move had already happened when it confirmed.';
  return 'A 30-minute candle closed back through the other side of the range, so the setup failed.';
}

function renderDropped(items, tradeLog) {
  const box = document.getElementById('dropped');
  const list = document.getElementById('dropped-list');
  box.hidden = items.length === 0;
  if (!items.length) { list.innerHTML = ''; return; }
  document.getElementById('dropped-summary').textContent = `Dropped · ${items.length}`;
  list.innerHTML = items.map(item => {
    const isBull = item.direction === 'bull';
    return `<div class="dropped-row">
      <div class="dropped-row-top">
        <span class="dropped-sym">${esc(item.symbol.replace('USDT', ''))}</span>
        <span class="pill ${isBull ? 'long' : 'short'}">${isBull ? '▲ Long' : '▼ Short'}</span>
        <span class="pill neutral">${item.exhausted ? 'Held back' : 'Invalidated'}</span>
      </div>
      <div class="dropped-reason">${esc(dropReason(item, tradeLog))}</div>
    </div>`;
  }).join('');
}

function renderWatchlist(list, tradeLog) {
  const waiting = (list || []).filter(i => !i.confirmed && !i.invalidated && !i.exhausted);
  const dropped = (list || []).filter(i => !i.confirmed && (i.invalidated || i.exhausted));
  document.getElementById('watchlist-count').textContent = `${waiting.length} pair${waiting.length === 1 ? '' : 's'}`;
  document.getElementById('watch-badge').textContent = waiting.length;

  const el = document.getElementById('channels');
  el.innerHTML = waiting.length
    ? waiting.map(renderTile).join('')
    : `<div class="empty">Nothing on watch right now. The next scan fills this in.</div>`;
  renderDropped(dropped, tradeLog);
  return waiting.length;
}

/* ── HERO: the bot's state in one sentence ── */
function renderHero(data, state, confirmedCount, waitingCount) {
  const title = document.getElementById('hero-title');
  const sub = document.getElementById('hero-sub');
  if (state === 'offline') {
    title.textContent = 'Can’t reach the bot.';
    sub.textContent = 'This page retries every 15 seconds. If it stays like this, check that the service is running on Render.';
  } else if (state === 'banned') {
    const mins = Math.ceil((data.bannedMsLeft || 0) / 60000);
    title.textContent = `Paused for ${mins} min.`;
    sub.textContent = 'Bybit’s rate limit is cooling down. The bot resumes by itself — nothing to do.';
  } else if (state === 'confirmed') {
    title.textContent = confirmedCount === 1 ? '1 entry confirmed.' : `${confirmedCount} entries confirmed.`;
    sub.innerHTML = `The Confirmed tab has entry, take profit and stop loss. ${waitingCount} more ${waitingCount === 1 ? 'pair is' : 'pairs are'} still waiting.`;
  } else if (state === 'scanning') {
    title.textContent = 'Scanning the market…';
    sub.textContent = 'Checking every pair’s daily candle for a breakout.';
  } else {
    title.textContent = waitingCount ? `Watching ${waitingCount} ${waitingCount === 1 ? 'pair' : 'pairs'}.` : 'Nothing on watch yet.';
    sub.textContent = waitingCount
      ? 'A pair moves to the Confirmed tab the moment a 30-minute candle closes through its line.'
      : 'The next scan looks for new daily breakouts.';
  }
}

/* ── LOGBOOK ── */
function effectiveOutcome(t) {
  // One effective result per trade: a manual mark wins over any automatic
  // result, so a trade marked by hand is never counted twice (or against
  // itself) when the auto-check disagrees.
  return (t.outcome && t.outcome !== 'pending' && t.outcome !== 'n/a')
    ? t.outcome
    : (t.autoOutcome === 'win' || t.autoOutcome === 'loss') ? t.autoOutcome : 'pending';
}

function renderStats(tradeLog) {
  const confirmed = tradeLog.filter(t => t.entryStatus === 'confirmed');
  const wins = confirmed.filter(t => effectiveOutcome(t) === 'win').length;
  const losses = confirmed.filter(t => effectiveOutcome(t) === 'loss').length;
  const pending = confirmed.filter(t => effectiveOutcome(t) === 'pending').length;
  const invalidated = tradeLog.filter(t => t.entryStatus === 'invalidated').length;
  const exhausted = tradeLog.filter(t => t.entryStatus === 'exhausted').length;
  const winRate = (wins + losses) > 0 ? Math.round((wins / (wins + losses)) * 100) : null;
  // Real money result, only from trades Bybit actually closed.
  const pnlTrades = confirmed.filter(t => t.actualPnl != null);
  const pnl = pnlTrades.reduce((sum, t) => sum + t.actualPnl, 0);

  document.getElementById('stats-row').innerHTML = `
    <div class="stat">
      <div class="stat-value win-rate">${winRate != null ? winRate + '%' : '—'}</div>
      <div class="stat-label">Win rate</div>
      <div class="stat-sub">${wins} won · ${losses} lost</div>
    </div>
    <div class="stat">
      <div class="stat-value">${confirmed.length}</div>
      <div class="stat-label">Trades taken</div>
      <div class="stat-sub">${pending} still open</div>
    </div>
    <div class="stat">
      <div class="stat-value ${pnlTrades.length ? (pnl >= 0 ? 'pos' : 'neg') : ''}">${pnlTrades.length ? (pnl >= 0 ? '+' : '−') + '$' + Math.abs(pnl).toFixed(2) : '—'}</div>
      <div class="stat-label">Closed P&amp;L</div>
      <div class="stat-sub">${pnlTrades.length ? `${pnlTrades.length} closed on Bybit` : 'none closed on Bybit yet'}</div>
    </div>
    <div class="stat">
      <div class="stat-value">${invalidated + exhausted}</div>
      <div class="stat-label">Skipped</div>
      <div class="stat-sub">${invalidated} invalidated · ${exhausted} held back</div>
    </div>`;
}

async function setOutcome(id, outcome) {
  if (!isAdmin) return;
  const res = await fetch(`/api/trade-log/${id}/outcome`, {
    method: 'POST', headers: adminHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ outcome })
  });
  if (res.status === 401) return verifyAdmin();
  poll();
}

const STATUS_WORD = { confirmed: 'Confirmed', invalidated: 'Invalidated', exhausted: 'Held back' };

function renderLog(tradeLog) {
  document.getElementById('log-count').textContent = `${tradeLog.length} ${tradeLog.length === 1 ? 'entry' : 'entries'}`;
  renderStats(tradeLog);

  const el = document.getElementById('log-rows');
  if (!tradeLog.length) {
    el.innerHTML = `<div class="empty">No trades logged yet. Each confirmed entry, and each pair the bot skips, is recorded here.</div>`;
    return;
  }

  el.innerHTML = tradeLog.slice(0, 40).map(t => {
    const isBull = t.direction === 'bull';
    const taken = t.entryStatus === 'confirmed';
    const outcome = effectiveOutcome(t);
    // 'bybit' = the real closed result read back from the exchange;
    // 'candle-estimate' = a guess from replayed candles (only used when this
    // trade never actually executed on Bybit) — worth knowing which one
    // you're looking at before trusting the win/loss count.
    const src = t.outcomeSource === 'bybit' ? '<span class="out-src real">✓ from Bybit</span>'
      : t.outcomeSource === 'candle-estimate' ? '<span class="out-src">estimate</span>' : '';

    // A skipped pair never filled, so only trades actually taken show a fill price.
    const price = (taken && t.entryPrice && t.confirmationPrice && t.entryPrice !== t.confirmationPrice)
      ? `Confirmed at <b>$${fmt(t.confirmationPrice)}</b>, filled at <b>$${fmt(t.entryPrice)}</b>`
      : t.confirmationPrice ? `Confirmed at <b>$${fmt(t.confirmationPrice)}</b>` : '';
    const pnl = t.actualPnl != null
      ? ` · <b>${t.actualPnl >= 0 ? '+' : '−'}$${Math.abs(t.actualPnl).toFixed(2)}</b>` : '';
    const note = [(t.signal1d || '').replace(/^[▲▼]\s*/, ''), t.notes].filter(Boolean).join(' — ');

    let outcomeBlock = '';
    if (taken && isAdmin) {
      outcomeBlock = `<div class="outcome">
        <button class="out-btn win ${outcome === 'win' ? 'active' : ''}" onclick="setOutcome(${t.id},'win')">Win</button>
        <button class="out-btn loss ${outcome === 'loss' ? 'active' : ''}" onclick="setOutcome(${t.id},'loss')">Loss</button>
        ${src}
      </div>`;
    } else if (taken) {
      outcomeBlock = `<div class="outcome">
        <span class="pill ${outcome === 'win' ? 'long' : outcome === 'loss' ? 'short' : 'neutral'}">${outcome === 'win' ? 'Won' : outcome === 'loss' ? 'Lost' : 'Open'}</span>
        ${src}
      </div>`;
    }

    return `<article class="log-row ${taken ? '' : 'is-skipped'}">
      <div class="log-top">
        <span class="log-sym">${esc(t.symbol.replace('USDT', ''))}</span>
        <span class="pill ${isBull ? 'long' : 'short'}">${isBull ? '▲ Long' : '▼ Short'}</span>
        <span class="pill ${taken ? 'flare' : 'neutral'}">${STATUS_WORD[t.entryStatus] || esc(t.entryStatus)}</span>
        <span class="log-time">${t.loggedAt ? shortDateTime(t.loggedAt) : esc(t.date)}</span>
      </div>
      ${note ? `<div class="log-note">${esc(note)}</div>` : ''}
      ${(price || pnl) ? `<div class="log-nums">${price}${pnl}</div>` : ''}
      ${outcomeBlock}
    </article>`;
  }).join('');
}

/* ── POLL ── */
async function poll() {
  try {
    const [res, positions] = await Promise.all([fetch('/api/state'), fetchPositions()]);
    const data = await res.json();
    const list = pickList(data);
    const tradeLog = data.tradeLog || [];

    const sum = openPnlSummary(positions);
    document.getElementById('open-pnl-wrap').hidden = !sum;
    if (sum) {
      const v = document.getElementById('open-pnl');
      v.textContent = money(sum.total);
      v.style.color = sum.total >= 0 ? 'var(--long)' : 'var(--short)';
    }

    const { state, confirmedCount } = renderChrome(data, list);
    const waitingCount = renderWatchlist(list, tradeLog);
    renderHero(data, state, confirmedCount, waitingCount);

    document.getElementById('last-scan').textContent = data.lastScan ? timeAgo(data.lastScan) : '—';
    document.getElementById('next-scan').textContent = msToClock(data.nextScanIn);
    renderLog(tradeLog);
  } catch (e) {
    renderChrome(null, []);
    renderHero(null, 'offline', 0, 0);
    console.log('poll error', e);
  }
}

document.getElementById('scan-btn').addEventListener('click', async () => {
  if (!isAdmin) return;
  const res = await fetch('/api/scan', { method: 'POST', headers: adminHeaders() });
  if (res.status === 401) return verifyAdmin();
  poll();
});

document.getElementById('admin-btn').addEventListener('click', toggleAdmin);

updateAdminUi();
verifyAdmin();
setInterval(poll, POLL_MS);

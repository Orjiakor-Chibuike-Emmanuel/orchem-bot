/* ═══════════════════════════════════════
   CONFIRMED SIGNALS — standalone page
   Its own page on purpose: on a day with several
   calls, scrolling through the full watchlist to
   find which ones confirmed doesn't scale. This
   page shows ONLY confirmed signals, newest first.
═══════════════════════════════════════ */

const POLL_MS = 15000;

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

function renderConfirmed(list) {
  const confirmed = (list || [])
    .filter(item => item.confirmed && !item.invalidated)
    .sort((a, b) => (b.confirmedAt || 0) - (a.confirmedAt || 0));

  document.getElementById('confirmed-count').textContent = confirmed.length;

  const el = document.getElementById('confirmed-list');
  if (!confirmed.length) {
    el.innerHTML = `<div class="empty-state">No confirmed signals yet today — this page fills in the moment one confirms.</div>`;
    return;
  }

  el.innerHTML = confirmed.map(item => {
    const isBull = item.direction === 'bull';
    const sym = item.symbol.replace('USDT', '');
    const whenAbs = item.confirmedAt ? new Date(item.confirmedAt).toLocaleString('en-GB', {
      day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit'
    }) : (item.signal2h && item.signal2h.dateStr) || '—';
    const whenAgo = item.confirmedAt ? timeAgo(item.confirmedAt) : '';

    const r = item.bybitResult || {};
    const bybitCls = r.placed ? 'placed' : r.error ? 'failed' : 'skipped';
    const bybitLine = r.placed
      ? `🤖 Bybit Demo: order placed — qty ${r.qty} ${sym}, SL $${r.sl}${r.tp ? `, TP $${r.tp}` : ' (no TP set)'}${r.trailing ? `, trailing $${r.trailing}` : ''}`
      : r.error
        ? `🤖 Bybit Demo: FAILED — ${r.reason}`
        : r.reason
          ? `🤖 Bybit Demo: ${r.reason}`
          : '';
    // Only call it "active" when Bybit actually confirmed the trailing
    // call — otherwise it's just the suggested % the bot computed.
    const trailingCell = r.trailing
      ? `<span>trailing <b>$${fmt(r.trailing)}</b> (${item.trailingPct}%, active)</span>`
      : item.trailingPct
        ? `<span>trailing <b>${item.trailingPct}%</b> (suggested, not set)</span>`
        : `<span>trailing <b>—</b></span>`;

    return `<div class="confirmed-card">
      <div class="confirmed-card-top">
        <span class="confirmed-card-name">${sym}/USDT
          <span class="dir-tag ${isBull ? 'long' : 'short'}">${isBull ? 'LONG' : 'SHORT'}</span>
        </span>
        <span class="confirmed-card-when">confirmed ${whenAbs}${whenAgo ? ` (${whenAgo})` : ''}</span>
      </div>
      <div class="confirmed-card-grid">
        <span>confirmed @ <b>$${fmt(item.confirmationPrice)}</b></span>
        ${item.entryPrice && item.entryPrice !== item.confirmationPrice ? `<span>fill <b>$${fmt(item.entryPrice)}</b></span>` : ''}
        ${item.tpLevel ? `<span>tp <b>$${fmt(item.tpLevel)}</b> (+${item.tpGain}%)</span>` : `<span>tp <b>none found</b> — size manually</span>`}
        ${item.slLevel ? `<span>sl <b>$${fmt(item.slLevel)}</b> (-${item.slRisk}%)</span>` : `<span>sl <b>none found</b> — size manually</span>`}
        ${item.sizeLeverage ? `<span>lev <b>${item.sizeLeverage}x</b></span>` : ''}
        ${trailingCell}
      </div>
      ${bybitLine ? `<div class="confirmed-card-bybit ${bybitCls}">${bybitLine}</div>` : ''}
    </div>`;
  }).join('');
}

async function poll() {
  try {
    const res = await fetch('/api/state');
    const data = await res.json();
    const list = data.confirmResults && data.confirmResults.length ? data.confirmResults : data.watchlist || [];
    renderConfirmed(list);
  } catch (e) {
    console.log('poll error', e);
  }
}

poll();
setInterval(poll, POLL_MS);

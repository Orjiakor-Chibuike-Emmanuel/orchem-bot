/* ═══════════════════════════════════════
   ORCHEM — confirmed page
   Its own page on purpose: on a day with several calls, scrolling the
   full watchlist to find which ones confirmed doesn't scale. This page
   shows only confirmed entries, newest first, each with a ladder that
   draws take profit, entry and stop loss to scale.
   (Shared helpers — esc, fmt, timeAgo, renderChrome — are in ui.js.)
═══════════════════════════════════════ */

const seenTickets = new Set();   // a ticket that wasn't here on the last poll gets a one-off highlight
let firstRender = true;

// How each TP/SL level was found, in plain words — so "how was this
// calculated?" never has to be reverse-engineered from a chart.
function sourceWords(source, estimated) {
  const words = {
    'aux-range': 'edge of the 30m auxiliary range',
    'tight-prior-candle': 'prior 30m candle',
    'swing-level': 'daily swing level',
    'swing-close': 'daily swing close',
    '4h-swing-close': '4h swing close',
    'range-extreme-close': 'range extreme (close)',
    '4h-swing-level': '4h swing level',
    'range-extreme': 'range extreme'
  }[source] || '';
  if (!words) return estimated ? 'estimate' : '';
  return estimated ? `estimate · ${words}` : words;
}

/* ── LADDER ──
   Higher price is always higher on the page. Take profit, entry and stop
   are placed in proportion to their real prices; labels are nudged apart
   only if two levels sit too close to read. */
function renderLadder(item) {
  const entry = item.entryPrice || item.confirmationPrice;
  const marks = [];
  if (item.tpLevel) marks.push({ kind: 'tp', price: item.tpLevel, name: 'Take profit', pct: `+${item.tpGain}%`, pos: true, src: sourceWords(item.tpSource, item.tpEstimated) });
  if (entry)        marks.push({ kind: 'entry', price: entry, name: item.entryPrice && item.entryPrice !== item.confirmationPrice ? 'Filled' : 'Entry', pct: '' });
  if (item.slLevel) marks.push({ kind: 'sl', price: item.slLevel, name: 'Stop loss', pct: `−${item.slRisk}%`, pos: false, src: sourceWords(item.slSource, item.slEstimated) });

  const missing = [
    !item.tpLevel ? 'No take profit found. Size it manually.' : '',
    !item.slLevel ? 'No stop loss found. Size it manually.' : ''
  ].filter(Boolean);

  if (marks.length < 2) {
    return `<div>${marks.map(m => `<p class="ladder-missing">${m.name} <b>$${fmt(m.price)}</b></p>`).join('')}
      ${missing.map(m => `<p class="ladder-missing">${m}</p>`).join('')}</div>`;
  }

  const TOP = 14, MIN_GAP = 40, MIN_SPAN = 150;
  const hi = Math.max(...marks.map(m => m.price));
  const lo = Math.min(...marks.map(m => m.price));
  const span = (hi - lo) || 1;
  marks.forEach(m => { m.y = TOP + ((hi - m.price) / span) * MIN_SPAN; });

  // Labels keep a minimum gap; the dots on the rail stay at their true spot.
  const ordered = marks.slice().sort((a, b) => a.y - b.y);
  ordered.forEach((m, i) => {
    m.labelY = i === 0 ? m.y : Math.max(m.y, ordered[i - 1].labelY + MIN_GAP);
  });
  const height = Math.max(...ordered.map(m => m.labelY)) + 34;

  const tp = marks.find(m => m.kind === 'tp');
  const sl = marks.find(m => m.kind === 'sl');
  const en = marks.find(m => m.kind === 'entry');
  const seg = (a, b, cls) => a && b
    ? `<div class="ladder-seg ${cls}" style="top:${Math.min(a.y, b.y)}px;height:${Math.abs(a.y - b.y)}px"></div>` : '';

  return `<div>
    <div class="ladder" style="height:${height}px" role="img"
         aria-label="Price ladder: ${marks.slice().sort((a, b) => b.price - a.price).map(m => `${m.name} $${fmt(m.price)}`).join(', ')}">
      ${seg(en, tp, 'profit')}${seg(en, sl, 'risk')}
      ${marks.map(m => `<div class="ladder-mark ${m.kind}" style="top:${m.y}px"></div>`).join('')}
      ${marks.map(m => `<div class="ladder-label" style="top:${m.labelY}px">
        <span class="ladder-name">${m.name}</span>
        <span class="ladder-price">$${fmt(m.price)}</span>
        ${m.pct ? `<span class="ladder-pct ${m.pos ? 'pos' : 'neg'}">${m.pct}</span>` : ''}
        ${m.src ? `<span class="ladder-src">${esc(m.src)}</span>` : ''}
      </div>`).join('')}
    </div>
    ${missing.map(m => `<p class="ladder-missing">${m}</p>`).join('')}
  </div>`;
}

function renderTrailing(item, r) {
  // Only call it "set" when Bybit actually confirmed the trailing call —
  // otherwise it's just the suggested % the bot computed.
  if (r.trailing) {
    return `<dd>$${fmt(r.trailing)} · ${esc(item.trailingPct)}%<small>starts working at $${fmt(r.trailingActivePrice)}</small></dd>`;
  }
  if (item.trailingPct) return `<dd>${esc(item.trailingPct)}%<small>suggested, not set on Bybit</small></dd>`;
  return `<dd>—</dd>`;
}

function renderTicket(item, isNew) {
  const isBull = item.direction === 'bull';
  const sym = item.symbol.replace('USDT', '');
  const r = item.bybitResult || {};
  const signal = (item.signal1d || '').replace(/^[▲▼]\s*/, '');

  const when = item.confirmedAt
    ? `${shortDateTime(item.confirmedAt)} · ${timeAgo(item.confirmedAt)}`
    : (item.signal2h && item.signal2h.dateStr) || '—';

  let bybit = '';
  if (r.placed) {
    bybit = `<div class="bybit placed"><b>Bybit demo: order placed.</b> ${esc(r.qty)} ${esc(sym)}, stop $${esc(r.sl)}${r.tp ? `, take profit $${esc(r.tp)}` : ', no take profit set'}${r.trailing ? `, trailing $${esc(r.trailing)}` : ''}.</div>`;
  } else if (r.error) {
    bybit = `<div class="bybit failed"><b>Bybit demo: order failed.</b> ${esc(r.reason)} Enter this one by hand.</div>`;
  } else if (r.reason) {
    bybit = `<div class="bybit skipped"><b>Bybit demo: not placed.</b> ${esc(r.reason)}</div>`;
  }

  const fill = item.entryPrice && item.entryPrice !== item.confirmationPrice;
  return `<article class="ticket ${isNew ? 'arrive' : ''}">
    <div class="ticket-head">
      <span class="ticket-sym">${esc(sym)}</span>
      <span class="pill ${isBull ? 'long' : 'short'}">${isBull ? '▲ Long' : '▼ Short'}</span>
      ${item.exhaustedEntry ? '<span class="pill flare">Reduced size · exhausted move</span>' : ''}
      <span class="ticket-when">${esc(when)}</span>
    </div>
    ${signal ? `<p class="ticket-signal">${esc(signal)}</p>` : ''}
    <div class="ticket-body">
      ${renderLadder(item)}
      <dl class="facts">
        <div class="fact"><dt>Confirmed at</dt><dd>$${fmt(item.confirmationPrice)}</dd></div>
        ${fill ? `<div class="fact"><dt>Filled at</dt><dd>$${fmt(item.entryPrice)}</dd></div>` : ''}
        ${item.sizeLeverage ? `<div class="fact"><dt>Leverage</dt><dd>${esc(item.sizeLeverage)}x</dd></div>` : ''}
        <div class="fact"><dt>Trailing stop</dt>${renderTrailing(item, r)}</div>
      </dl>
    </div>
    ${bybit}
  </article>`;
}

function renderConfirmed(list) {
  const confirmed = confirmedItems(list)
    .sort((a, b) => (b.confirmedAt || 0) - (a.confirmedAt || 0));

  const title = document.getElementById('hero-title');
  const sub = document.getElementById('hero-sub');
  if (confirmed.length) {
    title.textContent = confirmed.length === 1 ? '1 entry confirmed.' : `${confirmed.length} entries confirmed.`;
    sub.textContent = 'Newest first. The ladder draws take profit, entry and stop loss to scale.';
  } else {
    title.textContent = 'Nothing confirmed yet.';
    sub.textContent = 'This page fills in the moment a 30-minute candle closes through a pair’s line.';
  }

  const el = document.getElementById('confirmed-list');
  el.innerHTML = confirmed.map(item => {
    const key = `${item.symbol}:${item.direction}:${item.confirmedAt || ''}`;
    const isNew = !firstRender && !seenTickets.has(key);
    seenTickets.add(key);
    return renderTicket(item, isNew);
  }).join('');
  firstRender = false;
}

async function poll() {
  try {
    const res = await fetch('/api/state');
    const data = await res.json();
    const list = pickList(data);
    renderChrome(data, list);
    renderConfirmed(list);
  } catch (e) {
    renderChrome(null, []);
    document.getElementById('hero-title').textContent = 'Can’t reach the bot.';
    document.getElementById('hero-sub').textContent = 'This page retries every 15 seconds.';
    console.log('poll error', e);
  }
}

poll();
setInterval(poll, POLL_MS);

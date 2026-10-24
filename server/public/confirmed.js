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
function renderLadder(item, live) {
  const entry = item.entryPrice || item.confirmationPrice;
  const marks = [];
  if (item.tpLevel) marks.push({ kind: 'tp', price: item.tpLevel, name: 'Take profit', pct: `+${item.tpGain}%`, pos: true, src: sourceWords(item.tpSource, item.tpEstimated) });
  if (entry)        marks.push({ kind: 'entry', price: entry, name: item.entryPrice && item.entryPrice !== item.confirmationPrice ? 'Filled' : 'Entry', pct: '' });
  if (item.slLevel) {
    // If Bybit's stop has moved (the trailing stop doing its job), draw where
    // it is now and say where it started.
    const moved = live && live.stop && Math.abs(live.stop - item.slLevel) / item.slLevel > 0.0005;
    if (moved) {
      const locked = movePct(item.direction, entry, live.stop);   // + = profit locked in
      marks.push({
        kind: 'sl', price: live.stop, name: 'Stop now',
        pct: Math.abs(locked) < 0.05 ? 'break-even' : `${locked > 0 ? '+' : '−'}${Math.abs(locked).toFixed(2)}%`,
        pos: locked >= 0, src: `moved from $${fmt(item.slLevel)}`
      });
    } else {
      marks.push({ kind: 'sl', price: item.slLevel, name: 'Stop loss', pct: `−${item.slRisk}%`, pos: false, src: sourceWords(item.slSource, item.slEstimated) });
    }
  }
  if (live && live.price) {
    marks.push({ kind: 'now', price: live.price, name: live.estimate ? 'Now (estimate)' : 'Now', pct: '' });
  }

  const missing = [
    !item.tpLevel ? 'No take profit found. Size it manually.' : '',
    !item.slLevel ? 'No stop loss found. Size it manually.' : ''
  ].filter(Boolean);

  if (marks.filter(m => m.kind !== 'now').length < 2) {
    return `<div>${marks.filter(m => m.kind !== 'now').map(m => `<p class="ladder-missing">${m.name} <b>$${fmt(m.price)}</b></p>`).join('')}
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

function renderTrailing(item, r, pos) {
  // With the live position in hand, say what Bybit is actually doing.
  if (pos && pos.trailingStop) {
    const reached = !pos.activePrice ||
      (item.direction === 'bear' ? pos.markPrice <= pos.activePrice : pos.markPrice >= pos.activePrice);
    return `<dd>$${fmt(pos.trailingStop)} behind price<small>${reached
      ? `price reached $${fmt(pos.activePrice)} — the stop is following`
      : `starts working at $${fmt(pos.activePrice)}`}</small></dd>`;
  }
  // Only call it "set" when Bybit actually confirmed the trailing call —
  // otherwise it's just the suggested % the bot computed.
  if (r.trailing) {
    return `<dd>$${fmt(r.trailing)} · ${esc(item.trailingPct)}%<small>starts working at $${fmt(r.trailingActivePrice)}</small></dd>`;
  }
  if (item.trailingPct) return `<dd>${esc(item.trailingPct)}%<small>suggested, not set on Bybit</small></dd>`;
  return `<dd>—</dd>`;
}

/* ── LIVE P&L ──
   Where a trade stands right now. Source, in order of trust:
   open on Bybit (live) → closed (final result Bybit reported) →
   not on Bybit at all (an estimate from the bot's latest 30m price). */
function closedRow(item, tradeLog) {
  const since = item.confirmedAt ? item.confirmedAt - 5 * 60000 : 0;
  return (tradeLog || []).find(t =>
    t.entryStatus === 'confirmed' && t.actualPnl != null &&
    t.symbol === item.symbol && t.direction === item.direction &&
    (t.confirmedAtMs ? t.confirmedAtMs === item.confirmedAt : (t.loggedAt || 0) >= since));
}

function liveFor(item, positions, tradeLog) {
  const entry = item.entryPrice || item.confirmationPrice;
  const placed = !!(item.bybitResult && item.bybitResult.placed);
  const readable = positions && positions.available && positions.loaded;
  const pos = readable
    ? positions.positions.find(p => p.symbol === item.symbol && p.direction === item.direction) : null;

  if (pos) {
    return { kind: 'open', price: pos.markPrice, pnl: pos.unrealisedPnl,
             pct: movePct(item.direction, pos.avgPrice || entry, pos.markPrice), stop: pos.stopLoss, pos };
  }
  if (placed) {
    const row = closedRow(item, tradeLog);
    if (row) return { kind: 'closed', pnl: row.actualPnl };
    if (readable && !positions.stale) return { kind: 'gone' };
    return null;
  }
  if (item.currentPrice && entry) {
    const pct = movePct(item.direction, entry, item.currentPrice);
    const pnl = item.sizeQty ? item.sizeQty * (item.currentPrice - entry) * (item.direction === 'bear' ? -1 : 1) : null;
    return { kind: 'estimate', price: item.currentPrice, pnl, pct, estimate: true };
  }
  return null;
}

function renderLiveBlock(live) {
  if (!live) return '';
  if (live.kind === 'gone') {
    return `<div class="live"><span class="live-meta">No longer open on Bybit. The final result appears here within a few minutes.</span></div>`;
  }
  const cls = live.pnl == null ? '' : live.pnl >= 0 ? 'pos' : 'neg';
  const move = live.pct == null ? '' : `${live.pct >= 0 ? '+' : '−'}${Math.abs(live.pct).toFixed(2)}% price move`;
  const meta = live.kind === 'open' ? `${move} · live from Bybit`
    : live.kind === 'closed' ? 'closed · final result from Bybit'
    : `${move} · estimate from the bot’s last 30-minute price — not placed on Bybit`;
  const label = live.kind === 'closed' ? 'Closed' : live.kind === 'open' ? 'Open now' : 'Estimate';
  return `<div class="live ${cls}">
    <span class="live-label">${label}</span>
    <span class="live-pnl">${live.pnl == null ? (live.pct == null ? '—' : `${live.pct >= 0 ? '+' : '−'}${Math.abs(live.pct).toFixed(2)}%`) : money(live.pnl)}</span>
    <span class="live-meta">${esc(meta)}</span>
  </div>`;
}

function renderTicket(item, isNew, positions, tradeLog) {
  const isBull = item.direction === 'bull';
  const sym = item.symbol.replace('USDT', '');
  const r = item.bybitResult || {};
  const signal = (item.signal1d || '').replace(/^[▲▼]\s*/, '');
  const live = liveFor(item, positions, tradeLog);
  const ladderLive = live && live.price ? { price: live.price, stop: live.stop, estimate: live.estimate } : (live && live.stop ? { stop: live.stop } : null);

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
    ${renderLiveBlock(live)}
    <div class="ticket-body">
      ${renderLadder(item, ladderLive)}
      <dl class="facts">
        <div class="fact"><dt>Confirmed at</dt><dd>$${fmt(item.confirmationPrice)}</dd></div>
        ${fill ? `<div class="fact"><dt>Filled at</dt><dd>$${fmt(item.entryPrice)}</dd></div>` : ''}
        ${item.sizeLeverage ? `<div class="fact"><dt>Leverage</dt><dd>${esc(item.sizeLeverage)}x</dd></div>` : ''}
        <div class="fact"><dt>Trailing stop</dt>${renderTrailing(item, r, live && live.pos)}</div>
      </dl>
    </div>
    ${bybit}
  </article>`;
}

function renderConfirmed(list, positions, tradeLog) {
  const confirmed = confirmedItems(list)
    .sort((a, b) => (b.confirmedAt || 0) - (a.confirmedAt || 0));

  const title = document.getElementById('hero-title');
  const sub = document.getElementById('hero-sub');
  if (confirmed.length) {
    title.textContent = confirmed.length === 1 ? '1 entry confirmed.' : `${confirmed.length} entries confirmed.`;
    sub.textContent = 'Newest first. On open trades, the white dot is where price is now.';
  } else {
    title.textContent = 'Nothing confirmed yet.';
    sub.textContent = 'This page fills in the moment a 30-minute candle closes through a pair’s line.';
  }

  // Total across everything open on Bybit right now.
  const sum = openPnlSummary(positions);
  const pnlBox = document.getElementById('hero-pnl');
  pnlBox.hidden = !sum;
  if (sum) {
    const v = document.getElementById('pnl-total');
    v.textContent = money(sum.total);
    v.className = `hero-pnl-value ${sum.total >= 0 ? 'pos' : 'neg'}`;
    document.getElementById('pnl-sub').textContent =
      `open profit or loss across ${sum.count} ${sum.count === 1 ? 'position' : 'positions'} on Bybit` +
      (positions.stale ? ' · last check failed, showing the previous reading' : '');
  }

  const el = document.getElementById('confirmed-list');
  el.innerHTML = confirmed.map(item => {
    const key = `${item.symbol}:${item.direction}:${item.confirmedAt || ''}`;
    const isNew = !firstRender && !seenTickets.has(key);
    seenTickets.add(key);
    return renderTicket(item, isNew, positions, tradeLog);
  }).join('');
  firstRender = false;
}

async function poll() {
  try {
    const [res, positions] = await Promise.all([fetch('/api/state'), fetchPositions()]);
    const data = await res.json();
    const list = pickList(data);
    renderChrome(data, list);
    renderConfirmed(list, positions, data.tradeLog || []);
  } catch (e) {
    renderChrome(null, []);
    document.getElementById('hero-title').textContent = 'Can’t reach the bot.';
    document.getElementById('hero-sub').textContent = 'This page retries every 15 seconds.';
    console.log('poll error', e);
  }
}

poll();
setInterval(poll, POLL_MS);

'use strict';
// External file (not inline) because the panel serves apps with CSP script-src 'self'.
const q = new URLSearchParams(location.search);
const refreshMs = Math.max(10, parseInt(q.get('refreshSeconds'), 10) || 30) * 1000;
document.documentElement.dataset.theme = q.get('_dark') === '0' ? 'light' : 'dark';

const $ = s => document.querySelector(s);
const esc = v => String(v == null ? '' : v).replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const FILTER_THRESHOLD = 12;   // ponytail: filters appear above this; search only for far larger fleets
const COLS = 3;
let filter = 'all';
let lastSig = '';              // signature of last render — skip re-render (and keep focus) when data unchanged
let devicesCache = null;       // null until first load -> skeletons

// Primary condition, one per machine: expired (attention) > online > offline.
function condition(d) {
  if (d.expired) return 'warn';
  return d.online ? 'ok' : 'off';
}

// Urgency order: attention -> online -> offline; alphabetical within each group. Row-major fill.
function sortDevices(list) {
  const rank = { warn: 0, ok: 1, off: 2 };
  return list.slice().sort((a, b) =>
    (rank[condition(a)] - rank[condition(b)])
    || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
}

function dateText(ms) {
  const dt = new Date(ms);
  const sameYear = dt.getFullYear() === new Date().getFullYear();
  return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: sameYear ? undefined : 'numeric' });
}

function statusHtml(d) {
  const c = condition(d);
  if (c === 'warn') return '<div class="status warn"><span class="glyph warn">!</span>KEY EXPIRED</div>';
  if (c === 'ok') return '<div class="status ok"><span class="glyph ok"></span>ONLINE</div>';
  return '<div class="status off"><span class="glyph off"></span>OFFLINE</div>';
}

// Last-seen line only when it says something: nothing while online, omitted when unknown.
// Always "Last seen" — the API gives no offline-since timestamp, so don't imply one.
function seenHtml(d) {
  if (d.online || !d.lastSeen) return '';
  return '<div class="c-seen">Last seen ' + esc(dateText(d.lastSeen)) + '</div>';
}

function badgeHtml(d) {
  if (d.self) return '<span class="badge">This device</span>';
  if (d.exitNode || d.exitNodeOption) return '<span class="badge">Exit node</span>';
  return '';
}

// OS · primary address; missing values are omitted cleanly, never shown as placeholders.
function metaHtml(d) {
  const parts = [];
  if (d.os) parts.push('<span class="os">' + esc(d.os) + '</span>');
  const ip = d.ipv4 || d.addresses[0];
  if (ip) parts.push('<span class="addr">' + esc(ip) + '</span>');
  return parts.length ? '<div class="c-meta">' + parts.join(' · ') + '</div>' : '';
}

function fmtRate(bps) {
  if (bps >= 1e6) return (bps / 1e6).toFixed(1) + ' MB/s';
  if (bps >= 1e3) return Math.round(bps / 1e3) + ' KB/s';
  return Math.round(bps) + ' B/s';
}

// Panel<->peer connection: direct endpoint or DERP relay; live rate only when it's moving.
function connHtml(d) {
  if (d.self || !d.online) return '';
  const parts = [];
  if (d.direct) parts.push('Direct · <span class="addr">' + esc(d.direct) + '</span>');
  else if (d.relay) parts.push('Relayed via ' + esc(d.relay).toUpperCase());
  const rate = (d.rxRate || 0) + (d.txRate || 0);
  if (rate > 0) parts.push('↓ ' + fmtRate(d.rxRate || 0) + ' ↑ ' + fmtRate(d.txRate || 0));
  return parts.length ? '<div class="c-seen">' + parts.join(' · ') + '</div>' : '';
}

function cardHtml(d) {
  return '<div class="card" tabindex="0" data-id="' + esc(d.id) + '" title="' + esc(d.name) + '">'
    + '<div class="c-top"><span class="mname">' + esc(d.name) + '</span>' + badgeHtml(d) + '</div>'
    + statusHtml(d) + metaHtml(d) + seenHtml(d) + connHtml(d)
    + '</div>';
}

function skeletonHtml() {
  return '<div class="card skel"><div class="bar w1"></div><div class="bar w2"></div><div class="bar w3"></div></div>'.repeat(6);
}

function headerHealth(list) {
  const online = list.filter(d => condition(d) === 'ok').length;
  const attention = list.filter(d => condition(d) === 'warn').length;
  const offline = list.length - online - attention;
  const chips = ['<span class="chip"><span class="glyph ok"></span><span class="n">' + online + '</span> online</span>'];
  if (attention) chips.push('<span class="chip"><span class="glyph warn">!</span><span class="n">' + attention + '</span> attention</span>');
  chips.push('<span class="chip"><span class="glyph off"></span><span class="n">' + offline + '</span> offline</span>');
  $('#health').innerHTML = chips.join('');
}

function visibleDevices() {
  const sorted = sortDevices(devicesCache || []);
  return filter === 'all' ? sorted : sorted.filter(d => condition(d) === filter);
}

// "1–6 of 14" from live geometry, so it stays right for any card size or count.
function updatePos() {
  const cards = [...document.querySelectorAll('.card:not(.skel)')];
  const total = cards.length;
  if (!total) { $('#pos').textContent = ''; $('#fade').style.display = 'none'; return; }
  const view = $('#list').getBoundingClientRect();
  const vis = cards.filter(c => {
    const r = c.getBoundingClientRect();
    return r.top < view.bottom - 20 && r.bottom > view.top + 20;
  });
  const first = cards.indexOf(vis[0]) + 1;
  const last = cards.indexOf(vis[vis.length - 1]) + 1;
  $('#pos').textContent = first + '–' + last + ' of ' + total;
  const el = $('#list');
  $('#fade').style.display = el.scrollHeight - el.scrollTop - el.clientHeight > 8 ? 'block' : 'none';
}

function render() {
  if (devicesCache === null) { $('#grid').innerHTML = skeletonHtml(); return; }   // first load
  const list = visibleDevices();
  const focused = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.id : null;
  const sig = JSON.stringify([filter, list]);
  if (sig === lastSig) { updatePos(); return; }   // nothing changed — don't touch the DOM mid-navigation
  lastSig = sig;

  const scrollTop = $('#list').scrollTop;
  $('#grid').innerHTML = list.map(cardHtml).join('');
  $('#list').scrollTop = scrollTop;               // keep the user's place across refreshes
  if (focused) { const el = document.querySelector('.card[data-id="' + CSS.escape(focused) + '"]'); if (el) el.focus({ preventScroll: true }); }

  $('#filters').style.display = devicesCache.length > FILTER_THRESHOLD ? 'flex' : 'none';
  $('#empty').style.display = list.length ? 'none' : 'block';
  if (!list.length) $('#empty').querySelector('.big').textContent =
    filter === 'all' ? 'No machines found' : 'No machines match this filter';
  updatePos();
}

async function refresh() {
  try {
    const res = await fetch('/app-api/devices', { cache: 'no-store', signal: AbortSignal.timeout(12000) });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok || payload.ok === false) throw new Error(payload.error || 'Request failed (' + res.status + ')');
    $('#banner').style.display = 'none';
    if (payload.note) { $('#bannertext').textContent = payload.note; $('#banner').style.display = 'flex'; }
    devicesCache = payload.devices || [];
    headerHealth(devicesCache);
    $('#rate').textContent = payload.rateIn != null
      ? '↓ ' + fmtRate(payload.rateIn) + '   ↑ ' + fmtRate(payload.rateOut) : '';
    render();
  } catch (error) {
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    $('#bannertext').textContent = timedOut
      ? 'No response from the app backend. Check that the panel is running, then retry.'
      : error.message;
    $('#banner').style.display = 'flex';
    if (devicesCache === null) $('#grid').innerHTML = skeletonHtml();
  }
}

// ── knob / keyboard: row-major, one card per step; next row auto-scrolls into view ──
document.addEventListener('keydown', e => {
  const cards = [...document.querySelectorAll('.card:not(.skel)')];
  if (!cards.length) return;
  const step = { ArrowRight: 1, ArrowDown: COLS, ArrowLeft: -1, ArrowUp: -COLS }[e.key];
  if (step == null) return;
  e.preventDefault();
  const at = cards.indexOf(document.activeElement);
  const next = at === -1 ? 0 : Math.max(0, Math.min(cards.length - 1, at + step));
  cards[next].focus({ preventScroll: true });
  cards[next].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

$('#list').addEventListener('scroll', updatePos, { passive: true });
$('#filters').addEventListener('click', e => {
  const b = e.target.closest('button');
  if (!b) return;
  filter = b.dataset.f;
  document.querySelectorAll('#filters button').forEach(x => x.classList.toggle('sel', x === b));
  render();
});
const openAdmin = () => fetch('/app-api/open').catch(() => {});
$('#admin').addEventListener('click', openAdmin);
$('#emptyadmin').addEventListener('click', openAdmin);
$('#retry').addEventListener('click', refresh);

render();          // skeletons immediately
refresh();
setInterval(refresh, refreshMs);

'use strict';

const query = new URLSearchParams(location.search);
const mockMode = query.get('mock') === '1' || query.get('mock') === 'true';
const refreshSeconds = Math.max(5, Math.min(60, parseInt(query.get('refreshSeconds'), 10) || 10));

const SERVICES = [
  { key: 'sonarr', name: 'Sonarr', missingWord: 'missing' },
  { key: 'radarr', name: 'Radarr', missingWord: 'missing' },
  { key: 'lidarr', name: 'Lidarr', missingWord: 'wanted' },
  { key: 'sabnzbd', name: 'SABnzbd' },
  { key: 'youtarr', name: 'Youtarr' },
  { key: 'lidatube', name: 'LidaTube' },
];

const $ = selector => document.querySelector(selector);

// selected = one service key to focus the right column on, or null for combined
const state = { selected: null, lastServices: null };

function applyTheme() {
  document.documentElement.dataset.theme = query.get('_dark') === '0' ? 'light' : 'dark';
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1e12) return (n / 1e12).toFixed(1) + ' TB';
  if (n >= 1e9) return Math.round(n / 1e9) + ' GB';
  return Math.round(n / 1e6) + ' MB';
}

function formatWhen(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return time;
  return 'Tomorrow ' + time;
}

// ── Rail ─────────────────────────────────────────────────────────────────────
function railRow(service, slice) {
  let dot = 'up';
  let headline;
  if (!slice) {
    dot = '';
    headline = '<span class="hd state idle">…</span>';
  } else if (slice.up === false) {
    dot = 'down';
    headline = '<span class="hd state bad">Unreachable</span>';
  } else if (service.key === 'sabnzbd') {
    if (slice.paused) { dot = 'warn'; headline = '<span class="hd state idle">paused</span>'; }
    else if (slice.kbpersec > 50) headline = '<span class="hd">' + esc((slice.kbpersec / 1024).toFixed(1)) + '<span class="sub">MB/s</span></span>';
    else headline = '<span class="hd state idle">idle</span>';
  } else if (service.key === 'youtarr') {
    headline = '<span class="hd">' + slice.jobCount + '<span class="sub">' + (slice.jobCount === 1 ? 'job running' : 'jobs') + '</span></span>';
  } else if (service.key === 'lidatube') {
    headline = '<span class="hd state ok">Up</span>';
  } else {
    if (slice.queueErrors || (slice.health || []).some(h => h.type === 'error')) dot = 'down';
    else if (slice.queueWarnings || (slice.health || []).length) dot = 'warn';
    headline = '<span class="hd">' + (slice.queueCount || 0)
      + '<span class="sub">&#8595; &#183; ' + (slice.missing || 0) + ' ' + service.missingWord + '</span></span>';
  }
  return '<button type="button" class="svc' + (state.selected === service.key ? ' sel' : '') + '" data-svc="' + service.key + '">'
    + '<span class="dot ' + dot + '"></span><span class="nm b-' + service.key + '">' + service.name + '</span>' + headline + '</button>';
}

// ── Center list ──────────────────────────────────────────────────────────────
function statusIsWarning(status) {
  return /stalled|warning|failed|error|paused/i.test(String(status || ''));
}

function mergedItems(services) {
  const rows = [];
  for (const service of SERVICES) {
    const slice = services[service.key];
    if (!slice || !slice.configured || !Array.isArray(slice.items)) continue;
    for (const item of slice.items) rows.push(Object.assign({ service: service.key }, item));
  }
  rows.sort((a, b) => (b.progress != null ? b.progress : -1) - (a.progress != null ? a.progress : -1));
  return rows;
}

function itemRow(item) {
  const warn = statusIsWarning(item.status);
  const eta = warn ? item.status : (item.timeleft || item.status || '');
  const bar = item.progress != null
    ? '<div class="bar"><i' + (warn ? ' class="warn"' : '') + ' style="width:' + Math.max(0, Math.min(100, item.progress)) + '%"></i></div>'
    : '';
  return '<div class="dl"><div class="top">'
    + '<span class="badge b-' + item.service + '">' + item.service.toUpperCase().replace('NZBD', '') + '</span>'
    + '<span class="ttl">' + esc(item.title) + '</span>'
    + '<span class="eta">' + esc(eta) + '</span>'
    + '</div>' + bar + '</div>';
}

// ── Right column ─────────────────────────────────────────────────────────────
function focusedServices() {
  return state.selected ? SERVICES.filter(s => s.key === state.selected) : SERVICES;
}

function healthHtml(services) {
  const cards = [];
  for (const service of focusedServices()) {
    const slice = services[service.key];
    if (!slice || !slice.configured) continue;
    if (slice.up === false) {
      cards.push('<div class="hw err"><b>' + service.name + '</b><span>' + esc(slice.error || 'Unreachable') + '</span></div>');
      continue;
    }
    for (const entry of slice.health || []) {
      cards.push('<div class="hw' + (entry.type === 'error' ? ' err' : '') + '"><b>' + service.name + '</b><span>' + esc(entry.message) + '</span></div>');
    }
  }
  if (!cards.length) {
    const who = state.selected ? SERVICES.find(s => s.key === state.selected).name : 'All services';
    return '<div class="ok-pill">&#10003;&nbsp; ' + who + ' healthy</div>';
  }
  return cards.slice(0, 4).join('');
}

function disksHtml(services) {
  const seen = new Map();
  for (const service of focusedServices()) {
    const slice = services[service.key];
    if (!slice || !Array.isArray(slice.disks)) continue;
    for (const disk of slice.disks) {
      if (!disk.total) continue;
      seen.set(disk.path + '|' + disk.total, disk);
    }
  }
  return Array.from(seen.values()).slice(0, 3).map(disk => {
    const usedPct = Math.round((1 - disk.free / disk.total) * 100);
    const low = disk.free / disk.total < 0.1;
    return '<div class="disk"><div class="lbl"><span>' + esc(disk.path) + '</span>'
      + '<span class="free' + (low ? ' warn' : '') + '">' + formatBytes(disk.free) + ' free of ' + formatBytes(disk.total) + '</span></div>'
      + '<div class="bar"><i class="' + (low ? 'warn' : 'ok') + '" style="width:' + usedPct + '%"></i></div></div>';
  }).join('');
}

function calendarHtml(services) {
  const entries = [];
  for (const service of focusedServices()) {
    const slice = services[service.key];
    if (!slice || !Array.isArray(slice.calendar)) continue;
    entries.push(...slice.calendar);
  }
  entries.sort((a, b) => new Date(a.when) - new Date(b.when));
  if (!entries.length) return '<div class="none">Nothing scheduled</div>';
  return entries.slice(0, 5).map(entry =>
    '<div class="it"><span class="nm">' + esc(entry.title) + '</span><span class="when">' + esc(formatWhen(entry.when)) + '</span></div>'
  ).join('');
}

function historyHtml(slice) {
  const rows = (slice && slice.history) || [];
  if (!rows.length) return '<div class="none">No recent history</div>';
  return rows.slice(0, 5).map(entry =>
    '<div class="it"><span class="nm">' + esc(entry.title) + '</span><span class="when">' + esc(entry.status || '') + '</span></div>'
  ).join('');
}

// ── Render ───────────────────────────────────────────────────────────────────
function render(services) {
  state.lastServices = services;
  const configured = SERVICES.filter(s => services[s.key] && services[s.key].configured);
  $('#rail').innerHTML = configured.length
    ? configured.map(s => railRow(s, services[s.key])).join('')
    : '<div class="svc"><span class="nm">No services configured</span></div>';

  const items = mergedItems(services);
  $('#activity-heading').textContent = items.length ? 'Active downloads · ' + items.length : 'Active downloads';
  $('#dl-list').innerHTML = items.length
    ? items.map(itemRow).join('')
    : '<div class="empty">No active downloads</div>';

  const focused = state.selected && SERVICES.find(s => s.key === state.selected);
  $('#open-row').innerHTML = focused
    ? '<button type="button" class="open-btn" id="open-web">Open ' + focused.name + ' web UI&nbsp;&nbsp;&#8599;</button>'
    : '';

  $('#health').innerHTML = healthHtml(services);
  $('#disks').innerHTML = disksHtml(services);
  if (state.selected === 'sabnzbd') {
    $('#cal-heading').textContent = 'Recent history';
    $('#cal').innerHTML = historyHtml(services.sabnzbd);
  } else {
    $('#cal-heading').textContent = 'Next 24 hours';
    $('#cal').innerHTML = calendarHtml(services);
  }
  syncScrollbar();
}

function renderError(message) {
  $('#health').innerHTML = '<div class="hw err"><b>Dashboard</b><span>' + esc(message) + '</span></div>';
}

// ── Custom finger scrollbar ──────────────────────────────────────────────────
function syncScrollbar() {
  const list = $('#dl-list');
  const bar = $('#sbar');
  const thumb = $('#sbar-thumb');
  const overflow = list.scrollHeight - list.clientHeight;
  bar.hidden = overflow <= 4;
  if (bar.hidden) return;
  const track = bar.clientHeight;
  const size = Math.max(64, track * list.clientHeight / list.scrollHeight);
  thumb.style.height = size + 'px';
  thumb.style.top = (list.scrollTop / overflow * (track - size)) + 'px';
}

function wireScrollbar() {
  const list = $('#dl-list');
  const bar = $('#sbar');
  const thumb = $('#sbar-thumb');
  list.addEventListener('scroll', syncScrollbar, { passive: true });
  window.addEventListener('resize', syncScrollbar);

  let dragStartY = null;
  let dragStartScroll = 0;
  thumb.addEventListener('pointerdown', event => {
    dragStartY = event.clientY;
    dragStartScroll = list.scrollTop;
    thumb.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  thumb.addEventListener('pointermove', event => {
    if (dragStartY == null) return;
    const track = bar.clientHeight - thumb.clientHeight;
    if (track <= 0) return;
    const overflow = list.scrollHeight - list.clientHeight;
    list.scrollTop = dragStartScroll + (event.clientY - dragStartY) / track * overflow;
  });
  const endDrag = () => { dragStartY = null; };
  thumb.addEventListener('pointerup', endDrag);
  thumb.addEventListener('pointercancel', endDrag);

  bar.addEventListener('pointerdown', event => {
    if (event.target === thumb) return;
    const rect = thumb.getBoundingClientRect();
    list.scrollTop += (event.clientY < rect.top ? -1 : 1) * list.clientHeight * 0.9;
  });
}

// ── Data loop ────────────────────────────────────────────────────────────────
async function refresh() {
  try {
    const payload = mockMode ? mockSummary() : await fetchSummary();
    render(payload.services);
  } catch (error) {
    renderError(error.message || 'Refresh failed');
  } finally {
    setTimeout(refresh, refreshSeconds * 1000);
  }
}

async function fetchSummary() {
  const response = await fetch('/app-api/summary', { cache: 'no-store' });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch (error) { payload = {}; }
  if (!response.ok || payload.ok === false) throw new Error(payload.error || 'Request failed (' + response.status + ')');
  return payload;
}

function mockSummary() {
  return { ok: true, services: {
    sonarr: { configured: true, up: true, queueCount: 3, queueErrors: 0, queueWarnings: 0, missing: 12,
      health: [], disks: [{ path: '/data', free: 6.2e12, total: 14e12 }],
      items: [
        { title: 'The Expanse S06E04', progress: 72, timeleft: '00:12:00', status: 'downloading' },
        { title: 'For All Mankind S05E01', progress: null, timeleft: null, status: 'queued' },
      ],
      calendar: [{ title: 'Slow Horses S04E03', when: new Date(Date.now() + 6 * 3600e3).toISOString() }] },
    radarr: { configured: true, up: true, queueCount: 1, queueErrors: 0, queueWarnings: 0, missing: 4,
      health: [], disks: [{ path: '/data', free: 6.2e12, total: 14e12 }],
      items: [{ title: 'Dune: Part Two (2024)', progress: 31, timeleft: '01:04:00', status: 'downloading' }],
      calendar: [{ title: 'Twisters (2024)', when: new Date(Date.now() + 20 * 3600e3).toISOString() }] },
    lidarr: { configured: true, up: true, queueCount: 1, queueErrors: 0, queueWarnings: 0, missing: 27,
      health: [], disks: [], items: [{ title: 'Khruangbin — A LA SALA', progress: null, timeleft: null, status: 'queued' }], calendar: [] },
    sabnzbd: { configured: true, up: true, paused: false, kbpersec: 8601, queueCount: 1,
      disks: [{ path: '/downloads', free: 0.89e12, total: 2e12 }],
      items: [{ title: 'Slow.Horses.S04E02.2160p.WEB', progress: 45, timeleft: '0:22:00', status: 'Downloading' }] },
    youtarr: { configured: true, up: true, jobCount: 1,
      items: [{ title: 'Channel Downloads — Veritasium 3 of 12', progress: 25, timeleft: null, status: 'In Progress' }] },
    lidatube: { configured: true, up: true },
  } };
}

$('#open-row').addEventListener('click', async event => {
  if (!event.target.closest('#open-web') || !state.selected) return;
  try {
    if (!mockMode) {
      const response = await fetch('/app-api/open?svc=' + encodeURIComponent(state.selected), { cache: 'no-store' });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok || payload.ok === false) throw new Error(payload.error || 'Could not open');
    }
  } catch (error) {
    renderError(error.message || 'Could not open');
  }
});

$('#rail').addEventListener('click', event => {
  const row = event.target.closest('.svc[data-svc]');
  if (!row) return;
  state.selected = state.selected === row.dataset.svc ? null : row.dataset.svc;
  if (state.lastServices) render(state.lastServices);
});

applyTheme();
wireScrollbar();
refresh();

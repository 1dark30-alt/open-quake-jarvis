'use strict';

const query = new URLSearchParams(location.search);
const refreshSeconds = Math.max(5, Math.min(60, parseInt(query.get('refreshSeconds'), 10) || 10));

const $ = selector => document.querySelector(selector);

const state = {
  active: null,        // slot number of the selected tab
  servers: [],         // last summary payload
  timerBase: null,     // {seconds, at} for the local pause countdown
  countdownInterval: null,
};

function applyTheme() {
  document.documentElement.dataset.theme = query.get('_dark') === '0' ? 'light' : 'dark';
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function formatCount(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return (v / 1e6).toFixed(2) + ' M';
  if (v >= 100000) return Math.round(v / 1000) + ' k';
  return v.toLocaleString();
}

function formatAgo(unixTs) {
  if (!unixTs) return 'unknown';
  const hours = Math.floor((Date.now() / 1000 - unixTs) / 3600);
  if (hours < 1) return 'under an hour ago';
  if (hours < 48) return hours + ' h ago';
  return Math.floor(hours / 24) + ' d ago';
}

// ── Tabs ─────────────────────────────────────────────────────────────────────
function tabDot(server) {
  if (server.up === false) return 'down';
  if (server.blocking !== 'enabled') return 'warn';
  return '';
}

function tabSub(server) {
  if (server.up === false) return '<span class="tsub bad">Down</span>';
  if (server.blocking === 'disabled') return '<span class="tsub">blocking off</span>';
  if (server.stats) return '<span class="tsub">' + esc(server.stats.percent.toFixed(1)) + '% blocked</span>';
  return '';
}

function renderTabs(servers) {
  $('#tabs').innerHTML = servers.map(server =>
    '<button type="button" class="tab' + (server.slot === state.active ? ' sel' : '') + '" data-slot="' + server.slot + '">'
    + '<span class="tdot ' + tabDot(server) + '"></span>' + esc(server.name) + ' ' + tabSub(server) + '</button>'
  ).join('');
}

// ── Active pane ──────────────────────────────────────────────────────────────
function renderStats(server) {
  const s = server.stats || {};
  $('#stats').innerHTML =
    '<div class="tile"><span class="v">' + formatCount(s.total) + '</span><span class="l">Queries &#183; 24 h</span></div>'
    + '<div class="tile"><span class="v blk">' + formatCount(s.blocked) + '</span><span class="l">Blocked &#183; 24 h</span></div>'
    + '<div class="tile"><span class="v pct">' + (Number(s.percent) || 0).toFixed(1) + '%</span><span class="l">Percent blocked</span></div>'
    + '<div class="tile"><span class="v">' + formatCount(s.gravity) + '</span><span class="l">Domains on blocklist</span></div>'
    + '<div class="tile"><span class="v">' + (s.clients || 0) + '</span><span class="l">Active clients</span></div>'
    + '<div class="tile"><span class="v">' + (Number(s.qps) || 0).toFixed(1) + '<span class="unit"> q/s</span></span><span class="l">Query rate</span></div>';
}

function renderChart(detail) {
  const chart = $('#chart');
  const history = (detail && detail.history) || [];
  if (!history.length) {
    chart.innerHTML = '<span class="none">No history data</span>';
    return;
  }
  // Group ~144 ten-minute buckets into 48 bars (30-min each)
  const groupSize = Math.max(1, Math.ceil(history.length / 48));
  const bars = [];
  for (let i = 0; i < history.length; i += groupSize) {
    const group = history.slice(i, i + groupSize);
    bars.push({
      total: group.reduce((a, h) => a + h.total, 0),
      blocked: group.reduce((a, h) => a + h.blocked, 0),
    });
  }
  const max = Math.max(1, ...bars.map(b => b.total));
  chart.innerHTML = bars.map(bar => {
    const height = Math.max(2, Math.round(bar.total / max * 100));
    const blockedPct = bar.total > 0 ? Math.round(bar.blocked / bar.total * 100) : 0;
    return '<i style="height:' + height + '%"><b style="height:' + blockedPct + '%"></b></i>';
  }).join('');
}

function renderList(id, rows) {
  $(id).innerHTML = rows && rows.length
    ? rows.map(row => '<div class="it"><span class="n">' + esc(row.name) + '</span><span class="c">' + formatCount(row.count) + '</span></div>').join('')
    : '<div class="none">No data yet</div>';
}

function countdownText(seconds) {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return m + ':' + String(s).padStart(2, '0');
}

function renderBlocking(server) {
  const bstate = $('#bstate');
  const brow = $('#brow');
  if (server.blocking === 'enabled') {
    bstate.className = 'bstate';
    bstate.innerHTML = '&#9679; Blocking enabled';
    brow.innerHTML = '<button type="button" class="bbtn" data-block="pause">Pause 5 min</button>'
      + '<button type="button" class="bbtn" data-block="disable">Disable</button>';
  } else if (server.blocking === 'disabled') {
    bstate.className = 'bstate off';
    const remaining = remainingTimer();
    bstate.innerHTML = remaining != null
      ? '&#9646;&#9646; Blocking paused &#8212; resumes in <span id="bcount">' + countdownText(remaining) + '</span>'
      : '&#9646;&#9646; Blocking disabled';
    brow.innerHTML = '<button type="button" class="bbtn primary" data-block="enable">Enable now</button>';
  } else {
    bstate.className = 'bstate unknown';
    bstate.textContent = 'Blocking state unknown';
    brow.innerHTML = '';
  }
}

function remainingTimer() {
  if (!state.timerBase) return null;
  const left = state.timerBase.seconds - (Date.now() - state.timerBase.at) / 1000;
  return left > 0 ? left : 0;
}

function tickCountdown() {
  const el = document.getElementById('bcount');
  if (!el) return;
  const remaining = remainingTimer();
  if (remaining == null) return;
  el.textContent = countdownText(remaining);
}

function renderMeta(server) {
  const parts = [];
  if (server.detail) parts.push('Blocklist updated <b>' + esc(formatAgo(server.detail.gravityUpdated)) + '</b>');
  if (server.version) {
    parts.push('Pi-hole <b>' + esc(server.version) + '</b>'
      + (server.updateAvailable ? ' &nbsp;<span class="chip">update available</span>' : ''));
  }
  $('#meta').innerHTML = parts.join('<br>') || '';
}

function render() {
  const configured = state.servers.filter(server => server.configured);
  if (!configured.length) {
    $('#tabs').innerHTML = '';
    $('#down-overlay').hidden = false;
    $('#down-card').innerHTML = 'No Pi-hole servers configured — add a server URL in the app options.';
    return;
  }
  if (!configured.some(server => server.slot === state.active)) state.active = configured[0].slot;
  renderTabs(configured);

  const server = configured.find(s => s.slot === state.active);
  if (server.up === false) {
    $('#down-overlay').hidden = false;
    $('#down-card').innerHTML = '<b>' + esc(server.name) + ' is unreachable.</b><br>' + esc(server.error || '');
    return;
  }
  $('#down-overlay').hidden = true;
  renderStats(server);
  renderChart(server.detail);
  renderList('#top-blocked', server.detail && server.detail.topBlocked);
  renderList('#top-clients', server.detail && server.detail.topClients);
  renderBlocking(server);
  renderMeta(server);
}

// ── Data ─────────────────────────────────────────────────────────────────────
async function apiCall(action, params) {
  const url = new URL('/app-api/' + action, location.origin);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value != null && value !== '') url.searchParams.set(key, value);
  });
  const response = await fetch(url.pathname + url.search, { cache: 'no-store' });
  const text = await response.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch (error) {}
  if (!response.ok || payload.ok === false) throw new Error(payload.error || 'Request failed (' + response.status + ')');
  return payload;
}

function noteTimer(blocking, timer) {
  state.timerBase = (blocking === 'disabled' && typeof timer === 'number') ? { seconds: timer, at: Date.now() } : null;
}

async function refresh() {
  try {
    const payload = await apiCall('summary', { active: state.active || '' });
    state.servers = payload.servers;
    const active = payload.servers.find(server => server.slot === state.active && server.configured);
    if (active && active.up !== false) noteTimer(active.blocking, active.timer);
    render();
  } catch (error) {
    $('#down-overlay').hidden = false;
    $('#down-card').innerHTML = '<b>Dashboard error.</b><br>' + esc(error.message || 'Refresh failed');
  } finally {
    setTimeout(refresh, refreshSeconds * 1000);
  }
}

// ── Interactions ─────────────────────────────────────────────────────────────
$('#tabs').addEventListener('click', event => {
  const tab = event.target.closest('.tab[data-slot]');
  if (!tab) return;
  state.active = parseInt(tab.dataset.slot, 10);
  state.timerBase = null;
  render();
  apiCall('summary', { active: state.active }).then(payload => {
    state.servers = payload.servers;
    const active = payload.servers.find(server => server.slot === state.active);
    if (active && active.up !== false) noteTimer(active.blocking, active.timer);
    render();
  }).catch(() => {});
});

$('#brow').addEventListener('click', async event => {
  const button = event.target.closest('.bbtn[data-block]');
  if (!button || !state.active) return;
  const mode = button.dataset.block;
  button.disabled = true;
  try {
    const params = { server: state.active, enable: mode === 'enable' ? '1' : '0' };
    if (mode === 'pause') params.timer = '300';
    const result = await apiCall('blocking', params);
    const server = state.servers.find(s => s.slot === state.active);
    if (server) { server.blocking = result.blocking; server.timer = result.timer; }
    noteTimer(result.blocking, result.timer);
    render();
  } catch (error) {
    $('#bstate').className = 'bstate unknown';
    $('#bstate').textContent = error.message || 'Blocking change failed';
  }
});

$('#open-web').addEventListener('click', async () => {
  if (!state.active) return;
  try {
    await apiCall('open', { server: state.active });
  } catch (error) {
    $('#bstate').className = 'bstate unknown';
    $('#bstate').textContent = error.message || 'Could not open';
  }
});

applyTheme();
setInterval(tickCountdown, 1000);
refresh();

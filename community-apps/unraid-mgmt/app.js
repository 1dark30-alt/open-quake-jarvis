'use strict';

const RUNNING_VERSION = '1.0.8';
const query = new URLSearchParams(location.search);
const refreshSeconds = Math.max(5, Math.min(60, parseInt(query.get('refreshSeconds'), 10) || 10));
const controlsAllowed = query.get('allowControls') !== 'false' && query.get('allowControls') !== '0';

const $ = s => document.querySelector(s);
const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'docker', label: 'Docker' },
  { key: 'storage', label: 'Storage' },
  { key: 'vms', label: 'VMs' },
  { key: 'alerts', label: 'Alerts' },
];

const state = {
  servers: [],
  active: 0,
  tab: 'overview',
  filter: 'all',      // all | running | stopped
  sort: 'name',       // name | state
  density: 'comfortable',
  search: '',
  selected: null,     // container id shown in overlay
  dockerBuilt: false,
};

// ── setup ─────────────────────────────────────────────────────────────────────
function applyTheme() {
  document.documentElement.dataset.theme = query.get('_dark') === '0' ? 'light' : 'dark';
  const accent = query.get('_accent');
  if (accent && /^#?[0-9a-fA-F]{3,8}$/.test(accent)) {
    const hex = accent[0] === '#' ? accent : '#' + accent;
    document.documentElement.style.setProperty('--accent', hex);
    document.documentElement.style.setProperty('--accent-fg', contrastFg(hex));
  }
}
function contrastFg(hex) {
  let h = hex.replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? '#101010' : '#ffffff';
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmtBytes(b) {
  const n = Number(b) || 0;
  if (n >= 1e12) return (n / 1e12).toFixed(1) + ' TB';
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + ' GB';
  if (n >= 1e6) return Math.round(n / 1e6) + ' MB';
  return Math.round(n / 1e3) + ' KB';
}
function fmtMb(mb) {
  const n = Number(mb) || 0;
  return n >= 1024 ? (n / 1024).toFixed(1) + ' GB' : Math.round(n) + ' MB';
}
function fmtDuration(sec) {
  const s = Math.max(0, Math.floor(sec));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}
function fmtUptime(raw) {
  if (raw == null || raw === '') return '';
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return fmtDuration(n);
  const t = Date.parse(raw);
  if (!Number.isNaN(t)) return fmtDuration((Date.now() - t) / 1000);
  return String(raw);
}
function activeServer() { return state.servers.find(s => s.slot === state.active) || null; }

// ── data ──────────────────────────────────────────────────────────────────────
async function apiCall(action, params) {
  const url = new URL('/app-api/' + action, location.origin);
  Object.entries(params || {}).forEach(([k, v]) => { if (v != null && v !== '') url.searchParams.set(k, v); });
  const res = await fetch(url.pathname + url.search, { cache: 'no-store' });
  const text = await res.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch (e) {}
  if (!res.ok || payload.ok === false) throw new Error(payload.error || 'Request failed (' + res.status + ')');
  return payload;
}

async function refresh() {
  try {
    const payload = await apiCall('summary', { active: state.active || '' });
    state.servers = payload.servers || [];
    if (!state.servers.some(s => s.slot === state.active)) {
      state.active = payload.active || (state.servers[0] && state.servers[0].slot) || 0;
      state.dockerBuilt = false;
    }
    render();
  } catch (error) {
    renderFatal(error.message || 'Refresh failed');
  } finally {
    setTimeout(refresh, refreshSeconds * 1000);
  }
}

// ── render root ────────────────────────────────────────────────────────────────
function render() {
  renderRail();
  renderTabs();
  renderChips();
  renderView();
}

function renderRail() {
  const rail = $('#rail');
  if (!state.servers.length) {
    rail.innerHTML = '<div class="srv empty">No servers</div>';
    return;
  }
  rail.innerHTML = state.servers.map(s => {
    const down = s.up === false;
    const dot = down ? 'down' : (s.array && s.array.state && s.array.state !== 'STARTED' ? 'warn' : '');
    const counts = s.counts ? s.counts.running + '/' + s.counts.total : '';
    let sub;
    if (down) sub = '<span class="bad">' + esc(s.error || 'Unreachable') + '</span>';
    else if (s.system && s.system.cpuPct != null) sub = 'CPU ' + s.system.cpuPct + '% · RAM ' + (s.system.memPct != null ? s.system.memPct + '%' : '—');
    else sub = esc(s.system && s.system.unraid ? 'Unraid ' + s.system.unraid : '');
    return '<button type="button" class="srv' + (s.slot === state.active ? ' sel' : '') + '" data-slot="' + s.slot + '">'
      + '<span class="row1"><span class="dot ' + dot + '"></span><span class="nm">' + esc(s.name) + '</span>'
      + (counts ? '<span class="cnt">' + counts + '</span>' : '') + '</span>'
      + '<span class="sub">' + sub + '</span></button>';
  }).join('');
}

function renderTabs() {
  $('#tabs').innerHTML = TABS.map(t =>
    '<button type="button" class="tab' + (t.key === state.tab ? ' sel' : '') + '" data-tab="' + t.key + '">' + t.label + '</button>'
  ).join('');
}

function renderChips() {
  const s = activeServer();
  const chips = $('#chips');
  if (!s || s.up === false) { chips.innerHTML = ''; return; }
  const out = [];
  if (s.counts) out.push(chip('brand-docker', s.counts.running + '/' + s.counts.total, 'containers'));
  if (s.system && s.system.cpuPct != null) out.push(chip('cpu', s.system.cpuPct + '%', 'CPU'));
  if (s.system && s.system.memPct != null) out.push(chip('brain', s.system.memPct + '%', 'RAM'));
  if (s.gpu && s.gpu.util != null) out.push('<span class="chip gpu" title="GPU"><b>GPU ' + s.gpu.util + '%' + (s.gpu.temp != null ? ' ' + s.gpu.temp + '°' : '') + '</b></span>');
  if (s.array && s.array.state) out.push(chip('stack-2', esc(s.array.state.toLowerCase()), 'array'));
  if (s.ups && s.ups.charge != null) out.push(chip('battery-3', s.ups.charge + '%', 'UPS'));
  chips.innerHTML = out.join('');
}
function chip(icon, value, label) {
  return '<span class="chip" title="' + label + '"><b>' + value + '</b></span>';
}

function renderFatal(msg) {
  state.dockerBuilt = false;
  $('#view').innerHTML = '<div class="center-note"><b>Dashboard error</b>' + esc(msg) + '</div>';
}

// ── view dispatch ───────────────────────────────────────────────────────────────
function renderView() {
  const s = activeServer();
  if (!state.servers.length) {
    state.dockerBuilt = false;
    $('#view').innerHTML = '<div class="center-note"><b>No Unraid servers configured</b>Add a server URL and API key in the app options.</div>';
    return;
  }
  if (s && s.up === false) {
    state.dockerBuilt = false;
    $('#view').innerHTML = '<div class="center-note"><b>' + esc(s.name) + ' is unreachable</b>' + esc(s.error || '') + '</div>';
    return;
  }
  if (state.tab === 'docker') return renderDocker(s);
  state.dockerBuilt = false;
  if (state.tab === 'overview') return renderOverview(s);
  if (state.tab === 'storage') return renderStorage(s);
  if (state.tab === 'vms') return renderVms(s);
  if (state.tab === 'alerts') return renderAlerts(s);
}

// ── Docker ───────────────────────────────────────────────────────────────────────
function renderDocker(s) {
  if (!state.dockerBuilt) {
    $('#view').innerHTML =
      '<div class="docker">'
      + '<div class="dmain">'
      + '  <div class="dtoolbar">'
      + '    <label class="search"><span aria-hidden="true">&#128269;</span><input id="dsearch" type="search" placeholder="Filter containers" autocomplete="off"></label>'
      + '    <button type="button" class="fchip" data-filter="all">All</button>'
      + '    <button type="button" class="fchip" data-filter="running">Running</button>'
      + '    <button type="button" class="fchip" data-filter="stopped">Stopped</button>'
      + '    <button type="button" class="fchip warn" data-filter="updates">Updates</button>'
      + '    <button type="button" class="fchip" id="sortbtn">Sort: Name</button>'
      + '    <button type="button" class="fchip" id="densitybtn">Compact</button>'
      + '  </div>'
      + '  <div class="dwrap"><div class="dlist" id="dlist"></div><div class="sbar" id="sbar" hidden><div class="sbar-thumb" id="sbar-thumb"></div></div></div>'
      + '</div>'
      + '<aside class="dside" id="dside"></aside>'
      + '</div>';
    wireDocker();
    state.dockerBuilt = true;
    $('#dsearch').value = state.search;
  }
  updateDockerList(s);
}

function wireDocker() {
  $('#dsearch').addEventListener('input', e => { state.search = e.target.value; updateDockerList(activeServer()); });
  $('#view').querySelector('.dtoolbar').addEventListener('click', e => {
    const f = e.target.closest('[data-filter]');
    if (f) { state.filter = f.dataset.filter; return updateDockerList(activeServer()); }
    if (e.target.closest('#sortbtn')) { state.sort = state.sort === 'name' ? 'state' : 'name'; return updateDockerList(activeServer()); }
    if (e.target.closest('#densitybtn')) { state.density = state.density === 'comfortable' ? 'compact' : 'comfortable'; return updateDockerList(activeServer()); }
  });
  $('#dlist').addEventListener('click', onDockerListClick);
  $('#dside').addEventListener('click', onDsideClick);
  wireScrollbar('#dlist', '#sbar', '#sbar-thumb');
}

function filteredContainers(s) {
  let list = (s && s.containers) || [];
  const q = state.search.trim().toLowerCase();
  if (q) list = list.filter(c => (c.name + ' ' + c.image).toLowerCase().includes(q));
  if (state.filter === 'running') list = list.filter(c => c.state === 'running');
  else if (state.filter === 'stopped') list = list.filter(c => c.state !== 'running');
  else if (state.filter === 'updates') list = list.filter(c => c.updateAvailable);
  list = list.slice().sort((a, b) => {
    if (state.sort === 'state' && a.state !== b.state) return a.state === 'running' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return list;
}

function updateDockerList(s) {
  if (!s || state.tab !== 'docker') return;
  // toolbar chip states
  $('#view').querySelectorAll('[data-filter]').forEach(b => b.classList.toggle('sel', b.dataset.filter === state.filter));
  $('#sortbtn').textContent = 'Sort: ' + (state.sort === 'name' ? 'Name' : 'State');
  $('#densitybtn').textContent = state.density === 'comfortable' ? 'Compact' : 'Comfortable';

  const list = filteredContainers(s);
  const dlist = $('#dlist');
  dlist.classList.toggle('compact', state.density === 'compact');
  const compact = state.density === 'compact';
  dlist.innerHTML = list.length ? list.map(c => containerRow(c, compact)).join('')
    : '<div class="center-note" style="height:auto;padding:40px">' + (s.containers ? 'No containers match' : 'No container data') + '</div>';

  // side: counts + bulk + docker usage
  const c = s.counts || { running: 0, stopped: 0, total: 0 };
  const updN = c.updates || 0;
  const bulk = controlsAllowed
    ? '<button type="button" class="bbtn' + (updN ? ' primary' : '') + '" data-bulk="updateAll">Update all pending' + (updN ? ' (' + updN + ')' : '') + '</button>'
      + '<button type="button" class="bbtn" data-bulk="startAll">Start all</button>'
      + '<button type="button" class="bbtn danger" data-bulk="stopAll">Stop all</button>'
    : '';
  $('#dside').innerHTML =
    '<div class="mini">'
    + '<div class="stat"><span class="v ok">' + c.running + '</span><span class="l">Running</span></div>'
    + '<div class="stat"><span class="v">' + (c.stopped + (c.paused || 0)) + '</span><span class="l">Stopped</span></div>'
    + '<div class="stat"><span class="v' + (updN ? ' warn' : '') + '">' + updN + '</span><span class="l">Updates</span></div>'
    + '</div>'
    + '<button type="button" class="bbtn" data-bulk="checkUpdates">Check for updates</button>'
    + bulk
    + '<div class="spacer"></div>'
    + '<button type="button" class="bbtn" data-open>Open web UI</button>';
  syncScrollbar('#dlist', '#sbar', '#sbar-thumb');
}

function containerRow(c, compact) {
  const cls = c.state === 'running' ? 'running' : (c.state === 'paused' ? 'paused' : 'stopped');
  const dotcls = c.state === 'running' ? '' : (c.state === 'paused' ? 'paused' : 'stopped');
  const up = esc(shortStatus(c.status));
  let actions = '';
  if (!compact && controlsAllowed) {
    if (c.state === 'running') actions = btn('stop', '&#9632;') + btn('restart', '&#8635;');
    else if (c.state === 'paused') actions = '<button type="button" class="cbtn go" data-act="unpause" title="Resume">&#9654;</button>' + btn('stop', '&#9632;');
    else actions = '<button type="button" class="cbtn go" data-act="start" title="Start">&#9654;</button>' + btn('restart', '&#8635;');
    if (c.updateAvailable) actions = '<button type="button" class="cbtn upd" data-act="update" title="Apply update">&#11014;</button>' + actions;
  }
  let met = '';
  if (c.cpu != null || c.mem != null) {
    met = (c.cpu != null ? c.cpu + '%' : '') + (c.cpu != null && c.mem != null ? ' · ' : '') + (c.mem != null ? fmtMb(c.mem) : '');
  }
  // Always emit all six grid cells (empty when no data) so columns stay aligned.
  return '<div class="crow" data-id="' + esc(c.id) + '">'
    + '<span class="cdot ' + dotcls + '"></span>'
    + '<span class="cbody"><span class="cname">' + esc(c.name) + '</span><span class="cimage">' + esc(c.image) + '</span></span>'
    + '<span class="cstate"><span class="cpill ' + cls + '">' + esc(c.state || 'unknown') + '</span>'
    + (c.updateAvailable ? '<span class="cpill upd">update</span>' : '') + '</span>'
    + '<span class="cmet">' + met + '</span>'
    + '<span class="cup">' + up + '</span>'
    + '<div class="cactions">' + actions + '</div>'
    + '</div>';
}
function btn(act, glyph) { return '<button type="button" class="cbtn" data-act="' + act + '" title="' + act + '">' + glyph + '</button>'; }
function shortStatus(status) {
  const t = String(status || '');
  return t.length > 40 ? t.slice(0, 40) + '…' : t;
}

function onDockerListClick(e) {
  const row = e.target.closest('.crow[data-id]');
  if (!row) return;
  const id = row.dataset.id;
  const actBtn = e.target.closest('[data-act]');
  if (actBtn) { e.stopPropagation(); return runContainer(id, actBtn.dataset.act); }
  openDetail(id);
}

function onDsideClick(e) {
  const bulk = e.target.closest('[data-bulk]');
  if (bulk) return runBulk(bulk.dataset.bulk);
  if (e.target.closest('[data-open]')) return openWeb();
}

// ── Overview ─────────────────────────────────────────────────────────────────────
function renderOverview(s) {
  const sys = s.system || {}, arr = s.array, ups = s.ups;
  const gauges =
    gauge('CPU load', sys.cpuPct != null ? sys.cpuPct + '%' : '—', sys.cpuPct, '')
    + gauge('RAM', sys.memPct != null ? sys.memPct + '%' : '—', sys.memPct, sys.memUsed != null ? fmtBytes(sys.memUsed) + ' / ' + fmtBytes(sys.memTotal) : '')
    + gauge('Array', arr ? fmtBytes(arr.free) + ' free' : '—', arr ? Math.round((arr.used / (arr.total || 1)) * 100) : null, arr ? esc(arr.state.toLowerCase()) : '')
    + parityGauge(arr);

  let gpuCard;
  if (s.gpu && (s.gpu.util != null || s.gpu.memTotal)) {
    const g = s.gpu;
    const memPct = g.memTotal ? Math.round((g.memUsed / g.memTotal) * 100) : null;
    gpuCard = '<div class="card"><div class="hd">GPU<span class="tag nvidia">' + (g.temp != null ? g.temp + '°C' : '') + '</span></div>'
      + kvBar('Load', g.util != null ? g.util + '%' : '—', g.util, 'nv')
      + kv('Memory', (g.memUsed != null ? fmtMb(g.memUsed) : '—') + (g.memTotal ? ' / ' + fmtMb(g.memTotal) : ''))
      + (memPct != null ? '<div class="bar"><i class="nv" style="width:' + memPct + '%"></i></div>' : '')
      + '</div>';
  } else {
    const why = s.statsError
      ? 'stats-api error: ' + esc(s.statsError)
      : (s.statsConfigured ? 'stats-api reachable but returned no GPU data — check the nvidia mounts on that box.'
        : 'Add the stats-api add-on URL in this server\'s options to show GPU.');
    gpuCard = '<div class="card"><div class="hd">GPU<span class="tag nvidia">no data</span></div>'
      + '<div class="none">GPU isn\'t exposed by the Unraid API.<br>' + why + '</div></div>';
  }

  let upsCard;
  if (ups) {
    const chargeCls = ups.charge != null && ups.charge < 30 ? 'warn' : 'ok';
    upsCard = '<div class="card"><div class="hd">UPS · ' + esc(ups.name)
      + '<span class="tag ' + (ups.status && /online/i.test(ups.status) ? 'ok' : 'warn') + '">' + esc(ups.status || '—') + '</span></div>'
      + kvBar('Battery', (ups.charge != null ? ups.charge + '%' : '—'), ups.charge, chargeCls)
      + kvBar('Load', (ups.loadPct != null ? ups.loadPct + '%' : '—'), ups.loadPct, '')
      + kv('Runtime left', ups.runtime != null ? fmtDuration(ups.runtime) : '—')
      + kv('Nominal power', ups.nominalPower != null ? ups.nominalPower + ' W' : '—')
      + '</div>';
  } else {
    upsCard = '<div class="card"><div class="hd">UPS</div><div class="none">No UPS reported by this server.</div></div>';
  }

  $('#view').innerHTML = '<div class="overview"><div class="gauges">' + gauges + '</div><div class="cards">' + gpuCard + upsCard + '</div></div>';
}
function gauge(label, value, pct, sub) {
  const bar = pct != null ? '<div class="bar"><i class="' + (pct >= 90 ? 'warn' : 'ok') + '" style="width:' + Math.max(0, Math.min(100, pct)) + '%"></i></div>' : '';
  return '<div class="stat"><span class="l">' + label + '</span><span class="v">' + value + '</span>' + bar + (sub ? '<span class="l">' + sub + '</span>' : '') + '</div>';
}
function parityGauge(arr) {
  if (!arr || !arr.parity) return gauge('Parity', '—', null, '');
  const p = arr.parity;
  if (p.running) return gauge('Parity check', (p.progress != null ? Math.round(p.progress) + '%' : 'running'), p.progress, p.errors + ' errors');
  return gauge('Parity', 'Idle', null, (p.errors ? p.errors + ' errors' : '0 errors'));
}
function kv(k, v) { return '<div class="kv"><span>' + k + '</span><b>' + v + '</b></div>'; }
function kvBar(k, v, pct, cls) {
  return kv(k, v) + (pct != null ? '<div class="bar"><i class="' + cls + '" style="width:' + Math.max(0, Math.min(100, pct)) + '%"></i></div>' : '');
}

// ── Storage ───────────────────────────────────────────────────────────────────────
function renderStorage(s) {
  const arr = s.array;
  if (!arr) { $('#view').innerHTML = '<div class="center-note">No array data available.</div>'; return; }
  const disks = (arr.disks || []).map(d => {
    const usedPct = d.size ? Math.round(((d.size - d.free) / d.size) * 100) : 0;
    const low = d.size && d.free / d.size < 0.1;
    const smart = /pass|ok|healthy/i.test(d.status) ? '<span class="ok">OK</span>' : (d.status ? '<span class="warn">' + esc(d.status) + '</span>' : '—');
    return '<div class="line"><span class="n">' + esc(d.name) + '</span>'
      + '<div class="bar" style="margin:0;flex:2"><i class="' + (low ? 'warn' : 'ok') + '" style="width:' + usedPct + '%"></i></div>'
      + '<span class="r">' + (d.size ? fmtBytes(d.free) + ' free' : '') + '</span>'
      + '<span class="r">' + (d.temp != null ? d.temp + '°C' : '—') + '</span>'
      + '<span class="r">' + smart + '</span></div>';
  }).join('') || '<div class="center-note" style="height:auto;padding:40px">No disks reported</div>';

  const p = arr.parity || {};
  const controls = controlsAllowed
    ? (p.running
        ? '<button type="button" class="bbtn" data-parity="pause">Pause</button><button type="button" class="bbtn danger" data-parity="cancel">Cancel</button>'
        : '<button type="button" class="bbtn primary" data-parity="start">Start parity check</button>')
    : '';
  const parityCard = '<div class="parity-card"><div class="l">Parity</div>'
    + '<div class="big">' + (p.running ? (p.progress != null ? Math.round(p.progress) + '%' : 'Running') : 'Idle') + '</div>'
    + kv('Errors', String(p.errors || 0))
    + kv('Array', esc(arr.state.toLowerCase()))
    + kv('Used', fmtBytes(arr.used) + ' / ' + fmtBytes(arr.total)) + controls + '</div>';

  $('#view').innerHTML = '<div class="storage"><div class="scroll">' + disks + '</div><aside class="dside">' + parityCard + '</aside></div>';
  $('#view').querySelector('.storage').addEventListener('click', e => {
    const b = e.target.closest('[data-parity]');
    if (b) runParity(b.dataset.parity);
  });
}

// ── VMs ─────────────────────────────────────────────────────────────────────────
function renderVms(s) {
  const vms = s.vms;
  if (!vms) { $('#view').innerHTML = '<div class="center-note">VMs aren\'t reported by this server.</div>'; return; }
  if (!vms.length) { $('#view').innerHTML = '<div class="center-note">No virtual machines.</div>'; return; }
  const rows = vms.map(v => {
    const running = v.state === 'running' || v.state === 'started';
    const pill = '<span class="cpill ' + (running ? 'running' : 'stopped') + '">' + esc(v.state) + '</span>';
    const act = !controlsAllowed ? '' : (running
      ? '<button type="button" class="cbtn" data-vm="stop" data-id="' + esc(v.id) + '" title="Stop">&#9632;</button>'
      : '<button type="button" class="cbtn go" data-vm="start" data-id="' + esc(v.id) + '" title="Start">&#9654;</button>');
    return '<div class="line"><span class="n">' + esc(v.name) + '</span>' + pill + '<div class="cactions">' + act + '</div></div>';
  }).join('');
  $('#view').innerHTML = '<div class="scroll">' + rows + '</div>';
  $('#view').querySelector('.scroll').addEventListener('click', e => {
    const b = e.target.closest('[data-vm]');
    if (b) runVm(b.dataset.id, b.dataset.vm);
  });
}

// ── Alerts ───────────────────────────────────────────────────────────────────────
function renderAlerts(s) {
  const n = s.notifications;
  if (!n) { $('#view').innerHTML = '<div class="center-note">Notifications aren\'t reported by this server.</div>'; return; }
  if (!n.list.length) { $('#view').innerHTML = '<div class="center-note"><b>All clear</b>No unread notifications.</div>'; return; }
  const rows = n.list.map(x => {
    const cls = x.importance === 'alert' ? 'bad' : (x.importance === 'warning' ? 'warn' : 'ok');
    return '<div class="line"><span class="cpill ' + (cls === 'ok' ? 'running' : (cls === 'warn' ? 'paused' : 'stopped')) + '">' + esc(x.importance || 'info') + '</span>'
      + '<span class="n">' + esc(x.title || x.subject) + '</span>'
      + '<span class="r">' + esc(x.subject && x.subject !== x.title ? x.subject : '') + '</span></div>';
  }).join('');
  $('#view').innerHTML = '<div class="scroll">' + rows + '</div>';
}

// ── container detail overlay ──────────────────────────────────────────────────────
function openDetail(id) {
  const s = activeServer();
  const c = s && (s.containers || []).find(x => x.id === id);
  if (!c) return;
  state.selected = id;
  const running = c.state === 'running', paused = c.state === 'paused';
  const ports = c.ports.length ? c.ports.map(p => (p.pub ? p.pub + '&#8594;' : '') + (p.priv != null ? p.priv : '?')).join(', ') : 'none';
  const acts = [];
  if (controlsAllowed) {
    if (running) { acts.push(pact('stop', 'Stop', 'danger')); acts.push(pact('restart', 'Restart')); acts.push(pact('pause', 'Pause')); }
    else if (paused) { acts.push(pact('unpause', 'Resume', 'primary')); acts.push(pact('stop', 'Stop', 'danger')); }
    else { acts.push(pact('start', 'Start', 'go')); acts.push(pact('restart', 'Restart')); }
    acts.push(pact('update', c.updateAvailable ? 'Update ready' : 'Update', c.updateAvailable ? 'primary' : ''));
  }

  $('#panel').innerHTML =
    '<div class="phd"><span class="ptitle">' + esc(c.name) + '</span><button type="button" class="close" id="pclose">&#10005;</button></div>'
    + '<div><span class="cpill ' + (running ? 'running' : (paused ? 'paused' : 'stopped')) + '">' + esc(c.state) + '</span>' + (c.updateAvailable ? ' <span class="cpill upd">update</span>' : '') + ' <span class="cup">' + esc(c.status) + '</span></div>'
    + '<div class="pactions">' + acts.join('') + '</div>'
    + '<div class="pmeta">'
    + kv('Image', '<span class="mono">' + esc(c.image) + '</span>')
    + kv('Ports', ports)
    + kv('Autostart', c.autoStart ? 'on' : 'off')
    + (c.cpu != null ? kv('CPU', c.cpu + '%') : '')
    + (c.mem != null ? kv('Memory', fmtMb(c.mem) + (c.memLimit ? ' / ' + fmtMb(c.memLimit) : '')) : '')
    + (c.gpuMem != null ? kv('GPU memory', fmtMb(c.gpuMem)) : '')
    + '</div>'
    + '<button type="button" class="paction primary" id="plogs">Open logs in web UI</button>'
    + '<div class="none" style="color:var(--muted);font-size:15px">' + (c.cpu == null ? 'Live CPU/memory need the stats-api add-on. ' : '') + 'Logs open in your browser via the stats-api add-on.</div>';
  $('#overlay').hidden = false;
  $('#panel').scrollTop = 0;
}

function pact(act, label, cls) { return '<button type="button" class="paction ' + (cls || '') + '" data-pact="' + act + '">' + label + '</button>'; }

function closeOverlay() { $('#overlay').hidden = true; state.selected = null; }

$('#overlay').addEventListener('click', e => {
  if (e.target.id === 'scrim' || e.target.id === 'pclose') return closeOverlay();
  if (e.target.id === 'plogs') return openLogs(state.selected);
  const b = e.target.closest('[data-pact]');
  if (b && state.selected) runContainer(state.selected, b.dataset.pact);
});

// ── confirm dialog ────────────────────────────────────────────────────────────────
function confirmAction(title, text, danger) {
  return new Promise(resolve => {
    $('#confirm-box').innerHTML =
      '<div class="ctitle">' + esc(title) + '</div><div class="ctext">' + esc(text) + '</div>'
      + '<div class="crow2"><button type="button" class="cbtn2" data-c="0">Cancel</button>'
      + '<button type="button" class="cbtn2 ' + (danger ? 'danger' : '') + '" data-c="1">Confirm</button></div>';
    $('#confirm').hidden = false;
    const done = ok => { $('#confirm').hidden = true; box.removeEventListener('click', onClick); resolve(ok); };
    const box = $('#confirm');
    const onClick = e => {
      if (e.target.id === 'confirm-scrim') return done(false);
      const b = e.target.closest('[data-c]');
      if (b) done(b.dataset.c === '1');
    };
    box.addEventListener('click', onClick);
  });
}

// ── actions ───────────────────────────────────────────────────────────────────────
const CONFIRM_OPS = { stop: 'Stop', restart: 'Restart', update: 'Update' };
async function runContainer(id, op) {
  if (CONFIRM_OPS[op]) {
    const s = activeServer();
    const c = s && (s.containers || []).find(x => x.id === id);
    const ok = await confirmAction(CONFIRM_OPS[op] + ' container', CONFIRM_OPS[op] + ' "' + (c ? c.name : id) + '"?', op !== 'update');
    if (!ok) return;
  }
  try {
    await apiCall('container', { server: state.active, id, op });
    toast(op === 'update' ? 'Update started' : 'Done');
    closeOverlay();
    refresh();
  } catch (e) { toast(e.message || 'Action failed', true); }
}

async function runBulk(kind) {
  if (kind === 'stopAll') { if (!await confirmAction('Stop all containers', 'Stop every running container on this server?', true)) return; }
  if (kind === 'updateAll') { if (!await confirmAction('Update all', 'Update all containers with pending updates?', false)) return; }
  try {
    if (kind === 'checkUpdates') { toast('Checking for updates…'); await apiCall('checkUpdates', { server: state.active }); toast('Update check done'); }
    else if (kind === 'updateAll') { await apiCall('updateAll', { server: state.active }); toast('Update all started'); }
    else {
      const s = activeServer();
      const list = (s.containers || []).filter(c => kind === 'startAll' ? c.state !== 'running' : c.state === 'running');
      for (const c of list) { try { await apiCall('container', { server: state.active, id: c.id, op: kind === 'startAll' ? 'start' : 'stop' }); } catch (e) {} }
      toast(kind === 'startAll' ? 'Starting all' : 'Stopping all');
    }
    refresh();
  } catch (e) { toast(e.message || 'Bulk action failed', true); }
}

async function runVm(id, op) {
  const s = activeServer();
  const v = s && (s.vms || []).find(x => x.id === id);
  if (!await confirmAction((op === 'start' ? 'Start' : 'Stop') + ' VM', (op === 'start' ? 'Start' : 'Stop') + ' "' + (v ? v.name : id) + '"?', op === 'stop')) return;
  try { await apiCall('vm', { server: state.active, id, op }); toast('Done'); refresh(); }
  catch (e) { toast(e.message || 'VM action failed', true); }
}

async function runParity(op) {
  const labels = { start: 'Start parity check', pause: 'Pause parity check', resume: 'Resume parity check', cancel: 'Cancel parity check' };
  if (!await confirmAction(labels[op] || 'Parity', (labels[op] || 'Parity') + '?', op === 'cancel')) return;
  try { await apiCall('parity', { server: state.active, op }); toast('Done'); refresh(); }
  catch (e) { toast(e.message || 'Parity action failed', true); }
}

async function openWeb() {
  try { await apiCall('open', { server: state.active }); }
  catch (e) { toast(e.message || 'Could not open', true); }
}

async function openLogs(id) {
  const s = activeServer();
  const c = s && (s.containers || []).find(x => x.id === id);
  if (!c) return;
  try { await apiCall('open', { server: state.active, log: c.name }); }
  catch (e) { toast(e.message || 'Could not open', true); }
}

// ── toast ──────────────────────────────────────────────────────────────────────────
let toastTimer = null;
function toast(msg, isError) {
  let el = $('#toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'toast';
    el.style.cssText = 'position:absolute;left:50%;bottom:24px;transform:translateX(-50%);z-index:50;padding:14px 24px;border-radius:12px;font-size:19px;font-weight:600;max-width:80%;text-align:center;';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.background = isError ? 'var(--error)' : 'var(--raised)';
  el.style.color = isError ? '#fff' : 'var(--ink)';
  el.style.display = 'block';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.style.display = 'none'; }, isError ? 5000 : 2500);
}

// ── custom finger scrollbar (from arr-dash) ─────────────────────────────────────────
function syncScrollbar(listSel, barSel, thumbSel) {
  const list = $(listSel), bar = $(barSel), thumb = $(thumbSel);
  if (!list || !bar || !thumb) return;
  const overflow = list.scrollHeight - list.clientHeight;
  bar.hidden = overflow <= 4;
  if (bar.hidden) return;
  const track = bar.clientHeight;
  const size = Math.max(64, track * list.clientHeight / list.scrollHeight);
  thumb.style.height = size + 'px';
  thumb.style.top = (list.scrollTop / overflow * (track - size)) + 'px';
}
function wireScrollbar(listSel, barSel, thumbSel) {
  const list = $(listSel), bar = $(barSel), thumb = $(thumbSel);
  if (!list) return;
  list.addEventListener('scroll', () => syncScrollbar(listSel, barSel, thumbSel), { passive: true });
  window.addEventListener('resize', () => syncScrollbar(listSel, barSel, thumbSel));
  let startY = null, startScroll = 0;
  thumb.addEventListener('pointerdown', e => { startY = e.clientY; startScroll = list.scrollTop; thumb.setPointerCapture(e.pointerId); e.preventDefault(); });
  thumb.addEventListener('pointermove', e => {
    if (startY == null) return;
    const track = bar.clientHeight - thumb.clientHeight;
    if (track <= 0) return;
    list.scrollTop = startScroll + (e.clientY - startY) / track * (list.scrollHeight - list.clientHeight);
  });
  const end = () => { startY = null; };
  thumb.addEventListener('pointerup', end);
  thumb.addEventListener('pointercancel', end);
  bar.addEventListener('pointerdown', e => {
    if (e.target === thumb) return;
    const rect = thumb.getBoundingClientRect();
    list.scrollTop += (e.clientY < rect.top ? -1 : 1) * list.clientHeight * 0.9;
  });
}

// ── knob ─────────────────────────────────────────────────────────────────────────
function activeScroll() {
  if (!$('#overlay').hidden) return $('#panel');
  if (state.tab === 'docker') return $('#dlist');
  return $('#view').querySelector('.scroll');
}
window.oqKnob = function (ev) {
  if (!ev) return;
  if (ev.type === 'rotate') {
    const el = activeScroll();
    if (el) { el.scrollTop += ev.dir * 90; el.dispatchEvent(new Event('scroll')); }
  } else if (ev.type === 'press' && ev.index === 2) {
    if (!$('#overlay').hidden) closeOverlay();
  }
};

// ── static wiring ────────────────────────────────────────────────────────────────
$('#rail').addEventListener('click', e => {
  const b = e.target.closest('.srv[data-slot]');
  if (!b) return;
  const slot = parseInt(b.dataset.slot, 10);
  if (slot === state.active) return;
  state.active = slot;
  state.dockerBuilt = false;
  render();
  apiCall('summary', { active: slot }).then(p => { state.servers = p.servers || []; render(); }).catch(() => {});
});
$('#tabs').addEventListener('click', e => {
  const b = e.target.closest('.tab[data-tab]');
  if (!b || b.dataset.tab === state.tab) return;
  state.tab = b.dataset.tab;
  render();
});

// ── self-reload on version bump ─────────────────────────────────────────────────
setInterval(async () => {
  try {
    const m = await (await fetch('app.json', { cache: 'no-store' })).json();
    if (m.version && m.version !== RUNNING_VERSION) location.reload();
  } catch (e) {}
}, 30000);

applyTheme();
refresh();

'use strict';

const query = new URLSearchParams(location.search);
const refreshSeconds = Math.max(10, Math.min(120, parseInt(query.get('refreshSeconds'), 10) || 30));

const $ = selector => document.querySelector(selector);

function applyTheme() {
  document.documentElement.dataset.theme = query.get('_dark') === '0' ? 'light' : 'dark';
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function formatWhen(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dayMs = 24 * 3600 * 1000;
  if (date.toDateString() === now.toDateString()) return 'Today ' + time;
  const yesterday = new Date(now.getTime() - dayMs);
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday ' + time;
  const tomorrow = new Date(now.getTime() + dayMs);
  if (date.toDateString() === tomorrow.toDateString()) return 'Tomorrow ' + time;
  const days = Math.round(Math.abs(now - date) / dayMs);
  if (date < now) return days + ' days ago';
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
}

// Duplicati durations look like "00:04:12.1234567" (or "1.02:03:04" with days)
function formatDuration(value) {
  if (!value) return '';
  const m = /^(?:(\d+)\.)?(\d+):(\d\d):(\d\d)/.exec(value);
  if (!m) return '';
  const hours = (parseInt(m[1] || 0, 10) * 24) + parseInt(m[2], 10);
  const minutes = parseInt(m[3], 10);
  if (hours) return hours + ' h ' + minutes + ' min';
  if (minutes) return minutes + ' min';
  return '< 1 min';
}

// "Backup_ProcessingFiles" → "Processing Files"
function formatPhase(phase) {
  if (!phase) return '';
  return String(phase).replace(/^[^_]*_/, '').replace(/([a-z])([A-Z])/g, '$1 $2');
}

function formatSpeed(bytesPerSec) {
  if (!bytesPerSec) return '';
  if (bytesPerSec >= 1024 * 1024) return (bytesPerSec / (1024 * 1024)).toFixed(1) + ' MB/s';
  return Math.round(bytesPerSec / 1024) + ' KB/s';
}

// ── Rows ─────────────────────────────────────────────────────────────────────
function jobRow(job, state) {
  const running = state.activeBackupId === job.id;
  let cols;
  if (running) {
    cols = '<span class="col last"><span class="run-tag">Running&#8230;</span><span class="k">' + esc(formatPhase(state.phase) || 'in progress') + '</span></span>'
      + sizeCol(job) + verCol(job)
      + '<span class="col next"><span class="v">&#8212;</span><span class="k">in progress</span></span>';
  } else if (job.status === 'error') {
    cols = '<span class="col msgcol"><span class="v msg">Failed: ' + esc(job.lastError || 'see Duplicati log') + '</span>'
      + '<span class="k">' + (job.lastRun ? 'last success ' + esc(formatWhen(job.lastRun)) : 'no successful run recorded') + '</span></span>'
      + nextCol(job);
  } else if (job.status === 'never') {
    cols = '<span class="col last"><span class="v dim">Never ran</span></span>'
      + '<span class="col size"><span class="v">&#8212;</span></span>' + verCol(job) + nextCol(job);
  } else {
    const warn = job.warningCount ? ' &#183; ' + job.warningCount + ' warning' + (job.warningCount === 1 ? '' : 's') : '';
    cols = '<span class="col last"><span class="v">' + esc(formatWhen(job.lastRun)) + '</span>'
      + '<span class="k">' + esc(formatDuration(job.duration)) + warn + '</span></span>'
      + sizeCol(job) + verCol(job) + nextCol(job);
  }
  return '<div class="bk"><span class="dot ' + job.status + '"></span>'
    + '<span class="nm">' + esc(job.name) + '</span>' + cols + '</div>';
}

function sizeCol(job) {
  const value = job.sourceSize && job.targetSize ? esc(job.sourceSize) + ' &#8594; ' + esc(job.targetSize) : '&#8212;';
  return '<span class="col size"><span class="v">' + value + '</span><span class="k">source &#8594; backup</span></span>';
}
function verCol(job) {
  return '<span class="col ver"><span class="v">' + (job.versions || 0) + '</span><span class="k">versions</span></span>';
}
function nextCol(job) {
  return '<span class="col next"><span class="v">' + (job.nextRun ? esc(formatWhen(job.nextRun)) : 'unscheduled') + '</span><span class="k">next run</span></span>';
}

// ── Right column ─────────────────────────────────────────────────────────────
function stateHtml(state) {
  if (state.activeBackupId) {
    const bits = [formatPhase(state.phase), formatSpeed(state.speed), state.progress != null ? state.progress + '%' : null]
      .filter(Boolean).join(' &#183; ');
    const bar = state.progress != null
      ? '<div class="bar"><i style="width:' + Math.max(0, Math.min(100, state.progress)) + '%"></i></div>' : '';
    return '<div class="big run">Running: ' + esc(state.activeName || 'backup') + '</div>'
      + '<div class="sub">' + (bits || 'in progress') + '</div>' + bar;
  }
  if (state.paused) return '<div class="big paused">Paused</div><div class="sub">Scheduler paused in Duplicati</div>';
  return '<div class="big ok">Ready</div><div class="sub">No backup running &#183; scheduler active</div>';
}

function tallyHtml(jobs) {
  const count = status => jobs.filter(j => j.status === status).length;
  return '<div class="pill"><div class="n g">' + count('ok') + '</div><div class="t">OK</div></div>'
    + '<div class="pill"><div class="n y">' + count('warning') + '</div><div class="t">Warnings</div></div>'
    + '<div class="pill"><div class="n r">' + count('error') + '</div><div class="t">Failed</div></div>'
    + '<div class="pill"><div class="n m">' + count('never') + '</div><div class="t">Never ran</div></div>';
}

function notifsHtml(notifications) {
  if (!notifications || !notifications.length) return '<div class="notif-none">None</div>';
  return notifications.map(n =>
    '<div class="notif ' + esc(n.type) + '"><b>' + esc(n.backup) + '</b>' + esc(n.message) + '</div>'
  ).join('');
}

// ── Render ───────────────────────────────────────────────────────────────────
function render(payload) {
  if (!payload.configured) {
    $('#bk-heading').textContent = 'Backups';
    $('#bk-list').innerHTML = '<div class="empty">Set the Duplicati URL and password in this app’s options.</div>';
    $('#state').innerHTML = '<div class="big down">Not configured</div>';
    $('#tally').innerHTML = '';
    $('#notifs').innerHTML = '<div class="notif-none">None</div>';
    return;
  }
  const jobs = payload.backups || [];
  $('#bk-heading').textContent = 'Backups · ' + jobs.length;
  $('#bk-list').innerHTML = jobs.length
    ? jobs.map(job => jobRow(job, payload.state)).join('')
    : '<div class="empty">No backups defined on this server.</div>';
  $('#state').innerHTML = stateHtml(payload.state);
  $('#tally').innerHTML = tallyHtml(jobs);
  $('#notifs').innerHTML = notifsHtml(payload.notifications);
  syncScrollbar();
}

function renderDown(message) {
  $('#state').innerHTML = '<div class="big down">Unreachable</div><div class="sub">' + esc(message) + '</div>';
}

// ── Custom finger scrollbar (arr-dash pattern) ───────────────────────────────
function syncScrollbar() {
  const list = $('#bk-list');
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
  const list = $('#bk-list');
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
    const payload = await fetchSummary();
    render(payload);
  } catch (error) {
    renderDown(error.message || 'Refresh failed');
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

$('#open-web').addEventListener('click', async () => {
  try {
    const response = await fetch('/app-api/open', { cache: 'no-store' });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload.ok === false) throw new Error(payload.error || 'Could not open');
  } catch (error) {
    renderDown(error.message || 'Could not open');
  }
});

applyTheme();
wireScrollbar();
refresh();

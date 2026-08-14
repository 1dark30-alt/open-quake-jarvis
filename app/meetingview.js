function $(id) { return document.getElementById(id); }

// theme + options — host passes _dark=1/0, _accent=#hex, defaultPlatform=zoom|teams.
var Q = new URLSearchParams(location.search);
var QUERY_DEFAULT_PLATFORM = 'zoom';
(function () {
  try {
    document.body.classList.toggle('light', Q.get('_dark') === '0');
    var a = Q.get('_accent') || '';
    if (/^#[0-9a-fA-F]{6}$/.test(a)) document.documentElement.style.setProperty('--accent', a);
    // contrast-safe foreground for anything sitting on the accent (runtime accents vary):
    // relative luminance decides dark-on-accent vs light-on-accent.
    var hex = /^#[0-9a-fA-F]{6}$/.test(a) ? a : '#7CFFB2';
    var r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.style.setProperty('--accent-fg', lum > 0.45 ? '#04121f' : '#f2f7fc');
    var dp = Q.get('defaultPlatform');
    if (dp === 'zoom' || dp === 'teams') QUERY_DEFAULT_PLATFORM = dp;
  } catch (e) {}
})();

var ICON = {
  mic:    '<svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 0 0-6 0v5a3 3 0 0 0 3 3z"/><path d="M17 11a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11z"/></svg>',
  camera: '<svg viewBox="0 0 24 24"><path d="M4 6h11a2 2 0 0 1 2 2v1.5l4-2.5v10l-4-2.5V16a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2z"/></svg>',
  phone:  '<svg viewBox="0 0 24 24"><path d="M6.6 10.8c1.4 2.8 3.8 5.2 6.6 6.6l2.2-2.2c.3-.3.7-.4 1-.2 1.1.4 2.3.6 3.6.6.6 0 1 .4 1 1V20c0 .6-.4 1-1 1C10.6 21 3 13.4 3 4c0-.6.4-1 1-1h3.5c.6 0 1 .4 1 1 0 1.3.2 2.5.6 3.6.1.4 0 .8-.2 1z"/></svg>',
  exit:   '<svg viewBox="0 0 24 24"><path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5v-2H5V5h5V3z"/><path d="M17.7 12l-3.6-3.6L15.5 7l6 5-6 5-1.4-1.4 3.6-3.6H8v-2z"/></svg>',
  plus:   '<svg viewBox="0 0 24 24"><path d="M11 5h2v6h6v2h-6v6h-2v-6H5v-2h6z"/></svg>',
  minus:  '<svg viewBox="0 0 24 24"><path d="M5 11h14v2H5z"/></svg>',
  open:   '<svg viewBox="0 0 24 24"><path d="M14 3v2h3.6l-9 9 1.4 1.4 9-9V10h2V3h-7zM5 5h5V3H3v18h18v-7h-2v5H5V5z"/></svg>',
  speaker:'<svg viewBox="0 0 24 24"><path d="M3 10v4h4l5 5V5L7 10H3zm13.5 2a4.5 4.5 0 0 0-2.5-4v8a4.5 4.5 0 0 0 2.5-4zm-2.5-8.8v2.1a7 7 0 0 1 0 13.4v2.1a9 9 0 0 0 0-17.6z"/></svg>',
  share:  '<svg viewBox="0 0 24 24"><path d="M4 5h16a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-6v2h2v2H8v-2h2v-2H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zm8 3l-4 4h2.5v3h3v-3H16l-4-4z"/></svg>',
  fullscreen:'<svg viewBox="0 0 24 24"><path d="M4 4h6v2H6v4H4V4zm10 0h6v6h-2V6h-4V4zM6 14v4h4v2H4v-6h2zm14 0v6h-6v-2h4v-4h2z"/></svg>',
};

// AUDIO & VIDEO controls are constant. CALL controls are per-platform. cls drives the semantic
// treatment: accept = green ring/icon, decline = red ring/icon, end = the one solid-red button.
var AV = [
  { action: 'mute',  icon: 'mic',    label: 'Mute' },
  { action: 'video', icon: 'camera', label: 'Camera' },
];
var CALL = {
  zoom: [
    { action: 'accept',  icon: 'phone',  label: 'Accept',  cls: 'accept' },
    { action: 'decline', icon: 'phone',  label: 'Decline', cls: 'decline', rot: true },
    { action: 'leave',   icon: 'phone',  label: 'Leave',   cls: 'end',     rot: true },
  ],
  teams: [
    { action: 'acceptAudio', icon: 'phone',  label: 'Accept audio', cls: 'accept' },
    { action: 'acceptVideo', icon: 'camera', label: 'Accept video', cls: 'accept' },
    { action: 'decline',     icon: 'phone',  label: 'Decline',      cls: 'decline', rot: true },
    { action: 'hangup',      icon: 'phone',  label: 'Hang up',      cls: 'end',     rot: true },
  ],
};
var PLATFORM_LABEL = { zoom: 'Zoom', teams: 'Teams' };
var platform = CALL[QUERY_DEFAULT_PLATFORM] ? QUERY_DEFAULT_PLATFORM : 'zoom';

// ---- status (readiness / real outcomes only; never a filename) ----
var statusT = null;
function statusReady() { var el = $('status'); el.textContent = PLATFORM_LABEL[platform] + ' ready'; el.style.color = 'var(--dim)'; }
function statusShow(msg, isError) {
  var el = $('status');
  el.textContent = msg;
  el.style.color = isError ? 'var(--danger)' : 'var(--dim)';
  clearTimeout(statusT);
  statusT = setTimeout(statusReady, 3000);
}
function fireAction(plat, action, label) {
  return fetch('/meeting-action/' + encodeURIComponent(plat) + '/' + encodeURIComponent(action), { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (r) {
      if (r && r.ok) statusShow('Sent: ' + label); else statusShow((r && r.error) || 'Failed: ' + label, true);
      return r;
    })
    .catch(function () { statusShow('Request failed', true); });
}

// ---- deck ----
function buildCtl(a) {
  var b = document.createElement('button');
  b.type = 'button';
  b.className = 'ctl press foc' + (a.cls ? ' ' + a.cls : '') + (a.rot ? ' rot' : '');
  b.innerHTML = '<span class="btn"><span class="ic">' + ICON[a.icon] + '</span></span><span class="lab">' + a.label + '</span>';
  b.onclick = function () { fireAction(platform, a.action, a.label); };
  return b;
}
function renderDeck() {
  var av = $('avRow'); av.innerHTML = ''; AV.forEach(function (a) { av.appendChild(buildCtl(a)); });
  var call = $('callRow'); call.innerHTML = ''; (CALL[platform] || []).forEach(function (a) { call.appendChild(buildCtl(a)); });
  document.querySelectorAll('.seg').forEach(function (b) { b.classList.toggle('active', b.dataset.platform === platform); });
}
document.querySelectorAll('.seg').forEach(function (b) {
  b.onclick = function () { platform = b.dataset.platform; renderDeck(); statusReady(); };
});

// ---- utility rail ----
$('volDown').innerHTML = '<span class="ic">' + ICON.minus + '</span>';
$('volUp').innerHTML = '<span class="ic">' + ICON.plus + '</span>';
$('ic-full').innerHTML = ICON.fullscreen;
$('ic-share').innerHTML = ICON.share;
$('volDown').onclick = function () { fireAction('system', 'voldown', 'Volume down').then(pollState); };
$('volUp').onclick = function () { fireAction('system', 'volup', 'Volume up').then(pollState); };
$('fullscreen').onclick = function () { fireAction(platform, 'fullscreen', 'Full screen'); };
$('shareScreen').onclick = function () { fireAction(platform, 'share', 'Share screen'); };

// =====================================================================================
// Recording — remote for the hidden recorder window owned by main. Record opens a popover;
// once recording starts the popover collapses to a header pill. Filenames live only in the
// popover's recording details, never in the header status.
// =====================================================================================
var wrap = $('wrap');
var recHost = $('recHost');
recHost.innerHTML =
  '<button id="recToggle" class="press foc" type="button"><span class="dot"></span>Record</button>' +
  '<div id="pill" style="display:none"><span class="dot"></span><span class="txt">Recording</span>' +
  '<span class="t" id="pillDur">00:00</span>' +
  '<button class="stop press foc" id="pillStop" type="button"><span class="sq"></span>Stop</button></div>';

var drawerManual = false;
var curState = { recording: false, startedAt: null, mic: '', file: null, volume: null };
var micInitialized = false;

function fmtDur(ms) {
  var t = Math.max(0, Math.floor(ms / 1000));
  var h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  var mm = (m < 10 ? '0' : '') + m, ss = (s < 10 ? '0' : '') + s;
  return h > 0 ? (h + ':' + mm + ':' + ss) : (mm + ':' + ss);
}
function tick() {
  if (curState.recording && curState.startedAt) $('pillDur').textContent = fmtDur(Date.now() - curState.startedAt);
}
function applyState(st) {
  curState = st || curState;
  if (!micInitialized) { savedMicLabel = curState.mic || ''; micInitialized = true; syncMic(); }
  var live = !!curState.recording;
  // volume level (real, from main; when unreadable show a calm "System volume" label, no meter)
  var v = curState.volume;
  var known = (v != null);
  if (known) $('volPct').textContent = Math.round(v) + '%';
  else $('volPct').innerHTML = '<span class="ic">' + ICON.speaker + '</span>';   // centered icon, no awkward wrap
  $('volPct').classList.toggle('unknown', !known);
  $('volTrack').style.display = known ? '' : 'none';
  $('volFill').style.width = (known ? Math.max(0, Math.min(100, v)) : 0) + '%';
  // header: Record button vs live pill
  $('recToggle').style.display = live ? 'none' : 'flex';
  $('pill').style.display = live ? 'flex' : 'none';
  // popover open + mode
  wrap.classList.toggle('drawer-open', drawerManual);
  $('recPanel').classList.toggle('details', live);
  $('recFile').textContent = curState.file ? ('Saving ' + curState.file) : ' ';
  tick();
}
function pollState() {
  return fetch('/meeting-state', { cache: 'no-store' }).then(function (r) { return r.json(); })
    .then(function (st) { applyState(st); }).catch(function () {});
}
recHost.querySelector('#recToggle').onclick = function () { drawerManual = true; applyState(curState); };
$('recClose').onclick = function () { drawerManual = false; applyState(curState); };
$('pill').onclick = function (e) { if (e.target.closest('#pillStop')) return; drawerManual = true; applyState(curState); };
$('pillStop').onclick = function () { doStop(); };
$('recStopBig').onclick = function () { doStop(); };
$('recStart').onclick = function () {
  fetch('/meeting-record/start', { cache: 'no-store' }).then(function (r) { return r.json(); })
    .then(function (r) { if (r && r.error) statusShow(r.error, true); drawerManual = false; if (r && r.state) applyState(r.state); pollState(); })
    .catch(function () { statusShow('Could not start recording', true); });
};
function doStop() {
  fetch('/meeting-record/stop', { cache: 'no-store' }).then(function (r) { return r.json(); })
    .then(function (r) { drawerManual = false; if (r && r.state) applyState(r.state); pollState(); })
    .catch(function () { statusShow('Could not stop recording', true); });
}

// ---- microphone picker (label-based; full-screen overlay) ----
var savedMicLabel = '';
var allDevices = [];
function syncMic() { $('micVal').textContent = savedMicLabel || 'System default'; }
function ensureDeviceIds() {
  return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (tmp) {
    return navigator.mediaDevices.enumerateDevices().then(function (devs) {
      tmp.getTracks().forEach(function (t) { t.stop(); });
      allDevices = devs || [];
    });
  }).catch(function () { allDevices = []; });
}
function renderDevList() {
  var el = $('devList'); el.innerHTML = '';
  function addRow(label, value, current) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'devRow foc' + (current ? ' current' : '');
    b.textContent = label; b.title = label;
    b.onclick = function () { pickMic(value); };
    el.appendChild(b);
  }
  var devs = allDevices.filter(function (d) { return d.kind === 'audioinput' && d.label; });
  var matched = !!savedMicLabel && devs.some(function (d) { return d.label === savedMicLabel; });
  addRow('System default', '', !matched);
  devs.forEach(function (d) { addRow(d.label, d.label, matched && d.label === savedMicLabel); });
}
$('micRow').onclick = function () { renderDevList(); $('devOverlay').classList.add('show'); ensureDeviceIds().then(renderDevList); };
$('devCancel').onclick = function () { $('devOverlay').classList.remove('show'); };
function pickMic(label) {
  $('devOverlay').classList.remove('show');
  savedMicLabel = label || ''; syncMic();
  fetch('/meeting-set-mic/' + encodeURIComponent(savedMicLabel), { cache: 'no-store' })
    .then(function (r) { return r.json(); }).then(function (r) { if (r && r.state) applyState(r.state); })
    .catch(function () { statusShow('Could not set microphone', true); });
}

renderDeck();
statusReady();
syncMic();
$('volPct').innerHTML = '<span class="ic">' + ICON.speaker + '</span>';   // boot state: volume not yet read
pollState();
setInterval(function () { tick(); pollState(); }, 1000);

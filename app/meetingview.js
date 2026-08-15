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
  gear:   '<svg viewBox="0 0 24 24"><path d="M19.4 13c.04-.33.07-.66.07-1s-.03-.67-.07-1l2.11-1.65a.5.5 0 0 0 .12-.64l-2-3.46a.5.5 0 0 0-.61-.22l-2.49 1a7.03 7.03 0 0 0-1.73-1l-.38-2.65A.5.5 0 0 0 13.93 2h-4a.5.5 0 0 0-.5.43l-.37 2.65c-.63.26-1.21.6-1.74 1l-2.49-1a.5.5 0 0 0-.6.22l-2 3.46c-.13.22-.08.5.12.64L4.46 11c-.04.33-.07.66-.07 1s.03.67.07 1l-2.11 1.65a.5.5 0 0 0-.12.64l2 3.46c.12.22.38.31.6.22l2.49-1c.53.4 1.11.74 1.74 1l.37 2.65c.05.24.25.43.5.43h4c.25 0 .46-.19.5-.43l.37-2.65c.63-.26 1.21-.6 1.73-1l2.49 1c.23.09.49 0 .61-.22l2-3.46a.5.5 0 0 0-.12-.64L19.4 13zM11.93 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z"/></svg>',
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
$('ic-settings').innerHTML = ICON.gear;
$('ic-share').innerHTML = ICON.share;
$('volDown').onclick = function () { fireAction('system', 'voldown', 'Volume down').then(pollState); };
$('volUp').onclick = function () { fireAction('system', 'volup', 'Volume up').then(pollState); };
$('settingsRow').onclick = function () { openMicPicker(); };
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
// Shared by the popover's Microphone row and the rail's Settings row — the picker IS the panel's
// settings window (the only panel-side setting is which mic gets recorded).
function openMicPicker() { renderDevList(); $('devOverlay').classList.add('show'); ensureDeviceIds().then(renderDevList); }
$('micRow').onclick = function () { openMicPicker(); };
$('devCancel').onclick = function () { $('devOverlay').classList.remove('show'); };
function pickMic(label) {
  $('devOverlay').classList.remove('show');
  savedMicLabel = label || ''; syncMic();
  fetch('/meeting-set-mic/' + encodeURIComponent(savedMicLabel), { cache: 'no-store' })
    .then(function (r) { return r.json(); }).then(function (r) { if (r && r.state) applyState(r.state); })
    .catch(function () { statusShow('Could not set microphone', true); });
}

// =====================================================================================
// Library / Transcription / Analysis overlays — full-screen, same pattern as the mic picker.
// The transcription and analysis pollers run ONLY while their overlay is on screen.
// =====================================================================================
function escHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function fmtSize(b) { return b >= 1048576 ? (b / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(b / 1024)) + ' KB'; }
function fetchJson(url) { return fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); }); }
function fileMeta(f) {
  var sub = (f.durationMs != null ? fmtDur(f.durationMs) + ' · ' : '') + fmtSize(f.size);
  var meta = document.createElement('div'); meta.className = 'meta';
  meta.innerHTML = '<div class="fname">' + escHtml(f.name) + '</div><div class="fsub">' + escHtml(sub) + '</div>';
  return meta;
}
function rowBtn(label, extraCls) {
  var b = document.createElement('button');
  b.type = 'button'; b.className = 'rowBtn press foc' + (extraCls ? ' ' + extraCls : '');
  b.textContent = label;
  return b;
}
// ---- shared multi-select (Select all / <action> selected in each overlay header) ----
function selMake(allId, actId) {
  var sel = { set: {}, names: [], boxes: {}, allBtn: $(allId), actBtn: $(actId) };
  sel.allBtn.onclick = function () {
    var all = sel.names.length && selCount(sel) === sel.names.length;
    sel.set = {};
    if (!all) sel.names.forEach(function (n) { sel.set[n] = true; });
    selSync(sel);
  };
  return sel;
}
function selCount(sel) { return Object.keys(sel.set).length; }
function selNames(sel) { return Object.keys(sel.set); }
function selSync(sel) {
  sel.names.forEach(function (n) {
    var b = sel.boxes[n];
    if (b) { b.classList.toggle('on', !!sel.set[n]); b.textContent = sel.set[n] ? '✓' : ''; }
  });
  sel.allBtn.textContent = (sel.names.length && selCount(sel) === sel.names.length) ? 'Clear all' : 'Select all';
  if (!sel.actBtn.classList.contains('confirm')) sel.actBtn.disabled = !selCount(sel);
}
// Reset for a fresh render: keep selections for names still present, drop the rest.
function selReset(sel, names) {
  var kept = {};
  names.forEach(function (n) { if (sel.set[n]) kept[n] = true; });
  sel.set = kept; sel.names = names; sel.boxes = {};
}
function selBox(sel, name) {
  var b = document.createElement('button');
  b.type = 'button'; b.className = 'selBox press foc';
  b.onclick = function () {
    if (sel.set[name]) delete sel.set[name]; else sel.set[name] = true;
    selSync(sel);
  };
  sel.boxes[name] = b;
  return b;
}
// Processed names may carry the Organize-by-date prefix (2026/08/x.json) — show the filename big
// and the folder in the sub line.
function splitRel(name) {
  var i = name.lastIndexOf('/');
  return { base: i < 0 ? name : name.slice(i + 1), folder: i < 0 ? '' : name.slice(0, i) };
}
// ▲/▼ page buttons for scroll regions — tap = one page, hold = keeps paging (claudevoiceview pattern;
// drag-thumbs are unreliable on the physical panel).
function wireScrollButtons(listId, upId, downId) {
  var list = $(listId);
  function step(dir) { list.scrollBy({ top: dir * list.clientHeight * 0.9, behavior: 'smooth' }); }
  [[upId, -1], [downId, 1]].forEach(function (pair) {
    var btn = $(pair[0]);
    var repeat = null;
    btn.addEventListener('pointerdown', function (e) {
      btn.setPointerCapture(e.pointerId);
      step(pair[1]);
      repeat = setInterval(function () { step(pair[1]); }, 400);
    });
    ['pointerup', 'pointercancel'].forEach(function (ev) {
      btn.addEventListener(ev, function () { clearInterval(repeat); repeat = null; });
    });
  });
}

// ---- Unprocessed: list / play / delete ----
var libAudio = $('libAudio');
var libPlaying = '';        // name whose audio is loaded
var libSyncs = [];          // per-row repaint hooks, rebuilt on each render
function libSyncAll() { libSyncs.forEach(function (fn) { fn(); }); }
libAudio.onplay = libSyncAll; libAudio.onpause = libSyncAll;
libAudio.onended = function () { libPlaying = ''; libAudio.removeAttribute('src'); libSyncAll(); };
function stopPlayback() { try { libAudio.pause(); } catch (e) {} libPlaying = ''; libAudio.removeAttribute('src'); }
function libMsg(msg, isError) { var n = $('libNote'); n.textContent = msg || ''; n.classList.toggle('err', !!isError); }
var libSel = selMake('libSelAll', 'libDelSel');
function renderLibrary() {
  fetchJson('/meeting-files?kind=unprocessed').then(function (r) {
    var el = $('libList'); el.innerHTML = ''; libSyncs = [];
    var files = ((r && r.files) || []).filter(function (f) { return /\.wav$/i.test(f.name); });
    libMsg(files.length ? files.length + ' recording' + (files.length === 1 ? '' : 's') : '');
    selReset(libSel, files.map(function (f) { return f.name; }));
    if (!files.length) { el.innerHTML = '<div class="ovEmpty">No unprocessed recordings.</div>'; selSync(libSel); return; }
    files.forEach(function (f) { el.appendChild(buildLibRow(f)); });
    selSync(libSel);
  }).catch(function () { libMsg('Could not load recordings', true); });
}
function buildLibRow(f) {
  var row = document.createElement('div'); row.className = 'fileRow';
  row.appendChild(selBox(libSel, f.name));
  row.appendChild(fileMeta(f));
  var play = rowBtn('Play');
  play.onclick = function () {
    if (libPlaying === f.name) {
      if (libAudio.paused) libAudio.play().catch(function () { libMsg('Playback failed', true); });
      else libAudio.pause();
    } else {
      libPlaying = f.name;
      libAudio.src = '/meeting-audio?kind=unprocessed&name=' + encodeURIComponent(f.name);
      libAudio.play().catch(function () { libPlaying = ''; libMsg('Playback failed', true); libSyncAll(); });
    }
    libSyncAll();
  };
  var del = rowBtn('Delete', 'danger');
  var confirmT = null;
  del.onclick = function () {
    if (!del.classList.contains('confirm')) {   // two-tap confirm: first tap arms for 3 s
      del.classList.add('confirm'); del.textContent = 'Confirm?';
      confirmT = setTimeout(function () { del.classList.remove('confirm'); del.textContent = 'Delete'; }, 3000);
      return;
    }
    clearTimeout(confirmT);
    if (libPlaying === f.name) stopPlayback();
    fetchJson('/meeting-file-delete?kind=unprocessed&name=' + encodeURIComponent(f.name))
      .then(function (r) {
        if (r && r.ok) { libMsg('Deleted ' + f.name); renderLibrary(); }
        else libMsg((r && r.error) || 'Delete failed', true);
      })
      .catch(function () { libMsg('Delete failed', true); });
  };
  libSyncs.push(function () {
    row.classList.toggle('playing', libPlaying === f.name);
    play.textContent = (libPlaying === f.name && !libAudio.paused) ? 'Pause' : 'Play';
  });
  row.appendChild(play); row.appendChild(del);
  return row;
}
var libDelT = null;
$('libDelSel').onclick = function () {
  var btn = $('libDelSel');
  var names = selNames(libSel);
  if (!names.length) return;
  if (!btn.classList.contains('confirm')) {   // two-tap confirm, same as the per-row Delete
    btn.classList.add('confirm'); btn.textContent = 'Confirm delete ' + names.length + '?';
    clearTimeout(libDelT);
    libDelT = setTimeout(function () { btn.classList.remove('confirm'); btn.textContent = 'Delete selected'; selSync(libSel); }, 3000);
    return;
  }
  clearTimeout(libDelT); btn.classList.remove('confirm'); btn.textContent = 'Delete selected';
  if (names.indexOf(libPlaying) >= 0) stopPlayback();
  Promise.all(names.map(function (n) {
    return fetchJson('/meeting-file-delete?kind=unprocessed&name=' + encodeURIComponent(n)).catch(function () { return { ok: false }; });
  })).then(function (rs) {
    var fails = rs.filter(function (r) { return !(r && r.ok); }).length;
    libSel.set = {};
    renderLibrary();
    libMsg(fails ? (names.length - fails) + ' deleted, ' + fails + ' failed' : 'Deleted ' + names.length + ' recording' + (names.length === 1 ? '' : 's'), !!fails);
  });
};
$('btnUnprocessed').onclick = function () { $('libOverlay').classList.add('show'); renderLibrary(); };
$('libClose').onclick = function () { $('libOverlay').classList.remove('show'); stopPlayback(); };

// ---- Transcription: queue WAVs to the diarizer, watch honest progress (elapsed only) ----
var txTimer = null, txState = null, txLastFinished = 0;
var txRows = {};            // name -> { btn, sub }
function txPoll() {
  fetchJson('/meeting-transcribe/state').then(function (st) {
    txState = st;
    var n = $('txNote');
    if (st.health === 'ok') { n.textContent = 'Server connected'; n.classList.remove('err'); }
    else if (st.health === 'down') { n.textContent = 'Transcription server unreachable'; n.classList.add('err'); }
    else { n.textContent = ''; n.classList.remove('err'); }
    var s = $('txStatus');
    var queued = (st.queue || []).length;
    if (st.current) {
      s.innerHTML = 'Transcribing ' + escHtml(st.current.name) + ' — <span class="t">' + fmtDur(Date.now() - st.current.startedAt) + '</span>' +
        '&nbsp;&nbsp;(takes about ⅓ of the recording length)' + (queued ? ' · ' + queued + ' queued' : '');
    } else {
      s.textContent = queued ? queued + ' queued' : 'Idle — tap Transcribe on a recording below';
    }
    // a finished job moves files — refresh the list once per completion, not every second
    var fin = (st.recent && st.recent.length) ? st.recent[0].finishedAt : 0;
    if (fin && fin !== txLastFinished) { txLastFinished = fin; renderTxList(); }
    else updateTxButtons();
  }).catch(function () {});
}
var txSel = selMake('txSelAll', 'txGoSel');
function renderTxList() {
  fetchJson('/meeting-files?kind=unprocessed').then(function (r) {
    var el = $('txList'); el.innerHTML = ''; txRows = {};
    var files = ((r && r.files) || []).filter(function (f) { return /\.wav$/i.test(f.name); });
    selReset(txSel, files.map(function (f) { return f.name; }));
    if (!files.length) { el.innerHTML = '<div class="ovEmpty">Nothing to transcribe — new recordings land here.</div>'; selSync(txSel); return; }
    files.forEach(function (f) {
      var row = document.createElement('div'); row.className = 'fileRow';
      row.appendChild(selBox(txSel, f.name));
      var meta = fileMeta(f);
      var btn = rowBtn('Transcribe', 'primary');
      btn.onclick = function () {
        btn.disabled = true;
        fetchJson('/meeting-transcribe/start?name=' + encodeURIComponent(f.name))
          .then(function (r2) {
            if (r2 && r2.ok === false) { setSub(r2.error || 'Could not queue', true); btn.disabled = false; }
            txPoll();
          })
          .catch(function () { setSub('Could not queue', true); btn.disabled = false; });
      };
      function setSub(msg, isError) { var s2 = meta.querySelector('.fsub'); s2.textContent = msg; s2.classList.toggle('err', !!isError); }
      row.appendChild(meta); row.appendChild(btn);
      txRows[f.name] = { btn: btn, sub: meta.querySelector('.fsub') };
      el.appendChild(row);
    });
    updateTxButtons();
    selSync(txSel);
  }).catch(function () {});
}
$('txGoSel').onclick = function () {
  // Enqueue every selected file; the server FIFO dedupes anything already queued/running.
  var names = selNames(txSel);
  if (!names.length) return;
  $('txGoSel').disabled = true;
  Promise.all(names.map(function (n) {
    return fetchJson('/meeting-transcribe/start?name=' + encodeURIComponent(n)).catch(function () { return null; });
  })).then(function () { txSel.set = {}; selSync(txSel); txPoll(); });
};
function updateTxButtons() {
  if (!txState) return;
  Object.keys(txRows).forEach(function (name) {
    var r = txRows[name];
    if (txState.current && txState.current.name === name) {
      r.btn.textContent = 'Transcribing…'; r.btn.disabled = true; r.btn.classList.remove('primary');
    } else if ((txState.queue || []).indexOf(name) >= 0) {
      r.btn.textContent = 'Queued'; r.btn.disabled = true; r.btn.classList.remove('primary');
    } else {
      var err = (txState.recent || []).find(function (j) { return j.name === name && j.status === 'error'; });
      r.btn.textContent = err ? 'Retry' : 'Transcribe'; r.btn.disabled = false; r.btn.classList.add('primary');
      if (err) { r.sub.textContent = err.error || 'failed'; r.sub.classList.add('err'); }
    }
  });
}
$('btnTranscribe').onclick = function () {
  $('txOverlay').classList.add('show');
  renderTxList(); txPoll();
  if (!txTimer) txTimer = setInterval(txPoll, 1000);
};
$('txClose').onclick = function () {
  $('txOverlay').classList.remove('show');
  clearInterval(txTimer); txTimer = null;
};

// ---- Analysis: run the AI over a transcript, read the result ----
var anTimer = null, anState = null, anLastFinished = 0;
var anRows = {};            // json name -> { btnA, btnV, sub, analyzed }
function anPoll() {
  fetchJson('/meeting-analyze/state').then(function (st) {
    anState = st;
    var n = $('anNote');
    var queued = (st.queue || []).length;
    if (st.running) { n.textContent = 'Analyzing ' + splitRel(st.name).base + ' — ' + fmtDur(Date.now() - st.startedAt) + (queued ? ' · ' + queued + ' queued' : ''); n.classList.remove('err'); }
    else if (st.error) { n.textContent = splitRel(st.error.name).base + ': ' + st.error.error; n.classList.add('err'); }
    else { n.textContent = ''; n.classList.remove('err'); }
    var fin = (st.lastDone && st.lastDone.finishedAt) || 0;
    var finErr = (st.error && st.error.finishedAt) || 0;
    var latest = Math.max(fin, finErr);
    if (latest && latest !== anLastFinished) { anLastFinished = latest; renderAnList(); }
    else updateAnButtons();
  }).catch(function () {});
}
var anSel = selMake('anSelAll', 'anGoSel');
var anDir = '';   // current subfolder inside processed ('' = root); one folder shown at a time
function renderAnList() {
  var url = '/meeting-files?kind=processed' + (anDir ? '&dir=' + encodeURIComponent(anDir) : '');
  fetchJson(url).then(function (r) {
    var el = $('anList'); el.innerHTML = ''; anRows = {};
    $('anPath').textContent = 'Processed' + (anDir ? ' › ' + anDir.split('/').join(' › ') : '');
    $('anUp').disabled = !anDir;
    var files = (r && r.files) || [];
    var dirs = (r && r.dirs) || [];
    var mdSet = {};   // analyses are <base>-analysis.md (plain <base>.md accepted for early files)
    files.forEach(function (f) { if (/\.md$/i.test(f.name)) mdSet[f.name.replace(/(-analysis)?\.md$/i, '')] = 1; });
    var jsons = files.filter(function (f) { return /\.json$/i.test(f.name); });
    selReset(anSel, jsons.map(function (f) { return f.name; }));
    dirs.forEach(function (d) {
      var b = document.createElement('button');
      b.type = 'button'; b.className = 'fileRow folder press foc';
      b.innerHTML = '<div class="meta"><div class="fname">&#128193; ' + escHtml(d) + '</div></div><span class="chev">&rsaquo;</span>';
      b.onclick = function () { anDir = anDir ? anDir + '/' + d : d; renderAnList(); };
      el.appendChild(b);
    });
    if (!jsons.length) {
      if (!dirs.length) el.innerHTML = '<div class="ovEmpty">No transcripts here' + (anDir ? '.' : ' yet — transcribe a recording first.') + '</div>';
      selSync(anSel); return;
    }
    jsons.forEach(function (f) {
      // Raw transcripts are <base>-diarizer-response.json (legacy plain .json accepted);
      // the analysis is <base>-analysis.md, so match/display on the stripped base.
      var base = f.name.replace(/(-diarizer-response)?\.json$/i, '');
      var rel = splitRel(base);
      var analyzed = !!mdSet[base];
      var row = document.createElement('div'); row.className = 'fileRow';
      row.appendChild(selBox(anSel, f.name));
      var meta = document.createElement('div'); meta.className = 'meta';
      meta.innerHTML = '<div class="fname">' + escHtml(rel.base) + '</div><div class="fsub">' + (analyzed ? 'Analyzed' : 'Not analyzed') + '</div>';
      var btnA = rowBtn(analyzed ? 'Re-analyze' : 'Analyze', analyzed ? '' : 'primary');
      btnA.onclick = function () {
        btnA.disabled = true;
        fetchJson('/meeting-analyze/start?name=' + encodeURIComponent(f.name))
          .then(function (r2) {
            if (r2 && r2.ok === false) {
              var s2 = meta.querySelector('.fsub'); s2.textContent = r2.error || 'Could not start'; s2.classList.add('err');
              btnA.disabled = false;
            }
            anPoll();
          })
          .catch(function () { btnA.disabled = false; });
      };
      var btnV = rowBtn('View');
      btnV.disabled = !analyzed;
      btnV.onclick = function () { openAnalysisView(f.name, rel.base); };
      row.appendChild(meta); row.appendChild(btnA); row.appendChild(btnV);
      anRows[f.name] = { btnA: btnA, btnV: btnV, analyzed: analyzed };
      el.appendChild(row);
    });
    updateAnButtons();
    selSync(anSel);
  }).catch(function () {});
}
$('anGoSel').onclick = function () {
  // Queue every selected transcript; the analyzer FIFO runs them one at a time.
  var names = selNames(anSel);
  if (!names.length) return;
  $('anGoSel').disabled = true;
  Promise.all(names.map(function (n) {
    return fetchJson('/meeting-analyze/start?name=' + encodeURIComponent(n)).catch(function () { return null; });
  })).then(function () { anSel.set = {}; selSync(anSel); anPoll(); });
};
function updateAnButtons() {
  if (!anState) return;
  Object.keys(anRows).forEach(function (name) {
    var r = anRows[name];
    if (anState.running && anState.name === name) { r.btnA.textContent = 'Analyzing…'; r.btnA.disabled = true; }
    else if ((anState.queue || []).indexOf(name) >= 0) { r.btnA.textContent = 'Queued'; r.btnA.disabled = true; }
    else { r.btnA.textContent = r.analyzed ? 'Re-analyze' : 'Analyze'; r.btnA.disabled = false; }
  });
}
// Minimal markdown treatment (escape-first, matching the voice panel's renderContent discipline):
// code fences become <pre>, #-headings and **bold** become <b>. Everything else is plain text.
function renderMarkdown(src) {
  var parts = String(src || '').split('```');
  var out = '';
  for (var i = 0; i < parts.length; i++) {
    if (i % 2 === 1) { out += '<pre>' + escHtml(parts[i].replace(/^[a-zA-Z0-9]*\n/, '')) + '</pre>'; continue; }
    out += escHtml(parts[i]).split('\n').map(function (l) {
      if (/^#{1,6}\s/.test(l)) return '<b>' + l.replace(/^#{1,6}\s+/, '') + '</b>';
      return l.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
    }).join('\n');
  }
  return out;
}
function openAnalysisView(jsonName, title) {
  fetchJson('/meeting-analysis?name=' + encodeURIComponent(jsonName)).then(function (r) {
    if (!r || !r.ok) { var n = $('anNote'); n.textContent = (r && r.error) || 'Could not load analysis'; n.classList.add('err'); return; }
    $('anViewTitle').textContent = title;
    $('anView').innerHTML = renderMarkdown(r.markdown);
    $('anView').scrollTop = 0;
    $('anViewOverlay').classList.add('show');
  }).catch(function () {});
}
$('anUp').onclick = function () {
  if (!anDir) return;
  var parts = anDir.split('/'); parts.pop();
  anDir = parts.join('/');
  renderAnList();
};
$('btnAnalysis').onclick = function () {
  $('anOverlay').classList.add('show');
  renderAnList(); anPoll();
  if (!anTimer) anTimer = setInterval(anPoll, 1000);
};
$('anClose').onclick = function () {
  $('anOverlay').classList.remove('show');
  clearInterval(anTimer); anTimer = null;
};
$('anViewBack').onclick = function () { $('anViewOverlay').classList.remove('show'); };

wireScrollButtons('libList', 'libUp', 'libDown');
wireScrollButtons('txList', 'txUp', 'txDown');
wireScrollButtons('anList', 'anUp', 'anDown');
wireScrollButtons('anView', 'anViewUp', 'anViewDown');

renderDeck();
statusReady();
syncMic();
$('volPct').innerHTML = '<span class="ic">' + ICON.speaker + '</span>';   // boot state: volume not yet read
pollState();
setInterval(function () { tick(); pollState(); }, 1000);

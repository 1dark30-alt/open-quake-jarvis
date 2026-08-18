function $(id) { return document.getElementById(id); }

// theme — host passes _dark=1/0, _accent=#hex on the page URL (same as meetingview.js).
var Q = new URLSearchParams(location.search);
(function () {
  try {
    document.body.classList.toggle('light', Q.get('_dark') === '0');
    var a = Q.get('_accent') || '';
    if (/^#[0-9a-fA-F]{6}$/.test(a)) document.documentElement.style.setProperty('--accent', a);
    var hex = /^#[0-9a-fA-F]{6}$/.test(a) ? a : '#7CFFB2';
    var r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
    var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    document.documentElement.style.setProperty('--accent-fg', lum > 0.45 ? '#04121f' : '#f2f7fc');
  } catch (e) {}
})();

var text = $('text');
var lastSeq = -1, userDirty = false, dictating = false, editTimer = null;

function get(url) { return fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); }).catch(function () { return null; }); }

// Push the current textarea to the host so the global Apply hotkey pastes the edited text.
function flushEdit() {
  return fetch('/lucidtype-edit', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
    body: JSON.stringify({ text: text.value })
  }).catch(function () {});
}

text.addEventListener('input', function () {
  userDirty = true;
  clearTimeout(editTimer);
  editTimer = setTimeout(flushEdit, 250);
});

// Clear Text (header) — wipe the box and sync the empty transcript to the host.
$('btnClear').addEventListener('click', function () {
  text.value = '';
  userDirty = true;          // don't let a poll/SSE frame repopulate it
  flushEdit();
});

// Settings button -> overlay (like the voice apps); Done closes it. Mode is Phase 2 (no-op for now).
var settingsOvl = $('ltSettingsOverlay');
var curMic = '';   // latest mic label from state, so the picker opens on the current selection
$('btnSettings').addEventListener('click', function () { settingsOvl.classList.remove('hidden'); fillMicPicker(); });
$('btnSettingsClose').addEventListener('click', function () { settingsOvl.classList.add('hidden'); });
settingsOvl.addEventListener('click', function (e) { if (e.target === settingsOvl) settingsOvl.classList.add('hidden'); });

// Populate the overlay mic picker with device labels (lazy grant to reveal labels, like the editor).
// Picking one persists it via /lucidtype-set-mic and applies on the next dictation start.
function fillMicPicker() {
  var sel = $('ltOvlMic');
  function fill(devs) {
    var inputs = (devs || []).filter(function (d) { return d.kind === 'audioinput' && d.label; });
    sel.innerHTML = '<option value="">System default</option>';
    inputs.forEach(function (d) { var o = document.createElement('option'); o.value = d.label; o.textContent = d.label; sel.appendChild(o); });
    if (curMic && !inputs.some(function (d) { return d.label === curMic; })) { var o = document.createElement('option'); o.value = curMic; o.textContent = curMic + ' (not connected)'; sel.appendChild(o); }
    sel.value = curMic;
  }
  navigator.mediaDevices.enumerateDevices().then(function (devs) {
    if ((devs || []).some(function (d) { return d.kind === 'audioinput' && d.label; })) return fill(devs);
    navigator.mediaDevices.getUserMedia({ audio: true })
      .then(function (tmp) { navigator.mediaDevices.enumerateDevices().then(function (d2) { tmp.getTracks().forEach(function (t) { t.stop(); }); fill(d2); }); })
      .catch(function () { fill(devs); });
  }).catch(function () { fill([]); });
}
$('ltOvlMic').addEventListener('change', function (e) { curMic = e.target.value; get('/lucidtype-set-mic/' + encodeURIComponent(e.target.value)); });

function applyState(st) {
  if (!st) return;
  var wasDictating = dictating;
  dictating = !!st.dictating;
  document.body.classList.toggle('dictating', dictating);
  if (dictating && !wasDictating) userDirty = false;   // a fresh session owns the box again

  // Adopt the host transcript on any new sequence, unless the user is mid-edit (and not dictating).
  if (typeof st.seq === 'number' && st.seq !== lastSeq) {
    if (dictating || !userDirty) { text.value = st.transcript || ''; }
    lastSeq = st.seq;
  }

  curMic = st.mic || '';   // remember for the settings picker's current selection
  $('status').textContent = dictating ? 'Listening…' : '';
}

function pollState() { return get('/lucidtype-state').then(applyState); }

pollState();   // immediate load

// Real-time updates over SSE — main pushes on every dictation change, so text appears the instant
// Whisper returns (no poll lag). The poll is now only a fallback: it fires when the stream isn't
// open (initial connect gap or a dropped connection), tightened to 400ms so recovery is quick.
var es = null;
try {
  es = new EventSource('/lucidtype-events');
  es.onmessage = function (e) { try { applyState(JSON.parse(e.data)); } catch (_) {} };
  es.onerror = function () { /* EventSource auto-reconnects; the fallback poll covers the gap */ };
} catch (e) { es = null; }
setInterval(function () { if (!es || es.readyState !== 1) pollState(); }, 400);

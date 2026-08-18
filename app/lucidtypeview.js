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

  $('rMic').textContent = st.mic ? st.mic : 'System default';
  var stt = $('rStt');
  if (st.sttHost && st.sttPort) { stt.textContent = st.sttHost + ':' + st.sttPort; stt.className = 'v ok'; }
  else { stt.textContent = 'not set'; stt.className = 'v bad'; }
  $('status').textContent = dictating ? 'Listening…' : '';
}

function pollState() { return get('/lucidtype-state').then(applyState); }

pollState();
setInterval(pollState, 700);

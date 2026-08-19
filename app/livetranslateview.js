function $(id) { return document.getElementById(id); }

// One page = the livetranslate app. Options arrive as query params (musicview/claudevoiceview pattern);
// none are secret, so there is no /app-config fetch. See docs -- Tier 1 live translation.
var Q = new URLSearchParams(location.search);
var BASE = '/' + (location.pathname.split('/')[1] || 'livetranslate');
(function () {
  document.body.classList.toggle('light', Q.get('_dark') === '0');
  var a = Q.get('_accent') || '';
  if (/^#[0-9a-fA-F]{6}$/.test(a)) document.documentElement.style.setProperty('--accent', a);
  // Contrast-safe foreground for text on the accent (same luminance formula as the voice pages).
  var hex = /^#[0-9a-fA-F]{6}$/.test(a) ? a : '#7CFFB2';
  var r = parseInt(hex.slice(1, 3), 16) / 255, g = parseInt(hex.slice(3, 5), 16) / 255, b = parseInt(hex.slice(5, 7), 16) / 255;
  var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  document.documentElement.style.setProperty('--accent-fg', lum > 0.45 ? '#04120b' : '#f2f7fc');
})();

function esc(s) { var d = document.createElement('div'); d.textContent = s == null ? '' : String(s); return d.innerHTML; }

// Provider: 'soniox' (cloud streaming translation, the good path) or 'wyoming' (legacy utterance STT).
var provider = Q.get('provider') || 'soniox';
var targetLanguage = (Q.get('targetLanguage') || 'en').trim();
var sourceHint = (Q.get('sourceHint') || '').trim();
$('targetLang').textContent = Q.get('targetLangLabel') || (provider === 'soniox' ? targetLanguage.toUpperCase() : 'English');

// ---- captions ----
// Finalized lines only (Wyoming STT here is utterance-final -- no interim tokens). The still-being-
// transcribed utterance is a single "live" placeholder line whose blinking cursor signals activity.
var MAX_LINES = 200;
var lines = [];
var livePending = false;
var livePendingText = '';   // provisional (not-yet-final) tail shown on the live line (Soniox streaming)
function renderLines() {
  var list = $('list');
  $('empty').style.display = (lines.length || livePending) ? 'none' : '';
  var html = lines.map(function (t, i) {
    return '<div class="line' + (i >= lines.length - 2 ? ' recent' : '') + '">' + esc(t) + '</div>';
  }).join('');
  if (livePending) html += '<div class="line live">' + esc(livePendingText) + '</div>';
  list.innerHTML = html;
  $('card').scrollTop = $('card').scrollHeight;
}
function showPending() { livePending = true; renderLines(); }
function clearPending() { livePending = false; }
function addLine(text) {
  lines.push(text);
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
  clearPending();
  renderLines();
}

var RING_SIGNAL_STATES = { listening: 1 };
function setStatus(status, errorText) {
  var el = $('status');
  el.textContent = (status || 'idle').toUpperCase();
  el.className = status === 'listening' ? 'listening' : status === 'error' ? 'error' : '';
  $('srcInfo').textContent = errorText || '';
  console.log('OQX_RING::' + (RING_SIGNAL_STATES[status] ? status : 'idle'));   // drives the panel ring, like the voice pages
}

// ---- microphone devices (mic only -- no speaker/model here) ----
// Persist the pick as a LABEL ('' = system default); Chromium salts deviceIds per origin and the
// served port changes each launch, so the page re-matches label -> id at startup.
var savedMicLabel = Q.get('micDevice') || '';
var micDeviceId = '';
var allDevices = [];
var devicesReady = false;
function matchDevices() {
  var mic = allDevices.find(function (d) { return d.kind === 'audioinput' && d.label === savedMicLabel; });
  micDeviceId = mic ? mic.deviceId : '';
}
function ensureDeviceIds(force) {
  if (devicesReady && !force) return Promise.resolve();
  return navigator.mediaDevices.getUserMedia({ audio: true }).then(function (tmp) {
    return navigator.mediaDevices.enumerateDevices().then(function (devs) {
      tmp.getTracks().forEach(function (t) { t.stop(); });
      allDevices = devs || []; matchDevices(); devicesReady = true;
    });
  }).catch(function () { allDevices = []; matchDevices(); devicesReady = true; });
}
function syncMicPickVal() { $('micPickVal').textContent = savedMicLabel || 'System default'; }
function renderDevOverlay() {
  var el = $('devList'); el.innerHTML = '';
  function addRow(label, value, current) {
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'devRow' + (current ? ' current' : '');
    b.textContent = label; b.title = label;
    b.onclick = function () { pickMic(value); };
    el.appendChild(b);
  }
  var devs = allDevices.filter(function (d) { return d.kind === 'audioinput' && d.label; });
  var matched = !!savedMicLabel && devs.some(function (d) { return d.label === savedMicLabel; });
  addRow('System default', '', !matched);
  devs.forEach(function (d) { addRow(d.label, d.label, matched && d.label === savedMicLabel); });
}
function pickMic(label) {
  $('devOverlay').classList.add('hidden');
  savedMicLabel = label;
  postOption('micDevice', label);
  matchDevices();
  syncMicPickVal();
  if (listening && provider !== 'soniox' && vad) {   // live (wyoming): reopen the mic on the new device now
    vad.stop();
    vad.setInputDevice(micDeviceId);
    vad.start(onSpeechStart, onSpeechEnd, onLevel).catch(function (e) { setStatus('error', 'Microphone switch failed: ' + (e && e.message ? e.message : e)); });
  }
  // Soniox: the new device applies on the next start (avoids tearing a live cloud session).
}
$('micPickBtn').onclick = function () {
  $('devOverlay').classList.remove('hidden');
  renderDevOverlay();
  ensureDeviceIds(true).then(function () { renderDevOverlay(); });
};
$('devCancel').onclick = function () { $('devOverlay').classList.add('hidden'); };

// ---- tap-to-toggle listening (VAD; not push-to-talk -- same model as the voice pages) ----
var listening = false;
var vadHangoverMs = parseInt(Q.get('vadHangoverMs'), 10) || 800;
var vad = window.createClaudeVoiceVAD ? window.createClaudeVoiceVAD({ hangoverMs: vadHangoverMs }) : null;
function onSpeechStart() { showPending(); setStatus('listening'); }
function onSpeechEnd(pcm16) {
  showPending();
  fetch(BASE + '/audio', { method: 'POST', cache: 'no-store', body: pcm16.buffer })
    .then(function (r) { return r.json(); })
    .then(function (r) {
      if (r && r.ok && r.text && r.text.trim()) addLine(r.text.trim());
      else { clearPending(); renderLines(); setStatus(listening ? 'listening' : 'idle', r && r.error ? r.error : ''); }
    })
    .catch(function () { clearPending(); renderLines(); setStatus('error', 'Transcription request failed.'); });
}
var lastRippleAt = 0;
function onLevel(level) {
  if (!listening) return;
  var now = Date.now();
  if (level < 0.012 || now - lastRippleAt < 180) return;
  lastRippleAt = now;
  var r = document.createElement('div');
  r.className = 'ripple';
  $('micRipples').appendChild(r);
  r.addEventListener('animationend', function () { r.remove(); });
}
function syncMicUI() { $('micBtn').classList.toggle('on', listening); $('micBtn').classList.toggle('off', !listening); }

// ---- Soniox real-time translation (streaming; the cloud provider) ----
// Continuous mic PCM -> Soniox WebSocket -> live translated tokens. The real API key never reaches
// this page: main mints a short-lived temporary key (GET /soniox-token) that we authenticate with.
var soniWs = null, soniCtx = null, soniStream = null, soniProc = null;
var soniFinal = '', soniProv = '';
function renderSoniox() {
  // Committed translation split into sentence-ish lines; the provisional tail is the blinking live line.
  lines = (soniFinal.match(/[^.!?]+[.!?]*/g) || []).map(function (s) { return s.trim(); }).filter(Boolean);
  if (lines.length > MAX_LINES) lines = lines.slice(-MAX_LINES);
  livePending = true; livePendingText = soniProv.trim();
  renderLines();
}
function toggleSoniox() {
  if (listening) { stopSoniox(); return; }
  listening = true; setStatus('listening'); syncMicUI();
  fetch(BASE + '/soniox-token', { cache: 'no-store' }).then(function (r) { return r.json(); })
    .then(function (t) {
      if (!listening) return;   // toggled back off while the token was in flight
      if (!t || !t.ok || !t.apiKey) throw new Error((t && t.error) || 'could not get a Soniox token');
      return ensureDeviceIds().then(function () { if (listening) openSoniox(t.apiKey); });
    })
    .catch(function (e) { listening = false; syncMicUI(); setStatus('error', 'Soniox: ' + (e && e.message ? e.message : e)); });
}
function openSoniox(apiKey) {
  soniFinal = ''; soniProv = ''; lines = []; renderLines();
  soniWs = new WebSocket('wss://stt-rt.soniox.com/transcribe-websocket');
  soniWs.binaryType = 'arraybuffer';
  soniWs.onopen = function () {
    var cfg = { api_key: apiKey, model: 'stt-rt-v5', audio_format: 's16le', sample_rate: 16000, num_channels: 1,
      translation: { type: 'one_way', target_language: targetLanguage } };
    if (sourceHint) cfg.language_hints = [sourceHint];
    soniWs.send(JSON.stringify(cfg));
    startSoniCapture();
  };
  soniWs.onmessage = function (ev) {
    var msg; try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.error_code || msg.error_message) { setStatus('error', 'Soniox: ' + (msg.error_message || msg.error_code)); stopSoniox(); return; }
    var prov = '';
    (msg.tokens || []).forEach(function (tk) {
      if (!tk.text || tk.translation_status !== 'translation') return;
      if (tk.is_final) soniFinal += tk.text; else prov += tk.text;
    });
    soniProv = prov;
    renderSoniox();
    if (msg.finished) stopSoniox();
  };
  soniWs.onerror = function () { setStatus('error', 'Soniox connection error.'); };
}
function startSoniCapture() {
  navigator.mediaDevices.getUserMedia({ audio: micDeviceId ? { deviceId: { ideal: micDeviceId } } : true }).then(function (stream) {
    if (!listening) { stream.getTracks().forEach(function (t) { t.stop(); }); return; }
    soniStream = stream;
    soniCtx = new (window.AudioContext || window.webkitAudioContext)({ sampleRate: 16000 });
    var src = soniCtx.createMediaStreamSource(stream);
    soniProc = soniCtx.createScriptProcessor(4096, 1, 1);
    var mute = soniCtx.createGain(); mute.gain.value = 0;   // route to destination (some engines need it) but silent
    src.connect(soniProc); soniProc.connect(mute); mute.connect(soniCtx.destination);
    soniProc.onaudioprocess = function (e) {
      if (!soniWs || soniWs.readyState !== 1) return;
      var f = e.inputBuffer.getChannelData(0);
      var pcm = new Int16Array(f.length);
      var peak = 0;
      for (var i = 0; i < f.length; i++) { var s = Math.max(-1, Math.min(1, f[i])); pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff; if (Math.abs(f[i]) > peak) peak = Math.abs(f[i]); }
      try { soniWs.send(pcm.buffer); } catch (e2) {}
      onLevel(peak);   // drive the mic-button ripples off the live input level
    };
  }).catch(function (e) {
    setStatus('error', 'Microphone access failed: ' + (e && e.message ? e.message : e));
    stopSoniox();
  });
}
function stopSoniox() {
  var wasListening = listening;
  listening = false; syncMicUI();
  try { if (soniProc) soniProc.disconnect(); } catch (e) {}
  try { if (soniCtx) soniCtx.close(); } catch (e) {}
  try { if (soniStream) soniStream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
  soniProc = soniCtx = soniStream = null;
  try { if (soniWs && soniWs.readyState === 1) soniWs.send(new ArrayBuffer(0)); } catch (e) {}   // empty frame = end of audio
  try { if (soniWs) soniWs.close(); } catch (e) {}
  soniWs = null;
  if (wasListening && saveOn && soniFinal.trim()) {   // persist the whole session's translation on stop
    postJson('/append-line', { text: soniFinal.trim() });
  }
  livePending = false; renderLines();
  setStatus('idle');
}

function toggleListening() {
  if (provider === 'soniox') { toggleSoniox(); return; }
  if (!vad) { setStatus('error', 'Microphone engine failed to load.'); return; }
  if (listening) {
    listening = false; vad.stop(); clearPending(); renderLines(); setStatus('idle'); syncMicUI();
  } else {
    listening = true; setStatus('listening'); syncMicUI();
    ensureDeviceIds().then(function () {
      if (!listening) return;
      vad.setInputDevice(micDeviceId);
      return vad.start(onSpeechStart, onSpeechEnd, onLevel);
    }).catch(function (e) {
      listening = false; syncMicUI();
      setStatus('error', 'Microphone access failed: ' + (e && e.message ? e.message : e));
    });
  }
}
$('micBtn').onclick = toggleListening;
window.oqxToggleConversation = toggleListening;   // knob-tap hook, same as the voice pages

// ---- save to file ----
var saveOn = Q.get('saveToFile') === '1' || Q.get('saveToFile') === 'true';
function syncSaveUI() { $('saveBtn').classList.toggle('on', saveOn); $('saveState').textContent = saveOn ? 'ON' : 'OFF'; }
$('saveBtn').onclick = function () { saveOn = !saveOn; syncSaveUI(); postOption('saveToFile', saveOn ? '1' : '0'); };

// ---- settings: pause tolerance ----
function applyPause() {
  vadHangoverMs = Math.max(400, Math.min(2500, vadHangoverMs));
  if (vad && vad.setHangoverMs) vad.setHangoverMs(vadHangoverMs);
  $('pauseVal').textContent = (vadHangoverMs / 1000).toFixed(1) + ' s';
}
$('pauseMinus').onclick = function () { vadHangoverMs -= 100; applyPause(); postOption('vadHangoverMs', vadHangoverMs); };
$('pausePlus').onclick = function () { vadHangoverMs += 100; applyPause(); postOption('vadHangoverMs', vadHangoverMs); };
$('settingsBtn').onclick = function () { syncMicPickVal(); $('settingsOverlay').classList.remove('hidden'); };
$('settingsClose').onclick = function () { $('settingsOverlay').classList.add('hidden'); };

// ▲/▼ page buttons for the device list (drag-thumbs proved unreliable on the panel -- see quake-touch-ui).
function wireScrollButtons(listId, upId, downId) {
  var list = $(listId);
  function step(dir) { list.scrollBy({ top: dir * list.clientHeight * 0.9, behavior: 'smooth' }); }
  [[upId, -1], [downId, 1]].forEach(function (pair) {
    var btn = $(pair[0]); var repeat = null;
    btn.addEventListener('pointerdown', function (e) { btn.setPointerCapture(e.pointerId); step(pair[1]); repeat = setInterval(function () { step(pair[1]); }, 400); });
    ['pointerup', 'pointercancel'].forEach(function (ev) { btn.addEventListener(ev, function () { clearInterval(repeat); repeat = null; }); });
  });
}
wireScrollButtons('devList', 'devScrollUp', 'devScrollDown');

function postOption(key, value) { postJson('/option', { key: key, value: String(value) }); }
function postJson(path, body) {
  fetch(BASE + path, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).catch(function () {});
}

// On-load snapshot: the real STT endpoint (for the source line) and the persisted save/target state.
fetch(BASE + '/state', { cache: 'no-store' }).then(function (r) { return r.json(); })
  .then(function (s) {
    if (s.targetLangLabel) $('targetLang').textContent = s.targetLangLabel;
    else if (s.provider === 'soniox' && s.targetLanguage) $('targetLang').textContent = s.targetLanguage.toUpperCase();
    saveOn = !!s.saveToFile; syncSaveUI();
    if (s.provider === 'soniox') {
      $('srcPill').textContent = s.sonioxConfigured ? ('Soniox → ' + (s.targetLanguage || targetLanguage).toUpperCase()) : 'Soniox API key not set';
      if (!s.sonioxConfigured) setStatus('idle', 'Add your Soniox API key in this page’s settings (config editor).');
    } else {
      $('srcPill').textContent = s.sttConfigured ? ('STT ' + s.sttEndpoint) : 'STT not configured';
      if (!s.sttConfigured) setStatus('idle', 'No STT endpoint set — use this page’s Advanced override, or Settings → TTS/STT.');
    }
  }).catch(function () {});

applyPause();
syncMicUI();
syncSaveUI();
renderLines();

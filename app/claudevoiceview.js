function $(id) { return document.getElementById(id); }

// Theme — read directly from the served query (musicview.js's pattern, not chatview.html's broken
// hardcoded-dark approach — see docs/claude-voice.md). No options here are secret (confirmed in
// apps.json), so unlike the OWUI chat app there's no /app-config fetch needed at all for config.
var Q = new URLSearchParams(location.search);
(function () {
  document.body.classList.toggle('light', Q.get('_dark') === '0');
  var a = Q.get('_accent') || '';
  if (/^#[0-9a-fA-F]{6}$/.test(a)) document.documentElement.style.setProperty('--accent', a);
})();

var projectDir = Q.get('projectDir') || '';
$('project').textContent = projectDir ? projectDir.split(/[\\/]/).filter(Boolean).pop() : '(no project set)';

function esc(s) {
  var d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

// Minimal, deliberately small renderer: escape everything, then recognize ```fenced code blocks```
// as copyable <pre><code> and everything else as plain paragraphs. Not a full markdown parser (see
// Phase 8 note in the plan for why: a real one means vendoring a library under this app's strict
// CSP, same as the VAD assets) -- but code/commands, the thing that actually needs to be selectable
// and copyable per the hard requirement, already render correctly with this.
function renderContent(text) {
  var parts = String(text || '').split(/```([\s\S]*?)```/);
  var html = '';
  for (var i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      // fenced block — parts[i] may start with a language tag on its own first line; strip it for display
      var body = parts[i].replace(/^[ \t]*[A-Za-z0-9_+-]*\n/, '');
      html += '<div class="codeblock"><pre><code>' + esc(body.replace(/\n$/, '')) + '</code></pre>' +
        '<button class="copybtn" type="button">Copy</button></div>';
    } else if (parts[i].trim()) {
      html += '<div>' + esc(parts[i]).replace(/\n/g, '<br>') + '</div>';
    }
  }
  return html || esc(text);
}

function wireCopyButtons(container) {
  container.querySelectorAll('.copybtn').forEach(function (btn) {
    btn.onclick = function () {
      var code = btn.previousElementSibling.querySelector('code');
      var text = code ? code.textContent : '';
      navigator.clipboard.writeText(text).then(function () {
        btn.textContent = 'Copied'; btn.classList.add('copied');
        setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1500);
      }).catch(function () {});
    };
  });
}

var transcript = [];   // [{role:'user'|'assistant', text}]
function renderTranscript() {
  var list = $('list'), empty = $('empty');
  empty.style.display = transcript.length ? 'none' : '';
  list.innerHTML = transcript.map(function (m) {
    return '<div class="msg ' + m.role + '"><div class="who">' + (m.role === 'user' ? 'You' : 'Claude') + '</div>' +
      '<div class="bubble">' + renderContent(m.text) + '</div></div>';
  }).join('');
  wireCopyButtons(list);
  $('card').scrollTop = $('card').scrollHeight;
}

// Ring states the host (main.js) knows how to render — anything else (idle, error, ...) clears the
// override back to the user's normal theme-driven ring. Keep in sync with RING_STATES in main.js.
var RING_SIGNAL_STATES = { listening: 1, thinking: 1, speaking: 1, approval: 1 };
function setStatus(status, errorText) {
  var el = $('status');
  el.textContent = (status || 'idle').toUpperCase();
  el.className = status === 'thinking' ? 'thinking' : status === 'listening' ? 'listening' :
    status === 'error' ? 'error' : status === 'approval' ? 'approval' : '';
  $('err').textContent = errorText || '';
  console.log('OQX_RING::' + (RING_SIGNAL_STATES[status] ? status : 'idle'));
}

// Real streaming: EventSource stays open for the life of the page, pushed by main.js as
// content_block_delta events arrive from the live claude process (see claudevoice-session.js).
// `liveMsg` is the in-progress assistant transcript entry -- created on 'assistant-start', appended
// to on every 'assistant-delta', finalized (and re-rendered once more with the authoritative text)
// on 'turn-complete'.
var liveMsg = null;
function updateLiveBubble() {
  var list = $('list');
  var row = list.querySelector('[data-live="1"]');
  if (!row) return;
  row.querySelector('.bubble').innerHTML = renderContent(liveMsg.text);
  wireCopyButtons(row);
  $('card').scrollTop = $('card').scrollHeight;
}
function connectEvents() {
  var es = new EventSource('/claude-voice/events');
  es.onmessage = function (e) {
    var msg; try { msg = JSON.parse(e.data); } catch (err) { return; }
    if (msg.type === 'assistant-start') {
      setStatus('thinking');
      liveMsg = { role: 'assistant', text: '' };
      transcript.push(liveMsg);
      $('empty').style.display = 'none';
      var row = document.createElement('div');
      row.className = 'msg assistant'; row.setAttribute('data-live', '1');
      row.innerHTML = '<div class="who">Claude</div><div class="bubble"></div>';
      $('list').appendChild(row);
      $('card').scrollTop = $('card').scrollHeight;
    } else if (msg.type === 'assistant-delta') {
      if (!liveMsg) return;   // a delta arrived with no preceding start (e.g. page just loaded mid-turn) — ignore, /claude-voice/state will catch up on next reload
      liveMsg.text += msg.text || '';
      updateLiveBubble();
    } else if (msg.type === 'turn-complete') {
      var finalText = msg.text;
      if (liveMsg) {
        liveMsg.text = finalText || liveMsg.text;   // authoritative final text wins over accumulated deltas
        var row = $('list').querySelector('[data-live="1"]');
        if (row) row.removeAttribute('data-live');
        updateLiveBubbleFinal(row);
      }
      liveMsg = null;
      // Only speak the reply back if THIS turn started as voice -- a typed message never gets an
      // unsolicited spoken reply. speak() itself sets status to 'speaking' then back to
      // listening/idle when playback ends, so it fully owns the status transition here.
      if (lastTurnWasVoice && !msg.error) { speak(finalText); }
      else { setStatus('idle', msg.error); }
      lastTurnWasVoice = false;
    } else if (msg.type === 'error') {
      setStatus('error', msg.error);
    } else if (msg.type === 'approval-request') {
      showApprovalOverlay(msg.requestId, msg.toolName, msg.toolInput);
    } else if (msg.type === 'approval-decision' || msg.type === 'approval-timeout') {
      if (msg.requestId === pendingApprovalRequestId) hideApprovalOverlay();
    }
  };
  es.onerror = function () { /* EventSource auto-reconnects; nothing to do */ };
}

// ---- Touch approval overlay (Phase 7) ----
// Driven entirely by SSE: main.js's PreToolUse hook holds the tool call open and emits
// 'approval-request'; a tap here POSTs the decision, which resolves that same held-open hook
// response server-side. A reload while a request is in flight won't re-show this overlay (the
// current /claude-voice/state snapshot doesn't carry pending-request detail, only the status text) --
// same acknowledged limitation as the SSE transcript-replay gap noted above.
var pendingApprovalRequestId = null;
function renderApprovalDetail(toolName, toolInput) {
  toolInput = toolInput || {};
  var parts = [];
  var code = typeof toolInput.command === 'string' ? toolInput.command :
    typeof toolInput.content === 'string' ? toolInput.content :
    typeof toolInput.new_string === 'string' ? toolInput.new_string : null;
  if (code != null) parts.push('<pre class="approvalCode">' + esc(code) + '</pre>');
  var where = typeof toolInput.file_path === 'string' ? toolInput.file_path : typeof toolInput.path === 'string' ? toolInput.path : null;
  if (where) parts.push('<div class="approvalPath">in ' + esc(where) + '</div>');
  if (!parts.length) parts.push('<pre class="approvalCode">' + esc(JSON.stringify(toolInput, null, 2)) + '</pre>');
  return parts.join('');
}
function showApprovalOverlay(requestId, toolName, toolInput) {
  pendingApprovalRequestId = requestId;
  $('approvalTool').textContent = toolName || 'a tool';
  $('approvalDetail').innerHTML = renderApprovalDetail(toolName, toolInput);
  $('approvalOverlay').classList.remove('hidden');
  setStatus('approval');
}
function hideApprovalOverlay() {
  pendingApprovalRequestId = null;
  $('approvalOverlay').classList.add('hidden');
  setStatus('thinking');   // control is back with Claude -- it'll either keep working or ask again
}
function decideApproval(decision) {
  var requestId = pendingApprovalRequestId;
  if (!requestId) return;
  hideApprovalOverlay();
  fetch('/claude-voice/approval-decision', {
    method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestId: requestId, decision: decision }),
  }).catch(function () { setStatus('error', 'Could not send the approval decision.'); });
}
$('approvalApprove').onclick = function () { decideApproval('allow'); };
$('approvalDeny').onclick = function () { decideApproval('deny'); };
function updateLiveBubbleFinal(row) {
  if (!row || !liveMsg) return;
  row.querySelector('.bubble').innerHTML = renderContent(liveMsg.text);
  wireCopyButtons(row);
}
fetch('/claude-voice/state', { cache: 'no-store' }).then(function (r) { return r.json(); })
  .then(function (s) { setStatus(s.status, s.error); }).catch(function () {});
connectEvents();

function autoGrow() {
  var ta = $('textInput');
  ta.style.height = 'auto';
  ta.style.height = Math.min(140, ta.scrollHeight) + 'px';
}
$('textInput').addEventListener('input', autoGrow);

var lastTurnWasVoice = false;   // gates auto-speak-the-reply -- typed turns never get spoken back unsolicited
function sendText(text, fromVoice) {
  if (!text) return;
  transcript.push({ role: 'user', text: text });
  renderTranscript();
  lastTurnWasVoice = !!fromVoice;
  $('sendBtn').disabled = true;
  fetch('/claude-voice/turn', {
    method: 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text }),
  }).then(function (r) { return r.json(); })
    .then(function (r) { if (!r || !r.ok) setStatus('error', 'Turn failed to send — no project set, or claude CLI not found.'); })
    .catch(function () { setStatus('error', 'Could not reach the panel server.'); })
    .finally(function () { $('sendBtn').disabled = false; });
}
function send() {
  var ta = $('textInput');
  var text = ta.value.trim();
  if (!text) return;
  ta.value = ''; autoGrow();
  sendText(text, false);
}
$('sendBtn').onclick = send;
$('textInput').addEventListener('keydown', function (e) {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
});

// Speaks `text` via the configured wyoming-piper. Used both by the manual test button and by the
// real voice-conversation loop below (auto-speaking Claude's reply after a voice-initiated turn).
// `suppressVAD` is held true for the duration of playback so the mic doesn't hear Claude's own
// voice through the speakers and mistake it for the next user utterance (a real feedback-loop risk
// in a fully hands-free loop -- there's no headset here, just the panel's own mic and speaker).
var suppressVAD = false;
function speak(text, onDone) {
  if (!text) { if (onDone) onDone(); return; }
  suppressVAD = true;
  setStatus('speaking');
  var audio = new Audio('/claude-voice/tts-audio?text=' + encodeURIComponent(text));
  var finish = function () { suppressVAD = false; setStatus(conversationOpen ? 'listening' : 'idle'); if (onDone) onDone(); };
  audio.addEventListener('ended', finish);
  audio.addEventListener('error', finish);
  audio.play().catch(finish);
}
$('ttsTestBtn').onclick = function () {
  var last = transcript.slice().reverse().find(function (m) { return m.role === 'assistant'; });
  speak(last ? last.text : 'No reply yet to test with.');
};

// ---- Tap-to-toggle voice conversation (Phase 5) ----
// Explicitly NOT push-to-talk: one tap opens a continuous conversation (VAD detects each utterance's
// start/end on its own, no holding anything down), a second tap closes it. See the plan's hard
// constraint #4 -- push-to-talk was explicitly rejected.
var conversationOpen = false;
var vad = window.createClaudeVoiceVAD ? window.createClaudeVoiceVAD({}) : null;
function onVADSpeechStart() {
  if (suppressVAD) return;
  setStatus('listening');
}
function onVADSpeechEnd(pcm16) {
  if (suppressVAD) return;
  setStatus('thinking');
  fetch('/claude-voice/audio', { method: 'POST', cache: 'no-store', body: pcm16.buffer })
    .then(function (r) { return r.json(); })
    .then(function (r) {
      if (r && r.ok && r.text && r.text.trim()) { sendText(r.text.trim(), true); }
      else { setStatus(conversationOpen ? 'listening' : 'idle', r && r.error); }
    })
    .catch(function () { setStatus('error', 'Transcription request failed.'); });
}
window.oqxToggleConversation = function () {
  if (!vad) { $('textInput').focus(); return; }   // VAD script failed to load -- fall back to at least focusing input
  if (conversationOpen) {
    conversationOpen = false;
    vad.stop();
    setStatus('idle');
  } else {
    conversationOpen = true;
    setStatus('listening');
    vad.start(onVADSpeechStart, onVADSpeechEnd).catch(function (e) {
      conversationOpen = false;
      setStatus('error', 'Microphone access failed: ' + e.message);
    });
  }
};

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
    return '<div class="msg ' + m.role + '"><div class="bubble">' + renderContent(m.text) + '</div></div>';
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
      // Just a status change -- do NOT create a bubble yet. A turn emits message_start for every
      // internal message (tool calls, thinking), most of which never produce any text; creating a
      // bubble here left a trail of empty bars. The bubble appears on the first real text delta.
      setStatus('thinking');
    } else if (msg.type === 'assistant-delta') {
      if (!msg.text) return;
      if (!liveMsg) {
        liveMsg = { role: 'assistant', text: '' };
        transcript.push(liveMsg);
        $('empty').style.display = 'none';
        var row = document.createElement('div');
        row.className = 'msg assistant'; row.setAttribute('data-live', '1');
        row.innerHTML = '<div class="bubble"></div>';
        $('list').appendChild(row);
      }
      liveMsg.text += msg.text;
      updateLiveBubble();
      // Speech is NOT handled here anymore: the main process cuts sentences out of this same delta
      // stream itself and streams one continuous WAV per turn (see claudevoice-speech.js).
    } else if (msg.type === 'turn-complete') {
      var finalText = msg.text;
      if (liveMsg) {
        liveMsg.text = finalText || liveMsg.text;   // authoritative final text wins over accumulated deltas
        var row = $('list').querySelector('[data-live="1"]');
        if (row) row.removeAttribute('data-live');
        updateLiveBubbleFinal(row);
      } else if (finalText) {
        // No live bubble exists -- this turn never streamed (slash commands like /model or /context
        // come back only in the final result event), or the page loaded mid-turn. Render the result
        // as its own assistant message now instead of silently dropping it.
        transcript.push({ role: 'assistant', text: finalText });
        renderTranscript();
      }
      liveMsg = null;
      turnInProgress = false;
      // Speech: the server's per-turn stream keeps playing past turn-complete; when the audio is
      // still active its 'ended' event owns the status handoff back to listening/idle.
      if (msg.error) { stopTurnAudio(); setStatus('error', msg.error); }
      else if (!turnAudio) setStatus(conversationOpen ? 'listening' : 'idle');
    } else if (msg.type === 'error') {
      turnInProgress = false;
      stopTurnAudio();
      setStatus('error', msg.error);
    } else if (msg.type === 'approval-request') {
      showApprovalOverlay(msg.requestId, msg.toolName, msg.toolInput);
    } else if (msg.type === 'approval-decision' || msg.type === 'approval-timeout') {
      if (msg.requestId === pendingApprovalRequestId) hideApprovalOverlay();
    } else if (msg.type === 'permission-mode') {
      currentMode = msg.mode || currentMode;
      syncModeUI();
    } else if (msg.type === 'session-started') {
      // New session (folder switch or fresh start): new conversation, new header, silence.
      stopTurnAudio();
      turnInProgress = false;
      transcript = [];
      liveMsg = null;
      renderTranscript();
      setProjectHeader(msg.projectDir);
      setStatus('idle');
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
  .then(function (s) {
    // Replay the session's transcript (kept by main.js) -- the webview reloads this page on every
    // page switch, so without this a rotate-away-and-back would blank the whole conversation.
    if (s.transcript && s.transcript.length) { transcript = s.transcript.slice(); renderTranscript(); }
    if (s.permissionMode) { currentMode = s.permissionMode; syncModeUI(); }
    if (s.projectDir) setProjectHeader(s.projectDir);   // live truth beats the (possibly stale) page-load query param
    setStatus(s.status, s.error);
  }).catch(function () {});
connectEvents();

function autoGrow() {
  var ta = $('textInput');
  ta.style.height = 'auto';
  ta.style.height = Math.min(140, ta.scrollHeight) + 'px';
}
$('textInput').addEventListener('input', autoGrow);

var turnInProgress = false;   // a sent turn hasn't seen its turn-complete yet (drives status after audio ends early)
function sendText(text, fromVoice) {
  if (!text) return;
  transcript.push({ role: 'user', text: text });
  renderTranscript();
  turnInProgress = true;
  $('sendBtn').disabled = true;
  fetch('/claude-voice/turn', {
    method: 'POST', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    // `speak` is decided HERE, per turn (voice-initiated + speaker on) -- the server ties it to the
    // turn, so one turn finishing can never silence a queued next turn's speech (the old
    // lastTurnWasVoice-clobber bug). Typed turns never get spoken back unsolicited.
    body: JSON.stringify({ text: text, speak: !!(fromVoice && speakEnabled) }),
  }).then(function (r) { return r.json(); })
    .then(function (r) {
      if (!r || !r.ok) { turnInProgress = false; setStatus('error', 'Turn failed to send — no project set, or claude CLI not found.'); return; }
      if (r.speech) startTurnAudio(r.speech);
    })
    .catch(function () { turnInProgress = false; setStatus('error', 'Could not reach the panel server.'); })
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

// Speaks `text` via the configured wyoming-piper. Test-speech button ONLY now -- real replies
// stream through the per-turn pipeline below. The server sanitizes the text for speech itself.
// `suppressVAD` is held true for the duration of playback so the mic doesn't hear Claude's own
// voice through the speakers and mistake it for the next user utterance (a real feedback-loop risk
// in a fully hands-free loop -- there's no headset here, just the panel's own mic and speaker).
var suppressVAD = false;
function speak(text, onDone) {
  if (!text) { if (onDone) onDone(); return; }
  stopTurnAudio();   // the Test button supersedes any in-flight turn speech -- never two streams
  suppressVAD = true;
  setStatus('speaking');
  $('spkBtn').classList.add('pulsing');
  var finish = function (errMsg) {
    suppressVAD = false;
    $('spkBtn').classList.remove('pulsing');
    setStatus(conversationOpen ? 'listening' : 'idle', errMsg || '');
    if (onDone) onDone();
  };
  // POST the text first and play by id: reply text can be many KB, far beyond what a GET query
  // string survives (oversized request lines got rejected server-side before any handler ran --
  // the "sometimes replies just aren't spoken" bug). Failures surface in the status line now
  // instead of dying silently.
  fetch('/claude-voice/tts', {
    method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text }),
  }).then(function (r) { return r.json(); })
    .then(function (r) {
      if (!r || !r.ok || !r.id) { finish('Speech failed to start.'); return; }
      var audio = new Audio('/claude-voice/tts-audio?id=' + encodeURIComponent(r.id));
      audio.addEventListener('ended', function () { finish(); });
      audio.addEventListener('error', function () { finish('Speech playback failed.'); });
      audio.play().catch(function () { finish('Speech playback failed.'); });
    })
    .catch(function () { finish('Speech failed to start.'); });
}
$('ttsTestBtn').onclick = function () {
  var last = transcript.slice().reverse().find(function (m) { return m.role === 'assistant'; });
  speak(last ? last.text : 'No reply yet to test with.');
};

// ---- Turn speech (v2 -- the user's own architecture, task #26) ----
// ALL speech logic lives in the MAIN process now (claudevoice-speech.js): it cuts sentences out of
// the same delta stream this page renders, sanitizes them for the speaker, synthesizes serially,
// and streams ONE continuous WAV per turn. This page just plays a single <audio> element per voice
// turn -- overlap is structurally impossible, and there are no page-side queues or watchdogs left
// to orphan. Dropping the element's stream (mute, folder switch, page unload) is itself the abort
// signal the server acts on; no separate stop request exists or is needed.
var turnAudio = null;   // the current voice turn's <audio>, or null
function endSpeechUI(errMsg) {
  suppressVAD = false;
  $('spkBtn').classList.remove('pulsing');
  setStatus(turnInProgress ? 'thinking' : conversationOpen ? 'listening' : 'idle', errMsg || '');
}
function stopTurnAudio() {
  if (!turnAudio) return;
  var a = turnAudio;
  turnAudio = null;
  try { a.pause(); } catch (e) {}
  try { a.removeAttribute('src'); a.load(); } catch (e) {}   // closes the HTTP stream -> server aborts synthesis
  endSpeechUI();
}
function startTurnAudio(turnId) {
  stopTurnAudio();
  var a = turnAudio = new Audio('/claude-voice/turn-audio?turn=' + encodeURIComponent(turnId));
  var done = function () {   // ended and error land in the same place: release the mic, settle status
    if (turnAudio !== a) return;
    turnAudio = null;
    endSpeechUI();
  };
  a.addEventListener('playing', function () {
    if (turnAudio !== a) return;
    suppressVAD = true;   // the mic must never hear Claude's own voice through the speaker
    setStatus('speaking');
    $('spkBtn').classList.add('pulsing');
  });
  a.addEventListener('ended', done);
  a.addEventListener('error', done);
  a.play().catch(done);
}

// ---- Tap-to-toggle voice conversation (Phase 5) ----
// Explicitly NOT push-to-talk: one tap opens a continuous conversation (VAD detects each utterance's
// start/end on its own, no holding anything down), a second tap closes it. See the plan's hard
// constraint #4 -- push-to-talk was explicitly rejected.
var conversationOpen = false;
var vadHangoverMs = parseInt(Q.get('vadHangoverMs'), 10) || 800;
var vad = window.createClaudeVoiceVAD ? window.createClaudeVoiceVAD({ hangoverMs: vadHangoverMs }) : null;
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
      // Re-check AFTER the async STT round trip: if speech started playing while this was in
      // flight, the utterance may have caught the speaker's first words -- drop it, never
      // ghost-send it as a turn.
      if (suppressVAD) return;
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
    vad.start(onVADSpeechStart, onVADSpeechEnd, onVADLevel).catch(function (e) {
      conversationOpen = false;
      syncMicUI();
      setStatus('error', 'Microphone access failed: ' + e.message);
    });
  }
  syncMicUI();
};

// ---- Voice panel (right side): mic + speaker icon toggles, ripples, Project/Settings ----
// The mic icon IS the listening toggle (same action as the knob tap) -- crossed out when off,
// rippling outward when it hears sound. The speaker icon gates the spoken read-back of replies
// (text always renders either way) -- crossed out when off, pulsing while actually speaking.
function syncMicUI() {
  $('micBtn').classList.toggle('on', conversationOpen);
  $('micBtn').classList.toggle('off', !conversationOpen);
}
var speakEnabled = localStorage.getItem('cvSpeakEnabled') !== '0';   // persists across page switches/reloads
function syncSpkUI() {
  $('spkBtn').classList.toggle('on', speakEnabled);
  $('spkBtn').classList.toggle('off', !speakEnabled);
}
$('micBtn').onclick = function () { window.oqxToggleConversation(); };
$('spkBtn').onclick = function () {
  speakEnabled = !speakEnabled;
  localStorage.setItem('cvSpeakEnabled', speakEnabled ? '1' : '0');
  if (!speakEnabled) stopTurnAudio();   // muting mid-reply drops the stream; the server aborts synthesis on the socket close
  syncSpkUI();
};
// Ripples: spawn one expanding ring per level sample above the ripple floor, throttled so a
// sustained voice reads as a steady outward pulse rather than a solid blob.
var lastRippleAt = 0;
function onVADLevel(level) {
  if (!conversationOpen || suppressVAD) return;
  var now = Date.now();
  if (level < 0.012 || now - lastRippleAt < 180) return;
  lastRippleAt = now;
  var r = document.createElement('div');
  r.className = 'ripple';
  $('micRipples').appendChild(r);
  r.addEventListener('animationend', function () { r.remove(); });
}
// ---- Change folder overlay ----
// ("Folder", not "project" -- Claude has its own "projects" concept, so the panel never uses that
// word for directories.) Picks restart the session in the chosen directory (fresh conversation; the
// old session file stays resumable from a terminal). One flowing wall of pill chips: recent folders
// first (accent border), then everything under the root alphabetically; the current folder is the
// single solid accent-filled pill.
function baseName(p) { return String(p || '').split(/[\\/]/).filter(Boolean).pop() || p; }
function setProjectHeader(dir) { $('project').textContent = dir ? baseName(dir) : '(no folder set)'; }
var projRoot = '';
function pickProject(dir) {
  $('projectOverlay').classList.add('hidden');
  setStatus('thinking', '');
  fetch('/claude-voice/session/start', {
    method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ projectDir: dir }),
  }).then(function (r) { return r.json(); })
    .then(function (r) { if (!r || !r.ok) setStatus('error', 'Could not start a session in ' + dir); })
    .catch(function () { setStatus('error', 'Could not reach the panel server.'); });
}
// Loads (or reloads) the overlay listing `browsePath` -- omitted on first open, so the server
// falls back to the page's configured root. Tapping folders (rows or Recent chips) only NAVIGATES
// -- into the folder, ⬆ Up back out -- and the overlay stays open; the single commit action is
// "Use this folder", which starts a session at whatever level is being browsed (the standard
// mobile folder-picker pattern, chosen explicitly by the user 2026-08-12).
function openProjectOverlay(browsePath) {
  var url = '/claude-voice/projects' + (browsePath ? '?path=' + encodeURIComponent(browsePath) : '');
  fetch(url, { cache: 'no-store' }).then(function (r) { return r.json(); })
    .then(function (p) {
      projRoot = p.root || '';
      $('projPath').textContent = projRoot;
      $('projUp').disabled = !p.parent;
      $('projUp').onclick = function () { if (p.parent) openProjectOverlay(p.parent); };
      $('projUse').onclick = function () { pickProject(projRoot); };
      // Recent row: chips COMMIT -- one tap starts a session in that folder and closes the menu
      // (that's the whole point of recents). Only the main list navigates.
      var recentsRow = $('projRecentsRow');
      recentsRow.querySelectorAll('.projChip').forEach(function (c) { c.remove(); });
      var pathEl = $('projPath');
      (p.recents || []).slice(0, 5).forEach(function (dir) {
        var chip = document.createElement('button');
        chip.type = 'button'; chip.className = 'projChip';
        chip.textContent = baseName(dir); chip.title = dir;
        chip.onclick = function () { pickProject(dir); };
        recentsRow.insertBefore(chip, pathEl);
      });
      // Folder taps NAVIGATE into the folder (so sub-folders are reachable); only the
      // "Use this folder" button actually starts a session, at whatever level is being browsed.
      $('projList').innerHTML = '';
      (p.dirs || []).forEach(function (dir) {
        var row = document.createElement('div');
        row.className = 'projRow' + (dir === p.current ? ' current' : '');
        var name = document.createElement('button');
        name.type = 'button'; name.className = 'projName';
        name.textContent = baseName(dir); name.title = dir;
        name.onclick = function () { openProjectOverlay(dir); };
        row.appendChild(name);
        $('projList').appendChild(row);
      });
      $('projNewName').value = '';
      $('projectOverlay').classList.remove('hidden');
    })
    .catch(function () { setStatus('error', 'Could not load the folder list.'); });
}
// ▲/▼ page buttons for the folder list -- replaced the custom drag-thumb, which only registered
// ~1 in 5 finger drags on the real panel. Tap = one page; hold = keeps paging every 400ms.
(function wireProjScrollButtons() {
  var list = $('projList');
  function step(dir) { list.scrollBy({ top: dir * list.clientHeight * 0.9, behavior: 'smooth' }); }
  [['projScrollUp', -1], ['projScrollDown', 1]].forEach(function (pair) {
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
})();
$('vpProject').onclick = function () { openProjectOverlay(); };
$('projCancel').onclick = function () { $('projectOverlay').classList.add('hidden'); };
$('projCreate').onclick = function () {
  var name = $('projNewName').value.trim();
  if (!name || !projRoot) return;
  if (/[<>:"|?*\\/]/.test(name)) { setStatus(conversationOpen ? 'listening' : 'idle', 'Folder names can\'t contain < > : " | ? * \\ /'); return; }
  pickProject(projRoot.replace(/[\\/]+$/, '') + '\\' + name);
};
$('vpSettings').onclick = function () { $('settingsOverlay').classList.remove('hidden'); };
$('settingsClose').onclick = function () { $('settingsOverlay').classList.add('hidden'); };

// ---- Panel-tunable settings (persisted server-side into the page's options in config.json) ----
function postOption(key, value) {
  fetch('/claude-voice/option', {
    method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key: key, value: String(value) }),
  }).catch(function () {});
}
// Chat text size: applies live via the --chatFont CSS var (bubbles only; chrome is unaffected).
var chatFontSize = parseInt(Q.get('chatFontSize'), 10) || 16;
function applyChatFont() {
  chatFontSize = Math.max(12, Math.min(32, chatFontSize));
  document.documentElement.style.setProperty('--chatFont', chatFontSize + 'px');
  $('fontVal').textContent = chatFontSize + ' px';
}
$('fontMinus').onclick = function () { chatFontSize -= 1; applyChatFont(); postOption('chatFontSize', chatFontSize); };
$('fontPlus').onclick = function () { chatFontSize += 1; applyChatFont(); postOption('chatFontSize', chatFontSize); };
// Voice pause tolerance: how long a mid-sentence silence can last before the utterance is sent.
function applyPause() {
  vadHangoverMs = Math.max(400, Math.min(2500, vadHangoverMs));
  if (vad && vad.setHangoverMs) vad.setHangoverMs(vadHangoverMs);
  $('pauseVal').textContent = (vadHangoverMs / 1000).toFixed(1) + ' s';
}
$('pauseMinus').onclick = function () { vadHangoverMs -= 100; applyPause(); postOption('vadHangoverMs', vadHangoverMs); };
$('pausePlus').onclick = function () { vadHangoverMs += 100; applyPause(); postOption('vadHangoverMs', vadHangoverMs); };
applyChatFont();
applyPause();

// ---- Permission mode (Mode button + overlay) ----
// Switching restarts the claude process with --resume + the new --permission-mode (mode is a
// launch-only CLI flag; the mid-session control message is undocumented/unsupported). The
// conversation itself carries over -- expect a ~2s pause before the next turn responds.
var MODE_LABELS = { manual: 'Manual', acceptEdits: 'Accept edits', plan: 'Plan', bypassPermissions: 'Full auto' };
var currentMode = '';
function syncModeUI() {
  $('vpMode').textContent = currentMode ? 'Mode: ' + (MODE_LABELS[currentMode] || currentMode) : 'Mode';
  document.querySelectorAll('.modeOpt').forEach(function (b) {
    b.classList.toggle('current', b.getAttribute('data-mode') === currentMode);
  });
}
$('vpMode').onclick = function () { syncModeUI(); $('modeOverlay').classList.remove('hidden'); };
$('modeCancel').onclick = function () { $('modeOverlay').classList.add('hidden'); };
document.querySelectorAll('.modeOpt').forEach(function (btn) {
  btn.onclick = function () {
    var mode = btn.getAttribute('data-mode');
    $('modeOverlay').classList.add('hidden');
    if (!mode || mode === currentMode) return;
    fetch('/claude-voice/permission-mode', {
      method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: mode }),
    }).then(function (r) { return r.json(); })
      .then(function (r) {
        if (!r || !r.ok) setStatus(conversationOpen ? 'listening' : 'idle', 'Mode switch failed — is a session running yet? (Send a message first.)');
      })
      .catch(function () { setStatus('error', 'Could not reach the panel server.'); });
  };
});

syncMicUI();
syncSpkUI();
syncModeUI();

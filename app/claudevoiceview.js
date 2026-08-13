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
      // Sentence-streaming speech: feed the live text into the speech splitter so talking starts
      // as sentences complete, not after the whole reply lands. Voice-initiated turns only.
      if (!speechTurnActive && lastTurnWasVoice && speakEnabled) speechTurnActive = true;
      if (speechTurnActive) { speechBuf += msg.text; drainSpeechBuf(false); }
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
      // Speech: if the sentence-streaming pipeline was active this turn, flush its remainder and
      // let the queue own the status until it drains. Otherwise fall back to whole-reply speak()
      // for voice turns that never streamed text (e.g. a result-only turn). Typed turns are never
      // spoken unsolicited.
      if (speechTurnActive) {
        drainSpeechBuf(true);
        speechTurnActive = false;
        maybeEndSpeech();
        if (msg.error) setStatus('error', msg.error);
      } else if (lastTurnWasVoice && !msg.error && speakEnabled) { speak(finalText); }
      else { setStatus(conversationOpen ? 'listening' : 'idle', msg.error); }
      lastTurnWasVoice = false;
    } else if (msg.type === 'error') {
      stopSpeech();
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
      stopSpeech();
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
  text = prepWholeSpeech(text);   // speech-only cleanup; the on-screen text is never altered
  if (!text) { if (onDone) onDone(); return; }
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

// ---- Sentence-streaming speech (voice turns) ----
// Speaks the reply WHILE it streams: complete sentences are cut out of the live delta text, each
// synthesized via POST /claude-voice/tts, and played back through a strictly-ordered queue (the
// next sentence synthesizes while the current one plays). Fenced code blocks are never read
// aloud -- each block becomes the announcement below, once, and the code stays on screen.
// Thinking can never be spoken: only text_delta events reach the page at all.
var CODE_ANNOUNCE = "Code's on screen.";
var TABLE_ANNOUNCE = "Table's on screen.";
var speechQueue = [];          // {text, id, ready, failed} in speaking order
var speechPlaying = false;
var speechBuf = '';            // streamed text not yet cut into sentences
var speechInFence = false;     // currently inside a ``` block (content dropped for speech)
var speechTurnActive = false;  // this turn is voice-initiated and speaker is on
var speechInTable = false;     // consecutive table-row chunks announce only once per table
var currentSpeechAudio = null;
// Generation token: bumped by stopSpeech(). Every timer/callback armed by playNextSpeech captures
// the generation it was born in and goes inert if it fires after a stop. This is THE fix for the
// two-voices-overtalking bug (verified root cause 2026-08-12): stopping speech mid-playback (e.g.
// a folder switch) couldn't reach a playing sentence's closure-local watchdog; when that orphaned
// watchdog later fired it freed speechPlaying while the NEW conversation's audio was mid-sentence,
// forking a second player chain.
var speechGen = 0;

// Speech-ONLY text cleanup -- the display path never touches this; the screen always shows the
// raw text. Piper reads markdown source miserably, so for the speaker: links become their label,
// URLs become the bare hostname, file paths become the filename, UUIDs/hex become a word, and
// markdown markers / arrows / bullets / emoji vanish.
function speechSanitize(text) {
  var s = String(text || '');
  s = s.replace(/!?\[([^\]]*)\]\(([^)]*)\)/g, '$1');                               // [label](url) -> label
  s = s.replace(/\bhttps?:\/\/([^\s/)\]>]+)[^\s)\]>]*/gi, function (m, host) {     // bare URL -> "host dot com"
    return host.replace(/^www\./i, '').replace(/:\d+$/, '').replace(/\./g, ' dot ');
  });
  s = s.replace(/(?:[A-Za-z]:)?(?:\\[\w.\-~]+)+\\?/g, function (m) {               // windows path -> filename
    var parts = m.split('\\').filter(Boolean);
    return parts.length ? parts[parts.length - 1].replace(/^[A-Za-z]:$/, '') : '';
  });
  s = s.replace(/(^|\s)(~?\/[\w.\-/]+|[\w.\-]+(?:\/[\w.\-]+){2,})/g, function (m, pre, p) {   // unix-ish path -> filename
    var parts = p.split('/').filter(Boolean);
    return pre + (parts.length ? parts[parts.length - 1] : '');
  });
  s = s.replace(/\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g, 'an ID');
  s = s.replace(/\b(?=[0-9a-fA-F]*\d)(?=[0-9a-fA-F]*[a-fA-F])[0-9a-fA-F]{7,40}\b/g, 'a hash');   // hex runs (needs a digit AND a letter -- plain numbers survive)
  s = s.replace(/[←-⇿⌀-➿⬀-⯿■-◿★☆•·\u{1F000}-\u{1FAFF}]/gu, ' ');  // arrows, checks, bullets, emoji
  s = s.replace(/^[ \t]*#{1,6}[ \t]*/gm, '');                                       // heading markers
  s = s.replace(/^[ \t]*>+[ \t]*/gm, '');                                           // blockquote markers
  s = s.replace(/(\*\*|__|[*`])/g, ' ');                                            // emphasis/backtick markers
  return s.replace(/\s+/g, ' ').trim();
}

function enqueueSentence(text) {
  var raw = String(text || '');
  // Markdown tables: rows are dropped from speech; each table announces itself exactly once
  // (consecutive table-row chunks share one announcement; any prose in between resets it).
  var kept = [], sawTable = false;
  raw.split('\n').forEach(function (ln) {
    if (/^\s*\|/.test(ln)) sawTable = true;
    else if (ln.trim()) kept.push(ln);
  });
  var announceTable = sawTable && !speechInTable;
  speechInTable = sawTable;
  text = speechSanitize(kept.join(' '));
  if (announceTable) text = (text ? text + ' ' : '') + TABLE_ANNOUNCE;
  if (!text) return;
  enqueueSpeechItem(text);
}
// Adds already-sanitized text to the playback queue. This queue is the ONLY audio path in the app
// -- speak() feeds it too -- so two streams can never talk over each other.
function enqueueSpeechItem(text) {
  var item = { text: text, id: null, ready: false, failed: false };
  speechQueue.push(item);
  fetch('/claude-voice/tts', {
    method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: text }),
  }).then(function (r) { return r.json(); })
    .then(function (r) { if (r && r.ok && r.id) item.id = r.id; else item.failed = true; item.ready = true; playNextSpeech(); })
    .catch(function () { item.failed = true; item.ready = true; playNextSpeech(); });
}
// Cuts complete sentences (through the LAST . ! ? or newline) out of `text`, enqueues them, and
// returns the incomplete remainder.
function cutSentences(text) {
  var m = text.match(/[\s\S]*(?:[.!?](?=\s|$)|\n)/);
  if (!m) return text;
  enqueueSentence(m[0]);
  return text.slice(m[0].length);
}
function drainSpeechBuf(final) {
  for (;;) {
    var idx = speechBuf.indexOf('```');
    if (idx < 0) break;
    if (!speechInFence) {
      var before = speechBuf.slice(0, idx);
      if (before.trim()) enqueueSentence(before);
      enqueueSentence(CODE_ANNOUNCE);
    }
    speechBuf = speechBuf.slice(idx + 3);
    speechInFence = !speechInFence;
  }
  if (speechInFence) {
    // Inside a block: drop the content, keeping only a tail that could be a split ``` marker.
    if (speechBuf.length > 2) speechBuf = speechBuf.slice(-2);
    return;
  }
  if (final) { if (speechBuf.trim()) enqueueSentence(speechBuf); speechBuf = ''; }
  else speechBuf = cutSentences(speechBuf);
}
// Watchdog: 30s per QUEUE ITEM (one sentence of Claude's reply -- normally 2-5s to synthesize and
// play). This never touches the user's own speech; the mic side has no timer at all. It exists
// because a hung TTS request or an <audio> that never fires ended/error would otherwise hold
// suppressVAD forever -- the "conversation is on but the mic ignores me" stuck state.
var SPEECH_ITEM_TIMEOUT_MS = 30000;
function playNextSpeech() {
  var gen = speechGen;   // closures below go inert if stopSpeech() bumps the generation
  if (speechPlaying) return;
  while (speechQueue.length && speechQueue[0].ready && speechQueue[0].failed) speechQueue.shift();
  if (!speechQueue.length) { maybeEndSpeech(); return; }
  if (!speechQueue[0].ready) {
    // Head still synthesizing: give it a deadline so a hung /tts fetch can't wedge the queue.
    var head = speechQueue[0];
    if (!head.deadline) {
      head.deadline = setTimeout(function () {
        if (gen !== speechGen) return;
        if (!head.ready) { head.ready = true; head.failed = true; playNextSpeech(); }
      }, SPEECH_ITEM_TIMEOUT_MS);
    }
    maybeEndSpeech();
    return;
  }
  var item = speechQueue.shift();
  clearTimeout(item.deadline);
  speechPlaying = true;
  suppressVAD = true;   // held through the whole queue so the mic never hears the speaker
  setStatus('speaking');
  $('spkBtn').classList.add('pulsing');
  var audio = currentSpeechAudio = new Audio('/claude-voice/tts-audio?id=' + encodeURIComponent(item.id));
  var finished = false;
  var done = function () {
    if (finished || gen !== speechGen) return;   // stale generation: a stop already superseded us
    finished = true;
    clearTimeout(playTimer);
    try { audio.pause(); } catch (e) {}          // belt-and-braces: never advance over a sounding element
    if (currentSpeechAudio === audio) currentSpeechAudio = null;
    speechPlaying = false;
    playNextSpeech();
  };
  // Playback deadline: a sentence's audio that hasn't ENDED after 30s of no progress is stuck.
  // Reset the timer while playback advances so a genuinely long sentence is never cut off.
  var playTimer = setTimeout(function check() {
    if (finished || gen !== speechGen) return;
    if (!audio.paused && audio.currentTime > 0 && !audio.ended) {
      playTimer = setTimeout(check, SPEECH_ITEM_TIMEOUT_MS);   // progressing -- keep waiting
      return;
    }
    try { audio.pause(); } catch (e) {}
    done();
  }, SPEECH_ITEM_TIMEOUT_MS);
  audio.addEventListener('ended', done);
  audio.addEventListener('error', done);
  audio.play().catch(done);
}
function maybeEndSpeech() {
  if (speechPlaying || speechQueue.length || speechTurnActive) return;
  if (suppressVAD) {
    suppressVAD = false;
    $('spkBtn').classList.remove('pulsing');
    setStatus(conversationOpen ? 'listening' : 'idle');
  }
}
function stopSpeech() {
  speechGen++;   // every armed timer/callback from the old generation is now inert
  speechQueue.forEach(function (it) { clearTimeout(it.deadline); });
  speechQueue = []; speechBuf = ''; speechInFence = false; speechTurnActive = false; speechInTable = false;
  if (currentSpeechAudio) { try { currentSpeechAudio.pause(); } catch (e) {} currentSpeechAudio = null; }
  speechPlaying = false;
  maybeEndSpeech();
}
// Whole-text variant of the same cleanup, for the non-streaming speak() path (Test speech, and
// voice turns that never streamed): fences and tables become their one-line announcements inline.
function prepWholeSpeech(raw) {
  var out = [], inFence = false, inTable = false;
  String(raw || '').split('\n').forEach(function (ln) {
    if (/^\s*```/.test(ln)) { if (!inFence) out.push(CODE_ANNOUNCE); inFence = !inFence; return; }
    if (inFence) return;
    if (/^\s*\|/.test(ln)) { if (!inTable) out.push(TABLE_ANNOUNCE); inTable = true; return; }
    inTable = false;
    out.push(ln);
  });
  return speechSanitize(out.join(' '));
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
  if (!speakEnabled) stopSpeech();   // muting mid-reply cuts the current sentence and the queue
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
$('fontMinus').onclick = function () { chatFontSize -= 2; applyChatFont(); postOption('chatFontSize', chatFontSize); };
$('fontPlus').onclick = function () { chatFontSize += 2; applyChatFont(); postOption('chatFontSize', chatFontSize); };
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

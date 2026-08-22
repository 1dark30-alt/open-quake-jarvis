'use strict';
// Interactive Fiction player: panel chrome + voice, running inside Parchment's own page.
//
// vendor-parchment.js builds index.html by taking an upstream Parchment single-file release,
// externalising its inline scripts (open-quake serves drop-in apps under `script-src 'self'`) and
// injecting chrome.html + this file. So this runs in the SAME document as the interpreter -- there is
// no iframe, which also sidesteps the platform's `frame-ancestors 'none'`.
//
// Two integration points, both verified against the real interpreter:
//   read  -- new game text arrives as .BufferLine elements inside .BufferWindowInner
//   write -- GlkOte.send_event({type:'line', window:N, value}) submits a command, exactly as typing
//            does. Synthetic keyboard events on the input textarea do NOT work.
//
// Voice goes through the app's own server.js: POST /app-api/speak (text -> base64 WAV) and
// POST /app-api/listen (Int16 PCM -> transcript), both backed by the host's Wyoming TTS/STT config.
(function () {
  var q = new URLSearchParams(location.search);
  var DARK = q.get('_dark') !== '0';
  var ACCENT = /^#[0-9a-fA-F]{6}$/.test(q.get('_accent') || '') ? q.get('_accent') : '#7CFFB2';
  var OPT_STORY = (q.get('story') || '').trim();
  var WANT_SPEAK = q.get('speak') !== '0' && q.get('speak') !== 'false';
  var WANT_VOICE_IN = q.get('voiceInput') !== '0' && q.get('voiceInput') !== 'false';

  var el = function (id) { return document.getElementById(id); };
  var picker = el('picker'), storylist = el('storylist');
  var statusdot = el('statusdot'), statustext = el('statustext'), storyname = el('storyname');
  var heard = el('heard'), railnote = el('railnote');
  var speakbtn = el('speakbtn'), listenbtn = el('listenbtn'), stopbtn = el('stopbtn');

  document.documentElement.style.setProperty('--if-accent', ACCENT);
  document.documentElement.setAttribute('data-theme', DARK ? 'dark' : 'light');
  document.body.classList.add(DARK ? 'if-dark' : 'if-light');
  if (!WANT_VOICE_IN) document.body.classList.add('novoicein');

  var caps = { tts: false, stt: false };
  var narrating = false, listening = false;
  var speakQueue = [], audio = null, speaking = false;
  var vad = null, observer = null, gwin = 0;

  function setStatus(cls, text) { statusdot.className = 'dot ' + (cls || ''); statustext.textContent = text; }
  function note(msg) { railnote.textContent = msg || ''; }

  // ---- story resolution -------------------------------------------------
  // A bare filename means the app's stories/ folder; anything with a scheme is passed through.
  function storyUrl(value) {
    if (/^https?:\/\//i.test(value)) return value;
    return new URL('stories/' + encodeURIComponent(String(value).split(/[\\/]/).pop()), location.href).href;
  }
  // Parchment reads its story from ?story= at launch, so switching stories is a navigation. Our own
  // options are carried across so the page comes back themed and configured the same way.
  function loadStory(value) {
    var keep = new URLSearchParams(location.search);
    keep.set('story', value);
    keep.set('autoplay', '1');
    location.search = keep.toString();
  }
  function showPicker(stories, hint) {
    picker.hidden = false;
    document.body.classList.add('picking');
    setStatus('', 'No story loaded');
    el('pickerhint').textContent = hint || (stories.length ? 'Choose a story' : '');
    storylist.innerHTML = '';
    if (!stories.length) {
      var empty = document.createElement('div');
      empty.className = 'pk-empty';
      empty.textContent = 'Put .z5 / .z8 / .zblorb / .ulx / .gblorb story files in the app’s stories folder, '
        + 'or set a story file or URL in this page’s app options.';
      storylist.appendChild(empty);
      return;
    }
    stories.forEach(function (name) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'story';
      b.textContent = name.replace(/\.[^.]+$/, '');
      b.addEventListener('click', function () { loadStory(name); });
      storylist.appendChild(b);
    });
  }

  // ---- the interpreter ---------------------------------------------------
  function glkote() {
    try { return window.parchment.options.GlkOte; } catch (e) { return null; }
  }
  // Poll until Parchment has rendered a buffer window. It fetches a WASM core and the story first, so
  // there is no single load event to hang this on.
  function waitForGame() {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var inner = document.querySelector('.BufferWindowInner');
      if (inner) { clearInterval(timer); attach(inner); }
      else if (tries > 200) {                       // ~40s
        clearInterval(timer);
        setStatus('bad', 'Story failed to load');
        note('Check the story file name, and that it is a Z-code or Glulx file.');
      }
    }, 200);
  }
  function attach(inner) {
    var frameEl = document.querySelector('.BufferWindow');
    gwin = parseInt(String(frameEl && frameEl.id || '').replace(/\D+/g, ''), 10) || 0;
    setStatus('ok', 'Playing');
    document.body.classList.add('playing');
    if (observer) observer.disconnect();
    // New game text = added .BufferLine nodes. Batch them so one passage becomes one utterance.
    observer = new MutationObserver(function (muts) {
      var text = [];
      muts.forEach(function (m) {
        [].forEach.call(m.addedNodes, function (n) {
          if (n.nodeType !== 1 || !n.classList || !n.classList.contains('BufferLine')) return;
          var t = (n.innerText || '').replace(/\s+/g, ' ').trim();
          if (!t || t.charAt(0) === '>') return;     // blank, or the echoed player command
          text.push(t);
        });
      });
      if (text.length) enqueueSpeech(text.join(' '));
    });
    observer.observe(inner, { childList: true, subtree: true });
    focusGame();
  }
  function focusGame() {
    try { var input = document.querySelector('.Input'); if (input) input.focus(); } catch (e) {}
  }
  function sendCommand(text) {
    var G = glkote();
    if (!G || !text) return false;
    try { G.send_event({ type: 'line', window: gwin, value: text }); return true; }
    catch (e) { return false; }
  }

  // ---- narration (TTS) --------------------------------------------------
  function enqueueSpeech(text) {
    if (!narrating || !text) return;
    speakQueue.push(text);
    if (!speaking) drainSpeech();
  }
  function drainSpeech() {
    if (!speakQueue.length) { speaking = false; updateButtons(); return; }
    var text = speakQueue.shift();
    speaking = true;
    updateButtons();
    fetch('/app-api/speak', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: text })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok || !j.wav) { note(j && j.error || 'Narration unavailable'); speakQueue = []; speaking = false; updateButtons(); return; }
        playWav(j.wav);
      })
      .catch(function () { speakQueue = []; speaking = false; updateButtons(); });
  }
  function playWav(b64) {
    stopAudio();
    audio = new Audio('data:audio/wav;base64,' + b64);
    audio.addEventListener('ended', function () { audio = null; drainSpeech(); });
    audio.addEventListener('error', function () { audio = null; drainSpeech(); });
    audio.play().catch(function () { audio = null; drainSpeech(); });
  }
  function stopAudio() { if (audio) { try { audio.pause(); } catch (e) {} audio = null; } }
  function hush() { speakQueue = []; stopAudio(); speaking = false; updateButtons(); }

  // ---- voice commands (STT) ---------------------------------------------
  function startListening() {
    if (listening) return;
    if (!window.createClaudeVoiceVAD) { note('Voice capture unavailable'); return; }
    vad = window.createClaudeVoiceVAD({ hangoverMs: 700, minSpeechMs: 250 });
    vad.start(function () {}, function (pcm) { onUtterance(pcm); })
      .then(function () { listening = true; updateButtons(); note('Say a command, e.g. “go north”.'); })
      .catch(function (e) {
        listening = false; vad = null; updateButtons();
        note('Microphone unavailable: ' + (e && e.message || 'permission denied'));
      });
  }
  function stopListening() {
    if (vad) { try { vad.stop(); } catch (e) {} }
    vad = null; listening = false; updateButtons();
  }
  function onUtterance(pcm) {
    // Never transcribe our own narration: while a passage is being read the mic is mostly hearing the
    // speaker, so drop whatever it captured.
    if (speaking || (audio && !audio.paused)) return;
    heard.textContent = '…';
    fetch('/app-api/listen', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: pcm })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) { heard.textContent = ''; note(j && j.error || 'Could not transcribe'); return; }
        var text = cleanCommand(j.text);
        if (!text) { heard.textContent = ''; return; }
        heard.textContent = '“' + text + '”';
        sendCommand(text);
      })
      .catch(function () { heard.textContent = ''; });
  }
  // Whisper punctuates and capitalises dictation; parsers want bare words.
  function cleanCommand(raw) {
    return String(raw || '').replace(/[.!?,;:"']+$/g, '').replace(/^[\s.,!?]+/, '').trim().toLowerCase();
  }

  // ---- buttons ----------------------------------------------------------
  function updateButtons() {
    el('speaksub').textContent = !caps.tts ? 'No TTS' : (speaking ? 'Reading…' : (narrating ? 'On' : 'Off'));
    speakbtn.classList.toggle('on', narrating && caps.tts);
    speakbtn.disabled = !caps.tts;
    el('listensub').textContent = !caps.stt ? 'No STT' : (listening ? 'Listening' : 'Off');
    listenbtn.classList.toggle('on', listening);
    listenbtn.disabled = !caps.stt;
    stopbtn.disabled = !speaking && !speakQueue.length;
  }
  // pointerdown + preventDefault: tapping a control must never pull focus off the game, or the next
  // thing typed on the keyboard would go nowhere.
  function wire(btn, fn) {
    btn.addEventListener('pointerdown', function (e) { e.preventDefault(); });
    btn.addEventListener('click', function (e) { e.preventDefault(); fn(); focusGame(); });
  }
  wire(speakbtn, function () {
    narrating = !narrating;
    if (!narrating) hush();
    updateButtons();
    note(narrating ? 'Reading new passages aloud.' : '');
  });
  wire(listenbtn, function () { listening ? stopListening() : startListening(); });
  wire(stopbtn, hush);

  // ---- boot -------------------------------------------------------------
  fetch('/app-api/config').then(function (r) { return r.json(); }).then(function (j) {
    caps.tts = !!(j && j.tts); caps.stt = !!(j && j.stt);
    narrating = WANT_SPEAK && caps.tts;
    updateButtons();
    if (!caps.tts && WANT_SPEAK) note('Set a TTS server in Settings → TTS/STT to hear the story.');
    if (OPT_STORY) { storyname.textContent = OPT_STORY.split(/[\\/]/).pop(); setStatus('busy', 'Loading story…'); waitForGame(); }
    else showPicker((j && j.stories) || []);
  }).catch(function () {
    updateButtons();
    if (OPT_STORY) { setStatus('busy', 'Loading story…'); waitForGame(); } else showPicker([], 'Story list unavailable');
  });

  // Keep the keyboard pointed at the game when the panel returns to this page.
  window.addEventListener('focus', focusGame);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) focusGame(); });

  // Safety net for the physical keyboard: if focus is sitting on our chrome (say, just after tapping
  // a rail button) a keystroke would otherwise be swallowed. Hand focus back to the game and replay
  // the character, so nothing the player types is lost.
  //
  // Two behaviours of GlkOte shape this. Focusing the input leaves document.activeElement on the
  // enclosing .BufferWindow frame, not the textarea -- so "is the game focused?" has to test
  // containment, or this would fire on every keystroke and double up. And its focus setup can reset
  // the field, which swallows a character appended in the same tick; deferring the replay by a tick
  // avoids that. Only the first keystroke is ever replayed, so ordering stays intact.
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    var input = document.querySelector('.Input');
    if (!input) return;
    var ae = document.activeElement;
    if (ae === input || (ae && ae !== document.body && ae.contains && ae.contains(input))) return;
    input.focus();
    if (e.key && e.key.length === 1) {
      e.preventDefault();
      var ch = e.key;
      setTimeout(function () { try { input.value += ch; } catch (err) {} }, 0);
    }
  });
})();

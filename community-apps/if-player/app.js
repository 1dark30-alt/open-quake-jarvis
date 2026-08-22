'use strict';
// Interactive Fiction player: panel chrome + voice around Parchment.
//
// Parchment's single-file build runs untouched inside an iframe (same origin, so no build-time
// integration and upgrades are a file swap). Two hooks, both verified against the real interpreter:
//   read  -- new game text arrives as .BufferLine elements inside .BufferWindowInner
//   write -- GlkOte.send_event({type:'line', window:N, value}) submits a command, exactly as typing does
// Synthetic keyboard events on the input textarea do NOT work; send_event is the supported path.
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
  var frame = el('game'), picker = el('picker'), storylist = el('storylist');
  var statusdot = el('statusdot'), statustext = el('statustext'), storyname = el('storyname');
  var heard = el('heard'), railnote = el('railnote');
  var speakbtn = el('speakbtn'), listenbtn = el('listenbtn'), stopbtn = el('stopbtn');

  document.documentElement.style.setProperty('--accent', ACCENT);
  if (!DARK) document.body.classList.add('light');

  var caps = { tts: false, stt: false };
  var narrating = false, listening = false;
  var speakQueue = [], audio = null, speaking = false;
  var vad = null, observer = null, gwin = 0;

  function setStatus(cls, text) {
    statusdot.className = 'dot ' + (cls || '');
    statustext.textContent = text;
  }
  function note(msg) { railnote.textContent = msg || ''; }

  // ---- story resolution -------------------------------------------------
  // A bare filename means the app's stories/ folder; anything with a scheme is passed through.
  function storyUrl(value) {
    if (/^https?:\/\//i.test(value)) return value;
    return new URL('stories/' + encodeURIComponent(String(value).split(/[\\/]/).pop()), location.href).href;
  }
  function loadStory(value) {
    var url = storyUrl(value);
    // Parchment picks its theme during launch from this cookie (same origin, so we can set it) --
    // without it the first paint flashes its light default before styleGame() lands.
    try { document.cookie = 'parchment_theme=' + (DARK ? 'dark' : 'light') + ';path=/;max-age=31536000;SameSite=Lax'; } catch (e) {}
    storyname.textContent = String(value).split(/[\\/]/).pop();
    picker.hidden = true;
    frame.hidden = false;
    setStatus('busy', 'Loading story…');
    // Parchment's supported entry point: ?story=<absolute url> on its own page. autoplay=1 is
    // required because Parchment defaults it to `window.self === window.top` -- i.e. off inside an
    // iframe, where it would otherwise wait behind a "Play!" button.
    frame.src = 'interpreter/parchment-single.html?autoplay=1&story=' + encodeURIComponent(url);
    waitForGame();
  }
  function showPicker(stories, hint) {
    frame.hidden = true;
    picker.hidden = false;
    setStatus('', 'No story loaded');
    el('pickerhint').textContent = hint || (stories.length ? 'Choose a story' : '');
    storylist.innerHTML = '';
    if (!stories.length) {
      var empty = document.createElement('div');
      empty.className = 'pk-empty';
      empty.textContent = 'Drop .z5/.z8/.zblorb/.ulx/.gblorb story files into the app’s stories folder, '
        + 'or set a story URL in this page’s app options.';
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

  // ---- the game frame ---------------------------------------------------
  function gameDoc() {
    try { return frame.contentDocument; } catch (e) { return null; }
  }
  function glkote() {
    try { return frame.contentWindow.parchment.options.GlkOte; } catch (e) { return null; }
  }
  // Poll until Parchment has rendered a buffer window, then attach. Parchment fetches a WASM core and
  // the story before anything exists, so there is no single load event to hang this on.
  function waitForGame() {
    var tries = 0;
    var timer = setInterval(function () {
      tries++;
      var d = gameDoc();
      var inner = d && d.querySelector('.BufferWindowInner');
      if (inner) {
        clearInterval(timer);
        attach(d, inner);
      } else if (tries > 150) {                      // ~30s
        clearInterval(timer);
        setStatus('bad', 'Story failed to load');
        note('Check the story file name and that it is a Z-code or Glulx file.');
      }
    }, 200);
  }
  function attach(d, inner) {
    var frameEl = d.querySelector('.BufferWindow');
    gwin = parseInt(String(frameEl && frameEl.id || '').replace(/\D+/g, ''), 10) || 0;
    setStatus('ok', 'Playing');
    styleGame(d);
    if (observer) observer.disconnect();
    // New game text = added .BufferLine nodes. Batch them: one passage becomes one utterance.
    observer = new MutationObserver(function (muts) {
      var text = [];
      muts.forEach(function (m) {
        [].forEach.call(m.addedNodes, function (n) {
          if (n.nodeType !== 1 || !n.classList || !n.classList.contains('BufferLine')) return;
          var t = (n.innerText || '').replace(/\s+/g, ' ').trim();
          if (!t || t === '>') return;
          if (t.charAt(0) === '>') return;           // echoed player command, not narration
          text.push(t);
        });
      });
      if (text.length) enqueueSpeech(text.join(' '));
    });
    observer.observe(inner, { childList: true, subtree: true });
    focusGame();
  }
  // The physical keyboard must reach the game, so the frame keeps focus; our buttons never take it.
  function focusGame() {
    try {
      frame.contentWindow.focus();
      var input = gameDoc() && gameDoc().querySelector('.Input');
      if (input) input.focus();
    } catch (e) {}
  }
  // Theme the interpreter through its own supported surface -- Parchment sets data-theme on <html> and
  // GlkOte reads --glkote-* custom properties -- so the vendored build stays a drop-in upgrade.
  var PALETTE = DARK
    ? { page: '#131a2c', bg: '#131a2c', fg: '#f2f5ff', gridbg: '#1a2338', gridfg: '#a7b1cf', input: ACCENT }
    : { page: '#ffffff', bg: '#ffffff', fg: '#141c2e', gridbg: '#eef2f9', gridfg: '#45526c', input: '#0b4c8e' };
  function styleGame(d) {
    try {
      d.documentElement.setAttribute('data-theme', DARK ? 'dark' : 'light');
      var s = d.createElement('style');
      s.textContent = [
        ':root{',
        '--glkote-page-bg:' + PALETTE.page + ';',
        '--glkote-buffer-bg:' + PALETTE.bg + ';--glkote-buffer-fg:' + PALETTE.fg + ';',
        '--glkote-grid-bg:' + PALETTE.gridbg + ';--glkote-grid-fg:' + PALETTE.gridfg + ';',
        '--glkote-input-fg:' + PALETTE.input + ';',
        '}',
        'body{background:' + PALETTE.page + ' !important;}',
        // Parchment centres the game in a 900px column. On a 1920x480 panel vertical space is the
        // scarce resource, so widen it: fewer wrapped lines, less scrolling. 1100px also gives the
        // status line room for the 80 columns games assume -- at 900px it was truncated mid-word.
        '#gameport{max-width:1100px !important;}',
        // Readable at arm's length; the default web sizing is far too small on this panel.
        '.BufferWindow{font-size:23px !important;line-height:1.5 !important;}',
        '.BufferWindowInner{padding:8px 16px !important;}',
        '.Input,.LineInput{font-size:23px !important;}',
        '.GridWindow{font-size:17px !important;}',
      ].join('');
      d.head.appendChild(s);
    } catch (e) {}
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
        if (!j || !j.ok || !j.wav) { note(j && j.error || 'Narration unavailable'); speaking = false; speakQueue = []; updateButtons(); return; }
        playWav(j.wav);
      })
      .catch(function () { speaking = false; speakQueue = []; updateButtons(); });
  }
  function playWav(b64) {
    stopAudio();
    audio = new Audio('data:audio/wav;base64,' + b64);
    audio.addEventListener('ended', function () { audio = null; drainSpeech(); });
    audio.addEventListener('error', function () { audio = null; drainSpeech(); });
    audio.play().catch(function () { audio = null; drainSpeech(); });
  }
  function stopAudio() {
    if (audio) { try { audio.pause(); } catch (e) {} audio = null; }
  }
  function hush() {
    speakQueue = [];
    stopAudio();
    speaking = false;
    updateButtons();
  }

  // ---- voice commands (STT) ---------------------------------------------
  function startListening() {
    if (listening) return;
    if (!window.createClaudeVoiceVAD) { note('Voice capture unavailable'); return; }
    vad = window.createClaudeVoiceVAD({ hangoverMs: 700, minSpeechMs: 250 });
    vad.start(
      function () { /* speech started */ },
      function (pcm) { onUtterance(pcm); }
    ).then(function () {
      listening = true;
      updateButtons();
      note('Say a command, e.g. "go north".');
    }).catch(function (e) {
      listening = false; vad = null;
      note('Microphone unavailable: ' + (e && e.message || 'permission denied'));
      updateButtons();
    });
  }
  function stopListening() {
    if (vad) { try { vad.stop(); } catch (e) {} }
    vad = null;
    listening = false;
    updateButtons();
  }
  function onUtterance(pcm) {
    // Never transcribe our own narration: while a passage is being read, the mic is only hearing the
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
    return String(raw || '')
      .replace(/[.!?,;:"']+$/g, '')
      .replace(/^[\s.,!?]+/, '')
      .trim()
      .toLowerCase();
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
    if (!WANT_VOICE_IN) document.body.classList.add('novoicein');
    updateButtons();
    if (!caps.tts && WANT_SPEAK) note('Set a TTS server in Settings → TTS/STT to hear the story.');
    if (OPT_STORY) loadStory(OPT_STORY);
    else showPicker((j && j.stories) || []);
  }).catch(function () {
    updateButtons();
    if (OPT_STORY) loadStory(OPT_STORY); else showPicker([], 'Story list unavailable');
  });

  // Keep the keyboard pointed at the game when the panel returns to this page.
  window.addEventListener('focus', focusGame);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) focusGame(); });

  // Safety net for the physical keyboard: if focus is sitting on our chrome rather than inside the
  // interpreter (after tapping a rail button, or right after load), a keystroke would otherwise be
  // swallowed. Forward it into the game's input so nothing the player types is ever lost.
  document.addEventListener('keydown', function (e) {
    if (e.ctrlKey || e.altKey || e.metaKey) return;
    var d = gameDoc();
    var input = d && d.querySelector('.Input');
    if (!input || d.activeElement === input) return;   // already typing into the game: leave it alone
    input.focus();
    if (e.key === 'Enter') {
      var pending = (input.value || '').trim();
      input.value = '';
      if (pending) sendCommand(pending);
      e.preventDefault();
    } else if (e.key && e.key.length === 1) {
      input.value += e.key;                            // the event already fired elsewhere; replay it
      e.preventDefault();
    }
  });
})();

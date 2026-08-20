'use strict';
// Screensaver page: four built-in canvas scenes (drawn live, no assets) + a dual-layer crossfade
// player for the user's own images/videos (DK-Vivid's proven pattern: preload into the idle layer,
// fade opacity, never reflow). Media files are addressed by NAME through /screensaver/media (the
// folder path itself is server-side only). Manual visits: a tap advances and reveals ⚙; when the
// screensaver auto-started, main.js swallows the waking input so none of this ever fires.

(function () {
  var Q = new URLSearchParams(location.search);
  var $ = function (id) { return document.getElementById(id); };

  // ---- theme (overlays only — the stage stays black by design) ----
  var accent = Q.get('_accent') || '#4da3ff';
  document.body.classList.toggle('light', Q.get('_dark') === '0');
  document.documentElement.style.setProperty('--accent', accent);
  // Contrast-safe text on the accent: don't assume every configured accent accepts dark text.
  (function () {
    var m = /^#?([0-9a-f]{6})$/i.exec(accent.trim());
    if (!m) return;
    var n = parseInt(m[1], 16), r = n >> 16 & 255, g = n >> 8 & 255, b = n & 255;
    var yiq = (r * 299 + g * 587 + b * 114) / 1000;
    document.documentElement.style.setProperty('--accent-fg', yiq >= 140 ? '#08121c' : '#ffffff');
  })();

  // ---- options (query-string delivery; panel edits POST /option and update this copy) ----
  var opts = {
    source: Q.get('source') || 'scenes',           // scenes | media | both
    scene: Q.get('scene') || 'all',                // all | aurora | starfield | coderain | clock
    fillMode: Q.get('fillMode') || 'cover',        // cover | contain (media only)
    intervalSec: parseInt(Q.get('intervalSec'), 10) || 10,
    shuffle: Q.get('shuffle') === '1',
    idleMinutes: Q.get('idleMinutes') || '10',
  };
  var SCENES = ['aurora', 'starfield', 'coderain', 'clock'];
  var files = [];              // [{name, kind:'image'|'video'}] from /state
  var mediaDirLabel = '';      // shown in settings
  var usingDefault = true;

  // =====================================================================================
  // Built-in scenes: tiny animation programs drawing 1920x480 frames. Each returns a stop().
  // =====================================================================================
  var W = 1920, H = 480;

  function sceneAurora(cv) {
    var ctx = cv.getContext('2d'), t = 0, run = true;
    var ribbons = [
      { amp: 90, f: 0.0032, speed: 0.012, hue: 150, width: 150, phase: 0 },
      { amp: 130, f: 0.0021, speed: -0.009, hue: 190, width: 190, phase: 2.1 },
      { amp: 70, f: 0.0044, speed: 0.017, hue: 265, width: 120, phase: 4.4 },
      { amp: 110, f: 0.0026, speed: -0.014, hue: 120, width: 170, phase: 5.6 },
    ];
    (function frame() {
      if (!run) return;
      t++;
      ctx.globalCompositeOperation = 'source-over';
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < ribbons.length; i++) {
        var r = ribbons[i], hue = (r.hue + t * 0.08) % 360;
        var grad = ctx.createLinearGradient(0, 0, W, 0);
        grad.addColorStop(0, 'hsla(' + hue + ',85%,55%,0)');
        grad.addColorStop(0.5, 'hsla(' + hue + ',85%,55%,0.16)');
        grad.addColorStop(1, 'hsla(' + ((hue + 40) % 360) + ',85%,55%,0)');
        ctx.strokeStyle = grad; ctx.lineWidth = r.width; ctx.lineCap = 'round';
        ctx.beginPath();
        for (var x = -40; x <= W + 40; x += 16) {
          var y = H / 2 + Math.sin(x * r.f + t * r.speed + r.phase) * r.amp
                        + Math.sin(x * r.f * 2.7 + t * r.speed * 1.6) * r.amp * 0.35;
          if (x === -40) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        }
        ctx.stroke();
      }
      requestAnimationFrame(frame);
    })();
    return function () { run = false; };
  }

  function sceneStarfield(cv) {
    var ctx = cv.getContext('2d'), run = true;
    var N = 420, stars = [];
    for (var i = 0; i < N; i++) stars.push({ x: Math.random() * 2 - 1, y: Math.random() * 2 - 1, z: Math.random() });
    (function frame() {
      if (!run) return;
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(0, 0, W, H);
      for (var i = 0; i < N; i++) {
        var s = stars[i];
        s.z -= 0.004 + s.z * 0.012;
        if (s.z <= 0.02) { s.x = Math.random() * 2 - 1; s.y = Math.random() * 2 - 1; s.z = 1; continue; }
        var px = W / 2 + (s.x / s.z) * (W / 2.2);
        var py = H / 2 + (s.y / s.z) * (H / 1.1);
        if (px < 0 || px >= W || py < 0 || py >= H) { s.x = Math.random() * 2 - 1; s.y = Math.random() * 2 - 1; s.z = 1; continue; }
        var b = Math.min(1, (1 - s.z) * 1.3), r = Math.max(0.6, (1 - s.z) * 3.2);
        ctx.fillStyle = 'rgba(' + (200 + (55 * b) | 0) + ',' + (210 + (45 * b) | 0) + ',255,' + b.toFixed(2) + ')';
        ctx.beginPath(); ctx.arc(px, py, r, 0, 6.2832); ctx.fill();
      }
      requestAnimationFrame(frame);
    })();
    return function () { run = false; };
  }

  function sceneCodeRain(cv) {
    var ctx = cv.getContext('2d'), run = true;
    var size = 22, cols = Math.ceil(W / size), drops = [];
    var glyphs = 'アイウエオカキクケコサシスセソタチツテトナニヌネノ0123456789ABCDEFXYZ<>[]{}#$+*';
    for (var i = 0; i < cols; i++) drops.push({ y: -(Math.random() * H), speed: 4 + Math.random() * 8 });
    ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
    (function frame() {
      if (!run) return;
      ctx.fillStyle = 'rgba(0,0,0,0.08)'; ctx.fillRect(0, 0, W, H);   // trail fade
      ctx.font = 'bold ' + size + 'px monospace';
      for (var i = 0; i < cols; i++) {
        var d = drops[i];
        d.y += d.speed;
        ctx.fillStyle = 'rgba(190,255,190,0.95)';                     // bright head
        ctx.fillText(glyphs[(Math.random() * glyphs.length) | 0], i * size, d.y);
        ctx.fillStyle = 'rgba(60,220,90,0.7)';                        // fresh tail glyph
        ctx.fillText(glyphs[(Math.random() * glyphs.length) | 0], i * size, d.y - size);
        if (d.y > H + size * 4) { d.y = -(Math.random() * 200); d.speed = 4 + Math.random() * 8; }
      }
      requestAnimationFrame(frame);
    })();
    return function () { run = false; };
  }

  function sceneClock(cv) {
    var ctx = cv.getContext('2d'), run = true, last = '';
    function draw() {
      var d = new Date();
      var hh = String(d.getHours()).padStart(2, '0'), mm = String(d.getMinutes()).padStart(2, '0'), ss = String(d.getSeconds()).padStart(2, '0');
      var key = hh + mm + ss;
      if (key !== last) {
        last = key;
        ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
        ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = '#e8eef4';
        ctx.font = '600 240px "Segoe UI", system-ui, sans-serif';
        ctx.fillText(hh + ':' + mm, W / 2 - 90, 300);
        ctx.fillStyle = 'rgba(160,190,220,0.85)';
        ctx.font = '600 84px "Segoe UI", system-ui, sans-serif';
        ctx.fillText(ss, W / 2 + 330, 300);
        ctx.fillStyle = 'rgba(140,160,185,0.9)';
        ctx.font = '400 44px "Segoe UI", system-ui, sans-serif';
        ctx.fillText(d.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }), W / 2, 400);
      }
      if (run) requestAnimationFrame(draw);
    }
    draw();
    return function () { run = false; };
  }

  var SCENE_FNS = { aurora: sceneAurora, starfield: sceneStarfield, coderain: sceneCodeRain, clock: sceneClock };

  // =====================================================================================
  // Playlist + dual-layer player
  // =====================================================================================
  var layers = [$('layerA'), $('layerB')];
  var front = 0;                 // which layer is currently shown
  var stopScene = [null, null];  // per-layer scene stop()
  var playlist = [], order = [], pos = -1;
  var advanceTimer = null, swapping = false;

  function buildPlaylist() {
    var items = [];
    var wantScenes = opts.source === 'scenes' || opts.source === 'both';
    var wantMedia = opts.source === 'media' || opts.source === 'both';
    if (wantScenes) {
      (opts.scene === 'all' ? SCENES : [opts.scene]).forEach(function (n) { items.push({ kind: 'scene', name: n }); });
    }
    if (wantMedia) files.forEach(function (f) { items.push({ kind: f.kind, name: f.name }); });
    playlist = items;
    reshuffle();
  }
  function reshuffle() {
    order = playlist.map(function (_, i) { return i; });
    if (opts.shuffle) for (var i = order.length - 1; i > 0; i--) {
      var j = (Math.random() * (i + 1)) | 0, t = order[i]; order[i] = order[j]; order[j] = t;
    }
  }

  function clearTimer() { if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = null; } }
  function armTimer(ms) { clearTimer(); advanceTimer = setTimeout(function () { advance(); }, ms); }
  function intervalMs() { return Math.max(3, opts.intervalSec) * 1000; }

  // Build the DOM for one playlist item inside a layer; call ready() once it can be shown.
  function loadInto(layerIdx, item, ready) {
    var layer = layers[layerIdx];
    if (stopScene[layerIdx]) { stopScene[layerIdx](); stopScene[layerIdx] = null; }
    layer.innerHTML = '';
    layer.classList.toggle('fit-cover', opts.fillMode !== 'contain');
    layer.classList.toggle('fit-contain', opts.fillMode === 'contain');
    if (item.kind === 'scene') {
      var cv = document.createElement('canvas');
      cv.width = W; cv.height = H;
      layer.appendChild(cv);
      stopScene[layerIdx] = SCENE_FNS[item.name] ? SCENE_FNS[item.name](cv) : null;
      ready();
    } else if (item.kind === 'image') {
      var img = document.createElement('img');
      var done = false, fin = function () { if (!done) { done = true; ready(); } };
      img.onload = fin; img.onerror = fin;
      img.src = '/screensaver/media?f=' + encodeURIComponent(item.name);
      layer.appendChild(img);
      setTimeout(fin, 4000);
    } else {
      var v = document.createElement('video');
      v.muted = true; v.autoplay = true; v.playsInline = true;
      if (playlist.length === 1) v.loop = true;
      else v.addEventListener('ended', function () { advance(); });
      var vdone = false, vfin = function () { if (!vdone) { vdone = true; ready(); } };
      v.addEventListener('canplaythrough', vfin);
      v.addEventListener('error', function () { vfin(); });
      v.src = '/screensaver/media?f=' + encodeURIComponent(item.name);
      layer.appendChild(v);
      setTimeout(vfin, 4000);
    }
  }

  function advance() {
    if (swapping || !playlist.length) return;
    swapping = true;
    clearTimer();
    pos++;
    if (pos >= order.length) { pos = 0; reshuffle(); }
    var item = playlist[order[pos]];
    var back = 1 - front;
    loadInto(back, item, function () {
      var was = front;
      layers[back].classList.add('show');
      layers[was].classList.remove('show');
      front = back;
      // After the fade completes, stop the hidden layer's scene / drop its media element.
      setTimeout(function () {
        if (stopScene[was]) { stopScene[was](); stopScene[was] = null; }
        layers[was].innerHTML = '';
        swapping = false;
      }, 900);
      // Images and scenes advance on the interval; videos advance on 'ended' (their own runtime
      // wins over the interval — DK does the same). Single-item playlists just sit there.
      if (playlist.length > 1 && item.kind !== 'video') armTimer(intervalMs());
    });
  }

  function restart() {
    clearTimer();
    swapping = false;
    pos = -1;
    buildPlaylist();
    var empty = !playlist.length;
    $('hint').classList.toggle('show', empty);
    layers.forEach(function (l, i) {
      l.classList.remove('show');
      if (stopScene[i]) { stopScene[i](); stopScene[i] = null; }
      l.innerHTML = '';
    });
    if (!empty) advance();
  }

  function fetchState(cb) {
    fetch('/screensaver/state').then(function (r) { return r.json(); }).then(function (s) {
      files = (s && s.files) || [];
      mediaDirLabel = (s && s.mediaDir) || '';
      usingDefault = !!(s && s.usingDefault);
      syncSettingsUI();
      if (cb) cb();
    }).catch(function () { files = []; if (cb) cb(); });
  }

  // =====================================================================================
  // Tap / gear / settings
  // =====================================================================================
  var gearTimer = null;
  function flashGear() {
    $('gear').classList.add('show');
    if (gearTimer) clearTimeout(gearTimer);
    gearTimer = setTimeout(function () { $('gear').classList.remove('show'); }, 5000);
  }
  $('stage').addEventListener('click', function () { advance(); flashGear(); });
  $('hint').addEventListener('click', function () { flashGear(); });
  $('gear').addEventListener('click', function (e) { e.stopPropagation(); openSettings(); });

  function postOption(key, value, cb) {
    fetch('/screensaver/option', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key: key, value: String(value) }),
    }).then(function (r) { return r.json(); }).then(function (j) { if (cb) cb(j && j.ok); })
      .catch(function () { if (cb) cb(false); });
  }

  // Segmented pickers: [value, label] pairs; a current value outside the list gets its own chip.
  function renderSeg(el, pairs, current, onPick) {
    var list = pairs.slice();
    if (!list.some(function (p) { return p[0] === String(current); })) list.push([String(current), String(current)]);
    el.innerHTML = '';
    list.forEach(function (p) {
      var b = document.createElement('button');
      b.textContent = p[1];
      if (p[0] === String(current)) b.classList.add('on');
      b.addEventListener('click', function () { onPick(p[0]); });
      el.appendChild(b);
    });
  }

  function syncSettingsUI() {
    renderSeg($('segSource'), [['scenes', 'Built-in scenes'], ['media', 'My media'], ['both', 'Both']], opts.source, function (v) {
      opts.source = v; postOption('source', v); syncSettingsUI(); restart();
    });
    renderSeg($('segScene'), [['all', 'All'], ['aurora', 'Aurora'], ['starfield', 'Starfield'], ['coderain', 'Code rain'], ['clock', 'Clock']], opts.scene, function (v) {
      opts.scene = v; postOption('scene', v); syncSettingsUI(); restart();
    });
    renderSeg($('segFill'), [['cover', 'Fill screen'], ['contain', 'Fit inside']], opts.fillMode, function (v) {
      opts.fillMode = v; postOption('fillMode', v); syncSettingsUI(); restart();
    });
    renderSeg($('segShuffle'), [['0', 'Off'], ['1', 'On']], opts.shuffle ? '1' : '0', function (v) {
      opts.shuffle = v === '1'; postOption('shuffle', v); syncSettingsUI(); restart();
    });
    renderSeg($('segInterval'), [['5', '5s'], ['10', '10s'], ['20', '20s'], ['30', '30s'], ['60', '1m'], ['300', '5m']], String(opts.intervalSec), function (v) {
      opts.intervalSec = parseInt(v, 10) || 10; postOption('intervalSec', v); syncSettingsUI();
    });
    renderSeg($('segIdle'), [['0', 'Never'], ['1', '1m'], ['5', '5m'], ['10', '10m'], ['30', '30m'], ['60', '1h']], String(opts.idleMinutes), function (v) {
      opts.idleMinutes = v; postOption('idleMinutes', v); syncSettingsUI();
    });
    $('rowScene').style.display = opts.source === 'media' ? 'none' : '';
    $('rowFill').style.display = opts.source === 'scenes' ? 'none' : '';
    $('folderVal').textContent = mediaDirLabel ? (mediaDirLabel + (usingDefault ? '  (default)' : '')) : '—';
  }

  function openSettings() { syncSettingsUI(); $('settingsOverlay').classList.add('show'); }
  $('setDone').addEventListener('click', function () { $('settingsOverlay').classList.remove('show'); });
  $('settingsOverlay').addEventListener('click', function (e) { if (e.target === $('settingsOverlay')) $('settingsOverlay').classList.remove('show'); });

  // ---- folder browser (generic /projects route; row taps navigate, one persistent Use action) ----
  var fbRoot = '';
  function fbLoad(p) {
    fetch('/screensaver/projects' + (p ? '?path=' + encodeURIComponent(p) : '')).then(function (r) { return r.json(); }).then(function (s) {
      fbRoot = s.root || '';
      $('fbPath').textContent = fbRoot || '—';
      $('fbUp').disabled = !s.parent;
      $('fbUp').onclick = function () { if (s.parent) fbLoad(s.parent); };
      var list = $('fbList');
      list.innerHTML = '';
      (s.dirs || []).forEach(function (d) {
        var b = document.createElement('button');
        var parts = d.split(/[\\/]/);
        b.textContent = '📁 ' + (parts[parts.length - 1] || d);
        b.addEventListener('click', function () { fbLoad(d); });
        list.appendChild(b);
      });
    }).catch(function () {});
  }
  $('folderBrowse').addEventListener('click', function () { $('folderOverlay').classList.add('show'); fbLoad(''); });
  $('fbClose').addEventListener('click', function () { $('folderOverlay').classList.remove('show'); });
  $('fbUse').addEventListener('click', function () {
    if (!fbRoot) return;
    postOption('mediaDir', fbRoot, function () {
      $('folderOverlay').classList.remove('show');
      fetchState(function () { restart(); });
    });
  });
  $('fbDefault').addEventListener('click', function () {
    postOption('mediaDir', '', function () {
      $('folderOverlay').classList.remove('show');
      fetchState(function () { restart(); });
    });
  });

  // Pause the show while the page isn't visible (native grid shown over the webview); the media
  // pages unload on real page switches, but grid pages only hide us.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) clearTimer();
    else if (playlist.length > 1) armTimer(intervalMs());
  });

  // ---- boot ----
  fetchState(function () { restart(); });
})();

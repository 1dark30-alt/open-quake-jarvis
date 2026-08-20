'use strict';
// Screensaver page: built-in canvas scenes (drawn live, no assets) + a dual-layer crossfade
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
    fillMode: Q.get('fillMode') || 'cover',        // cover | contain (media only)
    intervalSec: parseInt(Q.get('intervalSec'), 10) || 10,
    shuffle: Q.get('shuffle') === '1',
    idleMinutes: Q.get('idleMinutes') || '10',
    sceneOn: {},                                   // per-scene include toggles (any mix)
  };
  var SCENES = ['waves', 'starfield', 'lava', 'fireflies', 'aquarium'];
  var SCENE_LABELS = { waves: 'Waves', starfield: 'Starfield', lava: 'Lava lamp', fireflies: 'Fireflies', aquarium: 'Aquarium' };
  function sceneKey(id) { return 'scene' + id.charAt(0).toUpperCase() + id.slice(1); }
  SCENES.forEach(function (id) { opts.sceneOn[id] = Q.get(sceneKey(id)) !== '0'; });   // absent = on
  var files = [];              // [{name, kind:'image'|'video'}] from /state
  var mediaDirLabel = '';      // shown in settings
  var usingDefault = true;

  // =====================================================================================
  // Built-in scenes: tiny animation programs drawing 1920x480 frames. Each returns a stop().
  // =====================================================================================
  var W = 1920, H = 480;

  function sceneWaves(cv) {
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

  function sceneLava(cv) {
    var ctx = cv.getContext('2d'), run = true, t = 0;
    // Metaball goo: blobs drawn small + heavily blurred, then a contrast step merges the fields
    // into gooey shapes. Rendered at 1/4 res offscreen and upscaled — the blur stays cheap.
    var os = document.createElement('canvas'); os.width = 480; os.height = 120;
    var octx = os.getContext('2d');
    var hasFilter = typeof octx.filter === 'string';
    var blobs = [];
    for (var i = 0; i < 8; i++) {
      blobs.push({
        // Even horizontal bands (+ jitter) so the goo never clumps into one corner for good.
        x: (i + 0.5) * (480 / 8) + (Math.random() - 0.5) * 40,
        y: 20 + Math.random() * 80,
        r: 14 + Math.random() * 18, vy: (Math.random() * 0.16 + 0.05) * (i % 2 ? 1 : -1),
        wob: Math.random() * 6.28, hot: i % 3 === 0,   // a few brighter "hot" blobs
      });
    }
    (function frame() {
      if (!run) return;
      t++;
      octx.setTransform(1, 0, 0, 1, 0, 0);
      octx.filter = 'none';
      octx.fillStyle = '#000'; octx.fillRect(0, 0, 480, 120);
      if (hasFilter) octx.filter = 'blur(8px) contrast(12)';   // softer threshold keeps orange fade at merge edges
      for (var i = 0; i < blobs.length; i++) {
        var b = blobs[i];
        b.y += b.vy;
        var breathe = 1 + Math.sin(t * 0.01 + b.wob) * 0.18;
        // A blob that drifts off the top sinks back from the bottom (and vice versa) at a new size.
        if (b.y < -b.r * 2) { b.y = 120 + b.r; b.vy = -(Math.random() * 0.16 + 0.05); b.r = 14 + Math.random() * 18; }
        if (b.y > 120 + b.r * 2) { b.y = -b.r; b.vy = Math.random() * 0.16 + 0.05; b.r = 14 + Math.random() * 18; }
        var x = b.x + Math.sin(t * 0.004 + b.wob) * 14;
        // Slow molten wobble; hot cores keep a tight red-orange hue — above ~hue 20 at this
        // lightness the contrast step tips them lime-green.
        var hue = b.hot ? 10 + Math.sin(t * 0.002 + b.wob) * 4 : 18 + Math.sin(t * 0.002 + b.wob) * 10;
        octx.fillStyle = 'hsl(' + hue + ',95%,' + (b.hot ? 57 : 46) + '%)';
        octx.beginPath(); octx.arc(x, b.y, b.r * breathe, 0, 6.2832); octx.fill();
      }
      ctx.imageSmoothingEnabled = true;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      ctx.drawImage(os, 0, 0, W, H);
      requestAnimationFrame(frame);
    })();
    return function () { run = false; };
  }

  function sceneFireflies(cv) {
    var ctx = cv.getContext('2d'), run = true, t = 0;
    // Grass silhouette pre-rendered once; the flies wander with smooth headings and pulse
    // individually, with the occasional brighter flash.
    var grass = document.createElement('canvas'); grass.width = W; grass.height = H;
    var gctx = grass.getContext('2d');
    for (var layer = 0; layer < 3; layer++) {
      gctx.fillStyle = 'rgba(6,16,8,' + (0.5 + layer * 0.25) + ')';
      gctx.beginPath(); gctx.moveTo(0, H);
      var base = H - 14 - layer * 16;
      for (var x = 0; x <= W; x += 7) {
        gctx.lineTo(x, base - Math.abs(Math.sin(x * 0.05 + layer * 9)) * (16 + layer * 10) * (0.4 + Math.abs(Math.sin(x * 0.011 + layer))));
      }
      gctx.lineTo(W, H); gctx.closePath(); gctx.fill();
    }
    var N = 46, flies = [];
    for (var i = 0; i < N; i++) {
      flies.push({
        x: Math.random() * W, y: 40 + Math.random() * (H - 110),
        a: Math.random() * 6.2832, speed: 0.25 + Math.random() * 0.5,
        phase: Math.random() * 6.2832, rate: 0.015 + Math.random() * 0.02,
        flash: 0,
      });
    }
    (function frame() {
      if (!run) return;
      t++;
      ctx.fillStyle = '#000'; ctx.fillRect(0, 0, W, H);
      ctx.drawImage(grass, 0, 0);
      ctx.globalCompositeOperation = 'lighter';
      for (var i = 0; i < N; i++) {
        var f = flies[i];
        f.a += (Math.random() - 0.5) * 0.25;                  // smooth-ish random wander
        f.x += Math.cos(f.a) * f.speed; f.y += Math.sin(f.a) * f.speed * 0.6;
        if (f.x < -20) f.x = W + 20; if (f.x > W + 20) f.x = -20;
        if (f.y < 30) { f.y = 30; f.a = -f.a; }
        if (f.y > H - 40) { f.y = H - 40; f.a = -f.a; }
        if (!f.flash && Math.random() < 0.0012) f.flash = 60;  // occasional bright flare
        var glow = Math.max(0, Math.sin(t * f.rate + f.phase)); glow = glow * glow;
        if (f.flash) { glow = Math.min(1, glow + f.flash / 60); f.flash--; }
        if (glow < 0.03) continue;
        var r = 6 + glow * 11;
        var grad = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, r);
        grad.addColorStop(0, 'rgba(222,255,150,' + Math.min(1, glow * 1.1).toFixed(3) + ')');
        grad.addColorStop(0.35, 'rgba(190,240,90,' + (0.45 * glow).toFixed(3) + ')');
        grad.addColorStop(1, 'rgba(190,240,90,0)');
        ctx.fillStyle = grad;
        ctx.beginPath(); ctx.arc(f.x, f.y, r, 0, 6.2832); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
      requestAnimationFrame(frame);
    })();
    return function () { run = false; };
  }

  function sceneAquarium(cv) {
    var ctx = cv.getContext('2d'), run = true, t = 0;
    function makeFish() {
      var dir = Math.random() < 0.5 ? 1 : -1;
      var size = 16 + Math.random() * 44;
      return {
        x: dir > 0 ? -size * 3 : W + size * 3,
        y: 50 + Math.random() * (H - 150),
        size: size, dir: dir,
        speed: (0.35 + Math.random() * 0.8) * (46 / (size + 30)),   // small fish dart, big fish cruise
        bob: Math.random() * 6.2832, wig: Math.random() * 6.2832,
        tint: 'hsl(' + (195 + Math.random() * 40) + ',45%,' + (14 + Math.random() * 10) + '%)',
      };
    }
    var fish = []; for (var i = 0; i < 9; i++) { var f0 = makeFish(); f0.x = Math.random() * W; fish.push(f0); }
    var bubbles = []; for (var i = 0; i < 26; i++) bubbles.push({ x: Math.random() * W, y: Math.random() * H, r: 1.5 + Math.random() * 3.5, v: 0.4 + Math.random() * 0.9, wob: Math.random() * 6.2832 });
    var weeds = []; for (var i = 0; i < 5; i++) weeds.push({ x: 120 + Math.random() * (W - 240), h: 70 + Math.random() * 90, phase: Math.random() * 6.2832 });
    function drawFish(f) {
      var s = f.size;
      ctx.save();
      ctx.translate(f.x, f.y + Math.sin(t * 0.02 + f.bob) * 6);
      ctx.scale(f.dir, 1);
      ctx.fillStyle = f.tint;
      ctx.beginPath(); ctx.ellipse(0, 0, s, s * 0.42, 0, 0, 6.2832); ctx.fill();       // body
      var tail = Math.sin(t * 0.18 + f.wig) * s * 0.22;                                 // tail wiggle
      ctx.beginPath(); ctx.moveTo(-s * 0.85, 0);
      ctx.lineTo(-s * 1.45, -s * 0.38 + tail); ctx.lineTo(-s * 1.45, s * 0.38 + tail);
      ctx.closePath(); ctx.fill();
      ctx.beginPath(); ctx.moveTo(-s * 0.1, -s * 0.35);                                 // dorsal fin
      ctx.lineTo(s * 0.25, -s * 0.72); ctx.lineTo(s * 0.4, -s * 0.3); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(190,230,255,0.5)';                                          // eye glint
      ctx.beginPath(); ctx.arc(s * 0.62, -s * 0.08, Math.max(1.2, s * 0.05), 0, 6.2832); ctx.fill();
      ctx.restore();
    }
    (function frame() {
      if (!run) return;
      t++;
      var water = ctx.createLinearGradient(0, 0, 0, H);
      water.addColorStop(0, '#04293e'); water.addColorStop(1, '#020f18');
      ctx.fillStyle = water; ctx.fillRect(0, 0, W, H);
      for (var i = 0; i < 4; i++) {                                                     // swaying light rays
        var rx = W * (0.12 + i * 0.24) + Math.sin(t * 0.004 + i * 2.1) * 60;
        var ray = ctx.createLinearGradient(rx, 0, rx + 140, H);
        ray.addColorStop(0, 'rgba(170,220,255,0.05)'); ray.addColorStop(1, 'rgba(170,220,255,0)');
        ctx.fillStyle = ray;
        ctx.beginPath(); ctx.moveTo(rx, 0); ctx.lineTo(rx + 90, 0); ctx.lineTo(rx + 260, H); ctx.lineTo(rx + 60, H); ctx.closePath(); ctx.fill();
      }
      ctx.fillStyle = '#0a1a14';                                                        // sandy bottom
      ctx.beginPath(); ctx.moveTo(0, H);
      for (var x = 0; x <= W; x += 60) ctx.lineTo(x, H - 16 - Math.sin(x * 0.01) * 8);
      ctx.lineTo(W, H); ctx.closePath(); ctx.fill();
      for (var i = 0; i < weeds.length; i++) {                                          // swaying seaweed
        var wd = weeds[i];
        ctx.strokeStyle = 'rgba(20,70,50,0.85)'; ctx.lineWidth = 7; ctx.lineCap = 'round';
        for (var blade = -1; blade <= 1; blade++) {
          ctx.beginPath(); ctx.moveTo(wd.x + blade * 10, H - 12);
          for (var seg = 1; seg <= 5; seg++) {
            var sway = Math.sin(t * 0.012 + wd.phase + seg * 0.7 + blade) * 6 * seg;
            ctx.lineTo(wd.x + blade * 10 + sway, H - 12 - (wd.h / 5) * seg);
          }
          ctx.stroke();
        }
      }
      for (var i = 0; i < bubbles.length; i++) {
        var b = bubbles[i];
        b.y -= b.v; b.x += Math.sin(t * 0.03 + b.wob) * 0.4;
        if (b.y < -6) { b.y = H + 6; b.x = Math.random() * W; }
        ctx.strokeStyle = 'rgba(190,230,255,0.35)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(b.x, b.y, b.r, 0, 6.2832); ctx.stroke();
      }
      for (var i = 0; i < fish.length; i++) {
        var f = fish[i];
        f.x += f.speed * f.dir;
        if ((f.dir > 0 && f.x > W + f.size * 3) || (f.dir < 0 && f.x < -f.size * 3)) fish[i] = makeFish();
        else drawFish(f);
      }
      requestAnimationFrame(frame);
    })();
    return function () { run = false; };
  }

  var SCENE_FNS = { waves: sceneWaves, starfield: sceneStarfield, lava: sceneLava, fireflies: sceneFireflies, aquarium: sceneAquarium };

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
      SCENES.filter(function (n) { return opts.sceneOn[n]; }).forEach(function (n) { items.push({ kind: 'scene', name: n }); });
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
    // Scenes are independent toggles — tap any mix on/off (all off = the honest empty state).
    (function () {
      var el = $('segScene');
      el.innerHTML = '';
      SCENES.forEach(function (id) {
        var b = document.createElement('button');
        b.textContent = SCENE_LABELS[id];
        if (opts.sceneOn[id]) b.classList.add('on');
        b.addEventListener('click', function () {
          opts.sceneOn[id] = !opts.sceneOn[id];
          postOption(sceneKey(id), opts.sceneOn[id] ? '1' : '0');
          syncSettingsUI(); restart();
        });
        el.appendChild(b);
      });
    })();
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
  // pages unload on real page switches, but grid pages only hide us. Videos advance on their own
  // 'ended', so only the image/scene timer needs re-arming.
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { clearTimer(); return; }
    var cur = playlist.length ? playlist[order[Math.max(0, pos)]] : null;
    if (playlist.length > 1 && cur && cur.kind !== 'video') armTimer(intervalMs());
  });

  // ---- boot ----
  fetchState(function () { restart(); });
})();

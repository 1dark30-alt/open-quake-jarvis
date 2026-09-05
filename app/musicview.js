  function $(id){ return document.getElementById(id); }
  // theme + options — host passes _dark=1/0, _accent=#hex, and app options (art=0/1) via the served query.
  (function(){
    try {
      var q = new URLSearchParams(location.search);
      document.body.classList.toggle('light', q.get('_dark') === '0');
      var a = q.get('_accent') || '';
      if (/^#[0-9a-fA-F]{6}$/.test(a)) document.documentElement.style.setProperty('--accent', a);
      document.body.classList.toggle('no-art', q.get('art') === '0');   // Show album art toggle
      document.body.classList.toggle('show-lyrics', q.get('lyrics') === '1');   // Show lyrics toggle
    } catch (e) {}
  })();
  // #status (the "Playing"/source-app line) lives in the HTML as the lyrics panel's caption -- it's
  // attribution context for what you're reading, not core now-playing identity. Without lyrics on
  // there's nothing for it to caption, so relocate it into .mid, right after the metadata block.
  if (!document.body.classList.contains('show-lyrics')) {
    $('progress').insertAdjacentElement('afterend', $('status'));
  }
  // Tight layout when the webview is narrow (e.g. a 2×3 button strip is on) — pull padding/sizes in.
  function applyTight(){ document.body.classList.toggle('tight', window.innerWidth < 1350); }
  applyTight(); window.addEventListener('resize', applyTight);
  function esc(s){ return (s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  var ICON = {
    prev: '<svg viewBox="0 0 24 24"><path d="M7 6h2.4v12H7z"/><path d="M20 6v12l-9-6z"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M14.6 6H17v12h-2.4z"/><path d="M4 6v12l9-6z"/></svg>',
    play: '<svg viewBox="0 0 24 24"><path d="M7 5l12 7-12 7z"/></svg>',
    pause:'<svg viewBox="0 0 24 24"><path d="M6 5h4.2v14H6z"/><path d="M13.8 5H18v14h-4.2z"/></svg>'
  };
  $('bPrev').innerHTML = ICON.prev; $('bNext').innerHTML = ICON.next; setPlayIcon(ICON.pause);
  function media(cmd){ fetch('/media/' + cmd, { cache: 'no-store' }).catch(function(){}); }
  function setPlayIcon(icon){ $('bPlay').innerHTML = icon; $('bPause').innerHTML = icon; }
  function togglePlayPause(){ media('playpause'); var p = $('bPlay').innerHTML === ICON.pause; setPlayIcon(p ? ICON.play : ICON.pause); }
  $('bPrev').onclick = function(){ media('prev'); };
  $('bNext').onclick = function(){ media('next'); };
  $('bPause').onclick = togglePlayPause;
  $('bPlay').onclick = togglePlayPause;

  function setArt(url){
    var img = $('artImg');
    if (url){ if (img.getAttribute('src') !== url) img.src = url; img.style.display = 'block'; }   // covers the 🎵 placeholder
    else { img.removeAttribute('src'); img.style.display = 'none'; }                                // no art -> show the 🎵 placeholder
  }

  // Idle state shows the last REAL playback info (title/artist/album/art actually reported), never
  // fabricated data (no "available speakers" / "Bluetooth status" -- this app has no data source for
  // that). If nothing has ever played this session, it falls through to a plain, space-saving
  // "Nothing playing".
  var lastGood = null;
  function renderNP(s){
    var playing = !!(s && s.title);
    document.body.classList.toggle('idle', !playing);
    if (playing) lastGood = { title: s.title, artist: s.artist || '', album: s.album || '', art: s.art || null };

    if (playing) {
      $('mTitle').textContent = s.title;
      $('mArtist').textContent = s.artist || '';
      $('mAlbum').textContent = s.album || '';
      $('status').classList.remove('hide');
      $('mStatus').textContent = s.status || '—';
      $('mStatus').classList.remove('last');
      setPlayIcon((s.status === 'Playing') ? ICON.pause : ICON.play);
      var app = (s.app || '').replace(/\._crx_.*/, '').replace(/!.*/, '').replace(/\.exe$/i, '');
      $('mApp').textContent = app ? ('· ' + app) : '';
      setArt(s.art);
    } else if (lastGood) {
      $('mTitle').textContent = lastGood.title;
      $('mArtist').textContent = lastGood.artist;
      $('mAlbum').textContent = lastGood.album;
      $('status').classList.remove('hide');
      $('mStatus').textContent = 'Last played';
      $('mStatus').classList.add('last');
      $('mApp').textContent = '';
      setPlayIcon(ICON.play);
      setArt(lastGood.art);
    } else {
      $('mTitle').textContent = 'Nothing playing';
      $('mArtist').textContent = '';
      $('mAlbum').textContent = '';
      $('status').classList.add('hide');
      setPlayIcon(ICON.play);
      setArt(null);
    }
  }

  function fmtTime(sec){
    sec = Math.max(0, Math.floor(sec || 0));
    var m = Math.floor(sec / 60), r = sec % 60;
    return m + ':' + (r < 10 ? '0' : '') + r;
  }
  // Position/duration come from SMTC's timeline (already in the /nowplaying payload). Interpolated
  // between polls the same way lyric sync already does, so the bar advances smoothly rather than
  // jumping once every 1.5s.
  function progressTick(){
    var host = $('progress');
    if (!np.dur || np.dur <= 0) {
      host.classList.add('idle');
      $('pFill').style.width = '0%'; $('pElapsed').textContent = '0:00'; $('pTotal').textContent = '0:00';
      return;
    }
    host.classList.remove('idle');
    var est = np.pos + (np.status === 'Playing' ? (Date.now() - np.ts) / 1000 : 0);
    est = Math.min(est, np.dur);
    $('pFill').style.width = Math.min(100, (est / np.dur) * 100) + '%';
    $('pElapsed').textContent = fmtTime(est);
    $('pTotal').textContent = fmtTime(np.dur);
  }
  setInterval(progressTick, 250);

  var np = { pos: 0, dur: 0, ts: 0, status: '' };   // last known playback position + when it was captured (same clock as us)
  function pollNP(){
    fetch('/nowplaying', { cache: 'no-store' }).then(function(r){ return r.json(); })
      .then(function(s){
        $('recon').classList.remove('show');
        if (s) { np.pos = s.position || 0; np.dur = s.duration || 0; np.ts = s.ts || Date.now(); np.status = s.status || ''; }
        else { np.dur = 0; }
        renderNP(s);
      })
      .catch(function(){ $('recon').classList.add('show'); });
  }
  pollNP();
  setInterval(pollNP, 1500);
  // The launcher grid is now the native button strip (rendered by the panel, not this page).

  // ---- lyrics (LRCLIB via /lyrics) — synced lines auto-scroll; plain lyrics scroll manually ----
  if (document.body.classList.contains('show-lyrics')) {
    var lyr = { key: '', synced: false, lines: [], active: -1 };
    var manualUntil = 0;   // knob "scroll in window" -> wheel scrolls the lyrics; pause auto-scroll for a bit after
    document.addEventListener('wheel', function (e) { var h = $('lyrics'); if (h) { h.scrollTop += e.deltaY; manualUntil = Date.now() + 4000; } }, { passive: true });
    function renderLyrics(d){
      var host = $('lyrics');
      if (!d || !d.ok) { if (lyr.key !== '__none') { host.innerHTML = '<div class="none">—</div>'; lyr.key = '__none'; lyr.lines = []; lyr.synced = false; } return; }
      if (d.key === lyr.key) return;   // same track, already rendered
      lyr.key = d.key; lyr.synced = !!d.synced; lyr.lines = d.lines || []; lyr.active = -1; host.scrollTop = 0;
      if (lyr.synced && lyr.lines.length) host.innerHTML = lyr.lines.map(function(l, i){ return '<div class="ln" data-i="' + i + '">' + esc(l.line || '♪') + '</div>'; }).join('');
      else if (d.plain) host.innerHTML = '<div class="plain">' + esc(d.plain) + '</div>';
      else host.innerHTML = '<div class="none">No lyrics found</div>';
    }
    function lyricTick(){
      if (!lyr.synced || !lyr.lines.length) return;
      var est = np.pos + (np.status === 'Playing' ? (Date.now() - np.ts) / 1000 : 0);
      var idx = -1;
      for (var i = 0; i < lyr.lines.length; i++){ if (lyr.lines[i].t <= est + 0.15) idx = i; else break; }
      if (idx === lyr.active) return;
      lyr.active = idx;
      var host = $('lyrics');
      var prev = host.querySelector('.ln.on'); if (prev) prev.classList.remove('on');
      var el = idx >= 0 ? host.querySelector('.ln[data-i="' + idx + '"]') : null;
      if (el){ el.classList.add('on'); if (Date.now() > manualUntil) el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }   // hold position right after a manual scroll
    }
    function pollLyrics(){ fetch('/lyrics', { cache: 'no-store' }).then(function(r){ return r.json(); }).then(renderLyrics).catch(function(){}); }
    pollLyrics();
    setInterval(pollLyrics, 4000);   // picks up track changes
    setInterval(lyricTick, 250);
  }

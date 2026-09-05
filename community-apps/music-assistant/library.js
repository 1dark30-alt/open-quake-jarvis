'use strict';

// Library / browse / search drawer. Loaded before app.js; everything runs lazily
// through window.MApp, which app.js assigns at startup.
(function () {
  const $ = s => document.querySelector(s);
  const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ#'.split('');
  const KEY_ROWS = [
    ['Q', 'W', 'E', 'R', 'T', 'Y', 'U', 'I', 'O', 'P'],
    ['A', 'S', 'D', 'F', 'G', 'H', 'J', 'K', 'L'],
    ['Z', 'X', 'C', 'V', 'B', 'N', 'M'],
  ];
  const DIGIT_ROWS = [
    ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
    ['-', '/', ':', ';', '(', ')', '$', '&', '@'],
    ['.', ',', '?', '!', "'", '"', '#'],
  ];
  const TABS = {
    home: { label: 'Home' },
    artists: { label: 'Artists', cmd: 'music/artists/library_items', grid: true },
    albums: { label: 'Albums', cmd: 'music/albums/library_items', grid: true },
    tracks: { label: 'Tracks', cmd: 'music/tracks/library_items', grid: false },
    playlists: { label: 'Playlists', cmd: 'music/playlists/library_items', grid: true },
    radios: { label: 'Radio', cmd: 'music/radios/library_items', grid: true },
    search: { label: 'Search' },
  };
  const PAGE = 500;
  const CAP = 2000; // ponytail: client-side letter jump needs the full list; cap it and point huge libraries at Search

  const L = {
    tab: 'home',
    cache: new Map(),
    query: '',
    digits: false,
    searchTimer: null,
    searchResults: null,
    detail: null, // { title, items } when drilled into an artist/album/playlist
    opener: null,
    hgridDetach: null,
  };

  function app() { return window.MApp; }

  async function cachedRequest(command, args) {
    const key = command + '|' + JSON.stringify(args || {});
    if (L.cache.has(key)) return L.cache.get(key);
    const result = await app().request(command, args);
    L.cache.set(key, result);
    return result;
  }

  async function fetchAll(command) {
    const key = 'all|' + command;
    if (L.cache.has(key)) return L.cache.get(key);
    const items = [];
    for (let offset = 0; offset < CAP; offset += PAGE) {
      const page = await app().request(command, { limit: PAGE, offset, order_by: 'sort_name' });
      if (!Array.isArray(page)) break;
      items.push.apply(items, page);
      if (page.length < PAGE) break;
    }
    const result = { items, truncated: items.length >= CAP };
    L.cache.set(key, result);
    return result;
  }

  function invalidateCache() { L.cache.clear(); }

  // ── shared row/cell markup ───────────────────────────────
  function cellHtml(it, i) {
    const A = app();
    const art = A.imageFor(it, 256);
    return '<button class="cell" type="button" data-item="' + i + '">' +
      '<span class="cimg">' + A.monoHtml(it.name) + (art ? '<img alt="" data-art loading="lazy" src="' + A.esc(art) + '">' : '') + '</span>' +
      '<span class="cname">' + A.esc(it.name || '') + '</span>' +
      '<span class="csub">' + A.esc(A.itemArtist(it)) + '</span></button>';
  }

  function rowHtml(it, i, badge) {
    const A = app();
    const art = A.imageFor(it, 80);
    const dur = A.itemDuration(it);
    return '<button class="lrow" type="button" data-item="' + i + '">' +
      (badge ? '<span class="badge">' + A.esc(badge) + '</span>' : '<span class="lthumb">' + A.monoHtml(it.name) + (art ? '<img alt="" data-art loading="lazy" src="' + A.esc(art) + '">' : '') + '</span>') +
      '<span class="lname">' + A.esc(it.name || '') + '</span>' +
      '<span class="lsub">' + A.esc(A.itemArtist(it)) + '</span>' +
      '<span class="ldur">' + (dur ? A.fmt(dur) : '') + '</span></button>';
  }

  function wireItems(root, items) {
    const A = app();
    root.querySelectorAll('[data-item]').forEach(btn => {
      btn.addEventListener('click', () => {
        const it = items[Number(btn.dataset.item)];
        if (!it) return;
        if (it.media_type === 'track' || it.media_type === 'radio') { A.playMedia(it, 'play'); close(); return; }
        A.playMedia(it, 'play');
        close();
      });
    });
    attachItemLongPress(root, items);
    A.wireArt(root);
  }

  function attachItemLongPress(root, items) {
    const A = app();
    let timer = null, start = null, target = null;
    root.addEventListener('pointerdown', ev => {
      target = ev.target.closest('[data-item]');
      if (!target) return;
      start = { x: ev.clientX, y: ev.clientY };
      timer = setTimeout(() => {
        timer = null;
        const it = items[Number(target.dataset.item)];
        if (!it) return;
        const extra = [];
        if (['artist', 'album', 'playlist'].includes(it.media_type)) {
          extra.push({ label: 'Show tracks', fn: () => openDetail(it) });
        }
        A.openCtx(start.x, start.y, it.name || '', A.mediaActions(it, extra));
      }, 450);
    });
    root.addEventListener('pointermove', ev => {
      if (timer && start && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 10) { clearTimeout(timer); timer = null; }
    });
    ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev =>
      root.addEventListener(ev, () => { clearTimeout(timer); timer = null; }));
  }

  // horizontal drag-to-scroll for cover rows (TouchDragScroll is vertical-only)
  function attachHDrag(el) {
    let gesture = null, suppress = false;
    el.addEventListener('pointerdown', ev => {
      gesture = { id: ev.pointerId, x: ev.clientX, left: el.scrollLeft, dragged: false };
    });
    el.addEventListener('pointermove', ev => {
      if (!gesture || gesture.id !== ev.pointerId) return;
      const d = ev.clientX - gesture.x;
      if (!gesture.dragged && Math.abs(d) < 8) return;
      if (!gesture.dragged) { gesture.dragged = true; try { el.setPointerCapture(ev.pointerId); } catch (e) {} }
      el.scrollLeft = gesture.left - d;
      if (ev.cancelable) ev.preventDefault();
    });
    ['pointerup', 'pointercancel'].forEach(evName => el.addEventListener(evName, ev => {
      if (!gesture || gesture.id !== ev.pointerId) return;
      if (gesture.dragged) { suppress = true; setTimeout(() => { suppress = false; }, 0); }
      gesture = null;
    }));
    el.addEventListener('click', ev => {
      if (!suppress) return;
      suppress = false;
      ev.preventDefault();
      ev.stopImmediatePropagation();
    }, true);
  }

  // ── tab renderers ────────────────────────────────────────
  function setBody(html) { $('#drawer-body').innerHTML = html; }
  function setHead(title, count) {
    $('#drawer-title').textContent = title;
    $('#drawer-count').textContent = count || '';
    $('#drawer-back').hidden = !L.detail;
  }

  function firstLetter(it) {
    const s = String(it.sort_name || it.name || '').trim().toUpperCase();
    return /^[A-Z]/.test(s) ? s[0] : '#';
  }

  function abcHtml() {
    return '<div class="abc" id="abc">' + LETTERS.map(l => '<button type="button" data-letter="' + l + '">' + l + '</button>').join('') + '</div>';
  }

  function wireAbc(items, jump) {
    const abc = $('#abc');
    if (!abc) return;
    function jumpTo(letter) {
      abc.querySelectorAll('button').forEach(b => b.classList.toggle('cur', b.dataset.letter === letter));
      let i = items.findIndex(it => firstLetter(it) >= letter || (letter === '#' && firstLetter(it) === '#'));
      if (letter === '#') i = items.findIndex(it => firstLetter(it) === '#');
      if (i >= 0) jump(i);
    }
    abc.addEventListener('pointerdown', ev => {
      const btn = ev.target.closest('[data-letter]');
      if (btn) jumpTo(btn.dataset.letter);
    });
    abc.addEventListener('pointermove', ev => {
      if (ev.buttons !== 1 && ev.pointerType === 'mouse') return;
      const el = document.elementFromPoint(ev.clientX, ev.clientY);
      const btn = el && el.closest && el.closest('[data-letter]');
      if (btn) jumpTo(btn.dataset.letter);
    });
  }

  async function renderGridTab(tab) {
    const def = TABS[tab];
    setHead(def.label, '');
    setBody('<div class="list-note">Loading…</div>');
    let data;
    try { data = await fetchAll(def.cmd); } catch (e) {
      setBody('<div class="list-note">' + app().esc(e.message || 'Failed to load') + '</div>');
      return;
    }
    if (L.tab !== tab || L.detail) return;
    const items = data.items;
    setHead(def.label, items.length + (data.truncated ? '+' : '') + ' in library');
    if (!items.length) { setBody('<div class="list-note">Nothing here yet</div>'); return; }
    setBody('<div class="hgrid" id="hgrid">' + items.map(cellHtml).join('') + '</div>' + abcHtml() +
      (data.truncated ? '<div class="list-note">Showing first ' + CAP + ' — use Search for the rest</div>' : ''));
    const grid = $('#hgrid');
    attachHDrag(grid);
    wireItems(grid, items);
    wireAbc(items, i => { grid.scrollLeft = i * 232; });
  }

  async function renderTracksTab() {
    setHead('Tracks', '');
    setBody('<div class="list-note">Loading…</div>');
    let data;
    try { data = await fetchAll(TABS.tracks.cmd); } catch (e) {
      setBody('<div class="list-note">' + app().esc(e.message || 'Failed to load') + '</div>');
      return;
    }
    if (L.tab !== 'tracks' || L.detail) return;
    const items = data.items;
    setHead('Tracks', items.length + (data.truncated ? '+' : '') + ' in library');
    if (!items.length) { setBody('<div class="list-note">Nothing here yet</div>'); return; }
    setBody('<div class="vlist" id="vlist">' + items.map((it, i) => rowHtml(it, i)).join('') + '</div>' + abcHtml() +
      (data.truncated ? '<div class="list-note">Showing first ' + CAP + ' — use Search for the rest</div>' : ''));
    const list = $('#vlist');
    TouchDragScroll.attach(list);
    wireItems(list, items);
    wireAbc(items, i => { list.scrollTop = i * 64; });
  }

  // ── Top Picks for You (mirrors MA frontend HomeWidgetRows "Model B") ──────
  // A balanced round-robin interleave across every shown recommendation row:
  // one item per row per pass, tagged with its row name, deduped by uri, capped
  // at HERO_COUNT; recently-played fills any shortfall. Rendered as one large
  // lead card + the remaining picks in columns of two (a horizontal scroller).
  const HERO_COUNT = 9;
  const KIND = {
    track: 'Track', album: 'Album', artist: 'Artist', playlist: 'Playlist',
    radio: 'Radio', audiobook: 'Audiobook', podcast: 'Podcast', folder: '',
  };
  const SPARKLE = '<svg class="th-spark" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 2l1.7 6.3L20 10l-6.3 1.7L12 18l-1.7-6.3L4 10l6.3-1.7z"></path></svg>';
  const REFRESH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15-6.7L21 8"></path><path d="M21 3v5h-5"></path><path d="M21 12a9 9 0 0 1-15 6.7L3 16"></path><path d="M3 21v-5h5"></path></svg>';

  function shuffled(arr) {
    const a = arr.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  function itemKey(it) { return (it && (it.uri || (it.media_type + '/' + it.provider + '/' + it.item_id))) || ''; }

  function buildHeroEntries(randomize) {
    const rows = (L.heroRows || [])
      .map(r => ({ tag: r.tag, items: randomize ? shuffled(r.items) : r.items }))
      .filter(r => r.items.length);
    const sources = randomize ? shuffled(rows) : rows;
    const seen = new Set();
    const out = [];
    const push = (item, tag) => {
      if (!item) return;
      const k = itemKey(item);
      if (seen.has(k) || out.length >= HERO_COUNT) return;
      seen.add(k);
      out.push({ item, tag });
    };
    const maxLen = sources.reduce((m, r) => Math.max(m, r.items.length), 0);
    for (let i = 0; i < maxLen && out.length < HERO_COUNT; i++) {
      for (const r of sources) push(r.items[i], r.tag);
    }
    for (const item of (L.heroRecent || [])) push(item, 'Recently played');
    return out;
  }

  function heroCardHtml(entry, idx, large) {
    const A = app();
    const it = entry.item;
    const art = A.imageFor(it, large ? 640 : 320);
    const kind = KIND[it.media_type] != null ? KIND[it.media_type] : '';
    const sub = A.itemArtist(it);
    return '<button class="th-card' + (large ? ' th-lead' : '') + '" type="button" data-item="' + idx + '">' +
      '<span class="th-bg">' + (art ? '<img alt="" data-art loading="lazy" src="' + A.esc(art) + '">' : '') + '</span>' +
      '<span class="th-scrim"></span>' +
      '<span class="th-content">' +
        '<span class="th-tag">' + SPARKLE + '<span>' + A.esc(entry.tag) + '</span></span>' +
        '<span class="th-body">' +
          (kind ? '<span class="th-kind">' + A.esc(kind) + '</span>' : '') +
          '<span class="th-title">' + A.esc(it.name || '') + '</span>' +
          (sub ? '<span class="th-sub">' + A.esc(sub) + '</span>' : '') +
        '</span>' +
      '</span></button>';
  }

  function heroGridInner(entries) {
    if (!entries.length) return '';
    let html = heroCardHtml(entries[0], 0, true);
    const rest = entries.slice(1);
    for (let i = 0; i < rest.length; i += 2) {
      html += '<div class="th-col">' +
        rest.slice(i, i + 2).map((e, j) => heroCardHtml(e, i + 1 + j, false)).join('') +
        '</div>';
    }
    return html;
  }

  function buildHeroHtml() {
    L.heroEntries = buildHeroEntries(false);
    if (!L.heroEntries.length) return '';
    return '<div class="th-head"><div class="th-headline">Top Picks for You</div>' +
      '<button class="th-refresh" id="th-refresh" type="button" aria-label="Refresh">' + REFRESH + '</button></div>' +
      '<div class="th-hero" id="th-hero">' + heroGridInner(L.heroEntries) + '</div>';
  }

  // Delegated wiring on the container so a refresh (innerHTML swap) keeps working:
  // handlers read L.heroEntries live by index rather than closing over a snapshot.
  function wireHero(root) {
    const A = app();
    const grid = root.querySelector('#th-hero');
    if (grid) {
      attachHDrag(grid);
      A.wireArt(grid);
      grid.addEventListener('click', ev => {
        const btn = ev.target.closest('[data-item]');
        if (!btn) return;
        const e = L.heroEntries[Number(btn.dataset.item)];
        if (!e) return;
        A.playMedia(e.item, 'play');
        close();
      });
      let timer = null, start = null, target = null;
      grid.addEventListener('pointerdown', ev => {
        target = ev.target.closest('[data-item]');
        if (!target) return;
        start = { x: ev.clientX, y: ev.clientY };
        timer = setTimeout(() => {
          timer = null;
          const e = L.heroEntries[Number(target.dataset.item)];
          if (!e) return;
          const extra = [];
          if (['artist', 'album', 'playlist'].includes(e.item.media_type)) {
            extra.push({ label: 'Show tracks', fn: () => openDetail(e.item) });
          }
          A.openCtx(start.x, start.y, e.item.name || '', A.mediaActions(e.item, extra));
        }, 450);
      });
      grid.addEventListener('pointermove', ev => {
        if (timer && start && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 10) { clearTimeout(timer); timer = null; }
      });
      ['pointerup', 'pointercancel', 'pointerleave'].forEach(ev =>
        grid.addEventListener(ev, () => { clearTimeout(timer); timer = null; }));
    }
    const rb = root.querySelector('#th-refresh');
    if (rb && grid) rb.addEventListener('click', () => {
      L.heroEntries = buildHeroEntries(true);
      grid.innerHTML = heroGridInner(L.heroEntries);
      A.wireArt(grid);
      grid.scrollLeft = 0;
    });
  }

  async function renderHomeTab() {
    setHead('Home', '');
    setBody('<div class="shelves" id="shelves"><div class="list-note">Loading…</div></div>');
    const A = app();
    const parts = [];
    const wire = [];

    function shelfPart(label, items) {
      if (!Array.isArray(items) || !items.length) return;
      parts.push('<div class="shelf-label">' + A.esc(label) + '</div><div class="shelf" data-shelf="' + wire.length + '">' +
        items.map((it, i) => cellHtml(it, i)).join('') + '</div>');
      wire.push({ items });
    }

    // Recommendation rows feed both the Top Picks hero and their own shelves.
    // Fetch each row's items once (keyed on provider + item_id, as the API wants).
    let recRows = [];
    try {
      const rows = await cachedRequest('music/recommendations', {});
      // enabled_by_default:false rows are the noisy ones MA hides until opted in.
      recRows = (rows || []).filter(r => r && r.enabled_by_default !== false).slice(0, 8);
      await Promise.all(recRows.map(async row => {
        if (Array.isArray(row.items) && row.items.length) return;
        try { row.items = await cachedRequest('music/recommendations/items', { provider: row.provider, item_id: row.item_id }); }
        catch (e) { row.items = []; }
      }));
    } catch (e) {}

    let recent = [];
    try { recent = await cachedRequest('music/recently_played_items', { limit: 12 }); } catch (e) {}
    if (!Array.isArray(recent)) recent = [];

    // Hero draws from the shown recommendation rows, recently-played as filler.
    L.heroRows = recRows
      .filter(r => Array.isArray(r.items) && r.items.length)
      .map(r => ({ tag: r.name || 'For you', items: r.items }));
    L.heroRecent = recent;
    const heroHtml = buildHeroHtml();

    // Shelves below the hero, in MA's order: recently played, favorites, then rows.
    shelfPart('Recently played', recent);
    try { shelfPart('Favorite albums', await cachedRequest('music/albums/library_items', { favorite: true, limit: 12 })); } catch (e) {}
    try { shelfPart('Favorite playlists', await cachedRequest('music/playlists/library_items', { favorite: true, limit: 12 })); } catch (e) {}
    for (const row of recRows) shelfPart(row.name || 'For you', row.items);

    if (L.tab !== 'home' || L.detail) return;
    const inner = heroHtml + parts.join('');
    setBody('<div class="shelves" id="shelves">' + (inner || '<div class="list-note">Nothing to show yet — play something!</div>') + '</div>');
    const shelves = $('#shelves');
    TouchDragScroll.attach(shelves);
    wireHero(shelves);
    shelves.querySelectorAll('[data-shelf]').forEach(el => {
      const w = wire[Number(el.dataset.shelf)];
      attachHDrag(el);
      wireItems(el, w.items);
    });
  }

  // ── search tab ───────────────────────────────────────────
  function keyRowsHtml() {
    const rows = L.digits ? DIGIT_ROWS : KEY_ROWS;
    let html = rows.map((r, i) => '<div class="krow">' +
      r.map(k => '<button class="key" type="button" data-key="' + app().esc(k) + '">' + app().esc(k) + '</button>').join('') +
      (i === 2 ? '<button class="key w2" type="button" data-key="⌫">⌫</button>' : '') +
      '</div>').join('');
    html += '<div class="krow"><button class="key w2" type="button" data-key="mode">' + (L.digits ? 'ABC' : '?123') + '</button>' +
      '<button class="key sp" type="button" data-key=" "> </button>' +
      '<button class="key w2" type="button" data-key="clear">Clear</button></div>';
    return html;
  }

  function renderSearchTab() {
    setHead('Search', '');
    setBody('<div class="search-split"><div class="search-left">' +
      '<div class="search-field"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"></circle><path d="m20 20-4-4"></path></svg>' +
      '<span class="search-query" id="search-query"></span>' +
      '<button class="search-clear" id="search-clear" type="button" aria-label="Clear search">✕</button></div>' +
      '<div class="vlist" id="search-results"></div></div>' +
      '<div class="kbd" id="kbd"></div></div>');
    $('#kbd').innerHTML = keyRowsHtml();
    renderQuery();
    renderSearchResults();
    $('#kbd').addEventListener('click', ev => {
      const key = ev.target.closest('[data-key]');
      if (!key) return;
      const k = key.dataset.key;
      if (k === 'mode') { L.digits = !L.digits; $('#kbd').innerHTML = keyRowsHtml(); return; }
      if (k === 'clear') L.query = '';
      else if (k === '⌫') L.query = L.query.slice(0, -1);
      else L.query += k.toLowerCase();
      renderQuery();
      scheduleSearch();
    });
    $('#search-clear').addEventListener('click', () => { L.query = ''; L.searchResults = null; renderQuery(); renderSearchResults(); });
  }

  function renderQuery() {
    const el = $('#search-query');
    if (!el) return;
    el.innerHTML = L.query
      ? app().esc(L.query) + '<span class="caret"></span>'
      : '<span class="placeholder">Search artists, albums, tracks…</span>';
  }

  function scheduleSearch() {
    clearTimeout(L.searchTimer);
    if (L.query.trim().length < 2) { L.searchResults = null; renderSearchResults(); return; }
    L.searchTimer = setTimeout(async () => {
      const query = L.query.trim();
      try {
        const result = await app().request('music/search', {
          search_query: query,
          media_types: ['track', 'artist', 'album', 'playlist', 'radio'],
          limit: 25,
        });
        if (L.query.trim() === query) { L.searchResults = result; renderSearchResults(); }
      } catch (e) {
        L.searchResults = { error: e.message || 'Search failed' };
        renderSearchResults();
      }
    }, 350);
  }

  function renderSearchResults() {
    const root = $('#search-results');
    if (!root) return;
    const r = L.searchResults;
    if (!r) { root.innerHTML = '<div class="list-note">' + (L.query.trim().length < 2 ? 'Type at least 2 letters' : 'Searching…') + '</div>'; return; }
    if (r.error) { root.innerHTML = '<div class="list-note">' + app().esc(r.error) + '</div>'; return; }
    const groups = [['artists', 'ARTIST'], ['albums', 'ALBUM'], ['tracks', 'TRACK'], ['playlists', 'PLAYLIST'], ['radio', 'RADIO'], ['radios', 'RADIO']];
    const items = [];
    let html = '';
    for (const [key, badge] of groups) {
      for (const it of (Array.isArray(r[key]) ? r[key] : [])) {
        html += rowHtml(it, items.length, badge);
        items.push(it);
      }
    }
    root.innerHTML = html || '<div class="list-note">No matches</div>';
    TouchDragScroll.attach(root);
    wireItems(root, items);
  }

  // ── detail view (artist / album / playlist tracks) ───────
  async function openDetail(item) {
    L.detail = { title: item.name || '', items: [] };
    setHead(L.detail.title, '');
    setBody('<div class="list-note">Loading…</div>');
    const cmdByType = {
      album: ['music/albums/album_tracks', {}],
      artist: ['music/artists/artist_tracks', {}],
      playlist: ['music/playlists/playlist_tracks', {}],
    };
    const entry = cmdByType[item.media_type];
    if (!entry) { L.detail = null; renderTab(); return; }
    let items = [];
    try {
      items = await cachedRequest(entry[0], {
        item_id: item.item_id,
        provider_instance_id_or_domain: item.provider,
      });
    } catch (e) {
      setBody('<div class="list-note">' + app().esc(e.message || 'Failed to load tracks') + '</div>');
      return;
    }
    if (!L.detail) return;
    items = Array.isArray(items) ? items : [];
    L.detail.items = items;
    setHead(L.detail.title, items.length + ' tracks');
    setBody('<div class="vlist" id="vlist">' + items.map((it, i) => rowHtml(it, i)).join('') + '</div>');
    const list = $('#vlist');
    TouchDragScroll.attach(list);
    wireItems(list, items);
  }

  // ── drawer shell ─────────────────────────────────────────
  function renderTab() {
    L.detail = null;
    document.querySelectorAll('#tab-rail .tab').forEach(t => t.classList.toggle('sel', t.dataset.tab === L.tab));
    if (L.tab === 'home') renderHomeTab();
    else if (L.tab === 'search') renderSearchTab();
    else if (L.tab === 'tracks') renderTracksTab();
    else renderGridTab(L.tab);
  }

  function open(tab) {
    if (!app() || app().S.status !== 'ready') { if (app()) app().toast('Not connected yet'); return; }
    L.opener = document.activeElement;
    L.tab = tab || L.tab || 'home';
    const drawer = $('#drawer');
    drawer.removeAttribute('inert');
    drawer.setAttribute('aria-hidden', 'false');
    drawer.classList.add('open');
    renderTab();
  }

  function close() {
    const drawer = $('#drawer');
    drawer.classList.remove('open');
    drawer.setAttribute('aria-hidden', 'true');
    drawer.setAttribute('inert', '');
    if (L.opener && L.opener.focus) L.opener.focus();
    L.opener = null;
  }

  $('#drawer-close').addEventListener('click', close);
  $('#drawer-back').addEventListener('click', () => renderTab());
  $('#tab-rail').addEventListener('click', ev => {
    const tab = ev.target.closest('[data-tab]');
    if (!tab) return;
    L.tab = tab.dataset.tab;
    renderTab();
  });
  $('#drawer').addEventListener('keydown', ev => { if (ev.key === 'Escape') close(); });

  window.LibraryView = { open, close, invalidateCache };
})();

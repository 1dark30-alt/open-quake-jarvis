'use strict';
// Stream Deck Host page: renders the key grid from server.js's snapshot (long-polled, per-key
// updates), sends press/release, and hosts the assignment + plugins overlays. Knob (generic drop-in
// capability, manifest "knob": true): rotate cycles profiles; press/hold are declined back to the
// panel's defaults. No inline scripts (drop-in CSP).
(function () {
  var q = new URLSearchParams(location.search);
  if (q.get('_dark') === '0') document.body.classList.add('light');
  var ACCENT = q.get('_accent');
  if (/^#[0-9a-fA-F]{6}$/.test(ACCENT || '')) document.documentElement.style.setProperty('--accent', ACCENT);

  var el = function (id) { return document.getElementById(id); };
  var grid = el('grid'), profilesNav = el('profiles');
  var snap = null, assignSlot = null, assignPick = null;
  var iconCache = {};   // "plugin|path" -> data URL ('' while loading)

  function post(action, body) {
    return fetch('/app-api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json(); }).catch(function () { return { ok: false, error: 'request failed' }; });
  }

  // ---- long-poll loop --------------------------------------------------
  function poll(since) {
    fetch('/app-api/state' + (since ? '?since=' + since : ''))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) { snap = j; render(); poll(j.v); }
        else setTimeout(function () { poll(0); }, 2000);
      })
      .catch(function () { setTimeout(function () { poll(0); }, 2000); });
  }

  // ---- rendering -------------------------------------------------------
  function hostStatus() {
    var dot = el('hostdot'), txt = el('hoststatus');
    var ps = (snap && snap.plugins) || [];
    if (!ps.length) { dot.className = 'dot warn'; txt.textContent = 'No plugins — set the Plugins folder in this page’s options'; return; }
    var running = ps.filter(function (p) { return p.status === 'running'; }).length;
    var crashed = ps.filter(function (p) { return p.status === 'crashed' || p.status === 'unsupported'; }).length;
    dot.className = 'dot ' + (crashed ? 'bad' : running ? 'ok' : 'warn');
    txt.textContent = running + '/' + ps.length + ' plugins running' + (crashed ? ' · ' + crashed + ' need attention' : '');
  }
  function renderProfiles() {
    profilesNav.innerHTML = '';
    (snap.profiles || []).forEach(function (pr) {
      var b = document.createElement('button');
      b.type = 'button'; b.tabIndex = -1;
      b.className = pr.id === snap.activeProfile ? 'on' : '';
      b.textContent = pr.name;
      b.addEventListener('click', function () { post('profile-select', { id: pr.id }); });
      profilesNav.appendChild(b);
    });
  }
  function actionIcon(plugin, iconPath, img) {
    if (!iconPath) return;
    var key = plugin + '|' + iconPath;
    if (iconCache[key]) { if (iconCache[key] !== 'x') img.src = iconCache[key]; return; }
    iconCache[key] = 'x';
    fetch('/app-api/asset?plugin=' + encodeURIComponent(plugin) + '&path=' + encodeURIComponent(iconPath))
      .then(function (r) { return r.json(); })
      .then(function (j) { if (j && j.ok) { iconCache[key] = 'data:' + j.mime + ';base64,' + j.b64; img.src = iconCache[key]; } })
      .catch(function () {});
  }
  function render() {
    hostStatus();
    renderProfiles();
    var lay = snap.layout || { columns: 8, rows: 3 };
    grid.style.gridTemplateColumns = 'repeat(' + lay.columns + ', 1fr)';
    grid.style.gridTemplateRows = 'repeat(' + lay.rows + ', 1fr)';
    grid.innerHTML = '';
    for (var r = 0; r < lay.rows; r++) {
      for (var c = 0; c < lay.columns; c++) (function (c, r) {
        var pos = c + ',' + r;
        var k = snap.keys && snap.keys[pos];
        var d = document.createElement('div');
        d.className = 'key' + (k ? '' : ' empty');
        if (k) {
          var plug = (snap.plugins || []).find(function (p) { return p.id === k.plugin; });
          if (plug && plug.status !== 'running') d.classList.add('dead');
          if (k.image) { var im = document.createElement('img'); im.src = k.image; d.appendChild(im); }
          else if (k.icon) { var im2 = document.createElement('img'); actionIcon(k.plugin, k.icon, im2); d.appendChild(im2); }
          var t = document.createElement('span'); t.className = 'kt';
          t.textContent = k.title || (k.image ? '' : k.name);
          if (t.textContent) d.appendChild(t);
          if (k.alert && Date.now() - k.alert < 2000) { var f = document.createElement('span'); f.className = 'flag'; f.textContent = '⚠️'; d.appendChild(f); }
          else if (k.ok && Date.now() - k.ok < 2000) { var f2 = document.createElement('span'); f2.className = 'flag'; f2.textContent = '✅'; d.appendChild(f2); }
          wireKey(d, k, c, r);
        } else {
          var e = document.createElement('span'); e.className = 'kt'; e.textContent = '+';
          d.appendChild(e);
          d.addEventListener('click', function () { openAssign(c, r, null); });
        }
        grid.appendChild(d);
      })(c, r);
    }
  }
  // A key: quick tap = press+release to the plugin; long-press (600ms) = assignment overlay.
  function wireKey(d, k, c, r) {
    var holdTimer = null, held = false;
    d.addEventListener('pointerdown', function (ev) {
      ev.preventDefault(); held = false;
      d.classList.add('pressed');
      post('press', { context: k.context });
      holdTimer = setTimeout(function () { held = true; post('release', { context: k.context }); openAssign(c, r, k); }, 600);
    });
    var up = function () {
      d.classList.remove('pressed');
      if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
      if (!held) post('release', { context: k.context });
      held = false;
    };
    d.addEventListener('pointerup', up);
    d.addEventListener('pointercancel', up);
    d.addEventListener('pointerleave', function () { if (holdTimer) up(); });
  }

  // ---- assignment overlay ----------------------------------------------
  function openAssign(c, r, k) {
    assignSlot = { col: c, row: r, key: k };
    assignPick = null;
    el('assigntitle').textContent = 'Key ' + (c + 1) + ',' + (r + 1) + (k ? ' — ' + k.name : '');
    el('unassignbtn').hidden = !k;
    el('settingsbox').value = k ? JSON.stringify(k.settings || {}, null, 2) : '{}';
    el('assignmsg').textContent = k ? 'Tap an action to reassign, or edit this key’s settings.' : 'Tap an action to assign it to this key.';
    var list = el('actionlist');
    list.innerHTML = '';
    var any = false;
    ((snap && snap.plugins) || []).forEach(function (p) {
      p.actions.forEach(function (a) {
        any = true;
        var b = document.createElement('button');
        b.type = 'button'; b.className = 'act';
        var im = document.createElement('img'); actionIcon(p.id, a.icon, im); b.appendChild(im);
        var g = document.createElement('span'); g.className = 'grow'; g.textContent = a.name; b.appendChild(g);
        var s = document.createElement('span'); s.className = 'sub'; s.textContent = p.name; b.appendChild(s);
        b.addEventListener('click', function () {
          [].forEach.call(list.children, function (x) { x.classList.remove('on'); });
          b.classList.add('on');
          post('assign', { col: assignSlot.col, row: assignSlot.row, action: a.uuid, plugin: p.id }).then(function (res) {
            el('assignmsg').textContent = res.ok ? 'Assigned ✓' : ('Failed: ' + (res.error || ''));
            if (res.ok) assignSlot.context = res.context;
          });
        });
        list.appendChild(b);
      });
    });
    if (!any) { var msg = document.createElement('div'); msg.className = 'pk-empty'; msg.textContent = 'No plugin actions available yet. Add *.sdPlugin folders to your plugins folder and restart.'; list.appendChild(msg); }
    el('assign').hidden = false;
  }
  el('assignclose').addEventListener('click', function () { el('assign').hidden = true; assignSlot = null; });
  el('unassignbtn').addEventListener('click', function () {
    if (!assignSlot) return;
    post('unassign', { col: assignSlot.col, row: assignSlot.row }).then(function () { el('assign').hidden = true; assignSlot = null; });
  });
  el('settingssave').addEventListener('click', function () {
    if (!assignSlot) return;
    var ctx = assignSlot.context || (assignSlot.key && assignSlot.key.context);
    if (!ctx) { el('assignmsg').textContent = 'Assign an action first.'; return; }
    var parsed;
    try { parsed = JSON.parse(el('settingsbox').value || '{}'); } catch (e) { el('assignmsg').textContent = 'Not valid JSON.'; return; }
    post('settings-set', { context: ctx, settings: parsed }).then(function (res) {
      el('assignmsg').textContent = res.ok ? 'Settings saved ✓' : ('Failed: ' + (res.error || ''));
    });
  });

  // ---- plugins overlay -------------------------------------------------
  el('pluginsbtn').addEventListener('click', function () { renderPlugins(); el('pluginspane').hidden = false; });
  el('pluginsclose').addEventListener('click', function () { el('pluginspane').hidden = true; });
  function renderPlugins() {
    var list = el('pluginlist');
    list.innerHTML = '';
    var ps = (snap && snap.plugins) || [];
    if (!ps.length) { var m = document.createElement('div'); m.className = 'pk-empty'; m.textContent = 'No plugins found. Set this page’s "Plugins folder" option to a folder holding *.sdPlugin packages. Plugins are real programs that run on your PC — only use plugins you trust.'; list.appendChild(m); return; }
    ps.forEach(function (p) {
      var d = document.createElement('div');
      d.className = 'plug';
      var g = document.createElement('span'); g.className = 'grow'; g.textContent = p.name; d.appendChild(g);
      var st = document.createElement('span'); st.className = 'st ' + p.status; st.textContent = p.status + (p.error ? ' — ' + p.error : ''); d.appendChild(st);
      var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Restart';
      b.addEventListener('click', function () { post('restart', { plugin: p.id }); });
      d.appendChild(b);
      list.appendChild(d);
    });
  }
  el('addprofile').addEventListener('click', function () { post('profile-add', {}); });

  // ---- knob (generic drop-in capability) --------------------------------
  // Rotate cycles profiles; everything else is declined so the panel's defaults keep working.
  window.oqKnob = function (ev) {
    if (ev && ev.type === 'rotate' && snap && snap.profiles && snap.profiles.length > 1) {
      var ids = snap.profiles.map(function (p) { return p.id; });
      var i = ids.indexOf(snap.activeProfile);
      var next = ids[(i + (ev.dir > 0 ? 1 : ids.length - 1)) % ids.length];
      post('profile-select', { id: next });
      return true;
    }
    return false;
  };

  poll(0);
  // Refresh transient alert/ok flags even between snapshots.
  setInterval(function () { if (snap) render(); }, 2500);
})();

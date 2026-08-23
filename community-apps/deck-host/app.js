'use strict';
// Stream Deck Host page. Interaction model (post-review):
//   Normal mode: touching a key sends keyDown on finger-down and keyUp on lift -- authentic Stream
//     Deck semantics (plugins may time holds). Nothing else hides behind gestures.
//   Edit mode (header toggle): tapping ANY key -- assigned or empty -- opens the assignment overlay;
//     profile chips grow an X for removal. No hidden hold gesture anywhere.
// Layout: three columns per the design system -- left rail = profiles, center = square key grid,
// right rail = host status + plugins summary. Renders from server.js snapshots (long-poll).
(function () {
  var q = new URLSearchParams(location.search);
  if (q.get('_dark') === '0') document.body.classList.add('light');
  var ACCENT = q.get('_accent');
  if (/^#[0-9a-fA-F]{6}$/.test(ACCENT || '')) document.documentElement.style.setProperty('--accent', ACCENT);

  var el = function (id) { return document.getElementById(id); };
  var grid = el('grid'), profilesNav = el('profiles');
  var snap = null, assignSlot = null, movePending = null;
  var editing = false;              // Edit mode: taps configure instead of pressing
  var confirmRemoveId = null;       // profile chip in remove-confirm state
  var pollFails = 0;                // consecutive long-poll failures -> connection-lost state
  var iconCache = {};               // "plugin|path" -> data URL

  function post(action, body) {
    return fetch('/app-api/' + action, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) })
      .then(function (r) { return r.json(); }).catch(function () { return { ok: false, error: 'panel lost the deck host' }; });
  }

  // ---- long-poll loop ---------------------------------------------------
  function poll(since) {
    fetch('/app-api/state' + (since ? '?since=' + since : ''))
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.ok) { pollFails = 0; snap = j; render(); poll(j.v); }
        else { pollFails++; render(); setTimeout(function () { poll(0); }, 2000); }
      })
      .catch(function () { pollFails++; render(); setTimeout(function () { poll(0); }, 2000); });
  }

  // ---- transient key feedback (no full re-render) -----------------------
  function flashKey(d, cls, ms) {
    d.classList.add(cls);
    setTimeout(function () { d.classList.remove(cls); }, ms || 900);
  }
  function toast(msg, bad) {
    var t = el('toast');
    t.textContent = msg; t.className = bad ? 'bad' : ''; t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, 2600);
  }

  // ---- status (right rail) ----------------------------------------------
  function renderStatus() {
    var dot = el('hostdot'), txt = el('hoststatus');
    if (pollFails >= 2) { dot.className = 'dot bad'; txt.textContent = 'Panel lost the deck host — retrying…'; document.body.classList.add('lost'); return; }
    document.body.classList.remove('lost');
    if (movePending) { dot.className = 'dot warn'; txt.textContent = 'Moving key — tap a highlighted slot. Tap anything else to cancel.'; return; }
    if (editing) { dot.className = 'dot warn'; txt.textContent = 'Edit mode — tap a key to assign or configure it; ✕ removes a profile.'; return; }
    var ps = (snap && snap.plugins) || [];
    var skipped = (snap && snap.skipped) || [];
    if (!ps.length) {
      dot.className = 'dot warn';
      txt.textContent = !snap || !snap.folder ? 'Plugins folder not set' : (skipped.length ? skipped.length + ' package(s) can’t run — see Plugins' : 'No plugins found yet');
      return;
    }
    var running = ps.filter(function (p) { return p.status === 'running'; }).length;
    var attention = ps.filter(function (p) { return p.status === 'crashed' || p.status === 'unsupported'; }).length + skipped.length;
    dot.className = 'dot ' + (attention ? 'bad' : running ? 'ok' : 'warn');
    txt.textContent = running + '/' + ps.length + ' plugins running' + (attention ? ' · ' + attention + ' need attention' : '');
  }

  // ---- profiles (left rail) ---------------------------------------------
  function renderProfiles() {
    profilesNav.innerHTML = '';
    el('editbtn').textContent = editing ? 'Done' : 'Edit';
    el('editbtn').classList.toggle('on', editing);
    (snap.profiles || []).forEach(function (pr) {
      if (pr.id === confirmRemoveId) {
        var count = 0;
        if (snap.keys && pr.id === snap.activeProfile) count = Object.keys(snap.keys).length;
        var rm = document.createElement('button');
        rm.type = 'button'; rm.tabIndex = -1; rm.className = 'removing';
        rm.textContent = 'Remove "' + pr.name + '"' + (count ? ' + ' + count + ' key' + (count === 1 ? '' : 's') : '') + '?';
        rm.addEventListener('click', function () { confirmRemoveId = null; post('profile-remove', { id: pr.id }).then(function (r) { if (!r.ok) toast(r.error, true); }); });
        var keep = document.createElement('button');
        keep.type = 'button'; keep.tabIndex = -1; keep.textContent = 'Keep';
        keep.addEventListener('click', function () { confirmRemoveId = null; renderProfiles(); });
        profilesNav.appendChild(rm); profilesNav.appendChild(keep);
        return;
      }
      var b = document.createElement('button');
      b.type = 'button'; b.tabIndex = -1;
      b.className = pr.id === snap.activeProfile ? 'on' : '';
      b.textContent = editing ? '✕ ' + pr.name : pr.name;
      b.addEventListener('click', function () {
        if (!editing) { post('profile-select', { id: pr.id }); return; }
        if ((snap.profiles || []).length <= 1) { toast('The last profile can’t be removed.', true); return; }
        confirmRemoveId = pr.id; renderProfiles();
      });
      profilesNav.appendChild(b);
    });
  }

  // ---- plugins summary (right rail) -------------------------------------
  function renderPluginsRail() {
    var host = el('plugrail');
    host.innerHTML = '';
    var ps = (snap && snap.plugins) || [];
    var skipped = (snap && snap.skipped) || [];
    ps.forEach(function (p) {
      var d = document.createElement('div'); d.className = 'prow';
      var st = document.createElement('span'); st.className = 'pdot ' + p.status; d.appendChild(st);
      var g = document.createElement('span'); g.className = 'grow'; g.textContent = p.name; d.appendChild(g);
      host.appendChild(d);
    });
    if (skipped.length) {
      var s = document.createElement('div'); s.className = 'prow skip';
      s.textContent = skipped.length + ' skipped package' + (skipped.length === 1 ? '' : 's');
      host.appendChild(s);
    }
  }

  // ---- key grid (center) ------------------------------------------------
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
  function normalizeImage(img) {
    if (!img) return '';
    return /^data:/.test(img) ? img : 'data:image/png;base64,' + img;   // some SDKs send bare base64
  }
  function shortName(k) {
    if (k.name && k.name.indexOf('.') < 0) return k.name;
    var parts = String(k.name || k.action || '').split('.');
    return parts[parts.length - 1] || 'key';
  }
  function render() {
    if (!snap) { renderStatus(); return; }
    renderStatus();
    renderProfiles();
    renderPluginsRail();
    var ps = snap.plugins || [];
    // First-run empty state: one clear instruction instead of 24 dashed boxes.
    if (!ps.length && !(snap.skipped || []).length) {
      grid.style.gridTemplateColumns = '1fr'; grid.style.gridTemplateRows = '1fr';
      grid.innerHTML = '';
      var e0 = document.createElement('div'); e0.className = 'bigempty';
      e0.textContent = !snap.folder
        ? 'Set this page’s “Plugins folder” option in the editor (and Save), then drop *.sdPlugin folders or downloaded .streamDeckPlugin files into it.'
        : 'Drop *.sdPlugin folders or downloaded .streamDeckPlugin files into\n' + snap.folder;
      grid.appendChild(e0);
      return;
    }
    var lay = snap.layout || { columns: 8, rows: 3 };
    var availW = grid.clientWidth - 32 - (lay.columns - 1) * 8;
    var availH = grid.clientHeight - 16 - (lay.rows - 1) * 8;
    var ks = Math.max(64, Math.floor(Math.min(availW / lay.columns, availH / lay.rows)));
    grid.style.gridTemplateColumns = 'repeat(' + lay.columns + ', ' + ks + 'px)';
    grid.style.gridTemplateRows = 'repeat(' + lay.rows + ', ' + ks + 'px)';
    document.documentElement.style.setProperty('--kt', Math.max(16, Math.round(ks / 4.6)) + 'px');
    grid.innerHTML = '';
    for (var r = 0; r < lay.rows; r++) {
      for (var c = 0; c < lay.columns; c++) (function (c, r) {
        var pos = c + ',' + r;
        var k = snap.keys && snap.keys[pos];
        var d = document.createElement('div');
        d.className = 'key' + (k ? '' : ' empty');
        if (k) {
          var plug = ps.find(function (p) { return p.id === k.plugin; });
          if (!plug || plug.status !== 'running') d.classList.add('dead');   // missing plugin looks dead too
          var img = normalizeImage(k.image);
          var t = document.createElement('span'); t.className = 'kt';
          t.textContent = k.title || (img ? '' : shortName(k));
          if (img) {
            var im = document.createElement('img'); im.src = img; d.appendChild(im); d.classList.add('has-img');
            im.onerror = function () { im.remove(); d.classList.remove('has-img'); t.textContent = k.title || shortName(k); };
          } else if (k.icon) {
            var im2 = document.createElement('img'); actionIcon(k.plugin, k.icon, im2); d.appendChild(im2); d.classList.add('has-img');
          }
          if (t.textContent) d.appendChild(t);
          if (!plug) { var miss = document.createElement('span'); miss.className = 'kt missing'; miss.textContent = 'plugin missing'; d.appendChild(miss); }
          if (k.ok && Date.now() - k.ok < 1500) flashKey(d, 'okflash', 1500 - (Date.now() - k.ok));
          if (k.alert && Date.now() - k.alert < 1500) flashKey(d, 'alertflash', 1500 - (Date.now() - k.alert));
          wireAssigned(d, k, c, r);
        } else {
          var e = document.createElement('span'); e.className = 'kt';
          e.textContent = movePending ? '⤵' : (editing ? '+' : '');
          if (movePending) d.classList.add('movetarget');
          d.appendChild(e);
          d.addEventListener('click', function () {
            if (movePending) {
              var from = movePending; movePending = null;
              post('move', { fromCol: from.col, fromRow: from.row, toCol: c, toRow: r }).then(function (res) { if (!res.ok) { toast(res.error, true); render(); } });
              return;
            }
            if (editing) openAssign(c, r, null);
          });
        }
        grid.appendChild(d);
      })(c, r);
    }
  }
  // Assigned key: authentic press semantics -- keyDown on finger-down, keyUp on lift. Edit mode
  // routes the tap to configuration instead. Press failures flash the key red (never silent).
  function wireAssigned(d, k, c, r) {
    var downSent = false;
    d.addEventListener('pointerdown', function (ev) {
      ev.preventDefault();
      if (movePending) { movePending = null; render(); return; }
      if (editing) return;
      downSent = true;
      d.classList.add('pressed');
      post('press', { context: k.context }).then(function (res) { if (!res.ok) { flashKey(d, 'alertflash'); toast(res.error + ' — see Plugins', true); } });
    });
    var lift = function () {
      d.classList.remove('pressed');
      if (downSent) { downSent = false; post('release', { context: k.context }); }
    };
    d.addEventListener('pointerup', lift);
    d.addEventListener('pointercancel', lift);
    d.addEventListener('pointerleave', function () { if (downSent) lift(); });
    d.addEventListener('click', function () { if (editing) openAssign(c, r, k); });
  }

  // ---- assignment overlay -----------------------------------------------
  var armAssign = null;   // action row armed for the confirm-second-tap when reassigning
  function openAssign(c, r, k) {
    assignSlot = { col: c, row: r, key: k, profile: snap.activeProfile };
    armAssign = null;
    el('assigntitle').textContent = 'Key ' + (c + 1) + ',' + (r + 1) + (k ? ' — ' + shortName(k) : '');
    el('unassignbtn').hidden = !k;
    el('movebtn').hidden = !k;
    el('settingsbox').value = k ? JSON.stringify(k.settings || {}, null, 2) : '{}';
    el('assignmsg').textContent = k ? 'Tap an action twice to replace this key (its settings reset), or edit its settings below.' : 'Tap an action to assign it to this key.';
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
          if (assignSlot.key && armAssign !== b) {   // replacing an assigned key erases its settings -> second tap confirms
            [].forEach.call(list.children, function (x) { x.classList.remove('arming'); });
            armAssign = b; b.classList.add('arming');
            el('assignmsg').textContent = 'Tap again to replace this key with "' + a.name + '" (current settings will be erased).';
            return;
          }
          if (snap.activeProfile !== assignSlot.profile) { el('assignmsg').textContent = 'The active profile changed — close and try again.'; return; }
          armAssign = null;
          post('assign', { col: assignSlot.col, row: assignSlot.row, action: a.uuid, plugin: p.id }).then(function (res) {
            el('assignmsg').textContent = res.ok ? 'Assigned ✓' : ('Failed: ' + (res.error || ''));
            if (res.ok) { assignSlot.context = res.context; assignSlot.key = { context: res.context, settings: {} }; el('unassignbtn').hidden = false; el('movebtn').hidden = false; el('settingsbox').value = '{}'; }
          });
        });
        list.appendChild(b);
      });
    });
    if (!any) { var msg = document.createElement('div'); msg.className = 'pk-empty'; msg.textContent = 'No plugin actions available. Add plugins to your folder first.'; list.appendChild(msg); }
    el('assign').hidden = false;
  }
  el('assignclose').addEventListener('click', function () { el('assign').hidden = true; assignSlot = null; });
  el('movebtn').addEventListener('click', function () {
    if (!assignSlot) return;
    movePending = { col: assignSlot.col, row: assignSlot.row };
    el('assign').hidden = true; assignSlot = null;
    render();
  });
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

  // ---- plugins overlay ---------------------------------------------------
  el('pluginsbtn').addEventListener('click', function () { renderPluginsPane(); el('pluginspane').hidden = false; });
  el('pluginsclose').addEventListener('click', function () { el('pluginspane').hidden = true; });
  el('rescanbtn').addEventListener('click', function () {
    post('rescan', {}).then(function (j) {
      if (j && j.ok) {
        snap = j; render(); renderPluginsPane();
        toast('Rescanned: ' + j.plugins.length + ' plugin' + (j.plugins.length === 1 ? '' : 's') + (j.skipped.length ? ', ' + j.skipped.length + ' skipped' : ''));
      } else toast('Rescan failed', true);
    });
  });
  function renderPluginsPane() {
    var list = el('pluginlist');
    list.innerHTML = '';
    var ps = (snap && snap.plugins) || [];
    var sk = (snap && snap.skipped) || [];
    if (!ps.length && !sk.length) {
      var m = document.createElement('div'); m.className = 'pk-empty';
      m.textContent = (snap && snap.folder ? 'Nothing in ' + snap.folder + ' yet. Drop *.sdPlugin folders or downloaded .streamDeckPlugin files there.' : 'Set this page’s "Plugins folder" option (and Save).') + ' Plugins are real programs that run on your PC — only use plugins you trust.';
      list.appendChild(m); return;
    }
    ps.forEach(function (p) {
      var d = document.createElement('div');
      d.className = 'plug';
      var head = document.createElement('div'); head.className = 'plughead';
      var g = document.createElement('span'); g.className = 'grow'; g.textContent = p.name; head.appendChild(g);
      var st = document.createElement('span'); st.className = 'st ' + p.status; st.textContent = p.status; head.appendChild(st);
      var b = document.createElement('button'); b.type = 'button'; b.textContent = 'Restart';
      b.addEventListener('click', function () { post('restart', { plugin: p.id }).then(function (r) { toast(r.ok ? 'Restarting ' + p.name + '…' : (r.error || 'restart failed'), !r.ok); }); });
      head.appendChild(b);
      d.appendChild(head);
      if (p.error) { var er = document.createElement('div'); er.className = 'plugerr'; er.textContent = p.error; d.appendChild(er); }
      (p.log || []).slice(-3).forEach(function (ln) { var lg = document.createElement('div'); lg.className = 'pluglog'; lg.textContent = ln; d.appendChild(lg); });
      list.appendChild(d);
    });
    sk.forEach(function (s) {
      var d = document.createElement('div');
      d.className = 'plug';
      var head = document.createElement('div'); head.className = 'plughead';
      var g = document.createElement('span'); g.className = 'grow'; g.textContent = s.file; head.appendChild(g);
      var st = document.createElement('span'); st.className = 'st unsupported'; st.textContent = 'skipped'; head.appendChild(st);
      d.appendChild(head);
      var er = document.createElement('div'); er.className = 'plugerr'; er.textContent = s.reason; d.appendChild(er);
      list.appendChild(d);
    });
  }

  // ---- header buttons ----------------------------------------------------
  el('editbtn').addEventListener('click', function () {
    editing = !editing;
    confirmRemoveId = null; movePending = null;
    render();
  });
  var addArm = null;
  el('addprofile').addEventListener('click', function () {
    var b = el('addprofile');
    if (addArm) {
      clearTimeout(addArm); addArm = null; b.textContent = '+ Profile';
      post('profile-add', {}).then(function (r) { if (r.ok) post('profile-select', { id: r.id }); });   // new profile becomes active
      return;
    }
    b.textContent = 'Tap again to add';
    addArm = setTimeout(function () { addArm = null; b.textContent = '+ Profile'; }, 3000);
  });

  // ---- knob (generic drop-in capability) ---------------------------------
  // Rotate cycles profiles -- but never while an overlay or move is in progress (declined -> panel default).
  window.oqKnob = function (ev) {
    if (!el('assign').hidden || !el('pluginspane').hidden || movePending || editing) return false;
    if (ev && ev.type === 'rotate' && snap && snap.profiles && snap.profiles.length > 1) {
      var ids = snap.profiles.map(function (p) { return p.id; });
      var i = ids.indexOf(snap.activeProfile);
      post('profile-select', { id: ids[(i + (ev.dir > 0 ? 1 : ids.length - 1)) % ids.length] });
      return true;
    }
    return false;
  };

  poll(0);
  window.addEventListener('resize', function () { if (snap) render(); });
})();

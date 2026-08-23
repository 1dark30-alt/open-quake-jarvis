'use strict';
// Stream Deck plugin host. Implements Elgato's documented plugin WebSocket protocol so unmodified
// *.sdPlugin packages run against the panel: this module (running in open-quake's main Node process)
// spawns each plugin's CodePath with the standard registration args (-port -pluginUUID -registerEvent
// -info), accepts its WebSocket, and speaks the SDK events. The app's page renders the key grid and
// talks to this module over /app-api/<action>.
//
// Approach per OpenDeck (protocol reimplementation, no Elgato or OpenDeck code). MVP scope: Keypad
// actions from native (.exe) and Node (.js) plugins; single image/title per context (state-scoped
// images collapse to the latest); no property inspectors (raw settings JSON instead), no Encoders yet.
//
// Actions (GET/POST /app-api/<action>):
//   state?since=N   long-poll snapshot { v, layout, profiles, activeProfile, keys, plugins, actions }
//   press / release {context}          -> keyDown / keyUp to the owning plugin
//   assign {col,row,action}            -> bind an action instance to a key slot (new context)
//   unassign {col,row}                 -> remove the binding (willDisappear)
//   settings-set {context, settings}   -> persist + didReceiveSettings
//   profile-select {id} · profile-add {name} · profile-remove {id}
//   asset?plugin=..&path=..            -> base64 of a plugin image file (icons for the picker)
//   restart {plugin}                   -> restart a crashed/stopped plugin

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const MAX_ASSET = 4 * 1024 * 1024;
const LONGPOLL_MS = 25000;
const RESTART_BACKOFF = [1000, 5000, 15000];

// ---- state ------------------------------------------------------------------------------------
let wss = null, wssPort = 0, startedFor = '';   // startedFor = pluginsDir the host was started against
const plugins = new Map();     // pluginId -> { id, dir, manifest, actions:[], uuid, proc, ws, status, restarts, log:[] }
let deck = null;               // persisted: { profiles:[{id,name,keys:{ "c,r":context }}], activeProfileId, contexts:{ctx:{action,plugin,col,row,settings}}, globalSettings:{pluginId:{}} }
const keyState = new Map();    // context -> { image, title, state, alert, ok }
let version = 1;
let waiters = [];              // parked long-polls: { resolve, timer }

function bump() {
  version++;
  const w = waiters; waiters = [];
  w.forEach(x => { clearTimeout(x.timer); try { x.resolve(); } catch (e) {} });
}

// ---- config / persistence ---------------------------------------------------------------------
function pluginsDirOf(options) {
  const chosen = String((options && options.pluginsDir) || '').trim();
  if (chosen) { try { if (fs.statSync(chosen).isDirectory()) return path.resolve(chosen); } catch (e) {} }
  return '';
}
// Deck layout/assignments persist OUTSIDE the app folder (an update replaces it): beside the user's
// plugins folder, or in the host's per-user data dir when no plugins folder is set yet.
function deckFile(options) {
  const pd = pluginsDirOf(options);
  if (pd) return path.join(pd, 'deck-host.json');
  try {
    const electron = require('electron');
    const userDir = electron && electron.app && electron.app.getPath('userData');
    if (userDir) return path.join(userDir, 'deck-host.json');
  } catch (e) {}
  return path.join(__dirname, 'deck-host.json');
}
function defaultDeck() {
  const id = 'p' + crypto.randomBytes(3).toString('hex');
  return { profiles: [{ id, name: 'Main', keys: {} }], activeProfileId: id, contexts: {}, globalSettings: {} };
}
function loadDeck(options) {
  if (deck) return deck;
  try { deck = JSON.parse(fs.readFileSync(deckFile(options), 'utf8')); } catch (e) { deck = null; }
  if (!deck || !Array.isArray(deck.profiles) || !deck.profiles.length) deck = defaultDeck();
  if (!deck.contexts) deck.contexts = {};
  if (!deck.globalSettings) deck.globalSettings = {};
  if (!deck.profiles.some(p => p.id === deck.activeProfileId)) deck.activeProfileId = deck.profiles[0].id;
  return deck;
}
function saveDeck(options) { try { fs.writeFileSync(deckFile(options), JSON.stringify(deck, null, 2)); } catch (e) {} }
function activeProfile() { return deck.profiles.find(p => p.id === deck.activeProfileId) || deck.profiles[0]; }
function layoutOf(options) {
  const m = /^(\d+)x(\d+)$/.exec(String((options && options.layout) || '8x3'));
  const cols = m ? Math.min(12, Math.max(1, +m[1])) : 8, rows = m ? Math.min(6, Math.max(1, +m[2])) : 3;
  return { columns: cols, rows };
}

// ---- plugin discovery -------------------------------------------------------------------------
function scanPlugins(dir) {
  const found = [];
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return found; }
  for (const ent of ents) {
    if (!ent.isDirectory() || !/\.sdPlugin$/i.test(ent.name)) continue;
    const pdir = path.join(dir, ent.name);
    let man; try { man = JSON.parse(fs.readFileSync(path.join(pdir, 'manifest.json'), 'utf8')); } catch (e) { continue; }
    if (!man || !Array.isArray(man.Actions)) continue;
    const os = Array.isArray(man.OS) ? man.OS : [];
    if (os.length && !os.some(o => /windows/i.test((o && o.Platform) || ''))) continue;   // windows-only host
    const id = ent.name.replace(/\.sdPlugin$/i, '');
    found.push({ id, dir: pdir, manifest: man });
  }
  return found;
}
// Resolve the executable this plugin runs. CodePathWin wins on Windows; a .html CodePath needs a
// browser runtime we don't provide (deferred) -> unsupported.
function codePathOf(p) {
  const man = p.manifest;
  const raw = String(man.CodePathWin || man.CodePath || '').trim();
  if (!raw) return null;
  const full = path.resolve(p.dir, raw);
  if (!full.startsWith(path.resolve(p.dir) + path.sep)) return null;   // confined to the plugin folder
  if (/\.html?$/i.test(raw)) return { unsupported: 'HTML plugin (needs a browser runtime)' };
  return { path: full, node: /\.(js|mjs|cjs)$/i.test(raw) };
}

// ---- the WebSocket host -----------------------------------------------------------------------
function ensureWss() {
  if (wss) return Promise.resolve(wssPort);
  const WebSocket = require('ws');
  return new Promise((resolve, reject) => {
    const server = new WebSocket.Server({ host: '127.0.0.1', port: 0 }, () => {
      wss = server; wssPort = server.address().port; resolve(wssPort);
    });
    server.on('error', reject);
    server.on('connection', ws => {
      // The first message must be the registration: { event: 'registerPlugin', uuid: <pluginUUID> }.
      ws.once('message', raw => {
        let msg; try { msg = JSON.parse(raw.toString('utf8')); } catch (e) { ws.close(); return; }
        const p = [...plugins.values()].find(x => x.uuid === msg.uuid);
        if (!p) { ws.close(); return; }
        p.ws = ws; p.status = 'running'; p.restarts = 0;
        ws.on('message', raw2 => { onPluginMessage(p, raw2); });
        ws.on('close', () => { if (p.ws === ws) { p.ws = null; if (p.status === 'running') p.status = 'stopped'; bump(); } });
        // Announce the device, then surface every visible key owned by this plugin.
        sendTo(p, { event: 'deviceDidConnect', device: deviceId(), deviceInfo: { name: 'open-quake', type: 0, size: lastLayout } });
        visibleContextsOf(p).forEach(ctx => sendTo(p, appearEvent('willAppear', ctx)));
        bump();
      });
    });
  });
}
let lastLayout = { columns: 8, rows: 3 };
function deviceId() { return 'openquake-deck-0'; }
function sendTo(p, obj) { if (p && p.ws && p.ws.readyState === 1) { try { p.ws.send(JSON.stringify(obj)); } catch (e) {} } }
function ctxInfo(ctx) { return deck.contexts[ctx] || null; }
function visibleContextsOf(p) {
  const prof = activeProfile();
  return Object.values(prof.keys).filter(ctx => { const c = ctxInfo(ctx); return c && c.plugin === p.id; });
}
function appearEvent(event, ctx) {
  const c = ctxInfo(ctx);
  return {
    event, action: c.action, context: ctx, device: deviceId(),
    payload: { controller: 'Keypad', coordinates: { column: c.col, row: c.row }, settings: c.settings || {}, state: (keyState.get(ctx) || {}).state || 0, isInMultiAction: false },
  };
}

// Plugin -> host commands.
function onPluginMessage(p, raw) {
  let m; try { m = JSON.parse(raw.toString('utf8')); } catch (e) { return; }
  const ctx = m.context, ks = ctx ? (keyState.get(ctx) || keyState.set(ctx, {}).get(ctx)) : null;
  switch (m.event) {
    case 'setImage': if (ks) { ks.image = (m.payload && m.payload.image) || ''; bump(); } break;
    case 'setTitle': if (ks) { ks.title = (m.payload && typeof m.payload.title === 'string') ? m.payload.title : ''; bump(); } break;
    case 'setState': if (ks) { ks.state = (m.payload && m.payload.state) | 0; bump(); } break;
    case 'showAlert': if (ks) { ks.alert = Date.now(); bump(); } break;
    case 'showOk': if (ks) { ks.ok = Date.now(); bump(); } break;
    case 'setSettings': {
      const c = ctxInfo(ctx); if (!c) break;
      c.settings = (m.payload && typeof m.payload === 'object') ? m.payload : {};
      saveDeck(lastOptions); sendTo(p, appearEventSettings(ctx)); bump(); break;
    }
    case 'getSettings': { if (ctxInfo(ctx)) sendTo(p, appearEventSettings(ctx)); break; }
    case 'setGlobalSettings': deck.globalSettings[p.id] = (m.payload && typeof m.payload === 'object') ? m.payload : {}; saveDeck(lastOptions); break;
    case 'getGlobalSettings': sendTo(p, { event: 'didReceiveGlobalSettings', payload: { settings: deck.globalSettings[p.id] || {} } }); break;
    case 'logMessage': p.log.push(String((m.payload && m.payload.message) || '').slice(0, 500)); if (p.log.length > 50) p.log.shift(); break;
    case 'openUrl': break;   // deliberately ignored: a kiosk panel doesn't pop browsers
    default: break;          // setFeedback / switchToProfile / PI messages: deferred
  }
}
function appearEventSettings(ctx) { const e = appearEvent('didReceiveSettings', ctx); return e; }

// ---- plugin processes -------------------------------------------------------------------------
let lastOptions = null;
async function startPlugin(p) {
  const cp = codePathOf(p);
  if (!cp || cp.unsupported) { p.status = 'unsupported'; p.error = (cp && cp.unsupported) || 'no CodePath'; return; }
  const port = await ensureWss();
  p.uuid = crypto.randomUUID();
  const info = {
    application: { font: 'Segoe UI', language: 'en', platform: 'windows', platformVersion: '10', version: '6.5.0' },
    colors: { buttonMouseOverBackgroundColor: '#464646FF', buttonPressedBackgroundColor: '#303030FF', buttonPressedBorderColor: '#646464FF', buttonPressedTextColor: '#969696FF', highlightColor: '#7CFFB2FF' },
    devicePixelRatio: 1,
    devices: [{ id: deviceId(), name: 'open-quake', size: lastLayout, type: 0 }],
    plugin: { uuid: p.id, version: String(p.manifest.Version || '1.0') },
  };
  const args = ['-port', String(port), '-pluginUUID', p.uuid, '-registerEvent', 'registerPlugin', '-info', JSON.stringify(info)];
  try {
    p.proc = cp.node
      ? spawn(process.execPath, [cp.path, ...args], { cwd: p.dir, env: Object.assign({}, process.env, { ELECTRON_RUN_AS_NODE: '1' }), stdio: 'ignore', windowsHide: true })
      : spawn(cp.path, args, { cwd: p.dir, stdio: 'ignore', windowsHide: true });
  } catch (e) { p.status = 'crashed'; p.error = e.message; bump(); return; }
  p.status = 'starting'; p.error = '';
  p.proc.on('exit', () => {
    p.proc = null;
    if (p.status === 'stopping') { p.status = 'stopped'; bump(); return; }
    p.status = 'crashed'; bump();
    const delay = RESTART_BACKOFF[Math.min(p.restarts, RESTART_BACKOFF.length - 1)];
    if (p.restarts < RESTART_BACKOFF.length) { p.restarts++; setTimeout(() => { if (p.status === 'crashed') startPlugin(p); }, delay); }
  });
  bump();
}
function stopPlugin(p) {
  p.status = 'stopping';
  try { if (p.ws) p.ws.close(); } catch (e) {}
  try { if (p.proc) p.proc.kill(); } catch (e) {}
}
process.on('exit', () => { for (const p of plugins.values()) { try { if (p.proc) p.proc.kill(); } catch (e) {} } });

async function ensureStarted(options) {
  lastOptions = options;
  lastLayout = layoutOf(options);
  const dir = pluginsDirOf(options);
  if (startedFor === dir) return;
  // Plugins folder changed (or first call): stop everything from the old folder, rescan, start.
  for (const p of plugins.values()) stopPlugin(p);
  plugins.clear();
  startedFor = dir;
  loadDeck(options);
  if (!dir) return;
  for (const found of scanPlugins(dir)) {
    const p = Object.assign(found, { uuid: '', proc: null, ws: null, status: 'stopped', restarts: 0, log: [], error: '',
      actions: found.manifest.Actions.filter(a => !a.Controllers || a.Controllers.indexOf('Keypad') >= 0)
        .map(a => ({ uuid: a.UUID, name: a.Name || a.UUID, icon: a.Icon || '', states: (a.States || []).length || 1 })) });
    plugins.set(p.id, p);
    startPlugin(p);   // fire and forget; status flows through the snapshot
  }
}

// ---- snapshot / long-poll ---------------------------------------------------------------------
function snapshot() {
  const prof = activeProfile();
  const keys = {};
  Object.entries(prof.keys).forEach(([pos, ctx]) => {
    const c = ctxInfo(ctx); if (!c) return;
    const ks = keyState.get(ctx) || {};
    const plug = plugins.get(c.plugin);
    const actDef = plug && plug.actions.find(a => a.uuid === c.action);
    keys[pos] = { context: ctx, action: c.action, plugin: c.plugin, image: ks.image || '', title: ks.title || '',
      state: ks.state || 0, alert: ks.alert || 0, ok: ks.ok || 0, settings: c.settings || {},
      name: (actDef && actDef.name) || c.action, icon: (actDef && actDef.icon) || '' };
  });
  return {
    v: version, layout: lastLayout,
    profiles: deck.profiles.map(pr => ({ id: pr.id, name: pr.name })), activeProfile: deck.activeProfileId,
    keys,
    plugins: [...plugins.values()].map(p => ({ id: p.id, name: p.manifest.Name || p.id, status: p.status, error: p.error || '',
      actions: p.actions })),
  };
}

// ---- asset serving (plugin icons for the picker) ----------------------------------------------
const ASSET_MIME = { '.png': 'image/png', '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif' };
function readAsset(pluginId, rel) {
  const p = plugins.get(String(pluginId || ''));
  if (!p) return null;
  const raw = String(rel || '').trim();
  if (!raw) return null;
  const base = path.resolve(p.dir);
  // Elgato image references omit the extension; try verbatim, then .png / @2x.png / .svg.
  for (const cand of [raw, raw + '.png', raw + '@2x.png', raw + '.svg']) {
    const full = path.resolve(base, cand);
    if (!full.startsWith(base + path.sep)) return null;
    const ext = path.extname(full).toLowerCase();
    if (!ASSET_MIME[ext]) continue;
    try {
      const st = fs.statSync(full);
      if (!st.isFile() || st.size > MAX_ASSET) continue;
      return { mime: ASSET_MIME[ext], b64: fs.readFileSync(full).toString('base64') };
    } catch (e) {}
  }
  return null;
}

// ---- /app-api dispatch ------------------------------------------------------------------------
async function handle(action, context) {
  const options = (context && context.options) || {};
  const query = (context && context.query) || {};
  let body = null;
  if (context && context.body) { try { body = JSON.parse(context.body.toString('utf8')); } catch (e) { body = null; } }
  await ensureStarted(options);

  if (action === 'state') {
    const since = Number(query.since) || 0;
    if (since && since >= version) {
      await new Promise(resolve => { const timer = setTimeout(resolve, LONGPOLL_MS); waiters.push({ resolve, timer }); });
    }
    return Object.assign({ ok: true }, snapshot());
  }

  if (action === 'press' || action === 'release') {
    const ctx = String((body && body.context) || query.context || '');
    const c = ctxInfo(ctx);
    if (!c) return { ok: false, error: 'unknown key' };
    const p = plugins.get(c.plugin);
    if (!p || p.status !== 'running') return { ok: false, error: 'plugin not running' };
    sendTo(p, appearEvent(action === 'press' ? 'keyDown' : 'keyUp', ctx));
    return { ok: true };
  }

  if (action === 'assign') {
    const col = (body && body.col) | 0, row = (body && body.row) | 0;
    const act = String((body && body.action) || ''), plug = String((body && body.plugin) || '');
    const p = plugins.get(plug);
    if (!p || !p.actions.some(a => a.uuid === act)) return { ok: false, error: 'unknown action' };
    const lay = layoutOf(options);
    if (col < 0 || row < 0 || col >= lay.columns || row >= lay.rows) return { ok: false, error: 'slot out of range' };
    const prof = activeProfile();
    const pos = col + ',' + row;
    if (prof.keys[pos]) unassignPos(prof, pos);
    const ctx = crypto.randomUUID().replace(/-/g, '');
    deck.contexts[ctx] = { action: act, plugin: plug, col, row, settings: {} };
    prof.keys[pos] = ctx;
    saveDeck(options);
    if (p.status === 'running') sendTo(p, appearEvent('willAppear', ctx));
    bump();
    return { ok: true, context: ctx };
  }

  if (action === 'unassign') {
    const pos = ((body && body.col) | 0) + ',' + ((body && body.row) | 0);
    const prof = activeProfile();
    if (!prof.keys[pos]) return { ok: false, error: 'empty slot' };
    unassignPos(prof, pos);
    saveDeck(options); bump();
    return { ok: true };
  }

  if (action === 'settings-set') {
    const ctx = String((body && body.context) || '');
    const c = ctxInfo(ctx);
    if (!c) return { ok: false, error: 'unknown key' };
    c.settings = (body && typeof body.settings === 'object' && body.settings) || {};
    saveDeck(options);
    const p = plugins.get(c.plugin);
    if (p && p.status === 'running') sendTo(p, appearEventSettings(ctx));
    bump();
    return { ok: true };
  }

  if (action === 'profile-select') {
    const id = String((body && body.id) || query.id || '');
    if (!deck.profiles.some(pr => pr.id === id)) return { ok: false, error: 'unknown profile' };
    if (id !== deck.activeProfileId) {
      // willDisappear for the outgoing profile's keys, willAppear for the incoming.
      for (const ctx of Object.values(activeProfile().keys)) { const c = ctxInfo(ctx); const p = c && plugins.get(c.plugin); if (p) sendTo(p, appearEvent('willDisappear', ctx)); }
      deck.activeProfileId = id;
      for (const ctx of Object.values(activeProfile().keys)) { const c = ctxInfo(ctx); const p = c && plugins.get(c.plugin); if (p) sendTo(p, appearEvent('willAppear', ctx)); }
      saveDeck(options); bump();
    }
    return { ok: true };
  }

  if (action === 'profile-add') {
    const name = String((body && body.name) || '').trim().slice(0, 32) || ('Profile ' + (deck.profiles.length + 1));
    const id = 'p' + crypto.randomBytes(3).toString('hex');
    deck.profiles.push({ id, name, keys: {} });
    saveDeck(options); bump();
    return { ok: true, id };
  }

  if (action === 'profile-remove') {
    const id = String((body && body.id) || '');
    if (deck.profiles.length <= 1) return { ok: false, error: 'the last profile cannot be removed' };
    const prof = deck.profiles.find(pr => pr.id === id);
    if (!prof) return { ok: false, error: 'unknown profile' };
    Object.keys(prof.keys).forEach(pos => unassignPos(prof, pos));
    deck.profiles = deck.profiles.filter(pr => pr.id !== id);
    if (deck.activeProfileId === id) deck.activeProfileId = deck.profiles[0].id;
    saveDeck(options); bump();
    return { ok: true };
  }

  if (action === 'asset') {
    const a = readAsset(query.plugin, query.path);
    return a ? { ok: true, mime: a.mime, b64: a.b64 } : { ok: false, error: 'not found' };
  }

  if (action === 'restart') {
    const p = plugins.get(String((body && body.plugin) || query.plugin || ''));
    if (!p) return { ok: false, error: 'unknown plugin' };
    p.restarts = 0;
    if (p.proc) stopPlugin(p);
    else startPlugin(p);
    return { ok: true };
  }

  return { ok: false, error: 'unknown action' };
}

function unassignPos(prof, pos) {
  const ctx = prof.keys[pos];
  const c = ctxInfo(ctx);
  if (c) { const p = plugins.get(c.plugin); if (p) sendTo(p, appearEvent('willDisappear', ctx)); }
  delete prof.keys[pos];
  delete deck.contexts[ctx];
  keyState.delete(ctx);
}

// Stop every plugin process, close the WebSocket server, and release parked long-polls. Used by the
// protocol tests; also safe to call on host teardown.
function _shutdown() {
  for (const p of plugins.values()) stopPlugin(p);
  plugins.clear();
  startedFor = '__shutdown__';
  const w = waiters; waiters = [];
  w.forEach(x => { clearTimeout(x.timer); try { x.resolve(); } catch (e) {} });
  if (wss) { try { wss.close(); for (const c of wss.clients) { try { c.terminate(); } catch (e) {} } } catch (e) {} wss = null; wssPort = 0; }
}

module.exports = { handle, _shutdown };

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
const zlib = require('zlib');
const http = require('http');
const { EventEmitter } = require('events');
const { spawn } = require('child_process');

// ZERO npm dependencies. A drop-in installed under %APPDATA% is outside every node_modules tree, so
// requiring ws/adm-zip is fragile there; this file uses only Node builtins -- a built-in zip reader
// (zlib) and a minimal RFC6455 WebSocket server (http + crypto) below.

// ---- built-in zip reader (store + deflate entries; enough for plugin packages) ----------------
function unzipEntries(buf) {
  // find the End Of Central Directory record (scan back over the trailing comment)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) throw new Error('bad central directory');
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28), extraLen = buf.readUInt16LE(off + 30), cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    // Some Windows-built zips (e.g. BarRaider releases) use backslash entry names, violating the
    // zip spec; normalize so root detection, extraction, and lookups all see forward slashes.
    const name = buf.subarray(off + 46, off + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    entries.push({
      name,
      dir: name.endsWith('/'),
      data() {
        if (buf.readUInt32LE(localOff) !== 0x04034b50) throw new Error('bad local header');
        const lNameLen = buf.readUInt16LE(localOff + 26), lExtraLen = buf.readUInt16LE(localOff + 28);
        const start = localOff + 30 + lNameLen + lExtraLen;
        const raw = buf.subarray(start, start + compSize);
        if (method === 0) return Buffer.from(raw);
        if (method === 8) return zlib.inflateRawSync(raw);
        throw new Error('unsupported compression method ' + method);
      },
    });
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return entries;
}
// Extract a zip's entries under destDir, refusing anything that would escape it (zip-slip).
function extractZip(buf, destDir) {
  const base = path.resolve(destDir);
  for (const e of unzipEntries(buf)) {
    if (/^([a-zA-Z]:|\\\\|\/)/.test(e.name) || e.name.split(/[\\/]/).indexOf('..') >= 0) throw new Error('unsafe zip entry: ' + e.name);
    const full = path.resolve(base, e.name);
    if (full !== base && !full.startsWith(base + path.sep)) throw new Error('unsafe zip entry: ' + e.name);
    if (e.dir) { fs.mkdirSync(full, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, e.data());
  }
}

// ---- built-in minimal WebSocket server (RFC 6455: handshake, text frames, ping, close) --------
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
class MiniSocket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.readyState = 1;   // OPEN (mirrors the ws module's constant)
    this._buf = Buffer.alloc(0);
    this._frags = [];
    this.lastSeen = Date.now();
    socket.on('data', d => { this.lastSeen = Date.now(); this._buf = Buffer.concat([this._buf, d]); this._pump(); });
    const closed = () => { if (this.readyState !== 3) { this.readyState = 3; this.emit('close'); } };
    socket.on('close', closed); socket.on('error', closed); socket.on('end', closed);
  }
  _pump() {
    for (;;) {
      const b = this._buf;
      if (b.length < 2) return;
      const fin = (b[0] & 0x80) !== 0, op = b[0] & 0x0f, masked = (b[1] & 0x80) !== 0;
      let len = b[1] & 0x7f, o = 2;
      if (len === 126) { if (b.length < 4) return; len = b.readUInt16BE(2); o = 4; }
      else if (len === 127) { if (b.length < 10) return; len = Number(b.readBigUInt64BE(2)); o = 10; }
      const maskLen = masked ? 4 : 0;
      if (b.length < o + maskLen + len) return;
      let payload = Buffer.from(b.subarray(o + maskLen, o + maskLen + len));
      if (masked) { const m = b.subarray(o, o + 4); for (let i = 0; i < payload.length; i++) payload[i] ^= m[i & 3]; }
      this._buf = b.subarray(o + maskLen + len);
      if (op === 8) { this.close(); continue; }                       // close
      if (op === 9) { this._frame(0x0a, payload); continue; }         // ping -> pong
      if (op === 0x0a) continue;                                       // pong
      if (op === 1 || op === 2 || op === 0) {                          // text/binary/continuation
        this._frags.push(payload);
        if (fin) { const whole = Buffer.concat(this._frags); this._frags = []; this.emit('message', whole); }
      }
    }
  }
  _frame(op, payload) {
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | op, len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | op; head[1] = 126; head.writeUInt16BE(len, 2); }
    else { head = Buffer.alloc(10); head[0] = 0x80 | op; head[1] = 127; head.writeBigUInt64BE(BigInt(len), 2); }
    try { this.socket.write(Buffer.concat([head, payload])); } catch (e) {}
  }
  send(data) { if (this.readyState === 1) this._frame(1, Buffer.from(String(data), 'utf8')); }
  ping() { if (this.readyState === 1) this._frame(9, Buffer.alloc(0)); }
  close() { if (this.readyState === 1) { this.readyState = 3; this._frame(8, Buffer.alloc(0)); try { this.socket.end(); } catch (e) {} this.emit('close'); } }
  terminate() { const was = this.readyState; this.readyState = 3; try { this.socket.destroy(); } catch (e) {} if (was !== 3) this.emit('close'); }
}
class MiniWss extends EventEmitter {
  constructor(host, port, ready) {
    super();
    this.clients = new Set();
    this.server = http.createServer((req, res) => { res.writeHead(426); res.end(); });
    this.server.on('upgrade', (req, socket, head) => {
      const key = req.headers['sec-websocket-key'];
      if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') { socket.destroy(); return; }
      const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
      if (head && head.length) socket.unshift(head);   // bytes the HTTP parser read past the handshake ARE the first frame
      const ws = new MiniSocket(socket);
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
      this.emit('connection', ws);
    });
    this.server.on('error', e => this.emit('error', e));
    this.server.listen(port, host, () => ready());
  }
  address() { return this.server.address(); }
  close() { try { this.server.close(); } catch (e) {} for (const c of this.clients) c.terminate(); this.clients.clear(); }
}

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
let deckPath = '';       // the file the cached deck came from; changes when the plugins folder does
let saveTimer = null;
function loadDeck(options) {
  const file = deckFile(options);
  if (deck && deckPath === file) return deck;
  deckPath = file;
  try { deck = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { deck = null; }
  if (!deck || !Array.isArray(deck.profiles) || !deck.profiles.length) deck = defaultDeck();
  if (!deck.contexts) deck.contexts = {};
  if (!deck.globalSettings) deck.globalSettings = {};
  if (!deck.profiles.some(p => p.id === deck.activeProfileId)) deck.activeProfileId = deck.profiles[0].id;
  return deck;
}
// Atomic write (tmp + rename): a crash mid-write must never leave a torn file that silently resets
// the user's whole deck on the next load.
function saveDeck(options) {
  try {
    const f = deckFile(options);
    fs.writeFileSync(f + '.tmp', JSON.stringify(deck, null, 2));
    fs.renameSync(f + '.tmp', f);
  } catch (e) {}
}
// Debounced variant for chatty plugin-driven writes (setSettings per tick would sync-write per tick).
function scheduleSave(options) {
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; saveDeck(options); }, 500);
}
function activeProfile() { return deck.profiles.find(p => p.id === deck.activeProfileId) || deck.profiles[0]; }
// Layout matches the DEVICE form factor: the user picks how many keys HIGH (2 = jumbo, 3 = dense);
// columns are whatever number of square keys fits the page's actual grid area, which the page
// reports with its state polls (w/h in px). That computed size is also what plugins are told the
// "device" is. Until the page reports, fall back to a 1920x480-ish estimate.
function layoutOf(options, wpx, hpx) {
  const rows = String((options && options.rows) || '3') === '2' ? 2 : 3;
  const h = Number(hpx) > 0 ? Number(hpx) : 448;
  const w = Number(wpx) > 0 ? Number(wpx) : 1650;
  const side = Math.max(64, Math.floor((h - (rows - 1) * 8) / rows));
  const columns = Math.max(1, Math.min(16, Math.floor((w - 32 + 8) / (side + 8))));
  return { columns, rows };
}

// ---- plugin discovery -------------------------------------------------------------------------
// A downloaded *.streamDeckPlugin is a plain zip wrapping one <id>.sdPlugin folder — extract any
// found beside the folders so users can drop the file in as-is. Elgato Marketplace packages are
// ENCRYPTED (payloads start with "ELGATO"); those are skipped and surfaced so the status is honest.
const skippedPackages = [];   // [{ file, reason }] for the snapshot
function extractPackages(dir) {
  skippedPackages.length = 0;
  let ents = []; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const ent of ents) {
    if (!ent.isFile() || !/\.streamDeckPlugin$/i.test(ent.name)) continue;
    // Cheap fast path first: don't re-read/parse a (possibly huge) archive on every scan when its
    // conventionally-named .sdPlugin folder already exists.
    const guess = ent.name.replace(/\.streamDeckPlugin$/i, '.sdPlugin');
    if (fs.existsSync(path.join(dir, guess))) continue;
    try {
      const buf = fs.readFileSync(path.join(dir, ent.name));
      const entries = unzipEntries(buf);
      const roots = new Set(entries.map(e => e.name.split('/')[0]).filter(Boolean));
      const root = [...roots].find(r => /\.sdPlugin$/i.test(r));
      if (!root || roots.size !== 1) { skippedPackages.push({ file: ent.name, reason: 'not a plugin package (no single *.sdPlugin root)' }); continue; }
      if (fs.existsSync(path.join(dir, root))) continue;   // already extracted (root differs from the file name)
      const manEntry = entries.find(e => e.name === root + '/manifest.json');
      const manRaw = manEntry ? manEntry.data() : null;
      if (manRaw && manRaw.subarray(0, 6).toString('latin1') === 'ELGATO') {
        skippedPackages.push({ file: ent.name, reason: 'Elgato Marketplace package (encrypted) — only plain open-source packages can run here' });
        continue;
      }
      // Extract via a temp dir + rename: a failed extraction must never leave a half folder that the
      // exists-check above then treats as complete.
      const tmp = path.join(dir, '.oq-extract-' + Date.now());
      try {
        extractZip(buf, tmp);
        fs.renameSync(path.join(tmp, root), path.join(dir, root));
      } finally { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e2) {} }
    } catch (e) { skippedPackages.push({ file: ent.name, reason: 'could not extract: ' + e.message }); }
  }
}
function scanPlugins(dir) {
  const found = [];
  extractPackages(dir);
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
// Resolve the executable this plugin runs. CodePathWin wins on Windows; an extensionless CodePath
// is Elgato's convention for the compiled binary name (append .exe); a .html CodePath needs a
// browser runtime we don't provide (deferred) -> unsupported.
function codePathOf(p) {
  const man = p.manifest;
  const raw = String(man.CodePathWin || man.CodePath || '').trim();
  if (!raw) return null;
  if (/\.html?$/i.test(raw)) return { unsupported: 'HTML plugin (needs a browser runtime)' };
  const base = path.resolve(p.dir);
  // Reverse-DNS CodePaths ("com.barraider.stopwatch") make extname() useless -- always try the
  // literal name first, then the Windows .exe convention.
  for (const cand of [raw, raw + '.exe']) {
    const full = path.resolve(base, cand);
    if (!full.startsWith(base + path.sep)) return null;   // confined to the plugin folder
    try { if (fs.statSync(full).isFile()) return { path: full, node: /\.(js|mjs|cjs)$/i.test(cand) }; } catch (e) {}
  }
  return { unsupported: 'CodePath "' + raw + '" not found in the plugin' };
}

// ---- the WebSocket host -----------------------------------------------------------------------
let wssPromise = null;   // memoized: concurrent startPlugin calls must share ONE server
function ensureWss() {
  if (wssPromise) return wssPromise;
  wssPromise = new Promise((resolve, reject) => {
    const server = new MiniWss('127.0.0.1', 0, () => {
      wss = server; wssPort = server.address().port; resolve(wssPort);
    });
    server.on('error', e => { wssPromise = null; reject(e); });
    server.on('connection', ws => {
      // The first message must be the registration: { event: 'registerPlugin', uuid: <pluginUUID> }.
      const regTimeout = setTimeout(() => { ws.terminate(); }, 10000);   // unknown clients don't get to park sockets
      ws.once('message', raw => {
        clearTimeout(regTimeout);
        let msg; try { msg = JSON.parse(raw.toString('utf8')); } catch (e) { ws.close(); return; }
        const p = [...plugins.values()].find(x => x.uuid === msg.uuid);
        if (!p) { ws.close(); return; }
        p.ws = ws; p.status = 'running';
        // A plugin only earns a backoff reset by staying alive -- resetting on registration lets a
        // register-then-die plugin spawn-loop at 1Hz forever.
        setTimeout(() => { if (p.ws === ws && p.status === 'running') p.restarts = 0; }, 60000);
        ws.on('message', raw2 => { onPluginMessage(p, raw2); });
        ws.on('close', () => {
          clearInterval(hb);
          if (p.ws === ws) { p.ws = null; if (p.status === 'running') p.status = 'stopped'; bump(); }
        });
        // Keepalive: a deadlocked plugin keeps its socket open and would look healthy forever.
        const hb = setInterval(() => {
          if (ws.readyState !== 1) { clearInterval(hb); return; }
          if (Date.now() - ws.lastSeen > 45000) {
            clearInterval(hb);
            if (p.ws === ws) { p.error = 'stopped responding'; }
            ws.terminate();
            return;
          }
          ws.ping();
        }, 15000);
        // Announce the device, then surface every visible key owned by this plugin.
        sendTo(p, { event: 'deviceDidConnect', device: deviceId(), deviceInfo: { name: 'open-quake', type: 0, size: lastLayout } });
        visibleContextsOf(p).forEach(ctx => sendTo(p, appearEvent('willAppear', ctx)));
        bump();
      });
    });
  });
  return wssPromise;
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
  const ctx = m.context;
  // Only live contexts get render state: a plugin with a leaked timer must not recreate state for
  // (and bump long-polls over) keys that were unassigned or belong to another profile's past.
  const ks = (ctx && ctxInfo(ctx)) ? (keyState.get(ctx) || keyState.set(ctx, {}).get(ctx)) : null;
  switch (m.event) {
    case 'setImage': if (ks) {
      // Images are per-STATE: a 2-state toggle pushes both faces up front and flips with setState.
      // No payload.state = applies to all states; empty image = reset that state to the manifest default.
      const img = (m.payload && m.payload.image) || '';
      if (!ks.images) ks.images = [];
      if (m.payload && m.payload.state != null) ks.images[m.payload.state | 0] = img;
      else { ks.images = [img]; ks.imageAll = img; }
      bump();
    } break;
    case 'setTitle': if (ks) { ks.title = (m.payload && typeof m.payload.title === 'string') ? m.payload.title : ''; bump(); } break;
    case 'setState': if (ks) { ks.state = (m.payload && m.payload.state) | 0; bump(); } break;
    case 'showAlert': if (ks) { ks.alert = Date.now(); bump(); } break;
    case 'showOk': if (ks) { ks.ok = Date.now(); bump(); } break;
    case 'setSettings': {
      const c = ctxInfo(ctx); if (!c) break;
      c.settings = (m.payload && typeof m.payload === 'object') ? m.payload : {};
      scheduleSave(lastOptions); sendTo(p, appearEventSettings(ctx)); bump(); break;
    }
    case 'getSettings': { if (ctxInfo(ctx)) sendTo(p, appearEventSettings(ctx)); break; }
    case 'setGlobalSettings': deck.globalSettings[p.id] = (m.payload && typeof m.payload === 'object') ? m.payload : {}; scheduleSave(lastOptions); break;
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
  if (p.proc) return;   // never double-spawn (a pending backoff timer + a manual restart can race here)
  if (p.restartTimer) { clearTimeout(p.restartTimer); p.restartTimer = null; }
  const cp = codePathOf(p);
  if (!cp || cp.unsupported) { p.status = 'unsupported'; p.error = (cp && cp.unsupported) || 'no CodePath'; return; }
  let port;
  try { port = await ensureWss(); }
  catch (e) { p.status = 'crashed'; p.error = e.message; bump(); return; }
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
    if (p.status === 'stopping') {
      p.status = 'stopped'; bump();
      if (p.restartWanted) { p.restartWanted = false; startPlugin(p); }   // the Restart action's stop->start
      return;
    }
    p.status = 'crashed'; bump();
    const delay = RESTART_BACKOFF[Math.min(p.restarts, RESTART_BACKOFF.length - 1)];
    if (p.restarts < RESTART_BACKOFF.length) {
      p.restarts++;
      p.restartTimer = setTimeout(() => { p.restartTimer = null; if (p.status === 'crashed') startPlugin(p); }, delay);
    }
  });
  bump();
}
function stopPlugin(p) {
  p.status = 'stopping';
  if (p.restartTimer) { clearTimeout(p.restartTimer); p.restartTimer = null; }
  try { if (p.ws) p.ws.close(); } catch (e) {}
  try { if (p.proc) p.proc.kill(); } catch (e) {}
}
process.on('exit', () => { for (const p of plugins.values()) { try { if (p.proc) p.proc.kill(); } catch (e) {} } });

async function ensureStarted(options, wpx, hpx) {
  lastOptions = options;
  if (wpx || hpx || !lastLayout.reported) {
    lastLayout = layoutOf(options, wpx, hpx);
    if (wpx) lastLayout.reported = true;   // a real page measurement beats the estimate from then on
  }
  loadDeck(options);   // ALWAYS, even with no folder set -- snapshot() needs a deck on the very first call
  const dir = pluginsDirOf(options);
  // While the folder is set but empty, keep looking -- the user is typically downloading plugins
  // into it right now; each state poll is one cheap readdir.
  if (startedFor === dir && dir && plugins.size === 0) startedFor = '';
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
        .map(a => ({ uuid: a.UUID, name: a.Name || a.UUID, icon: a.Icon || '', states: (a.States || []).length || 1,
          stateImages: (a.States || []).map(s => (s && s.Image) || '') })) });
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
    const state = ks.state || 0;
    // Resolve the face for the CURRENT state: plugin-pushed per-state image, then the plugin's
    // stateless image, then the manifest's per-state default (served via the asset route).
    const image = (ks.images && ks.images[state]) || ks.imageAll || '';
    const iconPath = (actDef && ((actDef.stateImages && actDef.stateImages[state]) || actDef.icon)) || '';
    keys[pos] = { context: ctx, action: c.action, plugin: c.plugin, image, title: ks.title || '',
      state, alert: ks.alert || 0, ok: ks.ok || 0, settings: c.settings || {},
      name: (actDef && actDef.name) || c.action, icon: iconPath };
  });
  return {
    v: version, layout: lastLayout,
    folder: (startedFor && startedFor !== '__shutdown__') ? startedFor : '',
    profiles: deck.profiles.map(pr => ({ id: pr.id, name: pr.name })), activeProfile: deck.activeProfileId,
    keys,
    plugins: [...plugins.values()].map(p => ({ id: p.id, name: p.manifest.Name || p.id, status: p.status, error: p.error || '',
      actions: p.actions, log: p.log.slice(-3) })),
    skipped: skippedPackages.slice(),
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
  await ensureStarted(options, Number(query.w) || 0, Number(query.h) || 0);

  if (action === 'state') {
    const since = Number(query.since) || 0;
    if (since && since >= version) {
      await new Promise(resolve => {
        const w = { resolve, timer: null };
        w.timer = setTimeout(() => { waiters = waiters.filter(x => x !== w); resolve(); }, LONGPOLL_MS);   // self-remove on timeout (idle panels leaked entries)
        waiters.push(w);
      });
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
    const lay = lastLayout;   // the live page-reported layout
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

  if (action === 'move') {   // relocate an assigned key to an empty slot, keeping its context + settings
    const from = ((body && body.fromCol) | 0) + ',' + ((body && body.fromRow) | 0);
    const toCol = (body && body.toCol) | 0, toRow = (body && body.toRow) | 0;
    const to = toCol + ',' + toRow;
    const lay = lastLayout;   // the live page-reported layout
    if (toCol < 0 || toRow < 0 || toCol >= lay.columns || toRow >= lay.rows) return { ok: false, error: 'slot out of range' };
    const prof = activeProfile();
    const ctx = prof.keys[from];
    const c = ctxInfo(ctx);
    if (!c) return { ok: false, error: 'nothing to move' };
    if (prof.keys[to]) return { ok: false, error: 'destination is occupied' };
    const p = plugins.get(c.plugin);
    if (p) sendTo(p, appearEvent('willDisappear', ctx));   // per spec: disappear at the old coordinates...
    delete prof.keys[from];
    c.col = toCol; c.row = toRow;
    prof.keys[to] = ctx;
    if (p) sendTo(p, appearEvent('willAppear', ctx));      // ...appear at the new ones
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

  if (action === 'profile-rename') {
    const id = String((body && body.id) || '');
    const name = String((body && body.name) || '').trim().slice(0, 32);
    const prof = deck.profiles.find(pr => pr.id === id);
    if (!prof) return { ok: false, error: 'unknown profile' };
    if (!name) return { ok: false, error: 'name required' };
    prof.name = name;
    saveDeck(options); bump();
    return { ok: true };
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

  if (action === 'rescan') {   // re-read the plugins folder (new drops / removals) without changing options
    startedFor = '';
    await ensureStarted(options);
    return Object.assign({ ok: true }, snapshot());
  }

  if (action === 'restart') {
    const p = plugins.get(String((body && body.plugin) || query.plugin || ''));
    if (!p) return { ok: false, error: 'unknown plugin' };
    p.restarts = 0; p.error = '';
    if (p.proc) { p.restartWanted = true; stopPlugin(p); }   // start again after this exit lands
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
  for (const p of plugins.values()) { p.restartWanted = false; stopPlugin(p); }
  plugins.clear();
  startedFor = '__shutdown__';
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; if (deck) saveDeck(lastOptions); }   // flush a pending debounced save
  const w = waiters; waiters = [];
  w.forEach(x => { clearTimeout(x.timer); try { x.resolve(); } catch (e) {} });
  if (wss) { try { wss.close(); for (const c of wss.clients) { try { c.terminate(); } catch (e) {} } } catch (e) {} wss = null; wssPort = 0; }
  wssPromise = null;
}

module.exports = { handle, _shutdown };

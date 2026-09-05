'use strict';

// Host-side bridge for the Unraid Manager drop-in.
// The panel page calls /app-api/<action>; this module does the actual cross-origin
// GraphQL calls to each Unraid server (Node-side, so no browser CORS) with the
// x-api-key kept server-side. Contract: exports.handle(action, { options, query }).

const REQUEST_TIMEOUT_MS = 9000;
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const SLOTS = [1, 2, 3, 4];

// ── option / url helpers (mirrors arr-dash / pihole-dash) ─────────────────────
function optionString(options, key) {
  const value = options && options[key];
  return value == null ? '' : String(value).trim();
}

function optionBool(options, key, dflt) {
  const value = options && options[key];
  if (value == null || value === '') return dflt;
  return value === true || value === 'true' || value === '1' || value === 1;
}

function slotConfig(options, n) {
  const raw = optionString(options, 'server' + n + 'Url').replace(/\/+$/, '');
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('URL must use http or https');
  return {
    slot: n,
    base: url.origin + url.pathname.replace(/\/+$/, ''),
    key: optionString(options, 'server' + n + 'Key'),
    name: optionString(options, 'server' + n + 'Name') || 'Unraid ' + n,
    verifySsl: optionBool(options, 'verifySsl', true),
    stats: optionString(options, 'server' + n + 'Stats').replace(/\/+$/, ''),
  };
}

function safeError(error) {
  return String((error && error.message) || error || 'request failed')
    .replace(/(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/ig, '$1<credentials>@')
    .replace(/(x-api-key|apikey|api_key|password|token)[=:]\s*([^&\s"]+)/ig, '$1=<hidden>');
}

// Self-signed HTTPS: build one insecure undici dispatcher, reused. http:// never needs it.
let insecureDispatcher = null;
function dispatcherFor(cfg) {
  if (cfg.verifySsl || !cfg.base.startsWith('https:')) return undefined;
  if (insecureDispatcher === null) {
    try {
      const { Agent } = require('undici');
      insecureDispatcher = new Agent({ connect: { rejectUnauthorized: false } });
    } catch (error) { insecureDispatcher = false; }
  }
  return insecureDispatcher || undefined;
}

async function graphql(cfg, queryText, variables) {
  if (!cfg.key) throw new Error('API key not set — add it in the app options');
  let response;
  const init = {
    method: 'POST',
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    headers: { 'Content-Type': 'application/json', 'x-api-key': cfg.key, Accept: 'application/json' },
    body: JSON.stringify({ query: queryText, variables: variables || {} }),
  };
  const dispatcher = dispatcherFor(cfg);
  if (dispatcher) init.dispatcher = dispatcher;
  try {
    response = await fetch(cfg.base + '/graphql', init);
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new Error('request timed out');
    throw error;
  }
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error('response too large');
  if (response.status === 401 || response.status === 403) throw new Error('unauthorized — check the API key and its role');
  if (response.status === 404) throw new Error('no GraphQL API at this URL — Unraid 7.2+ required');
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch (error) { throw new Error('non-JSON response (is this the Unraid webGUI URL?)'); }
  if (body.errors && body.errors.length) throw new Error((body.errors[0] && body.errors[0].message) || 'GraphQL error');
  if (response.status < 200 || response.status >= 300) throw new Error('HTTP ' + response.status);
  return body.data || {};
}

// isolated query: never lets one server-version field mismatch blank a whole panel
async function tryQuery(cfg, queryText) {
  try { return await graphql(cfg, queryText); } catch (error) { return null; }
}

// Optional stats-api add-on (github.com/TeeJS/stats): plain GET JSON, no auth.
// Supplies GPU + per-container CPU/mem/VRAM the Unraid GraphQL API does not expose.
// The stats-api '/' endpoint computes per-container docker stats for every
// container, which on a big box takes far longer than a normal request. So we
// never block the summary on it: refresh it in the background with a long
// timeout and serve the last cached result. GPU/per-container numbers lag by a
// cycle, which is fine for monitoring.
const STATS_TIMEOUT_MS = 45000;  // the '/' endpoint is expensive on big boxes; give it room
const STATS_TTL_MS = 25000;      // refresh at most this often (don't hammer it)
const STATS_STALE_MS = 180000;   // keep serving last-good data for up to 3 min through failures
const statsData = {};     // slot -> { data, at }  — successful reads ONLY
const statsErr = {};      // slot -> last error string — never clobbers statsData
const statsInflight = {}; // slot -> bool

function refreshStats(cfg) {
  const slot = cfg.slot;
  if (statsInflight[slot]) return;
  statsInflight[slot] = true;
  (async () => {
    try {
      const init = { method: 'GET', signal: AbortSignal.timeout(STATS_TIMEOUT_MS), headers: { Accept: 'application/json' } };
      const dispatcher = dispatcherFor(cfg);
      if (dispatcher) init.dispatcher = dispatcher;
      const response = await fetch(cfg.stats + '/', init);
      const text = await response.text();
      if (!response.ok) { statsErr[slot] = 'HTTP ' + response.status; return; }
      if (text.length > MAX_RESPONSE_BYTES) { statsErr[slot] = 'response too large'; return; }
      statsData[slot] = { data: text ? JSON.parse(text) : null, at: Date.now() };
      statsErr[slot] = null;
    } catch (error) {
      statsErr[slot] = safeError(error);   // KEEP last-good data; a slow/failed poll must not wipe the display
    } finally { statsInflight[slot] = false; }
  })();
}

// Non-blocking: serve last-good stats and refresh in the background. A failed refresh
// never clears a good reading (that caused the flicker) — last-good persists up to STATS_STALE_MS.
function fetchStats(cfg) {
  if (!cfg.stats) return { error: 'no URL set' };
  if (!/^https?:\/\//i.test(cfg.stats)) return { error: 'URL must start with http:// or https://' };
  const slot = cfg.slot;
  const good = statsData[slot];
  const fresh = good && Date.now() - good.at < STATS_TTL_MS;
  if (!statsInflight[slot] && !fresh) refreshStats(cfg);
  if (good && Date.now() - good.at < STATS_STALE_MS) return { data: good.data };
  return { error: statsErr[slot] || 'loading (first read can take ~15-30s on a big box)' };
}

function normStatsGpu(g) {
  if (!g) return null;
  return {
    util: g.utilization_percent != null ? num(g.utilization_percent) : null,
    memUsed: g.memory_used_mb != null ? num(g.memory_used_mb) : null,
    memTotal: g.memory_total_mb != null ? num(g.memory_total_mb) : null,
    temp: g.temperature_c != null ? num(g.temperature_c) : null,
  };
}

// Merge stats-api per-container numbers onto the GraphQL container rows by name.
function mergeContainerStats(containers, statsContainers) {
  if (!Array.isArray(containers) || !Array.isArray(statsContainers)) return;
  const byName = new Map();
  for (const s of statsContainers) if (s && s.name) byName.set(s.name, s);
  for (const c of containers) {
    const s = byName.get(c.name);
    if (!s) continue;
    if (s.cpu_percent != null) c.cpu = num(s.cpu_percent);
    if (s.memory_mb != null) c.mem = num(s.memory_mb);
    if (s.memory_limit_mb != null) c.memLimit = num(s.memory_limit_mb);
    if (s.gpu_memory_mb != null) c.gpuMem = num(s.gpu_memory_mb);
  }
}

// ── GraphQL documents (best-confirmed against unraid/api; see README to verify) ─
const Q_DOCKER = '{ docker { containers { id names image state status autoStart ports { ip privatePort publicPort } } } }';
// Update flags kept in their own isolated query so a missing field can never break the list.
const Q_DOCKER_UPD = '{ docker { containers { id isUpdateAvailable isRebuildReady } } }';
const Q_SYSTEM = '{ info { os { hostname uptime } versions { core { unraid } } } metrics { cpu { percentTotal } memory { total used percentTotal } } }';
const Q_ARRAY = '{ array { state capacity { kilobytes { free used total } } disks { name temp status fsSize fsFree } parityCheckStatus { status progress running errors } } }';
const Q_NOTIF = '{ notifications { overview { unread { total } } list(filter: { type: UNREAD, offset: 0, limit: 8 }) { id title subject importance timestamp } } }';
const Q_UPS = '{ upsDevices { name model status battery { chargeLevel estimatedRuntime } power { loadPercentage nominalPower } } }';
const Q_NET = '{ metrics { network { name rxSec txSec utilizationPercent } } }';
const Q_VMS = '{ vms { domains { id name state } } }';

// ── normalizers (KB → bytes; tolerate missing fields) ─────────────────────────
const KB = 1024;
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : 0; }
function firstName(names) { const raw = Array.isArray(names) ? names[0] : names; return String(raw || '').replace(/^\//, ''); }

function normDocker(data) {
  const list = (data && data.docker && data.docker.containers) || [];
  const containers = list.map(c => ({
    id: c.id,
    name: firstName(c.names),
    image: c.image || '',
    state: String(c.state || '').toLowerCase(),   // running | paused | exited
    status: c.status || '',                        // "Up 3 days" / "Exited (0) 2h ago"
    autoStart: !!c.autoStart,
    ports: (c.ports || []).map(p => ({ ip: p.ip || '', priv: p.privatePort, pub: p.publicPort })),
  }));
  let running = 0, paused = 0, stopped = 0;
  for (const c of containers) {
    if (c.state === 'running') running++;
    else if (c.state === 'paused') paused++;
    else stopped++;
  }
  return { containers, counts: { running, paused, stopped, total: containers.length } };
}

// Merge the isolated update-status query onto the container rows by id.
function mergeDockerUpdates(containers, data) {
  const list = data && data.docker && data.docker.containers;
  if (!Array.isArray(containers) || !Array.isArray(list)) return;
  const byId = new Map();
  for (const u of list) if (u && u.id) byId.set(u.id, !!(u.isUpdateAvailable || u.isRebuildReady));
  for (const c of containers) if (byId.has(c.id)) c.updateAvailable = byId.get(c.id);
}

function normSystem(data) {
  if (!data || !data.info) return null;
  const info = data.info, metrics = data.metrics || {};
  return {
    hostname: (info.os && info.os.hostname) || '',
    uptime: (info.os && info.os.uptime) || '',
    unraid: (info.versions && info.versions.core && info.versions.core.unraid) || '',
    cpuPct: metrics.cpu ? Math.round(num(metrics.cpu.percentTotal)) : null,
    memUsed: metrics.memory ? num(metrics.memory.used) : null,
    memTotal: metrics.memory ? num(metrics.memory.total) : null,
    memPct: metrics.memory ? Math.round(num(metrics.memory.percentTotal)) : null,
  };
}

function normArray(data) {
  const a = data && data.array;
  if (!a) return null;
  const cap = (a.capacity && a.capacity.kilobytes) || {};
  const parity = a.parityCheckStatus || {};
  return {
    state: a.state || 'UNKNOWN',
    used: num(cap.used) * KB,
    free: num(cap.free) * KB,
    total: num(cap.total) * KB,
    parity: {
      status: parity.status || null,
      progress: parity.progress != null ? num(parity.progress) : null,
      running: !!parity.running,
      errors: num(parity.errors),
    },
    disks: (a.disks || []).map(d => ({
      name: d.name,
      temp: d.temp != null ? num(d.temp) : null,
      status: d.status || '',
      size: num(d.fsSize) * KB,
      free: num(d.fsFree) * KB,
    })),
  };
}

function normNotif(data) {
  const n = data && data.notifications;
  if (!n) return null;
  const unread = (n.overview && n.overview.unread) || {};
  return {
    unread: { info: num(unread.info), warning: num(unread.warning), alert: num(unread.alert), total: num(unread.total) },
    list: (n.list || []).map(x => ({
      id: x.id, title: x.title || '', subject: x.subject || '',
      importance: String(x.importance || '').toLowerCase(), timestamp: x.timestamp || '',
    })),
  };
}

function normUps(data) {
  const devices = (data && data.upsDevices) || [];
  if (!devices.length) return null;
  const d = devices[0];
  const battery = d.battery || {}, power = d.power || {};
  return {
    name: d.name || d.model || 'UPS',
    model: d.model || '',
    status: d.status || '',
    charge: battery.chargeLevel != null ? Math.round(num(battery.chargeLevel)) : null,
    runtime: battery.estimatedRuntime != null ? num(battery.estimatedRuntime) : null, // seconds
    loadPct: power.loadPercentage != null ? Math.round(num(power.loadPercentage)) : null,
    nominalPower: power.nominalPower != null ? num(power.nominalPower) : null,
  };
}

function normVms(data) {
  const domains = data && data.vms && data.vms.domains;
  if (!domains) return null;
  return domains.map(v => ({ id: v.id, name: v.name || '', state: String(v.state || '').toLowerCase() }));
}

// Pick the busiest non-loopback interface (avoids double-counting a bond + its slave).
function normNet(data) {
  const list = data && data.metrics && data.metrics.network;
  if (!Array.isArray(list)) return null;
  let best = null;
  for (const n of list) {
    if (!n || n.name === 'lo') continue;
    const rx = num(n.rxSec), tx = num(n.txSec);
    if (!best || rx + tx > best.rxSec + best.txSec) {
      best = { rxSec: rx, txSec: tx, util: (n.utilizationPercent != null ? num(n.utilizationPercent) : null), iface: n.name };
    }
  }
  return best || { rxSec: 0, txSec: 0, util: null, iface: '' };
}

// ── per-server fetch ──────────────────────────────────────────────────────────
async function fetchServer(cfg, full) {
  const dockerData = await graphql(cfg, Q_DOCKER); // critical: let its error mark the server down
  const docker = normDocker(dockerData);

  const [sys, arr] = await Promise.all([tryQuery(cfg, Q_SYSTEM), tryQuery(cfg, Q_ARRAY)]);
  const out = {
    slot: cfg.slot, configured: true, up: true, name: cfg.name,
    system: normSystem(sys),
    array: normArray(arr),
    counts: docker.counts,
  };

  if (full) {
    const [notif, ups, vms, updData, netData, statsRes] = await Promise.all([tryQuery(cfg, Q_NOTIF), tryQuery(cfg, Q_UPS), tryQuery(cfg, Q_VMS), tryQuery(cfg, Q_DOCKER_UPD), tryQuery(cfg, Q_NET), fetchStats(cfg)]);
    out.containers = docker.containers;
    out.notifications = normNotif(notif);
    out.ups = normUps(ups);
    out.vms = normVms(vms);
    out.net = normNet(netData);
    mergeDockerUpdates(out.containers, updData);
    out.counts = Object.assign({}, docker.counts, { updates: out.containers.filter(c => c.updateAvailable).length });
    // GPU + per-container cpu/mem/vram come only from the optional stats-api add-on.
    const stats = statsRes && statsRes.data;
    out.gpu = stats ? normStatsGpu(stats.gpu) : null;
    out.statsConfigured = !!cfg.stats;
    out.statsError = (statsRes && statsRes.error) || null;
    if (stats) mergeContainerStats(out.containers, stats.containers);
  }
  return out;
}

async function summary(options, query) {
  const configs = SLOTS.map(n => {
    try { return slotConfig(options, n); }
    catch (error) { return { slot: n, error: safeError(error), name: 'Server ' + n }; }
  });

  const firstConfigured = configs.find(c => c && c.base);
  let active = parseInt(query.active, 10);
  if (!SLOTS.includes(active) || !configs.some(c => c && c.base && c.slot === active)) {
    active = firstConfigured ? firstConfigured.slot : 0;
  }

  const servers = await Promise.all(configs.map(async cfg => {
    if (!cfg) return { slot: 0, configured: false };
    if (cfg.error) return { slot: cfg.slot, configured: true, up: false, name: cfg.name, error: cfg.error };
    if (!cfg.base) return { slot: cfg.slot, configured: false };
    try { return await fetchServer(cfg, cfg.slot === active); }
    catch (error) { return { slot: cfg.slot, configured: true, up: false, name: cfg.name, error: safeError(error) }; }
  }));

  return { ok: true, active, servers: servers.filter(s => s.configured) };
}

// ── mutations ─────────────────────────────────────────────────────────────────
function requireControls(options) {
  if (!optionBool(options, 'allowControls', true)) throw new Error('controls are disabled in the app options');
}

function cfgOrThrow(options, slot) {
  if (!SLOTS.includes(slot)) throw new Error('unknown server');
  const cfg = slotConfig(options, slot);
  if (!cfg) throw new Error('server not configured');
  return cfg;
}

const DOCKER_OPS = { start: 'start', stop: 'stop', pause: 'pause', unpause: 'unpause', update: 'updateContainer' };

async function dockerAction(options, query) {
  requireControls(options);
  const cfg = cfgOrThrow(options, parseInt(query.server, 10));
  const id = String(query.id || '');
  if (!id) throw new Error('missing container id');
  const op = String(query.op || '');

  if (op === 'restart') {
    await graphql(cfg, 'mutation { docker { stop(id: ' + JSON.stringify(id) + ') { id state } } }');
    await graphql(cfg, 'mutation { docker { start(id: ' + JSON.stringify(id) + ') { id state } } }');
    return { ok: true };
  }
  const field = DOCKER_OPS[op];
  if (!field) throw new Error('unknown op');
  const sel = op === 'update' ? '{ id }' : '{ id state }';
  await graphql(cfg, 'mutation { docker { ' + field + '(id: ' + JSON.stringify(id) + ') ' + sel + ' } }');
  return { ok: true };
}

async function dockerUpdateAll(options, query) {
  requireControls(options);
  const cfg = cfgOrThrow(options, parseInt(query.server, 10));
  await graphql(cfg, 'mutation { docker { updateAllContainers { id } } }');
  return { ok: true };
}

// Re-check registries for new image digests (Unraid's "Check for Updates").
async function dockerCheckUpdates(options, query) {
  const cfg = cfgOrThrow(options, parseInt(query.server, 10));
  await graphql(cfg, 'mutation { docker { refreshDockerDigests } }');
  return { ok: true };
}

const VM_OPS = { start: 'start', stop: 'stop', pause: 'pause', resume: 'resume' };
async function vmAction(options, query) {
  requireControls(options);
  const cfg = cfgOrThrow(options, parseInt(query.server, 10));
  const id = String(query.id || '');
  const field = VM_OPS[String(query.op || '')];
  if (!id || !field) throw new Error('unknown op');
  await graphql(cfg, 'mutation { vm { ' + field + '(id: ' + JSON.stringify(id) + ') } }');
  return { ok: true };
}

const PARITY_OPS = { start: 'start(correct: false)', pause: 'pause', resume: 'resume', cancel: 'cancel' };
async function parityAction(options, query) {
  requireControls(options);
  const cfg = cfgOrThrow(options, parseInt(query.server, 10));
  const op = PARITY_OPS[String(query.op || '')];
  if (!op) throw new Error('unknown op');
  await graphql(cfg, 'mutation { parityCheck { ' + op + ' } }');
  return { ok: true };
}

function openWebUi(options, query) {
  const cfg = cfgOrThrow(options, parseInt(query.server, 10));
  const shell = require('electron').shell;
  if (!shell || typeof shell.openExternal !== 'function') throw new Error('opening a browser is only available on the panel');
  // Logs open in the browser via the stats-api add-on (Unraid's own log view is an
  // on-demand ttyd session that can't be deep-linked). Falls back to the Docker page.
  const log = String(query.log || '');
  let url;
  if (log) {
    if (!cfg.stats) throw new Error('logs need the stats-api URL set in this server\'s options');
    url = cfg.stats + '/logs?container=' + encodeURIComponent(log);
  } else {
    url = cfg.base + '/Docker';
  }
  shell.openExternal(url);
  return { ok: true };
}

async function handle(action, context) {
  const options = (context && context.options) || {};
  const query = (context && context.query) || {};
  try {
    if (action === 'summary') return await summary(options, query);
    if (action === 'container') return await dockerAction(options, query);
    if (action === 'updateAll') return await dockerUpdateAll(options, query);
    if (action === 'checkUpdates') return await dockerCheckUpdates(options, query);
    if (action === 'vm') return await vmAction(options, query);
    if (action === 'parity') return await parityAction(options, query);
    if (action === 'open') return openWebUi(options, query);
    return { ok: false, error: 'unknown action' };
  } catch (error) {
    return { ok: false, error: safeError(error) };
  }
}

module.exports = { handle };

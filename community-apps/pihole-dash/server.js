'use strict';

const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const SLOTS = [1, 2, 3, 4];

// Per-slot session cache: { sid: string|null } — sid null means "no password set" mode.
const sessions = {};
// Per-slot login coordination: single-flight promise + failure backoff, so a dead
// password can't hammer Pi-hole (it rate-limits) or leak its 16 session seats.
const loginState = {};
const LOGIN_BACKOFF_MS = 60000;

function optionString(options, key) {
  const value = options && options[key];
  return value == null ? '' : String(value).trim();
}

function slotConfig(options, n) {
  const raw = optionString(options, 'server' + n + 'Url').replace(/\/+$/, '');
  if (!raw) return null;
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('URL must use http or https');
  return {
    base: url.origin + url.pathname.replace(/\/+$/, ''),
    pass: optionString(options, 'server' + n + 'Pass'),
    name: optionString(options, 'server' + n + 'Name') || 'Pi-hole ' + n,
  };
}

function safeError(error) {
  return String(error && error.message || error || 'request failed')
    .replace(/(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/ig, '$1<credentials>@')
    .replace(/(password|sid|token)=([^&\s]+)/ig, '$1=<hidden>');
}

async function rawFetch(url, init) {
  let response;
  try {
    response = await fetch(url, Object.assign({
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    }, init || {}));
  } catch (error) {
    if (error && (error.name === 'TimeoutError' || error.name === 'AbortError')) throw new Error('request timed out');
    throw error;
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) throw new Error('response too large');
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error('response too large');
  let json = null;
  try { json = text ? JSON.parse(text) : {}; } catch (error) {}
  return { status: response.status, json };
}

async function login(n, cfg) {
  const { status, json } = await rawFetch(cfg.base + '/api/auth', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: cfg.pass }),
  });
  if (status === 404) throw new Error('Pi-hole v5 detected — this app needs Pi-hole v6');
  if (status === 429 || (json && json.error && json.error.key === 'no_seats')) {
    throw new Error('Pi-hole API session limit reached — seats free up within 30 min (or restart FTL)');
  }
  const session = json && json.session;
  if (!session || session.valid !== true) throw new Error('login failed — check the password');
  sessions[n] = { sid: session.sid || null };
  return sessions[n];
}

// Single-flight login with backoff: concurrent callers share one attempt, and a
// failed password is not retried for LOGIN_BACKOFF_MS.
function ensureSession(n, cfg) {
  if (sessions[n]) return Promise.resolve(sessions[n]);
  if (!cfg.pass) { sessions[n] = { sid: null }; return Promise.resolve(sessions[n]); }
  const state = loginState[n] || (loginState[n] = {});
  if (state.failedAt && Date.now() - state.failedAt < LOGIN_BACKOFF_MS) {
    return Promise.reject(new Error(state.lastError || 'login failed — retrying shortly'));
  }
  if (!state.promise) {
    state.promise = login(n, cfg)
      .then(session => { state.failedAt = 0; return session; })
      .catch(error => { state.failedAt = Date.now(); state.lastError = safeError(error); throw error; })
      .finally(() => { state.promise = null; });
  }
  return state.promise;
}

// Authenticated GET/POST against one Pi-hole; re-logins once on 401.
async function api(n, cfg, path, init, isRetry) {
  await ensureSession(n, cfg);
  const headers = Object.assign({ Accept: 'application/json' }, init && init.headers || {});
  if (sessions[n].sid) headers['X-FTL-SID'] = sessions[n].sid;
  const { status, json } = await rawFetch(cfg.base + '/api' + path, Object.assign({}, init, { headers }));
  if (status === 401) {
    if (!cfg.pass) throw new Error('password required — set it in the app options');
    if (isRetry) throw new Error('authentication failed');
    sessions[n] = null;
    return api(n, cfg, path, init, true);
  }
  if (status === 404 && path === '/padd?full=true') throw new Error('Pi-hole v5 detected — this app needs Pi-hole v6');
  if (status < 200 || status >= 300) throw new Error('HTTP ' + status);
  if (json == null) throw new Error('non-JSON response');
  return json;
}

function updateAvailable(version) {
  const v = version && version.version;
  if (!v) return false;
  for (const part of ['core', 'web', 'ftl']) {
    const p = v[part];
    if (p && p.local && p.remote && p.local.version && p.remote.version && p.local.version !== p.remote.version) return true;
  }
  return false;
}

async function fetchServer(n, cfg, wantDetail) {
  const [padd, blocking] = await Promise.all([
    api(n, cfg, '/padd?full=true'),
    api(n, cfg, '/dns/blocking'),
  ]);

  const out = {
    slot: n,
    configured: true,
    up: true,
    name: cfg.name,
    blocking: blocking.blocking || 'unknown',
    timer: typeof blocking.timer === 'number' ? blocking.timer : null,
    stats: {
      total: padd.queries && padd.queries.total || 0,
      blocked: padd.queries && padd.queries.blocked || 0,
      percent: padd.queries && padd.queries.percent_blocked || 0,
      qps: padd.queries && padd.queries.query_frequency || 0,
      clients: padd.active_clients || 0,
      gravity: padd.gravity_size || 0,
    },
    updateAvailable: updateAvailable(padd),
    version: padd.version && padd.version.core && padd.version.core.local && padd.version.core.local.version || '',
  };

  if (wantDetail) {
    const [history, topBlocked, topClients, summary] = await Promise.all([
      api(n, cfg, '/history').catch(() => null),
      api(n, cfg, '/stats/top_domains?blocked=true&count=5').catch(() => null),
      api(n, cfg, '/stats/top_clients?count=5').catch(() => null),
      api(n, cfg, '/stats/summary').catch(() => null),
    ]);
    out.detail = {
      history: ((history && history.history) || []).map(h => ({ ts: h.timestamp, total: h.total || 0, blocked: h.blocked || 0 })),
      topBlocked: ((topBlocked && topBlocked.domains) || []).map(d => ({ name: d.domain, count: d.count })),
      topClients: ((topClients && topClients.clients) || []).map(c => ({ name: c.name || c.ip, count: c.count })),
      gravityUpdated: summary && summary.gravity && summary.gravity.last_update || 0,
    };
  }
  return out;
}

async function summary(options, query) {
  let active = parseInt(query.active, 10);
  if (!SLOTS.includes(active)) {
    active = SLOTS.find(n => { try { return !!slotConfig(options, n); } catch (error) { return true; } }) || 0;
  }
  const servers = await Promise.all(SLOTS.map(async n => {
    let cfg;
    try {
      cfg = slotConfig(options, n);
    } catch (error) {
      return { slot: n, configured: true, up: false, name: 'Server ' + n, error: safeError(error) };
    }
    if (!cfg) return { slot: n, configured: false };
    try {
      return await fetchServer(n, cfg, n === active);
    } catch (error) {
      // keep any cached session — only a real 401 (handled in api()) invalidates it
      return { slot: n, configured: true, up: false, name: cfg.name, error: safeError(error) };
    }
  }));
  return { ok: true, servers };
}

async function setBlocking(options, query) {
  const n = parseInt(query.server, 10);
  if (!SLOTS.includes(n)) throw new Error('unknown server');
  const cfg = slotConfig(options, n);
  if (!cfg) throw new Error('server not configured');
  const enable = query.enable === '1';
  const timer = query.timer ? Math.max(1, parseInt(query.timer, 10)) : null;
  const result = await api(n, cfg, '/dns/blocking', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ blocking: enable, timer }),
  });
  return { ok: true, blocking: result.blocking || 'unknown', timer: typeof result.timer === 'number' ? result.timer : null };
}

function openWebUi(options, query) {
  const n = parseInt(query.server, 10);
  if (!SLOTS.includes(n)) throw new Error('unknown server');
  const cfg = slotConfig(options, n);
  if (!cfg) throw new Error('server not configured');
  const shell = require('electron').shell;
  if (!shell || typeof shell.openExternal !== 'function') throw new Error('opening a browser is only available on the panel');
  shell.openExternal(cfg.base + '/admin/');
  return { ok: true };
}

async function handle(action, context) {
  const options = context && context.options || {};
  const query = context && context.query || {};
  try {
    if (action === 'summary') return await summary(options, query);
    if (action === 'blocking') return await setBlocking(options, query);
    if (action === 'open') return openWebUi(options, query);
    return { ok: false, error: 'unknown action' };
  } catch (error) {
    return { ok: false, error: safeError(error) };
  }
}

module.exports = { handle };

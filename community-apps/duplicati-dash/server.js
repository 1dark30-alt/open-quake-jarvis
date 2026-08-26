'use strict';

const REQUEST_TIMEOUT_MS = 8000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

// JWT access tokens last 15 min; cache one and re-login on 401.
let accessToken = null;
// Duplicati rejects non-localhost Host values unless --webservice-allowed-hostnames is set;
// on a 403 we retry once with Host: localhost and remember that it was needed.
let useHostOverride = false;

function optionString(options, key) {
  const value = options && options[key];
  return value == null ? '' : String(value).trim();
}

function baseUrl(options) {
  const value = optionString(options, 'duplicatiUrl').replace(/\/+$/, '');
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('URL must use http or https');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function safeError(error) {
  return String(error && error.message || error || 'request failed')
    .replace(/(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/ig, '$1<credentials>@')
    .replace(/(password|token)=([^&\s]+)/ig, '$1=<hidden>')
    .replace(/Bearer\s+\S+/ig, 'Bearer <hidden>')
    .replace(/PreAuth\s+\S+/ig, 'PreAuth <hidden>');
}

async function fetchJson(url, init) {
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
  if (!response.ok) throw new Error('HTTP ' + response.status);
  try { return text ? JSON.parse(text) : {}; } catch (error) { throw new Error('non-JSON response'); }
}

async function login(base, password) {
  const data = await fetchJson(base + '/api/v1/auth/login', {
    method: 'POST',
    headers: authAwareHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({ Password: password }),
  });
  if (!data.AccessToken) throw new Error('Duplicati login failed');
  accessToken = data.AccessToken;
  return accessToken;
}

function authAwareHeaders(headers) {
  const out = Object.assign({ Accept: 'application/json' }, headers || {});
  if (useHostOverride) out.Host = 'localhost';
  return out;
}

async function api(base, options, path) {
  const preAuth = optionString(options, 'preAuthToken');
  const password = optionString(options, 'password');

  const doFetch = async () => {
    const headers = authAwareHeaders();
    if (preAuth) headers.Authorization = 'PreAuth ' + preAuth;
    else {
      if (!accessToken) await login(base, password);
      headers.Authorization = 'Bearer ' + accessToken;
    }
    return fetchJson(base + '/api/v1/' + path, { headers });
  };

  try {
    return await doFetch();
  } catch (error) {
    const message = String(error.message || '');
    if (!preAuth && /HTTP 401/.test(message)) {
      accessToken = null;               // token expired — re-login once
      return doFetch();
    }
    if (/HTTP 403/.test(message) && !useHostOverride) {
      useHostOverride = true;           // hostname allowlist — retry with Host: localhost
      try { return await doFetch(); } catch (retryError) { useHostOverride = false; throw retryError; }
    }
    throw error;
  }
}

// Metadata timestamps are "yyyyMMdd'T'HHmmssZ" — not ISO; Schedule fields ARE ISO.
function parseDupTime(value) {
  if (!value) return null;
  const m = /^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z?$/.exec(value);
  if (m) return new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])).toISOString();
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const SEVERITY = { error: 0, warning: 1, ok: 2, never: 3 };

function backupStatus(meta, notificationTypes) {
  if (notificationTypes.includes('Error')) return 'error';
  if (notificationTypes.includes('Warning')) return 'warning';
  const lastBackup = parseDupTime(meta.LastBackupDate || meta.LastBackupFinished);
  const lastError = parseDupTime(meta.LastErrorDate);
  if (lastError && meta.LastErrorMessage && (!lastBackup || lastError > lastBackup)) return 'error';
  if (!lastBackup) return 'never';
  return 'ok';
}

async function summary(options) {
  const base = baseUrl(options);
  if (!base) return { ok: true, configured: false };

  const [backups, notifications, serverState] = await Promise.all([
    api(base, options, 'backups'),
    api(base, options, 'notifications').catch(() => []),
    api(base, options, 'serverstate'),
  ]);

  const activeBackupId = serverState.ActiveTask ? String(serverState.ActiveTask.Item2) : null;
  let progress = null;
  if (activeBackupId) {
    progress = await api(base, options, 'progressstate').catch(() => null);
  }

  const notes = Array.isArray(notifications) ? notifications : [];
  const nameById = {};

  const jobs = (Array.isArray(backups) ? backups : []).map(entry => {
    const backup = entry.Backup || {};
    const meta = backup.Metadata || {};
    const schedule = entry.Schedule || null;
    const id = String(backup.ID);
    nameById[id] = backup.Name;
    const types = notes.filter(n => String(n.BackupID) === id).map(n => n.Type);
    const status = backupStatus(meta, types);
    return {
      id,
      name: backup.Name || 'Backup ' + id,
      status,
      lastRun: parseDupTime(meta.LastBackupFinished || meta.LastBackupDate),
      duration: meta.LastBackupDuration || null,
      sourceSize: meta.SourceSizeString || null,
      targetSize: meta.TargetSizeString || null,
      versions: parseInt(meta.BackupListCount, 10) || 0,
      nextRun: schedule && schedule.Time ? schedule.Time : null,
      lastError: status === 'error' ? (meta.LastErrorMessage || '') : '',
      warningCount: types.filter(t => t === 'Warning').length,
    };
  });
  jobs.sort((a, b) => (SEVERITY[a.status] - SEVERITY[b.status]) || a.name.localeCompare(b.name));

  return {
    ok: true,
    configured: true,
    state: {
      paused: serverState.ProgramState === 'Paused',
      activeBackupId,
      activeName: activeBackupId ? (nameById[activeBackupId] || 'backup') : null,
      phase: progress ? progress.Phase : null,
      progress: progress && typeof progress.OverallProgress === 'number' ? Math.round(progress.OverallProgress * 100) : null,
      speed: progress && progress.BackendSpeed > 0 ? progress.BackendSpeed : null,
    },
    backups: jobs,
    notifications: notes.slice(0, 4).map(n => ({
      type: n.Type,
      backup: nameById[String(n.BackupID)] || n.Title || '',
      message: n.Message || n.Title || '',
    })),
  };
}

const OPEN_GUARD = 'opening a browser is only available on the panel';

async function handle(action, context) {
  const options = context && context.options || {};
  try {
    if (action === 'summary') return await summary(options);
    if (action === 'open') {
      const base = baseUrl(options);
      if (!base) throw new Error('Duplicati is not configured');
      const shell = require('electron').shell;
      if (!shell || typeof shell.openExternal !== 'function') throw new Error(OPEN_GUARD);
      shell.openExternal(base);
      return { ok: true };
    }
    return { ok: false, error: 'unknown action' };
  } catch (error) {
    return { ok: false, error: safeError(error) };
  }
}

module.exports = { handle };

'use strict';

const REQUEST_TIMEOUT_MS = 8000;
const PING_TIMEOUT_MS = 5000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

// Youtarr session token cache (7-day tokens; re-login on 401).
let youtarrToken = null;

function optionString(options, key) {
  const value = options && options[key];
  return value == null ? '' : String(value).trim();
}

function baseUrl(options, key) {
  const value = optionString(options, key).replace(/\/+$/, '');
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('URL must use http or https');
  return url.origin + url.pathname.replace(/\/+$/, '');
}

function safeError(error) {
  return String(error && error.message || error || 'request failed')
    .replace(/(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/ig, '$1<credentials>@')
    .replace(/(apikey|api_key|password|token)=([^&\s]+)/ig, '$1=<hidden>');
}

async function fetchJson(url, init, timeoutMs) {
  let response;
  try {
    response = await fetch(url, Object.assign({
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs || REQUEST_TIMEOUT_MS),
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

// ── Sonarr / Radarr / Lidarr ─────────────────────────────────────────────────
const ARR_APPS = {
  sonarr: { api: 'api/v3', queueExtras: 'includeUnknownSeriesItems=true&includeSeries=true&includeEpisode=true' },
  radarr: { api: 'api/v3', queueExtras: 'includeUnknownMovieItems=true&includeMovie=true' },
  lidarr: { api: 'api/v1', queueExtras: 'includeUnknownArtistItems=true&includeArtist=true&includeAlbum=true' },
};

function arrTitle(kind, record) {
  if (kind === 'sonarr' && record.series) {
    const ep = record.episode;
    const code = ep ? ' S' + String(ep.seasonNumber).padStart(2, '0') + 'E' + String(ep.episodeNumber).padStart(2, '0') : '';
    return record.series.title + code;
  }
  if (kind === 'radarr' && record.movie) {
    return record.movie.title + (record.movie.year ? ' (' + record.movie.year + ')' : '');
  }
  if (kind === 'lidarr' && record.artist) {
    return record.artist.artistName + (record.album ? ' — ' + record.album.title : '');
  }
  return record.title || 'Unknown';
}

function calendarEntry(kind, item) {
  if (kind === 'sonarr') {
    const code = ' S' + String(item.seasonNumber).padStart(2, '0') + 'E' + String(item.episodeNumber).padStart(2, '0');
    return { title: (item.series ? item.series.title : item.title) + code, when: item.airDateUtc || item.airDate || null };
  }
  if (kind === 'radarr') {
    return { title: item.title + (item.year ? ' (' + item.year + ')' : ''), when: item.digitalRelease || item.physicalRelease || item.inCinemas || null };
  }
  return { title: (item.artist ? item.artist.artistName + ' — ' : '') + item.title, when: item.releaseDate || null };
}

async function fetchArr(kind, base, apiKey) {
  const cfg = ARR_APPS[kind];
  const headers = { 'X-Api-Key': apiKey, Accept: 'application/json' };
  const get = suffix => fetchJson(base + '/' + cfg.api + '/' + suffix, { headers });

  const start = new Date();
  const end = new Date(start.getTime() + 24 * 3600 * 1000);
  const [queue, queueStatus, health, diskspace, missing, calendar] = await Promise.all([
    get('queue?page=1&pageSize=20&' + cfg.queueExtras),
    get('queue/status'),
    get('health'),
    get('diskspace'),
    get('wanted/missing?page=1&pageSize=1'),
    get('calendar?start=' + start.toISOString() + '&end=' + end.toISOString() + (kind === 'sonarr' ? '&includeSeries=true' : '')).catch(() => []),
  ]);

  return {
    up: true,
    queueCount: queueStatus.totalCount || 0,
    queueErrors: (queueStatus.errors ? 1 : 0) + (queueStatus.unknownErrors ? 1 : 0),
    queueWarnings: (queueStatus.warnings ? 1 : 0) + (queueStatus.unknownWarnings ? 1 : 0),
    missing: missing.totalRecords || 0,
    health: (Array.isArray(health) ? health : []).map(h => ({ type: h.type, message: h.message })),
    disks: (Array.isArray(diskspace) ? diskspace : []).map(d => ({ path: d.path, free: d.freeSpace, total: d.totalSpace })),
    items: (queue.records || []).map(r => ({
      title: arrTitle(kind, r),
      progress: r.size > 0 ? Math.round((r.size - r.sizeleft) / r.size * 100) : null,
      timeleft: r.timeleft || null,
      status: r.status || null,
    })),
    calendar: (Array.isArray(calendar) ? calendar : []).map(i => calendarEntry(kind, i)).filter(e => e.when),
  };
}

// ── SABnzbd ──────────────────────────────────────────────────────────────────
async function fetchSab(base, apiKey) {
  const url = key => base + '/api?output=json&apikey=' + encodeURIComponent(apiKey) + '&' + key;
  const [queueRes, historyRes] = await Promise.all([
    fetchJson(url('mode=queue&start=0&limit=20')),
    fetchJson(url('mode=history&start=0&limit=5')),
  ]);
  const q = queueRes.queue || {};
  const gb = value => Math.round(parseFloat(value || 0) * 1e9);
  return {
    up: true,
    paused: !!q.paused,
    speed: q.speed || '0',
    kbpersec: parseFloat(q.kbpersec || 0),
    queueCount: q.noofslots || 0,
    disks: q.diskspacetotal1 ? [{ path: q.diskspace1_norm || 'downloads', free: gb(q.diskspace1), total: gb(q.diskspacetotal1) }] : [],
    items: (q.slots || []).map(s => ({
      title: s.filename,
      progress: s.percentage != null ? parseInt(s.percentage, 10) : null,
      timeleft: s.timeleft || null,
      status: s.status || null,
    })),
    history: ((historyRes.history || {}).slots || []).map(s => ({ title: s.name, status: s.status, failMessage: s.fail_message || '' })),
  };
}

// ── Youtarr ──────────────────────────────────────────────────────────────────
async function youtarrLogin(base, user, pass) {
  const data = await fetchJson(base + '/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: user, password: pass }),
  });
  if (!data.token) throw new Error('Youtarr login failed');
  youtarrToken = data.token;
  return data.token;
}

async function fetchYoutarr(base, user, pass) {
  const authed = !!(user && pass);
  const get = async suffix => {
    const headers = { Accept: 'application/json' };
    if (authed) {
      if (!youtarrToken) await youtarrLogin(base, user, pass);
      headers['x-access-token'] = youtarrToken;
    }
    try {
      return await fetchJson(base + suffix, { headers });
    } catch (error) {
      if (authed && /HTTP 401/.test(String(error.message))) {
        headers['x-access-token'] = await youtarrLogin(base, user, pass);
        return fetchJson(base + suffix, { headers });
      }
      throw error;
    }
  };
  const [jobs, activity] = await Promise.all([
    get('/runningjobs'),
    get('/api/jobs/current-activity').catch(() => null),
  ]);
  const running = (Array.isArray(jobs) ? jobs : []).filter(j => j.status === 'In Progress' || j.status === 'Pending');
  return {
    up: true,
    jobCount: running.length,
    items: running.map(j => ({
      title: (j.jobType || 'Job') + (activity && activity.activity ? ' — ' + String(activity.activity).slice(0, 120) : ''),
      progress: typeof j.progress === 'number' ? Math.round(j.progress) : null,
      timeleft: null,
      status: j.status,
    })),
  };
}

// ── LidaTube (reachability only — no HTTP API) ───────────────────────────────
async function fetchLidatube(base) {
  const response = await fetch(base + '/', {
    redirect: 'manual',
    signal: AbortSignal.timeout(PING_TIMEOUT_MS),
  });
  if (response.status >= 500) throw new Error('HTTP ' + response.status);
  try { await response.arrayBuffer(); } catch (error) {}
  return { up: true };
}

// ── Fan-out ──────────────────────────────────────────────────────────────────
async function serviceSlice(name, options, runner) {
  let base;
  try {
    base = baseUrl(options, name + 'Url');
  } catch (error) {
    return { configured: true, up: false, error: safeError(error) };
  }
  if (!base) return { configured: false };
  try {
    return Object.assign({ configured: true }, await runner(base));
  } catch (error) {
    return { configured: true, up: false, error: safeError(error) };
  }
}

async function summary(options) {
  const [sonarr, radarr, lidarr, sabnzbd, youtarr, lidatube] = await Promise.all([
    serviceSlice('sonarr', options, base => fetchArr('sonarr', base, optionString(options, 'sonarrApiKey'))),
    serviceSlice('radarr', options, base => fetchArr('radarr', base, optionString(options, 'radarrApiKey'))),
    serviceSlice('lidarr', options, base => fetchArr('lidarr', base, optionString(options, 'lidarrApiKey'))),
    serviceSlice('sabnzbd', options, base => fetchSab(base, optionString(options, 'sabnzbdApiKey'))),
    serviceSlice('youtarr', options, base => fetchYoutarr(base, optionString(options, 'youtarrUser'), optionString(options, 'youtarrPass'))),
    serviceSlice('lidatube', options, base => fetchLidatube(base)),
  ]);
  return { ok: true, services: { sonarr, radarr, lidarr, sabnzbd, youtarr, lidatube } };
}

const OPENABLE = new Set(['sonarr', 'radarr', 'lidarr', 'sabnzbd', 'youtarr', 'lidatube']);

function openWebUi(options, query) {
  const svc = String(query.svc || '');
  if (!OPENABLE.has(svc)) throw new Error('unknown service');
  const base = baseUrl(options, svc + 'Url');
  if (!base) throw new Error(svc + ' is not configured');
  const shell = require('electron').shell;
  if (!shell || typeof shell.openExternal !== 'function') throw new Error('opening a browser is only available on the panel');
  shell.openExternal(base);
  return { ok: true };
}

async function handle(action, context) {
  const options = context && context.options || {};
  try {
    if (action === 'summary') return await summary(options);
    if (action === 'open') return openWebUi(options, context && context.query || {});
    return { ok: false, error: 'unknown action' };
  } catch (error) {
    return { ok: false, error: safeError(error) };
  }
}

module.exports = { handle };

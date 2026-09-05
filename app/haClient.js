'use strict';
/*
 * haClient.js — Home Assistant data fetcher (REST + WebSocket). Lives in the main process so the
 * WebSocket connection can set the `Origin` header explicitly to the HA URL. HA's WS handler
 * rejects connections from origins it doesn't recognize, which is why we can't open the WS
 * from the editor renderer (its origin is file://). The `ws` package gives us that header.
 *
 * Two entry points:
 *   fetchAll(url, token)            — registries + dashboards in one shot. Returns a cache object
 *                                     with raw registry arrays plus a synthesized entities[] view
 *                                     (HAEntity shape). Does NOT bulk-load /api/states — that's
 *                                     the largest payload by far and most entries are never used.
 *   fetchEntityState(url, token, id) — single-entity REST fetch. Called on demand when an entity
 *                                     actually gets wired into something (button assignment, etc.).
 *
 * Caveat: entities[] is derived from entity_registry, so YAML/template entities that never get
 * registered won't appear. Those would need to be typed manually in any picker UI.
 */
const { net } = require('electron');
const WebSocket = require('ws');

const HA_WS_PATH = '/api/websocket';
const FETCH_ALL_TIMEOUT_MS = 30000;

function wsUrlFor(haUrl) {
  const u = new URL(haUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  u.pathname = u.pathname.replace(/\/+$/, '') + HA_WS_PATH;
  return u.href;
}

// HA echoes the Origin header back into its allowlist check; setting it to HA's own origin
// satisfies the same-origin gate that blocks the editor's file:// renderer.
function originFor(haUrl) {
  return new URL(haUrl).origin;
}

// Open a WS, run the auth handshake, then run the given commands sequentially. Resolves with an
// array of per-command results in the same order: { ok:true, result } or { ok:false, error }.
// A single hard failure (auth, socket error, overall timeout) rejects the whole promise.
function withWebSocket(haUrl, token, commands) {
  return new Promise((resolve, reject) => {
    let ws;
    try { ws = new WebSocket(wsUrlFor(haUrl), { headers: { Origin: originFor(haUrl) }, handshakeTimeout: 8000 }); }
    catch (e) { return reject(new Error('WebSocket open failed: ' + e.message)); }

    let nextId = 1;
    let done = false;
    const pending = new Map();   // id -> { resolve, reject }

    const finish = (err, results) => {
      if (done) return; done = true;
      clearTimeout(overallTo);
      for (const p of pending.values()) { try { p.reject(err || new Error('connection closed')); } catch (e) {} }
      pending.clear();
      try { ws.close(); } catch (e) {}
      err ? reject(err) : resolve(results);
    };
    const overallTo = setTimeout(() => finish(new Error('HA timed out after ' + FETCH_ALL_TIMEOUT_MS + 'ms')), FETCH_ALL_TIMEOUT_MS);

    ws.on('error', err => finish(new Error('WebSocket error: ' + err.message)));
    ws.on('close', () => { if (!done) finish(new Error('WebSocket closed unexpectedly')); });
    ws.on('message', raw => {
      let msg; try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
      if (msg.type === 'auth_required') {
        try { ws.send(JSON.stringify({ type: 'auth', access_token: token })); }
        catch (e) { finish(new Error('failed to send auth: ' + e.message)); }
      } else if (msg.type === 'auth_invalid') {
        finish(new Error('HA rejected the token: ' + (msg.message || 'auth invalid')));
      } else if (msg.type === 'auth_ok') {
        runCommands();
      } else if (msg.type === 'result' && pending.has(msg.id)) {
        const p = pending.get(msg.id); pending.delete(msg.id);
        if (msg.success) p.resolve(msg.result);
        else p.reject(new Error('command failed: ' + ((msg.error || {}).message || 'unknown')));
      }
    });

    async function runCommands() {
      const results = [];
      for (const cmd of commands) {
        const id = nextId++;
        try {
          const r = await new Promise((res, rej) => {
            pending.set(id, { resolve: res, reject: rej });
            try { ws.send(JSON.stringify(Object.assign({ id }, cmd))); }
            catch (e) { pending.delete(id); rej(new Error('send failed: ' + e.message)); }
          });
          results.push({ ok: true, result: r });
        } catch (e) {
          results.push({ ok: false, error: e.message });   // per-command failure; keep going (e.g. floor/label may be missing on older HA)
        }
      }
      finish(null, results);
    }
  });
}

// Derive the slim HAEntity[] view from the registries. State + supportedFeatures are filled in
// lazily by fetchEntityState() when an entity is actually used.
function synthesizeEntities(c) {
  const areaById = new Map(c.areaRegistry.map(a => [a.area_id, a]));
  const deviceById = new Map(c.deviceRegistry.map(d => [d.id, d]));
  const floorById = new Map(c.floorRegistry.map(f => [f.floor_id, f]));
  const labelById = new Map(c.labelRegistry.map(l => [l.label_id, l]));

  return c.entityRegistry
    .filter(r => !r.disabled_by && !r.hidden_by)               // skip disabled/hidden — they aren't useful in pickers
    .map(r => {
      const dev = r.device_id ? deviceById.get(r.device_id) : null;
      const areaId = r.area_id || (dev && dev.area_id) || null;
      const area = areaId ? areaById.get(areaId) : null;
      const floorId = area && area.floor_id;
      const floor = floorId ? floorById.get(floorId) : null;
      const labelIds = Array.isArray(r.labels) ? r.labels : [];
      const labelNames = labelIds.map(id => { const l = labelById.get(id); return l && l.name; }).filter(Boolean);
      return {
        entityId: r.entity_id,
        friendlyName: r.name || r.original_name || r.entity_id,
        domain: (r.entity_id.split('.')[0] || ''),
        area: area ? area.name : '',
        floor: floor ? floor.name : undefined,
        labels: labelNames,
        state: '',                  // populated by fetchEntityState
        supportedFeatures: 0,       // populated by fetchEntityState
      };
    });
}

async function fetchAll(url, token) {
  if (!url || !token) throw new Error('HA URL and token are required');

  // Sequential commands over one WS. Order matches the destructure below.
  const wsResults = await withWebSocket(url, token, [
    { type: 'lovelace/dashboards/list' },
    { type: 'config/area_registry/list' },
    { type: 'config/device_registry/list' },
    { type: 'config/entity_registry/list' },
    { type: 'config/floor_registry/list' },                    // HA 2024.1+ — older returns "unknown command" → empty
    { type: 'config/label_registry/list' },                    // HA 2024.4+ — older returns "unknown command" → empty
  ]);
  const [dashRes, areaRes, devRes, entRes, floorRes, labelRes] = wsResults;

  const cache = {
    ok: true,
    ts: Date.now(),
    error: null,
    dashboards: dashRes.ok ? (dashRes.result || []) : [],
    areaRegistry: areaRes.ok ? (areaRes.result || []) : [],
    deviceRegistry: devRes.ok ? (devRes.result || []) : [],
    entityRegistry: entRes.ok ? (entRes.result || []) : [],
    floorRegistry: floorRes.ok ? (floorRes.result || []) : [],
    labelRegistry: labelRes.ok ? (labelRes.result || []) : [],
    states: {},                                                // entityId -> single-entity state (filled lazily)
  };
  cache.entities = synthesizeEntities(cache);
  return cache;
}

// Single-entity state fetch via REST. Used on demand when an entity gets assigned/used so we can
// fill in state + supportedFeatures without paying the cost of a bulk /api/states load.
async function fetchEntityState(url, token, entityId) {
  if (!url || !token || !entityId) throw new Error('url, token, entityId required');
  const u = new URL(url);
  u.pathname = u.pathname.replace(/\/+$/, '') + '/api/states/' + encodeURIComponent(entityId);
  const r = await net.fetch(u.href, { method: 'GET', headers: { 'Authorization': 'Bearer ' + token } });
  if (!r.ok) throw new Error('HA ' + r.status);
  const data = JSON.parse(await r.text());
  return {
    entityId: data.entity_id,
    state: data.state,
    supportedFeatures: (data.attributes && data.attributes.supported_features) || 0,
    attributes: data.attributes || {},
    lastUpdated: data.last_updated,
  };
}

module.exports = { fetchAll, fetchEntityState };

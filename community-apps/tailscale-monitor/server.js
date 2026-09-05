'use strict';

// Tailscale Monitor backend. Reads the tailnet from the LOCAL tailscale daemon via
// `tailscale status --json` — no API token, no OAuth, no CORS, no internet round-trip.
// The panel host is itself a tailnet node, so the daemon already knows every machine.
// Bridge contract: the frontend calls /app-api/<action> -> handle(action, {options, query}).

const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');

const EXEC_TIMEOUT_MS = 8000;
const MAX_BUFFER = 8 * 1024 * 1024;

// Where the tailscale CLI lives. Option override first, then the usual install paths, then PATH.
function cliPath(options) {
  const override = options && options.cliPath ? String(options.cliPath).trim() : '';
  const candidates = [
    override,
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe'),
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Tailscale', 'tailscale.exe'),
    '/usr/bin/tailscale',
    '/usr/local/bin/tailscale',
    '/opt/homebrew/bin/tailscale',
  ].filter(Boolean);
  for (const c of candidates) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return override || 'tailscale';   // last resort: rely on PATH
}

function runStatus(bin) {
  return new Promise((resolve, reject) => {
    execFile(bin, ['status', '--json'], { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true }, (err, stdout) => {
      // `tailscale status` exits non-zero when logged out/stopped but still prints valid JSON — parse first.
      let json = null;
      try { json = JSON.parse(stdout); } catch (e) {}
      if (json) return resolve(json);
      if (err && err.code === 'ENOENT') return reject(new Error('Tailscale CLI not found — set its path in the app options, or install Tailscale'));
      if (err && (err.killed || err.signal)) return reject(new Error('tailscale status timed out'));
      reject(new Error((err && err.message) || 'could not read tailscale status'));
    });
  });
}

function ownerOf(status, userId) {
  const u = status.User && status.User[userId];
  return (u && (u.LoginName || u.DisplayName)) || '';
}

function mapNode(n, status, isSelf, now) {
  const ips = Array.isArray(n.TailscaleIPs) ? n.TailscaleIPs : [];
  // Go's zero time ("0001-01-01...") parses to a huge negative number — treat it as unknown.
  let lastSeen = n.LastSeen ? Date.parse(n.LastSeen) : NaN;
  if (lastSeen < 0) lastSeen = NaN;
  const expiry = n.KeyExpiry ? Date.parse(n.KeyExpiry) : NaN;
  return {
    id: n.ID || '',
    name: n.HostName || (n.DNSName || '').split('.')[0] || '(unnamed)',
    owner: ownerOf(status, n.UserID),
    self: !!isSelf,
    addresses: ips,
    ipv4: ips.find(ip => ip.indexOf(':') === -1) || ips[0] || '',
    os: n.OS || '',
    online: !!n.Online,
    lastSeen: Number.isFinite(lastSeen) ? lastSeen : null,
    exitNode: !!n.ExitNode,                 // currently acting as this node's exit
    exitNodeOption: !!n.ExitNodeOption,     // advertises itself as an exit node
    expired: Number.isFinite(expiry) && expiry < now,
    // Connection between the panel host and this peer (meaningless for self):
    // CurAddr set = direct WireGuard endpoint; else Relay = DERP city code.
    direct: (n.CurAddr || '') || null,
    relay: (n.Relay || '') || null,
    rxBytes: Number(n.RxBytes) || 0,        // session bytes panel<->peer, not tailnet-wide
    txBytes: Number(n.TxBytes) || 0,
  };
}

// ── Rate sampling: previous counters + timestamp, kept across /app-api calls ──
let lastSample = null;   // { t, in, out, peers: { id: {rx, tx} } }

// Parse `tailscale metrics print`: sum tailscaled_{inbound,outbound}_bytes_total across paths.
function runMetrics(bin) {
  return new Promise(resolve => {
    execFile(bin, ['metrics', 'print'], { timeout: EXEC_TIMEOUT_MS, maxBuffer: MAX_BUFFER, windowsHide: true }, (err, stdout) => {
      if (err || !stdout) return resolve(null);   // older CLI without `metrics` -> no totals, no error
      let inb = 0, outb = 0;
      for (const m of stdout.matchAll(/^tailscaled_(inbound|outbound)_bytes_total\{[^}]*\}\s+(\d+)/gm)) {
        if (m[1] === 'inbound') inb += Number(m[2]); else outb += Number(m[2]);
      }
      resolve({ in: inb, out: outb });
    });
  });
}

// Attach header rateIn/rateOut and per-device rxRate/txRate (bytes/sec) by diffing
// against the previous sample. First call after load has no baseline -> rates null/0.
function attachRates(list, totals) {
  const now = Date.now();
  const sample = { t: now, in: totals ? totals.in : null, out: totals ? totals.out : null, peers: {} };
  list.forEach(d => { sample.peers[d.id] = { rx: d.rxBytes, tx: d.txBytes }; });

  let rateIn = null, rateOut = null;
  const prev = lastSample;
  const dt = prev ? (now - prev.t) / 1000 : 0;
  if (prev && dt > 1) {
    if (totals && prev.in != null) {
      rateIn = Math.max(0, (totals.in - prev.in) / dt);
      rateOut = Math.max(0, (totals.out - prev.out) / dt);
    }
    list.forEach(d => {
      const p = prev.peers[d.id];
      d.rxRate = p ? Math.max(0, (d.rxBytes - p.rx) / dt) : 0;
      d.txRate = p ? Math.max(0, (d.txBytes - p.tx) / dt) : 0;
    });
  } else {
    list.forEach(d => { d.rxRate = 0; d.txRate = 0; });
  }
  lastSample = sample;
  return { rateIn, rateOut };
}

async function devices(options) {
  const bin = cliPath(options);
  const [status, totals] = await Promise.all([runStatus(bin), runMetrics(bin)]);
  const state = status.BackendState || 'Unknown';
  if (state !== 'Running') {
    return { ok: true, state, tailnet: '', count: 0, online: 0, devices: [],
      note: 'Tailscale is not connected (state: ' + state + ')' };
  }
  const now = Date.now();
  const list = [];
  if (status.Self) list.push(mapNode(status.Self, status, true, now));
  const peers = status.Peer || {};
  Object.keys(peers).forEach(k => list.push(mapNode(peers[k], status, false, now)));
  const { rateIn, rateOut } = attachRates(list, totals);

  // self first, then online, then by name
  list.sort((a, b) => (b.self - a.self) || (b.online - a.online) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const tailnet = (status.MagicDNSSuffix || '').replace(/^\.+|\.+$/g, '');
  return { ok: true, state, tailnet, count: list.length, online: list.filter(d => d.online).length,
    rateIn, rateOut, devices: list };
}

function openAdmin() {
  const shell = require('electron').shell;
  if (!shell || typeof shell.openExternal !== 'function') throw new Error('opening a browser is only available on the panel');
  shell.openExternal('https://login.tailscale.com/admin/machines');
  return { ok: true };
}

async function handle(action, context) {
  const options = (context && context.options) || {};
  try {
    if (action === 'devices') return await devices(options);
    if (action === 'open') return openAdmin();
    return { ok: false, error: 'unknown action' };
  } catch (error) {
    return { ok: false, error: (error && error.message) || 'request failed' };
  }
}

module.exports = { handle, _test: { mapNode } };

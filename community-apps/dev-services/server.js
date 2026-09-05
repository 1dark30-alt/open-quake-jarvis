'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');
const core = require('./service-core');

const APP_ID = 'dev-services';
const BODY_LIMIT = 64 * 1024;
const PROBE_TIMEOUT_MS = 1500;
const INSPECT_TIMEOUT_MS = 5000;
const OBSERVATION_TTL_MS = 2 * 60 * 1000;
const MAX_OBSERVATIONS = 100;

const POWERSHELL_INSPECTOR = [
  "$ErrorActionPreference = 'Stop'",
  "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
  "while (($line = [Console]::In.ReadLine()) -ne $null) {",
  "  $requestId = 0",
  "  try {",
  "    $request = $line | ConvertFrom-Json",
  "    $requestId = [int]$request.id",
  "    $ports = @($request.ports | ForEach-Object { [int]$_ })",
  "    $rows = @()",
  "    if ($ports.Count -gt 0) {",
  "      $connections = @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |",
  "        Where-Object { $ports -contains [int]$_.LocalPort })",
  "      foreach ($connection in $connections) {",
  "        $processName = ''",
  "        $executablePath = ''",
  "        try {",
  "          $owner = Get-Process -Id ([int]$connection.OwningProcess) -ErrorAction Stop",
  "          $processName = [string]$owner.ProcessName",
  "          try { $executablePath = [string]$owner.Path } catch {}",
  "        } catch {}",
  "        $rows += @{",
  "          port = [int]$connection.LocalPort",
  "          pid = [int]$connection.OwningProcess",
  "          processName = $processName",
  "          executablePath = $executablePath",
  "        }",
  "      }",
  "    }",
  "    $response = @{ id = $requestId; ok = $true; rows = @($rows) }",
  "  } catch {",
  "    $response = @{ id = $requestId; ok = $false; error = $_.Exception.Message; rows = @() }",
  "  }",
  "  [Console]::Out.WriteLine(($response | ConvertTo-Json -Compress -Depth 4))",
  "  [Console]::Out.Flush()",
  "}",
].join('\n');

function safePid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 4 && pid !== process.pid && pid !== process.ppid ? pid : null;
}

function localHost(value) {
  const host = String(value || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  return host === 'localhost' || host === '127.0.0.1' || host === '::1'
    || host === '0.0.0.0' || host === '::';
}

function parseBody(context) {
  const body = context && context.body;
  if (!Buffer.isBuffer(body) || !body.length || body.length > BODY_LIMIT) throw new Error('A valid request body is required.');
  let value;
  try { value = JSON.parse(body.toString('utf8')); }
  catch (error) { throw new Error('The request body is not valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The request body must be an object.');
  return value;
}

function validateService(value, index) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Service ' + (index + 1) + ' is invalid.');
  if (!String(value.id || '').trim() || String(value.id).length > 80) throw new Error('Every service requires a valid id.');
  if (!String(value.name || '').trim() || String(value.name).length > 80) throw new Error('Every service requires a display name.');
  if (!core.normalizePort(value.port)) throw new Error('Port must be between 1 and 65535.');
  if (!['http', 'https'].includes(String(value.protocol || '').toLowerCase())) throw new Error('Protocol must be HTTP or HTTPS.');
  if (String(value.host || '').length > 253 || !String(value.host || '').trim()) throw new Error('Every service requires a hostname.');
  const service = core.normalizeService(value, index);
  core.buildUrl(service);
  return service;
}

function validateServices(value) {
  if (!Array.isArray(value)) throw new Error('Services must be an array.');
  if (value.length > core.MAX_SERVICES) throw new Error('At most ' + core.MAX_SERVICES + ' services can be checked.');
  const services = value.map(validateService);
  if (new Set(services.map(service => service.id)).size !== services.length) throw new Error('Service ids must be unique.');
  return services;
}

function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Settings must be an object.');
  const refreshSeconds = Number(value.refreshSeconds);
  if (!core.REFRESH_OPTIONS.includes(refreshSeconds)) {
    throw new Error('Refresh interval must be one of ' + core.REFRESH_OPTIONS.join(', ') + ' seconds.');
  }
  return { refreshSeconds, services: validateServices(value.services) };
}

function defaultProbe(host, port) {
  return new Promise(resolve => {
    let settled = false;
    const socket = net.createConnection({ host, port });
    const finish = result => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish({ listening: true }));
    socket.once('timeout', () => finish({ listening: false, error: 'Connection timed out.' }));
    socket.once('error', error => {
      if (error && error.code === 'ECONNREFUSED') finish({ listening: false });
      else finish({ listening: false, error: (error && error.message) || 'Port check failed.' });
    });
  });
}

class UnavailableInspector {
  async inspect(ports) { return new Map(ports.map(port => [port, []])); }
  close() {}
}

class LinuxProcInspector {
  listeningInodes(ports) {
    const wanted = new Set(ports);
    const result = new Map(ports.map(port => [port, new Set()]));
    for (const file of ['/proc/net/tcp', '/proc/net/tcp6']) {
      let rows;
      try { rows = fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(1); }
      catch (error) { continue; }
      for (const row of rows) {
        const fields = row.trim().split(/\s+/);
        if (fields.length < 10 || fields[3] !== '0A') continue;
        const port = parseInt((fields[1].split(':')[1] || ''), 16);
        if (wanted.has(port) && fields[9]) result.get(port).add(fields[9]);
      }
    }
    return result;
  }

  async inspect(ports) {
    const byPort = new Map(ports.map(port => [port, []]));
    const inodes = this.listeningInodes(ports);
    const inodeToPort = new Map();
    for (const [port, values] of inodes) {
      for (const inode of values) inodeToPort.set(inode, port);
    }
    if (!inodeToPort.size) return byPort;
    let processDirs = [];
    try { processDirs = fs.readdirSync('/proc', { withFileTypes: true }).filter(entry => entry.isDirectory() && /^\d+$/.test(entry.name)); }
    catch (error) { return byPort; }
    for (const entry of processDirs) {
      const pid = Number(entry.name);
      const fdDir = '/proc/' + entry.name + '/fd';
      let descriptors = [];
      try { descriptors = fs.readdirSync(fdDir); } catch (error) { continue; }
      const matchedPorts = new Set();
      for (const descriptor of descriptors) {
        let target = '';
        try { target = fs.readlinkSync(path.join(fdDir, descriptor)); } catch (error) { continue; }
        const match = /^socket:\[(\d+)\]$/.exec(target);
        const port = match && inodeToPort.get(match[1]);
        if (port) matchedPorts.add(port);
      }
      if (!matchedPorts.size) continue;
      let processName = '';
      let executablePath = '';
      try { processName = fs.readFileSync('/proc/' + entry.name + '/comm', 'utf8').trim(); } catch (error) {}
      try { executablePath = fs.readlinkSync('/proc/' + entry.name + '/exe'); } catch (error) {}
      for (const port of matchedPorts) byPort.get(port).push({ pid, processName, executablePath });
    }
    return byPort;
  }

  close() {}
}

class WindowsPowerShellInspector {
  constructor(spawnImpl) {
    this.spawnImpl = spawnImpl || spawn;
    this.child = null;
    this.buffer = '';
    this.sequence = 0;
    this.pending = new Map();
  }

  start() {
    if (this.child) return;
    const child = this.spawnImpl('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive',
      '-Command', POWERSHELL_INSPECTOR,
    ], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child = child;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => this.onData(chunk));
    child.stderr.on('data', () => {}); // drain diagnostics so a noisy helper cannot block on a full pipe
    child.on('error', error => this.fail(error));
    child.on('exit', () => this.fail(new Error('The Windows process inspector stopped.')));
  }

  onData(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let response;
      try { response = JSON.parse(line); } catch (error) { continue; }
      const pending = this.pending.get(Number(response.id));
      if (!pending) continue;
      clearTimeout(pending.timer);
      this.pending.delete(Number(response.id));
      if (!response.ok) pending.reject(new Error(response.error || 'Windows process lookup failed.'));
      else pending.resolve(this.rowsToMap(pending.ports, response.rows));
    }
  }

  rowsToMap(ports, value) {
    const map = new Map(ports.map(port => [port, []]));
    const rows = Array.isArray(value) ? value : (value ? [value] : []);
    for (const row of rows) {
      const port = Number(row && row.port);
      const pid = Number(row && row.pid);
      if (!map.has(port) || !Number.isInteger(pid)) continue;
      const list = map.get(port);
      if (list.some(owner => owner.pid === pid)) continue;
      list.push({
        pid,
        processName: String(row.processName || ''),
        executablePath: String(row.executablePath || ''),
      });
    }
    return map;
  }

  inspect(ports) {
    const cleanPorts = [...new Set(ports.map(Number).filter(port => Number.isInteger(port) && port >= 1 && port <= 65535))];
    if (!cleanPorts.length) return Promise.resolve(new Map());
    try { this.start(); } catch (error) { return Promise.reject(error); }
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Windows process lookup timed out.'));
        this.close();
      }, INSPECT_TIMEOUT_MS);
      this.pending.set(id, { ports: cleanPorts, resolve, reject, timer });
      try { this.child.stdin.write(JSON.stringify({ id, ports: cleanPorts }) + '\n'); }
      catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  fail(error) {
    const child = this.child;
    this.child = null;
    this.buffer = '';
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    if (child) {
      try { child.removeAllListeners(); } catch (ignored) {}
    }
  }

  close() {
    const child = this.child;
    this.child = null;
    if (child) {
      try { child.stdin.end(); } catch (error) {}
      try { child.kill(); } catch (error) {}
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Process lookup was cancelled.'));
    }
    this.pending.clear();
    this.buffer = '';
  }
}

function inspectorFor(platform) {
  if (platform === 'win32') return new WindowsPowerShellInspector();
  if (platform === 'linux') return new LinuxProcInspector();
  return new UnavailableInspector();
}

const production = {
  platform: process.platform,
  probe: defaultProbe,
  kill: (pid, signal) => process.kill(pid, signal),
  now: Date.now,
  inspector: null,
  settingsFile: () => {
    const electron = require('electron');
    const userData = electron && electron.app && electron.app.getPath('userData');
    if (!userData) throw new Error('App settings storage is unavailable.');
    return path.join(userData, 'app-data', 'dev-services.json');
  },
  openPath: async folder => {
    const shell = require('electron').shell;
    return shell.openPath(folder);
  },
  copy: value => {
    const clipboard = require('electron').clipboard;
    clipboard.writeText(value);
  },
};
let deps = Object.assign({}, production);
const observations = new Map();

function readSharedSettings(fallback) {
  const target = deps.settingsFile();
  try {
    return validateSettings(JSON.parse(fs.readFileSync(target, 'utf8')));
  } catch (error) {
    if (error && error.code !== 'ENOENT') throw new Error('Dev Services settings could not be read: ' + error.message);
    const initial = fallback == null ? core.normalizeSettings({}) : validateSettings(fallback);
    if (fallback != null) writeSharedSettings(initial);
    return initial;
  }
}

function writeSharedSettings(value) {
  const settings = validateSettings(value);
  const target = deps.settingsFile();
  const temp = target + '.tmp';
  fs.mkdirSync(path.dirname(target), { recursive: true });
  try {
    fs.writeFileSync(temp, JSON.stringify(settings, null, 2), 'utf8');
    fs.renameSync(temp, target);
  } catch (error) {
    try { fs.rmSync(temp, { force: true }); } catch (ignored) {}
    throw new Error('Dev Services settings could not be saved: ' + error.message);
  }
  return settings;
}

function getInspector() {
  if (!deps.inspector) deps.inspector = inspectorFor(deps.platform);
  return deps.inspector;
}

function lookupDescription() {
  if (deps.platform === 'win32') return 'Windows PowerShell (one persistent helper)';
  if (deps.platform === 'linux') return 'Linux /proc';
  return 'Unavailable on this platform';
}

function pruneObservations() {
  const cutoff = deps.now() - OBSERVATION_TTL_MS;
  for (const [token, observation] of observations) {
    if (observation.createdAt < cutoff) observations.delete(token);
  }
  while (observations.size > MAX_OBSERVATIONS) observations.delete(observations.keys().next().value);
}

function observationToken() {
  return require('crypto').randomBytes(24).toString('base64url');
}

function rememberObservation(service, owner) {
  pruneObservations();
  const token = observationToken();
  observations.set(token, {
    createdAt: deps.now(),
    serviceId: service.id,
    port: service.port,
    host: service.host,
    pid: owner.pid,
    processName: owner.processName || '',
    expectedProcess: service.expectedProcess || '',
  });
  return token;
}

async function inspect(ports) {
  try { return { owners: await getInspector().inspect(ports), error: '' }; }
  catch (error) { return { owners: new Map(ports.map(port => [port, []])), error: (error && error.message) || 'Process lookup failed.' }; }
}

async function statuses(services) {
  const probes = await Promise.all(services.map(service => deps.probe(service.host, service.port)));
  const localListeningPorts = [...new Set(services
    .filter((service, index) => localHost(service.host) && probes[index].listening)
    .map(service => service.port))];
  const ownership = await inspect(localListeningPorts);

  return services.map((service, index) => {
    const probe = probes[index];
    const owners = localHost(service.host) ? (ownership.owners.get(service.port) || []) : [];
    const mapped = core.mapState({
      listening: probe.listening,
      error: probe.error,
      owners,
      expectedProcess: service.expectedProcess,
    });
    const owner = owners.length === 1 ? owners[0] : null;
    const pid = owner && safePid(owner.pid);
    const canStop = mapped.state === 'running' && !!pid && !!String(owner.processName || '').trim() && localHost(service.host);
    return {
      id: service.id,
      state: mapped.state,
      label: mapped.label,
      detail: mapped.detail,
      url: core.buildUrl(service),
      pid: owner ? Number(owner.pid) || null : null,
      processName: owner ? String(owner.processName || '') : '',
      expectedProcess: service.expectedProcess,
      canStop,
      observationToken: canStop ? rememberObservation(service, owner) : '',
      processLookupError: localHost(service.host) ? ownership.error : '',
      processLookupAvailable: localHost(service.host) && ['win32', 'linux'].includes(deps.platform),
    };
  });
}

async function stopObservedProcess(body) {
  pruneObservations();
  const token = String(body.observationToken || '');
  const serviceId = String(body.serviceId || '');
  if (!/^[A-Za-z0-9_-]{20,100}$/.test(token) || !serviceId) throw new Error('A valid stop confirmation is required.');
  const observation = observations.get(token);
  observations.delete(token);
  if (!observation || observation.serviceId !== serviceId) throw new Error('The stop confirmation has expired. Refresh and try again.');
  const pid = safePid(observation.pid);
  if (!pid || !localHost(observation.host)) throw new Error('This process cannot be stopped safely.');

  const fresh = await getInspector().inspect([observation.port]);
  const owners = fresh.get(observation.port) || [];
  if (owners.length !== 1) throw new Error('Port ownership changed or is ambiguous. Nothing was stopped.');
  const owner = owners[0];
  if (safePid(owner.pid) !== pid
      || core.normalizeProcessName(owner.processName) !== core.normalizeProcessName(observation.processName)) {
    throw new Error('Port ownership changed since the last check. Nothing was stopped.');
  }
  if (observation.expectedProcess && !core.processMatches(observation.expectedProcess, owner.processName)) {
    throw new Error('The current process does not match the configured expectation. Nothing was stopped.');
  }
  deps.kill(pid, 'SIGTERM');
  return { ok: true, stopped: { pid, processName: String(owner.processName || '') } };
}

async function openService(body, context) {
  const service = validateService(body.service, 0);
  const url = core.buildUrl(service);
  if (!context.host || typeof context.host.openExternal !== 'function') throw new Error('External navigation is unavailable.');
  const opened = await context.host.openExternal(url);
  if (!opened) throw new Error('The service URL could not be opened.');
  return { ok: true, url };
}

async function copyService(body) {
  const service = validateService(body.service, 0);
  const url = core.buildUrl(service);
  deps.copy(url);
  return { ok: true, url };
}

async function openFolder(body) {
  const service = validateService(body.service, 0);
  const folder = service.projectFolder;
  if (!folder || !path.isAbsolute(folder)) throw new Error('Configure an absolute project folder first.');
  let stat;
  try { stat = fs.statSync(folder); } catch (error) { throw new Error('The configured project folder does not exist.'); }
  if (!stat.isDirectory()) throw new Error('The configured project path is not a folder.');
  const result = await deps.openPath(folder);
  if (result) throw new Error(result);
  return { ok: true, folder };
}

async function handle(action, context) {
  if (!context || context.appId !== APP_ID) return { ok: false, error: 'unauthorized' };
  try {
    const body = parseBody(context);
    if (action === 'settings') return { ok: true, settings: readSharedSettings(body.fallback) };
    if (action === 'save-settings') return { ok: true, settings: writeSharedSettings(body.settings) };
    if (action === 'status') {
      const stored = body.useStoredSettings ? readSharedSettings(body.fallback) : null;
      const services = stored ? stored.services : validateServices(body.services);
      return {
        ok: true,
        checkedAt: deps.now(),
        platform: deps.platform,
        processLookup: lookupDescription(),
        settings: stored || undefined,
        services: await statuses(services),
      };
    }
    if (action === 'open') return await openService(body, context);
    if (action === 'copy') return await copyService(body);
    if (action === 'open-folder') return await openFolder(body);
    if (action === 'stop') return await stopObservedProcess(body);
    return { ok: false, error: 'unknown action' };
  } catch (error) {
    return { ok: false, error: (error && error.message) || 'Request failed.' };
  }
}

function shutdown() {
  if (deps.inspector && typeof deps.inspector.close === 'function') deps.inspector.close();
  deps.inspector = null;
  observations.clear();
}

function reset() {
  shutdown();
  deps = Object.assign({}, production);
}

function setDependencies(overrides) {
  shutdown();
  deps = Object.assign({}, production, overrides || {});
}

module.exports = {
  handle,
  _shutdown: shutdown,
  _test: {
    LinuxProcInspector,
    UnavailableInspector,
    WindowsPowerShellInspector,
    localHost,
    parseBody,
    reset,
    safePid,
    setDependencies,
    validateService,
    validateServices,
    validateSettings,
    readSharedSettings,
    writeSharedSettings,
  },
};

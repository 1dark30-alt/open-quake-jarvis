'use strict';

(function expose(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DevServicesCore = api;
}(typeof globalThis === 'object' ? globalThis : this, function createCore() {
  const MAX_SERVICES = 12;
  const REFRESH_OPTIONS = Object.freeze([10, 15, 30, 60]);
  const DEFAULT_SETTINGS = Object.freeze({ refreshSeconds: 15, services: Object.freeze([]) });

  function text(value, maxLength) {
    return String(value == null ? '' : value).trim().slice(0, maxLength);
  }

  function newId() {
    if (typeof crypto === 'object' && crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    return 'service-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 9);
  }

  function normalizeProtocol(value) {
    return String(value || '').toLowerCase() === 'https' ? 'https' : 'http';
  }

  function normalizePort(value) {
    const port = Number(value);
    return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null;
  }

  function normalizeProcessName(value) {
    const cleaned = text(value, 260).replace(/^.*[\\/]/, '').toLowerCase();
    return cleaned.endsWith('.exe') ? cleaned.slice(0, -4) : cleaned;
  }

  function processMatches(expected, actual) {
    const wanted = normalizeProcessName(expected);
    const found = normalizeProcessName(actual);
    return !wanted || (!!found && wanted === found);
  }

  function normalizeService(value, index) {
    const input = value && typeof value === 'object' ? value : {};
    return {
      id: text(input.id, 80) || newId(),
      name: text(input.name, 80) || 'Service ' + (Number(index || 0) + 1),
      port: normalizePort(input.port) || 3000,
      protocol: normalizeProtocol(input.protocol),
      host: text(input.host, 253) || 'localhost',
      path: text(input.path, 1024),
      expectedProcess: text(input.expectedProcess, 260),
      projectFolder: text(input.projectFolder, 2048),
    };
  }

  function normalizeSettings(value) {
    const input = value && typeof value === 'object' ? value : {};
    const refresh = Number(input.refreshSeconds);
    return {
      refreshSeconds: REFRESH_OPTIONS.includes(refresh) ? refresh : DEFAULT_SETTINGS.refreshSeconds,
      services: (Array.isArray(input.services) ? input.services : [])
        .slice(0, MAX_SERVICES)
        .map(normalizeService),
    };
  }

  function urlHost(host) {
    if (host.includes(':') && !host.startsWith('[') && !host.endsWith(']')) return '[' + host + ']';
    return host;
  }

  function buildUrl(value) {
    const service = normalizeService(value, 0);
    const host = service.host;
    if (!host || /[\s/@?#]/.test(host)) throw new Error('Enter a valid hostname or IP address.');
    const base = new URL(service.protocol + '://' + urlHost(host) + ':' + service.port + '/');
    if (!base.hostname || base.username || base.password) throw new Error('Enter a valid hostname or IP address.');
    const suffix = service.path ? '/' + service.path.replace(/^\/+/, '') : '/';
    const target = new URL(suffix, base);
    if (target.origin !== base.origin) throw new Error('The service path must stay on the configured host.');
    return target.href;
  }

  function mapState(input) {
    const value = input || {};
    if (value.error) return { state: 'error', label: 'ERROR', detail: String(value.error) };
    if (!value.listening) return { state: 'stopped', label: 'STOPPED', detail: 'Nothing is listening on this port.' };
    const owners = Array.isArray(value.owners) ? value.owners : [];
    if (owners.length > 1) return { state: 'error', label: 'ERROR', detail: 'Multiple processes report ownership of this port.' };
    const owner = owners[0] || null;
    if (owner && value.expectedProcess && !processMatches(value.expectedProcess, owner.processName)) {
      return {
        state: 'unexpected',
        label: 'UNEXPECTED PROCESS',
        detail: 'Expected ' + value.expectedProcess + ', found ' + (owner.processName || 'an unknown process') + '.',
      };
    }
    return {
      state: 'running',
      label: 'RUNNING',
      detail: owner ? 'Listening process identified.' : 'Listening; process ownership is unavailable.',
    };
  }

  function addService(settings, service) {
    const next = normalizeSettings(settings);
    if (next.services.length >= MAX_SERVICES) return next;
    next.services.push(normalizeService(service || {}, next.services.length));
    return next;
  }

  function removeService(settings, id) {
    const next = normalizeSettings(settings);
    next.services = next.services.filter(service => service.id !== id);
    return next;
  }

  function moveService(settings, id, direction) {
    const next = normalizeSettings(settings);
    const from = next.services.findIndex(service => service.id === id);
    const to = from + (direction < 0 ? -1 : 1);
    if (from < 0 || to < 0 || to >= next.services.length) return next;
    const moved = next.services.splice(from, 1)[0];
    next.services.splice(to, 0, moved);
    return next;
  }

  return {
    DEFAULT_SETTINGS,
    MAX_SERVICES,
    REFRESH_OPTIONS,
    addService,
    buildUrl,
    mapState,
    moveService,
    normalizePort,
    normalizeProcessName,
    normalizeService,
    normalizeSettings,
    processMatches,
    removeService,
  };
}));

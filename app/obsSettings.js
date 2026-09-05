'use strict';
// Pure OBS connection settings -- defaults, normalization, and ws-URL derivation. Separate module
// (like discordSettings.js) so it unit-tests without Electron. The password is encrypted at rest by
// secretStore (settings.obs.password); host/port/enabled/autoReconnect stay plaintext.

const DEFAULT_OBS_SETTINGS = Object.freeze({
  host: '127.0.0.1',
  port: '4455',
  password: '',
  enabled: false,
  autoReconnect: true,
});

// Accept a bare host/IP, tolerating a pasted ws://host:port/ or trailing path; default to loopback.
function cleanHost(value) {
  let h = typeof value === 'string' ? value.trim() : '';
  h = h.replace(/^wss?:\/\//i, '').replace(/^https?:\/\//i, '').replace(/\/.*$/, '').replace(/:\d+$/, '');
  return h || DEFAULT_OBS_SETTINGS.host;
}

function cleanPort(value) {
  const n = parseInt(String(value == null ? '' : value).trim(), 10);
  return Number.isInteger(n) && n >= 1 && n <= 65535 ? String(n) : DEFAULT_OBS_SETTINGS.port;
}

function normalizeObsSettings(value) {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    host: cleanHost(source.host),
    port: cleanPort(source.port),
    password: typeof source.password === 'string' ? source.password : '',
    enabled: source.enabled === true,
    autoReconnect: source.autoReconnect !== false,
  };
}

function obsWsUrl(settings) {
  const s = normalizeObsSettings(settings);
  return 'ws://' + s.host + ':' + s.port;
}

module.exports = { DEFAULT_OBS_SETTINGS, normalizeObsSettings, obsWsUrl, cleanHost, cleanPort };

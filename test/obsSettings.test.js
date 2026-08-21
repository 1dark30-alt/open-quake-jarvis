'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_OBS_SETTINGS, normalizeObsSettings, obsWsUrl, cleanHost, cleanPort } = require('../app/obsSettings');

test('normalizeObsSettings fills sane defaults for empty/garbage input', () => {
  assert.deepEqual(normalizeObsSettings(undefined), DEFAULT_OBS_SETTINGS);
  assert.deepEqual(normalizeObsSettings({}), DEFAULT_OBS_SETTINGS);
  assert.deepEqual(normalizeObsSettings(null), DEFAULT_OBS_SETTINGS);
  assert.equal(normalizeObsSettings({}).enabled, false);
  assert.equal(normalizeObsSettings({}).autoReconnect, true);
});

test('cleanHost tolerates schemes, ports, and paths; empty -> loopback', () => {
  assert.equal(cleanHost('192.168.1.50'), '192.168.1.50');
  assert.equal(cleanHost('  ws://192.168.1.50:4455/  '), '192.168.1.50');
  assert.equal(cleanHost('http://obs.local/x'), 'obs.local');
  assert.equal(cleanHost(''), '127.0.0.1');
  assert.equal(cleanHost(undefined), '127.0.0.1');
});

test('cleanPort clamps to a valid TCP port, else the default', () => {
  assert.equal(cleanPort('4455'), '4455');
  assert.equal(cleanPort(4455), '4455');
  assert.equal(cleanPort('0'), '4455');
  assert.equal(cleanPort('70000'), '4455');
  assert.equal(cleanPort('abc'), '4455');
  assert.equal(cleanPort(''), '4455');
});

test('enabled/autoReconnect coerce strictly', () => {
  assert.equal(normalizeObsSettings({ enabled: true }).enabled, true);
  assert.equal(normalizeObsSettings({ enabled: 'yes' }).enabled, false);   // only boolean true enables
  assert.equal(normalizeObsSettings({ autoReconnect: false }).autoReconnect, false);
  assert.equal(normalizeObsSettings({ autoReconnect: 0 }).autoReconnect, true);   // only boolean false disables
});

test('password passes through as a string only', () => {
  assert.equal(normalizeObsSettings({ password: 'secret' }).password, 'secret');
  assert.equal(normalizeObsSettings({ password: 123 }).password, '');
});

test('obsWsUrl derives ws://host:port from normalized settings', () => {
  assert.equal(obsWsUrl({ host: '192.168.1.50', port: '4455' }), 'ws://192.168.1.50:4455');
  assert.equal(obsWsUrl({}), 'ws://127.0.0.1:4455');
  assert.equal(obsWsUrl({ host: 'ws://10.0.0.9:4460/', port: '4460' }), 'ws://10.0.0.9:4460');
});

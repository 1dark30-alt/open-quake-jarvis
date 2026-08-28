'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const AdmZip = require('adm-zip');
const core = require('./service-core');
const { PollingController } = require('./polling');

test('manifest declares a served, app-local backend without global options', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'app.json'), 'utf8'));
  assert.equal(manifest.id, 'dev-services');
  assert.equal(manifest.served, true);
  assert.equal(manifest.server, 'server.js');
  assert.equal(manifest.knob, true);
  assert.deepEqual(manifest.options, []);
});

test('community catalog and installable zip contain the Dev Services runtime', () => {
  const communityRoot = path.dirname(__dirname);
  const catalog = JSON.parse(fs.readFileSync(path.join(communityRoot, 'index.json'), 'utf8'));
  const entry = catalog.apps.find(app => app.id === 'dev-services');
  assert.deepEqual(entry, {
    id: 'dev-services',
    name: 'Dev Services',
    description: 'Configure up to 12 local HTTP/HTTPS services and see four at a glance, including listening state, port owner, expected-process mismatches, URL and folder shortcuts, and guarded process stopping on supported platforms.',
    version: '1.0.1',
    zip: 'dev-services.zip',
    server: true,
  });
  const names = new Set(new AdmZip(path.join(communityRoot, entry.zip)).getEntries().map(item => item.entryName));
  for (const name of ['app.json', 'index.html', 'style.css', 'app.js', 'service-core.js', 'polling.js', 'server.js']) {
    assert.equal(names.has('dev-services/' + name), true, name);
  }
  assert.equal(names.has('dev-services/server.test.js'), false);
});

test('settings defaults and bounded refresh choices are stable', () => {
  assert.deepEqual(core.normalizeSettings(null), { refreshSeconds: 15, services: [] });
  assert.deepEqual(core.REFRESH_OPTIONS, [10, 15, 30, 60]);
  assert.equal(core.normalizeSettings({ refreshSeconds: 1 }).refreshSeconds, 15);
  assert.equal(core.normalizeSettings({ refreshSeconds: 600 }).refreshSeconds, 15);
});

test('service defaults normalize protocol, host, port, and optional values', () => {
  const service = core.normalizeService({ id: 'angular', name: 'Angular UI' }, 0);
  assert.equal(service.protocol, 'http');
  assert.equal(service.host, 'localhost');
  assert.equal(service.port, 3000);
  assert.equal(service.path, '');
  assert.equal(service.expectedProcess, '');
  assert.equal(service.projectFolder, '');
});

test('URL construction handles paths, HTTPS, IPv6, and invalid hosts', () => {
  assert.equal(core.buildUrl({
    id: 'ui', name: 'UI', protocol: 'http', host: 'localhost', port: 4200, path: 'admin?tab=build',
  }), 'http://localhost:4200/admin?tab=build');
  assert.equal(core.buildUrl({
    id: 'api', name: 'API', protocol: 'https', host: '::1', port: 5001, path: '',
  }), 'https://[::1]:5001/');
  assert.throws(() => core.buildUrl({
    id: 'bad', name: 'Bad', protocol: 'http', host: 'localhost/other', port: 80,
  }), /valid hostname/);
});

test('state mapping distinguishes all panel states', () => {
  assert.equal(core.mapState({ listening: false }).state, 'stopped');
  assert.equal(core.mapState({ listening: false, error: 'DNS failed' }).state, 'error');
  assert.equal(core.mapState({ listening: true, owners: [] }).state, 'running');
  assert.equal(core.mapState({ listening: true, owners: [{ pid: 10 }, { pid: 11 }] }).state, 'error');
  assert.equal(core.mapState({
    listening: true,
    expectedProcess: 'node.exe',
    owners: [{ pid: 10, processName: 'python.exe' }],
  }).state, 'unexpected');
});

test('expected process comparison is case insensitive and accepts an optional exe suffix', () => {
  assert.equal(core.processMatches('NODE.EXE', 'node'), true);
  assert.equal(core.processMatches('dotnet', '/usr/bin/dotnet'), true);
  assert.equal(core.processMatches('node', 'python'), false);
  assert.equal(core.processMatches('', 'anything'), true);
});

test('configuration add, remove, and reorder operations are immutable and bounded', () => {
  const initial = core.normalizeSettings({ services: [
    { id: 'a', name: 'A', port: 3001 },
    { id: 'b', name: 'B', port: 3002 },
  ] });
  const added = core.addService(initial, { id: 'c', name: 'C', port: 3003 });
  assert.deepEqual(initial.services.map(service => service.id), ['a', 'b']);
  assert.deepEqual(added.services.map(service => service.id), ['a', 'b', 'c']);
  const moved = core.moveService(added, 'c', -1);
  assert.deepEqual(moved.services.map(service => service.id), ['a', 'c', 'b']);
  const removed = core.removeService(moved, 'c');
  assert.deepEqual(removed.services.map(service => service.id), ['a', 'b']);

  let full = core.normalizeSettings({});
  for (let index = 0; index < core.MAX_SERVICES + 3; index += 1) {
    full = core.addService(full, { id: 's' + index, name: 'S' + index, port: 4000 + index });
  }
  assert.equal(full.services.length, core.MAX_SERVICES);
});

test('polling controller has one non-overlapping loop and pauses while hidden', async () => {
  let calls = 0;
  let nextTimer = 0;
  const timers = new Map();
  const controller = new PollingController({
    task: async () => { calls += 1; },
    intervalMs: 15000,
    setTimer: callback => {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimer: id => timers.delete(id),
  });

  await controller.start();
  assert.equal(calls, 1);
  assert.equal(timers.size, 1);
  await controller.start();
  assert.equal(calls, 1);
  controller.setVisible(false);
  assert.equal(timers.size, 0);
  controller.setVisible(true);
  await controller.inFlight;
  assert.equal(calls, 2);
  assert.equal(timers.size, 1);
  controller.stop();
  assert.equal(timers.size, 0);
});

test('panel CSS keeps four equal cards and touch targets at 1920 by 480', () => {
  const css = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  assert.match(css, /\.service-page\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /button\s*\{[^}]*min-height:\s*48px/s);
  assert.match(css, /\.shell\s*\{[^}]*height:\s*100vh/s);
  assert.match(html, /id="settings-overlay"/);
  assert.match(html, /id="confirm-overlay"/);
});

test('panel and desktop editor use the shared validated settings API', () => {
  const panel = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const editor = fs.readFileSync(path.join(__dirname, '..', '..', 'app', 'config.js'), 'utf8');
  assert.match(panel, /useStoredSettings:\s*true/);
  assert.match(panel, /api\('save-settings',\s*\{ settings: draft \}\)/);
  assert.match(editor, /def\.description/);
  assert.match(editor, /def\.id === 'dev-services'\) appendDevServices\(el\)/);
  assert.match(editor, /appApiCall\('dev-services', 'settings', \{\}\)/);
  assert.match(editor, /appApiCall\('dev-services', 'save-settings', \{ settings: state \}\)/);
  assert.match(editor, /configApi\.pickFolder\(\)/);
  assert.match(editor, /esc\(String\(service\.port\)\)/);
  assert.match(editor, /does not support desktop editing/);
  assert.match(editor, /Settings → Drop-In Apps/);
});

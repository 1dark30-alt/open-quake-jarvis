'use strict';
// sysserver OBS routes: live-state read, action dispatch, same-origin gating, and the served page --
// against a fake obsApp (the shape main.js passes: getSnapshot / action / EventEmitter 'update').

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { EventEmitter } = require('events');
const sysserver = require('../app/sysserver');

function req(port, method, route, headers, bodyObj) {
  return new Promise((resolve, reject) => {
    const body = bodyObj != null ? JSON.stringify(bodyObj) : null;
    const r = http.request({
      host: '127.0.0.1', port, path: route, method,
      headers: Object.assign({ Host: '127.0.0.1:' + port },
        body ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } : {}, headers || {}),
    }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => { const t = Buffer.concat(chunks).toString('utf8'); let b = null; try { b = t ? JSON.parse(t) : null; } catch (e) {} resolve({ status: res.statusCode, headers: res.headers, text: t, body: b }); });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}
const SAME = { 'Sec-Fetch-Site': 'same-origin' };

function fakeObsApp() {
  const e = new EventEmitter();
  e.snapshot = { connection: 'connected', programScene: 'Camera', scenes: ['Camera', 'Game'] };
  e.getSnapshot = () => e.snapshot;
  e.calls = [];
  e.action = async (name, value) => { e.calls.push({ name, value }); return { done: name, value }; };
  return e;
}

test.afterEach(() => sysserver.stop());

test('GET /api/obs/state returns the live snapshot to a same-origin page', async () => {
  const port = await sysserver.start({ obsApp: fakeObsApp() });
  const r = await req(port, 'GET', '/api/obs/state', SAME);
  assert.equal(r.status, 200);
  assert.equal(r.body.programScene, 'Camera');
  assert.deepEqual(r.body.scenes, ['Camera', 'Game']);
});

test('cross-site cannot read OBS state or POST OBS actions', async () => {
  const obs = fakeObsApp();
  const port = await sysserver.start({ obsApp: obs });
  const state = await req(port, 'GET', '/api/obs/state', { 'Sec-Fetch-Site': 'cross-site' });
  assert.equal(state.status, 403);
  const act = await req(port, 'POST', '/api/obs/action', { 'Sec-Fetch-Site': 'cross-site' }, { action: 'startStream' });
  assert.equal(act.status, 403);
  assert.equal(obs.calls.length, 0);   // action never dispatched
});

test('POST /api/obs/action dispatches to the service and returns its result', async () => {
  const obs = fakeObsApp();
  const port = await sysserver.start({ obsApp: obs });
  const r = await req(port, 'POST', '/api/obs/action', SAME, { action: 'sceneTap', value: 'Game' });
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
  assert.deepEqual(obs.calls, [{ name: 'sceneTap', value: 'Game' }]);
});

test('the served /obs page is delivered', async () => {
  const port = await sysserver.start({ obsApp: fakeObsApp() });
  const r = await req(port, 'GET', '/obs', SAME);
  assert.equal(r.status, 200);
  assert.match(r.text, /obsview\.js/);   // links its out-of-line script (CSP-safe)
});

test('with no obsApp wired, state is a calm disconnected snapshot (not a 500)', async () => {
  const port = await sysserver.start({});
  const r = await req(port, 'GET', '/api/obs/state', SAME);
  assert.equal(r.status, 200);
  assert.equal(r.body.connection, 'disconnected');
});

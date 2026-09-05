'use strict';
// The local server reuses a remembered port across restarts so served-app pages keep the same origin
// (per-origin localStorage -- drop-in saves, high scores, settings -- survives). It falls back to an
// OS-assigned port only when the remembered one is taken.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const sysserver = require('../app/sysserver');

function freePort() {
  return new Promise(res => { const s = http.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
}

test('server binds the preferred port, and falls back when it is taken', async () => {
  const want = await freePort();

  // free preferred port -> bound exactly, so the origin is stable across restarts
  const p1 = await sysserver.start({ preferredPort: want });
  assert.equal(p1, want);
  await sysserver.stop();

  // preferred port taken -> fall back to a different working port rather than failing to start
  const blocker = http.createServer(() => {});
  await new Promise(r => blocker.listen(want, '127.0.0.1', r));
  const p2 = await sysserver.start({ preferredPort: want });
  assert.notEqual(p2, want);
  assert.ok(p2 > 0);
  await sysserver.stop();
  await new Promise(r => blocker.close(r));

  // no preferred port -> ephemeral, unchanged behaviour
  const p3 = await sysserver.start({});
  assert.ok(p3 > 0);
  await sysserver.stop();
});

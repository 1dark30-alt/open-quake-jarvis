'use strict';
// /app-host/pick-folder: host-mediated folder picker for served drop-ins that declare the
// 'pick-folder' hostCapability. Pins the whole contract: explicit opt-in, same-origin + referer
// gating, bounded/validated body, single-flight + per-app cooldown, sanitized failures (no path
// leaks), and stop() clearing all picker state. The dialog is injected — no native UI ever opens.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sysserver = require('../app/sysserver');

function req(port, method, route, headers, body) {
  return new Promise((resolve, reject) => {
    const r = http.request({
      host: '127.0.0.1', port, path: route, method,
      headers: Object.assign({ Host: '127.0.0.1:' + port },
        body ? { 'Content-Length': Buffer.byteLength(body), 'Content-Type': 'application/json' } : {}, headers || {}),
    }, res => {
      const chunks = []; res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const t = Buffer.concat(chunks).toString('utf8');
        let b = null; try { b = t ? JSON.parse(t) : null; } catch (e) {}
        resolve({ status: res.statusCode, text: t, body: b });
      });
    });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function makeApp(id) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oq-pickfolder-'));
  fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify({ id, name: id, entry: 'index.html', served: true }));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><title>' + id + '</title>');
  return dir;
}

function ref(port, id) {
  return { Referer: 'http://127.0.0.1:' + port + '/apps/' + id + '/index.html', 'Sec-Fetch-Site': 'same-origin' };
}

// picker (has the capability) + plain (does not) — capability must not cross between them.
function startWith(picker, opts) {
  const dirs = { picker: makeApp('picker'), plain: makeApp('plain') };
  return sysserver.start(Object.assign({
    appFolders: {
      picker: { root: dirs.picker, hostCapabilities: ['pick-folder'] },
      plain: { root: dirs.plain, hostCapabilities: [] },
    },
    onPickAppFolder: picker,
  }, opts || {})).then(port => ({ port, dirs }));
}

async function cleanup(dirs) {
  await sysserver.stop();
  Object.values(dirs).forEach(d => fs.rmSync(d, { recursive: true, force: true }));
}

test('opted-in app selects a folder; defaultPath reaches the callback', async () => {
  const calls = [];
  const { port, dirs } = await startWith(async args => { calls.push(args); return { ok: true, path: 'D:\\Chosen\\Folder' }; });
  try {
    const r = await req(port, 'POST', '/app-host/pick-folder', ref(port, 'picker'), JSON.stringify({ defaultPath: 'D:\\Start\\Here' }));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: true, path: 'D:\\Chosen\\Folder' });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].appId, 'picker');
    assert.equal(calls[0].defaultPath, 'D:\\Start\\Here');
  } finally { await cleanup(dirs); }
});

test('cancellation returns 200 {ok:false,canceled:true}', async () => {
  const { port, dirs } = await startWith(async () => ({ ok: false, canceled: true }));
  try {
    const r = await req(port, 'POST', '/app-host/pick-folder', ref(port, 'picker'), '{}');
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { ok: false, canceled: true });
  } finally { await cleanup(dirs); }
});

test('defaultPath validation: relative is omitted; oversized and non-string are rejected', async () => {
  const calls = [];
  let now = 1000000;   // injected clock: hop past the per-app cooldown between picks
  const { port, dirs } = await startWith(async args => { calls.push(args); return { ok: false, canceled: true }; }, { now: () => now });
  try {
    // relative → forwarded WITHOUT a defaultPath (never resolved against the host cwd)
    const rel = await req(port, 'POST', '/app-host/pick-folder', ref(port, 'picker'), JSON.stringify({ defaultPath: '..\\..\\up' }));
    assert.equal(rel.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].defaultPath, undefined);
    // UNC is accepted as absolute
    now += 5000;
    const unc = await req(port, 'POST', '/app-host/pick-folder', ref(port, 'picker'), JSON.stringify({ defaultPath: '\\\\server\\share' }));
    assert.equal(unc.status, 200);
    assert.equal(calls[1].defaultPath, '\\\\server\\share');
    now += 5000;
    // oversized string → 400, callback untouched
    const big = await req(port, 'POST', '/app-host/pick-folder', ref(port, 'picker'), JSON.stringify({ defaultPath: 'C:\\' + 'a'.repeat(5000) }));
    assert.equal(big.status, 400);
    // non-string → 400
    const num = await req(port, 'POST', '/app-host/pick-folder', ref(port, 'picker'), JSON.stringify({ defaultPath: 42 }));
    assert.equal(num.status, 400);
    // malformed JSON → 400
    const bad = await req(port, 'POST', '/app-host/pick-folder', ref(port, 'picker'), '{nope');
    assert.equal(bad.status, 400);
    assert.equal(calls.length, 2);
  } finally { await cleanup(dirs); }
});

test('capability gating: undeclared app, forged referer, and cross-site are all rejected before the dialog', async () => {
  let called = 0;
  const { port, dirs } = await startWith(async () => { called++; return { ok: true, path: 'D:\\X' }; });
  try {
    // installed app without the capability (also proves capabilities do not cross between apps)
    const plain = await req(port, 'POST', '/app-host/pick-folder', ref(port, 'plain'), '{}');
    assert.equal(plain.status, 403);
    assert.equal(plain.body.code, 'forbidden');
    // unregistered / forged referer
    const forged = await req(port, 'POST', '/app-host/pick-folder',
      { Referer: 'http://127.0.0.1:' + port + '/apps/nosuch/index.html', 'Sec-Fetch-Site': 'same-origin' }, '{}');
    assert.equal(forged.status, 403);
    // cross-site request: rejected by the same-origin gate
    const cross = await req(port, 'POST', '/app-host/pick-folder',
      { Referer: 'http://127.0.0.1:' + port + '/apps/picker/index.html', 'Sec-Fetch-Site': 'cross-site' }, '{}');
    assert.equal(cross.status, 403);
    assert.equal(called, 0);
  } finally { await cleanup(dirs); }
});

test('GET receives 405; missing host callback produces 503 unavailable', async () => {
  const { port, dirs } = await startWith(undefined, { onPickAppFolder: undefined });
  try {
    const get = await req(port, 'GET', '/app-host/pick-folder', ref(port, 'picker'));
    assert.equal(get.status, 405);
    const post = await req(port, 'POST', '/app-host/pick-folder', ref(port, 'picker'), '{}');
    assert.equal(post.status, 503);
    assert.equal(post.body.code, 'unavailable');
  } finally { await cleanup(dirs); }
});

test('single-flight: a second request while the dialog is open gets a stable 409 busy', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const { port, dirs } = await startWith(async () => { await gate; return { ok: false, canceled: true }; });
  try {
    const first = req(port, 'POST', '/app-host/pick-folder', ref(port, 'picker'), '{}');
    await new Promise(r => setTimeout(r, 50));   // let the first request reach the callback
    const second = await req(port, 'POST', '/app-host/pick-folder', ref(port, 'picker'), '{}');
    assert.equal(second.status, 409);
    assert.deepEqual(second.body, { ok: false, code: 'busy', error: 'A folder picker is already open' });
    release();
    assert.equal((await first).status, 200);
  } finally { await cleanup(dirs); }
});

test('per-app cooldown after close; expires with time; stop() clears picker state', async () => {
  let now = 1000000;
  const { port, dirs } = await startWith(async () => ({ ok: false, canceled: true }), { now: () => now });
  try {
    const first = await req(port, 'POST', '/app-host/pick-folder', ref(port, 'picker'), '{}');
    assert.equal(first.status, 200);
    // immediately again → cooldown busy
    const again = await req(port, 'POST', '/app-host/pick-folder', ref(port, 'picker'), '{}');
    assert.equal(again.status, 409);
    // after the cooldown window it works again
    now += 5000;
    const later = await req(port, 'POST', '/app-host/pick-folder', ref(port, 'picker'), '{}');
    assert.equal(later.status, 200);
  } finally { await cleanup(dirs); }
  // restart with frozen time inside the cooldown window: stop() must have cleared it
  let now2 = 1000000;
  const second = await startWith(async () => ({ ok: false, canceled: true }), { now: () => now2 });
  try {
    const fresh = await req(second.port, 'POST', '/app-host/pick-folder', ref(second.port, 'picker'), '{}');
    assert.equal(fresh.status, 200);
  } finally { await cleanup(second.dirs); }
});

test('callback exceptions and junk results are sanitized — no path reaches the page', async () => {
  const { port, dirs } = await startWith(async () => { throw new Error('EPERM: open D:\\Secret\\Vault'); });
  try {
    const r = await req(port, 'POST', '/app-host/pick-folder', ref(port, 'picker'), '{}');
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'unavailable');
    assert.ok(!r.text.includes('Secret'), 'error text must not leak paths');
  } finally { await cleanup(dirs); }
  const junk = await startWith(async () => ({ something: 'else' }));
  try {
    const r = await req(junk.port, 'POST', '/app-host/pick-folder', ref(junk.port, 'picker'), '{}');
    assert.equal(r.status, 503);
    assert.equal(r.body.code, 'unavailable');
  } finally { await cleanup(junk.dirs); }
});

test('unknown capability names grant nothing', async () => {
  // Discovery in main.js filters to KNOWN_HOST_CAPABILITIES; even if an unrecognized name reached
  // the folder map, the route only honors the exact 'pick-folder' string.
  const dir = makeApp('weird');
  const port = await sysserver.start({
    appFolders: { weird: { root: dir, hostCapabilities: ['launch-nukes', 'pick-folder-2'] } },
    onPickAppFolder: async () => ({ ok: true, path: 'D:\\X' }),
  });
  try {
    const r = await req(port, 'POST', '/app-host/pick-folder',
      { Referer: 'http://127.0.0.1:' + port + '/apps/weird/index.html', 'Sec-Fetch-Site': 'same-origin' }, '{}');
    assert.equal(r.status, 403);
  } finally {
    await sysserver.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

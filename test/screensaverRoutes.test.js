'use strict';
// Screensaver media surface: name->path containment (pure), the /screensaver/media Range route,
// the /state media listing, and the generic /projects folder browse — through the REAL server and
// the REAL host, with fake deps pointing mediaDir at a temp fixture folder. Own process, like
// meetingRoutes.test.js, so sysserver.start() options don't leak into other suites.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const sysserver = require('../app/sysserver');
const { createScreensaverHost, resolveMediaPath, listMedia } = require('../app/screensaver-host');

let port, mediaDir, defaultDir;
let active = true;            // deps gate: is the screensaver page the active page?
const grid = { kind: 'app', app: 'screensaver', options: {} };
let saves = 0;

test.before(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-saver-'));
  mediaDir = path.join(root, 'media'); fs.mkdirSync(mediaDir);
  defaultDir = path.join(root, 'default-media');   // NOT pre-created — the host must mkdir it
  fs.writeFileSync(path.join(mediaDir, 'a.png'), Buffer.from('0123456789'));   // 10 bytes
  fs.writeFileSync(path.join(mediaDir, 'clip.mp4'), Buffer.from('MP4DATA'));
  fs.writeFileSync(path.join(mediaDir, 'notes.txt'), 'not media');
  const host = createScreensaverHost({
    deps: {
      activeServedAppConfig: () => (active ? { app: 'screensaver', options: grid.options } : null),
      activeGrid: () => (active ? grid : { kind: 'web' }),
      getConfig: () => ({}),
      saveConfig: () => { saves++; },
      getDocumentsPath: () => root,
    },
    defaultMediaDir: defaultDir,
  });
  grid.options.mediaDir = mediaDir;
  port = await sysserver.start({ voiceApps: { screensaver: { handlers: host.handlers } } });
});
test.after(() => sysserver.stop());

const base = () => 'http://127.0.0.1:' + port;
const pageFetch = (p, opts = {}) =>
  fetch(base() + p, Object.assign({}, opts, { headers: Object.assign({ 'sec-fetch-site': 'same-origin' }, opts.headers || {}) }));

// ---- pure containment matrix (no HTTP) ----

test('resolveMediaPath rejects everything but a plain allowlisted name in the folder', () => {
  assert.equal(resolveMediaPath(mediaDir, 'a.png'), path.join(mediaDir, 'a.png'));
  for (const bad of ['../a.png', '..\\a.png', 'sub/a.png', 'sub\\a.png', 'C:\\x\\a.png', 'C:evil.png',
    'file:a.png', '..', '', 'a.txt', 'a', 'a.png.exe']) {
    assert.equal(resolveMediaPath(mediaDir, bad), null, JSON.stringify(bad));
  }
  assert.equal(resolveMediaPath('', 'a.png'), null);
  assert.equal(resolveMediaPath(null, 'a.png'), null);
});

test('listMedia lists only allowlisted files, sorted, with kinds; missing folder is empty', () => {
  assert.deepEqual(listMedia(mediaDir), [{ name: 'a.png', kind: 'image' }, { name: 'clip.mp4', kind: 'video' }]);
  assert.deepEqual(listMedia(path.join(mediaDir, 'nope')), []);
});

// ---- the HTTP surface ----

test('media route serves a file with the right type and Accept-Ranges', async () => {
  const r = await pageFetch('/screensaver/media?f=a.png');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /image\/png/);
  assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal(await r.text(), '0123456789');
  const v = await pageFetch('/screensaver/media?f=clip.mp4');
  assert.match(v.headers.get('content-type'), /video\/mp4/);
});

test('media route honors single byte ranges (206/416)', async () => {
  const r = await pageFetch('/screensaver/media?f=a.png', { headers: { Range: 'bytes=2-5' } });
  assert.equal(r.status, 206);
  assert.equal(r.headers.get('content-range'), 'bytes 2-5/10');
  assert.equal(await r.text(), '2345');
  const open = await pageFetch('/screensaver/media?f=a.png', { headers: { Range: 'bytes=7-' } });
  assert.equal(open.status, 206);
  assert.equal(await open.text(), '789');
  const out = await pageFetch('/screensaver/media?f=a.png', { headers: { Range: 'bytes=99-' } });
  assert.equal(out.status, 416);
});

test('media route 404s traversal, disallowed extensions, missing files, and an inactive page', async () => {
  for (const f of ['..%2Fa.png', '..%5Ca.png', 'sub%2Fa.png', 'C%3A%5Ca.png', 'notes.txt', 'missing.png', '']) {
    const r = await pageFetch('/screensaver/media?f=' + f);
    assert.equal(r.status, 404, JSON.stringify(f));
  }
  active = false;
  try {
    const r = await pageFetch('/screensaver/media?f=a.png');
    assert.equal(r.status, 404);   // page not active -> host resolves null (also kills stray post-wake requests)
  } finally { active = true; }
});

test('media route fails closed without same-origin evidence; POST hits the wall', async () => {
  const cross = await fetch(base() + '/screensaver/media?f=a.png', { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(cross.status, 403);
  const post = await pageFetch('/screensaver/media?f=a.png', { method: 'POST' });
  assert.equal(post.status, 405);
});

test('foreign Host header rejected (DNS-rebinding gate)', async () => {
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: '/screensaver/media?f=a.png', headers: { Host: 'evil.example' } }, res => {
      res.resume(); res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
  assert.equal(status, 403);
});

test('/state lists the media and the folder; custom-vs-default is reported', async () => {
  const r = await pageFetch('/screensaver/state');
  const s = await r.json();
  assert.equal(s.ok, true);
  assert.deepEqual(s.files, [{ name: 'a.png', kind: 'image' }, { name: 'clip.mp4', kind: 'video' }]);
  assert.equal(s.mediaDir, mediaDir);
  assert.equal(s.usingDefault, false);
});

test('blank mediaDir falls back to the default folder and auto-creates it', async () => {
  grid.options.mediaDir = '';
  try {
    const s = await (await pageFetch('/screensaver/state')).json();
    assert.equal(s.mediaDir, defaultDir);
    assert.equal(s.usingDefault, true);
    assert.deepEqual(s.files, []);
    assert.equal(fs.existsSync(defaultDir), true);   // mkdir'd on demand
  } finally { grid.options.mediaDir = mediaDir; }
});

test('/projects browse is generic: reaches this host, lists directories, no recents', async () => {
  const s = await (await pageFetch('/screensaver/projects?path=' + encodeURIComponent(path.dirname(mediaDir)))).json();
  assert.equal(s.root, path.dirname(mediaDir));
  assert.ok(s.dirs.includes(mediaDir));
  assert.equal(s.current, mediaDir);
  assert.deepEqual(s.recents, []);
});

test('/option validates and persists panel-tunable keys', async () => {
  const post = (key, value) => pageFetch('/screensaver/option', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key, value }),
  });
  const before = saves;
  assert.equal((await (await post('imageFit', 'contain')).json()).ok, true);
  assert.equal(grid.options.imageFit, 'contain');
  assert.equal((await (await post('imageFit', 'stretch')).json()).ok, false);   // rejected value
  assert.equal((await (await post('fillMode', 'contain')).json()).ok, false);   // retired key
  assert.equal((await (await post('nope', 'x')).json()).ok, false);             // unknown key
  assert.equal((await post('idleMinutes', '0')).status, 200);                   // 0 = never is storable
  assert.equal(grid.options.idleMinutes, '0');
  assert.ok(saves > before);
  grid.options.idleMinutes = '10'; grid.options.imageFit = 'cover';
});

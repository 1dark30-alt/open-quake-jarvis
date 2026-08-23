'use strict';
// deck-host protocol host, exercised end-to-end against a SCRIPTED FAKE PLUGIN: a real child process
// that speaks Elgato's registration handshake over the host's WebSocket, receives willAppear/keyDown,
// and answers with setTitle/setImage — the full loop, no Elgato code involved.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'deckhost-'));
const PLUGDIR = path.join(TMP, 'com.test.fake.sdPlugin');
fs.mkdirSync(PLUGDIR, { recursive: true });

// The fake plugin: connects with the args the host passes, registers, reacts to events.
fs.writeFileSync(path.join(PLUGDIR, 'plugin.js'), `
'use strict';
const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i]] = process.argv[i + 1];
const WebSocket = require(${JSON.stringify(require.resolve('ws'))});
const ws = new WebSocket('ws://127.0.0.1:' + args['-port']);
ws.on('open', () => ws.send(JSON.stringify({ event: args['-registerEvent'], uuid: args['-pluginUUID'] })));
ws.on('message', raw => {
  const m = JSON.parse(raw.toString());
  if (m.event === 'willAppear') {
    ws.send(JSON.stringify({ event: 'setTitle', context: m.context, payload: { title: 'READY r' + m.payload.coordinates.row } }));
    ws.send(JSON.stringify({ event: 'setImage', context: m.context, payload: { image: 'data:image/png;base64,AAA=' } }));
  }
  if (m.event === 'keyDown') {
    ws.send(JSON.stringify({ event: 'setTitle', context: m.context, payload: { title: 'PRESSED' } }));
    ws.send(JSON.stringify({ event: 'showOk', context: m.context }));
    ws.send(JSON.stringify({ event: 'setSettings', context: m.context, payload: { presses: 1 } }));
  }
  if (m.event === 'didReceiveSettings') {
    ws.send(JSON.stringify({ event: 'setTitle', context: m.context, payload: { title: 'GOT ' + JSON.stringify(m.payload.settings) } }));
  }
});
setInterval(() => {}, 1000);   // stay alive
`);
fs.writeFileSync(path.join(PLUGDIR, 'manifest.json'), JSON.stringify({
  Name: 'Fake Plugin', Version: '1.0', CodePath: 'plugin.js',
  OS: [{ Platform: 'windows', MinimumVersion: '10' }],
  Actions: [
    { UUID: 'com.test.fake.hello', Name: 'Hello Key', Icon: 'icon', States: [{ Image: 'icon' }], Controllers: ['Keypad'] },
    { UUID: 'com.test.fake.dial', Name: 'Dial Only', Controllers: ['Encoder'] },
  ],
}));
fs.writeFileSync(path.join(PLUGDIR, 'icon.png'), Buffer.from('89504e470d0a1a0a', 'hex'));

const server = require('../community-apps/deck-host/server.js');
test.after(() => { server._shutdown(); });   // kill the fake plugin + close the WSS so the runner can exit
const OPTS = { pluginsDir: TMP, layout: '5x3' };
const call = (action, { query, body } = {}) => server.handle(action, { appId: 'deck-host', query: query || {}, options: OPTS, body: body ? Buffer.from(JSON.stringify(body)) : null });
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 120)); } };

test('scans, spawns, and registers the fake plugin (Encoder-only actions filtered out)', async () => {
  const s = await until(async () => { const x = await call('state'); return x.plugins.length && x.plugins[0].status === 'running' ? x : null; });
  assert.equal(s.plugins[0].id, 'com.test.fake');
  assert.deepEqual(s.plugins[0].actions.map(a => a.uuid), ['com.test.fake.hello']);   // Keypad only
  assert.deepEqual(s.layout, { columns: 5, rows: 3 });
});

test('assign -> willAppear -> plugin renders the key (setTitle + setImage)', async () => {
  const r = await call('assign', { body: { col: 1, row: 2, action: 'com.test.fake.hello', plugin: 'com.test.fake' } });
  assert.equal(r.ok, true);
  const s = await until(async () => { const x = await call('state'); const k = x.keys['1,2']; return k && k.title.startsWith('READY') ? x : null; });
  assert.equal(s.keys['1,2'].title, 'READY r2');                        // coordinates flowed through
  assert.equal(s.keys['1,2'].image, 'data:image/png;base64,AAA=');      // setImage landed
});

test('press -> keyDown -> setTitle/showOk/setSettings -> didReceiveSettings echo', async () => {
  const s0 = await call('state');
  const ctx = s0.keys['1,2'].context;
  assert.equal((await call('press', { body: { context: ctx } })).ok, true);
  assert.equal((await call('release', { body: { context: ctx } })).ok, true);
  const s = await until(async () => { const x = await call('state'); const k = x.keys['1,2']; return k && k.title.indexOf('GOT') === 0 ? x : null; });
  assert.match(s.keys['1,2'].title, /GOT \{"presses":1\}/);   // setSettings persisted + echoed back as didReceiveSettings
  assert.ok(s.keys['1,2'].ok > 0);                            // showOk flag
  assert.deepEqual(s.keys['1,2'].settings, { presses: 1 });
});

test('long-poll parks until a change and resolves on bump', async () => {
  const s0 = await call('state');
  const t0 = Date.now();
  const parked = call('state', { query: { since: String(s0.v) } });
  await new Promise(r => setTimeout(r, 300));
  await call('profile-add', { body: { name: 'Second' } });    // triggers bump()
  const s = await parked;
  assert.ok(s.v > s0.v);
  assert.ok(Date.now() - t0 < 5000, 'resolved by the bump, not the timeout');
  assert.equal(s.profiles.length, 2);
});

test('profile switching sends willDisappear/willAppear and isolates keys per profile', async () => {
  const s0 = await call('state');
  const second = s0.profiles.find(p => p.name === 'Second');
  await call('profile-select', { body: { id: second.id } });
  const s1 = await call('state');
  assert.deepEqual(s1.keys, {});                               // new profile is empty
  await call('profile-select', { body: { id: s0.profiles[0].id } });
  const s2 = await until(async () => { const x = await call('state'); return x.keys['1,2'] ? x : null; });
  assert.ok(s2.keys['1,2'].title.length);                      // key came back (willAppear re-fired)
});

test('asset serving resolves extensionless Elgato image refs and blocks traversal', async () => {
  const a = await call('asset', { query: { plugin: 'com.test.fake', path: 'icon' } });
  assert.equal(a.ok, true);
  assert.equal(a.mime, 'image/png');
  assert.equal((await call('asset', { query: { plugin: 'com.test.fake', path: '../../deck-host.json' } })).ok, false);
  assert.equal((await call('asset', { query: { plugin: 'nope', path: 'icon' } })).ok, false);
});

test('unassign removes the key and its state', async () => {
  await call('unassign', { body: { col: 1, row: 2 } });
  const s = await call('state');
  assert.equal(s.keys['1,2'], undefined);
});

test('deck persists to deck-host.json beside the plugins folder', () => {
  const saved = JSON.parse(fs.readFileSync(path.join(TMP, 'deck-host.json'), 'utf8'));
  assert.equal(saved.profiles.length, 2);
});

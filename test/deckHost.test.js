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
const OPTS = { pluginsDir: TMP, rows: '3' };
const call = (action, { query, body } = {}) => server.handle(action, { appId: 'deck-host', query: query || {}, options: OPTS, body: body ? Buffer.from(JSON.stringify(body)) : null });
const until = async (fn, ms = 8000) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise(r => setTimeout(r, 120)); } };

test('scans, spawns, and registers the fake plugin (Encoder-only actions filtered out)', async () => {
  const s = await until(async () => { const x = await call('state'); return x.plugins.length && x.plugins[0].status === 'running' ? x : null; });
  assert.equal(s.plugins[0].id, 'com.test.fake');
  assert.deepEqual(s.plugins[0].actions.map(a => a.uuid), ['com.test.fake.hello']);   // Keypad only
  assert.equal(s.layout.rows, 3);                                        // rows = the form-factor option
  assert.ok(s.layout.columns >= 1 && s.layout.columns <= 16);            // columns derived from the reported/estimated width
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

test('.streamDeckPlugin packages auto-extract (plain), encrypted ones are skipped, extensionless CodePath resolves', async () => {
  const AdmZip = require('adm-zip');
  const TMP2 = fs.mkdtempSync(path.join(os.tmpdir(), 'deckhost2-'));

  // (a) plain package wrapping the fake plugin -> should extract + run
  const zip = new AdmZip();
  zip.addLocalFolder(PLUGDIR, 'com.test.packaged.sdPlugin');
  const packed = JSON.parse(fs.readFileSync(path.join(PLUGDIR, 'manifest.json'), 'utf8'));
  zip.updateFile('com.test.packaged.sdPlugin/manifest.json', Buffer.from(JSON.stringify(Object.assign({}, packed, { Name: 'Packaged Fake' }))));
  zip.writeZip(path.join(TMP2, 'packaged.streamDeckPlugin'));

  // (b) "encrypted" marketplace-style package -> skipped with a clear reason
  const enc = new AdmZip();
  enc.addFile('com.evil.enc.sdPlugin/manifest.json', Buffer.concat([Buffer.from('ELGATO\x01\x00'), Buffer.from([0xfd, 0x04])]));
  enc.writeZip(path.join(TMP2, 'encrypted.streamDeckPlugin'));

  // (c) extensionless CodePath: folder with CodePath "stub" + stub.exe present -> resolves (not 'unsupported')
  const stubDir = path.join(TMP2, 'com.test.stub.sdPlugin');
  fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'manifest.json'), JSON.stringify({ Name: 'Stub', Version: '1.0', CodePath: 'stub',
    OS: [{ Platform: 'windows', MinimumVersion: '10' }], Actions: [{ UUID: 'com.test.stub.a', Name: 'A', Controllers: ['Keypad'] }] }));
  fs.writeFileSync(path.join(stubDir, 'stub.exe'), 'not a real exe');

  const call2 = (action, extra) => server.handle(action, Object.assign({ appId: 'deck-host', query: {}, options: { pluginsDir: TMP2, rows: '3' } }, extra));
  const s = await until(async () => {
    const x = await call2('state');
    const pk = x.plugins.find(p => p.id === 'com.test.packaged');
    return pk && pk.status === 'running' ? x : null;
  });
  assert.ok(fs.existsSync(path.join(TMP2, 'com.test.packaged.sdPlugin', 'manifest.json')));   // auto-extracted
  assert.equal(s.skipped.length, 1);
  assert.match(s.skipped[0].reason, /encrypted/i);                                            // marketplace package surfaced, not run
  const stub = s.plugins.find(p => p.id === 'com.test.stub');
  assert.notEqual(stub.status, 'unsupported');                                                // "stub" resolved to stub.exe
});

// ---- Stream Deck profile import ---------------------------------------------------------------

test('page-dir encoding matches real Elgato exports (base32hex, U skipped, Z suffix)', () => {
  // pairs read from real .streamDeckProfile files (Hue Controller root page; Teams folder page)
  assert.equal(server._uuidToPageDir('ce6e6c52-2022-4176-a983-89d3115c7ef1'), 'PPN6OKH0490NDAC3H79H2N3VV4Z');
  assert.equal(server._uuidToPageDir('19266f55-a561-4471-ad18-d84bc5c036f6'), '34J6VLD5C5273B8OR15SBG1MVOZ');
  assert.equal(server._uuidToPageDir('nonsense'), '');
});

test('imports a .streamDeckProfile: built-ins, images, reflow, folders, plugin refs', async () => {
  const AdmZip = require('adm-zip');
  const TMP3 = fs.mkdtempSync(path.join(os.tmpdir(), 'deckhost3-'));
  const call3 = (action, extra) => server.handle(action, Object.assign({ appId: 'deck-host', query: {}, options: { pluginsDir: TMP3, rows: '3' } }, extra));

  const rootUuid = 'ce6e6c52-2022-4176-a983-89d3115c7ef1';
  const childUuid = '19266f55-a561-4471-ad18-d84bc5c036f6';
  const rootDir = 'Test.sdProfile/Profiles/' + server._uuidToPageDir(rootUuid);
  const childDir = 'Test.sdProfile/Profiles/' + server._uuidToPageDir(childUuid);
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const hk = (vk, mods) => ({ UUID: 'com.elgato.streamdeck.system.hotkey', State: 0,
    Settings: { Hotkeys: [Object.assign({ VKeyCode: vk, KeyCtrl: false, KeyShift: false, KeyOption: false, KeyCmd: false }, mods),
      { VKeyCode: -1, QTKeyCode: 33554431 }] },   // trailing unset entries, like real exports
    States: [{ Title: 'HK', Image: 'Images/k.png' }] });
  const zip = new AdmZip();
  zip.addFile('Test.sdProfile/manifest.json', Buffer.from(JSON.stringify({
    Name: 'TestProf', Version: '2.0', Device: { Model: '20GAA9902' },
    Pages: { Current: rootUuid, Pages: [rootUuid] } })));
  zip.addFile(rootDir + '/manifest.json', Buffer.from(JSON.stringify({ Controllers: [{ Type: 'Keypad', Actions: {
    '0,0': hk(67, { KeyCtrl: true }),
    '1,0': { UUID: 'com.elgato.streamdeck.system.text', Settings: { pastedText: 'hello', isTypingMode: true, isSendingEnter: false }, States: [{ Title: 'Txt' }] },
    '2,0': { UUID: 'com.elgato.streamdeck.profile.openchild', Settings: { ProfileUUID: childUuid }, States: [{ Title: 'More' }] },
    '0,3': hk(65, {}),   // row 3 on a 3-row target -> reflows right (srcCols=3 -> col 3, row 0)
  } }] })));
  zip.addFile(rootDir + '/Images/k.png', png);
  zip.addFile(childDir + '/manifest.json', Buffer.from(JSON.stringify({ Controllers: [{ Type: 'Keypad', Actions: {
    '0,0': { UUID: 'com.elgato.streamdeck.profile.backtoparent', Settings: {}, States: [{}] },
    '1,0': { UUID: 'com.notinstalled.thing.act', Settings: { a: 1 }, States: [{ Title: 'Plug' }] },
  } }] })));
  fs.writeFileSync(path.join(TMP3, 'TestProf.streamDeckProfile'), zip.toBuffer());

  const sent = [];
  server._setKeyHelper(m => { sent.push(m); return 'ok'; });
  try {
    let s = await call3('state');
    assert.equal(s.importables.length, 1);
    const imp = await call3('import', { body: Buffer.from(JSON.stringify({ id: s.importables[0].id })) });
    assert.equal(imp.ok, true);
    assert.equal(imp.profiles, 2);
    assert.equal(imp.keys, 6);
    assert.equal(imp.dropped, 0);

    s = await call3('state');
    const main = s.profiles.find(p => p.name === 'TestProf');
    assert.ok(main && !main.child);
    assert.ok(s.profiles.find(p => p.name === 'TestProf › 2' && p.child));
    assert.equal(s.activeProfile, main.id);                                       // import switches to the imported profile
    assert.equal(s.keys['0,0'].builtin, 'hotkey');
    assert.match(s.keys['0,0'].image, /^data:image\/png;base64,/);                // key face came from the profile
    assert.equal(s.keys['0,0'].title, 'HK');
    assert.equal(s.keys['3,0'].builtin, 'hotkey');                                // '0,3' reflowed to '3,0'

    // hotkey press goes to the key helper as a combo (trailing unset entries filtered out)
    await call3('press', { body: Buffer.from(JSON.stringify({ context: s.keys['0,0'].context })) });
    assert.deepEqual(sent.pop(), { combo: [{ vk: 67, ctrl: true, shift: false, alt: false, win: false }] });
    // typing-mode text goes out as unicode text
    await call3('press', { body: Buffer.from(JSON.stringify({ context: s.keys['1,0'].context })) });
    assert.deepEqual(sent.pop(), { text: 'hello' });

    // folder key enters the child page; its Back key returns; its plugin key is honest about the gap
    await call3('press', { body: Buffer.from(JSON.stringify({ context: s.keys['2,0'].context })) });
    let s2 = await call3('state');
    assert.notEqual(s2.activeProfile, main.id);
    assert.equal(s2.keys['1,0'].plugin, 'com.notinstalled.thing');
    const miss = await call3('press', { body: Buffer.from(JSON.stringify({ context: s2.keys['1,0'].context })) });
    assert.equal(miss.ok, false);
    assert.match(miss.error, /needs the com\.notinstalled\.thing plugin/);
    await call3('press', { body: Buffer.from(JSON.stringify({ context: s2.keys['0,0'].context })) });
    s2 = await call3('state');
    assert.equal(s2.activeProfile, main.id);

    // importing again replaces, not duplicates
    await call3('import', { body: Buffer.from(JSON.stringify({ id: s.importables[0].id })) });
    s2 = await call3('state');
    assert.equal(s2.profiles.filter(p => p.name.startsWith('TestProf')).length, 2);
  } finally { server._setKeyHelper(null); }
});

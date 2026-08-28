'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const server = require('./server');

const tempRoots = [];

function tempDir() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'open-quake-photo-strip-'));
  tempRoots.push(root);
  return root;
}

function write(root, relative, content) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content || Buffer.from([1, 2, 3]));
  return file;
}

test.beforeEach(() => server._test.resetCache());
test.after(() => {
  for (const root of tempRoots) {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

test('supported file filtering accepts browser-safe photo formats only', () => {
  ['photo.jpg', 'PHOTO.JPEG', 'image.png', 'still.webp', 'loop.gif'].forEach(name => assert.equal(server._test.supportedImage(name), true, name));
  ['vector.svg', 'bitmap.bmp', 'movie.mp4', 'script.js', 'photo.jpg.exe', ''].forEach(name => assert.equal(server._test.supportedImage(name), false, name));
});

test('folder list settings trim blanks and deduplicate selected folders', () => {
  const root = tempDir();
  const duplicate = process.platform === 'win32' ? root.toUpperCase() : root;
  assert.deepEqual(server._test.configuredFolders({
    folder1: `  ${root}  `,
    folder2: '',
    folder3: duplicate,
    folder4: '   ',
  }), [path.resolve(root)]);
});

test('non-recursive scans ignore subfolders and unsupported files', async () => {
  const root = tempDir();
  write(root, 'one.jpg');
  write(root, 'two.PNG');
  write(root, 'notes.txt');
  write(root, path.join('nested', 'three.webp'));
  const result = await server._test.scanLibrary({ folder1: root, recursive: false });
  assert.deepEqual(result.items.map(item => item.name), ['one.jpg', 'two.PNG']);
});

test('recursive scans include supported images from subfolders only when enabled', async () => {
  const root = tempDir();
  write(root, 'top.gif');
  write(root, path.join('nested', 'inside.webp'));
  const flat = await server._test.scanLibrary({ folder1: root, recursive: false });
  const recursive = await server._test.scanLibrary({ folder1: root, recursive: true });
  assert.deepEqual(flat.items.map(item => item.name), ['top.gif']);
  assert.deepEqual(recursive.items.map(item => item.name).sort(), ['inside.webp', 'top.gif']);
});

test('missing and empty folders return honest renderer states', async () => {
  const root = tempDir();
  const empty = server._test.publicLibrary(await server._test.scanLibrary({ folder1: root }));
  assert.equal(empty.status, 'empty');
  assert.equal(empty.count, 0);
  const missing = server._test.publicLibrary(await server._test.scanLibrary({ folder1: path.join(root, 'gone') }));
  assert.equal(missing.status, 'unavailable');
  assert.equal(missing.availableFolders, 0);
  assert.match(missing.messages.join(' '), /missing or unreadable/i);
  const unconfigured = server._test.publicLibrary(await server._test.scanLibrary({}));
  assert.equal(unconfigured.status, 'unconfigured');
});

test('renderer boundary exposes opaque ids and rejects arbitrary path-shaped requests', async () => {
  const root = tempDir();
  write(root, 'safe.jpg', Buffer.from('synthetic-image'));
  const context = { options: { folder1: root }, query: {} };
  const library = await server.handle('library', context);
  assert.equal(library.ok, true);
  assert.equal(library.images.length, 1);
  assert.match(library.images[0].id, /^[a-f0-9]{24}$/);
  assert.equal('file' in library.images[0], false);
  assert.doesNotMatch(JSON.stringify(library), new RegExp(root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));

  const image = await server.handle('image', { options: context.options, query: { id: library.images[0].id } });
  assert.equal(image.ok, true);
  assert.match(image.dataUrl, /^data:image\/jpeg;base64,/);
  const traversal = await server.handle('image', { options: context.options, query: { id: '..\\outside.jpg' } });
  assert.deepEqual(traversal, { ok: false, error: 'invalid image id' });
});

test('manifest keeps every picked folder out of the renderer URL', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'app.json'), 'utf8'));
  assert.equal(manifest.id, 'photo-strip');
  assert.equal(manifest.served, true);
  assert.equal(manifest.server, 'server.js');
  assert.equal(manifest.knob, true);
  const folders = manifest.options.filter(option => /^folder[1-4]$/.test(option.key));
  assert.equal(folders.length, 4);
  folders.forEach(option => {
    assert.equal(option.type, 'folder');
    assert.equal(option.serverOnly, true);
  });
  const renderer = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.doesNotMatch(renderer, /\brequire\s*\(|\bnode:fs\b|\bfs\.(?:read|readdir|stat)/);
});

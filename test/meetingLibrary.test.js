'use strict';
// meetingLibrary: filename validation (the HTTP-facing gate), listing, and the
// delete-unprocessed-only rule. Uses real fs against temp dirs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMeetingLibrary, safeName, safeRelPath, wavDurationMs } = require('../app/meetingLibrary');

function tempDirs() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-lib-'));
  const unprocessed = path.join(root, 'unprocessed');
  const processed = path.join(root, 'processed');
  fs.mkdirSync(unprocessed); fs.mkdirSync(processed);
  return { root, unprocessed, processed };
}

// Minimal valid WAV: 16kHz mono 16-bit, one second of silence.
function makeWav(seconds) {
  const byteRate = 16000 * 2;
  const data = Buffer.alloc(byteRate * seconds);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(16000, 24); h.writeUInt32LE(byteRate, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

test('safeName accepts recorder-style names and rejects traversal/junk', () => {
  assert.equal(safeName('2026-08-14-09-30-00.wav'), '2026-08-14-09-30-00.wav');
  assert.equal(safeName('My Meeting (2).json'), 'My Meeting (2).json');
  assert.equal(safeName('notes.md'), 'notes.md');
  for (const bad of ['../x.wav', '..\\x.wav', 'a/b.wav', 'a\\b.wav', 'x.exe', 'x', '', null, 'x.wav.exe', 'con|.wav']) {
    assert.equal(safeName(bad), null, 'should reject: ' + bad);
  }
});

test('wavDurationMs parses a real header and rejects non-RIFF data', () => {
  assert.equal(wavDurationMs(makeWav(3)), 3000);
  assert.equal(wavDurationMs(Buffer.from('ID3not a wav at all, definitely mp3 data')), null);
  assert.equal(wavDurationMs(Buffer.alloc(10)), null);
});

test('listFiles returns WAV metadata with duration, newest first; missing folder is empty not error', () => {
  const dirs = tempDirs();
  const lib = createMeetingLibrary({ resolveFolders: () => ({ unprocessed: dirs.unprocessed, processed: dirs.processed }) });
  fs.writeFileSync(path.join(dirs.unprocessed, 'a.wav'), makeWav(2));
  fs.writeFileSync(path.join(dirs.unprocessed, 'b.wav'), makeWav(1));
  fs.writeFileSync(path.join(dirs.unprocessed, 'ignore.txt'), 'x');
  const r = lib.listFiles('unprocessed');
  assert.equal(r.ok, true);
  assert.deepEqual(r.files.map(f => f.name).sort(), ['a.wav', 'b.wav']);
  assert.equal(r.files.find(f => f.name === 'a.wav').durationMs, 2000);

  const empty = createMeetingLibrary({ resolveFolders: () => ({ unprocessed: path.join(dirs.root, 'nope'), processed: dirs.processed }) });
  assert.deepEqual(empty.listFiles('unprocessed'), { ok: true, dirs: [], files: [] });
  assert.equal(lib.listFiles('bogus').ok, false);
});

test('listFiles(processed) includes transcripts and analysis markdown', () => {
  const dirs = tempDirs();
  const lib = createMeetingLibrary({ resolveFolders: () => ({ unprocessed: dirs.unprocessed, processed: dirs.processed }) });
  fs.writeFileSync(path.join(dirs.processed, 'm.wav'), makeWav(1));
  fs.writeFileSync(path.join(dirs.processed, 'm.json'), '{}');
  fs.writeFileSync(path.join(dirs.processed, 'm.md'), '# notes');
  assert.deepEqual(lib.listFiles('processed').files.map(f => f.name).sort(), ['m.json', 'm.md', 'm.wav']);
});

test('deleteFile removes only from unprocessed and only validated names', () => {
  const dirs = tempDirs();
  const lib = createMeetingLibrary({ resolveFolders: () => ({ unprocessed: dirs.unprocessed, processed: dirs.processed }) });
  fs.writeFileSync(path.join(dirs.unprocessed, 'x.wav'), makeWav(1));
  fs.writeFileSync(path.join(dirs.processed, 'y.wav'), makeWav(1));

  assert.equal(lib.deleteFile('processed', 'y.wav').ok, false);   // archive is off-limits
  assert.equal(lib.deleteFile('unprocessed', '..\\y.wav').ok, false);
  assert.equal(lib.deleteFile('unprocessed', 'missing.wav').ok, false);
  assert.equal(lib.deleteFile('unprocessed', 'x.wav').ok, true);
  assert.equal(fs.existsSync(path.join(dirs.unprocessed, 'x.wav')), false);
  assert.equal(fs.existsSync(path.join(dirs.processed, 'y.wav')), true);
});

test('deleting a WAV also removes its Outlook meeting-info sidecar', () => {
  const dirs = tempDirs();
  const lib = createMeetingLibrary({ resolveFolders: () => ({ unprocessed: dirs.unprocessed, processed: dirs.processed }) });
  fs.writeFileSync(path.join(dirs.unprocessed, 'm.wav'), makeWav(1));
  fs.writeFileSync(path.join(dirs.unprocessed, 'm.json'), '{"subject":"weekly"}');
  assert.equal(lib.deleteFile('unprocessed', 'm.wav').ok, true);
  assert.equal(fs.existsSync(path.join(dirs.unprocessed, 'm.json')), false);
});

test('resolvePath stays inside the folder', () => {
  const dirs = tempDirs();
  const lib = createMeetingLibrary({ resolveFolders: () => ({ unprocessed: dirs.unprocessed, processed: dirs.processed }) });
  assert.equal(lib.resolvePath('unprocessed', 'ok.wav'), path.join(dirs.unprocessed, 'ok.wav'));
  assert.equal(lib.resolvePath('unprocessed', '..\\..\\config.json'), null);
  assert.equal(lib.resolvePath('nope', 'ok.wav'), null);
  // processed accepts the YYYY/MM layout; unprocessed stays flat
  assert.equal(lib.resolvePath('processed', '2026/08/m.json'), path.join(dirs.processed, '2026', '08', 'm.json'));
  assert.equal(lib.resolvePath('unprocessed', '2026/08/m.wav'), null);
  assert.equal(lib.resolvePath('processed', '../08/m.json'), null);
});

test('safeRelPath allows YYYY/MM subpaths but nothing sneaky', () => {
  assert.equal(safeRelPath('2026/08/m.json'), '2026/08/m.json');
  assert.equal(safeRelPath('m.json'), 'm.json');
  for (const bad of ['../m.json', '2026/../m.json', 'a/b/c/d.json', '2026\\08\\m.json', '2026/08/m.exe', '2026//m.json']) {
    assert.equal(safeRelPath(bad), null, 'should reject: ' + bad);
  }
});

test('listFiles(processed) shows one folder at a time with navigable subdirs', () => {
  const dirs = tempDirs();
  const lib = createMeetingLibrary({ resolveFolders: () => ({ unprocessed: dirs.unprocessed, processed: dirs.processed }) });
  fs.mkdirSync(path.join(dirs.processed, '2026', '08'), { recursive: true });
  fs.mkdirSync(path.join(dirs.processed, '.archive'));
  fs.writeFileSync(path.join(dirs.processed, '2026', '08', 'm.json'), '{}');
  fs.writeFileSync(path.join(dirs.processed, '2026', '08', 'm-analysis.md'), '# x');
  fs.writeFileSync(path.join(dirs.processed, 'legacy.json'), '{}');

  const root = lib.listFiles('processed');
  assert.deepEqual(root.dirs, ['2026']);                                       // dot-folders hidden, no recursion
  assert.deepEqual(root.files.map(f => f.name), ['legacy.json']);
  const y = lib.listFiles('processed', '2026');
  assert.deepEqual(y.dirs, ['08']);
  assert.deepEqual(y.files, []);
  const m = lib.listFiles('processed', '2026/08');
  assert.deepEqual(m.dirs, []);                                                // depth limit: no deeper navigation
  assert.deepEqual(m.files.map(f => f.name).sort(), ['2026/08/m-analysis.md', '2026/08/m.json']);

  assert.equal(lib.listFiles('processed', '../x').ok, false);                  // traversal rejected
  assert.equal(lib.listFiles('processed', 'a/b/c').ok, false);                 // too deep
  // unprocessed stays flat: dir param ignored, subfolders invisible
  fs.mkdirSync(path.join(dirs.unprocessed, 'sub'));
  fs.writeFileSync(path.join(dirs.unprocessed, 'sub', 'x.wav'), makeWav(1));
  assert.deepEqual(lib.listFiles('unprocessed', 'sub'), { ok: true, dirs: [], files: [] });
});

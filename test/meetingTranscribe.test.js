'use strict';
// meetingTranscribe: FIFO order, one-at-a-time, dedupe, success filing (JSON written + WAV moved),
// error handling (WAV stays), and the never-fabricated health probe. Fake fetch, real fs in temp dirs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMeetingTranscriber } = require('../app/meetingTranscribe');

const GOOD_RESPONSE = { speaker_report: { speaker_count: 1 }, segments: [{ speaker: 'T', start: 0, end: 1, text: 'hi' }] };

function setup(fetchImpl, httpPost) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-tx-'));
  const unprocessed = path.join(root, 'unprocessed');
  const processed = path.join(root, 'processed');
  fs.mkdirSync(unprocessed);
  const tx = createMeetingTranscriber({
    resolveFolders: () => ({ unprocessed, processed }),
    resolveBaseUrl: () => 'http://fake:1',
    fetchImpl: fetchImpl || (async () => jsonResponse(true, {})),   // health probe
    httpPost: httpPost || (async () => ({ status: 200, text: JSON.stringify(GOOD_RESPONSE) })),
    healthTtlMs: 0,
  });
  return { root, unprocessed, processed, tx };
}

function jsonResponse(ok, body, status) {
  return { ok, status: status || (ok ? 200 : 500), json: async () => body };
}
function addWav(dir, name) { fs.writeFileSync(path.join(dir, name), Buffer.from('RIFFxxxxWAVE')); }
function settle() { return new Promise(r => setTimeout(r, 50)); }
// Wait until the queue has fully drained (jobs are fast but not instant).
async function drained(tx, timeoutMs = 3000) {
  const t0 = Date.now();
  for (;;) {
    const st = tx.getState();
    if (!st.current && !st.queue.length) return;
    if (Date.now() - t0 > timeoutMs) throw new Error('queue never drained');
    await new Promise(r => setTimeout(r, 20));
  }
}

test('success: JSON transcript written to processed, WAV moved, FIFO order kept', async () => {
  const uploads = [];
  const s = setup(null, async (url, filename, buf) => {
    uploads.push([String(url), filename, buf.length]);
    return { status: 200, text: JSON.stringify(GOOD_RESPONSE) };
  });
  addWav(s.unprocessed, 'a.wav');
  addWav(s.unprocessed, 'b.wav');
  assert.equal(s.tx.enqueue('a.wav').ok, true);
  assert.equal(s.tx.enqueue('b.wav').ok, true);
  await drained(s.tx);
  const st = s.tx.getState();
  assert.equal(st.current, null);
  assert.deepEqual(st.recent.map(j => [j.name, j.status]), [['b.wav', 'done'], ['a.wav', 'done']]);   // newest first = FIFO ran a then b
  for (const base of ['a', 'b']) {
    assert.equal(fs.existsSync(path.join(s.unprocessed, base + '.wav')), false, base + ' should have moved');
    assert.equal(fs.existsSync(path.join(s.processed, base + '.wav')), true);
    const j = JSON.parse(fs.readFileSync(path.join(s.processed, base + '-diarizer-response.json'), 'utf8'));
    assert.deepEqual(j.segments, GOOD_RESPONSE.segments);
  }
});

test('diarizer {detail} error: WAV stays in unprocessed, error recorded, queue continues', async () => {
  let call = 0;
  const s = setup(null, async () => {
    call++;
    if (call === 1) return { status: 400, text: JSON.stringify({ detail: 'unsupported audio' }) };
    return { status: 200, text: JSON.stringify(GOOD_RESPONSE) };
  });
  addWav(s.unprocessed, 'bad.wav');
  addWav(s.unprocessed, 'good.wav');
  s.tx.enqueue('bad.wav');
  s.tx.enqueue('good.wav');
  await drained(s.tx);
  const st = s.tx.getState();
  assert.deepEqual(st.recent.map(j => [j.name, j.status, j.error]), [
    ['good.wav', 'done', null],
    ['bad.wav', 'error', 'unsupported audio'],
  ]);
  assert.equal(fs.existsSync(path.join(s.unprocessed, 'bad.wav')), true);     // stays for retry
  assert.equal(fs.existsSync(path.join(s.processed, 'good.wav')), true);
});

test('network failure surfaces as an error state', async () => {
  const s = setup(async () => { throw new Error('refused'); },
    async () => { throw new Error('connect ECONNREFUSED'); });
  addWav(s.unprocessed, 'x.wav');
  s.tx.enqueue('x.wav');
  await drained(s.tx);
  assert.deepEqual(s.tx.getState().recent.map(j => [j.name, j.status]), [['x.wav', 'error']]);
  assert.equal(fs.existsSync(path.join(s.unprocessed, 'x.wav')), true);
});

test('enqueue validates names, requires the file, and dedupes against queue + current', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const s = setup(null, async () => {
    await gate;                                   // hold the first job "running"
    return { status: 200, text: JSON.stringify(GOOD_RESPONSE) };
  });
  addWav(s.unprocessed, 'a.wav');
  addWav(s.unprocessed, 'b.wav');
  assert.equal(s.tx.enqueue('..\\a.wav').ok, false);
  assert.equal(s.tx.enqueue('a.txt').ok, false);
  assert.equal(s.tx.enqueue('missing.wav').ok, false);
  assert.equal(s.tx.enqueue('a.wav').ok, true);
  await settle();
  assert.equal(s.tx.enqueue('a.wav').ok, false);   // already running
  assert.equal(s.tx.enqueue('b.wav').ok, true);
  assert.equal(s.tx.enqueue('b.wav').ok, false);   // already queued
  const st = s.tx.getState();
  assert.equal(st.current.name, 'a.wav');
  assert.deepEqual(st.queue, ['b.wav']);
  release();
  await drained(s.tx);
});

test('organizeByDate files results into YYYY/MM under processed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-tx-date-'));
  const unprocessed = path.join(root, 'unprocessed');
  const processed = path.join(root, 'processed');
  fs.mkdirSync(unprocessed);
  const fixedNow = new Date(2026, 7, 14).getTime();   // Aug 14 2026 -> 2026/08
  const tx = createMeetingTranscriber({
    resolveFolders: () => ({ unprocessed, processed }),
    resolveBaseUrl: () => 'http://fake:1',
    organizeByDate: () => true,
    now: () => fixedNow,
    fetchImpl: async () => jsonResponse(true, {}),
    httpPost: async () => ({ status: 200, text: JSON.stringify(GOOD_RESPONSE) }),
    healthTtlMs: 0,
  });
  addWav(unprocessed, 'm.wav');
  tx.enqueue('m.wav');
  await drained(tx);
  assert.equal(fs.existsSync(path.join(processed, '2026', '08', 'm.wav')), true);
  assert.equal(fs.existsSync(path.join(processed, '2026', '08', 'm-diarizer-response.json')), true);
  assert.equal(fs.existsSync(path.join(unprocessed, 'm.wav')), false);
});

test('health is unknown until a probe answers, then reflects reality', async () => {
  let healthy = false;
  const s = setup(async () => {
    if (!healthy) throw new Error('refused');
    return jsonResponse(true, { status: 'ok' });
  });
  assert.equal(s.tx.getState().health, 'unknown');   // triggers the first probe
  await settle();
  assert.equal(s.tx.getState().health, 'down');
  healthy = true;
  await settle();                                     // ttl=0 -> next getState re-probes
  s.tx.getState();
  await settle();
  assert.equal(s.tx.getState().health, 'ok');
});

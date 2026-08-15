'use strict';
// meetingAnalyze: AI routing (claude vs codex), one-at-a-time, markdown filed next to the
// transcript, and clear errors for missing CLIs / failed runs. Fake spawn, real fs in temp dirs.

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createMeetingAnalyzer } = require('../app/meetingAnalyze');

// Fake child process: capture stdin, emit stdout, exit with a code on the next tick.
function fakeSpawnFactory(spawns, behavior) {
  return (cmd, args, opts) => {
    const proc = new EventEmitter();
    proc.stdout = new PassThrough();
    proc.stderr = new PassThrough();
    proc.stdin = new PassThrough();
    proc.kill = () => {};
    let stdin = '';
    proc.stdin.on('data', d => { stdin += d; });
    const rec = { cmd, args, opts, get stdin() { return stdin; } };
    spawns.push(rec);
    setImmediate(() => {
      const b = behavior(rec);
      if (b.stdout) proc.stdout.write(b.stdout);
      if (b.stderr) proc.stderr.write(b.stderr);
      if (b.outFile !== undefined) {
        const of = rec.args[rec.args.indexOf('--output-last-message') + 1];
        fs.writeFileSync(of, b.outFile);
      }
      setImmediate(() => proc.emit('close', b.code || 0));   // let stream data events flush first
    });
    return proc;
  };
}

function setup(behavior, aiSetting, finders) {
  const processed = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-an-'));
  fs.writeFileSync(path.join(processed, 'm.json'), JSON.stringify({ segments: [] }));
  const spawns = [];
  const an = createMeetingAnalyzer({
    resolveFolders: () => ({ unprocessed: processed, processed }),
    resolveAi: () => aiSetting,
    spawn: fakeSpawnFactory(spawns, behavior),
    findClaudeExe: (finders && finders.claude) || (() => 'claude.exe'),
    findCodexExe: (finders && finders.codex) || (() => 'codex.cmd'),
  });
  return { processed, spawns, an };
}
function settle() { return new Promise(r => setTimeout(r, 50)); }

test('claude route: -p, transcript on stdin, stdout filed as .md', async () => {
  const s = setup(() => ({ stdout: '# Meeting Analysis\nok', code: 0 }), 'claude');
  assert.equal(s.an.start('m.json').ok, true);
  await settle();
  assert.equal(s.spawns[0].cmd, 'claude.exe');
  assert.deepEqual(s.spawns[0].args, ['-p']);
  assert.match(s.spawns[0].stdin, /Meeting Analysis/);        // prompt text
  assert.match(s.spawns[0].stdin, /"segments"/);              // transcript JSON
  assert.equal(fs.readFileSync(path.join(s.processed, 'm.md'), 'utf8'), '# Meeting Analysis\nok');
  const st = s.an.getState();
  assert.equal(st.running, false);
  assert.equal(st.error, null);
  assert.equal(st.lastDone.name, 'm.json');
});

test('codex route: exec with stdin marker + output-last-message file', async () => {
  const s = setup(() => ({ outFile: 'codex analysis', code: 0 }), 'codex');
  s.an.start('m.json');
  await settle();
  assert.equal(s.spawns[0].cmd, 'codex');
  assert.equal(s.spawns[0].args[0], 'exec');
  assert.equal(s.spawns[0].args[1], '-');
  assert.ok(s.spawns[0].args.includes('--skip-git-repo-check'));
  assert.equal(s.spawns[0].opts.shell, true);
  assert.equal(fs.readFileSync(path.join(s.processed, 'm.md'), 'utf8'), 'codex analysis');
});

test('missing CLI is a clear error; nothing spawned', async () => {
  const s = setup(() => ({ code: 0 }), 'claude', { claude: () => null });
  s.an.start('m.json');
  await settle();
  assert.equal(s.spawns.length, 0);
  assert.match(s.an.getState().error.error, /Claude CLI not found/);
  assert.equal(fs.existsSync(path.join(s.processed, 'm.md')), false);
});

test('nonzero exit surfaces stderr; no .md written', async () => {
  const s = setup(() => ({ stderr: 'boom', code: 2 }), 'claude');
  s.an.start('m.json');
  await settle();
  assert.match(s.an.getState().error.error, /exited 2: boom/);
  assert.equal(fs.existsSync(path.join(s.processed, 'm.md')), false);
});

test('queue: second transcript waits its turn; rel-path names work', async () => {
  const processed = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-anq-'));
  fs.mkdirSync(path.join(processed, '2026', '08'), { recursive: true });
  fs.writeFileSync(path.join(processed, 'a.json'), '{}');
  fs.writeFileSync(path.join(processed, '2026', '08', 'b.json'), '{}');
  const spawns = [];
  const an = createMeetingAnalyzer({
    resolveFolders: () => ({ unprocessed: processed, processed }),
    resolveAi: () => 'claude',
    findClaudeExe: () => 'claude.exe', findCodexExe: () => null,
    spawn: fakeSpawnFactory(spawns, () => ({ stdout: 'notes', code: 0 })),
  });
  assert.equal(an.start('a.json').ok, true);
  const second = an.start('2026/08/b.json');
  assert.equal(second.ok, true);                       // queued, not rejected
  assert.deepEqual(second.queue, ['2026/08/b.json']);
  assert.equal(an.start('2026/08/b.json').ok, false);  // dedupe
  await settle();
  await settle();
  assert.equal(an.getState().running, false);
  assert.deepEqual(an.getState().queue, []);
  assert.equal(fs.existsSync(path.join(processed, 'a.md')), true);
  assert.equal(fs.existsSync(path.join(processed, '2026', '08', 'b.md')), true);
  assert.deepEqual(an.result('2026/08/b.json'), { ok: true, markdown: 'notes' });
});

test('one at a time; bad names and missing transcripts rejected up front', async () => {
  let release;
  const gate = new Promise(r => { release = r; });
  const processed = fs.mkdtempSync(path.join(os.tmpdir(), 'oqx-an2-'));
  fs.writeFileSync(path.join(processed, 'm.json'), '{}');
  const an = createMeetingAnalyzer({
    resolveFolders: () => ({ unprocessed: processed, processed }),
    resolveAi: () => 'claude',
    findClaudeExe: () => 'claude.exe',
    findCodexExe: () => null,
    spawn: () => {
      const proc = new EventEmitter();
      proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.stdin = new PassThrough();
      proc.kill = () => {};
      gate.then(() => { proc.stdout.write('done'); setImmediate(() => proc.emit('close', 0)); });
      return proc;
    },
  });
  assert.equal(an.start('..\\m.json').ok, false);
  assert.equal(an.start('m.wav').ok, false);
  assert.equal(an.start('missing.json').ok, false);
  assert.equal(an.start('m.json').ok, true);
  assert.equal(an.start('m.json').ok, false);       // busy
  release();
  await settle();
  assert.equal(an.getState().running, false);
});

test('result() reads the filed markdown or reports not analyzed', async () => {
  const s = setup(() => ({ stdout: 'notes', code: 0 }), 'claude');
  assert.deepEqual(s.an.result('m.json'), { ok: false, error: 'not analyzed' });
  s.an.start('m.json');
  await settle();
  assert.deepEqual(s.an.result('m.json'), { ok: true, markdown: 'notes' });
  assert.equal(s.an.result('..\\m.json').ok, false);
});

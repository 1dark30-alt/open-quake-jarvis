'use strict';

// Transcript analysis: feeds a processed transcript JSON plus the shared prompt
// (meeting-analysis-prompt.md) to a locally installed AI CLI — Claude (`claude -p`) or ChatGPT
// Codex (`codex exec`), per the Analysis AI setting — and writes the returned markdown next to
// the transcript as <basename>.md. One job at a time, no queue: analysis takes seconds-to-minutes
// and the panel disables the button while running.
//
// Both CLIs authenticate themselves (the app holds no API keys, same story as the voice panels).
// Deps are injected for tests: resolveFolders, resolveAi, spawn, fs, prompt path, clock.

const path = require('path');
const os = require('os');
const { safeName } = require('./meetingLibrary');

const ANALYZE_TIMEOUT_MS = 10 * 60 * 1000;   // generous; a transcript is small but CLIs cold-start

function createMeetingAnalyzer(deps) {
  const fsMod = deps.fs || require('fs');
  const fsp = fsMod.promises;
  const spawnImpl = deps.spawn || require('child_process').spawn;
  const resolveFolders = deps.resolveFolders;        // () => { unprocessed, processed }
  const resolveAi = deps.resolveAi;                  // () => 'claude' | 'codex'
  const findClaudeExe = deps.findClaudeExe || require('./claudevoice-session').findClaudeExe;
  const findCodexExe = deps.findCodexExe || require('./codexvoice-session').findCodexExe;
  const promptPath = deps.promptPath || path.join(__dirname, 'meeting-analysis-prompt.md');
  const log = deps.log || (() => {});
  const now = deps.now || Date.now;
  const timeoutMs = deps.timeoutMs || ANALYZE_TIMEOUT_MS;

  let running = null;    // { name, ai, startedAt } while a job runs
  let lastError = null;  // { name, error, finishedAt }
  let lastDone = null;   // { name, finishedAt }

  function getState() {
    return {
      ok: true,
      running: !!running,
      name: running ? running.name : null,
      startedAt: running ? running.startedAt : null,
      error: lastError,
      lastDone,
    };
  }

  function start(name) {
    if (running) return { ok: false, error: 'analysis already running: ' + running.name };
    const n = safeName(name);
    if (!n || !/\.json$/i.test(n)) return { ok: false, error: 'bad name' };
    const processed = resolveFolders().processed;
    const jsonPath = path.join(processed, n);
    if (!fsMod.existsSync(jsonPath)) return { ok: false, error: 'not found' };
    const ai = resolveAi() === 'codex' ? 'codex' : 'claude';
    running = { name: n, ai, startedAt: now() };
    log('analysis started (' + ai + '): ' + n);
    runJob(n, ai, jsonPath, path.join(processed, n.replace(/\.json$/i, '') + '.md'))
      .then(() => { lastDone = { name: n, finishedAt: now() }; lastError = null; log('analysis done: ' + n); })
      .catch(e => { lastError = { name: n, error: (e && e.message) || 'failed', finishedAt: now() }; log('analysis failed: ' + n + ' — ' + lastError.error); })
      .finally(() => { running = null; });
    return Object.assign({}, getState());
  }

  async function runJob(name, ai, jsonPath, mdPath) {
    const prompt = await fsp.readFile(promptPath, 'utf8');
    const transcript = await fsp.readFile(jsonPath, 'utf8');
    const input = prompt + '\n\nDiarizer JSON follows:\n\n' + transcript;
    const markdown = ai === 'codex' ? await runCodex(input) : await runClaude(input);
    if (!markdown.trim()) throw new Error('AI returned no output');
    const tmp = mdPath + '.tmp';
    await fsp.writeFile(tmp, markdown);
    await fsp.rename(tmp, mdPath);
  }

  function runClaude(input) {
    const exe = findClaudeExe();
    if (!exe) return Promise.reject(new Error('Claude CLI not found on PATH'));
    // `claude -p` with no positional prompt reads the whole prompt from stdin; response on stdout.
    return runProc(exe, ['-p'], input, false).then(r => r.stdout);
  }

  async function runCodex(input) {
    if (!findCodexExe()) throw new Error('Codex CLI not found on PATH');
    // codex exec: `-` = read instructions from stdin; --output-last-message captures just the final
    // reply (stdout carries progress noise); --skip-git-repo-check because the processed folder is
    // not a repo. shell:true because npm's codex shim is a .cmd on Windows (codexvoice-session:249).
    const outFile = path.join(os.tmpdir(), 'oqx-analysis-' + now() + '.md');
    try {
      await runProc('codex', ['exec', '-', '--skip-git-repo-check', '--output-last-message', outFile], input, true);
      return await fsp.readFile(outFile, 'utf8');
    } finally {
      try { await fsp.unlink(outFile); } catch (e) {}
    }
  }

  function runProc(cmd, args, stdinText, shell) {
    return new Promise((resolve, reject) => {
      let proc;
      try {
        proc = spawnImpl(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: !!shell });
      } catch (e) { return reject(new Error('spawn failed: ' + e.message)); }
      let out = '', err = '', settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        try { proc.kill(); } catch (e) {}
        reject(new Error('timed out after ' + Math.round(timeoutMs / 60000) + ' min'));
      }, timeoutMs);
      const finish = (fn, v) => { if (!settled) { settled = true; clearTimeout(timer); fn(v); } };
      proc.stdout.on('data', d => { out += d; });
      proc.stderr.on('data', d => { err += d; });
      proc.on('error', e => finish(reject, new Error('spawn failed: ' + e.message)));
      proc.on('close', code => {
        if (code === 0) finish(resolve, { stdout: out });
        else finish(reject, new Error('exited ' + code + (err.trim() ? ': ' + err.trim().slice(0, 300) : '')));
      });
      proc.stdin.on('error', () => {});   // EPIPE if the CLI dies early — close handler reports it
      proc.stdin.end(stdinText);
    });
  }

  // Read a finished analysis for the panel's View action.
  function result(name) {
    const n = safeName(name);
    if (!n) return { ok: false, error: 'bad name' };
    const mdPath = path.join(resolveFolders().processed, n.replace(/\.(json|md)$/i, '') + '.md');
    try { return { ok: true, markdown: fsMod.readFileSync(mdPath, 'utf8') }; }
    catch (e) { return { ok: false, error: 'not analyzed' }; }
  }

  return { start, getState, result };
}

module.exports = { createMeetingAnalyzer };

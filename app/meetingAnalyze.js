'use strict';

// Transcript analysis: feeds a processed transcript JSON plus the shared prompt
// (meeting-analysis-prompt.md) to a locally installed AI CLI — Claude (`claude -p`), ChatGPT
// Codex (`codex exec`), or GitHub Copilot (`copilot --acp`, one-shot ACP session — see
// copilotvoice-session.js's runCopilotBatchPrompt) — per the Analysis AI setting — and writes the
// returned markdown next to the transcript as <basename>.md. One job at a time, no queue: analysis
// takes seconds-to-minutes and the panel disables the button while running.
//
// All three CLIs authenticate themselves (the app holds no API keys, same story as the voice
// panels). Deps are injected for tests: resolveFolders, resolveAi, spawn, fs, prompt path, clock.

const path = require('path');
const os = require('os');
const { safeRelPath } = require('./meetingLibrary');
const { runCopilotBatchPrompt } = require('./copilotvoice-session');

const ANALYZE_TIMEOUT_MS = 10 * 60 * 1000;   // generous; a transcript is small but CLIs cold-start

// Analysis markdown lives beside the transcript, named after the recording: the raw diarizer
// response is <base>-diarizer-response.json (legacy plain <base>.json still accepted), the
// analysis is <base>-analysis.md — matching the naming T.J.'s pre-existing pipeline used, which
// other services key off.
function mdPathFor(jsonPath) {
  return jsonPath.replace(/-diarizer-response\.json$/i, '.json').replace(/\.json$/i, '-analysis.md');
}
// With "Use Details Folder" on, the transcript lives in <home>/details/ while the analysis .md
// belongs at <home>/ — write (and read) the .md one level up when the transcript sits in details.
function mdTargetFor(jsonPath) {
  const p = mdPathFor(jsonPath);
  const dir = path.dirname(p);
  return path.basename(dir).toLowerCase() === 'details' ? path.join(path.dirname(dir), path.basename(p)) : p;
}
// Recurring-meeting folder names, sanitized exactly like the OpenHiNotes pipeline: illegal chars
// and whitespace become hyphens, runs collapse, edges trimmed.
function sanitizeSubjectFolder(subject) {
  let s = String(subject || '');
  for (const c of '/\\:*?"<>|') s = s.split(c).join('-');
  s = s.split(/\s+/).filter(Boolean).join('-');
  while (s.includes('--')) s = s.split('--').join('-');
  return s.replace(/^-+|-+$/g, '');
}

function createMeetingAnalyzer(deps) {
  const fsMod = deps.fs || require('fs');
  const fsp = fsMod.promises;
  const spawnImpl = deps.spawn || require('child_process').spawn;
  const resolveFolders = deps.resolveFolders;        // () => { unprocessed, processed }
  const resolveAi = deps.resolveAi;                  // () => 'claude' | 'codex' | 'copilot'
  const findClaudeExe = deps.findClaudeExe || require('./claudevoice-session').findClaudeExe;
  const findCodexExe = deps.findCodexExe || require('./codexvoice-session').findCodexExe;
  const findCopilotExe = deps.findCopilotExe || require('./copilotvoice-session').findCopilotExe;
  // promptPath may be a function (main.js prefers the user's editable copy in userData over the
  // bundled template) or a fixed string (tests).
  const promptPath = deps.promptPath || path.join(__dirname, 'meeting-analysis-prompt.md');
  const resolvePromptPath = () => (typeof promptPath === 'function' ? promptPath() : promptPath);
  const log = deps.log || (() => {});
  const now = deps.now || Date.now;
  const timeoutMs = deps.timeoutMs || ANALYZE_TIMEOUT_MS;
  // () => { separateRecurring, separateTranscript, useDetailsFolder } — the Advanced filing options.
  const filingOptions = deps.filingOptions || (() => ({}));
  // () => { enabled, folder } — post-analysis batch task lists ('' folder = <processed>/task-list).
  const resolveTaskList = deps.resolveTaskList || (() => ({}));
  const batchDone = [];   // successful analyses in the current batch, flushed to a task list on drain

  const queue = [];      // names waiting (supports the panel's Analyze Selected)
  let running = null;    // { name, ai, startedAt } while a job runs
  let lastError = null;  // { name, error, finishedAt }
  let lastDone = null;   // { name, finishedAt }

  function getState() {
    return {
      ok: true,
      running: !!running,
      name: running ? running.name : null,
      startedAt: running ? running.startedAt : null,
      queue: queue.slice(),
      error: lastError,
      lastDone,
    };
  }

  function start(name) {
    const n = safeRelPath(name);
    if (!n || !/\.json$/i.test(n)) return { ok: false, error: 'bad name' };
    if ((running && running.name === n) || queue.includes(n)) return { ok: false, error: 'already queued' };
    if (!fsMod.existsSync(path.join(resolveFolders().processed, n))) return { ok: false, error: 'not found' };
    queue.push(n);
    pump();
    return Object.assign({}, getState());
  }

  function pump() {
    if (running || !queue.length) return;
    const n = queue.shift();
    const processed = resolveFolders().processed;
    const jsonPath = path.join(processed, n);
    const aiSetting = resolveAi();
    const ai = aiSetting === 'codex' ? 'codex' : aiSetting === 'copilot' ? 'copilot' : 'claude';
    running = { name: n, ai, startedAt: now() };
    log('analysis started (' + ai + '): ' + n);
    runJob(n, ai, jsonPath)
      .then(() => { lastDone = { name: n, finishedAt: now() }; lastError = null; log('analysis done: ' + n); })
      .catch(e => { lastError = { name: n, error: (e && e.message) || 'failed', finishedAt: now() }; log('analysis failed: ' + n + ' — ' + lastError.error); })
      .finally(() => {
        running = null;
        if (!queue.length) flushTaskList();   // batch drained — write the post-analysis task list
        pump();
      });
  }

  async function runJob(name, ai, jsonPath) {
    const opts = filingOptions() || {};
    const mdPath = mdTargetFor(jsonPath);
    const prompt = await fsp.readFile(resolvePromptPath(), 'utf8');
    const transcript = await fsp.readFile(jsonPath, 'utf8');
    const input = prompt + '\n\nDiarizer JSON follows:\n\n' + transcript;
    const markdown = ai === 'codex' ? await runCodex(input) : ai === 'copilot' ? await runCopilot(input) : await runClaude(input);
    if (!markdown.trim()) throw new Error('AI returned no output');

    // "Separate Clean Transcript": split the AI's output at the ## Transcript heading — notes
    // stay in the .md, the cleaned transcript goes to <base>-clean_transcript.txt. A custom
    // prompt without that heading keeps the combined output (logged, never lost).
    const dir = path.dirname(jsonPath);
    const base = path.basename(jsonPath).replace(/-diarizer-response\.json$/i, '').replace(/\.json$/i, '');
    let mdOut = markdown;
    let txtPath = null;
    if (opts.separateTranscript) {
      const m = /^##\s*Transcript\s*$/im.exec(markdown);
      if (m) {
        mdOut = markdown.slice(0, m.index).trimEnd() + '\n';
        const txt = markdown.slice(m.index + m[0].length).trim() + '\n';
        txtPath = path.join(dir, base + '-clean_transcript.txt');
        await fsp.writeFile(txtPath, txt);
      } else {
        log('no "## Transcript" heading in the AI output — keeping the combined .md');
      }
    }
    const tmp = mdPath + '.tmp';
    await fsp.writeFile(tmp, mdOut);
    await fsp.rename(tmp, mdPath);

    const filed = await fileSet(jsonPath, mdPath, txtPath, base, opts);
    if (filed) batchDone.push({ base, md: filed.md, sidecar: filed.sidecar, meta: filed.meta });
  }

  // Post-analysis filing: recurring meetings move to <processed>/YYYY/<Meeting-Name>/, and with
  // "Use Details Folder" everything except the .md tucks into a details/ subfolder. Runs after
  // the .md exists so unanalyzed meetings always stay in the easy-to-find date folders.
  async function fileSet(jsonPath, mdPath, txtPath, base, opts) {
    const dir = path.dirname(jsonPath);
    const inDetails = path.basename(dir).toLowerCase() === 'details';
    let home = inDetails ? path.dirname(dir) : dir;

    // Meeting-info sidecar (when the calendar integration wrote one): drives the recurring-folder
    // decision and feeds the batch task list's title/organizer.
    let meta = null;
    try {
      const sidecar = path.join(dir, base + '.json');
      if (fsMod.existsSync(sidecar)) meta = JSON.parse(await fsp.readFile(sidecar, 'utf8')) || null;
    } catch (e) { log('meeting-info sidecar unreadable: ' + e.message); }

    if (opts.separateRecurring && meta) {
      const folderName = sanitizeSubjectFolder(meta.subject);
      if (meta.is_recurring && folderName) {
        const ym = /^(\d{4})/.exec(base);
        const year = ym ? ym[1] : String(new Date(now()).getFullYear());
        home = path.join(resolveFolders().processed, year, folderName);
      }
    }
    const fileDir = opts.useDetailsFolder ? path.join(home, 'details') : home;

    const mv = async (src, dest) => {
      if (!src || src === dest || !fsMod.existsSync(src)) return;
      if (fsMod.existsSync(dest)) { log('filing skipped (exists): ' + path.basename(dest)); return; }
      try { await fsp.rename(src, dest); }
      catch (e) { await fsp.copyFile(src, dest); await fsp.unlink(src); }
    };
    try {
      await fsp.mkdir(fileDir, { recursive: true });
      await mv(mdPath, path.join(home, path.basename(mdPath)));
      await mv(jsonPath, path.join(fileDir, path.basename(jsonPath)));
      await mv(path.join(dir, base + '.wav'), path.join(fileDir, base + '.wav'));
      await mv(path.join(dir, base + '.json'), path.join(fileDir, base + '.json'));
      await mv(txtPath, txtPath ? path.join(fileDir, path.basename(txtPath)) : null);
    } catch (e) { log('filing failed (analysis itself is saved): ' + e.message); }
    return {
      md: path.join(home, path.basename(mdPath)),
      sidecar: meta ? path.join(fileDir, base + '.json') : null,
      meta,
    };
  }

  // "Create task-lists for post-analysis processing": one checklist per analysis batch, written
  // when the queue drains — the hand-off T.J.'s kanban ingestion picks up. Mirrors the old
  // diarizer-batch format but points at the finished -analysis.md files. Only successful analyses
  // are listed; failures stay visible on the panel instead.
  function pad2(n) { return String(n).padStart(2, '0'); }
  async function flushTaskList() {
    const items = batchDone.splice(0);
    const cfg = resolveTaskList() || {};
    if (!cfg.enabled || !items.length) return;
    try {
      const processed = resolveFolders().processed;
      const folder = String(cfg.folder || '').trim() || path.join(processed, 'task-list');
      await fsp.mkdir(folder, { recursive: true });
      const d = new Date(now());
      const stamp = d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate())
        + '_' + pad2(d.getHours()) + '-' + pad2(d.getMinutes()) + '-' + pad2(d.getSeconds());
      const rel = p => path.relative(processed, p).split(path.sep).join('/');
      const lines = [
        '# Analysis batch — ' + stamp.replace('_', ' ').replace(/-(\d\d)-(\d\d)$/, ':$1:$2'),
        '',
        items.length + ' meeting(s) analyzed. Paths below are relative to the meetings root. For each item, review the Action Items in the analysis and pick up the ones assigned to you.',
        '',
        '## Meetings',
        '',
      ];
      for (const it of items) {
        const title = (it.meta && String(it.meta.subject || '').trim()) || it.base;
        const tags = it.meta
          ? (it.meta.is_recurring ? ' (recurring)' : '') + (it.meta.organizer ? ' — ' + it.meta.organizer : '')
          : '';
        lines.push('- [ ] **' + title + '**' + tags);
        lines.push('    - Analysis: `' + rel(it.md) + '`');
        if (it.sidecar && fsMod.existsSync(it.sidecar)) lines.push('    - Meeting metadata: `' + rel(it.sidecar) + '`');
      }
      lines.push('');
      let dest = path.join(folder, stamp + '.md');
      for (let i = 1; fsMod.existsSync(dest); i++) dest = path.join(folder, stamp + '_' + i + '.md');
      await fsp.writeFile(dest, lines.join('\n'));
      log('task list written: ' + dest + ' (' + items.length + ' meeting(s))');
    } catch (e) { log('task-list write failed: ' + e.message); }
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
      await runProc('"' + findCodexExe() + '"', ['exec', '-', '--skip-git-repo-check', '--output-last-message', outFile], input, true);
      return await fsp.readFile(outFile, 'utf8');
    } finally {
      try { await fsp.unlink(outFile); } catch (e) {}
    }
  }

  function runCopilot(input) {
    const exe = findCopilotExe();
    if (!exe) return Promise.reject(new Error('Copilot CLI not found on PATH'));
    // Copilot has no plain -p-to-stdout mode -- it's an ACP JSON-RPC session (see
    // copilotvoice-session.js's runCopilotBatchPrompt), not a runProc-shaped stdin/stdout CLI.
    return runCopilotBatchPrompt({ text: input, timeoutMs, log, spawn: spawnImpl, exe });
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

  // Read a finished analysis for the panel's View action. The .md may live beside the transcript
  // or (details layout) one folder up; legacy plain <base>.md still accepted.
  function result(name) {
    const n = safeRelPath(name);
    if (!n) return { ok: false, error: 'bad name' };
    const jsonAbs = path.join(resolveFolders().processed, n).replace(/\.md$/i, '.json');
    for (const p of [mdTargetFor(jsonAbs), mdPathFor(jsonAbs), mdPathFor(jsonAbs).replace(/-analysis\.md$/i, '.md')]) {
      try { return { ok: true, markdown: fsMod.readFileSync(p, 'utf8') }; } catch (e) { /* next */ }
    }
    return { ok: false, error: 'not analyzed' };
  }

  return { start, getState, result };
}

module.exports = { createMeetingAnalyzer };

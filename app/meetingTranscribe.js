'use strict';

// Diarized-transcription client (docs/meetings-api.md): uploads unprocessed WAVs to the
// tts-sst / meeting-diarizer /transcribe endpoint, then files the results. One upload at a time
// through a FIFO queue — the diarizer runs one job anyway, and a single long-lived socket beats
// several 3600 s ones. On success the raw response JSON lands in the processed folder as
// <basename>.json and the WAV moves in next to it; on any failure the WAV stays in unprocessed
// and the error is kept for the panel to show.
//
// Everything external is injected (folders, base URL, fetch, fs, clock) so tests run with a fake
// diarizer and temp dirs — same DI shape as officeActions/meetingRecorder.

const path = require('path');
const http = require('http');
const https = require('https');
const { safeName } = require('./meetingLibrary');

const TIMEOUT_MS = 3600000;      // the API doc's own guidance: budget a full hour
const HEALTH_TTL_MS = 10000;     // re-probe /health at most this often
const HEALTH_TIMEOUT_MS = 3000;
const RECENT_MAX = 20;

// The upload deliberately does NOT use global fetch: undici enforces a hidden ~300 s
// headers timeout regardless of the abort signal, which killed any transcription needing
// more than 5 minutes of processing ("fetch failed" partway through). Raw http.request has
// no such ceiling — `timeout` below is socket INACTIVITY, so it only fires if the server
// goes silent for the full hour.
function httpPostWav(url, filename, buf, timeoutMs) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (e) { return reject(new Error('bad server URL: ' + url)); }
    const mod = u.protocol === 'https:' ? https : http;
    const boundary = '----OpenQuakeMeeting' + Math.random().toString(36).slice(2);
    const head = Buffer.from(
      '--' + boundary + '\r\nContent-Disposition: form-data; name="audio"; filename="' + filename.replace(/"/g, '') + '"\r\n' +
      'Content-Type: application/octet-stream\r\n\r\n');
    const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
    const body = Buffer.concat([head, buf, tail]);
    const req = mod.request({
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.pathname,
      method: 'POST', timeout: timeoutMs,
      headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length },
    }, res => {
      let out = '';
      res.on('data', d => { out += d; });
      res.on('end', () => resolve({ status: res.statusCode, text: out }));
    });
    req.on('timeout', () => req.destroy(new Error('no response after ' + Math.round(timeoutMs / 60000) + ' min')));
    req.on('error', e => reject(new Error(e.message || 'upload failed')));
    req.end(body);
  });
}

function createMeetingTranscriber(deps) {
  const fsMod = deps.fs || require('fs');
  const fsp = fsMod.promises;
  const fetchImpl = deps.fetchImpl || fetch;         // health probe only (short, cheap)
  const httpPost = deps.httpPost || httpPostWav;     // the long-running upload
  const resolveFolders = deps.resolveFolders;   // () => { unprocessed, processed }
  const resolveBaseUrl = deps.resolveBaseUrl;   // () => 'http://127.0.0.1:10301'
  const organizeByDate = deps.organizeByDate || (() => false);   // () => bool: file results into YYYY/MM subfolders
  const log = deps.log || (() => {});
  const now = deps.now || Date.now;
  const timeoutMs = deps.timeoutMs || TIMEOUT_MS;
  const healthTtlMs = deps.healthTtlMs === undefined ? HEALTH_TTL_MS : deps.healthTtlMs;

  const queue = [];          // names waiting
  let current = null;        // { name, startedAt } while a job runs
  const recent = [];         // newest first: { name, status: 'done'|'error', error?, finishedAt }
  let health = 'unknown';    // 'ok' | 'down' | 'unknown' — never fabricated, stays unknown until a probe answers
  let healthAt = 0;
  let healthBusy = false;

  function probeHealth() {
    if (healthBusy || (now() - healthAt) < healthTtlMs) return;
    healthBusy = true;
    fetchImpl(resolveBaseUrl() + '/health', { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
      .then(r => { health = r.ok ? 'ok' : 'down'; })
      .catch(() => { health = 'down'; })
      .finally(() => { healthAt = now(); healthBusy = false; });
  }

  function getState() {
    probeHealth();   // throttled; updates the cached value in the background
    return {
      ok: true,
      health,
      current: current ? { name: current.name, status: 'running', startedAt: current.startedAt } : null,
      queue: queue.slice(),
      recent: recent.slice(),
    };
  }

  function enqueue(name) {
    const n = safeName(name);
    if (!n || !/\.wav$/i.test(n)) return { ok: false, error: 'bad name' };
    if ((current && current.name === n) || queue.includes(n)) return { ok: false, error: 'already queued' };
    const src = path.join(resolveFolders().unprocessed, n);
    if (!fsMod.existsSync(src)) return { ok: false, error: 'not found' };
    queue.push(n);
    log('transcribe queued: ' + n);
    pump();
    return Object.assign({}, getState());
  }

  function finish(name, status, error) {
    recent.unshift({ name, status, error: error || null, finishedAt: now() });
    if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
    current = null;
    pump();
  }

  function pump() {
    if (current || !queue.length) return;
    const name = queue.shift();
    current = { name, startedAt: now() };
    runJob(name)
      .then(() => { log('transcribe done: ' + name); finish(name, 'done'); })
      .catch(e => {
        const msg = (e && e.name === 'TimeoutError') ? 'timed out after ' + Math.round(timeoutMs / 60000) + ' min' : (e && e.message) || 'failed';
        log('transcribe failed: ' + name + ' — ' + msg);
        finish(name, 'error', msg);
      });
  }

  async function runJob(name) {
    const folders = resolveFolders();
    const src = path.join(folders.unprocessed, name);
    const buf = await fsp.readFile(src);
    const res = await httpPost(resolveBaseUrl() + '/transcribe', name, buf, timeoutMs);
    if (res.status !== 200) {
      let detail = '';
      try { detail = JSON.parse(res.text).detail || ''; } catch (e) {}
      throw new Error(detail || ('diarizer returned HTTP ' + res.status));
    }
    let result = null;
    try { result = JSON.parse(res.text); } catch (e) {}
    if (!result || !Array.isArray(result.segments)) throw new Error('diarizer response missing segments');

    // File the results: transcript JSON first (atomic tmp+rename, same discipline as saveConfig),
    // then move the WAV. If the move fails the transcript still exists and the WAV stays visible
    // in unprocessed — nothing is lost either way. With Organize-by-date on, both land in
    // <processed>/YYYY/MM/ keyed to the processing date.
    let destDir = folders.processed;
    if (organizeByDate()) {
      const d = new Date(now());
      destDir = path.join(destDir, String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, '0'));
    }
    await fsp.mkdir(destDir, { recursive: true });
    const jsonPath = path.join(destDir, name.replace(/\.wav$/i, '') + '.json');
    const tmp = jsonPath + '.tmp';
    await fsp.writeFile(tmp, JSON.stringify(result, null, 2));
    await fsp.rename(tmp, jsonPath);
    const dest = path.join(destDir, name);
    try {
      await fsp.rename(src, dest);
    } catch (e) {   // cross-volume folders — copy+unlink
      await fsp.copyFile(src, dest);
      await fsp.unlink(src);
    }
  }

  return { enqueue, getState };
}

module.exports = { createMeetingTranscriber };

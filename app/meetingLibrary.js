'use strict';

// Meeting recordings library: list / delete / resolve files in the unprocessed and processed
// folders for the panel's Unprocessed / Transcription / Analysis screens. Everything is injected
// (folders, fs) so the module is testable without Electron — same pattern as officeActions.
//
// Filenames arrive from HTTP query params, so every entry point validates against SAFE_NAME and
// re-checks that the resolved path stays inside the configured folder. Reject means null/ok:false,
// never a throw that could leak a path into an error response.

const path = require('path');

const SAFE_NAME = /^[A-Za-z0-9 ._()-]+\.(wav|json|md)$/i;
const KINDS = ['unprocessed', 'processed'];

function safeName(name) {
  const n = String(name || '');
  if (!SAFE_NAME.test(n)) return null;
  if (n.includes('..') || n.includes('/') || n.includes('\\')) return null;
  return n;
}

// Best-effort duration from the WAV header: walk RIFF chunks for fmt (byteRate) + data (size).
// Returns null for anything odd (e.g. HiDock MP3-in-.wav) — callers show "—", never a fake number.
function wavDurationMs(buf) {
  try {
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') return null;
    let off = 12, byteRate = 0, dataSize = 0;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'fmt ' && off + 16 <= buf.length) byteRate = buf.readUInt32LE(off + 16);
      if (id === 'data') { dataSize = size; break; }
      off += 8 + size + (size % 2);
    }
    if (!byteRate || !dataSize) return null;
    return Math.round((dataSize / byteRate) * 1000);
  } catch (e) { return null; }
}

function createMeetingLibrary(deps) {
  const fsMod = deps.fs || require('fs');
  const resolveFolders = deps.resolveFolders;   // () => { unprocessed, processed }
  const log = deps.log || (() => {});

  function folderFor(kind) {
    if (!KINDS.includes(kind)) return null;
    return resolveFolders()[kind] || null;
  }

  // Absolute path for a validated (kind, name), or null. The startsWith re-check is belt and
  // braces on top of SAFE_NAME — a folder setting containing tricks can't escape either.
  function resolvePath(kind, name) {
    const dir = folderFor(kind);
    const n = safeName(name);
    if (!dir || !n) return null;
    const p = path.resolve(dir, n);
    if (!p.startsWith(path.resolve(dir) + path.sep)) return null;
    return p;
  }

  function listFiles(kind, ext) {
    const dir = folderFor(kind);
    if (!dir) return { ok: false, error: 'unknown kind' };
    let names = [];
    try { names = fsMod.readdirSync(dir); } catch (e) { return { ok: true, files: [] }; }   // folder not created yet = empty
    const want = ext ? new RegExp('\\.' + ext + '$', 'i') : /\.(wav|json|md)$/i;   // .md presence = "analyzed" marker for the panel
    const files = [];
    for (const n of names) {
      if (!want.test(n) || !safeName(n)) continue;
      try {
        const st = fsMod.statSync(path.join(dir, n));
        if (!st.isFile()) continue;
        let durationMs = null;
        if (/\.wav$/i.test(n)) {
          const fd = fsMod.openSync(path.join(dir, n), 'r');
          try {
            const head = Buffer.alloc(64 * 1024);
            const read = fsMod.readSync(fd, head, 0, head.length, 0);
            durationMs = wavDurationMs(head.slice(0, read));
          } finally { fsMod.closeSync(fd); }
        }
        files.push({ name: n, size: st.size, mtimeMs: st.mtimeMs, durationMs });
      } catch (e) { /* raced deletion — skip */ }
    }
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { ok: true, files };
  }

  // Deletion is only offered for unprocessed recordings — processed WAVs and their transcripts are
  // the archive and stay put.
  function deleteFile(kind, name) {
    if (kind !== 'unprocessed') return { ok: false, error: 'delete only allowed for unprocessed' };
    const p = resolvePath(kind, name);
    if (!p) return { ok: false, error: 'bad name' };
    try { fsMod.unlinkSync(p); } catch (e) { return { ok: false, error: e.code === 'ENOENT' ? 'not found' : e.message }; }
    log('deleted ' + name);
    return { ok: true };
  }

  return { listFiles, deleteFile, resolvePath, safeName };
}

module.exports = { createMeetingLibrary, safeName, wavDurationMs };

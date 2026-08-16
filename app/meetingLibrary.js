'use strict';

// Meeting recordings library: list / delete / resolve files in the unprocessed and processed
// folders for the panel's Unprocessed / Transcription / Analysis screens. Everything is injected
// (folders, fs) so the module is testable without Electron — same pattern as officeActions.
//
// Filenames arrive from HTTP query params, so every entry point validates against SAFE_NAME and
// re-checks that the resolved path stays inside the configured folder. Reject means null/ok:false,
// never a throw that could leak a path into an error response.

const path = require('path');

// Deny-list validation, not allow-list: real meeting subjects carry #, &, [ ], ', commas, etc.
// (an allow-list silently hid renamed recordings from every panel screen). Rejected outright:
// path separators, Windows-illegal filename chars, control chars, and anything containing "..".
const ILLEGAL_CHARS = /[\\/<>:"|?*]/;   // path separators + Windows-illegal (control chars checked below)
const SAFE_EXT = /\.(wav|json|md)$/i;
const KINDS = ['unprocessed', 'processed'];

function validSegment(s) {
  if (!s.length || s.includes('..') || s.trim() !== s || ILLEGAL_CHARS.test(s)) return false;
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) < 32) return false;   // control chars
  return true;
}

function safeName(name) {
  const n = String(name || '');
  if (!SAFE_EXT.test(n) || !validSegment(n)) return null;
  return n;
}

// Like safeName but allows forward-slash subfolders (the processed folder's YYYY/MM or
// YYYY/Meeting-Name layout, optionally with a details/ level): every segment validated, last
// segment must be a safeName. Max 3 folder levels deep.
function safeRelPath(name) {
  const n = String(name || '');
  if (n.includes('\\') || n.includes('..')) return null;
  const parts = n.split('/');
  if (parts.length > 4) return null;
  const file = parts[parts.length - 1];
  if (!safeName(file)) return null;
  for (let i = 0; i < parts.length - 1; i++) {
    if (!validSegment(parts[i])) return null;
  }
  return parts.join('/');
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

  // Absolute path for a validated (kind, name), or null. Processed accepts YYYY/MM subpaths;
  // unprocessed stays flat. The startsWith re-check is belt and braces on top of the name
  // validation — a folder setting containing tricks can't escape either.
  function resolvePath(kind, name) {
    const dir = folderFor(kind);
    const n = kind === 'processed' ? safeRelPath(name) : safeName(name);
    if (!dir || !n) return null;
    const p = path.resolve(dir, n);
    if (!p.startsWith(path.resolve(dir) + path.sep)) return null;
    return p;
  }

  // One directory at a time — no recursion (user direction: meeting-name folders will hold
  // special data, so the panel navigates rather than sweeping). `dir` is a forward-slash
  // relative subpath inside the processed folder (unprocessed is always flat); the returned
  // `dirs` are the navigable subfolders and file `name`s are relative paths resolvePath accepts.
  function listFiles(kind, subDir) {
    const base = folderFor(kind);
    if (!base) return { ok: false, error: 'unknown kind' };
    let rel = '';
    if (kind === 'processed' && subDir) {
      const parts = String(subDir).split('/').filter(Boolean);
      if (parts.length > 3 || parts.some(s => !validSegment(s))) return { ok: false, error: 'bad dir' };
      rel = parts.join('/');
    }
    const depth = rel ? rel.split('/').length : 0;
    let entries = [];
    try { entries = fsMod.readdirSync(rel ? path.join(base, rel) : base, { withFileTypes: true }); }
    catch (e) { return { ok: true, dirs: [], files: [] }; }   // folder not created yet = empty
    const dirs = [];
    const files = [];
    for (const ent of entries) {
      if (ent.isDirectory()) {
        // navigable while files inside remain valid rel paths (≤3 dirs); dot-folders stay hidden
        if (kind === 'processed' && depth < 3 && validSegment(ent.name) && ent.name[0] !== '.') dirs.push(ent.name);
        continue;
      }
      if (!/\.(wav|json|md)$/i.test(ent.name) || !safeName(ent.name)) continue;
      try {
        const dirAbs = rel ? path.join(base, rel) : base;
        const abs = path.join(dirAbs, ent.name);
        const st = fsMod.statSync(abs);
        if (!st.isFile()) continue;
        let durationMs = null;
        if (/\.wav$/i.test(ent.name)) {
          const fd = fsMod.openSync(abs, 'r');
          try {
            const head = Buffer.alloc(64 * 1024);
            const read = fsMod.readSync(fd, head, 0, head.length, 0);
            durationMs = wavDurationMs(head.slice(0, read));
          } finally { fsMod.closeSync(fd); }
        }
        const entry = { name: rel ? rel + '/' + ent.name : ent.name, size: st.size, mtimeMs: st.mtimeMs, durationMs };
        // Transcripts get an `analyzed` flag so the panel needn't guess: the -analysis.md sits
        // beside the transcript, or one level up when the transcript lives in a details/ folder.
        if (/-diarizer-response\.json$/i.test(ent.name)) {
          const b = ent.name.replace(/-diarizer-response\.json$/i, '');
          entry.analyzed = fsMod.existsSync(path.join(dirAbs, b + '-analysis.md'))
            || fsMod.existsSync(path.join(dirAbs, b + '.md'))
            || (path.basename(dirAbs).toLowerCase() === 'details'
                && fsMod.existsSync(path.join(path.dirname(dirAbs), b + '-analysis.md')));
        }
        files.push(entry);
      } catch (e) { /* raced deletion — skip */ }
    }
    dirs.sort();
    files.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return { ok: true, dirs, files };
  }

  // Deletion is only offered for unprocessed recordings — processed WAVs and their transcripts are
  // the archive and stay put. Deleting a WAV also removes its Outlook meeting-info sidecar
  // (<base>.json) so no orphaned info files pile up.
  function deleteFile(kind, name) {
    if (kind !== 'unprocessed') return { ok: false, error: 'delete only allowed for unprocessed' };
    const p = resolvePath(kind, name);
    if (!p) return { ok: false, error: 'bad name' };
    try { fsMod.unlinkSync(p); } catch (e) { return { ok: false, error: e.code === 'ENOENT' ? 'not found' : e.message }; }
    if (/\.wav$/i.test(p)) { try { fsMod.unlinkSync(p.replace(/\.wav$/i, '.json')); } catch (e) { /* no sidecar */ } }
    log('deleted ' + name);
    return { ok: true };
  }

  return { listFiles, deleteFile, resolvePath, safeName };
}

module.exports = { createMeetingLibrary, safeName, safeRelPath, wavDurationMs };

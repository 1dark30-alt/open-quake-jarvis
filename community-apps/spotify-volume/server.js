'use strict';
// Drives app-vol.exe (Windows Core Audio COM) to read/set per-app mixer volume.
// /app-api/get          -> { percent: N | null }
// /app-api/set?level=N  -> { percent: N | null }
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const EXE = path.join(__dirname, 'native', 'app-vol.exe');

function appVol(proc, set) {
  return new Promise(resolve => {
    if (process.platform !== 'win32' || !fs.existsSync(EXE)) return resolve(null);
    const args = [proc];
    if (set != null && Number.isFinite(set)) args.push(String(Math.max(0, Math.min(100, Math.round(set)))));
    try {
      execFile(EXE, args, { windowsHide: true, timeout: 4000 }, (err, stdout) => {
        const t = String(stdout || '').trim();
        const n = parseInt(t, 10);
        resolve(err || t === 'none' || !Number.isFinite(n) ? null : n);
      });
    } catch (e) { resolve(null); }
  });
}

exports.handle = async function (action, { query, options }) {
  const proc = ((options && options.process) || 'Spotify').trim() || 'Spotify';
  if (action === 'get') {
    return { percent: await appVol(proc, null) };
  }
  if (action === 'set') {
    const lvl = parseInt(query.level, 10);
    if (!Number.isFinite(lvl)) return { ok: false, error: 'invalid level' };
    return { percent: await appVol(proc, lvl) };
  }
  return { ok: false, error: 'unknown action' };
};

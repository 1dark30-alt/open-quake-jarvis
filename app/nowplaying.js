'use strict';
/*
 * nowplaying.js — current "now playing" track from the Windows System Media Transport Controls
 * (SMTC / Windows.Media.Control WinRT), read via the bundled smtc-monitor.exe helper. [MIT]
 *
 * App-agnostic: whatever app feeds the OS media flyout (Spotify, browser media, Groove, …) shows up
 * here — title / artist / album / playback status. No admin required.
 *
 * ONE persistent helper (native/smtc-monitor.cs) streams a JSON line on every change — this
 * replaced a powershell.exe spawn every 2.5s (~24 processes/min with the Music page open), which
 * endpoint-security tools flag as malware-like process churn. "{}" means no media session. The
 * stream replaces polling, so there's no staleness window on Windows: the last line holds until
 * the helper says otherwise or dies (death clears the snapshot and schedules a respawn).
 *
 * Album art: the SMTC thumbnail is read by a second one-shot helper (native/smtc-art.cs ->
 * app/native/smtc-art.exe), run once per track and cached. Transport control is in main.js.
 */
const { execFile, spawn } = require('child_process');
const { net } = require('electron');
const path = require('path');
const fs = require('fs');

const MONITOR_EXE = path.join(__dirname, 'native', 'smtc-monitor.exe').replace('app.asar', 'app.asar.unpacked');

const STALE_MS = 12000;   // provider path only: if no provider refresh for this long, report null
const RESPAWN_MS = 5000;  // helper crash -> retry delay (only while running)
let snapshot = null, snapTs = 0, timer = null, running = false, busy = false;
let proc = null, respawnTimer = null, warned = false;

// Optional async now-playing provider (e.g. the Spotify Web API client on macOS). When set, it REPLACES
// the win32 SMTC poll: macOS-with-Spotify -> provider; win32 -> SMTC; otherwise null. A provider result
// carries its own `art` URL (the page's setArt takes a URL), so it bypasses the SMTC art-helper path.
let provider = null;
function setProvider(fn) { provider = (typeof fn === 'function') ? fn : null; }

// Album art via the bundled .NET helper. Path resolves dev vs packaged (asar.unpacked) like main.js.
const ART_EXE = path.join(__dirname, 'native', 'smtc-art.exe').replace('app.asar', 'app.asar.unpacked');
const artCache = {};      // trackKey -> dataURL | null  (fetched or failed; never re-fetched)
let artBusy = false;
function trackKey(s) { return s ? (s.title || '') + '\t' + (s.artist || '') : ''; }
function artMime(b64) {   // sniff the format from the base64 head so the data: URL declares the right type
  if (b64.startsWith('iVBOR')) return 'image/png';
  if (b64.startsWith('/9j/')) return 'image/jpeg';
  if (b64.startsWith('R0lGOD')) return 'image/gif';
  if (b64.startsWith('UklGR')) return 'image/webp';
  if (b64.startsWith('Qk')) return 'image/bmp';
  return 'image/png';
}
function fetchArt(key, track) {
  if (artBusy || (key in artCache)) return;   // one fetch at a time; never re-fetch a known track
  artBusy = true;
  if (process.platform !== 'win32') {   // smtc-art.exe is Windows-only — skip it, go straight to the iTunes fallback
    lookupArtOnline(track, url => { artCache[key] = url || null; artBusy = false; });
    return;
  }
  execFile(ART_EXE, (track && track.app) ? [track.app] : [], { windowsHide: true, timeout: 4000, maxBuffer: 16 * 1024 * 1024 }, (err, stdout) => {
    const b64 = (!err && stdout) ? String(stdout).trim() : '';
    if (b64) { artCache[key] = 'data:' + artMime(b64) + ';base64,' + b64; artBusy = false; return; }
    lookupArtOnline(track, url => { artCache[key] = url || null; artBusy = false; });   // helper had no art -> online fallback
  });
}
// Fallback cover art via Apple's iTunes Search API (no key) when the SMTC thumbnail is unavailable —
// the helper is missing/blocked, or the player reports a track but ships no embedded art. Sends only the
// artist + album/title to Apple, and only for tracks the helper couldn't cover.
function lookupArtOnline(track, cb) {
  const artist = (track && track.artist) || '';
  const what = (track && (track.album || track.title)) || '';
  const term = (artist + ' ' + what).trim();
  if (!term) return cb(null);
  const url = 'https://itunes.apple.com/search?limit=1&media=music&entity='
    + ((track && track.album) ? 'album' : 'song') + '&term=' + encodeURIComponent(term);
  let req, to, done = false;
  const finish = v => { if (done) return; done = true; if (to) clearTimeout(to); cb(v); };
  try { req = net.request(url); } catch (e) { return cb(null); }
  to = setTimeout(() => { try { req.abort(); } catch (e) {} finish(null); }, 4000);
  const chunks = [];
  req.on('error', () => finish(null));
  req.on('response', resp => {
    if (resp.statusCode !== 200) { resp.resume(); return finish(null); }
    resp.on('data', d => chunks.push(d));
    resp.on('error', () => finish(null));
    resp.on('end', () => {
      try {
        const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        const a = j.results && j.results[0] && j.results[0].artworkUrl100;
        finish(a ? a.replace('100x100bb', '600x600bb') : null);   // bump 100px thumb to 600px
      } catch (e) { finish(null); }
    });
  });
  req.end();
}

// ---- provider path (e.g. Spotify Web API on macOS): still a timer poll of an async function ----
async function tick() {
  if (busy || !running || !provider) return;     // busy guard: don't overlap provider calls
  busy = true;
  try {
    const r = await Promise.resolve().then(provider).catch(() => null);
    if (r) {
      snapshot = r; snapTs = Date.now();
      // A provider (Spotify) supplies its own art URL — cache it directly and skip the SMTC art helper.
      if ('art' in r) artCache[trackKey(r)] = r.art || null;
      else if (running) fetchArt(trackKey(r), r);
    }
  } catch (e) {}
  finally { busy = false; }
}

// ---- Windows path: consume the persistent smtc-monitor.exe stream ----
function onMonitorLine(line) {
  if (!running) return;
  let o;
  try { o = JSON.parse(line); } catch (e) { return; }
  if (!o || !o.title) { snapshot = null; snapTs = 0; return; }        // "{}" -> no media session
  snapshot = { title: o.title || null, artist: o.artist || null, album: o.album || null, status: o.status || null, app: o.app || null, position: +o.position || 0, duration: +o.duration || 0 };
  snapTs = Date.now();
  fetchArt(trackKey(snapshot), snapshot);
}

function spawnMonitor() {
  if (!running || proc) return;
  if (!fs.existsSync(MONITOR_EXE)) {
    if (!warned) { warned = true; console.log('[nowplaying] smtc-monitor.exe missing (native helpers not built) — now-playing inactive'); }
    return;
  }
  // stdin stays open (piped): the helper exits on stdin EOF, so it can never outlive us.
  try { proc = spawn(MONITOR_EXE, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] }); }
  catch (e) { proc = null; return; }
  let buf = '';
  proc.stdout.on('data', d => {
    buf += d.toString('utf8');
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) onMonitorLine(line);
    }
  });
  proc.on('error', () => {});
  proc.on('close', () => {
    proc = null;
    snapshot = null; snapTs = 0;                                       // dead helper -> honest "nothing playing"
    if (running && !respawnTimer) respawnTimer = setTimeout(() => { respawnTimer = null; spawnMonitor(); }, RESPAWN_MS);
  });
}

function start() {
  if (running) return;
  running = true;
  if (provider) { tick(); timer = setInterval(tick, 2500); }
  else if (process.platform === 'win32') spawnMonitor();
}
function stop() {
  running = false;
  if (timer) clearInterval(timer);
  timer = null;
  if (respawnTimer) { clearTimeout(respawnTimer); respawnTimer = null; }
  if (proc) { try { proc.kill(); } catch (e) {} proc = null; }
  snapshot = null; snapTs = 0;
  artBusy = false;
  for (const k in artCache) delete artCache[k];
}
function getSnapshot() {                                                    // null => "nothing playing"
  if (!snapshot) return null;
  if (provider && !(snapTs && Date.now() - snapTs < STALE_MS)) return null; // staleness only guards the polled provider path
  const k = trackKey(snapshot);
  // ts = when this position was captured (same machine clock as the page) so the page can interpolate scroll.
  return Object.assign({}, snapshot, { art: (k in artCache) ? artCache[k] : null, ts: snapTs });
}

module.exports = { start, stop, getSnapshot, setProvider };

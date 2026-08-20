'use strict';
// HOST for the Screensaver panel app: serves the page its media list, resolves media-file requests
// (sysserver streams them with Range support), persists panel-tunable options, and backs the
// on-panel folder browser. No LLM/turn/SSE machinery — the page itself renders the built-in canvas
// scenes; this host only deals with the user's media folder.
//
// The media folder path is serverOnly (never in the page URL); the page addresses files by NAME
// through /screensaver/media?f=<name>, and this host is the only place names become paths — flat
// folder only, extension-allowlisted, contained exactly like the drop-in app static server.
//
// deps (main.js voicePanelDeps('screensaver')): activeServedAppConfig(appId), activeGrid(),
// getConfig(), saveConfig(), getDocumentsPath(). defaultMediaDir: the auto-created
// <userData>/screensaver-media folder used when the page has no custom folder set.
const fs = require('fs');
const path = require('path');

const MEDIA_EXTS = {
  '.jpg': 'image', '.jpeg': 'image', '.png': 'image', '.gif': 'image', '.webp': 'image',
  '.mp4': 'video', '.webm': 'video', '.mov': 'video',
};
const MAX_FILES = 500;

function truthy(v) { return v === true || v === '1' || v === 'true'; }

// Panel-editable options, validated + normalized to the string form stored in g.options
// (livetranslate pattern: strings survive restarts and match the query-string delivery).
const boolOpt = v => (v === true || v === '1' || v === false || v === '0' || v === 'true' || v === 'false')
  ? (truthy(v) ? '1' : '0') : null;
const PANEL_OPTIONS = {
  source: v => (v === 'scenes' || v === 'media' || v === 'both') ? v : null,
  // Scene picks are independent toggles (any mix); all five off is a legitimate "nothing" state.
  sceneWaves: boolOpt,
  sceneStarfield: boolOpt,
  sceneLava: boolOpt,
  sceneFireflies: boolOpt,
  sceneAquarium: boolOpt,
  fillMode: v => (v === 'cover' || v === 'contain') ? v : null,
  intervalSec: v => { const n = parseInt(v, 10); return n >= 3 && n <= 86400 ? String(n) : null; },
  shuffle: boolOpt,
  idleMinutes: v => { const n = parseInt(v, 10); return n >= 0 && n <= 720 ? String(n) : null; },
  mediaDir: v => (typeof v === 'string' && v.length <= 500) ? v.trim() : null,   // '' = default folder
};

// name -> absolute path inside mediaDir, or null. Flat folder only: any separator, drive prefix,
// traversal, or non-media extension is rejected (mirrors sysserver's serveDropInApp containment;
// the scheme regex also catches win32 drive-relative escapes like "C:evil" that isAbsolute misses).
function resolveMediaPath(mediaDir, name) {
  if (!mediaDir || typeof name !== 'string' || !name) return null;
  if (name.includes('/') || name.includes('\\') || name.includes('..')
    || /^[A-Za-z][A-Za-z0-9+.-]*:/.test(name) || path.isAbsolute(name)) return null;
  if (!MEDIA_EXTS[path.extname(name).toLowerCase()]) return null;
  const root = path.resolve(mediaDir);
  const abs = path.resolve(root, name);
  if (abs === root || !abs.startsWith(root + path.sep)) return null;
  return abs;
}

// Allowlisted media files in a folder: [{name, kind}], name-sorted, capped. Missing/unreadable
// folder = empty list (the page shows its "drop files in" hint instead of erroring).
function listMedia(mediaDir) {
  let names = [];
  try { names = fs.readdirSync(mediaDir); } catch (e) { return []; }
  return names
    .filter(n => MEDIA_EXTS[path.extname(n).toLowerCase()] && resolveMediaPath(mediaDir, n))
    .sort((a, b) => a.localeCompare(b))
    .slice(0, MAX_FILES)
    .map(n => ({ name: n, kind: MEDIA_EXTS[path.extname(n).toLowerCase()] }));
}

function createScreensaverHost({ appId = 'screensaver', log, deps, defaultMediaDir }) {
  const say = log || (() => {});

  function pageOptions() {
    const cfg = deps.activeServedAppConfig(appId);
    return (cfg && cfg.options) || null;
  }

  // Effective media folder for the ACTIVE screensaver page: the page's custom folder, or the
  // shipped default (auto-created on first use so the Settings "open folder" link always works).
  function mediaDir() {
    const o = pageOptions();
    if (!o) return null;                       // page not active -> no folder, media requests 404
    const custom = String(o.mediaDir || '').trim();
    if (custom) return custom;
    if (defaultMediaDir) { try { fs.mkdirSync(defaultMediaDir, { recursive: true }); } catch (e) {} }
    return defaultMediaDir || null;
  }

  // sysserver's /screensaver/media?f=<name> -> absolute path (it streams with Range) or null.
  function resolveMedia(name) {
    return resolveMediaPath(mediaDir(), name);
  }

  // The page's on-load /state fetch: the media list plus the folder shown in its settings overlay.
  function getState() {
    const o = pageOptions();
    if (!o) return { ok: false, status: 'idle', files: [], mediaDir: '', usingDefault: true };
    const dir = mediaDir();
    return {
      ok: true,
      status: 'idle',
      files: dir ? listMedia(dir) : [],
      mediaDir: dir || '',
      usingDefault: !String(o.mediaDir || '').trim(),
    };
  }

  // Folder browser for the page's settings overlay (same generic /projects route the voice apps
  // use). Starts from the effective media folder; recents are not a thing here.
  function getProjects(browsePath) {
    const o = pageOptions();
    if (!o) return { root: '', parent: null, dirs: [], current: '', recents: [] };
    const root = path.resolve(browsePath || mediaDir() || deps.getDocumentsPath() || '');
    let dirs = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true })
        .filter(d => d.isDirectory())
        .map(d => path.join(root, d.name))
        .sort((a, b) => a.localeCompare(b));
    } catch (e) {}
    const up = path.dirname(root);
    return { root, parent: up !== root ? up : null, dirs, current: mediaDir() || '', recents: [] };
  }

  // Persist a panel-tunable option into this page's options (only while it is the active page).
  function setOption(key, value) {
    const validate = PANEL_OPTIONS[key];
    if (!validate) return false;
    const v = validate(value);
    if (v == null) return false;
    const g = deps.activeGrid();
    if (!(g && g.kind === 'app' && g.app === appId)) return false;
    if (!g.options) g.options = {};
    g.options[key] = v;
    deps.saveConfig();
    return true;
  }

  return {
    appId,
    handlers: { getState, setOption, resolveMedia, getProjects },
    shutdown() {},   // nothing long-lived to tear down
  };
}

module.exports = { createScreensaverHost, resolveMediaPath, listMedia, MEDIA_EXTS };

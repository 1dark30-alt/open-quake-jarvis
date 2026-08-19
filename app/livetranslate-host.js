'use strict';
// Lightweight HOST for the "Live Translate" panel app. No LLM adapter, no turn/SSE/speech machinery:
// it mints short-lived Soniox credentials for the page, persists panel-tunable options, and appends
// finalized translations to a running text file when Save-to-file is on.
//
// The page (livetranslateview.js) does the actual streaming: continuous 16 kHz mono PCM to Soniox's
// real-time translation WebSocket, authenticated with a temporary key from /soniox-token below — the
// real API key never leaves the main process (plaintext in memory, encrypted at rest by secretStore).
//
// deps (reuses main.js's voicePanelDeps('livetranslate')):
//   activeServedAppConfig(appId)   activeGrid()   saveConfig()   getDocumentsPath()
const fs = require('fs');
const path = require('path');
const https = require('https');                         // Soniox temporary-API-key mint

function truthy(v) { return v === true || v === '1' || v === 'true'; }

// Panel-editable options, validated + normalized to the string form stored in config.json's g.options
// (so they survive app restarts and match how the query-string delivery re-reads them).
const PANEL_OPTIONS = {
  saveToFile: v => (v === true || v === '1' || v === false || v === '0' || v === 'true' || v === 'false')
    ? (truthy(v) ? '1' : '0') : null,
  // Mic pick is stored as a LABEL, not a deviceId (Chromium salts ids per origin, and the served
  // origin's port changes every launch); the page re-matches label -> id at startup. '' = default.
  micDevice: v => typeof v === 'string' && v.length <= 200 ? v : null,
};

function createLiveTranslateHost({ appId = 'livetranslate', log, deps }) {
  const say = log || (() => {});
  let currentSavePath = '';   // file the current Save-to-file session appends to (stamped on first line)

  function pageOptions() {
    const cfg = deps.activeServedAppConfig(appId);
    return (cfg && cfg.options) || null;
  }
  // Two-digit-padded local timestamp for the save filename (app code, so Date is fine to use here).
  function stamp() {
    const d = new Date(), p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '-' +
      p(d.getHours()) + '-' + p(d.getMinutes()) + '-' + p(d.getSeconds());
  }
  function saveFolder() {
    const o = pageOptions();
    const custom = o && String(o.saveFolder || '').trim();
    return custom || path.join(deps.getDocumentsPath() || '', 'OpenQuake Translations');
  }

  // Append one finalized line to the running file when Save-to-file is on. One file per save session:
  // the name is stamped when the first line lands and reused until saving is toggled off.
  function maybeSave(line) {
    const o = pageOptions();
    if (!o || !truthy(o.saveToFile)) { currentSavePath = ''; return; }
    try {
      const dir = saveFolder();
      fs.mkdirSync(dir, { recursive: true });
      if (!currentSavePath) currentSavePath = path.join(dir, 'translation-' + stamp() + '.txt');
      fs.appendFileSync(currentSavePath, line + '\r\n');
    } catch (e) { say('Save-to-file failed: ' + e.message); }
  }

  // Mint a SHORT-LIVED Soniox temporary API key from the page's stored key. The renderer
  // authenticates its Soniox WebSocket with this temp key, so the real key never leaves main.
  function sonioxToken() {
    const o = pageOptions();
    const key = o && String(o.sonioxApiKey || '').trim();
    if (!key) return Promise.resolve({ ok: false, error: 'Soniox API key not set (this page’s settings)' });
    const body = JSON.stringify({ usage_type: 'transcribe_websocket', expires_in_seconds: 300, max_session_duration_seconds: 3600 });
    return new Promise(resolve => {
      const req = https.request('https://api.soniox.com/v1/auth/temporary-api-key', {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      }, res => {
        let data = ''; res.on('data', d => data += d); res.on('end', () => {
          let j = null; try { j = JSON.parse(data); } catch (e) {}
          if (res.statusCode >= 200 && res.statusCode < 300 && j && j.api_key) resolve({ ok: true, apiKey: j.api_key, expiresAt: j.expires_at });
          else { say('Soniox token mint failed: ' + res.statusCode + ' ' + data.slice(0, 200)); resolve({ ok: false, error: (j && (j.error_message || j.message)) || ('Soniox HTTP ' + res.statusCode) }); }
        });
      });
      req.on('error', e => { say('Soniox token error: ' + e.message); resolve({ ok: false, error: e.message }); });
      req.write(body); req.end();
    });
  }

  // Append finalized translation to the save file (the page posts the session text on stop).
  function appendLine(text) { const t = String(text || '').trim(); if (t) maybeSave(t); return { ok: true }; }

  // Snapshot for the page's on-load /state fetch: configured?, target language, save state.
  function getState() {
    const o = pageOptions() || {};
    return {
      ok: true,
      status: 'idle',
      sonioxConfigured: !!String(o.sonioxApiKey || '').trim(),
      targetLanguage: o.targetLanguage || 'en',
      targetLangLabel: o.targetLangLabel || '',
      saveToFile: truthy(o.saveToFile),
      savePath: currentSavePath || '',
    };
  }

  // Persist a panel-tunable option into this page's options in config.json (only when livetranslate is
  // the active page). Toggling save OFF ends the current file so the next ON starts a fresh one.
  function setOption(key, value) {
    const validate = PANEL_OPTIONS[key];
    if (!validate) return false;
    const v = validate(value);
    if (v == null) return false;
    const g = deps.activeGrid();
    if (!(g && g.kind === 'app' && g.app === appId)) return false;
    if (!g.options) g.options = {};
    g.options[key] = v;
    if (key === 'saveToFile' && v === '0') currentSavePath = '';
    deps.saveConfig();
    return true;
  }

  return {
    appId,
    handlers: { getState, setOption, sonioxToken, appendLine },
    shutdown() {},   // nothing long-lived to tear down
  };
}

module.exports = { createLiveTranslateHost };

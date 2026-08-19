'use strict';
// Lightweight HOST for the "Live Translate" panel app (Tier 1). Unlike the voice-panel host
// (voicepanel-host.js) it has NO LLM adapter and none of the turn/SSE/speech machinery -- it only
// turns one VAD-trimmed mic utterance (raw 16 kHz/16-bit/mono PCM, matching claudevoice-vad.js) into
// text via the configured Wyoming STT endpoint, and optionally appends each finalized line to a
// running text file.
//
// "Translation to English" is NOT done here: it happens inside wyoming-faster-whisper when that STT
// server is launched with `--whisper-task translate` (a server-global flag -- confirmed per-request
// task selection is not supported). So the recommended setup points THIS page's STT override
// (grid.options.voiceOverride + voiceSttHost/voiceSttPort) at a translate-mode Whisper endpoint
// (e.g. a second port on the tts-stt-windows helper). This host is task-agnostic and simply shows
// whatever text the STT returns -- English when the endpoint is in translate mode, verbatim otherwise.
//
// deps (reuses main.js's voicePanelDeps('livetranslate')):
//   voiceEndpoints() -> { sttHost, sttPort, ... }   activeServedAppConfig(appId)
//   activeGrid()   saveConfig()   getDocumentsPath()
const fs = require('fs');
const path = require('path');
const wyoming = require('./claudevoice-wyoming');       // pure Wyoming STT/TTS protocol client
const { isSttNoisePhrase } = require('./voiceConfig');  // drops whisper's near-silence hallucinations

function truthy(v) { return v === true || v === '1' || v === 'true'; }

// Panel-editable options, validated + normalized to the string form stored in config.json's g.options
// (so they survive app restarts and match how the query-string delivery re-reads them).
const PANEL_OPTIONS = {
  saveToFile: v => (v === true || v === '1' || v === false || v === '0' || v === 'true' || v === 'false')
    ? (truthy(v) ? '1' : '0') : null,
  vadHangoverMs: v => { const n = parseInt(v, 10); return n >= 400 && n <= 2500 ? String(n) : null; },
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
  function saveFolder() { return path.join(deps.getDocumentsPath() || '', 'OpenQuake Translations'); }

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

  // Transcribes one VAD-trimmed utterance via the configured wyoming-faster-whisper host/port.
  async function transcribe(pcmBuffer) {
    const { sttHost: host, sttPort: port } = deps.voiceEndpoints();
    if (!host || !port) {
      return { ok: false, error: 'STT host/port not configured (this page’s Advanced override, or Settings → TTS/STT)' };
    }
    try {
      const text = await wyoming.transcribe({ host, port, audio: pcmBuffer, rate: 16000, width: 2, channels: 1, log: say });
      if (isSttNoisePhrase(text)) { say('STT dropped a known noise-hallucination phrase: ' + JSON.stringify(text)); return { ok: true, text: '' }; }
      const clean = String(text || '').trim();
      if (clean) maybeSave(clean);
      return { ok: true, text: clean };
    } catch (e) {
      say('STT error: ' + e.message);
      return { ok: false, error: e.message };
    }
  }

  // Snapshot for the page's on-load /state fetch: whether an STT endpoint is set, its host:port (for
  // the dim source line), the target-language label, and the current save state/path.
  function getState() {
    const { sttHost, sttPort } = deps.voiceEndpoints();
    const o = pageOptions() || {};
    return {
      ok: true,
      status: 'idle',
      sttConfigured: !!(sttHost && sttPort),
      sttEndpoint: sttHost && sttPort ? (sttHost + ':' + sttPort) : '',
      targetLangLabel: o.targetLangLabel || 'English',
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
    handlers: { transcribe, getState, setOption },
    shutdown() {},   // nothing long-lived to tear down
  };
}

module.exports = { createLiveTranslateHost };

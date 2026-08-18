'use strict';

// Shared, electron-free TTS/STT (Wyoming) endpoint config so it can be unit-tested.
//
// Model:
//   - GLOBAL default lives in config.settings.voice = { sttHost, sttPort, ttsHost, ttsPort } — each
//     service (Whisper STT / Piper TTS) has its own host+port so they can be on different servers.
//   - A voice-app PAGE may override the global for just itself via grid.options.voiceOverride +
//     voiceSttHost/voiceSttPort/voiceTtsHost/voiceTtsPort.
// Both are edited in the config editor (global on the TTS/STT tab, override in the page's Advanced).

const VOICE_APPS = ['claude-voice', 'codex-voice', 'copilot-voice', 'owui-voice'];
// Host blank by default (voice stays off until pointed at a server; the editor placeholder is
// 127.0.0.1 for the tts-stt-windows helper). Ports are the standard Wyoming faster-whisper / piper.
const VOICE_DEFAULTS = { sttHost: '', sttPort: '10300', ttsHost: '', ttsPort: '10200' };

function str(x) { return String(x == null ? '' : x).trim(); }

// The global voice endpoints, defaults filled in.
function voiceSettings(settings) {
  const v = (settings && settings.voice) || {};
  return {
    sttHost: str(v.sttHost) || VOICE_DEFAULTS.sttHost,
    sttPort: str(v.sttPort) || VOICE_DEFAULTS.sttPort,
    ttsHost: str(v.ttsHost) || VOICE_DEFAULTS.ttsHost,
    ttsPort: str(v.ttsPort) || VOICE_DEFAULTS.ttsPort,
  };
}

// Effective endpoints for a served voice page. `pageOptions` is grid.options, or null when no such
// page is active — then the endpoints are blank so nothing gets dialed (mirrors the old behavior
// where an inactive app returned an empty host). A page with voiceOverride uses its own values.
function resolveVoiceEndpoints(settings, pageOptions) {
  if (!pageOptions) return { sttHost: '', sttPort: '', ttsHost: '', ttsPort: '' };
  if (pageOptions.voiceOverride) {
    return {
      sttHost: str(pageOptions.voiceSttHost), sttPort: str(pageOptions.voiceSttPort),
      ttsHost: str(pageOptions.voiceTtsHost), ttsPort: str(pageOptions.voiceTtsPort),
    };
  }
  return voiceSettings(settings);
}

// One-time migration of the legacy per-page keys (wyomingHost / wyomingSttPort / wyomingTtsPort, one
// shared host) to the new model: seed the global from the first voice page that has them (its host
// applies to both services), keep any later page whose endpoints differ as an explicit override, and
// drop the legacy keys. Idempotent — with no legacy keys present it changes nothing. Mutates config.
function migrateVoiceConfig(config) {
  if (!config || !Array.isArray(config.grids)) return config;
  let seeded = !!(config.settings && config.settings.voice);
  for (const g of config.grids) {
    if (!g || !VOICE_APPS.includes(g.app) || !g.options) continue;
    const o = g.options;
    if (!('wyomingHost' in o) && !('wyomingSttPort' in o) && !('wyomingTtsPort' in o)) continue;
    const host = str(o.wyomingHost);
    const sttPort = str(o.wyomingSttPort) || VOICE_DEFAULTS.sttPort;
    const ttsPort = str(o.wyomingTtsPort) || VOICE_DEFAULTS.ttsPort;
    if (!seeded) {
      if (!config.settings) config.settings = {};
      config.settings.voice = { sttHost: host, sttPort, ttsHost: host, ttsPort };
      seeded = true;
    } else {
      const v = voiceSettings(config.settings);
      const differs = host !== v.sttHost || host !== v.ttsHost || sttPort !== v.sttPort || ttsPort !== v.ttsPort;
      if (differs) {
        o.voiceOverride = true;
        o.voiceSttHost = host; o.voiceSttPort = sttPort;
        o.voiceTtsHost = host; o.voiceTtsPort = ttsPort;
      }
    }
    delete o.wyomingHost; delete o.wyomingSttPort; delete o.wyomingTtsPort;
  }
  return config;
}

// Endpoints for LucidType dictation: the first lucidtype grid's own options (honoring its per-page
// override) over the global default. Pure so it's testable without electron — dictation runs in the
// background, so it can't use activeServedAppConfig (which only returns the ACTIVE grid).
function resolveLucidEndpoints(settings, grids) {
  const g = (grids || []).find(x => x && x.kind === 'app' && x.app === 'lucidtype');
  return resolveVoiceEndpoints(settings, (g && g.options) || {});
}

// Whisper near-silence hallucinations to drop (exact whole-utterance match after normalization, so a
// real sentence that merely contains these words still passes). Mirrors voicepanel-host.js.
const STT_NOISE_PHRASES = ['thanks for watching'];
function isSttNoisePhrase(text) {
  const norm = String(text || '').toLowerCase().replace(/[^a-z' ]/g, ' ').replace(/\s+/g, ' ').trim();
  return STT_NOISE_PHRASES.includes(norm);
}

module.exports = { VOICE_APPS, VOICE_DEFAULTS, voiceSettings, resolveVoiceEndpoints, resolveLucidEndpoints, migrateVoiceConfig, isSttNoisePhrase };

'use strict';

// voiceConfig: global TTS/STT endpoint resolution + per-page override + one-time migration of the
// legacy single-host per-page keys. Pure (no electron), so it locks in the migration-safe behavior:
// existing setups keep their exact endpoints, and inactive apps never dial out.

const test = require('node:test');
const assert = require('node:assert/strict');
const { VOICE_DEFAULTS, voiceSettings, resolveVoiceEndpoints, migrateVoiceConfig } = require('../app/voiceConfig');

test('voiceSettings fills defaults and trims', () => {
  assert.deepEqual(voiceSettings(undefined), VOICE_DEFAULTS);
  assert.deepEqual(voiceSettings({ voice: { sttHost: ' 10.0.0.5 ', sttPort: ' 1 ' } }),
    { sttHost: '10.0.0.5', sttPort: '1', ttsHost: '', ttsPort: '10200' });
});

test('resolveVoiceEndpoints returns blanks when no page is active', () => {
  assert.deepEqual(resolveVoiceEndpoints({ voice: { sttHost: 'x', ttsHost: 'y' } }, null),
    { sttHost: '', sttPort: '', ttsHost: '', ttsPort: '' });
});

test('resolveVoiceEndpoints uses the global default when the page does not override', () => {
  const settings = { voice: { sttHost: 'stt.lan', sttPort: '10300', ttsHost: 'tts.lan', ttsPort: '10200' } };
  assert.deepEqual(resolveVoiceEndpoints(settings, {}),
    { sttHost: 'stt.lan', sttPort: '10300', ttsHost: 'tts.lan', ttsPort: '10200' });
});

test('resolveVoiceEndpoints honors a per-page override', () => {
  const settings = { voice: { sttHost: 'global', sttPort: '1', ttsHost: 'global', ttsPort: '2' } };
  const page = { voiceOverride: true, voiceSttHost: 'pi', voiceSttPort: '10300', voiceTtsHost: 'pi2', voiceTtsPort: '10200' };
  assert.deepEqual(resolveVoiceEndpoints(settings, page),
    { sttHost: 'pi', sttPort: '10300', ttsHost: 'pi2', ttsPort: '10200' });
});

test('migration seeds the global from the first legacy voice page (host -> both services)', () => {
  const cfg = { grids: [{ app: 'claude-voice', options: { wyomingHost: '192.168.1.9', wyomingSttPort: '10300', wyomingTtsPort: '10200', projectDir: 'C:/x' } }] };
  migrateVoiceConfig(cfg);
  assert.deepEqual(cfg.settings.voice, { sttHost: '192.168.1.9', sttPort: '10300', ttsHost: '192.168.1.9', ttsPort: '10200' });
  // legacy keys removed, unrelated options preserved
  const o = cfg.grids[0].options;
  assert.equal('wyomingHost' in o, false);
  assert.equal('wyomingSttPort' in o, false);
  assert.equal('wyomingTtsPort' in o, false);
  assert.equal(o.projectDir, 'C:/x');
  assert.equal(o.voiceOverride, undefined);   // matches the seeded global -> inherits, no override
});

test('migration keeps a divergent second page as an explicit override', () => {
  const cfg = { grids: [
    { app: 'claude-voice', options: { wyomingHost: 'hostA', wyomingSttPort: '10300', wyomingTtsPort: '10200' } },
    { app: 'codex-voice', options: { wyomingHost: 'hostB', wyomingSttPort: '9', wyomingTtsPort: '8' } },
  ] };
  migrateVoiceConfig(cfg);
  assert.equal(cfg.settings.voice.sttHost, 'hostA');           // first page seeds the global
  const b = cfg.grids[1].options;
  assert.equal(b.voiceOverride, true);
  assert.deepEqual({ h: b.voiceSttHost, sp: b.voiceSttPort, th: b.voiceTtsHost, tp: b.voiceTtsPort },
    { h: 'hostB', sp: '9', th: 'hostB', tp: '8' });
  assert.equal('wyomingHost' in b, false);
});

test('migration is idempotent and a no-op without legacy keys', () => {
  const cfg = { settings: { voice: { sttHost: 'keep', sttPort: '10300', ttsHost: 'keep', ttsPort: '10200' } },
    grids: [{ app: 'claude-voice', options: { projectDir: 'C:/x' } }] };
  const before = JSON.stringify(cfg);
  migrateVoiceConfig(cfg);
  assert.equal(JSON.stringify(cfg), before);
});

'use strict';
// App-local server for the Interactive Fiction player: Wyoming TTS (speak a passage) and STT
// (transcribe a spoken command), plus a listing of the stories/ folder.
//
// Reached from the page as GET/POST /app-api/<action>. Runs inside open-quake's main process, so it
// can resolve the host's own config.json for the globally configured Wyoming servers -- the app works
// with no setup when TTS/STT are already configured in Settings, and app options override per page.

const fs = require('fs');
const path = require('path');
const wyoming = require('./wyoming');

const STORY_EXT = new Set(['.z1', '.z2', '.z3', '.z4', '.z5', '.z6', '.z7', '.z8', '.zlb', '.zblorb',
  '.ulx', '.blb', '.blorb', '.glb', '.gblorb', '.dat']);
const MAX_AUDIO = 8 * 1024 * 1024;    // ~4 minutes of 16kHz mono PCM; an utterance is far smaller
const MAX_SPEAK = 4000;               // characters per synthesize call

// The host's global Wyoming settings (Settings -> TTS/STT). Read fresh each call so a settings change
// applies without restarting. Never throws -- a missing/unreadable config just yields no defaults.
function globalVoice() {
  try {
    const electron = require('electron');
    const userDir = electron && electron.app && electron.app.getPath('userData');
    if (!userDir) return {};
    const raw = fs.readFileSync(path.join(userDir, 'config.json'), 'utf8');
    const cfg = JSON.parse(raw);
    const v = cfg && cfg.settings && cfg.settings.voice;
    return v && typeof v === 'object' ? v : {};
  } catch (e) { return {}; }
}

function endpoints(options) {
  const g = globalVoice();
  const opt = options || {};
  const pick = (a, b, fallback) => String(a || b || fallback || '').trim();
  return {
    tts: { host: pick(opt.ttsHost, g.ttsHost), port: pick(opt.ttsPort, g.ttsPort, '10200') },
    stt: { host: pick(opt.sttHost, g.sttHost), port: pick(opt.sttPort, g.sttPort, '10300') },
  };
}

function listStories() {
  const dir = path.join(__dirname, 'stories');
  let names = [];
  try { names = fs.readdirSync(dir); } catch (e) { return []; }
  return names
    .filter(n => STORY_EXT.has(path.extname(n).toLowerCase()))
    .filter(n => { try { return fs.statSync(path.join(dir, n)).isFile(); } catch (e) { return false; } })
    .sort((a, b) => a.localeCompare(b));
}

async function handle(action, context) {
  const options = context && context.options || {};
  const query = context && context.query || {};
  const ends = endpoints(options);

  // What the page needs to render: which stories are available and whether voice is usable at all.
  if (action === 'config') {
    return { ok: true, stories: listStories(), tts: !!ends.tts.host, stt: !!ends.stt.host };
  }

  // Speak one passage. Audio comes back as a base64 WAV: /app-api/ is a JSON channel, and an
  // utterance-sized clip is small enough that base64 over loopback costs nothing meaningful.
  if (action === 'speak') {
    const text = String((context.body ? context.body.toString('utf8') : query.text) || '').slice(0, MAX_SPEAK).trim();
    if (!text) return { ok: false, error: 'nothing to speak' };
    if (!ends.tts.host) return { ok: false, error: 'No TTS server configured (Settings → TTS/STT).' };
    const chunks = [];
    let format = null;
    try {
      await wyoming.synthesize({
        host: ends.tts.host, port: ends.tts.port, text,
        onFormat: f => { format = f; },
        onChunk: b => chunks.push(b),
      });
    } catch (e) {
      return { ok: false, error: 'TTS failed: ' + (e.message || 'unknown error') };
    }
    const pcm = Buffer.concat(chunks);
    if (!pcm.length) return { ok: false, error: 'TTS returned no audio' };
    // Real length is known here, so write a correct WAV header rather than the streaming sentinel.
    const header = wyoming.wavHeader(format || {});
    header.writeUInt32LE(36 + pcm.length, 4);
    header.writeUInt32LE(pcm.length, 40);
    return { ok: true, wav: Buffer.concat([header, pcm]).toString('base64') };
  }

  // Transcribe one captured utterance (raw 16kHz mono Int16 PCM in the POST body).
  if (action === 'listen') {
    const audio = context && context.body;
    if (!audio || !audio.length) return { ok: false, error: 'no audio' };
    if (audio.length > MAX_AUDIO) return { ok: false, error: 'audio too long' };
    if (!ends.stt.host) return { ok: false, error: 'No STT server configured (Settings → TTS/STT).' };
    try {
      const text = await wyoming.transcribe({ host: ends.stt.host, port: ends.stt.port, audio });
      return { ok: true, text: String(text || '').trim() };
    } catch (e) {
      return { ok: false, error: 'STT failed: ' + (e.message || 'unknown error') };
    }
  }

  return { ok: false, error: 'unknown action' };
}

module.exports = { handle };

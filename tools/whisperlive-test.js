'use strict';
// WhisperLive real-time speech-translation VALIDATION HARNESS.
// Connects to a WhisperLive (collabora) WebSocket, sends the exact handshake open-quake's Live
// Translate page sends, streams a 16 kHz mono WAV as float32 (paced ~real-time), and DUMPS every
// message the server returns. Purpose: prove — independently of the open-quake UI — whether the
// container (a) accepts the connection, (b) reaches SERVER_READY, and (c) actually returns
// translation, and IN WHAT FIELD. This is the binding-constraint test for the WhisperLive provider.
//
// Run it on the box that can reach the container (has german.wav on it):
//   node whisperlive-test.js ws://192.168.1.25:19000 german.wav en de 30
//   arg1 = WS url (ws:// or wss://; http(s):// is normalized)   arg2 = WAV path (default german.wav)
//   arg3 = target lang (default en)   arg4 = source hint (optional)   arg5 = max seconds to stream (default 30)
const fs = require('fs');
const WebSocket = require('ws');

let url = process.argv[2] || 'ws://127.0.0.1:19000';
const wavPath = process.argv[3] || 'german.wav';
const target = process.argv[4] || 'en';
const sourceHint = process.argv[5] || null;
const maxSeconds = parseFloat(process.argv[6] || '30');

// Accept http(s):// and normalize to ws(s):// so a reverse-proxy URL pasted as https:// still works.
url = url.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:');
if (!/^wss?:\/\//i.test(url)) { console.error('URL must be ws:// or wss:// (got: ' + url + ')'); process.exit(1); }

// Minimal WAV reader — expects PCM 16-bit mono. Returns { sampleRate, pcm(Int16 view) }.
function readWav(p) {
  const b = fs.readFileSync(p);
  if (b.toString('ascii', 0, 4) !== 'RIFF' || b.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let off = 12, fmt = null, dataOff = -1, dataLen = 0;
  while (off + 8 <= b.length) {
    const id = b.toString('ascii', off, off + 4);
    const sz = b.readUInt32LE(off + 4);
    if (id === 'fmt ') fmt = { channels: b.readUInt16LE(off + 10), sampleRate: b.readUInt32LE(off + 12), bits: b.readUInt16LE(off + 22) };
    else if (id === 'data') { dataOff = off + 8; dataLen = sz; }
    off += 8 + sz + (sz & 1);
  }
  if (!fmt || dataOff < 0) throw new Error('missing fmt/data chunk');
  return { sampleRate: fmt.sampleRate, channels: fmt.channels, bits: fmt.bits, pcm: b.subarray(dataOff, dataOff + dataLen) };
}

let wav;
try { wav = readWav(wavPath); } catch (e) { console.error('WAV error:', e.message); process.exit(1); }
if (wav.bits !== 16 || wav.channels !== 1) {
  console.error(`Expected 16-bit mono WAV; got ${wav.bits}-bit ${wav.channels}ch.`);
  console.error('Convert with:  ffmpeg -i input.mp3 -ar 16000 -ac 1 german.wav');
  process.exit(1);
}
if (wav.sampleRate !== 16000) console.error(`WARN: WAV is ${wav.sampleRate} Hz; WhisperLive wants 16000. Re-encode with -ar 16000 for a valid test.`);

// int16 PCM -> float32 in [-1,1], the format WhisperLive expects on the wire.
const totalSamples = Math.floor(wav.pcm.length / 2);
const f32 = new Float32Array(totalSamples);
for (let i = 0; i < totalSamples; i++) f32[i] = wav.pcm.readInt16LE(i * 2) / 32768;

console.log(`WAV: ${wav.sampleRate} Hz mono, ${(totalSamples / wav.sampleRate).toFixed(1)}s (streaming up to ${maxSeconds}s)`);
console.log(`Connecting to ${url}  →  translate to "${target}"${sourceHint ? ` (source hint: ${sourceHint})` : ''}\n`);

const uid = 'probe-' + Date.now();
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
let sawReady = false, readyMs = 0, sawSegments = false, sawTranslated = false, lastTranslated = '', lastOriginal = '', errored = false;
let readyTimer = null, dataMsgCount = 0;

const ws = new WebSocket(url);
ws.binaryType = 'arraybuffer';

ws.on('open', () => {
  console.log(`[${el()}] WS OPEN — sending handshake`);
  const handshake = { uid, language: sourceHint || null, task: 'transcribe', model: process.env.WL_MODEL || 'large-v3',
    use_vad: true, send_last_n_segments: 10, enable_translation: true, target_language: target };
  console.log('  handshake: ' + JSON.stringify(handshake));
  ws.send(JSON.stringify(handshake));
  // If SERVER_READY never comes, the image/model is the problem — say so instead of hanging forever.
  readyTimer = setTimeout(() => {
    if (!sawReady) { console.error(`\n[${el()}] NO SERVER_READY after 120s — model still loading, wrong image, or the server rejected the handshake. Check the container logs.`); finish(); }
  }, 120000);
});

ws.on('message', (data) => {
  let raw; try { raw = Buffer.isBuffer(data) ? data.toString('utf8') : (typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); } catch (e) { return; }
  let msg; try { msg = JSON.parse(raw); } catch (e) { console.log(`[${el()}] non-JSON message (${raw.length} bytes)`); return; }
  if (msg.uid && msg.uid !== uid) return;

  if (msg.message === 'SERVER_READY' || msg.status === 'SERVER_READY') {
    sawReady = true; readyMs = Date.now() - t0;
    console.log(`[${el()}] SERVER_READY  (backend: ${msg.backend || '?'})  — full: ${JSON.stringify(msg)}`);
    startStreaming();
    return;
  }
  if (msg.message === 'WAIT' || msg.status === 'WAIT') { console.log(`[${el()}] WAIT (server busy): ${JSON.stringify(msg)}`); return; }
  if (msg.status === 'ERROR' || msg.message === 'ERROR' || msg.error) { errored = true; console.error(`[${el()}] SERVER ERROR: ${JSON.stringify(msg)}`); return; }
  if (msg.message === 'DISCONNECT') { console.log(`[${el()}] DISCONNECT: ${JSON.stringify(msg)}`); return; }

  // Any message carrying segment data — this is where we learn the REAL translation schema.
  const keys = Object.keys(msg);
  if (msg.segments) { sawSegments = true; const s = msg.segments[msg.segments.length - 1]; if (s && s.text) lastOriginal = String(s.text).trim(); }
  if (msg.translated_segments) { sawTranslated = true; const s = msg.translated_segments[msg.translated_segments.length - 1]; if (s && s.text) lastTranslated = String(s.text).trim(); }
  // First few data messages: print the FULL raw so we see exact field names (segments vs translated_segments vs inline).
  if (dataMsgCount < 3) { console.log(`[${el()}] data msg (keys: ${keys.join(', ')}):\n  ${raw.slice(0, 600)}`); }
  else { console.log(`[${el()}] segments: orig="${lastOriginal.slice(-60)}" | translated="${lastTranslated.slice(-60)}"`); }
  dataMsgCount++;
});

ws.on('error', (e) => { console.error(`[${el()}] WS ERROR: ${e.message}  (is the container up and reachable on that host:port?)`); errored = true; });
ws.on('close', (code, reason) => { console.log(`[${el()}] WS CLOSED (code ${code}${reason && reason.length ? ', ' + reason : ''})`); finish(); });

function startStreaming() {
  const chunk = 1600;                 // 100 ms of 16 kHz float32
  const bytesLimit = Math.floor(maxSeconds * 16000);
  let pos = 0;
  const timer = setInterval(() => {
    if (ws.readyState !== 1) { clearInterval(timer); return; }
    if (pos >= totalSamples || pos >= bytesLimit) {
      clearInterval(timer);
      console.log(`[${el()}] end of stream — sending END_OF_AUDIO, waiting 6s for final translation`);
      try { ws.send('END_OF_AUDIO'); } catch (e) {}
      setTimeout(finish, 6000);
      return;
    }
    const slice = f32.subarray(pos, Math.min(pos + chunk, totalSamples));
    try { ws.send(Buffer.from(slice.buffer, slice.byteOffset, slice.byteLength)); } catch (e) {}
    pos += chunk;
  }, 100);
}

let finished = false;
function finish() {
  if (finished) return; finished = true;
  if (readyTimer) clearTimeout(readyTimer);
  console.log('\n=== RESULT ===');
  console.log('Connected            :', 'yes (WS opened)');
  console.log('SERVER_READY         :', sawReady ? `yes (${(readyMs / 1000).toFixed(1)}s to load)` : 'NO — server never became ready');
  console.log('Got segments (orig)  :', sawSegments ? `yes — last: "${lastOriginal}"` : 'no');
  console.log('Got TRANSLATION      :', sawTranslated ? `yes — last: "${lastTranslated}"` : 'NO — no translated_segments field seen');
  console.log('Server error         :', errored ? 'YES (see above)' : 'no');
  console.log('\nRead the "data msg" dumps above: if translation is present under a DIFFERENT field name than');
  console.log('translated_segments, that name is the fix for the open-quake client.');
  try { ws.close(); } catch (e) {}
  process.exit(0);
}

'use strict';
// Hand-rolled Wyoming protocol client (STT via wyoming-faster-whisper, TTS via wyoming-piper). No
// maintained JS/npm client exists for this protocol (confirmed by research before writing this) --
// only Python reference implementations -- but the wire format is simple enough not to need one:
// a newline-terminated JSON header line, optionally followed by exactly `payload_length` raw bytes
// (e.g. PCM audio) immediately after the newline. See docs/claude-voice.md for the source links.
//
// STT sample rate/width/channels (16000Hz, 16-bit, mono): this is the standard Whisper/Wyoming-
// ecosystem convention, not something the client needs to renegotiate per request. TTS format is
// NOT assumed the same way -- Piper voices can differ in sample rate, so synthesize() reads the
// real {rate, width, channels} back from the server's own audio-start reply rather than guessing.
// Neither of these has been verified against this user's actual running containers yet (no live
// connection made to their homelab from here) -- flagged in docs/claude-voice.md as a one-time
// check to do once they're back.

const net = require('net');

function writeMessage(socket, type, data, payload) {
  const header = { type };
  if (data !== undefined) header.data = data;
  if (payload) header.payload_length = payload.length;
  socket.write(JSON.stringify(header) + '\n');
  if (payload) socket.write(payload);
}

// Feeds `socket`'s data events through the header(+payload) framing, calling
// onMessage({type, data, payload}) once per complete message.
function createReader(socket, onMessage) {
  let buf = Buffer.alloc(0);
  let pendingHeader = null;   // set while waiting for a header's declared payload_length bytes
  function pump() {
    for (;;) {
      if (pendingHeader) {
        const need = pendingHeader.payload_length || 0;
        if (buf.length < need) return;
        const payload = need ? buf.subarray(0, need) : null;
        buf = buf.subarray(need);
        const header = pendingHeader; pendingHeader = null;
        onMessage({ type: header.type, data: header.data, payload });
        continue;
      }
      const nl = buf.indexOf(0x0a);
      if (nl < 0) return;
      const line = buf.subarray(0, nl).toString('utf8');
      buf = buf.subarray(nl + 1);
      if (!line.trim()) continue;
      let header;
      try { header = JSON.parse(line); } catch (e) { continue; }
      if (header.payload_length) { pendingHeader = header; continue; }
      onMessage({ type: header.type, data: header.data, payload: null });
    }
  }
  socket.on('data', chunk => { buf = Buffer.concat([buf, chunk]); pump(); });
}

// One-shot STT: audio-start/audio-chunk(+PCM)/audio-stop -> resolves with the transcript text.
// `audio` is a single Buffer of the whole (VAD-trimmed) utterance -- fine to send as one chunk for
// utterance-length clips (a few seconds); no need to sub-chunk for something this short.
function transcribe({ host, port, audio, rate, width, channels, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port: Number(port) });
    let settled = false;
    const finish = (err, text) => {
      if (settled) return; settled = true;
      try { socket.destroy(); } catch (e) {}
      err ? reject(err) : resolve(text);
    };
    socket.on('error', finish);
    socket.on('close', () => finish(new Error('Wyoming STT: connection closed before a transcript arrived')));
    socket.setTimeout(timeoutMs || 20000, () => finish(new Error('Wyoming STT request timed out')));
    createReader(socket, msg => { if (msg.type === 'transcript') finish(null, (msg.data && msg.data.text) || ''); });
    socket.on('connect', () => {
      const fmt = { rate: rate || 16000, width: width || 2, channels: channels || 1 };
      writeMessage(socket, 'audio-start', fmt);
      writeMessage(socket, 'audio-chunk', fmt, audio);
      writeMessage(socket, 'audio-stop', {});
    });
  });
}

// One-shot TTS: synthesize -> audio-start (carries the real format)/audio-chunk(s)+PCM/audio-stop.
// `onFormat({rate,width,channels})` fires once, as soon as audio-start arrives, so a caller (the
// /claude-voice/tts-audio/:id route) can write a correctly-sized WAV header before any audio bytes
// exist yet. `onChunk(buffer)` fires per audio-chunk, for piping straight into an HTTP response.
function synthesize({ host, port, text, onFormat, onChunk, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port: Number(port) });
    let settled = false;
    let format = null;
    const finish = (err) => {
      if (settled) return; settled = true;
      try { socket.destroy(); } catch (e) {}
      err ? reject(err) : resolve(format);
    };
    socket.on('error', finish);
    socket.on('close', () => { if (!settled) finish(new Error('Wyoming TTS: connection closed before audio-stop')); });
    socket.setTimeout(timeoutMs || 30000, () => finish(new Error('Wyoming TTS request timed out')));
    createReader(socket, msg => {
      if (msg.type === 'audio-start') { format = msg.data || {}; if (onFormat) onFormat(format); }
      else if (msg.type === 'audio-chunk' && msg.payload) { if (onChunk) onChunk(msg.payload); }
      else if (msg.type === 'audio-stop') finish(null);
    });
    socket.on('connect', () => { writeMessage(socket, 'synthesize', { text }); });
  });
}

// 44-byte canonical WAV/PCM header for streaming playback where the total length isn't known yet
// (we're piping audio-chunk payloads straight through as they arrive from Wyoming). The RIFF and
// data chunk sizes use the standard "streaming" sentinel (0xFFFFFFFF) -- browsers play a WAV with an
// oversized declared length just fine as long as the byte stream itself ends when the HTTP response
// does, which is exactly what happens here once Wyoming's audio-stop closes out the pipe.
function wavHeader({ rate, width, channels }) {
  const numChannels = channels || 1, bitsPerSample = (width || 2) * 8, sampleRate = rate || 22050;
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8);
  const blockAlign = numChannels * (bitsPerSample / 8);
  const buf = Buffer.alloc(44);
  buf.write('RIFF', 0); buf.writeUInt32LE(0xFFFFFFFF, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(numChannels, 22);
  buf.writeUInt32LE(sampleRate, 24); buf.writeUInt32LE(byteRate, 28); buf.writeUInt16LE(blockAlign, 32); buf.writeUInt16LE(bitsPerSample, 34);
  buf.write('data', 36); buf.writeUInt32LE(0xFFFFFFFF, 40);
  return buf;
}

module.exports = { transcribe, synthesize, wavHeader };

'use strict';
// recorder-preload.js
//
// Preload for the hidden meeting-recorder window (main-owned, show:false). Bridges
// the served /recorder page to main: main sends start/stop/setMic commands; the page
// streams captured PCM frames and lifecycle events back. The page itself has no Node
// access (contextIsolation) — it only sees window.recorderAPI.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('recorderAPI', {
  // main -> page commands: { type:'start'|'stop'|'setMic', mic, echoGate, sampleRate }
  onCommand(cb) {
    ipcRenderer.on('recorder-cmd', (_e, msg) => { try { cb(msg); } catch (e) {} });
  },
  // Tell main the page has loaded and is ready to receive commands.
  ready() { ipcRenderer.send('recorder-ready'); },
  // Stream one captured frame. `buf` is a transferable ArrayBuffer of interleaved
  // stereo int16 ([mic0,sys0,...]); meta = { micRms, systemRms, micGated }.
  sendPcm(buf, meta) { ipcRenderer.send('recorder-pcm', buf, meta); },
  // Capture went live / stopped / the shared source ended on its own / errored.
  sendState(state, detail) { ipcRenderer.send('recorder-state', state, detail || ''); },
  sendEnded() { ipcRenderer.send('recorder-ended'); },
  sendError(message) { ipcRenderer.send('recorder-error', String(message || '')); },
});

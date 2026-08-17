'use strict';
// slidecapture-preload.js
//
// Preload for the hidden slide-capture window (main-owned, show:false). Bridges the served
// /slidecapture page to main. Main sends start/stop/grab commands and the chosen desktop source
// id; the page runs getDisplayMedia, downsamples each poll to a thumbnail, and ships the raw
// thumbnail bytes + brightness stats back. Main runs the settle-detection engine and, when it
// decides to save, asks the page for one full-resolution PNG. The page has no Node access
// (contextIsolation) — it only sees window.slideAPI.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('slideAPI', {
  // main -> page: { type:'start', sourceId } | { type:'stop' } | { type:'grab' }
  onCommand(cb) { ipcRenderer.on('slide-cmd', (_e, msg) => { try { cb(msg); } catch (e) {} }); },
  ready() { ipcRenderer.send('slide-ready'); },
  // One downsampled frame per poll: buf = transferable ArrayBuffer of THUMB_W*THUMB_H RGBA bytes;
  // meta = { meanLuma, nonBlack } (0..255, 0..1) for minimized/blank detection.
  sendThumb(buf, meta) { ipcRenderer.send('slide-thumb', buf, meta); },
  // Full-resolution PNG for a save (auto or manual), in reply to a 'grab' command.
  sendFrame(buf) { ipcRenderer.send('slide-frame', buf); },
  // 'capturing' | 'stopped' | 'error' | 'source-ended', with an optional detail string.
  sendStatus(state, detail) { ipcRenderer.send('slide-status', state, detail || ''); },
});

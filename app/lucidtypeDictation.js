'use strict';
// lucidtypeDictation.js — MAIN PROCESS
//
// LucidType dictation controller. Owns a hidden, main-owned capture window (lucidtype-dictate.html)
// that runs getUserMedia + the shared energy VAD and streams each trimmed utterance (Int16 16 kHz mono
// PCM) back to main; main transcribes it via the injected `transcribe()` (Wyoming/Whisper) and appends
// it to the running transcript. The panel page (/lucidtype) displays that transcript and lets the user
// edit it; Apply pastes it at the PC cursor (handled in main). Mirrors meetingRecorder.js: a persistent
// hidden window keeps capture independent of whatever the visible panel shows.
//
// deps: {
//   createWindow()            -> a hidden BrowserWindow loading /lucidtype-dictate (session + preload set by main)
//   resolveSettings()         -> { micDevice, silenceMs, notifyBeep }
//   resolveEndpoints()        -> { sttHost, sttPort, ttsHost, ttsPort }
//   transcribe({host,port,audio}) -> Promise<string>   (already noise-filtered)
//   onState(state)            -> fires on every state change (tray/switch hooks in main)
//   log(msg)
// }

function createLucidDictation(deps) {
  const d = deps || {};
  const log = d.log || (() => {});
  let win = null;
  let dictating = false;
  let transcript = '';
  let seq = 0;
  let pending = 0;   // in-flight transcriptions — lets us hold "stop" as busy until the tail settles

  function state() { return { dictating, transcript, seq, pending }; }
  function notify() { try { if (d.onState) d.onState(state()); } catch (e) {} }
  function bump() { seq = (seq + 1) % 2147483647; notify(); }

  function ensureWindow() {
    if (win && !win.isDestroyed()) return win;
    try { win = d.createWindow(); } catch (e) { log('createWindow failed: ' + e.message); win = null; return null; }
    if (win) win.on('closed', () => { win = null; });
    return win;
  }
  function sendCmd(msg) {
    const w = ensureWindow();
    if (!w || w.isDestroyed()) return;
    const post = () => { try { w.webContents.send('lucid-cmd', msg); } catch (e) { log('sendCmd error: ' + e.message); } };
    if (w.webContents.isLoading()) w.webContents.once('did-finish-load', post); else post();
  }

  // Called by main when the hidden window streams one utterance (a Node Buffer of Int16 PCM).
  async function onUtterance(pcmBuf) {
    if (!dictating || !pcmBuf || !pcmBuf.length) return;
    const ep = d.resolveEndpoints ? d.resolveEndpoints() : {};
    if (!ep.sttHost || !ep.sttPort) { log('utterance dropped: no STT endpoint configured'); return; }
    pending += 1;
    try {
      const text = await d.transcribe({ host: ep.sttHost, port: ep.sttPort, audio: pcmBuf });
      if (text) { transcript = transcript ? (transcript + ' ' + text) : text; bump(); }
    } catch (e) {
      log('transcribe error: ' + e.message);
    } finally {
      pending = Math.max(0, pending - 1);
    }
  }

  function start() {
    if (dictating) return { ok: true, dictating: true };
    const s = d.resolveSettings ? d.resolveSettings() : {};
    if (s.startMode !== 'append') transcript = '';     // 'clear' (default): fresh box; 'append': keep + add to existing text
    dictating = true;
    sendCmd({ type: 'start', micDevice: s.micDevice || '', silenceMs: s.silenceMs || 800, beep: !!s.notifyBeep });
    bump();
    log('dictation start');
    return { ok: true, dictating: true };
  }
  function stop() {
    if (!dictating) return { ok: true, dictating: false };
    dictating = false;
    const s = d.resolveSettings ? d.resolveSettings() : {};
    sendCmd({ type: 'stop', beep: !!s.notifyBeep });
    bump();
    log('dictation stop');
    return { ok: true, dictating: false };
  }
  function toggle() { return dictating ? stop() : start(); }

  // The editor (panel textarea) is the source of truth after a stop; keep main's copy in sync so the
  // global Apply hotkey pastes exactly what the user sees. No seq bump — don't echo it back and clobber.
  function setTranscript(text) { transcript = String(text == null ? '' : text); return { ok: true }; }
  function currentText() { return transcript; }

  return { ensureWindow, onUtterance, start, stop, toggle, state, setTranscript, currentText, isDictating: () => dictating };
}

module.exports = { createLucidDictation };

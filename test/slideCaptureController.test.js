'use strict';
// slideCapture controller: Manual capture is a SINGLE shot. When invoked without a running
// capture it may spin the stream up for one frame, but it must NOT leave automatic settle-capture
// running afterwards (regression: clicking "Manual capture" started continuous auto-capture).

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSlideCapture } = require('../app/slideCapture');

// Minimal deps: capture window is a fake whose webContents.send records the last IPC command.
function makeCapture() {
  const cmds = [];
  const fakeWin = {
    isDestroyed: () => false,
    on: () => {},
    webContents: { send: (_ch, msg) => cmds.push(msg) },
    destroy: () => {},
  };
  const sc = createSlideCapture({
    resolveSettings: () => ({ slideCaptureEnabled: true }),
    resolveActiveRecording: () => ({ folder: 'X', base: 'rec' }),
    createWindow: () => fakeWin,
    onState: () => {},
    log: () => {},
  });
  sc.ensureWindow();
  sc.onReady();                 // mark the capture window ready so sendCmd delivers
  sc.selectWindow('window:1:0', 'Deck');
  return { sc, cmds };
}

test('Manual capture (standalone) does not leave auto-capture running', () => {
  const { sc, cmds } = makeCapture();
  const r = sc.manual();
  assert.equal(r.ok, true);
  assert.ok(cmds.some(c => c.type === 'grab'), 'sent a grab');
  assert.equal(sc.getState().capturing, true, 'stream is live while the frame is in flight');

  // The full-res PNG comes back; onFrame writes it (folder is bogus so the write throws and is
  // swallowed — we only care that capture is torn down, not that the file lands).
  sc.onFrame(Buffer.from([1, 2, 3]));
  assert.equal(sc.getState().capturing, false, 'auto-capture torn down after the single shot');
  assert.ok(cmds.some(c => c.type === 'stop'), 'sent a stop');
});

test('Manual capture while auto-capture is running leaves it running', () => {
  const { sc } = makeCapture();
  sc.start();                                   // user explicitly started auto-capture
  assert.equal(sc.getState().capturing, true);
  sc.manual();
  sc.onFrame(Buffer.from([1, 2, 3]));
  assert.equal(sc.getState().capturing, true, 'explicit auto-capture is not stopped by a manual grab');
});

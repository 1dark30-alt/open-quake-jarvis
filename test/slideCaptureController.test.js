'use strict';
// slideCapture controller: Manual capture is a SINGLE shot. When no capture is running it spins the
// stream up for ONE frame and tears it down again — it must never start the continuous auto-capture
// (regression: clicking "Manual capture" left a capture session running). A Manual grab taken while
// auto-capture is already live just piggybacks on it and leaves it running.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSlideCapture } = require('../app/slideCapture');

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
  sc.onReady();
  sc.selectWindow('window:1:0', 'Deck');
  return { sc, cmds };
}
const has = (cmds, type) => cmds.some(c => c.type === type);

test('Manual capture (standalone) tears the stream down after one frame', () => {
  const { sc, cmds } = makeCapture();
  const r = sc.manual();
  assert.equal(r.ok, true);
  assert.ok(has(cmds, 'grab'), 'sent a grab');
  assert.equal(sc.getState().capturing, true, 'stream is briefly live while the frame is in flight');

  sc.onFrame(Buffer.from([1, 2, 3]));   // full-res PNG returns (bogus folder -> write throws, swallowed)
  assert.equal(sc.getState().capturing, false, 'nothing left running after the single shot');
  assert.ok(has(cmds, 'stop'), 'stream torn down');
});

test('Manual capture while auto-capture is running leaves it running', () => {
  const { sc } = makeCapture();
  sc.start();                                   // user explicitly started auto-capture
  assert.equal(sc.getState().capturing, true);
  sc.manual();
  sc.onFrame(Buffer.from([1, 2, 3]));
  assert.equal(sc.getState().capturing, true, 'auto-capture is not stopped by a Manual grab');
});

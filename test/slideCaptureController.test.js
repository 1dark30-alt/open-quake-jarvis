'use strict';
// slideCapture controller: Manual capture is a SINGLE shot. It grabs one frame using the live
// capture stream but must NOT enable the automatic settle-capture (regression: clicking "Manual
// capture" started continuous auto-capture). The panel's Start/Stop toggle (state.capturing)
// reflects AUTO capture, not the hidden stream a Manual grab keeps alive.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSlideCapture } = require('../app/slideCapture');
const { THUMB_W, THUMB_H } = require('../app/slideCaptureEngine');

// Lit (non-black) RGBA thumbnail as an ArrayBuffer, matching what the capture page ships.
function thumb(level) {
  const u = new Uint8ClampedArray(THUMB_W * THUMB_H * 4);
  for (let i = 0; i < u.length; i += 4) { u[i] = u[i + 1] = u[i + 2] = level; u[i + 3] = 255; }
  return u.buffer;
}
const META = { meanLuma: 120, nonBlack: 1 };   // passes looksBlank (lit content)

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
const grabs = cmds => cmds.filter(c => c.type === 'grab').length;

test('Manual capture grabs one frame without enabling auto-capture', () => {
  const { sc, cmds } = makeCapture();
  const r = sc.manual();
  assert.equal(r.ok, true);
  assert.equal(grabs(cmds), 1, 'sent exactly one grab');
  assert.equal(sc.getState().capturing, false, 'panel stays "Start capture" — Manual is not auto-capture');

  sc.onFrame(Buffer.from([1, 2, 3]));   // full-res PNG returns (bogus folder -> write throws, swallowed)
  assert.equal(sc.getState().capturing, false, 'still not auto-capturing after the grab');

  // Feed steady thumbnails: with auto-save off, a settled frame must NOT trigger any auto grab.
  for (let i = 0; i < 5; i++) sc.onThumb(thumb(100), META);
  assert.equal(grabs(cmds), 1, 'no automatic grabs after a Manual capture');
});

test('Start capture enables auto-capture; Manual during it leaves it running', () => {
  const { sc, cmds } = makeCapture();
  sc.start();
  assert.equal(sc.getState().capturing, true, 'Start capture => auto-capturing');

  // A settled new slide should auto-grab once auto-save is on.
  sc.onThumb(thumb(100), META);   // poll 1 seeds prevThumb (f2f=1, motion)
  sc.onThumb(thumb(100), META);   // poll 2: 1 stable
  sc.onThumb(thumb(100), META);   // poll 3: 2 stable -> settle -> auto grab
  assert.equal(grabs(cmds), 1, 'auto-capture grabbed a settled slide');

  sc.manual();
  assert.equal(sc.getState().capturing, true, 'a Manual grab does not stop running auto-capture');
});

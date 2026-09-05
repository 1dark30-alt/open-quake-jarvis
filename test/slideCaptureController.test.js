'use strict';
// slideCapture controller: Manual capture is a SINGLE shot — one grab, nothing left running.
// Regressions covered:
//  - clicking Manual started the continuous auto-capture and left it running
//  - first-ever Manual (capture window still loading) ghost-started auto-capture via pendingStart
//  - stale stopAfterManual from an aborted Manual killed a later Start-capture session

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSlideCapture } = require('../app/slideCapture');

function makeCapture(opts) {
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
  if (!opts || !opts.notReady) { sc.ensureWindow(); sc.onReady(); }   // window up and ready unless testing the load race
  sc.selectWindow('window:1:0', 'Deck');
  return { sc, cmds };
}
const count = (cmds, type) => cmds.filter(c => c.type === type).length;

test('Manual (standalone, window ready): one grab, then torn down', () => {
  const { sc, cmds } = makeCapture();
  const r = sc.manual();
  assert.equal(r.ok, true);
  assert.equal(count(cmds, 'grab'), 1);
  assert.equal(r.state.capturing, false, 'one-shot never reports capturing to the panel');

  sc.onFrame(Buffer.from([1, 2, 3]));   // PNG returns (bogus folder -> write throws, swallowed)
  assert.equal(sc.getState().capturing, false, 'nothing left running');
  assert.ok(count(cmds, 'stop') >= 1, 'stream torn down');
});

test('Manual while window still loading: grab queues, no ghost auto-capture', () => {
  const { sc, cmds } = makeCapture({ notReady: true });
  sc.ensureWindow();                    // window created but page not ready yet
  const r = sc.manual();
  assert.equal(r.ok, true, 'queued, not refused');
  assert.equal(count(cmds, 'grab'), 0, 'nothing sent while loading');

  sc.onReady();                         // page finishes loading -> start + queued grab ride out
  assert.equal(count(cmds, 'start'), 1);
  assert.equal(count(cmds, 'grab'), 1, 'queued Manual grab fired');

  sc.onFrame(Buffer.from([1, 2, 3]));
  assert.equal(sc.getState().capturing, false, 'no ghost capture session after the one-shot');
});

test('Manual while auto-capture is running leaves it running', () => {
  const { sc } = makeCapture();
  sc.start();
  assert.equal(sc.getState().capturing, true);
  sc.manual();
  sc.onFrame(Buffer.from([1, 2, 3]));
  assert.equal(sc.getState().capturing, true, 'auto-capture not stopped by a Manual grab');
});

test('Start capture after an aborted Manual is not killed by stale one-shot state', () => {
  const { sc } = makeCapture();
  sc.manual();                          // one-shot in flight (stopAfterManual set)
  sc.stop('user');                      // user stops before the frame arrives
  sc.start();                           // then starts a real auto session
  assert.equal(sc.getState().capturing, true);
  sc.onFrame(Buffer.from([1, 2, 3]));   // first auto save must NOT tear the session down
  assert.equal(sc.getState().capturing, true, 'auto session survives its first save');
});

test('stop() while window is loading clears pendingStart (no ghost start on ready)', () => {
  const { sc, cmds } = makeCapture({ notReady: true });
  sc.ensureWindow();
  sc.start();                           // parks pendingStart
  sc.stop('user');                      // user changes their mind before the page loads
  sc.onReady();
  assert.equal(count(cmds, 'start'), 0, 'parked start was discarded');
  assert.equal(sc.getState().capturing, false);
});

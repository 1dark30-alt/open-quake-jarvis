'use strict';
// slideCaptureEngine: the settle state machine (video never settles, slides save once each),
// the frame-diff metric, minimized-window detection, and file/folder naming.

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  THUMB_W, THUMB_H, STABLE_THRESHOLD, NEW_SLIDE_THRESHOLD,
  frameDiff, looksBlank, SettleDetector, screenshotsFolderName, slideFileName,
} = require('../app/slideCaptureEngine');

// Build a THUMB_W*THUMB_H RGBA buffer filled with one gray level (0..255).
function solid(level) {
  const buf = new Uint8ClampedArray(THUMB_W * THUMB_H * 4);
  for (let i = 0; i < buf.length; i += 4) { buf[i] = buf[i + 1] = buf[i + 2] = level; buf[i + 3] = 255; }
  return buf;
}

test('frameDiff: identical = 0, opposite extremes = 1, mismatched length = 1', () => {
  const a = solid(120);
  assert.equal(frameDiff(a, solid(120)), 0);
  assert.equal(frameDiff(solid(0), solid(255)), 1);
  assert.equal(frameDiff(a, new Uint8ClampedArray(8)), 1);
  // a small uniform delta is well below the stable threshold (1 level / 255 ≈ 0.0039)
  assert.ok(frameDiff(solid(120), solid(121)) < STABLE_THRESHOLD);
});

test('looksBlank: minimized (all-black) frame is blank; lit content is not', () => {
  assert.equal(looksBlank(0, 0), true);          // minimized window
  assert.equal(looksBlank(3, 0.02), true);       // near-black
  assert.equal(looksBlank(40, 0.9), false);      // real content
});

test('a static slide is saved exactly once, not on every stable poll', () => {
  const d = new SettleDetector();
  // frame identical to previous each poll (diff 0); no prior save so vsSaved ignored
  assert.equal(d.evaluate(0, 1), false);   // poll 1: stable=1, not yet
  assert.equal(d.evaluate(0, 1), true);    // poll 2: settled -> SAVE
  assert.equal(d.evaluate(0, 0), false);   // poll 3: still static, already saved -> no
  assert.equal(d.evaluate(0, 0), false);   // poll 4: still no
});

test('continuous video motion never settles, never saves', () => {
  const d = new SettleDetector();
  let saves = 0;
  for (let i = 0; i < 100; i++) {
    // every frame differs from the last by well over the stable threshold
    if (d.evaluate(0.2, 0.2)) saves++;
  }
  assert.equal(saves, 0);
});

test('a genuine slide change after a save is captured; a return to the same slide is not', () => {
  const d = new SettleDetector();
  // slide A settles and saves
  d.evaluate(0, 1); assert.equal(d.evaluate(0, 1), true);
  // motion (transition), then slide B settles and differs from A -> save
  assert.equal(d.evaluate(0.3, 0.3), false);            // motion resets
  assert.equal(d.evaluate(0, 0.5), false);              // stable=1
  assert.equal(d.evaluate(0, 0.5), true);               // settled + new content -> SAVE
  // motion, then content identical to the last SAVED slide -> settled but NOT new
  assert.equal(d.evaluate(0.3, 0.3), false);
  assert.equal(d.evaluate(0, 0.001), false);            // stable=1
  assert.equal(d.evaluate(0, 0.001), false);            // settled but vsSaved below threshold -> skip
});

test('a settled-but-tiny change (mouse cursor) below new-slide threshold is not saved', () => {
  const d = new SettleDetector();
  d.evaluate(0, 1); d.evaluate(0, 1);                   // save slide A
  d.evaluate(0.3, 0.3);                                 // motion
  const tiny = NEW_SLIDE_THRESHOLD / 2;
  d.evaluate(0, tiny);
  assert.equal(d.evaluate(0, tiny), false);             // settled, but not different enough from A
});

test('noteManualSave sets the baseline so the auto path does not immediately re-save', () => {
  const d = new SettleDetector();
  d.noteManualSave();
  // content identical to the manual capture settles but is not "new"
  d.evaluate(0, 0);
  assert.equal(d.evaluate(0, 0), false);
});

test('folder name is a wav sidecar; file name is capture-moment YYMMDD-HHMMSS-slideNNN', () => {
  assert.equal(screenshotsFolderName('2026-08-17-08-56-09'), '2026-08-17-08-56-09-screenshots');
  assert.equal(screenshotsFolderName('2026-08-17-08-56-09-Tech-Support-Weekly'),
    '2026-08-17-08-56-09-Tech-Support-Weekly-screenshots');
  // 2026-08-17 09:05:03 -> 20260817-090503-slide001.png
  const d = new Date(2026, 7, 17, 9, 5, 3);
  assert.equal(slideFileName(d, 1), '20260817-090503-slide001.png');
  assert.equal(slideFileName(d, 42), '20260817-090503-slide042.png');
});

'use strict';
/*
 * slideCaptureEngine.js — pure, DI-testable core of Meeting Slide Capture. [MIT]
 *
 * Ported from the standalone Slide Capture app (D:\Github\teams-meeting-screenshots,
 * C#/.NET). No Electron, no DOM, no fs — just the settle state machine, the frame-diff
 * metric, and the file/folder naming. The capture surface (a hidden BrowserWindow running
 * getDisplayMedia + canvas) feeds diffs in; the main process does the actual PNG writes.
 *
 * Why "settle detection" and not video-vs-slide classification: a slide holds still, so
 * consecutive frames are ~identical; a video feed never stops changing. Requiring N
 * consecutive near-identical polls before saving means video never qualifies — no separate
 * motion classifier needed. Same insight (and the same thresholds) as the source app.
 */

// Frame-diff metric constants — MUST match the renderer's downsample size so the thresholds
// below are on the same 0..1 scale as the C# FrameComparer they came from.
const THUMB_W = 384;
const THUMB_H = 216;

// Settle/new-slide thresholds (0..1 mean-abs-RGB diff). Ported verbatim from SlideMonitor.cs.
const STABLE_THRESHOLD = 0.005;   // frame-to-frame diff at/below this = "unchanged"
const NEW_SLIDE_THRESHOLD = 0.02; // a settled frame must differ from the last SAVED slide by more than this
const REQUIRED_STABLE_POLLS = 2;  // consecutive unchanged polls before a settled frame is eligible to save

// Mean absolute per-channel (R,G,B) difference of two RGBA pixel buffers, normalized to 0..1.
// Both buffers must be the same length (THUMB_W*THUMB_H*4). Alpha is ignored, matching the source.
function frameDiff(a, b) {
  if (!a || !b || a.length !== b.length || a.length === 0) return 1;
  let sum = 0;
  for (let i = 0; i + 3 < a.length; i += 4) {
    sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
  }
  const max = (a.length / 4) * 3 * 255;
  return max === 0 ? 0 : sum / max;
}

// A near-black, near-empty frame means the target window is minimized (Windows.Graphics.Capture
// / getDisplayMedia deliver an all-black surface for iconic windows) — the caller surfaces
// "restore the window" instead of saving black slides. meanLuma and nonBlackFraction are cheap
// to compute alongside the diff in the renderer.
function looksBlank(meanLuma, nonBlackFraction) {
  return !(meanLuma > 5 && nonBlackFraction > 0.05);
}

/*
 * The settle state machine. Feed it one diff pair per poll:
 *   frameToFrameDiff — this frame vs the previous poll's frame (drives stability)
 *   vsSavedDiff      — this frame vs the last SAVED slide (drives "is it actually new")
 * evaluate() returns true exactly once per settle event when a new slide should be saved.
 * The caller owns the pixel buffers and updates "last saved" when evaluate() returns true.
 */
class SettleDetector {
  constructor(opts = {}) {
    this.stableThreshold = opts.stableThreshold != null ? opts.stableThreshold : STABLE_THRESHOLD;
    this.newSlideThreshold = opts.newSlideThreshold != null ? opts.newSlideThreshold : NEW_SLIDE_THRESHOLD;
    this.required = opts.requiredStablePolls != null ? opts.requiredStablePolls : REQUIRED_STABLE_POLLS;
    this.reset();
  }

  reset() {
    this.stable = 0;
    this.hasSaved = false;   // until the first save, any settled frame qualifies (matches C# lastSaved == null)
  }

  // vsSavedDiff is ignored until the first save. Returns true => save this frame now.
  evaluate(frameToFrameDiff, vsSavedDiff) {
    if (frameToFrameDiff > this.stableThreshold) { this.stable = 0; return false; }   // motion -> not settled
    this.stable++;
    if (this.stable !== this.required) return false;   // fire exactly once at the settle boundary, never again until motion resets
    if (!this.hasSaved || vsSavedDiff > this.newSlideThreshold) { this.hasSaved = true; return true; }
    return false;   // settled, but same content as the last saved slide -> skip
  }

  // Manual capture bypasses settle detection entirely but still becomes the new "last saved"
  // baseline, so the automatic path won't immediately re-save the same content.
  noteManualSave() { this.hasSaved = true; this.stable = this.required; }
}

// zero-pad an integer to width n
function pad(v, n) { return String(v).padStart(n, '0'); }

// The screenshots folder is a sidecar of the recording: "<wav basename>-screenshots". It
// travels and renames exactly like the .json sidecar — when the wav gains a meeting name or
// moves through filing, this name is recomputed from the wav's new basename by the caller.
function screenshotsFolderName(wavBaseName) {
  return String(wavBaseName || '') + '-screenshots';
}

// Slide file name at the moment of capture: "YYYYMMDD-HHMMSS-slideNNN.png" (4-digit year, to
// match the wav-scoped enclosing folder). `date` is a Date; `index` is 1-based within the
// recording. Zero cross-file collision by design — the slide index is monotonic per session.
function slideFileName(date, index) {
  const d = date || new Date();
  const yyyy = pad(d.getFullYear(), 4);
  const mm = pad(d.getMonth() + 1, 2);
  const dd = pad(d.getDate(), 2);
  const hh = pad(d.getHours(), 2);
  const mi = pad(d.getMinutes(), 2);
  const ss = pad(d.getSeconds(), 2);
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}-slide${pad(index, 3)}.png`;
}

module.exports = {
  THUMB_W, THUMB_H,
  STABLE_THRESHOLD, NEW_SLIDE_THRESHOLD, REQUIRED_STABLE_POLLS,
  frameDiff, looksBlank, SettleDetector,
  screenshotsFolderName, slideFileName,
};

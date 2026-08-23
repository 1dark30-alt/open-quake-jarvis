'use strict';
// Pure helpers for the generic drop-in knob capability (tested in test/knobRouting.test.js).
//
// Any served app page can receive the panel knob: its manifest declares `"knob": true`, which makes
// every gesture default to the 'app' mode, and the page defines `window.oqKnob(event)` (see
// docs/drop-in-spec.md). Events arrive verbatim in the hardware vocabulary --
//   { type:'rotate', dir: 1|-1 }   one detent, CW = 1
//   { type:'press',  index: 1|2 }  single / double click (detected in hardware)
//   { type:'hold',   phase:'start'|'end' }
// -- and a page returns false (or doesn't define oqKnob) to decline an event back to the panel's
// default behavior, so the knob is never dead.

const KNOB_DEFAULT = { turn: 'pages', click: 'rotation', dblclick: 'selector' };

// The default knob modes for a page: an app page whose manifest declares "knob": true routes all
// three gestures to the app. The user's per-page-type settings and per-page override still win.
function knobDefaultFor(grid, appDef) {
  if (grid && grid.kind === 'app' && appDef && appDef.knob === true) return { turn: 'app', click: 'app', dblclick: 'app' };
  return KNOB_DEFAULT;
}

// OQX_RING::custom:{"hue":..,"sat":..,"effect":..,"speed":..} -> a clamped override object, or null
// for anything malformed (ignored, same as an unknown named state). Fields are optional; defaults
// mirror the named-state shape. effect is a QMK RGB-Matrix id (0..43); 0 = All Off is allowed but
// note the mic-LED reassert quirk is handled by the caller's pipeline, not here.
function parseCustomRing(state) {
  if (typeof state !== 'string' || state.indexOf('custom:') !== 0) return null;
  let c = null;
  try { c = JSON.parse(state.slice(7)); } catch (e) { return null; }
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const n = (v, dflt, max) => { const x = Math.round(Number(v)); return Number.isFinite(x) ? Math.max(0, Math.min(max, x)) : dflt; };
  return { hue: n(c.hue, 128, 255), sat: n(c.sat, 255, 255), effect: n(c.effect, 1, 43), speed: n(c.speed, 128, 255) };
}

module.exports = { KNOB_DEFAULT, knobDefaultFor, parseCustomRing };

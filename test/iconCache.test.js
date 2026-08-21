'use strict';
// iconCache: the launch-sweep keep rule (downloaded MDI glyphs must survive) and the offline gate.

const test = require('node:test');
const assert = require('node:assert/strict');
const { isManagedGlyph, shouldSweepIconFile, iconsOffline } = require('../app/iconCache');

test('isManagedGlyph matches only mdi-<name>.svg files', () => {
  assert.equal(isManagedGlyph('mdi-lightbulb.svg'), true);
  assert.equal(isManagedGlyph('mdi-weather-partly-cloudy.svg'), true);
  assert.equal(isManagedGlyph('MDI-Lightbulb.SVG'), true);            // case-insensitive
  assert.equal(isManagedGlyph('mdi-.svg'), false);                    // needs an actual name
  assert.equal(isManagedGlyph('lightbulb.svg'), false);              // missing prefix
  assert.equal(isManagedGlyph('3a7f0c9b1d2e4f56.png'), false);       // a URL-icon cache file (sha1)
  assert.equal(isManagedGlyph(''), false);
  assert.equal(isManagedGlyph(null), false);
});

test('shouldSweepIconFile keeps downloaded glyphs even when no tile references them', () => {
  const used = new Set(['3a7f0c9b1d2e4f56.png']);                     // one URL icon a tile still uses
  // MDI glyphs are resolved at render time and never recorded on a tile -> not in `used`, must survive.
  assert.equal(shouldSweepIconFile('mdi-lightbulb.svg', used), false);
  assert.equal(shouldSweepIconFile('mdi-account.svg', new Set()), false);
});

test('shouldSweepIconFile deletes stale URL icons, keeps referenced ones', () => {
  const used = new Set(['3a7f0c9b1d2e4f56.png']);
  assert.equal(shouldSweepIconFile('3a7f0c9b1d2e4f56.png', used), false);  // still used -> keep
  assert.equal(shouldSweepIconFile('deadbeefdeadbeef.png', used), true);   // orphaned -> delete
  assert.equal(shouldSweepIconFile('deadbeefdeadbeef.png', new Set()), true);
});

test('iconsOffline reads the settings flag, defaulting to online', () => {
  assert.equal(iconsOffline({ offlineIcons: true }), true);
  assert.equal(iconsOffline({ offlineIcons: false }), false);
  assert.equal(iconsOffline({}), false);
  assert.equal(iconsOffline(undefined), false);
  assert.equal(iconsOffline(null), false);
});

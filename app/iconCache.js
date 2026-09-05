'use strict';
// Pure decisions for the on-disk icon cache. main.js owns the fs + network side and injects the
// live settings; keeping these three predicates here makes them unit-testable without Electron.

// App-managed MDI glyph files are named `mdi-<name>.svg` (see fetchMdiToCache in main.js). They are a
// bounded, deterministic set the app downloads once from jsDelivr and recolors — NOT per-tile
// artifacts. The launch sweep must never treat them as orphans the way it does stale URL downloads,
// or every Home Assistant icon re-downloads on the next launch.
function isManagedGlyph(filename) {
  return /^mdi-[a-z0-9-]+\.svg$/i.test(String(filename || ''));
}

// Whether the launch sweep should delete a cache file. Delete only if no tile references it AND it
// isn't an app-managed glyph. `used` is a Set of basenames referenced by url/ha tiles' iconCache.
function shouldSweepIconFile(filename, used) {
  if (used && used.has(filename)) return false;
  if (isManagedGlyph(filename)) return false;
  return true;
}

// "Work offline" (Settings → Software). When on, the app makes no outbound icon requests — neither
// jsDelivr MDI glyphs nor URL icons — serving whatever is already cached/seeded and letting the
// emoji fallback cover the rest. Anything else is treated as online (the default).
function iconsOffline(settings) {
  return !!(settings && settings.offlineIcons);
}

module.exports = { isManagedGlyph, shouldSweepIconFile, iconsOffline };

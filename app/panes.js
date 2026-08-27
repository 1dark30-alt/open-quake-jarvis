'use strict';

const { resolveRunMode } = require('./runMode');

const MAX_PANE_SLOTS = 5;

// Pure pane helpers, shared by main.js and unit tests. A pane stacks 1..5 existing pages
// vertically so a software-mode window can fill taller screens. Panes only ever apply in
// software run mode; anything unset/broken resolves to null so the app degrades to the
// normal single-page window.

// Resolve a pane's slots to real page objects: empty/dangling pageIds are dropped, capped at 5.
function resolvePaneSlots(pane, grids) {
  const slots = (pane && Array.isArray(pane.slots)) ? pane.slots.slice(0, MAX_PANE_SLOTS) : [];
  const list = Array.isArray(grids) ? grids : [];
  return slots
    .map(s => s && s.pageId ? list.find(g => g && g.id === s.pageId) : null)
    .filter(Boolean);
}

// The single gate everything branches on: { pane, pages } when a pane should be displayed,
// null otherwise (wrong run mode, display set to pages, no such pane, or pane resolves empty).
function activePane(settings, panes, grids) {
  if (resolveRunMode(settings) !== 'software') return null;
  if (!settings || settings.softwareDisplay !== 'pane') return null;
  const list = Array.isArray(panes) ? panes : [];
  // Explicit pick wins; an unset/dead activePaneId falls back to the first pane that resolves to
  // pages — the user chose "Pane", so show one rather than silently reverting to Pages.
  let pane = list.find(p => p && p.id === settings.activePaneId);
  let pages = pane ? resolvePaneSlots(pane, grids) : [];
  if (!pages.length) {
    pane = list.find(p => resolvePaneSlots(p, grids).length);
    pages = pane ? resolvePaneSlots(pane, grids) : [];
  }
  return pages.length ? { pane, pages } : null;
}

module.exports = { resolvePaneSlots, activePane, MAX_PANE_SLOTS };

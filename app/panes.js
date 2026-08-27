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

// A pane's columns of resolved pages: [left] or [left, right]. slots = left column,
// slots2 = optional right column; the right column exists only while it has resolvable pages.
function resolvePaneColumns(pane, grids) {
  const left = resolvePaneSlots(pane, grids);
  const right = resolvePaneSlots(pane ? { slots: pane.slots2 } : null, grids);
  return right.length ? [left, right] : [left];
}
// The single gate everything branches on: { pane, pages, columns } when a pane should be displayed,
// null otherwise (wrong run mode, display set to pages, no such pane, or pane resolves empty).
// pages is the flattened column-major list (left column top-to-bottom, then right).
function activePane(settings, panes, grids) {
  if (resolveRunMode(settings) !== 'software') return null;
  if (!settings || settings.softwareDisplay !== 'pane') return null;
  const list = Array.isArray(panes) ? panes : [];
  const usable = p => resolvePaneColumns(p, grids).some(c => c.length);
  // Explicit pick wins; an unset/dead activePaneId falls back to the first pane that resolves to
  // pages — the user chose "Pane", so show one rather than silently reverting to Pages.
  let pane = list.find(p => p && p.id === settings.activePaneId);
  if (!pane || !usable(pane)) pane = list.find(usable);
  if (!pane) return null;
  const columns = resolvePaneColumns(pane, grids);
  return { pane, pages: columns.flat(), columns };
}

// Software-window geometry for a rows x cols grid of 1920x480 pages (cols 1 or 2). With `prev`
// (the window's last bounds) the user's position and width are kept — only the height follows the
// layout, clamped into the work area `wa`. Without prev: default width, centered.
function softwareWindowBounds(prev, wa, rows, cols) {
  cols = cols || 1;
  const unitW = 1920 * cols, unitH = 480 * Math.max(1, rows);
  let width = prev ? Math.max(760, prev.width) : Math.max(760, Math.min(1280 * cols, wa.width - 80));
  let height = Math.round(width * unitH / unitW);
  if (height > wa.height - 80) {                 // taller than the screen -> shrink to fit, keep the aspect
    height = wa.height - 80;
    width = Math.max(760, Math.round(height * unitW / unitH));
  }
  const x = prev ? Math.min(Math.max(prev.x, wa.x), wa.x + wa.width - width) : wa.x + Math.round((wa.width - width) / 2);
  const y = prev ? Math.min(Math.max(prev.y, wa.y), wa.y + wa.height - height) : wa.y + Math.round((wa.height - height) / 2);
  return { x, y, width, height };
}

module.exports = { resolvePaneSlots, resolvePaneColumns, activePane, softwareWindowBounds, MAX_PANE_SLOTS };

'use strict';

// panes: pure resolution of the software-mode page stack. Locks in that panes never activate
// outside software mode, that broken references degrade to null (normal window), and the 5-slot cap.

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePaneSlots, activePane, softwareWindowBounds, MAX_PANE_SLOTS } = require('../app/panes');

const grids = [
  { id: 'a', name: 'Grid A' },
  { id: 'b', name: 'Dash B', kind: 'web' },
  { id: 'c', name: 'App C', kind: 'app' },
];
const pane = (slots) => ({ id: 'p1', name: 'P', slots });
const sw = { runMode: 'software', softwareDisplay: 'pane', activePaneId: 'p1' };

test('resolvePaneSlots maps pageIds to pages, dropping empty and dangling', () => {
  const pages = resolvePaneSlots(pane([{ pageId: 'a' }, { pageId: '' }, { pageId: 'gone' }, { pageId: 'b' }]), grids);
  assert.deepEqual(pages.map(g => g.id), ['a', 'b']);
});

test('resolvePaneSlots clamps to MAX_PANE_SLOTS', () => {
  const slots = ['a', 'b', 'c', 'a', 'b', 'c', 'a'].map(pageId => ({ pageId }));
  assert.equal(resolvePaneSlots(pane(slots), grids).length, MAX_PANE_SLOTS);
});

test('resolvePaneSlots tolerates junk input', () => {
  assert.deepEqual(resolvePaneSlots(null, grids), []);
  assert.deepEqual(resolvePaneSlots({}, grids), []);
  assert.deepEqual(resolvePaneSlots(pane([{ pageId: 'a' }]), null), []);
});

test('activePane is null by default and outside software mode', () => {
  assert.equal(activePane(undefined, [pane([{ pageId: 'a' }])], grids), null);
  assert.equal(activePane({}, [pane([{ pageId: 'a' }])], grids), null);
  assert.equal(activePane({ ...sw, runMode: 'panel' }, [pane([{ pageId: 'a' }])], grids), null);
  assert.equal(activePane({ ...sw, runMode: 'monitor' }, [pane([{ pageId: 'a' }])], grids), null);
  assert.equal(activePane({ ...sw, softwareDisplay: 'pages' }, [pane([{ pageId: 'a' }])], grids), null);
});

test('activePane is null when no pane resolves to any pages', () => {
  assert.equal(activePane(sw, [], grids), null);
  assert.equal(activePane(sw, [pane([{ pageId: 'gone' }])], grids), null);
  assert.equal(activePane({ ...sw, activePaneId: 'nope' }, [pane([{ pageId: 'gone' }])], grids), null);
});

test('softwareWindowBounds: no previous bounds -> default width, centered', () => {
  const wa = { x: 0, y: 0, width: 2560, height: 1440 };
  const b = softwareWindowBounds(null, wa, 1);
  assert.deepEqual(b, { x: 640, y: 560, width: 1280, height: 320 });
});

test('softwareWindowBounds: rebuild keeps position and width, height follows slot count', () => {
  const wa = { x: 0, y: 0, width: 2560, height: 1440 };
  const prev = { x: 100, y: 100, width: 1000, height: 250 };
  assert.deepEqual(softwareWindowBounds(prev, wa, 1), { x: 100, y: 100, width: 1000, height: 250 });
  assert.deepEqual(softwareWindowBounds(prev, wa, 3), { x: 100, y: 100, width: 1000, height: 750 });
});

test('softwareWindowBounds: clamps into the work area', () => {
  const wa = { x: 0, y: 0, width: 1920, height: 1080 };
  // 5 units at width 1600 would be 4000 tall -> shrink to fit, position pulled back on-screen
  const b = softwareWindowBounds({ x: 1800, y: 1000, width: 1600, height: 400 }, wa, 5);
  assert.equal(b.height, 1000);
  assert.equal(b.width, Math.max(760, Math.round(1000 * 1920 / 2400)));
  assert.ok(b.x + b.width <= wa.width && b.y + b.height <= wa.height);
});

test('activePane falls back to the first usable pane when the picked id is unset or dead', () => {
  // Show=Pane saved before any pane was picked (activePaneId '') — must still display the pane.
  const unset = activePane({ ...sw, activePaneId: '' }, [pane([{ pageId: 'a' }])], grids);
  assert.equal(unset.pane.id, 'p1');
  const dead = activePane({ ...sw, activePaneId: 'nope' }, [
    { id: 'empty', slots: [{ pageId: 'gone' }] },
    pane([{ pageId: 'b' }]),
  ], grids);
  assert.equal(dead.pane.id, 'p1');   // skips the pane with no resolvable pages
  assert.deepEqual(dead.pages.map(g => g.id), ['b']);
});

test('activePane returns the pane and its resolved pages', () => {
  const r = activePane(sw, [pane([{ pageId: 'c' }, { pageId: 'a' }])], grids);
  assert.equal(r.pane.id, 'p1');
  assert.deepEqual(r.pages.map(g => g.id), ['c', 'a']);
});

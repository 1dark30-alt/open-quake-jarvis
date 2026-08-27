'use strict';

// panes: pure resolution of the software-mode page stack. Locks in that panes never activate
// outside software mode, that broken references degrade to null (normal window), and the 5-slot cap.

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolvePaneSlots, activePane, MAX_PANE_SLOTS } = require('../app/panes');

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

test('activePane is null when the pane is missing or resolves empty', () => {
  assert.equal(activePane(sw, [], grids), null);
  assert.equal(activePane({ ...sw, activePaneId: 'nope' }, [pane([{ pageId: 'a' }])], grids), null);
  assert.equal(activePane(sw, [pane([{ pageId: 'gone' }])], grids), null);
});

test('activePane returns the pane and its resolved pages', () => {
  const r = activePane(sw, [pane([{ pageId: 'c' }, { pageId: 'a' }])], grids);
  assert.equal(r.pane.id, 'p1');
  assert.deepEqual(r.pages.map(g => g.id), ['c', 'a']);
});

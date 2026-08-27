'use strict';

// configMerge: three-way merge of external config writes into a dirty editor. Locks in the rules:
// external-only changes fold in, editor-only changes stand, both-changed keeps the editor's version
// and reports the conflict, external adds/deletes apply unless the editor touched the unit.

const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeExternalConfig } = require('../app/configMerge');

const clone = o => JSON.parse(JSON.stringify(o));
const BASE = {
  activeGridId: 'a',
  settings: { runMode: 'software', softwareDisplay: 'pane', activePaneId: 'p1', rotation: { enabled: false } },
  grids: [
    { id: 'a', name: 'A', tiles: [{ type: 'counter', value: 3 }] },
    { id: 'b', name: 'B', kind: 'app', app: 'lucidtype', options: { rewriteMode: 'professional' } },
  ],
  groups: [],
  panes: [{ id: 'p1', name: 'P1', slots: [{ pageId: 'a' }] }],
};

test('external-only change folds into a dirty editor copy', () => {
  const editor = clone(BASE); editor.panes[0].name = 'Renamed';            // editor edit
  const fresh = clone(BASE); fresh.grids[0].tiles[0].value = 4;            // counter tapped
  fresh.settings.activePaneId = 'p2';                                       // pane switched
  const { merged, conflicts } = mergeExternalConfig(editor, BASE, fresh);
  assert.deepEqual(conflicts, []);
  assert.equal(merged.panes[0].name, 'Renamed');                            // editor edit kept
  assert.equal(merged.grids[0].tiles[0].value, 4);                          // external folded in
  assert.equal(merged.settings.activePaneId, 'p2');
});

test('both-changed unit: editor wins, conflict reported', () => {
  const editor = clone(BASE); editor.grids[1].options.rewriteMode = 'concise';
  const fresh = clone(BASE); fresh.grids[1].options.rewriteMode = 'confident';
  const { merged, conflicts } = mergeExternalConfig(editor, BASE, fresh);
  assert.equal(merged.grids[1].options.rewriteMode, 'concise');
  assert.deepEqual(conflicts, ['page "B"']);
});

test('external page add appears; external delete applies unless the editor touched the unit', () => {
  const editor = clone(BASE); editor.panes[0].name = 'Renamed';
  const fresh = clone(BASE);
  fresh.grids.push({ id: 'c', name: 'AI Panel' });                          // added by the panel
  fresh.grids = fresh.grids.filter(g => g.id !== 'a');                      // page a deleted externally
  const { merged, conflicts } = mergeExternalConfig(editor, BASE, fresh);
  assert.deepEqual(merged.grids.map(g => g.id), ['b', 'c']);
  assert.deepEqual(conflicts, []);
});

test('externally deleted unit the editor edited survives as a conflict', () => {
  const editor = clone(BASE); editor.grids[0].name = 'A edited';
  const fresh = clone(BASE); fresh.grids = fresh.grids.filter(g => g.id !== 'a');
  const { merged, conflicts } = mergeExternalConfig(editor, BASE, fresh);
  assert.deepEqual(merged.grids.map(g => g.id), ['a', 'b']);
  assert.deepEqual(conflicts, ['page "A edited"']);
});

test('editor deletion is not undone by an unrelated external write', () => {
  const editor = clone(BASE); editor.grids = editor.grids.filter(g => g.id !== 'b');
  const fresh = clone(BASE); fresh.grids[0].tiles[0].value = 9;
  const { merged, conflicts } = mergeExternalConfig(editor, BASE, fresh);
  assert.deepEqual(merged.grids.map(g => g.id), ['a']);
  assert.equal(merged.grids[0].tiles[0].value, 9);
  assert.deepEqual(conflicts, []);
});

test('editor-added unit (unsaved new pane) survives the merge', () => {
  const editor = clone(BASE); editor.panes.push({ id: 'pNew', name: 'New Pane', slots: [{ pageId: '' }] });
  const fresh = clone(BASE); fresh.settings.activePaneId = 'p2';
  const { merged, conflicts } = mergeExternalConfig(editor, BASE, fresh);
  assert.deepEqual(merged.panes.map(p => p.id), ['p1', 'pNew']);
  assert.equal(merged.settings.activePaneId, 'p2');
  assert.deepEqual(conflicts, []);
});

test('both sides landing on the same value is not a conflict', () => {
  const editor = clone(BASE); editor.settings.rotation = { enabled: true };
  const fresh = clone(BASE); fresh.settings.rotation = { enabled: true };
  const { conflicts } = mergeExternalConfig(editor, BASE, fresh);
  assert.deepEqual(conflicts, []);
});

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { safeAppEntry, appEntryUrlPath, safeEditorDeclaration } = require('../app/dropInPaths');

test('editor entry uses the same safe relative-path rules as the panel entry', () => {
  assert.equal(safeAppEntry('ui/editor.html'), 'ui/editor.html');
  assert.equal(safeAppEntry('ui\\editor.html'), 'ui/editor.html');
  for (const bad of ['', '../editor.html', '/editor.html', 'C:\\editor.html', 'https://example.com/editor.html']) {
    assert.equal(safeAppEntry(bad), null, bad);
  }
  assert.equal(appEntryUrlPath('ui/my editor.html'), 'ui/my%20editor.html');
});

test('served drop-in editor declaration is sanitized and bounded', () => {
  assert.deepEqual(safeEditorDeclaration({ served: true, editor: { entry: 'index.html', label: ' Manage jobs ', ignored: true } }),
    { entry: 'index.html', label: 'Manage jobs' });
  assert.deepEqual(safeEditorDeclaration({ served: true, editor: { entry: 'index.html' } }),
    { entry: 'index.html', label: 'Manage app' });
  assert.equal(safeEditorDeclaration({ served: false, editor: { entry: 'index.html' } }), null);
  assert.equal(safeEditorDeclaration({ served: true, editor: { entry: '../outside.html' } }), null);
  assert.equal(safeEditorDeclaration({ served: true, editor: 'index.html' }), null);
  assert.equal(safeEditorDeclaration({ served: true }), null);
  assert.equal(safeEditorDeclaration({ served: true, editor: { entry: 'index.html', label: 'x'.repeat(100) } }).label.length, 80);
});

test('the editor bridge remains generic and narrowly exposed', () => {
  const fs = require('node:fs');
  const preload = fs.readFileSync(require.resolve('../app/config-preload'), 'utf8');
  const renderer = fs.readFileSync(require.resolve('../app/config'), 'utf8');
  assert.match(preload, /appEditorUrl\(page\).*ipcRenderer\.invoke\('appEditorUrl', page\)/);
  assert.match(renderer, /sandbox="allow-scripts allow-forms allow-same-origin"/);
  assert.doesNotMatch(preload + renderer, /folder-sync/i);
});

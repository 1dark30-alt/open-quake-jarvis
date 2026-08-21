'use strict';
// routines: storage shaping, auto-naming, and resolving a tile's routine id into something
// runnable — including the cases where the routine or its AI Chat page has been deleted.

const test = require('node:test');
const assert = require('node:assert/strict');
const { autoName, normalizeRoutine, normalizeList, resolveRoutine, aiVoicePages } = require('../app/routines');

const ids = (() => { let n = 0; return () => 'r' + (++n); })();
const chat = (id, name) => ({ id, name, kind: 'app', app: 'ai-voice' });
const grid = (id, name) => ({ id, name, kind: 'grid', tiles: [] });

// ---- auto-naming (the panel has no keyboard, so this is the only name a routine gets there) ----

test('autoName takes the opening words and marks the truncation', () => {
  assert.equal(autoName('Summarize my unread email'), 'Summarize my unread email');
  assert.equal(
    autoName('Summarize my unread email and list anything that needs a reply today'),
    'Summarize my unread email and list…');
});

test('autoName returns empty for an empty prompt', () => {
  assert.equal(autoName(''), '');
  assert.equal(autoName('   '), '');
  assert.equal(autoName(null), '');
});

// ---- storage shaping ----

test('normalizeRoutine fills a name from the prompt and mints an id', () => {
  const r = normalizeRoutine({ prompt: '  Run the standup summary  ' }, ids);
  assert.equal(r.prompt, 'Run the standup summary');
  assert.equal(r.name, 'Run the standup summary');
  assert.equal(r.id, 'r1');
  assert.equal(r.appPageId, '');
  assert.equal(r.profileId, '');
});

test('normalizeRoutine keeps a user-given name and existing id', () => {
  const r = normalizeRoutine({ id: 'keepme', name: 'Standup', prompt: 'do the thing', appPageId: 'p1', profileId: 'prof2' }, ids);
  assert.deepEqual(r, { id: 'keepme', name: 'Standup', prompt: 'do the thing', appPageId: 'p1', profileId: 'prof2' });
});

test('normalizeRoutine rejects an empty prompt — nothing may be saved that would do nothing', () => {
  assert.equal(normalizeRoutine({ prompt: '' }, ids), null);
  assert.equal(normalizeRoutine({ prompt: '   ', name: 'Looks fine' }, ids), null);
  assert.equal(normalizeRoutine(null, ids), null);
  assert.equal(normalizeRoutine('nope', ids), null);
});

test('normalizeList drops unusable rows and duplicate ids', () => {
  const out = normalizeList([
    { id: 'a', prompt: 'one' },
    { id: 'b', prompt: '' },          // half-saved row
    { id: 'a', prompt: 'dupe' },      // same id
    null,
    { id: 'c', prompt: 'two' },
  ], ids);
  assert.deepEqual(out.map(r => r.id), ['a', 'c']);
});

// ---- finding AI Chat pages ----

test('aiVoicePages picks only ai-voice app pages, in config order', () => {
  const grids = [grid('g1', 'Home'), chat('c1', 'Claude'), grid('g2', 'Media'), chat('c2', 'Codex')];
  assert.deepEqual(aiVoicePages(grids).map(g => g.id), ['c1', 'c2']);
  assert.deepEqual(aiVoicePages(null), []);
});

// ---- resolving a tile tap ----

const ROUTINES = [
  { id: 'r-standup', name: 'Standup', prompt: 'Summarize yesterday', appPageId: 'c1', profileId: '' },
  { id: 'r-gone', name: 'Orphan', prompt: 'do a thing', appPageId: 'deleted-page', profileId: 'prof1' },
  { id: 'r-blank', name: 'Blank', prompt: '', appPageId: 'c1', profileId: '' },
];

test('resolves to its own AI Chat page when that page still exists', () => {
  const r = resolveRoutine('r-standup', { routines: ROUTINES, grids: [grid('g1', 'Home'), chat('c1', 'Claude')] });
  assert.equal(r.ok, true);
  assert.equal(r.pageId, 'c1');
  assert.equal(r.routine.prompt, 'Summarize yesterday');
  assert.equal(r.warning, undefined);
});

test('falls back to the first AI Chat page when the saved one is gone, and says so', () => {
  const r = resolveRoutine('r-gone', { routines: ROUTINES, grids: [chat('c1', 'Claude'), chat('c2', 'Codex')] });
  assert.equal(r.ok, true);
  assert.equal(r.pageId, 'c1');
  assert.match(r.warning, /page is gone/);
  assert.match(r.warning, /Claude/);
});

test('unknown routine id reports it instead of doing nothing', () => {
  const r = resolveRoutine('r-nope', { routines: ROUTINES, grids: [chat('c1', 'Claude')] });
  assert.equal(r.ok, false);
  assert.match(r.error, /not found/);
});

test('no AI Chat page anywhere is an error, not a fallback', () => {
  const r = resolveRoutine('r-standup', { routines: ROUTINES, grids: [grid('g1', 'Home')] });
  assert.equal(r.ok, false);
  assert.match(r.error, /No AI Chat page/);
});

test('a routine whose prompt was emptied by hand is refused at run time too', () => {
  const r = resolveRoutine('r-blank', { routines: ROUTINES, grids: [chat('c1', 'Claude')] });
  assert.equal(r.ok, false);
  assert.match(r.error, /no prompt/);
});

test('a stale profileId is carried through — the host falls back on its own', () => {
  const r = resolveRoutine('r-gone', { routines: ROUTINES, grids: [chat('c1', 'Claude')] });
  assert.equal(r.routine.profileId, 'prof1');
});

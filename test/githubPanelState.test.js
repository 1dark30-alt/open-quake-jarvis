'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const panelState = require('../app/githubPanelState');

test('repository switching clears every repository-specific selection and invalidates pending requests', () => {
  const state = panelState.create();
  state.settings = { repository:'acme/old', branch:'main' };
  state.view = 'run';
  state.data = { repository:'old data' };
  state.selectedPull = { item:{ number:1 } };
  state.selectedCheck = 2;
  state.selectedRun = { item:{ id:3 } };
  state.selectedJob = 4;
  state.currentUrl = 'https://github.com/acme/old/actions/runs/3';
  state.fetchedAt = '2026-01-01T00:00:00Z';
  state.loading = true;
  const version = state.requestVersion;

  panelState.selectRepository(state, 'org/new', 'trunk');

  assert.equal(state.settings.repository, 'org/new');
  assert.equal(state.settings.branch, 'trunk');
  assert.equal(state.view, 'overview');
  assert.equal(state.data, null);
  assert.equal(state.selectedPull, null);
  assert.equal(state.selectedCheck, null);
  assert.equal(state.selectedRun, null);
  assert.equal(state.selectedJob, 0);
  assert.equal(state.currentUrl, '');
  assert.equal(state.loading, false);
  assert.equal(state.requestVersion, version + 1);
});

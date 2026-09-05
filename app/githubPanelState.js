'use strict';

(function expose(root, factory) {
  const value = factory();
  if (typeof module === 'object' && module.exports) module.exports = value;
  else root.GitHubPanelState = value;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  function create() {
    return {
      view: 'overview', settings: null, configuredRepository: '', repositories: [], repositoriesLoaded: false,
      favourites: [], recents: [], data: null, selectedPull: null, selectedCheck: null, selectedRun: null,
      issueFilter: 'open', selectedIssue: null, issueDetailError: null,
      selectedJob: 0, currentUrl: '', fetchedAt: null, loading: false, timer: null, focusIndex: 0,
      requestVersion: 0, stale: false,
    };
  }

  function selectRepository(state, repository, branch) {
    state.requestVersion += 1;
    state.loading = false;
    state.view = 'overview';
    state.data = null;
    state.selectedPull = null;
    state.selectedCheck = null;
    state.selectedRun = null;
    state.issueFilter = 'open';
    state.selectedIssue = null;
    state.issueDetailError = null;
    state.selectedJob = 0;
    state.currentUrl = '';
    state.fetchedAt = null;
    state.stale = false;
    if (state.settings) {
      state.settings.repository = repository;
      state.settings.branch = branch || '';
    }
    return state;
  }

  function mergeIssuePage(current, next) {
    const seen = new Set();
    const items = [];
    [current, next].forEach(page => {
      (page && Array.isArray(page.items) ? page.items : []).forEach(item => {
        const number = Number(item && item.number);
        if (!Number.isSafeInteger(number) || number <= 0 || seen.has(number)) return;
        seen.add(number);
        items.push(item);
      });
    });
    return Object.assign({}, next || {}, { items });
  }

  return { create, mergeIssuePage, selectRepository };
});

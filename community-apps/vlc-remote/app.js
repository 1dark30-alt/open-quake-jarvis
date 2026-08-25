'use strict';

const query = new URLSearchParams(location.search);
const mockMode = query.get('mock') === '1' || query.get('mock') === 'true';
const refreshSeconds = Math.max(1, Math.min(30, parseInt(query.get('refreshSeconds'), 10) || 2));

const state = {
  timer: null,
  clockTimer: null,
  refreshPromise: null,
  status: null,
  playlist: [],
  playlistSearch: '',
  phase: 'loading',
  busy: false,
  drawerOpener: null,
};

const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

function applyTheme() {
  const dark = query.get('_dark');
  document.documentElement.dataset.theme = dark === '0' ? 'light' : 'dark';
}

function formatTime(seconds) {
  const n = Math.max(0, Number(seconds) || 0);
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = Math.floor(n % 60);
  if (h) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function updateClock() {
  $('#deck-clock').textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[character]));
}

function apiUrl(action, params) {
  const url = new URL(`/app-api/${action}`, location.origin);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value != null && value !== '') url.searchParams.set(key, value);
  });
  return url.pathname + url.search;
}

async function api(action, params) {
  if (mockMode) return mockApi(action, params);
  const response = await fetch(apiUrl(action, params), { cache: 'no-store' });
  const text = await response.text();
  let payload = {};
  try {
    payload = text ? JSON.parse(text) : {};
  } catch (error) {
    payload = { ok: false, error: 'Invalid response from the VLC bridge' };
  }
  if (!response.ok || payload.ok === false) {
    throw new Error(payload.error || `VLC request failed (${response.status})`);
  }
  return payload;
}

function updateControlAvailability() {
  const disabled = state.phase !== 'online' || state.busy;
  $$('[data-command]').forEach(button => { button.disabled = disabled; });
  $('#transport-grid').setAttribute('aria-busy', state.busy ? 'true' : 'false');
  $('#refresh-button').disabled = !!state.refreshPromise || state.busy;
}

function setPhase(phase, detail) {
  state.phase = phase;
  const pill = $('#status-pill');
  pill.classList.toggle('online', phase === 'online');
  pill.classList.toggle('loading', phase === 'loading');
  $('#status-text').textContent = phase === 'online' ? 'Online' : phase === 'loading' ? 'Connecting' : 'Offline';
  if (detail) $('#track-meta').textContent = detail;
  updateControlAvailability();
}

function currentMeta(status) {
  const information = status.information || {};
  const category = information.category || {};
  return category.meta || information.meta || {};
}

function currentTitle(status) {
  const meta = currentMeta(status);
  return meta.title || meta.filename || status.title || status.name || (status.state === 'stopped' ? 'Nothing playing' : 'Untitled media');
}

function currentDescription(status) {
  const meta = currentMeta(status);
  const stateLabel = status.state ? status.state.charAt(0).toUpperCase() + status.state.slice(1) : '';
  return [meta.artist, meta.album, stateLabel].filter(Boolean).join(' · ') || 'VLC web interface connected';
}

function resetProgress() {
  $('#elapsed').textContent = '0:00';
  $('#duration').textContent = '0:00';
  $('#progress-fill').style.width = '0%';
  $('#progress-track').setAttribute('aria-valuenow', '0');
}

function renderStatus(status) {
  state.status = status;
  $('#track-title').textContent = currentTitle(status);
  setPhase('online', currentDescription(status));

  const playing = status.state === 'playing';
  const playToggle = $('#play-toggle');
  playToggle.classList.toggle('is-playing', playing);
  playToggle.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('#play-label').textContent = playing ? 'Pause' : 'Play';

  const duration = Number(status.length) || 0;
  const elapsed = Number(status.time) || 0;
  const progress = duration ? Math.max(0, Math.min(100, (elapsed / duration) * 100)) : 0;
  $('#elapsed').textContent = formatTime(elapsed);
  $('#duration').textContent = formatTime(duration);
  $('#progress-fill').style.width = `${progress}%`;
  $('#progress-track').setAttribute('aria-valuenow', String(Math.round(progress)));

  const volume = Math.round(((Number(status.volume) || 0) / 256) * 100);
  $('#volume-label').textContent = `${Math.max(0, Math.min(125, volume))}%`;
}

function flattenPlaylist(nodes, rows) {
  (nodes || []).forEach(node => {
    if (node.type === 'leaf') rows.push(node);
    if (Array.isArray(node.children)) flattenPlaylist(node.children, rows);
  });
  return rows;
}

function playlistDuration(rows) {
  const seconds = rows.reduce((sum, row) => sum + (Number(row.duration) > 0 ? Number(row.duration) : 0), 0);
  if (!seconds) return '';
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function renderPlaylistRows() {
  const needle = state.playlistSearch.trim().toLowerCase();
  const indexed = state.playlist.map((row, index) => ({ row, index }));
  const rows = needle
    ? indexed.filter(({ row }) => String(row.name || row.uri || '').toLowerCase().includes(needle))
    : indexed;
  const activeId = state.status && String(state.status.currentplid || '');
  const summary = playlistDuration(state.playlist);
  $('#playlist-summary').textContent = `${state.playlist.length} item${state.playlist.length === 1 ? '' : 's'}${summary ? ' · ' + summary : ''}`;
  $('#playlist').innerHTML = rows.length ? rows.slice(0, 100).map(({ row, index }) => {
    const active = activeId && String(row.id) === activeId;
    const duration = row.duration && row.duration > 0 ? formatTime(row.duration) : '';
    return `
      <button class="playlist-row ${active ? 'active' : ''}" type="button" data-play-id="${esc(row.id)}">
        <span class="playlist-index">${index + 1}</span>
        <span class="playlist-play">${active ? '▶' : ''}</span>
        <strong class="playlist-title">${esc(row.name || row.uri || 'Playlist item')}</strong>
        <span class="playlist-duration">${esc(duration)}</span>
      </button>`;
  }).join('') : `<div class="empty">${state.playlist.length ? 'No matching playlist items' : 'Playlist is empty'}</div>`;
}

function renderPlaylist(payload) {
  state.playlist = flattenPlaylist(payload.children || payload.playlist || [], []);
  renderPlaylistRows();
}

function renderError(error) {
  const message = error && error.message || 'Unable to reach VLC';
  if (!state.status) {
    $('#track-title').textContent = 'VLC unavailable';
    $('#volume-label').textContent = '--%';
    resetProgress();
  }
  setPhase('offline', message);
  if (!state.playlist.length) $('#playlist').innerHTML = '<div class="error">Unable to load the VLC playlist</div>';
}

function scheduleRefresh() {
  clearTimeout(state.timer);
  state.timer = setTimeout(refresh, refreshSeconds * 1000);
}

function refresh() {
  if (state.refreshPromise) return state.refreshPromise;
  if (!state.status) setPhase('loading', 'Checking the VLC web interface');
  state.refreshPromise = Promise.all([api('status'), api('playlist')])
    .then(([status, playlist]) => {
      renderStatus(status);
      renderPlaylist(playlist);
    })
    .catch(renderError)
    .finally(() => {
      state.refreshPromise = null;
      updateControlAvailability();
      scheduleRefresh();
    });
  updateControlAvailability();
  return state.refreshPromise;
}

async function sendCommand(command, params) {
  if (state.busy || state.phase !== 'online') return;
  state.busy = true;
  updateControlAvailability();
  try {
    await api('command', Object.assign({ command }, params || {}));
    if (state.refreshPromise) await state.refreshPromise;
    await refresh();
  } catch (error) {
    renderError(error);
  } finally {
    state.busy = false;
    updateControlAvailability();
  }
}

function drawerFocusables() {
  return $$('#playlist-page button:not(:disabled), #playlist-page input:not(:disabled)')
    .filter(element => element.offsetParent !== null);
}

function openDrawer(opener) {
  const drawer = $('#playlist-page');
  state.drawerOpener = opener || document.activeElement;
  drawer.removeAttribute('inert');
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  $('#playlist-open').setAttribute('aria-expanded', 'true');
  $('#drawer-backdrop').hidden = false;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (drawer.classList.contains('open')) $('#playlist-search').focus({ preventScroll: true });
  }));
}

function closeDrawer() {
  const drawer = $('#playlist-page');
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  drawer.setAttribute('inert', '');
  $('#playlist-open').setAttribute('aria-expanded', 'false');
  $('#drawer-backdrop').hidden = true;
  if (state.drawerOpener && typeof state.drawerOpener.focus === 'function') state.drawerOpener.focus();
  state.drawerOpener = null;
}

function trapDrawerFocus(event) {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeDrawer();
    return;
  }
  if (event.key !== 'Tab') return;
  const focusables = drawerFocusables();
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function setupEvents() {
  $$('[data-command]').forEach(button => {
    button.addEventListener('click', () => {
      const command = button.getAttribute('data-command');
      const value = button.getAttribute('data-val');
      sendCommand(command, value == null ? null : { val: value });
    });
  });

  $('#refresh-button').addEventListener('click', refresh);
  $('#playlist-open').addEventListener('click', event => openDrawer(event.currentTarget));
  $('#playlist-close').addEventListener('click', closeDrawer);
  $('#drawer-backdrop').addEventListener('click', closeDrawer);
  $('#playlist-page').addEventListener('keydown', trapDrawerFocus);
  $('#playlist-search').addEventListener('input', event => {
    state.playlistSearch = event.target.value;
    renderPlaylistRows();
  });
  $('#playlist-clear').addEventListener('click', () => sendCommand('pl_empty'));

  $('#playlist').addEventListener('click', event => {
    const row = event.target.closest('[data-play-id]');
    if (!row) return;
    sendCommand('pl_play', { id: row.getAttribute('data-play-id') });
    closeDrawer();
  });
}

function mockApi(action, params) {
  if (action === 'command' && params) {
    if (params.command === 'pl_pause') mockApi.playing = !mockApi.playing;
    if (params.command === 'pl_stop') mockApi.playing = false;
    if (params.command === 'pl_empty') mockApi.empty = true;
    if (params.command === 'pl_play') {
      mockApi.currentId = Number(params.id) || 2;
      mockApi.playing = true;
    }
  }
  const status = {
    ok: true,
    state: mockApi.playing ? 'playing' : 'paused',
    time: Math.floor((Date.now() / 1000) % 1800),
    length: 3600,
    volume: 176,
    currentplid: mockApi.currentId,
    information: {
      category: {
        meta: {
          title: 'Big Buck Bunny',
          artist: 'Blender Foundation',
          album: 'Local desktop VLC',
        },
      },
    },
  };
  const playlist = {
    ok: true,
    children: mockApi.empty ? [] : [{
      name: 'Playlist',
      children: [
        { id: 1, type: 'leaf', name: 'Open Quake trailer.mp4', duration: 212 },
        { id: 2, type: 'leaf', name: 'Big Buck Bunny', duration: 3600 },
        { id: 3, type: 'leaf', name: 'NAS movie night.m3u8', duration: 5420 },
      ],
    }],
  };
  return Promise.resolve(action === 'playlist' ? playlist : status);
}
mockApi.playing = true;
mockApi.currentId = 2;
mockApi.empty = false;

applyTheme();
setupEvents();
updateClock();
state.clockTimer = setInterval(updateClock, 1000);
updateControlAvailability();
refresh();

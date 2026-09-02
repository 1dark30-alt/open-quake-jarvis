'use strict';

// ---- Config from URL (served mode: non-secret options arrive as query params) ----
const params = new URLSearchParams(location.search);
const PINNED_ROOM = (params.get('room') || '').trim().toUpperCase();

// Apply host theme (served apps receive ?theme=light|dark; host may also set data-theme).
const THEME = (params.get('theme') || '').trim();
if (THEME === 'light' || THEME === 'dark') document.documentElement.dataset.theme = THEME;

const POLL_MS = 2000;
const DISCOVER_MS = 10000;
const RETRY_MAX_MS = 15000;
const DEFAULT_CLOSE_SUMMARY = 'Closed from panel';
const TAP_SWALLOW_MS = 700;

// ---- Element refs ----
const $ = (id) => document.getElementById(id);
const els = {
  shell: $('app'), statusDot: $('statusDot'), roomTitle: $('roomTitle'), roomCode: $('roomCode'),
  modeBadge: $('modeBadge'), closedBadge: $('closedBadge'), newRoomBtn: $('newRoomBtn'), roomsBtn: $('roomsBtn'), historyBtn: $('historyBtn'),
  rail: $('rail'), railToggle: $('railToggle'), objective: $('objective'),
  pCount: $('pCount'), participants: $('participants'),
  roomsCount: $('roomsCount'), roomList: $('roomList'),
  transcript: $('transcript'), messages: $('messages'), newPill: $('newPill'), newPillCount: $('newPillCount'),
  composer: $('composer'), viewerName: $('viewerName'), input: $('input'), sendBtn: $('sendBtn'), sendError: $('sendError'),
  overlay: $('overlay'), overlayKicker: $('overlayKicker'), overlayTitle: $('overlayTitle'),
  overlayBody: $('overlayBody'), overlayCount: $('overlayCount'), overlayList: $('overlayList'), overlayRetry: $('overlayRetry'), overlayBack: $('overlayBack'),
  closeDlg: $('closeDlg'), closeDlgTitle: $('closeDlgTitle'), closeDlgBody: $('closeDlgBody'),
  closeSummary: $('closeSummary'), closeCancel: $('closeCancel'), closeConfirm: $('closeConfirm'), closeError: $('closeError'),
};

// ---- Runtime state ----
const state = {
  code: PINNED_ROOM || null,
  pinned: Boolean(PINNED_ROOM),
  cursor: 0,
  status: 'loading',
  viewerName: 'viewer',
  colors: new Map(),   // name -> color
  roles: new Map(),    // name -> role
  atBottom: true,
  newCount: 0,
  pollTimer: null,
  discoverTimer: null,
  retryMs: POLL_MS,
  candidate: null,     // a newer open room to offer without hijacking
  seen: new Set(),     // message ids already rendered (dedupe)
  sending: false,      // guard against double-POST on rapid Enter
  polling: false,      // serialize poll application (scheduled vs post-send)
  rooms: [],           // last known open rooms (rail list)
  closeTarget: null,   // room being closed via the dialog
  closing: false,      // guard against double close
};

// ---- Small helpers ----
async function callApi(action, query, init) {
  const qs = new URLSearchParams(query || {}).toString();
  const url = '/app-api/' + action + (qs ? '?' + qs : '');
  let res;
  try {
    res = await fetch(url, init);
  } catch (error) {
    return { ok: false, error: 'panel bridge unreachable' };
  }
  let json = null;
  try { json = await res.json(); } catch (error) { json = null; }
  if (!json) return { ok: false, error: 'bad response' };
  return json;
}

// Touch on the panel does not arrive as touch events: the host turns each finger frame into
// synthesized mouse events on the webview (mouseDown on the first frame, mouseMove per frame,
// mouseUp on lift), and a click only forms if that sequence stays on one element. Activate on
// pointerdown instead — the first frame, before any jitter — the way the panel's own tiles arm on
// first touch, and swallow the click that follows so a mouse never fires twice. Keyboard and
// programmatic activation (knob press) still arrive as a bare click and run normally.
function tap(el, fn) {
  let armedAt = 0;
  el.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || el.disabled) return;
    armedAt = Date.now();
    fn(e);
  });
  el.addEventListener('click', (e) => {
    e.preventDefault();
    if (Date.now() - armedAt < TAP_SWALLOW_MS) return;
    fn(e);
  });
}

function fmtTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function fmtDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function setStatus(status) {
  state.status = status;
  els.shell.dataset.status = status;
  els.closedBadge.hidden = status !== 'closed';
  els.statusDot.dataset.state = (status === 'open' || status === 'closed' || status === 'error') ? status : 'loading';
  const closed = status === 'closed';
  els.input.disabled = closed;
  els.sendBtn.disabled = closed || !els.input.value.trim();
}

// ---- Overlay state screens ----
// Background regions made inert while any overlay is up, so keyboard focus can't sit behind it.
const bgRegions = [document.querySelector('.topbar'), document.querySelector('.body')];
function setInertBackground(on) { for (const el of bgRegions) { if (el) el.inert = on; } }

// The overlay is a 1920x480 workspace: a fixed 320px context rail (kicker, title, copy, count, Back /
// Retry) and a four-column grid of 64px room cards that is the only thing allowed to scroll. Every
// control is a normal <button>: tap, click, Tab, Enter and Space all work with no knob present; the
// knob (when there is one) merely moves the same selection.
function showOverlay(title, body, opts = {}) {
  if (els.overlay.hidden) state.prevFocus = document.activeElement;   // capture only on hidden -> shown
  els.overlay.dataset.kind = opts.kind || '';
  els.overlayKicker.textContent = opts.kind === 'history' ? 'History' : 'Agent Room Monitor';
  els.overlayList.setAttribute('aria-label', opts.kind === 'history' ? 'Closed room history' : 'Open rooms');
  els.overlayTitle.textContent = title;
  els.overlayBody.textContent = body || '';
  els.overlayRetry.hidden = !opts.retry;
  els.overlayBack.hidden = !opts.back;   // only offered when a room is attached to return to
  els.overlayList.hidden = !opts.list;
  els.overlayList.textContent = '';
  els.overlayList.scrollTop = 0;
  const rooms = opts.list || [];
  if (opts.list) {
    const noun = opts.kind === 'history' ? 'closed room' : 'open room';
    els.overlayCount.textContent = rooms.length + ' ' + noun + (rooms.length === 1 ? '' : 's');
    els.overlayCount.hidden = false;
    for (const room of rooms) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      const title = document.createElement('span');
      title.className = 'room-opt-title';
      title.textContent = room.title || room.code;
      const meta = document.createElement('span');
      meta.className = 'room-opt-meta';
      const count = Number(room.latest_message_id) || 0;
      meta.textContent = room.status === 'closed'
        ? room.code + ' · ' + fmtDate(room.updated_at) + ' · ' + count + ' message' + (count === 1 ? '' : 's')
        : room.code + ' · ' + (room.active_agents || 0) + ' agent' + ((room.active_agents === 1) ? '' : 's');
      btn.append(title, meta);
      // Plain click: works for tap (after the drag-scroll guard), mouse, keyboard and the knob's press.
      btn.addEventListener('click', () => { hideOverlay(); attach(room.code); });
      li.append(btn);
      els.overlayList.append(li);
    }
  } else {
    els.overlayCount.hidden = true;
  }
  // Interactive overlays (picker / retry / back) are modal dialogs; passive ones (loading / waiting) are status.
  const interactive = Boolean(opts.list || opts.retry || opts.back);
  els.overlay.setAttribute('role', interactive ? 'dialog' : 'status');
  if (interactive) els.overlay.setAttribute('aria-modal', 'true'); else els.overlay.removeAttribute('aria-modal');
  els.overlay.setAttribute('aria-live', interactive ? 'off' : 'polite');
  els.overlay.hidden = false;
  setInertBackground(true);
  // Initial selection: the first card; with no cards, Back; failing that, Retry.
  const order = overlayButtons();
  let start = 0;
  if (!rooms.length) {
    const back = order.indexOf(els.overlayBack), retry = order.indexOf(els.overlayRetry);
    start = back >= 0 ? back : (retry >= 0 ? retry : 0);
  }
  if (order.length) selectOverlay(start);
  else { try { els.overlay.focus(); } catch (e) {} }
}

// Explicit logical order of the overlay's controls: cards row-major (newest first), then Retry, then
// Back as the boundary sentinel. Used for the initial selection and for the knob; the DOM order is
// rail-before-grid for screen readers and Tab, which is fine because Tab has its own rules.
function overlayButtons() {
  if (els.overlay.hidden) return [];
  const btns = Array.from(els.overlayList.querySelectorAll('button'));
  if (!els.overlayRetry.hidden) btns.push(els.overlayRetry);
  if (!els.overlayBack.hidden) btns.push(els.overlayBack);
  return btns;
}
function markSelected(i) {
  const btns = overlayButtons();
  state.knobFocus = i;
  btns.forEach((b, j) => b.classList.toggle('is-selected', j === i && b.matches('.overlay-list button')));
}
function selectOverlay(i) {
  const btns = overlayButtons();
  if (!btns.length) return;
  i = Math.max(0, Math.min(btns.length - 1, i));
  markSelected(i);
  const target = btns[i];
  try { target.focus({ preventScroll: true }); } catch (e) {}
  if (target.matches('.overlay-list button')) target.scrollIntoView({ block: 'nearest', inline: 'nearest' });   // only the grid moves
}
// Touch, mouse and keyboard focus keep the selection in sync so a later knob turn continues from there.
document.getElementById('overlay').addEventListener('focusin', (e) => {
  const i = overlayButtons().indexOf(e.target);
  if (i >= 0) markSelected(i);
});

// Finger-drag scrolling for the room grid. The panel delivers touch as synthesized mouse events, which
// never scroll a container by themselves; this is the same pattern the Music Assistant app uses. A
// drag past the threshold scrolls the grid and swallows the click that would otherwise open a card.
function attachDragScroll(element, threshold = 8) {
  let gesture = null, suppressClick = false, clearSuppression = null;
  element.addEventListener('pointerdown', (e) => {
    if (e.isPrimary === false || (e.button !== undefined && e.button !== 0)) return;
    gesture = { pointerId: e.pointerId, startY: e.clientY, startScrollTop: element.scrollTop, dragged: false };
  });
  element.addEventListener('pointermove', (e) => {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    const delta = e.clientY - gesture.startY;
    if (!gesture.dragged && Math.abs(delta) < threshold) return;
    if (!gesture.dragged) { gesture.dragged = true; try { element.setPointerCapture(e.pointerId); } catch (err) {} }
    element.scrollTop = gesture.startScrollTop - delta;
    if (e.cancelable) e.preventDefault();
  });
  const finish = (e) => {
    if (!gesture || e.pointerId !== gesture.pointerId) return;
    if (gesture.dragged) {
      suppressClick = true;
      clearTimeout(clearSuppression);
      clearSuppression = setTimeout(() => { suppressClick = false; }, 0);
    }
    try { element.releasePointerCapture(e.pointerId); } catch (err) {}
    gesture = null;
  };
  element.addEventListener('pointerup', finish);
  element.addEventListener('pointercancel', finish);
  element.addEventListener('pointerleave', (e) => { if (gesture && !gesture.dragged && e.pointerId === gesture.pointerId) gesture = null; });
  element.addEventListener('lostpointercapture', (e) => { if (gesture && e.pointerId === gesture.pointerId) gesture = null; });
  element.addEventListener('click', (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    clearTimeout(clearSuppression);
    e.preventDefault();
    e.stopImmediatePropagation();
  }, true);
}
attachDragScroll(document.getElementById('overlayList'));

function hideOverlay() {
  els.overlay.hidden = true;
  if (els.closeDlg.hidden) setInertBackground(false);   // keep inert while the close dialog is up
  const prev = state.prevFocus;
  state.prevFocus = null;
  if (prev && document.contains(prev) && typeof prev.focus === 'function') { try { prev.focus(); } catch (e) {} }
}

// ---- Rendering ----
function colorFor(name) { return state.colors.get(name) || 'var(--faint)'; }

function applyRoster(participants) {
  state.colors.clear();
  state.roles.clear();
  for (const p of participants || []) {
    if (p && p.name) { state.colors.set(p.name, p.color || 'var(--faint)'); state.roles.set(p.name, p.role || 'agent'); }
  }
  els.pCount.textContent = String((participants || []).length);
  els.participants.textContent = '';
  for (const p of participants || []) {
    const li = document.createElement('li');
    const dot = document.createElement('span');
    dot.className = 'p-dot';
    dot.style.background = p.color || 'var(--faint)';
    const name = document.createElement('span');
    name.className = 'p-name';
    name.textContent = p.name;
    const role = document.createElement('span');
    role.className = 'p-role';
    role.textContent = p.role || 'agent';
    li.append(dot, name, role);
    els.participants.append(li);
  }
}

// Rail list of open rooms: tap a room to monitor it, or close it with a summary.
function renderRoomList(open) {
  state.rooms = Array.isArray(open) ? open : [];
  els.roomsCount.textContent = String(state.rooms.length);
  els.roomList.textContent = '';
  if (!state.rooms.length) {
    const li = document.createElement('li');
    li.className = 'room-row-empty';
    li.textContent = 'No open rooms';
    els.roomList.append(li);
    return;
  }
  for (const room of state.rooms) {
    const li = document.createElement('li');
    li.className = 'room-row' + (room.code === state.code ? ' is-current' : '');
    const openBtn = document.createElement('button');
    openBtn.type = 'button';
    openBtn.className = 'room-open';
    openBtn.setAttribute('aria-label', 'Monitor room ' + (room.title || room.code));
    const title = document.createElement('span');
    title.className = 'room-row-title';
    title.textContent = room.title || room.code;
    const meta = document.createElement('span');
    meta.className = 'room-row-meta';
    meta.textContent = room.code + ' · ' + (room.active_agents || 0) + ' agent' + ((room.active_agents === 1) ? '' : 's');
    openBtn.append(title, meta);
    tap(openBtn, () => { if (room.code !== state.code) attach(room.code); });
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'room-close';
    closeBtn.textContent = 'Close';
    closeBtn.setAttribute('aria-label', 'Close room ' + (room.title || room.code));
    tap(closeBtn, () => openCloseDialog(room));
    li.append(openBtn, closeBtn);
    els.roomList.append(li);
  }
}

// Fetch the open rooms and redraw the rail list. Returns the open list, or null when the
// server could not be reached (callers keep their last state in that case).
async function refreshRooms() {
  const res = await callApi('list', {});
  if (!res.ok) return null;
  const open = (res.rooms || []).filter((r) => r.status === 'open');
  renderRoomList(open);
  return open;
}

function messageEl(m) {
  const li = document.createElement('li');
  li.className = 'msg msg-' + (m.kind || 'agent');
  const rail = document.createElement('div');
  rail.className = 'msg-rail';
  rail.style.background = colorFor(m.sender);
  const main = document.createElement('div');
  main.className = 'msg-main';
  const head = document.createElement('div');
  head.className = 'msg-head';
  const name = document.createElement('span');
  name.className = 'msg-name';   // name stays in --ink; color is carried by the rail + roster dot
  name.textContent = m.sender;
  const role = document.createElement('span');
  role.className = 'msg-role';
  role.textContent = state.roles.get(m.sender) || (m.kind === 'human' ? 'human' : (m.kind === 'agent' ? 'agent' : ''));
  head.append(name, role);
  const body = document.createElement('div');
  body.className = 'msg-body';
  body.textContent = m.content;              // text only — never innerHTML
  main.append(head, body);
  const time = document.createElement('div');
  time.className = 'msg-time';
  time.textContent = fmtTime(m.created_at);
  li.append(rail, main, time);
  return li;
}

function appendMessages(list) {
  // Dedupe by id so a scheduled poll and a post-send poll can't render a message twice.
  const fresh = [];
  for (const m of (list || [])) {
    if (m && !state.seen.has(m.id)) { state.seen.add(m.id); fresh.push(m); }
  }
  if (!fresh.length) return;
  const frag = document.createDocumentFragment();
  for (const m of fresh) frag.append(messageEl(m));
  els.messages.append(frag);
  if (state.atBottom) {
    scrollToBottom();
  } else {
    state.newCount += fresh.length;
    els.newPillCount.textContent = String(state.newCount);
    els.newPill.hidden = false;
  }
}

function scrollToBottom() {
  els.transcript.scrollTop = els.transcript.scrollHeight;
  state.atBottom = true;
  state.newCount = 0;
  els.newPill.hidden = true;
}

// ---- Attach / hydrate / poll ----
async function attach(code) {
  stopLoops();
  state.code = code;
  state.candidate = null;
  els.newRoomBtn.hidden = true;
  setStatus('loading');
  showOverlay('Opening room…', code);
  const res = await callApi('hydrate', { room: code });
  if (!res.ok) { showOverlay('Could not open room', res.error || 'unknown error', { retry: true }); state.retryContext = () => attach(code); return; }
  const room = res.room;
  state.viewerName = room.viewer_name || 'viewer';
  els.viewerName.textContent = state.viewerName;
  els.roomTitle.textContent = room.title || 'Agent Room';
  els.roomCode.textContent = room.code || code;
  els.objective.textContent = room.objective || '—';
  applyRoster(room.participants);
  els.messages.textContent = '';
  state.seen = new Set();
  state.atBottom = true;
  const msgs = room.messages || [];
  appendMessages(msgs);                              // dedupe path; renders summary message on closed rooms too
  state.cursor = msgs.length ? msgs[msgs.length - 1].id : 0;
  scrollToBottom();
  setMode(room.addressed_only);
  setStatus(room.status || 'open');
  hideOverlay();
  renderRoomList(state.rooms);                       // re-mark the current room in the rail list
  refreshRooms();                                    // and refresh it in the background
  if (room.status === 'closed') onClosed();          // no synthetic summary — the summary-kind message already rendered
  else { startPolling(); startDiscovery(); }
  els.roomsBtn.hidden = state.pinned;
}

function setMode(addressedOnly) { els.modeBadge.hidden = !addressedOnly; }

// Single point that applies a poll result. Guarded by state.polling so the scheduled tick and
// the immediate post-send poll can't interleave; cursor only advances (monotonic).
async function doPoll() {
  if (state.polling || !state.code) return { skipped: true };
  state.polling = true;
  try {
    const res = await callApi('poll', { room: state.code, after: String(state.cursor) });
    if (!res.ok) return res;
    if (state.status === 'error') hideOverlay();
    setStatus(res.status || 'open');
    if (Array.isArray(res.participants)) applyRoster(res.participants);   // apply even when empty (roster cleared on close)
    setMode(res.addressed_only);
    if (res.messages && res.messages.length) appendMessages(res.messages);
    state.cursor = Math.max(state.cursor, Number(res.latest_message_id) || 0);
    return res;
  } finally {
    state.polling = false;
  }
}

function startPolling() {
  stopPolling();
  state.retryMs = POLL_MS;
  const tick = async () => {
    const res = await doPoll();
    if (res && res.skipped) { state.pollTimer = setTimeout(tick, POLL_MS); return; }
    if (!res || !res.ok) {
      setStatus('error');
      showOverlay('Reconnecting…', (res && res.error) || 'room server unreachable', {});
      state.retryMs = Math.min(RETRY_MAX_MS, state.retryMs * 2);
      state.pollTimer = setTimeout(tick, state.retryMs);
      return;
    }
    if (res.status === 'closed') { onClosed(); return; }
    state.retryMs = POLL_MS;
    state.pollTimer = setTimeout(tick, POLL_MS);
  };
  state.pollTimer = setTimeout(tick, POLL_MS);
}
function stopPolling() { if (state.pollTimer) { clearTimeout(state.pollTimer); state.pollTimer = null; } }

// On close the server emits a `summary`-kind MESSAGE ("Meeting closed. …") which hydrate/poll
// already render via appendMessages — so we never synthesize a second summary here.
function onClosed() {
  stopPolling();
  setStatus('closed');
  startDiscovery();
}

// ---- Discovery (rail list + non-hijacking "Open new room") ----
function startDiscovery() {
  stopDiscovery();
  const tick = async () => {
    const open = await refreshRooms();
    if (open) {
      const other = open.find((r) => r.code !== state.code);
      if (state.status === 'closed' && open.length === 1 && !state.pinned) {
        // room we were in closed and exactly one open room exists — offer it prominently
        state.candidate = open[0].code;
        els.newRoomBtn.hidden = false;
      } else if (other) {
        state.candidate = other.code;
        els.newRoomBtn.hidden = false;
      } else {
        state.candidate = null;
        els.newRoomBtn.hidden = true;
      }
    }
    state.discoverTimer = setTimeout(tick, DISCOVER_MS);
  };
  state.discoverTimer = setTimeout(tick, DISCOVER_MS);
}
function stopDiscovery() { if (state.discoverTimer) { clearTimeout(state.discoverTimer); state.discoverTimer = null; } }
function stopLoops() { stopPolling(); stopDiscovery(); }

// ---- Initial discovery / selection ----
async function init() {
  setStatus('loading');
  renderRoomList([]);
  if (state.pinned) { attach(state.code); return; }
  showOverlay('Looking for rooms…', 'Discovering open Agent Room meetings on the server.');
  const res = await callApi('list', {});
  if (!res.ok) { showOverlay('Room server unavailable', res.error || 'Could not reach the Agent Room server.', { retry: true }); state.retryContext = init; return; }
  const open = (res.rooms || []).filter((r) => r.status === 'open');
  renderRoomList(open);
  if (open.length === 0) { waitForRoom(); return; }
  if (open.length === 1) { attach(open[0].code); return; }
  showOverlay('Choose a room', 'Several rooms are open. Pick one to monitor.', { list: open });
}

function waitForRoom() {
  showOverlay('Waiting for a room', 'No open Agent Room meetings yet. This will attach automatically when one starts.');
  stopLoops();
  const tick = async () => {
    const open = await refreshRooms();
    if (open) {
      if (open.length === 1) { attach(open[0].code); return; }
      if (open.length > 1) { showOverlay('Choose a room', 'Several rooms are open. Pick one to monitor.', { list: open }); return; }
    }
    state.discoverTimer = setTimeout(tick, DISCOVER_MS / 2);
  };
  state.discoverTimer = setTimeout(tick, DISCOVER_MS / 2);
}

// ---- Send ----
async function submitMessage(text) {
  if (state.sending) return;                 // guard: rapid Enter can't POST twice
  state.sending = true;
  els.sendError.hidden = true;
  els.sendBtn.disabled = true;
  try {
    const res = await callApi('send', { room: state.code }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: text }),
    });
    if (!res.ok) {
      els.sendError.textContent = 'Send failed: ' + (res.error || 'unknown') + ' — your draft is kept.';
      els.sendError.hidden = false;
      return;                                 // draft preserved (input untouched)
    }
    els.input.value = '';
    autoGrow();
    await doPoll();                           // reflect immediately; dedupe + guard prevent double-render
  } finally {
    state.sending = false;
    els.sendBtn.disabled = state.status === 'closed' || !els.input.value.trim();
  }
}

// ---- Close room (dialog with a pre-filled summary) ----
function openCloseDialog(room) {
  state.closeTarget = room;
  els.closeDlgTitle.textContent = 'Close “' + (room.title || room.code) + '”?';
  els.closeDlgBody.textContent = room.code + ' — agents are removed and the summary is posted to the transcript.';
  els.closeSummary.value = DEFAULT_CLOSE_SUMMARY;
  els.closeError.hidden = true;
  els.closeConfirm.disabled = false;
  if (els.closeDlg.hidden) state.prevFocus = document.activeElement;
  els.closeDlg.hidden = false;
  setInertBackground(true);
  state.knobFocus = 1;
  try { els.closeConfirm.focus(); } catch (e) {}
}

function hideCloseDialog() {
  els.closeDlg.hidden = true;
  state.closeTarget = null;
  if (els.overlay.hidden) setInertBackground(false);   // keep inert if the main overlay is still up
  const prev = state.prevFocus;
  state.prevFocus = null;
  if (prev && document.contains(prev) && typeof prev.focus === 'function') { try { prev.focus(); } catch (e) {} }
}

async function confirmClose() {
  const room = state.closeTarget;
  if (!room || state.closing) return;
  state.closing = true;
  els.closeConfirm.disabled = true;
  els.closeError.hidden = true;
  try {
    const summary = els.closeSummary.value.trim() || DEFAULT_CLOSE_SUMMARY;
    const res = await callApi('close', { room: room.code }, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ summary }),
    });
    if (!res.ok) {
      els.closeError.textContent = 'Close failed: ' + (res.error || 'unknown');
      els.closeError.hidden = false;
      els.closeConfirm.disabled = false;
      return;
    }
    hideCloseDialog();
    if (room.code === state.code) await doPoll();   // pulls the summary message and the closed status
    await refreshRooms();
  } finally {
    state.closing = false;
  }
}

// ---- Composer UX ----
function autoGrow() {
  els.input.style.height = 'auto';
  els.input.style.height = Math.min(160, els.input.scrollHeight) + 'px';
  els.sendBtn.disabled = state.status === 'closed' || !els.input.value.trim();
}

// ---- Events ----
els.transcript.addEventListener('scroll', () => {
  const gap = els.transcript.scrollHeight - els.transcript.scrollTop - els.transcript.clientHeight;
  state.atBottom = gap < 40;
  if (state.atBottom) { state.newCount = 0; els.newPill.hidden = true; }
});
tap(els.newPill, scrollToBottom);
tap(els.railToggle, () => {
  const collapsed = els.shell.dataset.rail === 'collapsed';
  els.shell.dataset.rail = collapsed ? 'expanded' : 'collapsed';
  els.railToggle.setAttribute('aria-expanded', String(collapsed));
});
tap(els.newRoomBtn, () => { if (state.candidate) attach(state.candidate); });
tap(els.roomsBtn, async () => {
  const res = await callApi('list', {});
  const open = res.ok ? (res.rooms || []).filter((r) => r.status === 'open') : [];
  if (res.ok) renderRoomList(open);
  showOverlay('Rooms', open.length ? 'Tap a room to monitor it.' : 'No open rooms right now.', { list: open, back: Boolean(state.code) });
});
tap(els.historyBtn, async () => {
  const res = await callApi('history', {});
  const rooms = res.ok ? (res.rooms || []) : [];
  const body = !res.ok ? 'Could not load history: ' + (res.error || 'unknown')
    : (rooms.length ? 'Newest first. Tap a room to read its transcript.' : 'No closed rooms yet.');
  showOverlay('History', body, { list: rooms, kind: 'history', back: Boolean(state.code) });
});
tap(els.overlayBack, hideOverlay);
tap(els.overlayRetry, () => { hideOverlay(); (state.retryContext || init)(); });
tap(els.closeCancel, hideCloseDialog);
tap(els.closeConfirm, confirmClose);
tap(els.sendBtn, () => els.composer.requestSubmit());
els.closeDlg.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); hideCloseDialog(); } });
els.input.addEventListener('input', autoGrow);
els.input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); els.composer.requestSubmit(); }
});
els.composer.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = els.input.value.trim();
  if (!text || state.status === 'closed') return;
  submitMessage(text);
});

// ---- Panel knob (optional): context-aware ----
// Close dialog up -> rotate moves between Cancel / Close, press activates.
// Picker overlay up -> rotate moves the selection through the cards, with Back as the boundary
// sentinel (CW past the last card lands on Back, CCW before the first card lands on Back; from Back,
// CW goes to the first card and CCW to the last). With no Back shown, rotation clamps at the edges.
// Retry overlay up -> press retries. Otherwise -> rotate scrolls transcript, press jumps to newest.
window.oqKnob = function (ev) {
  if (!els.closeDlg.hidden) {
    const btns = [els.closeCancel, els.closeConfirm];
    if (ev.type === 'rotate') {
      state.knobFocus = Math.max(0, Math.min(btns.length - 1, (state.knobFocus || 0) + ev.dir));
      btns[state.knobFocus].focus();
      return true;
    }
    if (ev.type === 'press') {
      const target = btns.includes(document.activeElement) ? document.activeElement : btns[state.knobFocus || 0];
      target.click();
      return true;
    }
    return false;
  }
  const btns = overlayButtons();
  if (btns.length) {
    if (ev.type === 'rotate') {
      const n = btns.length;
      const i = state.knobFocus || 0;
      const next = els.overlayBack.hidden
        ? Math.max(0, Math.min(n - 1, i + ev.dir))
        : (((i + ev.dir) % n) + n) % n;
      selectOverlay(next);
      return true;
    }
    if (ev.type === 'press') {
      const target = btns.includes(document.activeElement) ? document.activeElement : btns[state.knobFocus || 0];
      target.click();
      return true;
    }
    return false;
  }
  if (!els.overlay.hidden) return false;
  if (ev.type === 'rotate') { els.transcript.scrollTop += ev.dir * 120; return true; }
  if (ev.type === 'press') { scrollToBottom(); return true; }
  return false;
};

init();

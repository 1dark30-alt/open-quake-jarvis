'use strict';

const query = new URLSearchParams(location.search);
const mockMode = query.get('mock') === '1' || query.get('mock') === 'true';
const baseUrl = String(query.get('frigateUrl') || '').trim().replace(/\/+$/, '');
const refreshSeconds = Math.max(1, Math.min(60, parseInt(query.get('refreshSeconds'), 10) || 2));
const cycleSeconds = Math.max(3, Math.min(120, parseInt(query.get('cycleSeconds'), 10) || 10));
const cameraFilter = String(query.get('cameras') || '').split(',').map(s => s.trim()).filter(Boolean);

const $ = selector => document.querySelector(selector);

const state = {
  mode: ['grid', 'spotlight', 'cycle'].includes(query.get('mode')) ? query.get('mode') : 'grid',
  stills: query.get('stillMode') === '1' || query.get('stillMode') === 'true',
  cams: [],            // [{ name, label, down }]
  selected: 0,         // spotlight main / cycle position
  cyclePaused: false,
  cycleStart: 0,
  stillTick: 0,
};

function applyTheme() {
  document.documentElement.dataset.theme = query.get('_dark') === '0' ? 'light' : 'dark';
  const accent = query.get('_accent');
  if (accent && /^#[0-9a-fA-F]{3,8}$/.test(accent)) {
    document.documentElement.style.setProperty('--accent', accent);
  }
}

function esc(value) {
  return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[character]));
}

function prettyName(name) {
  return String(name).replace(/[_-]+/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/\b\w/g, ch => ch.toUpperCase());
}

function stamp() {
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  return pad(now.getMonth() + 1) + '/' + pad(now.getDate()) + '/' + now.getFullYear()
    + ' ' + pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
}

// ── Discovery ────────────────────────────────────────────────────────────────
async function discover() {
  if (mockMode) {
    const names = ['front_door', 'driveway', 'backyard', 'garage', 'side_gate', 'porch', 'shed', 'doorbell'];
    return names.map((name, i) => ({ name, label: prettyName(name), down: i === 4, mockHue: (i * 43 + 30) % 360 }));
  }
  // JSON goes through the panel's same-origin /app-proxy (Frigate sends no CORS headers);
  // image/MJPEG tags are CORS-exempt and load straight from Frigate.
  const response = await fetch('/app-proxy?url=' + encodeURIComponent(baseUrl + '/api/config'), { cache: 'no-store' });
  if (!response.ok) throw new Error('HTTP ' + response.status);
  const config = await response.json();
  let names = Object.keys(config.cameras || {});
  if (cameraFilter.length) {
    names = cameraFilter.filter(want => names.includes(want));
  } else {
    names.sort();
  }
  return names.map(name => ({ name, label: prettyName(name), down: false }));
}

// ── Feed sources ─────────────────────────────────────────────────────────────
// Live = Frigate's MJPEG feed (/api/<cam>?h=N); stills = /api/<cam>/latest.jpg re-fetched on a timer.
// A tile shows stills when global stills mode is on, the camera was demoted by the stream
// watchdog (cam.stillFallback — its MJPEG starved, e.g. a proxy connection cap), or the tile
// is a rail thumbnail (only the spotlighted camera holds a stream open).
function tileWantsStills(cam, railTile) {
  return state.stills || cam.stillFallback || !!railTile;
}

function feedSrc(cam, tileHeight, railTile) {
  const h = Math.max(120, Math.min(1080, Math.round(tileHeight || 480)));
  if (tileWantsStills(cam, railTile)) return baseUrl + '/api/' + encodeURIComponent(cam.name) + '/latest.jpg?h=' + h + '&t=' + state.stillTick;
  return baseUrl + '/api/' + encodeURIComponent(cam.name) + '?h=' + h;
}

function feedMarkup(cam, tileHeight, railTile) {
  if (mockMode) {
    if (cam.down) return '<div class="sim" style="background:#07080b"></div>';
    const h = cam.mockHue;
    return '<div class="sim" style="background:radial-gradient(140% 120% at 30% 15%,hsla(' + h + ',22%,26%,1),transparent 60%),linear-gradient(190deg,hsl(' + h + ',16%,15%),hsl(' + h + ',18%,10%) 46%,hsl(' + ((h + 18) % 360) + ',14%,7%) 47%,hsl(' + ((h + 18) % 360) + ',12%,5%))"></div>';
  }
  return '<img class="feed" alt="" data-cam="' + esc(cam.name) + '"' + (tileWantsStills(cam, railTile) ? ' data-still="1"' : '') + ' src="' + esc(feedSrc(cam, tileHeight, railTile)) + '">';
}

const OFF_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">'
  + '<path d="M3 3l18 18"/><path d="M5 12a11 11 0 0 1 4-2.5M2 8.8A16 16 0 0 1 6 6.4M22 8.8a16 16 0 0 0-6.5-3.4"/>'
  + '<path d="M8.5 15.5A6 6 0 0 1 12 14"/><circle cx="12" cy="19" r="0.6" fill="currentColor"/></svg>';

function tileMarkup(cam, index, tileHeight, extraClass, railTile) {
  const stills = tileWantsStills(cam, railTile);
  const recClass = cam.down ? 'rec off' : (stills ? 'rec stills' : 'rec');
  const recLabel = cam.down ? 'OFFLINE' : (stills ? 'STILLS' : 'LIVE');
  return '<button type="button" class="tile' + (extraClass ? ' ' + extraClass : '') + '" data-idx="' + index + '">'
    + feedMarkup(cam, tileHeight, railTile)
    + (cam.down ? '<div class="offmsg">' + OFF_SVG + '<span>SIGNAL LOST</span></div>' : '')
    + '<div class="vig"></div>'
    + '<div class="osd"><div class="osd-top">'
    + '<span class="cidx">CAM ' + (index + 1) + '</span>'
    + '<span class="' + recClass + '"><span class="reddot"></span>' + recLabel + '</span>'
    + '</div><div class="osd-bot">'
    + '<span class="cname">' + esc(cam.label) + '</span>'
    + (cam.down ? '' : '<span class="cstamp">' + stamp() + '</span>')
    + '</div></div></button>';
}

// ── Layout ───────────────────────────────────────────────────────────────────
// Aspect-aware grid: stage is ~1920x424; aim tiles at ~16:9.
function gridShape(n) {
  const stage = $('#stage');
  const ratio = (stage.clientWidth || 1920) / (stage.clientHeight || 424) / (16 / 9);
  const rows = Math.max(1, Math.ceil(Math.sqrt(n / Math.max(0.5, ratio))));
  const cols = Math.max(1, Math.ceil(n / rows));
  return { cols, rows };
}

function render() {
  const stage = $('#stage');
  const cams = state.cams;
  document.querySelectorAll('.chip[data-mode]').forEach(chip => {
    chip.classList.toggle('on', chip.dataset.mode === state.mode);
  });
  const srcChip = $('#src-toggle');
  srcChip.classList.toggle('stills', state.stills);
  $('#src-label').textContent = state.stills ? 'STILLS' : 'LIVE';
  $('#count').textContent = cams.length + (cams.length === 1 ? ' camera' : ' cameras');

  if (!cams.length) return;
  if (state.selected >= cams.length) state.selected = 0;
  stage.className = 'stage ' + state.mode;

  if (state.mode === 'grid') {
    const { cols, rows } = gridShape(cams.length);
    stage.style.gridTemplateColumns = 'repeat(' + cols + ',1fr)';
    stage.style.gridTemplateRows = 'repeat(' + rows + ',1fr)';
    const tileHeight = Math.floor((stage.clientHeight || 424) / rows);
    stage.innerHTML = cams.map((cam, i) => tileMarkup(cam, i, tileHeight)).join('');
  } else if (state.mode === 'spotlight') {
    stage.style.gridTemplateColumns = '';
    stage.style.gridTemplateRows = '';
    const main = cams[state.selected];
    const railCams = cams.map((cam, i) => ({ cam, i }));
    const railHeight = Math.max(90, Math.floor((stage.clientHeight || 424) / Math.max(1, railCams.length)));
    stage.innerHTML = tileMarkup(main, state.selected, stage.clientHeight || 424, 'main')
      + '<div class="rail">'
      + railCams.map(({ cam, i }) => tileMarkup(cam, i, railHeight, i === state.selected ? 'sel' : '', true)).join('')
      + '</div>';
  } else {
    stage.style.gridTemplateColumns = '';
    stage.style.gridTemplateRows = '';
    const cam = cams[state.selected];
    stage.innerHTML = tileMarkup(cam, state.selected, stage.clientHeight || 424)
      + '<div class="cbadge">CAMERA ' + (state.selected + 1) + ' / ' + cams.length
      + (state.cyclePaused ? ' &middot; PAUSED' : '') + '</div>'
      + '<div class="cprog"><i id="cprog-i"></i></div>';
    state.cycleStart = Date.now();
  }
}

// ── Interaction ──────────────────────────────────────────────────────────────
// Mode/selection changes alter how many streams are open, so demoted cameras get a fresh
// chance at live on every switch.
function clearFallbacks() { state.cams.forEach(cam => { cam.stillFallback = false; }); }

document.addEventListener('click', event => {
  const chip = event.target.closest('.chip[data-mode]');
  if (chip) { state.mode = chip.dataset.mode; clearFallbacks(); render(); return; }
  if (event.target.closest('#src-toggle')) { state.stills = !state.stills; render(); return; }
  const tile = event.target.closest('.tile');
  if (!tile) return;
  const index = parseInt(tile.dataset.idx, 10);
  if (state.mode === 'grid') {
    state.selected = index;
    state.mode = 'spotlight';
    clearFallbacks();
    render();
  } else if (state.mode === 'spotlight') {
    if (tile.closest('.rail')) { state.selected = index; clearFallbacks(); render(); }
    else { state.mode = 'grid'; clearFallbacks(); render(); }
  } else {
    state.cyclePaused = !state.cyclePaused;
    render();
  }
});

// ── Timers ───────────────────────────────────────────────────────────────────
// One ticking loop: OSD clocks every second, still refresh on its interval, cycle advance + progress.
setInterval(() => {
  if (!state.cams.length) return;
  document.querySelectorAll('.cstamp').forEach(el => { el.textContent = stamp(); });

  if (!mockMode) {
    state.stillTick += 1;
    if (state.stillTick % refreshSeconds === 0) {
      document.querySelectorAll('img.feed[data-still]').forEach(img => {
        if (!img.complete) return;   // last refresh still downloading — don't restart it
        const cam = state.cams.find(c => c.name === img.dataset.cam);
        if (cam && !cam.down) img.src = feedSrc(cam, img.clientHeight, img.closest('.rail'));
      });
    }
  }

  // Live-stream watchdog: a starved MJPEG connection never fires onerror and never paints
  // (seen behind reverse proxies that cap concurrent streams). Kick it with a fresh
  // connection after 10s; after 2 dead kicks probe latest.jpg — reachable camera falls
  // back to stills for this session, unreachable camera goes offline.
  if (!mockMode) {
    document.querySelectorAll('img.feed:not([data-still])').forEach(img => {
      if (img.naturalWidth > 0) { img.dataset.stall = 0; img.dataset.kicks = 0; return; }
      const stall = (parseInt(img.dataset.stall, 10) || 0) + 1;
      img.dataset.stall = stall;
      if (stall < 10) return;
      img.dataset.stall = 0;
      const kicks = (parseInt(img.dataset.kicks, 10) || 0) + 1;
      img.dataset.kicks = kicks;
      const cam = state.cams.find(c => c.name === img.dataset.cam);
      if (!cam) return;
      if (kicks >= 2) {
        const probe = new Image();
        probe.onload = () => { cam.stillFallback = true; render(); };
        probe.onerror = () => { cam.down = true; render(); };
        probe.src = baseUrl + '/api/' + encodeURIComponent(cam.name) + '/latest.jpg?h=120&t=' + Date.now();
        return;
      }
      img.src = feedSrc(cam, img.clientHeight) + '&r=' + Date.now();
    });
  }

  if (state.mode === 'cycle') {
    const bar = document.getElementById('cprog-i');
    if (state.cyclePaused) { if (bar) bar.style.width = '0'; return; }
    const elapsed = (Date.now() - state.cycleStart) / 1000;
    if (bar) bar.style.width = Math.min(100, elapsed / cycleSeconds * 100) + '%';
    if (elapsed >= cycleSeconds) {
      state.selected = (state.selected + 1) % state.cams.length;
      render();
    }
  }
}, 1000);

// Offline detection: a failed feed marks the camera down; retry every 15s.
document.addEventListener('error', event => {
  const img = event.target;
  if (!img.matches || !img.matches('img.feed')) return;
  const cam = state.cams.find(c => c.name === img.dataset.cam);
  if (cam && !cam.down) { cam.down = true; render(); }
}, true);

setInterval(() => {
  if (mockMode || !state.cams.some(c => c.down)) return;
  state.cams.forEach(cam => {
    if (!cam.down) return;
    const probe = new Image();
    probe.onload = () => { cam.down = false; render(); };
    probe.src = baseUrl + '/api/' + encodeURIComponent(cam.name) + '/latest.jpg?h=120&t=' + Date.now();
  });
}, 15000);

// Re-render when the stage changes size (window resize, editor preview, panel rotation).
let resizeTimer = 0;
let lastStageSize = '';
new ResizeObserver(entries => {
  const box = entries[0].contentRect;
  const size = Math.round(box.width) + 'x' + Math.round(box.height);
  if (size === lastStageSize) return;
  if (lastStageSize === '') { lastStageSize = size; return; }   // initial observation, boot renders
  lastStageSize = size;
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(render, 200);
}).observe($('#stage'));

// ── Boot ─────────────────────────────────────────────────────────────────────
function notice(title, body) {
  $('#stage').innerHTML = '<div class="notice"><h2>' + title + '</h2><p>' + body + '</p></div>';
}

async function boot() {
  applyTheme();
  if (!baseUrl && !mockMode) {
    notice('Set your Frigate URL', 'Open this page\'s App options and enter Frigate\'s internal address, e.g. <code>http://192.168.1.25:5000</code>. Port 5000 is Frigate\'s unauthenticated internal port &mdash; the login port (8971) is not supported yet.');
    return;
  }
  try {
    state.cams = await discover();
  } catch (error) {
    notice('Can\'t reach Frigate', 'No answer from <code>' + esc(baseUrl) + '/api/config</code> (' + esc(error.message) + '). Check the address and that Frigate\'s port 5000 is reachable from this machine.');
    return;
  }
  if (!state.cams.length) {
    notice('No cameras', 'Frigate answered but reported no cameras' + (cameraFilter.length ? ' matching your camera list (<code>' + esc(cameraFilter.join(', ')) + '</code>)' : '') + '.');
    return;
  }
  render();
}

boot();

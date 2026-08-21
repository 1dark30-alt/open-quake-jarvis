'use strict';
// OBS Studio switcher (served app). State-driven: every control reflects OBS's live snapshot pushed
// over SSE (/api/obs/events); taps POST to /api/obs/action. Nothing flips optimistically -- the UI
// re-renders only when OBS confirms via an event. Layout follows the design system's three-part model:
// a compact context strip (connection + broadcast status), the on-air Program scene as the focal point
// plus the scene grid as primary content, grouped control clusters as secondary, and a compact audio
// mixer. Runs under script-src 'self' -- no inline handlers, and dynamic text is set via textContent.
(function () {
  const app = document.getElementById('app');
  const q = new URLSearchParams(location.search);

  document.documentElement.dataset.theme = q.get('_dark') === '0' ? 'light' : 'dark';
  const accent = q.get('_accent');
  if (/^#[0-9a-fA-F]{6}$/.test(accent || '')) {
    document.documentElement.style.setProperty('--accent', accent);
    const r = parseInt(accent.slice(1, 3), 16), g = parseInt(accent.slice(3, 5), 16), b = parseInt(accent.slice(5, 7), 16);
    document.documentElement.style.setProperty('--accent-fg', (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 > 0.6 ? '#06231a' : '#ffffff');
  }
  document.body.classList.add('lay-' + (q.get('layout') === '8x2' ? '8x2' : '12x4'));

  const HOLD_MS = 1500;
  let snap = { connection: 'disconnected', scenes: [], inputs: [], streaming: {}, recording: {}, replay: {} };

  function post(action, value) {
    return fetch('/api/obs/action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, value }) })
      .then(r => r.json()).catch(e => ({ ok: false, error: e.message }));
  }
  function el(tag, cls, txt) { const e = document.createElement(tag); if (cls) e.className = cls; if (txt != null) e.textContent = txt; return e; }
  function labelled(cls, label, name, nameCls) {   // "PROGRAM" over a scene name, used by the focal block
    const box = el('div', cls);
    box.appendChild(el('div', 'lbl', label));
    box.appendChild(el('div', nameCls, name));
    return box;
  }

  // A plain tap control (scene tile, Studio, Save Clip, Cut/Auto, audio row).
  function tapBtn(baseCls, label, sub, onTap) {
    const b = el('button', baseCls);
    b.appendChild(el('span', 'lb', label));
    if (sub != null) b.appendChild(el('span', 'sub', sub));
    b.addEventListener('click', () => onTap(b));
    return b;
  }
  // Hold-to-confirm (Stream / Record / Panic): fires only after a full press-and-hold; releasing early cancels.
  function holdBtn(baseCls, label, sub, onFire) {
    const b = el('button', baseCls + ' hold');
    b.appendChild(el('span', 'lb', label));
    b.appendChild(el('span', 'sub', sub || 'Hold'));
    b.appendChild(el('span', 'holdbar'));
    let t = null;
    const cancel = () => { if (t) clearTimeout(t); t = null; b.classList.remove('holding'); };
    b.addEventListener('pointerdown', e => { e.preventDefault(); b.classList.add('holding'); t = setTimeout(() => { cancel(); onFire(b); }, HOLD_MS); });
    b.addEventListener('pointerup', cancel);
    b.addEventListener('pointerleave', cancel);
    b.addEventListener('pointercancel', cancel);
    return b;
  }
  function pill(cls, text) { const p = el('span', 'pill ' + cls); p.appendChild(el('span', 'pd')); p.appendChild(el('span', null, text)); return p; }

  function statusText() {
    switch (snap.connection) {
      case 'connected': return 'OBS connected';
      case 'connecting': return 'Connecting…';
      case 'reconnecting': return 'Reconnecting…';
      case 'not-running': return 'OBS not reachable';
      default: return 'OBS off';
    }
  }
  function offline() {
    let head = 'Connecting…', msg = 'Reaching OBS…';
    if (snap.connection === 'not-running') { head = 'OBS not reachable'; msg = 'Start OBS and enable Tools → WebSocket Server, or re-check Settings → Auth → OBS Studio.'; }
    else if (snap.connection === 'disconnected') { head = 'OBS is off'; msg = 'Enable it in Settings → Auth → OBS Studio.'; }
    else if (snap.connection === 'reconnecting') { head = 'Reconnecting…'; msg = 'Lost the OBS connection — retrying automatically.'; }
    const box = el('div', 'offline');
    box.appendChild(el('div', 'ohead', head));
    box.appendChild(el('p', null, msg));
    return box;
  }

  function render() {
    app.innerHTML = '';
    const connected = snap.connection === 'connected';

    // ---- context strip: connection (left) + broadcast status pills (right) ----
    const ctx = el('div', 'ctx');
    const conn = el('div', 'conn ' + snap.connection);
    conn.appendChild(el('span', 'dot'));
    conn.appendChild(el('span', 'ctext', statusText()));
    if (connected && snap.obsVersion) conn.appendChild(el('span', 'ver', 'v' + snap.obsVersion));
    ctx.appendChild(conn);
    const bcast = el('div', 'bcast');
    if (connected) {
      if (snap.streaming.active) bcast.appendChild(pill('live', 'Live'));
      if (snap.recording.active) bcast.appendChild(pill('rec' + (snap.recording.paused ? ' paused' : ''), snap.recording.paused ? 'Paused' : 'Rec'));
      if (snap.replay.active) bcast.appendChild(pill('replay', 'Replay'));
      if (snap.studioMode) bcast.appendChild(pill('studio', 'Studio'));
    }
    ctx.appendChild(bcast);
    app.appendChild(ctx);

    if (!connected) { app.appendChild(offline()); return; }

    const main = el('div', 'main');

    // ---- primary: Program focal point + scene grid ----
    const primary = el('div', 'primary');
    const focal = el('div', 'focal');
    focal.appendChild(labelled('prog', 'Program', snap.programScene || '—', 'name'));
    if (snap.studioMode) {
      focal.appendChild(labelled('prev', 'Preview', snap.previewScene || '—', 'pname'));
      const takes = el('div', 'takes');   // Cut/Auto take Preview -> Program; live beside Preview
      takes.appendChild(tapBtn('tk cut', 'Cut', null, () => post('cut')));
      takes.appendChild(tapBtn('tk auto', 'Auto', null, () => post('auto')));
      focal.appendChild(takes);
    }
    primary.appendChild(focal);

    const scard = el('div', 'scenes-card');
    scard.appendChild(el('div', 'scenes-hd', snap.studioMode ? 'Scenes · tap to preview' : 'Scenes'));
    const scenes = el('div', 'scenes');
    (snap.scenes || []).forEach(name => {
      let cls = 'scene', tag = null;
      if (name === snap.programScene) { cls += ' program'; tag = 'On air'; }
      else if (snap.studioMode && name === snap.previewScene) { cls += ' preview'; tag = 'Preview'; }
      scenes.appendChild(tapBtn(cls, name, tag, () => post('sceneTap', name)));
    });
    if (!(snap.scenes || []).length) scenes.appendChild(el('div', 'empty', 'No scenes in OBS'));
    scard.appendChild(scenes);
    primary.appendChild(scard);
    main.appendChild(primary);

    // ---- secondary: grouped control clusters ----
    const controls = el('div', 'controls');
    const gStudio = el('div', 'cgroup');   // Studio / transition
    gStudio.appendChild(tapBtn('btn studio' + (snap.studioMode ? ' on' : ''), 'Studio', snap.studioMode ? 'On' : 'Off', () => post('studioMode')));
    controls.appendChild(gStudio);

    const gCast = el('div', 'cgroup');     // broadcast: stream + record, with replay beside recording
    const row1 = el('div', 'crow');
    row1.appendChild(holdBtn('btn stream' + (snap.streaming.active ? ' live' : ''), snap.streaming.active ? 'Stop' : 'Stream', snap.streaming.active ? 'Live' : 'Hold', () => post(snap.streaming.active ? 'stopStream' : 'startStream')));
    row1.appendChild(holdBtn('btn record' + (snap.recording.active ? (snap.recording.paused ? ' paused' : ' rec') : ''), snap.recording.active ? 'Stop Rec' : 'Record', snap.recording.active ? (snap.recording.paused ? 'Paused' : 'Rec') : 'Hold', () => post(snap.recording.active ? 'stopRecord' : 'startRecord')));
    gCast.appendChild(row1);
    const row2 = el('div', 'crow');
    if (snap.recording.active) row2.appendChild(tapBtn('btn recpause', snap.recording.paused ? 'Resume' : 'Pause', 'Rec', () => post(snap.recording.paused ? 'resumeRecord' : 'pauseRecord')));
    row2.appendChild(tapBtn('btn replay' + (snap.replay.active ? ' on' : ''), 'Save Clip', snap.replay.active ? 'Ready' : 'Buffer off', () => post('saveReplay')));
    gCast.appendChild(row2);
    controls.appendChild(gCast);

    controls.appendChild(holdBtn('btn panic', 'Panic', 'Safe scene', () => post('panic')));
    main.appendChild(controls);

    // ---- audio mixer (compact channel strip) ----
    const mixer = el('div', 'mixer');
    mixer.appendChild(el('div', 'mixer-hd', 'Audio'));
    const list = el('div', 'mixer-list');
    if ((snap.inputs || []).length) {
      snap.inputs.forEach(inp => {
        const b = el('button', 'aud ' + (inp.muted ? 'muted' : 'live'));
        b.appendChild(el('span', 'an', inp.name));
        const st = el('span', 'ast');
        st.appendChild(el('span', 'ad'));
        st.appendChild(el('span', null, inp.muted ? 'Muted' : 'Live'));
        b.appendChild(st);
        b.addEventListener('click', () => post('toggleMute', inp.name));
        list.appendChild(b);
      });
    } else {
      list.appendChild(el('div', 'empty', 'No audio inputs'));
    }
    mixer.appendChild(list);
    main.appendChild(mixer);

    app.appendChild(main);
  }

  function apply(s) { if (s && typeof s === 'object') { snap = s; render(); } }
  const es = new EventSource('/api/obs/events');
  es.onmessage = e => { try { apply(JSON.parse(e.data)); } catch (err) {} };
  fetch('/api/obs/state').then(r => r.json()).then(apply).catch(() => {});
  render();
})();

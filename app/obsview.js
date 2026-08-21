'use strict';
// OBS Studio switcher (served app). State-driven: every control reflects OBS's live snapshot pushed
// over SSE (/api/obs/events); taps POST to /api/obs/action. Nothing flips optimistically -- the UI
// re-renders when OBS confirms via an event. Layout follows the design system: a context strip whose
// focal point is the on-air Program scene, the scene grid as primary content, a stable control rail
// as secondary, and an audio row. Runs under script-src 'self' (no inline handlers).
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
  function el(tag, cls, html) { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }
  function setText(node, sel, txt) { const t = node.querySelector(sel); if (t) t.textContent = txt; }

  function tap(label, sub, cls, onTap) {
    const b = el('button', 'tile ' + (cls || ''), '<span class="lb"></span>' + (sub ? '<span class="sub"></span>' : ''));
    setText(b, '.lb', label); if (sub) setText(b, '.sub', sub);
    b.addEventListener('click', () => onTap(b));
    return b;
  }
  // Hold-to-confirm (safety for stream/record/panic): fires only after a full press-and-hold.
  function hold(label, sub, cls, onFire) {
    const b = el('button', 'tile hold ' + (cls || ''), '<span class="lb"></span><span class="sub"></span><span class="holdbar"></span>');
    setText(b, '.lb', label); setText(b, '.sub', sub || 'hold');
    let t = null;
    const cancel = () => { if (t) clearTimeout(t); t = null; b.classList.remove('holding'); };
    b.addEventListener('pointerdown', e => { e.preventDefault(); b.classList.add('holding'); t = setTimeout(() => { cancel(); onFire(b); }, HOLD_MS); });
    b.addEventListener('pointerup', cancel);
    b.addEventListener('pointerleave', cancel);
    b.addEventListener('pointercancel', cancel);
    return b;
  }

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
    let msg = 'Connecting to OBS…';
    if (snap.connection === 'not-running') msg = 'OBS isn’t reachable. Start OBS and enable Tools → WebSocket Server, or re-check Settings → Auth → OBS Studio.';
    else if (snap.connection === 'disconnected') msg = 'OBS is off. Enable it in Settings → Auth → OBS Studio.';
    else if (snap.connection === 'reconnecting') msg = 'Lost the OBS connection — reconnecting…';
    const box = el('div', 'offline card', '<div class="obig">OBS</div>');
    const p = el('p'); p.textContent = msg; box.appendChild(p);
    return box;
  }

  function render() {
    app.innerHTML = '';
    const connected = snap.connection === 'connected';

    // ---- context strip (focal: what's on-air) ----
    const ctx = el('div', 'ctx');
    const status = el('div', 'status card ' + snap.connection,
      '<div class="row1"><span class="dot"></span><span class="stext"></span></div><div class="row2"></div>');
    setText(status, '.stext', statusText());
    setText(status, '.row2', connected && snap.obsVersion ? 'OBS-WebSocket v' + snap.obsVersion : '');
    ctx.appendChild(status);

    const onair = el('div', 'onair card');
    const prog = el('div', 'slot prog', '<span class="k">Program</span><span class="v"></span>');
    setText(prog, '.v', connected ? (snap.programScene || '—') : '—');
    onair.appendChild(prog);
    if (connected && snap.studioMode) {
      const prev = el('div', 'slot prev', '<span class="k">Preview</span><span class="v"></span>');
      setText(prev, '.v', snap.previewScene || '—');
      onair.appendChild(prev);
      const takes = el('div', 'take-cluster');   // Cut/Auto take Preview -> Program; they live next to Preview
      takes.appendChild(tap('Cut', 'take', 'take cut', () => post('cut')));
      takes.appendChild(tap('Auto', 'transition', 'take auto', () => post('auto')));
      onair.appendChild(takes);
    }
    ctx.appendChild(onair);
    app.appendChild(ctx);

    if (!connected) { app.appendChild(offline()); return; }

    // ---- body: scenes (primary) + control rail (secondary) ----
    const body = el('div', 'body');
    const scard = el('div', 'scenes-card card');
    scard.appendChild(el('div', 'h', 'Scenes' + (snap.studioMode ? '  ·  tap → preview' : '')));
    const scenes = el('div', 'scenes');
    (snap.scenes || []).forEach(name => {
      let cls = 'scene', tag = '';
      if (name === snap.programScene) { cls += ' program'; tag = 'ON AIR'; }
      else if (snap.studioMode && name === snap.previewScene) { cls += ' preview'; tag = 'PREVIEW'; }
      scenes.appendChild(tap(name, tag, cls, () => post('sceneTap', name)));
    });
    if (!snap.scenes || !snap.scenes.length) scenes.appendChild(el('div', 'empty', 'No scenes in OBS'));
    scard.appendChild(scenes);
    body.appendChild(scard);

    const rail = el('div', 'rail');
    rail.appendChild(tap('Studio', snap.studioMode ? 'ON' : 'off', 'studio' + (snap.studioMode ? ' on' : ''), () => post('studioMode')));
    rail.appendChild(hold(snap.streaming.active ? 'Stop' : 'Stream', snap.streaming.active ? 'LIVE' : 'hold',
      'stream' + (snap.streaming.active ? ' live' : ''), () => post(snap.streaming.active ? 'stopStream' : 'startStream')));
    rail.appendChild(hold(snap.recording.active ? 'Stop Rec' : 'Record',
      snap.recording.active ? (snap.recording.paused ? 'PAUSED' : 'REC') : 'hold',
      'record' + (snap.recording.active ? (snap.recording.paused ? ' paused' : ' rec') : ''),
      () => post(snap.recording.active ? 'stopRecord' : 'startRecord')));
    if (snap.recording.active) rail.appendChild(tap(snap.recording.paused ? 'Resume' : 'Pause', 'rec', 'recpause', () => post(snap.recording.paused ? 'resumeRecord' : 'pauseRecord')));
    rail.appendChild(tap('Save Clip', snap.replay.active ? 'ready' : 'buffer off', 'replay' + (snap.replay.active ? ' on' : ''), () => post('saveReplay')));
    rail.appendChild(hold('Panic', 'safe scene', 'panic', () => post('panic')));
    body.appendChild(rail);
    app.appendChild(body);

    // ---- audio mutes ----
    if ((snap.inputs || []).length) {
      const audio = el('div', 'audio');
      snap.inputs.forEach(inp => audio.appendChild(tap(inp.name, inp.muted ? 'MUTED' : 'live', 'aud' + (inp.muted ? ' muted' : ' live'), () => post('toggleMute', inp.name))));
      app.appendChild(audio);
    }
  }

  function apply(s) { if (s && typeof s === 'object') { snap = s; render(); } }
  const es = new EventSource('/api/obs/events');
  es.onmessage = e => { try { apply(JSON.parse(e.data)); } catch (err) {} };
  fetch('/api/obs/state').then(r => r.json()).then(apply).catch(() => {});
  render();
})();

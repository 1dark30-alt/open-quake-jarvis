'use strict';

const RUNNING_VERSION = '1.0.1';
const params = new URLSearchParams(location.search);
const refreshSeconds = Math.max(15, Math.min(300, parseInt(params.get('refreshSeconds'), 10) || 30));
const PERIODS = ['today', '7d', '30d', 'all'];
const PERIOD_LABEL = { today: 'today', '7d': '7 days', '30d': '30 days', all: 'all time' };

let period = PERIODS.includes(params.get('period')) ? params.get('period') : '7d';

const $ = s => document.querySelector(s);
const panels = { claude: $('#p-claude'), codex: $('#p-codex'), copilot: $('#p-copilot') };

// ── Formatting ──────────────────────────────────────────────────────────────
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function num(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}
function intc(n) { return (Number(n) || 0).toLocaleString(); }
function resetIn(sec) {
  if (!sec) return '';
  let ms = sec * 1000 - Date.now();
  if (ms <= 0) return 'now';
  const d = Math.floor(ms / 86400000); ms -= d * 86400000;
  const h = Math.floor(ms / 3600000); ms -= h * 3600000;
  const m = Math.floor(ms / 60000);
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}
function levelColor(pct) { return pct >= 90 ? 'var(--error)' : pct >= 70 ? 'var(--warning)' : 'var(--success)'; }

// A labelled ring gauge. pct null → empty ring with a dash.
function ring(label, pct, resetsAt, opts) {
  opts = opts || {};
  const has = typeof pct === 'number';
  const p = has ? Math.max(0, Math.min(100, pct)) : 0;
  const col = has ? levelColor(pct) : 'var(--track)';
  const resetLine = resetsAt ? 'resets in <b>' + resetIn(resetsAt) + '</b>'
    : (opts.resetText || '&nbsp;');
  return '<div class="gauge"><div class="glabel">' + label + '</div>'
    + '<div class="ring' + (opts.big ? ' big' : '') + '" style="--pct:' + p + ';--ring:' + col + '">'
    + '<div class="hole"><span class="val">' + (has ? Math.round(pct) + '<span class="u">%</span>' : '&mdash;') + '</span>'
    + (opts.sub ? '<span class="sub">' + opts.sub + '</span>' : '') + '</div></div>'
    + '<div class="reset' + (resetsAt ? '' : ' none') + '">' + resetLine + '</div></div>';
}
function bigstat(v, l) { return '<div class="bigstat"><div class="v">' + v + '</div><div class="l">' + l + '</div></div>'; }
function head(name, sub, chip, chipCls) {
  return '<div class="phead"><div class="pname"><b>' + name + '</b><span>' + sub + '</span></div>'
    + (chip ? '<div class="pchip ' + (chipCls || '') + '">' + chip + '</div>' : '') + '</div>';
}
function errState(msg) { return '<div class="state err"><h3>Error</h3><p>' + esc(msg) + '</p></div>'; }
function scanState(name, sub) {
  return head(name, sub, '') + '<div class="state"><div class="scan"></div><p>Scanning session logs&hellip;</p></div>';
}

// ── Claude panel ────────────────────────────────────────────────────────────
function renderClaude(d) {
  if (!d.ok) return head('Claude', 'Code &middot; Cowork', '') + errState(d.error || 'failed');
  if (!d.dir || d.files === 0) {
    return head('Claude', 'Code &middot; Cowork', '')
      + '<div class="state"><h3>No Claude activity</h3><p>No Claude&nbsp;Code logs found under <b>~/.claude</b> on this machine.</p></div>';
  }
  const plan = d.plan ? d.plan[0].toUpperCase() + d.plan.slice(1) + ' plan' : '';
  // Live limits if the host resolved them via the Claude usage endpoint; else pending.
  let gauges;
  if (d.limit) {
    const parts = [ring('5-hour', d.limit.fiveHourPct, d.limit.fiveHourResetsAt)];
    parts.push(ring('Weekly', d.limit.weeklyPct, d.limit.weeklyResetsAt));
    gauges = '<div class="gauges">' + parts.join('') + '</div>';
  } else {
    gauges = '<div class="gauges">'
      + ring('5-hour', null, 0, { resetText: 'needs Claude sign-in' })
      + ring('Weekly', null, 0, { resetText: 'see the app options' })
      + '</div>';
  }
  return head('Claude', 'Code &middot; Cowork', plan || (d.limit ? '' : 'connect'), d.limit ? 'good' : 'warn')
    + gauges
    + '<div class="subrow">'
    + bigstat(intc(d.msgs), 'Messages &middot; ' + PERIOD_LABEL[period])
    + bigstat(num(d.inp + d.out + d.cacheRead + d.cacheWrite), 'Tokens')
    + bigstat(intc(d.sessions), 'Sessions')
    + '</div>';
}

// ── Codex / ChatGPT panel ───────────────────────────────────────────────────
function renderCodex(d) {
  if (!d.ok) return head('ChatGPT', 'Codex CLI', '') + errState(d.error || 'failed');
  if (!d.dir || d.files === 0) {
    return head('ChatGPT', 'Codex CLI', '')
      + '<div class="state"><h3>No Codex activity</h3><p>No Codex CLI logs found under <b>~/.codex</b> on this machine.</p></div>';
  }
  const lim = d.limit;
  const chip = lim && lim.model ? esc(lim.model) : '';
  let gauges;
  if (lim && (typeof lim.weeklyPct === 'number' || typeof lim.shortPct === 'number')) {
    const parts = [];
    if (lim.hasShort && typeof lim.shortPct === 'number') parts.push(ring('5-hour', lim.shortPct, lim.shortResetsAt));
    if (typeof lim.weeklyPct === 'number') parts.push(ring('Weekly', lim.weeklyPct, lim.weeklyResetsAt));
    gauges = '<div class="gauges">' + parts.join('') + '</div>';
  } else {
    gauges = '<div class="gauges"><div class="gauge"><div class="glabel">activity</div>'
      + '<div class="ring" style="--pct:0"><div class="hole"><span class="val">' + intc(d.msgs) + '</span><span class="sub">messages</span></div></div>'
      + '<div class="reset none">no limit data in logs</div></div></div>';
  }
  return head('ChatGPT', 'Codex CLI', chip)
    + gauges
    + '<div class="subrow">'
    + bigstat(intc(d.msgs), 'Messages &middot; ' + PERIOD_LABEL[period])
    + bigstat(num(d.tokens), 'Tokens')
    + bigstat(intc(d.sessions), 'Sessions')
    + '</div>';
}

// ── Copilot panel ───────────────────────────────────────────────────────────
function renderCopilot(d) {
  if (!d.ok) return head('Copilot', 'GitHub', 'error', 'err') + errState(d.error || 'failed');
  if (!d.configured) {
    return head('Copilot', 'GitHub', 'not connected', 'warn')
      + '<div class="state"><h3>Connect GitHub</h3><p>To show Copilot premium-request usage:</p>'
      + '<ol><li>Open this app&rsquo;s <b>options</b> in the editor</li>'
      + '<li>Set your <b>GitHub username</b></li>'
      + '<li>Paste a token with <b>Plan: read-only</b></li></ol></div>';
  }
  const included = Number(d.included) || 0;
  const used = Number(d.used) || 0;
  const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).getTime() / 1000;
  const remaining = Math.max(0, included - used);
  let body;
  if (included > 0) {
    const pct = used / included * 100;
    body = '<div class="gauges one">'
      + '<div class="gauge"><div class="glabel">This month</div>'
      + '<div class="ring big" style="--pct:' + Math.min(100, pct).toFixed(1) + ';--ring:' + levelColor(pct) + '">'
      + '<div class="hole"><span class="val">' + Math.round(pct) + '<span class="u">%</span></span><span class="sub">of quota</span></div></div>'
      + '<div class="reset">resets in <b>' + resetIn(monthEnd) + '</b></div></div>'
      + '<div class="sideblock">'
      + '<div class="row"><b>' + intc(used) + '</b> used</div>'
      + '<div class="row"><b>' + intc(remaining) + '</b> left of ' + intc(included) + '</div>'
      + (d.net > 0 ? '<div class="row">overage <b>$' + d.net.toFixed(2) + '</b></div>' : '')
      + '</div></div>';
  } else {
    body = '<div class="gauges one"><div class="gauge"><div class="glabel">This month</div>'
      + '<div class="ring big" style="--pct:0"><div class="hole"><span class="val">' + intc(used) + '</span><span class="sub">requests</span></div></div>'
      + '<div class="reset">resets in <b>' + resetIn(monthEnd) + '</b></div></div></div>';
  }
  return head('Copilot', 'GitHub', '@' + esc(d.user), 'good')
    + body
    + '<div class="subrow">'
    + bigstat(included > 0 ? intc(included) : '&mdash;', 'Monthly quota')
    + bigstat('$' + (Number(d.net) || 0).toFixed(2), 'Billed overage')
    + '</div>';
}

// ── Data loop ────────────────────────────────────────────────────────────────
async function apiCall(action, extra) {
  const url = new URL('/app-api/' + action, location.origin);
  Object.entries(extra || {}).forEach(([k, v]) => { if (v != null && v !== '') url.searchParams.set(k, v); });
  const res = await fetch(url.pathname + url.search, { cache: 'no-store' });
  const text = await res.text();
  let payload = {};
  try { payload = text ? JSON.parse(text) : {}; } catch (e) {}
  if (!res.ok && payload.ok !== false) throw new Error('HTTP ' + res.status);
  return payload;
}
async function loadOne(action, key, renderFn, extra) {
  try { panels[key].innerHTML = renderFn(await apiCall(action, extra)); }
  catch (e) { panels[key].innerHTML = errState(e.message || 'request failed'); }
}
function stampUpdated() {
  const t = new Date();
  $('#updated').innerHTML = 'updated ' + t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    + '<span class="dot"></span>';
}
async function refreshAll() {
  const dot = $('#updated').querySelector('.dot'); if (dot) dot.className = 'dot busy';
  await Promise.all([
    loadOne('claude', 'claude', renderClaude, { period }),
    loadOne('codex', 'codex', renderCodex, { period }),
    loadOne('copilot', 'copilot', renderCopilot),
  ]);
  stampUpdated();
}
function applyPeriod(p) {
  if (!PERIODS.includes(p)) return;
  period = p;
  document.querySelectorAll('#periods button').forEach(b => b.classList.toggle('sel', b.dataset.p === p));
  refreshAll();
}

$('#periods').addEventListener('click', e => {
  const b = e.target.closest('button[data-p]');
  if (b) applyPeriod(b.dataset.p);
});

// Panel knob: rotate cycles the period, single-press refreshes; everything else declines.
window.oqKnob = function (ev) {
  if (ev.type === 'rotate') {
    let i = PERIODS.indexOf(period) + (ev.dir > 0 ? 1 : -1);
    applyPeriod(PERIODS[(i + PERIODS.length) % PERIODS.length]);
    return true;
  }
  if (ev.type === 'press' && ev.index === 1) { refreshAll(); return true; }
  return false;
};

document.documentElement.dataset.theme = params.get('_dark') === '0' ? 'light' : 'dark';

// Self-heal after an update: the host swaps files on disk but won't reload a live page.
setInterval(async () => {
  try {
    const m = await (await fetch('app.json', { cache: 'no-store' })).json();
    if (m.version && m.version !== RUNNING_VERSION) location.reload();
  } catch (e) {}
}, 30000);

document.querySelectorAll('#periods button').forEach(b => b.classList.toggle('sel', b.dataset.p === period));
panels.claude.innerHTML = scanState('Claude', 'Code &middot; Cowork');
panels.codex.innerHTML = scanState('ChatGPT', 'Codex CLI');
panels.copilot.innerHTML = scanState('Copilot', 'GitHub');
refreshAll();
setInterval(refreshAll, refreshSeconds * 1000);

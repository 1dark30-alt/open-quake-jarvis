'use strict';

const RUNNING_VERSION = '1.0.0';
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
function money(x) {
  x = Number(x) || 0;
  if (x >= 10000) return '$' + (x / 1000).toFixed(1) + 'k';
  if (x >= 1000) return '$' + Math.round(x).toLocaleString();
  if (x >= 10) return '$' + x.toFixed(0);
  return '$' + x.toFixed(2);
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
function shortModel(m) { return String(m || '').replace(/^claude-/, ''); }
function modelColor(m) {
  m = String(m || '').toLowerCase();
  if (m.includes('fable') || m.includes('mythos')) return '#e05c9c';
  if (m.includes('opus')) return '#e08a5c';
  if (m.includes('sonnet')) return '#5c9ce0';
  if (m.includes('haiku')) return '#5ce0a8';
  return '#8a94a0';
}
function levelColor(pct) { return pct >= 90 ? 'var(--error)' : pct >= 70 ? 'var(--warning)' : 'var(--success)'; }

function sparkBars(series, fmt) {
  const max = Math.max(1, ...series.map(s => s.value));
  const last = series.length - 1;
  const bars = series.map((s, i) =>
    '<i class="' + (i === last ? 'today' : '') + '" style="height:' + Math.max(2, Math.round(s.value / max * 100)) + '%"></i>').join('');
  const peak = series.reduce((a, s) => s.value > a.value ? s : a, series[0] || { value: 0 });
  return { bars, peak: fmt(peak.value) };
}

function statChip(v, l) { return '<div class="stat"><div class="v">' + v + '</div><div class="l">' + l + '</div></div>'; }
function head(name, sub, chip, chipCls) {
  return '<div class="phead"><div class="pname"><b>' + name + '</b><span>' + sub + '</span></div>'
    + (chip ? '<div class="pchip ' + (chipCls || '') + '">' + chip + '</div>' : '') + '</div>';
}
function errState(msg) { return '<div class="state err"><h3>Error</h3><p>' + esc(msg) + '</p></div>'; }
function scanState(name, sub) {
  return head(name, sub, '') + '<div class="state"><div class="scan"></div><p>Scanning session logs&hellip;<br>first run can take a moment.</p></div>';
}

// ── Claude panel ────────────────────────────────────────────────────────────
function renderClaude(d) {
  if (!d.ok) return head('Claude', 'Code &middot; Cowork', '') + errState(d.error || 'failed');
  if (!d.dir || d.files === 0) {
    return head('Claude', 'Code &middot; Cowork', '')
      + '<div class="state"><h3>No Claude activity</h3><p>No Claude&nbsp;Code session logs were found under <b>~/.claude</b> on this machine.</p></div>';
  }
  const chip = intc(d.sessions) + ' sessions';
  const models = (d.models || []).filter(m => m.cost > 0);
  const totalCost = models.reduce((a, m) => a + m.cost, 0);
  let split = '';
  if (totalCost > 0) {
    split = '<div class="split">' + models.map(m =>
      '<i style="width:' + (m.cost / totalCost * 100).toFixed(1) + '%;background:' + modelColor(m.model) + '"></i>').join('') + '</div>'
      + '<div class="splitleg">' + models.map(m =>
        '<span><s style="background:' + modelColor(m.model) + '"></s>' + esc(shortModel(m.model)) + ' ' + money(m.cost) + '</span>').join('') + '</div>';
  }
  const sp = sparkBars(d.spark || [], money);
  return head('Claude', 'Code &middot; Cowork', chip)
    + '<div class="focal"><div class="hero" style="flex:1">'
    + '<div class="big"><span class="cur">&#8776;</span>' + money(d.cost).replace('$', '$') + '</div>'
    + '<div class="cap">est. value &middot; ' + PERIOD_LABEL[period] + ' &middot; at API rates</div>'
    + split + '</div></div>'
    + '<div class="chips">'
    + statChip(intc(d.msgs), 'Messages')
    + statChip(num(d.inp + d.out), 'In + out tokens')
    + statChip(num(d.cacheRead), 'Cache read')
    + statChip(num(d.cacheWrite), 'Cache write')
    + '</div>'
    + '<div class="sparkwrap"><div class="spark">' + sp.bars + '</div>'
    + '<div class="sparkcap"><span>14-day spend</span><span>peak ' + sp.peak + '</span></div></div>';
}

// ── Codex / ChatGPT panel ───────────────────────────────────────────────────
function renderCodex(d) {
  if (!d.ok) return head('ChatGPT', 'Codex CLI', '') + errState(d.error || 'failed');
  if (!d.dir || d.files === 0) {
    return head('ChatGPT', 'Codex CLI', '')
      + '<div class="state"><h3>No Codex activity</h3><p>No Codex CLI session logs were found under <b>~/.codex</b> on this machine.</p></div>';
  }
  const lim = d.limit;
  const chip = lim && lim.model ? esc(lim.model) : intc(d.sessions) + ' sessions';
  let focal;
  if (lim && typeof lim.weeklyPct === 'number') {
    const pct = Math.max(0, Math.min(100, lim.weeklyPct));
    focal = '<div class="ring" style="--pct:' + pct + ';--ring:' + levelColor(lim.weeklyPct) + '">'
      + '<div class="hole"><span class="val">' + Math.round(lim.weeklyPct) + '<i>%</i></span><span class="lbl">weekly</span></div></div>'
      + '<div class="ringside"><div class="cap"><b>Weekly limit</b></div>'
      + (lim.weeklyResetsAt ? '<div class="cap">resets in <b>' + resetIn(lim.weeklyResetsAt) + '</b></div>' : '')
      + (lim.hasShort ? '<div class="cap">5-hr window <b>' + Math.round(lim.shortPct) + '%</b>'
          + (lim.shortResetsAt ? ' &middot; ' + resetIn(lim.shortResetsAt) : '') + '</div>' : '')
      + '</div>';
  } else {
    focal = '<div class="hero" style="flex:1"><div class="big">' + intc(d.msgs) + '</div>'
      + '<div class="cap">messages &middot; ' + PERIOD_LABEL[period] + '</div>'
      + '<div class="cap" style="text-transform:none;margin-top:6px">No rate-limit data in logs yet.</div></div>';
  }
  const sp = sparkBars(d.spark || [], v => intc(Math.round(v)));
  return head('ChatGPT', 'Codex CLI', chip)
    + '<div class="focal">' + focal + '</div>'
    + '<div class="chips">'
    + statChip(intc(d.msgs), 'Messages &middot; ' + PERIOD_LABEL[period])
    + statChip(num(d.tokens), 'Tokens')
    + statChip(intc(d.sessions), 'Sessions')
    + statChip(num(d.cachedIn), 'Cached input')
    + '</div>'
    + '<div class="sparkwrap"><div class="spark">' + sp.bars + '</div>'
    + '<div class="sparkcap"><span>14-day activity</span><span>peak ' + sp.peak + ' msgs</span></div></div>';
}

// ── Copilot panel ───────────────────────────────────────────────────────────
function renderCopilot(d) {
  if (!d.ok) return head('Copilot', 'GitHub', 'error', 'err') + errState(d.error || 'failed');
  if (!d.configured) {
    return head('Copilot', 'GitHub', 'not connected', 'warn')
      + '<div class="state"><h3>Connect GitHub</h3><p>Show your Copilot premium-request usage:</p>'
      + '<ol><li>Open this app&rsquo;s <b>options</b> in the editor</li>'
      + '<li>Set <b>GitHub username</b></li>'
      + '<li>Paste a token with <b>Plan: read-only</b> permission</li></ol></div>';
  }
  const included = Number(d.included) || 0;
  const used = Number(d.used) || 0;
  const monthEnd = new Date(new Date().getFullYear(), new Date().getMonth() + 1, 1).getTime() / 1000;
  let focal;
  if (included > 0) {
    const pct = Math.max(0, Math.min(100, used / included * 100));
    focal = '<div class="ring" style="--pct:' + pct.toFixed(1) + ';--ring:' + levelColor(pct) + '">'
      + '<div class="hole"><span class="val">' + intc(used) + '</span><span class="lbl">used</span></div></div>'
      + '<div class="ringside"><div class="cap">of <b>' + intc(included) + '</b> this month</div>'
      + '<div class="cap">resets in <b>' + resetIn(monthEnd) + '</b></div>'
      + (d.net > 0 ? '<div class="cap">overage <b>$' + d.net.toFixed(2) + '</b></div>' : '') + '</div>';
  } else {
    focal = '<div class="hero" style="flex:1"><div class="big">' + intc(used) + '</div>'
      + '<div class="cap">premium requests &middot; this month</div></div>';
  }
  const remaining = Math.max(0, included - used);
  return head('Copilot', 'GitHub', '@' + esc(d.user), 'good')
    + '<div class="focal">' + focal + '</div>'
    + '<div class="chips">'
    + statChip(included > 0 ? intc(included) : '&mdash;', 'Included / mo')
    + statChip(included > 0 ? intc(remaining) : '&mdash;', 'Remaining')
    + statChip('$' + (Number(d.net) || 0).toFixed(2), 'Billed overage')
    + statChip(esc(d.period || ''), 'Billing month')
    + '</div>'
    + '<div class="sparkcap" style="margin-top:12px"><span>source: ' + esc(d.source || 'github') + ' billing API</span><span></span></div>';
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
function setDot(cls) { const u = $('#updated'); const d = u.querySelector('.dot'); if (d) d.className = 'dot ' + (cls || ''); }
function stampUpdated() {
  const t = new Date();
  $('#updated').innerHTML = 'updated ' + t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    + '<span class="dot"></span>';
}
async function refreshAll() {
  const u = $('#updated');
  if (u.querySelector('.dot')) setDot('busy');
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

// Theme (host passes _dark=0 for light).
document.documentElement.dataset.theme = params.get('_dark') === '0' ? 'light' : 'dark';

// Self-heal after an update: the host swaps files on disk but won't reload a live page.
setInterval(async () => {
  try {
    const m = await (await fetch('app.json', { cache: 'no-store' })).json();
    if (m.version && m.version !== RUNNING_VERSION) location.reload();
  } catch (e) {}
}, 30000);

// Boot: show scanning placeholders, then load. Re-sync the period buttons first.
document.querySelectorAll('#periods button').forEach(b => b.classList.toggle('sel', b.dataset.p === period));
panels.claude.innerHTML = scanState('Claude', 'Code &middot; Cowork');
panels.codex.innerHTML = scanState('ChatGPT', 'Codex CLI');
panels.copilot.innerHTML = scanState('Copilot', 'GitHub');
refreshAll();
setInterval(refreshAll, refreshSeconds * 1000);

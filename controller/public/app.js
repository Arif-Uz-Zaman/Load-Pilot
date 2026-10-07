'use strict';
/* LoadPilot UI — vanilla JS, no build step. */

const $ = (id) => document.getElementById(id);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

const fmt = {
  n: (v) => v == null ? '–' : Number(v).toLocaleString('en-US'),
  ms: (v) => v == null ? '–' : `${fmt.n(Math.round(v))} ms`,
  pct: (v) => v == null ? '–' : `${v}%`,
  tp: (v) => v == null ? '–' : `${v}/sec`, // throughput, JMeter-style
  dur: (sec) => { // elapsed clock, JMeter-style 00:01:40
    if (sec == null) return '–';
    const s = Math.max(0, Math.round(sec));
    return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60]
      .map((v) => String(v).padStart(2, '0')).join(':');
  },
  time: (sec) => new Date(sec * 1000).toLocaleTimeString('en-GB'),
  dt: (iso) => iso ? new Date(iso).toLocaleString('en-GB') : '–',
  ymd: (iso) => { // report style: 2026-07-01 10:10
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  },
};

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['content-type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

// ---------------- inline SVG icons ----------------
// Emoji glyphs (⬆ ⏱ 🖨 🧵 🗀 ⊞ ⊟ …) render as tofu boxes on machines whose
// fonts lack them. These stroke-based SVGs use currentColor and render the
// same everywhere. `ic(name)` returns a 1em inline icon.
const ICONS = {
  upload:   'M8 10.5V2.8M8 2.8 5 5.8M8 2.8l3 3M2.8 12.5h10.4',
  download: 'M8 2.5v7.7M8 10.2 5 7.2M8 10.2l3-3M2.8 13h10.4',
  clock:    'CIRCLE M8 4.6V8l2.4 1.5',
  printer:  'M4.5 6V2.5h7V6M4.5 11.5h-1a1 1 0 0 1-1-1V7.2a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v3.3a1 1 0 0 1-1 1h-1M4.5 9.8h7v3.7h-7z',
  folder:   'M2.2 4.2a1 1 0 0 1 1-1h3l1.4 1.5h5a1 1 0 0 1 1 1v6.1a1 1 0 0 1-1 1H3.2a1 1 0 0 1-1-1z',
  layers:   'M8 2 14 5.3 8 8.6 2 5.3zM2 8.2l6 3.3 6-3.3M2 10.9l6 3.3 6-3.3',
  expand:   'M8 3v10M3 8h10',   // plus
  collapse: 'M3 8h10',           // minus
  warn:     'M8 2 14.5 13.5H1.5zM8 6.3v3.2M8 11.4v.1',
  calendar: 'M3 3.5h10a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1zM2 6.5h12M5.5 2v3M10.5 2v3',
  bolt:     'M9 1.6 3.4 9.2H7.5l-.8 5.2 5.9-7.6H8.2z',
  gauge:    'CIRCLE M8 8l2.6-1.8',
  cube:     'M8 1.7 14 5v6l-6 3.3L2 11V5zM2 5l6 3.3 6-3.3M8 8.3V15',
  fail:     'CIRCLE M6 6l4 4M10 6l-4 4',
  check:    'M3.2 8.4 6.4 11.5 12.8 4.8',
};
function ic(name, cls) {
  const d = ICONS[name] || '';
  const circle = d.startsWith('CIRCLE') ? '<circle cx="8" cy="8" r="6"/>' : '';
  const path = d.replace('CIRCLE ', '');
  return `<svg class="ic ${cls || ''}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.55" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${circle}${path ? `<path d="${path}"/>` : ''}</svg>`;
}

// ---------------- pass/fail SLA ----------------

let slaThresholds = null; // { maxErrorPct, maxP90Ms, minThroughput } — null entries not enforced
function slaActive() {
  const s = slaThresholds;
  return !!(s && (s.maxErrorPct != null || s.maxP90Ms != null || s.minThroughput != null));
}
// 'pass' | 'fail' | null (null = no thresholds set, or run has no results)
function slaVerdict(r) {
  const s = slaThresholds, o = r && r.overall;
  if (!slaActive() || !o) return null;
  if (s.maxErrorPct != null && o.errorPct > s.maxErrorPct) return 'fail';
  if (s.maxP90Ms != null && o.p90 > s.maxP90Ms) return 'fail';
  if (s.minThroughput != null && o.throughput < s.minThroughput) return 'fail';
  return 'pass';
}
function slaPill(r) {
  const v = slaVerdict(r);
  return v ? ` <span class="sla-pill ${v}">${v === 'pass' ? 'PASS' : 'FAIL'}</span>` : '';
}
async function ensureSla() {
  if (slaThresholds) return;
  try { slaThresholds = await api('GET', '/api/sla'); } catch { /* leave null */ }
}

// ---------------- state ----------------

const state = {
  agents: [],
  teams: [],           // saved agent groups
  editingTeamId: null, // team being edited in the Team view
  plan: null,       // uploaded plan {id, name, structure}
  library: [],      // persistent data-file library (shared across all plans)
  run: null,        // active/last run meta
  live: null,       // latest liveStats payload
  distMode: 'split',   // 'split' (even) | 'per-agent' (own profile per agent)
  profiles: {},        // agentName -> config, in per-agent mode
  editingAgent: null,  // which agent's profile the form currently shows
};

// ---------------- theme toggle ----------------

function applyTheme(t) { // 'dark' | 'light' | null (follow OS)
  if (t) document.documentElement.dataset.theme = t;
  else delete document.documentElement.dataset.theme;
  const dark = t ? t === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  // line icons (no emoji): show the mode you'd switch TO
  $('themeBtn').innerHTML = dark
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5z"/></svg>';
  $('themeBtn').title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  // charts hold resolved colors — repaint them against the new palette
  document.querySelectorAll('canvas').forEach(repaintCanvas);
}

function repaintCanvas(c) {
  if (!c.clientWidth) return;
  if (c._area) drawArea(c, c._area.cfg);
  else if (c._chart) redraw(c);
}

$('themeBtn').onclick = () => {
  const cur = document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  localStorage.setItem('lp-theme', next);
  applyTheme(next);
};
applyTheme(localStorage.getItem('lp-theme'));

// ---------------- settings modal ----------------

const SETTING_LABELS = {
  dataDir: 'Data directory (all results)',
  bundlesDir: 'JMeter bundles folder',
  runtimeDir: 'Local JMeter runtime',
  port: 'Controller port',
};

// ---------------- settings page (General · Integrations · Storage) ----------------

async function loadSettingsPage() {
  $('settingsMsg').textContent = '';
  try {
    const s = await api('GET', '/api/settings');
    $('settingsEditable').innerHTML = Object.entries(s.editable).map(([k, v]) => `
      <div class="settings-field">
        <label for="set-${esc(k)}">${SETTING_LABELS[k] || k}</label>
        <input id="set-${esc(k)}" data-setting="${k}" value="${esc(v)}">
      </div>`).join('');
    $('settingsDerived').innerHTML = Object.entries(s.derived).map(([k, v]) =>
      `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
  } catch (e) {
    $('settingsMsg').textContent = `Could not load storage settings: ${e.message}`;
  }
  loadSheetsSettings();
  slaThresholds = null;
  await ensureSla();
  const t = slaThresholds || {};
  $('setSlaErr').value = t.maxErrorPct ?? '';
  $('setSlaP90').value = t.maxP90Ms ?? '';
  $('setSlaTp').value = t.minThroughput ?? '';
  $('setCtrlUrl').textContent = await controllerUrl();
  const cur = localStorage.getItem('lp-theme') || '';
  document.querySelectorAll('#setTheme [data-theme]').forEach((b) => b.classList.toggle('active', b.dataset.theme === cur));
}

// The address agents use to reach this controller (LAN IP, not "localhost").
let ctrlUrlCache = null;
async function controllerUrl() {
  if (ctrlUrlCache) return ctrlUrlCache;
  try {
    const d = await api('GET', '/api/agent-directory');
    ctrlUrlCache = d.controllerUrl || d.detectedUrl || location.origin;
  } catch { return location.origin; }
  return ctrlUrlCache;
}

function settingsSec(sec) {
  document.querySelectorAll('.settings-nav [data-sec]').forEach((b) => {
    const on = b.dataset.sec === sec;
    b.classList.toggle('on', on);
    if (on) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('.settings-sec').forEach((s) => { s.hidden = s.dataset.sec !== sec; });
}
document.querySelectorAll('.settings-nav [data-sec]').forEach((b) => (b.onclick = () => settingsSec(b.dataset.sec)));

$('setSlaSave').onclick = async () => {
  const val = (id) => ($(id).value === '' ? null : Number($(id).value));
  try {
    const d = await api('PUT', '/api/sla', { maxErrorPct: val('setSlaErr'), maxP90Ms: val('setSlaP90'), minThroughput: val('setSlaTp') });
    slaThresholds = d.sla;
    $('setSlaMsg').textContent = '✓ Saved — every run is now judged by these limits.';
    setTimeout(() => { $('setSlaMsg').textContent = ''; }, 3000);
  } catch (e) { $('setSlaMsg').textContent = `✗ ${e.message}`; }
};

// Stop the controller from the browser (it often runs hidden, with no window to close).
$('setShutdown').onclick = async () => {
  const msg = $('setShutdownMsg');
  if (!confirm('Stop the LoadPilot controller?\n\nNobody can use LoadPilot until it is started again on this PC.')) return;
  const post = (force) => fetch('/api/shutdown', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ force }),
  }).then(async (res) => ({ status: res.status, d: await res.json().catch(() => ({})) }));
  try {
    let r = await post(false);
    if (r.status === 409) {
      if (!confirm(`${r.d.error}\n\nStop the controller anyway? The running test is cut off and marked as an error.`)) return;
      r = await post(true);
    }
    if (r.status !== 200) throw new Error(r.d.error || `HTTP ${r.status}`);
    controllerStopped = true;
    $('stoppedNotice').hidden = false;
    msg.textContent = 'Stopping…';
  } catch (e) { msg.textContent = `✗ ${e.message}`; }
};

document.querySelectorAll('#setTheme [data-theme]').forEach((b) => (b.onclick = () => {
  const t = b.dataset.theme;
  if (t) localStorage.setItem('lp-theme', t); else localStorage.removeItem('lp-theme');
  applyTheme(t || null);
  document.querySelectorAll('#setTheme [data-theme]').forEach((x) => x.classList.toggle('active', x === b));
}));

$('settingsSave').onclick = async () => {
  const patch = {};
  document.querySelectorAll('[data-setting]').forEach((inp) => { patch[inp.dataset.setting] = inp.value.trim(); });
  try {
    const r = await api('PATCH', '/api/settings', patch);
    $('settingsMsg').textContent = r.restartRequired
      ? '✓ Saved. Restart the controller (npm start) to apply the new locations.'
      : '✓ Saved.';
  } catch (e) {
    $('settingsMsg').textContent = `✗ ${e.message}`;
  }
};

// Reflect the current Google Sheets config on the step-4 per-run opt-in.
async function refreshSheetOptIn() {
  const cb = $('syncSheet'), note = $('syncSheetNote');
  if (!cb) return;
  let s = { url: '', enabled: false };
  try { s = await api('GET', '/api/sheets'); } catch { /* leave defaults */ }
  if (!s.url) {
    cb.checked = false; cb.disabled = true;
    note.innerHTML = '— set up Google Sheets first in <a href="#settings">Settings → Integrations</a>';
  } else if (s.enabled) {
    cb.checked = true; cb.disabled = true;
    note.textContent = '— every run already auto-syncs (Settings)';
  } else {
    cb.disabled = false;
    note.textContent = '— appends this run to your sheet when it finishes';
  }
}

// Push one finished run to the Google Sheet on demand (History/Dashboard button).
async function sendRunToSheet(id, btn) {
  const old = btn.textContent;
  btn.disabled = true; btn.textContent = 'sending…';
  try {
    const r = await api('POST', `/api/runs/${id}/sheet`);
    btn.textContent = r.ok ? 'Sent to Sheet ✓' : `Sheet HTTP ${r.status}`;
  } catch (e) {
    btn.textContent = 'Failed';
    alert(`Send to Sheet failed: ${e.message}`);
  }
  setTimeout(() => { btn.textContent = old; btn.disabled = false; }, 2800);
}

// ---- Google Sheets sync settings ----
async function loadSheetsSettings() {
  try {
    const s = await api('GET', '/api/sheets');
    $('sheetsUrl').value = s.url || '';
    $('sheetsEnabled').checked = !!s.enabled;
  } catch { /* ignore */ }
}
$('sheetsHelp').onclick = (e) => {
  e.preventDefault();
  const box = $('sheetsHelpBox');
  const show = box.style.display === 'none';
  box.style.display = show ? 'block' : 'none';
  $('sheetsHelp').textContent = show ? 'Hide setup steps ▾' : 'Show one-time setup steps ▸';
};
$('sheetsCopy').onclick = () => {
  navigator.clipboard.writeText($('sheetsSnippet').textContent).then(() => {
    $('sheetsCopy').textContent = 'Copied ✓';
    setTimeout(() => { $('sheetsCopy').textContent = 'Copy code'; }, 1500);
  });
};
$('sheetsSave').onclick = async () => {
  $('sheetsMsg').textContent = '';
  try {
    await api('PUT', '/api/sheets', { url: $('sheetsUrl').value.trim(), enabled: $('sheetsEnabled').checked });
    $('sheetsMsg').textContent = '✓ Saved.';
    refreshSheetOptIn(); // keep the step-4 opt-in in sync
    setTimeout(() => { $('sheetsMsg').textContent = ''; }, 2000);
  } catch (e) { $('sheetsMsg').textContent = `✗ ${e.message}`; }
};
$('sheetsTest').onclick = async () => {
  $('sheetsMsg').textContent = 'sending…';
  try {
    const r = await api('POST', '/api/sheets/test', { url: $('sheetsUrl').value.trim() });
    $('sheetsMsg').textContent = r.ok
      ? '✓ Test row sent — check your sheet.'
      : `⚠ Sheet responded HTTP ${r.status}. Check the URL is the deployed Web App URL with "Anyone" access.`;
  } catch (e) { $('sheetsMsg').textContent = `✗ ${e.message}`; }
};

// ---- Portable controller: per-agent directory (tick which agents this controller owns) ----
let agentDirDetected = '';
function shortUrl(u) { return String(u || '').replace(/^https?:\/\//, ''); }
function agentRowHtml(a, now) {
  a = a || { ip: '', name: '', enabled: true };
  return `<tr>
    <td style="text-align:center;"><input type="checkbox" class="ad-en" ${a.enabled === false ? '' : 'checked'}></td>
    <td><input class="ad-ip" value="${esc(a.ip || '')}" placeholder="192.168.2.101"></td>
    <td><input class="ad-name" value="${esc(a.name || '')}" placeholder="e.g. Arif PC"></td>
    <td class="ad-now hint" style="white-space:nowrap;">${now ? esc(now) : ''}</td>
    <td><button class="ghost mini ad-del" title="Remove">✕</button></td>
  </tr>`;
}
function renderRows(agents, nowByIp) {
  nowByIp = nowByIp || {};
  const rows = (agents && agents.length) ? agents : [{ ip: '', name: '', enabled: true }];
  $('agentDirRows').innerHTML = rows.map((a) => agentRowHtml(a, nowByIp[a.ip])).join('');
}
// Fill the "Now on" column from a ping/discover result set (matched by IP).
function setNowColumn(list) {
  const byIp = {}; (list || []).forEach((x) => { byIp[x.ip] = x; });
  document.querySelectorAll('#agentDirRows tr').forEach((tr) => {
    const ip = tr.querySelector('.ad-ip').value.trim();
    const cell = tr.querySelector('.ad-now'); if (!cell) return;
    const x = byIp[ip]; if (!x) return;
    if (x.ok === false) { cell.innerHTML = '<span class="bad">offline</span>'; return; }
    cell.innerHTML = `${x.busy ? '<span class="bad">busy</span> ' : ''}${x.controller ? esc(shortUrl(x.controller)) : '—'}`;
  });
}
function collectAgents() {
  return [...document.querySelectorAll('#agentDirRows tr')].map((tr) => ({
    ip: tr.querySelector('.ad-ip').value.trim(),
    name: tr.querySelector('.ad-name').value.trim(),
    enabled: tr.querySelector('.ad-en').checked,
  })).filter((a) => a.ip);
}
async function loadAgentDir() {
  try {
    const d = await api('GET', '/api/agent-directory');
    agentDirDetected = d.detectedUrl || '';
    renderRows(d.agents || [], {});
    const urlInp = $('agentControllerUrl');
    urlInp.value = d.controllerUrl || '';
    urlInp.placeholder = agentDirDetected ? `${agentDirDetected}  (auto-detected)` : '';
    $('agentDirResult').innerHTML = '';
  } catch { /* ignore */ }
}
function saveDir() {
  return api('PUT', '/api/agent-directory', { agents: collectAgents(), controllerUrl: $('agentControllerUrl').value.trim() });
}
function renderAgentDirResults(results) {
  if (!results || !results.length) { $('agentDirResult').innerHTML = ''; return; }
  $('agentDirResult').innerHTML = '<table class="mini-table">' + results.map((r) => {
    const ok = r.ok;
    const detail = ok
      ? `${r.name ? esc(r.name) : 'agent'}${r.busy ? ' <span class="bad">busy</span>' : ''}${r.controller ? ` → ${esc(r.controller)}` : ''}`
      : `<span class="bad">${esc(r.error || 'failed')}</span>`;
    return `<tr><td>${ok ? '✅' : '❌'}</td><td><code>${esc(r.ip)}</code></td><td>${detail}</td></tr>`;
  }).join('') + '</table>';
}
$('agentDirAdd').onclick = () => { $('agentDirRows').insertAdjacentHTML('beforeend', agentRowHtml()); };
$('agentDirRows').addEventListener('click', (e) => {
  if (e.target.classList.contains('ad-del')) e.target.closest('tr').remove();
});
$('agentDirDiscover').onclick = async () => {
  const btn = $('agentDirDiscover');
  btn.disabled = true; $('agentDirMsg').textContent = 'scanning network…';
  try {
    const r = await api('POST', '/api/agent-directory/discover', {});
    const found = r.found || [];
    const existing = collectAgents();
    const byIp = new Map(existing.map((a) => [a.ip, a]));
    let added = 0;
    for (const f of found) {
      if (byIp.has(f.ip)) { const a = byIp.get(f.ip); if (!a.name && f.name) a.name = f.name; }
      else { const a = { ip: f.ip, name: f.name || '', enabled: true }; existing.push(a); byIp.set(f.ip, a); added++; }
    }
    // "Now on" per agent: redirectable (new exe) shows its controller; connected-only
    // (old exe) is flagged so you know it must be updated before it can be redirected.
    const nowByIp = {};
    for (const f of found) {
      const prefix = f.count > 1 ? `${f.count} agents · ` : '';
      nowByIp[f.ip] = prefix + (f.control
        ? `${f.busy ? 'busy · ' : ''}${shortUrl(f.controller)}`
        : (f.connected ? 'connected · old agent (update to redirect)' : ''));
    }
    renderRows(existing, nowByIp);
    await saveDir();
    const redirectable = found.filter((f) => f.control).length;
    const oldOnly = found.filter((f) => !f.control && f.connected).length;
    $('agentDirMsg').textContent = `found ${found.length} agent(s) — ${redirectable} redirect-ready, ${oldOnly} old agent(s) need updating`;
  } catch (e) { $('agentDirMsg').textContent = `✗ ${e.message}`; }
  btn.disabled = false;
};
$('agentDirHelp').onclick = (e) => {
  e.preventDefault();
  const box = $('agentDirHelpBox');
  const show = box.style.display === 'none';
  box.style.display = show ? 'block' : 'none';
  $('agentDirHelp').textContent = show ? 'Hide ▾' : 'How it works ▸';
};
$('agentDirSave').onclick = async () => {
  $('agentDirMsg').textContent = 'saving…';
  try { await saveDir(); $('agentDirMsg').textContent = '✓ Saved.'; setTimeout(() => { $('agentDirMsg').textContent = ''; }, 2000); }
  catch (e) { $('agentDirMsg').textContent = `✗ ${e.message}`; }
};
$('agentDirCheck').onclick = async () => {
  $('agentDirMsg').textContent = 'checking…';
  try {
    await saveDir();
    const ips = collectAgents().map((a) => a.ip);
    const r = await api('POST', '/api/agent-directory/ping', { ips });
    setNowColumn(r.results);
    renderAgentDirResults(r.results);
    const up = (r.results || []).filter((x) => x.ok).length;
    $('agentDirMsg').textContent = `${up}/${(r.results || []).length} reachable`;
  } catch (e) { $('agentDirMsg').textContent = `✗ ${e.message}`; }
};
$('agentDirRedirect').onclick = async () => {
  const btn = $('agentDirRedirect');
  const enabled = collectAgents().filter((a) => a.enabled).map((a) => a.ip);
  if (!enabled.length) { $('agentDirMsg').textContent = '✗ Tick at least one agent first.'; return; }
  btn.disabled = true; $('agentDirMsg').textContent = 'pointing agents here…';
  try {
    await saveDir();
    const r = await api('POST', '/api/agent-directory/redirect', { ips: enabled, controllerUrl: $('agentControllerUrl').value.trim() });
    renderAgentDirResults(r.results);
    const ok = (r.results || []).filter((x) => x.ok).length;
    const total = (r.results || []).length;
    $('agentDirMsg').textContent = `${ok}/${total} switched to ${r.url}${ok < total ? ' — others offline/busy/blocked' : ' ✓'}`;
  } catch (e) { $('agentDirMsg').textContent = `✗ ${e.message}`; }
  btn.disabled = false;
};

// ---------------- view switching ----------------

// Sidebar section + page title for each view (top bar breadcrumb).
const VIEW_TITLES = {
  home: ['Home', 'Overview'],
  new: ['Run', 'New run'], live: ['Run', 'Live monitor'], schedule: ['Run', 'Schedules'],
  runs: ['Results', 'Runs'], run: ['Results / Runs', 'Run detail'], report: ['Results', 'Reports'],
  fleet: ['Fleet', 'Agents & teams'], settings: ['Fleet', 'Settings'],
};
// old bookmarks keep working
const VIEW_ALIASES = { dashboard: 'runs', history: 'runs', agents: 'fleet', team: 'fleet' };

document.querySelectorAll('.side-nav button[data-view]').forEach((b) => {
  b.onclick = () => showView(b.dataset.view);
});
$('ctrlAddr').textContent = location.host;

// Each page has its own address (#runs, #run/<id> …) so Back/Forward, reload
// and bookmarks land on the same page.
function showView(name, opts = {}) {
  name = VIEW_ALIASES[name] || name;
  const navKey = name === 'run' ? 'runs' : name;
  document.querySelectorAll('.side-nav button[data-view]').forEach((b) => {
    const on = b.dataset.view === navKey;
    b.classList.toggle('active', on);
    if (on) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const [crumb, title] = VIEW_TITLES[name] || ['', name];
  $('crumb').textContent = crumb;
  $('pageTitle').textContent = title;
  document.title = `${title} · LoadPilot`;
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  const hash = opts.hash || name;
  if (!opts.fromHistory && location.hash.slice(1) !== hash) history[opts.replace ? 'replaceState' : 'pushState'](null, '', `#${hash}`);
  // charts drawn while their view was hidden (e.g. last run loaded at boot) have 0 width — repaint now
  requestAnimationFrame(() => document.querySelectorAll(`#view-${name} canvas`).forEach(repaintCanvas));
  if (name === 'home') loadHome();
  if (name === 'new') loadRecentPlans();
  if (name === 'runs') loadRuns();
  if (name === 'report') loadReportView();
  if (name === 'schedule') loadSchedules();
  if (name === 'fleet') loadFleet();
  if (name === 'settings') loadSettingsPage();
}

function routeFromHash() {
  let h = location.hash.slice(1);
  try { h = decodeURIComponent(h); } catch { /* a stray % in a hand-typed address */ }
  const m = /^run\/(.+)$/.exec(h);
  if (m) return openRun(m[1], { fromHistory: true });
  const name = VIEW_ALIASES[h] || h;
  if (VIEW_ALIASES[h]) history.replaceState(null, '', `#${name}`); // old bookmark → current address
  showView(name && $(`view-${name}`) ? name : 'home', { fromHistory: true });
}
window.addEventListener('popstate', routeFromHash);

// ---------------- websocket ----------------

let ws;
let wsOpenedBefore = false;
let controllerStopped = false;
function connectWs() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/ui`);
  ws.onopen = () => {
    $('conn').textContent = 'connected'; $('conn').className = 'ok';
    if (controllerStopped) { controllerStopped = false; $('stoppedNotice').hidden = true; $('setShutdownMsg').textContent = ''; }
    if (wsOpenedBefore) resyncRuns(); // updates sent while we were cut off are gone
    wsOpenedBefore = true;
  };
  ws.onclose = () => {
    $('conn').textContent = controllerStopped ? 'controller stopped' : 'reconnecting…';
    $('conn').className = 'bad';
    setTimeout(connectWs, controllerStopped ? 5000 : 2000);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'agents') { state.agents = msg.agents; renderAgents(); renderAgentPick(); if ($('view-home').classList.contains('active')) renderHome(); }
    if (msg.type === 'agentRes') {
      const a = (state.agents || []).find((x) => x.name === msg.name);
      if (a) { a.res = msg.res; updateResMeters(); }
    }
    if (msg.type === 'runUpdate') { onRunUpdate(msg.run); }
    if (msg.type === 'liveStats') { state.live = msg; renderLive(); renderLiveAgents(); }
    if (msg.type === 'runLog') { appendLog(msg.line); }
    if (msg.type === 'reportUpdated') {
      if (document.getElementById('view-report').classList.contains('active')) loadReportView();
    }
    if (msg.type === 'schedulesUpdated') {
      if (document.getElementById('view-schedule').classList.contains('active')) loadSchedules();
    }
    if (msg.type === 'controllerStopping') {
      controllerStopped = true;
      $('stoppedNotice').hidden = false;
    }
  };
}

// After a dropped connection: catch up on the run we were showing, or one that
// started meanwhile (e.g. from a schedule).
async function resyncRuns() {
  try {
    const runs = await api('GET', '/api/runs');
    const active = runs.find((r) => isActiveRun(r));
    const mine = state.run && runs.find((r) => r.id === state.run.id);
    if (mine) onRunUpdate(mine);
    if (active && (!mine || active.id !== mine.id)) onRunUpdate(active);
    if ($('view-home').classList.contains('active')) loadHome();
    if ($('view-runs').classList.contains('active')) loadRuns();
  } catch { /* still starting up */ }
}
connectWs();

// ---------------- new run: plan upload ----------------

const drop = $('dropzone');
drop.onclick = () => $('jmxFile').click();
drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('drag'); };
drop.ondragleave = () => drop.classList.remove('drag');
drop.ondrop = (e) => {
  e.preventDefault();
  drop.classList.remove('drag');
  if (e.dataTransfer.files[0]) uploadPlan(e.dataTransfer.files[0]);
};
$('jmxFile').onchange = () => $('jmxFile').files[0] && uploadPlan($('jmxFile').files[0]);

async function uploadPlan(file) {
  drop.textContent = `Uploading ${file.name}…`;
  try {
    const res = await fetch('/api/plans', {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-filename': encodeURIComponent(file.name) },
      body: file,
    });
    const plan = await res.json();
    if (!res.ok) throw new Error(plan.error);
    drop.textContent = 'Drop a different .jmx to replace';
    applyLoadedPlan(plan);
  } catch (err) {
    drop.textContent = `Upload failed: ${err.message} — click to retry`;
  }
}

// Load a plan (freshly uploaded OR re-imported from JMeter) into the New Run form.
function applyLoadedPlan(plan) {
  state.plan = plan;
  $('planInfo').style.display = 'block';
  $('planName').textContent = plan.name;
  $('planFileName').textContent = `(${plan.fileName})`;
  const plugins = plan.structure.plugins || [];
  $('planWarn').style.display = plugins.length ? 'block' : 'none';
  $('planWarn').textContent = plugins.length
    ? `⚠ This plan uses JMeter plugin elements (${plugins.map((p) => p.split('.').pop()).join(', ')}). ` +
      'The JMeter bundle on the controller (bundles/jmeter.zip) must include those plugin jars, or every run will fail to load the plan. ' +
      'Easiest fix: zip your team’s existing JMeter folder (which has the plugins) and use that as the bundle.'
    : '';
  // new plan → back to even-split, clear per-agent profiles
  state.distMode = 'split';
  state.profiles = {};
  state.editingAgent = null;
  const splitRadio = document.querySelector('input[name="distMode"][value="split"]');
  if (splitRadio) splitRadio.checked = true;
  renderConfig();
  renderAgentPick();
  renderDataFiles();
  renderVariables();
  $('configCard').style.display = 'block';
  $('agentCard').style.display = 'block';
  $('settingsCard').style.display = 'block';
  $('reportCard').style.display = 'block';
  // Start/Schedule live in the wizard footer on step 4; wizRender decides visibility.
  if (recentPlansCache && !recentPlansCache.some((p) => p.id === plan.id)) {
    recentPlansCache.unshift({ id: plan.id, name: plan.name, fileName: plan.fileName, uploadedAt: plan.uploadedAt });
  }
  renderRecentPlans();
  wizRender();
  loadReportsForRunPage();
  refreshSheetOptIn();
  // "Open in JMeter" available for any loaded plan; hide any stale edit panel.
  if ($('openInJmeter')) $('openInJmeter').style.display = 'inline-block';
  if ($('jmeterEditPanel')) $('jmeterEditPanel').style.display = 'none';
  state.jmeterEdit = null;
}

// ---- Open the plan in the bundled JMeter GUI (edit a copy → re-import as new plan) ----
if ($('openInJmeter')) $('openInJmeter').onclick = async () => {
  if (!state.plan) return;
  const btn = $('openInJmeter'); const old = btn.textContent;
  btn.disabled = true; btn.textContent = 'Opening JMeter…';
  try {
    const r = await api('POST', `/api/plans/${state.plan.id}/open-in-jmeter`);
    state.jmeterEdit = r.editId;
    $('jmeterEditPanel').style.display = 'block';
    $('jmeterEditMsg').innerHTML = 'JMeter is opening on the <b>controller PC</b> with a copy of this plan. Edit it, press <b>Ctrl+S</b> to save, then click <b>Import edited plan</b>. Your original plan stays unchanged.';
  } catch (e) { alert('Could not open JMeter: ' + e.message); }
  btn.disabled = false; btn.textContent = old;
};
if ($('importEdited')) $('importEdited').onclick = async () => {
  if (!state.jmeterEdit) return;
  const btn = $('importEdited'); btn.disabled = true; btn.textContent = 'Importing…';
  try {
    const plan = await api('POST', '/api/plans/import-edited', { editId: state.jmeterEdit });
    drop.textContent = 'Drop a different .jmx to replace';
    applyLoadedPlan(plan); // loads the new plan; also hides the panel + clears jmeterEdit
    alert('Imported edited plan as a new plan: ' + plan.name);
  } catch (e) {
    alert('Import failed: ' + e.message + '\n(Did you Save the file in JMeter first?)');
    btn.disabled = false; btn.textContent = 'Import edited plan';
  }
};
if ($('cancelEdited')) $('cancelEdited').onclick = () => {
  state.jmeterEdit = null;
  $('jmeterEditPanel').style.display = 'none';
};

// ---------------- New Run wizard: Plan → Workload → Agents → Review ----------------
// The steps are the SAME cards and handlers as before, shown one step at a time;
// nothing about how a run is configured or started changed.
const WIZ_STEPS = 4;
state.wizStep = 1;
let recentPlansCache = null;

const isSetupTg = (tg) => tg.tag === 'SetupThreadGroup' || tg.tag === 'PostThreadGroup';
const isRateTg = (tg) => tg.kind === 'arrivals' || tg.kind === 'concurrency';

function wizGo(n) {
  n = Math.max(1, Math.min(WIZ_STEPS, n));
  if (n > 1 && !state.plan) n = 1;
  state.wizStep = n;
  wizRender();
  if (n === 4) { renderReview(); renderPreflight(); }
  const top = $('wizSteps');
  if (top && top.getBoundingClientRect().top < 0) top.scrollIntoView({ block: 'start' });
}

function wizRender() {
  const n = state.wizStep || 1;
  document.querySelectorAll('#view-new .wiz-step').forEach((s) => { s.hidden = +s.dataset.step !== n; });
  document.querySelectorAll('#wizSteps .wiz-step-btn').forEach((b) => {
    const k = +b.dataset.step;
    b.classList.toggle('current', k === n);
    b.classList.toggle('done', k < n);
    b.disabled = k > 1 && !state.plan;
    if (k === n) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('#wizSteps .wiz-line').forEach((l, i) => l.classList.toggle('done', i + 1 < n));
  $('wizBack').style.visibility = n > 1 ? 'visible' : 'hidden';
  const last = n === WIZ_STEPS;
  $('wizNext').style.display = last ? 'none' : '';
  $('wizNext').disabled = n === 1 && !state.plan;
  $('wizNext').textContent = ['', 'Continue to workload →', 'Continue to agents →', 'Continue to review →'][n] || 'Continue →';
  $('startRow').style.display = last && state.plan ? 'flex' : 'none';
  $('wizHint').textContent = n === 1 && !state.plan ? 'Upload a .jmx file or pick a recent plan to continue.' : '';
  if (!last) $('startErr').textContent = '';
  updateWizSubs();
  renderRunSummary();
}

// Totals for the summary/review. Normal groups split a TOTAL across agents;
// setUp/tearDown run their threads on EACH agent; bzm groups are a rate.
function workloadSummary() {
  const out = { users: 0, groups: [], samplersOn: 0, samplersTotal: 0, perAgentUsers: {} };
  if (!state.plan) return out;
  const s = state.plan.structure;
  let cfg;
  try { cfg = readFormConfig(); } catch { return out; }
  const usersOf = (c) => (c.threadGroups || []).reduce((sum, t) => {
    const tg = s.threadGroups.find((x) => x.id === t.id);
    if (!tg || !t.enabled || isSetupTg(tg) || isRateTg(tg)) return sum;
    return sum + (+(t.threads != null ? t.threads : tg.threads) || 0);
  }, 0);
  // In per-agent mode every agent has its own profile: a group is "on" if any
  // agent runs it, and its total is the sum of the agents' own counts.
  const perAgentMode = state.distMode === 'per-agent';
  const profiles = perAgentMode ? selectedAgents().map((a) => state.profiles[a] || cfg) : [cfg];
  for (const tg of s.threadGroups) {
    const ts = profiles.map((p) => (p.threadGroups || []).find((x) => x.id === tg.id))
      .filter((t) => t && t.enabled && (!perAgentMode || (+t.threads || 0) > 0));
    if (!ts.length) continue;
    const t = ts[0];
    const users = perAgentMode && !isSetupTg(tg)
      ? ts.reduce((sum, x) => sum + (+x.threads || 0), 0)
      : (t.threads != null ? t.threads : tg.threads);
    out.groups.push({
      name: tg.name, setup: isSetupTg(tg), rate: isRateTg(tg), editable: tg.editable,
      users, rampUp: t.rampUp != null ? t.rampUp : tg.rampUp,
      mode: t.mode, loops: t.loops, duration: t.duration, hold: t.hold,
    });
  }
  const sm = cfg.samplers || [];
  out.samplersOn = sm.filter((x) => profiles.some((p) => ((p.samplers || []).find((y) => y.id === x.id) || x).enabled)).length;
  out.samplersTotal = sm.length;
  // requests that will actually run: ticked, in a group that's on, and under no
  // switched-off controller (same rule as the request tree's "X of Y will run")
  const runsIn = (p) => {
    const tgOn = new Map((p.threadGroups || []).map((t) => [t.id, t.enabled && (!perAgentMode || (+t.threads || 0) > 0)]));
    const ctrlOn = new Map((p.controllers || []).map((c) => [c.id, c.enabled]));
    const smOn = new Map((p.samplers || []).map((x) => [x.id, x.enabled]));
    return (sm2) => smOn.get(sm2.id) !== false && sm2.threadGroupId != null && tgOn.get(sm2.threadGroupId)
      && (sm2.ctrlIds || []).every((c) => ctrlOn.get(c) !== false);
  };
  const checks = profiles.map(runsIn);
  out.willRun = s.samplers.filter((x) => checks.some((ok) => ok(x))).length;
  if (perAgentMode) {
    for (const a of selectedAgents()) {
      out.perAgentUsers[a] = usersOf(state.profiles[a] || cfg);
      out.users += out.perAgentUsers[a];
    }
  } else {
    out.users = usersOf(cfg);
  }
  return out;
}

function updateWizSubs() {
  if (!state.plan) {
    $('wizSub1').textContent = 'Choose the test';
    $('wizSub2').textContent = 'Users and ramp-up';
    $('wizSub3').textContent = 'PCs and data files';
    return;
  }
  const w = workloadSummary();
  const n = selectedAgents().length;
  const fileIssues = n ? new Set(dataFileIssues().map((i) => i.ref)).size : 0;
  $('wizSub1').textContent = state.plan.name;
  $('wizSub2').textContent = state.distMode === 'per-agent' ? 'Per-agent profiles' : `${fmt.n(w.users)} users · split evenly`;
  $('wizSub3').textContent = !n ? 'None selected yet'
    : `${n} agent${n === 1 ? '' : 's'}${fileIssues ? ` · ${fileIssues} file${fileIssues === 1 ? '' : 's'} to attach` : ''}`;
}

function renderRunSummary() {
  const dl = $('runSummaryList');
  if (!dl) return;
  const rows = [];
  if (!state.plan) {
    rows.push(['Plan', 'Not chosen yet', 'muted']);
  } else {
    const w = workloadSummary();
    const ag = selectedAgents();
    const perAgent = state.distMode === 'per-agent';
    rows.push(['Plan', state.plan.name]);
    rows.push(['Load sharing', perAgent ? 'Per-agent profiles' : 'Split evenly']);
    rows.push(['Virtual users', w.users ? fmt.n(w.users) : '—']);
    rows.push(['Thread groups on', `${w.groups.length} of ${state.plan.structure.threadGroups.length}`]);
    rows.push(['Agents', ag.length ? `${ag.length} selected` : 'None selected', ag.length ? '' : 'warn']);
    if (ag.length && w.users && !perAgent) rows.push(['Users per agent', `≈ ${fmt.n(Math.ceil(w.users / ag.length))}`]);
    const refs = (state.plan.structure.dataFileRefs || []).filter(csvRefNeeded);
    if (refs.length) {
      // ready = attached AND (for per-agent files) attached for every selected agent
      const bad = new Set(dataFileIssues().map((i) => i.ref));
      const have = refs.filter((r) => !bad.has(r.name) && (state.library || []).some((f) => f.logical === libKey(r.name))).length;
      rows.push(['Data files', `${have} of ${refs.length} ready`, have < refs.length ? 'warn' : '']);
    }
  }
  dl.innerHTML = rows.map(([k, v, cls]) => `<div><dt>${esc(k)}</dt><dd${cls ? ` class="${cls}"` : ''}>${esc(v)}</dd></div>`).join('');
}

function renderReview() {
  const el = $('reviewBody');
  if (!el || !state.plan) return;
  if (state.distMode === 'per-agent') saveActiveProfile();
  const p = state.plan;
  const w = workloadSummary();
  const ag = selectedAgents();
  const n = ag.length || 1;
  const perAgent = state.distMode === 'per-agent';
  const perCol = (g) => {
    if (g.setup) return `${fmt.n(g.users)} each`;
    if (perAgent) return 'per profile';
    if (g.rate) return `${+(g.users / n).toFixed(2)}/s each`;
    return `≈ ${fmt.n(Math.ceil(g.users / n))} each`;
  };
  const runsFor = (g) => {
    if (g.rate) return g.hold ? `hold ${g.hold} s` : '—';
    if (!g.editable) return 'plan setting';
    if (g.mode === 'duration') return `${fmt.n(g.duration)} s`;
    return g.loops === -1 ? 'forever' : `${fmt.n(g.loops || 1)} loop${(g.loops || 1) === 1 ? '' : 's'}`;
  };
  const tgRows = w.groups.map((g) => `<tr><td>${esc(g.name)}</td>
    <td class="num">${g.rate ? `${fmt.n(g.users)}/s` : fmt.n(g.users)}</td><td class="num">${perCol(g)}</td>
    <td class="num">${g.rampUp != null ? `${fmt.n(g.rampUp)} s` : '—'}</td><td>${runsFor(g)}</td></tr>`).join('');
  const vo = readVariableOverrides();
  const nVar = Object.values(vo).reduce((a, b) => a + Object.keys(b).length, 0);
  const refs = (p.structure.dataFileRefs || []).filter(csvRefNeeded);
  // per-agent data files: show which file each agent will read, right on its chip
  const perAgentFiles = refs.map((r) => (state.library || []).find((x) => x.logical === libKey(r.name))).filter((f) => f && f.mode === 'per-agent');
  const fileOf = (a) => perAgentFiles.map((f) => {
    const o = (f.perAgentOrig || {})[a.replace(/[^\w.-]/g, '_')];
    let n = o ? o.name : 'no file';
    try { n = decodeURIComponent(n); } catch { /* keep */ }
    return n;
  }).join(', ');
  const chips = ag.map((a) => `<span class="rv-chip">${esc(a)}${perAgent ? ` · ${fmt.n(w.perAgentUsers[a] || 0)}` : ''}${perAgentFiles.length ? ` <span class="rv-chip-file">${esc(fileOf(a))}</span>` : ''}</span>`).join('');
  el.innerHTML = `
    <div class="rv-row">
      <div class="rv-k">Plan</div>
      <div class="rv-v"><b>${esc(p.name)}</b>
        <div class="rv-sub">${esc(p.fileName || '')}${refs.length ? ` · data files: ${refs.map((r) => {
          const f = (state.library || []).find((x) => x.logical === libKey(r.name));
          const how = !f ? 'not attached' : f.mode === 'per-agent' ? 'a different file per agent' : f.mode === 'split' ? 'rows split across agents' : 'same file for every agent';
          return `${esc(r.name)} (${how})`;
        }).join(', ')}` : ''}</div></div>
      <button type="button" class="link-btn" data-go="1">Edit</button>
    </div>
    <div class="rv-row">
      <div class="rv-k">Workload</div>
      <div class="rv-v"><b>${perAgent ? 'Per-agent profiles' : 'Split evenly'} · ${fmt.n(w.users)} virtual users</b>
        ${w.groups.length ? `<table class="rv-table"><thead><tr><th>Thread group</th><th class="num">Total</th><th class="num">Per agent</th><th class="num">Ramp-up</th><th>Runs for</th></tr></thead><tbody>${tgRows}</tbody></table>` : '<div class="rv-sub warn">No thread group is switched on.</div>'}
        <div class="rv-sub">${fmt.n(w.willRun)} of ${fmt.n(w.samplersTotal)} requests will run · ${nVar ? `${nVar} variable${nVar === 1 ? '' : 's'} changed` : 'no variables changed'} · heap ${esc($('heap').value)} per agent</div></div>
      <button type="button" class="link-btn" data-go="2">Edit</button>
    </div>
    <div class="rv-row">
      <div class="rv-k">Agents</div>
      <div class="rv-v"><b>${ag.length ? `${ag.length} agent${ag.length === 1 ? '' : 's'}` : 'No agents selected'}</b>
        <div class="rv-chips">${chips}</div>
        ${$('splitPreview').textContent ? `<div class="rv-sub">${esc($('splitPreview').textContent)}</div>` : ''}</div>
      <button type="button" class="link-btn" data-go="3">Edit</button>
    </div>`;
  el.querySelectorAll('[data-go]').forEach((b) => (b.onclick = () => wizGo(+b.dataset.go)));
}

// How one data file (a CSV slot the plan reads) reaches the selected agents.
function dataFileChecks(ref, agents) {
  const f = (state.library || []).find((x) => x.logical === libKey(ref.name));
  const dec = (s) => { try { return decodeURIComponent(s || ''); } catch { return s || ''; } };
  const size = (b) => (b ? (b < 10240 ? `${(b / 1024).toFixed(1)} KB` : `${Math.round(b / 1024)} KB`) : '');
  if (!f) return [{ lvl: 'warn', title: `${ref.name} is not attached yet`, detail: 'Attach it under Data files in step 3' }];
  if (f.mode === 'per-agent') {
    const rows = agents.map((a) => {
      const k = a.replace(/[^\w.-]/g, '_');
      const orig = (f.perAgentOrig || {})[k];
      return { agent: a, has: !!(f.perAgent || {})[k], file: orig ? dec(orig.name) : '', size: orig ? size(orig.bytes) : '', hash: (f.perAgentHash || {})[k] };
    });
    const missing = rows.filter((x) => !x.has);
    const out = [{
      lvl: missing.length ? 'warn' : 'ok',
      title: `${ref.name} · a different file for each agent`,
      detail: missing.length ? `No file yet for ${missing.map((x) => x.agent).join(', ')} — attach it under Data files in step 3` : '',
      files: rows,
    }];
    // identical content on two agents = their virtual users read the same rows (same accounts)
    const byHash = new Map();
    rows.filter((x) => x.has && x.hash).forEach((x) => (byHash.get(x.hash) || byHash.set(x.hash, []).get(x.hash)).push(x));
    for (const same of byHash.values()) {
      if (same.length < 2) continue;
      out.push({
        lvl: 'warn',
        title: `${same.map((x) => x.agent).join(' and ')} have the same ${ref.name}`,
        detail: `Their files are identical (${same[0].file}), so their virtual users will use the same rows — the same accounts. Give each agent its own file if users must not overlap.`,
      });
    }
    return out;
  }
  if (f.mode === 'split') {
    return [{ lvl: 'ok', title: `${ref.name} · rows split across ${agents.length} agent${agents.length === 1 ? '' : 's'}`, detail: `${dec(f.origName)}${f.bytes ? ` · ${size(f.bytes)}` : ''} — each agent gets its own share of the rows, so users don't overlap` }];
  }
  return [{ lvl: 'ok', title: `${ref.name} · the same file for every agent`, detail: `${dec(f.origName)}${f.bytes ? ` · ${size(f.bytes)}` : ''}${agents.length > 1 ? ' — every agent reads all rows, so agents can use the same accounts at the same time' : ''}` }];
}

// Pre-flight: fleet state + the SAME validation Start uses (buildRunConfig), so
// anything that would block the run is shown here before you press Start.
function renderPreflight() {
  const ul = $('preflightList');
  if (!ul || !state.plan) return;
  const items = [];
  const ag = selectedAgents();
  const info = ag.map((nm) => state.agents.find((a) => a.name === nm)).filter(Boolean);
  if (!ag.length) {
    items.push({ lvl: 'fail', title: 'No agents selected', detail: 'Pick at least one agent in step 3.' });
  } else {
    const busy = info.filter((a) => a.state !== 'idle');
    items.push(busy.length
      ? { lvl: 'fail', title: `${busy.length} selected agent${busy.length === 1 ? ' is' : 's are'} not idle`, detail: busy.map((a) => a.name).join(', ') }
      : { lvl: 'ok', title: ag.length === 1 ? `${ag[0]} is connected and idle` : `All ${ag.length} selected agents are connected and idle`, detail: '' });
    const notReady = info.filter((a) => !a.jmeterReady && !a.stub);
    items.push(notReady.length
      ? { lvl: 'warn', title: `JMeter will be downloaded on ${notReady.length} agent${notReady.length === 1 ? '' : 's'} first`, detail: `${notReady.map((a) => a.name).join(', ')} · the first run takes a little longer` }
      : { lvl: 'ok', title: 'JMeter is ready on every selected agent', detail: '' });
    const hot = info.filter((a) => a.res && a.res.cpu >= 80);
    if (hot.length) items.push({ lvl: 'warn', title: `High CPU right now on ${hot.map((a) => a.name).join(', ')}`, detail: 'Results from a busy machine can be skewed' });
  }
  let blocking = null;
  try { buildRunConfig(); } catch (e) { blocking = e.message; }
  if (blocking && !items.some((i) => i.lvl === 'fail')) {
    items.push({ lvl: 'fail', title: 'Not ready to start', detail: blocking });
  } else if (!blocking) {
    // One check per data file the plan reads: how it reaches the agents and, for
    // per-agent files, WHICH file each agent gets (plus identical-file warnings).
    const refs = (state.plan.structure.dataFileRefs || []).filter(csvRefNeeded);
    if (!refs.length) items.push({ lvl: 'ok', title: 'No data files needed', detail: '' });
    for (const r of refs) items.push(...dataFileChecks(r, ag));
  }
  const plugins = state.plan.structure.plugins || [];
  if (plugins.length) items.push({ lvl: 'warn', title: 'The plan uses JMeter plugins', detail: `${plugins.map((x) => x.split('.').pop()).join(', ')} · the JMeter bundle must include them` });
  const fails = items.filter((i) => i.lvl === 'fail').length;
  const warns = items.filter((i) => i.lvl === 'warn').length;
  const badge = $('preflightBadge');
  badge.textContent = fails ? `${fails} to fix` : warns ? `Ready · ${warns} warning${warns === 1 ? '' : 's'}` : 'Ready to start';
  badge.className = `pf-badge ${fails ? 'fail' : warns ? 'warn' : 'ok'}`;
  const icon = { ok: '<path d="m5 12.5 4.5 4.5L19 7.5"/>', warn: '<path d="M12 7v6M12 17h.01"/>', fail: '<path d="M6 6l12 12M18 6 6 18"/>' };
  ul.innerHTML = items.map((i) => `<li class="pf-${i.lvl}"><span class="pf-icon"><svg viewBox="0 0 24 24" aria-hidden="true">${icon[i.lvl]}</svg></span>
    <span class="pf-body"><b>${esc(i.title)}</b>${i.detail ? `<small>${esc(i.detail)}</small>` : ''}
      ${i.files ? `<span class="pf-files">${i.files.map((x) => `<span class="pf-file${x.has ? '' : ' missing'}"><b>${esc(x.agent)}</b><span aria-hidden="true">←</span><span class="mono">${x.has ? esc(x.file || 'file attached') : 'no file'}</span>${x.size ? `<span class="pf-size">${esc(x.size)}</span>` : ''}</span>`).join('')}</span>` : ''}</span></li>`).join('');
  $('startBtn').disabled = fails > 0;
}

// ---- recent plans (step 1): newest upload of each plan, one click to load ----
async function loadRecentPlans(force) {
  if (!$('recentPlans')) return;
  if (!recentPlansCache || force) {
    try { recentPlansCache = await api('GET', '/api/plans'); } catch { recentPlansCache = []; }
  }
  renderRecentPlans();
}
function renderRecentPlans() {
  const box = $('recentPlans');
  if (!box || !recentPlansCache) return;
  const seen = new Set();
  const uniq = recentPlansCache.filter((p) => { const k = `${p.name}|${p.fileName}`; if (seen.has(k)) return false; seen.add(k); return true; });
  if (!uniq.length) { box.innerHTML = ''; return; }
  if (!$('rpList')) {
    box.innerHTML = `<div class="rp-head"><span>Or pick a recent plan</span>
      <input type="search" id="rpFilter" placeholder="Filter plans…" aria-label="Filter recent plans"></div>
      <div class="rp-list" id="rpList"></div>`;
    $('rpFilter').oninput = renderRecentPlans;
  }
  const q = $('rpFilter').value.trim().toLowerCase();
  const shown = uniq.filter((p) => !q || `${p.name} ${p.fileName}`.toLowerCase().includes(q)).slice(0, q ? 12 : 6);
  const cur = state.plan && state.plan.id;
  $('rpList').innerHTML = shown.map((p) => `<button type="button" class="rp-item${p.id === cur ? ' on' : ''}" data-plan="${esc(p.id)}" title="${esc(`${p.name}\n${p.fileName || ''}`)}">
      <span class="rp-name">${esc(p.name)}</span><span class="rp-meta">${esc(fmt.dt(p.uploadedAt))} · ${esc(p.fileName || '')}</span></button>`).join('')
    || '<span class="hint" style="margin:0">No plans match.</span>';
  $('rpList').querySelectorAll('.rp-item').forEach((b) => (b.onclick = async () => {
    b.classList.add('loading');
    try {
      const plan = await api('GET', `/api/plans/${encodeURIComponent(b.dataset.plan)}`);
      drop.textContent = 'Drop a different .jmx to replace';
      applyLoadedPlan(plan);
    } catch (e) { $('wizHint').textContent = `Could not load that plan: ${e.message}`; }
    b.classList.remove('loading');
  }));
}

// Any edit anywhere in the New Run form refreshes the summary (and the review
// + pre-flight when you're on the last step).
let wizRefreshT = null;
function scheduleWizRefresh() {
  clearTimeout(wizRefreshT);
  wizRefreshT = setTimeout(() => {
    updateWizSubs();
    renderRunSummary();
    // a "can't continue" hint from step 3 goes away once the problem is fixed
    if (state.wizStep === 3 && $('wizHint').textContent && selectedAgents().length && !dataFileIssues().length) $('wizHint').textContent = '';
    if (state.wizStep === WIZ_STEPS) { renderReview(); renderPreflight(); }
  }, 120);
}
$('view-new').addEventListener('input', scheduleWizRefresh);
$('view-new').addEventListener('change', scheduleWizRefresh);

$('wizNext').onclick = () => {
  const n = state.wizStep;
  if (n === 1 && !state.plan) { $('wizHint').textContent = 'Upload a .jmx file or pick a recent plan first.'; return; }
  if (n === 3 && !selectedAgents().length) { $('wizHint').textContent = 'Select at least one agent to continue.'; return; }
  if (n === 3) {
    const issues = dataFileIssues();
    if (issues.length) { $('wizHint').textContent = issues[0].msg; $('dataCard').scrollIntoView({ block: 'nearest', behavior: 'smooth' }); return; }
  }
  wizGo(n + 1);
};
$('wizBack').onclick = () => wizGo(state.wizStep - 1);
document.querySelectorAll('#wizSteps .wiz-step-btn').forEach((b) => (b.onclick = () => wizGo(+b.dataset.step)));
wizRender();
loadRecentPlans();

// ---------------- user defined variables (editable after load) ----------------

// Show every enabled UDV block (Test Plan-level + nested) with editable values.
// Blocks are collapsible; the Test Plan block opens by default. Only values the
// user actually changes are sent — everything else keeps the plan's original.
function renderVariables() {
  const card = $('varsCard');
  if (!card) return;
  const all = (state.plan && state.plan.structure.variables) || [];
  const blocks = all.filter((b) => b.enabled && b.args.length);
  if (!blocks.length) { card.style.display = 'none'; return; }
  card.style.display = 'block';
  const total = blocks.reduce((n, b) => n + b.args.length, 0);
  $('varsList').innerHTML = `
    <p class="hint" style="margin:0 0 12px;">${blocks.length} group${blocks.length > 1 ? 's' : ''} · ${total} values. Change any value to override it for this run; untouched values keep the plan's original. Overrides apply to <b>every agent</b>.</p>
    ${blocks.map((b) => `
      <details class="var-block">
        <summary><b>${esc(b.name)}</b> <span class="var-scope">${esc(b.scope)}</span> <span class="badge">${b.args.length}</span></summary>
        <div class="var-grid">
          ${b.args.map((a) => `
            <label class="var-row">
              <span class="var-name" title="${esc(a.name)}">${esc(a.name)}</span>
              <input class="var-input" data-block="${b.id}" data-name="${esc(a.name)}" value="${esc(a.value)}" spellcheck="false" autocomplete="off">
            </label>`).join('')}
        </div>
      </details>`).join('')}`;
}

// Diff the inputs against the plan's originals → { [blockId]: { [name]: value } }.
function readVariableOverrides() {
  const all = (state.plan && state.plan.structure.variables) || [];
  const orig = {};
  for (const b of all) for (const a of b.args) orig[`${b.id}\u0000${a.name}`] = a.value;
  const out = {};
  document.querySelectorAll('#varsList .var-input').forEach((inp) => {
    const bid = inp.dataset.block, name = inp.dataset.name;
    if (inp.value !== orig[`${bid}\u0000${name}`]) (out[bid] || (out[bid] = {}))[name] = inp.value;
  });
  return out;
}

// ---------------- data files (shared / split / per-agent) ----------------

let uploadCtx = null; // {mode, agent?, logical?} — context for the hidden file input

$('addDataFile').onclick = () => { uploadCtx = { mode: 'shared' }; $('dataFile').click(); };

$('dataFile').onchange = async () => {
  const ctx = uploadCtx || { mode: 'shared' };
  const failed = [];
  try {
    for (const f of $('dataFile').files) {
      const headers = {
        'content-type': 'application/octet-stream',
        'x-filename': encodeURIComponent(ctx.logical || f.name),
        'x-origname': encodeURIComponent(f.name),
        'x-mode': ctx.mode,
      };
      if (ctx.agent) headers['x-agent'] = encodeURIComponent(ctx.agent);
      try {
        const res = await fetch('/api/library/files', { method: 'POST', headers, body: f });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || `HTTP ${res.status}`);
        if (d.files) state.library = d.files;
      } catch (e) {
        failed.push(`${f.name}: ${e.message}`);
      }
    }
  } finally {
    $('dataFile').value = ''; // so picking the same file again still uploads
    uploadCtx = null;
    renderDataFiles();
  }
  if (failed.length) alert(`Upload failed\n\n${failed.join('\n')}`);
};

async function patchDataFile(logical, patch) {
  const d = await api('PATCH', `/api/library/files/${encodeURIComponent(logical)}`, patch);
  state.library = d.files;
  renderDataFiles();
}

// Is a thread group enabled for the run right now (its checkbox, or plan default)?
function tgEnabledNow(tgId) {
  if (tgId == null) return true; // test-plan-level CSV (global) is always in play
  const cb = $(`tgEn-${tgId}`);
  if (cb) return cb.checked;
  const tg = ((state.plan && state.plan.structure.threadGroups) || []).find((t) => t.id === tgId);
  return tg ? tg.enabled : true;
}
function tgName(tgId) {
  const tg = ((state.plan && state.plan.structure.threadGroups) || []).find((t) => t.id === tgId);
  return tg ? tg.name : 'thread group';
}
// A CSV file is only needed for this run if its config is enabled AND its
// owning thread group is enabled (or it's a global/test-plan-level CSV).
// The library stores each file under a SAFE name ("Login Users.csv" → "Login_Users.csv");
// compare plan references in that same form, or names with spaces never match.
const libKey = (name) => String(name || '').replace(/[^\w.-]/g, '_').replace(/^\.+/, (m) => '_'.repeat(m.length)) || '_';

function csvRefNeeded(ref) {
  return ref.enabled && tgEnabledNow(ref.threadGroupId);
}

/**
 * ONE simple list, driven by the CSV files the plan actually reads. For each,
 * the user just picks a file — the FILENAME DOESN'T MATTER; LoadPilot delivers
 * whatever they pick as the name the plan expects. Advanced split/per-agent
 * options are tucked behind the row and only appear once a file is chosen.
 */
function renderDataFiles() {
  scheduleWizRefresh(); // attached/cleared files change the summary + review
  const files = state.library || [];
  const agents = selectedAgents();
  const byLogical = new Map(files.map((f) => [f.logical, f]));
  const refs = (state.plan && state.plan.structure.dataFileRefs) || [];
  if (!state.csvAdvOpen) state.csvAdvOpen = new Set();
  const advOpen = state.csvAdvOpen;

  // legacy elements no longer used — keep the UI to a single list
  if ($('addDataFile')) $('addDataFile').style.display = 'none';
  if ($('dataFilesUi')) $('dataFilesUi').innerHTML = '';

  $('dataCard').hidden = !refs.length;
  if (!refs.length) { $('csvRefs').innerHTML = ''; $('dataNote').hidden = true; return; }

  const needed = refs.filter(csvRefNeeded);
  const skipped = refs.filter((r) => !csvRefNeeded(r) && !byLogical.has(libKey(r.name)));

  // Step 1 only points ahead: a per-agent file can't be attached before the
  // agents are chosen, so the whole data-file setup lives in step 3.
  const names = needed.map((r) => `<b>${esc(r.name)}</b>`).join(', ');
  const allAttached = needed.length && needed.every((r) => byLogical.has(libKey(r.name)));
  $('dataNote').hidden = !needed.length;
  $('dataNote').innerHTML = allAttached
    ? `${ic('check')} This plan reads ${names} — already attached. You can review or change ${needed.length === 1 ? 'it' : 'them'} in step 3, next to the agents.`
    : `This plan reads ${needed.length === 1 ? 'a data file' : `${needed.length} data files`}: ${names}. You’ll attach ${needed.length === 1 ? 'it' : 'them'} in <b>step 3</b>, after choosing which agents run the test.`;

  const dec = (s) => { try { return decodeURIComponent(s || ''); } catch { return s || ''; } };
  const kb = (b) => b ? ` (${b < 10240 ? (b / 1024).toFixed(1) : Math.round(b / 1024)} KB)` : '';
  const rowHtml = (ref) => {
    const f = byLogical.get(libKey(ref.name));
    const ok = !!f;
    // Lead with the FILE THE USER PICKED (filename doesn't matter for delivery,
    // but that's what they recognise). The plan's internal slot name is shown
    // only as a small muted "fills …" note, so the two names don't compete.
    const picked = ok && f.mode !== 'per-agent' && f.origName ? dec(f.origName) : null;
    const title = picked || ref.name;
    let summary;
    if (!ok) summary = 'pick any CSV — filename doesn’t matter';
    else if (f.mode === 'per-agent') summary = 'a different file per agent →';
    else {
      const modeTxt = f.mode === 'split' ? 'rows split across agents' : 'same file for every agent';
      const maps = picked && picked !== ref.name
        ? ` · <span class="csv-fills">fills the plan’s <code>${esc(ref.name)}</code></span>` : '';
      summary = `${kb(f.bytes).trim() || 'CSV loaded'} · ${modeTxt}${maps}`;
    }

    // per-agent assignment — always visible so you can see WHICH file each agent runs
    let perAgentRow = '';
    if (ok && f.mode === 'per-agent') {
      const chips = agents.length ? agents.map((a) => {
        const key = a.replace(/[^\w.-]/g, '_');
        const has = f.perAgent && f.perAgent[key];
        const nm = f.perAgentOrig && f.perAgentOrig[key] ? dec(f.perAgentOrig[key].name) : '';
        return `<button class="csv-agent-chip ${has ? 'has' : 'need'}" data-logical="${esc(ref.name)}" data-agent="${esc(a)}"
          title="${has ? 'Click to replace · file: ' + esc(nm) : 'Click to upload this agent’s file'}">
          ${has ? '✓' : ic('upload')} ${esc(a)}${has && nm ? ` <span class="csv-agent-file">${esc(nm)}</span>` : has ? '' : ' <span class="csv-agent-file need">needs file</span>'}</button>`;
      }).join('') : '<span class="hint" style="margin:0">Select agents above first — then click each agent to attach its file.</span>';
      perAgentRow = `<div class="csv-agent-row">${chips}</div>`;
    }

    return `<div class="csv-slot ${ok ? 'ok' : 'missing'}">
      <div class="csv-slot-main">
        <span class="csv-slot-status">${ok ? '✓' : ic('upload')}</span>
        <span class="csv-slot-text">
          <span class="csv-slot-name" title="${esc(title)}">${esc(title)}</span>
          <span class="csv-slot-note">${summary}</span>
        </span>
        <span class="csv-slot-actions">
          ${ok && f.mode === 'per-agent' ? '' : `<button class="ghost mini csv-up" data-logical="${esc(ref.name)}">${ok ? 'Replace' : 'Choose file'}</button>`}
          ${ok ? `<button class="ghost mini csv-adv" data-logical="${esc(ref.name)}">${advOpen.has(ref.name) ? '▾' : '▸'} options</button>` : ''}
          ${ok ? `<button class="ghost mini csv-clear" data-logical="${esc(ref.name)}" title="Remove this file">✕ Clear</button>` : ''}
        </span>
      </div>
      ${perAgentRow}
      ${ok && advOpen.has(ref.name) ? `<div class="csv-slot-adv">
        <label class="field" style="margin:0;">Deliver to agents as
          <select class="df-mode" data-logical="${esc(ref.name)}">
            <option value="shared" ${f.mode === 'shared' ? 'selected' : ''}>Same file for every agent</option>
            <option value="split" ${f.mode === 'split' ? 'selected' : ''}>Split rows across agents</option>
            <option value="per-agent" ${f.mode === 'per-agent' ? 'selected' : ''}>A different file per agent</option>
          </select>
        </label>
        ${f.mode === 'split' ? `<label class="df-header"><input type="checkbox" class="df-hasheader" data-logical="${esc(ref.name)}" ${f.hasHeader !== false ? 'checked' : ''}> first row is a header</label>` : ''}
        ${f.mode === 'per-agent' ? '<span class="hint" style="margin:0">Click an agent chip above to set/replace its file.</span>' : ''}
      </div>` : ''}
    </div>`;
  };

  $('csvRefs').innerHTML = `
    <div class="hint" style="margin:8px 0 6px;">Data files this plan uses. Just pick a CSV for each — <b>the filename doesn’t matter</b>, LoadPilot handles the rest.</div>
    ${needed.map(rowHtml).join('')}
    ${skipped.map((r) => `<div class="csv-slot off">◌ <b>${esc(r.name)}</b> — not needed (its ${r.enabled ? `thread group “${esc(tgName(r.threadGroupId))}” is` : 'CSV config is'} disabled for this run)</div>`).join('')}`;

  // choose/replace a file for a slot — stored under the plan's expected name
  document.querySelectorAll('.csv-up').forEach((btn) => btn.onclick = () => {
    const logical = btn.dataset.logical;
    const existing = byLogical.get(libKey(logical));
    uploadCtx = { mode: existing ? existing.mode : 'shared', logical };
    $('dataFile').click();
  });
  // toggle the advanced (split / per-agent) panel for a slot
  document.querySelectorAll('.csv-adv').forEach((btn) => btn.onclick = () => {
    const k = btn.dataset.logical; advOpen.has(k) ? advOpen.delete(k) : advOpen.add(k); renderDataFiles();
  });
  // clear/remove the uploaded file(s) for a slot
  document.querySelectorAll('.csv-clear').forEach((btn) => btn.onclick = async () => {
    if (!confirm(`Remove the CSV for “${btn.dataset.logical}”? You'll need to pick a file again before running.`)) return;
    try {
      const d = await api('DELETE', `/api/library/files/${encodeURIComponent(btn.dataset.logical)}`);
      state.library = d.files;
    } catch (err) { alert(`Could not clear: ${err.message}`); }
    renderDataFiles();
  });
  document.querySelectorAll('.df-mode').forEach((sel) => sel.onchange = () => patchDataFile(sel.dataset.logical, { mode: sel.value }));
  document.querySelectorAll('.df-hasheader').forEach((cb) => cb.onchange = () => patchDataFile(cb.dataset.logical, { hasHeader: cb.checked }));
  document.querySelectorAll('.df-up').forEach((btn) => btn.onclick = () => {
    uploadCtx = { mode: 'per-agent', agent: btn.dataset.agent, logical: btn.dataset.logical };
    $('dataFile').click();
  });
  // click a per-agent chip → upload/replace that agent's file
  document.querySelectorAll('.csv-agent-chip').forEach((btn) => btn.onclick = () => {
    uploadCtx = { mode: 'per-agent', agent: btn.dataset.agent, logical: btn.dataset.logical };
    $('dataFile').click();
  });
}

// ---------------- new run: config form ----------------

// ---- step 2: the request tree (controllers ▸ requests ▸ the helpers of each request) ----
// Same checkboxes as before (smEn-<id> per sampler, .ctrlCb per controller), so
// reading/writing the run config is unchanged; only the layout is new.

const ROLE_LABEL = {
  pre: ['Before', 'r-pre'], extract: ['Extracts', 'r-ext'], check: ['Checks', 'r-chk'],
  post: ['After', 'r-post'], csv: ['Reads', 'r-csv'],
};

// "100-----STATIC PAGES--------" → "100 · STATIC PAGES" (the plan's name stays in the tooltip)
function prettyCtrlName(n) {
  const p = String(n || '').replace(/\s*[-_=~*.]{3,}\s*/g, ' · ').replace(/^[\s·]+|[\s·]+$/g, '').trim();
  return p || String(n || '');
}

// One helper (extractor, assertion, pre/post processor, CSV) — as a line under its request…
function helperHtml(a) {
  const [label, cls] = ROLE_LABEL[a.role] || ['Uses', 'r-post'];
  const main = a.role === 'csv' ? (a.file || a.name) : (a.detail || a.name);
  const sub = a.role === 'csv' ? a.name : a.type && a.type !== main ? a.type : '';
  return `<div class="rt-help${a.enabled ? '' : ' off'}" title="${esc(a.name)}${a.type ? ` · ${esc(a.type)}` : ''}">
    <span class="rt-elbow" aria-hidden="true"></span>
    <span class="rt-role ${cls}">${label}</span>
    <span class="rt-hname${a.role === 'extract' || a.role === 'csv' ? ' mono' : ''}">${esc(main)}</span>
    ${sub ? `<span class="rt-htype">${esc(sub)}</span>` : ''}
    ${a.enabled ? '' : '<span class="rt-hoff">· off in plan</span>'}
  </div>`;
}
// …or as a chip on a "applies to every request here" strip.
function helperChip(a) {
  const [label, cls] = ROLE_LABEL[a.role] || ['Uses', 'r-post'];
  const main = a.role === 'csv' ? (a.file || a.name) : (a.detail || a.name);
  const sub = a.role === 'csv' ? a.name : a.type && a.type !== main ? a.type : '';
  return `<span class="rt-chip${a.enabled ? '' : ' off'}" title="${esc(a.name)}${a.type ? ` · ${esc(a.type)}` : ''}">
    <span class="rt-role ${cls}">${label}</span><span class="rt-hname${a.role === 'extract' || a.role === 'csv' ? ' mono' : ''}">${esc(main)}</span>${sub ? `<span class="rt-htype">${esc(sub)}</span>` : ''}${a.enabled ? '' : '<span class="rt-hoff">· off in plan</span>'}</span>`;
}
function scopeStripHtml(list, label, cls = '') {
  return list.length ? `<div class="rt-scope ${cls}"><span class="rt-scope-k">${label}</span>${list.map(helperChip).join('')}</div>` : '';
}

const CHEVRON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 6 6 6-6 6"/></svg>';
const FOLDER = '<svg class="rt-folder" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

// JMeter runs a request's helpers in this order: pre-processors, the request,
// post-processors/extractors, then assertions — list them the same way.
const HELPER_PHASE = { csv: 0, pre: 1, extract: 2, post: 2, check: 3 };

function requestTreeHtml(tg, samplers) {
  const s = state.plan.structure;
  const ctrls = (s.controllers || []).filter((c) => c.threadGroupId === tg.id);
  const aux = (s.aux || []).filter((a) => a.threadGroupId === tg.id);
  const bySampler = new Map(), byCtrl = new Map(), tgScope = [];
  for (const a of aux) {
    const last = a.ctrlIds && a.ctrlIds.length ? a.ctrlIds[a.ctrlIds.length - 1] : null;
    if (a.samplerId != null) (bySampler.get(a.samplerId) || bySampler.set(a.samplerId, []).get(a.samplerId)).push(a);
    else if (last != null) (byCtrl.get(last) || byCtrl.set(last, []).get(last)).push(a);
    else tgScope.push(a);
  }
  const parentOf = (x) => (x.ctrlIds && x.ctrlIds.length ? x.ctrlIds[x.ctrlIds.length - 1] : null);
  const kidsOf = (cid) => [
    ...ctrls.filter((c) => parentOf(c) === cid).map((c) => ({ c, seq: c.seq })),
    ...samplers.filter((sm) => parentOf(sm) === cid).map((sm) => ({ sm, seq: sm.seq })),
  ].sort((a, b) => (a.seq || 0) - (b.seq || 0));
  // big thread groups open with their controllers folded, so the outline fits on screen
  const startOpen = samplers.length <= 60;
  const node = (it, d) => (it.c ? ctrlHtml(it.c, d) : reqHtml(it.sm, d));
  const ctrlHtml = (c, d) => {
    const nm = prettyCtrlName(c.name);
    const open = startOpen || d > 0;
    return `<div class="rt-ctrl${open ? '' : ' collapsed'}" data-ctrl="${c.id}" style="--d:${d}">
      <div class="rt-row rt-crow">
        <button type="button" class="rt-chev" aria-expanded="${open}" aria-label="${open ? 'Collapse' : 'Expand'} ${esc(nm)}">${CHEVRON}</button>
        <label class="rt-clabel" title="${esc(c.name)}"><input type="checkbox" class="ctrlCb" data-ctrl="${c.id}" data-tg="${tg.id}" ${c.enabled ? 'checked' : ''}>${FOLDER}
          <span class="rt-ctext"><b class="rt-cname">${esc(nm)}</b><small class="rt-csub"></small></span></label>
        <span class="rt-offpill" hidden>Off in plan · its requests won’t run</span>
        <span class="rt-actions">
          <button type="button" class="ghost mini rt-all" data-on="1" aria-label="Tick every request in ${esc(nm)}">All</button>
          <button type="button" class="ghost mini rt-all" data-on="0" aria-label="Untick every request in ${esc(nm)}">None</button>
        </span>
      </div>
      <div class="rt-kids">
        ${scopeStripHtml(byCtrl.get(c.id) || [], 'Every request in this group', 'rt-scope-ctrl')}
        ${kidsOf(c.id).map((k) => node(k, d + 1)).join('')}
      </div>
    </div>`;
  };
  const reqHtml = (sm, d) => `<div class="rt-req" data-name="${esc(sm.name.toLowerCase())}" style="--d:${d}">
      <div class="rt-row rt-rrow">
        <label class="rt-rlabel"><input type="checkbox" class="smCb-${tg.id}" id="smEn-${sm.id}" ${sm.enabled ? 'checked' : ''}>
          <span class="rt-method">${esc(sm.method || 'Req')}</span><span class="rt-name">${esc(sm.name)}</span></label>
        <span class="rt-wont" hidden>Ticked, but its controller is off</span>
      </div>
      ${(bySampler.get(sm.id) || []).slice().sort((x, y) => (HELPER_PHASE[x.role] - HELPER_PHASE[y.role]) || (x.seq - y.seq)).map(helperHtml).join('')}
    </div>`;
  return `${scopeStripHtml(tgScope, 'Every request in this thread group', 'rt-scope-tg')}
    <div class="rt" id="smList-${tg.id}">${kidsOf(null).map((k) => node(k, 0)).join('')}</div>`;
}

// Refresh on/off state, counts and "won't run" hints after any tick.
// (Named updateCtrlDim because applyFormConfig and friends already call it.)
function updateCtrlDim(tgId) {
  const root = $(`smList-${tgId}`);
  if (!root) return;
  const ownCb = (ctrlEl) => ctrlEl.querySelector(':scope > .rt-crow .ctrlCb');
  const offAncestor = (el) => {
    for (let p = el.parentElement && el.parentElement.closest('.rt-ctrl'); p; p = p.parentElement && p.parentElement.closest('.rt-ctrl')) {
      if (!ownCb(p).checked) return p;
    }
    return null;
  };
  root.querySelectorAll('.rt-ctrl').forEach((el) => {
    const on = ownCb(el).checked;
    const anc = offAncestor(el);
    el.classList.toggle('off', !on);
    el.classList.toggle('inactive', !!anc);
    el.querySelector(':scope > .rt-crow .rt-offpill').hidden = on;
    const cbs = [...el.querySelectorAll(`.smCb-${tgId}`)];
    const ticked = cbs.filter((c) => c.checked).length;
    el.querySelector(':scope > .rt-crow .rt-csub').textContent =
      `${cbs.length} request${cbs.length === 1 ? '' : 's'} · ${ticked} ticked` +
      (anc ? ` · inside “${anc.querySelector(':scope > .rt-crow .rt-cname').textContent}”, which is off` : '');
  });
  let willRun = 0;
  const all = root.querySelectorAll('.rt-req');
  all.forEach((el) => {
    const cb = el.querySelector(`.smCb-${tgId}`);
    const own = el.closest('.rt-ctrl');
    const live = !own || (ownCb(own).checked && !offAncestor(own));
    el.classList.toggle('inactive', !live);
    el.querySelector('.rt-wont').hidden = !(cb.checked && !live);
    if (cb.checked && live) willRun++;
  });
  const cnt = $(`smCount-${tgId}`);
  if (cnt) cnt.textContent = `${willRun} of ${all.length} will run`;
}

// Type-to-find: hide non-matching requests (and controllers left empty), open the rest.
function filterTree(tgId, q) {
  const root = $(`smList-${tgId}`);
  if (!root) return;
  q = q.trim().toLowerCase();
  root.classList.toggle('filtering', !!q);
  root.querySelectorAll('.rt-req').forEach((el) => el.classList.toggle('hidden', !!q && !el.dataset.name.includes(q)));
  root.querySelectorAll('.rt-ctrl').forEach((el) => el.classList.toggle('hidden', !!q && !el.querySelector('.rt-req:not(.hidden)')));
  const empty = root.parentElement.querySelector('.rt-nomatch');
  if (empty) empty.hidden = !q || !!root.querySelector('.rt-req:not(.hidden)');
}

function wireTree(tg) {
  const root = $(`smList-${tg.id}`);
  if (!root) return;
  const refresh = () => {
    updateCtrlDim(tg.id);
    if (state.distMode === 'per-agent') renderPerAgentSummary();
  };
  root.querySelectorAll(`.smCb-${tg.id}`).forEach((cb) => (cb.onchange = refresh));
  root.querySelectorAll('.ctrlCb').forEach((cb) => (cb.onchange = refresh));
  root.querySelectorAll('.rt-chev').forEach((b) => (b.onclick = () => {
    const el = b.closest('.rt-ctrl');
    const open = el.classList.toggle('collapsed') === false;
    b.setAttribute('aria-expanded', String(open));
    b.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${el.querySelector('.rt-cname').textContent}`);
  }));
  root.querySelectorAll('.rt-all').forEach((b) => (b.onclick = () => {
    b.closest('.rt-ctrl').querySelectorAll(`.rt-req:not(.hidden) .smCb-${tg.id}`).forEach((cb) => { cb.checked = b.dataset.on === '1'; });
    refresh();
  }));
  const card = $(`tg-${tg.id}`);
  const f = $(`smFilter-${tg.id}`);
  if (f) f.oninput = () => filterTree(tg.id, f.value);
  card.querySelectorAll('[data-small]').forEach((b) => (b.onclick = () => {
    root.querySelectorAll(`.rt-req:not(.hidden) .smCb-${tg.id}`).forEach((cb) => { cb.checked = b.dataset.on === '1'; });
    refresh();
  }));
  card.querySelectorAll('[data-rtfold]').forEach((b) => (b.onclick = () => {
    const open = b.dataset.rtfold === 'open';
    root.querySelectorAll('.rt-ctrl').forEach((el) => {
      el.classList.toggle('collapsed', !open);
      const chev = el.querySelector(':scope > .rt-crow .rt-chev');
      chev.setAttribute('aria-expanded', String(open));
      chev.setAttribute('aria-label', `${open ? 'Collapse' : 'Expand'} ${el.querySelector('.rt-cname').textContent}`);
    });
  }));
  updateCtrlDim(tg.id);
}

const RT_LEGEND = `<div class="rt-legend">
  <span><span class="rt-role r-pre">Before</span>runs just before its request</span>
  <span><span class="rt-role r-ext">Extracts</span>saves a value from the response</span>
  <span><span class="rt-role r-chk">Checks</span>passes or fails the request</span>
  <span><span class="rt-role r-post">After</span>runs after its request</span>
  <span><span class="rt-role r-csv">Reads</span>takes test data from a file</span>
</div>`;

// ---- form <-> config profile (reused for split mode and per-agent profiles) ----

/** Read the whole thread-group / sampler / controller form into a config object. */
function readFormConfig() {
  const s = state.plan.structure;
  return {
    threadGroups: s.threadGroups.map((tg) => {
      const enabled = $(`tgEn-${tg.id}`).checked;
      if (!tg.editable) return { id: tg.id, enabled };
      if (tg.kind === 'arrivals' || tg.kind === 'concurrency') {
        return {
          id: tg.id, enabled,
          threads: parseInt($(`tgThreads-${tg.id}`).value, 10) || 1, // target rate / concurrency
          rampUp: parseInt($(`tgRamp-${tg.id}`).value, 10) || 0,
          steps: parseInt($(`tgSteps-${tg.id}`).value, 10) || 0,
          hold: parseInt($(`tgHold-${tg.id}`).value, 10) || 0,
        };
      }
      const mode = $(`tgMode-${tg.id}`).value;
      const val = parseInt($(`tgVal-${tg.id}`).value, 10) || 1;
      return {
        id: tg.id, enabled,
        threads: parseInt($(`tgThreads-${tg.id}`).value, 10) || 1,
        rampUp: parseInt($(`tgRamp-${tg.id}`).value, 10) || 0,
        mode,
        loops: mode === 'loops' ? val : undefined,
        duration: mode === 'duration' ? val : undefined,
      };
    }),
    // Samplers outside every thread group (e.g. inside a Test Fragment used by a
    // Module Controller) have no checkbox — keep the plan's own setting for them.
    samplers: s.samplers.map((sm) => { const cb = $(`smEn-${sm.id}`); return { id: sm.id, enabled: cb ? cb.checked : sm.enabled }; }),
    controllers: (s.controllers || []).map((c) => {
      const cb = document.querySelector(`.ctrlCb[data-ctrl="${c.id}"]`);
      return { id: c.id, enabled: cb ? cb.checked : c.enabled };
    }),
  };
}

/** Write a config object back into the form inputs (for switching per-agent profiles). */
function applyFormConfig(cfg) {
  if (!cfg) return;
  const s = state.plan.structure;
  for (const tg of s.threadGroups) {
    const t = (cfg.threadGroups || []).find((x) => x.id === tg.id);
    if (!t) continue;
    const en = $(`tgEn-${tg.id}`); if (en) en.checked = t.enabled;
    const box = $(`tg-${tg.id}`); if (box) box.classList.toggle('disabled', !t.enabled);
    if (tg.editable) {
      const th = $(`tgThreads-${tg.id}`); if (th && t.threads != null) th.value = t.threads;
      const rp = $(`tgRamp-${tg.id}`); if (rp && t.rampUp != null) rp.value = t.rampUp;
      if (tg.kind === 'arrivals' || tg.kind === 'concurrency') {
        const sp = $(`tgSteps-${tg.id}`); if (sp && t.steps != null) sp.value = t.steps;
        const hd = $(`tgHold-${tg.id}`); if (hd && t.hold != null) hd.value = t.hold;
      } else {
        const md = $(`tgMode-${tg.id}`); if (md && t.mode) md.value = t.mode;
        const vv = $(`tgVal-${tg.id}`); const v = t.mode === 'duration' ? t.duration : t.loops;
        if (vv && v != null) vv.value = v;
      }
    }
  }
  for (const sm of s.samplers) {
    const x = (cfg.samplers || []).find((y) => y.id === sm.id);
    const cb = $(`smEn-${sm.id}`); if (cb && x) cb.checked = x.enabled;
  }
  for (const c of (s.controllers || [])) {
    const x = (cfg.controllers || []).find((y) => y.id === c.id);
    const cb = document.querySelector(`.ctrlCb[data-ctrl="${c.id}"]`);
    if (cb && x) cb.checked = x.enabled;
  }
  s.threadGroups.forEach((tg) => updateCtrlDim(tg.id)); // tree states + counts
}

// Per-agent profiles are edited in the per-agent grid, which writes straight into
// state.profiles. The classic form is hidden in that mode, so it must NEVER be
// copied over a profile (that silently replaced the first agent's grid edits).
// Kept as a no-op hook for the callers that "save before reading".
function saveActiveProfile() {}

// The load profile for a bzm rate/concurrency group: a staircase from 0 up to
// the target over `ramp` seconds in `steps` steps, then held flat for `hold`.
function rampProfile(target, ramp, steps, hold) {
  const T = Math.max(0, target || 0), R = Math.max(0, ramp || 0), S = Math.max(1, steps || 1), H = Math.max(0, hold || 0);
  const total = Math.max(1, R + H);
  const pts = [[0, 0]];
  if (R > 0 && T > 0) {
    const stepDur = R / S;
    for (let i = 1; i <= S; i++) {
      const y = T * i / S;
      pts.push([(i - 1) * stepDur, y]); // jump up at the start of the step
      pts.push([i * stepDur, y]);        // hold across the step
    }
  } else if (T > 0) {
    pts.push([0, T]);
  }
  pts.push([total, T]); // hold at target until the end
  let area = 0; // area under the staircase = ~total arrivals
  for (let i = 1; i < pts.length; i++) area += (pts[i][0] - pts[i - 1][0]) * ((pts[i - 1][1] + pts[i][1]) / 2);
  return { pts, total, T, area: Math.round(area) };
}

function rampChartSvg(kind, target, ramp, steps, hold) {
  const { pts, total, T, area } = rampProfile(target, ramp, steps, hold);
  const W = 420, Hh = 84, padL = 2, padR = 4, padT = 8, padB = 6;
  const plotW = W - padL - padR, plotH = Hh - padT - padB;
  const maxY = Math.max(1, T);
  const x = (t) => padL + (t / total) * plotW;
  const y = (v) => padT + plotH - (v / maxY) * plotH;
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p[0]).toFixed(1)} ${y(p[1]).toFixed(1)}`).join(' ');
  const areaPath = `${line} L${x(total).toFixed(1)} ${y(0).toFixed(1)} L${x(0).toFixed(1)} ${y(0).toFixed(1)} Z`;
  const totalLabel = kind === 'arrivals' ? `~${fmt.n(area)} total arrivals` : `peak ${fmt.n(T)} users`;
  return `<div class="tg-chart-head">
      <span class="tg-chart-title">${kind === 'arrivals' ? 'Arrival rate' : 'Concurrency'} over ${Math.round(total)}s</span>
      <span class="tg-chart-total">${totalLabel}</span>
    </div>
    <svg class="tg-chart-svg" viewBox="0 0 ${W} ${Hh}" preserveAspectRatio="none" aria-hidden="true">
      <line class="tgc-axis" x1="${padL}" y1="${y(0).toFixed(1)}" x2="${W - padR}" y2="${y(0).toFixed(1)}"/>
      <path class="tgc-area" d="${areaPath}"/>
      <path class="tgc-line" d="${line}"/>
    </svg>
    <div class="tg-chart-x"><span>0s</span><span>ramp ${Math.max(0, ramp | 0)}s</span><span>${Math.round(total)}s</span></div>`;
}

function updateRampChart(id) {
  const el = $(`tgChart-${id}`);
  if (!el) return;
  const tg = state.plan.structure.threadGroups.find((t) => t.id === id);
  if (!tg) return;
  el.innerHTML = rampChartSvg(tg.kind,
    parseInt($(`tgThreads-${id}`).value, 10) || 0,
    parseInt($(`tgRamp-${id}`).value, 10) || 0,
    parseInt($(`tgSteps-${id}`).value, 10) || 1,
    parseInt($(`tgHold-${id}`).value, 10) || 0);
}

// Editable inputs for a thread group — the fields differ by kind: bzm
// Arrivals/Concurrency use a rate model (target + ramp + steps + hold), while a
// standard group uses threads + ramp + loops/duration.
function tgFieldsHtml(tg) {
  if (tg.kind === 'arrivals' || tg.kind === 'concurrency') {
    const rateLabel = tg.kind === 'arrivals'
      ? 'Total target rate — arrivals/sec (all agents)'
      : 'Total target concurrency — users (all agents)';
    return `
      <div class="tg-rate-row">
        <div class="tg-rate-fields">
          <label class="field"><span class="tg-threads-label" data-rate="${tg.kind === 'arrivals' ? 'rate' : 'conc'}">${rateLabel}</span>
            <input type="number" id="tgThreads-${tg.id}" value="${tg.threads}" min="1">
          </label>
          <label class="field">Ramp-up time (s)
            <input type="number" id="tgRamp-${tg.id}" value="${tg.rampUp}" min="0">
          </label>
          <label class="field">Ramp-up steps
            <input type="number" id="tgSteps-${tg.id}" value="${tg.steps}" min="0">
          </label>
          <label class="field">Hold target (s)
            <input type="number" id="tgHold-${tg.id}" value="${tg.hold}" min="0">
          </label>
          <span class="tg-kind-badge">${tg.kind === 'arrivals' ? 'bzm · Arrivals' : 'bzm · Concurrency'}</span>
        </div>
        <div class="tg-chart" id="tgChart-${tg.id}">${rampChartSvg(tg.kind, tg.threads, tg.rampUp, tg.steps, tg.hold)}</div>
      </div>`;
  }
  const isSetup = tg.tag === 'SetupThreadGroup' || tg.tag === 'PostThreadGroup';
  return `
    <label class="field"><span class="tg-threads-label" data-setup="${isSetup ? 1 : 0}">${isSetup ? 'Threads (each agent runs its own)' : 'Total threads (all agents)'}</span>
      <input type="number" id="tgThreads-${tg.id}" value="${tg.threads}" min="1">
    </label>
    <label class="field">Ramp-up (s)
      <input type="number" id="tgRamp-${tg.id}" value="${tg.rampUp}" min="0">
    </label>
    <label class="field">Run mode
      <select id="tgMode-${tg.id}">
        <option value="duration" ${tg.scheduler ? 'selected' : ''}>Duration (s)</option>
        <option value="loops" ${tg.scheduler ? '' : 'selected'}>Loop count</option>
      </select>
    </label>
    <label class="field">Value
      <input type="number" id="tgVal-${tg.id}" value="${tg.scheduler ? (tg.duration || 60) : (tg.loops > 0 ? tg.loops : 1)}" min="1">
    </label>`;
}

function renderConfig() {
  const s = state.plan.structure;
  // Test-plan-level CSV / processors (not inside any thread group) — shown once on top.
  const planAux = (s.aux || []).filter((a) => a.threadGroupId === null);
  const planAuxHtml = scopeStripHtml(planAux, 'Every thread group in this plan', 'rt-scope-plan');
  $('tgList').innerHTML = planAuxHtml + s.threadGroups.map((tg) => {
    const samplers = s.samplers.filter((x) => x.threadGroupId === tg.id);
    const editable = tg.editable;
    const many = samplers.length > 10;
    const enabledCount = samplers.filter((x) => x.enabled).length;
    return `
    <div class="tg ${tg.enabled ? '' : 'disabled'}" id="tg-${tg.id}">
      <div class="tg-head">
        <input type="checkbox" id="tgEn-${tg.id}" ${tg.enabled ? 'checked' : ''}>
        <span>${esc(tg.name)}</span>
        <span class="tg-tag">${tg.tag}${editable ? '' : ' · custom group, runs with its own settings'}</span>
      </div>
      ${editable ? tgFieldsHtml(tg) : ''}
      ${samplers.length ? `
      <details open class="rt-details">
        <summary>Requests <span class="badge" id="smCount-${tg.id}">${enabledCount} of ${samplers.length}</span></summary>
        <div class="sampler-tools rt-tools">
          ${many ? `<input type="search" id="smFilter-${tg.id}" placeholder="Find one of ${samplers.length} requests…" aria-label="Find a request in ${esc(tg.name)}">` : ''}
          <button type="button" class="ghost mini" data-small="${tg.id}" data-on="1">Tick all</button>
          <button type="button" class="ghost mini" data-small="${tg.id}" data-on="0">Untick all</button>
          ${(s.controllers || []).some((c) => c.threadGroupId === tg.id) ? `
          <button type="button" class="ghost mini" data-rtfold="open">Expand all</button>
          <button type="button" class="ghost mini" data-rtfold="close">Collapse all</button>` : ''}
        </div>
        ${requestTreeHtml(tg, samplers)}
        <p class="rt-nomatch" hidden>No request matches that search.</p>
      </details>` : ''}
    </div>`;
  }).join('') + ((s.aux || []).length ? RT_LEGEND : '');

  s.threadGroups.forEach((tg) => {
    $(`tgEn-${tg.id}`).onchange = (e) => {
      $(`tg-${tg.id}`).classList.toggle('disabled', !e.target.checked);
      renderSplitPreview();
      renderDataFiles(); // a CSV under this group may become (un)needed
      if (state.distMode === 'per-agent') renderPerAgentSummary();
    };
    const th = $(`tgThreads-${tg.id}`);
    if (th) th.oninput = () => { renderSplitPreview(); updateRampChart(tg.id); if (state.distMode === 'per-agent') renderPerAgentSummary(); };
    // bzm rate/concurrency groups: live-update the ramp preview as ramp/steps/hold change
    if (tg.kind === 'arrivals' || tg.kind === 'concurrency') {
      ['tgRamp', 'tgSteps', 'tgHold'].forEach((p) => {
        const inp = $(`${p}-${tg.id}`);
        if (inp) inp.oninput = () => updateRampChart(tg.id);
      });
    }

    wireTree(tg); // tick / fold / find / All-None for this group's request tree
  });
}

// The agents the user deliberately chose (null = no choice yet → every idle agent).
// Busy/offline agents can't be ticked, so they're remembered here rather than read
// back from the checkboxes — otherwise agents busy in the last run would come back
// unticked once they're idle again.
state.agentChoice = null;
function recordAgentChoice() {
  const next = new Set(selectedAgents());
  document.querySelectorAll('.agentCb:disabled').forEach((cb) => {
    if (!state.agentChoice || state.agentChoice.has(cb.value)) next.add(cb.value);
  });
  state.agentChoice = next;
}

function renderAgentPick() {
  if (!state.plan) return;
  // Keep the user's selection when the agent list refreshes (an agent connecting,
  // disconnecting or finishing a run must not silently change step 3).
  const isOn = (a) => a.state === 'idle' && (state.agentChoice ? state.agentChoice.has(a.name) : true);
  $('agentPick').innerHTML = state.agents.length
    ? state.agents.map((a) => `
      <label>
        <input type="checkbox" class="agentCb" value="${esc(a.name)}" ${a.state !== 'idle' ? 'disabled' : isOn(a) ? 'checked' : ''}>
        <span><b>${esc(a.name)}</b><br><span class="meta">${Number(a.cpus) || 0} cores · ${Number(a.memGB) || 0} GB · ${esc(a.state)}${a.stub ? ' · STUB' : ''}</span><br>${resMeter(a.res, a.name)}</span>
      </label>`).join('')
    : '<span class="empty">No agents connected — start the agent exe on your worker PCs.</span>';
  document.querySelectorAll('.agentCb').forEach((cb) => (cb.onchange = () => { recordAgentChoice(); afterAgentSelChange(); }));
  populateTeamSelect();
  renderSplitPreview();
  renderDataFiles();
  updateDistUI();
  scheduleWizRefresh();
}

function afterAgentSelChange() { renderSplitPreview(); renderDataFiles(); renderReportAssign(); updateDistUI(); scheduleWizRefresh(); }

function selectedAgents() {
  return [...document.querySelectorAll('.agentCb:checked')].map((c) => c.value);
}

// ---- New Run: select all / none + load a saved team ----
function populateTeamSelect() {
  const sel = $('loadTeamSel');
  if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = '<option value="">— load a team —</option>' +
    (state.teams || []).map((t) => `<option value="${esc(t.id)}">${esc(t.name)} (${t.agents.length})</option>`).join('');
  if ([...sel.options].some((o) => o.value === cur)) sel.value = cur;
}
if ($('agentSelectAll')) $('agentSelectAll').onclick = () => {
  document.querySelectorAll('.agentCb:not(:disabled)').forEach((cb) => { cb.checked = true; });
  state.agentChoice = null; // "all" — including agents that become idle later
  afterAgentSelChange();
};
if ($('agentUnselectAll')) $('agentUnselectAll').onclick = () => {
  document.querySelectorAll('.agentCb').forEach((cb) => { cb.checked = false; });
  state.agentChoice = new Set();
  afterAgentSelChange();
};
if ($('loadTeamSel')) $('loadTeamSel').onchange = () => {
  const id = $('loadTeamSel').value;
  if (!id) { $('teamLoadNote').textContent = ''; return; }
  const team = (state.teams || []).find((t) => t.id === id);
  if (!team) return;
  const want = new Set(team.agents);
  const present = new Set();
  let offline = 0;
  document.querySelectorAll('.agentCb').forEach((cb) => {
    present.add(cb.value);
    if (want.has(cb.value)) { if (cb.disabled) { offline++; cb.checked = false; } else cb.checked = true; }
    else cb.checked = false;
  });
  const absent = team.agents.filter((a) => !present.has(a));
  state.agentChoice = want; // busy team members get ticked once they're idle
  afterAgentSelChange();
  const notes = [];
  if (offline) notes.push(`${offline} busy/not-idle`);
  if (absent.length) notes.push(`${absent.length} not connected: ${absent.join(', ')}`);
  $('teamLoadNote').textContent = notes.length ? `⚠ ${notes.join(' · ')}` : `✓ loaded "${team.name}"`;
};

// ---------------- Team view: create / edit named agent groups ----------------
async function loadTeamView() {
  try { state.teams = await api('GET', '/api/teams'); } catch { state.teams = []; }
  if (!state.agents.length) { try { state.agents = await api('GET', '/api/agents'); } catch { /* keep */ } }
  renderTeamForm();
  renderTeamList();
}
function updateTeamSelCount() {
  const n = document.querySelectorAll('.teamAgentCb:checked').length;
  const el = $('teamSelCount'); if (el) el.textContent = `${n} selected`;
}
function renderTeamForm() {
  const editing = state.editingTeamId ? state.teams.find((t) => t.id === state.editingTeamId) : null;
  $('teamFormTitle').textContent = editing ? `Edit team: ${editing.name}` : 'Create a team';
  $('teamName').value = editing ? editing.name : '';
  $('teamSave').textContent = editing ? 'Update team' : 'Save team';
  $('teamCancel').style.display = editing ? 'inline-block' : 'none';
  const chosen = new Set(editing ? editing.agents : []);
  const online = new Set((state.agents || []).map((a) => a.name));
  // pick from connected agents + any names the edited team already has (may be offline)
  const names = [...new Set([...(state.agents || []).map((a) => a.name), ...(editing ? editing.agents : [])])].sort();
  $('teamAgentPick').innerHTML = names.length
    ? names.map((n) => `<label class="team-agent-tile">
        <input type="checkbox" class="teamAgentCb" value="${esc(n)}" ${chosen.has(n) ? 'checked' : ''}>
        <span class="tat-dot ${online.has(n) ? 'on' : 'off'}"></span>
        <span class="tat-name">${esc(n)}</span>
        <span class="tat-state">${online.has(n) ? 'online' : 'offline'}</span>
      </label>`).join('')
    : '<span class="empty">No agents known yet — connect agents first, then create a team.</span>';
  document.querySelectorAll('.teamAgentCb').forEach((cb) => (cb.onchange = updateTeamSelCount));
  updateTeamSelCount();
}
function renderTeamList() {
  const el = $('teamList');
  const online = new Set((state.agents || []).map((a) => a.name));
  $('teamCount').textContent = state.teams.length ? `${state.teams.length} team${state.teams.length === 1 ? '' : 's'}` : '';
  if (!state.teams.length) { el.innerHTML = '<span class="empty">No teams yet — create one above.</span>'; return; }
  el.innerHTML = state.teams.map((t) => {
    const onCount = t.agents.filter((a) => online.has(a)).length;
    return `
    <div class="team-card">
      <div class="team-card-head">
        <b class="team-card-name">${esc(t.name)}</b>
        <span class="count-pill">${t.agents.length}</span>
      </div>
      <div class="team-card-sub">${onCount}/${t.agents.length} online</div>
      <div class="team-chips">${t.agents.map((a) => `<span class="team-chip ${online.has(a) ? 'on' : 'off'}"><span class="tat-dot ${online.has(a) ? 'on' : 'off'}"></span>${esc(a)}</span>`).join('') || '<span class="hint" style="margin:0;">no agents</span>'}</div>
      <div class="team-card-actions">
        <button type="button" class="primary mini team-use" data-id="${esc(t.id)}">Use in a new run</button>
        <button type="button" class="ghost mini team-edit" data-id="${esc(t.id)}">Edit</button>
        <button type="button" class="ghost mini danger team-del" data-id="${esc(t.id)}">Delete</button>
      </div>
    </div>`;
  }).join('');
  el.querySelectorAll('.team-use').forEach((b) => (b.onclick = () => { const t = state.teams.find((x) => x.id === b.dataset.id); if (t) useTeamInNewRun(t); }));
  el.querySelectorAll('.team-edit').forEach((b) => (b.onclick = () => { state.editingTeamId = b.dataset.id; renderTeamForm(); $('teamName').scrollIntoView({ behavior: 'smooth', block: 'center' }); $('teamName').focus(); }));
  el.querySelectorAll('.team-del').forEach((b) => (b.onclick = async () => {
    if (!confirm('Delete this team?')) return;
    try {
      await api('DELETE', `/api/teams/${b.dataset.id}`);
      state.teams = state.teams.filter((t) => t.id !== b.dataset.id);
      if (state.editingTeamId === b.dataset.id) state.editingTeamId = null;
      renderTeamForm(); renderTeamList(); populateTeamSelect(); renderAgents();
    } catch (e) { alert(e.message); }
  }));
}
if ($('teamSave')) $('teamSave').onclick = async () => {
  const name = $('teamName').value.trim();
  if (!name) { $('teamMsg').textContent = '✗ Enter a team name.'; return; }
  const agents = [...document.querySelectorAll('.teamAgentCb:checked')].map((c) => c.value);
  try {
    if (state.editingTeamId) {
      const t = await api('PUT', `/api/teams/${state.editingTeamId}`, { name, agents });
      const i = state.teams.findIndex((x) => x.id === t.id); if (i >= 0) state.teams[i] = t;
      state.editingTeamId = null;
    } else {
      const t = await api('POST', '/api/teams', { name, agents });
      state.teams.push(t);
    }
    $('teamMsg').textContent = '✓ Saved.';
    setTimeout(() => { $('teamMsg').textContent = ''; }, 2000);
    renderTeamForm(); renderTeamList(); populateTeamSelect(); renderAgents();
  } catch (e) { $('teamMsg').textContent = `✗ ${e.message}`; }
};
if ($('teamCancel')) $('teamCancel').onclick = () => { state.editingTeamId = null; renderTeamForm(); };
if ($('teamSelectAll')) $('teamSelectAll').onclick = () => { document.querySelectorAll('.teamAgentCb').forEach((c) => { c.checked = true; }); updateTeamSelCount(); };
if ($('teamClear')) $('teamClear').onclick = () => { document.querySelectorAll('.teamAgentCb').forEach((c) => { c.checked = false; }); updateTeamSelCount(); };

// ---------------- per-agent profiles ----------------

document.querySelectorAll('input[name="distMode"]').forEach((r) => {
  r.onchange = () => {
    if (r.value === state.distMode) return;
    if (r.value === 'per-agent') {
      // seed every selected agent's profile from the current (shared) form
      const base = readFormConfig();
      state.profiles = {};
      for (const a of selectedAgents()) state.profiles[a] = JSON.parse(JSON.stringify(base));
      state.distMode = 'per-agent';
      state.editingAgent = selectedAgents()[0] || null;
    } else {
      saveActiveProfile();
      state.distMode = 'split';
      state.editingAgent = null;
    }
    updateDistUI();
  };
});

$('profileAgentSel').onchange = () => {
  saveActiveProfile();
  state.editingAgent = $('profileAgentSel').value;
  applyFormConfig(state.profiles[state.editingAgent]);
  renderPerAgentSummary();
};

$('copyProfileAll').onclick = () => {
  saveActiveProfile();
  const src = state.profiles[state.editingAgent];
  if (!src) return;
  for (const a of selectedAgents()) state.profiles[a] = JSON.parse(JSON.stringify(src));
  $('startErr').textContent = '';
  flash($('copyProfileAll'), 'Copied ✓');
  renderPerAgentSummary();
};

function flash(btn, text) {
  const old = btn.textContent; btn.textContent = text;
  setTimeout(() => { btn.textContent = old; }, 1200);
}

// Reflect the current distribution mode in the UI (labels, picker, preview).
function updateDistUI() {
  const per = state.distMode === 'per-agent';
  $('agentProfilePicker').style.display = per ? 'inline-flex' : 'none';
  $('perAgentHint').style.display = per ? 'block' : 'none';
  $('splitPreview').style.display = per ? 'none' : '';
  // thread-count / rate label wording (bzm rate & concurrency groups keep their own noun)
  document.querySelectorAll('.tg-threads-label').forEach((el) => {
    if (el.dataset.rate) {
      const noun = el.dataset.rate === 'conc' ? 'target concurrency — users' : 'target rate — arrivals/sec';
      el.textContent = per ? `${noun.replace('target ', 'Target ')} (this agent)` : `Total ${noun} (all agents)`;
      return;
    }
    el.textContent = per ? 'Threads (this agent)'
      : (el.dataset.setup === '1' ? 'Threads (each agent runs its own)' : 'Total threads (all agents)');
  });
  // In per-agent mode the TREE MATRIX is the editor — hide the classic per-TG form.
  $('tgList').style.display = per ? 'none' : '';
  $('agentProfilePicker').style.display = 'none';
  const sum = $('perAgentSummary');
  if (sum) sum.style.display = per ? 'block' : 'none';
  if (per) {
    for (const a of selectedAgents()) if (!state.profiles[a]) state.profiles[a] = readFormConfig();
    renderPerAgentSummary();
  }
}

/**
 * Per-agent assignment TREE: agents are COLUMNS; the workload column is a
 * collapsible tree (thread group → controllers → nested controllers → samplers)
 * that mirrors the JMeter tree. Per agent: thread-count for groups, a checkbox
 * for controllers/samplers. Ancestor-off cells are dimmed. Edits write straight
 * into state.profiles.
 */
function renderPerAgentSummary() {
  const el = $('perAgentSummary');
  if (!el || !state.plan) return;
  const agents = selectedAgents();
  if (!agents.length) { el.innerHTML = '<p class="hint" style="margin:0">Select agents in step 3 to assign work.</p>'; return; }
  const s = state.plan.structure;
  for (const a of agents) if (!state.profiles[a]) state.profiles[a] = readFormConfig();

  const tgProf = (a, id) => (state.profiles[a].threadGroups || []).find((t) => t.id === id) || {};
  const ctrlProf = (a, id) => (state.profiles[a].controllers || []).find((c) => c.id === id) || {};
  const smProf = (a, id) => (state.profiles[a].samplers || []).find((x) => x.id === id) || {};

  // build parent → children map (controllers + samplers), in document order
  const parentKey = (it) => (it.ctrlIds && it.ctrlIds.length) ? `ctrl-${it.ctrlIds[it.ctrlIds.length - 1]}` : `tg-${it.threadGroupId}`;
  const childrenOf = new Map();
  const add = (k, n) => { if (!childrenOf.has(k)) childrenOf.set(k, []); childrenOf.get(k).push(n); };
  for (const c of (s.controllers || [])) add(parentKey(c), { kind: 'ctrl', id: c.id, name: c.name, seq: c.seq || 0 });
  for (const m of s.samplers) add(parentKey(m), { kind: 'sampler', id: m.id, name: m.name, seq: m.seq || 0 });
  for (const arr of childrenOf.values()) arr.sort((a, b) => a.seq - b.seq);

  if (!state.matrixExpanded) state.matrixExpanded = new Set(s.threadGroups.map((t) => `tg-${t.id}`));
  const exp = state.matrixExpanded;

  const cell = (kind, id, agent, on, dim, editable, threads, unit) => {
    const da = `data-agent="${esc(agent)}"`;
    if (kind === 'tg' && editable) {
      const u = unit ? `<span class="am-th-unit">${unit}</span>` : '';
      const title = unit === '/s' ? 'Target arrivals/sec on this agent (0 = skip)'
        : unit === 'users' ? 'Target concurrent users on this agent (0 = skip)'
        : 'Threads on this agent (0 = skip)';
      return `<td class="am-cell"><span class="am-th-wrap"><input type="number" min="0" class="am-th" ${da} data-tg="${id}" value="${on ? (threads || 0) : 0}" title="${title}">${u}</span></td>`;
    }
    const cls = kind === 'tg' ? 'am-en' : kind === 'ctrl' ? 'am-ct' : 'am-sm';
    const attr = kind === 'tg' ? `data-tg="${id}"` : kind === 'ctrl' ? `data-ctrl="${id}"` : `data-sm="${id}"`;
    return `<td class="am-cell ${on ? 'am-on' : 'am-off'} ${dim ? 'am-dim' : ''}"><input type="checkbox" class="${cls}" ${da} ${attr} ${on ? 'checked' : ''}></td>`;
  };

  const rows = [];
  const icon = (k) => k === 'tg' ? ic('layers', 'node-ic') : k === 'ctrl' ? ic('folder', 'node-ic') : '<span class="node-dot"></span>';
  const renderNode = (node, depth, ancOn) => {
    const key = `${node.kind}-${node.id}`;
    const kids = node.kind === 'sampler' ? [] : (childrenOf.get(key) || []);
    const open = exp.has(key);
    const chev = kids.length
      ? `<span class="am-chev ${open ? 'open' : ''}" data-key="${key}">▸</span>`
      : '<span class="am-chev-none"></span>';
    const tg = node.kind === 'tg' ? state.plan.structure.threadGroups.find((t) => t.id === node.id) : null;
    const tgUnit = tg && tg.kind === 'arrivals' ? '/s' : tg && tg.kind === 'concurrency' ? 'users' : '';
    const rateSub = tg && (tg.kind === 'arrivals' || tg.kind === 'concurrency')
      ? ` <span class="am-sub am-rate">${tg.kind === 'arrivals' ? 'arrivals/sec' : 'target users'}</span>` : '';
    const nameCell = `<td class="am-name am-name-${node.kind}" title="${esc(node.name)}" style="padding-left:${8 + depth * 20}px">${chev}<span class="am-ic">${icon(node.kind)}</span> ${esc(node.name)}${tg && !tg.editable ? ' <span class="am-sub">custom</span>' : ''}${rateSub}</td>`;
    const cells = agents.map((a, i) => {
      if (node.kind === 'tg') {
        const p = tgProf(a, node.id);
        const on = tg.editable ? !!p.enabled : !!p.enabled;
        return cell('tg', node.id, a, on, false, tg.editable, p.threads, tgUnit);
      }
      const on = node.kind === 'ctrl' ? !!ctrlProf(a, node.id).enabled : !!smProf(a, node.id).enabled;
      return cell(node.kind, node.id, a, on, !ancOn[i], false);
    }).join('');
    rows.push(`<tr class="am-row am-r-${node.kind}">${nameCell}${cells}</tr>`);
    if (kids.length && open) {
      const ownOn = node.kind === 'tg'
        ? agents.map((a) => { const p = tgProf(a, node.id); return tg.editable ? (p.enabled && (p.threads || 0) > 0) : !!p.enabled; })
        : agents.map((a, i) => ancOn[i] && !!ctrlProf(a, node.id).enabled);
      for (const ch of kids) renderNode(ch, depth + 1, ownOn);
    }
  };
  for (const tg of s.threadGroups) renderNode({ kind: 'tg', id: tg.id, name: tg.name }, 0, agents.map(() => true));

  const head = `<tr><th class="am-corner"><div class="am-corner-inner">
      <button class="ghost mini" id="amExpandAll">${ic('expand')} Expand all</button>
      <button class="ghost mini" id="amCollapseAll">${ic('collapse')} Collapse</button>
    </div></th>${agents.map((a) => `<th class="am-agent-h"><div>${esc(a)}</div><button class="ghost mini am-copy" data-agent="${esc(a)}" title="Copy this agent's assignment to all agents">copy → all</button></th>`).join('')}</tr>`;

  // bzm rate/concurrency groups: rate is per-agent (matrix), but the ramp
  // TIMELINE is shared so every agent ramps in sync — edit it here.
  const rateTgs = s.threadGroups.filter((t) => t.kind === 'arrivals' || t.kind === 'concurrency');
  const timelinePanel = rateTgs.length ? `
    <div class="pa-timeline">
      <div class="pa-timeline-head">${ic('clock')} Ramp timeline <span class="hint" style="margin:0">— shared by all agents (only the target rate above is per-agent)</span></div>
      ${rateTgs.map((tg) => {
        const p0 = tgProf(agents[0], tg.id);
        const v = (f, d) => (p0[f] != null ? p0[f] : d);
        return `<div class="pa-timeline-row">
          <span class="pa-tl-name">${esc(tg.name)}</span>
          <label class="field">Ramp-up time (s)<input type="number" min="0" class="pa-tl" data-tg="${tg.id}" data-f="rampUp" value="${v('rampUp', tg.rampUp)}"></label>
          <label class="field">Ramp-up steps<input type="number" min="0" class="pa-tl" data-tg="${tg.id}" data-f="steps" value="${v('steps', tg.steps)}"></label>
          <label class="field">Hold target (s)<input type="number" min="0" class="pa-tl" data-tg="${tg.id}" data-f="hold" value="${v('hold', tg.hold)}"></label>
        </div>`;
      }).join('')}
    </div>` : '';

  const wrap = el.querySelector('.am-wrap');
  const st = wrap ? wrap.scrollTop : 0, sl = wrap ? wrap.scrollLeft : 0;
  el.innerHTML = `<div class="am-legend"><span class="am-key am-on"></span> runs &nbsp; <span class="am-key am-off"></span> off &nbsp; <span class="am-key am-dim"></span> parent disabled · <b>columns = agents</b>, expand a scenario to reach its samplers</div>
    ${timelinePanel}
    <div class="am-wrap"><table class="assign-matrix"><thead>${head}</thead><tbody>${rows.join('')}</tbody></table></div>`;
  const nw = el.querySelector('.am-wrap'); if (nw) { nw.scrollTop = st; nw.scrollLeft = sl; }

  // wiring
  el.querySelectorAll('.am-chev').forEach((c) => c.onclick = () => {
    const k = c.dataset.key; exp.has(k) ? exp.delete(k) : exp.add(k); renderPerAgentSummary();
  });
  el.querySelectorAll('.am-th').forEach((inp) => inp.onchange = () => {
    const t = tgProf(inp.dataset.agent, +inp.dataset.tg), n = Math.max(0, parseInt(inp.value, 10) || 0);
    t.threads = n || 1; t.enabled = n > 0; renderPerAgentSummary();
  });
  // shared ramp timeline for bzm groups → apply to EVERY agent's profile
  el.querySelectorAll('.pa-tl').forEach((inp) => inp.onchange = () => {
    const id = +inp.dataset.tg, f = inp.dataset.f, v = Math.max(0, parseInt(inp.value, 10) || 0);
    for (const a of agents) tgProf(a, id)[f] = v;
  });
  el.querySelectorAll('.am-en').forEach((inp) => inp.onchange = () => {
    tgProf(inp.dataset.agent, +inp.dataset.tg).enabled = inp.checked; renderPerAgentSummary();
  });
  el.querySelectorAll('.am-ct').forEach((inp) => inp.onchange = () => {
    ctrlProf(inp.dataset.agent, +inp.dataset.ctrl).enabled = inp.checked; renderPerAgentSummary();
  });
  el.querySelectorAll('.am-sm').forEach((inp) => inp.onchange = () => {
    smProf(inp.dataset.agent, +inp.dataset.sm).enabled = inp.checked; // leaf: no re-render needed
  });
  el.querySelectorAll('.am-copy').forEach((b) => b.onclick = () => {
    const src = state.profiles[b.dataset.agent];
    for (const a of agents) if (a !== b.dataset.agent) state.profiles[a] = JSON.parse(JSON.stringify(src));
    renderPerAgentSummary();
  });
  const setAll = (open) => {
    exp.clear();
    if (open) { for (const t of s.threadGroups) exp.add(`tg-${t.id}`); for (const c of (s.controllers || [])) exp.add(`ctrl-${c.id}`); }
    renderPerAgentSummary();
  };
  if ($('amExpandAll')) $('amExpandAll').onclick = () => setAll(true);
  if ($('amCollapseAll')) $('amCollapseAll').onclick = () => setAll(false);
}

function renderSplitPreview() {
  const agents = selectedAgents();
  if (!state.plan || !agents.length) { $('splitPreview').textContent = ''; return; }
  const parts = [];
  for (const tg of state.plan.structure.threadGroups) {
    if (!tg.editable || !$(`tgEn-${tg.id}`).checked) continue;
    const total = parseInt($(`tgThreads-${tg.id}`).value, 10) || 0;
    if (tg.tag === 'SetupThreadGroup' || tg.tag === 'PostThreadGroup') {
      parts.push(`“${tg.name}”: ${total} thread(s) on EVERY agent (not split)`);
      continue;
    }
    const unit = tg.kind === 'arrivals' ? ' arrivals/sec' : tg.kind === 'concurrency' ? ' users' : ' threads';
    let split;
    if (tg.kind === 'arrivals' || tg.kind === 'concurrency') {
      const per = +(total / agents.length).toFixed(2); // fractional so no agent gets 0
      split = agents.map(() => per).join(' + ');
    } else {
      const base = Math.floor(total / agents.length);
      const extra = total % agents.length;
      split = agents.map((_, k) => base + (k < extra ? 1 : 0)).join(' + ');
    }
    parts.push(`“${tg.name}”: ${total}${unit} → ${split}`);
  }
  $('splitPreview').textContent = parts.length ? `Load split across ${agents.length} agent(s):  ${parts.join('   ·   ')}` : '';
}

// Validate the New Run form and assemble the run config (shared by Start and
// Schedule). Throws with a user-facing message if something's missing.
// Files this plan actively reads (enabled CSV + enabled thread group) must be
// satisfied by the library; per-agent files need a copy for every selected agent.
// In per-agent profile mode the server validates the union of profiles, so skip.
function dataFileIssues() {
  if (!state.plan || state.distMode === 'per-agent') return [];
  const issues = [];
  for (const ref of (state.plan.structure.dataFileRefs || []).filter(csvRefNeeded)) {
    const f = (state.library || []).find((x) => x.logical === libKey(ref.name));
    if (!f) { issues.push({ ref: ref.name, msg: `The plan reads "${ref.name}" but no file is attached for it — attach one under Data files (step 3).` }); continue; }
    if (f.mode === 'per-agent') {
      const missing = selectedAgents().filter((a) => !(f.perAgent || {})[a.replace(/[^\w.-]/g, '_')]);
      if (missing.length) issues.push({ ref: ref.name, msg: `Attach "${f.logical}" for: ${missing.join(', ')} — click each agent under Data files (step 3).` });
    }
  }
  return issues;
}

function buildRunConfig() {
  // an empty test would start on every agent and send nothing
  const w = workloadSummary();
  if (!w.groups.length) throw new Error('No thread group is switched on — turn at least one on in step 2.');
  if (!w.willRun) throw new Error('No request would run — tick at least one request (under a controller that is on) in step 2.');
  const issues = dataFileIssues();
  if (issues.length) throw new Error(issues[0].msg);
  const agents = selectedAgents();
  if (!agents.length) throw new Error('Select at least one load-generator PC (step 3).');
  const config = {
    heap: $('heap').value,
    liveInterval: parseInt($('liveInterval').value, 10) || 2,
    agents,
    report: reportConfigFromForm(),
  };
  if (state.distMode === 'per-agent') {
    saveActiveProfile(); // capture whatever agent is currently on screen
    config.mode = 'per-agent';
    config.agentConfigs = {};
    for (const name of agents) config.agentConfigs[name] = state.profiles[name] || readFormConfig();
  } else {
    Object.assign(config, readFormConfig());
  }
  config.variables = readVariableOverrides(); // User Defined Variable overrides (global, both modes)
  if ($('syncSheet') && $('syncSheet').checked) config.syncSheet = true; // per-run Google Sheet opt-in
  return config;
}

$('startBtn').onclick = async () => {
  $('startErr').textContent = '';
  let config;
  try { config = buildRunConfig(); } catch (e) { $('startErr').textContent = e.message; return; }
  try {
    $('startBtn').disabled = true;
    const run = await api('POST', '/api/runs', { planId: state.plan.id, config });
    if (!state.run) resetLiveView();
    onRunUpdate(run); // resets the live view when this is a new run id
    showView('live');
  } catch (err) {
    $('startErr').textContent = err.message;
  } finally {
    $('startBtn').disabled = false;
  }
};

// ---------------- scheduling ----------------
let schType = 'daily';
function updateSchTypeUI() {
  document.querySelectorAll('#schType button').forEach((b) => b.classList.toggle('active', b.dataset.t === schType));
  $('schDateWrap').style.display = schType === 'once' ? '' : 'none';
  $('schDaysWrap').style.display = schType === 'weekly' ? '' : 'none';
}
function openScheduleModal() {
  if (!state.plan) { $('startErr').textContent = 'Load a plan first.'; return; }
  $('schName').value = ''; $('schMsg').textContent = '';
  schType = 'daily'; updateSchTypeUI();
  $('scheduleOverlay').style.display = 'flex';
}
function closeScheduleModal() { $('scheduleOverlay').style.display = 'none'; }

$('scheduleBtn').onclick = openScheduleModal;
$('scheduleClose').onclick = closeScheduleModal;
$('scheduleOverlay').onclick = (e) => { if (e.target === $('scheduleOverlay')) closeScheduleModal(); };
document.querySelectorAll('#schType button').forEach((b) => (b.onclick = () => { schType = b.dataset.t; updateSchTypeUI(); }));

$('schSave').onclick = async () => {
  $('schMsg').textContent = '';
  let config;
  try { config = buildRunConfig(); } catch (e) { $('schMsg').textContent = e.message; return; }
  const recur = { type: schType, time: $('schTime').value || '02:00' };
  if (schType === 'once') {
    if (!$('schDate').value) { $('schMsg').textContent = 'Pick a date.'; return; }
    recur.date = $('schDate').value;
  }
  if (schType === 'weekly') {
    recur.days = [...document.querySelectorAll('#schDays input:checked')].map((i) => +i.value);
    if (!recur.days.length) { $('schMsg').textContent = 'Pick at least one day.'; return; }
  }
  try {
    await api('POST', '/api/schedules', { name: $('schName').value.trim() || 'Scheduled run', planId: state.plan.id, planName: state.plan.name, config, recur });
    closeScheduleModal();
    showView('schedule');
  } catch (e) { $('schMsg').textContent = e.message; }
};

function recurText(r) {
  if (!r) return '';
  const t = r.time || '';
  if (r.type === 'daily') return `Daily at ${t}`;
  if (r.type === 'once') return `Once on ${r.date} at ${t}`;
  if (r.type === 'weekly') {
    const names = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `Weekly · ${(r.days || []).slice().sort((a, b) => a - b).map((d) => names[d]).join(', ')} at ${t}`;
  }
  return '';
}
function relTime(iso) {
  if (!iso) return '—';
  const ms = new Date(iso) - new Date();
  if (ms <= 0) return 'due now';
  const m = Math.round(ms / 60000);
  if (m < 60) return `in ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `in ${h}h ${m % 60}m`;
  return `in ${Math.floor(h / 24)}d ${h % 24}h`;
}
function schCard(s) {
  const last = s.lastRun;
  const lastBadge = last
    ? `<span class="sch-last ${last.status}">${last.status}</span>${last.detail ? ` <span class="hint">${esc(last.detail)}</span>` : ''} <span class="hint">${fmt.dt(last.at)}</span>`
    : '<span class="hint">never run yet</span>';
  return `<div class="card sched-card ${s.enabled ? '' : 'off'}" data-id="${esc(s.id)}">
    <div class="sched-main">
      <div class="sched-info">
        <div class="sched-name">${esc(s.name)}${s.enabled ? '' : ' <span class="sch-paused">paused</span>'}</div>
        <div class="sched-sub">${esc(s.planName || 'plan')}${s.config && s.config.agents ? ` · ${s.config.agents.length} agent${s.config.agents.length > 1 ? 's' : ''}` : ''}</div>
      </div>
      <label class="switch" title="${s.enabled ? 'Enabled — click to pause' : 'Paused — click to enable'}"><input type="checkbox" class="sch-toggle" ${s.enabled ? 'checked' : ''}><span class="slider"></span></label>
    </div>
    <div class="sched-meta">
      <span class="sched-chip">${ic('calendar')} ${esc(recurText(s.recur))}</span>
      <span class="sched-chip">${ic('clock')} next run: <b>${s.enabled && s.nextRun ? `${fmt.dt(s.nextRun)} · ${relTime(s.nextRun)}` : '—'}</b></span>
    </div>
    <div class="sched-foot">
      <div class="sched-last">${lastBadge}</div>
      <div class="sched-actions">
        <button class="ghost mini sch-run">▶ Run now</button>
        <button class="ghost mini sch-del">Delete</button>
      </div>
    </div>
  </div>`;
}
async function loadSchedules() {
  let list = [];
  try { list = await api('GET', '/api/schedules'); } catch { /* empty */ }
  $('schSub').textContent = `${list.length} schedule${list.length === 1 ? '' : 's'}`;
  if (!list.length) {
    $('schList').innerHTML = `<div class="card"><p class="empty">No schedules yet. Set up a run on <b>New Run</b>, then click <b>Schedule this run…</b> in the action panel.</p></div>`;
    return;
  }
  $('schList').innerHTML = list.map(schCard).join('');
  document.querySelectorAll('.sched-card').forEach((card) => {
    const id = card.dataset.id;
    card.querySelector('.sch-toggle').onchange = async (e) => {
      try { await api('PATCH', `/api/schedules/${id}`, { enabled: e.target.checked }); } catch (err) { alert(err.message); }
      loadSchedules();
    };
    card.querySelector('.sch-run').onclick = async () => {
      try { await api('POST', `/api/schedules/${id}/run`); showView('live'); }
      catch (err) { alert(`Could not run now: ${err.message}`); }
    };
    card.querySelector('.sch-del').onclick = async () => {
      if (!confirm('Delete this schedule?')) return;
      try { await api('DELETE', `/api/schedules/${id}`); } catch (err) { alert(err.message); }
      loadSchedules();
    };
  });
}
$('schRefresh').onclick = () => loadSchedules();

// ---------------- live view ----------------

const isActiveRun = (run) => !!run && ['preparing', 'running', 'finalizing'].includes(run.state);
const isEndedRun = (run) => !!run && ['finished', 'done', 'stopped', 'error'].includes(run.state);

// Planned length in seconds when the plan says so: duration-based groups and
// bzm rate groups (ramp + hold). Loop-based groups have no fixed length → null.
function plannedRunSec(run) {
  const c = run && run.config;
  if (!c) return null;
  const tgs = c.mode === 'per-agent'
    ? Object.values(c.agentConfigs || {}).flatMap((ac) => ac.threadGroups || [])
    : (c.threadGroups || []);
  let max = 0;
  for (const t of tgs) {
    if (t.enabled === false) continue;
    if (t.mode === 'duration' && t.duration) max = Math.max(max, Number(t.duration));
    else if (t.hold != null && t.mode == null) max = Math.max(max, (Number(t.rampUp) || 0) + (Number(t.hold) || 0));
  }
  return max || null;
}

function liveElapsedSec() {
  if (!state.live) return null;
  if (state.run && state.run.state === 'running' && state.live.startedTs) return (Date.now() - state.live.startedTs) / 1000;
  return state.live.elapsedSec;
}

// Elapsed clock + progress — ticks every second while a run is active (wall time
// since the first sample) and freezes at the sample-span duration once it ends.
function renderLiveProgress() {
  const run = state.run;
  if (!run || !$('liveProgress')) return;
  const sec = liveElapsedSec();
  $('liveProgress').hidden = sec == null;
  if (sec == null) return;
  $('tElapsed').textContent = durHuman(sec);
  const planned = plannedRunSec(run);
  const ended = isEndedRun(run);
  const pct = ended ? 100 : planned ? Math.min(100, (100 * sec) / planned) : null;
  $('liveBarWrap').classList.toggle('indeterminate', pct == null);
  $('liveBar').style.width = pct == null ? '' : `${pct}%`;
  $('liveBarWrap').setAttribute('aria-valuenow', pct == null ? '' : String(Math.round(pct)));
  $('liveLeft').textContent = ended ? `${RESULT_LABEL[runResult(run)][0]} at ${run.endedAt ? timeOnly(run.endedAt) : '—'}`
    : run.state === 'finalizing' ? 'Collecting results from the agents…'
      : planned ? (sec < planned ? `About ${durHuman(planned - sec)} left` : 'Finishing — waiting for the last requests')
        : 'Runs until every loop is done';
}
setInterval(renderLiveProgress, 1000);

function resetLiveView() {
  $('log').textContent = '';
  state.live = null;
  state.livePeakTps = 0;
  ['tElapsed', 'tTps', 'tAvg', 'tErr', 'tTotal'].forEach((id) => ($(id).textContent = '–'));
  ['tTpsSub', 'tAvgSub', 'tErrSub', 'tTotalSub'].forEach((id) => ($(id).textContent = ''));
  $('tErrTile').classList.remove('bad');
  $('labelRows').innerHTML = '';
  const cont = $('lazCharts');
  if (cont) { cont._sig = null; cont.innerHTML = '<p class="empty">Waiting for samples…</p>'; }
}

function onRunUpdate(run) {
  const changed = !state.run || state.run.id !== run.id || state.run.state !== run.state;
  // a different run has started (here, from a schedule or another browser):
  // clear the previous run's numbers, charts and log first
  if (state.run && state.run.id !== run.id && isActiveRun(run)) resetLiveView();
  state.run = run;
  if (changed && $('view-home').classList.contains('active')) loadHome();
  const liveBadge = $('navLiveBadge');
  if (liveBadge) liveBadge.hidden = !isActiveRun(run);
  renderLiveHead();
  renderLiveAgents();

  const tgSel = $('liveTg');
  const kept = tgSel.value;
  const names = run.tgNames || [];
  tgSel.innerHTML = '<option value="">All thread groups</option>' +
    names.map((n) => `<option value="${esc(n)}" ${n === kept ? 'selected' : ''}>${esc(n)}</option>`).join('');
  renderLiveTgPills();

  const ended = isEndedRun(run);
  if (ended && state.lastLoggedEnd !== run.id) {
    state.lastLoggedEnd = run.id;
    appendLog(`run ${run.state}. Open "full results" for the complete report${run.hasReport ? ' and the JMeter dashboard' : ''}.`);
    loadFinalIntoLive(run.id, $('liveTg').value);
  }
}

function renderLiveHead() {
  const run = state.run;
  if (!run) return;
  const badge = run.state === 'preparing' ? '<span class="rbadge live">Starting</span>'
    : run.state === 'finalizing' ? '<span class="rbadge live">Finishing</span>' : resultBadge(run);
  $('liveTitle').innerHTML = `${esc(run.planName || 'Run')} ${badge}`;
  const agents = run.agents || [];
  const mode = run.config && run.config.mode === 'per-agent' ? 'per-agent profiles' : 'split evenly';
  const target = (run.targets || [])[0];
  $('liveMeta').innerHTML = `Started ${esc(fmt.dt(run.createdAt))} · ${agents.length} agent${agents.length === 1 ? '' : 's'} · ${mode}${target ? ` · target <b>${esc(target)}</b>` : ''}`;
  const ended = isEndedRun(run);
  $('stopBtn').hidden = run.state !== 'running';
  if (run.state !== 'running') $('stopConfirm').hidden = true;
  $('liveOpenRun').hidden = !ended;
  $('liveOpenRun').href = `#run/${encodeURIComponent(run.id)}`;
  $('stopConfirmText').textContent = `All ${agents.length} agent${agents.length === 1 ? '' : 's'} stop within a few seconds. Results collected so far are kept and marked as stopped.`;
  const vu = runVUsers(run);
  $('tUsers').textContent = vu != null ? fmt.n(vu) : '–';
  $('tUsersSub').textContent = vu && agents.length > 1 && !(run.config && run.config.mode === 'per-agent')
    ? `≈ ${fmt.n(Math.round(vu / agents.length))} on each agent` : 'Configured for this run';
  renderLiveProgress();
}

// Thread-group filter as pills (drives the hidden #liveTg select)
function renderLiveTgPills() {
  const sel = $('liveTg');
  const opts = [...sel.options];
  $('liveTgBar').hidden = opts.length <= 2; // "All" + one group → nothing to filter
  $('liveTgPills').innerHTML = opts.map((o) => `<button type="button" class="pill${o.value === sel.value ? ' on' : ''}" data-v="${esc(o.value)}" aria-pressed="${o.value === sel.value}">${esc(o.value ? o.textContent : 'All groups')}</button>`).join('');
  $('liveTgPills').querySelectorAll('.pill').forEach((b) => (b.onclick = () => {
    sel.value = b.dataset.v;
    sel.dispatchEvent(new Event('change'));
    renderLiveTgPills();
  }));
}

function setLiveTiles(src, kind) {
  // kind: 'window' (last 10 s while running) | 'run' (whole stored run)
  const errPct = kind === 'run' ? src.errorPct : src.errPct;
  $('tTps').textContent = `${kind === 'run' ? src.throughput : src.tps} req/s`;
  $('tAvg').textContent = msHuman(src.avg);
  $('tErr').textContent = `${errPct}%`;
  $('tErrTile').classList.toggle('bad', errPct > 0);
  $('tTpsSub').textContent = kind === 'run' ? 'Whole run' : `Last 10 s${state.livePeakTps ? ` · peak ${state.livePeakTps} req/s` : ''}`;
  $('tAvgSub').textContent = kind === 'run' ? 'Whole run' : 'Last 10 s';
}

/**
 * Fill the Live page with a finished run's stored results — covers runs so
 * short they ended between live broadcasts, and page loads after the run.
 */
async function loadFinalIntoLive(id, tg = '') {
  try {
    const q = tg ? `?tg=${encodeURIComponent(tg)}` : '';
    let s;
    if (tg) {
      s = await api('GET', `/api/runs/${id}/summary${q}`);
    } else {
      const r = await api('GET', `/api/runs/${id}`);
      s = r.summary;
    }
    if (!s || !s.overall || !s.overall.samples) return;
    if (!tg && state.run && state.run.id === id) { state.run.overall = s.overall; renderLiveHead(); } // SLA verdict in the badge
    if (!state.live) state.live = { elapsedSec: s.durationSec };
    $('tElapsed').textContent = durHuman(s.durationSec);
    setLiveTiles(s.overall, 'run');
    $('tErrSub').textContent = `${fmt.n(s.overall.errors)} failed`;
    $('tTotal').textContent = fmt.n(s.overall.samples);
    $('tTotalSub').textContent = 'Whole run';
    renderLabelRows(s.perLabel);
    const td = await api('GET', `/api/runs/${id}/timeline-detail${q}`);
    const cont = $('lazCharts');
    if (cont && td.t && td.t.length) {
      const vu = state.run ? runVUsers(state.run) : null;
      const rk = state.run ? state.run.rateKind : null;
      cont._sig = td.labels.join('|');
      cont.innerHTML = azChartsHtml('laz', td, s, vu, rk);
      azChartsDraw('laz', td, vu, rk);
    }
    renderLiveProgress();
  } catch { /* no stored results (e.g. failed before samples) */ }
}

function renderLabelRows(perLabel) {
  $('labelRows').innerHTML = perLabel.slice().sort((a, b) => b.samples - a.samples)
    .map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${fmt.n(r.samples)}</td>
      <td class="num${r.errors ? ' err-txt' : ''}">${fmt.n(r.errors)}</td>
      <td class="num">${fmt.tp(r.throughput)}</td>
      <td class="num">${fmt.n(r.avg)}</td><td class="num">${fmt.n(r.max)}</td></tr>`).join('');
}

$('stopBtn').onclick = () => { $('stopConfirm').hidden = false; $('stopCancel').focus(); };
$('stopCancel').onclick = () => { $('stopConfirm').hidden = true; $('stopBtn').focus(); };
$('stopYes').onclick = async () => {
  $('stopYes').disabled = true;
  try { await api('POST', `/api/runs/${state.run.id}/stop`); appendLog('stop requested — agents are stopping…'); } catch (e) { appendLog(`stop failed: ${e.message}`); }
  $('stopYes').disabled = false;
  $('stopConfirm').hidden = true;
};
$('liveOpenRun').onclick = (e) => {
  if (e.ctrlKey || e.metaKey || e.shiftKey || !state.run) return;
  e.preventDefault();
  openRun(state.run.id);
};

/** One row per agent: its own test time, avg latency, live CPU/RAM, and flags. */
function renderLiveAgents() {
  const run = state.run;
  if (!run) return;
  const liveElapsed = (state.live && state.live.agentElapsed) || {};
  const avgMs = (state.live && state.live.agentAvgMs) || {};
  // slowest-vs-fastest: an agent whose avg latency is a wild outlier is almost
  // always a bad network path to the target, not real load.
  const vals = Object.values(avgMs).filter((v) => v > 0);
  const fastest = vals.length ? Math.min(...vals) : 0;
  const isSlow = (name) => avgMs[name] > 0 && fastest > 0 && avgMs[name] >= 5 * fastest && avgMs[name] - fastest > 1000;
  const resByName = new Map((state.agents || []).map((x) => [x.name, x.res]));
  const STATE_TXT = { running: ['Running', 'live'], done: ['Done', 'ok'], finished: ['Done', 'ok'], error: ['Error', 'bad'], stopped: ['Stopped', 'neutral'] };
  let maxed = 0;
  $('liveAgents').innerHTML = (run.agents || []).map((a) => {
    const sec = liveElapsed[a.name] != null ? liveElapsed[a.name] : a.durationSec;
    const slow = isSlow(a.name);
    const res = resByName.get(a.name);
    const saturated = a.state === 'running' && res && (res.cpu >= 90 || res.mem >= 90);
    if (saturated) maxed++;
    const [st, cls] = STATE_TXT[a.state] || [a.state || '—', 'neutral'];
    const notes = [
      saturated ? `<span class="slow-badge">${ic('warn')} PC near its CPU/RAM limit — results may be skewed</span>` : '',
      slow ? `<span class="slow-badge" title="Average response ${fmt.n(avgMs[a.name])} ms vs ${fmt.n(fastest)} ms on the fastest agent">${ic('warn')} Slow network path to the target</span>` : '',
      a.error ? `<span class="err-txt">${esc(a.error)}</span>` : '',
      a.note && !a.error ? `<span class="hint" style="margin:0">${esc(a.note)}</span>` : '',
    ].filter(Boolean).join(' ');
    return `<tr${slow || saturated ? ' class="agent-slow"' : ''}>
      <td><b>${esc(a.name)}</b></td>
      <td><span class="rbadge ${cls}">${esc(st)}</span></td>
      <td class="num">${sec != null ? durHuman(sec) : '–'}</td>
      <td class="num">${avgMs[a.name] != null ? msHuman(avgMs[a.name]) : '–'}</td>
      <td>${a.state === 'running' ? resMeter(res, a.name) : '<span class="hint" style="margin:0">—</span>'}</td>
      <td>${notes || '<span class="hint" style="margin:0">—</span>'}</td>
    </tr>`;
  }).join('');
  $('liveAgentWarn').hidden = !maxed;
  $('liveAgentWarn').textContent = maxed ? `${maxed} agent${maxed === 1 ? '' : 's'} near the CPU or RAM limit` : '';
}

$('liveTg').onchange = () => {
  const ended = state.run && isEndedRun(state.run);
  // After a run ends, filter from the stored results (live snapshots are gone
  // after a page reload); during a run, use the streaming per-group stats.
  if (ended) loadFinalIntoLive(state.run.id, $('liveTg').value);
  else renderLive();
};

function renderLive() {
  if (!state.live || !state.live.window) return;
  // A selected thread group swaps in that group's snapshot (same shape).
  const sel = $('liveTg').value;
  const l = sel && state.live.byTg && state.live.byTg[sel] ? state.live.byTg[sel] : state.live;
  if (!sel) state.livePeakTps = Math.max(state.livePeakTps || 0, l.window.tps || 0);
  setLiveTiles(l.window, 'window');
  $('tErrSub').textContent = `Last 10 s · ${fmt.n(l.totalErrors || 0)} failed in total`;
  $('tTotal').textContent = fmt.n(l.totalSamples);
  $('tTotalSub').textContent = state.live.startedTs ? `Since ${new Date(state.live.startedTs).toLocaleTimeString('en-GB')}` : '';

  // per-sampler live charts — rebuild the structure only when the sampler set
  // changes, otherwise just repaint the canvases (cheap, every tick).
  const bl = l.byLabel;
  const cont = $('lazCharts');
  if (cont && bl && bl.labels && bl.labels.length && bl.t.length) {
    const td = { t: bl.t, labels: bl.labels, series: bl.series, threads: null };
    const vu = state.run ? runVUsers(state.run) : null;
    const rk = state.run ? state.run.rateKind : null;
    const sig = bl.labels.join('|') + '|' + (rk || '');
    if (cont._sig !== sig) { cont._sig = sig; cont.innerHTML = azChartsHtml('laz', td, null, vu, rk); }
    azChartsDraw('laz', td, vu, rk);
  }
  renderLabelRows(l.perLabel);
  renderLiveProgress();
}


function appendLog(line) {
  const el = $('log');
  el.textContent += line + '\n';
  el.scrollTop = el.scrollHeight;
}

// ---------------- multi-series area / line chart (dashboard) ----------------
// A distinct renderer from drawChart(): supports many series (one per sampler)
// with a fixed colour palette, an optional STACKED-AREA mode (requests/sec,
// errors) and a shared crosshair tooltip. Series values are index-aligned to a
// single `t` (seconds) axis.

const SERIES_PALETTE = ['#4f6ef7', '#8b5cf6', '#ec4899', '#14b8a6', '#f59e0b', '#ef4444', '#0ea5e9', '#a3e635', '#f472b6', '#94a3b8'];
function labelColor(i) { return SERIES_PALETTE[i % SERIES_PALETTE.length]; }
function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

function drawArea(canvas, cfg) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const padL = 46, padR = 10, padT = 8, padB = 20;
  const plotW = w - padL - padR, plotH = h - padT - padB;
  const t = cfg.t || [], series = cfg.series || [];
  canvas._area = { cfg, padL, padR, padT, padB, w, h };
  if (!t.length || !series.length) {
    ctx.fillStyle = css('--muted'); ctx.font = '12px system-ui'; ctx.textAlign = 'center';
    ctx.fillText('no data', w / 2, h / 2); return;
  }

  let vMax = 1;
  if (cfg.stacked) {
    for (let i = 0; i < t.length; i++) { let s = 0; for (const se of series) s += (se.values[i] || 0); if (s > vMax) vMax = s; }
  } else {
    for (const se of series) for (const v of se.values) if (v > vMax) vMax = v;
  }
  vMax = niceMax(vMax);
  const x = (i) => padL + (t.length === 1 ? plotW / 2 : (i / (t.length - 1)) * plotW);
  const y = (v) => padT + plotH - (v / vMax) * plotH;
  canvas._area.scale = { x, y, n: t.length };

  ctx.strokeStyle = css('--grid'); ctx.fillStyle = css('--muted'); ctx.lineWidth = 1; ctx.font = '11px system-ui'; ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) { const v = (vMax / 4) * i, yy = y(v); ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke(); ctx.fillText(fmt.n(Math.round(v)), padL - 6, yy + 4); }
  ctx.textAlign = 'center';
  for (let i = 0; i <= 3; i++) { const idx = Math.round((t.length - 1) * i / 3); ctx.fillText(fmt.time(t[idx]), x(idx), h - 5); }
  ctx.strokeStyle = css('--baseline'); ctx.beginPath(); ctx.moveTo(padL, y(0)); ctx.lineTo(w - padR, y(0)); ctx.stroke();

  if (cfg.stacked) {
    const cum = new Array(t.length).fill(0);
    for (const se of series) {
      ctx.beginPath();
      for (let i = 0; i < t.length; i++) { const yy = y(cum[i] + (se.values[i] || 0)); i ? ctx.lineTo(x(i), yy) : ctx.moveTo(x(i), yy); }
      for (let i = t.length - 1; i >= 0; i--) ctx.lineTo(x(i), y(cum[i]));
      ctx.closePath();
      ctx.fillStyle = hexA(se.color, 0.72); ctx.fill();
      ctx.strokeStyle = se.color; ctx.lineWidth = 1.2; ctx.beginPath();
      for (let i = 0; i < t.length; i++) { const yy = y(cum[i] + (se.values[i] || 0)); i ? ctx.lineTo(x(i), yy) : ctx.moveTo(x(i), yy); }
      ctx.stroke();
      for (let i = 0; i < t.length; i++) cum[i] += (se.values[i] || 0);
    }
  } else {
    for (const se of series) {
      ctx.strokeStyle = se.color; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.beginPath();
      for (let i = 0; i < t.length; i++) { const yy = y(se.values[i] || 0); i ? ctx.lineTo(x(i), yy) : ctx.moveTo(x(i), yy); }
      ctx.stroke();
      if (t.length <= 2) { ctx.fillStyle = se.color; for (let i = 0; i < t.length; i++) { ctx.beginPath(); ctx.arc(x(i), y(se.values[i] || 0), 3.5, 0, 7); ctx.fill(); } }
    }
  }

  if (cfg.tip && !canvas._areaHover) {
    canvas._areaHover = true;
    canvas.addEventListener('mousemove', (e) => areaHover(canvas, e));
    canvas.addEventListener('mouseleave', () => { cfg.tip.style.display = 'none'; drawArea(canvas, canvas._area.cfg); });
  }
}

function areaHover(canvas, e) {
  const a = canvas._area;
  if (!a || !a.scale) return;
  const { cfg, scale } = a;
  const mx = e.clientX - canvas.getBoundingClientRect().left;
  let bi = 0, bd = Infinity;
  for (let i = 0; i < scale.n; i++) { const d = Math.abs(scale.x(i) - mx); if (d < bd) { bd = d; bi = i; } }
  drawArea(canvas, cfg);
  const ctx = canvas.getContext('2d');
  const xx = scale.x(bi);
  ctx.strokeStyle = css('--baseline'); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(xx, a.padT); ctx.lineTo(xx, a.h - a.padB); ctx.stroke(); ctx.setLineDash([]);
  const rows = cfg.series
    .map((se) => ({ se, v: se.values[bi] || 0 }))
    .filter((r, i) => r.v > 0 || cfg.series.length <= 4 || i === 0)
    .map((r) => `<span class="sw" style="background:${r.se.color}"></span>${esc(r.se.name)}: <b>${fmt.n(r.v)}${cfg.unit || ''}</b>`);
  const tip = cfg.tip;
  tip.innerHTML = `${fmt.time(cfg.t[bi])}<br>${rows.join('<br>') || 'no samples'}`;
  tip.style.display = 'block';
  const box = canvas.parentElement.getBoundingClientRect();
  tip.style.left = Math.min(e.clientX - box.left + 14, box.width - 170) + 'px';
  tip.style.top = (e.clientY - box.top - 10) + 'px';
}

// ---------------- canvas chart (2px lines, hairline grid, crosshair tooltip) ----------------

/** Series colors may be a CSS var name ('--accent') — resolved at paint time so theme switches repaint correctly. */
function paint(c) {
  return c && c.startsWith('--') ? css(c) : c;
}

function drawChart(canvas, series, opts = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const padL = 44, padR = 10, padT = 8, padB = 20;
  const plotW = w - padL - padR, plotH = h - padT - padB;

  const allPts = series.flatMap((s) => s.points);
  canvas._chart = { series, padL, padR, padT, padB, w, h, opts };
  if (!allPts.length) {
    ctx.fillStyle = css('--muted');
    ctx.font = '12px system-ui';
    ctx.textAlign = 'center';
    ctx.fillText('waiting for samples…', w / 2, h / 2);
    return;
  }

  const t0 = Math.min(...allPts.map((p) => p.t));
  const t1 = Math.max(...allPts.map((p) => p.t));
  const vMax = niceMax(Math.max(1, ...allPts.map((p) => p.v)));
  const x = (t) => padL + (t1 === t0 ? plotW / 2 : ((t - t0) / (t1 - t0)) * plotW);
  const y = (v) => padT + plotH - (v / vMax) * plotH;
  canvas._chart.scale = { t0, t1, vMax, x, y };

  // hairline grid + y labels
  ctx.strokeStyle = css('--grid');
  ctx.fillStyle = css('--muted');
  ctx.lineWidth = 1;
  ctx.font = '11px system-ui';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const v = (vMax / 4) * i, yy = y(v);
    ctx.beginPath(); ctx.moveTo(padL, yy); ctx.lineTo(w - padR, yy); ctx.stroke();
    ctx.fillText(fmt.n(Math.round(v)), padL - 6, yy + 4);
  }
  // x time labels
  ctx.textAlign = 'center';
  for (let i = 0; i <= 3; i++) {
    const t = t0 + ((t1 - t0) / 3) * i;
    ctx.fillText(fmt.time(t), x(t), h - 5);
  }
  // baseline
  ctx.strokeStyle = css('--baseline');
  ctx.beginPath(); ctx.moveTo(padL, y(0)); ctx.lineTo(w - padR, y(0)); ctx.stroke();

  // series lines (2px); very short runs may have 1-2 points — a line would be
  // invisible, so draw markers instead
  for (const s of series) {
    ctx.strokeStyle = paint(s.color);
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.beginPath();
    s.points.forEach((p, i) => (i ? ctx.lineTo(x(p.t), y(p.v)) : ctx.moveTo(x(p.t), y(p.v))));
    ctx.stroke();
    if (s.points.length <= 2) {
      ctx.fillStyle = paint(s.color);
      for (const p of s.points) {
        ctx.beginPath();
        ctx.arc(x(p.t), y(p.v), 4, 0, 7);
        ctx.fill();
      }
    }
  }

  if (opts.tip && !canvas._hoverBound) {
    canvas._hoverBound = true;
    canvas.addEventListener('mousemove', (e) => chartHover(canvas, e));
    canvas.addEventListener('mouseleave', () => { opts.tip.style.display = 'none'; redraw(canvas); });
  }
}

function redraw(canvas) {
  const c = canvas._chart;
  if (c) drawChart(canvas, c.series, c.opts);
}

function chartHover(canvas, e) {
  const c = canvas._chart;
  if (!c || !c.scale) return;
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left;
  const pts = c.series[0] ? c.series[0].points : [];
  if (!pts.length) return;
  let best = pts[0];
  for (const p of pts) if (Math.abs(c.scale.x(p.t) - mx) < Math.abs(c.scale.x(best.t) - mx)) best = p;

  redraw(canvas);
  const ctx = canvas.getContext('2d');
  const xx = c.scale.x(best.t);
  ctx.strokeStyle = css('--baseline');
  ctx.lineWidth = 1;
  ctx.setLineDash([3, 3]);
  ctx.beginPath(); ctx.moveTo(xx, c.padT); ctx.lineTo(xx, c.h - c.padB); ctx.stroke();
  ctx.setLineDash([]);

  const rows = c.series.map((s) => {
    const p = s.points.find((q) => q.t === best.t);
    ctx.beginPath();
    if (p) { ctx.fillStyle = paint(s.color); ctx.arc(c.scale.x(p.t), c.scale.y(p.v), 4, 0, 7); ctx.fill(); }
    return `<span class="sw" style="background:${paint(s.color)}"></span>${s.name}: <b>${p ? fmt.n(p.v) : '–'}${c.opts.unit || ''}</b>`;
  });
  const tip = c.opts.tip;
  tip.innerHTML = `${fmt.time(best.t)}<br>${rows.join('<br>')}`;
  tip.style.display = 'block';
  const box = canvas.parentElement.getBoundingClientRect();
  tip.style.left = Math.min(e.clientX - box.left + 14, box.width - 150) + 'px';
  tip.style.top = (e.clientY - box.top - 10) + 'px';
}

function niceMax(v) {
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  for (const m of [1, 2, 2.5, 5, 10]) if (v <= m * mag) return m * mag;
  return 10 * mag;
}

// ---------------- runs: one list of every run (replaces Dashboard + History) ----------------

const runsState = { runs: [], q: '', plan: '', target: '', result: '', period: '', page: 0, sel: new Set(), bound: false };
const RUNS_PAGE = 50;

// "26 s", "2 m 53 s", "1 h 4 m" — easier to scan than 00:02:53 in lists and headers
function durHuman(sec) {
  if (sec == null) return '–';
  const s = Math.max(0, Math.round(sec));
  if (s < 60) return `${s} s`;
  if (s < 3600) return `${Math.floor(s / 60)} m${s % 60 ? ` ${s % 60} s` : ''}`;
  const m = Math.floor((s % 3600) / 60);
  return `${Math.floor(s / 3600)} h${m ? ` ${m} m` : ''}`;
}
// big response times read better in seconds: 125,159 ms → 125.2 s
function msHuman(v) {
  if (v == null) return '–';
  return v >= 10000 ? `${(v / 1000).toFixed(1)} s` : fmt.ms(v);
}

// One verdict per run, used by the list, the filters and the run page.
function runResult(r) {
  if (['running', 'finalizing', 'preparing'].includes(r.state)) return 'running';
  if (r.state === 'error') return 'error';
  if (r.state === 'stopped') return 'stopped';
  return slaVerdict(r) || 'done';
}
const RESULT_LABEL = {
  pass: ['Passed', 'ok'], fail: ['Failed SLA', 'bad'], done: ['Finished', 'neutral'],
  stopped: ['Stopped', 'neutral'], error: ['Error', 'bad'], running: ['Running', 'live'],
};
function resultBadge(r) {
  const [text, cls] = RESULT_LABEL[runResult(r)];
  return `<span class="rbadge ${cls}">${text}</span>`;
}

function kpiCard(c) {
  return `<div class="kpi ${c.tone || ''}">
    <div class="kpi-k">${c.k}</div>
    <div class="kpi-v">${c.v}</div>
    ${c.sub ? `<div class="kpi-sub">${c.sub}</div>` : ''}
  </div>`;
}

function fillSelect(id, allLabel, values, cur) {
  $(id).innerHTML = `<option value="">${allLabel}</option>` +
    values.map((v) => `<option value="${esc(v)}" ${v === cur ? 'selected' : ''}>${esc(v)}</option>`).join('');
}

async function loadRuns() {
  if (!runsState.bound) {
    runsState.bound = true;
    const bind = (id, key, ev) => $(id).addEventListener(ev || 'change', () => {
      runsState[key] = $(id).value.trim(); runsState.page = 0; renderRuns();
    });
    bind('runsQ', 'q', 'input'); bind('runsPlan', 'plan'); bind('runsTarget', 'target');
    bind('runsResult', 'result'); bind('runsPeriod', 'period');
    $('runsPrev').onclick = () => { runsState.page--; renderRuns(); };
    $('runsNext').onclick = () => { runsState.page++; renderRuns(); };
    $('runsSelAll').onchange = () => {
      const on = $('runsSelAll').checked;
      pageRuns().forEach((r) => (on ? runsState.sel.add(r.id) : runsState.sel.delete(r.id)));
      renderRuns();
    };
    $('runsCompare').onclick = compareSelected;
    $('runsDelete').onclick = deleteSelectedRuns;
    $('cmpClose').onclick = () => { $('runsCompareCard').hidden = true; };
  }
  await ensureSla();
  try { runsState.runs = await api('GET', '/api/runs'); } catch { runsState.runs = []; }
  const ids = new Set(runsState.runs.map((r) => r.id));
  [...runsState.sel].forEach((id) => { if (!ids.has(id)) runsState.sel.delete(id); });
  fillSelect('runsPlan', 'All plans', [...new Set(runsState.runs.map((r) => r.planName).filter(Boolean))].sort(), runsState.plan);
  // web address = the PRIMARY app each run tested (not incidental dependencies)
  fillSelect('runsTarget', 'All web addresses', [...new Set(runsState.runs.map((r) => (r.targets || [])[0]).filter(Boolean))].sort(), runsState.target);
  renderRuns();
}

function runsFiltered() {
  const s = runsState;
  const q = s.q.toLowerCase();
  const since = !s.period ? null
    : s.period === '1' ? new Date(new Date().setHours(0, 0, 0, 0))
      : new Date(Date.now() - Number(s.period) * 864e5);
  return s.runs.filter((r) =>
    (!s.plan || r.planName === s.plan) &&
    (!s.target || (r.targets || [])[0] === s.target) &&
    (!s.result || runResult(r) === s.result) &&
    (!since || new Date(r.createdAt) >= since) &&
    (!q || `${r.planName || ''} ${r.id} ${(r.targets || []).join(' ')}`.toLowerCase().includes(q)));
}
function pageRuns() {
  return runsFiltered().slice(runsState.page * RUNS_PAGE, (runsState.page + 1) * RUNS_PAGE);
}

function renderRuns() {
  const all = runsFiltered();
  const pages = Math.max(1, Math.ceil(all.length / RUNS_PAGE));
  runsState.page = Math.min(Math.max(0, runsState.page), pages - 1);
  const start = runsState.page * RUNS_PAGE;
  const rows = all.slice(start, start + RUNS_PAGE);
  const perDay = {};
  for (const r of all) perDay[dayKey(r.createdAt)] = (perDay[dayKey(r.createdAt)] || 0) + 1;

  const rowHtml = (r) => {
    const o = r.overall;
    const users = runVUsers(r);
    const on = runsState.sel.has(r.id);
    const target = (r.targets || [])[0];
    return `<tr data-id="${esc(r.id)}"${on ? ' class="sel"' : ''}>
      <td class="sel-col"><input type="checkbox" class="runSel" data-id="${esc(r.id)}" ${on ? 'checked' : ''} aria-label="Select the run started ${esc(fmt.dt(r.createdAt))}"></td>
      <td class="run-time">${timeOnly(r.createdAt)}</td>
      <td><a class="run-link" href="#run/${encodeURIComponent(r.id)}">${esc(r.planName || r.id)}</a>${target ? `<span class="run-target" title="${esc(runTargetTitle(r))}">${esc(target)}</span>` : ''}</td>
      <td>${resultBadge(r)}</td>
      <td class="num">${durHuman(r.durationSec)}</td>
      <td class="num">${users != null ? fmt.n(users) : '–'}</td>
      <td class="num">${o ? fmt.n(o.samples) : '–'}</td>
      <td class="num${o && o.errorPct > 0 ? ' err-txt' : ''}">${o ? `${o.errorPct}%` : '–'}</td>
      <td class="num">${o ? fmt.tp(o.throughput) : '–'}</td>
    </tr>`;
  };
  let html = '', lastDay = null;
  for (const r of rows) {
    const dk = dayKey(r.createdAt);
    if (dk !== lastDay) {
      lastDay = dk;
      html += `<tr class="date-row"><td colspan="9">${esc(dayLabel(r.createdAt))} <span class="date-count">· ${perDay[dk]} run${perDay[dk] > 1 ? 's' : ''}</span></td></tr>`;
    }
    html += rowHtml(r);
  }
  $('runsRows').innerHTML = html;
  $('runsEmpty').hidden = all.length > 0;

  const fails = all.filter((r) => runResult(r) === 'fail').length;
  $('runsSummary').textContent = all.length
    ? `${fmt.n(all.length)} run${all.length === 1 ? '' : 's'}${fails ? ` · ${fails} failed SLA` : ''} · tick two runs to compare them side by side`
    : '';
  $('runsPageInfo').textContent = all.length
    ? `Showing ${fmt.n(start + 1)}–${fmt.n(start + rows.length)} of ${fmt.n(all.length)}, newest first` : '';
  $('runsPrev').disabled = runsState.page === 0;
  $('runsNext').disabled = runsState.page >= pages - 1;
  $('runsSelAll').checked = rows.length > 0 && rows.every((r) => runsState.sel.has(r.id));
  updateRunsBar();

  $('runsRows').querySelectorAll('tr[data-id]').forEach((tr) => {
    tr.onclick = (e) => {
      if (e.target.closest('.sel-col') || e.target.closest('a')) return; // checkbox / real link handle themselves
      openRun(tr.dataset.id);
    };
  });
  $('runsRows').querySelectorAll('.runSel').forEach((cb) => {
    cb.onchange = () => {
      if (cb.checked) runsState.sel.add(cb.dataset.id); else runsState.sel.delete(cb.dataset.id);
      cb.closest('tr').classList.toggle('sel', cb.checked);
      updateRunsBar();
    };
  });
  $('runsRows').querySelectorAll('.run-link').forEach((a) => {
    a.onclick = (e) => {
      if (e.ctrlKey || e.metaKey || e.shiftKey || e.button) return; // let the browser open a new tab
      e.preventDefault();
      openRun(a.closest('tr').dataset.id);
    };
  });
}

function updateRunsBar() {
  const n = runsState.sel.size;
  $('runsCompare').textContent = `Compare selected (${n})`;
  $('runsCompare').disabled = n !== 2;
  $('runsCompare').title = n === 2 ? '' : 'Tick exactly two runs to compare them';
  $('runsDelete').hidden = n === 0;
  $('runsDelete').textContent = `Delete selected (${n})`;
}

function compareSelected() {
  const picked = [...runsState.sel].map((id) => runsState.runs.find((r) => r.id === id)).filter(Boolean);
  if (picked.length !== 2) return;
  picked.sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1)); // A = older, B = newer
  cmpState.a = picked[0].id;
  cmpState.b = picked[1].id;
  $('runsCompareCard').hidden = false;
  renderCompare();
  $('runsCompareCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function deleteSelectedRuns() {
  const ids = [...runsState.sel];
  if (!ids.length) return;
  if (!confirm(`Delete ${ids.length} run${ids.length === 1 ? '' : 's'}?\nTheir results, reports and logs are removed permanently.`)) return;
  let failed = 0;
  for (const id of ids) {
    try { await api('DELETE', `/api/runs/${encodeURIComponent(id)}`); runsState.sel.delete(id); } catch { failed++; }
  }
  if (failed) alert(`${failed} run${failed === 1 ? '' : 's'} could not be deleted — a run that is still active can't be removed.`);
  loadRuns();
}


// day bucket key + human title, e.g. "Wednesday, 22 Jul 2026"
function dayKey(iso) { const d = new Date(iso); return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`; }
function dayLabel(iso) { return new Date(iso).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'short', year: 'numeric' }); }
function timeOnly(iso) { return new Date(iso).toLocaleTimeString('en-GB'); }
// tooltip: primary app under test + any dependency hosts it also called
function runTargetTitle(r) {
  const t = r.targets || [];
  if (!t.length) return '';
  return t.length > 1 ? `Primary: ${t[0]}\nAlso called: ${t.slice(1).join(', ')}` : `Target: ${t[0]}`;
}

// ---------------- run comparison (A vs B) ----------------
const cmpState = { a: '', b: '', cache: {} };


async function cmpRun(id) {
  if (!cmpState.cache[id]) cmpState.cache[id] = await api('GET', `/api/runs/${id}`);
  return cmpState.cache[id];
}
function cmpNumCell(p, field) { return `<td class="num">${p ? fmt.n(p[field]) : '–'}</td>`; }
function cmpDeltaCell(pa, pb, field, lowerBetter) {
  if (!pa || !pb) return `<td class="num cmp-flat">–</td>`;
  const a = pa[field], b = pb[field], d = +(b - a).toFixed(2);
  if (!d) return `<td class="num cmp-flat">0</td>`;
  const worse = lowerBetter ? d > 0 : d < 0;
  const pct = a ? ` ${d > 0 ? '+' : ''}${(100 * d / a).toFixed(0)}%` : '';
  return `<td class="num ${worse ? 'cmp-bad' : 'cmp-good'}">${d > 0 ? '▲' : '▼'}${pct}</td>`;
}
function cmpMetric(label, a, b, unit, lowerBetter) {
  const d = +(b - a).toFixed(2);
  const cls = d === 0 ? 'cmp-flat' : ((lowerBetter ? d > 0 : d < 0) ? 'cmp-bad' : 'cmp-good');
  const pct = a ? ` ${d > 0 ? '+' : ''}${(100 * d / a).toFixed(0)}%` : '';
  return `<div class="cmp-metric"><div class="cmp-metric-k">${label}</div>
    <div class="cmp-metric-ab">${fmt.n(a)}${unit} → <b>${fmt.n(b)}${unit}</b></div>
    <div class="cmp-metric-d ${cls}">${d === 0 ? '—' : `${d > 0 ? '▲' : '▼'}${pct}`}</div></div>`;
}

async function renderCompare() {
  const el = $('cmpResult');
  const { a, b } = cmpState;
  if (!a || !b) { el.innerHTML = '<p class="hint" style="margin:0">Pick two runs to see per-request deltas (response time, error rate, throughput).</p>'; return; }
  if (a === b) { el.innerHTML = '<p class="hint" style="margin:0">Pick two <b>different</b> runs.</p>'; return; }
  el.innerHTML = '<p class="empty" style="text-align:left">loading…</p>';
  let ra, rb;
  try { [ra, rb] = await Promise.all([cmpRun(a), cmpRun(b)]); }
  catch (e) { el.innerHTML = `<p class="empty" style="text-align:left">Could not load: ${esc(e.message)}</p>`; return; }
  const sa = ra.summary, sb = rb.summary;
  if (!sa || !sb) { el.innerHTML = '<p class="empty" style="text-align:left">One of these runs produced no results.</p>'; return; }
  const oa = sa.overall, ob = sb.overall;
  const overall = [
    cmpMetric('Response p90', oa.p90, ob.p90, 'ms', true),
    cmpMetric('Avg response', oa.avg, ob.avg, 'ms', true),
    cmpMetric('Error rate', oa.errorPct, ob.errorPct, '%', true),
    cmpMetric('Throughput', oa.throughput, ob.throughput, '/s', false),
    cmpMetric('Samples', oa.samples, ob.samples, '', false),
  ];
  const labels = [...new Set([...sa.perLabel, ...sb.perLabel].map((p) => p.label))].filter((l) => l !== 'TOTAL');
  const mapA = new Map(sa.perLabel.map((p) => [p.label, p]));
  const mapB = new Map(sb.perLabel.map((p) => [p.label, p]));
  el.innerHTML = `
    <div class="cmp-head">
      <div class="cmp-run"><span class="cmp-tag cmp-a">A</span> ${esc(ra.planName || '')} <span class="hint">${fmt.dt(ra.createdAt)} · ${esc((ra.targets || [])[0] || '')}</span></div>
      <div class="cmp-run"><span class="cmp-tag cmp-b">B</span> ${esc(rb.planName || '')} <span class="hint">${fmt.dt(rb.createdAt)} · ${esc((rb.targets || [])[0] || '')}</span></div>
    </div>
    <div class="cmp-overall">${overall.join('')}</div>
    <div class="cmp-table-wrap"><table class="cmp-table">
      <thead>
        <tr><th rowspan="2">Request</th><th class="num" colspan="3">Response p90 (ms)</th><th class="num" colspan="3">Error %</th><th class="num" colspan="3">Throughput (/s)</th></tr>
        <tr><th class="num">A</th><th class="num">B</th><th class="num">Δ</th><th class="num">A</th><th class="num">B</th><th class="num">Δ</th><th class="num">A</th><th class="num">B</th><th class="num">Δ</th></tr>
      </thead>
      <tbody>${labels.map((l) => {
        const pa = mapA.get(l), pb = mapB.get(l);
        return `<tr><td>${esc(l)}</td>
          ${cmpNumCell(pa, 'p90')}${cmpNumCell(pb, 'p90')}${cmpDeltaCell(pa, pb, 'p90', true)}
          ${cmpNumCell(pa, 'errorPct')}${cmpNumCell(pb, 'errorPct')}${cmpDeltaCell(pa, pb, 'errorPct', true)}
          ${cmpNumCell(pa, 'throughput')}${cmpNumCell(pb, 'throughput')}${cmpDeltaCell(pa, pb, 'throughput', false)}</tr>`;
      }).join('')}</tbody>
    </table></div>`;
}

// Max concurrent virtual users a run was configured for = sum of enabled
// thread-group thread counts (across per-agent profiles when in that mode).
function runVUsers(r) {
  const c = r.config;
  if (!c) return null;
  const tgs = c.mode === 'per-agent'
    ? Object.values(c.agentConfigs || {}).flatMap((ac) => ac.threadGroups || [])
    : (c.threadGroups || []);
  const sum = tgs.filter((t) => t.enabled !== false).reduce((a, t) => a + (+t.threads || 0), 0);
  return sum || null;
}

function metricCard(m) {
  return `<div class="metric ${m.tone || ''}">
    <div class="metric-ic">${ic(m.ic || 'cube')}</div>
    <div class="metric-body"><div class="metric-k">${m.k}</div><div class="metric-v">${m.v}</div></div>
  </div>`;
}

// ---- shared Azure-style per-sampler charts (dashboard + history + live) ----
// `td` is a per-sampler timeline { t:[secs], labels:[...], series:{label:{tps,errors,avg}}, threads:[]|null }.
// When a finished-run `summary` is supplied the metric strips show official
// p90 / throughput / error totals; live (no summary) derives them from `td`.

function azColorMap(labels) { const m = {}; labels.forEach((l, i) => { m[l] = labelColor(i); }); return m; }

function azLegend(labels, colorOf) {
  return `<div class="az-legend">${labels.map((l) =>
    `<span class="az-leg"><span class="az-dot" style="background:${colorOf[l]}"></span>${esc(l)}</span>`).join('')}</div>`;
}

function azMetricStrip(labels, colorOf, valFn) {
  return `<div class="az-metrics">${labels.map((l) =>
    `<div class="az-metric"><span class="az-dot" style="background:${colorOf[l]}"></span><div class="az-metric-body"><div class="az-metric-k" title="${esc(l)}">${esc(l)}</div><div class="az-metric-v">${valFn(l)}</div></div></div>`).join('')}</div>`;
}

// Per-sampler headline numbers: prefer the finished-run summary; else derive from the timeline.
function azMetricFns(td, summary) {
  const derived = {};
  for (const l of td.labels) {
    const se = td.series[l] || { tps: [], errors: [], avg: [] };
    let wc = 0, wResp = 0, tpsSum = 0, errSum = 0;
    for (let i = 0; i < td.t.length; i++) {
      const c = se.tps[i] || 0;
      wc += c; wResp += c * (se.avg[i] || 0); tpsSum += c; errSum += (se.errors[i] || 0);
    }
    derived[l] = { resp: wc ? Math.round(wResp / wc) : 0, req: td.t.length ? +(tpsSum / td.t.length).toFixed(2) : 0, err: errSum };
  }
  const kept = new Set(td.labels.filter((l) => l !== 'Other'));
  const fromSummary = (label, field, agg) => {
    const pl = summary ? summary.perLabel : [];
    if (label === 'Other') {
      const others = pl.filter((p) => !kept.has(p.label));
      return agg === 'max' ? Math.max(0, ...others.map((p) => p[field] || 0)) : others.reduce((a, p) => a + (p[field] || 0), 0);
    }
    const p = pl.find((x) => x.label === label);
    return p ? (p[field] || 0) : 0;
  };
  return {
    resp: (l) => summary ? `${fmt.ms(fromSummary(l, 'p90', 'max'))} <span class="az-unit">p90</span>` : `${fmt.ms(derived[l].resp)} <span class="az-unit">avg</span>`,
    req: (l) => summary ? fmt.tp(fromSummary(l, 'throughput', 'sum')) : fmt.tp(derived[l].req),
    err: (l) => summary ? fmt.n(fromSummary(l, 'errors', 'sum')) : fmt.n(derived[l].err),
  };
}

// HTML for the 4-chart grid; `prefix` namespaces the canvas ids (az / daz / laz).
// The "virtual users" chart means different things by group type: for a bzm
// Arrivals run the load is a RATE (arrivals/sec) and concurrency (active
// threads) stays low, so we relabel to avoid the "why is it 1?" confusion.
function vuChartMeta(rateKind, hasThreads) {
  if (rateKind === 'arrivals' || rateKind === 'mixed') {
    return {
      title: hasThreads ? 'Active threads (concurrency)' : 'Target rate (arrivals/sec)',
      peakLabel: hasThreads ? 'Peak threads' : 'Target rate',
      series: hasThreads ? 'Active threads' : 'Target rate',
      hint: 'bzm Arrivals drives a request <b>rate</b> — active threads (concurrency) stay low when responses are fast. Watch <b>Requests/sec</b> for the real load.',
    };
  }
  // concurrency groups configure users directly; standard groups too
  return {
    title: hasThreads ? 'Virtual users (max)' : 'Virtual users (configured)',
    peakLabel: 'Peak', series: 'Active threads', hint: null,
  };
}

function azChartsHtml(prefix, td, summary, vu, rateKind) {
  const colorOf = azColorMap(td.labels);
  const hasThreads = Array.isArray(td.threads) && td.threads.length > 0;
  const peak = hasThreads ? fmt.n(Math.max(0, ...td.threads)) : (vu != null ? fmt.n(vu) : '–');
  const vm = vuChartMeta(rateKind, hasThreads);
  const mf = azMetricFns(td, summary);
  const block = (id, title, legendHtml, metricsHtml) => `
    <div class="az-chart">
      <h3>${title}</h3>
      <div class="az-chart-row">
        <div class="az-canvas-wrap"><canvas id="${id}" class="chart"></canvas><div class="tooltip" id="${id}Tip"></div></div>
        ${legendHtml}
      </div>
      ${metricsHtml}
    </div>`;
  return `<div class="az-grid">
    ${block(prefix + 'VU', vm.title,
      azLegend([vm.series], { [vm.series]: SERIES_PALETTE[0] }),
      `<div class="az-metrics"><div class="az-metric"><span class="az-dot" style="background:${SERIES_PALETTE[0]}"></span><div class="az-metric-body"><div class="az-metric-k">${vm.peakLabel}</div><div class="az-metric-v">${peak}</div></div></div></div>${vm.hint ? `<p class="az-vu-hint">${vm.hint}</p>` : ''}`)}
    ${block(prefix + 'Resp', 'Response time — ms (avg per sampler)', azLegend(td.labels, colorOf), azMetricStrip(td.labels, colorOf, mf.resp))}
    ${block(prefix + 'Req', 'Requests / sec (by sampler)', azLegend(td.labels, colorOf), azMetricStrip(td.labels, colorOf, mf.req))}
    ${block(prefix + 'Err', 'Errors (total by sampler)', azLegend(td.labels, colorOf), azMetricStrip(td.labels, colorOf, mf.err))}
  </div>`;
}

// Draw the 4 charts into the canvases created by azChartsHtml(prefix, …).
function azChartsDraw(prefix, td, vu, rateKind) {
  const hasThreads = Array.isArray(td.threads) && td.threads.length > 0;
  const vm = vuChartMeta(rateKind, hasThreads);
  drawArea($(prefix + 'VU'), { t: td.t, series: [{ name: vm.series, color: SERIES_PALETTE[0], values: hasThreads ? td.threads : td.t.map(() => vu || 0) }], tip: $(prefix + 'VUTip') });
  drawArea($(prefix + 'Resp'), { t: td.t, unit: ' ms', series: td.labels.map((l, i) => ({ name: l, color: labelColor(i), values: td.series[l].avg })), tip: $(prefix + 'RespTip') });
  drawArea($(prefix + 'Req'), { t: td.t, stacked: true, series: td.labels.map((l, i) => ({ name: l, color: labelColor(i), values: td.series[l].tps })), tip: $(prefix + 'ReqTip') });
  drawArea($(prefix + 'Err'), { t: td.t, stacked: true, series: td.labels.map((l, i) => ({ name: l, color: labelColor(i), values: td.series[l].errors })), tip: $(prefix + 'ErrTip') });
}

// Run detail — the classic JMeter listener views computed from the stored
// results: throughput/latency charts, Aggregate Report, Summary Report,
// View Results in Table, and a per-agent breakdown. The agent selector
// switches every view between the merged results and one agent's own JTL.
const detailState = { id: null, offset: 0, errorsOnly: false, pageSize: 100, agent: '', tg: '', summary: null, agentSummaries: null };

function filterQs() {
  const q = new URLSearchParams();
  if (detailState.agent) q.set('agent', detailState.agent);
  if (detailState.tg) q.set('tg', detailState.tg);
  return q.toString();
}

/**
 * Print the run detail as a clean report: header, both charts (rendered to
 * images so they survive into the print window), and the Aggregate + Summary +
 * Per-Agent tables — respecting the current Agent / Thread-group filter.
 */
async function printRunDetail(r) {
  const filterNote = [detailState.agent && `Agent: ${detailState.agent}`, detailState.tg && `Thread group: ${detailState.tg}`]
    .filter(Boolean).join(' · ');
  const chartImg = (id) => { const c = $(id); return c ? `<img src="${c.toDataURL('image/png')}" style="width:100%;max-width:720px;border:1px solid #ccc">` : ''; };
  // ensure per-agent table is loaded for the printout
  if ($('tab-agents') && !$('tab-agents').innerHTML) await loadAgentsTab();

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.planName || 'Run')} — ${esc(r.id)}</title>
    <style>
      body{font:12px/1.5 Segoe UI,system-ui,sans-serif;color:#111;margin:24px;}
      h1{font-size:17px;margin:0 0 2px;} h2{font-size:13px;margin:18px 0 6px;color:#333;}
      .meta{color:#555;font-size:11.5px;margin-bottom:14px;}
      table{border-collapse:collapse;width:100%;font-size:11px;margin-bottom:8px;}
      th,td{border:1px solid #ccc;padding:3px 6px;text-align:right;}
      th:first-child,td:first-child{text-align:left;}
      th{background:#eef2f9;}
      .charts{display:flex;flex-direction:column;gap:12px;margin:10px 0;}
      @media print{ button{display:none;} }
    </style></head><body>
    <h1>${esc(r.planName || 'Run')}</h1>
    <div class="meta">Run ${esc(r.id)} · ${esc((r.state || '').toUpperCase())}<br>
      ${fmt.dt(r.createdAt)} → ${fmt.dt(r.endedAt)} · duration ${fmt.dur(r.summary ? r.summary.durationSec : null)}<br>
      Agents: ${esc((r.agents || []).map((a) => a.name).join(', '))}${filterNote ? `<br><b>Filter — ${esc(filterNote)}</b>` : ''}</div>
    <h2>Virtual users</h2><div class="charts">${chartImg('dazVU')}</div>
    <h2>Response time — ms (per sampler)</h2><div class="charts">${chartImg('dazResp')}</div>
    <h2>Requests / sec (by sampler)</h2><div class="charts">${chartImg('dazReq')}</div>
    <h2>Errors (by sampler)</h2><div class="charts">${chartImg('dazErr')}</div>
    <h2>Aggregate Report</h2>${$('tab-aggregate').innerHTML}
    <h2>Summary Report</h2>${$('tab-summary').innerHTML}
    ${$('tab-agents') && $('tab-agents').innerHTML ? `<h2>Per Agent</h2>${$('tab-agents').innerHTML}` : ''}
    <script>window.onload=()=>{setTimeout(()=>window.print(),300);}<\/script>
    </body></html>`;
  const w = window.open('', '_blank');
  if (!w) { alert('Allow pop-ups to print.'); return; }
  w.document.write(html);
  w.document.close();
}

function renderDetailTables(s) {
  $('tab-aggregate').innerHTML = aggregateTable(s);
  $('tab-summary').innerHTML = summaryTable(s);
}

// A run-detail loader's answer is stale once another run was opened or a newer
// load of the same kind started (filters changed again) — it must not overwrite.
function rdToken(kind) {
  const toks = detailState.tok || (detailState.tok = {});
  const n = (toks[kind] = (toks[kind] || 0) + 1);
  const seq = detailState.seq;
  return () => seq === detailState.seq && n === toks[kind];
}

async function agentSummaries() {
  // cache per run + thread-group filter, so the Per Agent tab follows the dropdown
  const keyNow = () => `${detailState.id}|${detailState.tg || ''}`;
  const key = keyNow();
  const c = detailState.agentSummaries;
  if (c && c.key === key) return c.data;
  const q = detailState.tg ? `?tg=${encodeURIComponent(detailState.tg)}` : '';
  const data = await api('GET', `/api/runs/${detailState.id}/agents-summary${q}`);
  if (keyNow() === key) detailState.agentSummaries = { key, data };
  return data;
}

async function loadAgentsTab() {
  const current = rdToken('agents');
  $('tab-agents').innerHTML = '<p class="empty">loading…</p>';
  try {
    const per = await agentSummaries();
    if (!current()) return;
    // flag an agent whose avg response is a wild outlier vs the fastest (slow network path)
    const avgs = per.map((a) => a.overall.avg).filter((v) => v > 0);
    const fastest = avgs.length ? Math.min(...avgs) : 0;
    const slow = (a) => a.overall.avg > 0 && fastest > 0 && a.overall.avg >= 5 * fastest && a.overall.avg - fastest > 1000;
    const anySlow = per.some(slow);
    $('tab-agents').innerHTML = `
      ${detailState.tg ? `<p class="hint" style="margin:0 0 8px;">Filtered to thread group “${esc(detailState.tg)}” — numbers exclude other groups (e.g. setUp/tearDown).</p>` : ''}
      ${anySlow ? `<p class="hint" style="color:var(--warning); font-weight:600; margin:0 0 8px;">⚠ One or more agents were much slower than the others — likely a slow network path from that PC to the target, not real load. A run only finishes when its slowest agent does.</p>` : ''}
      <table>
        <thead><tr><th>Agent</th><th class="num">Samples</th><th class="num">Total Time</th><th class="num">Avg</th><th class="num">Median</th>
          <th class="num">p95</th><th class="num">Max</th><th class="num">Err %</th><th class="num">Throughput</th>
          <th class="num">Recv KB/s</th></tr></thead>
        <tbody>${per.map((a) => `
          <tr${slow(a) ? ' class="agent-slow"' : ''}>
            <td><b>${esc(a.agent)}</b>${slow(a) ? ' <span class="slow-badge">⚠ slow network</span>' : ''}</td>${numTd(a.overall.samples)}
            <td class="num">${fmt.dur(a.durationSec)}</td>
            <td class="num"${slow(a) ? ' style="color:var(--warning);font-weight:700"' : ''}>${fmt.n(a.overall.avg)}</td>${numTd(a.overall.median)}
            ${numTd(a.overall.p95)}${numTd(a.overall.max)}
            <td class="num" style="${errStyle(a.overall.errorPct)}">${a.overall.errorPct}</td>
            <td class="num">${fmt.tp(a.overall.throughput)}</td>
            <td class="num">${a.overall.recvKBs ?? '–'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
      <p class="hint">Use the Agent filter at the top of the page to see one agent's charts and tables.</p>`;
  } catch (e) {
    if (current()) $('tab-agents').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

const numTd = (v, style = '') => `<td class="num" ${style ? `style="${style}"` : ''}>${v == null ? '–' : fmt.n(v)}</td>`;
const errStyle = (p) => (p > 0 ? 'color:var(--critical)' : '');

function aggregateTable(s) {
  return `
  <table>
    <thead><tr><th>Sampler</th><th class="num">Samples</th><th class="num">Avg</th><th class="num">Median</th>
      <th class="num">p90</th><th class="num">p95</th><th class="num">p99</th><th class="num">Min</th><th class="num">Max</th>
      <th class="num">Err %</th><th class="num">Throughput</th></tr></thead>
    <tbody>${[...s.perLabel, s.overall].map((r) => `
      <tr ${r.label === 'TOTAL' ? 'style="font-weight:650"' : ''}>
        <td>${esc(r.label)}</td>${numTd(r.samples)}${numTd(r.avg)}${numTd(r.median)}
        ${numTd(r.p90)}${numTd(r.p95)}${numTd(r.p99)}${numTd(r.min)}${numTd(r.max)}
        <td class="num" style="${errStyle(r.errorPct)}">${r.errorPct}</td>
        <td class="num">${fmt.tp(r.throughput)}</td>
      </tr>`).join('')}
    </tbody>
  </table>`;
}

function summaryTable(s) {
  return `
  <table>
    <thead><tr><th>Sampler</th><th class="num">Samples</th><th class="num">Avg</th><th class="num">Min</th><th class="num">Max</th>
      <th class="num">Std Dev</th><th class="num">Err %</th><th class="num">Throughput</th>
      <th class="num">Recv KB/s</th><th class="num">Sent KB/s</th><th class="num">Avg Bytes</th></tr></thead>
    <tbody>${[...s.perLabel, s.overall].map((r) => `
      <tr ${r.label === 'TOTAL' ? 'style="font-weight:650"' : ''}>
        <td>${esc(r.label)}</td>${numTd(r.samples)}${numTd(r.avg)}${numTd(r.min)}${numTd(r.max)}
        ${numTd(r.stdDev)}
        <td class="num" style="${errStyle(r.errorPct)}">${r.errorPct}</td>
        <td class="num">${fmt.tp(r.throughput)}</td>
        <td class="num">${r.recvKBs ?? '–'}</td><td class="num">${r.sentKBs ?? '–'}</td>${numTd(r.avgBytes)}
      </tr>`).join('')}
    </tbody>
  </table>`;
}

async function loadSamples() {
  const current = rdToken('samples');
  $('samplesBox').innerHTML = '<p class="empty">loading…</p>';
  try {
    const d = await api('GET', `/api/runs/${detailState.id}/samples?offset=${detailState.offset}&limit=${detailState.pageSize}` +
      `${detailState.errorsOnly ? '&errors=1' : ''}&${filterQs()}`);
    if (!current()) return;
    $('pgInfo').textContent = `rows ${detailState.offset + 1}–${detailState.offset + d.rows.length}${d.hasMore ? '+' : ''}`;
    $('pgPrev').disabled = detailState.offset === 0;
    $('pgNext').disabled = !d.hasMore;
    $('samplesBox').innerHTML = d.rows.length ? `
      <table>
        <thead><tr><th>Time</th><th>Thread</th><th>Sampler</th><th class="num">ms</th><th>Code</th>
          <th class="num">Bytes</th><th class="num">Latency</th><th>Status</th></tr></thead>
        <tbody>${d.rows.map((row, i) => `
          <tr class="sample-row" data-i="${i}">
            <td>${new Date(row.t).toLocaleTimeString('en-GB')}.${String(row.t % 1000).padStart(3, '0')}</td>
            <td>${esc(row.thread)}</td><td>${esc(row.label)}</td>
            ${numTd(row.elapsed)}<td>${esc(row.code)}</td>${numTd(row.bytes)}${numTd(row.latency)}
            <td style="color:var(--${row.success ? 'good' : 'critical'}); font-weight:600">${row.success ? '✓' : '✗'}</td>
          </tr>
          <tr class="sample-detail" style="display:none"><td colspan="8">
            ${row.url ? `<b>URL:</b> ${esc(row.url)}<br>` : ''}
            <b>Response:</b> ${esc(row.code)} ${esc(row.msg)}<br>
            ${row.failure ? `<b>Failure:</b> ${esc(row.failure)}<br>` : ''}
            <b>Latency:</b> ${row.latency} ms · <b>Connect:</b> ${row.connect} ms · <b>Bytes:</b> ${fmt.n(row.bytes)}
          </td></tr>`).join('')}
        </tbody>
      </table>` : '<p class="empty">no rows</p>';
    document.querySelectorAll('.sample-row').forEach((tr) => {
      tr.onclick = () => {
        const det = tr.nextElementSibling;
        det.style.display = det.style.display === 'none' ? '' : 'none';
      };
    });
  } catch (e) {
    if (current()) $('samplesBox').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

// ---------------- run detail: one page per run (#run/<id>) ----------------

function shortStamp(iso) {
  return `${new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })} ${timeOnly(iso)}`;
}
function longStamp(iso) {
  return new Date(iso).toLocaleString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

async function openRun(id, opts = {}) {
  showView('run', { ...opts, hash: `run/${encodeURIComponent(id)}` });
  const page = $('runPage');
  const seq = (detailState.seq = (detailState.seq || 0) + 1);
  page.innerHTML = '<div class="card"><p class="empty">Loading run…</p></div>';
  let r;
  try { r = await api('GET', `/api/runs/${encodeURIComponent(id)}`); } catch (e) {
    page.innerHTML = `<div class="card empty-state"><b>This run can't be opened</b><span>${esc(e.message)}</span><a class="link-btn" href="#runs">Back to all runs</a></div>`;
    return;
  }
  await ensureSla();
  if (seq !== detailState.seq) return; // user already opened another run
  r.overall = r.summary ? r.summary.overall : null; // same shape as the list, so SLA/result badges agree
  Object.assign(detailState, {
    id, r, offset: 0, errorsOnly: false, agent: '', tg: '', summary: r.summary, cur: r.summary,
    agentSummaries: null, rateKind: r.rateKind,
  });
  $('crumb').textContent = `Results / Runs / ${shortStamp(r.createdAt)}`;
  document.title = `${r.planName || 'Run'} · ${shortStamp(r.createdAt)} · LoadPilot`;

  const s = r.summary;
  const hasSamples = !!(s && s.overall && s.overall.samples);
  const agents = r.agents || [];
  const uploadedAgents = agents.filter((a) => a.uploaded).map((a) => a.name);
  const dur = s ? s.durationSec : r.endedAt ? (new Date(r.endedAt) - new Date(r.createdAt)) / 1000 : null;
  const names = agents.map((a) => a.name);
  const agentsTxt = names.length <= 3 ? `${names.length} agent${names.length === 1 ? '' : 's'} (${names.join(', ')})` : `${names.length} agents`;
  const mode = r.config && r.config.mode === 'per-agent' ? 'per-agent profiles' : 'split evenly';
  const target = (r.targets || [])[0];
  const agentErrors = agents.filter((a) => a.error);
  const errs = hasSamples ? s.overall.errors : 0;

  page.innerHTML = `
    <div class="card run-head" id="printArea">
      <div class="run-head-top">
        <div class="run-head-text">
          <h2 class="run-title">${esc(r.planName || 'Run')} ${resultBadge(r)}${errs ? ` <span class="rbadge bad-soft">${fmt.n(errs)} failed request${errs === 1 ? '' : 's'}</span>` : ''}</h2>
          <p class="run-meta">${esc(longStamp(r.createdAt))} · ran ${durHuman(dur)} · <span title="${esc(names.join(', '))}">${esc(agentsTxt)}</span> · ${mode}${target ? ` · target <b>${esc(target)}</b>` : ''}</p>
          ${agentErrors.length ? `<p class="run-warn">${ic('warn')} ${agentErrors.map((a) => `<b>${esc(a.name)}</b>: ${esc(a.error)}`).join(' · ')}</p>` : ''}
        </div>
        <div class="run-actions">
          <button type="button" class="primary" id="rdAgain" ${r.planId ? '' : 'disabled'} title="Open New run with this plan, workload and agents">Run again</button>
          ${r.hasReport ? `<a class="btn-ghost" href="/runs-static/${encodeURIComponent(id)}/report/index.html" target="_blank" rel="noopener">JMeter report</a>` : ''}
          ${hasSamples ? `<button type="button" class="ghost" id="histSendSheet">Send to Google Sheet</button>` : ''}
          <details class="menu">
            <summary class="btn-ghost" aria-label="More actions">More</summary>
            <div class="menu-pop">
              ${r.hasMerged ? `<a href="/api/runs/${encodeURIComponent(id)}/merged.jtl">Download results (.jtl)</a>` : ''}
              <a href="/api/runs/${encodeURIComponent(id)}/log" target="_blank" rel="noopener">Open run log</a>
              ${hasSamples ? '<button type="button" id="printRun">Print report</button>' : ''}
              <button type="button" id="rdDelete" class="danger-item">Delete run</button>
            </div>
          </details>
        </div>
      </div>
      ${hasSamples && ((r.tgNames || []).length > 1 || uploadedAgents.length > 1) ? `
      <div class="rd-filters">
        ${(r.tgNames || []).length > 1 ? `<label class="rf"><span>Thread group</span><select id="tgSel">
          <option value="">All thread groups</option>${r.tgNames.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</select></label>` : ''}
        ${uploadedAgents.length > 1 ? `<label class="rf"><span>Agent</span><select id="agentSel">
          <option value="">All agents (merged)</option>${uploadedAgents.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</select></label>` : ''}
        <p class="rd-filter-note">Filters apply to every number, chart and table on this page. Throughput is always divided by the full run time, so filtered numbers stay comparable.</p>
      </div>` : ''}
    </div>
    ${hasSamples ? `
    <div class="kpi-row rd-kpis" id="rdKpis"></div>
    <div class="card" id="rdSla"></div>
    <div class="card"><h2>Over time</h2><div id="dazCharts"><p class="empty">Loading charts…</p></div></div>
    <div class="card rd-tabs-card">
      <div class="tabbar" role="tablist" aria-label="Run results">
        <button type="button" role="tab" data-tab="aggregate" class="on" aria-selected="true">Aggregate report</button>
        <button type="button" role="tab" data-tab="errors" id="rdErrTab">Errors · ${fmt.n(errs)}</button>
        ${uploadedAgents.length ? '<button type="button" role="tab" data-tab="agents">Per agent</button>' : ''}
        <button type="button" role="tab" data-tab="summary">Summary report</button>
        <button type="button" role="tab" data-tab="table" ${r.hasMerged ? '' : 'disabled title="Needs the merged results file"'}>All requests</button>
      </div>
      <div id="tab-aggregate" class="subtab active"></div>
      <div id="tab-errors" class="subtab"></div>
      <div id="tab-agents" class="subtab"></div>
      <div id="tab-summary" class="subtab"></div>
      <div id="tab-table" class="subtab">
        <div class="sampler-tools">
          <label class="df-header"><input type="checkbox" id="errOnly"> Failed requests only</label>
          <button type="button" class="ghost mini" id="pgPrev">← Previous</button>
          <span id="pgInfo" class="hint" style="margin:0"></span>
          <button type="button" class="ghost mini" id="pgNext">Next →</button>
        </div>
        <div id="samplesBox"></div>
      </div>
    </div>` : `
    <div class="card empty-state"><b>This run recorded no results</b>
      <span>${r.state === 'error' ? 'It failed before any request was sent — the run log usually says why.' : 'No requests were sent.'}</span>
      <a class="link-btn" href="/api/runs/${encodeURIComponent(id)}/log" target="_blank" rel="noopener">Open run log</a></div>`}`;

  $('rdAgain').onclick = () => runAgain(r, $('rdAgain'));
  $('rdDelete').onclick = async () => {
    if (!confirm(`Delete this run?\nIts results, reports and logs are removed permanently.`)) return;
    try { await api('DELETE', `/api/runs/${encodeURIComponent(id)}`); showView('runs'); } catch (e) { alert(`Delete failed: ${e.message}`); }
  };
  const hss = $('histSendSheet');
  if (hss) hss.onclick = () => sendRunToSheet(id, hss);
  if (!hasSamples) return;
  $('printRun').onclick = () => printRunDetail(r);
  page.querySelectorAll('.tabbar [data-tab]').forEach((b) => (b.onclick = () => rdTab(b.dataset.tab)));
  $('errOnly').onchange = () => { detailState.errorsOnly = $('errOnly').checked; detailState.offset = 0; loadSamples(); };
  $('pgPrev').onclick = () => { detailState.offset = Math.max(0, detailState.offset - detailState.pageSize); loadSamples(); };
  $('pgNext').onclick = () => { detailState.offset += detailState.pageSize; loadSamples(); };
  if ($('agentSel')) $('agentSel').onchange = () => { detailState.agent = $('agentSel').value; detailState.offset = 0; rdRefresh(); };
  if ($('tgSel')) $('tgSel').onchange = () => { detailState.tg = $('tgSel').value; detailState.offset = 0; rdRefresh(); };
  renderRdSla();
  rdRefresh();
  window.scrollTo({ top: 0 });
}

function rdTab(name) {
  document.querySelectorAll('#runPage .tabbar [data-tab]').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  document.querySelectorAll('#runPage .subtab').forEach((x) => x.classList.toggle('active', x.id === `tab-${name}`));
  if (name === 'table' && !$('samplesBox').innerHTML) loadSamples();
  if (name === 'agents' && !$('tab-agents').innerHTML) loadAgentsTab();
  if (name === 'errors' && !$('tab-errors').dataset.loaded) loadErrorsTab();
}

// Every number, chart and table for the current agent / thread-group filter.
async function rdRefresh() {
  const current = rdToken('refresh');
  const r = detailState.r;
  let s = detailState.summary;
  if (detailState.agent || detailState.tg) {
    try { s = await api('GET', `/api/runs/${detailState.id}/summary?${filterQs()}`); } catch { s = null; }
  }
  let td = { t: [], labels: [], series: {}, threads: null };
  try { td = await api('GET', `/api/runs/${detailState.id}/timeline-detail?${filterQs()}`); } catch { /* no timeline */ }
  if (!current()) return;
  detailState.cur = s;
  const hasData = !!(s && s.overall && s.overall.samples);
  renderRdKpis(hasData ? s : null, td);
  const vu = runVUsers(r);
  const charts = $('dazCharts');
  if (hasData && td.t.length) {
    charts.innerHTML = azChartsHtml('daz', td, s, vu, detailState.rateKind);
    azChartsDraw('daz', td, vu, detailState.rateKind);
  } else {
    charts.innerHTML = `<div class="empty-state"><b>No results for this ${detailState.tg ? 'thread group' : 'selection'}</b>
      <span>${detailState.tg ? `“${esc(detailState.tg)}” sent no requests in this run — it was probably switched off.` : 'Nothing was recorded for this filter.'}</span></div>`;
  }
  if (hasData) renderDetailTables(s);
  else { $('tab-aggregate').innerHTML = '<p class="empty">No requests for this filter.</p>'; $('tab-summary').innerHTML = ''; }
  $('rdErrTab').textContent = `Errors · ${fmt.n(hasData ? s.overall.errors : 0)}`;
  if ($('samplesBox').innerHTML) loadSamples();
  if ($('tab-errors').dataset.loaded) loadErrorsTab();
  if ($('tab-agents') && $('tab-agents').innerHTML) loadAgentsTab();
}

function renderRdKpis(s, td) {
  const r = detailState.r;
  const o = s && s.overall;
  const n = (r.agents || []).length;
  const split = n > 1 && !detailState.agent;
  const vu = runVUsers(r);
  const peak = td && td.threads && td.threads.length ? Math.max(0, ...td.threads) : vu;
  const isArr = r.rateKind === 'arrivals' || r.rateKind === 'mixed';
  const cards = [
    { k: isArr ? 'Peak active threads' : 'Peak users', v: peak != null ? fmt.n(peak) : '–', sub: peak && split ? `≈ ${fmt.n(Math.round(peak / n))} on each agent` : '' },
    { k: 'Throughput', v: o ? `${o.throughput} req/s` : '–', sub: o ? `Over ${durHuman(s.durationSec)}` : '' },
    { k: 'Response time p90', v: o ? msHuman(o.p90) : '–', sub: o ? `Average ${msHuman(o.avg)}` : '' },
    { k: 'Requests', v: o ? fmt.n(o.samples) : '–', sub: o && split ? `≈ ${fmt.n(Math.round(o.samples / n))} per agent` : '' },
    { k: 'Errors', v: o ? fmt.n(o.errors) : '–', sub: o ? `${o.errorPct}% of requests` : '', tone: o && o.errors ? 'bad' : '' },
  ];
  $('rdKpis').innerHTML = cards.map(kpiCard).join('');
}

// SLA limits are global (every run is judged by them); checked on the WHOLE run.
function renderRdSla(editing) {
  const el = $('rdSla');
  if (!el) return;
  const r = detailState.r;
  const o = r.summary && r.summary.overall;
  const t = slaThresholds || {};
  if (editing) {
    el.innerHTML = `<h2>SLA limits</h2>
      <p class="hint" style="margin:0 0 12px;">These limits judge <b>every</b> run as passed or failed. Leave a box empty for no limit.</p>
      <div class="sla-form">
        <label class="rf"><span>Error rate at most (%)</span><input id="slaErr" type="number" min="0" step="0.1" value="${t.maxErrorPct ?? ''}" placeholder="no limit"></label>
        <label class="rf"><span>p90 response time at most (ms)</span><input id="slaP90" type="number" min="0" step="10" value="${t.maxP90Ms ?? ''}" placeholder="no limit"></label>
        <label class="rf"><span>Throughput at least (req/s)</span><input id="slaTp" type="number" min="0" step="1" value="${t.minThroughput ?? ''}" placeholder="no limit"></label>
      </div>
      <div class="sla-form-actions"><button type="button" class="primary" id="slaSave">Save limits</button>
        <button type="button" class="ghost" id="slaCancel">Cancel</button><span id="slaMsg" class="hint" style="margin:0"></span></div>`;
    $('slaCancel').onclick = () => renderRdSla();
    $('slaSave').onclick = async () => {
      const val = (id) => ($(id).value === '' ? null : Number($(id).value));
      try {
        const d = await api('PUT', '/api/sla', { maxErrorPct: val('slaErr'), maxP90Ms: val('slaP90'), minThroughput: val('slaTp') });
        slaThresholds = d.sla;
        renderRdSla();
        // the header badge depends on the limits too
        const badge = document.querySelector('#runPage .run-title .rbadge');
        if (badge) badge.outerHTML = resultBadge(r);
      } catch (e) { $('slaMsg').textContent = e.message; }
    };
    return;
  }
  const v = slaVerdict(r);
  const row = (name, limit, ok, rule, actual) => limit == null
    ? `<li class="sla-off"><span class="sla-ic">–</span><span><b>${name}</b> · no limit set</span></li>`
    : `<li class="${ok ? 'sla-ok' : 'sla-bad'}"><span class="sla-ic">${ok ? ic('check') : ic('fail')}</span><span><b>${name} ${rule}</b> · ${actual}</span></li>`;
  el.innerHTML = `<h2>SLA checks <span class="rbadge ${v === 'pass' ? 'ok' : v === 'fail' ? 'bad' : 'neutral'}">${v === 'pass' ? 'Passed' : v === 'fail' ? 'Failed' : 'No limits set'}</span>
      <button type="button" class="link-btn" id="slaEdit" style="margin-left:auto;">Edit SLA limits</button></h2>
    ${o ? `<ul class="sla-list">
      ${row('Error rate', t.maxErrorPct, o.errorPct <= t.maxErrorPct, `at most ${t.maxErrorPct}%`, `${o.errorPct}% in this run`)}
      ${row('p90 response time', t.maxP90Ms, o.p90 <= t.maxP90Ms, `at most ${msHuman(t.maxP90Ms)}`, `${msHuman(o.p90)} in this run`)}
      ${row('Throughput', t.minThroughput, o.throughput >= t.minThroughput, `at least ${t.minThroughput} req/s`, `${o.throughput} req/s in this run`)}
    </ul>` : ''}
    ${detailState.agent || detailState.tg ? '<p class="hint" style="margin:8px 0 0">Checked on the whole run, not the current filter.</p>' : ''}`;
  $('slaEdit').onclick = () => renderRdSla(true);
}

// "Run again": the same plan, workload, variables and agents, opened on the
// Review step so nothing starts until you press Start.
async function runAgain(r, btn = $('rdAgain')) {
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Opening…';
  let plan;
  try { plan = await api('GET', `/api/plans/${encodeURIComponent(r.planId)}`); } catch (e) {
    alert(`The plan for this run is no longer available (${e.message}). Upload it again on New run.`);
    btn.disabled = false; btn.textContent = label;
    return;
  }
  const c = r.config || {};
  applyLoadedPlan(plan);
  state.agentChoice = new Set(c.agents || []);
  renderAgentPick();
  if (c.mode === 'per-agent' && c.agentConfigs) {
    state.profiles = JSON.parse(JSON.stringify(c.agentConfigs));
    state.distMode = 'per-agent';
    state.editingAgent = (c.agents || [])[0] || null;
    const radio = document.querySelector('input[name="distMode"][value="per-agent"]');
    if (radio) radio.checked = true;
    if (state.editingAgent) applyFormConfig(state.profiles[state.editingAgent]);
    updateDistUI();
  } else {
    applyFormConfig(c);
  }
  for (const [bid, vars] of Object.entries(c.variables || {})) {
    for (const [name, value] of Object.entries(vars)) {
      const inp = [...document.querySelectorAll('.var-input')].find((x) => x.dataset.block === String(bid) && x.dataset.name === name);
      if (inp) inp.value = value;
    }
  }
  if (c.heap) $('heap').value = c.heap;
  if (c.liveInterval) $('liveInterval').value = String(c.liveInterval);
  renderSplitPreview();
  renderDataFiles();
  showView('new');
  wizGo(4);
  btn.disabled = false; btn.textContent = label;
}

// ---------------- run detail: Errors tab ----------------
// Failures grouped by sampler + code + reason with TRUE counts; one captured
// example at a time with the request that was sent and the response that came back.

const errView = { d: null, g: 0, i: 0, side: 'resp', body: 'source' };

// Preview a captured HTML response without running or fetching anything from the
// target: scripts, frames and external links are removed, then a strict CSP
// inside a fully sandboxed iframe blocks whatever is left.
function previewDoc(html) {
  const clean = String(html)
    .replace(/<script[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<(link|iframe|frame|object|embed|base|meta)\b[^>]*>/gi, '')
    .replace(/<\/(iframe|object)\s*>/gi, '')
    .replace(/\s(src|srcset|href|action|poster)\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, ' data-blocked-$1=$2');
  return `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">${clean}`;
}

async function loadErrorsTab() {
  const box = $('tab-errors');
  box.dataset.loaded = '1';
  box.innerHTML = '<p class="empty">Loading errors…</p>';
  const current = rdToken('errors');
  let d;
  try { d = await api('GET', `/api/runs/${detailState.id}/error-summary?${filterQs()}`); } catch (e) {
    if (current()) $('tab-errors').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
    return;
  }
  if (!current()) return;
  errView.d = d;
  errView.g = 0; errView.i = 0;
  renderErrorsTab();
}

function errKind(g) {
  const code = String(g.code || '');
  const text = `${code} ${g.msg || ''}`;
  if (g.failure) return 'Assertion failed';
  if (/timeout|timed out/i.test(text)) return 'Timed out';
  if (/^\d{3}$/.test(code)) return Number(code) >= 500 ? 'Server error' : Number(code) >= 400 ? 'Request rejected' : 'Unexpected response';
  if (/connect|refused|reset|unknownhost|ssl|socket|no route/i.test(text)) return 'Connection problem';
  return 'Request failed';
}

// "Test failed: text expected not to contain /X/" → plain words + the pattern
function explainAssertion(msg) {
  const m = /expected (not )?to (contain|match|equal|be equal to|substring)\s*\/([\s\S]*)\/\s*$/i.exec(msg || '');
  if (!m) return null;
  const neg = !!m[1];
  const what = /\bcode\b/i.test(msg) ? 'response code' : /header/i.test(msg) ? 'response headers' : 'response';
  return {
    pattern: m[3], neg,
    text: neg ? `Response Assertion: the ${what} must not contain the text below, but it did.`
      : `Response Assertion: the ${what} must contain the text below, but it didn't.`,
    short: neg ? `The ${what} contained “${m[3].slice(0, 70)}”` : `The ${what} didn't contain “${m[3].slice(0, 70)}”`,
  };
}

const decodeParam = (s) => { try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch { return s; } };
function parseForm(str) {
  if (!str || /[\r\n]/.test(str.trim()) || !str.includes('=')) return null;
  const out = [];
  for (const part of str.split('&')) {
    const i = part.indexOf('=');
    if (i <= 0) return null;
    out.push([decodeParam(part.slice(0, i)), decodeParam(part.slice(i + 1))]);
  }
  return out;
}
const isGet = (e) => (e.method || 'GET').toUpperCase() === 'GET';
function exParams(e) {
  const out = [];
  try { new URL(e.url).searchParams.forEach((v, k) => out.push([k, v])); } catch { /* no url */ }
  if (!isGet(e)) (parseForm(e.requestData) || []).forEach((p) => out.push(p));
  return out;
}

// Signs that the PLAN (not the server) caused the failure.
function planProblems(g) {
  if (g._probs) return g._probs;
  const exs = g.examples || [];
  const out = [];
  const flagged = new Set();
  for (const e of exs) {
    for (const [k, v] of exParams(e)) {
      if (flagged.has(k) || !(v === 'NOT_FOUND' || /\$\{[^}]+\}/.test(v))) continue;
      flagged.add(k);
      const n = exs.filter((x) => exParams(x).some(([k2, v2]) => k2 === k && v2 === v)).length;
      out.push({ kind: v === 'NOT_FOUND' ? 'notfound' : 'literal', k, v, n });
    }
  }
  // The same account sent by several different virtual users → a per-user CSV
  // variable wasn't set and the plan's default was used. Only identity-like
  // fields count (a shared class or course id is normal).
  const userKey = (e) => `${e.agent}|${e.thread}`; // thread names repeat on every agent
  const byKey = new Map();
  for (const e of exs) {
    for (const [k, v] of exParams(e)) {
      if (flagged.has(k) || !IDENTITY_KEY.test(k) || !/^(\d{5,}|[^@\s]+@[^@\s]+\.\w+)$/.test(v)) continue;
      if (!byKey.has(k)) byKey.set(k, new Map());
      const m = byKey.get(k);
      if (!m.has(v)) m.set(v, { users: new Set(), agents: new Set() });
      m.get(v).users.add(userKey(e));
      m.get(v).agents.add(e.agent);
    }
  }
  for (const [k, m] of byKey) {
    const [v, hit] = [...m].sort((a, b) => b[1].users.size - a[1].users.size)[0];
    if (hit.users.size >= 3) out.push({ kind: 'same', k, v, n: hit.users.size, agents: [...hit.agents], total: new Set(exs.map(userKey)).size });
  }
  g._probs = out;
  return out;
}
const IDENTITY_KEY = /reg|user|login|email|mobile|phone|account|student|member|customer|identifier|uid|msisdn/i;
// A form page sent back with validation errors (ASP.NET-style
// `field-validation-error` spans) says WHICH field the server wanted. If the
// request never sent a field by that name, the site probably renamed it.
function formRejections(e) {
  const out = [];
  for (const m of String(e.responseBody || '').matchAll(/<span\b([^>]*field-validation-error[^>]*)>([^<]+)</gi)) {
    const f = /data-valmsg-for="([^"]+)"/i.exec(m[1]);
    if (f && m[2].trim()) out.push({ field: f[1], msg: m[2].trim() });
  }
  if (!out.length) return [];
  const sent = exParams(e).map(([k]) => k);
  return out.map((r) => ({ ...r, missing: !sent.some((k) => k.toLowerCase() === r.field.toLowerCase()), sent }));
}
function formRejectionHtml(r) {
  const sentList = r.sent.filter((k) => !/token/i.test(k)).map((k) => `<code>${esc(k)}</code>`).join(', ');
  return r.missing
    ? `The server rejected the form: field <code>${esc(r.field)}</code> — “${esc(r.msg)}” This request didn't send a field called <b>${esc(r.field)}</b>${sentList ? ` (it sent ${sentList})` : ''}. The site has probably renamed the field — update this request's parameter name in the plan.`
    : `The server rejected the form: field <code>${esc(r.field)}</code> — “${esc(r.msg)}” The field was sent, so check the value it was given.`;
}

function planProblemHtml(p, total) {
  const kv = `<code>${esc(p.k)}=${esc(p.v.length > 60 ? `${p.v.slice(0, 60)}…` : p.v)}</code>`;
  if (p.kind === 'notfound') return `This request was sent with ${kv} — the default used when a variable is not set. The step that saves <b>${esc(p.k)}</b> may not have run for this virtual user. ${p.n} of ${total} examples look like this.`;
  if (p.kind === 'literal') return `This request was sent with ${kv}: JMeter couldn't find that variable, so it sent its name instead of a value. ${p.n} of ${total} examples look like this.`;
  const who = p.n === p.total ? `All ${p.n} virtual users in these examples` : `${p.n} of the ${p.total} virtual users in these examples`;
  return `${who} sent the same ${kv} (on ${p.agents.map(esc).join(', ')}). If each user should log in with its own row from a CSV file, the CSV variable was probably not set and the plan's default value was used — check that agent's CSV file: its first line must hold the variable names (or set them in the CSV Data Set Config).`;
}

function headerLines(raw) {
  return String(raw || '').split(/\r?\n/).map((l) => {
    const i = l.indexOf(':');
    return i > 0 ? [l.slice(0, i).trim(), l.slice(i + 1).trim()] : null;
  }).filter(Boolean);
}
function headerValue(raw, name) {
  const h = headerLines(raw).find(([k]) => k.toLowerCase() === name);
  return h ? h[1] : '';
}

function tryB64Json(v) {
  if (!v || v.length < 16 || !/^[A-Za-z0-9+/_-]+={0,2}$/.test(v)) return null;
  try {
    const j = JSON.parse(atob(v.replace(/-/g, '+').replace(/_/g, '/')));
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch { return null; }
}
const SECRET_KEY = /pass|token|secret|auth|apikey|api_key|session|cookie|signature/i;

function toCurl(e) {
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
  const parts = [`curl -X ${(e.method || 'GET').toUpperCase()} ${q(e.url || '')}`];
  for (const [k, v] of headerLines(e.requestHeaders)) {
    if (/^(content-length|host|connection)$/i.test(k)) continue;
    parts.push(`-H ${q(`${k}: ${v}`)}`);
  }
  if (e.cookies) parts.push(`-b ${q(e.cookies.trim())}`);
  if (e.requestData && !isGet(e)) parts.push(`--data-raw ${q(e.requestData)}`);
  return parts.join(' \\\n  ');
}

// Works on plain http:// too (navigator.clipboard needs a secure page).
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); } finally { ta.remove(); }
  return Promise.resolve();
}

function renderErrorsTab() {
  const box = $('tab-errors');
  const d = errView.d;
  if (!d || !d.totalErrors) {
    const n = detailState.cur && detailState.cur.overall ? detailState.cur.overall.samples : 0;
    box.innerHTML = `<div class="empty-state"><b>No errors ${detailState.agent || detailState.tg ? 'for this filter' : 'in this run'}</b>
      <span>Every one of the ${fmt.n(n)} requests succeeded. Failed requests would be grouped here by sampler, code and reason.</span></div>`;
    return;
  }
  const groups = d.groups;
  const labels = [...new Set(groups.map((g) => g.label))];
  const allLabels = detailState.cur ? detailState.cur.perLabel.length : labels.length;
  const captured = groups.reduce((a, g) => a + exTotal(g), 0);
  const pct = (100 * d.totalErrors / Math.max(1, d.totalSamples));
  const kpis = [
    { k: 'Failed requests', v: fmt.n(d.totalErrors), sub: `${pct.toFixed(2)}% of ${fmt.n(d.totalSamples)} requests`, tone: 'bad' },
    { k: 'Error types', v: fmt.n(groups.length), sub: 'Same sampler, code and reason' },
    { k: 'Samplers affected', v: `${labels.length} of ${allLabels}`, sub: esc(labels.length === 1 ? labels[0] : `${labels[0]} and ${labels.length - 1} more`) },
    // a stopped run can capture a few more failures than made it into the results file
    { k: 'Examples captured', v: captured >= d.totalErrors ? 'All' : `${fmt.n(captured)} of ${fmt.n(d.totalErrors)}`, sub: 'Request and response for each' },
  ];
  box.innerHTML = `
    <div class="kpi-row err-kpis">${kpis.map(kpiCard).join('')}</div>
    ${d.captureTruncated ? `<p class="run-warn">${ic('warn')} Some capture files were too large to read completely — counts are exact, but a few examples may be missing.</p>` : ''}
    <div class="err-layout">
      <div class="etypes">
        <div class="etypes-head"><b>Error types</b><span class="hint" style="margin:0">Most frequent first</span></div>
        <div class="etype-list">${groups.map((g, i) => {
          const why = explainAssertion(g.failure);
          const agentsSeen = [...new Set((g.examples || []).map((e) => e.agent))];
          const users = new Set((g.examples || []).map((e) => e.thread)).size;
          const ms = (g.examples || []).map((e) => e.elapsed);
          return `<button type="button" class="etype${i === errView.g ? ' on' : ''}" data-g="${i}">
            <span class="etype-top"><span class="etype-kind">${errKind(g)}</span><span class="etype-code">${esc(g.code || '–')}${g.msg ? ` ${esc(g.msg)}` : ''}</span></span>
            <span class="etype-name">${esc(g.label)}</span>
            <span class="etype-desc">${esc(why ? why.short : (g.failure || g.msg || 'Failed'))}</span>
            <span class="etype-count"><b>${fmt.n(g.count)}</b> · ${(100 * g.count / d.totalErrors).toFixed(0)}%</span>
            <span class="etype-meta">${agentsSeen.length ? `Agent${agentsSeen.length > 1 ? 's' : ''} ${esc(agentsSeen.join(', '))} · ` : ''}${users ? `${users} user${users === 1 ? '' : 's'} · ` : ''}${new Date(g.firstTs).toLocaleTimeString('en-GB')}${g.lastTs !== g.firstTs ? `–${new Date(g.lastTs).toLocaleTimeString('en-GB')}` : ''}${ms.length ? ` · ${msHuman(Math.min(...ms))}${ms.length > 1 ? `–${msHuman(Math.max(...ms))}` : ''}` : ''}</span>
          </button>`;
        }).join('')}</div>
        <p class="hint">Failures are grouped by sampler, response code and reason, with the true count. Ten thousand identical failures still show as one row, and rare ones are never hidden.</p>
      </div>
      <div class="exview" id="exView"></div>
    </div>`;
  box.querySelectorAll('.etype').forEach((b) => (b.onclick = () => {
    errView.g = Number(b.dataset.g); errView.i = 0;
    box.querySelectorAll('.etype').forEach((x) => x.classList.toggle('on', x === b));
    renderErrExample();
  }));
  renderErrExample();
}

// Captured examples per error type can run into the thousands; the summary
// brings the first 25 and the rest are fetched in pages as you move through them.
const exTotal = (g) => (g.captured != null ? g.captured : (g.examples || []).length);
async function ensureExamples(g, upto) {
  while (g.examples.length <= upto && g.examples.length < exTotal(g)) {
    const q = new URLSearchParams(filterQs());
    q.set('label', g.label); q.set('code', g.code);
    q.set('offset', String(g.examples.length));
    q.set('limit', String(Math.min(500, Math.max(25, upto + 1 - g.examples.length))));
    const d = await api('GET', `/api/runs/${detailState.id}/error-examples?${q}`);
    if (!d.examples || !d.examples.length) break;
    g.examples.push(...d.examples);
    g._probs = null; // plan-problem checks re-run over the larger sample
  }
}

function renderErrExample() {
  const el = $('exView');
  const g = errView.d.groups[errView.g];
  const exs = g.examples || [];
  if (!exs.length) {
    el.innerHTML = `<div class="empty-state"><b>No captured example for this error type</b>
      <span>The request/response capture was lost (for example, an agent's upload failed). Run the test again to capture it.</span></div>`;
    return;
  }
  const total = exTotal(g);
  errView.i = Math.min(errView.i, total - 1);
  if (errView.i >= exs.length) { // not fetched yet
    el.querySelector('.ex-head b') ? el.querySelector('.ex-head b').insertAdjacentHTML('beforeend', ' <span class="hint" style="margin:0">loading…</span>') : (el.innerHTML = '<p class="empty">Loading example…</p>');
    ensureExamples(g, errView.i).catch(() => {}).then(() => {
      if (!errView.d || errView.d.groups[errView.g] !== g || !$('exView')) return; // moved on meanwhile
      if (errView.i >= g.examples.length) errView.i = Math.max(0, g.examples.length - 1);
      renderErrExample();
    });
    return;
  }
  const e = exs[errView.i];
  const why = explainAssertion(e.assertion || g.failure);
  const probs = planProblems(g).filter((p) => p.kind === 'same' || exParams(e).some(([k, v]) => k === p.k && v === p.v));
  const ctype = headerValue(e.responseHeaders, 'content-type');
  const body = e.responseBody || '';
  const isHtml = /html/i.test(ctype) || /^\s*</.test(body);
  const respHeaders = headerLines(e.responseHeaders);
  const reqHeaders = headerLines(e.requestHeaders);
  const statusLine = (String(e.responseHeaders || '').split(/\r?\n/)[0] || '').trim();

  // source view with the assertion's text highlighted
  const lines = body.split(/\r?\n/).slice(0, 3000);
  const needle = why && why.pattern;
  let rx = null;
  if (needle) { try { rx = new RegExp(needle); } catch { rx = null; } }
  const hitLine = (l) => !!needle && (l.includes(needle) || (rx ? rx.test(l) : false));
  const anyHit = lines.some(hitLine);

  const qParams = (() => { try { return [...new URL(e.url).searchParams.entries()]; } catch { return []; } })();
  const form = !isGet(e) ? parseForm(e.requestData) : null;
  const paramRows = (list) => list.map(([k, v]) => {
    const j = tryB64Json(v);
    const masked = SECRET_KEY.test(k);
    return `<tr><td class="pk">${esc(k)}</td><td class="pv">${masked ? '<span class="hint" style="margin:0">•••• hidden</span>' : esc(v) || '<span class="hint" style="margin:0">(empty)</span>'}
      ${v === 'NOT_FOUND' ? '<div class="pwarn">Not a real value — the variable was most likely never set.</div>' : ''}
      ${j ? `<details class="b64"><summary>Decoded from Base64 JSON · secrets hidden</summary><table class="ptable">${Object.entries(j).map(([jk, jv]) =>
        `<tr><td class="pk">${esc(jk)}</td><td class="pv">${SECRET_KEY.test(jk) ? '•••• hidden' : esc(typeof jv === 'object' ? JSON.stringify(jv) : String(jv))}</td></tr>`).join('')}</table></details>` : ''}</td></tr>`;
  }).join('');

  el.innerHTML = `
    <div class="ex-head">
      <span class="ex-nav">
        <button type="button" class="ghost mini" id="exPrev" aria-label="Previous example" ${total < 2 ? 'disabled' : ''}>‹</button>
        <b>Example <input type="number" class="ex-jump" id="exJump" min="1" max="${total}" value="${errView.i + 1}" aria-label="Example number, 1 to ${total}"> of ${fmt.n(total)}</b>
        <button type="button" class="ghost mini" id="exNext" aria-label="Next example" ${total < 2 ? 'disabled' : ''}>›</button>
        ${g.count > total ? `<span class="hint" style="margin:0">(${fmt.n(g.count)} failed; ${fmt.n(total)} captured)</span>` : ''}
      </span>
      <span class="ex-tools">
        <button type="button" class="ghost mini" id="exCurl">Copy as cURL</button>
        <button type="button" class="ghost mini" id="exAll">Download all ${fmt.n(total)}</button>
      </span>
    </div>
    <div class="ex-chips">
      <span class="ex-chip">Agent <b>${esc(e.agent)}</b></span>
      <span class="ex-chip">Virtual user <b>${esc(e.thread || '–')}</b></span>
      <span class="ex-chip">Started <b>${new Date(e.t).toLocaleTimeString('en-GB')}</b></span>
      <span class="ex-chip">Response time <b>${fmt.ms(e.elapsed)}</b></span>
      ${e.bytes ? `<span class="ex-chip">Size <b>${fmt.n(e.bytes)} bytes</b></span>` : ''}
    </div>
    ${probs.map((p) => `<div class="plan-warn">${ic('warn')}<span><b>Possible plan problem:</b> ${planProblemHtml(p, exs.length)}</span></div>`).join('')}
    ${formRejections(e).map((r) => `<div class="plan-warn">${ic('warn')}<span><b>${r.missing ? 'Possible plan problem:' : 'Form rejected:'}</b> ${formRejectionHtml(r)}</span></div>`).join('')}
    <div class="why">
      <h3>Why it failed</h3>
      ${why ? `<p>${esc(why.text)}</p><pre class="why-pat">${esc(why.pattern)}</pre>` : `<p>The server answered <b>${esc(e.code)} ${esc(e.msg)}</b>${/^\d{3}$/.test(String(e.code)) ? '' : ' — the request did not get a normal HTTP response'}.</p>`}
      ${e.assertion || g.failure ? `<p class="why-raw">JMeter message: ${esc(e.assertion || g.failure)}</p>` : ''}
    </div>
    <div class="tabbar ex-tabs" role="tablist">
      <button type="button" role="tab" data-side="resp" class="${errView.side === 'resp' ? 'on' : ''}" aria-selected="${errView.side === 'resp'}">Response</button>
      <button type="button" role="tab" data-side="req" class="${errView.side === 'req' ? 'on' : ''}" aria-selected="${errView.side === 'req'}">Request</button>
    </div>
    ${errView.side === 'resp' ? `
    <div class="ex-pane">
      <div class="ex-status"><span class="err-code">${esc(statusLine || `${e.code} ${e.msg}`)}</span>${ctype ? `<span class="hint" style="margin:0">${esc(ctype)}</span>` : ''}
        ${body && isHtml ? `<span class="seg ex-seg"><button type="button" data-body="source" class="${errView.body === 'source' ? 'active' : ''}">Source</button><button type="button" data-body="preview" class="${errView.body === 'preview' ? 'active' : ''}">Preview</button></span>` : ''}</div>
      ${!body ? '<p class="hint">The response had no body.</p>'
        : isHtml && errView.body === 'preview'
          ? `<iframe class="ex-preview" sandbox="" title="Response preview" srcdoc="${esc(previewDoc(body))}"></iframe>
             <p class="hint">Rendered safely in a sandbox · scripts and images from the target are blocked.</p>`
          : `<ol class="ex-src">${lines.map((l) => `<li${hitLine(l) ? ' class="hit"' : ''}><code>${esc(l) || ' '}</code></li>`).join('')}</ol>
             ${anyHit ? '<p class="hint">Highlighted: the line that matched the assertion.</p>' : ''}`}
      ${respHeaders.length ? `<details class="ex-det"><summary>Response headers <span class="count-pill">${respHeaders.length}</span></summary>
        <table class="ptable">${respHeaders.map(([k, v]) => `<tr><td class="pk">${esc(k)}</td><td class="pv">${esc(v)}</td></tr>`).join('')}</table></details>` : ''}
    </div>` : `
    <div class="ex-pane">
      <div class="req-line"><span class="req-method">${esc((e.method || 'GET').toUpperCase())}</span><span class="req-url">${esc(e.url || '(URL not captured)')}</span></div>
      ${qParams.length ? `<h4>Query parameters</h4><table class="ptable">${paramRows(qParams)}</table>` : ''}
      ${!isGet(e) ? (form ? `<h4>Form fields</h4><table class="ptable">${paramRows(form)}</table>`
        : e.requestData ? `<h4>Request body</h4><pre class="resp-body">${esc(e.requestData)}</pre>` : '<p class="hint">Request body: none.</p>') : ''}
      ${reqHeaders.length ? `<details class="ex-det"><summary>Request headers <span class="count-pill">${reqHeaders.length}</span></summary>
        <table class="ptable">${reqHeaders.map(([k, v]) => `<tr><td class="pk">${esc(k)}</td><td class="pv">${esc(v)}</td></tr>`).join('')}</table></details>` : ''}
      ${(() => {
        const cookies = String(e.cookies || '').split(/;\s*/).map((c) => c.trim()).filter(Boolean)
          .map((c) => { const i = c.indexOf('='); return i > 0 ? [c.slice(0, i), c.slice(i + 1)] : [c, '']; });
        return cookies.length
          ? `<details class="ex-det"><summary>Cookies sent <span class="count-pill">${cookies.length}</span></summary>
              <table class="ptable">${cookies.map(([k, v]) => `<tr><td class="pk">${esc(k)}</td><td class="pv">${esc(v)}</td></tr>`).join('')}</table></details>`
          : '<p class="hint">Cookies sent: none.</p>';
      })()}
      ${isGet(e) ? '<p class="hint">Request body: none (GET).</p>' : ''}
    </div>`}`;

  const go = (d) => { errView.i = (errView.i + d + total) % total; renderErrExample(); };
  $('exJump').onchange = () => {
    const n = Math.round(Number($('exJump').value));
    errView.i = Math.min(total, Math.max(1, Number.isFinite(n) ? n : 1)) - 1;
    renderErrExample();
  };
  $('exPrev').onclick = () => go(-1);
  $('exNext').onclick = () => go(1);
  el.querySelectorAll('[data-side]').forEach((b) => (b.onclick = () => { errView.side = b.dataset.side; renderErrExample(); }));
  el.querySelectorAll('[data-body]').forEach((b) => (b.onclick = () => { errView.body = b.dataset.body; renderErrExample(); }));
  $('exCurl').onclick = () => copyText(toCurl(e)).then(() => flash($('exCurl'), 'Copied ✓')).catch(() => alert(toCurl(e)));
  $('exAll').onclick = async () => {
    const btn = $('exAll');
    btn.disabled = true; btn.textContent = 'Preparing…';
    try { await ensureExamples(g, total - 1); } catch (err) { alert(`Could not fetch every example: ${err.message}`); }
    btn.disabled = false; btn.textContent = `Download all ${fmt.n(total)}`;
    const blob = new Blob([JSON.stringify(g.examples, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `errors-${(g.label || 'sampler').replace(/[^\w.-]+/g, '_')}-${g.code || 'x'}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  };
}


// ---------------- report: run-page section ----------------

const reportState = { list: [], current: null, activeSheet: 'main' };

async function loadReportsForRunPage() {
  reportState.list = await api('GET', '/api/reports');
  if (!reportState.list.length) {
    const def = await api('GET', '/api/reports/default');
    reportState.list = [{ id: def.id, name: def.name }];
  }
  const sel = $('reportSel');
  sel.innerHTML = reportState.list.map((r) => `<option value="${r.id}">${esc(r.name)}</option>`).join('');
  renderReportAssign();
}

$('reportEnable').onchange = () => {
  $('reportOpts').style.display = $('reportEnable').checked ? 'block' : 'none';
  if ($('reportEnable').checked && !$('reportSel').options.length) loadReportsForRunPage();
  if ($('reportEnable').checked) { $('reportAction').value = $('reportAction').value || (state.plan ? state.plan.name : ''); renderReportAssign(); }
};
$('reportSel').onchange = renderReportAssign;

async function renderReportAssign() {
  const box = $('reportAssign');
  if (!$('reportEnable').checked) return;
  const rid = $('reportSel').value;
  if (!rid) { box.innerHTML = ''; return; }
  const rep = await api('GET', `/api/reports/${rid}`);
  const agents = selectedAgents();
  if (!agents.length) { box.innerHTML = '<span class="hint">Select load-generator PCs above first.</span>'; return; }
  box.innerHTML = agents.map((a) => `
    <div class="assign-row">
      <span class="assign-agent">${esc(a)}</span> →
      <select class="assign-person" data-agent="${esc(a)}">
        <option value="">— skip —</option>
        ${rep.people.map((p) => `<option value="${p.id}">${esc(p.name)}${p.agent ? ` (${esc(p.agent)})` : ''}</option>`).join('')}
      </select>
    </div>`).join('') +
    `<button class="ghost mini" id="quickAddPerson" style="margin-top:6px;">+ New person for an agent</button>`;
  // auto-select a person whose saved agent matches this agent name
  box.querySelectorAll('.assign-person').forEach((sel) => {
    const match = rep.people.find((p) => p.agent === sel.dataset.agent);
    if (match) sel.value = match.id;
  });
  const q = $('quickAddPerson');
  if (q) q.onclick = async () => {
    const name = prompt('Person / sheet name:');
    if (!name) return;
    await api('POST', `/api/reports/${rid}/people`, { name });
    renderReportAssign();
  };
}

function reportConfigFromForm() {
  if (!$('reportEnable').checked) return undefined;
  const assignments = {};
  document.querySelectorAll('.assign-person').forEach((sel) => { if (sel.value) assignments[sel.dataset.agent] = sel.value; });
  const s = state.plan.structure;
  // main thread group (largest, non setUp/tearDown) drives thread/ramp/loop
  const mainTg = s.threadGroups.find((t) => t.editable && t.tag !== 'SetupThreadGroup' && t.tag !== 'PostThreadGroup' && $(`tgEn-${t.id}`) && $(`tgEn-${t.id}`).checked);
  const cfg = { enabled: true, reportId: $('reportSel').value, action: $('reportAction').value, assignments };
  if (mainTg) {
    cfg.thread = parseInt($(`tgThreads-${mainTg.id}`).value, 10) || '';
    cfg.rampTime = parseInt($(`tgRamp-${mainTg.id}`).value, 10) || '';
    // bzm rate/concurrency groups have no loop-count field (they use ramp/steps/hold)
    if (mainTg.kind === 'arrivals' || mainTg.kind === 'concurrency') {
      cfg.loop = '';
    } else {
      const modeEl = $(`tgMode-${mainTg.id}`);
      const mode = modeEl ? modeEl.value : 'loops';
      cfg.loop = mode === 'loops' ? (parseInt($(`tgVal-${mainTg.id}`).value, 10) || '') : '';
    }
    cfg.totalThread = cfg.thread;
  }
  return cfg;
}

// ---------------- report: full Report page ----------------

async function loadReportView() {
  const list = await api('GET', '/api/reports');
  if (!list.length) { await api('GET', '/api/reports/default'); return loadReportView(); }
  const pick = $('reportPick');
  const keep = reportState.current && reportState.current.id;
  pick.innerHTML = list.map((r) => `<option value="${r.id}" ${r.id === keep ? 'selected' : ''}>${esc(r.name)} (${r.rows} rows)</option>`).join('');
  const id = pick.value || list[0].id;
  reportState.current = await api('GET', `/api/reports/${id}`);
  renderReport();
}

$('reportPick').onchange = async () => {
  reportState.current = await api('GET', `/api/reports/${$('reportPick').value}`);
  reportState.activeSheet = 'main';
  renderReport();
};
$('reportNew').onclick = async () => {
  const name = prompt('New report name:', 'Load Test Report');
  if (!name) return;
  const r = await api('POST', '/api/reports', { name });
  reportState.current = r; reportState.activeSheet = 'main';
  await loadReportView();
};
$('reportRename').onclick = async () => {
  const name = prompt('Rename report:', reportState.current.name);
  if (!name) return;
  await api('PATCH', `/api/reports/${reportState.current.id}`, { name });
  loadReportView();
};
$('addPerson').onclick = async () => {
  const name = prompt('Person / sheet name:');
  if (!name) return;
  reportState.current = await api('POST', `/api/reports/${reportState.current.id}/people`, { name });
  renderReport();
};
$('addRow').onclick = async () => {
  reportState.current = await api('POST', `/api/reports/${reportState.current.id}/rows`, { action: '' });
  renderReport();
};
$('addInfraCol').onclick = async () => {
  const label = prompt('Column name (extra infra/metric column):');
  if (!label) return;
  const cols = [...(reportState.current.infraCols || []), { key: 'c_' + Date.now().toString(36), label }];
  reportState.current = await api('PATCH', `/api/reports/${reportState.current.id}`, { infraCols: cols });
  renderReport();
};
$('exportXlsx').onclick = () => { $('exportXlsx').href = `/api/reports/${reportState.current.id}/export.xlsx`; };
$('exportCsv').onclick = () => { $('exportCsv').href = `/api/reports/${reportState.current.id}/export.csv`; };
$('printReport').onclick = () => printReport();

// Print the whole report — Main Report + every person sheet, as static tables.
function printReport() {
  const r = reportState.current;
  if (!r) return;
  const activeBefore = reportState.activeSheet;
  // inputs become plain text nodes (escaped on serialising — an attribute value
  // keeps its < and > raw, so copying it out as HTML would run typed-in markup)
  const sheetTable = (sheet) => {
    reportState.activeSheet = sheet; renderReport();
    const grid = $('reportGrid').cloneNode(true);
    grid.querySelectorAll('input').forEach((i) => i.replaceWith(document.createTextNode(i.value)));
    grid.querySelectorAll('button, .col-del').forEach((b) => b.remove());
    return grid.innerHTML;
  };
  const parts = [`<h2>Main Report</h2>${sheetTable('main')}`];
  for (const p of r.people) parts.push(`<h2>${esc(p.name)}</h2>${sheetTable(p.id)}`);
  reportState.activeSheet = activeBefore; renderReport();

  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.name)}</title>
    <style>
      body{font:12px/1.4 Segoe UI,system-ui,sans-serif;color:#111;margin:20px;}
      h1{font-size:17px;margin:0 0 12px;} h2{font-size:13px;margin:16px 0 6px;}
      table{border-collapse:collapse;font-size:10.5px;margin-bottom:6px;}
      th,td{border:1px solid #bbb;padding:2px 5px;white-space:nowrap;text-align:right;}
      th:first-child,td:first-child{text-align:left;} th{background:#eef2f9;}
      @page{size:landscape;} @media print{button{display:none;}}
    </style></head><body><h1>${esc(r.name)}</h1>${parts.join('')}
    <script>window.onload=()=>setTimeout(()=>window.print(),300);<\/script></body></html>`;
  const w = window.open('', '_blank');
  if (!w) { alert('Allow pop-ups to print.'); return; }
  w.document.write(html); w.document.close();
}

function renderReport() {
  const r = reportState.current;
  if (!r) return;
  // sheet tabs: Main Report + each person
  $('reportTabs').innerHTML =
    `<button class="rtab ${reportState.activeSheet === 'main' ? 'active' : ''}" data-sheet="main">Main Report</button>` +
    r.people.map((p) => `<button class="rtab ${reportState.activeSheet === p.id ? 'active' : ''}" data-sheet="${p.id}">${esc(p.name)}</button>`).join('');
  document.querySelectorAll('.rtab').forEach((b) => b.onclick = () => { reportState.activeSheet = b.dataset.sheet; renderReport(); });
  $('reportGrid').innerHTML = reportState.activeSheet === 'main' ? mainSheetHtml(r) : personSheetHtml(r, reportState.activeSheet);
  wireReportEdits();
}

function editTd(rowId, field, value, opts = {}) {
  return `<td><input class="rcell" data-row="${rowId}" data-field="${field}" value="${esc(value == null ? '' : value)}" ${opts.num ? 'type="number"' : ''} style="width:${opts.w || 90}px"></td>`;
}
function aggTd(v, cls = '') { return `<td class="num agg ${cls}">${v == null || v === '' ? '' : fmt.n(v)}</td>`; }

function mainSheetHtml(r) {
  const infra = r.infraCols || [];
  return `<div style="overflow-x:auto"><table class="report-grid">
    <thead><tr>
      <th>Date Time</th><th>Action</th><th>Iteration</th><th>Thread</th><th>Ramp Time</th><th>Loop</th>
      <th class="agg-h">Person Cnt</th><th class="agg-h">Sample Sum</th><th>Total Thread</th>
      <th class="agg-h">Time (h:m:s)</th><th class="agg-h">Error Count</th><th class="agg-h">Error Rate %</th><th class="agg-h">Throughput</th>
      ${infra.map((c) => `<th class="infra-h" data-col="${c.key}">${esc(c.label)} <span class="col-del" data-col="${c.key}" title="delete column">✕</span></th>`).join('')}
      <th></th>
    </tr></thead>
    <tbody>${r.rows.map((row) => `<tr>
      <td class="dt">${fmt.ymd(row.dateTime)}</td>
      ${editTd(row.id, 'action', row.action, { w: 120 })}
      ${editTd(row.id, 'iteration', row.iteration, { w: 60 })}
      ${editTd(row.id, 'thread', row.thread, { num: true, w: 70 })}
      ${editTd(row.id, 'rampTime', row.rampTime, { num: true, w: 70 })}
      ${editTd(row.id, 'loop', row.loop, { num: true, w: 60 })}
      ${aggTd(row.agg.personCount)}${aggTd(row.agg.samplesSum)}
      ${editTd(row.id, 'totalThread', row.totalThread, { num: true, w: 80 })}
      <td class="num agg">${fmt.dur(row.agg.avgTime)}</td>${aggTd(row.agg.errorCount, 'err')}
      <td class="num agg ${row.agg.errorRatePct > 0 ? 'err' : ''}">${row.agg.errorRatePct}%</td>${aggTd(row.agg.throughput)}
      ${infra.map((c) => `<td><input class="rcell" data-row="${row.id}" data-infra="${c.key}" value="${esc((row.infra || {})[c.key] || '')}" style="width:90px"></td>`).join('')}
      <td><button class="ghost mini row-del-r" data-row="${row.id}">✕</button></td>
    </tr>`).join('')}</tbody>
  </table></div>
  ${r.rows.length ? '' : '<p class="empty">No rows yet. Run a test with “Add to report”, or click “+ Add row”.</p>'}`;
}

function personSheetHtml(r, pid) {
  const person = r.people.find((p) => p.id === pid);
  if (!person) return '';
  return `
    <div style="display:flex; gap:12px; align-items:flex-end; margin-bottom:10px; flex-wrap:wrap;">
      <label class="field">Sheet / person name<input type="text" id="pName" value="${esc(person.name)}"></label>
      <label class="field">Linked agent<input type="text" id="pAgent" value="${esc(person.agent || '')}" placeholder="agent name (auto-fills this sheet)"></label>
      <button class="ghost mini" id="savePerson">Save</button>
      <button class="ghost mini danger-text" id="delPerson">Delete sheet</button>
    </div>
    <div style="overflow-x:auto"><table class="report-grid">
      <thead><tr><th>Date Time</th><th>Action</th><th>Thread</th><th>Ramp Time</th><th>Loop</th>
        <th>Error Count</th><th>Error Rate %</th><th>Throughput</th><th>Time</th><th>individual Thread</th></tr></thead>
      <tbody>${r.rows.map((row) => {
        const c = (row.cells || {})[pid] || {};
        const cell = (field, w = 80) => `<td><input class="pcell" data-row="${row.id}" data-person="${pid}" data-field="${field}" value="${esc(c[field] == null ? '' : c[field])}" style="width:${w}px"></td>`;
        // Time cell shows HH:MM:SS; edits accept HH:MM:SS or plain seconds.
        const timeCell = `<td><input class="pcell ptime" data-row="${row.id}" data-person="${pid}" data-field="time" value="${c.time == null || c.time === '' ? '' : fmt.dur(c.time)}" style="width:80px"></td>`;
        return `<tr>
          <td class="dt">${fmt.ymd(row.dateTime)}</td><td>${esc(row.action)}</td>
          <td class="num">${esc(row.thread)}</td><td class="num">${esc(row.rampTime)}</td><td class="num">${esc(row.loop)}</td>
          ${cell('errorCount')}${cell('errorRatePct')}${cell('throughput')}${timeCell}${cell('samples')}
        </tr>`;
      }).join('')}</tbody>
    </table></div>`;
}

function wireReportEdits() {
  const rid = reportState.current.id;
  const refresh = async (promise) => { reportState.current = await promise; renderReport(); };

  document.querySelectorAll('.rcell').forEach((inp) => {
    inp.onchange = () => {
      const patch = inp.dataset.infra ? { infra: { [inp.dataset.infra]: inp.value } } : { [inp.dataset.field]: inp.value };
      api('PATCH', `/api/reports/${rid}/rows/${inp.dataset.row}`, patch).then((r) => { reportState.current = r; if (inp.dataset.field && ['thread','rampTime','loop','action'].includes(inp.dataset.field)) renderReport(); });
    };
  });
  document.querySelectorAll('.pcell').forEach((inp) => {
    inp.onchange = () => {
      const val = inp.classList.contains('ptime') ? parseHMS(inp.value) : num(inp.value);
      refresh(api('PATCH', `/api/reports/${rid}/rows/${inp.dataset.row}`, { cells: { [inp.dataset.person]: { [inp.dataset.field]: val } } }));
    };
  });
  document.querySelectorAll('.row-del-r').forEach((b) => b.onclick = () => { if (confirm('Delete this row?')) refresh(api('DELETE', `/api/reports/${rid}/rows/${b.dataset.row}`)); });
  document.querySelectorAll('.col-del').forEach((b) => b.onclick = () => {
    if (!confirm('Delete this column?')) return;
    const cols = reportState.current.infraCols.filter((c) => c.key !== b.dataset.col);
    refresh(api('PATCH', `/api/reports/${rid}`, { infraCols: cols }));
  });
  const sp = $('savePerson');
  if (sp) sp.onclick = () => refresh(api('PATCH', `/api/reports/${rid}/people/${reportState.activeSheet}`, { name: $('pName').value, agent: $('pAgent').value }));
  const dp = $('delPerson');
  if (dp) dp.onclick = () => {
    const pid = reportState.activeSheet;
    if (confirm('Delete this person sheet?')) { reportState.activeSheet = 'main'; refresh(api('DELETE', `/api/reports/${rid}/people/${pid}`)); }
  };
}

function num(v) { const n = Number(v); return v === '' || v == null || isNaN(n) ? v : n; }
// Parse a Time entry: "HH:MM:SS" / "MM:SS" → seconds; plain number → seconds.
function parseHMS(v) {
  const s = String(v == null ? '' : v).trim();
  if (s === '') return '';
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s);
  const parts = s.split(':').map(Number);
  if (parts.some((p) => isNaN(p))) return v;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

// ---------------- agents view ----------------

// Compact live CPU/RAM meter. Turns amber ≥75%, red ≥90% — a red generator is
// saturated, so its response times reflect the agent PC, not the target.
function resMeterInner(res) {
  if (!res || res.cpu == null) return '<span class="hint" style="margin:0">—</span>';
  const pct = (v) => Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
  res = { cpu: pct(res.cpu), mem: pct(res.mem), memUsedGB: Number(res.memUsedGB) || 0, memTotalGB: Number(res.memTotalGB) || 0 };
  const lvl = (v) => (v >= 90 ? 'crit' : v >= 75 ? 'warn' : 'ok');
  const one = (k, v, title) => `<span class="resm-item ${lvl(v)}" title="${title}"><span class="resm-k">${k}</span><span class="resm-bar"><span style="width:${v}%"></span></span><span class="resm-v">${v}%</span></span>`;
  return `${one('CPU', res.cpu, `CPU ${res.cpu}%`)}${one('RAM', res.mem, `RAM ${res.memUsedGB} / ${res.memTotalGB} GB`)}`;
}
function resMeter(res, agentName) {
  return `<span class="resm"${agentName ? ` data-agent="${esc(agentName)}"` : ''}>${resMeterInner(res)}</span>`;
}
// Update every on-screen meter in place from state.agents — no DOM rebuild, so
// open dropdowns / inputs are never disturbed by the 2s resource stream.
function updateResMeters() {
  const byName = new Map((state.agents || []).map((a) => [a.name, a.res]));
  document.querySelectorAll('.resm[data-agent]').forEach((el) => {
    el.innerHTML = resMeterInner(byName.get(el.dataset.agent));
  });
}

// ---------------- Agents & teams page ----------------

const fleetSel = new Set(); // agent names ticked in the Agents tab

async function loadFleet() {
  try { state.teams = await api('GET', '/api/teams'); } catch { /* keep */ }
  renderAgents();
  $('fleetCtrlUrl').textContent = await controllerUrl();
  if ($('fleet-teams').classList.contains('active')) loadTeamView();
  if ($('fleet-network').classList.contains('active')) loadAgentDir();
}

function fleetTab(name) {
  document.querySelectorAll('#view-fleet .tabbar [data-ftab]').forEach((b) => {
    const on = b.dataset.ftab === name;
    b.classList.toggle('on', on);
    b.setAttribute('aria-selected', on ? 'true' : 'false');
  });
  ['agents', 'teams', 'network'].forEach((t) => $(`fleet-${t}`).classList.toggle('active', t === name));
  if (name === 'teams') loadTeamView();
  if (name === 'network') loadAgentDir();
}
document.querySelectorAll('#view-fleet .tabbar [data-ftab]').forEach((b) => (b.onclick = () => fleetTab(b.dataset.ftab)));
$('fleetAddBtn').onclick = () => {
  const box = $('fleetAddBox');
  box.hidden = !box.hidden;
  $('fleetAddBtn').setAttribute('aria-expanded', String(!box.hidden));
};

function agentStatusBadge(a) {
  if (a.state === 'idle') return '<span class="rbadge ok">Idle</span>';
  if (a.state === 'running' || a.state === 'preparing') return '<span class="rbadge live">Running a test</span>';
  return `<span class="rbadge neutral">${esc(a.state || 'Unknown')}</span>`;
}

function renderAgents() {
  const agents = state.agents || [];
  const teamsOf = (name) => (state.teams || []).filter((t) => t.agents.includes(name)).map((t) => t.name);
  [...fleetSel].forEach((n) => { if (!agents.some((a) => a.name === n)) fleetSel.delete(n); });
  $('agentEmpty').hidden = agents.length > 0;
  $('agentRows').innerHTML = agents.map((a) => `
    <tr${fleetSel.has(a.name) ? ' class="sel"' : ''}>
      <td class="sel-col"><input type="checkbox" class="fleetCb" value="${esc(a.name)}" ${fleetSel.has(a.name) ? 'checked' : ''} aria-label="Select ${esc(a.name)}"></td>
      <td><b>${esc(a.name)}</b>${a.stub ? ' <span class="rbadge neutral">Test stub</span>' : ''}</td>
      <td class="mono-cell">${esc(a.address || '–')}</td>
      <td>${agentStatusBadge(a)}</td>
      <td class="nowrap">${Number(a.cpus) || 0} cores · ${Number(a.memGB) || 0} GB</td>
      <td>${resMeter(a.res, a.name)}</td>
      <td>${a.jmeterReady ? 'Ready' : '<span class="hint" style="margin:0">Downloads on first run</span>'}</td>
      <td>${teamsOf(a.name).map((t) => `<span class="team-chip">${esc(t)}</span>`).join(' ') || '<span class="hint" style="margin:0">—</span>'}</td>
      <td><button type="button" class="ghost mini agent-stop" data-name="${esc(a.name)}" title="Stops the agent program on that PC. Start it there again (or restart the PC) to bring it back.">Stop agent</button></td>
    </tr>`).join('');
  $('agentRows').querySelectorAll('.fleetCb').forEach((cb) => (cb.onchange = () => {
    if (cb.checked) fleetSel.add(cb.value); else fleetSel.delete(cb.value);
    cb.closest('tr').classList.toggle('sel', cb.checked);
    updateFleetBulk();
  }));
  $('agentRows').querySelectorAll('.agent-stop').forEach((b) => (b.onclick = () => stopAgent(b.dataset.name)));

  const busy = agents.filter((a) => a.state !== 'idle').length;
  const pcs = new Set(agents.map((a) => a.address).filter(Boolean)).size;
  $('fleetStats').innerHTML = `
    <span class="fstat"><b>${agents.length}</b> online</span>
    <span class="fstat"><b>${busy}</b> running a test</span>
    <span class="fstat"><b>${pcs}</b> PC${pcs === 1 ? '' : 's'}</span>`;
  $('ftabAgents').textContent = `Agents · ${agents.length}`;
  $('ftabTeams').textContent = `Teams · ${(state.teams || []).length}`;
  updateFleetBulk();
}

function updateFleetBulk() {
  const n = fleetSel.size;
  const all = (state.agents || []).length;
  $('fleetBulk').hidden = n === 0;
  $('fleetSelAll').checked = all > 0 && n === all;
  $('fleetSelCount').innerHTML = `<b>${n}</b> selected`;
  const cur = $('fleetTeamPick').value;
  $('fleetTeamPick').innerHTML = (state.teams || []).map((t) => `<option value="${esc(t.id)}">${esc(t.name)}</option>`).join('') +
    '<option value="__new">New team…</option>';
  if ([...$('fleetTeamPick').options].some((o) => o.value === cur)) $('fleetTeamPick').value = cur;
}
$('fleetSelAll').onchange = () => {
  fleetSel.clear();
  if ($('fleetSelAll').checked) (state.agents || []).forEach((a) => fleetSel.add(a.name));
  renderAgents();
};
$('fleetClearSel').onclick = () => { fleetSel.clear(); renderAgents(); };
$('fleetAddToTeam').onclick = async () => {
  const names = [...fleetSel];
  if (!names.length) return;
  const pick = $('fleetTeamPick').value;
  try {
    let team;
    if (pick === '__new') {
      const name = (prompt('Name for the new team:') || '').trim();
      if (!name) return;
      team = await api('POST', '/api/teams', { name, agents: names });
      state.teams.push(team);
    } else {
      const t = state.teams.find((x) => x.id === pick);
      if (!t) return;
      team = await api('PUT', `/api/teams/${t.id}`, { name: t.name, agents: [...new Set([...t.agents, ...names])] });
      state.teams[state.teams.findIndex((x) => x.id === t.id)] = team;
    }
    $('fleetBulkMsg').textContent = `✓ Added ${names.length} agent${names.length === 1 ? '' : 's'} to “${team.name}”`;
    setTimeout(() => { $('fleetBulkMsg').textContent = ''; }, 3000);
    fleetSel.clear();
    renderAgents();
    populateTeamSelect();
    if ($('fleet-teams').classList.contains('active')) { renderTeamForm(); renderTeamList(); }
  } catch (e) { $('fleetBulkMsg').textContent = `✗ ${e.message}`; }
};

async function stopAgent(name) {
  if (!confirm(`Stop agent "${name}"?\nIts program exits on that PC. Start it there again (or restart the PC) to bring it back.`)) return;
  try { await api('POST', `/api/agents/${encodeURIComponent(name)}/shutdown`); } catch (e) { alert(`Failed: ${e.message}`); }
}

// "Use in a new run": tick exactly this team's agents in step 3.
function useTeamInNewRun(team) {
  state.agentChoice = new Set(team.agents);
  if (state.plan) renderAgentPick();
  showView('new');
  if (state.plan) {
    wizGo(3);
    if ($('loadTeamSel')) $('loadTeamSel').value = team.id;
    $('teamLoadNote').textContent = `✓ loaded "${team.name}"`;
  } else {
    $('wizHint').textContent = `Team “${team.name}” will be selected in step 3 — choose a plan first.`;
  }
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- Home: is the lab ready, what ran recently, how is the fleet ----------------

const homeState = { runs: [] };

function agoText(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso)) / 1000);
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const hr = Math.round(m / 60);
  if (hr < 24) return `${hr} hour${hr === 1 ? '' : 's'} ago`;
  const d = Math.round(hr / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}
function dayWord(iso) {
  const d = new Date(iso), today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
}

async function loadHome() {
  await ensureSla();
  if (!state.agents.length) { try { state.agents = await api('GET', '/api/agents'); } catch { /* not up yet */ } }
  try { homeState.runs = await api('GET', '/api/runs'); } catch { /* keep the last list */ }
  renderHome();
}

function renderHome() {
  const runs = homeState.runs || [];
  const agents = state.agents || [];
  const active = (state.run && isActiveRun(state.run)) ? state.run : runs.find(isActiveRun);
  const last = runs.find((r) => isEndedRun(r) && r.overall);
  const idle = agents.filter((a) => a.state === 'idle').length;
  const busy = agents.length - idle;

  // ---- status banner ----
  let title, text, actions;
  if (active) {
    title = 'A test is running';
    text = `${esc(active.planName || 'A run')} started ${agoText(active.createdAt)} on ${(active.agents || []).length} agent${(active.agents || []).length === 1 ? '' : 's'}.`;
    actions = '<button type="button" class="primary" id="homeLive">Open live monitor</button>';
  } else if (!agents.length) {
    title = 'No agents connected';
    text = 'Install the agent on a worker PC, or bring existing agents to this controller.';
    actions = '<button type="button" class="primary" id="homeFleetBtn">Add an agent PC</button>';
  } else {
    const v = last ? slaVerdict(last) : null;
    title = idle ? 'Ready to run' : 'Every agent is busy';
    text = `${idle === agents.length ? `All ${agents.length} agent${agents.length === 1 ? ' is' : 's are'} online and idle.` : `${idle} of ${agents.length} agents are idle.`}` +
      (last ? ` The last run finished ${agoText(last.endedAt || last.createdAt)}${v === 'pass' ? ' and passed its SLA' : v === 'fail' ? ' and failed its SLA' : ''}.` : '');
    actions = `${last && last.planId ? '<button type="button" class="ghost" id="homeRepeat">Repeat last run</button>' : ''}
      <button type="button" class="primary" id="homeNew">New run</button>`;
  }
  const tone = active ? 'live' : !agents.length ? 'warn' : idle ? 'ok' : 'live';
  $('homeBanner').className = `card home-banner ${tone}`;
  $('homeBanner').innerHTML = `<span class="hb-dot" aria-hidden="true"></span>
    <div class="hb-text"><h2>${title}</h2><p>${text}</p></div>
    <div class="hb-actions">${actions}</div>`;
  if ($('homeLive')) $('homeLive').onclick = () => showView('live');
  if ($('homeFleetBtn')) $('homeFleetBtn').onclick = () => { showView('fleet'); $('fleetAddBox').hidden = false; };
  if ($('homeNew')) $('homeNew').onclick = () => showView('new');
  if ($('homeRepeat')) $('homeRepeat').onclick = () => runAgain(last, $('homeRepeat'));

  // ---- KPI tiles ----
  const today = new Date().toDateString();
  const todays = runs.filter((r) => new Date(r.createdAt).toDateString() === today);
  const passT = todays.filter((r) => runResult(r) === 'pass').length;
  const failT = todays.filter((r) => runResult(r) === 'fail').length;
  const otherT = todays.length - passT - failT;
  const lo = last && last.overall;
  const lv = last ? slaVerdict(last) : null;
  const maxErr = slaThresholds && slaThresholds.maxErrorPct;
  $('homeKpis').innerHTML = [
    { k: 'Agents online', v: fmt.n(agents.length), sub: !agents.length ? 'None connected' : busy ? `${busy} running a test` : 'All idle' },
    { k: 'Runs today', v: fmt.n(todays.length), sub: todays.length ? [passT && `${passT} passed`, failT && `${failT} failed SLA`, otherT && `${otherT} other`].filter(Boolean).join(' · ') : 'None yet' },
    { k: 'Last run throughput', v: lo ? `${lo.throughput} req/s` : '–', sub: lo ? `${fmt.n(lo.samples)} requests in ${durHuman(last.durationSec)}` : '' },
    { k: 'Last run error rate', v: lo ? `${lo.errorPct}%` : '–', tone: lv === 'fail' ? 'bad' : '',
      sub: lo ? `${fmt.n(lo.errors)} error${lo.errors === 1 ? '' : 's'}${maxErr != null ? ` · ${lo.errorPct <= maxErr ? 'inside' : 'over'} the ${maxErr}% SLA` : ''}` : '' },
  ].map(kpiCard).join('');

  // ---- recent runs ----
  const recent = runs.slice(0, 6);
  $('homeRunsEmpty').hidden = recent.length > 0;
  $('homeRuns').innerHTML = recent.map((r) => {
    const o = r.overall;
    const users = runVUsers(r);
    const target = (r.targets || [])[0];
    return `<tr data-id="${esc(r.id)}">
      <td class="run-time"><b>${new Date(r.createdAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}</b><span class="run-target" style="font-family:inherit">${dayWord(r.createdAt)}</span></td>
      <td><a class="run-link" href="#run/${encodeURIComponent(r.id)}">${esc(r.planName || r.id)}</a>${target ? `<span class="run-target">${esc(target)}</span>` : ''}</td>
      <td>${resultBadge(r)}</td>
      <td class="num">${users != null ? fmt.n(users) : '–'}</td>
      <td class="num">${o ? o.throughput : '–'}</td>
      <td class="num${o && o.errorPct > 0 ? ' err-txt' : ''}">${o ? `${o.errorPct}%` : '–'}</td>
    </tr>`;
  }).join('');
  $('homeRuns').querySelectorAll('tr[data-id]').forEach((tr) => (tr.onclick = (e) => {
    if (e.target.closest('a') && (e.ctrlKey || e.metaKey || e.shiftKey)) return;
    e.preventDefault();
    openRun(tr.dataset.id);
  }));

  // ---- fleet health: one row per PC ----
  const byPc = new Map();
  for (const a of agents) {
    const k = a.address || a.name;
    if (!byPc.has(k)) byPc.set(k, []);
    byPc.get(k).push(a);
  }
  $('homeFleet').innerHTML = byPc.size ? [...byPc].map(([ip, list]) => {
    const base = list.map((a) => a.name.replace(/[-_ ]?\d+$/, '')).sort((x, y) => x.length - y.length)[0] || list[0].name;
    const running = list.some((a) => a.state !== 'idle');
    return `<div class="pc-row">
      <div class="pc-main"><b>${esc(base)} PC</b> <span class="hint" style="margin:0">${list.length} agent${list.length === 1 ? '' : 's'}</span>
        <div class="pc-sub"><span class="mono">${esc(ip)}</span> · ${running ? '<span class="pc-busy">Running a test</span>' : 'Idle'}</div></div>
      <div class="pc-res">${resMeter(list[0].res, list[0].name)}</div>
    </div>`;
  }).join('') : '<div class="empty-state"><b>No agents connected</b><span>Agents appear here as soon as they connect.</span></div>';
}

// ---------------- boot: restore state on page load ----------------

// A reload / bookmark / link (#runs, #run/<id>…) opens that page straight away.
const startHash = location.hash.slice(1);
if (startHash) routeFromHash();
else showView('home', { replace: true });

(async () => {
  try {
    state.agents = await api('GET', '/api/agents');
    renderAgents();
    try { state.teams = await api('GET', '/api/teams'); populateTeamSelect(); } catch { /* teams optional */ }
    state.library = (await api('GET', '/api/library')).files || [];
    await ensureSla(); // result badges (Passed / Failed SLA) need the limits
    const runs = await api('GET', '/api/runs');
    const active = runs.find((r) => r.state === 'running' || r.state === 'finalizing');
    if (active) {
      onRunUpdate(active);
      if (!startHash) showView('live', { replace: true });
    } else if (runs.length) {
      // Live tab shows the most recent run's results instead of an empty page.
      onRunUpdate(runs[0]);
      loadFinalIntoLive(runs[0].id);
    }
  } catch { /* server starting up */ }
})();

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
  $('themeBtn').textContent = dark ? '☀️' : '🌙';
  // charts hold resolved colors — repaint them against the new palette
  document.querySelectorAll('canvas.chart').forEach((c) => { if (c._chart) redraw(c); });
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

$('settingsBtn').onclick = async () => {
  $('settingsMsg').textContent = '';
  try {
    const s = await api('GET', '/api/settings');
    $('settingsEditable').innerHTML = Object.entries(s.editable).map(([k, v]) => `
      <div class="settings-field">
        <label>${SETTING_LABELS[k] || k}</label>
        <input data-setting="${k}" value="${esc(v)}">
      </div>`).join('');
    $('settingsDerived').innerHTML = Object.entries(s.derived).map(([k, v]) =>
      `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('');
    loadSheetsSettings();
    loadAgentDir();
    $('settingsOverlay').style.display = 'flex';
  } catch (e) {
    alert(`Could not load settings: ${e.message}`);
  }
};

$('settingsClose').onclick = () => { $('settingsOverlay').style.display = 'none'; };
$('settingsOverlay').onclick = (e) => { if (e.target === $('settingsOverlay')) $('settingsOverlay').style.display = 'none'; };

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
    note.innerHTML = '— set up Google Sheets in <b>Settings ⚙</b> first';
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

document.querySelectorAll('nav button').forEach((b) => {
  b.onclick = () => showView(b.dataset.view);
});

function showView(name) {
  document.querySelectorAll('nav button').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${name}`));
  if (name === 'history') loadHistory();
  if (name === 'report') loadReportView();
  if (name === 'dashboard') loadDashboard();
  if (name === 'schedule') loadSchedules();
}

// ---------------- websocket ----------------

let ws;
function connectWs() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/ui`);
  ws.onopen = () => { $('conn').textContent = 'connected'; $('conn').className = 'ok'; };
  ws.onclose = () => {
    $('conn').textContent = 'reconnecting…';
    $('conn').className = 'bad';
    setTimeout(connectWs, 2000);
  };
  ws.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    if (msg.type === 'agents') { state.agents = msg.agents; renderAgents(); renderAgentPick(); }
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
  };
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
      headers: { 'content-type': 'application/octet-stream', 'x-filename': file.name },
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
  $('startRow').style.display = 'flex';
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
  for (const b of all) for (const a of b.args) orig[`${b.id} ${a.name}`] = a.value;
  const out = {};
  document.querySelectorAll('#varsList .var-input').forEach((inp) => {
    const bid = inp.dataset.block, name = inp.dataset.name;
    if (inp.value !== orig[`${bid} ${name}`]) (out[bid] || (out[bid] = {}))[name] = inp.value;
  });
  return out;
}

// ---------------- data files (shared / split / per-agent) ----------------

let uploadCtx = null; // {mode, agent?, logical?} — context for the hidden file input

$('addDataFile').onclick = () => { uploadCtx = { mode: 'shared' }; $('dataFile').click(); };

$('dataFile').onchange = async () => {
  const ctx = uploadCtx || { mode: 'shared' };
  for (const f of $('dataFile').files) {
    const headers = {
      'content-type': 'application/octet-stream',
      'x-filename': ctx.logical || f.name,
      'x-origname': encodeURIComponent(f.name),
      'x-mode': ctx.mode,
    };
    if (ctx.agent) headers['x-agent'] = ctx.agent;
    const d = await fetch('/api/library/files', { method: 'POST', headers, body: f }).then((r) => r.json());
    if (d.files) state.library = d.files;
  }
  $('dataFile').value = '';
  uploadCtx = null;
  renderDataFiles();
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
  const files = state.library || [];
  const agents = selectedAgents();
  const byLogical = new Map(files.map((f) => [f.logical, f]));
  const refs = (state.plan && state.plan.structure.dataFileRefs) || [];
  if (!state.csvAdvOpen) state.csvAdvOpen = new Set();
  const advOpen = state.csvAdvOpen;

  // legacy elements no longer used — keep the UI to a single list
  if ($('addDataFile')) $('addDataFile').style.display = 'none';
  if ($('dataFilesUi')) $('dataFilesUi').innerHTML = '';

  if (!refs.length) { $('csvRefs').innerHTML = ''; return; }

  const needed = refs.filter(csvRefNeeded);
  const skipped = refs.filter((r) => !csvRefNeeded(r) && !byLogical.has(r.name));

  const dec = (s) => { try { return decodeURIComponent(s || ''); } catch { return s || ''; } };
  const kb = (b) => b ? ` (${b < 10240 ? (b / 1024).toFixed(1) : Math.round(b / 1024)} KB)` : '';
  const rowHtml = (ref) => {
    const f = byLogical.get(ref.name);
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
      }).join('') : '<span class="hint" style="margin:0">select agents in step 3 first</span>';
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
    const existing = byLogical.get(logical);
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

/**
 * Sampler checkboxes grouped under their parent controllers (the tree the
 * JMeter GUI shows: Simple/Transaction/If controllers etc.). Plans without
 * controllers render as the plain flat grid.
 */
// A read-only badge row for CSV Data Set Config / pre / post processors.
function auxRowHtml(a) {
  const meta = a.role === 'csv'
    ? { badge: 'CSV', cls: 'aux-csv', title: 'CSV Data Set Config' }
    : (a.role === 'pre'
      ? { badge: 'PRE', cls: 'aux-pre', title: 'Pre-processor' }
      : { badge: 'POST', cls: 'aux-post', title: 'Post-processor' });
  const file = a.role === 'csv' && a.file ? ` <span class="aux-file">${esc(a.file)}</span>` : '';
  return `<div class="aux-row ${meta.cls}${a.enabled ? '' : ' aux-off'}" title="${esc(meta.title)} · ${esc(a.tag)}"><span class="aux-badge">${meta.badge}</span> ${esc(a.name)}${file}</div>`;
}

function samplerGroupsHtml(tg, samplers) {
  const ctrls = state.plan.structure.controllers || [];
  const aux = (state.plan.structure.aux || []).filter((a) => a.threadGroupId === tg.id);
  const label = (sm) => `<label data-name="${esc(sm.name.toLowerCase())}"><input type="checkbox" class="smCb-${tg.id}" id="smEn-${sm.id}" ${sm.enabled ? 'checked' : ''}> ${esc(sm.name)}</label>`;
  const renderItem = (it) => (it._aux ? auxRowHtml(it) : label(it));
  // Group samplers AND aux elements by their controller path, ordered by document seq.
  const groups = new Map();
  const push = (ctrlIds, item, isAux) => {
    const key = (ctrlIds || []).join('/');
    if (!groups.has(key)) groups.set(key, { ctrlIds: ctrlIds || [], items: [] });
    groups.get(key).items.push(isAux ? { ...item, _aux: true } : item);
  };
  for (const sm of samplers) push(sm.ctrlIds, sm, false);
  for (const a of aux) push(a.ctrlIds, a, true);
  for (const g of groups.values()) g.items.sort((x, y) => (x.seq || 0) - (y.seq || 0));
  if (groups.size === 1 && groups.has('')) {
    return `<div class="samplers" id="smList-${tg.id}">${groups.get('').items.map(renderItem).join('')}</div>`;
  }
  let gi = 0;
  return `<div class="sm-groups" id="smList-${tg.id}">${[...groups.values()].map((g) => {
    const id = `cg-${tg.id}-${gi++}`;
    const ids = g.ctrlIds;
    const inner = ids.length ? ids[ids.length - 1] : null;
    // EVERY controller in the path gets a checkbox — including ancestors like a
    // parent "Q&A Service" that has no direct samplers — so any of them can be
    // (re-)enabled, exactly like ticking it in the JMeter tree. A disabled parent
    // stops its children from running even when they're ticked.
    const head = inner === null
      ? '<span class="ctrl-name">— directly under thread group —</span>'
      : ids.map((cid) => `<label class="ctrl-toggle"><input type="checkbox" class="ctrlCb" data-ctrl="${cid}" data-tg="${tg.id}" ${ctrls[cid] && ctrls[cid].enabled ? 'checked' : ''}> ${esc(ctrls[cid] ? ctrls[cid].name : '?')}</label>`).join('<span class="ctrl-sep">›</span>');
    return `
    <div class="ctrl-group" id="${id}" data-ctrlids="${ids.join('/')}">
      <div class="ctrl-head">
        ${head}
        <span class="ctrl-off" style="display:none">controller disabled — these samplers won’t run</span>
        <span class="ctrl-actions">
          <button class="ghost mini" data-cgtarget="${id}" data-cgtg="${tg.id}" data-on="1">All</button>
          <button class="ghost mini" data-cgtarget="${id}" data-cgtg="${tg.id}" data-on="0">None</button>
        </span>
      </div>
      <div class="samplers">${g.items.map(renderItem).join('')}</div>
    </div>`;
  }).join('')}</div>`;
}

/** Dim every group that sits under a disabled controller (any ancestor unchecked). */
function updateCtrlDim(tgId) {
  const ctrls = state.plan.structure.controllers || [];
  const isOn = (id) => {
    const cb = document.querySelector(`.ctrlCb[data-ctrl="${id}"]`);
    return cb ? cb.checked : (ctrls[id] ? ctrls[id].enabled : true);
  };
  document.querySelectorAll(`#smList-${tgId} .ctrl-group`).forEach((g) => {
    const ids = (g.dataset.ctrlids || '').split('/').filter(Boolean).map(Number);
    const off = ids.some((id) => !isOn(id));
    g.classList.toggle('ctrl-disabled', off);
    const warn = g.querySelector('.ctrl-off');
    if (warn) warn.style.display = off ? '' : 'none';
  });
}

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
    samplers: s.samplers.map((sm) => ({ id: sm.id, enabled: $(`smEn-${sm.id}`).checked })),
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
  s.threadGroups.forEach((tg) => {
    updateCtrlDim(tg.id);
    const cbs = [...document.querySelectorAll(`.smCb-${tg.id}`)];
    const el = $(`smCount-${tg.id}`);
    if (el) el.textContent = `${cbs.filter((c) => c.checked).length} / ${cbs.length} enabled`;
  });
}

// Save whatever's on screen into the currently-edited agent's profile.
function saveActiveProfile() {
  if (state.distMode === 'per-agent' && state.editingAgent) {
    state.profiles[state.editingAgent] = readFormConfig();
  }
}

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
  const planAuxHtml = planAux.length
    ? `<div class="tg plan-aux"><div class="tg-head"><span>Plan-level configuration</span><span class="tg-tag">shared by all thread groups</span></div><div class="samplers">${planAux.map(auxRowHtml).join('')}</div></div>`
    : '';
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
      <details ${many ? '' : 'open'}>
        <summary>Samplers <span class="badge" id="smCount-${tg.id}">${enabledCount} / ${samplers.length} enabled</span></summary>
        <div class="sampler-tools">
          <button class="ghost mini" data-small="${tg.id}" data-on="1">Select all</button>
          <button class="ghost mini" data-small="${tg.id}" data-on="0">Select none</button>
          ${many ? `<input type="search" id="smFilter-${tg.id}" placeholder="Filter ${samplers.length} samplers…">` : ''}
        </div>
        ${samplerGroupsHtml(tg, samplers)}
      </details>` : ''}
    </div>`;
  }).join('');

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

    const updateCount = () => {
      const cbs = [...document.querySelectorAll(`.smCb-${tg.id}`)];
      const el = $(`smCount-${tg.id}`);
      if (el) el.textContent = `${cbs.filter((c) => c.checked).length} / ${cbs.length} enabled`;
    };
    document.querySelectorAll(`.smCb-${tg.id}`).forEach((cb) => (cb.onchange = updateCount));
    const filter = $(`smFilter-${tg.id}`);
    if (filter) filter.oninput = () => {
      const q = filter.value.toLowerCase();
      document.querySelectorAll(`#smList-${tg.id} label`).forEach((l) => {
        l.classList.toggle('hidden', q && !l.dataset.name.includes(q));
      });
      // hide controller groups whose samplers are all filtered out
      document.querySelectorAll(`#smList-${tg.id} .ctrl-group`).forEach((g) => {
        g.classList.toggle('hidden', ![...g.querySelectorAll('label')].some((l) => !l.classList.contains('hidden')));
      });
    };
  });

  // Per-controller All/None — affects only that controller's visible samplers.
  document.querySelectorAll('[data-cgtarget]').forEach((btn) => {
    btn.onclick = () => {
      document.getElementById(btn.dataset.cgtarget)
        .querySelectorAll('.samplers label:not(.hidden) input')
        .forEach((cb) => { cb.checked = btn.dataset.on === '1'; });
      const first = document.querySelector(`.smCb-${btn.dataset.cgtg}`);
      if (first) first.onchange();
    };
  });

  // Controller enable/disable checkboxes — re-dim affected groups live. A
  // controller can appear in several breadcrumbs (as an ancestor), so sync all
  // copies of it before re-dimming.
  document.querySelectorAll('.ctrlCb').forEach((cb) => {
    cb.onchange = () => {
      document.querySelectorAll(`.ctrlCb[data-ctrl="${cb.dataset.ctrl}"]`).forEach((x) => { x.checked = cb.checked; });
      updateCtrlDim(cb.dataset.tg);
      if (state.distMode === 'per-agent') renderPerAgentSummary();
    };
  });
  s.threadGroups.forEach((tg) => updateCtrlDim(tg.id));

  // Select all / none — only affects samplers currently visible under the filter.
  document.querySelectorAll('[data-small]').forEach((btn) => {
    btn.onclick = () => {
      const tgId = btn.dataset.small;
      document.querySelectorAll(`#smList-${tgId} label:not(.hidden) input`).forEach((cb) => { cb.checked = btn.dataset.on === '1'; });
      const first = document.querySelector(`.smCb-${tgId}`);
      if (first) first.onchange();
    };
  });
}

function renderAgentPick() {
  if (!state.plan) return;
  $('agentPick').innerHTML = state.agents.length
    ? state.agents.map((a) => `
      <label>
        <input type="checkbox" class="agentCb" value="${esc(a.name)}" ${a.state === 'idle' ? 'checked' : 'disabled'}>
        <span><b>${esc(a.name)}</b><br><span class="meta">${a.cpus} cores · ${a.memGB} GB · ${a.state}${a.stub ? ' · STUB' : ''}</span><br>${resMeter(a.res, a.name)}</span>
      </label>`).join('')
    : '<span class="empty">No agents connected — start the agent exe on your worker PCs.</span>';
  document.querySelectorAll('.agentCb').forEach((cb) => (cb.onchange = () => { renderSplitPreview(); renderDataFiles(); renderReportAssign(); updateDistUI(); }));
  renderSplitPreview();
  renderDataFiles();
  updateDistUI();
}

function selectedAgents() {
  return [...document.querySelectorAll('.agentCb:checked')].map((c) => c.value);
}

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
function buildRunConfig() {
  // Files this plan actively reads (enabled CSV + enabled thread group) must be
  // satisfied by the library; per-agent files need a copy for every agent.
  // In per-agent mode the server validates the union of profiles, so skip here.
  const requiredRefs = state.distMode === 'per-agent' ? [] : (state.plan.structure.dataFileRefs || []).filter(csvRefNeeded);
  for (const ref of requiredRefs) {
    const f = (state.library || []).find((x) => x.logical === ref.name);
    if (!f) throw new Error(`The plan reads "${ref.name}" but no file is uploaded for it (see step 1).`);
    if (f.mode === 'per-agent') {
      const missing = selectedAgents().filter((a) => !(f.perAgent || {})[a.replace(/[^\w.-]/g, '_')]);
      if (missing.length) throw new Error(`Upload "${f.logical}" for: ${missing.join(', ')}`);
    }
  }
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
    onRunUpdate(run);
    resetLiveView();
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

// Elapsed clock — ticks every second while a run is active (wall time since the
// first sample), freezes at the sample-span duration once the run ends.
setInterval(() => {
  const el = $('tElapsed');
  if (!el || !state.live) return;
  if (state.run && state.run.state === 'running') {
    el.textContent = state.live.startedTs ? fmt.dur((Date.now() - state.live.startedTs) / 1000) : '00:00:00';
  } else {
    el.textContent = fmt.dur(state.live.elapsedSec);
  }
}, 1000);

function resetLiveView() {
  $('log').textContent = '';
  state.live = null;
  ['tElapsed', 'tTps', 'tAvg', 'tErr', 'tTotal'].forEach((id) => ($(id).textContent = '–'));
  $('labelRows').innerHTML = '';
  const cont = $('lazCharts');
  if (cont) { cont._sig = null; cont.innerHTML = '<p class="empty">waiting for samples…</p>'; }
}

function onRunUpdate(run) {
  state.run = run;
  $('liveTitle').textContent = `${run.planName} — ${run.id} · `;
  const st = document.createElement('span');
  st.className = `state ${run.state}`;
  st.textContent = run.state.toUpperCase();
  $('liveTitle').appendChild(st);

  renderLiveAgents();

  const tgSel = $('liveTg');
  const kept = tgSel.value;
  tgSel.innerHTML = '<option value="">All thread groups</option>' +
    (run.tgNames || []).map((n) => `<option value="${esc(n)}" ${n === kept ? 'selected' : ''}>${esc(n)}</option>`).join('');

  $('stopBtn').style.display = run.state === 'running' ? 'inline-block' : 'none';
  const ended = run.state === 'finished' || run.state === 'stopped' || run.state === 'error';
  if (ended && state.lastLoggedEnd !== run.id) {
    state.lastLoggedEnd = run.id;
    appendLog(`run ${run.state}. See History tab for the full summary${run.hasReport ? ' and JMeter dashboard' : ''}.`);
    loadFinalIntoLive(run.id, $('liveTg').value);
  }
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
    $('tElapsed').textContent = fmt.dur(s.durationSec);
    $('tTps').textContent = fmt.n(s.overall.throughput);
    $('tAvg').textContent = fmt.ms(s.overall.avg);
    $('tErr').textContent = fmt.pct(s.overall.errorPct);
    $('tTotal').textContent = fmt.n(s.overall.samples);
    $('labelRows').innerHTML = s.perLabel
      .slice().sort((a, b) => b.samples - a.samples)
      .map((row) => `<tr><td>${esc(row.label)}</td><td class="num">${fmt.n(row.samples)}</td>
        <td class="num" style="${row.errors ? 'color:var(--critical)' : ''}">${fmt.n(row.errors)}</td>
        <td class="num">${fmt.n(row.avg)}</td><td class="num">${fmt.n(row.max)}</td></tr>`).join('');
    const td = await api('GET', `/api/runs/${id}/timeline-detail${q}`);
    const cont = $('lazCharts');
    if (cont && td.t && td.t.length) {
      const vu = state.run ? runVUsers(state.run) : null;
      const rk = state.run ? state.run.rateKind : null;
      cont._sig = td.labels.join('|');
      cont.innerHTML = azChartsHtml('laz', td, s, vu, rk);
      azChartsDraw('laz', td, vu, rk);
    }
  } catch { /* no stored results (e.g. failed before samples) */ }
}

$('stopBtn').onclick = () => api('POST', `/api/runs/${state.run.id}/stop`).catch((e) => appendLog(`stop failed: ${e.message}`));

/** Agent chips with each agent's own test time + a slow-network flag for outliers. */
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
  $('liveAgents').innerHTML = run.agents.map((a) => {
    const sec = liveElapsed[a.name] != null ? liveElapsed[a.name] : a.durationSec;
    const slow = isSlow(a.name);
    const lat = avgMs[a.name] != null ? ` · ${fmt.n(avgMs[a.name])}ms avg` : '';
    const res = resByName.get(a.name);
    const saturated = res && (res.cpu >= 90 || res.mem >= 90);
    return `<span class="chip ${a.state === 'running' ? 'running' : a.state === 'done' ? 'done' : a.state === 'error' ? 'error' : ''}${slow ? ' slow' : ''}"
       ${slow ? `title="Average response ${fmt.n(avgMs[a.name])}ms vs ${fmt.n(fastest)}ms on the fastest agent — likely a slow network path from this PC to the target, not real load."` : ''}>
       <b>${esc(a.name)}</b> ${a.state}${sec != null ? ` · ${ic('clock')} ${fmt.dur(sec)}` : ''}${lat}${a.state === 'running' ? ` ${resMeter(res, a.name)}` : ''}${saturated ? ` <b class="slow-badge">${ic('warn')} generator maxed</b>` : ''}${slow ? ` <b class="slow-badge">${ic('warn')} slow network path</b>` : ''}${a.error ? ` — ${esc(a.error)}` : ''}</span>`;
  }).join('');
}

$('liveTg').onchange = () => {
  const ended = state.run && ['finished', 'stopped', 'error'].includes(state.run.state);
  // After a run ends, filter from the stored results (live snapshots are gone
  // after a page reload); during a run, use the streaming per-group stats.
  if (ended) loadFinalIntoLive(state.run.id, $('liveTg').value);
  else renderLive();
};

function renderLive() {
  if (!state.live) return;
  // A selected thread group swaps in that group's snapshot (same shape).
  const sel = $('liveTg').value;
  const l = sel && state.live.byTg && state.live.byTg[sel] ? state.live.byTg[sel] : state.live;
  $('tTps').textContent = fmt.n(l.window.tps);
  $('tAvg').textContent = fmt.ms(l.window.avg);
  $('tErr').textContent = fmt.pct(l.window.errPct);
  $('tTotal').textContent = fmt.n(l.totalSamples);

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

  $('labelRows').innerHTML = l.perLabel
    .sort((a, b) => b.samples - a.samples)
    .map((r) => `<tr><td>${esc(r.label)}</td><td class="num">${fmt.n(r.samples)}</td>
      <td class="num" style="${r.errors ? 'color:var(--critical)' : ''}">${fmt.n(r.errors)}</td>
      <td class="num">${fmt.n(r.avg)}</td><td class="num">${fmt.n(r.max)}</td></tr>`).join('');
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

// ---------------- history ----------------

async function loadHistory() {
  await ensureSla();
  const runs = await api('GET', '/api/runs');
  $('runEmpty').style.display = runs.length ? 'none' : 'block';
  const counts = {};
  for (const r of runs) counts[dayKey(r.createdAt)] = (counts[dayKey(r.createdAt)] || 0) + 1;

  const row = (r) => {
    const o = r.overall;
    const target = (r.targets && r.targets[0]) ? `<span class="run-target" title="${esc(runTargetTitle(r))}">${esc(r.targets[0])}</span>` : '';
    return `<tr style="cursor:pointer" data-id="${esc(r.id)}" onclick="showRunDetail('${r.id}')">
      <td>${timeOnly(r.createdAt)}</td>
      <td>${esc(r.planName || '')}${target}</td>
      <td><span class="state ${r.state}">${r.state}</span>${slaPill(r)}</td>
      <td class="num">${fmt.dur(r.durationSec)}</td>
      <td class="num">${r.agents ? r.agents.length : '–'}</td>
      <td class="num">${o ? fmt.n(o.samples) : '–'}</td>
      <td class="num">${o ? fmt.n(o.avg) : '–'}</td>
      <td class="num">${o ? o.errorPct : '–'}</td>
      <td class="num">${o ? fmt.tp(o.throughput) : '–'}</td>
      <td class="num"><button class="ghost mini row-del" title="Delete this run" onclick="deleteRun('${r.id}', event)">✕</button></td>
    </tr>`;
  };

  let html = '', lastDay = null;
  for (const r of runs) {
    const dk = dayKey(r.createdAt);
    if (dk !== lastDay) {
      lastDay = dk;
      html += `<tr class="date-row"><td colspan="10">${ic('calendar')} <b>${esc(dayLabel(r.createdAt))}</b> <span class="date-count">${counts[dk]} run${counts[dk] > 1 ? 's' : ''}</span></td></tr>`;
    }
    html += row(r);
  }
  $('runRows').innerHTML = html;
}

// ---------------- dashboard ----------------
// An at-a-glance overview across ALL runs (KPI cards + a per-run throughput
// trend) with filters, plus a drill-down: click any run to see Azure-style
// metric cards, over-time charts and the aggregate report for that run.

const dashState = { runs: [], selectedId: null, plan: '', target: '', state: '', q: '', bound: false, detailTg: '' };

async function loadDashboard() {
  if (!dashState.bound) {
    dashState.bound = true;
    $('dashSearch').oninput = () => { dashState.q = $('dashSearch').value.trim(); renderDashboard(); };
    $('dashPlan').onchange  = () => { dashState.plan = $('dashPlan').value; renderDashboard(); };
    $('dashTarget').onchange = () => { dashState.target = $('dashTarget').value; renderDashboard(); };
    $('dashState').onchange = () => { dashState.state = $('dashState').value; renderDashboard(); };
    $('dashRefresh').onclick = () => loadDashboard();
    $('slaSave').onclick = saveSla;
    $('cmpA').onchange = () => { cmpState.a = $('cmpA').value; renderCompare(); };
    $('cmpB').onchange = () => { cmpState.b = $('cmpB').value; renderCompare(); };
    $('cmpClear').onclick = () => { cmpState.a = ''; cmpState.b = ''; $('cmpA').value = ''; $('cmpB').value = ''; renderCompare(); };
  }
  try { dashState.runs = await api('GET', '/api/runs'); } catch { dashState.runs = []; }
  try { slaThresholds = await api('GET', '/api/sla'); } catch { /* keep */ }
  fillSlaInputs();
  fillCompareOptions();
  const plans = [...new Set(dashState.runs.map((r) => r.planName).filter(Boolean))].sort();
  $('dashPlan').innerHTML = `<option value="">All plans</option>` +
    plans.map((p) => `<option value="${esc(p)}" ${p === dashState.plan ? 'selected' : ''}>${esc(p)}</option>`).join('');
  // web-address filter — the PRIMARY app each run tested (not incidental deps)
  const targets = [...new Set(dashState.runs.map((r) => (r.targets || [])[0]).filter(Boolean))].sort();
  $('dashTarget').innerHTML = `<option value="">All web addresses</option>` +
    targets.map((t) => `<option value="${esc(t)}" ${t === dashState.target ? 'selected' : ''}>${esc(t)}</option>`).join('');
  renderDashboard();
}

function dashFiltered() {
  const q = dashState.q.toLowerCase();
  return dashState.runs.filter((r) =>
    (!dashState.plan || r.planName === dashState.plan) &&
    (!dashState.target || (r.targets || [])[0] === dashState.target) &&
    (!dashState.state || r.state === dashState.state) &&
    (!q || (r.planName || '').toLowerCase().includes(q) || (r.id || '').toLowerCase().includes(q)
      || (r.targets || []).some((t) => t.includes(q))));
}

function fillSlaInputs() {
  if (!slaThresholds) return;
  $('slaErr').value = slaThresholds.maxErrorPct ?? '';
  $('slaP90').value = slaThresholds.maxP90Ms ?? '';
  $('slaTp').value = slaThresholds.minThroughput ?? '';
}
async function saveSla() {
  const val = (id) => ($(id).value === '' ? null : +$(id).value);
  try {
    const d = await api('PUT', '/api/sla', { maxErrorPct: val('slaErr'), maxP90Ms: val('slaP90'), minThroughput: val('slaTp') });
    slaThresholds = d.sla;
    $('slaMsg').textContent = 'saved ✓';
    setTimeout(() => { $('slaMsg').textContent = ''; }, 1500);
    renderDashboard();
  } catch (e) { $('slaMsg').textContent = e.message; }
}

function renderDashboard() {
  const runs = dashFiltered();
  const fails = slaActive() ? runs.filter((r) => slaVerdict(r) === 'fail').length : null;
  $('dashSub').textContent = `${runs.length} run${runs.length === 1 ? '' : 's'}${dashState.plan ? ` · ${dashState.plan}` : ''}${fails != null ? ` · ${fails} failing SLA` : ''}`;
  renderDashKpis(runs);
  renderDashTrend(runs);
  renderDashTable(runs);
  if (dashState.selectedId && !runs.some((r) => r.id === dashState.selectedId)) {
    dashState.selectedId = null; $('dashDetail').innerHTML = '';
  }
}

function kpiCard(c) {
  return `<div class="kpi ${c.tone || ''}">
    <div class="kpi-k">${c.k}</div>
    <div class="kpi-v">${c.v}</div>
    ${c.sub ? `<div class="kpi-sub">${c.sub}</div>` : ''}
  </div>`;
}

function renderDashKpis(runs) {
  const wd = runs.filter((r) => r.overall);
  const totReq = wd.reduce((a, r) => a + (r.overall.samples || 0), 0);
  const totErr = wd.reduce((a, r) => a + (r.overall.errors || 0), 0);
  const peak = wd.reduce((a, r) => Math.max(a, r.overall.throughput || 0), 0);
  const avgResp = wd.length ? Math.round(wd.reduce((a, r) => a + (r.overall.avg || 0), 0) / wd.length) : null;
  const errRate = totReq ? +(100 * totErr / totReq).toFixed(2) : 0;
  const failed = runs.filter((r) => r.state === 'error').length;
  const cards = [
    { k: 'Total runs', v: fmt.n(runs.length) },
    { k: 'Total requests', v: fmt.n(totReq) },
    { k: 'Peak throughput', v: peak ? fmt.tp(peak) : '–' },
    { k: 'Avg response', v: avgResp != null ? fmt.ms(avgResp) : '–' },
    { k: 'Overall error rate', v: `${errRate}%`, tone: errRate > 5 ? 'bad' : errRate > 0 ? 'warn' : 'good' },
    { k: 'Failed runs', v: fmt.n(failed), tone: failed ? 'bad' : 'good' },
  ];
  $('dashKpis').innerHTML = cards.map(kpiCard).join('');
}

function renderDashTrend(runs) {
  const el = $('dashTrend');
  const wd = runs.filter((r) => r.overall);
  const recent = wd.slice(0, 40).reverse(); // list is newest-first; oldest on the left, newest on the right
  $('dashTrendHint').textContent = wd.length > 40 ? `latest 40 of ${wd.length}` : '';
  if (!recent.length) { el.innerHTML = '<div class="dash-trend-empty">No completed runs to chart yet</div>'; return; }
  const max = Math.max(1, ...recent.map((r) => r.overall.throughput || 0));
  el.innerHTML = recent.map((r) => {
    const tp = r.overall.throughput || 0;
    const h = Math.max(4, Math.round((tp / max) * 100));
    const tone = r.overall.errorPct > 5 ? 'bad' : r.overall.errorPct > 0 ? 'warn' : 'good';
    const sel = r.id === dashState.selectedId ? ' sel' : '';
    return `<button class="tbar ${tone}${sel}" style="height:${h}%" data-id="${esc(r.id)}"
      title="${esc(r.planName || '')}&#10;${fmt.dt(r.createdAt)}&#10;${fmt.tp(tp)} · ${r.overall.errorPct}% err · ${fmt.n(r.overall.samples)} req"></button>`;
  }).join('');
  el.querySelectorAll('.tbar').forEach((b) => b.onclick = () => selectDashRun(b.dataset.id));
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

// Runs are grouped under a date header (the date is the "title"; each day's
// runs sit under it). Runs arrive newest-first, so groups do too.
function renderDashTable(runs) {
  $('dashEmpty').style.display = runs.length ? 'none' : 'block';
  const counts = {};
  for (const r of runs) counts[dayKey(r.createdAt)] = (counts[dayKey(r.createdAt)] || 0) + 1;

  const row = (r) => {
    const o = r.overall;
    const sel = r.id === dashState.selectedId ? ' class="sel"' : '';
    const target = (r.targets && r.targets[0]) ? `<span class="run-target" title="${esc(runTargetTitle(r))}">${esc(r.targets[0])}</span>` : '';
    return `<tr${sel} data-id="${esc(r.id)}">
      <td>${timeOnly(r.createdAt)}</td>
      <td>${esc(r.planName || '')}${target}</td>
      <td><span class="state ${r.state}">${r.state}</span>${slaPill(r)}</td>
      <td class="num">${fmt.dur(r.durationSec)}</td>
      <td class="num">${r.agents ? r.agents.length : '–'}</td>
      <td class="num">${o ? fmt.n(o.samples) : '–'}</td>
      <td class="num">${o ? fmt.n(o.avg) : '–'}</td>
      <td class="num" style="${o ? errStyle(o.errorPct) : ''}">${o ? o.errorPct : '–'}</td>
      <td class="num">${o ? fmt.tp(o.throughput) : '–'}</td></tr>`;
  };

  let html = '', lastDay = null;
  for (const r of runs) {
    const dk = dayKey(r.createdAt);
    if (dk !== lastDay) {
      lastDay = dk;
      html += `<tr class="date-row"><td colspan="9">${ic('calendar')} <b>${esc(dayLabel(r.createdAt))}</b> <span class="date-count">${counts[dk]} run${counts[dk] > 1 ? 's' : ''}</span></td></tr>`;
    }
    html += row(r);
  }
  $('dashRunRows').innerHTML = html;
  $('dashRunRows').querySelectorAll('tr[data-id]').forEach((tr) => tr.onclick = () => selectDashRun(tr.dataset.id));
}

// ---------------- run comparison (A vs B) ----------------
const cmpState = { a: '', b: '', cache: {} };

function fillCompareOptions() {
  const opts = `<option value="">— select run —</option>` + dashState.runs.filter((r) => r.overall).map((r) =>
    `<option value="${esc(r.id)}">${esc(fmt.ymd(r.createdAt))} · ${esc(r.planName || '')} · ${esc((r.targets || [])[0] || '')}</option>`).join('');
  $('cmpA').innerHTML = opts; $('cmpB').innerHTML = opts;
  $('cmpA').value = cmpState.a; $('cmpB').value = cmpState.b;
}

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

async function selectDashRun(id) {
  dashState.selectedId = id;
  renderDashTrend(dashFiltered());
  renderDashTable(dashFiltered());
  const box = $('dashDetail');
  box.innerHTML = '<div class="card"><p class="empty">loading run…</p></div>';
  let r;
  try { r = await api('GET', `/api/runs/${id}`); }
  catch (e) { box.innerHTML = `<div class="card"><p class="empty">Could not load run: ${esc(e.message)}</p></div>`; return; }
  dashState.detailTg = ''; // reset filter for the newly selected run
  const s0 = r.summary;
  const links = [
    r.hasReport ? `<a href="/runs-static/${id}/report/index.html" target="_blank">JMeter dashboard</a>` : '',
    r.hasMerged ? `<a href="/api/runs/${id}/merged.jtl">merged .jtl</a>` : '',
    `<a href="/api/runs/${id}/log" target="_blank">run log</a>`,
  ].filter(Boolean).join(' · ');
  // Thread-group filter — only when the run actually has more than one group.
  const tgFilter = (r.tgNames || []).length > 1
    ? `<label class="field dash-tg-filter">Thread group
        <select id="dashTgSel"><option value="">All thread groups</option>${r.tgNames.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}</select>
      </label>`
    : '';

  box.innerHTML = `
    <div class="card dash-detail">
      <div class="dash-detail-head">
        <div>
          <h2>${esc(r.planName || 'Run')} <span class="state ${r.state}">${r.state}</span></h2>
          <p class="dash-sub">${fmt.dt(r.createdAt)} · ${ic('clock')} ${fmt.dur(s0 ? s0.durationSec : r.durationSec)} · agents: ${esc((r.agents || []).map((a) => a.name).join(', ') || '–')}</p>
        </div>
        <div class="dash-detail-links">${links}${s0 && s0.overall && s0.overall.samples ? ` · <button class="ghost mini dash-send-sheet" data-id="${esc(id)}">${ic('download')} Send to Sheet</button>` : ''}</div>
      </div>
      ${tgFilter}
      <div id="dashBody"><p class="empty">loading…</p></div>
    </div>`;

  const sendBtn = box.querySelector('.dash-send-sheet');
  if (sendBtn) sendBtn.onclick = () => sendRunToSheet(sendBtn.dataset.id, sendBtn);
  const tgSel = document.getElementById('dashTgSel');
  if (tgSel) tgSel.onchange = () => { dashState.detailTg = tgSel.value; loadDashBody(r); };
  await loadDashBody(r);
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Render the metric cards + charts + aggregate for the selected run, honoring the
// Thread-group filter (dashState.detailTg). Re-runs when that dropdown changes.
async function loadDashBody(r) {
  const body = document.getElementById('dashBody');
  if (!body) return;
  const tg = dashState.detailTg || '';
  const qs = tg ? `?tg=${encodeURIComponent(tg)}` : '';
  body.innerHTML = '<p class="empty">loading…</p>';
  let td = { t: [], labels: [], series: {}, threads: null };
  try { td = await api('GET', `/api/runs/${r.id}/timeline-detail${qs}`); } catch { /* no samples */ }
  // Filtered summary when a group is picked; otherwise the stored whole-run summary.
  let s = r.summary;
  if (tg) { try { s = await api('GET', `/api/runs/${r.id}/summary${qs}`); } catch { s = null; } }
  const o = s ? s.overall : null;
  const vu = runVUsers(r);
  const isArr = r.rateKind === 'arrivals' || r.rateKind === 'mixed';
  const metrics = [
    { k: isArr ? 'Peak active threads' : 'Virtual users (max)', v: (td.threads ? fmt.n(Math.max(0, ...td.threads)) : (vu != null ? fmt.n(vu) : '–')), ic: 'layers' },
    { k: 'Response time (p90)', v: o ? fmt.ms(o.p90) : '–', ic: 'gauge' },
    { k: 'Requests / sec', v: o ? fmt.tp(o.throughput) : '–', ic: 'bolt' },
    { k: 'Total requests', v: o ? fmt.n(o.samples) : '–', ic: 'cube' },
    { k: 'Errors', v: o ? fmt.n(o.errors) : '–', tone: o && o.errors ? 'bad' : 'good', ic: 'fail' },
  ];
  body.innerHTML = `<div class="metric-row">${metrics.map(metricCard).join('')}</div>`
    + (s && td.t.length
      ? azChartsHtml('az', td, s, vu, r.rateKind)
        + (o && o.errors ? `<div id="dashErrDiag" class="err-diag"><p class="empty" style="text-align:left">loading error breakdown…</p></div>` : '')
        + `<details class="dash-agg" open><summary>Aggregate report</summary>${aggregateTable(s)}</details>`
      : `<p class="empty">No samples${tg ? ' for this thread group' : ''}.</p>`);
  if (s && td.t.length) azChartsDraw('az', td, vu, r.rateKind);
  if (o && o.errors) loadErrorDiag(r.id, tg);
}

// Error-diagnosis panel: the endpoints that actually failed, grouped by
// response code + message, worst-first — "what's dying" without digging.
async function loadErrorDiag(id, tg) {
  const el = document.getElementById('dashErrDiag');
  if (!el) return;
  try {
    const d = await api('GET', `/api/runs/${id}/error-summary${tg ? `?tg=${encodeURIComponent(tg)}` : ''}`);
    if (!d.groups || !d.groups.length) { el.innerHTML = '<p class="empty" style="text-align:left">No error details recorded for this run.</p>'; return; }
    const top = d.groups.slice(0, 12);
    el.innerHTML = `
      <h3 class="err-diag-h">${ic('warn')} Top failing requests <span class="hint" style="margin:0">${fmt.n(d.totalErrors)} errors in ${fmt.n(d.totalSamples)} samples</span></h3>
      <div class="err-diag-wrap"><table class="err-diag-table">
        <thead><tr><th>Request</th><th>Code</th><th>Message</th><th class="num">Count</th><th class="num">% of errors</th></tr></thead>
        <tbody>${top.map((g) => {
          const pct = d.totalErrors ? (100 * g.count / d.totalErrors) : 0;
          const message = (g.msg || g.failure || '').trim();
          return `<tr>
            <td>${esc(g.label)}</td>
            <td><span class="err-code">${esc(g.code || '–')}</span></td>
            <td class="err-msg" title="${esc(message)}">${esc(message.slice(0, 140) || '–')}</td>
            <td class="num">${fmt.n(g.count)}</td>
            <td class="num"><span class="err-bar" style="--p:${pct.toFixed(0)}%"></span>${pct.toFixed(1)}%</td>
          </tr>`;
        }).join('')}</tbody>
      </table></div>
      ${d.groups.length > 12 ? `<p class="hint" style="margin:6px 0 0">+ ${d.groups.length - 12} more error type${d.groups.length - 12 > 1 ? 's' : ''}</p>` : ''}`;
  } catch (e) {
    el.innerHTML = `<p class="empty" style="text-align:left">Could not load error breakdown: ${esc(e.message)}</p>`;
  }
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

window.deleteRun = async (id, ev) => {
  ev.stopPropagation();
  if (!confirm(`Delete run ${id}?\nIts results, reports and logs are removed permanently.`)) return;
  try {
    await api('DELETE', `/api/runs/${id}`);
    if (detailState.id === id) { $('runDetail').innerHTML = ''; detailState.id = null; }
    loadHistory();
  } catch (e) {
    alert(`Delete failed: ${e.message}`);
  }
};

$('clearRuns').onclick = async () => {
  const runs = await api('GET', '/api/runs');
  if (!runs.length) return;
  if (!confirm(`Delete ALL ${runs.length} runs from history?\nThis cannot be undone.`)) return;
  for (const r of runs) {
    try { await api('DELETE', `/api/runs/${r.id}`); } catch { /* skip active run */ }
  }
  $('runDetail').innerHTML = '';
  detailState.id = null;
  loadHistory();
};

window.showRunDetail = async (id) => {
  const r = await api('GET', `/api/runs/${id}`);
  Object.assign(detailState, { id, offset: 0, errorsOnly: false, agent: '', tg: '', summary: r.summary, agentSummaries: null, rateKind: r.rateKind });
  const s = r.summary;
  const uploadedAgents = (r.agents || []).filter((a) => a.uploaded).map((a) => a.name);
  const links = [
    r.hasReport ? `<a href="/runs-static/${id}/report/index.html" target="_blank">JMeter HTML dashboard</a>` : '',
    r.hasMerged ? `<a href="/api/runs/${id}/merged.jtl">Download merged .jtl</a>` : '',
    `<a href="/api/runs/${id}/log" target="_blank">Run log</a>`,
  ].filter(Boolean).join(' · ');
  $('runDetail').innerHTML = `
    <div class="card" id="printArea">
      <h2>${esc(r.planName || '')} — ${id} <span class="state ${r.state}">${r.state}</span>
        ${s && s.overall && s.overall.samples ? `<button class="ghost mini" id="histSendSheet" data-id="${esc(id)}" style="margin-left:auto;">${ic('download')} Send to Sheet</button>` : ''}
        <button class="ghost mini" id="printRun" ${s && s.overall && s.overall.samples ? '' : 'style="margin-left:auto;"'}>${ic('printer')} Print</button></h2>
      <p style="color:var(--muted)">${fmt.dt(r.createdAt)} → ${fmt.dt(r.endedAt)}
        · <b style="color:var(--ink)">${ic('clock')} ${fmt.dur(s ? s.durationSec : r.endedAt ? (new Date(r.endedAt) - new Date(r.createdAt)) / 1000 : null)}</b>
        · agents: ${(r.agents || []).map((a) => `${esc(a.name)}${a.error ? ` (${esc(a.error)})` : ''}`).join(', ')}</p>
      <p>${links}</p>
      ${s ? `
      <div style="display:flex; gap:16px; flex-wrap:wrap;">
        ${uploadedAgents.length > 1 ? `
        <label class="field">Agent
          <select id="agentSel">
            <option value="">All agents (merged)</option>
            ${uploadedAgents.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}
          </select>
        </label>` : ''}
        ${(r.tgNames || []).length > 1 ? `
        <label class="field">Thread group
          <select id="tgSel">
            <option value="">All thread groups</option>
            ${r.tgNames.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')}
          </select>
        </label>` : ''}
      </div>
      <div id="dazCharts" style="margin-bottom:14px;"></div>
      <div class="subtabs">
        <button class="active" data-tab="aggregate">Aggregate Report</button>
        <button data-tab="summary">Summary Report</button>
        <button data-tab="table" ${r.hasMerged ? '' : 'disabled title="needs merged results"'}>View Results in Table</button>
        ${uploadedAgents.length ? '<button data-tab="agents">Per Agent</button>' : ''}
        <button data-tab="errors">Error Responses</button>
      </div>
      <div id="tab-aggregate" class="subtab active"></div>
      <div id="tab-summary" class="subtab"></div>
      <div id="tab-table" class="subtab">
        <div class="sampler-tools" style="margin-bottom:8px;">
          <label class="df-header"><input type="checkbox" id="errOnly"> errors only</label>
          <button class="ghost mini" id="pgPrev">← Prev</button>
          <span id="pgInfo" class="hint" style="margin:0"></span>
          <button class="ghost mini" id="pgNext">Next →</button>
        </div>
        <div id="samplesBox"></div>
      </div>
      <div id="tab-agents" class="subtab"></div>
      <div id="tab-errors" class="subtab"></div>` : '<p class="empty">No summary (run produced no samples)</p>'}
    </div>`;

  if (!s) return;
  renderDetailTables(s);
  loadDetailCharts(s);

  document.querySelectorAll('.subtabs button').forEach((b) => {
    b.onclick = () => {
      if (b.disabled) return;
      document.querySelectorAll('.subtabs button').forEach((x) => x.classList.toggle('active', x === b));
      document.querySelectorAll('.subtab').forEach((x) => x.classList.toggle('active', x.id === `tab-${b.dataset.tab}`));
      if (b.dataset.tab === 'table' && !$('samplesBox').innerHTML) loadSamples();
      if (b.dataset.tab === 'agents' && !$('tab-agents').innerHTML) loadAgentsTab();
      if (b.dataset.tab === 'errors' && !$('tab-errors').innerHTML) loadErrorsTab();
    };
  });
  $('errOnly').onchange = () => { detailState.errorsOnly = $('errOnly').checked; detailState.offset = 0; loadSamples(); };
  $('pgPrev').onclick = () => { detailState.offset = Math.max(0, detailState.offset - detailState.pageSize); loadSamples(); };
  $('pgNext').onclick = () => { detailState.offset += detailState.pageSize; loadSamples(); };
  const selA = $('agentSel');
  if (selA) selA.onchange = () => { detailState.agent = selA.value; detailState.offset = 0; refreshDetailData(); };
  const selT = $('tgSel');
  if (selT) selT.onchange = () => { detailState.tg = selT.value; detailState.offset = 0; refreshDetailData(); };
  const pb = $('printRun');
  if (pb) pb.onclick = () => printRunDetail(r);
  const hss = $('histSendSheet');
  if (hss) hss.onclick = () => sendRunToSheet(id, hss);
  $('runDetail').scrollIntoView({ behavior: 'smooth' });
};

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
  if (!$('tab-agents').innerHTML) await loadAgentsTab();

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
    ${$('tab-agents').innerHTML ? `<h2>Per Agent</h2>${$('tab-agents').innerHTML}` : ''}
    <script>window.onload=()=>{setTimeout(()=>window.print(),300);}<\/script>
    </body></html>`;
  const w = window.open('', '_blank');
  if (!w) { alert('Allow pop-ups to print.'); return; }
  w.document.write(html);
  w.document.close();
}

/** Re-render every detail view for the current agent/thread-group filter. */
async function refreshDetailData() {
  let s = detailState.summary;
  if (detailState.agent || detailState.tg) {
    try { s = await api('GET', `/api/runs/${detailState.id}/summary?${filterQs()}`); } catch { s = detailState.summary; }
  }
  renderDetailTables(s);
  loadDetailCharts(s);
  if ($('samplesBox').innerHTML) loadSamples();
  if ($('tab-errors') && $('tab-errors').innerHTML) loadErrorsTab();
  if ($('tab-agents') && $('tab-agents').innerHTML) loadAgentsTab();
}

function renderDetailTables(s) {
  $('tab-aggregate').innerHTML = aggregateTable(s);
  $('tab-summary').innerHTML = summaryTable(s);
}

async function agentSummaries() {
  // cache per thread-group filter, so the Per Agent tab follows the dropdown
  const key = detailState.tg || '';
  if (!detailState.agentSummaries || detailState.agentSummaries.key !== key) {
    const q = key ? `?tg=${encodeURIComponent(key)}` : '';
    detailState.agentSummaries = { key, data: await api('GET', `/api/runs/${detailState.id}/agents-summary${q}`) };
  }
  return detailState.agentSummaries.data;
}

async function loadDetailCharts(summary) {
  const el = $('dazCharts');
  if (!el) return;
  try {
    const td = await api('GET', `/api/runs/${detailState.id}/timeline-detail?${filterQs()}`);
    if (!td.t.length) { el.innerHTML = '<p class="empty" style="text-align:left">No timeline for this filter.</p>'; return; }
    el.innerHTML = azChartsHtml('daz', td, summary || detailState.summary, null, detailState.rateKind);
    azChartsDraw('daz', td, null, detailState.rateKind);
  } catch {
    el.innerHTML = '<p class="empty" style="text-align:left">Could not load charts.</p>';
  }
}

// One captured error occurrence: the full REQUEST (method, URL, body, headers,
// cookies) that was sent, then the RESPONSE — everything needed to reproduce it.
function errorExampleHtml(e, i) {
  return `<div class="err-example">
    <div class="err-example-head">Example ${i + 1} · agent ${esc(e.agent)} · thread ${esc(e.thread)} · ${new Date(e.t).toLocaleTimeString('en-GB')} · ${e.elapsed} ms</div>
    <div class="err-req">
      <b>▶ Request</b>
      <div><span class="k">${esc(e.method || 'GET')}</span> ${esc(e.url || '(url not captured)')}</div>
      ${e.requestData ? `<details open><summary>Request body / parameters</summary><pre class="resp-body">${esc(e.requestData)}</pre></details>` : '<div class="hint" style="margin:2px 0">no request body</div>'}
      ${e.requestHeaders ? `<details><summary>Request headers</summary><pre class="resp-body">${esc(e.requestHeaders)}</pre></details>` : ''}
      ${e.cookies ? `<details><summary>Cookies</summary><pre class="resp-body">${esc(e.cookies)}</pre></details>` : ''}
    </div>
    <div class="err-res">
      <b>◀ Response</b> <span class="err-code">${esc(e.code)} ${esc(e.msg)}</span>
      ${e.assertion ? `<div style="color:var(--critical)"><b>Assertion failure:</b> ${esc(e.assertion)}</div>` : ''}
      ${e.responseHeaders ? `<details><summary>Response headers</summary><pre class="resp-body">${esc(e.responseHeaders)}</pre></details>` : ''}
      <details open><summary>Response body</summary><pre class="resp-body">${e.responseBody ? esc(e.responseBody) : '(empty)'}</pre></details>
    </div>
  </div>`;
}

// Error Responses — every DISTINCT error type with its true count across the
// whole run (grouped like JMeter's error summary), plus a captured example
// response per type. No error type gets lost behind thousands of duplicates.
async function loadErrorsTab() {
  $('tab-errors').innerHTML = '<p class="empty">loading…</p>';
  try {
    const d = await api('GET', `/api/runs/${detailState.id}/error-summary?${filterQs()}`);
    if (!d.totalErrors) {
      $('tab-errors').innerHTML = '<p class="empty">No failed samples in this run 🎉</p>';
      return;
    }
    $('tab-errors').innerHTML = `
      <p class="hint" style="margin:0 0 10px;">${fmt.n(d.totalErrors)} failed samples (${(100 * d.totalErrors / d.totalSamples).toFixed(2)}% of ${fmt.n(d.totalSamples)})
        grouped into <b>${d.groups.length} distinct error type(s)</b>. Click a row to see captured request + response examples.
        ${d.captureTruncated ? ' <b style="color:var(--warning)">Some capture files were too large to fully parse.</b>' : ''}</p>
      <table>
        <thead><tr><th>Sampler</th><th>Code</th><th>Message</th><th>Assertion / failure</th><th class="num">Count</th><th class="num">Examples</th></tr></thead>
        <tbody>${d.groups.map((g) => `
          <tr class="sample-row">
            <td>${esc(g.label)}</td>
            <td style="color:var(--critical); font-weight:600">${esc(g.code) || '–'}</td>
            <td>${esc(g.msg) || '–'}</td>
            <td>${esc(g.failure) || '–'}</td>
            <td class="num" style="font-weight:650">${fmt.n(g.count)}</td>
            <td class="num">${g.examples.length}${g.examples.length >= 25 ? '+' : ''}</td>
          </tr>
          <tr class="sample-detail" style="display:none"><td colspan="6">
            <div class="hint" style="margin:0 0 8px;">First seen ${new Date(g.firstTs).toLocaleTimeString('en-GB')} · last seen ${new Date(g.lastTs).toLocaleTimeString('en-GB')}
              · showing ${g.examples.length} captured example(s) of ${fmt.n(g.count)}</div>
            ${g.examples.length ? g.examples.map((e, i) => errorExampleHtml(e, i)).join('') :
              '<span class="hint" style="margin:0">No captured example — the response capture for this type was lost (e.g. an agent’s upload failed). Re-run to capture it.</span>'}
          </td></tr>`).join('')}
        </tbody>
      </table>`;
    document.querySelectorAll('#tab-errors .sample-row').forEach((tr) => {
      tr.onclick = () => {
        const det = tr.nextElementSibling;
        det.style.display = det.style.display === 'none' ? '' : 'none';
      };
    });
  } catch (e) {
    $('tab-errors').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
}

async function loadAgentsTab() {
  $('tab-agents').innerHTML = '<p class="empty">loading…</p>';
  try {
    const per = await agentSummaries();
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
      <p class="hint">Use the "Showing results of" selector above to switch the charts, reports and results table to a single agent.</p>`;
  } catch (e) {
    $('tab-agents').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
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
  $('samplesBox').innerHTML = '<p class="empty">loading…</p>';
  try {
    const d = await api('GET', `/api/runs/${detailState.id}/samples?offset=${detailState.offset}&limit=${detailState.pageSize}` +
      `${detailState.errorsOnly ? '&errors=1' : ''}&${filterQs()}`);
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
    $('samplesBox').innerHTML = `<p class="empty">${esc(e.message)}</p>`;
  }
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
  const sheetTable = (sheet) => { reportState.activeSheet = sheet; renderReport(); return $('reportGrid').innerHTML.replace(/<input[^>]*value="([^"]*)"[^>]*>/g, '$1').replace(/<button[^>]*>.*?<\/button>/g, '').replace(/<span class="col-del"[^>]*>.*?<\/span>/g, ''); };
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

function renderAgents() {
  $('agentEmpty').style.display = state.agents.length ? 'none' : 'block';
  $('agentRows').innerHTML = state.agents.map((a) => `
    <tr>
      <td><b>${esc(a.name)}</b>${a.stub ? ' <span class="chip">STUB</span>' : ''}</td>
      <td>${esc(a.address || '')}</td>
      <td class="num">${a.cpus}</td>
      <td class="num">${a.memGB} GB</td>
      <td>${resMeter(a.res, a.name)}</td>
      <td>${a.jmeterReady ? 'ready' : 'will bootstrap'}</td>
      <td><span class="state ${a.state === 'running' ? 'running' : ''}">${a.state}</span></td>
      <td><button class="ghost mini row-del" title="Stop this agent (its process exits; reinstall/restart it on that PC to bring it back)"
        onclick="stopAgent('${esc(a.name)}')">✕ Stop</button></td>
    </tr>`).join('');
}

window.stopAgent = async (name) => {
  if (!confirm(`Stop agent "${name}"?\nIts process will exit on that PC. Start it again there (or via its Startup shortcut at next login) to bring it back.`)) return;
  try { await api('POST', `/api/agents/${encodeURIComponent(name)}/shutdown`); }
  catch (e) { alert(`Failed: ${e.message}`); }
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------------- boot: restore state on page load ----------------

(async () => {
  try {
    state.agents = await api('GET', '/api/agents');
    renderAgents();
    state.library = (await api('GET', '/api/library')).files || [];
    const runs = await api('GET', '/api/runs');
    const active = runs.find((r) => r.state === 'running' || r.state === 'finalizing');
    if (active) {
      onRunUpdate(active);
      showView('live');
    } else if (runs.length) {
      // Live tab shows the most recent run's results instead of an empty page.
      onRunUpdate(runs[0]);
      loadFinalIntoLive(runs[0].id);
    }
  } catch { /* server starting up */ }
})();

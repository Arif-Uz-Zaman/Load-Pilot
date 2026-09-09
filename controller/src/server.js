'use strict';
/**
 * LoadPilot controller server.
 *  - Web UI (public/) for the person driving the test
 *  - REST API for plans/runs
 *  - WebSocket /ws/agent  — agent PCs connect here (outbound from their side)
 *  - WebSocket /ws/ui     — browsers get live agent/run/stat updates
 *
 * No auth: intended for a trusted office LAN only.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { WebSocketServer } = require('ws');

const { parseJmx } = require('./jmx');
const { AgentHub } = require('./agents');
const { RunManager, findJmeter } = require('./runs');
const { Scheduler } = require('./scheduler');
const { sampleWindow, summarizeJtl, timelineFromJtl, timelineByLabel, parseErrorsXml, errorSummaryFromJtl } = require('./stats');
const { ReportStore } = require('./report');
const config = require('./config');
const cfg = config.load();

const PORT = cfg.port;
const DATA_DIR = cfg.dataDir;
const PLANS_DIR = path.join(DATA_DIR, 'plans');
const LIB_DIR = path.join(DATA_DIR, 'library');
fs.mkdirSync(PLANS_DIR, { recursive: true });
fs.mkdirSync(LIB_DIR, { recursive: true });

// The data-file LIBRARY persists across plan uploads: upload a CSV once and
// every future JMX that references that name just works.
function readLib() {
  try { return JSON.parse(fs.readFileSync(path.join(LIB_DIR, 'files.json'), 'utf8')); } catch { return { files: [] }; }
}
function saveLib(lib) {
  fs.writeFileSync(path.join(LIB_DIR, 'files.json'), JSON.stringify(lib, null, 2));
}

const app = express();
const server = http.createServer(app);

// ---------- websockets ----------

const hub = new AgentHub();
const uiSockets = new Set();
const wssAgent = new WebSocketServer({ noServer: true });
const wssUi = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/ws/agent') {
    wssAgent.handleUpgrade(req, socket, head, (ws) => hub.attach(ws, req));
  } else if (pathname === '/ws/ui') {
    wssUi.handleUpgrade(req, socket, head, (ws) => {
      uiSockets.add(ws);
      ws.on('close', () => uiSockets.delete(ws));
      ws.send(JSON.stringify({ type: 'agents', agents: hub.list() }));
    });
  } else {
    socket.destroy();
  }
});

function broadcastUi(msg) {
  const s = JSON.stringify(msg);
  for (const ws of uiSockets) if (ws.readyState === ws.OPEN) ws.send(s);
}

const reports = new ReportStore(DATA_DIR);
const runs = new RunManager({ dataDir: DATA_DIR, hub, broadcastUi, baseUrl: '', reports });

const scheduler = new Scheduler({
  dataDir: DATA_DIR,
  trigger: (planId, config) => triggerRun(planId, config),
  connectedAgents: () => hub.list().map((a) => a.name),
  isBusy: () => !!runs.active,
  onChange: () => broadcastUi({ type: 'schedulesUpdated' }),
});

hub.onChange = () => broadcastUi({ type: 'agents', agents: hub.list() });
hub.onResStats = (name, res) => broadcastUi({ type: 'agentRes', name, res });
hub.onAgentMessage = (name, msg) => {
  // An agent still working a run the controller has already closed (e.g. it
  // dropped and the run finalized) is an orphan — tell it to stop.
  if (msg.type === 'status' && msg.state === 'running' && msg.runId
      && (!runs.active || runs.active.id !== msg.runId)) {
    hub.send(name, { type: 'stop', runId: msg.runId });
    return;
  }
  runs.onAgentMessage(name, msg);
};
hub.onAgentLost = (name, runId) => runs.onAgentLost(name, runId);
hub.startHeartbeat();

// ---------- helpers ----------

function safeName(s) {
  return String(s).replace(/[^\w.-]/g, '_');
}

function planDir(id) {
  return path.join(PLANS_DIR, safeName(id));
}

function readPlan(id) {
  let plan;
  try { plan = JSON.parse(fs.readFileSync(path.join(planDir(id), 'plan.json'), 'utf8')); } catch { return null; }
  // Plans uploaded before a parser change lack newer structure fields (e.g.
  // dataFileRefs[].threadGroupId). Re-parse from the stored JMX so existing
  // plans get today's structure without needing a re-upload.
  try {
    const st = plan.structure;
    const stale = !st || !st.dataFileRefs || !st.variables // variables added later
      || st.dataFileRefs.some((r) => r.threadGroupId === undefined)
      || (st.controllers || []).some((c) => c.seq === undefined); // tree metadata added later
    if (stale) {
      const xml = fs.readFileSync(path.join(planDir(id), 'original.jmx'), 'utf8');
      plan.structure = parseJmx(xml);
    }
  } catch { /* keep stored structure */ }
  return plan;
}

// ---------- REST: plans ----------

const rawBody = express.raw({ type: () => true, limit: '200mb' });
// Per-agent run configs (many agents × many samplers/controllers) exceed
// express.json's 100 KB default — use a generous limit for config-bearing routes.
const jsonLarge = express.json({ limit: '25mb' });

app.post('/api/plans', rawBody, (req, res) => {
  try {
    const xml = req.body.toString('utf8');
    const structure = parseJmx(xml);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const dir = planDir(id);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'original.jmx'), xml);
    const plan = {
      id,
      fileName: req.headers['x-filename'] || 'plan.jmx',
      name: structure.testPlanName,
      uploadedAt: new Date().toISOString(),
      files: [],
      structure,
    };
    fs.writeFileSync(path.join(dir, 'plan.json'), JSON.stringify(plan, null, 2));
    res.json(plan);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/plans', (_req, res) => {
  const list = fs.readdirSync(PLANS_DIR)
    .map(readPlan)
    .filter(Boolean)
    .sort((a, b) => (a.uploadedAt < b.uploadedAt ? 1 : -1))
    .map(({ structure, ...p }) => p);
  res.json(list);
});

app.get('/api/plans/:id', (req, res) => {
  const plan = readPlan(req.params.id);
  if (!plan) return res.status(404).json({ error: 'plan not found' });
  res.json(plan);
});

// Open a COPY of a plan in the bundled JMeter GUI (on the controller's desktop),
// so the user can edit with full fidelity. The edit is a working copy — importing
// it back creates a NEW plan; the original is untouched.
const JMETER_EDIT_DIR = path.join(DATA_DIR, 'jmeter-edit');
app.post('/api/plans/:id/open-in-jmeter', (req, res) => {
  const plan = readPlan(req.params.id);
  if (!plan) return res.status(404).json({ error: 'plan not found' });
  const jmeterBat = findJmeter();
  if (!jmeterBat) return res.status(400).json({ error: 'JMeter is not available on the controller (bundles/jmeter.zip missing).' });
  const src = path.join(planDir(req.params.id), 'original.jmx');
  if (!fs.existsSync(src)) return res.status(404).json({ error: 'plan file missing on disk' });
  const editId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const dir = path.join(JMETER_EDIT_DIR, editId);
  fs.mkdirSync(dir, { recursive: true });
  const work = path.join(dir, `${safeName(plan.name || 'plan')} (edit).jmx`);
  fs.copyFileSync(src, work);
  try {
    // shell:true runs the .bat; detached+unref so the GUI outlives this request.
    const child = require('child_process').spawn(`"${jmeterBat}" -t "${work}"`, {
      cwd: dir, detached: true, stdio: 'ignore', shell: true, windowsHide: false,
    });
    child.unref();
  } catch (e) { return res.status(500).json({ error: 'failed to launch JMeter: ' + e.message }); }
  res.json({ editId, file: work });
});

// Re-import the edited working copy as a NEW plan (after the user saved in JMeter).
app.post('/api/plans/import-edited', express.json(), (req, res) => {
  const editId = (req.body && String(req.body.editId || '')) || '';
  if (!/^[a-z0-9]+$/i.test(editId)) return res.status(400).json({ error: 'bad editId' });
  const dir = path.join(JMETER_EDIT_DIR, editId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'edit session not found' });
  const jmx = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.jmx'));
  if (!jmx) return res.status(404).json({ error: 'no .jmx found in the edit session' });
  try {
    const xml = fs.readFileSync(path.join(dir, jmx), 'utf8');
    const structure = parseJmx(xml);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const pdir = planDir(id);
    fs.mkdirSync(pdir, { recursive: true });
    fs.writeFileSync(path.join(pdir, 'original.jmx'), xml);
    const plan = { id, fileName: jmx, name: structure.testPlanName, uploadedAt: new Date().toISOString(), files: [], structure };
    fs.writeFileSync(path.join(pdir, 'plan.json'), JSON.stringify(plan, null, 2));
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* leave temp */ }
    res.json(plan);
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ---------- REST: data-file library (persists across plan uploads) ----------
// Each file has a delivery mode:
//   shared    — every agent gets the same file
//   split     — controller divides the data rows evenly among the run's agents
//   per-agent — a separate upload per agent (all delivered under the same
//               logical filename the JMX references)

app.get('/api/library', (_req, res) => res.json(readLib()));

app.post('/api/library/files', rawBody, (req, res) => {
  const lib = readLib();
  const logical = safeName(req.headers['x-filename'] || 'data.csv');
  const mode = ['shared', 'split', 'per-agent'].includes(req.headers['x-mode']) ? req.headers['x-mode'] : 'shared';
  const agent = req.headers['x-agent'] ? safeName(req.headers['x-agent']) : null;
  if (mode === 'per-agent' && !agent) return res.status(400).json({ error: 'x-agent header required for per-agent files' });

  const stored = mode === 'per-agent' ? `agent__${agent}__${logical}` : logical;
  fs.writeFileSync(path.join(LIB_DIR, stored), req.body);
  // remember the ORIGINAL filename the user picked, so the UI can show which
  // actual file each agent is using (filename doesn't matter for delivery,
  // but you still want to verify the assignment).
  const origName = req.headers['x-origname'] || logical;
  const bytes = req.body ? req.body.length : 0;

  let entry = lib.files.find((f) => f.logical === logical);
  if (!entry) {
    entry = { logical, mode, hasHeader: true, perAgent: {}, perAgentOrig: {} };
    lib.files.push(entry);
  }
  if (!entry.perAgentOrig) entry.perAgentOrig = {};
  entry.mode = mode;
  if (mode === 'per-agent') { entry.perAgent[agent] = stored; entry.perAgentOrig[agent] = { name: origName, bytes }; }
  else { entry.stored = stored; entry.origName = origName; entry.bytes = bytes; }
  saveLib(lib);
  res.json({ ok: true, files: lib.files });
});

// Update a library file's mode / header flag, or rename its logical name
// (e.g. assign an uploaded "part2.csv" to satisfy plans reading "part4.csv").
app.patch('/api/library/files/:logical', express.json(), (req, res) => {
  const lib = readLib();
  const entry = lib.files.find((f) => f.logical === safeName(req.params.logical));
  if (!entry) return res.status(404).json({ error: 'file not found' });
  if (['shared', 'split', 'per-agent'].includes(req.body.mode)) entry.mode = req.body.mode;
  if (typeof req.body.hasHeader === 'boolean') entry.hasHeader = req.body.hasHeader;
  if (req.body.renameTo) {
    const to = safeName(req.body.renameTo);
    if (lib.files.some((f) => f !== entry && f.logical === to)) {
      return res.status(400).json({ error: `a data file named ${to} already exists` });
    }
    try {
      if (entry.stored && fs.existsSync(path.join(LIB_DIR, entry.stored))) {
        fs.renameSync(path.join(LIB_DIR, entry.stored), path.join(LIB_DIR, to));
        entry.stored = to;
      }
      for (const [agent, stored] of Object.entries(entry.perAgent || {})) {
        const newStored = `agent__${agent}__${to}`;
        if (fs.existsSync(path.join(LIB_DIR, stored))) fs.renameSync(path.join(LIB_DIR, stored), path.join(LIB_DIR, newStored));
        entry.perAgent[agent] = newStored;
      }
      entry.logical = to;
    } catch (e) {
      return res.status(500).json({ error: `rename failed: ${e.message}` });
    }
  }
  saveLib(lib);
  res.json({ ok: true, files: lib.files });
});

app.delete('/api/library/files/:logical', (req, res) => {
  const lib = readLib();
  const i = lib.files.findIndex((f) => f.logical === safeName(req.params.logical));
  if (i === -1) return res.status(404).json({ error: 'file not found' });
  const entry = lib.files[i];
  for (const stored of [entry.stored, ...Object.values(entry.perAgent || {})].filter(Boolean)) {
    try { fs.unlinkSync(path.join(LIB_DIR, stored)); } catch { /* already gone */ }
  }
  lib.files.splice(i, 1);
  saveLib(lib);
  res.json({ ok: true, files: lib.files });
});

// Agents download library files from here during a run.
app.get('/api/library/files/:name', (req, res) => {
  const file = path.join(LIB_DIR, safeName(req.params.name));
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

// ---------- REST: agents ----------

app.get('/api/agents', (_req, res) => res.json(hub.list()));

// Ask a connected agent to shut itself down (it exits; the row disappears).
app.post('/api/agents/:name/shutdown', (req, res) => {
  const ok = hub.send(req.params.name, { type: 'shutdown' });
  res.json({ ok, note: ok ? 'shutdown sent' : 'agent not connected' });
});

// ---------- REST: reports ----------

const nowIso = () => new Date().toISOString();

app.get('/api/reports', (_req, res) => res.json(reports.list()));
app.post('/api/reports', express.json(), (req, res) => res.json(reports.create(req.body.name, nowIso())));
app.get('/api/reports/default', (_req, res) => res.json(reports._withAggregates(reports.ensureDefault(nowIso()))));

app.get('/api/reports/:id', (req, res) => {
  const r = reports.get(req.params.id);
  r ? res.json(r) : res.status(404).json({ error: 'report not found' });
});
app.patch('/api/reports/:id', express.json(), (req, res) => {
  const r = reports.update(req.params.id, req.body);
  r ? res.json(r) : res.status(404).json({ error: 'report not found' });
});
app.delete('/api/reports/:id', (req, res) => res.json({ ok: reports.remove(req.params.id) }));

app.post('/api/reports/:id/people', express.json(), (req, res) => {
  const r = reports.addPerson(req.params.id, req.body.name, req.body.agent, nowIso());
  r ? res.json(r) : res.status(404).json({ error: 'report not found' });
});
app.patch('/api/reports/:id/people/:pid', express.json(), (req, res) => {
  const r = reports.updatePerson(req.params.id, req.params.pid, req.body);
  r ? res.json(r) : res.status(404).json({ error: 'not found' });
});
app.delete('/api/reports/:id/people/:pid', (req, res) => {
  const r = reports.removePerson(req.params.id, req.params.pid);
  r ? res.json(r) : res.status(404).json({ error: 'not found' });
});

app.post('/api/reports/:id/rows', express.json(), (req, res) => {
  const r = reports.addRow(req.params.id, req.body, nowIso());
  r ? res.json(r) : res.status(404).json({ error: 'report not found' });
});
app.patch('/api/reports/:id/rows/:rowId', express.json(), (req, res) => {
  const r = reports.updateRow(req.params.id, req.params.rowId, req.body);
  r ? res.json(r) : res.status(404).json({ error: 'not found' });
});
app.delete('/api/reports/:id/rows/:rowId', (req, res) => {
  const r = reports.removeRow(req.params.id, req.params.rowId);
  r ? res.json(r) : res.status(404).json({ error: 'not found' });
});

app.get('/api/reports/:id/export.xlsx', (req, res) => {
  const wb = reports.toWorkbook(req.params.id);
  if (!wb) return res.status(404).json({ error: 'report not found' });
  res.setHeader('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('content-disposition', `attachment; filename="${safeName(wb.name)}.xlsx"`);
  res.send(wb.buffer);
});
app.get('/api/reports/:id/export.csv', (req, res) => {
  const c = reports.toCsv(req.params.id);
  if (!c) return res.status(404).json({ error: 'report not found' });
  res.setHeader('content-type', 'text/csv');
  res.setHeader('content-disposition', `attachment; filename="${safeName(c.name)}.csv"`);
  res.send(c.csv);
});

// ---------- REST: runs ----------

// Shared run-start: load the plan, work out which CSVs this config needs, and
// hand off to the RunManager. Used by the manual New Run POST and the scheduler.
function triggerRun(planId, config) {
  const plan = readPlan(planId);
  if (!plan) throw new Error('plan not found');
  const xml = fs.readFileSync(path.join(planDir(plan.id), 'original.jmx'), 'utf8');
  // A CSV is required only if its CSV Data Set is enabled AND it's global OR its
  // owning thread group is enabled — across ALL agents in per-agent mode.
  const enabledTgIds = new Set();
  if (config.mode === 'per-agent') {
    for (const ac of Object.values(config.agentConfigs || {}))
      for (const t of (ac.threadGroups || [])) if (t.enabled) enabledTgIds.add(t.id);
  } else {
    for (const t of (config.threadGroups || [])) if (t.enabled) enabledTgIds.add(t.id);
  }
  const requiredNames = (((plan.structure || {}).dataFileRefs) || [])
    .filter((r) => r.enabled && (r.threadGroupId == null || enabledTgIds.has(r.threadGroupId)))
    .map((r) => r.name);
  return runs.startRun({
    plan: { id: plan.id, name: plan.name, xml, requiredNames },
    config,
    library: { dir: LIB_DIR, files: readLib().files },
  });
}

app.post('/api/runs', jsonLarge, (req, res) => {
  try {
    const { planId, config } = req.body;
    if (!readPlan(planId)) return res.status(404).json({ error: 'plan not found' });
    res.json(triggerRun(planId, config));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- REST: scheduled / recurring runs ----------
app.get('/api/schedules', (_req, res) => res.json(scheduler.list()));
app.post('/api/schedules', jsonLarge, (req, res) => {
  try {
    const { name, planId, planName, config, recur } = req.body || {};
    if (!readPlan(planId)) return res.status(404).json({ error: 'plan not found' });
    res.json(scheduler.add({ name, planId, planName, config, recur }));
  } catch (e) { res.status(400).json({ error: e.message }); }
});
app.patch('/api/schedules/:id', jsonLarge, (req, res) => {
  try { res.json(scheduler.update(req.params.id, req.body || {})); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.delete('/api/schedules/:id', (req, res) => {
  try { scheduler.remove(req.params.id); res.json({ ok: true }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});
app.post('/api/schedules/:id/run', (req, res) => {
  try { res.json({ ok: true, run: scheduler.runNow(req.params.id) }); }
  catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/runs/:id/stop', (req, res) => {
  try {
    runs.stopRun(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/runs', (_req, res) => res.json(runs.listRuns()));

app.delete('/api/runs/:id', (req, res) => {
  const id = req.params.id;
  if (runs.active && runs.active.id === id) {
    return res.status(400).json({ error: 'run is active — stop it before deleting' });
  }
  const dir = runs.runDir(id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'run not found' });
  fs.rmSync(dir, { recursive: true, force: true });
  tgNamesCache.delete(id);
  res.json({ ok: true });
});

app.get('/api/runs/:id', (req, res) => {
  const run = runs.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });
  if (!run.tgNames) run.tgNames = runTgNames(req.params.id); // runs made before tgNames existed
  res.json(run);
});

// Agents download the rewritten plan from here.
app.get('/api/runs/:id/files/:name', (req, res) => {
  const file = path.join(runs.runDir(req.params.id), safeName(req.params.name));
  if (!fs.existsSync(file)) return res.status(404).end();
  res.sendFile(file);
});

// Agents stream their full JTL here when the job ends (can be large — stream to disk).
app.post('/api/runs/:id/results', (req, res) => {
  const dir = runs.runDir(req.params.id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'run not found' });
  const agent = safeName(req.query.agent || 'unknown');
  const out = fs.createWriteStream(path.join(dir, `results-${agent}.jtl`));
  req.pipe(out);
  out.on('finish', () => res.json({ ok: true }));
  out.on('error', (e) => res.status(500).json({ error: e.message }));
});

// Results file for the whole run (merged) or one agent's share of it.
function resultsFile(runId, agent) {
  const dir = runs.runDir(runId);
  return agent
    ? path.join(dir, `results-${safeName(agent)}.jtl`)
    : path.join(dir, 'merged.jtl');
}

// Thread-group names of a run (for sample attribution). Active runs carry them
// in memory; finished runs are parsed from the stored plan once and cached.
const tgNamesCache = new Map();
function runTgNames(id) {
  if (runs.active && runs.active.id === id) return runs.active.tgNames || [];
  if (tgNamesCache.has(id)) return tgNamesCache.get(id);
  let names = [];
  try {
    names = parseJmx(fs.readFileSync(path.join(runs.runDir(id), 'plan.jmx'), 'utf8'))
      .threadGroups.map((t) => t.name);
  } catch { /* run without a stored plan */ }
  tgNamesCache.set(id, names);
  return names;
}

function tgOpts(req) {
  return req.query.tg ? { tg: req.query.tg, tgNames: runTgNames(req.params.id) } : {};
}

// Raw samples — powers "View Results in Table" (optionally one agent's view).
app.get('/api/runs/:id/samples', async (req, res) => {
  const file = resultsFile(req.params.id, req.query.agent);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'no results for this run/agent yet' });
  try {
    res.json(await sampleWindow(file, {
      offset: Math.max(0, parseInt(req.query.offset, 10) || 0),
      limit: Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 100)),
      errorsOnly: req.query.errors === '1',
      ...tgOpts(req),
    }));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Per-second throughput/latency/error timeline — powers the post-run charts.
app.get('/api/runs/:id/timeline', async (req, res) => {
  const file = resultsFile(req.params.id, req.query.agent);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'no results for this run/agent yet' });
  try {
    res.json(await timelineFromJtl(file, tgOpts(req)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Per-sampler timeline (requests/sec, errors, avg response per label + active
// threads) for the dashboard's multi-series / stacked-area charts.
app.get('/api/runs/:id/timeline-detail', async (req, res) => {
  const file = resultsFile(req.params.id, req.query.agent);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'no results for this run/agent yet' });
  try {
    res.json(await timelineByLabel(file, tgOpts(req)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// On-demand filtered report (agent and/or thread group) — same shape as the
// stored summary.json, computed from the relevant JTL.
app.get('/api/runs/:id/summary', async (req, res) => {
  const file = resultsFile(req.params.id, req.query.agent);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'no results for this run/agent yet' });
  try {
    res.json(await summarizeJtl(file, tgOpts(req)));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Agents upload their errors.xml (failed samples with response body/headers).
app.post('/api/runs/:id/errors', (req, res) => {
  const dir = runs.runDir(req.params.id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'run not found' });
  const agent = safeName(req.query.agent || 'unknown');
  const out = fs.createWriteStream(path.join(dir, `errors-${agent}.xml`));
  req.pipe(out);
  out.on('finish', () => res.json({ ok: true }));
  out.on('error', (e) => res.status(500).json({ error: e.message }));
});

// Grouped error types with TRUE counts from the full results, each enriched
// with a captured example response where available — the "Error Responses" tab.
app.get('/api/runs/:id/error-summary', async (req, res) => {
  const file = resultsFile(req.params.id, req.query.agent);
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'no results for this run/agent yet' });
  try {
    const sum = await errorSummaryFromJtl(file, tgOpts(req));
    // Attach captured request+response examples to each group. Keep up to
    // EXAMPLES_PER_TYPE per (sampler,code) so rare errors always get shown and
    // common ones give several real cases to debug — bounded response size.
    const EXAMPLES_PER_TYPE = 25;
    const tgNames = req.query.tg ? runTgNames(req.params.id) : null;
    const dir = runs.runDir(req.params.id);
    const perType = new Map(); // "label|code" -> examples[]
    let capTruncated = false, captured = 0;
    for (const f of fs.readdirSync(dir)) {
      const m = /^errors-(.*)\.xml$/.exec(f);
      if (!m) continue;
      if (req.query.agent && m[1] !== safeName(req.query.agent)) continue;
      const parsed = parseErrorsXml(path.join(dir, f), 100000);
      if (parsed.tooBig) capTruncated = true;
      for (const e of parsed.entries) {
        if (req.query.tg && require('./stats').resolveTg(e.thread || '', tgNames) !== req.query.tg) continue;
        const key = `${e.label}|${e.code}`;
        let arr = perType.get(key);
        if (!arr) perType.set(key, (arr = []));
        if (arr.length < EXAMPLES_PER_TYPE) { arr.push({ agent: m[1], ...e }); captured++; }
      }
    }
    for (const g of sum.groups) {
      g.examples = perType.get(`${g.label}|${g.code}`) || [];
    }
    sum.captureTruncated = capTruncated;
    sum.captured = captured;
    res.json(sum);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Captured error responses across all agents — the "Error Responses" tab.
app.get('/api/runs/:id/errors', (req, res) => {
  const dir = runs.runDir(req.params.id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'run not found' });
  const limit = Math.min(500, Math.max(1, parseInt(req.query.limit, 10) || 200));
  const result = { entries: [], truncated: false };
  try {
    const { resolveTg } = require('./stats');
    const tg = req.query.tg;
    const tgNames = tg ? runTgNames(req.params.id) : null;
    for (const f of fs.readdirSync(dir)) {
      const m = /^errors-(.*)\.xml$/.exec(f);
      if (!m) continue;
      if (req.query.agent && m[1] !== safeName(req.query.agent)) continue;
      const parsed = parseErrorsXml(path.join(dir, f), limit - result.entries.length);
      if (parsed.tooBig) result.truncated = true;
      for (const e of parsed.entries) {
        if (tg && resolveTg(e.thread || '', tgNames) !== tg) continue;
        result.entries.push({ agent: m[1], ...e });
      }
      if (result.entries.length >= limit) { result.truncated = true; break; }
    }
    result.entries.sort((a, b) => a.t - b.t);
    res.json(result);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Per-agent summaries (each agent's own JTL, summarized individually).
// Honors ?tg= so the Per Agent tab matches the thread-group filter.
app.get('/api/runs/:id/agents-summary', async (req, res) => {
  const dir = runs.runDir(req.params.id);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'run not found' });
  const opts = tgOpts(req);
  const cache = path.join(dir, 'agents-summary.json');
  if (!opts.tg && fs.existsSync(cache)) return res.sendFile(cache);
  try {
    const out = [];
    for (const f of fs.readdirSync(dir)) {
      const m = /^results-(.*)\.jtl$/.exec(f);
      if (m) out.push({ agent: m[1], ...(await summarizeJtl(path.join(dir, f), opts)) });
    }
    // Cache only the unfiltered view, and never while the run is still active.
    if (!opts.tg && (!runs.active || runs.active.id !== req.params.id)) {
      fs.writeFileSync(cache, JSON.stringify(out));
    }
    res.json(out);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/runs/:id/merged.jtl', (req, res) => {
  const file = path.join(runs.runDir(req.params.id), 'merged.jtl');
  if (!fs.existsSync(file)) return res.status(404).end();
  res.download(file, `${safeName(req.params.id)}.jtl`);
});

app.get('/api/runs/:id/log', (req, res) => {
  const file = path.join(runs.runDir(req.params.id), 'run.log');
  if (!fs.existsSync(file)) return res.type('text/plain').send('');
  res.type('text/plain').sendFile(file);
});

// JMeter HTML dashboards (generated post-run when JMeter is available locally).
app.use('/runs-static', express.static(path.join(DATA_DIR, 'runs')));

// Agent bootstrap bundles: drop apache-jmeter zip as bundles/jmeter.zip (and a
// JRE as bundles/jre.zip) and agents with nothing installed pull them from here.
app.use('/bundle', express.static(cfg.bundlesDir));

// ---------- REST: SLA pass/fail thresholds ----------
// Simple gate applied to each run's overall stats. null = not enforced.
const SLA_FILE = path.join(DATA_DIR, 'sla.json');
const DEFAULT_SLA = { maxErrorPct: 1, maxP90Ms: null, minThroughput: null };
function readSla() {
  try { return { ...DEFAULT_SLA, ...JSON.parse(fs.readFileSync(SLA_FILE, 'utf8')) }; }
  catch { return { ...DEFAULT_SLA }; }
}
app.get('/api/sla', (_req, res) => res.json(readSla()));
app.put('/api/sla', express.json(), (req, res) => {
  const b = req.body || {};
  const num = (v) => (v === null || v === '' || v === undefined || !Number.isFinite(+v) ? null : +v);
  const sla = { maxErrorPct: num(b.maxErrorPct), maxP90Ms: num(b.maxP90Ms), minThroughput: num(b.minThroughput) };
  try { fs.writeFileSync(SLA_FILE, JSON.stringify(sla, null, 2)); res.json({ ok: true, sla }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- Google Sheets sync ----------
// After each finished run, POST its summary to a Google Apps Script Web App URL
// (deployed from the user's sheet) which appends a row. No Google auth needed
// on our side — the script runs as the sheet owner.
const SHEETS_FILE = path.join(DATA_DIR, 'sheets.json');
function readSheets() {
  try { return JSON.parse(fs.readFileSync(SHEETS_FILE, 'utf8')); } catch { return { url: '', enabled: false }; }
}
function fmtSheetDate(iso) {
  const d = new Date(iso);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function fmtClock(sec) {
  sec = Math.max(0, Math.round(sec || 0));
  return `${Math.floor(sec / 3600)}:${String(Math.floor((sec % 3600) / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

// Structured payload for a report-style Google Sheet: one Main Report row +
// one row per PERSON (agents grouped by the run's agent→person assignment).
async function buildSheetPayload(run, summary) {
  const o = (summary && summary.overall) || {};
  const dir = runs.runDir(run.id);
  const report = (run.config && run.config.report) || {};
  const assignments = report.assignments || {}; // agent name -> personId
  // resolve personId -> display name (which is what matches the sheet's tab names)
  const personName = {};
  if (report.reportId) {
    const rep = reports.get(report.reportId);
    if (rep && rep.people) for (const p of rep.people) personName[p.id] = p.name;
  }

  const byPerson = new Map();
  for (const a of (run.agents || [])) {
    const pid = assignments[a.name];
    const person = (pid && personName[pid]) || pid || a.name;
    let s = { overall: { samples: 0, errors: 0, throughput: 0 }, durationSec: 0 };
    const f = path.join(dir, `results-${safeName(a.name)}.jtl`);
    if (fs.existsSync(f)) { try { s = await summarizeJtl(f); } catch { /* keep zeros */ } }
    const threads = Math.max(0, ...Object.values(a.props || {}).map((v) => parseInt(v, 10) || 0), 0);
    let g = byPerson.get(person);
    if (!g) byPerson.set(person, (g = { person, samples: 0, errors: 0, throughput: 0, threads: 0, durationSec: 0 }));
    g.samples += s.overall.samples || 0;
    g.errors += s.overall.errors || 0;
    g.throughput += s.overall.throughput || 0;
    g.threads += threads;
    g.durationSec = Math.max(g.durationSec, s.durationSec || 0);
  }
  const persons = [...byPerson.values()].map((g) => ({
    person: g.person,
    errorRatePct: g.samples ? +(100 * g.errors / g.samples).toFixed(2) : 0,
    throughput: +g.throughput.toFixed(2),
    time: fmtClock(g.durationSec),
    thread: g.threads,
  }));
  return {
    // Main Report row (A, B, D, E, F — the rest are your formulas)
    date: fmtSheetDate(run.createdAt),
    action: report.action || run.planName || '',
    totalThread: report.totalThread || persons.reduce((s, p) => s + p.thread, 0),
    ramp: report.rampTime != null && report.rampTime !== '' ? report.rampTime : '',
    loop: report.loop != null && report.loop !== '' ? report.loop : '',
    // per-person rows (G, H, I, J on each person's tab)
    persons,
    // flat overall fields too, so a plain single-tab sheet still works
    runId: run.id, plan: run.planName || '', target: (run.targets || [])[0] || '',
    agents: (run.agents || []).map((a) => a.name).join(', '), agentCount: (run.agents || []).length,
    samples: o.samples || 0, errors: o.errors || 0, errorPct: o.errorPct || 0,
    avg: o.avg || 0, median: o.median || 0, p90: o.p90 || 0, p95: o.p95 || 0, p99: o.p99 || 0,
    min: o.min || 0, max: o.max || 0, throughput: o.throughput || 0,
    durationSec: (summary && summary.durationSec) || 0, time: fmtClock(summary && summary.durationSec),
  };
}
async function postSheetRow(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'follow',
  });
  const body = await res.text().catch(() => '');
  return { ok: res.ok, status: res.status, body: body.slice(0, 300) };
}

runs.onRunFinished = async (run, summary) => {
  const cfg = readSheets();
  // send if global auto-sync is on OR this specific run opted in — as long as a URL is set
  if (!cfg.url) return;
  if (!cfg.enabled && !(run.config && run.config.syncSheet)) return;
  try {
    const r = await postSheetRow(cfg.url, await buildSheetPayload(run, summary));
    console.log(`[sheets] run ${run.id} -> HTTP ${r.status}`);
  } catch (e) { console.log(`[sheets] run ${run.id} sync failed: ${e.message}`); }
};

app.get('/api/sheets', (_req, res) => res.json(readSheets()));
app.put('/api/sheets', express.json(), (req, res) => {
  const b = req.body || {};
  const s = { url: String(b.url || '').trim(), enabled: !!b.enabled };
  try { fs.writeFileSync(SHEETS_FILE, JSON.stringify(s, null, 2)); res.json({ ok: true, sheets: s }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Manually push one finished run to the sheet (for old runs, or a re-send).
app.post('/api/runs/:id/sheet', async (req, res) => {
  const cfg = readSheets();
  if (!cfg.url) return res.status(400).json({ error: 'No Google Sheet is configured yet — set it up in Settings → Google Sheets sync.' });
  const run = runs.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });
  if (!run.summary || !run.summary.overall || !run.summary.overall.samples) {
    return res.status(400).json({ error: 'this run produced no results to send' });
  }
  try { res.json(await postSheetRow(cfg.url, await buildSheetPayload(run, run.summary))); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

app.post('/api/sheets/test', express.json(), async (req, res) => {
  const url = (req.body && String(req.body.url || '').trim()) || readSheets().url;
  if (!url) return res.status(400).json({ error: 'Enter the Web App URL first.' });
  const sample = {
    runId: 'TEST-ROW', date: fmtSheetDate(new Date().toISOString()), action: 'LoadPilot connection test',
    totalThread: 100, ramp: 1, loop: 1, persons: [],
    plan: 'LoadPilot connection test', target: 'example.com', agents: 'test', agentCount: 0, durationSec: 5,
    samples: 100, errors: 1, errorPct: 1, avg: 120, median: 90, p90: 250, p95: 300, p99: 500, min: 40, max: 800, throughput: 20, time: '0:00:05',
  };
  try { res.json(await postSheetRow(url, sample)); }
  catch (e) { res.status(502).json({ error: e.message }); }
});

// ---------- Agent directory + redirect ("no fixed controller" mode) ----------
// The controller knows the worker PC IPs, so it can point every agent's small
// control endpoint (port 4101) at whichever controller is running now. That way
// no single controller PC is a permanent dependency — whoever starts a
// controller clicks "Point all agents here" and the agents switch over.
const AGENT_DIR_FILE = path.join(DATA_DIR, 'agent-directory.json');
const AGENT_CONTROL_PORT = 4101;
function readAgentDir() {
  let d;
  try { d = JSON.parse(fs.readFileSync(AGENT_DIR_FILE, 'utf8')); } catch { d = {}; }
  // migrate old flat shape { ips:[...] } -> { agents:[{ip,name,enabled}] }
  if (!Array.isArray(d.agents)) {
    d.agents = (Array.isArray(d.ips) ? d.ips : []).map((ip) => ({ ip, name: '', enabled: true }));
  }
  d.controllerUrl = d.controllerUrl || '';
  return d;
}
function normAgents(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set(); const out = [];
  for (const a of arr) {
    const ip = String((a && a.ip) || '').trim();
    if (!ip || seen.has(ip)) continue;
    seen.add(ip);
    out.push({ ip, name: String((a && a.name) || '').trim(), enabled: !(a && a.enabled === false) });
  }
  return out;
}
function lanIps() {
  return Object.values(os.networkInterfaces()).flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal).map((i) => i.address);
}
function detectedControllerUrl() {
  const ip = lanIps()[0];
  return ip ? `http://${ip}:${PORT}` : `http://localhost:${PORT}`;
}
function effectiveControllerUrl() {
  const d = readAgentDir();
  return (d.controllerUrl && d.controllerUrl.trim()) || detectedControllerUrl();
}
function parseIpList(raw) {
  if (Array.isArray(raw)) raw = raw.join('\n');
  return [...new Set(String(raw || '').split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean))];
}
async function fetchTimeout(url, opts = {}, ms = 4000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctl.signal }); }
  finally { clearTimeout(t); }
}
// Run fn over items with a bounded number of concurrent workers.
async function pool(items, n, fn) {
  const results = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const idx = i++; results[idx] = await fn(items[idx], idx); }
  }));
  return results;
}
// Candidate host IPs to probe: the /24 around each private LAN interface.
function isPrivateV4(ip) {
  return /^192\.168\./.test(ip) || /^10\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}
// Skip VM/host-only adapters — they add phantom "agents" (the local agent answers
// on every card). Match by adapter name, and by the tell-tale host-at-.1 address.
const VIRTUAL_IFACE = /virtualbox|vmware|hyper-v|host-only|vethernet|vmnet|loopback|bluetooth|wsl|tailscale|zerotier/i;
function scanCandidates() {
  const set = new Set();
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    if (VIRTUAL_IFACE.test(name)) continue;
    for (const i of (addrs || [])) {
      if (!i || i.family !== 'IPv4' || i.internal || !isPrivateV4(i.address)) continue;
      if (/\.1$/.test(i.address)) continue; // host-only/virtual network (this PC is the .1 gateway)
      const parts = i.address.split('.');
      if (parts.length !== 4) continue;
      const base = parts.slice(0, 3).join('.');
      for (let h = 1; h <= 254; h++) set.add(`${base}.${h}`);
    }
  }
  return [...set];
}
// Normalize a socket remoteAddress ("::ffff:192.168.3.161") to a plain IPv4.
function cleanIp(a) {
  if (!a) return '';
  const m = String(a).replace(/^::ffff:/i, '').match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})/);
  return m ? m[1] : '';
}

app.get('/api/agent-directory', (_req, res) => {
  const d = readAgentDir();
  res.json({ agents: d.agents, controllerUrl: d.controllerUrl || '', detectedUrl: detectedControllerUrl(), controlPort: AGENT_CONTROL_PORT });
});
app.put('/api/agent-directory', express.json(), (req, res) => {
  const b = req.body || {};
  const agents = Array.isArray(b.agents) ? normAgents(b.agents) : parseIpList(b.ips).map((ip) => ({ ip, name: '', enabled: true }));
  const d = { agents, controllerUrl: String(b.controllerUrl || '').trim() };
  try { fs.writeFileSync(AGENT_DIR_FILE, JSON.stringify(d, null, 2)); res.json({ ok: true, ...d, detectedUrl: detectedControllerUrl() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
// Ping each agent's control endpoint: who's reachable and which controller they point at.
app.post('/api/agent-directory/ping', express.json(), async (req, res) => {
  const ips = (req.body && req.body.ips != null) ? parseIpList(req.body.ips) : readAgentDir().agents.map((a) => a.ip);
  const results = await Promise.all(ips.map(async (ip) => {
    try {
      const r = await fetchTimeout(`http://${ip}:${AGENT_CONTROL_PORT}/lp-agent/ping`, {}, 3000);
      const j = await r.json().catch(() => ({}));
      return { ip, ok: r.ok, name: j.name, controller: j.controller, busy: !!j.busy };
    } catch (e) { return { ip, ok: false, error: e.name === 'AbortError' ? 'no response' : e.message }; }
  }));
  res.json({ results });
});
// Point every listed agent at this controller (or an override URL).
app.post('/api/agent-directory/redirect', express.json(), async (req, res) => {
  const dir = readAgentDir();
  const ips = (req.body && req.body.ips != null) ? parseIpList(req.body.ips) : dir.agents.filter((a) => a.enabled).map((a) => a.ip);
  const url = (req.body && String(req.body.controllerUrl || '').trim()) || effectiveControllerUrl();
  if (!ips.length) return res.status(400).json({ error: 'Tick at least one agent first.' });
  const results = await Promise.all(ips.map(async (ip) => {
    try {
      const r = await fetchTimeout(`http://${ip}:${AGENT_CONTROL_PORT}/lp-agent/set-controller`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }),
      }, 4000);
      const j = await r.json().catch(() => ({}));
      return { ip, ok: r.ok, name: j.name, busy: !!j.busy, error: r.ok ? undefined : (j.message || j.error || `HTTP ${r.status}`) };
    } catch (e) { return { ip, ok: false, error: e.name === 'AbortError' ? 'no response (agent off, or firewall blocking port 4101)' : e.message }; }
  }));
  res.json({ url, results });
});

// Scan the LAN for LoadPilot agents (by probing each host's control endpoint).
// Returns everyone found — including agents currently owned by ANOTHER controller —
// so you can see who's free and pick which ones this controller should take.
app.post('/api/agent-directory/discover', express.json(), async (_req, res) => {
  const ips = scanCandidates();
  // One entry PER PC (IP). Several agents on one PC (Mizan, Mizan-2) collect into
  // one row's `names` — redirect is per-PC, so they move together.
  const byIp = new Map();
  const ensure = (ip) => {
    let e = byIp.get(ip);
    if (!e) { e = { ip, names: new Set(), controller: '', busy: false, control: false, connected: false }; byIp.set(ip, e); }
    return e;
  };
  // 1) Network scan: agents exposing the control endpoint (port 4101) — finds
  //    agents on THIS subnet even if they serve another controller. control:true = redirectable.
  await pool(ips, 128, async (ip) => {
    try {
      const r = await fetchTimeout(`http://${ip}:${AGENT_CONTROL_PORT}/lp-agent/ping`, {}, 600);
      if (!r.ok) return;
      const j = await r.json().catch(() => ({}));
      if (j && j.app === 'loadpilot-agent') { const e = ensure(ip); if (j.name) e.names.add(j.name); e.controller = j.controller || ''; e.busy = !!j.busy; e.control = true; }
    } catch { /* not an agent, or no response */ }
  });
  // 2) Agents CURRENTLY CONNECTED to this controller — real IP known (any subnet, any
  //    exe version). control:false = old agent, can't redirect until updated.
  for (const a of hub.list()) {
    const ip = cleanIp(a.address);
    if (!ip) continue;
    const e = ensure(ip);
    if (a.name) e.names.add(a.name);
    e.connected = true;
    if (!e.controller) e.controller = detectedControllerUrl();
    if (a.state === 'running') e.busy = true;
  }
  const found = [...byIp.values()]
    .map((e) => ({ ip: e.ip, name: [...e.names].join(', '), count: e.names.size, controller: e.controller, busy: e.busy, control: e.control, connected: e.connected }))
    .sort((a, b) => a.ip.localeCompare(b.ip, undefined, { numeric: true }));
  res.json({ scanned: ips.length, found });
});

// ---------- REST: settings ----------

app.get('/api/settings', (_req, res) => {
  res.json({
    editable: {
      dataDir: cfg.dataDir,
      bundlesDir: cfg.bundlesDir,
      runtimeDir: cfg.runtimeDir,
      port: cfg.port,
    },
    derived: {
      'Plans (uploaded JMX)': PLANS_DIR,
      'Runs, results & run logs': path.join(DATA_DIR, 'runs') + '  (each run: run.log, merged.jtl, report/)',
      'Data-file library (CSVs)': LIB_DIR,
      'Reports (Excel-style)': path.join(DATA_DIR, 'reports'),
      'Local JMeter binary': findJmeter() || '(not found — HTML dashboards disabled)',
      'Settings file': config.CONFIG_FILE,
    },
    restartRequired: false,
  });
});

app.patch('/api/settings', express.json(), (req, res) => {
  try {
    const saved = config.save(req.body);
    res.json({ ok: true, saved, restartRequired: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Static web UI. Read files via fs (works from the pkg snapshot too, where
// express.static's stat-based streaming is unreliable).
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
app.get(/.*/, (req, res, next) => {
  if (req.method !== 'GET') return next();
  let rel = decodeURIComponent(req.path);
  if (rel === '/' || rel === '') rel = '/index.html';
  if (rel.includes('..')) return res.status(400).end();
  const file = path.join(PUBLIC_DIR, rel);
  fs.readFile(file, (err, buf) => {
    if (err) { if (rel === '/index.html') return res.status(404).end(); return next(); }
    res.setHeader('content-type', MIME[path.extname(file).toLowerCase()] || 'application/octet-stream');
    // The UI ships inside the controller exe and updates on every deploy — never
    // let the browser serve a stale app.js/style.css/index.html across updates.
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(buf);
  });
});

// ---------- first-run: extract bundled JMeter so report dashboards work ----------

function firstRunSetup() {
  try {
    fs.mkdirSync(cfg.runtimeDir, { recursive: true });
    const hasJmeter = fs.existsSync(cfg.runtimeDir) &&
      fs.readdirSync(cfg.runtimeDir).some((d) => d.toLowerCase().startsWith('apache-jmeter'));
    const zip = path.join(cfg.bundlesDir, 'jmeter.zip');
    if (!hasJmeter && fs.existsSync(zip)) {
      console.log('First run: extracting bundled JMeter for report generation...');
      const { spawn } = require('child_process');
      const p = spawn('powershell', ['-NoProfile', '-Command',
        `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${cfg.runtimeDir}' -Force`], { stdio: 'ignore' });
      p.on('exit', (c) => console.log(c === 0 ? 'JMeter runtime ready.' : 'JMeter extract failed (dashboards disabled).'));
    }
  } catch (e) { console.log('first-run setup skipped:', e.message); }
}

// ---------- start ----------

/** In the packaged app, keep the console open so errors are readable. */
function exitWithMessage(msg) {
  console.log('');
  console.log('ERROR: ' + msg);
  if (process.pkg) {
    console.log('');
    console.log('Press Enter to close this window...');
    try {
      process.stdin.resume();
      process.stdin.once('data', () => process.exit(1));
      return;
    } catch { /* no stdin (service context) */ }
  }
  process.exit(1);
}

server.on('error', (err) => {
  if (err.code !== 'EADDRINUSE') return exitWithMessage(`Failed to start: ${err.message}`);
  // Port busy — if it's another LoadPilot, behave single-instance: open its UI.
  const probe = http.get({ host: '127.0.0.1', port: PORT, path: '/api/settings', timeout: 2000 }, (res) => {
    res.resume();
    if (res.statusCode === 200) {
      console.log(`LoadPilot is already running on port ${PORT} - opening the existing UI.`);
      if (!process.env.LP_NO_OPEN) require('child_process').exec(`cmd /c start "" "http://localhost:${PORT}"`);
      setTimeout(() => process.exit(0), 1500);
    } else {
      exitWithMessage(`Port ${PORT} is used by another program. Change the port in the Settings panel (or config.json) and start LoadPilot again.`);
    }
  });
  probe.on('error', () => exitWithMessage(`Port ${PORT} is used by another program. Change the port in config.json next to the exe, then start LoadPilot again.`));
});

process.on('uncaughtException', (err) => exitWithMessage(`Unexpected error: ${err.message}`));

server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === 'IPv4' && !i.internal)
    .map((i) => i.address);
  console.log('==================================================');
  console.log(`  LoadPilot controller - running on port ${PORT}`);
  console.log(`  Open the UI:       http://localhost:${PORT}`);
  for (const ip of ips) console.log(`  Agents connect to: http://${ip}:${PORT}   (enter this on each agent PC)`);
  console.log('  Keep this window open. Close it to stop LoadPilot.');
  console.log('==================================================');
  firstRunSetup();
  // When run as the installed app, open the browser to the UI automatically.
  if (process.pkg && !process.env.LP_NO_OPEN) {
    require('child_process').exec(`cmd /c start "" "http://localhost:${PORT}"`);
  }
});

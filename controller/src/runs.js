'use strict';
/**
 * RunManager — creates runs, splits load across agents, tracks progress,
 * merges results and produces the final summary (plus the JMeter HTML
 * dashboard when a local JMeter install is available).
 *
 * One active run at a time: office PCs shouldn't fight over CPU between
 * two overlapping load tests — the results of both would be garbage.
 */

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { applyConfig, parseJmx, extractTargets } = require('./jmx');
const { RunStats, summarizeJtl, resolveTg, jtlRecords } = require('./stats');
const { writeJsonAtomic } = require('./fsutil');

// A disconnected agent may come back (network blip, controller hiccup) and carry on.
const RECONNECT_GRACE_MS = 30000;
// After Stop, an agent that says nothing for this long is given up on.
const STOP_SILENCE_MS = 3 * 60000;

const TARGETS_V = 2; // bump when extractTargets logic changes → old runs re-resolve

// Which bzm rate/concurrency groups a run enabled: 'arrivals' | 'concurrency' | 'mixed' | null.
function computeRateKind(structure, config) {
  const cfgTgs = config.mode === 'per-agent'
    ? Object.values(config.agentConfigs || {}).flatMap((ac) => ac.threadGroups || [])
    : (config.threadGroups || []);
  const enabled = new Set(cfgTgs.filter((t) => t.enabled).map((t) => t.id));
  const kinds = new Set();
  for (const t of (structure.threadGroups || [])) {
    if ((t.kind === 'arrivals' || t.kind === 'concurrency') && enabled.has(t.id)) kinds.add(t.kind);
  }
  return kinds.size === 0 ? null : kinds.size === 1 ? [...kinds][0] : 'mixed';
}

class RunManager {
  constructor({ dataDir, hub, broadcastUi, baseUrl, reports }) {
    this.runsDir = path.join(dataDir, 'runs');
    this.plansDir = path.join(dataDir, 'plans');
    fs.mkdirSync(this.runsDir, { recursive: true });
    this.hub = hub;
    this.broadcastUi = broadcastUi;
    this.baseUrl = baseUrl; // e.g. http://192.168.0.10:4000 — agents fetch files from here
    this.reports = reports; // ReportStore — runs can be recorded into a report
    this.active = null;     // in-memory state of the running test
    this._liveTimer = null;
    this._finalizing = null;   // the run being finished (guards against a second finish)
    this._lost = new Map();    // agent name -> timer: disconnected, waiting for it to come back
    this._seen = new Map();    // agent name -> last message time (for the Stop watchdog)
    this._stopWatchdog = null;
    this.onRunFinished = () => {}; // (publicRun, summary) — e.g. Google Sheets sync
    this._recoverInterrupted();
  }

  /**
   * A run that was still going when the controller stopped (crash, closed
   * window, PC restart) would show "running" forever and block nothing in
   * memory — close it out as interrupted, keeping whatever results arrived.
   */
  _recoverInterrupted() {
    let dirs = [];
    try { dirs = fs.readdirSync(this.runsDir); } catch { return; }
    for (const d of dirs) {
      const dir = path.join(this.runsDir, d);
      const meta = readJson(path.join(dir, 'meta.json'));
      if (!meta || !['preparing', 'running', 'finalizing'].includes(meta.state)) continue;
      meta.state = 'error';
      meta.endedAt = meta.endedAt || new Date().toISOString();
      for (const a of meta.agents || []) {
        if (a.state === 'preparing' || a.state === 'running') { a.state = 'error'; a.error = 'the controller stopped during the run'; }
      }
      try { fs.appendFileSync(path.join(dir, 'run.log'), `${new Date().toISOString()} controller was restarted during this run — closed as interrupted\n`); } catch { /* ignore */ }
      const run = { ...meta, dir };
      try { writeJsonAtomic(path.join(dir, 'meta.json'), this._publicRun(run)); } catch { /* read-only? */ }
      if (fs.existsSync(path.join(dir, 'summary.json'))) continue;
      // merge + summarise whatever results arrived, in the background
      this._mergeJtls(run)
        .then(() => (run.hasMerged ? summarizeJtl(path.join(dir, 'merged.jtl')) : null))
        .then((s) => {
          if (!s) return;
          writeJsonAtomic(path.join(dir, 'summary.json'), s);
          run.hasSummary = true;
          writeJsonAtomic(path.join(dir, 'meta.json'), this._publicRun(run));
        })
        .catch(() => { /* no usable results */ });
    }
  }

  // ---------- run creation ----------

  startRun(args) {
    this._startingDir = null;
    try {
      return this._startRun(args);
    } catch (e) {
      // a start that failed half-way (bad profile, missing data file…) must not
      // leave an empty run folder behind
      const dir = this._startingDir;
      if (dir && !(this.active && this.active.dir === dir)) {
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
      throw e;
    } finally {
      this._startingDir = null;
    }
  }

  _startRun({ plan, config, library }) {
    if (this.active) throw new Error(`Run ${this.active.id} is still active`);

    const agentNames = (config.agents || []).filter((n) => {
      const a = this.hub.agents.get(n);
      return a && a.state === 'idle';
    });
    if (!agentNames.length) throw new Error('No idle agents selected');

    const libFiles = (library && library.files) || [];
    const dataFileNames = libFiles.map((f) => f.logical);
    const structure = parseJmx(plan.xml);

    const id = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19) + '-' + Math.random().toString(36).slice(2, 6);
    const dir = path.join(this.runsDir, id);
    fs.mkdirSync(dir, { recursive: true });
    this._startingDir = dir;

    // Each agent ends up with: a plan file (shared or its own) + thread-count props.
    const perAgent = agentNames.map((name) => ({ name, planFile: 'plan.jmx', props: {} }));

    if (config.mode === 'per-agent') {
      // Per-agent profiles: each agent runs its OWN workload (samplers/controllers/
      // thread groups) at its OWN absolute thread counts — one rewritten plan each.
      agentNames.forEach((name, k) => {
        const ac = { ...((config.agentConfigs || {})[name] || {}), dataFileNames, variables: config.variables };
        if (!ac.threadGroups) throw new Error(`No per-agent profile configured for "${name}"`);
        const { xml, threadProps } = applyConfig(plan.xml, ac);
        const planFile = `plan-${safeName(name)}.jmx`;
        fs.writeFileSync(path.join(dir, planFile), xml);
        perAgent[k].planFile = planFile;
        for (const { tgId, prop } of threadProps) {
          const cfg = (ac.threadGroups || []).find((t) => t.id === tgId);
          const isRate = (structure.threadGroups[tgId] || {}).kind === 'arrivals' || (structure.threadGroups[tgId] || {}).kind === 'concurrency';
          // rate groups keep fractional values; standard groups are whole threads
          perAgent[k].props[prop] = isRate ? Math.max(0, +(cfg && cfg.threads) || 0) : Math.max(0, (cfg && cfg.threads) | 0);
        }
      });
    } else {
      // Even-split mode: one shared plan; each thread group's TOTAL threads are
      // divided across agents. EXCEPT setUp/tearDown (per-machine initializers)
      // which every agent runs at the full configured count.
      const shared = { ...config, dataFileNames };
      const { xml, threadProps } = applyConfig(plan.xml, shared);
      fs.writeFileSync(path.join(dir, 'plan.jmx'), xml);
      for (const { tgId, prop } of threadProps) {
        const cfg = (config.threadGroups || []).find((t) => t.id === tgId);
        const tgInfo = structure.threadGroups[tgId] || {};
        const tgTag = tgInfo.tag || '';
        if (tgTag === 'SetupThreadGroup' || tgTag === 'PostThreadGroup') {
          const total = Math.max(0, (cfg && cfg.threads) | 0);
          agentNames.forEach((_, k) => { perAgent[k].props[prop] = total; });
          continue;
        }
        if (tgInfo.kind === 'arrivals' || tgInfo.kind === 'concurrency') {
          // Rate/concurrency splits as a FRACTION so no agent gets 0 — a bzm
          // Arrivals group with target 0 has an infinite inter-arrival time and
          // never terminates, which would hang the whole run.
          const total = Math.max(0, +(cfg && cfg.threads) || 0);
          const per = agentNames.length ? +(total / agentNames.length).toFixed(4) : total;
          agentNames.forEach((_, k) => { perAgent[k].props[prop] = per; });
          continue;
        }
        const total = Math.max(0, (cfg && cfg.threads) | 0);
        const base = Math.floor(total / agentNames.length);
        const extra = total % agentNames.length;
        agentNames.forEach((_, k) => { perAgent[k].props[prop] = base + (k < extra ? 1 : 0); });
      }
    }

    const run = {
      id,
      dir,
      planId: plan.id,
      planName: plan.name,
      createdAt: new Date().toISOString(),
      state: 'running',
      config,
      // Target hosts this run load-tested — only the samplers enabled for this
      // run, resolved from the plan + overrides. Powers the web-address filter.
      targets: extractTargets(plan.xml, config),
      targetsV: TARGETS_V,
      // Which bzm rate/concurrency groups this run enabled — drives how the UI
      // labels the "Virtual users" chart (arrivals drive a rate, not users).
      rateKind: computeRateKind(structure, config),
      mode: config.mode === 'per-agent' ? 'per-agent' : 'split',
      heap: config.heap || '4g',
      dataFiles: dataFileNames,
      // Thread-group names — used to attribute samples (JMeter thread names
      // start with the group name) for the per-thread-group filters.
      tgNames: structure.threadGroups.map((t) => t.name),
      agents: agentNames.map((name, k) => ({
        name,
        state: 'preparing',
        props: perAgent[k].props,
        planFile: perAgent[k].planFile,
        exitCode: null,
        uploaded: false,
      })),
    };

    // Per-agent data file lists (may throw for missing per-agent uploads —
    // must happen before the run is registered as active).
    const agentFiles = this._buildDataFiles(library, agentNames, id, dir, new Set(plan.requiredNames || []));

    this.active = run;
    run.stats = new RunStats();
    run.tgStats = new Map();   // thread-group name -> RunStats (live filter)
    run.agentTimes = {};       // agent -> {first, last} sample ts (per-agent elapsed)
    run.agentLatency = {};     // agent -> {sum, count} response-time (spot slow/bad-network agents)
    this._saveMeta(run);

    // Longest scheduler duration among enabled groups — used by stub agents
    // (real JMeter reads timing from the plan itself). Covers both modes.
    const allTgConfigs = config.mode === 'per-agent'
      ? Object.values(config.agentConfigs || {}).flatMap((ac) => ac.threadGroups || [])
      : (config.threadGroups || []);
    const durationSec = Math.max(0, ...allTgConfigs
      .filter((t) => t.enabled && t.mode === 'duration')
      .map((t) => t.duration | 0));

    run.agents.forEach((a, k) => {
      const ok = this.hub.send(a.name, {
        type: 'job',
        runId: id,
        heap: run.heap,
        props: a.props,
        hint: { durationSec: durationSec || null },
        files: [
          // each agent downloads its own plan but saves it locally as plan.jmx
          { name: 'plan.jmx', url: `${this.baseUrl}/api/runs/${id}/files/${a.planFile}` },
          ...agentFiles[k],
        ],
        uploadUrl: `${this.baseUrl}/api/runs/${id}/results?agent=${encodeURIComponent(a.name)}`,
        errorsUploadUrl: `${this.baseUrl}/api/runs/${id}/errors?agent=${encodeURIComponent(a.name)}`,
      });
      if (!ok) { a.state = 'error'; a.error = 'dispatch failed'; }
    });

    // Live-stats push interval — user-selectable per run (1s..30s, default 2s).
    const liveMs = Math.min(30, Math.max(1, (config.liveInterval | 0) || 2)) * 1000;
    this._liveTimer = setInterval(() => this._broadcastLive(), liveMs);
    this._broadcastRun(run);
    // Every dispatch failed (agents vanished between the idle check and the send):
    // finish now rather than wait forever for agents that never got the job.
    if (!run.agents.some((a) => a.state === 'preparing' || a.state === 'running')) {
      setImmediate(() => this._maybeFinalize(run));
    }
    return this._publicRun(run);
  }

  /**
   * Resolve each LIBRARY data file into a per-agent download list.
   * Every entry is delivered to the agent under its LOGICAL name (the name the
   * JMX references), whatever file actually backs it:
   *   shared    -> the one uploaded file, for everyone
   *   split     -> controller cuts the rows into N chunk files in the run dir
   *   per-agent -> the file uploaded specifically for that agent
   * An incomplete entry only blocks the run when the plan actually READS that
   * file (required); otherwise it is skipped — the library serves many plans.
   * Returns files[agentIndex] = [{name, url}, ...].
   */
  _buildDataFiles(library, agentNames, runId, runDir, required = new Set()) {
    const entries = (library && library.files) || [];
    const libDir = library && library.dir;
    const out = agentNames.map(() => []);
    // a file the plan reads that was never uploaded at all must stop the run too
    for (const name of required) {
      if (!entries.some((e) => e.logical === name)) throw new Error(`The plan reads "${name}" but no file is uploaded for it`);
    }

    for (const entry of entries) {
      const must = required.has(entry.logical);
      if (entry.mode === 'per-agent') {
        const missing = agentNames.filter((name) => !(entry.perAgent || {})[name]);
        if (missing.length) {
          if (must) throw new Error(`No "${entry.logical}" uploaded for agent(s): ${missing.join(', ')} (per-agent file)`);
          continue;
        }
        agentNames.forEach((name, k) => {
          out[k].push({ logical: entry.logical, stored: entry.perAgent[name], lib: true });
        });
      } else if (entry.mode === 'split') {
        if (!entry.stored || !fs.existsSync(path.join(libDir, entry.stored))) {
          if (must) throw new Error(`No file uploaded for "${entry.logical}"`);
          continue;
        }
        const raw = fs.readFileSync(path.join(libDir, entry.stored), 'utf8');
        const lines = raw.split(/\r?\n/);
        while (lines.length && lines[lines.length - 1] === '') lines.pop();
        const header = entry.hasHeader !== false ? lines.shift() : null;
        const base = Math.floor(lines.length / agentNames.length);
        const extra = lines.length % agentNames.length;
        let off = 0;
        agentNames.forEach((_, k) => {
          const take = base + (k < extra ? 1 : 0);
          const chunkName = `split_${k}_${entry.logical}`.replace(/[^\w.-]/g, '_');
          const body = (header !== null ? header + '\n' : '') + lines.slice(off, off + take).join('\n') + '\n';
          off += take;
          fs.writeFileSync(path.join(runDir, chunkName), body);
          out[k].push({ logical: entry.logical, stored: chunkName, lib: false });
        });
      } else {
        if (!entry.stored || !fs.existsSync(path.join(libDir, entry.stored))) {
          if (must) throw new Error(`No file uploaded for "${entry.logical}"`);
          continue;
        }
        agentNames.forEach((_, k) => out[k].push({ logical: entry.logical, stored: entry.stored, lib: true }));
      }
    }

    return out.map((list) => list.map((f) => ({
      name: f.logical,
      url: f.lib
        ? `${this.baseUrl}/api/library/files/${encodeURIComponent(f.stored)}`
        : `${this.baseUrl}/api/runs/${runId}/files/${encodeURIComponent(f.stored)}`,
    })));
  }

  stopRun(runId) {
    const run = this.active;
    if (!run || run.id !== runId) throw new Error('Run is not active');
    for (const a of run.agents) {
      if (a.state === 'preparing' || a.state === 'running') this.hub.send(a.name, { type: 'stop', runId });
    }
    run.stoppedByUser = true;
    run.stopRequestedAt = Date.now();
    this._armStopWatchdog(run);
  }

  // After Stop, any agent that stays silent (crashed, half-dead connection) is
  // given up on after STOP_SILENCE_MS, so the run can never hang in "running".
  _armStopWatchdog(run) {
    clearInterval(this._stopWatchdog);
    this._stopWatchdog = setInterval(() => {
      if (this.active !== run) { clearInterval(this._stopWatchdog); return; }
      const now = Date.now();
      let changed = false;
      for (const a of run.agents) {
        if (a.state !== 'preparing' && a.state !== 'running') continue;
        const seen = Math.max(this._seen.get(a.name) || 0, run.stopRequestedAt || 0);
        if (now - seen > STOP_SILENCE_MS) {
          a.state = 'error';
          a.error = 'did not respond after Stop';
          this._appendLog(run, `[${a.name}] did not respond for ${STOP_SILENCE_MS / 60000} minutes after Stop — giving up on it`);
          changed = true;
        }
      }
      if (changed) this._maybeFinalize(run);
    }, 15000);
  }

  // ---------- agent event handlers (wired from server.js) ----------

  onAgentMessage(name, msg) {
    const run = this.active;
    // A dropped agent that came back idle isn't running this test any more (it
    // was restarted, or finished while offline): don't wait out the grace period.
    if (run && msg.type === 'status' && msg.state === 'idle' && this._lost.has(name)) {
      const a = run.agents.find((x) => x.name === name);
      clearTimeout(this._lost.get(name));
      this._lost.delete(name);
      if (a && (a.state === 'preparing' || a.state === 'running')) {
        a.state = 'error';
        a.error = 'agent dropped off and came back idle (restarted, or finished while offline)';
        this._appendLog(run, `[${name}] reconnected but is no longer running this test — results it uploaded are kept`);
        this._maybeFinalize(run);
      }
      return;
    }
    if (!run || msg.runId !== run.id) return;
    const a = run.agents.find((x) => x.name === name);
    if (!a) return;
    this._seen.set(name, Date.now());

    switch (msg.type) {
      case 'jobStatus': // preparing | running
        if (msg.state !== 'preparing' && msg.state !== 'running') break;
        if (a.state === 'preparing' || a.state === 'running') a.state = msg.state;
        // Stop pressed before this agent got going — say it again now it's listening
        if (run.stoppedByUser) this.hub.send(name, { type: 'stop', runId: run.id });
        this._broadcastRun(run);
        break;
      case 'status': // an agent that dropped off and came back, still busy with this run
        if (msg.state === 'running' && this._lost.has(name)) {
          clearTimeout(this._lost.get(name));
          this._lost.delete(name);
          this._appendLog(run, `[${name}] reconnected — still running its part of the test`);
          if (run.stoppedByUser) this.hub.send(name, { type: 'stop', runId: run.id });
          this._broadcastRun(run);
        }
        break;
      case 'samples': {
        run.stats.addRows(msg.rows || []);
        // A non-stub agent producing real samples clearly has JMeter installed
        // — flip the Agents-tab "will bootstrap" to "ready" (works for agents on
        // older builds that don't report readiness themselves).
        const ha = this.hub.agents.get(name);
        if (ha && !ha.info.stub && !ha.info.jmeterReady && (msg.rows || []).length) {
          ha.info.jmeterReady = true;
          this.hub.onChange();
        }
        let t = run.agentTimes[name];
        if (!t) run.agentTimes[name] = (t = { first: Infinity, last: 0 });
        let lt = run.agentLatency[name];
        if (!lt) run.agentLatency[name] = (lt = { sum: 0, count: 0 });
        for (const row of msg.rows || []) {
          if (row[0] < t.first) t.first = row[0];
          if (row[0] > t.last) t.last = row[0];
          lt.sum += row[1] || 0; lt.count++;
          const tg = resolveTg(row[5] || '', run.tgNames) || '(other)';
          let s = run.tgStats.get(tg);
          if (!s) run.tgStats.set(tg, (s = new RunStats()));
          s.addRows([row]);
        }
        break;
      }
      case 'runLog':
        this._appendLog(run, `[${name}] ${msg.line}`);
        break;
      case 'error':
        a.state = 'error';
        a.error = msg.message;
        this._appendLog(run, `[${name}] ERROR: ${msg.message}`);
        this._maybeFinalize(run);
        break;
      case 'done':
        a.exitCode = msg.exitCode;
        a.uploaded = !!msg.uploaded;
        if (run.stoppedByUser && !(msg.totalRows > 0)) {
          // Stop was pressed before this agent sent its first request — not a failure.
          a.state = 'done';
          a.note = 'stopped before any requests were sent';
        } else if (msg.exitCode !== 0 && !(msg.totalRows > 0)) {
          // JMeter died before producing a single sample — the plan didn't load.
          a.state = 'error';
          a.error = `JMeter exited with code ${msg.exitCode} before producing any samples — usually the plan failed to load (missing plugin jars in the JMeter bundle?). See the run log.`;
        } else {
          a.state = 'done';
        }
        this._appendLog(run, `[${name}] finished (exit ${msg.exitCode}, ${msg.totalRows ?? '?'} samples)`);
        this._maybeFinalize(run);
        break;
    }
  }

  onAgentLost(name, runId) {
    const run = this.active;
    if (!run || run.id !== runId) return;
    const a = run.agents.find((x) => x.name === name);
    if (!a || !(a.state === 'preparing' || a.state === 'running')) return;
    // Give it a moment: a network blip shouldn't fail the agent (its JMeter keeps
    // running) — only give up if it doesn't reconnect and report in.
    this._appendLog(run, `[${name}] lost connection — waiting ${RECONNECT_GRACE_MS / 1000}s for it to come back`);
    clearTimeout(this._lost.get(name));
    this._lost.set(name, setTimeout(() => {
      this._lost.delete(name);
      if (this.active !== run || !(a.state === 'preparing' || a.state === 'running')) return;
      a.state = 'error';
      a.error = 'agent disconnected';
      this._appendLog(run, `[${name}] agent disconnected mid-run`);
      this._maybeFinalize(run);
    }, RECONNECT_GRACE_MS));
  }

  // ---------- finalization ----------

  _maybeFinalize(run) {
    this._broadcastRun(run);
    if (this._finalizing === run) return; // a late done/error while it's already finishing
    const pending = run.agents.some((a) => a.state === 'preparing' || a.state === 'running');
    if (pending) return;
    this._finalizing = run;
    for (const t of this._lost.values()) clearTimeout(t);
    this._lost.clear();
    clearInterval(this._stopWatchdog);

    // Flush the last live snapshot BEFORE stopping the ticker — short runs can
    // start and finish entirely between two 2-second broadcasts, leaving the
    // Live page empty even though samples were collected.
    this._broadcastLive();
    run.state = 'finalizing';
    this._broadcastRun(run);
    clearInterval(this._liveTimer);

    (async () => {
      let summary = null;
      try {
        await this._mergeJtls(run);
        // Prefer the merged JTL (has byte counts -> full Summary/Aggregate
        // Report columns); fall back to live-streamed stats if no JTL arrived.
        summary = run.hasMerged
          ? await summarizeJtl(path.join(run.dir, 'merged.jtl'))
          : run.stats.finalSummary();
        summary.agents = run.agents.map(({ name, state, exitCode, error }) => ({ name, state, exitCode, error }));
        writeJsonAtomic(path.join(run.dir, 'summary.json'), summary);
        run.hasSummary = true;
      } catch (e) {
        try { this._appendLog(run, `finalize error: ${e.message}`); } catch { /* disk gone */ }
      }

      try {
        // persist each agent's own test duration into the run meta
        const elapsed = this._agentElapsed(run);
        for (const a of run.agents) if (elapsed[a.name] != null) a.durationSec = elapsed[a.name];

        const failed = run.agents.every((a) => a.state === 'error');
        run.state = run.stoppedByUser ? 'stopped' : failed ? 'error' : 'finished';
        run.endedAt = new Date().toISOString();
        this._recordToReport(run);
        this._broadcastRun(run);
      } catch (e) {
        try { this._appendLog(run, `finalize error: ${e.message}`); } catch { /* ignore */ }
      } finally {
        // ALWAYS release the run, or no other test could ever start
        this.active = null;
        this._finalizing = null;
      }

      // fire-and-forget external syncs (Google Sheets, …)
      if (summary && summary.overall && summary.overall.samples) {
        try { this.onRunFinished(this._publicRun(run), summary); } catch (e) { this._appendLog(run, `sync hook error: ${e.message}`); }
      }

      this._generateReport(run); // async, best-effort
    })();
  }

  /** If the run was marked "add to report", record each agent's own results. */
  _recordToReport(run) {
    const rep = run.config && run.config.report;
    if (!rep || !rep.enabled || !rep.reportId || !this.reports) return;
    if (run.state === 'error') return; // nothing meaningful to record
    try {
      // Each agent's metrics come from its own JTL (accurate per-machine numbers).
      const { summarizeJtl } = require('./stats');
      const build = async () => {
        const agents = [];
        for (const a of run.agents) {
          const f = path.join(run.dir, `results-${a.name.replace(/[^\w.-]/g, '_')}.jtl`);
          if (!fs.existsSync(f)) { agents.push({ name: a.name, errors: 0, errorPct: 0, throughput: 0, durationSec: 0, samples: 0 }); continue; }
          const s = await summarizeJtl(f);
          agents.push({
            name: a.name,
            errors: s.overall.errors,
            errorPct: s.overall.errorPct,
            throughput: s.overall.throughput,
            durationSec: s.durationSec,
            samples: s.overall.samples,
          });
        }
        this.reports.recordRun(rep.reportId, { config: rep, agents, nowIso: run.createdAt });
        this.broadcastUi({ type: 'reportUpdated', reportId: rep.reportId });
      };
      build().catch((e) => this._appendLog(run, `report record failed: ${e.message}`));
    } catch (e) {
      this._appendLog(run, `report record error: ${e.message}`);
    }
  }

  /**
   * Merge every agent's results into merged.jtl, in time order. Streams line by
   * line (each agent's file is already close to time order, so a k-way merge
   * by timestamp keeps the output ordered) — a big run's results can be far
   * larger than what fits in one string or in memory.
   */
  async _mergeJtls(run) {
    const files = fs.readdirSync(run.dir).filter((f) => /^results-.*\.jtl$/.test(f));
    if (!files.length) return;
    const ROW = /^\d{13},/;
    const sources = files.map((f) => {
      const file = path.join(run.dir, f);
      // Stop kills JMeter mid-write: a last line without its newline is torn
      // ("1784604426123,16,431 ") and would become a phantom failed sample — or,
      // cut inside the timestamp, wreck every duration and throughput. Drop it.
      let torn = false;
      try {
        const size = fs.statSync(file).size;
        if (size > 0) {
          const fd = fs.openSync(file, 'r');
          const b = Buffer.alloc(1);
          fs.readSync(fd, b, 0, 1, size - 1);
          fs.closeSync(fd);
          torn = b[0] !== 0x0a;
        }
      } catch { /* unreadable: the reader below fails the same way */ }
      // whole records: a failed sample's multi-line failure message stays one row
      const it = jtlRecords(file)[Symbol.asyncIterator]();
      return { it, torn, held: null, first: true, head: null, done: false };
    });

    let header = null;
    // Next sample row of one source (one line held back, so a torn last line is never emitted).
    const next = async (s) => {
      for (;;) {
        const r = await s.it.next();
        if (r.done) {
          const last = s.held;
          s.held = null;
          s.done = true;
          return last != null && !s.torn ? last : null;
        }
        const line = r.value;
        if (s.first) { s.first = false; if (!header) header = line; continue; }
        if (!ROW.test(line)) continue;
        const out = s.held;
        s.held = line;
        if (out != null) return out;
      }
    };
    for (const s of sources) s.head = await next(s);

    const target = path.join(run.dir, 'merged.jtl');
    const tmp = `${target}.part`;
    const out = fs.createWriteStream(tmp);
    const failed = new Promise((_, reject) => out.on('error', reject));
    failed.catch(() => {});
    const write = async (text) => {
      if (!out.write(text)) await Promise.race([new Promise((r) => out.once('drain', r)), failed]);
    };
    try {
      await write(`${header || ''}\n`);
      let batch = [];
      for (;;) {
        let pick = null;
        let ts = Infinity;
        for (const s of sources) {
          if (s.head == null) continue;
          const t = parseInt(s.head, 10); // JTL lines start with the timestamp
          if (t < ts) { ts = t; pick = s; }
        }
        if (!pick) break;
        batch.push(pick.head);
        pick.head = await next(pick);
        if (batch.length >= 2000) { await write(`${batch.join('\n')}\n`); batch = []; }
      }
      if (batch.length) await write(`${batch.join('\n')}\n`);
      await Promise.race([new Promise((r) => out.end(r)), failed]);
      fs.renameSync(tmp, target);
    } catch (e) {
      out.destroy();
      try { fs.rmSync(tmp, { force: true }); } catch { /* ignore */ }
      throw e;
    }
    run.hasMerged = true;
    this._saveMeta(run);
  }

  /** Generate the standard JMeter HTML dashboard if JMeter is installed locally. */
  _generateReport(run) {
    const jmeterBin = findJmeter();
    if (!jmeterBin || !run.hasMerged) return;
    const reportDir = path.join(run.dir, 'report');
    const p = spawn('cmd', ['/c', jmeterBin, '-g', 'merged.jtl', '-o', 'report', '-j', 'report-gen.log'], {
      cwd: run.dir,
      stdio: 'ignore',
    });
    p.on('exit', (code) => {
      if (code === 0 && fs.existsSync(path.join(reportDir, 'index.html'))) {
        run.hasReport = true;
        this._saveMeta(run);
        this._broadcastRun(run);
      }
    });
    p.on('error', () => {});
  }

  // ---------- queries ----------

  listRuns() {
    const planXmlCache = {};
    return fs.readdirSync(this.runsDir)
      .filter((d) => fs.existsSync(path.join(this.runsDir, d, 'meta.json')))
      .map((d) => {
        const metaPath = path.join(this.runsDir, d, 'meta.json');
        const meta = readJson(metaPath);
        const summary = readJson(path.join(this.runsDir, d, 'summary.json'));
        // Backfill/refresh target hosts (config-aware, versioned so a logic
        // change re-computes cached values from the stored plan).
        if (meta && meta.targetsV !== TARGETS_V) {
          meta.targets = this._backfillTargets(meta, planXmlCache);
          meta.targetsV = TARGETS_V;
          try { fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2)); } catch { /* read-only? skip */ }
        }
        const durationSec = summary && summary.durationSec
          ? summary.durationSec
          : meta && meta.endedAt ? Math.round((new Date(meta.endedAt) - new Date(meta.createdAt)) / 1000) : null;
        return { ...meta, overall: summary ? summary.overall : null, durationSec };
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  /** Resolve an old run's target hosts from its stored plan (cached per planId). */
  _backfillTargets(meta, cache) {
    const pid = meta && meta.planId;
    if (!pid) return [];
    try {
      if (cache[pid] === undefined) {
        cache[pid] = fs.readFileSync(path.join(this.plansDir, safeName(pid), 'original.jmx'), 'utf8');
      }
      return extractTargets(cache[pid], meta.config || {});
    } catch { return []; }
  }

  getRun(id) {
    if (this.active && this.active.id === id) {
      const byTg = {};
      for (const [name, s] of this.active.tgStats) byTg[name] = s.liveSnapshot(120);
      return {
        ...this._publicRun(this.active),
        live: { ...this.active.stats.liveSnapshot(), byTg, agentElapsed: this._agentElapsed(this.active), agentAvgMs: this._agentAvgMs(this.active) },
      };
    }
    const dir = path.join(this.runsDir, safeName(id));
    const metaPath = path.join(dir, 'meta.json');
    const meta = readJson(metaPath);
    if (!meta) return null;
    // Backfill rateKind for runs created before the bzm-labelling feature.
    if (meta.rateKind === undefined) {
      meta.rateKind = this._backfillRateKind(meta);
      try { fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2)); } catch { /* skip */ }
    }
    return { ...meta, summary: readJson(path.join(dir, 'summary.json')) };
  }

  /** Resolve an old run's bzm rate kind from its stored plan + config. */
  _backfillRateKind(meta) {
    if (!meta || !meta.planId) return null;
    try {
      const xml = fs.readFileSync(path.join(this.plansDir, safeName(meta.planId), 'original.jmx'), 'utf8');
      return computeRateKind(parseJmx(xml), meta.config || {});
    } catch { return null; }
  }

  runDir(id) {
    return path.join(this.runsDir, safeName(id));
  }

  // ---------- internals ----------

  _publicRun(run) {
    const { stats, tgStats, agentTimes, agentLatency, dir, ...pub } = run;
    return pub;
  }

  _agentElapsed(run) {
    const out = {};
    for (const [name, t] of Object.entries(run.agentTimes || {})) {
      if (t.last >= t.first) out[name] = Math.round((t.last - t.first) / 1000);
    }
    return out;
  }

  /** Per-agent average response time (ms) — the UI flags outliers as slow-network. */
  _agentAvgMs(run) {
    const out = {};
    for (const [name, lt] of Object.entries(run.agentLatency || {})) {
      if (lt.count) out[name] = Math.round(lt.sum / lt.count);
    }
    return out;
  }

  _saveMeta(run) {
    writeJsonAtomic(path.join(run.dir, 'meta.json'), this._publicRun(run));
  }

  _appendLog(run, line) {
    fs.appendFileSync(path.join(run.dir, 'run.log'), `${new Date().toISOString()} ${line}\n`);
    this.broadcastUi({ type: 'runLog', runId: run.id, line });
  }

  _broadcastRun(run) {
    this._saveMeta(run);
    this.broadcastUi({ type: 'runUpdate', run: this._publicRun(run) });
  }

  _broadcastLive() {
    const run = this.active;
    if (!run) return;
    const byTg = {};
    for (const [name, s] of run.tgStats) byTg[name] = s.liveSnapshot(120);
    this.broadcastUi({ type: 'liveStats', runId: run.id, ...run.stats.liveSnapshot(), byTg, agentElapsed: this._agentElapsed(run), agentAvgMs: this._agentAvgMs(run) });
  }
}

function findJmeter() {
  const candidates = [];
  if (process.env.JMETER_HOME) candidates.push(path.join(process.env.JMETER_HOME, 'bin', 'jmeter.bat'));
  const runtime = require('./config').load().runtimeDir;
  if (fs.existsSync(runtime)) {
    for (const d of fs.readdirSync(runtime)) {
      if (d.toLowerCase().startsWith('apache-jmeter')) candidates.push(path.join(runtime, d, 'bin', 'jmeter.bat'));
    }
  }
  return candidates.find((c) => fs.existsSync(c)) || null;
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Never a leading dot: ".." / "." would point at the parent / same folder.
function safeName(s) {
  return String(s).replace(/[^\w.-]/g, '_').replace(/^\.+/, (m) => '_'.repeat(m.length)) || '_';
}

module.exports = { RunManager, findJmeter };

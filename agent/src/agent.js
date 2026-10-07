#!/usr/bin/env node
'use strict';
/**
 * LoadPilot agent — runs on each worker PC, in the background.
 *
 * - Connects OUTBOUND to the controller (no inbound firewall rules needed)
 * - Announces hostname/cores/RAM, waits for jobs
 * - On job: downloads the prepared JMX (+ data files), runs JMeter headless,
 *   tails the JTL to stream live samples, uploads the full JTL when done
 * - Bootstraps its own JMeter (and JRE if java is missing) by downloading
 *   bundles from the controller — worker PCs need NOTHING preinstalled
 *
 * Usage:  node src/agent.js http://controller-host:4000  [--stub]
 * The URL is remembered in config.json next to the executable, so after the
 * first run it can start with no arguments (e.g. as a service).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { spawn, spawnSync } = require('child_process');
const WebSocket = require('ws');

const AGENT_VERSION = '0.1.0';

// When packaged as an exe (pkg), keep state next to the exe, not in the snapshot.
const BASE_DIR = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const CONFIG_FILE = path.join(BASE_DIR, 'config.json');
const RUNTIME_DIR = path.join(BASE_DIR, 'runtime');
const WORK_DIR = path.join(BASE_DIR, 'work');
const LOG_FILE = path.join(BASE_DIR, 'agent.log');
// The controller address on the command line (what the startup task was installed with).
const INSTALL_URL = (() => {
  const a = process.argv.find((x) => /^https?:\/\//.test(x));
  return a ? a.trim().replace(/\/+$/, '') : null;
})();

// Tee console output to agent.log so there's a record even when the agent runs
// windowless (no console) as a background app. Keeps the last ~1MB.
(function teeConsoleToFile() {
  let stream;
  try {
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 1024 * 1024) fs.unlinkSync(LOG_FILE);
    stream = fs.createWriteStream(LOG_FILE, { flags: 'a' });
  } catch { return; }
  const write = (args) => { try { stream.write(args.map(String).join(' ') + '\n'); } catch { /* ignore */ } };
  const origLog = console.log.bind(console);
  const origErr = console.error.bind(console);
  console.log = (...a) => { write(a); try { origLog(...a); } catch { /* no console */ } };
  console.error = (...a) => { write(a); try { origErr(...a); } catch { /* no console */ } };
})();

// ---------- config ----------

/** First-run setup when someone double-clicks the exe: ask for the controller URL. */
function promptForController() {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    const ask = () => rl.question('Enter controller URL (e.g. http://192.168.2.156:4000): ', (answer) => {
      const url = answer.trim();
      if (/^https?:\/\//.test(url)) { rl.close(); resolve(url.replace(/\/+$/, '')); }
      else { console.log('  That does not look like a URL — it must start with http://'); ask(); }
    });
    ask();
  });
}

async function loadConfig() {
  let cfg = {};
  try { cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* first run */ }
  if (INSTALL_URL) {
    // The startup task passes the install-time controller on every boot. If a
    // controller has since claimed this agent (redirect), keep following THAT
    // one; the install-time address wins again only when it changes (reinstall).
    const keepRedirect = cfg.redirect && cfg.redirect.from === INSTALL_URL && cfg.controller;
    if (!keepRedirect) { cfg.controller = INSTALL_URL; delete cfg.redirect; }
  }
  if (process.argv.includes('--stub')) cfg.stub = true;
  if (process.argv.includes('--no-stub')) cfg.stub = false;
  const nameArg = process.argv.indexOf('--name');
  if (nameArg !== -1 && process.argv[nameArg + 1]) cfg.name = process.argv[nameArg + 1];
  if (!cfg.controller) {
    if (process.pkg && !process.stdin.isTTY) {
      // Windowless exe double-clicked with no saved config: no console exists,
      // so show a real message box instead of dying silently.
      messageBox('No controller is configured for this agent.\n\nPlease install it with LoadPilot-Agent-Setup.exe (it asks for the controller address), or run from a terminal:\n\nloadpilot-agent.exe http://CONTROLLER-IP:4000');
      process.exit(1);
    }
    if (process.stdin.isTTY) {
      // double-clicked with no saved config — run a tiny interactive setup
      console.log('');
      console.log('=== LoadPilot agent — first-time setup ===');
      console.log('This PC will become a load generator. It needs the address of the');
      console.log('LoadPilot controller (the machine running the web UI).');
      console.log('');
      cfg.controller = await promptForController();
      console.log('Saved. The agent will remember this — next start needs no setup.');
      console.log('');
    } else {
      console.error('Usage: loadpilot-agent <http://controller:4000> [--name NAME] [--stub]');
      process.exit(1);
    }
  }
  cfg.name = cfg.name || os.hostname();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
  return cfg;
}

/** Native message box (via PowerShell) — the only visible channel for a windowless exe. */
function messageBox(text) {
  try {
    spawnSync('powershell', ['-NoProfile', '-Command',
      `[void][System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms');` +
      `[System.Windows.Forms.MessageBox]::Show('${String(text).replace(/'/g, "''").replace(/\n/g, "' + [Environment]::NewLine + '")}','LoadPilot Agent')`,
    ], { stdio: 'ignore', windowsHide: true });
  } catch { /* headless */ }
}

let config = null; // set in main() before anything else runs
const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---------- small http helpers (no deps) ----------

function httpMod(url) {
  return url.startsWith('https') ? https : http;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Download to `dest`. Rejects (and deletes the partial file) on a non-200, a
 * dropped connection, a short body or a stall — a half-downloaded plan, data
 * file or JMeter zip must never be used, and a dead link must not hang a run.
 */
function download(url, dest, idleMs = 60000) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const file = fs.createWriteStream(dest);
    const fail = (e) => {
      if (settled) return;
      settled = true;
      try { file.destroy(); } catch { /* ignore */ }
      fs.unlink(dest, () => {});
      reject(e);
    };
    const req = httpMod(url).get(url, (res) => {
      if (res.statusCode !== 200) { res.resume(); return fail(new Error(`GET ${url} -> ${res.statusCode}`)); }
      const expected = parseInt(res.headers['content-length'], 10);
      let got = 0;
      res.on('data', (d) => { got += d.length; });
      res.on('error', fail);
      res.on('close', () => { if (!res.complete) fail(new Error(`download of ${url} was cut off after ${got} bytes`)); });
      file.on('finish', () => file.close(() => {
        if (settled) return;
        if (Number.isFinite(expected) && got !== expected) return fail(new Error(`download of ${url} incomplete (${got} of ${expected} bytes)`));
        settled = true;
        resolve();
      }));
      res.pipe(file);
    });
    req.on('error', fail);
    req.setTimeout(idleMs, () => req.destroy(new Error(`download of ${url} stalled (no data for ${idleMs / 1000}s)`)));
    file.on('error', fail);
  });
}

function uploadFileOnce(url, filePath) {
  return new Promise((resolve, reject) => {
    const req = httpMod(url).request(url, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'content-length': fs.statSync(filePath).size },
    }, (res) => {
      res.resume();
      res.statusCode === 200 ? resolve() : reject(new Error(`upload -> ${res.statusCode}`));
    });
    req.on('error', reject);
    req.setTimeout(120000, () => req.destroy(new Error('upload stalled (no progress for 120s)')));
    fs.createReadStream(filePath).on('error', (e) => req.destroy(e)).pipe(req);
  });
}

/** Upload with retries — large result/error files must not be lost to a transient drop. */
async function uploadFile(url, filePath, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try { return await uploadFileOnce(url, filePath); }
    catch (e) {
      lastErr = e;
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
    }
  }
  throw lastErr;
}

/** Fetch small JSON from the controller (used for the bundle version check). Null on any error. */
function getJson(url, timeoutMs = 10000) {
  return new Promise((resolve) => {
    try {
      const req = httpMod(url).get(url, (res) => {
        if (res.statusCode !== 200) { res.resume(); return resolve(null); }
        let body = '';
        res.on('data', (d) => { body += d; });
        res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
        res.on('error', () => resolve(null));
      });
      req.on('error', () => resolve(null));
      req.setTimeout(timeoutMs, () => { req.destroy(); resolve(null); });
    } catch { resolve(null); }
  });
}

// ---------- jmeter / java discovery & bootstrap ----------

function findJmeterBat() {
  const candidates = [];
  if (config.jmeterHome) candidates.push(path.join(config.jmeterHome, 'bin', 'jmeter.bat'));
  if (process.env.JMETER_HOME) candidates.push(path.join(process.env.JMETER_HOME, 'bin', 'jmeter.bat'));
  if (fs.existsSync(RUNTIME_DIR)) {
    for (const d of fs.readdirSync(RUNTIME_DIR)) {
      if (d.toLowerCase().startsWith('apache-jmeter')) candidates.push(path.join(RUNTIME_DIR, d, 'bin', 'jmeter.bat'));
    }
  }
  return candidates.find((c) => fs.existsSync(c)) || null;
}

function findBundledJava() {
  if (!fs.existsSync(RUNTIME_DIR)) return null;
  for (const d of fs.readdirSync(RUNTIME_DIR)) {
    const java = path.join(RUNTIME_DIR, d, 'bin', 'java.exe');
    if (/^(jdk|jre)/i.test(d) && fs.existsSync(java)) return java;
  }
  return null;
}

function systemJavaWorks() {
  try { return spawnSync('java', ['-version'], { stdio: 'ignore', windowsHide: true }).status === 0; } catch { return false; }
}

/** Async so a long extraction never blocks the event loop (heartbeat pongs must keep flowing). */
function extractZip(zip, dest) {
  return new Promise((resolve, reject) => {
    const p = spawn('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${dest}' -Force`,
    ], { stdio: 'ignore', windowsHide: true });
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`failed to extract ${zip}`))));
    p.on('error', reject);
  });
}

/**
 * Download a bundle zip and unpack it into the runtime folder WITHOUT ever
 * leaving a half-extracted copy there: extract into a private temp folder,
 * then move the finished folder(s) in. (A cut-short extract straight into
 * runtime/ could leave jmeter.bat behind and be taken for a good install.)
 */
async function installBundle(name, report) {
  const tmpZip = path.join(RUNTIME_DIR, `.${name}-${process.pid}.zip`);
  const tmpDir = path.join(RUNTIME_DIR, `.extract-${name}-${process.pid}`);
  try {
    await download(`${config.controller}/bundle/${name}.zip`, tmpZip);
    report(`extracting ${name}...`);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    await extractZip(tmpZip, tmpDir);
    for (const d of fs.readdirSync(tmpDir)) {
      const to = path.join(RUNTIME_DIR, d);
      if (!fs.existsSync(to)) fs.renameSync(path.join(tmpDir, d), to);
    }
  } finally {
    fs.rmSync(tmpZip, { force: true });
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Several agents on one PC share runtime/. Only one may install or upgrade the
 * bundle at a time; the others wait, then re-check (it is usually done by then).
 */
async function withRuntimeLock(report, fn) {
  const lock = path.join(RUNTIME_DIR, '.bundle.lock');
  for (let i = 0; ; i++) {
    try { fs.writeFileSync(lock, String(process.pid), { flag: 'wx' }); break; } catch {
      try { if (Date.now() - fs.statSync(lock).mtimeMs > 15 * 60000) { fs.rmSync(lock, { force: true }); continue; } } catch { continue; }
      if (i === 0) report('another agent on this PC is installing JMeter — waiting for it...');
      await sleep(2000);
    }
  }
  try { return await fn(); } finally { fs.rmSync(lock, { force: true }); }
}

/** Make sure JMeter (and a usable java) exist; download bundles from the controller if not. */
async function ensureJmeter(report) {
  fs.mkdirSync(RUNTIME_DIR, { recursive: true });

  // Auto-upgrade: compare our extracted bundle fingerprint to the controller's.
  // If it changed (a newer JMeter was dropped on the controller), re-download.
  const marker = path.join(RUNTIME_DIR, '.jmeter-bundle-version');
  const readMarker = () => { try { return fs.readFileSync(marker, 'utf8').trim(); } catch { return null; } };
  const meta = await getJson(`${config.controller}/bundle/meta`);
  const wantVer = meta && meta.jmeter ? String(meta.jmeter) : null;
  const jarOk = () => { const b = findJmeterBat(); return !!b && fs.existsSync(path.join(path.dirname(b), 'ApacheJMeter.jar')); };

  await withRuntimeLock(report, async () => {
    const haveVer = readMarker();
    let needDownload = false, upgrading = false;
    if (!jarOk()) needDownload = true;
    else if (wantVer && haveVer && haveVer !== wantVer) { needDownload = true; upgrading = true; }
    else if (wantVer && !haveVer) { try { fs.writeFileSync(marker, wantVer); } catch { /* adopt existing as current */ } }
    if (!needDownload) return;
    report(upgrading ? `JMeter bundle changed on controller — upgrading (was ${haveVer}, now ${wantVer})` : 'downloading JMeter bundle from controller...');
    for (const d of fs.readdirSync(RUNTIME_DIR)) {
      if (d.toLowerCase().startsWith('apache-jmeter')) { try { fs.rmSync(path.join(RUNTIME_DIR, d), { recursive: true, force: true }); } catch { /* ignore */ } }
    }
    try { fs.rmSync(marker, { force: true }); } catch { /* ignore */ }
    await installBundle('jmeter', report);
    if (!jarOk()) throw new Error('the JMeter bundle from the controller did not contain a usable JMeter');
    if (wantVer) { try { fs.writeFileSync(marker, wantVer); } catch { /* ignore */ } }
  });

  const env = { ...process.env };
  let bundledJava = null;
  if (!systemJavaWorks()) {
    if (!findBundledJava()) {
      await withRuntimeLock(report, async () => {
        if (findBundledJava()) return; // another agent on this PC just installed it
        report('java not found — downloading JRE bundle from controller...');
        await installBundle('jre', report);
      });
    }
    bundledJava = findBundledJava();
    if (!bundledJava) throw new Error('no usable java (system java missing and no JRE bundle on controller)');
    env.JAVA_HOME = path.dirname(path.dirname(bundledJava));
    env.PATH = `${path.dirname(bundledJava)};${env.PATH}`;
  }

  const bat = findJmeterBat();
  if (!bat) throw new Error('JMeter not available (not installed and no bundle on controller at /bundle/jmeter.zip)');
  const home = path.dirname(path.dirname(bat));
  // Invoke java directly rather than jmeter.bat: the .bat's error path ends in
  // `pause`, which can wedge a headless agent forever. Use the java that was
  // actually checked: an inherited JAVA_HOME can point at an uninstalled Java.
  const javaExe = bundledJava || 'java';
  return { home, env, javaExe };
}

// ---------- JTL tailing ----------

/** Minimal CSV field splitter that honors double quotes. */
function splitCsv(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Poll a growing JTL file, emit parsed rows [ts, elapsed, label, success, code]. */
class JtlTailer {
  constructor(file, onRows) {
    this.file = file;
    this.onRows = onRows;
    this.offset = 0;
    this.partial = '';
    this.cols = null; // resolved from the header line
    this.rowCount = 0;
    this.timer = setInterval(() => this.poll(), 1000);
  }

  poll() {
    let stat;
    try { stat = fs.statSync(this.file); } catch { return; }
    if (stat.size <= this.offset) return;
    const fd = fs.openSync(this.file, 'r');
    const buf = Buffer.alloc(stat.size - this.offset);
    fs.readSync(fd, buf, 0, buf.length, this.offset);
    fs.closeSync(fd);
    this.offset = stat.size;

    const chunk = this.partial + buf.toString('utf8');
    const lines = chunk.split(/\r?\n/);
    this.partial = lines.pop(); // last piece may be incomplete

    const rows = [];
    for (const line of lines) {
      if (!line) continue;
      const f = splitCsv(line);
      if (!this.cols) {
        // header row: timeStamp,elapsed,label,responseCode,...,success,...
        this.cols = {
          ts: f.indexOf('timeStamp'),
          elapsed: f.indexOf('elapsed'),
          label: f.indexOf('label'),
          code: f.indexOf('responseCode'),
          success: f.indexOf('success'),
          thread: f.indexOf('threadName'),
        };
        if (this.cols.ts === -1) this.cols = { ts: 0, elapsed: 1, label: 2, code: 3, success: 7, thread: 5 };
        continue;
      }
      const ts = parseInt(f[this.cols.ts], 10);
      if (!Number.isFinite(ts)) continue;
      rows.push([ts, parseInt(f[this.cols.elapsed], 10) || 0, f[this.cols.label] || '?', f[this.cols.success] === 'true', f[this.cols.code] || '', f[this.cols.thread] || '']);
    }
    this.rowCount += rows.length;
    if (rows.length) this.onRows(rows);
  }

  stop() {
    clearInterval(this.timer);
    this.poll(); // final drain
  }
}

// ---------- stub load generator (dev/demo mode, no JMeter needed) ----------

function startStub(workDir, props, hint) {
  const file = path.join(workDir, 'results.jtl');
  fs.writeFileSync(file, 'timeStamp,elapsed,label,responseCode,responseMessage,threadName,dataType,success,failureMessage,bytes,sentBytes,grpThreads,allThreads,URL,Latency,IdleTime,Connect\n');
  const threads = Math.max(1, Object.values(props).reduce((s, v) => s + (v | 0), 0));
  const durationMs = Math.max(5, hint && hint.durationSec ? hint.durationSec : 30) * 1000;
  const labels = ['STUB Home page', 'STUB Login', 'STUB Search'];
  const started = Date.now();
  const timer = setInterval(() => {
    const lines = [];
    const perTick = Math.max(1, Math.round(threads * 0.8)); // ~0.8 req/s per "thread"
    for (let i = 0; i < perTick; i++) {
      const ok = Math.random() > 0.03;
      const elapsed = Math.round(80 + Math.random() * 400 + (ok ? 0 : 1500));
      const label = labels[Math.floor(Math.random() * labels.length)];
      lines.push(`${Date.now()},${elapsed},${label},${ok ? 200 : 500},${ok ? 'OK' : 'Internal Server Error'},tg1-${i},text,${ok},,1024,256,${threads},${threads},,${Math.round(elapsed * 0.7)},0,${Math.round(elapsed * 0.2)}`);
    }
    fs.appendFileSync(file, lines.join('\n') + '\n');
    if (Date.now() - started >= durationMs) proc.emit('exit', 0);
  }, 1000);
  // Duck-typed "process": same interface the job runner uses for real JMeter.
  const proc = new (require('events').EventEmitter)();
  proc.kill = () => { clearInterval(timer); proc.emit('exit', 143); };
  proc.once('exit', () => clearInterval(timer));
  return proc;
}

// ---------- job runner ----------

let ws = null;
let current = null; // {runId, proc, tailer} — set while JMeter itself runs
// The run this agent is busy with from the moment the job arrives until 'done'
// is sent: preparing (downloads, JMeter bootstrap), running, AND uploading.
// Everything that must not happen mid-run checks THIS, not `current`.
let busyRunId = null;
let cancelRequested = false; // Stop pressed before JMeter started
class StoppedBeforeStart extends Error {}

function send(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

// Whole-machine CPU% from os.cpus() idle/total deltas between samples, so the
// controller can tell if a load generator is saturated (results untrustworthy).
let lastCpuSample = os.cpus();
function cpuPercent() {
  const now = os.cpus();
  let idle = 0, total = 0;
  for (let i = 0; i < now.length && i < lastCpuSample.length; i++) {
    const a = lastCpuSample[i].times, b = now[i].times;
    const at = a.user + a.nice + a.sys + a.idle + a.irq;
    const bt = b.user + b.nice + b.sys + b.idle + b.irq;
    idle += b.idle - a.idle;
    total += bt - at;
  }
  lastCpuSample = now;
  return total > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - idle / total)))) : 0;
}
function resStats() {
  const total = os.totalmem(), used = total - os.freemem();
  return {
    type: 'resStats',
    cpu: cpuPercent(),
    mem: Math.round(100 * used / total),
    memUsedGB: +(used / 1e9).toFixed(1),
    memTotalGB: +(total / 1e9).toFixed(1),
  };
}
let resTimer = null;

// Each run leaves its plan, data files, results and captured responses in a
// work folder. The controller keeps the real copies, so only the most recent
// few stay here (a fallback if an upload failed) — otherwise the worker PC's
// disk fills up run after run.
const KEEP_WORK_RUNS = 5;
function pruneWorkDirs(agentDir, current) {
  let dirs;
  try { dirs = fs.readdirSync(agentDir, { withFileTypes: true }).filter((d) => d.isDirectory() && d.name !== current); } catch { return; }
  const byAge = dirs
    .map((d) => { try { return { name: d.name, t: fs.statSync(path.join(agentDir, d.name)).mtimeMs }; } catch { return null; } })
    .filter(Boolean)
    .sort((x, y) => y.t - x.t);
  for (const old of byAge.slice(KEEP_WORK_RUNS - 1)) { // -1: the current run counts as one
    try { fs.rmSync(path.join(agentDir, old.name), { recursive: true, force: true }); } catch { /* in use — next time */ }
  }
}

async function runJob(job) {
  const { runId, files, props = {}, heap = '4g', uploadUrl, errorsUploadUrl, hint } = job;
  // Name in the path so two agents on one PC (dev/testing) don't collide.
  const agentDir = path.join(WORK_DIR, config.name.replace(/[^\w.-]/g, '_'));
  const runDirName = runId.replace(/[^\w.-]/g, '_');
  const workDir = path.join(agentDir, runDirName);
  fs.mkdirSync(workDir, { recursive: true });
  pruneWorkDirs(agentDir, runDirName);
  const report = (line) => { log(`[${runId}]`, line); send({ type: 'runLog', runId, line }); };
  const checkCancel = () => { if (cancelRequested) throw new StoppedBeforeStart('stopped before JMeter started'); };
  busyRunId = runId;
  cancelRequested = false;

  try {
    send({ type: 'jobStatus', runId, state: 'preparing' });
    send({ type: 'status', state: 'running', runId });

    for (const f of files) {
      checkCancel();
      report(`downloading ${f.name}`);
      await download(`${config.controller}${f.url}`, path.join(workDir, f.name.replace(/[^\w.-]/g, '_')));
    }
    checkCancel();

    const resultsFile = path.join(workDir, 'results.jtl');
    if (fs.existsSync(resultsFile)) fs.unlinkSync(resultsFile);
    const errorsFile = path.join(workDir, 'errors.xml');
    if (fs.existsSync(errorsFile)) fs.unlinkSync(errorsFile);

    let proc;
    if (config.stub) {
      report('starting STUB load generator (no real JMeter)');
      proc = startStub(workDir, props, hint);
    } else {
      const { home, env, javaExe } = await ensureJmeter(report);
      checkCancel(); // Stop pressed while JMeter was downloading — never start the load
      const args = ['-Xms1g', `-Xmx${heap}`,
        '-jar', path.join(home, 'bin', 'ApacheJMeter.jar'),
        '-n', '-t', 'plan.jmx', '-l', 'results.jtl', '-j', 'jmeter.log'];
      for (const [k, v] of Object.entries(props)) args.push(`-J${k}=${v}`);
      report(`starting JMeter (heap ${heap}, props ${JSON.stringify(props)})`);
      // windowsHide: don't pop a console window for java.exe (the agent is
      // windowless, so a console child would otherwise flash its own window).
      proc = spawn(javaExe, args, { cwd: workDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      proc.stdout.on('data', (d) => d.toString().split('\n').forEach((l) => l.trim() && report(l.trim())));
      proc.stderr.on('data', (d) => d.toString().split('\n').forEach((l) => l.trim() && report(l.trim())));
    }

    current = { runId, proc, tailer: null };
    // JMeter is now installed (bootstrapped if needed) — tell the controller so
    // the Agents tab flips from "will bootstrap" to "ready".
    send({ type: 'status', state: 'running', runId, jmeterReady: !!findJmeterBat() });
    send({ type: 'jobStatus', runId, state: 'running' });

    current.tailer = new JtlTailer(resultsFile, (rows) => send({ type: 'samples', runId, rows }));

    // 'error' (e.g. java.exe missing) fires INSTEAD of 'exit' — without this the
    // agent would crash, or wait forever for an exit that never comes.
    const exitCode = await new Promise((resolve) => {
      proc.once('exit', resolve);
      proc.once('error', (e) => { report(`could not start JMeter: ${e.message}`); resolve(-1); });
    });
    current.tailer.stop();
    const totalRows = current.tailer.rowCount;
    current = null;

    let uploaded = false;
    if (fs.existsSync(resultsFile)) {
      report('uploading results.jtl to controller');
      try { await uploadFile(`${config.controller}${uploadUrl}`, resultsFile); uploaded = true; }
      catch (e) { report(`upload failed: ${e.message}`); }
    }
    // Error-response capture (bodies/headers of failed samples) — small file,
    // only exists if the run had failures.
    if (errorsUploadUrl && fs.existsSync(errorsFile) && fs.statSync(errorsFile).size > 0) {
      report('uploading errors.xml (captured error responses)');
      try { await uploadFile(`${config.controller}${errorsUploadUrl}`, errorsFile); }
      catch (e) { report(`errors upload failed: ${e.message}`); }
    }
    send({ type: 'done', runId, exitCode, uploaded, totalRows });
  } catch (e) {
    current = null;
    if (e instanceof StoppedBeforeStart) {
      // a clean stop, not a failure: no load was ever sent
      report('stopped before JMeter started — no load was sent');
      send({ type: 'done', runId, exitCode: 143, uploaded: false, totalRows: 0 });
    } else {
      report(`job failed: ${e.message}`);
      send({ type: 'error', runId, message: e.message });
    }
  } finally {
    busyRunId = null;
    cancelRequested = false;
    send({ type: 'status', state: 'idle', jmeterReady: !!findJmeterBat() });
  }
}

function stopJob(runId) {
  if (busyRunId !== runId) return;
  if (!current) {
    // still downloading / bootstrapping: make sure JMeter is never launched
    log(`stop requested for run ${runId} while preparing — will not start JMeter`);
    cancelRequested = true;
    return;
  }
  log(`stopping run ${runId}`);
  const { proc } = current;
  if (proc.pid) spawnSync('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
  else proc.kill(); // stub
}

// ---------- inbound control endpoint (lets a running controller "claim" this agent) ----------
// A tiny HTTP server on a fixed LAN port. A controller — knowing this PC's IP —
// POSTs its own URL here to point the agent at whichever controller is running
// now. That's what removes the single-controller dependency: no PC is permanent,
// whoever starts a controller can pull the agents over to themselves.
const CONTROL_PORT = 4101;

/** Point this agent at a new controller and reconnect. `persist` writes config.json
 *  (the control endpoint does; the config-watcher does not, to avoid a write loop). */
/** A controller address the agent can actually use, or throws. */
function cleanControllerUrl(url) {
  const clean = String(url || '').trim().replace(/\/+$/, '');
  let u;
  try { u = new URL(clean); } catch { throw new Error('bad url'); }
  if (!/^https?:$/.test(u.protocol) || !u.hostname || u.pathname.replace(/\/+$/, '') || u.search || u.hash) {
    throw new Error('bad url (expected http://HOST:PORT)');
  }
  return `${u.protocol}//${u.host}`;
}

function switchController(url, persist = true) {
  const clean = cleanControllerUrl(url);
  if (clean === config.controller) return; // already pointed here — nothing to do
  config.controller = clean;
  if (persist) {
    // Remember the install-time address this redirect replaced, so a reboot (the
    // task re-passes that address) keeps following the controller that claimed us.
    config.redirect = { from: INSTALL_URL || null, at: new Date().toISOString() };
    try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch { /* ignore */ }
  }
  log(`controller changed to ${clean} — reconnecting`);
  try { if (ws) ws.terminate(); } catch { /* the close handler reconnects to the new controller */ }
}

// When one agent on this PC is redirected it rewrites config.json; every OTHER
// agent instance on the same PC watches that file and follows, so a whole PC
// (all its agents) moves to the new controller together.
function watchConfigForController() {
  try {
    fs.watchFile(CONFIG_FILE, { interval: 1000 }, () => {
      try {
        const disk = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        if (disk.controller && disk.controller !== config.controller && !busyRunId) {
          log(`config.json controller changed to ${disk.controller} (by another instance on this PC) — following`);
          switchController(disk.controller, false);
        }
      } catch { /* mid-write / ignore */ }
    });
  } catch { /* watch unsupported — ignore */ }
}

// ---------- self-install (one exe, no separate .bat) ----------
// The install steps live INSIDE the exe. `--install` writes a tiny elevated
// script that (1) opens the control port in the firewall and (2) registers a
// startup task pointing back at this exe, then runs it. So a worker PC only ever
// needs this single file.

function isAdmin() {
  try { return spawnSync('net', ['session'], { stdio: 'ignore', windowsHide: true }).status === 0; } catch { return false; }
}
function installBatText(exe, url) {
  return [
    '@echo off',
    'netsh advfirewall firewall delete rule name="LoadPilot Agent Control" >nul 2>&1',
    'netsh advfirewall firewall add rule name="LoadPilot Agent Control" dir=in action=allow protocol=TCP localport=4101 >nul 2>&1',
    `schtasks /Create /F /TN "LoadPilotAgent" /TR "\\"${exe}\\" ${url} --no-stub" /SC ONSTART /RU SYSTEM /RL HIGHEST`,
    // Windows defaults would stop the agent after 3 days and skip it on battery; restart it after a crash
    'powershell -NoProfile -Command "Set-ScheduledTask -TaskName LoadPilotAgent -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1))" >nul 2>&1',
    'schtasks /Run /TN "LoadPilotAgent" >nul 2>&1',
    'exit /b 0',
  ].join('\r\n');
}
/** Run a generated .bat elevated (UAC prompt), wait for it, then delete it. */
function runElevatedBat(text, name) {
  const bat = path.join(os.tmpdir(), name);
  fs.writeFileSync(bat, text);
  spawnSync('powershell', ['-NoProfile', '-Command',
    `Start-Process -FilePath '${bat}' -Verb RunAs -WindowStyle Hidden -Wait`], { stdio: 'ignore', windowsHide: true });
  try { fs.unlinkSync(bat); } catch { /* ignore */ }
}
async function doInstall() {
  let url = process.argv.find((a) => /^https?:\/\//.test(a));
  if (!url) { try { url = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).controller; } catch { /* none */ } }
  if (!url) {
    if (process.stdin.isTTY) url = await promptForController();
    else { messageBox('To install, run:\n\nloadpilot-agent.exe --install http://CONTROLLER-IP:4000'); return; }
  }
  url = url.replace(/\/+$/, '');
  const exe = process.execPath;
  console.log('Installing LoadPilot agent (a Windows admin prompt will appear — click Yes)...');
  runElevatedBat(installBatText(exe, url), 'lp-agent-install.bat');
  const ok = spawnSync('schtasks', ['/Query', '/TN', 'LoadPilotAgent'], { stdio: 'ignore', windowsHide: true }).status === 0;
  if (ok) {
    console.log(`Installed. Controller: ${url}. The agent now runs in the background and starts with Windows.`);
    messageBox(`LoadPilot agent installed and started.\n\nController: ${url}\n\nIt runs in the background and starts automatically with Windows.\n\nThis PC should appear in the controller's Agents tab within a few seconds.`);
  } else {
    console.log('Install did not complete (admin prompt cancelled?).');
    messageBox('Install did not complete.\n\nIf a Windows administrator prompt appeared, please click Yes.\n\nTo retry: loadpilot-agent.exe --install');
  }
}
function doUninstall() {
  console.log('Uninstalling LoadPilot agent (admin prompt will appear)...');
  runElevatedBat([
    '@echo off',
    'schtasks /End /TN "LoadPilotAgent" >nul 2>&1',
    'schtasks /Delete /F /TN "LoadPilotAgent" >nul 2>&1',
    'netsh advfirewall firewall delete rule name="LoadPilot Agent Control" >nul 2>&1',
    'taskkill /IM loadpilot-agent.exe /F >nul 2>&1',
    'exit /b 0',
  ].join('\r\n'), 'lp-agent-uninstall.bat');
  messageBox('LoadPilot agent uninstalled (startup task and firewall rule removed).');
}
/** Ask a simple yes/no on the console (default yes). */
function askYesNo(question) {
  return new Promise((resolve) => {
    const rl = require('readline').createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`${question} [Y/n]: `, (a) => { rl.close(); resolve(!/^n/i.test(a.trim())); });
  });
}

/** Best-effort: open the control port in Windows Firewall (silent if not elevated). */
function ensureFirewallRule() {
  if (os.platform() !== 'win32') return;
  try {
    spawnSync('netsh', ['advfirewall', 'firewall', 'delete', 'rule', 'name=LoadPilot Agent Control'], { stdio: 'ignore', windowsHide: true });
    spawnSync('netsh', ['advfirewall', 'firewall', 'add', 'rule', 'name=LoadPilot Agent Control',
      'dir=in', 'action=allow', 'protocol=TCP', `localport=${CONTROL_PORT}`], { stdio: 'ignore', windowsHide: true });
  } catch { /* not elevated — user may get a one-time Windows firewall prompt instead */ }
}

function startControlServer() {
  const srv = http.createServer((req, res) => {
    // No CORS header: only the controller (a server, not a browser) talks to this port.
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const url = (req.url || '').split('?')[0];
    if (req.method === 'GET' && (url === '/lp-agent/ping' || url === '/')) {
      return send(200, { ok: true, app: 'loadpilot-agent', name: config.name, controller: config.controller, version: AGENT_VERSION, busy: !!busyRunId });
    }
    if (req.method === 'POST' && url === '/lp-agent/set-controller') {
      // Real JSON only: a web page can't send this cross-site without a CORS
      // preflight (which this server never answers), so a page open in someone's
      // browser can't silently re-point the agents.
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        req.resume();
        return send(415, { ok: false, error: 'content-type must be application/json' });
      }
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 10000) req.destroy(); });
      req.on('end', async () => {
        let target;
        try { target = cleanControllerUrl(JSON.parse(body).url); } catch (e) { return send(400, { ok: false, error: e.message === 'bad url' || /bad url/.test(e.message) ? e.message : 'bad json' }); }
        if (busyRunId) return send(409, { ok: false, busy: true, name: config.name, message: 'agent is running a test — redirect skipped' });
        // Only follow an address that answers like a LoadPilot controller — and
        // that THIS PC can reach; otherwise the agent would be stranded.
        const meta = await getJson(`${target}/bundle/meta`, 2500);
        if (!meta || typeof meta !== 'object') return send(400, { ok: false, error: `this PC can't reach a LoadPilot controller at ${target}` });
        if (busyRunId) return send(409, { ok: false, busy: true, name: config.name, message: 'agent is running a test — redirect skipped' });
        try { switchController(target); send(200, { ok: true, name: config.name, controller: config.controller }); }
        catch (e) { send(400, { ok: false, error: e.message }); }
      });
      return;
    }
    send(404, { ok: false, error: 'not found' });
  });
  // Another agent on the SAME PC already owns the port — fine, one endpoint per PC is enough.
  srv.on('error', (e) => log(`control endpoint not started (${e.code || e.message}) — port ${CONTROL_PORT} may be owned by another agent on this PC`));
  srv.listen(CONTROL_PORT, '0.0.0.0', () => log(`control endpoint on :${CONTROL_PORT} — a controller can redirect this agent here`));
}

// ---------- controller connection ----------

function connect() {
  const wsUrl = config.controller.replace(/^http/, 'ws') + '/ws/agent';
  try {
    ws = new WebSocket(wsUrl);
  } catch (e) {
    // a malformed address throws right here (not via 'error') — never crash, keep retrying
    log(`can't connect to "${config.controller}" (${e.message}) — retrying in 15s; fix the controller address`);
    ws = null;
    setTimeout(connect, 15000);
    return;
  }

  ws.on('open', () => {
    log(`connected to ${wsUrl} as "${config.name}"`);
    send({
      type: 'hello',
      name: config.name,
      platform: `${os.platform()} ${os.release()}`,
      cpus: os.cpus().length,
      memGB: Math.round(os.totalmem() / 1e9),
      agentVersion: AGENT_VERSION,
      jmeterReady: !!findJmeterBat(),
      stub: !!config.stub,
    });
    send(busyRunId
      ? { type: 'status', state: 'running', runId: busyRunId, jmeterReady: !!findJmeterBat() }
      : { type: 'status', state: 'idle', jmeterReady: !!findJmeterBat() });
    // stream CPU/RAM every 2s so the controller can flag a saturated agent
    lastCpuSample = os.cpus();
    clearInterval(resTimer);
    resTimer = setInterval(() => send(resStats()), 2000);
  });

  ws.on('message', (data) => {
    let msg;
    try { msg = JSON.parse(data); } catch { return; }
    if (msg.type === 'job') {
      if (busyRunId) return send({ type: 'error', runId: msg.runId, message: `agent is busy with run ${busyRunId}` });
      runJob(msg);
    } else if (msg.type === 'stop') {
      stopJob(msg.runId);
    } else if (msg.type === 'renamed') {
      log(`controller renamed this agent to "${msg.name}" (duplicate hostname)`);
      config.name = msg.name;
    } else if (msg.type === 'shutdown') {
      log('shutdown requested from controller - exiting.');
      if (busyRunId) stopJob(busyRunId);
      setTimeout(() => process.exit(0), 500);
    }
  });

  ws.on('close', () => {
    clearInterval(resTimer);
    log('disconnected from controller, retrying in 5s...');
    setTimeout(connect, 5000);
  });
  ws.on('error', (e) => log(`ws error: ${e.message}`));
}

/**
 * Per-NAME single-instance guard: hold a localhost port derived from the agent
 * name as a mutex. Double-clicking the same agent twice exits the second copy
 * (no more accidental OPL-2/-3/-4 duplicates), while intentionally running
 * MORE agents on one PC works — just give each a different --name.
 */
function ensureSingleInstance() {
  return new Promise((resolve) => {
    let h = 0;
    for (const ch of String(config.name)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    const port = 47100 + (h % 800);
    const net = require('net');
    const guard = net.createServer();
    guard.once('error', () => {
      log(`an agent named "${config.name}" is already running on this PC - duplicate launch ignored.`);
      if (process.pkg && !process.env.LP_SILENT_DUP && !process.argv.includes('--silent-dup')) {
        messageBox(`The LoadPilot agent "${config.name}" is already running on this PC.\n\nIt is working in the background - see the Agents tab in the controller.\n\n(To run MORE agents on this PC, use a different name: --name ${config.name}-B)`);
      }
      process.exit(0);
    });
    guard.listen(port, '127.0.0.1', () => { guard.unref(); resolve(); });
  });
}

(async () => {
  // One-file installer: `--install [url]` / `--uninstall`. These set up (or remove)
  // the startup task + firewall rule, then exit — they don't start the agent loop.
  if (process.argv.includes('--install')) { await doInstall(); process.exit(0); }
  if (process.argv.includes('--uninstall')) { doUninstall(); process.exit(0); }

  const hadConfig = fs.existsSync(CONFIG_FILE);
  config = await loadConfig();

  // First time someone double-clicks the exe: offer to install for automatic startup.
  if (!hadConfig && process.pkg && process.stdin.isTTY) {
    if (await askYesNo('Start LoadPilot automatically with Windows (recommended)?')) {
      await doInstall();
      process.exit(0);
    }
    console.log('OK — running in this window only. (You can install later with: loadpilot-agent.exe --install)');
  }

  await ensureSingleInstance();
  log(`LoadPilot agent v${AGENT_VERSION} - base dir ${BASE_DIR}${config.stub ? ' [STUB MODE]' : ''}`);
  fs.mkdirSync(WORK_DIR, { recursive: true });
  ensureFirewallRule();
  startControlServer();
  watchConfigForController();
  connect();
})();

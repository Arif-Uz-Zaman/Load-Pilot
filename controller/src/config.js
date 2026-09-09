'use strict';
/**
 * Controller configuration — storage paths and port, overridable via
 * controller/config.json (edited from the Settings panel in the UI).
 * Path changes take effect on the next controller start: relocating live
 * data directories under an active server isn't safe.
 */

const fs = require('fs');
const path = require('path');

// When packaged as an exe (pkg), data lives NEXT TO the exe (writable), not in
// the read-only snapshot. In dev it's the controller/ folder as before.
const ROOT = process.pkg ? path.dirname(process.execPath) : path.join(__dirname, '..');
const CONFIG_FILE = path.join(ROOT, 'config.json');

const DEFAULTS = {
  dataDir: path.join(ROOT, 'data'),       // plans / runs / library / reports live under this
  bundlesDir: path.join(ROOT, 'bundles'), // jmeter.zip (+ jre.zip) served to agents
  runtimeDir: path.join(ROOT, 'runtime'), // local JMeter used for HTML dashboards
  port: 4000,
};

function resolveDir(p) {
  return path.isAbsolute(p) ? p : path.join(ROOT, p);
}

function load() {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* defaults */ }
  const cfg = { ...DEFAULTS, ...saved };
  cfg.dataDir = resolveDir(cfg.dataDir);
  cfg.bundlesDir = resolveDir(cfg.bundlesDir);
  cfg.runtimeDir = resolveDir(cfg.runtimeDir);
  cfg.port = parseInt(process.env.LP_PORT || cfg.port, 10) || 4000;
  return cfg;
}

/** Validate + persist a settings patch. Returns the saved (raw) config. */
function save(patch) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { /* first save */ }

  for (const key of ['dataDir', 'bundlesDir', 'runtimeDir']) {
    if (patch[key] === undefined) continue;
    const dir = resolveDir(String(patch[key]).trim());
    fs.mkdirSync(dir, { recursive: true }); // throws -> 400 upstream if invalid/unwritable
    saved[key] = dir;
  }
  if (patch.port !== undefined) {
    const p = parseInt(patch.port, 10);
    if (!p || p < 1 || p > 65535) throw new Error('port must be 1-65535');
    saved.port = p;
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(saved, null, 2));
  return saved;
}

module.exports = { load, save, CONFIG_FILE, DEFAULTS, ROOT };

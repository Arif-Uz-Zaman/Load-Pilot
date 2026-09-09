'use strict';
/**
 * Load-test reporting, modeled on the team's Excel workbook.
 *
 * A report is a "Main Report" sheet plus one sheet per PERSON (each person maps
 * to an agent). Every scenario is a ROW shared across all sheets:
 *   - Main Report row: config (Date Time, Action, Thread, Ramp, Loop) + the
 *     values AGGREGATED across people (Excel did this with cross-sheet formulas)
 *   - Person row: that agent's own numbers (Error Count, Error Rate %,
 *     Throughput, Time, individual Thread = total samples)
 *
 * When a run is marked "add to report", each of its agents fills its assigned
 * person's row for that scenario, and the Main Report row is (re)computed.
 */

const fs = require('fs');
const path = require('path');
const { buildXlsx } = require('./xlsx');

// Columns the user enters on the Main Report (from the run config).
const CONFIG_COLS = ['action', 'iteration', 'thread', 'rampTime', 'loop', 'totalThread'];
// Per-person metric columns (filled from each agent's results).
const METRIC_COLS = ['errorCount', 'errorRatePct', 'throughput', 'time', 'samples'];

class ReportStore {
  constructor(dataDir) {
    this.dir = path.join(dataDir, 'reports');
    fs.mkdirSync(this.dir, { recursive: true });
  }

  _file(id) { return path.join(this.dir, `${String(id).replace(/[^\w.-]/g, '_')}.json`); }

  list() {
    return fs.readdirSync(this.dir).filter((f) => f.endsWith('.json')).map((f) => {
      const r = this._read(f.replace(/\.json$/, ''));
      return r && { id: r.id, name: r.name, rows: r.rows.length, people: r.people.length, updatedAt: r.updatedAt };
    }).filter(Boolean).sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : -1));
  }

  _read(id) {
    try { return JSON.parse(fs.readFileSync(this._file(id), 'utf8')); } catch { return null; }
  }

  get(id) {
    const r = this._read(id);
    return r ? this._withAggregates(r) : null;
  }

  _save(r) {
    r.updatedAt = new Date().toISOString();
    fs.writeFileSync(this._file(r.id), JSON.stringify(r, null, 2));
    return this._withAggregates(r);
  }

  create(name, nowIso) {
    const id = 'rep_' + Math.random().toString(36).slice(2, 9);
    return this._save({
      id,
      name: name || 'Load Test Report',
      createdAt: nowIso,
      people: [],          // [{ id, name, agent }]
      rows: [],            // [{ id, dateTime, action, iteration, thread, rampTime, loop, totalThread, cells: {personId: {metrics}}, infra: {} }]
      infraCols: [],       // [{ key, label }] user-defined extra columns
    });
  }

  ensureDefault(nowIso) {
    const list = this.list();
    if (list.length) return this._read(list[0].id);
    return this._read(this.create('Load Test Report', nowIso).id);
  }

  update(id, patch) {
    const r = this._read(id);
    if (!r) return null;
    if (typeof patch.name === 'string') r.name = patch.name;
    if (Array.isArray(patch.infraCols)) r.infraCols = patch.infraCols;
    return this._save(r);
  }

  remove(id) {
    try { fs.unlinkSync(this._file(id)); return true; } catch { return false; }
  }

  // ---- people (sheets) ----

  addPerson(id, name, agent, nowIso) {
    const r = this._read(id);
    if (!r) return null;
    const pid = 'p_' + Math.random().toString(36).slice(2, 8);
    r.people.push({ id: pid, name: name || `Person ${r.people.length + 1}`, agent: agent || '' });
    return this._save(r);
  }

  updatePerson(id, personId, patch) {
    const r = this._read(id);
    if (!r) return null;
    const p = r.people.find((x) => x.id === personId);
    if (!p) return null;
    if (typeof patch.name === 'string') p.name = patch.name;
    if (typeof patch.agent === 'string') p.agent = patch.agent;
    return this._save(r);
  }

  removePerson(id, personId) {
    const r = this._read(id);
    if (!r) return null;
    r.people = r.people.filter((p) => p.id !== personId);
    for (const row of r.rows) delete row.cells[personId];
    return this._save(r);
  }

  // ---- rows ----

  addRow(id, row, nowIso) {
    const r = this._read(id);
    if (!r) return null;
    r.rows.push(this._blankRow(row, nowIso));
    return this._save(r);
  }

  updateRow(id, rowId, patch) {
    const r = this._read(id);
    if (!r) return null;
    const row = r.rows.find((x) => x.id === rowId);
    if (!row) return null;
    for (const k of [...CONFIG_COLS, 'dateTime']) if (k in patch) row[k] = patch[k];
    if (patch.infra) row.infra = { ...row.infra, ...patch.infra };
    if (patch.cells) {
      for (const [pid, metrics] of Object.entries(patch.cells)) {
        row.cells[pid] = { ...(row.cells[pid] || {}), ...metrics };
      }
    }
    return this._save(r);
  }

  removeRow(id, rowId) {
    const r = this._read(id);
    if (!r) return null;
    r.rows = r.rows.filter((x) => x.id !== rowId);
    return this._save(r);
  }

  _blankRow(src = {}, nowIso) {
    const row = {
      id: 'row_' + Math.random().toString(36).slice(2, 8),
      dateTime: src.dateTime || nowIso || '',
      cells: {}, infra: {},
    };
    for (const k of CONFIG_COLS) row[k] = src[k] != null ? src[k] : '';
    return row;
  }

  /**
   * Record a finished run into the report: append a row and fill each agent's
   * assigned person cell. assignments = { agentName: personId }.
   */
  recordRun(id, { config, agents, nowIso }) {
    const r = this._read(id);
    if (!r) return null;
    const assignments = config.assignments || {};
    const row = this._blankRow({
      dateTime: nowIso,
      action: config.action || '',
      iteration: config.iteration || '',
      thread: config.thread || '',
      rampTime: config.rampTime || '',
      loop: config.loop || '',
      totalThread: config.totalThread || '',
    }, nowIso);
    for (const a of agents) {
      const pid = assignments[a.name];
      if (!pid || !r.people.some((p) => p.id === pid)) continue;
      row.cells[pid] = {
        errorCount: a.errors,
        errorRatePct: a.errorPct,
        throughput: a.throughput,
        time: a.durationSec,
        samples: a.samples,
      };
    }
    r.rows.push(row);
    return this._save(r);
  }

  // ---- aggregation (the Excel cross-sheet formulas, computed in JS) ----

  _withAggregates(r) {
    const rows = r.rows.map((row) => {
      const cells = row.cells || {};
      const present = r.people.filter((p) => cells[p.id] && Object.keys(cells[p.id]).length);
      const num = (pid, k) => Number((cells[pid] || {})[k]) || 0;
      const errorCount = present.reduce((s, p) => s + num(p.id, 'errorCount'), 0);
      const throughput = present.reduce((s, p) => s + num(p.id, 'throughput'), 0);
      const samplesSum = present.reduce((s, p) => s + num(p.id, 'samples'), 0);
      const times = present.map((p) => num(p.id, 'time'));
      const avgTime = times.length ? times.reduce((s, v) => s + v, 0) / times.length : 0;
      return {
        ...row,
        agg: {
          personCount: present.length,
          samplesSum,
          totalThread: row.totalThread || '',
          avgTime: +avgTime.toFixed(3),
          errorCount,
          errorRatePct: samplesSum ? +(100 * errorCount / samplesSum).toFixed(2) : 0,
          throughput: +throughput.toFixed(2),
        },
      };
    });
    return { ...r, rows };
  }

  // ---- export ----

  toWorkbook(id) {
    const r = this.get(id);
    if (!r) return null;

    const mainHeader = ['Date Time', 'Action', 'Iteration', 'Thread', 'Ramp Time', 'Loop',
      'Person Count', 'Sample Sum', 'Total Thread', 'Time (s)', 'Error Count', 'Error Rate %', 'Throughput',
      ...r.infraCols.map((c) => c.label)];
    const mainRows = [mainHeader.map((h) => ({ v: h, header: true }))];
    for (const row of r.rows) {
      mainRows.push([
        fmtDate(row.dateTime), row.action, row.iteration, num(row.thread), num(row.rampTime), num(row.loop),
        row.agg.personCount, row.agg.samplesSum, num(row.totalThread), timeCell(row.agg.avgTime),
        row.agg.errorCount, { v: pctFrac(row.agg.errorRatePct), numFmt: 'pct' }, row.agg.throughput,
        ...r.infraCols.map((c) => (row.infra || {})[c.key] || ''),
      ]);
    }

    const sheets = [{ name: 'Main Report', rows: mainRows }];
    const personHeader = ['Date Time', 'Action', 'Thread', 'Ramp Time', 'Loop', 'Error Count', 'Error Rate %', 'Throughput', 'Time', 'individual Thread'];
    for (const p of r.people) {
      const prows = [personHeader.map((h) => ({ v: h, header: true }))];
      for (const row of r.rows) {
        const c = (row.cells || {})[p.id] || {};
        const has = Object.keys(c).length;
        prows.push([
          fmtDate(row.dateTime), row.action, num(row.thread), num(row.rampTime), num(row.loop),
          has ? num(c.errorCount) : '', has ? { v: pctFrac(c.errorRatePct), numFmt: 'pct' } : '',
          has ? num(c.throughput) : '', has ? timeCell(c.time) : '', has ? num(c.samples) : '',
        ]);
      }
      sheets.push({ name: sheetName(p.name), rows: prows });
    }
    return { name: r.name, buffer: buildXlsx(sheets) };
  }

  toCsv(id) {
    const r = this.get(id);
    if (!r) return null;
    const header = ['Date Time', 'Action', 'Iteration', 'Thread', 'Ramp Time', 'Loop',
      'Person Count', 'Sample Sum', 'Total Thread', 'Time (s)', 'Error Count', 'Error Rate %', 'Throughput',
      ...r.infraCols.map((c) => c.label)];
    const lines = [header.map(csvCell).join(',')];
    for (const row of r.rows) {
      lines.push([
        fmtDate(row.dateTime), row.action, row.iteration, row.thread, row.rampTime, row.loop,
        row.agg.personCount, row.agg.samplesSum, row.totalThread, hms(row.agg.avgTime),
        row.agg.errorCount, row.agg.errorRatePct, row.agg.throughput,
        ...r.infraCols.map((c) => (row.infra || {})[c.key] || ''),
      ].map(csvCell).join(','));
    }
    return { name: r.name, csv: lines.join('\r\n') + '\r\n' };
  }
}

function num(v) { const n = Number(v); return isFinite(n) && v !== '' && v !== null ? n : (v || ''); }
function pctFrac(v) { return (Number(v) || 0) / 100; }
// Excel stores time as a fraction of a day; the hh:mm:ss format renders it.
function timeCell(sec) { const n = Number(sec) || 0; return { v: n / 86400, numFmt: 'time' }; }
function hms(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((v) => String(v).padStart(2, '0')).join(':');
}
// Report date format: 2026-07-01 10:10
function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (isNaN(d)) return iso;
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
function sheetName(s) { return String(s).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Person'; }
function csvCell(v) { const s = String(v == null ? '' : v); return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; }

module.exports = { ReportStore, CONFIG_COLS, METRIC_COLS };

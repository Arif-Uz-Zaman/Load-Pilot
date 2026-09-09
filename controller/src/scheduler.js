'use strict';
/**
 * Scheduled / recurring runs. Each schedule stores a full run config (the same
 * payload the New Run page posts) plus a recurrence. A once-a-minute tick
 * fires any schedule whose next occurrence has arrived — as long as no other
 * run is active and at least one of its agents is connected.
 *
 * Recurrence:
 *   { type: 'once',   date: 'YYYY-MM-DD', time: 'HH:MM' }
 *   { type: 'daily',  time: 'HH:MM' }
 *   { type: 'weekly', days: [0..6 (Sun..Sat)], time: 'HH:MM' }
 */

const fs = require('fs');
const path = require('path');

function nowId() {
  return 'sch_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

/** Next occurrence strictly after `from`, in the controller's local time. ISO string or null. */
function computeNextRun(recur, from = new Date()) {
  if (!recur || !recur.time) return null;
  const [hh, mm] = String(recur.time).split(':').map((n) => parseInt(n, 10));
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;

  if (recur.type === 'once') {
    if (!recur.date) return null;
    const d = new Date(`${recur.date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`);
    return isNaN(d) || d <= from ? null : d.toISOString();
  }
  const days = recur.type === 'weekly'
    ? (Array.isArray(recur.days) && recur.days.length ? recur.days : [from.getDay()])
    : [0, 1, 2, 3, 4, 5, 6]; // daily
  for (let i = 0; i <= 8; i++) {
    const d = new Date(from);
    d.setDate(from.getDate() + i);
    d.setHours(hh, mm, 0, 0);
    if (d > from && days.includes(d.getDay())) return d.toISOString();
  }
  return null;
}

class Scheduler {
  /** trigger(planId, config) -> run (throws on failure); connectedAgents() -> [names] */
  constructor({ dataDir, trigger, connectedAgents, isBusy, onChange }) {
    this.file = path.join(dataDir, 'schedules.json');
    this.trigger = trigger;
    this.connectedAgents = connectedAgents;
    this.isBusy = isBusy;
    this.onChange = onChange || (() => {});
    this.schedules = this._load();
    // refresh nextRun for anything stale, then start ticking
    for (const s of this.schedules) if (s.enabled && !s.nextRun) s.nextRun = computeNextRun(s.recur);
    this._save();
    this.timer = setInterval(() => this.tick(), 30000);
    if (this.timer.unref) this.timer.unref();
  }

  _load() {
    try { return JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { return []; }
  }
  _save() {
    try { fs.writeFileSync(this.file, JSON.stringify(this.schedules, null, 2)); } catch { /* ignore */ }
  }

  list() {
    return this.schedules.slice().sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  add({ name, planId, planName, config, recur }) {
    if (!planId || !config) throw new Error('planId and config are required');
    if (!recur || !recur.time) throw new Error('a time is required');
    const s = {
      id: nowId(),
      name: (name || 'Scheduled run').slice(0, 80),
      planId, planName: planName || '',
      config, recur,
      enabled: true,
      createdAt: new Date().toISOString(),
      lastRun: null,
      nextRun: computeNextRun(recur),
    };
    this.schedules.push(s);
    this._save();
    this.onChange();
    return s;
  }

  update(id, patch) {
    const s = this.schedules.find((x) => x.id === id);
    if (!s) throw new Error('schedule not found');
    if (patch.name != null) s.name = String(patch.name).slice(0, 80);
    if (patch.recur) s.recur = patch.recur;
    if (patch.enabled != null) s.enabled = !!patch.enabled;
    s.nextRun = s.enabled ? computeNextRun(s.recur) : null;
    this._save();
    this.onChange();
    return s;
  }

  remove(id) {
    const i = this.schedules.findIndex((x) => x.id === id);
    if (i === -1) throw new Error('schedule not found');
    this.schedules.splice(i, 1);
    this._save();
    this.onChange();
  }

  /** Fire a schedule now (manual or from the tick). Returns the started run. */
  runNow(id) {
    const s = this.schedules.find((x) => x.id === id);
    if (!s) throw new Error('schedule not found');
    return this._fire(s);
  }

  _fire(s) {
    const connected = new Set(this.connectedAgents());
    const wanted = (s.config.agents || []).filter((n) => connected.has(n));
    if (!wanted.length) throw new Error('none of this schedule’s agents are connected');
    const config = { ...s.config, agents: wanted };
    if (config.mode === 'per-agent' && config.agentConfigs) {
      config.agentConfigs = Object.fromEntries(
        Object.entries(config.agentConfigs).filter(([n]) => wanted.includes(n)));
    }
    const run = this.trigger(s.planId, config);
    s.lastRun = { at: new Date().toISOString(), runId: run.id, status: 'started' };
    this._save();
    this.onChange();
    return run;
  }

  tick() {
    const now = new Date();
    let changed = false;
    for (const s of this.schedules) {
      if (!s.enabled || !s.nextRun) continue;
      if (new Date(s.nextRun) > now) continue;
      // due now
      if (this.isBusy()) {
        s.lastRun = { at: now.toISOString(), status: 'skipped', detail: 'another run was in progress' };
        s.nextRun = computeNextRun(s.recur, now);
        if (s.recur.type === 'once') s.enabled = false;
        changed = true;
        continue;
      }
      try {
        this._fire(s);
      } catch (e) {
        s.lastRun = { at: now.toISOString(), status: 'error', detail: e.message };
      }
      s.nextRun = computeNextRun(s.recur, new Date(now.getTime() + 60000));
      if (s.recur.type === 'once') s.enabled = false;
      changed = true;
      break; // only one run can be active at a time
    }
    if (changed) { this._save(); this.onChange(); }
  }
}

module.exports = { Scheduler, computeNextRun };

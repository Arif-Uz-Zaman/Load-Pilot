'use strict';
/**
 * Live + final statistics for a run.
 * Agents stream sample rows as compact arrays: [tsMs, elapsedMs, label, success, code].
 * We keep per-label aggregates (with raw elapsed values for percentiles) and
 * per-second buckets for the live TPS/latency/error timeline.
 *
 * After the run, the merged JTL is re-summarized with summarizeJtl() — it has
 * the byte counts the live stream doesn't carry, producing the full JMeter
 * Summary/Aggregate Report columns (median, std dev, KB/s, avg bytes).
 */

const fs = require('fs');
const { createInterface } = require('readline');

const MAX_ELAPSED_SAMPLES = 2_000_000; // per label; beyond this, percentiles are approximate

function newAgg() {
  return { count: 0, errors: 0, sum: 0, min: Infinity, max: 0, elapsed: [] };
}

function addTo(agg, elapsed, ok) {
  agg.count++;
  if (!ok) agg.errors++;
  agg.sum += elapsed;
  if (elapsed < agg.min) agg.min = elapsed;
  if (elapsed > agg.max) agg.max = elapsed;
  if (agg.elapsed.length < MAX_ELAPSED_SAMPLES) agg.elapsed.push(elapsed);
}

function percentile(sorted, q) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1);
  return sorted[Math.max(0, idx)];
}

function summarize(label, agg, durationSec) {
  const sorted = agg.elapsed.slice().sort((a, b) => a - b);
  return {
    label,
    samples: agg.count,
    errors: agg.errors,
    errorPct: agg.count ? +(100 * agg.errors / agg.count).toFixed(2) : 0,
    avg: agg.count ? Math.round(agg.sum / agg.count) : 0,
    min: agg.count ? agg.min : 0,
    max: agg.max,
    p90: percentile(sorted, 0.90),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    throughput: durationSec > 0 ? +(agg.count / durationSec).toFixed(2) : 0,
  };
}

class RunStats {
  constructor() {
    this.labels = new Map();
    this.total = newAgg();
    this.buckets = new Map();       // epoch-second -> {count, errors, sum}
    this.labelBuckets = new Map();  // label -> Map(epoch-second -> {count, errors, sum}) — for live per-sampler charts
    this.firstTs = null;
    this.lastTs = null;
  }

  addRows(rows) {
    for (const [ts, elapsed, label, success] of rows) {
      const ok = success === true || success === 'true';
      addTo(this.total, elapsed, ok);
      let agg = this.labels.get(label);
      if (!agg) this.labels.set(label, (agg = newAgg()));
      addTo(agg, elapsed, ok);

      const sec = Math.floor(ts / 1000);
      let b = this.buckets.get(sec);
      if (!b) this.buckets.set(sec, (b = { count: 0, errors: 0, sum: 0 }));
      b.count++;
      if (!ok) b.errors++;
      b.sum += elapsed;

      let lb = this.labelBuckets.get(label);
      if (!lb) this.labelBuckets.set(label, (lb = new Map()));
      let lbb = lb.get(sec);
      if (!lbb) lb.set(sec, (lbb = { count: 0, errors: 0, sum: 0 }));
      lbb.count++;
      if (!ok) lbb.errors++;
      lbb.sum += elapsed;

      if (this.firstTs === null || ts < this.firstTs) this.firstTs = ts;
      if (this.lastTs === null || ts > this.lastTs) this.lastTs = ts;
    }
  }

  get durationSec() {
    if (this.firstTs === null) return 0;
    return Math.max(1, (this.lastTs - this.firstTs) / 1000);
  }

  /** Rolling last-10s window + timeline for the live chart. */
  liveSnapshot(timelineSeconds = 180) {
    const secs = [...this.buckets.keys()].sort((a, b) => a - b);
    const lastSec = secs.length ? secs[secs.length - 1] : 0;

    let wCount = 0, wErrors = 0, wSum = 0, wSecs = 0;
    for (let s = lastSec - 9; s <= lastSec; s++) {
      const b = this.buckets.get(s);
      if (!b) continue;
      wSecs++;
      wCount += b.count;
      wErrors += b.errors;
      wSum += b.sum;
    }

    const timeline = [];
    for (const s of secs.slice(-timelineSeconds)) {
      const b = this.buckets.get(s);
      timeline.push({
        t: s,
        tps: b.count,
        errors: b.errors,
        avg: b.count ? Math.round(b.sum / b.count) : 0,
      });
    }

    const perLabel = [...this.labels.entries()].map(([label, agg]) => ({
      label,
      samples: agg.count,
      errors: agg.errors,
      avg: agg.count ? Math.round(agg.sum / agg.count) : 0,
      max: agg.max,
    }));

    return {
      totalSamples: this.total.count,
      totalErrors: this.total.errors,
      startedTs: this.firstTs,
      elapsedSec: this.firstTs === null ? 0 : Math.round((this.lastTs - this.firstTs) / 1000),
      window: {
        tps: wSecs ? +(wCount / wSecs).toFixed(1) : 0,
        avg: wCount ? Math.round(wSum / wCount) : 0,
        errPct: wCount ? +(100 * wErrors / wCount).toFixed(2) : 0,
      },
      timeline,
      perLabel,
      byLabel: this._byLabelWindow(secs.slice(-timelineSeconds)),
    };
  }

  /** Per-sampler live timeline over the given seconds: busiest TOP labels + "Other". */
  _byLabelWindow(winSecs, top = 8) {
    const ranked = [...this.labels.entries()].sort((a, b) => b[1].count - a[1].count).map(([l]) => l);
    const keep = new Set(ranked.slice(0, top));
    const labels = ranked.slice(0, top).concat(ranked.length > top ? ['Other'] : []);
    const series = {};
    for (const l of labels) series[l] = { tps: [], errors: [], avg: [] };
    for (const sec of winSecs) {
      const acc = {};
      for (const l of labels) acc[l] = { c: 0, e: 0, s: 0 };
      for (const [label, lb] of this.labelBuckets) {
        const bb = lb.get(sec);
        if (!bb) continue;
        const key = keep.has(label) ? label : 'Other';
        if (!acc[key]) continue;
        acc[key].c += bb.count; acc[key].e += bb.errors; acc[key].s += bb.sum;
      }
      for (const l of labels) {
        const a = acc[l];
        series[l].tps.push(a.c);
        series[l].errors.push(a.e);
        series[l].avg.push(a.c ? Math.round(a.s / a.c) : 0);
      }
    }
    return { t: winSecs, labels, series };
  }

  finalSummary() {
    const durationSec = this.durationSec;
    const rows = [...this.labels.entries()]
      .map(([label, agg]) => summarize(label, agg, durationSec))
      .sort((a, b) => a.label.localeCompare(b.label));
    return {
      startedTs: this.firstTs,
      endedTs: this.lastTs,
      durationSec: Math.round(durationSec),
      overall: summarize('TOTAL', this.total, durationSec),
      perLabel: rows,
    };
  }
}

// ---------- thread-group attribution ----------

/**
 * JMeter thread names embed the owning thread group: "Browsing Users 1-3",
 * "bzm - Arrivals Thread Group-ThreadStarter 2-1". Longest matching group-name
 * prefix wins (guards against one group name being a prefix of another).
 */
function resolveTg(threadName, tgNames) {
  let best = null;
  for (const name of tgNames || []) {
    if (name && threadName.startsWith(name) && (!best || name.length > best.length)) best = name;
  }
  return best;
}

/** Row filter used by all JTL readers: keep only rows of one thread group. */
function tgMatches(threadName, opts) {
  if (!opts || !opts.tg) return true;
  return resolveTg(threadName || '', opts.tgNames) === opts.tg;
}

/**
 * Redirect/child sub-samples (e.g. "431 Login-0", "431 Login-1") are pieces of
 * their parent sample and their time is already inside the parent — JMeter's
 * Summary/Aggregate Report counts only the parent. Detect them so LoadPilot's
 * reports match JMeter: a label is a sub-sample only if it looks like
 * "<base>-<number>" AND a sampler named exactly "<base>" also exists (so a real
 * sampler deliberately named "Step-2" is NOT hidden unless "Step" also exists).
 */
async function collectSubSampleLabels(file) {
  const labels = new Set();
  let cols = null;
  const rl = createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const f = splitCsv(line);
    if (!cols) { cols = jtlCols(f); continue; }
    if (!Number.isFinite(parseInt(f[cols.ts], 10))) continue;
    labels.add(f[cols.label] || '');
  }
  const subs = new Set();
  for (const lbl of labels) {
    const m = /^(.*)-\d+$/.exec(lbl);
    if (m && labels.has(m[1])) subs.add(lbl);
  }
  return subs;
}

// ---------- post-run: full JMeter-style report from the merged JTL ----------

/** CSV field splitter honoring double quotes (JTL responseMessage can contain commas). */
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

function jtlCols(headerFields) {
  const idx = (n) => headerFields.indexOf(n);
  return {
    ts: idx('timeStamp'), elapsed: idx('elapsed'), label: idx('label'),
    code: idx('responseCode'), msg: idx('responseMessage'), thread: idx('threadName'),
    success: idx('success'), failure: idx('failureMessage'),
    bytes: idx('bytes'), sentBytes: idx('sentBytes'),
    latency: idx('Latency'), connect: idx('Connect'), url: idx('URL'),
    allThreads: idx('allThreads'), grpThreads: idx('grpThreads'),
  };
}

function newRichAgg() {
  return { count: 0, errors: 0, sum: 0, sumSq: 0, min: Infinity, max: 0, bytes: 0, sentBytes: 0, elapsed: [] };
}

function richRow(label, a, durationSec) {
  const sorted = a.elapsed.slice().sort((x, y) => x - y);
  const mean = a.count ? a.sum / a.count : 0;
  const variance = a.count ? Math.max(0, a.sumSq / a.count - mean * mean) : 0;
  return {
    label,
    samples: a.count,
    errors: a.errors,
    errorPct: a.count ? +(100 * a.errors / a.count).toFixed(2) : 0,
    avg: Math.round(mean),
    median: percentile(sorted, 0.5),
    p90: percentile(sorted, 0.90),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    min: a.count ? a.min : 0,
    max: a.max,
    stdDev: Math.round(Math.sqrt(variance)),
    throughput: durationSec > 0 ? +(a.count / durationSec).toFixed(2) : 0,
    recvKBs: durationSec > 0 ? +(a.bytes / 1024 / durationSec).toFixed(2) : 0,
    sentKBs: durationSec > 0 ? +(a.sentBytes / 1024 / durationSec).toFixed(2) : 0,
    avgBytes: a.count ? Math.round(a.bytes / a.count) : 0,
  };
}

/** Stream the merged JTL and produce the full Summary/Aggregate Report stats. */
async function summarizeJtl(file, opts = {}) {
  const labels = new Map();
  const total = newRichAgg();
  let cols = null, firstTs = null, lastTs = null;
  // Match JMeter: exclude redirect sub-samples from the summary (opt out with
  // opts.includeSubSamples).
  const subs = opts.includeSubSamples ? new Set() : await collectSubSampleLabels(file);

  const rl = createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const f = splitCsv(line);
    if (!cols) { cols = jtlCols(f); continue; }
    const ts = parseInt(f[cols.ts], 10);
    if (!Number.isFinite(ts)) continue;
    if (subs.has(f[cols.label])) continue;
    if (!tgMatches(f[cols.thread], opts)) continue;
    const elapsed = parseInt(f[cols.elapsed], 10) || 0;
    const ok = f[cols.success] === 'true';
    const bytes = parseInt(f[cols.bytes], 10) || 0;
    const sent = parseInt(f[cols.sentBytes], 10) || 0;
    const label = f[cols.label] || '?';

    for (const a of [total, labels.get(label) || labels.set(label, newRichAgg()).get(label)]) {
      a.count++;
      if (!ok) a.errors++;
      a.sum += elapsed;
      a.sumSq += elapsed * elapsed;
      if (elapsed < a.min) a.min = elapsed;
      if (elapsed > a.max) a.max = elapsed;
      a.bytes += bytes;
      a.sentBytes += sent;
      if (a.elapsed.length < MAX_ELAPSED_SAMPLES) a.elapsed.push(elapsed);
    }
    if (firstTs === null || ts < firstTs) firstTs = ts;
    if (ts > lastTs) lastTs = ts;
  }

  const durationSec = firstTs === null ? 0 : Math.max(1, (lastTs - firstTs) / 1000);
  return {
    startedTs: firstTs,
    endedTs: lastTs,
    durationSec: Math.round(durationSec),
    overall: richRow('TOTAL', total, durationSec),
    perLabel: [...labels.entries()]
      .map(([label, a]) => richRow(label, a, durationSec))
      .sort((a, b) => a.label.localeCompare(b.label)),
  };
}

/**
 * Per-second throughput/latency/error timeline from a JTL, for the post-run
 * charts. Long runs are re-bucketed to at most maxPoints intervals.
 */
async function timelineFromJtl(file, opts = {}) {
  const maxPoints = opts.maxPoints || 240;
  const buckets = new Map();
  let cols = null;
  const subs = opts.includeSubSamples ? new Set() : await collectSubSampleLabels(file);
  const rl = createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const f = splitCsv(line);
    if (!cols) { cols = jtlCols(f); continue; }
    const ts = parseInt(f[cols.ts], 10);
    if (!Number.isFinite(ts)) continue;
    if (subs.has(f[cols.label])) continue;
    if (!tgMatches(f[cols.thread], opts)) continue;
    const sec = Math.floor(ts / 1000);
    let b = buckets.get(sec);
    if (!b) buckets.set(sec, (b = { count: 0, errors: 0, sum: 0 }));
    b.count++;
    if (f[cols.success] !== 'true') b.errors++;
    b.sum += parseInt(f[cols.elapsed], 10) || 0;
  }
  const secs = [...buckets.keys()].sort((a, b) => a - b);
  if (!secs.length) return [];
  const span = secs[secs.length - 1] - secs[0] + 1;
  const step = Math.max(1, Math.ceil(span / maxPoints));
  const points = [];
  for (let s = secs[0]; s <= secs[secs.length - 1]; s += step) {
    let count = 0, errors = 0, sum = 0;
    for (let k = s; k < s + step; k++) {
      const b = buckets.get(k);
      if (b) { count += b.count; errors += b.errors; sum += b.sum; }
    }
    points.push({
      t: s,
      tps: +(count / step).toFixed(2),
      errors: +(errors / step).toFixed(2),
      avg: count ? Math.round(sum / count) : 0,
    });
  }
  return points;
}

/**
 * Per-SAMPLER timeline for the dashboard's Azure-style charts: for each time
 * bucket, requests/sec, error count and avg response time broken down by
 * sample label, plus the peak active thread count (Virtual Users). Labels are
 * ranked by volume; only the busiest TOP are kept as their own series, the
 * rest collapse into "Other" so the legend stays readable.
 */
async function timelineByLabel(file, opts = {}) {
  const maxPoints = opts.maxPoints || 240;
  const TOP = opts.topLabels || 8;
  const buckets = new Map();       // sec -> { threads, byLabel: Map(label -> {c,e,s}) }
  const labelTotals = new Map();   // label -> total count (for ranking)
  let cols = null, threadCol = -1;
  const subs = opts.includeSubSamples ? new Set() : await collectSubSampleLabels(file);
  const rl = createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const f = splitCsv(line);
    if (!cols) { cols = jtlCols(f); threadCol = cols.allThreads >= 0 ? cols.allThreads : cols.grpThreads; continue; }
    const ts = parseInt(f[cols.ts], 10);
    if (!Number.isFinite(ts)) continue;
    const label = f[cols.label] || '';
    if (subs.has(label)) continue;
    if (!tgMatches(f[cols.thread], opts)) continue;
    const sec = Math.floor(ts / 1000);
    let b = buckets.get(sec);
    if (!b) buckets.set(sec, (b = { threads: 0, byLabel: new Map() }));
    let e = b.byLabel.get(label);
    if (!e) b.byLabel.set(label, (e = { c: 0, e: 0, s: 0 }));
    e.c++;
    if (f[cols.success] !== 'true') e.e++;
    e.s += parseInt(f[cols.elapsed], 10) || 0;
    if (threadCol >= 0) { const at = parseInt(f[threadCol], 10) || 0; if (at > b.threads) b.threads = at; }
    labelTotals.set(label, (labelTotals.get(label) || 0) + 1);
  }
  const secs = [...buckets.keys()].sort((a, b) => a - b);
  if (!secs.length) return { t: [], labels: [], series: {}, threads: null };

  const ranked = [...labelTotals.entries()].sort((a, b) => b[1] - a[1]).map(([l]) => l);
  const keep = new Set(ranked.slice(0, TOP));
  const hasOther = ranked.length > TOP;
  const labels = ranked.slice(0, TOP).concat(hasOther ? ['Other'] : []);

  const span = secs[secs.length - 1] - secs[0] + 1;
  const step = Math.max(1, Math.ceil(span / maxPoints));
  const t = [];
  const series = {};
  for (const l of labels) series[l] = { tps: [], errors: [], avg: [] };
  const threads = threadCol >= 0 ? [] : null;

  for (let s = secs[0]; s <= secs[secs.length - 1]; s += step) {
    t.push(s);
    let th = 0;
    const acc = {};
    for (const l of labels) acc[l] = { c: 0, e: 0, s: 0 };
    for (let k = s; k < s + step; k++) {
      const b = buckets.get(k);
      if (!b) continue;
      if (b.threads > th) th = b.threads;
      for (const [label, e] of b.byLabel) {
        const key = keep.has(label) ? label : 'Other';
        if (!acc[key]) continue;
        acc[key].c += e.c; acc[key].e += e.e; acc[key].s += e.s;
      }
    }
    for (const l of labels) {
      const a = acc[l];
      series[l].tps.push(+(a.c / step).toFixed(2));
      series[l].errors.push(a.e);
      series[l].avg.push(a.c ? Math.round(a.s / a.c) : 0);
    }
    if (threads) threads.push(th);
  }
  return { t, labels, series, threads };
}

/**
 * Group ALL failed samples by (sampler, code, message, failureMessage) with
 * true counts — streamed from the JTL so no error type is ever lost, however
 * many thousands of duplicates occurred.
 */
async function errorSummaryFromJtl(file, opts = {}) {
  const groups = new Map();
  let cols = null, totalErrors = 0, totalSamples = 0;
  const rl = createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const f = splitCsv(line);
    if (!cols) { cols = jtlCols(f); continue; }
    const ts = parseInt(f[cols.ts], 10);
    if (!Number.isFinite(ts)) continue;
    if (!tgMatches(f[cols.thread], opts)) continue;
    totalSamples++;
    if (f[cols.success] === 'true') continue;
    totalErrors++;
    const label = f[cols.label] || '?';
    const code = f[cols.code] || '';
    const msg = (f[cols.msg] || '').slice(0, 300);
    const failure = (f[cols.failure] || '').slice(0, 300);
    const key = `${label} ${code} ${msg} ${failure}`;
    let g = groups.get(key);
    if (!g) groups.set(key, (g = { label, code, msg, failure, count: 0, firstTs: ts, lastTs: ts }));
    g.count++;
    if (ts < g.firstTs) g.firstTs = ts;
    if (ts > g.lastTs) g.lastTs = ts;
  }
  return {
    totalSamples,
    totalErrors,
    groups: [...groups.values()].sort((a, b) => b.count - a.count),
  };
}

/** Stream a window of raw samples out of the merged JTL (View Results in Table). */
async function sampleWindow(file, { offset = 0, limit = 100, errorsOnly = false, tg, tgNames }) {
  const rows = [];
  let cols = null, matched = 0, hasMore = false;
  const rl = createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    const f = splitCsv(line);
    if (!cols) { cols = jtlCols(f); continue; }
    const ts = parseInt(f[cols.ts], 10);
    if (!Number.isFinite(ts)) continue;
    const ok = f[cols.success] === 'true';
    if (errorsOnly && ok) continue;
    if (!tgMatches(f[cols.thread], { tg, tgNames })) continue;
    matched++;
    if (matched <= offset) continue;
    if (rows.length >= limit) { hasMore = true; break; }
    rows.push({
      t: ts,
      thread: f[cols.thread] || '',
      label: f[cols.label] || '',
      elapsed: parseInt(f[cols.elapsed], 10) || 0,
      code: f[cols.code] || '',
      msg: f[cols.msg] || '',
      success: ok,
      bytes: parseInt(f[cols.bytes], 10) || 0,
      latency: parseInt(f[cols.latency], 10) || 0,
      connect: parseInt(f[cols.connect], 10) || 0,
      failure: f[cols.failure] || '',
      url: f[cols.url] || '',
    });
  }
  return { offset, rows, hasMore };
}

// ---------- captured error responses (errors-<agent>.xml, XML JTL) ----------

const MAX_ERRORS_FILE = 120 * 1024 * 1024; // refuse to DOM-parse beyond this
const MAX_BODY_CHARS = 50_000;
const MAX_HEADER_CHARS = 4_000;

/**
 * Parse one agent's errors.xml (XML JTL with response data) into entries with
 * response body/headers — the "View Results Tree" data for failed samples.
 */
/**
 * A run that was STOPPED mid-write leaves errors.xml truncated (no closing
 * </testResults>, maybe a half-written sample). Trim to the last complete
 * sample and close the root so the XML parser doesn't choke.
 */
function repairErrorsXml(content) {
  if (/<\/testResults>\s*$/.test(content)) return content;
  const a = content.lastIndexOf('</httpSample>');
  const b = content.lastIndexOf('</sample>');
  const cut = Math.max(a, b);
  if (cut === -1) {
    const openEnd = content.indexOf('>', content.indexOf('<testResults'));
    return (openEnd !== -1 ? content.slice(0, openEnd + 1) : '<testResults>') + '\n</testResults>';
  }
  const tagLen = (a >= b ? '</httpSample>' : '</sample>').length;
  return content.slice(0, cut + tagLen) + '\n</testResults>';
}

function parseErrorsXml(file, limit = 200, dedupeByType = false) {
  if (fs.statSync(file).size > MAX_ERRORS_FILE) {
    return { tooBig: true, entries: [] };
  }
  const { DOMParser } = require('@xmldom/xmldom');
  let doc;
  try {
    doc = new DOMParser().parseFromString(repairErrorsXml(fs.readFileSync(file, 'utf8')), 'text/xml');
  } catch {
    return { tooBig: false, entries: [], truncated: true }; // unparseable capture — skip gracefully
  }
  const entries = [];
  const seenTypes = new Set(); // label|code keys when deduping
  const childText = (el, tag) => {
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1 && n.tagName === tag) return n.textContent || '';
    }
    return '';
  };
  const visit = (el) => {
    if (entries.length >= limit) return;
    if (el.tagName === 'httpSample' || el.tagName === 'sample') {
      const typeKey = `${el.getAttribute('lb')}|${el.getAttribute('rc')}`;
      if (dedupeByType && seenTypes.has(typeKey)) {
        // keep scanning children (sub-samples may be a different type)
        for (let n = el.firstChild; n; n = n.nextSibling) if (n.nodeType === 1) visit(n);
        return;
      }
      seenTypes.add(typeKey);
      entries.push({
        t: parseInt(el.getAttribute('ts'), 10) || 0,
        elapsed: parseInt(el.getAttribute('t'), 10) || 0,
        label: el.getAttribute('lb') || '',
        thread: el.getAttribute('tn') || '',
        code: el.getAttribute('rc') || '',
        msg: el.getAttribute('rm') || '',
        method: childText(el, 'method'),
        cookies: childText(el, 'cookies').slice(0, MAX_HEADER_CHARS),
        url: childText(el, 'java.net.URL'),
        assertion: (() => {
          for (let n = el.firstChild; n; n = n.nextSibling) {
            if (n.nodeType === 1 && n.tagName === 'assertionResult') {
              const fm = childText(n, 'failureMessage');
              if (fm) return fm.slice(0, 1000);
            }
          }
          return '';
        })(),
        requestData: childText(el, 'queryString').slice(0, MAX_BODY_CHARS),
        requestHeaders: childText(el, 'requestHeader').slice(0, MAX_HEADER_CHARS),
        responseHeaders: childText(el, 'responseHeader').slice(0, MAX_HEADER_CHARS),
        responseBody: childText(el, 'responseData').slice(0, MAX_BODY_CHARS),
      });
    }
    for (let n = el.firstChild; n; n = n.nextSibling) {
      if (n.nodeType === 1) visit(n);
    }
  };
  if (doc.documentElement) visit(doc.documentElement);
  return { tooBig: false, entries };
}

module.exports = { RunStats, summarizeJtl, sampleWindow, timelineFromJtl, timelineByLabel, parseErrorsXml, resolveTg, errorSummaryFromJtl };

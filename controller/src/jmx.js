'use strict';
/**
 * JMX (JMeter test plan XML) parsing and rewriting.
 *
 * A JMX file is a tree of test elements. The pattern is always:
 *   <SomeElement testname="..." enabled="true">...props...</SomeElement>
 *   <hashTree> ...children of that element... </hashTree>
 * i.e. an element's children live in the hashTree that is its NEXT SIBLING.
 *
 * We identify thread groups (tag contains "ThreadGroup") and samplers
 * (tag contains "Sampler"). Elements get stable ids from their document
 * order, so parse and rewrite walks must use the same detection logic.
 */

const { DOMParser, XMLSerializer } = require('@xmldom/xmldom');

const THREADS_PROP_PREFIX = 'lp_threads_';

// BlazeMeter (bzm) plugin thread groups use a rate/concurrency model instead of
// a fixed thread count: TargetLevel + RampUp + Steps + Hold. We still treat the
// TargetLevel as the per-TG "load level" so it splits across agents like threads.
const BZM_KINDS = {
  'com.blazemeter.jmeter.threads.arrivals.ArrivalsThreadGroup': 'arrivals',
  'com.blazemeter.jmeter.threads.concurrency.ConcurrencyThreadGroup': 'concurrency',
  'com.blazemeter.jmeter.threads.arrivals.FreeFormArrivalsThreadGroup': 'arrivals',
};
function tgKind(el) {
  return BZM_KINDS[el.tagName] || 'standard';
}

function isElement(node) {
  return node && node.nodeType === 1;
}

function walk(el, visit) {
  visit(el);
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (isElement(n)) walk(n, visit);
  }
}

/** Direct child like <stringProp name="ThreadGroup.num_threads">10</stringProp> */
function getPropEl(el, name) {
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (isElement(n) && n.getAttribute && n.getAttribute('name') === name) return n;
  }
  return null;
}

function getPropText(el, name) {
  const p = getPropEl(el, name);
  return p ? (p.textContent || '') : null;
}

function setPropText(doc, el, name, value, tag = 'stringProp') {
  let p = getPropEl(el, name);
  if (!p) {
    p = doc.createElement(tag);
    p.setAttribute('name', name);
    el.appendChild(p);
  } else if (p.tagName !== tag) {
    // JMeter 5.5+ saves some fields as <intProp>/<longProp>, which can only
    // hold plain numbers. A ${__P(...)} expression needs a <stringProp> — the
    // JMeter GUI does the same conversion when you type a function into the
    // field, and stringProp with a numeric value is always accepted.
    const repl = doc.createElement(tag);
    repl.setAttribute('name', name);
    el.replaceChild(repl, p);
    p = repl;
  }
  while (p.firstChild) p.removeChild(p.firstChild);
  p.appendChild(doc.createTextNode(String(value)));
}

function isEnabled(el) {
  return el.getAttribute('enabled') !== 'false';
}

/** The LoopController lives in an elementProp child of the ThreadGroup. */
function getLoopController(tgEl) {
  return getPropEl(tgEl, 'ThreadGroup.main_controller');
}

/** Walk up to find the thread group a sampler belongs to (see hashTree note above). */
function owningThreadGroup(el) {
  let node = el;
  while (node.parentNode && isElement(node.parentNode)) {
    node = node.parentNode;
    if (node.tagName === 'hashTree') {
      let prev = node.previousSibling;
      while (prev && !isElement(prev)) prev = prev.previousSibling;
      if (prev && prev.tagName && prev.tagName.includes('ThreadGroup')) return prev;
    }
  }
  return null;
}

/**
 * The chain of controller ELEMENTS (Simple/Transaction/If/Loop/…) between a
 * sampler and its thread group, outermost first — the JMeter GUI tree shape.
 */
function controllerPath(el) {
  const path = [];
  let node = el;
  while (node.parentNode && isElement(node.parentNode)) {
    node = node.parentNode;
    if (node.tagName !== 'hashTree') continue;
    let prev = node.previousSibling;
    while (prev && !isElement(prev)) prev = prev.previousSibling;
    if (!prev || !prev.tagName) continue;
    if (prev.tagName.includes('ThreadGroup')) break;
    if (isControllerTag(prev.tagName) && prev.getAttribute('testclass')) path.unshift(prev);
  }
  return path;
}

function isControllerTag(tag) {
  return tag.includes('Controller') || tag === 'InterleaveControl' || tag === 'RunTime';
}

/** The element whose hashTree directly holds `el` (its parent in the JMeter tree). */
function treeParent(el) {
  const h = el.parentNode;
  if (!h || h.tagName !== 'hashTree') return null;
  let prev = h.previousSibling;
  while (prev && !isElement(prev)) prev = prev.previousSibling;
  return prev || null;
}

// Bump when the parsed structure gains fields, so stored plans are re-parsed.
const PARSER_VERSION = 2;

// Short label for what kind of request a sampler sends (GET/POST, Script…).
function samplerMethod(el) {
  const tag = el.tagName || '';
  if (tag === 'HTTPSamplerProxy' || tag === 'HTTPSampler') return (getPropText(el, 'HTTPSampler.method') || 'GET').toUpperCase();
  if (/JSR223|BeanShell|Groovy/i.test(tag)) return 'Script';
  if (tag === 'DebugSampler') return 'Debug';
  if (/JDBC/i.test(tag)) return 'SQL';
  if (/TCP/i.test(tag)) return 'TCP';
  if (/SMTP|Mail/i.test(tag)) return 'Mail';
  if (/FTP/i.test(tag)) return 'FTP';
  if (/Flow|Test/i.test(tag)) return 'Flow';
  return tag.replace(/Sampler(Proxy)?$/, '').replace(/^.*\./, '').slice(0, 8) || 'Other';
}

const TYPE_LABELS = {
  XPathExtractor: 'XPath Extractor', XPath2Extractor: 'XPath Extractor', RegexExtractor: 'Regular Expression Extractor',
  JSONPostProcessor: 'JSON Extractor', BoundaryExtractor: 'Boundary Extractor', HtmlExtractor: 'CSS Selector Extractor',
  JSONPathExtractor: 'JSON Extractor', JSR223PostProcessor: 'JSR223 PostProcessor', JSR223PreProcessor: 'JSR223 PreProcessor',
  BeanShellPreProcessor: 'BeanShell PreProcessor', BeanShellPostProcessor: 'BeanShell PostProcessor',
  UserParameters: 'User Parameters', RegExUserParameters: 'RegEx User Parameters',
  ResponseAssertion: 'Response Assertion', JSONPathAssertion: 'JSON Assertion', DurationAssertion: 'Duration Assertion',
  SizeAssertion: 'Size Assertion', JSR223Assertion: 'JSR223 Assertion', BeanShellAssertion: 'BeanShell Assertion',
  XPathAssertion: 'XPath Assertion', XPath2Assertion: 'XPath Assertion', HTMLAssertion: 'HTML Assertion',
  CSVDataSet: 'CSV Data Set Config',
};
function typeLabel(tag) {
  return TYPE_LABELS[tag] || String(tag).replace(/^.*\./, '').replace(/([a-z])([A-Z])/g, '$1 $2');
}

const EXTRACTOR_REF = {
  XPathExtractor: 'XPathExtractor.refname', XPath2Extractor: 'XPathExtractor2.refname', RegexExtractor: 'RegexExtractor.refname',
  JSONPostProcessor: 'JSONPostProcessor.referenceNames', BoundaryExtractor: 'BoundaryExtractor.refname', HtmlExtractor: 'HtmlExtractor.refname',
};

/** One-line plain description of an assertion ("response contains “Dashboard”"). */
function assertionDetail(el) {
  const tag = el.tagName;
  if (tag === 'ResponseAssertion') {
    const coll = getPropEl(el, 'Asserion.test_strings') || getPropEl(el, 'Assertion.test_strings');
    const strings = [];
    if (coll) for (let n = coll.firstChild; n; n = n.nextSibling) if (isElement(n)) strings.push(n.textContent || '');
    const type = parseInt(getPropText(el, 'Assertion.test_type'), 10) || 2;
    const field = getPropText(el, 'Assertion.test_field') || '';
    const what = /response_code/.test(field) ? 'code' : /response_headers/.test(field) ? 'headers'
      : /response_message/.test(field) ? 'message' : /sample_label|request/.test(field) ? 'request' : 'response';
    const not = (type & 4) !== 0;
    const verb = (type & 8) ? (not ? 'must not equal' : 'equals') : (type & 1) ? (not ? 'must not match' : 'matches')
      : (not ? 'must not contain' : 'contains');
    const first = strings[0] != null ? `“${strings[0].length > 80 ? `${strings[0].slice(0, 80)}…` : strings[0]}”` : '';
    return `${what} ${verb} ${first}${strings.length > 1 ? ` (+${strings.length - 1} more)` : ''}`.trim();
  }
  if (tag === 'JSONPathAssertion') return `JSON path ${getPropText(el, 'JSON_PATH') || ''}`.trim();
  if (tag === 'DurationAssertion') { const d = getPropText(el, 'DurationAssertion.duration'); return d ? `responds within ${d} ms` : ''; }
  if (tag === 'SizeAssertion') { const s = getPropText(el, 'SizeAssertion.size'); return s ? `size check (${s} bytes)` : ''; }
  return '';
}

function collect(doc) {
  const threadGroups = [];
  const samplers = [];
  const controllers = [];
  const csvSets = [];
  const preProcessors = [];
  const postProcessors = [];
  const assertions = [];
  const plugins = new Set();
  let testPlanName = '';
  walk(doc.documentElement, (el) => {
    const tag = el.tagName || '';
    // Third-party test elements serialize under their full class name
    // (com.blazemeter…, kg.apc…). JMeter can't even LOAD such a plan unless
    // the matching plugin jars are installed — worth surfacing at upload time.
    if (tag.includes('.') && el.getAttribute('testclass')) plugins.add(tag);
    if (tag === 'TestPlan') {
      testPlanName = el.getAttribute('testname') || 'Test Plan';
    } else if (tag.includes('ThreadGroup') && el.getAttribute('testclass')) {
      threadGroups.push(el);
    } else if (tag.includes('Sampler') && el.getAttribute('testclass')) {
      samplers.push(el);
    } else if (isControllerTag(tag) && el.getAttribute('testclass')) {
      controllers.push(el);
    } else if (tag === 'CSVDataSet') {
      csvSets.push(el);
    } else if (el.getAttribute('testclass') && /PreProcessor$/.test(tag)) {
      preProcessors.push(el);
    } else if (el.getAttribute('testclass') && (/PostProcessor$/.test(tag) || /Extractor$/.test(tag))) {
      // extractors (RegexExtractor, JSON/XPath/Boundary/Html) are post-processors too
      postProcessors.push(el);
    } else if (el.getAttribute('testclass') && /Assertion$/.test(tag)) {
      assertions.push(el);
    }
  });
  return { testPlanName, threadGroups, samplers, controllers, csvSets, preProcessors, postProcessors, assertions, plugins: [...plugins] };
}

/** Bare file name out of a JMX file reference (handles both \ and / paths). */
function baseName(p) {
  return String(p || '').split(/[\\/]/).pop();
}

/**
 * Every editable "User Defined Variables" block, in document order. Covers both
 * the Test Plan's own variables (an <elementProp name="TestPlan.user_defined_variables">)
 * and standalone "User Defined Variables" config elements (<Arguments testclass="Arguments">).
 * HTTP-sampler argument lists look similar but are excluded (they use
 * elementType="HTTPArgument"). Parse and rewrite call this so block indexes line up.
 */
function collectUdvBlocks(doc) {
  const blocks = [];
  walk(doc.documentElement, (el) => {
    const tag = el.tagName || '';
    const isTestPlanUdv = tag === 'elementProp' && el.getAttribute('name') === 'TestPlan.user_defined_variables';
    const isStandaloneUdv = tag === 'Arguments' && el.getAttribute('testclass') === 'Arguments';
    if (!isTestPlanUdv && !isStandaloneUdv) return;
    const coll = getPropEl(el, 'Arguments.arguments');
    if (!coll) return;
    const args = [];
    for (let n = coll.firstChild; n; n = n.nextSibling) {
      if (!isElement(n) || n.tagName !== 'elementProp') continue;
      if (n.getAttribute('elementType') !== 'Argument') continue; // skip HTTPArgument etc.
      const nameEl = getPropEl(n, 'Argument.name');
      const valueEl = getPropEl(n, 'Argument.value');
      if (!nameEl) continue;
      args.push({ el: n, name: nameEl.textContent || '', value: valueEl ? (valueEl.textContent || '') : '' });
    }
    if (args.length) blocks.push({ el, isTestPlanUdv, args });
  });
  return blocks;
}

/**
 * Parse a JMX string into a UI-friendly structure.
 * Standard ThreadGroups are editable; exotic ones (Ultimate/Concurrency etc.)
 * are listed but marked editable:false — they run with their own settings.
 */
function parseJmx(xml) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const root = doc.documentElement;
  if (!root || root.tagName !== 'jmeterTestPlan') {
    throw new Error('Not a JMeter test plan (missing <jmeterTestPlan> root)');
  }
  const { testPlanName, threadGroups, samplers, controllers, csvSets, preProcessors, postProcessors, assertions, plugins } = collect(doc);

  // Document-order index per element — lets the UI interleave controllers and
  // samplers correctly when building the workload tree.
  const orderMap = new Map();
  { let seq = 0; walk(doc.documentElement, (el) => orderMap.set(el, seq++)); }

  // Files the plan reads (CSV Data Set Config). Plans written on one PC often
  // use absolute paths that exist nowhere else — agents need these uploaded.
  const dataFileRefs = [];
  for (const el of csvSets) {
    const raw = getPropText(el, 'filename') || '';
    if (!raw) continue;
    const name = baseName(raw);
    if (!dataFileRefs.some((r) => r.name === name)) {
      const tg = owningThreadGroup(el);
      dataFileRefs.push({
        name,
        path: raw,
        absolute: /^([a-zA-Z]:|\\\\|\/)/.test(raw),
        enabled: isEnabled(el),
        // owning thread group (null = test-plan level / global, used by all groups).
        // A CSV whose group is disabled for a run isn't needed for that run.
        threadGroupId: tg ? threadGroups.indexOf(tg) : null,
      });
    }
  }

  const ctrlInfos = controllers.map((el, i) => {
    const tg = owningThreadGroup(el);
    return {
      id: i,
      tag: el.tagName,
      name: el.getAttribute('testname') || el.tagName,
      enabled: isEnabled(el),
      threadGroupId: tg ? threadGroups.indexOf(tg) : null,
      // ancestor controllers (outermost -> innermost); last is the direct parent
      ctrlIds: controllerPath(el).map((c) => controllers.indexOf(c)).filter((x) => x >= 0),
      seq: orderMap.get(el),
    };
  });

  const tgInfos = threadGroups.map((el, i) => {
    const kind = tgKind(el);
    const base = { id: i, tag: el.tagName, name: el.getAttribute('testname') || el.tagName, enabled: isEnabled(el), kind };
    if (kind === 'arrivals' || kind === 'concurrency') {
      // rate/concurrency model — TargetLevel is the "load level" (splits like threads)
      return {
        ...base,
        editable: true,
        threads: parseInt(getPropText(el, 'TargetLevel'), 10) || 1,
        rampUp: parseInt(getPropText(el, 'RampUp'), 10) || 0,
        steps: parseInt(getPropText(el, 'Steps'), 10) || 0,
        hold: parseInt(getPropText(el, 'Hold'), 10) || 0,
        unit: (getPropText(el, 'Unit') || 'S').toUpperCase() === 'M' ? 'M' : 'S',
      };
    }
    const threads = getPropText(el, 'ThreadGroup.num_threads');
    const editable = threads !== null;
    const loopCtl = getLoopController(el);
    const loops = loopCtl ? getPropText(loopCtl, 'LoopController.loops') : null;
    return {
      ...base,
      editable,
      threads: editable ? parseInt(threads, 10) || 1 : null,
      rampUp: parseInt(getPropText(el, 'ThreadGroup.ramp_time'), 10) || 0,
      scheduler: getPropText(el, 'ThreadGroup.scheduler') === 'true',
      duration: parseInt(getPropText(el, 'ThreadGroup.duration'), 10) || 0,
      loops: loops === null ? null : parseInt(loops, 10),
    };
  });

  const samplerInfos = samplers.map((el, i) => {
    const tg = owningThreadGroup(el);
    return {
      id: i,
      tag: el.tagName,
      name: el.getAttribute('testname') || el.tagName,
      method: samplerMethod(el),
      enabled: isEnabled(el),
      threadGroupId: tg ? threadGroups.indexOf(tg) : null,
      // ancestor controller ids, outermost -> innermost
      ctrlIds: controllerPath(el).map((c) => controllers.indexOf(c)).filter((x) => x >= 0),
      seq: orderMap.get(el),
    };
  });

  // Editable User Defined Variables — Test Plan-level and nested blocks.
  const variables = collectUdvBlocks(doc).map((b, i) => {
    const tg = owningThreadGroup(b.el);
    return {
      id: i,
      name: b.el.getAttribute('testname') || 'User Defined Variables',
      scope: b.isTestPlanUdv ? 'Test Plan' : (tg ? (tg.getAttribute('testname') || 'Thread Group') : 'Test Plan'),
      enabled: isEnabled(b.el),
      args: b.args.map((a) => ({ name: a.name, value: a.value })),
    };
  });

  // Non-sampler elements that shape the run — CSV Data Set Config, pre/post
  // processors, extractors and assertions — so the tree shows what feeds, checks
  // and post-processes each request. Informational (no split checkbox). An element
  // inside a sampler's hashTree belongs to THAT sampler only (samplerId); one
  // under a controller or the thread group applies to every request in that scope.
  const isExtractor = (el) => /Extractor$/.test(el.tagName) || el.tagName === 'JSONPostProcessor';
  const auxSrc = [
    ...csvSets.map((el) => ({ el, role: 'csv' })),
    ...preProcessors.map((el) => ({ el, role: 'pre' })),
    ...postProcessors.map((el) => ({ el, role: isExtractor(el) ? 'extract' : 'post' })),
    ...assertions.map((el) => ({ el, role: 'check' })),
  ];
  const aux = auxSrc.map(({ el, role }, i) => {
    const tg = owningThreadGroup(el);
    const parent = treeParent(el);
    const sIdx = parent ? samplers.indexOf(parent) : -1;
    const ref = EXTRACTOR_REF[el.tagName] ? getPropText(el, EXTRACTOR_REF[el.tagName]) : null;
    return {
      id: i,
      role,
      tag: el.tagName,
      type: typeLabel(el.tagName),
      name: el.getAttribute('testname') || el.tagName,
      // what it does in a few words: the variable an extractor saves, what an assertion checks
      detail: role === 'extract' ? (ref || '') : role === 'check' ? assertionDetail(el) : '',
      file: role === 'csv' ? baseName(getPropText(el, 'filename') || '') : undefined,
      enabled: isEnabled(el),
      threadGroupId: tg ? threadGroups.indexOf(tg) : null,
      ctrlIds: controllerPath(el).map((c) => controllers.indexOf(c)).filter((x) => x >= 0),
      samplerId: sIdx >= 0 ? sIdx : null,
      seq: orderMap.get(el),
    };
  }).sort((a, b) => a.seq - b.seq);

  return { parserV: PARSER_VERSION, testPlanName, threadGroups: tgInfos, samplers: samplerInfos, controllers: ctrlInfos, dataFileRefs, variables, aux, plugins };
}

/** Merged variable name->value map: plan UDV defaults, then per-run overrides win. */
function udvValueMap(doc, overrides) {
  const map = {};
  collectUdvBlocks(doc).forEach((b) => { for (const a of b.args) map[a.name] = a.value; });
  if (overrides) for (const bid of Object.keys(overrides)) {
    for (const k of Object.keys(overrides[bid] || {})) map[k] = overrides[bid][k];
  }
  return map;
}

/** Resolve ${var} references (a few passes to cover vars that reference vars). */
function resolveVars(str, map) {
  let s = String(str);
  for (let i = 0; i < 4 && s.includes('${'); i++) {
    s = s.replace(/\$\{([^}]+)\}/g, (m, name) => (map[name] !== undefined ? map[name] : m));
  }
  return s;
}

/**
 * Distinct target hosts a run actually load-tests, most-hit first. Only counts
 * samplers that are ENABLED for this run — respecting the run config's disabled
 * thread groups / controllers / samplers (and, in per-agent mode, the union of
 * what any agent runs). ${var} domains resolve against the plan UDVs + this
 * run's overrides. `targets[0]` is the primary app under test; the rest are
 * dependencies it happens to call (payment gateways, other APIs, …).
 */
function extractTargets(xml, config) {
  let doc;
  try { doc = new DOMParser().parseFromString(xml, 'text/xml'); } catch { return []; }
  const { threadGroups, samplers, controllers } = collect(doc);
  const map = udvValueMap(doc, config && config.variables);

  // per-run enable state — even-split has one config; per-agent unions all agents
  const cfgs = (config && config.mode === 'per-agent')
    ? Object.values(config.agentConfigs || {})
    : [config || {}];
  const on = (arr, id, planDefault) => {
    if (id < 0) return true;
    if (!arr) return planDefault;          // config didn't list it → plan's own flag
    const e = arr.find((x) => x.id === id);
    return e ? !!e.enabled : planDefault;
  };
  const activeFor = (s, c) => {
    if (!on(c.samplers, samplers.indexOf(s), isEnabled(s))) return false;
    const tg = owningThreadGroup(s);
    if (tg && !on(c.threadGroups, threadGroups.indexOf(tg), isEnabled(tg))) return false;
    for (const ctrl of controllerPath(s)) {
      if (!on(c.controllers, controllers.indexOf(ctrl), isEnabled(ctrl))) return false;
    }
    return true;
  };

  const counts = new Map();
  for (const s of samplers) {
    const dp = getPropEl(s, 'HTTPSampler.domain');
    if (!dp) continue;                      // non-HTTP sampler
    if (!cfgs.some((c) => activeFor(s, c))) continue;
    const host = resolveVars(dp.textContent || '', map).trim().toLowerCase();
    if (!host || host.includes('${')) continue; // empty or unresolved
    counts.set(host, (counts.get(host) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h);
}

/**
 * Rewrite the JMX per run config. Thread counts become JMeter properties
 * (${__P(lp_threads_N,default)}) so ONE rewritten file serves every agent —
 * each agent passes its own -Jlp_threads_N to take its share of the load.
 *
 * config = {
 *   threadGroups: [{id, enabled, rampUp, mode: 'loops'|'duration', loops, duration}],
 *   samplers:     [{id, enabled}],
 * }
 * Returns { xml, threadProps: [{tgId, prop}] } — threadProps lists the
 * property name for each editable, enabled thread group.
 */
function applyConfig(xml, config) {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');
  const { threadGroups, samplers, controllers, csvSets } = collect(doc);
  const threadProps = [];

  for (const c of config.threadGroups || []) {
    const el = threadGroups[c.id];
    if (!el) continue;
    el.setAttribute('enabled', c.enabled ? 'true' : 'false');
    if (!c.enabled) continue;

    const kind = tgKind(el);
    if (kind === 'arrivals' || kind === 'concurrency') {
      // bzm rate/concurrency group: TargetLevel is the load level → split like
      // threads via a property; RampUp/Steps/Hold are timeline (same on every agent).
      const prop = THREADS_PROP_PREFIX + c.id;
      const fallback = Math.max(1, parseInt(getPropText(el, 'TargetLevel'), 10) || 1);
      setPropText(doc, el, 'TargetLevel', '${__P(' + prop + ',' + fallback + ')}');
      threadProps.push({ tgId: c.id, prop });
      if (c.rampUp != null) setPropText(doc, el, 'RampUp', Math.max(0, c.rampUp | 0));
      if (c.steps != null) setPropText(doc, el, 'Steps', Math.max(0, c.steps | 0));
      if (c.hold != null) setPropText(doc, el, 'Hold', Math.max(0, c.hold | 0));
      continue;
    }
    if (getPropText(el, 'ThreadGroup.num_threads') === null) continue; // custom group, runs as-is

    const prop = THREADS_PROP_PREFIX + c.id;
    const fallback = Math.max(1, parseInt(getPropText(el, 'ThreadGroup.num_threads'), 10) || 1);
    setPropText(doc, el, 'ThreadGroup.num_threads', '${__P(' + prop + ',' + fallback + ')}');
    threadProps.push({ tgId: c.id, prop });

    if (Number.isFinite(c.rampUp)) setPropText(doc, el, 'ThreadGroup.ramp_time', c.rampUp);

    const loopCtl = getLoopController(el);
    if (c.mode === 'duration') {
      setPropText(doc, el, 'ThreadGroup.scheduler', 'true', 'boolProp');
      setPropText(doc, el, 'ThreadGroup.duration', Math.max(1, c.duration | 0));
      if (loopCtl) setPropText(doc, loopCtl, 'LoopController.loops', '-1');
    } else if (c.mode === 'loops') {
      setPropText(doc, el, 'ThreadGroup.scheduler', 'false', 'boolProp');
      if (loopCtl) setPropText(doc, loopCtl, 'LoopController.loops', Math.max(1, c.loops | 0));
    }
  }

  for (const c of config.samplers || []) {
    const el = samplers[c.id];
    if (el) el.setAttribute('enabled', c.enabled ? 'true' : 'false');
  }

  for (const c of config.controllers || []) {
    const el = controllers[c.id];
    if (el) el.setAttribute('enabled', c.enabled ? 'true' : 'false');
  }

  // User Defined Variable overrides: { [blockId]: { [argName]: newValue } }.
  // Block indexes match parseJmx (both use collectUdvBlocks in document order).
  if (config.variables) {
    const blocks = collectUdvBlocks(doc);
    for (const [bid, overrides] of Object.entries(config.variables)) {
      const block = blocks[+bid];
      if (!block || !overrides) continue;
      for (const arg of block.args) {
        if (Object.prototype.hasOwnProperty.call(overrides, arg.name)) {
          setPropText(doc, arg.el, 'Argument.value', overrides[arg.name]);
        }
      }
    }
  }

  // CSV paths -> bare names for every file uploaded to LoadPilot, so agents on
  // OTHER machines read their downloaded copy instead of a path that only
  // exists on the plan author's PC.
  const uploadedNames = new Set(config.dataFileNames || []);
  for (const el of csvSets) {
    const raw = getPropText(el, 'filename') || '';
    // agents save downloads under the SAFE name ("Login Users.csv" -> "Login_Users.csv"), which
    // is also the library's name for it — point the plan at exactly that file
    const safe = baseName(raw).replace(/[^\w.-]/g, '_');
    if (raw !== safe && uploadedNames.has(safe)) setPropText(doc, el, 'filename', safe);
  }

  injectErrorCapture(doc);

  return { xml: new XMLSerializer().serializeToString(doc), threadProps };
}

/**
 * Add a plan-wide errors-only results writer: failed samples (and only those)
 * are recorded to errors.xml in the agent's work dir WITH response body and
 * headers — the data "View Results Tree" would show, without the cost of
 * recording successful samples under load.
 */
const ERROR_COLLECTOR_XML = `
<ResultCollector guiclass="SimpleDataWriter" testclass="ResultCollector" testname="LoadPilot Error Capture" enabled="true">
  <boolProp name="ResultCollector.error_logging">true</boolProp>
  <objProp>
    <name>saveConfig</name>
    <value class="SampleSaveConfiguration">
      <time>true</time><latency>true</latency><timestamp>true</timestamp><success>true</success>
      <label>true</label><code>true</code><message>true</message><threadName>true</threadName>
      <dataType>false</dataType><encoding>false</encoding><assertions>true</assertions>
      <subresults>false</subresults><responseData>true</responseData><samplerData>true</samplerData>
      <xml>true</xml><fieldNames>true</fieldNames><responseHeaders>true</responseHeaders>
      <requestHeaders>true</requestHeaders><responseDataOnError>true</responseDataOnError>
      <saveAssertionResultsFailureMessage>true</saveAssertionResultsFailureMessage>
      <assertionsResultsToSave>0</assertionsResultsToSave><bytes>true</bytes>
      <sentBytes>true</sentBytes><url>true</url><threadCounts>true</threadCounts>
      <idleTime>true</idleTime><connectTime>true</connectTime>
    </value>
  </objProp>
  <stringProp name="filename">errors.xml</stringProp>
</ResultCollector>`;

function injectErrorCapture(doc) {
  let testPlanEl = null;
  walk(doc.documentElement, (el) => {
    if (!testPlanEl && el.tagName === 'TestPlan') testPlanEl = el;
  });
  if (!testPlanEl) return;
  let planTree = testPlanEl.nextSibling;
  while (planTree && !(isElement(planTree) && planTree.tagName === 'hashTree')) planTree = planTree.nextSibling;
  if (!planTree) return;

  const frag = new DOMParser().parseFromString(ERROR_COLLECTOR_XML.trim(), 'text/xml');
  planTree.appendChild(doc.importNode(frag.documentElement, true));
  planTree.appendChild(doc.createElement('hashTree'));
}

module.exports = { parseJmx, applyConfig, extractTargets, THREADS_PROP_PREFIX, PARSER_VERSION };

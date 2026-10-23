'use strict';
// Route order: the order of routes by money, as DATA plus a hard check.
// Reads tools/assign/route-order.json and docs/ops/farm/FARM-RUNS.jsonl.
// Deterministic: no model, no network, no spawn, no clock, never starts anything.
// Unknown never lowers the bar: an unknown balance or availability of a cheaper
// kind is NOT exhausted, the cheaper kind stays first and the reason says so.
const path = require('node:path');
const io = require('./io.cjs');
const textSafe = require('../../.ai/bin/lib/text-safe.cjs');

const D = require('../../.ai/bin/accounting/lib/decimal.cjs');
const KINDS = ['free', 'subscription', 'direct', 'aggregator'];
const TASK_KINDS = ['author', 'fix-round', 'pre-review', 'certify', 'document', 'mechanical', 'design'];
const CANONICAL = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
// Positive proof lists: only a known hard disqualification or a known
// exhaustion can release the next kind. Every other reason is UNKNOWN,
// including future producer codes; missing prices never prove unsuitability.
// EXHAUSTED: the route is KNOWN to be unusable (money out, unhealthy, quota
// or ceiling refused), so the next kind may serve. UNKNOWN: the money or
// availability state is not known, and unknown never lowers the bar:
// the cheaper kind stays first and blocks the more expensive one.
const EXHAUSTED = ['route-unavailable', 'route-no-balance', 'route-budget-insufficient', 'route-unhealthy', 'route-key-or-provider-quota', 'daily-ceiling'];
const HARD = ['add60', 'independence', 'below-class-floor', 'role-rule', 'effort-for-tier', 'top-model-policy', 'mimo-busy', 'route-identity-unknown', 'effort-unknown', 'alias-unknown', 'class-unknown', 'score-unknown'];
// A candidate carrying BOTH a known-exhaustion code and an unknown-state code
// is UNKNOWN, never exhausted: contradictory evidence is not a permission.
const KEPT = { free: 'free-capable-first', subscription: 'subscription-minimal-sufficient', direct: 'direct-after-subscription', aggregator: 'aggregator-last-resort' };
const KEPT_ALTERNATIVE = 'subscription-sufficient-alternative';
const ANNOTATED = { exhausted: kind => `${kind}-exhausted`, unknown: kind => `${kind}-status-unknown`, unsuitable: kind => `${kind}-unqualified` };
const fail = code => { throw Object.assign(new Error(code), { code }); };

// Route key: "<client>:<model>", first colon splits; the pseudo-client "farm" names
// a calibration farm route id; "openrouter" denotes historical spend routes.
function splitRoute(route) {
  if (typeof route !== 'string') return null;
  const colon = route.indexOf(':');
  if (colon < 1) return null;
  const client = route.slice(0, colon), model = route.slice(colon + 1);
  if (!io.id(client) || !io.id(model)) return null;
  return { client, model };
}

// A decoded data value can hide an invisible character or a non-NFC spelling
// behind ASCII JSON escapes, where the file-level decode cannot see it. Every
// decoded string (and every object key) is checked again here and refused.
function textClean(value) {
  const checked = textSafe.decode(Buffer.from(value, 'utf8'), { bom: 'refuse', invisible: 'refuse' });
  if (!checked.ok || checked.notes.some(n => n.code === 'NOT_NFC')) fail('route-order-data-invalid');
}
function walkClean(value) {
  if (typeof value === 'string') textClean(value);
  else if (Array.isArray(value)) value.forEach(walkClean);
  else if (io.object(value)) for (const key of Object.keys(value)) { textClean(key); walkClean(value[key]); }
}

function validateData(data) {
  io.fields(data, ['schema', 'reason', 'enabled', 'enabledReason', 'order', 'orderReason', 'freeCapability', 'routes'],
    ['schema', 'reason', 'enabled', 'enabledReason', 'order', 'orderReason', 'freeCapability', 'routes']);
  if (data.schema !== 'route-order/1' || typeof data.enabled !== 'boolean') fail('route-order-schema');
  for (const key of ['reason', 'enabledReason', 'orderReason']) if (typeof data[key] !== 'string' || !data[key]) fail('route-order-schema');
  if (!Array.isArray(data.order) || JSON.stringify(data.order) !== JSON.stringify(KINDS)) fail('route-order-order');
  const fc = data.freeCapability;
  io.fields(fc, ['minRuns', 'minPassRate', 'reason', 'taskKinds', 'taskKindsReason'], ['minRuns', 'minPassRate', 'reason', 'taskKinds', 'taskKindsReason']);
  if (!Number.isInteger(fc.minRuns) || fc.minRuns < 1 || fc.minRuns > 10000
      || typeof fc.minPassRate !== 'number' || !Number.isFinite(fc.minPassRate) || fc.minPassRate <= 0 || fc.minPassRate > 1
      || typeof fc.reason !== 'string' || !fc.reason || typeof fc.taskKindsReason !== 'string' || !fc.taskKindsReason) fail('route-order-capability');
  if (JSON.stringify(Object.keys(fc.taskKinds).sort()) !== JSON.stringify([...TASK_KINDS].sort())) fail('route-order-task-kinds');
  for (const classes of Object.values(fc.taskKinds))
    if (!Array.isArray(classes) || !classes.every(c => io.id(c)) || new Set(classes).size !== classes.length) fail('route-order-task-kinds');
  if (!Array.isArray(data.routes) || !data.routes.length) fail('route-order-routes');
  const seen = new Set(), farmIds = new Set();
  for (const e of data.routes) {
    io.fields(e, ['route', 'kind', 'canonical', 'reason', 'farmRoute'], ['route', 'kind', 'canonical', 'reason']);
    if (!splitRoute(e.route)) fail('route-order-route-key');
    // canonical is exactly null or one canonical-form STRING; an array or any
    // other type is refused instead of coerced by the RegExp.
    if (!KINDS.includes(e.kind) || typeof e.reason !== 'string' || !e.reason
        || !(e.canonical === null || typeof e.canonical === 'string' && CANONICAL.test(e.canonical))) fail('route-order-route-entry');
    if (e.farmRoute !== undefined && (!io.id(e.farmRoute))) fail('route-order-route-entry');
    const parts = splitRoute(e.route);
    if (parts.client === 'farm') farmIds.add(parts.model);
    if (seen.has(e.route)) fail('route-order-route-duplicate');
    seen.add(e.route);
  }
  for (const e of data.routes) if (e.farmRoute !== undefined && !farmIds.has(e.farmRoute)) fail('route-order-farm-route-unknown');
  walkClean(data);
  io.publicValue(data);
  return data;
}

// Absent file: null (the switch is off, byte-identical outputs). Present but
// corrupt — including an unreadable policy location, a hardlink or junction in
// place of the file, a directory, broken text or an invalid schema — is ONE
// recorded route-order-data-invalid, never a raw path error and never a
// silent disable.
function loadRouteOrderData(root) {
  const rel = 'tools/assign/route-order.json';
  let g;
  try { g = io.guard(root, rel); } catch { fail('route-order-data-invalid'); }
  if (!g.exists) return null;
  if (g.type !== 'file') fail('route-order-data-invalid');
  try { return validateData(io.readJson(root, rel, 1024 * 1024)); }
  catch { fail('route-order-data-invalid'); }
}

// Tolerant journal read: a malformed row is counted and skipped, never an event;
// a truncated last line is not a run. One completed measured launch per launchId:
// every parseable row is grouped by its launchId
// BEFORE validity, so an invalid row naming a launch is conflicting evidence
// for that launch too. A launchId is measured only when EVERY row naming it
// is a valid measurement AND all of them are one canonical whole record
// (exact duplicates are idempotent, counted once); any disagreement — a
// second distinct record, a differing metadata field, an invalid or
// self-contradictory row — cancels ALL measurements of THAT launchId only
// (unknown never becomes a PASS) and never touches any other launchId.
function loadFarmRuns(root) {
  const rel = 'docs/ops/farm/FARM-RUNS.jsonl';
  let g;
  try { g = io.guard(root, rel); } catch { return { rows: [], problems: ['farm-journal-unreadable'], invalidRows: null }; }
  if (!g.exists || g.type !== 'file') return { rows: [], problems: ['farm-journal-missing'], invalidRows: null };
  let raw;
  try { raw = io.readText(root, rel, 8 * 1024 * 1024, 'report'); }
  catch { return { rows: [], problems: ['farm-journal-unreadable'], invalidRows: null }; }
  const byLaunch = new Map();
  const lines = raw.split('\n');
  let invalidRows = 0;
  // Refused rows never become measurements. Attribute only decoded root
  // identities through the SHARED reader; all named IDs are poisoned when
  // there are conflicting duplicate launchId fields, with one invalid count.
  const poison = line => {
    let names = [];
    try { names = textSafe.jsonRootStrings(line, 'launchId').filter(io.id); } catch {}
    for (const id of new Set(names)) {
      const group = byLaunch.get(id);
      if (group) group.valid = false;
      else byLaunch.set(id, { keys: new Set(), valid: false, count: 0, row: null });
    }
  };
  if (raw && !raw.endsWith('\n')) { poison(lines.pop()); invalidRows++; }
  for (const line of lines) {
    if (!line) continue;
    let r;
    try { r = textSafe.parseJsonUnique(line); } catch { poison(line); invalidRows++; continue; }
    const named = io.object(r) && typeof r.launchId === 'string' && io.id(r.launchId);
    let row = null;
    if (named) {
      try {
        if (r.schema !== 'launch-record/1' || typeof r.route !== 'string'
            || !r.route.startsWith('api:') || !io.id(r.route.slice(4)) || !io.id(r.taskClass) || !io.count(r.exitCode)
            || !['PASS', 'FAIL'].includes(r.verdict) || (r.verdict === 'PASS' && r.exitCode !== 0)) fail('farm-row-invalid');
        row = { launchId: r.launchId, route: r.route.slice(4), taskClass: r.taskClass, pass: r.verdict === 'PASS' };
      } catch { row = null; }
    }
    if (!named) { invalidRows++; continue; }
    const group = byLaunch.get(r.launchId);
    if (group === undefined) byLaunch.set(r.launchId, { keys: new Set([io.canonical(r)]), valid: row !== null, count: 1, row });
    else { group.keys.add(io.canonical(r)); group.count++; }
  }
  const rows = [];
  for (const group of byLaunch.values()) {
    if (group.valid && group.keys.size === 1) rows.push(group.row);
    else invalidRows += group.count;
  }
  return { rows, problems: [], invalidRows };
}

// A free route is capable only with measured evidence: at least minRuns runs of a
// mapped task class with pass rate at least minPassRate. No measurement or no
// mapped class: not capable, reason no-measurement; pass rate stays null, never 0.
function capability(data, rows, farmRouteId, taskKind) {
  const classes = TASK_KINDS.includes(taskKind) ? data.freeCapability.taskKinds[taskKind] : undefined;
  if (!Array.isArray(classes) || !classes.length || farmRouteId === null) {
    return { runs: null, passes: null, passRate: null, capable: false, reason: 'free-not-capable:no-measurement' };
  }
  const mine = rows.filter(r => r.route === farmRouteId && classes.includes(r.taskClass));
  const runs = mine.length, passes = mine.filter(r => r.pass).length;
  if (runs === 0) return { runs: 0, passes: 0, passRate: null, capable: false, reason: 'free-not-capable:no-measurement' };
  const passRate = passes / runs;
  if (runs < data.freeCapability.minRuns || passRate < data.freeCapability.minPassRate) {
    return { runs, passes, passRate, capable: false, reason: 'free-not-capable:below-threshold' };
  }
  return { runs, passes, passRate, capable: true, reason: null };
}

// A hard exclusion is positively established by HARD, never inferred from
// an unrecognized reason. It is FINAL: it never coexists
// with a money state and is never demoted into a cheaper-first fallback gate;
// an obviously unfit row does not stop the next route kind from being tried.
// A money-unknown state still comes before a known exhaustion: contradictory
// evidence is not a permission.
function statusOf(cand) {
  if (cand.reasons.some(r => HARD.includes(r))) return 'unsuitable';
  if (cand.reasons.some(r => !EXHAUSTED.includes(r))) return 'unknown';
  if (cand.reasons.some(r => EXHAUSTED.includes(r))) return 'exhausted';
  if (cand.qualified === true && cand.priceKnown === true) return 'available';
  return 'unknown';
}

// The decision function used by assign and by the operator bridge.
// candidates: [{ route, qualified, reasons, priceKnown, classRank?, cost? }]
// (closed grammar; no caller-side kind or canonical: both come from the
// tracked data only; classRank and cost are optional sufficiency facts from
// the catalog, used only for the minimal-sufficient subscription rule).
// context: { data, taskKind, farmRuns }. An absent or non-closed task kind is
// the unknown tier with caution (recorded in cautions), never a throw: the
// request stays valid and free routes stay no-measurement.
// Returns qualified candidates only in `ordered`, the kept-but-not-qualified
// ones with their status and reason in `unqualified`, and the exact reason for
// every refused one; deterministic, no writes.
function routeOrder(candidates, context) {
  const data = context && io.object(context) ? context.data : undefined;
  if (!io.object(data) || data.schema !== 'route-order/1' || data.enabled !== true) fail('route-order-disabled');
  const taskKind = context.taskKind === undefined || context.taskKind === null ? null : context.taskKind;
  const kindUnknown = !TASK_KINDS.includes(taskKind);
  const cautions = kindUnknown ? ['task-kind-unknown'] : [];
  // Caller-supplied data is validated, never trusted: an enabled override with
  // a corrupt shape fails with a recorded code, not a stray TypeError.
  try { validateData(data); } catch { fail('route-order-data-invalid'); }
  if (!Array.isArray(candidates)) fail('candidates-invalid');
  const farmRuns = context.farmRuns === undefined ? [] : context.farmRuns;
  if (!Array.isArray(farmRuns) || !farmRuns.every(r => io.object(r) && io.id(r.route) && io.id(r.taskClass) && typeof r.pass === 'boolean')) fail('farm-runs-invalid');
  const entries = new Map(data.routes.map(e => [e.route, e]));
  const items = candidates.map((c, index) => {
    io.fields(c, ['route', 'qualified', 'reasons', 'priceKnown', 'classRank', 'cost'], ['route', 'qualified', 'reasons', 'priceKnown']);
    const parts = splitRoute(c.route);
    if (!parts || typeof c.qualified !== 'boolean' || typeof c.priceKnown !== 'boolean'
        || !Array.isArray(c.reasons) || !c.reasons.every(r => typeof r === 'string')
        || !(c.classRank === undefined || c.classRank === null || Number.isSafeInteger(c.classRank) && c.classRank >= 0)
        || !(c.cost === undefined || c.cost === null || io.money(c.cost))) fail('candidate-invalid');
    const entry = entries.get(c.route) || null;
    const reasonInvalid = c.reasons.some(r => !/^[a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9-]+)?$/.test(r));
    return { index, route: c.route, kind: entry ? entry.kind : 'unknown', canonical: entry ? entry.canonical : null,
      farmRoute: entry && entry.farmRoute !== undefined ? entry.farmRoute : parts.client === 'farm' ? parts.model : null,
      priceKnown: c.priceKnown, classRank: c.classRank ?? null, cost: c.cost ?? null,
      reasonInvalid, status: reasonInvalid ? 'unsuitable' : statusOf(c) };
  });
  const pick = it => ({ index: it.index, route: it.route, kind: it.kind });
  const refused = [];
  // Stage 1 refusals: identity and capability. A row refused here never blocks a
  // more expensive kind (an incapable free route is not an available free route).
  const alive = [];
  for (const it of items) {
    if (it.reasonInvalid) { refused.push({ ...pick(it), reason: 'candidate-reason-invalid', blockedBy: null }); continue; }
    if (it.kind === 'unknown') { refused.push({ ...pick(it), reason: 'route-kind-unknown', blockedBy: null }); continue; }
    if (it.kind === 'free') {
      const cap = capability(data, farmRuns, it.farmRoute, taskKind);
      if (!cap.capable) { refused.push({ ...pick(it), reason: cap.reason, blockedBy: null }); continue; }
    }
    if (it.kind === 'aggregator' && it.priceKnown !== true) { refused.push({ ...pick(it), reason: 'aggregator-price-unknown', blockedBy: null }); continue; }
    if (it.kind === 'aggregator' && it.canonical === null) { refused.push({ ...pick(it), reason: 'aggregator-model-identity-unknown', blockedBy: null }); continue; }
    alive.push(it);
  }
  const block = (it, reason, blockedBy) => refused.push({ ...pick(it), reason, blockedBy });
  for (const it of alive) {
    if (it.kind === 'aggregator') {
      // Hard check: an aggregator is eligible only when no subscription and no
      // direct route of the same model is available; unknown is not exhausted.
      let done = false;
      for (const pass of ['available', 'unknown']) {
        for (const other of alive) {
          if (other.index === it.index || !['subscription', 'direct'].includes(other.kind) || other.canonical === null
              || other.canonical !== it.canonical || other.status !== pass) continue;
          block(it, `aggregator-while-${other.kind}-${pass}`, other.route);
          done = true;
          break;
        }
        if (done) break;
      }
      if (done) continue;
    }
    // Money ladder: a more expensive kind is refused while any cheaper kind has an
    // available candidate; an unknown cheaper candidate also refuses it (the
    // cheaper kind stays first and the reason says so). Exhausted and unsuitable
    // cheaper rows do not block.
    const cheaper = data.order.slice(0, data.order.indexOf(it.kind));
    let done = false;
    for (const statusPass of ['available', 'unknown']) {
      for (const kind of cheaper) {
        for (const other of alive) {
          if (other.kind !== kind || other.status !== statusPass) continue;
          block(it, `${it.kind}-while-${kind}-${statusPass}`, other.route);
          done = true;
          break;
        }
        if (done) break;
      }
      if (done) break;
    }
    if (done) continue;
  }
  const kept = alive.filter(it => !refused.some(f => f.index === it.index));
  const rank = kind => data.order.indexOf(kind);
  // Among kept subscriptions the MINIMUM NECESSARY AND SUFFICIENT
  // one leads: the least capable class that still satisfies the task tier
  // (the adapter already floored every kept row at that tier), then the
  // cheapest of that class, then the incoming order. Rows without sufficiency
  // facts cannot prove minimality and sort after the ranked ones.
  const unranked = it => it.classRank === null || it.cost === null;
  kept.sort((a, b) => {
    if (a.kind !== b.kind) return rank(a.kind) - rank(b.kind);
    if (a.kind === 'subscription') {
      const byFacts = Number(unranked(a)) - Number(unranked(b));
      if (byFacts) return byFacts;
      if (a.classRank !== null && b.classRank !== null && a.classRank !== b.classRank) return a.classRank - b.classRank;
      if (a.cost !== null && b.cost !== null) { const byCost = D.cmp(D.parse(a.cost), D.parse(b.cost)); if (byCost) return byCost; }
    }
    return a.index - b.index;
  });
  // `ordered` carries qualified candidates ONLY; a direct consumer can never
  // resurrect a reviewer-role or independence exclusion. Kept rows that are not
  // qualified stay visible as `unqualified` annotations with their status.
  const ordered = [], unqualified = [];
  let minimalSub = null;
  for (const it of kept) {
    if (it.status !== 'available') {
      unqualified.push({ index: it.index, route: it.route, kind: it.kind, status: it.status, reason: ANNOTATED[it.status](it.kind) });
      continue;
    }
    let reason = KEPT[it.kind];
    if (it.kind === 'subscription') {
      if (minimalSub === null && !unranked(it)) minimalSub = it.index;
      reason = it.index === minimalSub ? KEPT.subscription : KEPT_ALTERNATIVE;
    }
    ordered.push({ index: it.index, route: it.route, kind: it.kind, reason });
  }
  return { schema: 'route-order-decision/1', order: data.order.slice(), taskKind: kindUnknown ? null : taskKind, cautions,
    ordered, unqualified,
    refused: refused.map(f => ({ index: f.index, route: f.route, kind: f.kind, reason: f.reason, blockedBy: f.blockedBy })) };
}

module.exports = { routeOrder, loadRouteOrderData, loadFarmRuns, capability, validateData, KINDS, TASK_KINDS };

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const io = require('./io.cjs');
const D = require('../../.ai/bin/accounting/lib/decimal.cjs');
const { VERDICTS } = require('./complexity.cjs');
const KEYS = ['schema', 'eventId', 'assignmentId', 'machine', 'tier', 'role', 'event', 'assigned', 'actual', 'rounds', 'verdicts', 'wallSeconds', 'tokens', 'costUsd', 'handOverride', 'routeKind', 'routeOrderReason', 'reason', 'failureReason'];
// 'reason' and 'failureReason' are optional and the only added keys: a
// deviation reason written by the operator kit, and the bounded failure reason
// of a seat that ended without a verdict. Old rows without
// them stay valid; required keys are unchanged. A row written without them
// never gains the keys on disk: an old-caller row keeps the base bytes exactly
const REQUIRED = KEYS.filter(k => !['routeKind', 'routeOrderReason', 'reason', 'failureReason'].includes(k));
const ROUTE_KINDS = ['free', 'subscription', 'direct', 'aggregator', 'unknown'];
const ORDER_REASON = /^[a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9-]+)?$/;
const orderFields = (v, label) => {
  if (v.routeKind !== undefined && (!ROUTE_KINDS.includes(v.routeKind))) io.fail(`${label}-route-kind-invalid`);
  if (v.routeOrderReason !== undefined && (typeof v.routeOrderReason !== 'string' || !ORDER_REASON.test(v.routeOrderReason))) io.fail(`${label}-order-reason-invalid`);
};
const machineOf = v => { if (typeof v !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(v)) io.fail('machine-invalid'); return v; };
// The shared free-text decision replaces a lone surrogate instead of refusing
// it, so its result must equal the input: a string the decision would change
// is refused here, before any row or record exists, and the source bytes are
// never silently rewritten (round 13, OP-AUTO-05).
function unchanged(value) {
  if (!value.isWellFormed() || io.operatorText(value) !== value) io.fail('feedback-reason-invalid');
}
function validate(e) {
  io.fields(e, KEYS, REQUIRED); io.publicValue(e); machineOf(e.machine);
  if (e.reason !== undefined && e.reason !== null && (typeof e.reason !== 'string' || !e.reason.trim() || e.reason.length > 300 || /[\u0000-\u001f\u007f]/.test(e.reason))) io.fail('feedback-reason-invalid');
  // The same explicit invisible/bidi/NFC decision the strict file decoder makes:
  // a poisoned row must never reach the log, where every later reader would
  // refuse the whole file.
  if (e.reason !== undefined && e.reason !== null) { try { io.operatorText(e.reason); } catch { io.fail('feedback-reason-invalid'); } }
  if (e.reason !== undefined && e.reason !== null) unchanged(e.reason);
  // The bounded failure reason of a seat that ended without a verdict follows
  // the same rule.
  if (e.failureReason !== undefined && e.failureReason !== null && (typeof e.failureReason !== 'string' || !e.failureReason.trim() || e.failureReason.length > 60 || /[\u0000-\u001f\u007f]/.test(e.failureReason))) io.fail('feedback-reason-invalid');
  if (e.failureReason !== undefined && e.failureReason !== null) { try { io.operatorText(e.failureReason); } catch { io.fail('feedback-reason-invalid'); } }
  if (e.failureReason !== undefined && e.failureReason !== null) unchanged(e.failureReason);
  if (e.schema !== 'assign-feedback/1' || !io.id(e.eventId) || !io.id(e.assignmentId) || !/^T[1-9]$/.test(e.tier)
      || !['author', 'fixer', 'pre-reviewer', 'certifier', 'operator'].includes(e.role) || !['assignment', 'outcome'].includes(e.event)) io.fail('feedback-invalid');
  for (const r of [e.assigned, e.actual]) if (r !== null) {
    io.fields(r, ['client', 'model', 'effort', 'routeKind', 'routeOrderReason'], ['client', 'model', 'effort']);
    if (!io.id(r.client) || !io.id(r.model) || !['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(r.effort)) io.fail('feedback-route-invalid');
    orderFields(r, 'feedback-route');
  }
  orderFields(e, 'feedback');
  if (!Array.isArray(e.verdicts) || !e.verdicts.every(v => VERDICTS.includes(v)) || !(e.rounds === null || io.count(e.rounds))
      || !(e.wallSeconds === null || typeof e.wallSeconds === 'number' && Number.isFinite(e.wallSeconds) && e.wallSeconds >= 0)
      || !(e.costUsd === null || io.money(e.costUsd)) || !(e.handOverride === null || typeof e.handOverride === 'boolean')) io.fail('feedback-metrics-invalid');
  if (e.tokens !== null) { io.fields(e.tokens, ['input', 'output'], ['input', 'output']); if (!io.count(e.tokens.input) || !io.count(e.tokens.output)) io.fail('feedback-tokens-invalid'); }
  return e;
}
function read(root, machine) {
  const file = `feedback-${machineOf(machine)}.jsonl`, g = io.guard(root, file);
  if (!g.exists) return { events: [], invalidRows: 0, conflicts: 0, text: '' };
  // Decode whole text strictly; tolerate malformed individual JSON/schema rows.
  const raw = io.readText(root, file, 32 * 1024 * 1024, 'report'), byId = new Map(), conflicted = new Set(); let invalidRows = 0;
  const lines = raw.split('\n');
  // A last unterminated row is never a committed event, even when its JSON parses.
  if (raw && !raw.endsWith('\n')) { lines.pop(); invalidRows++; }
  for (const line of lines) {
    if (!line) continue;
    try {
      const e = validate(require('../../.ai/bin/lib/text-safe.cjs').parseJsonUnique(line));
      if (e.machine !== machine) io.fail('feedback-machine-conflict');
      if (byId.has(e.eventId) && io.canonical(byId.get(e.eventId)) !== io.canonical(e)) conflicted.add(e.eventId);
      else byId.set(e.eventId, e);
    } catch { invalidRows++; }
  }
  return { events: [...byId.values()].filter(e => !conflicted.has(e.eventId)), invalidRows, conflicts: conflicted.size, text: raw };
}
// A disposable `.ai/runtime` feedback root is refused from the resolved path
// string alone, before any directory exists. The rule is shared with the
// operator bridge, so a disposable root is never created only to be refused
function refuseDisposableRoot(root) {
  const parts = path.resolve(root).split(path.sep).map(p => p.toLowerCase());
  if (parts.some((p, i) => p === '.ai' && parts[i + 1] === 'runtime')) io.fail('durable-root-required');
}
function validateAppendState(state, event, locked = true) {
  io.publicValue(state.text);
  // Invalid rows and unfinished tails remain historical bytes. Inspect every
  // decoded JSON string token too: escaped private values must not evade the
  // tolerant row reader, including duplicate keys and malformed containers.
  for (const token of state.text.match(/"(?:[^"\\]|\\[\s\S])*(?:"|$)/g) || []) {
    let decoded;
    try { decoded = JSON.parse(token.endsWith('"') ? token : token + '"'); }
    catch {
      // A damaged string can still contain a fully encoded private prefix.
      // Decode its valid escape atoms without repairing or publishing the row.
      decoded = token.replace(/\\(?:u[0-9a-fA-F]{4}|["\\/bfnrt])/g, escape => JSON.parse('"' + escape + '"'));
    }
    io.publicValue(decoded);
  }
  if (locked && state.conflicts) io.fail('feedback-conflict');
  const previous = state.events.find(e => e.eventId === event.eventId);
  if (previous) { if (io.canonical(previous) !== io.canonical(event)) io.fail('feedback-conflict'); return { ok: true, duplicate: true }; }
  return null;
}
function preflightBatch(root, events) {
  if (!Array.isArray(events) || !events.length) io.fail('feedback-invalid');
  for (const event of events) validate(event);
  const machine = events[0].machine;
  if (events.some(event => event.machine !== machine)) io.fail('feedback-machine-conflict');
  refuseDisposableRoot(root);
  const rootState = io.guard(path.parse(path.resolve(root)).root, path.resolve(root), true);
  const state = rootState.exists ? read(root, machine) : { events: [], invalidRows: 0, conflicts: 0, text: '' };
  const pending = [], results = [];
  // Build the complete resulting state in memory. This includes collisions
  // between events of this same request, not only collisions with old rows.
  const planned = { ...state, events: [...state.events] };
  for (const event of events) {
    const duplicate = validateAppendState(planned, event);
    results.push(duplicate || { ok: true, duplicate: false });
    if (!duplicate) { pending.push(event); planned.events.push(event); }
  }
  return { state, pending, results, machine };
}
function appendBatch(root, events) {
  preflightBatch(root, events);
  io.guard(root, root, true);
  const lock = path.join(root, 'feedback.lock'); io.guard(root, lock);
  try { fs.mkdirSync(lock); } catch (e) { io.fail(e.code === 'EEXIST' ? 'feedback-busy' : 'feedback-lock-failed'); }
  const lockId = fs.lstatSync(lock, { bigint: true });
  try {
    const { state, pending, results, machine } = preflightBatch(root, events);
    if (!pending.length) return results;
    const file = path.join(root, `feedback-${machine}.jsonl`);
    // The lock spans read + atomic publish. Every cooperating machine shares it.
    const locked = io.guard(root, lock);
    const current = fs.lstatSync(locked.real, { bigint: true });
    if (current.ino !== lockId.ino || current.dev !== lockId.dev) io.fail('feedback-lock-changed');
    // Preserve the damaged tail as a separate invalid row; never join new bytes to it.
    io.writeText(root, file, state.text + (state.text && !state.text.endsWith('\n') ? '\n' : '') + pending.map(event => JSON.stringify(event) + '\n').join(''));
    return results;
  } finally {
    io.guard(root, lock);
    const current = fs.lstatSync(lock, { bigint: true });
    if (current.ino !== lockId.ino || current.dev !== lockId.dev) io.fail('feedback-lock-changed');
    const retired = path.join(root, `feedback-retired-${crypto.randomBytes(16).toString('hex')}`);
    io.guard(root, retired); fs.renameSync(lock, retired);
  }
}
function append(root, event) { return appendBatch(root, [event])[0]; }
function report(root, machine) {
  const state = read(root, machine), groups = new Map();
  // Route identity is the closed structured key [client, model, effort],
  // never a joined string: "a" + "b:c" and "a:b" + "c" are DIFFERENT routes
  // routeKind and routeOrderReason are cost-record
  // annotations that only the assignment event carries, so they never take
  // part in the identity.
  const routeKey = r => io.canonical([r.client, r.model, r.effort]);
  for (const e of state.events) {
    const key = `${e.tier}:${e.role}`;
    if (!groups.has(key)) groups.set(key, { tier: e.tier, role: e.role, assignments: 0, outcomes: 0, sameRoute: 0, changedRoute: 0, unknownRoute: 0,
      handOverrides: 0, unknownOverrides: 0, knownCostUsd: '0', costUsd: null, unknownCosts: 0, knownWallSeconds: 0, unknownWallTimes: 0, assigned: {}, actual: {} });
    const g = groups.get(key);
    const bump = (map, r) => { if (r) { const id = routeKey(r); map[id] = (map[id] || 0) + 1; } };
    if (e.event === 'assignment') { g.assignments++; bump(g.assigned, e.assigned); }
    else {
      g.outcomes++; bump(g.actual, e.actual);
      if (!e.assigned || !e.actual) g.unknownRoute++;
      else if (routeKey(e.assigned) === routeKey(e.actual)) g.sameRoute++;
      else g.changedRoute++;
      if (e.handOverride === true) g.handOverrides++; else if (e.handOverride === null) g.unknownOverrides++;
      if (e.costUsd === null) g.unknownCosts++; else g.knownCostUsd = D.toString(D.add(D.parse(g.knownCostUsd), D.parse(e.costUsd)));
      if (e.wallSeconds === null) g.unknownWallTimes++; else g.knownWallSeconds += e.wallSeconds;
    }
    g.costUsd = g.outcomes && !g.unknownCosts ? g.knownCostUsd : null;
  }
  return io.publicValue({ schema: 'assign-feedback-report/1', machine, invalidRows: state.invalidRows, conflicts: state.conflicts, rows: [...groups.values()].sort((a, b) => `${a.tier}:${a.role}`.localeCompare(`${b.tier}:${b.role}`, 'en')) });
}
// `ids` (optional) carries one assignment id per seat: the operator kit launches
// seats one at a time, so the identity of a recorded assignment must be the
// SEAT's, not the attempt's, or the second seat of the same attempt is silently
// deduplicated away. Without ids the historical per-index identity
// of the standalone CLI is unchanged.
function assignmentEvents(assignment, machine, ids) {
  io.publicValue(assignment);
  if (assignment.schema !== 'assignment/1' || !Array.isArray(assignment.assignments)) io.fail('assignment-invalid');
  const seats = assignment.assignments.length ? assignment.assignments : [null];
  if (ids !== undefined && (!Array.isArray(ids) || ids.length !== seats.length || !ids.every(io.id))) io.fail('assignment-invalid');
  const pending = [];
  seats.forEach((r, i) => {
    const seatId = ids === undefined ? `${assignment.assignmentId}-${i}` : ids[i];
    pending.push({ schema: 'assign-feedback/1', eventId: `assigned-${seatId}`, assignmentId: seatId,
    machine, tier: assignment.tier, role: assignment.role, event: 'assignment',
    assigned: r ? { client: r.client, model: r.model, effort: r.effort,
      ...(r.routeKind !== undefined ? { routeKind: r.routeKind, routeOrderReason: r.routeOrderReason } : {}) } : null, actual: null, rounds: null, verdicts: [], wallSeconds: null,
    tokens: null, costUsd: null, handOverride: null });
  });
  // Validate the whole batch before the first append; a later deterministic
  // refusal must not leave an earlier seat recorded.
  for (const event of pending) validate(event);
  return pending;
}
function recordAssignment(root, assignment, machine, ids) {
  appendBatch(root, assignmentEvents(assignment, machine, ids));
}
function deviationEvent(seatAssignmentId, tier, role, machine, recommended, actual, reason) {
  return validate({ schema: 'assign-feedback/1', eventId: `deviation-${seatAssignmentId}`,
    assignmentId: seatAssignmentId, machine, tier, role, event: 'outcome',
    assigned: { client: recommended.client, model: recommended.model, effort: recommended.effort },
    actual: { client: actual.client, model: actual.model, effort: actual.effort },
    rounds: null, verdicts: [], wallSeconds: null, tokens: null, costUsd: null, handOverride: true, reason });
}
function recordOutcome(root, assignmentId, machine, outcome) {
  io.fields(outcome, ['actual', 'rounds', 'verdicts', 'wallSeconds', 'tokens', 'costUsd', 'handOverride', 'reason', 'failureReason'], ['actual', 'rounds', 'verdicts', 'wallSeconds', 'tokens', 'costUsd', 'handOverride']);
  const records = read(root, machine);
  if (records.conflicts) io.fail('feedback-conflict');
  const base = records.events.find(e => e.event === 'assignment' && e.assignmentId === assignmentId);
  if (!base) io.fail('assignment-not-recorded');
  return append(root, { ...base, ...outcome, event: 'outcome', eventId: 'outcome-' + io.hash({ assignmentId, outcome }) });
}
function main(argv) {
  try {
    if (argv.length !== 3 || !['append', 'report'].includes(argv[0])) io.fail('usage');
    const root = path.resolve(argv[1]);
    const result = argv[0] === 'report' ? report(root, argv[2]) : append(root, io.readJson(path.dirname(path.resolve(argv[2])), path.resolve(argv[2])));
    process.stdout.write(JSON.stringify(result, null, 2) + '\n'); return 0;
  } catch { process.stderr.write('Assignment feedback refused; content withheld\n'); return 2; }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { append, appendBatch, preflightBatch, assignmentEvents, deviationEvent, read, report, validate, main, recordAssignment, recordOutcome, refuseDisposableRoot };

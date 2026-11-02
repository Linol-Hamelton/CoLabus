'use strict';
// measure.cjs - the ONE place where a launch pair becomes measurements (the route state,
// closed construction for the measurement class; PROTO-DEC-0216, PROTO-DEC-0227).
//
//   measureLaunch(pair) -> { client, model, duration, tokens, verdicts, outcome, reasons }
//
// pair is one launch of the kernel join (launch-stats.cjs launches(): start, fin, fins, reviews). Every
// field the function uses passes the one normalization (route-state.cjs normalizeValue) WITH its
// provenance, and is declared in READS. A field that is absent, unknown, partial, out of range or
// invalid makes ITS measure null with a named reason; it never becomes a number and never changes another
// measure. An absent or unknown value falls back to the next record exactly where the kernel reader falls
// back (wallOf, exitOf, tokensOf); a present value that the grammar refuses never falls back, so an
// invalid field can never be replaced by a neighbour's number. outcome is 'measured' only when at least
// one measure is a number from fully valid inputs; else 'invalid' when a reason is invalid; else 'unknown'.
//
// performanceOf (refresh.cjs) and every other caller use only this result; no caller reads a raw record
// field for a number. The property test of the stage-1 file generates its cases from READS: a read of a
// field that READS does not name throws here, and a field in READS without a row in the test's class
// table fails the completeness test.

const rs = require('./route-state.cjs');

// The declared reads, as role.path. Provenance reads (backfilled, confidence.<field>) are reads too.
const TOKEN_READS = role => [
  `${role}.tokens`, `${role}.tokens.*`, `${role}.tokens.source`, `${role}.tokens.note`, `${role}.tokens.total`,
  ...rs.TOKEN_PARTS.map(part => `${role}.tokens.${part}`),
];
const READS = Object.freeze([
  'start.tuple', 'start.tuple.client', 'start.tuple.model',
  'start.exitCode', 'start.wallSeconds', 'start.startedAt', 'start.startedAtNote', 'start.endedAt', 'start.endedAtNote',
  ...TOKEN_READS('start'),
  'start.backfilled', 'start.confidence', 'start.confidence.client', 'start.confidence.model',
  'start.confidence.exitCode', 'start.confidence.wallSeconds', 'start.confidence.tokens',
  'fin.exitCode', 'fin.wallSeconds', 'fin.endedAt', 'fin.endedAtNote',
  ...TOKEN_READS('fin'),
  'fin.backfilled', 'fin.confidence', 'fin.confidence.exitCode', 'fin.confidence.wallSeconds', 'fin.confidence.endedAt', 'fin.confidence.tokens',
  'review.reviewOutcome', 'review.backfilled', 'review.confidence', 'review.confidence.reviewOutcome',
]);
const DECLARED = new Set(READS);

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// One field of one record through the one normalization:
//   absent   the field is missing or a legacy null (kernel: an unknown base value); a null backfilled
//            flag is not absent but unknown (nullIsAbsent false)
//   unknown  the provenance makes it unknown, or the grammar names it unknown
//   invalid  the grammar refuses it (detail names why)
//   value    the normalized value
function read(role, rec, name, kind, withProvenance = true, nullIsAbsent = true) {
  if (!DECLARED.has(`${role}.${name}`)) throw new Error(`measure.cjs reads ${role}.${name}, which READS does not declare`);
  if (!Object.hasOwn(rec, name) || (nullIsAbsent && rec[name] === null)) return { state: 'absent' };
  const norm = rs.normalizeValue(kind, rec[name], withProvenance ? { record: rec, field: name } : undefined);
  if (norm.problem) return { state: 'invalid', detail: `${name} ${norm.problem}` };
  if (norm.unknown) return { state: 'unknown', detail: norm.unknown };
  return { state: 'value', value: norm.value };
}

function reason(reasons, measure, code, kind, rec, detail) {
  reasons.push({ measure, code, kind, rec, detail });
  return null;
}

function attribution(start, field, reasons) {
  if (!DECLARED.has('start.tuple')) throw new Error('measure.cjs reads start.tuple, which READS does not declare');
  if (!isPlain(start.tuple)) return reason(reasons, field, 'ATTRIBUTION', 'invalid', start, 'the start record names no tuple object');
  if (!DECLARED.has(`start.tuple.${field}`)) throw new Error(`measure.cjs reads start.tuple.${field}, which READS does not declare`);
  if (!Object.hasOwn(start.tuple, field) || start.tuple[field] === null) return reason(reasons, field, 'ATTRIBUTION', 'unknown', start, `the tuple names no ${field}`);
  const norm = rs.normalizeValue(field === 'client' ? 'launchClient' : 'attribution', start.tuple[field], { record: start, field });
  if (norm.problem) return reason(reasons, field, 'ATTRIBUTION', 'invalid', start, `tuple.${field} ${norm.problem}`);
  if (norm.unknown) return reason(reasons, field, 'ATTRIBUTION', 'unknown', start, norm.unknown);
  return norm.value;
}

// The exit code (kernel exitOf): the finished record's, else the start's. Only a success has a duration
// (kernel summarize: walls of the launches whose exit is 0).
function exitOf(pair, reasons) {
  for (const [role, rec] of [['fin', pair.fin], ['start', pair.start]]) {
    if (!rec) continue;
    const f = read(role, rec, 'exitCode', 'exitCode');
    if (f.state === 'invalid') return { invalid: reason(reasons, 'duration', 'EXIT_CODE', 'invalid', rec, f.detail) };
    if (f.state === 'value') return { value: f.value, rec };
  }
  return { value: null };
}

function durationOf(pair, reasons) {
  const { start, fin } = pair;
  const exit = exitOf(pair, reasons);
  if (Object.hasOwn(exit, 'invalid')) return null;
  if (exit.value === null) return reason(reasons, 'duration', 'EXIT_UNKNOWN', 'unknown', start, 'the launch names no usable exit code');
  if (exit.value !== 0) return reason(reasons, 'duration', 'EXIT_NONZERO', 'excluded', exit.rec, 'only a successful launch has a duration');
  // The wall time itself (kernel wallOf): the start's, else the finished record's.
  for (const [role, rec] of [['start', start], ['fin', fin]]) {
    if (!rec) continue;
    const f = read(role, rec, 'wallSeconds', 'seconds');
    if (f.state === 'invalid') return reason(reasons, 'duration', 'WALL_SECONDS', 'invalid', rec, f.detail);
    if (f.state === 'value') return f.value;
  }
  // Else derived from two instants written exactly (kernel wallOf): no approximate-time note, a start that
  // is not backfilled, the end of the finished record, else the start's own end.
  const backfilled = read('start', start, 'backfilled', 'backfilled', false, false);
  if (backfilled.state === 'invalid') return reason(reasons, 'duration', 'WALL_SECONDS', 'invalid', start, backfilled.detail);
  if (backfilled.state === 'unknown' || backfilled.value === true) return reason(reasons, 'duration', 'DERIVATION_BACKFILLED', 'unknown', start, 'a duration is never derived from a backfilled or unknown start');
  const notes = [['start', start, 'startedAtNote'], ['start', start, 'endedAtNote'], ...(fin ? [['fin', fin, 'endedAtNote']] : [])];
  for (const [role, rec, name] of notes) {
    const f = read(role, rec, name, 'note', false);
    if (f.state === 'invalid') return reason(reasons, 'duration', 'TIME_NOTE', 'invalid', rec, f.detail);
    if (f.state === 'value') return reason(reasons, 'duration', 'TIME_APPROXIMATE', 'unknown', rec, `${name} marks the time as approximate`);
  }
  const begin = read('start', start, 'startedAt', 'isoTime');
  if (begin.state === 'invalid') return reason(reasons, 'duration', 'STARTED_AT', 'invalid', start, begin.detail);
  if (begin.state !== 'value') return reason(reasons, 'duration', 'STARTED_AT', 'unknown', start, begin.detail || 'the launch names no start time');
  let end = { state: 'absent' };
  let endRec = start;
  for (const [role, rec] of [['fin', fin], ['start', start]]) {
    if (!rec) continue;
    end = read(role, rec, 'endedAt', 'isoTime');
    endRec = rec;
    if (end.state === 'value' || end.state === 'invalid') break;
  }
  if (end.state === 'invalid') return reason(reasons, 'duration', 'ENDED_AT', 'invalid', endRec, end.detail);
  if (end.state !== 'value') return reason(reasons, 'duration', 'ENDED_AT', 'unknown', start, end.detail || 'the launch names no end time');
  const seconds = (end.value - begin.value) / 1000;
  if (seconds < 0) return reason(reasons, 'duration', 'DURATION_ORDER', 'invalid', start, 'the end time is before the start time');
  if (seconds === 0) return reason(reasons, 'duration', 'DURATION_ZERO', 'unknown', start, 'the end time equals the start time (the kernel derives no duration)');
  const norm = rs.normalizeValue('seconds', seconds);
  if (norm.problem) return reason(reasons, 'duration', 'WALL_SECONDS', 'invalid', start, `the duration of the launch ${norm.problem}`);
  return norm.value;
}

// The token count (kernel tokensOf): the first record of finished, every finished line, start that names
// a total. A count object without a total is unknown and falls through, as in the kernel; an invalid one
// stops the measure.
function tokensOf(pair, reasons) {
  const records = [];
  for (const [role, rec] of [['fin', pair.fin], ...(pair.fins || []).map(f => ['fin', f]), ['start', pair.start]]) {
    if (rec && !records.some(([, seen]) => seen === rec)) records.push([role, rec]);
  }
  let detail = 'no record names a usable token count';
  for (const [role, rec] of records) {
    const f = read(role, rec, 'tokens', 'tokens');
    if (f.state === 'invalid') return reason(reasons, 'tokens', 'TOKENS', 'invalid', rec, f.detail);
    if (f.state === 'value' && f.value !== null) return f.value;
    if (f.detail) detail = f.detail;
  }
  return reason(reasons, 'tokens', 'TOKENS_UNKNOWN', 'unknown', pair.start, detail);
}

// The review outcomes of the launch: one entry per review whose outcome is in the closed enum.
function verdictsOf(pair, reasons) {
  const verdicts = [];
  for (const review of pair.reviews || []) {
    const f = read('review', review, 'reviewOutcome', 'outcome');
    if (f.state === 'invalid') reason(reasons, 'verdict', 'REVIEW_OUTCOME', 'invalid', review, f.detail);
    else if (f.state === 'value') verdicts.push(f.value);
    else reason(reasons, 'verdict', 'REVIEW_OUTCOME', 'unknown', review, f.detail || 'the review names no outcome');
  }
  return verdicts;
}

function measureLaunch(pair) {
  const reasons = [];
  const client = attribution(pair.start, 'client', reasons);
  const model = attribution(pair.start, 'model', reasons);
  const duration = durationOf(pair, reasons);
  const tokens = tokensOf(pair, reasons);
  const verdicts = verdictsOf(pair, reasons);
  const measured = duration !== null || tokens !== null || verdicts.length > 0;
  const outcome = measured ? 'measured' : reasons.some(r => r.kind === 'invalid') ? 'invalid' : 'unknown';
  return { client, model, duration, tokens, verdicts, outcome, reasons };
}

module.exports = { READS, measureLaunch };

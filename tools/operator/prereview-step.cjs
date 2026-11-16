'use strict';
// prereview-step.cjs - the L2 early review step contract (PROTO-DEC-0234 Q4/G8;
// guarantee G4). A pure data module: no fs, no network, no Date, no
// child process, no environment read. It is the contract between the landing procedure text
// (P-L2-012) and the existing PREREVIEW tool (tools/operator/prereview.cjs), which it does not
// modify and never calls.
//
// The step runs after the author's local checks on the author's candidate SHA and before the
// sealed independent certification. It REUSES PREREVIEW's usable rule, scanner and JSON
// advisory: the input here is the advisory summary that tools/operator/prereview.cjs already
// returned (runReview -> { usable, refused, failed, ok, sends, files, advisoryError, truncated,
// skipped }); this module maps that summary to one explicit outcome. It adds no new call from
// landing or launchers, no activation, no new sender and no new admission gate.
//
// The classifier is ONE ordered table of rules (RULE_ORDER + RULE_CONDITIONS below). Each rule
// names the condition it reads on the NORMALIZED summary and the skip outcome it produces; the
// first rule whose condition holds wins, and the fallback after the table is the advisory
// outcome. The order is the point of the contract and is justified here:
//   1. SECRET_REFUSED first: the secret scanner refused the assembled request before anything
//      was sent, so no review was ever produced; it is reported before every other reason.
//   2. INCOMPLETE_DIFF: a review of a truncated or partially skipped diff covers a prefix, not
//      the change, whatever the routes returned; it is reported before the route reasons.
//   3. NO_KEY before TIMEOUT: a missing key is a fixed local refusal, reported before the
//      timeout that only a sent request can reach.
//   4. TIMEOUT: a sent request exceeded the whole-request deadline.
//   5. NO_USABLE_FREE_ROUTE: the fallback when there was no usable free route at all, or every
//      attempted route failed with a reason that has no code of its own.
//   When ok >= 1 (at least one route answered), none of the route-failure rules (3, 4) fire and
//   the outcome is advisory: the review of the routes that answered is kept, with the failed
//   routes listed in the coverage, never discarded because another route failed.

const ADVISORY_SCHEMA = 'prereview-step/1';
const ADVISORY_MODE = 'READ-ONLY ADVISORY';
// A candidate SHA is a full object id (the same closed grammar PREREVIEW resolves a base to).
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// The skip codes of PROTO-DEC-0234 Q4. Each is an explicit outcome with a reason; the
// ordinary independent certification goes on without a paid fallback.
const SKIP_CODES = ['NO_USABLE_FREE_ROUTE', 'SECRET_REFUSED', 'NO_KEY', 'TIMEOUT', 'INCOMPLETE_DIFF'];

// The certification step keeps its seats (TIER 3 of PROTO-DEC-0232: three independent
// certifiers). The early review step is advisory and never adds or removes a seat.
const CERTIFIER_SEATS = 3;

const SKIP_REASONS = {
  NO_USABLE_FREE_ROUTE: 'no usable free route exists for the early review (usable free=0, or every attempted route failed with no coded reason); the ordinary independent certification goes on without a paid fallback',
  SECRET_REFUSED: 'the assembled request body matched the shared secret scanner and the send was refused; the matched value is not reproduced here',
  NO_KEY: 'the route key environment variable is missing; the send was refused before any request left the machine',
  TIMEOUT: 'the request exceeded the whole-request deadline and the route is marked failing until a new probe of that route succeeds',
  INCOMPLETE_DIFF: 'the review input is not the complete diff (truncated at the byte budget, or files were skipped with a stated reason); the review covers only a prefix',
};

// Reason codes have a CLOSED form, matched exactly, never by prefix: NO_KEY is the fixed
// two-token code "NO_KEY: <ENV_NAME>" (the environment variable name matches the registry
// grammar /^[A-Z][A-Z0-9_]*$/), so "NO_KEYSTONE" is not a NO_KEY and is never mapped to it.
const NO_KEY_REASON = /^NO_KEY: [A-Z][A-Z0-9_]*$/;
const TIMEOUT_REASON = 'TIMEOUT';

// The ONE ordered list of the classifier. Each name is a SKIP_CODE; the predicates live in
// RULE_CONDITIONS keyed by the same name. The order is the contract (see the header): secret
// refused before anything is sent, then the incomplete diff, then a missing key, then a
// timeout, then the no-usable-free-route fallback. The first matching rule wins.
const RULE_ORDER = ['SECRET_REFUSED', 'INCOMPLETE_DIFF', 'NO_KEY', 'TIMEOUT', 'NO_USABLE_FREE_ROUTE'];

const RULE_CONDITIONS = {
  SECRET_REFUSED: s => s.sends.some(x => x && x.state === 'refused'),
  INCOMPLETE_DIFF: s => s.incomplete === true,
  NO_KEY: s => s.ok === 0 && s.sends.some(x => x && x.state === 'failed' && NO_KEY_REASON.test(x.reason)),
  TIMEOUT: s => s.ok === 0 && s.sends.some(x => x && x.state === 'failed' && x.reason === TIMEOUT_REASON),
  NO_USABLE_FREE_ROUTE: s => s.usable === 0 || s.ok === 0,
};

// The ONE table of rules, derived from the order and the predicates above. Each rule is data:
// the code of the skip it produces and the predicate over the normalized summary.
const RULES = RULE_ORDER.map(code => ({ code, when: RULE_CONDITIONS[code] }));

// Every outcome shares the advisory shape: schema, candidate SHA, advisory flag, the
// READ-ONLY ADVISORY mode, the constant verdict null and the coverage. A skip adds a state, a
// code and a reason; an advisory outcome adds the state only.
function base(candidateSha, coverage) {
  return { schema: ADVISORY_SCHEMA, candidateSha, advisory: true, mode: ADVISORY_MODE, verdict: null, coverage };
}

function skip(code, candidateSha, coverage) {
  return { ...base(candidateSha, coverage), state: 'skipped', code, reason: SKIP_REASONS[code] };
}

function advisory(candidateSha, coverage) {
  return { ...base(candidateSha, coverage), state: 'advisory' };
}

// ONE normalization function. It turns the runReview summary into the classifier's input, and
// it is the ONLY place that judges the summary. A counter that is NaN, Infinity, negative or
// fractional is NOT coerced into a number: the summary is invalid with a named reason. A
// missing summary or a missing counter stays explicitly missing (invalid), never a silent zero.
// The summary separates the fixed-policy non-review-input
// exclusions (policyExcluded, never reviewed by design) from the review-input skips (skipped:
// binary, oversize, submodule, invalid-utf8). Only a review-input skip or a truncated diff
// makes the diff incomplete. A malformed field (a sends entry, files, truncated,
// advisoryError, skipped, policyExcluded) is invalid with a named reason, never silently
// dropped. The route counters must describe the sends list truthfully, and an advisory
// outcome must have persisted at least one advisory file without a write error.
function describeCount(value) {
  if (value === undefined) return 'missing';
  if (value === null) return 'null';
  if (typeof value !== 'number') return `a ${typeof value}`;
  if (Number.isNaN(value)) return 'NaN';
  if (!Number.isFinite(value)) return 'Infinity';
  if (!Number.isInteger(value)) return `a fractional number (${value})`;
  return `negative (${value})`;
}

const SEND_STATES = ['ok', 'failed', 'refused'];

// A skip or policy-exclusion list is an array of { path: string, reason: string } entries; a
// non-array or a malformed entry returns null (invalid), never a silently filtered list.
function readSkipList(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) return null;
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
    if (typeof entry.path !== 'string' || typeof entry.reason !== 'string') return null;
  }
  return value;
}

function normalizeSummary(review) {
  if (review === null || review === undefined) {
    return { ok: false, reason: 'the review summary is missing and stays explicitly missing, never coerced to zero counters' };
  }
  if (typeof review !== 'object' || Array.isArray(review)) {
    return { ok: false, reason: 'the review summary must be an object' };
  }
  const counters = {};
  for (const key of ['usable', 'refused', 'failed', 'ok']) {
    const value = review[key];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
      return { ok: false, reason: `the ${key} counter is ${describeCount(value)}; a counter must be a non-negative safe integer and is never coerced to a number` };
    }
    counters[key] = value;
  }
  if (!Array.isArray(review.sends)) {
    return { ok: false, reason: 'the sends list must be an array; a missing result stays explicitly missing' };
  }
  let refused = 0;
  let failed = 0;
  let ok = 0;
  for (const send of review.sends) {
    if (!send || typeof send !== 'object' || Array.isArray(send)
      || typeof send.id !== 'string'
      || !SEND_STATES.includes(send.state)
      || (send.reason !== undefined && send.reason !== null && typeof send.reason !== 'string')) {
      return { ok: false, reason: 'every sends entry must be an object with a string id, a state of ok, failed or refused, and a string or null reason' };
    }
    if (send.state === 'refused') refused += 1;
    else if (send.state === 'failed') failed += 1;
    else ok += 1;
  }
  if (counters.refused !== refused) {
    return { ok: false, reason: `the refused counter (${counters.refused}) does not match the sends list (${refused} refused send(s)); a contradictory summary is invalid` };
  }
  if (counters.failed !== failed) {
    return { ok: false, reason: `the failed counter (${counters.failed}) does not match the sends list (${failed} failed send(s)); a contradictory summary is invalid` };
  }
  if (counters.ok !== ok) {
    return { ok: false, reason: `the ok counter (${counters.ok}) does not match the sends list (${ok} ok send(s)); a contradictory summary is invalid` };
  }
  if (counters.usable !== review.sends.length) {
    return { ok: false, reason: `the usable counter (${counters.usable}) does not match the sends list length (${review.sends.length}); a contradictory summary is invalid` };
  }
  if (review.files !== undefined && review.files !== null && (!Array.isArray(review.files) || !review.files.every(f => typeof f === 'string'))) {
    return { ok: false, reason: 'the files list must be an array of strings; a malformed field is invalid' };
  }
  const files = Array.isArray(review.files) ? review.files.length : 0;
  if (review.truncated !== undefined && review.truncated !== null && typeof review.truncated !== 'boolean') {
    return { ok: false, reason: 'the truncated flag must be a boolean; a malformed field is invalid' };
  }
  const truncated = review.truncated === true;
  if (review.advisoryError !== undefined && review.advisoryError !== null && typeof review.advisoryError !== 'string') {
    return { ok: false, reason: 'the advisoryError must be a string or null; a malformed field is invalid' };
  }
  const advisoryError = typeof review.advisoryError === 'string' && review.advisoryError.length > 0 ? review.advisoryError : null;
  const skipped = readSkipList(review.skipped);
  if (skipped === null) {
    return { ok: false, reason: 'the skipped list must be an array of { path, reason } entries; a malformed field is invalid' };
  }
  const policyExcluded = readSkipList(review.policyExcluded);
  if (policyExcluded === null) {
    return { ok: false, reason: 'the policyExcluded list must be an array of { path, reason } entries; a malformed field is invalid' };
  }
  if (counters.ok > 0 && (files === 0 || advisoryError !== null)) {
    return { ok: false, reason: 'the summary reports ok sends but no advisory file was written or the advisory write failed; an advisory outcome requires at least one persisted file and no write error' };
  }
  const incomplete = truncated || skipped.length > 0;
  return {
    ok: true,
    summary: {
      usable: counters.usable, refused: counters.refused, failed: counters.failed, ok: counters.ok,
      sends: review.sends,
      files,
      advisoryError,
      skipped,
      policyExcluded,
      incomplete,
    },
  };
}

// The coverage carried by every outcome: the four route counters, the number of advisory files
// that were actually written, the advisory write error (null when the result was persisted),
// the files skipped out of the diff (review-input skips, not the fixed-policy excludes), the
// fixed-policy exclusions themselves (never review input by design), and the routes that did
// not answer (id + reason). This is what keeps a missing result explicit and lists the failed
// routes of a partial success.
function coverage(s) {
  return {
    usable: s.usable,
    refused: s.refused,
    failed: s.failed,
    ok: s.ok,
    files: s.files,
    advisoryError: s.advisoryError,
    skippedFiles: s.skipped,
    policyExcluded: s.policyExcluded,
    failedRoutes: s.sends.filter(x => x && x.state === 'failed').map(x => ({ id: x.id, reason: typeof x.reason === 'string' ? x.reason : null })),
  };
}

function earlyReviewOutcome(candidateSha, review) {
  if (typeof candidateSha !== 'string' || !OBJECT_ID.test(candidateSha)) {
    throw Error('PREREVIEW-STEP: the candidate SHA must be a full object id (40 or 64 hex characters)');
  }
  const n = normalizeSummary(review);
  if (!n.ok) throw Error(`PREREVIEW-STEP: invalid review summary: ${n.reason}`);
  const cov = coverage(n.summary);
  for (const rule of RULES) {
    if (rule.when(n.summary)) return skip(rule.code, candidateSha, cov);
  }
  return advisory(candidateSha, cov);
}

// outcomeValidFor answers ONE question exactly: is this outcome still the review for this
// candidate? It checks (1) the candidate SHA is a full object id, and (2) the outcome object
// conforms to the advisory or skip contract (schema prereview-step/1, advisory true, mode
// READ-ONLY ADVISORY, verdict null; a skip also needs a known code and a non-empty reason). It
// is not a verdict reader: a verdict-spoofing object that carries the same SHA is rejected here.
function outcomeValidFor(candidateSha, outcome) {
  if (typeof candidateSha !== 'string' || !OBJECT_ID.test(candidateSha)) return false;
  if (!outcome || typeof outcome !== 'object' || Array.isArray(outcome)) return false;
  if (outcome.candidateSha !== candidateSha) return false;
  if (outcome.schema !== ADVISORY_SCHEMA) return false;
  if (outcome.advisory !== true) return false;
  if (outcome.mode !== ADVISORY_MODE) return false;
  if (outcome.verdict !== null) return false;
  if (outcome.state === 'advisory') return true;
  if (outcome.state === 'skipped') {
    return SKIP_CODES.includes(outcome.code) && typeof outcome.reason === 'string' && outcome.reason.length > 0;
  }
  return false;
}

// The certification step keeps its seats; the early review step never changes the count.
function certificationSeats() {
  return CERTIFIER_SEATS;
}

module.exports = {
  ADVISORY_SCHEMA, ADVISORY_MODE, OBJECT_ID, SKIP_CODES, CERTIFIER_SEATS, SKIP_REASONS,
  RULE_ORDER, RULE_CONDITIONS, RULES, NO_KEY_REASON, TIMEOUT_REASON,
  normalizeSummary, earlyReviewOutcome, outcomeValidFor, certificationSeats,
};

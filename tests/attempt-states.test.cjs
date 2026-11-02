'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { repoRoot } = require('./helpers.cjs');

const FIXTURE_PATH = path.join(repoRoot, 'tests', 'fixtures', 'attempt-states-fixture.jsonl');
const ALLOWED_STATUSES = new Set(['running', 'failed', 'verified', 'unknown']);

function checkStopRule(row) {
  // R-L2-007.3 stop rule logic
  if (row.disposition === 'fixed-and-verified' || row.disposition === 'refuted') {
    return { token: 'PASS', exit: 0 };
  }
  if (row.attempt >= 3) {
    return { token: 'STOP', exit: 1 };
  }
  if (row.attempt === 2 && (row.disposition === 'confirmed' || row.disposition === 'unresolved')) {
    return { token: 'EXHAUSTED', exit: 1 };
  }
  if (row.disposition === 'deferred-by-owner') {
    if (row.decision && typeof row.decision === 'string' && row.decision.startsWith('PROTO-DEC-')) {
      return { token: 'OWNER-EXCEPTION', exit: 0 };
    }
    return { token: 'UNKNOWN', exit: 2 };
  }
  if (row.status === 'failed') {
    return { token: 'FAILED', exit: 1 };
  }
  return { token: 'UNKNOWN', exit: 2 };
}

test('attempt-states fixture parses and satisfies R-L2-007.2 vocabulary', () => {
  assert.ok(fs.existsSync(FIXTURE_PATH), 'fixture file must exist');
  const lines = fs.readFileSync(FIXTURE_PATH, 'utf8').trim().split('\n').filter(Boolean);
  assert.ok(lines.length >= 6, 'fixture must contain comprehensive test states');

  const statesCovered = new Set();

  for (const line of lines) {
    const row = JSON.parse(line);

    // Required fields per R-L2-007.2
    assert.ok(row.scope, 'scope is required');
    assert.ok(row.root_cause, 'root_cause is required');
    assert.ok(typeof row.attempt === 'number' && row.attempt >= 1, 'attempt must be positive int');
    assert.match(row.candidate, /^[0-9a-f]{40}$/, 'candidate must be 40-hex SHA');
    assert.ok(ALLOWED_STATUSES.has(row.status), `status ${row.status} must belong to R-L2-007.2 vocabulary`);

    // Evaluate stop rule state
    if (row.state) {
      const evaluation = checkStopRule(row);
      assert.equal(evaluation.token, row.state, `state mismatch for root_cause ${row.root_cause}`);
      assert.equal(evaluation.exit, row.exit, `exit mismatch for root_cause ${row.root_cause}`);
      statesCovered.add(row.state);
    }
  }

  // Ensure all key stop rule states are covered
  assert.ok(statesCovered.has('PASS'), 'fixture must cover PASS state');
  assert.ok(statesCovered.has('EXHAUSTED'), 'fixture must cover EXHAUSTED state');
  assert.ok(statesCovered.has('STOP'), 'fixture must cover STOP state');
  assert.ok(statesCovered.has('OWNER-EXCEPTION'), 'fixture must cover OWNER-EXCEPTION state');
  assert.ok(statesCovered.has('UNKNOWN'), 'fixture must cover UNKNOWN state');
});

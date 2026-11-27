'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { repoRoot, makeProtocolFixture, write, run } = require('./helpers.cjs');

const FIXTURE_PATH = path.join(repoRoot, 'tests', 'fixtures', 'attempt-states-fixture.jsonl');
const VERDICT_TOOL = path.join(repoRoot, '.ai', 'bin', 'protocol-verdict.cjs');

// R-L2-007.2 attempt-results vocabulary.
const ALLOWED_STATUSES = new Set(['running', 'failed', 'verified', 'unknown']);
// Findings-ledger dispositions (.ai/bin/protocol-verdict.cjs parseFindingsLedger).
const ALLOWED_DISPOSITIONS = new Set(['confirmed', 'refuted', 'fixed-and-verified', 'deferred-by-owner', 'unresolved']);
// R-L2-007.3 stop rule states recorded in the fixture; FAILED records a
// failed attempt below the stop limit (fixture row RC-001 attempt 1).
const ALLOWED_STATES = new Set(['PASS', 'FAILED', 'EXHAUSTED', 'STOP', 'OWNER-EXCEPTION', 'UNKNOWN']);

function readFixtureRows() {
  assert.ok(fs.existsSync(FIXTURE_PATH), 'fixture file must exist');
  return fs.readFileSync(FIXTURE_PATH, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

// A fixture row becomes a real findings-ledger row for the production CLI.
// paths/reproduction/exit/severity are inert for --stop-rule; root-cause,
// disposition and attempt are exactly what checkStopRule reads.
function toLedgerRow(row) {
  return {
    id: `F-${row.root_cause}-${row.attempt}`,
    rootCause: row.root_cause,
    requirement: `contract violation: ${row.scope}`,
    paths: 'notes.md',
    reproduction: 'reproduced attempt failure',
    exit: 'n/a',
    severity: 'LOW',
    disposition: row.disposition,
    attempt: String(row.attempt),
  };
}

function makeLedgerTable(rows) {
  let md = '# Findings Ledger\n\n' +
    '| id | root-cause | requirement | paths | reproduction | exit | severity | disposition | attempt |\n' +
    '|---|---|---|---|---|---|---|---|---|\n';
  for (const r of rows) {
    md += `| ${r.id} | ${r.rootCause} | ${r.requirement} | ${r.paths} | ${r.reproduction} | ${r.exit} | ${r.severity} | ${r.disposition} | ${r.attempt} |\n`;
  }
  return md;
}

// The real production CLI: .ai/bin/protocol-verdict.cjs <ledger> --stop-rule.
function runStopRule(root, ledgerArg, toolPath = VERDICT_TOOL) {
  const result = run('node', [toolPath, ledgerArg, '--stop-rule'], root);
  return { status: result.status, stdout: String(result.stdout), stderr: String(result.stderr) };
}

test('attempt-states fixture parses and satisfies R-L2-007.2/R-L2-007.3 vocabulary', () => {
  const rows = readFixtureRows();
  assert.ok(rows.length >= 6, 'fixture must contain comprehensive test states');

  const statesCovered = new Set();

  for (const row of rows) {
    // Required fields per R-L2-007.2
    assert.ok(row.scope, 'scope is required');
    assert.ok(row.root_cause, 'root_cause is required');
    assert.ok(typeof row.attempt === 'number' && row.attempt >= 1, 'attempt must be positive int');
    assert.match(row.candidate, /^[0-9a-f]{40}$/, 'candidate must be 40-hex SHA');
    assert.ok(ALLOWED_STATUSES.has(row.status), `status ${row.status} must belong to R-L2-007.2 vocabulary`);
    assert.ok(ALLOWED_DISPOSITIONS.has(row.disposition),
      `disposition ${row.disposition} must belong to the findings-ledger vocabulary`);
    assert.ok(ALLOWED_STATES.has(row.state), `state ${row.state} must belong to the R-L2-007.3 vocabulary`);
    assert.ok([0, 1, 2].includes(row.exit), `exit ${row.exit} must be a protocol exit code`);
    statesCovered.add(row.state);
  }

  // Ensure all key stop rule states are covered
  assert.ok(statesCovered.has('PASS'), 'fixture must cover PASS state');
  assert.ok(statesCovered.has('EXHAUSTED'), 'fixture must cover EXHAUSTED state');
  assert.ok(statesCovered.has('STOP'), 'fixture must cover STOP state');
  assert.ok(statesCovered.has('OWNER-EXCEPTION'), 'fixture must cover OWNER-EXCEPTION state');
  assert.ok(statesCovered.has('UNKNOWN'), 'fixture must cover UNKNOWN state');
});

test('stop rule: real CLI passes the fixture root causes below the attempt limit', t => {
  const rows = readFixtureRows();
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row.root_cause)) groups.set(row.root_cause, []);
    groups.get(row.root_cause).push(row);
  }
  const belowLimit = [...groups.entries()].filter(([, rs]) => !rs.some(r => r.attempt >= 3));
  assert.ok(belowLimit.length >= 4, 'fixture must hold several root causes below the stop limit');

  const root = makeProtocolFixture(t);
  write(root, 'pass-findings.md', makeLedgerTable(belowLimit.flatMap(([, rs]) => rs.map(toLedgerRow))));

  const res = runStopRule(root, 'pass-findings.md');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, new RegExp(`Root-cause stop rule satisfied across ${belowLimit.length} group\\(s\\)`));
});

test('every fixture row has the recorded state, disposition and real CLI exits', t => {
  // Independent contract examples, keyed by identity, never selected by the
  // fixture's claimed state/disposition. State is the attempt label; --stop-rule
  // only checks history/limit, while the normal CLI evaluates dispositions.
  const expected = new Map([
    ['RC-000:1', ['verified', 'fixed-and-verified', 'PASS', 0, 'PASS', 0]],
    ['RC-000b:1', ['verified', 'refuted', 'PASS', 0, 'PASS', 0]],
    ['RC-001:1', ['failed', 'confirmed', 'FAILED', 1, 'FAIL', 0]],
    ['RC-001:2', ['failed', 'confirmed', 'EXHAUSTED', 1, 'FAIL', 0]],
    ['RC-001:3', ['failed', 'confirmed', 'STOP', 1, 'FAIL', 1]],
    ['RC-002:1', ['unknown', 'deferred-by-owner', 'OWNER-EXCEPTION', 0, 'PASS', 0]],
    ['RC-FIXTURE-005:1', ['unknown', 'deferred-by-owner', 'OWNER-EXCEPTION', 0, 'PASS', 0]],
    ['RC-003:1', ['unknown', 'unresolved', 'UNKNOWN', 2, 'BLOCKED', 0]],
  ]);
  const rows = readFixtureRows();
  assert.equal(rows.length, expected.size, 'each contract example occurs exactly once');
  const ownerCitations = new Map([['RC-002:1', 'PROTO-DEC-9001'], ['RC-FIXTURE-005:1', 'PROTO-DEC-9002']]);
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.root_cause}:${row.attempt}`, want = expected.get(key);
    assert.ok(want, `unexpected example ${key}`);
    assert.ok(!seen.has(key), `duplicate example ${key}`);
    seen.add(key);
    assert.deepEqual([row.status, row.disposition, row.state, row.exit], want.slice(0, 4), key);
    assert.equal(row.decision, ownerCitations.get(key), `${key}: owner exception citation`);
    const root = makeProtocolFixture(t);
    write(root, 'row-findings.md', makeLedgerTable([toLedgerRow(row)]));
    const verdict = run('node', [VERDICT_TOOL, 'row-findings.md'], root);
    assert.equal(verdict.status, row.exit, `${key}: ${verdict.stderr}`);
    assert.match(verdict.stdout, new RegExp(`^Verdict: ${want[4]}\\n`), key);
    const prefix = rows.filter(r => r.root_cause === row.root_cause && r.attempt <= row.attempt);
    write(root, 'row-findings.md', makeLedgerTable(prefix.map(toLedgerRow)));
    const stop = runStopRule(root, 'row-findings.md');
    assert.equal(stop.status, want[5], `${key}: ${stop.stderr}`);
    assert.match(stop.stdout, want[5] === 1 ? /STOP RULE TRIGGERED/ : /^PASS: Root-cause stop rule satisfied/, key);
  }
});

test('stop rule: real CLI stops the fixture root cause that reached attempt 3; mutant with a raised limit escapes', t => {
  const rows = readFixtureRows();
  const stopRows = rows.filter(r => r.root_cause === rows.find(x => x.state === 'STOP').root_cause);
  assert.ok(stopRows.length >= 3, 'the STOP root cause must carry the full attempt history');
  assert.ok(stopRows.some(r => r.state === 'EXHAUSTED' && r.attempt === 2),
    'the STOP root cause must include the attempt-2 EXHAUSTED row');

  const root = makeProtocolFixture(t);
  write(root, 'stop-findings.md', makeLedgerTable(stopRows.map(toLedgerRow)));

  // Control: the real tool triggers the stop rule on the fixture data.
  const res = runStopRule(root, 'stop-findings.md');
  assert.equal(res.status, 1, res.stderr);
  assert.match(res.stdout, /STOP RULE TRIGGERED/);
  assert.match(res.stdout, /stop and return the area or the premise to the owner/);
  assert.match(res.stdout, new RegExp(stopRows[0].root_cause));
  assert.match(res.stdout, /attempt 3/);

  // Mutant: the attempt limit of the production source is raised from 3 to
  // 4 in a copy inside the fixture. The copy must let attempt 3 through,
  // which is exactly what the exit-1 assertions above reject.
  const source = fs.readFileSync(VERDICT_TOOL, 'utf8');
  const anchor = 'if (maxAttempt >= 3) {';
  assert.ok(source.includes(anchor), 'mutation anchor must exist in protocol-verdict.cjs');
  const mutated = source.replace(anchor, 'if (maxAttempt >= 4) {');
  assert.notEqual(mutated, source, 'mutation must change the source');
  const mutantPath = path.join(root, 'protocol-verdict-mutant.cjs');
  write(root, 'protocol-verdict-mutant.cjs', mutated);

  const resMutant = runStopRule(root, 'stop-findings.md', mutantPath);
  assert.equal(resMutant.status, 0,
    'mutant (limit raised to 4) must NOT trigger on attempt 3, proving the control assertions kill it');
});

test('stop rule: real CLI rejects conflicting and non-contiguous attempts (exit 2)', t => {
  const root = makeProtocolFixture(t);
  const base = { requirement: 'r', paths: 'notes.md', reproduction: 'none', exit: 'n/a', severity: 'LOW' };

  // Conflicting dispositions for the same (root-cause, attempt).
  write(root, 'conflict-findings.md', makeLedgerTable([
    { ...base, id: 'F-C1', rootCause: 'RC-conf', disposition: 'confirmed', attempt: '1' },
    { ...base, id: 'F-C2', rootCause: 'RC-conf', disposition: 'refuted', attempt: '1' },
  ]));
  const resConflict = runStopRule(root, 'conflict-findings.md');
  assert.equal(resConflict.status, 2);
  assert.match(resConflict.stderr, /conflicting dispositions/);
  fs.unlinkSync(path.join(root, 'conflict-findings.md'));

  // Non-contiguous attempts {1, 3}.
  write(root, 'gap-findings.md', makeLedgerTable([
    { ...base, id: 'F-G1', rootCause: 'RC-gap', disposition: 'confirmed', attempt: '1' },
    { ...base, id: 'F-G2', rootCause: 'RC-gap', disposition: 'unresolved', attempt: '3' },
  ]));
  const resGap = runStopRule(root, 'gap-findings.md');
  assert.equal(resGap.status, 2);
  assert.match(resGap.stderr, /non-contiguous attempts/);
});

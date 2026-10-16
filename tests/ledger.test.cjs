'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { run, git, write, makeProtocolFixture, makeFixture } = require('./helpers.cjs');
const ledger = require('../.ai/bin/protocol-ledger.cjs');

const TOOL = path.join(__dirname, '..', '.ai', 'bin', 'protocol-ledger.cjs');

const REPRO_SCRIPT = 'if (process.argv[2] !== "a;$(echo unsafe)") process.exitCode = 9; else process.exitCode = 1;\n';
const REPRO_HASH = require('node:crypto').createHash('sha256').update(REPRO_SCRIPT).digest('hex');
const LOCATOR = `repo:tests/repro.cjs; interp:node; argv:["a;$(echo unsafe)"]; exit:1; sha256:${REPRO_HASH}`;
const EXTERNAL_LOCATION = ['https:', '', 'example.invalid', 'repro'].join('/');

test('K2 repro closed grammar preserves argv literally and refuses ten malformed siblings', () => {
  assert.deepEqual(ledger.parseReproduction(LOCATOR, 'FAIL').argv, ['a;$(echo unsafe)']);
  assert.equal(ledger.parseReproduction(LOCATOR.replace('exit:1', 'exit:-1'), 'FAIL').exit, -1);
  assert.equal(ledger.parseReproduction(LOCATOR.replace('tests/repro.cjs', 'tests/\u0442\u0435\u0441\u0442.cjs'), 'FAIL').path, 'tests/\u0442\u0435\u0441\u0442.cjs');
  assert.deepEqual(ledger.parseReproduction('none', 'RECOMMENDATION'), { kind: 'none' });
  const bad = [
    LOCATOR.replace('tests/repro.cjs', '../tests/repro.cjs'),
    LOCATOR.replace('tests/repro.cjs', path.posix.join(path.posix.sep, 'tests', 'repro.cjs')),
    LOCATOR.replace('tests/repro.cjs', path.win32.join('C' + ':' + path.win32.sep, 'tests', 'repro.cjs')),
    LOCATOR.replace('tests/repro.cjs', 'tests//repro.cjs'),
    LOCATOR.replace('tests/repro.cjs', 'tests/./repro.cjs'),
    LOCATOR.replace('interp:node', 'interp:cmd'),
    LOCATOR.replace('interp:node', 'interp:bash'),
    LOCATOR.replace('exit:1', 'exit:-0'), LOCATOR.replace('exit:1', 'exit:1.5'), LOCATOR.replace('exit:1', 'exit:9007199254740992'),
    LOCATOR.replace('argv:["a;$(echo unsafe)"]', 'argv:[null]'),
    LOCATOR.replace('argv:["a;$(echo unsafe)"]', 'argv:[1]'),
    LOCATOR.replace('argv:["a;$(echo unsafe)"]', 'argv:["\\u0000"]'),
    '\uFEFF' + LOCATOR, LOCATOR + '\n', LOCATOR.replace('repo:', 'repo:\u200b'),
    `external:elsewhere; sha256:${REPRO_HASH}; sanction:missing`,
    LOCATOR.replace('argv:["a;$(echo unsafe)"]', 'argv:["s' + 'k-' + 'a'.repeat(20) + '"]'),
  ];
  for (const value of bad) assert.throws(() => ledger.parseReproduction(value, 'FAIL'));
  for (const verdict of ['FAIL', 'BLOCKED', 'PASS', 'unknown']) assert.throws(() => ledger.parseReproduction('none', verdict));
});

test('K2 repro executes exact candidate bytes despite dirty producer and binds to Evidence', t => {
  const root = makeProtocolFixture(t);
  write(root, '.ai/bin/protocol-validate.cjs', 'process.exitCode = 0;\n');
  write(root, 'tests/repro.cjs', REPRO_SCRIPT);
  write(root, 'tests/\u0442\u0435\u0441\u0442.cjs', REPRO_SCRIPT);
  assert.equal(git(root, ['add', '.']).status, 0);
  assert.equal(git(root, ['-c', 'user.name=Protocol Test', '-c', 'user.email=protocol-test@example.invalid', 'commit', '-m', 'repro fixture']).status, 0);
  const sha = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const journal = '.ai/worklog/repro-owner.md';
  write(root, journal, '# W\n\n## 2026-10-14 - repro\n\nAgent: tester\n\nAction: test\n\nResult: fixture\n\nNext step: handoff\n\nOpen: none\n');
  const rec = run(process.execPath, [path.join(root, '.ai/bin/protocol-handoff.cjs'), 'record', '--owner', 'repro-owner', '--candidate', sha, '--baseline', sha, '--quick'], root);
  assert.equal(rec.status, 0, rec.stderr);
  write(root, 'locator.txt', LOCATOR + '\n');
  write(root, 'tests/repro.cjs', 'process.exitCode = 9;\n');
  const opts = { candidate: sha, journal, locatorFile: 'locator.txt', verdict: 'FAIL' };
  const result = ledger.verifyReproduction(root, opts);
  assert.equal(result.executed, true); assert.equal(result.exit, 1); assert.equal(result.scriptSha256, REPRO_HASH);
  assert.match(result.candidateDigest, /^sha256:[a-f0-9]{64}$/);
  write(root, 'locator.txt', LOCATOR.replace('tests/repro.cjs', 'tests/\u0442\u0435\u0441\u0442.cjs') + '\n');
  assert.equal(ledger.verifyReproduction(root, opts).exit, 1);
  write(root, 'locator.txt', LOCATOR + '\n');
  const cli = run(process.execPath, [TOOL, 'repro', '--root', root, '--candidate', sha, '--journal', journal, '--locator-file', 'locator.txt', '--verdict', 'FAIL'], root);
  assert.equal(cli.status, 0, cli.stderr); assert.equal(JSON.parse(cli.stdout).exit, 1);
  for (const altered of [LOCATOR.replace('exit:1', 'exit:0'), LOCATOR.replace(REPRO_HASH, 'a'.repeat(64)), LOCATOR.replace('tests/repro.cjs', 'tests/missing.cjs')]) {
    write(root, 'locator.txt', altered + '\n');
    assert.throws(() => ledger.verifyReproduction(root, opts));
  }
  write(root, 'locator.txt', LOCATOR + '\n');
  assert.throws(() => ledger.verifyReproduction(root, { ...opts, candidate: 'a'.repeat(40) }));
  assert.throws(() => ledger.verifyReproduction(root, { ...opts, journal: '.ai/worklog/missing.md' }));
  // Synthetic fixture decisions are test data, not approvals in this repository.
  const external = `external:${EXTERNAL_LOCATION}; sha256:${REPRO_HASH}; sanction:PROTO-DEC-9999`;
  const sanction = `\n### PROTO-DEC-9999\n\nStatus: Accepted\nApproved by: Protocol Fixture Owner\nExternal-Reproduction: ${external}\nReproduction: ${LOCATOR}\n`;
  write(root, 'tests/repro.cjs', REPRO_SCRIPT);
  const decisionPath = '.ai/DECISIONS.md';
  const originalDecisions = fs.readFileSync(path.join(root, decisionPath), 'utf8');
  write(root, decisionPath, originalDecisions + sanction);
  assert.equal(git(root, ['add', decisionPath]).status, 0);
  assert.equal(git(root, ['-c', 'user.name=Protocol Test', '-c', 'user.email=protocol-test@example.invalid', 'commit', '-m', 'synthetic sanction fixture']).status, 0);
  const sanctionedSha = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  write(root, journal, '# W\n\n## 2026-10-14 - sanctioned fixture\n\nAgent: tester\n\nAction: test\n\nResult: fixture\n\nNext step: handoff\n\nOpen: none\n');
  const sanctionedRecord = run(process.execPath, [path.join(root, '.ai/bin/protocol-handoff.cjs'), 'record', '--owner', 'repro-owner', '--candidate', sanctionedSha, '--baseline', sha, '--quick'], root);
  assert.equal(sanctionedRecord.status, 0, sanctionedRecord.stderr);
  write(root, 'locator.txt', external + '\n');
  const extOpts = { ...opts, candidate: sanctionedSha };
  const extResult = ledger.verifyReproduction(root, extOpts);
  assert.equal(extResult.kind, 'external'); assert.equal(extResult.exit, 1); assert.equal(extResult.sanction, 'PROTO-DEC-9999');
  // Dirty producer cannot change approval, location or copy after the receipt.
  write(root, decisionPath, originalDecisions);
  assert.equal(ledger.verifyReproduction(root, extOpts).exit, 1);
  write(root, 'locator.txt', external.replace('example.invalid/repro', 'example.invalid/other') + '\n');
  assert.throws(() => ledger.verifyReproduction(root, extOpts), /different borrowing/);
  write(root, 'locator.txt', external.replace('PROTO-DEC-9999', 'PROTO-DEC-9998') + '\n');
  assert.throws(() => ledger.verifyReproduction(root, extOpts), /missing or ambiguous/);
});

test('K2 repro rejects duplicate/unknown options before executing', () => {
  for (const argv of [['repro'], ['repro', '--unknown', 'x'], ['repro', '--candidate', 'a', '--candidate', 'b']]) {
    assert.equal(ledger.main(argv), 2);
  }
});

test('K2 repro sanctions refuse fourteen approval, identity and Markdown siblings', t => {
  const root = makeFixture(t);
  const c = require('../.ai/bin/protocol-handoff/candidate.cjs');
  const ext = `external:${EXTERNAL_LOCATION}; sha256:${REPRO_HASH}; sanction:PROTO-DEC-9999`;
  const parsed = ledger.parseReproduction(ext, 'FAIL');
  const approved = `### PROTO-DEC-9999\n\nStatus: Accepted\nApproved by: Protocol Fixture Owner\nExternal-Reproduction: ${ext}\nReproduction: ${LOCATOR}\n`;
  const inspect = text => {
    write(root, '.ai/DECISIONS.md', text);
    write(root, 'tests/repro.cjs', REPRO_SCRIPT);
    assert.equal(git(root, ['add', '.']).status, 0);
    assert.equal(git(root, ['-c', 'user.name=Protocol Test', '-c', 'user.email=protocol-test@example.invalid', 'commit', '-m', 'synthetic decision text']).status, 0);
    const sha = git(root, ['rev-parse', 'HEAD']).stdout.trim();
    return ledger.sanctionedReproduction(root, c.candidateState(root, sha, sha), parsed, 'FAIL');
  };
  assert.equal(inspect(approved).path, 'tests/repro.cjs');
  const bad = [
    approved.replace('Status: Accepted', 'Status: Draft'),
    approved.replace('Status: Accepted', 'Status: Accepted\nStatus: Accepted'),
    approved.replace('Approved by: Protocol Fixture Owner', 'Approved by: '),
    approved.replace('Approved by: Protocol Fixture Owner', 'Approved by: Protocol Fixture Owner\nApproved by: Other Fixture'),
    approved.replace('Approved by: Protocol Fixture Owner', '<!--\nApproved by: Protocol Fixture Owner\n-->'),
    approved.replace('Approved by: Protocol Fixture Owner', '```\nApproved by: Protocol Fixture Owner\n```'),
    approved.replace('Approved by: Protocol Fixture Owner', '> Approved by: Protocol Fixture Owner\n'),
    approved.replace('External-Reproduction: ' + ext, 'External-Reproduction: ' + ext.replace('/repro;', '/other;')),
    approved.replace('External-Reproduction: ' + ext, 'External-Reproduction: ' + ext + '\nExternal-Reproduction: ' + ext),
    approved.replace('Reproduction: ' + LOCATOR, 'Reproduction: ' + LOCATOR.replace(REPRO_HASH, 'a'.repeat(64))),
    approved.replace('Reproduction: ' + LOCATOR, 'Reproduction: none'),
    approved + '\n' + approved,
    approved + '\n### PROTO-DEC-9998\n\nStatus: Accepted\nApproved by: Protocol Fixture Owner\nSupersedes: PROTO-DEC-9999\n',
    approved.replace('### PROTO-DEC-9999', '### PROTO-DEC-9998'),
  ];
  for (const text of bad) assert.throws(() => inspect(text));
});

test('K2 repro interpreter argv reaches Git Bash literally and missing pwsh refuses', t => {
  const root = makeProtocolFixture(t);
  const script = 'if [ "$1" = \'literal;$(false)\' ]; then exit 4; fi\nexit 9\n';
  write(root, '.ai/bin/protocol-validate.cjs', 'process.exitCode = 0;\n');
  write(root, 'tests/probe.sh', script);
  write(root, 'tests/probe.ps1', 'exit 3\n');
  assert.equal(git(root, ['add', '.']).status, 0);
  assert.equal(git(root, ['-c', 'user.name=Protocol Test', '-c', 'user.email=protocol-test@example.invalid', 'commit', '-m', 'interpreter fixture']).status, 0);
  const sha = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  const journal = '.ai/worklog/repro-owner.md';
  write(root, journal, '# W\n\n## 2026-10-14 - interpreters\n\nAgent: tester\n\nAction: test\n\nResult: fixture\n\nNext step: handoff\n\nOpen: none\n');
  const record = run(process.execPath, [path.join(root, '.ai/bin/protocol-handoff.cjs'), 'record', '--owner', 'repro-owner', '--candidate', sha, '--baseline', sha, '--quick'], root);
  assert.equal(record.status, 0, record.stderr);
  const opts = { candidate: sha, journal, locatorFile: 'locator.txt', verdict: 'FAIL' };
  const hash = s => require('node:crypto').createHash('sha256').update(s).digest('hex');
  write(root, 'locator.txt', `repo:tests/probe.sh; interp:bash; argv:["literal;$(false)"]; exit:4; sha256:${hash(script)}\n`);
  if (run('bash', ['--version'], root).status === 0) assert.equal(ledger.verifyReproduction(root, opts).exit, 4);
  else { assert.throws(() => ledger.verifyReproduction(root, opts)); t.diagnostic('bash positive execution unavailable'); }
  write(root, 'locator.txt', `repo:tests/probe.ps1; interp:pwsh; argv:[]; exit:3; sha256:${hash('exit 3\n')}\n`);
  if (run('pwsh', ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], root).status === 0) assert.equal(ledger.verifyReproduction(root, opts).exit, 3);
  else { assert.throws(() => ledger.verifyReproduction(root, opts), /unavailable/); t.diagnostic('pwsh positive unavailable; missing interpreter refuses'); }
});

function corpusFixture(t) {
  const root = makeProtocolFixture(t);
  write(root, 'src/alpha.py', 'print("alpha")\n');
  write(root, 'src/beta.py', 'print("beta")\n');
  write(root, 'src/gamma.py', 'print("gamma")\n');
  assert.equal(git(root, ['add', '.']).status, 0);
  assert.equal(git(root, ['-c', 'user.name=Protocol Test', '-c',
    'user.email=protocol-test@example.invalid', 'commit', '-m', 'Seed corpus']).status, 0);
  return root;
}

test('cover names the unit that has no record', t => {
  const root = corpusFixture(t);
  write(root, 'records/src/alpha.py.md', 'alpha record\n');
  write(root, 'records/src/beta.py.md', 'beta record\n');
  const result = ledger.cover(root, path.join(root, 'records'), ['.git'], '.md');
  const gamma = result.rows.find(row => row.unit === 'src/gamma.py');
  assert.equal(gamma.disposition, 'no record');
  assert.equal(result.rows.filter(row => row.disposition === 'record').length, 2);
  assert.deepEqual(result.extra, []);
});

test('cover names a record that has no unit behind it', t => {
  const root = corpusFixture(t);
  write(root, 'records/src/alpha.py.md', 'alpha record\n');
  write(root, 'records/src/invented.py.md', 'a record for a file that does not exist\n');
  const result = ledger.cover(root, path.join(root, 'records'), ['.git'], '.md');
  assert.equal(result.extra.length, 1);
  assert.match(result.extra[0], /invented\.py\.md$/);
});

test('a gap fails only under --expect-all; an unexpected record always fails', t => {
  const root = corpusFixture(t);
  write(root, 'records/src/alpha.py.md', 'alpha record\n');

  // The corpus is the whole repository, not the three files this test added, so the
  // expectation is derived from git rather than hard-coded.
  const tracked = git(root, ['ls-files']).stdout.split(/\r?\n/).filter(Boolean).length;
  const lenient = run(process.execPath,
    [TOOL, 'cover', '--records', path.join(root, 'records'), '--out',
      path.join(root, '.ai/runtime/c1.md')], root);
  assert.equal(lenient.status, 0, 'a unit without a record may be a declared classification');
  assert.match(lenient.stdout, new RegExp(`units ${tracked}, without record ${tracked - 1},`));

  const strict = run(process.execPath,
    [TOOL, 'cover', '--records', path.join(root, 'records'), '--expect-all', '--out',
      path.join(root, '.ai/runtime/c2.md')], root);
  assert.equal(strict.status, 1);

  write(root, 'records/src/invented.py.md', 'no unit behind this\n');
  const unexpected = run(process.execPath,
    [TOOL, 'cover', '--records', path.join(root, 'records'), '--out',
      path.join(root, '.ai/runtime/c3.md')], root);
  assert.equal(unexpected.status, 1, 'a record with no unit is always a defect');
});

test('dup reports records shared across two producers', t => {
  const root = corpusFixture(t);
  write(root, 'a/src/alpha.py.md', 'identical body\n');
  write(root, 'b/src/alpha.py.md', 'identical body\n');
  write(root, 'a/src/beta.py.md', 'own work\n');
  write(root, 'b/src/beta.py.md', 'different own work\n');
  const result = ledger.duplicates([path.join(root, 'a'), path.join(root, 'b')]);
  assert.equal(result.across.length, 1);
  assert.equal(result.across[0].count, 2);
  assert.equal(result.within.length, 0);
});

test('dup separates duplication inside one set from duplication across sets', t => {
  const root = corpusFixture(t);
  write(root, 'a/one.md', 'a filled template\n');
  write(root, 'a/two.md', 'a filled template\n');
  write(root, 'b/three.md', 'something else\n');
  const result = ledger.duplicates([path.join(root, 'a'), path.join(root, 'b')]);
  assert.equal(result.within.length, 1, 'the same body twice in one set is a template, not a copy');
  assert.equal(result.across.length, 0);
});

test('dup exits non-zero on a cross-producer duplicate and ignores the --out path', t => {
  const root = corpusFixture(t);
  write(root, 'a/one.md', 'shared\n');
  write(root, 'b/one.md', 'shared\n');
  const out = path.join(root, '.ai/runtime/dup.md');
  const result = run(process.execPath,
    [TOOL, 'dup', path.join(root, 'a'), path.join(root, 'b'), '--out', out], root);
  assert.equal(result.status, 1);
  const report = fs.readFileSync(out, 'utf8');
  assert.doesNotMatch(report, /dup\.md,/, 'the output file must not be compared against itself');
  assert.match(report, /identical across sets: 1/);
});

test('a corpus that is not a git repository still gets an inventory', t => {
  const root = makeFixture(t);
  write(root, 'notes/one.txt', 'one\n');
  write(root, 'notes/two.txt', 'two\n');
  const found = ledger.corpus(root, ['.git', 'node_modules']);
  assert.match(found.source, /not a git repository/);
  assert.deepEqual(found.units, ['notes/one.txt', 'notes/two.txt']);
});

test('the report states that it is advisory and decides nothing', t => {
  const root = corpusFixture(t);
  write(root, 'a/one.md', 'x\n');
  write(root, 'b/one.md', 'x\n');
  const rendered = ledger.renderDup(
    ledger.duplicates([path.join(root, 'a'), path.join(root, 'b')]),
    [path.join(root, 'a'), path.join(root, 'b')]);
  assert.match(rendered, /assigns no/);
  assert.match(rendered, /decides nothing/);
});

test('a non-ASCII tracked path survives git quoting (the certification blocker)', t => {
  const root = corpusFixture(t);
  write(root, 'src/крупный.md', 'x'.repeat(60000));
  assert.equal(git(root, ['add', '.']).status, 0);
  assert.equal(git(root, ['-c', 'user.name=Protocol Test', '-c',
    'user.email=protocol-test@example.invalid', 'commit', '-m', 'Add non-ASCII']).status, 0);

  // Precondition: the default configuration C-quotes it, which is what broke this.
  const quoted = git(root, ['ls-files']).stdout.split(/\r?\n/)
    .filter(line => line.startsWith('"'));
  assert.equal(quoted.length, 1, 'precondition: git must be C-quoting the non-ASCII path');
  assert.ok(!quoted[0].includes('крупный'), 'precondition: the quoted form hides the real name');

  const found = ledger.corpus(root, ['.git']);
  assert.ok(found.units.includes('src/крупный.md'),
    'the real path must be a unit, not the quoted string');
  assert.ok(!found.units.some(unit => unit.startsWith('"')),
    'no quoted string may survive as a unit');
});

test('a missing comparison set fails instead of reporting no duplicates', t => {
  const root = corpusFixture(t);
  write(root, 'a/one.md', 'body\n');
  const result = run(process.execPath,
    [TOOL, 'dup', path.join(root, 'a'), path.join(root, 'does-not-exist')], root);
  assert.notEqual(result.status, 0, 'a comparison that never happened is not a clean result');
  assert.match(result.stdout, /not an existing directory/);
});

test('the same directory twice is refused rather than matching itself', t => {
  const root = corpusFixture(t);
  write(root, 'a/one.md', 'body\n');
  const result = run(process.execPath,
    [TOOL, 'dup', path.join(root, 'a'), path.join(root, 'a')], root);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /given twice/);
});

test('an exclusion written with a trailing slash still excludes', t => {
  const root = corpusFixture(t);
  write(root, 'logs/noise.txt', 'noise\n');
  write(root, 'logs-old/keep.txt', 'keep\n');
  assert.equal(git(root, ['add', '.']).status, 0);
  assert.equal(git(root, ['-c', 'user.name=Protocol Test', '-c',
    'user.email=protocol-test@example.invalid', 'commit', '-m', 'Add logs']).status, 0);

  const found = ledger.corpus(root, ['.git', 'logs/']);
  assert.ok(!found.units.includes('logs/noise.txt'), 'trailing slash must still exclude');
  assert.ok(found.units.includes('logs-old/keep.txt'), 'a prefix is not a directory match');
});

test('a missing records directory fails with a named reason', t => {
  const root = corpusFixture(t);
  const result = run(process.execPath,
    [TOOL, 'cover', '--records', path.join(root, 'nope')], root);
  assert.equal(result.status, 2);
  assert.match(result.stdout, /records directory is not an existing directory/);
});

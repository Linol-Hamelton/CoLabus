'use strict';

// Node validator output, summary and exit-code contract across former parity fixtures.
// The section and CM coverage map below remains the case inventory.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { repoRoot, makeProtocolFixture, run, write, git } = require('./helpers.cjs');

const nodeCli = path.join(repoRoot, '.ai', 'bin', 'protocol-validate.cjs');

const SECTIONS = [
  {
    section: 'entry',
    cm: ['CM-01', 'CM-02', 'CM-04', 'CM-05', 'CM-47'],
    patterns: [
      /^AI Collaboration Protocol - validation$/,
      /^Root: /,
      /^Protocol (?:OK|BROKEN)\./,
    ],
  },
  {
    section: 'repository',
    cm: ['CM-06', 'CM-07', 'CM-08', 'CM-09', 'CM-10', 'CM-11', 'CM-12', 'CM-13', 'CM-14'],
    patterns: [
      /^missing file: /,
      /^present: /,
      /^protocol-manifest\.json is not valid JSON: /,
      /^legacy boundary manifest (?:not found: |is not valid JSON: )/,
      /^git is unavailable/,
      /^not a valid Git working tree at the protocol root$/,
      /^protocol root is inside another repository/,
      /^valid Git working tree$/,
      /^cannot enumerate Git files: /,
      /^cannot read Git history: /,
      /^no commits yet/,
      /^commits on record: /,
      /^symlink content not inspected: /,
    ],
  },
  {
    section: 'text',
    cm: ['CM-15', 'CM-16', 'CM-17', 'CM-18', 'CM-19', 'CM-21', 'CM-22', 'CM-23', 'CM-24',
      'CM-45'],
    patterns: [
      /^byte order mark present: /,
      /^invalid UTF-8: /,
      /^NUL byte in text/,
      /^CR\/CRLF found/,
      /^non-ASCII byte in PowerShell script: /,
      /^inspected \d+ protocol-owned text files for UTF-8, BOM, LF and PowerShell syntax$/,
      /^\d+ session journals in \.ai\/worklog \(cap 100/,
      /^cannot read UTF-8 text: /,
      /: \d+ lines exceeds limit of \d+$/,
      /: \d+\/\d+ lines$/,
      /^active docs\/reviews\/ exceeds budget \(/,
      /\.md holds an entry whose Agent line does not name /,
    ],
  },
  {
    section: 'governance',
    cm: ['CM-30', 'CM-31', 'CM-32', 'CM-33', 'CM-44'],
    patterns: [
      /^no numbered decisions recorded yet$/,
      /^inspected \d+ decision blocks; approval text is not proof of human authorization$/,
      / must use four digits$/,
      /^duplicate decision: /,
      / has duplicate (?:Status|Date|Approved by) fields$/,
      / has missing or invalid Status \(Proposed is forbidden; drafts belong in PLAN\.md\)$/,
      / requires a valid Date: YYYY-MM-DD$/,
      / requires a non-placeholder Approved by field$/,
      / supersedes .* which does not exist$/,
      / supersedes itself$/,
      /^docs\/decisions\/REGISTRY\.md is missing; decision registry should track accepted\/frozen status$/,
      /^decision registry missing entry for decision /,
      /^decision registry contains unknown decision /,
      /^docs\/decisions\/REGISTRY\.md modified or removed existing rows from HEAD; registry is append-only$/,
      /^new decision block .* missing Reopen-trigger field$/,
      /^new decision block .* has unknown Reopen-trigger: /,
      /^inspected decision registry with \d+ entries$/,
      /^\.ai\/TASK\.md requires exactly one Status line$/,
      /^no active task; owner supplies the next objective$/,
      /^task status: /,
      /^\.ai\/TASK\.md has an invalid Status; use In progress, Completed, Blocked, Planned or No active task$/,
      /^\d+ committed decision blocks are unchanged$/,
      /^no committed \.ai\/DECISIONS\.md to compare against; immutability guarantee is OFF until \.ai\/ is committed to Git \(run: git add \.ai && git commit\)$/,
      /^(?:PROTO-)?DEC-\d{4} was edited after it was written; a decision block is never rewritten$/,
      /^(?:PROTO-)?DEC-\d{4} was deleted; a decision block is never removed$/,
    ],
  },
  {
    section: 'gate-structure',
    cm: ['CM-34', 'CM-35', 'CM-36', 'CM-37', 'CM-38', 'CM-39'],
    patterns: [
      /^completed task requires a ## Completion gate section with an adversarial prompt and independent review$/,
      /^completed task is missing its (?:adversarial review prompt|independent review) field$/,
      /^(?:adversarial review prompt|independent review) must be a safe path inside the repository root: /,
      /^independent review must be a safe path inside the repository root: /,
      /^in source repository, (?:adversarial review prompt|independent review) must be under docs\/reviews\/: /,
      /^completed task (?:adversarial review prompt|independent review) is missing: /,
      /^completed task independent review is missing: /,
      /^completed task (?:adversarial review prompt|independent review) must not be empty: /,
      /^completed task independent review must not be empty: /,
      /^adversarial review prompt must identify a unified adversarial audit prompt: /,
      /^completion gate prompt found: /,
      /^adversarial prompt and independent review must be separate artifacts$/,
      /^independent review .* is transcribed; transcribed reviews cannot satisfy the independent review gate$/,
      /^independent review .*; advisory reviews cannot satisfy the independent review gate$/,
      /^WARN: legacy review missing (?:Mode: CERTIFYING|Receipt-Owner)$/,
      /^independent review must name a Reviewer: /,
      /^independent review must have a PASS or RECOMMENDATION verdict: /,
      /^independent review certified \(light path: /,
      /^independent review certified: /,
      /^completed task cites (?:missing|empty) review artifact: /,
      /^gate-check: /,
      /^gate-check skipped during evidence recording$/,
      /^completion gate verified fresh by gate-check$/,
    ],
  },
  {
    section: 'platform',
    cm: ['CM-20', 'CM-25', 'CM-26', 'CM-27', 'CM-28', 'CM-29', 'CM-40', 'CM-41', 'CM-42',
      'CM-43', 'CM-46'],
    patterns: [
      /^PowerShell syntax in .+: /,
      /^CLAUDE\.md imports AGENTS\.md$/,
      /^CLAUDE\.md must import @AGENTS\.md on its own line$/,
      /^invalid Claude settings JSON: /,
      /^(?:SessionStart|Stop) protocol hook command configured$/,
      /^(?:SessionStart|Stop) must configure exactly one canonical protocol hook command$/,
      /^node is unavailable; protocol hooks require Node\.js on PATH$/,
      /^Node\.js cannot run$/,
      /^Node\.js available: /,
      /^hook module syntax: /,
      /^hook module JavaScript syntax: /,
      /^invalid Codex hooks: /,
      /^Codex (?:SessionStart|Stop) protocol hook configured \(host trust checked separately\)$/,
      /^working Bash unavailable; install Git Bash and configure Claude to use it$/,
      /^Bash available: /,
      /^hook shell syntax in (?:session-start|stop-worklog-check)\.sh: /,
      /^hook shell syntax: (?:session-start|stop-worklog-check)\.sh$/,
      /^\.claude\/settings(?:\.local)?\.json sets disableAllHooks; protocol enforcement is off while this check would otherwise pass$/,
      /^Git does not ignore [^;]+; session state can reach a commit$/,
      /^cannot determine the ignore rule for /,
      /^one protocol version everywhere: /,
      / says .+; protocol-manifest\.json says /,
      /^content digest for .* is malformed$/,
      /^.* differs from the installed protocol content; it is a document the host may reconcile\. Run -Force to take the canonical copy\.$/,
      /^.* is not the content this protocol version installed; a partial upgrade or a hand edit\. Run node \.ai\/bin\/protocol-setup\.cjs --Force from the protocol source repository\.$/,
      /^verified \d+ managed content digest\(s\)$/,
      /^installed project; the installer lives in the protocol source repository$/,
      /^installer absent; its self-check cannot run and was not skipped quietly$/,
      /^installer self-check runs$/,
      /^installer cannot run: /,
    ],
  },
];

// Normalize only path and parser details that vary across fixtures.
function normalize(line, root) {
  let out = line.replace(/\r$/, '');
  for (const variant of [root, root.split('\\').join('/')].sort((a, b) => b.length - a.length)) {
    out = out.split(variant).join('<ROOT>');
  }
  out = out.replace(/^(.*is not valid JSON:) .*$/, '$1 <parser-error>');
  out = out.replace(/^(.*invalid Claude settings JSON:) .*$/, '$1 <parser-error>');
  out = out.replace(/^(.*invalid Codex hooks:) .*$/, '$1 <parser-error>');
  return out;
}

function lines(output) {
  return output.split(/\r?\n/).filter(line => line.length > 0);
}

function validateCase(name, root, args = []) {
  const result = run(process.execPath, [nodeCli, '--root', root, ...args], root);
  assert.equal(result.error, undefined, `${name}: ${String(result.error)}`);
  const output = result.stdout + result.stderr;
  const rendered = lines(output).map(line => normalize(line, root));
  const summary = rendered[rendered.length - 1];
  assert.match(summary, /^Protocol (?:OK\. \d+ warning\(s\)\.|BROKEN\. \d+ failure\(s\), \d+ warning\(s\)\.)$/, `${name}: summary grammar`);
  const failures = rendered.filter(line => line.startsWith('[FAIL]')).length;
  const ok = summary.startsWith('Protocol OK.');
  assert.equal(ok, failures === 0, `${name}: summary disagrees with FAIL lines`);
  assert.equal(ok, result.status === 0, `${name}: exit code disagrees with summary`);
  return { node: output };
}

test('validator-output: this tree, full output', () => {
  validateCase('this-tree', repoRoot);
});

test('validator-output: this tree, quiet mode suppresses PASS lines only', () => {
  const { node } = validateCase('this-tree-quiet', repoRoot, ['--quiet']);
  assert.equal(/^\[PASS\]/m.test(node), false, 'Node --quiet printed a PASS line');
  assert.match(node, /Protocol (?:OK|BROKEN)\./);
});

test('validator-output: fresh protocol fixture', t => {
  const root = makeProtocolFixture(t);
  const output = validateCase('fresh-fixture', root);
  assert.match(output.node, /no active task/);
  assert.match(output.node, /inspected \d+ protocol-owned text files/);
});

test('validator-output: encoding defects (BOM, invalid UTF-8, NUL, CR, non-ASCII ps1)', t => {
  const root = makeProtocolFixture(t);
  write(root, 'AGENTS.md', '\ufeff' + fs.readFileSync(path.join(root, 'AGENTS.md'), 'utf8'));
  fs.writeFileSync(path.join(root, '.ai', 'docs', 'bad-encoding.md'), Buffer.from([0x61, 0xc3, 0x28, 0x62]));
  fs.writeFileSync(path.join(root, '.ai', 'docs', 'bad-nul.md'), Buffer.from([0x61, 0x00, 0x62]));
  fs.writeFileSync(path.join(root, '.claude', 'hooks', 'bad-ascii.ps1'), 'Write-Host \'caf\u00e9\'\n');
  write(root, '.ai/PLAN.md', fs.readFileSync(path.join(root, '.ai', 'PLAN.md'), 'utf8').split('\n').join('\r\n'));
  const { node } = validateCase('encoding-defects', root);
  for (const engine of [node]) {
    assert.match(engine, /\[FAIL\] byte order mark present: AGENTS\.md/);
    assert.match(engine, /\[FAIL\] invalid UTF-8: \.ai\/docs\/bad-encoding\.md/);
    assert.match(engine, /\[FAIL\] NUL byte in text \(possibly UTF-16\): \.ai\/docs\/bad-nul\.md/);
    assert.match(engine, /\[FAIL\] non-ASCII byte in PowerShell script: \.claude\/hooks\/bad-ascii\.ps1/);
    assert.match(engine, /\[FAIL\] CR\/CRLF found; use LF line endings: \.ai\/PLAN\.md/);
    assert.match(engine, /Protocol BROKEN\./);
  }
});

test('validator-output: repository defects (missing required file, line-limit overflow)', t => {
  const root = makeProtocolFixture(t);
  fs.rmSync(path.join(root, 'CLAUDE.md'));
  write(root, '.ai/PLAN.md', 'line\n'.repeat(1001));
  const { node } = validateCase('repository-defects', root);
  for (const engine of [node]) {
    assert.match(engine, /\[FAIL\] missing file: CLAUDE\.md/);
    assert.match(engine, /\[FAIL\] \.ai\/PLAN\.md: 1001 lines exceeds limit of 1000/);
    assert.match(engine, /Protocol BROKEN\./);
  }
});

test('validator-output: missing manifest', t => {
  const root = makeProtocolFixture(t);
  fs.rmSync(path.join(root, 'protocol-manifest.json'));
  const { node } = validateCase('missing-manifest', root);
  for (const engine of [node]) {
    assert.match(engine, /\[FAIL\] missing file: protocol-manifest\.json/);
    assert.match(engine, /Protocol BROKEN\./);
  }
});

test('validator-output: invalid manifest JSON', t => {
  const root = makeProtocolFixture(t);
  write(root, 'protocol-manifest.json', '{ not json');
  const { node } = validateCase('invalid-manifest', root);
  for (const engine of [node]) {
    assert.match(engine, /\[FAIL\] protocol-manifest\.json is not valid JSON:/);
    assert.match(engine, /Protocol BROKEN\./);
  }
});

test('validator-output: PowerShell script syntax error (CM-20 subprocess boundary)', t => {
  const root = makeProtocolFixture(t);
  write(root, '.claude/hooks/bad-syntax.ps1', 'if ($true) {\n');
  const { node } = validateCase('ps-syntax', root);
  for (const engine of [node]) {
    assert.match(engine, /\[FAIL\] PowerShell syntax in \.claude\/hooks\/bad-syntax\.ps1: /);
    assert.match(engine, /Protocol BROKEN\./);
  }
});

test('validator-output: review corpus budget exceeded (CM-23)', t => {
  const root = makeProtocolFixture(t);
  for (let index = 0; index < 401; index++) {
    write(root, `docs/reviews/r${index}.md`, 'x\n');
  }
  const { node } = validateCase('review-budget', root);
  for (const engine of [node]) {
    assert.match(engine,
      /\[WARN\] active docs\/reviews\/ exceeds budget \(401 files \/ [\d.,]+ KB; limit 400 files \/ 8192 KB, PROTO-DEC-0150\); archive non-active reviews to docs\/reviews\/archive\//);
  }
});

test('validator-output: decision immutability vs HEAD (CM-44: unchanged, edited, deleted)', t => {
  const root = makeProtocolFixture(t);
  const block = '### DEC-0001\n\nStatus: Accepted\nDate: 2026-01-01\nApproved by: Tester\n\nBody text.\n\n---\n';
  write(root, '.ai/DECISIONS.md', '# Decisions\n\n' + block);
  git(root, ['add', '.ai/DECISIONS.md']);
  git(root, ['commit', '-m', 'decisions']);
  let output = validateCase('decision-unchanged', root);
  for (const engine of [output.node]) {
    assert.match(engine, /\[PASS\] 1 committed decision blocks are unchanged/);
  }
  write(root, '.ai/DECISIONS.md', '# Decisions\n\n' + block.replace('Body text.', 'Body text edited.'));
  output = validateCase('decision-edited', root);
  for (const engine of [output.node]) {
    assert.match(engine, /\[FAIL\] DEC-0001 was edited after it was written; a decision block is never rewritten/);
    assert.match(engine, /Protocol BROKEN\./);
  }
  write(root, '.ai/DECISIONS.md', '# Decisions\n');
  output = validateCase('decision-deleted', root);
  for (const engine of [output.node]) {
    assert.match(engine, /\[FAIL\] DEC-0001 was deleted; a decision block is never removed/);
    assert.match(engine, /Protocol BROKEN\./);
  }
});

test('validator-output: journal Agent-line mismatch (CM-45)', t => {
  const root = makeProtocolFixture(t);
  write(root, '.ai/worklog/vibe-test01234567.md',
    '## 2026-09-30 - probe\n\nAgent: claude\n\nAction: a\n\nResult: r\n\nNext step: n\n\nOpen: o\n');
  const { node } = validateCase('journal-agent', root);
  for (const engine of [node]) {
    assert.match(engine,
      /\[WARN\] vibe-test01234567\.md holds an entry whose Agent line does not name vibe/);
  }
});

// Case-mutated registry rows must still produce both coverage WARNs and the append-only WARN.
test('validator-output: case-mutated registry row vs HEAD (CM-32)', t => {
  const root = makeProtocolFixture(t);
  const block = '### DEC-0001\n\nStatus: Accepted\nDate: 2026-01-01\nApproved by: Tester\n\nBody text.\n\n---\n';
  write(root, '.ai/DECISIONS.md', '# Decisions\n\n' + block);
  const registry = table => '# Decision registry\n\n' +
    '| Decision | Status | Reopen-trigger | Frozen at | Supersedes | Evidence |\n' +
    '| --- | --- | --- | --- | --- | --- |\n' + table;
  write(root, 'docs/decisions/REGISTRY.md', registry('| DEC-0001 | accepted | none | | | |\n'));
  git(root, ['add', '.ai/DECISIONS.md', 'docs/decisions/REGISTRY.md']);
  git(root, ['commit', '-m', 'registry baseline']);
  write(root, 'docs/decisions/REGISTRY.md', registry('| dec-0001 | accepted | none | | | |\n'));
  const { node } = validateCase('registry-case-mutation', root);
  for (const engine of [node]) {
    assert.match(engine, /\[WARN\] decision registry missing entry for decision DEC-0001/);
    assert.match(engine, /\[WARN\] decision registry contains unknown decision dec-0001/);
    assert.match(engine,
      /\[WARN\] docs\/decisions\/REGISTRY\.md modified or removed existing rows from HEAD; registry is append-only/);
  }
});

test('validator-output: invalid Claude settings and Codex hooks JSON (parser-tail normalization)', t => {
  const root = makeProtocolFixture(t);
  write(root, '.claude/settings.json', '{ not json');
  write(root, '.codex/hooks.json', '[broken');
  const { node } = validateCase('invalid-hooks-json', root);
  for (const engine of [node]) {
    assert.match(engine, /\[FAIL\] invalid Claude settings JSON: /);
    assert.match(engine, /\[FAIL\] invalid Codex hooks: /);
    assert.match(engine, /Protocol BROKEN\./);
  }
});

test('Node CLI rejects unknown arguments', () => {
  const result = run('node', [nodeCli, '--root', repoRoot, '--bogus'], repoRoot);
  assert.notEqual(result.status, 0);
  assert.match(result.stdout + result.stderr, /unknown argument/);
});

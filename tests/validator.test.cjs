'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const nodeCli = path.join(__dirname, '..', '.ai', 'bin', 'protocol-validate.cjs');
const os = require('node:os');
const {
  makeProtocolFixture, makeFixture, seedProtocol, runPowerShell, git, write, run,
} = require('./helpers.cjs');

const { validate: validateApi } = require('../.ai/bin/protocol-validate.cjs');
const { tt } = require('./helpers.cjs');

function validate(root) {
  const result = validateApi(root);
  const outLines = [
    'AI Collaboration Protocol - validation',
    `Root: ${root}`,
  ];
  for (const diag of result.diagnostics) {
    if (diag.status === 'PASS') continue;
    outLines.push(`[${diag.status}] ${diag.message}`);
  }
  if (result.exitCode === 0) {
    outLines.push(`Protocol OK. ${result.counts.warn} warning(s).`);
  } else {
    outLines.push(`Protocol BROKEN. ${result.counts.fail} failure(s), ${result.counts.warn} warning(s).`);
  }
  const text = outLines.join('\n') + '\n';
  return { status: result.exitCode, stdout: text, stderr: '', output: text };
}

function succeeds(root) {
  const result = validate(root);
  assert.equal(result.status, 0, result.output);
  return result.output;
}

function fails(root, expected) {
  const result = validate(root);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, expected);
  return result.output;
}

function decision(fields = 'Status: Accepted\nDate: 2026-09-11\nApproved by: Test Owner\n', id = '0001') {
  return `# Decisions\n\n### DEC-${id}\n\n${fields}`;
}

// FR-1: git blob SHA of content (SHA-1 of "blob <size>\0<content>"), the same
// identity the boundary manifest freezes a legacy review with.
function gitBlob(content) {
  const body = Buffer.from(content, 'utf8');
  const header = Buffer.from(`blob ${body.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([header, body])).digest('hex');
}

test('a fresh protocol instance validates and reports its idle task', t => {
  const root = makeProtocolFixture(t);
  assert.match(succeeds(root), /no active task/);
});

test('junction escape outside repository root fails safe path check in validator', t => {
  const root = makeProtocolFixture(t);
  const manifestPath = path.join(root, 'protocol-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.role = 'installed';
  // FR-1 (owner item 3, launch defect 3): the fixture carries its own boundary
  // manifest, so the old-dated review below is legacy by the manifest rule
  // (path + blob), never by the Date-rule fallback a missing manifest file
  // triggers. The 2c corpus-manifest source seeding was the regression cause:
  // with that manifest loaded this unlisted review fell to the full certifying
  // rules and the in-root leg failed with 'declares no Mode'.
  const inRootReview = '# Independent review\n\nDate: 2026-09-19\nReviewer: auditor\nVerdict: PASS\n';
  manifest.legacyBoundaryManifest = 'docs/research/fr1/FIXTURE-MANIFEST.json';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  write(root, 'docs/research/fr1/FIXTURE-MANIFEST.json', JSON.stringify({
    manifest_version: 1,
    boundary: [{ path: 'custom-reviews/review.md', blob: gitBlob(inRootReview) }],
  }, null, 2) + '\n');

  // Normal owner-selected in-root path exits 0
  write(root, '.ai/TASK.md', '# Current Task\n\nStatus: Completed.\n\n## Completion gate\n\n' +
    '- Adversarial review prompt: custom-reviews/prompt.md\n' +
    '- Independent review: custom-reviews/review.md\n');
  write(root, 'custom-reviews/prompt.md', '# Unified Adversarial Audit Prompt: valid\n\nValid.\n');
  write(root, 'custom-reviews/review.md', inRootReview);
  succeeds(root);

  // Junction pointing outside root fails validator with exit 1 (guarded for Windows-only)
  if (process.platform === 'win32') {
    const outside = tt.mkTmp('colabs-junc-outside-');
    t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

    fs.writeFileSync(path.join(outside, 'prompt.md'), '# Unified Adversarial Audit Prompt: escape\n');
    fs.writeFileSync(path.join(outside, 'review.md'), '# Independent review\n\nDate: 2026-09-19\nReviewer: auditor\nVerdict: PASS\n');

    const link = path.join(root, 'docs/reviews/junc-link');
    fs.mkdirSync(path.join(root, 'docs/reviews'), { recursive: true });
    fs.symlinkSync(outside, link, 'junction');

    write(root, '.ai/TASK.md', '# Current Task\n\nStatus: Completed.\n\n## Completion gate\n\n' +
      '- Adversarial review prompt: docs/reviews/junc-link/prompt.md\n' +
      '- Independent review: docs/reviews/junc-link/review.md\n');
    fails(root, /must be a safe path inside the repository root/);
  }
});

test('required protocol state is inspected even when Git ignores it', t => {
  const root = makeProtocolFixture(t);
  fs.appendFileSync(path.join(root, '.gitignore'), '\n.ai/\n');
  write(root, '.ai/TASK.md', 'Status: In progress\r\n');
  fails(root, /CR\/CRLF found.*\.ai\/TASK\.md/);
});

test('line limits count a final newline correctly, with and without it', t => {
  const root = makeProtocolFixture(t);
  for (const finalNewline of [true, false]) {
    write(root, '.ai/TASK.md', ['Status: In progress', ...Array(79).fill('line')].join('\n') + (finalNewline ? '\n' : ''));
    write(root, '.ai/PLAN.md', Array(1000).fill('line').join('\n') + (finalNewline ? '\n' : ''));
    write(root, '.ai/worklog/custom.md', Array(150).fill('line').join('\n') + (finalNewline ? '\n' : ''));
    succeeds(root);
  }
  fs.appendFileSync(path.join(root, '.ai/TASK.md'), '\none too many\n');
  fails(root, /TASK\.md: 81 lines exceeds limit of 80/);
});

test('PLAN.md line limit is 1000 (PROTO-DEC-0150 item 3)', t => {
  const root = makeProtocolFixture(t);
  write(root, '.ai/PLAN.md', Array(1001).fill('line').join('\n') + '\n');
  fails(root, /PLAN\.md: 1001 lines exceeds limit of 1000/);
});

test('a directory named .git does not prove a valid working tree', t => {
  const root = makeProtocolFixture(t);
  fs.renameSync(path.join(root, '.git'), path.join(root, 'original-git'));
  fs.mkdirSync(path.join(root, '.git'));
  fails(root, /not a valid Git working tree/);
});

test('Git history command failures are failures instead of empty-history warnings', t => {
  const root = makeProtocolFixture(t);
  write(root, '.git/refs/heads/broken', 'not-an-object-id\n');
  fails(root, /cannot read Git history/);
});

test('linked worktrees with .git files validate', t => {
  const root = makeFixture(t);
  const linked = path.join(root, 'linked project');
  const result = git(root, ['worktree', 'add', '--detach', linked, 'HEAD']);
  assert.equal(result.status, 0, result.stderr);
  seedProtocol(linked);
  assert.ok(fs.statSync(path.join(linked, '.git')).isFile());
  succeeds(linked);
});

test('a protocol instance in a parent repository requires its own root', t => {
  const root = makeFixture(t);
  const nested = path.join(root, 'nested');
  seedProtocol(nested);
  fails(nested, /protocol root is inside another repository/);
});

test('C40-06: in-root junction is rejected by path safety check', t => {
  const root = makeProtocolFixture(t);
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'Base commit']);
  const baseline = git(root, ['rev-parse', 'HEAD']).stdout.trim();

  write(root, 'docs/user-guide.md', '# User Guide\n\nSome doc content.\n');
  fs.mkdirSync(path.join(root, 'docs', 'target-dir'), { recursive: true });
  write(root, 'docs/target-dir/guide-review.md', 'Reviewer: docs-auditor\nVerdict: PASS\n');

  try {
    fs.symlinkSync(path.join(root, 'docs', 'target-dir'), path.join(root, 'docs', 'link-dir'), 'junction');
  } catch {
    t.skip('Filesystem does not permit junctions in this test environment');
    return;
  }

  write(root, '.ai/TASK.md', '# Current Task\n\nStatus: Completed.\n\n## Completion gate\n\n' +
    '- Scope: docs\n' +
    `- Baseline: ${baseline}\n` +
    '- Independent review: docs/link-dir/guide-review.md\n');

  fails(root, /must be a safe path inside the repository root/);
});

test('C40-07: non-.md files and nested subdirectories in docs/reviews are counted towards corpus budget', t => {
  const root = makeProtocolFixture(t);
  fs.mkdirSync(path.join(root, 'docs', 'reviews', 'sub'), { recursive: true });
  for (let i = 0; i < 401; i++) {
    write(root, `docs/reviews/sub/file${i}.txt`, 'review content\n');
  }

  const out = validate(root).output;
  assert.match(out, /active docs\/reviews\/ exceeds budget \(401 files/);
});

test('C40-07: docs/reviews/archive is excluded from corpus budget count', t => {
  const root = makeProtocolFixture(t);
  fs.mkdirSync(path.join(root, 'docs', 'reviews', 'archive'), { recursive: true });
  for (let i = 0; i < 205; i++) {
    write(root, `docs/reviews/archive/archived${i}.md`, 'archived review\n');
  }

  const out = validate(root).output;
  assert.doesNotMatch(out, /active docs\/reviews\/ exceeds budget/);
});

test('C40-07: corpus byte limit triggers warning independently of file count', t => {
  const root = makeProtocolFixture(t);
  fs.mkdirSync(path.join(root, 'docs', 'reviews'), { recursive: true });
  const largeBuf = Buffer.alloc(8300 * 1024, 'a');
  fs.writeFileSync(path.join(root, 'docs', 'reviews', 'large-review.md'), largeBuf);

  const out = validate(root).output;
  assert.match(out, /active docs\/reviews\/ exceeds budget/);
});

test('C40-07: junction / symlink outside root in docs/reviews is not traversed by corpus check', t => {
  const root = makeProtocolFixture(t);
  if (process.platform !== 'win32') {
    t.skip('Windows junction test only');
    return;
  }
  const outside = tt.mkTmp('colabs-corpus-outside-');
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));

  // Create 405 files outside root (above the PROTO-DEC-0150 cap of 400)
  for (let i = 0; i < 405; i++) {
    fs.writeFileSync(path.join(outside, `outside-review-${i}.md`), 'content\n');
  }

  // Create junction inside docs/reviews pointing outside
  fs.mkdirSync(path.join(root, 'docs', 'reviews'), { recursive: true });
  const link = path.join(root, 'docs', 'reviews', 'outside-link');
  try {
    fs.symlinkSync(outside, link, 'junction');
  } catch {
    t.skip('Filesystem does not permit junctions in this test environment');
    return;
  }

  const out = validate(root).output;
  assert.doesNotMatch(out, /active docs\/reviews\/ exceeds budget/);
});

// CM-70: encoding guard (PROTO-DEC-0153 item 7). Only tracked files under
// .ai/, docs/ and  are in scope, so fixtures stage the bad file with
// git add. The mojibake fragments are built from escapes: this test file must
// not carry mojibake bytes itself.
function stage(root, relatives) {
  const result = git(root, ['add', ...relatives]);
  assert.equal(result.status, 0, result.stderr);
}

test('CM-70: a tracked UTF-16 BOM file fails the encoding guard', t => {
  const root = makeProtocolFixture(t);
  write(root, '.ai/docs/utf16-bom.md', Buffer.from([0xff, 0xfe, 0x41, 0x00, 0x0a, 0x00]));
  stage(root, ['.ai/docs/utf16-bom.md']);
  const out = fails(root, /\[FAIL\] CM-70 UTF-16 BOM: \.ai\/docs\/utf16-bom\.md/);
  assert.match(out, /Protocol BROKEN\./);
});

test('CM-70: a tracked mojibake signature warns without failing the run', t => {
  const root = makeProtocolFixture(t);
  // U+0420 U+00B5 U+0420: the CP1251 reading of a UTF-8 Cyrillic byte pair.
  write(root, '.ai/docs/mojibake.md', '\u0420\u00b5\u0420\u0435 \u0434\u0430\n');
  stage(root, ['.ai/docs/mojibake.md']);
  const out = succeeds(root);
  assert.match(out, /\[WARN\] CM-70 mojibake: \.ai\/docs\/mojibake\.md/);
});

test('CM-70: a clean tracked tree emits no encoding-guard lines', t => {
  const root = makeProtocolFixture(t);
  write(root, '.ai/docs/clean.md', 'Clean ASCII text.\n');
  stage(root, ['.ai/docs/clean.md']);
  const out = succeeds(root);
  assert.doesNotMatch(out, /CM-70/);
});

test('CM-70: allowlist entries match exactly and with a trailing glob', t => {
  const root = makeProtocolFixture(t);
  write(root, '.ai/docs/allowlisted.md', '\u0420\u00b5\u0420\u0435\n');
  write(root, '.ai/docs/allowlisted-glob.md', '\u0421\u0402\u0420\u0430\n');
  write(root, '.ai/encoding-allowlist.txt', [
    '# encoding guard allowlist',
    '.ai/docs/allowlisted.md',
    '.ai/docs/allowlisted-*',
    '',
  ].join('\n'));
  stage(root, ['.ai/docs/allowlisted.md', '.ai/docs/allowlisted-glob.md',
    '.ai/encoding-allowlist.txt']);
  const out = succeeds(root);
  assert.doesNotMatch(out, /CM-70/);
});

test('CM-70: the report caps hits at 20 lines and summarizes the rest', t => {
  const root = makeProtocolFixture(t);
  const relatives = [];
  for (let index = 0; index < 23; index++) {
    const relative = `.ai/docs/moji-${String(index).padStart(2, '0')}.md`;
    write(root, relative, `\u0420\u00b5\u0420-${index}\n`);
    relatives.push(relative);
  }
  stage(root, relatives);
  const out = succeeds(root);
  const hits = out.split(/\r?\n/).filter(line => line.includes('CM-70 mojibake:') &&
    !line.includes('more'));
  assert.equal(hits.length, 20, out);
  assert.match(out, /\[WARN\] CM-70 mojibake: \+3 more/);
});

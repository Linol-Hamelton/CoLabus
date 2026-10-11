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

// FR-1: Compute git blob SHA for a file (SHA-1 of "blob <size>\0<content>")
function gitBlob(content) {
  const body = Buffer.from(content, 'utf8');
  const header = Buffer.from(`blob ${body.length}\0`, 'utf8');
  return crypto.createHash('sha1').update(Buffer.concat([header, body])).digest('hex');
}

const { validate: validateApi } = require('../.ai/bin/protocol-validate.cjs');

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

function validatePS(root) {
  const psWrapper = path.join(root, 'validate-protocol.ps1');
  if (!fs.existsSync(psWrapper)) {
    fs.writeFileSync(psWrapper, 'param([switch]$Quiet)\n& node "$PSScriptRoot\\.ai\\bin\\protocol-validate.cjs" --root $PSScriptRoot $(if ($Quiet) { "--quiet" })\nexit $LASTEXITCODE\n', 'ascii');
  }
  const result = runPowerShell('validate-protocol.ps1', ['-Quiet'], root);
  return { status: result.status, output: (result.stdout || '') + (result.stderr || '') };
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

test('completed tasks require a prompt and independent review completion gate', { timeout: 20000 }, t => {
  const root = makeProtocolFixture(t);
  // The gate mechanics this test probes are role-agnostic, and since P2 its
  // certifying fixtures carry a Receipt-Owner. In the source role the strict
  // path hands the same gate to the Node gate-check (R1), which also verifies
  // the receipt journal and would turn every mechanics probe into a receipt
  // probe. Run the mechanics in the installed role and drop to source only for
  // the path-restriction probe; the Mode whitelist itself is covered in both
  // roles by the A-1 and P2 matrices below.
  const manifestPath = path.join(root, 'protocol-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.role = 'installed';
  // FR-1 (owner item 2,  item 3): this fixture carries its own
  // boundary manifest instead of inheriting the repository corpus manifest, so
  // the legacy rule is pinned here in both directions: the review below is
  // listed with its exact blob (listed legacy report -> accepted), while every
  // rewrite changes the blob (unlisted old-dated report -> full certifying
  // rules). The manifest must exist; a missing manifest file would fall back
  // to the Date rule this test must not depend on.
  const legacyPassReview = '# Independent review\n\nDate: 2026-09-19\nReviewer: opposing-agent\nMode: CERTIFYING\nReceipt-Owner: opposing-agent\n\nVerdict: PASS\n';
  manifest.legacyBoundaryManifest = 'docs/research/fr1/FIXTURE-MANIFEST.json';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  write(root, 'docs/research/fr1/FIXTURE-MANIFEST.json', JSON.stringify({
    manifest_version: 1,
    boundary: [{ path: 'docs/reviews/review.md', blob: gitBlob(legacyPassReview) }],
  }, null, 2) + '\n');

  write(root, '.ai/TASK.md', '# Current Task\n\nStatus: Completed.\n');
  fails(root, /completed task requires a ## Completion gate/);
  // Real PowerShell 5.1 smoke 1: missing completion gate fails under PS 5.1
  const psSmoke1 = validatePS(root);
  assert.equal(psSmoke1.status, 1, psSmoke1.output);
  assert.match(psSmoke1.output, /completed task requires a ## Completion gate/);

  write(root, '.ai/TASK.md', '# Current Task\n\nStatus: Completed.\n\n## Completion gate\n\n' +
    '- Adversarial review prompt: docs/reviews/prompt.md\n' +
    '- Independent review: docs/reviews/review.md\n');
  write(root, 'docs/reviews/prompt.md', '# Unified adversarial audit prompt\n\n' +
    'This unified adversarial review prompt covers every changed item.\n');
  write(root, 'docs/reviews/review.md', legacyPassReview);
  succeeds(root);
  // Real PowerShell 5.1 smoke 2: compliant completion gate succeeds under PS 5.1
  const psSmoke2 = validatePS(root);
  assert.equal(psSmoke2.status, 0, psSmoke2.output);

  write(root, 'docs/reviews/review.md', '# Independent review\n\nDate: 2026-09-19\nReviewer: opposing-agent\nMode: CERTIFYING\nReceipt-Owner: opposing-agent\n\nVerdict: BLOCKED\n');
  // FR-1: the Verdict check runs on the WARN branch as well (PROTO-DEC-0133
  // item 2), and a BLOCKED verdict is refused with the certifying reason
  // pinned by the FR-1 matrix (case A), not the outer verdict wording.
  fails(root, /PASS or RECOMMENDATION/);
  // Real PowerShell 5.1 smoke 3: BLOCKED verdict fails under PS 5.1
  const psSmoke3 = validatePS(root);
  assert.equal(psSmoke3.status, 1, psSmoke3.output);
  assert.match(psSmoke3.output, /PASS or RECOMMENDATION/);

  // Separate artifacts required
  write(root, '.ai/TASK.md', '# Current Task\n\nStatus: Completed.\n\n## Completion gate\n\n' +
    '- Adversarial review prompt: docs/reviews/review.md\n' +
    '- Independent review: docs/reviews/review.md\n');
  fails(root, /must be separate artifacts/);

  // Reviewer required
  write(root, '.ai/TASK.md', '# Current Task\n\nStatus: Completed.\n\n## Completion gate\n\n' +
    '- Adversarial review prompt: docs/reviews/prompt.md\n' +
    '- Independent review: docs/reviews/review.md\n');
  write(root, 'docs/reviews/review.md', '# Independent review\n\nDate: 2026-09-19\nMode: CERTIFYING\nReceipt-Owner: opposing-agent\n\nVerdict: PASS\n');
  fails(root, /must name a Reviewer/);

  // Unified adversarial prompt required
  write(root, 'docs/reviews/review.md', '# Independent review\n\nDate: 2026-09-19\nReviewer: opposing-agent\nMode: CERTIFYING\nReceipt-Owner: opposing-agent\n\nVerdict: RECOMMENDATION\n');
  write(root, 'docs/reviews/prompt.md', '# Regular prompt\n\nPlease review.\n');
  fails(root, /must identify a unified adversarial audit prompt/);

  // Compliant with RECOMMENDATION succeeds
  write(root, 'docs/reviews/prompt.md', '# Unified adversarial audit prompt\n\nPrompt content.\n');
  succeeds(root);
  // Real PowerShell 5.1 smoke 4: RECOMMENDATION verdict succeeds under PS 5.1
  const psSmoke4 = validatePS(root);
  assert.equal(psSmoke4.status, 0, psSmoke4.output);

  // Empty prompt fails
  write(root, 'docs/reviews/prompt.md', '   \n\n');
  fails(root, /must not be empty/);
  write(root, 'docs/reviews/prompt.md', '# Unified adversarial audit prompt\n\nPrompt content.\n');

  // Empty review fails
  write(root, 'docs/reviews/review.md', '');
  fails(root, /must not be empty/);
  // Real PowerShell 5.1 smoke 5: empty review fails under PS 5.1
  const psSmoke5 = validatePS(root);
  assert.equal(psSmoke5.status, 1, psSmoke5.output);
  assert.match(psSmoke5.output, /must not be empty/);
  write(root, 'docs/reviews/review.md', '# Independent review\n\nDate: 2026-09-19\nReviewer: opposing-agent\nMode: CERTIFYING\nReceipt-Owner: opposing-agent\n\nVerdict: PASS\n');

  // Completed task citing missing review artifact in TASK.md fails
  write(root, '.ai/TASK.md', '# Current Task\n\nStatus: Completed.\n\nSee docs/reviews/missing-analysis.md.\n\n## Completion gate\n\n' +
    '- Adversarial review prompt: docs/reviews/prompt.md\n' +
    '- Independent review: docs/reviews/review.md\n');
  fails(root, /cites missing review artifact/);

  // Completed task citing existing review artifact succeeds
  write(root, 'docs/reviews/missing-analysis.md', '# Analysis\n\nContent.\n');
  succeeds(root);

  // Completed task citing empty review artifact fails
  write(root, 'docs/reviews/missing-analysis.md', '   \n');
  fails(root, /cites empty review artifact/);

  // In source role, paths outside docs/reviews/ fail
  manifest.role = 'source';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  write(root, '.ai/TASK.md', '# Current Task\n\nStatus: Completed.\n\n## Completion gate\n\n' +
    '- Adversarial review prompt: custom-reviews/prompt.md\n' +
    '- Independent review: custom-reviews/review.md\n');
  write(root, 'custom-reviews/prompt.md', '# Unified adversarial audit prompt\n\nPrompt content.\n');
  write(root, 'custom-reviews/review.md', '# Independent review\n\nDate: 2026-09-19\nReviewer: opposing-agent\nMode: CERTIFYING\nReceipt-Owner: opposing-agent\n\nVerdict: PASS\n');
  fails(root, /in source repository, adversarial review prompt must be under docs\/reviews\//);

  // In installed role, owner-selected safe in-root review path outside docs/reviews/ succeeds
  manifest.role = 'installed';
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  succeeds(root);

  // Path traversal in completion gate fails safe path check
  write(root, '.ai/TASK.md', '# Current Task\n\nStatus: Completed.\n\n## Completion gate\n\n' +
    '- Adversarial review prompt: ../outside-prompt.md\n' +
    '- Independent review: custom-reviews/review.md\n');
  fails(root, /must be a safe path inside the repository root/);

  // Template 4 exact title Unified Adversarial Audit Prompt passes, old title without unified fails
  write(root, '.ai/TASK.md', '# Current Task\n\nStatus: Completed.\n\n## Completion gate\n\n' +
    '- Adversarial review prompt: docs/reviews/prompt.md\n' +
    '- Independent review: docs/reviews/review.md\n');
  write(root, 'docs/reviews/review.md', '# Independent review\n\nDate: 2026-09-19\nReviewer: opposing-agent\nMode: CERTIFYING\nReceipt-Owner: opposing-agent\n\nVerdict: PASS\n');
  write(root, 'docs/reviews/prompt.md', '# Unified Adversarial Audit Prompt: Wave A Remediation\n\nPrompt content.\n');
  succeeds(root);
  write(root, 'docs/reviews/prompt.md', '# Mandatory Adversarial Review Prompt: Wave A Remediation\n\nPrompt content.\n');
  fails(root, /must identify a unified adversarial audit prompt/);
});

test('F-5: Node validator review with header terminator on line 0 does not splice last line', { timeout: 20000 }, t => {
  const root = makeProtocolFixture(t);
  const promptRel = 'docs/reviews/2026-09-20-prompt.md';
  const reviewRel = 'docs/reviews/2026-09-20-review.md';
  write(root, '.ai/TASK.md', '# Current Task\n\nStatus: Completed.\n\n## Completion gate\n\n' +
    `- Adversarial review prompt: ${promptRel}\n` +
    `- Independent review: ${reviewRel}\n`);
  write(root, promptRel, '# Unified Adversarial Audit Prompt\n\nDate: 2026-09-20\nReviewer: auditor\n\nPrompt content.\n');
  // Line 0 is '---', followed by body with Reviewer and Verdict
  write(root, reviewRel, '---\nReviewer: auditor\nDate: 2026-09-20\nVerdict: PASS\n');

  fails(root, /independent review must name a Reviewer/);
});

// A-1, PROTO-DEC-0087 item 4. AGENTS.md section 2: an advisory output carries
// `[MODE: READ-ONLY ADVISORY]`, is non-certifying, and cannot satisfy the independent-review gate.
// The validator refused only an exact `Mode: ADVISORY`, and the installed role runs no gate-check.
const A1_PROMPT = 'docs/reviews/2026-09-28-a1-prompt.md';
const A1_REVIEW = 'docs/reviews/2026-09-28-a1-review.md';
const A1_FORMS = ['Mode: READ-ONLY ADVISORY', '[MODE: READ-ONLY ADVISORY]'];
const ADVISORY_REFUSED = /advisory reviews cannot satisfy the independent review gate/;

function a1Review(header, body = '') {
  return `# Independent review\n\nDate: 2026-09-28\nReviewer: opposing-agent\n${header}\nVerdict: PASS\n${body}`;
}

// Commits the role into a fresh baseline, since a changed manifest would force the strict path,
// then leaves one docs change for the light path. Returns the TASK.md text for both paths.
function a1Baseline(root, role) {
  const manifestPath = path.join(root, 'protocol-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.role = role;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', `A-1 ${role} baseline`]);
  const baseline = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  write(root, 'docs/user-guide.md', `# User Guide\n\nChanged after the ${role} baseline.\n`);
  write(root, A1_PROMPT, '# Unified Adversarial Audit Prompt\n\nPrompt content.\n');
  const task = gate => `# Current Task\n\nStatus: Completed.\n\n## Completion gate\n\n${gate}`;
  return {
    strict: task(`- Adversarial review prompt: ${A1_PROMPT}\n- Independent review: ${A1_REVIEW}\n`),
    light: task(`- Scope: docs\n- Baseline: ${baseline}\n- Independent review: ${A1_REVIEW}\n`),
  };
}

// Validates each review in turn and names every one the gate did not refuse as advisory. A
// light-path task that fell to the strict path fails on its missing prompt; that is no refusal.
function a1NotRefused(root, reviews) {
  const missed = [];
  for (const [label, review] of reviews) {
    write(root, A1_REVIEW, review);
    const { status, output } = validate(root);
    if (status !== 1 || !ADVISORY_REFUSED.test(output) || /missing its adversarial review prompt field/.test(output)) {
      missed.push(`${label} -> exit ${status}`);
    }
  }
  return missed;
}

test('A-1: a READ-ONLY ADVISORY review fails the completion gate in both roles and on both paths', { timeout: 60000 }, t => {
  const root = makeProtocolFixture(t);
  const missed = [];
  for (const role of ['installed', 'source']) {
    const tasks = a1Baseline(root, role);
    for (const [route, task] of Object.entries(tasks)) {
      write(root, '.ai/TASK.md', task);
      missed.push(...a1NotRefused(root, A1_FORMS.map(form => [`${role}/${route}/${form}`, a1Review(form)])));
      if (role === 'installed') {
        // Control: the same fixture with a certifying header passes, so the refusal is the form's.
        // P2 (ADV-005-3): a certifying header now also names its Receipt-Owner (AGENTS.md s.2).
        write(root, A1_REVIEW, a1Review('Mode: CERTIFYING\nReceipt-Owner: session-audit'));
        succeeds(root);
      }
    }
  }
  assert.deepEqual(missed, []);
});

test('A-1: advisory Mode values and markers are refused in any spelling, in the review header only', { timeout: 60000 }, t => {
  const root = makeProtocolFixture(t);
  write(root, '.ai/TASK.md', a1Baseline(root, 'installed').strict);
  const missed = a1NotRefused(root, [
    '- Mode: read-only advisory (owner-requested audit; certifies nothing)',
    '**Mode:** READ-ONLY ADVISORY',
    'Mode: CERTIFYING\nMode: READ-ONLY ADVISORY',
    '> [Mode: Read-Only Advisory]',
    // The exact rule refused this; a scan that consumed the first line would skip the second.
    '- Mode:\nMode:\nADVISORY',
  ].map(header => [JSON.stringify(header), a1Review(header)]));
  assert.deepEqual(missed, []);
  // The header region ends at the first `---` line. A certifying review that quotes both forms in
  // its body, as a review of this fix will, still passes.
  write(root, A1_REVIEW, a1Review('Mode: CERTIFYING\nReceipt-Owner: session-audit',
    '\n---\n\nMode: READ-ONLY ADVISORY and [MODE: READ-ONLY ADVISORY] now fail the gate.\n'));
  succeeds(root);
  // The review template explains the modes in an HTML comment above its first `---` and quotes the
  // marker there. A certifying review filled in from it, comments kept, still passes.
  const template = fs.readFileSync(path.join(root, 'templates', 'reviews', 'REVIEW.md'), 'utf8');
  write(root, A1_REVIEW, template.replace('**Mode**: CERTIFYING | ADVISORY', '**Mode**: CERTIFYING')
    .replace(/\*\*Verdict\*\*: \[[^\]\r\n]*\]/, '**Verdict**: PASS'));
  succeeds(root);
});

// P2 light-path checks
const P2_PROMPT = 'docs/reviews/2026-09-29-p2-prompt.md';
const P2_REVIEW = 'docs/reviews/2026-09-29-p2-review.md';
const P2_REFUSED = /advisory reviews cannot satisfy the independent review gate/;

function p2Review(header, body = '', date = '2026-09-29') {
  return `# Independent review\n\nDate: ${date}\nReviewer: opposing-agent\n${header}\nVerdict: PASS\n${body}`;
}

function p2Baseline(root, role) {
  const manifestPath = path.join(root, 'protocol-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.role = role;
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', `P2 ${role} baseline`]);
  const baseline = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  write(root, 'docs/user-guide.md', `# User Guide\n\nChanged after the ${role} baseline.\n`);
  write(root, P2_PROMPT, '# Unified Adversarial Audit Prompt\n\nPrompt content.\n');
  const task = gate => `# Current Task\n\nStatus: Completed.\n\n## Completion gate\n\n${gate}`;
  return {
    strict: task(`- Adversarial review prompt: ${P2_PROMPT}\n- Independent review: ${P2_REVIEW}\n`),
    light: task(`- Scope: docs\n- Baseline: ${baseline}\n- Independent review: ${P2_REVIEW}\n`),
  };
}

// ADV-007-3. The light path keeps the A-1 rule plus the F-005/F-008
// improvements and no whitelist: a review with no Mode declaration certifies,
// an ADVISORY Mode value and the marker (even across a newline) still refuse.
test('P2: the light path has no whitelist and refuses only ADVISORY forms, in both roles', { timeout: 60000 }, t => {
  const root = makeProtocolFixture(t);
  const missed = [];
  for (const role of ['installed', 'source']) {
    const tasks = p2Baseline(root, role);
    write(root, '.ai/TASK.md', tasks.light);

    // No Mode at all: Reviewer + Verdict PASS is the whole light contract.
    write(root, P2_REVIEW, p2Review(''));
    const noMode = validate(root);
    if (noMode.status !== 0) {
      missed.push(`no Mode ${role}/light -> exit ${noMode.status}`);
    }

    // An ADVISORY Mode value refuses.
    write(root, P2_REVIEW, p2Review('Mode: READ-ONLY ADVISORY'));
    const advisory = validate(root);
    if (advisory.status !== 1 || !P2_REFUSED.test(advisory.output)) {
      missed.push(`READ-ONLY ADVISORY ${role}/light -> exit ${advisory.status}`);
    }

    // The marker split across a newline refuses (F-005).
    write(root, P2_REVIEW, p2Review('> [MODE: READ-ONLY\nADVISORY]'));
    const split = validate(root);
    if (split.status !== 1 || !P2_REFUSED.test(split.output)) {
      missed.push(`split marker ${role}/light -> exit ${split.status}`);
    }

    // F-003: table cell with colon inside the cell: | Mode: ADVISORY |
    write(root, P2_REVIEW, p2Review('| Mode: ADVISORY |'));
    const tableColon = validate(root);
    if (tableColon.status !== 1 || !P2_REFUSED.test(tableColon.output)) {
      missed.push(`table cell with colon ${role}/light -> exit ${tableColon.status}`);
    }
  }
  assert.deepEqual(missed, []);
});

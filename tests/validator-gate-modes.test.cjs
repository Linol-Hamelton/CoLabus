'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const nodeCli = path.join(__dirname, '..', '.ai', 'bin', 'protocol-validate.cjs');
const os = require('node:os');
const { validate: validateApi } = require('../.ai/bin/protocol-validate.cjs');
const {
  makeProtocolFixture, makeFixture, seedProtocol, runPowerShell, git, write, run,
} = require('./helpers.cjs');

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
  git(root, ['commit', '-m', `light ${role} baseline`]);
  const baseline = git(root, ['rev-parse', 'HEAD']).stdout.trim();
  write(root, 'docs/user-guide.md', `# User Guide\n\nChanged after the ${role} baseline.\n`);
  write(root, P2_PROMPT, '# Unified Adversarial Audit Prompt\n\nPrompt content.\n');
  const task = gate => `# Current Task\n\nStatus: Completed.\n\n## Completion gate\n\n${gate}`;
  return {
    strict: task(`- Adversarial review prompt: ${P2_PROMPT}\n- Independent review: ${P2_REVIEW}\n`),
    light: task(`- Scope: docs\n- Baseline: ${baseline}\n- Independent review: ${P2_REVIEW}\n`),
  };
}

// Full-path refusal matrix. Each header hides or mutates the certifying
// declaration and must be refused with the advisory message. Every case
// certified under the earlier gate (except the plain double declaration, refused by the
// advisory value rule), which is what earlier reviews reported.
const P2_REFUSALS = [
  ['no Mode line', 'Receipt-Owner: session-audit'],
  ['SHADOW-CERTIFYING', 'Mode: SHADOW-CERTIFYING\nReceipt-Owner: session-audit'],
  ['READ-ONLY', 'Mode: READ-ONLY\nReceipt-Owner: session-audit'],
  ['marker split across a newline', 'Mode: CERTIFYING\nReceipt-Owner: session-audit\n> [MODE: READ-ONLY\nADVISORY]'],
  ['table cell', 'Receipt-Owner: session-audit\n| Mode | READ-ONLY ADVISORY |'],
  ['hash prefix', '#Mode: ADVISORY\nReceipt-Owner: session-audit'],
  ['fullwidth colon', 'Mode\uFF1AADVISORY\nReceipt-Owner: session-audit'],
  ['zero-width space after Mode', 'Mode\u200B: ADVISORY\nReceipt-Owner: session-audit'],
  // Table cell with colon inside the cell: | Mode: ADVISORY |
  ['table cell with colon', 'Receipt-Owner: session-audit\n| Mode: ADVISORY |'],
  // Mixed Mode: CERTIFYING line + | Mode: ADVISORY | table cell
  ['Mode: CERTIFYING plus table-cell with colon', 'Mode: CERTIFYING\n| Mode: ADVISORY |\nReceipt-Owner: session-audit'],
  // Plain double declaration: the advisory value rule already refuses the ADVISORY
  // line; the count rule must refuse the pair on its own as well.
  ['two plain Mode lines', 'Mode: CERTIFYING\nMode: ADVISORY'],
  // The ADVISORY line sits in a form the advisory line regex missed, so under the earlier gate
  // only the count rule can catch the pair.
  ['Mode: CERTIFYING plus a table-cell Mode', 'Mode: CERTIFYING\n| Mode | READ-ONLY ADVISORY |\nReceipt-Owner: session-audit'],
  ['Mode: CERTIFYING without Receipt-Owner or Session', 'Mode: CERTIFYING'],
];

// Full-path refusal matrix. Each header hides or mutates the certifying
// declaration and must be refused with the advisory message, in both roles.
test('the full-path completion gate is a Mode whitelist in both roles', { timeout: 120000 }, t => {
  const root = makeProtocolFixture(t);
  const missed = [];
  for (const role of ['installed', 'source']) {
    const tasks = p2Baseline(root, role);
    write(root, '.ai/TASK.md', tasks.strict);
    for (const [label, header] of P2_REFUSALS) {
      write(root, P2_REVIEW, p2Review(header));
      const { status, output } = validate(root);
      if (status !== 1 || !P2_REFUSED.test(output)) {
        missed.push(`${label} ${role}/strict -> exit ${status}`);
      }
    }
  }
  assert.deepEqual(missed, []);
});

// PROTO-DEC-0123 item 5b. The header
// region is normalized across the FORMS before any Mode read: table cells (the
// value inside the cell or in the adjacent cell on either side of the pipe),
// quotes, bold/italic, inline code, list items, HTML comments, extra spacing and
// case, and a non-breaking space (U+00A0) as the separator. The Mode field is
// then read only from the normalized report header. Regressions, both
// directions: (a) the light path REFUSES the canonical `| Mode | ADVISORY |`
// (an earlier gate accepted it); (b) the full path ACCEPTS the canonical
// `| Mode | CERTIFYING |` + Receipt-Owner (an earlier gate refused it).
// Corpus spellings covered here as well: `**Mode**: ADVISORY (...)` and
// `Mode: **ADVISORY**` appear in docs/reviews headers alongside the plain,
// list and list+bold forms asserted above.
const P5_REFUSED_FORMS = [
  ['plain line', 'Mode: ADVISORY'],
  ['canonical table cell', '| Mode | ADVISORY |'],
  ['table cell with colon', '| Mode: ADVISORY |'],
  ['table cell, value left of the pipe', '| ADVISORY | Mode |'],
  ['quote', '> Mode: ADVISORY'],
  ['bold', '**Mode:** ADVISORY'],
  ['italic', '*Mode*: ADVISORY'],
  ['inline code', '`Mode: ADVISORY`'],
  ['list item', '- Mode: ADVISORY'],
  ['numbered item', '1. Mode: ADVISORY'],
  ['html comment', '<!-- Mode: ADVISORY -->'],
  ['extra spaces and case', 'MODE :   advisory'],
  ['non-breaking space separator', 'Mode\u00A0:\u00A0ADVISORY'],
  ['bold value (corpus spelling)', 'Mode: **ADVISORY**'],
  ['bold field with parenthetical (corpus spelling)', '**Mode**: ADVISORY (PROTO-DEC-0038 item 2)'],
];

// A corpus spelling whose value is not CERTIFYING and contains no ADVISORY
// token (ADVERSARIAL is not ADVISORY): the light contract accepts it; only
// the full-path whitelist refuses the non-CERTIFYING value.
const P5_FULL_ONLY_REFUSALS = [
  ['mixed value (corpus spelling)', '**Mode**: CERTIFYING / ADVERSARIAL CHALLENGE'],
];

test('header modes: every header FORM declaring ADVISORY is refused on the light and the full path', { timeout: 240000 }, t => {
  const root = makeProtocolFixture(t);
  const missed = [];
  const tasks = p2Baseline(root, 'installed');
  for (const [label, header] of P5_REFUSED_FORMS) {
    write(root, P2_REVIEW, p2Review(header));
    write(root, '.ai/TASK.md', tasks.strict);
    const full = validate(root);
    if (full.status !== 1 || !P2_REFUSED.test(full.output)) {
      missed.push(`${label} full -> exit ${full.status}`);
    }
    write(root, '.ai/TASK.md', tasks.light);
    const light = validate(root);
    if (light.status !== 1 || !P2_REFUSED.test(light.output)) {
      missed.push(`${label} light -> exit ${light.status}`);
    }
  }
  assert.deepEqual(missed, []);
});

// The corpus spellings whose value is neither CERTIFYING nor ADVISORY: the
// light path (no whitelist) accepts them, the full-path whitelist refuses
// the non-CERTIFYING value. This is the path divergence by design.
test('header modes: a non-CERTIFYING value with no ADVISORY token is refused only by the full path', { timeout: 60000 }, t => {
  const root = makeProtocolFixture(t);
  const missed = [];
  const tasks = p2Baseline(root, 'installed');
  for (const [label, header] of P5_FULL_ONLY_REFUSALS) {
    write(root, P2_REVIEW, p2Review(header));
    write(root, '.ai/TASK.md', tasks.light);
    const light = validate(root);
    if (light.status !== 0) {
      missed.push(`${label} light -> exit ${light.status}`);
    }
    write(root, '.ai/TASK.md', tasks.strict);
    const full = validate(root);
    if (full.status !== 1 || !P2_REFUSED.test(full.output)) {
      missed.push(`${label} full -> exit ${full.status}`);
    }
  }
  assert.deepEqual(missed, []);
});

// The two canonical regressions, in both roles and both directions.
test('header modes: the canonical table-cell forms hold in both roles on both paths', { timeout: 240000 }, t => {
  const root = makeProtocolFixture(t);
  const missed = [];
  for (const role of ['installed', 'source']) {
    const tasks = p2Baseline(root, role);
    // (a) The light path must REFUSE `| Mode | ADVISORY |`.
    write(root, P2_REVIEW, p2Review('| Mode | ADVISORY |'));
    write(root, '.ai/TASK.md', tasks.light);
    const lightAdvisory = validate(root);
    if (lightAdvisory.status !== 1 || !P2_REFUSED.test(lightAdvisory.output)) {
      missed.push(`advisory cell light ${role} -> exit ${lightAdvisory.status}`);
    }
    // The full path refuses it as well.
    write(root, '.ai/TASK.md', tasks.strict);
    const fullAdvisory = validate(root);
    if (fullAdvisory.status !== 1 || !P2_REFUSED.test(fullAdvisory.output)) {
      missed.push(`advisory cell full ${role} -> exit ${fullAdvisory.status}`);
    }
    // (b) The full path must ACCEPT `| Mode | CERTIFYING |` + Receipt-Owner.
    write(root, P2_REVIEW, p2Review('| Mode | CERTIFYING |\nReceipt-Owner: session-audit'));
    write(root, '.ai/TASK.md', tasks.strict);
    const fullCertifying = validate(root);
    if (role === 'installed' && fullCertifying.status !== 0) {
      missed.push(`certifying cell full ${role} -> exit ${fullCertifying.status}`);
    }
    // The light route certifies it too (no ADVISORY, no marker).
    write(root, '.ai/TASK.md', tasks.light);
    const lightCertifying = validate(root);
    if (lightCertifying.status !== 0) {
      missed.push(`certifying cell light ${role} -> exit ${lightCertifying.status}`);
    }
  }
  assert.deepEqual(missed, []);
});

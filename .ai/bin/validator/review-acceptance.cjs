'use strict';
// CM-74: review acceptance (rule gates). The facts are those of .ai/bin/lib/review-facts.cjs: an advisory mode, no full
// commit SHA in the header (missing or a placeholder), no exit code stated.
//   WARN  when such a review is written: every report in docs/reviews/ (top level, a file named YYYY-MM-DD-... whose date is
//         2026-10-25 or later, not a prompt, holding a Verdict line) that misses a fact is named once. A report that cannot
//         be read is a FAIL: what is not known never passes (the card acceptance path refuses it as well).
//   FAIL  when such a review is used: the independent review of a Completed task's ## Completion gate names no full
//         SHA or no exit code (an advisory one already fails the completion gate; a review whose exact bytes are in the
//         frozen legacy boundary manifest keeps its old rules). On the light path (docs or config scope, one reviewer
//         statement, no prompt) the same facts are a WARN, and so they are where ruleGates.demoted lists "review".
// Landing refuses such a review when it accepts a card (tools/operator/landing.cjs acceptedReports).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { reviewFacts, certificationFacts, problems } = require('../lib/review-facts.cjs');
const gates = require('../lib/rule-gates.cjs');

const FROM = '2026-10-25';
const VERDICT = /^[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?Verdict(?:\*\*)?\s*:/im;
// { text } when the file is read, { code } with the error code when it is not (a missing file has code ENOENT)
const read = file => { try { return { text: fs.readFileSync(file, 'utf8') }; } catch (e) { return { code: (e && e.code) || 'UNREADABLE' }; } };
const blobSha = file => { try { const b = fs.readFileSync(file); return crypto.createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex'); } catch { return null; } };

function checkWrittenReviews(root, report) {
  const dir = path.join(root, 'docs', 'reviews');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names.sort()) {
    const m = /^(\d{4}-\d{2}-\d{2})-.+\.md$/.exec(name);
    if (!m || m[1] < FROM || /prompt/i.test(name)) continue;
    const got = read(path.join(dir, name));
    if (got.text === undefined) { report('CM-74', 'FAIL', `CM-74 review docs/reviews/${name} is unreadable (${got.code}), so it cannot accept a card or complete a task`, `docs/reviews/${name}`); continue; }
    if (!VERDICT.test(got.text)) continue;
    const missing = problems(reviewFacts(got.text));
    if (missing.length) report('CM-74', 'WARN', `CM-74 review docs/reviews/${name} cannot accept a card or complete a task: ${missing.join(', ')}`, `docs/reviews/${name}`);
  }
}

function checkUsedReview(root, task, legacyBoundaryManifest, report) {
  if (task === null || !/^Completed(?:[ .;:-]|$)/i.test(task.status)) return;
  const gate = /^## Completion gate[ \t]*\r?\n(?<body>[\s\S]*?)(?=^## |(?![\s\S]))/ms.exec(task.text);
  if (gate === null) return;
  const field = /^[ \t]*- Independent review:[ \t]*(\S+)[ \t]*$/m.exec(gate.groups.body);
  if (field === null) return;
  const relative = field[1].trim().split('\\').join('/').replace(/^\.\//, '');
  if (relative.split('/').some(s => s === '..') || path.isAbsolute(relative)) return; // CM-36/37 name an unsafe path
  const full = path.join(root, relative);
  const got = read(full);
  if (got.code === 'ENOENT') return; // CM-36/37 name a missing review
  if (got.text === undefined) { report('CM-74', 'FAIL', `CM-74 the independent review ${relative} is unreadable (${got.code}), so it cannot complete the task`, relative); return; }
  const text = got.text;
  const blob = blobSha(full);
  const legacy = legacyBoundaryManifest && Array.isArray(legacyBoundaryManifest.boundary)
    && legacyBoundaryManifest.boundary.some(e => e.path === relative && e.blob === blob);
  if (legacy) return;
  // an advisory review already fails the completion gate itself (CM-36/CM-37); CM-74 adds the two facts it does not check
  const missing = problems(reviewFacts(text)).filter(code => code !== 'R-ADVISORY');
  // The light path (a declared docs or config scope and no prompt field) needs one reviewer statement, which may run no
  // command: there the facts are a warning. A declared scope that is not really light fails the strict path for its missing prompt.
  const scope = /^[ \t]*- Scope:[ \t]*(\S+)[ \t]*$/m.exec(gate.groups.body);
  const light = scope !== null && /^(?:docs|config)$/i.test(scope[1]) && !/^[ \t]*- Adversarial review prompt:/m.test(gate.groups.body);
  if (!light) {
    for (const code of problems(certificationFacts(text))) if (code !== 'R-ADVISORY' && !missing.includes(code)) missing.push(code);
  }
  // A person may demote the review gate by configuration (ruleGates.demoted of this repository's protocol-manifest.json):
  // the failed facts stay named, as a warning that says so.
  const demoted = !light && missing.length > 0 && gates.isDemoted(gates.config(root), 'review');
  if (missing.length) report('CM-74', light || demoted ? 'WARN' : 'FAIL', `CM-74 the independent review ${relative} ${light ? 'completes a light-path task without' : demoted ? 'completes the task (review gate demoted by ruleGates.demoted) without' : 'cannot complete the task:'} ${missing.join(', ')}; a certifying review names the full reviewed SHA and the exit code of each check`, relative);
}

function checkReviewAcceptance(root, task, legacyBoundaryManifest, report) {
  checkWrittenReviews(root, report);
  checkUsedReview(root, task, legacyBoundaryManifest, report);
}

module.exports = { FROM, checkReviewAcceptance, checkWrittenReviews, checkUsedReview };

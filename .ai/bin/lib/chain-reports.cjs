'use strict';
// Chain reports (PROTO-DEC-0252 item 2): the collector that decides which earlier certifier reports of one
// candidate a chained certifier seat receives. A report qualifies iff ALL of these hold:
//   - its seat record is a sealed certifier of the SAME candidate sha and the seat is done with a closing verdict
//     (the launcher reads this through the injected reportStatus, so a draft, an unfinished report or a report of a
//     parallel seat that is still running never qualifies and is never silently relied on);
//   - the report carries a Receipt-Owner whose journal Evidence block verifies against the seat's own worktree
//     (checkOwnerReceipt, the same receipt acceptPair demands; "verifies" means at the time the report was
//     written, against that tree - F1 of the design). A receipt recorded with PROTOCOL_NO_FULL_SUITE=1 is
//     accepted as well when its only failing check is the protocol-test line that variable writes for a seat
//     (the full suite runs in the landing train, never in a seat): the exit 1 PROTOCOL_NO_FULL_SUITE failure of
//     a granted record (precert-facts.cjs noFullSuiteForm) or - since HEAVY-OPERATOR-ONLY - the heavy refusal
//     every ungranted seat records instead, at the exit code the current driver declares (heavyRefusalForm
//     below); either way the seat started no suite;
//   - the receipt-owning journal names the report path (acceptPair's binding rule).
// earlierReports returns EVERY qualifying report sorted by path (F4: "the earlier reports" means all of them).
// stageReports copies the qualified reports into .ai/runtime/chain-reports/ of the chained seat's worktree: the
// detached worktree of the candidate does not hold the earlier reports (sealed seats never commit to the
// candidate branch), so the launcher stages them; .ai/runtime keeps the precert P-CLEAN fact green.
const fs = require('node:fs');
const path = require('node:path');
const { maskMarkdown } = require('./text-safe.cjs');
const { checkOwnerReceipt } = require('../protocol-handoff/chain.cjs');
const { noFullSuiteForm, NO_FULL_SUITE_MAX_SECONDS } = require('./precert-facts.cjs');

const STAGED_DIR = '.ai/runtime/chain-reports';
const stagedName = report => `${STAGED_DIR}/${path.posix.basename(report)}`;

// The heavy-operator refusal form of the same receipt (HEAVY-OPERATOR-ONLY): without the operator grant
// PROTOCOL_OPERATOR_HEAVY the test driver refuses an ungranted suite start before any work, so a seat's
// record stamps "- protocol-test.cjs: exit <HEAVY_OPERATOR_EXIT> in Ns" as the single failing check of the
// Evidence. The refusal exit code is the driver's own HEAVY_OPERATOR_EXIT, read from the driver source this
// library ships beside (the constant is not exported), never hard-coded here; if the driver stops declaring
// it, no receipt qualifies through this form (fail closed, the reason names the unreadable code). The
// structural rules stay those of noFullSuiteForm: a green validator line, exactly one failing check,
// bounded seconds.
let HEAVY_OPERATOR_EXIT = null;
try {
  const declared = /^const HEAVY_OPERATOR_EXIT = (\d+);$/m.exec(
    fs.readFileSync(path.join(__dirname, '..', 'protocol-test.cjs'), 'utf8'));
  if (declared && Number(declared[1]) > 0) HEAVY_OPERATOR_EXIT = Number(declared[1]);
}
catch { /* unreadable: fail closed below */ }
const HEAVY_REFUSAL_LINE = HEAVY_OPERATOR_EXIT === null ? null
  : new RegExp(`^- protocol-test\\.cjs: exit ${HEAVY_OPERATOR_EXIT} in (\\d+)s$`);
function heavyRefusalForm(body) {
  if (typeof body !== 'string' || !body) return 'the newest entry has no Evidence block';
  const lines = body.replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd());
  if (lines.some(l => /^- candidate(?:-|:)/.test(l))) return 'the Evidence is an immutable candidate receipt';
  if (!lines.some(l => /^- protocol-validate\.cjs: exit 0 in \d+s$/.test(l))) return 'the Evidence has no passing protocol-validate line';
  const failing = lines.filter(l => /exit [^0]/.test(l));
  if (failing.length !== 1) return `the Evidence records ${failing.length} failing checks`;
  if (!HEAVY_REFUSAL_LINE) return 'the heavy-operator refusal exit code of the driver is unreadable';
  const m = HEAVY_REFUSAL_LINE.exec(failing[0]);
  if (!m) return `the failing check is not the heavy-operator protocol-test refusal (${(failing[0] || '').slice(0, 80)})`;
  if (Number(m[1]) > NO_FULL_SUITE_MAX_SECONDS) return `protocol-test ran ${m[1]}s: a full suite ran and failed`;
  return null;
}

// The Receipt-Owner header line of a report, read through the same Markdown masking the launcher uses.
function receiptOwner(contents) {
  const values = maskMarkdown(contents).lines.filter(l => !l.masked && !l.partial && l.text.startsWith('Receipt-Owner: ')).map(l => l.text.slice('Receipt-Owner: '.length));
  return values.length === 1 ? values[0] : null;
}

// One seat record -> the qualified report or null (with the reason for the audit trail).
function qualify(ctx, record, deps) {
  const c = record && record.contract;
  if (!c || c.sealed !== true || typeof c.report !== 'string') return null;
  const reportStatus = deps.reportStatus;
  const status = reportStatus(record);
  if (!status || status.done !== true || !status.verdict) return null;
  const wt = ctx.guard(ctx.workspace, record.worktree || c.worktree);
  let contents;
  try { contents = ctx.read(wt, c.report); } catch { return null; }
  const owner = receiptOwner(contents);
  if (!owner || !/^[a-z0-9][a-z0-9-]{0,100}$/.test(owner)) return null;
  const receipt = checkOwnerReceipt(wt, owner, { reviewPath: c.report, servedModel: (record.served && record.served.servedModel) || c.route.model });
  if (!receipt || receipt.ok !== true) {
    // The PROTOCOL_NO_FULL_SUITE=1 form: the receipt verifies against the tree and its only failing check is the
    // protocol-test line that variable writes for a seat (the full suite runs in the landing train, never in a
    // seat): the exit 1 failure of a granted record or the exit 3 heavy refusal of an ungranted one.
    if (!receipt || receipt.reason !== 'failing-check' || !receipt.evidence) return null;
    const body = receipt.evidence.body;
    if (noFullSuiteForm(body) !== null && heavyRefusalForm(body) !== null) return null;
  }
  let journal;
  try { journal = ctx.read(wt, `.ai/worklog/${owner}.md`); } catch { return null; }
  if (!journal.includes(c.report)) return null;
  return { path: c.report, seat: c.id, owner, verdict: status.verdict, worktree: record.worktree || c.worktree };
}

// Every qualifying earlier certifier report of the candidate sha, sorted by path. deps.reportStatus is the
// launcher's own report reader (tools/operator/seats.cjs reportStatus bound to ctx); it is injected so this
// library never depends on the operator kit.
function earlierReports(ctx, sha, deps = {}) {
  if (typeof deps.reportStatus !== 'function') throw new Error('reportStatus-required');
  const state = ctx.load();
  const out = [];
  for (const record of Object.values(state.seats || {})) {
    if (!record || !record.contract || record.contract.sha !== sha) continue;
    const q = qualify(ctx, record, deps);
    if (q) out.push(q);
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

// Stage the qualified earlier reports into the chained seat's worktree. Returns one row per contract report:
// { path (canonical docs/reviews path), staged (repo-relative staged path), seat, verdict }. A report that no
// longer qualifies throws chain-report-not-qualified: staging never degrades to a partial set.
function stageReports(ctx, c, wt, deps = {}) {
  const qualified = earlierReports(ctx, c.sha, deps);
  const byPath = new Map(qualified.map(q => [q.path, q]));
  const staged = [];
  for (const report of c.chain.reports) {
    const q = byPath.get(report);
    if (!q) {
      const e = new Error('chain-report-not-qualified');
      e.code = 'chain-report-not-qualified';
      throw e;
    }
    const contents = ctx.read(ctx.guard(ctx.workspace, q.worktree), q.path);
    const target = stagedName(report);
    ctx.write(wt, target, contents.endsWith('\n') ? contents : `${contents}\n`);
    staged.push({ path: report, staged: target, seat: q.seat, verdict: q.verdict });
  }
  return staged;
}

module.exports = { STAGED_DIR, stagedName, receiptOwner, earlierReports, stageReports };

'use strict';
// M-005: certifier verdict against the final outcome.
// Debt row L6-M005. Separate leaf file. ADVISORY only.
// Unknown is never a number: a missing outcome keeps the calibration cell unknown.
//
//   node .ai/bin/metrics/M-005.cjs [--a DIR] [--b DIR]
// Exit: 0 computed or compact source refusal; 2 usage.
const path = require('node:path');
const { TOKENS } = require('../lib/verdict-read.cjs');
const {refuseMeasurements,protect,exceptionRefusal}=require('./refused-package.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const REVIEWS = path.join(ROOT, 'docs', 'reviews');
const SINCE = '2026-10-05';
const { REVIEW_FILE, discoverReviews, reviewCoverage, selectPackage } = require('./review-discovery.cjs');

function usage(msg) { process.stderr.write(String(msg) + '\n'); return 2; }
function listPackage(dir) { return discoverReviews(dir); }

function inventoryUnsafe(rows) {
  if(rows.sourceRefusal)return rows.sourceRefusal;
  const coverage = reviewCoverage(rows);
  rows = rows.filter(r => !r.classification || r.classification === 'read' || r.classification === 'non-canonical');
  const byAgent = new Map();
  let withVerdict = 0;
  for (const r of rows) {
    if (!byAgent.has(r.agent)) byAgent.set(r.agent, { agent: r.agent, reviews: 0, verdicts: 0, PASS: 0, FAIL: 0, BLOCKED: 0, RECOMMENDATION: 0, unreadable: 0 });
    const a = byAgent.get(r.agent);
    a.reviews++;
    if (r.verdict === null) { a.unreadable++; continue; }
    withVerdict++;
    a.verdicts++;
    a[r.verdict]++;
  }
  const perAgent = [...byAgent.values()].sort((x, y) => (x.agent < y.agent ? -1 : 1));
  // The join to the FINAL package outcome (accepted / superseded / reopened) has no
  // structured record keyed by review; the calibration matrix stays unknown.
  return refuseMeasurements({
    ...coverage,
    reviews: rows.length,
    reviewsWithVerdictToken: withVerdict,
    reviewsWithoutVerdictToken: rows.length - withVerdict,
    verdictTokens: TOKENS.slice(),
    perAgent,
    calibrationMatrix: null,
    value: null,
    unit: 'verdictMatchesOutcome_share',
    denominator: {
      n: rows.length,
      of: 'paired_reviews_in_package',
      note: 'verdict tokens are read by the one verdict reader (verdict-read.cjs); the outcome side of the matrix is unfilled',
    },
    unknowns: [
      ...coverage.discoveryUnknowns,
      { field: 'value', reason: 'final-outcome-unrecorded' },
      { field: 'calibrationMatrix', reason: 'final-outcome-unrecorded' },
      { field: 'finalOutcome', reason: 'no structured package-outcome record joined to a review (accepted/superseded/reopened)' },
      { field: 'shadowVerdicts', reason: 'shadow (non-slot) certifier verdicts are kept in journals, not in this corpus' },
    ],
    sources: rows.map((r) => ({ path: 'docs/reviews/' + r.file, sha256: r.sha256, bytes: r.bytes, agent: r.agent, verdict: r.verdict })),
  });
}
const inventory=protect(inventoryUnsafe);

function main(argv) {
  let a = REVIEWS, b = REVIEWS, filterA = (r) => !r.date || r.date >= SINCE, filterB = (r) => r.date < SINCE;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--a' || k === '--b') {
      const dir = argv[++i];
      if (!dir) return usage('missing value for ' + k);
      if (k === '--a') { a = dir; filterA = null; } else { b = dir; filterB = null; }
    } else return usage('unknown argument: ' + k);
  }
  let rowsA, rowsB;
  try {
    rowsA = selectPackage(listPackage(a), filterA);
    rowsB = selectPackage(listPackage(b), filterB);
  } catch (e) { return usage(exceptionRefusal(e).reason); }
  const pa = inventory(rowsA); if(!pa.reason){pa.name = 'kernel-completion-window'; pa.path = 'docs/reviews (date>=' + SINCE + ')';}
  const pb = inventory(rowsB); if(!pb.reason){pb.name = 'pre-window'; pb.path = 'docs/reviews (date<' + SINCE + ')';}
  const result = {
    metric: 'M-005',
    title: 'Certifier verdict against the final outcome (calibration)',
    advisory: true,
    generatedAt: new Date().toISOString(),
    value: null,
    unit: 'verdictMatchesOutcome_share',
    denominator: pa.denominator||null,
    unknowns: pa.reason?[{reason:pa.reason}]:pa.unknowns,
    packages: { a: pa, b: pb },
    consumer: {
      decision: 'pair selection for certification; shadow admission into slots (PROTO-DEC-0047 п.1/п.4)',
      status: 'unchanged (no matrix cells fillable)',
      basis: 'verdict counts per transport are measured; without the outcome join no transport ranking or slot admission may change',
    },
  };
  process.stdout.write(JSON.stringify(result, null, 1) + '\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { REVIEW_FILE, listPackage, inventory, SINCE };

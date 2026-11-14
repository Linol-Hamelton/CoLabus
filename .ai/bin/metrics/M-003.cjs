'use strict';
// M-003: certification rounds per package; empty rounds.
// Package-card metric; debt row L6-M003. Separate leaf file.
// ADVISORY only. Unknown is never a number.
//
//   node .ai/bin/metrics/M-003.cjs [--a DIR] [--b DIR]
//     --a/--b  directories of paired review reports (default: docs/reviews split into
//              the kernel-completion window >=2026-10-05 and the earlier window).
// Exit: 0 computed (value may be null); 2 usage, unreadable or undecodable source.
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const REVIEWS = path.join(ROOT, 'docs', 'reviews');
const SINCE = '2026-10-05';
const { REVIEW_FILE, discoverReviews, reviewCoverage, selectPackage } = require('./review-discovery.cjs');
const {refuseMeasurements}=require('./refused-package.cjs');

function selectPackageSafe(rows,filter){return rows.sourceRefusal?rows:selectPackage(rows,filter);}
function usage(msg) { process.stderr.write(String(msg) + '\n'); return 2; }
function listPackage(dir) { try{return discoverReviews(dir);}catch(e){const rows=[];rows.sourceRefusal=require('./refused-package.cjs').exceptionRefusal(e);return rows;} }

function inventoryUnsafe(rows) {
  if(rows.sourceRefusal)return rows.sourceRefusal;
  const coverage = reviewCoverage(rows);
  rows = rows.filter(r => !r.classification || r.classification === 'read' || r.classification === 'non-canonical');
  const bySlug = new Map();
  for (const r of rows) {
    if (!bySlug.has(r.slug)) bySlug.set(r.slug, []);
    bySlug.get(r.slug).push(r);
  }
  // A round is one paired review file WITH a readable verdict (R-L6-M003.2 of the M-003
  // record): a report without a readable verdict is not a round and never a zero - it
  // stays unknown, counted only in unknownVerdicts. A package whose every report is
  // verdictless has no measured rounds: its cell stays null (R-L6-M003.3), and the
  // mean is available only when the entire declared corpus is canonical.
  const rounds = [...bySlug.entries()].map(([slug, rs]) => {
    const readable = rs.filter((r) => r.verdict !== null);
    const unreadCandidates = rs.filter(r => r.candidate === true && r.discoveryReason);
    return {
      slug,
      rounds: readable.length && !unreadCandidates.length ? readable.length : null,
      verdicts: readable.map((r) => r.verdict),
      failRounds: readable.filter((r) => r.verdict === 'FAIL').length,
      passRounds: readable.filter((r) => r.verdict === 'PASS').length,
      unknownVerdicts: rs.filter((r) => r.verdict === null).length,
      unknowns: unreadCandidates.length ? unreadCandidates.map(r => ({ field: 'rounds', report: r.file, reason: r.discoveryReason })) : readable.length ? [] : [{ field: 'rounds', reason: 'verdict-unreadable' }],
    };
  }).sort((x, y) => (x.slug < y.slug ? -1 : 1));
  const roundCounts = rounds.map((r) => r.rounds).filter((n) => n !== null);
  const mean = roundCounts.length ? roundCounts.reduce((s, n) => s + n, 0) / roundCounts.length : null;
  return refuseMeasurements({
    ...coverage,
    reviews: rows.length,
    packages: rounds.length,
    roundsPerPackage: rounds,
    meanRoundsPerPackage: mean,
    // An empty round = FAIL with no NEW root cause. Root-cause identity across rounds is
    // not recorded in a structured field; FAIL counts are shown but never read as empty.
    emptyRounds: null,
    value: mean,
    unit: 'certificationRoundsPerPackage_mean',
    denominator: {
      n: roundCounts.length,
      of: 'packages_with_at_least_one_readable_round',
      note: 'a round is one paired review file with a readable verdict; two transports reviewing the same slug are two seats and two files; a verdictless report is not a round and its package cell stays null',
    },
    unknowns: [
      ...coverage.discoveryUnknowns,
      ...(['value', 'meanRoundsPerPackage'].flatMap(field => mean === null ? [{ field, reason: rows.length ? 'verdict-unreadable' : 'no-records' }] : [])),
      { field: 'emptyRounds', reason: 'no structured root-cause id per round; FAIL without a new root cause cannot be detected from the corpus alone' },
      { field: 'roundsWithoutReadableVerdict', reason: 'a report without a readable verdict is not a round; its package cell stays null, never zero' },
    ],
    sources: rows.map((r) => ({ path: 'docs/reviews/' + r.file, sha256: r.sha256, bytes: r.bytes, slug: r.slug, verdict: r.verdict, unknowns: r.verdict === null ? [{ field: 'verdict', reason: 'verdict-unreadable' }] : [] })),
  }, ['value','reviews','packages','roundsPerPackage','meanRoundsPerPackage']);
}

const inventory=require('./refused-package.cjs').protect(inventoryUnsafe);

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
    rowsA = selectPackageSafe(listPackage(a), filterA);
    rowsB = selectPackageSafe(listPackage(b), filterB);
  } catch (e) { try{return usage(e.message);}catch{return usage('exception-unreadable');} }
  const pa = inventory(rowsA); if(!pa.reason)pa.name = 'kernel-completion-window'; if(!pa.reason)pa.path = 'docs/reviews (date>=' + SINCE + ')';
  const pb = inventory(rowsB); if(!pb.reason)pb.name = 'pre-window'; if(!pb.reason)pb.path = 'docs/reviews (date<' + SINCE + ')';
  const result = {
    metric: 'M-003',
    title: 'Certification rounds per package; empty rounds',
    advisory: true,
    generatedAt: new Date().toISOString(),
    value: pa.value,
    unit: 'certificationRoundsPerPackage_mean',
    denominator: pa.denominator||null,
    unknowns: pa.reason?[{reason:pa.reason}]:pa.unknowns,
    packages: { a: pa, b: pb },
    consumer: {
      decision: 'K7 card: stop the fix cycle at a root cause (<=3 rounds)',
      status: 'K7 rule unchanged; mean rounds measured per package',
      basis: 'mean rounds per package is descriptive; empty-round detection stays unknown, so K7 is not triggered or relaxed by this number',
    },
  };
  process.stdout.write(JSON.stringify(result, null, 1) + '\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { REVIEW_FILE, listPackage, inventory, SINCE };

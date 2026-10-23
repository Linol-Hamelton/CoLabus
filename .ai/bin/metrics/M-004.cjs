'use strict';
// M-004: escape defects - defects found AFTER a PASS (M-004;
// debt row L6-M004). Separate leaf file. ADVISORY only. Unknown is never a number.
//
// An escape CANDIDATE is a package slug whose paired corpus contains a PASS review and,
// strictly later by file date, a FAIL review on the same slug. A candidate is not a proven
// escape: the later FAIL must be reproduced against the same defect to close the metric.
//
//   node .ai/bin/metrics/M-004.cjs [--a DIR] [--b DIR]
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
  let passed = 0;
  const candidates = [];
  const unreadable = [];
  for (const [slug, rs] of bySlug) {
    const sorted = [...rs].sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : (x.file < y.file ? -1 : 1)));
    const firstPassIndex = sorted.findIndex((r) => r.verdict === 'PASS');
    if (firstPassIndex === -1) continue;
    passed++;
    // R-L6-M004.1 of the M-004 record: the FAIL must be strictly later by recorded date.
    // A same-date PASS/FAIL pair has no strict order and is never a candidate.
    const passDate = sorted[firstPassIndex].date;
    for (const r of sorted) if (r.date > passDate && r.verdict === null) {
      unreadable.push({ field: 'value', report: r.file, reason: 'later-verdict-unreadable' });
    }
    const laterFail = sorted.slice(firstPassIndex + 1).find((r) => r.verdict === 'FAIL' && r.date > passDate);
    if (laterFail) candidates.push({ slug, passFile: sorted[firstPassIndex].file, failFile: laterFail.file, passDate: sorted[firstPassIndex].date, failDate: laterFail.date });
  }
  return refuseMeasurements({
    ...coverage,
    reviews: rows.length,
    packagesPassed: passed,
    escapeCandidates: candidates.length,
    escapeCandidateList: candidates,
    value: passed && unreadable.length === 0 ? candidates.length / passed : null,
    unit: 'escapeCandidatesPerPassedPackage',
    denominator: {
      n: passed,
      of: 'packages_with_at_least_one_PASS_review',
      note: 'a candidate is a later-dated FAIL on the same slug after a PASS; it is not a proven escape until the defect is reproduced',
    },
    unknowns: [
      ...coverage.discoveryUnknowns,
      ...unreadable,
      ...(passed === 0 ? [{ field: 'value', reason: rows.length ? 'no-pass' : 'no-records' }] : []),
      { field: 'provenEscapes', reason: 'no structured defect id links a post-PASS FAIL finding to a defect that escaped the PASS' },
      { field: 'sameDatePairs', reason: 'a same-date PASS/FAIL pair has no strict order by recorded date and is never a candidate' },
    ],
    sources: rows.map((r) => ({ path: 'docs/reviews/' + r.file, sha256: r.sha256, bytes: r.bytes, slug: r.slug, verdict: r.verdict, unknowns: r.verdict === null ? [{ field: 'verdict', reason: 'verdict-unreadable' }] : [] })),
  }, ['value','reviews','packagesPassed','escapeCandidates','escapeCandidateList']);
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
    metric: 'M-004',
    title: 'Escape defects: defects found after PASS',
    advisory: true,
    generatedAt: new Date().toISOString(),
    value: pa.value,
    unit: 'escapeCandidatesPerPassedPackage',
    denominator: pa.denominator||null,
    unknowns: pa.reason?[{reason:pa.reason}]:pa.unknowns,
    packages: { a: pa, b: pb },
    consumer: {
      decision: 'certifier calibration (which transports miss which classes after a PASS)',
      status: 'candidates listed; calibration not changed without reproduction',
      basis: 'candidate rate is descriptive; a proven escape needs a reproduced defect id, which the corpus does not carry',
    },
  };
  process.stdout.write(JSON.stringify(result, null, 1) + '\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { REVIEW_FILE, listPackage, inventory, SINCE };

'use strict';
// M-001: LCC defects caught by the author against those found by the reviewer, by layer
// (M-001; debt row L6-M001). Separate leaf file.
// ADVISORY only (PROTO-DEC-0167 п.6): never Evidence, never a gate input.
// Unknown is never a number: a missing per-defect provenance record keeps value null.
//
//   node .ai/bin/metrics/M-001.cjs [--a DIR] [--b DIR]
//     --a/--b  directories of independent review reports (default: docs/reviews filtered
//              into two comparable date packages: kernel-completion window >=2026-10-05
//              and the earlier window).
// Exit: 0 computed or compact source refusal; 2 usage or author-report path escape.
const fs = require('node:fs');
const path = require('node:path');
const textSafe = require('../lib/text-safe.cjs');
const {refuseMeasurements,protect}=require('./refused-package.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const REVIEWS = path.join(ROOT, 'docs', 'reviews');
const OPS = path.join(ROOT, 'docs', 'ops');
const SINCE = '2026-10-05';
// Shared closed input contract: recursive files, canonical header/name/verdict,
// four named classifications; any noncanonical review poisons the package.
const { REVIEW_FILE, discoverReviews, reviewCoverage, selectPackage } = require('./review-discovery.cjs');
// Own line (outside every markdown fence) naming the author report of the same package.
const AUTHOR_LINE = /^[-*]?\s*\*{0,2}Author report\*{0,2}\s*:\s*`?(docs\/ops\/[A-Za-z0-9._/-]+\.md)`?\s*$/;

function usage(msg) { process.stderr.write(String(msg) + '\n'); return 2; }
function listPackage(dir) {
  const out = [];
  const discovered=discoverReviews(dir);if(discovered.sourceRefusal)return discovered;
  for (const row of discovered) {
    const { file: name, text } = row;
    const lines = text.split('\n');
    const mask = textSafe.maskMarkdown(text);
    let authorReport = null;
    for (let i = 0; i < lines.length; i++) {
      const row = mask.lines[i];
      // A fully masked line is never the document's own statement. A partial line is
      // accepted when the whole line matches the closed grammar (the path sits in an
      // inline code span, which the mask marks partial but the grammar pins exactly).
      if (!row || row.masked) continue;
      const am = AUTHOR_LINE.exec(row.text);
      if (am) { authorReport = am[1]; break; }
    }
    let authorExists = null;
    if (authorReport) {
      // path is constrained to docs/ops/*.md by the grammar; resolve inside ROOT only.
      const target = path.resolve(ROOT, authorReport);
      if (!target.startsWith(OPS + path.sep)) throw new Error('author-report-path-escapes: ' + name);
      authorExists = fs.existsSync(target);
    }
    out.push({ ...row, authorReport, authorExists });
  }
  return out;
}

function inventoryUnsafe(rows) {
  if(rows.sourceRefusal)return rows.sourceRefusal;
  const coverage = reviewCoverage(rows);
  rows = rows.filter(r => !r.classification || r.classification === 'read' || r.classification === 'non-canonical');
  const slugs = new Set(rows.map((r) => r.slug));
  const withAuthorLine = rows.filter((r) => r.authorReport !== null);
  const withAuthorFile = withAuthorLine.filter((r) => r.authorExists === true);
  const slugsWithBoth = new Set(withAuthorFile.map((r) => r.slug));
  return refuseMeasurements({
    ...coverage,
    reviews: rows.length,
    slugs: slugs.size,
    reviewsWithAuthorLine: withAuthorLine.length,
    reviewsWithAuthorFile: withAuthorFile.length,
    slugsWithReviewAndAuthorFile: slugsWithBoth.size,
    // Per-defect provenance (author-found vs reviewer-found, per layer) has no structured
    // record in this repository; the LCC join cannot be computed. Never imputed.
    value: null,
    unit: 'authorCaughtMinusReviewerFound_defects',
    denominator: {
      n: slugs.size,
      of: 'package_slugs_with_at_least_one_paired_review',
      note: 'a slug joins only when a paired review names an existing author report under docs/ops/',
    },
    unknowns: [
      ...coverage.discoveryUnknowns,
      { field: 'value', reason: 'defect-provenance-unrecorded' },
      { field: 'authorCaughtDefects', reason: 'no per-defect provenance records (author-found flag) in reviews or author reports' },
      { field: 'reviewerFoundDefects', reason: 'no per-defect provenance records (reviewer-found flag) with layer tag' },
      { field: 'layerJoin', reason: 'defect rows carry no layer id to group the LCC by layer' },
    ],
    sources: rows.map((r) => ({ path: 'docs/reviews/' + r.file, sha256: r.sha256, bytes: r.bytes, slug: r.slug, agent: r.agent, authorReport: r.authorReport, authorExists: r.authorExists })),
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
  } catch (e) { try{return usage(e.message);}catch{return usage('exception-unreadable');} }
  const pa = inventory(rowsA); if(!pa.reason){pa.name = 'kernel-completion-window'; pa.path = path.relative(ROOT, path.resolve(a)).replace(/\\/g, '/') + (filterA ? ' (date>=' + SINCE + ')' : '');}
  const pb = inventory(rowsB); if(!pb.reason){pb.name = 'pre-window'; pb.path = path.relative(ROOT, path.resolve(b)).replace(/\\/g, '/') + (filterB ? ' (date<' + SINCE + ')' : '');}
  const result = {
    metric: 'M-001',
    title: 'LCC author-caught defects against reviewer-found defects, by layer',
    advisory: true,
    generatedAt: new Date().toISOString(),
    value: null,
    unit: 'authorCaughtMinusReviewerFound_defects',
    denominator: pa.reason||pb.reason?null:{ n: pa.slugs + pb.slugs, of: 'slugs_across_both_packages', note: 'value stays null until per-defect provenance lands' },
    unknowns: pa.reason?[{reason:pa.reason}]:pa.unknowns,
    packages: { a: pa, b: pb },
    consumer: {
      decision: 'P-L0-001 (author LCC catch rule) trial status',
      status: 'unchanged',
      basis: 'both comparable packages join reviews to author reports but carry no per-defect provenance; the trial cannot be retired or promoted on a null value',
    },
  };
  process.stdout.write(JSON.stringify(result, null, 1) + '\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { REVIEW_FILE, AUTHOR_LINE, listPackage, inventory, SINCE };

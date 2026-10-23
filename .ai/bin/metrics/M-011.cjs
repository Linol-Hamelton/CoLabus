'use strict';
// M-011: leakage at closure — artifacts of closed frames found by the detector after
// CLOSED, per closed frame; active-corpus bytes before and after each closure
// (M-011; P-L0-008; debt row L6-M011). Separate leaf file. ADVISORY
// only. Unknown is never a number.
//
//   node .ai/bin/metrics/M-011.cjs [--a FILE] [--b FILE]
//     --a/--b  closure ledgers (default: docs/research/CLOSURES.jsonl; package A = all
//              receipts, package B = commit-anchored receipts — two comparable slices).
// Exit: 0 computed (value may be null); 2 usage, unreadable or undecodable source.
const path = require('node:path');
const { readJsonl, readableId, readableCommit, receiptOf, closureIssues, lineOf } = require('./closure-reader.cjs');
const {refuseMeasurements}=require('./refused-package.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const CLOSURES = path.join(ROOT, 'docs', 'research', 'CLOSURES.jsonl');

function usage(msg) { process.stderr.write(String(msg) + '\n'); return 2; }
// A leak counter for one closure record: dangling refs + competing authorities found by
// the detector. A non-integer or negative counter is unknown, never clamped to 0.
function leaksOf(r) {
  const parts = [r.dangling_refs, r.competing_authority];
  const nums = [];
  for (const p of parts) {
    if (typeof p !== 'number' || !Number.isSafeInteger(p) || p < 0) return null;
    nums.push(p);
  }
  return Number.isSafeInteger(nums[0] + nums[1]) ? nums[0] + nums[1] : null;
}

// R-L6-M011.2 of the M-011 record: a closure counts only from its recorded receipt.
// A record without a readable receipt id is an unknown closure, never a measured zero.
function bytesPair(r) {
  const before = r.active_bytes_before, after = r.active_bytes_after;
  if (typeof before !== 'number' || !Number.isSafeInteger(before) || before < 0) return null;
  if (typeof after !== 'number' || !Number.isSafeInteger(after) || after < 0) return null;
  return { before, after, delta: after - before };
}

function inventoryUnsafe(rows, label, filter) {
  if(rows.sourceRefusal)return rows.sourceRefusal;
  const preflight = closureIssues(rows);
  const sel = filter ? rows.filter(r => readableCommit(r.closure_commit) && filter(r)) : rows.slice();
  const leaks = [];
  const bytes = [];
  let unknownLeaks = 0;
  let unknownReceipts = 0;
  let framelessReceipts = 0;
  let duplicateReceipts = 0, conflictReceipts = 0;
  const invalid = filter ? rows.flatMap((r, i) => r.closure_commit != null && !readableCommit(r.closure_commit)
    ? [{ field: 'closure_commit', row: lineOf(r,i), reason: 'closure-commit-unreadable' }] : []) : [];
  // Pass 1: enumerate all selected rows and compare receipt identities before any
  // counter can contribute to a total. A later conflict poisons the earlier row too.
  const seen = new Map(), conflicts = preflight.conflicts;
  for (const r of sel) {
    const id = receiptOf(r);
    if (id === null) continue;
    const signature = JSON.stringify([r.frame, r.dangling_refs, r.competing_authority, r.active_bytes_before, r.active_bytes_after]);
    if (seen.has(id) && seen.get(id) !== signature) conflicts.add(id);
    else seen.set(id, signature);
  }
  // Pass 2: strict identities and counters; each unread row is named.
  const readIds = new Set(), unknownUnits = [];
  for (const [index, r] of sel.entries()) {
    const row = lineOf(r,index), receipt = receiptOf(r);
    if (conflicts.has(receipt)) {
      conflictReceipts++; invalid.push({ field: 'value', receipt, row, reason: 'conflict' }); continue;
    }
    if (receiptOf(r) === null) {
      unknownReceipts++; invalid.push({ field: 'receiptsWithoutReadableReceipt', row, reason: 'receipt-unreadable' }); continue;
    }
    if (!readableId(r.frame)) {
      framelessReceipts++; invalid.push({ field: 'frame', receipt, row, reason: 'receipt-without-frame' }); continue;
    }
    const l = leaksOf(r);
    if (readIds.has(receipt) && l !== null) { duplicateReceipts++; continue; }
    readIds.add(receipt);
    if (l === null) { unknownLeaks++; unknownUnits.push({ field: 'value', receipt, row, reason: 'leak-count-unknown' }); }
    else leaks.push({ receipt: r.receipt, frame: r.frame, leaks: l });
    const bp = bytesPair(r);
    if (bp) bytes.push({ receipt: r.receipt, frame: r.frame, ...bp });
  }
  const total = leaks.reduce((s, x) => s + x.leaks, 0);
  const nonCanonical = [...preflight.issues, ...invalid.map(u=>({...u,reason:'non-canonical-input',detail:u.reason})), ...unknownUnits.map(u=>({...u,reason:'non-canonical-input',detail:u.reason}))];
  const complete = nonCanonical.length === 0 && Number.isSafeInteger(total);
  const meanLeaks = complete && leaks.length ? total / leaks.length : null;
  const nullReason = invalid.length ? invalid[0].reason : unknownLeaks ? 'leak-count-unknown' : !Number.isSafeInteger(total) ? 'unsafe-integer' : 'no-records';
  unknownUnits.push(...invalid);
  const receipts = sel.length - unknownReceipts - framelessReceipts - conflictReceipts - duplicateReceipts;
  return refuseMeasurements({
    name: label,
    scope: 'every physical JSONL line, validated before the optional commit slice; final LF terminates the last record',
    format: 'render(parse(line)) byte equality (ordered JSON.stringify + LF), no blank lines, unique receipt; exact ASCII receipt/frame, nonnegative safe-integer counters; optional exact lowercase hex commit locator without trim',
    nonCanonicalCount: new Set(nonCanonical.map(u=>u.row)).size, offendingRows: [...new Set(nonCanonical.map(u=>u.row))].slice(0,20),
    candidates: sel.length + (filter ? invalid.filter(u => u.reason === 'closure-commit-unreadable').length : 0),
    read: sel.length - unknownUnits.filter(u => u.reason !== 'closure-commit-unreadable').length,
    unknown: unknownUnits.length, unknownUnits,
    receipts,
    receiptsWithoutReadableReceipt: unknownReceipts,
    receiptsWithLeakCount: leaks.length,
    receiptsWithUnknownLeakCount: unknownLeaks,
    totalLeaks: complete && leaks.length ? total : null,
    meanLeaksPerClosedFrame: meanLeaks,
    leakList: leaks,
    bytesMeasured: bytes.length,
    bytesList: bytes,
    value: meanLeaks,
    unit: 'detectorLeaksPerClosedFrame_mean',
    denominator: {
      n: receipts,
      of: 'closure_receipts_with_a_readable_receipt_and_frame',
      note: 'a receipt contributes only when its receipt id is readable and dangling_refs and competing_authority are exact non-negative integers; unknown counters and unknown closures stay unknown',
    },
    unknowns: [
      ...nonCanonical,
      ...invalid,
      ...unknownUnits.filter(u => u.reason === 'leak-count-unknown'),
      ...(['value', 'totalLeaks', 'meanLeaksPerClosedFrame'].flatMap(field => meanLeaks === null ? [{ field, reason: nullReason }] : [])),
      { field: 'postClosedDetectorRuns', reason: 'the ledger stores the closure-time detector result; a separate AFTER-CLOSED detector pass is not recorded per receipt' },
      { field: 'receiptsWithoutReadableReceipt', reason: unknownReceipts ? unknownReceipts + ' closure record(s) carry no readable receipt id; a closure without a receipt stays unknown' : null },
      { field: 'activeBytes', reason: bytes.length < receipts ? (receipts - bytes.length) + ' receipt(s) lack integer active_bytes_before/after' : null },
    ].filter((u) => u.reason),
  }, ['value','candidates','read','unknown','receipts','receiptsWithoutReadableReceipt','receiptsWithLeakCount','receiptsWithUnknownLeakCount','totalLeaks','meanLeaksPerClosedFrame','leakList','bytesMeasured','bytesList']);
}

const inventory=require('./refused-package.cjs').protect(inventoryUnsafe);

function main(argv) {
  let a = CLOSURES, b = CLOSURES;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--a' || k === '--b') {
      const f = argv[++i];
      if (!f) return usage('missing value for ' + k);
      if (k === '--a') a = f; else b = f;
    } else return usage('unknown argument: ' + k);
  }
  let src, srcB;
  try { src = readJsonl(path.resolve(a)); srcB = readJsonl(path.resolve(b)); } catch (e) { try{return usage(e.message);}catch{return usage('exception-unreadable');} }
  const pa = inventory(src.rows, 'all-closure-receipts', null);
  const pb = inventory(srcB.rows, 'commit-anchored-receipts', (r) => readableCommit(r.closure_commit));
  if(!pa.reason){
  pa.path = path.relative(ROOT, path.resolve(a)).replace(/\\/g, '/');
  pa.sha256 = src.sha256; pa.bytes = src.bytes;
  }
  if(!pb.reason){
  pb.path = path.relative(ROOT, path.resolve(b)).replace(/\\/g, '/'); pb.sha256 = srcB.sha256; pb.bytes = srcB.bytes;
  }
  const result = {
    metric: 'M-011',
    title: 'Artifact leakage of closed frames; active-corpus bytes around each closure',
    advisory: true,
    generatedAt: new Date().toISOString(),
    value: pa.value,
    unit: 'detectorLeaksPerClosedFrame_mean',
    denominator: pa.denominator||null,
    unknowns: [pa,pb].flatMap(p=>p.reason?[{reason:p.reason}]:(p.unknowns||[])),
    packages: { a: pa, b: pb },
    consumer: {
      decision: 'P-L0-008 closure procedure; attention budget for closed frames',
      status: 'closure-time detector counters measured; no AFTER-CLOSED re-scan evidence, so the procedure is not certified clean',
      basis: 'mean leaks per closed frame is descriptive; a zero mean over closure-time counters does not prove no post-CLOSED leak without a detector re-scan record',
    },
    sources: [
      pa.reason ? pa : { path: pa.path, sha256: src.sha256, bytes: src.bytes, records: src.rows.length },
      pb.reason ? pb : { path: pb.path, sha256: srcB.sha256, bytes: srcB.bytes, records: srcB.rows.length },
    ],
  };
  process.stdout.write(JSON.stringify(result, null, 1) + '\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { readJsonl, leaksOf, bytesPair, receiptOf, inventory };

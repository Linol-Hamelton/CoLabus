'use strict';
// M-010: frames with a recorded verdict against open frames, by stream; DIG/DIG_FLOOR/
// DEFERRED_ACCEPTED counters (M-010; P-L0-008; the research index
// is not built yet, so this leaf computes over the frames registry
// and the closures ledger that exist). Separate leaf file. ADVISORY only.
//
//   node .ai/bin/metrics/M-010.cjs [--frames FILE] [--closures FILE]
// Exit: 0 computed (value may be null); 2 usage, unreadable or undecodable source.
const path = require('node:path');
const { readJsonl, closureOf, readableCommit, closureIssues } = require('./closure-reader.cjs');
const {refuseMeasurements}=require('./refused-package.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const FRAMES = path.join(ROOT, 'docs', 'research', 'FRAMES.md');
const CLOSURES = path.join(ROOT, 'docs', 'research', 'CLOSURES.jsonl');

function usage(msg) { process.stderr.write(String(msg) + '\n'); return 2; }
const { parseFrames } = require('./canonical-frames.cjs');

function parseClosures(file) {
  return readJsonl(file);
}

function packageAUnsafe(framesParsed) {
  if(framesParsed.reason)return framesParsed;
  const real = framesParsed.frames.filter((f) => f.status !== 'NOT_A_FRAME' && f.status !== null);
  const byStream = {};
  let open = 0, closed = 0;
  for (const f of real) {
    const s = f.stream || '(none)';
    if (!byStream[s]) byStream[s] = { open: 0, closed: 0, total: 0 };
    byStream[s].total++;
    if (f.openState) { open++; byStream[s].open++; }
    if (f.closedState) { closed++; byStream[s].closed++; }
  }
  // A closed frame counts as verdicted only with a receipt reference in the record
  // column; the allow-list parser does not read the free-text record column, so the
  // verdicted share is unknown rather than assumed from CLOSED.
  return refuseMeasurements({
    name: 'frames-registry',
    candidates: framesParsed.candidates, read: framesParsed.read, unknown: framesParsed.unknown, unknownUnits: framesParsed.unknownUnits,
    frames: real.length,
    open,
    closed,
    byStream,
    verdictedShare: null,
    nonCanonicalCount: framesParsed.nonCanonicalCount, offendingLines: framesParsed.offendingLines, scope: framesParsed.scope, format: framesParsed.format,
    value: (real.length ? open / real.length : null),
    unit: 'openShare_of_frames',
    denominator: {
      n: real.length,
      of: 'frame_rows_with_a_recognised_status',
      note: 'open = ACTIVE|BLOCKED|SUSPENDED|TRANSITION-PENDING; verdicted share needs the record/receipt column, which is free text',
    },
    unknowns: [
      ...framesParsed.unknowns,
      ...(real.length === 0 ? [{ field: 'value', reason: 'no-records' }] : []),
      ...framesParsed.unknowns.filter(u => u.reason === 'frame-row-unreadable' || u.reason === 'conflict' && u.field.startsWith('F-')).map(u => ({ field: 'value', reason: u.reason, row: u.field })),
      { field: 'verdictedShare', reason: 'the registry record column is free text; a per-frame verdict flag is not structured' },
    ].filter((u) => u.reason),
    counters: {
      DIG: framesParsed.counters.DIG === undefined ? null : framesParsed.counters.DIG,
      DIG_FLOOR: framesParsed.counters.DIG_FLOOR === undefined ? null : framesParsed.counters.DIG_FLOOR,
      DEFERRED_ACCEPTED: framesParsed.counters.DEFERRED_ACCEPTED === undefined ? null : framesParsed.counters.DEFERRED_ACCEPTED,
    },
  }, ['value','candidates','read','unknown','frames','open','closed','byStream','counters']);
}

function packageBUnsafe(closuresParsed) {
  if(closuresParsed.sourceRefusal)return closuresParsed.sourceRefusal;
  const rows = closuresParsed.rows;
  const preflight = closureIssues(rows);
  let withCommit = 0, withReceipt = 0;
  const invalid = [];
  for (const [i, r] of rows.entries()) {
    const closure = closureOf(r);
    if (closure.reason) { invalid.push({ field: 'value', row: i + 1, reason: closure.reason }); continue; }
    if (readableCommit(r.closure_commit)) withCommit++;
    withReceipt++;
  }
  return refuseMeasurements({
    name: 'closures-ledger',
    scope: 'every physical JSONL line in the supplied closures file; final LF terminates the last record',
    format: 'render(parse(line)) byte equality (ordered JSON.stringify + LF), no blank lines, unique receipt; receipt/frame exact ASCII ^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$',
    nonCanonicalCount: new Set(preflight.issues.map(u=>u.row)).size, offendingRows: [...new Set(preflight.issues.map(u=>u.row))].slice(0,20),
    receipts: rows.length,
    receiptsWithCommit: withCommit,
    receiptsWithReceiptId: withReceipt,
    value: rows.length && invalid.length === 0 && preflight.issues.length === 0 ? withReceipt / rows.length : null,
    unit: 'receiptCoverage_of_closure_records',
    denominator: {
      n: rows.length,
      of: 'closure_records_in_CLOSURES.jsonl',
      note: 'coverage of receipt ids; frame open/verdict split lives in the registry, not here',
    },
    unknowns: [
      ...preflight.issues,
      ...invalid,
      ...(rows.length === 0 ? [{ field: 'value', reason: 'no-records' }] : []),
      { field: 'openFrames', reason: 'CLOSURES.jsonl records closed work only' },
    ],
  }, ['value','receipts','receiptsWithCommit','receiptsWithReceiptId']);
}

const packageA=require('./refused-package.cjs').protect(packageAUnsafe);

const packageB=require('./refused-package.cjs').protect(packageBUnsafe);

function main(argv) {
  let framesFile = FRAMES, closuresFile = CLOSURES;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--frames' || k === '--closures') {
      const f = argv[++i];
      if (!f) return usage('missing value for ' + k);
      if (k === '--frames') framesFile = f; else closuresFile = f;
    } else return usage('unknown argument: ' + k);
  }
  let fp, cp;
  try {
    fp = parseFrames(path.resolve(framesFile));
    cp = parseClosures(path.resolve(closuresFile));
  } catch (e) { try{return usage(e.message);}catch{return usage('exception-unreadable');} }
  const pa = packageA(fp);
  if(!pa.reason){
  pa.path = path.relative(ROOT, path.resolve(framesFile)).replace(/\\/g, '/');
  pa.sha256 = fp.sha256; pa.bytes = fp.bytes;
  }
  const pb = packageB(cp);
  if(!pb.reason){
  pb.path = path.relative(ROOT, path.resolve(closuresFile)).replace(/\\/g, '/');
  pb.sha256 = cp.sha256; pb.bytes = cp.bytes;
  }
  const result = {
    metric: 'M-010',
    title: 'Frames with a recorded verdict against open frames, by stream; DIG counters',
    advisory: true,
    generatedAt: new Date().toISOString(),
    value: pa.value,
    unit: 'openShare_of_frames',
    denominator: pa.denominator||null,
    unknowns: [pa,pb].flatMap(p=>p.reason?[{reason:p.reason}]:(p.unknowns||[])),
    packages: { a: pa, b: pb },
    consumer: {
      decision: 'P-L0-008 trial; the "implement first" mode',
      status: 'trial unchanged; open share and counters measured, verdicted share unknown',
      basis: 'the research index is not built yet; this leaf reads the live registry and closures ledger but cannot promote or retire the trial on a free-text record column',
    },
    sources: [
      pa.reason ? pa : { path: pa.path, sha256: fp.sha256, bytes: fp.bytes, records: fp.frames.length },
      pb.reason ? pb : { path: pb.path, sha256: cp.sha256, bytes: cp.bytes, records: cp.rows.length },
    ],
  };
  process.stdout.write(JSON.stringify(result, null, 1) + '\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { parseFrames, parseClosures, packageA, packageB };

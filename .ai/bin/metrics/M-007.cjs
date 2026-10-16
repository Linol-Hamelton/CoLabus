'use strict';
// M-007: full cost of a closed task - tokens, wall time, model, effort (
// id M-007; debt row L6-M007). Separate leaf file. ADVISORY only. Unknown is never a
// number. Median only when n>=5 timed (PROTO-DEC-0167 п.4). CodeBurn is NOT used (В-19).
//
//   node .ai/bin/metrics/M-007.cjs [--a JSONL] [--b JSONL]
//     --a/--b  launch-record/1 journals of closed runs (default A: farm FARM-RUNS.jsonl
//              variant "none" closed with a verdict; B: variant "pointer" — two comparable
//              packages of closed work on the same farm tasks).
// Exit: 0 computed (value may be null); 2 usage, unreadable or undecodable source.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const textSafe = require('../lib/text-safe.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const JOURNAL = path.join(ROOT, 'docs', 'ops', 'farm', 'FARM-RUNS.jsonl');

function usage(msg) { process.stderr.write(String(msg) + '\n'); return 2; }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function readText(file) {
  const buf = fs.readFileSync(file);
  const d = textSafe.decode(buf, { bom: 'strip', crlf: 'normalise' });
  if (!d.ok) throw new Error('undecodable: ' + path.relative(ROOT, file));
  return { text: d.text, bytes: buf.length, sha256: sha256(buf) };
}

function readJsonl(file) {
  const { text, bytes, sha256: sha } = readText(file);
  const rows = [];
  text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let o;
    try { o = JSON.parse(line); } catch (e) { throw new Error(path.basename(file) + ':' + (i + 1) + ' invalid JSON'); }
    rows.push(o);
  });
  return { rows, bytes, sha256: sha };
}

// A closed task: a finished farm run with a verdict token and a tuple (model identified).
const isClosed = (r) => (r.verdict === 'PASS' || r.verdict === 'FAIL' || r.verdict === 'BLOCKED' || r.verdict === 'RECOMMENDATION')
  && r.tuple && typeof r.tuple.model === 'string';
const isVariant = (r, v) => r.variant === v;

function median(nums) {
  if (nums.length < 5) return null; // 0167 п.4: no median below 5 timed values
  const s = [...nums].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function inventory(rows, label, variant) {
  const closed = variant === null ? rows.filter(isClosed) : rows.filter((r) => isClosed(r) && isVariant(r, variant));
  const wall = closed.map((r) => (typeof r.wallSeconds === 'number' && r.wallSeconds >= 0 ? r.wallSeconds : null));
  const timed = wall.filter((x) => x !== null);
  const tokensOut = closed.map((r) => (r.tokens && typeof r.tokens.output === 'number' && r.tokens.output >= 0 ? r.tokens.output : null)).filter((x) => x !== null);
  const models = new Set(closed.map((r) => r.tuple.model));
  return {
    name: label,
    variant,
    records: rows.length,
    closedTasks: closed.length,
    timedWall: timed.length,
    medianWallSeconds: median(timed),
    tokensOutKnown: tokensOut.length,
    medianTokensOut: median(tokensOut),
    models: [...models].sort(),
    value: median(timed),
    unit: 'wallSeconds_median_of_closed_tasks',
    denominator: {
      n: closed.length,
      of: 'closed_tasks_with_verdict_and_model',
      note: 'median only when n>=5 timed (0167 п.4); untimed closed tasks stay in the denominator and never become 0',
    },
    unknowns: [
      { field: 'wallSeconds', reason: closed.length - timed.length + ' closed task(s) carry no usable wallSeconds' },
      { field: 'tokensOut', reason: closed.length - tokensOut.length + ' closed task(s) carry no tokens.output' },
      { field: 'costUsd', reason: 'farm records carry no cost; CodeBurn is not permitted (В-19), so cost stays unknown' },
    ],
  };
}

function main(argv) {
  let a = JOURNAL, b = JOURNAL;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--a' || k === '--b') {
      const f = argv[++i];
      if (!f) return usage('missing value for ' + k);
      if (k === '--a') a = f; else b = f;
    } else return usage('unknown argument: ' + k);
  }
  let srcA, srcB;
  try {
    srcA = readJsonl(path.resolve(a));
    srcB = srcA && path.resolve(b) === path.resolve(a) ? srcA : readJsonl(path.resolve(b));
  } catch (e) { return usage(e.message); }
  const pa = inventory(srcA.rows, 'farm-closed-variant-none', 'none');
  pa.sha256 = srcA.sha256; pa.path = path.relative(ROOT, path.resolve(a)).replace(/\\/g, '/');
  const pb = inventory(srcB.rows, 'farm-closed-variant-pointer', 'pointer');
  pb.sha256 = srcB.sha256; pb.path = path.relative(ROOT, path.resolve(b)).replace(/\\/g, '/');
  const result = {
    metric: 'M-007',
    title: 'Full cost of a closed task (tokens, time, model; no CodeBurn)',
    advisory: true,
    generatedAt: new Date().toISOString(),
    value: pa.value,
    unit: 'wallSeconds_median_of_closed_tasks',
    denominator: pa.denominator,
    unknowns: pa.unknowns,
    packages: { a: pa, b: pb },
    consumer: {
      decision: 'complexity rubric and rank selection for future tasks',
      status: 'descriptive medians only; no ranking published',
      basis: 'closed-task wall medians exist per variant when n>=5; served attribution is OPEN and costUsd unknown, so no model rank may be derived (FINAL §3.3/§3.4)',
    },
  };
  process.stdout.write(JSON.stringify(result, null, 1) + '\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { readJsonl, inventory, median, isClosed, JOURNAL };

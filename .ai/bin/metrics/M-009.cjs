'use strict';
// M-009: spread of repeated comparative runs of one variant against the difference
// between variants (M-009; P-L0-007; debt row L6-M009). Separate
// leaf file. ADVISORY only. Unknown is never a number. Median only when n>=5 (0167 п.4).
//
//   node .ai/bin/metrics/M-009.cjs [--a JSONL] [--b JSONL]
//     --a/--b  launch-record/1 journals of comparative runs (default: farm FARM-RUNS.jsonl
//              read once; package A = within-variant repeat groups, package B = pairs of
//              variants on the same task+model — two comparable slices of one corpus).
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

const wallOf = (r) => (typeof r.wallSeconds === 'number' && r.wallSeconds >= 0 ? r.wallSeconds : null);

function median(nums) {
  if (nums.length < 5) return null;
  const s = [...nums].sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function inventoryA(rows) {
  // Within-variant repeats: same (task, model, variant), >=2 timed runs.
  const g = new Map();
  for (const r of rows) {
    const model = r.tuple && typeof r.tuple.model === 'string' ? r.tuple.model : null;
    if (!r.task || model === null || !r.variant) continue;
    const w = wallOf(r);
    if (w === null) continue;
    const k = [r.task, model, r.variant].join('|');
    if (!g.has(k)) g.set(k, []);
    g.get(k).push(w);
  }
  const groups = [...g.entries()].filter(([, ws]) => ws.length >= 2).map(([key, ws]) => ({
    key,
    n: ws.length,
    wallRange: Math.max(...ws) - Math.min(...ws),
    walls: ws,
  })).sort((x, y) => (x.key < y.key ? -1 : 1));
  const ranges = groups.map((g) => g.wallRange);
  return {
    name: 'within-variant-repeats',
    repeatGroups: groups.length,
    groups,
    medianWallRangeSeconds: median(ranges),
    value: median(ranges),
    unit: 'wallSeconds_range_median_across_repeat_groups',
    denominator: {
      n: groups.length,
      of: 'task_model_variant_groups_with_at_least_2_timed_runs',
      note: 'median of ranges only when n>=5 groups (0167 п.4)',
    },
    unknowns: [
      { field: 'repeatGroups', reason: 'most (task, model, variant) cells have a single attempt; repeats are scarce' },
    ],
  };
}

function inventoryB(rows) {
  // Between-variant difference: same (task, model) with both variants present.
  const g = new Map();
  for (const r of rows) {
    const model = r.tuple && typeof r.tuple.model === 'string' ? r.tuple.model : null;
    if (!r.task || model === null || !r.variant) continue;
    const w = wallOf(r);
    if (w === null) continue;
    const k = [r.task, model].join('|');
    if (!g.has(k)) g.set(k, new Map());
    const byV = g.get(k);
    if (!byV.has(r.variant)) byV.set(r.variant, []);
    byV.get(r.variant).push(w);
  }
  const pairs = [];
  for (const [key, byV] of g) {
    if (byV.size < 2) continue;
    const variants = [...byV.keys()].sort();
    const medians = variants.map((v) => {
      const ws = byV.get(v);
      if (ws.length < 5) return null;
      const s = [...ws].sort((x, y) => x - y);
      const m = s.length >> 1;
      return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
    });
    if (medians.some((m) => m === null)) continue;
    pairs.push({ key, variants, medians, delta: Math.abs(medians[0] - medians[1]) });
  }
  const deltas = pairs.map((p) => p.delta);
  return {
    name: 'between-variant-delta',
    variantPairs: pairs.length,
    pairs: pairs.slice(0, 50),
    medianWallDeltaSeconds: median(deltas),
    value: median(deltas),
    unit: 'wallSeconds_absDelta_median_across_variant_pairs',
    denominator: {
      n: pairs.length,
      of: 'task_model_cells_with_two_variants_each_n_ge_5_timed',
      note: 'a pair contributes only when each variant cell has n>=5 timed runs (0167 п.4)',
    },
    unknowns: [
      { field: 'variantPairs', reason: 'cells below n=5 per variant are excluded, never given a median' },
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
  let src;
  try { src = readJsonl(path.resolve(a)); } catch (e) { return usage(e.message); }
  const pa = inventoryA(src.rows);
  const pb = inventoryB(src.rows);
  pa.sha256 = src.sha256; pa.path = path.relative(ROOT, path.resolve(a)).replace(/\\/g, '/');
  pb.sha256 = src.sha256; pb.path = pa.path;
  const within = pa.value, between = pb.value;
  const distinguishable = within === null || between === null ? null : within < between;
  const result = {
    metric: 'M-009',
    title: 'Spread of repeated comparative runs against the difference between variants',
    advisory: true,
    generatedAt: new Date().toISOString(),
    value: between,
    unit: 'wallSeconds_absDelta_median_across_variant_pairs',
    denominator: pb.denominator,
    unknowns: [...pa.unknowns, ...pb.unknowns],
    packages: { a: pa, b: pb },
    distinguishable,
    consumer: {
      decision: 'P-L0-007 trial: is a comparative test result distinguishable from run noise',
      status: distinguishable === null ? 'undecided (repeat or variant cells below n>=5)' : (distinguishable ? 'differences currently exceed measured within-variant ranges' : 'differences do NOT exceed within-variant ranges; do not trust a single comparative run'),
      basis: 'within-variant range median vs between-variant delta median, both with explicit denominators; no promotion of P-L0-007 without fill',
    },
    sources: [{ path: pa.path, sha256: src.sha256, bytes: src.bytes, records: src.rows.length }],
  };
  process.stdout.write(JSON.stringify(result, null, 1) + '\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { readJsonl, inventoryA, inventoryB, median, wallOf, JOURNAL };

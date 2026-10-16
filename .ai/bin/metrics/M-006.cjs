'use strict';
// M-006: share of instruction context against work ( §6 id M-006:
// packet bytes / bytes read; debt row L6-M006). Separate leaf file. ADVISORY only.
// Unknown is never a number: bytes actually read by a seat are not recorded, so the
// share stays null; packetBytes and prompt-file bytes are measured as fills.
//
//   node .ai/bin/metrics/M-006.cjs [--a JSONL] [--b JSONL]
//     --a/--b  launch-record/1 journals (default A: benchmark-catalog LAUNCHES.jsonl,
//              B: calibration-farm FARM-RUNS.jsonl — two comparable corpora of launches).
// Exit: 0 computed (value may be null); 2 usage, unreadable or undecodable source.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const textSafe = require('../lib/text-safe.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const JOURNAL_A = path.join(ROOT, 'docs', 'product', 'launch-records', 'launches', 'LAUNCHES.jsonl');
const JOURNAL_B = path.join(ROOT, 'docs', 'ops', 'farm', 'FARM-RUNS.jsonl');

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

function promptBytes(rec) {
  if (!rec.promptPath || typeof rec.promptPath !== 'string') return null;
  const abs = path.resolve(ROOT, rec.promptPath);
  if (!abs.startsWith(ROOT + path.sep)) return null;
  try { return fs.statSync(abs).size; } catch (e) { return null; }
}

function inventory(file, label) {
  const { rows, bytes, sha256: sha } = readJsonl(file);
  let withPacket = 0, withPromptBytes = 0, withBoth = 0;
  const shares = [];
  for (const r of rows) {
    const packet = typeof r.packetBytes === 'number' && r.packetBytes >= 0 ? r.packetBytes : null;
    const pb = promptBytes(r);
    if (packet !== null) withPacket++;
    if (pb !== null) withPromptBytes++;
    if (packet !== null && pb !== null) {
      withBoth++;
      // The metric needs BYTES READ by the seat; prompt file size is only the stored
      // instruction footprint and is NOT substituted for bytes read. The share is null.
    }
  }
  return {
    name: label,
    path: path.relative(ROOT, file).replace(/\\/g, '/'),
    sha256: sha,
    bytes,
    records: rows.length,
    recordsWithPacketBytes: withPacket,
    recordsWithPromptFileBytes: withPromptBytes,
    recordsWithBothStored: withBoth,
    value: null,
    unit: 'packetBytes_over_bytesRead',
    denominator: {
      n: rows.length,
      of: 'launch_records_in_journal',
      note: 'fill of packetBytes and prompt files is measured; the share needs bytesRead, which no record carries',
    },
    unknowns: [
      { field: 'bytesRead', reason: 'launch-record/1 has no bytesRead field; prompt file size is not the bytes the seat read' },
    ],
    sources: [{ path: path.relative(ROOT, file).replace(/\\/g, '/'), sha256: sha, bytes }],
  };
}

function main(argv) {
  let a = JOURNAL_A, b = JOURNAL_B;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--a' || k === '--b') {
      const f = argv[++i];
      if (!f) return usage('missing value for ' + k);
      if (k === '--a') a = f; else b = f;
    } else return usage('unknown argument: ' + k);
  }
  let pa, pb;
  try {
    pa = inventory(path.resolve(a), 'benchmark-catalog-launches');
    pb = inventory(path.resolve(b), 'calibration-farm-runs');
  } catch (e) { return usage(e.message); }
  const result = {
    metric: 'M-006',
    title: 'Share of instruction context against work (packet bytes / bytes read)',
    advisory: true,
    generatedAt: new Date().toISOString(),
    value: null,
    unit: 'packetBytes_over_bytesRead',
    denominator: { n: pa.records + pb.records, of: 'launch_records_across_both_journals', note: 'share stays null until bytesRead is recorded' },
    unknowns: pa.unknowns,
    packages: { a: pa, b: pb },
    consumer: {
      decision: 'layer context budgets (layer context contract); packet profile bands',
      status: 'unchanged (no share fillable)',
      basis: 'packetBytes fill differs sharply between the two journals (farm records it, catalog launches mostly do not); budget decisions need bytesRead, not prompt size',
    },
  };
  process.stdout.write(JSON.stringify(result, null, 1) + '\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { readJsonl, inventory, JOURNAL_A, JOURNAL_B };

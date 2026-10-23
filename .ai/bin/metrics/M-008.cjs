'use strict';
// M-008: signals per package by type; time until a group closes (M-008).
// Separate leaf file. ADVISORY only.
// Unknown is never a number. Time-to-close is day-granular (the ledger stores dates).
//
//   node .ai/bin/metrics/M-008.cjs [--a FILE] [--b FILE]
//     --a/--b  signals ledgers (default: .ai/SIGNALS.md split into two comparable date
//              packages: signals dated >=2026-10-05 and earlier).
// Exit: 0 computed (value may be null); 2 usage, unreadable or undecodable source.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const textSafe = require('../lib/text-safe.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const LEDGER = path.join(ROOT, '.ai', 'SIGNALS.md');
const SINCE = '2026-10-05';
// Closed grammar of one ledger row (allow-list): Signal: id | type | date | agent | loc |
// attempts | state | rc | batch | src=(hex64 | -). The ledger's own two src forms are
// accepted; any other shape is not a signal.
const SIGNAL_LINE = /^Signal:\s+(sig-\d{8}-\d{3})\s*\|\s*([a-z-]+)\s*\|\s*(\d{4}-\d{2}-\d{2})\s*\|\s*([^\s|]+)\s*\|\s*([^\s|]+)\s*\|\s*([^\s|]+)\s*\|\s*(open|closed:[^\s|]*)\s*\|\s*rc=([^\s|]*)\s*\|\s*batch=([^\s|]*)\s*\|\s*src=(-|[0-9a-f]{64})\s*$/;

function usage(msg) { process.stderr.write(String(msg) + '\n'); return 2; }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function readText(file) {
  const buf = fs.readFileSync(file);
  const d = textSafe.decode(buf, { bom: 'strip', crlf: 'normalise' });
  if (!d.ok) throw new Error('undecodable: ' + path.relative(ROOT, file));
  return { text: d.text, bytes: buf.length, sha256: sha256(buf) };
}

function parseSignals(file) {
  const { text, bytes, sha256: sha } = readText(file);
  const mask = textSafe.maskMarkdown(text);
  const rows = [];
  const unparsed = [];
  mask.lines.forEach((row, i) => {
    if (!row || row.masked || row.partial) return;
    if (!/^Signal:\s/.test(row.text)) return;
    const m = SIGNAL_LINE.exec(row.text);
    if (!m) { unparsed.push(i + 1); return; }
    rows.push({ id: m[1], type: m[2], date: m[3], agent: m[4], location: m[5], attempts: m[6], state: m[7], rc: m[8], batch: m[9], src: m[10], line: i + 1 });
  });
  return { rows, unparsed, bytes, sha256: sha };
}

function inventory(rows, label) {
  const byType = {};
  let closed = 0, open = 0;
  const days = [];
  for (const r of rows) {
    byType[r.type] = (byType[r.type] || 0) + 1;
    if (r.state === 'open') open++;
    else if (r.state.startsWith('closed:')) {
      closed++;
      // close date is not stored separately; the ledger line carries only the open date
      // and a closed:location state. Day-granular time-to-close is therefore unknown.
    }
  }
  return {
    name: label,
    signals: rows.length,
    byType,
    open,
    closed,
    meanDaysToClose: null,
    value: rows.length ? closed / rows.length : null,
    unit: 'closedShare_of_signals',
    denominator: {
      n: rows.length,
      of: 'signals_in_package',
      note: 'closed share is measured; time-to-close needs a close date the ledger does not store',
    },
    unknowns: [
      { field: 'daysToClose', reason: 'SIGNALS.md rows carry an open date and a closed:location state, not a close date' },
      { field: 'groupCloseTime', reason: 'a group (type) closes only when every signal closes;  the same missing close dates propagate' },
    ],
  };
}

function main(argv) {
  let a = LEDGER, b = LEDGER, customA = false, customB = false;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--a' || k === '--b') {
      const f = argv[++i];
      if (!f) return usage('missing value for ' + k);
      if (k === '--a') { a = f; customA = true; } else { b = f; customB = true; }
    } else return usage('unknown argument: ' + k);
  }
  let parsedA;
  try { parsedA = parseSignals(path.resolve(a)); } catch (e) { return usage(e.message); }
  if (parsedA.unparsed.length) return usage('unparsed signal lines at: ' + parsedA.unparsed.join(','));
  let parsedB = parsedA;
  if (path.resolve(b) !== path.resolve(a)) {
    try { parsedB = parseSignals(path.resolve(b)); } catch (e) { return usage(e.message); }
    if (parsedB.unparsed.length) return usage('unparsed signal lines at: ' + parsedB.unparsed.join(','));
  }
  // A custom --a/--b package is taken whole; only the default ledger is split by date.
  const rowsA = customA ? parsedA.rows : parsedA.rows.filter((r) => r.date >= SINCE);
  const rowsB = customB ? parsedB.rows : parsedB.rows.filter((r) => r.date < SINCE);
  const pa = inventory(rowsA, customA ? 'package-a' : 'kernel-completion-window');
  const pb = inventory(rowsB, customB ? 'package-b' : 'pre-window');
  pa.path = customA ? path.relative(ROOT, path.resolve(a)).replace(/\\/g, '/') : '.ai/SIGNALS.md (date>=' + SINCE + ')';
  pa.sha256 = parsedA.sha256; pa.bytes = parsedA.bytes;
  pb.path = customB ? path.relative(ROOT, path.resolve(b)).replace(/\\/g, '/') : '.ai/SIGNALS.md (date<' + SINCE + ')';
  pb.sha256 = parsedB.sha256; pb.bytes = parsedB.bytes;
  const result = {
    metric: 'M-008',
    title: 'Signals per package by type; time until a group closes',
    advisory: true,
    generatedAt: new Date().toISOString(),
    value: pa.value,
    unit: 'closedShare_of_signals',
    denominator: pa.denominator,
    unknowns: pa.unknowns,
    packages: { a: pa, b: pb },
    consumer: {
      decision: 'priority of procedural work (which signal type drains first)',
      status: 'open/closed shares measured per window; close-time priority unchanged',
      basis: 'the closed share and the type histogram are real; without close dates a group-time ranking would be fabricated',
    },
    sources: [{ path: '.ai/SIGNALS.md', sha256: parsedA.sha256, bytes: parsedA.bytes, records: parsedA.rows.length }],
  };
  process.stdout.write(JSON.stringify(result, null, 1) + '\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { SIGNAL_LINE, parseSignals, inventory, SINCE };

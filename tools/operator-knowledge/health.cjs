'use strict';
// Pulse interface: no declared values or raw launch output enter this report.
const rs = require('./route-state.cjs');
const live = require('./launch-evidence.cjs');
function health(record, launches, now) {
  const state = rs.stateAt(record, now, { launches, purpose: 'advice' });
  const counts = { ok: 0, failed: 0, unknown: 0 };
  for (const row of state.routes) counts[row.state]++;
  return { at: state.at, counts, total: state.routes.length,
    routes: state.routes.map(({ id, state, reasons, evidence, warnings }) => ({ id, state, reasons, warnings,
      source: evidence?.source || null, basis: evidence?.basis || null, at: evidence?.at || null, expiresAt: evidence?.expiresAt || null })) };
}
function main(argv) {
  try {
    const f = rs.parseFlags(argv, ['record', 'journal', 'now', 'json'], ['json']);
    if (f._.length) throw new rs.Refusal('USAGE', 'unexpected argument');
    const record = rs.loadRecord(f.record ? rs.resolvePathArg(f.record, 'record') : rs.RECORD_FILE);
    const launches = live.readLiveLaunches(f.journal ? [rs.resolvePathArg(f.journal, 'journal')] : undefined);
    const result = health(record, launches, f.now || new Date().toISOString());
    if (f.json) process.stdout.write(`${JSON.stringify(result)}\n`);
    else {
      process.stdout.write(`ROUTE-HEALTH at=${result.at} total=${result.total} ok=${result.counts.ok} failed=${result.counts.failed} unknown=${result.counts.unknown}\n`);
      for (const row of result.routes) process.stdout.write(`${row.id} ${row.state} source=${row.source || 'none'} basis=${row.basis || 'none'} at=${row.at || 'none'} reasons=${row.reasons.join(',') || 'none'} warnings=${row.warnings.join(',') || 'none'}\n`);
    }
    return 0;
  } catch (e) { process.stderr.write(`REFUSED ${e instanceof rs.Refusal ? e.code : 'LAUNCH_EVIDENCE_UNREADABLE'}\n`); return 4; }
}
module.exports = { health, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

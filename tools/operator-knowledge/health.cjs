'use strict';
// Pulse interface: no declared values or raw launch output enter this report. The one derived exception is the reset time of a quota
// failure: the time the launch record names (source client-text), else the "resets at <time>" the owner declared in the limit field of
// the route (source route-declaration, read by the closed grammar of quota-reset.cjs declaredReset), else unknown; never the declared text.
const rs = require('./route-state.cjs');
const live = require('./launch-evidence.cjs');
const quotaLib = require('../../.ai/bin/accounting/lib/quota-reset.cjs');
function quotaResetOf(route, evidence, nowMs) {
  if (evidence?.source !== 'launch' || !['QUOTA', 'QUOTA_EXCEEDED', 'NO_CREDITS'].includes(evidence.reason)) return null;
  if (evidence.quotaReset?.resetAt) return { at: evidence.quotaReset.resetAt, source: 'client-text', format: evidence.quotaReset.format };
  const limit = route?.fields?.limit;
  const effective = limit && limit.tag === 'declared' && Date.parse(limit.declaredAt) <= nowMs && nowMs < Date.parse(limit.expiresAt);
  const declared = effective ? quotaLib.declaredReset(limit.value) : null;
  return { at: declared, source: declared ? 'route-declaration' : 'none', format: evidence.quotaReset?.format || null };
}
function health(record, launches, now) {
  const state = rs.stateAt(record, now, { launches, purpose: 'advice' });
  const counts = { ok: 0, failed: 0, unknown: 0 };
  for (const row of state.routes) counts[row.state]++;
  const nowMs = Date.parse(state.at);
  return { at: state.at, counts, total: state.routes.length,
    routes: state.routes.map(({ id, state, reasons, evidence, warnings }) => ({ id, state, reasons, warnings,
      source: evidence?.source || null, basis: evidence?.basis || null, at: evidence?.at || null, expiresAt: evidence?.expiresAt || null,
      quotaReset: quotaResetOf(record.routes.find(r => r.id === id), evidence, nowMs) })) };
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
      for (const row of result.routes) process.stdout.write(`${row.id} ${row.state} source=${row.source || 'none'} basis=${row.basis || 'none'} at=${row.at || 'none'} reasons=${row.reasons.join(',') || 'none'} warnings=${row.warnings.join(',') || 'none'}${row.quotaReset ? ` quota-reset=${row.quotaReset.at || 'unknown'} reset-source=${row.quotaReset.source}` : ''}\n`);
    }
    return 0;
  } catch (e) { process.stderr.write(`REFUSED ${e instanceof rs.Refusal ? e.code : 'LAUNCH_EVIDENCE_UNREADABLE'}\n`); return 4; }
}
module.exports = { health, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

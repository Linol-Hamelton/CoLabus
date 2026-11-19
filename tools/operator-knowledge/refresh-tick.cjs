'use strict';
// One tick for the admitted LOOP-SUPERVISOR runner. No timer or scheduler here.
const fs = require('node:fs');
const path = require('node:path');
const rs = require('./route-state.cjs');
const live = require('./launch-evidence.cjs');
const probe = require('./probe.cjs');
const safe = require('../../.ai/bin/lib/path-safe.cjs');
const text = require('../../.ai/bin/lib/text-safe.cjs');
const policy = require('./route-refresh.loop.json');
function selectRoute(record, launches, nowMs) {
  return record.routes.filter(r => !probe.isScarce(r.client) && Object.hasOwn(probe.COMMANDS, r.client)
    && ['free', 'subscription'].includes(r.billing) && !live.hasRecentLaunch(launches, r, nowMs)
    && !(r.fields.probe && Date.parse(r.fields.probe.measuredAt) <= nowMs && Date.parse(r.fields.probe.expiresAt) > nowMs))
    .sort((a, b) => (Date.parse(a.fields.probe?.measuredAt) || 0) - (Date.parse(b.fields.probe?.measuredAt) || 0) || a.id.localeCompare(b.id))[0] || null;
}
function tick({ recordFile = rs.RECORD_FILE, stateFile = path.join(rs.REPO, '.ai/runtime/route-refresh.json'), nowMs = Date.now(), launches }, deps = {}) {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new rs.Refusal('TIME_INVALID');
  const root = path.parse(path.resolve(stateFile)).root;
  const write = value => {
    const result = safe.writeAtomicGuarded(stateFile, Buffer.from(`${JSON.stringify(value)}\n`), { root });
    if (!result.ok) throw new rs.Refusal('TICK_WRITE_REFUSED');
  };
  const candidate = rs.withRecordLock(stateFile, () => {
    if (fs.existsSync(stateFile)) {
      const read = safe.readFileGuarded(root, stateFile);
      if (!read.ok) throw new rs.Refusal('TICK_READ_REFUSED');
      const prior = text.parseJsonUnique(read.bytes.toString('utf8'));
      if (prior.schema !== 'route-refresh/1' || !Number.isSafeInteger(prior.nextAt)) throw new rs.Refusal('TICK_STATE_INVALID');
      if (nowMs < prior.nextAt) return null;
    }
    const records = launches || live.readLiveLaunches();
    const route = selectRoute(rs.loadRecord(recordFile), records, nowMs);
    if (!route) return null;
    // Reserve before calling the client: a crash still leaves a bounded cooldown.
    write({ schema: 'route-refresh/1', nextAt: nowMs + probe.TIMEOUT_MS + policy.intervalMs });
    return { route, records };
  });
  if (!candidate) return { outcome: 'skipped' };
  const code = (deps.refresh || require('./refresh.cjs').main)(['--record', recordFile, '--route', candidate.route.id, '--probe', '--expired', '--now', rs.isoOf(nowMs)], { launches: candidate.records });
  // Never shorten a reservation on failure. This timestamp uses elapsed time in
  // production; deterministic fixtures may supply a completion clock.
  if (code === 0) rs.withRecordLock(stateFile, () => write({ schema: 'route-refresh/1', nextAt: (deps.completedAt ? deps.completedAt() : Date.now()) + policy.intervalMs }));
  return { outcome: code === 0 ? 'refreshed' : 'failed', route: candidate.route.id, code };
}
function main(argv) {
  if (argv.length) return 2;
  try { const result = tick({}); process.stdout.write(`ROUTE-REFRESH ${result.outcome}\n`); return result.code || 0; }
  catch { process.stderr.write('REFUSED ROUTE_REFRESH_STATE\n'); return 4; }
}
module.exports = { selectRoute, tick, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

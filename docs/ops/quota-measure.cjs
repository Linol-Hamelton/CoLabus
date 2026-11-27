'use strict';
// S5 read-only day totals. No repricing old launches with today's prices; unknown is not zero.
const fs = require('node:fs');
const Q = require('./quota-preflight.cjs');
const D = require('../../.ai/bin/accounting/lib/decimal.cjs');
function measure(buffers) {
  const groups = new Map(); let malformed = 0; let rows = 0;
  for (const bytes of buffers) for (const line of bytes.toString('utf8').split(/\r?\n/).filter(Boolean)) {
    rows++;
    let r; try { r = JSON.parse(line); } catch { malformed++; continue; }
    if (!r || r.schema !== 'launch-record/1' || typeof r.launchId !== 'string') { malformed++; continue; }
    const group = groups.get(r.launchId) || []; group.push(r); groups.set(r.launchId, group);
  }
  const days = {}; let undated = 0;
  for (const group of groups.values()) {
    const starts = [...new Set(group.map(r => r.startedAt).filter(s => typeof s === 'string' && Number.isFinite(Date.parse(s))))];
    if (starts.length !== 1) { undated++; continue; }
    const day = new Date(starts[0]).toISOString().slice(0,10);
    const d = days[day] ||= { launches:0, known:0, unknown:0, knownUsd:'0', totalUsd:null, over15:null };
    d.launches++;
    const costs = group.filter(r => Object.hasOwn(r, 'cost')).map(r => {
      const c = typeof r.cost === 'number' && Number.isFinite(r.cost) ? String(r.cost) :
        r.cost && typeof r.cost.usd === 'string' ? r.cost.usd : null;
      return Q.money(c) ? D.toString(Q.money(c)) : null;
    });
    const unique = [...new Set(costs)];
    if (unique.length !== 1 || unique[0] === null) d.unknown++;
    else { d.known++; d.knownUsd = D.toString(D.add(Q.money(d.knownUsd), Q.money(unique[0]))); }
  }
  for (const d of Object.values(days)) {
    if (!d.unknown && !malformed && !undated) { d.totalUsd = d.knownUsd; d.over15 = D.cmp(Q.money(d.totalUsd), Q.money('15')) > 0; }
  }
  return { rows, launches: groups.size, malformed, undated, days,
    sources: buffers.map(b => ({ sha256: Q.hash(b), bytes: b.length })) };
}
if (require.main === module && (process.argv.includes('--help') || process.argv.includes('-h'))) {
  process.stdout.write('usage: quota-measure.cjs FILE...  (measures the given quota captures; prints JSON)\n');
} else if (require.main === module) {
  try { process.stdout.write(JSON.stringify(measure(process.argv.slice(2).map(f => fs.readFileSync(f))),null,2) + '\n'); }
  catch { process.stderr.write('measurement-input-unavailable\n'); process.exitCode = 2; }
}
module.exports = { measure };

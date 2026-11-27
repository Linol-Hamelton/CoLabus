'use strict';
// Recommendation vs actual invocation vs observed outcome. Read-only, never a gate.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const repoPaths = require('../../.ai/bin/repo-paths.cjs');
const { row, groups, compareRoutes } = require("../../.ai/bin/lib/selection-metrics.cjs");
async function collect({ runtime, launches }) {
  const records = new Map(), events = new Map();
  function add(r, source) {
    const item = row(r, source); if (!item) return;
    const old = records.get(item.id);
    // The wrapper owns terminal routing; an inner review can enrich its verdict.
    const preferOld = old && old.source === 'wrapper' && (old.outcome.endedAt || !item.outcome.endedAt);
    if (preferOld) {
      records.set(item.id, { ...old, outcome: { ...old.outcome, verdict: item.outcome.verdict || old.outcome.verdict } });
    } else records.set(item.id, { ...item, outcome: { ...item.outcome, verdict: item.outcome.verdict || old?.outcome.verdict || null } });
  }
  if (runtime) {
    // Running first; terminal of the same exact attempt wins. Reused names stay distinct.
    for (const suffix of ['.running.json', '.terminal.json']) for (const name of fs.readdirSync(runtime).filter(n => n.endsWith(suffix)).sort()) {
      add(JSON.parse(fs.readFileSync(path.join(runtime, name), 'utf8')), 'wrapper');
    }
  }
  if (launches) {
    const files = fs.statSync(launches).isDirectory() ? fs.readdirSync(launches).filter(n => n.endsWith('.jsonl')).sort().map(n => path.join(launches, n)) : [launches];
    for (const file of files) {
      const lines = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
      for await (const line of lines) if (line.trim()) {
        const r = JSON.parse(line);
        if (r.launchId) {
          const previous = events.get(r.launchId) || {};
          // Outcome/review events are additive. A late start must not erase a finish.
          const merged = r.event === 'started' || !r.event ? { ...r, ...previous } : { ...previous, ...r };
          events.set(r.launchId, merged);
        }
      }
    }
    for (const r of events.values()) add(r, 'launch-record');
  }
  return [...records.values()].sort((a, b) => a.id.localeCompare(b.id));
}
const tuple = v => v ? `${v.client}:${v.model || 'unknown'}:${v.effort || 'unknown'}` : 'unknown';
async function main(argv, deps = {}) {
  const say = deps.say || (s => process.stdout.write(`${s}\n`));
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--json') opts.json = true;
    else if (['--runtime', '--launches'].includes(argv[i]) && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      const key = argv[i].slice(2); opts[key] = argv[++i];
    }
    else { say('usage: selection-intake-report.cjs [--runtime DIR] [--launches FILE_OR_DIR] [--json]'); return 2; }
  }
  try {
    // Explicit sources are complete on their own; a missing source is an error,
    // while an existing empty source is a valid report with zero observations.
    const explicit = opts.runtime !== undefined || opts.launches !== undefined;
    const rows = await collect(explicit ? opts : { runtime: repoPaths.runtimeDir(), launches: repoPaths.pendingDir() });
    if (opts.json) say(JSON.stringify({ schema: 'selection-intake-report/1', mode: 'shadow', rows, groups: groups(rows) }));
    else {
      say('id | source | role/domain | risk | tier | recommendation | actual | exact | exit | verdict | failure | scope');
      for (const r of rows) say([r.id, r.source, `${r.role}/${r.domain || 'unknown'}`, `${r.riskClass}${r.riskKnown ? '' : '(unknown)'}`, r.tier,
        tuple(r.recommendation), tuple(r.actual), r.exactMatch ?? 'unknown', r.outcome.exitCode ?? 'unknown', r.outcome.verdict || 'unknown', r.outcome.failureClass || '-', r.scope?.reason || 'declared-or-unknown'].join(' | '));
      const columns = ['taskClass', 'tier', 'pairs', 'recommended', 'matches', 'deviations', 'handOverrides', 'outcomes', 'noReason', 'unknownComparison', 'agreementRate', 'fallbacks'];
      say(columns.join(' | '));
      for (const g of groups(rows)) say(columns.map(k => g[k] ?? 'unknown').join(' | '));
    }
    return 0;
  } catch { say('selection-intake-report: input unreadable or invalid; no complete report'); return 2; }
}
module.exports = { row, collect, groups, main, compareRoutes };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, () => { process.exitCode = 2; });

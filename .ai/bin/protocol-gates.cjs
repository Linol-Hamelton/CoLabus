#!/usr/bin/env node
'use strict';
// protocol-gates.cjs - the rule gates by hand, and their audit counters (.ai/bin/lib/rule-gates.cjs).
//   status   [--day YYYY-MM-DD] [--runtime DIR]          counters of one UTC day (default today): per gate pass, refuse, warn,
//                                                        override, over-budget and gate time; launches of the seat ledger
//   precert  --worktree W [--base REF] [--prev SHA] [--journal PATH] [--report PATH] [--override "REASON"] [--runtime DIR]
//                                                        the precert gate cert-launch.cjs runs before a certifier seat
//             [--override-fact CODE=REASON]...           an override of one refused fact (repeatable, an exact code such as
//                                                        P-DERIVED:core-catalog or P-RECEIPT:affected); the facts it does not
//                                                        name still refuse; never together with --override
//             [--candidate-head SHA] [--seat-journal PATH] [--prompt-file PATH]
//                                                        explicit candidate/seat boundary for a manual check in a seat tree
//   identity [--repo DIR] [--override "REASON"] [--runtime DIR]
//                                                        the commit identity gate of a landing, before a commit made by hand
//   review   FILE... [--sha SHA]                         the review facts of each file (advisory, full SHA, exit codes)
// Configuration: ruleGates of protocol-manifest.json in the repository of this file. The runtime is the main checkout's
// .ai/runtime (OPS_RUNTIME_DIR overrides). Exit: 0 pass, warn or override; 1 refused or a review fact missing; 2 usage.
const fs = require('node:fs');
const path = require('node:path');
const gates = require('./lib/rule-gates.cjs');
const repoPaths = require('./repo-paths.cjs');

const KERNEL = path.resolve(__dirname, '..', '..');
const VALUED = new Set(['--day', '--runtime', '--worktree', '--base', '--prev', '--journal', '--override', '--override-fact', '--repo', '--sha', '--report', '--candidate-head', '--seat-journal', '--prompt-file']);

function parse(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (VALUED.has(a)) {
      const v = argv[i + 1];
      if (typeof v !== 'string' || !v.trim() || v.startsWith('--')) return { error: `${a} needs a value` };
      if (a === '--report') { (o.reports ||= []).push(v); i++; continue; }
      if (a === '--override-fact') {
        const m = /^([^=\s]+)=(.*)$/s.exec(v);
        if (!m) return { error: '--override-fact needs CODE=REASON' };
        (o.overrideFacts ||= []).push({ code: m[1], reason: m[2] }); i++; continue;
      }
      if (Object.hasOwn(o, a.slice(2))) return { error: `${a} given twice` };
      o[a.slice(2)] = v; i++;
    } else if (a.startsWith('--')) return { error: `unknown option ${a}` };
    else o._.push(a);
  }
  return o;
}

function main(argv, deps = {}) {
  const out = deps.out || (s => process.stdout.write(`${s}\n`));
  const err = deps.err || (s => process.stderr.write(`${s}\n`));
  const cmd = argv[0];
  const o = parse(argv.slice(1));
  if (o.error || !['status', 'precert', 'identity', 'review'].includes(cmd)) { err(o.error || 'usage: protocol-gates.cjs status|precert|identity|review [options]'); return 2; }
  const runtime = path.resolve(o.runtime || repoPaths.runtimeDir());
  if (cmd === 'status') {
    const day = o.day || new Date().toISOString().slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) { err('--day needs YYYY-MM-DD'); return 2; }
    for (const line of gates.statusLines(gates.counters(runtime, day))) out(line);
    return 0;
  }
  if (cmd === 'review') {
    if (!o._.length) { err('review needs at least one file'); return 2; }
    const { reviewFacts } = require('./lib/review-facts.cjs');
    let missing = 0;
    for (const file of o._) {
      let text;
      try { text = fs.readFileSync(file, 'utf8'); } catch (e) { err(`${file}: unreadable (${e.code || 'error'})`); return 2; }
      const failed = reviewFacts(text, { expectedSha: o.sha || null }).filter(f => !f.ok);
      if (!failed.length) out(`REVIEW ${file}: ok`);
      for (const f of failed) { missing++; out(`REVIEW ${file}: ${f.code} ${f.detail}; fix: ${f.fix}`); }
    }
    return missing ? 1 : 0;
  }
  let r;
  if (cmd === 'precert') {
    if (!o.worktree) { err('precert needs --worktree'); return 2; }
    const facts = deps.precertFacts || require('./lib/precert-facts.cjs').precertFacts;
    const cfg = gates.config(KERNEL);
    const derived = cfg.precert && Object.hasOwn(cfg.precert, 'derived') ? cfg.precert.derived : undefined;
    const authorChecks = cfg.precert && Object.hasOwn(cfg.precert, 'authorChecks') ? cfg.precert.authorChecks : undefined;
    r = gates.runGate({ gate: 'precert', root: KERNEL, runtime, subject: { worktree: path.resolve(o.worktree), by: 'protocol-gates' }, override: o.override, overrides: o.overrideFacts,
      evaluate: () => facts(o.worktree, { base: o.base, prev: o.prev, journal: o.journal, derived, authorChecks, reports: o.reports,
        candidateHead: o['candidate-head'], seatJournal: o['seat-journal'], promptFile: o['prompt-file'] }) });
  } else {
    if (o.overrideFacts) { err('--override-fact is an option of the precert gate only'); return 2; }
    const repo = path.resolve(o.repo || process.cwd());
    const { identityFacts } = require('./lib/commit-identity.cjs');
    r = gates.runGate({ gate: 'identity', root: repo, runtime, subject: { repo, by: 'protocol-gates' }, override: o.override,
      evaluate: () => identityFacts(repo, gates.config(repo)) });
  }
  for (const line of r.lines) out(line);
  return r.ok ? 0 : 1;
}

module.exports = { main, parse };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

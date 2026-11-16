#!/usr/bin/env node
'use strict';
// pairs-build.cjs - the builder of the pairs recorder (PROTO-DEC-0143 item 3, 0144 item 3, 0145, 0173 item 1g; kernel revision program step 4).
// Class B tooling, advisory: it records pairs (recommendation, assignment, outcome) and changes nothing that a launch does; nothing it writes is
// Evidence or an input of dispatch. It READS the launch records (the pending buffer and the tracked LAUNCHES*.jsonl journals), the resolver shadow
// journal, the class registry and the ladder digest, and WRITES only the pairs folder of the layer: pairs/PAIRS-<machine>-<YYYYMM>.jsonl and
// pairs/EPOCHS-<machine>.jsonl. The output folder is checked before anything is read (lib/pairs-io.cjs guardOutput); an input is never edited or deleted.
//   node .ai/bin/accounting/pairs-build.cjs [plan] [--pending DIR] [--shadow DIR] [--launches DIR] [--pairs DIR] [--machine ID] [--registry FILE] [--repo-root DIR] [--json]
//   node .ai/bin/accounting/pairs-build.cjs --execute --plan-hash HASH [the same options] [--now ISO]
// plan (the default) writes nothing and prints the numbers and the plan hash. --execute recomputes the plan from the files as they are now and refuses
// (exit 1, nothing written) unless it hashes to --plan-hash, so only a plan somebody looked at is executed. A launch that has no outcome yet is deferred
// (a journal is append-only, an outcome cannot be added later); a launch already in any PAIRS-*.jsonl of the folder is not written again.
// The output folder is guarded before anything is read (every input, registry and ladder file included, may not be, hold or lie inside it) and again, by real
// path, inside every write; the append is compare-and-publish with exclusive temporary files (lib/pairs-write.cjs).
// Exit: 0 plan or done; 1 --execute refused (plan hash differs); 2 usage, unusable input, a refused output path or an input that overlaps it, or a write error (APPEND_CONFLICT).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const core = require('./lib/pairs-core.cjs');
const io = require('./lib/pairs-io.cjs');
const { readLadder } = require('./lib/ladder-read.cjs');
const { secretIn } = require('./launch-record-validate.cjs');

const REPO = path.resolve(__dirname, '..', '..', '..');
const PLAN_SCHEMA = 'pairs-build-plan/1';
const PRIVACY_RE = /personal or machine path|secret-shaped/;
const say = (deps, s) => (deps.stdout || process.stdout).write(`${s}\n`);

function repoPaths() {
  try { return require('../repo-paths.cjs'); } catch { return null; }
}

function parseArgs(argv) {
  const o = { execute: false };
  const rest = argv[0] === 'plan' ? argv.slice(1) : argv;
  const values = ['pending', 'shadow', 'launches', 'pairs', 'machine', 'registry', 'repo-root', 'plan-hash', 'now'];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--execute') o.execute = true;
    else if (a === '--json') o.json = true;
    else if (a.startsWith('--') && values.includes(a.slice(2))) { if (i + 1 >= rest.length) return { error: `${a} needs a value` }; o[a.slice(2)] = rest[++i]; }
    else return { error: `unknown argument ${a}` };
  }
  return o;
}

/** Resolve every path the build uses. With --repo-root the whole tree is that root (a fixture); without it the tool's own checkout and the main checkout's buffers. */
function resolveOptions(o, env) {
  const repoRoot = path.resolve(o['repo-root'] || REPO);
  const rpEnv = o['repo-root'] ? {} : env;
  const rp = repoPaths();
  const layer = io.layerDir(repoRoot);
  const pending = o.pending || (rp ? rp.pendingDir(rpEnv, repoRoot) : path.join(layer, 'launches', 'pending'));
  const shadow = o.shadow || (rp ? path.join(rp.runtimeDir(rpEnv, repoRoot), 'resolver-shadow') : path.join(layer, 'no-shadow'));
  return {
    repoRoot, layer, pending: path.resolve(pending), launches: path.resolve(o.launches || path.join(layer, 'launches')), shadow: path.resolve(shadow),
    pairs: path.resolve(o.pairs || io.defaultPairsDir(repoRoot)), registry: path.resolve(o.registry || path.join(layer, 'data', 'model-classes.json')),
    machine: io.machineId(o.machine !== undefined ? o.machine : (env.OPS_MACHINE_ID || os.hostname())),
  };
}

const monthOf = pair => {
  const t = Date.parse(pair.startedAt || pair.endedAt || '');
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 7).replace('-', '');
};
const bump = (obj, k, n = 1) => { obj[k] = (obj[k] || 0) + n; };

function ladderEvidence(version, ladderSha) {
  if (!version) return { ladderVersionSource: 'none', ladderMatchesCurrentFile: null };
  const m = /#sha256:([0-9a-f]{16})/.exec(version);
  return { ladderVersionSource: 'shadow-record', ladderMatchesCurrentFile: m && ladderSha ? ladderSha.startsWith(m[1]) : null };
}

function buildPlan(opts) {
  const { groups, stats: ls } = io.loadLaunches({ pendingDir: opts.pending, launchesDir: opts.launches });
  const merged = new Map(); const conflictIds = new Set(); const rawText = new Map();
  for (const [id, g] of groups) {
    const m = core.mergeEvents(g.lines);
    merged.set(id, m.launch); rawText.set(id, g.text);
    if (m.conflict) conflictIds.add(id);
  }
  const sh = io.loadShadows(opts.shadow);
  const link = io.linkShadows(merged, sh.records);
  const registry = io.registryInfo(opts.registry);
  const existing = io.loadExisting(opts.pairs);
  let ladderSha = null;
  try { ladderSha = readLadder(opts.repoRoot).sha256; } catch { /* no ladder: the epoch evidence says so */ }

  const t = { launches: merged.size, conflicts: conflictIds.size, notFinished: 0, buildable: 0, withRecommendation: 0, withChoice: 0, withOutcome: 0, withVerdictToken: 0, clean: 0, quarantined: 0, refusedPrivacy: 0, refusedOther: 0, alreadyInJournal: 0, toAppend: 0, appendBytes: 0 };
  const unknown = { taskClass: 0, role: 0, effort: 0, route: 0, tokens: 0, cost: 0, servedModel: 0, duration: 0, noVerdict: 0 };
  const codes = {}; const refused = []; const entries = []; const epochs = new Map();
  const ordered = [...merged.values()].sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')) || a.launchId.localeCompare(b.launchId));
  for (const l of ordered) {
    if (!core.timeOf(l.endedAt)) { t.notFinished++; continue; }
    if (rawText.get(l.launchId).some(secretIn)) { t.refusedPrivacy++; refused.push({ launchId: l.launchId, reason: 'secret-shaped string in the launch line (content not shown)' }); continue; }
    const linked = link.byLaunch.get(l.launchId);
    const pair = core.buildPair({ launch: l, shadow: linked ? linked.shadow : null, linkBasis: linked ? linked.basis : null, machine: opts.machine, registry, conflict: conflictIds.has(l.launchId) });
    const problems = core.validatePair({ ...pair, recordedAt: '1970-01-01T00:00:00.000Z' });
    if (problems.length) {
      const privacy = problems.some(p => PRIVACY_RE.test(p));
      if (privacy) t.refusedPrivacy++; else t.refusedOther++;
      refused.push({ launchId: l.launchId, reason: privacy ? 'personal path or secret-shaped string in the pair (content not shown)' : problems.slice(0, 2).join('; ') });
      continue;
    }
    const month = monthOf(pair);
    if (!month) { t.refusedOther++; refused.push({ launchId: l.launchId, reason: 'no usable startedAt or endedAt for the month file' }); continue; }
    t.buildable++;
    if (pair.recommendation) t.withRecommendation++;
    if (pair.recommendation && pair.recommendation.choice) t.withChoice++;
    if (pair.outcome.exitCode !== null) t.withOutcome++;
    if (pair.outcome.verdict && pair.outcome.verdict !== 'NO_VERDICT') t.withVerdictToken++;
    if (pair.isolation.gate === 'clean') t.clean++; else t.quarantined++;
    for (const c of pair.isolation.codes) bump(codes, c);
    if (!pair.taskClass) unknown.taskClass++;
    if (!pair.role) unknown.role++;
    if (!pair.assignment.effort) unknown.effort++;
    if (!pair.assignment.route) unknown.route++;
    if (!pair.outcome.tokens || pair.outcome.tokens.total === null) unknown.tokens++;
    if (!pair.outcome.cost || pair.outcome.cost.basis === 'unknown' || (pair.outcome.cost.basis === null && pair.outcome.cost.usd === null)) unknown.cost++;
    if (!pair.assignment.servedModel) unknown.servedModel++;
    if (pair.outcome.durationSeconds === null) unknown.duration++;
    if (pair.outcome.verdict === 'NO_VERDICT') unknown.noVerdict++;
    const ep = epochs.get(pair.epoch.id) || { ...pair.epoch, firstStartedAt: null, pairs: 0 };
    ep.pairs++; if (pair.startedAt && (!ep.firstStartedAt || pair.startedAt < ep.firstStartedAt)) ep.firstStartedAt = pair.startedAt;
    epochs.set(pair.epoch.id, ep);
    if (existing.launchIds.has(l.launchId)) { t.alreadyInJournal++; continue; }
    entries.push({ journal: `PAIRS-${opts.machine}-${month}.jsonl`, launchId: l.launchId, pair });
    t.toAppend++;
  }
  const newEpochs = [...epochs.values()].filter(e => !existing.epochIds.has(e.id)).sort((a, b) => String(a.firstStartedAt).localeCompare(String(b.firstStartedAt)) || a.id.localeCompare(b.id));
  const plan = {
    schema: PLAN_SCHEMA, machine: opts.machine, totals: t, launchInput: ls, shadow: { ...link.stats, unreadable: sh.stats.unreadable, files: sh.stats.files }, unknown, codes, refused,
    epochs: [...epochs.values()].map(e => ({ id: e.id, pairs: e.pairs })).sort((a, b) => a.id.localeCompare(b.id)), newEpochs: newEpochs.map(e => e.id),
    state: { registry: registry ? { generatedAt: registry.generatedAt, sha16: registry.sha16 } : null, ladderSha256: ladderSha, shadowSources: sh.stats.sources, pairFiles: existing.files },
    entries: entries.map(e => ({ journal: e.journal, launchId: e.launchId, pairSha256: core.sha256(core.canonicalJson(e.pair)) })),
  };
  // The hash covers what the plan would write and the state it would write on (digests of every input and of the existing journals); no path and no time.
  plan.planHash = core.sha256(core.canonicalJson(plan));
  return { plan, entries, newEpochs, ladderSha, registry };
}

function execute(built, opts, now) {
  const recordedAt = now.toISOString();
  const byJournal = new Map();
  for (const e of built.entries) { if (!byJournal.has(e.journal)) byJournal.set(e.journal, []); byJournal.get(e.journal).push(JSON.stringify({ ...e.pair, recordedAt })); }
  const epochRecords = built.newEpochs.map(ep => ({
    schema: core.EPOCH_SCHEMA, epochId: ep.id, ladderVersion: ep.ladderVersion, classRegistryVersion: ep.classRegistryVersion, selectorTuple: ep.selectorTuple, selectorPromptSha256: ep.selectorPromptSha256,
    firstStartedAt: ep.firstStartedAt, machine: opts.machine, recordedAt,
    evidence: { ...ladderEvidence(ep.ladderVersion, built.ladderSha), registryVersionSource: ep.classRegistryVersion ? 'current-file' : 'none', registryGeneratedAt: ep.classRegistryVersion && built.registry ? built.registry.generatedAt : null },
  }));
  // what is written has passed the same checks as what is read: a ledger line that would not be read back is never written
  for (const rec of epochRecords) { const problems = core.validateEpoch(rec); if (problems.length) throw Object.assign(new Error(`REFUSED an epoch ledger line of ${rec.epochId} does not pass its checks (content not shown)`), { code: 'REFUSED' }); }
  for (const [name, lines] of byJournal) io.appendLines(path.join(opts.pairs, name), lines, opts.guard);
  const epochLines = epochRecords.map(r => JSON.stringify(r));
  if (epochLines.length) io.appendLines(path.join(opts.pairs, `EPOCHS-${opts.machine}.jsonl`), epochLines, opts.guard);
  return { appended: built.entries.length, journals: [...byJournal.keys()], epochs: epochLines.length };
}

function printPlan(plan, deps) {
  const t = plan.totals; const l = plan.launchInput; const s = plan.shadow; const u = plan.unknown;
  const codeText = Object.keys(plan.codes).sort((a, b) => core.CODES.indexOf(a) - core.CODES.indexOf(b)).map(c => `${c}=${plan.codes[c]}`).join(' ') || '-';
  const targets = {}; for (const e of plan.entries) bump(targets, e.journal);
  const lines = [
    `pairs-build PLAN (nothing is written) machine=${plan.machine}`,
    `launch input: files=${l.files} lines read=${l.linesRead} unparsable lines=${l.unparsable} not a launch record=${l.notLaunchRecord} unreadable files=${l.unreadableFiles} duplicate sources=${l.duplicateSources}`,
    `launches=${t.launches} conflicts=${t.conflicts}; not finished (deferred)=${t.notFinished}`,
    `shadow records=${s.records} shadow without a launch=${s.withoutLaunch} shadow duplicates=${s.duplicates} shadow unreadable=${s.unreadable} shadow ambiguous (not linked)=${s.ambiguous}`,
    `pairs buildable=${t.buildable}; with a recommendation=${t.withRecommendation} (choice known=${t.withChoice}); with an outcome (exit code known)=${t.withOutcome}; with a verdict token=${t.withVerdictToken}`,
    `gate: clean=${t.clean} quarantined=${t.quarantined} (${codeText})`,
    `unknown tokens=${u.tokens} (the launch record carries no token total, or a component of it is not a count)`,
    `unknown cost=${u.cost} (no cost, or a cost of basis unknown, in the launch record)`,
    `unknown served model=${u.servedModel} (no source outside the report named the served model)`,
    `unknown task class=${u.taskClass} (the tier of the shadow record or of the launch is absent) role=${u.role} effort=${u.effort} route=${u.route} duration=${u.duration}`,
    `no verdict recorded=${u.noVerdict} (a verdict role whose launch record carries no verdict token; the builder does not read review files)`,
    `refused (privacy)=${t.refusedPrivacy} refused (other)=${t.refusedOther}`,
    `already in a journal=${t.alreadyInJournal}`,
    `to append=${t.toAppend} pairs into ${Object.keys(targets).length} journal file(s): ${Object.keys(targets).sort().map(n => `${n} (+${targets[n]})`).join(', ') || '-'}`,
    `epochs: ${plan.epochs.length} (new to the ledger: ${plan.newEpochs.length})`,
  ];
  for (const r of plan.refused.slice(0, 20)) lines.push(`  REFUSED ${r.launchId}: ${r.reason}`);
  lines.push(`plan hash: ${plan.planHash}`, `To execute after looking at it: node .ai/bin/accounting/pairs-build.cjs --execute --plan-hash ${plan.planHash}`);
  say(deps, lines.join('\n'));
}

function main(argv, deps = {}) {
  const o = parseArgs(argv);
  const fail = msg => { say(deps, `ERROR ${msg}`); return 2; };
  if (o.error) return fail(o.error);
  if (o.execute && !o['plan-hash']) return fail('--execute needs --plan-hash <hash of the plan that was looked at>');
  if (!o.execute && o['plan-hash']) return fail('--plan-hash is only used with --execute');
  if (o.now && Number.isNaN(Date.parse(o.now))) return fail('--now must be an ISO time');
  const env = deps.env || process.env;
  const opts = resolveOptions(o, env);
  if (!opts.machine) return fail('the machine id has no safe character left (set OPS_MACHINE_ID to letters, digits, dash or underscore)');
  // Every input the build reads is named to the guard: no input may be, hold or lie inside the output folder (by real path), so the recorder can never rewrite its own input.
  opts.guard = { repoRoot: opts.repoRoot, inputs: [opts.pending, opts.launches, opts.shadow, opts.registry, io.ladderFile(opts.repoRoot)] };
  try { opts.pairs = io.guardOutput(opts.pairs, opts.guard); } catch (e) {
    if (e.code === 'REFUSED') { say(deps, `${e.message}\nNo data input was read and nothing was written.`); return 2; }
    throw e;
  }
  if (!fs.existsSync(opts.pending) || !fs.statSync(opts.pending).isDirectory()) return fail(`pending directory not found: ${opts.pending}`);
  const built = buildPlan(opts);
  if (!o.execute) {
    if (o.json) say(deps, JSON.stringify(built.plan, null, 2)); else printPlan(built.plan, deps);
    return 0;
  }
  if (String(o['plan-hash']).toLowerCase() !== built.plan.planHash) {
    say(deps, `REFUSED the plan hash ${o['plan-hash']} does not match the current plan ${built.plan.planHash} (an input or a journal changed, or another plan was looked at). Nothing was written.`);
    return 1;
  }
  try {
    const done = execute(built, opts, o.now ? new Date(o.now) : (deps.now ? deps.now() : new Date()));
    say(deps, `DONE appended=${done.appended} journals=${done.journals.join(',') || '-'} epochs-recorded=${done.epochs} plan=${built.plan.planHash}\nThe inputs were not touched. Commit the pair journal and the epoch ledger.`);
    return 0;
  } catch (e) {
    if (e.code === 'REFUSED') { say(deps, e.message); return 2; }
    return fail(e.message);
  }
}

module.exports = { main, buildPlan, execute, parseArgs, resolveOptions };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

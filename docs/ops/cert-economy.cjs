'use strict';
// Certifier economy: the budget and the scope of one certifier seat, computed by the certifier launcher (cert-launch.cjs) before the
// client starts, written into the certifier packet (a file in the runtime directory of the launched worktree) and into the run
// record. Read-only except that one packet file; every probe has a fixed failure meaning that is never a pass.
//
// Budget (item 2 of the certifier-economy decision): turns and tokens scaled by the size of the candidate diff and its risk class
// (BUDGET below, formula cert-budget/1; the numbers change only by measured run records). The packet requires a progress table from
// the first turn; at 70 percent of the budget the verdict for what is verified is written and every open item is marked; a report that
// keeps an open item which could block is PARTIAL and never certifies (.ai/bin/lib/review-facts.cjs R-PARTIAL), and only then the
// launcher starts one continuation. No client accepts a message between turns in a headless run today (MESSAGE_CLIENTS is empty), so
// the packet carries the 70 percent rule and the client's own turn limit is set to the budget plus one closing turn where the client
// has such a limit (TURN_FLAGS); a seat is never killed mid-turn.
//
// Scope (item 3): the certifier verifies the author-check receipt, runs the tests affected by the diff by its own reading, its own
// scenarios and mutants, and reruns a sample of the author-selected test files; the full protocol suite stays in the landing train.
// The automatic fallbacks are computed here before the launch and written into the packet as required runs:
//   a  the receipt is missing, not green, for another head or tree, or its environment (node version, Defender state) differs or is
//      not recorded: the certifier runs the affected selection itself;
//   b  the diff touches a shipped path and the receipt has no green product-real result: product-real through the heavy gate;
//   c  the diff touches gates, the launcher, the validator, deletion or cleanup code (or, found by the certifier, the sample rerun
//      disagrees with the receipt): the full affected selection plus product-real through the heavy gate;
//   d  two trains since the last green train went red on an assertion of a package of this risk class certified under this scope:
//      the full suite until a train lands green again (read from the train meter lines; an unreadable configured meter applies d).
// Unknown is never a pass: an unknown diff applies b and c, an unknown receipt applies a, an unreadable meter applies d.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const FORMULA = 'cert-budget/1';
const BUDGET = {
  A: { base: 80, max: 300 }, B: { base: 40, max: 150 },
  turnsPerHundredLines: 5, turnsPerFile: 2, tokensPerTurn: 60000,
  warnShare: 0.7, closingTurns: 1, continuationShare: 0.5,
};
// The client's own turn limit (a flag of its headless run); a client absent here has none and gets the packet rule only.
const TURN_FLAGS = { vibe: '--max-turns', claude: '--max-turns', dahl: '--max-steps' };
// Clients whose headless run accepts a message between turns: none today.
const MESSAGE_CLIENTS = new Set();
const SAMPLE_SIZE = 3;
// Protocol core and high-risk paths (risk class A); everything else is documentation and configuration (B). Case-insensitive: a file
// system that ignores case must not let an upper-case spelling leave the class.
const CLASS_A = /^(?:\.ai\/(?!worklog\/)|\.claude\/|hooks\/|tools\/|templates\/|protocol-manifest\.json$)|\.(?:c?js|mjs|ps1|sh|py)$/i;
// Shipped surface: the paths whose change needs a product-real result. The source is the product plan itself (shippedOf below: the
// classification of the product build over the changed paths with the product manifest of the candidate); this pattern is
// only the floor that stays when the product build is not part of the checkout (an installed host): the trigger the author check uses
// for product-real plus the launcher libraries under docs/ops/lib/. Case-insensitive: a file system that ignores case must not let an
// upper-case spelling leave the surface.
const SHIPPED = /^(?:docs\/ops\/product\/|tools\/|\.ai\/(?!worklog\/|runtime\/)|docs\/ops\/[^/]+\.cjs$|docs\/ops\/lib\/|docs\/product\/|protocol-manifest\.json$|templates\/|[^/]+\.md$)/i;
// The product manifest and the product build are named by their segments: they exist in the source checkout only, never in an installed host.
const MANIFEST_REL = ['docs', 'ops', 'product', 'PRODUCT-MANIFEST.json'].join('/');
// Fallback c: the paths whose change always needs the full affected selection plus product-real. Every rule names its class, so a reader
// sees why a path is here (all case-insensitive, like the deletion rule):
//   gate         decides whether a verdict, a handoff or a commit is accepted (gates, hooks, review and receipt readers, the operator's
//                  own gates: the local landing, the seats gate and the ops-guard register);
//   protocol-core  every other program of the protocol core (.ai/bin, .ai/hooks, hooks, the checks of tools/gates), listed last: the
//                  verdict and text readers a gate stands on are in no list above and still decide what a gate sees;
//   lock         the shared-document lock, the one writer of the shared documents;
//   session      session start and stop: the journal, the owner name and the evidence owner of every session;
//   containment  the real-path guard every report and packet read goes through, and the seat MCP policy that keeps sealed
//                certifiers from reading other reports;
//   launcher     starts seats and writes their packets and records, with the libraries it launches through (docs/ops/lib);
//   validator    the protocol validator;
//   deletion-or-cleanup  code that removes, retires, prunes or archives files.
const GUARDED = [
  ['gate', /^(?:\.ai\/bin\/(?:protocol-gates\.cjs|protocol-handoff(?:\.cjs|\/)|lib\/(?:rule-gates|precert-facts|review-facts|review-binding|commit-identity|seat-slots|verdict-read)\.cjs)|\.claude\/|\.ai\/hooks\/|tools\/operator\/(?:landing|seats)\.cjs|docs\/ops\/ops-guard\.cjs)/i],
  ['lock', /^\.ai\/bin\/protocol-lock\.cjs$/i],
  ['session', /^\.ai\/bin\/protocol-session\.cjs$/i],
  ['containment', /^\.ai\/bin\/lib\/(?:path-safe|seat-mcp)\.cjs$/i],
  ['launcher', /^(?:docs\/ops\/(?:cert-launch|fix-launch|launch-wrapper|seat-failover|launch-packet|cert-economy|served-model|kimi-route|qwen-client)\.cjs$|docs\/ops\/lib\/|\.ai\/bin\/(?:launch-record\.cjs|protocol-dispatch\/))/i],
  ['validator', /^\.ai\/bin\/(?:protocol-validate\.cjs|validator\/)/i],
  ['deletion-or-cleanup', /(?:clean|retire|prune|delet|remov|retention|purge|sweep|archiv)[^/]*\.(?:c?js|mjs|ps1|sh|py)$/i],
  ['protocol-core', /^(?:\.ai\/(?:bin|hooks)\/|hooks\/|tools\/gates\/)/i],
];
const KERNEL_HEAVY_GATE = '.ai/bin/ops-tools/heavy-gate.cjs';
const NODE_VERSION = /^v22\.21\./;
// The only Defender states that can match: unknown (a failed probe) equal to unknown on both sides still proves nothing.
const DEFENDER_STATES = new Set(['on', 'off', 'absent']);
// The product-real test file as the author-check receipt names it.
const PRODUCT_REAL = /(?:^|\/)product-real\.test\.cjs$/;

const plain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const short = (s, n = 120) => String(s === undefined || s === null ? '' : s).replace(/[\r\n\t]+/g, ' ').slice(0, n);
// The one packet boundary rule (the packet is plain text, ASCII, no angle brackets): every value from outside this module that the
// packet names (open items of a PARTIAL report, report and receipt paths, changed paths in fallback reasons, the configured heavy gate)
// passes through here. Anything but printable ASCII becomes a space, angle brackets become a space, runs of spaces fold into one, so
// a value is one bounded line and can never open a line or a tag of its own. Used by packetText and by the launcher for open items.
const PACKET_ITEM_MAX = 80;
const PACKET_OPEN_MAX = 20;
function packetSafe(value, max = PACKET_ITEM_MAX) {
  const s = String(value === undefined || value === null ? '' : value).replace(/[^\x20-\x7e]|[<>]/g, ' ').replace(/ {2,}/g, ' ').trim();
  return s.slice(0, max).trim();
}
// The open items of a PARTIAL report as the packet names them: each sanitized, empty ones dropped, at most PACKET_OPEN_MAX.
function packetOpen(open) {
  // an item whose text is all outside the packet alphabet (a Russian item) stays an open item with a plain name, never vanishes
  const items = (Array.isArray(open) ? open : []).map((v, i) => packetSafe(v) || (/[^\x00-\x7f]/.test(String(v === undefined || v === null ? '' : v)) ? `open item ${i + 1} (text not plain ASCII, read it in the report)` : '')).filter(Boolean);
  return items.length > PACKET_OPEN_MAX ? [...items.slice(0, PACKET_OPEN_MAX), `and ${items.length - PACKET_OPEN_MAX} more`] : items;
}

function riskClass(paths) {
  if (!Array.isArray(paths)) return 'A';
  return paths.some(p => CLASS_A.test(p)) ? 'A' : 'B';
}

// { known, files, lines, riskClass } -> { formula, riskClass, turns, tokens, warnTurn, warnTokens, turnLimit, diff }
function budgetFor(diff) {
  const cls = diff && diff.known && (diff.riskClass === 'A' || diff.riskClass === 'B') ? diff.riskClass : 'A';
  const c = BUDGET[cls];
  let turns;
  if (!diff || !diff.known) turns = c.max;
  else turns = Math.min(c.max, c.base + Math.ceil(diff.lines / 100) * BUDGET.turnsPerHundredLines + diff.files * BUDGET.turnsPerFile);
  return {
    formula: FORMULA, riskClass: cls, turns, tokens: turns * BUDGET.tokensPerTurn,
    warnTurn: Math.ceil(turns * BUDGET.warnShare), warnTokens: Math.ceil(turns * BUDGET.tokensPerTurn * BUDGET.warnShare),
    turnLimit: turns + BUDGET.closingTurns,
    diff: diff && diff.known ? { files: diff.files, lines: diff.lines } : { files: null, lines: null, reason: short(diff && diff.reason, 80) || 'unknown' },
  };
}
// The budget of the one continuation: half the turns of the first seat, never below the class base.
function continuationBudget(budget) {
  const turns = Math.max(BUDGET[budget.riskClass].base, Math.ceil(budget.turns * BUDGET.continuationShare));
  return { ...budget, turns, tokens: turns * BUDGET.tokensPerTurn, warnTurn: Math.ceil(turns * BUDGET.warnShare), warnTokens: Math.ceil(turns * BUDGET.tokensPerTurn * BUDGET.warnShare), turnLimit: turns + BUDGET.closingTurns, continuation: true };
}
// How the budget reaches the client: its own turn limit where it has one, and the packet rule always.
function turnControl(client, budget) {
  const flag = Object.hasOwn(TURN_FLAGS, client) ? TURN_FLAGS[client] : null;
  return { flag, limit: flag ? budget.turnLimit : null, message: MESSAGE_CLIENTS.has(client) ? 'between-turns' : 'packet-rule', reason: flag ? null : 'the client has no turn-limit flag in a headless run' };
}
// The controller decision between two turns (never during one): below 70 percent continue; at 70 percent send the one message; at
// 100 percent allow one closing turn; after the closing turn end the seat. { turn, tokens, sent, closing } are the counts so far.
function budgetStep(budget, { turn = 0, tokens = 0, sent = false, closing = false } = {}) {
  if (closing) return 'end';
  if (turn >= budget.turns || tokens >= budget.tokens) return 'closing-turn';
  if (!sent && (turn >= budget.warnTurn || tokens >= budget.warnTokens)) return 'message';
  return 'continue';
}

// ---- probes (each takes an injected git so the tests never touch a live repository) ----
function gitOf(worktree, run = spawnSync) {
  return args => run('git', ['-C', worktree, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
}
// The base of the candidate: the stated ref, else the merge base with the integration branch of the worktree's manifest.
function baseOf(worktree, stated, git, io = fs) {
  if (stated) {
    const r = git(['rev-parse', '--verify', `${stated}^{commit}`]);
    return r.status === 0 ? { ok: true, sha: r.stdout.trim() } : { ok: false, reason: 'stated-base-not-a-commit' };
  }
  let branch = null;
  try { const m = JSON.parse(io.readFileSync(path.join(worktree, 'protocol-manifest.json'), 'utf8')); branch = plain(m) && typeof m.integrationBranch === 'string' ? m.integrationBranch : null; } catch { branch = null; }
  for (const ref of branch ? [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`] : []) {
    const r = git(['merge-base', 'HEAD', ref]);
    if (r.status === 0 && /^[0-9a-f]{40}$/.test(r.stdout.trim())) return { ok: true, sha: r.stdout.trim() };
  }
  return { ok: false, reason: 'no-base' };
}
// The changed paths and line counts of base..HEAD (renames off: a rename is a deletion and an addition).
function diffOf(git, base) {
  const r = git(['diff', '--numstat', '--no-renames', '-z', base, 'HEAD']);
  if (r.status !== 0) return { known: false, reason: 'git-diff-failed', paths: null };
  const rows = (r.stdout || '').split('\0').filter(Boolean);
  const paths = []; let lines = 0;
  for (const row of rows) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(row);
    if (!m) return { known: false, reason: 'git-diff-unreadable', paths: null };
    paths.push(m[3]);
    lines += (m[1] === '-' ? 0 : Number(m[1])) + (m[2] === '-' ? 0 : Number(m[2]));
  }
  return { known: true, files: paths.length, lines, paths, riskClass: riskClass(paths) };
}

// The certifier economy part of the launching repository's configuration (ruleGates.certEconomy of protocol-manifest.json):
// heavyGate (absolute path of the operator heavy gate), heavyNode (absolute path of the node it runs with), trainMeter (absolute path
// of the train meter JSONL). A host without it gets the packet without a heavy gate command and without fallback d.
function configOf(kernelRoot, io = fs) {
  let m = null;
  try { m = JSON.parse(io.readFileSync(path.join(kernelRoot, 'protocol-manifest.json'), 'utf8')); } catch { m = null; }
  const rg = plain(m) && plain(m.ruleGates) ? m.ruleGates : {};
  const ce = plain(rg.certEconomy) ? rg.certEconomy : {};
  const abs = v => (typeof v === 'string' && path.isAbsolute(v) && !/[\r\n\0]/.test(v) ? v : undefined);
  return { authorChecks: plain(rg.precert) && Object.hasOwn(rg.precert, 'authorChecks') ? rg.precert.authorChecks : undefined,
    heavyGate: abs(ce.heavyGate), heavyNode: abs(ce.heavyNode), trainMeter: Object.hasOwn(ce, 'trainMeter') ? ce.trainMeter : undefined };
}
// The heavy gate every heavy run of a certifier goes through: the kernel version when it has landed, else the configured operator gate.
function heavyGateOf(kernelRoot, cfg, io = fs) {
  const kernel = path.join(kernelRoot, KERNEL_HEAVY_GATE);
  const node = cfg.heavyNode || 'node';
  if (io.existsSync(kernel)) return { source: 'kernel', command: `${node} ${KERNEL_HEAVY_GATE.replace(/\//g, '/')} --tree .` };
  if (cfg.heavyGate) return { source: 'operator', command: `${node} ${cfg.heavyGate} --tree .` };
  return { source: 'none', command: null };
}

// The bound author-check receipt (the reader the precert gate uses) and its facts against this head and environment.
function receiptOf(worktree, head, cfg, git, deps = {}) {
  const reader = deps.authorReceipt || require('../../.ai/bin/lib/precert-facts.cjs').authorReceipt;
  try { return reader(cfg.authorChecks, head, git); } catch (e) { return { problem: `the receipt reader failed (${short(e && e.message, 80)})`, receipt: null, file: null }; }
}
// The environment the receipt was made in against the one the certifier runs in. The receipt records it as env { node, defender }.
function environmentProblem(receipt, current) {
  const env = plain(receipt && receipt.env) ? receipt.env : null;
  if (!env) return 'the receipt records no environment (node version, Defender state)';
  if (typeof env.node !== 'string' || !NODE_VERSION.test(env.node)) return `the receipt node ${short(env.node, 20) || 'unknown'} is not the heavy-run node v22.21`;
  if (typeof env.defender !== 'string' || !env.defender) return 'the receipt records no Defender state';
  if (!DEFENDER_STATES.has(env.defender)) return `the receipt Defender state ${short(env.defender, 20)} is not one of on, off, absent`;
  if (!current || typeof current.defender !== 'string' || !current.defender) return 'the current Defender state cannot be read';
  if (!DEFENDER_STATES.has(current.defender)) return `the current Defender state ${short(current.defender, 20)} is not one of on, off, absent`;
  if (env.defender !== current.defender) return `the Defender state differs (receipt ${short(env.defender, 20)}, now ${short(current.defender, 20)})`;
  return null;
}
// The shipped paths among the changed ones, from the product plan: the classification of the product build over the changed paths with
// the product manifest (an object, or undefined for the manifest of this checkout). Returns a predicate path -> boolean, or null when
// the plan cannot be made (unknown: the caller treats every changed path as shipped). A checkout without the product build (an
// installed host) has no plan to read; the SHIPPED floor decides there.
let productBuildModule;
const loadModule = file => { try { return require(file); } catch { return null; } };
function shippedOf(paths, manifest, io = fs) {
  const pb = productBuildModule === undefined ? (productBuildModule = loadModule(path.join(__dirname, '..', '..', 'tools', 'product', 'product-build.cjs'))) : productBuildModule;
  if (!pb) return p => SHIPPED.test(p);
  try {
    const json = manifest === undefined ? JSON.parse(io.readFileSync(path.join(__dirname, '..', '..', MANIFEST_REL), 'utf8')) : manifest;
    if (!plain(json) || pb.checkManifest(json).length) return null;
    const cls = pb.classify(paths.map(p => ({ path: p, type: 'blob', mode: '100644', size: 0 })), json);
    const named = new Set(paths);
    const set = new Set([...cls.included.map(e => e.path), ...[...cls.generated, ...cls.regenerated].filter(p => named.has(p))]);
    return p => set.has(p) || SHIPPED.test(p);
  } catch { return null; }
}
// Whether the receipt holds a green product-real run.
function productRealGreen(receipt) {
  if (!plain(receipt) || !plain(receipt.groups) || !Array.isArray(receipt.groups.heavy) || !plain(receipt.results) || !plain(receipt.results.heavy)) return false;
  const heavy = receipt.results.heavy;
  return receipt.groups.heavy.some(f => PRODUCT_REAL.test(String(f))) && heavy.exit === 0
    && !(Array.isArray(heavy.failedFiles) && heavy.failedFiles.some(f => PRODUCT_REAL.test(String(f))));
}
// The author-selected test files to rerun: SAMPLE_SIZE of them in an order the author cannot choose: sha256 of the certifier's seed and
// the file name. The launcher draws the seed at random for every seat (newSeed), so it exists only after the candidate and its receipt
// are sealed; a value the author controls (the head, a commit message, the tree) never decides the sample.
const newSeed = () => crypto.randomBytes(16).toString('hex');
function sampleOf(receipt, seed) {
  const salt = typeof seed === 'string' && seed ? seed : newSeed();
  if (!plain(receipt) || !plain(receipt.groups)) return [];
  const files = [...new Set([...(receipt.groups.affected || []), ...(receipt.groups.common || [])].filter(f => typeof f === 'string' && /^[A-Za-z0-9._/-]+$/.test(f)))];
  const key = f => crypto.createHash('sha256').update(`${salt}\0${f}`).digest('hex');
  return files.sort((x, y) => (key(x) < key(y) ? -1 : key(x) > key(y) ? 1 : 0)).slice(0, SAMPLE_SIZE);
}

// The train meter: one JSON object per line, written by the train step after every landing train:
//   {"schema":"train-meter/1","train":"NAME","at":"ISO","result":"green"|"red",
//    "assertionFailures":[{"file":"FILE","package":"PACKAGE","riskClass":"A"|"B","certScope":"economy"|"full"}],
//    "certScopeSwitch":{"A":"full"|"economy","B":"full"|"economy"}}
// -> { ok, trains } or { ok: false, reason }. Not configured (undefined) is { ok: true, trains: [], configured: false }.
function readMeter(file, io = fs) {
  if (file === undefined) return { ok: true, trains: [], configured: false };
  if (typeof file !== 'string' || !path.isAbsolute(file)) return { ok: false, reason: 'the train meter path is not an absolute file path' };
  let text;
  try { text = io.readFileSync(file, 'utf8'); } catch (e) { return { ok: false, reason: `the train meter cannot be read (${String((e && e.code) || 'error').replace(/[^A-Za-z0-9_]/g, '')})` }; }
  const trains = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].trim()) continue;
    let t;
    try { t = JSON.parse(lines[i]); } catch { return { ok: false, reason: `train meter line ${i + 1} is not JSON` }; }
    if (!plain(t) || t.schema !== 'train-meter/1' || !['green', 'red'].includes(t.result) || (t.assertionFailures !== undefined && !Array.isArray(t.assertionFailures))) return { ok: false, reason: `train meter line ${i + 1} is not a train-meter/1 line` };
    // a record the reader cannot classify is unknown, never "no failure": every assertion failure names its class and scope
    if (typeof t.train !== 'string' || !t.train) return { ok: false, reason: `train meter line ${i + 1} names no train` };
    if ((t.assertionFailures || []).some(f => !plain(f) || !['A', 'B'].includes(f.riskClass) || !['economy', 'full'].includes(f.certScope))) return { ok: false, reason: `train meter line ${i + 1} holds an assertion failure without a known risk class and scope` };
    if (t.certScopeSwitch !== undefined && (!plain(t.certScopeSwitch) || Object.entries(t.certScopeSwitch).some(([k, v]) => !['A', 'B'].includes(k) || !['full', 'economy'].includes(v)))) return { ok: false, reason: `train meter line ${i + 1} holds an unknown certScopeSwitch` };
    trains.push(t);
  }
  return { ok: true, trains, configured: true };
}
// Fallback d: two trains since the last green one red on an assertion of a package of this class certified under this scope.
function meterSwitch(meter, cls) {
  if (!meter.ok) return { full: true, reason: meter.reason };
  let last = -1;
  meter.trains.forEach((t, i) => { if (t.result === 'green') last = i; });
  const hits = meter.trains.slice(last + 1).filter(t => t.result === 'red' && (t.assertionFailures || []).some(f => plain(f) && f.riskClass === cls && f.certScope === 'economy'));
  return hits.length >= 2 ? { full: true, reason: `trains ${hits.slice(-2).map(t => short(t.train, 20)).join(' and ')} went red on an assertion of a class ${cls} package since the last green train` } : { full: false, reason: null };
}

// The scope of the seat: the fallbacks that hold and the runs the packet requires.
function scopeFor({ receipt, receiptProblem, head, tree, diff, environment, meter, budget, seed, manifest }) {
  const fallbacks = [];
  const add = (code, reason) => fallbacks.push({ code, reason: short(reason, 200) });
  const r = receiptProblem ? null : receipt;
  const sampleSeed = typeof seed === 'string' && seed ? seed : newSeed();
  const sample = sampleOf(r, sampleSeed);
  if (!r) add('a', receiptProblem || 'no author-check receipt');
  else if (r.head !== head && !receipt.journalOnlyAhead) add('a', 'the receipt is for another head');
  // an unknown tree is a weak receipt, never a pass (a journal-only ancestor is bound by the precert reader, not by the tree)
  else if (!tree && !receipt.journalOnlyAhead) add('a', 'the tree of the candidate cannot be read');
  else if (tree && r.tree !== tree && !receipt.journalOnlyAhead) add('a', 'the receipt is for another tree');
  // a receipt that names no author-selected test file gives nothing to rerun: a weak receipt
  else if (!sample.length) add('a', 'the receipt names no author-selected test files to sample');
  else { const env = environmentProblem(r, environment); if (env) add('a', env); }
  const paths = diff && diff.known ? diff.paths : null;
  if (!paths) { add('b', 'the changed paths are unknown'); add('c', 'the changed paths are unknown'); }
  else {
    const isShipped = shippedOf(paths, manifest);
    // a product plan that cannot be made leaves no path outside the surface: every changed path counts as shipped
    const shipped = paths.length ? paths.find(p => (isShipped ? isShipped(p) : true)) : undefined;
    if (shipped && !productRealGreen(r)) add('b', isShipped ? `shipped path ${short(shipped, 100)} changed and the receipt has no green product-real result` : `the product plan cannot be read, so ${short(shipped, 100)} counts as shipped, and the receipt has no green product-real result`);
    const guarded = GUARDED.map(([kind, re]) => [kind, paths.find(p => re.test(p))]).filter(([, p]) => p);
    if (guarded.length) add('c', guarded.map(([kind, p]) => `${kind}: ${short(p, 80)}`).join('; '));
  }
  const d = meterSwitch(meter, budget.riskClass);
  if (d.full) add('d', d.reason);
  const codes = new Set(fallbacks.map(f => f.code));
  const runs = ['receipt-verify', 'own-affected', 'own-scenarios-and-mutants', 'sample-rerun'];
  if (codes.has('a') || codes.has('c')) runs.push('affected-selection');
  if (codes.has('b') || codes.has('c')) runs.push('product-real');
  if (codes.has('d')) runs.push('full-suite');
  return { mode: codes.has('d') ? 'full' : 'economy', fallbacks, runs, sample, sampleSeed };
}

// The packet section of the seat: plain text, ASCII, no angle brackets. Every value from outside this module goes through packetSafe.
function packetText(plan) {
  const b = plan.budget; const s = plan.scope; const t = plan.turns;
  const lines = [];
  lines.push(`# Certifier budget and scope (${b.formula}${b.continuation ? ', continuation' : ''})`, '');
  if (plan.continuation) {
    const open = packetOpen(plan.continuation.open);
    lines.push(`CONTINUATION of a PARTIAL report. Read your draft ${packetSafe(plan.continuation.report, 200)} first; finish ONLY its open items (${open.join('; ') || 'listed in its progress table'}); keep every finished item and its evidence; update the progress table, the status and the verdict line of the SAME file.`, '');
  }
  lines.push('## Budget', '');
  lines.push(`Risk class ${b.riskClass}; diff ${b.diff.files === null ? `unknown (${packetSafe(b.diff.reason)})` : `${b.diff.files} files, ${b.diff.lines} changed lines`}. Budget: ${b.turns} turns and ${b.tokens} tokens.`);
  lines.push(`From your FIRST turn the report holds a progress table with exactly these first three columns: | Audit item | State | Blocking | (State is done or open; Blocking is yes or no). Keep it current after every item.`);
  lines.push(`At turn ${b.warnTurn} or ${b.warnTokens} tokens (70 percent), whichever comes first: write the verdict for what is verified now and mark every item still open, with Blocking yes when it could change the verdict. Then continue.`);
  lines.push(`At turn ${b.turns} or ${b.tokens} tokens (100 percent): use ONE closing turn to finish the report (status, table, verdict line) and stop.${t.flag ? ` The client limit is ${t.limit} turns (${t.flag}).` : ''}`);
  lines.push('A report with an open item that could block is PARTIAL: write Status: PARTIAL; it never certifies, and one continuation will start from your open items. Never leave a mutant in the tree: undo every change to tracked files before you stop.', '');
  lines.push('## Scope', '');
  lines.push(`Do NOT run the full protocol suite unless fallback d below requires it: the landing train runs it for every package.${s.mode === 'full' ? ' Fallback d HOLDS: run the full suite.' : ''}`);
  lines.push(`1. Verify the author-check receipt${plan.receiptFile ? ` ${packetSafe(plan.receiptFile, 200)}` : ''}: its head and tree are the candidate (or a journal-only ancestor), its node version and Defender state, every part green. Write what you verified into the Checks table.`);
  lines.push(`2. Run the tests affected by the diff by YOUR reading of it (node .ai/bin/protocol-test.cjs --root . --affected ${packetSafe(plan.base, 40) || 'BASE'} or node --test on the files you choose).`);
  lines.push('3. Your own adversarial scenarios and mutants (mutants only in copies under a fresh temp directory, never on a live path).');
  lines.push(`4. Rerun this sample of the author-selected test files (drawn by the launcher at random, seed ${packetSafe(s.sampleSeed, 40) || 'none'}) and compare with the receipt: ${s.sample.length ? s.sample.map(f => packetSafe(f, 200)).join(', ') : 'none available (the receipt is weak: fallback a holds, run the affected selection yourself)'}. If any result disagrees with the receipt, fallback c holds: run the full affected selection and product-real.`);
  lines.push('', '## Required runs from the automatic fallbacks', '');
  if (!s.fallbacks.length) lines.push('None: the receipt is bound and green, no shipped or guarded path lacks its run, no train switch.');
  for (const f of s.fallbacks) lines.push(`- ${packetSafe(f.code, 1)}: ${packetSafe(f.reason, 200)}`);
  lines.push(`Required runs: ${s.runs.join(', ')}.`, '');
  lines.push('## Heavy runs', '');
  lines.push(plan.heavyGate.command
    ? `Every heavy run (affected or full protocol-test, node --test tests/product-*, product-build) goes through the heavy gate first: ${packetSafe(plan.heavyGate.command, 400)} --defender warn ; start the run only after HEAVY-GATE OK, one at a time, in the foreground, never in the background.`
    : 'No heavy gate is configured: run heavy runs one at a time, in the foreground, never in the background.');
  return `${lines.join('\n')}\n`;
}

// The whole plan of one certifier seat. Never throws: a failed probe becomes its fail-closed fallback.
function planFor({ worktree, head, client, kernelRoot, base, continuation }, deps = {}) {
  const io = deps.fs || fs;
  const git = deps.git || gitOf(worktree, deps.spawnSync);
  const cfg = deps.config || configOf(kernelRoot, io);
  const b = baseOf(worktree, base, git, io);
  const diff = b.ok ? diffOf(git, b.sha) : { known: false, reason: b.reason, paths: null };
  let budget = budgetFor(diff);
  if (continuation) budget = continuationBudget(budget);
  const treeR = git(['rev-parse', '--verify', 'HEAD^{tree}']);
  const tree = treeR.status === 0 ? treeR.stdout.trim() : null;
  const rc = receiptOf(worktree, head, cfg, git, deps);
  let receipt = rc.receipt;
  if (receipt && receipt.head !== head) receipt = { ...receipt, journalOnlyAhead: true };
  let environment = null;
  try { environment = (deps.environment || currentEnvironment)(); } catch { environment = null; }
  const meter = (deps.readMeter || readMeter)(cfg.trainMeter, io);
  // the manifest of the candidate decides what is shipped: null (git cannot show it) is unknown and fails closed in scopeFor
  const shown = git(['show', `HEAD:${MANIFEST_REL}`]);
  let manifest = null;
  try { manifest = shown.status === 0 ? JSON.parse(shown.stdout) : null; } catch { manifest = null; }
  const seed = typeof deps.seed === 'string' && deps.seed ? deps.seed : newSeed();
  const scope = scopeFor({ receipt, receiptProblem: rc.problem, head, tree, diff, environment, meter, budget, seed, manifest: deps.manifest !== undefined ? deps.manifest : manifest });
  return { budget, scope, turns: turnControl(client, budget), heavyGate: heavyGateOf(kernelRoot, cfg, io), base: b.ok ? b.sha : null,
    receiptFile: rc.file ? String(rc.file).replace(/\\/g, '/') : null, continuation: continuation || null };
}
// The Defender behavior-monitoring state of this machine (on, off, unknown); unknown never matches a receipt.
function currentEnvironment(run = spawnSync) {
  if (process.platform !== 'win32') return { defender: 'absent' };
  const r = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '(Get-MpComputerStatus).BehaviorMonitorEnabled'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
  const v = r.status === 0 ? String(r.stdout || '').trim() : '';
  return { defender: /^true$/i.test(v) ? 'on' : /^false$/i.test(v) ? 'off' : 'unknown' };
}

// The fields of the run record (numbers, codes and short reasons only).
const nat = v => Number.isSafeInteger(v) && v >= 0;
// Tokens used by the seat: the total the client reported when it did (it already holds the other kinds; summing every field of the
// usage object counted it twice), else input and output plus the cache kinds that were reported; unknown (null) when neither is
// known, never 0.
function tokensUsedOf(usage) {
  const t = usage && plain(usage.tokens) ? usage.tokens : null;
  if (!t) return null;
  if (nat(t.total)) return t.total;
  if (!nat(t.input) || !nat(t.output)) return null;
  const sum = t.input + t.output + (nat(t.cacheRead) ? t.cacheRead : 0) + (nat(t.cacheWrite) ? t.cacheWrite : 0);
  return Number.isSafeInteger(sum) ? sum : null;
}
// A reason in the record never carries a user folder: the user segment becomes the marker the record validator skips. The segment may
// hold a space (a folder name like "Yan PC" is one segment): it ends at the next separator, so the whole name is gone (F-11).
const redactUser = s => String(s).replace(/((?:\b[A-Za-z]:)?(?:\\\\|\\|\/)(?:Users|home)(?:\\\\|\\|\/))(?!<)[^\\/"'<>]+/gi, '$1<user>');
function recordFields(plan, usage) {
  const total = tokensUsedOf(usage);
  return {
    certBudget: { formula: plan.budget.formula, riskClass: plan.budget.riskClass, turns: plan.budget.turns, tokens: plan.budget.tokens, turnLimit: plan.turns.limit, turnFlag: plan.turns.flag, message: plan.turns.message,
      files: plan.budget.diff.files, lines: plan.budget.diff.lines, continuation: plan.budget.continuation === true, tokensUsed: total, overBudget: total === null ? null : total > plan.budget.tokens },
    certScope: { mode: plan.scope.mode, fallbacks: plan.scope.fallbacks.map(f => ({ code: f.code, reason: redactUser(short(f.reason, 120)) })), runs: plan.scope.runs, sample: plan.scope.sample, ...(plan.scope.sampleSeed ? { sampleSeed: plan.scope.sampleSeed } : {}), heavyGate: plan.heavyGate.source },
  };
}

// After the seat: tracked files changed outside the report and journal directories (a certifier's mutant left in the tree).
function mutantsLeft(git) {
  const r = git(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=no']);
  if (r.status !== 0) return { ok: false, files: null };
  const files = (r.stdout || '').split('\0').filter(Boolean).map(l => l.slice(3)).filter(p => p && !p.startsWith('docs/reviews/') && !p.startsWith('.ai/worklog/'));
  return { ok: true, files };
}
// The head a continuation may start on: the candidate itself, or a descendant whose commits since it touch only reports and journals.
// The candidate is named by its full 40-hex sha only: a prefix could name a later commit (chosen-prefix), so a short expect is refused.
function continuationHead(git, expect) {
  if (typeof expect !== 'string' || !/^[0-9a-f]{40}$/.test(expect)) return { ok: false, reason: 'expect-not-a-full-sha' };
  const h = git(['rev-parse', '--verify', 'HEAD']);
  const head = h.status === 0 ? h.stdout.trim() : '';
  if (!/^[0-9a-f]{40}$/.test(head)) return { ok: false, reason: 'no-head' };
  if (head === expect) return { ok: true, head: expect };
  if (git(['merge-base', '--is-ancestor', expect, head]).status !== 0) return { ok: false, reason: 'head-not-a-descendant' };
  const d = git(['diff', '--name-only', '--no-renames', expect, head]);
  if (d.status !== 0) return { ok: false, reason: 'diff-failed' };
  const other = (d.stdout || '').split('\n').map(s => s.trim()).filter(Boolean).filter(p => !p.startsWith('docs/reviews/') && !p.startsWith('.ai/worklog/'));
  return other.length ? { ok: false, reason: 'head-changed-candidate-files' } : { ok: true, head };
}

module.exports = { FORMULA, BUDGET, TURN_FLAGS, MESSAGE_CLIENTS, SAMPLE_SIZE, SHIPPED, shippedOf, tokensUsedOf, redactUser, newSeed, DEFENDER_STATES, GUARDED, KERNEL_HEAVY_GATE, PACKET_ITEM_MAX, PACKET_OPEN_MAX, riskClass, budgetFor, continuationBudget, turnControl, budgetStep,
  gitOf, baseOf, diffOf, configOf, heavyGateOf, receiptOf, environmentProblem, productRealGreen, sampleOf, readMeter, meterSwitch, scopeFor, packetSafe, packetOpen, packetText, planFor,
  currentEnvironment, recordFields, mutantsLeft, continuationHead };

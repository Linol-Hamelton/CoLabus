#!/usr/bin/env node
'use strict';
// protocol-decompose.cjs - check a decomposition record (decomposition/1), render the task file and the task frame of
// one child, and move the record through its states on checked evidence, by the rules TD-nn of the task decomposition
// specification. Advise mode: the tool proposes nothing and launches nothing; the operator approves each record and
// each launch, and the tool records what was approved and what came back.
//
//   node .ai/bin/protocol-decompose.cjs validate RECORD [--base REF] [--root DIR]
//   node .ai/bin/protocol-decompose.cjs render RECORD CHILD [--base REF] [--root DIR]
//   node .ai/bin/protocol-decompose.cjs ready|start RECORD CHILD [--base REF] [--root DIR]
//   node .ai/bin/protocol-decompose.cjs result RECORD CHILD RESULT-FILE [--base REF] [--root DIR]
//   node .ai/bin/protocol-decompose.cjs rerun RECORD CHILD [--base REF] [--root DIR]
//   node .ai/bin/protocol-decompose.cjs accept|reject RECORD CHILD ACCEPT-FILE [--run] [--base REF] [--root DIR]
//   node .ai/bin/protocol-decompose.cjs integrate RECORD [--base REF] [--root DIR]
//   node .ai/bin/protocol-decompose.cjs assemble RECORD ASSEMBLY-FILE [--base REF] [--root DIR]
//   node .ai/bin/protocol-decompose.cjs status RECORD [--base REF] [--root DIR]
//   node .ai/bin/protocol-decompose.cjs children plan RECORD [--base REF] [--root DIR]
//   node .ai/bin/protocol-decompose.cjs children start RECORD [CHILD ...] --route CHILD=CLIENT:MODEL[:EFFORT] ...
//        --worktree-root DIR --owner OWNER [--dry-run] [--base REF] [--root DIR]
//   node .ai/bin/protocol-decompose.cjs children status RECORD [--once] [--poll SEC] [--runtime DIR] [--base REF] [--root DIR]
//
// children: the launch of the children through the seams of the kernel (TD-84..TD-89). plan prints one row per child
// (its seat, its class on both axes, the route rule, the three advised routes with their reasons and what is unknown) and
// starts nothing. start launches the readied children the operator names (or every readied one), at most 4 running at
// once, each through the kernel launch entry (.ai/bin/ops-tools/author-launch.cjs) on the route the operator names, and
// records each launch in the ledger; a child that cannot start is refused by name and stays as it is. status shows the
// children and the end of each seat, records a seat that ended without its marker as lost, and returns when no seat of
// the record runs. children never readies a child, never accepts a result and never chooses a route.
//
// A command that moves the record checks the record, its ledger and the evidence first, then writes the record once
// through the guarded atomic writer; the contract hash stays and the counters only grow. Facts about a child commit
// or the assembled head come from the git objects of the repository; a refusal writes nothing.
//
// The acceptance runner: rerun, and accept or reject with --run, run every command of the contract themselves, on a
// clean tree of the child commit and (the negative commands) of its start, each checked out outside the repository and
// removed afterwards, under a closed allow list of environment variables (no NODE_OPTIONS, NODE_PATH or GIT_ variable).
// rerun prints what the run saw; with --run the acceptance document must record exactly that, and the ledger entry
// names the digest of the environment of the run.
//
// The facts about the tree come from the git objects of one base commit only (REF, default HEAD): the file list
// with its modes, protocol-manifest.json, docs/ops/selection-policy.json, the host list of protected names and the other
// records under docs/ops/decompositions/. No clock and no environment value enters the answer.
// validate writes nothing. render writes the two files of the child as a pair (both or neither), and only in the folder
// named after the parent id under docs/ops/decompositions/, through the guarded atomic writer; a refused record writes nothing.
// Exit: 0 accepted (or rendered); 1 refused, every refusal on stderr as DECOMPOSE-REFUSED CODE WHERE: DETAIL;
// 2 usage error, unreadable or damaged base facts, or an internal error named by its class (never a stack or a path).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const decompose = require('./lib/decompose.cjs');
const flow = require('./lib/decompose-flow.cjs');
const launch = require('./lib/decompose-launch.cjs');
const textSafe = require('./lib/text-safe.cjs');
const pathSafe = require('./lib/path-safe.cjs');
const protectedPaths = require('./lib/protected-paths.cjs');
const { BASE_PROTECTED_PREFIXES } = require('./protocol-verdict.cjs');
const { STANDING_DEFAULT_FORBIDDEN } = require('./protocol-scope.cjs');

const MAX_RECORD = 1024 * 1024;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/~^-]{0,199}$/;
const MODES = { 100644: 'blob', 100755: 'exec', 120000: 'link', 160000: 'gitlink' };

class UsageError extends Error {}
const usage = detail => { throw new UsageError(detail); };

function git(root, args) {
  // Hooks are switched off and no inherited GIT_ variable redirects the repository: the answer is a function of the objects.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  const r = spawnSync('git', ['-c', 'core.hooksPath=disabled', '-C', root, ...args], { env, maxBuffer: 256 * 1024 * 1024, windowsHide: true });
  return { ok: r.status === 0, out: r.stdout || Buffer.alloc(0) };
}
function show(root, base, file) {
  const r = git(root, ['cat-file', 'blob', `${base}:${file}`]);
  return r.ok ? r.out.toString('utf8') : null;
}
const parse = text => textSafe.parseJsonUnique(text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text);

// The kernel set (protocol prefixes plus the managed and source files of the manifest) and the protected set (the
// standing default forbidden list), both as they stand at the base commit.
function pathSets(root, base) {
  const kernel = { prefixes: [...BASE_PROTECTED_PREFIXES], paths: [] };
  const text = show(root, base, 'protocol-manifest.json');
  if (text !== null) {
    let manifest;
    try { manifest = parse(text); } catch { usage('protocol-manifest.json at the base commit is not valid JSON'); }
    const lists = [manifest.managed, manifest.role === 'installed' ? [] : manifest.source].filter(Array.isArray);
    for (const entry of lists.flat()) if (typeof entry === 'string' && entry.trim()) {
      const e = entry.trim().replace(/\\/g, '/').replace(/^(\.\/)+/, '');
      (e.endsWith('/') ? kernel.prefixes : kernel.paths).push(e);
    }
  }
  const protectedSet = { prefixes: STANDING_DEFAULT_FORBIDDEN.filter(p => p.endsWith('/')), paths: STANDING_DEFAULT_FORBIDDEN.filter(p => !p.endsWith('/')) };
  return { kernel, protected: protectedSet };
}

function facts(root, ref, recordRel) {
  if (!REF.test(ref)) usage('--base is a commit name of letters, digits and . _ / ~ ^ -');
  const rev = git(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
  if (!rev.ok) usage(`--base ${ref} is not a commit of the repository`);
  const base = rev.out.toString('utf8').trim();
  const tree = git(root, ['ls-tree', '-r', '-z', '--full-tree', base]);
  if (!tree.ok) usage('the tree of the base commit cannot be read');
  const files = {};
  for (const row of tree.out.toString('utf8').split('\0')) {
    if (!row) continue;
    const m = /^(\d{6}) \w+ [0-9a-f]+\t(.+)$/s.exec(row);
    if (!m || !MODES[m[1]]) usage('the tree of the base commit holds an entry of an unknown mode');
    files[m[2]] = MODES[m[1]];
  }
  const policyText = show(root, base, 'docs/ops/selection-policy.json');
  let policy;
  try { policy = parse(policyText).taskPolicy; } catch { usage('docs/ops/selection-policy.json at the base commit is missing or not valid JSON'); }
  if (!policy || !policy.hardFloors) usage('docs/ops/selection-policy.json at the base commit has no taskPolicy.hardFloors');
  const namesText = show(root, base, protectedPaths.CONFIG_REL);
  let protectedNames = [];
  if (namesText !== null) {
    try { protectedNames = protectedPaths.namesFromConfigText(namesText); } catch { usage(`${protectedPaths.CONFIG_REL} at the base commit is damaged`); }
  }
  const records = [];
  for (const file of Object.keys(files).sort()) {
    if (!file.startsWith(decompose.DECOMPOSITIONS_DIR) || !/^[^/]+\.json$/.test(file.slice(decompose.DECOMPOSITIONS_DIR.length))) continue;
    try {
      const rec = parse(show(root, base, file));
      records.push({ path: file, parentId: rec.parent.id, childIds: rec.children.map(c => c.id) });
    } catch { records.push({ path: file, unreadable: true }); }
  }
  let previous = null;
  if (recordRel && Object.hasOwn(files, recordRel)) {
    try { previous = parse(show(root, base, recordRel)); } catch { previous = { unreadable: true }; }
  }
  const sets = pathSets(root, base);
  const out = {
    base, files, kernel: sets.kernel, protected: sets.protected,
    policy: { sumTiers: policy.sumTiers, floors: { kernel: policy.hardFloors.kernel, protected: policy.hardFloors.protected } },
    protectedNames, records, previous, recordPath: recordRel,
  };
  // Damaged facts of the base commit (a policy without its tier table, say) are a usage error, never a crash.
  const problem = decompose.factsProblem(out);
  if (problem) usage(`the facts of the base commit are damaged: ${problem}`);
  return out;
}

function readRecord(root, file, what = 'the record') {
  const g = pathSafe.realInside(root, file, { refuseHardlinks: true });
  if (!g.ok) usage(`${what} path is refused (${g.reason})`);
  if (!g.exists || g.type !== 'file') usage(`${what} is not a file`);
  const bytes = fs.readFileSync(g.real);
  if (bytes.length > MAX_RECORD) return { rel: g.rel, text: null, problem: `larger than ${MAX_RECORD} bytes` };
  const d = textSafe.decode(bytes, { bom: 'refuse', crlf: 'refuse', invisible: 'refuse' });
  if (!d.ok) return { rel: g.rel, text: null, problem: `not clean UTF-8 text (${d.problems[0].code})` };
  return { rel: g.rel.split(path.sep).join('/'), text: d.text };
}

// ---------- facts about a child commit and the assembled head ----------

const SHA1 = /^[0-9a-f]{40}$/;
function commitOf(root, sha) {
  if (typeof sha !== 'string' || !SHA1.test(sha)) return null;
  const r = git(root, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`]);
  return r.ok ? r.out.toString('utf8').trim() : null;
}
function treeOf(root, commit) {
  const r = git(root, ['rev-parse', '--verify', '--quiet', `${commit}^{tree}`]);
  return r.ok ? r.out.toString('utf8').trim() : null;
}
// true, false, or null when git cannot tell (null is never an ancestor).
function isAncestor(root, a, b) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  const r = spawnSync('git', ['-c', 'core.hooksPath=disabled', '-C', root, 'merge-base', '--is-ancestor', a, b], { env, windowsHide: true });
  return r.status === 0 ? true : r.status === 1 ? false : null;
}
// The changed paths from a to b; a rename or a copy names its old path in from.
function diffOf(root, a, b) {
  const r = git(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-relative', '--name-status', '-z', '-M', a, b, '--']);
  if (!r.ok) usage('git cannot compare two commits of the evidence');
  const parts = r.out.toString('utf8').split('\0');
  const out = [];
  for (let i = 0; i < parts.length && parts[i];) {
    const status = parts[i++];
    if (/^[RC]/.test(status)) { out.push({ status: status[0], from: parts[i], path: parts[i + 1] }); i += 2; } else out.push({ status, path: parts[i++] });
  }
  return out;
}
// The kind and blob of each named path at a commit; an absent path has no entry.
function entriesOf(root, commit, paths) {
  const entries = {};
  if (!paths.length) return entries;
  const r = git(root, ['--literal-pathspecs', 'ls-tree', '-r', '-z', '--full-tree', commit, '--', ...paths]);
  if (!r.ok) usage('git cannot list the tree of a commit of the evidence');
  for (const row of r.out.toString('utf8').split('\0')) {
    const m = /^(\d{6}) \w+ ([0-9a-f]+)\t(.+)$/s.exec(row);
    if (m) entries[m[3]] = { kind: MODES[m[1]] || 'other', blob: m[2] };
  }
  return entries;
}

function resultTree(root, record, result) {
  const base = record.parent.base;
  const commit = commitOf(root, result.commit);
  const start = commitOf(root, result.start);
  const tree = { commit, tree: commit ? treeOf(root, commit) : null, start, startFromBase: false, commitFromStart: false, dependencyAncestors: {}, startChanges: [], changes: [], entries: {} };
  if (start) {
    tree.startFromBase = isAncestor(root, base, start) === true;
    tree.startChanges = flow.changedPaths(diffOf(root, base, start));
    for (const d of result.dependencies) { const c = commitOf(root, d.commit); tree.dependencyAncestors[d.commit] = c !== null && isAncestor(root, c, start) === true; }
  }
  if (start && commit) {
    tree.commitFromStart = isAncestor(root, start, commit) === true;
    tree.changes = diffOf(root, start, commit);
    tree.entries = entriesOf(root, commit, flow.changedPaths(tree.changes));
  }
  return tree;
}

function assemblyTree(root, record, assembly, results) {
  const head = commitOf(root, assembly.head);
  const tree = { head, tree: head ? treeOf(root, head) : null, headFromBase: false, merged: {}, changes: [], entries: {} };
  if (!head) return tree;
  tree.headFromBase = isAncestor(root, record.parent.base, head) === true;
  for (const m of assembly.merges) { const c = commitOf(root, m.commit); tree.merged[m.commit] = c !== null && isAncestor(root, c, head) === true; }
  tree.changes = diffOf(root, record.parent.base, head);
  const accepted = Object.values(results).flatMap(e => e.changed);
  tree.entries = entriesOf(root, head, [...new Set([...flow.changedPaths(tree.changes), ...accepted])]);
  return tree;
}

// ---------- commands ----------

// The positional arguments of each command after its name.
const COMMANDS = Object.freeze({
  validate: ['RECORD'], render: ['RECORD', 'CHILD'], ready: ['RECORD', 'CHILD'], start: ['RECORD', 'CHILD'],
  result: ['RECORD', 'CHILD', 'RESULT-FILE'], rerun: ['RECORD', 'CHILD'], accept: ['RECORD', 'CHILD', 'ACCEPT-FILE'], reject: ['RECORD', 'CHILD', 'ACCEPT-FILE'],
  integrate: ['RECORD'], assemble: ['RECORD', 'ASSEMBLY-FILE'], status: ['RECORD'],
});
const USAGE = Object.entries(COMMANDS).map(([c, a]) => `${c} ${a.join(' ')}${c === 'accept' || c === 'reject' ? ' [--run]' : ''}`).join(' | ');

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (!Object.hasOwn(COMMANDS, command || '')) usage(`the command is one of ${Object.keys(COMMANDS).join(', ')}`);
  const opts = { command, base: 'HEAD', root: '.', run: false, positional: [] };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--base' || a === '--root') {
      if (i + 1 >= rest.length) usage(`${a} needs a value`);
      opts[a.slice(2)] = rest[++i];
    } else if (a === '--run') {
      if (command !== 'accept' && command !== 'reject') usage('--run goes with accept or reject');
      opts.run = true;
    } else if (a.startsWith('-')) usage(`unknown option ${a}`);
    else opts.positional.push(a);
  }
  if (opts.positional.length !== COMMANDS[command].length) usage(`${command} ${COMMANDS[command].join(' ')}`);
  return opts;
}

// ---------- the acceptance runner ----------

// The environment of every command the tool runs: a closed allow list, so no NODE_OPTIONS, NODE_PATH, GIT_ or other
// variable makes node or git load code beside the file of the command. The digest names the environment of the run.
const RUN_ENV = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'LANG', 'TZ']);
const RUN_TIMEOUT = 10 * 60 * 1000;
function runEnvironment(env) {
  const kept = Object.entries(env).filter(([k, v]) => RUN_ENV.has(k.toUpperCase()) && typeof v === 'string').sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const out = Object.fromEntries(kept);
  return { env: out, digest: decompose.sha256(`run-environment/1\n${decompose.canonical(out)}`) };
}

// A clean tree of one commit, checked out outside the repository and removed when the action ends.
function withCleanTree(root, commit, action) {
  const holder = fs.mkdtempSync(path.join(os.tmpdir(), 'decompose-run-'));
  const dir = path.join(holder, 'tree');
  try {
    if (!git(root, ['worktree', 'add', '--detach', '--quiet', dir, commit]).ok) usage('git cannot check out a clean tree of a commit of the evidence');
    const head = git(dir, ['rev-parse', 'HEAD']);
    const status = git(dir, ['status', '--porcelain', '--untracked-files=all']);
    return action(dir, head.ok && head.out.toString('utf8').trim() === commit && status.ok && status.out.length === 0);
  } finally {
    git(root, ['worktree', 'remove', '--force', dir]);
    fs.rmSync(holder, { recursive: true, force: true });
    git(root, ['worktree', 'prune']);
  }
}

// One command of the contract under the environment of the run: node runs the words after node, nothing else.
function runCommand(dir, command, env) {
  const r = spawnSync(process.execPath, command.split(' ').slice(1), { cwd: dir, env, stdio: 'ignore', windowsHide: true, timeout: RUN_TIMEOUT });
  if (Number.isInteger(r.status)) return r.status;
  return { value: null, reason: r.error && r.error.code === 'ETIMEDOUT' ? 'the command did not finish in time' : 'the command ended without an exit code' };
}

// The rerun of a submitted child by the tool: every command of the contract on a clean tree of the child commit, and
// every negative command on a clean tree of the start, where it must fail (TD-67, TD-81).
function runAcceptance(root, record, childId, resultEntry) {
  const child = record.children.find(c => c.id === childId);
  const { env, digest } = runEnvironment(process.env);
  const commands = [];
  let clean = true;
  withCleanTree(root, resultEntry.commit, (dir, ok) => {
    clean = clean && ok;
    for (const kind of ['positive', 'negative']) for (const x of child.acceptance[kind]) commands.push({ kind, command: x.command, at: 'commit', exit: runCommand(dir, x.command, env) });
  });
  withCleanTree(root, resultEntry.start, (dir, ok) => {
    clean = clean && ok;
    for (const x of child.acceptance.negative) commands.push({ kind: 'negative', command: x.command, at: 'start', exit: runCommand(dir, x.command, env) });
  });
  return { commit: resultEntry.commit, tree: resultEntry.tree, clean, commands, environment: digest };
}

// The evidence document of a command: guarded read, clean UTF-8 text, unique keys, its own form.
function readEvidence(root, file, kind) {
  const ev = readRecord(root, file, `the ${kind} document`);
  if (ev.text === null) return { refusals: [{ code: 'SCHEMA', where: kind, detail: ev.problem }] };
  const parsed = flow.parseText(ev.text);
  if (!parsed.ok) return parsed;
  const formed = flow.checkForm(parsed.doc, kind);
  return formed.ok ? { ok: true, doc: parsed.doc } : formed;
}

// The pulse of one record; a count that cannot be shown is unknown, never 0 (TD-79).
function pulse(record) {
  if (!record) return 'DECOMP parents=unknown children=unknown accepted=unknown assembled=unknown reason=refused\n';
  const accepted = record.children.filter(c => c.state === 'accepted' || c.state === 'integrated').length;
  const assembled = ['assembled', 'certified', 'landed', 'activated'].includes(record.parent.state) ? 1 : 0;
  return `DECOMP parents=1 children=${record.children.length} accepted=${accepted} assembled=${assembled}\n`;
}

// Check the evidence of a moving command, move the record, check the next record whole, write it once.
function move(root, rec, f, record, opts, io) {
  const command = opts.command;
  const names = COMMANDS[command];
  const childId = names[1] === 'CHILD' ? opts.positional[1] : undefined;
  const file = names.length > 1 && names[names.length - 1].endsWith('-FILE') ? opts.positional[names.length - 1] : undefined;
  if (childId !== undefined && !record.children.some(c => c.id === childId)) usage(`the record has no child ${childId}`);
  let event = { type: command, child: childId };
  let hash = null;
  if (file !== undefined) {
    const kind = command === 'result' ? 'result' : command === 'assemble' ? 'assembly' : 'acceptance';
    const ev = readEvidence(root, file, kind);
    if (!ev.ok) return refuse(ev.refusals, io.err);
    let checked;
    if (command === 'result') checked = flow.checkResult(record, childId, ev.doc, resultTree(root, record, ev.doc));
    else if (command === 'assemble') {
      const { results, acceptances } = flow.acceptedOf(record);
      checked = flow.checkAssembly(record, results, acceptances, ev.doc, assemblyTree(root, record, ev.doc, results));
      event = { type: 'assemble' };
    } else {
      const last = flow.latestResult(record, childId);
      // With --run the tool reruns the commands itself; the document must record exactly what the tool saw (TD-81).
      const run = opts.run && last && flow.checkForm(ev.doc, 'acceptance').ok ? runAcceptance(root, record, childId, last) : null;
      checked = flow.checkAcceptance(record, childId, last, ev.doc, { reject: command === 'reject', run });
    }
    if (!checked.ok) return refuse(checked.refusals, io.err);
    event.entry = checked.entry;
    hash = checked.hash;
  }
  if (command === 'integrate') event = { type: 'integrate' };
  const moved = flow.nextState(record, event);
  if (!moved.ok) return refuse(moved.refusals, io.err);
  // The next record passes the whole check before it is written: no event leaves a record the validator refuses.
  const text = `${JSON.stringify(moved.record, null, 2)}\n`;
  const again = decompose.validateText(text, f);
  if (!again.ok) return refuse(again.refusals, io.err);
  const ledger = flow.checkLedger(moved.record, f.previous);
  if (!ledger.ok) return refuse(ledger.refusals, io.err);
  // One writer: a record that changed while this command ran is never overwritten (a second writer's move would be lost).
  if (readRecord(root, rec.rel).text !== rec.text) { io.err(`DECOMPOSE-WRITE-FAILED ${rec.rel}: the record changed while the command ran; run it again\n`); return 1; }
  const w = pathSafe.writeAtomicGuarded(path.join(root, ...rec.rel.split('/')), Buffer.from(text, 'utf8'), { root });
  if (!w.ok) { io.err(`DECOMPOSE-WRITE-FAILED ${rec.rel}: ${w.reason}\n`); return 1; }
  const subject = childId === undefined ? null : moved.record.children.find(c => c.id === childId);
  const where = subject
    ? `child=${subject.id} state=${subject.state} attempts=${subject.counters.attempts} rounds=${subject.counters.rounds}`
    : `parent=${moved.record.parent.id} state=${moved.record.parent.state}`;
  io.out(`DECOMPOSE-MOVED ${rec.rel} ${command} ${where}${hash ? ` hash=${hash}` : ''}\n`);
  return 0;
}

function refuse(refusals, err) {
  for (const r of refusals) err(`DECOMPOSE-REFUSED ${r.code} ${r.where}: ${r.detail}\n`);
  return 1;
}

const errName = e => (e && typeof e.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(e.code) ? e.code : 'failed');

// The files of one render are written as a pair: both or neither (TD-43). Each file is first staged next to its target
// through the guarded atomic writer, then the staged files are renamed onto their targets; when a later rename fails,
// every target already renamed gets its earlier bytes back (or is removed when it did not exist) and the staged files go.
function writePair(root, files) {
  const staged = [];
  const drop = () => { for (const s of staged) if (!s.done) { try { fs.unlinkSync(s.temp); } catch { /* already gone */ } } };
  for (const [rel, text] of files) {
    let dir = root;
    for (const seg of path.posix.dirname(rel).split('/')) {
      dir = path.join(dir, seg);
      const made = pathSafe.mkdirGuarded(root, dir);
      if (!made.ok) { drop(); return `${path.posix.dirname(rel)}: ${made.reason}`; }
    }
    const g = pathSafe.realInside(root, rel, { refuseHardlinks: true });
    if (!g.ok) { drop(); return `${rel}: ${g.reason}`; }
    const before = g.exists && g.type === 'file' ? fs.readFileSync(g.real) : null;
    const tempRel = `${rel}.render-${process.pid}.tmp`;
    const w = pathSafe.writeAtomicGuarded(path.join(root, ...tempRel.split('/')), Buffer.from(text, 'utf8'), { root });
    if (!w.ok) { drop(); return `${rel}: ${w.reason}`; }
    staged.push({ rel, target: path.join(root, ...rel.split('/')), temp: path.join(root, ...tempRel.split('/')), before, done: false });
  }
  for (const s of staged) {
    try { fs.renameSync(s.temp, s.target); s.done = true; } catch (e) {
      let undone = true;
      for (const back of staged.filter(x => x.done)) {
        if (back.before === null) { try { fs.unlinkSync(back.target); } catch { undone = false; } } else if (!pathSafe.writeAtomicGuarded(back.target, back.before, { root }).ok) undone = false;
      }
      drop();
      return `${s.rel}: ${errName(e)}; ${undone ? 'no file of the pair was changed' : `${staged[0].rel} could not be given back its earlier bytes`}`;
    }
  }
  return null;
}

// ---------- the children of a record: plan, start, status ----------

const CHILDREN_USAGE = 'children plan RECORD | children start RECORD [CHILD ...] --route CHILD=CLIENT:MODEL[:EFFORT] --worktree-root DIR --owner OWNER [--dry-run] | children status RECORD [--once] [--poll SEC] [--runtime DIR]';
const CHILD_OPTIONS = Object.freeze({
  plan: [],
  start: ['--route', '--worktree-root', '--owner', '--dry-run'],
  status: ['--once', '--poll', '--runtime'],
});

function parseChildren(argv) {
  const [action, ...rest] = argv;
  if (!Object.hasOwn(CHILD_OPTIONS, action || '')) usage(`children takes one of ${Object.keys(CHILD_OPTIONS).join(', ')}`);
  const opts = { command: `children ${action}`, action, base: 'HEAD', root: '.', positional: [], routes: {}, worktreeRoot: null, owner: null, dryRun: false, once: false, pollMs: 60000, runtime: null };
  const value = (a, i) => { if (i + 1 >= rest.length) usage(`${a} needs a value`); return rest[i + 1]; };
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('-') && a !== '--base' && a !== '--root' && !CHILD_OPTIONS[action].includes(a)) usage(`children ${action} takes no option ${a}`);
    if (a === '--base' || a === '--root') opts[a.slice(2)] = value(a, i++);
    else if (a === '--route') {
      const m = /^([a-z0-9][a-z0-9-]{2,47})=(.+)$/.exec(value(a, i++));
      if (!m) usage('--route takes CHILD=CLIENT:MODEL[:EFFORT]');
      if (Object.hasOwn(opts.routes, m[1])) usage(`--route names ${m[1]} twice`);
      opts.routes[m[1]] = m[2];
    } else if (a === '--worktree-root') opts.worktreeRoot = path.resolve(value(a, i++));
    else if (a === '--owner') opts.owner = value(a, i++);
    else if (a === '--runtime') opts.runtime = path.resolve(value(a, i++));
    else if (a === '--poll') {
      const n = Number(value(a, i++));
      if (!Number.isInteger(n) || n < 1 || n > 3600) usage('--poll takes whole seconds from 1 to 3600');
      opts.pollMs = n * 1000;
    } else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--once') opts.once = true;
    else opts.positional.push(a);
  }
  if (!opts.positional.length || (action !== 'start' && opts.positional.length !== 1)) usage(`children ${action} RECORD${action === 'start' ? ' [CHILD ...]' : ''}`);
  if (action === 'start') {
    if (!opts.worktreeRoot) usage('children start needs --worktree-root DIR');
    if (!opts.owner) usage('children start needs --owner OWNER');
    const ids = opts.positional.slice(1);
    if (new Set(ids).size !== ids.length) usage('children start names a child twice');
    opts.children = ids.length ? ids : null;
  }
  return opts;
}

// The seams of the line the children command uses. The classifier, the rubric, the advice and the ladder belong to the
// tree of this tool; the record and its worktrees to the repository the command works on. A seam that is not installed
// gives an unknown value with its reason, never a default class or route. Each module is loaded by a literal relative
// path, so the runtime closure of the product proves that a shipped command carries every module it loads.
const TOOL_ROOT = path.resolve(__dirname, '..', '..');
function lineSeams(root) {
  const tool = rel => path.join(TOOL_ROOT, ...rel.split('/'));
  let policy = null;
  const loadPolicy = () => policy || (policy = require('../../tools/assign/selection-policy.cjs').loadPolicy().obj);
  const readJson = (file, max) => {
    try { const bytes = fs.readFileSync(file); return bytes.length > max ? false : JSON.parse(bytes.toString('utf8')); } catch (e) { return e && e.code === 'ENOENT' ? null : false; }
  };
  const ladder = readJson(tool('docs/ops/model-ladder.json'), 8 * 1024 * 1024);
  return {
    reason: e => (e && typeof e.code === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(e.code) ? e.code : e && typeof e.message === 'string' && /^[a-z0-9-]{1,60}$/.test(e.message) ? e.message : 'failed'),
    rubricTier: (scores, flags) => require('../../tools/assign/complexity.cjs').rubricTier(scores, flags, loadPolicy()),
    classify: input => require('../../tools/assign/task-classifier.cjs').classifyTask({ ...input, manifestCtx: { manifest: new Set(loadPolicy().manifestOwned.map(p => p.toLowerCase())) } }),
    advise: (text, base) => {
      // The advice of the selection layer for the facts of the child; with the assignment mode off there is none. The
      // frame sees the child as a fresh worktree at the base sees it: no change yet, the scope from its launch task.
      const mode = require('../../tools/assign/host-mode.cjs').read(undefined, Date.now(), { worktree: root });
      if (mode.mode === 'off') return { value: null, reason: 'the assignment mode of the host is off' };
      const fresh = { head: base, base, paths: [], special: false, changes: [], lines: 0 };
      const out = require('../../tools/assign/launch-intake.cjs').capture({ role: 'author', worktree: root, text, say: () => {} }, { repository: fresh });
      const a = out && out.selectionShadow && out.selectionShadow.advice;
      return a ? { ranked: a.ranked, status: a.status, reason: a.reason, unknown: a.unknown } : { value: null, reason: 'the selection layer gave no advice' };
    },
    ladder: ladder || null,
    join: (dir, name) => path.join(dir, name),
    isWorktree: dir => fs.existsSync(path.join(dir, '.git')),
    launch: options => require('./ops-tools/author-launch.cjs').launch(options),
    runtimeDir: () => require('./ops-tools/lib/config.cjs').load({ root, env: process.env }).runtimeDir,
    terminalOf: (runtimeDir, seat) => {
      try {
        const bytes = fs.readFileSync(path.join(runtimeDir, `${seat}.terminal.json`));
        return bytes.length > 4 * 1024 * 1024 ? false : JSON.parse(bytes.toString('utf8'));
      } catch (e) { return e && e.code === 'ENOENT' ? undefined : false; }
    },
    sleep: ms => new Promise(resolve => { setTimeout(resolve, ms); }),
  };
}

// Write the next record once: it passes the whole check and its ledger first, and a record that changed since the
// command read it is never overwritten (one writer).
function commitRecord(root, rel, expected, next, f) {
  const text = `${JSON.stringify(next, null, 2)}\n`;
  const again = decompose.validateText(text, f);
  if (!again.ok) return { ok: false, refusals: again.refusals };
  const ledger = flow.checkLedger(next, f.previous);
  if (!ledger.ok) return { ok: false, refusals: ledger.refusals };
  if (readRecord(root, rel).text !== expected) return { ok: false, reason: 'the record changed while the command ran' };
  const w = pathSafe.writeAtomicGuarded(path.join(root, ...rel.split('/')), Buffer.from(text, 'utf8'), { root });
  return w.ok ? { ok: true, text } : { ok: false, reason: w.reason };
}

// The seat of the running attempt of a child: the last start entry of the current contract.
function runningStart(record, childId) {
  const starts = (record.ledger || []).filter(e => e.type === 'start' && e.child === childId && e.contract === record.parent.contractHash);
  return starts.length ? starts[starts.length - 1] : null;
}

function childrenPlan(rec, f, record, io, seams) {
  const running = record.children.filter(c => c.state === 'running').length;
  io.out(`DECOMP-PLAN-PARENT ${record.parent.id} revision=${record.revision} children=${record.children.length} running=${running} limit=${decompose.MAX_RUNNING} record=${rec.rel}\n`);
  for (const c of record.children) io.out(`DECOMP-PLAN ${JSON.stringify(launch.planChild(record, c.id, f, seams))}\n`);
  return 0;
}

async function childrenStart(root, rec, f, record, opts, io, seams) {
  for (const id of opts.children || []) if (!record.children.some(c => c.id === id)) usage(`the record has no child ${id}`);
  for (const id of Object.keys(opts.routes)) if (!record.children.some(c => c.id === id)) usage(`--route names ${id}, which is not a child of the record`);
  const plan = launch.startPlan(record, opts, f, seams);
  let code = plan.refusals.length ? 1 : 0;
  for (const r of plan.refusals) io.err(`DECOMP-LAUNCH-REFUSED ${r.child} ${r.code}: ${r.detail}\n`);
  let current = record; let text = rec.text;
  for (const s of plan.starts) {
    const refused = (codeName, detail) => { io.err(`DECOMP-LAUNCH-REFUSED ${s.child} ${codeName}: ${detail}\n`); code = 1; };
    // The start is checked before the seat exists: a start the ledger refuses (a spent budget, a stop) launches nothing.
    const moved = flow.nextState(current, { type: 'start', child: s.child, launch: { seat: s.seat, route: s.route } });
    if (!moved.ok) { for (const x of moved.refusals) refused(x.code, `${x.where}: ${x.detail}`); continue; }
    const task = launch.launchTask(current, s.child, f);
    if (!task.ok) { for (const x of task.refusals) refused(x.code, `${x.where}: ${x.detail}`); continue; }
    let holder = null; let taskFile;
    if (opts.dryRun) {
      holder = fs.mkdtempSync(path.join(os.tmpdir(), 'decompose-launch-'));
      taskFile = path.join(holder, `${s.child}.launch.md`);
      fs.writeFileSync(taskFile, task.text, 'utf8');
    } else {
      const problem = writePair(root, [[task.path, task.text]]);
      if (problem) { refused('LAUNCH_REFUSED', `the launch task cannot be written (${problem})`); continue; }
      taskFile = path.join(root, ...task.path.split('/'));
    }
    let out;
    try {
      out = await seams.launch({ root, name: s.seat, worktree: s.worktree, taskFile, stream: s.seat, client: s.routeParts.client,
        model: s.routeParts.model, effort: s.routeParts.effort || undefined, owner: opts.owner, selectionBase: current.parent.base, dryRun: opts.dryRun });
    } catch (e) { out = { ok: false, lines: [`the launch entry stopped on an internal error (${errName(e)})`] }; } finally { if (holder) fs.rmSync(holder, { recursive: true, force: true }); }
    const lines = Array.isArray(out && out.lines) ? out.lines : [];
    for (const line of lines) io.out(`DECOMP-LAUNCH ${s.child} ${line}\n`);
    if (!out || !out.ok) {
      const why = lines.filter(l => /REFUSED|SEAT CAP|_BLOCKED/.test(l)).pop() || lines[lines.length - 1] || 'the launch entry started nothing';
      refused('LAUNCH_REFUSED', `${why}${opts.dryRun ? '' : `; launch task retained at ${task.path}`}`);
      continue;
    }
    if (opts.dryRun) { io.out(`DECOMP-LAUNCH-DRY-RUN ${s.child} seat=${s.seat} route=${s.route} worktree=${s.worktree}\n`); continue; }
    const w = commitRecord(root, rec.rel, text, moved.record, f);
    if (!w.ok) {
      io.err(`DECOMPOSE-WRITE-FAILED ${rec.rel}: the seat ${s.seat} runs and its start is not recorded (${w.reason || w.refusals.map(x => x.code).join(' ')}); record it with: start ${rec.rel} ${s.child}\n`);
      return 1;
    }
    current = moved.record; text = w.text;
    const started = current.children.find(c => c.id === s.child);
    io.out(`DECOMP-STARTED ${s.child} seat=${s.seat} route=${s.route} attempt=${started.counters.attempts} parent=${current.parent.id}\n`);
  }
  return code;
}

async function childrenStatus(root, rec, f, record, opts, io, seams) {
  const runtimeDir = opts.runtime || seams.runtimeDir();
  let current = record; let text = rec.text;
  for (;;) {
    let live = 0;
    for (const c of current.children) {
      let line = `DECOMP-CHILD ${c.id} state=${c.state} attempts=${c.counters.attempts} rounds=${c.counters.rounds}`;
      const start = c.state === 'running' ? runningStart(current, c.id) : null;
      if (c.state === 'running' && (!start || !start.seat)) line += ' seat=none (started without the launch entry; its end is not observed)';
      else if (start) {
        const end = launch.seatEnd(start.seat, seams.terminalOf(runtimeDir, start.seat));
        line += ` seat=${start.seat} seat-state=${end.state}`;
        if (end.state === 'running') live++;
        if (end.state === 'marker') line += ' next=the operator submits its result';
        if (end.state === 'unknown') line += ` (${end.detail})`;
        if (end.state === 'lost') {
          const moved = flow.nextState(current, { type: 'lost', child: c.id, seat: start.seat, cause: 'SEAT_NO_MARKER' });
          const w = moved.ok ? commitRecord(root, rec.rel, text, moved.record, f) : { ok: false, refusals: moved.refusals };
          if (!w.ok) { io.err(`DECOMPOSE-WRITE-FAILED ${rec.rel}: the lost seat ${start.seat} is not recorded (${w.reason || w.refusals.map(x => x.code).join(' ')})\n`); return 1; }
          current = moved.record; text = w.text;
          line = `DECOMP-CHILD ${c.id} state=rejected seat=${start.seat} seat-state=lost cause=SEAT_NO_MARKER (${end.detail})`;
        }
      }
      io.out(`${line}\n`);
    }
    io.out(pulse(current));
    if (!live || opts.once) return 0;
    await seams.sleep(opts.pollMs);
    // Other commands move the record while seats run (a result, an acceptance): read it again and check it whole.
    const again = readRecord(root, rec.rel);
    const checked = again.text === null ? { ok: false, refusals: [{ code: 'SCHEMA', where: 'record', detail: again.problem }] } : decompose.validateText(again.text, f);
    if (!checked.ok) return refuse(checked.refusals, io.err);
    current = JSON.parse(again.text); text = again.text;
    const ledger = flow.checkLedger(current, f.previous);
    if (!ledger.ok) return refuse(ledger.refusals, io.err);
  }
}

async function childrenMain(argv, io, seams) {
  try {
    const opts = parseChildren(argv);
    const root = path.resolve(opts.root);
    const rec = readRecord(root, opts.positional[0]);
    const f = facts(root, opts.base, rec.rel);
    if (rec.text === null) return refuse([{ code: 'SCHEMA', where: 'record', detail: rec.problem }], io.err);
    // Depth 1 and at most 8 children are checks of the record: a record that fails them starts nothing (TD-14, TD-15).
    const result = decompose.validateText(rec.text, f);
    if (!result.ok) return refuse(result.refusals, io.err);
    const record = JSON.parse(rec.text);
    const ledger = flow.checkLedger(record, f.previous);
    if (!ledger.ok) return refuse(ledger.refusals, io.err);
    const s = seams || lineSeams(root);
    if (opts.action === 'plan') return childrenPlan(rec, f, record, io, s);
    if (opts.action === 'start') return await childrenStart(root, rec, f, record, opts, io, s);
    return await childrenStatus(root, rec, f, record, opts, io, s);
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`DECOMPOSE-USAGE ${e.message}\n`);
      io.err(`usage: protocol-decompose.cjs ${CHILDREN_USAGE} [--base REF] [--root DIR]\n`);
      return 2;
    }
    io.err(`DECOMPOSE-USAGE the command stopped on an internal error (${internalName(e)})\n`);
    return 2;
  }
}

// An internal failure is named by its class and code only: never a stack, a message or a path of this machine.
function internalName(e) {
  const name = e && typeof e.name === 'string' && /^[A-Za-z]{1,40}$/.test(e.name) ? e.name : 'Error';
  const code = e && typeof e.code === 'string' && /^[A-Z0-9_]{1,40}$/.test(e.code) ? ` ${e.code}` : '';
  return `${name}${code}`;
}

function main(argv, io = { out: s => process.stdout.write(s), err: s => process.stderr.write(s) }, seams = null) {
  if (argv[0] === 'children') return childrenMain(argv.slice(1), io, seams);
  let opts;
  try {
    opts = parseArgs(argv);
    const root = path.resolve(opts.root);
    const rec = readRecord(root, opts.positional[0]);
    const f = facts(root, opts.base, rec.rel);
    const refused = refusals => { const code = refuse(refusals, io.err); if (opts.command === 'status') io.out(pulse(null)); return code; };
    if (rec.text === null) return refused([{ code: 'SCHEMA', where: 'record', detail: rec.problem }]);
    const result = decompose.validateText(rec.text, f);
    if (!result.ok) return refused(result.refusals);
    const record = JSON.parse(rec.text);
    // The states of the record are the states its ledger gives; a hand-moved state is refused by every command (TD-71).
    const ledger = flow.checkLedger(record, f.previous);
    if (!ledger.ok) return refused(ledger.refusals);
    if (opts.command === 'status') {
      for (const c of record.children) io.out(`DECOMP-CHILD ${c.id} state=${c.state} attempts=${c.counters.attempts} rounds=${c.counters.rounds}\n`);
      io.out(`DECOMP-PARENT ${record.parent.id} state=${record.parent.state} revision=${record.revision} contractHash=${result.contractHash}\n`);
      io.out(pulse(record));
      return 0;
    }
    if (opts.command === 'rerun') {
      const childId = opts.positional[1];
      const child = record.children.find(c => c.id === childId);
      if (!child) usage(`the record has no child ${childId}`);
      const last = flow.latestResult(record, childId);
      if (child.state !== 'submitted' || !last) return refuse([{ code: 'STATE', where: 'child', detail: `${childId} is ${child.state}; the commands of a submitted child are rerun` }], io.err);
      const run = runAcceptance(root, record, childId, last);
      io.out(`DECOMPOSE-RERUN ${JSON.stringify({ commit: run.commit, tree: run.tree, clean: run.clean, commands: run.commands })}\n`);
      io.out(`DECOMPOSE-RUN-ENVIRONMENT ${run.environment}\n`);
      return 0;
    }
    if (opts.command !== 'validate' && opts.command !== 'render') return move(root, rec, f, record, opts, io);
    if (opts.command === 'validate') {
      io.out(`DECOMPOSE-OK ${rec.rel} parent=${record.parent.id} revision=${record.revision} children=${record.children.length} contractHash=${result.contractHash}\n`);
      for (const u of result.unknowns) io.out(`DECOMPOSE-UNKNOWN ${u}\n`);
      return 0;
    }
    const childId = opts.positional[1];
    if (!record.children.some(c => c.id === childId)) usage(`the record has no child ${childId}`);
    const out = decompose.render(record, childId, f);
    if (!out.ok) return refuse(out.refusals, io.err);
    const problem = writePair(root, [[out.taskPath, out.task], [out.framePath, out.frame]]);
    if (problem) { io.err(`DECOMPOSE-WRITE-FAILED ${problem}\n`); return 1; }
    io.out(`DECOMPOSE-RENDERED ${out.taskPath} ${out.framePath}\n`);
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`DECOMPOSE-USAGE ${e.message}\n`);
      io.err(`usage: protocol-decompose.cjs ${USAGE} | ${CHILDREN_USAGE} [--base REF] [--root DIR]\n`);
      return 2;
    }
    // Any other failure is named by its class only: never a stack, a message or a path of this machine in the output.
    io.err(`DECOMPOSE-USAGE the command stopped on an internal error (${internalName(e)})\n`);
    return 2;
  }
}

module.exports = { main, facts, parseArgs, parseChildren, runEnvironment, lineSeams };
if (require.main === module) {
  // children start and status wait for the launch entry and the seats; every other command returns at once.
  const code = main(process.argv.slice(2));
  if (code && typeof code.then === 'function') code.then(c => { process.exitCode = c; });
  else process.exitCode = code;
}

#!/usr/bin/env node
'use strict';
// protocol-context.cjs - the context resolver of the packet compiler. It derives the architecture context of one task (the paths
// the task changes, the kernel records that own them, their processes, rule homes, decisions, consumers, tests, contracts, the
// history of the package and of the findings on those paths, and the coupled set) and writes it as one task-context/1 document
// (SCHEMA-task-context; the shape lives in lib/task-context.cjs). The compiler takes the document with --context and never searches.
//
// Deterministic: everything of the repository is read from the git objects of the pinned commit (ls-tree, cat-file, log, diff),
// never from the working tree, so a dirty tree, another checkout of the same commit or another process gives the same bytes. The
// inputs outside the commit are the task file and the frame, by their bytes. No environment, clock, randomness or network is read;
// search servers and their indexes are never inputs. Every list is sorted by the ordinal comparison.
//
//   resolve --commit REV --base REV --stream NAME --launch-role author|certifier --task FILE [--package NAME] [--frame FILE]
//           [--level C1|C2|C3] [--root DIR] (--out FILE | --stdout)
//   head [--root DIR]                    the full id of the commit the worktree stands on
// Exit: 0 ok; 2 unusable input (a revision, a file, the git objects or a registry of the commit).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { InputError, REPO, parseRecord, cmp } = require('./lib/records.cjs');
const TC = require('./lib/task-context.cjs');
const { secretKind } = require('./lib/secrets.cjs');

const TOOL = 'protocol-context';
// The fixed sources of the repository the context reads at the commit; each one may be absent (an installed project has only part of them).
const FILES = {
  decisions: '.ai/DECISIONS.md',
  ruleMap: '.ai/core/RULE-MAP.md',
  processRegister: 'docs/ops/PROCESS-REGISTER.md',
  coupledSets: 'docs/ops/COUPLED-SETS.json',
  suiteTiming: 'docs/ops/suite-timing.json',
  consumerIndex: 'docs/ops/test-consumers.json',
  manifest: 'protocol-manifest.json',
  findingsExtractor: 'docs/ops/findings-cluster.cjs',
};
const REVIEWS = 'docs/reviews/';
const KERNEL = '.ai/core/';
// Operational records are no production files: session journals, their archives and the reviews (the consumer index rule).
const operational = n => n.startsWith('.ai/worklog/') || n.startsWith(REVIEWS) || n.startsWith('docs/ops/journals-archive/') || n === 'CERT-PROMPT.md' || n === 'FIX-PROMPT.md';
const isCode = n => /\.[cm]?js$/.test(n);
const SPECS = 'docs/core-arch'; // the directory of the specifications; a contract is a SPEC document below it
const isSpec = n => n.startsWith(`${SPECS}/`) && /SPEC[^/]*\.md$/.test(path.posix.basename(n));
const TEST_DEPTH = 8; // the depth of the consumer index
const SCOPE_CAP = 50; // a frame scope glob that names more files names no target (it is a scope, not a task)
const TASK_MAX = 2 * 1024 * 1024;
const OWNER_BASIS = ['self', 'tool-name', 'enforced-by', 'outputs', 'inputs', 'evidence', 'text'];
const TARGET_BASIS = ['task-scope', 'task-mention', 'branch-diff'];
const SET_BASIS = ['stream', 'package', 'path-mask'];
const COUPLED_SCHEMA = 'coupled-sets/1';

const sha256 = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const sortRows = (rows, key) => rows.sort((a, b) => cmp(TC.keyOf(a, key), TC.keyOf(b, key)));
const UTF8 = new TextDecoder('utf-8', { fatal: true });

// ---------- git (plumbing only, -z where it lists paths) ----------
function gitRun(root, args, input) {
  return spawnSync('git', ['-c', 'core.quotepath=false', '-c', 'i18n.logOutputEncoding=UTF-8', '-c', 'log.showSignature=false', ...args],
    { cwd: root, input, maxBuffer: 1024 * 1024 * 1024, windowsHide: true });
}
function git(root, args, input) {
  const r = gitRun(root, args, input);
  if (r.error || r.status !== 0) throw new InputError(`git ${args[0]} failed in the root (${r.error ? r.error.code || r.error.message : `exit ${r.status}`}); the context reads only the objects of a commit`);
  return r.stdout;
}
function revParse(root, rev, kind) {
  if (typeof rev !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/@^~{}-]{0,200}$/.test(rev)) throw new InputError(`${kind} "${String(rev).slice(0, 60)}" is not a revision`);
  const want = kind === 'tree' ? 'tree' : 'commit';
  const r = gitRun(root, ['rev-parse', '--verify', '--quiet', `${rev}^{${want}}`]);
  if (r.error) throw new InputError(`git rev-parse did not run in the root (${r.error.code || r.error.message}); the context reads only the objects of a commit`);
  const out = r.status === 0 ? r.stdout.toString('utf8').trim() : '';
  if (!TC.G.oid(out)) throw new InputError(`${kind} ${rev} does not name a ${want}`);
  return out;
}
function headOf(root) {
  return revParse(path.resolve(root || REPO), 'HEAD', 'head');
}
// The coupled-set registry at one commit of a worktree: { dir, commit, registry } with the full id of the commit, or commit null for a
// directory that is not the top of a worktree and for a revision that names no commit there; registry null for a commit without the file.
// A registry that is present and does not read is unusable input, as for resolve.
function revisionOk(rev) {
  if (typeof rev !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/@^~{}-]{0,200}$/.test(rev)) throw new InputError(`revision "${String(rev).slice(0, 60)}" is not a revision`);
}
function blobText(dir, commit, file) {
  const b = gitRun(dir, ['rev-parse', '--verify', '--quiet', `${commit}:${file}`]);
  const oid = !b.error && b.status === 0 ? b.stdout.toString('utf8').trim() : '';
  if (!TC.G.oid(oid)) return null;
  try { return UTF8.decode(git(dir, ['cat-file', 'blob', oid])); } catch (e) { if (e instanceof InputError) throw e; throw new InputError(`${file} of commit ${commit} is not UTF-8`); }
}
function registryAt(root, rev) {
  revisionOk(rev);
  const dir = path.resolve(root || REPO);
  const none = { dir, commit: null, registry: null };
  const top = gitRun(dir, ['rev-parse', '--show-toplevel']);
  if (top.error || top.status !== 0) return none;
  let same = false;
  try { const real = require('./lib/real-path.cjs').realPathSync; same = real(dir) === real(top.stdout.toString('utf8').trim()); } catch { same = false; }
  if (!same) return none;
  const r = gitRun(dir, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`]);
  const commit = !r.error && r.status === 0 ? r.stdout.toString('utf8').trim() : '';
  if (!TC.G.oid(commit)) return none;
  return { dir, commit, registry: coupledRegistry(blobText(dir, commit, FILES.coupledSets)) };
}
// The switch of the packet context at one commit of a worktree: on only while the coupled-set registry of that commit reads and says
// on. A directory that is not the top of a worktree, a revision that names no commit there and a commit without the registry are off;
// a registry that is present and does not read is unusable input, as for resolve. The full id of the commit comes back with the state.
function switchAt(root, rev) {
  const at = registryAt(root, rev);
  if (!at.commit) return { state: 'off', commit: null };
  return { state: at.registry && at.registry.packetContext === 'on' ? 'on' : 'off', commit: at.commit };
}
// The launch gate of the packet at one commit of a worktree, a key of its own beside the switch of the context: switching the context off
// leaves the gate as it is. The gate is on while the registry of the commit or the registry of the integration line says on; the line is
// the integration branch the manifest of the commit names, read at its remote ref and at its local branch. A source without the registry
// adds nothing, and a registry that is present and does not read is unusable input. So a branch never switches the gate off for itself:
// it is off only while every source says off, and every off names the owner act that switched it off (packetGateOff of coupledRegistry).
// -> { state: on|off, commit, sources: [{ name, state }] }
function gateAt(root, rev) {
  const at = registryAt(root, rev);
  if (!at.commit) return { state: 'off', commit: null, sources: [] };
  const sources = at.registry ? [{ name: 'commit', state: at.registry.packetGate }] : [];
  let branch = null;
  try {
    const m = JSON.parse(blobText(at.dir, at.commit, FILES.manifest) || 'null');
    branch = m && typeof m.integrationBranch === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(m.integrationBranch) && !m.integrationBranch.includes('..') ? m.integrationBranch : null;
  } catch (e) { if (e instanceof InputError) throw e; branch = null; }
  for (const ref of branch ? [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`] : []) {
    const r = gitRun(at.dir, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    const commit = !r.error && r.status === 0 ? r.stdout.toString('utf8').trim() : '';
    if (!TC.G.oid(commit)) continue;
    const registry = coupledRegistry(blobText(at.dir, commit, FILES.coupledSets));
    if (registry) sources.push({ name: ref, state: registry.packetGate });
  }
  return { state: sources.some(s => s.state === 'on') ? 'on' : 'off', commit: at.commit, sources };
}
function listTree(root, commit) {
  const entries = new Map();
  for (const row of git(root, ['ls-tree', '-r', '-l', '-z', commit]).toString('utf8').split('\0').filter(Boolean)) {
    const m = /^(\d{6}) (\w+) ([0-9a-f]+) +(\S+)\t([\s\S]+)$/.exec(row);
    if (!m) throw new InputError('the tree listing of the commit is not readable');
    const [, mode, type, oid, size, name] = m;
    if (type !== 'blob') continue; // a submodule is no file of this repository
    entries.set(name, { mode, oid, size: mode === '120000' ? 0 : Number(size), link: mode === '120000' });
  }
  return entries;
}
// The bytes of the named blobs, in batches through one cat-file process each.
function readBlobs(root, entries, names) {
  const out = new Map();
  const want = names.filter(n => entries.has(n) && !entries.get(n).link);
  const BATCH = 256 * 1024 * 1024;
  for (let i = 0; i < want.length;) {
    const items = [];
    let bytes = 0;
    while (i < want.length && (items.length === 0 || bytes + entries.get(want[i]).size <= BATCH)) { items.push(want[i]); bytes += entries.get(want[i]).size + 64; i++; }
    const buf = git(root, ['cat-file', '--batch'], items.map(n => entries.get(n).oid).join('\n') + '\n');
    let offset = 0;
    for (const name of items) {
      const nl = buf.indexOf(10, offset);
      const header = /^([0-9a-f]+) blob (\d+)$/.exec(buf.subarray(offset, nl).toString('ascii'));
      if (!header || header[1] !== entries.get(name).oid) throw new InputError(`the object of ${name} is not readable from the commit`);
      const size = Number(header[2]);
      out.set(name, buf.subarray(nl + 1, nl + 1 + size));
      offset = nl + 1 + size + 1;
    }
  }
  return out;
}
const textOf = (blobs, name) => { const b = blobs.get(name); if (!b) return null; try { return UTF8.decode(b); } catch { return null; } };

// ---------- inputs outside the commit ----------
function readInput(file, label) {
  const abs = path.resolve(String(file));
  const st = fs.lstatSync(abs, { throwIfNoEntry: false });
  if (!st) throw new InputError(`no such ${label}: ${file}`);
  if (st.isSymbolicLink() || !st.isFile()) throw new InputError(`the ${label} is not a regular file: ${file}`);
  if (st.size > TASK_MAX) throw new InputError(`the ${label} is larger than ${TASK_MAX} bytes: ${file}`);
  const bytes = fs.readFileSync(abs);
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) throw new InputError(`the ${label} starts with a byte order mark; inputs are UTF-8 without BOM: ${file}`);
  let text;
  try { text = UTF8.decode(bytes); } catch { throw new InputError(`the ${label} is not valid UTF-8: ${file}`); }
  return { bytes, text };
}

// ---------- matching ----------
// A path is named by a text when it stands there whole: no path character before it, none after it (a dot after it ends a sentence
// only when no letter or digit follows).
function mentions(text, p) {
  if (!text || !p) return false;
  for (let at = text.indexOf(p); at >= 0; at = text.indexOf(p, at + 1)) {
    const before = at > 0 ? text[at - 1] : '';
    const after = text[at + p.length] || '';
    const next = text[at + p.length + 1] || '';
    if (/[A-Za-z0-9._/-]/.test(before)) continue;
    if (/[A-Za-z0-9_/-]/.test(after)) continue;
    if (after === '.' && /[A-Za-z0-9]/.test(next)) continue;
    return true;
  }
  return false;
}
function globRe(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}
// A member mask of a coupled set: a path, a directory ending in "/", or a path with "*" inside one segment.
const maskMatches = (mask, p) => (mask.endsWith('/') ? p.startsWith(mask) : globRe(mask).test(p));

// ---------- the row guard ----------
function guard(machinePath) {
  const dropped = new Map();
  const drop = (section, reason) => { const k = `${section}\u0000${reason}`; dropped.set(k, (dropped.get(k) || 0) + 1); };
  // a row is kept when every field keeps its grammar and no string carries a machine path or a credential shape
  const admit = (section, row) => {
    for (const [name, ok] of TC.SECTIONS[section].fields) {
      for (const s of [].concat(row[name]).filter(v => typeof v === 'string')) {
        if (secretKind(s)) { drop(section, 'secret-shape'); return false; }
        if (machinePath(s).length) { drop(section, 'machine-path'); return false; }
      }
      if (!ok(row[name])) { drop(section, 'value-form'); return false; }
    }
    return true;
  };
  return { admit, drop, rows: () => [...dropped].map(([k, rows]) => { const [section, reason] = k.split('\u0000'); return { section, rows, reason }; }) };
}

// ---------- the sections ----------
function targetsOf({ root, entries, task, frameScope, base, commit }, g) {
  const found = new Map();
  const add = (p, basis) => { if (!found.has(p) || TARGET_BASIS.indexOf(basis) < TARGET_BASIS.indexOf(found.get(p))) found.set(p, basis); };
  for (const glob of frameScope) {
    const re = globRe(glob.replace(/^\.\//, ''));
    const hits = [...entries.keys()].filter(n => !operational(n) && re.test(n));
    if (hits.length > SCOPE_CAP) { for (let i = 0; i < hits.length; i++) g.drop('targets', 'scope-glob-wide'); continue; }
    for (const p of hits) add(p, 'task-scope');
  }
  for (const raw of task.match(/[A-Za-z0-9._@+~/-]+/g) || []) {
    const p = raw.replace(/^\.\//, '').replace(/[.]+$/, '');
    if (entries.has(p) && !operational(p)) add(p, 'task-mention');
  }
  if (base !== commit) {
    for (const p of git(root, ['diff', '--name-only', '--no-renames', '-z', `${base}...${commit}`]).toString('utf8').split('\0').filter(Boolean)) {
      if (!operational(p)) add(p, 'branch-diff');
    }
  }
  const rows = [...found].map(([p, basis]) => ({ path: p, basis, blob: entries.has(p) ? entries.get(p).oid : null })).filter(r => g.admit('targets', r));
  return sortRows(rows, TC.SECTIONS.targets.key);
}

function kernelRecords(root, entries, blobs) {
  const out = [];
  for (const name of [...entries.keys()].filter(n => n.startsWith(KERNEL) && n.endsWith('.md')).sort(cmp)) {
    const text = textOf(blobs, name);
    if (text === null) continue;
    const rec = parseRecord(path.join(root, ...name.split('/')), text);
    if (!rec.fm || typeof rec.fm.id !== 'string') continue;
    out.push({ name, id: rec.fm.id, status: typeof rec.fm.status === 'string' ? rec.fm.status : 'unknown', fm: rec.fm, text });
  }
  return out;
}
const entryPath = e => String(e).replace(/:\d+(?:-\d+)?$/, '');
function ownersOf(targets, records, dirs, g) {
  const ids = new Set(records.map(r => r.id));
  const rows = [];
  for (const t of targets) {
    const best = new Map();
    const add = (rec, basis) => { if (!best.has(rec.id) || OWNER_BASIS.indexOf(basis) < OWNER_BASIS.indexOf(best.get(rec.id).basis)) best.set(rec.id, { rec, basis }); };
    const stem = path.posix.basename(t.path).replace(/\.[^.]+$/, '');
    for (const rec of records) {
      if (rec.name === t.path) add(rec, 'self');
      if (rec.id === `TOOL-${stem}` && ids.has(rec.id)) add(rec, 'tool-name');
      // a script that enforces the record carries its rules; then what the record writes, reads and cites
      for (const [field, basis] of [['enforced_by', 'enforced-by'], ['outputs', 'outputs'], ['inputs', 'inputs'], ['evidence', 'evidence']]) {
        for (const e of [].concat(rec.fm[field] || []).map(entryPath)) {
          if (e === t.path || (dirs.has(e.replace(/\/$/, '')) && t.path.startsWith(`${e.replace(/\/$/, '')}/`))) add(rec, basis);
        }
      }
      if (mentions(rec.text, t.path)) add(rec, 'text');
    }
    for (const { rec, basis } of best.values()) {
      const row = { path: t.path, record: rec.id, status: rec.status, basis };
      if (g.admit('owners', row)) rows.push(row);
    }
  }
  return sortRows(rows, TC.SECTIONS.owners.key);
}

function processesOf(targets, text, g) {
  const rows = [];
  if (text === null) return rows;
  for (const line of text.split('\n')) {
    const m = /^\| (P-\d{1,4}) \|/.exec(line);
    if (!m) continue;
    for (const t of targets) if (mentions(line, t.path)) { const row = { path: t.path, process: m[1], basis: 'register-row' }; if (g.admit('processes', row)) rows.push(row); }
  }
  return sortRows(rows.filter((r, i, all) => i === all.findIndex(x => x.path === r.path && x.process === r.process)), TC.SECTIONS.processes.key);
}

function rulesOf(owners, text, g) {
  const rows = [];
  if (text === null) return rows;
  const ownerIds = new Set(owners.map(o => o.record));
  for (const line of text.split('\n')) {
    const cells = line.split('|').map(c => c.trim());
    if (!/^AR-\d{3}$/.test(cells[1] || '')) continue;
    const home = cells[4] || '';
    const named = new Set((home.match(/[A-Za-z0-9-]+/g) || []).map(tok => (/^R-L0-\d+$/.test(tok) ? 'P-L0-000' : tok)));
    for (const id of named) if (ownerIds.has(id)) { const row = { record: id, rule: cells[1], basis: 'rule-map' }; if (g.admit('rules', row)) rows.push(row); }
  }
  return sortRows(rows.filter((r, i, all) => i === all.findIndex(x => x.record === r.record && x.rule === r.rule)), TC.SECTIONS.rules.key);
}

function decisionsOf(targets, owners, records, text, g) {
  const rows = new Map();
  if (text === null) return [];
  const index = require('./protocol-index.cjs');
  const accepted = new Map();
  for (const block of index.parseBlocks(text)) {
    if (!block.body.some(l => l.trim() === 'Status: Accepted')) continue;
    accepted.set(block.id, index.boundPaths(block.body, null));
  }
  const add = (p, id, basis) => { const k = `${p}\u0000${id}`; if (!rows.has(k) || basis === 'decisions-index') rows.set(k, { path: p, id, basis }); };
  for (const t of targets) for (const [id, paths] of accepted) if (paths.includes(t.path)) add(t.path, id, 'decisions-index');
  const byId = new Map(records.map(r => [r.id, r]));
  for (const o of owners) {
    const fm = byId.get(o.record).fm;
    for (const id of [...[].concat(fm.decision || []), fm.owner_approval].filter(v => typeof v === 'string')) if (accepted.has(id)) add(o.path, id, 'owner-record');
  }
  return sortRows([...rows.values()].filter(r => g.admit('decisions', r)), TC.SECTIONS.decisions.key);
}

// The reader graph of the commit, by the rule of the consumer index: a code file reads a file it requires by a relative path, and a file
// whose base name stands in it as a token. JSON and Markdown are read, they read nothing.
function readerGraph(entries, blobs) {
  const names = [...entries.keys()].filter(n => !operational(n)).sort(cmp);
  const byBase = new Map();
  for (const n of names) { const b = path.posix.basename(n); if (!byBase.has(b)) byBase.set(b, []); byBase.get(b).push(n); }
  const reverse = new Map();
  const edge = (reader, dep) => { if (!reverse.has(dep)) reverse.set(dep, new Set()); reverse.get(dep).add(reader); };
  const builtins = new Set(require('node:module').builtinModules.flatMap(n => [n, `node:${n}`]));
  for (const name of names.filter(isCode)) {
    const body = textOf(blobs, name) || '';
    const deps = new Set();
    for (const m of body.matchAll(/\brequire\s*\(\s*['"]([^'"\r\n]+)['"]\s*\)/g)) {
      if (builtins.has(m[1])) continue;
      const b = path.posix.normalize(path.posix.join(path.posix.dirname(name), m[1]));
      for (const p of [b, `${b}.cjs`, `${b}.js`, `${b}.json`, `${b}/index.cjs`, `${b}/index.js`]) if (entries.has(p)) { deps.add(p); break; }
    }
    for (const token of new Set(body.match(/[A-Za-z0-9_.-]+/g) || [])) for (const t of byBase.get(token) || []) if (t !== name) deps.add(t);
    for (const d of deps) edge(name, d);
  }
  return { names, reverse };
}
// The digest the consumer index carries over its inputs: the names of the production files, the text of the code readers and the
// sorted test inventory (the same bytes protocol-consumers.cjs digests when it builds the index).
function indexDigest(names, blobs, indexPath, tests) {
  const h = crypto.createHash('sha256');
  for (const n of names.filter(x => x !== indexPath)) { h.update(`${n}\0`); if (isCode(n)) h.update(textOf(blobs, n) || ''); h.update('\0'); }
  h.update(JSON.stringify([...new Set(tests)].sort()));
  return `sha256:${h.digest('hex')}`;
}
function testInventory(entries, manifestText) {
  const tests = new Set([...entries.keys()].filter(n => /^tests\/[^/]+\.test\.cjs$/.test(n)));
  let manifest = null;
  try { manifest = manifestText === null ? null : JSON.parse(manifestText); } catch { manifest = null; }
  for (const n of (manifest && Array.isArray(manifest.tests) ? manifest.tests : [])) if (typeof n === 'string' && n.endsWith('.test.cjs') && entries.has(n)) tests.add(n);
  return tests;
}
function tierTable(text) {
  const ms = new Map();
  let data = null;
  try { data = text === null ? null : JSON.parse(text); } catch { data = null; }
  for (const f of (data && Array.isArray(data.files) ? data.files : [])) {
    const value = Math.max(-1, ...[].concat(f.totalMsByLog || []).filter(x => typeof x === 'number' && Number.isFinite(x)));
    for (const n of [f.name, f.owner]) if (typeof n === 'string' && value >= 0) ms.set(n, Math.max(ms.get(n) || 0, value));
  }
  return name => (TC.HEAVY_NAME.test(name) ? 'heavy-farm' : !ms.has(name) ? 'unmeasured' : ms.get(name) > TC.HEAVY_MS ? 'heavy-farm' : 'light');
}
function consumersAndTests(targets, graph, tests, index, tierOf, g) {
  const consumers = [];
  const testRows = [];
  for (const t of targets) {
    const d1 = new Set([...(graph.reverse.get(t.path) || [])].filter(n => n !== t.path && !tests.has(n)));
    const d2 = new Set();
    for (const c of d1) for (const n of graph.reverse.get(c) || []) if (n !== t.path && !d1.has(n) && !tests.has(n)) d2.add(n);
    for (const [set, depth] of [[d1, 1], [d2, 2]]) for (const c of set) { const row = { path: t.path, consumer: c, depth, basis: 'grep-at-commit' }; if (g.admit('consumers', row)) consumers.push(row); }
    let found;
    let basis;
    if (index) { found = new Set((index.consumers && Array.isArray(index.consumers[t.path]) ? index.consumers[t.path] : []).filter(n => tests.has(n))); basis = 'consumer-index'; }
    else {
      found = new Set();
      basis = 'grep-at-commit';
      const seen = new Set([t.path]);
      const queue = [[t.path, 0]];
      for (let i = 0; i < queue.length; i++) {
        const [node, depth] = queue[i];
        if (tests.has(node)) found.add(node);
        if (depth >= TEST_DEPTH) continue;
        for (const r of graph.reverse.get(node) || []) if (!seen.has(r)) { seen.add(r); queue.push([r, depth + 1]); }
      }
    }
    // a test reaches the target directly when it reads it (or is it); every other test of the set reaches it by a chain of readers
    const readers = graph.reverse.get(t.path) || new Set();
    for (const test of found) { const row = { path: t.path, test, reach: test === t.path || readers.has(test) ? 'direct' : 'chain', tier: tierOf(test), basis }; if (g.admit('tests', row)) testRows.push(row); }
  }
  return { consumers: sortRows(consumers, TC.SECTIONS.consumers.key), tests: sortRows(testRows, TC.SECTIONS.tests.key) };
}

function contractsOf(targets, entries, blobs, g) {
  const rows = [];
  for (const doc of [...entries.keys()].filter(isSpec).sort(cmp)) {
    const text = textOf(blobs, doc);
    for (const t of targets) if (t.path !== doc && mentions(text, t.path)) { const row = { path: t.path, doc, basis: 'cites-path' }; if (g.admit('contracts', row)) rows.push(row); }
  }
  return sortRows(rows, TC.SECTIONS.contracts.key);
}

// The names of one package: the stream as given and without its "ops-" prefix, and the package name without its version.
function packageKeys(stream, pkg) {
  const keys = new Set([stream.toLowerCase(), stream.toLowerCase().replace(/^ops-/, '')]);
  if (pkg) keys.add(pkg.toLowerCase().replace(/-\d+(?:\.\d+)*$/, ''));
  return [...keys].filter(k => k.length >= 6);
}
const reviewNamed = (name, keys) => { const base = path.posix.basename(name).toLowerCase(); return keys.some(k => base.includes(k)); };
function subjectOf(raw) {
  const s = String(raw).replace(/[^\x20-\x7e]|[`<>&\\]/g, '?').replace(/\s+/g, ' ').trim().slice(0, 160).trim();
  return s || '?';
}
function historyOf({ root, entries, blobs, stream, pkg, base, commit, targets }, g, extractor) {
  const pkgRows = [];
  if (base !== commit) {
    for (const line of git(root, ['log', '--first-parent', '--no-color', '--format=%H%x00%s', `${base}..${commit}`]).toString('utf8').split('\n').filter(Boolean)) {
      const [sha, subject] = line.split('\0');
      const row = { commit: sha, subject: subjectOf(subject || ''), basis: 'branch-log' };
      if (g.admit('history.package', row)) pkgRows.push(row);
    }
  }
  const keys = packageKeys(stream, pkg);
  const report = require('./lib/author-report.cjs');
  const reports = new Map();
  for (const k of [stream, stream.replace(/^ops-/, ''), ...(pkg ? [pkg.replace(/-\d+(?:\.\d+)*$/, '')] : [])]) {
    let p = null;
    try { p = report.reportPath(k); } catch { p = null; }
    if (p && entries.has(p)) reports.set(p, 'author-report');
  }
  const reviewNames = [...entries.keys()].filter(n => n.startsWith(REVIEWS) && n.endsWith('.md')).sort(cmp);
  for (const n of reviewNames) if (reviewNamed(n, keys) && !reports.has(n)) reports.set(n, 'review-name');
  const reportRows = sortRows([...reports].map(([doc, basis]) => ({ doc, basis })).filter(r => g.admit('history.reports', r)), TC.SECTIONS['history.reports'].key);
  const findings = new Map();
  // The finding history is read only from the reviews of the commit; findings kept outside the repository are no input.
  if (extractor) {
    for (const n of reviewNames) {
      const text = textOf(blobs, n);
      if (text === null) continue;
      const named = reviewNamed(n, keys);
      const cited = targets.filter(t => mentions(text, t.path));
      if (!named && !cited.length) continue;
      let records = [];
      try { records = extractor.readReview(n, blobs.get(n)).records || []; } catch { records = []; }
      for (const r of records) {
        const rowText = `${r.full_row || ''}\n${r.text || ''}`;
        const paths = cited.filter(t => mentions(rowText, t.path)).map(t => t.path);
        const severity = typeof r.severity === 'string' && TC.SEVERITIES.includes(r.severity.toUpperCase()) ? r.severity.toUpperCase() : 'unknown';
        const status = typeof r.status === 'string' && TC.G.statusWord(r.status) ? r.status : 'unknown';
        const each = paths.length ? paths.map(p => [p, 'review-cites-path']) : named ? [[null, 'review-name']] : [];
        for (const [p, basis] of each) {
          const row = { review: n, id: String(r.finding_id), severity, status, path: p, class: TC.findingClassOf(rowText), basis: named ? 'review-name' : basis };
          const k = TC.keyOf(row, TC.SECTIONS['history.findings'].key);
          if (!findings.has(k) && g.admit('history.findings', row)) findings.set(k, row);
        }
      }
    }
  }
  return { package: pkgRows, reports: reportRows, findings: sortRows([...findings.values()], TC.SECTIONS['history.findings'].key) };
}

// The coupled-set registry of the commit (coupled-sets/1). It also carries the switch of the packet context (the context is delivered
// only while the registry says it is on) and the key of the launch gate of the packet (gateAt). The gate is switched off only by an owner
// act, which packetGateOff names on one line: "owner YYYY-MM-DD" and what the act says; while the gate is on the field is null. A registry
// that is present and does not read is unusable input.
const OWNER_ACT = /^owner (\d{4}-\d{2}-\d{2})(?:[ :;,(][^\r\n]{0,300})?$/;
const ownerAct = v => {
  const m = typeof v === 'string' ? OWNER_ACT.exec(v) : null;
  if (!m) return false;
  const ms = Date.parse(`${m[1]}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(m[1]);
};
function coupledRegistry(text) {
  if (text === null) return null;
  const { parseJsonUnique } = require('./lib/text-safe.cjs');
  let data;
  try { data = parseJsonUnique(text); } catch { throw new InputError(`${FILES.coupledSets} of the commit is not valid JSON with unique keys`); }
  const bad = why => { throw new InputError(`${FILES.coupledSets} of the commit: ${why}`); };
  if (!data || typeof data !== 'object' || Array.isArray(data)) bad('not an object');
  if (data.schema !== COUPLED_SCHEMA) bad(`schema must be ${COUPLED_SCHEMA}`);
  if (!TC.SWITCH_STATES.includes(data.packetContext)) bad('packetContext must be off or on');
  if (!TC.SWITCH_STATES.includes(data.packetGate)) bad('packetGate must be off or on');
  if (data.packetGate === 'off' && !ownerAct(data.packetGateOff)) bad('packetGateOff must name the owner act that switched the gate off ("owner YYYY-MM-DD" and what the act says, one line)');
  if (data.packetGate === 'on' && data.packetGateOff !== null) bad('packetGateOff must be null while the gate is on');
  if (!Array.isArray(data.sets)) bad('sets must be an array');
  const ids = new Set();
  for (const s of data.sets) {
    if (!s || typeof s !== 'object' || !TC.G.setId(s.id)) bad('a set carries no id of capitals, digits and dashes');
    if (ids.has(s.id)) bad(`set ${s.id} is given twice`);
    ids.add(s.id);
    for (const k of ['paths', 'streams', 'packages']) if (!Array.isArray(s[k]) || s[k].some(v => typeof v !== 'string')) bad(`set ${s.id}: ${k} must be a list of strings`);
    if (!s.paths.length || s.paths.some(p => !TC.G.mask(p))) bad(`set ${s.id}: every path is a repository path, a directory ending in "/" or a mask with "*"`);
  }
  return data;
}
function coupledOf(registry, stream, pkg, targets, g) {
  if (!registry) return [];
  const rows = [];
  for (const s of registry.sets) {
    const basis = s.streams.includes(stream) ? 'stream' : pkg && s.packages.includes(pkg) ? 'package'
      : targets.some(t => s.paths.some(m => maskMatches(m, t.path))) ? 'path-mask' : null;
    if (!basis) continue;
    const row = { id: s.id, basis, members: [...new Set(s.paths)].sort(cmp) };
    if (g.admit('coupledSets', row)) rows.push(row);
  }
  return sortRows(rows, TC.SECTIONS.coupledSets.key);
}

// The findings extractor of this checkout, or null where it has none. It is an optional extension (the product does not ship it):
// loaded by a computed path, so the selection closure of the product never follows it (an exact optional dynamicCalls declaration of
// the product manifest) and the runtime require closure of gates a and f classifies it by an exact computed row, product and installed,
// of the runtime closure policy. The measure of the packet reads the classes of the reviews of the tree through it; the resolver never
// does (extractorAt).
function findingsExtractor() {
  const extractorFile = path.join(__dirname, '..', '..', ...FILES.findingsExtractor.split('/'));
  try { return require(extractorFile); } catch { return null; }
}

// The findings extractor of the pinned commit: its module and every relative module it requires are compiled from the blobs of the
// commit, never from a file of a checkout, so two worktrees of one commit read the same finding rows whatever their own copy says. A
// require outside that closure (a package, a path the commit does not carry as a file, a builtin outside EXTRACTOR_BUILTINS) throws an
// InputError naming it; the resolver then records the source as absent and reads no finding row.
const EXTRACTOR_BUILTINS = { fs, path, crypto, url: require('node:url'), child_process: require('node:child_process') };
function extractorAt(root, entries, blobs, file = FILES.findingsExtractor) {
  const vm = require('node:vm');
  const loaded = new Map();
  const load = rel => {
    if (loaded.has(rel)) return loaded.get(rel).exports;
    if (!entries.has(rel) || entries.get(rel).link || !blobs.has(rel)) throw new InputError(`the extractor needs ${rel}, which is no file of the commit`);
    let text;
    try { text = UTF8.decode(blobs.get(rel)); } catch { throw new InputError(`${rel} of the commit is not UTF-8`); }
    const filename = path.join(root, ...rel.split('/'));
    const module = { exports: {} };
    loaded.set(rel, module);
    if (rel.endsWith('.json')) { module.exports = JSON.parse(text.replace(/^\uFEFF/, '')); return module.exports; }
    const req = spec => {
      if (typeof spec !== 'string') throw new InputError(`${rel} requires a module that is not named by a string`);
      const name = spec.startsWith('node:') ? spec.slice(5) : spec;
      if (Object.hasOwn(EXTRACTOR_BUILTINS, name)) return EXTRACTOR_BUILTINS[name];
      if (!spec.startsWith('./') && !spec.startsWith('../')) throw new InputError(`${rel} requires ${spec}, which is no module of the commit and no allowed builtin`);
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      const found = [target, `${target}.cjs`, `${target}.js`, `${target}.json`].find(n => entries.has(n));
      if (!found) throw new InputError(`${rel} requires ${spec}, which is no file of the commit`);
      return load(found);
    };
    // a first line #! stays a line (a comment), so the line numbers of the module are its own
    const body = text.replace(/^\uFEFF/, '').replace(/^#!/, '//');
    vm.compileFunction(body, ['exports', 'require', 'module', '__filename', '__dirname'], { filename })
      .call(module.exports, module.exports, req, module, filename, path.dirname(filename));
    return module.exports;
  };
  return load(file);
}

// ---------- resolve ----------
function resolve(opts) {
  const root = path.resolve(opts.root || REPO);
  for (const k of ['commit', 'base', 'stream', 'launchRole', 'task']) if (!opts[k]) throw new InputError(`resolve needs --${k === 'launchRole' ? 'launch-role' : k}`);
  if (!TC.LAUNCH_ROLES.includes(opts.launchRole)) throw new InputError(`launch role must be one of ${TC.LAUNCH_ROLES.join(', ')}`);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(opts.stream)) throw new InputError('stream must be a name of letters, digits, dot, underscore and dash');
  if (opts.package !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(opts.package)) throw new InputError('package must be a name of letters, digits, dot, underscore and dash');
  const requested = opts.level || 'C3';
  if (!TC.LEVELS.includes(requested)) throw new InputError(`level must be one of ${TC.LEVELS.join(', ')}`);
  const P = require('./protocol-packet.cjs');
  const commit = revParse(root, opts.commit, 'commit');
  const base = revParse(root, opts.base, 'base');
  const tree = revParse(root, commit, 'tree');
  const task = readInput(opts.task, 'task file');
  const frameScope = [];
  if (opts.frame) {
    const scope = P.parseFrame(readInput(opts.frame, 'frame').text).scope;
    for (const s of Array.isArray(scope) ? scope : []) if (typeof s === 'string' && s) frameScope.push(s);
  }
  const g = guard(text => P.machinePathHits(text));
  const entries = listTree(root, commit);
  const dirs = new Set();
  for (const n of entries.keys()) for (let d = path.posix.dirname(n); d !== '.'; d = path.posix.dirname(d)) dirs.add(d);
  const needed = [...entries.keys()].filter(n => (n.startsWith(KERNEL) && n.endsWith('.md')) || (isCode(n) && !operational(n)) || (n.startsWith(REVIEWS) && n.endsWith('.md')) || isSpec(n));
  for (const f of Object.values(FILES)) if (entries.has(f)) needed.push(f);
  const blobs = readBlobs(root, entries, [...new Set(needed)].sort(cmp));

  const targets = targetsOf({ root, entries, task: task.text, frameScope, base, commit }, g);
  const records = kernelRecords(root, entries, blobs);
  const owners = ownersOf(targets, records, dirs, g);
  const processes = processesOf(targets, textOf(blobs, FILES.processRegister), g);
  const rules = rulesOf(owners, textOf(blobs, FILES.ruleMap), g);
  const decisions = decisionsOf(targets, owners, records, textOf(blobs, FILES.decisions), g);
  const graph = readerGraph(entries, blobs);
  const tests = testInventory(entries, textOf(blobs, FILES.manifest));
  let index = null;
  let indexState = { state: 'absent', reason: 'not in the commit' };
  const indexText = textOf(blobs, FILES.consumerIndex);
  if (indexText !== null) {
    let parsed = null;
    try { parsed = JSON.parse(indexText); } catch { parsed = null; }
    if (parsed && parsed.inputDigest === indexDigest(graph.names, blobs, FILES.consumerIndex, tests)) { index = parsed; indexState = { state: 'used', reason: null }; }
    else indexState = { state: 'stale', reason: 'input digest differs from the commit, tests read from the commit' };
  }
  const ct = consumersAndTests(targets, graph, tests, index, tierTable(textOf(blobs, FILES.suiteTiming)), g);
  const contracts = contractsOf(targets, entries, blobs, g);
  let extractor = null;
  let extractorState = { state: 'absent', reason: 'not in the commit' };
  if (entries.has(FILES.findingsExtractor)) {
    try { extractor = extractorAt(root, entries, blobs); } catch { extractor = null; }
    extractorState = extractor && typeof extractor.readReview === 'function' ? { state: 'used', reason: null } : { state: 'absent', reason: 'not loadable from the commit' };
    if (extractorState.state !== 'used') extractor = null;
  }
  const history = historyOf({ root, entries, blobs, stream: opts.stream, pkg: opts.package || null, base, commit, targets }, g, extractor);
  const registry = coupledRegistry(textOf(blobs, FILES.coupledSets));
  const coupledSets = coupledOf(registry, opts.stream, opts.package || null, targets, g);

  const listing = names => sha256(names.map(n => `${entries.get(n).oid} ${n}\n`).join(''));
  const fileSource = (name, file, state = null) => (entries.has(file)
    ? { name, file, sha256: blobs.has(file) ? sha256(blobs.get(file)) : null, state: state ? state.state : 'used', reason: state ? state.reason : null }
    : { name, file, sha256: null, state: 'absent', reason: 'not in the commit' });
  const kernelNames = [...entries.keys()].filter(n => n.startsWith(KERNEL)).sort(cmp);
  const reviewNames = [...entries.keys()].filter(n => n.startsWith(REVIEWS)).sort(cmp);
  const specNames = [...entries.keys()].filter(isSpec).sort(cmp);
  const sources = [
    fileSource('coupled-sets', FILES.coupledSets),
    fileSource('decisions', FILES.decisions),
    fileSource('findings-extractor', FILES.findingsExtractor, extractorState.state === 'used' || !entries.has(FILES.findingsExtractor) ? null : extractorState),
    kernelNames.length ? { name: 'kernel-records', file: '.ai/core', sha256: listing(kernelNames), state: 'used', reason: null } : { name: 'kernel-records', file: '.ai/core', sha256: null, state: 'absent', reason: 'not in the commit' },
    fileSource('process-register', FILES.processRegister),
    fileSource('protocol-manifest', FILES.manifest),
    reviewNames.length ? { name: 'reviews', file: 'docs/reviews', sha256: listing(reviewNames), state: 'used', reason: null } : { name: 'reviews', file: 'docs/reviews', sha256: null, state: 'absent', reason: 'not in the commit' },
    fileSource('rule-map', FILES.ruleMap),
    specNames.length ? { name: 'specs', file: SPECS, sha256: listing(specNames), state: 'used', reason: null } : { name: 'specs', file: SPECS, sha256: null, state: 'absent', reason: 'not in the commit' },
    fileSource('suite-timing', FILES.suiteTiming),
    fileSource('test-consumers', FILES.consumerIndex, indexState),
  ].sort((a, b) => cmp(a.name, b.name));

  const full = {
    schema: TC.SCHEMA, switch: registry && registry.packetContext === 'on' ? 'on' : 'off', commit, tree, base, stream: opts.stream, package: opts.package || null,
    launchRole: opts.launchRole, taskSha256: sha256(task.bytes), level: requested,
    targets, owners, processes, rules, decisions, consumers: ct.consumers, tests: ct.tests, contracts, history, coupledSets, sources,
    dropped: g.rows().sort((a, b) => cmp(TC.keyOf(a, ['section', 'reason']), TC.keyOf(b, ['section', 'reason']))),
  };
  // the document at the level asked for: the rows a level leaves out are chosen by their relevance to the task (task-context.cjs keepAt), never by
  // the size of the rendering; the size of the result is a figure for the operator (the pulse), not a rule that drops a row
  const doc = TC.atLevel(full, requested);
  TC.checkContext(doc, { machinePath: text => P.machinePathHits(text), secretKind });
  return { doc, text: TC.serialize(doc), bytes: Buffer.byteLength(TC.renderContext(doc)) };
}

// ---------- CLI ----------
function parseArgs(argv) {
  const valued = new Set(['--commit', '--base', '--stream', '--launch-role', '--task', '--package', '--frame', '--level', '--root', '--out']);
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--stdout') { o.stdout = true; continue; }
    if (!valued.has(a)) throw new InputError(`unknown argument ${a}`);
    if (i + 1 >= argv.length) throw new InputError(`${a} needs a value`);
    const key = a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (Object.hasOwn(o, key)) throw new InputError(`${a} is given twice; one option, one value`);
    o[key] = argv[++i];
  }
  return o;
}
function main(argv) {
  const out = s => process.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
  try {
    const [command, ...rest] = argv;
    if (command === 'head') {
      const o = parseArgs(rest);
      out(`HEAD commit=${headOf(o.root)}`);
      out('RESULT exit=0');
      return 0;
    }
    if (command !== 'resolve') throw new InputError('usage: protocol-context.cjs resolve|head (see the header of this file)');
    const o = parseArgs(rest);
    if (Boolean(o.out) === Boolean(o.stdout)) throw new InputError('resolve writes the document to exactly one of --out FILE and --stdout');
    const r = resolve(o);
    if (o.stdout) process.stdout.write(r.text);
    else {
      const root = path.resolve(o.root || REPO);
      const written = require('./lib/path-safe.cjs').writeAtomicGuarded(path.resolve(o.out), Buffer.from(r.text, 'utf8'), { root });
      if (!written || written.ok === false) throw new InputError(`cannot write the context document ${o.out}: ${written && (written.reason || written.code) || 'refused'}; the document is written only inside the root, never through a link`);
    }
    const count = s => TC.rowsOf(r.doc, s).length;
    // with --stdout the document owns the standard output; the summary goes to the error stream
    const say = o.stdout ? s => process.stderr.write(`${s}\n`) : out;
    say(`CONTEXT tool=${TOOL} schema=${r.doc.schema} switch=${r.doc.switch} level=${r.doc.level} bytes=${r.bytes} sha256=${sha256(Buffer.from(r.text, 'utf8'))} ${TC.SECTION_NAMES.map(s => `${s}=${count(s)}`).join(' ')}`);
    say('RESULT exit=0');
    return 0;
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    out(`ERROR reason=${JSON.stringify(error.message)}`);
    return 2;
  }
}

module.exports = { resolve, headOf, switchAt, gateAt, findingsExtractor, extractorAt, mentions, globRe, maskMatches, packageKeys, coupledRegistry, readerGraph, indexDigest, TOOL, FILES, SET_BASIS, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

#!/usr/bin/env node
'use strict';
// pilot-install: put the current kernel (L5) and the L6 pilot kit into ONE installed project, on a branch of its own.
//   node docs/ops/pilot-install.cjs --target <repo> [--branch kernel-pilot-YYYYMMDD] [--dry-run] [--no-commit] [--keys=ask|yes|no]
//   node docs/ops/pilot-install.cjs --target <repo> --update [--dry-run]   (re-apply the current kit ON the checked-out kernel-pilot-* branch)
// Contract: docs/ops/PILOT-INSTALL.md (layers L4, L5, L6: docs/ops/PILOT-L4-L6.md). Class B tooling (PROTO-DEC-0169). Exit 0 done, 1 install or checks failed (branch left
// uncommitted), 2 refused or bad usage (nothing changed). It never pushes, never touches the project's main, deletes nothing.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SOURCE = path.resolve(__dirname, '..', '..');
const SETUP = path.join(SOURCE, '.ai', 'bin', 'protocol-setup.cjs');
const KIT_JSON = path.join(SOURCE, 'docs', 'ops', 'pilot-kit.json');
const REPORT_REL = 'docs/ops/pilot-install-report.md';
const NEXT_STEPS_REL = 'docs/ops/PILOT-NEXT-STEPS.md';
// The keys wizard as the installed project holds it (the kit keeps the channels tools under src/); offered at the end of a REAL install.
const WIZARD_REL = 'docs/ops/pilot-kit/src/docs/ops/channels-wizard.cjs';
const KEYS_MODES = ['ask', 'yes', 'no'];
const INSTRUCTION_FILES = ['CLAUDE.md', 'AGENTS.md'];
const INTEGRATION_FILES = ['.claude/settings.json', '.codex/hooks.json', '.gitattributes', '.gitignore', 'protocol-manifest.json'];
// The tool talks to the local repository only. Anything that could leave the machine is refused by the git wrapper itself.
const PILOT_PREFIX = 'kernel-pilot-';
const FORBIDDEN_GIT = new Set(['push', 'fetch', 'pull', 'clone', 'remote', 'ls-remote', 'send-pack', 'submodule']);
const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

class Refusal extends Error {
  constructor(id, message) { super(message); this.id = id; }
}

// ---- git ----
function gitSubcommand(args) {
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-c' || args[i] === '-C') { i++; continue; }
    if (args[i].startsWith('-')) continue;
    return args[i];
  }
  return '';
}
function gitCmd(cwd, args) {
  const sub = gitSubcommand(args);
  if (FORBIDDEN_GIT.has(sub)) throw new Error(`forbidden git subcommand: ${sub}`);
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024 * 1024 });
  return { status: r.status, stdout: (r.stdout || '').trim(), stderr: (r.stderr || '').trim() };
}
function git(cwd, ...args) {
  const r = gitCmd(cwd, args);
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).replace(/\s+/g, ' ')}`);
  return r.stdout;
}

// ---- pure helpers ----
// Block names: letters of any script, combining marks, digits, dash, underscore, dot, colon.
const BLOCK_RE = /<!-- ([\p{L}\p{M}\p{N}_.:-]+):start -->[\s\S]*?<!-- \1:end -->/gu;
function parseBlocks(text) {
  const re = new RegExp(BLOCK_RE.source, BLOCK_RE.flags);
  const blocks = [];
  let m;
  while ((m = re.exec(text)) !== null) blocks.push({ name: m[1], text: m[0], index: m.index });
  return blocks;
}
const toLf = s => s.replace(/\r\n/g, '\n');

// Start markers that look like a project block but that parseBlocks cannot pair (odd name, no end marker, no spaces):
// restoring would silently lose them, so the tool refuses before it writes anything.
function unparsedMarkers(text) {
  const lf = toLf(text);
  const parsed = new Map();
  for (const b of parseBlocks(lf)) parsed.set(b.name, (parsed.get(b.name) || 0) + 1);
  const seen = new Map();
  const bad = [];
  const re = /<!--\s*([^\s>][^>]*?)\s*:start\s*-->/g;
  let m;
  while ((m = re.exec(lf)) !== null) {
    const n = (seen.get(m[1]) || 0) + 1;
    seen.set(m[1], n);
    if (n > (parsed.get(m[1]) || 0)) bad.push({ name: m[1], marker: m[0], line: lf.slice(0, m.index).split('\n').length });
  }
  return bad;
}
// 0-based line indexes of the ORIGINAL text that are wholly covered by the given blocks (a block that shares a line with other
// text does not exclude that line, so the other text is still reported).
function blockLines(lf, blocks) {
  const lines = new Set();
  for (const b of blocks) {
    const first = lf.slice(0, b.index).split('\n').length - 1;
    const last = first + b.text.split('\n').length - 1;
    const end = b.index + b.text.length;
    const from = b.index === 0 || lf[b.index - 1] === '\n' ? first : first + 1;
    const to = end === lf.length || lf[end] === '\n' ? last : last - 1;
    for (let i = from; i <= to; i++) lines.add(i);
  }
  return lines;
}

// Re-insert, after the managed text and in their original order, the marker blocks of the old file whose start marker is gone.
function restoreBlocks(oldText, newText) {
  const old = toLf(oldText);
  const fresh = toLf(newText);
  const missing = parseBlocks(old).filter(b => !fresh.includes(`<!-- ${b.name}:start -->`));
  if (!missing.length) return { text: fresh, restored: [] };
  const names = [];
  for (const b of missing) if (!names.includes(b.name)) names.push(b.name);
  return { text: `${fresh.replace(/\n+$/, '')}\n\n${missing.map(b => b.text).join('\n\n')}\n`, restored: names };
}

// Lines of the old text that are not in the new text, grouped by adjacency and classified. `historic` is the set of every line
// the source's CLAUDE.md/AGENTS.md ever held (null when unknown): a group of lines the protocol never wrote is a project candidate.
// Line numbers are those of the ORIGINAL text; `excluded` (0-based line indexes) are skipped and break a group, nothing is renumbered.
function removedGroups(oldText, newText, historic, excluded = new Set()) {
  const oldLines = toLf(oldText).split('\n');
  const keep = new Set(toLf(newText).split('\n').map(l => l.trim()));
  const entries = [];
  oldLines.forEach((line, i) => {
    const t = line.trim();
    if (!t || keep.has(t) || excluded.has(i)) return;
    entries.push({ n: i + 1, kind: historic && historic.has(t) ? 'old managed text' : 'project-specific candidate' });
  });
  const groups = [];
  for (const e of entries) {
    const g = groups[groups.length - 1];
    const gap = g ? oldLines.slice(g.end, e.n - 1).some((l, k) => l.trim() || excluded.has(g.end + k)) : true;
    if (g && g.kind === e.kind && !gap) g.end = e.n;
    else groups.push({ kind: e.kind, start: e.n, end: e.n });
  }
  return groups.map(g => ({ kind: g.kind, start: g.start, end: g.end, lines: oldLines.slice(g.start - 1, g.end) }));
}

// Dependency closure of `roots` over relative require() calls (builtins and bare names are ignored).
const REQUIRE_RE = /require\(\s*(['"])(\.{1,2}(?:\/[^'"]*)?)\1\s*\)/g;
function resolveModule(base) {
  for (const cand of [base, `${base}.cjs`, `${base}.js`, `${base}.json`, path.join(base, 'index.cjs'), path.join(base, 'index.js')]) {
    if (fs.existsSync(cand) && fs.statSync(cand).isFile()) return cand;
  }
  return null;
}
function closure(root, roots) {
  const seen = new Set();
  const pending = [];
  const missingRequired = [];
  const unresolved = [];
  const rel = full => path.relative(root, full).split(path.sep).join('/');
  const queue = [];
  for (const r of roots) {
    const full = path.join(root, r.path);
    if (fs.existsSync(full) && fs.statSync(full).isFile()) queue.push(full);
    else if (r.required) missingRequired.push(r.path);
    else pending.push({ path: r.path });
  }
  while (queue.length) {
    const file = queue.shift();
    const key = rel(file);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!/\.(cjs|js|mjs)$/.test(file)) continue;
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(REQUIRE_RE)) {
      const hit = resolveModule(path.resolve(path.dirname(file), m[2]));
      if (hit) queue.push(hit);
      else unresolved.push({ from: key, spec: m[2] });
    }
  }
  return { files: [...seen].sort(), pending, missingRequired, unresolved };
}

// ---- arguments ----
function parseArgs(argv) {
  const o = { target: '', branch: '', dryRun: false, noCommit: false, keys: 'ask', update: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') { if (i + 1 >= argv.length) throw new Error('--target needs a path'); o.target = argv[++i]; }
    else if (a.startsWith('--target=')) o.target = a.slice(9);
    else if (a === '--branch') { if (i + 1 >= argv.length) throw new Error('--branch needs a name'); o.branch = argv[++i]; }
    else if (a.startsWith('--branch=')) o.branch = a.slice(9);
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--no-commit') o.noCommit = true;
    else if (a === '--keys') { if (i + 1 >= argv.length) throw new Error('--keys needs ask, yes or no'); o.keys = argv[++i]; }
    else if (a.startsWith('--keys=')) o.keys = a.slice(7);
    else if (a === '--update') o.update = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!KEYS_MODES.includes(o.keys)) throw new Error(`--keys must be one of ${KEYS_MODES.join(', ')} (got "${o.keys}")`);
  if (!o.target) throw new Error('usage: node docs/ops/pilot-install.cjs --target <repo> [--branch NAME] [--dry-run] [--no-commit] [--keys=ask|yes|no] | --target <repo> --update [--dry-run]');
  if (o.update && o.branch) throw new Error('--update works on the checked-out kernel-pilot-* branch; --branch is not accepted with it');
  if (o.update && o.noCommit) throw new Error('--update commits its result as one change or leaves nothing committed; --no-commit is not accepted with it');
  return o;
}
function defaultBranch(now = new Date()) {
  return `${PILOT_PREFIX}${now.toISOString().slice(0, 10).replace(/-/g, '')}`;
}
function samePath(a, b) {
  const norm = p => { let r; try { r = fs.realpathSync.native(p); } catch { r = path.resolve(p); } return process.platform === 'win32' ? r.toLowerCase() : r; };
  return norm(a) === norm(b);
}
function readStrict(file) {
  const buf = fs.readFileSync(file);
  const text = strictUtf8.decode(buf);
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

// ---- refusals ----
// update = true: the --update mode. No branch is created; the CHECKED-OUT branch must already be a kernel-pilot-* branch (R12 otherwise).
function preflight(target, branch, update = false) {
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Refusal('R1', `target is not a directory: ${target}`);
  if (samePath(target, SOURCE)) throw new Refusal('R6', 'the target is this source checkout; pilot-install installs into another project');
  let srcRole = '';
  try { srcRole = JSON.parse(fs.readFileSync(path.join(SOURCE, 'protocol-manifest.json'), 'utf8')).role; } catch { /* handled below */ }
  if (srcRole !== 'source') throw new Refusal('R6', `this checkout is not the protocol source (manifest role "${srcRole}")`);
  if (!update && (!branch || branch.startsWith('-') || branch.includes('@{') || gitCmd(SOURCE, ['check-ref-format', '--branch', branch]).status !== 0)) {
    throw new Refusal('R7', `not a valid git branch name: "${branch}"`);
  }
  if (!update && (!branch.startsWith(PILOT_PREFIX) || branch.length === PILOT_PREFIX.length)) {
    throw new Refusal('R7', `the pilot branch name must start with "${PILOT_PREFIX}" and name the pilot after it (got "${branch}"); main, master and any other working branch are never a pilot branch`);
  }
  const top = gitCmd(target, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || !samePath(top.stdout, target)) throw new Refusal('R2', `the target is not the root of a git repository: ${target}`);
  const manifestFile = path.join(target, 'protocol-manifest.json');
  if (!fs.existsSync(manifestFile)) throw new Refusal('R5', 'protocol-manifest.json is missing: the target is not an installed project');
  let role;
  try { role = JSON.parse(readStrict(manifestFile)).role; } catch { throw new Refusal('R5', 'protocol-manifest.json is not valid JSON'); }
  if (role !== 'installed') throw new Refusal('R5', `protocol-manifest.json role is "${role}", not "installed"`);
  const dirty = git(target, 'status', '--porcelain=v1');
  if (dirty) {
    const lines = dirty.split('\n');
    throw new Refusal('R3', `working tree is not clean (${lines.length} path(s)); commit or stash first:\n  ${lines.slice(0, 10).join('\n  ')}`);
  }
  const current = gitCmd(target, ['symbolic-ref', '--short', '-q', 'HEAD']);
  if (current.status !== 0 || !current.stdout) throw new Refusal('R4', 'HEAD is detached; check out a branch first');
  if (update) {
    if (!current.stdout.startsWith(PILOT_PREFIX) || current.stdout.length === PILOT_PREFIX.length) {
      throw new Refusal('R12', `--update runs only on an existing ${PILOT_PREFIX}* branch; the checked-out branch is "${current.stdout}". Check out the pilot branch first (git checkout ${PILOT_PREFIX}...), or run a normal install without --update`);
    }
  } else {
    if (current.stdout === branch) throw new Refusal('R4', `the current branch is already the pilot branch "${branch}"`);
    // compared case-insensitively: on Windows refs/heads/Kernel-Pilot-x and kernel-pilot-x are the same file
    const heads = gitCmd(target, ['for-each-ref', '--format=%(refname:short)', 'refs/heads']);
    if (heads.status !== 0) throw new Refusal('R4', 'cannot list the branches of the target');
    if (heads.stdout.split('\n').some(h => h.trim().toLowerCase() === branch.toLowerCase())) {
      throw new Refusal('R4', `the pilot branch "${branch}" already exists; the tool never commits to a branch that existed before the run`);
    }
  }
  for (const f of INSTRUCTION_FILES) {
    const full = path.join(target, f);
    if (!fs.existsSync(full)) continue;
    let text;
    try { text = readStrict(full); } catch { throw new Refusal('R9', `${f} is not valid UTF-8; fix its encoding first, the blocks cannot be restored safely`); }
    const bad = unparsedMarkers(text);
    if (bad.length) {
      throw new Refusal('R10', `${f} holds a marker block the tool cannot parse and would lose: ${bad.map(b => `"${b.marker}" (line ${b.line})`).join(', ')}. ` +
        'Write it as <!-- NAME:start --> ... <!-- NAME:end --> (one space after <!--, NAME of letters, digits, - _ . :) with its end marker, then run again.');
    }
  }
  return { oldBranch: current.stdout, oldHead: git(target, 'rev-parse', 'HEAD') };
}

// ---- kit ----
// A repository-relative POSIX path that stays inside the repository (no absolute form, no backslash, no empty, . or .. segment).
function safeRel(p) {
  return typeof p === 'string' && p !== '' && !path.isAbsolute(p) && !/\\/.test(p) && !/^[A-Za-z]:/.test(p) && p.split('/').every(x => x !== '' && x !== '.' && x !== '..');
}
function sourceManaged() {
  try { return new Set(JSON.parse(fs.readFileSync(path.join(SOURCE, 'protocol-manifest.json'), 'utf8')).managed || []); } catch { return new Set(); }
}
// The layer groups of pilot-kit/2: each root with its require() closure plus explicit files, every path installed once (first group wins),
// and the skeletons (written only when absent).
function planGroups(def) {
  const claimed = new Set();
  const groups = [];
  const fail = m => { throw new Refusal('R8', `docs/ops/pilot-kit.json: ${m}`); };
  for (const g of def.groups || []) {
    if (!g || !/^[a-z0-9-]+$/.test(g.id || '') || !Array.isArray(g.roots)) fail('a group needs an id (a-z, 0-9, dash) and a roots array');
    for (const r of g.roots) if (!r || !safeRel(r.path)) fail(`group ${g.id}: unsafe root path ${JSON.stringify(r && r.path)}`);
    const c = closure(SOURCE, g.roots.map(r => ({ path: r.path, required: r.required !== false })));
    if (c.missingRequired.length) throw new Refusal('R8', `pilot kit group ${g.id}: root(s) missing on this checkout: ${c.missingRequired.join(', ')}`);
    const explicit = g.files || [];
    for (const f of explicit) {
      if (!safeRel(f)) fail(`group ${g.id}: unsafe file path ${JSON.stringify(f)}`);
      if (!fs.existsSync(path.join(SOURCE, f)) || !fs.statSync(path.join(SOURCE, f)).isFile()) throw new Refusal('R8', `pilot kit group ${g.id}: file missing on this checkout: ${f}`);
    }
    const files = [];
    for (const rel of [...c.files, ...explicit]) { if (claimed.has(rel)) continue; claimed.add(rel); files.push(rel); }
    const skeletons = [];
    for (const k of g.skeletons || []) {
      if (!k || !safeRel(k.path) || (typeof k.from === 'string') === (typeof k.content === 'string')) fail(`group ${g.id}: a skeleton needs a safe path and exactly one of from or content`);
      let bytes;
      if (typeof k.from === 'string') {
        if (!safeRel(k.from) || !fs.existsSync(path.join(SOURCE, k.from))) throw new Refusal('R8', `pilot kit group ${g.id}: skeleton source missing: ${k.from}`);
        bytes = fs.readFileSync(path.join(SOURCE, k.from));
      } else bytes = Buffer.from(k.content, 'utf8');
      skeletons.push({ path: k.path, from: k.from || null, bytes });
    }
    groups.push({ id: g.id, title: g.title || '', files: files.sort(), skeletons, pending: c.pending, unresolved: c.unresolved });
  }
  return groups;
}
function loadKitPlan() {
  let def;
  try { def = JSON.parse(fs.readFileSync(KIT_JSON, 'utf8')); } catch (e) { throw new Refusal('R8', `docs/ops/pilot-kit.json is unreadable: ${e.message}`); }
  if (!['pilot-kit/1', 'pilot-kit/2'].includes(def.schema) || !Array.isArray(def.roots) || !Array.isArray(def.templates) || typeof def.destination !== 'string' || (def.groups !== undefined && !Array.isArray(def.groups))) {
    throw new Refusal('R8', 'docs/ops/pilot-kit.json does not match pilot-kit/1 or pilot-kit/2');
  }
  const c = closure(SOURCE, def.roots.map(r => ({ path: r.path, required: r.required !== false })));
  if (c.missingRequired.length) throw new Refusal('R8', `pilot kit root(s) missing on this checkout: ${c.missingRequired.join(', ')}`);
  for (const t of def.templates) if (!fs.existsSync(path.join(SOURCE, t))) throw new Refusal('R8', `pilot kit template missing: ${t}`);
  const guardBlock = publicGuardBlock(SOURCE);
  if (!guardBlock) throw new Refusal('R8', `${NEXT_STEPS_REL} is missing or has no public-guard block on this checkout`);
  return { def, closure: c, groups: planGroups(def), guardBlock };
}
// Every path of this checkout whose change changes what an install puts into a project: the kit definition, its roots with their closure,
// templates, layer files, skeleton sources and the managed protocol files. Used by docs/ops/fleet/fleet.cjs to count the factory commits
// that touch the kit since a project's kit version. Throws a Refusal (R8) when the kit cannot be planned.
function kitSourcePaths() {
  const plan = loadKitPlan();
  const set = new Set(['docs/ops/pilot-kit.json', 'protocol-manifest.json', NEXT_STEPS_REL, ...plan.closure.files, ...plan.def.templates, ...sourceManaged()]);
  for (const g of plan.groups) {
    for (const f of g.files) set.add(f);
    for (const k of g.skeletons) if (k.from) set.add(k.from);
  }
  return [...set].filter(safeRel).sort();
}
// Every repository-relative path an install or an update writes into a project: the managed protocol files, the instruction files, the layer
// files, the files of the kit folder with its manifest, and the report. `skeletons` are separate: written only when absent, never overwritten.
// Used by docs/ops/fleet/fleet.cjs to refuse a write onto a path the project's own ignore rules cover (a local file the update would replace
// or a kit file git would silently leave out of the commit). Throws a Refusal (R8) when the kit cannot be planned.
function kitTargetPaths() {
  const plan = loadKitPlan();
  const dest = plan.def.destination;
  const set = new Set([...sourceManaged(), ...INSTRUCTION_FILES, REPORT_REL, `${dest}/KIT-MANIFEST.json`]);
  for (const rel of plan.closure.files) set.add(`${dest}/src/${rel}`);
  for (const t of plan.def.templates) set.add(`${dest}/${path.basename(t)}`);
  for (const g of plan.groups) for (const f of g.files) set.add(f);
  return { files: [...set].filter(safeRel).sort(), skeletons: plan.groups.flatMap(g => g.skeletons.map(k => k.path)).filter(safeRel).sort() };
}
// The KIT-MANIFEST.json of the kit already installed in the target (null when there is none or it is unreadable).
function previousKit(target, plan) {
  try {
    const m = JSON.parse(readStrict(path.join(target, plan.def.destination, 'KIT-MANIFEST.json')));
    const layerFiles = new Set();
    for (const l of m.layers || []) for (const f of l.files || []) layerFiles.add(f.path);
    return { sourceSha: typeof m.sourceSha === 'string' ? m.sourceSha : 'unknown', layerFiles, kitFiles: new Set((m.files || []).map(f => f.path)) };
  } catch { return null; }
}
// The visible "do not publish" block of docs/ops/PILOT-NEXT-STEPS.md (between the public-guard markers, fence lines dropped); null when absent.
function publicGuardBlock(root) {
  let text;
  try { text = toLf(readStrict(path.join(root, NEXT_STEPS_REL))); } catch { return null; }
  const m = /<!-- public-guard:start -->\n([\s\S]*?)\n<!-- public-guard:end -->/.exec(text);
  if (!m) return null;
  const lines = m[1].split('\n').filter(l => !l.startsWith('```'));
  return lines.length ? lines : null;
}
// Printed last on every run that did not refuse: the pilot branch holds the kernel, journals and launch records and must not reach a public repository.
function printPublicGuard(log, guardBlock, branch) {
  log('');
  for (const l of guardBlock) log(l);
  log(`branch of this install: ${branch} (never push it to a public repository; nothing was pushed by this tool)`);
}
// The checklist for the user, from the copy the install just wrote into the target.
function printNextSteps(log, target) {
  let text;
  try { text = readStrict(path.join(target, NEXT_STEPS_REL)); } catch { log(`next steps: ${NEXT_STEPS_REL} was not written`); return; }
  log('');
  log(`Next steps for the user (the same text is in ${NEXT_STEPS_REL}):`);
  log('');
  for (const l of toLf(text).replace(/\n+$/, '').split('\n')) log(l);
}

// Project files the layer groups would replace: a path that exists in the target with other bytes and is neither a managed protocol
// file (setup --Force replaces those anyway) nor one the previous pilot install put there (listed in its KIT-MANIFEST.json). Those are
// refused (R11) before anything is written; `replaced` are the previous pilot files whose local edits the run would overwrite (snapshotted).
function kitCollisions(target, plan) {
  const managed = sourceManaged();
  const ours = new Set();
  try {
    const m = JSON.parse(readStrict(path.join(target, plan.def.destination, 'KIT-MANIFEST.json')));
    for (const l of m.layers || []) for (const f of l.files || []) ours.add(f.path);
  } catch { /* no previous pilot install */ }
  const foreign = [];
  const replaced = [];
  for (const g of plan.groups) {
    for (const rel of g.files) {
      const full = path.join(target, rel);
      if (!fs.existsSync(full)) continue;
      if (!fs.statSync(full).isFile()) { foreign.push(rel); continue; }
      if (fs.readFileSync(full).equals(fs.readFileSync(path.join(SOURCE, rel)))) continue;
      if (managed.has(rel)) continue;
      (ours.has(rel) ? replaced : foreign).push(rel);
    }
    for (const k of g.skeletons) if (fs.existsSync(path.join(target, k.path)) && !fs.statSync(path.join(target, k.path)).isFile()) foreign.push(k.path);
  }
  return { foreign, replaced };
}
const sha256 = buf => `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;
function installKit(target, plan, source) {
  const dest = path.join(target, plan.def.destination);
  const files = [];
  const put = (relInKit, bytes) => {
    const out = path.join(dest, relInKit);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, bytes);
    files.push({ path: relInKit.split(path.sep).join('/'), sha256: sha256(bytes) });
  };
  for (const rel of plan.closure.files) put(path.join('src', rel), fs.readFileSync(path.join(SOURCE, rel)));
  for (const t of plan.def.templates) put(path.basename(t), fs.readFileSync(path.join(SOURCE, t)));
  const manifest = {
    schema: 'pilot-kit-manifest/1',
    sourceSha: source.sha,
    sourceDirty: source.dirty,
    roots: plan.def.roots,
    pending: plan.closure.pending.map(p => ({ path: p.path, reason: 'not present on the source checkout when this kit was installed; re-run pilot-install after it lands' })),
    unresolved: plan.closure.unresolved,
    files,
  };
  // layer groups: every file at its own repo-relative path (fixed places such as .ai/bin/* included), skeletons only when absent
  const layers = [];
  for (const g of plan.groups) {
    const lfiles = [];
    for (const rel of g.files) {
      const bytes = fs.readFileSync(path.join(SOURCE, rel));
      const out = path.join(target, rel);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, bytes);
      lfiles.push({ path: rel, sha256: sha256(bytes) });
    }
    const skeletons = [];
    for (const k of g.skeletons) {
      const out = path.join(target, k.path);
      const existed = fs.existsSync(out);
      if (!existed) { fs.mkdirSync(path.dirname(out), { recursive: true }); fs.writeFileSync(out, k.bytes); }
      skeletons.push({ path: k.path, template: sha256(k.bytes), action: existed ? 'kept' : 'created' });
    }
    layers.push({ id: g.id, files: lfiles, skeletons, pending: g.pending.map(p => ({ path: p.path })), unresolved: g.unresolved });
  }
  // the manifest is deterministic across re-runs: the skeleton action (created or kept) is run history, it goes to the report, not here
  manifest.layers = layers.map(l => ({ ...l, skeletons: l.skeletons.map(k => ({ path: k.path, template: k.template })) }));
  fs.writeFileSync(path.join(dest, 'KIT-MANIFEST.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return { files, pending: manifest.pending, unresolved: manifest.unresolved, dir: plan.def.destination, layers };
}

// ---- source facts ----
function sourceInfo() {
  const sha = gitCmd(SOURCE, ['rev-parse', 'HEAD']);
  // tracked changes only: an untracked journal or note does not make the installed bytes differ from the SHA
  const dirty = gitCmd(SOURCE, ['status', '--porcelain=v1', '--untracked-files=no']);
  return { sha: sha.status === 0 ? sha.stdout : 'unknown', dirty: dirty.status === 0 ? dirty.stdout !== '' : true };
}
// Every line CLAUDE.md or AGENTS.md of the source ever held, from `git log -p`; null when the history cannot be read.
function historicLines() {
  const r = gitCmd(SOURCE, ['log', '--format=', '-p', '--no-color', '--', ...INSTRUCTION_FILES]);
  if (r.status !== 0) return null;
  const set = new Set();
  for (const line of r.stdout.split('\n')) {
    if (!line || line.startsWith('+++') || line.startsWith('---') || line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index ')) continue;
    if ('+- '.includes(line[0])) set.add(line.slice(1).trim());
  }
  for (const f of INSTRUCTION_FILES) { try { for (const l of readStrict(path.join(SOURCE, f)).split(/\r?\n/)) set.add(l.trim()); } catch { /* absent */ } }
  return set;
}

// ---- running the target's own checks ----
function nodeRun(cwd, args) {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, PROTOCOL_NO_FULL_SUITE: '1' }, maxBuffer: 256 * 1024 * 1024 });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
function runChecks(target) {
  const v = nodeRun(target, [path.join('.ai', 'bin', 'protocol-validate.cjs'), '--root', '.']);
  const vLines = v.out.split(/\r?\n/).filter(Boolean);
  const validate = { ok: v.status === 0, status: v.status, fails: vLines.filter(l => /\[FAIL\]|\[ERROR\]/.test(l)), summary: vLines[vLines.length - 1] || '', tail: vLines.slice(-15) };
  const l = nodeRun(target, [path.join('.ai', 'bin', 'protocol-core.cjs'), 'lint', '.ai/core']);
  const lLines = l.out.split(/\r?\n/).filter(Boolean);
  const result = lLines.find(x => x.startsWith('RESULT ')) || '';
  const findings = /findings=(\d+)/.exec(result);
  const lint = { ok: l.status === 0 && findings !== null && findings[1] === '0', status: l.status, result, tail: lLines.slice(-15) };

  // Advisory MCP minimum installation diagnosis (PROTO-DEC-0170)
  let mcp = { advisory: true, gatesAffected: false, exitCode: 0, servers: [], summary: 'MCP minimum unverified (advisory diagnostic unavailable)' };
  try {
    const docPath = path.join(SOURCE, 'docs', 'ops', 'channels-doctor.cjs');
    if (fs.existsSync(docPath)) {
      const { diagnoseMcpMinimum } = require(docPath);
      if (typeof diagnoseMcpMinimum === 'function') {
        mcp = diagnoseMcpMinimum(target);
      }
    }
  } catch (_) {}

  return { validate, lint, mcp };
}

// ---- report ----
function renderReport(i) {
  const out = [];
  out.push('# Pilot install report', '');
  out.push(`- Date (UTC): ${i.date}`);
  out.push(`- Source: ${SOURCE.split(path.sep).join('/')} @ ${i.source.sha}${i.source.dirty ? ' (working tree dirty)' : ' (clean)'}`);
  out.push(`- Target: ${i.target.split(path.sep).join('/')}`);
  if (i.mode === 'update') {
    out.push(`- Mode: update of the pilot kit on the existing branch (--update); previous install report: git show ${i.oldHead.slice(0, 12)}:${REPORT_REL}`);
    out.push(`- Pilot branch: ${i.branch} (updated in place) @ ${i.oldHead}`);
    out.push(`- Kit version (factory commit): ${i.previousKitVersion || 'none (no kit on this branch before)'} -> ${i.source.sha}`);
  } else {
    out.push(`- Pilot branch: ${i.branch}, created from ${i.oldBranch} @ ${i.oldHead}`);
    out.push(`- Kit version (factory commit): ${i.source.sha}`);
  }
  out.push(`- Snapshot of the old files (OS temp dir, not deleted): ${i.snapDir}`);
  out.push(`- Installer backups: ${i.backupLine || 'none reported'} (git-ignored by the protocol)`, '');
  out.push('## Installer', '');
  for (const l of i.installLines) out.push(`- ${l}`);
  out.push('', '## Restored project blocks', '');
  if (!i.restored.length) out.push('None: no marker block was lost.');
  for (const r of i.restored) out.push(`- ${r.file}: ${r.names.length ? r.names.join(', ') : 'none'}`);
  out.push('', '## Lines present before and absent after (outside the restored blocks)', '');
  out.push('Exact old lines with their old line numbers. `old managed text` = lines the protocol itself wrote in an earlier version; `project-specific candidate` = lines the protocol never wrote: review each and move what the project still needs into a marker block (`<!-- NAME:start -->` ... `<!-- NAME:end -->`), which later installs restore automatically. Nothing is lost: the old files are in the snapshot, in the installer backups and in the previous commit.', '');
  for (const f of i.groups) {
    out.push(`### ${f.file}`, '');
    if (!f.groups.length) { out.push('No line was removed.', ''); continue; }
    for (const g of f.groups) {
      out.push(`#### ${g.kind} (old lines ${g.start}-${g.end})`, '', '```diff', `@@ -${g.start},${g.lines.length} +0,0 @@`);
      for (const l of g.lines) out.push(`-${l}`);
      out.push('```', '');
    }
  }
  out.push('## Pilot kit', '');
  out.push(`Directory: ${i.kit.dir}/ (${i.kit.files.length} file(s), manifest KIT-MANIFEST.json)`, '');
  for (const f of i.kit.files) out.push(`- ${f.path}`);
  out.push('', `Pending (absent on the source checkout, not an error): ${i.kit.pending.length ? i.kit.pending.map(p => p.path).join(', ') : 'none'}`);
  if (i.kit.unresolved.length) out.push('', `Unresolved relative require() calls: ${i.kit.unresolved.map(u => `${u.from} -> ${u.spec}`).join('; ')}`);
  for (const l of i.kit.layers) {
    out.push('', `### Layer ${l.id.toUpperCase()} (${l.files.length} file(s) at their repo-relative paths)`, '');
    for (const f of l.files) out.push(`- ${f.path}`);
    for (const k of l.skeletons) out.push(`- skeleton ${k.path}: ${k.action === 'created' ? 'created (was absent)' : 'kept (already present, not overwritten)'}`);
    if (l.pending.length) out.push(`- pending: ${l.pending.map(p => p.path).join(', ')}`);
    if (l.unresolved.length) out.push(`- unresolved require(): ${l.unresolved.map(u => `${u.from} -> ${u.spec}`).join('; ')}`);
  }
  if (i.kitReplaced && i.kitReplaced.length) out.push('', `Previous pilot files whose local edits were replaced (old bytes are in the snapshot): ${i.kitReplaced.join(', ')}`);
  if (i.leftBehind && i.leftBehind.length) out.push('', `Files of the previous kit that the current kit no longer ships (left in place; the tool deletes nothing): ${i.leftBehind.join(', ')}`);
  out.push('', '## Checks in the target', '');
  if (!i.checks) out.push('Not run yet.');
  else {
    out.push(`- validate: ${i.checks.validate.ok ? 'OK' : 'FAILED'} (exit ${i.checks.validate.status}) ${i.checks.validate.summary}`);
    out.push(`- lint: ${i.checks.lint.ok ? 'OK' : 'FAILED'} (exit ${i.checks.lint.status}) ${i.checks.lint.result}`);
    if (i.checks.mcp) {
      out.push(`- mcp minimum (advisory): ${i.checks.mcp.summary}`);
    }
  }
  if (i.checks && i.checks.mcp && i.checks.mcp.servers) {
    out.push('', '## MCP minimum installation diagnostics (advisory)', '', '| server | inventory | pin | sandbox | network | schema-budget | runtime | status |', '|---|---|---|---|---|---|---|---|');
    for (const s of i.checks.mcp.servers) {
      out.push(`| ${s.id} | ${s.inventory} | ${s.pin} | ${s.sandbox} | ${s.network} | ${s.schemaBudget} | ${s.runtime} | ${s.status} |`);
    }
    out.push('', '*Note: MCP minimum diagnosis is strictly advisory; completion and verification gates never depend on MCP (PROTO-DEC-0170). Unavailable servers maintain identical completion semantics.*');
  }
  out.push('', '## Next steps and publication', '');
  out.push(`- Checklist for the user (doctor, browser logins, keys, the three mandatory MCP servers, recommender, .gitignore lines): ${NEXT_STEPS_REL}`);
  out.push(`- Keys wizard (one command asks for every key in turn, add or skip): node ${WIZARD_REL}`);
  out.push(`- The branch ${i.branch} holds the installed kernel, journals and launch records. Do NOT push it to a public repository. Nothing was pushed by this tool; the optional pre-push hook is docs/ops/pilot-kit/pre-push-guard.sample.`);
  out.push('', '## Undo', '');
  if (i.mode === 'update') out.push('```', `git revert --no-edit HEAD   # undo this update as a new commit on ${i.branch}: owner's decision, never run by the tool`, '```', '');
  else out.push('```', 'git checkout ' + i.oldBranch + '   # leave the pilot, keep its branch', `git branch -D ${i.branch}   # owner's decision, never run by the tool`, '```', '');
  return out.join('\n');
}

// ---- keys wizard offer ----
const terminalNow = () => !!(process.stdin.isTTY && process.stdout.isTTY);
const ttyOf = (io) => (typeof io.isTTY === 'function' ? !!io.isTTY() : io.isTTY !== undefined ? !!io.isTTY : terminalNow());
// One line from the terminal, synchronously (the installer itself is synchronous); an end of input is an empty answer.
function readLineSync() {
  const b = Buffer.alloc(1);
  let s = '';
  for (;;) {
    let n;
    try { n = fs.readSync(0, b, 0, 1, null); } catch (e) { if (e.code === 'EAGAIN') continue; if (e.code === 'EOF') break; throw e; }
    if (!n) break;
    const ch = b.toString('latin1');
    if (ch === '\n') break;
    if (ch !== '\r') s += ch;
  }
  return s;
}
const askYesNoDefault = (prompt) => { process.stdout.write(prompt); return readLineSync(); };
// The wizard path comes from the SECOND argument, the way offerKeysWizard (and an injected runner) is called: (target, relative path).
function runWizardDefault(target, rel) {
  const r = spawnSync(process.execPath, [rel || WIZARD_REL], { cwd: target, stdio: 'inherit' });
  return r.status === null ? 1 : r.status;
}
// After a REAL install only. One line names the exact command. With a terminal and --keys=ask (the default) it asks "Run the keys wizard now? [y/N]"
// (default N); --keys=yes runs it without asking; --keys=no only prints the line. Without a terminal nothing is ever asked. The wizard does not change
// the exit code of the install: it is the user's own step.
function offerKeysWizard(log, target, opts, io) {
  log('');
  log(`Keys wizard (asks for every key of the project in turn, add or skip; a value is typed at a hidden prompt and never shown): node ${WIZARD_REL}`);
  if (opts.keys === 'no') return 'no';
  if (!ttyOf(io)) { log('keys wizard: no terminal, so it was not offered interactively; run the command above in your own terminal.'); return 'no-terminal'; }
  let run = opts.keys === 'yes';
  if (!run) run = /^y(es)?$/i.test(String((io.askYesNo || askYesNoDefault)('Run the keys wizard now? [y/N] ') || '').trim());
  if (!run) { log('keys wizard: not run now; the command above starts it later.'); return 'declined'; }
  if (!fs.existsSync(path.join(target, WIZARD_REL))) { log(`keys wizard: ${WIZARD_REL} is not in the target; run pilot-install again.`); return 'missing'; }
  const code = (io.runWizard || runWizardDefault)(target, WIZARD_REL);
  log(`keys wizard: finished with exit ${code} (the result of the install above is not changed by it)`);
  return 'ran';
}

// ---- main ----
function main(argv, io = { log: s => process.stdout.write(`${s}\n`) }) {
  const log = io.log;
  let opts;
  try { opts = parseArgs(argv); } catch (e) { log(`usage error: ${e.message}`); return 2; }
  if (opts.update) return mainUpdate(opts, log);
  const target = path.resolve(opts.target);
  const branch = opts.branch || defaultBranch();
  if (!opts.dryRun && opts.keys === 'yes' && !ttyOf(io)) {
    log('REFUSED R12: --keys=yes runs the keys wizard and needs a terminal (stdin and stdout must be a TTY); nothing was changed. Use --keys=no and run the wizard yourself.');
    return 2;
  }
  let pre;
  let plan;
  try {
    pre = preflight(target, branch);
    plan = loadKitPlan();
    const coll = kitCollisions(target, plan);
    if (coll.foreign.length) {
      throw new Refusal('R11', `the pilot kit would overwrite ${coll.foreign.length} file(s) the project owns (not a managed protocol file, not from an earlier pilot install): ${coll.foreign.slice(0, 12).join(', ')}. Move them aside or rename them in the project, then run again.`);
    }
    plan.replaced = coll.replaced;
  } catch (e) {
    if (e instanceof Refusal) { log(`REFUSED ${e.id}: ${e.message}`); return 2; }
    throw e;
  }
  const source = sourceInfo();
  log(`pilot-install: source ${SOURCE} @ ${source.sha}${source.dirty ? ' (dirty)' : ''}`);
  log(`pilot-install: target ${target} (${pre.oldBranch} @ ${pre.oldHead.slice(0, 9)}) -> new branch ${branch}`);

  // What the installer would change, from its own read-only check.
  const verify = nodeRun(SOURCE, [SETUP, '--Target', target, '--Verify']);
  const verifyLines = verify.out.split(/\r?\n/).filter(l => l.startsWith('[!=]'));
  const differs = verifyLines.map(l => /^\[!=\] Managed file differs: (.+)$/.exec(l)).filter(Boolean).map(m => m[1]);

  if (opts.dryRun) {
    log('dry-run: the installer reports these differences (it would update them with --Force):');
    for (const l of verifyLines.slice(0, 60)) log(`  ${l}`);
    if (!verifyLines.length) log('  none');
    log(`dry-run: kit ${plan.def.destination}/ would get ${plan.closure.files.length + plan.def.templates.length} file(s) plus KIT-MANIFEST.json`);
    for (const f of plan.closure.files) log(`  src/${f}`);
    for (const t of plan.def.templates) log(`  ${path.basename(t)}`);
    log(`dry-run: pending (absent on this checkout): ${plan.closure.pending.length ? plan.closure.pending.map(p => p.path).join(', ') : 'none'}`);
    for (const g of plan.groups) {
      log(`dry-run: layer ${g.id.toUpperCase()}: ${g.files.length} file(s) at their repo-relative paths${g.pending.length ? `, pending: ${g.pending.map(p => p.path).join(', ')}` : ''}`);
      for (const f of g.files) log(`  ${f}${fs.existsSync(path.join(target, f)) ? '' : '  (new)'}`);
      for (const k of g.skeletons) log(`  skeleton ${k.path}: ${fs.existsSync(path.join(target, k.path)) ? 'would be kept (present)' : 'would be created'}`);
    }
    if (plan.replaced.length) log(`dry-run: previous pilot files with local edits that would be replaced (snapshotted first): ${plan.replaced.join(', ')}`);
    log(`dry-run: would create branch ${branch}, restore marker blocks, write ${REPORT_REL}, run validate and lint, then ${opts.noCommit ? 'stop before git add (--no-commit)' : 'commit'}`);
    log(`dry-run: the checklist for the user would be written to ${NEXT_STEPS_REL} and printed at the end`);
    log(`dry-run: at the end of a real install the keys wizard (node ${WIZARD_REL}) is offered (--keys=${opts.keys}); nothing is asked in a dry run`);
    log('dry-run: no change was made');
    printPublicGuard(log, plan.guardBlock, branch);
    return 0;
  }

  // 1. snapshot
  const { snapDir, oldText } = takeSnapshot(log, target, branch, [...differs, ...plan.replaced]);

  // 2. branch, then the installer
  git(target, 'checkout', '-q', '-b', branch);
  log(`branch: created ${branch} from ${pre.oldBranch}`);
  const install = nodeRun(SOURCE, [SETUP, '--Target', target, '--Force']);
  const installLines = install.out.split(/\r?\n/).filter(l => /^(Done:|Previous versions saved to:|\[error\]|\d+ difference)/.test(l));
  const backupLine = (installLines.find(l => l.startsWith('Previous versions saved to:')) || '').replace('Previous versions saved to: ', '');
  if (install.status !== 0) {
    log(`install: FAILED (exit ${install.status})`);
    for (const l of install.out.split(/\r?\n/).filter(Boolean).slice(-15)) log(`  ${l}`);
    return failedOut(log, target, branch, pre, snapDir, plan);
  }
  log(`install: OK ${installLines.find(l => l.startsWith('Done:')) || ''}`);

  // 3. project-owned content
  const { restored, groups } = restoreInstructions(log, target, oldText);

  // 4. kit
  const kit = installKit(target, plan, source);
  log(`kit: ${kit.files.length} file(s) in ${kit.dir}/, pending: ${kit.pending.length ? kit.pending.map(p => p.path).join(', ') : 'none'}`);
  for (const l of kit.layers) log(`layer ${l.id.toUpperCase()}: ${l.files.length} file(s), skeletons ${l.skeletons.map(k => `${k.path.split('/').pop()}=${k.action}`).join(', ') || 'none'}${l.pending.length ? `, pending: ${l.pending.map(p => p.path).join(', ')}` : ''}`);

  // 5. report, checks, final report
  const info = { date: new Date().toISOString(), source, target, branch, oldBranch: pre.oldBranch, oldHead: pre.oldHead, snapDir, backupLine, installLines, restored, groups, kit, kitReplaced: plan.replaced, checks: null };
  const reportFile = path.join(target, REPORT_REL);
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, renderReport(info), 'utf8');
  const checks = runChecks(target);
  info.checks = checks;
  fs.writeFileSync(reportFile, renderReport(info), 'utf8');
  log(`validate: ${checks.validate.ok ? 'OK' : 'FAILED'} (exit ${checks.validate.status}) ${checks.validate.summary}`);
  log(`lint: ${checks.lint.ok ? 'OK' : 'FAILED'} (exit ${checks.lint.status}) ${checks.lint.result}`);
  if (!checks.validate.ok || !checks.lint.ok) {
    for (const l of checks.validate.fails) log(`  ${l}`);
    if (!checks.validate.ok && !checks.validate.fails.length) for (const l of checks.validate.tail) log(`  ${l}`);
    if (!checks.lint.ok) for (const l of checks.lint.tail) log(`  ${l}`);
    return failedOut(log, target, branch, pre, snapDir, plan);
  }

  // 6. commit
  if (opts.noCommit) {
    log(`no-commit: the changes are in the working tree of ${target} on branch ${branch}, nothing is staged.`);
    undoLines(log, target, branch, pre, snapDir, false);
    printNextSteps(log, target);
    offerKeysWizard(log, target, opts, io);
    printPublicGuard(log, plan.guardBlock, branch);
    return 0;
  }
  git(target, 'add', '-A');
  const msgFile = path.join(snapDir, 'COMMIT-MESSAGE.txt');
  fs.writeFileSync(msgFile, [
    `chore(protocol): pilot install of the kernel with the L4, L5 and L6 pilot kit (${branch})`, '',
    `Installed with docs/ops/pilot-install.cjs from the protocol source @ ${source.sha}${source.dirty ? ' (working tree dirty)' : ''}.`,
    `Branch ${branch} was created from ${pre.oldBranch} @ ${pre.oldHead}.`,
    `Project marker blocks restored: ${restored.map(r => `${r.file}: ${r.names.join(', ') || 'none'}`).join('; ') || 'none'}.`,
    `Report: ${REPORT_REL}. Kit: ${kit.dir}/ (${kit.files.length} files, pending: ${kit.pending.map(p => p.path).join(', ') || 'none'}); layers: ${kit.layers.map(l => `${l.id.toUpperCase()}=${l.files.length}`).join(', ') || 'none'}.`, ''].join('\n'), 'utf8');
  const commit = gitCmd(target, ['commit', '-q', '-F', msgFile]);
  if (commit.status !== 0) {
    log(`commit: FAILED ${(commit.stderr || commit.stdout).replace(/\s+/g, ' ')}`);
    return failedOut(log, target, branch, pre, snapDir, plan);
  }
  const head = git(target, 'rev-parse', 'HEAD');
  log(`commit: ${head.slice(0, 9)} on ${branch}`);
  log(`Done on branch ${branch} (commit ${head.slice(0, 9)}), from ${pre.oldBranch} @ ${pre.oldHead.slice(0, 9)}. Nothing was pushed.`);
  undoLines(log, target, branch, pre, snapDir, true);
  printNextSteps(log, target);
  offerKeysWizard(log, target, opts, io);
  printPublicGuard(log, plan.guardBlock, branch);
  return 0;
}

// The old instruction and integration files (plus `extra`) are copied into an OS-temp snapshot before anything is written. Never deleted by the tool.
function takeSnapshot(log, target, branch, extra) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const snapDir = path.join(os.tmpdir(), `pilot-install-${branch.replace(/[^A-Za-z0-9._-]/g, '_')}-${stamp}-${crypto.randomBytes(3).toString('hex')}`);
  const snapFiles = [...new Set([...INSTRUCTION_FILES, ...INTEGRATION_FILES, ...extra])].filter(f => fs.existsSync(path.join(target, f)) && fs.statSync(path.join(target, f)).isFile());
  for (const f of snapFiles) {
    fs.mkdirSync(path.dirname(path.join(snapDir, f)), { recursive: true });
    fs.copyFileSync(path.join(target, f), path.join(snapDir, f));
  }
  log(`snapshot: ${snapDir}`);
  log(`snapshot files: ${snapFiles.length}`);
  const oldText = {};
  for (const f of INSTRUCTION_FILES) oldText[f] = fs.existsSync(path.join(snapDir, f)) ? readStrict(path.join(snapDir, f)) : null;
  return { snapDir, oldText };
}
// After the installer: the project's marker blocks are put back and every other line that went away is grouped for the report.
function restoreInstructions(log, target, oldText) {
  const historic = historicLines();
  const restored = [];
  const groups = [];
  for (const f of INSTRUCTION_FILES) {
    const full = path.join(target, f);
    if (oldText[f] === null || !fs.existsSync(full)) continue;
    const fresh = readStrict(full);
    const r = restoreBlocks(oldText[f], fresh);
    if (r.restored.length) fs.writeFileSync(full, r.text, 'utf8');
    restored.push({ file: f, names: r.restored });
    // blocks that are back, or identical in the new text, are not "lost"; a block the new text carries with other content stays in the diff.
    // They are excluded by line index, so the numbers in the report stay the numbers of the original file.
    const before = toLf(oldText[f]);
    const now = toLf(r.text);
    const excluded = blockLines(before, parseBlocks(before).filter(b => now.includes(b.text)));
    groups.push({ file: f, groups: removedGroups(before, now, historic, excluded) });
    log(`restore: ${f}: blocks restored ${r.restored.length ? r.restored.join(', ') : 'none'}; removed line groups ${groups[groups.length - 1].groups.length}`);
  }
  const candidates = groups.reduce((n, g) => n + g.groups.filter(x => x.kind === 'project-specific candidate').length, 0);
  if (candidates) log(`WARNING: ${candidates} project-specific candidate group(s) were removed from CLAUDE.md/AGENTS.md; they are listed with the exact lines in ${REPORT_REL}. Review them.`);
  return { restored, groups };
}

// ---- update mode ----
// --update: on the checked-out kernel-pilot-* branch, with a clean tree, re-run the installer (managed files are replaced when their bytes
// differ from this checkout, with its own backups), restore the project's marker blocks, re-install the kit and the layers (skeletons are
// never overwritten, project files are refused by R11), run the target's checks and commit everything as ONE change. A run that changes
// nothing commits nothing and says so. A failure or an interruption leaves the branch without a new commit and prints what to do.
const UPDATE_SUBJECT = sha => `chore(protocol): update the pilot kit to ${sha}`;
function mainUpdate(opts, log) {
  const target = path.resolve(opts.target);
  let pre;
  let plan;
  try {
    pre = preflight(target, null, true);
    plan = loadKitPlan();
    const coll = kitCollisions(target, plan);
    if (coll.foreign.length) {
      throw new Refusal('R11', `the pilot kit would overwrite ${coll.foreign.length} file(s) the project owns (not a managed protocol file, not from an earlier pilot install): ${coll.foreign.slice(0, 12).join(', ')}. Move them aside or rename them in the project, then run again.`);
    }
    plan.replaced = coll.replaced;
  } catch (e) {
    if (e instanceof Refusal) { log(`REFUSED ${e.id}: ${e.message}`); return 2; }
    throw e;
  }
  const branch = pre.oldBranch;
  const source = sourceInfo();
  const prev = previousKit(target, plan);
  const newLayerFiles = new Set(plan.groups.flatMap(g => g.files));
  const leftBehind = prev ? [...prev.layerFiles].filter(f => !newLayerFiles.has(f)).sort() : [];
  log(`pilot-install --update: source ${SOURCE} @ ${source.sha}${source.dirty ? ' (dirty)' : ''}`);
  log(`pilot-install --update: target ${target} on ${branch} @ ${pre.oldHead.slice(0, 9)}; kit installed there: ${prev ? prev.sourceSha : 'none (first kit on this branch)'}`);

  const verify = nodeRun(SOURCE, [SETUP, '--Target', target, '--Verify']);
  const verifyLines = verify.out.split(/\r?\n/).filter(l => l.startsWith('[!=]'));
  const differs = verifyLines.map(l => /^\[!=\] Managed file differs: (.+)$/.exec(l)).filter(Boolean).map(m => m[1]);

  if (opts.dryRun) {
    const other = verifyLines.filter(l => !INSTRUCTION_FILES.some(f => l.endsWith(`: ${f}`)));
    log(`dry-run: the installer would update ${other.length} managed or integration file(s)${other.length ? ':' : ''}`);
    for (const l of other.slice(0, 60)) log(`  ${l}`);
    log(`dry-run: ${INSTRUCTION_FILES.join(' and ')} are re-applied with the project's marker blocks restored byte for byte`);
    let changes = 0;
    for (const g of plan.groups) {
      const rows = [];
      for (const f of g.files) {
        const full = path.join(target, f);
        if (!fs.existsSync(full)) rows.push(`  ${f}  (new)`);
        else if (!fs.readFileSync(full).equals(fs.readFileSync(path.join(SOURCE, f)))) rows.push(`  ${f}  (changed)`);
      }
      changes += rows.length;
      log(`dry-run: layer ${g.id.toUpperCase()}: ${rows.length} of ${g.files.length} file(s) would change`);
      for (const r of rows) log(r);
      for (const k of g.skeletons) log(`  skeleton ${k.path}: ${fs.existsSync(path.join(target, k.path)) ? 'kept (never overwritten)' : 'would be created'}`);
    }
    const kitRows = [...plan.closure.files.map(f => ({ rel: path.join('src', f), src: f })), ...plan.def.templates.map(t => ({ rel: path.basename(t), src: t }))]
      .filter(x => { const full = path.join(target, plan.def.destination, x.rel); return !fs.existsSync(full) || !fs.readFileSync(full).equals(fs.readFileSync(path.join(SOURCE, x.src))); });
    changes += kitRows.length;
    log(`dry-run: kit ${plan.def.destination}/: ${kitRows.length} file(s) would change; KIT-MANIFEST.json sourceSha ${prev ? prev.sourceSha : 'none'} -> ${source.sha}`);
    for (const x of kitRows) log(`  ${x.rel.split(path.sep).join('/')}`);
    if (leftBehind.length) log(`dry-run: no longer in the kit (would be left in place, nothing is deleted): ${leftBehind.join(', ')}`);
    if (plan.replaced.length) log(`dry-run: previous pilot files with local edits that would be replaced (snapshotted first): ${plan.replaced.join(', ')}`);
    const same = changes === 0 && other.length === 0 && prev && prev.sourceSha === source.sha;
    log(same ? `dry-run: nothing to update: the kit on ${branch} is already at ${source.sha}` : `dry-run: would run validate and lint, then commit "${UPDATE_SUBJECT(source.sha)}" on ${branch}`);
    log('dry-run: no change was made');
    printPublicGuard(log, plan.guardBlock, branch);
    return 0;
  }

  const { snapDir, oldText } = takeSnapshot(log, target, branch, [...differs, ...plan.replaced]);
  let installLines = [];
  let backupLine = '';
  let restored = [];
  let groups = [];
  let kit;
  try {
    const install = nodeRun(SOURCE, [SETUP, '--Target', target, '--Force']);
    installLines = install.out.split(/\r?\n/).filter(l => /^(Done:|Previous versions saved to:|\[error\]|\d+ difference)/.test(l));
    backupLine = (installLines.find(l => l.startsWith('Previous versions saved to:')) || '').replace('Previous versions saved to: ', '');
    if (install.status !== 0) {
      log(`install: FAILED (exit ${install.status})`);
      for (const l of install.out.split(/\r?\n/).filter(Boolean).slice(-15)) log(`  ${l}`);
      return failedUpdate(log, target, branch, pre, snapDir, plan);
    }
    log(`install: OK ${installLines.find(l => l.startsWith('Done:')) || ''}`);
    ({ restored, groups } = restoreInstructions(log, target, oldText));
    kit = installKit(target, plan, source);
  } catch (e) {
    log(`INTERRUPTED: the update stopped before its commit: ${e.message}`);
    return failedUpdate(log, target, branch, pre, snapDir, plan);
  }
  log(`kit: ${kit.files.length} file(s) in ${kit.dir}/, pending: ${kit.pending.length ? kit.pending.map(p => p.path).join(', ') : 'none'}`);
  for (const l of kit.layers) log(`layer ${l.id.toUpperCase()}: ${l.files.length} file(s), skeletons ${l.skeletons.map(k => `${k.path.split('/').pop()}=${k.action}`).join(', ') || 'none'}`);

  const changed = git(target, 'status', '--porcelain=v1');
  if (!changed) {
    log(`update: nothing to change: the kit on ${branch} is already at ${source.sha}; no commit was made.`);
    printPublicGuard(log, plan.guardBlock, branch);
    return 0;
  }
  log(`update: ${changed.split('\n').length} path(s) changed`);
  const info = { mode: 'update', previousKitVersion: prev ? prev.sourceSha : '', leftBehind, date: new Date().toISOString(), source, target, branch, oldBranch: pre.oldBranch, oldHead: pre.oldHead, snapDir, backupLine, installLines, restored, groups, kit, kitReplaced: plan.replaced, checks: null };
  const reportFile = path.join(target, REPORT_REL);
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, renderReport(info), 'utf8');
  const checks = runChecks(target);
  info.checks = checks;
  fs.writeFileSync(reportFile, renderReport(info), 'utf8');
  log(`validate: ${checks.validate.ok ? 'OK' : 'FAILED'} (exit ${checks.validate.status}) ${checks.validate.summary}`);
  log(`lint: ${checks.lint.ok ? 'OK' : 'FAILED'} (exit ${checks.lint.status}) ${checks.lint.result}`);
  if (!checks.validate.ok || !checks.lint.ok) {
    for (const l of checks.validate.fails) log(`  ${l}`);
    if (!checks.validate.ok && !checks.validate.fails.length) for (const l of checks.validate.tail) log(`  ${l}`);
    if (!checks.lint.ok) for (const l of checks.lint.tail) log(`  ${l}`);
    return failedUpdate(log, target, branch, pre, snapDir, plan);
  }
  git(target, 'add', '-A');
  const msgFile = path.join(snapDir, 'COMMIT-MESSAGE.txt');
  fs.writeFileSync(msgFile, [
    UPDATE_SUBJECT(source.sha), '',
    `Updated with docs/ops/pilot-install.cjs --update from the protocol source @ ${source.sha}${source.dirty ? ' (working tree dirty)' : ''}.`,
    `Kit version: ${prev ? prev.sourceSha : 'none'} -> ${source.sha}. Branch ${branch} was at ${pre.oldHead}.`,
    `Project marker blocks restored: ${restored.map(r => `${r.file}: ${r.names.join(', ') || 'none'}`).join('; ') || 'none'}.`,
    `Report: ${REPORT_REL}. Kit: ${kit.dir}/ (${kit.files.length} files); layers: ${kit.layers.map(l => `${l.id.toUpperCase()}=${l.files.length}`).join(', ') || 'none'}.`,
    ...(leftBehind.length ? [`No longer in the kit, left in place: ${leftBehind.join(', ')}.`] : []), ''].join('\n'), 'utf8');
  const commit = gitCmd(target, ['commit', '-q', '-F', msgFile]);
  if (commit.status !== 0) {
    log(`commit: FAILED ${(commit.stderr || commit.stdout).replace(/\s+/g, ' ')}`);
    return failedUpdate(log, target, branch, pre, snapDir, plan);
  }
  const head = git(target, 'rev-parse', 'HEAD');
  log(`commit: ${head.slice(0, 9)} on ${branch}`);
  log(`Done: the pilot kit on ${branch} is updated to ${source.sha} (commit ${head.slice(0, 9)}, one change on top of ${pre.oldHead.slice(0, 9)}). Nothing was pushed.`);
  log('Undo (inside the target, owner\'s decision, never run by this tool):');
  log(`  git revert --no-edit ${head.slice(0, 9)}`);
  log(`  old CLAUDE.md/AGENTS.md and the other replaced files: ${snapDir}`);
  log(`The checklist for the user is in ${NEXT_STEPS_REL} of the target.`);
  printPublicGuard(log, plan.guardBlock, branch);
  return 0;
}
function failedUpdate(log, target, branch, pre, snapDir, plan) {
  log(`The update on ${branch} is left UNCOMMITTED in ${target}: the branch has NO new commit (HEAD is still ${pre.oldHead.slice(0, 9)}); the working tree holds the partial update. Nothing was pushed or deleted.`);
  log('  inspect:            git status   and   git diff');
  log('  set the update aside (recoverable, the owner decides): git stash push -u -m pilot-update-failed');
  log(`  then run again:     node ${path.join(SOURCE, 'docs', 'ops', 'pilot-install.cjs')} --target ${target} --update`);
  log(`  old files:          ${snapDir}`);
  printPublicGuard(log, plan.guardBlock, branch);
  return 1;
}

function undoLines(log, target, branch, pre, snapDir, committed) {
  log('Undo / next (run inside the target repository):');
  log(`  git checkout ${pre.oldBranch}        # leave the pilot, the branch stays`);
  log(`  git checkout ${branch}   # come back to it`);
  log(`  git branch -D ${branch}   # delete it: the owner's decision, NOT run by this tool`);
  if (!committed) log('  git add -A && git commit        # to keep the result');
  log(`  old CLAUDE.md/AGENTS.md and the other replaced files: ${snapDir}`);
  log('  the tool never pushes; publishing the pilot branch is yours.');
}
function failedOut(log, target, branch, pre, snapDir, plan) {
  log(`The pilot branch ${branch} is left UNCOMMITTED in ${target}. Nothing was pushed or deleted.`);
  log('  inspect:            git status');
  log(`  set the work aside: git stash push -u -m pilot-install-failed   then   git checkout ${pre.oldBranch}`);
  log(`  old files:          ${snapDir}`);
  printPublicGuard(log, plan.guardBlock, branch);
  return 1;
}

if (require.main === module) {
  let code;
  try { code = main(process.argv.slice(2)); } catch (e) { process.stdout.write(`pilot-install: unexpected error: ${e.message}\n`); code = 1; }
  process.exitCode = code;
}

// FEATURES: what this version of the tool accepts, read by docs/ops/fleet/fleet.cjs before it passes a flag through.
const FEATURES = ['update', 'keys'];
module.exports = { runChecks, renderReport, WIZARD_REL, KEYS_MODES, offerKeysWizard, runWizardDefault, main, gitCmd, publicGuardBlock, NEXT_STEPS_REL, parseBlocks, unparsedMarkers, blockLines, restoreBlocks, removedGroups, closure, defaultBranch, safeRel, FORBIDDEN_GIT, PILOT_PREFIX, REPORT_REL, FEATURES, kitSourcePaths, kitTargetPaths, UPDATE_SUBJECT };

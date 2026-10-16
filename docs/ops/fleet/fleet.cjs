#!/usr/bin/env node
'use strict';
// fleet: the fleet of projects that carry the kernel (PROTO-DEC-0177, owner ). One registry (docs/ops/fleet/projects.json, schema
// fleet/1), one tool to add, pull, set up and update every project on every machine. Class B tooling. Contract: .
//   node docs/ops/fleet/fleet.cjs list [--json]
//   node docs/ops/fleet/fleet.cjs status [--project p] [--json]
//   node docs/ops/fleet/fleet.cjs add <url> [--name n] [--visibility public|private] [--kernel-remote url] [--plan]
//   node docs/ops/fleet/fleet.cjs pull-all [--project p] [--plan]
//   node docs/ops/fleet/fleet.cjs setup <project> [--keys ask|yes|no] [--plan]
//   node docs/ops/fleet/fleet.cjs update-kit <project> [--plan]
//   node docs/ops/fleet/fleet.cjs push-pilots [--project p] [--plan]
//   node docs/ops/fleet/fleet.cjs kernel-check [--project p]
//   node docs/ops/fleet/fleet.cjs doctor
// Common flags: --registry <file> (default: projects.json next to this tool), --root <dir> (default: environment COLABS_PILOTS_ROOT, else
// <home>/ColabsPilots), --factory <dir> (default: the checkout holding this tool), --machine <id> (default: environment COLABS_MACHINE_ID, else the
// host name, lower case).
// Exit 0 done (or nothing to do), 1 a project failed or needs the owner, 2 refused or bad usage. Every command that changes anything takes --plan
// (prints what it would do, changes nothing) and the real run prints one outcome line per project.
// SAFETY: the tool never writes into a working copy that holds uncommitted or untracked files, never touches a path the registry marks as an
// owner working copy, runs git only through an allow-list (no reset, clean, stash, rebase, gc, file checkout, force push, merge other than
// --ff-only), fast-forwards only, deletes nothing, and pushes a kernel-pilot-* branch only to the registered kernel remote after BOTH the
// registry and a read-only visibility probe say private. The probe is injected in tests; production asks `gh repo view`, and refuses to do so
// under node --test. Round 1 rules (review of 2026-10-09): a clone that is busy (index.lock, merge, rebase...) is refused before any write; setup and
// update-kit refuse a kit write onto a path the project's ignore rules cover (ignored files are local work no commit holds); no command moves HEAD
// of a clone that is detached or on a branch it is not documented to act on (update-kit never switches branches); the visibility probe is asked
// about the URL the clone will really push to. ASCII-only source on purpose (non-ASCII folder names come from the registry as \u escapes).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { safeMachineId } = require('../ops-guard.cjs');

const SCHEMA = 'fleet/1';
const STATES = ['none', 'base', 'kit', 'needs-owner', 'owner-working'];
const VISIBILITY = ['public', 'private'];
const REMOTE_VISIBILITY = ['public', 'private', 'unknown'];
const repoPaths = require('../../../.ai/bin/repo-paths.cjs');
const PILOT_PREFIX = 'kernel-pilot-';
const DEFAULT_ROOT = repoPaths.pilotsDir();
const DEFAULT_FACTORY = path.resolve(__dirname, '..', '..', '..');
const DEFAULT_REGISTRY = path.join(__dirname, 'projects.json');
const PROJECT_KEYS = ['name', 'url', 'visibility', 'defaultBranch', 'kernelRemote', 'pilotBranchPrefix', 'kernelBranch', 'state', 'kitVersion', 'paths', 'ownerWorking', 'needsOwner', 'notes'];
const KIT_MANIFEST = 'docs/ops/pilot-kit/KIT-MANIFEST.json';
const HOOK_SAMPLE = 'docs/ops/pilot-kit/pre-push-guard.sample';

class Refusal extends Error {}
// A git command that was allowed and ran, and failed: carries the folder it ran in so the report can name it.
class GitFailure extends Error { constructor(message, cwd) { super(message); this.cwd = cwd; } }

// ---- git, through an allow-list ----
const ALLOWED_GIT = new Set(['clone', 'fetch', 'push', 'remote', 'status', 'rev-parse', 'rev-list', 'symbolic-ref', 'for-each-ref', 'branch', 'checkout', 'merge',
  'update-ref', 'merge-base', 'show', 'config', 'add', 'commit', 'check-ref-format', 'check-ignore', 'version']);
// A remote name or a registry name: starts with a letter or digit (never a dash, so git cannot read it as an option), no .., not ending in a dot or .lock.
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const safeName = s => typeof s === 'string' && SAFE_NAME.test(s) && !s.includes('..') && !/\.$/.test(s) && !/\.lock$/i.test(s) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(s);
// A branch name as the registry may hold it: the same, with / allowed between safe parts.
const safeBranch = s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._\/-]*$/.test(s) && !s.includes('..') && !s.includes('//') && !/[\/.]$/.test(s) && !/\.lock(\/|$)/i.test(s);
// Options that run a program, read another repository's configuration or move the repository: never passed to git by this tool.
const DANGEROUS_OPTION = /^(-c|-C|--config|--config-env(=.*)?|--config=.*|--upload-pack(=.*)?|--receive-pack(=.*)?|--exec(=.*)?|--exec-path(=.*)?|--work-tree(=.*)?|--namespace(=.*)?|--template(=.*)?|--separate-git-dir(=.*)?|--super-prefix(=.*)?|--recurse-submodules(=.*)?|--ext-diff|--textconv)$/;
// Throws before spawning when a call is outside what this tool may ever do.
function checkGit(args) {
  let i = 0;
  while (i < args.length && String(args[i]).startsWith('-')) {
    if (args[i] !== '--no-optional-locks') throw new Error(`fleet: the git option ${args[i]} before the subcommand is not allowed (no -c, --config-env, -C, --git-dir, --work-tree, --exec-path)`);
    i++;
  }
  const sub = args[i] === undefined ? '' : String(args[i]);
  const rest = args.slice(i + 1).map(String);
  if (!ALLOWED_GIT.has(sub)) throw new Error(`fleet: git ${sub || '(none)'} is not allowed`);
  const dd = rest.indexOf('--');
  const before = dd < 0 ? rest : rest.slice(0, dd);
  const bad = before.find(a => DANGEROUS_OPTION.test(a) || ((sub === 'clone' || sub === 'fetch') && /^-u/.test(a)));
  if (bad) throw new Error(`fleet: the git option ${bad} is not allowed (it runs a program or reads other configuration)`);
  const has = (...flags) => rest.some(a => flags.includes(a) || flags.some(f => f.endsWith('=') && a.startsWith(f)));
  if (sub === 'push' && (has('--force', '-f', '--force-with-lease=', '--force-with-lease', '--mirror', '--delete', '-d', '--prune', '--all', '--tags', '--no-verify') || rest.some(a => a.startsWith('+') || a.startsWith(':')))) throw new Error('fleet: a forced, deleting or hook-skipping push is not allowed');
  // the only push this tool makes: push --set-upstream <remote> refs/heads/<kernel-pilot-x>:refs/heads/<kernel-pilot-x> (the same name on both sides)
  if (sub === 'push') {
    const m = rest.length === 3 && rest[0] === '--set-upstream' && SAFE_NAME.test(rest[1]) && /^refs\/heads\/(kernel-pilot-[A-Za-z0-9._\/-]+):refs\/heads\/(kernel-pilot-[A-Za-z0-9._\/-]+)$/.exec(rest[2]);
    if (!m || m[1] !== m[2] || !safeBranch(m[1])) throw new Error('fleet: a push other than  push --set-upstream <remote> refs/heads/<kernel-pilot-x>:refs/heads/<kernel-pilot-x>  is not allowed');
  }
  if (sub === 'fetch' && (has('--prune', '-p', '--force', '-f') || rest.some(a => a.startsWith('+')))) throw new Error('fleet: fetch with prune or force is not allowed');
  if (sub === 'fetch' && !(rest.length === 2 && rest[0] === '-q' && SAFE_NAME.test(rest[1]))) throw new Error('fleet: a fetch other than  fetch -q <remote>  is not allowed');
  if (sub === 'clone' && !(rest.length === 4 && rest[0] === '--no-hardlinks' && rest[1] === '--' && !rest[2].startsWith('-') && !rest[3].startsWith('-'))) throw new Error('fleet: a clone other than  clone --no-hardlinks -- <url> <dir>  is not allowed');
  if (sub === 'check-ignore' && !(rest[0] === '--' && rest.length > 1)) throw new Error('fleet: check-ignore other than  check-ignore -- <paths>  is not allowed');
  if (sub === 'commit' && has('-c', '-C', '--reuse-message', '--reedit-message', '--fixup', '--squash', '--amend', '--no-verify', '-n')) throw new Error('fleet: commit options other than -q -m <message> are not allowed');
  if (sub === 'merge' && !has('--ff-only')) throw new Error('fleet: a merge other than --ff-only is not allowed');
  // checkout: only `checkout -q -b <new> [<start>]` or `checkout -q <branch> --` (the trailing -- makes git read <branch> as a revision, never a path)
  if (sub === 'checkout') {
    const names = rest.filter(a => !a.startsWith('-'));
    const okNew = rest.includes('-b') && names.length >= 1 && names.length <= 2 && !rest.includes('--');
    const okSwitch = !rest.includes('-b') && names.length === 1 && rest[rest.length - 1] === '--' && rest.indexOf('--') === rest.length - 1;
    if ((!okNew && !okSwitch) || has('-f', '--force', '-B', '--orphan', '-p', '--patch', '--detach')) throw new Error('fleet: checkout of files or a forced checkout is not allowed');
  }
  if (sub === 'branch' && has('-d', '-D', '--delete', '-f', '--force', '-m', '-M', '--move', '-c', '-C', '--copy', '--set-upstream-to=', '-u', '--unset-upstream', '--edit-description')) throw new Error('fleet: deleting, moving, copying or re-pointing a branch is not allowed (only listing or creating)');
  if (sub === 'remote' && !['add', 'get-url'].includes(rest[0])) throw new Error('fleet: a remote command other than add and get-url is not allowed');
  if (sub === 'remote' && rest[0] === 'add' && !(rest.length === 3 && SAFE_NAME.test(rest[1]) && !rest[2].startsWith('-'))) throw new Error('fleet: a remote add other than  remote add <name> <url>  (a name that starts with a letter or digit) is not allowed');
  if (sub === 'remote' && rest[0] === 'get-url' && !(rest.length >= 2 && rest.slice(1, -1).every(a => a === '--push' || a === '--all') && SAFE_NAME.test(rest[rest.length - 1]))) throw new Error('fleet: a remote get-url other than  remote get-url [--push] [--all] <name>  is not allowed');
  if (sub === 'update-ref' && (rest.length !== 3 || !rest[0].startsWith('refs/heads/') || has('-d', '--stdin', '--no-deref'))) throw new Error('fleet: update-ref without <refs/heads/x> <new> <old> is not allowed');
  if (sub === 'config' && (!['--get', '--get-all'].includes(rest[0]) || rest.length !== 2)) throw new Error('fleet: writing git config is not allowed (only config --get <key>)');
}
// --no-optional-locks: a read such as `git status` never rewrites the index of a repository it only looks at.
function gitRun(cwd, args, env) {
  checkGit(args);
  const r = spawnSync('git', ['--no-optional-locks', ...args], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, env: env || process.env });
  return { status: r.status === null ? 1 : r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
function gitOk(cwd, ...args) {
  const r = gitRun(cwd, args);
  if (r.status !== 0) throw new GitFailure(`git ${args.join(' ')} failed: ${(r.err || r.out).replace(/\s+/g, ' ')}`, cwd);
  return r.out;
}

// ---- small helpers ----
const norm = p => { const r = path.resolve(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
function inside(child, parent) { const rel = path.relative(norm(parent), norm(child)); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); }
function strictlyInside(child, parent) { const rel = path.relative(norm(parent), norm(child)); return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel); }
const normUrl = u => String(u || '').trim().replace(/\/+$/, '').replace(/\.git$/i, '').replace(/^git[@]github[.]com:/i, 'https://github.com/').toLowerCase();
const short = s => (s ? String(s).slice(0, 9) : 'none');
function utcDate(now) { return now.toISOString().slice(0, 10).replace(/-/g, ''); }
const slug = name => name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
function githubRepo(url) {
  const m = /^(?:https:\/\/github\.com\/|git[@]github[.]com:|ssh:\/\/git[@]github[.]com\/)([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(String(url || '').trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}
// The registry file is kept ASCII: every non-ASCII character is written as a \u escape (JSON reads it back unchanged).
function asciiJson(obj) { return `${JSON.stringify(obj, null, 2).replace(/[\u007f-\uffff]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}\n`; }

// ---- the registry ----
function validateRegistry(reg) {
  const p = [];
  if (!reg || typeof reg !== 'object' || Array.isArray(reg)) return ['the registry is not a JSON object'];
  if (reg.schema !== SCHEMA) p.push(`schema must be "${SCHEMA}" (got ${JSON.stringify(reg.schema)})`);
  for (const k of Object.keys(reg)) if (!['schema', 'comment', 'projects'].includes(k)) p.push(`unknown top-level key "${k}"`);
  if (!Array.isArray(reg.projects)) { p.push('projects must be an array'); return p; }
  const names = new Set();
  reg.projects.forEach((x, i) => {
    const at = `projects[${i}]${x && typeof x.name === 'string' ? ` (${x.name})` : ''}`;
    if (!x || typeof x !== 'object' || Array.isArray(x)) { p.push(`${at}: not an object`); return; }
    for (const k of Object.keys(x)) if (!PROJECT_KEYS.includes(k)) p.push(`${at}: unknown key "${k}"`);
    if (!safeName(x.name)) p.push(`${at}: name must be letters, digits, dot, dash, underscore, start with a letter or digit, no .., no trailing dot, not .lock, not a Windows device name`);
    else if (names.has(x.name.toLowerCase())) p.push(`${at}: duplicate name`);
    else names.add(x.name.toLowerCase());
    if (typeof x.url !== 'string' || !/^(https:\/\/|git@|ssh:\/\/|file:\/\/)\S+$/.test(x.url)) p.push(`${at}: url must be an https, ssh, git@ or file URL`);
    if (!VISIBILITY.includes(x.visibility)) p.push(`${at}: visibility must be public or private`);
    if (!safeBranch(x.defaultBranch) || x.defaultBranch.startsWith(PILOT_PREFIX)) p.push(`${at}: defaultBranch must be a safe branch name (letters, digits, . _ - /; starts with a letter or digit; no .., no trailing / or .) that is not a kernel-pilot-* branch`);
    const kr = x.kernelRemote;
    if (!kr || typeof kr !== 'object' || !safeName(kr.name) || typeof kr.url !== 'string' || !/^(https:\/\/|git@|ssh:\/\/|file:\/\/)\S+$/.test(kr.url) || !REMOTE_VISIBILITY.includes(kr.visibility)) {
      p.push(`${at}: kernelRemote needs a safe name (starts with a letter or digit), url and visibility (public, private or unknown)`);
    } else {
      if (kr.visibility === 'public') p.push(`${at}: kernelRemote is public; a kernel branch never goes to a public repository`);
      if (x.visibility === 'public' && normUrl(kr.url) === normUrl(x.url)) p.push(`${at}: a public project needs its own private kernel repository, not its origin`);
      if (x.visibility === 'public' && kr.name === 'origin') p.push(`${at}: the kernel remote of a public project must not be named origin`);
      if (x.visibility === 'private' && normUrl(kr.url) === normUrl(x.url) && kr.visibility !== 'private') p.push(`${at}: the kernel remote is the private origin, so its visibility is private`);
    }
    if (typeof x.pilotBranchPrefix !== 'string' || !x.pilotBranchPrefix.startsWith(PILOT_PREFIX) || !/^[a-z0-9-]+$/.test(x.pilotBranchPrefix)) p.push(`${at}: pilotBranchPrefix must start with ${PILOT_PREFIX} (lower-case letters, digits, dash)`);
    if (x.kernelBranch !== undefined && x.kernelBranch !== null && (!safeBranch(x.kernelBranch) || !x.kernelBranch.startsWith(PILOT_PREFIX) || x.kernelBranch.length === PILOT_PREFIX.length)) p.push(`${at}: kernelBranch must be null or a safe kernel-pilot-* branch name`);
    if (!STATES.includes(x.state)) p.push(`${at}: state must be one of ${STATES.join(', ')}`);
    if (x.kitVersion !== null && (typeof x.kitVersion !== 'string' || !/^[0-9a-f]{40}$/.test(x.kitVersion))) p.push(`${at}: kitVersion must be null or a 40-hex factory commit`);
    if (x.state === 'kit' && !x.kitVersion) p.push(`${at}: state kit needs a kitVersion`);
    const machineMap = (v, what, check) => {
      if (!v || typeof v !== 'object' || Array.isArray(v)) { p.push(`${at}: ${what} must be an object {machineId: ...}`); return; }
      for (const [m, val] of Object.entries(v)) {
        try { if (safeMachineId(m) !== m) throw new Error('canonical'); }
        catch { p.push(`${at}: ${what}: machine id "${m}" must use the canonical identity grammar`); }
        check(m, val);
      }
    };
    const absPath = s => typeof s === 'string' && (path.isAbsolute(s) || /^[A-Za-z]:\\/.test(s));
    machineMap(x.paths, 'paths', (m, val) => { if (!absPath(val)) p.push(`${at}: paths.${m} must be an absolute path`); });
    machineMap(x.ownerWorking, 'ownerWorking', (m, val) => { if (!Array.isArray(val) || !val.every(absPath)) p.push(`${at}: ownerWorking.${m} must be a list of absolute paths`); });
    if (x.paths && x.ownerWorking && typeof x.paths === 'object' && typeof x.ownerWorking === 'object') {
      for (const [m, val] of Object.entries(x.paths)) for (const w of [].concat(x.ownerWorking[m] || [])) if (typeof val === 'string' && typeof w === 'string' && (inside(val, w) || inside(w, val))) p.push(`${at}: paths.${m} overlaps the owner working copy ${w}`);
    }
    if (x.needsOwner !== undefined && x.needsOwner !== null && (typeof x.needsOwner !== 'object' || typeof x.needsOwner.reason !== 'string' || typeof x.needsOwner.remedy !== 'string')) p.push(`${at}: needsOwner must be null or {reason, remedy, date}`);
    if (typeof x.notes !== 'string') p.push(`${at}: notes must be a string`);
  });
  return p;
}
function readRegistry(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw new Refusal(`cannot read the registry ${file}: ${e.code || e.message}`); }
  let reg;
  try { reg = JSON.parse(text); } catch (e) { throw new Refusal(`the registry ${file} is not valid JSON: ${e.message}`); }
  const problems = validateRegistry(reg);
  if (problems.length) throw new Refusal(`the registry ${file} does not match ${SCHEMA}:\n  ${problems.join('\n  ')}`);
  return reg;
}
function writeRegistry(file, reg) {
  const problems = validateRegistry(reg);
  if (problems.length) throw new Error(`refusing to write an invalid registry: ${problems.join('; ')}`);
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, asciiJson(reg));
  fs.renameSync(tmp, file);
}
function findProject(reg, name) {
  const p = reg.projects.find(x => x.name.toLowerCase() === String(name || '').toLowerCase());
  if (!p) throw new Refusal(`no project "${name}" in the registry (known: ${reg.projects.map(x => x.name).join(', ')})`);
  return p;
}
// Every owner working copy of every project on every machine: the tool writes into none of them, nor into anything inside one.
function ownerWorkingPaths(reg) {
  const out = [];
  for (const x of reg.projects) for (const list of Object.values(x.ownerWorking || {})) for (const w of list) out.push(w);
  return out;
}
// The path with every junction and symlink resolved (the deepest folder that exists is resolved, the rest is appended): a link must not hide where a write lands.
function realish(p) {
  const rest = [];
  let cur = path.resolve(p);
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch { /* not there (yet): resolve its parent */ }
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(p);
    rest.push(path.basename(cur));
    cur = up;
  }
}
// Compared by name and by real location, both for the path and for every owner folder (a root, a registered path or an owner folder may each be a link).
function ownerWorkingHit(reg, p) {
  const ps = [p, realish(p)];
  return ownerWorkingPaths(reg).find(w => { const ws = [w, realish(w)]; return ps.some(a => ws.some(b => inside(a, b) || inside(b, a))); }) || null;
}

// ---- the visibility probe (production: gh, read-only; tests inject their own) ----
function ghProbe(url) {
  if (process.env.NODE_TEST_CONTEXT) throw new Error('fleet: the gh visibility probe is never called under node --test; inject a probe');
  const gh = githubRepo(url);
  if (!gh) return 'unknown';
  const r = spawnSync('gh', ['repo', 'view', `${gh.owner}/${gh.repo}`, '--json', 'visibility', '--jq', '.visibility'], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  if (r.status !== 0) return 'unknown';
  const v = (r.stdout || '').trim().toLowerCase();
  return v === 'public' || v === 'private' ? v : 'unknown';
}
function probeOf(deps, url) {
  let v;
  try { v = (deps.probe || ghProbe)(url); } catch (e) { if (/never called under node --test/.test(e.message)) throw e; v = 'unknown'; }
  return VISIBILITY.includes(v) ? v : 'unknown';
}

// ---- reading a clone ----
function repoFacts(dir) {
  const f = { exists: fs.existsSync(dir), isRepo: false };
  if (!f.exists) return f;
  const top = gitRun(dir, ['rev-parse', '--show-toplevel']);
  f.isRepo = top.status === 0 && norm(top.out) === norm(dir);
  if (!f.isRepo) return f;
  const st = gitRun(dir, ['status', '--porcelain=v1', '--untracked-files=all']);
  f.changes = st.status === 0 ? st.out.split('\n').filter(Boolean) : ['(git status failed)'];
  f.dirty = f.changes.length > 0;
  const b = gitRun(dir, ['symbolic-ref', '--short', '-q', 'HEAD']);
  f.branch = b.status === 0 ? b.out : '';
  f.head = gitRun(dir, ['rev-parse', 'HEAD']).out;
  const heads = gitRun(dir, ['for-each-ref', '--format=%(refname:short)%09%(upstream:short)', 'refs/heads']).out.split('\n').filter(Boolean).map(l => { const [n, u] = l.split('\t'); return { name: n, upstream: u || '' }; });
  f.heads = heads;
  f.kernelBranches = heads.filter(h => h.name.startsWith(PILOT_PREFIX)).map(h => h.name);
  return f;
}
// A clone that another git process is using, or that holds the leftovers of an interrupted operation: git writes nothing until it is resolved,
// and neither does this tool. Read only (one rev-parse). Each entry names the file or folder that proves it.
const BUSY_IN_GIT_DIR = [['index.lock', 'a git process holds the index lock, or left a stale one'], ['HEAD.lock', 'a git process holds HEAD.lock, or left a stale one'], ['MERGE_HEAD', 'a merge is in progress'],
  ['CHERRY_PICK_HEAD', 'a cherry-pick is in progress'], ['REVERT_HEAD', 'a revert is in progress'], ['rebase-merge', 'a rebase is in progress'], ['rebase-apply', 'a rebase or am is in progress'],
  ['BISECT_LOG', 'a bisect is in progress'], ['sequencer', 'a cherry-pick or revert sequence is in progress']];
const BUSY_IN_COMMON_DIR = [['config.lock', 'a git process holds config.lock, or left a stale one'], ['packed-refs.lock', 'a git process holds packed-refs.lock, or left a stale one'], ['shallow.lock', 'a git process holds shallow.lock, or left a stale one']];
const REF_SCAN_CAP = 20000;
// Any *.lock under refs/ (refs/heads/<branch>.lock is the lock of update-ref, merge --ff-only and commit; a stale one makes git fail after it already wrote the tree). Links are not followed.
function refLocks(dir, out, state) {
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (state.n++ > REF_SCAN_CAP) { state.capped = true; return; }
    const full = path.join(dir, e.name);
    if (/\.lock$/i.test(e.name)) out.push(full);
    else if (e.isDirectory()) refLocks(full, out, state);
  }
}
function busyOf(dir) {
  const r = gitRun(dir, ['rev-parse', '--git-dir', '--git-common-dir']);
  if (r.status !== 0) return [{ file: dir, why: 'git could not locate its directory' }];
  const [gd, cd] = r.out.split('\n').map(s => path.resolve(dir, s.trim()));
  const found = [];
  for (const [name, why] of BUSY_IN_GIT_DIR) if (fs.existsSync(path.join(gd, name))) found.push({ file: path.join(gd, name), why });
  for (const [name, why] of BUSY_IN_COMMON_DIR) if (cd && fs.existsSync(path.join(cd, name))) found.push({ file: path.join(cd, name), why });
  const state = { n: 0, capped: false };
  const locks = [];
  for (const root of new Set([cd, gd].filter(Boolean).map(d => path.join(d, 'refs')))) refLocks(root, locks, state);
  for (const l of locks) found.push({ file: l, why: 'a git process holds the lock of this ref, or left a stale one' });
  if (state.capped) found.push({ file: path.join(cd || gd, 'refs'), why: `more than ${REF_SCAN_CAP} entries: too many to check for stale ref locks` });
  return found;
}
const busyText = b => b.map(x => `${x.file} (${x.why})`).join('; ');
const BUSY_REMEDY = 'check that no git process is using the clone (an editor, another tool), then remove a stale lock or finish the operation yourself; the tool writes nothing until then';
function sparseOf(dir) {
  const c = gitRun(dir, ['config', '--get', 'core.sparseCheckout']);
  if (c.status === 0 && /^(true|yes|on|1)$/i.test(c.out.trim())) return 'core.sparseCheckout is on';
  const r = gitRun(dir, ['rev-parse', '--git-dir', '--git-common-dir']);
  if (r.status === 0) for (const d of new Set(r.out.split('\n').map(x => path.resolve(dir, x.trim())))) if (fs.existsSync(path.join(d, 'info', 'sparse-checkout'))) return `${path.join(d, 'info', 'sparse-checkout')} exists`;
  return null;
}
// Ignored paths of a clone. Files the project chose not to track are local work that no commit holds: the kit update must not write onto one.
// collisions: kit target paths the project's ignore rules cover (an existing local file the update would replace, or a new kit file git would
// silently leave out of the commit); report: ignored entries that sit in a folder the kit manages (shown, never touched).
function kitFootprint(ctx) {
  let fp;
  try { fp = require(path.join(ctx.factory, 'docs', 'ops', 'pilot-install.cjs')).kitTargetPaths(); } catch (e) { throw new Refusal(`cannot work out which paths the kit writes (${String(e.message).split('\n')[0].slice(0, 200)}); the tool does not guess, so it writes nothing`); }
  return fp;
}
function ignoredScan(ctx, dir) {
  const fp = kitFootprint(ctx);
  const collisions = [];
  for (let i = 0; i < fp.files.length; i += 50) {
    const r = gitRun(dir, ['check-ignore', '--', ...fp.files.slice(i, i + 50)]);
    if (r.status === 0) collisions.push(...r.out.split('\n').map(s => s.trim()).filter(Boolean));
    else if (r.status !== 1) throw new Refusal(`git could not tell which paths of ${dir} are ignored (check-ignore exit ${r.status}: ${(r.err || r.out).replace(/\s+/g, ' ').slice(0, 160)}); the tool writes nothing`);
  }
  const st = gitRun(dir, ['status', '-z', '--porcelain=v1', '--ignored=matching', '--untracked-files=all']);
  const managedDirs = new Set(fp.files.map(f => path.posix.dirname(f)).filter(d => d !== '.'));
  const files = new Set(fp.files);
  const report = [];
  for (const rec of st.status === 0 ? st.out.split('\0') : []) {
    if (!rec.startsWith('!! ')) continue;
    const e = rec.slice(3);
    const p = e.replace(/\/$/, '');
    const d = e.endsWith('/') ? p : path.posix.dirname(p);
    if (files.has(p) || (d !== '.' && [...managedDirs].some(m => d === m || d.startsWith(`${m}/`)))) report.push(e);
  }
  return { collisions: [...new Set(collisions)].sort(), report };
}
// The refusals shared by the two commands that write into a working copy (setup, update-kit), after the tree is known to be clean: busy clone, a sparse
// checkout, then a write onto an ignored path. Returns the ignored entries to report. Reads only.
function writeGuards(ctx, dir) {
  const busy = busyOf(dir);
  if (busy.length) throw new Refusal(`${dir} is busy: ${busyText(busy)}; ${BUSY_REMEDY}`);
  const sparse = sparseOf(dir);
  if (sparse) throw new Refusal(`${dir} uses a sparse checkout (${sparse}); the kit writes files the sparse definition leaves out, and git add would fail halfway. The tool never changes it: run  git sparse-checkout disable  in ${dir} yourself (set it up again afterwards if you want it back), then run again`);
  const scan = ignoredScan(ctx, dir);
  if (scan.collisions.length) throw new Refusal(`${dir}: the kit would write to an ignored path (local files the project chose not to track, which no commit holds; git would also leave a new kit file out of the commit): ${scan.collisions.slice(0, 8).join(', ')}. Move the local file or change the ignore rule in the project, then run again`);
  return scan.report;
}
function logIgnored(ctx, tag, report) {
  if (report.length) ctx.log(`${tag}: ${report.length} ignored path(s) under kit-managed folders (left as they are, never written): ${report.slice(0, 8).join('; ')}${report.length > 8 ? '; ...' : ''}`);
}
function aheadBehind(dir, local, upstream) {
  if (!upstream) return null;
  const r = gitRun(dir, ['rev-list', '--left-right', '--count', `${local}...${upstream}`]);
  if (r.status !== 0) return null;
  const [a, b] = r.out.split(/\s+/).map(Number);
  return { ahead: a, behind: b };
}
function upstreamOf(f, branch) { const h = (f.heads || []).find(x => x.name === branch); return h ? h.upstream : ''; }
function kitOnBranch(dir, branch) {
  const r = gitRun(dir, ['show', `${branch}:${KIT_MANIFEST}`]);
  if (r.status !== 0) return null;
  try { const m = JSON.parse(r.out); return typeof m.sourceSha === 'string' ? m.sourceSha : null; } catch { return null; }
}
function manifestRole(dir, rev) {
  const r = gitRun(dir, ['show', `${rev}:protocol-manifest.json`]);
  if (r.status !== 0) return null;
  try { return JSON.parse(r.out).role || 'unknown'; } catch { return 'unreadable'; }
}

// ---- the factory ----
function factoryFacts(factory) {
  const head = gitRun(factory, ['rev-parse', 'HEAD']);
  let role = '';
  try { role = JSON.parse(fs.readFileSync(path.join(factory, 'protocol-manifest.json'), 'utf8')).role; } catch { /* reported by doctor */ }
  const dirty = gitRun(factory, ['status', '--porcelain=v1', '--untracked-files=no']);
  return { head: head.status === 0 ? head.out : '', role, dirty: dirty.status !== 0 || dirty.out !== '' };
}
let kitPathCache = null;
function kitPaths(factory) {
  if (kitPathCache && kitPathCache.factory === factory) return kitPathCache.paths;
  let paths;
  try { paths = require(path.join(factory, 'docs', 'ops', 'pilot-install.cjs')).kitSourcePaths(); } catch { paths = ['docs/ops/pilot-kit.json', 'docs/ops/pilot-kit', 'docs/ops/pilot-install.cjs', '.ai/bin', 'protocol-manifest.json']; }
  kitPathCache = { factory, paths };
  return paths;
}
// up to date | behind by N commits touching the kit | unknown
function kitAge(factory, kitVersion) {
  if (!kitVersion) return { state: 'none', text: 'no kit' };
  const fh = factoryFacts(factory).head;
  if (kitVersion === fh) return { state: 'current', behind: 0, text: 'up to date' };
  if (gitRun(factory, ['rev-parse', '--verify', '--quiet', `${kitVersion}^{commit}`]).status !== 0) return { state: 'unknown', text: `unknown (kit commit ${short(kitVersion)} is not in this factory's history)` };
  if (gitRun(factory, ['merge-base', '--is-ancestor', kitVersion, 'HEAD']).status !== 0) return { state: 'unknown', text: `unknown (kit commit ${short(kitVersion)} is not an ancestor of the factory HEAD)` };
  const n = gitRun(factory, ['rev-list', '--count', `${kitVersion}..HEAD`, '--', ...kitPaths(factory)]);
  const count = n.status === 0 ? Number(n.out) : NaN;
  if (!Number.isFinite(count)) return { state: 'unknown', text: 'unknown (rev-list failed)' };
  return count === 0 ? { state: 'current', behind: 0, text: `up to date (factory HEAD ${short(fh)} changes nothing of the kit)` } : { state: 'behind', behind: count, text: `behind by ${count} commit(s) touching the kit` };
}

// ---- status ----
function projectStatus(ctx, x) {
  const s = { name: x.name, machine: ctx.machine, visibility: x.visibility, kernelRemote: `${x.kernelRemote.name} ${x.kernelRemote.url} (${x.kernelRemote.visibility})`, registryState: x.state, path: x.paths[ctx.machine] || null };
  const ow = (x.ownerWorking[ctx.machine] || []);
  s.ownerWorking = ow;
  if (x.state === 'owner-working') { s.next = 'none: the registry marks this project as an owner working copy; the tool only reads it'; return s; }
  if (!s.path) { s.next = `pull-all --project ${x.name} (clones it into ${path.join(ctx.root, x.name)})`; return s; }
  const hit = ownerWorkingHit(ctx.reg, s.path);
  if (hit) { s.next = `owner: the registered path is an owner working copy (${hit}); fix the registry, the tool never writes there`; return s; }
  const f = repoFacts(s.path);
  s.exists = f.exists;
  if (!f.exists) { s.next = `pull-all --project ${x.name} (the path is missing on this machine)`; return s; }
  if (!f.isRepo) { s.next = `owner: ${s.path} is not the root of a git repository`; return s; }
  s.branch = f.branch || '(detached)';
  s.dirty = f.dirty;
  s.changes = f.changes.length;
  const ab = f.branch ? aheadBehind(s.path, f.branch, upstreamOf(f, f.branch)) : null;
  s.upstream = f.branch ? upstreamOf(f, f.branch) || null : null;
  s.ahead = ab ? ab.ahead : null;
  s.behind = ab ? ab.behind : null;
  s.kernelBranches = f.kernelBranches;
  const kb = x.kernelBranch && f.kernelBranches.includes(x.kernelBranch) ? x.kernelBranch : (f.kernelBranches.length === 1 ? f.kernelBranches[0] : null);
  s.kernelBranch = kb;
  if (kb) {
    const ku = upstreamOf(f, kb);
    const kab = aheadBehind(s.path, kb, ku);
    s.kernelUpstream = ku || null;
    s.kernelAhead = kab ? kab.ahead : null;
    s.kernelBehind = kab ? kab.behind : null;
  }
  s.kitVersion = kb ? kitOnBranch(s.path, kb) : null;
  const age = kitAge(ctx.factory, s.kitVersion);
  s.kit = age.text;
  s.kitState = age.state;
  if (f.dirty) s.next = `owner: commit or set aside the ${f.changes.length} changed path(s) in ${s.path}; the tool does not touch a dirty tree`;
  else if (busyOf(s.path).length) s.next = `owner: git is busy in ${s.path} (${busyText(busyOf(s.path))}); ${BUSY_REMEDY}`;
  else if (x.state === 'needs-owner' && x.needsOwner) s.next = `owner: ${x.needsOwner.remedy}`;
  else if (f.kernelBranches.length > 1 && !kb) s.next = `owner: several kernel branches (${f.kernelBranches.join(', ')}); set kernelBranch in the registry`;
  else if (!kb) s.next = `setup ${x.name}`;
  else if (s.kernelBehind) s.next = `pull-all --project ${x.name} (the kernel branch is behind its upstream)`;
  else if (age.state === 'unknown') s.next = `owner: update the factory first (git pull in ${ctx.factory}); the kit of ${x.name} is not in its history`;
  else if ((age.state === 'behind' || age.state === 'none') && f.branch !== kb) s.next = `owner: run  git checkout ${kb}  in ${s.path} (update-kit never switches branches), then update-kit ${x.name}`;
  else if (age.state === 'behind' || age.state === 'none') s.next = `update-kit ${x.name}`;
  else if (!s.kernelUpstream || s.kernelAhead) s.next = `push-pilots --project ${x.name}`;
  else if (s.behind) s.next = `pull-all --project ${x.name}`;
  else s.next = 'nothing';
  return s;
}

function failureLine(ctx, tag, e, dir) {
  const why = String((e && e.message) || e).split(/\r?\n/)[0].replace(/\s+/g, ' ').slice(0, 300);
  const where = (e && e.cwd) || dir || 'the clone';
  ctx.log(`${tag}: FAILED ${why}`);
  ctx.log(`  ${tag}| REMEDY: nothing was deleted or pushed. Look at  git status  in ${where}: a stale git lock file (*.lock under .git), a hook of the project, a read-only file or a full disk is the usual cause. Staged or half-written changes there belong to the interrupted command; the owner decides what to do with them (inspect, then commit, or set aside with  git stash push -u -m fleet-failed ); the tool never resets or cleans. After the cause is fixed, run the same command again`);
}

// ---- add ----
function cmdAdd(ctx, o) {
  const url = o._[0];
  if (!url || !/^(https:\/\/|git@|ssh:\/\/|file:\/\/)\S+$/.test(url)) throw new Refusal('add needs a repository URL (https, ssh, git@ or file)');
  const name = o.name || decodeURIComponent(url.replace(/\/+$/, '').split(/[\/:]/).pop().replace(/\.git$/i, ''));
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new Refusal(`project name "${name}" is not letters, digits, dot, dash, underscore; pass --name`);
  if (ctx.reg.projects.some(x => x.name.toLowerCase() === name.toLowerCase())) throw new Refusal(`a project named "${name}" is already registered; names are unique (use status, pull-all or setup for it)`);
  const dup = ctx.reg.projects.find(x => normUrl(x.url) === normUrl(url));
  if (dup) throw new Refusal(`the URL is already registered as "${dup.name}"`);
  if (o.visibility && !VISIBILITY.includes(o.visibility)) throw new Refusal('--visibility must be public or private');
  const probed = probeOf(ctx.deps, url);
  let visibility;
  if (probed !== 'unknown' && o.visibility && probed !== o.visibility) throw new Refusal(`--visibility ${o.visibility} contradicts the probe (${probed}); check the repository settings`);
  if (probed !== 'unknown') visibility = probed;
  else if (o.visibility) visibility = o.visibility;
  else throw new Refusal('the visibility of the repository is unknown (the probe could not tell); check it and pass --visibility public|private');
  let kernelRemote;
  if (visibility === 'private' && !o['kernel-remote']) kernelRemote = { name: 'origin', url, visibility: 'private' };
  else {
    const gh = githubRepo(url);
    const kurl = o['kernel-remote'] || (gh ? `https://github.com/${gh.owner}/${gh.repo}-kernel.git` : null);
    if (!kurl) throw new Refusal('a public project needs --kernel-remote <url of its private kernel repository>');
    if (normUrl(kurl) === normUrl(url) && visibility === 'public') throw new Refusal('the kernel remote of a public project cannot be its public origin');
    const kv = probeOf(ctx.deps, kurl);
    if (kv === 'public') throw new Refusal(`the kernel repository ${kurl} is PUBLIC; a kernel branch never goes to a public repository`);
    kernelRemote = { name: 'kernel', url: kurl, visibility: kv };
  }
  const target = path.join(ctx.root, name);
  const hit = ownerWorkingHit(ctx.reg, target);
  if (hit) throw new Refusal(`${target} is (inside) an owner working copy (${hit}); the tool never writes there`);
  if (fs.existsSync(target)) throw new Refusal(`${target} already exists; the tool clones only into a new folder (move it or pass --name)`);
  const lines = [`clone ${url} into ${target}`, `register "${name}": visibility ${visibility}${probed === 'unknown' ? ' (from --visibility; the probe could not tell)' : ' (probe)'}, kernel remote ${kernelRemote.name} ${kernelRemote.url} (${kernelRemote.visibility}), branch prefix ${PILOT_PREFIX}${slug(name)}-, path on ${ctx.machine}`];
  if (kernelRemote.visibility === 'unknown') lines.push(`the kernel repository is not confirmed private yet: create it with  gh repo create ${(githubRepo(kernelRemote.url) || { owner: '<owner>', repo: '<repo>' }).owner}/${(githubRepo(kernelRemote.url) || { repo: '<repo>' }).repo} --private  and set kernelRemote.visibility to private in the registry; push-pilots refuses until then`);
  if (o.plan) { for (const l of lines) ctx.log(`plan add ${name}: ${l}`); ctx.log(`plan add ${name}: nothing was changed`); return 0; }
  fs.mkdirSync(ctx.root, { recursive: true });
  const c = gitRun(ctx.root, ['clone', '--no-hardlinks', '--', url, target]);
  if (c.status !== 0) { ctx.log(`add ${name}: FAILED clone: ${(c.err || c.out).replace(/\s+/g, ' ')}`); return 1; }
  const def = gitRun(target, ['symbolic-ref', '--short', '-q', 'HEAD']).out || 'main';
  const role = manifestRole(target, 'HEAD');
  const state = role === 'installed' ? 'base' : 'none';
  ctx.reg.projects.push({ name, url, visibility, defaultBranch: def, kernelRemote, pilotBranchPrefix: `${PILOT_PREFIX}${slug(name)}-`, kernelBranch: null, state, kitVersion: null,
    paths: { [ctx.machine]: target }, ownerWorking: {}, needsOwner: null, notes: `added by fleet add on ${ctx.machine} ${ctx.now.toISOString().slice(0, 10)}` });
  writeRegistry(ctx.registry, ctx.reg);
  for (const l of lines.slice(2)) ctx.log(`add ${name}: note: ${l}`);
  ctx.log(`add ${name}: OK cloned into ${target} (default branch ${def}, ${state === 'base' ? 'base protocol present' : 'no protocol'}), registered; next: setup ${name}. Commit the registry change in the factory.`);
  return 0;
}

function caseClash(names, want) { return names.includes(want) ? null : (names.find(n => n.toLowerCase() === want.toLowerCase()) || null); }
function namesUnder(dir, prefix) { return gitRun(dir, ['for-each-ref', '--format=%(refname)', prefix]).out.split('\n').filter(Boolean).map(n => n.slice(prefix.length)); }
function branchClash(dir, local, remoteRef) {
  const m = /^refs\/remotes\/([^/]+)\/(.+)$/.exec(remoteRef);
  const lc = caseClash(namesUnder(dir, 'refs/heads/'), local);
  if (lc) return `REFUSED ${local}: the registry or the remote say "${local}" but the clone has "${lc}" (the names differ in case); nothing was moved. Fix the registry (or rename the branch) so both spell it the same`;
  const rc = m ? caseClash(namesUnder(dir, `refs/remotes/${m[1]}/`), m[2]) : null;
  if (rc) return `REFUSED ${local}: the registry says "${m[2]}" but the remote has "${rc}" (the names differ in case); nothing was moved. Fix defaultBranch in the registry`;
  return null;
}
// Fast-forward `local` to `remoteRef` when it is strictly behind; never anything else.
function fastForward(ctx, dir, f, local, remoteRef, plan) {
  const clash = branchClash(dir, local, remoteRef);
  if (clash) return clash;
  const r = gitRun(dir, ['rev-parse', '--verify', '--quiet', `${remoteRef}^{commit}`]);
  if (r.status !== 0) return `${local}: no ${remoteRef}`;
  const remoteSha = r.out;
  const l = gitRun(dir, ['rev-parse', '--verify', '--quiet', `refs/heads/${local}^{commit}`]);
  if (l.status !== 0) {
    if (plan) return `${local}: would be created tracking ${remoteRef}`;
    gitOk(dir, 'branch', '--track', local, remoteRef);
    return `${local}: created tracking ${remoteRef}`;
  }
  const localSha = l.out;
  if (localSha === remoteSha) return `${local}: up to date`;
  if (gitRun(dir, ['merge-base', '--is-ancestor', localSha, remoteSha]).status === 0) {
    const n = gitOk(dir, 'rev-list', '--count', `${localSha}..${remoteSha}`);
    if (plan) return `${local}: would fast-forward ${n} commit(s)`;
    if (f.branch === local) gitOk(dir, 'merge', '--ff-only', '-q', remoteRef);
    else {
      // a branch checked out in another working tree of this repository is that tree's HEAD: not moved from here
      const wt = gitRun(dir, ['for-each-ref', '--format=%(worktreepath)', `refs/heads/${local}`]);
      if (wt.status !== 0 || wt.out) return `${local}: checked out in another working tree${wt.out ? ` (${wt.out})` : ''}; not moved`;
      gitOk(dir, 'update-ref', `refs/heads/${local}`, remoteSha, localSha);
    }
    return `${local}: fast-forwarded ${n} commit(s)`;
  }
  if (gitRun(dir, ['merge-base', '--is-ancestor', remoteSha, localSha]).status === 0) return `${local}: ahead of ${remoteRef} by ${gitOk(dir, 'rev-list', '--count', `${remoteSha}..${localSha}`)} (not pushed; nothing done)`;
  return `${local}: DIVERGED from ${remoteRef}; not touched (the owner merges)`;
}
// The kernel remote in a clone: added when absent; a remote of that name with another URL is refused.
// Read only: does the clone have the remote, and where would a fetch and a push really go (git expands insteadOf and pushurl).
function kernelRemoteState(dir, kr) {
  const fetchUrls = gitRun(dir, ['remote', 'get-url', '--all', kr.name]);
  if (fetchUrls.status !== 0) return { exists: false, ok: true, pushUrl: kr.url, note: '' };
  const pushUrls = gitRun(dir, ['remote', 'get-url', '--push', '--all', kr.name]);
  const lines = s => s.split('\n').map(x => x.trim()).filter(Boolean);
  const all = [...lines(fetchUrls.out), ...lines(pushUrls.out)];
  const pushUrl = lines(pushUrls.out)[0] || lines(fetchUrls.out)[0] || kr.url;
  if (pushUrls.status !== 0 || !all.length || all.some(u => normUrl(u) !== normUrl(kr.url))) return { exists: true, ok: false, pushUrl, note: `remote ${kr.name} points elsewhere (${all.join(', ') || 'unreadable'}), registry says ${kr.url}` };
  return { exists: true, ok: true, pushUrl, note: '' };
}
function ensureKernelRemote(ctx, dir, kr, plan) {
  const s = kernelRemoteState(dir, kr);
  if (!s.exists) {
    if (plan) return { ok: true, note: `would add remote ${kr.name} ${kr.url}`, pushUrl: kr.url };
    gitOk(dir, 'remote', 'add', kr.name, kr.url);
    return { ok: true, note: `added remote ${kr.name}`, pushUrl: kr.url };
  }
  return { ok: s.ok, note: s.note, pushUrl: s.pushUrl };
}
function cmdPullAll(ctx, o) {
  const list = o.project ? [findProject(ctx.reg, o.project)] : ctx.reg.projects;
  let bad = 0;
  let changedRegistry = false;
  for (const x of list) {
    const tag = `${o.plan ? 'plan ' : ''}pull-all ${x.name}`;
    let dirNow = null;
    try {
      if (x.state === 'owner-working') { ctx.log(`${tag}: SKIPPED owner working copy (read only)`); continue; }
      let dir = x.paths[ctx.machine];
      if (!dir) {
        dir = path.join(ctx.root, x.name);
        const hit = ownerWorkingHit(ctx.reg, dir);
        if (hit) { ctx.log(`${tag}: REFUSED ${dir} is an owner working copy (${hit})`); bad++; continue; }
        if (fs.existsSync(dir)) { ctx.log(`${tag}: REFUSED ${dir} exists but is not registered for ${ctx.machine}; register it by hand or move it`); bad++; continue; }
        if (o.plan) { ctx.log(`${tag}: would clone ${x.url} into ${dir} and record the path for ${ctx.machine}`); continue; }
        fs.mkdirSync(ctx.root, { recursive: true });
        const c = gitRun(ctx.root, ['clone', '--no-hardlinks', '--', x.url, dir]);
        if (c.status !== 0) { ctx.log(`${tag}: FAILED clone: ${(c.err || c.out).replace(/\s+/g, ' ')}`); bad++; continue; }
        x.paths[ctx.machine] = dir;
        changedRegistry = true;
        ctx.log(`${tag}: cloned into ${dir}`);
      }
      const hit = ownerWorkingHit(ctx.reg, dir);
      if (hit) { ctx.log(`${tag}: REFUSED ${dir} is an owner working copy (${hit})`); bad++; continue; }
      dirNow = dir;
      const f = repoFacts(dir);
      if (!f.isRepo) { ctx.log(`${tag}: FAILED ${dir} is ${f.exists ? 'not the root of a git repository' : 'missing'}`); bad++; continue; }
      if (f.dirty) { ctx.log(`${tag}: SKIPPED dirty working tree (${f.changes.length} path(s)), not touched: ${f.changes.slice(0, 5).join('; ')}`); bad++; continue; }
      const busy = busyOf(dir);
      if (busy.length) { ctx.log(`${tag}: SKIPPED busy clone, not touched: ${busyText(busy)}; ${BUSY_REMEDY}`); bad++; continue; }
      const notes = [];
      if (o.plan) notes.push('would fetch origin');
      else {
        const fe = gitRun(dir, ['fetch', '-q', 'origin']);
        if (fe.status !== 0) { ctx.log(`${tag}: FAILED fetch origin: ${(fe.err || fe.out).replace(/\s+/g, ' ')}`); bad++; continue; }
      }
      const fNow = repoFacts(dir);
      notes.push(fastForward(ctx, dir, fNow, x.defaultBranch, `refs/remotes/origin/${x.defaultBranch}`, o.plan));
      if (/^REFUSED /.test(notes[notes.length - 1])) { ctx.log(`${tag}: ${notes.join('; ')}`); bad++; continue; }
      const kr = x.kernelRemote;
      let kernelReady = true;
      if (kr.name !== 'origin') {
        const e = ensureKernelRemote(ctx, dir, kr, o.plan);
        if (!e.ok) { notes.push(`kernel remote: ${e.note}; kernel branches not pulled`); kernelReady = false; }
        else {
          if (e.note) notes.push(e.note);
          if (o.plan) notes.push(`would fetch ${kr.name}`);
          else {
            const fk = gitRun(dir, ['fetch', '-q', kr.name]);
            if (fk.status !== 0) { notes.push(`fetch ${kr.name} failed (${(fk.err || fk.out).replace(/\s+/g, ' ').slice(0, 160)})`); kernelReady = false; }
          }
        }
      }
      if (kernelReady) {
        const f2 = repoFacts(dir);
        const remoteKernel = gitRun(dir, ['for-each-ref', '--format=%(refname:short)', `refs/remotes/${kr.name}/${PILOT_PREFIX}*`]).out.split('\n').filter(Boolean);
        for (const rk of remoteKernel) notes.push(fastForward(ctx, dir, f2, rk.slice(kr.name.length + 1), `refs/remotes/${rk}`, o.plan));
        const f3 = repoFacts(dir);
        if (!x.kernelBranch && f3.kernelBranches.length === 1 && !o.plan) { x.kernelBranch = f3.kernelBranches[0]; changedRegistry = true; }
      }
      const refused = notes.some(n => /^REFUSED /.test(n));
      if (refused || notes.some(n => /DIVERGED/.test(n))) bad++;
      ctx.log(`${tag}: ${refused ? 'REFUSED (in part)' : notes.some(n => /DIVERGED/.test(n)) ? 'ATTENTION' : 'OK'} ${notes.join('; ')}`);
    } catch (e) { failureLine(ctx, tag, e, dirNow); bad++; }
  }
  if (changedRegistry) { writeRegistry(ctx.registry, ctx.reg); ctx.log(`registry updated (${ctx.registry}); commit it in the factory`); }
  return bad ? 1 : 0;
}

// ---- setup and update-kit: shared pieces ----
// Validator lines that come from the project's own files (state the tool never repairs), with the exact remedy for the owner.
const PROJECT_OWNED = [
  { re: /completed task requires a ## Completion gate section/i, reason: 'the project .ai/TASK.md says Status: Completed but has no ## Completion gate section',
    remedy: dir => `in ${dir} edit .ai/TASK.md: either set "Status:" to the real state (one of No active task, Planned, Pending, Ready, In progress, Active, Blocked) or add a "## Completion gate" section with "- Adversarial review prompt: <path>" and "- Independent review: <path>" (AGENTS.md section 2); then run  node .ai/bin/protocol-validate.cjs --root .  and  git add -A && git commit -m "chore(protocol): pilot kit with the project TASK.md status fixed"  in that folder, then  node docs/ops/fleet/fleet.cjs update-kit <project>` },
  { re: /\.ai\/(TASK|PLAN|DECISIONS|ARCHIVE)\.md|\.ai\/worklog\/|worklog/i, reason: 'a protocol state file of the project (.ai/TASK.md, PLAN.md, DECISIONS.md, ARCHIVE.md or a journal) fails the validator',
    remedy: dir => `in ${dir} fix the file the [FAIL] line names (it belongs to the project and the tool never edits it); then run  node .ai/bin/protocol-validate.cjs --root .  and  git add -A && git commit  in that folder, then  node docs/ops/fleet/fleet.cjs update-kit <project>` },
];
function classifyFailure(out) {
  const fails = out.split(/\r?\n/).filter(l => /\[FAIL\]|\[ERROR\]/.test(l)).map(l => l.trim());
  for (const k of PROJECT_OWNED) { const hit = fails.find(l => k.re.test(l)); if (hit) return { owned: true, line: hit, rule: k, fails }; }
  return { owned: false, fails };
}
function runNode(ctx, cwd, args) {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, PROTOCOL_NO_FULL_SUITE: '1' } });
  return { status: r.status === null ? 1 : r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
const KEEP_LINE = /^(REFUSED|pilot-install|snapshot:|install:|restore:|WARNING:|kit:|layer L\d|update:|validate:|lint:|commit:|Done|INTERRUPTED|The update|  \[FAIL\]|  \[ERROR\]|dry-run:|  \S.*  \((changed|new)\)$|  skeleton )/;
function relay(ctx, tag, out, max = 40) { const keep = out.split(/\r?\n/).filter(l => KEEP_LINE.test(l)); for (const l of keep.slice(0, max)) ctx.log(`  ${tag}| ${l}`); }
// Runs pilot-install --update of the factory in the clone and records the outcome in the registry entry.
function runKitUpdate(ctx, x, dir, plan, tag) {
  const tool = path.join(ctx.factory, 'docs', 'ops', 'pilot-install.cjs');
  const args = [tool, '--target', dir, '--update'];
  if (plan) args.push('--dry-run');
  const keys = ctx.keys;
  if (keys && keys.pass) args.push(`--keys=${keys.value}`);
  const r = runNode(ctx, ctx.factory, args);
  relay(ctx, 'pilot-install', r.out);
  if (plan) return { code: r.status === 0 ? 0 : r.status, outcome: r.status === 0 ? 'plan printed above' : `pilot-install --update --dry-run exit ${r.status}` };
  if (r.status === 0) {
    let kv = null;
    try { kv = JSON.parse(fs.readFileSync(path.join(dir, KIT_MANIFEST), 'utf8')).sourceSha; } catch { /* reported below */ }
    x.state = 'kit';
    x.kitVersion = /^[0-9a-f]{40}$/.test(kv || '') ? kv : x.kitVersion;
    x.needsOwner = null;
    return { code: 0, outcome: /nothing to change/.test(r.out) ? `OK nothing to change (kit ${short(x.kitVersion)})` : `OK kit ${short(x.kitVersion)} committed on ${repoFacts(dir).branch}` };
  }
  if (r.status === 2) return { code: 1, outcome: `REFUSED by pilot-install: ${(r.out.split(/\r?\n/).find(l => l.startsWith('REFUSED')) || '').slice(0, 300)}` };
  const c = classifyFailure(r.out);
  if (c.owned) {
    const remedy = c.rule.remedy(dir).replace('<project>', x.name);
    x.state = 'needs-owner';
    x.needsOwner = { reason: c.rule.reason, remedy, date: ctx.now.toISOString().slice(0, 10) };
    ctx.log(`  ${tag}| project-owned check failed (never repaired by the tool): ${c.line}`);
    ctx.log(`  ${tag}| REMEDY: ${remedy}`);
    return { code: 1, outcome: `NEEDS-OWNER ${c.rule.reason}; the kit is left UNCOMMITTED on the pilot branch` };
  }
  ctx.log(`  ${tag}| REMEDY: inspect  git status  in ${dir}; the kit is left uncommitted on the pilot branch (nothing was pushed or deleted). After the cause is fixed: git add -A && git commit, or set it aside with  git stash push -u -m fleet-kit-failed  (owner's decision), then  node docs/ops/fleet/fleet.cjs update-kit ${x.name}`);
  return { code: 1, outcome: `FAILED pilot-install --update exit ${r.status}${c.fails.length ? `: ${c.fails[0].slice(0, 200)}` : ''}` };
}
// The keys wizard hook (stream ops-keys-wizard-claude): --keys ask|yes|no is passed through to pilot-install only when the factory's
// pilot-install declares FEATURES 'keys'; "ask" becomes "no" without a TTY (the same rule as the wizard).
function resolveKeys(ctx, o) {
  const raw = o.keys || 'ask';
  if (!['ask', 'yes', 'no'].includes(raw)) throw new Refusal('--keys must be ask, yes or no');
  const value = raw === 'ask' && !ctx.deps.isTTY ? 'no' : raw;
  let features = [];
  try { features = require(path.join(ctx.factory, 'docs', 'ops', 'pilot-install.cjs')).FEATURES || []; } catch { /* old factory */ }
  return { value, pass: features.includes('keys'), note: features.includes('keys') ? `keys wizard: --keys=${value} passed to pilot-install` : `keys wizard: not in this factory yet (stream ops-keys-wizard-claude); --keys=${value} is recorded here and passed through once pilot-install declares it` };
}

// ---- setup ----
function cmdSetup(ctx, o) {
  const x = findProject(ctx.reg, o._[0]);
  const tag = `${o.plan ? 'plan ' : ''}setup ${x.name}`;
  if (x.state === 'owner-working') throw new Refusal(`${x.name} is marked owner-working in the registry; the tool never sets it up`);
  const dir = x.paths[ctx.machine];
  if (!dir) throw new Refusal(`${x.name} has no clone on ${ctx.machine}; run  pull-all --project ${x.name}  first (it clones into ${path.join(ctx.root, x.name)})`);
  const hit = ownerWorkingHit(ctx.reg, dir);
  if (hit) throw new Refusal(`${dir} is an owner working copy (${hit}); setup installs only into fresh clones under ${ctx.root}`);
  if (!strictlyInside(dir, ctx.root)) throw new Refusal(`${dir} is not under the fleet root ${ctx.root}; setup installs only into fresh clones there (an installed project outside the root is updated with update-kit)`);
  const f = repoFacts(dir);
  if (!f.isRepo) throw new Refusal(`${dir} is not the root of a git repository`);
  if (f.dirty) throw new Refusal(`${dir} has ${f.changes.length} uncommitted or untracked path(s); the tool does not touch it: ${f.changes.slice(0, 5).join('; ')}`);
  if (f.kernelBranches.length) throw new Refusal(`${dir} already has a kernel branch (${f.kernelBranches.join(', ')}); use  update-kit ${x.name}`);
  if (f.branch !== x.defaultBranch) throw new Refusal(`${dir} is on "${f.branch || 'detached HEAD'}", not on the default branch ${x.defaultBranch}; a fresh clone is on its default branch`);
  const ab = aheadBehind(dir, f.branch, upstreamOf(f, f.branch));
  if (ab && ab.ahead) throw new Refusal(`${x.defaultBranch} in ${dir} is ${ab.ahead} commit(s) ahead of its upstream; a fresh clone holds no local commits`);
  const role = manifestRole(dir, 'HEAD');
  if (role !== null && role !== 'installed') throw new Refusal(`protocol-manifest.json of ${x.name} has role "${role}"; only a project without the protocol or with an installed one is set up`);
  const branch = `${x.pilotBranchPrefix}${utcDate(ctx.now)}`;
  if (gitRun(dir, ['check-ref-format', '--branch', branch]).status !== 0 || !branch.startsWith(PILOT_PREFIX)) throw new Refusal(`"${branch}" is not a valid kernel-pilot-* branch name`);
  const ignored = writeGuards(ctx, dir);
  logIgnored(ctx, tag, ignored);
  const mode = role === null ? 'initialise (no manifest)' : 'update with --Force (older installed protocol; the installer keeps its backups in .ai/backups)';
  ctx.keys = resolveKeys(ctx, o);
  const fx = factoryFacts(ctx.factory);
  const steps = [`git checkout -b ${branch} from ${x.defaultBranch} @ ${short(f.head)}`, `node <factory>/.ai/bin/protocol-setup.cjs --Target ${dir}${role === null ? '' : ' --Force'}  (${mode})`,
    `commit "chore(protocol): base protocol from the factory @ ${short(fx.head)}"`, `node <factory>/docs/ops/pilot-install.cjs --target ${dir} --update  (kit ${short(fx.head)}, then validator and kernel lint)`, ctx.keys.note];
  if (o.plan) { for (const s of steps) ctx.log(`${tag}: would ${s}`); ctx.log(`${tag}: nothing was changed`); return 0; }
  gitOk(dir, 'checkout', '-q', '-b', branch);
  ctx.log(`  setup ${x.name}| branch ${branch} created from ${x.defaultBranch} @ ${short(f.head)}`);
  const setupArgs = [path.join(ctx.factory, '.ai', 'bin', 'protocol-setup.cjs'), '--Target', dir];
  if (role !== null) setupArgs.push('--Force');
  const s = runNode(ctx, ctx.factory, setupArgs);
  for (const l of s.out.split(/\r?\n/).filter(l => /^(Done:|Previous versions saved to:|\[error\])/.test(l))) ctx.log(`  setup ${x.name}| protocol-setup: ${l}`);
  if (s.status !== 0) {
    ctx.log(`  setup ${x.name}| REMEDY: the base install failed on ${branch} and is left uncommitted in ${dir}; read the [error] line above, fix its cause, then  git add -A && git commit  there (or set the work aside with  git stash push -u -m fleet-setup-failed , owner's decision) and run  update-kit ${x.name}`);
    ctx.log(`${tag}: FAILED protocol-setup exit ${s.status}; branch ${branch} left uncommitted`);
    x.kernelBranch = branch;
    writeRegistry(ctx.registry, ctx.reg);
    return 1;
  }
  gitOk(dir, 'add', '-A');
  if (repoFacts(dir).changes.length) {
    gitOk(dir, 'commit', '-q', '-m', `chore(protocol): base protocol from the factory @ ${fx.head} (protocol-setup ${role === null ? 'initialise' : '--Force'})`);
    ctx.log(`  setup ${x.name}| base protocol committed (${short(gitOk(dir, 'rev-parse', 'HEAD'))})`);
  } else ctx.log(`  setup ${x.name}| base protocol already current, nothing to commit`);
  x.kernelBranch = branch;
  x.state = 'base';
  const k = runKitUpdate(ctx, x, dir, false, `setup ${x.name}`);
  writeRegistry(ctx.registry, ctx.reg);
  ctx.log(`${tag}: ${k.outcome}; ${ctx.keys.note}`);
  return k.code;
}

// ---- update-kit ----
function cmdUpdateKit(ctx, o) {
  const x = findProject(ctx.reg, o._[0]);
  const tag = `${o.plan ? 'plan ' : ''}update-kit ${x.name}`;
  if (x.state === 'owner-working') throw new Refusal(`${x.name} is marked owner-working in the registry; the tool never updates it`);
  const dir = x.paths[ctx.machine];
  if (!dir) throw new Refusal(`${x.name} has no path on ${ctx.machine}; run  pull-all --project ${x.name}  first`);
  const hit = ownerWorkingHit(ctx.reg, dir);
  if (hit) throw new Refusal(`${dir} is an owner working copy (${hit}); the tool never writes there`);
  const f = repoFacts(dir);
  if (!f.isRepo) throw new Refusal(`${dir} is not the root of a git repository`);
  if (f.dirty) throw new Refusal(`${dir} has ${f.changes.length} uncommitted or untracked path(s); the tool does not touch it: ${f.changes.slice(0, 5).join('; ')}`);
  const kb = x.kernelBranch && f.kernelBranches.includes(x.kernelBranch) ? x.kernelBranch : (f.kernelBranches.length === 1 ? f.kernelBranches[0] : null);
  if (!kb) throw new Refusal(f.kernelBranches.length ? `several kernel branches in ${dir} (${f.kernelBranches.join(', ')}); set kernelBranch in the registry` : `no kernel branch in ${dir}; run  setup ${x.name}  first`);
  // R12 for the fleet too: the update runs on the kernel branch the owner has checked out, and the tool never moves HEAD to get there
  if (f.branch !== kb) throw new Refusal(`${dir} is on ${f.branch ? `"${f.branch}"` : 'a detached HEAD'}, not on ${kb}; update-kit never switches branches (R12): run  git checkout ${kb}  there yourself, then run it again`);
  const ignored = writeGuards(ctx, dir);
  logIgnored(ctx, tag, ignored);
  const kab = aheadBehind(dir, kb, upstreamOf(f, kb));
  if (kab && kab.behind) throw new Refusal(`${kb} is ${kab.behind} commit(s) behind its upstream; run  pull-all --project ${x.name}  first`);
  // never a downgrade: the kit on the branch must come from a commit this factory contains
  const installedKit = kitOnBranch(dir, kb);
  const age = kitAge(ctx.factory, installedKit);
  if (age.state === 'unknown') throw new Refusal(`the kit on ${kb} is from factory commit ${short(installedKit)}, which this factory (${ctx.factory}) does not contain: ${age.text}. Update the factory first (git pull in it); the tool never installs an older kit over a newer one`);
  ctx.keys = null;
  const k = runKitUpdate(ctx, x, dir, o.plan, `update-kit ${x.name}`);
  if (!o.plan) { x.kernelBranch = kb; writeRegistry(ctx.registry, ctx.reg); }
  ctx.log(`${tag}: ${k.outcome}`);
  return k.code;
}

// ---- push-pilots ----
function cmdPushPilots(ctx, o) {
  const list = o.project ? [findProject(ctx.reg, o.project)] : ctx.reg.projects;
  let bad = 0;
  let changedRegistry = false;
  const publicUrls = new Set(ctx.reg.projects.filter(p => p.visibility === 'public').map(p => normUrl(p.url)));
  for (const x of list) {
    const tag = `${o.plan ? 'plan ' : ''}push-pilots ${x.name}`;
    let dirNow = null;
    try {
      if (x.state === 'owner-working') { ctx.log(`${tag}: SKIPPED owner working copy`); continue; }
      const dir = x.paths[ctx.machine];
      if (!dir) { ctx.log(`${tag}: SKIPPED no clone on ${ctx.machine}`); continue; }
      if (ownerWorkingHit(ctx.reg, dir)) { ctx.log(`${tag}: REFUSED ${dir} is an owner working copy`); bad++; continue; }
      dirNow = dir;
      const f = repoFacts(dir);
      if (!f.isRepo) { ctx.log(`${tag}: FAILED ${dir} is not a git repository root`); bad++; continue; }
      if (!f.kernelBranches.length) { ctx.log(`${tag}: SKIPPED no kernel branch (run setup first)`); continue; }
      if (f.dirty) { ctx.log(`${tag}: SKIPPED dirty working tree (${f.changes.length} path(s)); nothing pushed, no hook written`); bad++; continue; }
      const busy = busyOf(dir);
      if (busy.length) { ctx.log(`${tag}: SKIPPED busy clone; nothing pushed, no hook written: ${busyText(busy)}; ${BUSY_REMEDY}`); bad++; continue; }
      const kr = x.kernelRemote;
      // 1. the registry
      if (kr.visibility !== 'private') { ctx.log(`${tag}: REFUSED the registry says the kernel remote ${kr.url} is ${kr.visibility}; only a private one receives a kernel branch`); bad++; continue; }
      if (publicUrls.has(normUrl(kr.url))) { ctx.log(`${tag}: REFUSED ${kr.url} is the URL of a public project in the registry`); bad++; continue; }
      // 2. the remote in the clone (read only): where a push to it would really go; a URL other than the registry's is refused before the probe
      const rs = kernelRemoteState(dir, kr);
      if (!rs.ok) { ctx.log(`${tag}: REFUSED ${rs.note}`); bad++; continue; }
      if (publicUrls.has(normUrl(rs.pushUrl))) { ctx.log(`${tag}: REFUSED ${rs.pushUrl} is the URL of a public project in the registry`); bad++; continue; }
      // 3. the read-only probe, at push time, asked about that URL (the one the clone will use), not about the registry's spelling of it
      const probed = probeOf(ctx.deps, rs.pushUrl);
      if (probed !== 'private') { ctx.log(`${tag}: REFUSED the visibility probe says ${rs.pushUrl} is ${probed.toUpperCase()}; a kernel branch goes only to a repository that is private now`); bad++; continue; }
      const e = ensureKernelRemote(ctx, dir, kr, o.plan);
      if (!e.ok) { ctx.log(`${tag}: REFUSED ${e.note}`); bad++; continue; }
      // 4. the pre-push guard (second line of defence): a copy of the kit sample, never over a different hook
      const hookRel = gitOk(dir, 'rev-parse', '--git-path', 'hooks/pre-push');
      const hook = path.resolve(dir, hookRel);
      const sample = fs.readFileSync(path.join(ctx.factory, HOOK_SAMPLE));
      let hookNote;
      if (!fs.existsSync(hook)) {
        if (o.plan) hookNote = `would install the pre-push guard at ${hook}`;
        else { fs.mkdirSync(path.dirname(hook), { recursive: true }); fs.writeFileSync(hook, sample); try { fs.chmodSync(hook, 0o755); } catch { /* Windows */ } hookNote = 'pre-push guard installed'; }
      } else hookNote = fs.readFileSync(hook).equals(sample) ? 'pre-push guard present' : `a different pre-push hook is present at ${hook}; left as it is`;
      const branches = x.kernelBranch && f.kernelBranches.includes(x.kernelBranch) ? [x.kernelBranch] : f.kernelBranches;
      const notes = [e.note, hookNote].filter(Boolean);
      let failed = false;
      for (const b of branches) {
        if (o.plan) { notes.push(`would push ${b} to ${kr.name} (${kr.url}) and set its upstream`); continue; }
        // ALLOW_KERNEL_PILOT_PUSH=1 is the guard's documented one-push bypass, set only here, after the registry and the probe said private.
        const p = gitRun(dir, ['push', '--set-upstream', kr.name, `refs/heads/${b}:refs/heads/${b}`], { ...process.env, ALLOW_KERNEL_PILOT_PUSH: '1' });
        if (p.status !== 0) { failed = true; notes.push(`push ${b} FAILED: ${(p.err || p.out).replace(/\s+/g, ' ').slice(0, 200)}`); }
        else notes.push(`${b} pushed to ${kr.name}, upstream set`);
      }
      if (!o.plan && branches.length === 1 && x.kernelBranch !== branches[0]) { x.kernelBranch = branches[0]; changedRegistry = true; }
      if (failed) bad++;
      ctx.log(`${tag}: ${failed ? 'FAILED' : 'OK'} ${notes.join('; ')}`);
    } catch (e) { failureLine(ctx, tag, e, dirNow); bad++; }
  }
  if (changedRegistry) writeRegistry(ctx.registry, ctx.reg);
  return bad ? 1 : 0;
}

// ---- kernel-check ----
// Read only: asks the visibility probe about the kernel repository of every project (or one). Nothing is created here: when the probe cannot
// confirm a repository, the owner looks (gh repo view) and creates it only when it really is missing.
function cmdKernelCheck(ctx, o) {
  const list = o.project ? [findProject(ctx.reg, o.project)] : ctx.reg.projects;
  let bad = 0;
  for (const x of list) {
    const kr = x.kernelRemote;
    const tag = `kernel-check ${x.name}`;
    const gh = githubRepo(kr.url);
    const slugName = gh ? `${gh.owner}/${gh.repo}` : '<owner>/<repo>';
    const probed = probeOf(ctx.deps, kr.url);
    if (probed === 'public') { ctx.log(`${tag}: REFUSED ${kr.url} is PUBLIC; a kernel branch never goes to a public repository. Make it private first (repository settings)`); bad++; }
    else if (probed === 'private') ctx.log(`${tag}: OK ${kr.url} is private (probe)${kr.visibility === 'private' ? '' : `; the registry says ${kr.visibility}: set kernelRemote.visibility to private`}`);
    else { ctx.log(`${tag}: NOT CONFIRMED the probe could not see ${kr.url} (missing, no access, or gh is not installed or not logged in). Check with  gh repo view ${slugName} and, only when it really is missing,  gh repo create ${slugName} --private ; then run kernel-check again`); bad++; }
  }
  return bad ? 1 : 0;
}

// ---- doctor ----
function cmdDoctor(ctx) {
  let fails = 0;
  const row = (status, what, detail) => { if (status === 'FAIL') fails++; ctx.log(`[${status}] ${what}: ${detail}`); };
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  row(nodeMajor >= 18 ? 'OK' : 'FAIL', 'node', `v${process.versions.node}${nodeMajor >= 18 ? '' : ' (18 or newer needed)'}`);
  const gv = gitRun(ctx.factory, ['version']);
  row(gv.status === 0 ? 'OK' : 'FAIL', 'git', gv.status === 0 ? gv.out : 'not found');
  const gh = (ctx.deps.which || whichGh)();
  row(gh ? 'OK' : 'WARN', 'gh', gh || 'not found: the visibility probe answers "unknown", so add needs --visibility and push-pilots refuses');
  for (const k of ['user.name', 'user.email']) { const v = gitRun(ctx.factory, ['config', '--get', k]); row(v.status === 0 && v.out ? 'OK' : 'FAIL', `git config ${k}`, v.status === 0 && v.out ? 'set' : 'not set (commits of setup and update-kit need it)'); }
  const crlf = gitRun(ctx.factory, ['config', '--get', 'core.autocrlf']);
  row('OK', 'git config core.autocrlf', crlf.out || '(unset)');
  const fx = factoryFacts(ctx.factory);
  row(fx.role === 'source' ? 'OK' : 'FAIL', 'factory', `${ctx.factory} role "${fx.role}" @ ${short(fx.head)}${fx.dirty ? ' (tracked changes: an install records the factory as dirty)' : ''}`);
  if (fx.dirty) row('WARN', 'factory tree', 'tracked changes present');
  row('OK', 'machine id', `${ctx.machine}${ctx.deps.env.COLABS_MACHINE_ID ? ' (COLABS_MACHINE_ID)' : ' (host name)'}`);
  let rootOk = false;
  try { rootOk = fs.statSync(ctx.root).isDirectory(); } catch { /* absent */ }
  row(rootOk ? 'OK' : 'WARN', 'fleet root', `${ctx.root}${rootOk ? '' : ' does not exist yet (add or pull-all creates it)'}`);
  const problems = validateRegistry(ctx.reg);
  row(problems.length ? 'FAIL' : 'OK', 'registry', `${ctx.registry}: ${ctx.reg.projects.length} project(s)${problems.length ? `; ${problems.join('; ')}` : ''}`);
  for (const x of ctx.reg.projects) {
    const p = x.paths[ctx.machine];
    row('OK', `project ${x.name}`, `${x.visibility}, state ${x.state}, path on ${ctx.machine}: ${p ? `${p}${fs.existsSync(p) ? '' : ' (missing)'}` : 'none'}; owner working copies: ${(x.ownerWorking[ctx.machine] || []).map(w => `${w}${fs.existsSync(w) ? '' : ' (missing)'}`).join(', ') || 'none'}`);
  }
  ctx.log(`RESULT doctor exit=${fails ? 1 : 0} fails=${fails}`);
  return fails ? 1 : 0;
}
function whichGh() {
  if (process.env.NODE_TEST_CONTEXT) return null;
  const r = spawnSync('gh', ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  return r.status === 0 ? (r.stdout || '').split('\n')[0].trim() : null;
}

// ---- list ----
function cmdList(ctx, o) {
  const rows = ctx.reg.projects.map(x => ({ name: x.name, visibility: x.visibility, defaultBranch: x.defaultBranch, kernelRemote: x.kernelRemote, state: x.state, kitVersion: x.kitVersion, kernelBranch: x.kernelBranch || null, path: x.paths[ctx.machine] || null, ownerWorking: x.ownerWorking[ctx.machine] || [] }));
  if (o.json) { ctx.log(JSON.stringify({ machine: ctx.machine, root: ctx.root, projects: rows }, null, 2)); return 0; }
  for (const r of rows) ctx.log(`${r.name}  ${r.visibility}  ${r.defaultBranch}  state ${r.state}  kit ${short(r.kitVersion)}  kernel ${r.kernelRemote.name} ${r.kernelRemote.url} (${r.kernelRemote.visibility})  path ${r.path || '-'}${r.ownerWorking.length ? `  owner-working ${r.ownerWorking.join(' | ')}` : ''}`);
  ctx.log(`${rows.length} project(s); machine ${ctx.machine}; root ${ctx.root}`);
  return 0;
}
function cmdStatus(ctx, o) {
  const list = o.project ? [findProject(ctx.reg, o.project)] : ctx.reg.projects;
  const fx = factoryFacts(ctx.factory);
  const rows = list.map(x => projectStatus(ctx, x));
  if (o.json) { ctx.log(JSON.stringify({ machine: ctx.machine, root: ctx.root, factoryHead: fx.head, projects: rows }, null, 2)); return 0; }
  ctx.log(`machine ${ctx.machine}; root ${ctx.root}; factory ${ctx.factory} @ ${short(fx.head)}`);
  for (const s of rows) {
    const parts = [`path ${s.path || '-'}`];
    if (s.branch !== undefined) parts.push(`branch ${s.branch}`, s.dirty ? `DIRTY (${s.changes})` : 'clean', s.upstream ? `ahead ${s.ahead} behind ${s.behind} of ${s.upstream}` : 'no upstream');
    if (s.kernelBranches) parts.push(`kernel branch ${s.kernelBranch || (s.kernelBranches.length ? s.kernelBranches.join('|') : 'none')}${s.kernelBranch ? (s.kernelUpstream ? ` (ahead ${s.kernelAhead} behind ${s.kernelBehind} of ${s.kernelUpstream})` : ' (not pushed)') : ''}`);
    if (s.kit) parts.push(`kit ${short(s.kitVersion)} ${s.kit}`);
    parts.push(`visibility ${s.visibility}`, `next: ${s.next}`);
    ctx.log(`${s.name}: ${parts.join('; ')}`);
  }
  return 0;
}

// ---- arguments and main ----
const VALUE_FLAGS = ['--registry', '--root', '--factory', '--machine', '--project', '--name', '--visibility', '--kernel-remote', '--keys'];
const BOOL_FLAGS = ['--plan', '--json'];
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const eq = a.indexOf('=');
    const key = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    if (VALUE_FLAGS.includes(key)) {
      const v = eq > 0 && a.startsWith('--') ? a.slice(eq + 1) : argv[++i];
      if (v === undefined || v === '') throw new Refusal(`${key} needs a value`);
      o[key.slice(2)] = v;
    } else if (BOOL_FLAGS.includes(a)) o[a.slice(2)] = true;
    else if (a.startsWith('-')) throw new Refusal(`unknown option ${a}`);
    else o._.push(a);
  }
  return o;
}
const USAGE = 'usage: node docs/ops/fleet/fleet.cjs list|status|add <url>|pull-all|setup <project>|update-kit <project>|push-pilots|kernel-check|doctor [--plan] [--json] [--project p] [--registry f] [--root d] [--factory d] [--machine id]';
const COMMANDS = { list: cmdList, status: cmdStatus, add: cmdAdd, 'pull-all': cmdPullAll, setup: cmdSetup, 'update-kit': cmdUpdateKit, 'push-pilots': cmdPushPilots, 'kernel-check': cmdKernelCheck, doctor: cmdDoctor };
const NEEDS_ARG = new Set(['add', 'setup', 'update-kit']);
const CHANGES = new Set(['add', 'pull-all', 'setup', 'update-kit', 'push-pilots']);

// deps: { log, env, probe(url) -> 'public'|'private'|'unknown', now: Date, hostname, isTTY, which() }; the CLI passes the real ones.
function main(argv, deps = {}) {
  const log = deps.log || (s => process.stdout.write(`${s}\n`));
  const env = deps.env || process.env;
  const d = { ...deps, log, env };
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === 'help') { log(USAGE); return cmd ? 0 : 2; }
  if (!COMMANDS[cmd]) { log(`unknown command "${cmd}"\n${USAGE}`); return 2; }
  let o;
  try { o = parseArgs(argv.slice(1)); } catch (e) { log(`usage error: ${e.message}`); return 2; }
  if (NEEDS_ARG.has(cmd) && o._.length !== 1) { log(`usage error: ${cmd} needs exactly one ${cmd === 'add' ? 'URL' : 'project name'}`); return 2; }
  if (!NEEDS_ARG.has(cmd) && o._.length) { log(`usage error: ${cmd} takes no positional argument (got ${o._.join(' ')})`); return 2; }
  if (o.plan && !CHANGES.has(cmd)) { log(`usage error: ${cmd} changes nothing; --plan is for add, pull-all, setup, update-kit and push-pilots`); return 2; }
  let machine;
  try { machine = safeMachineId(o.machine !== undefined ? o.machine : (env.COLABS_MACHINE_ID !== undefined ? env.COLABS_MACHINE_ID : (d.hostname || os.hostname()))); }
  catch { log('usage error: invalid canonical machine id'); return 2; }
  const ctx = {
    deps: d, log, machine, now: d.now || new Date(),
    root: path.resolve(o.root || env.COLABS_PILOTS_ROOT || DEFAULT_ROOT),
    factory: path.resolve(o.factory || DEFAULT_FACTORY),
    registry: path.resolve(o.registry || DEFAULT_REGISTRY),
  };
  try {
    ctx.reg = readRegistry(ctx.registry);
    const hit = ownerWorkingHit(ctx.reg, ctx.root);
    if (CHANGES.has(cmd) && hit) throw new Refusal(`the fleet root ${ctx.root} overlaps the owner working copy ${hit}`);
    return COMMANDS[cmd](ctx, o);
  } catch (e) {
    if (e instanceof Refusal) { log(`REFUSED: ${e.message}`); return 2; }
    if (/never called under node --test/.test(e.message)) throw e; // the test-only guard against a real gh call stays loud
    failureLine(ctx, `${o.plan ? 'plan ' : ''}${cmd}${NEEDS_ARG.has(cmd) && cmd !== 'add' ? ` ${o._[0]}` : ''}`, e, null);
    return 1;
  }
}

if (require.main === module) {
  let code;
  try { code = main(process.argv.slice(2), { isTTY: Boolean(process.stdin.isTTY) }); } catch (e) { process.stdout.write(`fleet: unexpected error: ${e.message}\n`); code = 1; }
  process.exitCode = code;
}

module.exports = { main, validateRegistry, readRegistry, checkGit, classifyFailure, ownerWorkingHit, githubRepo, normUrl, asciiJson, SCHEMA, STATES, PILOT_PREFIX, DEFAULT_ROOT };

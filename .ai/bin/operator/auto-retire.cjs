#!/usr/bin/env node
'use strict';
// Worktree retirement, Class A. Offline landed proof; dry-run is read-only.
// Installed kernel home (.ai/bin/operator); the source repository keeps a
// forwarding module at the former tools path. In an installed host it proves against the local
// integration branch and keeps task branches by default.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const G = require('../lib/path-safe.cjs');
// The candidate registry reader ships with the pilot kit, not with the base
// install: it is loaded only when a registry file exists, and a host that has
// a registry but no reader refuses instead of guessing.
function opsGuard() {
  try { return require('../../../docs/ops/ops-guard.cjs'); } catch { fail('REGISTRY_REFUSED'); }
}
const guard = {
  readRegistry: (...a) => opsGuard().readRegistry(...a),
  retireRows: (...a) => opsGuard().retireRows(...a),
};
const { secretIn } = require('../lib/secrets.cjs');
const { findSecretLeak } = require('../protocol-hooks.cjs');
const { decode, parseJsonUnique } = require('../lib/text-safe.cjs');
const { createLandedProof } = require('./landed-proof.cjs');
const fail = code => { throw new Error(code); };
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const PLAN_VERSION = hash(Buffer.concat([fs.readFileSync(__filename), fs.readFileSync(path.join(__dirname, 'landed-proof.cjs'))]));
function real(p, links = 0) {
  const absolute = path.resolve(p);
  try { return (fs.realpathSync.native || fs.realpathSync)(absolute); }
  catch (e) {
    // Windows App Execution Aliases can refuse realpath's open while their
    // symlink target is readable. Follow only an explicitly readable link,
    // then resolve its target normally; never accept a lexical path on denial.
    if (['EACCES', 'EPERM'].includes(e.code)) {
      try {
        if (links >= 40 || !fs.lstatSync(absolute).isSymbolicLink()) fail('PATH_REFUSED');
        return real(path.resolve(path.dirname(absolute), fs.readlinkSync(absolute)), links + 1);
      } catch { fail('PATH_REFUSED'); }
    }
    // Missing suffixes (a retired tree or a collector race) still resolve via
    // the nearest existing parent, including any junction in that parent.
    const parent = path.dirname(absolute);
    if (!['ENOENT', 'ENOTDIR'].includes(e.code) || parent === absolute) fail('PATH_REFUSED');
    return path.join(real(parent, links), path.basename(absolute));
  }
}
const key = p => { const s = real(p).replace(/\\/g, '/'); return process.platform === 'win32' ? s.toLowerCase() : s; };
const inside = (root, p) => {
  const r = key(root), value = key(p);
  return value === r || value.startsWith(r.endsWith('/') ? r : r + '/');
};
function gitRaw(repo, args, encoding = 'utf8') {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const k of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG)/.test(k)) delete env[k];
  const r = spawnSync('git', ['-c', 'core.hooksPath=disabled', '-c', 'core.quotepath=false', ...args], {
    cwd: repo, encoding, windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    env,
  });
  return r;
}
function git(repo, args, encoding = 'utf8') {
  const r = gitRaw(repo, args, encoding);
  if (r.error || r.status !== 0) fail('GIT_REFUSED');
  return r.stdout;
}
// R2: plan mode is read-only and runs no content filter. Every git call of the
// plan runs with system and global config disabled (GIT_CONFIG_NOSYSTEM,
// GIT_CONFIG_GLOBAL pointing at the null device), optional locks off, fsmonitor
// and hooks disabled, and the plan never calls git status. Dirty state is the
// advisory approximation ls-files --others --exclude-standard (untracked names,
// no filters) plus diff-files --name-only (stat only); apply re-checks it with
// the full inventory.
function gitPlanRaw(repo, args, encoding = 'utf8', timeout = 60000) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const k of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG)/.test(k)) delete env[k];
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = process.platform === 'win32' ? 'NUL' : require('node:os').devNull;
  const result = spawnSync('git', ['-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=disabled', '-c', 'core.quotepath=false', ...args], {
    cwd: repo, encoding, windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout, killSignal: 'SIGKILL',
    env,
  });
  if (result.error?.code === 'ETIMEDOUT') fail('PLAN_TIMEOUT');
  return result;
}
function gitPlan(repo, args, encoding = 'utf8', timeout) {
  const r = gitPlanRaw(repo, args, encoding, timeout);
  // A2: an unknown git outcome is named GIT_UNKNOWN in plan mode, never a guess.
  if (r.error || r.status !== 0) fail('GIT_UNKNOWN');
  return r.stdout;
}
// A2: every raw git call of the plan is checked for BOTH the spawn
// error and the exit status; a non-zero status or a missing stdout is unknown.
const gitPlanUnknown = r => r.error || r.status !== 0 || typeof r.stdout !== 'string';
function safe(root, file, allowRoot = false) {
  const r = G.realInside(root, file, { allowRoot, refuseHardlinks: true });
  if (!r.ok) fail('PATH_REFUSED'); return r.real;
}
function read(root, file) {
  const r = G.readFileGuarded(root, file); if (!r.ok) fail('READ_REFUSED'); return r.bytes;
}
function jsonDecode(bytes) {
  const decoded = decode(bytes, { bom: 'refuse', crlf: 'normalise', invisible: 'refuse', finalNewline: 'report' });
  if (!decoded.ok) fail('READ_REFUSED');
  try { return parseJsonUnique(decoded.text); } catch { fail('READ_REFUSED'); }
}
function jsonRead(root, file) { return jsonDecode(read(root, file)); }
function mkdir(root, dir) {
  safe(root, dir, true);
  let cur = root;
  for (const part of path.relative(root, dir).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part); if (!G.mkdirGuarded(root, cur).ok) fail('MKDIR_REFUSED');
  }
}
function write(root, file, bytes) {
  mkdir(root, path.dirname(file));
  if (!G.writeAtomicGuarded(file, bytes, { root }).ok) fail('WRITE_REFUSED');
}
// The shared writer fsyncs payloads before publishing them. Compare again at
// publication so an existing foreign archive/receipt is never overwritten.
function preserve(root, file, bytes) {
  mkdir(root, path.dirname(file));
  const previous = fs.existsSync(file) ? read(root, file) : null;
  if (previous && !previous.equals(bytes)) fail('ARCHIVE_CONFLICT');
  if (!G.writeAtomicGuarded(file, bytes, { root, onTempWritten: () => {
    const current = fs.existsSync(file) ? read(root, file) : null;
    if (previous ? !current?.equals(previous) : current !== null) fail('ARCHIVE_CONFLICT');
  } }).ok) fail('WRITE_REFUSED');
}
const sensitive = (name, bytes) => /(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]*\.(?:pem|key|p12|pfx))$/i.test(name)
  || secretIn(bytes.toString('utf8')) || Boolean(findSecretLeak(bytes.toString('utf8')));
function worktrees(repo, call = git) {
  const fields = call(repo, ['worktree', 'list', '--porcelain', '-z']).split('\0');
  const rows = []; let row;
  for (const field of fields) {
    if (field.startsWith('worktree ')) { row = { path: field.slice(9) }; rows.push(row); }
    else if (field.startsWith('HEAD ')) row.head = field.slice(5);
    else if (field.startsWith('branch ')) row.branch = field.slice(7).replace(/^refs\/heads\//, '');
    else if (field.startsWith('locked')) row.locked = true;
    else if (field.startsWith('prunable')) row.prunable = true;
    else if (field === 'bare') row.bare = true;
  }
  return rows;
}
// A1: the process source is parsed with ONE closed grammar. The
// declared segment of the platform stat record is "pid (comm) state ppid ...
// starttime" (exactly 20 fields after the closing parenthesis): pid, ppid and
// the creation time are decimal digit strings, the state is one declared
// letter, the 17 intermediate fields are decimal integers. An empty field, a
// hex number, a non-digit, a missing field or an extra field in the declared
// segment makes the row unparsable (null) and the whole table
// PROCESS_UNKNOWN; created is required and never defaults to 0.
const PROC_STATE_LETTERS = /^[RSDZTtXxKWPI]$/;
const PROC_DIGITS = /^\d+$/;
const PROC_SIGNED = /^-?\d+$/;
function parseProcStat(text) {
  if (typeof text !== 'string') return null;
  const open = text.indexOf('('), close = text.lastIndexOf(')');
  if (open < 1 || close <= open || !PROC_DIGITS.test(text.slice(0, open - 1))) return null;
  const rest = text.slice(close + 2).split(' ');
  if (rest.length !== 20) return null; // exactly state..starttime: no missing and no extra field
  if (!PROC_STATE_LETTERS.test(rest[0])) return null;
  if (!PROC_DIGITS.test(rest[1]) || !PROC_DIGITS.test(rest[19])) return null;
  for (let i = 2; i < 19; i++) if (!PROC_SIGNED.test(rest[i])) return null;
  return { ppid: Number(rest[1]), created: Number(rest[19]) };
}
function processes({ identitiesOnly = false } = {}) {
  if (process.platform === 'win32') {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'auto-retire-processes.ps1'), ...(identitiesOnly ? ['-IdentitiesOnly'] : [])],
      { encoding: 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 * 1024 });
    if (r.status !== 0 || r.error) return null;
    try { const v = JSON.parse(r.stdout); return Array.isArray(v) ? v : [v]; } catch { return null; }
  }
  if (process.platform !== 'linux') return null;
  const rows = [];
  const attempt = f => { try { return { v: f() }; } catch (e) { return { e }; } };
  const refused = e => e && (e.code === 'EACCES' || e.code === 'EPERM');
  try {
    for (const pid of fs.readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
      const cwd = attempt(() => fs.readlinkSync(`/proc/${pid}/cwd`));
      const cmd = attempt(() => fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0/g, ' '));
      const exe = attempt(() => fs.readlinkSync(`/proc/${pid}/exe`));
      const stat = attempt(() => fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
      if (stat.e) {
        if (!fs.existsSync(`/proc/${pid}`)) continue;
        if (!identitiesOnly) return null;
        rows.push({ pid: Number(pid), ppid: null, created: null });
        continue;
      }
      // A1: the collector hands the parser the declared segment of the record
      // (fields state..starttime, 20 tokens after the comm); the closed grammar
      // refuses malformed, missing or extra fields and one unparsable row makes
      // the whole table PROCESS_UNKNOWN.
      const closeP = stat.v.lastIndexOf(')');
      const tokens = closeP >= 0 ? stat.v.slice(closeP + 2).trimEnd().split(' ') : [];
      const parsed = parseProcStat(tokens.length >= 20 ? `${stat.v.slice(0, closeP + 2)}${tokens.slice(0, 20).join(' ')}` : stat.v);
      if (!parsed) return null;
      if (identitiesOnly && /^[ZXx]$/.test(tokens[0])) continue; // terminal, awaiting the parent's reap
      if (cwd.e && !fs.existsSync(`/proc/${pid}`)) continue; // exited while collecting
      rows.push({ pid: Number(pid), ppid: parsed.ppid, created: parsed.created, cwd: cwd.v ?? null, cmd: cmd.v ?? '', exe: exe.v ?? null, state: cwd.e ? (refused(cwd.e) ? 'denied' : 'unreadable') : 'ok' });
    }
    rows.push(ROOT_MARKER); // A5: the enumeration is complete, so a pid not in the table is absent
    return rows;
  } catch { return null; }
}
// G1 self-exclusion by structure. The tool removes exactly its own row and the rows
// of its ancestors (the shell and wrappers whose command line names the tree
// because they started the tool) from the structured table, by pid and parent pid.
// Command-line text never excludes anything.
// A5: the chain from the tool's own pid is followed upward and
// ends ONLY at a row whose parent is a declared platform root pid (one constant:
// 0, or the system idle/system pids on Windows), or at a parent pid the table's
// own root marker declares absent (the collectors enumerate every process, so a
// pid missing from a marked table is provably exited). ANY other missing parent
// pid, a cycle, a duplicate row or a missing own row is PROCESS_UNKNOWN.
// R1: identity is the pair (pid, creation time), never the pid alone. Every row on
// the chain must carry the creation time its process was started with; a row that
// holds an ancestor pid but was created after its supposed descendant is a reused
// pid, not the ancestor: the chain ends there and the row stays to block like any
// other process. A missing or unparsable creation time on the chain is
// PROCESS_UNKNOWN. A row is removed only when both pid and creation time match.
const isPid = v => Number.isSafeInteger(v) && v >= 0;
const isStamp = v => Number.isSafeInteger(v) && v >= 0;
// The table's own root marker: the table is a complete enumeration of the
// platform's processes, so any pid absent from it is declared absent.
const ROOT_MARKER = { rootMarker: 'complete' };
const isRootMarker = p => p && typeof p === 'object' && !Array.isArray(p) && p.rootMarker === 'complete';
// The declared platform root pids: init's parent 0 everywhere, plus the system
// idle (0) and system (4) pids named on Windows.
const ROOT_PIDS = new Set(process.platform === 'win32' ? [0, 4] : [0]);
function withoutSelf(rows, self = { pid: process.pid, ppid: process.ppid }) {
  if (!Array.isArray(rows) || !isPid(self?.pid) || !isPid(self?.ppid)) fail('PROCESS_UNKNOWN');
  const complete = rows.some(isRootMarker);
  const byPid = new Map();
  for (const p of rows) if (!isRootMarker(p) && p && typeof p === 'object' && !Array.isArray(p) && isPid(p.pid)) byPid.set(p.pid, [...(byPid.get(p.pid) || []), p]);
  const chain = new Map(); // pid -> the creation time an ancestor row must carry
  let pid = self.pid, prevCreated = null;
  for (let depth = 0; ; depth++) {
    const found = byPid.get(pid);
    if (!found) {
      // A5: only the table's own root marker may declare the parent absent; the
      // own row is never allowed to be missing.
      if (depth === 0 || !complete) fail('PROCESS_UNKNOWN');
      break;
    }
    if (found.length !== 1 || !isPid(found[0].ppid) || chain.has(pid)) fail('PROCESS_UNKNOWN');
    if (depth === 0 && found[0].ppid !== self.ppid) fail('PROCESS_UNKNOWN');
    if (!isStamp(found[0].created)) fail('PROCESS_UNKNOWN');
    // An ancestor is created before its descendant; a row holding an ancestor pid
    // with a newer creation time is a reused pid and is not that ancestor.
    if (prevCreated !== null && found[0].created > prevCreated) break;
    chain.set(pid, found[0].created); prevCreated = found[0].created;
    if (ROOT_PIDS.has(found[0].ppid)) break; // the chain ends at the declared platform root
    pid = found[0].ppid;
  }
  return rows.filter(p => !(p && typeof p === 'object' && !Array.isArray(p)
    && isPid(p.pid) && chain.has(p.pid) && chain.get(p.pid) === p.created));
}
const text = v => typeof v === 'string' && v.length > 0;
// Conservative path-token scan, not a shell interpreter. Retain the literal
// check too. Resolve quoted/unquoted argv and option values via the row's cwd;
// never execute, expand variables, or persist command-line text.
function commandInside(tree, cmd, cwd) {
  const tokens = cmd.matchAll(/"([^"]*)"|'([^']*)'|([^\s"']+)/g);
  for (const token of tokens) {
    const value = token[1] ?? token[2] ?? token[3];
    const candidates = [value];
    if (value.includes('=')) candidates.push(value.slice(value.indexOf('=') + 1));
    for (const p of candidates) {
      if (!p || (!path.isAbsolute(p) && !text(cwd))) continue;
      if (inside(tree, path.isAbsolute(p) ? p : path.resolve(cwd, p))) return true;
    }
  }
  return false;
}
// A row that names the tree by cwd, image path or command line is live, whatever
// else is unknown. A row whose cwd could not be read blocks every tree
// (PROCESS_UNKNOWN) unless the collector marked it state 'denied': the OS refused
// the handle, so it belongs to another principal or is a protected system process
// and is counted, not guessed about. A row without a state is conservative: unknown.
function active(tree, rows) {
  if (!Array.isArray(rows)) fail('PROCESS_UNKNOWN');
  let unknown = false, denied = 0;
  for (const p of rows) {
    if (isRootMarker(p)) continue;
    if (!p || typeof p !== 'object' || Array.isArray(p)) { unknown = true; continue; }
    const cmd = text(p.cmd) ? p.cmd.replace(/\\/g, '/') : '';
    if ((text(p.cwd) && inside(tree, p.cwd)) || (text(p.exe) && inside(tree, p.exe))
      || (cmd && ((process.platform === 'win32' ? cmd.toLowerCase() : cmd).includes(key(tree))
        || commandInside(tree, p.cmd, p.cwd)))) fail('LIVE_PROCESS');
    if (p.state === 'denied') { denied++; continue; }
    if (p.state !== 'ok' || !text(p.cwd) || typeof p.cmd !== 'string') unknown = true;
  }
  if (unknown) fail('PROCESS_UNKNOWN');
  return { denied };
}
// Inventory all ordinary files, including ignored files and journals in Git.
// Secret payloads retain only their names and hashes.
// Links, hardlinks, submodules, and special files refuse instead of being followed.
// Keep-branches mode: a tracked regular file whose working bytes are exactly the
// HEAD blob stays recoverable from the kept branch, so it is listed with its
// sha256 and inHead: true but not copied. Every other file (untracked, ignored,
// changed) is copied and verified as before.
const gitBlobId = (bytes, length) => crypto.createHash(length === 64 ? 'sha256' : 'sha1')
  .update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`), bytes])).digest('hex');
const stored = f => !f.omitted && !f.inHead;
function headBlobs(tree) {
  return new Map(git(tree, ['ls-tree', '-r', '-z', 'HEAD']).split('\0').filter(Boolean).map(row => {
    const tab = row.indexOf('\t'), meta = row.slice(0, tab).split(' ');
    return [row.slice(tab + 1), { mode: meta[0], type: meta[1], sha: meta[2] }];
  }));
}
function inventory(tree, blobs = null) {
  safe(path.parse(path.resolve(tree)).root, tree, true);
  const files = []; let newest = fs.statSync(tree).mtimeMs;
  function walk(dir) {
    for (const name of fs.readdirSync(dir).sort()) {
      const file = safe(tree, path.join(dir, name)); const st = fs.lstatSync(file);
      newest = Math.max(newest, st.mtimeMs);
      const rel = path.relative(tree, file).split(path.sep).join('/');
      if (rel === '.git') { if (!st.isFile()) fail('GIT_DESCRIPTOR_REFUSED'); continue; }
      // A nested repository or worktree (registered elsewhere or not) would be deleted with the tree.
      if (name.toLowerCase() === '.git') fail('NESTED_GIT_REFUSED');
      if (st.isDirectory()) walk(file);
      else if (st.isFile()) {
        const bytes = read(tree, file);
        const blob = blobs && blobs.get(rel);
        const inHead = Boolean(blob && blob.type === 'blob' && /^100(?:644|755)$/.test(blob.mode) && gitBlobId(bytes, blob.sha.length) === blob.sha);
        files.push({ path: rel, sha256: hash(bytes), size: st.size, ...(sensitive(rel, bytes) ? { omitted: 'secret' } : {}), ...(inHead ? { inHead: true } : {}) });
      }
      else fail('SPECIAL_FILE_REFUSED');
    }
  }
  walk(tree);
  const staged = stagedArchive(tree);
  return { files, newest, descriptorSha256: hash(read(tree, path.join(tree, '.git'))), stagedPatchSha256: hash(staged.patch), stagedOmitted: staged.omitted };
}
function stagedArchive(tree) {
  if (git(tree, ['ls-files', '--unmerged', '-z']).length) fail('INDEX_UNMERGED');
  const names = git(tree, ['diff', '--cached', '--name-only', '-z', '--no-renames', 'HEAD', '--']).split('\0').filter(Boolean);
  const blobs = args => new Map(git(tree, args).split('\0').filter(Boolean).map(row => {
    const tab = row.indexOf('\t'), meta = row.slice(0, tab).split(' ');
    return [row.slice(tab + 1), { mode: meta[0], sha: meta[1] === 'blob' ? meta[2] : meta[1] }];
  }));
  const head = blobs(['ls-tree', '-r', '-z', 'HEAD']), index = blobs(['ls-files', '--stage', '-z']);
  const allowed = [], omitted = [];
  for (const name of names) {
    const versions = {};
    for (const [label, blob] of [['head', head.get(name)], ['index', index.get(name)]]) {
      if (!blob) continue;
      if (!/^100(?:644|755)$/.test(blob.mode)) fail('SPECIAL_FILE_REFUSED');
      versions[label] = git(tree, ['cat-file', 'blob', blob.sha], null);
    }
    if (sensitive(name, Buffer.alloc(0)) || Object.values(versions).some(bytes => sensitive(name, bytes))) {
      omitted.push({ path: name, ...Object.fromEntries(Object.entries(versions).map(([label, bytes]) => [`${label}Sha256`, hash(bytes)])), omitted: 'secret' });
    } else allowed.push(`:(literal)${name}`);
  }
  return { patch: allowed.length ? git(tree, ['diff', '--cached', '--binary', '--full-index', '--no-renames', '--no-ext-diff', '--no-textconv', 'HEAD', '--', ...allowed], null) : Buffer.alloc(0), omitted };
}
function sameSnapshot(a, b) { return JSON.stringify(a) === JSON.stringify(b); }
function checkOperation(tree) {
  const admin = git(tree, ['rev-parse', '--absolute-git-dir']).trim();
  for (const name of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG']) {
    if (fs.existsSync(path.join(admin, name))) fail('OPERATION_IN_PROGRESS');
  }
  return admin;
}
// A tree that contains, or sits inside, another registered worktree is never retired:
// removing it would delete the other tree with whatever it holds.
const nested = (wt, list) => list.some(o => key(o.path) !== key(wt.path) && (inside(wt.path, o.path) || inside(o.path, wt.path)));
// One archive folder per tree identity: two trees named alike never share a folder.
const identity = p => `${path.basename(p)}-${hash(Buffer.from(key(p))).slice(0, 16)}`;
// No retirement while a landing is running: the operator lock is held by land/close,
// and a landing record that is preparing, ready or closing still owns its scratch trees.
function landingGate(repo) {
  const common = path.resolve(repo, git(repo, ['rev-parse', '--git-common-dir']).trim());
  if (fs.existsSync(path.join(common, 'operator.lock'))) fail('LANDING_IN_PROGRESS');
  const kit = path.join(common, 'operator-kit');
  if (!fs.existsSync(kit)) return;
  safe(path.parse(kit).root, kit, true);
  for (const name of fs.readdirSync(kit).filter(n => /^state-[0-9a-f]{16}\.json$/.test(n))) {
    let data; try { data = jsonRead(kit, path.join(kit, name)); } catch { fail('LANDING_STATE_UNKNOWN'); }
    if (!data || typeof data.landings !== 'object' || data.landings === null || Array.isArray(data.landings)) fail('LANDING_STATE_UNKNOWN');
    if (Object.values(data.landings).some(l => !l || typeof l !== 'object' || ['preparing', 'ready', 'closing'].includes(l.status))) fail('LANDING_IN_PROGRESS');
  }
}
// Update real operator-kit candidates, including states produced on other hosts.
// The common operator lock excludes launch/landing writers during this CAS update.
function retireOperatorState(repo, wt, registry) {
  const common = path.resolve(repo, git(repo, ['rev-parse', '--git-common-dir']).trim());
  const kit = path.join(common, 'operator-kit');
  const rows = fs.existsSync(registry) ? guard.readRegistry(registry).rows.filter(r => r.branch === wt.branch && r.sha === wt.head && r.status === 'retired') : [];
  if (!fs.existsSync(kit) && !rows.length) return;
  const lock = path.join(common, 'operator.lock');
  try { fs.mkdirSync(lock); } catch { fail('LANDING_IN_PROGRESS'); }
  try {
    // Re-read under the common lock before the state loader can consume it.
    for (const name of fs.existsSync(kit) ? fs.readdirSync(kit).filter(n => /^state-[0-9a-f]{16}\.json$/.test(n)) : []) {
      try { jsonRead(kit, path.join(kit, name)); } catch { fail('LANDING_STATE_UNKNOWN'); }
    }
    // The landing state module ships with the pilot kit; operator-kit state
    // without it is unknown, never guessed.
    let stateModule; try { stateModule = require('../../../tools/operator/state.cjs'); } catch { fail('LANDING_STATE_UNKNOWN'); }
    const ctx = stateModule.createContext({ repo });
    const current = ctx.load(); let added = false;
    for (const row of rows) if (!Object.hasOwn(current.candidates, row.stream)) {
      current.candidates[row.stream] = { stream: row.stream, branch: wt.branch, sha: wt.head, status: 'retired' }; added = true;
    }
    if (added) ctx.save(current);
    for (const name of fs.readdirSync(kit).filter(n => /^state-[0-9a-f]{16}\.json$/.test(n))) {
      const file = path.join(kit, name), before = read(kit, file);
      let state; try { state = jsonRead(kit, file); } catch { fail('LANDING_STATE_UNKNOWN'); }
      let changed = false;
      if (!state.candidates || typeof state.candidates !== 'object' || Array.isArray(state.candidates)) fail('LANDING_STATE_UNKNOWN');
      for (const candidate of Object.values(state.candidates)) {
        if (candidate.branch === wt.branch && candidate.sha === wt.head && candidate.status === 'landed') {
          candidate.status = 'retired'; changed = true;
        }
      }
      if (changed && !G.writeAtomicGuarded(file, Buffer.from(JSON.stringify(state, null, 2) + '\n'), { root: kit,
        onTempWritten: () => { if (!read(kit, file).equals(before)) fail('TREE_CHANGED'); } }).ok) fail('WRITE_REFUSED');
    }
  } finally { fs.renameSync(lock, `${lock}.${crypto.randomUUID()}.released`); }
}
function stateChecks(main, tree, registry, branch, head, now) {
  if (fs.existsSync(registry)) {
    const rows = guard.readRegistry(registry);
    if (rows.problems.length) fail('REGISTRY_REFUSED');
    if (rows.rows.some(r => (r.branch === branch || r.sha === head) && !['landed', 'retired', 'superseded', 'void'].includes(r.status))) fail('LIVE_CANDIDATE');
  }
  const session = require('../protocol-session.cjs');
  for (const runtime of new Set([path.join(main, '.ai/runtime'), path.join(tree, '.ai/runtime')])) {
    if (!fs.existsSync(runtime)) continue;
    safe(path.parse(runtime).root, runtime, true);
    for (const name of fs.readdirSync(runtime)) {
      if (name === 'claims.json') {
        let data; try { data = jsonRead(runtime, path.join(runtime, name)); } catch { fail('CLAIMS_UNKNOWN'); }
        if (!data || !Array.isArray(data.claims)) fail('CLAIMS_UNKNOWN');
        for (const claim of data.claims) {
          if (!claim || typeof claim !== 'object' || Array.isArray(claim) || !text(claim.since)
            || !Number.isFinite(Date.parse(claim.since)) || !Number.isFinite(claim.ttlMin) || claim.ttlMin < 0
            || (claim.worktree !== undefined && (!text(claim.worktree) || !path.isAbsolute(claim.worktree)))) fail('CLAIMS_UNKNOWN');
          if (Date.parse(claim.since) + claim.ttlMin * 60000 > now
            && (!claim.worktree || inside(tree, claim.worktree) || inside(claim.worktree, tree))) fail('LIVE_CLAIM');
        }
      } else if (key(runtime) === key(path.join(tree, '.ai/runtime')) && (/^[a-z][a-z0-9-]*-[0-9a-f]{8,}\.json$/.test(name) || name === 'shared-writer.json')) {
        let record; try { record = jsonRead(runtime, path.join(runtime, name)); } catch { fail('SESSION_UNKNOWN'); }
        if (!record || typeof record !== 'object' || Array.isArray(record)) fail('SESSION_UNKNOWN');
        if (session.isSessionAlive(record) !== false) fail('LIVE_SESSION');
      }
    }
  }
}
// G2 quick plan: read-only, advisory, cheap conditions only. It reads the
// protocol manifest and the candidate registry of the main tree and never any
// file content of a candidate tree (no inventory, no hash, no read()): git
// metadata, directory listings and mtimes only. A candidate here is never a
// permission to delete.
const PLAN_HEADER = [
  'AUTO-RETIRE PLAN: advisory and read-only. It reads the protocol manifest and the candidate registry',
  'of the main tree; the plan code itself reads no candidate tree file content (metadata, process tables',
  'and git calls only): worktree list --porcelain -z, rev-parse, check-ref-format, merge-base',
  '--is-ancestor, ls-files --others --exclude-standard -z, diff-files --name-only -z, ls-files -z.',
  'Landing proof also uses log --format and for-each-ref --contains (heads/archive pins);',
  'one immutable line-tip history and repeated-head proof are shared within each plan.',
  'The only plan write is an atomic advisory checkpoint after each tree; resume is advisory too.',
  'Git itself may read ignore files (.gitignore) and the Git index, so changed .gitignore bytes change',
  'the untracked names. Stated limits of the cheap check: the age condition is top-level mtimes only',
  '(a deep recent edit is invisible); the dirty check is stat-only and misses staged-only changes; the',
  'file count is git ls-files only (ignored files are not counted).',
  'A candidate is NOT a permission to delete: --apply re-checks everything with the full inventory',
  '(hashes, archive verification, tree unchanged at removal, locks, operator lock).',
];
// R3: an unreadable archive listing never becomes an empty one. The tree is a
// candidate only when the listing was read completely: any read error (ENOTDIR
// included) or a link/junction entry inside the archive refuses the listing and
// is never followed. Receipt names compare case-insensitively on Windows, where
// the filesystem itself does.
// A4: lstat decides BEFORE any exists or readdir
// test, everywhere in the archive. A link of any kind (junction, symlink,
// dangling) at the base or at any dated entry is UNKNOWN; the base simply
// missing is the empty first-run archive; any other lstat or readdir error,
// ENOTDIR included, is UNKNOWN (null), never an empty set.
const ARCHIVE_UNKNOWN = null;
// F-04: ONE case-folding function for receipt names, used by the plan's listing,
// the plan's receipt check and the apply/dry-run recovery scan alike. Windows
// compares names case-insensitively, where the filesystem itself does; elsewhere
// the comparison is exact, exactly as the plan has always done it.
const foldArchiveName = n => process.platform === 'win32' ? n.toLowerCase() : n;
function archiveNames(base) {
  const names = new Set();
  let root; try { root = fs.lstatSync(base); } catch (e) {
    if (e.code !== 'ENOENT') return ARCHIVE_UNKNOWN;
    // A dangling link is UNKNOWN, never the empty first-run archive. On Windows
    // the lstat of a dangling junction reports ENOENT, so the parent listing
    // decides: an entry with the base's name is a link or a race, not an absent
    // archive.
    try {
      const parent = path.dirname(base), name = path.basename(base);
      if (fs.readdirSync(parent, { withFileTypes: true }).some(d => foldArchiveName(d.name) === foldArchiveName(name))) return ARCHIVE_UNKNOWN;
    } catch (e2) { if (e2.code !== 'ENOENT') return ARCHIVE_UNKNOWN; }
    return names; // the base is simply missing: the empty first-run archive
  }
  if (!root.isDirectory() || root.isSymbolicLink()) return ARCHIVE_UNKNOWN;
  let days; try { days = fs.readdirSync(base); } catch { return ARCHIVE_UNKNOWN; }
  for (const day of days) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const dir = path.join(base, day);
    let entry; try { entry = fs.lstatSync(dir); } catch { return ARCHIVE_UNKNOWN; }
    if (!entry.isDirectory() || entry.isSymbolicLink()) return ARCHIVE_UNKNOWN;
    let list; try { list = fs.readdirSync(dir); } catch { return ARCHIVE_UNKNOWN; }
    for (const n of list) names.add(foldArchiveName(n));
  }
  return names;
}
function planTable({ repo, main, trees, ref, tip, now, hours, base, protectedBranch, scan, gitC, gitRawC, prove, budget, o }) {
  const seconds = (value, fallback) => {
    const n = value === undefined ? fallback : Number(value);
    if (!Number.isFinite(n) || n <= 0) fail('TIME_REFUSED');
    return n;
  };
  const treeMs = seconds(o.treeTimeoutSeconds, 60) * 1000;
  const totalEnd = o.totalTimeoutSeconds === undefined ? Infinity : performance.now() + seconds(o.totalTimeoutSeconds, 60) * 1000;
  const partial = path.resolve(o.partialFile || path.join(main, '.ai/runtime/auto-retire-plan.json'));
  const runtime = path.join(main, '.ai/runtime');
  if (!partial.endsWith('.json') || trees.some(w => inside(w.path, partial) && !(key(w.path) === key(main) && inside(runtime, partial)))) fail('PARTIAL_REFUSED');
  const partialRoot = inside(runtime, partial) ? main : path.dirname(partial);
  const config = hash(Buffer.from(JSON.stringify({ ref, hours, base, treeMs, total: o.totalTimeoutSeconds ?? null })));
  let prior;
  if (fs.existsSync(partial)) {
    prior = jsonRead(partialRoot, partial);
    if (prior.schema !== 'auto-retire-plan/2' || !Array.isArray(prior.entries)) fail('PARTIAL_REFUSED');
  }
  if (o.resume && (!prior || prior.tip !== tip || prior.toolVersion !== PLAN_VERSION || prior.config !== config)) fail('RESUME_STALE');
  const rows = scan(); // a table-level refusal (PROCESS_UNKNOWN) refuses the whole plan
  const names = archiveNames(base);
  const workArea = path.dirname(main);
  // R4: cheap apply refusals the plan lists instead of hiding: a concurrently
  // running apply holds the lock, and an in-progress git operation owns the tree.
  const busyLock = fs.existsSync(path.join(main, '.ai/runtime/auto-retire.lock'));
  const entries = [];
  const checkpoint = () => write(partialRoot, partial, Buffer.from(JSON.stringify({ schema: 'auto-retire-plan/2', tip, toolVersion: PLAN_VERSION, config, entries }, null, 2) + '\n'));
  for (const wt of trees) {
    const previous = o.resume && prior.entries.find(e => e.path === wt.path && e.head === wt.head && e.branch === (wt.branch ?? null) && !e.reasons?.includes('PLAN_TIMEOUT'));
    if (previous) { entries.push({ ...previous, resumed: true }); checkpoint(); continue; }
    const start = performance.now();
    budget.end = Math.min(start + treeMs, totalEnd);
    const reasons = [];
    const entry = { path: wt.path, head: wt.head, branch: wt.branch ?? null, plan: 'keep', reasons, files: null };
    entries.push(entry);
    const add = r => { if (!reasons.includes(r)) reasons.push(r); };
    try {
      budget.check();
      if ([main, repo, process.cwd()].some(p => inside(wt.path, p)) || protectedBranch(wt.branch)) add('PROTECTED_TREE');
      if (!inside(workArea, wt.path)) add('OUTSIDE_WORK_AREA');
      if (wt.locked || wt.prunable || wt.bare || !wt.head || !fs.existsSync(wt.path)) { add('WORKTREE_UNAVAILABLE'); continue; }
      if (nested(wt, trees)) add('NESTED_WORKTREE');
      if (busyLock) add('RETIRE_BUSY');
      const admin = gitC(wt.path, ['rev-parse', '--absolute-git-dir']).trim();
      if (['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG'].some(n => fs.existsSync(path.join(admin, n)))) add('OPERATION_IN_PROGRESS');
      const proof = prove(wt);
      budget.check();
      if (!proof.ok) {
        entry.landingReason = proof.detail;
        if (proof.reason === 'GIT_REFUSED') add('GIT_REFUSED');
        else add('NOT_LANDED');
      } else { entry.landedBy = proof.landedBy; entry.landedEvidence = proof.evidence; }
      const untracked = gitRawC(wt.path, ['ls-files', '--others', '--exclude-standard', '-z']);
      if (gitPlanUnknown(untracked)) add('GIT_UNKNOWN'); else if (untracked.stdout.length) add('UNSAVED_CHANGES');
      const modified = gitRawC(wt.path, ['diff-files', '--name-only', '-z']);
      if (gitPlanUnknown(modified)) add('GIT_UNKNOWN'); else if (modified.stdout.length) add('UNSAVED_CHANGES');
      try { active(wt.path, rows); } catch (e) { add(e.message === 'LIVE_PROCESS' ? 'LIVE_PROCESS' : 'PROCESS_UNKNOWN'); }
      let newest = fs.statSync(wt.path).mtimeMs;
      for (const n of fs.readdirSync(wt.path)) { budget.check(); newest = Math.max(newest, fs.lstatSync(path.join(wt.path, n)).mtimeMs); }
      if (now - newest < hours * 3600000) add('TOO_RECENT');
      entry.files = gitC(wt.path, ['ls-files', '-z']).split('\0').filter(Boolean).length;
      const receipt = `retirement-${identity(wt.path)}.json`;
      if (names === ARCHIVE_UNKNOWN) add('ARCHIVE_UNKNOWN');
      else if (names.has(foldArchiveName(receipt))) add('ARCHIVE_RECEIPT_PRESENT');
      budget.check();
    } catch (e) { add(/^[A-Z_]+$/.test(e.message) ? e.message : 'PLAN_REFUSED'); }
    finally {
      entry.elapsedMs = performance.now() - start;
      if (performance.now() >= budget.end) add('PLAN_TIMEOUT');
      if (!reasons.length) entry.plan = 'candidate';
      budget.end = Infinity;
      checkpoint();
    }
  }
  const lines = [...PLAN_HEADER, `integration ${ref} ${tip}`, `at ${new Date(now).toISOString()}  age threshold ${hours} h`, '',
    ['plan', 'tree', 'branch', 'files', 'reasons', 'landedBy'].join(' | '),
    ...entries.map(e => [e.plan, e.path.replace(/\\/g, '/'), e.branch ?? '(detached)', e.files ?? '-', e.reasons.map(r => r === 'NOT_LANDED' && e.landingReason ? `${r}:${e.landingReason}` : r).join(',') || '-', e.landedBy ?? '-'].join(' | '))];
  return { schema: 'auto-retire-plan/2', toolVersion: PLAN_VERSION, partialFile: partial, mode: 'plan', advisory: PLAN_HEADER.join(' '), integration: ref, tip, entries, text: lines.join('\n') + '\n' };
}
function run(o = {}) {
  if (o.plan && (o.apply || o.targets)) fail('USAGE');
  if (!o.plan && [o.partialFile, o.resume, o.treeTimeoutSeconds, o.totalTimeoutSeconds].some(v => v !== undefined)) fail('USAGE');
  const budget = { end: Infinity, check() { if (performance.now() >= this.end) fail('PLAN_TIMEOUT'); } };
  const remaining = () => { budget.check(); return Math.max(1, Math.min(60000, Math.ceil(budget.end - performance.now()))); };
  // R2: in plan mode every git call, including the prelude, runs sanitized.
  const gitC = o.plan ? (r, a, e) => gitPlan(r, a, e, remaining()) : git;
  const gitRawC = o.plan ? (r, a, e) => gitPlanRaw(r, a, e, remaining()) : gitRaw;
  const repo = fs.realpathSync(o.repo || process.cwd());
  const trees = worktrees(repo, gitC); const main = trees[0]?.path;
  if (!main || trees[0].bare) fail('MAIN_UNKNOWN');
  const manifest = jsonRead(main, path.join(main, 'protocol-manifest.json'));
  // An installed host lands task branches LOCALLY into its integration branch
  // (usually by squash, with a Landed-Tip trailer) and keeps task branches as
  // history. The kernel source proves against the pushed remote-tracking ref
  // and deletes merged branches. Explicit options override either default.
  const host = manifest.role === 'installed';
  if (o.local && o.remote !== undefined) fail('USAGE');
  if (o.keepBranches && o.deleteBranches) fail('USAGE');
  const local = o.local === true || (host && o.remote === undefined && manifest.integrationRemote === undefined);
  const keepBranches = o.keepBranches === true || (host && o.deleteBranches !== true);
  const branch = o.integrationBranch || manifest.integrationBranch;
  const remote = o.remote || manifest.integrationRemote || 'origin';
  if (typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || !/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(remote)) fail('INTEGRATION_UNKNOWN');
  gitC(repo, ['check-ref-format', `refs/heads/${branch}`]);
  const configuredProtected = manifest.protectedBranches || [];
  if (!Array.isArray(configuredProtected) || configuredProtected.some(b => typeof b !== 'string' || !b)) fail('INTEGRATION_UNKNOWN');
  const protectedBranches = new Set([branch, 'main', 'master', ...configuredProtected].map(b => b.toLowerCase()));
  const protectedBranch = name => typeof name === 'string' && protectedBranches.has(name.toLowerCase());
  const ref = local ? `refs/heads/${branch}` : `refs/remotes/${remote}/${branch}`;
  const tip = gitC(repo, ['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  const now = o.now === undefined ? Date.now() : o.now;
  const hours = o.ageHours === undefined ? 24 : Number(o.ageHours);
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isFinite(hours) || hours < 0) fail('TIME_REFUSED');
  const targets = o.targets?.map(key);
  if (targets && !targets.length) fail('TARGETS_EMPTY');
  const registry = path.join(main, '.ai/runtime/CANDIDATES.md');
  if (fs.existsSync(registry) && guard.readRegistry(registry).problems.length) fail('REGISTRY_REFUSED');
  const newProof = () => {
    const data = fs.existsSync(registry) ? guard.readRegistry(registry) : { rows: [], problems: [] };
    if (data.problems.length) fail('REGISTRY_REFUSED');
    return createLandedProof({ repo, line: tip, raw: gitRawC, registryRows: data.rows, host });
  };
  const prove = newProof();
  function landed(wt, entry, proof = prove) {
    const p = proof(wt);
    if (!p.ok) {
      entry.landingReason = p.detail;
      if (p.reason === 'GIT_REFUSED') fail('GIT_REFUSED');
      fail('NOT_LANDED');
    }
    entry.landedBy = p.landedBy; entry.landedEvidence = p.evidence;
  }
  const date = new Date(now).toISOString().slice(0, 10);
  // Default archive: inside the main worktree (committed by the documented operator step).
  // Optional archiveRoot: an existing directory outside every registered worktree.
  let aroot = main, base = path.join(main, 'docs/ops/journals-archive');
  if (o.archiveRoot !== undefined) {
    // F-03 (A4): lstat decides FIRST. A link of any kind (junction, symlink,
    // dangling) at the archive root is refused before any resolution or stat;
    // existsSync/statSync would follow it and resolve the link.
    if (typeof o.archiveRoot !== 'string' || !path.isAbsolute(o.archiveRoot)) fail('ARCHIVE_ROOT_REFUSED');
    let rootStat; try { rootStat = fs.lstatSync(o.archiveRoot); } catch { fail('ARCHIVE_ROOT_REFUSED'); }
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) fail('ARCHIVE_ROOT_REFUSED');
    aroot = fs.realpathSync(o.archiveRoot); base = aroot;
    if (trees.some(w => inside(w.path, aroot))) fail('ARCHIVE_ROOT_REFUSED');
  }
  const archive = path.join(base, date);
  safe(aroot, archive);
  const getProcesses = o.processes || processes;
  // G1: every liveness test sees the table without the tool's own row and its ancestors.
  const selfInfo = o.self || { pid: process.pid, ppid: process.ppid };
  const scan = () => withoutSelf(getProcesses(), selfInfo);
  // The plan is advisory and stops here: it never reads the landing state JSONs
  // (operator-kit), never takes the operator lock and never touches the archive.
  if (o.plan) return planTable({ repo, main, trees, ref, tip, now, hours, base, protectedBranch, scan, gitC, gitRawC, prove, budget, o });
  landingGate(repo);
  const result = { schema: 'auto-retire/1', mode: o.apply ? 'apply' : 'dry-run', at: new Date(now).toISOString(), integration: ref, tip, host, keepBranches, archive: { dir: archive, insideMain: aroot === main }, entries: [] };
  const remove = o.remove || (w => git(repo, ['worktree', 'remove', '--force', '--', w.path]));
  // Keep-branches: the branch of a removed tree is never deleted; it pins the
  // HEAD whose unchanged files were not copied. Deletion happens only when it
  // was asked for and only for a branch that is an ancestor of the integration.
  const pinnedByBranch = wt => keepBranches && Boolean(wt.branch)
    && git(repo, ['rev-parse', '--verify', `refs/heads/${wt.branch}^{commit}`]).trim() === wt.head;
  function deleteBranch(entry) {
    if (keepBranches) { if (entry.branch) entry.branchKept = true; return; }
    if (entry.branch && !protectedBranch(entry.branch) && !worktrees(repo).some(w => w.branch === entry.branch)) {
      try {
        if (git(repo, ['rev-parse', `refs/heads/${entry.branch}`]).trim() !== entry.head) return;
        git(repo, ['merge-base', '--is-ancestor', `refs/heads/${entry.branch}`, ref]);
        git(repo, ['branch', '-d', '--', entry.branch]); entry.branchDeleted = true;
      } catch { entry.branchDeleted = false; }
    }
  }
  function verifyArchive(entry, dir) {
    const destination = path.join(dir, entry.identity);
    for (const f of entry.files) if (stored(f) && hash(read(aroot, path.join(destination, f.path))) !== f.sha256) fail('ARCHIVE_MISMATCH');
    if (entry.stagedPatch && hash(read(aroot, `${destination}.index.patch`)) !== entry.stagedPatch.sha256) fail('ARCHIVE_MISMATCH');
  }
  let lock;
  if (o.apply) {
    mkdir(main, path.join(main, '.ai/runtime'));
    lock = path.join(main, '.ai/runtime/auto-retire.lock'); safe(main, lock);
    try { fs.mkdirSync(lock); } catch { fail('RETIRE_BUSY'); }
  }
  try {
  // A crash can happen after git removed the tree but before branch/receipt work.
  // Search historical date folders as well: a retry may run on the next UTC day.
  const receiptRefusals = new Set();
  if (fs.existsSync(base)) for (const day of fs.readdirSync(base).filter(n => /^\d{4}-\d{2}-\d{2}$/.test(n))) {
    const dir = safe(aroot, path.join(base, day));
    for (const name of fs.readdirSync(dir).filter(n => /^retirement-.+\.json$/.test(foldArchiveName(n)))) {
      const file = path.join(dir, name);
      let entry = { path: file, action: 'keep', files: [] };
      try {
        const before = read(aroot, file), saved = jsonDecode(before);
        if (!saved || typeof saved !== 'object' || Array.isArray(saved)) fail('READ_REFUSED');
        if (saved.phase !== 'registry') continue;
        const candidate = saved.entry;
        if (!candidate || !text(candidate.path) || !path.isAbsolute(candidate.path)) fail('ARCHIVE_CONFLICT');
        if (targets && !targets.includes(key(candidate.path))) continue;
        entry = { ...candidate, action: 'keep' };
        if (saved.schema !== 'auto-retire/1' || saved.integration !== ref || entry.identity !== identity(entry.path)
          || foldArchiveName(name) !== foldArchiveName(`retirement-${entry.identity}.json`) || !/^[a-f0-9]{40}$/.test(entry.head)
          || protectedBranch(entry.branch)
          || [main, repo, process.cwd()].some(p => inside(p, entry.path) || inside(entry.path, p))) fail('ARCHIVE_CONFLICT');
        if (trees.some(w => key(w.path) === key(entry.path)) || fs.existsSync(entry.path)) continue;
        result.entries.push(entry);
        landed(entry, entry, newProof());
        active(entry.path, scan()); stateChecks(main, entry.path, registry, entry.branch, entry.head, now); landingGate(repo);
        verifyArchive(entry, dir);
        if (!o.apply) { entry.action = 'would-complete'; continue; }
        entry.action = 'retired'; entry.treeRemoved = true;
        retireOperatorState(repo, entry, registry); deleteBranch(entry);
        if (!read(aroot, file).equals(before)) fail('ARCHIVE_CONFLICT');
        write(aroot, file, Buffer.from(JSON.stringify({ ...saved, phase: 'completed', entry }, null, 2) + '\n'));
      } catch (e) {
        // A corrupt receipt cannot authorize recovery. A live tree's own
        // receipt check below keeps it; unrelated trees continue normally.
        const associated = trees.find(w => foldArchiveName(name) === foldArchiveName(`retirement-${identity(w.path)}.json`));
        if (associated) {
          receiptRefusals.add(key(associated.path));
          if (entry.path === file) continue;
        }
        if (!result.entries.includes(entry)) result.entries.push(entry);
        entry.reason = /^[A-Z_]+$/.test(e.message) ? e.message : 'RETIRE_REFUSED';
      }
    }
  }
  for (const wt of trees) {
    if (targets && !targets.includes(key(wt.path))) continue;
    const entry = { ...wt, action: 'keep', files: [] }; result.entries.push(entry);
    try {
      if (inside(wt.path, main) || inside(wt.path, repo) || inside(wt.path, process.cwd())) fail('PROTECTED_TREE');
      if (protectedBranch(wt.branch)) fail('PROTECTED_TREE');
      if (wt.locked || wt.prunable || wt.bare || !wt.head) fail('WORKTREE_UNAVAILABLE');
      if (nested(wt, trees)) fail('NESTED_WORKTREE');
      if (receiptRefusals.has(key(wt.path))) fail('ARCHIVE_CONFLICT');
      landed(wt, entry);
      entry.processesDenied = active(wt.path, scan()).denied;
      stateChecks(main, wt.path, registry, wt.branch, wt.head, now);
      const admin = checkOperation(wt.path);
      const blobs = pinnedByBranch(wt) ? headBlobs(wt.path) : null;
      const inv = inventory(wt.path, blobs);
      const activity = Math.max(inv.newest, fs.statSync(path.join(admin, 'HEAD')).mtimeMs);
      if (now - activity < hours * 3600000) fail('TOO_RECENT');
      entry.identity = identity(wt.path);
      const destination = path.join(archive, entry.identity); safe(aroot, destination);
      const receipt = path.join(archive, `retirement-${entry.identity}.json`);
      let receiptBytes = fs.existsSync(receipt) ? read(aroot, receipt) : null;
      if (receiptBytes) {
        let previous; try { previous = jsonDecode(receiptBytes); } catch { fail('ARCHIVE_CONFLICT'); }
        if (!previous || typeof previous !== 'object' || Array.isArray(previous)) fail('ARCHIVE_CONFLICT');
        if (!['intent', 'registry'].includes(previous.phase) || previous.integration !== ref || previous.entry?.path !== wt.path
          || previous.entry.head !== wt.head || previous.entry.branch !== wt.branch || previous.entry.identity !== entry.identity
          || previous.snapshot !== hash(Buffer.from(JSON.stringify(inv)))) fail('ARCHIVE_CONFLICT');
      }
      // The index can hold bytes different from both HEAD and the working file.
      // A binary patch preserves non-secret staged versions and deletions.
      const patch = stagedArchive(wt.path).patch;
      const patchFile = safe(aroot, `${destination}.index.patch`);
      if (patch.length && fs.existsSync(patchFile) && hash(read(aroot, patchFile)) !== inv.stagedPatchSha256) fail('ARCHIVE_CONFLICT');
      for (const f of inv.files) {
        if (f.omitted) continue;
        if (f.inHead) continue;
        const dest = safe(aroot, path.join(destination, f.path));
        if (fs.existsSync(dest) && hash(read(aroot, dest)) !== f.sha256) fail('ARCHIVE_CONFLICT');
      }
      entry.files = inv.files;
      entry.stagedOmitted = inv.stagedOmitted;
      if (!o.apply) { entry.action = 'would-retire'; continue; }
      if (patch.length) {
        preserve(aroot, patchFile, patch);
        if (hash(read(aroot, patchFile)) !== inv.stagedPatchSha256) fail('ARCHIVE_MISMATCH');
        entry.stagedPatch = { path: patchFile, sha256: inv.stagedPatchSha256 };
      }
      for (const f of inv.files) {
        if (f.omitted) continue;
        if (f.inHead) continue;
        const dest = safe(aroot, path.join(destination, f.path));
        const bytes = read(wt.path, path.join(wt.path, f.path));
        if (hash(bytes) !== f.sha256) fail('TREE_CHANGED');
        preserve(aroot, dest, bytes);
        if (hash(read(aroot, dest)) !== f.sha256) fail('ARCHIVE_MISMATCH');
      }
      // Order of operations (recoverable at every step; a re-run completes the rest):
      //   archive bytes -> intent receipt -> rechecks -> registry transition + receipt -> removal -> branch.
      // The receipt has one stable name per tree identity and is rewritten at each phase.
      const record = phase => {
        const bytes = Buffer.from(JSON.stringify({ ...result, phase, snapshot: hash(Buffer.from(JSON.stringify(inv))), entry }, null, 2) + '\n');
        mkdir(aroot, path.dirname(receipt));
        if (!G.writeAtomicGuarded(receipt, bytes, { root: aroot, onTempWritten: () => {
          const current = fs.existsSync(receipt) ? read(aroot, receipt) : null;
          if (receiptBytes ? !current?.equals(receiptBytes) : current !== null) fail('ARCHIVE_CONFLICT');
        } }).ok) fail('WRITE_REFUSED');
        receiptBytes = bytes;
      };
      record('intent');
      active(wt.path, scan());
      stateChecks(main, wt.path, registry, wt.branch, wt.head, now);
      checkOperation(wt.path);
      landingGate(repo);
      if (git(repo, ['rev-parse', ref]).trim() !== tip || git(wt.path, ['rev-parse', 'HEAD']).trim() !== wt.head) fail('TIP_CHANGED');
      const list = worktrees(repo); const fresh = list.find(w => key(w.path) === key(wt.path));
      if (!fresh || fresh.locked || fresh.branch !== wt.branch || nested(fresh, list) || !sameSnapshot(inv, inventory(wt.path, blobs))) fail('TREE_CHANGED');
      for (const f of inv.files) if (stored(f) && hash(read(aroot, path.join(destination, f.path))) !== f.sha256) fail('ARCHIVE_MISMATCH');
      if (patch.length && hash(read(aroot, patchFile)) !== inv.stagedPatchSha256) fail('ARCHIVE_MISMATCH');
      landed(wt, entry, newProof());
      // The registry transition comes first: when it fails the tree is still intact.
      // When removal fails afterwards the row already says retired and the next run
      // removes the tree (stateChecks accepts retired rows, retireRows is idempotent).
      if (fs.existsSync(registry)) {
        try { entry.registryRows = guard.retireRows(registry, { branch: wt.branch, sha: wt.head, now, repo }); } catch { fail('REGISTRY_TRANSITION_FAILED'); }
      }
      entry.registryState = fs.existsSync(registry) && guard.readRegistry(registry).rows.some(r => r.branch === wt.branch && r.sha === wt.head && r.status === 'retired') ? 'retired' : 'not-present';
      entry.treeRemoved = false; entry.action = 'retirement-pending';
      record('registry');
      try { remove(wt); } catch { fail('REMOVE_FAILED'); }
      entry.action = 'retired';
      entry.treeRemoved = true;
      retireOperatorState(repo, wt, registry);
      // Only this tree's branch, never unrelated branches or a kept tree's branch.
      deleteBranch(entry);
      // The tree is gone: a failed final receipt is reported, never turned back into keep.
      try { record('completed'); } catch { entry.receiptFailed = true; }
    } catch (e) {
      if (!entry.treeRemoved) entry.action = 'keep';
      entry.reason = /^[A-Z_]+$/.test(e.message) ? e.message : 'RETIRE_REFUSED';
    }
  }
  if (o.apply) {
    const stamp = `run-${crypto.randomUUID()}`;
    try {
      write(aroot, path.join(archive, `${stamp}.json`), Buffer.from(JSON.stringify(result, null, 2) + '\n'));
      write(aroot, path.join(archive, `${stamp}.md`), Buffer.from('# AUTO-RETIRE\n\n' + result.entries.map(e => `- ${JSON.stringify(e.path)}: ${e.action}${e.reason ? ` (${e.reason})` : ''}`).join('\n') + '\n'));
    } catch { result.recordFailed = true; }
  }
  return result;
  } finally {
    // Retain lock history without deleting it. An interrupted run leaves the
    // active lock in place; an operator investigates it rather than stealing it.
    if (lock) fs.renameSync(safe(main, lock), safe(main, `${lock}.${crypto.randomUUID()}.done`));
  }
}
function main(argv) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--apply' && !o.apply) o.apply = true;
    else if (a === '--plan' && !o.plan) o.plan = true;
    else if (a === '--resume' && !o.resume) o.resume = true;
    else if (a === '--local' && !o.local) o.local = true;
    else if (a === '--keep-branches' && !o.keepBranches) o.keepBranches = true;
    else if (a === '--delete-branches' && !o.deleteBranches) o.deleteBranches = true;
    else if (['--root', '--integration-branch', '--remote', '--age-hours', '--tree', '--archive-root', '--partial-file', '--tree-timeout-seconds', '--total-timeout-seconds'].includes(a) && argv[i + 1] && !argv[i + 1].startsWith('--')) {
      const k = { '--root': 'repo', '--integration-branch': 'integrationBranch', '--remote': 'remote', '--age-hours': 'ageHours', '--tree': 'targets', '--archive-root': 'archiveRoot', '--partial-file': 'partialFile', '--tree-timeout-seconds': 'treeTimeoutSeconds', '--total-timeout-seconds': 'totalTimeoutSeconds' }[a];
      if (k === 'targets') (o.targets ||= []).push(path.resolve(argv[++i]));
      else { if (o[k] !== undefined) fail('USAGE'); o[k] = argv[++i]; }
    } else fail('USAGE');
  }
  const result = run(o);
  if (result.mode === 'plan') { process.stdout.write(result.text); return 0; }
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  const refusals = result.entries.filter(e => e.reason && !['PROTECTED_TREE', 'TOO_RECENT', 'LIVE_PROCESS', 'GIT_REFUSED', 'NOT_LANDED', 'NESTED_WORKTREE'].includes(e.reason));
  // Keep stdout machine-readable and disclose only closed reason codes.
  for (const reason of new Set(refusals.map(e => e.reason)))
    process.stderr.write((/^[A-Z_]+$/.test(reason) ? reason : 'RETIRE_REFUSED') + '\n');
  return refusals.length ? 1 : 0;
}
if (require.main === module) { try { process.exitCode = main(process.argv.slice(2)); } catch (e) { process.stderr.write((/^[A-Z_]+$/.test(e.message) ? e.message : 'RETIRE_REFUSED') + '\n'); process.exitCode = 1; } }
module.exports = { run, main, processes, parseProcStat, archiveNames, active, inventory, worktrees, identity, withoutSelf, isRootMarker };

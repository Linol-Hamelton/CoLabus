'use strict';
// write-boundary: the cheap exact check that a seat did not create a new entry at the top of the work drive
// (TEMP hygiene design, layer 4; PROCESS-REGISTER.md P-149; owner scheme: gate only on cheap exact facts, otherwise a
// warning plus an audit counter).
//
// The launch wrapper lists the top-level entries of the work drive root before the seat starts and after it ends. An entry
// that appeared during the seat and is not on the allow list (write-boundary.allow.json, a data file of this
// repository) is a WARNING and one increment of its audit counter in the operator status report. The SAME entry, still
// present at the start of a later launch, is a REFUSAL: nothing is created for that launch, and the refusal names the entry,
// the allow-file line to add and the directory to remove. An entry that disappears or is added to the allow list loses its
// counter, so the refusal never becomes permanent by itself.
//
// The allow file also names the drive it describes: a boundary root on another drive is skipped with the named reason
// boundary-drive-not-in-allow-file, so a host project never inherits this machine's baseline. The check never depends on
// that baseline for a diff: only entries created DURING the seat count, so a pre-existing directory is never reported.
//
// External owner projects' registered linked worktrees are notes, not seat violations. Legacy counters can be migrated;
// new seat violations carry their origin so adding Git metadata later never clears them. Git reads have a fixed deadline.
// This module holds no deletion, no seat launch and no network; it reads listings, Git metadata and one audit JSON file.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const repoPaths = require('../../../.ai/bin/repo-paths.cjs');
const textSafe = require('../../../.ai/bin/lib/text-safe.cjs');

const BOUNDARY_ENV = 'OK_WRITE_BOUNDARY_ROOT';
const ALLOW_ENV = 'OK_WRITE_BOUNDARY_ALLOW';
const ALLOW_FILE_NAME = 'write-boundary.allow.json';
const AUDIT_FILE = 'write-boundary-audit.json';
const ALLOW_SCHEMA = 'write-boundary-allow/1';
const AUDIT_SCHEMA = 'write-boundary-audit/1';
const MAX_AUDIT = 100;

const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const lower = value => (process.platform === 'win32' ? value.toLowerCase() : value);
// realpath does not unify UNC/admin-share aliases with drive paths. Their ownership stays unproven.
const networkPath = value => /^[/\\]{2}/.test(value);

function inside(root, target) {
  const rel = path.relative(root, target);
  return !rel || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
}

// A linked worktree is owner work only when both it and its main repository are outside the seat/build areas.
// Git discovery is bounded and read-only; inherited GIT_* overrides cannot redirect the repository being checked.
function ownerPolicy({ repo, runtime, workRootDir, env, io }) {
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  const gitRead = (cwd, args) => {
    const r = spawnSync('git', ['-C', cwd, ...args], { env: gitEnv, encoding: 'utf8', windowsHide: true, timeout: 2000, maxBuffer: 65536 });
    if (r.error || r.signal || r.status !== 0) throw Error('GIT_DISCOVERY_FAILED');
    return r.stdout.trim();
  };
  const resolve = value => { try { return io.realpathSync(value); } catch { return path.resolve(value); } };
  repo = path.resolve(repo || repoPaths.FILE_REPO);
  let main;
  try {
    const common = gitRead(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    if (!path.isAbsolute(common) || path.basename(common) !== '.git') return null;
    main = path.dirname(common);
  }
  catch { return null; } // Unknown main checkout means no owner exemptions, including legacy migration.
  if (networkPath(repo) || networkPath(main)) return null;
  // Carry area overrides only: repository-root overrides must not replace the Git-discovered main checkout.
  const pathsEnv = { OPS_REPO_ROOT: main };
  for (const [key, value] of Object.entries(env || {})) {
    if (/_(?:WT|WORKTREE|TMP|TEMP|PILOTS)_(?:ROOT|DIR)$/.test(key)) pathsEnv[key] = value;
  }
  const roots = [repo, main, runtime, workRootDir, repoPaths.worktreesDir(pathsEnv, main), repoPaths.tempDir(pathsEnv, main), repoPaths.pilotsDir(pathsEnv, main)]
    .filter(Boolean).map(resolve);
  return { roots, resolve, gitRead };
}

function ownerWorktree(dir, policy, io = fs) {
  try {
    if (!policy || networkPath(dir)) return null;
    if (!io.lstatSync(dir).isDirectory() || !io.lstatSync(path.join(dir, '.git')).isFile()) return null;
    const real = policy.resolve(dir);
    if (networkPath(real) || policy.roots.some(root => inside(root, real))) return null;
    const fields = policy.gitRead(real, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--git-dir']).split(/\r?\n/);
    if (fields.length !== 3 || fields.some(networkPath) || !same(policy.resolve(fields[0]), real)) return null;
    const common = policy.resolve(fields[1]);
    const gitDir = policy.resolve(fields[2]);
    const project = path.dirname(common);
    if (networkPath(common) || networkPath(gitDir) || path.basename(common) !== '.git' || same(common, gitDir) ||
      !same(path.dirname(gitDir), path.join(common, 'worktrees')) ||
      policy.roots.some(root => inside(root, project) || inside(root, common) || inside(root, gitDir))) return null;
    // A copied/forged .git pointer is not a registered linked worktree.
    const backlink = io.readFileSync(path.join(gitDir, 'gitdir'), 'utf8').trim();
    if (!same(policy.resolve(backlink), policy.resolve(path.join(dir, '.git')))) return null;
    return { name: path.basename(dir), commonDir: common };
  } catch { return null; }
}

const ownerNote = rows => rows.length ? `NOTE write-boundary owner-worktree=${rows.map(row => row.name).join(',')} outside-seat-and-build-areas` : null;

// The DOS drive identifier or UNC share root, null for anything else (a host without a drive letters concept
// falls back to the boundary override only).
function driveOf(dir) {
  const resolved = path.resolve(dir);
  const m = /^([A-Za-z]:)[\\/]/.exec(resolved);
  if (m) return m[1].toUpperCase();
  const u = /^\\\\([^\\/]+)\\([^\\/]+)/.exec(resolved);
  return u ? `\\\\${u[1]}\\${u[2]}`.toLowerCase() : null;
}

// The work drive root: the explicit override of the environment, else the volume root of the resolved work root.
function boundaryRoot(workRootDir, env = process.env) {
  const override = env && env[BOUNDARY_ENV];
  if (typeof override === 'string' && override.trim()) return { dir: path.resolve(override), source: 'env' };
  if (!workRootDir) return { dir: null, source: null, reason: 'boundary-root-unresolved' };
  const volume = path.parse(path.resolve(workRootDir)).root;
  if (!volume || !driveOf(volume)) return { dir: null, source: null, reason: 'boundary-root-unresolved' };
  return { dir: volume, source: 'work-drive' };
}

function allowFileFor(repo, env = process.env) {
  const override = env && env[ALLOW_ENV];
  if (typeof override === 'string' && override.trim()) return path.resolve(override);
  return path.join(path.resolve(repo || path.join(__dirname, '..', '..')), 'docs', 'ops', ALLOW_FILE_NAME);
}

// null for a readable allow file, else { code, detail }. Names are single path segments; separators are refused.
function allowProblem(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return { code: 'ALLOW_NOT_OBJECT', detail: 'the allow file is not a JSON object' };
  if (j.schema !== ALLOW_SCHEMA) return { code: 'ALLOW_WRONG_SCHEMA', detail: `the schema is not ${ALLOW_SCHEMA}` };
  if (typeof j.drive !== 'string' || !/^(?:[A-Za-z]:|\\\\[^\\/]+\\[^\\/]+)$/.test(j.drive)) return { code: 'ALLOW_BAD_DRIVE', detail: 'the drive is not a DOS drive or a UNC share' };
  if (!Array.isArray(j.allow)) return { code: 'ALLOW_NOT_ARRAY', detail: 'allow is not an array' };
  for (const row of j.allow) {
    if (!row || typeof row !== 'object' || typeof row.name !== 'string' || !row.name.trim()) return { code: 'ALLOW_BAD_ROW', detail: 'every entry needs a name' };
    if (/[\\/]/.test(row.name) || row.name.trim() === '.' || row.name.trim() === '..') return { code: 'ALLOW_BAD_NAME', detail: `not a single path segment: ${row.name}` };
    if (typeof row.reason !== 'string' || !row.reason.trim()) return { code: 'ALLOW_NO_REASON', detail: `the entry ${row.name} needs a reason` };
  }
  return null;
}

function loadAllow(file, io = fs) {
  let text;
  try { text = io.readFileSync(file); }
  catch (e) { return { ok: false, file, problem: { code: e && e.code === 'ENOENT' ? 'ALLOW_FILE_MISSING' : 'ALLOW_FILE_UNREADABLE', detail: String((e && e.code) || e) } }; }
  let parsed;
  try { parsed = readJson(text); }
  catch { return { ok: false, file, problem: { code: 'ALLOW_JSON', detail: 'the allow file is not valid JSON' } }; }
  const problem = allowProblem(parsed);
  if (problem) return { ok: false, file, problem };
  const names = new Set();
  for (const row of parsed.allow) names.add(lower(row.name.trim()));
  return { ok: true, file, drive: parsed.drive.toUpperCase(), names };
}

// The listing is one readdir; the comparison is exactly by name (case-insensitive on Windows). No recursion, no stats.
function snapshot(dir, io = fs) {
  try {
    const names = new Map();
    for (const name of io.readdirSync(dir)) names.set(lower(name), name);
    return { ok: true, dir, names };
  } catch (e) { return { ok: false, dir, problem: { code: 'BOUNDARY_UNREADABLE', detail: String((e && e.code) || e) } }; }
}

function readAudit(file, io = fs) {
  let text;
  try { text = io.readFileSync(file); }
  catch (e) { return { schema: AUDIT_SCHEMA, updatedAt: null, entries: Object.create(null), ...(e.code === 'ENOENT' ? {} : { problem: 'AUDIT_UNREADABLE' }) }; }
  try {
    const j = readJson(text);
    if (!j || j.schema !== AUDIT_SCHEMA || !j.entries || typeof j.entries !== 'object' || Array.isArray(j.entries)) {
      return { schema: AUDIT_SCHEMA, updatedAt: null, entries: Object.create(null), problem: 'AUDIT_INVALID' };
    }
    if (Object.entries(j.entries).some(([key, row]) => !row || typeof row !== 'object' || Array.isArray(row) ||
      typeof row.name !== 'string' || lower(row.name) !== key || !Number.isSafeInteger(row.count) || row.count < 1)) {
      return { schema: AUDIT_SCHEMA, updatedAt: null, entries: Object.create(null), problem: 'AUDIT_INVALID' };
    }
    const owners = j.ownerWorktrees || {};
    if (typeof owners !== 'object' || Array.isArray(owners) || Object.entries(owners).some(([key, row]) =>
      !row || typeof row.name !== 'string' || lower(row.name) !== key || /[\\/]/.test(key) ||
      typeof row.commonDir !== 'string' || !path.isAbsolute(row.commonDir))) {
      return { schema: AUDIT_SCHEMA, updatedAt: null, entries: Object.create(null), problem: 'AUDIT_INVALID' };
    }
    return { schema: AUDIT_SCHEMA, updatedAt: typeof j.updatedAt === 'string' ? j.updatedAt : null, entries: Object.assign(Object.create(null), j.entries), ownerWorktrees: Object.assign(Object.create(null), owners) };
  } catch { return { schema: AUDIT_SCHEMA, updatedAt: null, entries: Object.create(null), problem: 'AUDIT_JSON' }; }
}

function readJson(text) {
  const decoded = textSafe.decode(Buffer.isBuffer(text) ? text : Buffer.from(text, 'utf8'), { invisible: 'refuse' });
  if (!decoded.ok) throw Error('JSON_TEXT');
  return textSafe.parseJsonUnique(decoded.text);
}

function writeAudit(file, audit, io = fs) {
  const tmp = `${file}.${process.pid}.${Date.now().toString(36)}.tmp`;
  const body = { schema: AUDIT_SCHEMA, updatedAt: new Date().toISOString(), entries: audit.entries, ownerWorktrees: audit.ownerWorktrees || {} };
  io.mkdirSync(path.dirname(file), { recursive: true });
  io.writeFileSync(tmp, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  io.renameSync(tmp, file);
  return body;
}

// Drop counters that no longer describe a fact: the entry is gone from the boundary root, or the allow list now carries it.
// An invalid audit is reported before pruning; its bytes are preserved for recovery.
function pruneAudit(audit, listing, allowNames) {
  const kept = Object.create(null);
  let dropped = 0;
  for (const [key, row] of Object.entries(audit.entries || {})) {
    if (!row || typeof row !== 'object' || typeof row.name !== 'string' || !Number.isSafeInteger(row.count) || row.count < 1) { dropped++; continue; }
    if (!listing.names.has(key) || allowNames.has(key)) { dropped++; continue; }
    kept[key] = row;
  }
  const rows = Object.values(kept).sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
  for (const row of rows.slice(MAX_AUDIT)) delete kept[lower(row.name)];
  return { entries: kept, dropped };
}

// The launch-start step: resolve the boundary, read the allow list, prune the counters against the current listing and
// REFUSE when a counted entry is still there (the same entry repeating). Pure except for the pruning write.
function prepare({ workRootDir, env = process.env, repo, runtime, io = fs } = {}) {
  const boundary = boundaryRoot(workRootDir, env);
  if (!boundary.dir) return { applied: false, reason: boundary.reason || 'boundary-root-unresolved' };
  const allowFile = allowFileFor(repo, env);
  const allow = loadAllow(allowFile, io);
  if (!allow.ok) return { applied: false, reason: allow.problem.code, problem: allow.problem, allowFile, boundary };
  const drive = driveOf(boundary.dir);
  if (!drive || !same(drive, allow.drive)) return { applied: false, reason: 'boundary-drive-not-in-allow-file', drive, allowDrive: allow.drive, allowFile, boundary };
  const listing = snapshot(boundary.dir, io);
  if (!listing.ok) return { applied: false, reason: listing.problem.code, problem: listing.problem, allowFile, boundary };
  const auditFile = path.join(path.resolve(runtime), AUDIT_FILE);
  const audit = readAudit(auditFile, io);
  if (audit.problem) return { applied: false, reason: audit.problem, auditFile, allowFile, boundary };
  const policy = ownerPolicy({ repo, runtime, workRootDir, env, io });
  const pruned = pruneAudit(audit, listing, allow.names);
  const owners = Object.assign(Object.create(null), audit.ownerWorktrees || {});
  const ownerWork = [];
  for (const key of Object.keys(owners)) if (!listing.names.has(key)) delete owners[key];
  // Migrate old counters that blamed an unrelated owner's worktree. A newly observed seat output keeps its origin forever.
  for (const [key, row] of Object.entries(pruned.entries)) {
    if (row.origin === 'seat') continue;
    const owner = ownerWorktree(path.join(boundary.dir, listing.names.get(key)), policy, io);
    if (!owner) continue;
    if (!owners[key] || !same(owners[key].commonDir, owner.commonDir)) ownerWork.push(owner);
    owners[key] = owner;
    delete pruned.entries[key];
  }
  const auditState = { schema: AUDIT_SCHEMA, updatedAt: audit.updatedAt, entries: pruned.entries, ownerWorktrees: owners };
  if (pruned.dropped || Object.keys(pruned.entries).length !== Object.keys(audit.entries || {}).length ||
    JSON.stringify(owners) !== JSON.stringify(audit.ownerWorktrees || {})) {
    try { writeAudit(auditFile, auditState, io); } catch { /* a counter that cannot be pruned still never refuses on a gone entry */ }
  }
  const repeated = Object.values(pruned.entries).sort((a, b) => a.name.localeCompare(b.name));
  const base = { applied: true, boundary, allow, allowFile, auditFile, allowDrive: allow.drive, listing, audit: auditState, dropped: pruned.dropped, policy, ownerWork, note: ownerNote(ownerWork) };
  if (repeated.length) {
    const names = repeated.slice(0, 5).map(r => r.name).join(', ');
    return {
      ...base,
      refusal: {
        code: 'WRITE_BOUNDARY_REPEATED',
        repeated,
        recovery: `add the entry to ${allowFile} (or remove ${path.join(boundary.dir, repeated[0].name)}); a repeated entry outside the allow list is refused`,
        line: `WRITE-BOUNDARY REFUSED code=WRITE_BOUNDARY_REPEATED entries=${repeated.length} (${names})`,
      },
    };
  }
  return base;
}

// The pre-seat listing. Taken after the wrapper created its own per-launch directory, so that directory is not "new".
function begin(ctx, io = fs) {
  if (!ctx || !ctx.applied) return null;
  return snapshot(ctx.boundary.dir, io);
}

// The post-seat step: the same listing again, the diff, and one audit increment per new entry outside the allow list.
// Never throws: a boundary that cannot be read is recorded as a problem and never blocks the launch's exit code.
function settle({ ctx, before, launchName, at = new Date().toISOString(), io = fs } = {}) {
  if (!ctx || !ctx.applied) return { applied: false, reason: (ctx && ctx.reason) || 'not-applied' };
  if (!before || before.ok !== true) return { applied: true, checked: false, problem: (before && before.problem) || { code: 'BOUNDARY_NO_BASELINE' } };
  const after = snapshot(ctx.boundary.dir, io);
  if (!after.ok) return { applied: true, checked: false, problem: after.problem, root: ctx.boundary.dir };
  const allowNames = ctx.allow && ctx.allow.names ? ctx.allow.names : new Set();
  const added = [...after.names.keys()].filter(key => !before.names.has(key));
  const allowed = added.filter(key => allowNames.has(key));
  const ownerWork = added.filter(key => !allowNames.has(key)).map(key => ownerWorktree(path.join(ctx.boundary.dir, after.names.get(key)), ctx.policy, io)).filter(Boolean);
  const ownerNames = new Set(ownerWork.map(row => lower(row.name)));
  const outside = added.filter(key => !allowNames.has(key) && !ownerNames.has(key));
  const gone = [...before.names.keys()].filter(key => !after.names.has(key));
  let audit = ctx.audit && ctx.audit.entries ? ctx.audit : readAudit(ctx.auditFile, io);
  const counted = [];
  const owners = audit.ownerWorktrees || (audit.ownerWorktrees = Object.create(null));
  const newOwners = ownerWork.filter(row => !owners[lower(row.name)] || !same(owners[lower(row.name)].commonDir, row.commonDir));
  for (const row of ownerWork) owners[lower(row.name)] = row;
  for (const key of outside) {
    const prev = audit.entries[key];
    const row = {
      name: after.names.get(key),
      count: (prev && Number.isSafeInteger(prev.count) ? prev.count : 0) + 1,
      firstSeen: prev && prev.firstSeen ? prev.firstSeen : at,
      lastSeen: at,
      lastLaunch: launchName || null,
      origin: 'seat',
    };
    audit.entries[key] = row;
    counted.push(row);
  }
  if (counted.length || newOwners.length) {
    try { audit = writeAudit(ctx.auditFile, audit, io); ctx.audit = audit; }
    catch (e) { return { applied: true, checked: true, root: ctx.boundary.dir, added, allowed, outside, counted, auditProblem: String((e && e.code) || e) }; }
  }
  const warning = outside.length
    ? `WARN write-boundary new=${outside.map(k => after.names.get(k)).join(',')} outside-the-allow-list=${outside.length} audit=${counted.map(r => `${r.name}:${r.count}`).join(',')}`
    : null;
  return {
    applied: true, checked: true, root: ctx.boundary.dir, allowFile: ctx.allowFile,
    added: added.map(k => after.names.get(k)), allowed: allowed.map(k => after.names.get(k)),
    outside: outside.map(k => after.names.get(k)), counted, gone: gone.map(k => before.names.get(k)), warning,
    ownerWork, note: ownerNote(newOwners),
  };
}

// The status-report counters: how many entries are counted and how many of them already repeated (count above one) or
// are one more sighting away from a refusal (count one, present at the last launch).
function counters(file, io = fs) {
  const audit = readAudit(file, io);
  const rows = Object.values(audit.entries).sort((a, b) => String(b.lastSeen || '').localeCompare(String(a.lastSeen || '')));
  const repeated = rows.filter(r => r.count > 1).length;
  const sample = rows.slice(0, 3).map(r => `${r.name}:${r.count}`).join(', ');
  return { entries: rows.length, repeated, rows, problem: audit.problem || null, line: `WRITE-BOUNDARY audit entries=${rows.length} repeated=${repeated}${sample ? ` (e.g. ${sample})` : ''}${audit.problem ? ` problem=${audit.problem}` : ''}` };
}

module.exports = {
  BOUNDARY_ENV, ALLOW_ENV, ALLOW_FILE_NAME, AUDIT_FILE, ALLOW_SCHEMA, AUDIT_SCHEMA,
  driveOf, boundaryRoot, allowFileFor, allowProblem, loadAllow, snapshot, readAudit, writeAudit, pruneAudit, prepare, begin, settle, counters,
};

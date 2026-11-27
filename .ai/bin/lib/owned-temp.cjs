'use strict';
// owned-temp: the helper that removes a temporary root after its creator has exited.
// The creator removes its own tree; the sweep settles trees left by a killed creator.
// Node builtins and run-temp.cjs only, so a driver that runs from
// a checkout holding this directory alone keeps working.
//
// A bare name or age is insufficient: even the legacy suite-name record must prove its owner dead. A root is removed only when ALL of these hold:
//   1. it is ONE plain directory (lstat: not a link) directly under a managed root the caller names, and the managed root is not a
//      filesystem root; the process working directory is not inside it;
//   2. an OWNER RECORD exists: the caller hands over the owner it read through its own strict reader (the launch marker of
//      docs/ops/lib/launch-marker.cjs, the owner file below, the test-tmp root marker, or - for the suite prefix only - the pid and
//      time the creator encoded in the name). No owner means "unowned": kept, counted, never removed;
//   3. the keep deadline of the record is absent or past (the cap eviction of the launch sweep is the one explicit exception);
//   4. the owner is DEAD: same host, and the pid is gone, or the pid is alive but its process started AFTER the root was created
//      (pid reuse). An unreadable process table, a foreign host or a live pid are all "alive": unknown never becomes permission.
// The removal itself never follows a link (run-temp.removeTree) and a failed removal is reported, never swallowed.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const runTemp = require('./run-temp.cjs');
const realPath = require('./real-path.cjs');

const OWNER_FILE = '.colabs-owner.json';
const OWNER_SCHEMA = 'temp-owner/1';
const TT_ROOT_FILE = '.test-tmp-root.json'; // the root marker of docs/ops/lib/test-tmp.cjs (colabs-tt-*), read here only for its pid and time
const LEGACY_GRACE_MS = 12 * 3600 * 1000; // a root with no owner record cannot say whether a kept-for-debugging root was meant: it gets the 12 hours a kept root gets
const SKEW_MS = 5000; // a process that started within this slack of the root's creation is its creator
const SUITE_NAME = /^colabs-suite-(\d+)-([0-9a-z]+)-[0-9a-f]{6}(?:-\d+)?$/;

// The physical path, or null when an existing object has no provable real path: unknown is never the same as anything.
const same = (a, b) => a !== null && b !== null && (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
const real = (p, io = fs) => { try { return realPath.forFs(io).physicalPathSync(p); } catch { return null; } };
const isoMs = v => { const n = typeof v === 'number' ? v : Date.parse(v); return Number.isFinite(n) ? n : null; };

// ---- liveness ----
// ESRCH is the only proof of absence. EPERM means the process exists under another account; any other error is unknown, so alive.
function pidAlive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return true;
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return true; } catch (e) { return !(e && e.code === 'ESRCH'); }
}
// Best effort start time (ms) of a LIVE pid, null when it cannot be read: null never proves reuse.
function processStartMs(pid, now = Date.now(), timeoutMs = 10000) {
  try {
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${Number(pid)} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`], { encoding: 'utf8', windowsHide: true, timeout: timeoutMs });
      return r.status === 0 ? isoMs(String(r.stdout || '').trim()) : null;
    }
    const r = spawnSync('ps', ['-o', 'etimes=', '-p', String(Number(pid))], { encoding: 'utf8', timeout: timeoutMs });
    const secs = Number(String(r.stdout || '').trim());
    return r.status === 0 && Number.isFinite(secs) ? now - secs * 1000 : null;
  } catch { return null; }
}
// { dead, reason }: the ownership proof of rule 4.
function ownerState(owner, deps = {}) {
  const isAlive = deps.isAlive || pidAlive;
  const startMs = deps.startMs || processStartMs;
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return { dead: false, reason: 'no-owner-pid' };
  if (owner.host && String(owner.host).toLowerCase() !== os.hostname().toLowerCase()) return { dead: false, reason: 'foreign-host' };
  if (!isAlive(owner.pid)) return { dead: true, reason: 'owner-dead' };
  if (owner.pid === process.pid) return { dead: false, reason: 'owner-alive' };
  const created = isoMs(owner.createdAt);
  const started = created === null ? null : startMs(owner.pid, deps.now);
  if (started !== null && started > created + SKEW_MS) return { dead: true, reason: 'pid-reused' };
  return { dead: false, reason: 'owner-alive' };
}

// ---- the owner records ----
// The owner file of a run root (colabs-suite-*, author-check-*): written exclusively by the creator right after its mkdir.
function writeOwnerFile(dir, fields = {}, io = fs) {
  const record = { schema: OWNER_SCHEMA, pid: process.pid, host: os.hostname(), createdAt: new Date().toISOString(), keepUntil: null, ...fields };
  io.writeFileSync(path.join(dir, OWNER_FILE), `${JSON.stringify(record)}\n`, { flag: 'wx' });
  return record;
}
function readOwnerFile(dir, io = fs) {
  let text;
  try { text = io.readFileSync(path.join(dir, OWNER_FILE), 'utf8'); } catch (e) { return e && e.code === 'ENOENT' ? { present: false } : { present: true, ok: false, problem: (e && e.code) || 'unreadable' }; }
  let j;
  try { j = JSON.parse(text); } catch { return { present: true, ok: false, problem: 'json' }; }
  const bad = !j || typeof j !== 'object' || j.schema !== OWNER_SCHEMA || !Number.isSafeInteger(j.pid) || j.pid < 1 || typeof j.host !== 'string'
    || isoMs(j.createdAt) === null || (j.keepUntil !== null && isoMs(j.keepUntil) === null);
  return bad ? { present: true, ok: false, problem: 'schema' } : { present: true, ok: true, owner: { pid: j.pid, host: j.host, createdAt: j.createdAt, keepUntil: j.keepUntil } };
}
// Keeping a root (KEEP_FIXTURES, a failed run) stamps the deadline into its own owner file; a record the reader refuses is never repaired.
function keepOwnerFile(dir, keepUntil, io = fs) {
  const r = readOwnerFile(dir, io);
  if (!r.ok) return false;
  io.writeFileSync(path.join(dir, OWNER_FILE), `${JSON.stringify({ schema: OWNER_SCHEMA, ...r.owner, keepUntil })}\n`);
  return true;
}
// The owner of a run-root directory, through whichever record its creator wrote. A record that cannot say "kept" (the test-tmp marker, the name)
// gets createdAt + 12 h as its deadline. { kind, owner } or { kind: 'unowned', why }.
// The name-derived owner exists ONLY for the suite prefix: its creator encoded its pid and its time into the leaf (run-temp.createRunTemp).
function runRootOwner(dir, io = fs) {
  const file = readOwnerFile(dir, io);
  if (file.present) return file.ok ? { kind: 'owner-file', owner: file.owner } : { kind: 'unowned', why: `owner file refused (${file.problem})` };
  try {
    const m = JSON.parse(io.readFileSync(path.join(dir, TT_ROOT_FILE), 'utf8'));
    if (m && m.schema === 'test-tmp-root/1' && Number.isSafeInteger(m.pid) && m.pid > 0 && isoMs(m.created) !== null) return { kind: 'test-tmp-marker', owner: { pid: m.pid, host: null, createdAt: m.created, keepUntil: new Date(isoMs(m.created) + LEGACY_GRACE_MS).toISOString() } };
  } catch { /* no test-tmp marker: the name decides below */ }
  const legacy = SUITE_NAME.exec(path.basename(dir));
  if (legacy) {
    const createdMs = parseInt(legacy[2], 36);
    const pid = Number(legacy[1]);
    if (Number.isSafeInteger(pid) && pid > 0 && createdMs > Date.UTC(2020, 0, 1) && createdMs < Date.now() + 86400000) {
      return { kind: 'suite-name', owner: { pid, host: null, createdAt: new Date(createdMs).toISOString(), keepUntil: new Date(createdMs + LEGACY_GRACE_MS).toISOString() } };
    }
  }
  return { kind: 'unowned', why: 'no owner record' };
}

// ---- the one removal ----
// removeOwnedRoot(dir, { roots, prefixes, owner, now, ignoreKeep, isAlive, startMs, io }) -> { action, reason, dir }
//   action: removed | gone | kept | refused | failed. `roots` are the managed roots the caller may sweep; `owner` is what the caller's strict
//   reader returned ({ pid, host, createdAt, keepUntil }); `ignoreKeep` is the cap eviction (the dead owner is still proven).
function removeOwnedRoot(dir, opts = {}) {
  const io = opts.io || fs;
  const out = { dir, action: null, reason: null };
  const refuse = reason => ({ ...out, action: 'refused', reason });
  const target = path.resolve(String(dir || ''));
  if (!dir || !path.isAbsolute(String(dir))) return refuse('not-absolute');
  const name = path.basename(target);
  if (!name || name === '.' || name === '..') return refuse('not-a-leaf');
  if (Array.isArray(opts.prefixes) && !opts.prefixes.some(p => name.startsWith(p))) return refuse('name-outside-prefixes');
  let st;
  try { st = io.lstatSync(target); } catch (e) { return e && e.code === 'ENOENT' ? { ...out, action: 'gone' } : { ...out, action: 'kept', reason: `unreadable (${(e && e.code) || 'error'})` }; }
  if (st.isSymbolicLink()) return refuse('is-a-link');
  if (!st.isDirectory()) return refuse('not-a-directory');
  const parent = real(path.dirname(target), io);
  const managed = (opts.roots || []).map(r => real(r, io)).find(r => same(r, parent));
  if (!managed) return refuse('outside-managed-root');
  if (same(path.dirname(managed), managed)) return refuse('managed-root-is-a-filesystem-root');
  if (!runTemp.insideRoot(target, managed, io)) return refuse('not-inside-managed-root');
  const cwd = real(process.cwd(), io);
  if (cwd === null) return { ...out, action: 'kept', reason: 'process-cwd-unproven' };
  if (same(cwd, real(target, io)) || runTemp.insideRoot(cwd, target, io)) return { ...out, action: 'kept', reason: 'process-cwd-inside' };
  const owner = opts.owner;
  if (!owner) return { ...out, action: 'kept', reason: 'unowned' };
  const now = opts.now === undefined ? Date.now() : opts.now;
  const until = owner.keepUntil ? isoMs(owner.keepUntil) : null;
  if (owner.keepUntil && until === null) return { ...out, action: 'kept', reason: 'keep-deadline-unreadable' };
  if (until !== null && until > now && !opts.ignoreKeep) return { ...out, action: 'kept', reason: 'keep-deadline' };
  const state = ownerState(owner, { isAlive: opts.isAlive, startMs: opts.startMs, now });
  if (!state.dead) return { ...out, action: 'kept', reason: state.reason };
  if (opts.dry) return { ...out, action: 'would-remove', reason: state.reason };
  try { runTemp.removeTree(target, io); } catch (e) { return { ...out, action: 'failed', reason: (e && e.code) || 'remove-failed' }; }
  return { ...out, action: 'removed', reason: state.reason };
}

// The sweep of one managed root: every child whose name starts with one of `prefixes` goes through removeOwnedRoot with the owner the
// caller's `ownerOf(dir)` proves. Bounded by a removal count and a wall budget so a launch never stalls on a huge backlog; what is left is
// swept by the next start. Returns { examined, removed, kept, refused, failed, partial }.
function sweepRoot(root, opts = {}) {
  const io = opts.io || fs;
  const res = { root, dry: Boolean(opts.dry), examined: 0, removed: [], wouldRemove: [], evicted: [], kept: [], refused: [], failed: [], unowned: 0, partial: false };
  let names;
  try { names = io.readdirSync(root); } catch { return res; }
  const clock = opts.clock || Date.now;
  const deadline = opts.deadline === undefined ? clock() + (opts.budgetMs || 20000) : opts.deadline;
  const maxRemovals = opts.maxRemovals || 100;
  for (const name of names.sort()) {
    if (Array.isArray(opts.prefixes) && !opts.prefixes.some(p => name.startsWith(p))) continue;
    if (res.removed.length + res.wouldRemove.length >= maxRemovals || clock() >= deadline) { res.partial = true; break; }
    const dir = path.join(root, name);
    res.examined++;
    let owner = null;
    try { const o = opts.ownerOf ? opts.ownerOf(dir, io) : null; owner = o && o.owner ? o.owner : null; } catch { owner = null; }
    if (!owner) { res.unowned++; continue; } // no owner record: counted, never removed
    const r = removeOwnedRoot(dir, { ...opts, roots: [root], owner });
    (r.action === 'removed' ? res.removed : r.action === 'would-remove' ? res.wouldRemove : r.action === 'failed' ? res.failed : r.action === 'refused' ? res.refused : r.action === 'gone' ? [] : res.kept).push({ name, action: r.action, reason: r.reason });
  }
  return res;
}

module.exports = { OWNER_FILE, OWNER_SCHEMA, pidAlive, processStartMs, ownerState, writeOwnerFile, readOwnerFile, keepOwnerFile, runRootOwner, removeOwnedRoot, sweepRoot };

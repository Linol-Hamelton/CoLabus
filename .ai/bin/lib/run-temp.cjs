'use strict';
// run-temp: the per-run temporary directory of ONE suite run (TEMP hygiene design, layer 0; PROCESS-REGISTER.md P-149;
// PROTO-DEC-0244 item 1: the creator of a temporary tree removes it).
//
// The test driver (.ai/bin/protocol-test.cjs) creates one fresh directory under the work root before a run, hands it to the
// child as TEMP, TMP and TMPDIR, and removes it as soon as the run's exit code is known (success or failure). The removal
// never follows a link, refuses a path that is not physically inside the work root and does not carry the prefix of this
// run, and prints exactly one record line.
//
// Root resolution is the launcher order of docs/ops/lib/work-root.cjs, read here without that module (the driver must run
// from a checkout that keeps this file alone): PROTOCOL_WORK_ROOT, then COLABS_TMP_ROOT, then the protocol-manifest.json
// "workRoot" key, then <drive of the repository>:/ColabsTmp when that directory exists, then the OS temp dir.
//
// The only exception to the removal is an explicit author request (KEEP_FIXTURES=1): a failing fixture is kept for
// debugging, and the record line says so. Nothing else keeps the directory.
//
// Every function takes an optional io (fs by default) so tests and mutants run on fixtures without touching a real root.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const PREFIX = 'colabs-suite-';
const ENV_NAMES = ['TEMP', 'TMP', 'TMPDIR'];
const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']);
const RETRIES = 5;
const KEEP_MS = 12 * 3600 * 1000;

function real(p, io = fs) { try { return io.realpathSync.native(p); } catch { return path.resolve(p); } }
function same(a, b) { return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b; }

// Physically inside the root: the resolved child is a strict descendant of the resolved root. A link that leaves the root
// is outside; equal paths are outside too (the root itself is never removed by a run).
function insideRoot(child, root, io = fs) {
  const c = real(child, io);
  const r = real(root, io);
  if (same(c, r)) return false;
  const rel = path.relative(r, c);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

function driveCandidate(repo) {
  const root = path.parse(path.resolve(repo)).root;
  if (!/^[A-Za-z]:[\\/]$/.test(root)) return null;
  return path.join(root, 'ColabsTmp');
}

// The work root of this run. A manifest that cannot be parsed is absence, not a guess: the next source decides, exactly as
// the launcher's resolver does for a manifest that does not exist.
function resolveRunTempRoot({ repo, env = process.env } = {}) {
  const value = name => {
    const raw = env && env[name];
    return typeof raw === 'string' && raw.trim() ? path.resolve(raw) : null;
  };
  const override = value('PROTOCOL_WORK_ROOT');
  if (override) return { dir: override, source: 'PROTOCOL_WORK_ROOT' };
  const legacy = value('COLABS_TMP_ROOT');
  if (legacy) return { dir: legacy, source: 'COLABS_TMP_ROOT' };
  if (repo) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(path.resolve(repo), 'protocol-manifest.json'), 'utf8'));
      if (manifest && typeof manifest.workRoot === 'string' && manifest.workRoot.trim()) {
        return { dir: path.resolve(manifest.workRoot), source: 'manifest' };
      }
    } catch { /* absent or unreadable: the next source decides */ }
    const candidate = driveCandidate(repo);
    try { if (candidate && fs.statSync(candidate).isDirectory()) return { dir: candidate, source: 'drive-root' }; }
    catch { /* no such directory on this host */ }
  }
  return { dir: path.resolve(os.tmpdir()), source: 'os-temp' };
}

// One fresh directory under the root, created exclusively. A root that does not exist is not created here: the run falls
// back to the inherited TEMP and says so (the driver keeps working; the leak fix stays opt-in only in that one case).
function createRunTemp({ root, prefix = PREFIX, now = Date.now(), pid = process.pid, io = fs } = {}) {
  // root is the work root directory itself: a string, or the resolved descriptor resolveRunTempRoot returns.
  const resolved = typeof root === 'string' ? { dir: path.resolve(root), source: 'explicit' } : (root || resolveRunTempRoot({}));
  const dir = resolved && resolved.dir;
  let isDir = false;
  try { isDir = io.statSync(dir).isDirectory(); } catch { isDir = false; }
  if (!isDir) return { ok: false, reason: 'root-missing', root: dir };
  const stem = `${prefix}${pid}-${Number(now).toString(36)}`;
  for (let i = 0; ; i++) {
    const leaf = i === 0 ? `${stem}-${crypto.randomBytes(3).toString('hex')}` : `${stem}-${crypto.randomBytes(3).toString('hex')}-${i}`;
    const target = path.join(dir, leaf);
    try { io.mkdirSync(target); }
    catch (e) {
      if (e && e.code === 'EEXIST' && i < 20) continue;
      return { ok: false, reason: (e && e.code) || 'mkdir-failed', root: dir };
    }
    // A junction on the root itself still resolves inside the root; anything that physically leaves it is refused and
    // the directory just created is removed again (it is empty and ours).
    if (!insideRoot(target, dir, io)) {
      try { io.rmdirSync(target); } catch { /* the refusal names the path either way */ }
      return { ok: false, reason: 'outside-work-root', root: dir, dir: target };
    }
    // The owner record (DISK-LEAKS dli1): who made this root, so a LATER run can prove the creator dead and sweep a root a kill left behind.
    // Best effort: a root without the record is still swept by its suite-prefix name (pid and time are in it), never by anything weaker.
    try { require('./owned-temp.cjs').writeOwnerFile(target, { pid }, io); } catch { /* the name still names the owner */ }
    return { ok: true, dir: target, root: dir, prefix, source: resolved.source };
  }
}

// The sweep a run starts with (DISK-LEAKS dli1): run roots of an EARLIER run whose creating process is dead (a hard kill never reached
// settleRunTemp). Removal goes only through owned-temp.removeOwnedRoot: owner record proven, owner dead, keep deadline past, inside the
// work root. Never throws: a sweep must not stop a run. PROTOCOL_TEMP_SWEEP=0 turns it off.
const SWEEP_PREFIXES = [PREFIX, 'author-check-', 'colabs-tt-'];
function sweepRunTemps({ root, prefixes = SWEEP_PREFIXES, now = Date.now(), env = process.env, io = fs, isAlive, startMs } = {}) {
  const dir = typeof root === 'string' ? root : root && root.dir;
  const empty = { root: dir || null, examined: 0, removed: [], kept: [], refused: [], failed: [], partial: false, skipped: null };
  if (!dir) return { ...empty, skipped: 'no-root' };
  if (env && String(env.PROTOCOL_TEMP_SWEEP) === '0') return { ...empty, skipped: 'disabled' };
  try {
    const owned = require('./owned-temp.cjs');
    return owned.sweepRoot(path.resolve(dir), { prefixes, now, io, isAlive, startMs, dry: env.PROTOCOL_TEMP_SWEEP === 'dry', ownerOf: (d, i) => owned.runRootOwner(d, i) });
  } catch (e) { return { ...empty, skipped: `error:${(e && e.code) || (e && e.message) || 'unknown'}` }; }
}
function sweepLine(sweep) {
  if (!sweep || sweep.skipped || (!sweep.removed.length && !sweep.failed.length && !(sweep.wouldRemove || []).length)) return null;
  return `[run-temp] SWEEP ${JSON.stringify(sweep)}`;
}

// lstat only: a symlink or junction is unlinked itself, its target is never entered.
function removeTree(target, io = fs) {
  const st = (() => { try { return io.lstatSync(target); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } })();
  if (!st) return;
  if (st.isSymbolicLink()) { retry(() => unlink(target, io), io); return; }
  if (!st.isDirectory()) { retry(() => unlink(target, io), io); return; }
  for (const name of io.readdirSync(target)) removeTree(path.join(target, name), io);
  retry(() => io.rmdirSync(target), io);
}
function unlink(p, io = fs) {
  try { io.unlinkSync(p); } catch (e) {
    if (e.code === 'ENOENT') return;
    try { io.rmdirSync(p); } catch (e2) { if (e2.code === 'ENOENT') return; throw e; }
  }
}
function retry(fn, io = fs) {
  let last;
  for (let i = 0; ; i++) {
    try { fn(); return; } catch (e) {
      last = e;
      if (e.code === 'ENOENT') return;
      if (!RETRY_CODES.has(e.code) || i >= RETRIES) break;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1));
    }
  }
  throw last;
}

// The one judgment before removal. Returns { action: removed|gone|kept|refused|failed, reason?, dir, root }.
function settleRunTemp(run, { failed = false, keep = false, io = fs } = {}) {
  const out = { dir: run && run.dir, root: run && run.root, action: null, reason: null };
  if (!run || run.ok !== true) return { ...out, action: 'skipped', reason: (run && run.reason) || 'no-run-temp' };
  if (keep) {
    // A kept root carries a deadline in its own owner record: the next run's sweep leaves it until then and only then (12 h, as a failed launch).
    try { require('./owned-temp.cjs').keepOwnerFile(run.dir, new Date(Date.now() + KEEP_MS).toISOString(), io); } catch { /* the name rule applies after the deadline-less record */ }
    return { ...out, action: 'kept', reason: process.env.KEEP_FIXTURES === '1' ? 'KEEP_FIXTURES=1' : 'keep-requested' };
  }
  let st;
  try { st = io.lstatSync(run.dir); } catch (e) { return { ...out, action: e.code === 'ENOENT' ? 'gone' : 'failed', reason: e.code || 'unreadable' }; }
  if (st.isSymbolicLink()) return { ...out, action: 'refused', reason: 'run temp is a link' };
  if (!st.isDirectory()) return { ...out, action: 'refused', reason: 'run temp is not a directory' };
  if (!insideRoot(run.dir, run.root, io)) return { ...out, action: 'refused', reason: 'outside-work-root' };
  if (!same(real(path.dirname(real(run.dir, io)), io), real(run.root, io))) return { ...out, action: 'refused', reason: 'not-directly-under-root' };
  if (!path.basename(run.dir).startsWith(run.prefix || PREFIX)) return { ...out, action: 'refused', reason: 'not-this-run' };
  try { removeTree(run.dir, io); }
  catch (e) { return { ...out, action: 'failed', reason: e.code || 'remove-failed' }; }
  return { ...out, action: failed ? 'removed-after-failure' : 'removed' };
}

// The child environment with TEMP, TMP and TMPDIR pointing into the run directory. Every case variant of the three names
// is dropped first (on Windows a parent "Temp" would otherwise coexist with "TEMP"), and the canonical spelling keeps the
// key order the base environment had, so a run without isolation hands the child byte-identical environment keys.
function runTempEnv(baseEnv, dir) {
  const out = { ...(baseEnv || {}) };
  if (!dir) return out;
  const canonical = new Set(ENV_NAMES);
  for (const key of Object.keys(out)) {
    if (canonical.has(key.toUpperCase()) && !canonical.has(key)) delete out[key];
  }
  return Object.assign(out, { TEMP: dir, TMP: dir, TMPDIR: dir });
}

// One line, the same shape for every outcome: what happened to which directory, under which root, for which exit code.
function recordLine(settlement, exitCode) {
  const reason = settlement.reason ? ` reason=${settlement.reason}` : '';
  return `[run-temp] TEMP-${String(settlement.action || 'unknown').toUpperCase()} dir=${settlement.dir} root=${settlement.root} exit=${exitCode}${reason}`;
}

module.exports = {
  PREFIX, ENV_NAMES, SWEEP_PREFIXES, resolveRunTempRoot, createRunTemp, settleRunTemp, runTempEnv, recordLine, sweepRunTemps, sweepLine,
  removeTree, insideRoot, driveCandidate,
};

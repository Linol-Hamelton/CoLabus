'use strict';
// test-tmp: the one way for a test (or a certifier seat script) to make a temporary fixture directory and not leave it behind
// (, layer 1; docs/ops/PROCESS-REGISTER.md P-74). Node builtins only.
//   const tt = <the module docs/ops/lib/test-tmp.cjs loaded with CommonJS require, path relative to the test file>;
//   const dir = tt.mkTmp('my-fixture-', t);   // t = the node:test context; its after-hook removes the dir when the test passed
//   const dir = tt.mkTmp('my-fixture-');      // no context: call tt.cleanup() in your own after/afterEach, or the exit hook removes it
// A fixture has no value after its test passed, so it is removed. It is KEPT (and its path printed once to stderr) only when
//   - the test failed (t.passed === false, or the process exits with a non-zero code while the dir is still registered), or
//   - tt.keep(dir) was called, or KEEP_FIXTURES=1 is set in the environment.
// Every fixture lives under one per-run root `colabs-tt-<random>` inside os.tmpdir() (so a launch-wrapper TEMP/TMP isolation applies to it).
// Nothing is removed unless it lies strictly inside such a root AND the root carries the marker file AND the dir has a registration record
// next to it (not inside it: a fixture's own listing, `git status` or a directory comparison never sees the marker).
// Removal never follows a junction or a symlink (the link itself is unlinked) and retries EBUSY/EPERM/ENOTEMPTY up to 5 times.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT_PREFIX = 'colabs-tt-';
const ROOT_MARKER = '.test-tmp-root.json';
const REG_DIR = '.reg';
const RETRIES = 5;
const PATIENT_RETRIES = 15; // the exit hook waits up to ~3 s for a client that has not released its cwd yet
const RETRY_CODES = new Set(['EBUSY', 'EPERM', 'ENOTEMPTY', 'EACCES']);

const state = { root: null, dirs: new Map(), hooked: false, patient: false };

function sleepMs(ms) { try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch { /* a busy wait is not worth it */ } }
const keepAll = () => process.env.KEEP_FIXTURES === '1';
const say = s => { try { process.stderr.write(`${s}\n`); } catch { /* stderr may be closed at exit */ } };
function real(p) { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } }
function inside(child, parent) {
  const rel = path.relative(real(parent), real(path.dirname(child)) + path.sep + path.basename(child));
  // only a path whose FIRST SEGMENT is `..` leaves the parent: a leaf such as `..-x` or `..hidden` is a normal name inside it
  return rel !== '' && rel.split(/[\\/]/)[0] !== '..' && !path.isAbsolute(rel);
}

// Remove one entry or a whole tree. lstat only: a symlink or junction is unlinked itself, its target is never entered.
// Throws the last error when a retried operation still fails. Callers apply their own guard (see removeRegistered, removeUnderRoot).
function removeTree(target) {
  const st = (() => { try { return fs.lstatSync(target); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } })();
  if (!st) return;
  if (st.isSymbolicLink()) { retry(() => unlinkLink(target)); return; }
  if (!st.isDirectory()) { retry(() => unlinkFile(target)); return; }
  for (const name of fs.readdirSync(target)) removeTree(path.join(target, name));
  retry(() => fs.rmdirSync(target));
}
function unlinkLink(p) {
  try { fs.unlinkSync(p); } catch (e) { if (e.code === 'ENOENT') return; try { fs.rmdirSync(p); } catch (e2) { if (e2.code === 'ENOENT') return; throw e; } }
}
function unlinkFile(p) {
  try { fs.unlinkSync(p); } catch (e) {
    if (e.code === 'ENOENT') return;
    if (e.code === 'EPERM' || e.code === 'EACCES') { try { fs.chmodSync(p, 0o666); } catch { /* retry decides */ } }
    throw e;
  }
}
function retry(fn) {
  let last;
  for (let i = 0; ; i++) {
    try { fn(); return; } catch (e) {
      last = e;
      if (e.code === 'ENOENT') return;
      const max = state.patient ? PATIENT_RETRIES : RETRIES;
      if (!RETRY_CODES.has(e.code) || i >= max) break;
      sleepMs(state.patient ? 200 : 40 * (i + 1));
    }
  }
  throw last;
}

function readJson(f) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } }
const isRoot = root => { const m = readJson(path.join(root, ROOT_MARKER)); return Boolean(m && m.schema === 'test-tmp-root/1'); };

function hook() {
  if (state.hooked) return;
  state.hooked = true;
  process.on('exit', () => {
    const failing = Boolean(process.exitCode);
    state.patient = true;
    for (const dir of [...state.dirs.keys()]) release(dir, { failed: failing });
    dropRootIfEmpty();
  });
}

function getRoot() {
  if (state.root && fs.existsSync(state.root)) return state.root;
  const root = fs.mkdtempSync(path.join(os.tmpdir(), ROOT_PREFIX));
  fs.writeFileSync(path.join(root, ROOT_MARKER), `${JSON.stringify({ schema: 'test-tmp-root/1', pid: process.pid, created: new Date().toISOString() })}\n`);
  fs.mkdirSync(path.join(root, REG_DIR));
  state.root = root;
  state.dirs = new Map([...state.dirs].filter(([d]) => fs.existsSync(d)));
  hook();
  return root;
}

function mkTmp(prefix = 'tmp-', t = null) {
  if (typeof prefix !== 'string' || !prefix || /[\\/]/.test(prefix) || prefix.includes('..')) throw new Error(`test-tmp: bad prefix ${JSON.stringify(prefix)}`);
  const root = getRoot();
  const dir = fs.mkdtempSync(path.join(root, prefix));
  fs.writeFileSync(path.join(root, REG_DIR, `${path.basename(dir)}.json`), `${JSON.stringify({ path: dir, created: new Date().toISOString() })}\n`);
  state.dirs.set(dir, { kept: false });
  if (t && typeof t.after === 'function') t.after(() => release(dir, { failed: t.passed === false }));
  return dir;
}

// The dir is registered by this helper, inside a marked root, and its registration record names exactly this path.
function isRegistered(dir) {
  const d = path.resolve(dir);
  const root = path.dirname(d);
  if (!isRoot(root) || !inside(d, root)) return false;
  const rec = readJson(path.join(root, REG_DIR, `${path.basename(d)}.json`));
  return Boolean(rec && rec.path && path.resolve(rec.path) === d);
}

function removeRegistered(dir) {
  const d = path.resolve(dir);
  if (!isRegistered(d)) throw new Error(`test-tmp: refusing to remove ${d} (not under a marked test-tmp root, or not registered)`);
  removeTree(d);
  try { fs.unlinkSync(path.join(path.dirname(d), REG_DIR, `${path.basename(d)}.json`)); } catch { /* record already gone */ }
}

function release(dir, { failed = false } = {}) {
  const d = path.resolve(dir);
  const rec = state.dirs.get(d);
  if (!rec) return false;
  if (rec.kept || keepAll() || failed) {
    if (!rec.kept) { rec.kept = true; say(`[test-tmp] kept fixture: ${d}`); }
    state.dirs.delete(d);
    return false;
  }
  try { removeRegistered(d); } catch (e) {
    // a process may still hold the dir (a client that has not released its cwd): stay registered, the exit hook tries again with more patience
    if (!state.patient) return false;
    say(`[test-tmp] could not remove ${d}: ${e.code || e.message}`);
  }
  state.dirs.delete(d);
  return true;
}

function keep(dir) {
  const d = path.resolve(dir);
  const rec = state.dirs.get(d);
  if (!rec) return;
  rec.kept = true;
  say(`[test-tmp] kept fixture: ${d}`);
}

// cleanup(): the test's own after/afterEach hook (every fixture still registered). cleanup(dir): one fixture. { failed: true } keeps it.
function cleanup(dirOrOpts, maybeOpts) {
  const one = typeof dirOrOpts === 'string' ? dirOrOpts : null;
  const opts = (one ? maybeOpts : dirOrOpts) || {};
  for (const d of one ? [path.resolve(one)] : [...state.dirs.keys()]) release(d, opts);
  dropRootIfEmpty();
}

function dropRootIfEmpty() {
  const root = state.root;
  if (!root || state.dirs.size) return;
  try {
    const left = fs.readdirSync(root).filter(n => n !== ROOT_MARKER && n !== REG_DIR);
    if (left.length || !isRoot(root)) return; // a kept fixture stays, and so does its root
    removeTree(root);
    state.root = null;
  } catch { /* the root is removed by the next run's retention at the latest */ }
}

// For tools that own a marked directory themselves (the launch wrapper, the retention script): remove `target` only when it lies
// strictly inside `root` and `root`/`markerName` exists. Never follows links. Returns true when something was removed.
function removeUnderRoot(target, root, markerName) {
  const t = path.resolve(target);
  const r = path.resolve(root);
  if (!markerName || !fs.existsSync(path.join(r, markerName))) throw new Error(`test-tmp: refusing to remove ${t} (root ${r} has no ${markerName || 'marker'})`);
  if (!inside(t, r)) throw new Error(`test-tmp: refusing to remove ${t} (not strictly inside ${r})`);
  if (!fs.existsSync(t) && !isLink(t)) return false;
  removeTree(t);
  return true;
}
function isLink(p) { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } }

// For a test file whose code (or the dispatch executor it calls in-process) makes its own temp dirs: from here on os.tmpdir() of THIS process is a fixture
// dir of this helper, so those dirs are removed with it. Call once at the top of the file; returns the dir.
function isolateTemp(prefix = 'tmp-iso-') {
  const dir = mkTmp(prefix);
  for (const k of ['TEMP', 'TMP', 'TMPDIR']) process.env[k] = dir;
  return dir;
}

module.exports = { isolateTemp, mkTmp, keep, cleanup, removeTree, removeUnderRoot, inside, getRoot, isRegistered, ROOT_PREFIX, ROOT_MARKER };

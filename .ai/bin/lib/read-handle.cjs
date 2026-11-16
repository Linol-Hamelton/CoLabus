'use strict';
// Native descriptor query, not a path guard. path-safe owns all containment checks.
// Windows: a child receives a duplicate of the already-open fd as stdin; the helper
// queries that handle, never opens by name.
//
// Helper build (Windows): one verified executable per user and per source+compiler
// identity, in a per-user cache directory (READ_HANDLE_CACHE_DIR overrides it for
// tests and measurement; the default lives under the user profile). The file name is
// the sha256 of the C# source and of the compiler identity; the sha256 of the
// executable is recorded beside it and re-verified before EVERY run. Publishing is
// write, hash, rename: a partial file never stands at the final name, so a
// half-written executable is never run. Anything that does not verify - a planted
// or swapped executable, a missing or foreign record, a cache directory that is not
// a plain directory, a busy file, a failed publish - falls back to the per-process
// private compile of the previous design, which keeps its own exit cleanup. A
// retention sweep at every cache start removes only what this tool itself names
// (path-handle dirs of killed processes, stale publish partials), never follows a
// link, and leaves foreign content alone.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

let helper = null; // { exe, side } - side is null for a private per-process build

const STALE_MS = 60 * 60 * 1000; // younger may still belong to a live process
const OWN_DIR = /^path-handle-[A-Za-z0-9]{6}$/; // exactly what mkdtempSync names
const OWN_OUTPUT = new Set(['read-handle.cs', 'read-handle.exe']);
const OWN_PARTIAL = /^read-handle-[0-9a-f]{64}\.(exe|sha256)\.partial-[A-Za-z0-9._-]+$/;
const SIDE_GRAMMAR = /^[0-9a-f]{64}\r?\n?$/;
const COMPILER = path.join('Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

const sameId = (a, b) => a.dev === b.dev && a.ino === b.ino; // identity only: a directory mtime moves when content is written
const same = (a, b) => sameId(a, b) && a.size === b.size && a.mtimeNs === b.mtimeNs;
// Every real path here is the answer of real-path.cjs: native where the volume has a Mount Manager name,
// the walk that follows no link where it has none.
const realPath = require('./real-path.cjs').create({ fs });
const realOf = p => realPath.realPathSync(p);
// A path names itself only when the real entry is reached by this very spelling:
// no link and no alias (short name, case) in any component.
const isSelf = (p) => realOf(p) === path.resolve(p);

// Best effort at exit, including failed compilation. Never recurse, follow a link,
// or remove a foreign file. The directory and each output retain their identities.
function ownHelperDirectory(dir) {
  const identity = fs.lstatSync(dir, { bigint: true });
  const real = realOf(dir);
  const outputs = new Map();
  process.once('exit', () => {
    try {
      const current = fs.lstatSync(dir, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || !sameId(current, identity) || realOf(dir) !== real) return;
      for (const [file, original] of outputs) {
        try {
          const st = fs.lstatSync(file, { bigint: true });
          if (st.isFile() && !st.isSymbolicLink() && st.nlink === 1n && same(st, original)) fs.unlinkSync(file);
        } catch { /* missing, replaced or busy: leave it for retention */ }
      }
      fs.rmdirSync(dir); // unknown entries keep the directory; never recurse
    } catch { /* an exit hook must never throw */ }
  });
  return file => {
    try { const st = fs.lstatSync(file, { bigint: true }); if (st.isFile() && !st.isSymbolicLink()) outputs.set(file, st); } catch { /* no output */ }
  };
}

// The compiler path: the Framework64 csc under SystemRoot, or the absolute
// READ_HANDLE_CSC for tests and measurement. A non-absolute override is a
// configuration error and refuses loudly, like the cache directory override.
function compilerPath() {
  const given = process.env.READ_HANDLE_CSC;
  if (given === undefined) return path.join(process.env.SystemRoot || 'C:\\Windows', COMPILER);
  if (typeof given !== 'string' || given === '' || !path.isAbsolute(given)) throw new Error('descriptor-cache-refused');
  return given;
}

// The private per-process build of the previous design, byte for byte in behavior:
// fresh OS-temp directory, own source copy, own compile, own exit cleanup.
function privateCompile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-handle-'));
  const remember = ownHelperDirectory(dir);
  const source = path.join(dir, 'read-handle.cs');
  fs.copyFileSync(path.join(__dirname, 'read-handle.cs'), source);
  remember(source);
  const exe = path.join(dir, 'read-handle.exe');
  const compiler = compilerPath();
  let build;
  try { build = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${exe}`, source], {
    windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 65536,
  }); } finally { remember(exe); }
  if (build.error || build.status !== 0) throw new Error('descriptor-helper-unavailable');
  return { exe, side: null };
}

// sha256 of a regular file, read in chunks through one fd whose identity is judged
// around the read (a whole-file buffer is never allocated). A link, a swap, a
// hardlink, an oversized or a busy file refuses with null, never throws.
function fileDigest(target) {
  let fd;
  try {
    const first = fs.lstatSync(target, { bigint: true });
    if (!first.isFile() || first.isSymbolicLink() || first.size > 1048576n) return null;
    fd = fs.openSync(target, 'r');
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !same(opened, first)) return null;
    const hash = crypto.createHash('sha256');
    const chunk = Buffer.alloc(65536);
    for (;;) {
      const n = fs.readSync(fd, chunk, 0, chunk.length, null);
      if (n === 0) break;
      hash.update(chunk.subarray(0, n));
    }
    const after = fs.fstatSync(fd, { bigint: true });
    if (!same(opened, after) || after.size !== opened.size) return null;
    return hash.digest('hex');
  } catch { return null; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* closed */ } } }
}

// The record beside the executable. Only the exact grammar is a record; anything
// else (missing, replaced, a link, oversized) is not and refuses with null.
function readSidecar(side) {
  try {
    const st = fs.lstatSync(side, { bigint: true });
    if (!st.isFile() || st.isSymbolicLink() || st.size > 128n) return null;
    const text = fs.readFileSync(side, 'utf8');
    return SIDE_GRAMMAR.test(text) ? text.trim() : null;
  } catch { return null; }
}

// The one acceptance point of a cached executable: its own sha256 must equal the
// record published under the same key. Returns the verified digest, or null.
function verifyPair(exe, side) {
  const digest = fileDigest(exe);
  const recorded = digest === null ? null : readSidecar(side);
  if (digest === null || recorded === null || digest !== recorded) return null;
  return digest;
}

// The cache directory. A non-absolute READ_HANDLE_CACHE_DIR is a configuration
// error and refuses loudly; anything that does not verify returns null and the
// caller falls back to the private build.
function cacheDir() {
  const given = process.env.READ_HANDLE_CACHE_DIR;
  let cache;
  if (given === undefined) {
    const base = process.env.LOCALAPPDATA;
    if (typeof base !== 'string' || base === '' || !path.isAbsolute(base)) return null;
    cache = path.join(base, 'read-handle-cache');
  } else {
    if (typeof given !== 'string' || given === '' || !path.isAbsolute(given)) throw new Error('descriptor-cache-refused');
    cache = given;
  }
  try {
    // lstat first: a directory that already exists is verified as it is and never passed to mkdir (a machine-wide cache must not be touched by a fixture);
    // only an absent one is created, and only after its parent chain verifies
    let st = null;
    try { st = fs.lstatSync(cache, { bigint: true }); } catch (e) { if (!e || e.code !== 'ENOENT') return null; }
    if (st === null) {
      // The nearest existing ancestor is resolved and verified BEFORE anything is
      // created: a plain directory reached without a link, and its real path is
      // captured at that same observation. Every later check compares against
      // that captured root, so a parent swapped after the check cannot hand the
      // created directory off as verified.
      let ancestor = cache; let ast = null;
      while (ast === null) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor) return null;
        ancestor = parent;
        try { ast = fs.lstatSync(ancestor, { bigint: true }); } catch (e) { if (!e || e.code !== 'ENOENT') return null; }
      }
      let realAncestor = null;
      try { realAncestor = realOf(ancestor); } catch { return null; }
      if (!ast.isDirectory() || ast.isSymbolicLink() || realAncestor !== path.resolve(ancestor)) return null;
      // A missing intermediate chain is created first and verified the same way:
      // the chain must really sit under the captured real ancestor, or it is
      // removed again (only what was created, deepest first, best effort).
      let realParent = realAncestor;
      if (path.dirname(cache) !== ancestor) {
        try { fs.mkdirSync(path.dirname(cache), { recursive: true }); } catch { return null; }
        try { realParent = realOf(path.dirname(cache)); } catch { return null; }
        if (realParent !== path.join(realAncestor, path.relative(ancestor, path.dirname(cache)))) {
          for (let d = path.dirname(cache); ; d = path.dirname(d)) {
            if (d === ancestor || d === path.dirname(d)) break;
            try { fs.rmdirSync(d); } catch { break; }
          }
          return null;
        }
      }
      // The directory is created under a fresh unique name nobody can pre-arrange
      // anything at, and only a created directory whose realpath is the verified
      // parent's real path plus that name is renamed into place. A parent swapped
      // after the check receives at most the temporary name, which is removed
      // again; the final name never receives anything through it.
      const temp = path.join(path.dirname(cache), `.read-handle-cache-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
      let created = null;
      try { fs.mkdirSync(temp); } catch { return null; }
      try { created = fs.lstatSync(temp, { bigint: true }); } catch { /* unresolved below */ }
      const expectedTemp = path.join(realParent, path.basename(temp));
      let realTemp = null;
      try { realTemp = realOf(temp); } catch { /* unresolved below */ }
      if (created === null || !created.isDirectory() || created.isSymbolicLink() || realTemp !== expectedTemp) {
        try { fs.rmdirSync(temp); } catch { /* best effort */ }
        return null;
      }
      try { fs.renameSync(temp, cache); }
      catch { try { fs.rmdirSync(temp); } catch { /* best effort */ } return null; }
      st = fs.lstatSync(cache, { bigint: true });
    }
    if (!st.isDirectory() || st.isSymbolicLink() || !isSelf(cache)) return null;
    return cache;
  } catch { return null; }
}

// Retention inside the cache: only stale publish partials this tool names.
function sweepCache(dir) {
  let names;
  try { names = fs.readdirSync(dir); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    if (!OWN_PARTIAL.test(name)) continue;
    const p = path.join(dir, name);
    try {
      const st = fs.lstatSync(p, { bigint: true });
      if (!st.isFile() || st.isSymbolicLink() || now - Number(st.mtimeMs) < STALE_MS) continue;
      const again = fs.lstatSync(p, { bigint: true });
      if (!again.isFile() || again.isSymbolicLink() || !same(again, st)) continue;
      fs.unlinkSync(p);
    } catch { /* best effort */ }
  }
}

// Retention in OS temp: only directories of the exact own name shape, only their
// own output files, only inside a quarantined copy of the measured directory.
// The directory is moved first, atomically, to a fresh unpredictable name in
// the same parent: a rename moves a junction itself, never its target, so an
// attacker who replaces the known own name with a link (before or after any
// check) can only have the link itself moved, never deletion redirected through
// it. The moved entry must then lstat as the very directory that was measured
// (no link, a directory, the same dev/ino); every deletion and the final rmdir
// name the quarantine only, and the quarantine identity is re-checked
// immediately before every removal step. Anything that does not match leaves
// the quarantine untouched (or restores it to its own still-absent name, when
// what sits there is verifiably the measured directory) and refuses the sweep.
function removeStaleOwnDir(target, now) {
  // The one snapshot of the directory: lstat only, a link is never followed.
  const snap = () => { try { return fs.lstatSync(target, { bigint: true }); } catch { return null; } };
  const own = snap();
  if (own === null || own.isSymbolicLink() || !own.isDirectory() || now - Number(own.mtimeMs) < STALE_MS) return;
  // The quarantine: a fresh unique name in the same parent, so nothing can be
  // pre-arranged at it, and every later step names it instead of the racy path.
  let quarantine = path.join(path.dirname(target), `.${path.basename(target)}.quarantine-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  try { fs.renameSync(target, quarantine); } catch { return; }
  // The moved entry must be the measured directory: a link swapped onto the own
  // name before the rename, or anything placed at the quarantine after it,
  // refuses here. What is not ours is left where it is.
  const stillOwn = () => {
    let st = null;
    try { st = fs.lstatSync(quarantine, { bigint: true }); } catch { return false; }
    return !st.isSymbolicLink() && st.isDirectory() && sameId(st, own);
  };
  if (!stillOwn()) return;
  // Restore what is verifiably ours, and only into its still-absent own name:
  // a refusal never moves anything else, and never leaves the real directory
  // at a name no later sweep looks at.
  const restore = () => {
    try { if (stillOwn() && snap() === null) fs.renameSync(quarantine, target); } catch { /* best effort */ }
  };
  let empty = true;
  for (const entry of fs.readdirSync(quarantine)) {
    if (!OWN_OUTPUT.has(entry)) { empty = false; continue; }
    const p = path.join(quarantine, entry);
    try {
      const e = fs.lstatSync(p, { bigint: true });
      if (e.isSymbolicLink() || !e.isFile()) { empty = false; continue; }
      const again = fs.lstatSync(p, { bigint: true });
      if (!again.isFile() || again.isSymbolicLink() || !same(e, again)) { empty = false; continue; }
      if (!stillOwn()) { empty = false; break; } // a swapped or replaced quarantine keeps everything
      fs.unlinkSync(p); // a busy helper exe refuses here and keeps the directory
    } catch { empty = false; }
  }
  if (!empty) { restore(); return; }
  if (!stillOwn()) return; // the directory itself is verified again before it is removed
  try { fs.rmdirSync(quarantine); } catch { restore(); /* in use or replaced: retention tries again */ }
}

function sweepOwnTempDirs() {
  const tmpRoot = os.tmpdir();
  let names;
  try { names = fs.readdirSync(tmpRoot); } catch { return; }
  const now = Date.now();
  for (const name of names) {
    if (!OWN_DIR.test(name)) continue;
    try { removeStaleOwnDir(path.join(tmpRoot, name), now); } catch { /* best effort */ }
  }
}

// Resolve the helper once per process: reuse a verified pair, or compile and
// publish one, or fall back to the private build. Never returns an unverified helper.
function resolveHelper() {
  const source = path.join(__dirname, 'read-handle.cs');
  const compiler = compilerPath();
  let dir;
  try {
    const cs = fs.readFileSync(source);
    const csStat = fs.statSync(compiler, { bigint: true });
    dir = cacheDir();
    if (dir === null) return privateCompile();
    sweepCache(dir);
    sweepOwnTempDirs();
    const h = crypto.createHash('sha256');
    h.update('read-handle-v1\0');
    h.update(cs);
    h.update(`${compiler}\0${csStat.size}\0${csStat.mtimeMs}`);
    const key = h.digest('hex');
    const exe = path.join(dir, `read-handle-${key}.exe`);
    const side = path.join(dir, `read-handle-${key}.sha256`);
    if (verifyPair(exe, side) !== null) return { exe, side };
    const tag = `read-handle-${key}`;
    const pExe = path.join(dir, `${tag}.exe.partial-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    const pSide = path.join(dir, `${tag}.sha256.partial-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
    try {
      const build = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${pExe}`, source], {
        windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 65536,
      });
      if (build.error || build.status !== 0) return privateCompile();
      const digest = fileDigest(pExe);
      if (digest === null) return privateCompile();
      const fd = fs.openSync(pSide, 'w');
      try { fs.writeSync(fd, `${digest}\n`); } finally { fs.closeSync(fd); }
      fs.renameSync(pExe, exe);
      fs.renameSync(pSide, side);
    } catch { return privateCompile(); } finally {
      for (const p of [pExe, pSide]) { try { fs.unlinkSync(p); } catch { /* published or gone */ } }
    }
    // A concurrent publish may have interleaved: only a verified pair is run.
    if (verifyPair(exe, side) !== null) return { exe, side };
    return privateCompile();
  } catch (e) {
    if (e && e.message === 'descriptor-cache-refused') throw e;
    return privateCompile();
  }
}

function descriptorInfo(fd) {
  if (process.platform === 'linux') {
    const real = fs.readlinkSync(`/proc/self/fd/${fd}`);
    if (!path.isAbsolute(real) || real.endsWith(' (deleted)')) throw new Error('descriptor-path-unknown');
    const st = fs.fstatSync(fd, { bigint: true });
    return { real, dev: st.dev, ino: st.ino, nlink: st.nlink };
  }
  if (process.platform !== 'win32') throw new Error('descriptor-platform-unsupported');
  if (helper === null) helper = resolveHelper();
  else if (helper.side !== null) {
    // The cached executable is re-verified before every run. A private helper is
    // this process's own fresh compile and keeps the pre-cache trust: it is run
    // as before, without any extra per-run file check.
    let ready = false;
    try {
      const st = fs.lstatSync(helper.exe, { bigint: true });
      ready = st.isFile() && !st.isSymbolicLink() && (verifyPair(helper.exe, helper.side) !== null);
    } catch { ready = false; }
    if (!ready) helper = resolveHelper();
  }
  const run = spawnSync(helper.exe, [], { stdio: [fd, 'pipe', 'pipe'], windowsHide: true,
    encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  if (run.error || run.status !== 0) throw new Error('descriptor-query-failed');
  const m = /^([A-Za-z0-9+/]+={0,2})\|(\d+)\|(\d+)\|(\d+)\r?\n$/.exec(run.stdout);
  if (!m) throw new Error('descriptor-response-unknown');
  const bytes = Buffer.from(m[1], 'base64');
  if (bytes.toString('base64') !== m[1]) throw new Error('descriptor-response-unknown');
  const real = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { real, dev: BigInt(m[2]), ino: BigInt(m[3]), nlink: BigInt(m[4]) };
}

// The identity of an opened handle and no name: for a volume without a Mount Manager name, where no
// helper can name a handle. The caller holds it to the identity of the lstat of the path it guarded.
function descriptorIdentity(fd) {
  const st = fs.fstatSync(fd, { bigint: true });
  return { real: null, dev: st.dev, ino: st.ino, nlink: st.nlink };
}

module.exports = { descriptorInfo, descriptorIdentity };

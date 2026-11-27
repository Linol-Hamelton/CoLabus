'use strict';
// work-root: the one place that says where a launched seat may write its temporary files and caches (layer 2).
// Writes on the system drive are unacceptable, and the judgment is PHYSICAL (the PROTO-DEC-0212 design review guarantees
// G1..G4): every directory is resolved with fs.realpathSync.native (junctions, symlinks, subst and mapped drives followed) before it is judged, and
// two resolved paths are on the same volume when their fs.statSync(...).dev (the volume serial) or their resolved drive roots (a DOS drive, or a UNC
// server\share) are equal. A work root that physically lives on the system volume is refused unless the exact opt-in
// PROTOCOL_WORK_ROOT_ON_SYSTEM_DRIVE=1 is set (a host with one drive). UNKNOWN IS A REFUSAL, never a pass (G2): when %SystemRoot% and %windir% are
// absent, empty, relative, conflicting or unresolvable, or the work root itself cannot be resolved, the launcher refuses with a named reason; the
// exact opt-in is the operator's way to take that responsibility on a host that cannot name its system directory. Every per-launch directory this
// module creates is verified to be PHYSICALLY inside the resolved work root before its marker is written (G3). NO REUSE (G2): the per-launch
// directory is created FRESH for every launch - an inherited TEMP that carries the marker of an earlier run is not accepted again, a fresh
// directory is created - and every cache directory the child environment names (npm, pip, XDG, the node compile cache) is created fresh and
// exclusively inside it: a plain mkdir that REFUSES when the path already exists, so the child never receives a pre-existing cache path. The
// protocol-manifest.json "workRoot" key is read ONLY through the shared strict reader (.ai/bin/lib/text-safe.cjs): decode owns the byte classes
// (a BOM, CRLF, a lone CR, invalid UTF-8, a NUL) and parseJsonUnique refuses a duplicated key of ANY spelling, INCLUDING THE EMPTY KEY; this
// module has no duplicate-key walker of its own. A non-object manifest, a wrongly typed key or a non-safe integer is a named refusal, never a
// silent fallback (G4); environment values are used exactly as written (an empty value counts as unset, the opt-in is exactly "1") and an
// unresolvable value is refused, never guessed. The marker file of a per-launch directory belongs to the ONE marker module
// docs/ops/lib/launch-marker.cjs: this module only calls its strict writer (prepareLaunchDir) and re-exports its strict reader, and holds no
// marker parsing of its own. The marker carries the role "work-root-launch-dir" and the creation time, and temp-retention
// finds a kept per-launch directory by its MARKER FILE, never by a name pattern, so a bare leaf is found on every root; a directory without the
// marker is never touched by that rule. The marker is READ only through the marker module's shared strict reader with the FIXED schema (exactly the six fields
// the writer writes, plus the optional validated host for backward-compatible old markers): a missing, extra, wrongly typed or wrongly valued field is a named refusal, the marker is never a match and the directory
// is never put in a deletion plan - unknown never becomes permission. TRUST BOUNDARY (PROTO-DEC-0217 item 1): processes of the same operating-system user are INSIDE the trust
// boundary of every launcher; the guarantees hold against inputs (environment, manifest, directories found on disk), not against a concurrent
// same-user writer that swaps a path between its check and its use - the exclusive create stays (an existing path is never reused) and no retry
// loop is added around that window. The package guarantees temp and caches inside the work root; it does not move
// client homes (.codex, .vibe, .kimi, .qwen, .claude) - the owner moves them to the work drive with junctions, outside this package.
//   resolveWorkRoot(repo, env, io): PROTOCOL_WORK_ROOT, else COLABS_TMP_ROOT, else the strict-read "workRoot" key of protocol-manifest.json,
//     else <drive of the repository>:/ColabsTmp, else the OS temp dir (a host without drive letters). No write.
//   workRootRefusal(root, env, io): null, or { reason, root, recovery }. Reasons: work-root-unresolved, work-root-config-refused (the manifest is
//     not strictly readable), work-root-relative (a configured value is not an absolute path), work-root-missing, work-root-unresolvable, system-directory-unknown, system-directory-unresolvable,
//     work-root-on-system-drive. Pure: stat/realpath probes only, no write.
//   prepareLaunchDir(name, root, wrapperPid, io, opts): a FRESH per-launch directory under the resolved root (exclusive mkdir; a same-named
//     directory is never reused, the new one gets a suffix), physically verified inside it, with the launch marker of docs/ops/lib/launch-marker.cjs (role
//     "work-root-launch-dir", creation time). The wrapper leaf rule keeps the bare launch name (os-temp prefixes colabs-launch-); opts.kernelLeaf
//     gives the kernel launchers (cert-launch, fix-launch) the colabs-launch-<name> leaf on every root.
//   launchWorkEnv(dir, baseEnv): the child environment ADDITIONS: TEMP, TMP, TMPDIR and the caches of the client toolchains, all inside dir
//     (npm_config_cache, PYTHONPYCACHEPREFIX, XDG_CACHE_HOME; NODE_COMPILE_CACHE only when the base environment already sets it, in any spelling).
//   prepareCacheDirs(dir, baseEnv, io): CREATES every cache directory launchWorkEnv names, fresh and exclusively (a plain mkdir; an existing
//     path is refused with cache-dir-exists, never reused, never recursive). Per launch, so the child never receives a pre-existing cache path.
//   childLaunchEnv(baseEnv, dir): the FULL child environment: baseEnv minus every case variant of the overridden names (a parent NPM_CONFIG_CACHE
//     would otherwise coexist with our npm_config_cache and win on Windows), plus the additions.
//   kernelWorkEnv({ repo, name, env, io }): everything a kernel launcher needs before the client starts: the refusal, or { root, dir, env } with
//     env the FULL child environment. The inherited TEMP is never reused (G2: a marker from an earlier run is not accepted again) - a fresh
//     per-launch directory is created under the root with fresh exclusive cache directories inside it.
const fs = require('node:fs');
const { removeTree, inside } = require('./test-tmp.cjs');
const KEEP_FAILED_MS = 12 * 3600 * 1000;
const os = require('node:os');
const path = require('node:path');
const { decode, parseJsonUnique } = require('../../../.ai/bin/lib/text-safe.cjs');
const realPath = require('../../../.ai/bin/lib/real-path.cjs');
const { driveRootCandidate } = require('./tmp-root.cjs');

// The marker file of a per-launch directory belongs to the ONE marker module: launch-marker.cjs writes, reads and judges
// it; this module re-exports the constants and the reader so the existing consumers keep one import, and holds no marker parsing of its own.
const launchMarker = require('./launch-marker.cjs');
const { LAUNCH_TMP_MARKER, LAUNCH_TMP_ROLE, MARKER_FIELDS, readLaunchMarker } = launchMarker;
const ENV_OVERRIDE = 'PROTOCOL_WORK_ROOT';
const LEGACY_OVERRIDE = 'COLABS_TMP_ROOT';
const SYSTEM_DRIVE_OPT_IN = 'PROTOCOL_WORK_ROOT_ON_SYSTEM_DRIVE';
const MANIFEST_FILE = 'protocol-manifest.json';

// ---- physical resolution (G1, G2, G3) ----
// realpathSync.native follows junctions, symlinks, subst and mapped drives and returns a plain DOS or UNC path (it may prefix \\?\ or \\?\UNC\;
// cleanReal removes that prefix, so driveRootOf reads the path as written). dev below is the volume serial: equal exactly when two paths live on
// one physical volume, whatever lexical spelling, junction or mapped drive reached it. The call goes through the shared real-path helper: on a
// volume without a Mount Manager name (a RAM disk) it walks from the volume root and refuses a junction or link instead of following it.
function cleanReal(p) { return p.replace(/^\\\\\?\\UNC\\/, '\\\\').replace(/^\\\\\?\\/, ''); }
function driveRootOf(real) {
  const m = /^([A-Za-z]):[\\/]/.exec(real);
  if (m) return `${m[1].toUpperCase()}:\\`;
  const u = /^\\\\([^\\/]+)\\([^\\/]+)/.exec(real);
  if (u) return `\\\\${u[1]}\\${u[2]}`.toLowerCase();
  return null;
}
function physicalOf(dir, io = fs) {
  const real = cleanReal(realPath.forFs(io).realPathSync(dir));
  const st = io.statSync(real);
  if (!st.isDirectory()) { const e = new Error(`${dir} is not a directory`); e.code = 'ENOTDIR'; throw e; }
  return { real, dev: st.dev, driveRoot: driveRootOf(real) };
}
function sameVolume(a, b) { return a.dev === b.dev || Boolean(a.driveRoot && a.driveRoot === b.driveRoot); }
function physicallyInside(child, root) {
  if (child.dev !== root.dev) return false;
  const c = child.real.toLowerCase(); const r = root.real.toLowerCase();
  return c !== r && c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

// %SystemRoot% (else %windir%), read case-insensitively and resolved PHYSICALLY (G2): absent, empty, relative, conflicting or unresolvable is
// { ok: false, reason }, never a guess and never a silent pass; off Windows there is no system drive at all ({ ok: false, offPlatform: true }).
function systemDirectory(env = process.env, io = fs) {
  if (process.platform !== 'win32') return { ok: false, offPlatform: true };
  const keys = Object.keys(env || {}).filter(k => /^(systemroot|windir)$/i.test(k));
  if (!keys.length) return { ok: false, reason: 'system-directory-unknown', detail: '%SystemRoot% and %windir% are not set' };
  const values = [...new Set(keys.map(k => String(env[k]).trim()).filter(Boolean))];
  if (!values.length) return { ok: false, reason: 'system-directory-unknown', detail: '%SystemRoot% and %windir% are empty' };
  if (values.length > 1) return { ok: false, reason: 'system-directory-unknown', detail: '%SystemRoot% and %windir% disagree' };
  if (!path.isAbsolute(values[0])) return { ok: false, reason: 'system-directory-unknown', detail: `the value "${values[0].slice(0, 60)}" is not an absolute path` };
  try { return { ok: true, ...physicalOf(values[0], io) }; }
  catch { return { ok: false, reason: 'system-directory-unresolvable', detail: values[0] }; }
}

// ---- the strict manifest read (G4) ----
// The strict read is the SHARED reader of .ai/bin/lib/text-safe.cjs, nothing private: decode owns the byte classes (BOM, CRLF, a lone CR, NUL,
// invalid UTF-8) and parseJsonUnique refuses a duplicated key of ANY spelling, INCLUDING THE EMPTY KEY - JSON.parse itself keeps the last of two
// equal keys and never shows the duplicate to anyone, and a truthiness check on the found key would silently skip the empty spelling. The one
// rule below is a domain check on the parsed value, not a reader: every number in the manifest must be a safe integer.
function assertSafeIntegers(value, what) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error(`${what}: the number is not a safe integer`);
  if (!value || typeof value !== 'object') return;
  for (const v of Object.values(value)) assertSafeIntegers(v, what);
}
// { configured: <string> } when the key is set, { configured: null } when the file or the key is absent (absence is not corruption; an
// unreachable repository location is absence too - there is nothing to be strict about), { problem: { code, detail } } when the file
// exists but is not strictly readable. Never a silent fallback to the next source.
function manifestWorkRoot(repo, io = fs) {
  try { if (!io.statSync(path.resolve(repo)).isDirectory()) return { configured: null }; }
  catch { return { configured: null }; }
  let bytes;
  try { bytes = io.readFileSync(path.join(path.resolve(repo), MANIFEST_FILE)); }
  catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'ENOTDIR')) return { configured: null };
    return { problem: { code: `MANIFEST_READ_${String((e && e.code) || 'ERROR')}`, detail: String((e && e.message) || e).slice(0, 120) } };
  }
  const dec = decode(bytes);
  if (!dec.ok) return { problem: { code: dec.problems[0].code, detail: dec.problems[0].detail } };
  let manifest;
  try { manifest = parseJsonUnique(dec.text); assertSafeIntegers(manifest, MANIFEST_FILE); }
  catch (e) { return { problem: { code: 'MANIFEST_JSON', detail: String(e.message).slice(0, 200) } }; }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return { problem: { code: 'MANIFEST_NOT_OBJECT', detail: 'the manifest is not a JSON object' } };
  if (!Object.hasOwn(manifest, 'workRoot')) return { configured: null };
  const v = manifest.workRoot;
  if (typeof v !== 'string' || !v.trim()) return { problem: { code: 'WORKROOT_NOT_A_STRING', detail: 'the "workRoot" key must be a non-empty string' } };
  return { configured: v };
}

// Pure. `kind` says where the root came from and names the recovery line; a manifest that is present but not strictly readable is carried as a
// problem for workRootRefusal to refuse (never silently skipped).
// A configured value is used exactly as written: a relative one would resolve against whatever the current directory happens to be, so
// it is carried as the problem WORKROOT_RELATIVE for workRootRefusal to refuse by name, never guessed. A drive-letter path counts as
// absolute on every platform (the manifest of a Windows host is read the same everywhere). On Windows a path rooted by one slash or
// backslash without a drive letter takes the drive of the current directory, so it is relative there too; a UNC path (two leading
// separators and a host name) stays absolute.
const ROOT_SOURCE = { 'env-override': ENV_OVERRIDE, 'colabs-tmp-root': LEGACY_OVERRIDE, manifest: `the ${MANIFEST_FILE} "workRoot" key` };
const absoluteRoot = v => /^[A-Za-z]:[\\/]/.test(v) || /^[\\/]{2}[^\\/]/.test(v) || (process.platform !== 'win32' && path.isAbsolute(v));
function resolveWorkRoot(repo, env = process.env, io = fs) {
  const set = (value, kind) => (absoluteRoot(String(value))
    ? { dir: path.resolve(String(value)), kind }
    : { dir: null, kind, problem: { code: 'WORKROOT_RELATIVE', detail: `${ROOT_SOURCE[kind]} is not an absolute path` } });
  if (env[ENV_OVERRIDE] && String(env[ENV_OVERRIDE]).trim()) return set(env[ENV_OVERRIDE], 'env-override');
  if (env[LEGACY_OVERRIDE] && String(env[LEGACY_OVERRIDE]).trim()) return set(env[LEGACY_OVERRIDE], 'colabs-tmp-root');
  if (repo) {
    const m = manifestWorkRoot(repo, io);
    if (m.problem) return { dir: null, kind: 'manifest', problem: m.problem };
    if (m.configured) return set(m.configured, 'manifest');
  }
  const candidate = repo ? driveRootCandidate(repo) : null;
  if (candidate) return { dir: candidate, kind: 'drive-root' };
  return { dir: os.tmpdir(), kind: 'os-temp' };
}

// Pure (stat and realpath probes, no write): null when the launch may proceed, else the named reason and the recovery line.
function workRootRefusal(root, env = process.env, io = fs) {
  if (!root || !root.dir) {
    if (root && root.problem && root.problem.code === 'WORKROOT_RELATIVE') {
      return { reason: 'work-root-relative', root: null, recovery: `${root.problem.detail}; set it to an existing absolute directory outside the system drive` };
    }
    if (root && root.problem) {
      return { reason: 'work-root-config-refused', root: null, recovery: `fix ${MANIFEST_FILE} (${root.problem.code}: ${root.problem.detail}), or set ${ENV_OVERRIDE} to an existing directory outside the system drive` };
    }
    return { reason: 'work-root-unresolved', root: null, recovery: `set ${ENV_OVERRIDE} to an existing directory outside the system drive` };
  }
  let isDir = false;
  try { isDir = io.statSync(root.dir).isDirectory(); } catch { isDir = false; }
  if (!isDir) {
    return { reason: 'work-root-missing', root: root.dir, recovery: `create it or point ${ENV_OVERRIDE} (or the protocol-manifest.json "workRoot" key) at an existing directory outside the system drive` };
  }
  const optIn = String(env[SYSTEM_DRIVE_OPT_IN]) === '1';
  let rootPhys;
  try { rootPhys = physicalOf(root.dir, io); }
  catch { return { reason: 'work-root-unresolvable', root: root.dir, recovery: `the work root exists but does not resolve to a real physical directory; point ${ENV_OVERRIDE} at a plain directory on the work drive` }; }
  if (process.platform !== 'win32') return null; // a host without drive letters has no system drive to compare with
  const system = systemDirectory(env, io);
  if (!system.ok) {
    if (optIn) return null; // the operator explicitly accepted the work root wherever it physically lives (single-drive host)
    return { reason: system.reason, root: rootPhys.real, recovery: `set %SystemRoot% (or %windir%) to the existing system directory, or set ${SYSTEM_DRIVE_OPT_IN}=1 when you accept this work root wherever it physically lives` };
  }
  if (sameVolume(rootPhys, system) && !optIn) {
    return { reason: 'work-root-on-system-drive', root: rootPhys.real, recovery: `point ${ENV_OVERRIDE} (or the protocol-manifest.json "workRoot" key) at a directory on another drive, or set ${SYSTEM_DRIVE_OPT_IN}=1 on a single-drive host` };
  }
  return null;
}

// ---- per-launch directories (G3) ----
// A leaf name this module accepts: one safe path segment; a traversal or a reserved device name is refused before anything is created.
// Rule: the leaf name in a PATH and the identity in the MARKER follow the same closed grammar, so both are judged by the one
// grammar function of the marker module (identityProblem); they can never drift apart.
function launchLeafProblem(name) { return launchMarker.identityProblem(name); }
const sameCreation = (a, b) => Boolean(a && b && typeof a.dev === 'bigint' && typeof a.ino === 'bigint' && a.dev === b.dev && a.ino === b.ino);

// Failed creation owns only this exclusive directory and (if opened) this exact
// marker. Never recurse: foreign content, links and replacement identities stay.
function settleLaunchCreation(lt, identity, markerIdentity, fields, io) {
  const ownDir = () => {
    const st = io.lstatSync(lt.dir, { bigint: true });
    if (!st.isDirectory() || st.isSymbolicLink() || !sameCreation(st, identity)) throw Error('created directory identity changed or was not captured');
  };
  const ownMarker = () => {
    const st = io.lstatSync(path.join(lt.dir, LAUNCH_TMP_MARKER), { bigint: true });
    if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1n || !sameCreation(st, markerIdentity)) throw Error('marker is not the file this creator opened');
  };
  const markerPresent = () => {
    try { io.lstatSync(path.join(lt.dir, LAUNCH_TMP_MARKER)); return true; }
    catch (e) { if (e.code === 'ENOENT') return false; throw e; }
  };
  let cleanupError;
  try {
    ownDir();
    const names = io.readdirSync(lt.dir);
    if (names.some(n => n !== LAUNCH_TMP_MARKER)) throw Error('created directory contains foreign entries');
    if (names.length) { ownMarker(); io.unlinkSync(path.join(lt.dir, LAUNCH_TMP_MARKER)); }
    ownDir();
    io.rmdirSync(lt.dir);
    return { path: lt.dir, action: 'removed', reason: 'launch creation failed; creator removed its directory', keepUntil: null };
  } catch (e) { cleanupError = e; }
  let keepUntil = null;
  try {
    ownDir();
    if (!physicallyInside(physicalOf(lt.dir, io), physicalOf(lt.root, io))) throw Error('created directory is outside the work root');
    // A partially written marker can be replaced only by its own creator,
    // before this function has ever returned it to a caller or a child.
    if (markerPresent()) { ownMarker(); io.unlinkSync(path.join(lt.dir, LAUNCH_TMP_MARKER)); }
    ownDir();
    const deadline = new Date(Date.now() + KEEP_FAILED_MS).toISOString();
    launchMarker.writeLaunchMarker(lt.dir, { ...fields, keepUntil: deadline }, io, { exclusive: true });
    const state = launchMarker.markerState(lt.dir, io);
    if (state.ok && state.fields.keepUntil === deadline) keepUntil = deadline;
  } catch { /* impossible to mark safely: the refusal must name the exact path */ }
  return { path: lt.dir, action: 'kept', reason: `launch creation cleanup failed: ${cleanupError.code || cleanupError.message}`, keepUntil };
}
// A fresh per-launch directory. opts.kernelLeaf: the kernel launchers (cert-launch, fix-launch) name their standalone directories
// colabs-launch-<name> on every root, so the temp-retention pattern colabs-launch-* (with the marker) reaches them; launch-wrapper keeps its own
// leaf rule (the bare launch name, colabs-launch-<name> only in the OS-temp fallback).
function prepareLaunchDir(name, root, wrapperPid = process.pid, io = fs, opts = {}) {
  const bad = launchLeafProblem(name);
  if (bad) throw Object.assign(new Error(bad), { code: 'launch-name-unsafe' });
  const leaf = opts.kernelLeaf ? `colabs-launch-${name}` : (root.kind === 'os-temp' ? `colabs-launch-${name}` : name);
  let dir = path.join(root.dir, leaf);
  for (let i = 0; ; i++) {
    try { io.mkdirSync(dir); break; }
    catch (e) {
      if (e.code !== 'EEXIST' || i >= 20) throw e;
      dir = path.join(root.dir, `${leaf}-${Date.now().toString(36)}${i}`);
    }
  }
  const lt = { dir, root: root.dir, kind: root.kind, name };
  // The host is recorded only in a spelling the strict reader reads back; any other machine name leaves it out (never a refusal).
  const host = launchMarker.recordedHost(os.hostname());
  const fields = { schema: 'launch-tmp/1', role: LAUNCH_TMP_ROLE, name, wrapperPid, ...(host === null ? {} : { host }), createdAt: new Date().toISOString(), keepUntil: null };
  let identity; let markerIdentity;
  try {
    // Capture identity immediately after the exclusive mkdir, before any physical
    // probe or marker I/O. If capture itself fails, preserve and name the path.
    identity = io.lstatSync(dir, { bigint: true });
    if (!identity.isDirectory() || identity.isSymbolicLink()) throw Object.assign(Error('created launch directory is not a plain directory'), { code: 'launch-dir-replaced' });
    // G3: resolve physically before writing the marker; the child receives the
    // configured spelling, while a swapped link or another volume is refused.
    const dirPhys = physicalOf(dir, io); const rootPhys = physicalOf(root.dir, io);
    if (!physicallyInside(dirPhys, rootPhys)) {
      throw Object.assign(new Error(`the per-launch directory ${dirPhys.real} resolved outside the work root ${rootPhys.real}`), { code: 'launch-dir-outside-root' });
    }
    // Only the shared strict writer owns the marker bytes and schema.
    launchMarker.writeLaunchMarker(dir, fields, io, { exclusive: true, onCreate(st) { markerIdentity = st; } });
    return lt;
  } catch (e) {
    e.launchTmp = lt;
    e.tempDir = settleLaunchCreation(lt, identity, markerIdentity, fields, io);
    if (e.tempDir.action === 'kept') e.message += `; unsettled launch directory: ${dir}`;
    throw e;
  }
}

// ---- the marker reader: ONE shared strict reader and a fixed schema ----
// The marker of a per-launch directory is decoded as a WHOLE by the shared text-safe reader of the marker module
// (docs/ops/lib/launch-marker.cjs): decode refuses a BOM, CRLF, a lone CR, a NUL and every invisible class before the JSON
// is parsed, parseJsonUnique refuses a duplicated key of ANY spelling, and the fixed schema (exactly the six fields the writer writes,
// each with its fixed type, value and - for the identity - the closed grammar of the launcher names) is judged there. readLaunchMarker and
// the tri-state markerState are re-exported from this module for the consumers (retention, the retire tool); nobody parses the file privately.

// The child environment additions: everything the seat writes through temp or a toolchain cache lands inside the per-launch directory.
// NODE_COMPILE_CACHE is redirected only when the base environment already sets it in ANY spelling (the task names it "if set").
// extra: the additions of seatExtras (the shared cache of the two large downloads, the data home of a class K client); they are added after the
// caches of this directory and carry canonical names too.
function launchWorkEnv(dir, baseEnv = process.env, extra = null) {
  if (!dir) return {};
  const set = (name) => baseEnv && Object.keys(baseEnv).some(k => k.toLowerCase() === name);
  const env = { TEMP: dir, TMP: dir, TMPDIR: dir };
  for (const [name, leaf] of CACHE_LEAVES) env[CANONICAL_CHILD_ENV[name]] = path.join(dir, leaf);
  for (const [name, leaf] of OPTIONAL_CACHE_LEAVES) if (set(name)) env[CANONICAL_CHILD_ENV[name]] = path.join(dir, leaf);
  if (extra) Object.assign(env, extra);
  return env;
}

// The cache directories (G2: no cache directory is ever reused). Per launch, every cache directory the child environment names is CREATED fresh
// and exclusively inside the per-launch directory: a plain mkdir (never recursive, never a reuse of an existing path) that REFUSES when the path
// already exists, so a pre-existing junction at a cache path never reaches the child. The per-launch directory itself is fresh and exclusive, so
// an existing cache path inside it can only be a concurrent same-user act - inside the trust boundary (PROTO-DEC-0217 item 1), kept visible by the
// refusal instead of silently worked around; no retry loop.
// The caches of every seat (lower-case variable name, leaf below the launch directory). The Cargo and Rustup homes and GOPATH are not here: they
// hold installed tools and sources, not caches, and an empty fresh one would break the toolchain. The two large downloads (uv, the Playwright
// browsers) are not here either: they live in the shared cache (shared-cache.cjs). The Hugging Face models belong to the retrieval service
// and are not a seat cache.
const CACHE_LEAVES = [
  ['npm_config_cache', 'npm-cache'], ['pythonpycacheprefix', 'pycache'], ['xdg_cache_home', 'xdg-cache'], ['pip_cache_dir', 'pip-cache'],
  ['gocache', 'go-build'], ['gomodcache', 'go-mod'], ['npm_config_devdir', 'node-gyp'], ['puppeteer_cache_dir', 'puppeteer'],
];
// Redirected only when the base environment already sets them, in any spelling.
const OPTIONAL_CACHE_LEAVES = [['node_compile_cache', 'node-compile-cache']];
const CACHE_DIR_LEAVES = Object.fromEntries([...CACHE_LEAVES, ...OPTIONAL_CACHE_LEAVES]);

// One leaf below a launch directory, fresh and exclusive. A nested leaf (client-data/xdg-data) gets its parent segments made with a recursive
// mkdir ONLY after the leaf path is proved to lie inside the launch directory (a relative path without a dot segment, an empty segment or a
// drive); the leaf itself is the same plain mkdir that refuses an existing path with cache-dir-exists.
function makeLeaf(dir, rel, io = fs) {
  const parts = String(rel).split(/[\\/]/);
  if (!dir || !rel || path.isAbsolute(String(rel)) || parts.some(p => !p || p === '.' || p === '..' || p.includes(':'))) {
    throw Object.assign(new Error(`the cache leaf ${JSON.stringify(String(rel).slice(0, 80))} is not a relative path inside the launch directory`), { code: 'cache-leaf-unsafe' });
  }
  const leaf = path.join(dir, ...parts);
  if (path.relative(dir, leaf).split(/[\\/]/)[0] === '..') throw Object.assign(new Error('the cache leaf leaves the launch directory'), { code: 'cache-leaf-unsafe' });
  if (parts.length > 1) io.mkdirSync(path.dirname(leaf), { recursive: true });
  try { io.mkdirSync(leaf); }
  catch (e) { throw Object.assign(new Error(`the cache directory ${leaf} already exists and is never reused (${(e && e.code) || 'ERROR'})`), { code: 'cache-dir-exists' }); }
  return leaf;
}
function prepareCacheDirs(dir, baseEnv = process.env, io = fs) {
  if (!dir) return [];
  const set = (name) => baseEnv && Object.keys(baseEnv).some(k => k.toLowerCase() === name);
  const names = CACHE_LEAVES.map(([name]) => name);
  for (const [name] of OPTIONAL_CACHE_LEAVES) if (set(name)) names.push(name);
  return names.map(name => makeLeaf(dir, CACHE_DIR_LEAVES[name], io));
}

// What a seat gets beyond its own caches: the shared cache of the two large downloads (a lease on it) and, for a class K client, a fresh data
// home with its credential files placed. Both fail towards the old behaviour with a named note: a seat that cannot take the shared cache, or a
// client that is unseated, keeps working and the note says why. { env, lease, notes }.
function seatExtras({ dir, repo, client, env = process.env, io = fs, name, rootKind = null }) {
  const out = { env: {}, lease: null, notes: [], sharedReason: null, unseatedReason: null };
  if (!dir) return out;
  try {
    const shared = require('./shared-cache.cjs');
    const cache = shared.resolveSharedCache({ repo, env, io, volume: { physicalOf, sameVolume, systemDirectory }, allowDefault: rootKind === 'manifest' || rootKind === 'drive-root' });
    if (cache.dir) {
      const got = shared.acquire({ cache: cache.dir, name: name || path.basename(dir), env, io });
      if (got.refused) out.notes.push(`shared-cache refused: ${got.refused}`);
      else {
        Object.assign(out.env, got.env); out.lease = got.lease;
        if (got.rotation && got.rotation.rotated) out.notes.push(`shared-cache rotated: removed ${got.rotation.removed.length}, kept ${got.rotation.kept.length}`);
      }
    } else {
      out.sharedReason = cache.reason;
      // an explicit work root without a named shared cache is the normal state of a test or a RAM host: not worth a line in every launch
      if (cache.reason !== 'shared-cache-not-named-for-an-explicit-work-root') out.notes.push(`shared-cache not used: ${cache.reason}`);
    }
  } catch (e) { out.notes.push(`shared-cache error: ${(e && e.code) || (e && e.message) || 'unknown'}`); }
  if (client) {
    try {
      const data = require('./client-data.cjs').prepare({ dir, client, home: env.USERPROFILE || env.HOME || undefined, makeLeaf: (d, rel) => makeLeaf(d, rel, io), io });
      Object.assign(out.env, data.env);
      if (data.unseated) out.notes.push(`client ${client} unseated: ${data.unseated}`);
      if (data.disabled) out.unseatedReason = data.disabled;
    } catch (e) {
      if (out.lease) require('./shared-cache.cjs').release(out.lease, io);
      if (e && e.code === 'cache-dir-exists') throw e;
      out.notes.push(`client-data error: ${(e && e.code) || (e && e.message) || 'unknown'}`);
    }
  }
  return out;
}

// The FULL child environment: a foreign case variant of an overridden name leaves the base (a parent NPM_CONFIG_CACHE would otherwise
// coexist with our npm_config_cache and the child would read the parent's value on Windows), while the canonical spelling keeps its place in
// the key order, so the environment bytes stay identical to the previous spread whenever the parent carries no variant.
// A foreign case variant of ANY name of the table leaves the base, also when this seat does not set it itself: a parent's lower-case
// uv_cache_dir can never coexist with the shared one (on Windows the child would read the parent's value).
const CANONICAL_CHILD_ENV = {
  temp: 'TEMP', tmp: 'TMP', tmpdir: 'TMPDIR', npm_config_cache: 'npm_config_cache', pythonpycacheprefix: 'PYTHONPYCACHEPREFIX', xdg_cache_home: 'XDG_CACHE_HOME',
  node_compile_cache: 'NODE_COMPILE_CACHE', pip_cache_dir: 'PIP_CACHE_DIR', gocache: 'GOCACHE', gomodcache: 'GOMODCACHE', npm_config_devdir: 'npm_config_devdir',
  puppeteer_cache_dir: 'PUPPETEER_CACHE_DIR', uv_cache_dir: 'UV_CACHE_DIR', uv_python_install_dir: 'UV_PYTHON_INSTALL_DIR',
  playwright_browsers_path: 'PLAYWRIGHT_BROWSERS_PATH', xdg_data_home: 'XDG_DATA_HOME', xdg_state_home: 'XDG_STATE_HOME',
};
function childLaunchEnv(baseEnv = process.env, dir, extra = null) {
  const out = { ...(baseEnv || {}) };
  for (const k of Object.keys(out)) {
    const canon = CANONICAL_CHILD_ENV[k.toLowerCase()];
    if (canon && k !== canon) delete out[k];
  }
  return dir ? Object.assign(out, launchWorkEnv(dir, baseEnv, extra)) : out;
}

// Everything a kernel launcher (cert-launch.cjs, fix-launch.cjs) needs before the client starts: the refusal, or a FRESH per-launch directory
// (the inherited TEMP is never reused - a marker from an earlier run is not accepted again) with fresh exclusive cache directories inside it, and
// the FULL child environment.
function kernelWorkEnv({ repo, name, env = process.env, io = fs, client = null }) {
  const root = resolveWorkRoot(repo, env, io);
  const refusal = workRootRefusal(root, env, io);
  if (refusal) return { refusal, root };
  const sweep = sweepLaunchRoots(root, { env, io }); // DISK-LEAKS dli1: dead launchers' directories and the kept-directory cap, before a new one is made
  let dir; let extras = null;
  try {
    dir = prepareLaunchDir(name, root, process.pid, io, { kernelLeaf: true }).dir;
    prepareCacheDirs(dir, env, io);
    extras = seatExtras({ dir, repo, client, env, io, name, rootKind: root.kind });
  } catch (e) {
    if (extras && extras.lease) require('./shared-cache.cjs').release(extras.lease, io);
    const tempDir = e.tempDir || (dir ? finishLaunchTmp({ dir, root: root.dir, name }, true, 'CACHE_PREPARE_FAILED') : null);
    if (!dir && e.launchTmp) dir = e.launchTmp.dir;
    const reason = (e && e.code) === 'cache-dir-exists' ? 'cache-dir-refused' : 'launch-dir-refused';
    return { refusal: { reason, root: root.dir, recovery: `${(e && e.code) || 'ERROR'}: ${String((e && e.message) || e).slice(0, 200)}` }, root, dir, tempDir };
  }
  return { root, dir, env: childLaunchEnv(env, dir, extras.env), sweep, lease: extras.lease, notes: extras.notes };
}

// Remove the launch's temp tree (success) or keep it for 12 hours (failure, or a removal that did not work). Returns the terminal record's tempDir field.
// Rule: the marker is read and written ONLY through the one marker module (docs/ops/lib/launch-marker.cjs);
// the private JSON reader and writer are gone. A marker the shared strict reader refuses (corrupted by the child, a foreign file) is not
// ours: the directory is KEPT on the success path and on the failure path, and the refused marker is never repaired or overwritten - the
// 12-hour keep deadline is written only into a marker of the fixed schema, so a corrupt marker can never be laundered into a valid one.
// The credential copies of a class K client and the lease on the shared cache go FIRST and in every completion class: a failed launch keeps its
// folder for 12 hours, never a copy of a key. Only the exact names of the client table below this launch directory are touched.
function settleSeat(lt) {
  if (lt.lease) require('./shared-cache.cjs').release(lt.lease);
  const out = { failed: [] };
  try { if (lt.root && inside(lt.dir, lt.root)) out.failed = require('./client-data.cjs').removeSeed(lt.dir).failed; } catch { out.failed = ['unreadable']; }
  return out;
}
function finishLaunchTmp(lt, failed, why, nowMs = Date.now()) {
  if (!lt) return null;
  try {
    if (fs.lstatSync(lt.dir).isSymbolicLink()) return { path: lt.dir, action: 'kept', reason: 'not removed: launch directory is a link', keepUntil: null };
  } catch (e) {
    if (e.code === 'ENOENT') { settleSeat({ lease: lt.lease }); return { path: lt.dir, action: 'gone', reason: null, keepUntil: null }; }
    return { path: lt.dir, action: 'kept', reason: 'not removed: launch directory is unreadable', keepUntil: null };
  }
  const seat = settleSeat(lt);
  if (seat.failed.length) { failed = true; why = `${why || 'seed'}; a credential copy could not be removed (${seat.failed.join(', ')})`; }
  const marker = launchMarker.markerState(lt.dir);
  const mine = Boolean(marker.present && marker.ok && marker.fields.name === lt.name && inside(lt.dir, lt.root));
  let removedMarker = false;
  const keep = reason => {
    const keepUntil = new Date(nowMs + KEEP_FAILED_MS).toISOString();
    // Remove the marker last. If only the final rmdir failed, restore the marker
    // we removed, exclusively when it is still absent; never repair refused bytes.
    if (mine && removedMarker) {
      try {
        const st = fs.lstatSync(lt.dir);
        if (st.isDirectory() && !st.isSymbolicLink() && !launchMarker.markerState(lt.dir).present) launchMarker.writeLaunchMarker(lt.dir, { ...marker.fields, keepUntil });
      } catch { /* retention cannot be granted permission to repair unknown state */ }
    }
    if (mine) { try { launchMarker.updateKeepUntil(lt.dir, keepUntil); } catch { /* the marker stays as it was */ } }
    return { path: lt.dir, action: 'kept', reason, keepUntil };
  };
  if (!fs.existsSync(lt.dir)) return { path: lt.dir, action: 'gone', reason: null, keepUntil: null };
  if (!mine) return { path: lt.dir, action: 'kept', reason: 'not removed: the directory lost its wrapper marker or carries one the strict reader refuses, or it is not under the temp root', keepUntil: null };
  if (failed) return keep(`launch failed (${why}); kept for 12 hours for retention`);
  try {
    for (const name of fs.readdirSync(lt.dir)) if (name !== LAUNCH_TMP_MARKER) removeTree(path.join(lt.dir, name));
    removeTree(path.join(lt.dir, LAUNCH_TMP_MARKER)); removedMarker = true;
    fs.rmdirSync(lt.dir);
    return { path: lt.dir, action: 'removed', reason: null, keepUntil: null };
  } catch (e) { return keep(`remove failed (${e.code || e.message}); kept for 12 hours`); }
}

// ---- the sweep and the hard cap of kept launch directories (DISK-LEAKS dli1; design L01, L09) ----
// finishLaunchTmp settles the creator's own directory; this is the sweep for a creator that never got there (a hard kill leaves a marker with a
// dead wrapperPid and keepUntil null) and for a failed launch whose 12 hours are over (nothing ever removed it: 273 of 278 kept directories
// measured on 2026-11-03 were past their deadline). It starts every launch. Removal goes ONLY through the one helper
// (.ai/bin/lib/owned-temp.cjs): the marker is read by the strict marker reader, the directory is inside this work root, the wrapper pid is dead
// (or reused) and the keep deadline is past. Only with PROTOCOL_KEPT_CAP=1, the CAP: directories kept for a failure number at most KEPT_MAX_ROOTS and weigh at most
// KEPT_MAX_BYTES together; the oldest dead-owner ones beyond that go first, before their 12 hours are over (a hard cap is not a retention
// promise). A directory whose owner is alive, whose marker the strict reader refuses or that has no marker is never touched and never counted
// as removable. Both numbers are PROPOSED values awaiting the owner (design: launch budget, 20 GB ColabsTmp); PROTOCOL_KEPT_MAX_ROOTS and
// PROTOCOL_KEPT_MAX_BYTES override the proposal, but do not enable it. PROTOCOL_LAUNCH_SWEEP=0 disables; dry previews without removal.
// The helper is loaded where it is used: a host that ships this module without the helper still launches (the sweep reports helper-unavailable).
const KEPT_MAX_ROOTS = 30;
const KEPT_MAX_BYTES = 2000000000;
// One deadline bounds removal, kept classification, size scan and eviction together; a single synchronous filesystem operation may overrun it.
const SWEEP_MAX_REMOVALS = 25;
const SWEEP_BUDGET_MS = 4000;
const SCAN_BUDGET_MS = 3000;
function positiveInt(v, fallback) { const n = Number(v); return v !== undefined && /^[0-9]+$/.test(String(v).trim()) && Number.isSafeInteger(n) && n > 0 ? n : fallback; }
function treeBytes(dir, io, deadline, clock = Date.now) {
  let bytes = 0; let complete = true;
  const stack = [dir];
  while (stack.length) {
    if (clock() >= deadline) { complete = false; break; }
    const d = stack.pop();
    let names;
    try { names = io.readdirSync(d); } catch { complete = false; continue; }
    for (const n of names) {
      if (clock() >= deadline) { complete = false; break; }
      let s;
      try { s = io.lstatSync(path.join(d, n)); } catch { complete = false; continue; }
      if (s.isSymbolicLink()) continue; // a link says nothing about our tree: not entered, not counted
      if (s.isDirectory()) stack.push(path.join(d, n)); else bytes += s.size;
    }
  }
  return { bytes, complete };
}
function sweepLaunchRoots(root, opts = {}) {
  const io = opts.io || fs;
  const env = opts.env || process.env;
  const dir = typeof root === 'string' ? root : root && root.dir;
  const out = { root: dir || null, skipped: null, dry: env.PROTOCOL_LAUNCH_SWEEP === 'dry', capEnabled: env.PROTOCOL_KEPT_CAP === '1', removed: [], wouldRemove: [], failed: [], kept: 0, unowned: 0, evicted: [], wouldEvict: [], bytes: null, bytesComplete: false, maxRoots: KEPT_MAX_ROOTS, maxBytes: KEPT_MAX_BYTES };
  if (!dir) return { ...out, skipped: 'no-root' };
  if (String(env.PROTOCOL_LAUNCH_SWEEP) === '0') return { ...out, skipped: 'disabled' };
  // A credential copy of a launch whose owner is PROVEN dead goes at once, whatever the keep deadline of the directory (client-data.cjs).
  try {
    const seeds = require('./client-data.cjs').sweepSeeds(dir, { io, now: opts.now === undefined ? Date.now() : opts.now, isAlive: opts.isAlive, startMs: opts.startMs, dry: out.dry });
    if (seeds.cleaned.length || seeds.failed.length) out.seeds = seeds;
  } catch { /* the sweep of the directories below still runs */ }
  out.maxRoots = positiveInt(env.PROTOCOL_KEPT_MAX_ROOTS, KEPT_MAX_ROOTS);
  out.maxBytes = positiveInt(env.PROTOCOL_KEPT_MAX_BYTES, KEPT_MAX_BYTES);
  try {
    let owned;
    try { owned = require('../../../.ai/bin/lib/owned-temp.cjs'); } catch { return { ...out, skipped: 'helper-unavailable' }; }
    const now = opts.now === undefined ? Date.now() : opts.now;
    const ownerOf = (d, i) => {
      const m = launchMarker.markerState(d, i);
      return m.present && m.ok ? { owner: { pid: m.fields.wrapperPid, host: m.fields.host || null, createdAt: m.fields.createdAt, keepUntil: m.fields.keepUntil } } : null;
    };
    const clock = opts.clock || Date.now;
    const deadline = clock() + (opts.budgetMs || SWEEP_BUDGET_MS);
    const starts = new Map();
    const deps = { isAlive: opts.isAlive, startMs(pid, at) {
      if (clock() >= deadline) return null;
      if (!starts.has(pid)) starts.set(pid, (opts.startMs || owned.processStartMs)(pid, at, Math.max(1, Math.min(10000, deadline - clock()))));
      return starts.get(pid);
    } };
    const maxRemovals = opts.maxRemovals || SWEEP_MAX_REMOVALS;
    const first = owned.sweepRoot(path.resolve(dir), { io, now, ownerOf, maxRemovals, deadline, clock, dry: out.dry, ...deps });
    out.removed = first.removed.map(r => r.name); out.wouldRemove = first.wouldRemove.map(r => r.name); out.failed = first.failed.map(r => r.name); out.unowned = first.unowned || 0; out.partial = first.partial;
    out.kept = first.kept.filter(r => r.reason === 'keep-deadline').length;
    if (!out.capEnabled) return out;
    // the cap: what is still kept for a failure, oldest first
    const scanDeadline = Math.min(deadline, clock() + SCAN_BUDGET_MS);
    const keptDirs = [];
    let names = [];
    try { names = io.readdirSync(dir); } catch { names = []; }
    for (const name of names) {
      if (clock() >= deadline) { out.partial = true; break; }
      const d = path.join(dir, name);
      const o = ownerOf(d, io);
      if (!o || !o.owner.keepUntil || Date.parse(o.owner.keepUntil) <= now) continue;
      let st; try { st = io.lstatSync(d); } catch { continue; }
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      const size = treeBytes(d, io, scanDeadline, clock);
      if (!size.complete) { out.partial = true; break; }
      if (clock() >= deadline) { out.partial = true; break; }
      keptDirs.push({ name, dir: d, owner: o.owner, bytes: size.bytes, evictable: owned.ownerState(o.owner, { ...deps, now }).dead });
    }
    out.kept = keptDirs.length;
    out.bytes = keptDirs.reduce((a, k) => a + k.bytes, 0);
    out.bytesComplete = !out.partial;
    if (out.partial) return out; // incomplete accounting cannot authorize early eviction
    let count = keptDirs.length; let bytes = out.bytes;
    for (const k of keptDirs.filter(x => x.evictable).sort((a, b) => Date.parse(a.owner.createdAt) - Date.parse(b.owner.createdAt))) {
      if (count <= out.maxRoots && bytes <= out.maxBytes) break;
      if (clock() >= deadline || out.removed.length + out.evicted.length + out.wouldRemove.length + out.wouldEvict.length >= maxRemovals) { out.partial = true; break; }
      const r = owned.removeOwnedRoot(k.dir, { roots: [dir], owner: k.owner, now, ignoreKeep: true, dry: out.dry, io, ...deps });
      if (r.action === 'removed' || r.action === 'would-remove') { (out.dry ? out.wouldEvict : out.evicted).push(k.name); count--; bytes -= k.bytes; } else if (r.action === 'failed') out.failed.push(k.name);
    }
    out.kept = count; out.bytes = bytes;
  } catch (e) { out.skipped = `error:${(e && e.code) || (e && e.message) || 'unknown'}`; }
  finally {
    if (out.removed.length || out.failed.length || out.evicted.length || out.wouldRemove.length || out.wouldEvict.length || out.seeds) {
      (opts.report || (line => process.stderr.write(`${line}\n`)))(`[launch-temp] SWEEP ${JSON.stringify(out)}`);
    }
  }
  return out;
}

module.exports = {
  finishLaunchTmp, sweepLaunchRoots, KEPT_MAX_ROOTS, KEPT_MAX_BYTES,
  LAUNCH_TMP_MARKER, LAUNCH_TMP_ROLE, MARKER_FIELDS, ENV_OVERRIDE, LEGACY_OVERRIDE, SYSTEM_DRIVE_OPT_IN, MANIFEST_FILE, CACHE_DIR_LEAVES,
  cleanReal, driveRootOf, physicalOf, sameVolume, physicallyInside, systemDirectory, manifestWorkRoot, readLaunchMarker,
  resolveWorkRoot, workRootRefusal, launchLeafProblem, prepareLaunchDir, prepareCacheDirs, makeLeaf, seatExtras, launchWorkEnv, childLaunchEnv, kernelWorkEnv,
  CACHE_LEAVES, OPTIONAL_CACHE_LEAVES, CANONICAL_CHILD_ENV,
};

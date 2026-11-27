'use strict';
// shared-cache: the one shared cache on a non-system drive for the two large downloaded caches (uv and the Playwright browsers); every
// other cache of a seat stays inside its own launch directory (docs/ops/lib/work-root.cjs). This is the stated exception to "the caches of a
// seat live inside its temporary folder": a download of many gigabytes per seat would otherwise be repeated by every seat.
// Layout: <cache>/gen-<n>/{uv,uv-python,playwright}, <cache>/.leases/<launch>-<pid>.json. A seat takes a LEASE on the highest generation
// before it uses it; the LIMIT is enforced by ROTATION, never by deleting inside a generation: when the measured size of all generations
// is over the limit a new generation is started, and an older generation is removed only when no live lease names it. A lease is live
// unless its owner is PROVEN dead (the same proof as owned-temp.cjs: same host and a dead pid, or a reused pid); unknown is live.
// Ordering that makes the removal safe against a seat that starts meanwhile: the rotator creates the new generation FIRST and reads the leases
// AFTER; a seat writes its lease FIRST and reads the highest generation AFTER, and moves to the higher generation when there is one.
// The size is measured with a time budget; a count that is cut short is only a lower bound, and a lower bound over the limit is proof enough
// to rotate, while a lower bound under the limit is "unknown" and never rotates and is said so. Nothing here ever touches a path outside the
// resolved cache root; a link, a non-directory or a root on the system drive is refused and the seat simply runs without the shared cache.
//   resolveSharedCache({ repo, env, io, volume }): { dir } or { dir: null, reason }
//   acquire({ cache, name, env, io, now, isAlive, startMs, clock }): { env, gen, lease, rotation } or { refused: reason }
//   release(lease, io): removes the lease file of this seat (never throws)
//   measure(dir, io, deadline, clock): { bytes, complete }
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeTree } = require('./test-tmp.cjs');
const { driveRootCandidate } = require('./tmp-root.cjs');

const SHARED_CACHE_ENV = 'PROTOCOL_SHARED_CACHE';
const LIMIT_ENV = 'PROTOCOL_SHARED_CACHE_LIMIT_BYTES';
const SCAN_ENV = 'PROTOCOL_SHARED_CACHE_SCAN_MS';
const DEFAULT_LIMIT_BYTES = 20 * 1000 * 1000 * 1000;
const DEFAULT_SCAN_MS = 5000;
const GEN = /^gen-(\d{1,9})$/;
const LEASES = '.leases';
const LEAVES = { UV_CACHE_DIR: 'uv', UV_PYTHON_INSTALL_DIR: 'uv-python', PLAYWRIGHT_BROWSERS_PATH: 'playwright' };

function positive(v, fallback) { const n = Number(v); return v !== undefined && /^[0-9]+$/.test(String(v).trim()) && Number.isSafeInteger(n) && n > 0 ? n : fallback; }

// The root: PROTOCOL_SHARED_CACHE (an absolute path), else a Cache directory beside the work-root candidate of the repository drive, and the default only when allowDefault says the
// work root is the configured one (an explicit override of the work root, as a test or a RAM host sets it, must name its shared cache too). Created with a plain mkdir when its parent
// exists; judged physically (a plain directory, not a link, and not on the system volume). Unknown is a refusal, never a guess.
function resolveSharedCache({ repo, env = process.env, io = fs, volume, allowDefault = true } = {}) {
  let dir = null;
  const set = env[SHARED_CACHE_ENV];
  if (set && String(set).trim()) {
    if (!/^[A-Za-z]:[\\/]/.test(String(set)) && !/^[\\/]{2}[^\\/]/.test(String(set)) && !(process.platform !== 'win32' && path.isAbsolute(String(set)))) return { dir: null, reason: 'shared-cache-relative' };
    dir = path.resolve(String(set));
  } else {
    if (!allowDefault) return { dir: null, reason: 'shared-cache-not-named-for-an-explicit-work-root' };
    const tmp = repo ? driveRootCandidate(repo) : null;
    if (!tmp) return { dir: null, reason: 'shared-cache-no-drive' };
    // beside the work-root candidate and named after it (the stem of its name with Cache for Tmp), so the two share one drive and one convention
    dir = path.join(path.dirname(tmp), `${path.basename(tmp).replace(/Tmp$/i, '')}Cache`);
  }
  let exists = false;
  try { exists = io.existsSync(dir); } catch { exists = false; }
  const parent = path.dirname(dir);
  let parentThere = true;
  if (!exists) { try { parentThere = io.existsSync(parent); } catch { parentThere = false; } }
  if (!exists && !parentThere) return { dir: null, reason: 'shared-cache-create-failed:ENOENT' };
  const plain = () => {
    let st;
    try { st = io.lstatSync(dir); } catch (e) { return `shared-cache-unreadable:${(e && e.code) || 'error'}`; }
    return st.isSymbolicLink() || !st.isDirectory() ? 'shared-cache-not-a-plain-directory' : null;
  };
  if (exists) { const bad = plain(); if (bad) return { dir: null, reason: bad }; }
  // The volume is judged before anything is created: the directory itself when it exists, else the parent that would hold it, so a refusal
  // leaves nothing behind on the system drive.
  if (volume) {
    let phys; let sys;
    try { phys = volume.physicalOf(exists ? dir : parent, io); sys = volume.systemDirectory(env, io); } catch { return { dir: null, reason: 'shared-cache-unresolvable' }; }
    if (!phys || !sys) return { dir: null, reason: 'shared-cache-unresolvable' };
    if (sys.ok && volume.sameVolume(phys, sys) && String(env.PROTOCOL_WORK_ROOT_ON_SYSTEM_DRIVE) !== '1') return { dir: null, reason: 'shared-cache-on-system-drive' };
    if (!sys.ok && !sys.offPlatform && String(env.PROTOCOL_WORK_ROOT_ON_SYSTEM_DRIVE) !== '1') return { dir: null, reason: 'shared-cache-system-drive-unknown' };
  }
  if (!exists) {
    try { io.mkdirSync(dir); }
    catch (e) { return { dir: null, reason: `shared-cache-create-failed:${(e && e.code) || 'error'}` }; }
    const bad = plain(); if (bad) return { dir: null, reason: bad };
  }
  return { dir };
}

function measure(dir, io = fs, deadline = Infinity, clock = Date.now) {
  let bytes = 0; let complete = true;
  const stack = [dir];
  while (stack.length) {
    if (clock() >= deadline) { complete = false; break; }
    const d = stack.pop();
    let entries;
    try { entries = io.readdirSync(d, { withFileTypes: true }); } catch { complete = false; continue; }
    for (const e of entries) {
      if (e.isSymbolicLink()) continue;
      const full = path.join(d, e.name);
      if (e.isDirectory()) { stack.push(full); continue; }
      try { bytes += io.lstatSync(full).size; } catch { complete = false; }
    }
  }
  return { bytes, complete };
}

function generations(cache, io) {
  let names = [];
  try { names = io.readdirSync(cache); } catch { return null; }
  return names.map(n => GEN.exec(n)).filter(Boolean).map(m => ({ n: Number(m[1]), name: m[0] })).sort((a, b) => a.n - b.n);
}

function readLease(file, io) {
  try {
    const j = JSON.parse(io.readFileSync(file, 'utf8'));
    if (j && j.schema === 'cache-lease/1' && GEN.test(j.gen) && Number.isSafeInteger(j.pid) && j.pid > 0 && typeof j.createdAt === 'string') return j;
  } catch { /* unreadable: treated as a live lease below */ }
  return null;
}

// The leases of the cache, with the proof of death of each owner. { readable, leases: [{ file, gen, dead }] }; one lease that cannot be read
// makes the whole answer unreadable, so a generation is never removed on a partial view.
function leaseStates(cache, io, deps) {
  const owned = require('../../../.ai/bin/lib/owned-temp.cjs');
  const dir = path.join(cache, LEASES);
  let names;
  try { names = io.readdirSync(dir); } catch (e) { return e && e.code === 'ENOENT' ? { readable: true, leases: [] } : { readable: false, leases: [] }; }
  const leases = [];
  for (const n of names) {
    const file = path.join(dir, n);
    const j = readLease(file, io);
    if (!j) return { readable: false, leases: [] };
    const state = owned.ownerState({ pid: j.pid, host: j.host || null, createdAt: j.createdAt }, { isAlive: deps.isAlive, startMs: deps.startMs, now: deps.now });
    leases.push({ file, gen: j.gen, dead: state.dead });
  }
  return { readable: true, leases };
}

function acquire({ cache, name, env = process.env, io = fs, now = Date.now(), isAlive, startMs, clock = Date.now } = {}) {
  if (!cache) return { refused: 'no-cache' };
  const limit = positive(env[LIMIT_ENV], DEFAULT_LIMIT_BYTES);
  const scanMs = positive(env[SCAN_ENV], DEFAULT_SCAN_MS);
  const deps = { isAlive, startMs, now };
  let gens = generations(cache, io);
  if (gens === null) return { refused: 'cache-unreadable' };
  let top = gens.length ? gens[gens.length - 1].n : 0;
  const rotation = { rotated: false, removed: [], kept: [], sizeKnown: false, bytes: null, lowerBound: null };
  if (gens.length) {
    const deadline = clock() + scanMs;
    let total = 0; let complete = true;
    for (const g of gens) { const m = measure(path.join(cache, g.name), io, deadline, clock); total += m.bytes; complete = complete && m.complete; }
    rotation.bytes = complete ? total : null; rotation.lowerBound = total; rotation.sizeKnown = complete;
    // A complete count over the limit, or a cut-short count that is already over it (a lower bound), proves the limit is exceeded.
    if (total > limit) {
      try { io.mkdirSync(path.join(cache, `gen-${top + 1}`)); top += 1; rotation.rotated = true; }
      catch (e) { if (!e || e.code !== 'EEXIST') return { refused: `rotate-failed:${(e && e.code) || 'error'}` }; gens = generations(cache, io); top = gens.length ? gens[gens.length - 1].n : top; }
    }
  } else { try { io.mkdirSync(path.join(cache, 'gen-1')); } catch (e) { if (!e || e.code !== 'EEXIST') return { refused: `generation-create-failed:${(e && e.code) || 'error'}` }; } top = 1; }
  try { io.mkdirSync(path.join(cache, LEASES), { recursive: true }); } catch (e) { return { refused: `lease-dir-failed:${(e && e.code) || 'error'}` }; }
  // The lease is written first, the highest generation read after it: a seat that raced a rotation moves up and never uses a generation that is leaving.
  const leaseFile = path.join(cache, LEASES, `${name}-${process.pid}.json`);
  const writeLease = gen => {
    const fields = { schema: 'cache-lease/1', gen, pid: process.pid, host: os.hostname(), createdAt: new Date(now).toISOString() };
    try { io.unlinkSync(leaseFile); } catch { /* none yet */ }
    io.writeFileSync(leaseFile, `${JSON.stringify(fields)}\n`, { flag: 'wx' });
  };
  let useGen = `gen-${top}`;
  try {
    writeLease(useGen);
    gens = generations(cache, io);
    const highest = gens && gens.length ? gens[gens.length - 1] : null;
    if (highest && highest.name !== useGen && highest.n > top) { useGen = highest.name; writeLease(useGen); }
    const genDir = path.join(cache, useGen);
    const env2 = {};
    for (const [key, leaf] of Object.entries(LEAVES)) { io.mkdirSync(path.join(genDir, leaf), { recursive: true }); env2[key] = path.join(genDir, leaf); }
    if (rotation.rotated) rotate({ cache, io, deps, rotation, keep: useGen });
    return { env: env2, gen: useGen, lease: leaseFile, rotation };
  } catch (e) {
    try { io.unlinkSync(leaseFile); } catch { /* nothing to release */ }
    return { refused: `lease-failed:${(e && e.code) || 'error'}` };
  }
}

// Remove the generations below the one in use that no live lease names. The leases are read after the new generation exists and again
// right before each removal; an unreadable lease keeps everything.
function rotate({ cache, io, deps, rotation, keep }) {
  const gens = generations(cache, io) || [];
  for (const g of gens) {
    if (g.name === keep || g.n >= Number(GEN.exec(keep)[1])) continue;
    const states = leaseStates(cache, io, deps);
    if (!states.readable) { rotation.kept.push({ gen: g.name, why: 'lease-unreadable' }); continue; }
    const live = states.leases.filter(l => l.gen === g.name && !l.dead);
    if (live.length) { rotation.kept.push({ gen: g.name, why: 'live-lease' }); continue; }
    try { removeTree(path.join(cache, g.name)); rotation.removed.push(g.name); }
    catch (e) { rotation.kept.push({ gen: g.name, why: `remove-failed:${(e && e.code) || 'error'}` }); }
  }
  // A lease whose owner is proven dead names nothing alive: it goes with the generation it named, never alone and never early.
  const states = leaseStates(cache, io, deps);
  if (states.readable) for (const l of states.leases) if (l.dead && !io.existsSync(path.join(cache, l.gen))) { try { io.unlinkSync(l.file); } catch { /* left for the next rotation */ } }
}

function release(lease, io = fs) {
  if (!lease || path.basename(path.dirname(String(lease))) !== LEASES) return false;
  try { io.unlinkSync(lease); return true; } catch { return false; }
}

module.exports = { SHARED_CACHE_ENV, LIMIT_ENV, SCAN_ENV, DEFAULT_LIMIT_BYTES, LEAVES, resolveSharedCache, acquire, rotate, release, measure, generations, leaseStates };

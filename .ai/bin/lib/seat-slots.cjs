'use strict';
// Seat slots: the ONE counter of live seats of a host. Every consumer (the launch gate,
// seat-count, wait-slot, author-launch and the cycle adapter) reads its seats from here, so
// the operator and the kernel always see the same set.
//
// One identity rule for every consumer: a seat ends only through `marker.ended` or a
// terminal record of the SAME attempt. The attempt is the pair (wrapperPid, startedAt) that
// the running record carries; a terminal record of another attempt (another PID or another
// start) never ends this seat, and the raw output of the launch never ends it either.
//
// One liveness rule: the seat lives while its wrapper process or its child process lives.
// A PID that was reused by another process (its start time is later than the attempt plus
// the reuse window) is not this seat. EPERM means alive, ESRCH means gone, and an unknown
// start time stays alive. The six hour cutoff applies only when no PID of the attempt lives.
//
// One domain rule: the roots are derived from the repository, not configured. They are the
// kernel runtime under the main root, the operator-kit root under the git common dir and the
// runtime a caller passes. A root is normalized (real path, folded case on Windows) so two
// spellings of one directory are one root.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const seatPolicy = require('./seat-policy.cjs');
const realPath = require('./real-path.cjs');

const MAX_AGE_MS = 6 * 3600 * 1000;
const PID_REUSE_MS = 120000;
const RUNNING = '.running.json';
const TERMINAL = '.terminal.json';
// Every field the launch wrapper (docs/ops/launch-wrapper.cjs) writes into these two records, and no other. The launch base, the
// child fields set at spawn, the SEAT-SPAWN and refusal lines and the idle flag reach both records (watch copies a dead launch's
// running record into its terminal); claim release and the end mark only the running record; the outcome only the terminal record.
// The cycle reader (tools/cycle/input-shapes.cjs) accepts exactly these lists and refuses any other field.
const LAUNCH_FIELDS = ['name', 'stream', 'task', 'owner', 'wrapperPid', 'startedAt', 'command', 'client', 'model', 'certifier', 'routeGate', 'launchRole',
  'completionMarker', 'spawnProof', 'precert', 'wrapperLaunchId', 'tempSweep', 'worktree', 'tempDir', 'resolver', 'taskFrame', 'selectionShadow',
  'riskClass', 'tier', 'assignLaunch', 'seatPersistenceBefore', 'childPid', 'cycleStop', 'seatSpawn', 'refusal', 'idle'];
const RECORD_FIELDS = Object.freeze({
  running: Object.freeze([...LAUNCH_FIELDS, 'claimReleasedAt', 'ended']),
  terminal: Object.freeze([...LAUNCH_FIELDS, 'status', 'exitCode', 'signal', 'failureClass', 'reason', 'endedAt', 'wallSeconds', 'lastLines', 'note',
    'usage', 'writeBoundary', 'tokens', 'cost', 'seatRoute', 'seatPersistence'])
});

function aliveDefault(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// The start time of a process, or NaN when it cannot be read. An unknown start time is
// never a proof of reuse.
function processStartMs(pid) {
  if (pid === process.pid) return Date.now() - process.uptime() * 1000;
  const r = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString("o")`], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    : spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 20000 });
  return r.error || r.status !== 0 ? NaN : Date.parse(String(r.stdout || '').trim());
}

const json = (io, file) => { try { return JSON.parse(io.readFileSync(file, 'utf8')); } catch { return null; } };

// The attempt of a marker: the pair that names one launch. Without it the marker cannot
// belong to a seat. A start that is not a valid date names no attempt: a damaged pair of
// records never proves that they belong together.
function attemptOf(marker) {
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return null;
  if (!Number.isSafeInteger(marker.wrapperPid) || marker.wrapperPid <= 0) return null;
  if (typeof marker.startedAt !== 'string' || !Number.isFinite(Date.parse(marker.startedAt))) return null;
  return { wrapperPid: marker.wrapperPid, startedAt: marker.startedAt };
}

// The terminal identity: the same attempt and nothing else.
function sameAttempt(marker, terminal) {
  const a = attemptOf(marker), b = attemptOf(terminal);
  return Boolean(a && b && a.wrapperPid === b.wrapperPid && a.startedAt === b.startedAt);
}

// The state of one seat inside one root. -> { live, marker, attempt, reason, mtimeMs }
function seatState(runtimeDir, name, options = {}) {
  const io = options.io || fs;
  const dir = path.resolve(runtimeDir);
  const runningFile = path.join(dir, name + RUNNING);
  let st;
  try { st = io.statSync(runningFile); } catch { return { live: false, marker: null, attempt: null, reason: 'no-marker', mtimeMs: null }; }
  const now = options.now === undefined ? Date.now() : options.now;
  const maxAgeMs = options.maxAgeMs === undefined ? MAX_AGE_MS : options.maxAgeMs;
  const marker = json(io, runningFile);
  const terminal = json(io, path.join(dir, name + TERMINAL));
  const attempt = attemptOf(marker);
  const dead = reason => ({ live: false, marker, attempt, reason, mtimeMs: st.mtimeMs });
  // A corrupt marker never disappears silently: the seat is counted (with an unknown client)
  // until the age cutoff, because nothing proves that the launch ended.
  if (!marker) return now - st.mtimeMs > maxAgeMs ? dead('expired') : { live: true, marker: null, attempt: null, corrupt: true, reason: 'corrupt-marker', mtimeMs: st.mtimeMs };
  if (marker.ended) return dead('ended');
  if (sameAttempt(marker, terminal)) return dead('terminal');
  const kill = options.kill || process.kill;
  const startedMs = Date.parse(marker.startedAt);
  // The liveness of one PID of the attempt. A PID whose process started after the attempt
  // (plus the reuse window) belongs to another process and is not this seat.
  const pidLives = pid => {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { kill(pid, 0); } catch (e) { if (!e || e.code !== 'EPERM') return false; }
    const created = (options.processStartMs || processStartMs)(pid);
    if (Number.isFinite(created) && Number.isFinite(startedMs) && created > startedMs + PID_REUSE_MS) return false;
    return true;
  };
  const wrapperAlive = pidLives(marker.wrapperPid);
  const childAlive = pidLives(marker.childPid);
  if (!wrapperAlive && !childAlive) {
    // No PID of the attempt lives: only then does the age of the record end the seat.
    return now - st.mtimeMs > maxAgeMs ? dead('expired') : dead('process-gone');
  }
  return { live: true, marker, attempt, reason: null, mtimeMs: st.mtimeMs, wrapperAlive, childAlive };
}

// The client of a seat: the metadata of the record first, the model, then the name of the
// seat. The name patterns are data (.ai/bin/ops-tools/seat-caps.json keeps only the names).
function patternRows(patterns) {
  if (Array.isArray(patterns)) return patterns;
  return patterns && Array.isArray(patterns.clients) ? patterns.clients : [];
}
function clientOf(name, patterns) {
  const folded = String(name || '').toLowerCase();
  for (const row of patternRows(patterns)) if (row.patterns.some(pattern => pattern.test(folded))) return row.name;
  return 'other';
}
function canonicalClient(client, patterns) {
  const folded = String(client).toLowerCase();
  const rows = patternRows(patterns);
  if (!rows.length) return folded;
  if (seatPolicy.clientId(folded) || rows.some(row => row.name === folded)) return folded;
  const matched = clientOf(folded, rows);
  // Explicit identities that match no alias keep distinct default-capped pools.
  // A marker with no identity still reaches this function as `other`.
  return matched === 'other' ? folded : matched;
}
function recordedClient(marker, name, patterns) {
  const route = marker.routeGate && marker.routeGate.client;
  if (typeof route === 'string' && route.trim()) return route;
  if (typeof marker.client === 'string' && marker.client.trim()) return marker.client;
  const model = String((marker.routeGate && marker.routeGate.model) || '');
  const byName = clientOf(name, patterns);
  if (/^claude-/.test(model)) return byName === 'cline' ? 'cline' : 'claude';
  if (/^gemini-/.test(model)) return byName === 'kilo' ? 'kilo' : 'cline';
  const resolver = marker.resolver && marker.resolver.operator && marker.resolver.operator.client;
  const command = Array.isArray(marker.command) ? marker.command : [];
  const at = command.indexOf('--client');
  const commandClient = at >= 0 ? command[at + 1] : typeof marker.command === 'string' ? path.basename(marker.command).replace(/\.(exe|cmd|bat)$/i, '') : null;
  return [resolver, commandClient].find(value => typeof value === 'string' && value.trim()) || byName;
}

function recordedModel(marker) {
  const command = Array.isArray(marker.command) ? marker.command : [];
  const at = command.indexOf('--model');
  return (marker.routeGate && marker.routeGate.model) || marker.model
    || (marker.resolver && marker.resolver.operator && marker.resolver.operator.model)
    || (at >= 0 ? command[at + 1] : null) || null;
}

// The normalized identity of a root: the real path, folded on Windows. Two spellings of one
// directory are one root. A root that does not exist yet is named by its nearest existing
// ancestor; an existing root whose real path cannot be proven throws, because its spelling
// would make it a second identity (a worktree that looks free, a domain that looks foreign).
function normalizeRoot(dir, io = fs) {
  const real = realPath.forFs(io).physicalPathSync(path.resolve(dir));
  return process.platform === 'win32' ? real.toLowerCase() : real;
}

function gitCommonDir(cwd) {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', windowsHide: true, timeout: 20000 });
  return !r.error && r.status === 0 && r.stdout.trim() ? path.resolve(r.stdout.trim()) : null;
}
function gitMainRoot(cwd) {
  const common = gitCommonDir(cwd);
  return common ? path.resolve(common, '..') : null;
}

// The domain of the counter: the roots the repository derives plus the runtime of the
// caller. An explicit domain (a fixture) or an injected root set replaces the derived set.
// The derived set needs a repository: without one the caller sees only the roots it named.
// -> { roots: [absolute directories], closed: [the derived roots] }
function domainRoots(options = {}) {
  const declared = options.domain === undefined || options.domain === null
    ? []
    : (Array.isArray(options.domain) ? options.domain : [options.domain]).map(dir => path.resolve(dir));
  const closed = [];
  if (options.repo || options.mainRoot || options.gitCommonDir) {
    const repo = path.resolve(options.repo || process.cwd());
    const main = options.mainRoot ? path.resolve(options.mainRoot) : gitMainRoot(repo);
    const common = options.gitCommonDir ? path.resolve(options.gitCommonDir) : gitCommonDir(repo);
    if (main) {
      closed.push(path.join(main, '.ai', 'runtime'));
      // The operator's configured runtime is derived from the main checkout, never
      // from the requested launch runtime. All consumers must count the same root.
      try { closed.push(path.join(main, require('../operator/layer.cjs').loadSettings(main).runtime)); }
      catch { /* an absent or invalid operator setting adds no root */ }
    }
    if (common) closed.push(path.join(common, 'operator-kit'));
  }
  // The injected roots REPLACE the derived set: a fixture names its own domain.
  const injected = options.inject === undefined || options.inject === null
    ? []
    : (Array.isArray(options.inject) ? options.inject : [options.inject]).map(dir => path.resolve(dir));
  const roots = [];
  const seen = new Set();
  for (const dir of [...declared, ...(injected.length ? injected : closed), ...(options.runtimeDir ? [path.resolve(options.runtimeDir)] : [])]) {
    const key = normalizeRoot(dir);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(dir);
  }
  return { roots, closed, injected };
}

// The live seats of the whole domain. Every seat names its root, so one registry of live
// seats is reconstructible from the domain alone.
// -> [ { name, client, root, attempt, mtimeMs } ]
function runningSeats(options = {}) {
  const io = options.io || fs;
  const patterns = patternRows(options.patterns || options.caps);
  const domain = options.domainRoots || domainRoots(options);
  const seats = [];
  for (const root of domain.roots) {
    let names;
    try { names = io.readdirSync(root); } catch { continue; }
    for (const file of names.filter(name => name.endsWith(RUNNING))) {
      const name = file.slice(0, -RUNNING.length);
      const state = seatState(root, name, { ...options, io });
      if (!state.live) continue;
      // The own attempt of the caller is excluded by its identity, never by its name: a
      // foreign attempt with the same name is a different seat.
      const own = options.exclude;
      if (own && state.attempt && own.wrapperPid === state.attempt.wrapperPid && own.startedAt === state.attempt.startedAt) continue;
      const client = canonicalClient(recordedClient(state.marker || {}, name, patterns), patterns);
      const model = recordedModel(state.marker || {});
      seats.push({ name, client, model, route: seatPolicy.routeOf(options.policy, client, model),
        root, attempt: state.attempt, mtimeMs: state.mtimeMs });
    }
  }
  seats.sort((a, b) => a.root === b.root ? (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : (a.root < b.root ? -1 : 1));
  return seats;
}

// The seats of one client in the domain.
function countClient(client, options = {}) {
  const patterns = patternRows(options.patterns || options.caps);
  const canonical = canonicalClient(client, patterns);
  return runningSeats(options).filter(seat => seat.client === canonical).length;
}

// The worktree guard: one owner per worktree. The guard uses the identity of the seat, so a
// worktree is not freed because any terminal file exists: only the terminal record of the
// SAME attempt ends the seat that owns the worktree.
// -> the name of the owning seat, or null.
function busyWorktree(options = {}) {
  const io = options.io || fs;
  const want = normalizeRoot(options.worktree, io);
  const domain = options.domainRoots || domainRoots(options);
  const probe = { ...options, io, processStartMs: options.processStartMs || processStartMs };
  for (const root of domain.roots) {
    let names = null;
    for (let attempt = 0; attempt < 5 && !names; attempt++) {
      try { names = io.readdirSync(root); }
      catch (e) {
        if (e && e.code === 'ENOENT') break;
        if (!e || e.code !== 'EBUSY') throw e;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
      }
    }
    if (!names) continue;
    for (const file of names.filter(n => n.endsWith(RUNNING))) {
      const name = file.slice(0, -RUNNING.length);
      const state = seatState(root, name, probe);
      if (!state.live) continue;
      const marker = state.marker;
      if (!marker || typeof marker.worktree !== 'string' || normalizeRoot(marker.worktree, io) !== want) continue;
      return name;
    }
  }
  return null;
}

// The pure admission rule of one pool: count < cap. A cap of null admits everything, a cap
// of zero admits nothing.
function admitPool({ count, cap }) {
  if (cap === null || cap === undefined) return true;
  if (!Number.isSafeInteger(count) || count < 0) return false;
  return count < cap;
}

// The state of the pools of one request against the live seats of the domain.
// caps: { total, client, route, clientName, routeName } (a null cap means "no cap here").
function slotState(options = {}, caps = {}) {
  const seats = runningSeats(options);
  const client = caps.clientName || null;
  const route = caps.routeName || null;
  const sameClient = seats.filter(seat => client ? seat.client === client : !seat.client || seat.client === 'other' || seat.client === 'unknown-client').length;
  const sameRoute = route ? seats.filter(seat => seat.route === route).length : 0;
  const free = admitPool({ count: seats.length, cap: caps.total === undefined ? null : caps.total })
    && admitPool({ count: sameClient, cap: caps.client === undefined ? null : caps.client })
    && (!route || admitPool({ count: sameRoute, cap: caps.route === undefined ? null : caps.route }));
  return { free, running: seats.length, sameClient, sameRoute, seats };
}

// Wait until a slot is free. The clock, the sleep and the probe are injected, so a test
// never waits. The caps are read again on every tick by the caller (the policy is re-read
// at the admission step).
async function waitForSlot(options = {}, caps = {}) {
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const waitMs = options.waitMs === undefined ? 45 * 60 * 1000 : options.waitMs;
  const pollMs = options.pollMs === undefined ? 20000 : options.pollMs;
  const started = now();
  for (let first = true; ; first = false) {
    const state = slotState({ ...options, now: now() }, caps);
    if (state.free) return { ok: true, waitedMs: now() - started, running: state.running, sameClient: state.sameClient, sameRoute: state.sameRoute, seats: state.seats };
    if (now() - started >= waitMs) return { ok: false, waitedMs: now() - started, running: state.running, sameClient: state.sameClient, sameRoute: state.sameRoute, seats: state.seats };
    if (first && options.onWait) options.onWait(state);
    await sleep(pollMs);
  }
}

// The environment injection of the domain (a fixture): the roots that replace the derived set.
const DOMAIN_ENV = 'OK_SEAT_DOMAIN_INJECT';
function injectedRoots(env = process.env) {
  const raw = env && typeof env[DOMAIN_ENV] === 'string' ? env[DOMAIN_ENV] : '';
  return raw.split(/[,;]/).map(part => part.trim()).filter(Boolean).map(part => path.resolve(part));
}

module.exports = {
  MAX_AGE_MS, PID_REUSE_MS, RUNNING, TERMINAL, RECORD_FIELDS, DOMAIN_ENV,
  aliveDefault, processStartMs, attemptOf, sameAttempt, seatState,
  clientOf, canonicalClient, recordedClient, recordedModel, normalizeRoot, injectedRoots,
  domainRoots, runningSeats, countClient, busyWorktree, admitPool, slotState, waitForSlot,
};

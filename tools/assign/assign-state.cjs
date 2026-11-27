'use strict';
// Machine-owned control state of the assign mode.
// The owner's file (assignment-mode/1, host-mode.cjs) says which classes MAY be assigned; this file only narrows that set:
// a hold of everything, a demoted class, a quarantined route. Nothing here can widen it. Never cached; every call reads again.
//
//   read(file, now)            -> { status: absent | ok | invalid, state, sha256 }
//   effective(mode, read, ...) pure: the classes that may be assigned right now, and why not when none may
//   gate(taskClass, opts)      the impure decision of one launch: mode file + state file + environment
//   update(files, mutate, o)   the only writer: lock with a fencing token, validated, atomic replacement
//   acquire / verify / release the assign-launch lock; a holder whose token is gone must refuse its next step (F3)
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hostMode = require('./host-mode.cjs');
const selection = require('./selection-policy.cjs');
const safe = require('../../.ai/bin/lib/path-safe.cjs');

const STATE_SCHEMA = 'assign-state/1';
const LOCK_SCHEMA = 'assign-lock/1';
const POLICY_SCHEMA = 'assign-execution-policy/1';
const POLICY_FILE = path.join(__dirname, 'assign-execution-policy.json');
const KEYS = ['schema', 'hold', 'demoted', 'quarantinedRoutes', 'history', 'updatedAt'];
const CLASS = /^(implementer|fixer|reviewer|certifier|critic|researcher|drafter|synthesiser|architect):[AB]:T[1-9]$/;
const ROUTE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
const WHO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const RULE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const HISTORY_MAX = 100;
const fail = code => { throw Object.assign(new Error(code), { code }); };
const stamp = ms => new Date(ms).toISOString();
const isStamp = s => typeof s === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(s)
  && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
const plain = v => v && typeof v === 'object' && !Array.isArray(v);
const closed = (v, keys) => plain(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const CONTROL = new RegExp('[\u0000-\u001f\u007f-\u009f\u2028\u2029]');
const text = (s, max) => typeof s === 'string' && s.length >= 1 && s.length <= max && !CONTROL.test(s);

function emptyState(now) {
  return { schema: STATE_SCHEMA, hold: null, demoted: {}, quarantinedRoutes: {}, history: [], updatedAt: stamp(now) };
}
const holdOk = h => h === null || closed(h, ['at', 'by', 'reason']) && isStamp(h.at) && WHO.test(h.by) && text(h.reason, 240);
function validateState(v) {
  const ok = closed(v, KEYS) && v.schema === STATE_SCHEMA && holdOk(v.hold) && isStamp(v.updatedAt)
    && plain(v.demoted) && Object.keys(v.demoted).length <= 200
    && Object.entries(v.demoted).every(([c, d]) => CLASS.test(c) && closed(d, ['at', 'rule', 'evidence', 'by']) && isStamp(d.at)
      && RULE.test(d.rule) && WHO.test(d.by) && Array.isArray(d.evidence) && d.evidence.length <= 20 && d.evidence.every(e => text(e, 160)))
    && plain(v.quarantinedRoutes) && Object.keys(v.quarantinedRoutes).length <= 200
    && Object.entries(v.quarantinedRoutes).every(([r, q]) => ROUTE.test(r) && closed(q, ['until', 'rule']) && isStamp(q.until) && RULE.test(q.rule))
    && Array.isArray(v.history) && v.history.length <= HISTORY_MAX
    && v.history.every(h => closed(h, ['at', 'by', 'action', 'target', 'reason']) && isStamp(h.at) && WHO.test(h.by)
      && ['hold', 'demote', 'quarantine', 'release'].includes(h.action) && text(h.target, 120) && text(h.reason, 240));
  if (!ok) fail('state-invalid');
  return v;
}

// ---- files: the state and the lock live beside the owner's mode file and are resolved by the same guarded rules
function locate(options = {}) {
  const mode = hostMode.resolveFile(options.worktree, options.modeFile, options.env);
  if (!mode) return { mode: null, state: null, lock: null };
  const state = hostMode.resolveFile(options.worktree, path.join(path.dirname(mode), 'assign-state.json'), options.env);
  const lock = state ? path.join(path.dirname(state), 'assign-launch.lock') : null;
  return { mode, state, lock };
}
function read(file, now = Date.now()) {
  if (!file) return { status: 'invalid', state: null, sha256: null, reason: 'state-unlocatable' };
  try {
    if (!fs.existsSync(file)) return { status: 'absent', state: null, sha256: null, reason: 'state-absent' };
    const doc = selection.readInput(file, 'assign-state');
    return { status: 'ok', state: validateState(doc.obj), sha256: doc.sha256, reason: 'state-read', at: now };
  } catch { return { status: 'invalid', state: null, sha256: null, reason: 'state-invalid' }; }
}

// ---- the decision. Fail closed in every branch: a doubt means advise, never "no restriction".
// Mode off or advise, or no class declared: nothing could execute, so the state file is not needed (design section 6).
// Mode assign with classes: an ABSENT file means advise (F2: .ai/runtime is disposable, a lost file must not lift a demotion;
// the enable act creates the file); an UNREADABLE file means every class is demoted.
function effective(mode, stateRead, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const none = reason => ({ enabled: false, classes: [], reason, quarantined: [] });
  if (!mode || mode.mode !== 'assign') return none('mode-not-assign');
  if (!Array.isArray(mode.assignClasses) || !mode.assignClasses.length) return none('no-classes-declared');
  const held = options.env && typeof options.env.COLABUS_ASSIGN_HOLD === 'string' && !['', '0'].includes(options.env.COLABUS_ASSIGN_HOLD);
  if (held) return none('env-hold');
  if (!stateRead || stateRead.status === 'absent') return none('state-absent');
  if (stateRead.status !== 'ok') return none('state-invalid');
  const state = stateRead.state;
  if (state.hold) return none('hold');
  const classes = mode.assignClasses.filter(c => !Object.hasOwn(state.demoted, c));
  const quarantined = Object.entries(state.quarantinedRoutes).filter(([, q]) => Date.parse(q.until) > now).map(([r]) => r).sort();
  return { enabled: classes.length > 0, classes, reason: classes.length ? 'ok' : 'all-demoted', quarantined };
}
// One launch's gate: the mode file, the state file and the environment, read fresh. Returns the hashes a launch record carries.
function gate(taskClass, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const files = locate(options);
  const mode = hostMode.read(files.mode === null ? null : files.mode, now, { worktree: options.worktree, env: options.env });
  const stateRead = files.state ? read(files.state, now) : { status: 'invalid', state: null, sha256: null };
  const eff = effective(mode, stateRead, { now, env: options.env || process.env });
  const classEnabled = eff.classes.includes(taskClass);
  return { effective: classEnabled, reason: classEnabled ? 'ok' : eff.enabled ? 'class-not-enabled' : eff.reason, taskClass,
    modeSha256: mode.sha256, stateSha256: stateRead.sha256, quarantined: eff.quarantined, mode: mode.mode, expiresAt: mode.expiresAt };
}

// ---- the lock with a fencing token (F3). The holder carries the token; the file says who holds the lock now.
const alive = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
function ownerOf(lock) {
  try {
    const o = JSON.parse(fs.readFileSync(path.join(lock, 'owner.json'), 'utf8'));
    return closed(o, ['schema', 'pid', 'startedAtMs', 'token', 'acquiredAtMs']) && o.schema === LOCK_SCHEMA && Number.isSafeInteger(o.pid)
      && /^[0-9a-f]{32}$/.test(o.token) && Number.isFinite(o.acquiredAtMs) ? o : null;
  } catch { return null; }
}
function acquire(lock, options = {}) {
  const now = options.now ?? Date.now();
  const ttlMs = options.ttlMs ?? 120000;
  const isAlive = options.isAlive || alive;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { fs.mkdirSync(lock); } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const o = ownerOf(lock);
      // A lock directory without a readable owner is a creator that has not written yet: young, else abandoned.
      const young = (() => { try { return now - fs.statSync(lock).mtimeMs < 5000; } catch { return false; } })();
      const dead = o ? !isAlive(o.pid) : !young;
      const expired = o ? now - o.acquiredAtMs > ttlMs : false;
      if (!dead && !expired) return { ok: false, reason: o ? 'held' : 'busy', holder: o ? { pid: o.pid, ageMs: now - o.acquiredAtMs } : null };
      // Recovery of a dead or expired holder. An expired but LIVE holder loses its token here: its next fence() refuses.
      try { fs.rmSync(path.join(lock, 'owner.json'), { force: true }); fs.rmdirSync(lock); } catch { return { ok: false, reason: 'recovery-lost', holder: null }; }
      continue;
    }
    const token = (options.token || crypto.randomBytes(16).toString('hex'));
    const owner = { schema: LOCK_SCHEMA, pid: options.pid ?? process.pid, startedAtMs: Math.round(now - process.uptime() * 1000), token, acquiredAtMs: now };
    fs.writeFileSync(path.join(lock, 'owner.json'), JSON.stringify(owner), { encoding: 'utf8', flag: 'wx' });
    return { ok: true, token, acquiredAtMs: now };
  }
  return { ok: false, reason: 'recovery-lost', holder: null };
}
const verify = (lock, token) => { const o = ownerOf(lock); return Boolean(o && token && o.token === token); };
// A holder whose token is gone (taken after the term, recovered, removed) must stop before the next step of the section.
function fence(lock, token, step) { if (!verify(lock, token)) fail(`lock-lost:${step || 'step'}`); }
function release(lock, token) {
  if (!verify(lock, token)) return false;
  try { fs.rmSync(path.join(lock, 'owner.json'), { force: true }); fs.rmdirSync(lock); return true; } catch { return false; }
}

// ---- the only writer of the state file
const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
function update(files, mutate, options = {}) {
  if (!files || !files.state || !files.lock) fail('state-unlocatable');
  const now = options.now ?? Date.now();
  let held = null;
  for (let i = 0; i < (options.tries ?? 40) && !(held && held.ok); i++) { held = acquire(files.lock, { ...options, now: options.now ?? Date.now() }); if (!held.ok) sleep(options.pauseMs ?? 25); }
  if (!held || !held.ok) fail('lock-busy');
  try {
    const before = read(files.state, now);
    if (before.status === 'invalid') fail('state-invalid');
    const base = before.status === 'ok' ? before.state : emptyState(now);
    const next = validateState({ ...mutate(structuredClone(base)), updatedAt: stamp(now) });
    fence(files.lock, held.token, 'write-state');
    const done = safe.writeAtomicGuarded(files.state, Buffer.from(`${JSON.stringify(next, null, 2)}\n`, 'utf8'), { root: path.parse(files.state).root });
    if (!done.ok) fail('state-write-failed');
    return { state: next, created: before.status === 'absent' };
  } finally { release(files.lock, held.token); }
}

// ---- pure mutations (one per operator act); history keeps who did what, bounded
function note(state, at, by, action, target, reason) {
  state.history = [...state.history, { at: stamp(at), by, action, target, reason }].slice(-HISTORY_MAX);
  return state;
}
function applyHold(state, a) {
  if (!WHO.test(a.by) || !text(a.reason, 240)) fail('hold-invalid');
  if (a.scope === 'all') { state.hold = { at: stamp(a.at), by: a.by, reason: a.reason }; return note(state, a.at, a.by, 'hold', 'all', a.reason); }
  if (a.scope === 'class') {
    if (!CLASS.test(a.target)) fail('hold-invalid');
    state.demoted[a.target] = { at: stamp(a.at), rule: a.rule || 'operator-hold', evidence: (a.evidence || []).slice(0, 20), by: a.by };
    return note(state, a.at, a.by, 'demote', a.target, a.reason);
  }
  if (a.scope === 'route') {
    if (!ROUTE.test(a.target) || !Number.isFinite(a.until)) fail('hold-invalid');
    state.quarantinedRoutes[a.target] = { until: stamp(a.until), rule: a.rule || 'operator-hold' };
    return note(state, a.at, a.by, 'quarantine', a.target, a.reason);
  }
  return fail('hold-invalid');
}
// Return to assign is an act of the operator only: it names who and why; the machine layer (killcheck) never calls it.
function applyRelease(state, a) {
  if (!WHO.test(a.by) || !text(a.reason, 240)) fail('release-invalid');
  if (a.scope === 'all') { if (!state.hold) fail('release-nothing'); state.hold = null; return note(state, a.at, a.by, 'release', 'all', a.reason); }
  const bag = a.scope === 'class' ? state.demoted : a.scope === 'route' ? state.quarantinedRoutes : null;
  if (!bag || !Object.hasOwn(bag, a.target)) fail('release-nothing');
  delete bag[a.target];
  return note(state, a.at, a.by, 'release', a.target, a.reason);
}

// ---- the policy (data, hash goes into every launch record)
function validatePolicy(p) {
  const num = (v, min, max) => Number.isFinite(v) && v >= min && v <= max;
  const k = p && p.killcheck, fr = k && k.failureRate, st = k && k.stuck, bn = k && k.burn;
  const ok = closed(p, ['schema', 'comment', 'lock', 'seat', 'killcheck', 'hold', 'expiry']) && p.schema === POLICY_SCHEMA
    && closed(p.lock, ['ttlSeconds', 'sectionMaxSeconds']) && num(p.lock.ttlSeconds, 10, 600) && num(p.lock.sectionMaxSeconds, 1, p.lock.ttlSeconds - 1)
    && closed(p.seat, ['slotWaitMin', 'idleMinutes', 'idleKillMinutes']) && num(p.seat.slotWaitMin, 0, 0) && num(p.seat.idleMinutes, 1, 600) && num(p.seat.idleKillMinutes, p.seat.idleMinutes, 1440)
    && closed(k, ['windowDays', 'failureRate', 'stuck', 'burn']) && num(k.windowDays, 1, 90)
    && closed(fr, ['minCompleted', 'minFailures', 'minBaselinePairs', 'absoluteRate', 'consecutive']) && num(fr.minCompleted, 1, 1000) && num(fr.minFailures, 1, 1000)
    && num(fr.minBaselinePairs, 1, 1000) && num(fr.absoluteRate, 0.01, 1) && num(fr.consecutive, 2, 100)
    && closed(st, ['silentFactor', 'idleStopsPerWindow', 'idleStopWindowDays']) && num(st.silentFactor, 1, 20) && num(st.idleStopsPerWindow, 1, 100) && num(st.idleStopWindowDays, 1, 90)
    && closed(bn, ['classes', 'perRoute', 'windowHours', 'quarantineHours', 'distinctRoutes']) && Array.isArray(bn.classes) && bn.classes.length > 0 && bn.classes.every(c => /^[A-Z_]{2,40}$/.test(c))
    && num(bn.perRoute, 1, 100) && num(bn.windowHours, 1, 720) && num(bn.quarantineHours, 1, 720) && num(bn.distinctRoutes, 2, 100)
    && closed(p.hold, ['routeHours', 'maxRouteHours']) && num(p.hold.routeHours, 1, p.hold.maxRouteHours) && num(p.hold.maxRouteHours, 1, 8760)
    && closed(p.expiry, ['warnHours']) && num(p.expiry.warnHours, 1, 720);
  if (!ok) fail('policy-invalid');
  return p;
}
function readPolicy(file = POLICY_FILE) {
  try { const doc = selection.readInput(file, 'assign-policy'); return { ok: true, policy: validatePolicy(doc.obj), sha256: doc.sha256 }; }
  catch { return { ok: false, policy: null, sha256: null }; }
}

module.exports = { STATE_SCHEMA, LOCK_SCHEMA, POLICY_FILE, CLASS, ROUTE, WHO, emptyState, validateState, validatePolicy, readPolicy, locate, read, effective, gate,
  acquire, verify, fence, release, update, applyHold, applyRelease };

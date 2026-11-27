'use strict';
// Assignment changes argv only behind the host declaration and the R1 token fence.
// The advice is a ranked input, never authority. All facts are read again at spawn.
const path = require('node:path');
const crypto = require('node:crypto');
const state = require('./assign-state.cjs');
const modeApi = require('./host-mode.cjs');
const selection = require('./selection-policy.cjs');
const intakeApi = require('./launch-intake.cjs');
const hash = v => crypto.createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
const routeKey = r => `${r.client}:${r.model}`;
const routeIdentity = r => JSON.stringify([r.client, r.model, r.effort]);
const code = e => /^[A-Za-z0-9._:-]{1,119}$/.test(e?.code || e?.message || '') ? e.code || e.message : 'recheck-unavailable';
const fail = reason => { throw Object.assign(Error(reason), { code: reason }); };
const option = (args, key) => args.some(s => s === `--${key}` || s.startsWith(`--${key}=`));

function rankedThree(advice) {
  if (!Array.isArray(advice?.ranked) || advice.ranked.length > 3) fail('ranked-invalid');
  const seen = new Set();
  return advice.ranked.map((r, i) => {
    if (r.rank !== i + 1 || ![r.client, r.model].every(s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(s))
      || !(r.effort === null || /^[a-z][a-z0-9-]{0,24}$/.test(r.effort)) || seen.has(routeIdentity(r))) fail('ranked-invalid');
    seen.add(routeIdentity(r));
    return { rank: r.rank, client: r.client, model: r.model, effort: r.effort };
  });
}

// Stops at the first passing route, preserving every earlier failure. Missing ranks
// are explicit too: an empty or short advice is never padded by a resolver ladder.
function choose(ranked, recheck) {
  const skipped = [];
  for (let i = 0; i < 3; i++) {
    const r = ranked[i];
    if (!r) { skipped.push({ rank: i + 1, route: null, reason: 'rank-missing' }); continue; }
    try {
      const facts = recheck(r);
      if (!facts || facts.ok !== true) fail(facts?.reason || 'recheck-unavailable');
      return { route: r, facts, skipped };
    } catch (e) {
      if (/^(?:control-changed|section-expired|lock-lost)/.test(code(e))) throw e;
      skipped.push({ rank: r.rank, route: routeKey(r), reason: code(e) });
    }
  }
  return { route: null, skipped, reason: 'ASSIGN-NONE-AVAILABLE' };
}

function inject(o, r) {
  const command = o.command.slice();
  for (const key of ['client', 'model', 'effort']) {
    const at = command.findIndex(s => s === `--${key}` || s.startsWith(`--${key}=`));
    if (at >= 0) {
      const width = command[at] === `--${key}` ? 2 : 1;
      command.splice(at, width, ...(r[key] !== null ? [`--${key}`, r[key]] : []));
    } else if (r[key] !== null) command.push(`--${key}`, r[key]);
  }
  if (o.command.some(s => /(?:^|[\\/])fix-launch\.cjs$/.test(s)) && !option(command, 'assign')) command.push('--assign', 'auto');
  return { ...o, command, client: r.client, model: r.model, ...(r.effort !== null ? { effort: r.effort } : {}),
    route: routeKey(r), 'slot-wait-min': '0', 'proxy-wait-min': '0' };
}

function assignStep(o, deps = {}) {
  if (o.assign !== 'auto') return { active: false };
  const now = deps.now || Date.now, env = deps.env || process.env;
  const controls = { modeFile: deps.modeFile, worktree: o.worktree, env };
  const mode = modeApi.read(deps.modeFile, now(), controls);
  // No new field or advice capture on the shipped empty declaration.
  if (mode.mode !== 'assign' || !mode.assignClasses.length) return { active: false, inert: true };
  if (o.client || o.model || option(o.command, 'client') || option(o.command, 'model')) return { active: false, ownerExplicit: true };
  const say = deps.say || (() => {});
  let held, files, intent = false, finished = false, spawned = false, result, record, feedbackRoot, machine, chosen;
  const policyRead = state.readPolicy(deps.policyFile);
  let assignmentId = `assign-launch-${o.name}`;
  const feedback = deps.feedback || require('./feedback.cjs');
  const bridge = deps.bridge || require('../operator/assign-bridge.cjs');
  const closeIntent = reason => {
    if (!intent || finished) return;
    feedback.recordOutcome(feedbackRoot, assignmentId, machine, { actual: null, rounds: null, verdicts: [], wallSeconds: null,
      tokens: null, costUsd: null, handOverride: false, failureReason: reason, reason: 'not-started' });
    finished = true;
  };
  const release = () => { if (held?.ok) { state.release(files.lock, held.token); held = null; } };
  const cancel = reason => { try { closeIntent(reason); } finally { release(); } };
  try {
    if (!policyRead.ok) fail('policy-invalid');
    if (!o['task-file']) fail('task-file-required');
    if (o['route-override'] || option(o.command, 'route-override')) fail('route-override-forbidden');
    if (o.engine === 'dispatch') fail('launcher-unsupported');
    if (o['proxy-continue']) fail('proxy-continue-unsupported');
    if (option(o.command, 'fallback')) fail('fallback-unsupported');
    if (!['cert', 'fix'].includes(deps.launcher)) fail('launcher-unsupported');
    if (o.certifier && deps.role !== 'author') fail('certifier-auto-assignment-disabled');
    if (!o['quota-request']) fail('quota-request-required');
    const budget = (deps.quotaContext || quotaContext)(o['quota-request'], deps);
    const reservationContext = budget.context || budget;
    const quotaFile = r => budget.files?.find(f => f.client === r.client && f.model === r.model)?.file || (!budget.files ? o['quota-request'] : null);
    const activeSeats = deps.activeSeats();
    result = (deps.capture || intakeApi.capture)({ launcher: 'launch-wrapper', name: o.name, worktree: o.worktree,
      taskFile: o['task-file'], base: o['selection-base'], role: deps.launcher === 'fix' ? 'fixer' : deps.role,
      operator: { client: null, model: null, effort: null }, execution: true, reservationContext }, {
      ...(deps.intake || {}), modeFile: deps.modeFile, env, now: () => new Date(now()).toISOString(), say,
      executionPolicy: policyRead, bridgeDeps: { ...(deps.intake?.bridgeDeps || {}), execution: true, activeSeats, reservationContext } });
    const frame = result.taskFrame, advice = result.selectionShadow?.advice;
    if (!['implementer', 'fixer'].includes(frame.role)) fail('role-not-enabled');
    if (frame.riskClass !== 'B' || !frame.riskKnown || frame.complexity.protectedPaths !== 0) fail('risk-not-enabled');
    if (!/^T[1-4]$/.test(frame.tier) || frame.unknown.length || !selection.FACTORS.every(k => Number.isInteger(frame.complexity[k]) && frame.complexity[k] >= 0 && frame.complexity[k] <= 2)) fail('task-factors-unknown');
    const taskClass = modeApi.taskClass(frame);
    const gate = state.gate(taskClass, { ...controls, now: now() });
    say(`ASSIGN-GATE class=${taskClass} effective=${gate.effective ? 'yes' : 'no'} reason=${gate.reason}`);
    if (!gate.effective) fail(gate.reason);
    if (advice?.status !== 'requires-route-recheck') fail(advice?.reason || 'intake-unavailable');
    const ranked = rankedThree(advice);
    files = state.locate(controls);
    held = state.acquire(files.lock, { ...(deps.lockOptions || {}), now: now(), ttlMs: policyRead.policy.lock.ttlSeconds * 1000 });
    if (!held.ok) fail('lock-busy');
    const fence = () => {
      state.fence(files.lock, held?.token, 'spawn');
      if (now() - held.acquiredAtMs >= policyRead.policy.lock.sectionMaxSeconds * 1000) fail('section-expired');
    };
    const controlsCheck = () => {
      fence();
      const current = state.gate(taskClass, { ...controls, now: now() });
      if (!current.effective || current.modeSha256 !== gate.modeSha256 || current.stateSha256 !== gate.stateSha256) fail('control-changed');
      return current;
    };
    const check = r => {
      const current = controlsCheck();
      // Fixer has the existing recovery invocations; Qwen/Kimi primary setup
      // belongs to cert-launch. Never choose an unimplemented fixer route.
      if (deps.launcher === 'fix' && !['codex', 'claude', 'vibe', 'kilo', 'mimo'].includes(r.client)) fail('launcher-route-unsupported');
      if (current.quarantined.includes(routeKey(r))) fail('route-quarantined');
      const checked = deps.recheck(r, { intake: result, reservationContext, now: now(), phase: 'select' });
      if (!quotaFile(r)) fail('quota-request-missing');
      return checked;
    };
    chosen = choose(ranked, check);
    if (!chosen.route) { release(); return { active: true, deferred: true, reason: chosen.reason, skipped: chosen.skipped, intake: result }; }
    fence();
    // Persist the intent before substitution or any spawn. The token is hashed;
    // no raw token enters durable records or the child environment.
    feedbackRoot = deps.feedbackRoot || path.join(modeApi.hostRoot(), '.ai/assign-feedback');
    machine = deps.machine || bridge.machineId();
    bridge.ensureFeedbackRoot(feedbackRoot);
    fence();
    const writeIntent = route => feedback.recordAssignment(feedbackRoot, { schema: 'assignment/1', assignmentId,
      tier: frame.tier, role: frame.role === 'fixer' ? 'fixer' : 'author', lockTokenSha256: hash(held.token),
      assignments: [{ client: route.client, model: route.model, effort: route.effort || 'none' }] }, machine, [assignmentId]);
    writeIntent(chosen.route);
    intent = true;
    record = { schema: 'launch-assign/1', assignmentId, taskClass, mode: 'assign', modeSha256: gate.modeSha256,
      stateSha256: gate.stateSha256, policySha256: policyRead.sha256, decidedAt: new Date(now()).toISOString(),
      route: { client: chosen.route.client, model: chosen.route.model, effort: chosen.route.effort },
      injected: ['client', 'model', ...(chosen.route.effort ? ['effort'] : [])], source: 'assign',
      chosenRank: chosen.route.rank, skippedRanks: chosen.skipped,
      routeRecheck: chosen.facts.routeRecheck, caps: chosen.facts.caps, quota: { status: 'allow' },
      intent: { eventId: `assigned-${assignmentId}`, writtenAt: new Date(now()).toISOString() },
      lock: { heldMs: now() - held.acquiredAtMs, tokenSha256: hash(held.token) },
      outcome: { status: 'running', failureClass: null, wallSeconds: null, verdicts: [], closedAt: null } };
    const finalCheck = () => {
      fence();
      const currentPolicy = state.readPolicy(deps.policyFile);
      if (!currentPolicy.ok || currentPolicy.sha256 !== policyRead.sha256) fail('control-changed');
      const latest = choose(ranked, r => {
        const checked = check(r);
        const reserved = deps.reserve(r, quotaFile(r));
        if (reserved?.status !== 'allow') fail(reserved?.reason || 'quota-unverified');
        return checked;
      });
      if (!latest.route) { const e = Error('ASSIGN-NONE-AVAILABLE'); e.code = e.message; e.skipped = latest.skipped; throw e; }
      if (routeIdentity(latest.route) !== routeIdentity(chosen.route)) {
        closeIntent('route-no-longer-first');
        assignmentId = `assign-launch-${o.name}-rank${latest.route.rank}`;
        writeIntent(latest.route); finished = false;
        record.assignmentId = assignmentId;
        record.intent = { eventId: `assigned-${assignmentId}`, writtenAt: new Date(now()).toISOString() };
        record.route = { client: latest.route.client, model: latest.route.model, effort: latest.route.effort };
        record.injected = ['client', 'model', ...(latest.route.effort ? ['effort'] : [])];
        record.chosenRank = latest.route.rank;
      } else if (latest.facts.routeRecheck.recordSha256 !== record.routeRecheck.recordSha256) fail('control-changed');
      chosen = latest;
      record.routeRecheck = latest.facts.routeRecheck;
      record.skippedRanks = latest.skipped;
      record.caps = latest.facts.caps;
      record.lock.heldMs = now() - held.acquiredAtMs;
      controlsCheck();
      return record;
    };
    return { active: true, intake: result, options: { ...inject(o, chosen.route), 'quota-request': quotaFile(chosen.route) }, record, finalCheck, cancel,
      currentOptions: () => ({ ...inject(o, chosen.route), 'quota-request': quotaFile(chosen.route) }),
      currentFacts: () => chosen.facts,
      beforeSpawn() {
        const currentPolicy = state.readPolicy(deps.policyFile);
        if (!currentPolicy.ok || currentPolicy.sha256 !== policyRead.sha256) fail('control-changed');
        controlsCheck();
      },
      didSpawn: () => spawned,
      markSpawned() { spawned = true; finished = true; },
      published: release,
      spawned() { spawned = true; finished = true; release(); }, release };
  } catch (e) {
    try { cancel(code(e)); } catch { release(); }
    return { active: true, deferred: true, reason: code(e), intake: result, skipped: e.skipped || [] };
  }
}

// Read-only preview from the same S5 file the wrapper will reserve. No descriptor
// can invent a live ledger. The route-specific request is still checked at spawn.
function quotaContext(file, deps = {}) {
  const q = require('../../docs/ops/quota-preflight.cjs');
  const doc = selection.readInput(file, 'assign-quota').obj;
  if (doc.schema === 'assign-quota/1') {
    if (Object.keys(doc).length !== 2 || !Array.isArray(doc.requests) || doc.requests.length < 1 || doc.requests.length > 3) fail('quota-bundle-invalid');
    const parts = doc.requests.map(f => {
      if (typeof f !== 'string' || !path.isAbsolute(f)) fail('quota-bundle-invalid');
      const context = quotaContext(f, deps);
      if (context.context) fail('quota-bundle-nested');
      return { file: f, context };
    });
    const first = parts[0].context;
    const sources = parts.map(p => selection.readInput(p.file, 'assign-quota').obj);
    if (sources.some(s => s.storeRoot !== sources[0].storeRoot || s.machine !== sources[0].machine || s.priceFile !== sources[0].priceFile)) fail('quota-bundle-coordination');
    if (parts.some(p => hash(p.context.snapshot) !== hash(first.snapshot) || hash(p.context.policy) !== hash(first.policy) || hash(p.context.states) !== hash(first.states))) fail('quota-bundle-inconsistent');
    const requests = parts.flatMap(p => p.context.requests);
    if (new Set(requests.map(r => routeKey(r.route))).size !== requests.length) fail('quota-bundle-duplicate');
    return { context: { ...first, requests }, files: parts.map(p => ({ file: p.file, client: p.context.requests[0].route.client, model: p.context.requests[0].route.model })) };
  }
  const assertPath = deps.assertPath || pathGuard;
  const store = q.createStore({ root: doc.storeRoot, machine: doc.machine, assertPath });
  assertPath(doc.priceFile, { root: path.dirname(doc.priceFile), write: false });
  const snapshot = require('../../.ai/bin/accounting/lib/price-snapshot.cjs').loadSnapshot(doc.priceFile);
  const policy = q.policyFor(path.resolve(__dirname, '../../docs/ops/S5-QUOTAS-POLICY.json'), path.resolve(__dirname, '../../docs/ops/ROUTE-BUDGETS.md'), new Date((deps.now || Date.now)()).toISOString().slice(0, 10));
  return { snapshot, policy, states: [store.read()], requests: [doc.request] };
}

function pathGuard(file, options = {}) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || options.write && require('../../.ai/bin/lib/protected-paths.cjs').hasProtectedName(file, { mode: 'segment' })) fail('quota-path-refused');
  const checked = require('../../.ai/bin/lib/path-safe.cjs').realInside(options.root || path.dirname(file), file, { refuseHardlinks: true, allowRoot: true });
  if (!checked.ok) fail('quota-path-refused');
  return checked.real;
}

function reserve(r, file, deps = {}) {
  try {
    const doc = selection.readInput(file, 'assign-quota').obj;
    const q = require('../../docs/ops/quota-preflight.cjs'), identity = q.routeIdentity(doc.request?.route);
    if (!identity) return { status: 'refuse', reason: 'quota-route-invalid' };
    return require('../../docs/ops/quota-launch-hook.cjs').beforeLaunch({ client: r.client, model: r.model,
      route: identity.routeId, 'quota-request': file }, { ...deps, assertPath: deps.assertPath || pathGuard,
      quotaCheckFile: deps.quotaCheckFile || ((f, opts) => q.checkFile(f, { ...opts, now: (deps.now || Date.now)() })) });
  } catch { return { status: 'ask-owner', reason: 'quota-input-unavailable' }; }
}

function recheckLaunch(r, context, deps) {
  return require('../operator/assign-bridge.cjs').recheckLaunch(r, context.intake.execution,
    { ...deps.assignment?.bridgeDeps, now: context.now, activeSeats: deps.activeSeats });
}

module.exports = { assignStep, choose, rankedThree, inject, quotaContext, recheckLaunch, hash, pathGuard, reserve };

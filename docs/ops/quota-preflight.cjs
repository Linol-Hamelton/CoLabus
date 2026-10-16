'use strict';
// S5, on-demand only. No launch, network, secret lookup or provider mutation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const D = require('../../.ai/bin/accounting/lib/decimal.cjs');
const prices = require('../../.ai/bin/accounting/lib/price-snapshot.cjs');
const { scanBuffer } = require('./history-archive/lib.cjs');
const ZERO = D.parse('0');
const MAX_AGE_MS = 15 * 60 * 1000;
const RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const digest = o => hash(JSON.stringify(o));
const decision = (status, reason, extra = {}) => ({ status, reason, ...extra });
const object = o => o !== null && typeof o === 'object' && !Array.isArray(o);
const money = s => {
  if (typeof s !== 'string' || !/^(0|[1-9][0-9]{0,8})(\.[0-9]{1,18})?$/.test(s)) return null;
  return D.parse(s);
};
const sum = values => values.reduce((a, s) => D.add(a, money(s)), ZERO);
const id = s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(s);
const hex = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
const iso = s => {
  if (typeof s !== 'string' || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(s)) return false;
  const ms = Date.parse(s);
  return Number.isFinite(ms) && new Date(ms).toISOString() === s;
};
const fresh = (at, now) => iso(at) && Date.parse(at) <= now && now - Date.parse(at) <= MAX_AGE_MS;
const keys = (o, names) => object(o) && Object.keys(o).every(k => names.includes(k)) && names.every(k => Object.hasOwn(o, k));
function safeValue(o) { return scanBuffer(Buffer.from(JSON.stringify(o))).count === 0; }

function routeIdentity(route) {
  if (!keys(route, ['client', 'model', 'platform', 'provider', 'keyAlias', 'pool']) ||
      !['cash', 'vibe'].includes(route.pool) || !Object.values(route).every(id) || !safeValue(route)) return null;
  // Public key alias is deliberately hashed separately from the route. Never pass a key value.
  return { routeId: digest([route.client, route.model, route.platform, route.provider]), keyId: hash(route.keyAlias), pool: route.pool };
}

function priceFor(snapshot, route, now) {
  if (!snapshot || snapshot.schema !== 'price-snapshot/1' || !fresh(snapshot.capturedAt, now)) return null;
  const rows = snapshot.records.filter(r => r.platform === route.platform && r.platformModelId === route.model &&
    (r.provider || 'default') === route.provider && r.modelType === 'language');
  if (!rows.length || rows.some(r => !money(r.inputPerM) || !money(r.outputPerM))) return null;
  const signatures = new Set(rows.map(r => JSON.stringify([r.inputPerM, r.outputPerM, r.free, r.variant, r.priceKind])));
  if (signatures.size !== 1) return null;
  const r = rows[0];
  return { input: money(r.inputPerM), output: money(r.outputPerM),
    free: r.free === true && r.variant === 'free' && D.cmp(money(r.inputPerM), ZERO) === 0 && D.cmp(money(r.outputPerM), ZERO) === 0 };
}

function boundFor(price, tokens) {
  if (!keys(tokens, ['input', 'output']) || !Object.values(tokens).every(n => Number.isSafeInteger(n) && n >= 0)) return null;
  return D.shift10(D.add(D.mulInt(price.input, tokens.input), D.mulInt(price.output, tokens.output)), -6);
}

function validBaseline(b, day, now) {
  return keys(b, ['day', 'at', 'externalCash', 'externalVibe']) && b.day === day && fresh(b.at, now) &&
    money(b.externalCash) !== null && money(b.externalVibe) !== null;
}
function validQuota(q, now) {
  return keys(q, ['at', 'routeDailyCap', 'routeSpent', 'keyRemaining', 'providerRemaining', 'providerBalance']) &&
    fresh(q.at, now) && ['routeDailyCap', 'routeSpent', 'keyRemaining', 'providerRemaining', 'providerBalance'].every(k => money(q[k]) !== null);
}

function stateProblem(s, machine) {
  if (!keys(s, ['schema', 'machine', 'baselines', 'reservations', 'health']) || s.schema !== 's5-state/1' || s.machine !== machine ||
      !object(s.baselines) || !object(s.reservations) || !object(s.health) || !safeValue(s)) return true;
  for (const [day, b] of Object.entries(s.baselines)) {
    if (!/^\d{4}-\d\d-\d\d$/.test(day) || !keys(b, ['day', 'at', 'externalCash', 'externalVibe']) || b.day !== day ||
        !iso(b.at) || !(b.externalCash === null && b.externalVibe === null || money(b.externalCash) && money(b.externalVibe))) return true;
  }
  for (const [rid, r] of Object.entries(s.reservations)) {
    if (!hex(rid) || !keys(r, ['routeId', 'keyId', 'pool', 'day', 'createdAt', 'expiresAt', 'bound', 'actual', 'settledAt']) ||
        !hex(r.routeId) || !hex(r.keyId) || !['cash', 'vibe'].includes(r.pool) || !s.baselines[r.day] ||
        !iso(r.createdAt) || !iso(r.expiresAt) || Date.parse(r.expiresAt) - Date.parse(r.createdAt) !== RESERVATION_TTL_MS ||
        !money(r.bound) || !(r.actual === null || money(r.actual)) ||
        (r.actual === null ? r.settledAt !== null : !iso(r.settledAt))) return true;
  }
  for (const [routeId, h] of Object.entries(s.health)) {
    if (!hex(routeId) || !keys(h, ['status', 'at', 'modelHash', 'sessionHash']) ||
        !['healthy', 'unhealthy', 'unknown'].includes(h.status) || !iso(h.at) || !hex(h.modelHash) || !hex(h.sessionHash)) return true;
  }
  return false;
}

// Shared guard adapter contract, intentionally no private realpath/text/Markdown guard copy.
// Until .ai/bin/lib/path-safe.cjs lands, production returns ask-owner. A caller may provide
// assertPath(file, {root, write}); it MUST reject links in all ancestors, hardlinks and aliases,
// and recheck immediately before every write/rename. It throws without echoing the input.
function createStore({ root, machine, assertPath }) {
  if (typeof assertPath !== 'function') throw new Error('path-guard-unavailable');
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(machine || '')) throw new Error('machine-invalid');
  const parts = path.resolve(root).split(path.sep).map(s => s.toLowerCase());
  if (parts.some((s,i) => s === '.ai' && parts[i + 1] === 'runtime')) throw new Error('durable-root-required');
  const file = path.join(root, `s5-${machine}.json`);
  // One coordination root, shared filesystem lock, separate durable files per machine.
  // Replicated independent directories (e.g. asynchronous sync) are NOT a lock service.
  const lock = path.join(root, 's5-ledger.lock');
  const guard = (p, write = false) => assertPath(p, { root, write });
  const readMachine = (otherMachine = machine) => {
    const source = path.join(root, `s5-${otherMachine}.json`);
    guard(source);
    let bytes;
    try { bytes = fs.readFileSync(source); } catch (e) { if (e.code === 'ENOENT') return null; throw new Error('state-unreadable'); }
    try {
      const e = JSON.parse(bytes.toString('utf8'));
      if (!keys(e, ['state', 'sha256']) || digest(e.state) !== e.sha256 ||
          !Buffer.from(JSON.stringify(e) + '\n').equals(bytes) || stateProblem(e.state, otherMachine)) throw new Error();
      return e.state;
    } catch { throw new Error('state-corrupt'); }
  };
  const transaction = fn => {
    guard(root, true);
    fs.mkdirSync(root, { recursive: true });
    guard(lock, true);
    try { fs.mkdirSync(lock); } catch (e) { throw new Error(e.code === 'EEXIST' ? 'state-busy-or-crash-lock' : 'lock-write-failed'); }
    const nonce = crypto.randomBytes(16).toString('hex');
    try {
      const state = readMachine() || { schema: 's5-state/1', machine, baselines: {}, reservations: {}, health: {} };
      guard(root);
      const fleet = fs.readdirSync(root).map(n => /^s5-([a-z][a-z0-9-]{1,31})\.json$/.exec(n)).filter(Boolean)
        .filter(m => m[1] !== machine).map(m => readMachine(m[1]));
      const result = fn(state, fleet);
      if (stateProblem(state, machine)) throw new Error('state-invalid');
      const temp = path.join(root, `s5-${machine}-${nonce}.tmp`);
      guard(temp, true);
      const fd = fs.openSync(temp, 'wx');
      try { fs.writeFileSync(fd, JSON.stringify({ state, sha256: digest(state) }) + '\n'); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      guard(temp); guard(file, true);
      fs.renameSync(temp, file);
      return result;
    } finally {
      // No lock stealing or age-based recovery. A process crash needs operator inspection.
      guard(lock, true);
      const retired = path.join(root, `s5-${machine}-lock-${nonce}`);
      guard(retired, true);
      fs.renameSync(lock, retired);
    }
  };
  return { file, read: readMachine, transaction };
}

function preflight(request, { store, snapshot, policy, now = Date.now() }) {
  try {
    if (!request || !request.route) return decision('ask-owner', 'explicit-route-required');
    const identity = routeIdentity(request.route);
    if (!identity || !hex(request.reservationId)) return decision('refuse', 'request-invalid');
    // Safety attribution, from ' distinct Mistral/Vibe allowance.
    // An aggregator/API route must not relabel its cash charge as subscription allowance.
    if (identity.pool === 'vibe' && (request.route.client !== 'vibe' || request.route.platform !== 'mistral'))
      return decision('refuse', 'billing-pool-mismatch');
    const day = new Date(now).toISOString().slice(0, 10);
    const price = priceFor(snapshot, request.route, now);
    if (!price) return decision('refuse', 'price-unknown-or-stale');
    const bound = price.free ? ZERO : boundFor(price, request.maxTokens);
    if (!bound) return decision('refuse', 'usage-bound-unknown');
    if (!price.free && (!validBaseline(request.baseline, day, now) || !validQuota(request.quota, now))) return decision('refuse', 'usage-or-quota-unknown');
    if (!policy || !money(policy.cashDaily) || !money(policy.vibeDaily) || !money(policy.reserveFraction)) return decision('ask-owner', 'policy-unavailable');
    return store.transaction((state, fleet) => {
      const h = state.health[identity.routeId];
      if (!h || !fresh(h.at, now) || h.modelHash !== hash(request.route.model)) return decision('refuse', 'model-proof-unknown-or-stale');
      if (h.status !== 'healthy') return decision('refuse', 'route-unhealthy');
      const existing = [state, ...fleet].some(s => s.reservations[request.reservationId]);
      if (existing) return decision('refuse', 'reservation-id-already-used');
      if (!price.free) {
        const baselines = [state, ...fleet].map(s => s.baselines[day]).filter(b => b && b.externalCash !== null);
        if (baselines.some(b => digest(b) !== digest(request.baseline))) return decision('ask-owner', 'baseline-disagreement');
        const rows = [state, ...fleet].flatMap(s => Object.values(s.reservations));
        // An expired unsettled reservation remains debt, including across UTC midnight.
        const relevant = rows.filter(r => r.actual === null || r.day === day);
        const counted = r => r.actual === null ? r.bound : r.actual;
        const used = sum(relevant.filter(r => r.pool === identity.pool).map(counted));
        const external = money(identity.pool === 'cash' ? request.baseline.externalCash : request.baseline.externalVibe);
        const cap = money(identity.pool === 'cash' ? policy.cashDaily : policy.vibeDaily);
        if (D.cmp(D.add(D.add(used, external), bound), cap) > 0) return decision('ask-owner', 'daily-ceiling');
        const q = request.quota;
        const routeUsed = sum(relevant.filter(r => r.routeId === identity.routeId).map(counted));
        const keyUsed = sum(relevant.filter(r => r.keyId === identity.keyId).map(counted));
        // Account quota includes every local route in the same pool, not just this key.
        const reserve = money(policy.reserveFraction);
        if (D.cmp(reserve, money('0.2')) !== 0) return decision('ask-owner', 'policy-reserve-invalid');
        const providerRoom = D.sub(money(q.providerRemaining), D.shift10(D.mulInt(money(q.providerBalance), 20), -2));
        if (D.cmp(D.add(D.add(routeUsed, money(q.routeSpent)), bound), money(q.routeDailyCap)) > 0 ||
            D.cmp(D.add(keyUsed, bound), money(q.keyRemaining)) > 0 || D.cmp(D.add(used, bound), providerRoom) > 0)
          return decision('refuse', 'route-key-or-provider-quota');
      }
      // Free calls do not consume money; an explicit zero baseline is only for that proven-free case.
      // Unknown baselines remain null after a free call; never create a paid zero baseline.
      if (!state.baselines[day]) state.baselines[day] = !price.free ? request.baseline :
        { day, at: new Date(now).toISOString(), externalCash: null, externalVibe: null };
      if (!price.free && state.baselines[day].externalCash === null) state.baselines[day] = request.baseline;
      state.reservations[request.reservationId] = { ...identity, day, createdAt: new Date(now).toISOString(),
        expiresAt: new Date(now + RESERVATION_TTL_MS).toISOString(), bound: D.toString(bound), actual: null, settledAt: null };
      return decision('allow', price.free ? 'proven-free' : 'reserved', { reservationId: request.reservationId, reservedUsd: D.toString(bound) });
    });
  } catch { return decision('ask-owner', 'storage-unavailable'); }
}

function settle(store, reservationId, actual, now = Date.now()) {
  if (!hex(reservationId) || !money(actual)) return decision('refuse', 'terminal-cost-unknown');
  try { return store.transaction(s => {
    const r = s.reservations[reservationId];
    if (!r) return decision('refuse', 'reservation-missing');
    if (r.actual !== null) return decision(D.cmp(money(r.actual), money(actual)) === 0 ? 'allow' : 'refuse', 'settlement-already-recorded');
    r.actual = D.toString(money(actual)); r.settledAt = new Date(now).toISOString();
    return decision('allow', D.cmp(money(actual), money(r.bound)) > 0 ? 'overspend-recorded' : 'settled');
  }); } catch { return decision('ask-owner', 'storage-unavailable'); }
}

function healthFromMeta(meta, route, sessionId, startedAt, endedAt, aliases = {}) {
  const identity = routeIdentity(route);
  const unknown = { status: 'unknown', at: endedAt, modelHash: hash(String(route && route.model)), sessionHash: hash(String(sessionId)) };
  if (!identity || !id(sessionId) || !iso(startedAt) || !iso(endedAt) || Date.parse(endedAt) < Date.parse(startedAt) || !object(meta)) return unknown;
  // Explicit session meta, never newest log directory, agent prose, config alias alone or --version.
  if (meta.session_id !== sessionId || !iso(meta.started_at) || Date.parse(meta.started_at) < Date.parse(startedAt) ||
      Date.parse(meta.started_at) > Date.parse(endedAt) || !Array.isArray(meta.served_models) || !meta.served_models.length ||
      !meta.served_models.every(id) || !safeValue(meta.served_models)) return unknown;
  const served = [...new Set(meta.served_models)];
  if (served.length !== 1) return unknown;
  const targets = aliases[route.model];
  const requested = targets === undefined ? route.model : Array.isArray(targets) && targets.length === 1 && id(targets[0]) ? targets[0] : null;
  return { ...unknown, status: requested === null ? 'unknown' : served[0] === requested ? 'healthy' : 'unhealthy' };
}

function probe(store, route, meta, window, aliases = {}) {
  const identity = routeIdentity(route);
  if (!identity) return decision('refuse', 'explicit-route-required');
  const health = healthFromMeta(meta, route, window.sessionId, window.startedAt, window.endedAt, aliases);
  if (!iso(health.at)) return decision('refuse', 'probe-window-invalid');
  try { return store.transaction(s => { s.health[identity.routeId] = health; return decision(health.status === 'healthy' ? 'allow' : 'refuse', `model-${health.status}`); }); }
  catch { return decision('ask-owner', 'storage-unavailable'); }
}

function policyFor(file, budgetFile, day) {
  const p = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (p.schema !== 's5-policy/1' || hash(fs.readFileSync(budgetFile)) !== p.budgetSha256 || p.cashDaily !== '15' ||
      p.reserveFraction !== '0.2' || p.vibeNormal !== '6' || p.vibeIntro !== '22') throw new Error('policy-invalid');
  return { cashDaily: p.cashDaily, reserveFraction: p.reserveFraction,
    vibeDaily: day >= p.vibeIntroStart && day <= p.vibeIntroEnd ? p.vibeIntro : p.vibeNormal };
}

function checkFile(file, { assertPath, expectedRoute, now = Date.now() } = {}) {
  try {
    if (typeof assertPath !== 'function') return decision('ask-owner', 'path-guard-unavailable');
    assertPath(file, { root: path.dirname(file), write: false });
    const r = JSON.parse(fs.readFileSync(file, 'utf8'));
    const identity = routeIdentity(r.request?.route);
    if (!identity || !expectedRoute || expectedRoute.routeId !== identity.routeId ||
        expectedRoute.client !== r.request.route.client || expectedRoute.model !== r.request.route.model)
      return decision('refuse', 'route-disagreement');
    const store = createStore({ root: r.storeRoot, machine: r.machine, assertPath });
    assertPath(r.priceFile, { root: path.dirname(r.priceFile), write: false });
    const snapshot = prices.loadSnapshot(r.priceFile);
    const policy = policyFor(path.join(__dirname, 'S5-QUOTAS-POLICY.json'), path.join(__dirname, 'ROUTE-BUDGETS.md'), new Date(now).toISOString().slice(0, 10));
    return preflight(r.request, { store, snapshot, policy, now });
  } catch { return decision('ask-owner', 'input-unavailable'); }
}

module.exports = { createStore, preflight, settle, probe, healthFromMeta, priceFor, boundFor, policyFor, checkFile,
  routeIdentity, stateProblem, money, hash, MAX_AGE_MS, RESERVATION_TTL_MS };

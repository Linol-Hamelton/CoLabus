'use strict';
// Selection: seven strict documents plus explicit time. Pure plan, no launch or write.
// The selector reads NO client logs; quotas are declared operator data.
const path = require('node:path');
const { createHash } = require('node:crypto');
function loadModule(file, load) {
  try { return load(); } catch {
    const error = new Error(`Selection REFUSED reason=selection-module-load: ${file}`);
    error.code = 'selection-module-load';
    if (require.main === module) { console.error(error.message); process.exit(2); }
    throw error;
  }
}
const selectionPolicy = loadModule('tools/assign/selection-policy.cjs', () => require('../../tools/assign/selection-policy.cjs'));
const { complexity } = loadModule('tools/assign/complexity.cjs', () => require('../../tools/assign/complexity.cjs'));
const { readInput, Refusal } = selectionPolicy;
const INPUTS = Object.freeze(['ladder', 'clients', 'quotas', 'policy', 'aliases', 'supplement', 'task']);
// PROTO-DEC-0221 item 1: the model identity library
// is required HERE, at module load, and the plan calls only buildIdentity, its
// in-memory entry point, with the already parsed alias and identity documents
// as arguments. Since this round of the library, a require of it reads no file
// and consults no environment variable (its default data loads at the first
// use of a DEFAULT function, and the plan never calls one), so the require
// costs no read and plan() itself performs no require and no file read.
const modelIdentity = loadModule('.ai/bin/lib/model-identity.cjs', () => require('../../.ai/bin/lib/model-identity.cjs'));
// family resolution, exclusion parsing and route validity are SEAT-FAILOVER's
// (docs/ops/seat-failover.cjs), imported, never copied.
const seatFailover = loadModule('docs/ops/seat-failover.cjs', () => require('./seat-failover.cjs'));
// the consumer's own effort rule of the cert launch path (P-L3-005) that
// SEAT-FAILOVER applies to this plan's argv; effortFor is pure given a registry.
const certLaunch = loadModule('docs/ops/cert-launch.cjs', () => require('./cert-launch.cjs'));
// the kernel P-L3-005 effort mechanism, called, never copied.
const ladderBuild = loadModule('docs/ops/ladder-build.cjs', () => require('./ladder-build.cjs'));
const resolver = loadModule('.ai/bin/protocol-dispatch/resolver.cjs', () => require('../../.ai/bin/protocol-dispatch/resolver.cjs'));

// PROTO-DEC-0221 item 2: the repository root of this
// module's own repository, found once. The default location of every declared
// input resolves against THIS root, never against the current working
// directory: a CLI run from another directory that holds its own copies of
// the inputs still plans from this repository's data.
const REPO = path.resolve(__dirname, '..', '..');
const inRepo = relative => path.join(REPO, relative);
const DEFAULT_LADDER = inRepo('docs/ops/model-ladder.json');
const DEFAULT_CLIENTS = inRepo('.ai/docs/clients.json');
const DEFAULT_QUOTAS = inRepo('docs/ops/l3-select-quotas.json');
const DEFAULT_ALIASES = inRepo('docs/product/launch-records/data/model-aliases.json');
const DEFAULT_SUPPLEMENT = inRepo('.ai/bin/lib/model-identity-data.json');
const DEFAULT_POLICY = selectionPolicy.DEFAULT;
const PLAN_SCHEMA = 'l3-select-plan/7';
const COST_RANK = Object.freeze({ free: 0, subscription: 1, 'per-token': 2, unknown: 3 });
const WINDOW_KINDS = Object.freeze(['5-hour', 'weekly', 'monthly', 'credit']);
const COST_BASES = Object.freeze(['free', 'subscription', 'per-token']);
const UNITS = Object.freeze(['percent', 'usd', 'tokens', 'requests']);
// The closed output domain of the kernel ladder builder (ladder-build.cjs
// effortStatusOf): every status the builder can stamp into a ladder row. A stored
// status outside it never refuses the ladder: the ROW is excluded by name (review finding).
const KERNEL_EFFORT_STATUSES = Object.freeze(['client-unregistered', 'unknown', 'in-model-id', 'in-registry-values', 'not-in-registry-values', 'client-config', 'not-settable']);
// The canonicality domain of client keys: ASCII lower-case; a lookalike
// (Cyrillic or Greek homoglyph) key is refused by name at load.
const CLIENT_KEY_RE = /^[a-z][a-z0-9-]{0,63}$/;
// a placeholder is not an identifier. ONE closed list, ONE function,
// shared by every identifier of the declared inputs: quota window ids, quota
// route ids (the whole route and each of its parts), ladder row ids, ladder
// clients and route models, and role names. A placeholder id is a named refusal
// of the record that carries it, never a value that reaches a plan.
const PLACEHOLDER_IDS = Object.freeze(['unknown', 'tbd', 'n/a', 'na', 'none', 'null', 'nil', 'empty', '-', '?']);
const isPlaceholderId = s => typeof s === 'string' && PLACEHOLDER_IDS.includes(s.toLowerCase());

const isoDate = s => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(s)) return false;
  const ms = Date.parse(s);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === s.slice(0, 19);
};
const isPlain = o => o !== null && typeof o === 'object' && !Array.isArray(o);
const isId = (s, max) => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,}$/.test(s) && s.length <= max;

// ---- the model ladder (docs/ops/model-ladder.json, schema ladder/2; rows only, as data) ----
// the stored effortStatus is inert data for the decision; it must be
// a string or null at load, and a value outside the kernel builder's closed output
// domain excludes the ROW at selection time, never the whole ladder.
function checkLadder(obj) {
  if (obj.schema !== 'ladder/2') throw new Refusal('ladder-schema', `schema is ${JSON.stringify(obj.schema)}, expected ladder/2`);
  if (!Array.isArray(obj.rows)) throw new Refusal('ladder-schema', 'rows must be an array');
  const rows = obj.rows.map((row, i) => {
    const where = `rows[${i}]`;
    if (!isPlain(row)) throw new Refusal('ladder-schema', `${where} must be an object`);
    for (const [key, type] of [['id', 'string'], ['client', 'string']]) if (typeof row[key] !== 'string' || !row[key]) throw new Refusal('ladder-schema', `${where}.${key} must be a non-empty string`);
    // a placeholder is not an identifier, in the id, the client or
    // the route model alike; the record is refused by name.
    if (isPlaceholderId(row.id) || isPlaceholderId(row.client)) throw new Refusal('ladder-schema', `${where}: a placeholder (${PLACEHOLDER_IDS.join(', ')}) is not an identifier`);
    if (row.routeModel !== null && typeof row.routeModel !== 'string') throw new Refusal('ladder-schema', `${where}.routeModel must be a string or null`);
    if (row.routeModel !== null && (!isId(row.routeModel, 160) || isPlaceholderId(row.routeModel))) throw new Refusal('ladder-schema', `${where}.routeModel is not a model spelling`);
    if (row.tier !== null && (!Number.isInteger(row.tier) || row.tier < 1 || row.tier > 9)) throw new Refusal('ladder-schema', `${where}.tier must be an integer T1-T9 or null`);
    if (row.effort !== null && typeof row.effort !== 'string') throw new Refusal('ladder-schema', `${where}.effort must be a string or null`);
    if (row.effortStatus !== undefined && row.effortStatus !== null && typeof row.effortStatus !== 'string') throw new Refusal('ladder-schema', `${where}.effortStatus must be a string or null`);
    if (row.approval !== null && row.approval !== 'none' && row.approval !== 'owner-long-task') throw new Refusal('ladder-schema', `${where}.approval must be "none", "owner-long-task" or null`);
    return { pos: i, id: row.id, maker: typeof row.maker === 'string' ? row.maker : null, client: row.client, routeModel: row.routeModel, tier: row.tier, effort: row.effort, effortStatus: row.effortStatus === undefined ? null : row.effortStatus, approval: row.approval };
  });
  const seen = new Set();
  for (const row of rows) {
    if (seen.has(row.id)) throw new Refusal('ladder-schema', `two rows with id ${row.id}`);
    seen.add(row.id);
  }
  return { schema: obj.schema, asOf: typeof obj.asOf === 'string' ? obj.asOf : null, rows };
}

// ---- the client registry (.ai/docs/clients.json, schema clients/1; presence and the effort block) ----
function checkClients(obj) {
  if (obj.schema !== 'clients/1') throw new Refusal('clients-schema', `schema is ${JSON.stringify(obj.schema)}, expected clients/1`);
  if (!isPlain(obj.clients)) throw new Refusal('clients-schema', 'clients must be an object');
  for (const [name, entry] of Object.entries(obj.clients)) {
    if (!CLIENT_KEY_RE.test(name)) throw new Refusal('clients-schema', `clients.${name}: a client name is ASCII lower-case letters, digits and hyphens (lookalike spellings are refused)`);
    if (!isPlain(entry)) throw new Refusal('clients-schema', `clients.${name} must be an object`);
    if (typeof entry.present !== 'boolean') throw new Refusal('clients-schema', `clients.${name}.present must be a boolean`);
    // The effort block is the kernel P-L3-005 data the effort status is computed from.
    if (entry.effort !== undefined) {
      if (!isPlain(entry.effort)) throw new Refusal('clients-schema', `clients.${name}.effort must be an object`);
      if (entry.effort.values !== undefined && entry.effort.values !== null && (!Array.isArray(entry.effort.values) || !entry.effort.values.every(v => typeof v === 'string' && v))) throw new Refusal('clients-schema', `clients.${name}.effort.values must be null or a list of non-empty strings`);
    }
  }
  return obj;
}

// ---- in-memory role view of the canonical policy ----
// a topCost model spelling is canonicalised by model-identity; a
// non-canonical spelling refuses the role table, never silently voids the check.
function checkRoles(obj, identity) {
  if (obj.schema !== 'l3-select-roles/1') throw new Refusal('roles-schema', `schema is ${JSON.stringify(obj.schema)}, expected l3-select-roles/1`);
  if (typeof obj.source !== 'string' || !obj.source.trim()) throw new Refusal('roles-schema', 'source is required (where the tier floors come from)');
  if (!Array.isArray(obj.taskClasses) || !obj.taskClasses.length || obj.taskClasses.some(c => typeof c !== 'string' || !/^[A-Z]$/.test(c)) || new Set(obj.taskClasses).size !== obj.taskClasses.length) throw new Refusal('roles-schema', 'taskClasses must be a non-empty list of distinct single capital letters');
  if (!isPlain(obj.roles)) throw new Refusal('roles-schema', 'roles must be an object');
  if (!isPlain(obj.topCost) || !Array.isArray(obj.topCost.models) || !obj.topCost.models.every(m => isId(m, 160)) || typeof obj.topCost.reason !== 'string' || !obj.topCost.reason.trim()) throw new Refusal('roles-schema', 'topCost must hold a models list and a reason');
  for (const m of obj.topCost.models) {
    if (identity.canonicalRouteId(m) === 'UNKNOWN') throw new Refusal('roles-schema', `topCost model ${JSON.stringify(m)} is not a canonical model spelling (model-identity)`);
  }
  const topCost = new Set(obj.topCost.models.map(m => identity.canonicalRouteId(m)));
  for (const [name, role] of Object.entries(obj.roles)) {
    const where = `roles.${name}`;
    if (!isId(name, 63)) throw new Refusal('roles-schema', `${where}: not a role name`);
    // a placeholder is not an identifier; a role name
    // is checked by the same ONE list as every other identifier of the inputs.
    if (isPlaceholderId(name)) throw new Refusal('roles-schema', `${where}: a placeholder (${PLACEHOLDER_IDS.join(', ')}) is not a role name`);
    if (!isPlain(role)) throw new Refusal('roles-schema', `${where} must be an object`);
    // PROTO-DEC-0226 item 2: the role table keeps only floors that are
    // specific to a role. The author role carries NO tierFloor at all (its
    // required tier is the task tier of the assignment policy alone), so the
    // field is optional; a role that has one must give an integer floor T1-T9
    // for every task class and nothing else.
    if (role.tierFloor !== undefined) {
      if (!isPlain(role.tierFloor)) throw new Refusal('roles-schema', `${where}.tierFloor must be an object`);
      const floors = Object.keys(role.tierFloor);
      if (floors.length !== obj.taskClasses.length || !obj.taskClasses.every(c => Number.isInteger(role.tierFloor[c]) && role.tierFloor[c] >= 1 && role.tierFloor[c] <= 9)) throw new Refusal('roles-schema', `${where}.tierFloor must give an integer floor T1-T9 for every task class and nothing else`);
    }
    if (!Array.isArray(role.excludeFamilies) || !role.excludeFamilies.every(f => typeof f === 'string' && identity.declaredFamily(f) !== 'UNKNOWN')) throw new Refusal('roles-schema', `${where}.excludeFamilies must be a list of known family names`);
    if (new Set(role.excludeFamilies).size !== role.excludeFamilies.length) throw new Refusal('roles-schema', `${where}.excludeFamilies names a family twice`);
    if (typeof role.admitTierUnknown !== 'boolean') throw new Refusal('roles-schema', `${where}.admitTierUnknown must be a boolean`);
  }
  return { obj, topCost };
}

// ---- the machine quota registry (docs/ops/l3-select-quotas.json, schema l3-quotas/1) ----
// every record is validated; any invalid record refuses the registry with a named
// reason; unknown stays null. Window schema (documented in
// docs/ops/l3-select.cjs):
//   id          unique window id
//   kind        "5-hour" | "weekly" | "monthly" | "credit"
//   remaining   amount when known, else null (a percent stays within 0..100)
//   unit        "percent" | "usd" | "tokens" | "requests" | null (required when remaining is known)
//   total       normalization base when known, else null (a percent window carries total 100)
//   resetAt     ISO 8601 reset time when known, else null
//   costBasis   "free" | "subscription" | "per-token"
//   routes      "client:model" routes that share this window (may be empty: a window
//               may document a machine quota no ladder route maps)
//   source      who or what entered the record (e.g. "operator-observation")
//   observedAt  ISO 8601 observation time (required)
//   note        optional free text with the citation
// the records are entered by the operator (a later L6 tool derives them from
// the structured launch records of L5); the selector itself reads no client logs.
// the route shape of a record is SEAT-FAILOVER's grammar, imported, and every
// route model part is canonicalised by model-identity: a non-canonical spelling
// refuses the record (review finding), never silently voids the window. A percent window
// must carry total exactly 100 (review finding); a percent remaining above 100 is refused.
function registryRouteProblem(route, identity) {
  // the model part is canonicalised by model-identity first; a
  // non-canonical spelling refuses the record, never silently voids the window.
  const model = route.slice(route.indexOf(':') + 1);
  if (identity.canonicalRouteId(model) === 'UNKNOWN') return `${JSON.stringify(route)} does not name a canonical model spelling (model-identity)`;
  try {
    seatFailover.plan(['--client', 'claude', '--model', 'claude-opus-5-5', '--fallback', route], 'cert',
      { registry: { clients: {} }, modelIdentity: identity });
  } catch (e) {
    const message = String(e.message);
    if (/^unsupported-invocation client=/.test(message) || message === 'fallback client is unavailable' || message === 'duplicate route') return null;
    return `${JSON.stringify(route)} is not a "client:model" route (the SEAT-FAILOVER grammar)`;
  }
  return null;
}
function windowProblem(w, where, identity, now) {
  if (!isId(w.id, 63)) return `${where}.id is not a window id`;
  // a placeholder is not an identifier; quota window id is refused by name.
  if (isPlaceholderId(w.id)) return `${where}.id: a placeholder (${PLACEHOLDER_IDS.join(', ')}) is not an identifier`;
  if (!WINDOW_KINDS.includes(w.kind)) return `${where}.kind must be one of ${WINDOW_KINDS.join(', ')}`;
  if (w.remaining !== null && (!Number.isFinite(w.remaining) || w.remaining < 0)) return `${where}.remaining must be a finite amount >= 0 or null`;
  if (w.remaining !== null && w.unit === null) return `${where}.remaining is known but the unit is unknown`;
  if (w.unit !== null && !UNITS.includes(w.unit)) return `${where}.unit must be one of ${UNITS.join(', ')} or null`;
  if (w.total !== null && (!Number.isFinite(w.total) || w.total <= 0)) return `${where}.total must be a finite amount > 0 or null`;
  if (w.unit === 'percent' && w.total !== 100) return `${where}.total must be exactly 100 for a percent window`;
  if (w.remaining !== null && w.unit === 'percent' && w.remaining > 100) return `${where}.remaining is a percent above 100`;
  if (w.remaining !== null && w.total !== null && w.remaining > w.total) return `${where}.remaining is above the total ${w.total}`;
  if (w.resetAt !== null && !isoDate(w.resetAt)) return `${where}.resetAt is not an ISO 8601 time`;
  if (!COST_BASES.includes(w.costBasis)) return `${where}.costBasis must be one of ${COST_BASES.join(', ')}`;
  if (!Array.isArray(w.routes)) return `${where}.routes must be a list of "client:model" routes`;
  for (const r of w.routes) {
    if (typeof r !== 'string') return `${where}.routes must hold strings`;
    const problem = registryRouteProblem(r, identity);
    if (problem) return `${where}.routes: ${problem}`;
  }
  if (new Set(w.routes).size !== w.routes.length) return `${where}.routes names a route twice`;
  const canonical = w.routes.map(r => `${r.slice(0, r.indexOf(':'))}:${identity.canonicalRouteId(r.slice(r.indexOf(':') + 1))}`);
  if (new Set(canonical).size !== canonical.length) return `${where}.routes names one canonical route twice through two spellings`;
  if (typeof w.source !== 'string' || !/^[a-z][a-z-]{0,63}$/.test(w.source)) return `${where}.source must name the reader or the observation kind`;
  if (!isoDate(w.observedAt)) return `${where}.observedAt is not an ISO 8601 time`;
  // an observation from the future is not a record, and a window
  // whose reset is not later than its own observation is internally inconsistent:
  // each is a named refusal of the record, never a definite number in the plan.
  if (Date.parse(w.observedAt) > now) return `${where}.observedAt is later than --now: an observation from the future is not a record`;
  if (w.resetAt !== null && Date.parse(w.resetAt) <= Date.parse(w.observedAt)) return `${where}.resetAt is not later than observedAt: the window reset before it was observed`;
  if (w.note !== undefined && w.note !== null && typeof w.note !== 'string') return `${where}.note must be a string or null`;
  return null;
}
function checkQuotas(obj, identity, now) {
  if (obj.schema !== 'l3-quotas/1') throw new Refusal('quotas-schema', `schema is ${JSON.stringify(obj.schema)}, expected l3-quotas/1`);
  if (!Array.isArray(obj.windows)) throw new Refusal('quotas-schema', 'windows must be an array');
  const seen = new Set();
  const windows = obj.windows.map((w, i) => {
    if (!isPlain(w)) throw new Refusal('quotas-schema', `windows[${i}] must be an object`);
    const problem = windowProblem(w, `windows[${i}]`, identity, now);
    if (problem) throw new Refusal('quotas-schema', problem);
    if (seen.has(w.id)) throw new Refusal('quotas-schema', `two windows with id ${w.id}`);
    seen.add(w.id);
    return { id: w.id, kind: w.kind, remaining: w.remaining, unit: w.unit, total: w.total, resetAt: w.resetAt, costBasis: w.costBasis, routes: w.routes.slice(), canonicalRoutes: w.routes.map(r => `${r.slice(0, r.indexOf(':'))}:${identity.canonicalRouteId(r.slice(r.indexOf(':') + 1))}`), source: w.source, observedAt: w.observedAt, note: w.note === undefined ? null : w.note };
  });
  return { schema: obj.schema, updated: typeof obj.updated === 'string' ? obj.updated : null, windows };
}

// ---- quota state of one route (windows whose reset time has passed carry no state) ----
function normalizeRemaining(w) {
  if (typeof w.remaining !== 'number') return null;
  if (w.unit === 'percent') return w.remaining / 100;
  if (typeof w.total === 'number') return w.remaining / w.total;
  return null;
}
// per route the live window with the earliest resetAt is taken as a
// whole - its own cost basis and its own fraction, never a pair built from two
// windows. Ties are broken by the window id, so the choice is deterministic.
// two live windows of one route that share a resetAt and disagree
// on the value contradict each other: the quota of that route is UNKNOWN (reason
// window-contradiction), never a value decided by the window id. The comparison
// is on the value fields after the JSON decode (remaining, unit, total and cost
// basis); windows whose reset is unknown (null) form one group, so two live
// windows with unknown resets that disagree are unknown the same way.
const windowValueKey = w => `${JSON.stringify(w.remaining)}|${JSON.stringify(w.unit)}|${JSON.stringify(w.total)}|${JSON.stringify(w.costBasis)}`;
function quotaState(routeKey, windows, now) {
  const ofRoute = windows.filter(w => w.canonicalRoutes.includes(routeKey));
  const mine = ofRoute.filter(w => w.resetAt === null || Date.parse(w.resetAt) > now);
  const stale = ofRoute.length - mine.length;
  const byReset = new Map();
  for (const w of mine) {
    const key = w.resetAt === null ? '' : w.resetAt;
    if (!byReset.has(key)) byReset.set(key, []);
    byReset.get(key).push(w);
  }
  const contradiction = [...byReset.values()].some(group => group.length > 1 && group.some(w => windowValueKey(w) !== windowValueKey(group[0])));
  if (contradiction) {
    return { known: true, exhausted: false, stale, costBasis: null, resetAt: null, fraction: null, windows: mine.map(w => w.id), reason: 'window-contradiction' };
  }
  const exhausted = mine.some(w => typeof w.remaining === 'number' && w.remaining <= 0);
  const representative = mine.length
    ? mine.reduce((best, w) => {
        const bt = best.resetAt === null ? Infinity : Date.parse(best.resetAt);
        const wt = w.resetAt === null ? Infinity : Date.parse(w.resetAt);
        return wt < bt || (wt === bt && w.id < best.id) ? w : best;
      })
    : null;
  return {
    known: mine.length > 0,
    exhausted,
    stale,
    costBasis: representative ? representative.costBasis : null,
    resetAt: representative ? representative.resetAt : null,
    fraction: representative ? normalizeRemaining(representative) : null,
    windows: mine.map(w => w.id),
    reason: null,
  };
}

// ---- the kernel P-L3-005 effort mechanism, called, never copied ----
// The status of a row's effort is computed by the kernel ladder builder from the live
// client registry (the same function that stamps effortStatus into model-ladder.json),
// and the kernel resolver decides requestability, both VERBATIM. The synthetic
// single-row ladder and slot neutralise every other resolver rule (floor T1, no role
// rule, no independence, no approval, probe skipped), so the resolver's answer is
// exactly its effort rule.
function kernelEffort(row, clientCfg) {
  const status = ladderBuild.effortStatusOf(clientCfg, row.effort);
  const synthetic = {
    schema: 'ladder/2',
    rows: [{ id: row.id, maker: row.maker || 'l3-select', client: row.client, routeModel: row.routeModel,
      tier: 1, effort: row.effort, effortStatus: status, approval: 'none' }],
  };
  const slot = { id: 'l3-select-effort', floor: 'T1', role: 'l3-select', stageKind: 'other', long: false, substitutes: 0 };
  let resolved;
  try { resolved = resolver.resolveSlot(slot, synthetic, { clients: {} }, { skipProbe: true }); }
  catch (e) { throw new Refusal('effort-rule-unavailable', `the kernel resolver refused the effort question for ${row.id}: ${e.message}`); }
  return { status, requestable: !resolved.excluded.some(e => e.reason === 'effort-not-settable') };
}
// The consumer's own effort rule (the cert launch path SEAT-FAILOVER applies to
// the argv): cert-launch effortFor over the same client registry document. With the
// registry passed it touches no file. the row's
// request is passed AS IT IS. A null request is the consumer's own
// 'no effort requested' answer (a falsy effort applies no flag and records
// effortUsed null), never the options() default 'high' - that default answers a
// different question, what the consumer applies to an argv that carries no
// --effort, which the plan asks separately through consumerAppliedArgv.
function consumerEffort(client, model, request, clientsObj) {
  return certLaunch.effortFor({ client, model, effort: request }, clientsObj);
}
// the consumer's answer for ONE route
// of the plan. The argv is the plan's own, with exactly the route's client and
// model substituted - the substitution SEAT-FAILOVER itself performs at failover
// time (run() replaces --client and --model and passes every other option
// unchanged) - and the answer comes from the consumer's own options() + effortFor()
// pair, the path the cert launch applies to that argv. What these functions return
// is what the plan prints for the route: never a value computed from the row's
// own request.
function consumerAppliedArgv(argv, client, model, clientsObj) {
  const routeArgv = [...argv];
  routeArgv[routeArgv.indexOf('--client') + 1] = client;
  routeArgv[routeArgv.indexOf('--model') + 1] = model;
  return certLaunch.effortFor(certLaunch.options(routeArgv), clientsObj);
}
// The full effort decision of one ladder row: the kernel status and requestability
// VERBATIM, plus what the consumer would apply. The stored effortStatus field of
// the row is never consulted.
function effortOfRow(row, clientsObj) {
  const clientCfg = clientsObj.clients[row.client];
  const kernel = kernelEffort(row, clientCfg);
  // R-L3-005.6: where no setting is available the effort cannot be set and stays
  // unknown (null). Only a value the registry lists is requested (R-L3-005.7);
  // client-config, in-model-id, not-settable and unknown never invent an effort.
  const request = kernel.status === 'in-registry-values' && row.effort !== null ? row.effort : null;
  const applied = consumerEffort(row.client, row.routeModel, request, clientsObj);
  return { kernel, request, applied };
}

// ---- the selector ----
// Admissible by the selector's own data rules: a known family not excluded, a tier at
// or above the role floor for the task class (a tier-unknown row only when the role
// admits it), not a top-cost model (unless the dead end is attested with --top-cost),
// no owner approval pending, a present client, a kernel-requestable effort, and
// no quota window known exhausted. Consumer validity is applied afterwards, in
// rank order, through the imported seat-failover plan().
function selectRoutes(input, data) {
  const role = data.roles.obj.roles[input.role];
  // PROTO-DEC-0226 item 1: the required tier is the LARGER of the task tier
  // (the assignment policy's class risk floor, the one point of computation of
  // the task tier) and the role floor of the role table. The author role keeps
  // no floor of its own, so its required tier is the task tier alone; the plan
  // names which of the two decided the tier.
  const declaredFloor = role.tierFloor !== undefined && role.tierFloor !== null && Object.hasOwn(role.tierFloor, input.class) ? role.tierFloor[input.class] : null;
  const roleFloor = input.role.startsWith('certifier-') ? Math.max(declaredFloor || 1, data.hardFloors.certification) : declaredFloor;
  const taskTier = Number(data.classification.tier.slice(1));
  const floor = Math.max(taskTier, roleFloor === null ? 0 : roleFloor);
  const tierDecidedBy = roleFloor !== null && roleFloor > taskTier ? 'role' : 'task';
  // Both the standing rule and the input arrive through the imported SEAT-FAILOVER
  // resolution (the caller resolves the input once and passes the resolved list),
  // so the list holds resolved family names.
  const standing = role.excludeFamilies.length ? seatFailover.excludedFamilies(role.excludeFamilies.join(','), data.identity) : [];
  const families = [...new Set([...standing, ...input.excludeFamilies])];
  const now = input.now;
  const admissible = [];
  const excluded = [];
  for (const row of data.ladder.rows) {
    // a stored effortStatus outside the kernel builder's closed output
    // domain excludes this ROW, never the whole ladder; the field never decides.
    if (row.effortStatus !== null && !KERNEL_EFFORT_STATUSES.includes(row.effortStatus)) {
      excluded.push({ id: row.id, reason: 'stored-effort-status-outside-kernel-domain', detail: `the stored effortStatus ${JSON.stringify(row.effortStatus)} is outside the kernel builder's closed output domain ${KERNEL_EFFORT_STATUSES.join(', ')}` });
      continue;
    }
    if (row.routeModel === null) { excluded.push({ id: row.id, reason: 'route-unknown', detail: 'the ladder row names no route model at this effort' }); continue; }
    const client = data.clients.obj.clients[row.client];
    if (!client || client.present !== true) { excluded.push({ id: row.id, reason: 'client-unavailable', detail: `client ${row.client} is not present` }); continue; }
    // the kernel mechanism decides, not the ladder's own
    // status field. The status is recomputed from the live client registry and the
    // kernel resolver refuses what it cannot set; a route whose effort cannot be
    // set never receives an invented effort (R-L3-005.6).
    const effort = effortOfRow(row, data.clients.obj);
    if (!effort.kernel.requestable) {
      excluded.push({ id: row.id, reason: 'effort-not-settable', detail: `P-L3-005 R-L3-005.7: the kernel resolver never requests effort ${JSON.stringify(row.effort)} (kernel status ${effort.kernel.status})` });
      continue;
    }
    if (!effort.applied.ok) {
      excluded.push({ id: row.id, reason: 'effort-not-consumer-applicable', detail: `the consumer refuses this effort: ${effort.applied.error}` });
      continue;
    }
    const family = data.identity.declaredFamily(row.routeModel);
    if (family === 'UNKNOWN') { excluded.push({ id: row.id, reason: 'family-unknown', detail: `${row.routeModel} has no known family, so independence cannot be checked` }); continue; }
    if (families.includes(family)) { excluded.push({ id: row.id, reason: 'family-excluded', detail: `family ${family} is excluded` }); continue; }
    const reasons = [];
    if (row.tier === null) {
      if (!role.admitTierUnknown) { excluded.push({ id: row.id, reason: 'tier-unknown', detail: 'the row has no tier cell and the role admits no tier-unknown route' }); continue; }
      reasons.push('tier unknown; admitted for this role');
    } else {
      if (row.tier < floor) { excluded.push({ id: row.id, reason: 'below-floor', detail: `tier T${row.tier} is below the floor T${floor}` }); continue; }
      reasons.push(`tier T${row.tier} at or above the floor T${floor}`);
    }
    if (data.roles.topCost.has(data.identity.canonicalRouteId(row.routeModel))) {
      if (!input.topCost) { excluded.push({ id: row.id, reason: 'top-cost-reserved', detail: data.roles.obj.topCost.reason }); continue; }
      reasons.push('top-cost model admitted (--top-cost attests the dead end)');
    }
    if (row.approval === 'owner-long-task') { excluded.push({ id: row.id, reason: 'needs-approval', detail: 'owner-long-task approval is pending for this route' }); continue; }
    reasons.push(`family ${family} admissible`);
    reasons.push(effort.request === null
      ? `effort unknown (kernel P-L3-005 status ${effort.kernel.status}; R-L3-005.6: it cannot be set, so it stays unknown)`
      : `effort ${effort.request} (kernel P-L3-005 status ${effort.kernel.status})`);
    const route = `${row.client}:${row.routeModel}`;
    const routeKey = `${row.client}:${data.identity.canonicalRouteId(row.routeModel)}`;
    const quota = quotaState(routeKey, data.windows, now);
    if (quota.exhausted) { excluded.push({ id: row.id, reason: 'quota-exhausted', detail: `a known window of ${route} is exhausted (${quota.windows.join(', ')})` }); continue; }
    reasons.push(quota.reason === 'window-contradiction'
      ? 'quota unknown: window-contradiction (two live windows of this route share one reset time and disagree, so no value of either is taken)'
      : quota.known
      ? `cost basis ${quota.costBasis}${quota.stale ? ` (${quota.stale} stale window(s) ignored)` : ''}${quota.resetAt ? `, resets ${quota.resetAt}` : ''}${quota.fraction !== null ? `, ${Math.round(quota.fraction * 1000) / 10}% of the window remaining` : ', remaining unknown'}`
      : 'quota unknown (no live window names this route)');
    admissible.push({ route, routeKey, row, family, quota, reasons, effort });
  }
  // rows are first grouped by route (client plus canonical model id);
  // per route the chosen row is the nearest tier at or above the floor (ties: the
  // lower tier, then ladder order). A duplicate row of the same route never drops
  // the nearer tier; the rows not chosen are excluded by name.
  const byRoute = new Map();
  for (const entry of admissible) {
    if (!byRoute.has(entry.routeKey)) byRoute.set(entry.routeKey, []);
    byRoute.get(entry.routeKey).push(entry);
  }
  const chosen = [];
  for (const entries of byRoute.values()) {
    const known = entries.filter(e => e.row.tier !== null);
    const pool = known.length ? known : entries;
    pool.sort((a, b) => (a.row.tier - b.row.tier) || (a.row.pos - b.row.pos));
    const keep = pool[0];
    for (const e of entries) if (e !== keep) excluded.push({ id: e.row.id, reason: 'duplicate-route-row', detail: `${e.route} is ranked through the nearer tier row ${keep.row.id} (tier T${keep.row.tier === null ? 'unknown' : keep.row.tier})` });
    chosen.push(keep);
  }
  chosen.sort((a, b) => {
    const cost = COST_RANK[a.quota.costBasis ?? 'unknown'] - COST_RANK[b.quota.costBasis ?? 'unknown'];
    if (cost !== 0) return cost;
    const ra = a.quota.resetAt === null ? Infinity : Date.parse(a.quota.resetAt);
    const rb = b.quota.resetAt === null ? Infinity : Date.parse(b.quota.resetAt);
    if (ra !== rb) return ra - rb; // expiring soonest first; unknown after known
    const fa = a.quota.fraction === null ? -1 : a.quota.fraction;
    const fb = b.quota.fraction === null ? -1 : b.quota.fraction;
    if (fa !== fb) return fb - fa; // most remaining first; unknown after known
    return a.row.pos - b.row.pos; // ties keep the ladder order
  });
  const routes = chosen.map(entry => ({
    route: entry.route,
    id: entry.row.id,
    client: entry.row.client,
    model: entry.row.routeModel,
    effort: entry.effort.applied.effortUsed,
    effortRequest: entry.effort.request,
    effortStatus: entry.effort.kernel.status,
    effortArgs: entry.effort.applied.args,
    tier: entry.row.tier,
    maker: entry.row.maker,
    family: entry.family,
    costBasis: entry.quota.costBasis,
    quota: { known: entry.quota.known, windows: entry.quota.windows, resetAt: entry.quota.resetAt, remainingFraction: entry.quota.fraction, reason: entry.quota.reason },
    reasons: entry.reasons,
    pos: entry.row.pos,
  }));
  return { routes, excluded, families, floor, tierDecidedBy, role: input.role, class: input.class };
}

// ---- consumer route validity, imported ----
// A ranked route is admissible only if seat-failover plan() accepts it: the first
// kept route as the primary, every next rank as a --fallback route (the strictest
// position). A route the consumer refuses is excluded with the consumer's own reason.
function consumerRoutes(selection, clientsObj, identity) {
  const deps = { registry: clientsObj, modelIdentity: identity };
  const famArg = selection.families.length ? ['--exclude-families', selection.families.join(',')] : [];
  const kept = [];
  for (const entry of selection.routes) {
    const argv = kept.length === 0
      ? ['--client', entry.client, '--model', entry.model, ...famArg]
      : ['--client', kept[0].client, '--model', kept[0].model, '--fallback', entry.route, ...famArg];
    try { seatFailover.plan(argv, 'cert', deps); kept.push(entry); }
    catch (e) {
      selection.excluded.push({ id: entry.id, reason: 'not-a-seat-failover-route', detail: `SEAT-FAILOVER refuses this route: ${e.message}` });
    }
  }
  return kept;
}

// ---- the pure plan function ----
// plan(documents, options) touches no file, no environment variable and no clock:
// every input arrives as an already-parsed document ({ obj, sha256, path }), the
// identity is built from those documents, and --now is the only time source.
function planJson(documents, options) {
  if (!isPlain(documents) || Object.keys(documents).length !== INPUTS.length || INPUTS.some(k => !documents[k] || !isPlain(documents[k].obj) || !/^[a-f0-9]{64}$/.test(documents[k].sha256))) throw new Refusal('inputs-schema', 'exactly seven hashed documents required');
  const ladder = checkLadder(documents.ladder.obj);
  const clients = checkClients(documents.clients.obj);
  let identity;
  try { identity = modelIdentity.buildIdentity(documents.clients.obj, documents.aliases.obj, documents.supplement.obj); }
  catch (e) { throw new Refusal('identity-data', e.message); }
  selectionPolicy.validatePolicySource(documents.policy, options.testPolicyDir ?? null);
  const policy = { obj: selectionPolicy.validatePolicy(documents.policy.obj) };
  const roles = checkRoles({ schema: 'l3-select-roles/1', source: policy.obj.source, taskClasses: Object.keys(policy.obj.taskPolicy.riskFloor), roles: policy.obj.roleFloors, topCost: policy.obj.selection.topCost }, identity);
  if (!Object.hasOwn(roles.obj.roles, options.role)) throw new Refusal('unknown-role', 'role not in canonical policy');
  if (!roles.obj.taskClasses.includes(options.class)) throw new Refusal('unknown-class', 'class not in canonical policy');
  const frame = documents.task.obj;
  if (frame.schema !== 'selection-task/1' || Object.keys(frame).length !== 2 || !isPlain(frame.task) || !isPlain(frame.task.complexity)) throw new Refusal('task-schema', 'selection-task/1 with task and six complexity scores required');
  if (frame.task.riskClass !== options.class) throw new Refusal('task-class-conflict', 'task frame riskClass differs from --class');
  let classification;
  try { classification = complexity(frame.task, policy.obj); } catch (e) { throw new Refusal('task-schema', e.code || e.message); }
  // --now is validated before the quota registry is checked, so
  // every record is judged against the declared time of the plan.
  const nowMs = Date.parse(options.now);
  if (!isoDate(options.now) || !Number.isFinite(nowMs)) throw new Refusal('usage', `--now is not an ISO 8601 time: ${options.now}`);
  const quotas = checkQuotas(documents.quotas.obj, identity, nowMs);
  if (!Object.hasOwn(roles.obj.roles, options.role)) throw new Refusal('unknown-role', `the role table defines ${Object.keys(roles.obj.roles).join(', ')}`);
  if (!roles.obj.taskClasses.includes(options.class)) throw new Refusal('unknown-class', `the role table defines task classes ${roles.obj.taskClasses.join(', ')}`);
  // the input is resolved through the imported SEAT-FAILOVER grammar (a family
  // name or a model spelling); unknown, empty, repeated and duplicate resolutions
  // are refused by name.
  const excludeFamilies = options.excludeFamilies === null || options.excludeFamilies === undefined ? []
    : (() => {
        let families;
        try { families = seatFailover.excludedFamilies(options.excludeFamilies, identity); }
        catch { throw new Refusal('unknown-excluded-family', `${JSON.stringify(options.excludeFamilies)}: every exclusion item must be a known family name or a model spelling (the SEAT-FAILOVER grammar)`); }
        if (new Set(families).size !== families.length) throw new Refusal('duplicate-excluded-family', 'two exclusion items resolve to the same family');
        return families;
      })();
  const selection = selectRoutes({ role: options.role, class: options.class, excludeFamilies, topCost: options.topCost, now: nowMs },
    { ladder, clients: { obj: clients }, roles, windows: quotas.windows, classification, hardFloors: policy.obj.taskPolicy.hardFloors, identity });
  // consumer validity in rank order, then --limit. A
  // limit can never hide the only usable route, and zero usable routes never print
  // a plan with a null seatFailover block - it is a refusal with a named reason.
  // every consumer call receives the already parsed strict clients
  // document - the revision code passed clients.obj of the checked document, that
  // is undefined, so the consumer silently re-read the registry from disk.
  const valid = consumerRoutes(selection, clients, identity);
  // the effort cascade cannot
  // reorder or borrow. For each ranked route the effort was decided by the
  // consumer's own pure function on THAT route's OWN row (its own kernel
  // request; a null request is the consumer's 'no effort requested' answer),
  // and the plan's ONE effort is the effort the consumer applies to the HEAD
  // route: the first ranked route that can state its own effort under the argv
  // the plan can emit - with --effort <its own effort>, or with no --effort at
  // all when the consumer applies null. A route the consumer would serve with
  // a DIFFERENT effort under that argv (a settable client under a null
  // request: with no --effort the consumer applies its own default, an effort
  // the ladder never requested) can neither head the plan nor ride it, so
  // every rank before the head is dropped, never reordered in front of it.
  const argvForEffort = (client, model, effort) => ['--client', client, '--model', model,
    ...(effort !== null ? ['--effort', effort] : [])];
  let head = null;
  let planEffort = null;
  for (const entry of valid) {
    const appliedHead = consumerAppliedArgv(argvForEffort(entry.client, entry.model, entry.effort), entry.client, entry.model, clients);
    if (!appliedHead.ok || appliedHead.effortUsed !== entry.effort) continue; // this rank cannot head the plan
    head = entry;
    planEffort = entry.effort;
    break;
  }
  const incompatibleDetail = (entry, applied) => entry.effort !== planEffort
    ? `the consumer applies ${JSON.stringify(entry.effort)} to this route's own row, never another route's effort; the plan effort is ${JSON.stringify(planEffort)}`
    : !applied.ok
      ? `the consumer refuses the plan effort for this route: ${applied.error}`
      : `the plan carries no effort and the consumer would apply its own default ${JSON.stringify(applied.effortUsed)} to this route`;
  const kept = [];
  if (head !== null) {
    const planArgv = argvForEffort(head.client, head.model, planEffort);
    for (const entry of valid) {
      const applied = consumerAppliedArgv(planArgv, entry.client, entry.model, clients);
      // a route rides the plan only if the consumer applies the plan's ONE
      // effort to it - decided both on the route's own row and with the
      // plan's argv (the exact failover-time substitution)
      if (entry.effort === planEffort && applied.ok && applied.effortUsed === planEffort) kept.push(entry);
      else selection.excluded.push({ id: entry.id, reason: 'fallback-effort-incompatible', detail: `SEAT-FAILOVER passes the plan effort ${JSON.stringify(planEffort)} to every route: ${incompatibleDetail(entry, applied)}` });
    }
  } else {
    for (const entry of valid) {
      selection.excluded.push({ id: entry.id, reason: 'fallback-effort-incompatible', detail: 'no ranked route can head the plan: every candidate primary is a route the consumer would serve with an effort the plan cannot state' });
    }
  }
  const ranked = (options.limit === null ? kept : kept.slice(0, options.limit)).map((entry, i) => ({ ...entry, rank: i + 1 }));
  const generatedAt = new Date(nowMs).toISOString();
  const input = {
    role: options.role,
    class: options.class,
    excludeFamilies,
    topCost: options.topCost,
    // PROTO-DEC-0226: the plan names the required tier and WHICH of the two
    // floors decided it (the task tier of the assignment policy or the role
    // floor of the role table); the role table keeps no author task-class floor.
    requiredTier: `T${selection.floor}`,
    tierDecidedBy: selection.tierDecidedBy,
    admitTierUnknown: roles.obj.roles[options.role].admitTierUnknown,
    limit: options.limit,
    now: generatedAt,
  };
  const sources = {
    ladder: { path: documents.ladder.path, sha256: documents.ladder.sha256, schema: ladder.schema, asOf: ladder.asOf },
    clients: { path: documents.clients.path, sha256: documents.clients.sha256 },
    quotas: { path: documents.quotas.path, sha256: documents.quotas.sha256, updated: quotas.updated, windows: quotas.windows.length },
    aliases: { path: documents.aliases.path, sha256: documents.aliases.sha256 },
    supplement: { path: documents.supplement.path, sha256: documents.supplement.sha256 },
    policy: { path: documents.policy.path, sha256: documents.policy.sha256, schema: policy.obj.schema },
    task: { path: documents.task.path, sha256: documents.task.sha256 },
  };
  const snapshotHash = createHash('sha256').update(JSON.stringify({ documents: INPUTS.map(k => [k, documents[k].sha256]), now: generatedAt })).digest('hex');
  if (ranked.length === 0) {
    return { schema: PLAN_SCHEMA, generatedAt, input, sources, snapshotHash, routes: [], excluded: selection.excluded, reason: 'no-admissible-route' };
  }
  const primary = ranked[0];
  const fallback = ranked.slice(1).map(r => r.route).join(',');
  const families = selection.families.join(',');
  // the argv carries the plan's ONE effort - the effort the consumer
  // applies to the head route - or no --effort at all when that effort is
  // null; every kept route applies exactly this effort (certified above).
  const argv = ['--client', primary.client, '--model', primary.model,
    ...(planEffort !== null ? ['--effort', planEffort] : []),
    ...(fallback ? ['--fallback', fallback] : []),
    ...(families ? ['--exclude-families', families] : [])];
  // the printed argv is certified by the consumer itself before it is printed.
  try { seatFailover.plan(argv, 'cert', { registry: clients, modelIdentity: identity }); }
  catch (e) { throw new Refusal('seat-failover-plan-refused', `the planned argv was refused by SEAT-FAILOVER: ${e.message}`); }
  // every route's printed effort and effort argv
  // tokens are what the consumer's own options() + effortFor() return for the
  // plan's argv with that route substituted - the exact failover-time answer,
  // equal to the plan effort for every kept route. A route whose consumer
  // answer is effortUsed null (a client that cannot set its effort,
  // R-L3-005.6) prints null and no effort tokens; the route's own request is
  // printed as effortRequest (null stays null), the kernel verdict as
  // effortStatus.
  const routes = ranked.map(entry => {
    const applied = consumerAppliedArgv(argv, entry.client, entry.model, clients);
    if (entry.effort !== planEffort || !applied.ok || applied.effortUsed !== planEffort) {
      throw new Refusal('effort-plan-inconsistent', `the consumer's answer for ${entry.route} changed after the plan was built: ${incompatibleDetail(entry, applied)}`);
    }
    const effortReason = applied.effortUsed === null
      ? 'effort unknown (the consumer records no effort for this route with the plan argv; R-L3-005.6)'
      : `effort ${applied.effortUsed} (applied by the consumer to this route with the plan argv)`;
    return { ...entry, effort: applied.effortUsed, effortArgs: applied.args, reasons: [...entry.reasons.filter(r => !/^effort /.test(r)), effortReason] };
  });
  return {
    schema: PLAN_SCHEMA,
    generatedAt,
    input,
    sources,
    snapshotHash,
    taskComplexity: classification,
    routes,
    excluded: selection.excluded,
    seatFailover: {
      client: primary.client,
      model: primary.model,
      effort: planEffort,
      fallback,
      excludeFamilies: families,
      argv,
    },
    reason: 'ranked',
  };
}

const USAGE = [
  'usage: node docs/ops/l3-select.cjs plan --role <author|certifier-strong|certifier-medium|pre-review> --class <A|B>',
  '          [--exclude-families f1[,f2[...]]] [--top-cost] [--limit N] [--quotas FILE] --task FILE',
  '          [--ladder FILE] [--clients FILE] [--aliases FILE] [--identity-supplement FILE] [--policy FILE] --now ISO',
  '          [--test-policy-dir DIR] (explicit fixture policies inside DIR only)',
  'plan prints an ordered route list (JSON) usable as SEAT-FAILOVER arguments; it never launches a client.',
  'the selector reads no client logs (PROTO-DEC-0213): quota records are operator-entered data.',
  'the required tier is the larger of the task tier (the assignment policy) and the role floor (PROTO-DEC-0226).',
  'every input is read once, guarded on every parent path segment; the plan prints the sha256 of each input it used.',
].join('\n');

function parseArgs(argv) {
  if (!argv.length) throw new Refusal('usage', 'no verb given');
  const verb = argv[0];
  const options = {
    role: null, class: null, excludeFamilies: null, topCost: false, limit: null,
    quotas: DEFAULT_QUOTAS, task: null, ladder: DEFAULT_LADDER, clients: DEFAULT_CLIENTS,
    aliases: DEFAULT_ALIASES, identitySupplement: DEFAULT_SUPPLEMENT, policy: DEFAULT_POLICY,
    now: null, testPolicyDir: null, // explicitly required: no implicit clock input
  };
  const known = new Set(['plan']);
  const optionNames = new Set(['role', 'class', 'exclude-families', 'top-cost', 'limit', 'quotas', 'task', 'ladder', 'clients', 'aliases', 'identity-supplement', 'policy', 'now', 'test-policy-dir']);
  if (!known.has(verb)) throw new Refusal('usage', `unknown verb ${JSON.stringify(verb)}: this package has only the plan verb (the codex session-log reader was removed by PROTO-DEC-0213)`);
  // A repeated --exclude-families option is refused by name, exactly as SEAT-FAILOVER's
  // normalize refuses a repeated option - a second list never silently overwrites the
  // first. Other options keep last-wins so a caller may override a preset on the same
  // command line.
  let excludeSeen = false;
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(arg);
    if (!match || !optionNames.has(match[1])) throw new Refusal('usage', `unknown option ${JSON.stringify(arg)}`);
    const key = match[1];
    if (key === 'exclude-families') {
      if (excludeSeen) throw new Refusal('usage', 'duplicate-option option=--exclude-families');
      excludeSeen = true;
    }
    // --top-cost is a flag; an inline value is refused exactly as
    // SEAT-FAILOVER's normalize refuses a value on a flag option.
    if (key === 'top-cost') {
      if (match[2] !== undefined) throw new Refusal('usage', 'unexpected-option-value option=--top-cost');
      options.topCost = true;
      continue;
    }
    const value = match[2] !== undefined ? match[2] : argv[++i];
    if (typeof value !== 'string' || !value.trim() || value.startsWith('--')) throw new Refusal('usage', `missing-option-value option=--${key}`);
    if (key === 'identity-supplement') options.identitySupplement = value;
    else if (key === 'test-policy-dir') options.testPolicyDir = value;
    else if (key === 'policy') options.policy = value;
    else if (key === 'role' || key === 'class' || key === 'quotas' || key === 'task' || key === 'ladder' || key === 'clients' || key === 'aliases' || key === 'now') options[key] = value;
    else if (key === 'exclude-families') options.excludeFamilies = value;
    else if (key === 'limit') { if (!/^\d+$/.test(value) || Number(value) < 1) throw new Refusal('usage', '--limit must be a positive integer'); options.limit = Number(value); }
    else throw new Refusal('usage', `unknown option --${key}`);
  }
  if (options.role === null) throw new Refusal('usage', '--role is required');
  if (options.class === null) throw new Refusal('usage', '--class is required');
  if (options.task === null) throw new Refusal('usage', '--task is required');
  if (!isoDate(options.now)) throw new Refusal('usage', `--now is not an ISO 8601 time: ${options.now}`);
  return { verb, options };
}

function main(argv, io = {}) {
  const say = io.say || console.log;
  const error = io.error || console.error;
  let parsed;
  try { parsed = parseArgs(argv); } catch (e) {
    if (e instanceof Refusal && e.code === 'usage') { error(`${USAGE}\nSelection REFUSED reason=usage: ${e.message}`); return 2; }
    throw e;
  }
  try {
    // the CLI reads each declared input file ONCE, guarded on every parent
    // segment, and hands the parsed documents to the pure plan function.
    const documents = {
      ladder: readInput(parsed.options.ladder, 'ladder'),
      clients: readInput(parsed.options.clients, 'clients'),
      quotas: readInput(parsed.options.quotas, 'quotas'),
      aliases: readInput(parsed.options.aliases, 'aliases'),
      supplement: readInput(parsed.options.identitySupplement, 'identity-supplement'),
      policy: readInput(parsed.options.policy, 'policy'),
      task: readInput(parsed.options.task, 'task'),
    };
    const plan = planJson(documents, parsed.options);
    say(JSON.stringify(plan, null, 2));
    return plan.reason === 'no-admissible-route' ? 1 : 0;
  } catch (e) {
    if (e instanceof Refusal) { error(`Selection REFUSED reason=${e.code}: ${e.message}`); return 2; }
    throw e;
  }
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { main, planJson, selectRoutes, consumerRoutes, quotaState, kernelEffort, consumerEffort, effortOfRow, checkLadder, checkClients, checkRoles, checkQuotas, windowProblem, registryRouteProblem, readInput, INPUTS, USAGE, Refusal };

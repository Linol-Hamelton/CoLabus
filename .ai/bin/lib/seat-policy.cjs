'use strict';
// Seat policy: the one place where the owner states how many seats a host may run.
// The file is docs/ops/seat-policy.json of the MAIN checkout (schema seat-policy/1). Every
// consumer reads it through this module; no other file holds an operational cap number.
//
// Two phases, stated once:
//   - a malformed record (a bad shape, a duplicate key, a BOM, a future declaredAt, a
//     declaredAt at or after expiresAt) is a VALIDATION REFUSAL: the reader refuses with a
//     named reason and the caller exits 2. It never falls back to "uncapped" and never
//     falls back to a shipped table.
//   - an expired entry is a RUNTIME STATE: the effective cap of that entry is 0 and the
//     caller exits 3 with SLOT_CAP_EXPIRED.
// An absent policy file at the canonical root is not an error: the host is UNCONFIGURED,
// so no client and no route cap applies and the total default stays an independent source
// (.ai/bin/ops-tools/ops-tools.config.json, seat.defaultCap).
//
// The module is managed and pure: it reads bytes and returns a decision. It starts no
// process, writes nothing and imports no host-only module.
const fs = require('node:fs');
const path = require('node:path');
const safe = require('./path-safe.cjs');
const text = require('./text-safe.cjs');
// The registry is project-owned (P-L3-005), never an installable dependency.
// Read it from disk so the pilot's module closure cannot ship the source
// registry into a host. Only absence names no clients; other read/parse errors
// still refuse, as they did with the module import. Keep one snapshot per process,
// read at the first client check of a policy: loading this module or using its pool
// rule opens no file, so a reader of the pool rule reads only the inputs it declared.
let roster = null;
function clients() {
  if (roster === null) {
    try { roster = { clients: JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'docs', 'clients.json'), 'utf8')).clients }; }
    catch (error) { if (error.code === 'ENOENT') roster = { clients: {} }; else throw error; }
  }
  return roster.clients;
}

const SCHEMA = 'seat-policy/1';
const RELATIVE = path.join('docs', 'ops', 'seat-policy.json');
// The test injection of the policy file (the same pattern as OK_ROUTE_STATE_FILE).
const ENV = 'OK_SEAT_POLICY_FILE';
const MAX_CAP = 64;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const TOP_LEVEL = new Set(['schema', 'total', 'defaultClient', 'clients', 'routes']);
const CLIENT_ENTRY = new Set(['cap', 'declaredBy', 'declaredAt', 'expiresAt']);
const ROUTE_ENTRY = new Set(['client', 'provider', 'cap', 'declaredBy', 'declaredAt', 'expiresAt']);

// The named reasons of the validation phase. The caller maps them to exit 2.
const REFUSALS = Object.freeze({
  ABSENT: 'SEAT-POLICY-ABSENT',
  UNREADABLE: 'SEAT-POLICY-UNREADABLE',
  ENCODING: 'SEAT-POLICY-ENCODING',
  JSON: 'SEAT-POLICY-JSON',
  SCHEMA: 'SEAT-POLICY-SCHEMA',
  FUTURE: 'SEAT-POLICY-FUTURE-DECLARED',
  ROUTE_ID: 'SEAT-POLICY-ROUTE-ID',
});
// The named reason of the runtime phase (an expired entry). The caller maps it to exit 3.
const EXPIRED = 'SLOT_CAP_EXPIRED';

const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = v => typeof v === 'string' && ID.test(v);
const clientId = v => id(v) && Object.hasOwn(clients(), v);
const own = (map, key) => map && Object.hasOwn(map, key) ? map[key] : null;
const iso = v => {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(v)) return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms) || v.startsWith('0000-')) return null;
  const canonical = v.length === 20 ? v.replace('Z', '.000Z') : v;
  return new Date(ms).toISOString() === canonical ? ms : null;
};

function refuse(code, detail) {
  return { ok: false, code, detail: detail || null };
}

// The provenance of one entry: the owner's act (who declared it and when) and the optional
// expiry. The expiry is compared with the clock of the caller, never with the clock of the
// reader, so a test can state the moment.
function readEntry(row, allowed, what) {
  if (!plain(row)) return refuse(REFUSALS.SCHEMA, `${what} is not an object`);
  for (const key of Object.keys(row)) if (!allowed.has(key)) return refuse(REFUSALS.SCHEMA, `${what} holds an unknown key ${key}`);
  if (!Number.isSafeInteger(row.cap) || row.cap < 0 || row.cap > MAX_CAP) return refuse(REFUSALS.SCHEMA, `${what}.cap must be a whole number from 0 to ${MAX_CAP}`);
  if (typeof row.declaredBy !== 'string' || !row.declaredBy.trim()) return refuse(REFUSALS.SCHEMA, `${what}.declaredBy must name the act`);
  const declaredAt = iso(row.declaredAt);
  if (declaredAt === null) return refuse(REFUSALS.SCHEMA, `${what}.declaredAt must be an ISO time`);
  let expiresAt = null;
  if (row.expiresAt !== undefined && row.expiresAt !== null) {
    expiresAt = iso(row.expiresAt);
    if (expiresAt === null) return refuse(REFUSALS.SCHEMA, `${what}.expiresAt must be an ISO time`);
    if (declaredAt >= expiresAt) return refuse(REFUSALS.SCHEMA, `${what}.declaredAt must be before ${what}.expiresAt`);
  }
  return { ok: true, entry: { cap: row.cap, declaredBy: row.declaredBy.trim(), declaredAt: row.declaredAt, expiresAt: row.expiresAt === undefined ? null : row.expiresAt } };
}

// The whole document. -> { ok: true, policy } or { ok: false, code, detail }.
// The expiry is NOT baked into the parsed entry: the clock of the caller decides it later, so
// a policy read before the expiry and used after it still sees the closed value.
function parsePolicy(value, now) {
  if (!plain(value) || value.schema !== SCHEMA) return refuse(REFUSALS.SCHEMA, `the policy must be a ${SCHEMA} object`);
  for (const key of Object.keys(value)) if (!TOP_LEVEL.has(key)) return refuse(REFUSALS.SCHEMA, `the policy holds an unknown key ${key}`);
  const policy = { schema: SCHEMA, total: null, defaultClient: null, clients: {}, routes: {} };
  if (value.total !== undefined && value.total !== null) {
    if (!Number.isSafeInteger(value.total) || value.total < 0 || value.total > MAX_CAP) return refuse(REFUSALS.SCHEMA, `total must be a whole number from 0 to ${MAX_CAP}`);
    policy.total = value.total;
  }
  if (value.defaultClient !== undefined && value.defaultClient !== null) {
    const read = readEntry(value.defaultClient, CLIENT_ENTRY, 'defaultClient');
    if (!read.ok) return read;
    policy.defaultClient = read.entry;
  }
  if (value.clients !== undefined && value.clients !== null) {
    if (!plain(value.clients)) return refuse(REFUSALS.SCHEMA, 'clients must be an object');
    for (const [name, row] of Object.entries(value.clients)) {
      if (!id(name)) return refuse(REFUSALS.SCHEMA, `the client id ${JSON.stringify(name)} is not a safe id`);
      if (!clientId(name)) return refuse(REFUSALS.SCHEMA, `the client id ${JSON.stringify(name)} must name a canonical client in the client roster`);
      const read = readEntry(row, CLIENT_ENTRY, `clients.${name}`);
      if (!read.ok) return read;
      policy.clients[name] = read.entry;
    }
  }
  if (value.routes !== undefined && value.routes !== null) {
    if (!plain(value.routes)) return refuse(REFUSALS.SCHEMA, 'routes must be an object');
    const seen = new Set();
    for (const [name, row] of Object.entries(value.routes)) {
      if (!id(name)) return refuse(REFUSALS.SCHEMA, `the route id ${JSON.stringify(name)} is not a safe id`);
      if (!plain(row)) return refuse(REFUSALS.SCHEMA, `routes.${name} is not an object`);
      for (const key of Object.keys(row)) if (!ROUTE_ENTRY.has(key)) return refuse(REFUSALS.SCHEMA, `routes.${name} holds an unknown key ${key}`);
      if (!id(row.client)) return refuse(REFUSALS.SCHEMA, `routes.${name}.client must be a safe id`);
      if (!clientId(row.client)) return refuse(REFUSALS.SCHEMA, `routes.${name}.client must name a canonical client in the client roster`);
      if (!id(row.provider)) return refuse(REFUSALS.SCHEMA, `routes.${name}.provider must be a safe id`);
      const overlap = poolKey(row);
      if (seen.has(overlap)) return refuse(REFUSALS.SCHEMA, `two routes of the client ${row.client} share the provider ${row.provider}`);
      seen.add(overlap);
      const read = readEntry(row, ROUTE_ENTRY, `routes.${name}`);
      if (!read.ok) return read;
      policy.routes[name] = { ...read.entry, client: row.client, provider: row.provider };
    }
  }
  // The owner's act may not be dated in the future: a record of an act that did not happen yet
  // is a malformed record, not a runtime state.
  for (const [what, entry] of [['defaultClient', policy.defaultClient], ...Object.entries(policy.clients).map(([k, v]) => [`clients.${k}`, v]), ...Object.entries(policy.routes).map(([k, v]) => [`routes.${k}`, v])]) {
    if (!entry) continue;
    if (iso(entry.declaredAt) > now) return refuse(REFUSALS.FUTURE, `${what}.declaredAt is in the future`);
  }
  return { ok: true, policy };
}

// The canonical file of a checkout: the policy of the MAIN checkout, so a worktree of the
// same repository reads the same policy and a closed policy cannot be bypassed.
function canonicalFile(mainRoot) {
  return path.join(path.resolve(mainRoot), RELATIVE);
}

// Read one policy file. -> { ok: true, policy } | { ok: false, code, detail }.
// `now` is the clock of the caller (milliseconds). An absent file is the ABSENT refusal and
// only the caller may turn it into "unconfigured host".
function readPolicy(file, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  if (!Number.isFinite(now)) return refuse(REFUSALS.SCHEMA, 'the clock is not a number');
  const resolved = path.resolve(file);
  // ENOENT is the unconfigured host; every other read failure (EACCES, EPERM, a link, a
  // hardlink, a swapped file) is a refusal and never a fallback.
  try { fs.lstatSync(resolved); }
  catch (e) {
    if (e && e.code === 'ENOENT') return refuse(REFUSALS.ABSENT, `${file} does not exist`);
    return refuse(REFUSALS.UNREADABLE, `${file} (${e && e.code ? e.code : 'stat failed'})`);
  }
  const root = path.parse(resolved).root;
  const result = safe.readFileGuarded(root, resolved, { refuseHardlinks: true, maxBytes: 1024 * 1024 });
  if (!result.ok) return refuse(REFUSALS.UNREADABLE, `${file} (${result.reason || 'read failed'})`);
  const decoded = text.decode(result.bytes, { bom: 'refuse', crlf: 'refuse', invisible: 'refuse', finalNewline: 'refuse' });
  if (!decoded.ok) return refuse(REFUSALS.ENCODING, `${file} (${decoded.problems[0] ? decoded.problems[0].code : 'encoding'})`);
  let value;
  try { value = text.parseJsonUnique(decoded.text); }
  catch (e) { return refuse(REFUSALS.JSON, `${file} (${e && e.code ? e.code : 'json'})`); }
  return parsePolicy(value, now);
}

// One entry against one clock: the effective cap of the entry and whether it is expired.
// An expired entry has the effective cap 0 and the named runtime reason.
function entryCap(entry, now) {
  if (!entry) return { cap: null, expired: false };
  if (entry.expiresAt !== null && iso(entry.expiresAt) !== null && iso(entry.expiresAt) <= now) return { cap: 0, expired: true };
  return { cap: entry.cap, expired: false };
}

// The one model identity (the model key of launch-cost.cjs, next to the one model alias table) and the folded spelling
// that still names the router a seat went through, loaded with this module so a use of the pool rule loads no module and
// reads no file.
const { modelKey, spellingKey, MODEL_ALIASES } = require('../accounting/lib/launch-cost.cjs');
// The pool of a route row: its client and its provider folded to one spelling (case, and a model in any spelling).
const poolProvider = provider => modelKey(String(provider)) || '';
const poolKey = row => `${row.client}:${poolProvider(row.provider)}`;
// The provider names of one model key: the prefix of every documented spelling of the model with a provider prefix (the
// alias table), next to the prefix of its canonical id. Built from the table in memory, so it opens no file.
const ALIAS_PROVIDERS = new Map();
for (const spelling of Object.keys(MODEL_ALIASES)) {
  const folded = spelling.trim().toLowerCase();
  if (!folded.includes('/')) continue;
  const key = modelKey(folded);
  ALIAS_PROVIDERS.set(key, new Set([...(ALIAS_PROVIDERS.get(key) || []), folded.split('/')[0]]));
}
// How a model spelling stands to the provider of one pool row: 'model' when the row names the model itself (one model
// identity: equal keys), 'router' when it names the router the spelling went through (openrouter/...), 'provider' when it
// names the provider of the canonical id or of any documented spelling of the model, else null. The model and its
// provider depend on the model's key alone, so every spelling of one model is one member; case never matters.
// The one rule of routeOf and of every reader that counts a seat in a route pool (inPool).
function poolMatch(provider, model) {
  const key = modelKey(model);
  const row = typeof provider === 'string' ? modelKey(provider) : null;
  if (!key || !row) return null;
  if (row === key) return 'model';
  const route = spellingKey(model).split('/')[0];
  if (row === route && route !== key.split('/')[0]) return 'router';
  return row === key.split('/')[0] || (ALIAS_PROVIDERS.get(key) || new Set()).has(row) ? 'provider' : null;
}
const inPool = (provider, model) => poolMatch(provider, model) !== null;
// A route is the policy pool of this client and model provider, never the seat name. Every documented spelling of one
// model takes the same pool (poolMatch). A row that names the model is preferred to a row of the router the spelling went
// through, and that to a row of its provider.
function routeOf(policy, client, model) {
  if (!policy || typeof model !== 'string' || !model.trim()) return null;
  const rows = Object.keys(policy.routes || {}).filter(name => policy.routes[name].client === client && typeof policy.routes[name].provider === 'string');
  return rows.find(name => poolMatch(policy.routes[name].provider, model) === 'model')
    || rows.find(name => poolMatch(policy.routes[name].provider, model) === 'router')
    || rows.find(name => poolMatch(policy.routes[name].provider, model) === 'provider') || null;
}

// The effective caps of one seat request. A seat on a route takes one unit of the client
// pool AND one unit of the route pool (the nested pools). A cap of null means "no cap in the
// policy"; the caller keeps its own default.
// -> { total, client, route, expired, expiredReason } where every number is a cap or null.
function effectiveCaps(policy, request = {}, now = Date.now()) {
  const client = id(request.client) ? request.client : null;
  const routeName = id(request.route) ? request.route : null;
  const clientRow = client && policy ? own(policy.clients, client) : null;
  const defaultRow = policy ? policy.defaultClient : null;
  const routeRow = routeName && policy ? own(policy.routes, routeName) : null;
  const expired = [];
  const clientState = entryCap(clientRow || defaultRow, now);
  const clientCap = clientState.cap;
  if (clientState.expired) expired.push(clientRow ? `clients.${client}` : 'defaultClient');
  let routeCap = null;
  if (routeRow && routeRow.client === client) {
    const routeState = entryCap(routeRow, now);
    routeCap = routeState.cap;
    if (routeState.expired) expired.push(`routes.${routeName}`);
  }
  const total = policy && Number.isSafeInteger(policy.total) ? policy.total : null;
  return { total, client: clientCap, route: routeCap, expired, expiredReason: expired.length ? EXPIRED : null };
}

// Legacy policy helper; production admission uses seat-slots.cjs admitPool. A null cap is uncapped.
// A cap of 0 admits nothing.
function admit({ count, cap }) {
  if (cap === null || cap === undefined) return true;
  if (!Number.isSafeInteger(count) || count < 0) return false;
  return count < cap;
}

// The effective cap of one pool, given the policy caps and a CLI cap. The CLI only TIGHTENS:
// it never reopens a zero and never reopens an expired cap.
function tighter(policyCap, cliCap) {
  if (policyCap === null || policyCap === undefined) return cliCap === undefined ? null : cliCap;
  if (cliCap === undefined || cliCap === null) return policyCap;
  return Math.min(policyCap, cliCap);
}

// Two policies, one of them an additional host file: the result TIGHTENS the base policy and
// never loosens it. Each client intersects its effective row in BOTH inputs: an omitted
// client uses that input's default, including its expiry, rather than becoming uncapped.
function tightenPolicies(base, extra) {
  if (!base) return extra;
  if (!extra) return base;
  const out = { schema: SCHEMA, total: tighter(base.total, extra.total), defaultClient: null, clients: {}, routes: {} };
  const entry = (a, b) => {
    if (!a && !b) return null;
    if (!a) return { ...b };
    if (!b) return { ...a };
    return { ...a, cap: Math.min(a.cap, b.cap), expiresAt: a.expiresAt == null ? (b.expiresAt ?? null) : (b.expiresAt == null ? a.expiresAt : (iso(a.expiresAt) < iso(b.expiresAt) ? a.expiresAt : b.expiresAt)) };
  };
  out.defaultClient = entry(base.defaultClient, extra.defaultClient);
  for (const name of new Set([...Object.keys(base.clients), ...Object.keys(extra.clients)])) {
    out.clients[name] = entry(own(base.clients, name) || base.defaultClient, own(extra.clients, name) || extra.defaultClient);
  }
  // A route is the pool of one client and one provider, never its id (routeOf): every row of a
  // pool in either input tightens that pool, and every id carries the intersected row of its
  // pool. The base ids come first, so routeOf keeps naming the base id; an id the two inputs
  // give to two different pools stays with the base pool and the extra pool takes a free id.
  // A free id keeps the id grammar: when every suffix within the grammar is taken, no valid id is
  // left and the merge throws the named reason (resolvePolicy refuses with it), never a longer id.
  const poolOf = poolKey;
  const pools = new Map();
  for (const row of [...Object.values(base.routes), ...Object.values(extra.routes)]) {
    const seen = pools.get(poolOf(row));
    pools.set(poolOf(row), seen ? entry(seen, row) : { ...row });
  }
  const put = (name, row) => { out.routes[name] = { ...pools.get(poolOf(row)) }; };
  for (const [name, row] of Object.entries(base.routes)) put(name, row);
  for (const [name, row] of Object.entries(extra.routes)) {
    if (!Object.hasOwn(out.routes, name)) put(name, row);
    else if (poolOf(out.routes[name]) !== poolOf(row)) {
      let free = name;
      for (let i = 2; Object.hasOwn(out.routes, free); i++) {
        free = `${name.slice(0, 60)}-${i}`;
        if (!id(free)) throw Object.assign(new Error(`no free route id within the id grammar for routes.${name}`), { code: REFUSALS.ROUTE_ID });
      }
      put(free, row);
    }
  }
  return out;
}

// The policy of a host: the canonical file of the main checkout, an optional additional host
// file that may only TIGHTEN it, and the test injection that replaces it.
// -> { ok: true, policy, file, configured } | { ok: false, code, detail, file }
// An absent canonical file is an UNCONFIGURED host (policy null). An absent or broken file
// that was NAMED is a refusal: never "uncapped" and never a fallback to a shipped table.
function resolvePolicy(options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const canonical = path.resolve(options.canonical);
  const named = options.named ? path.resolve(options.named) : null;
  const injected = options.injected ? path.resolve(options.injected) : null;
  if (injected) {
    const read = readPolicy(injected, { now });
    if (!read.ok) return { ok: false, code: read.code, detail: read.detail, file: injected };
    return { ok: true, policy: read.policy, file: injected, configured: true };
  }
  const base = readPolicy(canonical, { now });
  if (named && named !== canonical) {
    const extra = readPolicy(named, { now });
    if (!extra.ok) return { ok: false, code: extra.code, detail: extra.detail, file: named };
    if (!base.ok) {
      if (base.code === REFUSALS.ABSENT) return { ok: true, policy: extra.policy, file: named, configured: true };
      return { ok: false, code: base.code, detail: base.detail, file: canonical };
    }
    let merged;
    try { merged = tightenPolicies(base.policy, extra.policy); }
    catch (e) {
      if (e && e.code === REFUSALS.ROUTE_ID) return { ok: false, code: e.code, detail: e.message, file: named };
      throw e;
    }
    return { ok: true, policy: merged, file: named, configured: true };
  }
  if (base.ok) return { ok: true, policy: base.policy, file: canonical, configured: true };
  if (base.code === REFUSALS.ABSENT) return { ok: true, policy: null, file: canonical, configured: false };
  return { ok: false, code: base.code, detail: base.detail, file: canonical };
}

module.exports = {
  SCHEMA, RELATIVE, ENV, MAX_CAP, REFUSALS, EXPIRED,
  canonicalFile, readPolicy, parsePolicy, resolvePolicy, effectiveCaps, entryCap, routeOf, inPool, admit, tighter, tightenPolicies, clientId,
};

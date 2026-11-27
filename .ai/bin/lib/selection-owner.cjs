'use strict';
// One fail-closed owner boundary for catalog, ladder and launch projections.
// Host data is read on demand; requiring this module performs no IO.
const path = require('node:path');
const safe = require('./path-safe.cjs');
const text = require('./text-safe.cjs');
const identity = require('./model-identity.cjs');
const { makerMatches } = require('./maker-fold.cjs');
const billingSchema = require('./model-bank-route.schema.json').properties.billing;
const requiredPolicy = require('./selection-owner-requirements.json');
const billingOrder = new Map(billingSchema['x-cost-order'].flatMap((group, rank) => group.map(value => [value, rank])));
const knownBilling = value => billingSchema.enum.includes(value) && billingOrder.has(value);
const { independenceOf, excludesRoute } = require('./selection-constraints.cjs');
const CERTIFYING_ROLE = new RegExp('^(?:' + ['certifier', 'certifier-strong', 'certifier-medium', 'shadow-certifier', 'auditor'].join('|') + ')$');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+~-]{0,159}$/.test(v);
const denyKey = value => value.split('/').at(-1).toLowerCase().replace(/\./g, '-');
const knownModel = value => id(value) && value.toLowerCase() !== 'unknown';
const timestamp = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d[:]\d\d[:]\d\d\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const fail = () => { throw Object.assign(Error('owner-rules-invalid'), { code: 'owner-rules-invalid', selectionReason: 'owner-rules-invalid' }); };
const OWNER_RULE_KINDS = { 'task-route': 'owner-task-route', 'exclude-model': 'owner-model-excluded', 'conditional-model': 'owner-model-excluded', 'effort-range': 'owner-effort-range', 'exclude-provider': 'owner-provider-excluded', 'prefer-last-provider': null };
function validateOwnerRules(doc) {
  const prose = v => typeof v === 'string' && v.trim().length > 0;
  const list = v => Array.isArray(v) && v.length > 0 && v.every(prose) && new Set(v).size === v.length;
  if (!object(doc) || Object.keys(doc).length !== 3 || doc.schema !== 'assign-owner-rules/1' || !prose(doc.reason) || !Array.isArray(doc.rules)) fail();
  const ids = new Set();
  for (const rule of doc.rules) {
    if (!object(rule) || !id(rule.id) || ids.has(rule.id) || typeof rule.enabled !== 'boolean' || !prose(rule.reason) || !Object.hasOwn(OWNER_RULE_KINDS, rule.kind)) fail();
    ids.add(rule.id);
    if (rule.kind === 'task-route') {
      const allowed = ['id', 'enabled', 'kind', 'families', 'modelIds', 'roles', 'action', 'reason', 'dimensions', 'clients', 'providers', 'maxMinutes', 'riskClasses', 'reviewScopes', 'minMinutes'];
      if (Object.keys(rule).some(k => !allowed.includes(k)) || !(list(rule.families) && rule.modelIds === undefined || list(rule.modelIds) && rule.families === undefined) || !list(rule.roles)
          || !['exclude', 'require-route', 'max-duration', 'prefer'].includes(rule.action)) fail();
      for (const k of ['dimensions', 'clients', 'providers', 'riskClasses', 'reviewScopes']) if (rule[k] !== undefined && !list(rule[k])) fail();
      if (rule.families?.some(f => !/^[a-z][a-z0-9-]*$/.test(f))) fail();
      for (const k of ['maxMinutes', 'minMinutes']) if (rule[k] !== undefined && (!Number.isFinite(rule[k]) || rule[k] < 0 || rule[k] > 10080)) fail();
      if (rule.action === 'require-route' && !rule.clients || rule.action === 'max-duration' && rule.maxMinutes === undefined) fail();
      continue;
    }
    const provider = ['exclude-provider', 'prefer-last-provider'].includes(rule.kind);
    const model = ['exclude-model', 'conditional-model'].includes(rule.kind);
    const keys = model ? ['id', 'enabled', 'kind', 'modelIds', 'reason'] : provider ? ['id', 'enabled', 'kind', 'providers', 'reason'] : ['id', 'enabled', 'kind', 'makers', 'efforts', 'reason'];
    if (rule.kind === 'conditional-model') keys.push('tier', 'maxSeats', 'maxLaunchShare', 'windowDays', 'route');
    if (provider) for (const k of ['clients', 'billings']) if (Object.hasOwn(rule, k)) keys.push(k);
    if (Object.keys(rule).length !== keys.length || keys.some(k => !Object.hasOwn(rule, k))) fail();
    if (model ? !list(rule.modelIds) : provider ? !list(rule.providers) || ['clients', 'billings'].some(k => Object.hasOwn(rule, k) && !list(rule[k])) : !list(rule.makers) || !list(rule.efforts)) fail();
    if (rule.kind === 'conditional-model' && (rule.tier !== 9 || rule.maxSeats !== 1 || rule.maxLaunchShare !== 0.05 || rule.windowDays !== 7 || rule.route !== 'claude')) fail();
  }
  try { identity.refuseCleanData(doc, 'owner-rules'); } catch { fail(); }
  return doc;
}
function loadOwnerRules(root) {
  try {
    const rel = 'tools/assign/owner-rules.json';
    const abs = path.resolve(root);
    const base = safe.realInside(path.parse(abs).root, abs, { allowRoot: true, refuseHardlinks: true });
    if (!base.ok || base.type !== 'dir') fail();
    const g = safe.realInside(base.real, rel, { refuseHardlinks: true });
    if (!g.ok) fail();
    if (!g.exists) return null;
    if (g.type !== 'file') fail();
    const read = safe.readFileGuarded(base.real, rel);
    if (!read.ok || read.bytes.length > 64 * 1024) fail();
    const decoded = text.decode(read.bytes, { bom: 'refuse', crlf: 'normalise', invisible: 'refuse' });
    if (!decoded.ok || decoded.notes.some(n => n.code === 'NOT_NFC')) fail();
    return validateOwnerRules(text.parseJsonUnique(decoded.text));
  } catch { fail(); }
}
// An owner rule names a provider by the one pool rule of the seat policy (inPool): case and every documented spelling of
// one model fold to one key, so each reader of the rule excludes the same routes. The rule reads no file: a plan reads only
// the inputs its caller declared.
const { inPool } = require('./seat-policy.cjs');
const declaredModels = route => [route.model, route.modelId, route.makerModel, route.routeModel].filter(v => typeof v === 'string');
function modelIds(route, ids = identity) {
  const values = declaredModels(route);
  return [...new Set(values.flatMap(v => [v, ids.canonicalModel(v)]).filter(v => v !== 'UNKNOWN'))];
}
function matchesModel(rule, route, ids = identity) {
  const models = modelIds(route, ids);
  return rule.modelIds.some(m => models.some(v => denyKey(v) === denyKey(m)));
}
// Facts are supplied by the host, never inferred from prose or missing history.
// A prospective launch participates in the seven-day share, including cold start.
function conditionalReasons(rule, route, context) {
  const ids = context.identity || identity;
  if (!matchesModel(rule, route, ids)) return [];
  const facts = context.ownerContext || context;
  const now = typeof facts.now === 'number' ? facts.now : Date.parse(facts.now);
  const seats = facts.activeSeats, records = facts.launchRecords;
  const limits = facts.claudeLimits || (facts.claudeLimit ? [facts.claudeLimit] : []);
  if (context.tier !== `T${rule.tier}` && context.tier !== rule.tier) return ['owner-model-excluded'];
  if (!Array.isArray(seats) || seats.some(s => !object(s) || !knownModel(s.model))) return ['owner-model-excluded', 'owner-fallback-facts-unknown'];
  if (seats.filter(s => matchesModel(rule, s, ids)).length >= rule.maxSeats) return ['owner-model-excluded', 'owner-fallback-seat-cap'];
  if (!Array.isArray(limits) || !limits.length || limits.some(limit => !object(limit) || limit.route !== rule.route || !['declared', 'measured'].includes(limit.source)
      || !['ok', 'low'].includes(limit.state) || !Number.isFinite(now) || !timestamp(limit.at)
      || Date.parse(limit.at) > now || now - Date.parse(limit.at) > 86400000)) return ['owner-model-excluded', 'owner-fallback-facts-unknown'];
  if (limits.some(limit => limit.state === 'low')) return ['owner-model-excluded', 'owner-fallback-low-limit'];
  if (!Array.isArray(records)) return ['owner-model-excluded', 'owner-fallback-facts-unknown'];
  const launches = new Map();
  for (const row of records) {
    if (!object(row) || row.schema !== 'launch-record/1' || !id(row.launchId) || !timestamp(row.startedAt)
        || !object(row.tuple) || !knownModel(row.tuple.model) || Date.parse(row.startedAt) > now) return ['owner-model-excluded', 'owner-fallback-facts-unknown'];
    if (row.servedModel != null && !knownModel(row.servedModel)) return ['owner-model-excluded', 'owner-fallback-facts-unknown'];
    const key = JSON.stringify([row.startedAt, denyKey(row.tuple.model), row.servedModel == null ? null : denyKey(row.servedModel)]);
    if (launches.has(row.launchId) && launches.get(row.launchId).key !== key) return ['owner-model-excluded', 'owner-fallback-facts-unknown'];
    launches.set(row.launchId, { key, row });
  }
  const recent = [...launches.values()].map(v => v.row).filter(r => Date.parse(r.startedAt) >= now - rule.windowDays * 86400000);
  if ((recent.filter(r => matchesModel(rule, { ...r.tuple, modelId: r.servedModel }, ids)).length + 1) / (recent.length + 1) > rule.maxLaunchShare) return ['owner-model-excluded', 'owner-fallback-launch-share'];
  return [];
}
function ownerRuleReasons(doc, route, ids = identity) {
  if (!doc) return [];
  const reasons = [];
  const models = modelIds(route, ids);
  // Denial is conservative across a provider prefix and dotted version syntax.
  // This key may deny a spelling; it never establishes served-model identity.
  for (const rule of doc ? validateOwnerRules(doc).rules : []) {
    if (!rule.enabled) continue;
    if (rule.kind === 'exclude-model' && rule.modelIds.some(m => models.includes(m) || models.includes(ids.canonicalModel(m))
        || models.some(v => denyKey(v) === denyKey(m)))) reasons.push(OWNER_RULE_KINDS[rule.kind]);
    if (rule.kind === 'exclude-provider' && (!rule.clients || rule.clients.includes(route.client))
        && (!rule.billings || rule.billings.includes(route.billing))
        && rule.providers.some(p => [route.provider, ...models].some(v => inPool(p, v)))) reasons.push(OWNER_RULE_KINDS[rule.kind]);
    if (rule.kind === 'effort-range' && rule.makers.some(m => makerMatches(m, String(route.maker || ids.canonicalFamily(route.model))))
        && !rule.efforts.includes(route.effort)) reasons.push(OWNER_RULE_KINDS[rule.kind]);
  }
  return reasons;
}
function exclusionReasons(doc, route, context = {}) {
  try {
    const ids = context.identity || identity;
    const reasons = ownerRuleReasons(doc, route, ids);
    reasons.push(...taskRouteRules(doc, route, context).reasons);
    const certifying = CERTIFYING_ROLE.test(context.role || '') || context.stageKind === 'certification';
    const models = certifying ? modelIds(route, ids) : [];
    if (context.mode === 'assign' && !knownBilling(route.billing)) reasons.push('assign-unknown-billing');
    for (const rule of doc?.rules || []) if (rule.enabled && rule.kind === 'conditional-model') reasons.push(...conditionalReasons(rule, route, context));
    const ind = independenceOf(context.independence);
    if (excludesRoute(ind, route)) reasons.push('independence');
    if (certifying) {
      const routeFamilies = new Set([...models.map(m => ids.canonicalFamily(m)), ids.declaredFamily(route.family)].filter(f => f !== 'UNKNOWN'));
      if (ind.excludeFamilies.some(f => routeFamilies.has(ids.declaredFamily(f)))) reasons.push('independence');
      for (const entry of ind.lineage) {
        if (entry.family && routeFamilies.has(ids.declaredFamily(entry.family))) reasons.push('independence');
        if (!entry.model) continue;
        const family = ids.canonicalFamily(entry.model);
        if (models.some(m => ids.canonicalModel(m) === ids.canonicalModel(entry.model) && ids.canonicalModel(m) !== 'UNKNOWN'
            || family !== 'UNKNOWN' && family === ids.canonicalFamily(m))) reasons.push('independence');
      }
    }
    return [...new Set(reasons)];
  } catch (e) { return [e.code === 'INDEPENDENCE_MALFORMED' ? 'independence-malformed' : 'owner-rules-invalid']; }
}
// Task constraints live in the owner's data. Unknown duration cannot prove that
// a bounded route fits. Preferences only reorder already eligible candidates.
function taskRouteRules(doc, route, context = {}) {
  if (!doc?.rules?.some(r => r.enabled && r.kind === 'task-route')) return { reasons: [], preference: 0 };
  const ids = context.identity || identity;
  const facts = context.ownerContext?.taskFacts || context.taskFacts || {};
  // Intake aliases keep the same owner constraints at each filtering boundary.
  const role = { implementer: 'author', reviewer: 'pre-reviewer', architect: 'operator',
    'pre-review': 'pre-reviewer', 'procedure-author': 'operator',
    'certifier-strong': 'certifier', 'certifier-medium': 'certifier',
    critic: 'pre-reviewer', researcher: 'author', drafter: 'author', synthesiser: 'author' }[context.role] || context.role;
  const reasons = []; let preference = 0;
  const families = new Set([ids.declaredFamily(route.family), ...modelIds(route, ids).map(m => ids.canonicalFamily(m))].filter(f => f !== 'UNKNOWN'));
  for (const rule of doc?.rules || []) {
    if (!rule.enabled || rule.kind !== 'task-route' || !rule.roles.includes(role)
        || !(rule.families ? rule.families.some(f => families.has(ids.declaredFamily(f))) : matchesModel(rule, route, ids))
        || rule.dimensions && !rule.dimensions.some(d => facts.dimensions?.includes(d))
        || rule.riskClasses && !rule.riskClasses.includes(facts.riskClass)
        || rule.reviewScopes && !rule.reviewScopes.includes(facts.reviewScope)
        || rule.minMinutes !== undefined && !(facts.minutes >= rule.minMinutes)) continue;
    if (rule.action === 'exclude') reasons.push(rule.modelIds ? 'owner-model-excluded' : 'owner-task-excluded');
    if (rule.action === 'require-route' && (!rule.clients.includes(route.client) || rule.providers && !rule.providers.some(p => inPool(p, route.provider)))) reasons.push('owner-task-route');
    if (rule.action === 'max-duration' && (!Number.isFinite(facts.minutes) || facts.minutes < 0 || facts.minutes > rule.maxMinutes)) reasons.push('owner-task-duration');
    if (rule.action === 'prefer') preference--;
  }
  return { reasons: [...new Set(reasons)], preference };
}
function filterRoutes(rows, context = {}) {
  let doc, unavailable = false;
  try {
    doc = Object.hasOwn(context, 'ownerRules') ? context.ownerRules : loadOwnerRules(context.repoRoot || path.resolve(__dirname, '../../..'));
    if (context.requireOwnerRules && doc === null) unavailable = true;
    if (doc !== null) validateOwnerRules(doc);
  }
  catch {
    // Invalid explicit policy data still refuses. At a dispatch boundary a host
    // read failure blocks only decisions that need policy, not unrelated work.
    if (Object.hasOwn(context, 'ownerRules') || !context.requireOwnerRules) return { allowed: [], excluded: rows.map(route => ({ route, reasons: ['owner-rules-invalid'] })), reason: 'owner-rules-invalid' };
    doc = null; unavailable = true;
  }
  const allowed = [], excluded = [];
  for (const route of rows) {
    const reasons = exclusionReasons(doc, route, context);
    // Denial scope uses declared spellings only: missing host policy must not
    // turn an ordinary dispatch into a read of the optional benchmark catalog.
    if (unavailable && (requiredPolicy.modelIds.some(m => declaredModels(route).some(v => denyKey(v) === denyKey(m)))
        || context.mode === 'assign' && knownBilling(route.billing) && billingRank(route) > 0)) reasons.unshift('owner-rules-invalid');
    if (reasons.length) excluded.push({ route, reasons }); else allowed.push(route);
  }
  // Call this after ordinary qualification as well: an unavailable alternative
  // cannot suppress the last eligible model. Early passes defer only this step.
  if (!context.deferAlternatives) for (const rule of doc?.rules || []) {
    if (!rule.enabled || rule.kind !== 'conditional-model') continue;
    const alternativePool = context.alternativeRoutes ? filterRoutes(context.alternativeRoutes, { ...context, ownerRules: doc, alternativeRoutes: undefined, deferAlternatives: true }).allowed : [];
    const ids = context.identity || identity;
    const alternatives = [...allowed, ...alternativePool].some(r => !matchesModel(rule, r, ids) && r.qualified !== false
      && !(Array.isArray(r.excluded) && r.excluded.length));
    if (alternatives) for (let i = allowed.length - 1; i >= 0; i--) if (matchesModel(rule, allowed[i], ids)) {
      excluded.push({ route: allowed[i], reasons: ['owner-model-excluded', 'owner-fallback-alternative'] }); allowed.splice(i, 1);
    }
  }
  return { allowed, excluded, reason: allowed.length ? null : excluded[0]?.reasons[0] || 'no-owner-allowed-route' };
}
const billingRank = route => billingOrder.get(route.billing) ?? 4;
module.exports = { loadOwnerRules, validateOwnerRules, ownerRuleReasons, exclusionReasons, filterRoutes, billingRank, taskRouteRules };

'use strict';
// Model advice: a ranked top of canonical MODELS for one task class, never a client, a route or a provider.
// The rank is the benchmark strength of the model for the dimension of the task (the same profile score and
// classifier-median floor the selection uses); scores that tie within the measured error go to the lowest public
// list price. Only model facts exclude a model: an author family for a reviewing role, an owner rule that withdrew
// the model, the review maker rule, the expensive-model policy. A model without a benchmark row for the class stays
// a conditional row with its score unknown. Routes never rank: after the ranking each model lists the known routes
// that can serve it now (state, proof, cap) as information for the operator; no live route is no-route-now.
const identity = require('../../.ai/bin/lib/model-identity.cjs');
const adapter = { routes: () => [], profileScore: () => ({ score: null, substitute: [], thin: false }), floorOf: () => ({ rule: 'none' }), classifierMedians: () => new Map(), rowFloor: () => null };
const registry = require('./dimension-registry.cjs').load();

const TOP = 5;
const WANTED = 3;
// The bank carries no measured error of a strength: only an exact tie is a tie.
const TIE_MARGIN = 0;
const TIE_BASIS = 'no-measured-error-in-bank';
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const REVIEWING = ['certifier', 'pre-reviewer'];
const norm = s => String(s).toLowerCase().replace(/[._]/g, '-');
// The zero-width space, non-joiner and joiner, the word joiner and the byte order mark: invisible inside a name.
const INVISIBLE = new Set([0x200B, 0x200C, 0x200D, 0x2060, 0xFEFF]);
const visible = s => [...s].filter(c => !INVISIBLE.has(c.codePointAt(0))).join('');
const canonical = id => { const c = identity.canonicalModel(id); return c === 'UNKNOWN' ? id : c; };
function familyOf(model) {
  const declared = identity.declaredFamily(model.maker);
  return declared !== 'UNKNOWN' ? declared : identity.canonicalFamily(model.id);
}

// The best strength of a model over the efforts its benchmark groups name; an effort-free group counts at the basis.
function strength(model, profile, dimension) {
  const efforts = new Set([null]);
  for (const view of [model.public?.dimensions]) for (const cell of Object.values(view || {})) for (const g of cell.groupsDetail || []) if (typeof g.effort === 'string' && g.effort) efforts.add(g.effort);
  let best = null;
  for (const effort of [...efforts].sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b))) {
    const at = effort === null ? 'basis' : effort;
    const p = adapter.profileScore(profile, { classRecord: model, effort: at, effortBasis: at, effortConvention: false }, false);
    if (p.score === null) continue;
    if (!best || p.score > best.p.score) best = { p, effort };
  }
  if (!best) return null;
  const by = best.p.substitute[0]?.by || dimension;
  const cell = model.public.dimensions[by];
  return { score: best.p.score, effort: best.effort, thin: best.p.thin, substitute: best.p.substitute,
    basis: { dimension, by, state: cell.state, benchmarks: [...new Set(cell.groupsDetail.map(g => g.benchmarkId))].sort(),
      groups: cell.groups, sourceKinds: [...new Set(cell.groupsDetail.map(g => g.sourceKind))].sort() } };
}

// The public list price of the canonical model: the cheapest standard list record of the newest price snapshot whose
// canonical id names the model. The index is input plus output dollars per million tokens.
function listPrice(catalog, model) {
  const id = norm(model.id).split('/').pop();
  let best = null;
  const dollars = v => typeof v === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(v) ? Number(v) : typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
  for (const p of catalog.prices?.records || []) {
    const input = dollars(p.inputPerM), output = dollars(p.outputPerM);
    if (p.priceKind !== 'list' || p.variant !== 'standard' || input === null || output === null) continue;
    if (norm(p.canonicalId).split('/').pop() !== id) continue;
    const index = Math.round((input + output) * 1e6) / 1e6;
    if (!best || index < best.index) best = { inputPerM: input, outputPerM: output, index,
      basis: { kind: 'public-list-price', index: 'inputPerM+outputPerM', platform: p.platform, record: p.canonicalId, snapshot: catalog.prices.id } };
  }
  return best;
}

function ownerExcluded(ownerRules, model, family, role, taskDimensions) {
  return (ownerRules?.rules || []).some(r => r.enabled === true && r.kind === 'task-route' && r.action === 'exclude'
    && (!Array.isArray(r.roles) || r.roles.includes(role))
    && (!Array.isArray(r.dimensions) || r.dimensions.some(d => taskDimensions.includes(d)))
    && ((r.modelIds || []).some(m => canonical(m) === canonical(model.id)) || (r.families || []).includes(family)));
}

// The routes of a model as information: state from the projected route states, proof time, served model and caps.
function routeInfo(catalog, routeRows, routeStates, adviceUnknown, modelId) {
  const out = new Map();
  for (const r of routeRows) {
    if (canonical(r.modelId || r.model) !== modelId || out.has(`${r.client}:${r.model}`)) continue;
    const st = routeStates.find(s => s.client === r.client && s.model === r.model);
    const state = r.withdrawn ? 'client-withdrawn' : r.closed ? 'closed' : r.kind !== 'text' ? 'not-text'
      : r.launchable === false || r.unverified === true ? 'unverified'
      : st?.available === true && !adviceUnknown.has(`${r.client}:${r.model}`) ? 'live'
      : st?.available === false && !adviceUnknown.has(`${r.client}:${r.model}`) ? 'unavailable' : 'unproven';
    out.set(`${r.client}:${r.model}`, { client: r.client, model: r.model, state, provedAt: st?.at || null, served: st?.servedModel || null,
      clientCap: r.clientCap ?? null, routeCap: r.routeCap ?? null,
      ...(r.launchable !== undefined ? { launchable: r.launchable === true && state === 'live' } : {}) });
  }
  const order = ['live', 'unproven', 'unavailable', 'unverified', 'closed', 'client-withdrawn', 'not-text'];
  return [...out.values()].sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state) || `${a.client}:${a.model}`.localeCompare(`${b.client}:${b.model}`));
}

// facts: { role (assign role), frameRole, dimension, tier, task: { kind, riskClass, failedRounds, superImportant },
// taskDimensions, authorFamilies, lineageKnown, routeStates, adviceUnknown, ownerRules, policy }
function rank(catalog, facts) {
  const role = facts.role;
  const dimension = registry.ids.includes(facts.dimension) ? facts.dimension : registry.roles[facts.frameRole] || null;
  if (!dimension) return { schema: 'model-advice/1', dimension: null, reason: 'dimension-unknown', ranked: [], excluded: [] };
  const profile = [{ id: dimension, weight: 1 }];
  const tier = Number(String(facts.tier || 'T9').slice(1));
  const floor = catalog.strengthFloor || adapter.floorOf(catalog.weights || {});
  const floorOn = floor.rule === 'classifier-median' && tier >= Number(String(floor.fromTier).slice(1));
  const medians = floorOn ? adapter.classifierMedians(catalog.classes.models, false) : new Map();
  const routeRows = adapter.routes(catalog);
  // An author family spelled with surrounding space or a zero-width character inside is the same family, never an unknown one
  // that silently drops the exclusion.
  const authors = new Set((facts.authorFamilies || []).map(f => identity.declaredFamily(typeof f === 'string' ? visible(f).trim() : f)).filter(f => f !== 'UNKNOWN'));
  const policy = facts.policy || {};
  const task = facts.task || {};
  const rows = new Map(), excluded = [];
  for (const model of catalog.classes.models) {
    const id = canonical(model.id);
    const family = familyOf(model);
    const kinds = routeRows.filter(r => canonical(r.modelId || r.model) === id).map(r => r.kind);
    const reasons = [], unknown = [];
    if (kinds.length && kinds.every(k => k !== 'text')) reasons.push('model-kind-not-text');
    if (REVIEWING.includes(role) && family !== 'UNKNOWN' && authors.has(family)) reasons.push('author-family');
    if (REVIEWING.includes(role) && (policy.reviewExcludedMakers || []).some(m => String(m).toLowerCase() === String(model.maker || '').toLowerCase())) reasons.push('role-rule');
    if (ownerExcluded(facts.ownerRules, model, family, role, facts.taskDimensions || [])) reasons.push('owner-model-excluded');
    const top = policy.topModel;
    if (top && top.modelIds.some(m => canonical(m) === id) && ((top.forbiddenKinds || []).includes(task.kind) || tier < top.minTier
        || !(task.riskClass === 'A' && Number.isInteger(task.failedRounds) && task.failedRounds >= top.minFailedRounds || task.superImportant === true || task.kind === 'design'))) reasons.push('top-model-policy');
    const s = strength(model, profile, dimension);
    const floorValue = s && floorOn ? adapter.rowFloor(profile, s.substitute, medians) : null;
    if (s && floorValue !== null && s.score < floorValue) reasons.push('below-classifier-median');
    if (reasons.length) { excluded.push({ model: id, family, reasons }); continue; }
    if (!s) unknown.push('score-unknown');
    if (s?.thin) unknown.push('thin-evidence');
    if (s?.substitute.length) unknown.push(`score-substitute-${s.basis.by}`);
    if (family === 'UNKNOWN') unknown.push('model-family-unknown');
    const price = listPrice(catalog, model);
    if (!price) unknown.push('price-unknown');
    const row = { model: id, family, score: s ? s.score : null, thin: s ? s.thin : true, effort: s ? s.effort : null,
      scoreBasis: s ? s.basis : { dimension, by: null, state: 'no-benchmark-row', benchmarks: [], groups: 0, sourceKinds: [] },
      strengthFloor: floorValue, price, unknown,
      conditional: !s || family === 'UNKNOWN' && REVIEWING.includes(role) };
    const held = rows.get(id);
    if (!held || held.thin && !row.thin || held.thin === row.thin && (row.score ?? -1) > (held.score ?? -1)) rows.set(id, row);
  }
  const byPrice = (a, b) => (a.price ? a.price.index : Infinity) - (b.price ? b.price.index : Infinity);
  const sorted = [...rows.values()].sort((a, b) => Number(a.conditional) - Number(b.conditional)
    || (a.score === null) - (b.score === null)
    || Number(a.thin) - Number(b.thin)
    || (a.score !== null && b.score !== null && Math.abs(a.score - b.score) > TIE_MARGIN ? b.score - a.score : 0)
    || byPrice(a, b) || a.model.localeCompare(b.model, 'en'));
  const admissible = sorted.filter(r => !r.conditional);
  const ordered = admissible.length >= WANTED ? admissible : [...admissible, ...sorted.filter(r => r.conditional)];
  const states = facts.routeStates || [], adviceUnknown = facts.adviceUnknown || new Set();
  const strengthRanked = ordered.map((r, i) => {
      const routes = routeInfo(catalog, routeRows, states, adviceUnknown, r.model);
      const reasons = [r.score === null ? 'benchmark-unknown' : `benchmark-${dimension}${r.scoreBasis.by !== dimension ? `-via-${r.scoreBasis.by}` : ''}`,
        ...(r.thin ? ['thin-evidence'] : []), ...(routes.length ? [] : ['no-route-row']),
        ...(i > 0 && r.score !== null && ordered[i - 1].score === r.score ? ['score-tie-cheaper-first'] : []), r.price ? 'list-price-known' : 'list-price-unknown'];
      const confirm = [...(r.score === null ? ['confirm-model-suitability'] : []), ...(r.family === 'UNKNOWN' && REVIEWING.includes(role) ? ['confirm-model-family'] : []),
        ...(REVIEWING.includes(role) && !facts.lineageKnown ? ['confirm-authors-outside-this-family'] : [])];
      const live = routes.some(x => x.state === 'live');
      return { rank: i + 1, ...r, reasons, confirm, routes, routeNow: live ? 'live' : 'no-route-now',
        routeState: live ? 'launchable-route' : routes.length ? 'route-row-without-launch-proof' : 'no-route' };
    });
  return { schema: 'model-advice/1', dimension, tieMargin: TIE_MARGIN, tieBasis: TIE_BASIS,
    floor: { rule: floor.rule, applies: floorOn }, reason: strengthRanked.length ? 'ranked' : 'no-admissible-model',
    ranked: strengthRanked.slice(0, TOP), strengthRanked,
    launchRecommendation: strengthRanked.find(r => r.routes.length > 0) || null, excluded };
}

// The canonical model a name stands for: a route spelling of the given client, else any route spelling, else the
// kernel identity table, else a model id of the catalog itself. A name nothing knows is null, never a guess.
function modelOf(catalog, name, client) {
  if (typeof name !== 'string' || !name) return null;
  const rows = adapter.routes(catalog).filter(r => r.model === name && r.modelId);
  const own = rows.find(r => r.client === client) || rows[0];
  if (own) return canonical(own.modelId);
  const id = identity.canonicalModel(name);
  if (id !== 'UNKNOWN') return id;
  const listed = catalog.classes.models.find(m => m.id === name || canonical(m.id) === name);
  return listed ? canonical(listed.id) : null;
}

// The persisted form of the advice: bounded, ids and numbers only.
function brief(advice) {
  return { schema: advice.schema, dimension: advice.dimension, reason: advice.reason, tieMargin: advice.tieMargin ?? null,
    ...(advice.scope ? { scope: advice.scope } : {}),
    launchRecommendation: advice.launchRecommendation ? { model: advice.launchRecommendation.model, rank: advice.launchRecommendation.rank,
      routeState: advice.launchRecommendation.routeState,
      routes: advice.launchRecommendation.routes.slice(0, 8).map(x => `${x.client}:${x.model}`) } : null,
    ranked: (advice.ranked || []).map(r => ({ rank: r.rank, model: r.model, family: r.family, score: r.score, effort: r.effort,
      benchmarks: r.scoreBasis.benchmarks.slice(0, 20), by: r.scoreBasis.by, priceIndex: r.price ? r.price.index : null,
      conditional: r.conditional, routeNow: r.routeNow, routeState: r.routeState,
      routes: r.routes.slice(0, 8).map(x => `${x.client}:${x.model}`) })) };
}
module.exports = { rank, brief, modelOf, familyOf, listPrice, TOP, WANTED, TIE_MARGIN };

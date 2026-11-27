'use strict';
// Pure advice/actual/outcome reduction shared by launch readers and pulse.
const identity = require('./model-identity.cjs');
function compareRoutes(a, b, exact = false) {
  if (!a?.client || !a.model || !b?.client || !b.model) return null;
  const model = value => { const id = identity.canonicalModel(value); return id === 'UNKNOWN' ? value : id; };
  if (a.client !== b.client || model(a.model) !== model(b.model)) return false;
  if (a.effort && b.effort) return a.effort === b.effort;
  return exact && (a.effort || b.effort) ? null : true;
}
function row(record, source) {
  if (!record?.taskFrame || !record?.selectionShadow) return null;
  const routed = typeof record.seatRoute === 'string' && /^([a-z][a-z0-9-]*):(.+)$/.exec(record.seatRoute);
  const route = routed ? { client: routed[1], model: routed[2] } : record.tuple || record.selectionShadow.advice?.actual || record.resolver?.operator || record.contract?.route || null;
  const actual = route ? { client: route.client || null, model: route.model || null, effort: route.effort || null } : null;
  if (actual && record.servedModel && record.servedModelSource && record.servedModelSource !== 'none') actual.model = record.servedModel;
  const recommended = record.selectionShadow.choice;
  return { id: record.wrapperLaunchId || record.launchId || `${record.name || record.runId}@${record.startedAt}`, source,
    role: record.taskFrame.role, domain: record.taskFrame.domain, riskClass: record.taskFrame.riskClass,
    riskKnown: record.taskFrame.riskKnown, tier: record.taskFrame.tier, unknown: record.taskFrame.unknown,
    ...(record.taskFrame.scope ? { scope: record.taskFrame.scope } : {}),
    recommendation: recommended, reason: record.selectionShadow.reason, actual,
    exactMatch: compareRoutes(actual, recommended, true), routeMatch: compareRoutes(actual, recommended),
    taskClass: record.selectionShadow.advice?.taskClass || `${record.taskFrame.role}:${record.taskFrame.riskClass}:${record.taskFrame.tier}`,
    handOverride: record.selectionShadow.advice?.handOverride ?? null,
    deviationReason: record.selectionShadow.advice?.deviationReason || null,
    ranked: record.selectionShadow.advice?.ranked || [],
    adviceMode: record.selectionShadow.advice?.mode || null,
    excluded: record.selectionShadow.advice?.excluded || [],
    startedAt: typeof record.startedAt === 'string' ? record.startedAt : null,
    modelTop: Array.isArray(record.selectionShadow.advice?.models?.ranked) ? record.selectionShadow.advice.models.ranked.length : 0,
    assignment: record.selectionShadow.advice?.assignment || null,
    outcome: { endedAt: record.endedAt || null, exitCode: Number.isInteger(record.exitCode) ? record.exitCode : null,
      verdict: record.verdict || record.reviewOutcome || null, failureClass: record.failureClass || null } };
}
function groups(rows) {
  const map = new Map();
  for (const row of new Map(rows.map(r => [r.id, r])).values()) {
    const key = `${row.taskClass}/${row.tier}`;
    if (!map.has(key)) map.set(key, { taskClass: row.taskClass, tier: row.tier, pairs: 0, recommended: 0, matches: 0, deviations: 0,
      handOverrides: 0, outcomes: 0, noReason: 0, unknownComparison: 0, agreementRate: null, fallbacks: 0, reasons: {}, fallbackReasons: {} });
    const g = map.get(key); g.pairs++;
    if (row.recommendation) g.recommended++;
    const flags = row.unknown || [];
    if (flags.some(s => /input-unknown|diff-unknown|role-unknown|intake-unavailable|score-unknown/.test(s))) g.fallbacks++;
    for (const flag of new Set(flags)) g.fallbackReasons[flag] = (g.fallbackReasons[flag] || 0) + 1;
    if (row.reason) g.reasons[row.reason] = (g.reasons[row.reason] || 0) + 1;
    const match = row.routeMatch !== undefined ? row.routeMatch : row.exactMatch;
    if (match === true) g.matches++;
    else if (match === false) g.deviations++;
    else g.unknownComparison++;
    if (match === false && ['owner-explicit-choice', 'operator-choice-reason-not-provided', null].includes(row.deviationReason)) g.noReason++;
    if (row.handOverride === true) g.handOverrides++;
    if (row.outcome.endedAt) g.outcomes++;
    g.agreementRate = g.matches + g.deviations ? g.matches / (g.matches + g.deviations) : null;
  }
  return [...map.values()].sort((a, b) => a.taskClass.localeCompare(b.taskClass));
}
// The correction of the selection from own data stays off until this many comparable pairs exist; until then the
// selection reads benchmarks and price only. A pair is comparable when the launch ran with an advice of the selection
// (mode advise or assign), the advice named a route, the launched route is known, the outcome ended with a verdict
// (an exit code alone grades no work), and the classifier and the complexity of the task are known.
const CORRECTION_MIN_PAIRS = 50;
// The advice named a route: one predicate for the comparable pair and for the share of recommended launches.
const routeAdvised = r => Boolean(r.recommendation?.client && r.recommendation?.model);
function comparable(r) {
  return ['advise', 'assign'].includes(r.adviceMode) && routeAdvised(r)
    && Boolean(r.actual?.client && r.actual?.model)
    && Boolean(r.outcome?.endedAt) && Boolean(r.outcome.verdict)
    && typeof r.taskClass === 'string' && /^T[1-9]$/.test(String(r.tier));
}
function correction(rows) {
  const unique = [...new Map(rows.map(r => [r.id, r])).values()];
  const advised = unique.filter(r => ['advise', 'assign'].includes(r.adviceMode));
  const n = advised.filter(comparable).length;
  return { pairs: advised.length, comparable: n, threshold: CORRECTION_MIN_PAIRS, correction: n >= CORRECTION_MIN_PAIRS ? 'threshold-reached' : 'off' };
}
// The share of launches that got a non-empty recommendation (a model top or a route choice), the share whose model the
// operator confirmed as assigned, and the deviations with their reasons, over the last 24 hours and the last 7 days.
// One launch id is one observation: its running and terminal records carry the same counted facts and count once.
// Rows of one id whose counted facts differ are a rewrite, so that launch counts toward no share and is named in conflicts.
// A launch without a readable start time falls in no window and is counted as undated, never dropped silently.
const WINDOWS = [['24h', 86400000], ['7d', 7 * 86400000]];
const countedFacts = r => JSON.stringify([r.startedAt, r.modelTop, r.recommendation?.client || null, r.recommendation?.model || null, r.assignment || null]);
function shares(rows, nowMs) {
  const byId = new Map();
  for (const r of rows) {
    const seen = byId.get(r.id);
    if (!seen) byId.set(r.id, { row: r, conflict: false });
    else if (countedFacts(seen.row) !== countedFacts(r)) seen.conflict = true;
  }
  const undated = [...byId.values()].filter(({ row: r }) => !Number.isFinite(Date.parse(r.startedAt))).length;
  return WINDOWS.map(([window, ms]) => {
    const within = [...byId.values()].filter(({ row: r }) => { const at = Date.parse(r.startedAt); return Number.isFinite(at) && at <= nowMs && nowMs - at <= ms; });
    const inside = within.filter(e => !e.conflict).map(e => e.row);
    const withTop = inside.filter(r => r.modelTop > 0 || routeAdvised(r)).length;
    const confirmed = inside.filter(r => r.assignment?.status === 'confirmed').length;
    const deviations = inside.filter(r => r.assignment?.status === 'deviation')
      .map(r => ({ assigned: r.assignment.assigned, actual: r.assignment.actualModel, reason: r.assignment.deviation }));
    const share = n => inside.length ? n / inside.length : null;
    return { window, launches: inside.length, withTop, withTopShare: share(withTop), confirmed, confirmedShare: share(confirmed),
      refused: inside.filter(r => r.assignment?.status === 'refused').length, deviations,
      conflicts: within.filter(e => e.conflict).map(e => e.row.id).sort(), undated };
  });
}
function provenanceHashes(value) {
  const hashes = {};
  // Hash provenance contains only the catalog's named inputs, never arbitrary
  // adapter text or absolute machine paths supplied through a test seam.
  for (const [key, hash] of Object.entries(value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {})) {
    if (key === '.ai/docs/clients.json' && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) hashes[key] = hash;;
  }
  return hashes;
}
module.exports = { compareRoutes, row, groups, comparable, correction, shares, CORRECTION_MIN_PAIRS, provenanceHashes };

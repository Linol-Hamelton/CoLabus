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
    recommendation: recommended, reason: record.selectionShadow.reason, actual,
    exactMatch: compareRoutes(actual, recommended, true), routeMatch: compareRoutes(actual, recommended),
    taskClass: record.selectionShadow.advice?.taskClass || `${record.taskFrame.role}:${record.taskFrame.riskClass}:${record.taskFrame.tier}`,
    handOverride: record.selectionShadow.advice?.handOverride ?? null,
    deviationReason: record.selectionShadow.advice?.deviationReason || null,
    ranked: record.selectionShadow.advice?.ranked || [],
    adviceMode: record.selectionShadow.advice?.mode || null,
    excluded: record.selectionShadow.advice?.excluded || [],
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
module.exports = { compareRoutes, row, groups };

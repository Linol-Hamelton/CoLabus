'use strict';
const path = require('node:path');
const io = require('./io.cjs');
const selection = require('./selection-policy.cjs');
const risk = require('../../docs/ops/risk-class.cjs');
const { KINDS, validateDimensionPair, validateAnnotations } = require('./task-classifier.cjs');
const LEGACY_KINDS = ['author', 'pre-review'];
const ALL_KINDS = [...new Set([...KINDS, ...LEGACY_KINDS])];
const KEYS = ['packageId', 'kind', 'paths', 'files', 'lines', 'riskClass', 'failedRounds', 'verdicts', 'defectClasses', 'unknowns', 'verification', 'coupling', 'superImportant', 'complexity', 'dimension', 'dimensionSource', 'dimensions', 'classifier', 'classifierDisagreements'];
const VERDICTS = ['PASS', 'FAIL', 'BLOCKED', 'RECOMMENDATION'];
function rubricScore(scores, selectionPolicy) {
  const p = selectionPolicy.taskPolicy;
  return p.sumTiers[p.factors.reduce((n, k) => n + scores[k], 0)];
}
// Shared rubric for launch intake and structured assignment. Missing is unknown.
function rubricTier(scores, flags = {}, selectionPolicy = selection.loadPolicy().obj) {
  const p = selectionPolicy.taskPolicy;
  const known = p.factors.every(k => Number.isInteger(scores[k]) && scores[k] >= 0 && scores[k] <= 2);
  return `T${Math.max(known ? rubricScore(scores, selectionPolicy) : p.unknownTier,
    scores.protectedPaths > 0 ? p.hardFloors.protected : 1,
    flags.certification ? p.hardFloors.certification : 1, flags.kernel ? p.hardFloors.kernel : 1)}`;
}
function complexity(task, selectionPolicy = selection.loadPolicy().obj) {
  const policy = selectionPolicy.taskPolicy;
  io.fields(task, KEYS, ['packageId']); io.publicValue(task);
  if (!io.id(task.packageId)) io.fail('package-id-invalid');
  validateDimensionPair(task.dimension, task.dimensionSource);
  validateAnnotations(task);
  const features = [], add = (feature, value, tier, reason) => features.push({ feature, value: value ?? null, tier, reason });
  const unknown = (key) => add(key, null, policy.unknownTier, 'unknown-caution');
  const missing = key => task[key] === null || task[key] === undefined;
  const numeric = key => {
    if (missing(key)) { unknown(key); return false; }
    if (!io.count(task[key])) io.fail('feature-number-invalid'); return true;
  };
  if (missing('kind')) unknown('kind');
  else { if (!ALL_KINDS.includes(task.kind)) io.fail('kind-invalid'); add('kind', task.kind, task.kind === 'design' ? policy.designTier : 1, 'task-kind'); }
  // Volume is metadata only. Absence never adds uncertainty or changes a tier.
  for (const key of ['files', 'lines']) if (!missing(key) && !io.count(task[key])) io.fail('feature-number-invalid');
  if (missing('complexity')) unknown('complexity');
  else {
    io.fields(task.complexity, policy.factors, policy.factors);
    for (const f of policy.factors) if (!Number.isInteger(task.complexity[f]) || task.complexity[f] < 0 || task.complexity[f] > 2) io.fail('complexity-score-invalid');
    add('complexity', task.complexity, rubricScore(task.complexity, selectionPolicy), 'six-factor-rubric');
    if (task.complexity.protectedPaths > 0) add('protectedPaths', true, policy.hardFloors.protected, 'protected-floor');
  }
  if (task.kind === 'certify') add('certification', true, policy.hardFloors.certification, 'certification-floor');
  let pathRisk = null;
  if (missing('paths')) unknown('paths');
  else {
    if (!Array.isArray(task.paths) || !task.paths.length || task.paths.length > 10000 || new Set(task.paths.map(p => typeof p === 'string' ? p.toLowerCase() : p)).size !== task.paths.length) io.fail('paths-invalid');
    for (const p of task.paths) if (typeof p !== 'string' || p.length > 240 || !risk.normalisePath(p).ok || path.isAbsolute(p) || p.includes('\\')) io.fail('paths-invalid');
    if (!missing('files') && task.files < task.paths.length) io.fail('file-count-conflict');
    // The PRE classifier owns the path rules. Ownership is a checked manifest
    // projection inside the hashed policy, keeping the seven-input calculation pure.
    const ctx = { manifest: new Set(selectionPolicy.manifestOwned.map(p => p.toLowerCase())) };
    const rows = task.paths.map(p => risk.classifyPath(p, ctx));
    pathRisk = rows.some(r => r.cls === 'A') ? 'A' : 'B';
    add('paths', task.paths.slice().sort(), policy.pathFloors[pathRisk], 'risk-classifier-pre');
  }
  if (missing('riskClass')) unknown('riskClass');
  else { if (!['A', 'B'].includes(task.riskClass)) io.fail('risk-invalid'); add('riskClass', task.riskClass, policy.riskFloor[task.riskClass], 'declared-risk-floor'); }
  if (numeric('failedRounds')) add('failedRounds', task.failedRounds, Math.max(1, ...policy.failedRounds.filter(([n]) => task.failedRounds >= n).map(([, t]) => t)), 'failed-round-history');
  if (missing('verdicts')) unknown('verdicts');
  else {
    if (!Array.isArray(task.verdicts) || task.verdicts.length > 10000 || !task.verdicts.every(v => VERDICTS.includes(v))) io.fail('verdicts-invalid');
    add('verdicts', task.verdicts.slice().sort(), task.verdicts.includes('FAIL') && task.verdicts.includes('PASS') ? policy.splitTier : 1, 'verdict-split');
  }
  if (missing('defectClasses')) unknown('defectClasses');
  else {
    const ds = task.defectClasses;
    if (!Array.isArray(ds) || !ds.every(d => Number.isInteger(d) && d >= 1 && d <= 14) || new Set(ds).size !== ds.length) io.fail('defects-invalid');
    add('defectClasses', ds.slice().sort((a, b) => a - b), Math.max(1, ...policy.defects.filter(([n]) => ds.length >= n).map(([, t]) => t)), 'defect-history');
  }
  if (numeric('unknowns')) add('unknowns', task.unknowns, task.unknowns > 0 ? policy.discoveryTier : 1, 'discovery-caution');
  if (missing('verification')) unknown('verification');
  else { if (!Object.hasOwn(policy.verification, task.verification)) io.fail('verification-invalid'); add('verification', task.verification, policy.verification[task.verification], 'verification-weight'); }
  if (numeric('coupling')) add('coupling', task.coupling, Math.max(1, ...policy.coupling.filter(([n]) => task.coupling >= n).map(([, t]) => t)), 'cross-module-coupling');
  if (missing('superImportant')) unknown('superImportant');
  else { if (typeof task.superImportant !== 'boolean') io.fail('importance-invalid'); add('superImportant', task.superImportant, task.superImportant ? policy.importantTier : 1, 'owner-designation'); }
  const tier = Math.max(...features.map(f => f.tier));
  return { schema: 'complexity/1', packageId: task.packageId, tier: `T${tier}`, riskClass: pathRisk === 'A' || task.riskClass === 'A' ? 'A' : task.riskClass ?? null,
    ...(task.dimension !== undefined ? { dimension: task.dimension, dimensionSource: task.dimensionSource } : {}),
    ...Object.fromEntries(['dimensions', 'classifier', 'classifierDisagreements'].filter(k => task[k] !== undefined).map(k => [k, task[k]])),
    features, decidedBy: features.filter(f => f.tier === tier), policyHash: io.hash(policy) };
}
module.exports = { complexity, rubricTier, KINDS: ALL_KINDS, VERDICTS };

'use strict';
// Classify one round from its recorded paths, stream history and open questions.
// An unknown factor counts as the worst score for the tier; unknown scope stays A.
const path = require('node:path');
const risk = require('../../docs/ops/risk-class.cjs');
const { rubricTier } = require('./complexity.cjs');
const { COMPLEXITY_FACTORS, layerOf, protectedPathsOf } = require('./task-classifier.cjs');
const selection = require('./selection-policy.cjs');

const SCHEMA = 'round-class/1';
const FACT_KEYS = ['paths', 'priorRounds', 'openQuestions'];
const RULE = Object.fromEntries(risk.TABLE.map(r => [r.id, r]));
const isDocument = p => RULE['RC-B04-document'].test(path.posix.basename(p));
const isData = p => RULE['RC-B05-docs-data'].test(`docs/${path.posix.basename(p)}`);
const isCode = p => RULE['RC-A16-executable'].test(p);
const EXTERNAL_RULES = ['RC-A03-history-and-decisions', 'RC-A12-launch-and-channel-data'];
const IMPLEMENTING = ['implementer', 'fixer', 'architect'];
const refuse = code => { throw Object.assign(new Error(code), { code }); };
const count = v => Number.isSafeInteger(v) && v >= 0;

function validate(frame, facts) {
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) refuse('round-frame-invalid');
  if (frame.role !== undefined && typeof frame.role !== 'string') refuse('round-frame-invalid');
  if (!facts || typeof facts !== 'object' || Array.isArray(facts)) refuse('round-facts-invalid');
  if (Object.keys(facts).some(k => ![...FACT_KEYS, 'refusals'].includes(k)) || FACT_KEYS.some(k => !Object.hasOwn(facts, k))) refuse('round-facts-invalid');
  if (facts.paths !== null && (!Array.isArray(facts.paths) || facts.paths.length > 10000 || facts.paths.some(p => typeof p !== 'string'))) refuse('round-facts-invalid');
  for (const k of ['priorRounds', 'openQuestions']) if (facts[k] !== null && !count(facts[k])) refuse('round-facts-invalid');
  if (facts.refusals !== undefined && (!Array.isArray(facts.refusals) || facts.refusals.some(r => typeof r !== 'string' || !r.trim()))) refuse('round-facts-invalid');
}

function worst(scores) {
  if (scores.includes(2)) return 2;
  return scores.includes(null) ? null : Math.max(0, ...scores);
}
function reversibilityOf(p, row) {
  const n = risk.normalisePath(p);
  if (!n.ok) return null;
  p = n.path.toLowerCase();
  if (EXTERNAL_RULES.includes(row.rule) || /migrat/i.test(p) || isData(p)) return 2;
  if (isCode(p)) return 1;
  return isDocument(p) ? 0 : null;
}
function manifestContext() {
  try { return { manifest: new Set(selection.loadPolicy().obj.manifestOwned.map(p => p.toLowerCase())) }; }
  catch (e) { return { manifest: new Set(), manifestError: `selection-policy-unreadable:${e.code || 'error'}` }; }
}
function classify(frame, facts, opts = {}) {
  validate(frame, facts);
  const unknown = [];
  const factors = Object.fromEntries(COMPLEXITY_FACTORS.map(k => [k, null]));
  const role = typeof frame.role === 'string' ? frame.role : 'unknown';
  // Canonicalise before every helper, not just the risk table. Retain invalid input
  // for classifyPath to name it, never turn an invalid spelling into a valid path.
  const canonical = p => { const n = risk.normalisePath(p); return n.ok ? n.path.toLowerCase() : p; };
  const paths = Array.isArray(facts.paths) && facts.paths.length ? [...new Set(facts.paths.map(canonical))].sort() : null;
  let rows = null;
  if (paths === null) {
    const reason = facts.paths === null ? 'paths-of-round-unknown' : 'paths-of-round-empty';
    for (const k of ['protectedPaths', 'reversibility', 'coupling']) unknown.push(`${k}:${reason}`);
  } else {
    const ctx = opts.manifestCtx || manifestContext();
    rows = paths.map(p => risk.classifyPath(p, ctx));
    factors.protectedPaths = protectedPathsOf(rows);
    if (factors.protectedPaths === null) unknown.push(`protectedPaths:${rows.find(r => /^RC-A(?:00|99)-/.test(r.rule)).rule}`);
    factors.reversibility = worst(paths.map((p, i) => reversibilityOf(p, rows[i])));
    if (factors.reversibility === null) unknown.push('reversibility:path-kind-unknown');
    const layers = paths.map(p => risk.normalisePath(p).ok ? layerOf(p) : null);
    const known = new Set(layers.filter(Boolean)).size;
    factors.coupling = known >= 3 ? 2 : layers.includes(null) ? null : Math.min(2, known - 1);
    if (factors.coupling === null) unknown.push('coupling:path-layer-unknown');
  }
  const refusals = facts.refusals || [];
  const repeated = refusals.length >= 2 && refusals[refusals.length - 1].trim() === refusals[refusals.length - 2].trim();
  if (facts.priorRounds === null) unknown.push('novelty:history-unknown');
  else factors.novelty = facts.priorRounds === 0 || repeated ? 2 : 1;
  if (facts.openQuestions === null) unknown.push('ambiguity:open-questions-unrecorded');
  else factors.ambiguity = facts.openQuestions === 0 ? 0 : facts.openQuestions <= 2 ? 1 : 2;
  const judgement = role === 'certifier' || role === 'architect' || frame.domain === 'D-ARCH' ? 2
    : ['reviewer', 'critic'].includes(role) ? 1 : role === 'unknown' ? null : 0;
  const guessed = (frame.unknown || []).includes('role-from-task-text');
  if (judgement === null) unknown.push('independentJudgement:role-unknown');
  else if (guessed && judgement < 2) unknown.push('independentJudgement:role-from-task-text');
  else factors.independentJudgement = judgement;
  // Bounded task judgments keep their declared or inferred status. Path protection and reviewing-role
  // floors cannot be lowered by them; absent judgments retain the conservative unknown factors.
  if (opts.declaredFactors && COMPLEXITY_FACTORS.every(k => Number.isInteger(opts.declaredFactors[k]) && opts.declaredFactors[k] >= 0 && opts.declaredFactors[k] <= 2)) {
    for (const k of ['novelty', 'ambiguity']) factors[k] = opts.declaredFactors[k];
    for (const k of ['protectedPaths', 'reversibility', 'coupling', 'independentJudgement']) {
      if (factors[k] !== null) factors[k] = Math.max(factors[k], opts.declaredFactors[k]);
    }
  }
  if (opts.coupled && paths) factors.coupling = 2;
  const riskClass = rows === null || rows.some(r => r.cls === 'A') ? 'A' : 'B';
  if (rows === null) unknown.push('riskClass:scope-unknown');
  const scores = Object.fromEntries(COMPLEXITY_FACTORS.map(k => [k, factors[k] === null ? 2 : factors[k]]));
  const tier = rubricTier(scores, { certification: role === 'certifier', kernel: IMPLEMENTING.includes(role) && riskClass === 'A' }, opts.policy);
  return { schema: SCHEMA, riskClass, tier, factors, unknown, paths };
}

function roundPaths(changedByPrevious, findingPaths) {
  if (!Array.isArray(changedByPrevious) || !Array.isArray(findingPaths)) return null;
  return [...new Set([...changedByPrevious, ...findingPaths])].sort();
}
module.exports = { SCHEMA, classify, roundPaths, reversibilityOf };

'use strict';
// Pure validation is separate from the only file reader. No eager data/schema require.
const path = require('node:path');
const { createHash } = require('node:crypto');
const safe = require('../../.ai/bin/lib/path-safe.cjs');
const text = require('../../.ai/bin/lib/text-safe.cjs');
const identity = require('../../.ai/bin/lib/model-identity.cjs');
class Refusal extends Error { constructor(code, detail) { super(detail || code); this.code = code; } }
const fail = (code, detail) => { throw new Refusal(code, detail); };
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const object = o => o !== null && typeof o === 'object' && !Array.isArray(o);
const SLOTS = Object.freeze(['implementer', 'fixer', 'drafter', 'synthesiser', 'owner', 'researcher', 'reviewer', 'critic', 'coordinator', 'dispatcher', 'certifier', 'shadow-certifier', 'auditor', 'procedure-author']);
const FACTORS = Object.freeze(['protectedPaths', 'novelty', 'reversibility', 'ambiguity', 'coupling', 'independentJudgement']);
const DEFAULT = path.resolve(__dirname, '../../docs/ops/selection-policy.json');
// Update this byte pin with the four projections when changing canonical data.
const CANONICAL_SHA256 = 'd08bdfcbfa0f2518620984739a58cbde932e563c84086ec84b30aed232dd758f';
const MIN_FLOORS = Object.freeze({ certification: 7, kernel: 7, protected: 4 });
function fields(o, names, where) {
  if (!object(o) || Object.keys(o).length !== names.length || names.some(k => !Object.hasOwn(o, k))) fail('policy-schema', where);
}
const integer = (n, lo, hi) => Number.isSafeInteger(n) && n >= lo && n <= hi;
const tier = n => integer(n, 1, 9);
function readInput(file, what) {
  const abs = path.resolve(file);
  const guarded = safe.readFileGuarded(path.parse(abs).root, abs);
  if (!guarded.ok) fail(`${what}-unreadable`, guarded.reason);
  const decoded = text.decode(guarded.bytes, { bom: 'refuse', crlf: 'normalise', invisible: 'refuse' });
  if (!decoded.ok || decoded.notes.some(n => n.code === 'NOT_NFC')) fail(`${what}-encoding`);
  let obj;
  try { obj = text.parseJsonUnique(decoded.text); }
  catch (e) { fail(`${what}-invalid-json`, e.code === 'JSON_DUPLICATE_KEY' ? 'a key appears twice in one object' : 'not valid JSON'); }
  if (!object(obj)) fail(`${what}-invalid-json`, 'the top level must be an object');
  // Tokenise strings as whole tokens, so numbers inside strings stay untouched.
  for (const token of decoded.text.match(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g) || []) {
    if (token[0] === '"') continue;
    const n = Number(token);
    if (!Number.isFinite(n) || (Number.isInteger(n) && !Number.isSafeInteger(n)) || JSON.stringify(n) !== token) fail(`${what}-number`, 'non-canonical or unsafe number');
  }
  try { identity.refuseCleanData(obj, `the ${what}`); } catch (e) { fail(`${what}-text`, e.message); }
  return { obj, sha256: hash(guarded.bytes), path: file };
}
function validatePolicy(p) {
  fields(p, ['schema', 'source', 'manifestOwned', 'taskPolicy', 'roleFloors', 'roleBindings', 'loadingProfiles', 'selection'], 'selection-policy/1 fields');
  if (!Array.isArray(p.manifestOwned) || !p.manifestOwned.every(s => typeof s === 'string' && s === s.toLowerCase() && /^[a-z0-9._/-]+$/.test(s)) || new Set(p.manifestOwned).size !== p.manifestOwned.length) fail('policy-schema', 'manifestOwned');
  if (p.schema !== 'selection-policy/1' || typeof p.source !== 'string' || !p.source.trim()) fail('policy-schema', 'expected selection-policy/1 and source');
  const t = p.taskPolicy;
  fields(t, ['reason', 'riskFloor', 'failedRounds', 'splitTier', 'defects', 'unknownTier', 'discoveryTier', 'verification', 'coupling', 'importantTier', 'designTier', 'factors', 'sumTiers', 'hardFloors', 'pathFloors', 'rubric'], 'taskPolicy fields');
  fields(t.rubric, ['factors', 'basis', 'reviewOnly'], 'rubric');
  fields(t.rubric.factors, FACTORS, 'rubric factors');
  const prose = s => typeof s === 'string' && s.trim().length > 0;
  if (![t.rubric.basis, t.rubric.reviewOnly].every(prose)) fail('policy-schema', 'rubric basis');
  for (const f of FACTORS) {
    const row = t.rubric.factors[f];
    fields(row, ['label', 'scores'], `rubric.${f}`);
    if (!prose(row.label) || !Array.isArray(row.scores) || row.scores.length !== 3 || !row.scores.every(prose)) fail('policy-schema', 'rubric scale');
  }
  fields(t.pathFloors, ['A', 'B'], 'pathFloors');
  fields(t.riskFloor, ['A', 'B'], 'riskFloor names no floor for task class A or B');
  fields(t.hardFloors, ['certification', 'kernel', 'protected'], 'hardFloors');
  if (!Object.values(t.pathFloors).every(tier) || t.pathFloors.A < t.hardFloors.kernel) fail('policy-schema', 'path floors');
  for (const [key, floor] of Object.entries(MIN_FLOORS)) if (!tier(t.hardFloors[key]) || t.hardFloors[key] < floor) fail('policy-schema', `hardFloors.${key} below normative minimum`);
  fields(t.verification, ['light', 'targeted', 'heavy'], 'verification');
  if (JSON.stringify(t.factors) !== JSON.stringify(FACTORS) || !Array.isArray(t.sumTiers) || t.sumTiers.length !== 13 || !t.sumTiers.every(tier)) fail('policy-schema', 'factor/sum scale');
  for (const n of [...Object.values(t.riskFloor), ...Object.values(t.hardFloors), ...Object.values(t.verification), t.splitTier, t.unknownTier, t.discoveryTier, t.importantTier, t.designTier]) if (!tier(n)) fail('policy-schema', 'integer floor T1-T9 required');
  for (const k of ['failedRounds', 'defects', 'coupling']) {
    if (!Array.isArray(t[k]) || !t[k].every((r, i) => Array.isArray(r) && r.length === 2 && integer(r[0], 0, 10000) && tier(r[1]) && (!i || r[0] > t[k][i - 1][0]))) fail('policy-schema', k);
  }
  fields(p.roleFloors, ['author', 'certifier-strong', 'certifier-medium', 'pre-review'], 'roleFloors');
  for (const [name, r] of Object.entries(p.roleFloors)) {
    fields(r, name === 'author' ? ['excludeFamilies', 'admitTierUnknown'] : ['tierFloor', 'excludeFamilies', 'admitTierUnknown'], `roles.${name}`);
    if (name !== 'author') {
      fields(r.tierFloor, ['A', 'B'], 'tierFloor must give every task class');
      if (!Object.values(r.tierFloor).every(tier)) fail('policy-schema', 'integer floor T1-T9');
    }
    if (!Array.isArray(r.excludeFamilies) || !r.excludeFamilies.every(s => typeof s === 'string') || new Set(r.excludeFamilies).size !== r.excludeFamilies.length || typeof r.admitTierUnknown !== 'boolean') fail('policy-schema', `roles.${name}`);
  }
  fields(p.roleBindings, SLOTS, 'all L1 roles must be bound');
  fields(p.loadingProfiles, ['teamRules', 'roles'], 'loadingProfiles');
  fields(p.loadingProfiles.roles, SLOTS, 'all profiles must be bound');
  if (!Array.isArray(p.loadingProfiles.teamRules) || !p.loadingProfiles.teamRules.every(s => /^R-L0-\d+$/.test(s)) || new Set(p.loadingProfiles.teamRules).size !== p.loadingProfiles.teamRules.length) fail('policy-schema', 'teamRules');
  for (const slot of SLOTS) {
    const binding = p.roleBindings[slot];
    const valid = slot === 'owner' ? binding === null : slot === 'certifier' ? Array.isArray(binding) && JSON.stringify(binding) === '["certifier-strong","certifier-medium"]' : typeof binding === 'string' && Object.hasOwn(p.roleFloors, binding);
    if (!valid) fail('policy-schema', `roleBindings.${slot}`);
    const levels = p.loadingProfiles.roles[slot];
    if (!Array.isArray(levels) || levels.length !== 9 || !levels.every(n => integer(n, 1, 4))) fail('policy-schema', `loadingProfiles.${slot}`);
  }
  fields(p.selection, ['topCost', 'routeMaxAgeMs', 'dailyCeilings', 'topModel', 'singleSeat', 'reviewExcludedMakers', 'reviewReason'], 'selection');
  const s = p.selection;
  fields(s.topCost, ['models', 'reason'], 'topCost');
  fields(s.dailyCeilings, ['cash', 'vibe', 'reserveFraction', 'reason'], 'dailyCeilings');
  fields(s.topModel, ['modelIds', 'minTier', 'minFailedRounds', 'forbiddenKinds', 'reason'], 'topModel');
  fields(s.singleSeat, ['modelPrefix', 'clients', 'reason'], 'singleSeat');
  for (const a of [s.topCost.models, s.topModel.modelIds, s.topModel.forbiddenKinds, s.singleSeat.clients, s.reviewExcludedMakers]) if (!Array.isArray(a) || !a.every(v => typeof v === 'string' && v.length > 0)) fail('policy-schema', 'selection arrays');
  for (const v of [t.reason, s.topCost.reason, s.dailyCeilings.reason, s.topModel.reason, s.singleSeat.reason, s.singleSeat.modelPrefix, s.reviewReason]) if (typeof v !== 'string' || !v.trim()) fail('policy-schema', 'selection text');
  if (!integer(s.routeMaxAgeMs, 1, Number.MAX_SAFE_INTEGER) || !tier(s.topModel.minTier) || !integer(s.topModel.minFailedRounds, 0, 10000)) fail('policy-schema', 'selection numbers');
  for (const v of [s.dailyCeilings.cash, s.dailyCeilings.vibe, s.dailyCeilings.reserveFraction]) if (typeof v !== 'string' || !/^(0|[1-9]\d*)(\.\d+)?$/.test(v)) fail('policy-schema', 'selection money');
  return p;
}
function loadPolicy(file = DEFAULT) { const doc = readInput(file, 'policy'); validatePolicy(doc.obj); return doc; }
function validatePolicySource(doc, fixtureDir = null) {
  const file = path.resolve(doc.path);
  if (fixtureDir !== null) {
    const relative = path.relative(path.resolve(fixtureDir), file);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) fail('policy-source', 'policy outside explicit test fixture directory');
  } else if (file !== DEFAULT || doc.sha256 !== CANONICAL_SHA256) fail('policy-source', 'canonical policy path and byte hash required; fixtures need --test-policy-dir DIR');
  return doc;
}
function assignPolicy(p) { return { schema: 'assign-policy/2', ...p.taskPolicy, ...p.selection }; }
module.exports = { readInput, loadPolicy, validatePolicy, validatePolicySource, assignPolicy, hash, Refusal, DEFAULT, CANONICAL_SHA256, MIN_FLOORS, FACTORS, SLOTS };

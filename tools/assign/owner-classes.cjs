'use strict';
// The owner's first classes of automatic assignment: read-only tasks, child tasks of a decomposition in a host
// project outside the kernel paths, and readers and certifiers of low risk. A launch belongs to a class only by
// facts it already carries: the explicit role, the computed criticality and tier, the risk rules of its declared
// or observed paths, the closed unknown flags of the frame, the descriptor fields of the task file and the role of
// the repository; never by a reading of the task prose. The declaration is data (docs/ops/assign-owner-classes.json)
// and is OFF until an owner act turns it on; off, it changes nothing. An author round on a kernel path is class A
// and is never in a class.
const fs = require('node:fs');
const path = require('node:path');
const { parseJsonUnique } = require('../../.ai/bin/lib/text-safe.cjs');
const policyApi = require('./selection-policy.cjs');
const { killcheck } = require('./assign-killcheck.cjs');

const REPO = path.resolve(__dirname, '../..');
const DECLARATION = 'docs/ops/assign-owner-classes.json';
const IDS = ['read-only', 'host-child', 'low-risk-reader'];
// Facts a frame may carry and still be recognised: the scope came from the task's own declaration, and a first
// launch has no review history yet. Any other flag (an inferred rubric, scope or role, an unknown score) refuses.
const ALLOWED_UNKNOWN = ['scope-from-task-declaration', 'history-unknown'];
// Read-only work writes only documents, data under docs and its own session record.
const READ_ONLY_RULES = ['RC-B01-session-record', 'RC-B04-document', 'RC-B05-docs-data'];
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,79}$/;
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);

function validate(doc) {
  const keys = ['schema', 'enabled', 'ownerAct', 'classes', 'note'];
  if (!plain(doc) || Object.keys(doc).length !== keys.length || keys.some(k => !Object.hasOwn(doc, k))
      || doc.schema !== 'assign-owner-classes/1' || typeof doc.enabled !== 'boolean' || typeof doc.note !== 'string'
      || !(doc.ownerAct === null || typeof doc.ownerAct === 'string' && /^PROTO-DEC-[0-9]{4}$/.test(doc.ownerAct))
      || !Array.isArray(doc.classes) || !doc.classes.every(c => IDS.includes(c)) || new Set(doc.classes).size !== doc.classes.length) {
    throw new Error('owner-classes-invalid');
  }
  return doc;
}

// Off unless the declaration is valid, enabled and names the owner act; a missing or broken file is off.
function read(file = path.join(REPO, DECLARATION)) {
  try {
    const doc = validate(parseJsonUnique(fs.readFileSync(file, 'utf8')));
    if (!doc.enabled) return { on: false, reason: 'owner-classes-off', classes: [] };
    if (doc.ownerAct === null) return { on: false, reason: 'owner-act-missing', classes: [] };
    return { on: true, reason: 'owner-classes-declared', classes: doc.classes, ownerAct: doc.ownerAct };
  } catch { return { on: false, reason: 'owner-classes-missing-or-invalid', classes: [] }; }
}

function lineageDeclared(descriptor) {
  if (descriptor?.independence !== undefined) return plain(descriptor.independence) && Array.isArray(descriptor.independence.lineage) && descriptor.independence.lineage.length > 0;
  const l = descriptor?.lineage;
  return plain(l) && ['author', 'fixer', 'preReviewer', 'operator', 'certifiers'].every(k => Array.isArray(l[k])) && l.author.length + l.fixer.length > 0;
}

function decompositionDeclared(descriptor) {
  const d = descriptor?.decomposition;
  return plain(d) && Object.keys(d).length === 2 && ID.test(d.parentId || '') && ID.test(d.childId || '') && d.parentId !== d.childId;
}

// The classes a launch belongs to, each with the facts that put it there; an empty list with the refusal otherwise.
function recognise(frame, facts = {}) {
  const tier = Number(/^T([1-9])$/.exec(frame?.tier || '')?.[1]);
  const common = [];
  if (!frame || frame.riskKnown !== true) common.push('risk-unknown');
  if (frame?.riskClass !== 'B') common.push('criticality-not-low');
  if (!(frame?.pathCount > 0)) common.push('scope-unknown');
  if (!Array.isArray(frame?.riskRules) || !frame.riskRules.length || frame.riskRules.some(r => !/^RC-B[0-9]{2}-/.test(r))) common.push('protected-path');
  if (!Array.isArray(frame?.unknown) || frame.unknown.some(f => !ALLOWED_UNKNOWN.includes(f))) common.push('frame-facts-unknown');
  if (!policyApi.FACTORS.every(k => Number.isInteger(frame?.complexity?.[k]))) common.push('task-factors-unknown');
  if (!(tier >= 1 && tier <= 7)) common.push('tier-out-of-range');
  if (common.length) return { classes: [], reasons: common };
  const out = [], reasons = [];
  if (['reviewer', 'researcher', 'critic'].includes(frame.role)) {
    if (frame.riskRules.every(r => READ_ONLY_RULES.includes(r))) out.push('read-only'); else reasons.push('read-only:writes-outside-documents');
  }
  if (['implementer', 'fixer'].includes(frame.role)) {
    if (facts.repositoryRole !== 'installed') reasons.push('host-child:kernel-repository');
    else if (!decompositionDeclared(facts.descriptor)) reasons.push('host-child:no-decomposition-record');
    else out.push('host-child');
  }
  if (['certifier', 'reviewer'].includes(frame.role)) {
    if (lineageDeclared(facts.descriptor)) out.push('low-risk-reader'); else reasons.push('low-risk-reader:lineage-unknown');
  }
  if (!out.length && !reasons.length) reasons.push('role-not-in-a-class');
  return { classes: out, reasons };
}

// What the selection does for a recognised launch when the declaration is on: the class takes the place of the
// task-class list of the host mode, and every other gate of the eligibility still applies; a paid route never
// takes part (separate owner permission) and a class demoted back to advice stays with the operator.
function admit(declaration, frame, facts = {}, state = {}) {
  if (!declaration?.on) return { ownerClass: null, reason: declaration?.reason || 'owner-classes-off' };
  const r = recognise(frame, facts);
  const enabled = r.classes.filter(c => declaration.classes.includes(c));
  if (!enabled.length) return { ownerClass: null, reason: r.reasons[0] || 'owner-class-not-enabled' };
  const live = enabled.filter(c => !Object.hasOwn(state.demoted || {}, `owner:${c}`));
  if (!live.length) return { ownerClass: null, reason: 'owner-class-demoted' };
  if (state.hold) return { ownerClass: null, reason: 'assign-hold' };
  return { ownerClass: live[0], reason: 'owner-class-recognised' };
}

// The automatic return to advice: the kill criterion of the host mode on the runs of one owner class against the
// operator's own choices on the same class, under the class key owner:<id>.
function returnToAdvice(classId, input, policy, now) {
  const key = `owner:${classId}`;
  const runs = (input.runs || []).filter(r => r.ownerClass === classId).map(r => ({ ...r, taskClass: key }));
  const baseline = (input.baseline || []).filter(b => b.ownerClass === classId).map(b => ({ ...b, taskClass: key }));
  return killcheck({ ...input, runs, baseline }, policy, now);
}

module.exports = { DECLARATION, IDS, ALLOWED_UNKNOWN, validate, read, recognise, admit, returnToAdvice };

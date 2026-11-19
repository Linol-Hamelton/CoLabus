'use strict';
// decompose.cjs - the decomposition record decomposition/1: its validator, its contract hash and the renderer of a
// child task file and child task frame. Rule ids TD-nn are those of the task decomposition specification.
//
// validate(record, facts)     -> { ok, refusals: [{ code, where, detail }], unknowns: [where], contractHash }
// factsProblem(facts)         -> why the facts are malformed, or null
// validateText(text, facts)   -> the same, from the record text (a repeated key is DUPLICATE_KEY, never last-wins)
// contractHash(record)        -> sha256 hex of the canonical contract projection (TD-30)
// render(record, childId, facts) -> { ok: true, task, frame, taskPath, framePath } | { ok: false, refusals }
//
// Pure: no file system, no clock, no environment, no child process. Everything about the tree comes in `facts`; the one
// other input is the family fold of the kernel (.ai/bin/lib/model-identity.cjs), whose data ships with the tool like its
// code. The facts the caller reads from the git objects of one base commit (the CLI .ai/bin/protocol-decompose.cjs). The same record and
// the same facts give the same bytes. A refusal is a value, never an exception; a malformed `facts` object is a
// programming error and throws a TypeError.
const crypto = require('node:crypto');
const textSafe = require('./text-safe.cjs');
const pathSafe = require('./path-safe.cjs');
const protectedPaths = require('./protected-paths.cjs');
const taskLint = require('./task-lint.cjs');

const SCHEMA_ID = 'decomposition/1';
// The closed list of refusals, in the order a report lists them (TD-10).
const CODES = Object.freeze(['SCHEMA', 'DUPLICATE_KEY', 'PATH_UNSAFE', 'DEPTH', 'CHILD_COUNT', 'COVERAGE_GAP',
  'SCOPE_ESCAPE', 'SCOPE_OVERLAP', 'DANGLING_DEP', 'CYCLE', 'UNVERIFIABLE_ACCEPTANCE', 'MARKER', 'BASELINE_DRIFT',
  'AUTHOR_FLOOR', 'ROLE_FORBIDDEN', 'FAMILY', 'RUNNING_LIMIT', 'COUNTER', 'UNKNOWN_AS_VALUE', 'DUPLICATE_RECORD']);
// Owner limits of the first version: depth 1, at most 8 children, at most 4 running at once (TD-14, TD-15, TD-27).
const MAX_CHILDREN = 8;
const MIN_CHILDREN = 2;
const MAX_RUNNING = 4;
const MAX_RAISES = 32;
const CHILD_STATES = Object.freeze(['planned', 'ready', 'running', 'submitted', 'accepted', 'rejected', 'integrated']);
const PARENT_STATES = Object.freeze(['planned', 'integrating', 'assembled', 'certified', 'landed', 'activated']);
// A child past these states has an author at work or done: its families must be known (TD-26).
const STAFFED_CHILD = new Set(['running', 'submitted', 'accepted', 'rejected', 'integrated']);
const STAFFED_PARENT = new Set(['integrating', 'assembled', 'certified', 'landed', 'activated']);
const ROLES = Object.freeze(['change', 'collect', 'verdict']);
const WORK_CLASSES = Object.freeze(['kernel', 'protected', 'outside', 'mechanical']);
const ROUTES = Object.freeze(['subscription', 'api', 'free']);
const FACTORS = Object.freeze(['protectedPaths', 'novelty', 'reversibility', 'ambiguity', 'coupling', 'independentJudgement']);
const DECOMPOSITIONS_DIR = 'docs/ops/decompositions/';

const ID = /^[a-z0-9][a-z0-9-]{2,47}$/;
const PACKAGE = /^[A-Z0-9][A-Z0-9._-]{1,63}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._:/-]{1,127}$/;
const REQ = /^[A-Z][A-Z0-9-]{0,31}$/;
const FAMILY = /^[a-z][a-z0-9-]{1,31}$/;
const TIER = /^T[1-9]$/;
const SHA1 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const PATH_CHARS = /^[A-Za-z0-9._/-]+$/;
// An end marker inside a longer value: a run of marker characters ending in _DONE that no further name character follows.
const END_MARKER_RUN = /[A-Z0-9][A-Z0-9_.-]*_DONE(?![A-Za-z0-9_-])/;
const SESSION = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const CAUSE = /^[A-Z][A-Z0-9_-]{1,31}$/;
// The ledger of a record: what happened to it, in order, append only (TD-52). Each entry is closed to its own fields.
const LEDGER_FIELDS = Object.freeze({
  ready: ['type', 'revision', 'contract', 'child', 'pins'],
  start: ['type', 'revision', 'contract', 'child', 'attempt', 'paths'],
  result: ['type', 'revision', 'contract', 'child', 'attempt', 'hash', 'author', 'start', 'commit', 'tree', 'changed', 'outputs'],
  accept: ['type', 'revision', 'contract', 'child', 'result', 'hash', 'reviewer', 'verdict'],
  reject: ['type', 'revision', 'contract', 'child', 'result', 'hash', 'reviewer', 'verdict', 'cause'],
  integrate: ['type', 'revision', 'contract'],
  assemble: ['type', 'revision', 'contract', 'hash', 'integrator', 'head', 'tree'],
  lost: ['type', 'revision', 'contract', 'child', 'attempt', 'seat', 'cause'],
});
// Fields an entry may carry beyond its own list: the digest of the environment of the run, when the tool reran the
// commands; the seat and the route of a start made through the kernel launch entry (TD-85).
const LEDGER_OPTIONAL = Object.freeze({ accept: ['environment'], reject: ['environment'], start: ['seat', 'route'] });
// The seat of a child (its launch name and stream) and a route client:model[:effort] (TD-84, TD-85).
const SEAT = /^[a-z0-9][a-z0-9-]{2,63}$/;
const ROUTE = /^[a-z][a-z0-9-]{0,31}:[A-Za-z0-9][A-Za-z0-9._/-]{0,127}(?::[a-z0-9-]{1,16})?$/;
// Why a seat ended its attempt without a result (TD-87).
const LOST_CAUSES = Object.freeze(['SEAT_NO_MARKER']);
const MAX_LEDGER = 4096;
const COMMAND = /^node(?: [A-Za-z0-9._/=:-]+)+$/;
// Option names that load or evaluate code (node and its test runner); never a word of an acceptance command (TD-07).
const CODE_OPTION = /^(?:-[repC]|--require|--import|--loader|--eval|--print|--conditions|--input-type|--snapshot-blob|--build-snapshot|--policy-integrity|--experimental-[a-z-]*|--env-file[a-z-]*|--test-reporter[a-z-]*|--inspect[a-z-]*|--watch[a-z-]*)$/;
const SCRIPT_FILE = /\.(?:[cm]?[jt]sx?|node|wasm)$/i;
const MAX_PATH = 240;
const MAX_TEXT = 400;
const MAX_COMMAND = 300;
// Placeholders that stand for a value nobody knows; in a field that may be unknown they are refused (TD-29).
const PLACEHOLDERS = new Set(['', 'unknown', 'n/a', 'na', 'none', 'null', 'tbd', '-', '?', 'todo']);

const sha256 = text => crypto.createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
const fold = p => p.toLowerCase();
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const tierNumber = t => Number(t.slice(1));

// ---------- facts ----------

function checkFacts(facts) {
  const bad = what => { throw new TypeError(`decompose facts: ${what}`); };
  if (!isObject(facts)) bad('an object is required');
  if (typeof facts.base !== 'string' || !SHA1.test(facts.base)) bad('base is a full commit id');
  if (!isObject(facts.files)) bad('files maps a path to blob, exec, link or gitlink');
  for (const [p, kind] of Object.entries(facts.files)) if (!['blob', 'exec', 'link', 'gitlink'].includes(kind)) bad(`files: ${p}`);
  for (const key of ['kernel', 'protected']) {
    const set = facts[key];
    if (!isObject(set) || !Array.isArray(set.prefixes) || !Array.isArray(set.paths)) bad(`${key} has prefixes and paths`);
  }
  const policy = facts.policy;
  if (!isObject(policy) || !Array.isArray(policy.sumTiers) || policy.sumTiers.length !== FACTORS.length * 2 + 1
    || !policy.sumTiers.every(n => Number.isInteger(n) && n >= 1 && n <= 9)) bad('policy.sumTiers maps 0..12 to tiers 1..9');
  if (!isObject(policy.floors) || ![policy.floors.kernel, policy.floors.protected].every(n => Number.isInteger(n) && n >= 1 && n <= 9)) bad('policy.floors has kernel and protected tiers');
  if (!Array.isArray(facts.protectedNames) || !facts.protectedNames.every(n => typeof n === 'string' && n)) bad('protectedNames is a list of names');
  if (!Array.isArray(facts.records)) bad('records is a list');
  if (facts.recordPath !== null && facts.recordPath !== undefined && typeof facts.recordPath !== 'string') bad('recordPath is a path or null');
}

// Why the facts cannot be read, or null: the caller that reads them from a base commit names it as damaged facts.
function factsProblem(facts) {
  try { checkFacts(facts); return null; } catch (e) {
    if (e instanceof TypeError && e.message.startsWith('decompose facts: ')) return e.message.slice('decompose facts: '.length);
    throw e;
  }
}

// One index of the facts per call: folded file kinds, links and the kernel and protected sets.
function indexFacts(facts) {
  const kinds = new Map();
  for (const [p, kind] of Object.entries(facts.files)) kinds.set(fold(p), kind);
  const links = [...kinds].filter(([, kind]) => kind === 'link' || kind === 'gitlink').map(([p]) => p);
  const set = s => ({ prefixes: s.prefixes.map(fold), paths: new Set(s.paths.map(fold)) });
  return { kinds, links: new Set(links), kernel: set(facts.kernel), protected: set(facts.protected), names: facts.protectedNames.map(fold) };
}

// ---------- shape (SCHEMA, UNKNOWN_AS_VALUE, DEPTH) ----------

function textProblem(value, { item = false } = {}) {
  if (typeof value !== 'string') return 'is not text';
  if (value.length < 1 || value.length > MAX_TEXT) return `holds 1 to ${MAX_TEXT} characters`;
  if (value !== value.trim()) return 'starts or ends with a space';
  if (/[\u0000-\u001f\u007f]/.test(value)) return 'holds a control character';
  // The rendered task passes task lint and the frame parser: no angle bracket, entity, code span, escape, list bracket.
  if (/[<>`\\&^[\]]/.test(value)) return 'holds one of < > ` \\ & ^ [ ]';
  if ([...value].some(ch => textSafe.isIgnorableFormat(ch))) return 'holds an invisible format character';
  if (!/[\p{L}\p{N}]/u.test(value)) return 'holds no letter or digit';
  if (item && value.includes(',')) return 'is a list item and holds a comma';
  return endShapeProblem(value);
}

// The rendered task holds one footer and one marker line by construction: no value renders in a line shaped like either,
// whichever field it comes from (a text, a path, a command, a name). A path is one item of a "- path" line, so a bare
// upper case name such as LICENSE is no marker; the value that is a whole line is `whole`.
function endShapeProblem(value, { whole = true } = {}) {
  if (/task-end/i.test(value)) return 'holds the footer word Task-End';
  if (whole && taskLint.TOKEN_PATTERN.test(value)) return 'is shaped like an end marker';
  if (END_MARKER_RUN.test(value)) return 'holds an end marker';
  return null;
}

// The first line of a rendered file, other than the two end lines it is allowed to hold, that is shaped like the footer
// or an end marker; the check that stands behind every field, so no value reaches a line unchecked.
function endLineProblem(lines) {
  for (const [i, line] of lines.entries()) {
    const why = endShapeProblem(line);
    if (why) return `line ${i + 1} ${why}`;
  }
  return null;
}

// A value that may be unknown: the value itself, or { value: null, reason } (TD-29).
function isUnknown(v) { return isObject(v) && Object.hasOwn(v, 'value') && v.value === null; }
function placeholder(v) {
  if (v === null || v === undefined || v === false || v === 0) return true;
  if (typeof v === 'string' && PLACEHOLDERS.has(v.trim().toLowerCase())) return true;
  if (Array.isArray(v) && v.length === 0) return true;
  if (isObject(v) && Object.keys(v).length === 0) return true;
  return false;
}

// The family of a name: the family fold of the kernel (the maker of the model by its closed maker rules), or null when
// the fold does not know the name. Every spelling of one maker is one family; an unknown name is no family at all (TD-82).
let kernelFold = null;
function kernelFamily(name) {
  if (!kernelFold) kernelFold = require('./model-identity.cjs').declaredFamily;
  const family = kernelFold(name);
  return typeof family === 'string' && family !== 'UNKNOWN' ? family : null;
}
function familyTable(record, foldFamily = kernelFamily) {
  return name => (typeof name === 'string' ? foldFamily(name) : null);
}

class Report {
  constructor() { this.refusals = []; this.unknowns = []; }
  add(code, where, detail) { this.refusals.push({ code, where, detail }); }
  has(...codes) { return this.refusals.some(r => codes.includes(r.code)); }
}

function shape(record, r) {
  const schema = (where, detail) => r.add('SCHEMA', where, detail);
  const keys = (obj, where, allowed, required = allowed) => {
    if (!isObject(obj)) { schema(where, 'is not an object'); return false; }
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) schema(`${where}.${k}`, 'is not a field of decomposition/1');
    for (const k of required) if (!Object.hasOwn(obj, k)) schema(`${where}.${k}`, 'is missing');
    return true;
  };
  const text = (v, where, opts) => { const p = textProblem(v, opts); if (p) schema(where, p); };
  const match = (v, re, where, what) => { if (typeof v !== 'string' || !re.test(v)) schema(where, `is not ${what}`); };
  const int = (v, where, min, max) => { if (!Number.isInteger(v) || v < min || v > max) schema(where, `is not an integer ${min}..${max}`); };
  const list = (v, where, min, max, each, { unique = true } = {}) => {
    if (!Array.isArray(v)) { schema(where, 'is not a list'); return; }
    if (v.length < min || v.length > max) schema(where, `holds ${min} to ${max} entries`);
    v.forEach((x, i) => each(x, `${where}[${i}]`));
    if (unique) {
      const seen = new Set();
      for (const x of v) if (typeof x === 'string') { if (seen.has(fold(x))) schema(where, `holds ${JSON.stringify(x)} twice`); seen.add(fold(x)); }
    }
  };
  const pathEntry = (v, where) => {
    if (typeof v !== 'string') { schema(where, 'is not a path'); return; }
    const why = endShapeProblem(v, { whole: false });
    if (why) schema(where, why);
  };
  const filePath = (v, where) => { pathEntry(v, where); if (typeof v === 'string' && v.endsWith('/')) schema(where, 'is a directory prefix; only exact files are written'); };
  // A field that may hold an unknown value: either a proper value or { value: null, reason }; a placeholder is UNKNOWN_AS_VALUE.
  const maybe = (v, where, proper) => {
    if (isUnknown(v)) {
      if (Object.keys(v).some(k => k !== 'value' && k !== 'reason')) schema(where, 'an unknown value holds only value and reason');
      if (typeof v.reason !== 'string' || textProblem(v.reason) !== null) r.add('UNKNOWN_AS_VALUE', where, 'an unknown value needs a reason');
      else r.unknowns.push(where);
      return;
    }
    // An unknown value written with 0, false or an empty value in place of null is still an unknown taken as a value.
    if (isObject(v) && Object.hasOwn(v, 'value') && placeholder(v.value)) { r.add('UNKNOWN_AS_VALUE', where, 'an unknown value is { value: null, reason }; its value is never 0, false or empty'); return; }
    if (placeholder(v)) { r.add('UNKNOWN_AS_VALUE', where, 'a missing value is { value: null, reason }, never null, 0, false, an empty or placeholder value'); return; }
    proper(v, where);
  };
  const party = (v, where) => {
    if (!keys(v, where, ['family', 'routes'])) return;
    maybe(v.family, `${where}.family`, (x, w) => match(x, FAMILY, w, 'a family name'));
    list(v.routes, `${where}.routes`, 1, ROUTES.length, (x, w) => { if (!ROUTES.includes(x)) schema(w, `is not one of ${ROUTES.join(', ')}`); });
  };
  const command = (v, where) => {
    if (!keys(v, where, ['command', 'file'])) return;
    if (typeof v.command !== 'string') schema(`${where}.command`, 'is not text');
    else { const why = endShapeProblem(v.command, { whole: false }); if (why) schema(`${where}.command`, why); }
    filePath(v.file, `${where}.file`);
  };

  if (!keys(record, 'record', ['schema', 'revision', 'parent', 'children', 'assembly', 'ledger'], ['schema', 'revision', 'parent', 'children', 'assembly'])) return;
  if (record.schema !== SCHEMA_ID) schema('record.schema', `is not ${SCHEMA_ID}`);
  int(record.revision, 'record.revision', 1, 9999);

  const p = record.parent;
  if (keys(p, 'parent', ['id', 'package', 'coupledSet', 'ownerIntent', 'base', 'risk', 'certificationTier', 'requirements',
    'exclusions', 'scope', 'forbidden', 'budget', 'certifierFamilies', 'state', 'counters', 'contractHash'])) {
    match(p.id, ID, 'parent.id', 'an id');
    match(p.package, PACKAGE, 'parent.package', 'a package name');
    if (typeof p.package === 'string') { const why = endShapeProblem(p.package, { whole: false }); if (why) schema('parent.package', why); }
    maybe(p.coupledSet, 'parent.coupledSet', (x, w) => match(x, PACKAGE, w, 'a coupled set name'));
    match(p.ownerIntent, REF, 'parent.ownerIntent', 'a reference');
    if (typeof p.base !== 'string' || !SHA1.test(p.base)) schema('parent.base', 'is not a full commit id');
    if (p.risk !== 'A' && p.risk !== 'B') schema('parent.risk', 'is not A or B');
    int(p.certificationTier, 'parent.certificationTier', 0, 4);
    list(p.requirements, 'parent.requirements', 1, 64, (q, w) => {
      if (!keys(q, w, ['id', 'text', 'hash'])) return;
      match(q.id, REQ, `${w}.id`, 'a requirement id');
      text(q.text, `${w}.text`);
      if (typeof q.text === 'string' && q.hash !== sha256(q.text)) schema(`${w}.hash`, 'is not the sha256 of the text');
    }, { unique: false });
    if (Array.isArray(p.requirements)) {
      const ids = p.requirements.filter(isObject).map(q => q.id);
      if (new Set(ids).size !== ids.length) schema('parent.requirements', 'two requirements share one id');
    }
    list(p.exclusions, 'parent.exclusions', 0, 32, (x, w) => text(x, w, { item: true }));
    list(p.scope, 'parent.scope', 1, 256, pathEntry);
    list(p.forbidden, 'parent.forbidden', 0, 256, pathEntry);
    if (keys(p.budget, 'parent.budget', ['attempts', 'rounds', 'total', 'raises'])) {
      int(p.budget.attempts, 'parent.budget.attempts', 1, 99); int(p.budget.rounds, 'parent.budget.rounds', 1, 99);
      // The total of the parent and the raises of it, each with its revision, its reason and the owner approval (TD-83).
      if (keys(p.budget.total, 'parent.budget.total', ['attempts', 'rounds'])) { int(p.budget.total.attempts, 'parent.budget.total.attempts', 1, 999); int(p.budget.total.rounds, 'parent.budget.total.rounds', 1, 999); }
      list(p.budget.raises, 'parent.budget.raises', 0, MAX_RAISES, (x, w) => {
        if (!keys(x, w, ['revision', 'attempts', 'rounds', 'reason', 'approval'])) return;
        int(x.revision, `${w}.revision`, 2, 9999); int(x.attempts, `${w}.attempts`, 1, 999); int(x.rounds, `${w}.rounds`, 1, 999);
        text(x.reason, `${w}.reason`);
        match(x.approval, REF, `${w}.approval`, 'a reference');
      }, { unique: false });
    }
    maybe(p.certifierFamilies, 'parent.certifierFamilies', (x, w) => list(x, w, 1, 8, (f, fw) => match(f, FAMILY, fw, 'a family name')));
    if (!PARENT_STATES.includes(p.state)) schema('parent.state', `is not one of ${PARENT_STATES.join(', ')}`);
    if (keys(p.counters, 'parent.counters', ['attempts', 'rounds'])) { int(p.counters.attempts, 'parent.counters.attempts', 0, 9999); int(p.counters.rounds, 'parent.counters.rounds', 0, 9999); }
    if (typeof p.contractHash !== 'string' || !SHA256.test(p.contractHash)) schema('parent.contractHash', 'is not a sha256');
  }

  const children = record.children;
  if (!Array.isArray(children)) schema('children', 'is not a list');
  else {
    if (children.length < MIN_CHILDREN) schema('children', `a decomposition has at least ${MIN_CHILDREN} children`);
    // CHILD_COUNT is its own refusal: more than the owner limit is never a shape error (TD-15).
    if (children.length > MAX_CHILDREN) r.add('CHILD_COUNT', 'children', `${children.length} children; at most ${MAX_CHILDREN}`);
    children.forEach((c, i) => {
      const w = `children[${i}]`;
      if (!isObject(c)) { schema(w, 'is not an object'); return; }
      // A child that is split again is DEPTH, not an unknown field (TD-14).
      if (Object.hasOwn(c, 'children')) r.add('DEPTH', `${w}.children`, 'a child is never split again; depth is 1');
      const own = Object.fromEntries(Object.entries(c).filter(([k]) => k !== 'children'));
      const fields = ['id', 'goal', 'role', 'workClass', 'readSet', 'writeSet', 'forbidden', 'dependsOn', 'covers', 'acceptance',
        'complexity', 'author', 'reviewer', 'marker', 'state', 'counters'];
      if (!keys(own, w, [...fields, 'formerIds'], fields)) return;
      match(c.id, ID, `${w}.id`, 'an id');
      // A renamed child names the ids it carried before, so its lineage and its counters stay (TD-53).
      if (Object.hasOwn(c, 'formerIds')) {
        list(c.formerIds, `${w}.formerIds`, 1, MAX_CHILDREN, (x, xw) => match(x, ID, xw, 'an id'));
        if (Array.isArray(c.formerIds) && c.formerIds.includes(c.id)) schema(`${w}.formerIds`, 'names the id of the child itself');
      }
      text(c.goal, `${w}.goal`);
      if (!ROLES.includes(c.role)) schema(`${w}.role`, `is not one of ${ROLES.join(', ')}`);
      if (!WORK_CLASSES.includes(c.workClass)) schema(`${w}.workClass`, `is not one of ${WORK_CLASSES.join(', ')}`);
      list(c.readSet, `${w}.readSet`, 0, 256, pathEntry);
      list(c.writeSet, `${w}.writeSet`, 1, 256, filePath);
      list(c.forbidden, `${w}.forbidden`, 0, 512, pathEntry);
      list(c.dependsOn, `${w}.dependsOn`, 0, MAX_CHILDREN, (x, xw) => { if (typeof x !== 'string') schema(xw, 'is not an id'); });
      list(c.covers, `${w}.covers`, 0, 64, (x, xw) => match(x, REQ, xw, 'a requirement id'));
      if (keys(c.acceptance, `${w}.acceptance`, ['positive', 'negative'])) {
        list(c.acceptance.positive, `${w}.acceptance.positive`, 0, 8, command, { unique: false });
        list(c.acceptance.negative, `${w}.acceptance.negative`, 0, 8, command, { unique: false });
      }
      if (keys(c.complexity, `${w}.complexity`, FACTORS)) for (const f of FACTORS) int(c.complexity[f], `${w}.complexity.${f}`, 0, 2);
      if (keys(c.author, `${w}.author`, ['minTier', 'routes', 'family'])) {
        match(c.author.minTier, TIER, `${w}.author.minTier`, 'a tier T1..T9');
        party({ family: c.author.family, routes: c.author.routes }, `${w}.author`);
      }
      party(c.reviewer, `${w}.reviewer`);
      if (typeof c.marker !== 'string' || !taskLint.TOKEN_PATTERN.test(c.marker)) schema(`${w}.marker`, 'is not an end marker token');
      if (!CHILD_STATES.includes(c.state)) schema(`${w}.state`, `is not one of ${CHILD_STATES.join(', ')}`);
      if (keys(c.counters, `${w}.counters`, ['attempts', 'rounds'])) { int(c.counters.attempts, `${w}.counters.attempts`, 0, 9999); int(c.counters.rounds, `${w}.counters.rounds`, 0, 9999); }
    });
  }

  const a = record.assembly;
  if (keys(a, 'assembly', ['order', 'integrator', 'integratorPaths', 'checks'])) {
    list(a.order, 'assembly.order', 0, MAX_CHILDREN * 2, (x, w) => { if (typeof x !== 'string') schema(w, 'is not an id'); }, { unique: false });
    party(a.integrator, 'assembly.integrator');
    list(a.integratorPaths, 'assembly.integratorPaths', 0, 64, filePath);
    list(a.checks, 'assembly.checks', 0, 16, (k, w) => {
      if (!keys(k, w, ['id', 'command', 'file', 'covers'])) return;
      match(k.id, REQ, `${w}.id`, 'a check id');
      command({ command: k.command, file: k.file }, w);
      list(k.covers, `${w}.covers`, 0, 64, (x, xw) => match(x, REQ, xw, 'a requirement id'));
    }, { unique: false });
  }

  if (Object.hasOwn(record, 'ledger')) list(record.ledger, 'ledger', 0, MAX_LEDGER, (e, w) => ledgerEntry(e, w, { keys, match, int, list, schema }), { unique: false });
}

// One ledger entry: its type names its closed field list; every value is a fact the CLI wrote (TD-52).
function ledgerEntry(e, w, { keys, match, int, list, schema }) {
  if (!isObject(e) || !Object.hasOwn(LEDGER_FIELDS, e.type)) { schema(`${w}.type`, `is not one of ${Object.keys(LEDGER_FIELDS).join(', ')}`); return; }
  if (!keys(e, w, [...LEDGER_FIELDS[e.type], ...(LEDGER_OPTIONAL[e.type] || [])], LEDGER_FIELDS[e.type])) return;
  const sha1 = (v, x) => match(v, SHA1, `${w}.${x}`, 'a full commit or tree id');
  const sha2 = (v, x) => match(v, SHA256, `${w}.${x}`, 'a sha256');
  const pathOf = (v, x) => { if (typeof v !== 'string' || v.length > MAX_PATH || !PATH_CHARS.test(v)) schema(x, 'is not a repository path'); };
  int(e.revision, `${w}.revision`, 1, 9999);
  sha2(e.contract, 'contract');
  if (Object.hasOwn(e, 'child')) match(e.child, ID, `${w}.child`, 'an id');
  if (Object.hasOwn(e, 'attempt')) int(e.attempt, `${w}.attempt`, 1, 9999);
  if (Object.hasOwn(e, 'hash')) sha2(e.hash, 'hash');
  if (Object.hasOwn(e, 'result')) sha2(e.result, 'result');
  if (Object.hasOwn(e, 'environment')) sha2(e.environment, 'environment');
  for (const k of ['author', 'reviewer', 'integrator']) if (Object.hasOwn(e, k)) match(e[k], FAMILY, `${w}.${k}`, 'a family name');
  for (const k of ['start', 'commit', 'tree', 'head']) if (Object.hasOwn(e, k)) sha1(e[k], k);
  if (e.type === 'ready') list(e.pins, `${w}.pins`, 0, MAX_CHILDREN, (p, pw) => { if (keys(p, pw, ['child', 'result'])) { match(p.child, ID, `${pw}.child`, 'an id'); match(p.result, SHA256, `${pw}.result`, 'a sha256'); } });
  if (e.type === 'start') list(e.paths, `${w}.paths`, 1, 256, pathOf);
  if (Object.hasOwn(e, 'seat')) match(e.seat, SEAT, `${w}.seat`, 'a seat name');
  if (Object.hasOwn(e, 'route')) match(e.route, ROUTE, `${w}.route`, 'a route client:model[:effort]');
  if (e.type === 'lost' && !LOST_CAUSES.includes(e.cause)) schema(`${w}.cause`, `is not one of ${LOST_CAUSES.join(', ')}`);
  if (e.type === 'result') {
    list(e.changed, `${w}.changed`, 1, 1024, pathOf);
    list(e.outputs, `${w}.outputs`, 0, 1024, (o, ow) => { if (keys(o, ow, ['path', 'blob'])) { pathOf(o.path, `${ow}.path`); match(o.blob, SHA1, `${ow}.blob`, 'a blob id'); } }, { unique: false });
  }
  if (e.type === 'accept' && !['PASS', 'RECOMMENDATION'].includes(e.verdict)) schema(`${w}.verdict`, 'an acceptance is PASS or RECOMMENDATION');
  if (e.type === 'reject') {
    if (!['FAIL', 'BLOCKED'].includes(e.verdict)) schema(`${w}.verdict`, 'a rejection is FAIL or BLOCKED');
    match(e.cause, CAUSE, `${w}.cause`, 'a cause name');
  }
}

// ---------- paths (PATH_UNSAFE) ----------

// Every path of the record, with where it stands.
function allPaths(record) {
  const out = [];
  const take = (list, where) => { if (Array.isArray(list)) list.forEach((p, i) => out.push([p, `${where}[${i}]`])); };
  take(record.parent.scope, 'parent.scope');
  take(record.parent.forbidden, 'parent.forbidden');
  record.children.forEach((c, i) => {
    for (const k of ['readSet', 'writeSet', 'forbidden']) take(c[k], `children[${i}].${k}`);
    for (const k of ['positive', 'negative']) c.acceptance[k].forEach((x, j) => out.push([x.file, `children[${i}].acceptance.${k}[${j}].file`]));
  });
  take(record.assembly.integratorPaths, 'assembly.integratorPaths');
  record.assembly.checks.forEach((k, i) => out.push([k.file, `assembly.checks[${i}].file`]));
  return out;
}

// Why a repository path is unsafe, or null (TD-11): relative, forward slashes only, no dot or empty segment, the
// Windows name alphabet, no protected name, no link or submodule on the way.
function pathProblem(p, ix) {
  if (p.length > MAX_PATH) return `longer than ${MAX_PATH} characters`;
  if (/^[\\/]{2}/.test(p)) return 'a UNC or device path';
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return 'an absolute path';
  if (p.includes('\\')) return 'a backslash; paths use forward slashes';
  if (!PATH_CHARS.test(p)) return 'a character outside A-Z a-z 0-9 . _ / -';
  const segs = (p.endsWith('/') ? p.slice(0, -1) : p).split('/');
  for (const seg of segs) {
    const problem = pathSafe.segmentProblem(seg);
    if (problem) return `${problem[0]}: ${problem[1]}`;
  }
  if (ix.names.length && protectedPaths.hasProtectedName(p, { names: ix.names, mode: 'any' })) return 'names a protected location of the host';
  for (let k = 1; k <= segs.length; k++) {
    const prefix = fold(segs.slice(0, k).join('/'));
    if (ix.links.has(prefix)) return `${segs.slice(0, k).join('/')} is a link or a submodule at the base commit`;
  }
  return null;
}

// ---------- scope helpers ----------

// An entry ending in "/" is a directory prefix; any other entry is one exact path. Comparison folds case (TD-18).
function covers(entry, p) {
  const e = fold(entry); const q = fold(p);
  return e.endsWith('/') ? q.startsWith(e) || q === e.slice(0, -1) : q === e;
}
function touches(a, b) { return covers(a, b) || covers(b, a); }
// Two exact paths clash when they are one path, or when one is a folder on the way to the other (a file and a folder
// of one name cannot both be written), compared in both directions after folding case (TD-18).
function clash(a, b) { const x = fold(a); const y = fold(b); return x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`); }
function inSet(set, p) {
  const q = fold(p);
  return set.paths.has(q) || set.prefixes.some(pre => q.startsWith(pre));
}
// The class the files of a child demand: kernel above protected above the rest (TD-23).
function derivedClass(child, ix) {
  if (child.writeSet.some(p => inSet(ix.kernel, p))) return 'kernel';
  if (child.writeSet.some(p => inSet(ix.protected, p))) return 'protected';
  return 'outside';
}
const CLASS_RANK = { outside: 0, mechanical: 0, protected: 1, kernel: 2 };
// The work class of a child as its task file states it: the class its files demand, or the declared class when that is
// stricter (TD-23). The launch seam applies the route rule to this class (TD-86).
function workClassOf(child, facts) {
  const derived = derivedClass(child, indexFacts(facts));
  return CLASS_RANK[derived] >= CLASS_RANK[child.workClass] ? derived : child.workClass;
}

// The end marker of a child, derived from the two ids: "." never occurs in an id, so the map is one to one (TD-21).
function markerOf(parentId, childId) { return `${parentId}.${childId}_DONE`.toUpperCase(); }
// The seat of a child: its launch name and its stream. The launch entry derives the end marker of a seat from its name,
// so the seat carries its own marker; the ledger start entry binds the seat to the child (TD-84).
function seatOf(parentId, childId) { return `${parentId}-${childId}`; }

// ---------- graph ----------

function graphOf(children) {
  const ids = children.map(c => c.id);
  const edges = new Map(ids.map(id => [id, []]));
  for (const c of children) for (const d of c.dependsOn) if (edges.has(d) && d !== c.id) edges.get(c.id).push(d);
  return { ids, edges };
}
function findCycle({ ids, edges }) {
  const state = new Map();
  const visit = (id, trail) => {
    state.set(id, 1);
    for (const d of edges.get(id)) {
      if (state.get(d) === 1) return [...trail.slice(trail.indexOf(d)), d];
      if (!state.has(d)) { const found = visit(d, [...trail, d]); if (found) return found; }
    }
    state.set(id, 2);
    return null;
  };
  for (const id of [...ids].sort()) if (!state.has(id)) { const found = visit(id, [id]); if (found) return found; }
  return null;
}
function reachable({ edges }, from, to) {
  const seen = new Set(); const stack = [from];
  while (stack.length) {
    const id = stack.pop();
    if (id === to) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    stack.push(...(edges.get(id) || []));
  }
  return false;
}

// ---------- contract hash ----------

function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (isObject(v)) return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
const omit = (obj, names) => Object.fromEntries(Object.entries(obj).filter(([k]) => !names.includes(k)));
// The contract is what a child is asked to do. Revision, states, counters, the hash itself and the families named for
// the work are not part of it: assigning a family or counting an attempt never changes the contract (TD-30).
function contractProjection(record) {
  return {
    schema: record.schema,
    parent: omit(record.parent, ['state', 'counters', 'contractHash', 'certifierFamilies']),
    children: record.children.map(c => ({ ...omit(c, ['state', 'counters', 'author', 'reviewer']),
      author: omit(c.author, ['family']), reviewer: omit(c.reviewer, ['family']) })),
    assembly: { ...omit(record.assembly, ['integrator']), integrator: omit(record.assembly.integrator, ['family']) },
  };
}
function contractHash(record) { return sha256(`${SCHEMA_ID}\n${canonical(contractProjection(record))}`); }

// ---------- semantic checks ----------

// The words of an acceptance command: node [--test] FILE [ARGUMENT ...], or null when it is not of that form.
function commandWords(command) {
  const words = command.split(' ');
  const test = words[1] === '--test';
  return { test, file: words[test ? 2 : 1], args: words.slice(test ? 3 : 2) };
}
// The check a command runs, whatever its spelling: the file (case folded) and its arguments; --test does not change it.
function commandKey(command) { const w = commandWords(command); return [fold(w.file || ''), ...w.args].join(' '); }

// Every word is checked (TD-07): node runs exactly one script, the file of the record, a file of the base commit. Only
// one --test may stand before it and then nothing after it (each later word would be another test entry file); with
// plain node the later words are arguments of the script, never a script file, a path leaving the tree or an option
// that loads or evaluates code.
function commandProblem(x, ix) {
  if (x.command.length > MAX_COMMAND || !COMMAND.test(x.command)) return 'is not one node command of ASCII words (letters, digits and . _ / = : -)';
  const w = commandWords(x.command);
  if (w.file !== x.file) return `does not run its file ${x.file} as the script of node`;
  const kind = ix.kinds.get(fold(x.file));
  if (kind !== 'blob' && kind !== 'exec') return `its file ${x.file} is not a file at the base commit`;
  if (w.test && w.args.length) return `node --test runs every later word as another test file; ${w.args[0]} stands after ${x.file}`;
  for (const word of w.args) {
    const [name, ...rest] = word.split('=');
    for (const part of [word, ...(rest.length ? [rest.join('=')] : [])]) {
      if (part.startsWith('/') || /^[A-Za-z]:/.test(part) || part.split('/').includes('..')) return `the word ${word} leaves the tree`;
      if (SCRIPT_FILE.test(part)) return `the word ${word} names another script file`;
    }
    if (CODE_OPTION.test(name)) return `the word ${word} is an option that loads or evaluates code`;
  }
  return null;
}

function semantics(record, facts, ix, r) {
  const p = record.parent;
  const children = record.children;
  const ids = children.map(c => c.id);
  const childIds = new Set(ids);

  // PATH_UNSAFE: every path of the record, before any scope comparison.
  for (const [value, where] of allPaths(record)) {
    const problem = pathProblem(value, ix);
    if (problem) r.add('PATH_UNSAFE', where, problem);
  }
  const pathsSafe = !r.has('PATH_UNSAFE');

  // DEPTH: the parent is not itself a child, and no child is a parent, of another record (TD-14).
  for (const other of facts.records) {
    if (other.unreadable) continue;
    if (Array.isArray(other.childIds) && other.childIds.includes(p.id)) r.add('DEPTH', 'parent.id', `the parent is a child of ${other.path}`);
    children.forEach((c, i) => { if (other.parentId === c.id) r.add('DEPTH', `children[${i}].id`, `the child is the parent of ${other.path}`); });
  }
  children.forEach((c, i) => { if (c.id === p.id) r.add('DEPTH', `children[${i}].id`, 'a child carries the id of its parent'); });

  // COVERAGE_GAP: every requirement is closed by a child or by an assembly check; no coverage names an unknown one (TD-16).
  const reqIds = new Set(p.requirements.map(q => q.id));
  const covered = new Set();
  children.forEach((c, i) => c.covers.forEach((id, j) => { covered.add(id); if (!reqIds.has(id)) r.add('COVERAGE_GAP', `children[${i}].covers[${j}]`, `${id} is not a requirement of the parent`); }));
  record.assembly.checks.forEach((k, i) => k.covers.forEach((id, j) => { covered.add(id); if (!reqIds.has(id)) r.add('COVERAGE_GAP', `assembly.checks[${i}].covers[${j}]`, `${id} is not a requirement of the parent`); }));
  p.requirements.forEach((q, i) => { if (!covered.has(q.id)) r.add('COVERAGE_GAP', `parent.requirements[${i}]`, `${q.id} is closed by no child and no assembly check`); });

  // DANGLING_DEP and CYCLE (TD-19, TD-20).
  children.forEach((c, i) => c.dependsOn.forEach((d, j) => {
    if (d === c.id) r.add('DANGLING_DEP', `children[${i}].dependsOn[${j}]`, 'a child depends on itself');
    else if (!childIds.has(d)) r.add('DANGLING_DEP', `children[${i}].dependsOn[${j}]`, `${d} is not a child of this record`);
  }));
  const order = record.assembly.order;
  const orderSet = new Set(order);
  order.forEach((id, i) => { if (!childIds.has(id)) r.add('DANGLING_DEP', `assembly.order[${i}]`, `${id} is not a child of this record`); });
  if (orderSet.size !== order.length || ids.some(id => !orderSet.has(id))) r.add('DANGLING_DEP', 'assembly.order', 'the merge order names every child exactly once');
  const graph = graphOf(children);
  const cycle = findCycle(graph);
  if (cycle) r.add('CYCLE', 'children', `dependency cycle ${cycle.join(' -> ')}`);
  // The merge order is read against an acyclic graph only; a cycle is reported once, by the graph.
  if (!cycle && !r.has('DANGLING_DEP')) {
    const pos = new Map(order.map((id, i) => [id, i]));
    for (const c of children) for (const d of c.dependsOn) if (pos.get(d) > pos.get(c.id)) r.add('CYCLE', 'assembly.order', `${c.id} is merged before ${d}, which it depends on`);
  }

  if (pathsSafe) {
    // SCOPE_ESCAPE: a child writes only inside the parent scope, never a forbidden path, and keeps every parent prohibition (TD-17).
    const parentForbidden = p.forbidden;
    children.forEach((c, i) => {
      for (const f of parentForbidden) if (!c.forbidden.some(x => fold(x) === fold(f))) r.add('SCOPE_ESCAPE', `children[${i}].forbidden`, `drops the parent prohibition ${f}`);
      c.writeSet.forEach((w, j) => {
        if (!p.scope.some(s => covers(s, w))) r.add('SCOPE_ESCAPE', `children[${i}].writeSet[${j}]`, `${w} is outside the parent scope`);
        const hit = [...parentForbidden, ...c.forbidden].find(f => covers(f, w));
        if (hit) r.add('SCOPE_ESCAPE', `children[${i}].writeSet[${j}]`, `${w} is forbidden by ${hit}`);
      });
    });
    record.assembly.integratorPaths.forEach((w, j) => {
      if (!p.scope.some(s => covers(s, w))) r.add('SCOPE_ESCAPE', `assembly.integratorPaths[${j}]`, `${w} is outside the parent scope`);
      const hit = parentForbidden.find(f => covers(f, w));
      if (hit) r.add('SCOPE_ESCAPE', `assembly.integratorPaths[${j}]`, `${w} is forbidden by ${hit}`);
    });

    // SCOPE_OVERLAP: two children without a dependency edge never write one path, nor read what the other writes;
    // a child never writes a path only the integrator writes (TD-18).
    if (!cycle) {
      for (let i = 0; i < children.length; i++) for (let j = i + 1; j < children.length; j++) {
        const a = children[i]; const b = children[j];
        if (reachable(graph, a.id, b.id) || reachable(graph, b.id, a.id)) continue;
        for (const w of a.writeSet) {
          const x = b.writeSet.find(y => clash(w, y));
          if (x === undefined) continue;
          r.add('SCOPE_OVERLAP', `children[${i}].writeSet`, fold(x) === fold(w) ? `${a.id} and ${b.id} both write ${w} with no dependency edge` : `${a.id} writes ${w} and ${b.id} writes ${x}, a file and a folder of one name, with no dependency edge`);
        }
        for (const [reader, writer, ri] of [[a, b, i], [b, a, j]]) {
          for (const rd of reader.readSet) {
            const w = writer.writeSet.find(x => touches(rd, x));
            if (w) r.add('SCOPE_OVERLAP', `children[${ri}].readSet`, `${reader.id} reads ${w}, which ${writer.id} writes, with no dependency edge`);
          }
        }
      }
    }
    children.forEach((c, i) => c.writeSet.forEach((w, j) => {
      if (record.assembly.integratorPaths.some(x => clash(x, w))) r.add('SCOPE_OVERLAP', `children[${i}].writeSet[${j}]`, `${w} is or holds a path written only by the integrator`);
      if (c.writeSet.some((x, k) => k !== j && fold(x) !== fold(w) && clash(x, w))) r.add('SCOPE_OVERLAP', `children[${i}].writeSet[${j}]`, `${w} is a file and a folder of another path of the same write set`);
    }));
  }

  // UNVERIFIABLE_ACCEPTANCE: one positive and one negative command at least, each a node command that runs a file of
  // the base commit; a negative command is never also a positive one (TD-22).
  children.forEach((c, i) => {
    for (const k of ['positive', 'negative']) {
      if (!c.acceptance[k].length) r.add('UNVERIFIABLE_ACCEPTANCE', `children[${i}].acceptance.${k}`, `no ${k} executable command`);
      c.acceptance[k].forEach((x, j) => { const problem = commandProblem(x, ix); if (problem) r.add('UNVERIFIABLE_ACCEPTANCE', `children[${i}].acceptance.${k}[${j}]`, problem); });
    }
    // One check is never both the positive and the negative one, whatever its spelling (case of the file, --test).
    const pos = new Set(c.acceptance.positive.map(x => commandKey(x.command)));
    c.acceptance.negative.forEach((x, j) => { if (pos.has(commandKey(x.command))) r.add('UNVERIFIABLE_ACCEPTANCE', `children[${i}].acceptance.negative[${j}]`, 'runs the check of a positive command; one check cannot be both the positive and the negative one'); });
  });
  record.assembly.checks.forEach((k, i) => { const problem = commandProblem(k, ix); if (problem) r.add('UNVERIFIABLE_ACCEPTANCE', `assembly.checks[${i}]`, problem); });

  // MARKER: derived from the parent and child ids, one per child (TD-21).
  const seen = new Map();
  children.forEach((c, i) => {
    if (c.marker !== markerOf(p.id, c.id)) r.add('MARKER', `children[${i}].marker`, `is not the derived marker ${markerOf(p.id, c.id)}`);
    if (seen.has(c.marker)) r.add('MARKER', `children[${i}].marker`, `repeats the marker of children[${seen.get(c.marker)}]`);
    else seen.set(c.marker, i);
  });

  // BASELINE_DRIFT: the record is read against the commit it names (TD-24).
  if (p.base !== facts.base) r.add('BASELINE_DRIFT', 'parent.base', `the record names ${p.base}; the facts were read at ${facts.base}`);

  // AUTHOR_FLOOR: the author tier is at least the rubric tier and the floor of the class the files demand (TD-23).
  children.forEach((c, i) => {
    const derived = pathsSafe ? derivedClass(c, ix) : 'outside';
    if (CLASS_RANK[derived] > CLASS_RANK[c.workClass]) r.add('AUTHOR_FLOOR', `children[${i}].workClass`, `${c.workClass} is below the class ${derived} its files demand`);
    const factorFloor = derived === 'kernel' ? 2 : derived === 'protected' ? 1 : 0;
    if (c.complexity.protectedPaths < factorFloor) r.add('AUTHOR_FLOOR', `children[${i}].complexity.protectedPaths`, `${c.complexity.protectedPaths} is below ${factorFloor} for ${derived} files`);
    const sum = FACTORS.reduce((n, f) => n + c.complexity[f], 0);
    const cls = CLASS_RANK[derived] >= CLASS_RANK[c.workClass] ? derived : c.workClass;
    const floor = cls === 'kernel' ? facts.policy.floors.kernel : cls === 'protected' ? facts.policy.floors.protected : 1;
    const required = Math.max(facts.policy.sumTiers[sum], floor);
    if (tierNumber(c.author.minTier) < required) r.add('AUTHOR_FLOOR', `children[${i}].author.minTier`, `${c.author.minTier} is below T${required} (rubric T${facts.policy.sumTiers[sum]}, ${cls} floor T${floor})`);
  });

  // ROLE_FORBIDDEN: a free route authors only a mechanical change outside the kernel, and never reviews or integrates (TD-25).
  children.forEach((c, i) => {
    const derived = pathsSafe ? derivedClass(c, ix) : 'outside';
    if (c.author.routes.includes('free') && !(c.workClass === 'mechanical' && derived === 'outside' && c.role === 'change')) {
      r.add('ROLE_FORBIDDEN', `children[${i}].author.routes`, `a free route authors only a mechanical change outside the kernel (role ${c.role}, class ${c.workClass}, files ${derived})`);
    }
    if (c.reviewer.routes.includes('free')) r.add('ROLE_FORBIDDEN', `children[${i}].reviewer.routes`, 'a free route never gives an acceptance verdict');
  });
  if (record.assembly.integrator.routes.includes('free')) r.add('ROLE_FORBIDDEN', 'assembly.integrator.routes', 'a free route never integrates');

  // FAMILY: every family the record names is one the kernel family fold knows, and a spelling is the family it folds to (TD-82);
  // a child is accepted by another family; certifiers are outside every child author and the integrator;
  // once work is staffed every family is known (TD-26).
  const familyOf = familyTable(record);
  const named = [[record.assembly.integrator.family, 'assembly.integrator.family']];
  children.forEach((c, i) => named.push([c.author.family, `children[${i}].author.family`], [c.reviewer.family, `children[${i}].reviewer.family`]));
  (Array.isArray(p.certifierFamilies) ? p.certifierFamilies : []).forEach((f, i) => named.push([f, `parent.certifierFamilies[${i}]`]));
  (Array.isArray(record.ledger) ? record.ledger : []).forEach((e, i) => { for (const k of ['author', 'reviewer', 'integrator']) if (Object.hasOwn(e, k)) named.push([e[k], `ledger[${i}].${k}`]); });
  for (const [v, where] of named) if (typeof v === 'string' && !familyOf(v)) r.add('FAMILY', where, `${v} is not a family the kernel family fold knows`);
  const known = v => (typeof v === 'string' ? familyOf(v) : null);
  const certifiers = Array.isArray(p.certifierFamilies) ? p.certifierFamilies.map(known).filter(Boolean) : null;
  const integrator = known(record.assembly.integrator.family);
  children.forEach((c, i) => {
    const author = known(c.author.family); const reviewer = known(c.reviewer.family);
    if (author && reviewer && author === reviewer) r.add('FAMILY', `children[${i}].reviewer.family`, `the reviewer is of the author family ${author}`);
    if (author && certifiers && certifiers.includes(author)) r.add('FAMILY', 'parent.certifierFamilies', `${author} authors ${c.id} and certifies the parent`);
    if (STAFFED_CHILD.has(c.state) && (!author || !reviewer)) r.add('FAMILY', `children[${i}]`, `a ${c.state} child has an unknown author or reviewer family`);
  });
  if (integrator && certifiers && certifiers.includes(integrator)) r.add('FAMILY', 'parent.certifierFamilies', `${integrator} integrates and certifies the parent`);
  if (STAFFED_PARENT.has(p.state) && (!integrator || !certifiers)) r.add('FAMILY', 'parent', `an ${p.state} parent has an unknown integrator or certifier family`);

  // RUNNING_LIMIT (TD-27).
  const running = children.filter(c => c.state === 'running').length;
  if (running > MAX_RUNNING) r.add('RUNNING_LIMIT', 'children', `${running} children running; at most ${MAX_RUNNING}`);

  // COUNTER: the stored hash is the hash of the contract; against the record at the base commit nothing goes back
  // and a changed contract has a higher revision; the parent lineage holds every child count (TD-28).
  const hash = contractHash(record);
  if (p.contractHash !== hash) r.add('COUNTER', 'parent.contractHash', 'is not the hash of the contract; a changed contract is stamped by a new revision');
  for (const k of ['attempts', 'rounds']) {
    const sum = children.reduce((n, c) => n + c.counters[k], 0);
    if (p.counters[k] < sum) r.add('COUNTER', `parent.counters.${k}`, `${p.counters[k]} is below the ${sum} counted by the children`);
  }
  // The total budget of the parent: every start and every rejection of every child draws from it, whatever its id, its
  // lineage or the revision; only a raise recorded with its revision, its reason and the owner approval lifts it (TD-83).
  const { total, raises } = p.budget;
  for (const k of ['attempts', 'rounds']) if (p.counters[k] > total[k]) r.add('COUNTER', `parent.counters.${k}`, `${p.counters[k]} is above the total budget ${total[k]}`);
  raises.forEach((x, i) => {
    const before = raises[i - 1];
    if (x.revision > record.revision) r.add('COUNTER', `parent.budget.raises[${i}].revision`, `${x.revision} is after the revision ${record.revision} of the record`);
    if (before && x.revision <= before.revision) r.add('COUNTER', `parent.budget.raises[${i}].revision`, 'is not after the revision of the raise before it');
    if (before && !(x.attempts >= before.attempts && x.rounds >= before.rounds && (x.attempts > before.attempts || x.rounds > before.rounds))) r.add('COUNTER', `parent.budget.raises[${i}]`, 'raises nothing over the raise before it');
  });
  const last = raises[raises.length - 1];
  if (last && (last.attempts !== total.attempts || last.rounds !== total.rounds)) r.add('COUNTER', 'parent.budget.total', 'is not the total of the last raise');
  const prev = facts.previous;
  if (prev && prev.unreadable) r.add('COUNTER', 'record', 'the record at the base commit cannot be read, so its counters cannot be compared');
  else if (prev) {
    const pp = prev.parent || {};
    if (record.revision < prev.revision) r.add('COUNTER', 'record.revision', `goes back from ${prev.revision}`);
    if (pp.contractHash !== p.contractHash && record.revision <= prev.revision) r.add('COUNTER', 'record.revision', 'the contract changed without a new revision');
    for (const k of ['attempts', 'rounds']) if (pp.counters && p.counters[k] < pp.counters[k]) r.add('COUNTER', `parent.counters.${k}`, `goes back from ${pp.counters[k]}`);
    // The raises are append only, a new raise carries the new revision, and the total never rises without one (TD-83).
    const pb = isObject(pp.budget) ? pp.budget : {};
    const prevRaises = Array.isArray(pb.raises) ? pb.raises : [];
    if (prevRaises.length > raises.length || prevRaises.some((x, i) => canonical(x) !== canonical(raises[i]))) r.add('COUNTER', 'parent.budget.raises', 'the raises are append only; a raise of the record at the base commit is gone or changed');
    const fresh = raises.slice(prevRaises.length);
    if (fresh.some(x => x.revision !== record.revision) || (fresh.length && record.revision <= prev.revision)) r.add('COUNTER', 'parent.budget.raises', 'a new raise is stamped with the new revision of the record');
    if (isObject(pb.total)) for (const k of ['attempts', 'rounds']) if (Number.isInteger(pb.total[k]) && total[k] > pb.total[k] && !fresh.length) r.add('COUNTER', `parent.budget.total.${k}`, `rises from ${pb.total[k]} without a recorded raise`);
    const before = new Map((Array.isArray(prev.children) ? prev.children : []).map(c => [c.id, c]));
    children.forEach((c, i) => {
      // A renamed child is compared with the child it was: the counters of a lineage never go back (TD-53).
      const old = before.get(c.id) || (c.formerIds || []).map(id => before.get(id)).find(Boolean);
      for (const k of ['attempts', 'rounds']) if (old && old.counters && c.counters[k] < old.counters[k]) r.add('COUNTER', `children[${i}].counters.${k}`, `goes back from ${old.counters[k]}`);
    });
  }

  // DUPLICATE_RECORD: one record per parent; a record under the decompositions folder is named after its parent (TD-31).
  const self = facts.recordPath ? fold(facts.recordPath) : null;
  for (const other of facts.records) {
    if (self && fold(other.path) === self) continue;
    if (other.unreadable) r.add('DUPLICATE_RECORD', other.path, 'another record cannot be read, so uniqueness cannot be shown');
    else if (typeof other.parentId === 'string' && fold(other.parentId) === fold(p.id)) r.add('DUPLICATE_RECORD', other.path, `a second record of the parent ${p.id}`);
  }
  return hash;
}

// ---------- entry points ----------

function finish(r, hash) {
  const rank = new Map(CODES.map((c, i) => [c, i]));
  const refusals = [...r.refusals].sort((a, b) => rank.get(a.code) - rank.get(b.code) || (a.where < b.where ? -1 : a.where > b.where ? 1 : 0) || (a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0));
  return { ok: refusals.length === 0, refusals, unknowns: [...r.unknowns].sort(), contractHash: hash };
}

function validate(record, facts) {
  checkFacts(facts);
  const r = new Report();
  shape(record, r);
  if (facts.recordPath && fold(facts.recordPath).startsWith(DECOMPOSITIONS_DIR) && isObject(record) && isObject(record.parent)
    && fold(facts.recordPath) !== fold(`${DECOMPOSITIONS_DIR}${record.parent.id}.json`)) {
    r.add('SCHEMA', 'record', `a record under ${DECOMPOSITIONS_DIR} is named after its parent id`);
  }
  // The semantic checks read a record of the right shape only; a shape refusal stops here, with its own name.
  if (r.has('SCHEMA', 'UNKNOWN_AS_VALUE', 'DEPTH')) return finish(r, null);
  const ix = indexFacts(facts);
  const hash = semantics(record, facts, ix, r);
  return finish(r, hash);
}

function validateText(text, facts) {
  checkFacts(facts);
  let record;
  try { record = textSafe.parseJsonUnique(text); } catch (e) {
    const r = new Report();
    if (e && e.code === 'JSON_DUPLICATE_KEY') r.add('DUPLICATE_KEY', 'record', 'a key appears twice in one object');
    else r.add('SCHEMA', 'record', 'is not JSON');
    return finish(r, null);
  }
  return validate(record, facts);
}

// ---------- render ----------

function sourcesOf(paths, ix) {
  return paths.map(p => {
    const q = fold(p);
    const tracked = p.endsWith('/') ? [...ix.kinds.keys()].some(k => k.startsWith(q)) : ix.kinds.has(q);
    return `${p}: ${tracked ? 'tracked' : 'missing'}`;
  });
}
const unique = list => { const seen = new Set(); return list.filter(x => { const k = fold(x); if (seen.has(k)) return false; seen.add(k); return true; }); };

// The child task file and child task frame (TD-40..TD-44). A record that does not pass validate is never rendered.
function render(record, childId, facts) {
  const checked = validate(record, facts);
  if (!checked.ok) return { ok: false, refusals: checked.refusals };
  const child = record.children.find(c => c.id === childId);
  if (!child) throw new RangeError(`decompose render: no child ${childId}`);
  const p = record.parent;
  const ix = indexFacts(facts);
  // The child keeps every parent prohibition, its own, the paths only the integrator writes and what its siblings write.
  const siblings = record.children.filter(c => c.id !== child.id).flatMap(c => c.writeSet);
  const forbidden = unique([...p.forbidden, ...child.forbidden, ...record.assembly.integratorPaths, ...siblings]);
  const derived = derivedClass(child, ix);
  const cls = CLASS_RANK[derived] >= CLASS_RANK[child.workClass] ? derived : child.workClass;
  const risk = cls === 'kernel' || cls === 'protected' ? 'A' : p.risk;
  const accept = [...child.acceptance.positive, ...child.acceptance.negative];
  const reqs = p.requirements.filter(q => child.covers.includes(q.id));

  const frame = [
    `goal: ${child.goal}`,
    `non-goals: [${p.exclusions.join(', ')}]`,
    `sources: [${unique([...sourcesOf(child.readSet, ix), ...sourcesOf(accept.map(x => x.file), ix)]).join(', ')}]`,
    `baseline: ${p.base}`,
    `scope-id: child:${p.id}.${child.id}`,
    `parent-scope: task:${p.id}`,
    `scope: [${child.writeSet.join(', ')}]`,
    `forbidden: [${forbidden.join(', ')}]`,
    `risk: ${risk}`,
    `tier: ${child.author.minTier}`,
    `success: [${accept.map(x => x.command).join(', ')}]`,
    `budgets: {attempts: ${p.budget.attempts}, rounds: ${p.budget.rounds}}`,
    '',
  ].join('\n');

  const lines = [
    `# Child task ${child.id} of ${p.id}`,
    '',
    `Parent: ${p.id}, package ${p.package}, record revision ${record.revision}, contract ${checked.contractHash}.`,
    `Base commit: ${p.base}. Work class: ${cls}. Author tier at least ${child.author.minTier}.`,
    'This is one child of a decomposition. The parent package is certified and landed as a whole; this child is accepted by a reviewer of another family who reruns the commands below on a clean tree.',
    '',
    '## Goal',
    '',
    child.goal,
    '',
    '## Parent requirements this child closes',
    '',
    ...(reqs.length ? reqs.map(q => `- ${q.id}: ${q.text}`) : ['- none (the assembly checks close the requirements of the parent)']),
    '',
    '## Write set',
    '',
    'Change these files and no other file:',
    '',
    ...child.writeSet.map(w => `- ${w}`),
    '',
    '## Read set',
    '',
    ...(child.readSet.length ? child.readSet.map(x => `- ${x}`) : ['- none beyond the write set']),
    '',
    '## Forbidden paths',
    '',
    ...forbidden.map(f => `- ${f}`),
    '',
    '## Inherited prohibitions of the parent',
    '',
    ...(p.exclusions.length ? p.exclusions.map(x => `- ${x}`) : ['- none beyond the forbidden paths']),
    '- Do not change a path outside the write set; a changed path outside it refuses the result.',
    '- Do not split this child again and do not start other children.',
    '',
    '## Acceptance',
    '',
    'Each command exits 0 on the finished tree. A negative command shows that invalid input is refused.',
    '',
    ...child.acceptance.positive.map(x => `- positive: \`${x.command}\``),
    ...child.acceptance.negative.map(x => `- negative: \`${x.command}\``),
    '',
    '## End',
    '',
    'When the work is committed, end your final message with the line below. It means submitted, not accepted.',
    '',
    child.marker,
    `Task-End: ${child.marker}`,
    '',
  ];
  const task = lines.join('\n');
  // Every line before the marker line, the footer and the last empty line, and every line of the frame, is checked, not the fields.
  const shaped = endLineProblem([...lines.slice(0, -3), ...frame.split('\n')]);
  if (shaped) return { ok: false, refusals: [{ code: 'SCHEMA', where: 'task', detail: shaped }] };
  const lint = taskLint.lintTask(task, { completion: child.marker });
  if (!lint.ok) throw new Error(`decompose render: the child task fails task lint (${lint.problems.map(x => x.code).join(', ')})`);
  const dir = `${DECOMPOSITIONS_DIR}${p.id}/`;
  return { ok: true, task, frame, taskPath: `${dir}${child.id}.task.md`, framePath: `${dir}${child.id}.frame.md` };
}

module.exports = {
  SCHEMA_ID, CODES, MAX_CHILDREN, MAX_RUNNING, DECOMPOSITIONS_DIR, CHILD_STATES, PARENT_STATES, LEDGER_FIELDS,
  GRAMMAR: Object.freeze({ ID, FAMILY, REQ, SHA1, SHA256, SESSION, CAUSE, PATH_CHARS, MAX_PATH, SEAT, ROUTE }), LOST_CAUSES,
  validate, validateText, contractHash, canonical, markerOf, render, sha256, isUnknown, textProblem, endShapeProblem, endLineProblem, commandWords, factsProblem,
  familyTable, workClassOf, seatOf,
};

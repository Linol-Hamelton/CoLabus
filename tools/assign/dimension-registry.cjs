'use strict';
// The one reader of the dimension registry. Every dimension list of the
// classifier, the launch intake, the selection adapter, the class registry,
// certifier selection and the benchmark bank is derived here; no reader keeps
// a list of its own.
const fs = require('node:fs');
const path = require('node:path');
const { parseJsonUnique } = require('../../.ai/bin/lib/text-safe.cjs');
const { validate } = require('../../.ai/bin/accounting/lib/schema-check.cjs');
const identity = require('../../.ai/bin/lib/model-identity.cjs');

const FILE = 'docs/ops/model-bank/dimensions.json';
const SCHEMA_FILE = 'docs/ops/model-bank/dimensions.schema.json';
const CROSSWALK_FILE = 'docs/ops/model-bank/benchmark-crosswalk.json';
const CROSSWALK_SCHEMA_FILE = 'docs/ops/model-bank/benchmark-crosswalk.schema.json';
const ADJACENCY_FILE = 'docs/ops/model-bank/dimension-adjacency.json';
const ADJACENCY_SCHEMA_FILE = 'docs/ops/model-bank/dimension-adjacency.schema.json';
// The files are named by require() so every require closure (an installed kit, the product tree) carries them;
// the data bytes are read again with the parser that refuses a duplicate key, so require's last key never decides.
const SCHEMA = require('../../docs/ops/model-bank/dimensions.schema.json');
require('../../docs/ops/model-bank/dimensions.json');
const CROSSWALK_SCHEMA = require('../../docs/ops/model-bank/benchmark-crosswalk.schema.json');
require('../../docs/ops/model-bank/benchmark-crosswalk.json');
const ROOT = path.resolve(__dirname, '../..');
const fail = detail => { throw Object.assign(new Error(`dimension-registry-invalid: ${detail}`), { code: 'dimension-registry-invalid', detail }); };
const cwFail = detail => { throw Object.assign(new Error(`benchmark-crosswalk-invalid: ${detail}`), { code: 'benchmark-crosswalk-invalid', detail }); };
const adjFail = detail => { throw Object.assign(new Error(`dimension-adjacency-invalid: ${detail}`), { code: 'dimension-adjacency-invalid', detail }); };
// The closed set of rows the layer crosswalk decision holds (PROTO-DEC-0175 item
// 5): the family stem, version null, metric null, no checks, and exactly this
// type, target and confidence. A row that cites the decision is held only when
// it is in this set; any other row needs two independent checks.
const DECISION = 'PROTO-DEC-0175 item 5';
const DECISION_ROWS = Object.freeze({
  'aacr-bench': 'direct D-REV H', 'aider-polyglot': 'direct D-EDIT H', 'aime-2025': 'direct D-MATH M',
  'apps': 'direct D-ALGO M', 'arc-agi-1': 'direct D-REASON M', 'arc-agi-2': 'direct D-REASON M',
  'arc-agi-3': 'direct D-REASON M', 'bigcodebench': 'direct D-ALGO M', 'c-crab': 'direct D-REV H',
  'codeelo': 'direct D-ALGO M', 'codeforces-platform': 'direct D-ALGO M', 'codesec-eval': 'direct D-SEC H',
  'conda-2024-contamination-report': 'unmapped - L', 'contextcrbench': 'direct D-REV H', 'cweval': 'direct D-SEC H',
  'cybench': 'direct D-SEC H', 'cybench-integrity-audit': 'unmapped - L', 'cyberseceval-2': 'direct D-SEC H',
  'cyberseceval-3': 'direct D-SEC H', 'cyberseceval-v1': 'direct D-SEC H', 'evalperf': 'direct D-ALGO M',
  'evalplus-humaneval-plus-mbpp-plus': 'direct D-ALGO M', 'gaia': 'direct D-AGENT L',
  'gpqa-diamond': 'direct D-KNOW M', 'hle': 'direct D-KNOW M', 'humaneval-contamination-cdd': 'unmapped - L',
  'humaneval-v1': 'direct D-ALGO M', 'humanevalpack': 'direct D-ALGO M', 'livecodebench': 'direct D-ALGO M',
  'mbpp-v1': 'direct D-ALGO M', 'mmlu-pro': 'direct D-KNOW M', 'multipl-e': 'direct D-ALGO M',
  'omega': 'direct D-MATH M', 'osworld': 'direct D-AGENT L', 'realvuln': 'direct D-SEC H',
  'repobench': 'direct D-ARCH M', 'repoprobe': 'direct D-ARCH H', 'rottenreviews': 'proxy D-CRIT L',
  'secbench-llm-cybersecurity': 'direct D-SEC H', 'secbench-vulnerability-patches': 'direct D-SEC H',
  'securityeval-v2-1': 'direct D-SEC H', 'swe-bench-lite': 'direct D-IMPL H',
  'swe-bench-multilingual': 'direct D-IMPL H', 'swe-bench-multimodal': 'direct D-IMPL H',
  'swe-bench-pro': 'direct D-IMPL H', 'swe-bench-verified': 'direct D-IMPL H', 'swe-lancer': 'direct D-IMPL H',
  'tau-bench': 'direct D-AGENT L'
});

// The approved collection table (PROTO-DEC-0321 item 7) as the owner refined it
// after the comparison with the maintainer pages (PROTO-DEC-0324), with the
// exact spellings of the stored pool. This closed set cannot approve a new
// benchmark by merely citing the decision. Versions/re-measurers share a
// counted key; composite indexes and aggregates are marked substitutes and never
// give coverage. A row may carry marks: subset-of names the benchmark whose
// subset its own counted key measures; substitute-in names the classes where the
// benchmark, counted once in its own class, is shown only as a marked
// substitute. The last field names the decisions the basis of each row cites.
const CLASS_TABLE_DECISION = 'PROTO-DEC-0321 item 7';
const REFINED = 'PROTO-DEC-0324';
const SUBSET_RULE = 'PROTO-DEC-0323 item 5';
const CLASS_TABLE = [
  ['D-IMPL', 'direct', 'deepswe', 'deepswe deepswe-1.1 deepswe-v1.1 deepswe-unversioned'],
  ['D-IMPL', 'direct', 'frontiercode', 'frontiercode frontiercode-1.1 frontiercode-2.0 frontiercode-aa-2.0'],
  ['D-IMPL', 'direct', 'frontierswe', 'frontierswe-unversioned frontierswe-v2'],
  ['D-IMPL', 'direct', 'programbench', 'programbench'],
  ['D-IMPL', 'direct', 'swe-bench-pro', 'swe-bench-pro-v2 swe-bench-pro-unversioned'],
  ['D-IMPL', 'direct', 'swe-atlas', 'swe-atlas', '', [REFINED]],
  ['D-IMPL', 'proxy', 'swe-atlas', 'swe-atlas-overall', '', [REFINED, SUBSET_RULE]],
  ['D-IMPL', 'direct', 'vibe-code-bench', 'vibe-code-bench-v1.1', '', [REFINED]],
  ['D-IMPL', 'direct', 'arena-webdev', 'arena-webdev', '', [REFINED]],
  ['D-IMPL', 'proxy', 'aa-coding-agent-index', 'aa-coding-agent-index aa-coding-agent-index-v2.1'],
  ['D-EDIT', 'direct', 'code-migration', 'code-migration code-migration-v1 code-migration-v1.1', '', [REFINED]],
  ['D-EDIT', 'direct', 'vibe-code-bench-1-100', 'vibe-code-bench-1-100-v1 vibe-code-bench-1-100-v1.1', '', [REFINED]],
  ['D-EDIT', 'direct', 'cursorbench', 'cursorbench-4.1', '', [REFINED]],
  ['D-EDIT', 'direct', 'swe-atlas-refactoring', 'swe-atlas-refactoring', '', [REFINED]],
  ['D-EDIT', 'direct', 'swe-sweep', 'swe-sweep', '', [REFINED]],
  ['D-REV', 'direct', 'martian-code-review', 'martian-code-review martian-code-review-ironbee'],
  ['D-REV', 'direct', 'kodus-code-review-v3', 'kodus-code-review-v3 kodus-code-review'],
  ['D-REV', 'direct', 'reviewbench', 'reviewbench'],
  ['D-REV', 'direct', 'swe-atlas-qna', 'swe-atlas-qna swe-atlas-qna-aa', '', [REFINED]],
  ['D-TERM', 'direct', 'terminal-bench', 'terminal-bench-2.0 terminal-bench-4.0-aa terminalbench-hard'],
  ['D-TERM', 'direct', 'terminal-bench-science', 'terminal-bench-science terminal-bench-science-0.1'],
  ['D-ARCH', 'direct', 'nl2repo-bench', 'nl2repo-bench'],
  ['D-DOC', 'direct', 'hemingway-bench', 'hemingway-bench'],
  ['D-DOC', 'direct', 'arena-document', 'arena-document', '', [REFINED]],
  ['D-DOC', 'direct', 'hlab-vals', 'hlab-vals-v1.1', '', [REFINED]],
  ['D-DOC', 'direct', 'vals-medscribe', 'vals-medscribe', '', [REFINED]],
  ['D-DOC', 'direct', 'vals-legal-research', 'vals-legal-research', '', [REFINED]],
  ['D-DOC', 'direct', 'vals-excel-modeling', 'vals-excel-modeling-v1.1', '', [REFINED]],
  ['D-SEC', 'direct', 'cwe-bench', 'cwe-bench-aa cwe-bench-v1-unspecified cwe-bench-v2'],
  ['D-SEC', 'direct', 'cybergym', 'cybergym-e2e-aa'],
  ['D-SEC', 'direct', 'deepsecbench', 'deepsecbench-aa', '', [REFINED]],
  ['D-SEC', 'direct', 'exploitbench', 'exploitbench-internal-port exploitbench-v8'],
  ['D-SEC', 'direct', 'exploitgym', 'exploitgym', '', [REFINED]],
  ['D-SEC', 'direct', 'webexploitbench', 'webexploitbench-v1.2', '', [REFINED]],
  ['D-SEC', 'direct', 'cyberbench', 'cyberbench-v1.1', '', [REFINED]],
  ['D-SEC', 'proxy', 'aa-cyber-index', 'aa-cyber-index', '', [REFINED]],
  ['D-KNOW', 'proxy', 'aa-intelligence-index', 'aa-intelligence-index-v5'],
  ['D-KNOW', 'proxy', 'vals-index', 'vals-index-v2.2', '', [REFINED]],
  ['D-AGENT', 'direct', 'automationbench', 'automationbench automationbench-aa'],
  ['D-AGENT', 'direct', 'gdpval', 'gdpval gdpval-aa'],
  ['D-AGENT', 'direct', 'agents-last-exam', 'agents-last-exam-v1.1'],
  ['D-AGENT', 'direct', 'aa-briefcase', 'aa-briefcase aa-briefcase-v1.1', 'substitute-in=D-DOC', [REFINED]],
  ['D-AGENT', 'direct', 'arena-agent', 'arena-agent', '', [REFINED]],
  ['D-AGENT', 'direct', 'apex-agents', 'apex-agents-aa', '', [REFINED]],
  ['D-AGENT', 'direct', 'enterprise-ops-gym', 'enterprise-ops-gym-aa', '', [REFINED]],
  ['D-AGENT', 'direct', 'itbench', 'itbench-aa', '', [REFINED]],
  ['D-AGENT', 'direct', 'skillsbench', 'skillsbench', '', [REFINED]],
  ['D-AGENT', 'direct', 'tau3-banking', 'tau3-bench tau3-banking', 'subset-of=tau3-bench', [REFINED, SUBSET_RULE]],
  ['D-AGENT', 'direct', 'toolathlon-verified', 'toolathlon-verified'],
];
const CLASS_TABLE_ROWS = Object.freeze(Object.fromEntries(CLASS_TABLE.flatMap(([target, type, counted, ids, marks = '']) =>
  ids.split(' ').map(id => [id, [type, target, counted, marks].filter(Boolean).join(' ')]))));
const CLASS_TABLE_CITES = Object.freeze(Object.fromEntries(CLASS_TABLE.flatMap(([, , , ids, , cites = []]) =>
  ids.split(' ').map(id => [id, Object.freeze([...cites])]))));
// The held form of a class-table row: type, target, counted key and its marks.
const classTableForm = row => [row.type, row.target, row.counted,
  row.subsetOf === undefined ? '' : `subset-of=${row.subsetOf}`,
  row.substituteIn === undefined ? '' : `substitute-in=${row.substituteIn.join(',')}`].filter(Boolean).join(' ');

// The closed rules the schema cannot state: one name space for IDs, facet
// labels, crosswalk labels, the quarantine bucket and removed IDs; only a task
// ID carries a profile weight; a role and certification name task IDs only.
function check(doc, schema) {
  const problems = validate(schema, doc, 'registry');
  if (problems.length) fail(problems[0]);
  const names = new Set();
  const claim = name => { if (names.has(name)) fail(`duplicate name ${name}`); names.add(name); };
  for (const d of doc.dimensions) {
    claim(d.id);
    if (d.scope === 'layer' && (d.profile || d.f02)) fail(`layer ID ${d.id} carries a task flag`);
  }
  for (const f of doc.facets) { claim(f.label); claim(f.id); }
  for (const label of [...doc.crosswalkLabels, ...doc.quarantine]) claim(label);
  const task = new Set(doc.dimensions.filter(d => d.scope === 'task').map(d => d.id));
  for (const r of doc.removed) {
    claim(r.id);
    if (!task.has(r.replacement)) fail(`removed ID ${r.id} names no task ID`);
  }
  for (const [role, id] of Object.entries(doc.roles)) {
    if (!/^[a-z][a-z-]{1,40}$/.test(role) || !task.has(id)) fail(`role ${role} names no task ID`);
  }
  if (!doc.certification.length || new Set(doc.certification).size !== doc.certification.length
      || doc.certification.some(id => !task.has(id))) fail('certification names no task ID set');
  if (!doc.dimensions.some(d => d.profile)) fail('no profile ID');
  return doc;
}

function readJson(root, rel) {
  return parseJsonUnique(fs.readFileSync(path.join(root, rel), 'utf8'));
}

function build(doc) {
  const of = pred => Object.freeze(doc.dimensions.filter(pred).map(d => d.id));
  const ids = of(() => true);
  const removed = Object.freeze(Object.fromEntries(doc.removed.map(r => [r.id, r.replacement])));
  const bankLabels = Object.freeze([...ids, ...doc.facets.map(f => f.label), ...doc.crosswalkLabels, ...doc.quarantine]);
  // Lookups close over this frozen copy, never over the caller's document.
  const roles = Object.freeze({ ...doc.roles });
  return Object.freeze({
    schema: doc.schema,
    // All 14 IDs; task IDs are the classifier vocabulary, profile IDs the
    // weighted task-profile subset, layer IDs strength cells only.
    ids,
    taskIds: of(d => d.scope === 'task'),
    profileIds: of(d => d.scope === 'task' && d.profile),
    layerIds: of(d => d.scope === 'layer'),
    f02Ids: of(d => d.f02),
    facets: Object.freeze(doc.facets.map(f => Object.freeze({ ...f }))),
    crosswalkLabels: Object.freeze([...doc.crosswalkLabels]),
    quarantine: Object.freeze([...doc.quarantine]),
    removed,
    roles,
    certification: Object.freeze([...doc.certification]),
    // The raw labels a benchmark bank row may carry: an ID, a facet label, a
    // crosswalk label or the quarantine bucket. A removed ID is not one.
    bankLabels,
    isBankLabel: label => typeof label === 'string' && bankLabels.includes(label),
    roleDimension: role => (typeof role === 'string' && Object.hasOwn(roles, role) ? roles[role] : null),
  });
}

let cached = null;
// load() reads the registry of this checkout once; load({ root }) reads another
// tree and load({ doc }) checks an in-memory document (tests and mutations).
function load(opts = {}) {
  if (!opts.root && !opts.doc && cached) return cached;
  const root = opts.root || ROOT;
  const schema = opts.schema || SCHEMA;
  const registry = build(check(opts.doc || readJson(root, FILE), schema));
  if (!opts.root && !opts.doc) cached = registry;
  return registry;
}

// Why a target is refused, or null for a registry ID. The quarantine bucket, a
// crosswalk label and a removed ID are never targets; neither is an unknown name.
function targetProblem(registry, t) {
  return registry.quarantine.includes(t) ? 'the quarantine bucket is never a target'
    : registry.crosswalkLabels.includes(t) ? 'a crosswalk label is never a target'
      : Object.hasOwn(registry.removed, t) ? `removed ID, use ${registry.removed[t]}`
        : registry.ids.includes(t) ? null : 'unknown ID';
}

// One identity fold for a check: the family is the canonical maker of the
// declared family (UNKNOWN is refused), and a reviewer that spells a known model
// is that model and must be of the declared family. An opaque reviewer is itself.
function checkIdentity(key, c) {
  const family = identity.declaredFamily(c.family);
  if (family === 'UNKNOWN') cwFail(`row ${key} check ${c.reviewer}: family ${c.family} is not a known family`);
  const model = identity.lineagePlainModel(c.reviewer);
  if (model !== 'UNKNOWN' && identity.canonicalFamily(model) !== family) cwFail(`row ${key} check ${c.reviewer}: the reviewer is not of family ${c.family}`);
  return { reviewer: model === 'UNKNOWN' ? c.reviewer : model, family };
}

// The closed rules of the benchmark crosswalk the schema cannot state: every row
// is approved, by a row the decision holds or by two independent checks of
// different canonical families; a direct or proxy target is a registry ID, a
// facet target a facet ID, an unmapped row has none. Only a counted (direct)
// row carries marks: a subset has a counted key of its own, never the key of
// the benchmark it is a subset of; a substitute class is a registry ID other
// than the row's own class, named once.
function checkCrosswalk(doc, registry, schema = CROSSWALK_SCHEMA) {
  const problems = validate(schema, doc, 'crosswalk');
  if (problems.length) cwFail(problems[0]);
  const keys = new Set();
  const facets = registry.facets.map(f => f.id);
  for (const row of doc.rows) {
    const key = row.version === null ? row.benchmark : `${row.benchmark}@${row.version}`;
    if (keys.has(key)) cwFail(`duplicate row ${key}`);
    keys.add(key);
    if (row.status !== 'approved') cwFail(`row ${key} is not approved (${row.status})`);
    if (row.type === 'direct' || row.type === 'proxy') {
      const problem = targetProblem(registry, row.target);
      if (problem) cwFail(`row ${key} target ${row.target}: ${problem}`);
    } else if (row.type === 'facet') {
      if (!facets.includes(row.target)) cwFail(`row ${key} target ${row.target}: not a facet ID`);
    } else if (row.target !== null) cwFail(`row ${key}: an unmapped row has no target`);
    if ((row.subsetOf !== undefined || row.substituteIn !== undefined) && row.type !== 'direct') cwFail(`row ${key}: only a counted row carries a subset or substitute mark`);
    if (row.subsetOf !== undefined && (row.counted ?? row.benchmark) === row.subsetOf) cwFail(`row ${key}: a subset of ${row.subsetOf} counts under a key of its own`);
    if (row.substituteIn !== undefined) {
      if (!row.substituteIn.length || new Set(row.substituteIn).size !== row.substituteIn.length) cwFail(`row ${key}: substitute classes are named once each`);
      for (const c of row.substituteIn) {
        const problem = c === row.target ? 'the row counts in this class' : targetProblem(registry, c);
        if (problem) cwFail(`row ${key} substitute class ${c}: ${problem}`);
      }
    }
    if (row.decision === DECISION) {
      const held = row.version === null && Object.hasOwn(DECISION_ROWS, row.benchmark) ? DECISION_ROWS[row.benchmark] : null;
      if (held !== `${row.type} ${row.target ?? '-'} ${row.confidence}` || row.metric !== null || row.checks.length
          || (row.counted !== undefined && row.counted !== row.benchmark) || row.subsetOf !== undefined || row.substituteIn !== undefined) {
        cwFail(`row ${key} is not a row ${DECISION} holds; it needs two independent checks`);
      }
    } else if (row.decision === CLASS_TABLE_DECISION) {
      const held = Object.hasOwn(CLASS_TABLE_ROWS, row.benchmark) ? CLASS_TABLE_ROWS[row.benchmark] : null;
      if (held !== classTableForm(row) || row.version !== 'exact-id'
          || row.metric !== null || row.checks.length || row.confidence !== (row.type === 'proxy' ? 'L' : 'H')) {
        cwFail(`row ${key} is not a row ${CLASS_TABLE_DECISION} holds`);
      }
      if (typeof row.basis !== 'string' || !row.basis.trim() || !row.basis.startsWith(`${row.target}: `)) {
        cwFail(`row ${key} on the class table needs its basis`);
      }
      for (const cite of CLASS_TABLE_CITES[row.benchmark]) {
        if (!row.basis.includes(cite)) cwFail(`row ${key} on the class table needs its basis to cite ${cite}`);
      }
    } else {
      if (row.checks.length < 2) cwFail(`row ${key} needs two independent checks`);
      const folded = row.checks.map(c => checkIdentity(key, c));
      if (new Set(folded.map(c => c.reviewer)).size !== folded.length) cwFail(`row ${key} needs two independent checks`);
      if (new Set(folded.map(c => c.family)).size < 2) cwFail(`row ${key} needs checks by different families`);
    }
  }
  return doc;
}

function buildCrosswalk(doc, registry) {
  const rows = Object.freeze(doc.rows.map(r => Object.freeze({ ...r, checks: Object.freeze(r.checks.map(c => Object.freeze({ ...c }))) })));
  const families = rows.filter(r => r.version === null).sort((a, b) => b.benchmark.length - a.benchmark.length);
  // An exact id wins; otherwise the longest family stem whose id is stem-<suffix>.
  const resolve = id => {
    if (typeof id !== 'string') return null;
    return rows.find(r => r.benchmark === id) || families.find(r => id.startsWith(`${r.benchmark}-`)) || null;
  };
  return Object.freeze({
    schema: doc.schema,
    rows,
    resolve,
    // A crosswalk label resolves only through a direct row of the benchmark's
    // family; any other label is the dimension itself. null: unresolved.
    dimensionOf: (label, benchmarkId) => {
      if (!registry.crosswalkLabels.includes(label)) return label;
      const row = resolve(benchmarkId);
      return row && row.type === 'direct' ? row.target : null;
    },
  });
}

// loadCrosswalk() reads the crosswalk of this checkout; { root } another tree;
// { doc } an in-memory document. The registry is this checkout's unless given.
function loadCrosswalk(opts = {}) {
  const registry = opts.registry || load();
  const doc = opts.doc || readJson(opts.root || ROOT, CROSSWALK_FILE);
  return buildCrosswalk(checkCrosswalk(doc, registry, opts.schema), registry);
}

// Stored slices only, from the same admitted bank as the headline scores. No
// headline aggregation or extra coverage is inferred here. opts.rows lets the
// bank builder pass its already loaded rows; opts.root reads another checkout.
// Unknown model IDs match only their exact spelling, never UNKNOWN == UNKNOWN.
function slicesForModel(modelId, opts = {}) {
  if (typeof modelId !== 'string' || !modelId.trim()) return Object.freeze([]);
  const rows = opts.rows || fs.readFileSync(path.join(opts.root || ROOT, 'docs/ops/model-bank/scores.jsonl'), 'utf8')
    .split('\n').filter(line => line.trim()).map(line => parseJsonUnique(line));
  const canonical = identity.canonicalModel(modelId);
  const sameModel = id => id === modelId || (canonical !== 'UNKNOWN' && identity.canonicalModel(id) === canonical);
  const cw = loadCrosswalk({ root: opts.root });
  const counted = id => { const row = cw.resolve(id); return row ? row.counted || row.benchmark : id; };
  const freeze = value => {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  };
  return freeze(rows.filter(row => ['category', 'subtask'].includes(row.granularity)
    && sameModel(row.modelId)
    && (opts.benchmarkId === undefined || counted(row.benchmarkId) === counted(opts.benchmarkId)))
    .map(row => structuredClone(row)));
}

// The closed rules of the adjacency table the schema cannot state: one row per
// dimension; the dimension and every nearest ID are registry IDs (never a
// crosswalk label, the quarantine bucket or a removed ID); one to three nearest
// IDs, distinct and never the dimension itself.
function checkAdjacency(doc, registry, schema) {
  const problems = validate(schema, doc, 'adjacency');
  if (problems.length) adjFail(problems[0]);
  const seen = new Set();
  for (const row of doc.rows) {
    const problem = targetProblem(registry, row.dimension);
    if (problem) adjFail(`row ${row.dimension}: ${problem}`);
    if (seen.has(row.dimension)) adjFail(`duplicate row ${row.dimension}`);
    seen.add(row.dimension);
    if (!row.nearest.length || row.nearest.length > 3 || new Set(row.nearest).size !== row.nearest.length) adjFail(`row ${row.dimension}: one to three distinct nearest IDs`);
    for (const id of row.nearest) {
      const p = id === row.dimension ? 'a dimension never names itself' : targetProblem(registry, id);
      if (p) adjFail(`row ${row.dimension} nearest ${id}: ${p}`);
    }
  }
  return doc;
}

// The nearest classifiers of a dimension, in order; [] for a dimension without a row.
function buildAdjacency(doc) {
  const byId = new Map(doc.rows.map(r => [r.dimension, Object.freeze([...r.nearest])]));
  return Object.freeze({ schema: doc.schema, nearest: id => byId.get(id) || Object.freeze([]) });
}

// loadAdjacency() reads the table of this checkout once; { root } another tree;
// { doc } an in-memory document. The data is named by require() here, inside the
// reader, so a copy of this file that never asks for the table needs no copy of it.
let cachedAdjacency = null;
function loadAdjacency(opts = {}) {
  const own = !opts.root && !opts.doc && !opts.registry && !opts.schema;
  if (own && cachedAdjacency) return cachedAdjacency;
  const schema = opts.schema || require('../../docs/ops/model-bank/dimension-adjacency.schema.json');
  if (!opts.doc && !opts.root) require('../../docs/ops/model-bank/dimension-adjacency.json');
  const doc = opts.doc || readJson(opts.root || ROOT, ADJACENCY_FILE);
  const table = buildAdjacency(checkAdjacency(doc, opts.registry || load(), schema));
  if (own) cachedAdjacency = table;
  return table;
}

module.exports = { FILE, SCHEMA_FILE, CROSSWALK_FILE, CROSSWALK_SCHEMA_FILE, ADJACENCY_FILE, ADJACENCY_SCHEMA_FILE, DECISION_ROWS, CLASS_TABLE_DECISION, CLASS_TABLE_ROWS, CLASS_TABLE_CITES, load, check, loadCrosswalk, checkCrosswalk, slicesForModel, loadAdjacency, checkAdjacency };

'use strict';
// The task-context/1 document: the architecture context of one task, derived from the git objects of one commit by the context
// resolver and checked by the packet compiler. One closed shape, one level filter and one rendering serve both sides, so the
// resolver and the compiler never read the document two ways. Pure: no file, no git, no environment, no clock, no randomness.
//
// The shape is closed (SCHEMA-task-context): the keys stand in one order, every row of a section has the fields of that section
// in one order, every value has one grammar, the rows of a section are sorted and unique, and the file is the canonical
// serialisation of its value. Anything else is a named refusal; nothing in the document is free text from a review.

const SCHEMA = 'task-context/1';
const KEYS = ['schema', 'switch', 'commit', 'tree', 'base', 'stream', 'package', 'launchRole', 'taskSha256', 'level', 'targets', 'owners',
  'processes', 'rules', 'decisions', 'consumers', 'tests', 'contracts', 'history', 'coupledSets', 'sources', 'dropped'];
const HISTORY_KEYS = ['package', 'reports', 'findings'];
const LAUNCH_ROLES = ['author', 'certifier'];
const SWITCH_STATES = ['off', 'on'];
// The levels of the context, largest first. A level is chosen by what the task and the client need (the contextLevel of the client), and its rows
// are chosen by relevance, never by the size of the rendering: C3 keeps every row the task itself names or reaches directly (the tests that
// read a target, the consumers of depth 1 and 2) and the chain tests of the targets the task names; C2 leaves out the transitive rows (consumers
// of depth 2, tests that only reach a target through a chain); C1 keeps the required set of the targets: their direct owners, the direct callers,
// the tests that read a target, the contracts and the findings of HIGH severity or above. There is no cap on the rows of a
// section: the resolver delivers the level asked for whatever its size, and a rendering that grows large is a figure for the operator (the pulse
// line packet-size). The one limit is the safety limit of the whole packet: above it the compiler lowers the level step by step (fitLevel); when
// the required set of C1 alone passes it, the rows of that set are kept by relevance in the order TRIM_ORDER and the rest are named by their count
// (dropped, reason packet limit); the context is refused by name only when the rows that are never trimmed do not fit. A level that leaves rows
// out names their count in the dropped rows and the way to the full set (the line full set of the rendering).
const LEVELS = ['C3', 'C2', 'C1'];
// How a test reaches a target: direct (it reads the target, or it is the target) or by a chain of readers.
const REACH = ['direct', 'chain'];
// The targets the task names itself; the other targets of the commit are the ones of its branch diff.
const NAMED_BASIS = ['task-scope', 'task-mention'];
// The main PC load rule: a test file measured over two minutes, and every installer, manifest, product or suite-wide test, runs on
// the farm; the rest runs on the author's machine one file at a time.
const HEAVY_MS = 120000;
const HEAVY_NAME = /(?:^|[/-])(?:installer|manifest|product|suite)(?:[-.]|$)/;
// The closed list of finding classes. A finding names its class in the Class field of its report row (the certifier report format);
// a row that names none, or a name outside the list, reads as unknown.
const FINDING_CLASSES = ['MR-1', 'MR-2', 'MR-3', 'MR-4', 'MR-5', 'MR-6', 'MR-7', 'MR-8', 'MR-9', 'MR-10',
  'machine-path', 'link', 'hard-link', 'encoding', 'atomic-write', 'unknown'];
// The class of one finding row: the label "Class:" with one name (the label may be bold, the name in backticks), else a cell of the row
// that is exactly one name of the list. Two different names, a name outside the list or no name read as unknown.
const CLASS_FIELD = /(?:^|[^A-Za-z0-9-])Class[*_]*\s*:[*_\s]*`?([A-Za-z0-9-]+)`?/g;
function findingClassOf(text) {
  if (typeof text !== 'string' || !text) return 'unknown';
  const known = n => FINDING_CLASSES.includes(n) && n !== 'unknown';
  const named = [...text.matchAll(CLASS_FIELD)].map(m => m[1]);
  const names = named.length ? named : text.split('|').map(c => c.replace(/[*`]/g, '').trim()).filter(known);
  const set = new Set(names);
  return set.size === 1 && known(names[0]) ? names[0] : 'unknown';
}
const SEVERITIES = ['CRITICAL', 'BLOCKER', 'HIGH', 'MAJOR', 'MEDIUM', 'MINOR', 'LOW', 'INFO', 'unknown'];
const SEVERE = new Set(['CRITICAL', 'BLOCKER', 'HIGH', 'MAJOR', 'MEDIUM']);
const HIGH = new Set(['CRITICAL', 'BLOCKER', 'HIGH']);
const TIERS = ['light', 'heavy-farm', 'unmeasured'];
// The owners whose records the trigger path-owner opens: the record of the path itself, the record named after the tool, the record the
// tool enforces, and the records that write or read the path. A record that only cites or mentions the path stays a data row.
const OPEN_BASIS = ['self', 'tool-name', 'enforced-by', 'outputs', 'inputs'];
const TRIM_LEVEL = 'C1';
const TRIM_REASON = 'packet limit';
const DROP_REASONS = ['level C3', 'level C2', 'level C1', TRIM_REASON, 'machine-path', 'secret-shape', 'value-form', 'scope-glob-wide'];

const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------- value grammars ----------
const SEGMENT = '[A-Za-z0-9_@+~-][A-Za-z0-9._@+~-]*|\\.[A-Za-z0-9_@+~-][A-Za-z0-9._@+~-]*';
const PATH_RE = new RegExp(`^(?:${SEGMENT})(?:/(?:${SEGMENT}))*$`);
const MASK_SEGMENT = '[A-Za-z0-9._@+~*-]+';
const MASK_RE = new RegExp(`^(?:${MASK_SEGMENT})(?:/${MASK_SEGMENT})*/?$`);
const OID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const RECORD_RE = /^(?:P-L[0-9]-[0-9]{3}|S-[0-9]{3}|M-[0-9]{3}|(?:ROLE|TOOL|APP|SCHEMA)-[A-Za-z0-9][A-Za-z0-9-]{0,80})$/;
const DECISION_RE = /^(?:PROTO-)?DEC-[0-9]{4}$/;
const PROCESS_RE = /^P-[0-9]{1,4}$/;
const RULE_ROW_RE = /^AR-[0-9]{3}$/;
const FINDING_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$/;
const STATUS_WORD_RE = /^[A-Za-z0-9][A-Za-z0-9 _.-]{0,39}$/;
const RECORD_STATUS_RE = /^[a-z][a-z-]{1,20}$/;
const SET_ID_RE = /^[A-Z][A-Z0-9-]{0,60}$/;
const SOURCE_NAME_RE = /^[a-z][a-z0-9-]{0,40}$/;
const REASON_RE = /^[a-z0-9][a-z0-9 .,:()=_-]{0,119}$/;
// a commit subject is one printable ASCII line without the signs that open markup or a path escape
const SUBJECT_RE = /^[\x21-\x7e](?:[\x20-\x7e]{0,158}[\x21-\x7e])?$/;
const SUBJECT_BAD = /[`<>&\\]/;

const safePath = v => typeof v === 'string' && v.length <= 300 && PATH_RE.test(v) && !v.split('/').some(s => s === '.' || s === '..');
const G = {
  path: v => safePath(v),
  mask: v => typeof v === 'string' && v.length <= 300 && MASK_RE.test(v) && !v.split('/').some(s => s === '.' || s === '..'),
  oid: v => typeof v === 'string' && OID_RE.test(v),
  sha256: v => typeof v === 'string' && SHA256_RE.test(v),
  record: v => typeof v === 'string' && RECORD_RE.test(v),
  recordStatus: v => typeof v === 'string' && RECORD_STATUS_RE.test(v),
  decision: v => typeof v === 'string' && DECISION_RE.test(v),
  process: v => typeof v === 'string' && PROCESS_RE.test(v),
  ruleRow: v => typeof v === 'string' && RULE_ROW_RE.test(v),
  findingId: v => typeof v === 'string' && FINDING_ID_RE.test(v),
  statusWord: v => typeof v === 'string' && STATUS_WORD_RE.test(v),
  setId: v => typeof v === 'string' && SET_ID_RE.test(v),
  sourceName: v => typeof v === 'string' && SOURCE_NAME_RE.test(v),
  reason: v => typeof v === 'string' && REASON_RE.test(v),
  subject: v => typeof v === 'string' && SUBJECT_RE.test(v) && !SUBJECT_BAD.test(v),
  depth: v => v === 1 || v === 2,
  count: v => Number.isSafeInteger(v) && v > 0,
};
const oneOf = list => v => list.includes(v);
const nullable = g => v => v === null || g(v);
const listOf = g => v => Array.isArray(v) && v.length > 0 && v.length <= 200 && v.every(g) && v.every((x, i) => i === 0 || cmp(v[i - 1], x) < 0);

// The sections: their fields in order, the grammar of each field and the sort key of the rows (null: the order of the resolver).
const SECTIONS = {
  targets: { fields: [['path', G.path], ['basis', oneOf(['task-scope', 'task-mention', 'branch-diff'])], ['blob', nullable(G.oid)]], key: ['path'] },
  owners: { fields: [['path', G.path], ['record', G.record], ['status', G.recordStatus], ['basis', oneOf(['self', 'tool-name', 'enforced-by', 'outputs', 'inputs', 'evidence', 'text'])]], key: ['path', 'record'] },
  processes: { fields: [['path', G.path], ['process', G.process], ['basis', oneOf(['register-row'])]], key: ['path', 'process'] },
  rules: { fields: [['record', G.record], ['rule', G.ruleRow], ['basis', oneOf(['rule-map'])]], key: ['record', 'rule'] },
  decisions: { fields: [['path', G.path], ['id', G.decision], ['basis', oneOf(['decisions-index', 'owner-record'])]], key: ['path', 'id'] },
  consumers: { fields: [['path', G.path], ['consumer', G.path], ['depth', G.depth], ['basis', oneOf(['grep-at-commit'])]], key: ['path', 'consumer'] },
  tests: { fields: [['path', G.path], ['test', G.path], ['reach', oneOf(REACH)], ['tier', oneOf(TIERS)], ['basis', oneOf(['consumer-index', 'grep-at-commit'])]], key: ['path', 'test'] },
  contracts: { fields: [['path', G.path], ['doc', G.path], ['basis', oneOf(['cites-path'])]], key: ['path', 'doc'] },
  'history.package': { fields: [['commit', G.oid], ['subject', G.subject], ['basis', oneOf(['branch-log'])]], key: null, unique: ['commit'] },
  'history.reports': { fields: [['doc', G.path], ['basis', oneOf(['author-report', 'review-name'])]], key: ['doc'] },
  'history.findings': { fields: [['review', G.path], ['id', G.findingId], ['severity', oneOf(SEVERITIES)], ['status', G.statusWord], ['path', nullable(G.path)], ['class', oneOf(FINDING_CLASSES)], ['basis', oneOf(['review-cites-path', 'review-name'])]], key: ['review', 'id', 'path'] },
  coupledSets: { fields: [['id', G.setId], ['basis', oneOf(['stream', 'package', 'path-mask'])], ['members', listOf(G.mask)]], key: ['id'] },
  sources: { fields: [['name', G.sourceName], ['file', G.path], ['sha256', nullable(G.sha256)], ['state', oneOf(['used', 'stale', 'absent'])], ['reason', nullable(G.reason)]], key: ['name'] },
  dropped: { fields: [['section', s => typeof s === 'string' && Object.hasOwn(SECTIONS, s) && s !== 'dropped'], ['rows', G.count], ['reason', oneOf(DROP_REASONS)]], key: ['section', 'reason'] },
};
const SECTION_NAMES = Object.keys(SECTIONS);
const rowsOf = (doc, section) => (section.startsWith('history.') ? doc.history[section.slice(8)] : doc[section]);
const keyOf = (row, fields) => fields.map(f => (row[f] === null ? '' : String(row[f]))).join('\u0000');

// ---------- the closed shape ----------
// opts.machinePath(text) -> [{ kind }] and opts.secretKind(text) -> kind|null are the detectors of the caller (the compiler's PC-15
// detector, the credential scanner); the refusal names the section, the row and the field, never the matched text.
function checkContext(doc, opts = {}) {
  const bad = why => { const e = new Error(why); e.contextShape = true; throw e; };
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) bad('not an object');
  const keys = Object.keys(doc);
  for (const k of keys) if (!KEYS.includes(k)) bad(`unknown key "${k.slice(0, 40)}"`);
  for (const k of KEYS) if (!keys.includes(k)) bad(`missing key "${k}"`);
  if (keys.join(',') !== KEYS.join(',')) bad(`the keys stand out of order (${KEYS.join(', ')})`);
  if (doc.schema !== SCHEMA) bad(`schema must be ${SCHEMA}`);
  if (!SWITCH_STATES.includes(doc.switch)) bad('switch must be off or on');
  for (const k of ['commit', 'tree', 'base']) if (!G.oid(doc[k])) bad(`${k} must be a full object id (40 or 64 hex)`);
  if (typeof doc.stream !== 'string' || !NAME_RE.test(doc.stream)) bad('stream must be a name of letters, digits, dot, underscore and dash');
  if (doc.package !== null && (typeof doc.package !== 'string' || !NAME_RE.test(doc.package))) bad('package must be null or a name of letters, digits, dot, underscore and dash');
  if (!LAUNCH_ROLES.includes(doc.launchRole)) bad(`launchRole must be one of ${LAUNCH_ROLES.join(', ')}`);
  if (!G.sha256(doc.taskSha256)) bad('taskSha256 must be sha256:64 hex');
  if (!LEVELS.includes(doc.level)) bad(`level must be one of ${LEVELS.join(', ')}`);
  if (!doc.history || typeof doc.history !== 'object' || Array.isArray(doc.history)) bad('history must be an object');
  const hk = Object.keys(doc.history);
  if (hk.join(',') !== HISTORY_KEYS.join(',')) bad(`history keys must be exactly ${HISTORY_KEYS.join(', ')} in this order`);
  for (const section of SECTION_NAMES) {
    const spec = SECTIONS[section];
    const rows = rowsOf(doc, section);
    if (!Array.isArray(rows)) bad(`${section} must be an array`);
    const names = spec.fields.map(f => f[0]);
    const seen = new Set();
    let prev = null;
    rows.forEach((row, i) => {
      const at = `${section} row ${i + 1}`;
      if (!row || typeof row !== 'object' || Array.isArray(row)) bad(`${at} is not an object`);
      const rk = Object.keys(row);
      if (rk.join(',') !== names.join(',')) bad(`${at} must carry exactly the fields ${names.join(', ')} in this order`);
      for (const [name, ok] of spec.fields) {
        if (!ok(row[name])) bad(`${at} field ${name} is outside its grammar`);
        for (const s of [].concat(row[name]).filter(v => typeof v === 'string')) {
          const kind = opts.secretKind ? opts.secretKind(s) : null;
          if (kind) bad(`${at} field ${name} carries a credential-shaped value (${String(kind).replace(/[^A-Za-z0-9-]/g, '').slice(0, 40)})`);
          const hits = opts.machinePath ? opts.machinePath(s) : [];
          if (hits.length) bad(`${at} field ${name} carries a machine path (${hits[0].kind})`);
        }
      }
      const unique = keyOf(row, spec.key || spec.unique);
      if (seen.has(unique)) bad(`${at} repeats the row of ${(spec.key || spec.unique).join(' and ')}`);
      seen.add(unique);
      if (spec.key && prev !== null && cmp(prev, unique) > 0) bad(`${at} is out of order; rows are sorted by ${spec.key.join(', ')}`);
      prev = unique;
    });
  }
  const targets = new Set(doc.targets.map(t => t.path));
  for (const section of ['owners', 'processes', 'decisions', 'consumers', 'tests', 'contracts']) {
    for (const row of doc[section]) if (!targets.has(row.path)) bad(`${section} names ${row.path}, which is not a target`);
  }
  for (const row of doc.history.findings) if (row.path !== null && !targets.has(row.path)) bad(`history.findings names ${row.path}, which is not a target`);
  const owners = new Set(doc.owners.map(o => o.record));
  for (const row of doc.rules) if (!owners.has(row.record)) bad(`rules names ${row.record}, which is not an owner`);
  const kept = atLevel(doc, doc.level);
  for (const section of SECTION_NAMES) {
    if (section === 'dropped') continue;
    const extra = rowsOf(doc, section).length - rowsOf(kept, section).length;
    if (extra) bad(`level ${doc.level} carries ${extra} ${section} row(s) the level leaves out`);
  }
  // a document never claims a level larger than the one that left its rows out: a dropped row of a smaller level than its own is a relabelled document
  const rank = LEVELS.indexOf(doc.level);
  for (const d of doc.dropped) {
    if (d.reason.startsWith('level ') && LEVELS.indexOf(d.reason.slice(6)) > rank) bad(`level ${doc.level} carries rows dropped at ${d.reason}, a smaller level than its own`);
    if (d.reason === TRIM_REASON && doc.level !== TRIM_LEVEL) bad(`level ${doc.level} carries rows left out for the safety limit, which only the floor ${TRIM_LEVEL} leaves out`);
  }
  // a level above the floor keeps the branch log: a document whose targets come from the branch diff always has commits in that log, so one with
  // no commit and no dropped row of the log is a floor that was relabelled and had its dropped rows removed
  if (rank < LEVELS.indexOf(TRIM_LEVEL) && doc.targets.some(t => t.basis === 'branch-diff') && !doc.history.package.length && !doc.dropped.some(d => d.section === 'history.package')) {
    bad(`level ${doc.level} carries no commit of the branch log of its branch diff and no dropped row names it; the document was cut and relabelled`);
  }
  return doc;
}

// The canonical serialisation: the document of one value is one byte string.
const serialize = doc => `${JSON.stringify(doc, null, 2)}\n`;

// ---------- levels ----------
// C3 keeps every row but the chain tests of a target that only the branch diff names (the tests that read it, and the chain tests of the
// targets the task names, stay). C2 keeps the consumers of depth 1, the findings of the same package and the severe ones, and of the tests the
// ones that read a target directly and the ones that are targets themselves. C1, the floor, keeps the required set of the targets: the
// targets, their owners, the processes, the rules, the decisions and the contracts, the direct callers (depth 1), the tests that read a target
// or are targets, the coupled sets, the findings of the same package and the findings of HIGH severity or above. Sources and dropped stay at
// every level. targets maps each target path to its basis.
function keepAt(level, section, row, targets) {
  if (level === 'C3') return section !== 'tests' || row.reach === 'direct' || NAMED_BASIS.includes(targets.get(row.path)) || targets.has(row.test);
  if (level === 'C1') {
    if (['targets', 'owners', 'processes', 'rules', 'decisions', 'contracts', 'coupledSets', 'sources'].includes(section)) return true;
    if (section === 'consumers') return row.depth === 1;
    if (section === 'tests') return row.reach === 'direct' || targets.has(row.test);
    if (section === 'history.findings') return row.basis === 'review-name' || HIGH.has(row.severity);
    return false;
  }
  if (section === 'consumers') return row.depth === 1;
  if (section === 'tests') return row.reach === 'direct' || targets.has(row.test);
  if (section === 'history.findings') return row.basis === 'review-name' || SEVERE.has(row.severity);
  return true;
}
function atLevel(doc, level) {
  if (!LEVELS.includes(level)) throw new Error(`unknown context level ${level}`);
  const targets = new Map(doc.targets.map(t => [t.path, t.basis]));
  const out = { ...doc, level, history: { ...doc.history } };
  const dropped = new Map(doc.dropped.map(d => [`${d.section}\u0000${d.reason}`, { ...d }]));
  for (const section of SECTION_NAMES) {
    if (section === 'dropped') continue;
    const rows = rowsOf(doc, section);
    const keep = rows.filter(r => keepAt(level, section, r, targets));
    if (section.startsWith('history.')) out.history[section.slice(8)] = keep; else out[section] = keep;
    const gone = rows.length - keep.length;
    if (gone) {
      const k = `${section}\u0000level ${level}`;
      const d = dropped.get(k) || { section, rows: 0, reason: `level ${level}` };
      d.rows += gone;
      dropped.set(k, d);
    }
  }
  out.dropped = [...dropped.values()].sort((a, b) => cmp(keyOf(a, ['section', 'reason']), keyOf(b, ['section', 'reason'])));
  return out;
}

// ---------- the required set over the safety limit ----------
// When the rows of the floor alone pass the safety limit, the rows of the sections below are kept by relevance, most relevant first, and the
// tail is left out and named by its count: a finding of HIGH severity or above is never left out while a row of a lower rank stays, then come
// the tests that are targets, the direct callers, the tests that read a target and the other findings of the package. The targets, owners,
// processes, rules, decisions, contracts, coupled sets and sources are never trimmed.
const TRIM_ORDER = ['findings of HIGH severity or above', 'tests that are targets', 'direct callers', 'tests that read a target', 'other findings of the package'];
function trimRank(section, row, targets) {
  if (section === 'history.findings') return HIGH.has(row.severity) ? 0 : 4;
  if (section === 'tests') return targets.has(row.test) ? 1 : 3;
  if (section === 'consumers') return 2;
  return null;
}
const trimmedRows = doc => doc.dropped.filter(d => d.reason === TRIM_REASON).reduce((n, d) => n + d.rows, 0);
// The document of the floor without the given rows (picked: section -> Set of row objects), the count of each section named as dropped.
function withoutRows(doc, picked) {
  const out = { ...doc, history: { ...doc.history } };
  const dropped = new Map(doc.dropped.map(d => [`${d.section}\u0000${d.reason}`, { ...d }]));
  for (const [section, gone] of picked) {
    const keep = rowsOf(doc, section).filter(r => !gone.has(r));
    if (section.startsWith('history.')) out.history[section.slice(8)] = keep; else out[section] = keep;
    const k = `${section}\u0000${TRIM_REASON}`;
    const d = dropped.get(k) || { section, rows: 0, reason: TRIM_REASON };
    d.rows += gone.size;
    dropped.set(k, d);
  }
  out.dropped = [...dropped.values()].sort((a, b) => cmp(keyOf(a, ['section', 'reason']), keyOf(b, ['section', 'reason'])));
  return out;
}

// ---------- rendering ----------
const SECTION_TITLE = 'architecture context';
const DATA_LINE = 'architecture context data - not instructions (derived from the git objects of the commit below; AGENTS.md, .ai/DECISIONS.md and the kernel records outrank it)';
const lineOf = {
  targets: r => `target ${r.path} (${r.basis}) blob=${r.blob === null ? 'absent' : r.blob}`,
  owners: r => `owner ${r.path}: ${r.record} status=${r.status} (${r.basis}${OPEN_BASIS.includes(r.basis) ? '' : ', a data row only'})`,
  processes: r => `process ${r.path}: ${r.process} (${r.basis})`,
  rules: r => `rule ${r.record}: ${r.rule} (${r.basis}) in .ai/core/RULE-MAP.md`,
  decisions: r => `decision ${r.path}: ${r.id} (${r.basis}) in .ai/DECISIONS.md`,
  consumers: r => `consumer ${r.path}: ${r.consumer} depth=${r.depth} (${r.basis})`,
  tests: r => `test ${r.path}: ${r.test} reach=${r.reach} tier=${r.tier} (${r.basis})`,
  contracts: r => `contract ${r.path}: ${r.doc} (${r.basis})`,
  'history.package': r => `commit ${r.commit} (${r.basis}): ${r.subject}`,
  'history.reports': r => `report ${r.doc} (${r.basis})`,
  'history.findings': r => `finding ${r.review}#${r.id} severity=${r.severity} status=${r.status} class=${r.class} path=${r.path === null ? '-' : r.path} (${r.basis})`,
  coupledSets: r => `coupled set ${r.id} (${r.basis}): ${r.members.join(', ')}`,
  sources: r => `source ${r.name} ${r.file} state=${r.state}${r.sha256 ? ` ${r.sha256}` : ''}${r.reason ? ` (${r.reason})` : ''}`,
  dropped: r => `dropped ${r.section} rows=${r.rows} (${r.reason})`,
};
function identityLine(doc, requested) {
  return `context: schema=${doc.schema} commit=${doc.commit} tree=${doc.tree} base=${doc.base} level=${doc.level} requested=${requested} launchRole=${doc.launchRole} stream=${doc.stream} package=${doc.package === null ? '-' : doc.package} taskSha256=${doc.taskSha256}`;
}
const FULL_SET_LINE = 'full set: the rows of the dropped lines marked level C2, level C1 or packet limit are in the context of level C3, made by protocol-context.cjs resolve --level C3 for the same commit, base, stream, launch role and task; the tests that reach a target only through a chain, which level C3 leaves out for the targets of the branch diff, are listed whole by target in the committed consumer index of the source repository';
function renderContext(doc, requested = doc.level) {
  const lines = [identityLine(doc, requested)];
  lines.push(`rows: ${SECTION_NAMES.filter(s => s !== 'dropped').map(s => `${s} ${rowsOf(doc, s).length}`).join(', ')}`);
  for (const section of SECTION_NAMES) for (const row of rowsOf(doc, section)) lines.push(lineOf[section](row));
  if (doc.dropped.some(d => d.reason.startsWith('level ') || d.reason === TRIM_REASON)) lines.push(FULL_SET_LINE);
  if (requested !== doc.level) lines.push(`lowered: level ${requested} was asked for and level ${doc.level} is delivered, because the packet of the level asked for passes the safety limit; the rows left out are the dropped lines above`);
  const left = trimmedRows(doc);
  if (left) lines.push(`trimmed: ${left} rows of the required set are left out, because the required set alone passes the safety limit; the rows kept stand first by relevance (${TRIM_ORDER.join(', ')}); the rows left out are the dropped lines marked ${TRIM_REASON}`);
  return [`## ${SECTION_TITLE}`, DATA_LINE, '```text', ...lines.map(l => `| ${l}`), '```'].join('\n') + '\n';
}
// The bytes of each section in the rendering, largest first: the offenders of a refused floor.
function sectionBytes(doc) {
  return SECTION_NAMES.map(s => ({ section: s, rows: rowsOf(doc, s).length, bytes: rowsOf(doc, s).reduce((n, r) => n + Buffer.byteLength(`| ${lineOf[s](r)}\n`), 0) }))
    .filter(x => x.rows).sort((a, b) => b.bytes - a.bytes || cmp(a.section, b.section));
}
// The document at the level it asks for, rendered, while it stays inside the room the safety limit of the whole packet leaves. A level that
// does not fit is lowered one step at a time (C3, C2, C1): the rows a lower level keeps are the ones of its relevance rule (keepAt), the rows it
// leaves out are named by their count in the dropped rows, and the rendering says the level was lowered and names the way to the full set.
// The floor C1 is the required set of the targets and is kept at every level; when it alone passes the room, the rows of the trimmable sections
// are kept in the order of trimRank (the largest part that fits, a deterministic prefix) and the tail is named by its count (TRIM_REASON).
// fits is false only when the rows that are never trimmed do not fit; the document of the whole floor is then the one the caller refuses by name.
function fitLevel(doc, room) {
  let last = null;
  for (const level of LEVELS.slice(LEVELS.indexOf(doc.level))) {
    const d = atLevel(doc, level);
    const text = renderContext(d, doc.level);
    last = { doc: d, text, bytes: Buffer.byteLength(text), level, requested: doc.level };
    if (last.bytes <= room) return { ...last, fits: true };
  }
  const targets = new Map(last.doc.targets.map(t => [t.path, t.basis]));
  const pool = [];
  for (const section of SECTION_NAMES) {
    for (const row of rowsOf(last.doc, section)) {
      const rank = trimRank(section, row, targets);
      if (rank !== null) pool.push({ section, row, rank, at: pool.length });
    }
  }
  pool.sort((a, b) => a.rank - b.rank || a.at - b.at);
  const keeping = keep => {
    const picked = new Map();
    for (const { section, row } of pool.slice(keep)) picked.set(section, (picked.get(section) || new Set()).add(row));
    const d = withoutRows(last.doc, picked);
    const text = renderContext(d, doc.level);
    return { doc: d, text, bytes: Buffer.byteLength(text), level: last.level, requested: doc.level };
  };
  let best = null;
  for (let lo = 0, hi = pool.length - 1; lo <= hi;) {
    const mid = (lo + hi) >> 1;
    const tried = keeping(mid);
    if (tried.bytes <= room) { best = tried; lo = mid + 1; } else hi = mid - 1;
  }
  return best ? { ...best, fits: true } : { ...last, fits: false };
}
// The identity line of a delivered context section, for the staleness check of a packet: { commit, tree } or null.
const IDENTITY_RE = /^\| context: schema=task-context\/1 commit=([0-9a-f]{40}|[0-9a-f]{64}) tree=([0-9a-f]{40}|[0-9a-f]{64}) /;
function deliveredIdentity(body) {
  const head = `\n## ${SECTION_TITLE}\n${DATA_LINE}\n\`\`\`text\n`;
  const at = body.lastIndexOf(head);
  if (at < 0) return null;
  const line = body.slice(at + head.length).split('\n', 1)[0];
  const m = IDENTITY_RE.exec(line);
  return m ? { commit: m[1], tree: m[2] } : null;
}

module.exports = {
  SCHEMA, KEYS, HISTORY_KEYS, LAUNCH_ROLES, SWITCH_STATES, LEVELS, REACH, HEAVY_MS, HEAVY_NAME, FINDING_CLASSES, SEVERITIES, TIERS, OPEN_BASIS,
  DROP_REASONS, SECTIONS, SECTION_NAMES, SECTION_TITLE, DATA_LINE, G, safePath, cmp, rowsOf, keyOf, SEVERE, findingClassOf,
  TRIM_ORDER, TRIM_REASON, checkContext, serialize, atLevel, renderContext, sectionBytes, fitLevel, deliveredIdentity, trimmedRows,
};

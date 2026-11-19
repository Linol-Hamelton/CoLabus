'use strict';
// decompose-flow.cjs - what happens to an approved decomposition record: the result of a child (child-result/1), its
// acceptance by a reviewer of another family (child-acceptance/1), the assembly of the parent (assembly/1), the
// ledger of the record and its state machine. Rule ids TD-nn are those of the task decomposition specification.
//
// checkResult(record, childId, result, tree)                  -> { ok, refusals, hash, entry }
// checkAcceptance(record, childId, resultEntry, acceptance, { reject, run }) -> { ok, refusals, hash, entry }
// checkAssembly(record, results, acceptances, assembly, tree) -> { ok, refusals, hash, entry }
// checkLedger(record, previous)                               -> { ok, refusals }
// nextState(record, event)                                    -> { ok, record, refusals }
// acceptedOf(record) -> { results, acceptances }: the accepted result and acceptance entry of each child, by child id
// latestResult(record, childId) -> the ledger entry of the last result of the child under the current contract, or null
// hashOf(doc) -> sha256 of the schema name, a new line and the canonical JSON of the document
// parseText(text) -> { ok, doc } | { ok: false, refusals }; checkForm(doc, kind) -> { ok, refusals } (kind: result, acceptance, assembly)
//
// Pure: no file system, no clock, no environment, no child process. The facts about commits and trees come in `tree`,
// which the caller reads from the git objects (the CLI .ai/bin/protocol-decompose.cjs). A refusal is a value, never an
// exception. The record passed in has passed decompose.validate; these functions read a record of the right shape only.
const decompose = require('./decompose.cjs');
const textSafe = require('./text-safe.cjs');

const { ID, FAMILY, SHA1, SHA256, SESSION, CAUSE, PATH_CHARS, MAX_PATH, ROUTE } = decompose.GRAMMAR;
// The closed list of refusals of results, acceptances, assemblies and transitions, in the order a report lists them (TD-60).
const CODES = Object.freeze(['SCHEMA', 'DUPLICATE_KEY', 'RESULT_UNBOUND', 'RESULT_SCOPE', 'RESULT_INCOMPLETE', 'ACCEPT_FAMILY',
  'ACCEPT_NOT_RERUN', 'ACCEPT_VERDICT', 'ASSEMBLY_ORDER', 'ASSEMBLY_DRIFT', 'ASSEMBLY_CONFLICT', 'ASSEMBLY_COVERAGE', 'CERT_FAMILY',
  'STATE', 'COUNTER', 'REPLAY']);
const SCHEMAS = Object.freeze({ result: 'child-result/1', acceptance: 'child-acceptance/1', assembly: 'assembly/1' });
const VERDICTS = Object.freeze(['PASS', 'RECOMMENDATION', 'FAIL', 'BLOCKED']);
const PASSING = new Set(['PASS', 'RECOMMENDATION']);
const KINDS = Object.freeze(['positive', 'negative']);
// Child moves by event: the states it may leave and the state it enters (TD-70). Nothing else moves a child.
const CHILD_MOVES = Object.freeze({
  ready: [['planned'], 'ready'],
  start: [['ready', 'rejected'], 'running'],
  result: [['running'], 'submitted'],
  accept: [['submitted'], 'accepted'],
  reject: [['submitted'], 'rejected'],
  // A seat that ended its attempt without the marker of the child: a named rejection of the running attempt (TD-87).
  lost: [['running'], 'rejected'],
});
const DONE_CHILD = new Set(['accepted', 'integrated']);

const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const fold = p => p.toLowerCase();
const clone = v => JSON.parse(JSON.stringify(v));
const exitOk = v => v === 0;
const unknownText = v => (decompose.isUnknown(v) ? `unknown (${v.reason})` : String(v));

function hashOf(doc) { return decompose.sha256(`${doc.schema}\n${decompose.canonical(doc)}`); }

// The text of an evidence document: JSON with unique keys (a repeated key is DUPLICATE_KEY, never last-wins).
function parseText(text) {
  try { return { ok: true, doc: textSafe.parseJsonUnique(text), refusals: [] }; } catch (e) {
    const r = new Report();
    if (e && e.code === 'JSON_DUPLICATE_KEY') r.add('DUPLICATE_KEY', 'document', 'a key appears twice in one object');
    else r.add('SCHEMA', 'document', 'is not JSON');
    return r.done();
  }
}

class Report {
  constructor() { this.refusals = []; }
  add(code, where, detail) { this.refusals.push({ code, where, detail }); }
  has(...codes) { return this.refusals.some(r => codes.includes(r.code)); }
  done(extra = {}) {
    const rank = new Map(CODES.map((c, i) => [c, i]));
    const refusals = [...this.refusals].sort((a, b) => rank.get(a.code) - rank.get(b.code) || (a.where < b.where ? -1 : a.where > b.where ? 1 : 0) || (a.detail < b.detail ? -1 : a.detail > b.detail ? 1 : 0));
    return { ok: refusals.length === 0, refusals, ...extra };
  }
}

// ---------- the form of the three documents (SCHEMA) ----------

function form(doc, kind, r) {
  const schema = (where, detail) => r.add('SCHEMA', where, detail);
  const keys = (obj, where, allowed, required = allowed) => {
    if (!isObject(obj)) { schema(where, 'is not an object'); return false; }
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) schema(`${where}.${k}`, `is not a field of ${SCHEMAS[kind]}`);
    for (const k of required) if (!Object.hasOwn(obj, k)) schema(`${where}.${k}`, 'is missing');
    return true;
  };
  const match = (v, re, where, what) => { if (typeof v !== 'string' || !re.test(v)) schema(where, `is not ${what}`); };
  const list = (v, where, min, max, each) => {
    if (!Array.isArray(v)) { schema(where, 'is not a list'); return; }
    if (v.length < min || v.length > max) schema(where, `holds ${min} to ${max} entries`);
    v.forEach((x, i) => each(x, `${where}[${i}]`));
  };
  const pathOf = (v, where) => { if (typeof v !== 'string' || v.length > MAX_PATH || !PATH_CHARS.test(v)) schema(where, 'is not a repository path'); };
  // A value that may be unknown is the value itself or { value: null, reason }; a bare null, 0 or empty is never unknown (TD-29).
  const maybe = (v, where, proper) => {
    if (decompose.isUnknown(v)) {
      if (Object.keys(v).some(k => k !== 'value' && k !== 'reason') || typeof v.reason !== 'string' || decompose.textProblem(v.reason) !== null) schema(where, 'an unknown value is exactly { value: null, reason } with a reason');
      return;
    }
    proper(v, where);
  };
  const family = (v, where) => maybe(v, where, (x, w) => match(x, FAMILY, w, 'a family name'));
  const party = (v, where) => { if (keys(v, where, ['family', 'session'])) { family(v.family, `${where}.family`); match(v.session, SESSION, `${where}.session`, 'a session owner name'); } };
  const exit = (v, where) => maybe(v, where, (x, w) => { if (!Number.isInteger(x) || x < 0 || x > 255) schema(w, 'is not an exit code 0..255'); });
  const head = ['schema', 'parent', 'contractHash'];

  if (!isObject(doc)) { schema(kind, 'is not an object'); return; }
  if (doc.schema !== SCHEMAS[kind]) schema(`${kind}.schema`, `is not ${SCHEMAS[kind]}`);
  if (kind === 'result') {
    if (!keys(doc, 'result', [...head, 'child', 'attempt', 'author', 'base', 'start', 'dependencies', 'commit', 'tree', 'changed', 'outputs', 'commands', 'terminal'])) return;
    match(doc.child, ID, 'result.child', 'an id');
    if (!Number.isInteger(doc.attempt) || doc.attempt < 1 || doc.attempt > 9999) schema('result.attempt', 'is not an integer 1..9999');
    party(doc.author, 'result.author');
    for (const k of ['base', 'start', 'commit', 'tree']) match(doc[k], SHA1, `result.${k}`, 'a full commit or tree id');
    list(doc.dependencies, 'result.dependencies', 0, decompose.MAX_CHILDREN, (d, w) => {
      if (keys(d, w, ['child', 'result', 'commit'])) { match(d.child, ID, `${w}.child`, 'an id'); match(d.result, SHA256, `${w}.result`, 'a sha256'); match(d.commit, SHA1, `${w}.commit`, 'a full commit id'); }
    });
    list(doc.changed, 'result.changed', 0, 1024, pathOf);
    list(doc.outputs, 'result.outputs', 0, 1024, (o, w) => { if (keys(o, w, ['path', 'blob'])) { pathOf(o.path, `${w}.path`); match(o.blob, SHA1, `${w}.blob`, 'a blob id'); } });
    list(doc.commands, 'result.commands', 0, 32, (c, w) => {
      if (keys(c, w, ['kind', 'command', 'exit'])) { if (!KINDS.includes(c.kind)) schema(`${w}.kind`, 'is not positive or negative'); if (typeof c.command !== 'string') schema(`${w}.command`, 'is not text'); exit(c.exit, `${w}.exit`); }
    });
    if (keys(doc.terminal, 'result.terminal', ['marker', 'exit'])) { if (typeof doc.terminal.marker !== 'string') schema('result.terminal.marker', 'is not text'); exit(doc.terminal.exit, 'result.terminal.exit'); }
  } else if (kind === 'acceptance') {
    // cause names the class of a rejection; an acceptance has none.
    const fields = [...head, 'child', 'result', 'reviewer', 'verdict', 'rerun', 'findings'];
    if (!keys(doc, 'acceptance', [...fields, 'cause'], fields)) return;
    match(doc.child, ID, 'acceptance.child', 'an id');
    match(doc.result, SHA256, 'acceptance.result', 'a sha256');
    party(doc.reviewer, 'acceptance.reviewer');
    if (typeof doc.verdict !== 'string') schema('acceptance.verdict', 'is not text');
    if (Object.hasOwn(doc, 'cause')) match(doc.cause, CAUSE, 'acceptance.cause', 'a cause name');
    if (keys(doc.rerun, 'acceptance.rerun', ['commit', 'tree', 'clean', 'commands'])) {
      match(doc.rerun.commit, SHA1, 'acceptance.rerun.commit', 'a full commit id');
      match(doc.rerun.tree, SHA1, 'acceptance.rerun.tree', 'a full tree id');
      if (typeof doc.rerun.clean !== 'boolean') schema('acceptance.rerun.clean', 'is not true or false');
      list(doc.rerun.commands, 'acceptance.rerun.commands', 0, 64, (c, w) => {
        if (!keys(c, w, ['kind', 'command', 'at', 'exit'])) return;
        if (!KINDS.includes(c.kind)) schema(`${w}.kind`, 'is not positive or negative');
        if (typeof c.command !== 'string') schema(`${w}.command`, 'is not text');
        if (c.at !== 'commit' && c.at !== 'start') schema(`${w}.at`, 'is not commit or start');
        exit(c.exit, `${w}.exit`);
      });
    }
    list(doc.findings, 'acceptance.findings', 0, 32, (x, w) => { const p = decompose.textProblem(x); if (p) schema(w, p); });
  } else {
    if (!keys(doc, 'assembly', [...head, 'base', 'integrator', 'planner', 'merges', 'head', 'tree', 'checks'])) return;
    match(doc.base, SHA1, 'assembly.base', 'a full commit id');
    party(doc.integrator, 'assembly.integrator');
    if (keys(doc.planner, 'assembly.planner', ['family'])) family(doc.planner.family, 'assembly.planner.family');
    list(doc.merges, 'assembly.merges', 0, decompose.MAX_CHILDREN * 2, (m, w) => {
      if (keys(m, w, ['child', 'result', 'acceptance', 'commit'])) { match(m.child, ID, `${w}.child`, 'an id'); match(m.result, SHA256, `${w}.result`, 'a sha256'); match(m.acceptance, SHA256, `${w}.acceptance`, 'a sha256'); match(m.commit, SHA1, `${w}.commit`, 'a full commit id'); }
    });
    match(doc.head, SHA1, 'assembly.head', 'a full commit id');
    match(doc.tree, SHA1, 'assembly.tree', 'a full tree id');
    list(doc.checks, 'assembly.checks', 0, 16, (c, w) => { if (keys(c, w, ['id', 'command', 'exit'])) { if (typeof c.id !== 'string') schema(`${w}.id`, 'is not text'); if (typeof c.command !== 'string') schema(`${w}.command`, 'is not text'); exit(c.exit, `${w}.exit`); } });
  }
  if (typeof doc.parent !== 'string' || !ID.test(doc.parent)) schema(`${kind}.parent`, 'is not an id');
  if (typeof doc.contractHash !== 'string' || !SHA256.test(doc.contractHash)) schema(`${kind}.contractHash`, 'is not a sha256');
}

// The form of one document alone, before any fact about the tree is read for it.
function checkForm(doc, kind) { const r = new Report(); form(doc, kind, r); return r.done(); }

// ---------- the ledger and its replay ----------

const ledgerOf = record => (Array.isArray(record.ledger) ? record.ledger : []);
const current = (record, e) => e.contract === record.parent.contractHash;
// The lineage group of a ledger child id: the child of the record that is that id or names it as a former id.
function groupOf(record) {
  const map = new Map();
  for (const c of record.children) { map.set(c.id, c.id); for (const f of c.formerIds || []) if (!map.has(f)) map.set(f, c.id); }
  return id => map.get(id) || `former:${id}`;
}
// How many starts and rejections a lineage holds, whatever the contract revision: a rename never resets them (TD-53).
function lineageCounts(record) {
  const group = groupOf(record);
  const counts = new Map();
  const of = id => { const g = group(id); if (!counts.has(g)) counts.set(g, { attempts: 0, rounds: 0 }); return counts.get(g); };
  for (const e of ledgerOf(record)) { if (e.type === 'start') of(e.child).attempts++; if (e.type === 'reject' || e.type === 'lost') of(e.child).rounds++; }
  return { of: id => counts.get(group(id)) || { attempts: 0, rounds: 0 }, totals: [...counts.values()].reduce((t, c) => ({ attempts: t.attempts + c.attempts, rounds: t.rounds + c.rounds }), { attempts: 0, rounds: 0 }) };
}

// Replay the entries of the current contract from the planned states. A move that is not legal from the replayed state is
// STATE; an evidence hash or a result commit seen twice is REPLAY (TD-69, TD-71).
function replay(record) {
  const problems = [];
  const states = new Map(record.children.map(c => [c.id, 'planned']));
  let parent = 'planned';
  const results = new Map(); const accepted = new Map(); const acceptances = new Map(); const starts = new Map();
  const hashes = new Map(); const commits = new Map();
  ledgerOf(record).forEach((e, i) => {
    const where = `ledger[${i}]`;
    if (e.hash) { if (hashes.has(e.hash)) problems.push(['REPLAY', where, `repeats the evidence of ${hashes.get(e.hash)}`]); else hashes.set(e.hash, where); }
    if (e.type === 'result') { if (commits.has(e.commit)) problems.push(['REPLAY', where, `the commit ${e.commit} is already the result of ${commits.get(e.commit)}`]); else commits.set(e.commit, where); }
    if (!current(record, e)) return;
    if (Object.hasOwn(CHILD_MOVES, e.type)) {
      if (!states.has(e.child)) { problems.push(['STATE', where, `${e.child} is not a child of this contract`]); return; }
      const [from, to] = CHILD_MOVES[e.type];
      if (!from.includes(states.get(e.child))) { problems.push(['STATE', where, `${e.type} of ${e.child} from ${states.get(e.child)}`]); return; }
      states.set(e.child, to);
      if (e.type === 'start') starts.set(e.child, e);
      if (e.type === 'result') results.set(e.child, e);
      if (e.type === 'accept' || e.type === 'reject') {
        const last = results.get(e.child);
        if (!last || last.hash !== e.result) problems.push(['STATE', where, `the verdict does not name the last result of ${e.child}`]);
      }
      if (e.type === 'accept') { accepted.set(e.child, results.get(e.child)); acceptances.set(e.child, e); }
    } else if (e.type === 'integrate') {
      if (parent !== 'planned') problems.push(['STATE', where, `integrate from ${parent}`]); else parent = 'integrating';
    } else if (e.type === 'assemble') {
      if (parent !== 'planned' && parent !== 'integrating') problems.push(['STATE', where, `assemble from ${parent}`]);
      else if ([...states.values()].some(s => s !== 'accepted')) problems.push(['STATE', where, 'assemble before every child is accepted']);
      else { parent = 'assembled'; for (const id of states.keys()) states.set(id, 'integrated'); }
    }
  });
  return { states, parent, results, accepted, acceptances, starts, hashes, commits, problems };
}

function latestResult(record, childId) { return replay(record).results.get(childId) || null; }
function acceptedOf(record) {
  const r = replay(record);
  return { results: Object.fromEntries(r.accepted), acceptances: Object.fromEntries(r.acceptances) };
}

// The record and its ledger agree: the ledger only grows, every state is the replayed state, the counters hold the
// lineage, a renamed child names its former ids, and nothing is replayed (TD-52, TD-53, TD-71).
function checkLedger(record, previous) {
  const r = new Report();
  const ledger = ledgerOf(record);
  if (previous && previous.unreadable) r.add('COUNTER', 'ledger', 'the record at the base commit cannot be read, so the ledger cannot be compared');
  else if (previous) {
    const before = Array.isArray(previous.ledger) ? previous.ledger : [];
    if (before.length > ledger.length || before.some((e, i) => decompose.canonical(e) !== decompose.canonical(ledger[i]))) r.add('COUNTER', 'ledger', 'the ledger is append only; an entry of the record at the base commit is gone or changed');
  }
  const ids = new Set(record.children.map(c => c.id));
  const history = new Set(ledger.filter(e => e.child).map(e => e.child));
  const claimed = new Map();
  record.children.forEach((c, i) => (c.formerIds || []).forEach(f => {
    if (ids.has(f)) r.add('COUNTER', `children[${i}].formerIds`, `${f} is a child of this record, not a former id`);
    else if (!history.has(f)) r.add('COUNTER', `children[${i}].formerIds`, `${f} has no history in the ledger`);
    if (claimed.has(f)) r.add('COUNTER', `children[${i}].formerIds`, `${f} is already the former id of ${claimed.get(f)}`);
    claimed.set(f, c.id);
  }));
  // A child that takes the paths of a child with history and does not name it would start a fresh lineage: refused.
  const group = groupOf(record);
  for (const e of ledger) {
    if (e.type !== 'start' || !group(e.child).startsWith('former:')) continue;
    record.children.forEach((c, i) => {
      const hit = c.writeSet.find(w => e.paths.some(p => fold(p) === fold(w)));
      if (hit) r.add('COUNTER', `children[${i}].formerIds`, `${c.id} writes ${hit} of the former child ${e.child} without naming it as a former id`);
    });
  }
  const seen = new Set();
  const replayed = replay(record);
  for (const [code, where, detail] of replayed.problems) if (!seen.has(`${code}${where}`)) { seen.add(`${code}${where}`); r.add(code, where, detail); }
  record.children.forEach((c, i) => { const s = replayed.states.get(c.id); if (c.state !== s) r.add('STATE', `children[${i}].state`, `is ${c.state}; the ledger gives ${s}`); });
  if (record.parent.state !== replayed.parent) r.add('STATE', 'parent.state', `is ${record.parent.state}; the ledger gives ${replayed.parent}`);
  const counts = lineageCounts(record);
  record.children.forEach((c, i) => {
    const n = counts.of(c.id);
    for (const k of ['attempts', 'rounds']) if (c.counters[k] < n[k]) r.add('COUNTER', `children[${i}].counters.${k}`, `${c.counters[k]} is below the ${n[k]} of its lineage in the ledger`);
    if (n.attempts > record.parent.budget.attempts) r.add('COUNTER', `children[${i}]`, `the lineage holds ${n.attempts} attempts; the budget is ${record.parent.budget.attempts}`);
  });
  for (const k of ['attempts', 'rounds']) if (record.parent.counters[k] < counts.totals[k]) r.add('COUNTER', `parent.counters.${k}`, `${record.parent.counters[k]} is below the ${counts.totals[k]} of the ledger`);
  for (const k of ['attempts', 'rounds']) if (counts.totals[k] > record.parent.budget.total[k]) r.add('COUNTER', 'parent.budget.total', `the ledger holds ${counts.totals[k]} ${k}; the total of the parent is ${record.parent.budget.total[k]}`);
  return r.done();
}

// ---------- the result of a child ----------

const changedPaths = changes => [...new Set(changes.flatMap(c => (c.from ? [c.from, c.path] : [c.path])))];

// A child result binds the contract, the child, the attempt, the base, the start and the pinned dependencies to one
// commit and its tree; its diff is the commit's own diff and stays inside the write set; every command ran and exited 0
// and the session ended on its marker. DONE gives submitted, never accepted (TD-61..TD-64).
function checkResult(record, childId, result, tree) {
  const r = new Report();
  form(result, 'result', r);
  const child = record.children.find(c => c.id === childId);
  if (!child) { r.add('STATE', 'child', `${childId} is not a child of the record`); return r.done(); }
  if (r.has('SCHEMA')) return r.done();
  const hash = hashOf(result);
  const replayed = replay(record);
  const p = record.parent;

  if (replayed.states.get(child.id) !== 'running') r.add('STATE', 'child', `${child.id} is ${replayed.states.get(child.id)}; a result is submitted by a running child`);
  if (replayed.hashes.has(hash)) r.add('REPLAY', 'result', `the same result is already ${replayed.hashes.get(hash)}`);
  if (replayed.commits.has(result.commit)) r.add('REPLAY', 'result.commit', `the commit is already the result of ${replayed.commits.get(result.commit)}`);

  const unbound = (where, detail) => r.add('RESULT_UNBOUND', where, detail);
  if (result.parent !== p.id) unbound('result.parent', `names ${result.parent}, not ${p.id}`);
  if (result.child !== child.id) unbound('result.child', `names ${result.child}, not ${child.id}`);
  if (result.contractHash !== p.contractHash) unbound('result.contractHash', 'is not the contract hash of the record');
  if (result.base !== p.base) unbound('result.base', 'is not the base of the parent');
  const start = replayed.starts.get(child.id);
  if (start && result.attempt !== start.attempt) unbound('result.attempt', `is not the running attempt ${start.attempt}`);
  // A family is compared as the family the table of the record says it stands for; an undeclared name is no family (TD-82).
  const familyOf = decompose.familyTable(record);
  const author = decompose.isUnknown(result.author.family) ? null : familyOf(result.author.family);
  if (!author && typeof result.author.family === 'string') unbound('result.author.family', `${result.author.family} is not a family the kernel family fold knows`);
  else if (!author || author !== familyOf(child.author.family)) unbound('result.author.family', `is ${unknownText(result.author.family)}; the record names ${unknownText(child.author.family)}`);
  if (tree.commit !== result.commit) unbound('result.commit', 'is not a commit of the repository');
  else if (tree.tree !== result.tree) unbound('result.tree', 'is not the tree of the commit');
  if (tree.start !== result.start) unbound('result.start', 'is not a commit of the repository');
  else {
    if (!tree.startFromBase) unbound('result.start', 'does not descend from the base of the parent');
    if (!tree.commitFromStart) unbound('result.commit', 'does not descend from the start');
  }
  // Every dependency is pinned by the hash of its accepted result and the commit of that result (TD-62).
  const deps = [...child.dependsOn].sort();
  const named = result.dependencies.map(d => d.child).sort();
  if (deps.join(',') !== named.join(',')) unbound('result.dependencies', `names ${named.join(' ') || 'none'}; the child depends on ${deps.join(' ') || 'none'}`);
  const depPaths = new Set();
  result.dependencies.forEach((d, i) => {
    const pin = replayed.accepted.get(d.child);
    if (!pin) { unbound(`result.dependencies[${i}]`, `${d.child} is not accepted`); return; }
    if (pin.hash !== d.result || pin.commit !== d.commit) unbound(`result.dependencies[${i}]`, `is not the accepted result of ${d.child}`);
    else if (!tree.dependencyAncestors || tree.dependencyAncestors[d.commit] !== true) unbound(`result.dependencies[${i}]`, `the start does not hold the accepted commit of ${d.child}`);
    for (const x of pin.changed) depPaths.add(fold(x));
  });
  if (tree.start === result.start) {
    const extra = (tree.startChanges || []).find(x => !depPaths.has(fold(x)));
    if (extra) unbound('result.start', `changes ${extra} against the base, which no accepted dependency changed`);
  }
  if (r.has('RESULT_UNBOUND')) return r.done({ hash });

  // The diff is the commit's own (rename: old and new both count); the claim must equal it (TD-63).
  const actual = changedPaths(tree.changes);
  const claim = [...result.changed].map(fold).sort();
  if (claim.join('\n') !== actual.map(fold).sort().join('\n')) unbound('result.changed', `is not the diff of the commit (${actual.join(' ') || 'nothing'})`);
  // A sibling that writes a path of this write set is joined to it by a dependency edge (TD-18), so only the prohibitions
  // and the integrator paths remain to compare.
  const forbidden = [...p.forbidden, ...child.forbidden, ...record.assembly.integratorPaths];
  const covers = (e, x) => (e.endsWith('/') ? fold(x).startsWith(fold(e)) : fold(x) === fold(e));
  for (const x of actual) {
    if (!child.writeSet.some(w => fold(w) === fold(x))) r.add('RESULT_SCOPE', 'result.changed', `${x} is outside the write set`);
    else { const hit = forbidden.find(f => covers(f, x)); if (hit) r.add('RESULT_SCOPE', 'result.changed', `${x} is forbidden by ${hit}`); }
    const kind = tree.entries[x] ? tree.entries[x].kind : null;
    if (kind === 'link' || kind === 'gitlink') r.add('RESULT_SCOPE', 'result.changed', `${x} is a link or a submodule; an output is a file`);
  }

  // Complete: something changed, every existing changed path has its output, every command of the contract ran and
  // exited 0, and the session ended on the marker of the child with exit 0. Unknown is never 0 (TD-64).
  const incomplete = (where, detail) => r.add('RESULT_INCOMPLETE', where, detail);
  if (!actual.length) incomplete('result.changed', 'the commit changes nothing');
  const present = actual.filter(x => tree.entries[x]);
  const outs = new Map(result.outputs.map(o => [fold(o.path), o.blob]));
  for (const x of present) {
    if (!outs.has(fold(x))) incomplete('result.outputs', `${x} has no output hash`);
    else if (outs.get(fold(x)) !== tree.entries[x].blob) unbound('result.outputs', `the hash of ${x} is not its blob at the commit`);
  }
  for (const o of result.outputs) if (!present.some(x => fold(x) === fold(o.path))) incomplete('result.outputs', `${o.path} is not a changed file of the commit`);
  for (const kind of KINDS) for (const x of child.acceptance[kind]) {
    const ran = result.commands.filter(c => c.kind === kind && c.command === x.command);
    if (!ran.length) incomplete('result.commands', `the ${kind} command ${x.command} was not run`);
    else if (!ran.every(c => exitOk(c.exit))) incomplete('result.commands', `the ${kind} command ${x.command} exited ${ran.map(c => unknownText(c.exit)).join(' ')}`);
  }
  const contract = new Set(KINDS.flatMap(k => child.acceptance[k].map(x => `${k} ${x.command}`)));
  for (const c of result.commands) if (!contract.has(`${c.kind} ${c.command}`)) unbound('result.commands', `${c.command} is not a ${c.kind} command of the contract`);
  if (result.terminal.marker !== child.marker) incomplete('result.terminal.marker', `is not the marker ${child.marker} of the child`);
  if (!exitOk(result.terminal.exit)) incomplete('result.terminal.exit', `is ${unknownText(result.terminal.exit)}; a submitted child ended with exit 0`);

  const entry = { type: 'result', revision: record.revision, contract: p.contractHash, child: child.id, attempt: result.attempt, hash,
    author: author || '', start: result.start, commit: result.commit, tree: result.tree, changed: actual,
    outputs: present.map(x => ({ path: x, blob: tree.entries[x].blob })) };
  return r.done({ hash, entry });
}

// ---------- the acceptance of a child ----------

// One reviewer of another family, the one the record names, accepts the last result of the child: the commands of the
// contract were rerun on a clean tree at the child commit and exited 0, and the negative command was rerun at the start,
// where it must not pass: a negative check that passes without the change shows nothing about it (TD-65..TD-67).
// With { reject: true } the same document with a FAIL or BLOCKED verdict and a cause is a named rejection (TD-68).
// With { run } the commands were rerun by the tool itself ({ clean, commands, environment }): the document records
// exactly those runs with exactly those exits, and the entry names the digest of the environment of the run (TD-81).
function checkAcceptance(record, childId, resultEntry, acceptance, { reject = false, run = null } = {}) {
  const r = new Report();
  form(acceptance, 'acceptance', r);
  const child = record.children.find(c => c.id === childId);
  if (!child) { r.add('STATE', 'child', `${childId} is not a child of the record`); return r.done(); }
  if (r.has('SCHEMA')) return r.done();
  const hash = hashOf(acceptance);
  const replayed = replay(record);
  const p = record.parent;
  if (replayed.states.get(child.id) !== 'submitted') r.add('STATE', 'child', `${child.id} is ${replayed.states.get(child.id)}; a verdict is given on a submitted child`);
  if (!resultEntry) { r.add('STATE', 'child', `${child.id} has no result under this contract`); return r.done({ hash }); }
  if (replayed.hashes.has(hash)) r.add('REPLAY', 'acceptance', `the same verdict is already ${replayed.hashes.get(hash)}`);
  if (acceptance.result !== resultEntry.hash) {
    if (replayed.hashes.has(acceptance.result)) r.add('REPLAY', 'acceptance.result', `names the result ${replayed.hashes.get(acceptance.result)}, not the last result of ${child.id}`);
    else r.add('RESULT_UNBOUND', 'acceptance.result', `is not the hash of the last result of ${child.id}`);
  }
  if (acceptance.parent !== p.id) r.add('RESULT_UNBOUND', 'acceptance.parent', `names ${acceptance.parent}, not ${p.id}`);
  if (acceptance.child !== child.id) r.add('RESULT_UNBOUND', 'acceptance.child', `names ${acceptance.child}, not ${child.id}`);
  if (acceptance.contractHash !== p.contractHash) r.add('RESULT_UNBOUND', 'acceptance.contractHash', 'is not the contract hash of the record');

  const familyOf = decompose.familyTable(record);
  const reviewer = decompose.isUnknown(acceptance.reviewer.family) ? null : familyOf(acceptance.reviewer.family);
  const planned = familyOf(child.reviewer.family);
  const authors = [familyOf(resultEntry.author), familyOf(child.author.family)].filter(Boolean);
  if (!reviewer && typeof acceptance.reviewer.family === 'string') r.add('ACCEPT_FAMILY', 'acceptance.reviewer.family', `${acceptance.reviewer.family} is not a family the kernel family fold knows`);
  else if (!reviewer) r.add('ACCEPT_FAMILY', 'acceptance.reviewer.family', 'is unknown; independence cannot be shown');
  else if (authors.includes(reviewer)) r.add('ACCEPT_FAMILY', 'acceptance.reviewer.family', `${reviewer} is the family of the author`);
  else if (reviewer !== planned) r.add('ACCEPT_FAMILY', 'acceptance.reviewer.family', `${reviewer} is not the reviewer ${unknownText(child.reviewer.family)} the record names`);

  const v = acceptance.verdict;
  if (!VERDICTS.includes(v)) r.add('ACCEPT_VERDICT', 'acceptance.verdict', `${v} is not one of ${VERDICTS.join(', ')}`);
  else if (!reject && !PASSING.has(v)) r.add('ACCEPT_VERDICT', 'acceptance.verdict', `${v} accepts nothing; a FAIL or BLOCKED verdict is a rejection`);
  else if (reject && PASSING.has(v)) r.add('ACCEPT_VERDICT', 'acceptance.verdict', `${v} rejects nothing`);
  const cause = Object.hasOwn(acceptance, 'cause') ? acceptance.cause : null;
  if (reject && !cause) r.add('ACCEPT_VERDICT', 'acceptance.cause', 'a rejection names its cause');
  if (!reject && cause) r.add('ACCEPT_VERDICT', 'acceptance.cause', 'an acceptance names no cause of rejection');

  const rerun = acceptance.rerun;
  const notRerun = (where, detail) => r.add('ACCEPT_NOT_RERUN', where, detail);
  if (rerun.commit !== resultEntry.commit) notRerun('acceptance.rerun.commit', 'is not the commit of the result');
  if (rerun.tree !== resultEntry.tree) notRerun('acceptance.rerun.tree', 'is not the tree of the result');
  if (rerun.clean !== true) notRerun('acceptance.rerun.clean', 'the commands were not rerun on a clean tree');
  if (!reject) {
    for (const kind of KINDS) for (const x of child.acceptance[kind]) {
      const ran = rerun.commands.filter(c => c.kind === kind && c.command === x.command && c.at === 'commit');
      if (!ran.length) notRerun('acceptance.rerun.commands', `the ${kind} command ${x.command} was not rerun at the child commit`);
      else if (!ran.every(c => exitOk(c.exit))) notRerun('acceptance.rerun.commands', `the ${kind} command ${x.command} exited ${ran.map(c => unknownText(c.exit)).join(' ')} at the child commit`);
    }
    for (const x of child.acceptance.negative) {
      const control = rerun.commands.filter(c => c.kind === 'negative' && c.command === x.command && c.at === 'start');
      if (!control.length) notRerun('acceptance.rerun.commands', `the negative command ${x.command} was not rerun at the start`);
      else if (control.some(c => decompose.isUnknown(c.exit) || c.exit === 0)) notRerun('acceptance.rerun.commands', `the negative command ${x.command} passed or is unknown at the start (${control.map(c => unknownText(c.exit)).join(' ')}), so it shows nothing about the change`);
    }
  }
  if (run) {
    const key = c => `${c.kind} ${c.at} ${c.command}`;
    const recorded = new Map();
    for (const c of rerun.commands) { if (!recorded.has(key(c))) recorded.set(key(c), []); recorded.get(key(c)).push(c); }
    if (run.clean !== true) notRerun('acceptance.rerun.clean', 'the tool found a tree of the run not clean');
    for (const o of run.commands) {
      const got = recorded.get(key(o)) || [];
      if (!got.length) notRerun('acceptance.rerun.commands', `the tool ran the ${o.kind} command ${o.command} at the ${o.at}; the document does not record it`);
      else if (got.some(c => decompose.canonical(c.exit) !== decompose.canonical(o.exit))) notRerun('acceptance.rerun.commands', `the ${o.kind} command ${o.command} exited ${unknownText(o.exit)} at the ${o.at} in the run of the tool; the document records ${got.map(c => unknownText(c.exit)).join(' ')}`);
    }
    for (const [k, list] of recorded) if (!run.commands.some(o => key(o) === k)) notRerun('acceptance.rerun.commands', `the document records the ${list[0].kind} command ${list[0].command} at the ${list[0].at}, which the tool did not run`);
  }
  const entry = { type: reject ? 'reject' : 'accept', revision: record.revision, contract: p.contractHash, child: child.id,
    result: resultEntry.hash, hash, reviewer: reviewer || '', verdict: v, ...(reject ? { cause } : {}), ...(run ? { environment: run.environment } : {}) };
  return r.done({ hash, entry });
}

// ---------- the assembly of the parent ----------

// The parent is assembled only from accepted children, merged in the approved order, each pinned by the hashes of its
// accepted result and acceptance. The assembled tree changes nothing outside the union of the accepted child diffs and
// the integrator paths, holds every accepted output as accepted (the last writer in merge order wins), passes every
// assembly check, and the certifiers are outside every child author, the integrator and the planner. Green children
// never replace the check of the whole (TD-72..TD-76).
function checkAssembly(record, results, acceptances, assembly, tree) {
  const r = new Report();
  form(assembly, 'assembly', r);
  if (r.has('SCHEMA')) return r.done();
  const hash = hashOf(assembly);
  const replayed = replay(record);
  const p = record.parent;
  if (p.state !== 'planned' && p.state !== 'integrating') r.add('STATE', 'parent', `${p.id} is ${p.state}; a parent is assembled from planned or integrating`);
  if (replayed.hashes.has(hash)) r.add('REPLAY', 'assembly', `the same assembly is already ${replayed.hashes.get(hash)}`);
  const drift = (where, detail) => r.add('ASSEMBLY_DRIFT', where, detail);
  if (assembly.parent !== p.id) drift('assembly.parent', `names ${assembly.parent}, not ${p.id}`);
  if (assembly.contractHash !== p.contractHash) drift('assembly.contractHash', 'is not the contract hash of the record');
  if (assembly.base !== p.base) drift('assembly.base', 'is not the base of the parent');
  if (tree.head !== assembly.head) drift('assembly.head', 'is not a commit of the repository');
  else if (tree.tree !== assembly.tree) drift('assembly.tree', 'is not the tree of the head');
  else if (!tree.headFromBase) drift('assembly.head', 'does not descend from the base of the parent');

  // Order: every child once, accepted, in the approved merge order, never before what it depends on (TD-72).
  const order = (where, detail) => r.add('ASSEMBLY_ORDER', where, detail);
  const merged = assembly.merges.map(m => m.child);
  if (merged.join(' ') !== record.assembly.order.join(' ')) order('assembly.merges', `merges ${merged.join(' ') || 'nothing'}; the approved order is ${record.assembly.order.join(' ')}`);
  const pos = new Map(merged.map((id, i) => [id, i]));
  for (const c of record.children) {
    for (const d of c.dependsOn) if (pos.has(c.id) && (!pos.has(d) || pos.get(d) > pos.get(c.id))) order('assembly.merges', `${c.id} is merged before ${d}, which it depends on`);
    if (replayed.states.get(c.id) !== 'accepted') order('assembly.merges', `${c.id} is ${replayed.states.get(c.id)}, not accepted`);
  }
  assembly.merges.forEach((m, i) => {
    const res = results[m.child]; const acc = acceptances[m.child];
    if (!res || !acc) return;
    if (m.result !== res.hash || m.acceptance !== acc.hash || m.commit !== res.commit || !replayed.hashes.has(res.hash) || !replayed.hashes.has(acc.hash)) drift(`assembly.merges[${i}]`, `is not pinned to the accepted result and acceptance of ${m.child}`);
    else if (!tree.merged || tree.merged[m.commit] !== true) order(`assembly.merges[${i}]`, `the accepted commit of ${m.child} is not merged into the head`);
  });

  // Content: the last accepted writer of each path, in merge order, defines it; a changed path outside the union of the
  // accepted diffs and the integrator paths is a manual resolution (TD-73, TD-74).
  if (tree.head === assembly.head && tree.tree === assembly.tree) {
    const expected = new Map(); const union = new Set();
    for (const id of record.assembly.order) {
      const res = results[id];
      if (!res) continue;
      for (const x of res.changed) { union.add(fold(x)); expected.set(fold(x), { path: x, blob: null, child: id }); }
      for (const o of res.outputs) expected.set(fold(o.path), { path: o.path, blob: o.blob, child: id });
    }
    const integrator = new Set(record.assembly.integratorPaths.map(fold));
    for (const x of changedPaths(tree.changes)) if (!union.has(fold(x)) && !integrator.has(fold(x))) r.add('ASSEMBLY_CONFLICT', 'assembly.head', `${x} changed outside the accepted child diffs and the integrator paths`);
    for (const [key, want] of expected) {
      if (integrator.has(key)) continue;
      const got = Object.entries(tree.entries).find(([x]) => fold(x) === key);
      const blob = got ? got[1].blob : null;
      if (blob !== want.blob) drift('assembly.head', `${want.path} is ${blob || 'absent'} at the head; ${want.child} was accepted with ${want.blob || 'the file removed'}`);
    }
  }

  // The whole: every assembly check of the record ran on the head and exited 0, and every requirement is closed by an
  // accepted child or a passed check (TD-75).
  const passed = new Set();
  for (const k of record.assembly.checks) {
    const ran = assembly.checks.filter(c => c.id === k.id && c.command === k.command);
    if (!ran.length) r.add('ASSEMBLY_COVERAGE', 'assembly.checks', `the check ${k.id} was not run on the head`);
    else if (!ran.every(c => exitOk(c.exit))) r.add('ASSEMBLY_COVERAGE', 'assembly.checks', `the check ${k.id} exited ${ran.map(c => unknownText(c.exit)).join(' ')} on the head`);
    else for (const q of k.covers) passed.add(q);
  }
  for (const c of record.children) if (replayed.states.get(c.id) === 'accepted') for (const q of c.covers) passed.add(q);
  for (const q of p.requirements) if (!passed.has(q.id)) r.add('ASSEMBLY_COVERAGE', 'parent.requirements', `${q.id} has no accepted child and no passed assembly check`);

  // Certifiers outside every child author, the integrator and the planner; unknown cannot show it (TD-76).
  const cert = (where, detail) => r.add('CERT_FAMILY', where, detail);
  const known = decompose.familyTable(record);
  const integratorFamily = known(assembly.integrator.family);
  const plannerFamily = known(assembly.planner.family);
  for (const [v, where] of [[assembly.integrator.family, 'assembly.integrator.family'], [assembly.planner.family, 'assembly.planner.family']]) if (typeof v === 'string' && !known(v)) cert(where, `${v} is not a family the kernel family fold knows`);
  if (!integratorFamily) cert('assembly.integrator.family', 'is unknown; independence cannot be shown');
  else if (known(record.assembly.integrator.family) !== integratorFamily) cert('assembly.integrator.family', `${integratorFamily} is not the integrator ${unknownText(record.assembly.integrator.family)} the record names`);
  if (!plannerFamily) cert('assembly.planner.family', 'is unknown; independence cannot be shown');
  if (!Array.isArray(p.certifierFamilies)) cert('parent.certifierFamilies', 'are unknown; independence cannot be shown');
  else {
    const authors = ledgerOf(record).filter(e => e.type === 'result').map(e => known(e.author)).filter(Boolean);
    const lineage = new Map([...authors.map(a => [a, 'a child author']), [integratorFamily, 'the integrator'], [plannerFamily, 'the planner']]);
    for (const name of p.certifierFamilies) {
      const f = known(name);
      if (!f) cert('parent.certifierFamilies', `${name} is not a family the kernel family fold knows`);
      else if (lineage.has(f)) cert('parent.certifierFamilies', `${f} certifies the parent and is ${lineage.get(f)}`);
    }
  }
  const entry = { type: 'assemble', revision: record.revision, contract: p.contractHash, hash, integrator: integratorFamily || '', head: assembly.head, tree: assembly.tree };
  return r.done({ hash, entry });
}

// ---------- the state machine ----------

// Two rejections of one cause in a row stop the project until the operator raises the revision of the record (TD-77).
function stopOf(record) {
  // A lost seat is a rejection of its cause (TD-87).
  const refused = e => e.type === 'reject' || e.type === 'lost';
  const verdicts = ledgerOf(record).filter(e => e.type === 'accept' || refused(e));
  const [a, b] = verdicts.slice(-2);
  if (a && b && refused(a) && refused(b) && a.cause === b.cause && record.revision <= b.revision) return b.cause;
  return null;
}

// The next record after one event, or the refusals. A state moves only forward by its event; the only way back is a
// named rejection; counters only grow; the contract hash never changes; certified, landed and activated are recorded
// by the certification of the whole and the landing, never by this tool (TD-70, TD-77, TD-78).
function nextState(record, event) {
  const r = new Report();
  const held = checkLedger(record, null);
  if (!held.ok) return held;
  if (!isObject(event) || typeof event.type !== 'string') { r.add('STATE', 'event', 'is not an event'); return r.done(); }
  const next = clone(record);
  next.ledger = ledgerOf(next);
  const replayed = replay(record);
  const stamp = { revision: record.revision, contract: record.parent.contractHash };
  const childOf = () => {
    const i = next.children.findIndex(c => c.id === event.child);
    if (i < 0) r.add('STATE', 'event.child', `${event.child} is not a child of the record`);
    return i < 0 ? null : next.children[i];
  };
  const move = (child, type) => {
    const [from, to] = CHILD_MOVES[type];
    const now = replayed.states.get(child.id);
    if (!from.includes(now)) { r.add('STATE', `children.${child.id}`, `${type} from ${now}; it moves ${from.join(' or ')} to ${to}`); return false; }
    child.state = to;
    return true;
  };
  const withEntry = type => {
    if (!isObject(event.entry) || event.entry.type !== type || event.entry.child !== event.child || event.entry.contract !== record.parent.contractHash) { r.add('STATE', 'event.entry', `is not a checked ${type} of ${event.child}`); return false; }
    return true;
  };

  switch (event.type) {
    case 'ready': {
      const child = childOf(); if (!child) break;
      const pins = [];
      for (const d of child.dependsOn) {
        const res = replayed.accepted.get(d);
        if (!res || !DONE_CHILD.has(replayed.states.get(d))) r.add('STATE', `children.${child.id}`, `the dependency ${d} is ${replayed.states.get(d)}, not accepted`);
        else pins.push({ child: d, result: res.hash });
      }
      if (r.refusals.length || !move(child, 'ready')) break;
      next.ledger.push({ type: 'ready', ...stamp, child: child.id, pins });
      break;
    }
    case 'start': {
      const child = childOf(); if (!child) break;
      const stop = stopOf(record);
      if (stop) { r.add('STATE', 'parent', `two rejections of cause ${stop} in a row stop the project; the operator raises the revision to go on`); break; }
      const n = lineageCounts(record).of(child.id);
      if (n.attempts >= record.parent.budget.attempts) r.add('COUNTER', `children.${child.id}`, `the lineage spent its ${record.parent.budget.attempts} attempts`);
      if (n.rounds >= record.parent.budget.rounds) r.add('COUNTER', `children.${child.id}`, `the lineage spent its ${record.parent.budget.rounds} rounds`);
      // Every start draws from the total of the parent: no rename, new child or new revision gives it back (TD-83).
      const spent = lineageCounts(record).totals;
      if (spent.attempts >= record.parent.budget.total.attempts) r.add('COUNTER', 'parent.budget.total', `the parent spent its total of ${record.parent.budget.total.attempts} attempts`);
      if (spent.rounds >= record.parent.budget.total.rounds) r.add('COUNTER', 'parent.budget.total', `the parent spent its total of ${record.parent.budget.total.rounds} rounds`);
      // A start made through the kernel launch entry names its seat and route; the seat is the one of this child (TD-85).
      const launch = event.launch;
      if (launch !== undefined && (!isObject(launch) || launch.seat !== decompose.seatOf(record.parent.id, child.id) || typeof launch.route !== 'string' || !ROUTE.test(launch.route))) {
        r.add('STATE', 'event.launch', `is not the seat ${decompose.seatOf(record.parent.id, child.id)} of ${child.id} with a route client:model[:effort]`);
      }
      if (r.refusals.length || !move(child, 'start')) break;
      child.counters.attempts += 1; next.parent.counters.attempts += 1;
      next.ledger.push({ type: 'start', ...stamp, child: child.id, attempt: n.attempts + 1, paths: [...child.writeSet], ...(launch ? { seat: launch.seat, route: launch.route } : {}) });
      break;
    }
    case 'lost': {
      // The seat of the running attempt ended without the marker of the child: the attempt is rejected by name and counts
      // as a round of the lineage and of the parent (TD-87).
      const child = childOf(); if (!child) break;
      const start = replayed.starts.get(child.id);
      if (!start || !start.seat || start.seat !== event.seat) r.add('STATE', 'event.seat', `${event.seat} is not the seat of the running attempt of ${child.id}`);
      if (!decompose.LOST_CAUSES.includes(event.cause)) r.add('STATE', 'event.cause', `is not one of ${decompose.LOST_CAUSES.join(', ')}`);
      if (r.refusals.length || !move(child, 'lost')) break;
      child.counters.rounds += 1; next.parent.counters.rounds += 1;
      next.ledger.push({ type: 'lost', ...stamp, child: child.id, attempt: start.attempt, seat: start.seat, cause: event.cause });
      break;
    }
    case 'result': case 'accept': case 'reject': {
      const child = childOf(); if (!child || !withEntry(event.type) || !move(child, event.type)) break;
      if (event.type === 'reject') { child.counters.rounds += 1; next.parent.counters.rounds += 1; }
      next.ledger.push(clone(event.entry));
      break;
    }
    case 'integrate': {
      if (record.parent.state !== 'planned') { r.add('STATE', 'parent', `integrate from ${record.parent.state}`); break; }
      const open = record.children.filter(c => replayed.states.get(c.id) !== 'accepted');
      if (open.length) { r.add('STATE', 'parent', `${open.map(c => c.id).join(' ')} not accepted`); break; }
      next.parent.state = 'integrating';
      next.ledger.push({ type: 'integrate', ...stamp });
      break;
    }
    case 'assemble': {
      if (!isObject(event.entry) || event.entry.type !== 'assemble' || event.entry.contract !== record.parent.contractHash) { r.add('STATE', 'event.entry', 'is not a checked assembly'); break; }
      if (record.parent.state !== 'planned' && record.parent.state !== 'integrating') { r.add('STATE', 'parent', `assemble from ${record.parent.state}`); break; }
      const open = record.children.filter(c => replayed.states.get(c.id) !== 'accepted');
      if (open.length) { r.add('STATE', 'parent', `${open.map(c => c.id).join(' ')} not accepted`); break; }
      next.parent.state = 'assembled';
      for (const c of next.children) c.state = 'integrated';
      next.ledger.push(clone(event.entry));
      break;
    }
    case 'certify': case 'land': case 'activate':
      r.add('STATE', 'event', `${event.type} is recorded by the certification of the whole and the landing, never by the decomposition tool`);
      break;
    default:
      r.add('STATE', 'event', `${event.type} is not an event of the record`);
  }
  if (r.refusals.length) return r.done();
  if (decompose.contractHash(next) !== record.parent.contractHash) throw new Error('decompose-flow: an event changed the contract');
  return r.done({ record: next });
}

module.exports = { CODES, SCHEMAS, VERDICTS, hashOf, parseText, checkForm, changedPaths, checkResult, checkAcceptance, checkAssembly, checkLedger, nextState, acceptedOf, latestResult };

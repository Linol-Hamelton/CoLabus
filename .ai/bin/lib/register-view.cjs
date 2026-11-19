'use strict';
// Pure views and shape/semantic checks; all provenance is injected.
const textSafe = require('./text-safe.cjs');
const { parseVersion, releaseAtLeast } = require('./protocol-version.cjs');
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const describe = (v) => {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'an array';
  return typeof v === 'object' ? 'an object' : `a ${typeof v}`;
};

// a diagnostic is one line: every line terminator of register data (a line feed in a source key,
// a carriage return, a tab, a NUL, the next-line U+0085, the line separator U+2028 and the
// paragraph separator U+2029) is escaped, never printed raw, so one problem is always exactly one
// REFUSED or PROBLEM line under every reader that splits on a line terminator
const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/g;
const escapeControl = (s) => String(s).replace(CONTROL, (c) => {
  if (c === '\n') return '\\n';
  if (c === '\r') return '\\r';
  if (c === '\t') return '\\t';
  return `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`;
});

// the field table: [name, type, required]; the array blocks name their element fields separately
const TOP_FIELDS = [
  ['schema', 'string', true],
  ['title', 'string', true],
  ['dateUTC', 'string', true],
  ['textEncoding', 'string', false],
  ['baseline', 'stringMap', true],
  ['sources', 'array', true],
  ['items', 'objects', true],
  ['duplicates', 'objects', true],
  ['contradictions', 'objects', true],
  ['counts', 'object', true],
];
const BASELINE_FIELDS = [
  ['commit', 'string', true],
  ['branch', 'string', true],
  ['statusBase', 'string', true],
  ['statusAsOf', 'string', true],
  ['rule', 'string', true],
];
const SOURCE_FIELDS = [
  ['key', 'string', true],
  ['file', 'string', true],
  ['kind', 'string', true],
  ['itemsTotal', 'integer', true],
  ['openAtSource', 'integer', false],
  ['replacedBy', 'string', true],
];
const ITEM_FIELDS = [
  ['id', 'string', true],
  ['sourceKey', 'string', true],
  ['sourceIds', 'strings', true],
  ['title', 'string', true],
  ['status', 'string', true],
  ['statusAsOf', 'string', true],
  ['statusProof', 'string', false],
  ['class', 'string', true],
  ['layer', 'string', true],
  ['ownerAct', 'boolean', true],
  ['dependsOn', 'strings', false],
  ['target', 'string', true],
  ['package', 'string', true],
  ['nextStep', 'string', false],
  ['note', 'string', false],
  ['evidence', 'stringOrStrings', false],
];
const DUPLICATE_FIELDS = [
  ['survivorId', 'string', true],
  ['survivorSource', 'string', true],
  ['merged', 'strings', true],
  ['why', 'string', true],
];
const CONTRADICTION_FIELDS = [
  ['id', 'string', true],
  ['sources', 'strings', true],
  ['text', 'string', true],
];
const COUNTS_FIELDS = [
  ['items', 'integer', true],
  ['open', 'integer', true],
  ['closedWithProof', 'integer', true],
  ['withdrawn', 'integer', true],
  ['byStatus', 'integerMap', true],
  ['bySource', 'integerMap', true],
  ['byTarget', 'integerMap', true],
];

// every declared field path, for the coverage assertion of the test suite: dropping one entry
// from the tables above drops it here, and the suite refuses to pass
const FIELDS = [
  ...TOP_FIELDS.map(([n]) => n),
  ...BASELINE_FIELDS.map(([n]) => `baseline.${n}`),
  ...SOURCE_FIELDS.map(([n]) => `sources[].${n}`),
  ...ITEM_FIELDS.map(([n]) => `items[].${n}`),
  'items[].sourceIds[]',
  'items[].dependsOn[]',
  ...DUPLICATE_FIELDS.map(([n]) => `duplicates[].${n}`),
  'duplicates[].merged[]',
  ...CONTRADICTION_FIELDS.map(([n]) => `contradictions[].${n}`),
  'contradictions[].sources[]',
  ...COUNTS_FIELDS.map(([n]) => `counts.${n}`),
];

const NAME = {
  string: 'a string',
  integer: 'an integer',
  boolean: 'a boolean',
  array: 'an array',
  strings: 'an array of strings',
  stringOrStrings: 'a string or an array of strings',
};

function checkValue(v, type, path, problems) {
  switch (type) {
    case 'string':
    case 'integer':
    case 'boolean': {
      const ok = type === 'string' ? typeof v === 'string' : type === 'integer' ? Number.isInteger(v) : typeof v === 'boolean';
      if (!ok) problems.push(`${path}: expected ${NAME[type]}, got ${describe(v)}`);
      return;
    }
    case 'array':
      if (!Array.isArray(v)) problems.push(`${path}: expected an array, got ${describe(v)}`);
      return;
    case 'objects':
      if (!Array.isArray(v)) { problems.push(`${path}: expected an array of objects, got ${describe(v)}`); return; }
      v.forEach((e, i) => { if (!isObj(e)) problems.push(`${path}[${i}] is not an object`); });
      return;
    case 'strings':
      if (!Array.isArray(v)) { problems.push(`${path}: expected an array of strings, got ${describe(v)}`); return; }
      v.forEach((e, i) => { if (typeof e !== 'string') problems.push(`${path}[${i}]: expected a string, got ${describe(e)}`); });
      return;
    case 'stringOrStrings':
      if (typeof v === 'string') return;
      if (!Array.isArray(v)) { problems.push(`${path}: expected ${NAME.stringOrStrings}, got ${describe(v)}`); return; }
      v.forEach((e, i) => { if (typeof e !== 'string') problems.push(`${path}[${i}]: expected a string, got ${describe(e)}`); });
      return;
    case 'object':
      if (!isObj(v)) problems.push(`${path} is not an object (got ${describe(v)})`);
      return;
    case 'stringMap':
    case 'integerMap': {
      if (!isObj(v)) { problems.push(`${path} is not an object (got ${describe(v)})`); return; }
      const want = type === 'stringMap' ? 'a string' : 'an integer';
      const ok = type === 'stringMap' ? (x) => typeof x === 'string' : (x) => Number.isInteger(x);
      for (const [k, val] of Object.entries(v)) if (!ok(val)) problems.push(`${path}.${k}: expected ${want}, got ${describe(val)}`);
      return;
    }
    default:
      problems.push(`${path}: the field table holds the unknown type ${type}`);
  }
}

function checkField(container, [name, type, required], path, problems) {
  if (!Object.hasOwn(container, name)) {
    if (required) problems.push(`${path} is required (missing)`);
    return;
  }
  checkValue(container[name], type, path, problems);
}

function walkFields(entry, fields, prefix, problems, presenceOnly = false) {
  for (const f of fields) {
    if (presenceOnly) {
      if (f[2] && !Object.hasOwn(entry, f[0])) problems.push(`${prefix}.${f[0]} is required (missing)`);
    } else {
      checkField(entry, f, `${prefix}.${f[0]}`, problems);
    }
  }
}

function walkEntries(arr, label, fields, problems) {
  if (!Array.isArray(arr)) return; // the top-level objects check already named it
  arr.forEach((e, i) => {
    if (!isObj(e)) return; // the top-level objects check already named it
    walkFields(e, fields, `${label}[${i}]`, problems);
  });
}

// a sources entry is named by its key once the key is a string, like the checker names its findings
function walkSources(arr, problems) {
  if (!Array.isArray(arr)) return;
  arr.forEach((e, i) => {
    if (!isObj(e)) { problems.push(`sources[${i}] is not an object with a string key`); return; }
    // own properties only: a key of the prototype chain is not a key of the source
    const ownKey = Object.hasOwn(e, 'key') && typeof e.key === 'string';
    for (const f of SOURCE_FIELDS) {
      const path = f[0] === 'key' || !ownKey ? `sources[${i}].${f[0]}` : `sources.${e.key}.${f[0]}`;
      checkField(e, f, path, problems);
    }
  });
}

function validate(reg) {
  if (!isObj(reg)) return ['the register is not a JSON object'];
  const problems = [];
  for (const f of TOP_FIELDS) checkField(reg, f, f[0], problems);
  // the stringMap check above already typed every baseline value; the named walk adds presence
  if (isObj(reg.baseline)) walkFields(reg.baseline, BASELINE_FIELDS, 'baseline', problems, true);
  walkSources(reg.sources, problems);
  walkEntries(reg.items, 'items', ITEM_FIELDS, problems);
  walkEntries(reg.duplicates, 'duplicates', DUPLICATE_FIELDS, problems);
  walkEntries(reg.contradictions, 'contradictions', CONTRADICTION_FIELDS, problems);
  if (isObj(reg.counts)) walkFields(reg.counts, COUNTS_FIELDS, 'counts', problems);
  return problems.map(escapeControl);
}

// The archived sources the checker reads are shaped by the same rule: only the fields the tools
// read are declared. The archived debt register is JSON and only its row ids are read (they reach
// the string code of the coverage recount), so its rows are objects with a string id. The two
// markdown sources are parsed by line patterns, so their row ids are strings by construction.
// Own properties only: a rows array or a row id carried by the prototype chain is not a field of
// the source, so it is a managed problem (a missing field), never a silently accepted value.
function validateArchivedRows(label, parsed) {
  const problems = [];
  if (!isObj(parsed)) { problems.push(`${label}: expected an object, got ${describe(parsed)}`); return problems.map(escapeControl); }
  if (!Object.hasOwn(parsed, 'rows')) { problems.push(`${label}.rows is required (missing)`); return problems.map(escapeControl); }
  if (!Array.isArray(parsed.rows)) { problems.push(`${label}.rows: expected an array, got ${describe(parsed.rows)}`); return problems.map(escapeControl); }
  parsed.rows.forEach((r, i) => {
    if (!isObj(r)) { problems.push(`${label}.rows[${i}] is not an object`); return; }
    if (!Object.hasOwn(r, 'id')) { problems.push(`${label}.rows[${i}].id is required (missing)`); return; }
    if (typeof r.id !== 'string') problems.push(`${label}.rows[${i}].id: expected a string, got ${describe(r.id)}`);
  });
  return problems.map(escapeControl);
}



function renderTable(reg, labels) {
  if (!labels || typeof labels.registerPath !== "string" || typeof labels.command !== "string" || validate(reg).length) throw new Error("REGISTER_VIEW_INPUT");
const LINE_BREAK = new RegExp('[\\r\\n\\u0085\\u2028\\u2029]+', 'g');
const oneLine = (s) => String(s ?? '').replace(LINE_BREAK, ' ');
const esc = (s) => oneLine(s).replace(/\\+(?=\|)/g, (m) => m + m).replaceAll('|', '\\|');
const date = reg.dateUTC;

const lines = [];
// every interpolated metadata value goes through oneLine: a line break in register metadata
// (baseline.statusBase, the schema tag, a counts key) must not inject a line into the table
lines.push('# One register of open items: the readable table');
lines.push('');
lines.push(`Generated from ${labels.registerPath} (schema ${oneLine(reg.schema)}, dated ${oneLine(date)}); regenerate with ${labels.command}. The machine-readable register is the source of truth; this table is its projection. Statuses were verified against the landings of ${oneLine(reg.baseline.statusBase)}; a closed status always names its proof in the register.`);
lines.push('');
lines.push(`Open items today: ${oneLine(reg.counts.open)} of ${oneLine(reg.counts.items)} (open ${oneLine(reg.counts.byStatus.open)}, partial ${oneLine(reg.counts.byStatus.partial)}, unknown ${oneLine(reg.counts.byStatus.unknown)}; closed with proof ${oneLine(reg.counts.closedWithProof)}, withdrawn ${oneLine(reg.counts.withdrawn)}). Carried text encodes an arrow as the Unicode arrow and a bracket pair as the typographic quote pair: the files for seats carry no angle brackets and no ampersand entities.`);
lines.push('');

const byStatus = Object.entries(reg.counts.byStatus).map(([k, v]) => `${oneLine(k)}: ${oneLine(v)}`).join('; ');
lines.push(`By status: ${byStatus}.`);
lines.push('');
// counts.bySource is register data read under a register key: own-key membership only, never the
// prototype chain (a source key like constructor must not resolve to an inherited value)
const bySourceCount = (key) => (isObj(reg.counts.bySource) && Object.hasOwn(reg.counts.bySource, key) ? reg.counts.bySource[key] : undefined);
const bySource = reg.sources.map(s => `${oneLine(s.key)}: ${oneLine(s.itemsTotal)} rows at the source, ${oneLine(bySourceCount(s.key))} items here (open at the source: ${oneLine(s.openAtSource)})`).join('; ');
lines.push(`By source: ${bySource}.`);
lines.push('');
const byTarget = Object.entries(reg.counts.byTarget || {}).map(([k, v]) => `${oneLine(k)}: ${oneLine(v)}`).join('; ');
lines.push('');
lines.push('## Duplicates merged');
lines.push('');
lines.push('| Surviving item | Survives | Merged ids | Why |');
lines.push('|---|---|---|---|');
for (const d of reg.duplicates) {
  lines.push(`| ${esc(d.survivorId)} | ${esc(d.survivorSource)} | ${esc(d.merged.join(', '))} | ${esc(d.why)} |`);
}
lines.push('');
lines.push('## Contradictions (listed, not silently resolved)');
lines.push('');
for (const c of reg.contradictions) {
  lines.push(`- ${oneLine(c.id)}: ${oneLine(c.text)} Sources: ${oneLine(c.sources.join('; '))}.`);
}
lines.push('');
lines.push('## The items');
lines.push('');
lines.push('| ID | Source ids | Item | Status | As of | Class | Layer | Owner act | Target | Package |');
lines.push('|---|---|---|---|---|---|---|---|---|---|');
for (const it of reg.items) {
  lines.push(`| ${esc(it.id)} | ${esc(it.sourceIds.join(', '))} | ${esc(it.title)} | ${esc(it.status)} | ${esc(it.statusAsOf)} | ${esc(it.class)} | ${esc(it.layer)} | ${it.ownerAct ? 'yes' : 'no'} | ${esc(it.target)} | ${esc(it.package)} |`);
}
lines.push('');

return lines.join('\n');

}
const LINE_BREAK = new RegExp('[\\r\\n\\u0085\\u2028\\u2029]');
const isCalendarDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};

const STATUSES = ['open', 'partial', 'unknown', 'closed', 'withdrawn'];
const SOURCE_KEYS = ['KDR14', 'RR201', 'PROC', 'BACKLOG', 'OPMEM', 'DOCS', 'REV'];
const LAYERS = new Set(['release', 'product', 'package-finding', 'carried', 'temp-hygiene', 'process',
  'operator', 'docs', 'review', 'backlog', 'test', 'VOICE',
  'L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9',
  'X-CLEANUP', 'X-DOCS', 'X-GOVERNANCE', 'X-MACHINES', 'X-MCP', 'X-OPERATOR', 'X-PILOTS',
  'X-PRODUCT', 'X-SECURITY', 'X-SELECTION', 'X-TOPOLOGY']);
const COMMIT_PROOF = /^commit ([0-9a-f]{7,40})(?:\s|$)/;
const NAMED_DECISION = /^the decision named by\s+/;

// Targets remain stable releases; the shared comparator orders the whole version.

function forbiddenAt(value, where, report) {
  if (typeof value === 'string') { if (/[<>&]/.test(value)) report(where); return; }
  if (Array.isArray(value)) { value.forEach((v, i) => forbiddenAt(v, `${where}[${i}]`, report)); return; }
  if (isObj(value)) {
    for (const [k, v] of Object.entries(value)) {
      if (/[<>&]/.test(k)) report(`${where}.${k} (the key)`);
      forbiddenAt(v, `${where}.${k}`, report);
    }
  }
}

// a recount object has no prototype: a register key like toString or __proto__ can never collide with
// an inherited name, and every increment starts from an own key
const tally = (objs, field) => { const t = Object.create(null); for (const it of objs) if (it[field]) t[it[field]] = (Object.hasOwn(t, it[field]) ? t[it[field]] : 0) + 1; return t; };

function checkRegister(parsed, opts) {
  const problems = [];
  const problem = (msg) => problems.push(escapeControl(msg));

  const reg = isObj(parsed) ? parsed : null;
  if (!reg) problem("the register is not a JSON object");
  // ---------------------------------------------------------------- declared shape FIRST
  // every field the tools read must hold its declared type before any later code touches it:
  // a value of an undeclared type further down (an object where a string is expected, whatever
  // its toString) is exactly the crash class this round closes
  if (reg) for (const p of validate(reg)) problem(p);
  const sound = reg !== null && problems.length === 0;

  // ---------------------------------------------------------------- shape
  const seenSourceIds = new Map();
  const declared = new Set();
  const sources = [];
  let items = [];
  if (sound) {
    // Use the same source as product-build, from the checked tree, never from the tool's
    // checkout or from register data. A missing or ambiguous source has no fallback version.
    let currentVersion;
    let currentRelease;
    try {
      currentVersion = opts.version;
      currentRelease = parseVersion(currentVersion) ? currentVersion : null;
      if (!currentRelease) problem('protocol-manifest.json: protocolVersion must be a canonical release triplet, or a pre-release X.Y.Z-pre.N');
    } catch (e) {
      problem(`protocol-manifest.json: cannot read protocolVersion (${e.code || e.message})`);
    }
    for (const top of ['schema', 'title', 'dateUTC', 'baseline', 'sources', 'items', 'duplicates', 'contradictions', 'counts']) {
      if (!Object.hasOwn(reg, top)) problem(`the register is missing the top-level field ${top}`);
    }
    for (const top of ['sources', 'items', 'duplicates', 'contradictions']) {
      if (Object.hasOwn(reg, top) && !Array.isArray(reg[top])) problem(`the top-level field ${top} is not an array`);
    }
    for (const top of ['baseline', 'counts']) {
      if (Object.hasOwn(reg, top) && !isObj(reg[top])) problem(`the top-level field ${top} is not an object`);
    }
    if (reg.schema !== 'open-register/1') problem(`the register schema is ${reg.schema}, expected open-register/1`);
    if (!isCalendarDate(reg.dateUTC)) problem('dateUTC is not a calendar date');
    forbiddenAt(reg, 'the register', (where) => {
      // an item is named by its id, not by its place in the file
      const m = /^the register\.items\[(\d+)\](.*)$/.exec(where);
      const it = m && Array.isArray(reg.items) ? reg.items[Number(m[1])] : null;
      if (m) problem(`${it && typeof it.id === 'string' ? it.id : `item ${m[1]}`}: the field ${m[2].replace(/^\./, '')} holds a forbidden character (no angle brackets, no ampersand)`);
      else problem(`${where} holds a forbidden character (no angle brackets, no ampersand)`);
    });

    const seenSources = new Set();
    (Array.isArray(reg.sources) ? reg.sources : []).forEach((s, i) => {
      if (!isObj(s) || typeof s.key !== 'string' || !s.key) { problem(`sources[${i}] has no key`); return; }
      if (seenSources.has(s.key)) problem(`the sources block declares ${s.key} twice`);
      seenSources.add(s.key); declared.add(s.key); sources.push(s);
    });

    items = Array.isArray(reg.items) ? reg.items : [];
    // the proofs of the register are resolved against the repository of the tree: the tracked files
    // (a file proof must name one of them) and the commit shas (a commit proof must name a commit
    // of that repository). One batch call answers for every sha. A tree without a repository, a
    // failed git call or an unknown root is unknown provenance: the tracked set is then null, and
    // every proof of that tree is refused with the reason (never a silent success).
    items.forEach((it, i) => {
      const where = it && typeof it.id === 'string' ? it.id : `item ${i}`;
      const expect = `OR-${String(i + 1).padStart(4, '0')}`;
      if (!isObj(it)) { problem(`${where}: not an object`); return; }
      if (it.id !== expect) problem(`${where}: the id is ${it.id}, expected ${expect} (sequential in file order)`);
      for (const f of ['sourceKey', 'sourceIds', 'title', 'status', 'statusAsOf', 'class', 'layer', 'ownerAct', 'target', 'package']) {
        if (it[f] === undefined) problem(`${where}: the field ${f} is required`);
      }
      if (!SOURCE_KEYS.includes(it.sourceKey)) problem(`${where}: unknown sourceKey ${it.sourceKey}`);
      else if (!declared.has(it.sourceKey)) problem(`${where}: the sourceKey ${it.sourceKey} is not a declared sources[].key`);
      if (!Array.isArray(it.sourceIds) || !it.sourceIds.length) { problem(`${where}: sourceIds must be a non-empty array`); }
      else for (const sid of it.sourceIds) {
        if (typeof sid !== 'string' || !/^[A-Z0-9]+:[A-Za-z0-9._-]+$/.test(sid)) { problem(`${where}: the source id ${sid} is not of the form KEY:id`); continue; }
        const key = sid.slice(0, sid.indexOf(':'));
        if (!declared.has(key)) problem(`${where}: the source id ${sid} names ${key}, which is not a declared sources[].key`);
        if (seenSourceIds.has(sid)) problem(`the source id ${sid} appears in ${seenSourceIds.get(sid)} and ${where}`);
        else seenSourceIds.set(sid, where);
      }
      if (typeof it.title !== 'string' || !it.title.trim()) problem(`${where}: the title is empty`);
      if (!STATUSES.includes(it.status)) problem(`${where}: the status ${it.status} is not one of ${STATUSES.join(', ')}`);
      if (!isCalendarDate(it.statusAsOf)) problem(`${where}: statusAsOf is not a calendar date`);
      if (it.status === 'closed' || it.status === 'withdrawn') {
        // a withdrawn item proves itself exactly like a closed one: a commit of the repository or
        // a file of the tree. Prose and a path that leaves the tree are no proof.
        const why = (typeof opts.proofReader === "function" && opts.proofReader(it.statusProof) === true ? null : "cannot be verified from the pinned tree");
        if (why) problem(`${where}: a ${it.status} item needs statusProof (a commit of this repository or a file of this tree); the proof ${why}`);
      }
      if (it.class !== undefined && !['A', 'B'].includes(it.class)) problem(`${where}: the class ${it.class} is not A or B`);
      if (it.layer !== undefined && !LAYERS.has(it.layer)) problem(`${where}: the layer ${it.layer} is not a known area token`);
      if (typeof it.ownerAct !== 'boolean') problem(`${where}: ownerAct is not a boolean`);
      if (it.status === 'closed' || it.status === 'withdrawn') {
        if (it.target !== '' && it.target !== undefined) problem(`${where}: a ${it.status} item has no target (got ${it.target})`);
      } else if (it.target !== 'later' && !releaseAtLeast(it.target, currentRelease)) {
        problem(`${where}: the target ${it.target} must be later or a release at least ${currentRelease ? currentVersion : 'the repository version (unavailable)'}`);
      }
      if (it.package === undefined || typeof it.package !== 'string') problem(`${where}: package is missing`);
      if (it.dependsOn !== undefined) {
        if (!Array.isArray(it.dependsOn)) problem(`${where}: dependsOn is not an array`);
      }
      // the table prints these fields on one row: a line break would split the row
      for (const f of ['id', 'title', 'status', 'statusAsOf', 'class', 'layer', 'target', 'package']) {
        if (typeof it[f] === 'string' && LINE_BREAK.test(it[f])) problem(`${where}: the field ${f} holds a line break (the table keeps one row per item)`);
      }
      for (const sid of Array.isArray(it.sourceIds) ? it.sourceIds : []) {
        if (typeof sid === 'string' && LINE_BREAK.test(sid)) problem(`${where}: a source id holds a line break (the table keeps one row per item)`);
      }
    });
    const byId = new Map(items.filter(isObj).map(it => [it.id, it]));
    for (const it of items.filter(isObj)) {
      for (const d of Array.isArray(it.dependsOn) ? it.dependsOn : []) {
        if (!byId.has(d)) problem(`${it.id}: dependsOn names ${d} which is not an item`);
        else if (d === it.id) problem(`${it.id}: dependsOn names the item itself`);
      }
    }
    (Array.isArray(reg.duplicates) ? reg.duplicates : []).forEach((d, i) => {
      if (!isObj(d)) { problem(`duplicates[${i}] is not an object`); return; }
      const survivor = byId.get(d.survivorId);
      if (!survivor) problem(`a duplicate entry names survivor ${d.survivorId} which is not an item`);
      const own = survivor && Array.isArray(survivor.sourceIds) ? survivor.sourceIds : [];
      if (survivor && !own.includes(d.survivorSource)) problem(`the duplicate entry of ${d.survivorId} names the surviving source ${d.survivorSource}, which is not a source id of that item`);
      if (!Array.isArray(d.merged) || !d.merged.length) problem(`the duplicate entry of ${d.survivorId} lists no merged id`);
      else for (const m of d.merged) {
        if (typeof m !== 'string' || !seenSourceIds.has(m)) problem(`the duplicate entry of ${d.survivorId} merges ${m}, which is not a source id of the register`);
        else if (survivor && !own.includes(m)) problem(`the duplicate entry of ${d.survivorId} merges ${m}, which is not a source id of that item`);
      }
      if (typeof d.why !== 'string' || !d.why.trim()) problem(`the duplicate entry of ${d.survivorId} has no why`);
      for (const f of [d.survivorSource, d.why, ...(Array.isArray(d.merged) ? d.merged : [])]) {
        if (typeof f === 'string' && LINE_BREAK.test(f)) { problem(`the duplicate entry of ${d.survivorId} holds a line break (the table keeps one row per entry)`); break; }
      }
    });
    (Array.isArray(reg.contradictions) ? reg.contradictions : []).forEach((c, i) => {
      if (!isObj(c)) { problem(`contradictions[${i}] is not an object`); return; }
      if (!/^[A-Z0-9-]+$/.test(c.id || '')) problem(`a contradiction id is malformed`);
      if (typeof c.text !== 'string' || !c.text.trim()) problem(`the contradiction ${c.id} has no text`);
      else if (LINE_BREAK.test(c.text)) problem(`the contradiction ${c.id} holds a line break (the table keeps one bullet per entry)`);
      if (!Array.isArray(c.sources) || c.sources.some(s => typeof s !== 'string')) problem(`the contradiction ${c.id} has no sources array of strings`);
    });
  }

  // ---------------------------------------------------------------- coverage
  // the archived debt register is shaped by the shared validator before its row ids are read: a
  // row id of a wrong type (an object without a toString) used to reach the string code of the
  // recount and crash the checker with a TypeError. A malformed source is a managed problem, and
  // the ids of that source are not counted at all (its own problem is the answer).
  function kdrIds() { return opts.sourceIds.KDR14; }
  function ownLines(text) {
    const lines = text.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
    const fenced = textSafe.fenceMap(lines, 'hide');
    const out = [];
    let inComment = false;
    lines.forEach((line, i) => {
      if (fenced[i]) return;
      let touched = inComment;
      let rest = line;
      for (;;) {
        const at = rest.indexOf(inComment ? '-->' : '<!--');
        if (at < 0) break;
        touched = true;
        rest = rest.slice(at + (inComment ? 3 : 4));
        inComment = !inComment;
      }
      if (!touched) out.push(line);
    });
    return out;
  }
  function residualIds() { return opts.sourceIds.RR201; }
  function processIds() {
    // The train merger checks the pending process projection before writing either file.
    const text = opts.processText;
    if (text === null) return [];
    const out = [];
    const ids = new Set();
    for (const l of ownLines(text)) {
      if (!l.startsWith('| P-')) continue;
      const c = l.split('|').map(s => s.trim());
      if (!/^P-\d+$/.test(c[1])) continue;
      if (ids.has(c[1])) problem(`PROCESS_DUPLICATE ${c[1]}`);
      ids.add(c[1]);
      if (c.length >= 10 && c[9] === 'proposed') {
        const sid = `PROC:${c[1]}`;
        const matching = items.filter(item => item?.sourceKey === 'PROC' && Array.isArray(item.sourceIds) && item.sourceIds.includes(sid));
        if (matching.length !== 1) problem(`PROCESS_COVERAGE ${c[1]} requires exactly one PROC item`);
        out.push(sid);
      }
    }
    return out;
  }
  if (sound) {
    const kdr = kdrIds(); const residual = residualIds(); const proc = processIds();
    // a malformed source (kdr is null) contributes no ids: its own shape problem is the answer,
    // and the ids of that source are not counted as missing or as unknown
    const expect = [...(kdr || []), ...residual, ...proc];
    const expectSet = new Set(expect);
    if (expect.length !== expectSet.size) problem('a source holds a duplicate row id (the sources are malformed)');
    for (const sid of expect) if (!seenSourceIds.has(sid)) problem(`the source row ${sid} is missing from the register`);
    for (const sid of seenSourceIds.keys()) {
      if (sid.startsWith('KDR14:') && kdr === null) continue;
      if (sid.startsWith('KDR14:') || sid.startsWith('RR201:') || sid.startsWith('PROC:')) {
        if (!expectSet.has(sid)) problem(`the register holds the source id ${sid} which no id-bearing source has`);
      }
    }
    // the sources block must tell the truth about the id-bearing sources: itemsTotal is required and
    // is an integer equal to the live recount (a missing or non-integer value is a problem, not a skip)
    const src = new Map(sources.map(s => [s.key, s]));
    for (const [key, real] of [['KDR14', kdr === null ? null : kdr.length], ['RR201', residual.length], ['PROC', proc.length]]) {
      if (real === null) continue; // the source is malformed: its own problem is already reported
      const s = src.get(key);
      if (!s) { problem(`the sources block is missing ${key}`); continue; }
      if (!Number.isInteger(s.itemsTotal)) problem(`sources.${key}.itemsTotal is ${JSON.stringify(s.itemsTotal) ?? 'undefined'}, the source holds ${real} (itemsTotal must be an integer)`);
      else if (s.itemsTotal !== real) problem(`sources.${key}.itemsTotal is ${s.itemsTotal}, the source holds ${real}`);
    }
  }

  // ---------------------------------------------------------------- counts
  const objs = items.filter(isObj);
  const byStatus = tally(objs, 'status');
  const openCount = (byStatus.open || 0) + (byStatus.partial || 0) + (byStatus.unknown || 0);
  if (sound) {
    const bySource = tally(objs, 'sourceKey');
    const byTarget = tally(objs, 'target');
    const c = isObj(reg.counts) ? reg.counts : {};
    if (c.items !== items.length) problem(`counts.items is ${c.items}, the register holds ${items.length}`);
    // each block equals its recount key for key: a value that differs, a key the recount lacks (own-key
    // membership, never the prototype chain) and a sum that is not the item count are all problems
    const sameBlock = (name, actual, recount, sums) => {
      if (!isObj(actual)) { problem(`counts.${name} is not an object`); return; }
      for (const [k, v] of Object.entries(recount)) if (actual[k] !== v) problem(`counts.${name}.${k} is ${actual[k]}, the recount is ${v}`);
      for (const k of Object.keys(actual)) if (!Object.hasOwn(recount, k)) problem(`counts.${name}.${k} is ${actual[k]}, the recount has no such key (an unknown key)`);
      if (sums) {
        const sum = Object.values(actual).reduce((a, v) => a + (Number.isInteger(v) ? v : NaN), 0);
        if (sum !== items.length) problem(`counts.${name} sums to ${sum}, the register holds ${items.length} items`);
      }
    };
    sameBlock('byStatus', c.byStatus, byStatus, true);
    sameBlock('bySource', c.bySource, bySource, true);
    sameBlock('byTarget', c.byTarget, byTarget, false);
    if (c.open !== openCount) problem(`counts.open is ${c.open}, the recount is ${openCount}`);
    const closedWithProof = objs.filter(i => i.status === 'closed' && typeof i.statusProof === 'string' && i.statusProof.trim()).length;
    if (c.closedWithProof !== closedWithProof) problem(`counts.closedWithProof is ${c.closedWithProof}, the recount is ${closedWithProof}`);
    const withdrawn = byStatus.withdrawn || 0;
    if (c.withdrawn !== withdrawn) problem(`counts.withdrawn is ${c.withdrawn}, the recount is ${withdrawn}`);
    const procSrc = sources.find(s => s.key === 'PROC');
    if (procSrc && procSrc.openAtSource !== undefined) {
      const real = processIds().length;
      if (procSrc.openAtSource !== real) problem(`sources.PROC.openAtSource is ${procSrc.openAtSource}, the source holds ${real} proposed rows`);
    }
  }

  return { problems, reg, objs, openCount, byStatus };
}

function recount(reg) {
  const tally = field => {
    const result = Object.create(null);
    for (const item of reg.items) if (item[field]) result[item[field]] = (result[item[field]] || 0) + 1;
    return result;
  };
  const byStatus = tally('status');
  reg.counts = { items: reg.items.length, byStatus, bySource: tally('sourceKey'), byTarget: tally('target'),
    open: (byStatus.open || 0) + (byStatus.partial || 0) + (byStatus.unknown || 0),
    closedWithProof: reg.items.filter(i => i.status === 'closed' && i.statusProof?.trim()).length,
    withdrawn: byStatus.withdrawn || 0 };
}

module.exports = { validate, validateArchivedRows, escapeControl, FIELDS, ITEM_FIELDS, renderTable, checkRegister, recount };

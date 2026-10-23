#!/usr/bin/env node
'use strict';
// protocol-core.cjs - lint, catalog, check-links, packet, lcc, verify and root-size for kernel
// records.
// Enforces .ai/core/schema/procedure.schema.md and
// P-L0-004 (both approved by PROTO-DEC-0061). Output follows docs/specs/bin-output-schema.md.
// Every enumeration and registry it enforces is read from the canon's dictionaries block
// (procedure.schema.md section 6); the code keeps no literal copy.
// Inputs are repository files and the headings of .ai/DECISIONS.md only; no network, no model,
// no git history. Same tree, same output. Unknown input exits 2.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { InputError, REGISTRY_NAME, DECISION_ID, REPO, rel, cmp, dicts, loadDictionaries, parseRecord, parseRuleId, parseEvidenceItem, bodyStructure, listMarkdown, loadRecords, manifestLines, treeSha } = require('./lib/records.cjs');
const { artifactLint } = require('./lib/artifacts.cjs');
const { realInside } = require('./lib/path-safe.cjs');
const ENFORCES = 'PROTO-DEC-0061 (stage 1: procedure.schema.md, P-L0-004), PROTO-DEC-0047 item 8, PROTO-DEC-0049 item 2';
// PROTO-DEC-0193: operator may set 200000 ONLY after recording the measured
// role/stage and quality reason. Never infer the fallback from a failed compile.
const { HARD_BYTES: LCC8_DELIVERED_BUDGET } = require('./protocol-packet.cjs');
const PACKET_BUDGET = LCC8_DELIVERED_BUDGET;
// The root budget: hard limit 9 500 UTF-8 bytes (exit 2), WARN above
// 8 500 B (exit 1), optimization goal 8 000 B. The budget is measured in bytes; characters
// are printed as information only.
const ROOT_GOAL = 8000;
const ROOT_WARN = 8500;
const ROOT_LIMIT = 9500;
const FULL_KEYS = ['id', 'version', 'title', 'layer', 'type', 'status', 'roles', 'stages', 'triggers', 'inputs', 'outputs',
  'back_edges', 'enforcement', 'script_candidate', 'evidence_class', 'evidence'];
const REQUIRED_KEYS = {
  procedure: FULL_KEYS, tool: FULL_KEYS, application: FULL_KEYS, metric: FULL_KEYS, scenario: FULL_KEYS,
  role: FULL_KEYS.filter(k => k !== 'back_edges'),
  invariant: ['id', 'version', 'title', 'layer', 'type', 'status', 'roles', 'stages', 'triggers', 'enforcement',
    'script_candidate', 'evidence_class', 'evidence'],
  schema: ['id', 'version', 'title', 'layer', 'type', 'status', 'evidence_class', 'evidence'],
};
const EIGHT = ['Purpose', 'Rules', 'Steps', 'Stop conditions', 'Back edges', 'Evidence', 'Risks', 'Change log'];
const REQUIRED_HEADINGS = {
  procedure: EIGHT, tool: EIGHT, application: EIGHT, metric: EIGHT,
  scenario: ['Purpose', 'Rules', 'Steps', 'Stage graph', 'Handoff artifacts', 'Stop conditions', 'Back edges', 'Evidence', 'Risks', 'Change log'],
  role: ['Purpose', 'Rules', 'Rights', 'Duties', 'Limits', 'Procedures', 'Evidence', 'Risks', 'Change log'],
  invariant: ['Purpose', 'Rules', 'Evidence', 'Change log'],
  schema: ['Change log'],
};
const REGISTRY_HEADER = '| id | referrer | target layer | closing stage/package | owner | status |';
const MAP_HEADER = '| Id | Lines | Rule (short) | Home | Layer | Class | Note |';
const RECORD_ID = /^(?:P-L[0-9]-\d{3}|S-\d{3}|ROLE-[a-z][a-z0-9-]*|TOOL-[a-z][a-z0-9-]*|APP-[a-z][a-z0-9-]*|M-\d{3}|SCHEMA-[a-z][a-z0-9-]*)$/;
const BODY_ID = /\b(P-L[0-9]-\d{3}|S-\d{3}|ROLE-[a-z][a-z0-9-]*[a-z0-9]|TOOL-[a-z][a-z0-9-]*[a-z0-9]|M-\d{3})\b/g;



function q(value) {
  const s = String(value);
  return /^[^\s"]+$/.test(s) ? s : `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function row(token, fields) {
  return [token, ...Object.entries(fields).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${q(v)}`)].join(' ');
}



function isRepoPath(value) {
  return /^[A-Za-z0-9._\-/]+$/.test(value) && !value.startsWith('/') && !value.split('/').includes('..') && /[/.]/.test(value);
}

// ---------- lint ----------

function lintRecord(rec, file) {
  const f = rec.findings;
  const fm = rec.fm;
  const D = dicts();
  const at = key => rec.fmLines[key] || 1;
  const add = (code, key, value, message) => f.push({ code, path: rel(file), line: at(key), value, message });
  // F4 enumerations
  if (fm.type !== undefined && !D.types.has(fm.type)) add('F4', 'type', fm.type, 'type outside the enumeration');
  if (fm.status !== undefined && !D.statuses.has(fm.status)) add('F4', 'status', fm.status, 'status outside the enumeration');
  if (fm.layer !== undefined && !/^L[0-9]$/.test(fm.layer)) add('F4', 'layer', fm.layer, 'layer must be L0..L9');
  if (fm.enforcement !== undefined && !D.enforcement.has(fm.enforcement)) add('F4', 'enforcement', fm.enforcement, 'enforcement outside the enumeration');
  if (fm.script_candidate !== undefined && !/^(yes|no:[1-4])$/.test(fm.script_candidate)) add('F4', 'script_candidate', fm.script_candidate, 'script_candidate must be yes or no:<1-4>');
  for (const c of fm.evidence_class || []) if (!D.evidence_class.has(c)) add('F4', 'evidence_class', c, 'evidence class outside A..E');
  // F5 registries
  for (const key of ['inputs', 'outputs']) for (const v of fm[key] || []) if (!D.artifacts.has(v) && !isRepoPath(v)) add('F5', key, v, 'not an artifact id of schema 2.1 nor a repo-relative path');
  for (const v of fm.stages || []) if (!D.stages.has(v)) add('F5', 'stages', v, 'stage not in schema 2.2');
  for (const v of fm.roles || []) if (!D.roles.has(v)) add('F5', 'roles', v, 'role slot not in the L1 catalog');
  // F6 forms
  if (fm.id !== undefined && !RECORD_ID.test(fm.id)) add('F6', 'id', fm.id, 'malformed record id');
  if (fm.version !== undefined && !/^\d+\.\d+$/.test(fm.version)) add('F6', 'version', fm.version, 'version must be <major>.<minor>');
  if (fm.title !== undefined && fm.title.length > 100) add('F6', 'title', fm.title.slice(0, 40), 'title longer than 100 characters');
  for (const v of fm.evidence || []) if (!parseEvidenceItem(v)) add('F6', 'evidence', v, 'evidence item must be DEC-nnnn, PROTO-DEC-nnnn, PROTO-DEC-nnnn:<k>, sig-..., path:line or path:<a>-<b>');
  for (const v of fm.back_edges || []) if (!/^\d+>\d+\/\d+\/[a-z][a-z-]*$/.test(v)) add('F6', 'back_edges', v, 'back edge must be <from>><to>/<budget>/<exit>');
  for (const v of fm.supersedes || []) if (!(/^[A-Z][A-Za-z0-9-]*@\d+\.\d+$/.test(v) || /^legacy:[A-Za-z0-9._\-/]+:\d+$/.test(v))) add('F6', 'supersedes', v, 'supersedes item must be <id>@<version> or legacy:<path>:<line>');
  if (fm.superseded_by !== undefined && !/^[A-Z][A-Za-z0-9-]*@\d+\.\d+$/.test(fm.superseded_by)) add('F6', 'superseded_by', fm.superseded_by, 'superseded_by must be <id>@<version>');
  for (const v of fm.decision || []) if (!/^PROTO-DEC-\d{4}$/.test(v)) add('F6', 'decision', v, 'decision item must be PROTO-DEC-nnnn');
  if (fm.owner_approval !== undefined && !(fm.owner_approval === 'none' || DECISION_ID.test(fm.owner_approval))) add('F6', 'owner_approval', fm.owner_approval, 'owner_approval must be a decision id or none');
  if (fm.cost_basis !== undefined && !/^(?:(?:attempts|minutes|owner)=\d+|owner=unknown|unknown)$/.test(fm.cost_basis)) add('F6', 'cost_basis', fm.cost_basis, 'cost_basis must be attempts=<n>, minutes=<n>, owner=<n>, owner=unknown or unknown');
  if (fm.trial !== undefined && !/^metric=M-\d{3}; kill=.+; until=.+$/.test(fm.trial)) add('F6', 'trial', fm.trial.slice(0, 40), 'trial must be "metric=<M-id>; kill=<condition>; until=<date or batch>"');
  for (const v of fm.tools || []) if (!/^TOOL-[a-z][a-z0-9-]*$/.test(v)) add('F6', 'tools', v, 'tools item must be TOOL-<name>');
  for (const v of fm.enforced_by || []) if (!isRepoPath(v)) add('F6', 'enforced_by', v, 'enforced_by item must be a repo-relative path');
  // F2 required keys by type
  const type = D.types.has(fm.type) ? fm.type : null;
  if (!fm.type) add('F2', 'id', 'type', 'required key missing');
  if (type) for (const key of REQUIRED_KEYS[type]) if (!Object.hasOwn(fm, key)) add('F2', 'id', key, `required key missing for type ${type}`);
  // F3 conditional keys
  if (['S', 'S~'].includes(fm.enforcement) && !fm.enforced_by) add('F3', 'enforcement', 'enforced_by', 'enforcement S or S~ requires enforced_by');
  if ((fm.evidence_class || []).includes('B') && !fm.cost_basis) add('F3', 'evidence_class', 'cost_basis', 'evidence class B requires cost_basis');
  if (fm.status === 'trial' && (fm.evidence_class || []).some(c => c === 'C' || c === 'D') && !fm.trial) add('F3', 'status', 'trial', 'class C or D in trial requires trial');
  if (fm.status === 'superseded' && !fm.superseded_by) add('F3', 'status', 'superseded_by', 'status superseded requires superseded_by');
  // F8 active without approval
  if (fm.status === 'active' && (!fm.owner_approval || fm.owner_approval === 'none' || !fm.decision || !fm.decision.length)) add('F8', 'status', 'active', 'status active requires owner_approval and decision');
  // F8 class C/D with an open trial: R-L0-17.5 has a class C/D record pass its
  // trial before it becomes active. The `trial:` field is the open-trial marker; the owner
  // act that closes a trial moves the record, so the field still being present while the
  // status is active is the finding (class C + active + open trial).
  if (fm.status === 'active' && (fm.evidence_class || []).some(c => c === 'C' || c === 'D') && fm.trial !== undefined) {
    add('F8', 'trial', fm.trial.slice(0, 40), 'status active with an open trial in a class C/D record (R-L0-17.5: pass a trial before active)');
  }
  // F8 active record that says it is not binding (PROTO-DEC-0165 item 4): an active record is binding,
  // so the sentence contradicts its status. Fenced code blocks and inline code spans are quoting, not
  // the record's own voice, and are skipped.
  if (fm.status === 'active') {
    let fence = false;
    for (let i = rec.bodyStart; i < rec.lines.length; i++) {
      const line = rec.lines[i].replace(/\r$/, '');
      if (/^(```|~~~)/.test(line)) { fence = !fence; continue; }
      if (fence) continue;
      if (/\bNot binding until approved\b/.test(line.replace(/`[^`]*`/g, ''))) {
        f.push({ code: 'F8', path: rel(file), line: i + 1, value: 'Not binding until approved', message: 'status active with the sentence "Not binding until approved" in the body (PROTO-DEC-0165: an active record is binding)' });
      }
    }
  }
  // F7 headings
  const body = bodyStructure(rec);
  if (type) {
    let lastIndex = -1;
    for (const name of REQUIRED_HEADINGS[type]) {
      const index = body.headings.findIndex(h => h.name === name);
      if (index < 0) f.push({ code: 'F7', path: rel(file), line: rec.bodyStart, value: name, message: `required heading "## ${name}" missing` });
      else if (index < lastIndex) f.push({ code: 'F7', path: rel(file), line: body.headings[index].line, value: name, message: `heading "## ${name}" out of order` });
      else lastIndex = index;
    }
  }
  // F7 version consistency: the front matter version equals the newest change-log
  // line. The corpus writes change logs oldest-first, so "the top line of the changelog" is the
  // highest version; comparing against the maximum is order-independent and deterministic. A
  // change log without a single version line fails closed - the version cannot be verified.
  const log = body.headings.find(h => h.name === 'Change log');
  if (/^\d+\.\d+$/.test(fm.version || '') && log) {
    const seen = [];
    for (let i = log.line; i < rec.lines.length; i++) {
      const line = rec.lines[i].replace(/\r$/, '');
      if (/^## /.test(line)) break;
      const m = line.match(/^- (\d+)\.(\d+) — /);
      if (m) seen.push([Number(m[1]), Number(m[2]), `${m[1]}.${m[2]}`]);
    }
    if (!seen.length) add('F7', 'version', fm.version, 'the change log carries no version line; the front matter version cannot be verified');
    else {
      const newest = seen.reduce((a, b) => (b[0] > a[0] || (b[0] === a[0] && b[1] >= a[1])) ? b : a);
      if (fm.version !== newest[2]) add('F7', 'version', fm.version, `front matter version ${fm.version} does not equal the newest change-log line ${newest[2]}`);
    }
  }
  return body;
}

// F9 across records: anchoring and single definition.
function lintRules(records) {
  const findings = [];
  const root = records.find(r => r.fm && r.fm.id === 'P-L0-000');
  const rootRules = new Set(root ? root.body.rules.map(x => x.id) : []);
  const defined = new Map();
  for (const r of records) {
    if (!r.fm || !r.body) continue;
    const id = r.fm.id || '';
    for (const item of r.body.listItemsWithoutId) findings.push({ code: 'F9', path: r.rel, line: item.line, value: item.text, message: 'a "## Rules" item without an anchored rule id' });
    for (const item of r.body.unparsed) findings.push({ code: 'F10', path: r.rel, line: item.line, value: item.token, message: `"## Rules" line starts like a rule id but does not parse (schema section 3): ${item.text}` });
    for (const rule of r.body.rules) {
      const where = { code: 'F9', path: r.rel, line: rule.line, value: rule.id };
      if (defined.has(rule.id)) findings.push({ ...where, message: `rule id also defined at ${defined.get(rule.id)}` });
      else defined.set(rule.id, `${r.rel}:${rule.line}`);
      if (id === 'P-L0-000') {
        if (!/^R-L0-\d{2}$/.test(rule.id)) findings.push({ ...where, message: 'the root defines R-L0-<nn> only' });
      } else if (r.fm.layer === 'L0') {
        const m = rule.id.match(/^(R-L0-\d{2})\.\d+$/);
        if (!m) findings.push({ ...where, message: 'an L0 record defines sub-rules R-L0-<nn>.<k> of a root rule' });
        else if (!root) findings.push({ ...where, message: 'root L0-ROOT.md (P-L0-000) not among the scanned records' });
        else if (!rootRules.has(m[1])) findings.push({ ...where, message: `root rule ${m[1]} is not defined in L0-ROOT.md` });
      } else {
        const anchor = anchorFor(r.fm);
        if (!anchor || !rule.id.startsWith(`${anchor}.`)) findings.push({ ...where, message: `rule id must be anchored as ${anchor || '<record anchor>'}.<k>` });
      }
    }
  }
  return findings;
}
function anchorFor(fm) {
  const id = fm.id || '';
  let m = id.match(/^P-(L[0-9]-\d{3})$/);
  if (m) return `R-${m[1]}`;
  m = id.match(/^S-(\d{3})$/);
  if (m && fm.layer) return `R-${fm.layer}-S${m[1]}`;
  m = id.match(/^(?:ROLE|TOOL|APP|SCHEMA)-(.+)$/);
  if (m && fm.layer) return `R-${fm.layer}-${m[1]}`;
  m = id.match(/^M-(\d{3})$/);
  if (m && fm.layer) return `R-${fm.layer}-M${m[1]}`;
  return null;
}


function lint(targets) {
  if (!targets.length) throw new InputError('lint needs at least one path');
  dicts(); // a missing or malformed dictionaries block is a named exit 2 before any record is parsed
  const { records, errors } = loadRecords(targets);
  const findings = [...errors];
  for (const r of records) { r.body = lintRecord(r, r.file); findings.push(...r.findings); }
  // A sub-rule needs its root; find it next to the scanned records when it was not passed.
  if (!records.some(r => r.fm.id === 'P-L0-000') && records.some(r => r.fm.layer === 'L0')) {
    for (const candidate of new Set(records.map(r => path.join(path.dirname(r.file), 'L0-ROOT.md')))) {
      if (fs.existsSync(candidate)) { const root = parseRecord(candidate); root.file = candidate; root.rel = rel(candidate); root.body = bodyStructure(root); records.push({ ...root, rootOnly: true }); break; }
    }
  }
  findings.push(...lintRules(records).filter(x => !records.find(r => r.rel === x.path && r.rootOnly)));
  return { records: records.filter(r => !r.rootOnly), findings: sortFindings(findings) };
}

function sortFindings(list) {
  return list.sort((a, b) => cmp(a.path, b.path) || a.line - b.line || cmp(a.code, b.code) || cmp(String(a.value), String(b.value)));
}
function exitFor(findings) {
  if (findings.some(x => dicts().exit2.has(x.code))) return 2;
  return findings.length ? 1 : 0;
}

// ---------- catalog ----------

function designRoot(root) { return /(^|\/)docs\/core-arch(\/|$)/.test(rel(path.resolve(root))); }

function catalogText(root) {
  const { records, errors } = loadRecords([root], { skipUnlisted: designRoot(root) });
  const f1 = [...errors, ...records.flatMap(r => r.findings.filter(x => x.code === 'F1'))];
  const sources = records.map(r => r.file).sort((a, b) => cmp(rel(a), rel(b)));
  const rows = records.map(r => r.fm).sort((a, b) => cmp(a.layer || '', b.layer || '') || cmp(a.id || '', b.id || ''));
  const list = v => (Array.isArray(v) ? v.join(', ') : (v || ''));
  const lines = ['# CATALOG', '', 'Derived by `node .ai/bin/protocol-core.cjs catalog`; never edit by hand. Loading levels: exists and summary (procedure.schema.md section 4).', '', '## Sources', ''];
  for (const s of sources) lines.push(`- sha256:${crypto.createHash('sha256').update(fs.readFileSync(s)).digest('hex')}  ${rel(s)}`);
  lines.push('', '## Records', '', '| id | version | layer | type | status | roles | stages | triggers | title |', '|---|---|---|---|---|---|---|---|---|');
  for (const fm of rows) lines.push(`| ${[fm.id, fm.version, fm.layer, fm.type, fm.status, list(fm.roles), list(fm.stages), list(fm.triggers), fm.title].map(x => String(x || '').replace(/\|/g, '/')).join(' | ')} |`);
  return { text: lines.join('\n') + '\n', f1, count: rows.length };
}

function catalogTarget(root) {
  return designRoot(root) ? path.join(REPO, '.ai', 'runtime', 'CATALOG.md') : path.join(path.resolve(root), 'CATALOG.md');
}

// ---------- RULE-MAP and EXTERNAL-PENDING ----------

// The map's version is its table header: LCC-9 fails closed (exit 2) when the map is absent or
// does not carry the current format, so an old or foreign map can never pass silently.
// The map is read only from its canonical location next to the scanned records; the
// reserve copy is gone, so a missing map is a named failure.
function mapFile(root) {
  const file = path.join(path.resolve(root), 'RULE-MAP.md');
  if (!fs.existsSync(file)) return null;
  if (!fs.readFileSync(file, 'utf8').includes(MAP_HEADER)) {
    throw new InputError(`unsupported RULE-MAP version in ${rel(file)}: the current table header "${MAP_HEADER}" is missing`);
  }
  return file;
}

// Ids the map's Home cells name, with the map as the referrer: a registry row may point here
// (for example P-L9-001 through AR-058), so the both-ways reconciliation must see these references.
function mapRefs(file, known) {
  const refs = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const cells = line.split('|').map(c => c.trim());
    if (cells.length < 7 || !/^[A-Z]+-\d+/.test(cells[1] || '')) continue;
    for (const m of cells[4].matchAll(BODY_ID)) refs.push({ ref: m[1], path: rel(file), resolved: known.has(m[1]) });
  }
  return refs;
}

// The registry of external pending references (.ai/core/EXTERNAL-PENDING.md): the only
// way a reference outside the package passes a gate. Parsed fail-closed: a missing file, a
// foreign header, a malformed row or a status other than open/closed is a named exit 2.
function registryPathFor(root, explicit) {
  return path.resolve(explicit || path.join(path.resolve(root), REGISTRY_NAME));
}
// In design mode an open registry row resolves a reference that no stage
// plans (the `tools:` field of P-L0-001). The registry is consulted only when the
// default file exists - a design-era corpus without one keeps its behavior - and the both-ways
// reconciliation stays with the --package and --layer gates.
function softRegistry(root) {
  const file = registryPathFor(root, undefined);
  return fs.existsSync(file) ? loadRegistry(file) : null;
}
function loadRegistry(file) {
  if (!fs.existsSync(file)) throw new InputError(`${rel(file)} not found (the gate needs the registry of external pending references)`);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  if (!lines.some(l => l.replace(/\r$/, '').trim() === REGISTRY_HEADER)) {
    throw new InputError(`unsupported EXTERNAL-PENDING format in ${rel(file)}: the current header "${REGISTRY_HEADER}" is missing`);
  }
  const rows = [];
  const seen = new Set();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.startsWith('|')) continue;
    const cells = line.split('|').map(c => c.trim());
    if (cells[1] === 'id' || /^-+$/.test(cells[1] || '')) continue;
    if (cells.length !== 8) throw new InputError(`malformed registry row ${rel(file)}:${i + 1}: expected six columns in "${line.slice(0, 60)}"`);
    const [id, referrer, target, closing, owner, status] = cells.slice(1, 7);
    if (!RECORD_ID.test(id) || !isRepoPath(referrer) || !/^L[0-9]$/.test(target) || !closing || !owner) {
      throw new InputError(`malformed registry row ${rel(file)}:${i + 1}: "${line.slice(0, 60)}"`);
    }
    if (status !== 'open' && status !== 'closed') throw new InputError(`malformed registry row ${rel(file)}:${i + 1}: status "${status}" must be open or closed`);
    const key = `${id}|${referrer}`;
    if (seen.has(key)) throw new InputError(`duplicate registry row ${id} of ${referrer} in ${rel(file)}`);
    seen.add(key);
    rows.push({ id, referrer, target, closing, owner, status, line: i + 1 });
  }
  return rows;
}

// Both ways: every registry row must name a reference its referrer actually makes, and
// every unresolved reference must have its open row. An open row whose reference resolved, a
// closed row whose reference is still unresolved, and a row nobody references are stale
// exceptions - they fail, they never expire silently.
function registryStaleRows(registry, idRefs) {
  const stale = [];
  for (const row of registry) {
    const refs = idRefs.filter(x => x.ref === row.id && x.path === row.referrer);
    if (!refs.length) stale.push({ ...row, reason: 'no reference to this id from the referrer' });
    else if (row.status === 'open' && refs.every(x => x.resolved)) stale.push({ ...row, reason: 'the reference is resolved; close or remove the row' });
    else if (row.status === 'closed' && refs.some(x => !x.resolved)) stale.push({ ...row, reason: 'the row is closed but the reference is unresolved' });
  }
  return stale.sort((a, b) => cmp(a.id, b.id) || cmp(a.referrer, b.referrer));
}

// ---------- check-links ----------

function decisionHeadings() {
  const file = path.join(REPO, '.ai', 'DECISIONS.md');
  if (!fs.existsSync(file)) throw new InputError('.ai/DECISIONS.md not found');
  const ids = new Set();
  for (const m of fs.readFileSync(file, 'utf8').matchAll(/^### ((?:PROTO-)?DEC-\d{4})\s*$/gm)) ids.add(m[1]);
  return ids;
}
function supersededDecisions() {
  const text = fs.readFileSync(path.join(REPO, '.ai', 'DECISIONS.md'), 'utf8');
  const out = new Set();
  for (const m of text.matchAll(/^### ((?:PROTO-)?DEC-\d{4})\s*\n+Status:[ \t]*Superseded/gm)) out.add(m[1]);
  return out;
}
function signalIds() {
  const file = path.join(REPO, '.ai', 'SIGNALS.md');
  if (!fs.existsSync(file)) return new Set();
  return new Set([...fs.readFileSync(file, 'utf8').matchAll(/\bsig-[A-Za-z0-9._-]+/g)].map(m => m[0]));
}
// Ids that a design program under docs/core-arch plans: a record drafted in a stage directory, or an
// id named in one of its program documents. A forward reference to one is PENDING in design mode, not DANGLING.
function plannedIds() {
  const dir = path.join(REPO, 'docs', 'core-arch');
  const planned = new Map();
  if (!fs.existsSync(dir)) return planned;
  for (const stage of fs.readdirSync(dir).filter(n => /^stage-\d+$/.test(n)).sort()) {
    for (const file of listMarkdown(path.join(dir, stage))) {
      const rec = parseRecord(file);
      if (rec.fm && rec.fm.id && !planned.has(rec.fm.id)) planned.set(rec.fm.id, rel(file));
    }
  }
  for (const f of fs.readdirSync(dir).filter(n => /^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+\.md$/.test(n)).sort()) {
    for (const m of fs.readFileSync(path.join(dir, f), 'utf8').matchAll(BODY_ID)) if (!planned.has(m[1])) planned.set(m[1], `docs/core-arch/${f}`);
  }
  return planned;
}
function checkLine(target) {
  const m = target.match(/^(.*):(\d+)$/);
  if (!m) return 'unparseable';
  const file = path.join(REPO, m[1]);
  if (!isRepoPath(m[1]) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return 'missing file';
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const n = Number(m[2]);
  if (n < 1 || n > lines.length) return `line ${n} beyond ${lines.length}`;
  if (lines[n - 1].trim() === '') return `line ${n} is blank`;
  // A heading cited as content. Whether a content line says what is claimed stays with the reviewer.
  if (/^#{1,6} /.test(lines[n - 1])) return `line ${n} is a heading, not content`;
  return null;
}
// A path reference under an archived prefix is provenance that resolves through the archive
// index of the project (a citation of an old path resolves through that index; the cited
// files are not rewritten), so only its form is checked -
// repo-relative path without traversal, line >= 1, range a < b - and the filesystem is never read
// for it. Live documents and kernel paths keep the full checkLine resolvability, a live range
// through its two endpoint lines; decision ids, signal ids and record ids stay mandatory. The
// prefix is the common root of the index's research rows (at minimum docs/research/**);
// the index itself is not read at runtime, so the kernel stays
// self-contained without docs/.
const ARCHIVED_PREFIX = 'docs/research/';
function checkPathRef(target) {
  const m = target.match(/^([A-Za-z0-9._\-/]+):(\d+)(?:-(\d+))?$/);
  if (m && isRepoPath(m[1])) {
    const from = Number(m[2]);
    const to = m[3] === undefined ? from : Number(m[3]);
    if (from < 1) return `line ${m[2]} below 1`;
    if (to < from) return `range ${m[2]}-${m[3]} is empty`;
    if (m[1].startsWith(ARCHIVED_PREFIX)) return null;
    if (m[3] !== undefined) {
      const first = checkLine(`${m[1]}:${m[2]}`);
      return first || checkLine(`${m[1]}:${m[3]}`);
    }
  }
  return checkLine(target);
}

function checkLinks(root, design, opts = {}) {
  const { records, errors } = loadRecords([root], { skipUnlisted: designRoot(root) });
  const rows = [];
  const add = (token, r, line, ref, extra = {}) => rows.push({ token, path: r.rel, line, ref, ...extra });
  const unparseable = [...errors, ...records.flatMap(r => r.findings.filter(x => x.code === 'F1'))];
  const known = new Set(records.map(r => r.fm.id));
  const decisions = decisionHeadings();
  const signals = signalIds();
  const planned = plannedIds();
  const registry = opts.registry || null;
  // Every record-id reference, resolved or not: the both-ways reconciliation of the registry
  // needs the full multiset, not only the failures.
  const idRefs = [];
  const resolveId = (r, line, ref) => {
    idRefs.push({ ref, path: r.rel, resolved: known.has(ref) });
    if (known.has(ref)) return;
    if (design && planned.has(ref)) { add('PENDING', r, line, ref, { planned: planned.get(ref) }); return; }
    const reg = registry && registry.find(x => x.status === 'open' && x.id === ref && x.referrer === r.rel);
    if (reg) { add('REGISTERED', r, line, ref, { closing: reg.closing }); return; }
    add('DANGLING', r, line, ref);
  };
  for (const r of records) {
    const fm = r.fm;
    const at = key => r.fmLines[key] || 1;
    for (const v of fm.supersedes || []) {
      if (v.startsWith('legacy:')) { const bad = checkPathRef(v.slice(7)); if (bad) add('BAD_LINE', r, at('supersedes'), v, { reason: bad }); }
      else resolveId(r, at('supersedes'), v.split('@')[0]);
    }
    if (fm.superseded_by) resolveId(r, at('superseded_by'), fm.superseded_by.split('@')[0]);
    for (const v of fm.tools || []) resolveId(r, at('tools'), v);
    for (const v of fm.decision || []) if (!decisions.has(v)) add('DANGLING', r, at('decision'), v);
    if (fm.owner_approval && fm.owner_approval !== 'none' && !decisions.has(fm.owner_approval)) add('DANGLING', r, at('owner_approval'), fm.owner_approval);
    for (const v of fm.evidence || []) {
      const item = parseEvidenceItem(v);
      if (!item) {
        add('BAD_LINE', r, at('evidence'), v, { reason: 'unparseable' });
      } else if (item.form === 'decision' || item.form === 'decision-item') {
        if (!decisions.has(item.id)) add('DANGLING', r, at('evidence'), v);
      } else if (item.form === 'signal') {
        if (!signals.has(item.id)) add('DANGLING', r, at('evidence'), v);
      } else {
        const bad = checkPathRef(v);
        if (bad) add('BAD_LINE', r, at('evidence'), v, { reason: bad });
      }
    }
    // A fenced block is quoted material, never a reference (the same rule as for rule
    // lines): the canon's dictionaries block names artifact ids (TOOL-registry)
    // that would otherwise read as record references in every corpus carrying the canon.
    let fence = false;
    for (let i = r.bodyStart; i < r.lines.length; i++) {
      const line = r.lines[i].replace(/\r$/, '');
      if (/^(```|~~~)/.test(line)) { fence = !fence; continue; }
      if (fence) continue;
      for (const m of line.matchAll(BODY_ID)) if (m[1] !== fm.id) resolveId(r, i + 1, m[1]);
    }
  }
  // The both-ways reconciliation (map refs and stale rows) runs only when the caller passes the
  // registry for a gate: design mode resolves registered references but never reconciles (SPEC).
  if (registry && opts.reconcile !== false) {
    const map = mapFile(root);
    if (map) idRefs.push(...mapRefs(map, known));
    for (const stale of registryStaleRows(registry, idRefs)) {
      rows.push({ token: 'REGISTRY_STALE', path: stale.referrer, line: stale.line, ref: stale.id, status: stale.status, reason: stale.reason });
    }
  }
  const sorted = rows.sort((a, b) => cmp(a.path, b.path) || a.line - b.line || cmp(a.ref, b.ref));
  const dedup = sorted.filter((x, i) => i === 0 || !(x.path === sorted[i - 1].path && x.line === sorted[i - 1].line && x.ref === sorted[i - 1].ref));
  // Pending = references that passed as pending: PENDING and REGISTERED record rows, plus open
  // registry rows whose live reference comes from the RULE-MAP home (for example P-L9-001 via AR-058).
  const covered = new Set(dedup.filter(x => x.token === 'REGISTERED').map(x => `${x.ref}|${x.path}`));
  const mapRegistered = registry ? registry.filter(row => row.status === 'open'
    && idRefs.some(x => x.ref === row.id && x.path === row.referrer && !x.resolved)
    && !covered.has(`${row.id}|${row.referrer}`)).length : 0;
  const pending = dedup.filter(x => x.token === 'PENDING' || x.token === 'REGISTERED').length + mapRegistered;
  return { rows: dedup, unparseable, records, pending };
}

// ---------- packet (procedure.schema.md section 4) ----------

// Legacy file-size computation, shared by `packet` and the LCC advisories; the
// packet compiler (protocol-packet.cjs) delivers the actual packet. Full load: the root; records whose roles
// name the slot explicitly and whose stages name the stage or any; schema records named in the
// inputs of the full-load records. Records with roles: [all] and everything else load at
// summary, rendered as their CATALOG row (loading levels, schema section 4).
function summaryBytes(rec) {
  const fm = rec.fm;
  const list = v => (Array.isArray(v) ? v.join(', ') : '');
  const cells = [fm.id, fm.version, fm.layer, fm.type, fm.status, list(fm.roles), list(fm.stages), list(fm.triggers), fm.title]
    .map(x => String(x || '').replace(/\|/g, '/'));
  return Buffer.byteLength(`| ${cells.join(' | ')} |\n`);
}

function computePacket(records, role, stage) {
  const root = records.find(r => r.fm && r.fm.id === 'P-L0-000') || null;
  const full = new Map();
  if (root) full.set(root, 'root');
  for (const r of records) {
    if (!r.fm || full.has(r)) continue;
    if ((r.fm.roles || []).includes(role) && (r.fm.stages || []).some(s => s === stage || s === 'any')) full.set(r, 'role-stage');
  }
  const schemas = new Map();
  for (const r of records) if (r.fm && r.fm.type === 'schema') { schemas.set(r.fm.id, r); schemas.set(r.rel, r); }
  for (const r of [...full.keys()]) {
    for (const v of (r.fm.inputs || [])) {
      const s = schemas.get(v);
      if (s && !full.has(s)) full.set(s, 'schema-input');
    }
  }
  const files = records.filter(r => r.fm).map(r => {
    const isFull = full.has(r);
    return {
      path: r.rel,
      level: isFull ? 'full' : 'summary',
      reason: isFull ? full.get(r) : ((r.fm.roles || []).includes('all') ? 'roles-all' : 'other'),
      bytes: isFull ? Buffer.byteLength(r.text) : summaryBytes(r),
    };
  }).sort((a, b) => cmp(a.path, b.path));
  const bytes = files.reduce((a, f) => a + f.bytes, 0);
  return {
    files, bytes,
    root: root ? root.rel : null,
    full: files.filter(f => f.level === 'full').length,
    summary: files.filter(f => f.level === 'summary').length,
    over: bytes > PACKET_BUDGET,
  };
}

// ---------- root size ----------

// The root budget: bytes (the budget unit) and characters (informational) of the root
// record P-L0-000. Over the 9 500 B hard limit exit 2, over the 8 500 B warn line exit 1;
// the 8 000 B goal is printed, never enforced. Same tree, same output; no root is exit 2.
function checkRootSize(root) {
  const { records } = loadRecords([root], { skipUnlisted: designRoot(root) });
  const rootRec = records.find(r => r.fm && r.fm.id === 'P-L0-000');
  if (!rootRec) throw new InputError(`root P-L0-000 not found under ${rel(path.resolve(root))}; the root budget needs the root record`);
  const bytes = Buffer.byteLength(rootRec.text);
  const chars = [...rootRec.text].length;
  const state = bytes > ROOT_LIMIT ? 'over' : (bytes > ROOT_WARN ? 'warn' : 'within');
  return { path: rootRec.rel, bytes, chars, state, code: state === 'over' ? 2 : (state === 'warn' ? 1 : 0) };
}

// ---------- lcc ----------

function lcc(layer, root, design, opts = {}) {
  if (!/^L[0-9]$/.test(layer)) throw new InputError(`layer must be L0..L9, got ${layer}`);
  const D = dicts();
  const all = lint([root]);
  const records = all.records;
  const inLayer = records.filter(r => r.fm.layer === layer);
  if (!inLayer.length) throw new InputError(`no records of layer ${layer} under ${root}`);
  const layerOf = new Map(records.map(r => [r.fm.id, r.fm.layer]));
  const results = {};
  const ids = list => [...new Set(list)].sort();
  // LCC-1 one home and anchoring (F9 and unparsed rule lines F10 of this layer, same parser as lint)
  const f9 = all.findings.filter(x => (x.code === 'F9' || x.code === 'F10') && inLayer.some(r => r.rel === x.path));
  results[1] = ids(f9.map(x => x.value));
  // LCC-2 direction: a reference down to another layer is allowed only as a forward reference to a
  // record a named stage writes (design mode: planned; strict mode, a package freeze: resolved).
  // Freeze mode (--layer) keeps planned references pending and takes dangling references only from
  // the EXTERNAL-PENDING registry, reconciled both ways; a stale row fails with them.
  // Design mode resolves registry rows without reconciling: reconcile only at the freeze gate.
  const links = checkLinks(root, design, { registry: opts.registry || null, reconcile: !!opts.freeze });
  const unresolvedHere = links.rows.filter(x => inLayer.some(r => r.rel === x.path) && RECORD_ID.test(x.ref) && (x.token === 'DANGLING' || (!design && x.token === 'PENDING')));
  results[2] = ids([...unresolvedHere.map(x => `${x.path.split('/').pop()}>${x.ref}`),
    ...links.rows.filter(x => x.token === 'REGISTRY_STALE').map(x => `registry:${x.ref}`)]);
  // LCC-3 decisions: every referenced decision exists and is not superseded
  const known = decisionHeadings();
  const superseded = supersededDecisions();
  const decRefs = inLayer.flatMap(r => [...(r.fm.decision || []), ...(r.fm.evidence || []).filter(v => DECISION_ID.test(v)), r.fm.owner_approval].filter(Boolean).filter(v => v !== 'none'));
  results[3] = ids(decRefs.filter(v => !known.has(v) || superseded.has(v)));
  // LCC-4 roles; LCC-5 tools; LCC-6 loops (form and prose)
  results[4] = ids(inLayer.flatMap(r => (r.fm.roles || []).filter(v => !D.roles.has(v))));
  const toolIds = new Set(records.filter(r => r.fm.type === 'tool').map(r => r.fm.id));
  const planned = plannedIds();
  // LCC-5 accepts a tool declared pending with its stage: planned in design mode, or an open
  // registry row naming the record as its referrer (upward references come from the
  // registry at the freeze gate).
  const registeredTools = opts.registry ? new Set(opts.registry.filter(x => x.status === 'open')
    .map(x => `${x.id}|${x.referrer}`)) : new Set();
  results[5] = ids(inLayer.flatMap(r => (r.fm.tools || [])
    .filter(t => !toolIds.has(t) && !(design && planned.has(t)) && !registeredTools.has(`${t}|${r.rel}`))));
  results[6] = ids(inLayer.flatMap(r => {
    const bad = (r.fm.back_edges || []).filter(v => !/^\d+>\d+\/\d+\/[a-z][a-z-]*$/.test(v));
    const hasProse = r.body.headings.some(h => h.name === 'Back edges');
    return [...bad, ...((r.fm.back_edges || []).length && !hasProse ? [`${r.fm.id}:no-prose`] : [])];
  }));
  // Legacy full-load advisory: the maximum over all slot/stage pairs of this
  // layer under the old schema section 4 loading rule: root and pair members in full,
  // the rest as summary rows. This historical layer-only number excludes schemas
  // of other layers; the compiler-delivered profile below is the actual gate.
  const rootRec = records.find(r => r.fm.id === 'P-L0-000');
  const layerCorpus = inLayer.includes(rootRec) ? inLayer : (rootRec ? [rootRec, ...inLayer] : inLayer);
  let largest = { slot: '-', stage: '-', bytes: 0 };
  for (const slot of [...D.roles].filter(s => s !== 'all')) {
    for (const stage of [...D.stages]) {
      const bytes = computePacket(layerCorpus, slot, stage).bytes;
      if (bytes > largest.bytes) largest = { slot, stage, bytes };
    }
  }
  const compiled = deliveredProfiles(root);
  results[8] = compiled.failures;
  // Legacy LCC-8c estimate (PROTO-DEC-0161 item 1), advisory only. This is the
  // scanned tree's file estimate, whatever its home layer (records homed above the layer under check, such as the
  // L5 schemas, travel too), so the same loading rule runs over the whole tree - the figure the
  // `packet` command reports. Over the budget it is a warning only: never in `results` or the exit.
  let delivered = { slot: '-', stage: '-', bytes: 0 };
  for (const slot of [...D.roles].filter(s => s !== 'all')) {
    for (const stage of [...D.stages]) {
      const bytes = computePacket(records, slot, stage).bytes;
      if (bytes > delivered.bytes) delivered = { slot, stage, bytes };
    }
  }
  // LCC-9 coverage: RULE-MAP rows homed in this layer name an existing record or a planned one.
  // Fail-closed: no map, or a map without the current table header, is a named exit 2 -
  // the check never passes silently on a missing or wrong-version map.
  const map = mapFile(root);
  if (!map) throw new InputError(`RULE-MAP.md not found at ${rel(path.join(path.resolve(root), 'RULE-MAP.md'))}; LCC-9 fails closed`);
  const missing = [];
  for (const line of fs.readFileSync(map, 'utf8').split('\n')) {
    const cells = line.split('|').map(c => c.trim());
    if (cells.length < 7 || !/^[A-Z]+-\d+/.test(cells[1] || '') || cells[5] !== layer) continue;
    for (const m of cells[4].matchAll(BODY_ID)) if (!layerOf.has(m[1]) && !(design && planned.has(m[1]))) missing.push(`${cells[1]}>${m[1]}`);
  }
  results[9] = ids(missing);
  return { results, largest, delivered, compiled, map: rel(map), pending: links.pending };
}

// Use the launcher compiler itself, including its default step-down and refusal.
// No frame/client is invented: unknown client capabilities keep the compiler's
// conservative no-file-access semantics. Full profile bytes are advisory only.
function deliveredProfiles(root) {
  const absolute = path.resolve(root);
  const repo = path.dirname(path.dirname(absolute));
  const identity = realInside(path.join(repo, '.ai', 'core'), absolute, { allowRoot: true });
  if (!identity.ok || !identity.exists || identity.type !== 'dir' || identity.rel !== '') throw new InputError('LCC-8 needs a repository kernel at .ai/core');
  // The same canonical dictionary reader and repository root as compile(); no cwd/caller pair set.
  let D;
  try { D = loadDictionaries(repo); }
  catch { throw new InputError('LCC-8 dictionaries unavailable: .ai/core/schema/procedure.schema.md cannot be read or is malformed'); }
  const { compile } = require('./protocol-packet.cjs');
  const pairs = [];
  const failures = [];
  for (const role of [...D.roles].filter(r => r !== 'all')) {
    for (const stage of [...D.stages].filter(s => s !== 'any')) {
      const options = { root: repo, role, stage };
      let actual; let full;
      try {
        actual = compile(options);
      } catch {
        failures.push(`${role}/${stage}=compiler-error`);
        pairs.push({ role, stage, bytes: null, fullBytes: null, exit: 2 });
        continue;
      }
      const measured = r => r && r.manifest && typeof r.text === 'string' &&
        Number.isSafeInteger(r.manifest.bytes) && r.manifest.bytes > 0 &&
        r.manifest.bytes === Buffer.byteLength(r.text);
      if (!measured(actual) || ![0, 1].includes(actual.exit)) {
        failures.push(`${role}/${stage}=measurement-invalid`);
        pairs.push({ role, stage, bytes: null, fullBytes: null, exit: 2 });
        continue;
      }
      // The full profile is advisory even if its measurement is unavailable.
      // A failed advisory compile never changes a valid delivered-profile exit.
      try { full = compile({ ...options, profile: 'full' }); } catch { full = null; }
      const p = { role, stage, bytes: actual.manifest.bytes, fullBytes: measured(full) ? full.manifest.bytes : null,
        exit: actual.exit, profile: actual.manifest.profile?.level || 4 };
      pairs.push(p);
      if (p.exit !== 0 || p.bytes > LCC8_DELIVERED_BUDGET) failures.push(`${role}/${stage}=delivered:${p.bytes}B/full:${p.fullBytes === null ? 'unknown' : `${p.fullBytes}B`}`);
    }
  }
  if (!pairs.length) failures.push('no-role-stage-pairs');
  return { pairs, failures };
}

// ---------- verify ----------


// The lcc report shared by the `lcc` command and `verify --layer`.
function lccReport(layer, root, design, opts = {}) {
  const { results, largest, delivered, compiled, map, pending } = lcc(layer, root, design, { registry: opts.registry || null, freeze: opts.freeze });
  const cell = n => (results[n].length ? `fail:${results[n].join(',')}` : 'pass');
  const rows = [row('LCC', {
    layer, root: rel(path.resolve(root)), mode: opts.freeze ? 'layer' : (design ? 'design' : 'strict'),
    rulemap: map || 'none', registry: opts.freeze ? rel(registryPathFor(root, opts.pendingPath)) : undefined,
    largestPacket: `${largest.slot}/${largest.stage}=${largest.bytes}B`, budget: `${PACKET_BUDGET}B`,
  })];
  for (const n of [1, 2, 3, 4, 5, 6]) rows.push(row('LCC_CHECK', { id: `LCC-${n}`, result: cell(n) }));
  rows.push(row('LCC_CHECK', { id: 'LCC-8', result: cell(8), budget: `${LCC8_DELIVERED_BUDGET}B`, pairs: compiled.pairs.length, scope: 'delivered-profile' }));
  for (const p of compiled.pairs) rows.push(row('LCC_PACKET', {
    role: p.role, stage: p.stage, delivered: p.bytes === null ? 'unknown' : `${p.bytes}B`,
    full: p.fullBytes === null ? 'unknown' : `${p.fullBytes}B`, profile: p.profile,
    exit: p.exit, fullProvisional: 'true',
  }));
  rows.push(row('LCC_FULL', { largestPacket: `${largest.slot}/${largest.stage}=${largest.bytes}B`, scope: 'layer', provisional: 'true', advisory: 'true' }));
  const deliveredPair = `${delivered.slot}/${delivered.stage}=${delivered.bytes}B`;
  rows.push(row('LCC_CHECK', {
    id: 'LCC-8c', result: delivered.bytes > PACKET_BUDGET ? `warn:${deliveredPair}` : 'pass',
    deliveredPacket: deliveredPair, scope: 'tree', budget: `${PACKET_BUDGET}B`, provisional: 'true',
  }));
  rows.push(row('LCC_CHECK', { id: 'LCC-9', result: cell(9) }));
  rows.push(row('JOURNAL', { line: `LCC: ${layer} | ${[1, 2, 3, 4, 5, 6].map(n => `${n}=${cell(n)}`).join(' | ')} | 7=manual | 8=${cell(8)} | 9=${cell(9)}` }));
  const failed = [1, 2, 3, 4, 5, 6, 8, 9].filter(n => results[n].length);
  return { code: failed.length ? 1 : 0, rows, pending, failed: failed.map(n => `LCC-${n}`) };
}

// ---------- CLI ----------

const HELP = `protocol-core.cjs - kernel record tooling (enforces ${ENFORCES})

  lint <path|dir>...                   schema checks F1-F9; exit 0 pass, 1 rule broken, 2 malformed
  artifact-lint <path|dir>...          the L5-min artifact families (registry rows, owner-card,
                                       owner-words, state-brief, channel discipline); advisory,
                                       exit 0 pass, 1 rule broken, 2 malformed (additive to lint)
  catalog [--root <dir>] [--check]     write or verify CATALOG.md (default root .ai/core)
  check-links [--root <dir>] [--design|--strict] [--package <id> [--pending <file>]]
                                       resolve record, decision, signal and path:line references;
                                       a path under docs/research/** (an archived prefix)
                                       is checked for form only, live paths stay resolvable;
                                       --package is the strict final gate: a reference outside the
                                       package passes only as an open row of the EXTERNAL-PENDING
                                       registry (default <root>/EXTERNAL-PENDING.md), reconciled
                                       both ways - a row without its live reference fails
  packet --role <slot> --stage <stage> [--root <dir>]
                                       the schema section 4 packet: file list with loading
                                       levels and byte count; over budget exits 1; the packet
                                       compiler protocol-packet.cjs delivers the actual packet
  lcc                                  the layer-consistency gate of the kernel development; it is not
                                       part of the product and exits 2 with that reason
  verify [--root <dir>] [--design]   (--layer and --package are development gates: exit 2 here)
                                       lint + catalog --check + the gate of the mode in one run,
                                       used by validate-protocol.ps1 when .ai/core exists; the
                                       final gate is never chosen implicitly; the output carries
                                       the zone, pending, the counters and the tree SHA

Design mode is the default for a root under docs/core-arch: references to records that a program
document there plans are PENDING, not DANGLING. At a package freeze run --strict.`;

function parseOptions(args, allowed) {
  const opts = { positional: [] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { opts.positional.push(a); continue; }
    const name = a.slice(2);
    if (!(name in allowed)) throw new InputError(`unknown flag ${a}`);
    if (allowed[name] === 'value') {
      if (i + 1 >= args.length || args[i + 1].startsWith('--')) throw new InputError(`flag ${a} needs a value`);
      opts[name] = args[++i];
    } else opts[name] = true;
  }
  return opts;
}

function modeFor(root, opts) {
  if (opts.design && opts.strict) throw new InputError('--design and --strict are exclusive');
  if (opts.design) return true;
  if (opts.strict) return false;
  return designRoot(root);
}

function main(argv) {
  const [command, ...rest] = argv;
  const out = [];
  const print = line => out.push(line);
  try {
    if (!command || command === '--help' || command === 'help') { console.log(HELP + '\n  cover [--agents AGENTS.md] [--map .ai/core/RULE-MAP.md] [--json]  advisory line coverage; exit 0, unreadable input/usage 2'); return 0; }
    if (command === 'cover') {
      // Class B: no enforcement, validator wiring, artifact writes, launches, or network.
      // Shared guarded reads may use the local Windows handle helper.
      try {
        const seen = new Set();
        for (const arg of rest.filter(a => a.startsWith('--'))) {
          if (seen.has(arg)) throw new Error('USAGE');
          seen.add(arg);
        }
        const opts = parseOptions(rest, { agents: 'value', map: 'value', json: 'flag' });
        if (opts.positional.length) throw new Error('USAGE');
        const cover = require('./lib/core-cover.cjs');
        const result = cover.cover({ root: REPO, agents: opts.agents, map: opts.map });
        console.log(opts.json ? JSON.stringify(result, null, 2) : cover.table(result));
        return 0;
      } catch {
        // Do not reflect paths, argv, record text or parser errors at the output boundary.
        console.log('COVER_UNKNOWN advisory=true reason=unreadable-input-or-usage exit=2');
        return 2;
      }
    }
    if (command === 'lint') {
      const opts = parseOptions(rest, {});
      if (!opts.positional.length) throw new InputError('lint needs at least one path');
      const { records, findings } = lint(opts.positional);
      const code = exitFor(findings);
      print(row('LINT', { paths: opts.positional.join(','), records: records.length, enforces: 'PROTO-DEC-0061' }));
      for (const x of findings) print(row('FINDING', { code: x.code, path: `${x.path}:${x.line}`, value: x.value, reason: x.message }));
      // Found rules == rule lines over the scanned records unless a rule line is F10.
      const rules = records.reduce((a, r) => a + r.body.rules.length, 0);
      const ruleLines = rules + records.reduce((a, r) => a + r.body.unparsed.length, 0);
      print(row('RESULT', { exit: code, findings: findings.length, malformed: findings.filter(x => dicts().exit2.has(x.code)).length, rules, ruleLines }));
      console.log(out.join('\n'));
      return code;
    }
    if (command === 'artifact-lint' || command === 'artifacts') {
      // One root, resolved exactly as `lint` resolves it (the repository above the working
      // directory): the dictionaries, the PROPOSED marker and the files are read from one tree.
      const opts = parseOptions(rest, {});
      if (!opts.positional.length) throw new InputError('artifact-lint needs at least one path');
      const r = artifactLint(opts.positional, { root: REPO });
      print(row('ARTIFACT_LINT', { paths: opts.positional.join(','), files: r.files.length, records: r.records, advisory: 'true' }));
      for (const x of r.findings) print(row('FINDING', { code: x.code, class: x.cls, path: `${x.path}:${x.line}`, value: x.value, reason: x.message }));
      print(row('RESULT', { exit: r.exit, findings: r.findings.length, violations: r.counts.violations, malformed: r.counts.malformed, deferred: r.counts.deferred, warns: r.counts.warns }));
      console.log(out.join('\n'));
      return r.exit;
    }
    if (command === 'catalog') {
      const opts = parseOptions(rest, { root: 'value', check: 'flag' });
      if (opts.positional.length) throw new InputError(`unexpected argument ${opts.positional[0]}`);
      const root = opts.root || path.join(REPO, '.ai', 'core');
      if (!fs.existsSync(root)) throw new InputError(`no such root: ${root}`);
      const { text, f1, count } = catalogText(root);
      const target = catalogTarget(root);
      print(row('CATALOG', { root: rel(path.resolve(root)), records: count, target: rel(target), mode: opts.check ? 'check' : 'write' }));
      if (f1.length) {
        for (const x of f1) print(row('FINDING', { code: x.code, path: `${x.path}:${x.line}`, value: x.value, reason: x.message }));
        print(row('RESULT', { exit: 2, reason: 'a source fails F1' }));
        console.log(out.join('\n'));
        return 2;
      }
      const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
      if (opts.check) {
        const fresh = current === text;
        print(row('RESULT', { exit: fresh ? 0 : 1, state: fresh ? 'fresh' : (current === null ? 'missing' : 'stale') }));
        console.log(out.join('\n'));
        return fresh ? 0 : 1;
      }
      if (current !== text) { fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, text); }
      print(row('RESULT', { exit: 0, state: current === text ? 'fresh' : 'written' }));
      console.log(out.join('\n'));
      return 0;
    }
    if (command === 'check-links') {
      // --package <id> is the strict final gate, reconciled against the EXTERNAL-PENDING
      // registry both ways. It is never implicit: --design is refused with it, and a
      // reference outside the package passes only as an open registry row naming it.
      const opts = parseOptions(rest, { root: 'value', design: 'flag', strict: 'flag', package: 'value', pending: 'value' });
      if (opts.positional.length) throw new InputError(`unexpected argument ${opts.positional[0]}`);
      if (opts.pending && !opts.package) throw new InputError('--pending is the EXTERNAL-PENDING registry of the package gate; pass --package <id> with it');
      if (opts.design && opts.package) throw new InputError('--package is the strict final gate, never implicit; it is exclusive with --design');
      const root = opts.root || path.join(REPO, '.ai', 'core');
      if (!fs.existsSync(root)) throw new InputError(`no such root: ${root}`);
      const design = opts.package ? false : modeFor(root, opts);
      const registry = opts.package ? loadRegistry(registryPathFor(root, opts.pending)) : (design ? softRegistry(root) : null);
      const { rows, unparseable, records, pending } = checkLinks(root, design, { registry, reconcile: !design });
      const failing = rows.filter(x => x.token !== 'PENDING' && x.token !== 'REGISTERED');
      const code = unparseable.length ? 2 : (failing.length ? 1 : 0);
      print(row('CHECK_LINKS', { root: rel(path.resolve(root)), records: records.length, mode: opts.package ? `package:${opts.package}` : (design ? 'design' : 'strict') }));
      for (const x of unparseable) print(row('FINDING', { code: x.code, path: `${x.path}:${x.line}`, value: x.value, reason: x.message }));
      for (const x of rows) {
        if (x.token === 'REGISTRY_STALE') print(row('REGISTRY_STALE', { row: x.ref, referrer: x.path, status: x.status, reason: x.reason }));
        else print(row(x.token, { path: `${x.path}:${x.line}`, ref: x.ref, planned: x.planned, closing: x.closing, reason: x.reason }));
      }
      print(row('RESULT', {
        exit: code, pending, registered: rows.filter(x => x.token === 'REGISTERED').length,
        dangling: rows.filter(x => x.token === 'DANGLING').length, badLines: rows.filter(x => x.token === 'BAD_LINE').length,
        registryStale: rows.filter(x => x.token === 'REGISTRY_STALE').length,
      }));
      console.log(out.join('\n'));
      return code;
    }
    if (command === 'verify') {
      // One process for the validator and the gates. Modes: --design; --layer <N> (the
      // freeze gate: lcc <N> with planned references pending and the registry required);
      // --package <id> (the final gate: strict resolution reconciled against EXTERNAL-PENDING.md).
      // The final gate is never chosen implicitly: plain verify stays the design-era default and
      // never reconciles the registry. The output carries the zone, pending, counters, tree SHA.
      const opts = parseOptions(rest, { root: 'value', design: 'flag', layer: 'value', package: 'value', pending: 'value' });
      if (opts.positional.length) throw new InputError(`unexpected argument ${opts.positional[0]}`);
      if ([opts.design, opts.layer !== undefined, opts.package !== undefined].filter(Boolean).length > 1) {
        throw new InputError('--design, --layer and --package are exclusive; the gate mode is never chosen implicitly');
      }
      if (opts.pending && opts.layer === undefined && opts.package === undefined) {
        throw new InputError('--pending is the EXTERNAL-PENDING registry of the --layer and --package gates');
      }
      if (opts.layer !== undefined || opts.package !== undefined) throw new InputError('verify --layer and --package run the freeze and final gates of the kernel development (lcc and the EXTERNAL-PENDING registry); they are not part of the product');
      const root = opts.root || path.join(REPO, '.ai', 'core');
      if (!fs.existsSync(root)) throw new InputError(`no such root: ${root}`);
      const mode = opts.design ? 'design' : (opts.layer !== undefined ? 'layer' : (opts.package !== undefined ? 'package' : 'default'));
      const zone = mode === 'layer' ? opts.layer : (mode === 'package' ? opts.package : 'design');
      const lintResult = lint([root]);
      const tree = treeSha(manifestLines(lintResult.records));
      const records = lintResult.records.length;
      const results = [];
      let pending = 0;
      let findings = 0;
      const pushLint = () => {
        findings += lintResult.findings.length;
        results.push(['lint', exitFor(lintResult.findings), lintResult.findings.map(x => row('FINDING', { code: x.code, path: `${x.path}:${x.line}`, value: x.value, reason: x.message }))]);
      };
      const pushCatalog = () => {
        const cat = catalogText(root);
        const target = catalogTarget(root);
        const fresh = fs.existsSync(target) && fs.readFileSync(target, 'utf8') === cat.text;
        const rows = fresh ? [] : [row('STALE', { path: rel(target), reason: 'run: node .ai/bin/protocol-core.cjs catalog' })];
        findings += rows.length + cat.f1.length;
        results.push(['catalog', cat.f1.length ? 2 : (fresh ? 0 : 1), rows]);
      };
      const pushLinks = (design, registry, keepRegistered) => {
        const { rows, unparseable, pending: p } = checkLinks(root, design, { registry, reconcile: !design });
        const failing = rows.filter(x => x.token !== 'PENDING' && x.token !== 'REGISTERED');
        const code = unparseable.length ? 2 : (failing.length ? 1 : 0);
        findings += failing.length + unparseable.length;
        pending = p;
        const printed = [...unparseable.map(x => row('FINDING', { code: x.code, path: `${x.path}:${x.line}`, value: x.value, reason: x.message })),
          ...rows.filter(x => failing.includes(x) || (keepRegistered && x.token === 'REGISTERED'))
            .map(x => row(x.token, { path: `${x.path}:${x.line}`, ref: x.ref, reason: x.reason, closing: x.closing }))];
        results.push(['check-links', code, printed]);
      };
      pushLint();
      pushCatalog();
      if (mode === 'layer' || mode === 'package') {
        const registry = loadRegistry(registryPathFor(root, opts.pending));
        if (mode === 'layer') {
          const report = lccReport(opts.layer, root, true, { registry, freeze: true, pendingPath: opts.pending });
          findings += report.failed.length;
          pending = report.pending;
          results.push(['lcc', report.code, report.rows]);
        } else {
          pushLinks(false, registry, true);
        }
      } else if (mode === 'design' || fs.existsSync(path.join(REPO, 'docs', 'core-arch'))) {
        pushLinks(true, softRegistry(root), false);
      } else {
        results.push(['check-links', 0, [row('SKIPPED', { check: 'check-links', reason: 'no docs/core-arch design corpus in this checkout' })]]);
      }
      const code = Math.max(...results.map(r => r[1]));
      print(row('VERIFY', { root: rel(path.resolve(root)), mode, zone, records, pending, tree, enforces: 'PROTO-DEC-0061' }));
      for (const [name, exit, rows] of results) { rows.forEach(r => print(r)); print(row('CHECK', { name, exit })); }
      print(row('RESULT', { exit: code, zone, pending, findings, records, tree }));
      console.log(out.join('\n'));
      return code;
    }
    if (command === 'packet') {
      const opts = parseOptions(rest, { role: 'value', stage: 'value', root: 'value' });
      if (opts.positional.length) throw new InputError(`unexpected argument ${opts.positional[0]}`);
      if (!opts.role) throw new InputError('packet needs --role <slot>');
      if (!opts.stage) throw new InputError('packet needs --stage <stage>');
      const D = dicts();
      if (!D.roles.has(opts.role)) throw new InputError(`unknown role slot ${opts.role} (procedure.schema.md section 6)`);
      if (opts.role === 'all') throw new InputError('role all is the summary level, not a slot; name a slot (procedure.schema.md section 4)');
      if (!D.stages.has(opts.stage)) throw new InputError(`unknown stage ${opts.stage} (procedure.schema.md section 6)`);
      const root = opts.root || path.join(REPO, '.ai', 'core');
      if (!fs.existsSync(root)) throw new InputError(`no such root: ${root}`);
      const { records, errors } = loadRecords([root], { skipUnlisted: designRoot(root) });
      const packet = computePacket(records, opts.role, opts.stage);
      if (errors.length) {
        for (const x of errors) print(row('FINDING', { code: x.code, path: `${x.path}:${x.line}`, value: x.value, reason: x.message }));
        print(row('RESULT', { exit: 2, reason: 'a corpus file fails F1' }));
        console.log(out.join('\n'));
        return 2;
      }
      if (!packet.root) throw new InputError(`root P-L0-000 not found under ${rel(path.resolve(root))}; a packet loads the root (procedure.schema.md section 4)`);
      const state = packet.over ? 'over' : 'within';
      print(row('PACKET', { role: opts.role, stage: opts.stage, root: packet.root, records: packet.files.length, full: packet.full, summary: packet.summary, bytes: packet.bytes, budget: `${PACKET_BUDGET}B`, state }));
      for (const f of packet.files) print(row('FILE', { path: f.path, level: f.level, reason: f.reason, bytes: f.bytes }));
      if (packet.over) {
        for (const f of [...packet.files].sort((a, b) => b.bytes - a.bytes || cmp(a.path, b.path)).slice(0, 3)) print(row('OVER', { path: f.path, bytes: f.bytes }));
      }
      print(row('RESULT', { exit: packet.over ? 1 : 0, bytes: packet.bytes, records: packet.files.length, full: packet.full, summary: packet.summary, budget: `${PACKET_BUDGET}B`, state, provisional: 'true' }));
      console.log(out.join('\n'));
      return packet.over ? 1 : 0;
    }
    if (command === 'root-size') {
      const opts = parseOptions(rest, { root: 'value' });
      if (opts.positional.length) throw new InputError(`unexpected argument ${opts.positional[0]}`);
      const root = opts.root || path.join(REPO, '.ai', 'core');
      if (!fs.existsSync(root)) throw new InputError(`no such root: ${root}`);
      const size = checkRootSize(root);
      print(row('ROOT_SIZE', { root: size.path, bytes: size.bytes, chars: size.chars, goal: `${ROOT_GOAL}B`, warn: `${ROOT_WARN}B`, limit: `${ROOT_LIMIT}B`, state: size.state }));
      print(row('RESULT', { exit: size.code, bytes: size.bytes, chars: size.chars, state: size.state }));
      console.log(out.join('\n'));
      return size.code;
    }
    // the product ships no layer-consistency gate: lcc is the layer-consistency gate of the kernel DEVELOPMENT (records planned for later stages, the development decision journal); it is not part of the product: a host project uses the kernel layers and does not change them
    if (command === 'lcc') throw new InputError('lcc is the layer-consistency gate of the kernel DEVELOPMENT (records planned for later stages, the development decision journal); it is not part of the product: a host project uses the kernel layers and does not change them');
    if (command === 'lcc') {
      // --layer is the freeze gate of the both-ways rule - planned references stay pending, a dangling
      // reference passes only as an open EXTERNAL-PENDING row, and the registry is required.
      const opts = parseOptions(rest, { root: 'value', design: 'flag', strict: 'flag', layer: 'flag', pending: 'value' });
      if (opts.positional.length !== 1) throw new InputError('lcc needs exactly one layer, for example L0');
      if (opts.layer && (opts.design || opts.strict)) throw new InputError('--layer is the freeze gate and is exclusive with --design and --strict');
      if (opts.pending && !opts.layer) throw new InputError('--pending is the EXTERNAL-PENDING registry of the freeze gate; pass --layer with it');
      const layer = opts.positional[0];
      const root = opts.root || path.join(REPO, '.ai', 'core');
      if (!fs.existsSync(root)) throw new InputError(`no such root: ${root}`);
      const design = opts.layer ? true : modeFor(root, opts);
      const registry = opts.layer ? loadRegistry(registryPathFor(root, opts.pending)) : (design ? softRegistry(root) : null);
      const { code, rows, failed } = lccReport(layer, root, design, { registry, freeze: opts.layer, pendingPath: opts.pending });
      rows.forEach(r => print(r));
      print(row('RESULT', { exit: code, failed: failed.join(',') || 'none' }));
      console.log(out.join('\n'));
      return code;
    }
    throw new InputError(`unknown command ${command}`);
  } catch (error) {
    if (error instanceof InputError) {
      console.log([...out, row('ERROR', { reason: error.message })].join('\n'));
      return 2;
    }
    console.log([...out, row('ERROR', { reason: `internal: ${error.message}` })].join('\n'));
    return 2;
  }
}

module.exports = { parseRecord, parseRuleId, parseEvidenceItem, lint, catalogText, checkLinks, lcc, deliveredProfiles, LCC8_DELIVERED_BUDGET, checkRootSize, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));

'use strict';
// Artifact lint of the L5 artifact families. Rules:
// R-LS-*, R-IN-*, R-EC-* and B-L*;
// the field contracts are `.ai/core/schema/artifact.schema.md` (SCHEMA-artifact).
//
// This module is the structural half of the artifact check: family identification by external
// artifact home and the grammar of the identifiers present (B-L26), the closed field sets, and
// the proposed per-family error classes (R-EC-3). It borrows the canonical dictionaries of
// procedure.schema.md (R-LS-5: no copy travels with the tool) and keeps no literal copy of the
// registry. It is advisory (R-LS-2): a pass certifies nothing and closes no Class A gate.
const fs = require('node:fs');
const path = require('node:path');
const { InputError, dicts, REPO, rel, cmp } = require('./records.cjs');

const WORD_FIELDS = ['word-id', 'date-utc', 'owner', 'provenance', 'binding', 'scope', 'excluded', 'addendum-ref', 'links'];
const CARD_FIELDS = ['card-id', 'date-utc', 'question', 'options', 'default', 'anchor', 'links', 'status'];
const CARD_REQUIRED = ['card-id', 'date-utc', 'question', 'options', 'default', 'links', 'status'];
const BRIEF_REQUIRED = ['tree', 'registry-open', 'launches', 'tasks', 'freshness', 'unknowns'];
const REG_HEADER = ['label', 'artifact', 'home', 'id', 'writer', 'reader', 'schema', 'source'];
// The keys only one family carries. A record without a family identifier is still judged on what
// is wrong whichever family it is (unknown keys, the date, the values of a family-only key).
const WORD_ONLY = WORD_FIELDS.filter(k => !CARD_FIELDS.includes(k));
const CARD_ONLY = CARD_FIELDS.filter(k => !WORD_FIELDS.includes(k));
const OW_ID = /^OW-\d{8}-\d{2}$/;
const OC_ID = /^OC-\d{8}-\d{2}$/;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

// The one binding grammar (OW section 2.1; artifact.schema.md "Wire forms"), read by the lint
// (B-L13/B-L15) and by the rule-20 validator (.ai/bin/validator/owner-words.cjs):
//   standing                                   a standing word; Git movement never voids it (R-BK-2)
//   candidate@<branch>@<40-hex sha>            the exact authorization target (rule 20)
//   candidate@<branch>@<sha>; void-on:<clause> the word's own void clause: registry-row or new-commit
//   plan@<64-hex sha256>@<40-hex commit>       the frozen artifact and its publication commit
// `errors` are grammar defects of the kind named (B-L13, malformed); `warns` are the artificial
// anchor of a standing word (B-L15). A plan anchor outside its form is reported in `planMalformed`:
// the validator reads it as is (B-L16 form) and the lint reports it as B-L13, malformed, exit 2
// (B-L13: an anchor that is not of the form of its kind).
const BINDING_KINDS = ['standing', 'candidate', 'plan'];
const VOID_CLAUSES = ['registry-row', 'new-commit'];
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SHA40 = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function parseBinding(value) {
  const out = { value: String(value), kind: null, branch: null, sha: null, sha256: null, voidOn: null, planMalformed: null, errors: [], warns: [] };
  const parts = out.value.split(';').map(s => s.trim());
  const segs = parts[0].split('@');
  out.kind = segs[0];
  if (!BINDING_KINDS.includes(out.kind)) { out.errors.push('binding.kind outside {standing, candidate, plan}'); return out; }
  for (const clause of parts.slice(1)) {
    const m = clause.match(/^void-on:([a-z-]+)$/);
    if (!m || !VOID_CLAUSES.includes(m[1])) out.errors.push(`unknown binding clause "${clause}" (void-on:registry-row or void-on:new-commit)`);
    else if (out.voidOn) out.errors.push('a second void-on clause');
    else if (out.kind !== 'candidate') out.errors.push(`a void-on clause on a ${out.kind} word (only a candidate word is voided by Git movement, OW section 2.1)`);
    else out.voidOn = m[1];
  }
  if (out.kind === 'candidate') {
    if (segs.length !== 3 || !BRANCH_NAME.test(segs[1]) || segs[1].includes('..')) {
      out.errors.push('a candidate word needs a full <branch>@<40-hex> anchor');
    } else {
      out.branch = segs[1];
      if (SHA40.test(segs[2])) out.sha = segs[2];
      else if (/^[0-9a-fA-F]{4,39}$/.test(segs[2])) out.errors.push(`short sha (${segs[2].length} of 40 hex): a short anchor authorizes nothing (OWNER-WORDS-JOURNAL R-OWJ-7)`);
      else out.errors.push('malformed sha: the anchor needs 40 lowercase hex digits copied from the registry');
    }
  } else if (out.kind === 'standing') {
    if (segs.length > 1) out.warns.push('an artificial candidate anchor on a standing word');
  } else if (segs.length === 3 && SHA256.test(segs[1]) && SHA40.test(segs[2])) {
    out.sha256 = segs[1];
    out.sha = segs[2];
  } else {
    out.planMalformed = 'a plan word needs <sha256>@<commit> (64-hex artifact digest, 40-hex publication commit; OW section 2.1, B-L16)';
  }
  return out;
}

function isRepoPath(value) {
  return /^[A-Za-z0-9._\-/]+$/.test(value) && !value.startsWith('/') && !value.split('/').includes('..') && /[/.]/.test(value);
}
function baseName(relPath) { return relPath.split('/').pop(); }

// The PROPOSED ids are registry metadata, not a dict line (section 2.1 carries the marker). Read
// from the same canonical location as the dictionaries (R-LS-5), under the root the lint runs on.
function proposedIds(repoRoot) {
  const file = path.join(repoRoot, '.ai', 'core', 'schema', 'procedure.schema.md');
  if (!fs.existsSync(file)) return new Set();
  const m = fs.readFileSync(file, 'utf8').match(/^PROPOSED[^\n]*: ([^\n.]*)\.?$/m);
  if (!m) return new Set();
  return new Set(m[1].split(',').map(s => s.trim()).filter(Boolean));
}

// A file named on the command line is read as given. A directory walk takes only the document
// forms the families live in (markdown homes and JSONL channels), never a script or a binary,
// and never descends into `.git` or the disposable `.ai/runtime` (R-IN-L2, AGENTS section 1).
function listFiles(target, repoRoot) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) throw new InputError(`no such path: ${target}`);
  if (fs.statSync(abs).isFile()) return [abs];
  const runtime = path.join(repoRoot, '.ai', 'runtime');
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => cmp(a.name, b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== '.git' && p !== runtime) walk(p); continue; }
      if (/\.(md|jsonl)$/.test(e.name)) out.push(p);
    }
  })(abs);
  return out;
}

const WIRE_INFOS = ['registry', 'record', 'brief'];

// Fenced blocks of a markdown file. A fence still open at the end of the file is returned as
// `unclosed` (its info string and the 1-based line of the opening fence): a wire block without
// its closing fence is an unreadable form, a parse failure (R-LS-4), never a silently dropped
// block or a guessed boundary.
function fences(lines) {
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const start = line.match(/^```([A-Za-z0-9-]*)\s*$/);
    if (open === null && start) { open = { info: start[1], start: i, content: [] }; continue; }
    if (open !== null && /^```\s*$/.test(line)) { blocks.push({ info: open.info, line: open.start + 2, content: open.content }); open = null; continue; }
    if (open !== null) open.content.push({ text: line, line: i + 1 });
  }
  return { blocks, unclosed: open === null ? null : { info: open.info, line: open.start + 1 } };
}

// B-L07/B-L08 report: one finding per duplicated id, never one per row. The message carries the
// count of distinct homes (or writers) and at most EXAMPLES of them, then "(+N more)".
const EXAMPLES = 10;
function examples(values) {
  const sorted = [...values].sort(cmp);
  const shown = sorted.slice(0, EXAMPLES).join(', ');
  return sorted.length > EXAMPLES ? `${shown} (+${sorted.length - EXAMPLES} more)` : shown;
}

function fieldMap(content) {
  const fields = new Map();
  const unknown = [];
  for (const { text, line } of content) {
    if (text.trim() === '') continue;
    const m = text.match(/^([a-z][a-z0-9-]*): (.*)$/);
    if (!m) { unknown.push({ key: text.slice(0, 24), line }); continue; }
    fields.set(m[1], { value: m[2], line });
  }
  return { fields, unknown };
}

// ---- per-family checks -----------------------------------------------------

// The header row of a registry block is the eight field names of AH section 1 in order, nothing
// else: a data row whose first cell merely reads `label` is not it. Case and spacing
// around the cells are not significant; the cell count and the names are.
function isRegistryHeader(cells) {
  return cells.length === REG_HEADER.length && cells.every((c, i) => c.toLowerCase() === REG_HEADER[i]);
}
function isSeparatorRow(cells) {
  return cells.length === REG_HEADER.length && cells.every(c => /^:?-{2,}:?$/.test(c));
}

function checkRegistryRow(cells, line, ctx, rows) {
  const f = ctx.findings;
  const push = (code, cls, value, message) => f.push({ code, cls, path: ctx.rel, line, value, message });
  if (cells.length < REG_HEADER.length) { push('B-L01', 'violation', `cells=${cells.length}`, 'registry row misses one of the seven required fields (AH section 1)'); return null; }
  if (cells.length > REG_HEADER.length) { push('B-L01', 'malformed', `cells=${cells.length}`, 'registry row carries an extra/unknown field'); return null; }
  for (let i = 1; i < REG_HEADER.length; i++) if (!cells[i]) push('B-L01', 'violation', REG_HEADER[i], `registry field ${REG_HEADER[i]} is empty`);
  const label = cells[0];
  const artifact = cells[1];
  const home = cells[2];
  const id = cells[3];
  const writer = cells[4];
  const row = { label, artifact, home, id, writer, line, file: ctx.rel };
  if (label !== 'current' && label !== 'proposed') push('B-L03', 'malformed', label, 'current/proposed label outside its enumeration');
  else if (label === 'current' && ctx.proposed.has(id)) push('B-L03', 'violation', id, 'a PROPOSED id presented as current (R-AH-4)');
  // An empty id is the missing-required case already reported above (B-L01, exit 1); only a
  // present id is judged against the registry and the path grammar (B-L02).
  if (id && !isRepoPath(id) && !ctx.registered.has(id)) push('B-L02', 'malformed', id, 'an unissued id used as issued');
  if (id === 'brief' && fs.existsSync(path.join(ctx.root, 'docs', 'ops', 'state-brief.cjs'))) {
    push('B-L17', 'violation', id, 'the PROPOSED id brief collides with the live helper docs/ops/state-brief.cjs');
  }
  rows.push(row);
  return row;
}

// Value checks that belong to one family: the owner-words binding and addendum-ref, the owner-card
// status, options and default. They run for an identified record and, by the keys present, for a
// record that carries no family identifier (R-EC-2: the first finding never suppresses the rest).
function wordValueChecks(fields, ctx, push) {
  const binding = fields.get('binding');
  if (binding) {
    const parsed = parseBinding(binding.value);
    for (const error of parsed.errors) push('B-L13', 'malformed', binding.value, error);
    if (parsed.planMalformed) push('B-L13', 'malformed', binding.value, parsed.planMalformed);
    for (const warning of parsed.warns) push('B-L15', 'warn', binding.value, warning);
  }
  // B-L12: the journal entry is derived (OW R-OW-2); its addendum-ref must resolve to a tracked
  // file, as `path` or `path:line`. A value that is not a repo path, or a path that does not
  // exist, leaves the word non-canonical.
  const addendum = fields.get('addendum-ref');
  if (addendum) {
    const target = addendum.value.replace(/:\d+(-\d+)?$/, '');
    if (!isRepoPath(target) || !fs.existsSync(path.join(ctx.root, target))) {
      push('B-L12', 'violation', addendum.value, 'unresolvable addendum-ref: the word is not canonical until it points at the Addendum');
    }
  }
}

function cardValueChecks(fields, push) {
  const status = fields.get('status');
  if (status && !(status.value === 'open' || status.value === 'answered' || /^superseded-by:OC-\d{8}-\d{2}$/.test(status.value))) {
    push('B-L25', 'malformed', status.value, 'status outside {open, answered, superseded-by:<id>}');
  }
  const options = fields.get('options');
  let optionNumbers = [];
  if (options) {
    optionNumbers = options.value.split(';').map(s => s.trim()).map(s => (s.match(/^(\d+):\s*\S/) || [null, null])[1]).filter(Boolean).map(Number);
    if (optionNumbers.length < 2 || optionNumbers.length > 5) push('B-L25', 'malformed', options.value, 'options must be 2-5 numbered choices');
  }
  const def = fields.get('default');
  if (def && def.value !== 'none' && optionNumbers.length && !optionNumbers.includes(Number(def.value))) {
    push('B-L25', 'malformed', def.value, 'default is neither one of the options nor none');
  }
}

function checkWord(fields, unknown, line, ctx) {
  const f = ctx.findings;
  const push = (code, cls, value, message) => f.push({ code, cls, path: ctx.rel, line, value, message });
  for (const key of WORD_FIELDS) if (!fields.has(key)) {
    if (key === 'word-id') push('B-L26', 'violation', key, 'missing family identification word-id');
    else push('B-L04', 'violation', key, `missing required owner-words field ${key} (OW section 2)`);
  }
  for (const u of unknown) push('B-L24', 'malformed', u.key, 'unknown/extra field outside the closed owner-words set (9 fields)');
  for (const key of fields.keys()) if (!WORD_FIELDS.includes(key)) push('B-L24', 'malformed', key, 'unknown/extra field outside the closed owner-words set (9 fields)');
  const wordId = fields.get('word-id');
  if (wordId && !OW_ID.test(wordId.value)) push('B-L05', 'malformed', wordId.value, 'word-id must be OW-YYYYMMDD-NN');
  const date = fields.get('date-utc');
  if (date && !UTC.test(date.value)) push('B-L05', 'malformed', date.value, 'date-utc must be ISO-8601 UTC');
  wordValueChecks(fields, ctx, push);
}

function checkCard(fields, unknown, line, ctx) {
  const f = ctx.findings;
  const push = (code, cls, value, message) => f.push({ code, cls, path: ctx.rel, line, value, message });
  for (const key of CARD_REQUIRED) if (!fields.has(key)) {
    if (key === 'card-id') push('B-L26', 'violation', key, 'missing family identification card-id');
    else push('B-L25', 'violation', key, `missing required owner-card field ${key} (OW section 1)`);
  }
  for (const u of unknown) push('B-L24', 'malformed', u.key, 'unknown/extra field outside the closed owner-card set');
  for (const key of fields.keys()) if (!CARD_FIELDS.includes(key)) push('B-L24', 'malformed', key, 'unknown/extra field outside the closed owner-card set');
  const cardId = fields.get('card-id');
  if (cardId && !OC_ID.test(cardId.value)) push('B-L05', 'malformed', cardId.value, 'card-id must be OC-YYYYMMDD-NN');
  const date = fields.get('date-utc');
  if (date && !UTC.test(date.value)) push('B-L05', 'malformed', date.value, 'date-utc must be ISO-8601 UTC');
  cardValueChecks(fields, push);
}

// A record block whose family is not fixed by one identifier: no word-id and no card-id (B-L26,
// missing identification, exit 1), or both (B-L26, malformed, exit 2). The family-bound checks
// (required fields) cannot run, but everything that is wrong whichever family it is still is
// reported, so the worst class is never hidden behind the identification finding (R-EC-2): a line
// that is not `key: value`, a key outside both closed sets (B-L24), a malformed date (B-L05), and
// the values of a key only one family carries (B-L13/B-L15/B-L12 for the word keys, B-L25 for the
// card keys).
function checkUnidentified(fields, unknown, line, ctx) {
  const f = ctx.findings;
  const push = (code, cls, value, message) => f.push({ code, cls, path: ctx.rel, line, value, message });
  for (const u of unknown) push('B-L24', 'malformed', u.key, 'a line that is not `key: value` in a record without a single family identifier');
  for (const key of fields.keys()) if (!WORD_FIELDS.includes(key) && !CARD_FIELDS.includes(key)) push('B-L24', 'malformed', key, 'unknown/extra field outside the closed owner-words and owner-card sets');
  const date = fields.get('date-utc');
  if (date && !UTC.test(date.value)) push('B-L05', 'malformed', date.value, 'date-utc must be ISO-8601 UTC');
  if (WORD_ONLY.some(k => fields.has(k))) wordValueChecks(fields, ctx, push);
  if (CARD_ONLY.some(k => fields.has(k))) cardValueChecks(fields, push);
}

function checkBrief(content, line, ctx) {
  const f = ctx.findings;
  const push = (code, cls, value, message) => f.push({ code, cls, path: ctx.rel, line, value, message });
  const nonEmpty = content.filter(c => c.text.trim() !== '');
  if (!nonEmpty.length) { push('B-L06', 'malformed', 'empty', 'a brief block without the state-header envelope'); return; }
  const env = nonEmpty[0].text.match(/^== state-brief (.+) ==$/);
  if (!env) { push('B-L06', 'malformed', nonEmpty[0].text.slice(0, 40), 'brief parse failure: the state-header envelope line is missing or malformed'); return; }
  if (!UTC.test(env[1])) push('B-L06', 'malformed', env[1], 'the state-header UTC is malformed');
  const { fields, unknown } = fieldMap(nonEmpty.slice(1));
  for (const key of BRIEF_REQUIRED) if (!fields.has(key)) push('R-EC-1', 'deferred', key, 'missing required brief payload field (exact code deferred)');
  for (const u of unknown) push('B-L24', 'malformed', u.key, 'unknown/extra key in the brief payload');
  for (const [key, v] of fields) {
    if (!BRIEF_REQUIRED.includes(key)) push('B-L24', 'malformed', key, 'unknown/extra key in the brief payload');
    if (/Date\.now/.test(v.value)) push('B-L18', 'violation', key, 'live time inside the payload (time is only an injected input, R-IN-5)');
  }
}

// F-RUN / F-LAUNCH: only the channel discipline (B-L09). The records themselves belong to their
// own schemas (R-LS-6); an unparsable line is theirs to reject, not this lint's.
function checkChannel(text, ctx) {
  const f = ctx.findings;
  const push = (code, cls, line, value, message) => f.push({ code, cls, path: ctx.rel, line, value, message });
  const name = baseName(ctx.rel);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const rec = lines[i].trim();
    if (!rec) continue;
    let obj;
    try { obj = JSON.parse(rec); } catch { continue; }
    const schema = obj && obj.schema;
    if (name === 'RUNS.jsonl' && schema === 'launch-record/1') push('B-L09', 'violation', i + 1, 'launch-record/1', 'a launch record inside the RUNS channel; the channels never mix');
    if (name === 'LAUNCHES.jsonl' && schema === 'run-record/1') push('B-L09', 'violation', i + 1, 'run-record/1', 'a run record inside the LAUNCHES channel; the channels never mix');
  }
}

// ---- driver ----------------------------------------------------------------

function artifactLint(targets, options = {}) {
  const repoRoot = path.resolve(options.root || REPO);
  const D = dicts(); // R-LS-4/R-LS-5: a missing/malformed dictionaries block is a named exit 2
  const registered = D.artifacts;
  const proposed = proposedIds(repoRoot);
  const findings = [];
  const rows = [];
  const files = [];
  let records = 0;

  for (const target of targets) {
    const abs = path.resolve(repoRoot, target);
    const relPath = path.relative(repoRoot, abs).split(path.sep).join('/');
    if (relPath === '.ai/runtime' || relPath.startsWith('.ai/runtime/')) {
      // R-IN-L2: the disposable runtime is never an input and never an authority of the lint.
      findings.push({ code: 'R-IN-L2', cls: 'malformed', path: relPath, line: 1, value: relPath, message: '.ai/runtime is disposable session state, never an input of the lint (AGENTS section 1)' });
      continue;
    }
    for (const file of listFiles(abs, repoRoot)) {
      files.push(file);
      const relFile = rel(file);
      const buf = fs.readFileSync(file);
      const ctx = { root: repoRoot, rel: relFile, registered, proposed, findings };
      if (buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF) {
        findings.push({ code: 'R-LS-7', cls: 'malformed', path: relFile, line: 1, value: 'BOM', message: 'UTF-8 without BOM is the authority (AGENTS section 11)' });
      }
      let text = buf.toString('utf8').replace(/^\uFEFF/, '');
      if (/\r\n/.test(text)) {
        findings.push({ code: 'R-LS-7', cls: 'malformed', path: relFile, line: 1, value: 'CRLF', message: 'LF is the authority (AGENTS section 11)' });
        text = text.replace(/\r\n/g, '\n');
      }
      if (/\.jsonl$/.test(relFile)) { checkChannel(text, ctx); continue; }
      const { blocks, unclosed } = fences(text.split('\n'));
      if (unclosed && WIRE_INFOS.includes(unclosed.info)) {
        findings.push({ code: 'R-LS-4', cls: 'malformed', path: relFile, line: unclosed.line, value: unclosed.info, message: `unclosed fenced ${unclosed.info} block: the wire form cannot be parsed (fail-closed, R-LS-4)` });
      }
      for (const block of blocks) {
        if (block.info === 'registry') {
          // Only two rows are not data: the header, and only as the first row of the block, and the
          // markdown separator, and only right after that header. Anywhere else a row that looks
          // like either is a data row and is judged as one (B-L01/B-L03), never silently skipped.
          let rowNo = 0;
          let afterHeader = false;
          for (const item of block.content) {
            const rowText = item.text;
            if (rowText.trim() === '' || !rowText.includes('|')) continue;
            const cells = rowText.split('|').map(s => s.trim());
            if (cells[0] === '') cells.shift();
            if (cells[cells.length - 1] === '') cells.pop();
            const at = rowNo++;
            if (at === 0 && isRegistryHeader(cells)) { afterHeader = true; continue; }
            if (at === 1 && afterHeader && isSeparatorRow(cells)) continue;
            records++;
            checkRegistryRow(cells, item.line, ctx, rows);
          }
        } else if (block.info === 'record') {
          const { fields, unknown } = fieldMap(block.content);
          if (fields.has('word-id') && fields.has('card-id')) {
            findings.push({ code: 'B-L26', cls: 'malformed', path: relFile, line: block.line, value: 'word-id,card-id', message: 'two family identifiers in one record' });
            checkUnidentified(fields, unknown, block.line, ctx);
            continue;
          }
          records++;
          if (fields.has('word-id')) checkWord(fields, unknown, block.line, ctx);
          else if (fields.has('card-id')) checkCard(fields, unknown, block.line, ctx);
          else {
            findings.push({ code: 'B-L26', cls: 'violation', path: relFile, line: block.line, value: 'none', message: 'a record block without a family identifier (word-id or card-id)' });
            checkUnidentified(fields, unknown, block.line, ctx);
          }
        } else if (block.info === 'brief') {
          records++;
          checkBrief(block.content, block.line, ctx);
        }
      }
    }
  }

  // B-L07/B-L08: one home and one writer per instance across every registry row read. The
  // report is bounded and linear in the input: at most one B-L07 and one B-L08 finding per
  // distinct id (anchored at the id's first row), each naming the count and at most EXAMPLES
  // distinct values. The example values of all findings together are a subset of the home and
  // writer cells read, so the whole report never exceeds a constant per finding plus the input.
  // A row whose id is empty is already B-L01 (missing required) and joins no group.
  const byId = new Map();
  for (const row of rows) {
    if (!row.id) continue;
    if (!byId.has(row.id)) byId.set(row.id, { first: row, homes: new Set(), writers: new Set() });
    const g = byId.get(row.id);
    g.homes.add(row.home);
    g.writers.add(row.writer);
  }
  for (const [id, g] of byId) {
    const at = { path: g.first.file, line: g.first.line, value: id };
    if (g.homes.size > 1) findings.push({ code: 'B-L07', cls: 'violation', ...at, message: `one artifact, ${g.homes.size} homes: ${examples(g.homes)}` });
    if (g.writers.size > 1) findings.push({ code: 'B-L08', cls: 'violation', ...at, message: `one instance, ${g.writers.size} writers: ${examples(g.writers)}` });
  }

  findings.sort((a, b) => cmp(a.path, b.path) || a.line - b.line || cmp(a.code, b.code) || cmp(String(a.value), String(b.value)));
  const counts = { violations: 0, malformed: 0, deferred: 0, warns: 0 };
  for (const x of findings) {
    if (x.cls === 'violation') counts.violations++;
    else if (x.cls === 'malformed') counts.malformed++;
    else if (x.cls === 'deferred') counts.deferred++;
    else if (x.cls === 'warn') counts.warns++;
  }
  const exit = counts.malformed ? 2 : ((counts.violations || counts.deferred) ? 1 : 0);
  return { findings, files, records, counts, exit };
}

module.exports = { artifactLint, parseBinding, fences, fieldMap, WORD_FIELDS, CARD_FIELDS, BRIEF_REQUIRED, REG_HEADER };

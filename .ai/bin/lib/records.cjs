'use strict';
// Shared kernel record library (PROTO-DEC-0162 item 2, PROTO-DEC-0165 item 3c, FINAL plan answer 1D): the record
// parser, the corpus loader, the dictionaries reader and the tree digest. protocol-core.cjs and
// protocol-packet.cjs import it, so the repository has exactly one record parser. The code below is a pure
// move out of protocol-core.cjs: no logic edit.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

class InputError extends Error {}

const SCALAR_KEYS = new Set(['id', 'version', 'title', 'layer', 'type', 'status', 'enforcement', 'script_candidate',
  'cost_basis', 'trial', 'superseded_by', 'owner_approval', 'last_applied']);
const LIST_KEYS = new Set(['roles', 'stages', 'triggers', 'inputs', 'outputs', 'tools', 'back_edges', 'enforced_by',
  'evidence_class', 'evidence', 'decision', 'supersedes']);

// The allowlist of work products ( WP-1.6): a file without front matter is
// skipped only under these names or inside a trial/ directory. EXTERNAL-PENDING.md is
// tool-maintained registry data read by its own parser, never a record. Anything else without
// front matter is F1.
const WORK_PRODUCTS = [/^RULE-MAP\.md$/, /^TRIAL-NOTES\.md$/, /^SPEC-.*\.md$/, /^CATALOG\.md$/,
  /^LANDED\.md$/, /^STATUS\.md$/, /^WORK-CYCLE\.md$/, /^S1-SUMMARY\.md$/];
const REGISTRY_NAME = 'EXTERNAL-PENDING.md';

const RULE_ID = /^(?:- )?(R-L[0-9]-(?:\d{2,3}|S\d{3}|[a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:\.\d+)*)\. \s*\S/;
const RULE_LINE = /^(?:- )?R-L/;

const DECISION_ID = /^(?:PROTO-)?DEC-\d{4}$/;

function repoRootFrom(start) {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, 'protocol-manifest.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new InputError('repository root not found (no protocol-manifest.json above the working directory)');
    dir = parent;
  }
}
const REPO = (() => { try { return repoRootFrom(process.cwd()); } catch { return process.cwd(); } })();
const rel = p => path.relative(REPO, p).split(path.sep).join('/');
// Ordinal comparison: the same tree gives the same bytes on every machine and locale.
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------- dictionaries (procedure.schema.md section 6; WP-1.3, F-02) ----------

// The canon carries every enumeration and registry this tool enforces; the code keeps no literal
// copy. WP-1.8 (Р12, H-03): the schema is read only from its canonical location under the scanned
// root; no copy travels with the tool. A missing file, a missing block, a missing dictionary or
// a malformed line is a named exit 2, never a guessed default.
const DICT_KEYS = ['types', 'statuses', 'enforcement', 'evidence_class', 'artifacts', 'stages', 'roles', 'exit2'];
// Optional dictionaries (PROTO-DEC-0165): loaded when present, never required. `triggers` is the registry of
// trigger tokens (section 6); its items may also contain ":" (signal:fall, stage-enter:accept, verdict:FAIL).
const OPTIONAL_DICT_KEYS = ['triggers'];
const DICT_ITEM = /^[A-Za-z0-9_~-]+$/;
const DICT_ITEM_COLON = /^[A-Za-z0-9_~:-]+$/;

// `base` defaults to the repository of the working directory; the packet compiler passes the root it compiles (S6-T03), so the
// dictionaries come from the scanned root and never from wherever the process happens to run.
function loadDictionaries(base = REPO) {
  const file = path.join(base, '.ai', 'core', 'schema', 'procedure.schema.md');
  if (!fs.existsSync(file)) throw new InputError(`dictionaries unavailable: ${rel(file)} not found (procedure.schema.md section 6)`);
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  const start = lines.findIndex(l => l.replace(/\r$/, '') === '```dict');
  if (start < 0) throw new InputError(`dictionaries block missing from ${rel(file)} (procedure.schema.md section 6)`);
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) if (/^(```|~~~)/.test(lines[i].replace(/\r$/, ''))) { end = i; break; }
  if (end < 0) throw new InputError(`dictionaries block of ${rel(file)} is not closed`);
  const out = {};
  for (let i = start + 1; i < end; i++) {
    const raw = lines[i].replace(/\r$/, '');
    if (raw.trim() === '') continue;
    const m = raw.match(/^([a-z][a-z0-9_]*): (.*)$/);
    if (!m) throw new InputError(`malformed dictionaries line ${i + 1} of ${rel(file)}: "${raw.slice(0, 60)}"`);
    const [, name, value] = m;
    if (!DICT_KEYS.includes(name) && !OPTIONAL_DICT_KEYS.includes(name)) throw new InputError(`unknown dictionary "${name}" at ${rel(file)}:${i + 1}`);
    if (Object.hasOwn(out, name)) throw new InputError(`duplicate dictionary "${name}" at ${rel(file)}:${i + 1}`);
    const items = value.split(', ');
    const itemForm = name === 'triggers' ? DICT_ITEM_COLON : DICT_ITEM;
    if (items.some(item => !itemForm.test(item))) throw new InputError(`malformed item in dictionary "${name}" at ${rel(file)}:${i + 1}`);
    if (new Set(items).size !== items.length) throw new InputError(`duplicate item in dictionary "${name}" at ${rel(file)}:${i + 1}`);
    out[name] = new Set(items);
  }
  for (const name of DICT_KEYS) if (!Object.hasOwn(out, name)) throw new InputError(`dictionary "${name}" missing from the dictionaries block of ${rel(file)}`);
  return out;
}

let DICTS = null;
function dicts() {
  if (!DICTS) DICTS = loadDictionaries();
  return DICTS;
}

// ---------- parsing ----------

// Returns { fm, fmLines: {key: line}, body, bodyStart, findings } or { fm: null } when no front matter.
function parseRecord(file, suppliedText) {
  // A guarded reader may supply its verified snapshot; legacy callers still read by name.
  const text = suppliedText === undefined ? fs.readFileSync(file, 'utf8') : suppliedText;
  if (typeof text !== 'string') throw new TypeError('parseRecord: text must be a string');
  const findings = [];
  const add = (code, line, value, message) => findings.push({ code, path: rel(file), line, value, message });
  if (!text.startsWith('---\n') && !text.startsWith('---\r\n')) return { fm: null, text, findings };
  const lines = text.split('\n');
  const close = lines.findIndex((l, i) => i > 0 && l.replace(/\r$/, '') === '---');
  if (close < 0) { add('F1', 1, '---', 'front matter is not closed'); return { fm: {}, fmLines: {}, text, lines, bodyStart: lines.length, findings }; }
  const fm = {};
  const fmLines = {};
  for (let i = 1; i < close; i++) {
    const raw = lines[i];
    const n = i + 1;
    if (raw.includes('\r')) { add('F1', n, raw.trim(), 'CR in front matter; use LF'); continue; }
    const m = raw.match(/^([a-z][a-z0-9_]*): (.*)$/);
    if (!m) { add('F1', n, raw, 'not a "key: value" line of the grammar (nesting, comment or malformed key)'); continue; }
    const [, key, value] = m;
    if (Object.hasOwn(fm, key)) { add('F1', n, key, 'duplicate key'); continue; }
    if (!SCALAR_KEYS.has(key) && !LIST_KEYS.has(key)) { add('F1', n, key, 'unknown key'); continue; }
    if (value.trim() === '' || value !== value.trim()) { add('F1', n, value, 'empty value or surrounding spaces'); continue; }
    let parsed;
    if (value.startsWith('[')) {
      if (!value.endsWith(']')) { add('F1', n, value, 'list not closed'); continue; }
      const inner = value.slice(1, -1);
      parsed = inner === '' ? [] : inner.split(', ');
      if (parsed.some(item => item === '' || /[,[\]]/.test(item) || item !== item.trim())) {
        add('F1', n, value, 'list items must be separated by ", " and contain no "," "[" "]"'); continue;
      }
    } else {
      if (value.includes('#')) { add('F1', n, value, 'comment marker "#" in a scalar'); continue; }
      parsed = value;
    }
    if (LIST_KEYS.has(key) && !Array.isArray(parsed)) { add('F6', n, value, `list expected for ${key}, scalar given`); continue; }
    if (SCALAR_KEYS.has(key) && Array.isArray(parsed)) { add('F6', n, value, `scalar expected for ${key}, list given`); continue; }
    fm[key] = parsed;
    fmLines[key] = n;
  }
  return { fm, fmLines, text, lines, bodyStart: close + 1, findings };
}

// THE one definition of "text" (K5, procedure.schema.md section 3; Sol F3.1 certification rounds 4 and 6): what a reader actually sees. Every Default_Ignorable_Code_Point character (zero-width
// marks, the Hangul and Khmer fillers, variation selectors, tags - several of them satisfy \p{L}) renders as nothing and is dropped. HTML comments, empty
// code spans, numeric entities that decode to nothing visible and a pair of empty quotes are not content either. Stripping is context-aware: the content
// of a NON-EMPTY code span is literal visible text (a comment or an entity written inside backticks counts), and with { literal: true } (frame paths
// and globs) an entity is the literal name, not markup.
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;
const ENTITY = /&(#[xX][0-9a-fA-F]+|#[0-9]+|\w+);/y;
function textOf(value, { literal = false } = {}) {
  const entities = !literal;
  const s = String(value);
  let out = '';
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length && /[!-/:-@[-`{-~]/.test(s[i + 1])) { out += s[i + 1]; i += 2; continue; }
    if (s.startsWith('<!--', i)) {
      const end = s.indexOf('-->', i + 4);
      if (end >= 0) { out += ' '; i = end + 3; continue; }
    }
    if (s[i] === '`') {
      let n = 1;
      while (s[i + n] === '`') n++;
      let close = -1;
      for (let k = s.indexOf('`', i + n); k >= 0;) {
        let m = 1;
        while (s[k + m] === '`') m++;
        if (m === n) { close = k; break; }
        k = s.indexOf('`', k + m);
      }
      if (close >= 0) {
        const inner = s.slice(i + n, close);
        out += inner.replace(INVISIBLE, '').trim() === '' ? ' ' : inner;
        i = close + n;
        continue;
      }
      out += s.slice(i, i + n);
      i += n;
      continue;
    }
    if (entities && s[i] === '&') {
      ENTITY.lastIndex = i;
      const m = ENTITY.exec(s);
      if (m) {
        const ref = m[1];
        if (ref[0] === '#') {
          const cp = ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
          if (cp > 0 && cp <= 0x10FFFF) out += String.fromCodePoint(cp);
        }
        i += m[0].length;
        continue;
      }
    }
    out += s[i];
    i++;
  }
  return out.replace(INVISIBLE, '').replace(/^(?:""|'')$/, '').trim();
}
// A rule or a free-text value carries text when it still holds a letter or a digit after that reduction.
const hasText = (value, opts) => /[\p{L}\p{N}]/u.test(textOf(value, opts));

// The text of a rule line: everything after the `<rule-id>. ` marker, or null when the line has no rule marker.
function ruleText(line) {
  const m = RULE_ID.exec(line);
  return m ? line.slice(m[0].length - 1) : null;
}
// A rule line parses only when it carries text (see textOf): `R-L0-01. .`, an empty code span, a comment or invisible characters
// after the marker make a hollow rule, which falls to `unparsed` (lint F10) and never to the rule count.
function parseRuleId(line) {
  const m = RULE_ID.exec(line);
  return m && hasText(ruleText(line)) ? m[1] : null;
}
// The one evidence-item grammar ( WP-1.4, Р6/F-04). lint F6 reads every `evidence:`
// entry through parseEvidenceItem; it accepts exactly the forms the canon defines
// (procedure.schema.md section 2: DEC-*, PROTO-DEC-*, sig-*, path:line) plus the Р6-A forms
// PROTO-DEC-nnnn:<k> and path:<a>-<b>. Syntax only: resolvability stays with check-links, and no
// file-existence requirement is added or strengthened here (R6-A interaction, WP-1.9).
// A DEC-shaped token is a decision reference, never a path: an id that fails its own form is
// malformed (F6), not a path with a line number.
const DECISION_SHAPED = /^(?:PROTO-)?DEC-\d+$/;
function parseEvidenceItem(value) {
  let m;
  if (DECISION_ID.test(value)) return { form: 'decision', id: value };
  if ((m = /^PROTO-DEC-\d{4}:(\d+)$/.exec(value))) {
    return Number(m[1]) >= 1 ? { form: 'decision-item', id: value.slice(0, value.length - m[1].length - 1), item: Number(m[1]) } : null;
  }
  if (/^sig-[A-Za-z0-9._-]+$/.test(value)) return { form: 'signal', id: value };
  if ((m = /^([A-Za-z0-9._\-/]+):(\d+)-(\d+)$/.exec(value)) && !DECISION_SHAPED.test(m[1])) {
    const from = Number(m[2]);
    const to = Number(m[3]);
    return from >= 1 && from < to ? { form: 'range', path: m[1], from, to } : null;
  }
  if ((m = /^([A-Za-z0-9._\-/]+):(\d+)$/.exec(value)) && !DECISION_SHAPED.test(m[1])) {
    return Number(m[2]) >= 1 ? { form: 'line', path: m[1], line: Number(m[2]) } : null;
  }
  return null;
}

// `##` headings and rule lines of the body, outside fenced code blocks. A "## Rules" line that
// starts like a rule and does not parse goes to `unparsed` (F10), never to silence.
function bodyStructure(rec) {
  const headings = [];
  const rules = [];
  const unparsed = [];
  const listItemsWithoutId = [];
  let fence = false;
  let section = null;
  for (let i = rec.bodyStart; i < rec.lines.length; i++) {
    const line = rec.lines[i].replace(/\r$/, '');
    if (/^(```|~~~)/.test(line)) { fence = !fence; continue; }
    if (fence) continue;
    const h = line.match(/^## (.+?)\s*$/);
    if (h) { headings.push({ name: h[1], line: i + 1 }); section = h[1]; continue; }
    if (section !== 'Rules') continue;
    const id = parseRuleId(line);
    if (id) rules.push({ id, line: i + 1 });
    else if (RULE_LINE.test(line)) {
      // hollow: the marker parses but no text follows it (textOf); the compiler words that case apart from a malformed marker.
      const hollow = RULE_ID.exec(line);
      unparsed.push({ line: i + 1, token: line.replace(/^- /, '').split(/\s/)[0], text: line.slice(0, 60), hollow: Boolean(hollow), id: hollow ? hollow[1] : null });
    }
    else if (/^- /.test(line)) listItemsWithoutId.push({ line: i + 1, text: line.slice(0, 60) });
  }
  return { headings, rules, unparsed, listItemsWithoutId };
}

// ---------- corpus ----------

function listMarkdown(target) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) throw new InputError(`no such path: ${target}`);
  const st = fs.statSync(abs);
  if (st.isFile()) return [abs];
  const out = [];
  (function walk(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => cmp(a.name, b.name))) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.md')) out.push(p);
    }
  })(abs);
  return out;
}

function loadRecords(targets, { skipUnlisted = false } = {}) {
  const records = [];
  const errors = [];
  const seen = new Set();
  for (const t of targets) {
    for (const file of listMarkdown(t)) {
      if (seen.has(file)) continue;
      seen.add(file);
      const rec = parseRecord(file);
      rec.file = file;
      rec.rel = rel(file);
      if (rec.fm === null) {
        if (skipUnlisted || WORK_PRODUCTS.some(re => re.test(path.basename(file)))
          || path.basename(file) === REGISTRY_NAME || /(^|\/)trial\//.test(rec.rel)) continue;
        errors.push({ code: 'F1', path: rec.rel, line: 1, value: path.basename(file), message: 'no front matter and not an allowlisted work product' });
        continue;
      }
      records.push(rec);
    }
  }
  return { records, errors };
}

// The tree SHA: a digest of the scanned tree, one line per record - the same manifest the
// CATALOG Sources section carries. Same tree, same SHA; no git history is read.
function manifestLines(records) {
  return records.filter(r => r.fm).map(r => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(r.file)).digest('hex')}  ${r.rel}`).sort(cmp);
}
function treeSha(lines) {
  return `sha256:${crypto.createHash('sha256').update(lines.join('\n')).digest('hex')}`;
}

module.exports = {
  InputError,
  SCALAR_KEYS,
  LIST_KEYS,
  WORK_PRODUCTS,
  REGISTRY_NAME,
  RULE_ID,
  RULE_LINE,
  DECISION_ID,
  repoRootFrom,
  REPO,
  rel,
  cmp,
  dicts,
  loadDictionaries,
  parseRecord,
  parseRuleId,
  ruleText,
  INVISIBLE,
  textOf,
  hasText,
  DECISION_SHAPED,
  parseEvidenceItem,
  bodyStructure,
  listMarkdown,
  loadRecords,
  manifestLines,
  treeSha,
};

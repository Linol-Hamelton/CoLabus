'use strict';
// md-structure.cjs - the one structural reader of the Markdown sources of the operator knowledge (a
// PROTO-DEC-0216 closed construction, PROTO-DEC-0227). owner-rules.cjs reads the owner rules list and the kernel
// record P-L1-003 only through it; handover.cjs reads .ai/TASK.md and .ai/DECISIONS.md only through it and quotes
// what it takes as data. Neither tool reads Markdown by a line pattern of its own.
//
// Every reading starts from the shared scanner text-safe.maskMarkdown, which gives each line the set of Markdown kinds
// that cover it (a fence, a comment, an HTML element such as details, a quote, an inline link, a code span, ...). A
// reading is CLOSED: it names the kinds a line may carry (a whitelist, never a list of kinds to hide), so a construct
// the scanner learns later is refused before anyone decides it is harmless.
//
//   readRulesTable(text, spec)  the owner rules list: EXACTLY ONE table, at its fixed header row; the whole source is
//                               refused (a Refusal with a named reason) on a second header, a table cell separator
//                               "|" on any line outside the table (a stray row before, after or inside other
//                               structure), a line outside the table with a kind other than heading, list item or code
//                               span (a fence, a comment, an HTML block or element, a quote, a link, ...), a table line
//                               with a kind other than table (and code span in a row), a table that does not stand
//                               between blank lines, a row whose cells are not the closed grammar, and a cell holding
//                               Markdown. Never a row skipped, never a row added.
//   cellData(cell)              the one documented rule for Markdown inside a cell: a cell is plain text; the one
//                               construct it may hold is a code span of single backticks, which is STRIPPED (written as
//                               its content); any other Markdown character (\ * [ ] < > & ~ $, an unpaired backtick,
//                               an underscore at the edge of a word) is refused, also inside the code span.
//   readRecordSections(text)    the kernel record: front matter, headings, paragraphs, list items and code spans only;
//                               exactly one "## Rules" heading as a heading of the record's own statement, followed by
//                               another section; a rule line anywhere outside that section is refused.
//   readTaskDate(text)          the "Last update: YYYY-MM-DD" line of the task, only from a plain line of the task's own
//                               statement (no kind at all); none or more than one is no date, with the reason.
//   readDecisions(text)         the decision blocks: a heading "### DEC-nnnn" or "### PROTO-DEC-nnnn" that is a
//                               heading of the document's own statement after a blank line; the fields Date, Status
//                               and Title from own lines of its block (each set once; a second line of one field is a
//                               duplicate, returned by name for the caller to refuse); a block ends at any heading. A
//                               decision-shaped line in any other place is no decision and is NAMED (skipped lines).
//   quoteBlock(lines)           a source text as a quoted data block (an indented block of four spaces), so no heading,
//                               comment, fence or metadata line of a source becomes structure of the generated file.
//   inlineData(text, chars)     one source value inside a line of the generated file: clipped, every Markdown
//                               character escaped with a backslash.
//   lineKinds(text)             the scanner's kinds per line (an empty array for a line it leaves as plain text).
//   entityLines(text), canShow  character references: never decoded. The list and the record
//                               refuse any (ENTITY_REFUSED); the task date and the decision fields name a reference in
//                               a line that could read as a date, a heading or a field; owner-rules.cjs refuses one in
//                               a word that could read as a rule id. canShow tries every reading instead of choosing one.

const textSafe = require('../../.ai/bin/lib/text-safe.cjs');
const { clip } = require('./summary.cjs');

class Refusal extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}

// The shared text check: invalid UTF-8, a lone surrogate, a BOM, a carriage return or an invisible character refuses.
const STRICT = Object.freeze({ invisible: 'refuse' });

// The first invisible format character of a text by the shared predicate of text-safe (every Default_Ignorable_Code_Point
// and every Cf character, U+2061 included, not a list of literals): { line, hex } or null. decodeText refuses only its
// named classes (zero width, bidi, tag); the list and the record refuse every format character.
function formatChar(text) {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (textSafe.isIgnorableFormat(ch)) return { line: i + 1, hex: `U+${ch.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}` };
    }
  }
  return null;
}

// ---------- character references (PROTO-DEC-0216, PROTO-DEC-0227) ----------
// An HTML character reference is NOT part of the input grammar of the owner rules list, of the kernel record, of a text
// that cites rule ids, or of the structural lines of the task and the decisions. Nothing here decodes one and nothing
// maps a shown text back to its source: a reference where it could change what is read is refused (ENTITY_REFUSED) at
// its line. The form is closed and wider than HTML's: an ampersand, then a hash or an ASCII letter, then letters and
// digits, the semicolon optional (named, decimal, hex with x or X, astral, surrogate halves, a missing semicolon).
const ENTITY_FORM = /&[#A-Za-z][0-9A-Za-z]*;?/;
const ENTITY_FORMS = new RegExp(ENTITY_FORM.source, 'g');

// The first reference form of each line of text: [{ line, form }].
function entityLines(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const m = ENTITY_FORM.exec(line);
    if (m) out.push({ line: i + 1, form: m[0] });
  });
  return out;
}

// Could some reading of raw show key (anywhere, or at its start when anchored)? A reference form is never decoded:
// every reading is tried. A form reads as any zero, one or two characters followed by any end part of its own text (its
// own text, a decoded character, an HTML decoding without the semicolon, a character that hides); every other
// character reads as itself. Only a text that holds a form is asked: a plain text is read as written by its reader.
function canShow(raw, key, anchored) {
  const units = [];
  let last = 0;
  for (const m of raw.matchAll(ENTITY_FORMS)) {
    for (const ch of raw.slice(last, m.index)) units.push({ ch });
    units.push({ ref: m[0] });
    last = m.index + m[0].length;
  }
  if (!units.some(u => u.ref !== undefined)) return false;
  for (const ch of raw.slice(last)) units.push({ ch });
  const memo = new Map();
  const match = (i, k) => {
    if (k >= key.length) return true;
    if (i >= units.length) return false;
    const id = i * (key.length + 1) + k;
    if (memo.has(id)) return memo.get(id);
    const u = units[i];
    let ok = false;
    if (u.ref === undefined) ok = u.ch === key[k] && match(i + 1, k + 1);
    else {
      for (let t = 0; t <= 2 && !ok; t++) {
        const at = k + t;
        if (at >= key.length) { ok = true; break; }
        for (let j = 0; j <= u.ref.length && !ok; j++) {
          const part = u.ref.slice(j);
          const rest = key.slice(at);
          if (rest.startsWith(part)) ok = match(i + 1, at + part.length);
          else if (part.startsWith(rest)) ok = true;
        }
      }
    }
    memo.set(id, ok);
    return ok;
  };
  if (anchored) return match(0, 0);
  for (let i = 0; i < units.length; i++) if (match(i, 0)) return true;
  return false;
}

const entityRefusal = (where, e) => new Refusal('ENTITY_REFUSED', `line ${e.line}: the character reference "${e.form}" in ${where} (a character reference is not read; write the character itself)`);

// One entry per line of text.split('\n'): the sorted kinds of the scanner (the scanner gives no entry for the empty
// line after a final line break; that line has no kind).
function lineKinds(text) {
  const mask = textSafe.maskMarkdown(text).lines;
  return text.split('\n').map((line, i) => (mask[i] ? mask[i].kinds : []));
}

const only = (kinds, allowed) => kinds.every(kind => allowed.includes(kind));
const named = kinds => kinds.filter(kind => kind !== 'table' && kind !== 'code-span' && kind !== 'heading' && kind !== 'list-item').join(', ') || kinds.join(', ');

// ---------- the owner rules list ----------

const OUTSIDE_KINDS = Object.freeze(['heading', 'list-item', 'code-span']);
const ROW_KINDS = Object.freeze(['table', 'code-span']);
const MARKDOWN_CHAR = /[\\*[\]<>&~$]/u;
const EDGE_UNDERSCORE = /(?<![\p{L}\p{N}])_|_(?![\p{L}\p{N}])/u;

// The text of a cell as data, or { ok: false, reason }.
function cellData(cell) {
  const parts = cell.split('`');
  if (parts.length % 2 === 0) return { ok: false, reason: 'an unpaired backtick' };
  for (let k = 1; k < parts.length; k += 2) {
    if (!parts[k] || /^\s|\s$/u.test(parts[k])) return { ok: false, reason: 'a code span that is empty, a run of backticks or a span with a blank at its edge' };
  }
  const text = parts.join('');
  const md = MARKDOWN_CHAR.exec(text);
  if (md) return { ok: false, reason: `the Markdown character "${md[0]}" (a cell is plain text; only a code span is allowed, and it is written as its content)` };
  if (EDGE_UNDERSCORE.test(text)) return { ok: false, reason: 'an underscore at the edge of a word (emphasis)' };
  return { ok: true, text };
}

// spec: { header, separator, columns }. Returns { start, rows: [{ line, cells, raw }] } with the cells as data.
function readRulesTable(text, spec) {
  if (typeof text !== 'string') throw new TypeError('readRulesTable takes a decoded string');
  const decoded = textSafe.decodeText(text, STRICT);
  if (!decoded.ok) throw new Refusal('BAD_TEXT', `the list is not strict text: ${decoded.problems.map(p => p.code).join(',')}`);
  const format = formatChar(text);
  if (format) throw new Refusal('BAD_TEXT', `line ${format.line}: the invisible format character ${format.hex} (the list is not strict text)`);
  const entity = entityLines(text)[0];
  if (entity) throw entityRefusal('the owner rules list', entity);
  const lines = text.split('\n');
  const kinds = lineKinds(text);
  const heads = lines.reduce((acc, line, i) => (line === spec.header ? [...acc, i] : acc), []);
  if (heads.length !== 1) throw new Refusal('BAD_TABLE', `the header "${spec.header}" must appear exactly once (found ${heads.length})`);
  const start = heads[0];
  if (start > 0 && lines[start - 1] !== '') throw new Refusal('BAD_TABLE', `line ${start + 1}: the header must follow a blank line`);
  if (lines[start + 1] !== spec.separator) throw new Refusal('BAD_TABLE', 'the separator line must follow the header');
  let end = start + 2;
  while (end < lines.length && lines[end].startsWith('|')) end++;
  if (end === start + 2) throw new Refusal('BAD_TABLE', 'the table has no rule rows');
  // A line right after the last row is a row of the table for a Markdown reader: the table must end at a blank line.
  if (end < lines.length && lines[end] !== '') throw new Refusal('BAD_TABLE', `line ${end + 1}: the table must end at a blank line`);
  const rows = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const k = kinds[i];
    if (i < start || i >= end) {
      if (line.includes('|')) throw new Refusal('BAD_TABLE', `line ${i + 1}: a table cell separator "|" outside the one table (a rule row is read only inside it)`);
      if (!only(k, OUTSIDE_KINDS)) throw new Refusal('BAD_TABLE', `line ${i + 1}: Markdown structure (${named(k)}) outside the table; the list holds headings, paragraphs, list items and code spans only`);
      continue;
    }
    if (i < start + 2) {
      if (k.length !== 1 || k[0] !== 'table') throw new Refusal('BAD_TABLE', `line ${i + 1}: the ${i === start ? 'header' : 'separator'} is inside other Markdown structure (${named(k)})`);
      continue;
    }
    if (!k.includes('table') || !only(k, ROW_KINDS)) throw new Refusal('BAD_ROW', `line ${i + 1}: the row is inside other Markdown structure (${named(k)})`);
    if (!line.startsWith('| ') || !line.endsWith(' |')) throw new Refusal('BAD_ROW', `line ${i + 1} is not a row of the form "| cell | ... |"`);
    const cells = line.slice(1, -1).split('|').map(c => c.trim());
    if (cells.length !== spec.columns || cells.some(c => !c)) throw new Refusal('BAD_ROW', `line ${i + 1} must have ${spec.columns} non-empty cells (found ${cells.length})`);
    // Byte for byte: the row is exactly its cells, each with one space on either side of its pipes.
    if (line !== `| ${cells.join(' | ')} |`) throw new Refusal('BAD_ROW', `line ${i + 1}: a cell has a blank of its own at its edge`);
    const data = cells.map(cellData);
    const bad = data.findIndex(d => !d.ok);
    if (bad >= 0) throw new Refusal('BAD_ROW', `line ${i + 1}, cell ${bad + 1}: ${data[bad].reason}`);
    rows.push({ line: i + 1, cells: data.map(d => d.text), raw: line });
  }
  return { start, rows };
}

// ---------- the kernel record ----------

const RECORD_KINDS = Object.freeze(['front-matter', 'heading', 'list-item', 'code-span']);
const RULES_HEADING = '## Rules';
// A heading line whose title is Rules, at any level and in any spacing.
const RULES_NAMED = /^ {0,3}#{1,6}[ \t]*Rules[ \t#]*$/;
// A rule line of the record (or one shaped like it): it may stand only inside the "## Rules" section.
const RULE_LINE = /R-L1-003\.\d+\.\s*OR-\d|^\s*(?:[-*+]|\d{1,9}[.)])\s+OR-\d+\s*\[/;

function readRecordSections(text) {
  const format = formatChar(text);
  if (format) throw new Refusal('BAD_RECORD', `line ${format.line}: the invisible format character ${format.hex} in the kernel record`);
  const entity = entityLines(text)[0];
  if (entity) throw entityRefusal('the kernel record', entity);
  const lines = text.split('\n');
  const kinds = lineKinds(text);
  for (let i = 0; i < lines.length; i++) {
    if (!only(kinds[i], RECORD_KINDS)) throw new Refusal('BAD_RECORD', `line ${i + 1}: Markdown structure (${named(kinds[i])}) in the kernel record; a record holds front matter, headings, paragraphs, list items and code spans only`);
  }
  const isHeading = i => kinds[i].includes('heading');
  const sections = lines.reduce((acc, line, i) => (isHeading(i) && line.startsWith('## ') ? [...acc, i] : acc), []);
  const rules = sections.filter(i => lines[i] === RULES_HEADING);
  const namedRules = lines.filter(line => RULES_NAMED.test(line)).length;
  if (rules.length !== 1 || namedRules !== 1) throw new Refusal('BAD_RECORD', `the record must have exactly one "${RULES_HEADING}" heading`);
  const at = rules[0];
  const end = sections.find(i => i > at);
  if (end === undefined) throw new Refusal('BAD_RECORD', `the "${RULES_HEADING}" section must be followed by another section`);
  for (let i = 0; i < lines.length; i++) {
    if ((i <= at || i >= end) && RULE_LINE.test(lines[i])) throw new Refusal('BAD_RECORD', `line ${i + 1}: a rule line outside the "${RULES_HEADING}" section`);
  }
  return { before: lines.slice(0, at + 1), body: lines.slice(at + 1, end), after: lines.slice(end), bodyStart: at + 2, bodyEnd: end };
}

// ---------- the task and the decisions ----------

const LAST_UPDATE = /^Last update: (\d{4}-\d{2}-\d{2})\s*$/;
const LAST_UPDATE_KEY = 'Last update: ';

// { day, line } or { day: null, reason } (the reason completes ".ai/TASK.md ...").
function readTaskDate(text) {
  const lines = text.split('\n');
  const kinds = lineKinds(text);
  // A reference in a line that could read as the date line is refused: never a date guessed around it.
  const entity = entityLines(text).find(e => canShow(lines[e.line - 1], LAST_UPDATE_KEY, true));
  if (entity) return { day: null, reason: `has a character reference in a "Last update:" line at line ${entity.line} (ENTITY_REFUSED: a character reference is not read; write the character itself)` };
  const plain = lines.map((line, i) => i).filter(i => kinds[i].length === 0 && LAST_UPDATE.test(lines[i]));
  if (plain.length > 1) return { day: null, reason: `has ${plain.length} "Last update:" lines of its own statement (one is the date)` };
  if (!plain.length) return { day: null, reason: 'has no "Last update:" line' };
  return { day: LAST_UPDATE.exec(lines[plain[0]])[1], line: plain[0] + 1 };
}

const DECISION_HEAD = /^### ((?:PROTO-)?DEC-\d{4})$/;
const DECISION_SHAPED = /#{1,6}[ \t]*(?:PROTO-)?DEC-\d{4}/;
const FIELD = /^(Date|Status|Title): (.*)$/;
const FIELD_KEYS = Object.freeze(['Date: ', 'Status: ', 'Title: ']);
const FIELD_KINDS = Object.freeze(['code-span']);

// { blocks: [{ id, date, status, title, line }], skipped: [line numbers], duplicates: [{ id, field, line, first }],
//   entities: [{ line, form }] }.
// A field is set once: its presence is a flag of the block (never a comparison with the placeholder "?"), and a second
// line of the same field in one block is a duplicate the caller refuses by name. A character
// reference in a heading line, or in a line that could read as a field line, is returned by line for the caller to
// refuse: a heading or a field is never read around it.
function readDecisions(text) {
  const lines = text.split('\n');
  const kinds = lineKinds(text);
  const entities = entityLines(text).filter(e => kinds[e.line - 1].includes('heading') || FIELD_KEYS.some(key => canShow(lines[e.line - 1], key, true)));
  const blocks = [];
  const skipped = [];
  const duplicates = [];
  let current = null;
  let seen = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const k = kinds[i];
    const head = DECISION_HEAD.exec(line);
    if (head && k.length === 1 && k[0] === 'heading' && (i === 0 || lines[i - 1] === '')) {
      current = { id: head[1], date: '?', status: '?', title: '?', line: i + 1 };
      seen = new Map();
      blocks.push(current);
      continue;
    }
    if (DECISION_SHAPED.test(line)) skipped.push(i + 1);
    if (k.includes('heading')) { current = null; continue; }
    if (!current || !only(k, FIELD_KINDS)) continue;
    const field = FIELD.exec(line);
    if (!field) continue;
    const name = field[1].toLowerCase();
    if (seen.has(name)) { duplicates.push({ id: current.id, field: field[1], line: i + 1, first: seen.get(name) }); continue; }
    seen.set(name, i + 1);
    current[name] = field[2].trim();
  }
  return { blocks, skipped, duplicates, entities };
}

// ---------- the generated file ----------

const QUOTE = '    ';
const quoteBlock = lines => lines.map(line => (line === '' ? '' : `${QUOTE}${line}`));

// Every ASCII character with an inline meaning in Markdown, escaped with a backslash (CommonMark: any ASCII
// punctuation may be escaped, and an escaped character is shown as itself).
// The clip is the summary's: control characters flattened, cut at chars code points.
const INLINE_MARKDOWN = /[\\`*_[\]<>&~|#!$]/g;
const inlineData = (text, chars) => clip(text, chars).replace(INLINE_MARKDOWN, '\\$&');

module.exports = { Refusal, STRICT, ENTITY_FORM, entityLines, canShow, formatChar, lineKinds, cellData, readRulesTable, readRecordSections, readTaskDate, readDecisions, quoteBlock, inlineData, QUOTE, OUTSIDE_KINDS, ROW_KINDS, RECORD_KINDS, FIELD_KINDS };

#!/usr/bin/env node
'use strict';

// protocol-delegation.cjs - deterministic checker of delegation records (S6-T02, P-L8-001).
// Record shape: .ai/core/schema/delegation.schema.md (SCHEMA-delegation, draft). It reuses the L5
// wire discipline of SCHEMA-artifact (a fenced block of `key: value` lines, a closed field set,
// missing required = exit 1, unknown or malformed = exit 2, fail-closed on a missing input:
// R-L5-artifact.2, .5) and the L1 delegation rule of SCHEMA-assignment section 5 (the record names
// the decision block in which the owner granted it).
//
// The owner's grant is read positively: the decision block must state, as its own
// live statements, exactly one `Status: Accepted`, one `Approved by:` naming a person, one `Date:`
// and the six `Grant-*` lines; the record may only narrow that grant, and `check` applies both.
// A statement is live only in a paragraph of `Key: value` lines at column 0, outside fences,
// HTML, comments, quotes, tables, lists and code spans; a statement-like line in any other form
// is unknown and never authorises, never revokes silently.
//
// Text is decoded by the shared guard
// text-safe, every path is judged by path-safe realInside (an excluded path excludes itself and
// everything below it in any spelling; lstat errors are UNKNOWN, never a missing component; both
// sides of a comparison use one real path), the approver carries a closed provenance and must be
// a name of the closed owner list in the project data `.ai/docs/owners.json`, and a decision id is
// named only between symmetric boundaries.
//
// An object key of the owner list is compared after
// escape-decoding, so a key stated twice in any spelling is ambiguous and refuses (the platform
// JSON.parse keeps the last of two keys silently); and `--path` names a repository file, so an
// existing directory is malformed input - a move or delete of it would act on a whole subtree and
// an excluded path under it would move or vanish with it.
//
//   lint  <file> [--root <dir>]
//   check <file> --grantee <token> --scope-id <kind:name> --verb <verb> --path <p> [--path <p> ...]
//                --at <YYYY-MM-DDTHH:MM:SSZ> [--root <dir>]
//
// Exit: 0 clean / ALLOW; 1 a rule broken / REFUSE; 2 malformed input, never guessed.
// The clock is never read: the instant of the action is an input (--at), so a run is reproducible.
// The checker is advisory: nothing calls it, it closes no gate (P-L8-001, enforcement P).

const fs = require('node:fs');
const path = require('node:path');
const textSafe = require('./lib/text-safe.cjs');
const pathSafe = require('./lib/path-safe.cjs');

const FIELDS = ['delegation-id', 'date-utc', 'grantee', 'scope-id', 'scope-paths', 'excluded', 'verbs', 'until', 'by'];
const GRANT_FIELDS = ['grantee', 'scope-id', 'scope-paths', 'excluded', 'verbs', 'until'];
const VERBS = ['edit', 'create', 'move', 'delete', 'commit', 'tag', 'merge', 'push'];
const DG_ID = /^DG-(\d{4})(\d{2})(\d{2})-\d{2}$/;
const UTC = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})Z$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const GRANTEE = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const SCOPE_ID = /^(?:(?:program|task):[a-z0-9][a-z0-9-]{2,63}|candidate:[0-9a-f]{40})$/;
const BLOCK_ID = /^(?:PROTO-DEC|DEC)-\d{4}$/;
const SEGMENT = /^[A-Za-z0-9._@+-]+$/;
// One identity token in the form the decision log uses (`OwnerName`): at least two capitalised
// parts, optionally followed by ONE closed provenance in parentheses - non-empty, no parenthesis
// inside, nothing after the closing one. An unclosed parenthesis, an empty one, a nested one or a
// tail after the closed one is malformed. TBD, empty, `_pending`, `Owner`,
// `unknown`, `a human name` do not match. Whether the token is THE owner is decided separately by
// the closed owner list of the project data (Addendum 118 item 5), never by this grammar (I-8).
const APPROVER = /^([A-Z][a-z]+(?:[A-Z][a-z]+)+)(?: \([^()]+\))?$/;

class InputError extends Error {}

function validDate(y, m, d) {
  const t = Date.UTC(Number(y), Number(m) - 1, Number(d));
  const x = new Date(t);
  return x.getUTCFullYear() === Number(y) && x.getUTCMonth() === Number(m) - 1 && x.getUTCDate() === Number(d);
}
function parseUtc(value) {
  const m = UTC.exec(value);
  if (!m || !validDate(m[1], m[2], m[3]) || Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 59) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
}
function dayStart(value) {
  const m = DATE.exec(value);
  if (!m || !validDate(m[1], m[2], m[3])) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0);
}
// `until` is a calendar date; the delegation holds through 23:59:59Z of that day.
function untilEnd(value) {
  const start = dayStart(value);
  return start === null ? null : start + 86399000;
}

// A path item is repository-relative, ASCII, `/`-separated; a directory prefix ends with `/`.
// The grammar is positive: no glob, no `..`, no absolute or drive form, no trailing dot or space,
// no `:` (alternate streams), no `~` (8.3 short names). Anything else is malformed.
function pathItem(raw) {
  if (typeof raw !== 'string' || raw === '') return null;
  const dir = raw.endsWith('/');
  const body = dir ? raw.slice(0, -1) : raw;
  if (body === '') return null;
  const segs = body.split('/');
  for (const s of segs) {
    if (!SEGMENT.test(s) || s === '.' || s === '..' || s.endsWith('.')) return null;
  }
  return { text: raw, dir, body };
}
function listOf(value) {
  return value.split(', ');
}

// Field grammars shared by the record and the owner's `Grant-*` lines.
const PARSE = {
  grantee: v => (GRANTEE.test(v) ? v : null),
  'scope-id': v => (SCOPE_ID.test(v) ? v : null),
  'scope-paths': v => { const l = listOf(v).map(pathItem); return l.some(x => x === null) ? null : l; },
  excluded: v => { if (v === 'none') return []; const l = listOf(v).map(pathItem); return l.some(x => x === null) ? null : l; },
  verbs: v => { const l = listOf(v); return l.some(x => !VERBS.includes(x)) || new Set(l).size !== l.length ? null : l; },
  until: v => (untilEnd(v) === null ? null : v),
};

// ---- text as data ----

// Strict decoding through the shared guard (text-safe decode): BOM, CRLF and lone CR
// are refused, NUL and invalid UTF-8 are refused by the library itself; the refusal keeps its name
// so the finding message stays the one the tests pin.
const DECODE_WHY = { BOM: 'BOM', NUL: 'NUL', LONE_CR: 'CR', CRLF: 'CR', INVALID_UTF8: 'invalid UTF-8' };
function decodeStrict(buf) {
  const d = textSafe.decode(buf, { bom: 'refuse', crlf: 'refuse' });
  if (!d.ok) {
    const first = (d.problems && d.problems[0]) || { code: 'UNKNOWN' };
    return { why: DECODE_WHY[first.code] || first.code };
  }
  return { text: d.text };
}
const INVISIBLE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFE00-\uFE0F\uFEFF]/g;
const ODD_SPACE = /[\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\t]/g;
const CONFUSABLE = {
  '\u0410': 'A', '\u0412': 'B', '\u0415': 'E', '\u041A': 'K', '\u041C': 'M', '\u041D': 'H', '\u041E': 'O', '\u0420': 'P',
  '\u0421': 'C', '\u0422': 'T', '\u0425': 'X', '\u0405': 'S', '\u0406': 'I', '\u0408': 'J', '\u0430': 'a', '\u0435': 'e',
  '\u043E': 'o', '\u0440': 'p', '\u0441': 'c', '\u0443': 'y', '\u0445': 'x', '\u0455': 's', '\u0456': 'i', '\u0458': 'j',
  '\u0391': 'A', '\u0392': 'B', '\u0395': 'E', '\u0396': 'Z', '\u0397': 'H', '\u0399': 'I', '\u039A': 'K', '\u039C': 'M',
  '\u039D': 'N', '\u039F': 'O', '\u03A1': 'P', '\u03A4': 'T', '\u03A5': 'Y', '\u03A7': 'X', '\u03BF': 'o', '\u03BD': 'v',
  '\u03C1': 'p', '\u2010': '-', '\u2011': '-', '\u2012': '-', '\u2013': '-', '\u2014': '-', '\u2212': '-', '\uFF1A': ':',
};
// The form a reader sees: invisible characters dropped, odd spaces made spaces, compatibility forms
// and look-alike letters folded. A line whose folded form is a statement but whose bytes are not
// is a disguised statement: unknown, never a statement.
function folded(line) {
  return line.normalize('NFKC').replace(INVISIBLE, '').replace(ODD_SPACE, ' ').replace(/[^\x00-\x7F]/g, c => CONFUSABLE[c] || c);
}

// ---- the record file: strict fences ----

// Fenced blocks, strictly. A line that starts (after any indentation) with ``` or ~~~ is a fence
// line; it must start at column 0 and an opening fence carries an info string of [A-Za-z0-9-]
// only. A `delegation` fence opens only after a blank line or at the start of the file, and an
// HTML line is outside the file grammar (an HTML block or comment could hold a fence that renders
// as text). Anything else is a malformed form, because a guessed fence boundary would turn quoted
// text into a live record or a live record into text. A fence closes on the same character
// repeated at least as often; content inside another fence (an example) is never read as a record.
function scanFences(lines, push) {
  const blocks = [];
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceLike = /^\s*(`{3,}|~{3,})/.exec(line);
    if (open === null) {
      if (/^ {0,3}<[A-Za-z/!?]/.test(line)) { push('D-08', 'malformed', i + 1, line.slice(0, 40), 'an HTML line is outside the record file grammar'); return { blocks, broken: true }; }
      if (!fenceLike) continue;
      const m = /^(`{3,}|~{3,})([A-Za-z0-9-]*)$/.exec(line);
      if (!m) { push('D-08', 'malformed', i + 1, line.slice(0, 40), 'a fence line outside the closed fence grammar (column 0, info [A-Za-z0-9-] only)'); return { blocks, broken: true }; }
      if (m[2] === 'delegation' && i > 0 && lines[i - 1] !== '') { push('D-08', 'malformed', i + 1, line.slice(0, 40), 'a delegation fence opens only after a blank line'); return { blocks, broken: true }; }
      open = { char: m[1][0], len: m[1].length, info: m[2], start: i + 1, content: [] };
      continue;
    }
    const close = /^(`{3,}|~{3,})$/.exec(line);
    if (close && close[1][0] === open.char && close[1].length >= open.len) {
      blocks.push(open);
      open = null;
      continue;
    }
    if (fenceLike && open.info === 'delegation') {
      push('D-08', 'malformed', i + 1, line.slice(0, 40), 'a fence line inside a delegation block that does not close it');
      return { blocks, broken: true };
    }
    open.content.push({ text: line, line: i + 1 });
  }
  if (open !== null) { push('D-08', 'malformed', open.start, open.info || 'fence', 'unclosed fence: the form cannot be read'); return { blocks, broken: true }; }
  return { blocks, broken: false };
}

function readText(file, push, root) {
  const read = pathSafe.readFileGuarded(root, file);
  if (!read.ok) throw new InputError(`delegation input cannot be verified (${read.reason})`);
  const d = decodeStrict(read.bytes);
  if (d.why) {
    const why = { BOM: 'UTF-8 without BOM is the authority (AGENTS section 11)', NUL: 'a NUL byte: not a UTF-8 text file', 'invalid UTF-8': 'invalid UTF-8', CR: 'LF is the authority (AGENTS section 11)' }[d.why];
    push('D-08', 'malformed', 1, d.why, why);
    return null;
  }
  return d.text;
}

// ---- the decision log: the document's own statements ----

const STATEMENT = /^(Status|Approved by|Date|Supersedes|Grant-[a-z-]+): (\S(?:.*\S)?)$/;
const CANDIDATE = /^\s*(status|approved\s*by|date|supersedes|grant\b[^:]*?)\s*:/i;
const FIELD_LINE = /^[A-Z][A-Za-z0-9]*(?:[ -][A-Za-z0-9]+){0,3}: \S/;
const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const INDENTED = /^(?: {4}|\t| {1,3}\t)/;
const HTML_UNTIL = [
  [/^ {0,3}<!--/, /-->/],
  [/^ {0,3}<(?:script|pre|style|textarea)(?=[\s>]|$)/i, /<\/(?:script|pre|style|textarea)>/i],
  [/^ {0,3}<\?/, /\?>/],
  [/^ {0,3}<!\[CDATA\[/, /\]\]>/],
  [/^ {0,3}<![A-Za-z]/, />/],
];
const HTML_OTHER = /^ {0,3}<\/?[A-Za-z]/;
// Lines that make a run something other than a plain paragraph: quote, list item, table row or
// delimiter, setext underline, thematic break, HTML.
const BLOCKISH = /^ {0,3}(?:>|[-+*](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|\||<|=+[ \t]*$|\|?[ \t:|-]*-[ \t:|-]*$|([*_])(?:[ \t]*\1){2,}[ \t]*$)/;
const INLINE_HTML = /<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!\[CDATA\[[\s\S]*?\]\]>|<![A-Za-z][^>]*>|<\/[A-Za-z][A-Za-z0-9-]*\s*>|<[A-Za-z][A-Za-z0-9-]*(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:[^\s"'=<>`]+|'[^']*'|"[^"]*"))?)*\s*\/?>/y;

// Character ranges of a paragraph that are code spans or inline HTML (CommonMark order: left to
// right, a backtick run closes on the next run of the same length, an escaped character is text).
function inlineRanges(text) {
  const out = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length && /[!-/:-@[-`{-~]/.test(text[i + 1])) { i += 2; continue; }
    if (c === '`') {
      let j = i;
      while (text[j] === '`') j++;
      const n = j - i;
      let k = j;
      let found = -1;
      while (k < text.length) {
        if (text[k] !== '`') { k++; continue; }
        let m = k;
        while (text[m] === '`') m++;
        if (m - k === n) { found = k; break; }
        k = m;
      }
      if (found >= 0) { out.push([i, found + n]); i = found + n; } else i = j;
      continue;
    }
    if (c === '<') {
      INLINE_HTML.lastIndex = i;
      const m = INLINE_HTML.exec(text);
      if (m) { out.push([i, i + m[0].length]); i += m[0].length; continue; }
    }
    i++;
  }
  return out;
}

// Reads a Markdown document into its live headings and live statements. Positive rule: a statement
// is a `Key: value` line of the closed STATEMENT grammar, at column 0, in a paragraph made only of
// such field lines, not inside a code span or inline HTML of that paragraph. Fences (0-3 spaces,
// backtick or tilde), HTML blocks and comments, indented code are masked; quotes, tables, lists,
// setext headings and lazy continuations are paragraphs with a non-field line. A statement-like
// line anywhere else that is not masked is `ambiguous`; an unclosed fence or HTML block makes the
// whole document `unknown`.
function readStatements(text) {
  const lines = text.split('\n');
  const headings = [];
  const statements = [];
  const ambiguous = [];
  let fence = null;
  let until = null;
  let htmlToBlank = false;
  let run = [];
  let codeRun = false;
  let fenceStart = 0;
  let untilStart = 0;
  const flush = () => {
    if (!codeRun && run.length) {
      // In a plain paragraph (no quote, list, table, setext or HTML line) a line that begins inside
      // a code span or inline HTML is quoted; the other lines must all be field lines.
      const plain = run.every(i => !BLOCKISH.test(lines[i]));
      let masked = new Set();
      if (plain) {
        const starts = [];
        let off = 0;
        for (const i of run) { starts.push(off); off += lines[i].length + 1; }
        const ranges = inlineRanges(run.map(i => lines[i]).join('\n'));
        masked = new Set(run.filter((_, k) => ranges.some(([s, e]) => s < starts[k] && starts[k] < e)));
      }
      const field = plain && run.every(i => masked.has(i) || FIELD_LINE.test(lines[i]));
      for (const i of run) {
        if (masked.has(i)) continue;
        const raw = lines[i];
        const f = folded(raw);
        const cand = CANDIDATE.exec(f);
        if (!cand) continue;
        const key = cand[1].replace(/\s+/g, ' ').toLowerCase();
        // The key must be the exact ASCII key at column 0; the value is judged by its own grammar.
        const st = STATEMENT.exec(raw);
        if (field && st) statements.push({ line: i + 1, key: st[1], value: st[2], folded: folded(st[2]) });
        else ambiguous.push({ line: i + 1, key, text: f });
      }
    }
    run = [];
    codeRun = false;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      if (close && close[1][0] === fence.char && close[1].length >= fence.len) fence = null;
      continue;
    }
    if (until) {
      if (until.test(line)) until = null;
      continue;
    }
    if (htmlToBlank) {
      if (/^[ \t]*$/.test(line)) htmlToBlank = false;
      continue;
    }
    if (/^[ \t]*$/.test(line)) { flush(); continue; }
    if (codeRun && INDENTED.test(line)) continue;
    if (codeRun) flush();
    const fo = FENCE_OPEN.exec(line);
    if (fo && !(fo[1][0] === '`' && fo[2].includes('`'))) { flush(); fence = { char: fo[1][0], len: fo[1].length }; fenceStart = i + 1; continue; }
    const opener = HTML_UNTIL.find(([o]) => o.test(line));
    if (opener) {
      flush();
      const rest = line.slice(line.search(/</) + 1);
      if (!opener[1].test(rest)) { until = opener[1]; untilStart = i + 1; }
      continue;
    }
    if (HTML_OTHER.test(line) && run.length === 0) { htmlToBlank = true; continue; }
    const h = ATX.exec(line);
    if (h) { flush(); headings.push({ line: i + 1, level: h[1].length, raw: line, text: (h[2] || '').replace(/[ \t]+#+$/, '') }); continue; }
    if (run.length === 0 && INDENTED.test(line)) { codeRun = true; continue; }
    run.push(i);
  }
  if (fence) return { unknown: { line: fenceStart, why: 'an unclosed fence' }, headings, statements, ambiguous };
  if (until) return { unknown: { line: untilStart, why: 'an unclosed HTML block or comment' }, headings, statements, ambiguous };
  flush();
  return { unknown: null, headings, statements, ambiguous };
}

// Does the text name this decision id? The boundaries are symmetric: a `-` on
// either side means a longer, different token (a decision id followed by a suffix does not name
// the bare id, and the short form inside the long form does not name the short form).
function namesId(text, id) {
  return new RegExp(`(^|[^A-Za-z0-9-])${id}($|[^A-Za-z0-9-])`).test(text);
}

// A strict JSON reader with the one rule the platform parser cannot give: an object key is compared AFTER escape-decoding, and a key that appears twice in one
// object - in any spelling (a literal "owners" key and an escaped one that decodes to it are the
// same key) - is a refusal. JSON.parse
// silently keeps the last of the two keys and a raw text count sees only the spelling that was
// written, so an escaped duplicate was an unknown that became a pass. This is not a copy of the
// shared text guard: it is the closed grammar of JSON itself, strict in the same direction as
// JSON.parse (no trailing comma, no comment, no single quote, no unquoted key, no leading zero).
function parseJsonStrict(text) {
  let i = 0;
  const end = text.length;
  const ws = () => { while (i < end && (text[i] === ' ' || text[i] === '\n' || text[i] === '\t' || text[i] === '\r')) i += 1; };
  const bad = why => { throw new Error(why); };
  const hex4 = () => {
    const h = text.slice(i, i + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(h)) bad('a \\u escape needs four hex digits');
    i += 4;
    return String.fromCharCode(parseInt(h, 16));
  };
  const str = () => {
    if (text[i] !== '"') bad('a key or a value must be a string');
    i += 1;
    let out = '';
    for (;;) {
      if (i >= end) bad('an unterminated string');
      const ch = text[i];
      i += 1;
      if (ch === '"') return out;
      if (ch === '\\') {
        const e = text[i];
        i += 1;
        if (e === '"') out += '"';
        else if (e === '\\') out += '\\';
        else if (e === '/') out += '/';
        else if (e === 'b') out += '\b';
        else if (e === 'f') out += '\f';
        else if (e === 'n') out += '\n';
        else if (e === 'r') out += '\r';
        else if (e === 't') out += '\t';
        else if (e === 'u') out += hex4();
        else bad('an unknown escape');
      } else if (ch.charCodeAt(0) < 0x20) bad('an unescaped control character');
      else out += ch;
    }
  };
  const num = () => {
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i));
    if (!m) bad('a malformed number');
    i += m[0].length;
    return Number(m[0]);
  };
  const value = () => {
    ws();
    if (i >= end) bad('an unexpected end of input');
    const ch = text[i];
    if (ch === '{') {
      i += 1;
      const out = Object.create(null);
      const keys = new Set();
      ws();
      if (text[i] === '}') { i += 1; return out; }
      for (;;) {
        ws();
        const key = str();
        if (keys.has(key)) bad(`the key ${JSON.stringify(key)} appears twice in one object`);
        keys.add(key);
        ws();
        if (text[i] !== ':') bad('a key must be followed by `:`');
        i += 1;
        out[key] = value();
        ws();
        const c = text[i];
        i += 1;
        if (c === '}') return out;
        if (c !== ',') bad('expected `,` or `}`');
        ws();
        if (text[i] === '}') bad('a trailing comma');
      }
    }
    if (ch === '[') {
      i += 1;
      const out = [];
      ws();
      if (text[i] === ']') { i += 1; return out; }
      for (;;) {
        out.push(value());
        ws();
        const c = text[i];
        i += 1;
        if (c === ']') return out;
        if (c !== ',') bad('expected `,` or `]`');
        ws();
        if (text[i] === ']') bad('a trailing comma');
      }
    }
    if (ch === '"') return str();
    if (text.slice(i, i + 4) === 'true') { i += 4; return true; }
    if (text.slice(i, i + 5) === 'false') { i += 5; return false; }
    if (text.slice(i, i + 4) === 'null') { i += 4; return null; }
    return num();
  };
  try {
    const out = value();
    ws();
    if (i !== end) bad('trailing content after the value');
    return { value: out };
  } catch (e) {
    return { why: e.message };
  }
}

// The closed owner list of the project data (Addendum 118 item 5): `.ai/docs/owners.json` under the
// root, a data file, never code. It holds exactly one `owners` array of non-empty names. Absent,
// unreadable, malformed or stated twice: unknown, and unknown never approves.
function ownerList(root) {
  const rel = '.ai/docs/owners.json';
  const file = path.join(root, '.ai', 'docs', 'owners.json');
  let bytes;
  const read = pathSafe.readFileGuarded(root, file);
  if (!read.ok) return { error: read.reason === 'not-file'
    ? `the owner list ${rel} is absent or not a regular file under the root`
    : `the owner list ${rel} cannot be verified (${read.reason})` };
  bytes = read.bytes;
  const d = decodeStrict(bytes);
  if (d.why) return { error: `the owner list ${rel} is not UTF-8 without BOM and CR (${d.why})` };
  // Keys are judged after escape-decoding: one key stated twice in any
  // spelling is ambiguous, and an ambiguity refuses - unknown never approves.
  const parsed = parseJsonStrict(d.text);
  if (parsed.why) return { error: `the owner list ${rel} is not valid JSON (${parsed.why})` };
  const data = parsed.value;
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { error: `the owner list ${rel} is not an object with one key` };
  const keys = Object.keys(data);
  if (keys.length !== 1 || keys[0] !== 'owners') return { error: `the owner list ${rel} carries a key outside the closed set: exactly \`owners\`` };
  if (!Array.isArray(data.owners) || data.owners.some(n => typeof n !== 'string' || n === '')) return { error: `the owner list ${rel} \`owners\` must be an array of non-empty names` };
  return { owners: new Set(data.owners) };
}

function decisionLog(root) {
  const file = path.join(root, '.ai', 'DECISIONS.md');
  const read = pathSafe.readFileGuarded(root, file);
  if (!read.ok) throw new InputError(read.reason === 'not-file'
    ? '.ai/DECISIONS.md not found or not a regular file under the root: no owner record can be checked'
    : `.ai/DECISIONS.md cannot be verified (${read.reason}): no owner record can be checked`);
  const d = decodeStrict(read.bytes);
  if (d.why) return { unknown: { line: 1, why: `the decision log is not UTF-8 without BOM and CR (${d.why})` } };
  return readStatements(d.text);
}

// The block of a decision id: exactly one live heading names it, and that heading is `### <id>`.
// The block runs to the next live heading of level 1-3 (the validator's block boundary).
function decisionBlock(log, id) {
  const named = log.headings.filter(h => new RegExp(`^${id}(?![A-Za-z0-9])`).test(folded(h.text).trim()));
  if (named.length !== 1) return { error: named.length ? 'the decision heading appears more than once' : 'no decision block with this id outside fences in .ai/DECISIONS.md' };
  const h = named[0];
  if (h.raw !== `### ${id}`) return { error: `the decision heading is not exactly \`### ${id}\`` };
  const next = log.headings.find(x => x.line > h.line && x.level <= 3);
  const end = next ? next.line : Infinity;
  const inside = x => x.line > h.line && x.line < end;
  return { start: h.line, statements: log.statements.filter(inside), ambiguous: log.ambiguous.filter(inside) };
}

// a lies inside b: every path a covers, b covers.
function itemKey(item) { return item.dir ? `${item.body}/` : item.body; }
function within(a, b, insensitive) {
  const ka = insensitive ? itemKey(a).toLowerCase() : itemKey(a);
  const kb = insensitive ? itemKey(b).toLowerCase() : itemKey(b);
  return b.dir ? ka.startsWith(kb) : (!a.dir && ka === kb);
}
// a lies inside b for exclusions: every path a covers (itself and everything below it), b covers the same way. Exclusions are judged case-insensitively, as everywhere else.
function withinExcluded(a, b) {
  const na = itemKey(a).toLowerCase().replace(/\/+$/, '');
  const nb = itemKey(b).toLowerCase().replace(/\/+$/, '');
  return na === nb || na.startsWith(`${nb}/`);
}

function basisFindings(rec, log, root) {
  const out = [];
  const id = rec.by;
  const malformed = message => out.push(['D-07', 'malformed', id, message]);
  if (log.unknown) { malformed(`the decision log cannot be read: ${log.unknown.why} at line ${log.unknown.line}`); return { out }; }
  const block = decisionBlock(log, id);
  if (block.error) { malformed(block.error); return { out }; }
  for (const a of block.ambiguous) if (a.key !== 'supersedes') malformed(`line ${a.line} looks like a \`${a.key}\` statement but is not a live one`);
  const one = key => {
    const s = block.statements.filter(x => x.key === key);
    if (s.length !== 1) { malformed(s.length ? `the block states \`${key}:\` more than once` : `the block carries no live \`${key}:\` statement`); return undefined; }
    return s[0].value;
  };
  const status = one('Status');
  if (status !== undefined && status !== 'Accepted') malformed('the decision block does not carry `Status: Accepted`');
  const approver = one('Approved by');
  if (approver !== undefined && !APPROVER.test(approver)) malformed('`Approved by:` does not name a person (one identity token, optional closed (provenance))');
  else if (approver !== undefined) {
    // Addendum 118 item 5: the owner is a name from the closed owner list in the project data (a
    // data file, not code); a name outside it or an absent list refuses - unknown never approves.
    const owners = ownerList(root);
    if (owners.error) malformed(`${owners.error}: no approval can be checked (Addendum 118 item 5)`);
    else if (!owners.owners.has(APPROVER.exec(approver)[1])) malformed('`Approved by:` names a person outside the closed owner list of the project data (.ai/docs/owners.json)');
  }
  const date = one('Date');
  const from = date === undefined ? undefined : dayStart(date);
  if (from === null) malformed('`Date:` is not a valid YYYY-MM-DD');
  for (const s of block.statements) if (s.key.startsWith('Grant-') && !GRANT_FIELDS.includes(s.key.slice(6))) malformed(`unknown grant statement \`${s.key}:\` outside the closed set`);
  const grant = {};
  for (const f of GRANT_FIELDS) {
    const v = one(`Grant-${f}`);
    if (v === undefined) continue;
    const p = PARSE[f](v);
    if (p === null) malformed(`\`Grant-${f}:\` is outside its grammar`);
    else grant[f] = p;
  }
  // Revocation: a later live Supersedes line naming the block withdraws it; a statement-like
  // Supersedes line after the block that is not live leaves the revocation unknown.
  for (const s of log.statements) {
    if (s.key !== 'Supersedes' || s.line <= block.start) continue;
    if (namesId(s.value, id)) out.push(['D-09', 'violation', id, `the decision block is named by the later live Supersedes: line ${s.line}; the basis is withdrawn`]);
    else if (namesId(s.folded, id)) out.push(['D-09', 'malformed', id, `line ${s.line} names the basis in a disguised form: revocation unknown`]);
  }
  for (const a of log.ambiguous) if (a.key === 'supersedes' && a.line > block.start && namesId(a.text, id)) out.push(['D-09', 'malformed', id, `line ${a.line} may withdraw the basis but is not a live statement: revocation unknown`]);
  if (out.length) return { out };
  // Containment: the record may only narrow the owner's grant, and the path side of it is judged
  // by the same real path on both sides: both spellings of an existing
  // directory resolve to one real path; a not-yet-existing tail is compared case-insensitively on
  // Windows and exactly on POSIX, because there the spellings are different paths. A scope or
  // excluded path that cannot be read is unknown (never a pass, never a missing component); one
  // through a link or outside the root covers nothing at check time, so containment skips it.
  const widen = message => out.push(['D-10', 'violation', id, message]);
  const fold = process.platform === 'win32';
  const realItem = item => {
    const c = canonical(root, item);
    if (c.unknown) return { unknown: c.unknown };
    if (c.outside || c.link) return { unusable: true };
    return { item: { dir: item.dir, body: c.rel } };
  };
  const recScope = new Map(rec.scope.map(s => [s, realItem(s)]));
  const grantScope = new Map(grant['scope-paths'].map(g => [g, realItem(g)]));
  for (const [item, r] of [...recScope, ...grantScope]) {
    if (r.unknown) malformed(`path ${item.text} cannot be resolved (${r.unknown}): containment is unknown`);
  }
  for (const x of [...grant.excluded, ...rec.excluded]) {
    const c = canonical(root, x);
    if (c.unknown) malformed(`excluded path ${x.text} cannot be resolved (${c.unknown})`);
  }
  if (out.length) return { out };
  if (rec.grantee !== grant.grantee) widen(`the grant is for ${grant.grantee}, not ${rec.grantee}`);
  if (rec['scope-id'] !== grant['scope-id']) widen(`the grant is for scope-id ${grant['scope-id']}, not ${rec['scope-id']}`);
  for (const v of rec.verbs) if (!grant.verbs.includes(v)) widen(`verb ${v} is not in the grant`);
  for (const s of rec.scope) {
    const cs = recScope.get(s);
    if (cs.unusable) continue;
    const covered = grant['scope-paths'].some(g => {
      const cg = grantScope.get(g);
      return Boolean(cg) && !cg.unusable && within(cs.item, cg.item, fold);
    });
    if (!covered) widen(`scope path ${s.text} lies outside the grant`);
    for (const x of grant.excluded) {
      if (withinExcluded(s, x)) widen(`scope path ${s.text} lies inside ${x.text}, which the grant excludes`);
      else if (withinExcluded(x, s) && !rec.excluded.some(e => withinExcluded(x, e))) widen(`the grant excludes ${x.text} inside ${s.text}; the record must exclude it too`);
    }
  }
  if (rec.end > untilEnd(grant.until)) widen(`until ${rec.until} is later than the grant's ${grant.until}`);
  if (rec.start < from) widen(`date-utc is before the decision Date ${date}`);
  return { out, grant: { ...grant, from, end: untilEnd(grant.until) } };
}

// ---- lint ----

function lint(file, root) {
  const findings = [];
  const push = (code, cls, line, value, message) => findings.push({ code, cls, line, value: String(value), message });
  const text = readText(file, push, root);
  const records = [];
  if (text === null) return { findings, records };
  const { blocks, broken } = scanFences(text.split('\n'), push);
  if (broken) return { findings, records };
  const log = decisionLog(root);
  for (const block of blocks.filter(b => b.info === 'delegation')) {
    const rec = { line: block.start, fields: new Map(), ok: true };
    const bad = (code, cls, line, value, message) => { push(code, cls, line, value, message); rec.ok = false; };
    for (const { text: t, line } of block.content) {
      if (t === '') continue;
      const m = /^([a-z][a-z0-9-]*): (\S(?:.*\S)?)$/.exec(t);
      if (!m) { bad('D-02', 'malformed', line, t.slice(0, 40), 'a line that is not `key: value` (one space, no padding)'); continue; }
      if (!FIELDS.includes(m[1])) { bad('D-02', 'malformed', line, m[1], 'unknown field outside the closed set of nine'); continue; }
      if (rec.fields.has(m[1])) { bad('D-03', 'malformed', line, m[1], 'a field appears twice'); continue; }
      rec.fields.set(m[1], { value: m[2], line });
    }
    for (const key of FIELDS) if (!rec.fields.has(key)) bad('D-01', 'violation', block.start, key, `missing required field ${key}`);
    const get = key => (rec.fields.get(key) || {}).value;
    const at = key => (rec.fields.get(key) || {}).line || block.start;
    const id = get('delegation-id');
    if (id !== undefined) { const m = DG_ID.exec(id); if (!m || !validDate(m[1], m[2], m[3])) bad('D-04', 'malformed', at('delegation-id'), id, 'delegation-id must be DG-YYYYMMDD-NN'); }
    const start = get('date-utc') === undefined ? undefined : parseUtc(get('date-utc'));
    if (start === null) bad('D-04', 'malformed', at('date-utc'), get('date-utc'), 'date-utc must be a valid YYYY-MM-DDTHH:MM:SSZ');
    const messages = {
      grantee: 'grantee must be one lowercase token [a-z0-9][a-z0-9._-]{1,63}',
      'scope-id': 'scope-id outside the SCHEMA-assignment grammar kind:name',
      'scope-paths': 'scope-paths items must be repository paths or directory prefixes ending in / (no glob, no .., no absolute form)',
      excluded: 'excluded is none or a list of repository paths or directory prefixes',
      verbs: `verbs must be distinct items of ${VERBS.join(', ')}`,
      until: 'until must be a valid YYYY-MM-DD',
    };
    const parsed = {};
    for (const f of GRANT_FIELDS) {
      if (get(f) === undefined) continue;
      parsed[f] = PARSE[f](get(f));
      if (parsed[f] === null) bad('D-04', 'malformed', at(f), get(f), messages[f]);
    }
    const end = get('until') === undefined ? undefined : untilEnd(get('until'));
    if (get('by') !== undefined && !BLOCK_ID.test(get('by'))) bad('D-04', 'malformed', at('by'), get('by'), 'by must name a decision block PROTO-DEC-nnnn or DEC-nnnn');
    if (typeof start === 'number' && typeof end === 'number' && end < start) bad('D-05', 'violation', at('until'), get('until'), 'until ends before date-utc');
    rec.id = id; rec.start = start; rec.end = end; rec.grantee = get('grantee'); rec['scope-id'] = get('scope-id');
    rec.scope = parsed['scope-paths'] || []; rec.excluded = parsed.excluded || []; rec.verbs = parsed.verbs || [];
    rec.until = get('until'); rec.by = get('by');
    if (rec.ok) {
      const basis = basisFindings(rec, log, root);
      for (const [code, cls, value, message] of basis.out) bad(code, cls, at('by'), value, message);
      rec.grant = basis.grant;
    }
    records.push(rec);
  }
  const seen = new Map();
  for (const r of records) if (r.id) { if (!seen.has(r.id)) seen.set(r.id, []); seen.get(r.id).push(r); }
  for (const [id, list] of seen) if (list.length > 1) for (const r of list) { r.ok = false; push('D-06', 'violation', r.line, id, 'a delegation-id is used by more than one record (ids are never reused)'); }
  return { findings, records };
}

function exitOf(findings) {
  if (findings.some(f => f.cls === 'malformed')) return 2;
  return findings.length ? 1 : 0;
}

// ---- check ----

// The real path of a repository path item through the shared guard (path-safe realInside): every segment below the root is walked with lstat, a link in ANY ancestor is a link, a
// file in the middle of the path and a file-system error other than "does not exist" (EACCES,
// ENOTDIR, ...) are UNKNOWN - never a missing component, and unknown never becomes a pass (F-03).
// Both the requested paths and every scope and excluded item go through this one function, so both
// sides of a comparison are judged by the same real path (F-04). Reasons keep their published
// names: OUTSIDE-ROOT (the real path leaves the root), LINK (link, junction, reparse, hardlink),
// UNKNOWN (everything the guard refuses as unknown).
function canonical(root, item) {
  const r = pathSafe.realInside(root, item.body, { refuseHardlinks: true });
  if (r.ok) return { outside: false, link: false, unknown: null, rel: r.rel, type: r.type, exists: r.exists };
  if (r.reason === 'outside-root' || r.reason === 'is-root') return { outside: true, link: false, unknown: null, rel: null };
  if (r.reason === 'link' || r.reason === 'reparse' || r.reason === 'hardlink') {
    // The guard refuses at the first link without following it; the verdict still has to say
    // OUTSIDE-ROOT when the link's real target leaves the root, and it shows the resolved path
    // when the target stays inside (the row the checker printed before the guard took the walk).
    const probe = resolveThrough(root, item);
    if (probe && probe.outside) return { outside: true, link: false, unknown: null, rel: null };
    return { outside: false, link: true, unknown: null, rel: probe ? probe.rel : null };
  }
  // unreadable (EACCES ...), not-a-directory (a file in the middle), short-name, not-regular and a
  // lexical refusal of the shared grammar: unknown, and unknown never approves.
  return { outside: false, link: false, unknown: r.reason, rel: null };
}
// Where the path really leads when the guard refused it as a link: the deepest existing ancestor
// resolved by realpath (the same walk the checker judged before), the missing tail appended, then
// judged against the root. Nothing to resolve, or a file in the middle: null - still a link or an
// unknown, never a pass.
function resolveThrough(root, item) {
  let realRoot;
  try { realRoot = fs.realpathSync.native(root); } catch { return null; }
  const segs = item.body.split('/');
  let base = null;
  let used = 0;
  for (let k = segs.length; k >= 0; k--) {
    try { base = fs.realpathSync.native(path.join(realRoot, ...segs.slice(0, k))); used = k; break; } catch { /* a shorter prefix */ }
  }
  if (base === null) return null;
  if (used < segs.length) {
    let st;
    try { st = fs.statSync(base); } catch { return null; }
    if (!st.isDirectory()) return null;
  }
  const rel = path.relative(realRoot, path.join(base, ...segs.slice(used)));
  if (rel === '') return { outside: false, rel: '' };
  if (rel.startsWith('..') || path.isAbsolute(rel)) return { outside: true, rel: null };
  return { outside: false, rel: rel.split(path.sep).join('/') };
}
// A scope item covers what is written below it: the bare directory node itself is not granted by a
// trailing-slash prefix. An excluded item covers itself and everything below it, with or without
// the trailing slash - no spelling of the name frees the path.
function coversScope(item, p, insensitive) {
  const a = insensitive ? p.toLowerCase() : p;
  const b = insensitive ? item.body.toLowerCase() : item.body;
  return item.dir ? a.startsWith(`${b}/`) : a === b;
}
function coversExcluded(item, p, insensitive) {
  const a = insensitive ? p.toLowerCase() : p;
  const b = insensitive ? item.body.toLowerCase() : item.body;
  return a === b || a.startsWith(`${b}/`);
}
// A scope item through a link or outside the root covers nothing; an unreadable one is unknown and
// also covers nothing (the caller refuses everything then, unknown never becomes a pass). An
// excluded item excludes both its written form and its real form; an unreadable exclusion makes
// the whole exclusion set unknown - the caller refuses every path then.
function realScope(root, items) {
  const kept = [];
  let unknown = null;
  for (const s of items) {
    const c = canonical(root, s);
    if (c.unknown) { unknown = unknown || c.unknown; continue; }
    if (c.outside || c.link) continue;
    kept.push({ dir: s.dir, body: c.rel });
  }
  return { items: kept, unknown };
}
function realExcluded(root, items) {
  const kept = [];
  let unknown = null;
  for (const x of items) {
    const c = canonical(root, x);
    if (c.unknown) { unknown = unknown || c.unknown; continue; }
    kept.push(x);
    if (!c.outside && c.rel && c.rel !== x.body) kept.push({ dir: x.dir, body: c.rel });
  }
  return { items: kept, unknown };
}

function check(file, opts, root) {
  for (const k of ['grantee', 'scope-id', 'verb', 'at']) if (opts[k] === undefined) throw new InputError(`check needs --${k}`);
  if (!opts.path.length) throw new InputError('check needs at least one --path');
  if (!GRANTEE.test(opts.grantee)) throw new InputError('--grantee outside the grantee grammar');
  if (!SCOPE_ID.test(opts['scope-id'])) throw new InputError('--scope-id outside the SCHEMA-assignment grammar');
  if (!VERBS.includes(opts.verb)) throw new InputError(`--verb must be one of ${VERBS.join(', ')}`);
  const at = parseUtc(opts.at);
  if (at === null) throw new InputError('--at must be a valid YYYY-MM-DDTHH:MM:SSZ');
  const items = opts.path.map(p => ({ raw: p, item: pathItem(p.replace(/\\/g, '/').replace(/^\.\//, '')) }));
  const badPath = items.find(x => x.item === null || x.item.dir);
  if (badPath) throw new InputError(`--path ${JSON.stringify(badPath.raw)} is not a repository file path`);
  // A --path names a repository file, positively: an existing object
  // that is a directory is not a file path, in any spelling. The trailing-slash form is already
  // refused by the grammar above; this closes the bare one. A move or delete of a directory acts
  // on the whole subtree, so an excluded path under it would move or vanish with it - the checker
  // authorises file effects only, and a rename must name its source (this check) and its target.
  // The type comes from the same real path as every later comparison (path-safe realInside).
  for (const { raw, item } of items) {
    const c = canonical(root, item);
    if (c.type === 'dir') throw new InputError(`--path ${JSON.stringify(raw)} names an existing directory, not a repository file path`);
  }

  const { findings, records } = lint(file, root);
  const rows = findings.map(f => `FINDING code=${f.code} cls=${f.cls} line=${f.line} value=${JSON.stringify(f.value)}`);
  if (exitOf(findings) === 2) return { exit: 2, rows: [...rows, 'ERROR reason="the delegation file is malformed; no access decision is made on it"'] };
  for (const r of records.filter(x => !x.ok)) rows.push(`IGNORED delegation=${r.id || '-'} line=${r.line} reason=record-has-findings`);
  const usable = records.filter(r => r.ok && r.grant);
  const forGrantee = usable.filter(r => r.grantee === opts.grantee);
  const forScope = forGrantee.filter(r => r['scope-id'] === opts['scope-id']);
  const candidates = forScope.filter(r => r.verbs.includes(opts.verb) && r.grant.verbs.includes(opts.verb));
  const timely = candidates.filter(r => Math.max(r.start, r.grant.from) <= at && at <= Math.min(r.end, r.grant.end));
  // Every exclusion of a holding record of this grantee and scope, and of its grant, applies. When
  // any of them cannot be read the whole set is unknown: no path is allowed then.
  const excluded = realExcluded(root, forScope.filter(r => r.start <= at && at <= r.end).flatMap(r => [...r.excluded, ...r.grant.excluded]));
  const scopes = new Map(timely.map(r => {
    const own = realScope(root, r.scope);
    const grant = realScope(root, r.grant['scope-paths']);
    return [r, { own: own.items, grant: grant.items, unknown: own.unknown || grant.unknown }];
  }));
  const guardUnknown = excluded.unknown || [...scopes.values()].some(s => s.unknown);
  // One real path on both sides (F-04): on Windows the not-yet-existing tail of the request keeps
  // its spelling while the scope took the true case from realpath, so the comparison folds case
  // there; on POSIX the spellings are different paths and the comparison stays exact.
  const fold = process.platform === 'win32';
  let allow = true;
  for (const { raw, item } of items) {
    const c = canonical(root, item);
    // Re-apply the closed file-type rule at the point of decision: realInside can correctly observe a newly appeared directory here.
    if (c.type === 'dir') throw new InputError(`--path ${JSON.stringify(raw)} names an existing directory, not a repository file path`);
    let verdict = 'REFUSE';
    let reason;
    let by = '-';
    if (c.unknown) reason = 'UNKNOWN';
    else if (c.outside) reason = 'OUTSIDE-ROOT';
    else if (c.link) reason = 'LINK';
    else if (!['file', 'missing'].includes(c.type) || guardUnknown) reason = 'UNKNOWN';
    else if (excluded.items.some(s => coversExcluded(s, c.rel, true) || coversExcluded(s, item.body, true))) reason = 'EXCLUDED';
    else {
      const hit = timely.find(r => scopes.get(r).own.some(s => coversScope(s, c.rel, fold)) && scopes.get(r).grant.some(s => coversScope(s, c.rel, fold)));
      if (hit) { verdict = 'ALLOW'; reason = 'COVERED'; by = hit.id; }
      else if (!forGrantee.length) reason = 'NO-DELEGATION';
      else if (!forScope.length) reason = 'SCOPE-ID-MISMATCH';
      else if (!candidates.length) reason = 'VERB-NOT-GRANTED';
      else if (!timely.length) reason = candidates.every(r => at < Math.max(r.start, r.grant.from)) ? 'NOT-YET-VALID' : 'EXPIRED';
      else reason = 'OUT-OF-SCOPE';
    }
    if (verdict !== 'ALLOW') allow = false;
    const canon = !c.outside && !c.unknown && c.rel && c.rel !== item.body ? ` canonical=${JSON.stringify(c.rel)}` : '';
    rows.push(`DECISION path=${JSON.stringify(raw)}${canon} verdict=${verdict} reason=${reason} delegation=${by}`);
  }
  return { exit: allow ? 0 : 1, rows, verdict: allow ? 'ALLOW' : 'REFUSE', paths: items.length };
}

// K2 action interface, advisory until S6-L8-ACT and the integration act. A digest
// binds a checker result to one operation and snapshots, not to an authenticated
// writer. No action, backup, journal append, or external path is performed here.
function operationBinding(opts) {
  const keys = ['grantee', 'scope-id', 'verb', 'at', 'path'];
  if (!opts || Object.keys(opts).some(k => !keys.includes(k)) || keys.some(k => !Object.hasOwn(opts, k))
      || !GRANTEE.test(opts.grantee) || !SCOPE_ID.test(opts['scope-id']) || !VERBS.includes(opts.verb)
      || parseUtc(opts.at) === null || !Array.isArray(opts.path) || !opts.path.length
      || opts.path.some(p => typeof p !== 'string' || !pathItem(p) || pathItem(p).dir)
      || new Set(opts.path).size !== opts.path.length) throw new Error('operation-invalid');
  return { grantee: opts.grantee, scopeId: opts['scope-id'], verb: opts.verb, paths: opts.path.slice().sort() };
}
const operationHash = value => require('node:crypto').createHash('sha256').update(JSON.stringify(value)).digest('hex');
function operationInputs(file, binding, root) {
  const names = [file, '.ai/DECISIONS.md', '.ai/docs/owners.json', ...binding.paths];
  const repository = pathSafe.realInside(root, root, { allowRoot: true });
  if (!repository.ok) throw new Error('operation-root-unverified');
  const rootStat = fs.statSync(repository.real, { bigint: true });
  const rootIdentity = operationHash([repository.real, String(rootStat.dev), String(rootStat.ino)]);
  return [['repository', rootIdentity], ...names.map((name, index) => {
    // The shared path/read guards close the read race and refuse link ancestors.
    const g = pathSafe.realInside(root, name, { refuseHardlinks: true });
    if (!g.ok || !['file', 'missing'].includes(g.type) || index < 3 && !g.exists) throw new Error('operation-input-unverified');
    if (!g.exists) return [g.rel, 'missing'];
    const read = pathSafe.readFileGuarded(root, name);
    if (!read.ok) throw new Error('operation-input-unverified');
    return [g.rel, require('node:crypto').createHash('sha256').update(read.bytes).digest('hex')];
  })];
}
function planOperation(file, opts, root) {
  const base = { mode: 'advisory', authenticated: false, execute: false };
  try {
    const binding = operationBinding(opts);
    const before = operationHash(operationInputs(file, binding, root));
    const checked = check(file, opts, root);
    const after = operationHash(operationInputs(file, binding, root));
    if (before !== after) return { ...base, status: 'blocked', reason: 'operation-input-changed' };
    if (checked.exit !== 0 || checked.verdict !== 'ALLOW') return { ...base, status: 'blocked', reason: 'delegation-refused' };
    return { ...base, status: 'ready', reason: 'checker-allow-only', bindingHash: operationHash(binding), inputHash: after, checkedAt: opts.at };
  } catch { return { ...base, status: 'blocked', reason: 'operation-input-unverified' }; }
}
function recheckOperation(prior, file, opts, root) {
  const next = planOperation(file, opts, root);
  if (next.status !== 'ready') return next;
  if (!prior || prior.mode !== 'advisory' || prior.status !== 'ready' || prior.authenticated !== false || prior.execute !== false
      || prior.bindingHash !== next.bindingHash || prior.inputHash !== next.inputHash) {
    return { mode: 'advisory', authenticated: false, execute: false, status: 'blocked', reason: 'operation-plan-changed' };
  }
  return next;
}

// ---- command line ----

function parseArgs(argv) {
  const [command, file, ...rest] = argv;
  if (!['lint', 'check'].includes(command)) throw new InputError('usage: protocol-delegation.cjs lint|check <file> [options]');
  if (!file || file.startsWith('--')) throw new InputError(`${command} needs a delegation file`);
  const opts = { path: [] };
  const allowed = command === 'lint' ? ['root'] : ['root', 'grantee', 'scope-id', 'verb', 'path', 'at'];
  for (let i = 0; i < rest.length; i += 2) {
    const flag = rest[i];
    const value = rest[i + 1];
    const name = typeof flag === 'string' && flag.startsWith('--') ? flag.slice(2) : null;
    if (!name || !allowed.includes(name)) throw new InputError(`unknown option ${flag}`);
    if (value === undefined || value.startsWith('--')) throw new InputError(`option ${flag} needs a value`);
    if (name === 'path') opts.path.push(value);
    else if (opts[name] !== undefined) throw new InputError(`option ${flag} given twice`);
    else opts[name] = value;
  }
  return { command, file, opts };
}

function main(argv) {
  const out = [];
  let exit;
  try {
    const { command, file, opts } = parseArgs(argv);
    const root = path.resolve(opts.root || process.cwd());
    const abs = path.resolve(file);
    if (command === 'lint') {
      const { findings, records } = lint(abs, root);
      for (const f of findings) out.push(`FINDING code=${f.code} cls=${f.cls} line=${f.line} value=${JSON.stringify(f.value)} message=${JSON.stringify(f.message)}`);
      exit = exitOf(findings);
      out.push(`RESULT exit=${exit} records=${records.length} findings=${findings.length} malformed=${findings.filter(f => f.cls === 'malformed').length}`);
    } else {
      const r = check(abs, opts, root);
      out.push(...r.rows);
      exit = r.exit;
      out.push(r.verdict ? `RESULT exit=${exit} verdict=${r.verdict} paths=${r.paths}` : `RESULT exit=${exit}`);
    }
  } catch (err) {
    if (!(err instanceof InputError)) throw err;
    out.push(`ERROR reason=${JSON.stringify(err.message)}`, 'RESULT exit=2');
    exit = 2;
  }
  process.stdout.write(`${out.join('\n')}\n`);
  return exit;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { planOperation, recheckOperation, lint, check, main, readStatements, FIELDS, VERBS };

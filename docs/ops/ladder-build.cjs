'use strict';
// ladder-build: builds docs/ops/model-ladder.json (schema ladder/2) from evidence, never from memory (PROTO-DEC-0058):
//   - the tier table, the rank lines and the maker sections of the model matrix .ai/core/L3-tools/trial/MODEL-MATRIX.md
//     (P-L3-002/003; every row cites the line of its tier cell and of its rank line, and the matrix run date). A maker section may
//     carry `- Evidence date: YYYY-MM-DD` (its rows then carry that date) and `Withheld: T7, T8, T9 (reason)`: the tier cells of the
//     maker that are empty on purpose (a stated unknown or an undecided floor); the empty cells and the Withheld line must agree.
//     A maker that is not one of the eight of the first run must carry `- Rank basis: none | repeat-rule (<n> reachable models) |
//     vendor-positioning <url or `command`> <date>` (P-L3-003 R-L3-003.1/.5): with `none` it has no Ranks line and no tier cell;
//     every date is a real calendar date. Statements are read only from lines of a closed grammar; the matrix holds no fenced,
//     HTML, comment, quote or indented block except the provenance comment on line 1 (see SECTION_LINE and blockShape);
//   - the client registry .ai/docs/clients.json (the client route, its model list, its effort rule and its verification date; the
//     `makers` of a client's models, from which the reachable models of a maker are counted: see checkReachable);
//   - the host history docs/ops/model-ladder-history.json supplies the `source` block, compatibility rungs and approval flags.
//   - the explicit cross-maker order per task class (data the owner or the operator supplies with its source and date). By default
//     the pointer docs/ops/host-maker-order.json ({"schema":"maker-order-pointer/1","current":"<dated maker-order/1 file>"}) names
//     it, so plan, write and check build the same ladder without a flag; --maker-order FILE overrides it for one run. Both files
//     must be inside the repository (the ladder is rebuilt from tracked files). A new order is a new dated file, kept, plus a
//     one-line change of `current`. Without the pointer `makerOrder` stays empty: the resolver then never compares makers
//     and asks the owner. `check` is the guard of the order file: the resolver's staleness check (registry.cjs) hashes the
//     matrix, the registry and the history but not the order, so an order edited without a rebuild is caught by `check` only.
// Every file it reads or writes in the repository (the inputs above, the pointer, the order file, the ladder) passes repoPath:
// physically inside the repository, no link, hard link or alternate data stream on the way (see repoPath).
// It reads NO layer data (PROTO-DEC-0143 item 3): no benchmark catalog, model class registry, score or price table. Unknown stays null.
//   node docs/ops/ladder-build.cjs plan [--maker-order FILE] [--repo DIR]           print the rows and the sha256 of the file it would write
//   node docs/ops/ladder-build.cjs write --expect-sha SHA [--maker-order FILE] [--repo DIR]   write it only when its sha256 is SHA
//   node docs/ops/ladder-build.cjs check [--maker-order FILE] [--repo DIR]            exit 0 when docs/ops/model-ladder.json is what plan builds
// Exit: 0 ok; 1 check found a difference or write was refused (sha mismatch); 2 usage or unreadable/contradictory evidence.
const fs = require('node:fs');
const path = require('node:path');
const realPath = require('../../.ai/bin/lib/real-path.cjs');
const crypto = require('node:crypto');
const { clientsProjection } = require('../../.ai/bin/protocol-dispatch/registry.cjs');

const MATRIX = '.ai/core/L3-tools/trial/MODEL-MATRIX.md';
const CLIENTS = '.ai/docs/clients.json';
const HISTORY = 'docs/ops/model-ladder-history.json';
const OUT = 'docs/ops/model-ladder.json';
const MAKER_ORDER = 'docs/ops/host-maker-order.json'; // the default: a pointer to the dated maker-order/1 file in force
const RANK_OF_TIER = t => (t <= 3 ? 'workhorse' : t <= 6 ? 'second' : 'flagship'); // PROTO-DEC-0059, P-L2-002 tier table
const TASK_CLASSES = ['T1', 'T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'T8', 'T9'];

// The eight makers of the first matrix run (2026-09-24): their sections cite the provider's own pages and prices line by line. Every
// other maker section is new and must declare its `Rank basis`: the set is closed here.
const LEGACY_MAKERS = new Set(['Anthropic', 'OpenAI', 'Google', 'DeepSeek', 'Mistral', 'xAI', 'Moonshot', 'Microsoft']);
const WITHHELD_ALL = [1, 2, 3, 4, 5, 6, 7, 8, 9];

class BuildError extends Error { constructor(msg) { super(msg); this.code = 'BUILD'; } }
const trimAscii = s => String(s).replace(/^[ 	]+|[ 	]+$/g, '');
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
// YYYY-MM-DD with a real month and day (2026-13-45 and 2026-02-30 are refused; the year range keeps the check to this century)
function isCalendarDate(s) {
  const m = typeof s === 'string' ? s.match(/^(\d{4})-(\d{2})-(\d{2})$/) : null;
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2099) return false;
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}
// `- Rank basis: ...`: the only grammar by which a new maker section may state why its ranks (and so its tier cells) exist.
//   none                                              no rank is settled; the section carries no `Ranks:` line and no tier cell
//   repeat-rule (<n> reachable model[s])              P-L3-003 R-L3-003.5: fewer than three reachable models repeat; n must be the models table
//   vendor-positioning <https URL | `command`> <date> the provider's own positioning or price (R-L3-003.1), recorded with source and date
// Internal roles, certification outcomes and the use history of a model are not a basis: there is no word for them.
function parseRankBasis(text) {
  const t = trimAscii(text);
  if (t === 'none' || /^none \(.*\)$/.test(t)) return { kind: 'none' };
  let m = t.match(/^repeat-rule \((\d+) reachable models?\)$/);
  if (m) return { kind: 'repeat-rule', n: Number(m[1]) };
  m = t.match(/^vendor-positioning (https:\/\/[^\s`]+|`[^`\n]+`) (\d{4}-\d{2}-\d{2})$/);
  if (m && isCalendarDate(m[2])) return { kind: 'vendor-positioning', ref: m[1], date: m[2] };
  return null;
}
// JSON.parse keeps the last of two equal keys, so a duplicate key anywhere in a JSON file the generator reads would silently
// drop the first value before validation. firstDuplicateKey walks the raw text like a JSON parser: strings, escapes and
// nested objects and arrays. It names the first key repeated in an object, or returns null.
// Duplicate keys inside a `makers` map are refused.
// nesting of objects and arrays) and names the first key that appears twice in one object; null when there is none.
function firstDuplicateKey(text) {
  const s = String(text);
  const stack = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '{') { stack.push(new Set()); i++; continue; }
    if (c === '[') { stack.push(null); i++; continue; }
    if (c === '}' || c === ']') { stack.pop(); i++; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      const raw = s.slice(i, j + 1);
      i = j + 1;
      let k = i;
      while (k < s.length && /\s/.test(s[k])) k++;
      const keys = stack[stack.length - 1];
      if (keys && s[k] === ':') {
        let key;
        try { key = JSON.parse(raw); } catch { return raw; }
        if (keys.has(key)) return key;
        keys.add(key);
        i = k + 1;
      }
      continue;
    }
    i++;
  }
  return null;
}
// every JSON file the generator reads is parsed through here: a duplicate key is refused before JSON.parse can keep the last
function parseJsonNoDuplicates(buf, what) {
  const text = buf.toString('utf8');
  const dup = firstDuplicateKey(text);
  if (dup !== null) throw new BuildError(`${what}: the key "${dup}" appears twice in one object: JSON.parse would keep the last and lose the first, so a duplicate key is refused`);
  try { return JSON.parse(text); } catch { throw new BuildError(`${what} is not valid JSON`); }
}
// `Ranks:`: the exact, positive shape of a rank
// statement. The whole rank paragraph (the Ranks line plus its paragraph continuation lines, joined by one space) must be
// exactly one of the two closed forms, with an optional trailing remark that is one parenthetical holding no parenthesis,
// asterisk, backtick or backslash of its own:
//   Ranks: **flagship <id>**, **second <id>**, **workhorse <id>** [(<remark>)]   three models, in this closed order
//   Ranks: [one reachable model, so ]**<text>** fills all three [(<remark>)]     one model fills all three; its id is the
//                                                                                first word of the bold text (deepseek-flash 4.1)
// Everything else is refused, never reinterpreted: an escaped bold (`\**`), an HTML entity (`&ast;`), an asterisk lookalike,
// the words `fills all three` inside a code span, a bold word smuggled into the remark (it could not overwrite a rank before)
// and a plain sentence in place of the remark all make parseRanksParagraph answer null and the build refuse the section.
const RANKS_REMARK = '(?: \\([^()`*\\\\]*\\))?\\.?';
const RANKS_ID = String.raw`[A-Za-z0-9][A-Za-z0-9./-]*`;
const RANKS_THREE = new RegExp(`^Ranks: \\*\\*flagship (${RANKS_ID})\\*\\*, \\*\\*second (${RANKS_ID})\\*\\*, \\*\\*workhorse (${RANKS_ID})\\*\\*${RANKS_REMARK}$`);
const RANKS_FILLS = new RegExp(`^Ranks: (?:one reachable model, so )?\\*\\*([A-Za-z0-9][A-Za-z0-9./ -]*)\\*\\* fills all three${RANKS_REMARK}$`);
function parseRanksParagraph(text2) {
  const t = String(text2);
  let m = t.match(RANKS_THREE);
  if (m) return { flagship: { id: m[1], text: m[1] }, second: { id: m[2], text: m[2] }, workhorse: { id: m[3], text: m[3] } };
  m = t.match(RANKS_FILLS);
  if (m) {
    const text = m[1].trim();
    const r = { id: text.split(/\s+/)[0], text };
    return { flagship: r, second: r, workhorse: r };
  }
  return null;
}
const tokens = s => String(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
const norm = s => String(s).toLowerCase().replace(/^.*\//, '').replace(/\./g, '-');

// ---- the line grammar of the matrix ----
// The generator takes its statements only from lines whose shape it knows. A line inside a fenced block, an HTML block or comment, a
// block quote or an indented code block is not a statement of the document, and the matrix holds none of them; the one exception is
// fixed and positive: the provenance comment that opens the file on line 1. So there is no block a statement could hide in.
//   Whole file: no byte order mark; CRLF is read as LF and any other CR is refused. After the opening comment no line opens or closes a
//   fence (three or more backticks or tildes, at any indentation), opens an HTML block (first non-blank character `<` followed by a
//   letter, `/`, `!` or `?`), holds `<!--` or `-->`, is a block quote (`>`), a Setext underline or thematic break (only `=` or only
//   `-`; front matter is refused by the same rule) or an indented heading.
//   Maker sections (`### <Maker> — ...` up to the next `##` or `###` heading) and the section of the tier table: every line, at column 0,
//   is one of SECTION_LINE: empty; a table row `|...|`; a bullet `- <text>`; a paragraph line starting with a letter or `(`. A table
//   and a `Ranks:` or `Withheld:` line start after an empty line, a table's second row is its delimiter row, a section holds one table.
//   Inside such a line: no tab, no no-break or other Unicode space, no zero-width, bidi, soft hyphen or control character
//   (SECTION_BAD_CHAR); backticks pair up on the line (no code span crosses a line); outside code spans no `<` that opens a tag, a
//   comment or an autolink, and no `[` or `]` (a link title or a reference definition is text that is not shown as written).
const SECTION_LINE = /^(?:|\|.*\||- \S.*|[A-Za-z(].*)$/;
// code points refused in a section line: tab and the other ASCII controls except LF, DEL and extended controls, no-break space, soft hyphen, the Ogham and
// Mongolian spaces, the spaces, zero-width and direction marks U+2000-U+200F, the line and paragraph separators, bidi embeddings and the
// narrow no-break space U+2028-U+202F, U+205F-U+206F, the ideographic space, the byte order mark
const BAD_RANGES = [[0x00, 0x08], [0x09, 0x09], [0x0b, 0x1f], [0x7f, 0x9f], [0xa0, 0xa0], [0xad, 0xad], [0x1680, 0x1680], [0x180e, 0x180e], [0x2000, 0x200f], [0x2028, 0x202f], [0x205f, 0x206f], [0x3000, 0x3000], [0xfeff, 0xfeff]];
const SECTION_BAD_CHAR = new RegExp(`[${BAD_RANGES.map(([a, b]) => String.fromCharCode(a) + (b > a ? `-${String.fromCharCode(b)}` : '')).join('')}]`);
const DELIMITER_ROW = /^\|(?: *:?-{3,}:? *\|)+$/;
const PARAGRAPH = /^[A-Za-z(]/;
const withoutCodeSpans = l => l.replace(/`[^`]*`/g, '');
// whole-file shapes that open, close or are a block whose lines are not statements; returns the reason or null
function blockShape(l) {
  if (/^\s*(`{3,}|~{3,})/.test(l)) return 'a fence of a code block';
  if (/^\s*<[A-Za-z!/?]/.test(l)) return 'an HTML block';
  if (l.includes('<!--') || l.includes('-->')) return 'an HTML comment';
  if (/^\s*>/.test(l)) return 'a block quote';
  if (/^\s*(=+|-+)\s*$/.test(l)) return 'a Setext underline, a thematic break or front matter';
  if (/^\s+#/.test(l)) return 'an indented heading';
  return null;
}
// the shape of one line of a maker section or of the tier table section; returns the reason it is refused or null
function sectionLineProblem(l) {
  if (SECTION_BAD_CHAR.test(l)) return 'a tab, a no-break or other Unicode space, or an invisible or control character';
  if (!SECTION_LINE.test(l)) return 'a line shape outside the grammar (empty, |table row|, "- " bullet, or a paragraph line starting with a letter or "(", at column 0)';
  if (/`{3,}|~{3,}/.test(l)) return 'a fence marker inside the line (a list item may open a code block)';
  if ((l.match(/`/g) || []).length % 2) return 'an unpaired backtick (a code span may not cross a line)';
  const bare = withoutCodeSpans(l);
  if (/<[A-Za-z!/?]/.test(bare)) return 'inline HTML, an HTML comment or an autolink';
  if (/[[\]]/.test(bare)) return 'a link (its title or target is not shown as written)';
  return null;
}

// ---- model matrix ----
function parseMatrix(text, rel = MATRIX) {
  if (text.startsWith('\ufeff')) throw new BuildError(`matrix: ${rel} starts with a byte order mark (tracked text is UTF-8 without BOM)`);
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const cite = i => `${rel}:${i + 1}`;
  const cr = lines.findIndex(l => l.includes('\r'));
  if (cr >= 0) throw new BuildError(`matrix: ${cite(cr)} holds a carriage return that does not end a CRLF line`);
  // the provenance comment on line 1 is the only block the file may hold; its lines are not read
  let first = 0;
  if (lines[0].startsWith('<!--')) {
    const end = lines.findIndex(l => l.includes('-->'));
    if (end < 0 || !lines[end].endsWith('-->') || lines[end].indexOf('-->') !== lines[end].length - 3) throw new BuildError(`matrix: the opening comment of ${rel} must close at the end of a line with -->`);
    for (let i = 0; i <= end; i++) if (lines[i].indexOf('<!--', i === 0 ? 4 : 0) >= 0) throw new BuildError(`matrix: the opening comment of ${rel} holds another <!-- (${cite(i)})`);
    first = end + 1;
  }
  for (let i = first; i < lines.length; i++) {
    const why = blockShape(lines[i]);
    if (why) throw new BuildError(`matrix: ${cite(i)} is ${why}: the matrix holds no block whose lines are not its statements (only the provenance comment on line 1)`);
  }
  // the run date: one line, before the first `## ` heading
  const produced = [];
  for (let i = first; i < lines.length; i++) if (/^- Produced by .* on \d{4}-\d{2}-\d{2}/.test(lines[i])) produced.push(i);
  if (!produced.length) throw new BuildError('matrix: no "Produced by ... on <date>" line');
  if (produced.length > 1) throw new BuildError(`matrix: two "Produced by ... on <date>" lines (${produced.map(cite).join(', ')}): the run date is unknown`);
  const dateLine = produced[0];
  const firstH2 = lines.findIndex((l, i) => i >= first && /^## /.test(l));
  if (firstH2 >= 0 && dateLine > firstH2) throw new BuildError(`matrix: the "Produced by" line ${cite(dateLine)} is not in the head of the file (before ${cite(firstH2)})`);
  const date = lines[dateLine].match(/on (\d{4}-\d{2}-\d{2})/)[1];
  if (!isCalendarDate(date)) throw new BuildError(`matrix: the run date "${date}" (${cite(dateLine)}) is not a calendar date`);
  const tierHeads = [];
  for (let i = first; i < lines.length; i++) if (/^\| Maker \(client\) \| T1 \|/.test(lines[i])) tierHeads.push(i);
  if (tierHeads.length > 1) throw new BuildError(`matrix: two tier table headers (${tierHeads.map(cite).join(', ')})`);
  const tierHead = tierHeads.length ? tierHeads[0] : -1;
  const makers = {};
  let current = null;
  let tierSection = false;
  for (let i = first; i < lines.length; i++) {
    const l = lines[i];
    const h = l.match(/^### (\S+) — /);
    if (h) {
      if (makers[h[1]]) throw new BuildError(`matrix: two sections of ${h[1]} (${makers[h[1]].heading}, ${cite(i)})`);
      current = makers[h[1]] = { maker: h[1], heading: cite(i), models: [], table: null, ranks: null, rankLine: null, date: null, dateLine: null, withheld: new Set(), withheldLine: null, basis: null, basisLine: null };
      tierSection = false; continue;
    }
    if (/^## /.test(l)) {
      current = null;
      // the section of the tier table runs from its `## ` heading to the next one
      tierSection = tierHead > i && !lines.slice(i + 1, tierHead).some(x => /^## /.test(x));
      continue;
    }
    if (!current && !tierSection) continue;
    const why = sectionLineProblem(l);
    const owner = current ? `section of ${current.maker}` : 'the tier table section';
    if (why) throw new BuildError(`matrix: ${owner} (${cite(i)}) holds ${why}: its statements must be plain lines`);
    if (!current) continue;
    const afterBlank = i > 0 && lines[i - 1] === '';
    // the models table: header row after an empty line, then its delimiter row, then one row per model; one table per section
    if (l.startsWith('|')) {
      if (!current.table) {
        if (!afterBlank) throw new BuildError(`matrix: the table of ${current.maker} (${cite(i)}) does not start after an empty line`);
        if (!DELIMITER_ROW.test(lines[i + 1] || '')) throw new BuildError(`matrix: the table of ${current.maker} (${cite(i)}) has no delimiter row under its header`);
        current.table = { start: i, end: null }; i++; continue;
      }
      if (current.table.end !== null) throw new BuildError(`matrix: section of ${current.maker} holds a second table (${cite(i)}): one models table per section`);
      if (DELIMITER_ROW.test(l)) throw new BuildError(`matrix: the table of ${current.maker} holds a second delimiter row (${cite(i)})`);
      const cell = l.split('|')[1].trim();
      for (const part of cell.split(',')) {
        const id = part.replace(/\(.*?\)/g, '').trim();
        if (id) current.models.push({ id, line: cite(i) });
      }
      continue;
    }
    if (current.table && current.table.end === null) current.table.end = i;
    if (/^(Ranks|Withheld):/.test(l) && !afterBlank) throw new BuildError(`matrix: ${l.slice(0, l.indexOf(':'))} line of ${current.maker} (${cite(i)}) does not start after an empty line (it would continue the paragraph above)`);
    // `- Evidence date: YYYY-MM-DD`: a section that was written after the matrix run carries the date of its own evidence
    const ed = l.match(/^- Evidence date: (.*)$/);
    if (ed) {
      if (!isCalendarDate(trimAscii(ed[1]))) throw new BuildError(`matrix: Evidence date "${trimAscii(ed[1])}" of ${current.maker} (${cite(i)}) is not a calendar date YYYY-MM-DD`);
      if (current.dateLine) throw new BuildError(`matrix: ${current.maker} carries two Evidence date lines (${current.dateLine}, ${cite(i)})`);
      current.date = trimAscii(ed[1]); current.dateLine = cite(i); continue;
    }
    // `- Rank basis: ...` (see parseRankBasis): one line, one value, a closed grammar
    const rb = l.match(/^- Rank basis: (.*)$/);
    if (rb) {
      if (current.basisLine) throw new BuildError(`matrix: ${current.maker} carries two Rank basis lines (${current.basisLine}, ${cite(i)})`);
      const basis = parseRankBasis(rb[1]);
      if (!basis) throw new BuildError(`matrix: Rank basis "${rb[1].trim()}" of ${current.maker} (${cite(i)}) is not none, repeat-rule (<n> reachable models) or vendor-positioning <https URL or a command in backticks> <date>`);
      current.basis = basis; current.basisLine = cite(i); continue;
    }
    // `Withheld: T7, T8, T9 (reason)`: the tier cells of this maker that are deliberately empty; the words in parentheses are the reason
    if (/^Withheld:/.test(l)) {
      const named = l.slice('Withheld:'.length).replace(/\(.*?\)/g, ' ');
      for (const m of named.matchAll(/\bT(\d+)(?:\s*-\s*T?(\d+))?\b/g)) {
        const lo = Number(m[1]); const hi = m[2] ? Number(m[2]) : lo;
        for (const n of [lo, hi]) if (n < 1 || n > 9) throw new BuildError(`matrix: Withheld line of ${current.maker} (${cite(i)}) names T${n}, which is not a tier T1-T9`);
        for (let n = lo; n <= hi; n++) current.withheld.add(n);
      }
      if (current.withheldLine) throw new BuildError(`matrix: ${current.maker} carries two Withheld lines (${current.withheldLine}, ${cite(i)})`);
      current.withheldLine = cite(i); continue;
    }
    if (/^Ranks:/.test(l)) {
      // the paragraph of the rank line: its own continuation lines only (a bullet, a table or another statement ends it).
      // The rank statement is read from the CLOSED grammar of parseRanksParagraph: anything that is not
      // exactly one of the two forms is refused, never reinterpreted from bold shapes found anywhere in the paragraph.
      let text2 = l; for (let j = i + 1; j < lines.length && PARAGRAPH.test(lines[j]) && !/^(Ranks|Withheld):/.test(lines[j]); j++) text2 += ` ${lines[j]}`;
      const ranks = parseRanksParagraph(text2);
      if (!ranks) throw new BuildError(`matrix: rank line ${cite(i)} does not settle all three ranks: it is not "Ranks: **flagship <id>**, **second <id>**, **workhorse <id>**" or "Ranks: [one reachable model, so ]**<id>** fills all three" (an optional parenthetical remark may follow)`);
      if (current.rankLine) throw new BuildError(`matrix: ${current.maker} carries two Ranks lines (${current.rankLine}, ${cite(i)})`);
      current.ranks = ranks; current.rankLine = cite(i);
    }
  }
  // a new maker section states its basis, and the basis agrees with what the section holds
  for (const m of Object.values(makers)) {
    if (!m.basis) {
      if (!LEGACY_MAKERS.has(m.maker)) throw new BuildError(`matrix: section of ${m.maker} (${m.heading}) has no "- Rank basis:" line (only the eight makers of the first run may omit it)`);
      continue;
    }
    const where = `${m.maker} (${m.basisLine})`;
    if (m.basis.kind === 'none') {
      if (m.ranks) throw new BuildError(`matrix: Rank basis of ${where} is none but the section states ranks (${m.rankLine})`);
      const missing = WITHHELD_ALL.filter(n => !m.withheld.has(n));
      if (missing.length) throw new BuildError(`matrix: Rank basis of ${where} is none, so its Withheld line must name T1-T9 (missing T${missing.join(', T')})`);
      continue;
    }
    if (!m.ranks) throw new BuildError(`matrix: Rank basis of ${where} is ${m.basis.kind} but the section has no Ranks line`);
    if (m.basis.kind === 'repeat-rule') {
      const ids = new Set(m.models.map(x => x.id));
      if (m.basis.n !== ids.size) throw new BuildError(`matrix: Rank basis of ${where} says ${m.basis.n} reachable models but the models table lists ${ids.size}`);
      if (m.basis.n >= 3) throw new BuildError(`matrix: Rank basis of ${where} is repeat-rule with ${m.basis.n} models: the repeat rule (R-L3-003.5) is for fewer than three`);
      for (const r of ['flagship', 'second', 'workhorse']) if (!ids.has(m.ranks[r].id)) throw new BuildError(`matrix: ${r} ${m.ranks[r].id} of ${m.rankLine} is not in the models table of ${m.maker}`);
      // one model fills all three; two models: the higher above, the lower one filling the two lower ranks
      if (m.basis.n === 1 && !(m.ranks.flagship.id === m.ranks.second.id && m.ranks.second.id === m.ranks.workhorse.id)) throw new BuildError(`matrix: ${m.maker} has one model, the ranks of ${m.rankLine} must repeat it`);
      if (m.basis.n === 2 && !(m.ranks.second.id === m.ranks.workhorse.id && m.ranks.flagship.id !== m.ranks.second.id)) throw new BuildError(`matrix: ${m.maker} has two models, the ranks of ${m.rankLine} must be the higher above and the lower repeated`);
    }
  }
  if (tierHead < 0) throw new BuildError('matrix: no tier table header "| Maker (client) | T1 |"');
  if (!DELIMITER_ROW.test(lines[tierHead + 1] || '')) throw new BuildError(`matrix: the tier table header ${cite(tierHead)} has no delimiter row under it`);
  const cells = [];
  const tierRowOf = {};
  for (let i = tierHead + 2; i < lines.length && /^\| /.test(lines[i]); i++) {
    const cols = lines[i].split('|').slice(1, -1).map(c => c.trim());
    const mc = cols[0].match(/^(\S+) \((\S+)\)$/);
    if (!mc || cols.length !== 10) throw new BuildError(`matrix: tier row ${cite(i)} is not "Maker (client)" plus nine cells`);
    const [, maker, client] = mc;
    const m = makers[maker];
    if (!m || !m.ranks) throw new BuildError(`matrix: tier row ${cite(i)} names maker ${maker} without a rank line`);
    if (tierRowOf[maker]) throw new BuildError(`matrix: two tier rows of ${maker} (${tierRowOf[maker]}, ${cite(i)})`);
    tierRowOf[maker] = cite(i); m.tierClient = client.toLowerCase();
    for (let t = 1; t <= 9; t++) {
      // an empty cell is a stated unknown: it needs a Withheld line of its maker that names the tier, and no row is built for it
      if (cols[t] === '') {
        if (!m.withheld.has(t)) throw new BuildError(`matrix: T${t} of tier row ${cite(i)} is empty but the Withheld line of ${maker} does not name it`);
        continue;
      }
      if (m.withheld.has(t)) throw new BuildError(`matrix: T${t} of tier row ${cite(i)} is filled but the Withheld line of ${maker} names it`);
      // the tier cell is a CLOSED shape: "<model> / <effort>", the model name of ASCII
      // letters, digits, dots and hyphens only, the effort a lower-case word (or `unknown`); punctuation (`!!!`) and Unicode
      // lookalikes in place of a name are refused here
      const cm = cols[t].match(/^([A-Za-z0-9][A-Za-z0-9.-]*) \/ ([a-z]+)$/);
      if (!cm) throw new BuildError(`matrix: cell T${t} "${cols[t]}" of ${cite(i)} is not "<model> / <effort>" (a model name of ASCII letters, digits, dots and hyphens, a lower-case effort)`);
      const rank = RANK_OF_TIER(t);
      const ranked = m.ranks[rank];
      // the cell names a model and agrees with the rank line by an exact closed comparison: the tokens of the cell name
      // (lower-case words and numbers, split at everything else) are never empty - a name of punctuation only names nothing -
      // at least one of them holds a letter (numbers only are a version fragment, not a model) and every token of the cell
      // name appears in the tokens of the rank text
      const cellTokens = tokens(cm[1]);
      const have = new Set(tokens(ranked.text));
      if (!cellTokens.length || !cellTokens.some(tk => /[a-z]/.test(tk)) || !cellTokens.every(tk => have.has(tk))) throw new BuildError(`matrix: cell T${t} "${cm[1]}" of ${cite(i)} contradicts the ${rank} "${ranked.text}" of ${m.rankLine}`);
      cells.push({ maker, client: client.toLowerCase(), tier: t, rank, model: ranked.id, cell: cols[t], effort: cm[2] === 'unknown' ? null : cm[2], tierLine: cite(i), rankLine: m.rankLine, date: m.date || date, dateLine: m.dateLine || cite(dateLine) });
    }
  }
  return { date, dateLine: cite(dateLine), makers, cells };
}

// ---- reachable models of a maker come from the registry ----
// A client entry carries `makers`: {"<Maker>": ["<model of its models list>", ...]}, the maker of every model it lists, each model
// exactly once, each maker one with a section in the matrix. The reachable models of a maker are the models the registry attributes
// to it, over every client that carries `makers`; one model reached through two clients counts once (its name after the route
// prefix, as `norm`). For a maker outside the eight of the first run the models table of its section must name exactly that set and
// `repeat-rule (<n> ...)` must give its size, so a table that leaves a reachable model out cannot shrink the count (P-L3-003
// R-L3-003.5). The client of its tier row and every client that lists a model of its table must carry `makers`: otherwise the count is
// unknown and the build stops. A model the registry attributes to one maker and the table of another names is a contradiction.
function checkReachable(mx, clients, clientsText) {
  const where = name => `${CLIENTS}#clients.${name}.makers`;
  const withMap = Object.keys(clients).filter(name => clients[name] && Object.prototype.hasOwnProperty.call(clients[name], 'makers'));
  // JSON.parse keeps the last of two equal keys: a second "makers" key of one client would be silently dropped
  const keys = (String(clientsText).match(/"makers"\s*:/g) || []).length;
  if (keys !== withMap.length) throw new BuildError(`${CLIENTS}: ${keys} "makers" keys for ${withMap.length} clients that carry one: a client names its makers once`);
  const reach = {}; // maker -> Map(norm -> registry id)
  const attributed = {}; // client -> Map(model -> maker)
  for (const name of withMap) {
    const cfg = clients[name]; const map = cfg.makers;
    if (!map || typeof map !== 'object' || Array.isArray(map)) throw new BuildError(`${where(name)} must be an object {"<Maker>": [models]}`);
    const listed = Array.isArray(cfg.models) ? cfg.models : [];
    const seen = new Map();
    for (const [maker, ids] of Object.entries(map)) {
      if (!mx.makers[maker]) throw new BuildError(`${where(name)} names maker ${maker}, which has no section in the matrix`);
      if (!Array.isArray(ids) || !ids.length || ids.some(x => typeof x !== 'string')) throw new BuildError(`${where(name)}.${maker} must be a non-empty list of model ids`);
      for (const id of ids) {
        if (!listed.includes(id)) throw new BuildError(`${where(name)}.${maker} names ${id}, which clients.${name}.models does not list`);
        if (seen.has(id)) throw new BuildError(`${where(name)} names ${id} twice (${seen.get(id)}, ${maker})`);
        seen.set(id, maker);
        const r = reach[maker] = reach[maker] || new Map();
        if (!r.has(norm(id))) r.set(norm(id), id);
      }
    }
    const missing = listed.filter(id => !seen.has(id));
    if (missing.length) throw new BuildError(`${where(name)} does not name the maker of ${missing.join(', ')}: the reachable models of every maker are then unknown`);
    attributed[name] = seen;
  }
  // the registry and the tables of the matrix must not disagree about whose model a model is
  for (const [name, seen] of Object.entries(attributed)) {
    for (const [id, maker] of seen) {
      for (const m of Object.values(mx.makers)) {
        if (m.maker === maker) continue;
        const hit = m.models.find(x => norm(x.id) === norm(id));
        if (hit) throw new BuildError(`${where(name)} attributes ${id} to ${maker} but the table of ${m.maker} names it (${hit.line})`);
      }
    }
  }
  for (const m of Object.values(mx.makers)) {
    if (LEGACY_MAKERS.has(m.maker)) continue;
    const table = new Map(m.models.map(x => [norm(x.id), x.id]));
    const need = new Set(m.tierClient ? [m.tierClient] : []);
    for (const [name, cfg] of Object.entries(clients)) for (const id of Array.isArray(cfg.models) ? cfg.models : []) if (table.has(norm(id))) need.add(name);
    for (const name of need) if (!attributed[name]) throw new BuildError(`matrix: ${m.maker} is reached through client ${name}, whose registry entry carries no "makers": the number of reachable models of ${m.maker} is unknown`);
    const reg = reach[m.maker] || new Map();
    const notInTable = [...reg.keys()].filter(k => !table.has(k)).map(k => reg.get(k));
    const notInRegistry = [...table.keys()].filter(k => !reg.has(k)).map(k => table.get(k));
    if (notInTable.length) throw new BuildError(`matrix: the models table of ${m.maker} (${m.heading}) leaves out ${notInTable.join(', ')}, which the registry attributes to ${m.maker}: the reachable models come from the registry`);
    if (notInRegistry.length) throw new BuildError(`matrix: the models table of ${m.maker} (${m.heading}) names ${notInRegistry.join(', ')}, which no client of the registry attributes to ${m.maker}`);
    if (m.basis && m.basis.kind === 'repeat-rule' && m.basis.n !== reg.size) throw new BuildError(`matrix: Rank basis of ${m.maker} (${m.basisLine}) says ${m.basis.n} reachable models but the registry attributes ${reg.size} to ${m.maker}`);
  }
}

// ---- client registry ----
function routeModelOf(clientCfg, model, effort) {
  const list = (clientCfg && Array.isArray(clientCfg.models)) ? clientCfg.models : [];
  const how = clientCfg && clientCfg.effort ? clientCfg.effort.how : null;
  if (how === 'model-id') { const id = effort ? `${model}-${effort}` : model; return list.includes(id) ? id : null; }
  if (list.includes(model)) return model;
  return list.find(x => x.endsWith(`/${model}`)) || null;
}
function effortStatusOf(clientCfg, effort) {
  if (!clientCfg) return 'client-unregistered';
  const e = clientCfg.effort || {};
  if (effort === null) return 'unknown';
  if (e.how === 'model-id') return 'in-model-id';
  if (Array.isArray(e.values)) return e.values.includes(effort) ? 'in-registry-values' : 'not-in-registry-values';
  if (e.how === 'config') return 'client-config';
  return 'not-settable';
}

// ---- maker order (owner or operator data) ----
function validateMakerOrder(obj, makersKnown) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || obj.schema !== 'maker-order/1' || !obj.entries || typeof obj.entries !== 'object') {
    throw new BuildError('maker order: expected {"schema":"maker-order/1","entries":{"T7":{"order":[...],"source":"...","date":"YYYY-MM-DD","by":"owner|operator"}}}');
  }
  const out = {};
  for (const [k, v] of Object.entries(obj.entries)) {
    if (!TASK_CLASSES.includes(k)) throw new BuildError(`maker order: unknown task class ${k} (T1..T9)`);
    if (!v || !Array.isArray(v.order) || !v.order.length || v.order.some(x => typeof x !== 'string')) throw new BuildError(`maker order ${k}: order must be a non-empty array of maker names`);
    if (new Set(v.order).size !== v.order.length) throw new BuildError(`maker order ${k}: a maker is named twice`);
    for (const mk of v.order) if (!makersKnown.has(mk)) throw new BuildError(`maker order ${k}: unknown maker ${mk}`);
    if (typeof v.source !== 'string' || !v.source.trim()) throw new BuildError(`maker order ${k}: source is required`);
    if (!isCalendarDate(v.date)) throw new BuildError(`maker order ${k}: a calendar date YYYY-MM-DD is required`);
    if (v.by !== 'owner' && v.by !== 'operator') throw new BuildError(`maker order ${k}: by must be owner or operator`);
    out[k] = { order: v.order.slice(), source: v.source, date: v.date, by: v.by };
  }
  return out;
}

// A file the generator reads or writes is checked physically, not only by name.
// Junctions must not turn an external file into a repository file. Refused: a name that
// leaves the repository; a name with ':' (a drive, or an NTFS alternate data stream git does not track); any component below the
// repository root that is a link (symbolic link or junction: lstat); a file with more than one hard link (a write or an edit
// through the other name changes it); anything but a regular file; a real path (realpathSync.native) that is not the real
// repository root plus the same name, equal ignoring letter case on Windows: that also refuses other reparse points and 8.3 short
// names. The root is what --repo names; only what lies below it is checked. A file swapped for a link between this check and the
// read or write is not covered (the generator runs on the owner's own checkout).
// Returns { abs, real, rel }: rel is the name the file system holds, repo-relative with forward slashes (a letter-case variant
// is recorded as the real name). opts.mayBeMissing: a missing file returns { missing: true, abs, rel } after its parents passed.
const SAME_NAME = process.platform === 'win32' ? (a, b) => a.toLowerCase() === b.toLowerCase() : (a, b) => a === b;
function repoPath(repo, p, what, opts = {}) {
  const fsx = opts.fs || fs;
  const abs = path.resolve(repo, p);
  const rel = path.relative(repo, abs);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) throw new BuildError(`${what} must be inside the repository (the ladder is rebuilt from tracked files): ${p}`);
  const parts = rel.split(path.sep);
  const shown = parts.join('/');
  if (parts.some(c => c.includes(':'))) throw new BuildError(`${what} ${p}: a name with ':' (a drive or an NTFS alternate data stream, which git does not track) is refused`);
  let realRoot;
  const realOf = realPath.forFs(fsx).realPathSync;
  try { realRoot = realOf(repo); } catch (e) { throw new BuildError(`repository ${repo} unreadable: ${e.code || e.message}`); }
  const sameReal = (absPath, relPath) => {
    let real;
    try { real = realOf(absPath); } catch (e) { throw new BuildError(`${what} unreadable: ${shown}: ${e.code || e.message}`); }
    const relReal = path.relative(realRoot, real);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) throw new BuildError(`${what} ${p} is physically outside the repository (a link or another reparse point): refused`);
    if (!SAME_NAME(relReal, relPath)) throw new BuildError(`${what} ${p} is physically ${relReal.split(path.sep).join('/')} (a reparse point or an 8.3 short name): refused`);
    return { real, relReal };
  };
  let cur = repo;
  for (let i = 0; i < parts.length; i++) {
    cur = path.join(cur, parts[i]);
    let st;
    try { st = fsx.lstatSync(cur); } catch (e) {
      if (e.code === 'ENOENT' && opts.mayBeMissing) {
        if (i > 0) sameReal(path.dirname(cur), parts.slice(0, i).join(path.sep));
        return { missing: true, abs, rel: shown };
      }
      throw new BuildError(`${what} unreadable: ${shown}: ${e.code || e.message}`);
    }
    if (st.isSymbolicLink()) throw new BuildError(`${what} ${p}: ${parts.slice(0, i + 1).join('/')} is a link (symbolic link or junction): the generator reads and writes only real files of the repository`);
    if (i === parts.length - 1) {
      if (!st.isFile()) throw new BuildError(`${what} ${p}: not a regular file`);
      if (st.nlink > 1) throw new BuildError(`${what} ${p}: the file has ${st.nlink} hard links: refused (a change through another name would change it)`);
    }
  }
  const { real, relReal } = sameReal(abs, rel);
  return { abs, real, rel: relReal.split(path.sep).join('/') };
}

// The maker order in force: --maker-order FILE, else the dated file the default pointer names, else none (null).
// Returns { rel, buf, obj }: rel is repo-relative with forward slashes, so the built ladder never carries a machine path.
// Both the pointer and the file it names (or the override) pass repoPath: inside the repository physically, no link on the way.
function readMakerOrder(repo, override, deps = {}) {
  const fsx = deps.fs || fs;
  const readJson = (loc, what) => {
    let buf;
    try { buf = fsx.readFileSync(loc.real); } catch (e) { throw new BuildError(`${what} unreadable: ${loc.rel}: ${e.code || e.message}`); }
    return { buf, obj: parseJsonNoDuplicates(buf, `${what} ${loc.rel}`) };
  };
  let loc;
  if (override) {
    loc = repoPath(repo, override, 'maker order file', { fs: fsx });
  } else {
    // a missing pointer means no order; a dangling link at its place is a link, not a missing pointer
    const ptr = repoPath(repo, MAKER_ORDER, 'maker order pointer', { fs: fsx, mayBeMissing: true });
    if (ptr.missing) return null;
    const { obj } = readJson(ptr, 'maker order pointer');
    if (!obj || obj.schema !== 'maker-order-pointer/1') throw new BuildError(`${MAKER_ORDER}: expected {"schema":"maker-order-pointer/1","current":"docs/ops/maker-order-YYYY-MM-DD.json"}`);
    if (typeof obj.current !== 'string' || !obj.current.trim()) throw new BuildError(`${MAKER_ORDER}: current must name the dated maker order file`);
    loc = repoPath(repo, obj.current, `maker order file named by ${MAKER_ORDER}`, { fs: fsx });
  }
  const { buf, obj } = readJson(loc, 'maker order file');
  if (obj && obj.schema === 'maker-order-pointer/1') throw new BuildError(`maker order file ${loc.rel} names another pointer: a pointer is followed once`);
  return { rel: loc.rel, buf, obj };
}

function readText(repo, rel) {
  const loc = repoPath(repo, rel, 'input');
  try { return fs.readFileSync(loc.real); } catch (e) { throw new BuildError(`cannot read ${rel}: ${e.code || e.message}`); }
}

function build(repo, opts = {}) {
  const matrixBuf = readText(repo, MATRIX);
  const clientsBuf = readText(repo, CLIENTS);
  const historyBuf = readText(repo, HISTORY);
  let registry; let history;
  // revision, the registry and the history are read by the duplicate-key detecting parser (a repeated key loses no
  // value silently: the build refuses it before JSON.parse keeps the last)
  registry = parseJsonNoDuplicates(clientsBuf, CLIENTS);
  history = parseJsonNoDuplicates(historyBuf, HISTORY);
  if (history.schema !== 'ladder/1' || !Array.isArray(history.rungs) || !history.source) throw new BuildError(`${HISTORY} is not the ladder/1 history file`);
  const mx = parseMatrix(matrixBuf.toString('utf8'));
  const clients = registry.clients || {};
  checkReachable(mx, clients, clientsBuf.toString('utf8'));
  // the owner's approval flags of the working ladder carry over to the maker they were set for (rung provider == maker)
  const approvals = {};
  for (const r of history.rungs) if (r.approval && r.approval !== 'none') approvals[r.provider] = { approval: r.approval, source: `${HISTORY} rung ${r.rung} order ${r.order} ("${r.label}")` };

  const rows = [];
  const covered = new Set();
  for (const c of mx.cells) {
    const cfg = clients[c.client] || null;
    const routeModel = cfg ? routeModelOf(cfg, c.model, c.effort) : null;
    if (routeModel) covered.add(`${c.client}\u0000${routeModel}`);
    const effortStatus = effortStatusOf(cfg, c.effort);
    const appr = approvals[c.maker] || null;
    rows.push({
      id: `${c.maker}:${c.model}:T${c.tier}`, maker: c.maker, model: c.model, family: c.model, client: c.client, routeModel,
      tier: c.tier, rank: c.rank, effort: c.effort, effortStatus, approval: appr ? appr.approval : 'none', contextWindow: null,
      date: c.date, clientVerifiedOn: cfg ? cfg.verifiedOn || null : null,
      source: { tier: c.tierLine, rank: c.rankLine, date: c.dateLine, route: cfg ? `${CLIENTS}#clients.${c.client}.models` : null, ...(appr ? { approval: appr.source } : {}) },
      evidence: `tier cell "${c.cell}" (${c.tierLine}); ${c.rank} ${c.model} (${c.rankLine}); ${cfg ? (routeModel ? `${c.client}.models lists ${routeModel}` : `${c.client}.models does not list ${c.model}${c.effort ? ` for effort ${c.effort}` : ''}`) : `client ${c.client} is not in the registry`}; effort ${c.effort === null ? 'unknown' : c.effort}: ${effortStatus}`,
    });
  }
  // every other model a registered client lists: a row with its maker when a maker section of the matrix names it, else null; tier null
  const sectionIndex = [];
  for (const m of Object.values(mx.makers)) for (const md of m.models) sectionIndex.push({ maker: m.maker, id: md.id, line: md.line });
  for (const name of Object.keys(clients).sort()) {
    const cfg = clients[name];
    for (const raw of Array.isArray(cfg.models) ? cfg.models : []) {
      if (covered.has(`${name}\u0000${raw}`)) continue;
      const base = cfg.effort && cfg.effort.how === 'model-id' ? raw.replace(/-(low|medium|high)$/, '') : raw;
      const hit = sectionIndex.find(s => norm(s.id) === norm(base));
      rows.push({
        id: `${hit ? hit.maker : 'unknown'}:${raw}:${name}`, maker: hit ? hit.maker : null, model: hit ? hit.id : null, family: hit ? hit.id : raw, client: name, routeModel: raw,
        tier: null, rank: null, effort: null, effortStatus: 'unknown', approval: 'none', contextWindow: null,
        date: null, clientVerifiedOn: cfg.verifiedOn || null,
        source: { tier: null, rank: null, date: null, route: `${CLIENTS}#clients.${name}.models`, ...(hit ? { maker: hit.line } : {}) },
        evidence: `${name}.models lists ${raw}; ${hit ? `maker ${hit.maker} from ${hit.line}` : 'no maker section of the matrix names it'}; no tier cell in the matrix tier table`,
      });
    }
  }
  const makersKnown = new Set(rows.map(r => r.maker).filter(Boolean));
  const mo = readMakerOrder(repo, opts.makerOrderFile);
  const makerOrder = mo ? validateMakerOrder(mo.obj, makersKnown) : {};
  const dates = [mx.date, ...Object.values(mx.makers).map(m => m.date).filter(Boolean), ...Object.values(clients).map(c => c.verifiedOn).filter(Boolean)].sort();
  const ladder = {
    schema: 'ladder/2',
    generator: 'docs/ops/ladder-build.cjs',
    asOf: dates[dates.length - 1],
    note: 'Built from evidence by docs/ops/ladder-build.cjs; never edited by hand. Tiers are provider-relative (P-L3-003 R-L3-003.3, P-L2-002, PROTO-DEC-0086 item 5): the resolver orders rows only within one maker; across makers it follows makerOrder and nothing else. Unknown stays null. No layer data (PROTO-DEC-0143 item 3).',
    source: history.source,
    sources: {
      matrix: { path: MATRIX, sha256: sha256(matrixBuf), date: mx.date },
      clients: { path: CLIENTS, sha256: sha256(JSON.stringify(clientsProjection(registry))), digest: 'sha256 of the clients projection (registry.cjs clientsProjection)' },
      history: { path: HISTORY, sha256: sha256(historyBuf), snapshot: history.source.snapshot || null },
      ...(mo ? { makerOrder: { path: mo.rel, sha256: sha256(mo.buf) } } : {}),
    },
    makerOrder,
    makerOrderNote: mo ? `from ${mo.rel} (sha256 in sources.makerOrder; the default file is named by ${MAKER_ORDER}); the resolver orders makers by it and still never compares tiers across makers` : 'empty: no explicit cross-maker order per task class has been supplied by the owner or the operator; the resolver answers cross-maker-order-missing with a stop-question (P-L0-002) whenever the admissible rows span more than one maker',
    rows,
    rungsNote: `compatibility view: the rungs of ${HISTORY} verbatim, for readers of ladder/1 (the layer tools read them), except the rungs of a client the registry no longer lists (the history file itself is never edited); the ladder/2 resolver never reads rungs`,
    rungs: history.rungs.filter(r => Object.hasOwn(clients, r.client)),
  };
  const text = `${JSON.stringify(ladder, null, 2)}\n`;
  return { ladder, text, sha256: sha256(text) };
}

function arg(argv, name) { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined; }

function summary(ladder) {
  const out = [];
  for (const r of ladder.rows) out.push(`ROW ${r.id} client=${r.client} route=${r.routeModel || 'null'} tier=${r.tier === null ? 'null' : `T${r.tier}`} effort=${r.effort || 'null'} effortStatus=${r.effortStatus} approval=${r.approval} src=${r.source.tier || r.source.route}`);
  const ranked = ladder.rows.filter(r => r.tier !== null).length;
  out.push(`ROWS total=${ladder.rows.length} ranked=${ranked} unranked=${ladder.rows.length - ranked} makerOrder=${Object.keys(ladder.makerOrder).join(',') || 'none'} asOf=${ladder.asOf}`);
  return out;
}

function main(argv, deps = {}) {
  const cmd = argv[0];
  const say = deps.say || (l => process.stdout.write(`${l}\n`));
  const repo = path.resolve(arg(argv, 'repo') || path.join(__dirname, '..', '..'));
  if (!['plan', 'write', 'check'].includes(cmd)) { say('usage: ladder-build.cjs plan|write|check [--expect-sha SHA] [--maker-order FILE] [--repo DIR]'); return 2; }
  let built;
  try { built = build(repo, { makerOrderFile: arg(argv, 'maker-order') }); } catch (e) { say(`ERROR ${e.message}`); return 2; }
  const outFile = path.join(repo, OUT);
  if (cmd === 'plan') {
    for (const l of summary(built.ladder)) say(l);
    say(`PLAN sha256=${built.sha256} bytes=${Buffer.byteLength(built.text)} (write with: node docs/ops/ladder-build.cjs write --expect-sha ${built.sha256})`);
    return 0;
  }
  // The ladder file itself: check and write never follow links. deps.fs is a test seam
  // for the ladder file only, so a test can keep its bytes in memory.
  const fsOut = deps.fs || fs;
  let out;
  try { out = repoPath(repo, OUT, 'ladder file', { mayBeMissing: true, fs: fsOut }); } catch (e) { say(`ERROR ${e.message}`); return 2; }
  if (cmd === 'check') {
    let cur = null; if (!out.missing) try { cur = fsOut.readFileSync(out.real, 'utf8'); } catch { /* unreadable: different */ }
    const same = cur === built.text;
    say(`CHECK ${same ? 'ok' : 'DIFFERENT'} built=${built.sha256} current=${cur === null ? 'missing' : sha256(cur)}`);
    return same ? 0 : 1;
  }
  const expect = arg(argv, 'expect-sha');
  if (!expect) { say('write needs --expect-sha <sha256 printed by plan>'); return 2; }
  if (expect !== built.sha256) { say(`REFUSED sha256=${built.sha256} expected=${expect}: the evidence changed since the plan; run plan again`); return 1; }
  (deps.writeFileSync || fsOut.writeFileSync)(outFile, built.text, 'utf8');
  say(`WROTE ${OUT} sha256=${built.sha256}`);
  return 0;
}

module.exports = { build, parseMatrix, checkReachable, sectionLineProblem, blockShape, isCalendarDate, parseRankBasis, routeModelOf, effortStatusOf, validateMakerOrder, readMakerOrder, repoPath, main, BuildError, MATRIX, CLIENTS, HISTORY, OUT, MAKER_ORDER };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

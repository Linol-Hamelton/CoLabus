'use strict';

// One model of the text of a journal entry, shared by every reader and every writer of it: the Stop hook and the session
// context, the handoff record, verify and rehash, the evidence chain, the archive, review bindings, the validator and
// the certification counters. Text inside code (a fenced or an indented code block) or an HTML comment (a comment block,
// or an inline comment of a paragraph), closed or running to the end, is entry data: a dated heading, a label, an
// Evidence block, an entry hash line, a review binding or a `### From` frame there is never structure. Every pattern
// here runs on the fence mask (the same offsets, the quoted characters filled with a control character) and every cut
// is made in the text, so a quoted example stays byte for byte. A reader takes the sections, the labels, the Evidence
// block, the entry hash line and the From frames from this module and keeps no fence or label pattern of its own, so no
// two readers can disagree on where they are. Pure functions: nothing here reads or writes a file.

const crypto = require('node:crypto');
// The one list of credential shapes (a pure module): a writer refuses an entry that carries one.
const { secretKind } = require('./secrets.cjs');

// Required labels, then optional ones. Optional labels never gate completeness,
// but they do terminate the preceding label's capture, so an Evidence block
// appended by .ai/bin/protocol-handoff.cjs does not leak into Open.
const REQUIRED_LABELS = ['Agent', 'Action', 'Result', 'Next step', 'Open'];
const ENTRY_LABELS = [...REQUIRED_LABELS, 'Evidence'];

// Canonical date heading patterns, shared by all protocol modules.
// Supports: YYYY-MM-DD, optional HH:MM[:SS], optional timezone (named, +-HHMM, Z).
const DATE_HEADING_REGEX = /^## \d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2})?(?:[ ]?(?:[A-Za-z0-9_]+|[+-]\d{2}(?::?\d{2})?|Z))?)? - .+/;
const DATE_HEADING_M_REGEX = /^## \d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}(?::\d{2})?(?:[ ]?(?:[A-Za-z0-9_]+|[+-]\d{2}(?::?\d{2})?|Z))?)? - .+/m;

const ENTRY_HASH_FORMAT = 2;

const lf = text => String(text).replace(/\r\n/g, '\n');
const sha256 = text => `sha256:${crypto.createHash('sha256').update(text, 'utf8').digest('hex')}`;

// Code and comments are data: a heading, a label, a bullet or a separator inside them never frames an entry, an Evidence
// block, an entry hash line or a quoted tail. The blocks follow CommonMark, line by line:
// - A fenced code block (``` or ~~~) runs to its closing fence; an indented code block is a line indented four columns
//   past its container (a tab to the next multiple of four) that does not continue a paragraph.
// - A list item is a container: its content column is the marker's end plus the spaces after it (one when the item is
//   empty or its content is itself indented code), and a fence, a comment block or indented code inside the item is
//   measured from that column. A fence after the marker on the same line (`- ```) is a fence. The item ends at the
//   first non-blank line indented less than its column that does not continue a paragraph, and a fence in it ends there
//   too.
// - An HTML comment block starts at a line whose text (after its container's indent and up to three spaces) begins with
//   `<!--`, and runs to the line where a comment is left closed: every `-->` and `<!--` of a line is taken in order, a
//   close ends the comment and a later opener on the same line opens another one; `<!-->` and `<!--->` close at once. A
//   comment block is never ended by its container: the rendered page hides everything up to its `-->`.
// - A `<!--` inside a paragraph (labels, bullets' text and their continuation lines) opens an inline comment when a
//   `-->` closes it before the paragraph ends: the characters between are hidden, across lines. A code span opened
//   first keeps a `<!--` inside it as text, a backslash keeps the next character literal, and an opener with no close
//   in its paragraph is text.
// - A fence or a comment block with no close runs to the end of the text it is given (in one entry to the end of the
//   entry, in a journal to its end; a fence in a list item to the end of the item), and an unclosed one that reaches
//   the end is reported, so no writer places a block after it and no archive keeps the record.
// Kept rules: an entry heading starts at column 0 (a heading indented one to three spaces is text of the entry or the
// preamble it stands in, never a cut); a block quote line is paragraph text (a `>` line frames nothing: no heading, label
// or hash line starts with `>`); raw HTML other than a comment is text.
// The archived-parent marker of a journal is one line of the exact marker form that stands as a block of its own: read
// as plain text in its place, it is outside a fence, an indented block and a comment block and is a paragraph of that
// one line. The same line as a line of a longer paragraph (no blank line before or after it, in a list item's text or
// a block quote) is neither the marker nor quoted text, and so is a line that begins as the marker comment but is not the
// exact form (malformed): a writer or a reader that needs the parent refuses it by name (ENTRY_AMBIGUOUS), and a reader
// that reports names the line and never takes it as the parent.
// The scan goes in order, so a comment opener inside a fence is fence data and a fence opener inside a comment is
// comment data. The mask keeps every offset and fills the quoted characters with a control character (never whitespace,
// never a pattern), so a pattern runs on the mask and the cut is made in the text.
const BLANK = /^[ \t\r]*$/;
const FENCE_OPEN = /^(`{3,}|~{3,})([^\n]*)$/;
const FENCE_CLOSE = /^(`{3,}|~{3,})[ \t\r]*$/;
const THEMATIC = /^([-*_])(?:[ \t]*\1){2,}[ \t\r]*$/;
const SETEXT = /^(?:=+|-+)[ \t\r]*$/;
const ATX = /^#{1,6}(?:[ \t]|\r?$)/;
const LIST_MARKER = /^([-+*]|\d{1,9}[.)])(?=[ \t]|\r?$)/;

// The indent of a line in columns (a tab to the next multiple of four) and its text after the indent.
function indentOf(line) {
  let width = 0;
  let at = 0;
  for (; at < line.length; at++) {
    if (line[at] === ' ') width++;
    else if (line[at] === '\t') width += 4 - (width % 4);
    else break;
  }
  return { width, rest: line.slice(at) };
}

// The fence of an opener line's text, or null (a backtick fence carries no backtick in its info string).
function fenceOf(rest) {
  const open = FENCE_OPEN.exec(rest);
  return open && !(open[1][0] === '`' && open[2].includes('`')) ? open[1] : null;
}

// True when a line's text starts a block that ends a paragraph (a list item interrupts one only with content, and an
// ordered one only from 1).
function startsBlock(rest, inParagraph) {
  if (fenceOf(rest) || rest.startsWith('<!--') || ATX.test(rest) || THEMATIC.test(rest)) return true;
  if (inParagraph && SETEXT.test(rest)) return true;
  const marker = LIST_MARKER.exec(rest);
  if (!marker) return false;
  if (!inParagraph) return true;
  return !BLANK.test(rest.slice(marker[0].length)) && (!/\d/.test(marker[1][0]) || /^0*1[.)]$/.test(marker[1]));
}

// True when a comment open at `from` is still open at the end of the line: its markers are taken in order.
function commentOpenAfter(line, from) {
  let open = true;
  let at = from;
  for (;;) {
    const next = line.indexOf(open ? '-->' : '<!--', at);
    if (next === -1) return open;
    at = next + (open ? 3 : 2);
    open = !open;
  }
}

// The inline comments of one paragraph (its line indexes, consecutive), added to the per-line character spans.
function inlineComments(lines, indexes, spans) {
  if (!indexes.length) return;
  const text = indexes.map(i => lines[i]).join('\n');
  const hide = (start, end) => {
    let offset = 0;
    for (const i of indexes) {
      const from = Math.max(start, offset) - offset;
      const to = Math.min(end, offset + lines[i].length) - offset;
      if (from < to) spans.set(i, [...(spans.get(i) || []), [from, to]]);
      offset += lines[i].length + 1;
    }
  };
  for (let k = 0; k < text.length;) {
    if (text[k] === '\\') { k += 2; continue; }
    if (text[k] === '`') {
      let run = 1;
      while (text[k + run] === '`') run++;
      let close = -1;
      for (let c = text.indexOf('`', k + run); c !== -1; c = text.indexOf('`', c)) {
        let length = 1;
        while (text[c + length] === '`') length++;
        if (length === run) { close = c; break; }
        c += length;
      }
      k = close === -1 ? k + run : close + run;
      continue;
    }
    if (text.startsWith('<!--', k)) {
      const end = text.indexOf('-->', k + 2);
      if (end === -1) break;
      hide(k, end + 3);
      k = end + 3;
      continue;
    }
    k++;
  }
}

function quotedLines(lines) {
  const whole = new Array(lines.length).fill(false);
  const spans = new Map();
  let unclosed = false;
  const items = [];
  const joined = new Set();
  let paragraph = [];
  const endParagraph = () => {
    inlineComments(lines, paragraph, spans);
    if (paragraph.length > 1) for (const i of paragraph) joined.add(i);
    paragraph = [];
  };
  for (let i = 0; i < lines.length; i++) {
    if (BLANK.test(lines[i])) { endParagraph(); continue; }
    let { width, rest } = indentOf(lines[i]);
    const inParagraph = paragraph.length > 0;
    const starts = startsBlock(rest, inParagraph);
    if (!inParagraph || starts) while (items.length && width < items[items.length - 1]) items.pop();
    const column = items.length ? items[items.length - 1] : 0;
    if (inParagraph && (!starts || width - column >= 4 || width < column)) { paragraph.push(i); continue; }
    if (width - column >= 4) { endParagraph(); whole[i] = true; continue; }
    if (inParagraph && SETEXT.test(rest)) { endParagraph(); continue; }
    if (THEMATIC.test(rest)) { endParagraph(); continue; }
    let code = false;
    for (let marker; (marker = LIST_MARKER.exec(rest));) {
      const after = rest.slice(marker[0].length);
      const gap = indentOf(after);
      const end = width + marker[0].length;
      if (BLANK.test(after)) { items.push(end + 1); rest = ''; break; }
      if (gap.width > 4) { items.push(end + 1); code = true; break; }
      items.push(end + gap.width);
      width = end + gap.width;
      rest = gap.rest;
    }
    endParagraph();
    if (code) { whole[i] = true; continue; }
    if (rest === '') continue;
    const fence = fenceOf(rest);
    if (fence) {
      const inside = items.length ? items[items.length - 1] : 0;
      let j = i + 1;
      let closed = false;
      for (; j < lines.length; j++) {
        const line = indentOf(lines[j]);
        // The item ends at a line indented less than its column, and the fence with it: that line is read again.
        if (items.length && !BLANK.test(lines[j]) && line.width < inside) break;
        const close = FENCE_CLOSE.exec(line.rest);
        if (close && line.width - inside < 4 && close[1][0] === fence[0] && close[1].length >= fence.length) { closed = true; break; }
      }
      const last = closed ? j : j - 1;
      if (!closed && j === lines.length) unclosed = true;
      for (let k = i; k <= last; k++) whole[k] = true;
      i = last;
      continue;
    }
    if (rest.startsWith('<!--')) {
      let j = i;
      whole[j] = true;
      let open = commentOpenAfter(lines[j], lines[j].length - rest.length + 2);
      while (open && j + 1 < lines.length) { j++; whole[j] = true; open = commentOpenAfter(lines[j], 0); }
      if (open) unclosed = true;
      i = j;
      continue;
    }
    if (ATX.test(rest)) continue;
    paragraph.push(i);
  }
  endParagraph();
  return { whole, spans, unclosed, joined };
}
const fencedLines = lines => quotedLines(lines).whole;
function fenceMask(text) {
  const lines = String(text).split('\n');
  const { whole, spans } = quotedLines(lines);
  return lines.map((line, i) => {
    if (whole[i]) return '\u0001'.repeat(line.length);
    let out = line;
    for (const [from, to] of spans.get(i) || []) out = out.slice(0, from) + '\u0001'.repeat(to - from) + out.slice(to);
    return out;
  }).join('\n');
}
// True when the text has a fence or a comment block without its closing line: everything after the opener is quoted, so
// no writer places a block there and no archive keeps it as a record of its own.
function openQuote(text) {
  return quotedLines(lf(text).split('\n')).unclosed;
}

// The first match of a pattern on the mask, as offsets into the text.
function find(text, pattern) {
  const match = new RegExp(pattern.source, pattern.flags.replace('g', '')).exec(fenceMask(text));
  return match ? { index: match.index, end: match.index + match[0].length, match } : null;
}

// The lines of the text outside quoted blocks (code and comment blocks), each with its offset and its 1-based line number.
function unfencedLines(text) {
  const lines = String(text).split('\n');
  const masked = fencedLines(lines);
  const out = [];
  let offset = 0;
  lines.forEach((line, i) => {
    if (!masked[i]) out.push({ line, index: offset, number: i + 1 });
    offset += line.length + 1;
  });
  return out;
}

// The text cut before every heading line the pattern names (default `## `) outside a fenced block.
function splitSections(text, heading = /^## /) {
  const source = String(text);
  const mask = fenceMask(source);
  const pattern = new RegExp(heading.source, 'gm');
  const cuts = [...mask.matchAll(pattern)].map(m => m.index).filter(index => index > 0);
  return [0, ...cuts].map((start, i) => source.slice(start, i < cuts.length ? cuts[i] : source.length)).filter(s => s !== '');
}

// The dated entries of a journal or of the archive, newest first as they stand: every section that starts with a dated
// heading (LF line ends). The default cut is every `## ` heading (a journal entry); the archive cuts on dated headings
// only, so an inner `## Details` heading stays inside its record.
function datedSections(text, heading = /^## /) {
  return splitSections(lf(text), heading).filter(section => DATE_HEADING_REGEX.test(section));
}

// The text before the first heading of the journal (its title and its markers), or all of it when it has none.
function preamble(text) {
  const normalized = lf(text);
  const first = splitSections(normalized)[0] || '';
  return /^## /.test(first) ? '' : first;
}

// The newest dated section, complete or not: evidence attaches to what the
// agent just wrote, and an incomplete entry is exactly when it matters.
function newestSection(text) {
  const normalized = lf(text);
  const sections = splitSections(normalized);
  const index = sections.findIndex(section => DATE_HEADING_REGEX.test(section));
  if (index === -1) return null;
  return { sections, index, normalized };
}

// The section without a trailing separator line (`---`).
function withoutSeparator(section) {
  const separator = find(section, /\n-{3,}\s*$/);
  return separator ? `${section.slice(0, separator.index)}\n` : section;
}

// The value of one label: from its line to the next line of any other entry label. Terminate on any other label, not
// only the ones that come later in the canonical order: writing Open before Agent used to make Open swallow every field
// after it while the entry still counted as complete (DEC-0021). The value is found on the mask and cut from the text,
// trimmed; null when the label has no line of its own.
function entryField(section, label) {
  const text = String(section);
  const mask = fenceMask(text);
  const others = ENTRY_LABELS.filter(name => name !== label);
  const end = others.map(next => `${next}:`).join('|') || '(?!)';
  const match = new RegExp(`^${label}:[ \\t]*([\\s\\S]*?)(?=^(?:${end})|(?![\\s\\S]))`, 'md').exec(mask);
  if (!match) return null;
  let [start, stop] = match.indices[1];
  while (start < stop && /\s/.test(mask[start])) start++;
  while (stop > start && /\s/.test(mask[stop - 1])) stop--;
  return text.slice(start, stop);
}

// True when a dated section carries all five labels, each with a value (the trailing separator is not a value).
function entryComplete(section) {
  return labelsFilled(withoutSeparator(String(section)));
}
function labelsFilled(own) {
  if (!DATE_HEADING_REGEX.test(own)) return false;
  return REQUIRED_LABELS.every(label => {
    const value = entryField(own, label);
    // A floor against stubs, not a judgement of substance: "a"/"b"/"c"/"d"
    // used to pass as a handoff. Nothing here can tell filler from work.
    return value && value.length >= 3 && !/^_(?:What|Assumptions)/.test(value);
  });
}

function latestCompleteEntry(text) {
  // Strip the trailing separator first. Leaving it attached let an empty final
  // label capture "---" and count as a filled section.
  const sections = splitSections(lf(text)).map(withoutSeparator);
  return sections.find(labelsFilled)?.trim() || null;
}

// The entry hash label lines (`- entry: ...`) outside quoted text, in order, each with its recorded hash (null when
// the line carries none). The first one is the entry's own: it is the line the entry hash leaves out, the line a writer
// stamps and the line whose hash the entry records; a record with more than one is ambiguous.
const ENTRY_LINE = /^[ \t]*-[ \t]+entry:[^\n]*$/gm;
const ENTRY_HASH = /^[ \t]*-[ \t]+entry:[ \t]*(sha256:[a-f0-9]{64})\b/;
function entryLines(text) {
  const source = lf(text);
  const mask = fenceMask(source);
  return [...mask.matchAll(ENTRY_LINE)].map(m => {
    const line = source.slice(m.index, m.index + m[0].length);
    const hash = ENTRY_HASH.exec(line);
    return { index: m.index, line, hash: hash ? hash[1] : null };
  });
}

// The entry hash lines that carry a hash inside quoted text (code or a comment): examples of the line, never the
// entry's own.
function quotedEntryLines(text) {
  const source = lf(text);
  const mask = fenceMask(source);
  return [...source.matchAll(ENTRY_LINE)]
    .filter(m => mask.slice(m.index, m.index + m[0].length) !== m[0] && ENTRY_HASH.test(m[0]))
    .map(m => ({ index: m.index, line: m[0] }));
}

// The hash the entry records on its own (first) entry hash line, or null when that line carries none.
function recordedEntryHash(text) {
  const own = entryLines(text)[0];
  return own ? own.hash : null;
}

function hasEntryHashFormat2(section) {
  if (!section) return false;
  return /^[ \t]*-[ \t]+entry hash format:[ \t]*2(?:\s|$)/m.test(fenceMask(section));
}

// Canonical entry body hash logic: covers the entry body with its own
// Evidence block removed (for legacy format) or with its own '- entry:' line removed
// (for format 2). See DEC-0021 and PROTO-DEC-0028. Fenced text is entry data.
function canonicalEntryBody(section) {
  if (!section) return '';
  const authenticated = hasEntryHashFormat2(section);
  const cut = (text, pattern) => {
    const match = find(text, pattern);
    return match ? { before: text.slice(0, match.index), after: text.slice(match.end) } : null;
  };
  const own = cut(section, authenticated ? /\n*^[ \t]*-[ \t]+entry:[^\r\n]*$/m : /\n*^Evidence:[\s\S]*$/m);
  let body = own ? `${own.before}\n${own.after}` : section;
  const trailer = cut(body, /(?:\s*\n-{3,}[ \t]*|\s*\n### From [^\r\n]+)*\s*$/);
  body = trailer ? trailer.before : body;
  return body.replace(/\s+$/, '');
}

const entryDigest = section => sha256(canonicalEntryBody(section));

// The entry's own text ends before the first `### From` heading (text quoted from another file) and before a trailing
// separator; both stay as they are, after the entry. A heading or a separator inside a fenced block is entry text.
function splitEntryTail(section) {
  const from = fenceMask(section).search(/^### From /m);
  let head = from === -1 ? section : section.slice(0, from);
  let tail = from === -1 ? '' : section.slice(from);
  const separator = fenceMask(head).match(/\n-{3,}\s*$/);
  if (separator) { tail = head.slice(separator.index) + tail; head = head.slice(0, separator.index); }
  return { head, tail };
}

// The archived journal frames of a section after an offset: the cut before each `---` + `### From journal ...` frame
// the archive writes when it moves a whole journal.
function journalFrames(section, after = 0) {
  const frame = /\n---\n\n### From journal \.ai\/worklog\/[^\r\n]+, archived \d{4}-\d{2}-\d{2} \(\d+ bytes, sha256:[a-f0-9]{64}\)\n\n/g;
  return [...fenceMask(section).slice(after).matchAll(frame)].map(m => after + m.index);
}

// The entry's Evidence block, whatever its fields: an `Evidence:` line of its own followed by bullet lines. The word in
// prose (`Result: Evidence: none yet ...`), an `Evidence:` paragraph of the agent's own (no bullet after it) or a fenced
// example of the format is entry text.
const RECORDED_BLOCK = /(?:^|\n+)Evidence:[ \t]*\n[ \t]*-[ \t][^\n]*(?:\n[ \t]*-[ \t][^\n]*)*\n*/g;

// The Evidence field outside fenced blocks, cut from the text itself.
function evidenceField(text) {
  return entryField(text, 'Evidence');
}

// The fields of an Evidence block, read from its lines outside fenced blocks.
function parseEvidenceBlock(body) {
  if (!body) return null;
  const own = fenceMask(body);
  const digest = own.match(/^[ \t]*-[ \t]+digest:[ \t]*(sha256:[a-f0-9]{64})\b/m) || own.match(/digest:\s*(sha256:[a-f0-9]{64})/);
  const format = own.match(/^[ \t]*-[ \t]+digest format:[ \t]*(\d+)/m) || own.match(/digest format:\s*(\d+)/);
  const entry = own.match(/^[ \t]*-[ \t]+entry:[ \t]*(sha256:[a-f0-9]{64})\b/m);
  const parent = own.match(/^[ \t]*-[ \t]+parent-entry:[ \t]*(\S+)/m);
  const chainRoot = own.match(/^[ \t]*-[ \t]+chain root:[ \t]*(\S+)/m);
  const authenticated = hasEntryHashFormat2(body);
  const anchor = /^- anchor: ([a-f0-9]{40})(?:,|$)/m.exec(own);
  const recordedBy = [...own.matchAll(/^[ \t]*-[ \t]+recorded:[^\n]*? by ([^\n]+)$/gm)].map(m => m[1].trim());
  const candidate = /(?:^|\n)- candidate(?:-|:)/.test(own);
  return { body, digest: digest ? digest[1] : null, format: format ? Number(format[1]) : 1, formatStated: Boolean(format),
    commit: anchor ? anchor[1] : null,
    entry: entry ? entry[1] : null, parentEntry: parent ? parent[1] : null,
    chainRoot: chainRoot ? chainRoot[1] : null, authenticated, recordedBy, candidate };
}

// The section without its trailing separators and trailing `### From` heading lines.
function withoutTrailer(section) {
  const trailer = find(section, /(?:\n-{3,}[ \t]*|\n### From [^\r\n]+)*\s*$/);
  return trailer ? `${section.slice(0, trailer.index)}\n` : section;
}

// True when the text has an Evidence label line of its own (outside a fenced block), anywhere in it.
function hasEvidenceLabel(text) {
  return /^Evidence:/m.test(fenceMask(text));
}

// The entry text before its own recorded Evidence block (all of it when it has none): what the entry itself claims.
function claimText(section) {
  const block = find(section, RECORDED_BLOCK);
  return block ? section.slice(0, block.index) : section;
}

// The review bindings of a section: its `- review-binding:` lines outside quoted text, as written.
function bindingLines(section) {
  const text = lf(section);
  const mask = fenceMask(text).split('\n');
  return text.split('\n').filter((line, i) => mask[i].startsWith('- review-binding:'));
}

// null when the journal has no dated entry outside a quote, or when its newest entry opens a fence or a comment block it
// never closes: everything after that opener is quoted, so the entry has no place for a block of its own.
function formatWithEvidence(text, block) {
  const found = newestSection(text);
  if (!found || openQuote(found.sections[found.index])) return null;
  const { head, tail } = splitEntryTail(found.sections[found.index]);
  // A re-record replaces the recorded block where it stands (other entry text may follow it), so the entry keeps one
  // block; a first record goes at the end of the entry's own text, never into the quoted tail. A block is found on the
  // fence mask and cut from the text, so a fenced example stays byte for byte.
  let placed = false;
  let entry = '';
  let last = 0;
  for (const found of fenceMask(head).matchAll(RECORDED_BLOCK)) {
    const lead = found.index === 0 && !found[0].startsWith('\n') ? '' : '\n\n';
    entry += head.slice(last, found.index) + (placed ? (lead ? '\n\n' : '') : `${lead}${block}\n\n`);
    placed = true;
    last = found.index + found[0].length;
  }
  entry += head.slice(last);
  entry = placed ? `${entry.replace(/\n+$/, '')}\n` : `${head.replace(/\n+$/, '')}\n\n${block}\n`;
  const sections = [...found.sections];
  sections[found.index] = tail ? `${entry}\n${tail.replace(/^\n+/, '')}` : entry;
  return sections.join('');
}

// The journal text with the recorded hash of its newest entry set to `hash` on the entry's own hash line (its first
// entry hash line outside quoted text), and only when that line records `from` (any hash when `from` is null) and
// stands in the entry's own recorded Evidence block. null otherwise: when the entry's only hash line is quoted, or an
// entry hash line of its text comes before its block, a writer refuses rather than stamping another line.
function setEntryHash(text, hash, from = null) {
  const found = newestSection(text);
  if (!found) return null;
  const section = found.sections[found.index];
  const own = entryLines(section)[0];
  if (!own || !own.hash || (from !== null && own.hash !== from)) return null;
  const block = find(splitEntryTail(section).head, RECORDED_BLOCK);
  if (!block || own.index < block.index || own.index >= block.end) return null;
  const at = own.index + own.line.indexOf(own.hash);
  const sections = [...found.sections];
  sections[found.index] = section.slice(0, at) + hash + section.slice(at + own.hash.length);
  return sections.join('');
}

// The journal text with one line added to the Evidence block of its newest entry, before the block's own
// `- reproduce:` line; the text as it is when the block already has a line that starts with the same field, and null
// when the newest entry has no recorded block with a reproduce line.
function addEvidenceLine(text, line) {
  const found = newestSection(text);
  if (!found) return null;
  const section = found.sections[found.index];
  const block = find(splitEntryTail(section).head, RECORDED_BLOCK);
  if (!block) return null;
  const lines = section.slice(block.index, block.end);
  const field = line.slice(0, line.indexOf(':') + 1);
  if (lines.split('\n').some(l => l.startsWith(field))) return found.normalized;
  const reproduce = lines.search(/^- reproduce: /m);
  if (reproduce === -1) return null;
  const at = block.index + reproduce;
  const sections = [...found.sections];
  sections[found.index] = `${section.slice(0, at)}${line}\n${section.slice(at)}`;
  return sections.join('');
}

// The lines of the exact archived-parent marker form that nothing quotes, as { start, end, hash, glued } (the offsets of
// the line): read as plain text in its place, the line is outside a fence, an indented block and a comment, and glued
// when it is a line of a longer paragraph. The same line inside a fence, an indented block or another comment is an
// example of the marker, text like any other. A line that nothing quotes and that begins as the marker comment
// (`<!--`, blanks, `archived-parent:`) but is not the exact form is a malformed marker ({ malformed: true, hash: null }):
// it is neither the marker nor text, so it is never the parent and every reader of the parent names it.
const PARENT_MARKER = /^<!-- archived-parent:\s*(sha256:[a-f0-9]{64})\s*-->[ \t]*$/;
const MARKER_OPENING = /^<!--[ \t]*archived-parent:/;
function markerLines(text) {
  const lines = lf(text).split('\n');
  const out = [];
  let offset = 0;
  lines.forEach((line, i) => {
    const marker = PARENT_MARKER.exec(line);
    if (marker || MARKER_OPENING.test(line)) {
      const probe = lines.slice();
      probe[i] = 'x'.repeat(line.length);
      const { whole, spans, joined } = quotedLines(probe);
      if (!whole[i] && !(spans.get(i) || []).length) {
        out.push({ start: offset, end: offset + line.length, hash: marker ? marker[1] : null, malformed: !marker, glued: joined.has(i) });
      }
    }
    offset += line.length + 1;
  });
  return out;
}
// The archived-parent markers of a text: each well-formed marker line that stands as a block of its own.
const parentMarkers = text => markerLines(text).filter(m => !m.glued && !m.malformed);
// The well-formed marker lines glued to a paragraph: neither a marker nor text, so every reader of the parent names them.
const gluedMarkers = text => markerLines(text).filter(m => m.glued && !m.malformed);
// Every marker line that is neither a marker nor text: glued to a paragraph, or malformed.
const strayMarkers = text => markerLines(text).filter(m => m.glued || m.malformed);
// The refusal of the stray marker lines: each line, what it is and what clears it.
function strayRefusal(text, stray) {
  const lines = stray.map(m => lineAt(text, m.start));
  const named = stray.map((m, k) => (m.malformed
    ? `line ${lines[k]} begins as the archived-parent marker comment but is not the exact form <!-- archived-parent: sha256:<64 hex digits> -->, so the archived-parent layout is ambiguous: it is neither the journal's own marker nor quoted text; write the exact form or move the example into a fence`
    : `line ${lines[k]} is an archived-parent marker glued to a paragraph (no blank line before or after it): it is neither the journal's own marker nor quoted text; put a blank line before and after it, or move the example into a fence`));
  return refuse(ENTRY_AMBIGUOUS, lines, named.join('; '));
}

// The archived-parent marker of a journal: the first marker of its own in its preamble.
function findArchivedParent(text) {
  const marker = parentMarkers(preamble(text))[0];
  return marker ? marker.hash : null;
}

// The hash chain of a journal, read from its text: every dated section with a recorded entry hash hashes to it, and each
// recorded parent is the hash of the next older section (the oldest one's is the archived-parent marker when there is
// one). { ok } or { ok: false, reason }.
function journalChain(text) {
  const normalized = lf(text);
  const stray = strayMarkers(preamble(normalized));
  if (stray.length) return strayRefusal(normalized, stray);
  const dated = datedSections(normalized);
  const archivedParent = findArchivedParent(normalized);
  for (let i = 0; i < dated.length; i++) {
    const section = dated[i];
    const ev = parseEvidenceBlock(evidenceField(withoutSeparator(section)));
    if (!ev || !ev.entry) continue;
    const actual = entryDigest(section);
    if (ev.entry !== actual) {
      return { ok: false, index: i, reason: `historical entry at index ${i} was changed after certification. Recorded ${ev.entry}, computed ${actual}.` };
    }
    if (ev.parentEntry && ev.parentEntry !== 'root' && ev.parentEntry !== 'legacy') {
      if (ev.parentEntry === 'tampered') return { ok: false, index: i, reason: `historical entry at index ${i} recorded a tampered parent entry.` };
      if (i + 1 < dated.length) {
        const next = entryDigest(dated[i + 1]);
        if (ev.parentEntry !== next) {
          return { ok: false, index: i, reason: `historical link at index ${i} was broken. Recorded parent ${ev.parentEntry}, expected ${next}.` };
        }
      } else if (archivedParent && ev.parentEntry !== archivedParent) {
        return { ok: false, index: i, reason: `oldest entry parent ${ev.parentEntry} does not match archived-parent marker ${archivedParent}.` };
      }
    } else if (i + 1 < dated.length && hasEntryHashFormat2(section) && !ev.parentEntry && ev.chainRoot !== 'transitional') {
      return { ok: false, index: i, reason: `historical link at index ${i} lacks parent-entry; chain is broken.` };
    }
  }
  return { ok: true };
}

// --- The writer postconditions --------------------------------------------------------------------------------------
// The format rule is an enumeration, not a promise to read every Markdown or HTML construct: a fenced code block, an
// indented code block and an HTML comment are quotes (the rules above); everything else at column 0 is structure. A
// construct outside that list (an entry line inside pre, details, a table cell or any later construct) is read as
// structure, so a writer meeting it gets a named refusal below, never a rewritten example. Every journal and archive
// writer computes its result in memory, proves it with checkJournalWrite and writes once; a refusal writes nothing.
// A label written twice in one entry is one value: a label's value runs to the next label of another name, so the second
// line of the same label continues the first value (a declared reading, not two readings); a receipt field stated twice
// in the Evidence block has two readings and is refused.
// The refusal names: ENTRY_AMBIGUOUS (the result changes text outside the place the writer owns, replaces a block that is
// not the entry's verified recorded block (its own hash line carries the entry's hash, or it has no hash line and states
// the recorder's anchor digest item), moves a section cut, or the newest entry has not exactly one own entry hash
// line carrying the hash set, or its block states a receipt field twice), ENTRY_INCOMPLETE (the newest entry lacks one of
// the five labels before or after), ENTRY_SECRET (the entry written holds a credential-shaped value; the reason opens with the
// phrase record has always printed for a secret) and
// ENTRY_CHAIN_BROKEN (the hash chain of the result does not verify).
// Each name is the code its refusal carries; the list is written as data, one name per item.
// Beside them, ENTRY_STALE is the refusal of the compare before the replace (protocol-journal unchangedOrStale): the file
// changed while the tool worked; run the command again.
const [ENTRY_AMBIGUOUS, ENTRY_INCOMPLETE, ENTRY_CHAIN_BROKEN, ENTRY_SECRET, ENTRY_STALE] =
  ['ENTRY_AMBIGUOUS', 'ENTRY_INCOMPLETE', 'ENTRY_CHAIN_BROKEN', 'ENTRY_SECRET', 'ENTRY_STALE'];
// What clears a carriage return refusal, said by every writer that refuses one.
const CR_CLEAR = 'save the journal as UTF-8 with LF line ends and run the command again';
// The phrase of record's secret refusal since its first secret scan, kept beside the name for the readers that match it.
const SECRET_PHRASE = 'Unredacted secret pattern detected';
// The anchor digest item every recorder writes into its block.
const RECEIPT_DIGEST = /^[ \t]*-[ \t]+digest:[ \t]*sha256:[a-f0-9]{64}[ \t]*$/m;
// The receipt fields a reader takes from the block, each of which a block states once.
const RECEIPT_FIELDS = ['anchor', 'digest', 'digest format', 'entry hash format', 'parent-entry', 'chain root'];

const lineAt = (text, index) => String(text).slice(0, Math.max(0, index)).split('\n').length;

// The sections of a text with their offsets: the cut before every heading line the pattern names outside a quote.
function sectionSpans(text, heading = /^## /) {
  const source = String(text);
  const pattern = new RegExp(heading.source, 'gm');
  const cuts = [...fenceMask(source).matchAll(pattern)].map(m => m.index).filter(index => index > 0);
  return [0, ...cuts].map((start, i) => {
    const end = i < cuts.length ? cuts[i] : source.length;
    return { start, end, text: source.slice(start, end), dated: DATE_HEADING_REGEX.test(source.slice(start, end)) };
  }).filter(s => s.text !== '');
}

// The own text of a section (before its quoted tail and separator) and its recorded Evidence block, as offsets.
function ownSpan(span) {
  const head = splitEntryTail(span.text).head;
  const block = find(head, RECORDED_BLOCK);
  return { start: span.start, end: span.start + head.length,
    block: block ? [span.start + block.index, span.start + block.end] : null };
}

// The reading of one entry under the format rule: { ok: true } or { ok: false, state: 'ambiguous', code, lines, reason }
// with line numbers counted from `base`. An entry hash line of its own must be one, inside the entry's recorded Evidence
// block (I4), and the entry must be complete (I5); a reader reports the state by name and never picks one reading.
function entryState(section, base = 1) {
  const text = lf(section);
  // Every entry hash line outside a quote counts, whatever its value: a pending line beside a stamped one is a second.
  const stated = entryLines(text);
  const own = stated.filter(line => line.hash);
  const at = index => base + lineAt(text, index) - 1;
  if (stated.length > 1) {
    return { ok: false, state: 'ambiguous', code: ENTRY_AMBIGUOUS, lines: stated.map(line => at(line.index)),
      reason: `${stated.length} entry hash lines outside a quote` };
  }
  const block = find(splitEntryTail(text).head, RECORDED_BLOCK);
  if (own.length === 1 && (!block || own[0].index < block.index || own[0].index >= block.end)) {
    return { ok: false, state: 'ambiguous', code: ENTRY_AMBIGUOUS, lines: [at(own[0].index)],
      reason: 'the entry hash line stands outside the entry\'s Evidence block' };
  }
  // A receipt field the block states twice has two readings: each stands once.
  const repeated = repeatedReceiptField(text);
  if (repeated) {
    return { ok: false, state: 'ambiguous', code: ENTRY_AMBIGUOUS, lines: repeated.lines.map(i => base + i),
      reason: `the Evidence block states ${repeated.field} ${repeated.count} times` };
  }
  if (!entryComplete(text)) {
    return { ok: false, state: 'ambiguous', code: ENTRY_INCOMPLETE, lines: [base],
      reason: `the entry lacks a label (${REQUIRED_LABELS.filter(label => !entryField(withoutSeparator(text), label)).join(', ') || 'a value'})` };
  }
  return { ok: true };
}

const refuse = (code, lines, reason) => ({ ok: false, code, lines: [...new Set(lines)].filter(Number.isInteger), reason });
// A chain that does not verify, by the code it names (a glued or malformed marker line is ambiguous) or as a broken chain.
const chainRefusal = chain => refuse(chain.code || ENTRY_CHAIN_BROKEN, chain.lines || [], chain.reason);
const sameReading = (a, b) => JSON.stringify(entryLines(a).map(l => l.hash)) === JSON.stringify(entryLines(b).map(l => l.hash)) &&
  entryComplete(a) === entryComplete(b) && entryDigest(a) === entryDigest(b);

// Proves a journal or archive write on the texts before and after it, in memory, before the one write. `kind`:
// - 'entry' (record, rehash, attach): I2 the texts differ in one contiguous region inside the own text of the newest
//   entry, and the replaced and the written text are each only line ends or lie inside the entry's recorded Evidence
//   block; I3 every section outside the region keeps its offset (shifted past it) and the count stays; I4 the newest
//   entry has exactly one own entry hash line of any value, inside its block, carrying `hash` (none when `hash` is null); I5 the
//   newest entry is complete before and after; I1 the chain of the result verifies.
// - 'add' (journal add): the result is the text with one new newest entry: every older section byte for byte, the
//   preamble changed only in its trailing white space, the new entry complete with no own entry hash line, the chain
//   verifies.
// - 'shorten' (the archive move of older entries): the move owns two things, the bytes of the entries it moves and one
//   archived-parent marker line of its own in the preamble, and proves its result by reconstruction: the result with
//   that marker line undone and the moved bytes put back at their offset is the old journal byte for byte (no trimming,
//   no line end change), the moved bytes with the `moved` records taken out are separators and blank lines only, the
//   result carries the marker `archivedParent` (or none) and keeps `keep` entries, and the chain verifies.
// - 'append' (the archive): the result is the old bytes followed by the addition, the old records keep their offsets,
//   the addition holds exactly `records` (in order) as dated records, each read as its source reads it (its own hash
//   lines, completeness and digest) and with at most one own entry hash line, the addition with its `sources` (the
//   records by default) taken out in order is framing only (blank lines, separators and record headers), and the
//   archive does not end in a quote.
// - 'newline' (the final line end added at the session stop): one LF added at the end, every reading unchanged.
// Returns { ok: true } or { ok: false, code, lines, reason }.
function checkJournalWrite(before, after, options = {}) {
  const kind = options.kind || 'entry';
  const old = String(before);
  const now = String(after);
  // Bytes given are compared as bytes: a text that does not decode and encode back to them is not UTF-8 text.
  if (Buffer.isBuffer(before) && !Buffer.from(old, 'utf8').equals(before)) return refuse(ENTRY_AMBIGUOUS, [1], 'the file is not UTF-8 text, so a write would change bytes it does not own');
  if (kind === 'append') return checkAppend(old, now, options.records || [], options.sources);
  if (kind === 'newline') {
    if (now !== `${old}\n` || old.endsWith('\n')) return refuse(ENTRY_AMBIGUOUS, [lineAt(old, old.length)], 'the stop writer adds one final line end and nothing else');
    const a = sectionSpans(old).map(s => s.start).join();
    if (a !== sectionSpans(now).map(s => s.start).join()) return refuse(ENTRY_AMBIGUOUS, [lineAt(old, old.length)], 'a final line end moves a section cut');
    const chain = journalChain(now);
    return chain.ok ? { ok: true } : chainRefusal(chain);
  }
  if (kind === 'add') return checkAdd(old, now);
  if (kind === 'shorten') return checkShorten(old, now, options);
  return checkEntry(old, now, options.hash === undefined ? null : options.hash, Boolean(options.restamp));
}

// The receipt field a block states twice, as { field, lines } (line indexes in the text), or null.
function repeatedReceiptField(text) {
  const block = find(splitEntryTail(text).head, RECORDED_BLOCK);
  if (!block) return null;
  const lines = text.slice(block.index, block.end).split('\n');
  for (const field of RECEIPT_FIELDS) {
    const hits = lines.map((line, i) => (new RegExp(`^[ \\t]*-[ \\t]+${field}:`).test(line) ? i : -1)).filter(i => i !== -1);
    if (hits.length > 1) return { field, lines: hits.map(i => lineAt(text, block.index) - 1 + i), count: hits.length };
  }
  return null;
}

// `restamp` (rehash): the block of an entry changed after it was recorded is stamped again, so the replaced block need
// not verify; every other writer replaces only the entry's verified recorded block (its own hash line carries the hash
// of the entry), never an Evidence list of the agent's own or an example the enumeration reads as structure.
function checkEntry(old, now, hash, restamp) {
  const b = sectionSpans(old);
  const a = sectionSpans(now);
  const bi = b.findIndex(s => s.dated);
  const ai = a.findIndex(s => s.dated);
  if (bi === -1 || ai === -1) return refuse(ENTRY_AMBIGUOUS, [], 'no dated entry outside a quote');
  const first = b[bi];
  const newest = a[ai];
  const line = (text, index) => lineAt(text, index);
  if (old !== now) {
    const cr = old.indexOf('\r');
    if (cr !== -1) return refuse(ENTRY_AMBIGUOUS, [line(old, cr)], 'a carriage return: the journal is not LF text, so the write would change line ends outside the entry; ' + CR_CLEAR);
    // The one differing region, aligned from the front and from the back (an inserted run of line ends aligns either
    // way); the write passes when one alignment lies in the newest entry's own text and its Evidence block.
    const prefix = (limit = Infinity) => { let k = 0; while (k < limit && k < old.length && k < now.length && old[k] === now[k]) k++; return k; };
    const suffix = (limit = Infinity) => { let k = 0; while (k < limit && k < old.length && k < now.length && old[old.length - 1 - k] === now[now.length - 1 - k]) k++; return k; };
    const front = prefix();
    const back = suffix();
    const ownOld = ownSpan(first);
    const ownNew = ownSpan(newest);
    const inside = (r, own) => r[0] >= own.start && r[1] <= own.end;
    const recorded = recordedEntryHash(first.text);
    // A block with no entry hash line of its own claims no hash: it is the entry's recorded block when it states the
    // anchor digest in the recorder's form (the minimal and the legacy receipt) and stands where a first record puts
    // it, at the end of the entry's own text; a list of the agent's own, or an example with text after it, is not.
    const receipt = ownOld.block !== null && RECEIPT_DIGEST.test(old.slice(ownOld.block[0], ownOld.block[1])) &&
      /^\s*$/.test(old.slice(ownOld.block[1], ownOld.end));
    const verified = restamp || (recorded !== null ? recorded === entryDigest(first.text) : receipt);
    const placed = (text, r, own, replacing) => /^\n*$/.test(text.slice(r[0], r[1])) ||
      Boolean(own.block && r[0] >= own.block[0] && r[1] <= own.block[1] && (!replacing || verified));
    const alignments = [[front, suffix(Math.min(old.length, now.length) - front)], [prefix(Math.min(old.length, now.length) - back), back]];
    const fits = ([p, s]) => {
      const replaced = [p, old.length - s];
      const written = [p, now.length - s];
      return inside(replaced, ownOld) && inside(written, ownNew) && placed(old, replaced, ownOld, true) && placed(now, written, ownNew, false);
    };
    const chosen = alignments.find(fits);
    // I2: one region inside the newest entry's own text, replacing and writing only line ends or its Evidence block.
    if (bi !== ai || !chosen) {
      return refuse(ENTRY_AMBIGUOUS, [line(old, front), line(old, old.length - back)],
        'the write changes text outside the Evidence block of the newest entry (a construct outside the quote list reads as structure)');
    }
    const [p, s] = chosen;
    const replaced = [p, old.length - s];
    const delta = now.length - old.length;
    const moved = b.map(sec => (sec.start < p ? sec.start : sec.start + delta));
    if (b.some(sec => sec.start >= p && sec.start < replaced[1]) || moved.join() !== a.map(sec => sec.start).join()) {
      return refuse(ENTRY_AMBIGUOUS, [line(old, p)], 'the write moves a section cut');
    }
  }
  // I4 counts every entry hash line of the newest entry outside a quote, whatever its value.
  const stated = entryLines(newest.text);
  const own = stated.filter(l => l.hash);
  const block = ownSpan(newest).block;
  const at = l => line(now, newest.start + l.index);
  if (stated.length > 1 || (hash === null ? own.length !== 0 : own.length !== 1)) {
    const named = stated.length > 1 ? stated : own;
    return refuse(ENTRY_AMBIGUOUS, named.length ? named.map(at) : [line(now, newest.start)], `${named.length} entry hash lines outside a quote in the newest entry`);
  }
  if (hash !== null && (own[0].hash !== hash || !block || newest.start + own[0].index < block[0] || newest.start + own[0].index >= block[1])) {
    return refuse(ENTRY_AMBIGUOUS, [at(own[0])], 'the entry hash line does not carry the hash set inside the entry\'s Evidence block');
  }
  // I5: the newest entry is complete before and after the write.
  if (!entryComplete(first.text) || !entryComplete(newest.text)) {
    const state = entryState(first.text, line(old, first.start));
    return refuse(ENTRY_INCOMPLETE, [line(old, first.start)], state.ok ? 'the newest entry is not complete after the write' : state.reason);
  }
  // The written receipt states each field once, and the entry it certifies carries no credential-shaped value.
  const repeated = repeatedReceiptField(newest.text);
  if (repeated) return refuse(ENTRY_AMBIGUOUS, repeated.lines.map(i => line(now, newest.start) + i), `the Evidence block states ${repeated.field} ${repeated.count} times`);
  const leak = secretKind(newest.text);
  if (leak) return refuse(ENTRY_SECRET, [line(now, newest.start)], `${SECRET_PHRASE}: the newest entry holds a credential-shaped value (${leak}); redact it`);
  // I1: the chain of the result verifies.
  const result = journalChain(now);
  if (!result.ok) return chainRefusal(result);
  return { ok: true };
}

function checkAdd(old, now) {
  const b = sectionSpans(old);
  const a = sectionSpans(now);
  const bPre = b.length && !/^## /.test(b[0].text) ? b[0] : null;
  const aPre = a.length && !/^## /.test(a[0].text) ? a[0] : null;
  const bRest = b.slice(bPre ? 1 : 0);
  const aRest = a.slice(aPre ? 1 : 0);
  const added = aRest[0];
  if ((bPre ? bPre.text : '').trimEnd() !== (aPre ? aPre.text : '').trimEnd() || !added || !added.dated ||
      aRest.length !== bRest.length + 1 || aRest.slice(1).some((sec, i) => sec.text !== bRest[i].text)) {
    return refuse(ENTRY_AMBIGUOUS, [added ? lineAt(now, added.start) : 1], 'the add changes text outside its new entry, or the new entry does not read as one dated section');
  }
  if (entryLines(added.text).some(l => l.hash)) return refuse(ENTRY_AMBIGUOUS, [lineAt(now, added.start)], 'the new entry carries an entry hash line');
  if (!entryComplete(added.text)) return refuse(ENTRY_INCOMPLETE, [lineAt(now, added.start)], 'the new entry is not complete');
  const leak = secretKind(added.text);
  if (leak) return refuse(ENTRY_SECRET, [lineAt(now, added.start)], `${SECRET_PHRASE}: the new entry holds a credential-shaped value (${leak}); redact it`);
  const chain = journalChain(now);
  return chain.ok ? { ok: true } : chainRefusal(chain);
}

// The length of a kept entry's own text with the line end of its last line: the blank lines, one separator line and the
// blank lines after it at the end of the section stand before the next older entry and move with it.
function keptLength(text) {
  const lines = text.split('\n');
  lines.pop();
  const blank = () => lines.length && /^[ \t]*$/.test(lines[lines.length - 1]);
  while (blank()) lines.pop();
  if (lines.length && /^-{3,}[ \t]*$/.test(lines[lines.length - 1])) lines.pop();
  while (blank()) lines.pop();
  return lines.join('\n').length + 1;
}

// Text that is only blank lines and separator lines: what stands between moved records.
const onlySeparators = text => text.split('\n').every(l => /^[ \t]*$|^-{3,}[ \t]*$/.test(l));

function checkShorten(old, now, options) {
  const keep = options.keep;
  const cr = old.indexOf('\r');
  if (cr !== -1) return refuse(ENTRY_AMBIGUOUS, [lineAt(old, cr)], 'a carriage return: the journal is not LF text, so the move would change line ends it does not own; ' + CR_CLEAR);
  const b = sectionSpans(old, DATE_HEADING_REGEX).filter(s => s.dated);
  if (!Number.isInteger(keep) || keep < 0 || b.length <= keep) return refuse(ENTRY_AMBIGUOUS, [1], `the journal has ${b.length} dated entries, none past the ${keep} kept`);
  const cut = keep === 0 ? b[0].start : b[keep - 1].start + keptLength(b[keep - 1].text);
  // The marker line of its own before and after: one at most, and after the move the hash of the newest moved entry.
  const stray = strayMarkers(preamble(old));
  if (stray.length) return strayRefusal(old, stray);
  const before = parentMarkers(preamble(old));
  const after = parentMarkers(preamble(now));
  for (const [text, found] of [[old, before], [now, after]]) {
    if (found.length > 1) return refuse(ENTRY_AMBIGUOUS, found.map(m => lineAt(text, m.start)), `${found.length} archived-parent markers of their own in the preamble`);
  }
  if ((after[0] ? after[0].hash : null) !== (options.archivedParent || null)) return refuse(ENTRY_AMBIGUOUS, [1], 'the archived-parent marker is not the hash of the newest moved entry');
  // The reconstruction: the marker line undone (the line written taken out, the line replaced or removed put back), the
  // moved bytes put back at their offset; the result is the old journal byte for byte.
  const [o, n] = [before[0], after[0]];
  let back = now;
  if (o && n) back = back.slice(0, n.start) + old.slice(o.start, o.end) + back.slice(n.end);
  else if (n) back = back.slice(0, n.start) + back.slice(n.end + 1);
  else if (o) back = back.slice(0, o.start) + old.slice(o.start, o.end + 1) + back.slice(o.start);
  back += old.slice(cut);
  if (back !== old) {
    let at = 0;
    while (at < old.length && back[at] === old[at]) at++;
    return refuse(ENTRY_AMBIGUOUS, [lineAt(old, at)], 'the archive move changes bytes it does not own: with its marker line undone and the moved entries put back the result is not the journal');
  }
  // The moved bytes are the moved records and the separators between them, nothing else.
  let rest = old.slice(cut);
  for (const record of options.moved || []) {
    const at = rest.indexOf(record);
    if (at === -1 || !onlySeparators(rest.slice(0, at))) return refuse(ENTRY_AMBIGUOUS, [lineAt(old, cut)], 'a moved record is not the bytes of a moved entry');
    rest = rest.slice(at + record.length);
  }
  if (!onlySeparators(rest)) return refuse(ENTRY_AMBIGUOUS, [lineAt(old, old.length - rest.length)], 'the moved bytes hold text that no moved record carries');
  if (sectionSpans(now, DATE_HEADING_REGEX).filter(s => s.dated).length !== keep) return refuse(ENTRY_AMBIGUOUS, [1], `the result does not keep ${keep} entries`);
  const chain = journalChain(now);
  return chain.ok ? { ok: true } : chainRefusal(chain);
}

// A record header line of the archive framing.
const RECORD_HEADER = /^### From .+$/;

function checkAppend(old, now, records, sources = records) {
  const cut = DATE_HEADING_REGEX;
  if (!now.startsWith(old)) return refuse(ENTRY_AMBIGUOUS, [lineAt(old, 0)], 'the archive is append only');
  // The reconstruction of the addition: its sources taken out in order leave the framing only.
  let rest = now.slice(old.length);
  let framing = '';
  for (const source of sources) {
    const at = rest.indexOf(source);
    if (at === -1) return refuse(ENTRY_AMBIGUOUS, [lineAt(now, old.length)], 'the addition does not hold an appended record byte for byte');
    framing += `${rest.slice(0, at)}\n`;
    rest = rest.slice(at + source.length);
  }
  framing += rest;
  if (!framing.split('\n').every(l => /^[ \t]*$|^-{3,}[ \t]*$/.test(l) || RECORD_HEADER.test(l))) {
    return refuse(ENTRY_AMBIGUOUS, [lineAt(now, old.length)], 'the addition holds bytes beyond its records and their framing');
  }
  const b = sectionSpans(old, cut).filter(s => s.dated);
  const a = sectionSpans(now, cut).filter(s => s.dated);
  const kept = a.filter(sec => sec.start < old.length);
  const added = a.filter(sec => sec.start >= old.length);
  if (kept.map(s => s.start).join() !== b.map(s => s.start).join() || added.length !== records.length) {
    return refuse(ENTRY_AMBIGUOUS, [lineAt(now, old.length)], `the addition reads as ${added.length} records, not ${records.length}, or moves an old record`);
  }
  for (let i = 0; i < added.length; i++) {
    const own = entryLines(added[i].text);
    if (own.length > 1) return refuse(ENTRY_AMBIGUOUS, own.map(l => lineAt(now, added[i].start + l.index)), `${own.length} entry hash lines outside a quote in one record`);
    if (!sameReading(added[i].text, records[i])) return refuse(ENTRY_AMBIGUOUS, [lineAt(now, added[i].start)], 'an appended record does not read as its source');
  }
  if (openQuote(now)) return refuse(ENTRY_AMBIGUOUS, [lineAt(now, old.length)], 'the archive would end inside an open quote');
  return { ok: true };
}

// The refusal as one message line: its name, the line numbers and the reason, and that nothing was written.
function refusalMessage(result, file) {
  return `${result.code}${file ? ` in ${file}` : ''}${result.lines.length ? ` at line ${result.lines.join(', ')}` : ''}: ${result.reason}; nothing was written.`;
}

module.exports = {
  REQUIRED_LABELS,
  ENTRY_LABELS,
  DATE_HEADING_REGEX,
  DATE_HEADING_M_REGEX,
  ENTRY_HASH_FORMAT,
  fenceMask,
  openQuote,
  unfencedLines,
  splitSections,
  datedSections,
  preamble,
  newestSection,
  withoutSeparator,
  withoutTrailer,
  entryField,
  latestCompleteEntry,
  entryLines,
  quotedEntryLines,
  recordedEntryHash,
  hasEntryHashFormat2,
  canonicalEntryBody,
  entryDigest,
  splitEntryTail,
  journalFrames,
  RECORDED_BLOCK,
  evidenceField,
  parseEvidenceBlock,
  hasEvidenceLabel,
  claimText,
  bindingLines,
  formatWithEvidence,
  setEntryHash,
  addEvidenceLine,
  entryComplete,
  entryState,
  findArchivedParent,
  parentMarkers,
  gluedMarkers,
  journalChain,
  checkJournalWrite,
  refusalMessage,
  ENTRY_AMBIGUOUS,
  ENTRY_INCOMPLETE,
  ENTRY_CHAIN_BROKEN,
  ENTRY_SECRET,
  ENTRY_STALE,
  CR_CLEAR,
};

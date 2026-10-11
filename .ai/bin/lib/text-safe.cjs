'use strict';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const REPLACEMENT = '￼';

// ---------- decode ----------

const POLICY_VALUES = { bom: ['refuse', 'strip'], crlf: ['refuse', 'normalise'], invisible: ['report', 'refuse'], finalNewline: ['report', 'refuse'] };
const POLICY_DEFAULTS = { bom: 'refuse', crlf: 'refuse', invisible: 'report', finalNewline: 'report' };

// The first offset that breaks UTF-8 (shortest form, no surrogates, at most U+10FFFF), or -1.
function firstInvalidUtf8(buf) {
  const n = buf.length;
  let i = 0;
  while (i < n) {
    const b = buf[i];
    if (b < 0x80) { i += 1; continue; }
    let need; let min;
    if (b >= 0xc2 && b <= 0xdf) { need = 1; min = 0x80; }
    else if (b >= 0xe0 && b <= 0xef) { need = 2; min = 0x800; }
    else if (b >= 0xf0 && b <= 0xf4) { need = 3; min = 0x10000; }
    else return i;
    if (i + need >= n) return i;
    let cp = b & (need === 1 ? 0x1f : need === 2 ? 0x0f : 0x07);
    for (let k = 1; k <= need; k++) {
      const c = buf[i + k];
      if (c === undefined || (c & 0xc0) !== 0x80) return i;
      cp = (cp << 6) | (c & 0x3f);
    }
    if (cp < min || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return i;
    i += need + 1;
  }
  return -1;
}

function classify(cp) {
  if (cp === 0) return 'NUL';
  if (cp === 0xa0 || cp === 0x2007 || cp === 0x202f) return 'NBSP';
  if (cp === 0x200b || cp === 0x200c || cp === 0x200d || cp === 0x2060 || cp === 0xfeff || cp === 0xad || cp === 0x180e || cp === 0x34f) return 'ZERO_WIDTH';
  if (cp === 0x61c || cp === 0x200e || cp === 0x200f || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) return 'BIDI';
  if ((cp < 0x20 && cp !== 0x09 && cp !== 0x0a && cp !== 0x0d) || cp === 0x7f || (cp >= 0x80 && cp <= 0x9f)) return 'CONTROL';
  if (cp === 0x2028 || cp === 0x2029) return 'SEPARATOR';
  if (cp >= 0xe0000 && cp <= 0xe007f) return 'TAG';
  return null;
}

const hex = cp => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;

function refused(problems, extra = {}) {
  return { ok: false, text: null, problems, notes: extra.notes || [], bom: Boolean(extra.bom), lineEndings: extra.lineEndings || null, truncatedLastLine: null };
}

function decode(bytes, policy = {}) {
  if (!(bytes instanceof Uint8Array)) return refused([{ code: 'NOT_BYTES', detail: 'decode takes a Buffer or Uint8Array; a string has lost its bytes' }]);
  const pol = { ...POLICY_DEFAULTS };
  for (const key of Object.keys(policy || {})) {
    if (!Object.hasOwn(POLICY_VALUES, key) || !POLICY_VALUES[key].includes(policy[key])) {
      return refused([{ code: 'BAD_POLICY', detail: `policy ${String(key).slice(0, 40)} must be one of ${(POLICY_VALUES[key] || []).join(', ') || 'bom, crlf, invisible, finalNewline'}` }]);
    }
    pol[key] = policy[key];
  }
  const buf = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const bad = firstInvalidUtf8(buf);
  if (bad >= 0) return refused([{ code: 'INVALID_UTF8', detail: `invalid UTF-8 at byte offset ${bad}`, index: bad }]);
  let text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
  const problems = []; const notes = [];
  const hasBom = buf.length >= 3 && buf.subarray(0, 3).equals(BOM);
  if (hasBom) {
    if (pol.bom === 'refuse') problems.push({ code: 'BOM', detail: 'UTF-8 byte order mark at offset 0' });
    else { text = text.slice(1); notes.push({ code: 'BOM_STRIPPED', detail: 'UTF-8 byte order mark at offset 0 removed' }); }
  }
  const lineEndings = { lf: 0, crlf: 0, cr: 0 };
  let firstLoneCr = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 0x0d) {
      if (text.charCodeAt(i + 1) === 0x0a) { lineEndings.crlf += 1; i += 1; }
      else { lineEndings.cr += 1; if (firstLoneCr < 0) firstLoneCr = i; }
    } else if (c === 0x0a) lineEndings.lf += 1;
  }
  if (lineEndings.cr) problems.push({ code: 'LONE_CR', detail: `${lineEndings.cr} CR not followed by LF`, ...where(text, firstLoneCr) });
  if (lineEndings.crlf) {
    if (pol.crlf === 'refuse') problems.push({ code: 'CRLF', detail: `${lineEndings.crlf} CRLF line ending(s)` });
    else if (!lineEndings.cr) { text = text.replace(/\r\n/g, '\n'); notes.push({ code: 'CRLF_NORMALISED', detail: `${lineEndings.crlf} CRLF line ending(s) became LF` }); }
  }
  // Positions are taken on the text as it will be returned (after BOM strip and CRLF normalisation).
  let line = 1; let column = 1;
  for (let i = 0; i < text.length;) {
    const cp = text.codePointAt(i);
    const width = cp > 0xffff ? 2 : 1;
    const cls = classify(cp);
    if (cls === 'NUL') problems.push({ code: 'NUL', detail: 'NUL character', line, column, index: i });
    else if (cls) (pol.invisible === 'refuse' ? problems : notes).push({ code: cls, detail: hex(cp), line, column, index: i });
    if (cp === 0x0a) { line += 1; column = 1; } else column += 1;
    i += width;
  }
  const truncatedLastLine = text.length > 0 && !text.endsWith('\n');
  if (truncatedLastLine) (pol.finalNewline === 'refuse' ? problems : notes).push({ code: 'TRUNCATED_LAST_LINE', detail: 'the last line has no LF' });
  if (text.normalize('NFC') !== text) notes.push({ code: 'NOT_NFC', detail: 'the text is not in Unicode NFC (kept as is)' });
  if (problems.length) return refused(problems, { notes, bom: hasBom, lineEndings });
  return { ok: true, text, problems, notes, bom: hasBom, lineEndings, truncatedLastLine };
}

function where(text, index) {
  let line = 1; let column = 1;
  for (let i = 0; i < index;) {
    const cp = text.codePointAt(i);
    if (cp === 0x0a) { line += 1; column = 1; } else column += 1;
    i += cp > 0xffff ? 2 : 1;
  }
  return { line, column, index };
}

// ---------- maskMarkdown ----------

const CONTAINER_TAGS = ['pre', 'code', 'script', 'style', 'details', 'textarea', 'kbd', 'samp',
  // F3: elements whose content is not the document's own statement, held anywhere outside code:
  // raw-text elements, the template contents and the foreign-content roots svg and math.
  'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext', 'template', 'svg', 'math'];
const LIST_MARKER = /^( *)((?:[-*+]|\d{1,9}[.)]))( +|\t|$)/;
const FENCE_OPEN = /^((?:[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)*[ \t]*)(`{3,}|~{3,})(.*)$/;
const PARITY_FENCE = /^ {0,3}(?:`{3,}|~{3,})/;
const THEMATIC = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const SETEXT_EQ = /^ {0,3}=+[ \t]*$/;
const SETEXT_DASH = /^ {0,3}-+[ \t]*$/;
const ATX = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const LINK_DEF_HEAD = /^(?:[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)*[ \t]*\[/;
const DELIMITER_ROW = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const BLOCK_TAG = /^ {0,3}<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/;
// M5b: CommonMark HTML block start conditions with their end condition (null: a blank line ends the block).
const HTML_BLOCKS = [
  [/^<(?:pre|script|style|textarea)(?=[ \t>]|$)/i, /<\/(?:pre|script|style|textarea)>/i],
  [/^<!--/, /-->/],
  [/^<\?/, /\?>/],
  [/^<!\[CDATA\[/, /\]\]>/],
  [/^<![A-Za-z]/, />/],
  [/^<\/?[A-Za-z][A-Za-z0-9-]*(?=[\s/>]|$)/, null],
];
// M4: raw HTML a browser never shows: [opener, end marker, kind].
const RAW_HTML = [['<!--', '-->', 'html-comment'], ['<![CDATA[', ']]>', 'html-cdata'], ['<?', '?>', 'html-pi']];
// HTML elements whose content the browser reads as text up to their own closing tag; template, svg and
// math are skipped the same way when nested (their content is parsed markup, and skipping their closer
// masks more than letting a container's closing tag inside them count).
const RAW_TEXT = new Set(['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes', 'plaintext', 'template', 'svg', 'math']);
// A CommonMark inline tag: whitespace holds at most one line break; quoted values may hold line breaks.
const WS1 = '(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)';
const WS0 = '(?:[ \\t]*(?:\\n[ \\t]*)?)';
const ATTR = `${WS1}[A-Za-z_:][A-Za-z0-9_.:-]*(?:${WS0}=${WS0}(?:[^"'=<>\`\\x00-\\x20]+|'[^']*'|"[^"]*"))?`;
const INLINE_TAG = new RegExp(`^(?:<[A-Za-z][A-Za-z0-9-]*(?:${ATTR})*${WS0}/?>|</[A-Za-z][A-Za-z0-9-]*${WS0}>)`);
const PUNCT = /[!-/:-@[-`{-~]/;

// Shared lexical readers, with absolute UTF-16 offsets. A consumer chooses whether
// literal link syntax in code is evidence; the grammar is not copied per consumer.
const linkGap = (s, p, stop) => p + /^[ \t]*(?:\n[ \t]*)?/.exec(s.slice(p, stop))[0].length;
function linkDestination(s, p, stop, empty = false) {
  const start = p;
  if (s[p] === '<') {
    p++;
    while (p < stop) {
      if (s[p] === '\\' && PUNCT.test(s[p + 1] || '')) { p += 2; continue; }
      if (s[p] === '>') return { start, end: p + 1 };
      if (s[p] === '<' || s[p] === '\n') return null;
      p++;
    }
    return null;
  }
  let depth = 0;
  while (p < stop && s.charCodeAt(p) > 32 && s.charCodeAt(p) !== 127) {
    if (s[p] === '\\' && PUNCT.test(s[p + 1] || '')) { p += 2; continue; }
    if (s[p] === '(') depth++;
    else if (s[p] === ')') { if (depth === 0) break; depth--; }
    p++;
  }
  return depth === 0 && (p > start || empty) ? { start, end: p } : null;
}
function linkTitleEnd(s, p, stop) {
  const open = s[p], close = open === '(' ? ')' : open;
  if (!['"', "'", '('].includes(open)) return null;
  for (p++; p < stop; p++) {
    if (s[p] === '\\' && PUNCT.test(s[p + 1] || '')) { p++; continue; }
    if (s[p] === close) return p + 1;
    if (open === '(' && s[p] === '(') return null;
  }
  return null;
}
function codeSpanEnd(s, p, stop) {
  let end = p;
  while (s[end] === '`') end++;
  const width = end - p;
  for (let q = end; q < stop;) {
    if (s[q] !== '`') { q++; continue; }
    let next = q; while (s[next] === '`') next++;
    if (next - q === width) return next;
    q = next;
  }
  return null;
}
function linkTail(s, p, stop) {
  if (s[p] !== '(') return null;
  const d = linkDestination(s, linkGap(s, p + 1, stop), stop, true);
  if (!d) return null;
  let q = linkGap(s, d.end, stop);
  // A title REQUIRES separation from the whole balanced destination.
  if (q > d.end && ['"', "'", '('].includes(s[q])) {
    const e = linkTitleEnd(s, q, stop);
    if (e === null) return null;
    q = linkGap(s, e, stop);
  }
  return s[q] === ')' ? { end: q + 1, destinationStart: d.start, destinationEnd: d.end } : null;
}
function readInlineLink(s, start) {
  needText('readInlineLink', s);
  if (s[start] !== '[') return null;
  const blank = /\n[ \t]*(?:\n|$)/.exec(s.slice(start));
  const stop = blank ? start + blank.index : s.length;
  const stack = [{ start, active: false, image: s[start - 1] === '!' }];
  for (let p = start + 1; p < stop; p++) {
    if (s[p] === '\\' && PUNCT.test(s[p + 1] || '')) { p++; continue; }
    if (s[p] === '`') {
      const end = codeSpanEnd(s, p, stop);
      if (end !== null) { p = end - 1; continue; }
      while (s[p + 1] === '`') p++;
      continue;
    }
    if (s[p] === '[') { stack.push({ start: p, active: false, image: s[p - 1] === '!' }); continue; }
    if (s[p] !== ']') continue;
    const label = stack.pop();
    if (!label) return null;
    const tail = label.active && !label.image ? null : linkTail(s, p + 1, stop);
    if (!stack.length) return tail ? { start, labelEnd: p, ...tail } : null;
    if (tail) {
      if (!label.image) for (const parent of stack) parent.active = true;
      p = tail.end - 1;
    }
  }
  return null;
}
function readReferenceDefinition(s, start) {
  needText('readReferenceDefinition', s);
  if (s[start] !== '[') return null;
  const blank = /\n[ \t]*(?:\n|$)/.exec(s.slice(start));
  const stop = blank ? start + blank.index : s.length;
  let p = start + 1;
  while (p < stop && s[p] !== ']') {
    if (s[p] === '\\' && PUNCT.test(s[p + 1] || '')) { p += 2; continue; }
    if (s[p] === '[') return null;
    p++;
  }
  if (p >= stop || p - start > 1000 || !/\S/.test(s.slice(start + 1, p)) || s[p + 1] !== ':') return null;
  const d = linkDestination(s, linkGap(s, p + 2, stop), stop);
  if (!d) return null;
  let end = d.end;
  const q = linkGap(s, end, stop);
  if (q > end) {
    const title = linkTitleEnd(s, q, stop);
    if (title !== null && /^[ \t]*(?:\n|$)/.test(s.slice(title))) end = title;
  }
  if (!/^[ \t]*(?:\n|$)/.test(s.slice(end))) return null;
  return { start, end, destinationStart: d.start, destinationEnd: d.end };
}

// Read syntax, including literal examples when requested by a citation consumer.
// Container markers become spaces; offsets remain those of the original document.
function markdownLinkTargets(text, { literal = false } = {}) {
  needText('markdownLinkTargets', text);
  const out = [];
  const pending = [[0, text.length]];
  while (pending.length) {
    const [from, to] = pending.pop();
    for (let p = from; p < to; p++) {
      if (text[p] === '\\' && PUNCT.test(text[p + 1] || '')) { p++; continue; }
      if (text[p] === '`') {
        const blank = /\n[ \t]*\n/.exec(text.slice(p, to));
        const end = codeSpanEnd(text, p, blank ? p + blank.index : to);
        if (end !== null) {
          if (literal) { let a = p; while (text[a] === '`') a++; let b = end; while (text[b - 1] === '`') b--; pending.push([a, b]); }
          p = end - 1; continue;
        }
      }
      if (text[p] !== '[') continue;
      const r = readInlineLink(text, p);
      if (!r || r.end > to) continue;
      out.push(r);
      // Labels may contain images or literal links but cannot change the outer target.
      pending.push([p + 1, r.labelEnd]);
      p = r.end - 1;
    }
  }
  const lines = text.split('\n');
  const heads = [];
  let offset = 0;
  const view = lines.map(line => {
    let p = 0;
    for (;;) {
      const m = /^ {0,3}(?:>[ \t]?|(?:[-+*]|\d{1,9}[.)])[ \t]+)/.exec(line.slice(p));
      if (!m) break;
      p += m[0].length;
    }
    heads.push(offset + p);
    offset += line.length + 1;
    return ' '.repeat(p) + line.slice(p);
  }).join('\n');
  for (const head of heads) {
    const m = /^ {0,3}\[/.exec(view.slice(head));
    if (!m) continue;
    const r = readReferenceDefinition(view, head + m[0].length - 1);
    if (r && !out.some(c => c.destinationStart < r.destinationEnd && r.destinationStart < c.destinationEnd)) out.push(r);
  }
  return out.sort((a, b) => a.destinationStart - b.destinationStart);
}

const isBlank = s => /^[ \t]*$/.test(s);
// Columns of leading white space, a tab advancing to the next multiple of 4.
function indentOf(s) {
  let col = 0;
  for (const ch of s) {
    if (ch === ' ') col += 1;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

function needText(name, text) {
  if (typeof text !== 'string') throw new TypeError(`${name} takes a decoded string (use decode first)`);
}

// Header presentation: a leading paired emphasis wrapper, optionally followed by
// explanatory punctuation/text. Preserve literal content for the canonical reader.
function unwrapEmphasis(text) {
  needText('unwrapEmphasis', text);
  return text.replace(/^(\*{1,3}|_{1,3})(\S[\s\S]*?)\1(?=$|[\s.,;:!?])/, '$2');
}

// Fenced code blocks (CommonMark): a fence opens with three or more backticks or tildes at most
// three spaces deep, also inside block quotes, and closes with the same character, at least as
// many, and nothing else on the line. Where a reading is uncertain the caller picks the safe side:
// `show` (a hidden line would be an acceptance) ends a fence opened inside a quote when the quote
// ends, ends a fence opened with indentation at a line indented less (the end of a list item), and
// shows the lines of a fence that never closes; `hide` (a visible line would be an acceptance)
// keeps every such line inside the fence, as CommonMark does for an unclosed fence.
function fenceMap(lines, mode = 'hide') {
  const inFence = new Array(lines.length).fill(false);
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const quote = /^(?: {0,3}> ?)*/.exec(lines[i])[0];
    const rest = lines[i].slice(quote.length);
    const indent = /^ */.exec(rest)[0].length;
    const body = rest.slice(indent);
    if (open) {
      const ended = mode === 'show' && ((open.quoted && !quote.includes('>')) || (body !== '' && open.indent > 0 && indent < open.indent));
      if (!ended) {
        inFence[i] = true;
        if (indent <= 3 && new RegExp(`^\\${open.ch}{${open.n},}[ \\t]*$`).test(body)) open = null;
        continue;
      }
      open = null;
    }
    const m = indent <= 3 ? /^(`{3,}|~{3,})(.*)$/.exec(body) : null;
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      inFence[i] = true;
      open = { ch: m[1][0], n: m[1].length, indent, quoted: quote.includes('>'), from: i };
    }
  }
  if (open && mode === 'show') for (let i = open.from; i < lines.length; i++) inFence[i] = false;
  return inFence;
}

function maskMarkdown(text) {
  const { lines, spans } = maskCore(text);
  return { lines, spans };
}

function maskCore(text) {
  needText('maskMarkdown', text);
  if (text.charCodeAt(0) === 0xfeff) throw Object.assign(new TypeError('maskMarkdown: the string starts with U+FEFF (a BOM decoded as text); decode with policy bom first'), { code: 'bom-in-string' });
  const src = text;
  const lines = src === '' ? [] : src.split('\n').map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (src.endsWith('\n')) lines.pop();
  const n = lines.length;
  const spans = [];
  const kinds = lines.map(() => new Set());
  const cover = lines.map(() => []); // [start, end) column intervals per line
  const addSpan = (kind, sl, sc, el, ec, unclosed) => {
    const span = { kind, startLine: sl + 1, startCol: sc, endLine: el + 1, endCol: ec };
    if (unclosed) span.unclosed = true;
    spans.push(span);
    for (let i = sl; i <= el; i++) {
      const from = i === sl ? sc : 0;
      const to = i === el ? ec : lines[i].length;
      cover[i].push([from, Math.max(from, to)]);
      kinds[i].add(kind);
    }
  };
  const wholeLines = (kind, sl, el, unclosed) => addSpan(kind, sl, 0, el, lines[el].length, unclosed);

  // The text as one string (lines joined by LF) for constructs that span lines; starts[i] is the offset of line i.
  const all = lines.join('\n');
  const starts = [];
  for (let i = 0, acc = 0; i < n; i++) { starts.push(acc); acc += lines[i].length + 1; }
  const lineOf = p => { let lo = 0; let hi = n - 1; while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= p) lo = mid; else hi = mid - 1; } return lo; };
  const at = p => { const l = lineOf(p); return [l, p - starts[l]]; };

  // M2: the owner's fence parity.
  const inParity = lines.map(() => false);
  let parity = false; let parityStart = -1;
  for (let i = 0; i < n; i++) {
    if (PARITY_FENCE.test(lines[i])) {
      if (!parity) { parity = true; parityStart = i; } else { parity = false; wholeLines('fence-parity', parityStart, i); for (let j = parityStart; j <= i; j++) inParity[j] = true; }
    }
  }
  if (parity) { wholeLines('fence-parity', parityStart, n - 1, true); for (let j = parityStart; j < n; j++) inParity[j] = true; }

  // The end of a tag whose name ends at p, read as the HTML tokenizer does (attribute values quoted or not,
  // across lines): the offset after its ">", or -1 when the text ends inside the tag.
  const tagEnd = p => {
    const L = all.length;
    const ws = c => c === ' ' || c === '\t' || c === '\n' || c === '\f';
    for (;;) {
      while (p < L && (ws(all[p]) || all[p] === '/')) p += 1;
      if (p >= L) return -1;
      if (all[p] === '>') return p + 1;
      p += 1; // the attribute name (its first character may be anything, "=" included)
      while (p < L && !ws(all[p]) && all[p] !== '/' && all[p] !== '>' && all[p] !== '=') p += 1;
      while (p < L && ws(all[p])) p += 1;
      if (p >= L) return -1;
      if (all[p] !== '=') continue;
      p += 1;
      while (p < L && ws(all[p])) p += 1;
      if (p >= L) return -1;
      const q = all[p];
      if (q === '"' || q === "'") { const e = all.indexOf(q, p + 1); if (e < 0) return -1; p = e + 1; }
      else if (q === '>') return p + 1;
      else while (p < L && !ws(all[p]) && all[p] !== '>') p += 1;
    }
  };
  // A closing tag that may be code (a fence-parity line, 4 columns of indentation, backticks on both sides)
  // is not counted: ignoring it masks more.
  const maybeCode = p => {
    const [l, c] = at(p);
    return inParity[l] || indentOf(lines[l]) >= 4 || (lines[l].lastIndexOf('`', c) >= 0 && lines[l].indexOf('`', c) >= 0);
  };
  // M5: the offset after the closing tag of element `tag` whose content starts at p, or -1.
  const elementEnd = (p, tag) => {
    let depth = 1;
    for (;;) {
      const lt = all.indexOf('<', p);
      if (lt < 0) return -1;
      const raw = RAW_HTML.find(([o]) => all.startsWith(o, lt));
      if (raw || all[lt + 1] === '!') {
        // Comment, CDATA, PI, declaration or bogus comment: skip to the later of the browser's end (the first
        // ">", "-->" for a comment) and the CommonMark end marker.
        const mark = raw ? raw[1] : '>';
        const e = all.indexOf(mark, lt + 2);
        const gt = raw && raw[0] === '<!--' ? e : all.indexOf('>', lt + 2);
        if (e < 0 || gt < 0) return -1;
        p = Math.max(e + mark.length, gt + 1);
        continue;
      }
      const m = /^<(\/?)([A-Za-z][^\s/>]*)/.exec(all.slice(lt, lt + 256));
      if (!m) { p = lt + 1; continue; }
      const end = tagEnd(lt + m[0].length);
      if (end < 0) return -1;
      const name = m[2].toLowerCase();
      if (name === tag) {
        if (!m[1]) depth += 1;
        else if (!maybeCode(lt)) { depth -= 1; if (depth === 0) return end; }
      } else if (!m[1] && RAW_TEXT.has(name)) {
        const re = new RegExp(`</${name}(?=[\\s/>])`, 'gi');
        re.lastIndex = end;
        const c = re.exec(all);
        if (!c) return -1;
        const e2 = tagEnd(c.index + 2 + name.length);
        if (e2 < 0) return -1;
        p = e2;
        continue;
      }
      p = end;
    }
  };
  // M5b: a CommonMark inline tag starting at (i, k): its end [line, col], the string 'limit' when the tag
  // cannot be closed within the 8192-character window (unknown: mask to the end of the document), or
  // null. Never across a blank line.
  const inlineTag = (i, k) => {
    const from = starts[i] + k;
    let slice = all.slice(from, from + 8192);
    const blank = /\n[ \t]*(?:\n|$)/.exec(slice);
    const limited = !blank && all.length - from > 8192;
    if (blank) slice = slice.slice(0, blank.index);
    const m = INLINE_TAG.exec(slice);
    if (m) return at(from + m[0].length);
    return limited && /^<[A-Za-z]/.test(slice) ? 'limit' : null;
  };
  // M14: an inline link or image starting at the "[" offset p: { start, end } covering the whole
  // construct through ")", or null when the CommonMark grammar does not complete it inside one
  // paragraph (then its characters are literal text, as a renderer shows them).
  const inlineLink = p => readInlineLink(all, p);
  // M12: the last line of a link reference definition starting at line i, or -1.
  const linkDefEnd = i => {
    const head = LINK_DEF_HEAD.exec(lines[i]);
    if (!head) return -1;
    const def = readReferenceDefinition(all, starts[i] + head[0].length - 1);
    return def ? lineOf(def.end - 1) : -1;
  };

  // Inline scanner (M3, M4, M5): from (line, col) in a text run; returns the position where block parsing resumes.
  // A code span lives inside one paragraph: it ends at a blank line and at a line that starts a block which
  // interrupts a paragraph (fence, ATX heading, thematic break, quote, HTML block, comment).
  const interrupts = s => isBlank(s) || /^ {0,3}(?:`{3,}|~{3,})/.test(s) || ATX.test(s) || THEMATIC.test(s) || /^ {0,3}>/.test(s) || BLOCK_TAG.test(s) || /^ {0,3}<[!?]/.test(s);
  const findBackticks = (sl, sc, len) => {
    for (let i = sl; i < n; i++) {
      if (i > sl && interrupts(lines[i])) return null;
      const s = lines[i];
      let k = i === sl ? sc : 0;
      while (k < s.length) {
        if (s[k] !== '`') { k += 1; continue; }
        let e = k; while (s[e] === '`') e += 1;
        if (e - k === len) return [i, k, e];
        k = e;
      }
    }
    return null;
  };
  const findText = (sl, sc, needle) => {
    for (let i = sl; i < n; i++) {
      const k = lines[i].indexOf(needle, i === sl ? sc : 0);
      if (k >= 0) return [i, k, k + needle.length];
    }
    return null;
  };
  function scanInline(i, col) {
    let s = lines[i];
    let k = col;
    while (k < s.length) {
      const ch = s[k];
      if (ch === '\\' && k + 1 < s.length && /[!-/:-@[-`{-~]/.test(s[k + 1])) { k += 2; continue; }
      if (ch === '`') {
        let e = k; while (s[e] === '`') e += 1;
        const close = findBackticks(i, e, e - k);
        if (!close) { k = e; continue; }
        addSpan('code-span', i, k, close[0], close[2]);
        i = close[0]; s = lines[i]; k = close[2];
        continue;
      }
      if (ch === '<') {
        // M4: comment, CDATA, processing instruction, declaration.
        const raw = RAW_HTML.find(([o]) => s.startsWith(o, k)) || (/^<![A-Za-z]/.test(s.slice(k, k + 3)) ? ['<!', '>', 'html-declaration'] : null);
        if (raw) {
          const close = findText(i, k + raw[0].length, raw[1]);
          if (!close) { addSpan(raw[2], i, k, n - 1, lines[n - 1].length, true); return n; }
          addSpan(raw[2], i, k, close[0], close[2]);
          i = close[0]; s = lines[i]; k = close[2];
          continue;
        }
        // M5: an element whose content is masked, to its closing tag. plaintext never closes.
        const open = /^<([A-Za-z][A-Za-z0-9-]*)(?=[\s/>]|$)/.exec(s.slice(k));
        if (open && CONTAINER_TAGS.includes(open[1].toLowerCase())) {
          const tag = open[1].toLowerCase();
          const openEnd = tagEnd(starts[i] + k + open[0].length);
          const end = tag === 'plaintext' || openEnd < 0 ? -1 : elementEnd(openEnd, tag);
          if (end < 0) { addSpan(`html-${tag}`, i, k, n - 1, lines[n - 1].length, true); return n; }
          const [el, ec] = at(end);
          addSpan(`html-${tag}`, i, k, el, ec);
          i = el; s = lines[i]; k = ec;
          continue;
        }
        const tag = inlineTag(i, k);
        if (tag === 'limit') { addSpan('html-inline-tag', i, k, n - 1, lines[n - 1].length, true); return n; }
        if (tag) { addSpan('html-inline-tag', i, k, tag[0], tag[1]); i = tag[0]; s = lines[i]; k = tag[1]; continue; }
      }
      if (ch === '[' || (ch === '!' && s[k + 1] === '[')) {
        // M14: an inline link or image; its destination and title are not the document's statement.
        const res = inlineLink(starts[i] + (ch === '!' ? k + 1 : k));
        if (res) {
          const [el, ec] = at(res.end);
          addSpan('inline-link', i, k, el, ec);
          i = el; s = lines[i]; k = ec;
          continue;
        }
      }
      k += 1;
    }
    return i + 1;
  }

  // The block context after an inline span carried the scan from line `from` to line next - 1: a closing line
  // that starts with a tag starts an HTML block of type 6 or 7 (to a blank line; where CommonMark reads a
  // paragraph continuation instead, this masks more); else a blank line crossed ended the context.
  const afterJump = (ctx, from, next) => {
    if (next <= from + 1 || next > n) return ctx;
    if (BLOCK_TAG.test(lines[next - 1])) return 'html-block';
    return lines.slice(from + 1, next).some(isBlank) ? null : ctx;
  };

  let i = 0;
  let context = null; // 'quote' | 'table' | 'html-block' : masks every non-blank line up to a blank line
  let prevPara = false; // the previous line was paragraph text (own)
  let paraStart = -1;
  let listContent = -1; // content column of the open list item, -1 outside a list
  let prevBlank = true;

  // M11: front matter.
  if (n > 0 && lines[0] === '---') {
    let close = -1;
    for (let j = 1; j < n; j++) if (lines[j] === '---') { close = j; break; }
    if (close > 0) { wholeLines('front-matter', 0, close); i = close + 1; }
  }

  while (i < n) {
    const s = lines[i];
    if (isBlank(s)) {
      context = null; prevPara = false; prevBlank = true; i += 1;
      continue;
    }
    const ind = indentOf(s);
    if (listContent >= 0 && prevBlank && ind === 0 && !LIST_MARKER.test(s)) listContent = -1;
    // M1: fenced code, also after list markers and inside a lazy context (not inside an HTML block: M5b).
    const f = context === 'html-block' ? null : FENCE_OPEN.exec(s);
    const fenceOk = f && !(f[2][0] === '`' && f[3].includes('`')) && (f[1].trim() !== '' || indentOf(f[1]) <= 3 + Math.max(0, listContent));
    if (fenceOk) {
      const ch = f[2][0]; const len = f[2].length;
      // The container column: the content column of the list item that holds the fence (0 at top level).
      const marked = f[1].trim() !== '';
      const contentCol = indentOf(f[1].replace(/[-*+]|\d{1,9}[.)]/g, m => ' '.repeat(m.length)));
      const containerCol = marked ? contentCol : (listContent >= 0 && contentCol >= listContent ? listContent : 0);
      let j = i + 1; let end = -1; let implicit = -1;
      for (; j < n; j++) {
        const t = lines[j];
        if (!isBlank(t) && containerCol > 0 && indentOf(t) < containerCol) { implicit = j; break; }
        const c = /^([ \t]*)(`{3,}|~{3,})[ \t]*$/.exec(t);
        if (c && c[2][0] === ch && c[2].length >= len && indentOf(c[1]) <= containerCol + 3) { end = j; break; }
      }
      if (end >= 0) { wholeLines('fence', i, end); i = end + 1; }
      else if (implicit >= 0) { wholeLines('fence', i, implicit - 1); i = implicit; }
      else { wholeLines('fence', i, n - 1, true); i = n; }
      context = null; prevPara = false; prevBlank = false;
      continue;
    }
    if (context) {
      wholeLines(context, i, i);
      // An element or comment opened inside a lazy line still runs to its own end.
      const next = scanInline(i, 0);
      context = afterJump(context, i, next);
      i = Math.max(i + 1, next); prevBlank = false; prevPara = false;
      continue;
    }
    // M8: indented code.
    const codeCol = listContent >= 0 ? listContent + 4 : 4;
    if (ind >= codeCol && !prevPara) {
      wholeLines('indented-code', i, i);
      i += 1; prevBlank = false;
      continue;
    }
    // M6: block quotes (after optional list markers).
    if (/^[ \t]*(?:(?:[-*+]|\d{1,9}[.)])[ \t]+)*>/.test(s)) {
      wholeLines('quote', i, i); prevPara = false; prevBlank = false;
      const next = scanInline(i, 0); // raw HTML or an element opened in the quote runs to its own end
      context = afterJump('quote', i, next);
      i = Math.max(i + 1, next);
      continue;
    }
    if (/^[ \t]*\|/.test(s) || (s.includes('|') && i + 1 < n && DELIMITER_ROW.test(lines[i + 1]) && lines[i + 1].includes('-'))) {
      wholeLines('table', i, i);
      const next = scanInline(i, 0);
      context = afterJump('table', i, next);
      i = Math.max(i + 1, next); prevPara = false; prevBlank = false;
      continue;
    }
    // M10: setext underline or thematic break.
    if ((SETEXT_EQ.test(s) || SETEXT_DASH.test(s)) && prevPara && listContent < 0) {
      for (let p = paraStart; p < i; p++) kinds[p].add('setext-heading');
      wholeLines('setext-underline', i, i); prevPara = false; prevBlank = false;
      i += 1;
      continue;
    }
    if (THEMATIC.test(s)) {
      wholeLines('thematic-break', i, i); prevPara = false; prevBlank = false; i += 1;
      continue;
    }
    // M12: link reference definitions (also after list markers; a definition does not interrupt a paragraph).
    const defEnd = !prevPara || LIST_MARKER.test(s) ? linkDefEnd(i) : -1;
    if (defEnd >= 0) {
      wholeLines('link-definition', i, defEnd); prevPara = false; prevBlank = false; i = defEnd + 1;
      continue;
    }
    // M5b: HTML blocks of the seven CommonMark types.
    const hb = ind <= 3 + Math.max(0, listContent) ? HTML_BLOCKS.find(([start]) => start.test(s.trimStart())) : null;
    if (hb && hb[1]) {
      const lead = s.length - s.trimStart().length;
      const opener = hb[0].exec(s.trimStart())[0].length;
      let end = -1;
      for (let j = i; j < n && end < 0; j++) if (hb[1].test(j === i ? s.slice(lead + opener) : lines[j])) end = j;
      const last = end < 0 ? n - 1 : end;
      wholeLines('html-block', i, last, end < 0);
      let k = i;
      while (k <= last) k = Math.max(k + 1, scanInline(k, 0));
      context = null; prevPara = false; prevBlank = false; i = k;
      continue;
    }
    if (hb) {
      wholeLines('html-block', i, i); prevPara = false; prevBlank = false;
      const next = scanInline(i, 0);
      context = afterJump('html-block', i, next);
      i = Math.max(i + 1, next);
      continue;
    }
    // Own text: heading, list item or paragraph; inline constructs inside it.
    const lm = LIST_MARKER.exec(s);
    if (lm && !(prevPara && listContent < 0 && !/^ {0,3}(?:[-*+]|1[.)])/.test(s))) {
      kinds[i].add('list-item');
      listContent = lm[1].length + lm[2].length + (lm[3] === '\t' ? 4 - ((lm[1].length + lm[2].length) % 4) : Math.max(1, lm[3].length));
    }
    if (ATX.test(s)) { kinds[i].add('heading'); prevPara = false; }
    else { if (!prevPara) paraStart = i; prevPara = true; }
    prevBlank = false;
    const next = scanInline(i, 0);
    if (next > i + 1) { prevPara = false; context = afterJump(null, i, next); }
    i = Math.max(i + 1, next);
  }

  const out = lines.map((t, idx) => {
    const iv = cover[idx].slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    let reach = 0; let covered = 0;
    for (const [a, b] of iv) {
      if (b <= reach) continue;
      covered += b - Math.max(a, reach);
      reach = b;
    }
    const inSpan = iv.length > 0;
    const masked = inSpan && covered >= t.length;
    return { line: idx + 1, text: t, masked, partial: inSpan && !masked, kinds: [...kinds[idx]].sort() };
  });
  spans.sort((a, b) => a.startLine - b.startLine || a.startCol - b.startCol || a.endLine - b.endLine || a.endCol - b.endCol || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0));
  return { lines: out, spans, cover };
}

// ---------- ownLines ----------

// Merged [start, end) intervals, ordered.
function merged(iv) {
  const out = [];
  for (const [a, b] of iv.slice().sort((x, y) => x[0] - y[0] || x[1] - y[1])) {
    if (out.length && a <= out[out.length - 1][1]) out[out.length - 1][1] = Math.max(out[out.length - 1][1], b);
    else out.push([a, b]);
  }
  return out;
}

function ownLines(text, opts = {}) {
  const mode = opts.partial === undefined ? 'exclude' : opts.partial;
  if (mode !== 'exclude' && mode !== 'include') throw new TypeError("ownLines: opts.partial must be 'exclude' or 'include'");
  const m = maskCore(text);
  const result = [];
  for (const l of m.lines) {
    if (l.masked) continue;
    if (l.partial && mode === 'exclude') continue;
    if (!l.partial) { result.push({ line: l.line, text: l.text, partial: false }); continue; }
    let outText = ''; let pos = 0;
    for (const [a, b] of merged(m.cover[l.line - 1])) {
      outText += l.text.slice(pos, a) + REPLACEMENT;
      pos = b;
    }
    outText += l.text.slice(pos);
    result.push({ line: l.line, text: outText, partial: true });
  }
  return result;
}

// ---------- parseFrontMatterStrict ----------

const KEY = /^[a-z][a-z0-9_]*$/;
const RESERVED_LEAD = new Set(['"', "'", '&', '*', '!', '|', '>', '{', '}', '%', '@', '`', '#', ',', ';']);

// F5: what is refused in a value (scalar or list item); null when the value is kept verbatim.
function scalarProblem(value) {
  if (value === '') return 'empty value';
  if (value !== value.trim() || /^[ \t]|[ \t]$/.test(value)) return 'surrounding spaces';
  if (RESERVED_LEAD.has(value[0])) return `leading "${value[0]}" is a reserved first character`;
  if (/[ \t]#/.test(value)) return '" #" is a comment marker';
  if (/^- /.test(value) || value === '-') return 'leading "- " is a list item marker';
  if (/^\? |^: /.test(value)) return 'leading "? " or ": " is a reserved first form';
  if (/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value)) return 'control character';
  return null;
}

// F5: a "key: value" scalar: { value } or { problem }. records.cjs refuses "#" anywhere in a scalar.
function scalarOf(raw) {
  const p = scalarProblem(raw) || (raw.includes('#') ? '"#" in a scalar is a comment marker (records.cjs)' : null);
  return p ? { problem: p } : { value: raw };
}

function parseFrontMatterStrict(text, opts = {}) {
  const errors = [];
  const err = (code, line, detail, key) => errors.push(key === undefined ? { code, line, detail } : { code, key, line, detail });
  needText('parseFrontMatterStrict', text);
  const src = text;
  if (src.charCodeAt(0) === 0xfeff) return { ok: false, present: null, data: null, endLine: null, errors: [{ code: 'BOM', line: 1, detail: 'a BOM before the front matter' }] };
  if (!src.startsWith('---\n')) {
    if (src.startsWith('---\r')) return { ok: false, present: null, data: null, endLine: null, errors: [{ code: 'CR', line: 1, detail: 'CR in front matter; use LF' }] };
    return { ok: true, present: false, data: null, endLine: null, errors: [] };
  }
  const lines = src.split('\n');
  let close = -1;
  for (let i = 1; i < lines.length; i++) if (lines[i].replace(/\r$/, '') === '---') { close = i; break; }
  if (close < 0) return { ok: false, present: true, data: null, endLine: null, errors: [{ code: 'UNCLOSED', line: 1, detail: 'front matter is not closed by a --- line' }] };
  if (lines[close] !== '---') err('CR', close + 1, 'CR in front matter; use LF');
  const schema = opts.keys || null;
  const seen = new Map(); // key -> [lines]
  const values = new Map();
  for (let i = 1; i < close; i++) {
    const raw = lines[i]; const n = i + 1;
    if (raw.includes('\r')) { err('CR', n, 'CR in front matter; use LF'); continue; }
    if (raw.includes('\t')) { err('TAB', n, 'tab in front matter'); continue; }
    if (/^\s+-/.test(raw)) { err('MALFORMED_LIST', n, 'a block item: the kernel grammar has no block lists (records.cjs refuses them)'); continue; }
    const m = /^([^:\s][^:]*):(?: (.*))?$/.exec(raw);
    if (!m || !KEY.test(m[1])) { err('MALFORMED_LINE', n, 'not a "key: value" or "key: [a, b]" line of the grammar'); continue; }
    const key = m[1]; const value = m[2];
    if (value === undefined) { err('MALFORMED_LINE', n, 'a bare "key:" line: the kernel grammar has no block lists (records.cjs refuses them)', key); continue; }
    if (!seen.has(key)) seen.set(key, []);
    seen.get(key).push(n);
    if (seen.get(key).length > 1) { values.delete(key); continue; }
    if (value.startsWith('[')) {
      if (!value.endsWith(']')) { err('MALFORMED_LIST', n, 'flow list not closed by "]"', key); continue; }
      const inner = value.slice(1, -1);
      const items = inner === '' ? [] : inner.split(', ');
      const bad = items.map(scalarProblem).find(Boolean) || (items.some(x => /[[\],]/.test(x)) ? 'a list item holds "[", "]" or ","' : null);
      if (bad) { err('MALFORMED_LIST', n, `flow list: ${bad} (items are separated by ", ")`, key); continue; }
      values.set(key, items);
      continue;
    }
    const sc = scalarOf(value);
    if (sc.problem) { err('BAD_SCALAR', n, sc.problem, key); continue; }
    values.set(key, sc.value);
  }
  for (const [key, at] of seen) {
    if (at.length > 1) { err('DUPLICATE_KEY', at[0], `key "${key}" appears on lines ${at.join(', ')}`, key); errors[errors.length - 1].lines = at.slice(); }
  }
  if (schema) {
    for (const [key, v] of values) {
      if (!Object.hasOwn(schema, key)) { err('UNKNOWN_KEY', seen.get(key)[0], `key "${key}" is not in the grammar`, key); continue; }
      const shape = Array.isArray(v) ? 'list' : 'scalar';
      if (schema[key] !== shape) err('WRONG_SHAPE', seen.get(key)[0], `${schema[key]} expected, ${shape} given`, key);
    }
  }
  errors.sort((a, b) => a.line - b.line || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0));
  const data = {};
  for (const key of [...values.keys()].sort()) data[key] = values.get(key);
  return errors.length
    ? { ok: false, present: true, data: null, endLine: close + 1, errors }
    : { ok: true, present: true, data, endLine: close + 1, errors };
}

// JSON syntax belongs to JSON.parse; this additional shared guard refuses duplicate
// decoded keys in EACH object before a consumer can accept last-key-wins data.
// Tokens inside strings are never structural; escaped spellings compare by value.
// Errors carry codes only, never input data. Does not decode bytes: use decode first.
function parseJsonUnique(text) {
  const bad = code => { const e = new Error(code); e.code = code; throw e; };
  if (typeof text !== 'string') bad('JSON_NOT_TEXT');
  let value;
  try { value = JSON.parse(text); } catch { bad('JSON_SYNTAX'); }
  const stack = [];
  const tokens = /"(?:\\.|[^"\\])*"\s*:?|[{}\[\]]/g;
  for (const match of text.matchAll(tokens)) {
    const token = match[0];
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token.endsWith(':')) {
      const key = JSON.parse(token.slice(0, -1).trimEnd());
      const keys = stack[stack.length - 1];
      if (keys.has(key)) bad('JSON_DUPLICATE_KEY');
      keys.add(key);
    }
  }
  return value;
}

module.exports = { unwrapEmphasis, fenceMap, readInlineLink, readReferenceDefinition, markdownLinkTargets, decode, maskMarkdown, ownLines, parseFrontMatterStrict, firstInvalidUtf8, CONTAINER_TAGS, parseJsonUnique };

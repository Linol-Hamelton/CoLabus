'use strict';
// hostile-corpus.cjs - the shared deterministic generator of hostile variants of a canonical
// sample (the K2-INTEGRITY technical integrity contract of the draft record P-L9-002;
// DEFECT-CLASSES.md classes 1, 2, 4, 5, 6). CommonJS, no dependencies, pure (no file, no
// clock, no environment, no randomness): the same sample and the same runtime Unicode tables
// give byte-identical variants on every machine and in every working directory (the invisible
// set is DERIVED from the runtime's tables and the tests pin its count, so a Unicode-data
// change is loud, never silent).
//
// The contract it serves (draft P-L9-002): a reader of human-written or external text declares
// ONE canonical form and a declared scope per source, and inside the scope any non-canonical
// input makes the result unknown or a refusal with a named reason - never a number, a pass or a
// silent skip. This file does not decide what is canonical; it manufactures the attacks so a
// test can prove the reader's own answer.
//
// variants(sample, opts) -> [{ kind, name, text }]
//   sample  a non-empty string, well formed (no lone surrogate), no CR, no NUL, with at least
//           one non-blank data line. LF is allowed (a multi-line sample is a whole document to
//           a document reader). Everything else is refused (BAD_SAMPLE): the generator never
//           guesses.
//   opts.kinds  a non-empty subset of KINDS, without duplicates (closed grammar; an unknown kind
//           is refused with UNKNOWN_KIND, an empty or duplicated list with BAD_OPTIONS: an
//           empty scope is never a clean result). Default: every kind.
//   opts.line   for the line-oriented kinds: damage only this line (1-based, as the file is
//           read). A blank or out-of-range line is refused (BAD_OPTIONS). Default: every
//           non-blank data line in turn, so a document reader is probed on every line it may
//           judge, not only the first.
//   Each variant is { kind, name, text }. A NAMED MARKER entry has text null: it records a fact
//   the corpus cannot honestly attack instead of fabricating a fake twin - a placeholder equal
//   to the canonical sample (placeholder-<name>-equals-sample), a sample without a composable
//   character (normalisation-not-applicable), a sample without LF for the two line-ending
//   byte damages (bytes-crlf-not-applicable, bytes-lone-cr-not-applicable), or a Markdown
//   container kind of a sample outside the closed allow-list (markdown-<container>-
//   not-applicable, reason sample-not-plain). Markers are notes,
//   not attacks: acceptedBy skips them, and a scope whose filter selects only markers is
//   refused (EMPTY_SCOPE), never an empty clean result.
//   Line-oriented kinds (invisible, the homoglyph lookalikes, bytes-lone-surrogate and the
//   markdown indented/list-item/setext/lazy-continuation containers) damage one line at a time.
//   For a multi-line sample the name carries the line (-l2 for line 2); a single-line sample
//   keeps the plain name. Insertion into a line is by CODE POINT, so an astral character is
//   never split into lone surrogates. EXACTLY ONE INTENDED DIFFERENCE (H1): every
//   variant preserves the sample's own line endings and final-newline state byte for byte -
//   no maker appends a carrier LF the canonical lacks, and the tests prove it by removing the
//   declared damage and comparing the result with the canonical byte for byte. The count of
//   entries per kind is fixed for single-line samples of every kind except normalisation,
//   whose yield is the sample's own other spelling(s): one, two or the named marker (counts()
//   publishes the counts of its own probe and the tests assert them); for multi-line samples
//   the line-oriented kinds scale with the number of data lines.
//
// Kinds (counts() at the time of writing, for a single-line probe sample: invisible 4207,
// lookalike 7, normalisation 1 (the marker, for its ASCII probe), bytes 4 (BOM, the lone
// surrogate and the two line-ending markers - the probe sample has no LF to convert),
// placeholder 7, markdown 11, path 6, json 4; total 4247):
//   invisible       every code point of \p{Default_Ignorable_Code_Point} or
//                   \p{General_Category=Format} plus the named fillers U+115F, U+1160, U+3164,
//                   U+FFA0, U+2800, inserted after the first code point of the damaged line (not
//                   at an end, so trimming cannot hide them). The set is DERIVED from the
//                   Unicode properties of the runtime, never hand-picked; which of them the
//                   shared text-safe decode refuses today is pinned in
//                   the hostile-corpus regression tests.
//   lookalike       full-width alphanumerics over the whole sample, and Cyrillic/Greek
//                   homoglyphs of P/a/o, U+2011 and U+2212 for the hyphen-minus, one line at
//                   a time: visually the sample, canonically not.
//   normalisation   every distinct spelling of the sample itself among NFC and NFD, the sample
//                   excluded: an NFC sample yields its NFD spelling, an NFD sample its NFC
//                   spelling, a sample in neither form yields both spellings - including
//                   SINGLETON decompositions such as U+212B ANGSTROM SIGN (NFC U+00C5, NFD
//                   A+U+030A: both spellings) and U+2126 OHM SIGN or U+212A KELVIN SIGN
//                   (NFC and NFD are the same other spelling: yielded once). The named marker
//                   normalisation-not-applicable appears ONLY when NFC, NFD and the sample
//                   are all equal - never a fake twin.
//   bytes           BOM before the sample; the sample with EVERY LF converted to CRLF (a
//                   document saved with Windows endings) and with EVERY LF converted to a
//                   lone CR (the classic pre-OS-X ending), one variant each over the whole
//                   document: the sample's own line endings converted, nothing else added -
//                   a sample without LF yields its named not-applicable marker, never a
//                   carrier ending the sample lacks; and a lone surrogate (U+D800) before
//                   the damaged line. A lone surrogate encoded to UTF-8 arrives at the
//                   reader as U+FFFD; a reader that consumes JS strings sees a string
//                   that isWellFormed() rejects. Both are hostile forms.
//   placeholder     the sample replaced by a placeholder value: -, TBD, n/a, unknown, ?, the
//                   empty string, whitespace. A placeholder never matches a canonical value; a
//                   placeholder equal to the sample is a named marker, never a fake attack.
//   markdown        the sample inside a container a reader must not read as the document's own
//                   statement: fenced, unclosed fence, HTML block, details, HTML comment,
//                   block quote (EVERY real line quoted; the final LF is not a line), a second
//                   table, and - line by line - indented code, list item, setext underline,
//                   lazy continuation of a quote. The containers are produced ONLY for a
//                   plain sample - every line of the sample inside the closed allow-list of
//                   the corpus contract (ASCII letters, digits, the space and the eleven
//                   punctuation characters . , : ; / ( ) ' -, no line starting with a
//                   character that can begin a Markdown block, no blank line), decided by
//                   the ONE function isPlainSample (the strict requirement C1). For any
//                   other sample each container kind yields its named not-applicable entry
//                   with the reason 'sample-not-plain': the corpus does not emulate
//                   CommonMark container semantics (each earlier defect repair found
//                   another container rule the emulation did not model, and a lenient
//                   emulation never terminates), so it never fabricates a wrap that would
//                   leak the sample's later lines as the document's own text and never
//                   falsely accuses an honest mask-following reader. For a plain sample
//                   the bytes sit inside the container unchanged; a closing marker that
//                   must start on its own line is preceded by the one separator LF - the
//                   single intended structural addition, which belongs to the container,
//                   never to the sample - and the wrapped variant keeps the sample's
//                   final-newline state: an LF after the closing marker only when the
//                   sample ends with one. A plain sample is held by every container (its
//                   lines cannot close or end one early), so no container of a plain
//                   sample is ever replaced by a marker.
//                   The text-safe mask classifies list-item and setext text as own; a reader
//                   that requires a first-column canonical row must still refuse them, and
//                   the adoption helper lets each test declare its scope (see acceptedBy).
//   path            the sample used as a path or a path segment: a drive letter, a UNC prefix,
//                   a .. segment, a middle segment with a common link name, a trailing dot, a
//                   trailing space.
//   json            the sample embedded in a JSON form with duplicate key, as a non-object row,
//                   with a huge integer, with NaN text.
//
// counts() -> { kind: count }  the stable counts of a single-line probe sample, asserted by the
//            tests (markers included: they are entries).
// KINDS    the frozen list of kind names.
//
// acceptedBy(read, sample, opts) -> [{ kind, name, text, outcome }]
//   The adoption helper (I3): a test says "every variant of this canonical sample must be
//   refused or unknown" in a few lines. read(text) is the reader under test (any return value);
//   opts.isRefusal(outcome, variant) decides what counts as refused or unknown for THAT reader
//   (required: the refusal grammar belongs to the reader, never to the generator). The helper
//   first proves the canonical sample is not refused (opts.isRefusal(read(sample)) must be
//   false, else MISCONFIGURED_CANONICAL), then returns the variants the reader ACCEPTED anyway
//   - each a defect to fix or to report. opts.kinds and opts.filter(variant) narrow the scope
//   the test declares for its reader (a reader whose source is not JSON does not owe an answer
//   for json kinds, but a silent acceptance inside its scope is a finding). A narrowed scope
//   that selects no attack (empty kinds, a filter that selects nothing, a filter that keeps
//   only markers) is refused with EMPTY_SCOPE: a vacuous clean is an error, never a result.
//   opts.markers  the acknowledgment. A scope that holds named markers (the entries with text
//   null: facts the corpus cannot honestly attack for this sample - a placeholder equal to
//   the sample, a sample without a composable character, the two line-ending damages of a
//   sample without LF, a container kind of a sample outside the closed allow-list) must declare markers:"skip" to
//   acknowledge them; without it the helper refuses with MARKERS_UNDECLARED, naming every
//   marker in scope. Markers are notes, never attacks, and are never fed to the reader - but
//   dropping them SILENTLY would let a reader that normalises away exactly what a marker
//   stands for be reported clean, so the drop is always explicit. An acknowledgment for a
//   scope that holds no markers is refused (BAD_OPTIONS): the acknowledgment names a fact, it
//   is never boilerplate. A reader of file lines owes a final-LF sample: there the
//   line-ending damages are attacks, not markers, and the helper catches the reader that
//   accepts them. opts is validated like variants: a null, non-object or array options value
//   is BAD_OPTIONS.

const INVISIBLE_FILLERS = Object.freeze([0x115f, 0x1160, 0x3164, 0xffa0, 0x2800]);

// The derived invisible set: \p{Default_Ignorable_Code_Point} plus \p{General_Category=Format}
// plus the named fillers. Derived once per process from the runtime's Unicode tables; the tests
// pin the count, so a Unicode-data change is loud, never silent.
let INVISIBLE_CPS = null;
function invisibleCodePoints() {
  if (INVISIBLE_CPS === null) {
    const di = new RegExp('^\\p{Default_Ignorable_Code_Point}$', 'u');
    const cf = new RegExp('^\\p{General_Category=Format}$', 'u');
    const out = [];
    for (let cp = 1; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      const ch = String.fromCodePoint(cp);
      if (di.test(ch) || cf.test(ch)) out.push(cp);
    }
    for (const f of INVISIBLE_FILLERS) if (!out.includes(f)) out.push(f);
    out.sort((a, b) => a - b);
    INVISIBLE_CPS = out;
  }
  return INVISIBLE_CPS;
}

const PLACEHOLDERS = [
  ['dash', '-'],
  ['tbd', 'TBD'],
  ['n-a', 'n/a'],
  ['unknown', 'unknown'],
  ['question', '?'],
  ['empty', ''],
  ['whitespace', '   '],
];

const HOMOGLYPHS = [
  ['cyrillic-capital-p', 'P', '\u0420'],
  ['cyrillic-small-a', 'a', '\u0430'],
  ['cyrillic-small-o', 'o', '\u043e'],
  ['greek-capital-rho', 'P', '\u03a1'],
  ['non-breaking-hyphen', '-', '\u2011'],
  ['minus-sign', '-', '\u2212'],
];

// The separator LF of the whole-document markdown containers: the sample followed by exactly
// one LF, so a closing marker that must start on its own line starts on its own line. It is
// the SINGLE intended structural addition of the paired containers (fence, HTML block,
// details, comment) and belongs to the container, never to the sample: the wrapped variant
// keeps the sample's final-newline state - it ends with an LF after the closing marker only
// when the sample ends with one, and no maker adds a blank line that would change which
// container a reader sees.
const e = s => (s.endsWith('\n') ? s : s + '\n');
// The closing marker keeps the sample's final-newline state: an LF after it only when the
// sample ends with one.
const end = s => (s.endsWith('\n') ? '\n' : '');

// The lines of the sample: a trailing LF is the file's final newline, not a line.
function sampleLines(sample) {
  const ls = sample.split('\n');
  if (ls[ls.length - 1] === '') ls.pop();
  return ls;
}

// (the strict requirement C1) The corpus contract for the Markdown container kinds: a CLOSED
// ALLOW-LIST, never an emulation of CommonMark container semantics. The container kinds are
// produced ONLY for a plain sample - every line consists of characters from the closed
// allow-list (ASCII letters, digits, the space, and the eleven punctuation characters
// . , : ; / ( ) ' -), no line starts with a character that can begin a Markdown block, and
// the sample holds no blank line. For any other sample each container kind yields its named
// not-applicable entry with the reason 'sample-not-plain'. The list is closed: a character or
// shape it does not name does not exist for the container kinds, whatever a lenient emulation
// of the container semantics would do with it - each earlier defect repair found another
// container rule the emulation did not model (a lenient emulation never terminates), so the
// emulation is removed and the whole contract is decided by ONE function.
const PLAIN_LINE = /^[A-Za-z0-9 .,:;/()'-]*$/;
// The characters that can begin a Markdown block other than a paragraph (indented code, a
// fence, an HTML block, a heading, a list bullet or an ordered-list marker, a quote, a setext
// underline, a table row): a sample line that starts with one of them is not plain.
const PLAIN_BLOCK_START = new Set([' ', '\t', '-', '+', '*', '>', '`', '~', '<', '#', '=', '|',
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9']);
// The eleven container kinds of the markdown kind: each is produced only for a plain sample
// and yields its named not-applicable entry with the reason 'sample-not-plain' otherwise.
const PLAIN_MARKDOWN_KINDS = Object.freeze(['fence', 'unclosed-fence', 'html-block', 'details',
  'comment', 'quote', 'indented', 'list-item', 'setext', 'lazy-continuation', 'second-table']);
// (the strict requirement C1) The ONE function of the corpus contract for the container
// kinds: is this sample plain - every line inside the closed allow-list, no line starting
// with a character that can begin a Markdown block, no blank line?
function isPlainSample(sample) {
  for (const line of sampleLines(sample)) {
    if (!PLAIN_LINE.test(line)) return false; // a character outside the closed allow-list
    if (line.trim() === '') return false; // a blank line (the allow-list holds no other white space)
    if (PLAIN_BLOCK_START.has(line[0])) return false; // a line that can begin a Markdown block
  }
  return true;
}

// The 0-based indices of the lines a line-oriented kind damages: every non-blank (data) line,
// or the one declared line when opts.line is given.
function targetIndices(sample, opts) {
  const ls = sampleLines(sample);
  if (opts.line !== undefined) return [opts.line - 1];
  const data = [];
  ls.forEach((l, i) => { if (l.trim() !== '') data.push(i); });
  return data;
}

// Plain names for single-line samples, line-numbered names (-l2 for line 2) for multi-line ones.
function lineName(base, ls, li) {
  return ls.length > 1 ? base + '-l' + (li + 1) : base;
}

// Rebuild the document from damaged lines, preserving the sample's own final-newline state
// byte for byte: a carrier LF would be a SECOND, unintended difference between the variant
// and the canonical sample (H1).
const rebuild = (ls, finalLf) => ls.join('\n') + (finalLf ? '\n' : '');
function damageLine(ls, li, fn, finalLf) {
  const out = ls.slice();
  out[li] = fn(out[li]);
  return rebuild(out, finalLf);
}
function insertLineBefore(ls, li, extra, finalLf) { return rebuild([...ls.slice(0, li), extra, ...ls.slice(li)], finalLf); }
function insertLineAfter(ls, li, extra, finalLf) { return rebuild([...ls.slice(0, li + 1), extra, ...ls.slice(li + 1)], finalLf); }

// Insert the hostile code point after the FIRST CODE POINT of the line: an astral first
// character is never split into lone surrogates, and the insertion stays inside the line.
function insertAfterFirstCodePoint(line, ch) {
  const cps = Array.from(line);
  return cps.length ? cps[0] + ch + cps.slice(1).join('') : ch + line;
}

// Replace the first occurrence of `from` in the line; when it is absent, prefix the line with
// the hostile code point so the count of the kind never depends on the sample.
const firstOrPrefix = (line, from, to) => (line.includes(from) ? line.replace(from, to) : to + line);

// fullwidth: digits U+0030..U+0039 -> U+FF10..U+FF19, letters a-z -> U+FF41.., A-Z -> U+FF21..
function toFullwidth(text) {
  return text.replace(/[0-9A-Za-z]/g, ch => {
    const c = ch.charCodeAt(0);
    if (c >= 0x30 && c <= 0x39) return String.fromCodePoint(c + 0xfee0);
    if (c >= 0x41 && c <= 0x5a) return String.fromCodePoint(c - 0x41 + 0xff21);
    return String.fromCodePoint(c - 0x61 + 0xff41);
  });
}

const KINDS = Object.freeze(['invisible', 'lookalike', 'normalisation', 'bytes', 'placeholder', 'markdown', 'path', 'json']);

function fail(code, detail) {
  throw Object.assign(new Error(code + (detail ? ': ' + detail : '')), { code });
}

function checkSample(sample) {
  if (typeof sample !== 'string' || sample.length === 0) fail('BAD_SAMPLE', 'a non-empty string');
  if (sample.includes('\r')) fail('BAD_SAMPLE', 'no CR in the canonical sample');
  if (sample.includes('\u0000')) fail('BAD_SAMPLE', 'no NUL in the canonical sample');
  if (!sample.isWellFormed()) fail('BAD_SAMPLE', 'no lone surrogate in the canonical sample');
  if (!sample.split('\n').some(l => l.trim() !== '')) fail('BAD_SAMPLE', 'at least one non-blank data line');
}

function checkOpts(sample, opts) {
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) fail('BAD_OPTIONS', 'an options object');
  if (opts.kinds !== undefined) {
    if (!Array.isArray(opts.kinds)) fail('BAD_OPTIONS', 'kinds is an array');
    if (opts.kinds.length === 0) fail('BAD_OPTIONS', 'kinds is a non-empty array: an empty kind list is a vacuous scope, never a clean result');
    const seen = new Set();
    for (const k of opts.kinds) {
      if (!KINDS.includes(k)) fail('UNKNOWN_KIND', String(k));
      if (seen.has(k)) fail('BAD_OPTIONS', 'duplicate kind ' + String(k) + ': a kind appears once');
      seen.add(k);
    }
  }
  if (opts.line !== undefined) {
    const ls = sampleLines(sample);
    if (!Number.isInteger(opts.line) || opts.line < 1 || opts.line > ls.length) fail('BAD_OPTIONS', 'line is a 1-based line number of the sample');
    if (ls[opts.line - 1].trim() === '') fail('BAD_OPTIONS', 'the declared line is blank: damaging it would not change the document');
  }
  if (opts.filter !== undefined && typeof opts.filter !== 'function') fail('BAD_OPTIONS', 'filter is a function');
}


function variantList(kind, sample, opts) {
  const ls = sampleLines(sample);
  const finalLf = sample.endsWith('\n');
  switch (kind) {
    case 'invisible': {
      // The trailing LF keeps the probe honest: with finalNewline 'refuse' a reader must refuse
      // for the invisible character, not for a truncated last line.
      const out = [];
      for (const li of targetIndices(sample, opts)) {
        for (const cp of invisibleCodePoints()) {
          const name = 'invisible-u' + cp.toString(16).padStart(4, '0');
          out.push({ kind, name: lineName(name, ls, li), text: damageLine(ls, li, l => insertAfterFirstCodePoint(l, String.fromCodePoint(cp)), finalLf) });
        }
      }
      return out;
    }
    case 'lookalike': {
      const out = [{ kind, name: 'lookalike-fullwidth-alnum', text: (/[0-9A-Za-z]/.test(sample) ? toFullwidth(sample) : '\uff30' + sample) }];
      for (const li of targetIndices(sample, opts)) {
        for (const [name, from, to] of HOMOGLYPHS) {
          out.push({ kind, name: lineName('lookalike-' + name, ls, li), text: damageLine(ls, li, l => firstOrPrefix(l, from, to), finalLf) });
        }
      }
      return out;
    }
    case 'normalisation': {
      // H2: every distinct spelling among NFC and NFD that differs from the
      // sample, including singleton decompositions (U+212B, U+2126, U+212A); the marker only
      // when NFC, NFD and the sample are all equal. Each form is compared with the SAMPLE,
      // never only with each other.
      const nfc = sample.normalize('NFC');
      const nfd = sample.normalize('NFD');
      const out = [];
      if (nfc !== sample) out.push({ kind, name: 'normalisation-nfc', text: nfc });
      if (nfd !== sample && nfd !== nfc) out.push({ kind, name: 'normalisation-nfd', text: nfd });
      if (out.length === 0) return [{ kind, name: 'normalisation-not-applicable', text: null }];
      return out;
    }
    case 'bytes': {
      // The two line-ending damages convert the sample's OWN line endings, the whole document
      // in one variant: every LF becomes CRLF (a document saved with Windows endings) or a
      // lone CR (the classic pre-OS-X ending). Nothing else is added, so a reader that
      // normalises the endings silently reads its canonical value and is caught, and a
      // sample without LF - which cannot be line-ending-damaged - yields its named marker,
      // never a carrier ending the sample lacks.
      const hasLf = sample.includes('\n');
      const out = [
        { kind, name: 'bytes-bom', text: '\ufeff' + sample },
        hasLf ? { kind, name: 'bytes-crlf', text: sample.replace(/\n/g, '\r\n') }
          : { kind, name: 'bytes-crlf-not-applicable', text: null },
        hasLf ? { kind, name: 'bytes-lone-cr', text: sample.replace(/\n/g, '\r') }
          : { kind, name: 'bytes-lone-cr-not-applicable', text: null },
      ];
      for (const li of targetIndices(sample, opts)) {
        out.push({ kind, name: lineName('bytes-lone-surrogate', ls, li), text: damageLine(ls, li, l => '\ud800' + l, finalLf) });
      }
      return out;
    }
    case 'placeholder':
      return PLACEHOLDERS.map(([name, value]) => (value === sample
        ? { kind, name: 'placeholder-' + name + '-equals-sample', text: null }
        : { kind, name: 'placeholder-' + name, text: value }));
    case 'markdown': {
      // (the strict requirement C1) The closed allow-list contract: the containers are
      // fabricated ONLY for a plain sample (isPlainSample). For any other sample each
      // container kind yields its named not-applicable entry with the reason
      // 'sample-not-plain': the corpus does not emulate CommonMark container semantics,
      // so it never fabricates a wrap that would leak the sample's later lines as the
      // document's own text and never falsely accuses an honest mask-following reader,
      // and it never fabricates a marker for a shape it does not model either.
      if (!isPlainSample(sample)) {
        return PLAIN_MARKDOWN_KINDS.map(name => ({
          kind, name: 'markdown-' + name + '-not-applicable', text: null, reason: 'sample-not-plain',
        }));
      }
      // The whole-document containers wrap the sample's own bytes and keep its
      // final-newline state: the closing marker ends with an LF only when the sample
      // does, and a closing marker that must start on its own line is preceded by the one
      // separator LF - the single intended structural addition, part of the container,
      // never of the sample. A plain sample is held by every container: its lines sit
      // inside the closed allow-list, so none of them can close or end the container early
      // (no fence line, no blank line, no comment end marker, no closing tag), and none of
      // them opens a construct a lenient reader could read as the document's own text.
      const whole = [
        ['fence', s => '```\n' + e(s) + '```' + end(s)],
        ['unclosed-fence', s => '```\n' + s],
        ['html-block', s => '<div>\n' + e(s) + '</div>' + end(s)],
        ['details', s => '<details>\n' + e(s) + '</details>' + end(s)],
        ['comment', s => '<!--\n' + e(s) + '-->' + end(s)],
        ['quote', s => sampleLines(s).map(l => '> ' + l).join('\n') + end(s)],
      ].map(([name, make]) => ({ kind, name: 'markdown-' + name, text: make(sample) }));
      const perLine = [];
      for (const li of targetIndices(sample, opts)) {
        perLine.push(
          { kind, name: lineName('markdown-indented', ls, li), text: damageLine(ls, li, l => '    ' + l, finalLf) },
          { kind, name: lineName('markdown-list-item', ls, li), text: damageLine(ls, li, l => '- ' + l, finalLf) },
          { kind, name: lineName('markdown-setext', ls, li), text: insertLineAfter(ls, li, '===', finalLf) },
          { kind, name: lineName('markdown-lazy-continuation', ls, li), text: insertLineBefore(ls, li, '> word', finalLf) },
        );
      }
      return [...whole, ...perLine, { kind, name: 'markdown-second-table', text: '| one | two |\n|---|---|\n| 1 | 2 |\n\n' + sample }];
    }
    case 'path':
      return [
        { kind, name: 'path-drive-letter', text: 'D:\\x\\' + sample },
        { kind, name: 'path-unc', text: '\\\\server\\share\\' + sample },
        { kind, name: 'path-dotdot', text: 'a\\..\\' + sample },
        { kind, name: 'path-symlink-name', text: 'latest\\' + sample },
        { kind, name: 'path-trailing-dot', text: sample + '.' },
        { kind, name: 'path-trailing-space', text: sample + ' ' },
      ];
    case 'json':
      return [
        { kind, name: 'json-duplicate-key', text: '{"v":' + JSON.stringify(sample) + ',"v":' + JSON.stringify(sample) + '}' },
        { kind, name: 'json-non-object', text: JSON.stringify([sample]) },
        { kind, name: 'json-huge-integer', text: '{"v":' + '9'.repeat(400) + ',"s":' + JSON.stringify(sample) + '}' },
        { kind, name: 'json-nan-text', text: '{"v":NaN,"s":' + JSON.stringify(sample) + '}' },
      ];
    default:
      fail('UNKNOWN_KIND', String(kind));
  }
}

function variants(sample, opts = {}) {
  checkSample(sample);
  checkOpts(sample, opts);
  let kinds = KINDS;
  if (opts.kinds !== undefined) kinds = opts.kinds;
  const out = [];
  for (const kind of kinds) out.push(...variantList(kind, sample, opts));
  return out;
}

function counts() {
  const probe = variants('P-122 sample');
  const out = {};
  for (const kind of KINDS) out[kind] = 0;
  for (const v of probe) out[v.kind] += 1;
  return out;
}

function acceptedBy(read, sample, opts = {}) {
  if (typeof read !== 'function') fail('BAD_OPTIONS', 'read is a function');
  checkOpts(sample, opts);
  if (typeof opts.isRefusal !== 'function') fail('BAD_OPTIONS', 'isRefusal(outcome, variant) is required: the refusal grammar belongs to the reader');
  if (opts.markers !== undefined && opts.markers !== 'skip') fail('BAD_OPTIONS', 'markers is "skip" (acknowledge the not-applicable markers in scope) or absent');
  if (opts.isRefusal(read(sample), { kind: 'canonical', name: 'canonical', text: sample })) {
    fail('MISCONFIGURED_CANONICAL', 'the canonical sample is refused; fix the sample or the predicate');
  }
  const all = variants(sample, { kinds: opts.kinds, line: opts.line });
  const inScope = opts.filter ? all.filter(v => opts.filter(v)) : all;
  // Markers are notes, never attacks - but they are never dropped silently either: a scope
  // that holds one must acknowledge it, and the refusal names every marker in scope, so a
  // reader reported clean is clean only against attacks it was really fed (the silent drop
  // let a trailing-ending-tolerant reader pass a no-LF sample against all attacks).
  const markers = inScope.filter(v => typeof v.text !== 'string');
  if (markers.length > 0 && opts.markers === undefined) {
    fail('MARKERS_UNDECLARED', 'the scope holds ' + markers.length + ' not-applicable marker(s): ' + markers.map(v => v.name).join(', ')
      + '. Pass markers:"skip" to acknowledge them, or declare a sample the corpus can attack (a reader of file lines owes a final-LF sample: there the line-ending damages are attacks, not markers)');
  }
  if (markers.length === 0 && opts.markers === 'skip') {
    fail('BAD_OPTIONS', 'markers:"skip" acknowledges markers this scope does not hold: the acknowledgment names a fact, it is never boilerplate');
  }
  const attacks = inScope.filter(v => typeof v.text === 'string');
  if (attacks.length === 0) fail('EMPTY_SCOPE', 'the kinds and the filter select no attack: a vacuous clean is refused, never returned');
  const accepted = [];
  for (const v of attacks) {
    const outcome = read(v.text);
    if (!opts.isRefusal(outcome, v)) accepted.push({ ...v, outcome });
  }
  return accepted;
}

module.exports = { variants, counts, acceptedBy, KINDS };

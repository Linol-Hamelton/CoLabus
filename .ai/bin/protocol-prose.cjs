#!/usr/bin/env node
'use strict';
// protocol-prose.cjs - the mechanical part of layer L7 (prose documents).
//
// Records: .ai/core/L7-prose/P-L7-001-prose-documents.md (kinds, headers, caps) and
// .ai/core/L7-prose/P-L7-002-agreement-and-citations.md (citation grammar, agreement grammar).
// Deterministic: no model, no network, no clock; the same tree gives the same bytes. Read-only:
// it never changes repository inputs (the Windows descriptor helper builds private temporary files). Every grammar below is POSITIVE: a token is a citation only when it
// matches one of the closed forms, and a citation passes only when it resolves; an unknown or
// unresolvable item is reported, never guessed and never counted as a pass.
//
//   check  [--root <dir>] <path>...   citations: one line per unresolved citation, exit 1 if any
//   agree  [--root <dir>] <path>...   agreement lines (PROTO-DEC-0048 item 3): exit 2 on a line
//                                     outside the grammar, exit 1 on a missing justification
//   prose  [--root <dir>] <path>...   the P-L7-001 checks no other tool makes (caps, headers of
//                                     research, specs and program plans, transcription line,
//                                     Superseded by target); advisory
//
// Output: one problem per line, then COUNT lines, then `RESULT exit=<n> ...` last. Exit 2 is an
// input outside the domain: a missing path, a path outside the root or through a link, an
// unreadable file, or (agree) a line that starts like an agreement but does not parse.
//
// "Carries text", the invisible characters and the kernel record and rule grammars are those of
// .ai/bin/lib/records.cjs (procedure.schema.md section 3.1, R-L7-001.13): imported, never copied.
// Text decoding, Markdown masking (which lines a reader sees) and real paths come from the shared
// guards library (.ai/bin/lib/text-safe.cjs, path-safe.cjs): no private
// copy of BOM/CRLF handling, of comment/fence visibility or of the path walk is kept here.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hasText, textOf: visibleText, INVISIBLE, parseRecord, bodyStructure } = require('./lib/records.cjs');
const textSafe = require('./lib/text-safe.cjs');
const pathSafe = require('./lib/path-safe.cjs');

class InputError extends Error {}

// Path segments are Unicode letters, digits, `_`, `-` and inner dots; an extension from the closed
// list, in any letter case (the resolution then demands the exact spelling).
const EXT = '(?:md|cjs|js|mjs|json|jsonl|ps1|psm1|sh|py|ts|tsx|yml|yaml|toml|txt|csv|html|css|xml)';
const SEG = '\\.?[\\p{L}\\p{N}_-][\\p{L}\\p{N}._-]*';
const NOT_BEFORE = '(?<![\\p{L}\\p{N}_./\\\\-])';
const NOT_AFTER = '(?![\\p{L}\\p{N}_-]|\\.[\\p{L}\\p{N}_.-])';
const RECORD = '(?:P-L\\d-\\d{3}|S-\\d{3}|M-\\d{3}|ROLE-[a-z][a-z0-9-]*[a-z0-9]|TOOL-[a-z][a-z0-9-]*[a-z0-9]|APP-[a-z][a-z0-9-]*[a-z0-9]|SCHEMA-[a-z][a-z0-9-]*[a-z0-9])';
const RULE = 'R-L\\d-[A-Za-z0-9]+(?:-[A-Za-z0-9]+)*(?:\\.\\d+)*';
// An address after a colon: the whole run up to a space or a bracket, quote,
// emphasis or table mark is the address, and it must match the closed grammar exactly; anything
// else is reported with its text, so a prefix of a damaged address never becomes a valid one.
// Trailing sentence punctuation (`.`, `,`, `:`) is not part of the address. A colon look-alike
// (fullwidth, small, ratio, modifier letter) before an address is reported, not read as `:`.
const COLON = '[:\\uFF1A\\uFE55\\u2236\\uA789]';
const TAIL = '[^\\s()\\[\\]{}<>|`\'"]*';
const LINES_RE = /^[1-9]\d*(?:-[1-9]\d*)?(?:,[1-9]\d*(?:-[1-9]\d*)?)*$/;
const ITEM_RE = /^[1-9]\d*$/;
// Spelled out in their letter cases rather than with the i flag, which would also admit upper-case
// hex: a commit id of the grammar is lower-case hex.
const SHA_KEYWORDS = ['commit', 'commits', 'sha', 'candidate', 'base', 'anchor', 'landing', 'merge', 'head', 'коммит[а-яё]*', 'база', 'базы', 'кандидат[а-яё]*']
  .flatMap(k => [k, k[0].toUpperCase() + k.slice(1), k.toUpperCase().replace('[А-ЯЁ]*', '[а-яё]*')]).join('|');
// Only `blob` is a type word: in this corpus "tree <id>" means the tree of a commit (25 of 25
// measured cases named a commit), so a tree word would turn commit citations into wrong ones.
const OBJECT_WORDS = ['blob', 'блоб[а-яё]*'].flatMap(k => [k, k[0].toUpperCase() + k.slice(1), k.toUpperCase().replace('[А-ЯЁ]*', '[а-яё]*')]).join('|');
const objectType = () => 'blob';

// The closed forms, in the order they claim text (an earlier form masks its span). `addr` names
// the grammar of the address after the colon; an empty address leaves the token to a later form.
// A markdown link or reference definition is NOT a form of this list: it is read from the whole
// document by `linkClaims` below, because a CommonMark link may put its
// destination and title on other lines. It still claims its TARGET first: a
// link target is a path as written, so a `path:line` inside it is never a line citation - the
// target of a missing file is reported. Only the target span is claimed, so the
// label of the link and the text around it stay readable by the other forms. The `d` flag gives
// the exact indices of the target group.
const FORMS = [
  { cls: 'path-line', addr: 'lines', re: new RegExp(`${NOT_BEFORE}((?:${SEG}/)*${SEG}\\.${EXT})(${COLON})(${TAIL})`, 'giu') },
  { cls: 'record-line', addr: 'lines', re: new RegExp(`(?<![A-Za-z0-9./-])(${RECORD})(${COLON})(${TAIL})`, 'gu') },
  { cls: 'traversal', re: new RegExp(`${NOT_BEFORE}((?:\\.\\./)+(?:${SEG}/)*${SEG}\\.${EXT})${NOT_AFTER}`, 'giu') },
  // A repository path that separates any segment with a backslash: the
  // token must hold at least one `\` (checked at claim time), so a mixed path like `\x.md`
  // - which neither the `/` forms nor the pure-backslash form matched - is reported as a
  // backslash path instead of silently ignored. A drive letter in front (D:\...) stays outside
  // the grammar (not a citation): the lookbehind refuses a preceding `:` as before.
  { cls: 'backslash', re: new RegExp(`(?<![\\p{L}\\p{N}_./\\\\:-])((?:${SEG}[/\\\\])+${SEG}\\.${EXT})${NOT_AFTER}`, 'giu') },
  { cls: 'path', re: new RegExp(`${NOT_BEFORE}((?:${SEG}/)+${SEG}\\.${EXT})${NOT_AFTER}`, 'giu') },
  // Any number of digits is read, so a decision id of the wrong width is reported, not skipped.
  { cls: 'decision', addr: 'item', re: new RegExp(`(?<![A-Za-z0-9-])((?:PROTO-)?DEC-\\d+)(?:(${COLON})(${TAIL}))?(?![0-9A-Za-z])`, 'gu') },
  { cls: 'rule', re: new RegExp(`(?<![A-Za-z0-9-])(${RULE})(?![A-Za-z0-9-])`, 'g') },
  { cls: 'record', re: new RegExp(`(?<![A-Za-z0-9-])(${RECORD})(?![A-Za-z0-9-])`, 'g') },
  // A blob is cited with its type word in front, `blob <id>` (7 to 40 hex digits), and resolves
  // only to an object of type blob.
  { cls: 'object', re: new RegExp(`(?<![\\p{L}\\p{N}])(${OBJECT_WORDS})(?![\\p{L}\\p{N}])[ \\t]*[:=]?[ \\t]*\`?([0-9a-f]{7,40})(?![0-9A-Za-z])(?!\\.\\.\\.|…)`, 'gu') },
  // A commit id: 40 hex digits anywhere, or 7 to 39 after `@`, alone in a code
  // span or after a commit word. No condition on letters or digits: an all-digit or all-letter id
  // in one of these three places is a citation like any other.
  { cls: 'commit', re: /(?<![0-9A-Za-z])([0-9a-f]{40})(?![0-9A-Za-z])/g },
  { cls: 'commit', re: /@([0-9a-f]{7,39})(?![0-9A-Za-z])(?!\.\.\.|…)/g },
  { cls: 'commit', re: /`([0-9a-f]{7,39})`/g },
  { cls: 'commit', re: new RegExp(`(?<![\\p{L}\\p{N}])(?:${SHA_KEYWORDS})(?![\\p{L}\\p{N}])[ \\t]*[:=]?[ \\t]*\`?([0-9a-f]{7,39})(?![0-9A-Za-z])(?!\\.\\.\\.|…)`, 'gu') },
];
const CLASSES = ['path-line', 'record-line', 'traversal', 'backslash', 'link', 'path', 'decision', 'rule', 'record', 'commit', 'object'];

// One shared link grammar; this consumer also checks literal examples in code.
function linkClaims(text) {
  return textSafe.markdownLinkTargets(text, { literal: true }).map(r => ({
    start: r.destinationStart, end: r.destinationEnd,
    token: text.slice(r.destinationStart, r.destinationEnd),
  }));
}

function q(value) {
  const s = String(value);
  return /^[^\s"]+$/.test(s) ? s : `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
function row(token, fields) {
  return [token, ...Object.entries(fields).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${q(v)}`)].join(' ');
}
function lineCount(text) {
  if (!text.length) return 0;
  const n = text.split('\n').length;
  return text.endsWith('\n') ? n - 1 : n;
}
function toPosix(p) { return p.split(path.sep).join('/'); }

// ---------- the corpus: what the root really holds ----------

function walk(realRoot) {
  const out = [];
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue; // a link is never part of the corpus
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) out.push(toPosix(path.relative(realRoot, full)));
    }
  };
  visit(realRoot);
  return out;
}

function context(rootArg) {
  const root = path.resolve(rootArg);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) throw new InputError(`the root is not a directory`);
  // realpathSync.native returns the on-disk spelling (case, long names); the JS realpathSync keeps
  // the caller's letter case on Windows, so a case fold would pass unseen.
  const realRoot = fs.realpathSync.native(root);
  const git = spawnSync('git', ['-C', realRoot, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024 });
  // A repository is read through its index even when the index is empty: an empty index is not a
  // licence to read untracked files as the corpus.
  const mode = git.status === 0 ? 'git' : 'walk';
  const files = mode === 'git' ? git.stdout.split('\0').filter(Boolean) : walk(realRoot);
  const fileSet = new Set(files);
  const dirSet = new Set();
  for (const f of files) { const parts = f.split('/'); for (let i = 1; i < parts.length; i++) dirSet.add(parts.slice(0, i).join('/')); }
  const ctx = { root, realRoot, mode, files, fileSet, dirSet, cache: new Map() };
  ctx.decisions = loadDecisions(ctx);
  Object.assign(ctx, loadKernel(ctx));
  ctx.registry = loadRegistry(ctx);
  ctx.archived = loadArchiveIndex(ctx);
  return ctx;
}

// THE real-path rule, one for every reader and every citation form: documents,
// path and path:line citations, link targets that are files or directories, and the indexes the
// tool loads. The walk itself is the shared path-safe realInside (no private copy of
// the segment lstat / native realpath loop): a repo-relative path is real when the corpus lists it
// with this exact spelling (r.rel must equal the citation, so no letter-case fold and no 8.3 short
// name passes), every step from the root down is a plain directory (no symbolic link, no junction),
// the last step is the kind asked for, and a file has exactly one hard link. The reason strings
// stay the tool's contract (tests assert them); a path-safe refusal is mapped, never re-guessed.
function realEntry(ctx, rel, want) {
  const key = `${want}|${rel}`;
  if (ctx.cache.has(key)) return ctx.cache.get(key);
  const result = (() => {
    const listed = want === 'file' ? ctx.fileSet.has(rel) : ctx.dirSet.has(rel);
    if (!listed) return { error: want === 'file' ? 'not a file of the repository' : 'not a directory of the repository' };
    const r = pathSafe.realInside(ctx.realRoot, rel, { refuseHardlinks: want === 'file' });
    if (!r.ok) {
      if (r.reason === 'hardlink') {
        let n = null;
        try { n = fs.statSync(path.join(ctx.realRoot, ...rel.split('/'))).nlink; } catch (e) { n = null; }
        return { error: `the file has ${n} hard links; a citation names one file` };
      }
      if (r.reason === 'link') {
        let finalIsLink = false;
        try { finalIsLink = fs.lstatSync(path.join(ctx.realRoot, ...rel.split('/'))).isSymbolicLink(); } catch (e) { finalIsLink = false; }
        return { error: finalIsLink && want === 'file' ? 'the path is a link' : 'the path passes through a link or junction' };
      }
      if (r.reason === 'not-a-directory') return { error: 'a step of the path is not a directory' };
      if (r.reason === 'outside-root' || r.reason === 'reparse') return { error: 'the path passes through a link or differs in case on disk' };
      if (r.reason === 'unreadable') return { error: 'the real path cannot be read' };
      if (r.reason === 'short-name') return { error: 'the path passes through a link or differs in case on disk' };
      return { error: `the path is not real (${r.reason})` };
    }
    if (!r.exists) return { error: 'listed by git but missing in the working tree' };
    if (toPosix(r.rel) !== rel) return { error: 'the path passes through a link or differs in case on disk' };
    if (want === 'file' && r.type !== 'file') return { error: 'not a regular file' };
    if (want === 'dir' && r.type !== 'dir') return { error: 'not a directory' };
    return { full: r.real, text: null };
  })();
  ctx.cache.set(key, result);
  return result;
}
function fileText(ctx, rel) {
  const r = realEntry(ctx, rel, 'file');
  if (r.error) return null;
  if (r.text === null) {
    // One reader for text as data: shared decode with an explicit policy - strip one leading BOM,
    // normalise CRLF to LF; a lone CR, NUL or invalid UTF-8 is a refusal (exit 2 through the
    // caller), never an empty or half-read text. A SECOND leading byte
    // order mark is not the encoding's own mark but text the reader cannot see, and the shared mask
    // refuses such a string: the file is refused as unreadable - a controlled
    // exit 2 with a RESULT line, never the TypeError the mask throws and never a lost RESULT.
    const read = pathSafe.readFileGuarded(ctx.realRoot, rel);
    if (!read.ok) throw new InputError(`${rel}: the read is unverified (${read.reason})`);
    const dec = textSafe.decode(read.bytes, { bom: 'strip', crlf: 'normalise' });
    if (!dec.ok) throw new InputError(`${rel}: the text is not readable (${dec.problems.map(p => p.code).join(', ')})`);
    if (dec.text.charCodeAt(0) === 0xfeff) throw new InputError(`${rel}: the text is not readable (a second leading byte order mark)`);
    r.text = dec.text;
  }
  return r.text;
}

// Lines a reader sees, through the shared mask (text-safe maskMarkdown): a line
// is hidden when the mask covers it with a fence (or its parity line) or an HTML comment - the
// closed set R-L7-001.15 names ("a line inside a fenced block or an HTML comment fills no
// field"); a quoted line stays visible, because the record does not unquote it and a reader sees
// quoted text. A table row, a code span or a link is the data the indexes parse, never a hiding
// kind. The input is the decoded text of fileText (no BOM, CRLF already LF): "decode first".
const HIDE_KINDS = new Set(['fence', 'fence-parity', 'html-comment']);
function visibleLines(text) {
  const { lines } = textSafe.maskMarkdown(text);
  return lines.map(l => ({ n: l.line, text: l.text, hidden: l.masked && l.kinds.some(k => HIDE_KINDS.has(k)) }));
}

// A decision block is a `### <id>` heading of .ai/DECISIONS.md that a reader sees (fenced and comment-hidden lines fill nothing - the shared mask decides, not a private
// copy). Two headings with one id make the id unknown (never the first, never the newest).
function loadDecisions(ctx) {
  const text = fileText(ctx, '.ai/DECISIONS.md');
  const blocks = new Map();
  if (text === null) return blocks;
  let current = null;
  for (const l of visibleLines(text)) {
    if (l.hidden) continue;
    const m = /^### ((?:PROTO-)?DEC-\d{4})\s*$/.exec(l.text);
    if (m) {
      if (blocks.has(m[1])) { blocks.get(m[1]).duplicate = true; current = null; continue; }
      current = { id: m[1], items: new Set(), line: l.n, duplicate: false };
      blocks.set(m[1], current);
      continue;
    }
    if (/^#{1,3} /.test(l.text)) { current = null; continue; }
    const item = /^(\d+)\. /.exec(l.text);
    if (current && item) current.items.add(Number(item[1]));
  }
  return blocks;
}

// Kernel records and rules through the one record parser (records.cjs parseRecord, bodyStructure):
// a record id is the `id:` of a front matter, a rule id is a rule of a `## Rules` section that
// carries text. A hollow rule (`R-L0-01. .`) defines nothing. An id defined twice is unknown.
function loadKernel(ctx) {
  const records = new Map();
  const rules = new Map();
  const twice = new Set();
  for (const rel of ctx.files.filter(f => f.startsWith('.ai/core/') && f.endsWith('.md')).sort()) {
    const r = realEntry(ctx, rel, 'file');
    if (r.error) continue;
    const rec = parseRecord(r.full, fileText(ctx, rel));
    if (!rec.fm) continue;
    // A record whose front matter parseRecord refuses is unknown input (SCHEMA-procedure §1): neither its id nor its rules register - a duplicate `id:` used to report
    // F1 and still leave the first id resolvable. The findings are never ignored.
    if (Array.isArray(rec.findings) && rec.findings.length) continue;
    const id = rec.fm.id;
    if (typeof id === 'string' && id !== '') {
      if (records.has(id)) twice.add(id); else records.set(id, rel);
    }
    for (const rule of bodyStructure(rec).rules) {
      if (rules.has(rule.id)) twice.add(rule.id); else rules.set(rule.id, rel);
    }
  }
  return { records, rules, twice };
}

// .ai/core/EXTERNAL-PENDING.md: an open row that a reader sees is the owner-recorded exception
// for one id from one referrer; a row inside a fence or an HTML comment
// fills nothing. Anything else in the file is ignored, not guessed.
function loadRegistry(ctx) {
  const text = fileText(ctx, '.ai/core/EXTERNAL-PENDING.md');
  const open = new Set();
  if (text === null) return open;
  for (const l of visibleLines(text)) {
    if (l.hidden) continue;
    const c = l.text.split('|').map(s => s.trim());
    if (c.length === 8 && c[6] === 'open') open.add(`${c[1]}|${c[2]}`);
  }
  return open;
}

// docs/ARCHIVE-INDEX.md: a path that left the tree resolves as `archived` when the first cell of
// a visible index row names it exactly or names a directory (trailing /) that holds it. A row
// inside a fence or an HTML comment names nothing. Glob and brace forms in a
// cell are not paths and are not used.
function loadArchiveIndex(ctx) {
  const text = fileText(ctx, 'docs/ARCHIVE-INDEX.md');
  const exact = new Set();
  const dirs = [];
  if (text === null) return { exact, dirs };
  for (const l of visibleLines(text)) {
    if (l.hidden || !l.text.startsWith('| `')) continue;
    const cell = l.text.split('|')[1] || '';
    for (const m of cell.matchAll(/`([^`]+)`/g)) {
      const p = m[1];
      if (/[*{}\s\\]/.test(p) || p.startsWith('/') || p.split('/').includes('..')) continue;
      if (p.endsWith('/')) dirs.push(p); else exact.add(p);
    }
  }
  return { exact, dirs };
}
function isArchived(ctx, rel) {
  return ctx.archived.exact.has(rel) || ctx.archived.dirs.some(d => rel.startsWith(d));
}

// ---------- documents ----------

function expand(ctx, args) {
  if (!args.length) throw new InputError('no path given');
  const docs = [];
  for (const arg of args) {
    const abs = path.resolve(arg);
    if (!fs.existsSync(abs)) throw new InputError(`the input does not exist`);
    // The argument is a real path below the root, walked by the shared path-safe realInside (no private copy of the ancestor loop): no step may be a link or junction, and the
    // spelling must be the one on disk - the same rule as for a citation. The reason strings stay
    // the tool's contract; path-safe detail (which holds no absolute path) is not echoed.
    const r = pathSafe.realInside(ctx.realRoot, abs, {});
    if (!r.ok) {
      if (r.reason === 'link') throw new InputError(`the input passes through a link or junction; name the real path`);
      if (r.reason === 'outside-root') throw new InputError(`the input lies outside the root`);
      if (r.reason === 'is-root') throw new InputError(`the input is the root itself; name a file or directory below it`);
      throw new InputError(`the input is not a regular file or directory (${r.reason})`);
    }
    if (!r.exists) throw new InputError(`the input does not exist`);
    const rel = r.rel;
    // The argument is spelled as on disk below the root: the same rule as for a citation.
    if (toPosix(path.relative(ctx.realRoot, abs)) !== rel) throw new InputError(`the input differs from its real path ${rel} (letter case or short name); name the real path`);
    if (r.type === 'dir') {
      const prefix = rel === '' ? '' : `${rel}/`;
      const before = docs.length;
      for (const f of ctx.files) if (f.startsWith(prefix) && f.endsWith('.md')) docs.push({ rel: f, explicit: false });
      // An empty set is not a pass: a directory with no .md file of the repository is named.
      if (docs.length === before) throw new InputError(`the input holds no .md file of the repository (${ctx.mode} mode; untracked files are not documents)`);
    } else if (r.type === 'file') {
      if (!ctx.fileSet.has(rel)) throw new InputError(`the input is not a file of the repository (exact spelling, ${ctx.mode} mode)`);
      docs.push({ rel, explicit: true });
    } else throw new InputError(`the input is not a regular file or directory`);
  }
  const seen = new Set();
  return docs.filter(d => (seen.has(d.rel) ? false : seen.add(d.rel))).sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}
// Text as data: fileText has already stripped one leading byte order mark and normalised CRLF to
// LF through the shared decode; a refusal above reached the caller as exit 2 instead.
function readDoc(ctx, rel) {
  const text = fileText(ctx, rel);
  if (text === null) throw new InputError(`${rel}: ${realEntry(ctx, rel, 'file').error}`);
  return text;
}

// Text between ~~double tildes~~ is a superseded value kept for the history of a correction; a
// sha256: digest is a content digest, not a commit. Both are blanked with spaces so columns stay.
function maskLine(line) {
  return line.replace(/~~.*?~~/g, m => ' '.repeat(m.length)).replace(/sha256:[0-9a-fA-F]+/g, m => ' '.repeat(m.length));
}

// A line address that passed LINES_RE: each line at least 1, a range strictly increasing (a-b with
// a < b; one line is written alone), every line inside the file.
function linesOk(total, spec) {
  for (const part of spec.split(',')) {
    const [a, b] = part.split('-').map(Number);
    if (b !== undefined && b <= a) return `range ${part} is empty or reversed; a range is a-b with a < b`;
    const to = b === undefined ? a : b;
    if (to > total) return `line ${to} is beyond the end (${total} lines)`;
  }
  return null;
}

function shortFormHint(ctx, token, doc) {
  const local = path.posix.join(path.posix.dirname(doc), token);
  if (ctx.fileSet.has(local)) return `not a repo-relative path; relative to the document it is ${local}`;
  const hits = ctx.files.filter(f => f === token || f.endsWith(`/${token}`));
  if (hits.length === 1) return `not a repo-relative path; the one file it may mean is ${hits[0]}`;
  if (hits.length > 1) return `not a repo-relative path; ${hits.length} files end with this name`;
  return 'not a file of the repository';
}

// Resolve one citation. Outcome: resolved | registered | archived | generated | unresolved
// (+ reason). `registered`, `archived` and `generated` are the three named exceptions, each an
// allow-list the repository itself declares (EXTERNAL-PENDING open rows, registry rows, the
// untracked runtime directory of AGENTS.md section 1); each is counted, none is silent. A resolved
// path or link also carries `target`, the repo-relative file or directory it names.
const GENERATED = '.ai/runtime/';
function resolve(ctx, doc, c) {
  if (c.malformed) return { outcome: 'unresolved', reason: c.malformed };
  const pathOutcome = (rel, lines) => {
    const r = realEntry(ctx, rel, 'file');
    if (r.error) {
      if (!ctx.fileSet.has(rel) && isArchived(ctx, rel)) return { outcome: 'archived' };
      if (!ctx.fileSet.has(rel) && rel.startsWith(GENERATED) && !lines) return { outcome: 'generated' };
      return { outcome: 'unresolved', reason: ctx.fileSet.has(rel) ? r.error : shortFormHint(ctx, rel, doc) };
    }
    if (lines) {
      const bad = linesOk(lineCount(fileText(ctx, rel)), lines);
      if (bad) return { outcome: 'unresolved', reason: bad };
    }
    return { outcome: 'resolved', target: rel };
  };
  switch (c.cls) {
    case 'path-line': return pathOutcome(c.token, c.lines);
    case 'path': return pathOutcome(c.token, null);
    case 'traversal': return { outcome: 'unresolved', reason: 'a ../ path is not repo-relative; write the path from the root' };
    case 'backslash': return { outcome: 'unresolved', reason: `a citation separates segments with /; did you mean ${c.token.replace(/\\/g, '/')}` };
    case 'link': {
      let target = c.token.startsWith('<') && c.token.endsWith('>') ? c.token.slice(1, -1) : c.token;
      // A URL, an anchor or an absolute drive path is not a citation (the domain of P-L7-002 is
      // repo-relative paths). The scheme is a closed list: the open
      // `scheme:` test of an earlier version of this tool matched a record-id target like `P-L2-004:7` and a short
      // form like `note.md:1` and silently dropped them instead of reporting the missing file.
      if (/^(?:https?|mailto|ftp|ftps|file|git|ssh|ircs?|xmpp):/i.test(target) || /^[A-Za-z]:[\\/]/.test(target) || target.startsWith('#')) return null; // not a citation
      target = target.replace(/[#?].*$/, '');
      try { target = decodeURIComponent(target); } catch (e) { return { outcome: 'unresolved', reason: 'malformed percent-encoding' }; }
      const base = target.startsWith('/') ? '' : path.posix.dirname(doc);
      const joined = path.posix.normalize(path.posix.join(base, target.replace(/^\/+/, '')));
      if (joined === '..' || joined.startsWith('../')) return { outcome: 'unresolved', reason: 'the link leaves the repository' };
      const slash = joined.endsWith('/');
      const rel = joined.replace(/\/$/, '');
      if (rel === '.' || rel === '') return { outcome: 'resolved', target: '' };
      if (ctx.fileSet.has(rel)) {
        if (slash) return { outcome: 'unresolved', reason: 'a trailing / names a directory; the target is a file' };
        return pathOutcome(rel, null);
      }
      if (ctx.dirSet.has(rel)) {
        const r = realEntry(ctx, rel, 'dir');
        return r.error ? { outcome: 'unresolved', reason: r.error } : { outcome: 'resolved', target: rel };
      }
      if (isArchived(ctx, rel) || isArchived(ctx, `${rel}/`)) return { outcome: 'archived' };
      return { outcome: 'unresolved', reason: 'the link target is not a file or directory of the repository' };
    }
    case 'decision': {
      const block = ctx.decisions.get(c.token);
      if (!block) return { outcome: 'unresolved', reason: 'no "### <id>" heading in .ai/DECISIONS.md' };
      if (block.duplicate) return { outcome: 'unresolved', reason: 'two "### <id>" headings in .ai/DECISIONS.md: the id is ambiguous' };
      if (c.item !== undefined && !block.items.has(c.item)) return { outcome: 'unresolved', reason: `the block has no item ${c.item}` };
      return { outcome: 'resolved' };
    }
    case 'record':
    case 'record-line': {
      const file = ctx.records.get(c.token);
      if (!file) {
        if (ctx.registry.has(`${c.token}|${doc}`)) return { outcome: 'registered' };
        return { outcome: 'unresolved', reason: 'no kernel record with this id under .ai/core' };
      }
      if (ctx.twice.has(c.token)) return { outcome: 'unresolved', reason: 'two kernel records carry this id: it is ambiguous' };
      if (c.cls === 'record-line') {
        const bad = linesOk(lineCount(fileText(ctx, file)), c.lines);
        if (bad) return { outcome: 'unresolved', reason: `${file}: ${bad}` };
      }
      return { outcome: 'resolved' };
    }
    case 'rule':
      if (!ctx.rules.has(c.token)) return { outcome: 'unresolved', reason: 'no kernel record defines this rule id (a rule of a ## Rules section that carries text)' };
      if (ctx.twice.has(c.token)) return { outcome: 'unresolved', reason: 'two kernel rules carry this id: it is ambiguous' };
      return { outcome: 'resolved' };
    case 'commit':
    case 'object': return c.object ? { outcome: 'resolved' } : { outcome: 'unresolved', reason: c.objectReason };
    default: throw new Error(`unknown class ${c.cls}`);
  }
}

// The address after a colon, read whole (see TAIL): null when there is none (the token is then a
// citation without an address and a later form takes it), else { value } or { value, bad }.
function address(colon, raw, grammar, prefix = '') {
  let value = raw.replace(/[.,:;!?\uFF1A]+$/, '');
  const emphasis = /(\*{1,3}|_{1,3})$/.exec(prefix);
  if (emphasis && value.endsWith(emphasis[1])) value = value.slice(0, -emphasis[1].length);
  value = value.replace(/[.,:;!?\uFF1A]+$/, '');
  if (value === '') return null;
  if (colon !== ':') return { value, bad: `"${colon}" before the address is not an ASCII colon` };
  if (grammar === 'lines' && !LINES_RE.test(value)) return { value, bad: `malformed line address ":${value}"; the grammar is :N, :A-B with A < B, or a comma list of them` };
  if (grammar === 'item' && !ITEM_RE.test(value)) return { value, bad: `malformed item ":${value}"; the grammar is :K, one item number from 1` };
  return { value };
}

// Extract the citations of one line. A span claimed by an earlier form is masked for the later
// ones, so `path:line` is one path-line citation, not also a path. Invisible characters
// (Default_Ignorable_Code_Point, records.cjs) are removed first: the citation is what a reader sees.
function extract(line, opts = {}) {
  let text = maskLine(line.replace(INVISIBLE, ''));
  const found = [];
  for (const form of FORMS) {
    form.re.lastIndex = 0;
    const claims = [];
    for (const m of text.matchAll(form.re)) {
      const token = form.cls === 'object' ? m[2] : m[1];
      // The broadened backslash form matches any `/`-or-`\` path; it claims only a token that
      // really holds a backslash, so an ordinary `/` path falls through to the path forms.
      if (form.cls === 'backslash' && !(token && token.includes('\\'))) continue;
      const c = { cls: form.cls, token, col: m.index + 1, ref: token };
      let claimStart = m.index;
      let claimEnd = m.index + m[0].length;
      if (form.cls === 'link') {
        // Claim the target only: the label and the surrounding text stay readable.
        const g = m.indices && m.indices[1];
        if (g) { claimStart = g[0]; claimEnd = g[1]; }
        c.col = claimStart + 1;
      }
      if (form.cls === 'object') { c.want = objectType(m[1]); c.ref = `${c.want} ${token}`; }
      if (form.addr === 'lines') {
        const a = address(m[2], m[3], 'lines', text.slice(0, m.index));
        if (!a) continue; // no address: the path or record form takes the token
        c.lines = a.value;
        c.ref = `${token}${m[2]}${a.value}`;
        if (a.bad) c.malformed = a.bad;
      }
      if (form.cls === 'decision') {
        if (!/^(?:PROTO-)?DEC-\d{4}$/.test(token)) c.malformed = 'a decision id is PROTO-DEC-nnnn or DEC-nnnn with four digits';
        const a = m[2] === undefined ? null : address(m[2], m[3], 'item', text.slice(0, m.index));
        if (a) {
          c.ref = `${token}${m[2]}${a.value}`;
          if (a.bad) c.malformed = c.malformed || a.bad; else c.item = Number(a.value);
        }
      }
      if (opts?.spans === true) c.claim = { start: claimStart, end: claimEnd };
      found.push(c);
      claims.push([claimStart, claimEnd]);
    }
    for (const [a, b] of claims) text = text.slice(0, a) + ' '.repeat(b - a) + text.slice(b);
  }
  return found;
}

// A commit id resolves only to an object of type commit: a blob, a tree or a tag
// object is not a commit; a `blob <id>` resolves only to a blob. The full id git
// answers must start with the cited id, so a branch or tag NAME that happens to look like hex never
// stands in for an object id.
function resolveCommits(ctx, items) {
  const commits = items.filter(c => c.cls === 'commit' || c.cls === 'object');
  if (!commits.length) return;
  if (ctx.mode !== 'git') { for (const c of commits) { c.object = false; c.objectReason = `no git repository: ${c.cls === 'commit' ? 'a commit' : 'an object'} id cannot resolve`; } return; }
  const unique = [...new Set(commits.map(c => c.token))].sort();
  const out = spawnSync('git', ['-C', ctx.realRoot, 'cat-file', '--batch-check'], { input: unique.join('\n') + '\n', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (out.status !== 0) throw new InputError(`git cat-file failed`);
  const answers = out.stdout.split('\n').filter(Boolean);
  if (answers.length !== unique.length) throw new InputError(`git cat-file gave ${answers.length} answers for ${unique.length} ids`);
  // The answer per id: { type } of the object git names, or { error }.
  const answer = new Map();
  answers.forEach((l, i) => {
    const parts = l.split(' ');
    const key = unique[i];
    if (parts[1] === 'missing') answer.set(key, { error: 'git does not know this object' });
    else if (parts[1] === 'ambiguous') answer.set(key, { error: 'the short id is ambiguous' });
    else if (!/^[0-9a-f]{40}$/.test(parts[0]) || !parts[0].startsWith(key)) answer.set(key, { error: `git answered with another object (${parts[0].slice(0, 12)}): a name, not this id` });
    else if (/^(commit|tree|blob|tag)$/.test(parts[1])) answer.set(key, { type: parts[1] });
    else answer.set(key, { error: `unexpected git answer: ${l}` });
  });
  for (const c of commits) {
    const a = answer.get(c.token);
    const want = c.cls === 'commit' ? 'commit' : c.want;
    c.object = !a.error && a.type === want;
    c.objectReason = a.error || (c.object ? null : `the object is a ${a.type}, not a ${want}`);
  }
}

// A short id alone in a code span is a citation (R-L7-002.2):
// an earlier reader took only the spans that crossed lines and read the raw text, so a padded span
// (` deadbee1 `), another delimiter width (`` deadbee1 ``) and an id with an invisible character
// inside (`\ndead\u200bbee1\n`) yielded citations=0. Every code span of the shared mask is read
// now, through the library, never a private copy: the mask names the spans, INVISIBLE
// (records.cjs) is removed before the token is judged, and the same strikethrough and sha256
// policy as `maskLine` is applied to the pieces, so a superseded value fills nothing here either.
// The content - delimiter runs stripped precisely by their length - is what CommonMark shows:
// line endings become spaces and, when the content both begins and ends with a space and is not
// all spaces, one space is removed from each side; a content of exactly one 7-to-39 lower-case hex
// token is a citation of the line that carries it, and a content that stays padded (two spaces, a
// visible blank such as NBSP) is not `alone` and is no citation. A single-line span whose visible
// text is exactly `` `id` `` was already read by the line form, so the span reader leaves it there
// and never counts it twice; a 40-hex content is not of this form (the bare form reads it).
function spanCitations(text) {
  const out = [];
  const lines = text.split('\n');
  const masked = lines.map(maskLine);
  for (const span of textSafe.maskMarkdown(text).spans) {
    if (span.kind !== 'code-span') continue;
    const openLen = (/^`+/.exec((lines[span.startLine - 1] || '').slice(span.startCol)) || [''])[0].length;
    const closeLen = (/`+$/.exec((lines[span.endLine - 1] || '').slice(0, span.endCol)) || [''])[0].length;
    const pieces = [];
    for (let n = span.startLine; n <= span.endLine; n++) {
      let piece = masked[n - 1] || '';
      if (n === span.startLine) piece = piece.slice(span.startCol + openLen);
      if (n === span.endLine) piece = piece.slice(0, n === span.startLine ? span.endCol - closeLen - span.startCol - openLen : span.endCol - closeLen);
      pieces.push({ n, piece });
    }
    let content = pieces.map(p => p.piece).join('\n').replace(INVISIBLE, '').replace(/\n/g, ' ');
    if (/^ /.test(content) && / $/.test(content) && !/^ +$/.test(content)) content = content.slice(1, -1);
    if (!/^[0-9a-f]{7,39}$/.test(content)) continue;
    if (span.startLine === span.endLine) {
      const slice = (masked[span.startLine - 1] || '').slice(span.startCol, span.endCol).replace(INVISIBLE, '');
      if (/^`[0-9a-f]{7,39}`$/.test(slice)) continue; // the line form already read this span
    }
    const at = pieces.find(p => p.piece.replace(INVISIBLE, '').trim() === content);
    out.push({ cls: 'commit', token: content, col: 1, ref: content, line: at ? at.n : span.startLine });
  }
  return out;
}

function citationsOf(ctx, rel, text) {
  const items = [];
  // The link targets are claimed first and masked, exactly as the earlier line forms did inside
  // `extract`: the per-line forms then never read the inside of a target.
  // Every text that reaches here is a whole file (fileText refuses a second
  // leading byte order mark) or a fragment whose producer already drops a leading U+FEFF (the
  // FIELD grammar's `\s*`, the trim of fieldsOf and records.cjs textOf all consume it), so the
  // shared mask never meets a BOM-in-string.
  const claims = linkClaims(text);
  let rest = text;
  for (const c of [...claims].sort((a, b) => b.start - a.start)) {
    rest = rest.slice(0, c.start) + ' '.repeat(c.end - c.start) + rest.slice(c.end);
  }
  rest.split('\n').forEach((line, i) => { for (const c of extract(line)) items.push({ ...c, line: i + 1 }); });
  for (const c of claims) {
    const before = text.slice(0, c.start);
    items.push({
      cls: 'link', token: c.token, col: c.start - (before.lastIndexOf('\n') + 1) + 1, ref: c.token,
      line: before.split('\n').length,
    });
  }
  for (const c of spanCitations(rest)) items.push(c);
  items.sort((a, b) => a.line - b.line || a.col - b.col);
  resolveCommits(ctx, items);
  const out = [];
  for (const c of items) {
    const r = resolve(ctx, rel, c);
    if (r) out.push({ ...c, ...r });
  }
  return out;
}

// ---------- check ----------

function runCheck(ctx, docs) {
  const lines = [];
  const counts = Object.fromEntries(CLASSES.map(k => [k, { found: 0, resolved: 0, registered: 0, archived: 0, generated: 0, unresolved: 0 }]));
  let unresolved = 0;
  for (const d of docs) {
    for (const c of citationsOf(ctx, d.rel, readDoc(ctx, d.rel))) {
      counts[c.cls].found += 1;
      counts[c.cls][c.outcome] += 1;
      if (c.outcome === 'unresolved') {
        unresolved += 1;
        lines.push(row('UNRESOLVED', { at: `${d.rel}:${c.line}`, class: c.cls, ref: c.ref, reason: c.reason }));
      }
    }
  }
  for (const k of CLASSES) lines.push(row('COUNT', { class: k, ...counts[k] }));
  const total = CLASSES.reduce((a, k) => a + counts[k].found, 0);
  const code = unresolved ? 1 : 0;
  lines.push(row('RESULT', { exit: code, files: docs.length, mode: ctx.mode, citations: total, unresolved }));
  return { code, lines };
}

// ---------- agree (PROTO-DEC-0048 item 3) ----------

const DEGREES = ['categorically disagree, with reasons', 'disagree', 'partially agree', 'agree with reservations', 'fully agree', 'absolutely agree, with additional confirmation found'];
const AGREEMENT = new RegExp(`^Agreement with ([A-Za-z][A-Za-z0-9._-]*) on item ([A-Za-z0-9]+(?:[-._][A-Za-z0-9]+)*): (${DEGREES.map(d => d.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\.$`);

function agreementBody(raw) {
  // An allowed prefix is a list marker or a blockquote marker; the statement starts after it.
  const m = /^(\s*(?:>\s*)*(?:[-*+]\s+|\d+[.)]\s+)?)(.*)$/.exec(raw);
  return { prefix: m[1], body: m[2] };
}

// A candidate is a line that STATES an agreement: after its list, quote, heading or table-cell
// markers and any emphasis, a cell or the line starts with "agreement with" in any letter case.
// Every candidate must then match the grammar exactly, with only a list or quote prefix allowed,
// so a heading, a table cell or emphasis around the statement is a malformed line, not a skip.
// A code span at the start quotes the form and states nothing. Invisible characters are removed
// before the test (records.cjs INVISIBLE), so an invisible mark cannot hide a line from it.
function isCandidate(raw) {
  const visible = raw.replace(INVISIBLE, '');
  const stripped = visible.replace(/^\s*(?:>\s*)*(?:#{1,6}\s+)?(?:[-*+]\s+|\d+[.)]\s+)?/, '');
  const cells = stripped.startsWith('|') ? stripped.split('|').slice(1) : [stripped];
  return cells.some(cell => {
    const c = cell.trim();
    if (c.startsWith('`')) return false;
    return /^a\s*g\s*r\s*e\s*e\s*m\s*e\s*n\s*t[\s\u00A0]*with(?![\p{L}\p{N}])/iu.test(visibleText(c).replace(/^[*_~]+/, ''));
  });
}

function runAgree(ctx, docs) {
  const out = [];
  let malformed = 0; let ruleBroken = 0; let valid = 0;
  for (const d of docs) {
    const lines = readDoc(ctx, d.rel).split('\n');
    // Only a closed fence hides a line here: a hidden statement would escape the grammar.
    const fenced = textSafe.fenceMap(lines, 'show');
    const degrees = new Map();
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (fenced[i] || !isCandidate(raw)) continue;
      const { body } = agreementBody(raw);
      const visible = body.replace(INVISIBLE, '');
      const at = `${d.rel}:${i + 1}`;
      if (visible !== body) { malformed += 1; out.push(row('MALFORMED', { at, reason: 'invisible characters inside an agreement line' })); continue; }
      const m = AGREEMENT.exec(body.trimEnd());
      if (!m) {
        malformed += 1;
        let reason = 'not the grammar "Agreement with <participant> on item <id>: <degree>."';
        if (/\.\.|–|—|\bto\b|,\s*\S+\s*:/.test(body.split(' on item ')[1] || '')) reason = 'one item per line; ranges and lists are not allowed';
        else if (/^[*_]/.test(body)) reason = 'emphasis around the statement is outside the grammar';
        else if (/^(#|\|)/.test(body)) reason = 'an agreement is a line of its own, not a heading or a table cell';
        else if (!/^Agreement with /.test(body)) reason = 'the statement must start with "Agreement with " exactly';
        else if (/ on item [^:]+: /.test(body) && !DEGREES.some(dg => body.trimEnd().endsWith(`: ${dg}.`))) reason = `degree outside the closed scale: ${DEGREES.join(' | ')}`;
        out.push(row('MALFORMED', { at, reason }));
        continue;
      }
      // An item of digits joined by `-` (1-3) is a range, not one id (R-L7-002.7); ids such as Z4-11
      // or F-R3.01 hold a letter.
      if (/^\d+(?:-\d+)+$/.test(m[2])) { malformed += 1; out.push(row('MALFORMED', { at, reason: 'one item per line; ranges and lists are not allowed' })); continue; }
      const degree = m[3];
      // One participant, one item, one degree per document: a second line with another degree for
      // the same pair contradicts the first.
      const key = `${m[1].toLowerCase()}|${m[2]}`;
      if (degrees.has(key) && degrees.get(key).degree !== degree) {
        ruleBroken += 1;
        out.push(row('CONFLICT', { at, participant: m[1], item: m[2], degree, first: degrees.get(key).at }));
        continue;
      }
      if (!degrees.has(key)) degrees.set(key, { degree, at });
      // The justification is the next non-blank line, outside a fence, with the same kind of prefix
      // allowed; it carries text by the one definition of procedure.schema.md section 3.1 (hasText):
      // a comment, an entity of an invisible character or punctuation alone is hollow.
      let j = i + 1;
      while (j < lines.length && lines[j].trim() === '') j++;
      const next = j < lines.length && !fenced[j] ? agreementBody(lines[j]).body : '';
      const just = /^Justification: (.*)$/.exec(next);
      const hollow = !just || !hasText(just[1]);
      if (degree !== 'fully agree' && hollow) { ruleBroken += 1; out.push(row('NO_JUSTIFICATION', { at, participant: m[1], item: m[2], degree })); continue; }
      if (degree.startsWith('absolutely')) {
        // The confirmation is read from the visible text of the justification (a citation inside a
        // comment confirms nothing), and at least one citation must resolve to a fact of the tree:
        // registered, archived and generated name the absence of a file, never a confirmation
        // (R-L7-002.8).
        const cites = citationsOf(ctx, d.rel, visibleText(just[1]));
        if (!cites.length) { ruleBroken += 1; out.push(row('NO_CONFIRMATION', { at, reason: 'the justification names no citation of the confirmation' })); continue; }
        const bad = cites.filter(c => c.outcome === 'unresolved');
        if (bad.length) { ruleBroken += 1; out.push(row('NO_CONFIRMATION', { at, reason: `the confirmation does not resolve: ${bad.map(c => c.ref).join(', ')}` })); continue; }
        if (!cites.some(c => c.outcome === 'resolved')) { ruleBroken += 1; out.push(row('NO_CONFIRMATION', { at, reason: `no citation resolves to a fact of the tree (${cites.map(c => `${c.ref} is ${c.outcome}`).join(', ')})` })); continue; }
      }
      valid += 1;
    }
  }
  const code = malformed ? 2 : (ruleBroken ? 1 : 0);
  out.push(row('COUNT', { agreements: valid + malformed + ruleBroken, valid, malformed, ruleBroken }));
  out.push(row('RESULT', { exit: code, files: docs.length }));
  return { code, lines: out };
}

// ---------- prose (P-L7-001: only the checks no other tool makes) ----------

const CAPS = { 'review-prompt': 150, 'review-report': 250 }; // PROTO-DEC-0038 item 3
function kindOf(rel) {
  if (/^docs\/reviews\/.+\.md$/.test(rel)) return /prompt/i.test(path.posix.basename(rel)) ? 'review-prompt' : 'review-report';
  if (/^docs\/research\/\d{4}-\d{2}-\d{2}-[^/]+\/.+\.md$/.test(rel)) return 'research';
  if (/^docs\/specs\/.+\.md$/.test(rel)) return 'spec';
  if (/^docs\/core-arch\/[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*-\d+\.md$/.test(rel)) return 'program-plan';
  return null;
}
const familyOf = kind => (kind && kind.startsWith('review-') ? 'review' : kind);
// The header region: the visible lines before the first visible `## ` heading (R-L7-001 step 2:
// "before the first `## ` heading"). The 40-line cap was removed, which silently
// skipped fields and a `Superseded by:` target below it; it keeps fenced and comment-hidden
// lines out of the header through the shared mask. A line a reader does not see fills no field.
function headerOf(text) {
  const out = [];
  for (const l of visibleLines(text)) {
    if (l.hidden) continue;
    if (/^## /.test(l.text)) break;
    out.push({ n: l.n, text: l.text });
  }
  return out;
}
const FIELD = /^(?:\s*[-*]\s+)?\**([A-Za-zА-Яа-яЁё][A-Za-zА-Яа-яЁё -]*?)\**:\s*(.*)$/;
function fieldsOf(header, names) {
  const out = [];
  for (const h of header) {
    const m = FIELD.exec(h.text);
    if (m && names.includes(m[1].trim().toLowerCase())) out.push({ n: h.n, value: m[2].trim() });
  }
  return out;
}
function calendarDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}
const DATE_OR_UNKNOWN = v => (v === 'unknown' || calendarDate(v) ? null : 'a date is YYYY-MM-DD (a real calendar day) or the word unknown');
// A standard no-value marker is not a filled field: R-L7-001.15 writes the value that is not
// known as `unknown`. Closed
// list, letter case ignored, one optional trailing period stripped first; every other value is
// the author's text and stands. The marker is compared with the value a reader
// sees (records.cjs textOf - the one definition of text), and a whitespace run inside it is markup
// noise, not identity, so `N\u200b/A`, `N<!--x-->/A` and `N&#47;A` are all the marker `N/A`, not a
// filled value; a value that only spells a marker through its letters (`N A`) is not an author.
const PLACEHOLDER = /^(?:n\/a|na|n\.a|tbd|t\.b\.d|none|null|undefined|nil|no|notknown|notapplicable|nonerecorded|nodata|unknownyet)$/i;
const placeholderOf = v => (PLACEHOLDER.test(v.replace(/\.$/, '').replace(/\s+/g, '')) ? v : null);
// R-L7-001.10: the transcription line is judged on the text a reader sees
// (records.cjs INVISIBLE removed first, so an invisible mark cannot hide a malformed line), and
// its date is a real calendar day of the ISO calendar with a real UTC time - `2026-99-99` and
// `T99:99Z` are malformed lines, never accepted values.
const TRANSCRIPTION = /^> Transcribed from chat by [^,]+, model: [^,]+, date: (\d{4}-\d{2}-\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?Z)?[ \t]*$/;
function transcriptionOk(line) {
  const m = TRANSCRIPTION.exec(line);
  if (!m) return false;
  if (!calendarDate(m[1])) return false;
  if (m[2] !== undefined && (Number(m[2]) > 23 || Number(m[3]) > 59 || (m[4] !== undefined && Number(m[4]) > 59))) return false;
  return true;
}
const DATED = name => (/^(\d{4}-\d{2}-\d{2})/.exec(path.posix.basename(name)) || [])[1];

function runProse(ctx, docs) {
  const out = [];
  let problems = 0; let checked = 0; let skipped = 0;
  const add = (tok, at, fields) => { problems += 1; out.push(row(tok, { at, ...fields })); };
  for (const d of docs) {
    const kind = kindOf(d.rel);
    if (!kind) {
      if (d.explicit) throw new InputError(`${d.rel} is none of the P-L7-001 kinds (review report or prompt, research, spec, program plan)`);
      skipped += 1; continue;
    }
    checked += 1;
    const text = readDoc(ctx, d.rel);
    const lines = text.split('\n');
    const header = headerOf(text);
    // A header field is filled when its value carries text (hasText); a field the author cannot
    // fill is written `unknown` (P-L7-001 step 2), and an empty line is not a filled field. A standard no-value marker (N/A, TBD, ...) is not a filled field either (R-L7-001.15). One field written twice with two values is unknown, never the
    // first one.
    const need = (label, names, { grammar, many = false } = {}) => {
      const found = fieldsOf(header, names);
      if (!found.length) { add('HEADER', `${d.rel}:1`, { kind, missing: label }); return; }
      // The value judged and echoed is the value a reader sees, read through the
      // one definition of text (records.cjs textOf, imported as visibleText) - a zero-width mark,
      // an HTML comment and a numeric entity are not authorship, so a no-value marker written with
      // such noise inside is the marker, and two values conflict when their visible text does.
      for (const f of found) f.seen = visibleText(textSafe.unwrapEmphasis(f.value));
      for (const f of found) {
        if (!hasText(f.value)) { add('HEADER', `${d.rel}:${f.n}`, { kind, empty: label, reason: 'an empty field is not filled; write unknown when the value is not known' }); continue; }
        const ph = placeholderOf(f.seen);
        if (ph) { add('HEADER', `${d.rel}:${f.n}`, { kind, placeholder: label, value: ph.slice(0, 40), reason: 'a value that is not known is written unknown (R-L7-001.15)' }); continue; }
        const bad = grammar && grammar(f.seen);
        if (bad) add(grammar.token || 'HEADER', `${d.rel}:${f.n}`, { kind, ...bad });
      }
      if (!many && new Set(found.map(f => f.seen)).size > 1) add('HEADER', `${d.rel}:${found[1].n}`, { kind, conflict: label, first: `${d.rel}:${found[0].n}`, reason: 'two values for one field: the field is unknown' });
    };
    const status = (allowed, re) => Object.assign(v => (re.test(v) ? null : { value: v.slice(0, 40), allowed }), { token: 'STATUS' });
    const date = v => { const bad = DATE_OR_UNKNOWN(v); return bad ? { field: 'Date', value: v.slice(0, 40), reason: bad } : null; };
    if (CAPS[kind] !== undefined && lineCount(text) > CAPS[kind]) add('CAP', `${d.rel}:1`, { kind, lines: lineCount(text), cap: CAPS[kind] });
    if (kind === 'research') {
      if (!header.some(h => /advisory, not a decision/i.test(h.text))) add('HEADER', `${d.rel}:1`, { kind, missing: 'Advisory, not a decision' });
      need('Date', ['date'], { grammar: date });
      need('Base', ['base', 'baseline', 'reviewed commit sha']);
    }
    if (kind === 'spec') {
      need('Author', ['author']);
      need('Base', ['base', 'baseline']);
      // R-L7-001.8: a change of status is a new header line, so every Status line is checked. The closed token ends at a boundary that is not a letter, digit, `_` or `-`
      // - the word boundary of an earlier grammar accepted `spec-evil` and `spec_evil` because `\b`
      // holds between a letter and a joiner; unknown values never pass.
      need('Status', ['status'], { many: true, grammar: status('spec|implemented|superseded', /^(spec|implemented|superseded)(?![\p{L}\p{N}_-])/u) });
    }
    if (kind === 'program-plan') {
      // R-L7-001.15: only a specification's Status gains a line per change;
      // a plan has one status, so two lines with two values are a conflict, never the first.
      // The closed token ends as the spec status does (no joiner).
      need('Status', ['status', 'статус'], { grammar: status('предложение|proposal', /^(?:предложение|proposal)(?![\p{L}\p{N}_-])/iu) });
      if (!header.some(h => /(?<![A-Za-z0-9-])(?:PROTO-)?DEC-\d{4}(?![0-9])/.test(h.text))) add('HEADER', `${d.rel}:1`, { kind, missing: 'decision id' });
    }
    // R-L7-001.4: `Superseded by:` names exactly one citation, a path or a link,
    // that resolves to another file of the same kind (a review names a review); a decision, record,
    // rule or commit id is not the new file, and a dated name older than this one is not new.
    for (const sup of fieldsOf(header, ['superseded by'])) {
      const at = `${d.rel}:${sup.n}`;
      const cites = citationsOf(ctx, d.rel, sup.value);
      if (cites.length !== 1) { add('SUPERSEDED_BY', at, { reason: cites.length ? `names ${cites.length} citations; the line names exactly one new file` : 'names no file' }); continue; }
      const c = cites[0];
      if (!['path', 'link'].includes(c.cls)) { add('SUPERSEDED_BY', at, { ref: c.ref, reason: `a ${c.cls} citation is not the new file; name the new ${kind} file` }); continue; }
      if (c.outcome !== 'resolved') { add('SUPERSEDED_BY', at, { ref: c.ref, reason: c.reason || `the target is ${c.outcome}, not a file of the tree` }); continue; }
      if (!ctx.fileSet.has(c.target)) { add('SUPERSEDED_BY', at, { ref: c.ref, reason: 'names a directory, not a file' }); continue; }
      if (c.target === d.rel) { add('SUPERSEDED_BY', at, { ref: c.ref, reason: 'names the document itself' }); continue; }
      if (familyOf(kindOf(c.target)) !== familyOf(kind)) { add('SUPERSEDED_BY', at, { ref: c.ref, reason: `names ${kindOf(c.target) ? `a ${kindOf(c.target)}` : 'a document of no P-L7-001 kind'}, not a new ${kind}` }); continue; }
      const mine = DATED(d.rel); const theirs = DATED(c.target);
      if (mine && theirs && theirs < mine) add('SUPERSEDED_BY', at, { ref: c.ref, reason: `the named file is dated ${theirs}, older than this document (${mine})` });
    }
    const fenced = textSafe.fenceMap(lines, 'show');
    lines.forEach((l, i) => {
      // The candidate and the grammar both see the line without its invisible characters:
      // a zero-width mark after `>` used to take the line out of the check entirely.
      const seen = l.replace(INVISIBLE, '');
      if (!fenced[i] && /^>\s*transcribed from chat by/i.test(seen) && !transcriptionOk(seen)) add('TRANSCRIPTION', `${d.rel}:${i + 1}`, { reason: 'not "> Transcribed from chat by <who>, model: <name>, date: <ISO>"' });
    });
  }
  if (!checked) throw new InputError(`no document of a P-L7-001 kind among ${docs.length} file(s); nothing was checked`);
  const code = problems ? 1 : 0;
  out.push(row('COUNT', { checked, skipped, problems }));
  out.push(row('RESULT', { exit: code, files: docs.length }));
  return { code, lines: out };
}

// ---------- copy (P-L7-002) ----------
//
// ADVISORY: the copy detector is never a completion gate.
// Exit 1 on a finding is the explicit CLI contract, same class as `check`
// unresolved citations - never an automatic gate input.
//
// Text is read through the shared kernel mask (text-safe maskMarkdown): fenced code, fence parity,
// HTML comments/blocks, indented code, table lines, code spans and link destinations are the
// library's own "not the document's statement" kinds - no private regex reimplementation of them.
// Paths, ids and commit hexes are claimed by the SAME closed citation FORMS this file already
// uses for `check` (extract), never a second private list of exclusions.

function extractProseWords(text, rel) {
  const decoded = textSafe.decodeText(text, { invisible: 'refuse' });
  if (!decoded.ok) throw new InputError('copy text is outside the canonical domain');
  const { lines } = textSafe.maskMarkdown(text);
  const visible = textSafe.ownLines(text, { partial: 'include' });
  const { secretIn } = require('./lib/secrets.cjs');
  const words = [];
  let inHeader = true;
  for (const own of visible) {
    const i = own.line - 1;
    const info = lines[i];
    const raw = info.text;
    if (info.kinds.some(k => ['heading', 'setext-heading'].includes(k))) continue;
    // Do not turn a credential into apparently harmless words at the output boundary.
    if (secretIn(raw)) continue;
    const seen = own.text;
    const trimmed = seen.trim();
    if (!trimmed) continue;

    if (/^##\s+/.test(trimmed)) inHeader = false;

    // Headings excluded: a title is not the prose under comparison.
    if (/^#{1,6}\s+/.test(trimmed)) continue;

    // Metadata header fields before the first ## excluded (same FIELD grammar as P-L7-001).
    if (inHeader && FIELD.test(trimmed)) continue;

    // Shell / CLI command lines excluded (closed command-word list, not a free-text heuristic).
    if (EXCLUDED_COMMAND_LINE.test(trimmed)) continue;

    // Agreement lines excluded (they are formulaic by grammar, not copied prose).
    if (isCandidate(raw)) continue;

    // Blank shared-mask spans, then claim citation tokens with the SAME closed FORMS as `check`
    // (paths, path:line, decision/record/rule ids, commit hexes) so a second private exclusion
    // list can never drift from the citation grammar.
    let lineText = seen;
    for (const c of extract(lineText, { spans: true })) {
      const { start, end } = c.claim;
      if (end > start && end <= lineText.length) {
        lineText = lineText.slice(0, start) + ' '.repeat(end - start) + lineText.slice(end);
      }
    }
    // Root-level filenames use the same segment and extension grammar as citations.
    const filename = new RegExp(`${NOT_BEFORE}${SEG}\\.${EXT}${NOT_AFTER}`, 'giu');
    lineText = lineText.replace(filename, m => ' '.repeat(m.length));

    // Words: Unicode letters/digits tokens with at least one letter (numbers alone are not prose).
    const re = /[\p{L}\p{M}\p{N}]+/gu;
    let m;
    while ((m = re.exec(lineText)) !== null) {
      const token = m[0];
      if (!/\p{L}/u.test(token)) continue;
      words.push({
        word: token.normalize('NFC').toLowerCase(),
        original: token,
        line: i + 1,
        col: m.index + 1,
        doc: rel,
      });
    }
  }
  return words;
}

const EXCLUDED_COMMAND_LINE = /^\s*(?:[$>]|[#]\s*!\/bin\/|(?:node|npm|npx|git|powershell|pwsh|bash|sh|uvx|python|cargo|mvn|gradle)\b)/i;

function findCopies(docsWithWords, windowSize = 8, { self = false } = {}) {
  if (!Number.isSafeInteger(windowSize) || windowSize < 3) throw new InputError('invalid copy window');
  const copies = [];
  const index = new Map();
  for (let d = 0; d < docsWithWords.length; d++) {
    const words = docsWithWords[d].words;
    for (let i = 0; i <= words.length - windowSize; i++) {
      const key = words.slice(i, i + windowSize).map(w => w.word).join(' ');
      let list = index.get(key);
      if (!list) { list = []; index.set(key, list); }
      list.push({ d, i });
    }
  }

  const pairMatches = new Map();
  for (const [key, entries] of index) {
    if (entries.length < 2) continue;
    for (let p1 = 0; p1 < entries.length; p1++) {
      const e1 = entries[p1];
      const startP2 = self ? p1 : p1 + 1;
      for (let p2 = startP2; p2 < entries.length; p2++) {
        const e2 = entries[p2];
        if (e1.d === e2.d) {
          if (!self) continue;
          if (Math.abs(e1.i - e2.i) < windowSize || e1.i >= e2.i) continue;
        } else if (e1.d > e2.d) {
          continue;
        }
        const pairKey = e1.d + ':' + e2.d;
        let list = pairMatches.get(pairKey);
        if (!list) { list = []; pairMatches.set(pairKey, list); }
        list.push({ i: e1.i, j: e2.i });
      }
    }
  }

  for (const [pairKey, rawMatches] of pairMatches) {
    const [a, b] = pairKey.split(':').map(Number);
    const docA = docsWithWords[a];
    const docB = docsWithWords[b];
    const wordsA = docA.words;
    const wordsB = docB.words;

    rawMatches.sort((m1, m2) => m1.i - m2.i || m1.j - m2.j);
    const coalesced = [];
    for (const m of rawMatches) {
      const prev = coalesced.find(c => c.endI === m.i && c.endJ === m.j);
      if (prev) {
        prev.endI = m.i + 1;
        prev.endJ = m.j + 1;
        prev.length += 1;
      } else {
        const covered = coalesced.some(c => m.i - c.startI === m.j - c.startJ && m.i >= c.startI && m.i < c.endI);
        if (!covered) {
          coalesced.push({ startI: m.i, endI: m.i + 1, startJ: m.j, endJ: m.j + 1, length: windowSize });
        }
      }
    }

    for (const c of coalesced) {
      const spanWords = wordsA.slice(c.startI, c.startI + c.length);
      copies.push({
        at: `${docA.rel}:${wordsA[c.startI].line}`,
        other: `${docB.rel}:${wordsB[c.startJ].line}`,
        window: c.length,
        words: spanWords.map(w => w.word).join(' '),
      });
    }
  }
  return copies;
}

function runCopy(ctx, docs, { windowSize = 8, self = false } = {}) {
  const out = [];
  if (!docs.length) throw new InputError('no document to check');
  const docsWithWords = docs.map(d => {
    const read = pathSafe.readFileGuarded(ctx.realRoot, d.rel);
    if (!read.ok) throw new InputError('copy input read is unverified');
    const dec = textSafe.decode(read.bytes, { crlf: 'normalise', invisible: 'refuse' });
    if (!dec.ok) throw new InputError('copy input text is outside the canonical domain');
    return { rel: d.rel, words: extractProseWords(dec.text, d.rel) };
  });
  const copies = findCopies(docsWithWords, windowSize, { self });
  for (const c of copies) {
    out.push(row('COPY', { at: c.at, other: c.other, window: c.window, words: c.words }));
  }
  const pairs = docs.length * (docs.length - 1) / 2;
  const code = copies.length ? 1 : 0;
  out.push(row('COUNT', { checked: docs.length, pairs, copies: copies.length }));
  out.push(row('RESULT', { exit: code, files: docs.length, copies: copies.length }));
  return { code, lines: out };
}

// ---------- CLI ----------

const HELP = `protocol-prose.cjs - layer L7 checks (P-L7-001, P-L7-002); deterministic, read-only

  check [--root <dir>] <path>...   citations (path:line, path:a-b, path, markdown link, record and
                                   rule ids, decision ids, commit ids): exit 1 when one does not
                                   resolve; one UNRESOLVED line per item
  agree [--root <dir>] <path>...   agreement lines: exit 2 outside the grammar, 1 without the
                                   justification or the confirmation the degree needs
  prose [--root <dir>] <path>...   caps and headers of P-L7-001 kinds: exit 1 on a problem
  copy  [--root <dir>] [--window <n>] [--self] <path>...
                                   ADVISORY (never a completion gate): copied prose between
                                   documents via sliding windows of normalized words (default 8);
                                   exit 1 only when this command is run explicitly and finds a copy
A directory argument means its tracked .md files. The root defaults to the current directory.`;

function main(argv) {
  const [cmd, ...rest] = argv;
  if (cmd === '--help' || cmd === '-h') { process.stdout.write(`${HELP}\n`); return 0; }
  if (!cmd) { process.stdout.write(`${HELP}\n${row('RESULT', { exit: 2, reason: 'no command' })}\n`); return 2; }
  if (!['check', 'agree', 'prose', 'copy'].includes(cmd)) { process.stdout.write(`${row('RESULT', { exit: 2, reason: `unknown command ${cmd}` })}\n`); return 2; }
  let root = '.';
  let windowSize = 8;
  let self = false;
  const paths = [];
  try {
    for (let i = 0; i < rest.length; i++) {
      if (rest[i] === '--root') { if (rest[i + 1] === undefined) throw new InputError('--root needs a value'); root = rest[++i]; }
      else if (rest[i] === '--window') {
        if (rest[i + 1] === undefined) throw new InputError('--window needs a value');
        const value = rest[++i];
        const n = Number(value);
        if (cmd !== 'copy' || !/^[1-9][0-9]*$/.test(value) || !Number.isSafeInteger(n) || n < 3) throw new InputError('--window must be an integer >= 3');
        windowSize = n;
      }
      else if (rest[i] === '--self') { if (cmd !== 'copy') throw new InputError('--self requires copy'); self = true; }
      else if (rest[i].startsWith('--')) throw new InputError(`unknown flag ${rest[i]}`);
      else paths.push(rest[i]);
    }
    const ctx = context(root);
    const docs = expand(ctx, paths);
    const r = cmd === 'check' ? runCheck(ctx, docs)
      : cmd === 'agree' ? runAgree(ctx, docs)
      : cmd === 'prose' ? runProse(ctx, docs)
      : runCopy(ctx, docs, { windowSize, self });
    process.stdout.write(`${r.lines.join('\n')}\n`);
    return r.code;
  } catch (e) {
    if (!(e instanceof InputError)) throw e;
    process.stdout.write(`${row('RESULT', { exit: 2, reason: e.message })}\n`);
    return 2;
  }
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main, extract, kindOf, lineCount, AGREEMENT, DEGREES, runCopy, findCopies, extractProseWords };

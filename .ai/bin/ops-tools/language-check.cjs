'use strict';

// A heuristic, WARN-only scan of the language contract. The
// protocol keeps documentation in Russian and code, identifiers, commit
// subjects and CLI prompts English and ASCII. This tool looks for the
// violations the existing encoding guard (CM-70) cannot see:
//
//   CYRILLIC-CODE  Cyrillic in a code position of a .cjs file (an
//                  identifier). String literals, template literals (at any
//                  ${} nesting depth), comments and regular-expression data
//                  hold Russian prose and patterns on purpose and are
//                  allowed; an identifier is not.
//   MOJIBAKE       the CP1251 round-trip byte signatures on a .cjs file. The
//                  encoding guard scans them only on .md/.txt/.json/.jsonl;
//                  this tool closes the source-code gap. Honours the same
//                  .ai/encoding-allowlist.txt.
//   MOJIBAKE-C1    the reverse signature family no guard looks for:
//                  U+00D0/U+00D1 followed by a C1 control (U+0080..U+009F),
//                  Cyrillic bytes once read as Latin-1 and saved back.
//   COMMIT-SUBJECT a non-ASCII commit subject in the range under check
//                  (base..HEAD). The subject text is never echoed.
//   UNREADABLE     a tracked .cjs file that is not valid UTF-8 (skipped; for
//                  protocol-owned text this is already CM-16 FAIL material).
//
// WARN only: findings line the report and never change the exit status, so
// no existing history or train can break. The tool exits 0 with findings and
// 1 only when it cannot enumerate its inputs (an internal refusal). Working
// code and identifiers of this file stay ASCII; Cyrillic appears only as
// \u escapes (PROTO-DEC-0153 item 6, no mojibake propagation).
//
// The scan targets tracked .cjs files only: .md/.txt/.json/.jsonl are already
// covered by the encoding guard (no duplicated reporting) and any non-ASCII
// byte in a .ps1 file is already a CM-19 FAIL, stronger than any WARN here.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const REPORT_CAP = 50;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

// Include the supplementary Cyrillic blocks, not just U+0400..U+04FF.
function isCyrillicCodePoint(value) {
  return /\p{Script=Cyrillic}/u.test(String.fromCodePoint(value));
}

// The CP1251 round-trip signatures the encoding guard already knows, plus the
// C1 reverse family. Escapes keep this file free of mojibake bytes.
const MOJIBAKE_PATTERNS = [
  fromCodePoints(0x0420, 0x00b5, 0x0420), // Cyrillic UTF-8 read as CP1251 and saved back
  fromCodePoints(0x0421, 0x0402, 0x0420),
  fromCodePoints(0x0420, 0x0405, 0x0420),
  fromCodePoints(0x0421, 0x201a, 0x0420),
  fromCodePoints(0x0432, 0x0402),
  fromCodePoints(0x0420, 0x0454, 0x0420),
];

// One utf-8 buffer per row of code points: escapes never reach this file's
// bytes (the source stays pure ASCII, PROTO-DEC-0153 item 6).
function fromCodePoints(...codePoints) {
  return Buffer.from(String.fromCodePoint(...codePoints), 'utf8');
}

// scanSource: Cyrillic in code positions of one script text. A stack of
// parser contexts tracks string, template (nested ${} to any depth), comment
// and regex-literal data; only a character seen in a code position counts.
// The scanner is a heuristic: it never rejects input, it only reports.
function scanSource(text) {
  const hits = [];
  const codeFrame = expression => ({ kind: 'code', sig: '', word: '', property: false, label: false,
    depth: 0, parens: [], braces: [], classes: [], expression });
  const stack = [codeFrame(false)];
  let line = 1;
  let i = 0;
  const throughEscape = () => {
    if (text[i + 1] === '\n') line++;
    i += 2;
  };
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    const frame = stack[stack.length - 1];
    if (ch === '\n') line++;
    if (frame.kind === 'code') {
      if (i === 0 && ch === '#' && next === '!') { while (i < text.length && text[i] !== '\n') i++; continue; }
      if (ch === '/' && next === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
      if (ch === '/' && next === '*') { stack.push({ kind: 'block' }); i += 2; continue; }
      if (ch === '/') {
        const afterValue = frame.sig === '' || frame.sig === '(' || frame.sig === '[' || frame.sig === '{'
          || frame.sig === '=' || frame.sig === ',' || frame.sig === ':' || frame.sig === ';'
          || frame.sig === '!' || frame.sig === '&' || frame.sig === '|' || frame.sig === '?'
          || frame.sig === '^' || frame.sig === '%' || frame.sig === '*' || frame.sig === '+'
          || frame.sig === '-' || frame.sig === '~' || frame.sig === '<' || frame.sig === '>'
          || frame.sig === '@';
        const keyword = !frame.property && ['return', 'typeof', 'case', 'in', 'of', 'instanceof', 'new',
          'delete', 'void', 'do', 'else', 'yield', 'await', 'throw'].includes(frame.word);
        if (afterValue || keyword) { stack.push({ kind: 'regex', inClass: false }); i++; continue; }
      }
      if (ch === "'" || ch === '"') { stack.push({ kind: 'string', quote: ch }); i++; continue; }
      if (ch === '`') { stack.push({ kind: 'template' }); i++; continue; }
      if (ch === '}' && frame.depth === 0 && stack.length > 1) { stack.pop(); i++; continue; }
      if ((ch === '+' || ch === '-') && next === ch) {
        // A postfix update ends a value; a prefix update still expects one.
        const postfix = /[A-Za-z0-9_$)\]}]/.test(frame.sig);
        frame.sig = postfix ? 'x' : ch; frame.word = ''; i += 2; continue;
      }
      if (ch === '(') frame.parens.push(!frame.property && ['if', 'for', 'while', 'switch', 'catch', 'with'].includes(frame.word));
      if (ch === ')') {
        frame.sig = frame.parens.pop() ? ';' : ')'; frame.word = ''; i++; continue;
      }
      if (ch === '{') {
        const pending = frame.classes[frame.classes.length - 1];
        const classBody = pending && pending.depth === frame.depth && pending.parens === frame.parens.length;
        const block = classBody ? frame.classes.pop().statement
          : (frame.sig === '' && !frame.expression) || [';', ')', '>'].includes(frame.sig)
            || (frame.sig === ':' && frame.label)
            || (!frame.property && ['else', 'try', 'finally', 'do', 'catch', 'static'].includes(frame.word));
        frame.braces.push(block); frame.depth++; frame.sig = '{'; frame.word = ''; i++; continue;
      }
      if (ch === '}') {
        frame.depth = Math.max(0, frame.depth - 1);
        frame.sig = frame.braces.pop() ? ';' : '}'; frame.word = ''; i++; continue;
      }
      // An escaped identifier still denotes its decoded code point. Escapes
      // inside strings/templates/regex never reach this code context.
      if (ch === '\\' && next === 'u') {
        const escaped = /^\\u(?:\{([0-9a-fA-F]{1,6})\}|([0-9a-fA-F]{4}))/.exec(text.slice(i));
        if (escaped) {
          const point = parseInt(escaped[1] || escaped[2], 16);
          if (point <= 0x10ffff && isCyrillicCodePoint(point)) hits.push({ line });
          frame.sig = 'x'; frame.word = ''; i += escaped[0].length; continue;
        }
      }
      if (isCyrillicCodePoint(text.codePointAt(i))) hits.push({ line });
      if (/[A-Za-z_$]/.test(ch)) {
        const word = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(text.slice(i))[0];
        frame.property = frame.sig === '.';
        frame.label = (frame.sig === '' && !frame.expression) || frame.sig === ';'
          || (frame.sig === '{' && frame.braces[frame.braces.length - 1] === true);
        if (word === 'class' && !frame.property) frame.classes.push({
          depth: frame.depth, parens: frame.parens.length, statement: frame.label,
        });
        frame.sig = word[word.length - 1]; frame.word = word; i += word.length; continue;
      }
      if (!/\s/.test(ch)) {
        frame.sig = ch;
        frame.word = '';
      }
      i += text.codePointAt(i) > 0xffff ? 2 : 1; continue;
    }
    if (frame.kind === 'block') {
      if (ch === '*' && next === '/') {
        stack.pop(); i += 2; continue; // a comment does not change code context
      }
      i++; continue;
    }
    if (frame.kind === 'string') {
      if (ch === '\\') { throughEscape(); continue; }
      if (ch === frame.quote || ch === '\n') {
        stack.pop();
        const parent = stack[stack.length - 1];
        if (parent.kind === 'code') { parent.sig = 'x'; parent.word = ''; }
        i++; continue;
      }
      i++; continue;
    }
    if (frame.kind === 'template') {
      if (ch === '\\') { throughEscape(); continue; }
      if (ch === '`') {
        stack.pop();
        const parent = stack[stack.length - 1];
        if (parent.kind === 'code') { parent.sig = 'x'; parent.word = ''; }
        i++; continue;
      }
      if (ch === '$' && next === '{') { stack.push(codeFrame(true)); i += 2; continue; }
      i++; continue;
    }
    if (frame.kind === 'regex') {
      if (ch === '\\') { throughEscape(); continue; }
      if (ch === '\n' || (ch === '/' && !frame.inClass)) {
        stack.pop();
        const parent = stack[stack.length - 1];
        if (parent.kind === 'code') { parent.sig = ch === '\n' ? ';' : 'x'; parent.word = ''; }
        if (ch === '/') {
          while (i + 1 < text.length && /[A-Za-z]/.test(text[i + 1])) i++;
        }
        i++; continue;
      }
      if (ch === '[') frame.inClass = true;
      else if (ch === ']') frame.inClass = false;
      i++; continue;
    }
  }
  return hits;
}

// scanMojibake: byte signatures over the raw file. One finding per class per
// file, at the first line the signature appears on: a corrupted file is one
// quarantine action, not one line per repetition.
function scanMojibake(bytes) {
  const hits = [];
  let direct = -1;
  const lineAt = offset => {
    let line = 1;
    for (let at = 0; at < offset && at < bytes.length; at++) if (bytes[at] === 0x0a) line++;
    return line;
  };
  for (const pattern of MOJIBAKE_PATTERNS) {
    const at = bytes.indexOf(pattern);
    if (at !== -1 && (direct === -1 || at < direct)) direct = at;
  }
  // The remaining two byte signatures ride the 0xC3 lead byte: U+00D0/U+00D1
  // (C3 90/C3 91). Followed by a Cyrillic UTF-8 lead byte (D0/D1) it is the
  // direct class the encoding guard already knows; followed by a C1 control
  // (C2 80..C2 9F) it is the reverse class no guard looks for.
  let reverse = -1;
  for (let at = bytes.indexOf(0xc3); at !== -1 && at + 1 < bytes.length; at = bytes.indexOf(0xc3, at + 1)) {
    const lead = bytes[at + 1];
    if (lead !== 0x90 && lead !== 0x91) continue;
    if ((direct === -1 || at < direct) && at + 2 < bytes.length && (bytes[at + 2] === 0xd0 || bytes[at + 2] === 0xd1)) direct = at;
    if (reverse === -1 && at + 3 < bytes.length && bytes[at + 2] === 0xc2
      && bytes[at + 3] >= 0x80 && bytes[at + 3] <= 0x9f) reverse = at;
  }
  if (direct !== -1) hits.push({ line: lineAt(direct), code: 'MOJIBAKE' });
  if (reverse !== -1) hits.push({ line: lineAt(reverse), code: 'MOJIBAKE-C1' });
  return hits;
}

// parseSubjects: rows of git log --format=%H%x1f%s output. Byte-level non-ASCII
// detection keeps the answer exact even for partially invalid UTF-8.
function parseSubjects(buffer) {
  const rows = [];
  if (!Buffer.isBuffer(buffer)) return rows;
  const text = buffer.toString('utf8');
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const at = line.indexOf('\u001f');
    if (at === -1) continue;
    const sha = line.slice(0, at);
    const subject = Buffer.from(line.slice(at + 1), 'utf8');
    if (sha.length < 40) continue;
    let nonAscii = false;
    const cyrillic = [...subject.toString('utf8')].some(ch => isCyrillicCodePoint(ch.codePointAt(0)));
    for (let i = 0; i < subject.length && !nonAscii; i++) {
      const byte = subject[i];
      if (byte > 0x7f) {
        nonAscii = true;
      }
    }
    rows.push({ sha, nonAscii, cyrillic });
  }
  return rows;
}

// The mojibake allowlist: same grammar as the encoding guard (one
// repository-relative path per line, '#' comments, a trailing '*' matches any
// suffix, case-insensitive).
function loadAllowlist(root) {
  const full = path.join(root, '.ai', 'encoding-allowlist.txt');
  let content;
  try {
    content = fs.readFileSync(full, 'utf8');
  } catch {
    return [];
  }
  const entries = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    entries.push(line.split('\\').join('/').toLowerCase());
  }
  return entries;
}

function isAllowlisted(normalized, entries) {
  const lowered = normalized.toLowerCase();
  for (const entry of entries) {
    if (entry.endsWith('*')) {
      if (lowered.startsWith(entry.slice(0, -1))) return true;
    } else if (lowered === entry) {
      return true;
    }
  }
  return false;
}

// checkTree: the whole check over one repository. git lists tracked files and
// the commit range, both filtered to ASCII arguments only; the tree root
// travels as the cwd, never as a -C argument.
function checkTree(options = {}) {
  const root = path.resolve(options.root || '.');
  const readFile = options.readFile || (full => fs.readFileSync(full));
  const gitRunner = options.git
    || (args => spawnSync('git', args, { cwd: root, encoding: 'buffer', windowsHide: true, maxBuffer: 128 * 1024 * 1024 }));
  const findings = [];
  const counts = { files: 0, commits: 0, 'cyrillic-code': 0, mojibake: 0, 'mojibake-c1': 0,
    'commit-subject': 0, unreadable: 0, allowlisted: 0, 'subjects-skipped': 0 };
  const listed = gitRunner(['ls-files', '-z']);
  if (listed.error || listed.signal || !Buffer.isBuffer(listed.stdout) || listed.status !== 0) {
    const error = new Error('tracked file enumeration refused (git ls-files failed)');
    error.code = 'LANGUAGE-CHECK-REFUSED';
    throw error;
  }
  const allowlist = loadAllowlist(root);
  const files = listed.stdout.toString('utf8').split('\0').filter(Boolean);
  for (const relative of files) {
    const normalized = relative.split('\\').join('/');
    if (path.extname(normalized).toLowerCase() !== '.cjs') continue;
    counts.files++;
    let bytes;
    try {
      bytes = readFile(path.join(root, normalized));
    } catch {
      findings.push({ class: 'UNREADABLE', path: normalized, line: 0, message: 'tracked .cjs unreadable (gone or locked)' });
      counts.unreadable++;
      continue;
    }
    let text;
    try {
      text = UTF8.decode(bytes);
    } catch {
      findings.push({ class: 'UNREADABLE', path: normalized, line: 0, message: 'not valid UTF-8 (skipped)' });
      counts.unreadable++;
      continue;
    }
    if (isAllowlisted(normalized, allowlist)) counts.allowlisted++;
    else for (const hit of scanMojibake(bytes)) {
      findings.push({ class: hit.code, path: normalized, line: hit.line,
        message: hit.code === 'MOJIBAKE-C1'
          ? 'reverse mojibake signature (U+00D0/U+00D1 followed by a C1 control)'
          : 'mojibake signature (UTF-8 read as CP1251 and saved back)' });
      if (hit.code === 'MOJIBAKE-C1') counts['mojibake-c1']++; else counts.mojibake++;
    }
    for (const hit of scanSource(text)) {
      findings.push({ class: 'CYRILLIC-CODE', path: normalized, line: hit.line,
        message: 'Cyrillic in a code position (identifier); strings, comments and regex data are allowed' });
      counts['cyrillic-code']++;
    }
  }
  const base = options.base;
  if (base) {
    const log = gitRunner(['log', `--format=%H%x1f%s`, `${base}..HEAD`]);
    if (log.error || log.signal || !Buffer.isBuffer(log.stdout) || log.status !== 0) {
      const error = new Error(`commit subject enumeration refused (git log ${base}..HEAD failed)`);
      error.code = 'LANGUAGE-CHECK-REFUSED';
      throw error;
    }
    const rows = parseSubjects(log.stdout);
    for (const row of rows) {
      counts.commits++;
      if (row.nonAscii) {
        findings.push({ class: 'COMMIT-SUBJECT', path: row.sha.slice(0, 12), line: 1,
          message: row.cyrillic
            ? 'commit subject holds Cyrillic; subjects stay English and ASCII (text withheld)'
            : 'commit subject holds non-ASCII; subjects stay English and ASCII (text withheld)' });
        counts['commit-subject']++;
      }
    }
  } else {
    counts['subjects-skipped'] = 1;
  }
  return { findings, counts };
}

function formatFindings(result) {
  const lines = [];
  const byClass = new Map();
  for (const finding of result.findings) {
    if (!byClass.has(finding.class)) byClass.set(finding.class, []);
    byClass.get(finding.class).push(finding);
  }
  for (const [className, list] of byClass) {
    for (const finding of list.slice(0, REPORT_CAP)) {
      lines.push(`LANG ${className} ${finding.path}:${finding.line} ${finding.message}`);
    }
    if (list.length > REPORT_CAP) {
      lines.push(`LANG +${list.length - REPORT_CAP} more findings of class ${className} (report cap ${REPORT_CAP})`);
    }
  }
  const c = result.counts;
  lines.push(`LANG SUMMARY files=${c.files} commits=${c.commits} cyrillic-code=${c['cyrillic-code']}`
    + ` mojibake=${c.mojibake} mojibake-c1=${c['mojibake-c1']} commit-subject=${c['commit-subject']}`
    + ` unreadable=${c.unreadable} allowlisted=${c.allowlisted} subjects-skipped=${c['subjects-skipped']}`);
  return lines;
}

function main(argv) {
  const args = argv.slice();
  const value = name => {
    const at = args.indexOf(name);
    if (at === -1) return null;
    const valueFound = args[at + 1];
    if (!valueFound || valueFound.startsWith('--')) throw new Error(`option ${name} requires a value`);
    args.splice(at, 2);
    return valueFound;
  };
  let result;
  try {
    const root = value('--root') || '.';
    const base = value('--base');
    if (args.length) throw new Error('unknown or repeated option');
    result = checkTree({ root, base });
  } catch (e) {
    process.stderr.write(`LANGUAGE-CHECK-REFUSED ${e.message}\n`);
    return 1;
  }
  for (const line of formatFindings(result)) process.stdout.write(`${line}\n`);
  return 0; // findings are WARN only and never change the exit status
}

module.exports = { scanSource, scanMojibake, parseSubjects, loadAllowlist, isAllowlisted, checkTree, formatFindings, main };

if (require.main === module) process.exitCode = main(process.argv.slice(2));

#!/usr/bin/env node
'use strict';
// reserved-names.cjs - read-only checker of repository paths that Windows cannot hold or holds as a
// different file (after a NUL-named file once broke a repository snapshot).
//
// Every rule is a closed definition, not a list of exclusions:
//   RESERVED     a segment whose stem (text before the first dot, trailing spaces removed) is one of
//                CON PRN AUX NUL CONIN$ CONOUT$ COM1-9 LPT1-9 COM/LPT with a superscript 1 2 3,
//                compared without case (any extension is still the device: NUL.txt, nul .md)
//   TRAILING     a segment that ends with a dot or a space (Windows drops it: "a." and "a" are one file)
//   CHARACTER    a segment character outside the Windows file name alphabet (code points 0-31 and
//                < > : " / \ | ? *), or U+FFFD (a name git could not hand over as UTF-8)
//   SHORTNAME    a segment of the 8.3 alias form (up to 6 characters, ~, digits, extension of up to 3),
//                which may name another file of the same directory
//   SEGMENT      an empty segment, "." or "..", an absolute path or a drive letter
//   LENGTH       a segment over 255 UTF-16 units, or root length + 1 + path length over --max-path
//                (default 260, the Windows MAX_PATH of a checkout without long path support)
//   CASE         two different spellings of one path or directory that are equal without case
//
// Input: the tracked tree of --root (git ls-files -z, so quoted and Unicode names arrive verbatim),
// optionally its untracked files (--untracked), and candidate paths (--path, --list). Read-only:
// it never writes, never renames and never blocks anything by itself. Exit 0 clean, 1 one line per
// problem, 2 input error (an input that cannot be read is never reported as clean). A --list file is
// read with .ai/bin/lib/path-safe.cjs readFileGuarded from the drive root (links in any ancestor,
// hardlinks and changing snapshots are refused), decoded by .ai/bin/lib/text-safe.cjs decode.

const fs = require('node:fs');
const path = require('node:path');
const realPath = require('../../.ai/bin/lib/real-path.cjs');
const { execFileSync } = require('node:child_process');
const textSafe = require('../../.ai/bin/lib/text-safe.cjs');
const pathSafe = require('../../.ai/bin/lib/path-safe.cjs');
const { safeLine } = require('./diagnostic.cjs');

const DEVICE_STEMS = new Set(['CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$']);
for (const base of ['COM', 'LPT']) {
  for (const d of ['1', '2', '3', '4', '5', '6', '7', '8', '9', '\u00b9', '\u00b2', '\u00b3']) DEVICE_STEMS.add(base + d);
}
// The Windows file name alphabet is every code point from 32 up except these nine.
const FORBIDDEN_CHARS = new Set(['<', '>', ':', '"', '/', '\\', '|', '?', '*']);
const SHORTNAME = /^[^.~]{1,6}~[0-9]+(\.[^.]{0,3})?$/;
const DEFAULT_MAX_PATH = 260;
const MAX_SEGMENT = 255;

function utf16Length(s) { return s.length; }

function deviceStem(segment) {
  const dot = segment.indexOf('.');
  const stem = (dot === -1 ? segment : segment.slice(0, dot)).replace(/ +$/, '');
  return stem.toUpperCase();
}

function isReservedSegment(segment) { return DEVICE_STEMS.has(deviceStem(segment)); }

// Problems of one segment; used by the path grammar of write-set-check and check-plan as well.
function segmentProblems(segment) {
  const out = [];
  if (segment === '' || segment === '.' || segment === '..') {
    out.push({ code: 'SEGMENT', detail: segment === '' ? 'empty segment' : `segment "${segment}"` });
    return out;
  }
  if (isReservedSegment(segment)) out.push({ code: 'RESERVED', detail: `device name ${deviceStem(segment)} in "${segment}"` });
  if (/[. ]$/.test(segment)) out.push({ code: 'TRAILING', detail: `"${segment}" ends with ${segment.endsWith('.') ? 'a dot' : 'a space'}` });
  for (const ch of segment) {
    const cp = ch.codePointAt(0);
    if (cp < 32 || FORBIDDEN_CHARS.has(ch)) { out.push({ code: 'CHARACTER', detail: `code point U+${cp.toString(16).toUpperCase().padStart(4, '0')} in "${printable(segment)}"` }); break; }
    if (cp === 0xfffd) { out.push({ code: 'CHARACTER', detail: `U+FFFD (not valid UTF-8) in "${printable(segment)}"` }); break; }
  }
  if (SHORTNAME.test(segment)) out.push({ code: 'SHORTNAME', detail: `"${segment}" has the 8.3 alias form` });
  if (utf16Length(segment) > MAX_SEGMENT) out.push({ code: 'LENGTH', detail: `segment of ${utf16Length(segment)} UTF-16 units (limit ${MAX_SEGMENT})` });
  return out;
}

function printable(s) {
  return s.replace(/[\u0000-\u001f]/g, c => `\\x${c.charCodeAt(0).toString(16).padStart(2, '0')}`);
}

// Problems of one repository-relative path (forward slashes). rootLength is the length of the
// checkout root the path will live under; null skips the MAX_PATH check (a lexical candidate).
function pathProblems(rel, options = {}) {
  const out = [];
  if (typeof rel !== 'string' || rel.length === 0) return [{ code: 'SEGMENT', detail: 'empty path' }];
  if (rel.startsWith('/') || /^[A-Za-z]:/.test(rel) || rel.startsWith('\\')) {
    out.push({ code: 'SEGMENT', detail: 'absolute path or drive letter' });
  }
  const body = rel.replace(/^\/+/, '');
  for (const segment of body.split('/')) for (const p of segmentProblems(segment)) out.push(p);
  const maxPath = options.maxPath || DEFAULT_MAX_PATH;
  if (Number.isInteger(options.rootLength)) {
    const total = options.rootLength + 1 + utf16Length(rel);
    if (total > maxPath) out.push({ code: 'LENGTH', detail: `full path of ${total} UTF-16 units (limit ${maxPath})` });
  }
  return out;
}

// Case collisions over the whole set, every directory prefix included ("A/x" and "a/y").
function caseCollisions(paths) {
  const spellings = new Map();
  for (const rel of paths) {
    const segs = rel.split('/');
    for (let i = 1; i <= segs.length; i++) {
      const prefix = segs.slice(0, i).join('/');
      const key = prefix.toUpperCase();
      if (!spellings.has(key)) spellings.set(key, new Set());
      spellings.get(key).add(prefix);
    }
  }
  const out = [];
  for (const set of spellings.values()) {
    if (set.size > 1) {
      const list = [...set].sort();
      out.push({ code: 'CASE', path: list[0], detail: `one name on Windows: ${list.map(s => JSON.stringify(s)).join(' ')}` });
    }
  }
  return out;
}

function checkPaths(paths, options = {}) {
  const problems = [];
  const unique = [...new Set(paths)];
  for (const rel of unique) for (const p of pathProblems(rel, options)) problems.push({ path: rel, ...p });
  for (const c of caseCollisions(unique)) problems.push(c);
  return { count: unique.length, problems };
}

function gitList(root, args) {
  const out = execFileSync('git', args, { cwd: root, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  // -z output is raw bytes; an invalid UTF-8 name decodes to U+FFFD and is then reported (CHARACTER).
  return out.toString('utf8').split('\0').filter(Boolean);
}

function realRoot(root) {
  let st;
  try { st = fs.statSync(root); } catch { throw new Error(`--root does not exist: ${root}`); }
  if (!st.isDirectory()) throw new Error(`--root is not a directory: ${root}`);
  return realPath.realPathSync(root);
}

function readList(file) {
  const abs = path.resolve(file);
  const guard = pathSafe.readFileGuarded(path.parse(abs).root, abs);
  if (!guard.ok) {
    if (guard.reason === 'link') throw new Error(`--list is a link (refused): ${file}`);
    throw new Error(`--list is not readable as a real file (${guard.reason}): ${file}`);
  }
  const d = textSafe.decode(guard.bytes, { bom: 'strip', crlf: 'normalise', invisible: 'refuse', finalNewline: 'report' });
  if (!d.ok) throw new Error(`--list is not decodable text (${d.problems.map(p => p.code).join(', ')})`);
  return d.text.split('\n').filter(line => line.length > 0);
}

function parseArgs(argv) {
  const o = { paths: [], lists: [], untracked: false, tracked: null, maxPath: DEFAULT_MAX_PATH, root: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    if (a === '--root') o.root = value();
    else if (a === '--path') o.paths.push(value());
    else if (a === '--list') o.lists.push(value());
    else if (a === '--untracked') o.untracked = true;
    else if (a === '--tracked') o.tracked = true;
    else if (a === '--max-path') {
      const v = value();
      // The closed form is the message it prints - a positive integer (one to
      // five digits, no leading zero); the old two-to-five-digit regex refused 1..9 while the
      // message said "positive integer".
      if (!/^[1-9][0-9]{0,4}$/.test(v)) throw new Error(`--max-path must be a positive integer: ${v}`);
      o.maxPath = Number(v);
    } else throw new Error(`unknown argument: ${a}`);
  }
  // Without candidates the tracked tree is the input; with candidates it is added only on --tracked.
  if (o.tracked === null) o.tracked = o.paths.length === 0 && o.lists.length === 0;
  return o;
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write('usage: reserved-names.cjs (--path P... | --list FILE | --tracked | --untracked) [--root DIR] [--max-path N]\n'); return 0; }
  let o;
  try { o = parseArgs(argv); } catch (e) { process.stderr.write(`ERROR ${safeLine(e.message)}\n`); return 2; }
  const say = s => process.stdout.write(`${safeLine(s)}\n`);
  let problems = [];
  let count = 0;
  try {
    const sets = [];
    if (o.tracked || o.untracked) {
      const root = realRoot(o.root || process.cwd());
      const rootLength = root.length;
      const tree = [];
      if (o.tracked) tree.push(...gitList(root, ['ls-files', '-z']));
      if (o.untracked) tree.push(...gitList(root, ['ls-files', '-z', '--others', '--exclude-standard']));
      sets.push({ paths: tree, rootLength });
    }
    const candidates = [...o.paths.map(p => p.replace(/\\/g, '/'))];
    for (const list of o.lists) candidates.push(...readList(list).map(p => p.replace(/\\/g, '/')));
    if (candidates.length) sets.push({ paths: candidates, rootLength: o.root ? realRoot(o.root).length : null });
    // One collision check across every input: a candidate that differs from a tracked path only in
    // case is the same file on Windows.
    const all = sets.flatMap(s => s.paths);
    const byPath = new Map();
    for (const s of sets) for (const p of s.paths) if (!byPath.has(p)) byPath.set(p, s.rootLength);
    for (const [rel, rootLength] of byPath) {
      for (const p of pathProblems(rel, { maxPath: o.maxPath, rootLength })) problems.push({ path: rel, ...p });
    }
    problems.push(...caseCollisions([...new Set(all)]));
    count = byPath.size;
  } catch (e) {
    process.stderr.write(`ERROR ${safeLine(e.message)}\n`);
    return 2;
  }
  if (count === 0) { process.stderr.write('ERROR no path to check (an empty input is never clean)\n'); return 2; }
  for (const p of problems) say(`${p.code} ${printable(p.path)} (${p.detail})`);
  if (problems.length) { say(`RESERVED-NAMES PROBLEMS ${problems.length} in ${count} path(s)`); return 1; }
  say(`RESERVED-NAMES OK ${count} path(s)`);
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { DEVICE_STEMS, DEFAULT_MAX_PATH, deviceStem, isReservedSegment, segmentProblems, pathProblems, caseCollisions, checkPaths, parseArgs, main };

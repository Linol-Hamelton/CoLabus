'use strict';
// owner-rules.cjs - the owner rules as a kernel record (PROTO-DEC-0235 item 4,
// PROTO-DEC-0236 item 2, PROTO-DEC-0237; guarantee K8).
//
// The confirmed list docs/ops/OWNER-RULES.md is the owner's document; this tool never writes it. The kernel record
// .ai/core/L1-meta/P-L1-003-owner-rules.md carries one rule line per row whose status is "in force" (the status cell
// starts with the word действует), generated from that row and byte-checked against it:
//
//   - R-L1-003.<n>. OR-<nnn> [<status cell>; <date cell>]: <rule cell>
//
// <n> is the number of the OR id, so a rule id never moves when another row changes. The cells are copied byte for byte
// as data (md-structure cellData: a code span of a cell is written as its content, any other Markdown in a cell is
// refused) except one declared transform (renderText): a drive-letter root `X:/` becomes `X: `, because no kernel line
// may carry a machine path; any other machine path is the refusal MACHINE_PATH. Rows with the status history
// (история) or lifted out (вынесено) never enter the record (PROTO-DEC-0237 item 1); a status of any other form is a
// named refusal, never a guess. The record keeps no balance, limit or other time-bound value of its own (fork 3) and
// no per-client number (fork 2): it carries the owner's confirmed text and nothing else.
//
//   parseSource(text)            strict parser of the one table of OWNER-RULES.md -> rows with a status class
//   renderRules(rows)            the exact text of the "## Rules" section of the record
//   check(root)                  findings: the record differs from the source, a citation names a missing rule
//   write(root)                  rewrites only the "## Rules" section of the record from the source
//
// Citations: every OR-<nnn> token and every R-L1-003.<n> token in the operator duties procedure and in every kernel
// record under .ai/core (except this record) must name a rule in force. A cited history, lifted or absent id is the
// finding RULE_CITATION_MISSING.
//
// A citation is a token of the full grammar: OR- and exactly three digits (OR-001 to OR-999), or R-L1-003. and a number
// without a leading zero; no id character may follow. Any other token of either family (OR-1, OR-001a, R-L1-003.01,
// R-L1-003.1.2) is the finding RULE_CITATION_MALFORMED with its named reason; a prefix is never accepted.
// A bare family name with no id (the placeholders OR-<nnn> and R-L1-003.<n>) cites nothing. An HTML character
// reference is not part of the grammar (closed by refusal; no decoder exists):
// nothing decodes one, and a reference in a word that could read as a rule id (OR&#45;099, &#79;R-005, OR-0&#57;9) is
// the finding ENTITY_REFUSED at its line; the owner list and the record refuse any reference. A look-alike character
// written as itself (U+2010 in place of "-") is not a reference and stays the declared look-alike residual.
//
// Markdown structure: the list and the record are read ONLY through the shared
// structural reader md-structure.cjs, never by a line pattern of this file. The list must hold exactly one table at its
// fixed header row; a "|" on any line outside it, any Markdown structure outside it other than headings, paragraphs,
// list items and code spans, and any row or cell outside the closed grammar refuse the whole list with a named reason
// (never a row skipped, never a row added). A cell is plain text; its one allowed construct, a code span, is written as
// its content (md-structure cellData). The record holds front matter, headings, paragraphs, list items and code spans
// only, its "## Rules" heading is a heading of its own statement, and a rule line outside that section is refused; its
// prose is checked for citations like every other kernel record. check also runs the packet compiler's machine-path
// detector over EVERY line of the record, not only over the generated rule lines.
//
// Real paths: every file is read through readContainedBytes: the shared guard path-safe realInside
// proves the real path inside the root (no link, junction, reparse point or hardlink on the way) before the open, the
// opened descriptor must be the file the guard saw, and the guard runs again after the read. write proves the record
// path the same way BEFORE any file is created, then writes through the shared atomic writer
// path-safe.writeAtomicGuarded: a temporary file in the same directory, re-read and compared byte for byte, then the
// rename. The source and the record are refused on an invisible character (BAD_TEXT, BAD_RECORD; every Default_Ignorable_Code_Point
// and Cf character by the shared predicate text-safe.isIgnorableFormat), so the byte check of the rule
// lines holds for what a reader sees; the other sections of the record are prose, checked for a machine path.
//
// Command line: node tools/operator-knowledge/owner-rules.cjs check|write [--root DIR]
// Exit: 0 clean, 1 findings, 2 a refused input (unreadable or unsafe file, malformed table, unknown status).

const fs = require('node:fs');
const path = require('node:path');
const pathSafe = require('../../.ai/bin/lib/path-safe.cjs');
const textSafe = require('../../.ai/bin/lib/text-safe.cjs');
const md = require('./md-structure.cjs');
const packet = require('../../.ai/bin/protocol-packet.cjs');

const SOURCE_REL = 'docs/ops/OWNER-RULES.md';
const RECORD_REL = '.ai/core/L1-meta/P-L1-003-owner-rules.md';
const DUTIES_REL = 'docs/ops/OPERATOR-DUTIES.md';
const CORE_REL = '.ai/core';
const ANCHOR = 'R-L1-003';
const HEADER = '| id | правило | дата | источник | статус |';
const SEPARATOR = '|---|---|---|---|---|';
const RULE_ID = /^OR-(\d{3})$/;
// The status cell decides: the first word classifies the row. Order matters only for readability; the words differ.
const STATUS_CLASSES = Object.freeze([['действует', 'in-force'], ['история', 'history'], ['вынесено', 'lifted']]);
const RULES_INTRO = [
  'Generated from the rows in force of `docs/ops/OWNER-RULES.md` by `node tools/operator-knowledge/owner-rules.cjs write`',
  'and byte-checked by its `check`; never edit a rule line by hand. A change of any rule needs the owner\'s word in',
  'that list first (PROTO-DEC-0237 item 6); the operator never edits the list by itself.',
].join('\n');

// The one refusal class of both readers (md-structure.cjs).
const { Refusal } = md;

// The bytes of root/rel, or { ok: false, unsafe, code, detail }. unsafe is true when the shared guard refused the path
// (a link, junction or reparse point on the way, a hardlink, a path outside the root) or the file changed under the
// read; a file that does not exist is not unsafe. detail holds the relative path and a reason, never an absolute path.
function readContainedBytes(root, rel) {
  const target = path.join(root, ...rel.split('/'));
  const unsafe = why => ({ ok: false, unsafe: true, code: 'UNSAFE_PATH', detail: `${rel}: ${why}` });
  const g = pathSafe.realInside(root, target, { refuseHardlinks: true });
  if (!g.ok) return unsafe(g.reason);
  if (!g.exists) return { ok: false, unsafe: false, code: 'UNREADABLE', detail: `${rel}: ENOENT` };
  if (g.type !== 'file') return unsafe('not a regular file');
  let fd = null;
  try {
    const before = fs.lstatSync(g.real, { bigint: true });
    fd = fs.openSync(g.real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.nlink !== 1n) return unsafe('the opened file is not the file the guard saw');
    const bytes = fs.readFileSync(fd);
    const post = pathSafe.realInside(root, target, { refuseHardlinks: true });
    if (!post.ok || !post.exists || post.real !== g.real) return unsafe('the path changed during the read');
    const after = fs.lstatSync(post.real, { bigint: true });
    if (after.dev !== opened.dev || after.ino !== opened.ino) return unsafe('the path changed during the read');
    return { ok: true, bytes };
  } catch (error) {
    return { ok: false, unsafe: false, code: 'UNREADABLE', detail: `${rel}: ${(error && error.code) || 'read error'}` };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* read only: nothing was written */ } }
  }
}

function readText(root, rel, policy = {}) {
  const read = readContainedBytes(root, rel);
  if (!read.ok) throw new Refusal(read.code, read.detail);
  const decoded = textSafe.decode(read.bytes, policy);
  if (!decoded.ok) throw new Refusal('BAD_TEXT', `${rel}: ${decoded.problems.map(p => p.code).join(',')}`);
  return decoded.text;
}

// The source and the record: an invisible character is refused, so the byte check holds for what a reader sees.
const STRICT = md.STRICT;

// The status cell decides: the first word classifies the row. A status in force is the word действует alone or followed
// by a space; a colon or another separator right after it, or a word of withdrawal anywhere in the cell, is a status of
// no known form (UNKNOWN_STATUS), never read as in force.
const WITHDRAWN = /история|вынесен|отмен|снят|не действует/u;
function statusClass(status) {
  const first = status.split(/[\s(;,:]/)[0];
  const hit = STATUS_CLASSES.find(([word]) => word === first);
  if (!hit) return null;
  if (hit[1] === 'in-force' && (!/^действует(?:$| )/u.test(status) || WITHDRAWN.test(status))) return null;
  return hit[1];
}

// The one table of the source, read by the shared structural reader (cells as data); then the grammar of each row:
// the id is OR-<nnn>, unique and ascending; the status is in force, history or lifted out.
function parseSource(text) {
  const { rows: table } = md.readRulesTable(text, { header: HEADER, separator: SEPARATOR, columns: 5 });
  const rows = [];
  let last = 0;
  for (const { line, cells } of table) {
    const [id, rule, date, source, status] = cells;
    const m = RULE_ID.exec(id);
    if (!m) throw new Refusal('BAD_ROW', `line ${line}: the first cell is not an owner id (OR- and three digits)`);
    const n = Number(m[1]);
    if (n <= last) throw new Refusal('BAD_ROW', `line ${line}: ${id} is not after the previous id (ids are unique and ascending)`);
    last = n;
    const cls = statusClass(status);
    if (!cls) throw new Refusal('UNKNOWN_STATUS', `line ${line}: ${id} has a status that is neither in force, history nor lifted out`);
    rows.push({ id, n, rule, date, source, status, cls, line });
  }
  return rows;
}

// No line of a kernel record may carry a machine path (packet compiler PC-15). The one
// transform of the owner's text: a drive-letter root `X:/` or `X:\` is written in the spaced form `X: ` that the
// compiler's detector reads as prose. Any other machine path left after it is a named refusal, never a silent kernel line.
const DRIVE_ROOT = /(?<![\p{L}\p{N}])(\p{L}):[\\/]+/gu;
const renderText = text => text.replace(DRIVE_ROOT, '$1: ');

function ruleLine(row) {
  const line = `- ${ANCHOR}.${row.n}. ${row.id} [${renderText(row.status)}; ${renderText(row.date)}]: ${renderText(row.rule)}`;
  const hits = packet.machinePathHits(line);
  if (hits.length) throw new Refusal('MACHINE_PATH', `${row.id} keeps a machine path (${hits[0].kind}) after the drive-root transform; the kernel cannot carry it`);
  return line;
}

function renderRules(rows) {
  const inForce = rows.filter(row => row.cls === 'in-force');
  return `${RULES_INTRO}\n\n${inForce.map(row => ruleLine(row)).join('\n')}\n`;
}

// The "## Rules" section of a record, read by the shared structural reader: { before, body, after, bodyStart, bodyEnd }
// (the body is lines bodyStart to bodyEnd of the record, counted from 1).
const rulesSection = text => md.readRecordSections(text);

const sectionText = rules => `\n${rules}\n`;

// The Markdown files below rel, as repository-relative paths. A link or junction in the walk is refused, never followed
// and never skipped (a skipped directory would hide its citations).
function listMarkdown(root, rel) {
  const out = [];
  const dir = path.join(root, ...rel.split('/'));
  const g = pathSafe.realInside(root, dir);
  if (!g.ok) throw new Refusal('UNSAFE_PATH', `${rel}: ${g.reason}`);
  if (!g.exists) return out;
  if (g.type !== 'dir') throw new Refusal('UNSAFE_PATH', `${rel}: not a directory`);
  for (const entry of fs.readdirSync(g.real, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
    const child = `${rel}/${entry.name}`;
    if (entry.isSymbolicLink()) throw new Refusal('UNSAFE_PATH', `${child}: link`);
    if (entry.isDirectory()) out.push(...listMarkdown(root, child));
    else if (entry.name.endsWith('.md')) out.push(child);
  }
  return out;
}

function citingFiles(root) {
  const files = listMarkdown(root, CORE_REL).filter(rel => rel !== RECORD_REL);
  if (fs.existsSync(path.join(root, ...DUTIES_REL.split('/')))) files.push(DUTIES_REL);
  return files;
}

// A token of either family: the family name, then id characters, a dot or a hyphen only between two id characters.
const ID_CHAR = '[\\p{L}\\p{N}_]';
const CITATION = new RegExp(`(?<![\\p{L}\\p{N}_-])(OR-|${ANCHOR})((?:${ID_CHAR}|[.-](?=${ID_CHAR}))*)`, 'gu');

// null for a token of the full grammar, else the reason it is not a rule id.
function malformedReason(family, tail) {
  if (family === 'OR-') {
    if (/^\d{3}$/.test(tail)) return null;
    if (/^\d+$/.test(tail)) return 'an owner id has exactly three digits';
    if (/^\d{3}/.test(tail)) return 'characters follow the three digits of the owner id';
    return 'not OR- and three digits';
  }
  if (/^\.[1-9]\d*$/.test(tail)) return null;
  if (/^\.0\d*$/.test(tail)) return 'a rule number has no leading zero';
  if (/^\.\d+/.test(tail)) return 'characters follow the rule number (a sub-rule or an alias is not a rule id)';
  return `not ${ANCHOR}. and a number`;
}

// A character reference is not part of the grammar of a citing text (PROTO-DEC-0216): it is
// never decoded. A word (a run of the line without a blank; a rule id never holds one) that holds a reference form and
// could read as a text holding a family name (OR- or R-L1-003) through some reading of its references (md-structure
// canShow: every reading tried, none chosen) is the finding ENTITY_REFUSED at its line, and no token of that word is
// read. Every other word is read as written.
const FAMILIES = Object.freeze(['OR-', ANCHOR]);

function citations(text) {
  const out = [];
  text.split('\n').forEach((line, i) => {
    const refused = [];
    for (const w of line.matchAll(/\S+/gu)) {
      if (!FAMILIES.some(family => md.canShow(w[0], family, false))) continue;
      refused.push([w.index, w.index + w[0].length]);
      out.push({ token: w[0].length > 80 ? `${w[0].slice(0, 80)}...` : w[0], n: null, line: i + 1, code: 'ENTITY_REFUSED', malformed: `the character reference ${md.ENTITY_FORM.exec(w[0])[0]} in a word that could read as a rule id; a character reference is not read: write the id and the characters around it plainly` });
    }
    for (const m of line.matchAll(CITATION)) {
      const [token, family, tail] = m;
      if (tail === '') continue; // the bare family name of a placeholder cites nothing
      if (refused.some(([start, end]) => m.index >= start && m.index < end)) continue;
      const malformed = malformedReason(family, tail);
      out.push({ token, n: malformed ? null : Number(family === 'OR-' ? tail : tail.slice(1)), line: i + 1, malformed });
    }
  });
  return out;
}

function check(root) {
  root = path.resolve(root);
  const findings = [];
  const rows = parseSource(readText(root, SOURCE_REL, STRICT));
  const recordText = readText(root, RECORD_REL, STRICT);
  // No line of the record, prose included, may carry a machine path (packet compiler PC-15).
  for (const hit of packet.machinePathHits(recordText)) findings.push({ code: 'MACHINE_PATH', path: `${RECORD_REL}:${hit.line}`, detail: `a machine path (${hit.kind}) in a line of the kernel record` });
  const parts = rulesSection(recordText);
  const { body } = parts;
  const expected = sectionText(renderRules(rows));
  const actual = `${body.join('\n')}\n`;
  if (actual !== expected) {
    const want = expected.split('\n');
    const got = actual.split('\n');
    let i = 0;
    while (i < want.length && i < got.length && want[i] === got[i]) i++;
    findings.push({ code: 'RECORD_DIFFERS', path: RECORD_REL, detail: `the "## Rules" section differs from the rows in force of ${SOURCE_REL} at section line ${i + 1}; run: node tools/operator-knowledge/owner-rules.cjs write` });
  }
  const inForce = new Set(rows.filter(row => row.cls === 'in-force').map(row => row.n));
  const known = new Map(rows.map(row => [row.n, row]));
  // The record's own prose cites like every kernel record; its rule lines are checked byte for byte above.
  const prose = citations(recordText).filter(c => c.line < parts.bodyStart || c.line > parts.bodyEnd);
  const cited = [[RECORD_REL, prose], ...citingFiles(root).map(rel => [rel, citations(readText(root, rel))])];
  for (const [rel, list] of cited) {
    for (const c of list) {
      if (c.code) {
        findings.push({ code: c.code, path: `${rel}:${c.line}`, detail: `${c.token}: ${c.malformed}` });
        continue;
      }
      if (c.malformed) {
        findings.push({ code: 'RULE_CITATION_MALFORMED', path: `${rel}:${c.line}`, detail: `${c.token} is not a rule id: ${c.malformed}` });
        continue;
      }
      if (inForce.has(c.n)) continue;
      const row = known.get(c.n);
      const why = row ? `its status is ${row.cls}, not in force` : 'no such rule';
      findings.push({ code: 'RULE_CITATION_MISSING', path: `${rel}:${c.line}`, detail: `${c.token} is cited but ${why}` });
    }
  }
  return { rows, inForce: inForce.size, findings };
}

// opts.writer replaces the shared atomic writer (a test seam with its signature); nothing else changes.
function write(root, opts = {}) {
  root = path.resolve(root);
  const rows = parseSource(readText(root, SOURCE_REL, STRICT));
  const target = path.join(root, ...RECORD_REL.split('/'));
  // The write path is proven BEFORE any file is created: a real path inside the root, no link on the way.
  const guard = pathSafe.realInside(root, target, { refuseHardlinks: true });
  if (!guard.ok) throw new Refusal('UNSAFE_PATH', `${RECORD_REL}: ${guard.reason}`);
  if (!guard.exists) throw new Refusal('UNREADABLE', `${RECORD_REL}: ENOENT`);
  if (guard.type !== 'file') throw new Refusal('UNSAFE_PATH', `${RECORD_REL}: not a regular file`);
  const current = readText(root, RECORD_REL, STRICT);
  const parts = rulesSection(current);
  const next = [...parts.before, ...sectionText(renderRules(rows)).split('\n').slice(0, -1), ...parts.after].join('\n');
  if (next === current) return { rows, changed: false };
  const bytes = Buffer.from(next, 'utf8');
  const writer = opts.writer || pathSafe.writeAtomicGuarded;
  // The temporary file is re-read and compared before the rename; a difference leaves the record byte for byte.
  const verify = ({ temp }) => {
    if (!fs.readFileSync(temp).equals(bytes)) throw Object.assign(new Error('the temporary file differs'), { code: 'WRITE_VERIFY' });
  };
  const written = writer(target, bytes, { root, onTempWritten: verify });
  if (!written || written.ok !== true) throw new Refusal('WRITE_FAILED', `${RECORD_REL}: ${written ? `${written.reason}: ${written.detail}` : 'no result'}`);
  return { rows, changed: true };
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write('usage: owner-rules.cjs check|write [--root DIR]\n'); return 0; }
  const [command, ...rest] = argv;
  let root = path.join(__dirname, '..', '..');
  if (rest.length === 2 && rest[0] === '--root') root = path.resolve(rest[1]);
  else if (rest.length) { process.stderr.write('usage: owner-rules.cjs check|write [--root DIR]\n'); return 2; }
  try {
    if (command === 'check') {
      const r = check(root);
      for (const f of r.findings) process.stdout.write(`FINDING ${f.code} ${f.path} ${f.detail}\n`);
      process.stdout.write(`OWNER_RULES rows=${r.rows.length} inForce=${r.inForce} findings=${r.findings.length} exit=${r.findings.length ? 1 : 0}\n`);
      return r.findings.length ? 1 : 0;
    }
    if (command === 'write') {
      const r = write(root);
      process.stdout.write(`OWNER_RULES rows=${r.rows.length} record=${RECORD_REL} state=${r.changed ? 'written' : 'fresh'}\n`);
      return 0;
    }
    process.stderr.write('usage: owner-rules.cjs check|write [--root DIR]\n');
    return 2;
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    process.stdout.write(`OWNER_RULES REFUSED ${error.code}: ${error.detail}\n`);
    return 2;
  }
}

module.exports = { SOURCE_REL, RECORD_REL, DUTIES_REL, ANCHOR, HEADER, SEPARATOR, RULES_INTRO, Refusal, parseSource, renderRules, renderText, rulesSection, citations, citingFiles, check, write, statusClass, readContainedBytes };

if (require.main === module) process.exitCode = main(process.argv.slice(2));

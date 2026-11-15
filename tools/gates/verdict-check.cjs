#!/usr/bin/env node
'use strict';
// verdict-check.cjs - does a report's verdict agree with its own findings table? (card am1:I-016;
// PROTO-DEC-0127 item 8, PROTO-DEC-0038, PROTO-DEC-0041; ADVICE only.)
//
// The verdict of a report has ONE reader, the frozen .ai/bin/lib/verdict-read.cjs (shared guards,
// section 4): the closing line, or a keyed line in the header when
// a Mode line is there. This tool asks that reader for the token and adds only diagnostics when it
// refuses: MISSING (no verdict-shaped own line anywhere), NONCANONICAL (a line looks like a verdict
// but no token the frozen reader accepts) or AMBIGUOUS (conflicting sources, or two different tokens
// in shaped lines). The private verdict grammar of the first round is gone; a quoted, listed,
// fenced or data-block line is never the report's verdict.
//
// The findings ledger is the report's own data table: the ledger lines are the table lines the
// shared mask (tools/gates/report-lines.cjs) reports, which excludes tables inside fences, comments,
// quotes and <data id=N> blocks (a quoted foreign ledger is not this report's ledger). The header
// row needs the cells ID, Severity, Disposition and Reproduction (exact names, any case, emphasis
// removed; the Russian word for reproduction is the one other name of Reproduction), each named
// EXACTLY ONCE (a role named twice makes the ledger ambiguous, never
// first-column-wins), and the delimiter row the SAME cell count (otherwise the table is reported
// as broken while readable rows still contribute). Multiline inline spans touching table rows
// and table-shaped lines lost to those spans are incomplete ledger data, never silently absent.
//
// Closed grammar of the cells:
//   row          same cell count as the header; Severity one of HIGH MEDIUM LOW INFO; Disposition
//                one of confirmed refuted fixed-and-verified deferred-by-owner unresolved (the closed
//                sets of the template and of .ai/bin/protocol-verdict.cjs), each in the canonical or
//                the annotated form. Any other row is UNPARSED. Rows end at the first line that is
//                not a table row.
//   identity     nonempty ID, unique after NFC across all ledgers; repeated IDs are ambiguous,
//                excluded from evaluated rows and reported as UNPARSED, even if values agree.
//   open row     Disposition confirmed or unresolved
//   reproduction a Reproduction cell that is not empty and not one of - -- (em dash) n/a none and the Russian "no"
//
// Rules (each line names one report and one rule):
//   PASS-WITH-OPEN-HIGH      PASS while an open HIGH row exists (template: PASS only with zero
//                            mandatory defects unresolved; HIGH blocks)
//   RECOMMENDATION-WITH-OPEN-HIGH  RECOMMENDATION while an open HIGH row exists (RECOMMENDATION covers
//                            optional improvements only)
//   FAIL-WITHOUT-REPRODUCTION FAIL while no open row has a reproduction (PROTO-DEC-0038: a FAIL needs
//                            a reproduction, else it is advisory)
//   OPEN-HIGH-WITHOUT-REPRODUCTION  FAIL or BLOCKED and an open HIGH row has no reproduction (one
//                            reproduction per claim)
//   OPEN-FINDING-WITHOUT-REPRODUCTION  FAIL or BLOCKED and an open non-HIGH row has no reproduction
//                            (R-L2-004.7: every open claim, not only the highest severity)
// A MEDIUM row does not trigger PASS/RECOMMENDATION blocking: its protected-path context is unknown.
//
// Result per report: INCONSISTENT (a rule fired), UNCHECKABLE (no canonical verdict, no ledger, or an
// unparsed row and no rule fired), CONSISTENT. Exit 0 all consistent, 1 any inconsistent, 2 otherwise
// (an unknown is never consistent). Every input file is guarded by .ai/bin/lib/path-safe.cjs
// readFileGuarded from the drive root (links in ANY ancestor and hardlinks are refused; bytes
// are read through one descriptor and verified as a snapshot); a report in --dir that cannot
// be read as a regular file is an ERROR line, never a silent drop. It never changes a verdict,
// never writes report bytes, and nothing it prints is Evidence. The shared Windows descriptor
// helper may compile to OS temp; unavailable verification is an error, never an unguarded fallback.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const textSafe = require('../../.ai/bin/lib/text-safe.cjs');
const pathSafe = require('../../.ai/bin/lib/path-safe.cjs');
const verdictRead = require('../../.ai/bin/lib/verdict-read.cjs');
const { analyzeText } = require('./report-lines.cjs');
const { safeLine } = require('./diagnostic.cjs');

const VERDICTS = ['PASS', 'RECOMMENDATION', 'FAIL', 'BLOCKED'];
const SEVERITIES = ['HIGH', 'MEDIUM', 'LOW', 'INFO'];
const DISPOSITIONS = ['confirmed', 'refuted', 'fixed-and-verified', 'deferred-by-owner', 'unresolved'];
const OPEN = new Set(['confirmed', 'unresolved']);
const EMPTY_REPRO = new Set(['', '-', '--', '\u2014', 'n/a', 'none', '\u043d\u0435\u0442']);
const REPRO_NAMES = new Set(['reproduction', '\u0432\u043e\u0441\u043f\u0440\u043e\u0438\u0437\u0432\u0435\u0434\u0435\u043d\u0438\u0435']);

function unemph(s) { return s.trim().replace(/^(\*\*|__|\*|_|`)+|(\*\*|__|\*|_|`)+$/g, '').trim(); }

// A cell or verdict value in one of two closed forms:
//   canonical  TOKEN (emphasis and one final dot allowed)
//   annotated  TOKEN, optional closing emphasis, then one separator of " (" " - " " (em dash) " ": " "; " ". "
//              and free text (the note is never read)
// Anything else ("HIGH if unfixed", "(was MEDIUM)", "PASS / APPROVED", "confirmed-invariant") is no
// token. Case is ignored; the token comes back in the case of the closed set. This reads CELLS only;
// the verdict of the report comes from the frozen reader, not from here.
const SEPARATORS = [' (', ' - ', ' \u2014 ', ': ', '; ', '. '];
function leadToken(text, set) {
  const s = unemph(text);
  const exact = unemph(s.replace(/\.$/, ''));
  const hit = set.find(t => t.toLowerCase() === exact.toLowerCase());
  if (hit) return { token: hit, form: 'canonical' };
  for (const t of set) {
    if (s.slice(0, t.length).toLowerCase() !== t.toLowerCase()) continue;
    let rest = s.slice(t.length);
    rest = rest.replace(/^(\*\*|__|\*|_|`)+/, '');
    if (SEPARATORS.some(sep => rest.startsWith(sep))) return { token: t, form: 'annotated' };
  }
  return { token: null, form: null };
}

// The report's own statements: wholly outside every masked span, outside data blocks.
function liveLines(text) {
  return analyzeText(text).statements;
}

// A line that LOOKS like a verdict line (the shape only; the token never comes from here).
const VERDICT_LINE = /^\s*(?:>\s*|[-*]\s+)?(?:\*\*|__)?Verdict(?:\*\*|__)?\s*:\s*(?:\*\*|__)?\s*(.*?)\s*$/;

// The report's verdict: the frozen reader decides (closing line, or the header when a Mode line is
// there); this function only names WHY it refused, so the operator can look.
function readVerdict(text) {
  const a = analyzeText(text);
  const v = verdictRead.readVerdict(a.stripped);
  if (v.token) return { status: 'OK', token: v.token, source: v.source };
  if (v.reason === 'conflicting-sources') return { status: 'AMBIGUOUS', token: null };
  if (v.reason === 'undecodable') return { status: 'UNDECODABLE', token: null };
  const found = [];
  for (const { n, line } of a.statements) {
    const m = VERDICT_LINE.exec(line);
    if (!m) continue;
    const lead = leadToken(m[1], VERDICTS);
    found.push({ n, raw: m[1], token: lead.token });
  }
  if (!found.length) return { status: 'MISSING', token: null };
  const tokens = new Set(found.filter(f => f.token).map(f => f.token));
  if (tokens.size > 1) return { status: 'AMBIGUOUS', token: null, tokens: [...tokens] };
  const bad = found.find(f => !f.token) || found[0];
  return { status: 'NONCANONICAL', token: null, line: bad.n, raw: bad.raw.slice(0, 80) };
}

// A GFM row comes in TWO closed forms, with outer pipes and without
// them ("ID | Reproduction | Severity | Disposition" above a delimiter row is a legal table,
// and the shared mask M7 already recognises it). This tool's private row grammar read the
// leading-pipe form only, so a full pipe-less findings table was never a ledger and an open HIGH
// row beside a PASS verdict was CONSISTENT (reproduced). A row is now any line holding at least
// one pipe: outer pipes, when present, delimit and are not cells; a line without a pipe is never
// a row. The positive gates stay: the header must name at least two of the four finding roles,
// each exactly once, and the delimiter must match the header cell count.
function splitRow(line) {
  const t = line.trim();
  if (!t.includes('|')) return null;
  const cells = [];
  let cur = '';
  let endedAtDelimiter = false;
  for (let i = 0; i < t.length; i++) {
    endedAtDelimiter = false;
    if (t[i] === '\\' && t[i + 1] === '|') { cur += '|'; i++; continue; }
    if (t[i] === '|') { cells.push(cur.trim()); cur = ''; endedAtDelimiter = true; continue; }
    cur += t[i];
  }
  cells.push(cur.trim());
  // Both outer delimiters are independently optional. An escaped final pipe is cell content.
  if (t.startsWith('|')) cells.shift();
  if (endedAtDelimiter) cells.pop();
  return cells;
}

function isSeparator(cells) { return cells.length > 0 && cells.every(c => /^:?-{3,}:?$/.test(c)); }

// The findings ledgers of the report: a table that names at least two of the four roles (ID,
// Severity, Disposition, Reproduction) claims to be a findings ledger (the rule:
// fewer than two roles is data, not a ledger; some but not all four is a broken findings table
// that is reported, never silently dropped). All four roles named once: the rows are read to the
// first line that is not a table row, and a missing or malformed delimiter row is reported while
// the rows are still read (the header fixes the columns), so a broken second table never hides
// its rows.
function readLedgers(text) {
  const a = analyzeText(text);
  const live = a.ledger;
  const rows = [];
  const unparsed = a.ledgerForeign.map(f => ({ n: f.n, reason: `a table line holds masked foreign text (${[...f.kinds].sort().join(', ')})` }));
  // F-C5: a table row the mask never gave a table kind (an inline span crossed the row boundary)
  // is a lost row: it is unknown, never silently absent.
  for (const lost of a.ledgerLost) unparsed.push({ n: lost.n, reason: `a table row was lost to the mask (an inline span crossed rows: ${[...lost.kinds].sort().join(', ')})` });
  let ledgers = 0;
  for (let i = 0; i < live.length; i++) {
    const head = splitRow(live[i].line);
    if (!head) continue;
    const names = head.map(c => unemph(c).toLowerCase());
    const counts = {
      id: names.filter(n => n === 'id').length,
      severity: names.filter(n => n === 'severity').length,
      disposition: names.filter(n => n === 'disposition').length,
      reproduction: names.filter(n => REPRO_NAMES.has(n)).length,
    };
    // A table that names at least TWO of the four finding roles claims to
    // be a findings ledger (a positive grammar, not a checklist of refusals). A table that names
    // fewer is data, not a ledger. A table that names some but not all four roles is a BROKEN
    // findings table: renaming or dropping one column must not hide its rows, so it is reported as
    // unparsed and the report can no longer be CONSISTENT beside it.
    const named = Object.keys(counts).filter(r => counts[r] > 0);
    if (named.length < 2) continue;
    ledgers++;
    if (named.length < 4) {
      const missing = Object.keys(counts).filter(r => counts[r] === 0);
      unparsed.push({ n: live[i].n, reason: `the table names finding columns (${named.join(', ')}) but not all four roles (missing: ${missing.join(', ')}): its rows cannot be read and are not silently dropped` });
      continue;
    }
    // F-06: a role column named twice is an ambiguous ledger (two values from one source give
    // unknown, never the first or the newest); it is reported, and the rows are not guessed at.
    const dupRoles = Object.keys(counts).filter(r => counts[r] > 1);
    if (dupRoles.length) {
      unparsed.push({ n: live[i].n, reason: `the ledger header names a finding column twice (${dupRoles.sort().join(', ')}): the column is ambiguous` });
      continue;
    }
    const col = {
      id: names.indexOf('id'),
      severity: names.indexOf('severity'),
      disposition: names.indexOf('disposition'),
      repro: names.findIndex(c => REPRO_NAMES.has(c)),
    };
    // A broken delimiter row no longer discards the table. The rows are
    // still read (the header fixes the columns), the broken delimiter itself is reported as
    // unparsed, and a malformed second findings table can never turn an open HIGH row into silence.
    const sep = live[i + 1] && splitRow(live[i + 1].line);
    let start = i + 2;
    if (!sep || !isSeparator(sep)) {
      unparsed.push({ n: live[i].n, reason: 'the findings table has no delimiter row: the rows are read, the table is not a GFM ledger' });
      start = i + 1;
    } else if (sep.length !== head.length) {
      unparsed.push({ n: live[i + 1].n, reason: `the delimiter row has ${sep.length} cells, the header has ${head.length}: the rows are read, the table is not a GFM ledger` });
    }
    let j = start;
    for (; j < live.length; j++) {
      const cells = splitRow(live[j].line);
      if (!cells) break;
      const n = live[j].n;
      if (cells.length !== head.length) { unparsed.push({ n, reason: `${cells.length} cells, header has ${head.length}` }); continue; }
      const sev = leadToken(cells[col.severity], SEVERITIES);
      const disp = leadToken(cells[col.disposition], DISPOSITIONS);
      if (!sev.token) { unparsed.push({ n, reason: 'severity outside the closed vocabulary' }); continue; }
      if (!disp.token) { unparsed.push({ n, reason: 'disposition outside the closed vocabulary' }); continue; }
      const repro = unemph(cells[col.repro]);
      const annotated = sev.form === 'annotated' || disp.form === 'annotated';
      rows.push({ n, id: unemph(cells[col.id]), severity: sev.token, disposition: disp.token, annotated, reproduced: !EMPTY_REPRO.has(repro.toLowerCase()) });
    }
    i = j - 1;
  }
  // IDs name findings, not occurrences. With a repeated ID the source is ambiguous even when
  // today's values happen to agree; neither occurrence is used as the authoritative finding.
  const byId = new Map();
  for (const row of rows) {
    const key = row.id.normalize('NFC');
    if (!byId.has(key)) byId.set(key, []);
    byId.get(key).push(row);
  }
  const ambiguous = new Set();
  for (const group of byId.values()) if (group.length > 1 || !group[0].id) {
    for (const row of group) {
      ambiguous.add(row);
      unparsed.push({ n: row.n, reason: row.id ? 'duplicate finding ID' : 'empty finding ID' });
    }
  }
  return { ledgers, rows: rows.filter(row => !ambiguous.has(row)), unparsed };
}

function checkText(text) {
  const verdict = readVerdict(text);
  const ledger = readLedgers(text);
  const findings = [];
  const open = ledger.rows.filter(r => OPEN.has(r.disposition));
  const openHigh = open.filter(r => r.severity === 'HIGH');
  if (verdict.status === 'OK') {
    const v = verdict.token;
    if (v === 'PASS' && openHigh.length) findings.push({ rule: 'PASS-WITH-OPEN-HIGH', rows: openHigh });
    if (v === 'RECOMMENDATION' && openHigh.length) findings.push({ rule: 'RECOMMENDATION-WITH-OPEN-HIGH', rows: openHigh });
    // "no open row has a reproduction" is a claim about every row: an unparsed row could hold one
    if (v === 'FAIL' && ledger.ledgers && !ledger.unparsed.length && !open.some(r => r.reproduced)) findings.push({ rule: 'FAIL-WITHOUT-REPRODUCTION', rows: open });
    if ((v === 'FAIL' || v === 'BLOCKED') && openHigh.some(r => !r.reproduced)) findings.push({ rule: 'OPEN-HIGH-WITHOUT-REPRODUCTION', rows: openHigh.filter(r => !r.reproduced) });
    const otherUnreproduced = open.filter(r => r.severity !== 'HIGH' && !r.reproduced);
    if ((v === 'FAIL' || v === 'BLOCKED') && otherUnreproduced.length) findings.push({ rule: 'OPEN-FINDING-WITHOUT-REPRODUCTION', rows: otherUnreproduced });
  }
  const reasons = [];
  if (verdict.status !== 'OK') reasons.push(`verdict ${verdict.status}`);
  if (!ledger.ledgers) reasons.push('no findings ledger');
  if (ledger.unparsed.length) reasons.push(`${ledger.unparsed.length} unparsed row(s)`);
  const status = findings.length ? 'INCONSISTENT' : reasons.length ? 'UNCHECKABLE' : 'CONSISTENT';
  return { status, verdict, ledgers: ledger.ledgers, rows: ledger.rows.length, unparsed: ledger.unparsed, findings, reasons };
}

// The shared descriptor reader owns guards and reading together; a separate check followed by
// readFileSync(name) leaves the checked identity unrelated to the bytes the rules consume.
function readReport(file) {
  const abs = path.resolve(file);
  const guard = pathSafe.readFileGuarded(path.parse(abs).root, abs);
  if (!guard.ok) {
    if (guard.reason === 'link') throw new Error(`a link is refused: ${file}`);
    if (guard.reason === 'not-regular' || guard.reason === 'not-file') throw new Error(`not a regular file: ${file}`);
    throw new Error(`not readable as a real file (${guard.reason}): ${file}`);
  }
  return guard.bytes;
}

function checkFile(file, bytes) {
  const d = textSafe.decode(bytes || readReport(file), { bom: 'strip', crlf: 'normalise', invisible: 'report', finalNewline: 'report' });
  if (!d.ok) throw new Error(`not decodable text (${d.problems.map(p => p.code).join(', ')})`);
  return { file, ...checkText(d.text), textNotes: [...new Set(d.notes.map(note => note.code))] };
}

function format(r) {
  const out = [];
  const label = path.basename(r.file);
  if (r.textNotes && r.textNotes.length) out.push(`NOTE ${label} text=${r.textNotes.join(',')}`);
  for (const f of r.findings) {
    const ids = f.rows.map(x => String(x.n)).join(',') || 'no open row';
    const form = f.rows.some(x => x.annotated) ? ' form=annotated' : '';
    out.push(`INCONSISTENT ${label} ${f.rule} verdict=${r.verdict.token} lines=${ids}${form}`);
  }
  if (r.status === 'UNCHECKABLE') {
    const extra = r.verdict.status === 'NONCANONICAL' ? ` line=${r.verdict.line}` : r.verdict.status === 'AMBIGUOUS' && r.verdict.tokens ? ` tokens=${r.verdict.tokens.join('/')}` : '';
    const rows = r.unparsed.slice(0, 3).map(u => `line ${u.n}: ${u.reason}`).join('; ');
    out.push(`UNCHECKABLE ${label} ${r.reasons.join(', ')}${extra}${rows ? ` (${rows})` : ''}`);
  }
  if (r.status === 'CONSISTENT') out.push(`CONSISTENT ${label} verdict=${r.verdict.token} rows=${r.rows}`);
  return out.map(safeLine);
}

// Every .md name of the directory comes back, whatever its type: one that cannot be read as a
// regular file is an ERROR line at read time, never a silent drop.
function listDir(dir) {
  const abs = path.resolve(dir);
  const guard = pathSafe.realInside(path.parse(abs).root, abs);
  if (!guard.ok) throw new Error(`--dir is not a real directory (${guard.reason}): ${dir}`);
  if (!guard.exists) throw new Error(`--dir does not exist: ${dir}`);
  if (guard.type !== 'dir') throw new Error(`--dir is not a real directory: ${dir}`);
  return fs.readdirSync(guard.real, { withFileTypes: true }).filter(e => e.name.endsWith('.md')).map(e => path.join(dir, e.name)).sort();
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write('usage: verdict-check.cjs FILE... | --dir DIR [--quiet]\n'); return 0; }
  const files = [];
  let quiet = false;
  try {
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--dir') { if (i + 1 >= argv.length) throw new Error('missing value for --dir'); files.push(...listDir(argv[++i])); }
      else if (a === '--quiet') quiet = true;
      else if (a.startsWith('--')) throw new Error(`unknown argument: ${a}`);
      else files.push(a);
    }
    if (!files.length) throw new Error('no report given (paths or --dir)');
  } catch (e) { process.stderr.write(`${safeLine(`ERROR ${e.message}`)}\n`); return 2; }
  const counts = { CONSISTENT: 0, INCONSISTENT: 0, UNCHECKABLE: 0, ERROR: 0 };
  const seen = new Set();
  for (const file of files) {
    let r;
    try {
      const bytes = readReport(file);
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      if (seen.has(digest)) continue;
      seen.add(digest);
      r = checkFile(file, bytes);
    } catch (e) { counts.ERROR++; process.stdout.write(`${safeLine(`ERROR ${path.basename(file)} ${e.message}`)}\n`); continue; }
    counts[r.status]++;
    for (const line of format(r)) if (!quiet || !line.startsWith('CONSISTENT')) process.stdout.write(`${line}\n`);
  }
  process.stdout.write(`VERDICT-CHECK reports=${seen.size} consistent=${counts.CONSISTENT} inconsistent=${counts.INCONSISTENT} uncheckable=${counts.UNCHECKABLE} errors=${counts.ERROR} (advice only)\n`);
  if (counts.INCONSISTENT) return 1;
  return counts.UNCHECKABLE || counts.ERROR ? 2 : 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { VERDICTS, SEVERITIES, DISPOSITIONS, liveLines, readVerdict, readLedgers, splitRow, checkText, readReport, checkFile, format, main };

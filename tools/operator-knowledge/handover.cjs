'use strict';
// handover.cjs - the generated HANDOVER file of the operator (PROTO-DEC-0235 item 4;
// guarantee K7).
//
// The file is made from a FIXED list of repository sources and nothing else (SOURCES below); each is read through
// its existing reader, never a second one:
//   route-state  docs/ops/route-state.json        through summary.cjs load/summary, which reads the record
//                                                  only through route-state.cjs loadRecord and stateAt
//   candidates   <main checkout>/.ai/runtime/CANDIDATES.md   through .ai/bin/lib/candidate-registry.cjs parseRegistry
//   task         .ai/TASK.md
//   decisions    .ai/DECISIONS.md                 the last DECISIONS_TAIL blocks: id, date, status, title
//   ledger       the launch journals of the CYCLE-CONTROL ledger (LAUNCHES.jsonl and the machine-month journals in its
//                records directory) through tools/cycle/ledger.cjs readLaunches, loadPlans, build and jsonReport
// collect and generate open no network connection. The one process they may start is the descriptor query of the
// shared guarded reader (path-safe readFileGuarded through read-handle.cjs, on Windows) that route-state.cjs loadRecord
// uses for the route record; nothing else starts a process (the command line alone also asks git once, through
// .ai/bin/repo-paths.cjs mainRoot, where the main checkout is, to locate the registry). The pure part reads no
// clock: generate(inputs, now) takes the time as an argument (an ISO time of the form 2026-10-21T12:00:00.000Z) and
// states it in the first lines, so the age of the file is visible to every reader. Every input that is older than its
// threshold, or dated after the generation time, is announced with a "STALE INPUT" line; every input that cannot be
// read is announced with an "UNAVAILABLE" line (never a blank section); a date that is not a real calendar date is no
// date. The shared secret scanner (.ai/bin/lib/secrets.cjs) runs over every raw string of every input BEFORE anything
// is clipped, and again over the whole text: a secret-shaped string from any source refuses the whole file
// (SECRET_IN_SOURCE, naming the source, never the value) and nothing is written.
//
// Real paths: every source is read only at its fixed path inside its root (the repository root; the
// registry inside the main checkout root) through owner-rules.cjs readContainedBytes, the shared guard path-safe
// realInside before and after the read. A source behind a link, a junction or another reparse point, or outside its
// root, refuses the WHOLE file (SOURCE_OUTSIDE_ROOT, naming the source) and nothing is written.
//
// Markdown structure: the task and the decisions are read ONLY through the shared
// structural reader md-structure.cjs (the task date from a plain line of the task's own statement; the decision blocks
// from own headings after a blank line, a decision-shaped line anywhere else named in a STALE INPUT line, never read),
// and both are written as QUOTED DATA BLOCKS (an indented block), never as structure of this file. Every other source
// value inside a line of the file (a candidate row, a ledger name) has every Markdown character escaped. The whole text
// is scanned once more with a closed whitelist: a quoted line must be an indented block line, every other line a
// heading, a list item or a paragraph without any other structure (the fixed "Generated at" line may hold its code
// span); any other line refuses the file (STRUCTURE_IN_SOURCE, naming the source).
//
// Times: a time is read in the grammar of the candidate registry (REGISTRY_UPDATED of
// candidate-registry.cjs: a date, or a date and hours and minutes, optional seconds and fraction, an optional zone Z
// or +HH:MM, +HHMM), with a real calendar date and real hours, minutes, seconds and zone; a time without a zone is
// read as UTC (this generator reads no local clock). now itself is an ISO time in UTC as before. A route record
// without a generation time of that grammar is announced as such, never aged from the epoch.
//
//   collect(root, opts)   the only impure part: reads the five sources; never throws for an unreadable source
//   generate(inputs, now) pure: the text of the file, or a Refusal
//   write(root, text)     the shared atomic writer of path-safe.cjs, to docs/ops/HANDOVER.md
//
// Command line: node tools/operator-knowledge/handover.cjs [--print] [--root DIR]
//   (default writes docs/ops/HANDOVER.md; --print writes nothing and prints the text)
// Exit: 0 written or printed, 1 refused (a secret or an unsafe path in a source, or the writer refused).

const fs = require('node:fs');
const path = require('node:path');
const pathSafe = require('../../.ai/bin/lib/path-safe.cjs');
const textSafe = require('../../.ai/bin/lib/text-safe.cjs');
const { secretIn } = require('../../.ai/bin/lib/secrets.cjs');
const registry = require('../../.ai/bin/lib/candidate-registry.cjs');
const ledger = require('../cycle/ledger.cjs');
const sm = require('./summary.cjs');
const md = require('./md-structure.cjs');
const { readContainedBytes } = require('./owner-rules.cjs');

const OUT_REL = 'docs/ops/HANDOVER.md';
const TASK_REL = '.ai/TASK.md';
const DECISIONS_REL = '.ai/DECISIONS.md';
const REGISTRY_REL = '.ai/runtime/CANDIDATES.md';
const ROUTE_RELS = Object.freeze([sm.RECORD_REL, sm.SCHEMA_REL]);
const LAUNCHES_REL = require('../../.ai/bin/repo-paths.cjs').CATALOG_LAUNCHES.join('/');
const PLANS_REL = 'docs/ops/cycle/plans.json';
const JOURNAL_NAME = /^LAUNCHES(?:-[a-z0-9][a-z0-9-]*-\d{6})?\.jsonl$/;
const SOURCES = Object.freeze(['route-state', 'candidates', 'task', 'decisions', 'ledger']);
const DECISIONS_TAIL = 5;
const NOTE_CHARS = 120;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// An input older than its threshold is announced as stale. The thresholds are this generator's, stated in the file.
const STALE = Object.freeze({ routeRecordMs: DAY, candidateRowMs: 3 * DAY, taskMs: 3 * DAY, ledgerMs: 7 * DAY });

class Refusal extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.code = code;
    this.detail = detail;
  }
}

const unavailable = (code, detail) => ({ ok: false, code, detail: sm.clip(detail, 200) });
// A source the shared guard refused: generate refuses the whole file on it.
const unsafeInput = detail => ({ ok: false, unsafe: true, code: 'UNSAFE_PATH', detail: sm.clip(detail, 200) });

function readBytes(root, rel) {
  const read = readContainedBytes(root, rel);
  if (read.ok) return read;
  return read.unsafe ? unsafeInput(read.detail) : unavailable(read.code, read.detail.slice(rel.length + 2) || 'read error');
}

function readText(root, rel) {
  const read = readBytes(root, rel);
  if (!read.ok) return read;
  const decoded = textSafe.decode(read.bytes);
  if (!decoded.ok) return unavailable('BAD_TEXT', decoded.problems.map(p => p.code).join(','));
  return { ok: true, text: decoded.text };
}

// The path below the root is proven by the shared guard; null when it is safe, else the unsafe input.
function guardPath(root, rel, type) {
  const g = pathSafe.realInside(root, path.join(root, ...rel.split('/')), { refuseHardlinks: true });
  if (!g.ok) return unsafeInput(`${rel}: ${g.reason}`);
  if (g.exists && g.type !== type) return unsafeInput(`${rel}: not a ${type === 'dir' ? 'directory' : 'regular file'}`);
  return null;
}

function collectCandidates(registryRoot) {
  if (!registryRoot) return unavailable('NO_REGISTRY_PATH', 'the main checkout root was not given');
  const read = readBytes(registryRoot, REGISTRY_REL);
  if (!read.ok) return read;
  const bytes = read.bytes;
  try {
    const parsed = registry.parseRegistry(bytes);
    const rows = parsed.rows.map(({ cells }) => {
      const [stream, branch, sha, owner, status, updated, note] = cells;
      return { stream, branch, sha, owner, status, updated, note };
    });
    return { ok: true, rows };
  } catch (error) {
    return unavailable(error.code || 'INVALID_REGISTRY', error.reason || error.message || 'refused');
  }
}

// The journals and the plans are read by the ledger's own readers; each path is proven by the shared guard first.
function collectLedger(root) {
  const dir = path.join(root, ...LAUNCHES_REL.split('/'));
  const dirUnsafe = guardPath(root, LAUNCHES_REL, 'dir');
  if (dirUnsafe) return dirUnsafe;
  let names;
  try { names = fs.readdirSync(dir).filter(name => JOURNAL_NAME.test(name)).sort(); } catch (error) { return unavailable('UNREADABLE', `${LAUNCHES_REL}: ${error.code || 'read error'}`); }
  if (!names.length) return unavailable('NO_JOURNAL', `no launch journal in ${LAUNCHES_REL}`);
  for (const rel of [...names.map(name => `${LAUNCHES_REL}/${name}`), PLANS_REL]) {
    const unsafe = guardPath(root, rel, 'file');
    if (unsafe) return unsafe;
  }
  const plans = ledger.loadPlans(path.join(root, ...PLANS_REL.split('/')));
  if (plans.refusal) return unavailable('PLANS_REFUSED', plans.refusal);
  const journals = names.map(name => {
    const launches = ledger.readLaunches(path.join(dir, name));
    if (launches.refusal) return { name, ...unavailable('JOURNAL_REFUSED', launches.refusal) };
    return { name, ok: true, valid: launches.valid, invalid: launches.invalid, records: launches.all.length };
  });
  return { ok: true, plans: plans.plans, journals };
}

// The route record is read by the summary's load; its two paths are proven by the shared guard first.
function collectRoute(root) {
  for (const rel of ROUTE_RELS) {
    const unsafe = guardPath(root, rel, 'file');
    if (unsafe) return unsafe;
  }
  return sm.load(root);
}

// The only impure part. root is the repository root (absolute); opts.registryRoot is the root of the checkout whose
// .ai/runtime/CANDIDATES.md is the candidate registry (the CLI passes the main checkout).
function collect(root, opts = {}) {
  root = path.resolve(root);
  return {
    'route-state': collectRoute(root),
    candidates: collectCandidates(opts.registryRoot ? path.resolve(opts.registryRoot) : null),
    task: readText(root, TASK_REL),
    decisions: readText(root, DECISIONS_REL),
    ledger: collectLedger(root),
  };
}

// now: an ISO time in UTC, 2026-10-21T12:00:00.000Z (milliseconds optional).
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
// A time of the candidate registry's grammar (REGISTRY_UPDATED): its milliseconds, else null. The date must be a real
// calendar date (2026-02-29 is no date), the hours, minutes, seconds and zone real values; no zone is UTC.
const TIME = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
function isoMs(text) {
  const m = typeof text === 'string' ? TIME.exec(text) : null;
  if (!m) return null;
  const [, y, mo, d, h = '0', mi = '0', s = '0', frac = '', zone = 'Z'] = m;
  const day = Date.UTC(Number(y), Number(mo) - 1, Number(d));
  if (!Number.isFinite(day) || new Date(day).toISOString().slice(0, 10) !== `${y}-${mo}-${d}`) return null;
  if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) return null;
  let offset = 0;
  if (zone !== 'Z') {
    const z = /^([+-])(\d{2}):?(\d{2})$/.exec(zone);
    if (Number(z[2]) > 23 || Number(z[3]) > 59) return null;
    offset = (z[1] === '+' ? 1 : -1) * (Number(z[2]) * 60 + Number(z[3])) * 60000;
  }
  return day + ((Number(h) * 60 + Number(mi)) * 60 + Number(s)) * 1000 + Number(frac.slice(0, 3).padEnd(3, '0')) - offset;
}

// One value of a source inside a line of the file: clipped, every Markdown character escaped (md-structure inlineData).
const inline = md.inlineData;

function routeSection(loaded, now, nowMs, stale) {
  const lines = [sm.summary(loaded, now, { cap: Infinity })];
  if (!loaded || loaded.ok !== true) stale.push(`route state: UNAVAILABLE ${(loaded && loaded.code) || 'RECORD_READ_ERROR'}`);
  else {
    const generated = isoMs(loaded.record.generatedAt);
    if (generated === null) {
      lines.push('STALE INPUT: the route record has no generation time of a known form; refresh it before a launch.');
      stale.push('route state: record without a generation time');
    } else if (generated > nowMs) {
      lines.push('STALE INPUT: the route record is dated after the generation time of this file; refresh it before a launch.');
      stale.push('route state: record dated after the generation time');
    } else if (nowMs - generated > STALE.routeRecordMs) {
      const line = `STALE INPUT: the route record was generated ${sm.age(nowMs - generated)} ago (over ${STALE.routeRecordMs / HOUR} h); refresh it before a launch.`;
      lines.push(line);
      stale.push('route state: record older than 24 h');
    }
  }
  return lines.join('\n');
}

function candidatesSection(input, nowMs, stale) {
  if (!input.ok) {
    stale.push(`candidates: UNAVAILABLE ${input.code}`);
    return `UNAVAILABLE ${input.code}: the candidate registry could not be read (${input.detail}).`;
  }
  const live = input.rows.filter(row => registry.ACTIVE_STATUSES.includes(row.status));
  const lines = [`${input.rows.length} rows; live (${registry.ACTIVE_STATUSES.join(', ')}): ${live.length}.`];
  let old = 0;
  let ahead = 0;
  for (const row of live) {
    const updated = isoMs(row.updated);
    const future = updated !== null && updated > nowMs;
    const isStale = updated === null || nowMs - updated > STALE.candidateRowMs;
    if (future) ahead += 1;
    else if (isStale) old += 1;
    const tag = future ? ' FUTURE' : isStale ? ' STALE' : '';
    lines.push(`- ${inline(row.stream, 80)} ${inline(row.status, 20)}${tag}: ${inline(row.branch, 120)}@${inline(row.sha.slice(0, 8), 8)} owner ${inline(row.owner, 80)}, updated ${inline(row.updated, 40)}; ${inline(row.note, NOTE_CHARS)}`);
  }
  if (old) {
    lines.push(`STALE INPUT: ${old} live row(s) not updated for over ${STALE.candidateRowMs / DAY} days.`);
    stale.push(`candidates: ${old} live row(s) older than ${STALE.candidateRowMs / DAY} days`);
  }
  if (ahead) {
    lines.push(`STALE INPUT: ${ahead} live row(s) dated after the generation time of this file.`);
    stale.push(`candidates: ${ahead} live row(s) dated after the generation time`);
  }
  return lines.join('\n');
}

function taskSection(input, nowMs, stale) {
  if (!input.ok) {
    stale.push(`task: UNAVAILABLE ${input.code}`);
    return `UNAVAILABLE ${input.code}: ${TASK_REL} could not be read (${input.detail}).`;
  }
  // Quoted as data: one indented block, read by no one as a heading, a comment, a fence or a line of this file's own
  // metadata. The date comes from the shared reader: a plain line of the task's own statement, exactly one.
  const lines = [`Quoted from ${TASK_REL}:`, '', ...md.quoteBlock(input.text.replace(/\n+$/, '').split('\n'))];
  const read = md.readTaskDate(input.text);
  const day = read.day;
  const updated = day ? isoMs(day) : null;
  if (updated !== null && updated > nowMs) {
    lines.push('', `STALE INPUT: ${TASK_REL} is dated ${day}, after the generation time of this file.`);
    stale.push(`task: last update ${day} after the generation time`);
  } else if (updated === null || nowMs - updated > STALE.taskMs) {
    lines.push('', `STALE INPUT: ${TASK_REL} ${day ? (updated === null ? `has no real date in its "Last update:" line (${day})` : `was last updated ${day}`) : read.reason} (threshold ${STALE.taskMs / DAY} days).`);
    stale.push(`task: ${day ? `last update ${day}` : 'no last update line'}`);
  }
  return lines.join('\n');
}

function decisionsSection(input, stale) {
  if (!input.ok) {
    stale.push(`decisions: UNAVAILABLE ${input.code}`);
    return `UNAVAILABLE ${input.code}: ${DECISIONS_REL} could not be read (${input.detail}).`;
  }
  const { blocks, skipped, duplicates, entities } = md.readDecisions(input.text);
  const lines = [];
  if (entities.length) {
    // A heading or a field line that a character reference could change is not read: no decision is shown.
    const e = entities[0];
    stale.push('decisions: UNAVAILABLE ENTITY_REFUSED');
    return `UNAVAILABLE ENTITY_REFUSED: ${DECISIONS_REL} line ${e.line}: the character reference ${inline(e.form, 40)} in a heading or a field line (a character reference is not read); ${entities.length} such line(s); no decision of the file is shown.`;
  }
  if (duplicates.length) {
    // A block with one field twice has no value of that field: no decision of the file is shown.
    const d = duplicates[0];
    stale.push('decisions: UNAVAILABLE DUPLICATE_FIELD');
    return `UNAVAILABLE DUPLICATE_FIELD: ${DECISIONS_REL} line ${d.line}: the field ${d.field} of ${d.id} appears a second time (first at line ${d.first}); ${duplicates.length} duplicate field line(s); no decision of the file is shown.`;
  }
  if (!blocks.length) {
    stale.push('decisions: no decision block');
    lines.push(`UNAVAILABLE NO_DECISION_BLOCK: ${DECISIONS_REL} was read but holds no decision block of the form "### DEC-nnnn" or "### PROTO-DEC-nnnn".`);
  } else {
    const tail = blocks.slice(-DECISIONS_TAIL);
    // Quoted as data: one indented block; the id, date, status and title are shown as text, never as structure.
    lines.push(`${blocks.length} decision blocks; the last ${tail.length}, quoted from ${DECISIONS_REL}:`, '',
      ...md.quoteBlock(tail.map(b => `${b.id} (${sm.clip(b.date, 40)}, ${sm.clip(b.status, 60)}): ${sm.clip(b.title, 240)}`)));
  }
  if (skipped.length) {
    const at = skipped.slice(0, 10).join(', ');
    lines.push('', `STALE INPUT: ${skipped.length} decision-shaped line(s) of ${DECISIONS_REL} inside Markdown structure or not after a blank line were not read as decisions (line ${at}${skipped.length > 10 ? ', ...' : ''}).`);
    stale.push(`decisions: ${skipped.length} decision-shaped line(s) not read`);
  }
  return lines.join('\n');
}

function ledgerSection(input, now, nowMs, stale) {
  if (!input.ok) {
    stale.push(`ledger: UNAVAILABLE ${input.code}`);
    return `UNAVAILABLE ${input.code}: the launch ledger could not be read (${input.detail}).`;
  }
  const lines = [];
  for (const j of input.journals) {
    if (!j.ok) {
      lines.push(`- ${j.name}: UNAVAILABLE ${j.code} (${j.detail})`);
      stale.push(`ledger: ${j.name} UNAVAILABLE`);
      continue;
    }
    const ctx = { generated: now, since: null, scope: 'all valid launches in the journal', records: j.records, launches: j.valid.length, invalid: j.invalid, inputs: [], outputDirs: [] };
    const report = ledger.jsonReport(ledger.build(j.valid, input.plans, ctx), ctx);
    const days = report.days.map(d => d.day).filter(Boolean).sort();
    const newest = days.length ? days[days.length - 1] : null;
    const clients = report.clients.map(c => `${c.client} ${c.launches} (verdict ${c.verdict}, no verdict ${c.no_verdict}, not ended ${c.not_ended})`).join('; ');
    const newestMs = newest ? isoMs(newest) : null;
    const future = newestMs !== null && newestMs > nowMs;
    const isStale = future || newestMs === null || nowMs - newestMs > STALE.ledgerMs;
    lines.push(`- ${j.name}: ${report.records} records, ${report.launches} valid launches, ${report.invalid.count} invalid; newest day ${newest ? inline(newest, 40) : 'none'}${future ? ' FUTURE' : isStale ? ' STALE' : ''}. ${clients ? inline(clients, 2000) : 'no client'}.`);
    if (isStale) stale.push(`ledger: ${j.name} newest day ${newest ? inline(newest, 40) : 'none'}${future ? ' after the generation time' : ''}`);
  }
  return lines.join('\n');
}

// Every string inside an input (object keys included), as collected, before any clip.
function rawStrings(value, out = [], depth = 0) {
  if (depth > 64) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) for (const item of value) rawStrings(item, out, depth + 1);
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) { out.push(k); rawStrings(v, out, depth + 1); }
  }
  return out;
}

// Pure: the same (inputs, now) always gives the same text. A secret in any section refuses the whole file.
function generate(inputs, now) {
  const nowMs = typeof now === 'string' && ISO_TIME.test(now) ? isoMs(now) : null;
  if (nowMs === null) throw new Refusal('BAD_TIME', 'now must be an ISO time of the form 2026-10-21T12:00:00.000Z');
  for (const name of SOURCES) if (!inputs || !Object.hasOwn(inputs, name)) throw new Refusal('MISSING_INPUT', `the input ${name} was not collected`);
  for (const name of Object.keys(inputs)) if (!SOURCES.includes(name)) throw new Refusal('UNKNOWN_INPUT', `the input ${sm.clip(name, 40)} is not one of the fixed sources`);
  for (const name of SOURCES) {
    const input = inputs[name];
    if (input && input.unsafe === true) throw new Refusal('SOURCE_OUTSIDE_ROOT', `the ${name} source is not a plain file at its fixed path inside its root (${sm.clip(input.detail, 120)}); nothing was written`);
  }
  // The raw scan: a secret cut in half by a clip below must still refuse.
  for (const name of SOURCES) {
    if (rawStrings(inputs[name]).some(text => secretIn(text))) throw new Refusal('SECRET_IN_SOURCE', `a secret-shaped string in the ${name} source; nothing was written`);
  }
  const stale = [];
  const sections = [
    ['Route state', 'route-state', routeSection(inputs['route-state'], now, nowMs, stale)],
    ['Candidates', 'candidates', candidatesSection(inputs.candidates, nowMs, stale)],
    ['Task', 'task', taskSection(inputs.task, nowMs, stale)],
    ['Decisions (tail)', 'decisions', decisionsSection(inputs.decisions, stale)],
    ['Launch ledger', 'ledger', ledgerSection(inputs.ledger, now, nowMs, stale)],
  ];
  const head = [
    '# HANDOVER (generated)',
    '',
    `Generated at ${new Date(nowMs).toISOString()} by \`node tools/operator-knowledge/handover.cjs\` (OPERATOR-KNOWLEDGE K7, PROTO-DEC-0235 item 4).`,
    'Never edit by hand: run the generator again. Every line below is as old as this time or as its own source line says.',
    `Sources, fixed: ${SOURCES.join(', ')}. Stale thresholds: route record ${STALE.routeRecordMs / HOUR} h, live candidate row ${STALE.candidateRowMs / DAY} days, task ${STALE.taskMs / DAY} days, ledger ${STALE.ledgerMs / DAY} days.`,
    stale.length ? `STALE OR UNAVAILABLE INPUTS (${stale.length}): ${stale.join('; ')}.` : 'Stale or unavailable inputs: none.',
    'The duties of the operator: docs/ops/OPERATOR-DUTIES.md; the owner rules: .ai/core/L1-meta/P-L1-003-owner-rules.md.',
  ];
  const text = `${[...head, ...sections.flatMap(([title, , body]) => ['', `## ${title}`, '', body])].join('\n')}\n`;
  // One scan over the whole text; the refusal names the source of the first section that holds the match, never the value.
  if (secretIn(text)) {
    const hit = sections.find(([, , body]) => secretIn(body));
    throw new Refusal('SECRET_IN_SOURCE', `a secret-shaped string in the ${hit ? hit[1] : 'header'} source; nothing was written`);
  }
  // The closed structure check over the whole file (shared scanner, whitelist): a quoted line of the task or the
  // decisions is an indented block line and nothing else; every other line is a heading, a list item or a paragraph
  // with no other structure; the fixed "Generated at" line (head line 3) may hold its code span.
  const kinds = md.lineKinds(text);
  const lines = text.split('\n');
  const quotedFrom = lines.indexOf('## Task');
  const quotedTo = lines.indexOf('## Launch ledger');
  const fits = (line, i) => {
    const k = kinds[i];
    if (/^[ \t]*$/.test(line)) return true;
    if (i > quotedFrom && i < quotedTo && line.startsWith(md.QUOTE)) return k.length === 1 && k[0] === 'indented-code';
    if (i === 2) return k.every(kind => kind === 'code-span');
    return k.every(kind => kind === 'heading' || kind === 'list-item');
  };
  const hidden = lines.findIndex((line, i) => !fits(line, i));
  if (hidden >= 0) {
    const section = [...lines.slice(0, hidden + 1)].reverse().find(line => line.startsWith('## '));
    const hit = sections.find(([title]) => `## ${title}` === section);
    throw new Refusal('STRUCTURE_IN_SOURCE', `line ${hidden + 1} of the file would carry Markdown structure from the ${hit ? hit[1] : 'header'} source; nothing was written`);
  }
  return text;
}

function write(root, text) {
  const written = pathSafe.writeAtomicGuarded(path.join(root, ...OUT_REL.split('/')), Buffer.from(text, 'utf8'), { root });
  if (!written.ok) throw new Refusal('WRITE_REFUSED', `${written.reason}: ${written.detail}`);
  return OUT_REL;
}

module.exports = { OUT_REL, SOURCES, STALE, DECISIONS_TAIL, JOURNAL_NAME, Refusal, collect, generate, write, isoMs };

if (require.main === module && (process.argv.includes('--help') || process.argv.includes('-h'))) {
  process.stdout.write('usage: handover.cjs [--print] [--root DIR]\n');
} else if (require.main === module) {
  const args = process.argv.slice(2);
  const print = args[0] === '--print';
  const rest = print ? args.slice(1) : args;
  if (!(rest.length === 0 || (rest.length === 2 && rest[0] === '--root'))) { process.stderr.write('usage: handover.cjs [--print] [--root DIR]\n'); process.exit(2); }
  const root = rest.length ? path.resolve(rest[1]) : path.join(__dirname, '..', '..');
  const repoPaths = require('../../.ai/bin/repo-paths.cjs');
  const registryRoot = repoPaths.mainRoot(root);
  try {
    const text = generate(collect(root, { registryRoot }), new Date().toISOString());
    if (print) process.stdout.write(text);
    else process.stdout.write(`HANDOVER written ${write(root, text)} bytes=${Buffer.byteLength(text, 'utf8')}\n`);
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    process.stdout.write(`HANDOVER REFUSED ${error.code}: ${error.detail}\n`);
    process.exitCode = 1;
  }
}

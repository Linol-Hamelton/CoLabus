'use strict';
// launch-journal-sync.cjs - copies the validated launch records of the untracked pending buffer into a TRACKED per machine journal
// (PROTO-DEC-0174 item 2: one machine writes its own files, text records belong in Git). Class B tooling, advisory.
//   node .ai/bin/accounting/launch-journal-sync.cjs [plan] [--pending DIR] [--launches DIR] [--machine ID] [--json]
//   node .ai/bin/accounting/launch-journal-sync.cjs --execute --plan-hash HASH [--pending DIR] [--launches DIR] [--machine ID]
// plan (the default) writes nothing and prints what would happen and the plan hash; --execute recomputes the plan from the current files and refuses
// (exit 1, nothing written) unless it hashes to --plan-hash, so only a plan somebody looked at is executed.
// Targets: <launches>/LAUNCHES-<machine>-<YYYYMM>.jsonl (month of startedAt, UTC) and the ledger <launches>/LAUNCH-SYNC-LEDGER-<machine>.jsonl.
// <machine> is OPS_MACHINE_ID or the host name, reduced to a-z 0-9 _ - (at most 32 characters). Defaults: pending = the pending buffer of the MAIN
// checkout (.ai/bin/repo-paths.cjs, env OPS_LAUNCH_PENDING_DIR), launches = the launches folder of this checkout.
// Rules: a record goes in only when it passes launch-record-validate.cjs (shape, enumerations, secret scan) and the secret scan of its own line;
// anything else is skipped and LISTED (file, line, reason), never repaired. A launchId already in any LAUNCHES*.jsonl of the launches folder is not copied
// again (a different line under the same launchId is a conflict and is listed, never overwritten). Existing lines are never rewritten: a journal is read,
// the new lines are appended under an exclusive transaction lock via the shared guarded writer; old content remains an exact prefix. Every copied line gets
// a ledger line {launchId, key, sourceFile, sourceLine, sha256, journal, syncedAt, planHash}; the journals are written first and the ledger last, so an execute
// that stops in between leaves journal lines without a ledger line: the next plan lists them and its execute adds exactly those ledger lines (`repaired: true`,
// Guard), never a second one. The pending files are only READ: this tool never deletes,
// edits or renames them (the pending buffer is the machine's own state; whoever retires it does that apart, after the journal is committed).
// Guard (review finding: pending given as the journal folder, the source buffer changed while the tool said "not touched"): before ANY write, and in plan
// mode too, a run is refused (code PATHS-OVERLAP, exit 3) when the pending folder and the journal folder are the same real path, or one lies inside the other,
// or a journal or the ledger file resolves into the pending folder, or a pending file resolves into the journal folder. Paths are compared as real paths
// (links and junctions resolved; on Windows without regard to case). So a run inside the main checkout, whose pending buffer is launches/pending, is refused:
// run it from a worktree (its launches folder) against the main checkout's pending buffer. The "not touched" claim is a verified fact: --execute hashes every
// file under the pending folder before and after, and a changed, added or removed file fails the run (code PENDING-CHANGED, exit 4).
// Exit: 0 plan or done; 1 --execute refused (plan hash differs); 2 usage or unusable input; 3 PATHS-OVERLAP (nothing written); 4 PENDING-CHANGED.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const validator = require('./launch-record-validate.cjs');
const textSafe = require('../lib/text-safe.cjs');
const pathSafe = require('../lib/path-safe.cjs');
const { withJournalLock } = require('./lib/journal-lock.cjs');

const LAUNCHES = path.resolve(__dirname, '..', '..', '..', 'docs', 'product', 'launch-records', 'launches');
const SCHEMA = 'launch-journal-sync-plan/1';
const LEDGER_SCHEMA = 'launch-sync-ledger/1';

const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).filter(k => value[k] !== undefined).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  return JSON.stringify(value);
}
const usage = msg => { process.stdout.write(`ERROR ${msg}\n`); return 2; };

// The machine id: OPS_MACHINE_ID, else the host name; reduced to safe characters. Null when nothing safe is left.
function machineId(raw) {
  const safe = String(raw === undefined || raw === null ? '' : raw).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 32).replace(/[-_]+$/, '');
  return safe || null;
}
function defaultPending() {
  try {
    const rp = require(path.resolve(__dirname, '..', 'repo-paths.cjs'));
    return rp.pendingDir();
  } catch { return path.join(LAUNCHES, 'pending'); }
}
const monthOf = rec => {
  const t = Date.parse(rec.startedAt || rec.endedAt || '');
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 7).replace('-', '');
};
const keyOf = (rec, lineSha) => (validator.kindOf(rec) === 'full' || validator.kindOf(rec) === 'started' ? `start:${rec.launchId}` : `${validator.kindOf(rec)}:${rec.launchId}:${lineSha}`);

function listJsonl(dir) {
  try { return fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort(); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
// Explicit UTF-8 policy: pending refuses BOM; historical journals accept BOM/CRLF.
function decoded(file, bom, textNotes) {
  const d = textSafe.decode(fs.readFileSync(file), { bom, crlf: 'normalise', invisible: 'refuse' });
  if (!d.ok) throw new Error('text refused: ' + d.problems.map(p => p.code).join(','));
  for (const n of d.notes) textNotes.push({ file: path.basename(file), code: n.code });
  return d.text;
}
function readLines(file, textNotes) {
  return decoded(file, 'refuse', textNotes).split('\n').map((text, i) => ({ line: i + 1, text })).filter(x => x.text.trim() !== '');
}
function readTolerant(file, tornTails, textNotes) {
  const raw = fs.readFileSync(file);
  let d = textSafe.decode(raw, { bom: 'strip', crlf: 'normalise', invisible: 'refuse' });
  // An incomplete UTF-8 sequence may belong to a torn last line. Completed bytes remain readable.
  if (!d.ok && !raw.subarray(-1).equals(Buffer.from('\n')) && d.problems.some(p => p.code === 'INVALID_UTF8')) {
    const lastLF = raw.lastIndexOf(10);
    const prefix = raw.subarray(0, lastLF + 1);
    d = textSafe.decode(prefix, { bom: 'strip', crlf: 'normalise', invisible: 'refuse' });
    if (d.ok) tornTails.push({ file: path.basename(file), line: prefix.toString('utf8').split('\n').length });
  }
  if (!d.ok) throw new Error('text refused: ' + d.problems.map(p => p.code).join(','));
  for (const n of d.notes) textNotes.push({ file: path.basename(file), code: n.code });
  const rows = d.text.split('\n').map((text, i) => ({ line: i + 1, text }));
  const last = rows.at(-1);
  if (last.text.trim() && !d.text.endsWith('\n')) {
    try { JSON.parse(last.text); } catch {
      tornTails.push({ file: path.basename(file), line: last.line }); rows.pop();
    }
  }
  return rows.filter(x => x.text.trim() !== '');
}
const eolOf = text => { const i = text.indexOf('\n'); return i > 0 && text[i - 1] === '\r' ? '\r\n' : '\n'; };
function appendInStyle(before, lines) {
  const eol = eolOf(before);
  const base = before === '' || before.endsWith('\n') ? before : before + eol;
  return base + lines.map(l => l + eol).join('');
}
function guardedFile(root, file) {
  const guardRoot = fs.existsSync(root) ? root : path.parse(root).root;
  const g = pathSafe.realInside(guardRoot, file, { refuseHardlinks: true });
  if (!g.ok) throw Object.assign(new Error('file path refused: ' + g.reason), { code: 'UNSAFE-PATH' });
  return g.real;
}
// Every launchId (and exact line hash) the launches folder already holds in any LAUNCHES*.jsonl, with the file it is in. The lines of THIS machine's own
// journals (LAUNCHES-<machine>-<YYYYMM>.jsonl, the files this tool writes) are listed apart: each of them must have its ledger line.
// Guard: a journal that cannot be read, or holds a line that is not JSON, stops the plan (before: skipped, so its launchIds were copied again).
function existingIndex(launchesDir, machine, tornTails = [], textNotes = []) {
  const ids = new Map(); const files = new Map(); const own = [];
  const ownName = new RegExp(`^LAUNCHES-${machine}-\\d{6}\\.jsonl$`);
  for (const name of listJsonl(launchesDir).filter(n => /^LAUNCHES.*\.jsonl$/.test(n))) {
    const full = guardedFile(launchesDir, path.join(launchesDir, name));
    let lines = [];
    try { lines = readTolerant(full, tornTails, textNotes); } catch (e) { throw new Error(`the journal ${name} cannot be read (${e.code || e.message}); nothing is planned`); }
    files.set(name, sha256(fs.readFileSync(full)));
    for (const { line, text } of lines) {
      let rec; try { rec = JSON.parse(text); } catch { throw new Error(`the journal ${name} line ${line} is not JSON; nothing is planned (repair the journal by hand: the tool never guesses which launch it held)`); }
      if (!rec || typeof rec !== 'object' || !rec.launchId) continue;
      const key = keyOf(rec, sha256(text));
      if (ids.has(key) && ids.get(key).sha !== sha256(text)) throw Object.assign(new Error('journal lines disagree for one record key; nothing is planned'), { code: 'AMBIGUOUS-JOURNAL' });
      ids.set(key, { journal: name, sha: sha256(text) });
      if (ownName.test(name)) own.push({ journal: name, journalLine: line, launchId: rec.launchId, key, sha256: sha256(text) });
    }
  }
  return { ids, files, own };
}
// The (key, line hash) pairs the ledger already holds. A ledger that cannot be read (a directory, a broken disk) stops the plan: the tool never guesses.
function ledgerIndex(ledgerFile, tornTails = [], textNotes = []) {
  const have = new Set();
  if (!fs.existsSync(ledgerFile)) return have;
  for (const { text } of readTolerant(ledgerFile, tornTails, textNotes)) {
    let row; try { row = JSON.parse(text); } catch { throw new Error('the ledger has a completed non-JSON line; nothing is planned'); }
    if (row && typeof row.key === 'string' && typeof row.sha256 === 'string') have.add(`${row.key}\t${row.sha256}`);
  }
  return have;
}

// Path identity and nesting are decided by the shared real-path guard, fail closed.
const overlap = message => Object.assign(new Error(message), { code: 'PATHS-OVERLAP' });
function assertSeparated(pendingDir, launchesDir, targetNames = [], pendingFiles = []) {
  if (pathSafe.sameFileOrNested(pendingDir, launchesDir)) throw overlap('the pending folder and journal folder are the same real path or nested');
  for (const dir of [pendingDir, launchesDir]) {
    const guard = pathSafe.realInside(path.parse(dir).root, dir, { allowRoot: true });
    if (!guard.ok) throw Object.assign(new Error('directory path refused: ' + guard.reason), { code: 'UNSAFE-PATH' });
  }
  for (const name of targetNames) {
    const target = path.join(launchesDir, name);
    if (pathSafe.sameFileOrNested(target, pendingDir)) throw overlap(name + ' resolves into the pending folder');
    guardedFile(launchesDir, target);
  }
  for (const file of pendingFiles) {
    if (pathSafe.sameFileOrNested(file, launchesDir)) throw overlap('pending file ' + path.basename(file) + ' resolves into the journal folder');
    guardedFile(pendingDir, file);
  }
}
// sha256 of every file under the pending folder (relative path -> hash); the evidence of "the pending files were not touched".
function hashTree(dir) {
  const out = new Map();
  const walk = (d, rel) => {
    let ents = []; try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else { try { out.set(r, sha256(fs.readFileSync(path.join(d, e.name)))); } catch (err) { out.set(r, `unreadable:${err.code || 'error'}`); } }
    }
  };
  walk(dir, '');
  return out;
}
function treeChanges(before, after) {
  const changed = [];
  for (const [k, v] of before) if (!after.has(k)) changed.push(`${k} removed`); else if (after.get(k) !== v) changed.push(`${k} changed`);
  for (const k of after.keys()) if (!before.has(k)) changed.push(`${k} added`);
  return changed;
}

function buildPlan(opts) {
  const pendingDir = path.resolve(opts.pending); const launchesDir = path.resolve(opts.launches);
  const machine = machineId(opts.machine);
  if (!machine) throw new Error('the machine id has no safe character left (set OPS_MACHINE_ID to letters, digits, dash or underscore)');
  if (!fs.existsSync(pendingDir) || !fs.statSync(pendingDir).isDirectory()) throw new Error('pending directory unavailable');
  assertSeparated(pendingDir, launchesDir, [], [], opts.pathDeps);
  const tornTails = [], textNotes = [];
  const existing = existingIndex(launchesDir, machine, tornTails, textNotes);
  const ledgerName = `LAUNCH-SYNC-LEDGER-${machine}.jsonl`;
  const ledgerFile = guardedFile(launchesDir, path.join(launchesDir, ledgerName));
  const ledgered = ledgerIndex(ledgerFile, tornTails, textNotes);
  const plan = { schema: SCHEMA, machine, tornTails, textNotes, sources: [], totals: { files: 0, bytes: 0, records: 0, valid: 0, skipped: 0, duplicates: 0, conflicts: 0, toAppend: 0, appendBytes: 0, ledgerRepairs: 0 }, entries: [], skipped: [], duplicates: [], conflicts: [], targets: {}, ledgerRepairs: [] };
  const seen = new Map();
  const pendingSource = new Map(); // key + line hash -> the first pending line that holds it (the source of a repaired ledger line)
  for (const name of listJsonl(pendingDir)) {
    const file = guardedFile(pendingDir, path.join(pendingDir, name));
    const bytes = fs.statSync(file).size;
    plan.totals.files++; plan.totals.bytes += bytes;
    let lines;
    try { lines = readLines(file, textNotes); } catch (e) { plan.skipped.push({ sourceFile: name, line: 0, reason: `file unreadable: ${e.message}` }); plan.totals.skipped++; plan.sources.push({ file: name, bytes, lines: 0, sha256: sha256(fs.readFileSync(file)) }); continue; }
    plan.sources.push({ file: name, bytes, lines: lines.length, sha256: sha256(fs.readFileSync(file)) });
    for (const { line, text } of lines) {
      plan.totals.records++;
      let rec;
      try { rec = JSON.parse(text); } catch (e) { plan.skipped.push({ sourceFile: name, line, reason: `invalid JSON: ${e.message}` }); plan.totals.skipped++; continue; }
      const problems = validator.validateRecord(rec);
      if (!problems.length && validator.secretIn(text)) problems.push('a secret-shaped string was found in the line');
      if (problems.length) { plan.skipped.push({ sourceFile: name, line, launchId: rec && rec.launchId, reason: problems.slice(0, 3).join('; ') + (problems.length > 3 ? ` (+${problems.length - 3} more)` : '') }); plan.totals.skipped++; continue; }
      plan.totals.valid++;
      const lineSha = sha256(text);
      const key = keyOf(rec, lineSha);
      const month = monthOf(rec);
      if (!month) { plan.skipped.push({ sourceFile: name, line, launchId: rec.launchId, reason: 'no usable startedAt or endedAt for the month file' }); plan.totals.skipped++; plan.totals.valid--; continue; }
      if (!pendingSource.has(`${key}\t${lineSha}`)) pendingSource.set(`${key}\t${lineSha}`, { sourceFile: name, sourceLine: line });
      const have = existing.ids.get(key);
      if (have) {
        const start = validator.kindOf(rec) === 'full' || validator.kindOf(rec) === 'started';
        if (start && have.sha !== lineSha) { plan.conflicts.push({ launchId: rec.launchId, in: have.journal, sourceFile: name, line, reason: 'the launchId is already in a journal with different content; the journal line is kept' }); plan.totals.conflicts++; }
        else { plan.duplicates.push({ launchId: rec.launchId, in: have.journal, sourceFile: name, line }); plan.totals.duplicates++; }
        continue;
      }
      const prev = seen.get(key);
      if (prev) {
        if (prev.sha === lineSha) { plan.duplicates.push({ launchId: rec.launchId, in: 'this plan', sourceFile: name, line }); plan.totals.duplicates++; }
        else { plan.conflicts.push({ launchId: rec.launchId, in: 'this plan', sourceFile: name, line, reason: 'the same launchId twice in the pending buffer with different content; the first one is kept' }); plan.totals.conflicts++; }
        continue;
      }
      seen.set(key, { sha: lineSha });
      const journal = `LAUNCHES-${machine}-${month}.jsonl`;
      plan.entries.push({ journal, launchId: rec.launchId, key, sha256: lineSha, sourceFile: name, sourceLine: line, text, ledgered: ledgered.has(`${key}\t${lineSha}`) });
      plan.totals.toAppend++; plan.totals.appendBytes += Buffer.byteLength(text) + 1;
    }
  }
  for (const e of plan.entries) {
    const t = plan.targets[e.journal] || (plan.targets[e.journal] = { appends: 0, currentSha256: existing.files.get(e.journal) || null });
    t.appends++;
  }
  // Ledger repair (Guard): a line of this machine's journals without its ledger line was copied by an execute that stopped before the ledger was written
  // (the journal is written first). The retry adds exactly the missing ledger lines, once; the source is the pending line that holds the same record, or null
  // when the pending buffer no longer has it. Journals and pending files are not touched by a repair.
  const repaired = new Set();
  for (const o of existing.own) {
    const id = `${o.key}\t${o.sha256}`;
    if (ledgered.has(id) || repaired.has(id)) continue;
    repaired.add(id);
    const src = pendingSource.get(id) || { sourceFile: null, sourceLine: null };
    plan.ledgerRepairs.push({ journal: o.journal, journalLine: o.journalLine, launchId: o.launchId, key: o.key, sha256: o.sha256, sourceFile: src.sourceFile, sourceLine: src.sourceLine });
  }
  plan.totals.ledgerRepairs = plan.ledgerRepairs.length;
  plan.ledger = { file: ledgerName, currentSha256: fs.existsSync(ledgerFile) ? sha256(fs.readFileSync(ledgerFile)) : null };
  // every file this run may write, and every pending file it reads, must stay on its own side (links included)
  assertSeparated(pendingDir, launchesDir, [...Object.keys(plan.targets), ledgerName], listJsonl(pendingDir).map(n => path.join(pendingDir, n)), opts.pathDeps);
  // The hash covers what the plan would do and the state it would do it on (source digests, journal digests), never a path or a time.
  const hashed = { ...plan, entries: plan.entries.map(({ text, ...rest }) => rest) };
  plan.planHash = sha256(canonicalJson(hashed));
  return plan;
}

function execute(plan, opts, now) {
  const root = path.resolve(opts.launches);
  assertSeparated(path.resolve(opts.pending), root);
  fs.mkdirSync(root, { recursive: true });
  return withJournalLock(root, () => {
    const current = buildPlan(opts);
    if (current.planHash !== plan.planHash) throw Object.assign(new Error('journal or pending changed; retry with a fresh plan'), { code: 'STALE-PLAN' });
    if (current.tornTails.length) throw Object.assign(new Error('torn last line; preserve and repair the tail explicitly before executing'), { code: 'TORN-TAIL' });
    return executeLocked(current, opts, now);
  });
}
function writeJournal(file, text, root) {
  const result = pathSafe.writeAtomicGuarded(file, Buffer.from(text), { root });
  if (!result.ok) throw Object.assign(new Error('journal write refused: ' + result.reason), { code: 'JOURNAL-WRITE' });
}
function executeLocked(plan, opts, now) {
  const launchesDir = path.resolve(opts.launches);
  fs.mkdirSync(launchesDir, { recursive: true });
  const byJournal = new Map();
  for (const e of plan.entries) { if (!byJournal.has(e.journal)) byJournal.set(e.journal, []); byJournal.get(e.journal).push(e); }
  const syncedAt = now.toISOString();
  const ledgerLines = [];
  for (const [name, entries] of byJournal) {
    const file = path.join(launchesDir, name);
    const before = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    const next = appendInStyle(before, entries.map(e => e.text));
    writeJournal(file, next, launchesDir);
    const after = fs.readFileSync(file, 'utf8');
    if (!after.startsWith(before) || after.length !== next.length) throw new Error(`${name}: the written journal does not start with its previous content; stopping`);
    for (const e of entries) if (!e.ledgered) ledgerLines.push(JSON.stringify({ schema: LEDGER_SCHEMA, launchId: e.launchId, key: e.key, sourceFile: e.sourceFile, sourceLine: e.sourceLine, sha256: e.sha256, journal: name, syncedAt, planHash: plan.planHash }));
  }
  // the missing ledger lines of an earlier execute that stopped after its journal write go into the same single atomic ledger write
  const repairs = plan.ledgerRepairs || [];
  for (const r of repairs) ledgerLines.push(JSON.stringify({ schema: LEDGER_SCHEMA, launchId: r.launchId, key: r.key, sourceFile: r.sourceFile, sourceLine: r.sourceLine, sha256: r.sha256, journal: r.journal, syncedAt, planHash: plan.planHash, repaired: true }));
  if (ledgerLines.length) {
    const ledgerFile = path.join(launchesDir, plan.ledger.file);
    const before = fs.existsSync(ledgerFile) ? fs.readFileSync(ledgerFile, 'utf8') : '';
    writeJournal(ledgerFile, appendInStyle(before, ledgerLines), launchesDir);
  }
  return { journals: [...byJournal.keys()], appended: plan.entries.length, ledgerLines: ledgerLines.length, ledgerRepaired: repairs.length };
}

function parseArgs(argv) {
  const o = { execute: false };
  const rest = argv[0] === 'plan' ? argv.slice(1) : argv;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]; const next = () => rest[++i];
    if (a === '--execute') o.execute = true;
    else if (a === '--plan-hash') o.planHash = next();
    else if (a === '--pending') o.pending = next();
    else if (a === '--launches') o.launches = next();
    else if (a === '--machine') o.machine = next();
    else if (a === '--json') o.json = true;
    else if (a === '--now') o.now = next();
    else return { error: `unknown argument ${a}` };
  }
  return o;
}

function main(argv, deps = {}) {
  const o = parseArgs(argv);
  if (o.error) return usage(o.error);
  if (o.execute && !o.planHash) return usage('--execute needs --plan-hash <hash of the plan that was looked at>');
  if (!o.execute && o.planHash) return usage('--plan-hash is only used with --execute');
  if (o.now && Number.isNaN(Date.parse(o.now))) return usage('--now must be an ISO time');
  const env = deps.env || process.env;
  const opts = { pending: o.pending || defaultPending(), launches: o.launches || LAUNCHES, machine: o.machine !== undefined ? o.machine : (env.OPS_MACHINE_ID || os.hostname()) };
  let plan;
  try { plan = buildPlan(opts); } catch (e) {
    if (e.code === 'PATHS-OVERLAP') { (deps.stdout || process.stdout).write(`REFUSED PATHS-OVERLAP ${e.message}. Nothing was written.\n`); return 3; }
    return usage(e.message);
  }
  const t = plan.totals;
  const out = deps.stdout || process.stdout;
  if (!o.execute) {
    if (o.json) { out.write(`${JSON.stringify({ ...plan, entries: plan.entries.map(({ text, ...rest }) => rest) }, null, 2)}\n`); return 0; }
    const lines = [
      `launch-journal-sync PLAN (nothing is written) machine=${plan.machine}`,
      `pending files=${t.files} bytes=${t.bytes}; records=${t.records} valid=${t.valid} skipped=${t.skipped} duplicates=${t.duplicates} conflicts=${t.conflicts}`,
      `to append: ${t.toAppend} records, ${t.appendBytes} bytes, into ${Object.keys(plan.targets).length} journal file(s): ${Object.entries(plan.targets).map(([n, x]) => `${n} (+${x.appends})`).join(', ') || '-'}`,
      `ledger: ${plan.ledger.file}; ledger lines to repair: ${t.ledgerRepairs} (journal lines of this machine without their ledger line)`,
    ];
    for (const tail of plan.tornTails) lines.push('TORN-TAIL ' + tail.file + ':' + tail.line + ' (execute refuses; bytes preserved)');
    for (const note of plan.textNotes) lines.push('TEXT-NOTE ' + note.file + ' ' + note.code);
    const reasons = new Map();
    for (const s of plan.skipped) { const k = s.reason.replace(/^field "([^"]+)".*/, 'field "$1" invalid').replace(/^unknown field.*/, 'unknown field').replace(/^launchId has \d+ start records.*/, 'launchId repeated').slice(0, 90); reasons.set(k, (reasons.get(k) || 0) + 1); }
    for (const [k, n] of [...reasons].sort((a, b) => b[1] - a[1])) lines.push(`  skipped x${n}: ${k}`);
    for (const s of plan.skipped.slice(0, 20)) lines.push(`  SKIP ${s.sourceFile}:${s.line}${s.launchId ? ` ${s.launchId}` : ''} ${s.reason}`);
    if (plan.skipped.length > 20) lines.push(`  ... ${plan.skipped.length - 20} more skipped (use --json for the full list)`);
    for (const c of plan.conflicts.slice(0, 10)) lines.push(`  CONFLICT ${c.sourceFile}:${c.line} ${c.launchId} ${c.reason}`);
    lines.push(`plan hash: ${plan.planHash}`, `To execute after looking at it: node .ai/bin/accounting/launch-journal-sync.cjs --execute --plan-hash ${plan.planHash}`);
    out.write(`${lines.join('\n')}\n`);
    return 0;
  }
  if (String(o.planHash).toLowerCase() !== plan.planHash) {
    out.write(`REFUSED the plan hash ${o.planHash} does not match the current plan ${plan.planHash} (the pending buffer or a journal changed, or another plan was looked at). Nothing was written.\n`);
    return 1;
  }
  // "not touched" is measured: every pending file is hashed before and after the writes (also when the execute fails half way)
  const pendingDir = path.resolve(opts.pending);
  const before = hashTree(pendingDir);
  let done = null; let failure = null;
  try { done = (deps.execute || execute)(plan, opts, o.now ? new Date(o.now) : (deps.now ? deps.now() : new Date())); } catch (e) { failure = e; }
  const changes = treeChanges(before, hashTree(pendingDir));
  if (changes.length) {
    out.write(`ERROR PENDING-CHANGED ${changes.length} pending file(s) differ after the execute: ${changes.slice(0, 10).join(', ')}${changes.length > 10 ? ', ...' : ''}${failure ? `; the execute also failed: ${failure.message}` : ''}\n`);
    return 4;
  }
  if (failure) { out.write('ERROR ' + (failure.code || 'EXECUTE-FAILED') + ' ' + failure.message + '\n'); return failure.code === 'STALE-PLAN' ? 1 : 2; }
  out.write(`DONE appended=${done.appended} journals=${done.journals.join(',') || '-'} ledger-lines=${done.ledgerLines} ledger-repaired=${done.ledgerRepaired} skipped=${t.skipped} duplicates=${t.duplicates} conflicts=${t.conflicts} plan=${plan.planHash}\nThe pending files were not touched (${before.size} file(s), sha256 equal before and after). Commit the journal and the ledger; retire the pending files separately.\n`);
  return 0;
}

module.exports = { buildPlan, execute, machineId, canonicalJson, keyOf, main, assertSeparated, hashTree, treeChanges };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

'use strict';
// flake-quarantine.cjs - the one reader of the flaky-test quarantine register.
// Rule: a flaky test may be quarantined by one row of the register: its file, its exact name, a literal failure signature, the
// cause, an owner, a term of seven days and a plan item. While the row is active a failure of that test that carries the
// signature does not redden a run; it is still counted and shown. After the term the test blocks again; an extension is a
// new row with a new cause. A fixed cause ends a row early by a close record appended after it (never an edit of the row):
// the commit of the fix, a proof of at least five green runs of the test file in a row on the fixed head and, when the row
// names a host, a green rerun record; a closed row covers nothing. A row never covers a whole file, a failure with another signature, a failure that is not a
// test failure, a test whose file or whose executed entry file the change under test touched (or when that change is
// unknown), a test that failed on every host that ran it, a product gate or a test of the product tooling.
// The register is a source-repository development file the product never ships: a tree without it has no rows and covers
// nothing. Every reader (the suite runner, the train tool, the pulse, the add command and the validator) uses this module
// and one rule set: the rules of every row and the facts of the tree; a register with any problem covers nothing.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const safe = require('./path-safe.cjs');
const textSafe = require('./text-safe.cjs');
const { RULES } = require('./secrets.cjs');

// The name is built at run time so no shipped text names the development file.
const FILE = path.posix.join('docs', 'ops', `${['FLAKE', 'QUARANTINE'].join('-')}.jsonl`);
const PLAN_FILE = path.posix.join('docs', 'ops', `${['OPEN', 'REGISTER'].join('-')}.json`);
// A test of the product tooling loads a module of it; the directory name is built at run time like the file names above.
const PRODUCT_TOOL = `${path.posix.join('tools', 'product')}/`;
const PRODUCT_TOOL_JOIN = /'tools',\s*'product'/;
const CONFIG_FILE = '.ai/bin/ops-tools/ops-tools.config.json';
const SCHEMA = 'flake-quarantine/1';
const RULE = 'a row covers one test with one literal signature for seven days; after the term the test blocks again; an extension is a new row with a new cause';
const TERM_DAYS = 7;
const DAY_MS = 86400000;
const MAX_REGISTER_BYTES = 1024 * 1024;
const MAX_TEXT = 4000;
const ROW = ['id', 'file', 'test', 'signature', 'cause', 'owner', 'set', 'ends', 'plan', 'evidence', 'addedBy', 'extends'];
const HEADER = ['schema', 'rule'];
// The close record: one line after the row it closes, with the proof of the fix.
const CLOSE = ['closes', 'fix', 'proof', 'closedBy', 'closedAt'];
const PROOF = ['file', 'head', 'runs', 'rerun'];
const RUN = ['at', 'pass', 'fail', 'exit'];
const RERUN = ['host', 'at', 'pass', 'fail', 'exit'];
const MIN_RUNS = 5;
const MAX_RUNS = 50;
const MAX_PROOF_BYTES = 64 * 1024;
const SHA = /^[0-9a-f]{40,64}$/;
const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
// A farm result directory in the evidence of a row (stamp, kind, name, then the host after the last dot) names a host.
const HOST_EVIDENCE = /\d{8}T\d{6}-[A-Za-z0-9_.-]*\.[A-Za-z0-9][A-Za-z0-9_-]*/;
const ID = /^FQ-\d{3,}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const PLAN = /^OR-\d{4,}$/;
const TEST_FILE = /^(?:tests|docs\/ops)\/(?:[A-Za-z0-9_][A-Za-z0-9_.-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.cjs$/;
// The product gates and the tests of the product tooling: every test file named for the product (the real product build,
// its gates and their machinery). Their failures are never quarantined; a row of another test that loads the product
// tooling is refused by the tree facts below.
const PRODUCT_GATE = /^tests\/(?:product)[^/]*\.cjs$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const SIGNATURE_MIN = 16;
const SIGNATURE_MAX = 300;
const HOST_SIGNAL = 3;
const MAX_TREE_BYTES = 64 * 1024 * 1024;
const MAX_TEST_BYTES = 4 * 1024 * 1024;

const oneLine = (v, max = 500) => typeof v === 'string' && v.trim() !== '' && v.length <= max && !/[\x00-\x1f\x7f]/.test(v);
const realDay = v => {
  if (typeof v !== 'string' || !DAY.test(v)) return false;
  const ms = Date.parse(`${v}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(v);
};
const realStamp = v => {
  if (typeof v !== 'string' || !STAMP.test(v)) return false;
  const ms = Date.parse(v);
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 19) === v.slice(0, 19);
};
const dayMs = v => Date.parse(`${v}T00:00:00Z`);
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
const plusTerm = day => dayOf(dayMs(day) + TERM_DAYS * DAY_MS);
const plain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const sameKeys = (v, keys) => plain(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const flat = v => String(v).replace(/[\x00-\x1f\x7f]+/g, ' ').slice(0, 300);

// Problems of one row against the rows before it; no clock and no filesystem.
// closed: the close records read so far (row id -> record); a closed row no longer holds its test.
function rowProblems(row, earlier, closed = new Map()) {
  const out = [];
  const bad = message => out.push(message);
  if (!sameKeys(row, ROW)) {
    const keys = plain(row) ? Object.keys(row) : [];
    return [`fields must be exactly ${ROW.join(', ')}${keys.length ? ` (found ${keys.join(', ')})` : ''}`];
  }
  if (typeof row.id !== 'string' || !ID.test(row.id)) bad('id must be FQ-nnn');
  else if (earlier.some(r => r.id === row.id)) bad(`duplicate id ${row.id}`);
  if (typeof row.file !== 'string' || !TEST_FILE.test(row.file) || row.file.split('/').includes('..')) bad('file must be a .cjs file under tests/ or docs/ops/');
  else if (PRODUCT_GATE.test(row.file)) bad('a product gate is never quarantined');
  if (!oneLine(row.test)) bad('test must be the exact test name on one line');
  if (!oneLine(row.signature, SIGNATURE_MAX) || row.signature.length < SIGNATURE_MIN) bad(`signature must be one line of ${SIGNATURE_MIN} to ${SIGNATURE_MAX} characters`);
  else if ((row.signature.match(/[A-Za-z0-9]/g) || []).length < 8) bad('signature must carry at least 8 letters or digits');
  for (const k of ['cause', 'owner', 'evidence', 'addedBy']) if (!oneLine(row[k])) bad(`${k} must be one non-empty line`);
  if (typeof row.plan !== 'string' || !PLAN.test(row.plan)) bad('plan must name an open register item OR-nnnn');
  if (!realDay(row.set)) bad('set must be a calendar day YYYY-MM-DD');
  if (!realDay(row.ends)) bad('ends must be a calendar day YYYY-MM-DD');
  else if (realDay(row.set) && row.ends !== plusTerm(row.set)) bad(`ends must be set plus ${TERM_DAYS} days`);
  const same = earlier.filter(r => r.file === row.file && r.test === row.test);
  if (row.extends === null) {
    const held = same.filter(r => !closed.has(r.id));
    if (held.length) bad(`${held.at(-1).id} already quarantines this test: a new term needs extends and a new cause`);
  } else if (typeof row.extends !== 'string' || !ID.test(row.extends)) bad('extends must be null or FQ-nnn');
  else {
    const base = earlier.find(r => r.id === row.extends);
    if (!base || base.file !== row.file || base.test !== row.test) bad('extends must name an earlier row of the same test');
    else if (closed.has(base.id)) bad(`${base.id} is closed: a failure after a fix is a new row without extends`);
    else {
      if (same.at(-1).id !== base.id) bad(`extends must name the latest row of this test (${same.at(-1).id})`);
      if (base.cause === row.cause) bad('an extension needs a new cause');
      if (realDay(row.set) && realDay(base.ends) && dayMs(row.set) < dayMs(base.ends)) bad(`an extension starts when ${base.id} has ended (${base.ends})`);
    }
  }
  return out;
}

const greenRun = (run, keys) => sameKeys(run, keys) && realStamp(run.at) && Number.isInteger(run.pass) && run.pass > 0 && run.fail === 0 && run.exit === 0;
// A row names a host when its evidence names a farm result directory (the host is the suffix of that name).
const namesHost = row => HOST_EVIDENCE.test(row.evidence);

// Problems of one close record against the rows and the close records before it; no clock and no filesystem. Each problem
// starts with its name (CLOSE-...), so a refusal says which part of the proof is missing or wrong.
function closeProblems(close, earlier, closed) {
  if (!sameKeys(close, CLOSE)) return [`CLOSE-FIELDS: a close record has exactly ${CLOSE.join(', ')}`];
  const out = [];
  const bad = message => out.push(message);
  const row = typeof close.closes === 'string' && ID.test(close.closes) ? earlier.find(r => r.id === close.closes) : null;
  if (!row) bad('CLOSE-TARGET: closes must name an earlier row FQ-nnn');
  else if (closed.has(row.id)) bad(`CLOSE-TARGET: ${row.id} is already closed`);
  if (typeof close.fix !== 'string' || !SHA.test(close.fix)) bad('CLOSE-FIX: fix must be the full commit id of the fix');
  if (!oneLine(close.closedBy)) bad('CLOSE-BY: closedBy must be one non-empty line');
  if (!realStamp(close.closedAt)) bad('CLOSE-AT: closedAt must be a UTC time YYYY-MM-DDTHH:MM:SSZ');
  const proof = close.proof;
  if (!sameKeys(proof, PROOF)) return [...out, `CLOSE-PROOF: proof has exactly ${PROOF.join(', ')}`];
  if (typeof proof.file !== 'string' || !TEST_FILE.test(proof.file) || proof.file.split('/').includes('..') || PRODUCT_GATE.test(proof.file)) bad('CLOSE-PROOF-FILE: proof.file must be a .cjs test file under tests/ or docs/ops/ and not a product gate');
  if (typeof proof.head !== 'string' || !SHA.test(proof.head)) bad('CLOSE-PROOF-HEAD: proof.head must be the full commit id the runs were made on');
  const runs = Array.isArray(proof.runs) ? proof.runs : null;
  if (!runs || runs.length < MIN_RUNS || runs.length > MAX_RUNS) bad(`CLOSE-PROOF-RUNS: proof.runs must list the last ${MIN_RUNS} to ${MAX_RUNS} runs of the test file, one after another`);
  else if (!runs.every(run => greenRun(run, RUN))) bad('CLOSE-PROOF-RUNS: every listed run must be green (at, pass above 0, fail 0, exit 0): a red run breaks the row of runs');
  else if (runs.some((run, i) => i && Date.parse(run.at) < Date.parse(runs[i - 1].at))) bad('CLOSE-PROOF-RUNS: runs must be listed in the order they were made');
  const rerun = proof.rerun;
  if (rerun === null) { if (row && namesHost(row)) bad(`CLOSE-PROOF-RERUN: ${row.id} names a host in its evidence: a green rerun record is required`); }
  else if (!greenRun(rerun, RERUN) || !oneLine(rerun.host, 100)) bad('CLOSE-PROOF-RERUN: rerun must be null or a green record (host, at, pass above 0, fail 0, exit 0)');
  if (realStamp(close.closedAt) && out.every(p => !p.startsWith('CLOSE-PROOF-RUNS') && !p.startsWith('CLOSE-PROOF-RERUN'))) {
    const last = Math.max(...runs.map(run => Date.parse(run.at)), rerun ? Date.parse(rerun.at) : -Infinity);
    if (Date.parse(close.closedAt) < last) bad('CLOSE-AT: closedAt is before a run of the proof');
  }
  return out;
}

// One register line as JSON with every key once (the kernel's unique-key parser): a key written twice is refused by name,
// never read last-wins.
function lineJson(text) {
  try { return { value: textSafe.parseJsonUnique(text) }; } catch (e) {
    if (!e || e.code !== 'JSON_DUPLICATE_KEY') return { error: 'not JSON' };
    const twice = [...HEADER, ...ROW, ...CLOSE].filter(k => { try { return textSafe.jsonRootStrings(text, k).length > 1; } catch { return false; } });
    return { error: `a key appears twice${twice.length ? ` (${twice.join(', ')})` : ''}` };
  }
}

// Parse the register text; every problem is named, and a register with any problem covers nothing.
function parseRegister(text) {
  const problems = [];
  const rows = [];
  const closed = new Map();
  if (typeof text !== 'string') return { rows, closed, problems: ['register is not text'] };
  if (text.charCodeAt(0) === 0xfeff) problems.push('register starts with a byte order mark');
  if (text.includes('\r')) problems.push('register must use LF line endings');
  if (text !== '' && !text.endsWith('\n')) problems.push('register must end with a line feed');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (!lines.length) return { rows, closed, problems: [...problems, 'register has no header line'] };
  const head = lineJson(lines[0]);
  if (head.error) problems.push(`line 1: ${head.error}`);
  const header = head.error ? null : head.value;
  if (!sameKeys(header, HEADER) || header.schema !== SCHEMA || header.rule !== RULE) problems.push(`line 1: header must be {"schema":"${SCHEMA}","rule":"${RULE}"}`);
  for (let i = 1; i < lines.length; i++) {
    const parsed = lineJson(lines[i]);
    if (parsed.error) { problems.push(`line ${i + 1}: ${parsed.error}`); continue; }
    const row = parsed.value;
    if (plain(row) && Object.hasOwn(row, 'closes')) {
      const found = closeProblems(row, rows, closed);
      if (found.length) problems.push(...found.map(p => `line ${i + 1} (closes ${flat(row.closes)}): ${p}`));
      else closed.set(row.closes, row);
      continue;
    }
    const found = rowProblems(row, rows, closed);
    if (found.length) problems.push(...found.map(p => `line ${i + 1}${plain(row) && typeof row.id === 'string' ? ` (${flat(row.id)})` : ''}: ${p}`));
    else rows.push(row);
  }
  return { rows, closed, problems };
}

function headerLine() {
  return `${JSON.stringify({ schema: SCHEMA, rule: RULE })}\n`;
}

// The register of a tree: state absent (no file: no rows), ok, or invalid (named problems: no row covers). The rules of
// every row and the facts of the tree (treeProblems) are the one rule set of every reader: a row the validator fails
// never covers in the runner or the train tool.
// A plain read of one regular file: the suite runner and the validator call it in their own process, and a read through
// the native read-handle helper would place the helper cache outside the run (a link, a second hard link to the file or
// an oversized file is invalid).
function read(rootDir) {
  const root = path.resolve(rootDir);
  const file = path.join(root, FILE);
  const invalid = problems => ({ state: 'invalid', rows: [], closed: new Map(), problems });
  let st;
  try { st = fs.lstatSync(file); } catch (e) {
    return e.code === 'ENOENT' ? { state: 'absent', rows: [], closed: new Map(), problems: [] } : invalid([`register unreadable: ${e.code || 'error'}`]);
  }
  if (!st.isFile()) return invalid(['register is not a regular file']);
  if (st.nlink > 1) return invalid([`register has ${st.nlink} hard links: it must be one file of its own`]);
  if (st.size > MAX_REGISTER_BYTES) return invalid([`register is larger than ${MAX_REGISTER_BYTES} bytes`]);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return invalid([`register unreadable: ${e.code || 'error'}`]); }
  const parsed = parseRegister(text);
  if (parsed.problems.length) return invalid(parsed.problems);
  const facts = treeProblems(root, parsed.rows, parsed.closed);
  return facts.length ? invalid(facts) : { state: 'ok', rows: parsed.rows, closed: parsed.closed, problems: [] };
}

// closed: the close records of the register (a Map by row id); a closed row is never active.
const isActive = (row, nowMs, closed = null) => !(closed && closed.has(row.id)) && dayMs(row.set) <= nowMs && nowMs < dayMs(row.ends);
const closedOf = register => (register && register.closed instanceof Map ? register.closed : new Map());

function redact(text) {
  let out = text;
  for (const [, pattern] of RULES) out = out.replace(new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`), '[REDACTED]');
  return out;
}

// The failure text of a serialized node:test error: its message and the message of its cause, LF only.
function failureText(error) {
  if (!plain(error)) return '';
  const parts = [];
  if (typeof error.message === 'string') parts.push(error.message);
  if (typeof error.cause === 'string') parts.push(error.cause);
  else if (plain(error.cause) && typeof error.cause.message === 'string' && error.cause.message !== error.message) parts.push(error.cause.message);
  return parts.join('\n').replace(/\r\n?/g, '\n');
}

const relative = (root, file) => (typeof file === 'string' ? path.relative(root, path.resolve(root, file)).split(path.sep).join('/') : null);

// The failures of a node:test event list. complete: one final summary, no cancelled test, and exactly as many failure
// events as the summary counts. derived: a parent that failed only because a subtest failed (never a failure of its own).
function failuresFromEvents(events, root) {
  const finals = events.filter(e => e && e.type === 'test:summary' && e.data && !e.data.file);
  const fails = events.filter(e => e && e.type === 'test:fail' && plain(e.data));
  const counts = finals.length === 1 && plain(finals[0].data.counts) ? finals[0].data.counts : null;
  const complete = Boolean(counts) && counts.cancelled === 0 && counts.failed === fails.length;
  const failures = [];
  let derived = 0;
  for (const event of fails) {
    const d = event.data;
    const error = plain(d.details) ? d.details.error : null;
    const failureType = plain(error) && typeof error.failureType === 'string' ? error.failureType : 'unknown';
    if (failureType === 'subtestsFailed') { derived++; continue; }
    const file = relative(root, d.file);
    const fileLevel = plain(error) && Object.hasOwn(error, 'exitCode') ||
      (typeof d.name === 'string' && file !== null && relative(root, d.name) === file);
    // file: where the test is registered (a helper can register tests); entry: the test file the runner executed.
    failures.push({ file, entry: relative(root, d.entryFile || d.file), test: typeof d.name === 'string' ? d.name : null,
      line: Number.isSafeInteger(d.line) ? d.line : null, column: Number.isSafeInteger(d.column) ? d.column : null,
      failureType, fileLevel, text: failureText(error) });
  }
  return { complete, failures, derived };
}

// One failure against the register. ctx: { register, nowMs, changed (Set or null), everyHost (boolean) }.
function classify(failure, ctx) {
  const red = (reason, row = null) => ({ covered: false, row, reason });
  const entry = typeof failure.entry === 'string' && failure.entry ? failure.entry : null;
  if (typeof failure.file !== 'string' || PRODUCT_GATE.test(failure.file) || (entry && PRODUCT_GATE.test(entry))) return red(typeof failure.file === 'string' ? 'product-gate' : 'not-test-failure');
  if (failure.fileLevel || failure.failureType !== 'testCodeFailure' || typeof failure.test !== 'string') return red('not-test-failure');
  if (!ctx.register || ctx.register.state === 'invalid') return red('register-invalid');
  const rows = ctx.register.rows.filter(r => r.file === failure.file && r.test === failure.test);
  if (!rows.length) return red('no-row');
  const signed = rows.filter(r => typeof failure.text === 'string' && failure.text.includes(r.signature));
  if (!signed.length) return red('other-signature', rows.at(-1).id);
  const closed = closedOf(ctx.register);
  const open = signed.filter(r => !closed.has(r.id));
  if (!open.length) return red('closed', signed.at(-1).id);
  const active = open.find(r => isActive(r, ctx.nowMs, closed));
  if (!active) return red(open.some(r => ctx.nowMs < dayMs(r.set)) ? 'not-started' : 'expired', open.at(-1).id);
  if (!(ctx.changed instanceof Set)) return red('changed-unknown', active.id);
  // The file that registers the test and the entry file that ran it: a change of either is the change under test.
  if (ctx.changed.has(failure.file) || (entry && ctx.changed.has(entry))) return red('changed-by-package', active.id);
  if (ctx.everyHost) return red('every-host', active.id);
  return { covered: true, row: active.id, reason: 'covered', until: active.ends, plan: active.plan };
}

function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  return r.error || r.status !== 0 ? null : r.stdout;
}

// The base the change under test is measured from: a stated base, else the project's declared author base.
function baseRef(root, stated) {
  for (const value of stated) if (typeof value === 'string' && value !== '') return REF.test(value) && !value.includes('..') ? value : null;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(root, CONFIG_FILE), 'utf8'));
    const value = cfg?.author?.baseRef;
    return typeof value === 'string' && REF.test(value) && !value.includes('..') ? value : null;
  } catch { return null; }
}

const names = text => text.split('\n').map(s => s.trim()).filter(Boolean);

// The files the change under test touched: from the merge base of base and HEAD to the working tree, untracked included
// (head null), or base...head of two commits (a train). null when git cannot say.
function changedFiles(root, base, head = null) {
  if (!base) return null;
  if (head !== null) {
    const diff = git(root, ['diff', '--name-only', '--no-renames', `${base}...${head}`, '--']);
    return diff === null ? null : new Set(names(diff));
  }
  const mb = git(root, ['merge-base', base, 'HEAD']);
  if (mb === null || !/^[0-9a-f]{40,64}$/.test(mb.trim())) return null;
  const diff = git(root, ['diff', '--name-only', '--no-renames', mb.trim(), '--']);
  const others = git(root, ['ls-files', '--others', '--exclude-standard']);
  if (diff === null || others === null) return null;
  return new Set([...names(diff), ...names(others)]);
}

// The run decision of a single-host runner. The run is lowered to green only when the report is complete, every failure
// is covered and at least one exists; the runner sees one host, so the every-host rule is the train tool's.
function decideRun({ events, root, register, nowMs, changed }) {
  const { complete, failures } = failuresFromEvents(events, root);
  const classified = failures.map(f => ({ ...f, ...classify(f, { register, nowMs, changed, everyHost: false }) }));
  const covered = classified.filter(f => f.covered).length;
  return { complete, failures: classified, covered, red: classified.length - covered, nowMs,
    lowered: complete && classified.length > 0 && covered === classified.length };
}

// The record of a failure in a run summary: bounded, secrets redacted.
function summaryRecord(f) {
  const text = redact(f.text || '');
  return { file: f.file, entry: f.entry ?? null, test: f.test, line: f.line, column: f.column, failureType: f.failureType, fileLevel: f.fileLevel,
    text: text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}[truncated]` : text, covered: f.covered, row: f.row, reason: f.reason };
}

const quote = v => JSON.stringify(flat(v));
function runLines(decision, register, base, host) {
  const lines = decision.failures.map(f => f.covered
    ? `TEST-QUARANTINE covered row=${f.row} until=${f.until} plan=${f.plan} file=${f.file} test=${quote(f.test)}`
    : `TEST-QUARANTINE red reason=${f.reason}${f.row ? ` row=${f.row}` : ''} file=${f.file} test=${quote(f.test)}`);
  const active = register.rows.filter(r => isActive(r, decision.nowMs, closedOf(register))).length;
  lines.push(`TEST-QUARANTINE register=${register.state} rows=${register.rows.length} active=${active} closed=${closedOf(register).size} covered=${decision.covered} red=${decision.red} complete=${decision.complete} lowered=${decision.lowered} hosts=1 host=${flat(host || 'unknown')} base=${flat(base || 'unknown')}`);
  for (const p of register.problems.slice(0, 5)) lines.push(`TEST-QUARANTINE register-problem ${flat(p)}`);
  return lines;
}

// The train verdict over the run summaries of one train head (shards and reruns on several hosts).
// summaries: [{ name, data }]. A summary with a nonzero exit is red; a covered failure is judged again against the train's
// change, today and every host of the given summaries.
function suiteVerdict({ summaries, register, nowMs, changed }) {
  const lines = [];
  let red = 0, quarantined = 0;
  const ranOn = new Map(); // executed test file -> hosts whose summary lists the file or a failure of it
  const failedOn = new Map(); // file + test -> hosts with a failure of that test
  const hostOf = s => (plain(s.data) && typeof s.data.host === 'string' && s.data.host ? s.data.host : `unknown:${s.name}`);
  const keyOf = f => JSON.stringify([f.file, f.test]);
  // A test registered in a helper ran wherever its entry file ran; a record without an entry falls back to its file.
  const ranKey = f => (typeof f.entry === 'string' && f.entry ? f.entry : f.file);
  const add = (map, key, host) => { if (!map.has(key)) map.set(key, new Set()); map.get(key).add(host); };
  for (const s of summaries) {
    if (!plain(s.data)) continue;
    const host = hostOf(s);
    for (const f of Array.isArray(s.data.files) ? s.data.files : []) if (plain(f) && typeof f.name === 'string') add(ranOn, f.name, host);
    for (const f of Array.isArray(s.data.failures) ? s.data.failures : []) {
      if (!plain(f)) continue;
      add(ranOn, ranKey(f), host);
      add(failedOn, keyOf(f), host);
    }
  }
  for (const s of summaries) {
    const d = s.data;
    if (!plain(d) || d.schemaVersion !== 1 || !Number.isInteger(d.exit)) { red++; lines.push(`TRAIN-SUITE RED summary=${flat(s.name)} reason=unreadable-summary`); continue; }
    const host = hostOf(s);
    const failures = Array.isArray(d.failures) ? d.failures.filter(plain) : null;
    if (d.exit !== 0) {
      red++;
      lines.push(`TRAIN-SUITE RED summary=${flat(s.name)} host=${flat(host)} reason=exit-${d.exit}${failures ? ` failures=${failures.length}` : ' failures=unrecorded'}`);
      for (const f of failures || []) if (!f.covered) lines.push(`TRAIN-SUITE RED summary=${flat(s.name)} reason=${flat(f.reason || 'unrecorded')} file=${flat(f.file)} test=${quote(f.test)}`);
      continue;
    }
    let coveredHere = 0;
    for (const f of failures || []) {
      const ran = ranOn.get(ranKey(f)) || new Set();
      const failed = failedOn.get(keyOf(f)) || new Set();
      const everyHost = ran.size >= 2 && [...ran].every(h => failed.has(h));
      const c = classify(f, { register, nowMs, changed, everyHost });
      if (c.covered) {
        quarantined++; coveredHere++;
        lines.push(`TRAIN-SUITE QUARANTINED row=${c.row} until=${c.until} plan=${c.plan} host=${flat(host)} hosts=${ran.size} file=${flat(f.file)} test=${quote(f.test)}`);
      } else {
        red++;
        lines.push(`TRAIN-SUITE RED summary=${flat(s.name)} host=${flat(host)} reason=${c.reason}${c.row ? ` row=${c.row}` : ''} file=${flat(f.file)} test=${quote(f.test)}`);
      }
    }
    if (coveredHere >= HOST_SIGNAL) lines.push(`TRAIN-SUITE HOST-SIGNAL host=${flat(host)} covered=${coveredHere} summary=${flat(s.name)}: several quarantined tests failed on one host at once`);
  }
  lines.push(`TRAIN-SUITE ${red ? 'RED' : 'GREEN'} summaries=${summaries.length} quarantined=${quarantined} red=${red} register=${register.state}`);
  return { ok: red === 0 && summaries.length > 0, red, quarantined, lines };
}

// Pulse lines: the register state and every active row.
function pulseLines(root, nowMs) {
  const register = read(root);
  if (register.state === 'absent') return [];
  if (register.state === 'invalid') return [`flake quarantine INVALID: ${flat(register.problems[0] || 'unknown')} (no row covers)`];
  const closed = closedOf(register);
  const active = register.rows.filter(r => isActive(r, nowMs, closed));
  const expired = register.rows.filter(r => !closed.has(r.id) && nowMs >= dayMs(r.ends)).length;
  const next = active.map(r => r.ends).sort()[0] || 'none';
  return [`flake quarantine: register=ok rows=${register.rows.length} active=${active.length} expired=${expired} next-end=${next} closed=${closed.size}`,
    ...active.map(r => `quarantined ${r.id} ${flat(r.file)} ${quote(r.test)} until ${r.ends} plan ${r.plan} owner ${quote(r.owner)}`)];
}

// A bounded plain read of one regular file of the tree, or null.
function treeText(root, rel, max) {
  try {
    const st = fs.lstatSync(path.join(root, rel));
    return st.isFile() && st.size <= max ? fs.readFileSync(path.join(root, rel), 'utf8') : null;
  } catch { return null; }
}
// How often the test name is written as one quoted literal in its file (a name built at run time is not counted).
const quotedCount = (text, name) => ["'", '"', '`'].reduce((n, mark) => n + text.split(`${mark}${name}${mark}`).length - 1, 0);

// Facts of the tree a row must name: an existing regular test file that names the test once and does not load the product
// tooling, and an open plan item of the open register.
function treeProblems(root, rows, closed = new Map(), readText = treeText) {
  const out = [];
  let items = null;
  try {
    const text = readText(root, PLAN_FILE, MAX_TREE_BYTES);
    const reg = text === null ? null : JSON.parse(text);
    items = reg ? new Map((reg.items || []).map(item => [item.id, item.status])) : null;
  } catch { items = null; }
  for (const row of rows) {
    // A closed row is history: its file or its plan item may be gone or closed by the fix.
    if (closed.has(row.id)) continue;
    const source = readText(root, row.file, MAX_TEST_BYTES);
    if (source === null) out.push(`${row.id}: file ${row.file} does not exist as a regular file of at most ${MAX_TEST_BYTES} bytes`);
    else {
      if (source.includes(PRODUCT_TOOL) || PRODUCT_TOOL_JOIN.test(source)) out.push(`${row.id}: file ${row.file} loads the product tooling: a test of the product is never quarantined`);
      const named = quotedCount(source, row.test);
      if (named > 1) out.push(`${row.id}: test name is written ${named} times in ${row.file}: a row must name one test`);
    }
    if (items === null) out.push(`${row.id}: the open register is unreadable; plan ${row.plan} is unproven`);
    else if (!items.has(row.plan)) out.push(`${row.id}: plan ${row.plan} is not an open register item`);
    else if (['closed', 'withdrawn'].includes(items.get(row.plan))) out.push(`${row.id}: plan ${row.plan} is ${items.get(row.plan)}`);
  }
  return out;
}

// The validator check CM-79: an invalid register fails (it covers nothing); a valid one passes with its counts.
function checkRegister(root, report, nowMs = Date.now()) {
  const register = read(root);
  if (register.state === 'absent') return;
  const { problems } = register;
  if (register.state === 'invalid') {
    for (const p of problems.slice(0, 20)) report('CM-79', 'FAIL', `CM-79 flake quarantine: ${p}`, FILE);
    if (problems.length > 20) report('CM-79', 'FAIL', `CM-79 flake quarantine: +${problems.length - 20} more problems`, FILE);
    return;
  }
  const closed = closedOf(register);
  const active = register.rows.filter(r => isActive(r, nowMs, closed)).length;
  report('CM-79', 'PASS', `CM-79 flake quarantine: rows=${register.rows.length} active=${active} expired=${register.rows.filter(r => !closed.has(r.id) && nowMs >= dayMs(r.ends)).length} closed=${closed.size}`, FILE);
}

// The add command's row: every rule of the register, the tree facts, then one guarded append.
function addRow(rootDir, input, nowMs = Date.now()) {
  const root = path.resolve(rootDir);
  const register = read(root);
  if (register.state === 'invalid') return { ok: false, code: 'QUARANTINE-REGISTER-INVALID', detail: register.problems[0] };
  for (const k of ['cause', 'owner', 'plan', 'evidence', 'by', 'file', 'test', 'signature']) {
    if (typeof input[k] !== 'string' || input[k].trim() === '') return { ok: false, code: `QUARANTINE-${k.toUpperCase()}-MISSING`, detail: `--${k} is required` };
  }
  const set = input.set || dayOf(nowMs);
  if (!realDay(set)) return { ok: false, code: 'QUARANTINE-ROW', detail: 'set must be a calendar day YYYY-MM-DD' };
  if (dayMs(set) > nowMs) return { ok: false, code: 'QUARANTINE-ROW', detail: 'set must not be in the future' };
  const last = register.rows.map(r => Number(r.id.slice(3))).reduce((a, b) => Math.max(a, b), 0);
  const row = { id: `FQ-${String(last + 1).padStart(3, '0')}`, file: input.file, test: input.test, signature: input.signature,
    cause: input.cause, owner: input.owner, set, ends: plusTerm(set), plan: input.plan, evidence: input.evidence,
    addedBy: input.by, extends: input.extends || null };
  const problems = [...rowProblems(row, register.rows, closedOf(register)), ...treeProblems(root, [row])];
  if (problems.length) return { ok: false, code: 'QUARANTINE-ROW', detail: problems.join('; ') };
  const line = `${JSON.stringify(row)}\n`;
  if (register.state === 'absent') {
    const made = safe.writeAtomicGuarded(path.join(root, FILE), Buffer.from(headerLine() + line, 'utf8'), { root });
    if (!made.ok) return { ok: false, code: 'QUARANTINE-WRITE', detail: made.reason || 'refused' };
  } else {
    const done = safe.appendGuarded(root, FILE, fd => fs.writeSync(fd, line));
    if (!done.ok) return { ok: false, code: 'QUARANTINE-WRITE', detail: done.reason || 'refused' };
  }
  return { ok: true, row };
}

// The facts of git and the tree a close record names: the fix and the head of the runs are commits, the head holds the fix
// and is the checked-out line (or an ancestor of it), and the proof file is a test file of the tree that is, or loads, the
// file of the row. Checked when the record is written; the reader keeps the record as written.
function closeFacts(root, close, row) {
  const out = [];
  const commit = sha => git(root, ['cat-file', '-e', `${sha}^{commit}`]) !== null;
  const within = (older, newer) => git(root, ['merge-base', '--is-ancestor', older, newer]) !== null;
  if (!commit(close.fix)) out.push('CLOSE-FIX: the fix is not a commit of this repository');
  if (!commit(close.proof.head)) out.push('CLOSE-PROOF-HEAD: proof.head is not a commit of this repository');
  else {
    if (commit(close.fix) && !within(close.fix, close.proof.head)) out.push('CLOSE-PROOF-HEAD: proof.head does not contain the fix: the runs are not on the fixed head');
    if (!within(close.proof.head, 'HEAD')) out.push('CLOSE-PROOF-HEAD: proof.head is not an ancestor of HEAD');
  }
  const source = treeText(root, close.proof.file, MAX_TEST_BYTES);
  if (source === null) out.push(`CLOSE-PROOF-FILE: ${close.proof.file} does not exist as a regular file of at most ${MAX_TEST_BYTES} bytes`);
  else if (close.proof.file !== row.file && !source.includes(path.posix.basename(row.file))) out.push(`CLOSE-PROOF-FILE: ${close.proof.file} neither is ${row.file} nor loads it`);
  return out;
}

// The close command: one close record appended after every rule of the register and the facts hold. input: { id, fix,
// proof (the proof object), by }.
function closeRow(rootDir, input, nowMs = Date.now()) {
  const root = path.resolve(rootDir);
  const register = read(root);
  if (register.state === 'invalid') return { ok: false, code: 'QUARANTINE-REGISTER-INVALID', detail: register.problems[0] };
  for (const [k, name] of [['id', 'TARGET'], ['fix', 'FIX'], ['by', 'BY']]) {
    if (typeof input[k] !== 'string' || input[k].trim() === '') return { ok: false, code: `QUARANTINE-CLOSE-${name}`, detail: `--${k} is required` };
  }
  if (!plain(input.proof)) return { ok: false, code: 'QUARANTINE-CLOSE-PROOF', detail: '--proof must name a JSON file holding the proof object' };
  const close = { closes: input.id, fix: input.fix, proof: input.proof, closedBy: input.by, closedAt: new Date(nowMs).toISOString() };
  const problems = closeProblems(close, register.rows, closedOf(register));
  if (!problems.length) problems.push(...closeFacts(root, close, register.rows.find(r => r.id === close.closes)));
  if (problems.length) return { ok: false, code: `QUARANTINE-${problems[0].split(':')[0]}`, detail: problems.join('; ') };
  const done = safe.appendGuarded(root, FILE, fd => fs.writeSync(fd, `${JSON.stringify(close)}\n`));
  if (!done.ok) return { ok: false, code: 'QUARANTINE-WRITE', detail: done.reason || 'refused' };
  return { ok: true, close };
}

module.exports = { FILE, SCHEMA, RULE, TERM_DAYS, MIN_RUNS, PRODUCT_GATE, HOST_SIGNAL, MAX_PROOF_BYTES, rowProblems, closeProblems, parseRegister, headerLine, read,
  isActive, closedOf, redact, failureText, failuresFromEvents, classify, baseRef, changedFiles, decideRun, summaryRecord, runLines,
  suiteVerdict, pulseLines, treeProblems, checkRegister, addRow, closeRow };

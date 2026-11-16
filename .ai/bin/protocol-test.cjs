#!/usr/bin/env node
'use strict';

// Node test driver for the protocol regression suite (contracts C1-C8 frozen).
// One child runner over the explicit top-level tests/*.test.cjs list, in the
// resolved order; raw stdio byte-forward; exit = child's.
//
// The child is this same file started with --protocol-internal-runner
// (PROTOCOL_TEST_RUNNER_SPEC carries a one-hop JSON spec): it calls node:test
// run() with the files in exactly
// the resolved order and the driver's concurrency K, so the scheduled order is
// the real start order. A plain `node --test <paths>` cannot do that: Node 22
// expands and sorts its positional paths alphabetically, which silently
// discards a measured (LPT) order. The runner tees one event stream to the tap
// reporter on stdout and to this module's JSON reporter, which yields one JSON
// event per line to the report file. The require.main guard keeps main() from
// running in either role, and the exported helpers double as the module
// surface the contract suite pins.
//
// CLI (frozen):
//   [--root <abs>] [--conc N] [--order sorted|measured] [--json <path>]
//   [--list] [--file <substr>]... [--only <substr>]
//   [--rerun-failed <file>] [--clear-lock]
//   [--affected <baseRef>] (cannot combine with narrower selection flags)
//   [--with-mutations] adds mutation oracles for certification and release
// Unknown or invalid arguments fail TEST-PROTOCOL-USAGE, exit 1.
//
// Heavy runs are the operator's: a full-suite run, an --affected run and a
// broad selection start only when the environment carries the operator grant
// PROTOCOL_OPERATOR_HEAVY=1 (the operator's starters set it); without it the
// driver prints the one refusal line and exits 3 before any work. A seat
// carrying OK_SEAT_NAME cannot use the grant: the wrapper's seat marker wins
// even when empty, including case variants of the Windows environment key.
// A selection is heavy unless it is narrow: an empty --file/--only value
// is a usage error, and a --file/--only/--rerun-failed selection that would
// run more than HEAVY_SELECTION_FILE_CAP test files is a suite-scale run and
// refuses exactly like a full run. The narrow selections and the read-only
// modes stay open to every seat, and a granted run keeps its children
// working unchanged.
//
// Node >= 22 (TEST-PROTOCOL-NODE-OLD). PROTOCOL_TEST_FAKE_NODE_VERSION is a
// test-only override of the version the gate reads. PROTOCOL_TEST_POWERSHELL
// must be non-empty (TEST-PROTOCOL-ENV-POWERSHELL); the child env overlays
// PROTOCOL_TEST_FAST_CHECKS=1 and strips NODE_TEST_CONTEXT, because a
// node:test file-child context silently breaks any grandchild runner that
// inherits it. Any selection flag makes the run DIAGNOSTIC: loud selection
// line plus [DIAGNOSTIC-NOT-EVIDENCE]; never record or CI it.
//
// Each executing run hands its files PROTOCOL_TEST_SHARE_DIR, a marked
// directory inside its one-run temp tree for real artifacts shared within
// that run only; its parent owns cleanup on success and failure alike.
//
// Flaky-test quarantine (one reader: lib/flake-quarantine.cjs): when every test
// failure of the child is covered by an active register row (test, signature,
// term, a file the change under test did not touch, measured from
// PROTOCOL_TEST_QUARANTINE_BASE, else the --affected base, else the declared
// author base), the child counts as green; each failure is printed as a
// TEST-QUARANTINE line and recorded in the summary (host, failures, quarantine),
// and the counts never change. PROTOCOL_TEST_QUARANTINE=off disables it.
//
// Writes only the one-run temp tree (removed before the run returns; layer 0 of TEMP hygiene design, P-149) and
// <root>/.ai/runtime/:
//   test-summaries/run-summary.json  one summary per run (schema v1)
//   test-reports/<runId>.json        child JSON report (NDJSON events)
//   test-timing.jsonl                one line per full run
//   test-failures/<runId>/           artifacts on nonzero, redacted,
//                                    last 10 runs / 200 MB
//   test-protocol.lock               full-run lock, staleness by pid only

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const SUMMARY_SCHEMA_VERSION = 1;
// Heavy runs are the operator's: only the environment that carries the
// operator grant may start the full suite or an --affected run; every other
// seat gets the one refusal line and a distinct exit code. The single-file
// and read-only selections stay open to every seat, and the child of a
// granted run inherits the grant unchanged.
const OPERATOR_GRANT_ENV = 'PROTOCOL_OPERATOR_HEAVY';
const HEAVY_OPERATOR_REFUSAL = "heavy runs are the operator's: the operator runs them on the farm; run single files with --file";
const HEAVY_OPERATOR_EXIT = 3;
// A selection is heavy unless it is a real narrow selection: more matched
// test files than this cap is a suite-scale run (a broad substring such as
// `--file cjs`, a bare `--only .` over the whole inventory or a rerun summary
// naming most of it), so it needs the operator grant like a full run.
const HEAVY_SELECTION_FILE_CAP = 12;
const DIAGNOSTIC_TAG = '[DIAGNOSTIC-NOT-EVIDENCE]';
const RETAINED_FAILURE_RUNS = 10;
const FAILURE_BUDGET_BYTES = 200 * 1024 * 1024;
const TAIL_BYTES = 64 * 1024;
const TIMING_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const TIMING_MIN_RUNS = 5;
const INTERNAL_RUNNER_ARG = '--protocol-internal-runner';
const MAX_DRIVER_DEPTH = 16;

function rootIdentity(root) {
  let resolved = path.resolve(root);
  try { resolved = fs.realpathSync(resolved); } catch { /* discovery reports missing roots */ }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function driverAncestry() {
  const raw = process.env.PROTOCOL_TEST_ANCESTRY;
  if (raw === undefined) return [];
  const roots = JSON.parse(raw);
  if (!Array.isArray(roots) || roots.length > MAX_DRIVER_DEPTH ||
      roots.some(root => typeof root !== 'string' || !path.isAbsolute(root))) {
    throw Error('invalid driver ancestry');
  }
  return roots.map(rootIdentity);
}

function usageFailure(message) {
  process.stderr.write(`TEST-PROTOCOL-USAGE: ${message}\n`);
  return 1;
}

function namedFailure(name, message) {
  process.stderr.write(`${name}: ${message}\n`);
  return 1;
}

// ---------------------------------------------------------------------------
// Pure helpers (exported).

function parseArgs(argv) {
  const parsed = {
    root: null,
    conc: null,
    order: 'sorted',
    json: null,
    list: false,
    file: null,
    only: null,
    rerunFailed: null,
    affected: null,
    clearLock: false,
    withMutations: false,
  };
  const usage = message => ({ error: 'TEST-PROTOCOL-USAGE', message });
  const nextValue = args => (args.length ? args.shift() : null);
  const args = [...argv];
  while (args.length) {
    const argument = args.shift();
    if (argument === '--root') {
      const value = nextValue(args);
      if (value === null) return usage('--root needs a path');
      parsed.root = value;
    } else if (argument === '--conc') {
      const value = nextValue(args);
      if (value === null || !/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 8) {
        return usage('--conc must be an integer 1..8');
      }
      parsed.conc = Number(value);
    } else if (argument === '--order') {
      const value = nextValue(args);
      if (value !== 'sorted' && value !== 'measured') {
        return usage('--order must be sorted or measured');
      }
      parsed.order = value;
    } else if (argument === '--json') {
      const value = nextValue(args);
      if (value === null) return usage('--json needs a path');
      parsed.json = value;
    } else if (argument === '--list') {
      parsed.list = true;
    } else if (argument === '--file') {
      const value = nextValue(args);
      if (value === null || value.trim() === '') return usage('--file needs a non-empty substring');
      parsed.file = parsed.file === null ? value : [...(Array.isArray(parsed.file) ? parsed.file : [parsed.file]), value];
    } else if (argument === '--only') {
      const value = nextValue(args);
      if (value === null || value.trim() === '') return usage('--only needs a non-empty substring');
      parsed.only = value;
    } else if (argument === '--rerun-failed') {
      const value = nextValue(args);
      if (value === null || value.trim() === '') return usage('--rerun-failed needs a non-empty summary path');
      parsed.rerunFailed = value;
    } else if (argument === '--affected') {
      const value = nextValue(args);
      if (value === null || value.startsWith('--')) return usage('--affected needs a base commit ref');
      parsed.affected = value;
    } else if (argument === '--with-mutations') {
      parsed.withMutations = true;
    } else if (argument === '--clear-lock') {
      parsed.clearLock = true;
    } else {
      return usage(`unknown argument: ${argument}`);
    }
  }
  if (parsed.clearLock && (parsed.list || parsed.json !== null || parsed.conc !== null ||
      parsed.order !== 'sorted' || parsed.file !== null || parsed.only !== null ||
      parsed.rerunFailed !== null || parsed.affected !== null || parsed.withMutations)) {
    return usage('--clear-lock takes only --root');
  }
  if (parsed.rerunFailed !== null && (parsed.file !== null || parsed.only !== null)) {
    return usage('--rerun-failed excludes --file and --only');
  }
  if (parsed.affected !== null && (parsed.file !== null || parsed.only !== null || parsed.rerunFailed !== null)) {
    return usage('--affected excludes --file, --only and --rerun-failed (impact must not be narrowed)');
  }
  return parsed;
}

// The operator grant decision, pure so the mutation oracle can pin it. A
// heavy run is the full suite (no selection flag) or any --affected run; the
// read-only modes (--list, --clear-lock) and the narrow selections
// (--file, --only, --rerun-failed) are never heavy here - a selection wider
// than the cap is heavySelectionRefusal's business, which needs the resolved
// file set. Only the exact grant value 1 arms a heavy run; every other
// spelling or value refuses.
function operatorGrantRefusal(parsed, env = process.env) {
  if (parsed.list || parsed.clearLock) return null;
  const heavy = parsed.affected !== null ||
    (parsed.file === null && parsed.only === null && parsed.rerunFailed === null);
  if (heavy && seatEnvironment(env)) return HEAVY_OPERATOR_REFUSAL;
  return heavy && env[OPERATOR_GRANT_ENV] !== '1' ? HEAVY_OPERATOR_REFUSAL : null;
}

// The launch wrapper's marker outranks an inherited operator grant. Presence
// (even an empty value) counts; Windows environment keys are case-insensitive.
function seatEnvironment(env) {
  return Object.keys(env).some(key => key.toUpperCase() === 'OK_SEAT_NAME');
}

// The narrow-selection half of the same rule: --file, --only and
// --rerun-failed stay open for every seat only while the selection is a real
// narrow subset of the inventory. The caller passes the number of test files
// the selection would run (--only filters test names inside files, so its
// file set is the selection after any --file narrowing); more files than the
// cap is a suite-scale run in substance and refuses like a full run. The
// read-only modes never execute anything and stay open, with or without the
// grant.
function heavySelectionRefusal(parsed, matchedFiles, env = process.env) {
  if (parsed.list || parsed.clearLock) return null;
  const selection = parsed.file !== null || parsed.only !== null || parsed.rerunFailed !== null;
  if (!selection || parsed.affected !== null) return null;
  if (matchedFiles > HEAVY_SELECTION_FILE_CAP && seatEnvironment(env)) return HEAVY_OPERATOR_REFUSAL;
  return matchedFiles > HEAVY_SELECTION_FILE_CAP && env[OPERATOR_GRANT_ENV] !== '1'
    ? HEAVY_OPERATOR_REFUSAL : null;
}

// One enrollment source for execution and impact selection, including tests
// outside tests/. Exact forwarding entries execute their target once, in the
// same isolated child as before; other enrolled tests are independent entries.
// A snapshot reader lets historical selection use that commit's enrollment.
function discoverTestInventory(root, snapshotFiles = null) {
  const testsDir = path.join(root, 'tests');
  let names = [];
  if (snapshotFiles) {
    names = [...snapshotFiles.keys()].filter(n => /^tests\/[^/]+\.test\.cjs$/.test(n));
  } else try {
    names = fs.readdirSync(testsDir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.test.cjs'))
      .map(entry => `tests/${entry.name}`);
  } catch {
    // A manifest can enroll tests without a top-level tests directory.
  }
  const read = name => snapshotFiles ? snapshotFiles.get(name)?.text :
    fs.readFileSync(path.join(root, name), 'utf8');
  const manifestExists = snapshotFiles ? snapshotFiles.has('protocol-manifest.json') :
    fs.existsSync(path.join(root, 'protocol-manifest.json'));
  if (manifestExists) {
    const manifest = JSON.parse(read('protocol-manifest.json'));
    if (!Array.isArray(manifest.tests)) throw Error('test enrollment must be an array');
    for (const name of manifest.tests) {
      if (typeof name !== 'string') throw Error('invalid test enrollment');
      if (!name.endsWith('.test.cjs')) continue; // helpers are not test entries
      if (/[\\\r\n\0]/.test(name) || path.posix.isAbsolute(name) || /^[A-Za-z]:/.test(name) ||
          name.split('/').some(p => !p || p === '.' || p === '..')) throw Error('unsafe test enrollment');
      if (snapshotFiles ? !snapshotFiles.has(name) : !fs.existsSync(path.join(root, name))) {
        throw Error(`missing enrolled test: ${name}`);
      }
      names.push(name);
    }
  }
  const tests = [...new Set(names)].sort(), owners = {};
  for (const name of tests) owners[name] = name;
  for (const name of tests.filter(n => /^tests\/[^/]+\.test\.cjs$/.test(n))) {
    const body = read(name)?.replace(/^\/\/[^\n]*(?:\n|$)/gm, '').trim();
    const m = /^'use strict';\s*require\('([^']+)'\);$/.exec(body || '');
    if (!m || !m[1].startsWith('../')) continue;
    const target = path.posix.normalize(path.posix.join('tests', m[1]));
    if (tests.includes(target) && !target.startsWith('tests/')) owners[target] = name;
  }
  return { tests, entries: [...new Set(Object.values(owners))].sort(), owners };
}

function discoverTestFiles(root) {
  return discoverTestInventory(root).entries;
}

// Keep manifest.tests as strings: existing installer/validator readers retain
// their contract. testTiers is a closed, optional per-enrollment metadata map.
function testTierMetadata(root, inventory, snapshotFiles = null) {
  const text = snapshotFiles ? snapshotFiles.get('protocol-manifest.json')?.text :
    (fs.existsSync(path.join(root, 'protocol-manifest.json')) ? fs.readFileSync(path.join(root, 'protocol-manifest.json'), 'utf8') : null);
  const manifest = text ? JSON.parse(text) : {};
  const rows = manifest.testTiers || {};
  if (!rows || typeof rows !== 'object' || Array.isArray(rows)) throw Error('TEST-TIER-SCHEMA: expected metadata map');
  for (const [name, row] of Object.entries(rows)) {
    if (!inventory.tests.includes(name) || !row || Array.isArray(row) ||
        Object.keys(row).some(k => !['tier', 'targets'].includes(k)) ||
        !['standard', 'mutation', 'trainOnly'].includes(row.tier) || (row.targets !== undefined && (!Array.isArray(row.targets) ||
        row.targets.some(t => typeof t !== 'string' || !t || /[\\\r\n\0]/.test(t) ||
          path.posix.isAbsolute(t) || /^[A-Za-z]:/.test(t) || t.split('/').some(s => !s || s === '.' || s === '..'))))) {
      throw Error(`TEST-TIER-SCHEMA: invalid enrollment metadata: ${name}`);
    }
    if (row.tier === 'mutation' && row.targets && !row.targets.length) throw Error(`TEST-TIER-TARGETS: ${name}`);
  }
  for (const [name, owner] of Object.entries(inventory.owners)) {
    if ((rows[name]?.tier || 'standard') !== (rows[owner]?.tier || 'standard')) throw Error(`TEST-TIER-ALIAS: ${name}`);
  }
  return rows;
}

function selectTierFiles(root, withMutations = false) {
  const inventory = discoverTestInventory(root), rows = testTierMetadata(root, inventory);
  return inventory.entries.filter(n => withMutations || rows[n]?.tier !== 'mutation');
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

// Order precedence: sorted is canonical; --order
// measured uses fresh runtime medians > committed seed > sorted fallback.
function resolveOrder(names, options = {}) {
  const sorted = [...names].sort();
  if (options.order !== 'measured') {
    return { files: sorted, orderSource: 'sorted' };
  }
  const medians = options.medians;
  if (medians && Object.keys(medians).length > 0) {
    const known = names.filter(name => typeof medians[name] === 'number' && medians[name] >= 0);
    const unknown = sorted.filter(name => !known.includes(name));
    known.sort((a, b) => (medians[b] - medians[a]) || (a < b ? -1 : a > b ? 1 : 0));
    return { files: [...known, ...unknown], orderSource: 'runtime' };
  }
  if (options.seed && Array.isArray(options.seed.files)) {
    const ordered = [...new Set(options.seed.files.filter(name => names.includes(name)))];
    const rest = sorted.filter(name => !ordered.includes(name));
    return { files: [...ordered, ...rest], orderSource: 'seed' };
  }
  return { files: sorted, orderSource: 'sorted' };
}

// The runner spec: the files in the order they must start, as absolute paths.
// Canonical mode carries no name pattern and no isolation flags. The boundary
// fields (registryPath, runTempDir, runId) are optional: a caller that builds
// a spec without them runs without a registry, and the driver then reports an
// explicitly named registry-unverified boundary rather than a silent pass.
function buildRunnerSpec(options) {
  const spec = {
    files: options.files.map(name => path.join(options.root, name)),
    root: options.root,
    concurrency: options.concurrency,
    jsonReportPath: options.jsonReportPath,
  };
  if (options.namePattern) spec.namePattern = options.namePattern;
  if (options.registryPath) spec.registryPath = options.registryPath;
  if (options.runTempDir) spec.runTempDir = options.runTempDir;
  if (options.runId) spec.runId = options.runId;
  if (options.startsPath) spec.startsPath = options.startsPath;
  return spec;
}

// The JSON reporter used by the child runner: one JSON event per line to the
// destination the driver chose. An error keeps its message (Error properties are
// not enumerable): the quarantine reader matches failure signatures in it. An
// event whose error cause cannot be serialized (a cycle) is written as before.
const keepMessage = (key, value) => (value instanceof Error
  ? { ...value, message: value.message, ...(value.cause !== undefined ? { cause: value.cause } : {}) } : value);
async function* jsonReporter(source) {
  for await (const event of source) {
    let line;
    try { line = JSON.stringify(event, keepMessage); } catch { line = JSON.stringify(event); }
    yield `${line}\n`;
  }
}

// Runner mode (the driver's child). Starts the files in spec order, keeping
// at most spec.concurrency running, and mirrors `node --test`: tap on stdout,
// exit code 1 when any test fails.
async function runSpec(spec) {
  // The spec is a one-hop control message. Test files may launch a driver for
  // a fixture, but must never inherit the parent's executable file list.
  delete process.env.PROTOCOL_TEST_RUNNER_SPEC;
  const { run } = require('node:test');
  const { tap } = require('node:test/reporters');
  const { PassThrough } = require('node:stream');
  const { once } = require('node:events');
  // Transfer descendant identities at each file boundary; paths never prove ownership.
  let pbModule = null;
  const pb = () => {
    if (!pbModule) {
      try { pbModule = require('./lib/process-boundary.cjs'); } catch { pbModule = null; }
    }
    return pbModule;
  };
  const registryPath = typeof spec.registryPath === 'string' ? spec.registryPath : null;
  const registryTree = typeof spec.runTempDir === 'string' ? spec.runTempDir : null;
  const runId = typeof spec.runId === 'string' ? spec.runId : 'runner';
  const startsPath = typeof spec.startsPath === 'string' ? spec.startsPath : null;
  const knownStarts = new Set();
  const pollMs = 250;
  const knownIds = new Set();
  let lastSnapshot = Date.now();
  let markedDegraded = false;
  const registerSnapshot = force => {
    if (!registryPath || !pb()) return;
    const now = Date.now();
    if (!force && now - lastSnapshot < pollMs) return;
    lastSnapshot = now;
    let table = null;
    try { table = pb().collectProcesses(); } catch { table = null; }
    if (table === null) {
      if (!markedDegraded) {
        markedDegraded = true;
        try { pb().appendRegistry(registryPath, [{ runId, degraded: true, reason: 'snapshot-unavailable' }]); } catch { /* the missing file is the stronger signal */ }
      }
      return;
    }
    const fresh = pb().registerFromTable({ table, rootPid: process.pid, tree: registryTree })
      .filter(row => !knownIds.has(`${row.pid}:${row.created}`))
      .map(row => ({ runId, pid: row.pid, created: row.created, role: row.role }));
    for (const row of fresh) knownIds.add(`${row.pid}:${row.created}`);
    try { pb().appendRegistry(registryPath, fresh); }
    catch { process.stderr.write('[boundary] registry=UNVERIFIED reason=registry-write-unavailable\n'); }
  };
  // The Windows job records members natively; Linux polling retains descendants before reparenting.
  const registryPoll = process.platform === 'linux' ? setInterval(() => registerSnapshot(true), pollMs) : null;
  if (registryPoll) registryPoll.unref();
  if (registryPath) {
    process.env.PROTOCOL_PROCESS_REGISTRY = registryPath;
    process.env.PROTOCOL_PROCESS_RUN = runId;
    process.env.PROTOCOL_PROCESS_FILES = JSON.stringify(spec.files);
    process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS || ''} --require ${JSON.stringify(path.join(__dirname, 'lib/process-preload.cjs'))}`.trim();
  }
  const stream = run({
    files: spec.files,
    cwd: spec.root,
    concurrency: spec.concurrency,
    testNamePatterns: spec.namePattern ? [spec.namePattern] : undefined,
  });
  let failed = false;
  stream.on('test:fail', () => { failed = true; });
  stream.on('test:summary', event => {
    if (!event.file && event.success === false) failed = true;
  });
  const tapIn = new PassThrough({ objectMode: true });
  const jsonIn = new PassThrough({ objectMode: true });
  stream.on('data', event => {
    tapIn.write(event);
    jsonIn.write(event);
    // The long-pole pulse (finding 11.99 / R-L2-013.21) needs per-file start offsets:
    // stamp the first dequeue of each file (the file-root test, discriminated by its
    // name ending .test.cjs) with wall time. A failed stamp degrades to startMs null,
    // never to a wrong offset.
    if (startsPath && event && event.type === 'test:dequeue' && event.data &&
        typeof event.data.file === 'string' && /\.test\.cjs$/.test(event.data.file) &&
        /\.test\.cjs$/.test(String(event.data.name || '')) && !knownStarts.has(event.data.file)) {
      knownStarts.add(event.data.file);
      try { fs.appendFileSync(startsPath, `${JSON.stringify({ file: event.data.file, at: Date.now() })}\n`); }
      catch { /* the parent reports the missing offset in the summary */ }
    }
    if (event && event.type === 'test:summary' && event.data && event.data.file) {
      registerSnapshot(true);
      // File exit can precede the runner's remaining file summaries by many
      // snapshots. Mark completed bookkeeping separately from the file's exit
      // so a busy runner is not mistaken for an abandoned inherited pipe.
      if (registryPath && pb()) {
        try { pb().appendRegistry(registryPath, [{ runId, fileSettled: event.data.file }]); }
        catch { process.stderr.write('[boundary] registry=UNVERIFIED reason=runner-progress-registration\n'); }
      }
    }
  });
  stream.on('end', () => {
    tapIn.end();
    jsonIn.end();
  });
  // POSIX supervisor-death coverage (design 3.2): the driver starts this
  // runner detached, in its own session; when the driver dies the runner is
  // re-parented, notices the change of its parent, and removes its own whole
  // process group. On win32 the Job Object launcher covers the same case.
  if (process.platform !== 'win32' && process.env.PROTOCOL_TEST_DETACHED === '1') {
    const parentPid = process.ppid;
    let orphaned = false;
    const watchdog = setInterval(async () => {
      if (process.ppid !== parentPid) {
        if (orphaned) return;
        orphaned = true;
        const engine = pb();
        const registered = engine?.readRegistry(registryPath);
        if (registered) await engine.enforceBoundary({
          runId, registry: registered.rows.filter(row => !row.fileExit && !row.fileSettled && !row.degraded && row.pid !== process.pid),
          table: engine.collectProcesses(), collect: engine.collectProcesses,
          kill: (pid, signal) => { try { process.kill(pid, signal); return 'stopped'; } catch { return 'denied'; } },
          sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        });
        try { process.kill(-process.pid, 'SIGKILL'); } catch { /* not a group leader */ }
        process.exit(1);
      }
    }, 1000);
    watchdog.unref();
  }
  const forwardTap = async () => {
    for await (const chunk of tap(tapIn)) {
      if (!process.stdout.write(chunk)) await once(process.stdout, 'drain');
    }
  };
  const writeJson = async () => {
    const fd = fs.openSync(spec.jsonReportPath, 'w');
    try {
      for await (const line of jsonReporter(jsonIn)) fs.writeSync(fd, line);
    } finally {
      fs.closeSync(fd);
    }
  };
  await Promise.all([forwardTap(), writeJson()]);
  if (registryPoll) clearInterval(registryPoll);
  registerSnapshot(true);
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Impure support.

function gitOutput(root, args) {
  // TRAIN-PATHS: the worktree travels through cwd, never argv.
  const result = spawnSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true });
  return result.status === 0 ? result.stdout : null;
}

function isUnder(base, target) {
  const relative = path.relative(base, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function repoRootHash(root) {
  return crypto.createHash('sha256').update(root).digest('hex');
}

function inventoryHash(root, names) {
  const lines = names.map(name => {
    const digest = crypto.createHash('sha256')
      .update(fs.readFileSync(path.join(root, name)))
      .digest('hex');
    return `${path.basename(name)} ${digest}\n`;
  }).sort();
  return crypto.createHash('sha256').update(lines.join('')).digest('hex');
}

function loadSeed(root) {
  const seedPath = path.join(root, 'docs/ops/suite-order.json');
  try {
    const seed = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    if (seed && Array.isArray(seed.files)) return seed;
  } catch {
    // Absent in v1 (committed only if LPT is kept); sorted is the fallback.
  }
  return null;
}

function loadMedians(root, hash) {
  const timingPath = path.join(root, '.ai/runtime/test-timing.jsonl');
  let raw;
  try {
    raw = fs.readFileSync(timingPath, 'utf8');
  } catch {
    return null;
  }
  const cutoff = Date.now() - TIMING_MAX_AGE_MS;
  const runs = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.inventoryHash === hash && entry.ts && Date.parse(entry.ts) >= cutoff &&
          entry.files && typeof entry.files === 'object') {
        runs.push(entry.files);
      }
    } catch {
      // A malformed history line never invalidates the fresh ones.
    }
  }
  if (runs.length < TIMING_MIN_RUNS) return null;
  const medians = {};
  const names = new Set(runs.flatMap(files => Object.keys(files)));
  for (const name of names) {
    // an unknown duration (null, text, an absent file) is no value: Number(null) would read it as zero seconds
    const values = runs
      .map(files => files[name])
      .filter(value => typeof value === 'number' && Number.isFinite(value) && value >= 0);
    if (values.length > 0) medians[name] = median(values);
  }
  return Object.keys(medians).length > 0 ? medians : null;
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

// The shell the Job Object launcher may run through: an existing file, resolved through where.exe
// for a bare name. A marker or a missing binary is null, never a guess.
function resolveJobShell(shellValue) {
  if (typeof shellValue !== 'string' || !shellValue.trim()) return null;
  const probe = value => { try { return fs.statSync(value).isFile() ? value : null; } catch { return null; } };
  if (path.isAbsolute(shellValue)) return probe(shellValue);
  const where = spawnSync('where.exe', [shellValue], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
  if (where.status !== 0) return null;
  const first = (where.stdout || '').trim().split(/\r?\n/)[0];
  return first ? probe(first) : null;
}

function lockFile(root) {
  return path.join(root, '.ai/runtime/test-protocol.lock');
}

function acquireLock(root) {
  const file = lockFile(root);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    try {
      const lock = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (lock && typeof lock.pid === 'number' && lock.repoRootHash === repoRootHash(root) &&
          pidAlive(lock.pid)) {
        return { blocked: true, pid: lock.pid };
      }
    } catch {
      // An unreadable lock is stale by definition; staleness is pid-only.
    }
  }
  fs.writeFileSync(file, `${JSON.stringify({
    repoRootHash: repoRootHash(root),
    pid: process.pid,
    startedAt: new Date().toISOString(),
    mode: 'full',
  })}\n`);
  return { blocked: false, file };
}

function clearLockAction(root) {
  const file = lockFile(root);
  if (!fs.existsSync(file)) {
    process.stdout.write('no lock present\n');
    return 0;
  }
  let lock = null;
  try {
    lock = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Unreadable: stale, clearable.
  }
  if (lock && typeof lock.pid === 'number' && lock.repoRootHash === repoRootHash(root) &&
      pidAlive(lock.pid)) {
    process.stderr.write(`TEST-PROTOCOL-LOCK-HELD: refusing --clear-lock; pid ${lock.pid} is live\n`);
    return 1;
  }
  fs.rmSync(file, { force: true });
  process.stdout.write('stale lock cleared\n');
  return 0;
}

function redact(text) {
  return String(text)
    .replace(/((?:password|passwd|secret|token|api[_-]?key)["']?\s*[:=]\s*)\S+/gi, '$1[REDACTED]');
}

function makeTail() {
  const chunks = [];
  return {
    push(chunk) {
      chunks.push(chunk);
      let total = chunks.reduce((sum, part) => sum + part.length, 0);
      while (total > TAIL_BYTES) {
        total -= chunks[0].length;
        chunks.shift();
      }
    },
    text() {
      return redact(Buffer.concat(chunks).toString('utf8'));
    },
  };
}

// Parse the child JSON report (NDJSON events) into counts and per-file data. A count or a duration the report does not
// state is unknown (null), never zero: a missing measurement is not a measurement of nothing.
const knownCount = value => (Number.isSafeInteger(value) && value >= 0 ? value : null);
const knownSeconds = ms => (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0 ? ms / 1000 : null);
function parseReport(reportPath) {
  let raw;
  try {
    raw = fs.readFileSync(reportPath, 'utf8');
  } catch {
    return null;
  }
  let finalSummary = null;
  const files = new Map();
  const fileCounts = new Map();
  const skippedTests = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event.type === 'test:summary' && event.data && !event.data.file) {
      finalSummary = event.data;
    }
    if (event.type === 'test:summary' && event.data?.file && event.data.counts) {
      fileCounts.set(path.resolve(event.data.file), event.data.counts);
    }
    // A skipped test also emits test:pass. Preserve its identity and reason
    // once, and use entryFile when the assertion lives in a shared helper.
    if (event.type === 'test:pass' && event.data?.skip) {
      skippedTests.push({
        file: event.data.entryFile || event.data.file || null,
        name: event.data.name,
        reason: typeof event.data.skip === 'string' ? event.data.skip : 'unspecified',
      });
    }
    // File-level completions: the event name is the test file itself
    // (relative or absolute); per-test events also carry data.file, so the
    // nesting and the name shape are the discriminator.
    if (event.type === 'test:complete' && event.data && event.data.nesting === 0 &&
        typeof event.data.file === 'string' && /\.test\.cjs$/.test(event.data.file) &&
        /\.test\.cjs$/.test(String(event.data.name || ''))) {
      const details = event.data.details || {};
      files.set(path.resolve(event.data.file), {
        passed: details.passed === true,
        seconds: knownSeconds(details.duration_ms),
      });
    }
  }
  if (!finalSummary && files.size === 0) return null;
  const counts = finalSummary && finalSummary.counts ? {
    total: knownCount(finalSummary.counts.tests),
    pass: knownCount(finalSummary.counts.passed),
    fail: knownCount(finalSummary.counts.failed),
    skip: knownCount(finalSummary.counts.skipped),
  } : null;
  for (const [file, entry] of files) {
    const measured = fileCounts.get(file);
    entry.skipped = measured ? entry.passed && measured.tests > 0 && measured.skipped === measured.tests : null;
  }
  return { counts, files, skippedTests };
}

// TAP parse from the forwarded stream (the fallback).
function parseTap(stdout) {
  const counts = { total: 0, pass: 0, fail: 0, skip: 0 };
  const files = new Map();
  const skippedTests = [...stdout.matchAll(/^\s*ok \d+ - (.*?) # SKIP(?: (.*))?$/gm)]
    .map(match => ({ file: null, name: match[1], reason: match[2] || 'unspecified' }));
  for (const match of stdout.matchAll(/^(ok|not ok) \d+ - (\S.*\.test\.cjs)\s*$/gm)) {
    files.set(match[2].replace(/\\/g, '/'), { passed: match[1] === 'ok', seconds: null });
  }
  const number = pattern => {
    const found = pattern.exec(stdout);
    return found ? Number(found[1]) : null;
  }
  ;
  counts.total = number(/^# tests (\d+)$/m);
  counts.pass = number(/^# pass (\d+)$/m);
  counts.fail = number(/^# fail (\d+)$/m);
  counts.skip = number(/^# skipped (\d+)$/m);
  if (!counts.total && files.size === 0) return null;
  return { counts, files, skippedTests };
}

function summaryFiles(root, selected, report, finalExit, startOffsets = new Map()) {
  const counts = report.counts;
  const allSkipped = counts?.total > 0 && counts.skip === counts.total;
  return selected.map(name => {
    const entry = report.files.get(path.join(root, name)) || report.files.get(name.replace(/\//g, path.sep));
    const startMs = startOffsets.get(path.join(root, name)) ??
      startOffsets.get(path.resolve(root, name.replace(/\//g, path.sep)));
    // Missing per-file measurements in a mixed TAP fallback are unknown, not
    // proof that an unexecuted oracle passed. The run exit remains independent.
    let status;
    if (entry?.passed === false) status = 'fail';
    else if (entry?.skipped || allSkipped) status = 'skip';
    else if (entry?.skipped === false) status = 'pass';
    else if (counts?.skip > 0) status = 'unknown';
    // No measurement for a selected file is never a pass: a clean run exit says nothing about a file the report does not name.
    else status = entry ? 'pass' : finalExit === 0 ? 'unknown' : 'fail';
    // startMs missing (TAP fallback, no dequeue stamp): null means the start offset
    // is unproven; the long-pole pulse reports it unknown, never as zero.
    return { name, status, seconds: entry && Number.isFinite(entry.seconds) ? Math.round(entry.seconds * 1000) / 1000 : null,
      startMs: Number.isSafeInteger(startMs) && startMs >= 0 ? startMs : null };
  });
}

function pruneFailures(failuresDir) {
  let runs;
  try {
    runs = fs.readdirSync(failuresDir)
      .map(name => ({ name, full: path.join(failuresDir, name) }))
      .filter(entry => fs.statSync(entry.full).isDirectory())
      .map(entry => ({ ...entry, mtime: fs.statSync(entry.full).mtimeMs }))
      .sort((a, b) => a.mtime - b.mtime);
  } catch {
    return;
  }
  let removed = 0;
  while (runs.length - removed > RETAINED_FAILURE_RUNS) {
    fs.rmSync(runs[removed].full, { recursive: true, force: true });
    removed += 1;
  }
  let budget = FAILURE_BUDGET_BYTES;
  for (let index = runs.length - 1; index >= removed; index -= 1) {
    let size = 0;
    try {
      for (const artifact of fs.readdirSync(runs[index].full)) {
        size += fs.statSync(path.join(runs[index].full, artifact)).size;
      }
    } catch {
      continue;
    }
    budget -= size;
    if (budget < 0) {
      fs.rmSync(runs[index].full, { recursive: true, force: true });
    }
  }
}

function readFailedFromSummary(summaryPath) {
  try {
    const summary = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
    if (summary && Array.isArray(summary.files)) {
      return summary.files.filter(file => file.status === 'fail').map(file => file.name);
    }
  } catch {
    // Fall through to the usage failure below.
  }
  return null;
}

// Only this run's selected paths count. Duplicate or foreign markers cannot
// extend the wait; the growing set admits at most one extension per file.
function observeFileProgress(rows, runId, expectedFiles, settledFiles) {
  const previous = settledFiles.size;
  const exited = new Set();
  for (const row of rows) {
    if (row.runId !== runId) continue;
    if (expectedFiles.has(row.fileExit)) exited.add(row.fileExit);
    if (expectedFiles.has(row.fileSettled)) settledFiles.add(row.fileSettled);
  }
  return { allExited: exited.size === expectedFiles.size, advanced: settledFiles.size > previous };
}

// ---------------------------------------------------------------------------
// main.

async function main() {
  const startMs = Date.now();
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) return usageFailure(parsed.message);
  const root = parsed.root ? path.resolve(parsed.root) : path.resolve(__dirname, '..', '..');

  let ancestry;
  try { ancestry = driverAncestry(); } catch {
    return namedFailure('TEST-PROTOCOL-RECURSION', 'invalid driver ancestry; no tests ran');
  }
  const identity = rootIdentity(root);
  if (ancestry.includes(identity) || ancestry.length >= MAX_DRIVER_DEPTH) {
    return namedFailure('TEST-PROTOCOL-RECURSION',
      'repository already has an ancestor driver or maximum driver depth reached; no tests ran');
  }

  if (parsed.clearLock) return clearLockAction(root);

  // Heavy runs are the operator's: the full suite and an --affected run
  // refuse here, before discovery and before any lock, when the environment
  // does not carry the operator grant; a granted run (and its children)
  // proceeds without a seat marker. Single files and read-only modes stay open.
  const operatorRefusal = operatorGrantRefusal(parsed);
  if (operatorRefusal !== null) {
    process.stderr.write(`${operatorRefusal}\n`);
    return HEAVY_OPERATOR_EXIT;
  }

  // C1: the driver refuses to run on Node below 22. Node missing is the
  // wrapper's fallback case, never the driver's.
  const versionString = process.env.PROTOCOL_TEST_FAKE_NODE_VERSION || process.versions.node;
  const major = /^v?(\d+)/.exec(String(versionString));
  if (!major || Number(major[1]) < 22) {
    return namedFailure('TEST-PROTOCOL-NODE-OLD',
      `Node 22 or later is required (gate read: ${versionString})`);
  }

  // C2: discovery over the frozen canonical shape; empty is a named failure.
  const discovered = discoverTestFiles(root);
  if (discovered.length === 0) {
    return namedFailure('TEST-PROTOCOL-NO-TESTS', `no tests/*.test.cjs under ${root}`);
  }
  let selected = selectTierFiles(root, parsed.withMutations ||
    (parsed.file !== null || parsed.only !== null || parsed.rerunFailed !== null));
  let affected = null;
  // Affected-only runs are switched off unless the one switch of the selector
  // is on: --affected then runs the full suite and says so in one line.
  if (parsed.affected !== null && !require('./protocol-affected.cjs').affectedRunsOn()) {
    process.stderr.write(`${require('./protocol-affected.cjs').AFFECTED_OFF}: --affected ${parsed.affected} runs the full suite\n`);
    parsed.affected = null;
  }
  if (parsed.affected !== null) {
    try {
      affected = require('./protocol-affected.cjs').selectAffected(root, parsed.affected, { withMutations: parsed.withMutations });
    } catch (error) {
      return namedFailure('TEST-PROTOCOL-AFFECTED-UNKNOWN', `${error.message}; no tests ran; refresh the consumer index or declare the missing reader`);
    }
    selected = affected.executionFiles;
    if (affected.fallback && JSON.stringify([...selected].sort()) !== JSON.stringify([...discovered].sort())) {
      return namedFailure('TEST-PROTOCOL-AFFECTED-UNKNOWN', 'FULL fallback inventory differs from full driver; no tests ran');
    }
    process.stderr.write(`affected base: ${affected.base}; changed=${affected.changed.length}; selected=${affected.files.length}/${affected.total}; execution entries=${selected.length}/${discovered.length}\n`);
    for (const reason of affected.unknown) process.stderr.write(`affected uncertainty: ${reason}\n`);
    for (const file of affected.files) process.stderr.write(`affected ${file.name}: ${file.reasons.join('; ')}\n`);
    for (const name of affected.deferred || []) process.stderr.write(`affected deferred mutation tier (add --with-mutations): ${name}\n`);
    if (affected.fallback) process.stderr.write('affected FULL fallback: impact cannot be mapped with certainty\n');
  }
  const diagnostic = parsed.file !== null || parsed.only !== null || parsed.rerunFailed !== null ||
    (affected && !affected.fallback);
  if (parsed.rerunFailed !== null) {
    const failed = readFailedFromSummary(path.resolve(parsed.rerunFailed));
    if (failed === null) {
      return usageFailure(`--rerun-failed: cannot read a summary at ${parsed.rerunFailed}`);
    }
    const failedSet = new Set(failed);
    selected = selected.filter(name => failedSet.has(name));
  }
  if (parsed.file !== null) {
    const patterns = Array.isArray(parsed.file) ? parsed.file : [parsed.file];
    selected = selected.filter(name => patterns.some(pattern => name.includes(pattern)));
  }
  if (selected.length === 0) {
    return namedFailure('TEST-PROTOCOL-NO-TESTS', 'the selection matches no test file');
  }

  // C8: --list prints the sorted selection without executing, locking or env.
  if (parsed.list) {
    process.stdout.write(`${[...selected].sort().join('\n')}\n`);
    return 0;
  }

  // The narrow-selection guard: a selection that would run more test files
  // than the cap is a suite-scale run in substance, so without the operator
  // grant it refuses exactly like a full run - the one refusal line, exit 3,
  // before any lock, temp tree or summary. --list above stays open: the
  // read-only list executes nothing.
  const selectionRefusal = heavySelectionRefusal(parsed, selected.length);
  if (selectionRefusal !== null) {
    process.stderr.write(`${selectionRefusal}\n`);
    return HEAVY_OPERATOR_EXIT;
  }

  // Inventory/tier readers can load the standalone driver; execution requires its installed helper.
  let tempHelper;
  try { tempHelper = require('./lib/run-temp.cjs'); }
  catch (e) { return namedFailure('TEST-PROTOCOL-TEMP-HELPER', `run-temp helper unavailable (${e.code || 'load-failed'}); no tests ran`); }
  const { createRunTemp, settleRunTemp, recordLine, resolveRunTempRoot } = tempHelper;

  if (process.env.PROTOCOL_NO_FULL_SUITE === '1' && !diagnostic) {
    return namedFailure('TEST-PROTOCOL-NO-FULL-SUITE',
      'PROTOCOL_NO_FULL_SUITE=1 is set: the full suite runs in the landing train; use --affected <baseRef>. An affected FULL fallback is blocked here, never narrowed or silently skipped');
  }

  // C3: the shell must be provided, never invented; the child gets the
  // FAST_CHECKS overlay; NODE_TEST_CONTEXT is stripped (see header).
  const powershell = process.env.PROTOCOL_TEST_POWERSHELL;
  if (typeof powershell !== 'string' || powershell === '') {
    return namedFailure('TEST-PROTOCOL-ENV-POWERSHELL',
      'PROTOCOL_TEST_POWERSHELL must be set to the PowerShell binary path');
  }

  // PROTO-DEC-0249 items 2 and 3 (P-153, P-154): with PROTOCOL_HEAVY_GATE=1 the driver asks the heavy-run gate for the
  // environment check and a slot before the runner starts. It is a switch of the operator's train and author runs, off by
  // default so fixture drivers inside the suite never queue; the child env below drops it, so a nested driver never waits
  // behind its own parent.
  if (process.env.PROTOCOL_HEAVY_GATE === '1') {
    const gateEnv = { ...process.env };
    for (const key of Object.keys(gateEnv)) if (key.toUpperCase() === 'PROTOCOL_HEAVY_TREE') delete gateEnv[key];
    gateEnv.PROTOCOL_HEAVY_TREE = root;
    const gateScript = path.relative(root, path.join(__dirname, 'ops-tools', 'heavy-gate.cjs'));
    const gate = spawnSync(process.execPath, [gateScript], { cwd: root, env: gateEnv, stdio: ['ignore', 'inherit', 'inherit'], windowsHide: true });
    if (gate.status !== 0) return namedFailure('TEST-PROTOCOL-HEAVY-GATE', `the heavy-run gate refused the start (exit ${gate.status === null ? 'none' : gate.status}); no tests ran`);
  }

  // Order (section 5): sorted canonical; measured by runtime medians.
  let order = parsed.order;
  let orderSource = 'sorted';
  if (order === 'measured') {
    const hash = inventoryHash(root, discovered);
    const resolved = resolveOrder(selected, {
      order,
      medians: loadMedians(root, hash),
      seed: loadSeed(root),
    });
    selected = resolved.files;
    orderSource = resolved.orderSource;
  } else {
    selected = resolveOrder(selected, {}).files;
  }
  process.stderr.write(`order: ${order} (orderSource=${orderSource})\n`);

  const runId = `run-${startMs}-${crypto.randomUUID().slice(0, 8)}`;
  const runtimeDir = path.join(root, '.ai/runtime');

  // C6: --json must resolve under OS temp or .ai/runtime.
  let jsonReportPath = null;
  if (parsed.json) {
    jsonReportPath = path.resolve(parsed.json);
    if (!isUnder(os.tmpdir(), jsonReportPath) && !isUnder(runtimeDir, jsonReportPath)) {
      return usageFailure(`--json must resolve under ${os.tmpdir()} or ${runtimeDir}`);
    }
  } else {
    jsonReportPath = path.join(runtimeDir, 'test-reports', `${runId}.json`);
  }

  // Section 7.13: selection runs are loud diagnostics, never Evidence.
  const selectionParts = [];
  if (parsed.file !== null) {
    for (const pattern of Array.isArray(parsed.file) ? parsed.file : [parsed.file]) selectionParts.push(`--file ${pattern}`);
  }
  if (parsed.only !== null) selectionParts.push(`--only ${parsed.only}`);
  if (parsed.rerunFailed !== null) selectionParts.push(`--rerun-failed ${parsed.rerunFailed}`);
  if (parsed.affected) selectionParts.push(`--affected ${affected.base}`);
  const selectionText = diagnostic || affected ? selectionParts.join(' ') : null;
  if (diagnostic) {
    process.stderr.write(`selection: ${selectionText}\n`);
    process.stderr.write(`${DIAGNOSTIC_TAG} this run selects a subset; it is not Evidence and must not be recorded\n`);
  }

  // The child runner writes the report file itself; its directory must exist
  // before the spawn, for the default path and for --json alike.
  fs.mkdirSync(path.dirname(jsonReportPath), { recursive: true });

  // C7: full runs take the lock; diagnostics and --list never do.
  let heldLock = null;
  if (!diagnostic) {
    const lock = acquireLock(root);
    if (lock.blocked) {
      return namedFailure('TEST-PROTOCOL-LOCK-HELD',
        `a full run is already active (pid ${lock.pid})`);
    }
    heldLock = lock.file;
  }

  // Section 7.7: tracked-delta porcelain guard start; untracked ignored.
  const porcelainStart = gitOutput(root, ['status', '--porcelain', '--untracked-files=no']);
  const headOutput = gitOutput(root, ['rev-parse', 'HEAD']);
  const head = headOutput !== null ? headOutput.trim() : null;
  const dirty = porcelainStart !== null ? porcelainStart.trim() !== '' : null;

  const concurrency = parsed.conc !== null ? parsed.conc
    : Math.max(1, Math.min(8, os.cpus().length));

  // Layer 0 of TEMP hygiene design (PROTO-DEC-0244 item 1): TEMP, TMP and TMPDIR of this one run point into a fresh
  // directory under the work root, and the directory is removed as soon as the exit code is known (the record line below).
  // A work root that does not exist is not created here: the run keeps the inherited TEMP and says so in one line.
  const runTempRoot = resolveRunTempRoot({ repo: root, env: process.env });
  // DISK-LEAKS dli1: roots of an EARLIER run whose process was killed are swept first, only through the owner-proof helper (owner dead,
  // inside this work root, deadline past); a sweep never stops the run.
  const sweepNote = typeof tempHelper.sweepRunTemps === 'function' ? tempHelper.sweepLine(tempHelper.sweepRunTemps({ root: runTempRoot.dir })) : null;
  if (sweepNote) process.stderr.write(`${sweepNote}\n`);
  const runTemp = createRunTemp({ root: runTempRoot.dir });
  if (!runTemp.ok) {
    process.stderr.write(`[run-temp] TEMP-NOT-ISOLATED reason=${runTemp.reason} root=${runTemp.root} exit-pending\n`);
  }
  // The ownership registry of this run (LEFTOVER-PROCESS design v2, section 3.1): inside the run
  // temp tree when it is isolated, otherwise under the runtime reports, never in a foreign tree.
  const registryPath = runTemp.ok
    ? path.join(runTemp.dir, 'process-registry.ndjson')
    : path.join(runtimeDir, 'test-reports', `${runId}-registry.ndjson`);
  // The per-file start stamps of the runner (the long-pole pulse, finding 11.99 / R-L2-013.21):
  // the same confinement as the registry; the parent drains the file into the summary before
  // the one-run temp tree settles, so no artifact survives the run.
  const startsPath = runTemp.ok
    ? path.join(runTemp.dir, 'file-starts.ndjson')
    : path.join(runtimeDir, 'test-reports', `${runId}-file-starts.ndjson`);
  const pbEngine = require('./lib/process-boundary.cjs');
  let registryWriteFailed = false;
  try {
    fs.mkdirSync(path.dirname(registryPath), { recursive: true });
    fs.writeFileSync(registryPath, '');
  } catch {
    registryWriteFailed = true;
    process.stderr.write('[boundary] registry=UNVERIFIED reason=registry-create-unavailable\n');
  }

  // C4/C5: exactly one child runner, explicit files started in the resolved
  // order, reporters tap->stdout and json-><runtime file>; canonical mode
  // carries no isolation/selection options.
  const runnerSpec = JSON.stringify(buildRunnerSpec({
    files: selected,
    root,
    concurrency,
    jsonReportPath,
    namePattern: parsed.only,
    registryPath,
    startsPath,
    ...(runTemp.ok ? { runTempDir: runTemp.dir } : {}),
    runId,
  }));
  // TRAIN-PATHS: keep this worktree out of the runner command line.
  const runnerScript = path.relative(root, __filename);
  const childArgs = [runnerScript.startsWith('..') || path.isAbsolute(runnerScript) ? __filename : runnerScript, INTERNAL_RUNNER_ARG];

  const childEnv = {
    ...process.env,
    PROTOCOL_TEST_FAST_CHECKS: '1',
    PROTOCOL_TEST_RUNNER_SPEC: runnerSpec,
    PROTOCOL_TEST_ANCESTRY: JSON.stringify([...ancestry, identity]),
  };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.PROTOCOL_HEAVY_GATE;
  for (const key of Object.keys(childEnv)) if (key.toUpperCase() === 'PROTOCOL_HEAVY_TREE') delete childEnv[key];
  // POSIX: the runner runs detached in its own session and watches its parent (design 3.2).
  if (process.platform !== 'win32') childEnv.PROTOCOL_TEST_DETACHED = '1';
  if (runTemp.ok) {
    // every case variant of the three names is dropped first (a parent "Temp" would coexist with "TEMP" on Windows)
    for (const key of Object.keys(childEnv)) if (/^(temp|tmp|tmpdir)$/i.test(key) && !['TEMP', 'TMP', 'TMPDIR'].includes(key)) delete childEnv[key];
    Object.assign(childEnv, { TEMP: runTemp.dir, TMP: runTemp.dir, TMPDIR: runTemp.dir });
    // The verified helper cache of the read-handle (.ai/bin/lib/read-handle.cjs) defaults to a machine-wide directory under LOCALAPPDATA.
    // Every test child gets one inside the run directory instead (removed with it), unless the caller already stated a value: a test
    // that needs its own keeps it. The product default is unchanged outside this runner. On Windows a case variant of the name counts as stated.
    const cacheNameStated = Object.keys(childEnv).some(key => (process.platform === 'win32' ? key.toUpperCase() : key) === 'READ_HANDLE_CACHE_DIR');
    if (!cacheNameStated) childEnv.READ_HANDLE_CACHE_DIR = path.join(runTemp.dir, 'read-handle-cache');
    // The runner that names the default also creates it: a child then verifies an existing directory and never calls mkdir
    // itself (a fixture-guarded child may not create a directory outside its own fixtures). Best effort: a child that reaches
    // an uncreated default applies the reader's own verify-or-create rules (creation under a fresh temporary name, then rename).
    if (!cacheNameStated) { try { fs.mkdirSync(childEnv.READ_HANDLE_CACHE_DIR, { recursive: true }); } catch { /* the child's reader applies its own rules when it reaches the cache */ } }
  }
  // Failure artifacts need the driver's own boundary/settlement diagnostics,
  // not only the child stderr. These failures can follow a zero-failure TAP
  // summary, and callers may retain only the artifact and the counts.
  const errTail = makeTail();
  const writeRunDiagnostic = message => {
    errTail.push(Buffer.from(message));
    process.stderr.write(message);
  };
  let runTempSettlement = null;
  const settleRunTempOnce = exitCode => {
    if (!runTemp.ok) return (runTempSettlement ||= { action: 'skipped', reason: 'no-run-temp' });
    if (runTempSettlement) return runTempSettlement;
    runTempSettlement = settleRunTemp(runTemp, { failed: exitCode !== 0, keep: process.env.KEEP_FIXTURES === '1' });
    writeRunDiagnostic(`${recordLine(runTempSettlement, exitCode)}\n`);
    return runTempSettlement;
  };
  // An exception between creation and the settlement must not leave the tree behind (a killed process still can; retention
  // is the net for that, and KEEP_FIXTURES=1 is the explicit author exception).
  process.once('exit', () => {
    if (!runTempSettlement) process.stderr.write('[boundary] PROCESS-BOUNDARY-UNVERIFIED reason=abrupt-driver-exit\n');
  });
  // The share belongs to this run's temp tree, never the driver's inherited
  // OS temp. If isolation failed, each file does its work alone. Replace any
  // ambient share so a nested or later run cannot reuse an earlier build.
  const shareDir = runTemp.ok ? makeRunShare(runId, runTemp.dir) : null;
  // Windows keeps the parent's key spelling; scrub every variant even when
  // no new share can be created, so fallback cannot inherit a foreign build.
  for (const key of Object.keys(childEnv)) if (key.toUpperCase() === 'PROTOCOL_TEST_SHARE_DIR') delete childEnv[key];
  if (shareDir) childEnv.PROTOCOL_TEST_SHARE_DIR = shareDir;
  // Process boundary backend: on win32, with a real
  // PowerShell, the runner starts through the Job Object launcher (the job is assigned before any
  // child code runs and is the OS owner that covers supervisor death). Any other shape prints
  // PROCESS_BOUNDARY_UNAVAILABLE and continues: the identity boundary still verifies every run.
  let child = null;
  let jobBackend = null;
  if (process.platform === 'win32') {
    const jobShell = resolveJobShell('powershell.exe');
    if (jobShell) {
        const launcherEnv = { ...childEnv, PROTOCOL_TEST_LAUNCHER_SPEC: JSON.stringify({ node: process.execPath, args: childArgs, parentPid: process.pid, registryPath, runId }) };
        child = spawn(jobShell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
          '-File', path.join(__dirname, 'lib', 'process-launcher.ps1')], {
          cwd: root,
          env: launcherEnv,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        jobBackend = { launcherPid: child.pid };
    } else {
      writeRunDiagnostic('[boundary] PROCESS_BOUNDARY_UNAVAILABLE reason=no-job-shell\n');
    }
  }
  if (!child) {
    child = spawn(process.execPath, childArgs, {
      cwd: root,
      env: childEnv,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
  }
  const outTail = makeTail();
  child.stdout.on('data', chunk => {
    process.stdout.write(chunk);
    outTail.push(chunk);
  });
  child.stderr.on('data', chunk => {
    process.stderr.write(chunk);
    errTail.push(chunk);
  });
  let backendLeftover = false;
  let backendTail = '';
  child.stderr.on('data', chunk => {
    backendTail = (backendTail + String(chunk)).slice(-2048);
    if (/PROCESS-BOUNDARY-(LEFTOVER|UNVERIFIED)/.test(backendTail)) backendLeftover = true;
  });
  let childExited = false;
  let closeResult = { timedOut: false };
  const initialTable = pbEngine.collectProcesses();
  const childIdentity = initialTable && initialTable.find(row => row.pid === child.pid);
  const observedRegistry = childIdentity
    ? [{ runId, pid: childIdentity.pid, created: childIdentity.created, role: 'runner' },
      ...pbEngine.registerFromTable({ table: initialTable, rootPid: childIdentity.pid }).map(row => ({ ...row, runId }))]
    : [];
  const observedIds = new Set(observedRegistry.map(row => `${row.pid}:${row.created}`));
  const rememberRegistry = registry => {
    for (const row of registry?.rows || []) {
      if (row.runId !== runId || !Number.isSafeInteger(row.pid)) continue;
      const key = `${row.pid}:${row.created}`;
      if (!observedIds.has(key)) { observedIds.add(key); observedRegistry.push(row); }
    }
  };
  try { pbEngine.appendRegistry(registryPath, observedRegistry); }
  catch {
    registryWriteFailed = true;
    writeRunDiagnostic('[boundary] registry=UNVERIFIED reason=registry-write-unavailable\n');
  }
  // Signals run the same bounded finalizer (design 3.2): no default termination that would skip
  // the boundary. The handler is attached before the close wait so a signal during the run
  // escalates instead of dying silently.
  let finalizeRun = null;
  const onSignal = async signal => {
    writeRunDiagnostic(`[boundary] PROCESS-BOUNDARY-SIGNAL signal=${signal}\n`);
    try {
      const code = finalizeRun ? await finalizeRun(1) : 1;
      if (heldLock) fs.rmSync(heldLock, { force: true });
      process.exit(code || 1);
    } catch {
      process.exit(1);
    }
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));
  // The close wait is bounded after the child's exit. File-exit markers also catch a grandchild
  // holding an inherited pipe before the runner can exit. Those markers can arrive while the
  // runner still drains file summaries: first-time completed snapshots extend that wait, at most
  // once per selected file. Output and repeated markers never extend it. After the actual child
  // exits, the pipe-close deadline is absolute. A timeout reports and escalates on the registry.
  const closeDeadlineMs = Number(process.env.PROTOCOL_TEST_CLOSE_DEADLINE_MS) > 0
    ? Number(process.env.PROTOCOL_TEST_CLOSE_DEADLINE_MS) : 30000;
  // The one idempotent async finalizer of every exit path (design 3.2): stop the owned processes,
  // confirm their absence, then settle the temp tree. The sync exit hook above stays the last mark
  // for the paths this process cannot take async; supervisor death is covered by the OS owner.
  let finalization = null;
  let processBoundary = null;
  finalizeRun = exitCode => finalization ||= (async () => {
    let exit = exitCode;
    let boundary = { status: 'unverified', reason: 'boundary-not-run', survivors: [], stopped: false };
    let pbLib = null;
    try {
      pbLib = require('./lib/process-boundary.cjs');
      const registry = pbLib.readRegistry(registryPath);
      rememberRegistry(registry);
      if (registry?.rows.some(row => row.degraded)) {
        boundary = { status: 'unverified', reason: 'snapshot-unavailable', survivors: [], stopped: false };
      } else {
        const kill = (pid, stage) => {
          try {
            if (process.platform === 'win32' && stage === 'SIGKILL') {
              const stopped = spawnSync('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, timeout: 5000 });
              return stopped.status === 0 ? 'stopped' : 'denied';
            }
            process.kill(pid, stage);
            return 'stopped';
          } catch (error) {
            if (error && error.code === 'ESRCH') return 'stopped';
            return 'denied';
          }
        };
        const table = pbLib.collectProcesses();
        // A fresh chain is owned only while its root still matches the identity we spawned.
        // If it has exited or its PID was reused, paths/argv cannot establish ownership.
        const rooted = childIdentity && table?.some(row => row.pid === childIdentity.pid && row.created === childIdentity.created)
          ? pbLib.registerFromTable({ table, rootPid: childIdentity.pid }).map(row => ({ ...row, runId })) : [];
        const identities = rows => rows.filter(row => !row.fileExit && !row.fileSettled && (row.role !== 'runner' || !childExited));
        boundary = await pbLib.enforceBoundary({
          runId,
          registry: registry && !registryWriteFailed ? identities(registry.rows) : null,
          fallbackRegistry: identities([...(registry?.rows || []), ...observedRegistry, ...rooted]),
          table,
          collect: () => pbLib.collectProcesses(),
          kill,
          sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        });
      }
    } catch {
      boundary = { status: 'unverified', reason: 'boundary-error', survivors: [], stopped: false };
    }
    const line = pbLib ? pbLib.boundaryLine({ ...boundary, runId })
      : `[boundary] PROCESS-BOUNDARY-${String(boundary.status).toUpperCase()} run=${runId} reason=${boundary.reason}`;
    writeRunDiagnostic(`${line}\n`);
    processBoundary = { status: boundary.status, reason: boundary.reason, survivors: boundary.survivors.length };
    const nonRefusing = boundary.status === 'clean' || boundary.status === 'registry-unverified';
    if (!nonRefusing) exit = exit === 0 ? 1 : exit;
    // A close timeout means the runner (or its pipe holder) is still alive: the driver owns its
    // own spawned child by construction and removes it, with the job, the session or the tree.
    if (!childExited) {
      try {
          if (process.platform !== 'win32' && childIdentity) {
            const fresh = pbEngine.collectProcesses();
            if (fresh?.some(row => row.pid === childIdentity.pid && row.created === childIdentity.created)) process.kill(-child.pid, 'SIGKILL');
          }
      } catch { /* fall through to the direct signal */ }
      try {
        if (process.platform === 'win32' && childIdentity) {
          const fresh = pbEngine.collectProcesses();
          if (fresh && fresh.some(row => row.pid === childIdentity.pid && row.created === childIdentity.created))
            spawnSync('taskkill', ['/PID', String(child.pid), '/F'], { windowsHide: true, timeout: 5000 });
        }
        else if (process.platform !== 'win32' && childIdentity) {
          const fresh = pbEngine.collectProcesses();
          if (fresh?.some(row => row.pid === childIdentity.pid && row.created === childIdentity.created)) process.kill(child.pid, 'SIGKILL');
        }
      } catch { /* the confirmation below decides */ }
      const gone = await new Promise(resolve => {
        const deadline = Date.now() + 3000;
        const tick = () => { if (childExited || Date.now() > deadline) resolve(childExited); else setTimeout(tick, 100); };
        tick();
      });
      if (!gone) {
        writeRunDiagnostic(`[boundary] PROCESS-BOUNDARY-UNVERIFIED reason=stuck-child pid=${child.pid}\n`);
        exit = exit === 0 ? 1 : exit;
      }
    }
    // Stop, confirm, then settle (design 3.2): KEEP_FIXTURES keeps the directory, never a process.
    const settlement = childExited && (nonRefusing || (boundary.status === 'leftover' && boundary.stopped))
      ? settleRunTempOnce(exit) : { action: 'refused', reason: 'process-boundary-unverified' };
    if (settlement && ['failed', 'refused'].includes(settlement.action)) {
      writeRunDiagnostic(`TEST-PROTOCOL-TEMP-SETTLE: ${settlement.action} reason=${settlement.reason}\n`);
      exit = exit === 0 ? 1 : exit;
    }
    return exit;
  })();

  closeResult = await new Promise(resolve => {
    let timer = null;
    const expectedFiles = new Set(selected.map(name => path.join(root, name)));
    const settledFiles = new Set();
    const armDeadline = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { clearInterval(poll); resolve({ timedOut: true }); }, closeDeadlineMs);
    };
    const poll = setInterval(() => {
      const registry = pbEngine.readRegistry(registryPath);
      rememberRegistry(registry);
      if (childExited || !registry) return;
      const progress = observeFileProgress(registry.rows, runId, expectedFiles, settledFiles);
      // Only first-time completion of a selected file can extend this wait:
      // at most N extensions, never arbitrary output or repeated markers.
      // Once the actual child exits, its pipe-close deadline is absolute.
      if (progress.allExited && (!timer || progress.advanced)) armDeadline();
    }, 250);
    child.once('exit', () => {
      childExited = true;
      armDeadline();
    });
    child.once('close', (code, signal) => {
      clearInterval(poll);
      if (timer) clearTimeout(timer);
      resolve({ code, signal, timedOut: false });
    });
    child.once('error', () => {
      clearInterval(poll);
      if (timer) clearTimeout(timer);
      resolve({ code: 1, signal: null, timedOut: false });
    });
  });
  if (closeResult.timedOut) writeRunDiagnostic(`[boundary] PROCESS-BOUNDARY-CLOSE-TIMEOUT wait=${closeDeadlineMs}ms pid=${child.pid}\n`);
  // Flaky-test quarantine: a child that failed only by quarantined test failures (the row's test and signature, an
  // active term, a file the change under test did not touch, a complete report) counts as green; every failure stays
  // counted, printed and recorded. The leak guard and the process boundary below still apply on top.
  const quarantine = (() => {
    // Off (the product's own test gate) or unavailable: nothing is classified and the summary records no failure list.
    if (process.env.PROTOCOL_TEST_QUARANTINE === 'off') return { state: 'off', lowered: false, failures: null };
    // A green child has nothing to cover: the register is not read.
    if (closeResult.code === 0) return { state: 'not-needed', lowered: false, failures: [] };
    let q;
    try { q = require('./lib/flake-quarantine.cjs'); } catch { return { state: 'unavailable', lowered: false, failures: null }; }
    let events = [];
    try {
      events = fs.readFileSync(jsonReportPath, 'utf8').split(/\r?\n/).filter(Boolean)
        .map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    } catch { events = []; }
    const register = q.read(root);
    const base = q.baseRef(root, [process.env.PROTOCOL_TEST_QUARANTINE_BASE, affected ? affected.base : null]);
    const changed = register.rows.length ? q.changedFiles(root, base) : null;
    const decision = q.decideRun({ events, root, register, nowMs: Date.now(), changed });
    decision.lowered = decision.lowered && closeResult.code === 1 && !closeResult.signal && !closeResult.timedOut && !backendLeftover;
    if (decision.failures.length) for (const line of q.runLines(decision, register, base, os.hostname())) writeRunDiagnostic(`${line}\n`);
    return { state: register.state, base, rows: register.rows.length, lowered: decision.lowered, complete: decision.complete,
      covered: decision.covered, red: decision.red, failures: decision.failures.map(q.summaryRecord) };
  })();
  const childExit = backendLeftover && closeResult.code === 0 ? 1 : quarantine.lowered ? 0 : closeResult.code ?? 1;
  if (childExit !== 0) writeRunDiagnostic(`TEST-PROTOCOL-CHILD-EXIT: code=${closeResult.code ?? 'none'} signal=${closeResult.signal ?? 'none'} timeout=${closeResult.timedOut} backendFailure=${backendLeftover}\n`);

  // Leak guard end: a tracked delta is a hard failure with the diff printed.
  let finalExit = childExit;
  const porcelainEnd = gitOutput(root, ['status', '--porcelain', '--untracked-files=no']);
  if (porcelainStart !== null && porcelainEnd !== null &&
      porcelainEnd.trim() !== porcelainStart.trim()) {
    writeRunDiagnostic('TEST-PROTOCOL-LEAK-DETECTED: the run changed tracked files\n');
    for (const line of porcelainEnd.trim().split(/\r?\n/)) {
      if (line.trim() && !porcelainStart.includes(line)) writeRunDiagnostic(`  ${line}\n`);
    }
    finalExit = 1;
  }

  // The per-file start stamps of the runner (finding 11.99): drain them before the process
  // boundary settles the one-run temp tree; a missing or malformed stamp keeps the offset
  // unproven (startMs null in the summary), never guessed.
  const startOffsets = new Map();
  try {
    const rawStamps = fs.readFileSync(startsPath, 'utf8');
    for (const line of rawStamps.split(/\r?\n/)) {
      if (!line.trim()) continue;
      const stamp = JSON.parse(line);
      if (stamp && typeof stamp.file === 'string' && Number.isFinite(stamp.at) && stamp.at >= startMs) {
        startOffsets.set(path.resolve(stamp.file), Math.round(stamp.at - startMs));
      }
    }
  } catch {
    // No stamps (or the runner never started): every file reports startMs null.
    startOffsets.clear();
  }

  // The exit code of the run is known here (child exit plus the leak guard): the process boundary
  // runs now - stop the owned processes, confirm their absence, then settle the one-run temp tree,
  // on success and on failure alike (KEEP_FIXTURES=1 is the explicit author exception, named in the
  // record line). A blocking boundary or a refused settle flips the exit code; registry loss alone
  // is named and recorded without refusal when no known survivor was observed.
  finalExit = await finalizeRun(finalExit);

  // Counts: JSON report primary, TAP fallback (7.1); advisory only.
  const report = parseReport(jsonReportPath) ||
    parseTap(outTail.text().replace(/\[REDACTED\]/g, 'REDACTED')) || { counts: null, files: new Map() };
  const counts = report.counts || null;
  const files = summaryFiles(root, selected, report, finalExit, startOffsets)
    .map(file => (quarantine.lowered && file.status === 'fail' ? { ...file, quarantined: true } : file));

  // Section 7.2: the summary; a write failure warns and never flips a green.
  const wallSeconds = Math.round((Date.now() - startMs) / 100) / 10;
  const summary = {
    schemaVersion: SUMMARY_SCHEMA_VERSION,
    runId,
    mode: diagnostic ? 'diagnostic' : 'full',
    selection: selectionText,
    ...(affected ? { affected } : {}),
    order,
    orderSource,
    exit: finalExit,
    wallSeconds,
    concurrency,
    nodeVersion: process.version,
    head,
    dirty,
    counts,
    skippedTests: (report.skippedTests || []).map(row => ({ ...row,
      file: row.file ? path.relative(root, row.file).replace(/\\/g, '/') : null,
    })),
    processBoundary,
    files,
    host: os.hostname(),
    failures: quarantine.failures,
    quarantine: { state: quarantine.state, base: quarantine.base ?? null, rows: quarantine.rows ?? 0, lowered: quarantine.lowered,
      covered: quarantine.covered ?? 0, red: quarantine.red ?? 0 },
    env: { powershell, fastChecks: true },
  };
  const summaryPath = path.join(runtimeDir, 'test-summaries/run-summary.json');
  let summaryText = null;
  try {
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    summaryText = `${JSON.stringify(summary, null, 2)}\n`;
    fs.writeFileSync(summaryPath, summaryText);
  } catch (error) {
    process.stderr.write(`TEST-PROTOCOL-SUMMARY-UNWRITABLE: ${error.message}\n`);
  }

  // Section 7.4: failure artifacts, secret-scanned, bounded retention.
  if (finalExit !== 0) {
    const failureDir = path.join(runtimeDir, 'test-failures', runId);
    try {
      fs.mkdirSync(failureDir, { recursive: true });
      fs.writeFileSync(path.join(failureDir, 'stdout.tail'), outTail.text());
      fs.writeFileSync(path.join(failureDir, 'stderr.tail'), errTail.text());
      fs.writeFileSync(path.join(failureDir, 'command'),
        redact([process.execPath, ...childArgs, runnerSpec].join(' ')));
      fs.writeFileSync(path.join(failureDir, 'summary'), summaryText || 'summary unavailable');
      pruneFailures(path.join(runtimeDir, 'test-failures'));
    } catch {
      // Artifacts are best-effort; they never change the exit code.
    }
  }

  // Section 7.3: one timing line per full run only.
  if (!diagnostic) {
    try {
      const fileSeconds = {};
      const fileStarts = {};
      for (const file of files) {
        fileSeconds[file.name] = file.seconds;
        // The long-pole pulse (finding 11.99) reads the start offsets from this line:
        // a file without a stamp is omitted here and reported serial unknown by the reader.
        if (Number.isSafeInteger(file.startMs) && file.startMs >= 0) fileStarts[file.name] = file.startMs;
      }
      fs.mkdirSync(runtimeDir, { recursive: true });
      fs.appendFileSync(path.join(runtimeDir, 'test-timing.jsonl'),
        `${JSON.stringify({
          ts: new Date().toISOString(),
          runId,
          inventoryHash: inventoryHash(root, discovered),
          node: process.version,
          cpu: os.cpus().length,
          conc: concurrency,
          order,
          orderSource,
          files: fileSeconds,
          starts: fileStarts,
        })}\n`);
    } catch {
      // Timing history is advisory; never change the exit code for it.
    }
  }

  if (heldLock) fs.rmSync(heldLock, { force: true });
  return finalExit;
}

const RUN_SHARE_PREFIX = 'protocol-run-share-';
const RUN_SHARE_MARKER = '.run-share.json';

// The share directory lives inside the fresh run temp, whose owner settles it
// even if marker creation fails. Best-effort: every file can also work alone.
function makeRunShare(runId, runTempDir) {
  try {
    const dir = fs.mkdtempSync(path.join(runTempDir, RUN_SHARE_PREFIX));
    fs.writeFileSync(path.join(dir, RUN_SHARE_MARKER),
      `${JSON.stringify({ schema: 'run-share/1', runId, pid: process.pid })}\n`);
    return dir;
  } catch {
    return null;
  }
}

// Publish before main: the affected selector reads this driver's inventory
// while main is on the stack, including when invoked directly as a CLI.
module.exports = jsonReporter;
module.exports.parseArgs = parseArgs;
module.exports.parseReport = parseReport;
module.exports.parseTap = parseTap;
module.exports.summaryFiles = summaryFiles;
module.exports.discoverTestFiles = discoverTestFiles;
module.exports.discoverTestInventory = discoverTestInventory;
module.exports.resolveOrder = resolveOrder;
module.exports.buildRunnerSpec = buildRunnerSpec;
module.exports.observeFileProgress = observeFileProgress;
module.exports.selectTierFiles = selectTierFiles;
module.exports.testTierMetadata = testTierMetadata;
module.exports.operatorGrantRefusal = operatorGrantRefusal;
module.exports.heavySelectionRefusal = heavySelectionRefusal;
module.exports.HEAVY_SELECTION_FILE_CAP = HEAVY_SELECTION_FILE_CAP;
// Exported so the precert regression checks the Evidence parser against the driver's actual refusal code.
module.exports.HEAVY_OPERATOR_EXIT = HEAVY_OPERATOR_EXIT;
module.exports.SUMMARY_SCHEMA_VERSION = SUMMARY_SCHEMA_VERSION;

// TRAIN-PATHS: the internal runner publishes its identity before any work: a pointer file in the
// heavy-run registry (under the work root) attributes this process line to its tree, because the
// closed argv contract keeps the worktree path out of the line itself. The publication is atomic
// and owned by this process: the pointer is removed at exit, and a leaked pointer of a dead pid is
// stale and ignored. A pointer that cannot be published fails the run before any test runs: an
// unattributable heavy run would refuse every other tree's gate (PROTO-DEC-0249 item 3).
function registerRun(tree, deps = {}) {
  let gate;
  let config;
  try {
    gate = require('./ops-tools/heavy-gate.cjs');
    config = require('./ops-tools/lib/config.cjs');
  } catch (error) {
    return { error: `the run registry is unavailable (${error.code || error.message})` };
  }
  let dir;
  try { dir = (deps.load || config.load)({ root: tree, env: process.env }).heavy.runsDir; }
  catch (error) { return { error: `the run registry is unavailable (${error.code || error.message})` }; }
  let pointer;
  try {
    const started = (deps.creationTime || gate.systemProbes().creationTime)(process.pid);
    if (!Number.isSafeInteger(started) || started <= 0) throw new Error('process start is unverified');
    pointer = gate.writePointer(dir, process.pid, { tree, started, kind: 'runner' });
  }
  catch (error) { return { error: `the run registry is unwritable (${error.code || error.message})` }; }
  const cleanup = () => { try { fs.unlinkSync(pointer); } catch { /* leaked: the pid is dead, the pointer is stale and ignored */ } };
  (deps.onExit || (fn => process.once('exit', fn)))(cleanup);
  return { dir, cleanup };
}
module.exports.registerRun = registerRun;

if (require.main === module && process.argv.length === 3 && process.argv[2] === INTERNAL_RUNNER_ARG) {
  // Runner mode: leave the exit to natural process end so stdout flushes.
  let spec = null;
  try {
    spec = JSON.parse(process.env.PROTOCOL_TEST_RUNNER_SPEC);
  } catch {
    // Handled below.
  }
  let valid = false;
  try {
    valid = spec && typeof spec.root === 'string' && path.isAbsolute(spec.root) &&
      rootIdentity(spec.root) === rootIdentity(process.cwd()) &&
      driverAncestry().at(-1) === rootIdentity(spec.root) &&
      Array.isArray(spec.files) && spec.files.length > 0 && spec.files.every(file =>
        typeof file === 'string' && path.isAbsolute(file) && isUnder(rootIdentity(spec.root), rootIdentity(file))) &&
      Number.isInteger(spec.concurrency) && spec.concurrency >= 1 && spec.concurrency <= 8 &&
      typeof spec.jsonReportPath === 'string' &&
      (spec.registryPath === undefined || (typeof spec.registryPath === 'string' && path.isAbsolute(spec.registryPath))) &&
      (spec.runTempDir === undefined || (typeof spec.runTempDir === 'string' && path.isAbsolute(spec.runTempDir))) &&
      (spec.runId === undefined || typeof spec.runId === 'string');
  } catch { /* malformed or foreign-root control messages fail before execution */ }
  if (!valid) {
    process.stderr.write('TEST-PROTOCOL-RUNNER-SPEC: invalid or foreign-root runner spec; no tests ran\n');
    process.exitCode = 1;
  } else if (seatEnvironment(process.env) && spec.files.length > HEAVY_SELECTION_FILE_CAP) {
    // A manually supplied internal spec must not bypass the broad-seat gate.
    process.stderr.write(`${HEAVY_OPERATOR_REFUSAL}\n`);
    process.exitCode = HEAVY_OPERATOR_EXIT;
  } else {
    const registry = registerRun(spec.root);
    if (registry.error) {
      process.stderr.write(`TEST-PROTOCOL-RUN-REGISTRY: ${registry.error}; no tests ran\n`);
      process.exitCode = 2;
    } else {
      runSpec(spec).then(code => { process.exitCode = code; }).catch(error => {
        process.stderr.write(`test runner failed: ${error && error.stack ? error.stack : error}\n`);
        process.exitCode = 1;
      });
    }
  }
} else if (require.main === module) {
  // An ambient spec never selects runner mode or overrides CLI --root.
  delete process.env.PROTOCOL_TEST_RUNNER_SPEC;
  main().then(code => process.exit(code)).catch(error => {
    process.stderr.write(`test driver failed: ${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });
}

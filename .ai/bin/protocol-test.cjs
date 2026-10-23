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
//   [--list] [--file <substr>] [--only <substr>]
//   [--rerun-failed <file>] [--clear-lock]
//   [--affected <baseRef>] (cannot combine with narrower selection flags)
// Unknown or invalid arguments fail TEST-PROTOCOL-USAGE, exit 1.
//
// Node >= 22 (TEST-PROTOCOL-NODE-OLD). PROTOCOL_TEST_FAKE_NODE_VERSION is a
// test-only override of the version the gate reads. PROTOCOL_TEST_POWERSHELL
// must be non-empty (TEST-PROTOCOL-ENV-POWERSHELL); the child env overlays
// PROTOCOL_TEST_FAST_CHECKS=1 and strips NODE_TEST_CONTEXT, because a
// node:test file-child context silently breaks any grandchild runner that
// inherits it. Any selection flag makes the run DIAGNOSTIC: loud selection
// line plus [DIAGNOSTIC-NOT-EVIDENCE]; never record or CI it.
//
// Writes only OS temp and <root>/.ai/runtime/:
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
      if (value === null) return usage('--file needs a substring');
      parsed.file = value;
    } else if (argument === '--only') {
      const value = nextValue(args);
      if (value === null) return usage('--only needs a substring');
      parsed.only = value;
    } else if (argument === '--rerun-failed') {
      const value = nextValue(args);
      if (value === null) return usage('--rerun-failed needs a summary path');
      parsed.rerunFailed = value;
    } else if (argument === '--affected') {
      const value = nextValue(args);
      if (value === null || value.startsWith('--')) return usage('--affected needs a base commit ref');
      parsed.affected = value;
    } else if (argument === '--clear-lock') {
      parsed.clearLock = true;
    } else {
      return usage(`unknown argument: ${argument}`);
    }
  }
  if (parsed.clearLock && (parsed.list || parsed.json !== null || parsed.conc !== null ||
      parsed.order !== 'sorted' || parsed.file !== null || parsed.only !== null ||
      parsed.rerunFailed !== null || parsed.affected !== null)) {
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
    const ordered = options.seed.files.filter(name => names.includes(name));
    const rest = sorted.filter(name => !ordered.includes(name));
    return { files: [...ordered, ...rest], orderSource: 'seed' };
  }
  return { files: sorted, orderSource: 'sorted' };
}

// The runner spec: the files in the order they must start, as absolute paths.
// Canonical mode carries no name pattern and no isolation flags.
function buildRunnerSpec(options) {
  const spec = {
    files: options.files.map(name => path.join(options.root, name)),
    root: options.root,
    concurrency: options.concurrency,
    jsonReportPath: options.jsonReportPath,
  };
  if (options.namePattern) spec.namePattern = options.namePattern;
  return spec;
}

// The JSON reporter used by the child runner: one JSON event per line to the
// destination the driver chose.
async function* jsonReporter(source) {
  for await (const event of source) {
    yield `${JSON.stringify(event)}\n`;
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
  });
  stream.on('end', () => {
    tapIn.end();
    jsonIn.end();
  });
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
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Impure support.

function gitOutput(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
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
    const values = runs
      .map(files => Number(files[name]))
      .filter(value => Number.isFinite(value) && value >= 0);
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

// Parse the child JSON report (NDJSON events) into counts and per-file data.
function parseReport(reportPath) {
  let raw;
  try {
    raw = fs.readFileSync(reportPath, 'utf8');
  } catch {
    return null;
  }
  let finalSummary = null;
  const files = new Map();
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
    // File-level completions: the event name is the test file itself
    // (relative or absolute); per-test events also carry data.file, so the
    // nesting and the name shape are the discriminator.
    if (event.type === 'test:complete' && event.data && event.data.nesting === 0 &&
        typeof event.data.file === 'string' && /\.test\.cjs$/.test(event.data.file) &&
        /\.test\.cjs$/.test(String(event.data.name || ''))) {
      const details = event.data.details || {};
      files.set(path.resolve(event.data.file), {
        passed: details.passed === true,
        seconds: Number(details.duration_ms) / 1000 || 0,
      });
    }
  }
  if (!finalSummary && files.size === 0) return null;
  const counts = finalSummary && finalSummary.counts ? {
    total: Number(finalSummary.counts.tests) || 0,
    pass: Number(finalSummary.counts.passed) || 0,
    fail: Number(finalSummary.counts.failed) || 0,
    skip: Number(finalSummary.counts.skipped) || 0,
  } : null;
  return { counts, files };
}

// TAP parse from the forwarded stream (the fallback).
function parseTap(stdout) {
  const counts = { total: 0, pass: 0, fail: 0, skip: 0 };
  const files = new Map();
  for (const match of stdout.matchAll(/^(ok|not ok) \d+ - (\S.*\.test\.cjs)\s*$/gm)) {
    files.set(match[2].replace(/\\/g, '/'), { passed: match[1] === 'ok', seconds: 0 });
  }
  const number = pattern => {
    const found = pattern.exec(stdout);
    return found ? Number(found[1]) || 0 : 0;
  }
  ;
  counts.total = number(/^# tests (\d+)$/m);
  counts.pass = number(/^# pass (\d+)$/m);
  counts.fail = number(/^# fail (\d+)$/m);
  counts.skip = number(/^# skipped (\d+)$/m);
  if (counts.total === 0 && files.size === 0) return null;
  return { counts, files };
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
  let selected = [...discovered];
  let affected = null;
  if (parsed.affected !== null) {
    try {
      affected = require('./protocol-affected.cjs').selectAffected(root, parsed.affected);
    } catch (error) {
      return namedFailure('TEST-PROTOCOL-AFFECTED-UNKNOWN', `${error.message}; no tests ran; landing train must run FULL suite`);
    }
    selected = affected.executionFiles;
    if (affected.fallback && JSON.stringify([...selected].sort()) !== JSON.stringify([...discovered].sort())) {
      return namedFailure('TEST-PROTOCOL-AFFECTED-UNKNOWN', 'FULL fallback inventory differs from full driver; no tests ran');
    }
    process.stderr.write(`affected base: ${affected.base}; changed=${affected.changed.length}; selected=${affected.files.length}/${affected.total}; execution entries=${selected.length}/${discovered.length}\n`);
    for (const reason of affected.unknown) process.stderr.write(`affected uncertainty: ${reason}\n`);
    for (const file of affected.files) process.stderr.write(`affected ${file.name}: ${file.reasons.join('; ')}\n`);
    if (affected.fallback) process.stderr.write('affected FULL fallback: impact cannot be mapped with certainty\n');
  }
  const diagnostic = Boolean(parsed.file || parsed.only || parsed.rerunFailed || (affected && !affected.fallback));
  if (parsed.rerunFailed) {
    const failed = readFailedFromSummary(path.resolve(parsed.rerunFailed));
    if (failed === null) {
      return usageFailure(`--rerun-failed: cannot read a summary at ${parsed.rerunFailed}`);
    }
    const failedSet = new Set(failed);
    selected = selected.filter(name => failedSet.has(name));
  }
  if (parsed.file) {
    selected = selected.filter(name => name.includes(parsed.file));
  }
  if (selected.length === 0) {
    return namedFailure('TEST-PROTOCOL-NO-TESTS', 'the selection matches no test file');
  }

  // C8: --list prints the sorted selection without executing, locking or env.
  if (parsed.list) {
    process.stdout.write(`${[...selected].sort().join('\n')}\n`);
    return 0;
  }

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
  if (parsed.file) selectionParts.push(`--file ${parsed.file}`);
  if (parsed.only) selectionParts.push(`--only ${parsed.only}`);
  if (parsed.rerunFailed) selectionParts.push(`--rerun-failed ${parsed.rerunFailed}`);
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

  // C4/C5: exactly one child runner, explicit files started in the resolved
  // order, reporters tap->stdout and json-><runtime file>; canonical mode
  // carries no isolation/selection options.
  const runnerSpec = JSON.stringify(buildRunnerSpec({
    files: selected,
    root,
    concurrency,
    jsonReportPath,
    namePattern: parsed.only,
  }));
  const childArgs = [__filename, INTERNAL_RUNNER_ARG];

  const childEnv = {
    ...process.env,
    PROTOCOL_TEST_FAST_CHECKS: '1',
    PROTOCOL_TEST_RUNNER_SPEC: runnerSpec,
    PROTOCOL_TEST_ANCESTRY: JSON.stringify([...ancestry, identity]),
  };
  delete childEnv.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, childArgs, {
    cwd: root,
    env: childEnv,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const outTail = makeTail();
  const errTail = makeTail();
  child.stdout.on('data', chunk => {
    process.stdout.write(chunk);
    outTail.push(chunk);
  });
  child.stderr.on('data', chunk => {
    process.stderr.write(chunk);
    errTail.push(chunk);
  });
  const childResult = await new Promise(resolve => {
    child.on('close', (code, signal) => resolve({ code, signal }));
  });
  const childExit = childResult.code === null || childResult.code === undefined ? 1 : childResult.code;

  // Leak guard end: a tracked delta is a hard failure with the diff printed.
  let finalExit = childExit;
  const porcelainEnd = gitOutput(root, ['status', '--porcelain', '--untracked-files=no']);
  if (porcelainStart !== null && porcelainEnd !== null &&
      porcelainEnd.trim() !== porcelainStart.trim()) {
    process.stderr.write('TEST-PROTOCOL-LEAK-DETECTED: the run changed tracked files\n');
    for (const line of porcelainEnd.trim().split(/\r?\n/)) {
      if (line.trim() && !porcelainStart.includes(line)) process.stderr.write(`  ${line}\n`);
    }
    finalExit = 1;
  }

  // Counts: JSON report primary, TAP fallback (7.1); advisory only.
  const report = parseReport(jsonReportPath) ||
    parseTap(outTail.text().replace(/\[REDACTED\]/g, 'REDACTED')) || { counts: null, files: new Map() };
  const counts = report.counts || { total: 0, pass: 0, fail: 0, skip: 0 };
  const files = selected.map(name => {
    const entry = report.files.get(path.join(root, name)) ||
      report.files.get(name.replace(/\//g, path.sep));
    return {
      name,
      status: entry ? (entry.passed ? 'pass' : 'fail') : (finalExit === 0 ? 'pass' : 'fail'),
      seconds: entry ? Math.round(entry.seconds * 1000) / 1000 : 0,
    };
  });

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
    files,
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
      for (const file of files) fileSeconds[file.name] = file.seconds;
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
        })}\n`);
    } catch {
      // Timing history is advisory; never change the exit code for it.
    }
  }

  if (heldLock) fs.rmSync(heldLock, { force: true });
  return finalExit;
}

// Publish before main: the affected selector reads this driver's inventory
// while main is on the stack, including when invoked directly as a CLI.
module.exports = jsonReporter;
module.exports.parseArgs = parseArgs;
module.exports.discoverTestFiles = discoverTestFiles;
module.exports.discoverTestInventory = discoverTestInventory;
module.exports.resolveOrder = resolveOrder;
module.exports.buildRunnerSpec = buildRunnerSpec;
module.exports.SUMMARY_SCHEMA_VERSION = SUMMARY_SCHEMA_VERSION;

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
      typeof spec.jsonReportPath === 'string';
  } catch { /* malformed or foreign-root control messages fail before execution */ }
  if (!valid) {
    process.stderr.write('TEST-PROTOCOL-RUNNER-SPEC: invalid or foreign-root runner spec; no tests ran\n');
    process.exitCode = 1;
  } else {
    runSpec(spec).then(code => { process.exitCode = code; }).catch(error => {
      process.stderr.write(`test runner failed: ${error && error.stack ? error.stack : error}\n`);
      process.exitCode = 1;
    });
  }
} else if (require.main === module) {
  // An ambient spec never selects runner mode or overrides CLI --root.
  delete process.env.PROTOCOL_TEST_RUNNER_SPEC;
  main().then(code => process.exit(code)).catch(error => {
    process.stderr.write(`test driver failed: ${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });
}

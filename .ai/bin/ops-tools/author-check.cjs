'use strict';
// Author check: affected tests, the short common set and triggered heavy tests in ONE driver
// run, plus the validator, with a receipt bound to the commit and the tree. The full suite
// stays in the landing train. Selection is author-select at depth 1; the driver is the
// repository driver, never a bare `node --test` (the driver strips NODE_TEST_CONTEXT and
// sets the fast-check switch the tests expect).
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const select = require('./author-select.cjs');
const { load, readJson } = require('./lib/config.cjs');
const receipt = require('./lib/receipt.cjs');
const { secretIn } = require('../lib/secrets.cjs');
const heavyChecks = require('./lib/heavy-checks.cjs');
const sharedDocs = require('./lib/shared-docs.cjs');
const productEarly = require('./product-gate-early.cjs');

const SUMMARY = /^(?:# (?:tests|pass|fail|skipped)|not ok )/;
const ATTEMPT_PREFIX = 'author-check-';
const plain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function gitRunner(root, run, env = process.env) {
  const spawn = run || ((file, args, opts) => spawnSync(file, args, opts));
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) if (key.toUpperCase() === 'PROTOCOL_HEAVY_TREE') delete childEnv[key];
  // TRAIN-PATHS: the tree root travels as the cwd, never as a -C argument, so a git line of this
  // check names no worktree path.
  return args => {
    const r = spawn('git', args, { cwd: root, env: childEnv, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw Object.assign(new Error(`AUTHOR-CHECK-GIT: git ${args[0]} failed`), { code: 'AUTHOR-CHECK-GIT' });
    return args[0] === 'status' ? (r.stdout || '') : (r.stdout || '').trim();
  };
}
const safe = (git, args) => { try { return git(args); } catch { return ''; } };

function ownerTable(root, driverFiles) {
  const file = path.join(root, 'docs/ops/suite-timing.json');
  let owners = new Map();
  try {
    const timing = JSON.parse(fs.readFileSync(file, 'utf8'));
    owners = new Map((timing.files || []).filter(row => plain(row) && row.owner).map(row => [row.name, row.owner]));
  } catch { /* no declarations: derive from the live driver graph */ }
  return driverFiles ? select.deriveOwners(root, driverFiles, owners) : owners;
}

// The exact same mapping is available to inventory audits without executing
// the check, its heavy gate, the validator or any selected test.
function mapDriverFiles(files, driverFiles, owners) {
  const unmapped = [];
  const mapped = files.map(file => driverFiles.has(file) ? file :
    driverFiles.has(owners.get(file)) ? owners.get(file) : (unmapped.push(file), null));
  return { files: [...new Set(mapped.filter(Boolean))], unmapped };
}

// R-L2-013.22: every red product file needs its own named gate diagnosis.
// SUMMARY keeps only the unindented TAP lines, so a red real-product test reached the farm
// receipts naming the failing file but not the failing product gates, and the red was then
// classified without a diagnosis. The assertion messages of the red tests sit in the indented
// `error:` scalars of the TAP stream; the shared helper that renders the real-product diagnosis
// of the source repository carries a `failing gates: ` line followed by the
// value-safe findings (the gates themselves withhold the values). The receipt keeps those
// blocks, bounded and secret-redacted, and the gate-line contract is that one literal: no other
// first-class is parsed, no product code is imported here.
const GATE_MARKER = 'failing gates: ';
const PRODUCT_REAL = /^product-real[a-z0-9.-]*\.test\.cjs$/;
const DETAIL_BLOCKS = 40;
const DETAIL_LINES = 64;
const DETAIL_LINE_CHARS = 300;
// Closed producer vocabulary: unknown names require a contract review, never classification.
const PRODUCT_GATES = new Set(['a-forbidden', 'b-secrets', 'c-personal', 'd-encoding', 'e-size',
  'f-installability', 'g-orientation', 'h-determinism', 'i-history', 'j-product-tests']);
function gateNames(line) {
  if (!line.startsWith(GATE_MARKER)) return [];
  const names = line.slice(GATE_MARKER.length).split(',').map(name => name.trim());
  return names.length && names.every(name => PRODUCT_GATES.has(name)) ? names : [];
}

// The TAP failure blocks whose error scalar carries the gate-line contract. The error belongs
// to the `not ok` line seen last (children complete before the parent line), a secret is
// redacted before the cap (never the cap before the scan), and blocks without the contract
// never enter the receipt at all, so a suite red of hundreds of ordinary failures adds nothing.
function failureDetails(rawOutput) {
  const entries = [];
  const redact = text => {
    const line = String(text);
    if (secretIn(line)) return '[REDACTED]';
    // Clipping a contract line could turn a malformed tail into a valid name.
    if (line.startsWith(GATE_MARKER) && line.length > DETAIL_LINE_CHARS) return '[TRUNCATED]';
    return line.slice(0, DETAIL_LINE_CHARS);
  };
  let name = null;
  let file = null;
  let lines = null;
  let errorIndent = null;
  const flush = () => {
    if (name !== null && lines !== null && lines.some(line => line.includes(GATE_MARKER)) && entries.length < DETAIL_BLOCKS) {
      entries.push({ name: redact(name), lines: lines.slice(0, DETAIL_LINES), ...(file ? { file } : {}) });
    }
    name = null; file = null; lines = null; errorIndent = null;
  };
  for (const rawLine of String(rawOutput || '').split(/\r?\n/)) {
    const match = /^(\s*)(.*)$/.exec(rawLine);
    const indent = match[1].length;
    const body = match[2];
    if (/^not ok \d+ - /.test(body)) { flush(); name = body.replace(/^not ok \d+ - /, ''); continue; }
    if (body === '...') { flush(); continue; }
    // Only TAP metadata identifies the file; message text cannot lend a diagnosis
    // to another failed file. Retain a basename, never the location path.
    if (name !== null && lines === null && body.startsWith('location:')) {
      const located = /(?:^|[\\/])([A-Za-z0-9._-]+\.test\.cjs):\d+:\d+['"]?$/.exec(body.slice('location:'.length).trim().replace(/^['"]/, ''));
      if (located) file = located[1];
    }
    const error = /^error:\s*(.*)$/.exec(body);
    if (error && lines === null) {
      const scalar = error[1].trim();
      if (scalar === '' || scalar === '|-' || scalar === '|') { lines = []; errorIndent = indent; }
      else {
        let text = scalar;
        if (text.startsWith('"') && text.endsWith('"')) {
          try { text = JSON.parse(text); } catch { text = ''; }
        } else if (text.startsWith("'") && text.endsWith("'")) text = text.slice(1, -1).replace(/''/g, "'");
        // Scan the complete scalar before interpreting escaped newlines or clipping.
        lines = secretIn(text) ? ['[REDACTED]'] : text.split(/\r?\n|\\n/).slice(0, DETAIL_LINES).map(redact);
        flush();
      }
      continue;
    }
    if (lines !== null && indent > errorIndent) {
      if (lines.length < DETAIL_LINES) lines.push(redact(body));
      continue;
    }
    if (lines !== null && indent <= errorIndent) flush();
  }
  flush();
  return entries;
}

function defaultGate({ root, env, spawn }) {
  // TRAIN-PATHS: the gate is spawned with cwd=root, a script path relative to it and the tree in
  // PROTOCOL_HEAVY_TREE only, so this process line names no worktree path. The env is the one
  // explicit child env of the check, never the ambient one.
  const gateEnv = { ...env, PROTOCOL_HEAVY_TREE: root };
  const r = spawn(process.execPath, ['.ai/bin/ops-tools/heavy-gate.cjs', '--defender', 'warn'], { cwd: root, env: gateEnv, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = String(r.stdout || '').split(/\r?\n/).filter(Boolean);
  return { ok: !r.error && r.status === 0, lines };
}

// DISK-LEAKS dli1 (design L10): ONE attempt directory per check under the shared author-check-tmp, never the shared parent itself as TEMP.
// The check starts by sweeping attempt roots (and suite roots) of EARLIER checks whose process is dead (killed, power loss) and ends by settling its
// own, success or failure, so nothing a check makes outlives it. Removal goes only through .ai/bin/lib/owned-temp.cjs (owner dead, inside the root).
// A host without the helper keeps the old behavior: the shared parent is TEMP.
function openAttempt(parent, env) {
  let helper = null;
  try { helper = require('../lib/run-temp.cjs'); } catch { return { dir: parent, helper: null, run: null, sweep: null }; }
  const sweep = helper.sweepRunTemps({ root: parent, env });
  const line = helper.sweepLine(sweep);
  if (line) process.stderr.write(`${line}\n`);
  const created = helper.createRunTemp({ root: parent, prefix: ATTEMPT_PREFIX });
  return { dir: created.ok ? created.dir : parent, helper, run: created.ok ? created : null, sweep };
}
function settleAttempt(attempt) {
  if (!attempt || !attempt.run) return null;
  return attempt.helper.settleRunTemp(attempt.run, { keep: process.env.KEEP_FIXTURES === '1' });
}

// The Defender state the gate measured. Canonical form (P-L9-002): exactly one line "HEAVY-GATE FACTS node=<version> defender=<state>"
// among the gate's lines, the state one of the four words the gate's probe returns. Anything else (no line, two lines, another
// word, trailing characters) is 'unknown': the receipt never claims a state that was not measured.
const FACTS_LINE = /^HEAVY-GATE FACTS node=v\d+\.\d+\.\d+ defender=(on|off|unreadable|not-applicable)$/;
function defenderFact(gateLines) {
  const found = (gateLines || []).filter(line => typeof line === 'string' && line.startsWith('HEAVY-GATE FACTS'));
  const match = found.length === 1 ? FACTS_LINE.exec(found[0]) : null;
  return match ? match[1] : 'unknown';
}

function run(options = {}) {
  const holder = {};
  try { return runChecks(options, holder); } finally { holder.settled = settleAttempt(holder.attempt); }
}

function runChecks(options, holder) {
  const root = path.resolve(options.root || '.');
  // An inherited operator base can span unrelated trains and shared policies.
  // The caller must choose the reviewed branch base for the seat-safe tier.
  if (options.light && (typeof options.base !== 'string' || !options.base.trim())) {
    return { ok: false, code: 2, light: true, partial: true,
      lines: ['AUTHOR-CHECK LIGHT REFUSED: explicit BASE required; use author-check.cjs ROOT BASE --light'] };
  }
  const inputEnv = options.env || process.env;
  const cfg = options.cfg || load({ root, env: options.env || process.env });
  const author = options.author || cfg.author;
  const base = options.base || author.baseRef;
  const spawn = options.spawn || ((file, args, opts) => spawnSync(file, args, opts));
  const git = options.git || gitRunner(root, spawn, options.env || process.env);
  const now = options.now || (() => Date.now());
  const lines = [];
  const say = text => { lines.push(text); if (options.onLine) options.onLine(text); };
  const sharedWarnings = options.policy ? [] : sharedDocs.authorWarnings(git, base);
  sharedWarnings.forEach(say);

  // This tier is read-only, seat-safe and never writes an author-check receipt.
  if (options.light) {
    const early = (options.productCheck || productEarly.run)({ root, base });
    return { ...early, light: true, lines: [...lines, ...early.lines, 'AUTHOR-CHECK LIGHT: product content only; farm author check pending'] };
  }

  // Route before selection, gate, temp creation or any receipt. A queued job
  // is an admission, never a successful check or a green receipt.
  if (!options.list || options.policy) {
    const route = heavyChecks.route(cfg, inputEnv, options.exists);
    const policy = { mode: cfg.heavyChecks || 'local', farmSubmit: cfg.farmSubmit, ...cfg.heavyPolicy, executor: route.executor || null, refusal: route.refused ? route.lines[0] : null };
    const policyLine = `AUTHOR-CHECK POLICY ${JSON.stringify(policy)}`;
    if (options.policy) return { ok: true, policy, lines: [policyLine] };
    if (route.refused) return { ...route, policy, lines: [...lines, policyLine, ...route.lines] };
    // An injected selection and process runner describe an execution harness,
    // not a real Git repository. Its content provider must be injected too.
    // Real execution and the CLI always run the default content preflight.
    if (!options.selection || !options.spawn || options.productCheck) {
      const early = (options.productCheck || productEarly.run)({ root, base });
      if (!early.ok) return { ...early, policy, lines: [...lines, policyLine, ...early.lines] };
      holder.productEarly = early;
      for (const line of early.lines) say(line);
    }
    if (route.executor === 'farm') {
      const submitted = heavyChecks.submit({ root, cfg, git, spawn, base, env: inputEnv });
      return { ...submitted, policy, lines: [policyLine, ...sharedWarnings, ...(holder.productEarly?.lines || []), ...submitted.lines] };
    }
    say(policyLine);
  }

  // Affected-only runs are switched off unless the one switch of the selector is on: the check then asks for the
  // full plan, every enrolled test, and says so in one line.
  const affectedSwitch = require('../protocol-affected.cjs');
  const full = !options.selection && !affectedSwitch.affectedRunsOn(inputEnv);
  if (full) say(`AUTHOR-CHECK ${affectedSwitch.AFFECTED_OFF}: every enrolled test is selected`);
  const selection = options.selection || select.select({ root, base, depth: author.defaultDepth, author, git, exists: options.exists, readFile: options.readFile, full });
  if (!options.list) say(select.estimateLine(selection));
  const capWarning = select.capLine(selection);
  if (!options.list && capWarning) say(capWarning);
  const partOf = test => { const reason = selection.reasons[test] || ''; return Object.hasOwn(author.heavy || {}, test) ? 'heavy' : reason === 'common' ? 'common' : reason.startsWith('heavy') ? 'heavy' : 'affected'; };
  const groups = { common: [], affected: [], heavy: [] };
  const trainOnly = author.trainOnly || [];
  for (const test of selection.tests) if (!trainOnly.includes(test)) groups[partOf(test)].push(test);

  if (options.list) {
    // Inventory discovery and mapping are read-only. Inspect the complete
    // enrollment as well as this selection; a quiet branch must not hide gaps.
    const driver = require('../protocol-test.cjs');
    const listed = new Set(driver.selectTierFiles(root, true));
    const owners = ownerTable(root, listed);
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'protocol-manifest.json'), 'utf8'));
    const unmapped = mapDriverFiles(selection.tests, listed, owners).unmapped;
    const inventoryUnmapped = mapDriverFiles(manifest.tests, listed, owners).unmapped;
    return { ok: !unmapped.length && !inventoryUnmapped.length, list: true, selection, groups, unmapped, inventoryUnmapped,
      lines: [JSON.stringify({ base, groups, reasons: selection.reasons, estimate: { milliseconds: Number.isFinite(selection.estimateMs) ? selection.estimateMs : null, timedFiles: selection.timedFiles || 0, capWarning }, unmapped, inventoryUnmapped }, null, 2), ...lines] };
  }

  // PROTO-DEC-0249 items 2 and 3 (P-153, P-154): environment facts and at most the configured number of heavy runs at once.
  // The gate waits for a slot; a refusal ends the check before anything is run. Defender is a warning here, not a refusal.
  // TRAIN-PATHS: the one explicit child env of the check (TEMP/TMP, PROTOCOL_TEST_POWERSHELL) is built before the gate call
  // and rides every child with cwd=root, so the spawn lines of this check name no worktree path.
  const parentTemp = options.tempRoot || cfg.tempRoot;
  fs.mkdirSync(parentTemp, { recursive: true });
  holder.attempt = openAttempt(parentTemp, options.env || process.env);
  const tempRoot = holder.attempt.dir;
  const env = { ...(options.env || process.env), TEMP: tempRoot, TMP: tempRoot };
  for (const key of Object.keys(env)) if (['PROTOCOL_HEAVY_TREE', 'PROTOCOL_OPERATOR_HEAVY'].includes(key.toUpperCase())) delete env[key];
  if (!env.PROTOCOL_TEST_POWERSHELL) {
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
    env.PROTOCOL_TEST_POWERSHELL = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }
  const gate = (options.gate || defaultGate)({ root, env, spawn });
  for (const line of gate.lines) say(line);
  if (!gate.ok) {
    say('AUTHOR-CHECK REFUSED by the heavy gate (PROTO-DEC-0249); nothing was run');
    return { ok: false, refused: true, code: 3, selection, groups, lines };
  }

  // The local route verified a positive operator grant before selection or I/O.
  // Preserve that grant for the driver; this starter cannot authorize itself.
  const spawnOptions = { cwd: root, env: { ...env, PROTOCOL_OPERATOR_HEAVY: inputEnv.PROTOCOL_OPERATOR_HEAVY }, encoding: 'utf8', windowsHide: true };
  // TRAIN-PATHS: the driver and the validator are reached through script paths relative to the
  // root they run in; the select summary stays under the neutral temp root (it names no worktree).
  const driverScript = path.relative(root, cfg.driver);
  const validatorScript = path.relative(root, cfg.validator);

  // The selection reaches the driver as a summary whose files are marked failed. A driver
  // that cannot list its own inventory is a red part: an empty listing must never turn into
  // a green receipt with nothing run.
  let listed = spawn(process.execPath, [driverScript, '--root', '.', '--list', '--with-mutations'], { ...spawnOptions, timeout: 300000 });
  const listingFallback = Boolean(listed.error || listed.status !== 0);
  if (listingFallback) {
    say('AUTHOR-CHECK note: mutation inventory unavailable; falling back to --list');
    listed = spawn(process.execPath, [driverScript, '--root', '.', '--list'], { ...spawnOptions, timeout: 300000 });
  }
  const listFailed = Boolean(listed.error) || listed.status !== 0;
  const driverFiles = new Set(String(listed.stdout || '').split(/\r?\n/).filter(Boolean));
  const owners = ownerTable(root, driverFiles);
  const unmapped = [];
  const toDriver = files => {
    const mapped = mapDriverFiles(files, driverFiles, owners);
    unmapped.push(...mapped.unmapped);
    return mapped.files;
  };
  const byPart = Object.fromEntries(['common', 'affected', 'heavy'].map(name => [name, toDriver(groups[name])]));
  const all = [...new Set(Object.values(byPart).flat())];
  const unmappedTests = selection.tests.filter(test => unmapped.includes(test));
  // MD0 freshness runs separately and is outside the main selection groups.
  const coverageSelected = selection.tests.filter(test => !trainOnly.includes(test));
  const coverageLinks = select.coverageLinks(root, coverageSelected, driverFiles, owners);

  const started = now();
  const summaryPath = path.join(tempRoot, `select-${process.pid}.json`);
  fs.writeFileSync(summaryPath, JSON.stringify({ files: all.map(name => ({ name, status: 'fail' })) }));
  const r = all.length
    ? spawn(process.execPath, [driverScript, '--root', '.', '--rerun-failed', summaryPath], { ...spawnOptions, maxBuffer: 512 * 1024 * 1024, timeout: select.CAP_MS })
    : { status: 0, stdout: '', stderr: '' };
  const wallMs = now() - started;
  if (r.error?.code === 'ETIMEDOUT') say(`AUTHOR-CHECK TIMEOUT files=${all.length} minutes=${(wallMs / 60000).toFixed(1)} capMinutes=${select.CAP_MS / 60000} tests=${all.join(',')}`);
  const rawOutput = `${r.stdout || ''}\n${r.stderr || ''}`;
  const output = rawOutput.split(/\r?\n/).filter(line => SUMMARY.test(line));

  let fileStatus = new Map();
  let skippedTests = [];
  let runFileTiming = new Map();
  try {
    const summary = path.join(root, '.ai/runtime/test-summaries/run-summary.json');
    const data = JSON.parse(fs.readFileSync(summary, 'utf8'));
    if (fs.statSync(summary).mtimeMs >= started) {
      fileStatus = new Map((data.files || []).map(row => [row.name, row.status]));
      skippedTests = data.skippedTests || [];
      // The long-pole pulse (finding 11.99 / R-L2-013.21): copy the per-file run results
      // (duration and start offset) out of the one summary the check and the suite runner
      // share, into the receipt - the durable record of this author-check run. Unknown
      // seconds or a start without a stamp stay null (unproven, never zero).
      runFileTiming = new Map((data.files || [])
        .filter(row => plain(row) && typeof row.name === 'string' && row.name.length > 0)
        .map(row => [row.name, {
          seconds: Number.isFinite(row.seconds) && row.seconds >= 0 ? row.seconds : null,
          startMs: Number.isSafeInteger(row.startMs) && row.startMs >= 0 ? row.startMs : null,
        }]));
    }
  } catch { /* no current summary: execution coverage must refuse by name */ }

  const results = {};
  if (holder.productEarly) results.productContent = { exit: 0, partial: true, sourceSha: holder.productEarly.sourceSha || null,
    gates: (holder.productEarly.results || []).map(row => ({ gate: row.gate, ok: row.ok })),
    checked: holder.productEarly.checked || [], deferred: holder.productEarly.deferred || [] };
  const entryFiles = all.filter(file => ['pass', 'fail'].includes(fileStatus.get(file)));
  const coverage = select.accountCoverage(coverageSelected, entryFiles, coverageLinks, unmapped);
  if (!coverage.ok) {
    const files = [...coverage.refused.map(row => row.file), ...coverage.unaccounted];
    results.coverage = { exit: 2, files };
    say(`AUTHOR-CHECK coverage: exit=2 ${files.join(',')}`);
  } else results.coverage = { exit: 0, files: [] };
  const warn = [...sharedWarnings];
  const freshnessStarted = now();
  // A separate driver owns exactly one claim. Never inspect its TAP text to
  // distinguish freshness from another assertion, or consult branch/env names.
  for (const test of trainOnly) {
    const fresh = spawn(process.execPath, [driverScript, '--root', '.', '--file', test],
      { ...spawnOptions, env: { ...spawnOptions.env, PROTOCOL_CONSUMER_FRESHNESS_STRICT: '1' }, timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
    const stale = !fresh.error && fresh.status === 1 && !fresh.signal;
    results[`trainOnly:${test}`] = { exit: stale ? 0 : fresh.error || fresh.signal || !Number.isInteger(fresh.status) ? 2 : fresh.status,
      observedExit: Number.isInteger(fresh.status) ? fresh.status : null, stale };
    if (stale) {
      const warning = 'consumer-index stale (package branch; the landing train regenerates it)';
      warn.push(warning);
      say(`AUTHOR-CHECK warn: ${warning}`);
    }
  }
  const freshnessMs = now() - freshnessStarted;
  if (listFailed) {
    results.list = { exit: 2, error: listed.error ? (listed.error.code || 'spawn error') : `exit ${listed.status}` };
    say(`AUTHOR-CHECK list: exit=2 ${results.list.error}`);
  }
  if (unmappedTests.length) {
    results.unmappedTests = { exit: 2, files: unmappedTests };
    say(`AUTHOR-CHECK unmappedTests: exit=2 ${unmappedTests.slice(0, 5).join(',')}`);
  }
  for (const [name, files] of Object.entries(byPart)) {
    const skippedFiles = files.filter(file => fileStatus.get(file) === 'skip');
    const failed = files.filter(file => fileStatus.get(file) && !['pass', 'skip', 'unknown'].includes(fileStatus.get(file)));
    const unknown = files.filter(file => !fileStatus.has(file) || fileStatus.get(file) === 'unknown');
    const exit = !files.length ? 0 : failed.length ? 1 : unknown.length && r.status !== 0 ? (r.status || 2) : 0;
    results[name] = { files: files.length, exit, failedFiles: failed, skippedFiles,
      passedFiles: files.filter(file => fileStatus.get(file) === 'pass'), unknownFiles: unknown.length };
    say(`AUTHOR-CHECK ${name}: files=${files.length} exit=${exit} skipped=${skippedFiles.length}${failed.length ? ` failed=${failed.slice(0, 5).join(',')}` : ''}`);
  }
  results.run = {
    exit: r.error ? 2 : (r.status === null || r.status === undefined ? 2 : r.status),
    error: r.error ? (r.error.code || 'spawn error') : null,
    wallMs,
    failing: output.filter(line => line.startsWith('not ok')).slice(0, 40),
    tests: output.filter(line => line.startsWith('# tests ')).pop() || null,
    fail: output.filter(line => line.startsWith('# fail ')).pop() || null,
    skipped: output.filter(line => line.startsWith('# skipped ')).pop() || null,
    skippedWithReason: skippedTests.filter(row => typeof row.reason === 'string' && row.reason.trim() && row.reason !== 'unspecified').length,
    skippedTests,
  };
  say(`AUTHOR-CHECK run: files=${all.length} exit=${results.run.exit} ${results.run.fail || ''} ${(wallMs / 60000).toFixed(1)} min`);

  // R-L2-013.22: the red product-real family is named by the
  // per-file statuses, falling back to the kept failing lines when the summary was not
  // current; the receipt carries the failed product gate names and their findings (the gates
  // withhold the values themselves), and a red product-real whose gate names did not arrive
  // marks the whole receipt unclassified, so a gateless red is never read as a load class
  // (R-L2-013.22).
  const family = file => PRODUCT_REAL.test(path.basename(String(file)));
  const failedStatus = status => status && !['pass', 'skip', 'unknown'].includes(status);
  const redProductReal = [];
  const addRed = name => { if (!redProductReal.includes(name)) redProductReal.push(name); };
  for (const [name, status] of fileStatus) if (family(name) && failedStatus(status)) addRed(path.basename(String(name)));
  for (const line of results.run.failing || []) {
    const named = Array.from(line.matchAll(/[A-Za-z0-9._-]+\.test\.cjs/g), match => match[0]).filter(family);
    for (const name of named) addRed(name);
  }
  const gates = [];
  const gateFindings = [];
  const diagnosedFiles = new Set();
  for (const entry of failureDetails(rawOutput)) {
    if (!redProductReal.includes(entry.file)) continue;
    const named = entry.lines.flatMap(gateNames);
    if (!named.length) continue;
    diagnosedFiles.add(entry.file);
    for (const trimmed of named) {
      if (trimmed && !gates.includes(trimmed)) gates.push(trimmed);
    }
    for (const line of entry.lines) {
      if (gateFindings.length < DETAIL_LINES) gateFindings.push(line);
    }
  }
  const unclassifiedGateless = redProductReal.some(file => !diagnosedFiles.has(file));
  results.productGates = { exit: unclassifiedGateless ? 2 : redProductReal.length ? 1 : 0, red: redProductReal, gates, findings: gateFindings, unclassified: unclassifiedGateless };
  say(`AUTHOR-CHECK productGates: red=${redProductReal.length} gates=${gates.join(',') || '(none)'}${unclassifiedGateless ? ' (R-L2-013.22: unclassified)' : ''}`);
  if (unclassifiedGateless) warn.push('product-real red without failing product gate names in the receipt (R-L2-013.22): unclassified');

  const validator = spawn(process.execPath, [validatorScript, '--root', '.'], { ...spawnOptions, timeout: 600000 });
  results.validator = { exit: validator.status === null || validator.status === undefined ? 2 : validator.status };
  say(`AUTHOR-CHECK validator: exit=${results.validator.exit}`);

  // The language contract is checked heuristically on this range:
  // WARN-only third-party step on the range this check already checks (base..HEAD).
  // Findings never fail the check; only an internal refusal of the tool does.
  const langArgs = ['.ai/bin/ops-tools/language-check.cjs', '--root', '.'];
  if (base) langArgs.push('--base', base);
  const lang = spawn(process.execPath, langArgs, { ...spawnOptions, timeout: 300000 });
  results.lang = { exit: lang.error || lang.status === null || lang.status === undefined ? 2 : lang.status };
  const langLines = String(lang.stdout || '').split(/\r?\n/).filter(Boolean);
  say(`AUTHOR-CHECK lang: exit=${results.lang.exit} findings=${langLines.filter(line => line.startsWith('LANG ') && !line.startsWith('LANG SUMMARY')).length}`);
  for (const line of langLines) if (line.startsWith('LANG ')) say(`AUTHOR-CHECK lang: ${line}`);

  const head = safe(git, ['rev-parse', 'HEAD']);
  const tree = safe(git, ['rev-parse', 'HEAD^{tree}']);
  const branch = (safe(git, ['rev-parse', '--abbrev-ref', 'HEAD']) || 'unknown').replace(/[^A-Za-z0-9._-]/g, '_');
  let dirty;
  try { dirty = receipt.dirtyNonJournal(git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])); }
  catch { dirty = ['unreadable worktree status']; }
  const baseSha = safe(git, ['rev-parse', base]);
  const ok = Object.values(results).every(row => row.exit === 0) && dirty.length === 0;
  if (unmapped.length) say(`AUTHOR-CHECK note: ${unmapped.length} selected files have no driver entry or owner: ${unmapped.slice(0, 5).join(', ')}`);

  const value = {
    schema: receipt.SCHEMA, rule: 'author-check 2026-10-25 (driver)', worktree: root, branch, head, tree, base, unmapped,
    baseSha, dirtyNonJournal: dirty, listingFallback, at: new Date(now()).toISOString(), ok, groups, results, warn,
    coverage,
    marked: warn.length ? (ok ? 'PASS-WITH-WARNINGS' : 'FAIL-WITH-WARNINGS') : null,
    // R-L2-013.22: the classification of a red product-real. A red
    // product-real with its gate names in the receipt is GATE-NAMED; the same red without
    // them is UNCLASSIFIED and blocks classification of the run.
    classification: redProductReal.length ? (unclassifiedGateless ? 'UNCLASSIFIED' : 'GATE-NAMED') : null,
    timing: { mainMs: wallMs, freshnessMs,
      // per-file run results of this author-check run for the long-pole pulse (finding 11.99);
      // empty when the summary was not current - the pulse then reports the run unproven.
      files: Object.fromEntries([...runFileTiming.entries()].sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)), },
    tempSweep: holder.attempt.sweep,
    // the machine facts a certification scope compares: the Node of this check and the Defender state the gate measured
    environment: { node: process.version, defender: defenderFact(gate.lines) },
  };
  const dir = options.receiptRoot || cfg.receiptRoot;
  const file = receipt.writeReceipt(dir, value, fs);
  receipt.appendLedger(dir, {
    at: value.at, branch, head, ok, warn, marked: value.marked,
    wallMin: +((wallMs + freshnessMs) / 60000).toFixed(1), files: selection.tests.length,
    exits: Object.fromEntries(Object.entries(results).map(([key, row]) => [key, row.exit])),
  }, fs);
  say(`AUTHOR-CHECK ${ok ? warn.length ? 'PASS-WITH-WARNINGS' : 'PASS' : 'FAIL'} receipt ${file}${dirty.length ? ' (uncommitted non-journal changes: commit first, then rerun)' : ''}`);
  return { ok, receipt: value, receiptFile: file, selection, groups, results, lines, unmapped };
}

function main(argv) {
  const args = argv.slice();
  const lightIndex = args.indexOf('--light');
  const light = lightIndex >= 0;
  if (light) args.splice(lightIndex, 1);
  const policyIndex = args.indexOf('--policy');
  const policy = policyIndex >= 0;
  if (policy) args.splice(policyIndex, 1);
  const listIndex = args.indexOf('--list');
  const list = listIndex >= 0;
  if (list) args.splice(listIndex, 1);
  const root = path.resolve(args[0] || '.');
  const base = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
  let result;
  const emitted = [];
  try {
    if (light && (list || policy)) throw new Error('--light cannot be combined with --list or --policy');
    result = run({ root, base, list, policy, light, onLine: line => { emitted.push(line); process.stdout.write(`${line}\n`); } });
  }
  catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  for (const line of result.lines) if (!emitted.includes(line)) process.stdout.write(`${line}\n`);
  return result.code !== undefined ? result.code : result.ok ? 0 : 1;
}

module.exports = { run, main, SUMMARY, ownerTable, mapDriverFiles, failureDetails };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

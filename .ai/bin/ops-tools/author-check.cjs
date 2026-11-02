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

const SUMMARY = /^(?:# (?:tests|pass|fail)|not ok )/;
const plain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function gitRunner(root, run) {
  const spawn = run || ((file, args, opts) => spawnSync(file, args, opts));
  return args => {
    const r = spawn('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw Object.assign(new Error(`AUTHOR-CHECK-GIT: git ${args[0]} failed`), { code: 'AUTHOR-CHECK-GIT' });
    return args[0] === 'status' ? (r.stdout || '') : (r.stdout || '').trim();
  };
}
const safe = (git, args) => { try { return git(args); } catch { return ''; } };

function ownerTable(root) {
  const file = path.join(root, 'docs/ops/suite-timing.json');
  if (!fs.existsSync(file)) return new Map();
  try {
    const timing = JSON.parse(fs.readFileSync(file, 'utf8'));
    return new Map((timing.files || []).filter(row => plain(row) && row.owner).map(row => [row.name, row.owner]));
  } catch { return new Map(); }
}

function defaultGate({ root, spawn }) {
  const r = spawn(process.execPath, [path.join(__dirname, 'heavy-gate.cjs'), '--tree', root, '--defender', 'warn'], { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const lines = String(r.stdout || '').split(/\r?\n/).filter(Boolean);
  return { ok: !r.error && r.status === 0, lines };
}

function run(options = {}) {
  const root = path.resolve(options.root || '.');
  const cfg = options.cfg || load({ root, env: options.env || process.env });
  const author = options.author || cfg.author;
  const base = options.base || author.baseRef;
  const spawn = options.spawn || ((file, args, opts) => spawnSync(file, args, opts));
  const git = options.git || gitRunner(root, spawn);
  const now = options.now || (() => Date.now());
  const lines = [];
  const say = text => lines.push(text);

  const selection = options.selection || select.select({ root, base, depth: author.defaultDepth, author, git, exists: options.exists, readFile: options.readFile });
  const partOf = test => { const reason = selection.reasons[test] || ''; return reason === 'common' ? 'common' : reason.startsWith('heavy') ? 'heavy' : 'affected'; };
  const groups = { common: [], affected: [], heavy: [] };
  for (const test of selection.tests) groups[partOf(test)].push(test);

  if (options.list) {
    return { ok: true, list: true, selection, groups, lines: [JSON.stringify({ base, groups, reasons: selection.reasons }, null, 2)] };
  }

  // PROTO-DEC-0249 items 2 and 3 (P-153, P-154): environment facts and at most the configured number of heavy runs at once.
  // The gate waits for a slot; a refusal ends the check before anything is run. Defender is a warning here, not a refusal.
  const gate = (options.gate || defaultGate)({ root, spawn });
  for (const line of gate.lines) say(line);
  if (!gate.ok) {
    say('AUTHOR-CHECK REFUSED by the heavy gate (PROTO-DEC-0249); nothing was run');
    return { ok: false, refused: true, code: 3, selection, groups, lines };
  }

  const tempRoot = options.tempRoot || cfg.tempRoot;
  fs.mkdirSync(tempRoot, { recursive: true });
  const env = { ...(options.env || process.env), TEMP: tempRoot, TMP: tempRoot };
  if (!env.PROTOCOL_TEST_POWERSHELL) {
    const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\Windows';
    env.PROTOCOL_TEST_POWERSHELL = path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }
  const spawnOptions = { cwd: root, env, encoding: 'utf8', windowsHide: true };

  // The selection reaches the driver as a summary whose files are marked failed. A driver
  // that cannot list its own inventory is a red part: an empty listing must never turn into
  // a green receipt with nothing run.
  let listed = spawn(process.execPath, [cfg.driver, '--root', '.', '--list', '--with-mutations'], { ...spawnOptions, timeout: 300000 });
  const listingFallback = Boolean(listed.error || listed.status !== 0);
  if (listingFallback) {
    say('AUTHOR-CHECK note: mutation inventory unavailable; falling back to --list');
    listed = spawn(process.execPath, [cfg.driver, '--root', '.', '--list'], { ...spawnOptions, timeout: 300000 });
  }
  const listFailed = Boolean(listed.error) || listed.status !== 0;
  const driverFiles = new Set(String(listed.stdout || '').split(/\r?\n/).filter(Boolean));
  const owners = ownerTable(root);
  const unmapped = [];
  const toDriver = files => [...new Set(files.map(file => driverFiles.has(file) ? file : driverFiles.has(owners.get(file)) ? owners.get(file) : (unmapped.push(file), null)).filter(Boolean))];
  const byPart = Object.fromEntries(['common', 'affected', 'heavy'].map(name => [name, toDriver(groups[name])]));
  const all = [...new Set(Object.values(byPart).flat())];
  const unmappedTests = selection.tests.filter(test => unmapped.includes(test));

  const started = now();
  const summaryPath = path.join(tempRoot, `select-${process.pid}.json`);
  fs.writeFileSync(summaryPath, JSON.stringify({ files: all.map(name => ({ name, status: 'fail' })) }));
  const r = all.length
    ? spawn(process.execPath, [cfg.driver, '--root', '.', '--rerun-failed', summaryPath], { ...spawnOptions, maxBuffer: 512 * 1024 * 1024, timeout: 90 * 60 * 1000 })
    : { status: 0, stdout: '', stderr: '' };
  const wallMs = now() - started;
  const output = `${r.stdout || ''}\n${r.stderr || ''}`.split(/\r?\n/).filter(line => SUMMARY.test(line));

  let fileStatus = new Map();
  try {
    const summary = path.join(root, '.ai/runtime/test-summaries/run-summary.json');
    const data = JSON.parse(fs.readFileSync(summary, 'utf8'));
    if (fs.statSync(summary).mtimeMs >= started) fileStatus = new Map((data.files || []).map(row => [row.name, row.status]));
  } catch { /* per-part status unknown: the overall exit decides */ }

  const results = {};
  if (listFailed) {
    results.list = { exit: 2, error: listed.error ? (listed.error.code || 'spawn error') : `exit ${listed.status}` };
    say(`AUTHOR-CHECK list: exit=2 ${results.list.error}`);
  }
  if (unmappedTests.length) {
    results.unmappedTests = { exit: 2, files: unmappedTests };
    say(`AUTHOR-CHECK unmappedTests: exit=2 ${unmappedTests.slice(0, 5).join(',')}`);
  }
  for (const [name, files] of Object.entries(byPart)) {
    const failed = files.filter(file => fileStatus.get(file) && fileStatus.get(file) !== 'pass');
    const unknown = files.filter(file => !fileStatus.has(file));
    const exit = !files.length ? 0 : failed.length ? 1 : unknown.length && r.status !== 0 ? (r.status || 2) : 0;
    results[name] = { files: files.length, exit, failedFiles: failed, unknownFiles: unknown.length };
    say(`AUTHOR-CHECK ${name}: files=${files.length} exit=${exit}${failed.length ? ` failed=${failed.slice(0, 5).join(',')}` : ''}`);
  }
  results.run = {
    exit: r.error ? 2 : (r.status === null || r.status === undefined ? 2 : r.status),
    error: r.error ? (r.error.code || 'spawn error') : null,
    wallMs,
    failing: output.filter(line => line.startsWith('not ok')).slice(0, 40),
    tests: output.filter(line => line.startsWith('# tests ')).pop() || null,
    fail: output.filter(line => line.startsWith('# fail ')).pop() || null,
  };
  say(`AUTHOR-CHECK run: files=${all.length} exit=${results.run.exit} ${results.run.fail || ''} ${(wallMs / 60000).toFixed(1)} min`);

  const validator = spawn(process.execPath, [cfg.validator, '--root', '.'], { ...spawnOptions, timeout: 600000 });
  results.validator = { exit: validator.status === null || validator.status === undefined ? 2 : validator.status };
  say(`AUTHOR-CHECK validator: exit=${results.validator.exit}`);

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
    baseSha, dirtyNonJournal: dirty, listingFallback, at: new Date(now()).toISOString(), ok, groups, results,
  };
  const dir = options.receiptRoot || cfg.receiptRoot;
  const file = receipt.writeReceipt(dir, value, fs);
  receipt.appendLedger(dir, {
    at: value.at, branch, head, ok,
    wallMin: +(wallMs / 60000).toFixed(1), files: selection.tests.length,
    exits: Object.fromEntries(Object.entries(results).map(([key, row]) => [key, row.exit])),
  }, fs);
  say(`AUTHOR-CHECK ${ok ? 'PASS' : 'FAIL'} receipt ${file}${dirty.length ? ' (uncommitted non-journal changes: commit first, then rerun)' : ''}`);
  return { ok, receipt: value, receiptFile: file, selection, groups, results, lines, unmapped };
}

function main(argv) {
  const args = argv.slice();
  const listIndex = args.indexOf('--list');
  const list = listIndex >= 0;
  if (list) args.splice(listIndex, 1);
  const root = path.resolve(args[0] || '.');
  const base = args[1] && !args[1].startsWith('--') ? args[1] : undefined;
  let result;
  try { result = run({ root, base, list }); }
  catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  return result.code !== undefined ? result.code : result.ok ? 0 : 1;
}

module.exports = { run, main, SUMMARY };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

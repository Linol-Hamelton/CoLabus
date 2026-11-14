'use strict';
// Configuration and path derivation of the operator tools. Nothing here names a machine
// directory: the work root comes from protocol-manifest.json (workRoot) or from the
// directory above the main checkout, and every other path is a name under that root.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { seatEnvironment } = require('../../lib/seat-heavy.cjs');

const PACKAGE = path.resolve(__dirname, '..');
const REPO = path.resolve(PACKAGE, '..', '..');
const DEFAULTS = path.join(PACKAGE, 'ops-tools.config.json');
const CAPS = path.join(PACKAGE, 'seat-caps.json');
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const plain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
function refuse(code, detail) {
  return Object.assign(new Error(`${code}: ${detail}`), { code });
}
function readJson(file, readFile = name => fs.readFileSync(name, 'utf8')) {
  let text;
  try { text = readFile(file); } catch (e) { throw refuse('CONFIG-UNREADABLE', `${file} (${e.code || 'read failed'})`); }
  try { return JSON.parse(text); } catch { throw refuse('CONFIG-INVALID', `${file} is not valid JSON`); }
}
function absolute(value) { return typeof value === 'string' && path.isAbsolute(value) && !/[\r\n\0]/.test(value); }

// The main checkout of a worktree family, from the shared Git directory. The runtime
// directory (candidate registry, launch markers) always belongs to that checkout.
function gitMainRoot(cwd) {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd, encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0 || !r.stdout.trim()) return null;
  return path.resolve(r.stdout.trim(), '..');
}

function segment(value, what) {
  if (typeof value !== 'string' || !SAFE_SEGMENT.test(value)) throw refuse('CONFIG-INVALID', `${what} must be one safe path segment`);
  return value;
}
function positive(value, what) {
  if (!Number.isSafeInteger(value) || value <= 0) throw refuse('CONFIG-INVALID', `${what} must be a positive integer`);
  return value;
}
function regexList(list, what) {
  if (!Array.isArray(list) || list.some(v => typeof v !== 'string' || !v)) throw refuse('CONFIG-INVALID', `${what} must be a list of non-empty strings`);
  return list.map(source => {
    try { return new RegExp(source); } catch { throw refuse('CONFIG-INVALID', `${what} holds an invalid regular expression: ${source}`); }
  });
}
function merge(base, extra) {
  if (!plain(extra)) throw refuse('CONFIG-INVALID', 'a configuration layer must be an object');
  const out = { ...base };
  for (const [key, value] of Object.entries(extra || {})) {
    out[key] = plain(value) && plain(out[key]) ? { ...out[key], ...value } : value;
  }
  return out;
}
function manifestWorkRoot(root, readFile) {
  const file = path.join(root, 'protocol-manifest.json');
  let manifest;
  try { manifest = readJson(file, readFile); } catch { return null; }
  return plain(manifest) && absolute(manifest.workRoot) ? manifest.workRoot : null;
}

// Returns the validated configuration and every derived path. Options exist only for
// tests: a caller passes a root, a work root and injected readers instead of the machine.
function load(options = {}) {
  const root = path.resolve(options.root || REPO);
  const cwd = options.cwd || root;
  const readFile = options.readFile || (name => fs.readFileSync(name, 'utf8'));
  const exists = options.exists || (name => fs.existsSync(name));
  const env = options.env || process.env;
  const main = path.resolve(options.main || gitMainRoot(cwd) || root);
  const defaults = readJson(options.defaults || DEFAULTS, readFile);
  if (!plain(defaults) || defaults.schema !== 'ops-tools/1') throw refuse('CONFIG-INVALID', 'the defaults are not an ops-tools/1 object');
  const workRoot = path.resolve(options.workRoot || env.PROTOCOL_OPS_WORK_ROOT || manifestWorkRoot(root, readFile)
    || path.join(path.dirname(main), 'ops-work'));
  // Run identity belongs to the worktree family. A branch-local manifest must not
  // hide its runners from another branch's gate. Explicit operator overrides stay shared.
  const registryRoot = path.resolve(options.workRoot || env.PROTOCOL_OPS_WORK_ROOT || manifestWorkRoot(main, readFile) || workRoot);
  const localFile = path.join(workRoot, segment(defaults.paths && defaults.paths.localConfig, 'paths.localConfig'));
  // Operator layering: shipped defaults, project selection sets, local file.
  // Seats use checkout layers only; local routing overrides need an operator grant.
  const projectFile = path.join(root, 'docs/ops/ops-tools.project.json');
  const project = exists(projectFile) ? readJson(projectFile, readFile) : {};
  const layered = merge(defaults, project);
  // Seats never depend on an unreadable, mutable policy outside their checkout.
  // Unknown/unmarked callers still need a positive grant for local execution.
  const isSeat = seatEnvironment(env);
  const localApplied = !isSeat && exists(localFile);
  const local = localApplied ? readJson(localFile, readFile) : {};
  const config = merge(layered, local);
  const operatorPolicy = !isSeat && env.PROTOCOL_OPERATOR_HEAVY === '1';
  if (!operatorPolicy) for (const key of ['heavyChecks', 'farmSubmit']) {
    if (Object.hasOwn(layered, key)) config[key] = layered[key]; else delete config[key];
  }
  const sourceOf = key => operatorPolicy && Object.hasOwn(local, key) ? localFile : Object.hasOwn(project, key) ? projectFile : (options.defaults || DEFAULTS);
  const heavyPolicy = {
    source: sourceOf('heavyChecks'),
    farmSubmitSource: config.farmSubmit === undefined ? 'derived:workRoot/farm/submit.cjs' : sourceOf('farmSubmit'),
    localFile, localApplied: operatorPolicy && localApplied, seat: isSeat,
  };
  const heavyChecks = config.heavyChecks === undefined ? 'local' : config.heavyChecks;
  if (!['local', 'farm', 'auto'].includes(heavyChecks)) throw refuse('CONFIG-INVALID', 'heavyChecks must be local, farm or auto');
  if (config.farmSubmit !== undefined && !absolute(config.farmSubmit)) throw refuse('CONFIG-INVALID', 'farmSubmit must be an absolute script path');
  let operatorSettings;
  try { operatorSettings = require('../../operator/layer.cjs').parseSettings(readJson(path.join(main, 'protocol-manifest.json'), readFile).operatorLayer); }
  catch (e) { if (e.code === 'SETTINGS_INVALID') throw e; operatorSettings = require('../../operator/layer.cjs').parseSettings(); }
  const proxy = require('../proxy-health.cjs').config({ ...config.proxy, tickMs: operatorSettings.schedules.proxyMinutes * 60000 });
  const names = plain(config.paths) ? config.paths : {};
  for (const key of ['receipts', 'prompts', 'tmp', 'localConfig']) segment(names[key], `paths.${key}`);
  const author = plain(config.author) ? config.author : {};
  const manifest = exists(path.join(root, 'protocol-manifest.json')) ? readJson(path.join(root, 'protocol-manifest.json'), readFile) : {};
  const trainOnly = Object.keys(manifest.testTiers || {}).filter(test => manifest.testTiers[test]?.tier === 'trainOnly');
  for (const test of trainOnly) {
    if (!Array.isArray(manifest.tests) || !manifest.tests.includes(test) || !/^tests\/[A-Za-z0-9._-]+\.test\.cjs$/.test(test)) {
      throw refuse('CONFIG-INVALID', 'trainOnly must name an enrolled test driver');
    }
  }
  if (typeof author.baseRef !== 'string' || !author.baseRef || /[\r\n\0]/.test(author.baseRef)) throw refuse('CONFIG-INVALID', 'author.baseRef must be one commit ref');
  if (![1, 2].includes(author.defaultDepth)) throw refuse('CONFIG-INVALID', 'author.defaultDepth must be 1 or 2');
  regexList(author.ignore || [], 'author.ignore');
  regexList(author.common || [], 'author.common');
  if (!plain(author.heavy)) throw refuse('CONFIG-INVALID', 'author.heavy must be an object');
  for (const [test, trigger] of Object.entries(author.heavy)) regexList([trigger], `author.heavy[${test}]`);
  const seat = plain(config.seat) ? config.seat : {};
  for (const key of ['maxAgeHours', 'defaultCap', 'pollMs', 'waitTimeoutMs', 'verifyTimeoutMs', 'verifyPollMs']) positive(seat[key], `seat.${key}`);
  if (typeof seat.endMarker !== 'string' || !seat.endMarker) throw refuse('CONFIG-INVALID', 'seat.endMarker must be a regular expression');
  try { new RegExp(seat.endMarker); } catch { throw refuse('CONFIG-INVALID', 'seat.endMarker is not a valid regular expression'); }
  const heavy = plain(config.heavy) ? config.heavy : {};
  for (const key of ['cap', 'minFreeGb', 'waitMinutes', 'pollMs', 'trainFlagHours']) positive(heavy[key], `heavy.${key}`);
  if (typeof heavy.nodeVersion !== 'string' || !/^\d+(\.\d+)*$/.test(heavy.nodeVersion)) throw refuse('CONFIG-INVALID', 'heavy.nodeVersion must be a dotted version prefix');
  segment(heavy.queueDir, 'heavy.queueDir');
  segment(heavy.trainFlag, 'heavy.trainFlag');
  segment(heavy.runsDir, 'heavy.runsDir');
  const cleanup = plain(config.cleanup) ? config.cleanup : {};
  if (cleanup.archiveRoot !== null && !absolute(cleanup.archiveRoot)) throw refuse('CONFIG-INVALID', 'cleanup.archiveRoot must be an absolute directory or null');
  segment(cleanup.archiveName, 'cleanup.archiveName');
  regexList([cleanup.ownerSessionPattern], 'cleanup.ownerSessionPattern');
  if (!Array.isArray(cleanup.protectedBranches) || cleanup.protectedBranches.some(v => typeof v !== 'string' || !SAFE_SEGMENT.test(v))) throw refuse('CONFIG-INVALID', 'cleanup.protectedBranches must be a list of branch names');
  for (const key of ['inventoryMaxHours', 'tempRetentionDays']) positive(cleanup[key], `cleanup.${key}`);
  const legacy = plain(config.legacy) ? config.legacy : {};
  if (!Array.isArray(legacy.names) || legacy.names.some(n => typeof n !== 'string' || !SAFE_SEGMENT.test(n))) throw refuse('CONFIG-INVALID', 'legacy.names must be a list of safe file names');
  return {
    root, main, workRoot, config, heavyChecks, heavyPolicy, proxy,
    farmSubmit: config.farmSubmit === undefined ? path.join(workRoot, 'farm', 'submit.cjs') : config.farmSubmit,
    runtimeDir: path.join(main, operatorSettings.runtime),
    receiptRoot: path.join(workRoot, names.receipts),
    promptRoot: path.join(workRoot, names.prompts),
    tempRoot: path.join(workRoot, names.tmp),
    localFile, projectFile,
    driver: path.join(root, '.ai', 'bin', 'protocol-test.cjs'),
    gates: path.join(root, '.ai', 'bin', 'protocol-gates.cjs'),
    validator: path.join(root, '.ai', 'bin', 'protocol-validate.cjs'),
    author: {
      baseRef: author.baseRef,
      defaultDepth: author.defaultDepth,
      manifestTestOnly: new Set(Array.isArray(author.manifestTestOnly) ? author.manifestTestOnly : []),
      ignore: regexList(author.ignore || [], 'author.ignore'),
      common: Array.isArray(author.common) ? author.common.filter(v => typeof v === 'string') : [],
      trainOnly,
      heavy: Object.fromEntries(Object.entries(author.heavy).map(([name, source]) => [name, new RegExp(source)])),
    },
    seat: {
      maxAgeMs: seat.maxAgeHours * 3600000,
      endMarker: new RegExp(seat.endMarker, 'm'),
      defaultCap: seat.defaultCap,
      pollMs: seat.pollMs,
      waitTimeoutMs: seat.waitTimeoutMs,
      verifyTimeoutMs: seat.verifyTimeoutMs,
      verifyPollMs: seat.verifyPollMs,
    },
    legacyNames: legacy.names,
    heavy: {
      cap: heavy.cap, minFreeGb: heavy.minFreeGb, nodeVersion: heavy.nodeVersion, waitMinutes: heavy.waitMinutes, pollMs: heavy.pollMs,
      trainFlagMs: heavy.trainFlagHours * 3600000,
      queueDir: path.join(workRoot, heavy.queueDir),
      trainFlag: path.join(workRoot, heavy.trainFlag),
      runsDir: path.join(registryRoot, heavy.runsDir),
    },
    cleanup: {
      archiveRoot: cleanup.archiveRoot || path.join(workRoot, cleanup.archiveName),
      ownerSessionPattern: new RegExp(cleanup.ownerSessionPattern, 'i'),
      protectedBranches: cleanup.protectedBranches,
      reservedNames: [...Object.values(names), heavy.queueDir, heavy.trainFlag, heavy.runsDir, cleanup.archiveName],
      inventoryMaxMs: cleanup.inventoryMaxHours * 3600000,
      tempRetentionMs: cleanup.tempRetentionDays * 86400000,
    },
  };
}

// The client NAME patterns are data; the caps are not. The caps live in the seat policy
// (docs/ops/seat-policy.json of the main checkout, read through .ai/bin/lib/seat-policy.cjs),
// so a stale shipped number can never enforce anything. A table that still carries a cap is
// refused, never silently ignored.
function loadSeatCaps(options = {}) {
  const file = options.file || CAPS;
  const data = readJson(file, options.readFile || (name => fs.readFileSync(name, 'utf8')));
  if (!plain(data) || data.schema !== 'seat-caps/1') throw refuse('SEAT-CAPS-INVALID', `${file} is not a seat-caps/1 object`);
  if (!Array.isArray(data.clients) || !data.clients.length) throw refuse('SEAT-CAPS-INVALID', 'clients must be a non-empty list');
  const seen = new Set();
  const clients = data.clients.map((row, index) => {
    if (!plain(row) || typeof row.name !== 'string' || !SAFE_SEGMENT.test(row.name)) throw refuse('SEAT-CAPS-INVALID', `clients[${index}].name is not a safe client name`);
    if (seen.has(row.name)) throw refuse('SEAT-CAPS-INVALID', `client ${row.name} is named twice`);
    seen.add(row.name);
    if (Object.hasOwn(row, 'cap')) throw refuse('SEAT-CAPS-INVALID', `clients[${index}].cap must not be here: the caps live in the seat policy`);
    return { name: row.name, patterns: regexList(row.patterns, `clients[${index}].patterns`) };
  });
  return { clients };
}

// The seat policy of the host. -> { ok, configured, policy, file, code, detail }.
// The canonical file is the policy of the MAIN checkout, so every worktree of the repository
// reads the same policy. An additional host file (--caps) may only TIGHTEN it; the test
// injection (OK_SEAT_POLICY_FILE) replaces it. An absent canonical file is an UNCONFIGURED
// host (no client and no route cap; the total default of the ops config stays in force).
// Every other failure is a refusal with a named reason: the caller exits 2 and never falls
// back to "uncapped" and never falls back to a shipped table.
function loadSeatPolicy(options = {}) {
  // General configuration and the run registry do not need seat-policy readers.
  // Load the guarded helper only when an operation actually requests the policy.
  const seatPolicy = require('../../lib/seat-policy.cjs');
  const main = path.resolve(options.main || REPO);
  const canonical = seatPolicy.canonicalFile(main);
  const env = options.env || process.env;
  const injected = typeof env[seatPolicy.ENV] === 'string' && env[seatPolicy.ENV].trim() ? env[seatPolicy.ENV].trim() : null;
  const read = seatPolicy.resolvePolicy({ canonical, named: options.file || null, injected, now: options.now });
  if (read.ok) return { ok: true, configured: read.configured, policy: read.policy, file: read.file };
  return { ok: false, configured: false, policy: null, file: read.file, code: read.code, detail: read.detail };
}

module.exports = { PACKAGE, REPO, DEFAULTS, CAPS, plain, refuse, readJson, absolute, gitMainRoot, load, loadSeatCaps, loadSeatPolicy, merge };

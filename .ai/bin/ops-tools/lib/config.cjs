'use strict';
// Configuration and path derivation of the operator tools. Nothing here names a machine
// directory: the work root comes from protocol-manifest.json (workRoot) or from the
// directory above the main checkout, and every other path is a name under that root.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

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
  const localFile = path.join(workRoot, segment(defaults.paths && defaults.paths.localConfig, 'paths.localConfig'));
  // Three layers, later wins: the shipped defaults, the project's own selection sets (a host
  // keeps them in its own file; the product ships none), then the operator's local file.
  const projectFile = path.join(root, 'docs/ops/ops-tools.project.json');
  const layered = exists(projectFile) ? merge(defaults, readJson(projectFile, readFile)) : defaults;
  const config = exists(localFile) ? merge(layered, readJson(localFile, readFile)) : layered;
  const names = plain(config.paths) ? config.paths : {};
  for (const key of ['receipts', 'prompts', 'tmp', 'localConfig']) segment(names[key], `paths.${key}`);
  const author = plain(config.author) ? config.author : {};
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
  const cleanup = plain(config.cleanup) ? config.cleanup : {};
  if (cleanup.archiveRoot !== null && !absolute(cleanup.archiveRoot)) throw refuse('CONFIG-INVALID', 'cleanup.archiveRoot must be an absolute directory or null');
  segment(cleanup.archiveName, 'cleanup.archiveName');
  regexList([cleanup.ownerSessionPattern], 'cleanup.ownerSessionPattern');
  if (!Array.isArray(cleanup.protectedBranches) || cleanup.protectedBranches.some(v => typeof v !== 'string' || !SAFE_SEGMENT.test(v))) throw refuse('CONFIG-INVALID', 'cleanup.protectedBranches must be a list of branch names');
  for (const key of ['inventoryMaxHours', 'tempRetentionDays']) positive(cleanup[key], `cleanup.${key}`);
  const legacy = plain(config.legacy) ? config.legacy : {};
  if (!Array.isArray(legacy.names) || legacy.names.some(n => typeof n !== 'string' || !SAFE_SEGMENT.test(n))) throw refuse('CONFIG-INVALID', 'legacy.names must be a list of safe file names');
  return {
    root, main, workRoot, config,
    runtimeDir: path.join(main, '.ai', 'runtime'),
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
    },
    cleanup: {
      archiveRoot: cleanup.archiveRoot || path.join(workRoot, cleanup.archiveName),
      ownerSessionPattern: new RegExp(cleanup.ownerSessionPattern, 'i'),
      protectedBranches: cleanup.protectedBranches,
      reservedNames: [...Object.values(names), heavy.queueDir, heavy.trainFlag, cleanup.archiveName],
      inventoryMaxMs: cleanup.inventoryMaxHours * 3600000,
      tempRetentionMs: cleanup.tempRetentionDays * 86400000,
    },
  };
}

// Per-client caps are data. A malformed table is a named refusal, never a silent default.
function loadSeatCaps(options = {}) {
  const file = options.file || CAPS;
  const data = readJson(file, options.readFile || (name => fs.readFileSync(name, 'utf8')));
  if (!plain(data) || data.schema !== 'seat-caps/1') throw refuse('SEAT-CAPS-INVALID', `${file} is not a seat-caps/1 object`);
  if (!Number.isSafeInteger(data.defaultCap) || data.defaultCap < 0) throw refuse('SEAT-CAPS-INVALID', 'defaultCap must be a non-negative integer');
  if (!Array.isArray(data.clients) || !data.clients.length) throw refuse('SEAT-CAPS-INVALID', 'clients must be a non-empty list');
  const seen = new Set();
  const clients = data.clients.map((row, index) => {
    if (!plain(row) || typeof row.name !== 'string' || !SAFE_SEGMENT.test(row.name)) throw refuse('SEAT-CAPS-INVALID', `clients[${index}].name is not a safe client name`);
    if (seen.has(row.name)) throw refuse('SEAT-CAPS-INVALID', `client ${row.name} is named twice`);
    seen.add(row.name);
    if (!Number.isSafeInteger(row.cap) || row.cap < 0) throw refuse('SEAT-CAPS-INVALID', `clients[${index}].cap must be a non-negative integer`);
    return { name: row.name, cap: row.cap, patterns: regexList(row.patterns, `clients[${index}].patterns`) };
  });
  return { defaultCap: data.defaultCap, clients };
}

module.exports = { PACKAGE, REPO, DEFAULTS, CAPS, plain, refuse, readJson, absolute, gitMainRoot, load, loadSeatCaps, merge };

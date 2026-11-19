'use strict';
// Author test selection. Depth 1: an enrolled test whose text names a changed file. Depth 2:
// also a test that names a non-test module which names a changed file. Heavy tests join only
// by the trigger configured for them. The parser is the driver's own enrollment; no code of
// the inspected tree is executed.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');

const plain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const names = file => [file, path.posix.basename(file)];
const CAP_MS = 90 * 60 * 1000;

function enrollmentOnly(key, before, after) {
  if (key === 'testTiers') return plain(after) && (before === undefined || plain(before)) &&
    Object.entries(before || {}).every(([name, row]) => Object.hasOwn(after, name) && isDeepStrictEqual(row, after[name]));
  if (!['tests', 'source', 'managed', 'integration', 'state'].includes(key) || !Array.isArray(after) || (before !== undefined && !Array.isArray(before))) return false;
  return after.every(name => typeof name === 'string') && new Set(after).size === after.length &&
    (before || []).every(name => after.includes(name));
}

// An estimate no timing row supports is unknown, never 0 minutes, and cannot cross the cap.
const knownMs = selection => Number.isFinite(selection.estimateMs) ? selection.estimateMs : null;
function estimateLine(selection) {
  const ms = knownMs(selection);
  const minutes = ms === null ? 'unknown' : (ms / 60000).toFixed(1);
  return `AUTHOR-SELECT ESTIMATE files=${selection.tests.length} minutes=${minutes} timed=${selection.timedFiles || 0} unknown=${selection.tests.length - (selection.timedFiles || 0)} capMinutes=${CAP_MS / 60000} basis=recorded-cpu`;
}
function capLine(selection) {
  return (knownMs(selection) ?? 0) > CAP_MS
    ? `AUTHOR-SELECT OVER-CAP files=${selection.tests.length} minutes=${(selection.estimateMs / 60000).toFixed(1)} capMinutes=${CAP_MS / 60000} tests=${selection.tests.join(',')}` : null;
}

function gitRunner(root, run) {
  const spawn = run || ((file, args, opts) => spawnSync(file, args, opts));
  return args => {
    const r = spawn('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
    if (r.error || r.status !== 0) {
      const detail = r.error ? r.error.code : `exit ${r.status}`;
      throw Object.assign(new Error(`AUTHOR-SELECT-GIT: git ${args[0]} failed (${detail})`), { code: 'AUTHOR-SELECT-GIT' });
    }
    return r.stdout || '';
  };
}

function select(options = {}) {
  const root = path.resolve(options.root || '.');
  const base = options.base || 'origin/v2.0.0';
  const depth = options.depth === undefined ? 2 : Number(options.depth);
  if (![1, 2].includes(depth)) throw Object.assign(new Error('AUTHOR-SELECT-USAGE: depth must be 1 or 2'), { code: 'AUTHOR-SELECT-USAGE' });
  const git = options.git || gitRunner(root, options.run);
  const read = file => (options.readFile || (f => fs.readFileSync(f, 'utf8')))(path.join(root, file));
  const exists = options.exists || (file => fs.existsSync(path.join(root, file)));
  const author = options.author || {};
  const manifestFile = path.join(root, 'protocol-manifest.json');
  let manifest;
  try { manifest = JSON.parse(read('protocol-manifest.json')); } catch { throw Object.assign(new Error(`AUTHOR-SELECT-MANIFEST: ${manifestFile} is unreadable`), { code: 'AUTHOR-SELECT-MANIFEST' }); }
  if (!plain(manifest) || !Array.isArray(manifest.tests)) throw Object.assign(new Error('AUTHOR-SELECT-MANIFEST: the manifest has no tests list'), { code: 'AUTHOR-SELECT-MANIFEST' });

  const changed = git(['diff', '--no-renames', '--name-only', '-z', `${base}...HEAD`]).split('\0')
    .concat(git(['diff', '--no-renames', '--name-only', '-z', 'HEAD']).split('\0'), git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0'))
    .filter(Boolean).filter((file, index, all) => all.indexOf(file) === index);

  // The manifest counts only through the keys that changed: test enrollment alone is the
  // manifest test's own job in the common set, not a reason to select every test.
  let manifestKeys = [], beforeManifest = {}, manifestUnreadable = false;
  if (changed.includes('protocol-manifest.json')) {
    // Match the triple-dot changed-path baseline, not the moving branch tip.
    let manifestBase = base;
    try { const ancestor = git(['merge-base', base, 'HEAD']).trim(); if (/^[a-f0-9]{40,64}$/.test(ancestor)) manifestBase = ancestor; } catch { /* baseline read below remains conservative */ }
    let before = {};
    try { before = JSON.parse(git(['show', `${manifestBase}:protocol-manifest.json`])); if (!plain(before)) throw Error('manifest shape'); }
    catch { before = {}; manifestUnreadable = true; }
    beforeManifest = before;
    const keys = new Set([...Object.keys(before), ...Object.keys(manifest)]);
    manifestKeys = [...keys].filter(key => !isDeepStrictEqual(before[key], manifest[key]));
  }
  const manifestRelevant = manifestUnreadable || manifestKeys.some(key => !enrollmentOnly(key, beforeManifest[key], manifest[key]));

  const enrolled = manifest.tests.filter(test => exists(test));
  const trainOnly = new Set(Object.keys(manifest.testTiers || {}).filter(test => manifest.testTiers[test]?.tier === 'trainOnly'));
  const tracked = git(['ls-files']).split('\n').filter(file => /\.(c?js|mjs)$/.test(file) && exists(file));
  const ignore = Array.isArray(author.ignore) ? author.ignore : [];
  // The optional source adapter uses this driver's compilers, never inspected code.
  // Installed hosts have no adapter and retain conservative selection.
  let derivedOwners = {};
  try {
    const adapter = path.join(__dirname, 'source', 'selection.cjs');
    if (fs.existsSync(adapter)) derivedOwners = require(adapter).owners({ root, changed, git, base, files: options.snapshotFiles });
  } catch { /* unverifiable output stays relevant */ }
  for (const [file, owners] of Object.entries(derivedOwners)) {
    if (!owners.length || owners.some(test => !enrolled.includes(test) || !exists(test) || trainOnly.has(test))) delete derivedOwners[file];
  }
  const code = changed
    .filter(file => !ignore.some(re => re.test(file)))
    .filter(file => file !== 'protocol-manifest.json' || manifestRelevant)
    .filter(file => !Object.hasOwn(derivedOwners, file));

  const text = new Map();
  const body = file => { if (!text.has(file)) { try { text.set(file, read(file)); } catch { text.set(file, ''); } } return text.get(file); };
  const mentions = (file, target) => names(target).some(name => body(file).includes(name));

  const selected = new Map();
  const add = (test, why) => { if (!trainOnly.has(test) && !selected.has(test)) selected.set(test, why); };
  const common = Array.isArray(author.common) ? author.common : [];
  for (const test of common) if (exists(test)) add(test, 'common');
  // The full plan (affected-only runs switched off): every enrolled test is selected.
  if (options.full === true) for (const test of enrolled) add(test, 'full');
  for (const [file, owners] of Object.entries(derivedOwners)) {
    if (!owners.length || owners.some(test => !enrolled.includes(test))) continue;
    for (const test of owners) add(test, `derived owner ${file}`);
  }
  for (const file of changed) if (enrolled.includes(file)) add(file, 'changed test');
  const heavy = plain(author.heavy) ? author.heavy : {};
  const isHeavy = test => Object.hasOwn(heavy, test);
  for (const test of enrolled) {
    if (isHeavy(test)) continue;
    const hit = code.find(file => file !== test && mentions(test, file));
    if (hit) add(test, `d1 ${hit}`);
  }
  if (depth >= 2) {
    const middles = tracked.filter(file => !enrolled.includes(file) && !/\.test\.c?js$/.test(file)
      && code.some(changedFile => changedFile !== file && /\.(c?js|mjs|json)$/.test(changedFile) && mentions(file, changedFile)));
    for (const test of enrolled) {
      if (isHeavy(test) || selected.has(test)) continue;
      const hit = middles.find(file => mentions(test, file));
      if (hit) add(test, `d2 ${hit}`);
    }
  }
  for (const [test, trigger] of Object.entries(heavy)) {
    if (!enrolled.includes(test)) continue;
    const hit = code.find(file => trigger.test(file));
    if (hit) add(test, `heavy trigger ${hit}`);
  }

  // Time estimate from the recorded suite timing when the tree has one.
  let estimateMs = 0;
  let timedFiles = 0;
  try {
    const timing = JSON.parse(read('docs/ops/suite-timing.json'));
    const rows = Array.isArray(timing.files) ? timing.files : [];
    const byName = new Map();
    const byOwner = new Map();
    for (const row of rows) {
      if (!plain(row) || typeof row.name !== 'string') continue;
      byName.set(row.name, Math.max(byName.get(row.name) || 0, row.attributedMs || 0));
      if (typeof row.owner === 'string') byOwner.set(row.owner, Math.max(byOwner.get(row.owner) || 0, row.attributedMs || 0));
    }
    const timedOwners = new Set();
    for (const test of selected.keys()) {
      const ms = byName.get(test) || byOwner.get(test);
      if (Number.isFinite(ms) && ms > 0) {
        timedFiles++;
        const owner = rows.find(row => row.name === test)?.owner || test;
        if (!timedOwners.has(owner)) { estimateMs += byOwner.get(owner) || ms; timedOwners.add(owner); }
      }
    }
  } catch { /* no timing table on this tree */ }
  if (selected.size && !timedFiles) estimateMs = null;

  return {
    worktree: root, base, depth, manifestKeys, manifestRelevant, derivedOwners,
    changed: changed.length, enrolled: enrolled.length, selected: selected.size,
    cpuMinutesKnown: estimateMs === null ? null : Math.round(estimateMs / 60000), estimateMs, timedFiles,
    tests: [...selected.keys()],
    reasons: Object.fromEntries(selected),
  };
}

// Coverage is not selection: a textual hit may select a helper, but only an
// indexed consumer or a static relative require path can explain its owner.
// Never execute inspected modules. The timing table alone is not proof.
function requireGraph(root) {
  const cache = new Map();
  const adapter = path.join(__dirname, 'source', 'selection.cjs');
  const safeName = name => typeof name === 'string' && name.length > 0 &&
    !/[\\\r\n\0]/.test(name) && !path.posix.isAbsolute(name) && !/^[A-Za-z]:/.test(name) &&
    !name.split('/').some(p => !p || p === '.' || p === '..');
  const deps = name => {
    if (cache.has(name)) return cache.get(name);
    const found = [];
    cache.set(name, found);
    if (!safeName(name) || !/\.[cm]?js$/.test(name)) return found;
    let text;
    try { text = fs.readFileSync(path.join(root, name), 'utf8'); } catch { return found; }
    // Source-only syntax adapter, like derived selection above. Installed hosts
    // without the parser cannot prove graph edges and retain explicit rows.
    let specifiers;
    try { specifiers = require(adapter).specifiers(text, name); }
    catch { return found; }
    for (const specifier of specifiers.filter(n => n.startsWith('.'))) {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(name), specifier));
      for (const target of [base, base + '.cjs', base + '.js', base + '.json', base + '/index.cjs', base + '/index.js']) {
        if (safeName(target) && fs.existsSync(path.join(root, target)) && fs.statSync(path.join(root, target)).isFile()) {
          found.push(target); break;
        }
      }
    }
    return found;
  };
  const paths = entry => {
    const found = new Map();
    const seen = new Set([entry]), queue = [[entry]];
    for (let i = 0; i < queue.length; i++) {
      const chain = queue[i];
      for (const dep of deps(chain.at(-1))) {
        if (!seen.has(dep)) {
          const next = [...chain, dep];
          seen.add(dep); found.set(dep, next); queue.push(next);
        }
      }
    }
    return found;
  };
  return { paths, safeName };
}

// A live require path supplies missing helper declarations, never overrides an
// explicit owner (even a stale one), and never uses the text consumer index.
// Sorting all driver entries makes the choice independent of selection order.
function deriveOwners(root, entries, declared = new Map()) {
  const owners = new Map(declared), graph = requireGraph(root);
  for (const entry of [...entries].sort()) {
    for (const file of graph.paths(entry).keys()) {
      if (file.startsWith('tests/') && /\.[cm]?js$/.test(file) && !entries.has(file) && !owners.has(file)) owners.set(file, entry);
    }
  }
  return owners;
}

function coverageLinks(root, files, entries, owners) {
  let index;
  // A coverage row is proven by the index the loader builds from the Git inventory: a stale or
  // forged stored file never steers it, and the row names the digest of those inputs.
  try { index = require('../protocol-consumers.cjs').loadIndex(root, { cache: false }); } catch { /* graph fallback */ }
  const { paths, safeName } = requireGraph(root), chains = new Map();
  return files.flatMap(file => {
    const entry = entries.has(file) ? file : owners.get(file);
    if (!entry || !entries.has(entry)) return [];
    if (entry === file) return [{ file, entry, source: 'driver' }];
    if (index?.schema === 1 && plain(index.consumers) && Array.isArray(index.consumers[file]) && index.consumers[file].includes(entry)) {
      return [{ file, entry, source: 'consumer-index', index: 'docs/ops/test-consumers.json', inputDigest: index.inputDigest || null }];
    }
    if (!safeName(entry) || !safeName(file)) return [];
    if (!chains.has(entry)) chains.set(entry, paths(entry));
    const chain = chains.get(entry).get(file);
    return chain ? [{ file, entry, source: 'require-graph', path: chain }] : [];
  });
}

// Disjoint partition of SELECTED names (not entry counts: several helpers may
// share one entry). Failed entries still ran; the run result remains red.
function accountCoverage(selected, entryFiles, links, unmapped = []) {
  const ran = [], coveredBy = [], refused = [], unaccounted = [];
  const executed = new Set(entryFiles), missing = new Set(unmapped);
  for (const file of selected) {
    const link = links.find(row => row.file === file);
    if (missing.has(file)) refused.push({ file, code: 'NO_DRIVER_ENTRY_OR_OWNER' });
    else if (!link) refused.push({ file, code: 'OWNER_COVERAGE_UNPROVEN' });
    else if (!executed.has(link.entry)) refused.push({ file, entry: link.entry, code: 'ENTRY_NOT_CONFIRMED_RUN' });
    else if (file === link.entry) ran.push(file);
    else coveredBy.push({ ...link });
  }
  const accounted = [...ran, ...coveredBy.map(row => row.file), ...refused.map(row => row.file)];
  for (const file of selected) if (accounted.filter(name => name === file).length !== 1) unaccounted.push(file);
  const complete = unaccounted.length === 0 && new Set(selected).size === selected.length && accounted.length === selected.length;
  return { selected, entryFiles, ran, coveredBy, refused, unaccounted, complete, ok: complete && refused.length === 0 };
}

function main(argv) {
  const args = argv.slice();
  const list = {};
  const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (args.includes('--json')) { list.json = true; args.splice(args.indexOf('--json'), 1); }
  const depthValue = value('--depth');
  if (depthValue !== undefined) { list.depth = Number(depthValue); args.splice(args.indexOf('--depth'), 2); }
  const root = path.resolve(args[0] || '.');
  const base = args[1] && !args[1].startsWith('--') ? args[1] : 'origin/v2.0.0';
  let author;
  try { author = require('./lib/config.cjs').load({ root }).author; } catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  let result;
  try { result = select({ root, base, depth: list.depth, author }); }
  catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  if (list.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${path.basename(root)} changed=${result.changed} selected=${result.selected}/${result.enrolled}\n${estimateLine(result)}\n`);
  const warning = capLine(result);
  if (warning) process.stderr.write(`${warning}\n`);
  return 0;
}

module.exports = { select, gitRunner, main, deriveOwners, coverageLinks, accountCoverage, enrollmentOnly, estimateLine, capLine, CAP_MS };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

'use strict';

// Conservative static impact selection. No code from the inspected tree
// is executed. Git's base is compared with the complete worktree (index,
// unstaged changes and non-ignored untracked files), not just HEAD.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// The consumer graph ships next to this selector. A copy without it refuses
// by name when a selection is asked for, never with a module error on load.
function consumerGraph() {
  try {
    return require('./protocol-consumers.cjs');
  } catch (e) {
    if (e.code !== 'MODULE_NOT_FOUND' || fs.existsSync(path.join(__dirname, 'protocol-consumers.cjs'))) throw e;
    throw Error('AFFECTED-CONSUMERS-MISSING: protocol-consumers.cjs is not next to protocol-affected.cjs');
  }
}

// These exercise the validator, enrollment/installation contract and hook
// lifecycle even when a package has only a narrow, statically visible impact.
const SAFETY = Object.freeze({
  'tests/validator.test.cjs': 'safety: validator invariants',
  'tests/manifest.test.cjs': 'safety: manifest enrollment and installation',
  'tests/hooks.test.cjs': 'safety: session hook lifecycle',
  'tests/suite-consumers.test.cjs': 'safety: consumer index freshness',
});
const SOURCE = /\.(?:[cm]?js|json)$/;

function git(root, args, input) {
  const r = spawnSync('git', ['-C', root, ...args], {
    input, windowsHide: true, maxBuffer: 128 * 1024 * 1024,
  });
  if (r.error || r.status !== 0 || r.signal) {
    throw new Error(`affected Git ${args[0]} failed${r.error ? `: ${r.error.code}` : ` (exit ${r.status})`}`);
  }
  return r.stdout;
}

function resolveCommit(root, ref) {
  if (typeof ref !== 'string' || !ref || /[\r\n\0]/.test(ref)) throw new Error('affected base needs a commit ref');
  const sha = git(root, ['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).toString('utf8').trim();
  if (!/^[a-f0-9]{40,64}$/.test(sha)) throw new Error('affected commit resolution failed');
  return sha;
}

function safeName(name) {
  return name && !name.includes('\\') && !name.startsWith('/') && !/^[A-Za-z]:/.test(name) &&
    !name.split('/').some(s => !s || s === '.' || s === '..');
}

function snapshot(root, ref) {
  const sha = resolveCommit(root, ref);
  const rows = git(root, ['ls-tree', '-rz', sha]).toString('utf8').split('\0').filter(Boolean);
  const files = new Map();
  const wanted = [];
  for (const row of rows) {
    const m = /^(\d+) (\w+) ([a-f0-9]+)\t([\s\S]+)$/.exec(row);
    if (!m || !safeName(m[4])) throw new Error('affected unsafe Git inventory');
    const [, mode, type, oid, name] = m;
    if (type !== 'blob' || !['100644', '100755'].includes(mode)) throw new Error('affected unsupported Git file mode');
    files.set(name, { oid, text: null });
    if (SOURCE.test(name)) wanted.push({ oid, name });
  }
  if (wanted.length) {
    const bytes = git(root, ['cat-file', '--batch'], wanted.map(x => x.oid).join('\n') + '\n');
    let offset = 0;
    for (const item of wanted) {
      const end = bytes.indexOf(10, offset);
      const header = bytes.subarray(offset, end).toString('ascii');
      const match = /^([a-f0-9]+) blob (\d+)$/.exec(header);
      if (!match || match[1] !== item.oid) throw new Error('affected incomplete Git batch');
      const size = Number(match[2]);
      offset = end + 1;
      if (offset + size >= bytes.length) throw new Error('affected truncated Git blob');
      files.get(item.name).text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(offset, offset + size));
      offset += size + 1;
    }
  }
  return { sha, files };
}

function workingSnapshot(root) {
  const names = git(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z'])
    .toString('utf8').split('\0').filter(Boolean);
  const files = new Map();
  const realRoot = fs.realpathSync(root);
  for (const name of new Set(names)) {
    if (!safeName(name)) throw new Error('affected unsafe worktree inventory');
    const full = path.join(root, name);
    let stat;
    try { stat = fs.lstatSync(full); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    const real = fs.realpathSync(full);
    const relative = path.relative(realRoot, real);
    if (!stat.isFile() || stat.isSymbolicLink() || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error('affected unsupported worktree link or file');
    }
    const bytes = fs.readFileSync(full);
    const oid = require('node:crypto').createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    files.set(name, { oid, text: SOURCE.test(name) ? new TextDecoder('utf-8', { fatal: true }).decode(bytes) : null });
  }
  return { sha: null, files };
}

// Find JSON files that pin the bytes of changed files via sha256 hashes.
// Pin files contain entries with both "path" and "sha256" fields, including nested snapshots.
function findPinFiles(files, changedFiles) {
  const pinFiles = new Set();
  for (const [fileName, fileInfo] of files) {
    if (!fileName.endsWith('.json') || !fileInfo.text) continue;
    try {
      const parsed = JSON.parse(fileInfo.text);
      const pins = extractPins(parsed, changedFiles);
      if (pins.size > 0) {
        pinFiles.add(fileName);
      }
    } catch {
      // Not valid JSON, skip
    }
  }
  return [...pinFiles].sort();
}

// Recursively extract all pinned file paths from a JSON structure.
function extractPins(obj, changedFiles) {
  const pinned = new Set();
  if (Array.isArray(obj)) {
    for (const item of obj) {
      const nested = extractPins(item, changedFiles);
      nested.forEach(p => pinned.add(p));
    }
  } else if (obj !== null && typeof obj === 'object') {
    // Check if this object has both "path" and "sha256" fields
    if (typeof obj.path === 'string' && typeof obj.sha256 === 'string' && /^[a-f0-9]{64}$/.test(obj.sha256)) {
      if (changedFiles.has(obj.path)) {
        pinned.add(obj.path);
      }
    }
    // Also check nested "snapshot" objects.
    if (obj.snapshot && typeof obj.snapshot === 'object') {
      const snapshotPins = extractPins(obj.snapshot, changedFiles);
      snapshotPins.forEach(p => pinned.add(p));
    }
    // Recursively check all values
    for (const value of Object.values(obj)) {
      const nested = extractPins(value, changedFiles);
      nested.forEach(p => pinned.add(p));
    }
  }
  return pinned;
}

function selectAffected(root, baseRef, options = {}) {
  const consumers = consumerGraph();
  const before = snapshot(root, baseRef);
  const after = options.headRef ? snapshot(root, options.headRef) : workingSnapshot(root);
  const inventory = require('./protocol-test.cjs').discoverTestInventory(root, after.files);
  const tests = inventory.tests;
  if (!tests.length) throw new Error('affected inventory has no tests');
  const indexed = after.files.get(consumers.INDEX_PATH)?.text;
  // Fixtures, historical commits and trees that ship no index (the product,
  // a host) have no committed index. Build the same non-executing graph for
  // those snapshots, never fall back FULL.
  const index = indexed ? JSON.parse(indexed) : consumers.buildIndex(after.files, tests);
  if (index.schema !== 1 || index.depth !== consumers.DEPTH || !index.consumers || !index.directories) {
    throw Error('AFFECTED-INDEX-INVALID: refresh tools/suite-consumers.cjs');
  }
  const previous = consumers.buildIndex(before.files, tests);
  // Rebuild the working overlay: a changed/new reader can introduce an edge
  // before the committed index is refreshed. The equality test still fails.
  const overlay = consumers.buildIndex(after.files, tests, index.gitTree);
  const combined = { consumers: Object.create(null), directories: Object.create(null) };
  for (const key of ['consumers', 'directories']) {
    for (const source of [previous, index, overlay]) for (const [n, list] of Object.entries(source[key])) {
      combined[key][n] = [...new Set([...(combined[key][n] || []), ...list])].sort();
    }
  }
  const tiers = require('./protocol-test.cjs').testTierMetadata(root, inventory, after.files);
  // Only the standard tier is selected through the consumer graph;
  // a mutation oracle enters solely through its target rule below.
  const standard = tests.filter(t => tiers[t]?.tier !== 'mutation');
  const result = consumers.selectIndexed(before.files, after.files, standard, combined);

  // Also select tests that read files pinning the bytes of changed files.
  // Pin files are JSON files containing sha256 hashes next to file paths.
  // When a file changes, any test reading a pin file that references it must run to verify the pin.
  const changedFiles = new Set(result.changed);

  // Also include pin files themselves if they changed
  const pinFiles = findPinFiles(after.files, changedFiles);
  for (const pinFile of pinFiles) {
    // Find all tests that consume this pin file (directly or via the consumer graph)
    let pinConsumers = Object.hasOwn(combined.consumers, pinFile) ? combined.consumers[pinFile] : [];
    if (!pinConsumers.length) {
      const dir = path.posix.dirname(pinFile);
      pinConsumers = Object.hasOwn(combined.directories, dir) ? combined.directories[dir] : [];
    }
    for (const test of pinConsumers) {
      if (standard.includes(test) && !result.files.some(f => f.name === test)) {
        result.files.push({ name: test, reasons: [`pin file consumer: ${pinFile}`], fallbackOnly: false });
      }
    }
  }

  // Also handle the case where a pin file itself changed (not just the files it pins)
  // In this case, we need to check if the changed files include any pin files
  for (const changedFile of changedFiles) {
    if (changedFile.endsWith('.json') && after.files.get(changedFile)?.text) {
      // This is a changed JSON file, it might be a pin file
      // Find all tests that read it
      let consumers = Object.hasOwn(combined.consumers, changedFile) ? combined.consumers[changedFile] : [];
      if (!consumers.length) {
        const dir = path.posix.dirname(changedFile);
        consumers = Object.hasOwn(combined.directories, dir) ? combined.directories[dir] : [];
      }
      for (const test of consumers) {
        if (standard.includes(test) && !result.files.some(f => f.name === test)) {
          result.files.push({ name: test, reasons: [`changed pin file: ${changedFile}`], fallbackOnly: false });
        }
      }
    }
  }

  result.files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const test of standard) if (SAFETY[test] && !result.files.some(f => f.name === test)) {
    result.files.push({ name: test, reasons: [SAFETY[test]], fallbackOnly: false });
  }
  result.deferred = [];
  for (const [name, row] of Object.entries(tiers)) {
    if (row.tier !== 'mutation') continue;
    // Explicit targets or conservative production dependencies read from the
    // suite's require/path graph; a changed oracle file is its own target.
    const targetChanged = result.changed.includes(name) || (row.targets ? row.targets.some(t => result.changed.includes(t)) :
      result.changed.some(t => !inventory.tests.includes(t) && combined.consumers[t]?.includes(name)));
    if (!targetChanged) continue;
    // Without --with-mutations the affected run carries no mutation entry;
    // the deferred oracles are named, never silently dropped.
    if (!options.withMutations) result.deferred.push(name);
    else if (!result.files.some(f => f.name === name)) {
      result.files.push({ name, reasons: ['mutation target changed'], fallbackOnly: false });
    }
  }
  result.deferred.sort();
  result.files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (result.unknown.length) throw Error(result.unknown.join('; '));
  const executionFiles = [...new Set(result.files.map(f => inventory.owners[f.name]))].sort();
  return { base: before.sha, head: after.sha, ...result, executionFiles, executionTotal: inventory.entries.length };
}

// Public pure selector shares the indexed contract, including named refusal.
function selectConsumerSnapshots(before, after, tests) {
  const consumers = consumerGraph();
  const previous = consumers.buildIndex(before, tests), next = consumers.buildIndex(after, tests);
  for (const key of ['consumers', 'directories']) for (const [name, rows] of Object.entries(previous[key])) {
    next[key][name] = [...new Set([...(next[key][name] || []), ...rows])].sort();
  }
  const result = consumers.selectIndexed(before, after, tests, next);
  for (const name of tests) if (after.has(name) && SAFETY[name] && !result.files.some(f => f.name === name)) {
    result.files.push({ name, reasons: [SAFETY[name]], fallbackOnly: false });
  }
  result.files.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return result;
}
module.exports = { selectAffected, selectSnapshots: selectConsumerSnapshots, snapshot, workingSnapshot, SAFETY };

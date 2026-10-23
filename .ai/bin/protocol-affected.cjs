'use strict';

// Conservative static impact selection. No code from the inspected tree
// is executed. Git's base is compared with the complete worktree (index,
// unstaged changes and non-ignored untracked files), not just HEAD.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { builtinModules, isBuiltin } = require('node:module');

// These exercise the validator, enrollment/installation contract and hook
// lifecycle even when a package has only a narrow, statically visible impact.
const SAFETY = Object.freeze({
  'tests/validator.test.cjs': 'safety: validator invariants',
  'tests/manifest.test.cjs': 'safety: manifest enrollment and installation',
  'tests/hooks.test.cjs': 'safety: session hook lifecycle',
});
const SOURCE = /\.(?:[cm]?js|json)$/;
const builtins = new Set(builtinModules.flatMap(n => [n, `node:${n}`]));

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

function resolveModule(files, from, spec) {
  const relative = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
  for (const p of [relative, ...['.js', '.cjs', '.mjs', '.json'].map(e => relative + e),
    ...['index.js', 'index.cjs', 'index.mjs', 'index.json'].map(n => `${relative}/${n}`)]) {
    if (files.has(p)) return p;
  }
  // package.json "main" and external resolution are deliberately unknown.
  return null;
}

function graph(files) {
  const edges = new Map();
  const uncertain = new Set();
  for (const [name, entry] of files) {
    if (entry.text === null) continue;
    const deps = new Set();
    const source = entry.text;
    const calls = [...source.matchAll(/\brequire\s*\(([\s\S]*?)\)/g)];
    for (const call of calls) {
      const literal = /^\s*(['"])([^'"\\\r\n]+)\1\s*$/.exec(call[1]);
      if (!literal) { uncertain.add(name); continue; }
      const spec = literal[2];
      if (builtins.has(spec) || isBuiltin(spec)) continue;
      const resolved = spec.startsWith('.') ? resolveModule(files, name, spec) : null;
      if (resolved) deps.add(resolved); else uncertain.add(name);
    }
    // Aliased loaders, ESM, escaped specifiers and computed require are outside
    // this static grammar. They cannot establish certainty for a changed file.
    if (/\b(?:import|createRequire|require\.resolve)\b|\brequire\s*\[/.test(source)) uncertain.add(name);
    if (/\brequire\b/.test(source.replace(/\brequire\s*\(([\s\S]*?)\)/g, ''))) uncertain.add(name);
    if (/\b(?:readFileSync|readFile|readdirSync|readdir|spawnSync|spawn|execFileSync|execFile|execSync|exec|eval|Function)\s*\(/.test(source)) uncertain.add(name);
    // Literal resource paths connect metadata to its consumers,
    // in addition to the static require graph.
    for (const m of source.matchAll(/['"]([^'"\r\n]+)['"]/g)) {
      if (files.has(m[1]) && m[1] !== name) deps.add(m[1]);
    }
    edges.set(name, deps);
  }
  return { edges, uncertain };
}

function selectSnapshots(before, after, tests) {
  tests = [...new Set(tests)].filter(n => after.has(n)).sort();
  const changed = [...new Set([...before.keys(), ...after.keys()])]
    .filter(n => before.get(n)?.oid !== after.get(n)?.oid).sort();
  const reasons = new Map();
  const add = (test, reason) => {
    if (!reasons.has(test)) reasons.set(test, new Set());
    reasons.get(test).add(reason);
  };
  for (const test of tests) if (SAFETY[test]) add(test, SAFETY[test]);
  const graphs = [graph(before), graph(after)];
  const unknown = [];
  // A computed/aliased loader in a reachable consumer could read any changed
  // module without spelling it. Such a graph cannot justify a smaller run.
  if (changed.some(n => !tests.includes(n))) {
    for (const g of graphs) {
      const queue = [...tests], seen = new Set();
      while (queue.length) {
        const node = queue.pop();
        if (seen.has(node)) continue;
        seen.add(node);
        if (g.uncertain.has(node)) unknown.push(`non-static reachable consumer: ${node}`);
        for (const dep of g.edges.get(node) || []) queue.push(dep);
      }
    }
  }
  for (const name of changed) {
    let mapped = false;
    if (tests.includes(name)) { add(name, `changed test: ${name}`); mapped = true; }
    for (const test of tests) {
      for (const files of [before, after]) {
        const text = files.get(test)?.text || '';
        if (text.includes(name) || text.includes(path.posix.basename(name))) {
          add(test, `text reference: ${name}`); mapped = true;
        }
      }
      for (const g of graphs) {
        const queue = [test], seen = new Set();
        while (queue.length) {
          const node = queue.pop();
          if (seen.has(node)) continue;
          seen.add(node);
          if (node === name && node !== test) {
            add(test, `dependency (static require/resource, transitive): ${name}`); mapped = true;
            break;
          }
          for (const dep of g.edges.get(node) || []) queue.push(dep);
        }
      }
    }
    if (!mapped) unknown.push(`unmapped changed file: ${name}`);
    // Runtime-read resources may have unnamed consumers even when one test
    // happens to mention them. Static text matches do not prove completeness.
    if (!/\.[cm]?js$/.test(name) && !tests.includes(name)) unknown.push(`runtime resource or configuration: ${name}`);
    if (graphs.some(g => g.uncertain.has(name))) unknown.push(`non-static loader in changed file: ${name}`);
  }
  if (unknown.length) for (const test of tests) if (!reasons.has(test)) add(test, 'FULL fallback: uncertain impact');
  return {
    changed, fallback: unknown.length > 0, unknown: [...new Set(unknown)].sort(),
    files: [...reasons].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([name, why]) => ({ name, reasons: [...why].sort(),
        fallbackOnly: why.has('FULL fallback: uncertain impact') })),
    total: tests.length,
  };
}

function selectAffected(root, baseRef, options = {}) {
  const before = snapshot(root, baseRef);
  const after = options.headRef ? snapshot(root, options.headRef) : workingSnapshot(root);
  const inventory = require('./protocol-test.cjs').discoverTestInventory(root, after.files);
  const tests = inventory.tests;
  if (!tests.length) throw new Error('affected inventory has no tests');
  const result = selectSnapshots(before.files, after.files, tests);
  const executionFiles = [...new Set(result.files.map(f => inventory.owners[f.name]))].sort();
  return { base: before.sha, head: after.sha, ...result, executionFiles, executionTotal: inventory.entries.length };
}

module.exports = { selectAffected, selectSnapshots, snapshot, SAFETY };

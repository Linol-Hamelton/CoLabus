'use strict';
// Static, non-executing reader index. Substring/path matches are deliberately
// conservative, including comments, so generated/dynamic readers are covered.
const path = require('node:path');
const crypto = require('node:crypto');
const { builtinModules } = require('node:module');
const INDEX_PATH = 'docs/ops/test-consumers.json';
const DEPTH = 8;
// Seat launch files the operator writes, untracked, into a worktree root
// (closed list from the real writers: CERT-PROMPT.md in cert-launch trees,
// FIX-PROMPT.md in fix-launch trees). Only these exact root names are ignored.
const LAUNCH_FILES = Object.freeze(['CERT-PROMPT.md', 'FIX-PROMPT.md']);
const operational = n => LAUNCH_FILES.includes(n) || n.startsWith('.ai/worklog/') || n.startsWith('docs/reviews/') ||
  n.startsWith('docs/ops/journals-archive/');
const code = n => /\.[cm]?js$/.test(n);
const sorted = values => [...new Set(values)].sort();

function buildIndex(files, tests, gitTree = null) {
  const names = [...files.keys()].filter(n => !operational(n)).sort();
  const byBase = new Map(), edges = new Map();
  for (const name of names) {
    const base = path.posix.basename(name);
    if (!byBase.has(base)) byBase.set(base, []);
    byBase.get(base).push(name);
  }
  const builtins = new Set(builtinModules.flatMap(n => [n, `node:${n}`]));
  for (const name of names.filter(code)) {
    const body = files.get(name)?.text || '', deps = new Set();
    for (const m of body.matchAll(/\brequire\s*\(\s*['"]([^'"\r\n]+)['"]\s*\)/g)) {
      if (builtins.has(m[1])) continue;
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(name), m[1]));
      for (const p of [base, base + '.cjs', base + '.js', base + '.json', base + '/index.cjs', base + '/index.js']) {
        if (files.has(p)) { deps.add(p); break; }
      }
    }
    // Equivalent to git grep -F for each path and basename, but one token
    // pass per source. Handles split path.join arguments via basename tokens.
    for (const token of body.match(/[A-Za-z0-9_.-]+/g) || []) {
      for (const target of byBase.get(token) || []) if (target !== name) deps.add(target);
    }
    edges.set(name, deps);
  }
  const reverse = new Map(names.map(n => [n, new Set()]));
  for (const [reader, deps] of edges) for (const dep of deps) reverse.get(dep)?.add(reader);
  const testSet = new Set(tests);
  const consumers = Object.create(null);
  for (const name of names) {
    const seen = new Set([name]), found = new Set(), queue = [[name, 0]];
    for (let i = 0; i < queue.length; i++) {
      const [node, depth] = queue[i];
      if (testSet.has(node)) found.add(node);
      if (depth >= DEPTH) continue;
      for (const reader of reverse.get(node) || []) if (!seen.has(reader)) {
        seen.add(reader); queue.push([reader, depth + 1]);
      }
    }
    consumers[name] = sorted(found);
  }
  const directories = Object.create(null);
  for (const name of names) {
    const dir = path.posix.dirname(name);
    if (dir === '.') continue;
    if (!directories[dir]) directories[dir] = new Set();
    for (const t of consumers[name]) directories[dir].add(t);
  }
  for (const dir of Object.keys(directories)) {
    for (const t of tests) if ((files.get(t)?.text || '').includes(dir)) directories[dir].add(t);
  }
  // Provenance tree is a historical Git anchor. inputDigest covers the exact
  // path inventory and reader overlay (including uncommitted/new readers).
  const digest = crypto.createHash('sha256');
  for (const name of names.filter(n => n !== INDEX_PATH)) {
    digest.update(name + '\0');
    if (code(name)) digest.update(files.get(name)?.text || '');
    digest.update('\0');
  }
  return { schema: 1, gitTree, depth: DEPTH,
    method: 'Git file inventory; static relative require edges plus path/basename token grep over all JS/CJS/MJS readers; reverse consumers through depth 8; directory fallback is union of known consumers and directory literals. Operational journals/reviews excluded. No inspected code is executed.',
    inputDigest: 'sha256:' + digest.digest('hex'), tests: sorted(tests), consumers: Object.fromEntries(Object.entries(consumers)),
    directories: Object.fromEntries(Object.keys(directories).sort().map(n => [n, sorted(directories[n])])) };
}

function selectIndexed(before, after, tests, index) {
  const changed = sorted([...before.keys(), ...after.keys()]).filter(n => !operational(n) && before.get(n)?.oid !== after.get(n)?.oid);
  const selected = new Map(), unknown = [];
  const add = (n, reason) => {
    if (!tests.includes(n) || !after.has(n)) return;
    if (!selected.has(n)) selected.set(n, new Set());
    selected.get(n).add(reason);
  };
  for (const name of changed) {
    let consumers = Object.hasOwn(index.consumers, name) ? index.consumers[name] : [];
    // A known file with an empty list and a new file both fall to the
    // directory consumers, then to the named refusal; never to silence.
    if (!consumers.length) {
      const dir = path.posix.dirname(name);
      consumers = Object.hasOwn(index.directories, dir) ? index.directories[dir] : [];
    }
    if (tests.includes(name)) consumers = sorted([...consumers, name]);
    if (!consumers.length) unknown.push(`AFFECTED-NO-CONSUMER: ${name}`);
    for (const t of consumers) add(t, t === name ? `changed test: ${name}` : `consumer index: ${name}`);
  }
  return { changed, fallback: false, unknown, files: [...selected].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, why]) => ({ name, reasons: sorted(why), fallbackOnly: false })), total: tests.length };
}

module.exports = { buildIndex, selectIndexed, INDEX_PATH, operational, DEPTH, LAUNCH_FILES };

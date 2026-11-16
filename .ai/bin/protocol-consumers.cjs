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

// The closed consumer rule of an affected run (the index above stays the broad map of the tree). An edge is a static
// relative require that resolves to a tracked file, or a quoted literal of a reader that names a tracked file: its
// whole path, a suffix of it with a slash, or its file name when that name is unique in the tree, the reader sits in
// the same folder, or every folder of the path is a literal of the reader. A quoted literal is found at every depth: a
// string, a fixed part of a template, a string in the code of a template interpolation, and a quoted text inside a
// literal (a script a reader hands to a child process). The reader is not parsed as JavaScript, so a quote inside a
// comment adds a candidate (an extra test, never a lost one); an unquoted name (in a comment, in a command line of a
// literal), an identifier and a folder are never an edge. A require loads the file; any other edge reads it (or runs
// it: a launcher names the script it starts). A test consumes every file it reaches through at most LOAD_DEPTH edges of
// either kind, followed transitively from every reader: the test helpers it loads, the code it loads and every file
// that code loads, reads or runs. A chain past the bound is the named refusal AFFECTED-DEPTH, never a cut; a changed
// file without a consumer is the named refusal AFFECTED-NO-CONSUMER, except a document (Markdown or text) that no
// code names, which no test reads.
const LOAD_DEPTH = 12;
const DOCUMENT = /\.(?:md|txt)$/i;
// The raw quoted texts of a source: each string, each fixed part of a template and, through the brace depth of every
// open interpolation, the texts of the code inside it. A string that is never closed ends at its line, a template at
// the end of the source.
function quotedTexts(body) {
  const out = [], open = [];
  let depth = 0, template = false, start = 0;
  for (let i = 0; i < body.length;) {
    const c = body[i];
    if (template) {
      if (c === '\\') i += 2;
      else if (c === '`') { out.push(body.slice(start, i)); template = false; i++; }
      else if (c === '$' && body[i + 1] === '{') { out.push(body.slice(start, i)); open.push(depth); depth = 0; template = false; i += 2; }
      else i++;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < body.length && body[j] !== c && body[j] !== '\n' && body[j] !== '\r') j += body[j] === '\\' ? 2 : 1;
      out.push(body.slice(i + 1, Math.min(j, body.length)));
      i = j + 1;
    } else if (c === '`') { template = true; start = ++i; }
    else if (c === '{') { depth++; i++; }
    else if (c === '}') {
      if (!depth && open.length) { depth = open.pop(); template = true; start = ++i; } else { depth = Math.max(0, depth - 1); i++; }
    } else i++;
  }
  if (template) out.push(body.slice(start));
  return out;
}
const unescape = text => text.replace(/\\(.)/gs, (_, c) => c === '\\' ? '/' : 'nrt'.includes(c) ? ' ' : c);
function literalsOf(body, reader) {
  const out = new Set(), dir = path.posix.dirname(reader), seen = new Set();
  const add = raw => {
    if (!raw || raw.length > 300) return;
    const bare = raw.replace(/^(?:\.{1,2}\/)+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
    if (bare) out.add(bare);
    if (raw.startsWith('.')) {
      const near = path.posix.normalize(path.posix.join(dir, raw)).replace(/\/+$/, '');
      if (near && !near.startsWith('..')) out.add(near);
    }
  };
  // Each nested text is shorter than the text it sits in, so the walk ends.
  for (let work = quotedTexts(body); work.length;) {
    const text = unescape(work.pop());
    if (!text || seen.has(text)) continue;
    seen.add(text);
    add(text);
    if (/['"`]/.test(text)) work.push(...quotedTexts(text));
  }
  return out;
}
const push = (map, key, value) => { if (!map.has(key)) map.set(key, []); map.get(key).push(value); };
function closedGraph(files) {
  const names = [...files.keys()].filter(n => !operational(n)).sort(), known = new Set(names);
  const byBase = new Map(), bySuffix = new Map(), loadBy = new Map(), readBy = new Map();
  for (const name of names) {
    const segments = name.split('/');
    push(byBase, segments[segments.length - 1], name);
    for (let i = 1; i < segments.length - 1; i++) push(bySuffix, segments.slice(i).join('/'), name);
  }
  const builtins = new Set(builtinModules.flatMap(n => [n, `node:${n}`]));
  const edge = (map, target, reader) => { if (target !== reader) { if (!map.has(target)) map.set(target, new Set()); map.get(target).add(reader); } };
  for (const reader of names.filter(code)) {
    const body = files.get(reader)?.text || '', dir = path.posix.dirname(reader);
    for (const m of body.matchAll(/\brequire\s*\(\s*['"]([^'"\r\n]+)['"]\s*\)/g)) {
      if (builtins.has(m[1])) continue;
      const base = path.posix.normalize(path.posix.join(dir, m[1]));
      const hit = [base, base + '.cjs', base + '.js', base + '.json', base + '/index.cjs', base + '/index.js'].find(p => known.has(p));
      if (hit) edge(loadBy, hit, reader);
    }
    const literals = literalsOf(body, reader), folders = new Set([...literals].flatMap(l => l.split('/')));
    for (const literal of literals) {
      const targets = known.has(literal) ? [literal] : [];
      if (literal.includes('/')) targets.push(...(bySuffix.get(literal) || []));
      else for (const target of byBase.get(literal) || []) {
        const at = path.posix.dirname(target);
        if (byBase.get(literal).length === 1 || at === dir || at === '.' || at.split('/').every(s => folders.has(s))) targets.push(target);
      }
      for (const target of targets) edge(readBy, target, reader);
    }
  }
  return { loadBy, readBy };
}
// The tests of `tests` that consume `name` in one graph, and whether a chain ran past the bound. Every edge is followed
// transitively: a file that loads or names `name`, every file that loads or names such a file, and so on; a reader is
// code, so a file that names it may run it.
function closedConsumers(graph, tests, name) {
  const testSet = new Set(tests), found = new Set(), seen = new Set([name]);
  let cut = false;
  for (let level = [name], depth = 0; level.length; depth++) {
    const next = [];
    for (const node of level) {
      if (testSet.has(node)) found.add(node);
      for (const reader of [...(graph.loadBy.get(node) || []), ...(graph.readBy.get(node) || [])]) if (!seen.has(reader)) {
        if (depth >= LOAD_DEPTH) { cut = true; continue; }
        seen.add(reader); next.push(reader);
      }
    }
    level = next;
  }
  return { tests: found, cut };
}
// before/after: Map name -> { oid, text }; a changed file takes the consumers of both trees (a deleted one keeps
// those of the base, a new reader counts from the head). Only tests of the head are selected; a test of mapOnly (an
// oracle of another tier) maps a file it consumes and is never selected through the graph; a file of targets (the
// declared targets of such oracles) is mapped by them.
function selectClosed(before, after, tests, { graphs = [closedGraph(before), closedGraph(after)], mapOnly = [], targets = [] } = {}) {
  const changed = sorted([...before.keys(), ...after.keys()]).filter(n => !operational(n) && before.get(n)?.oid !== after.get(n)?.oid);
  const selected = new Map(), unknown = [], documents = [], every = [...tests, ...mapOnly];
  const add = (n, reason) => {
    if (!tests.includes(n) || !after.has(n)) return;
    if (!selected.has(n)) selected.set(n, new Set());
    selected.get(n).add(reason);
  };
  for (const name of changed) {
    const found = new Set(every.includes(name) ? [name] : []);
    let cut = false;
    for (const graph of graphs) {
      const r = closedConsumers(graph, every, name);
      for (const t of r.tests) found.add(t);
      cut = cut || r.cut;
    }
    if (cut) unknown.push(`AFFECTED-DEPTH: ${name} is loaded through more than ${LOAD_DEPTH} files`);
    else if (!found.size && DOCUMENT.test(name)) documents.push(name);
    else if (!found.size && !targets.includes(name)) unknown.push(`AFFECTED-NO-CONSUMER: ${name}`);
    for (const t of found) add(t, t === name ? `changed test: ${name}` : `consumer: ${name}`);
  }
  return { changed, fallback: false, unknown, documents, files: [...selected].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([name, why]) => ({ name, reasons: sorted(why), fallbackOnly: false })), total: tests.length };
}

module.exports = { buildIndex, selectIndexed, closedGraph, closedConsumers, selectClosed, literalsOf, INDEX_PATH, operational, DEPTH, LOAD_DEPTH, LAUNCH_FILES };

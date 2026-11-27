'use strict';
// PowerShell is reserved for Windows integration. Existing portable uses are debt.
// This bounded static detector never executes the source it inspects.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { TextDecoder } = require('node:util');
const crypto = require('node:crypto');
const FILE = '.ai/docs/powershell-inventory.json';
const CHECK = 'CM-84';
const PURPOSES = ['process-list', 'process-kill', 'scheduled-task', 'acl', 'account', 'hash', 'service', 'other'];
const CLASSES = ['windows-integration', 'portable-fact'];
const NOTICE = 'Interim hand-reviewed inventory; replace with platform-module facts in 2.0.4; no manual tables after 2.0.4.';
const REMEDY = 'PowerShell is allowed only for Windows integration; a new use needs an owner decision and a row in the inventory with its decision id.';
const fail = message => { throw new Error(message); };
const safePath = v => typeof v === 'string' && v.length > 0 && !/[\x00-\x1f\\:]/.test(v) && !v.startsWith('/') && v.split('/').every(s => s && s !== '.' && s !== '..');

function git(root, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_/i.test(key)) delete env[key];
  const r = spawnSync('git', ['--no-pager', '-c', 'color.ui=false', '-c', 'core.quotePath=false', '-C', root, ...args],
    { encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 64 * 1024 * 1024, env });
  if (r.error || r.status !== 0) fail(`git ${args[0]} unavailable for PowerShell inventory`);
  return r.stdout;
}

function read(root, rel) {
  if (!safePath(rel)) fail(`unsafe inventory path: ${JSON.stringify(rel)}`);
  // Refuse links at every component, including a symlink directory leaving the root.
  let full = root;
  for (const part of rel.split('/')) {
    full = path.join(full, part);
    if (fs.lstatSync(full).isSymbolicLink()) fail(`unreadable inventory input (symlink): ${rel}`);
  }
  const st = fs.statSync(full);
  if (!st.isFile() || st.size > 8 * 1024 * 1024) fail(`unreadable inventory input: ${rel}`);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(fs.readFileSync(full)); }
  catch (e) { fail(`unreadable inventory input: ${rel} (${e.code || 'invalid-utf8'})`); }
}

function tracked(root) {
  const out = git(root, ['ls-files', '--stage', '-z']);
  const rows = out.split('\0').filter(Boolean).map(row => {
    const m = /^(\d{6}) [a-f0-9]+ (\d)\t([\s\S]+)$/.exec(row);
    if (!m || m[2] !== '0') fail('git ls-files: malformed or unmerged PowerShell inventory input');
    return { mode: m[1], path: m[3] };
  });
  return rows;
}

// Strings/comments are tokenized, so a quoted reproduction is not an actual call.
// Template interpolation is retained as an unknown fragment. This is not a JS parser.
function tokens(source) {
  const out = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i], start = i;
    if (/\s/.test(c)) { i++; continue; }
    if (source.startsWith('//', i) || (i === 0 && source.startsWith('#!'))) {
      const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; continue;
    }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
    const last = out[out.length - 1];
    const regexAllowed = !last || (!last.string && (/^[=(:,!&|?;{\[]$/.test(last.text) || /^(?:return|throw|case|typeof|void|=>)$/.test(last.text)));
    if (c === '/' && regexAllowed) {
      i++; let bracket = false;
      while (i < source.length && source[i] !== '\n') {
        const x = source[i++];
        if (x === '\\') { i++; continue; }
        if (x === '[') bracket = true;
        if (x === ']') bracket = false;
        if (x === '/' && !bracket) break;
      }
      while (/[a-z]/i.test(source[i] || '') && i < source.length) i++;
      out.push({ text: '<regexp>' }); continue;
    }
    if (/['"`]/.test(c)) {
      i++;
      while (i < source.length) { const x = source[i++]; if (x === '\\') i++; else if (x === c) break; }
      const raw = source.slice(start, i);
      const value = raw.slice(1, -1).replace(/\\(?:x([a-f\d]{2})|u([a-f\d]{4})|([\s\S]))/gi,
        (_, x, u, c) => x || u ? String.fromCharCode(parseInt(x || u, 16)) : ({ n: '\n', r: '\r', t: '\t' }[c] || c));
      out.push({ text: raw, value, string: true });
    } else if (/[A-Za-z_$]/.test(c)) {
      i++; while (i < source.length && /[\w$]/.test(source[i])) i++;
      out.push({ text: source.slice(start, i) });
    } else { i++; out.push({ text: c }); }
  }
  return out;
}

function argumentsAt(ts, start) {
  const args = []; let current = []; const stack = [];
  for (let i = start + 1; i < ts.length; i++) {
    const s = ts[i].string ? '' : ts[i].text;
    if (s === ')' && !stack.length) { args.push(current); return args; }
    if (s === ',' && !stack.length) { args.push(current); current = []; continue; }
    if (['(', '[', '{'].includes(s)) stack.push(s);
    else if ([')', ']', '}'].includes(s)) stack.pop();
    current.push(ts[i]);
  }
  return [];
}

function valueOf(ts, vars) {
  const parts = ts.map(t => t.string ? t.value : vars.get(t.text) || (/^(?:PROTOCOL_TEST_POWERSHELL|PWSH|POWERSHELL|PS_EXE)$/i.test(t.text) ? 'powershell' : ''));
  return parts.join(' ') + '\n' + parts.join('');
}
function executable(value, native) {
  return (native ? /(?:^|[\/\\\s"'])(?:powershell|pwsh|fsutil|icacls)(?:\.exe)?(?=$|[\s"'])/i :
    /(?:^|[\/\\\s"'])(?:powershell|pwsh)(?:\.exe)?(?=$|[\s"'])/i).test(value);
}

// Resolve ordinary Node imports and promisify without running imported code.
const PROCESS_METHOD = /^(?:spawn(?:Sync)?|exec(?:File)?(?:Sync)?)$/;
function bindingValue(ts, bindings) {
  if (ts.length === 1 && !ts[0].string) return bindings.get(ts[0].text);
  if (ts.length === 4 && ts[0].text === 'require' && ts[1].text === '(' && ts[2].string && ts[3].text === ')') {
    if (/^(?:node:)?child_process$/.test(ts[2].value)) return 'process-module';
    if (/^(?:node:)?util$/.test(ts[2].value)) return 'util-module';
  }
  const n = ts.length;
  if (n > 2 && ts[n - 2].text === '.') {
    const owner = bindingValue(ts.slice(0, -2), bindings), key = ts[n - 1].text;
    if (owner === 'process-module' && PROCESS_METHOD.test(key)) return 'process-call';
    if (owner === 'util-module' && key === 'promisify') return 'promisify';
  }
  if (ts[n - 1]?.text === ')') {
    let depth = 0;
    for (let i = n - 1; i >= 0; i--) {
      if (ts[i].string) continue;
      if (ts[i].text === ')') depth++;
      if (ts[i].text === '(' && --depth === 0) {
        if (bindingValue(ts.slice(0, i), bindings) === 'promisify' &&
          bindingValue(ts.slice(i + 1, -1), bindings) === 'process-call') return 'process-call';
        break;
      }
    }
  }
  return undefined;
}
function importBindings(ts) {
  const bindings = new Map();
  for (let pass = 0; pass < 4; pass++) {
    const before = bindings.size;
    for (let i = 0; i < ts.length; i++) {
    if (ts[i].text === '{') {
      let end = i + 1;
      while (end < ts.length && end < i + 180 && ts[end].text !== '}') end++;
      if (ts[end]?.text !== '}') continue;
      let owner;
      if (ts[end + 1]?.text === '=') owner = bindingValue(ts.slice(end + 2, end + 6), bindings);
      if (ts[end + 1]?.text === 'from' && ts[end + 2]?.string) {
        const moduleName = ts[end + 2].value;
        owner = /^(?:node:)?child_process$/.test(moduleName) ? 'process-module' : /^(?:node:)?util$/.test(moduleName) ? 'util-module' : undefined;
      }
      for (let j = i + 1; j < end; j++) {
        const key = ts[j].text;
        const kind = owner === 'process-module' && PROCESS_METHOD.test(key) ? 'process-call' : owner === 'util-module' && key === 'promisify' ? 'promisify' : undefined;
        if (!kind) continue;
        const alias = [':', 'as'].includes(ts[j + 1]?.text) ? ts[j + 2]?.text : key;
        if (alias) bindings.set(alias, kind);
      }
    }
    if (/^[A-Za-z_$][\w$]*$/.test(ts[i].text) && ts[i + 1]?.text === '=') {
      let end = i + 2, depth = 0;
      for (; end < ts.length && end < i + 180; end++) {
        if (ts[end].string) continue;
        const s = ts[end].text;
        if (!depth && [';', ','].includes(s)) break;
        if (['(', '[', '{'].includes(s)) depth++;
        if ([')', ']', '}'].includes(s)) { if (!depth) break; depth--; }
      }
      const kind = bindingValue(ts.slice(i + 2, end), bindings);
      if (kind) bindings.set(ts[i].text, kind);
    }
    }
    if (bindings.size === before) break;
  }
  return bindings;
}

function detect(source, native = false) {
  if (!/(?:spawn|exec|run|invoke|query|resolveJobShell)/i.test(source)) return [];
  if (!/power|pwsh|fsutil|icacls|-NoProfile|-EncodedCommand|\\[xu]|['"`](?:p|po|pow|powe|wer|shell|pw|pws)['"`]/i.test(source)) return [];
  const ts = tokens(source), vars = new Map(), bindings = /child_process|promisify/.test(source) ? importBindings(ts) : new Map();
  // A union of values, deliberately scope-insensitive and conservative. Forward bindings
  // and small literal concatenations/array joins are resolved without evaluating code.
  for (let pass = 0; pass < 4; pass++) {
    const before = vars.size;
    for (let i = 0; i < ts.length - 2; i++) {
      if (!/^[A-Za-z_$][\w$]*$/.test(ts[i].text) || ts[i + 1].text !== '=') continue;
      let end = i + 2, depth = 0;
      for (; end < ts.length && end < i + 180; end++) {
        const s = ts[end].string ? '' : ts[end].text;
        if (!depth && [';', '\n'].includes(s)) break;
        if (['(', '[', '{'].includes(s)) depth++;
        if ([')', ']', '}'].includes(s)) { if (depth === 0) break; depth--; }
      }
      const rhs = ts.slice(i + 2, end);
      // A process result (or an arbitrary function result) is not an executable.
      if (rhs.some((t, k) => rhs[k + 1]?.text === '(' && /^[A-Za-z_$]/.test(t.text) &&
        !/^(?:join|resolve|resolveCommand|resolveJobShell|powershell)$/.test(t.text))) continue;
      const value = valueOf(rhs, vars);
      if (executable(value, native)) vars.set(ts[i].text, ' powershell ');
    }
    if (vars.size === before) break;
  }
  const hits = [];
  for (let i = 0; i < ts.length - 1; i++) {
    if (ts[i].string || ts[i + 1].text !== '(') continue;
    const name = ts[i].text;
    if (/^(?:runPowerShell|powershell|pwsh)$/i.test(name) && ts[i - 1]?.text !== 'function') {
      hits.push(name); continue;
    }
    const parenthesized = name === ')' && ts.slice(Math.max(0, i - 8), i).some(t => /^(?:invokeExternal|spawnSync|spawn)$/.test(t.text));
    let bound = bindings.get(name) === 'process-call';
    if (name === ')') {
      let start = i;
      while (start > 0 && i - start < 180 && ![';', '=', '{', '}'].includes(ts[start - 1].text)) start--;
      bound = bindingValue(ts.slice(start, i + 1), bindings) === 'process-call';
    }
    if (!bound && !parenthesized && !/^(?:spawn(?:Sync)?|exec(?:File)?(?:Sync|Text)?|invokeExternal|run(?:Argv|Checked|Shell)?|resolveJobShell|query)$/i.test(name)) continue;
    if (name === 'exec' && ts[i - 1]?.text === '.' && !['this', 'cp', 'childProcess', 'child_process'].includes(ts[i - 2]?.text) && bindings.get(ts[i - 2]?.text) !== 'process-module') continue;
    if (ts[i - 1]?.text === 'function') continue;
    const args = argumentsAt(ts, i + 1);
    const first = valueOf(args[0] || [], vars);
    const flags = valueOf(args[1] || [], vars);
    const envCommand = (args[0] || []).some(t => t.text === 'env');
    if (executable(first, native) || (envCommand && /-(?:NoProfile|EncodedCommand)/i.test(flags)) ||
      (/\bcmd(?:\.exe)?\b/i.test(first) && executable(flags, native))) hits.push(name);
  }
  return [...new Set(hits)];
}

const isTest = rel => rel.startsWith('tests/') || /(?:^|\/)[^/]+\.test\.[cm]?js$/i.test(rel);
function emittedCalls(source, native) {
  if (!/writeFile|\.replace\(|runIn(?:New|This)Context|_compile|commandFor/.test(source)) return false;
  return tokens(source).some(t => t.string && executable(t.value, native) &&
    (detect(t.value, native).length > 0 || /-(?:NoProfile|EncodedCommand)/i.test(t.value)));
}
function scan(root, { role = 'source', owned = [], exclusions = [] } = {}) {
  const files = [], tests = [], ownerSet = new Set(owned);
  const excluded = new Map(exclusions.map(r => [r.path, r]));
  // An installed host needs no Git or shell: the shipped ownership projection
  // supplies the finite file set, and files absent from a partial install skip.
  const inputs = role === 'installed' ? [...ownerSet].filter(rel => {
    if (!safePath(rel)) fail(`unsafe inventory path: ${JSON.stringify(rel)}`);
    return fs.existsSync(path.join(root, rel));
  }).map(rel => ({ path: rel, mode: '100644' })) : tracked(root);
  for (const row of inputs) {
    const rel = row.path;
    const script = /\.ps1$/i.test(rel);
    const code = /\.[cm]?js$/i.test(rel) && /^(?:\.ai\/bin|tools|docs\/ops|tests)\//.test(rel);
    if (!script && !code) continue;
    if (!['100644', '100755'].includes(row.mode)) fail(`unreadable inventory input (git mode ${row.mode}): ${rel}`);
    let source;
    try { source = read(root, rel); } catch (e) { fail(`cannot read ${rel}: ${e.code || e.message}`); }
    const exclusion = excluded.get(rel);
    if (exclusion && crypto.createHash('sha256').update(source).digest('hex') === exclusion.sha256) continue;
    const test = isTest(rel);
    if (script || detect(source, test).length || emittedCalls(source, test)) {
      (test ? tests : files).push({ path: rel, kind: script ? 'script' : 'caller' });
    }
  }
  return { files, tests };
}

function ceilings({ files, tests }) {
  return { scripts: files.filter(r => r.kind === 'script').length,
    callers: files.filter(r => r.kind === 'caller').length, tests: tests.length };
}
function validatePart(part, label, kernel = false) {
  if (!part || !Array.isArray(part.files) || !Array.isArray(part.tests) || !part.ceilings) fail(`${FILE}: malformed ${label}`);
  const seen = new Set();
  for (const r of part.exclusions || []) {
    if (!safePath(r.path) || !/^[a-f0-9]{64}$/.test(r.sha256 || '') || typeof r.reason !== 'string' || !r.reason.trim()) fail(`${FILE}: malformed exclusion in ${label}`);
  }
  for (const [list, rows] of [['files', part.files], ['tests', part.tests]]) for (const r of rows) {
    if (!r || !safePath(r.path) || !['script', 'caller'].includes(r.kind) ||
      !PURPOSES.includes(r.purpose) || !CLASSES.includes(r.class) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(r.addedDate) || ((!kernel || r.landing !== undefined) && !/^[a-f0-9]{40}$/.test(r.landing || '')) ||
      (list === 'files' && typeof r.shipped !== 'boolean') || (kernel && list === 'files' && r.shipped !== true) ||
      (r.decision !== null && !/^(?:PROTO-DEC|DEC)-\d{4}$/.test(r.decision || '')) || seen.has(r.path)) fail(`${FILE}: malformed or duplicate row in ${label}: ${r?.path}`);
    seen.add(r.path);
  }
  const actual = ceilings(part);
  for (const key of Object.keys(actual)) if (!Number.isInteger(part.ceilings[key]) || part.ceilings[key] !== actual[key]) fail(`${FILE}: malformed ${label} ceiling ${key}`);
  return part;
}
function load(root, { source = true } = {}) {
  let data;
  try { data = JSON.parse(read(root, FILE)); } catch (e) { fail(`${FILE}: unreadable or malformed inventory (${e.code || e.message})`); }
  const h = data?.inventory?.[0];
  if (!h || data.inventory.length !== 1 || h.schema !== 'powershell-inventory/1' || h.notice !== NOTICE || !/^\d{4}-\d{2}-\d{2}$/.test(h.asOf || '')) fail(`${FILE}: malformed inventory header`);
  validatePart(h.kernel, 'kernel', true);
  if (h.kernel.owned !== undefined && (!Array.isArray(h.kernel.owned) ||
    h.kernel.owned.some(p => !safePath(p)) || new Set(h.kernel.owned).size !== h.kernel.owned.length)) fail(`${FILE}: malformed kernel ownership`);
  if (source && h.source) {
    validatePart(h.source, 'source');
    if (JSON.stringify(h.kernel.files) !== JSON.stringify(h.source.files.filter(r => r.shipped))) fail(`${FILE}: kernel projection differs from shipped source rows`);
  }
  return h;
}

function compare(actual, baseline, report) {
  for (const name of ['files', 'tests']) {
    const expected = new Map(baseline[name].map(r => [r.path, r]));
    const present = new Set(actual[name].map(r => r.path));
    for (const row of actual[name]) if (!expected.has(row.path) || expected.get(row.path).kind !== row.kind) {
      report(CHECK, 'FAIL', `PowerShell inventory: new ${row.kind}: ${row.path}. ${REMEDY}`, row.path);
    }
    for (const row of baseline[name]) if (!present.has(row.path)) report(CHECK, 'WARN',
      `PowerShell inventory: removed use: ${row.path}; rerun the inventory generator.`, row.path);
  }
  const count = ceilings(actual);
  for (const key of Object.keys(count)) if (count[key] > baseline.ceilings[key]) report(CHECK, 'FAIL', `PowerShell inventory ceiling exceeded: ${key}=${count[key]} > ${baseline.ceilings[key]}. ${REMEDY}`, FILE);
  const debt = name => baseline[name].filter(r => r.class === 'portable-fact' && actual[name].some(a => a.path === r.path)).length;
  report(CHECK, 'PASS', `PowerShell inventory: scripts=${count.scripts} callers=${count.callers} tests=${count.tests}; portable-fact debt: files=${debt('files')} tests=${debt('tests')}`, FILE);
  return count;
}

function check(root, manifest, report) {
  try {
    const h = load(root, { source: manifest.role !== 'installed' }), installed = manifest.role === 'installed' || !h.source;
    const sourceGenerator = ['tools', ['powershell', 'inventory.cjs'].join('-')].join('/');
    if (manifest.role === 'source' && (manifest.required || []).includes(sourceGenerator) && !h.source) fail(`${FILE}: missing source inventory`);
    let baseline = installed ? h.kernel : h.source;
    if (!baseline) fail(`${FILE}: missing source inventory`);
    // Ownership is the product's positive projection, never a directory prefix
    // or the source manifest's broader required set. Hosts may keep extra files.
    let owned = baseline.owned;
    if (installed && !Array.isArray(owned)) fail(`${FILE}: missing kernel ownership projection`);
    if (manifest.role === 'installed') {
      const required = new Set(manifest.required || []);
      const tests = baseline.tests.filter(r => required.has(r.path));
      const optionalTests = new Set(baseline.tests.filter(r => !required.has(r.path)).map(r => r.path));
      owned = owned.filter(p => required.has(p) && !optionalTests.has(p));
      // Missing components are normal for kernel-only / pilot-only installs.
      // Warn about a removed use only in files actually installed in this host.
      const files = baseline.files.filter(r => required.has(r.path));
      baseline = { ...baseline, files, tests, ceilings: ceilings({ files, tests }) };
    }
    const actual = scan(root, { role: installed ? 'installed' : 'source', owned, exclusions: baseline.exclusions });
    return compare(actual, baseline, report);
  } catch (e) { report(CHECK, 'FAIL', `PowerShell inventory unavailable: ${e.message}`, FILE); return null; }
}

module.exports = { FILE, CHECK, PURPOSES, CLASSES, NOTICE, REMEDY, git, read, tracked, tokens, detect, emittedCalls, scan, ceilings, validatePart, load, compare, check };

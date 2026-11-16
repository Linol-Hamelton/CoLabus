'use strict';
// Forwarding stubs for the old entry points. The operator tools used to live only outside
// the repository; a running session or an old script still calls those names. This tool
// writes a small CommonJS forwarder at the old path that runs the tracked tool. It never
// overwrites a real implementation without --force, and it never writes outside the named
// root. The originals are not edited by the author of this package.
//   node .ai/bin/ops-tools/legacy-stub.cjs --root DIR [--repo DIR] [--check|--write] [--force]
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./lib/config.cjs');

const MARKER = 'Compatibility forwarding stub';
const PACKAGE = path.resolve(__dirname);

function stubSource(target) {
  return [
    '#!/usr/bin/env node',
    "'use strict';",
    `// ${MARKER}: the implementation is the tracked kernel tool. Written by .ai/bin/ops-tools/legacy-stub.cjs.`,
    `const target = ${JSON.stringify(target.replace(/\\/g, '/'))};`,
    'process.argv[1] = target;',
    "require('node:module').runMain(target);",
    '',
  ].join('\n');
}

function plan(options) {
  const root = path.resolve(options.legacyRoot);
  const repo = path.resolve(options.repo || path.resolve(PACKAGE, '..', '..'));
  const names = options.names;
  const rows = names.map(name => {
    const target = path.join(repo, '.ai', 'bin', 'ops-tools', name);
    const file = path.join(root, name);
    const expected = stubSource(target);
    let exists = false;
    let current = null;
    try { current = fs.readFileSync(file, 'utf8'); exists = true; } catch { /* absent */ }
    const state = !exists ? 'absent' : current === expected ? 'stub' : current.includes(MARKER) ? 'stale-stub' : 'real-file';
    return { name, file, target, expected, state };
  });
  const blocked = rows.filter(row => row.state === 'real-file' && !options.force);
  return { root, repo, rows, blocked };
}

function write(options) {
  const result = plan(options);
  if (result.blocked.length) {
    return { ok: false, code: 'LEGACY-REAL-FILE', result, lines: result.blocked.map(row => `REFUSED LEGACY-REAL-FILE: ${row.file} is not a forwarding stub; pass --force to replace it deliberately`) };
  }
  fs.mkdirSync(result.root, { recursive: true });
  const written = [];
  for (const row of result.rows) {
    if (row.state === 'stub') continue;
    fs.writeFileSync(row.file, row.expected, 'utf8');
    written.push(row.file);
  }
  return { ok: true, result, written, lines: written.map(file => `LEGACY-STUB written ${file}`) };
}

function check(options) {
  const result = plan(options);
  const problems = result.rows.filter(row => row.state === 'absent' || row.state === 'stale-stub' || row.state === 'real-file');
  return {
    ok: problems.length === 0, result, problems,
    lines: problems.length
      ? problems.map(row => `LEGACY-STUB ${row.state}: ${row.file}`)
      : result.rows.map(row => `LEGACY-STUB ok: ${row.file}`),
  };
}

function main(argv) {
  const args = argv.slice();
  const value = name => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const root = value('--root');
  const repo = value('--repo');
  const writeMode = args.includes('--write');
  const checkMode = args.includes('--check') || !writeMode;
  const force = args.includes('--force');
  if (args.includes('--write')) args.splice(args.indexOf('--write'), 1);
  if (args.includes('--check')) args.splice(args.indexOf('--check'), 1);
  if (args.includes('--force')) args.splice(args.indexOf('--force'), 1);
  if (!root || args.length) { process.stderr.write('usage: legacy-stub.cjs --root DIR [--repo DIR] [--check|--write] [--force]\n'); return 2; }
  let cfg;
  try { cfg = load({ root: repo || process.cwd() }); } catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  const options = { legacyRoot: root, repo: repo ? path.resolve(repo) : cfg.root, names: cfg.legacyNames, force };
  const result = writeMode ? write(options) : check(options);
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  if (writeMode) return result.ok ? 0 : 1;
  return checkMode && result.ok ? 0 : 1;
}

module.exports = { MARKER, stubSource, plan, write, check, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

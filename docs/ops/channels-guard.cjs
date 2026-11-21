#!/usr/bin/env node
'use strict';
// channels-guard: refuse to commit files named like key stores, and files whose content has the shape of a secret
// (Class B tooling). Read-only: it never edits the index, the hooks or .gitignore.
//   node docs/ops/channels-guard.cjs check [--staged] [--root DIR] [file...]   exit 1 on a key-store name or a secret-shaped line
//   node docs/ops/channels-guard.cjs gitignore-check [--root DIR]               exit 1 when recommended .gitignore lines are missing
//   node docs/ops/channels-guard.cjs hook-snippet                               prints a pre-commit snippet for the USER to install
// Output is file:line and a reason only, never the matching text. The content scan reuses the SECRETS patterns of
// launch-record-validate (through channels-lib) plus the local pattern set LOCAL_SECRETS of channels-lib. A pre-commit hook lives in the git directory, which a linked worktree shares
// with the main checkout, so this tool prints the snippet and never installs it.
// Exit: 0 clean, 1 problem found, 2 usage error.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const lib = require('./channels-lib.cjs');

const ALLOWED_SUFFIX = /\.(example|sample|template|dist)$/i;
const NAME_RULES = [
  [/^\.env$/i, 'environment file'],
  [/^\.env\./i, 'environment file'],
  [/\.env$/i, 'environment file'],
  [/\.(key|pem|p12|pfx|jks|keystore|ppk)$/i, 'key or certificate store'],
  [/^id_(rsa|dsa|ecdsa|ed25519)$/i, 'ssh private key'],
  [/^\.?credentials(\.json)?$/i, 'credentials file'],
  [/^auth\.json$/i, 'client auth file'],
  [/^secrets?\.(json|ya?ml|toml|env)$/i, 'secrets file'],
  [/\.secrets?$/i, 'secrets file'],
  [/^\.netrc$/i, 'netrc credentials'],
  [/^KEYSTORE_[A-Z0-9]+_[A-Z][A-Z0-9]*$/, 'file named like a stored key'],
];
const RECOMMENDED_IGNORE = ['.env', '.env.*', '*.env', '*.key', '*.pem', '*.p12', '*.pfx', '*.jks', '*.keystore', '.credentials.json', 'credentials.json', 'auth.json', 'secrets.json', 'secrets.yaml', 'secrets.yml', 'secrets.toml', '.ai/runtime/'];
const snippetFor = (tool) => `#!/bin/sh
# pre-commit: refuse key-store file names and secret-shaped lines (${tool})
node ${tool} check --staged || exit 1
`;

function keyStoreName(rel) {
  const base = rel.split('/').pop();
  if (ALLOWED_SUFFIX.test(base)) return null;
  for (const [re, why] of NAME_RULES) if (re.test(base)) return why;
  return null;
}

function git(root, args, opts) { return spawnSync('git', args, Object.assign({ cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }, opts)); }

function check(files, read) {
  const problems = [];
  for (const f of files) {
    const why = keyStoreName(f);
    if (why) problems.push({ file: f, line: 0, reason: `name looks like a key store (${why})` });
    const text = read(f);
    if (text === null || text === undefined) continue;
    for (const h of lib.scanTextLocal(text)) problems.push({ file: f, line: h.line, reason: 'line has the shape of a secret' });
  }
  return problems;
}

function main(argv, deps = {}) {
  const out = deps.stdout || process.stdout; const err = deps.stderr || process.stderr;
  const cmd = argv[0];
  let root = process.cwd(); let staged = false; const rest = [];
  for (let i = 1; i < argv.length; i++) {
    if (argv[i] === '--root') root = path.resolve(argv[++i] || '.');
    else if (argv[i] === '--staged') staged = true;
    else if (argv[i].startsWith('--')) { err.write(`unknown option ${argv[i]}\n`); return 2; }
    else rest.push(argv[i]);
  }
  if (cmd === 'hook-snippet') { out.write(snippetFor(lib.toolRel('channels-guard.cjs', process.cwd()))); return 0; }
  if (cmd === 'gitignore-check') {
    const p = path.join(root, '.gitignore');
    const have = new Set(fs.existsSync(p) ? fs.readFileSync(p, 'utf8').split(/\r?\n/).map(s => s.trim()) : []);
    const missing = RECOMMENDED_IGNORE.filter(l => !have.has(l));
    if (!missing.length) { out.write('gitignore: all recommended lines present\n'); return 0; }
    out.write(`gitignore: ${missing.length} recommended line(s) missing from .gitignore (add them yourself):\n${missing.map(l => `  ${l}`).join('\n')}\n`);
    return 1;
  }
  if (cmd !== 'check') { err.write('usage: channels-guard check [--staged] [--root DIR] [file...] | gitignore-check | hook-snippet\n'); return 2; }
  let files; let read;
  if (staged) {
    const r = git(root, ['diff', '--cached', '--name-only', '--diff-filter=ACMR']);
    if (r.status !== 0) { err.write('cannot read the staged file list (is this a git repository?)\n'); return 2; }
    files = r.stdout.split('\n').filter(Boolean);
    read = (f) => { const b = git(root, ['show', `:${f}`], { encoding: 'buffer' }); return b.status === 0 && !b.stdout.subarray(0, 4096).includes(0) && b.stdout.length <= 1024 * 1024 ? b.stdout.toString('utf8') : null; };
  } else {
    files = rest.map(f => f.replace(/\\/g, '/'));
    read = (f) => { try { const p = path.resolve(root, f); const st = fs.statSync(p); if (!st.isFile() || st.size > 1024 * 1024) return null; const b = fs.readFileSync(p); return b.subarray(0, 4096).includes(0) ? null : b.toString('utf8'); } catch (e) { return null; } };
  }
  const problems = check(files, read);
  if (!problems.length) { out.write(`channels-guard: ${files.length} file(s) checked, clean\n`); return 0; }
  for (const p of problems) out.write(`${p.file}${p.line ? ':' + p.line : ''}  ${p.reason}\n`);
  out.write(`channels-guard: ${problems.length} problem(s); commit refused. Move the value into the OS store (channels-keys add) and keep only the NAME in the repository.\n`);
  return 1;
}

module.exports = { main, check, keyStoreName, RECOMMENDED_IGNORE, snippetFor, SNIPPET: snippetFor('docs/ops/channels-guard.cjs') };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

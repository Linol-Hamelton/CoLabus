'use strict';
// Add one building row for a new stream to the live candidate registry. The row is appended
// and the whole table is parsed again with the shared registry reader before anything is
// written; an existing row for the stream is reported as `exists` and never duplicated.
//   node .ai/bin/ops-tools/cand-add.cjs STREAM "NOTE" [--branch B] [--owner O] [--sha SHA]
//        [--file REGISTRY] [--repo DIR] [--updated YYYY-MM-DD]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseRegistry } = require('../lib/candidate-registry.cjs');
const paths = require('../lib/path-safe.cjs');
const { load } = require('./lib/config.cjs');

const SHA = /^[0-9a-f]{40}$/;
const STREAM = /^[a-z0-9][a-z0-9-]{0,63}$/;
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

function branchProblem(branch) {
  if (!BRANCH.test(branch) || branch.includes('..') || branch.endsWith('.lock') || branch.endsWith('/') || branch.includes('//')) return 'CAND-ADD-BRANCH: the branch is outside the registry grammar';
  return null;
}
function cell(value) { return String(value === undefined ? '' : value).replace(/\|/g, '/').replace(/[\r\n\t]+/g, ' ').trim(); }

function tipSha(options) {
  const run = options.run || ((file, args, opts) => spawnSync(file, args, opts));
  const remote = options.remote || 'origin';
  for (const ref of [`refs/remotes/${remote}/${options.branch}`, `refs/heads/${options.branch}`]) {
    const r = run('git', ['-C', options.repo, 'rev-parse', '--verify', ref], { encoding: 'utf8', windowsHide: true });
    if (!r.error && r.status === 0 && SHA.test((r.stdout || '').trim())) return (r.stdout || '').trim();
  }
  throw Object.assign(new Error(`CAND-ADD-SHA: neither refs/remotes/${remote}/${options.branch} nor refs/heads/${options.branch} resolves to a commit`), { code: 'CAND-ADD-SHA' });
}

function addRow(options) {
  const stream = options.stream;
  if (typeof stream !== 'string' || !STREAM.test(stream)) throw Object.assign(new Error('CAND-ADD-STREAM: the stream is outside the registry grammar'), { code: 'CAND-ADD-STREAM' });
  const branch = options.branch || stream;
  const problem = branchProblem(branch);
  if (problem) throw Object.assign(new Error(problem), { code: 'CAND-ADD-BRANCH' });
  const owner = cell(options.owner);
  if (!owner) throw Object.assign(new Error('CAND-ADD-OWNER: an owner is required (--owner or candidate.owner in the local config)'), { code: 'CAND-ADD-OWNER' });
  const updated = options.updated || new Date().toISOString().slice(0, 10);
  if (!DATE.test(updated) || !Number.isFinite(Date.parse(`${updated}T00:00:00Z`))) throw Object.assign(new Error('CAND-ADD-DATE: --updated must be YYYY-MM-DD'), { code: 'CAND-ADD-DATE' });
  const sha = options.sha || tipSha({ ...options, branch });
  if (!SHA.test(sha)) throw Object.assign(new Error('CAND-ADD-SHA: --sha must be a full 40-character commit id'), { code: 'CAND-ADD-SHA' });
  const note = cell(options.note);
  if (!note) throw Object.assign(new Error('CAND-ADD-NOTE: a note is required'), { code: 'CAND-ADD-NOTE' });

  const file = path.resolve(options.file);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { throw Object.assign(new Error(`CAND-ADD-REGISTRY: cannot read ${file} (${e.code || 'read failed'})`), { code: 'CAND-ADD-REGISTRY' }); }
  let parsed;
  try { parsed = parseRegistry(text); } catch (e) { throw Object.assign(new Error(`CAND-ADD-REGISTRY: ${file} is not a valid registry (${e.code || 'invalid'})`), { code: 'CAND-ADD-REGISTRY' }); }
  if (parsed.rows.some(row => row.cells[0] === stream)) return { ok: true, added: false, reason: 'exists', stream, file };
  const row = `| ${stream} | ${branch} | ${sha} | ${owner} | building | ${updated} | ${note.slice(0, 400)} |`;
  const lines = text.replace(/\n+$/, '').split('\n');
  lines.push(row);
  const next = `${lines.join('\n')}\n`;
  try { parseRegistry(next); } catch (e) { throw Object.assign(new Error(`CAND-ADD-REGISTRY: the appended row would make the table invalid (${e.code || 'invalid'})`), { code: 'CAND-ADD-REGISTRY' }); }
  const written = paths.writeAtomicGuarded(file, Buffer.from(next, 'utf8'), { root: path.dirname(file) });
  if (!written.ok) throw Object.assign(new Error(`CAND-ADD-WRITE: ${written.reason || 'atomic write refused'}`), { code: 'CAND-ADD-WRITE' });
  return { ok: true, added: true, stream, sha, file, row };
}

function main(argv) {
  const args = argv.slice();
  const value = name => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const branch = value('--branch'); const owner = value('--owner'); const sha = value('--sha');
  const file = value('--file'); const repo = value('--repo'); const updated = value('--updated');
  const [stream, note] = args;
  if (!stream || !note) { process.stderr.write('usage: cand-add.cjs STREAM "NOTE" [--branch B] [--owner O] [--sha SHA] [--file REGISTRY] [--repo DIR] [--updated YYYY-MM-DD]\n'); return 2; }
  let cfg;
  try { cfg = load({ root: path.resolve(repo || process.cwd()) }); } catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  const localOwner = cfg.config.candidate && cfg.config.candidate.owner;
  try {
    const result = addRow({
      stream, note, branch, owner: owner || process.env.CANDIDATE_OWNER || localOwner, sha, updated,
      file: file || path.join(cfg.runtimeDir, 'CANDIDATES.md'), repo: path.resolve(repo || cfg.root),
    });
    process.stdout.write(`${result.added ? 'ok' : 'exists'}${result.sha ? ` ${result.sha.slice(0, 8)}` : ''}\n`);
    return 0;
  } catch (e) { process.stderr.write(`${e.message}\n`); return 1; }
}

module.exports = { addRow, main, branchProblem };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

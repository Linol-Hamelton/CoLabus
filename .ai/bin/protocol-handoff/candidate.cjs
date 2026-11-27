'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { realInside, readFileGuarded } = require('../lib/path-safe.cjs');
const { decode, ownLines } = require('../lib/text-safe.cjs');
const SHA = /^[0-9a-f]{40}$/;
const HASH = /^sha256:[0-9a-f]{64}$/;
const excluded = name => name.startsWith('.ai/worklog/') || name.startsWith('.ai/runtime/') || name === '.ai/ARCHIVE.md';
const inputError = message => Object.assign(new Error(message), { exitCode: 2 });

function git(root, args, binary = false) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: binary ? undefined : 'utf8', windowsHide: true,
    timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new Error('candidate Git operation failed');
  return r.stdout;
}
function exactCommit(root, sha) {
  if (!SHA.test(sha)) throw inputError('candidate/baseline must be full lowercase commit SHA');
  let resolved;
  try { resolved = git(root, ['rev-parse', '--verify', `${sha}^{commit}`]).trim(); }
  catch { throw inputError('candidate commit is unavailable'); }
  if (resolved !== sha) throw inputError('candidate is not an exact commit');
  return sha;
}
function candidateState(root, sha, baseline) {
  exactCommit(root, sha); exactCommit(root, baseline);
  // A candidate must descend from its baseline.
  try { git(root, ['merge-base', '--is-ancestor', baseline, sha]); }
  catch { throw inputError('candidate is not a descendant of baseline'); }
  const rows = git(root, ['ls-tree', '-r', '-z', sha]).split('\0').filter(Boolean).map(row => {
    const m = /^(\d{6}) (blob|commit) ([0-9a-f]{40})\t([\s\S]+)$/.exec(row);
    if (!m) throw new Error('invalid candidate tree entry');
    return { mode: m[1], type: m[2], oid: m[3], name: m[4] };
  });
  const hash = crypto.createHash('sha256');
  const selected = rows.filter(row => !excluded(row.name)).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  for (const row of selected) hash.update(`${row.name}|${row.mode}:${row.oid}|`);
  return { commit: sha, baseline, tree: git(root, ['rev-parse', `${sha}^{tree}`]).trim(),
    digest: `sha256:${hash.digest('hex')}`, fileCount: selected.length, format: 4, rows };
}

// A disposable local clone owns the detached worktree registry, keeping the
// producer's common .git untouched. Both checkouts contain the exact candidate.
// No shell, no network, no caller-supplied destination, no deletion command.
function isolated(root, state, fn) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'protocol-candidate-'));
  const repository = path.join(temp, 'repository');
  const checkout = path.join(temp, 'checkout');
  try {
    git(root, ['clone', '--local', '--no-hardlinks', '--no-checkout', '--', root, repository]);
    const config = ['-c', 'core.hooksPath=' + path.join(temp, 'empty-hooks')];
    git(repository, [...config, 'checkout', '--detach', state.commit]);
    git(repository, [...config, 'worktree', 'add', '--detach', checkout, state.commit]);
    if (git(checkout, ['rev-parse', 'HEAD']).trim() !== state.commit) throw new Error('isolated candidate HEAD mismatch');
    // Refuse links, gitlinks and filesystem aliases before any candidate code runs.
    for (const row of state.rows) {
      if (!['100644', '100755'].includes(row.mode) || row.type !== 'blob') throw new Error('isolated candidate contains a non-regular entry');
      const g = realInside(checkout, row.name, { refuseHardlinks: true });
      if (!g.ok || g.type !== 'file') throw new Error('isolated candidate path refused');
    }
    return fn(checkout);
  } finally {
    // temp was made exclusively above; never accept a path from input here.
    const real = fs.realpathSync(temp);
    if (real !== temp || !path.basename(temp).startsWith('protocol-candidate-')) throw new Error('candidate cleanup path changed');
    fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}

function candidateReceipt(body) {
  if (!/(?:^|\n)- candidate(?:-|:)/.test(body || '')) return null;
  const text = decode(Buffer.from(body), { invisible: 'refuse' });
  if (!text.ok) throw new Error('candidate receipt text refused');
  const own = new Set(ownLines(body).map(l => l.line));
  body.split('\n').forEach((line, i) => {
    if (/^- (?:candidate(?:-|:)|anchor:|digest(?: format)?:|entry(?: hash format)?:|protocol-|targeted:)/.test(line) && !own.has(i + 1)) {
      throw new Error('candidate receipt field is hidden in Markdown');
    }
  });
  const one = (name, pattern) => {
    const lines = body.split('\n').filter(l => l.startsWith(`- ${name}:`));
    if (lines.length !== 1) throw new Error('candidate receipt field missing or duplicated');
    const value = lines[0].slice(name.length + 4);
    if (!pattern.test(value)) throw new Error('candidate receipt field malformed');
    return value;
  };
  const sha = one('candidate', SHA);
  const baseline = one('candidate-baseline', SHA);
  const tree = one('candidate-tree', SHA);
  const digest = one('candidate-digest', HASH);
  const snapshotDigest = one('digest', /^sha256:[0-9a-f]{64} over [0-9]+ tracked and untracked files$/);
  if (snapshotDigest.split(' ')[0] !== digest) throw new Error('candidate digest fields disagree');
  one('digest format', /^4$/);
  one('entry hash format', /^2$/);
  one('entry', /^sha256:[0-9a-f]{64} of this entry without this block$/);
  const scope = one('candidate-scope', /^(validator-only|targeted|full)$/);
  const anchor = one('anchor', /^[0-9a-f]{40}, (clean tree|uncommitted changes present)$/);
  if (!anchor.startsWith(sha + ',')) throw new Error('candidate anchor mismatch');
  const count = Number(one('candidate-checks', /^[1-9][0-9]*$/));
  const checks = body.split('\n').filter(l => /^- (?:protocol-validate\.cjs|protocol-test\.cjs|targeted:[A-Za-z0-9_./-]+):/.test(l));
  if (checks.length !== count || new Set(checks.map(l => l.split(': exit')[0])).size !== count ||
      checks.some(l => !/^[^\n]+: exit 0 in [0-9]+s$/.test(l)) || !checks.some(l => l.startsWith('- protocol-validate.cjs:'))) {
    throw new Error('candidate checks missing, duplicated or failed');
  }
  if (scope === 'full' && !checks.some(l => l.startsWith('- protocol-test.cjs:'))) throw new Error('candidate full suite missing');
  if (scope === 'targeted' && !checks.some(l => l.startsWith('- targeted:'))) throw new Error('candidate targeted checks missing');
  return { sha, baseline, tree, digest, scope };
}
function receiptState(root, evidence) {
  const receipt = candidateReceipt(evidence.body);
  if (!receipt) return null;
  const state = candidateState(root, receipt.sha, receipt.baseline);
  if (receipt.digest !== state.digest || receipt.tree !== state.tree || evidence.digest !== state.digest) throw new Error('candidate object digest mismatch');
  return state;
}
function guardedText(root, file) {
  const r = readFileGuarded(root, file);
  if (!r.ok) throw new Error('candidate journal path refused');
  const d = decode(r.bytes, { invisible: 'refuse' });
  if (!d.ok) throw new Error('candidate journal encoding refused');
  return d.text;
}
module.exports = { candidateState, candidateReceipt, receiptState, isolated, git, exactCommit, guardedText };

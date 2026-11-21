'use strict';
// Structured launch facts supplement an unclear task; they never authorize execution.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const identity = require('../../.ai/bin/lib/model-identity.cjs');
const safe = require('../../.ai/bin/lib/path-safe.cjs');
const { parseJsonUnique } = require('../../.ai/bin/lib/text-safe.cjs');
const preflight = require('./author-lineage.cjs');
const context = require('../../.ai/bin/protocol-context.cjs');

function git(root, args, run = spawnSync) {
  const r = run('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw Error('structured-git-unknown');
  return String(r.stdout || '').trim();
}
function names(input, deps = {}) {
  let branch = null;
  try { branch = git(input.worktree, ['rev-parse', '--abbrev-ref', 'HEAD'], deps.run); } catch { /* unnamed branch stays unknown */ }
  if (branch === 'HEAD') branch = null;
  const stream = typeof input.stream === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.stream) ? input.stream : branch;
  return { branch, stream };
}
function branchBase(input, deps = {}) {
  const read = safe.readFileGuarded(input.worktree, 'protocol-manifest.json');
  if (!read.ok || read.bytes.length > 1024 * 1024) return null;
  const manifest = parseJsonUnique(read.bytes.toString('utf8'));
  const branch = manifest.integrationBranch;
  if (typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,119}$/.test(branch) || branch.includes('..')) return null;
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    try {
      const base = git(input.worktree, ['merge-base', 'HEAD', ref], deps.run);
      if (/^[a-f0-9]{40}$/.test(base)) return base;
    } catch { /* the next declared integration ref may exist */ }
  }
  return null;
}
function coupled(input, paths, deps = {}) {
  const { stream, branch } = names(input, deps);
  try {
    const registry = context.coupledRegistry(git(input.worktree, ['show', 'HEAD:docs/ops/COUPLED-SETS.json'], deps.run));
    const matching = (registry?.sets || []).filter(s => s.streams.some(v => [stream, branch].includes(v))
      || s.packages.some(v => [stream, branch, `branch:${branch}`].includes(v))
      || paths.some(p => s.paths.some(mask => context.maskMatches(mask, p))));
    // Exact members add scope; masks and directories only establish coupling.
    return { stream, branch, paths: matching.flatMap(s => s.paths).filter(p => !/[*]/.test(p) && !p.endsWith('/')),
      count: matching.length, unknown: matching.length ? [] : ['coupled-set-unknown'] };
  } catch { return { stream, branch, paths: [], count: 0, unknown: ['coupled-set-unknown'] }; }
}
function lineage(input, deps = {}) {
  const named = names(input, deps), families = new Set();
  let roots = deps.runtimeDir ? [deps.runtimeDir] : [];
  if (!roots.length) {
    try { roots = require('../../.ai/bin/lib/seat-slots.cjs').domainRoots({ repo: input.worktree }).roots; } catch { /* no host roots */ }
  }
  if (!roots.length) roots = [path.join(input.worktree, '.ai', 'runtime')];
  for (const runtimeDir of roots) {
    const found = preflight.authorLineage(input.worktree, { ...named, runtimeDir, structuredOnly: true });
    // Convert the reader's historical labels through the kernel identity table.
    const makers = { gpt: 'OpenAI', claude: 'Anthropic', gemini: 'Google', glm: 'Zhipu AI (Z.ai)', kimi: 'Moonshot', mimo: 'Xiaomi' };
    for (const family of found.keys()) {
      const canonical = identity.declaredFamily(makers[family] || family);
      if (canonical !== 'UNKNOWN') families.add(canonical);
    }
  }
  return [...families].sort().map(family => ({ family }));
}
module.exports = { names, branchBase, coupled, lineage };

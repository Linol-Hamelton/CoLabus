'use strict';
// Structured launch facts supplement an unclear task; they never authorize execution.
const fs = require('node:fs');
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
function runtimeRoots(input, deps = {}) {
  let roots = deps.runtimeDir ? [deps.runtimeDir] : [];
  if (!roots.length) {
    try { roots = require('../../.ai/bin/lib/seat-slots.cjs').domainRoots({ repo: input.worktree }).roots; } catch { /* no host roots */ }
  }
  return roots.length ? roots : [path.join(input.worktree, '.ai', 'runtime')];
}
// The streams the candidate registry names for this worktree: a row whose branch is the checked-out branch or whose
// sha is the head. A reviewing worktree on its own seat branch finds its package this way. An absent registry has no
// rows; a registry that exists but is unreadable or outside the registry grammar (a CRLF or BOM file among them) is
// named candidate-registry-invalid, never read as an empty one.
function registryStreams(input, branch, deps = {}) {
  let head = null;
  try { head = git(input.worktree, ['rev-parse', 'HEAD'], deps.run); } catch { return { streams: [], unknown: [] }; }
  const out = new Set(), unknown = new Set();
  for (const root of runtimeRoots(input, deps)) {
    if (!fs.existsSync(path.join(root, 'CANDIDATES.md'))) continue;
    const read = safe.readFileGuarded(root, 'CANDIDATES.md', { maxBytes: 4 * 1024 * 1024 });
    let rows = null;
    try { rows = read.ok ? require('../../.ai/bin/lib/candidate-registry.cjs').parseRegistry(read.bytes).rows : null; } catch { rows = null; }
    if (!rows) { unknown.add('candidate-registry-invalid'); continue; }
    for (const { cells } of rows) if (cells[1] === branch && branch || cells[2] === head) out.add(cells[0]);
  }
  return { streams: [...out].filter(s => /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(s)).sort(), unknown: [...unknown] };
}
function names(input, deps = {}) {
  let branch = null;
  try { branch = git(input.worktree, ['rev-parse', '--abbrev-ref', 'HEAD'], deps.run); } catch { /* unnamed branch stays unknown */ }
  if (branch === 'HEAD') branch = null;
  const stated = typeof input.stream === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.stream) ? input.stream : null;
  let registry;
  try { registry = registryStreams(input, branch, deps); } catch { registry = { streams: [], unknown: ['candidate-registry-invalid'] }; }
  const registered = registry.streams;
  const stream = stated || (registered.length === 1 ? registered[0] : branch);
  return { branch, stream, streams: [...new Set([...(stated ? [stated] : []), ...registered])], unknown: registry.unknown };
}
function branchBase(input, deps = {}) {
  const read = safe.readFileGuarded(input.worktree, 'protocol-manifest.json');
  if (!read.ok || read.bytes.length > 1024 * 1024) return null;
  let manifest;
  try { manifest = parseJsonUnique(read.bytes.toString('utf8')); } catch { return null; }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return null;
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
  const { stream, branch, unknown: registryUnknown } = names(input, deps);
  try {
    const registry = context.coupledRegistry(git(input.worktree, ['show', 'HEAD:docs/ops/COUPLED-SETS.json'], deps.run));
    const matching = (registry?.sets || []).filter(s => s.streams.some(v => [stream, branch].includes(v))
      || s.packages.some(v => [stream, branch, `branch:${branch}`].includes(v))
      || paths.some(p => s.paths.some(mask => context.maskMatches(mask, p))));
    // Exact members add scope; masks and directories only establish coupling.
    return { stream, branch, paths: matching.flatMap(s => s.paths).filter(p => !/[*]/.test(p) && !p.endsWith('/')),
      count: matching.length, unknown: [...registryUnknown, ...(matching.length ? [] : ['coupled-set-unknown'])] };
  } catch { return { stream, branch, paths: [], count: 0, unknown: [...registryUnknown, 'coupled-set-unknown'] }; }
}
// An invalid registry may hide the package stream of a reviewing worktree, so the lineage read refuses by name and the
// caller keeps the lineage unknown instead of reading the authors of a partial stream set.
function lineage(input, deps = {}) {
  const { streams, unknown, ...named } = names(input, deps), families = new Set();
  if (unknown.length) throw Error(unknown[0]);
  for (const runtimeDir of runtimeRoots(input, deps)) {
    const found = preflight.authorLineage(input.worktree, { ...named, names: streams, runtimeDir, structuredOnly: true });
    // Convert the reader's historical labels through the kernel identity table.
    const makers = { gpt: 'OpenAI', claude: 'Anthropic', gemini: 'Google', glm: 'Zhipu AI (Z.ai)', kimi: 'Moonshot', mimo: 'Xiaomi' };
    for (const family of found.keys()) {
      const canonical = identity.declaredFamily(makers[family] || family);
      if (canonical !== 'UNKNOWN') families.add(canonical);
    }
  }
  return [...families].sort().map(family => ({ family }));
}
const SHA = /^[a-f0-9]{40}$/;
const READER = new Set(['certifier', 'reviewer', 'critic']);
const AUTHOR = new Set(['author', 'implementer', 'fixer']);
const operational = p => /^\.ai\/(?:worklog|runtime)\//i.test(p.replace(/\\/g, '/').replace(/^(?:\.\/)+/, ''));
function roundPaths(paths) {
  if (!Array.isArray(paths) || !paths.length || paths.length > 10000) return null;
  const normalise = require('../../docs/ops/risk-class.cjs').normalisePath;
  const out = [];
  for (const p of paths) {
    const n = normalise(p);
    if (!n.ok) return null;
    if (!operational(n.path)) out.push(n.path);
  }
  return out.length ? [...new Map(out.map(p => [p.toLowerCase(), p])).values()].sort() : null;
}
// Running and terminal files describe the same launch; the terminal copy wins.
// A corrupt or unreadable history is unknown, not evidence of zero prior rounds.
function roundRecords(input, deps) {
  if (Object.hasOwn(deps, 'launchRecords')) {
    return Array.isArray(deps.launchRecords) ? deps.launchRecords : null;
  }
  const byId = new Map();
  let read = false;
  for (const root of runtimeRoots(input, deps)) {
    let files;
    try { files = fs.readdirSync(root); read = true; } catch { return null; }
    for (const suffix of ['.running.json', '.terminal.json']) {
      for (const file of files.filter(f => f.endsWith(suffix)).sort()) {
        const g = safe.readFileGuarded(root, file, { maxBytes: 4 * 1024 * 1024 });
        if (!g.ok) return null;
        let r;
        try { r = parseJsonUnique(g.bytes.toString('utf8')); } catch { return null; }
        if (!r || typeof r !== 'object' || Array.isArray(r)) return null;
        if (!r.startedAt || !r.stream) continue; // Pre-history launch records carry neither fact.
        if (!Number.isFinite(Date.parse(r.startedAt))) return null;
        byId.set(r.wrapperLaunchId || `${r.name}@${r.startedAt}`, r);
      }
    }
  }
  return read ? [...byId.values()] : null;
}
// The facts at the start of this round. Explicit scope wins for every role;
// only readers may recover scope from commits, never from the branch base.
function round(input, descriptor, repo, role, deps = {}) {
  const { stream, unknown } = names(input, deps);
  const at = Date.parse(input.startedAt || (typeof deps.now === 'function' ? deps.now() : deps.now) || new Date().toISOString());
  const records = !stream || unknown.length && stream !== input.stream || !Number.isFinite(at) ? null : roundRecords(input, deps);
  const matching = records?.filter(r => r?.stream === stream) || [];
  const invalid = matching.some(r => !Number.isFinite(Date.parse(r.startedAt)) || !['author', 'implementer', 'fixer', 'certifier', 'reviewer', 'critic', 'architect', 'researcher', 'drafter', 'synthesiser'].includes(r.taskFrame?.role || r.role));
  const earlier = matching.filter(r => Number.isFinite(Date.parse(r.startedAt)) && Date.parse(r.startedAt) < at)
    .sort((a, b) => Date.parse(a.startedAt) - Date.parse(b.startedAt) || String(a.name).localeCompare(String(b.name)));
  // De-duplicate injected snapshots too, using the same identity as on disk.
  const unique = [...new Map(earlier.map(r => [r.wrapperLaunchId || `${r.name}@${r.startedAt}`, r])).values()];
  const priorRounds = records !== null && matching.length && !invalid ? unique.filter(r => AUTHOR.has(r.taskFrame?.role || r.role)).length : null;
  const declared = descriptor.spec?.writeSet ? descriptor.spec.writeSet.flatMap(c => c.paths) : descriptor.paths;
  let paths = declared !== undefined ? roundPaths(declared) : null;
  if (declared === undefined && READER.has(role) && records !== null && !invalid && SHA.test(repo?.head || '')) {
    const previous = [...unique].reverse().find(r => SHA.test(r.taskFrame?.head || r.head || '') && (r.taskFrame?.head || r.head) !== repo.head);
    if (previous) {
      const from = previous.taskFrame?.head || previous.head;
      try {
        paths = roundPaths(git(input.worktree, ['log', '--first-parent', '--no-merges', '--no-renames', '--format=', '--name-only', '-z', `${from}..${repo.head}`, '--'], deps.run)
          .split(/[\0\n]/).filter(Boolean));
      } catch { /* Missing commit or unreadable repository leaves scope unknown. */ }
    }
  }
  return { paths, priorRounds, openQuestions: descriptor.spec?.openQuestions ?? null };
}
module.exports = { names, branchBase, coupled, lineage, round };

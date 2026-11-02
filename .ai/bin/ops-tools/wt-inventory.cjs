'use strict';
// Read-only inventory of the git worktrees and local branches for the landing cleanup (PROTO-DEC-0249 item 4, row P-155).
//   node .ai/bin/ops-tools/wt-inventory.cjs [--repo DIR] [--json FILE]
// Classes: live (a seat record without a later terminal record names the tree), in-work (the branch is an open candidate in the
// registry), fresh (a branch with no work of its own yet, or in the line but not closed by the registry), landed (the tip is in the
// line or cited by a Landed-Tip trailer, or in the line and closed by the registry), seat-ended (a detached tree whose seat ended),
// detached-in-line, owner-session (the path matches the configured owner pattern) and orphan (anything else). Untracked review
// files and journals are counted: they must be archived before a tree goes. Nothing is changed.
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./lib/config.cjs');
const wt = require('./lib/worktrees.cjs');

const REVIEW_OR_JOURNAL = /docs\/reviews\/|\.ai\/worklog\/|(CERT-PROMPT|FIX-PROMPT)\.md/;

function classify(w, facts) {
  const p = wt.norm(w.path);
  if (facts.ownerPattern.test(w.path)) return 'owner-session';
  if (facts.live.has(p)) return 'live';
  if (w.branch && facts.registry.open.has(w.branch)) return 'in-work';
  // A branch whose reflog holds only its creation has no work of its own: a new package tree, kept even if an old closed
  // registry row reuses its name.
  if (w.branch && facts.creationOnly(w.branch)) return 'fresh';
  if (w.branch && (facts.isLandedTip(w.head) || (facts.inLine(w.head) && facts.registry.closed.has(w.branch)))) return 'landed';
  // In the line, not closed and not cited: created for a new package and kept.
  if (w.branch && facts.inLine(w.head)) return 'fresh';
  if (w.detached && facts.ended.has(p)) return 'seat-ended';
  if (w.detached && facts.inLine(w.head)) return 'detached-in-line';
  return 'orphan';
}

function inventory(options = {}) {
  const cfg = options.cfg;
  const main = path.resolve(options.main || cfg.main);
  const runtimeDir = options.runtimeDir || cfg.runtimeDir;
  const git = options.git || wt.gitReader();
  const files = options.fs || fs;
  const now = options.now || (() => Date.now());
  const lineRef = wt.lineRefOf(cfg.author.baseRef);
  const registry = wt.readRegistry(runtimeDir, files);
  const seats = wt.seatRecords(runtimeDir, files);
  const live = new Set();
  const ended = new Set();
  for (const seat of seats.seats) if (seat.worktree) (seat.live ? live : ended).add(wt.norm(seat.worktree));
  const line = wt.lineFacts(git, main, lineRef);
  const creationOnly = branch => {
    const log = (git(['reflog', 'show', '--format=%gs', `refs/heads/${branch}`], main) || '').split('\n').filter(Boolean);
    return log.length === 1 && /^branch: Created from/.test(log[0]);
  };
  const facts = { ownerPattern: cfg.cleanup.ownerSessionPattern, live, ended, registry, creationOnly, ...line };

  const rows = [];
  for (const w of wt.listWorktrees(git, main)) {
    if (wt.samePath(w.path, main)) continue;
    const exists = files.existsSync(w.path);
    const status = exists ? (git(['status', '--porcelain', '--untracked-files=all'], w.path) || '').split('\n').filter(Boolean) : [];
    rows.push({
      path: w.path, branch: w.branch || null, head: (w.head || '').slice(0, 8), fullHead: w.head || '',
      cls: classify(w, facts), exists, prunable: Boolean(w.prunable),
      reviews: status.filter(l => /docs\/reviews\//.test(l)).length,
      journals: status.filter(l => /\.ai\/worklog\//.test(l)).length,
      dirty: status.filter(l => !REVIEW_OR_JOURNAL.test(l)).length,
    });
  }
  const worktreeBranches = new Set(rows.map(r => r.branch).filter(Boolean));
  const branches = { landed: 0, 'in-work': 0, 'with-tree': 0, unlanded: 0 };
  const heads = (git(['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'], main) || '').split('\n').filter(Boolean).map(l => l.split(' '));
  for (const [name, sha] of heads) {
    if (worktreeBranches.has(name)) branches['with-tree']++;
    else if (registry.open.has(name)) branches['in-work']++;
    else if (line.isLandedTip(sha) || line.inLine(sha)) branches.landed++;
    else branches.unlanded++;
  }
  return {
    schema: 'wt-inventory/1', generatedAt: new Date(now()).toISOString(), main, baseRef: cfg.author.baseRef,
    registry: registry.present, seatsReadable: seats.readable, rows, branchCount: heads.length, branches,
  };
}

function summary(inv) {
  const by = {};
  for (const row of inv.rows) (by[row.cls] = by[row.cls] || []).push(row);
  const lines = Object.entries(by).map(([cls, rows]) => `${cls.padEnd(17)} ${String(rows.length).padStart(3)}  untracked reviews ${rows.reduce((s, r) => s + r.reviews, 0)}, journals ${rows.reduce((s, r) => s + r.journals, 0)}, other dirty ${rows.reduce((s, r) => s + r.dirty, 0)}`);
  lines.push(`branches ${inv.branchCount}: ${JSON.stringify(inv.branches)}`);
  if (!inv.registry) lines.push('WARNING: the candidate registry is unreadable; no tree is known to be in work and a cleanup will refuse to run');
  if (!inv.seatsReadable) lines.push('WARNING: the seat records are unreadable; no tree is known to be live and a cleanup will refuse to run');
  return lines;
}

function main(argv, deps = {}) {
  const args = argv.slice();
  const value = name => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const repo = value('--repo');
  const json = value('--json');
  if (args.length || (json !== undefined && !json)) { process.stderr.write('usage: wt-inventory.cjs [--repo DIR] [--json FILE]\n'); return 2; }
  let cfg;
  try { cfg = deps.cfg || load({ root: path.resolve(repo || process.cwd()), env: deps.env || process.env }); }
  catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  const inv = inventory({ cfg, ...deps.inventory });
  for (const line of summary(inv)) process.stdout.write(`${line}\n`);
  if (json) fs.writeFileSync(json, `${JSON.stringify(inv, null, 1)}\n`);
  return 0;
}

module.exports = { classify, inventory, summary, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

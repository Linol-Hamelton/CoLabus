'use strict';
// Cleanup after a landing, archive first (PROTO-DEC-0249 item 4, row P-155).
//   node .ai/bin/ops-tools/landing-cleanup.cjs --inventory FILE [--apply] [--archive DIR]
// FILE is the output of wt-inventory.cjs --json. Without --apply the tool prints the plan, item by item, and changes nothing.
// With --apply:
// 1. archive: the untracked review files and journals (docs/reviews/*.md, .ai/worklog/*.md) of every tree to be removed are
//    copied under <archive>/cleanup-YYYYMMDD/trees/ and compared byte for byte; the unlanded local branches go into one git
//    bundle that is verified and checked to hold every tip. Any failure stops the run before anything is removed.
// 2. remove, only after step 1 succeeded: git worktree remove of the classes landed, seat-ended, orphan and detached-in-line;
//    git branch -D of the bundled and the landed branches whose tip is still the planned one; the temp root of an ended seat
//    past the retention.
// Never touched: the main checkout, a live seat's tree or temp root, a branch in work, an owner session, the current directory,
// a tree with uncommitted work other than archivable reviews and journals, a tree that moved since the inventory, and any
// branch a kept tree has checked out. The tool refuses to plan from a stale or foreign inventory, or without the registry.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { load } = require('./lib/config.cjs');
const wt = require('./lib/worktrees.cjs');

const REMOVE = new Set(['landed', 'seat-ended', 'orphan', 'detached-in-line']);
const ARCHIVABLE = /^(docs\/reviews\/|\.ai\/worklog\/).+\.md$/;
const PROMPT_FILE = /^(CERT-PROMPT|FIX-PROMPT)\.md$/;
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Entries of git status --porcelain=v1 -z: "XY path"; a rename or a copy is followed by its source, which is not an entry.
function statusEntries(out) {
  const parts = String(out || '').split('\0');
  const entries = [];
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part.length < 4) continue;
    entries.push({ code: part.slice(0, 2), file: part.slice(3) });
    if (/[RC]/.test(part.slice(0, 2))) i++;
  }
  return entries;
}

function readers(options) {
  const spawn = options.spawn || ((file, args, opts) => spawnSync(file, args, opts));
  const run = (args, cwd) => spawn('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const git = (args, cwd) => { const r = run(args, cwd); return r.error || r.status !== 0 ? null : String(r.stdout || '').trim(); };
  const strict = (args, cwd) => {
    const r = run(args, cwd);
    if (r.error || r.status !== 0) throw Object.assign(new Error(String((r.stderr || (r.error && r.error.message) || `git ${args[0]} failed`)).split('\n')[0].slice(0, 200)), { code: 'LANDING-CLEANUP-GIT' });
    return String(r.stdout || '').trim();
  };
  const raw = (args, cwd) => { const r = run(args, cwd); return r.error || r.status !== 0 ? null : String(r.stdout || ''); };
  return { git, strict, raw };
}

function plan(options) {
  const cfg = options.cfg;
  const inv = options.inventory;
  const files = options.fs || fs;
  const now = options.now || (() => Date.now());
  const cwd = options.cwd || process.cwd();
  const main = path.resolve(cfg.main);
  const { git, raw } = options.git ? { git: options.git, raw: options.raw || options.git } : readers(options);
  const refusals = [];
  if (!inv || inv.schema !== 'wt-inventory/1' || !Array.isArray(inv.rows)) refusals.push('INVENTORY-INVALID: not a wt-inventory/1 file');
  else {
    if (typeof inv.main !== 'string' || !wt.samePath(inv.main, main)) refusals.push(`INVENTORY-FOREIGN: the inventory is of ${inv.main}, this repository is ${main}`);
    const age = now() - Date.parse(inv.generatedAt);
    if (!(age >= 0 && age <= cfg.cleanup.inventoryMaxMs)) refusals.push('INVENTORY-STALE: the inventory is older than the allowed age or dated in the future; run wt-inventory.cjs again');
    if (!inv.registry || !inv.seatsReadable) refusals.push('INVENTORY-BLIND: the inventory was taken without the registry or the seat records');
  }
  const registry = wt.readRegistry(cfg.runtimeDir, files);
  const seats = wt.seatRecords(cfg.runtimeDir, files);
  if (!registry.present) refusals.push('REGISTRY-MISSING: the candidate registry is unreadable; what is in work is unknown');
  if (!seats.readable) refusals.push('SEATS-UNREADABLE: the seat records are unreadable; what is live is unknown');
  if (refusals.length) return { refusals };

  const lineRef = wt.lineRefOf(cfg.author.baseRef);
  const line = wt.lineFacts(git, main, lineRef);
  const registered = wt.listWorktrees(git, main);
  const registeredAt = p => registered.find(w => wt.samePath(w.path, p));
  const liveSeat = p => seats.seats.find(s => s.live && s.worktree && wt.samePath(s.worktree, p));
  const anySeat = p => seats.seats.find(s => s.worktree && wt.samePath(s.worktree, p));
  const liveTemp = seats.seats.filter(s => s.live && SAFE_NAME.test(s.name)).map(s => path.join(cfg.workRoot, s.name));

  const kept = [];
  const trees = [];
  const keptBranches = new Set();
  for (const row of inv.rows) {
    if (!REMOVE.has(row.cls) || wt.samePath(row.path, main)) { if (row.branch) keptBranches.add(row.branch); continue; }
    const why = (() => {
      const now1 = registeredAt(row.path);
      if (!now1) return 'not a registered worktree of this repository';
      if (row.fullHead && now1.head !== row.fullHead) return 'moved since the inventory';
      if (liveSeat(row.path)) return 'live seat';
      if (cfg.cleanup.ownerSessionPattern.test(row.path)) return 'owner session';
      if (wt.within(cwd, row.path)) return 'the current directory is inside it';
      const under = liveTemp.find(dir => wt.within(row.path, dir));
      if (under) return `under the temp root of a live seat (${path.basename(under)})`;
      const seat = anySeat(row.path);
      if (seat && seat.stream && registry.open.has(seat.stream)) return `seat of open package ${seat.stream}`;
      if (now1.branch && registry.open.has(now1.branch)) return `branch ${now1.branch} is in work`;
      if ((row.cls === 'landed' || row.cls === 'detached-in-line') && !(line.isLandedTip(now1.head) || line.inLine(now1.head))) return 'not in the line any more';
      if (row.exists || files.existsSync(row.path)) {
        const entries = statusEntries(raw(['status', '--porcelain=v1', '-z', '--untracked-files=all'], row.path));
        const loose = entries.filter(e => !(e.code === '??' && (ARCHIVABLE.test(e.file) || PROMPT_FILE.test(e.file))));
        if (loose.length) return `uncommitted work outside archivable reviews and journals (${loose.length} paths, first ${loose[0].file})`;
      }
      return null;
    })();
    if (why) { kept.push({ row, why }); if (row.branch) keptBranches.add(row.branch); } else trees.push(row);
  }

  // Branches: everything that is neither kept, in work, protected nor the line goes: in the line it is landed, else bundled first.
  const removedBranches = new Set(trees.map(t => t.branch).filter(Boolean));
  const lineName = lineRef.replace(/^refs\/remotes\/[^/]+\//, '');
  const protectedNames = new Set([...cfg.cleanup.protectedBranches, lineName]);
  const current = git(['rev-parse', '--abbrev-ref', 'HEAD'], main);
  const heads = (git(['for-each-ref', '--format=%(refname:short) %(objectname)', 'refs/heads'], main) || '').split('\n').filter(Boolean).map(l => l.split(' '));
  const checkedOut = new Set(registered.filter(w => w.branch && !removedBranches.has(w.branch)).map(w => w.branch));
  const delLanded = [];
  const delBundle = [];
  for (const [name, sha] of heads) {
    if (name === current || protectedNames.has(name) || keptBranches.has(name) || checkedOut.has(name) || registry.open.has(name)) continue;
    if (line.isLandedTip(sha) || line.inLine(sha)) delLanded.push({ name, sha }); else delBundle.push({ name, sha });
  }

  const day = new Date(now()).toISOString().slice(0, 10).replace(/-/g, '');
  const archiveDir = path.join(options.archiveRoot || cfg.cleanup.archiveRoot, `cleanup-${day}`);
  const copies = [];
  for (const tree of trees) {
    if (!files.existsSync(tree.path)) continue;
    const slot = `${path.basename(tree.path)}-${Buffer.from(wt.norm(tree.path)).toString('hex').slice(-8)}`;
    for (const entry of statusEntries(raw(['status', '--porcelain=v1', '-z', '--untracked-files=all'], tree.path))) {
      if (entry.code === '??' && ARCHIVABLE.test(entry.file)) copies.push({ from: path.join(tree.path, entry.file), to: path.join(archiveDir, 'trees', slot, entry.file) });
    }
  }

  // Temp roots of ended seats past the retention: one plain directory directly under the work root, named like the seat.
  const tempRoots = [];
  for (const seat of seats.seats) {
    if (seat.live || seat.terminalAt === null || !SAFE_NAME.test(seat.name) || cfg.cleanup.reservedNames.includes(seat.name)) continue;
    if (now() - seat.terminalAt <= cfg.cleanup.tempRetentionMs) continue;
    const dir = path.join(cfg.workRoot, seat.name);
    let stat;
    try { stat = files.lstatSync(dir); } catch { continue; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    if (wt.within(cwd, dir) || liveTemp.some(l => wt.samePath(l, dir))) continue;
    if (registered.some(w => wt.within(w.path, dir) && !trees.some(t => wt.samePath(t.path, w.path)))) continue;
    tempRoots.push(dir);
  }
  return { refusals: [], trees, kept, delLanded, delBundle, copies, tempRoots, archiveDir };
}

function printPlan(p, say) {
  for (const k of p.kept) say(`KEEP ${k.row.path}: ${k.why}`);
  const classes = [...REMOVE].map(c => `${c} ${p.trees.filter(t => t.cls === c).length}`).join(', ');
  say(`PLAN trees to remove ${p.trees.length} (${classes})`);
  say(`PLAN files to archive ${p.copies.length} into ${p.archiveDir}`);
  say(`PLAN branches: delete landed ${p.delLanded.length}; bundle then delete ${p.delBundle.length}`);
  say(`PLAN temp roots to remove ${p.tempRoots.length}`);
  // Every item is listed, so the operator reads what goes before --apply: counts alone once hid six new trees.
  for (const t of p.trees) say(`REMOVE-TREE ${t.cls} ${t.path} ${t.branch || ''}`);
  for (const b of p.delLanded) say(`DELETE-BRANCH landed ${b.name}`);
  for (const b of p.delBundle) say(`DELETE-BRANCH after-bundle ${b.name}`);
  for (const d of p.tempRoots) say(`REMOVE-TEMP-ROOT ${d}`);
}

function apply(p, options) {
  const cfg = options.cfg;
  const files = options.fs || fs;
  const main = path.resolve(cfg.main);
  const { strict, git } = options.git ? { strict: options.strict, git: options.git } : readers(options);
  const lines = [];
  const say = line => { lines.push(line); if (options.say) options.say(line); };

  files.mkdirSync(p.archiveDir, { recursive: true });
  for (const c of p.copies) {
    files.mkdirSync(path.dirname(c.to), { recursive: true });
    // A repeated run of the same day finds its own earlier copy: the same bytes are fine, different bytes stop the run.
    if (!files.existsSync(c.to)) files.copyFileSync(c.from, c.to, fs.constants.COPYFILE_EXCL);
    if (!files.readFileSync(c.from).equals(files.readFileSync(c.to))) { say(`ARCHIVE MISMATCH ${c.from}; stop, nothing removed`); return { code: 4, lines }; }
  }
  say(`ARCHIVED ${p.copies.length} files`);
  if (p.delBundle.length) {
    const bundle = path.join(p.archiveDir, 'unlanded-branches.bundle');
    try {
      strict(['bundle', 'create', bundle, ...p.delBundle.map(b => `refs/heads/${b.name}`)], main);
      strict(['bundle', 'verify', bundle], main);
      const heads = strict(['bundle', 'list-heads', bundle], main);
      for (const b of p.delBundle) {
        if (!new RegExp(`^${b.sha} refs/heads/${b.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm').test(heads)) throw Object.assign(new Error(`the bundle does not hold ${b.name} at ${b.sha}`), { code: 'LANDING-CLEANUP-BUNDLE' });
      }
    } catch (e) { say(`BUNDLE FAILED ${e.message}; stop, nothing removed`); return { code: 5, lines }; }
    files.writeFileSync(path.join(p.archiveDir, 'unlanded-branches.txt'), `${p.delBundle.map(b => `${b.name} ${b.sha}`).join('\n')}\n`);
    say(`BUNDLED ${p.delBundle.length} branches into ${bundle} (verified, every tip present)`);
  }

  let removed = 0;
  let failed = 0;
  for (const t of p.trees) {
    try { strict(['worktree', 'remove', '--force', t.path], main); removed++; }
    catch (e) { failed++; say(`KEPT ${t.path}: ${e.message}`); }
  }
  git(['worktree', 'prune'], main);
  let deleted = 0;
  for (const b of [...p.delLanded, ...p.delBundle]) {
    // The planned tip must still be the branch's tip: a branch that moved after the plan is not deleted.
    if (git(['rev-parse', '--verify', `refs/heads/${b.name}`], main) !== b.sha) { say(`KEPT branch ${b.name}: moved since the plan`); continue; }
    if (git(['branch', '-D', b.name], main) !== null) deleted++;
  }
  let temps = 0;
  const registered = wt.listWorktrees(git, main);
  for (const dir of p.tempRoots) {
    if (registered.some(w => wt.within(w.path, dir))) { say(`KEPT ${dir}: a registered worktree is inside`); continue; }
    try { files.rmSync(dir, { recursive: true, force: true }); temps++; } catch (e) { say(`KEPT ${dir}: ${String(e.code || e.message)}`); }
  }
  say(`REMOVED trees ${removed}, kept on error ${failed}; deleted branches ${deleted}; removed temp roots ${temps}`);
  return { code: 0, lines, removed, failed, deleted, temps };
}

function main(argv, deps = {}) {
  const args = argv.slice();
  const value = name => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const doApply = (() => { const i = args.indexOf('--apply'); if (i < 0) return false; args.splice(i, 1); return true; })();
  const inventoryFile = value('--inventory');
  const archive = value('--archive');
  if (args.length || !inventoryFile) { process.stderr.write('usage: landing-cleanup.cjs --inventory FILE [--apply] [--archive DIR]\n'); return 2; }
  let cfg;
  let inventory;
  try {
    cfg = deps.cfg || load({ root: process.cwd(), env: deps.env || process.env });
    inventory = JSON.parse(fs.readFileSync(inventoryFile, 'utf8'));
  } catch (e) { process.stderr.write(`landing-cleanup: ${e.code === 'ENOENT' ? `cannot read ${inventoryFile}` : e.message}\n`); return 2; }
  const say = line => process.stdout.write(`${line}\n`);
  const p = plan({ cfg, inventory, archiveRoot: archive ? path.resolve(archive) : undefined, ...deps.plan });
  if (p.refusals.length) { for (const r of p.refusals) say(`LANDING-CLEANUP REFUSED ${r}`); return 3; }
  printPlan(p, say);
  if (!doApply) { say('plan only; nothing was changed'); return 0; }
  return apply(p, { cfg, say, ...deps.apply }).code;
}

module.exports = { REMOVE, statusEntries, plan, printPlan, apply, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

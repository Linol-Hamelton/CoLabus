'use strict';
// Cleanup after a landing, archive first (PROTO-DEC-0249 item 4, row P-155).
//   node .ai/bin/ops-tools/landing-cleanup.cjs --inventory FILE [--apply] [--archive DIR]
// FILE is the output of wt-inventory.cjs --json. Without --apply the tool prints the plan, item by item, and changes nothing.
// With --apply:
// 1. archive: the untracked review files and journals (docs/reviews/*.md, .ai/worklog/*.md) of every tree to be removed are
//    copied under <archive>/cleanup-YYYYMMDD/trees/ and compared byte for byte; the unlanded local branches go into one git
//    bundle that is verified and checked to hold every tip (legacy plans only). Any failure stops before anything is removed.
// 2. remove, only after step 1 succeeded: git worktree remove of the classes landed, seat-ended, orphan and detached-in-line;
//    git branch -D only with a landed record and no commit younger than 72 hours, rechecked at apply; the temp root of an ended seat
//    past the retention.
// Never touched: the main checkout, a live seat's tree or temp root, a branch in work, an owner session, the current directory,
// a tree with uncommitted work other than archivable reviews and journals, a tree that holds an ignored file no pattern of the
// caller exempts (the command line names none), a tree that moved since the inventory, a tree that
// holds another registered worktree (nested), a tree that holds the archive directory, a tree whose status cannot be read, and
// any branch a kept tree has checked out. The tool refuses to plan from a stale or foreign inventory, or without the registry.
// Every doubt keeps the tree. The removal is one check-and-act on a tree that cannot change: the tree is first set aside under
// a name of its own (git worktree move; Windows refuses while anything holds it open), everything is read again there, the
// slow look (the walk of the tree) first, the status of the tree after it, the seat records and the registry last, and only
// then is the aside tree removed; on any doubt it is moved back to its own place. A writer that goes by the old path no longer
// reaches the tree, so no file can appear between the last read and the removal.
// The plan is older than every step of the apply, and a seat may start again in between. So each removal reads the seat records
// again right before it acts: a tree stays while a live seat works in it or its temp root holds it; a temp root goes only when
// its seat records, read last, still show the ended attempt the plan saw (the same attempt, the same end) and no live seat works
// inside it; a branch stays while a tree has it checked out or the seat records cannot be read. Any doubt keeps it.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { load } = require('./lib/config.cjs');
const wt = require('./lib/worktrees.cjs');
const { sameAttempt } = require('../lib/seat-slots.cjs');

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

// The reason a tree may not go now, or null. An unreadable status is a reason; an untracked review or journal counts as
// clean only when its copy in the archive is byte for byte the same. The tree stands at `dir`; `home` is the place its copies
// were planned for (they differ while the tree is set aside). The ignored files are always listed in the same status, and
// every ignored file is a reason unless ignoredOk (a pattern) exempts it: only the disposable session state a caller names may
// be ignored, and without ignoredOk none is.
function uncommittedReason(dir, home, copies, raw, files, ignoredOk) {
  if (!files.existsSync(dir)) return null;
  const out = raw(['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=all'], dir);
  if (out === null || out === undefined) return 'the status of the tree could not be read';
  const copied = new Map(copies.map(c => [wt.norm(c.from), c.to]));
  const entries = statusEntries(out);
  for (const e of entries) {
    if (e.code === '!!') {
      if (ignoredOk && ignoredOk.test(e.file)) continue;
      const foreign = entries.filter(x => x.code === '!!' && !(ignoredOk && ignoredOk.test(x.file)));
      return `unknown ignored files (${foreign.length}, first ${foreign[0].file})`;
    }
    if (e.code === '??' && PROMPT_FILE.test(e.file)) continue;
    if (e.code === '??' && ARCHIVABLE.test(e.file)) {
      const to = copied.get(wt.norm(path.join(home, e.file)));
      let same = false;
      try { same = Boolean(to) && files.readFileSync(path.join(dir, e.file)).equals(files.readFileSync(to)); } catch { same = false; }
      if (same) continue;
      return `${e.file} is not archived byte for byte`;
    }
    return `uncommitted work (${e.file})`;
  }
  return null;
}

// The reason a planned temp root may not go now, or null. The plan holds the proof of the ended seat it saw (tempSeats); the
// root, the current directory and last the seat records are read again here, right before the removal.
function tempRootDoubt(dir, p, cfg, files, cwd) {
  const proof = (p.tempSeats || []).find(s => wt.samePath(s.dir, dir));
  if (!proof) return 'the plan holds no proof of its ended seat';
  let stat;
  try { stat = files.lstatSync(dir); } catch (e) { return `it cannot be read (${String(e.code || e.message)})`; }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return 'it is no plain directory any more';
  if (wt.within(cwd, dir)) return 'the current directory is inside it';
  const seatsLast = wt.seatRecords(cfg.runtimeDir, files);
  if (!seatsLast.readable) return 'the seat records are unreadable; what is live is unknown';
  const seat = seatsLast.seats.find(s => s.name === proof.name);
  if (!seat) return `the record of seat ${proof.name} is gone since the plan`;
  if (seat.live) return `seat ${proof.name} is live (it started again since the plan)`;
  if (!sameAttempt(seat.attempt, proof.attempt) || seat.terminalAt !== proof.terminalAt) return `seat ${proof.name} ended another attempt since the plan`;
  const inside = seatsLast.seats.find(s => s.live && ((s.worktree && wt.within(s.worktree, dir)) || (SAFE_NAME.test(s.name) && wt.samePath(path.join(cfg.workRoot, s.name), dir))));
  if (inside) return `live seat ${inside.name} works inside it`;
  return null;
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
  if (!seats.readable) refusals.push(`SEATS-UNREADABLE: the seat records are unreadable${seats.unreadable && seats.unreadable.length ? ` (${seats.unreadable.slice(0, 3).join(', ')})` : ''}; what is live is unknown`);
  if (refusals.length) return { refusals };

  const lineRef = wt.lineRefOf(cfg.author.baseRef);
  const line = wt.lineFacts(git, main, lineRef);
  const registered = wt.listWorktrees(git, main);
  const registeredAt = p => registered.find(w => wt.samePath(w.path, p));
  const liveSeat = p => seats.seats.find(s => s.live && s.worktree && wt.samePath(s.worktree, p));
  const anySeat = p => seats.seats.find(s => s.worktree && wt.samePath(s.worktree, p));
  const liveTemp = seats.seats.filter(s => s.live && SAFE_NAME.test(s.name)).map(s => path.join(cfg.workRoot, s.name));

  const day = new Date(now()).toISOString().slice(0, 10).replace(/-/g, '');
  const archiveDir = path.join(options.archiveRoot || cfg.cleanup.archiveRoot, `cleanup-${day}`);
  const kept = [];
  const trees = [];
  const keptBranches = new Set();
  for (const row of inv.rows) {
    if (!REMOVE.has(row.cls) || wt.samePath(row.path, main)) { if (row.branch) keptBranches.add(row.branch); continue; }
    const why = (() => {
      const now1 = registeredAt(row.path);
      if (!now1) return 'not a registered worktree of this repository';
      if (row.fullHead && now1.head !== row.fullHead) return 'moved since the inventory';
      const inside = registered.find(w => !wt.samePath(w.path, row.path) && wt.within(w.path, row.path));
      if (inside) return `a registered worktree is nested inside it (${inside.path}); removing the outer tree would destroy it`;
      if (liveSeat(row.path)) return 'live seat';
      if (cfg.cleanup.ownerSessionPattern.test(row.path)) return 'owner session';
      if (wt.within(cwd, row.path)) return 'the current directory is inside it';
      const under = liveTemp.find(dir => wt.within(row.path, dir));
      if (under) return `under the temp root of a live seat (${path.basename(under)})`;
      const seat = anySeat(row.path);
      if (seat && seat.stream && registry.open.has(seat.stream)) return `seat of open package ${seat.stream}`;
      if (now1.branch && registry.open.has(now1.branch)) return `branch ${now1.branch} is in work`;
      if ((row.cls === 'landed' || row.cls === 'detached-in-line') && !(line.isLandedTip(now1.head) || line.inLine(now1.head))) return 'not in the line any more';
      if (!wt.packageLanded(now1, seats, registry, line, git, main)) return 'package has no landed record';
      if (wt.within(wt.physical(archiveDir), wt.physical(row.path))) return 'the archive directory lies inside it; the archive is never deleted';
      if (row.exists || files.existsSync(row.path)) {
        // With listIgnored (the command line) the plan lists the ignored files too and names the tree that holds one no pattern
        // of ignoredOk exempts; post-landing.cjs lists them with its own pattern before it applies.
        const out = raw(['status', '--porcelain=v1', '-z', ...(options.listIgnored ? ['--ignored'] : []), '--untracked-files=all'], row.path);
        if (out === null || out === undefined) return 'the status of the tree could not be read; what is uncommitted is unknown';
        const entries = statusEntries(out);
        const ignored = entries.filter(e => e.code === '!!' && !(options.ignoredOk && options.ignoredOk.test(e.file)));
        if (ignored.length) return `unknown ignored files (${ignored.length}, first ${ignored[0].file})`;
        const loose = entries.filter(e => e.code !== '!!' && !(e.code === '??' && (ARCHIVABLE.test(e.file) || PROMPT_FILE.test(e.file))));
        if (loose.length) return `uncommitted work outside archivable reviews and journals (${loose.length} paths, first ${loose[0].file})`;
      }
      return null;
    })();
    if (why) { kept.push({ row, why }); if (row.branch) keptBranches.add(row.branch); } else trees.push(row);
  }

  // A registry omission, a superseded row or an archive bundle is never permission to delete unlanded work.
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
    if (wt.branchKeepReason(name, sha, registry, line, git, main, now())) continue;
    delLanded.push({ name, sha });
  }

  const copies = [];
  for (const tree of trees) {
    if (!files.existsSync(tree.path)) continue;
    const slot = `${path.basename(tree.path)}-${Buffer.from(wt.norm(tree.path)).toString('hex').slice(-8)}`;
    for (const entry of statusEntries(raw(['status', '--porcelain=v1', '-z', '--untracked-files=all'], tree.path))) {
      if (entry.code === '??' && ARCHIVABLE.test(entry.file)) copies.push({ from: path.join(tree.path, entry.file), to: path.join(archiveDir, 'trees', slot, entry.file) });
    }
  }

  // Temp roots of ended seats past the retention: one plain directory directly under the work root, named like the seat.
  // tempSeats keeps, for each, the ended attempt that was seen here; the apply removes the root only for that same attempt.
  const tempRoots = [];
  const tempSeats = [];
  for (const seat of seats.seats) {
    if (seat.live || seat.terminalAt === null || !SAFE_NAME.test(seat.name) || cfg.cleanup.reservedNames.includes(seat.name)) continue;
    if (now() - seat.terminalAt <= cfg.cleanup.tempRetentionMs) continue;
    const dir = path.join(cfg.workRoot, seat.name);
    let stat;
    try { stat = files.lstatSync(dir); } catch { continue; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
    if (wt.within(cwd, dir) || liveTemp.some(l => wt.samePath(l, dir))) continue;
    if (wt.within(wt.physical(archiveDir), wt.physical(dir))) continue;
    if (registered.some(w => wt.within(w.path, dir) && !trees.some(t => wt.samePath(t.path, w.path)))) continue;
    tempRoots.push(dir);
    tempSeats.push({ dir, name: seat.name, attempt: seat.attempt || null, terminalAt: seat.terminalAt });
  }
  return { refusals: [], trees, kept, delLanded, delBundle, copies, tempRoots, tempSeats, archiveDir };
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
  const { strict, git, raw } = options.git ? { strict: options.strict, git: options.git, raw: options.raw || options.git } : readers(options);
  const now = options.now || (() => Date.now());
  const cwd = options.cwd || process.cwd();
  const lines = [];
  const kept = [];
  const say = line => { lines.push(line); if (options.say) options.say(line); };
  const keep = (tree, why) => { kept.push({ path: tree, why }); say(`KEPT ${tree}: ${why}`); };
  // A live seat of the tree, as the plan judges it: the seat works in the tree, or its temp root holds the tree.
  const liveFor = (seats, tree) => seats.seats.some(s => s.live && ((s.worktree && wt.within(s.worktree, tree)) ||
    (typeof cfg.workRoot === 'string' && SAFE_NAME.test(s.name) && wt.within(tree, path.join(cfg.workRoot, s.name)))));

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
  let stuck = null;
  const asideName = tree => {
    const stem = `${tree}.landing-cleanup-${process.pid}-${now().toString(36)}`;
    // A busy namespace is a doubt, never an unbounded search or an occupied destination.
    for (let i = 0; i < 100; i++) { const q = i ? `${stem}-${i}` : stem; if (!files.existsSync(q)) return q; }
    return null;
  };
  for (const t of p.trees) {
    const current = wt.listWorktrees(git, main).find(w => wt.samePath(w.path, t.path));
    const registry = wt.readRegistry(cfg.runtimeDir, files);
    const seats = wt.seatRecords(cfg.runtimeDir, files);
    const line = wt.lineFacts(git, main, wt.lineRefOf(cfg.author.baseRef));
    if (!current || current.head !== t.fullHead || !registry.present || !seats.readable || liveFor(seats, t.path) ||
        !wt.packageLanded(current, seats, registry, line, git, main)) {
      keep(t.path, 'moved, live or package not landed'); continue;
    }
    const inside = wt.listWorktrees(git, main).find(w => !wt.samePath(w.path, t.path) && wt.within(w.path, t.path));
    if (inside) { keep(t.path, `a registered worktree is nested inside it (${inside.path})`); continue; }
    if (p.archiveDir && wt.within(wt.physical(p.archiveDir), wt.physical(t.path))) { keep(t.path, 'the archive directory lies inside it; the archive is never deleted'); continue; }

    // Set the tree aside: from here nothing that goes by its old path reaches it, so the reads below cannot be outdated by a write.
    const aside = asideName(t.path);
    if (!aside) { keep(t.path, 'no free set-aside name after 100 attempts'); continue; }
    try { strict(['worktree', 'move', t.path, aside], main); } catch (e) { keep(t.path, `it could not be set aside for the removal (something may hold it open): ${e.message}`); continue; }
    const putBack = why => {
      try { strict(['worktree', 'move', aside, t.path], main); keep(t.path, why); } catch (e) {
        stuck = aside;
        say(`QUARANTINE-STUCK ${aside}: the tree could not be moved back to ${t.path} (${String(e.message).slice(0, 160)}); stop, restore it by hand`);
      }
    };
    const there = wt.listWorktrees(git, main);
    const now1 = there.find(w => wt.samePath(w.path, aside));
    const nested = there.find(w => !wt.samePath(w.path, aside) && wt.within(w.path, aside));
    let doubt = null;
    if (!now1 || now1.head !== t.fullHead) doubt = 'moved while it was set aside';
    else if (nested) doubt = `a registered worktree is nested inside it (${nested.path})`;
    // The slow look (the walk of the whole tree) first. Then the facts that other sessions can change, in the order of how
    // fast they change: the line (git history), the status of the tree, and last the seat records and the registry.
    if (!doubt && options.beforeRemove) { try { doubt = options.beforeRemove(aside); } catch (e) { doubt = `the last check failed: ${String(e.message).slice(0, 120)}`; } }
    const lineNow = doubt ? null : wt.lineFacts(git, main, wt.lineRefOf(cfg.author.baseRef));
    if (!doubt) doubt = uncommittedReason(aside, t.path, p.copies, raw, files, options.ignoredOk);
    if (!doubt) {
      const registryNow = wt.readRegistry(cfg.runtimeDir, files);
      const seatsNow = wt.seatRecords(cfg.runtimeDir, files);
      if (!registryNow.present || !seatsNow.readable || liveFor(seatsNow, t.path) ||
          !wt.packageLanded({ ...now1, path: t.path }, seatsNow, registryNow, lineNow, git, main)) doubt = 'moved, live or package not landed';
    }
    if (doubt) putBack(doubt);
    else {
      try { strict(['worktree', 'remove', '--force', aside], main); removed++; }
      catch (e) { failed++; putBack(e.message); }
    }
    if (stuck) break;
  }
  if (stuck) return { code: 6, lines, removed, failed, deleted: 0, temps: 0, kept };
  git(['worktree', 'prune'], main);
  let deleted = 0;
  for (const b of [...p.delLanded, ...p.delBundle]) {
    // The planned tip must still be the branch's tip: a branch that moved after the plan is not deleted.
    if (git(['rev-parse', '--verify', `refs/heads/${b.name}`], main) !== b.sha) { say(`KEPT branch ${b.name}: moved since the plan`); continue; }
    const registry = wt.readRegistry(cfg.runtimeDir, files);
    const line = wt.lineFacts(git, main, wt.lineRefOf(cfg.author.baseRef));
    const why = wt.branchKeepReason(b.name, b.sha, registry, line, git, main, now());
    if (why) { say(`KEPT branch ${b.name}: ${why}`); continue; }
    // The plan counted the trees it would remove; one kept here (put back, or kept before the move) may still have it checked out.
    const trees = wt.listWorktrees(git, main);
    if (!trees.length) { say(`KEPT branch ${b.name}: the worktree list could not be read`); continue; }
    if (trees.some(w => w.branch === b.name)) { say(`KEPT branch ${b.name}: a tree has it checked out`); continue; }
    if (!wt.seatRecords(cfg.runtimeDir, files).readable) { say(`KEPT branch ${b.name}: the seat records are unreadable; what is live is unknown`); continue; }
    if (git(['branch', '-D', b.name], main) !== null) deleted++;
  }
  let temps = 0;
  for (const dir of p.tempRoots) {
    // Everything is read again for each root, the seat records last (tempRootDoubt), right before the removal.
    const registered = wt.listWorktrees(git, main);
    if (!registered.length) { say(`KEPT ${dir}: the worktree list could not be read`); continue; }
    if (registered.some(w => wt.within(w.path, dir))) { say(`KEPT ${dir}: a registered worktree is inside`); continue; }
    if (p.archiveDir && wt.within(wt.physical(p.archiveDir), wt.physical(dir))) { say(`KEPT ${dir}: the archive directory lies inside it`); continue; }
    const why = tempRootDoubt(dir, p, cfg, files, cwd);
    if (why) { say(`KEPT ${dir}: ${why}`); continue; }
    try { files.rmSync(dir, { recursive: true, force: true }); temps++; } catch (e) { say(`KEPT ${dir}: ${String(e.code || e.message)}`); }
  }
  say(`REMOVED trees ${removed}, kept on error ${failed}; deleted branches ${deleted}; removed temp roots ${temps}`);
  return { code: 0, lines, removed, failed, deleted, temps, kept };
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
  const p = plan({ cfg, inventory, archiveRoot: archive ? path.resolve(archive) : undefined, listIgnored: true, ...deps.plan });
  if (p.refusals.length) { for (const r of p.refusals) say(`LANDING-CLEANUP REFUSED ${r}`); return 3; }
  printPlan(p, say);
  if (!doApply) { say('plan only; nothing was changed'); return 0; }
  return apply(p, { cfg, say, ...deps.apply }).code;
}

module.exports = { REMOVE, statusEntries, plan, printPlan, apply, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

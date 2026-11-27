'use strict';
// After a train lands (G12-POST-LANDING). Three steps, one command:
//   node .ai/bin/ops-tools/post-landing.cjs [--repo DIR] [--train-base REF] [--line REF] [--archive DIR]
//                                           [--no-retire] [--apply --decision ID]
// 1. verify the line: train-land verify over the train range (Landed-Tip trailers) and the consumer index against a rebuild;
// 2. merge-tree every branch that is in work against the line and name the conflicts early (git merge-tree changes nothing);
// 3. retire the trees of landed packages (author and certifier seats) through the plan of landing-cleanup.cjs, with the
//    extra conditions of the standing class POST-LANDING-TREE-REMOVAL: the tip is in the line or sits in a verified bundle,
//    no uncommitted work and no unknown ignored file, no registered worktree and no other repository (.git) nested inside
//    the tree, a place under the directory of the main checkout or the work root, the archive outside the tree, reports and
//    journals copied byte for byte, and a rename probe proves that nothing holds the tree open. Every doubt keeps the tree:
//    an unreadable status, an unreadable seat record, a directory that cannot be listed. The checks run again immediately
//    before each removal, on the tree set aside for it (landing-cleanup.cjs: one check-and-act, the walk first, then the status
//    with the ignored files, then the seat records and the registry; any doubt puts the tree back). --line is the line of all
//    three steps. Branches are never deleted here. Every removal and every
//    kept or failed tree is logged, with the bytes it freed.
// Without --apply the tool prints the plan and changes nothing but the reversible rename probe. --apply is refused unless
// --decision names an Accepted, owner-approved block of .ai/DECISIONS.md that carries the class name.
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const { spawnSync } = require('node:child_process');
const { load } = require('./lib/config.cjs');
const textSafe = require('../lib/text-safe.cjs');
const wt = require('./lib/worktrees.cjs');
const inventoryTool = require('./wt-inventory.cjs');
const clean = require('./landing-cleanup.cjs');
const train = require('./train-land.cjs');

const CLASS = 'POST-LANDING-TREE-REMOVAL';
const RETIRE = new Set(['landed', 'seat-ended', 'detached-in-line']);
// Ignored paths that are disposable session state; any other ignored file is unknown work and keeps the tree.
const IGNORED_OK = /^(?:\.ai\/runtime\/|node_modules\/|\.mmx-tmp\/|temp\/|\.kilo\/|\.mimocode\/)/;
const DECISION_ID = /^(?:[A-Z]+-)?DEC-\d{4}$/;

function runner(spawn = spawnSync) {
  const run = (args, cwd) => spawn('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const strict = (args, cwd) => {
    const r = run(args, cwd);
    if (r.error || r.status !== 0) throw Object.assign(new Error(String((r.stderr || (r.error && r.error.message) || `git ${args[0]} failed`)).split('\n')[0].slice(0, 200)), { code: 'LANDING-CLEANUP-GIT' });
    return String(r.stdout || '').trim();
  };
  const raw = (args, cwd) => { const r = run(args, cwd); return r.error || r.status !== 0 ? null : String(r.stdout || ''); };
  const git = (args, cwd) => { const r = run(args, cwd); return r.error || r.status !== 0 ? null : String(r.stdout || '').trim(); };
  return { run, strict, raw, git };
}

// Step 1b: the committed consumer index must equal an independent rebuild. A tree without the index tooling is skipped, not failed.
function defaultConsumers(root) {
  let c, a, t;
  try {
    c = require(path.join(root, '.ai/bin/protocol-consumers.cjs'));
    a = require(path.join(root, '.ai/bin/protocol-affected.cjs'));
    t = require(path.join(root, '.ai/bin/protocol-test.cjs'));
  } catch { return { status: 'SKIPPED', detail: 'the consumer index tooling is not present' }; }
  const file = path.join(root, c.INDEX_PATH);
  if (!fs.existsSync(file)) return { status: 'SKIPPED', detail: `${c.INDEX_PATH} is not tracked` };
  const committed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const snapshot = a.workingSnapshot(root);
  const rebuilt = c.buildIndex(snapshot.files, t.discoverTestInventory(root, snapshot.files).tests, committed.gitTree);
  return util.isDeepStrictEqual(rebuilt, committed)
    ? { status: 'OK', detail: committed.inputDigest }
    : { status: 'STALE', detail: `${c.INDEX_PATH} differs from a rebuild; regenerate it with the consumer index tool` };
}

function verifyLine({ repo, lineRef, trainBase, git, spawn, consumers, skipConsumers }) {
  const base = trainBase || git(['rev-parse', '--verify', '--quiet', `${lineRef}@{1}`], repo);
  let trailers;
  if (!base) trailers = { status: 'SKIPPED', detail: 'no train base: pass --train-base REF (the line before the train)' };
  else {
    const r = train.verify({ repo, base, head: lineRef, spawn });
    if (r.ok) trailers = { status: 'OK', detail: `${r.landings.length} landings from ${r.base.slice(0, 8)} to ${r.head.slice(0, 8)}` };
    else if (r.code === 'TRAIN-LAND-EMPTY') trailers = { status: 'SKIPPED', detail: 'the train range is empty; pass --train-base REF' };
    else trailers = { status: 'FAIL', detail: `${r.code}: ${r.detail}` };
  }
  let index;
  if (skipConsumers) index = { status: 'SKIPPED', detail: '--skip-consumers' };
  else { try { index = consumers(); } catch (e) { index = { status: 'FAIL', detail: String(e.message).slice(0, 200) }; } }
  return { trailers, consumers: index };
}

// Step 2: a branch in work is any open row of the candidate registry that resolves to a local branch.
function conflictScan({ git, run, main, registry, lineRef }) {
  if (!registry.present) return { rows: [], unknown: 'the candidate registry is unreadable; what is in work is unknown' };
  const lineOid = git(['rev-parse', '--verify', '--quiet', `${lineRef}^{commit}`], main);
  if (!lineOid) return { rows: [], unknown: `${lineRef} does not resolve` };
  const rows = [];
  for (const name of [...registry.open].sort()) {
    const sha = git(['rev-parse', '--verify', '--quiet', `refs/heads/${name}^{commit}`], main);
    if (!sha) continue;
    if (git(['merge-base', '--is-ancestor', sha, lineOid], main) !== null) { rows.push({ branch: name, sha, state: 'in-line', files: [] }); continue; }
    const r = run(['merge-tree', '--write-tree', '--name-only', '--no-messages', lineOid, sha], main);
    if (r.error || (r.status !== 0 && r.status !== 1)) rows.push({ branch: name, sha, state: 'error', files: [], detail: String(r.stderr || (r.error && r.error.message) || '').split('\n')[0].slice(0, 160) });
    else if (r.status === 0) rows.push({ branch: name, sha, state: 'clean', files: [] });
    else rows.push({ branch: name, sha, state: 'conflict', files: String(r.stdout || '').split('\n').slice(1).map(s => s.trim()).filter(Boolean) });
  }
  return { rows, unknown: null };
}

// Rename the top directory to a unique sibling name and straight back: a handle open inside the tree makes Windows refuse.
function probeRename(dir, files = fs, suffix = `${process.pid}-${Date.now().toString(36)}`) {
  const moved = `${dir}.post-landing-probe-${suffix}`;
  try { files.renameSync(dir, moved); } catch (e) { return { ok: false, code: e.code || 'RENAME' }; }
  try { files.renameSync(moved, dir); } catch (e) { return { ok: false, stuck: moved, code: e.code || 'RENAME-BACK' }; }
  return { ok: true };
}

// One walk of a tree; links are counted as nothing and never followed. bytes is the logical size, or null when any directory
// or file could not be read (an unknown size is not zero); nested is the first .git below the top, a repository of its own
// with work this tool cannot see; unknown is the first place that could not be read. A vanished entry is not unknown.
function scanTree(dir, files = fs) {
  let bytes = 0;
  let nested = null;
  let unknown = null;
  const stack = [dir];
  while (stack.length) {
    const here = stack.pop();
    let entries;
    try { entries = files.readdirSync(here, { withFileTypes: true }); } catch (e) { if (!e || e.code !== 'ENOENT') unknown = unknown || here; continue; }
    for (const e of entries) {
      const full = path.join(here, e.name);
      if (e.name === '.git' && here !== dir && !nested) nested = full;
      if (e.isSymbolicLink()) continue;
      if (e.isDirectory()) stack.push(full);
      else if (e.isFile()) { try { bytes += files.lstatSync(full).size; } catch (err) { if (!err || err.code !== 'ENOENT') unknown = unknown || full; } }
    }
  }
  return { bytes: unknown ? null : bytes, nested, unknown };
}

function treeBytes(dir, files = fs) { return scanTree(dir, files).bytes; }

// Why a tree may not go, or null; bytes of the tree when it may. Ignored files are listed too: only disposable session
// state may be ignored. The plan reads both here. The last look before the removal is only the walk (scanDoubt): the ignored
// files are read by the one status of landing-cleanup.cjs that comes after it (ignoredOk), so no file made during the walk is
// outside the last status.
function scanDoubt(dir, files) {
  const scan = scanTree(dir, files);
  if (scan.unknown) return { why: `the tree could not be read completely (${scan.unknown}); what it holds is unknown` };
  if (scan.nested) return { why: `a repository of its own is nested inside it (${scan.nested}); its work is unknown` };
  return { why: null, bytes: scan.bytes };
}

function treeDoubt(raw, dir, files) {
  const walked = scanDoubt(dir, files);
  if (walked.why) return walked;
  const out = raw(['status', '--porcelain=v1', '-z', '--ignored', '--untracked-files=normal'], dir);
  if (out === null || out === undefined) return { why: 'ignored files could not be listed' };
  const foreign = clean.statusEntries(out).filter(e => e.code === '!!' && !IGNORED_OK.test(e.file));
  if (foreign.length) return { why: `unknown ignored files (${foreign.length}, first ${foreign[0].file})` };
  return walked;
}

function freeBytes(dir, files = fs) {
  try { const s = files.statfsSync(dir); return Number(s.bavail) * Number(s.bsize); } catch { return null; }
}

// The roots a retired tree may live under: the directory that holds the main checkout (the family) and the work root. Paths
// are compared by their physical place (a junction or link out of the family does not count), and the directory above a
// main checkout that sits at a drive root is the whole drive: it is no family.
function withinFamily(dir, cfg) {
  const parent = path.dirname(path.resolve(cfg.main));
  const roots = [path.dirname(parent) === parent ? null : parent, cfg.workRoot].filter(Boolean).map(wt.physical);
  dir = wt.physical(dir);
  return roots.some(root => wt.within(dir, root));
}

// Canonical form of .ai/DECISIONS.md (P-L9-002, read by the shared strict reader of text-safe.cjs): UTF-8 without a byte order
// mark, LF only, no NUL, no invisible or look-alike control character, a final newline. Anything else is refused with its
// reason, never read. The statements are the document's own lines only: a block inside a fence, an HTML comment, an HTML
// element, a quote, indented code or a table is an example, not a decision. A block named twice is ambiguous. A block ends at
// the next heading of its own level or above (#, ## or ###, ATX or setext): a later section of the document is not part of the
// decision, whatever it names.
const DECISION_POLICY = { bom: 'refuse', crlf: 'refuse', invisible: 'refuse', finalNewline: 'refuse' };
const BLOCK_END_ATX = /^ {0,3}#{1,3}(?:[ \t]|$)/;
function endsBlock(l) {
  return !l.masked && (l.kinds.includes('setext-heading') || (l.kinds.includes('heading') && BLOCK_END_ATX.test(l.text)));
}
function decisionApproves(source, id, mark = CLASS) {
  if (!DECISION_ID.test(String(id || ''))) return `--decision must name a block like PROTO-DEC-0255, got ${JSON.stringify(String(id || '').slice(0, 40))}`;
  const decoded = typeof source === 'string' ? textSafe.decodeText(source, DECISION_POLICY) : textSafe.decode(source, DECISION_POLICY);
  if (!decoded.ok) return `.ai/DECISIONS.md is not read: non-canonical text (${[...new Set(decoded.problems.map(p => p.code))].join(', ')})`;
  const own = new Map(textSafe.ownLines(decoded.text).map(l => [l.line, l.text]));
  const lines = decoded.text.split('\n').map((_, i) => own.get(i + 1) || '');
  const heads = lines.map((l, i) => (l.trim() === `### ${id}` ? i : -1)).filter(i => i >= 0);
  if (!heads.length) return `${id} is not a block of .ai/DECISIONS.md`;
  if (heads.length > 1) return `${id} is a block more than once; which one is meant is unknown`;
  const start = heads[0];
  const marks = textSafe.maskMarkdown(decoded.text).lines;
  let end = marks.findIndex((l, i) => i > start && endsBlock(l));
  if (end < 0) end = lines.length;
  const block = lines.slice(start, end).join('\n');
  if ((block.match(/^Status:/gm) || []).length !== 1 || !/^Status: Accepted\s*$/m.test(block)) return `${id} is not Accepted`;
  if (!/^Approved by: \S/m.test(block) || /^Approved by:\s*(?:TBD|TODO|n\/a|none|pending|-)\s*$/im.test(block)) return `${id} carries no Approved by line`;
  if (!(mark instanceof RegExp ? mark.test(block) : block.includes(mark))) return `${id} does not name ${mark instanceof RegExp ? `the rule ${mark.source}` : `the class ${mark}`}`;
  return null;
}

// Step 3. Returns the plan rows; with apply it also removes them.
function retire(o) {
  const { git, run, raw, strict, files = fs, apply = false, archiveRoot, cwd, now = () => Date.now(), say } = o;
  // One line for the whole step: the inventory, the plan of the cleanup and the tip test all read cfg.author.baseRef.
  const cfg = o.lineRef ? { ...o.cfg, author: { ...o.cfg.author, baseRef: o.lineRef } } : o.cfg;
  const main = path.resolve(cfg.main);
  const lineRef = wt.lineRefOf(cfg.author.baseRef);
  const inv = inventoryTool.inventory({ cfg, git, fs: files, now });
  const p = clean.plan({ cfg, inventory: inv, archiveRoot, cwd, git, raw, fs: files, now });
  if (p.refusals.length) return { refusals: p.refusals, kept: [], approved: [] };
  const kept = p.kept.map(k => ({ path: k.row.path, why: k.why }));
  const approved = [];
  for (const row of p.trees) {
    if (!RETIRE.has(row.cls)) { kept.push({ path: row.path, why: `class ${row.cls} is not in the standing deletion class` }); continue; }
    if (!withinFamily(row.path, cfg)) { kept.push({ path: row.path, why: 'outside the directory of the main checkout and the work root' }); continue; }
    const doubt = treeDoubt(raw, row.path, files);
    if (doubt.why) { kept.push({ path: row.path, why: doubt.why }); continue; }
    const inLine = git(['merge-base', '--is-ancestor', row.fullHead, lineRef], main) !== null;
    const bundle = inLine ? null : path.join(p.archiveDir, 'post-landing-bundles', `${row.fullHead.slice(0, 12)}.bundle`);
    approved.push({ row, inLine, bundle, bytes: doubt.bytes });
  }

  // Probe last: it is the only step that touches a tree, and it touches only those that passed everything else.
  const open = [];
  for (const a of approved.slice()) {
    const probe = probeRename(a.row.path, files);
    if (probe.stuck) return { refusals: [`PROBE-STUCK: ${a.row.path} was moved to ${probe.stuck} and could not be moved back (${probe.code}); stop and restore it by hand`], kept, approved: [] };
    if (!probe.ok) { kept.push({ path: a.row.path, why: `rename probe refused (${probe.code}): something holds the tree open` }); open.push(a); }
  }
  const final = approved.filter(a => !open.includes(a));
  const result = { refusals: [], kept, approved: final, archiveDir: p.archiveDir, removed: [], failed: [] };
  for (const k of kept) say(`POST-LANDING KEEP ${k.path}: ${k.why}`);
  for (const a of final) say(`POST-LANDING REMOVE-TREE ${a.row.cls} ${a.row.path} ${a.row.branch || ''} tip ${a.inLine ? 'in the line' : `bundle ${a.bundle}`} ${a.bytes} bytes`);
  if (!apply) return result;

  // Tips outside the line are saved first; a bundle that does not verify keeps its tree.
  const saved = [];
  for (const a of final) {
    if (a.inLine) { saved.push(a); continue; }
    try {
      if (!files.existsSync(a.bundle)) {
        files.mkdirSync(path.dirname(a.bundle), { recursive: true });
        strict(['bundle', 'create', a.bundle, 'HEAD', `^${lineRef}`], a.row.path);
      }
      strict(['bundle', 'verify', a.bundle], main);
      if (!strict(['bundle', 'list-heads', a.bundle], main).split('\n').some(l => l.startsWith(`${a.row.fullHead} `))) throw new Error('the bundle does not hold the tip');
      saved.push(a);
    } catch (e) { result.failed.push({ path: a.row.path, why: `tip bundle failed: ${e.message}` }); say(`POST-LANDING KEEP ${a.row.path}: tip bundle failed: ${e.message}`); }
  }
  const plan2 = { ...p, trees: saved.map(a => a.row), delLanded: [], delBundle: [], tempRoots: [],
    copies: p.copies.filter(c => saved.some(a => wt.within(c.from, a.row.path))) };
  const before = freeBytes(main, files);
  const lastLook = tree => scanDoubt(tree, files).why;
  const applied = clean.apply(plan2, { cfg, say: line => say(`POST-LANDING ${line}`), git, raw, strict, fs: files, now, beforeRemove: lastLook, ignoredOk: IGNORED_OK });
  if (applied.code !== 0) return { ...result, refusals: [`LANDING-CLEANUP apply stopped with code ${applied.code}`] };
  const registered = wt.listWorktrees(git, main);
  for (const a of saved) {
    if (!registered.some(w => wt.samePath(w.path, a.row.path))) { result.removed.push(a.row.path); continue; }
    const why = (applied.kept || []).find(k => wt.samePath(k.path, a.row.path));
    result.failed.push({ path: a.row.path, why: why ? why.why : 'still registered after the removal' });
  }
  const goneBytes = saved.filter(a => result.removed.includes(a.row.path)).reduce((s, a) => s + a.bytes, 0);
  const after = freeBytes(main, files);
  result.logicalBytes = goneBytes;
  result.freeDelta = before === null || after === null ? null : after - before;
  const record = { at: new Date(now()).toISOString(), line: lineRef, archive: p.archiveDir,
    removed: saved.filter(a => result.removed.includes(a.row.path)).map(a => ({ path: a.row.path, branch: a.row.branch, head: a.row.fullHead, bytes: a.bytes, tip: a.inLine ? 'line' : path.relative(p.archiveDir, a.bundle).split(path.sep).join('/') })),
    kept, failed: result.failed, logicalBytes: goneBytes, freeDelta: result.freeDelta };
  files.mkdirSync(p.archiveDir, { recursive: true });
  files.appendFileSync(path.join(p.archiveDir, 'post-landing-log.jsonl'), `${JSON.stringify(record)}\n`);
  say(`POST-LANDING RETIRED trees ${result.removed.length}, kept ${kept.length + result.failed.length}; logical bytes ${goneBytes}; free space delta ${result.freeDelta === null ? 'unknown' : result.freeDelta} bytes; log ${path.join(p.archiveDir, 'post-landing-log.jsonl')}`);
  return result;
}

function parse(argv) {
  const args = argv.slice();
  const flag = name => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  const value = name => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; if (!v || v.startsWith('--')) throw new Error(`missing value for ${name}`); args.splice(i, 2); return v; };
  const o = { apply: flag('--apply'), noRetire: flag('--no-retire'), skipConsumers: flag('--skip-consumers'),
    repo: value('--repo'), trainBase: value('--train-base'), line: value('--line'), archive: value('--archive'), decision: value('--decision') };
  if (args.length) throw new Error(`unexpected argument ${args[0]}`);
  return o;
}

function main(argv, deps = {}) {
  const out = deps.say || (line => process.stdout.write(`${line}\n`));
  let o;
  try { o = parse(argv); } catch (e) {
    process.stderr.write(`post-landing: ${e.message}\nusage: post-landing.cjs [--repo DIR] [--train-base REF] [--line REF] [--archive DIR] [--no-retire] [--skip-consumers] [--apply --decision ID]\n`);
    return 2;
  }
  const repo = path.resolve(o.repo || deps.cwd || process.cwd());
  let cfg;
  try { cfg = deps.cfg || load({ root: repo, env: deps.env || process.env }); } catch (e) { process.stderr.write(`post-landing: ${e.message}\n`); return 2; }
  const main_ = path.resolve(cfg.main);
  const { run, strict, raw, git } = deps.git ? deps.git : runner(deps.spawn);
  const files = deps.fs || fs;
  let lineRef = wt.lineRefOf(cfg.author.baseRef);
  if (o.line) {
    // A branch name of any spelling becomes its full ref, so that the three steps cannot read different lines.
    const full = git(['rev-parse', '--symbolic-full-name', '--verify', '--quiet', o.line], main_);
    if (!full || !full.startsWith('refs/')) { process.stderr.write(`post-landing: --line must name a branch, got ${JSON.stringify(o.line.slice(0, 80))}\n`); return 2; }
    lineRef = full;
  }
  if (o.apply) {
    let text = '';
    try { text = files.readFileSync(path.join(repo, '.ai', 'DECISIONS.md')); } catch { /* refused below */ }
    const why = decisionApproves(text, o.decision);
    if (why) { process.stderr.write(`post-landing: --apply refused: ${why}\n`); return 3; }
  }
  const lineOid = git(['rev-parse', '--verify', '--quiet', `${lineRef}^{commit}`], main_);
  if (!lineOid) { process.stderr.write(`post-landing: ${lineRef} does not resolve\n`); return 2; }
  out(`POST-LANDING LINE ${lineRef} ${lineOid.slice(0, 8)}`);

  const v = verifyLine({ repo, lineRef, trainBase: o.trainBase, git, spawn: deps.spawn, skipConsumers: o.skipConsumers,
    consumers: deps.consumers || (() => defaultConsumers(repo)) });
  out(`POST-LANDING TRAILERS ${v.trailers.status} ${v.trailers.detail}`);
  out(`POST-LANDING CONSUMERS ${v.consumers.status} ${v.consumers.detail}`);
  const broken = [v.trailers, v.consumers].some(x => x.status === 'FAIL' || x.status === 'STALE');

  const registry = wt.readRegistry(cfg.runtimeDir, files);
  const scan = conflictScan({ git, run, main: main_, registry, lineRef });
  if (scan.unknown) out(`POST-LANDING MERGE-TREE UNKNOWN ${scan.unknown}`);
  for (const r of scan.rows) out(`POST-LANDING ${r.state === 'conflict' ? 'CONFLICT' : 'MERGE-TREE'} ${r.branch} ${r.sha.slice(0, 8)} ${r.state}${r.files.length ? ` ${r.files.join(', ')}` : ''}${r.detail ? ` ${r.detail}` : ''}`);
  const conflicts = scan.rows.filter(r => r.state === 'conflict').length;
  out(`POST-LANDING MERGE-TREE branches ${scan.rows.length}, conflicts ${conflicts}`);

  if (o.noRetire) { out('POST-LANDING retire step skipped (--no-retire)'); return broken ? 1 : 0; }
  if (broken) { out('POST-LANDING retire step skipped: the line did not verify'); return 1; }
  const res = retire({ cfg, lineRef, git, run, raw, strict, files, apply: o.apply, archiveRoot: o.archive ? path.resolve(o.archive) : undefined,
    cwd: deps.cwd || process.cwd(), now: deps.now, say: out });
  if (res.refusals.length) { for (const r of res.refusals) out(`POST-LANDING REFUSED ${r}`); return 3; }
  if (!o.apply) out(`POST-LANDING plan only: ${res.approved.length} trees would be retired, ${res.approved.reduce((s, a) => s + a.bytes, 0)} logical bytes; nothing was removed`);
  return res.failed && res.failed.length ? 4 : 0;
}

module.exports = { CLASS, RETIRE, IGNORED_OK, verifyLine, conflictScan, probeRename, scanTree, scanDoubt, treeBytes, freeBytes, withinFamily, decisionApproves, retire, parse, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

'use strict';
// The cleanup after landing: the worktrees of packages that landed and of seats that ended are removed after the work in them is archived.
//   node .ai/bin/ops-tools/post-landing-sweep.cjs [--repo DIR] [--line REF] [--archive DIR] [--farm DIR] [--triage FILE] [--tree-root DIR]... [--json]
//   node .ai/bin/ops-tools/post-landing-sweep.cjs --apply --plan-hash HASH --decision ID [the same options]
// Without --apply the tool prints the plan and its hash and changes nothing. --apply plans AGAIN, refuses unless the new plan has exactly the hash
// that was printed (a tree that changed, a new seat, a new queue entry all change it) and unless --decision names an Accepted, owner-approved
// block of .ai/DECISIONS.md that states the cleanup after landing. A tree goes only when ONE boolean is true (removable, below); every
// unknown makes it false. The archive comes first: for every tree of the plan, before the first removal, the commits that are not in the
// line (one verified git bundle) and the files that are not in git (untracked, modified, deleted, and the ignored ones that are not disposable
// session state) go into one verified tar with a manifest of sha256 per file; one failed step stops the whole batch. Nothing is written
// on the system drive. The farm results, the receipts and the archive itself are never a class of removal.
//
// The facts of a tree, each true, false or unknown:
//   landed    the tree's head is a cited Landed-Tip of the line or an ancestor of it
//   mustLand  the branch is listed as must-land by the triage and its head is not an ancestor of the line (an unreadable, empty or inconsistent
//             triage is unknown, never "nothing is listed")
//   inWork    the candidate registry has the branch or the seat's package open (an unreadable registry is unknown)
//   farmRef   the head is named by an entry of the farm queue or claims (a missing or unreadable queue, claims or entry is unknown)
//   seat      none (no seat record names the tree), ended (every record has its terminal pair, or its owner is PROVEN dead), live, or unknown
//   held      a process names the tree in its command line or executable (an unreadable process table is unknown)
// removable = landed && !mustLand && !inWork && !farmRef && (seat is none or ended) && !held, with every unknown counted against the tree.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { load } = require('./lib/config.cjs');
const wt = require('./lib/worktrees.cjs');

const SCHEMA = 'post-landing-sweep/1';
const DECISION_MARK = /cleanup after landing/i;
const TAR_CAP_BYTES = 2 * 1000 * 1000 * 1000;
const SHA40 = /^[0-9a-f]{40}$/;

// ---- the one boolean ----
function removable(f) {
  const reasons = [];
  if (f.landed !== true) reasons.push(f.landed === false ? 'not landed' : 'landing unknown');
  if (f.mustLand !== false) reasons.push(f.mustLand === true ? 'must-land package not on the line' : 'must-land list unknown');
  if (f.inWork !== false) reasons.push(f.inWork === true ? 'package in work' : 'registry unknown');
  if (f.farmRef !== false) reasons.push(f.farmRef === true ? 'named by the farm queue or claims' : 'farm queue or claims unknown');
  if (f.seat !== 'none' && f.seat !== 'ended') reasons.push(f.seat === 'live' ? 'live seat' : 'seat records unknown');
  if (f.held !== false) reasons.push(f.held === true ? 'a process names the tree' : 'process table unknown');
  return { ok: reasons.length === 0, reasons };
}

// ---- the must-land list (read, never copied) ----
// Consistent means: a records array, a summary whose MUST-LAND total equals the records that carry that decision, and at least one such record.
// A file that parses but lists nothing is as unknown as one that does not parse.
function readMustLand(file, files = fs) {
  let t;
  try { t = JSON.parse(files.readFileSync(file, 'utf8')); } catch (e) { return { ok: false, reason: `triage unreadable (${(e && e.code) || 'parse'})` }; }
  if (!t || !Array.isArray(t.records) || !t.summary || typeof t.summary !== 'object') return { ok: false, reason: 'triage has no records or summary' };
  const key = Object.keys(t.summary).find(k => /^MUST-LAND/.test(k));
  const listed = t.records.filter(r => r && typeof r.decision === 'string' && /^MUST-LAND/.test(r.decision) && typeof r.branch === 'string' && r.branch);
  if (!key || !t.summary[key] || t.summary[key].total !== listed.length || listed.length === 0) return { ok: false, reason: 'triage must-land count is zero or does not match its summary' };
  return { ok: true, branches: new Set(listed.map(r => r.branch)) };
}

// ---- the farm references ----
// Every 40-hex id in an entry of queue/ and claims/ is a reference; the farm results and receipts are not read at all. A missing directory, an
// unreadable directory or one unreadable entry makes the whole answer unknown.
function readFarm(dir, files = fs) {
  const refs = new Set();
  for (const sub of ['queue', 'claims']) {
    let names;
    try { names = files.readdirSync(path.join(dir, sub)); } catch (e) { return { ok: false, reason: `farm ${sub} unreadable (${(e && e.code) || 'error'})` }; }
    for (const n of names) {
      let text;
      try { text = files.readFileSync(path.join(dir, sub, n), 'utf8'); } catch (e) { return { ok: false, reason: `farm ${sub}/${n.slice(0, 40)} unreadable` }; }
      for (const m of text.matchAll(/\b[0-9a-f]{40}\b/g)) refs.add(m[0]);
    }
  }
  return { ok: true, refs };
}

// ---- processes that name a path ----
function mentionsDir(text, dir) {
  const win = process.platform === 'win32';
  const sep = win ? '\\' : '/';
  const norm = v => { const t = String(v || '').replace(win ? /\//g : /\\/g, sep); return win ? t.toLowerCase() : t; };
  let needle = norm(path.resolve(dir));
  while (needle.length > 1 && needle.endsWith(sep)) needle = needle.slice(0, -1);
  const hay = norm(text);
  const nameChar = c => /[A-Za-z0-9_.-]/.test(c);
  for (let at = hay.indexOf(needle); at !== -1; at = hay.indexOf(needle, at + 1)) {
    const before = at === 0 ? '' : hay[at - 1];
    const after = hay[at + needle.length] || '';
    if (before && nameChar(before)) continue;
    if (after && after !== sep && nameChar(after)) continue;
    return true;
  }
  return false;
}
// One snapshot per plan: { ok, rows: [{ pid, text }] }. A table that cannot be read, or is empty, is not "nothing holds it".
function processTable(spawn = spawnSync) {
  try {
    if (process.platform === 'win32') {
      const r = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)" }'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
      if (!r || r.error || r.status !== 0) return { ok: false, rows: [] };
      const rows = String(r.stdout || '').split(/\r?\n/).map(l => l.split('\t')).filter(p => Number(p[0])).map(p => ({ pid: Number(p[0]), text: p.slice(1).join(' ') }));
      return { ok: rows.length > 0, rows };
    }
    const r = spawn('ps', ['-eo', 'pid=,args='], { encoding: 'utf8', timeout: 60000 });
    if (!r || r.error || r.status !== 0) return { ok: false, rows: [] };
    const rows = String(r.stdout || '').split('\n').map(l => /^\s*(\d+)\s+(.*)$/.exec(l)).filter(Boolean).map(m => ({ pid: Number(m[1]), text: m[2] }));
    return { ok: rows.length > 0, rows };
  } catch { return { ok: false, rows: [] }; }
}

// ---- the seat of a tree ----
// none: no record names the tree; ended: every record that names it has its terminal pair or an owner PROVEN dead (the wrapper process is gone, or
// its pid was reused); live: a record without a pair whose owner is alive or unproven; unknown: the records cannot all be read.
function seatState(treePath, cfg, files, deps = {}) {
  const seats = wt.seatRecords(cfg.runtimeDir, files);
  if (!seats.readable) return 'unknown';
  const owned = deps.owned || require('../lib/owned-temp.cjs');
  const mine = seats.seats.filter(s => (s.worktree && wt.samePath(s.worktree, treePath)) || (typeof cfg.workRoot === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(s.name) && wt.within(treePath, path.join(cfg.workRoot, s.name))));
  if (!mine.length) return 'none';
  let state = 'ended';
  for (const s of mine) {
    if (!s.live) continue;
    let rec;
    try { rec = JSON.parse(files.readFileSync(path.join(cfg.runtimeDir, `${s.name}.running.json`), 'utf8')); } catch { return 'unknown'; }
    const pid = rec && Number(rec.wrapperPid);
    if (!Number.isSafeInteger(pid) || pid < 1 || typeof rec.startedAt !== 'string') return 'unknown';
    const dead = owned.ownerState({ pid, host: typeof rec.host === 'string' ? rec.host : null, createdAt: rec.startedAt }, { isAlive: deps.isAlive, startMs: deps.startMs, now: deps.now }).dead;
    if (!dead) return 'live';
  }
  return state;
}

// ---- the files that are not in git ----
function gitList(raw, args, cwd) {
  const out = raw(args, cwd);
  return out === null || out === undefined ? null : String(out).split('\0').filter(Boolean);
}
// sha256 of the content of one plain file, read in blocks; a link or another kind is named, never followed.
function contentDigest(abs, io) {
  if (!io.lstatSync(abs).isFile()) return 'not-a-file';
  const fd = io.openSync(abs, 'r');
  const hash = crypto.createHash('sha256');
  const buf = Buffer.alloc(1 << 20);
  try { for (;;) { const n = io.readSync(fd, buf, 0, buf.length, null); if (!n) break; hash.update(buf.subarray(0, n)); } } finally { io.closeSync(fd); }
  return hash.digest('hex');
}
// null when the index of the tree is exactly HEAD, else the reason to keep it: staged work lives in the index and in no file of the working tree,
// so neither the diff against HEAD nor the archive of the files sees it. Additions, modifications, deletions, renames, mode changes, submodule
// entries, intent-to-add entries and the entries of an unfinished merge all count; a git error is an index that cannot be read, never a clean one.
function indexReason(raw, dir) {
  const staged = raw(['diff', '--cached', '--name-status', '-z', '--no-renames', '--ignore-submodules=none', 'HEAD'], dir);
  const unmerged = raw(['ls-files', '-u', '-z'], dir);
  const intent = raw(['diff', '--name-status', '-z', '--no-renames', '--ignore-submodules=none', '--diff-filter=A'], dir);
  if (staged === null || unmerged === null || intent === null) return 'the index of the tree could not be read';
  if (String(unmerged).replace(/\0/g, '')) return 'the index holds the entries of an unfinished merge';
  if (String(staged).replace(/\0/g, '')) return 'the index differs from HEAD (staged changes)';
  if (String(intent).replace(/\0/g, '')) return 'the index holds an intent-to-add entry';
  return null;
}
// { files: [{ path, kind, sha256 }], deleted: [path], problem } of a tree. Disposable session state (the ignored patterns of post-landing) is not archived.
// The digest binds the CONTENT of every file, so an edit that keeps the size still changes what the plan hash and the tree state say.
// A tree whose index differs from HEAD is a problem: the plan keeps it, the archive stops, and the check after the set-aside puts it back.
function changedSet(raw, dir, disposable, io) {
  const index = indexReason(raw, dir);
  if (index) return { files: [], deleted: [], problem: index };
  const untracked = gitList(raw, ['ls-files', '-z', '--others', '--exclude-standard'], dir);
  const ignored = gitList(raw, ['ls-files', '-z', '--others', '--ignored', '--exclude-standard'], dir);
  const diff = raw(['diff', 'HEAD', '--name-status', '-z', '--no-renames'], dir);
  if (untracked === null || ignored === null || diff === null || diff === undefined) return { files: [], deleted: [], problem: 'the status of the tree could not be read' };
  const files = new Map();
  const deleted = [];
  const parts = String(diff).split('\0').filter(Boolean);
  for (let i = 0; i + 1 < parts.length; i += 2) {
    if (/^D/.test(parts[i])) deleted.push(parts[i + 1]); else files.set(parts[i + 1], 'modified');
  }
  for (const f of untracked) files.set(f, 'untracked');
  for (const f of ignored) if (!disposable.test(f)) files.set(f, 'ignored');
  const list = [...files].map(([p, kind]) => ({ path: p, kind })).sort((a, b) => (a.path < b.path ? -1 : 1));
  for (const f of list) {
    try { f.sha256 = contentDigest(path.join(dir, f.path), io); } catch { return { files: [], deleted: [], problem: `a file to archive cannot be read (${f.path})` }; }
  }
  return { files: list, deleted: deleted.sort(), problem: null };
}

// ---- tar: ustar with GNU long names, written and read here so the verification does not depend on a program ----
const BLOCK = 512;
function octal(n, width) { return `${n.toString(8).padStart(width - 1, '0')}\0`; }
function tarHeader(name, size, mtime, type = '0') {
  const h = Buffer.alloc(BLOCK);
  const nameBytes = Buffer.from(name, 'utf8');
  nameBytes.copy(h, 0, 0, Math.min(100, nameBytes.length));
  h.write(octal(0o644, 8), 100); h.write(octal(0, 8), 108); h.write(octal(0, 8), 116);
  h.write(octal(size, 12), 124); h.write(octal(mtime, 12), 136);
  h.write('        ', 148); h.write(type, 156); h.write('ustar\0', 257); h.write('00', 263);
  let sum = 0; for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148);
  return h;
}
const pad = n => (BLOCK - (n % BLOCK)) % BLOCK;
// Writes the files of `entries` ({ name, abs }) into `file` (created exclusively). Returns { files: [{ name, size, sha256 }] }; a file that changes size
// while it is read, or is not a plain file, stops the write.
function writeTar(file, entries, files = fs) {
  const fd = files.openSync(file, 'wx');
  const out = [];
  try {
    for (const e of entries) {
      const st = files.lstatSync(e.abs);
      if (!st.isFile()) throw Object.assign(new Error(`not a plain file: ${e.name}`), { code: 'TAR-NOT-A-FILE' });
      const nameBytes = Buffer.from(e.name, 'utf8');
      if (nameBytes.length > 100) {
        const body = Buffer.concat([nameBytes, Buffer.from([0])]);
        files.writeSync(fd, tarHeader('././@LongLink', body.length, 0, 'L'));
        files.writeSync(fd, body); files.writeSync(fd, Buffer.alloc(pad(body.length)));
      }
      files.writeSync(fd, tarHeader(e.name, st.size, Math.floor(st.mtimeMs / 1000)));
      const src = files.openSync(e.abs, 'r');
      const hash = crypto.createHash('sha256');
      let copied = 0;
      try {
        const buf = Buffer.alloc(1 << 20);
        for (;;) { const n = files.readSync(src, buf, 0, buf.length, null); if (!n) break; hash.update(buf.subarray(0, n)); files.writeSync(fd, buf, 0, n); copied += n; }
      } finally { files.closeSync(src); }
      if (copied !== st.size) throw Object.assign(new Error(`file changed while archived: ${e.name}`), { code: 'TAR-CHANGED' });
      files.writeSync(fd, Buffer.alloc(pad(copied)));
      out.push({ name: e.name, size: copied, sha256: hash.digest('hex') });
    }
    files.writeSync(fd, Buffer.alloc(BLOCK * 2));
  } finally { files.closeSync(fd); }
  return { files: out };
}
// Reads the tar back: { files: [{ name, size, sha256 }] } or throws on a bad header or a short file.
function readTar(file, files = fs) {
  const fd = files.openSync(file, 'r');
  const out = [];
  try {
    let pos = 0; let longName = null;
    const header = Buffer.alloc(BLOCK);
    for (;;) {
      const n = files.readSync(fd, header, 0, BLOCK, pos);
      if (n === 0) throw Object.assign(new Error('tar ends without its end blocks'), { code: 'TAR-SHORT' });
      if (n < BLOCK) throw Object.assign(new Error('tar header is short'), { code: 'TAR-SHORT' });
      if (header.every(b => b === 0)) return { files: out };
      const stored = parseInt(header.toString('ascii', 148, 154), 8);
      let sum = 0; for (let i = 0; i < BLOCK; i++) sum += i >= 148 && i < 156 ? 32 : header[i];
      if (!Number.isFinite(stored) || stored !== sum) throw Object.assign(new Error('tar header checksum is wrong'), { code: 'TAR-CHECKSUM' });
      const size = parseInt(header.toString('ascii', 124, 135), 8);
      const type = String.fromCharCode(header[156]);
      let name = header.toString('utf8', 0, 100).replace(/\0.*$/s, '');
      pos += BLOCK;
      if (type === 'L') {
        const body = Buffer.alloc(size); files.readSync(fd, body, 0, size, pos);
        longName = body.toString('utf8').replace(/\0.*$/s, ''); pos += size + pad(size); continue;
      }
      if (longName !== null) { name = longName; longName = null; }
      const hash = crypto.createHash('sha256');
      const buf = Buffer.alloc(1 << 20);
      let left = size;
      while (left > 0) {
        const got = files.readSync(fd, buf, 0, Math.min(buf.length, left), pos + (size - left));
        if (!got) throw Object.assign(new Error(`tar file ${name} is short`), { code: 'TAR-SHORT' });
        hash.update(buf.subarray(0, got)); left -= got;
      }
      out.push({ name, size, sha256: hash.digest('hex') });
      pos += size + pad(size);
    }
  } finally { files.closeSync(fd); }
}

// A share path (two leading separators) is never an archive root: the archive is written beside the machine that runs the tool.
const onNetworkPath = p => /^[\\/]{2}[^\\/]/.test(String(p));
const onSystemDrive = p => process.platform === 'win32' && /^[A-Za-z]:/.test(path.resolve(p)) && path.resolve(p).slice(0, 2).toLowerCase() === String(process.env.SystemDrive || 'C:').slice(0, 2).toLowerCase();
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const stable = v => JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(key => [key, x[key]])) : x));

// ---- the plan ----
function runnerOf(spawn) {
  const run = (args, cwd) => (spawn || spawnSync)('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  const raw = (args, cwd) => { const r = run(args, cwd); return !r || r.error || r.status !== 0 ? null : String(r.stdout || ''); };
  const git = (args, cwd) => { const r = raw(args, cwd); return r === null ? null : r.trim(); };
  const strict = (args, cwd) => { const r = run(args, cwd); if (!r || r.error || r.status !== 0) throw new Error(String((r && (r.stderr || (r.error && r.error.message))) || `git ${args[0]} failed`).split('\n')[0].slice(0, 200)); return String(r.stdout || '').trim(); };
  return { run, raw, git, strict };
}

function buildPlan(o) {
  const files = o.fs || fs;
  const cfg = o.cfg;
  const { git, raw } = o.runner;
  const post = require('./post-landing.cjs');
  const main = path.resolve(cfg.main);
  const lineRef = o.lineRef || wt.lineRefOf(cfg.author.baseRef);
  const lineOid = git(['rev-parse', '--verify', '--quiet', `${lineRef}^{commit}`], main);
  const plan = { schema: SCHEMA, line: lineRef, lineOid, archiveRoot: path.resolve(o.archiveRoot || cfg.cleanup.archiveRoot), trees: [], branches: [], refusals: [], kept: [] };
  if (!lineOid) { plan.refusals.push(`${lineRef} does not resolve`); return finish(plan); }
  if (onSystemDrive(plan.archiveRoot)) { plan.refusals.push('the archive root is on the system drive'); return finish(plan); }
  if (onNetworkPath(plan.archiveRoot)) { plan.refusals.push('the archive root is a network path'); return finish(plan); }
  const triage = readMustLand(o.triageFile, files);
  const farm = readFarm(o.farmDir, files);
  const registry = wt.readRegistry(cfg.runtimeDir, files);
  const line = wt.lineFacts(git, main, lineRef);
  const listed = wt.listWorktrees(git, main);
  if (!listed.length) { plan.refusals.push('the worktree list could not be read'); return finish(plan); }
  const cwd = o.cwd || process.cwd();
  let table = null;
  const held = dir => { if (!table) table = (o.processTable || processTable)(); return table.ok ? table.rows.some(r => r.pid !== process.pid && mentionsDir(r.text, dir)) : 'unknown'; };
  const day = new Date(o.now ? o.now() : Date.now()).toISOString().slice(0, 10).replace(/-/g, '');
  plan.archiveDir = path.join(plan.archiveRoot, `landed-${day}`);
  const cap = o.tarCapBytes || TAR_CAP_BYTES;
  for (const w of listed) {
    const keep = why => plan.kept.push({ path: w.path, why });
    if (wt.samePath(w.path, main)) continue;
    if (w.prunable || !w.head || !SHA40.test(w.head)) { keep('not a usable registered worktree'); continue; }
    if (wt.within(cwd, w.path)) { keep('the current directory is inside it'); continue; }
    if (cfg.cleanup.ownerSessionPattern.test(w.path)) { keep('owner session'); continue; }
    if (listed.some(x => !wt.samePath(x.path, w.path) && wt.within(x.path, w.path))) { keep('a registered worktree is nested inside it'); continue; }
    if (wt.within(wt.physical(plan.archiveDir), wt.physical(w.path))) { keep('the archive directory lies inside it'); continue; }
    if (!post.withinFamily(w.path, cfg) && !(o.treeRoots || []).some(r => wt.within(wt.physical(w.path), wt.physical(r)))) { keep('outside the directory of the main checkout, the work root and the tree roots named with --tree-root'); continue; }
    const inLine = line.inLine(w.head);
    const facts = {
      landed: line.isLandedTip(w.head) || inLine,
      mustLand: triage.ok ? (Boolean(w.branch && triage.branches.has(w.branch)) && !inLine) : 'unknown',
      inWork: registry.present ? Boolean(w.branch && registry.open.has(w.branch)) : 'unknown',
      farmRef: farm.ok ? farm.refs.has(w.head) : 'unknown',
      seat: seatState(w.path, cfg, files, o.deps || {}),
      held: 'unknown',
    };
    const early = removable({ ...facts, held: false });
    if (!early.ok) { keep(early.reasons.join('; ')); continue; }
    facts.held = held(w.path);
    const verdict = removable(facts);
    if (!verdict.ok) { keep(verdict.reasons.join('; ')); continue; }
    const scan = post.scanTree(w.path, files);
    if (scan.unknown) { keep(`the tree could not be read completely (${scan.unknown})`); continue; }
    if (scan.nested) { keep(`a repository of its own is nested inside it (${scan.nested})`); continue; }
    const changed = changedSet(raw, w.path, post.IGNORED_OK, files);
    if (changed.problem) { keep(changed.problem); continue; }
    let archiveBytes = 0; let unreadable = null;
    for (const f of changed.files) { try { archiveBytes += files.lstatSync(path.join(w.path, f.path)).size; } catch { unreadable = f.path; break; } }
    if (unreadable) { keep(`a file to archive cannot be read (${unreadable})`); continue; }
    if (archiveBytes > cap) { keep(`the files that are not in git weigh ${archiveBytes} bytes, over the archive cap of ${cap}`); continue; }
    plan.trees.push({
      path: path.resolve(w.path), branch: w.branch || null, head: w.head, class: facts.seat === 'ended' ? 'seat-ended' : 'landed',
      proof: line.isLandedTip(w.head) ? 'landed-tip trailer' : 'ancestor of the line', bundle: !inLine,
      archive: { files: changed.files.length, bytes: archiveBytes, deleted: changed.deleted.length, kinds: changed.files.reduce((a, f) => ({ ...a, [f.kind]: (a[f.kind] || 0) + 1 }), {}) },
      state: sha(stable({ head: w.head, files: changed.files, deleted: changed.deleted })), bytes: scan.bytes,
    });
  }
  plan.trees.sort((a, b) => (a.path < b.path ? -1 : 1));
  // A branch goes only with its tree gone, landed, older than the retention of the line and not checked out by any tree that stays.
  const removedBranches = new Set(plan.trees.map(t => t.branch).filter(Boolean));
  const stays = new Set(listed.filter(w => w.branch && !plan.trees.some(t => wt.samePath(t.path, w.path))).map(w => w.branch));
  for (const b of removedBranches) {
    const tip = git(['rev-parse', '--verify', '--quiet', `refs/heads/${b}`], main);
    if (!tip || stays.has(b) || registry.open.has(b) || (triage.ok && triage.branches.has(b) && !line.inLine(tip)) || !triage.ok) continue;
    if (cfg.cleanup.protectedBranches.includes(b)) continue;
    if (wt.branchKeepReason(b, tip, registry, line, git, main, o.now ? o.now() : Date.now())) continue;
    plan.branches.push({ name: b, tip, inLine: line.inLine(tip) });
  }
  plan.branches.sort((a, b) => (a.name < b.name ? -1 : 1));
  return finish(plan, { triage, farm });
}
function finish(plan, extra = {}) {
  if (extra.triage && !extra.triage.ok) plan.notes = [...(plan.notes || []), extra.triage.reason];
  if (extra.farm && !extra.farm.ok) plan.notes = [...(plan.notes || []), extra.farm.reason];
  const { kept, notes, archiveDir, ...hashed } = plan;
  plan.hash = sha(stable(hashed));
  return plan;
}

// ---- the archive ----
function archiveTree(t, plan, o) {
  const files = o.fs || fs;
  const { strict, raw } = o.runner;
  const main = path.resolve(o.cfg.main);
  const post = require('./post-landing.cjs');
  const slug = `${path.basename(t.path)}-${t.head.slice(0, 12)}`;
  const out = { bundle: null, tar: null, manifest: null, files: 0 };
  if (t.bundle) {
    const file = path.join(plan.archiveDir, 'bundles', `${t.head.slice(0, 12)}.bundle`);
    files.mkdirSync(path.dirname(file), { recursive: true });
    if (!files.existsSync(file)) strict(['bundle', 'create', file, 'HEAD', `^${plan.line}`], t.path);
    strict(['bundle', 'verify', file], main);
    if (!strict(['bundle', 'list-heads', file], main).split('\n').some(l => l.startsWith(`${t.head} `))) throw new Error('the bundle does not hold the tip');
    out.bundle = file;
  }
  const changed = changedSet(raw, t.path, post.IGNORED_OK, files);
  if (changed.problem) throw new Error(changed.problem);
  if (sha(stable({ head: t.head, files: changed.files, deleted: changed.deleted })) !== t.state) throw new Error('the tree changed since the plan');
  if (changed.files.length || changed.deleted.length) {
    const dir = path.join(plan.archiveDir, 'trees');
    const tar = path.join(dir, `${slug}.tar`); const manifestFile = path.join(dir, `${slug}.manifest.json`);
    if (onSystemDrive(tar)) throw new Error('the archive would be written on the system drive');
    files.mkdirSync(dir, { recursive: true });
    const written = writeTar(tar, changed.files.map(f => ({ name: f.path, abs: path.join(t.path, f.path) })), files);
    const back = readTar(tar, files);
    const same = back.files.length === written.files.length && back.files.every((b, i) => b.name === written.files[i].name && b.size === written.files[i].size && b.sha256 === written.files[i].sha256);
    if (!same) throw new Error('the tar read back does not match what was written');
    if (written.files.some((w, i) => w.sha256 !== changed.files[i].sha256)) throw new Error('the tree changed while it was archived');
    const kinds = new Map(changed.files.map(f => [f.path, f.kind]));
    const manifest = { schema: 'tree-archive/1', tree: t.path, head: t.head, files: written.files.map(f => ({ ...f, kind: kinds.get(f.name) })), deleted: changed.deleted };
    files.writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`, { flag: 'wx' });
    out.tar = tar; out.manifest = manifest; out.manifestFile = manifestFile; out.files = written.files.length;
  } else out.manifest = { schema: 'tree-archive/1', tree: t.path, head: t.head, files: [], deleted: [] };
  return out;
}

// What is not in git at `dir` must be exactly what the manifest holds, byte for byte.
function matchesManifest(dir, manifest, o) {
  const files = o.fs || fs;
  const post = require('./post-landing.cjs');
  const changed = changedSet(o.runner.raw, dir, post.IGNORED_OK, files);
  if (changed.problem) return changed.problem;
  const want = new Map(manifest.files.map(f => [f.name, f]));
  if (changed.files.length !== want.size || stable(changed.deleted) !== stable(manifest.deleted)) return 'the tree holds files the archive does not';
  for (const f of changed.files) {
    const m = want.get(f.path);
    if (!m) return `a file is not in the archive (${f.path})`;
    if (f.sha256 !== m.sha256) return `a file changed after it was archived (${f.path})`;
  }
  return null;
}

function applyPlan(plan, o) {
  const files = o.fs || fs;
  const cfg = o.cfg;
  const main = path.resolve(cfg.main);
  const { strict, git } = o.runner;
  const say = o.say || (() => {});
  const log = [];
  const archived = [];
  for (const t of plan.trees) {
    try { archived.push({ t, a: archiveTree(t, plan, o) }); } catch (e) { say(`POST-LANDING SWEEP ARCHIVE FAILED ${t.path}: ${e.message}; nothing was removed`); return { code: 5, removed: [], log }; }
  }
  say(`POST-LANDING SWEEP archived ${archived.length} trees into ${plan.archiveDir}`);
  // The facts are read once more after the archive: anything that changed while it was written (a seat, a queue entry, a file) changes the hash.
  const again = buildPlan(o);
  if (again.refusals.length || again.hash !== plan.hash) { say(`POST-LANDING SWEEP REFUSED the plan changed while it was archived (now ${again.hash}); nothing was removed`); return { code: 3, removed: [], log }; }
  const removed = [];
  const keptNow = [];
  const logFile = path.join(plan.archiveDir, 'post-landing-log.jsonl');
  for (const { t, a } of archived) {
    // The tree is set aside, and what is not in git is read once more where no writer reaches it.
    let aside = null;
    for (let i = 0; i < 100 && !aside; i++) { const q = `${t.path}.sweep-${process.pid}-${Date.now().toString(36)}${i}`; if (!files.existsSync(q)) aside = q; }
    if (!aside) { keptNow.push({ path: t.path, why: 'no free set-aside name' }); continue; }
    try { strict(['worktree', 'move', t.path, aside], main); } catch (e) { keptNow.push({ path: t.path, why: `it could not be set aside (something may hold it open): ${e.message}` }); say(`POST-LANDING SWEEP KEPT ${t.path}: could not be set aside`); continue; }
    const putBack = why => { try { strict(['worktree', 'move', aside, t.path], main); keptNow.push({ path: t.path, why }); say(`POST-LANDING SWEEP KEPT ${t.path}: ${why}`); } catch (e) { say(`POST-LANDING SWEEP QUARANTINE-STUCK ${aside}: restore it by hand to ${t.path}`); throw Object.assign(new Error('quarantine stuck'), { stuck: aside }); } };
    const doubt = matchesManifest(aside, a.manifest, o);
    if (doubt) { putBack(doubt); continue; }
    try { strict(['worktree', 'remove', '--force', aside], main); } catch (e) { putBack(`removal failed: ${e.message}`); continue; }
    removed.push(t.path);
    const row = { tree: t.path, branch: t.branch, head: t.head, reason: `${t.class}: ${t.proof}`, archivedFiles: a.files, bundle: a.bundle, tar: a.tar, bytesFreed: t.bytes, at: new Date(o.now ? o.now() : Date.now()).toISOString() };
    files.appendFileSync(logFile, `${JSON.stringify(row)}\n`);
    log.push(row);
    say(`POST-LANDING SWEEP REMOVED ${t.path} (${t.class}, ${a.files} archived files${a.bundle ? ', bundle' : ''})`);
  }
  git(['worktree', 'prune'], main);
  // Branches: one verified bundle of every tip first, then the branches whose tree went and whose tip is unchanged.
  const gone = plan.branches.filter(b => plan.trees.some(t => t.branch === b.name && removed.includes(t.path)));
  if (gone.length) {
    const bundle = path.join(plan.archiveDir, 'bundles', 'branches.bundle');
    try {
      files.mkdirSync(path.dirname(bundle), { recursive: true });
      strict(['bundle', 'create', bundle, ...gone.map(b => `refs/heads/${b.name}`)], main);
      strict(['bundle', 'verify', bundle], main);
      const heads = strict(['bundle', 'list-heads', bundle], main);
      for (const b of gone) if (!heads.split('\n').some(l => l === `${b.tip} refs/heads/${b.name}`)) throw new Error(`the bundle does not hold ${b.name}`);
      for (const b of gone) {
        if (git(['rev-parse', '--verify', `refs/heads/${b.name}`], main) !== b.tip) { say(`POST-LANDING SWEEP KEPT branch ${b.name}: moved since the plan`); continue; }
        if (git(['branch', '-D', b.name], main) !== null) { files.appendFileSync(logFile, `${JSON.stringify({ branch: b.name, tip: b.tip, bundle, at: new Date(o.now ? o.now() : Date.now()).toISOString() })}\n`); say(`POST-LANDING SWEEP DELETED branch ${b.name}`); }
      }
    } catch (e) { say(`POST-LANDING SWEEP BRANCHES KEPT: ${e.message}`); }
  }
  say(`POST-LANDING SWEEP removed ${removed.length} of ${plan.trees.length}, kept ${keptNow.length}; log ${logFile}`);
  return { code: keptNow.length ? 4 : 0, removed, kept: keptNow, log };
}

function printPlan(plan, say) {
  for (const k of plan.kept) say(`POST-LANDING SWEEP KEEP ${k.path}: ${k.why}`);
  for (const n of plan.notes || []) say(`POST-LANDING SWEEP UNKNOWN ${n}`);
  for (const t of plan.trees) say(`POST-LANDING SWEEP REMOVE ${t.class} ${t.path} ${t.branch || ''} head ${t.head.slice(0, 8)} proof: ${t.proof}; archive ${t.archive.files} files ${t.archive.bytes} bytes${t.bundle ? ' and a bundle' : ''}`);
  for (const b of plan.branches) say(`POST-LANDING SWEEP DELETE-BRANCH ${b.name} ${b.tip.slice(0, 8)}`);
  say(`POST-LANDING SWEEP PLAN trees ${plan.trees.length}, branches ${plan.branches.length}, kept ${plan.kept.length} hash ${plan.hash}`);
}

// The plan line a train prints after its push: never throws, never changes anything.
function dryLine({ repo, env = process.env, spawn, cfg: cfgIn } = {}) {
  try {
    const cfg = cfgIn || load({ root: path.resolve(repo || process.cwd()), env });
    const plan = buildPlan(settings({ cfg, runner: runnerOf(spawn) }));
    return `POST-LANDING SWEEP (dry) trees ${plan.trees.length}, branches ${plan.branches.length}, kept ${plan.kept.length}${plan.refusals.length ? `, refused: ${plan.refusals[0]}` : ''}${plan.notes && plan.notes.length ? `, unknown: ${plan.notes[0]}` : ''}, hash ${plan.hash}`;
  } catch (e) { return `POST-LANDING SWEEP (dry) unavailable: ${String((e && e.message) || e).slice(0, 120)}`; }
}

function settings(o) {
  const cfg = o.cfg;
  return { ...o, farmDir: o.farmDir || path.join(cfg.workRoot, 'farm'), triageFile: o.triageFile || path.join(path.resolve(cfg.main), 'docs', 'research', '2026-11-11-package-inventory', 'triage.json') };
}

function parse(argv) {
  const args = argv.slice();
  const flag = name => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  const value = name => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; if (!v || v.startsWith('--')) throw new Error(`missing value for ${name}`); args.splice(i, 2); return v; };
  const treeRoots = [];
  for (let v = value('--tree-root'); v !== undefined; v = value('--tree-root')) treeRoots.push(path.resolve(v));
  const o = { treeRoots, apply: flag('--apply'), json: flag('--json'), repo: value('--repo'), line: value('--line'), archive: value('--archive'), farm: value('--farm'), triage: value('--triage'), planHash: value('--plan-hash'), decision: value('--decision') };
  if (args.length) throw new Error(`unexpected argument ${args[0]}`);
  return o;
}

function main(argv, deps = {}) {
  const out = deps.say || (line => process.stdout.write(`${line}\n`));
  let o;
  try { o = parse(argv); } catch (e) { process.stderr.write(`post-landing-sweep: ${e.message}\nusage: post-landing-sweep.cjs [--repo DIR] [--line REF] [--archive DIR] [--farm DIR] [--triage FILE] [--tree-root DIR]... [--json] [--apply --plan-hash HASH --decision ID]\n`); return 2; }
  const files = deps.fs || fs;
  const repo = path.resolve(o.repo || deps.cwd || process.cwd());
  let cfg;
  try { cfg = deps.cfg || load({ root: repo, env: deps.env || process.env }); } catch (e) { process.stderr.write(`post-landing-sweep: ${e.message}\n`); return 2; }
  const runner = deps.runner || runnerOf(deps.spawn);
  let lineRef;
  if (o.line) {
    const full = runner.git(['rev-parse', '--symbolic-full-name', '--verify', '--quiet', o.line], path.resolve(cfg.main));
    if (!full || !full.startsWith('refs/')) { process.stderr.write(`post-landing-sweep: --line must name a branch, got ${JSON.stringify(o.line.slice(0, 80))}\n`); return 2; }
    lineRef = full;
  }
  if (o.apply) {
    if (!o.planHash || !/^[0-9a-f]{64}$/.test(o.planHash)) { process.stderr.write('post-landing-sweep: --apply needs --plan-hash of the plan that was printed\n'); return 3; }
    let text = '';
    try { text = files.readFileSync(path.join(repo, '.ai', 'DECISIONS.md')); } catch { /* refused below */ }
    const why = require('./post-landing.cjs').decisionApproves(text, o.decision, DECISION_MARK);
    if (why) { process.stderr.write(`post-landing-sweep: --apply refused: ${why}\n`); return 3; }
  }
  const settled = settings({ cfg, runner, fs: files, lineRef, archiveRoot: o.archive, farmDir: o.farm ? path.resolve(o.farm) : undefined, triageFile: o.triage ? path.resolve(o.triage) : undefined, cwd: deps.cwd, now: deps.now, deps: deps.deps, processTable: deps.processTable, tarCapBytes: deps.tarCapBytes, treeRoots: o.treeRoots });
  const plan = buildPlan(settled);
  if (plan.refusals.length) { for (const r of plan.refusals) out(`POST-LANDING SWEEP REFUSED ${r}`); return 3; }
  if (o.json) out(JSON.stringify(plan)); else printPlan(plan, out);
  if (!o.apply) { out(`POST-LANDING SWEEP plan only; nothing was changed; apply with --apply --plan-hash ${plan.hash} --decision ID`); return 0; }
  if (plan.hash !== o.planHash) { out(`POST-LANDING SWEEP REFUSED the plan changed since it was printed (now ${plan.hash}); nothing was changed`); return 3; }
  return applyPlan(plan, { ...settled, say: out }).code;
}

module.exports = { SCHEMA, DECISION_MARK, TAR_CAP_BYTES, removable, readMustLand, readFarm, processTable, mentionsDir, seatState, changedSet, indexReason, writeTar, readTar, buildPlan, archiveTree, matchesManifest, applyPlan, printPlan, dryLine, settings, runnerOf, parse, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

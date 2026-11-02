'use strict';
// temp-retention: the safety net of the temp-hygiene layers (layer 3). Class B tool.
// Tests clean up after themselves and the launch wrapper removes each run's temp tree; this tool is only for what still slipped through
// (a crashed run, a kept failed fixture, an old producer). It removes nothing without a plan the owner (or operator) has seen:
//   node docs/ops/temp-retention.cjs plan  [--root DIR]... [--age-hours N] [--patterns FILE] [--out FILE] [--now ISO]
//        lists directories DIRECTLY under the temp roots that are either a KEPT PER-LAUNCH DIRECTORY found by its MARKER FILE (the launch
//        marker of schema launch-tmp/1 that the one marker module docs/ops/lib/launch-marker.cjs writes through work-root.cjs into every
//        per-launch directory, whatever the leaf is called and on every root) or whose NAME matches an allow-list pattern of
//        docs/ops/temp-retention.patterns.json, and whose newest entry is older than the age cut (default 24 h); writes the plan JSON
//        (with a sha256 plan hash) and prints it. A marker file that is present but REFUSED by the strict reader is FINAL (rule R1):
//        the directory is KEPT, never planned, and no name pattern is ever consulted for it.
//        `plan` never deletes anything.
//   node docs/ops/temp-retention.cjs apply --plan FILE --plan-hash HASH [--archive-count N] [--execute] [--patterns FILE] [--now ISO]
//        re-checks every entry (hash, still a plain directory directly under an allowed root, still matches, still older, unchanged since
//        the plan, no live process has its working directory inside) and removes it. DRY-RUN BY DEFAULT: without --execute it prints what
//        it would remove. --execute requires the ARCHIVE COUNT CHECK: --archive-count N is the number of directories the operator saw in
//        the plan (the PLAN line prints dirs=N), and apply refuses (exit 2, nothing removed) when the plan's entry count or its own totals
//        disagree with N or with the entries. With --execute it also writes the removal log (one JSON line per directory) next to the plan:
//        <plan>.removal.jsonl, and prints the archive row count of that run.
//   node docs/ops/temp-retention.cjs report [--root DIR]... [--allow FILE] [--boundary-root DIR] [--baseline FILE] [--out FILE] [--now ISO]
//        the WEEKLY drive-root report (P-149): lists the top-level entries of the work drive root, marks each one as allowed or not by
//        the allow file of the launch wrapper (write-boundary.allow.json) and as matching or not a retention pattern, and prints
//        the totals. Read-only: it removes nothing and writes no file without --out (the JSON report). --baseline FILE compares the
//        listing with the entries of an earlier report and shows what appeared and what is gone.
// Roots: the OS temp dir (os.tmpdir()), the launch wrapper's root, resolved by the SAME function (docs/ops/lib/tmp-root.cjs): COLABS_TMP_ROOT when set,
// else <drive of the repository>:/ColabsTmp (the sibling directory of the repository; --repo DIR picks another repository, default is the checkout of this tool),
// and the resolved work root of the launchers (docs/ops/lib/work-root.cjs: PROTOCOL_WORK_ROOT, else the protocol-manifest.json "workRoot" key), so
// every directory a launcher may keep is reachable. A --root that is none of these is refused (exit 2). Entries not matched by any
// pattern or marker are never touched and never scanned: they are only counted as `foreign` (with a name sample) so the owner can see other
// tools' dirs; a kept per-launch directory is found ONLY by its marker file, never by a name pattern, so a bare leaf is found on every root
// and a directory without the marker is never touched by that rule.
// Links (symlinks, junctions) are never followed: a link directly under a root is `skipped-link`, a link inside a tree is not entered.
// Exit: 0 ok, 1 apply could not remove or refused an entry, 2 usage error or a refused root/plan.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { removeTree } = require('./lib/test-tmp.cjs');
const { configuredTmpRoot } = require('./lib/tmp-root.cjs');
const { resolveWorkRoot } = require('./lib/work-root.cjs');
const { markerState, LAUNCH_TMP_MARKER } = require('./lib/launch-marker.cjs');
const writeBoundary = require('./lib/write-boundary.cjs');

const PATTERNS_FILE = path.join(__dirname, 'temp-retention.patterns.json');
const PLAN_SCHEMA = 'temp-retention-plan/1';
const DEFAULT_AGE_HOURS = 24;
const FOREIGN_SAMPLE = 25;
const HOUR = 3600 * 1000;
const DEFAULT_REPO = path.resolve(__dirname, '..', '..'); // the checkout this tool lives in; its drive decides the default root, like the wrapper's --repo

const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');
const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
function real(p) { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } }

function parse(argv) {
  const o = { roots: [] };
  const valued = new Set(['--root', '--repo', '--age-hours', '--patterns', '--out', '--now', '--plan', '--plan-hash', '--archive-count', '--allow', '--boundary-root', '--baseline']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--execute') o.execute = true;
    else if (valued.has(a)) { const v = argv[++i]; if (a === '--root') o.roots.push(v); else o[a.slice(2)] = v; }
    else if (a.startsWith('--')) return { error: `unknown option ${a}` };
    else (o._ = o._ || []).push(a);
  }
  return o;
}

// ---- roots ----
// The wrapper's root counts as kind 'colabs-tmp-root' whether it came from COLABS_TMP_ROOT or from the drive default (the marker pattern is the same).
function allowedRoots(env = process.env, repo = DEFAULT_REPO) {
  const list = [{ kind: 'os-temp', dir: path.resolve(os.tmpdir()) }];
  const configured = configuredTmpRoot(repo, env);
  if (configured) list.push({ kind: 'colabs-tmp-root', dir: path.resolve(configured.dir) });
  // DRIVE-C-ISOLATION: a launcher may keep a per-launch directory under the work root it was given (PROTOCOL_WORK_ROOT, or
  // the protocol-manifest.json "workRoot" key) even when that is neither the OS temp dir nor COLABS_TMP_ROOT; retention must reach every directory
  // the launcher keeps, so the resolved work root is allowed on its own (kind 'work-root'). A manifest that is present but not strictly readable
  // is a named refusal here too (the shared strict reader, docs/ops/lib/work-root.cjs G4), never a silent skip of that root.
  const resolved = resolveWorkRoot(repo, env);
  if (resolved.problem) throw new Error(`the "workRoot" of protocol-manifest.json is not strictly readable: ${resolved.problem.code} (${resolved.problem.detail}); fix the manifest or point PROTOCOL_WORK_ROOT elsewhere`);
  const workDir = resolved.dir ? path.resolve(resolved.dir) : null;
  if (workDir && !list.some(a => same(real(a.dir), real(workDir)))) list.push({ kind: 'work-root', dir: workDir });
  return list;
}
function resolveRoots(requested, env = process.env, repo = DEFAULT_REPO) {
  const allowed = allowedRoots(env, repo);
  const want = requested.length ? requested.map(r => path.resolve(r)) : allowed.map(a => a.dir);
  const out = [];
  for (const w of want) {
    const hit = allowed.find(a => same(real(a.dir), real(w)));
    if (!hit) throw new Error(`refusing root ${w}: it is neither the OS temp dir (${allowed[0].dir}) nor the launch wrapper's temp root${allowed.length > 1 ? ` (${allowed[1].dir})` : ' (COLABS_TMP_ROOT is not set and the repository has no drive letter)'}`);
    if (path.dirname(real(w)) === real(w)) throw new Error(`refusing root ${w}: a filesystem root`);
    if (!out.some(x => same(x.dir, hit.dir)) && fs.existsSync(hit.dir)) out.push(hit);
  }
  return out;
}

// ---- patterns ----
function loadPatterns(file) {
  const j = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (j.schema !== 'temp-retention-patterns/1' || !Array.isArray(j.patterns) || !j.patterns.length) throw new Error(`${file}: not a temp-retention-patterns/1 file`);
  const patterns = j.patterns.map((p, i) => {
    if (!p.pattern || typeof p.pattern !== 'string' || !p.reason || typeof p.reason !== 'string') throw new Error(`${file}: pattern #${i + 1} needs a pattern and a reason`);
    if (/[\\/]/.test(p.pattern) || p.pattern === '*' && !p.requiresMarker) throw new Error(`${file}: pattern ${JSON.stringify(p.pattern)} is too broad or has a separator`);
    const re = new RegExp(`^${p.pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`, process.platform === 'win32' ? 'i' : '');
    return { pattern: p.pattern, reason: p.reason, requiresMarker: p.requiresMarker || null, onlyRoot: p.onlyRoot || null, re };
  });
  return { patterns, sha256: sha256(fs.readFileSync(file, 'utf8')) };
}
// A kept per-launch directory (DRIVE-C-ISOLATION, G3) is found by its MARKER FILE, never by a name pattern: whatever the leaf is called - a bare
// name under a work root that is the OS temp dir is found too - the launch marker of schema launch-tmp/1 directly inside the directory says
// "a per-launch temp dir of ours". The marker belongs to the ONE marker module docs/ops/lib/launch-marker.cjs: it is written
// by that module's strict writer (called from work-root.cjs, which records the role "work-root-launch-dir" and the creation time) and READ
// only through that module's shared strict reader with the fixed schema (the whole file decoded by the shared text-safe decode - a BOM, CR, NUL
// and the invisible classes refused - parsed by parseJsonUnique, exactly the six fields the writer writes, each with its fixed type, value and
// closed identity grammar); this tool holds no marker parsing of its own.
// Rule: a marker that is PRESENT and REFUSED is final. The directory is KEPT and never reaches the deletion plan,
// and NO name pattern is ever consulted for a directory that carries a marker file - present, valid or refused, however well its leaf matches
// an allow-list pattern and however far in the future its keepUntil says. Only a directory with NO marker file at all may be judged by the name
// allow-list, and then only by the patterns that do not require a marker. judgeEntry below is that one judgment, used by the plan AND by the
// re-check before removal; a refused marker never yields a keep deadline either - unknown never becomes permission to delete what it cannot name.
const MARKER_MATCH = { pattern: ':marker', reason: 'per-launch temp dir of a launcher, found by its marker file (docs/ops/lib/launch-marker.cjs), not by its name', requiresMarker: LAUNCH_TMP_MARKER };
function judgeEntry(dir, name, rootKind, patterns) {
  const marker = markerState(dir);
  if (marker.present && !marker.ok) return { hit: null, marker, kept: `its marker file is present but refused (${marker.problem.code})` };
  if (marker.present) return { hit: MARKER_MATCH, marker };
  const noMarkerPatterns = patterns.filter(p => !p.requiresMarker);
  return { hit: matchPattern(noMarkerPatterns, name, rootKind, dir), marker };
}
// The plain predicate the retire tool uses: a match only for a marker of the fixed schema, never for a refused one.
function launchMarkerMatch(dir) {
  const marker = markerState(dir);
  return marker.present && marker.ok ? MARKER_MATCH : null;
}
function matchPattern(patterns, name, rootKind, dir) {
  for (const p of patterns) {
    if (!p.re.test(name)) continue;
    if (p.onlyRoot && p.onlyRoot !== rootKind) continue;
    if (p.requiresMarker && !isPlainFile(path.join(dir, p.requiresMarker))) continue;
    return p;
  }
  return null;
}
function isPlainFile(p) { try { return fs.lstatSync(p).isFile(); } catch { return false; } }

// ---- scan: lstat only, never into a link ----
function scan(dir) {
  let bytes = 0; let files = 0; let newest = 0;
  const stack = [dir];
  while (stack.length) {
    const d = stack.pop();
    let st;
    try { st = fs.lstatSync(d); } catch { continue; }
    newest = Math.max(newest, st.mtimeMs);
    let names;
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) {
      const p = path.join(d, n);
      let s;
      try { s = fs.lstatSync(p); } catch { continue; }
      if (s.isSymbolicLink()) continue; // a link says nothing about our tree: not entered, not counted
      if (s.isDirectory()) { stack.push(p); continue; }
      files++; bytes += s.size; newest = Math.max(newest, s.mtimeMs);
    }
  }
  return { bytes, files, newestMs: newest };
}

// The keep deadline of a marked directory, from the SAME judgment that matched it: a marker of the fixed schema carries keepUntil null or a
// valid ISO time, so an unreadable or corrupt marker never yields a deadline - and never becomes permission to delete what it cannot name.
function markerKeepUntil(judged) {
  const marker = judged.marker;
  if (!marker.present || !marker.ok || marker.fields.keepUntil === null) return 0;
  const until = Date.parse(marker.fields.keepUntil);
  return Number.isFinite(until) ? until : 0;
}

// ---- plan ----
function makePlan({ roots, patterns: loaded, ageHours, now }) {
  const patterns = loaded.patterns;
  const cut = now - ageHours * HOUR;
  const entries = []; const recent = []; const links = [];
  const foreign = { count: 0, sample: [] };
  const markerRefused = { count: 0, sample: [] };
  for (const root of roots) {
    let names;
    try { names = fs.readdirSync(root.dir); } catch { continue; }
    for (const name of names.sort()) {
      const p = path.join(root.dir, name);
      let st;
      try { st = fs.lstatSync(p); } catch { continue; }
      if (!st.isDirectory() && !st.isSymbolicLink()) { foreign.count++; if (foreign.sample.length < FOREIGN_SAMPLE) foreign.sample.push(name); continue; }
      if (st.isSymbolicLink()) { const hit = matchByNameOnly(patterns, name, root.kind); if (hit) links.push({ root: root.dir, name, pattern: hit.pattern }); else { foreign.count++; if (foreign.sample.length < FOREIGN_SAMPLE) foreign.sample.push(name); } continue; }
      // R1: the one tri-state judgment - a present, refused marker KEEPS the directory before any name pattern is consulted
      const judged = judgeEntry(p, name, root.kind, patterns);
      if (judged.marker.present && !judged.marker.ok) {
        markerRefused.count++;
        if (markerRefused.sample.length < FOREIGN_SAMPLE) markerRefused.sample.push({ name, code: judged.marker.problem.code });
        continue;
      }
      if (!judged.hit) { foreign.count++; if (foreign.sample.length < FOREIGN_SAMPLE) foreign.sample.push(name); continue; }
      const s = scan(p);
      const keepUntil = markerKeepUntil(judged);
      if (s.newestMs >= cut || keepUntil > now) { recent.push({ root: root.dir, name, ageHours: round1((now - s.newestMs) / HOUR) }); continue; }
      entries.push({ root: root.dir, rootKind: root.kind, name, pattern: judged.hit.pattern, reason: judged.hit.reason, bytes: s.bytes, files: s.files, newest: new Date(s.newestMs).toISOString(), ageHours: round1((now - s.newestMs) / HOUR) });
    }
  }
  const body = {
    schema: PLAN_SCHEMA, createdAt: new Date(now).toISOString(), ageHours, patternsSha256: loaded.sha256,
    roots: roots.map(r => ({ kind: r.kind, dir: r.dir })), entries,
    skippedTooRecent: recent.length, skippedLinks: links, foreign,
    keptMarkerRefused: markerRefused,
    totals: { dirs: entries.length, files: entries.reduce((a, e) => a + e.files, 0), bytes: entries.reduce((a, e) => a + e.bytes, 0) }
  };
  return { ...body, planHash: hashOf(body) };
}
function matchByNameOnly(patterns, name, rootKind) { return patterns.find(p => p.re.test(name) && !p.requiresMarker && (!p.onlyRoot || p.onlyRoot === rootKind)) || null; }
const round1 = n => Math.round(n * 10) / 10;
function hashOf(body) { const { planHash, ...rest } = body; return sha256(JSON.stringify(rest)); }

// ---- live-process check: is a process working inside the directory? ----
// Linux: /proc/<pid>/cwd and the arguments in /proc/<pid>/cmdline. Windows: the executable path and the command line of a process (the working directory of
// another process is not readable there without a native helper or a handle tool, which this tool does not ship). Windows refuses to remove a directory that is
// some process's cwd (EBUSY/EPERM), so a miss costs a FAILED entry, never a killed process.
// mentionsDir(text, dir): true when `text` names `dir` or a path inside it at an ARGUMENT BOUNDARY: the character before is not part of a name (start of the text, a space,
// a quote, `=`, `,` ...) and the character after is the end of the text, a separator (a path inside), or anything that is not part of a name. So `node x.js <dir>` (bare
// directory as the last argument), `"<dir>"` and `--root=<dir>/sub` match, while `<dir>-old` and `<dir>2` (another directory with the same prefix) do not.
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
function liveProcessInside(dir) {
  const needle = path.resolve(dir);
  try {
    if (process.platform === 'linux') {
      for (const pid of fs.readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
        if (Number(pid) === process.pid) continue;
        try { if (mentionsDir(fs.readlinkSync(`/proc/${pid}/cwd`), needle)) return Number(pid); } catch { /* not ours or gone */ }
        try { if (mentionsDir(fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' '), needle)) return Number(pid); } catch { /* not ours or gone */ }
      }
      return null;
    }
    if (process.platform === 'win32') {
      const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_Process | ForEach-Object { "$($_.ProcessId)`t$($_.ExecutablePath)`t$($_.CommandLine)" }'], { encoding: 'utf8', windowsHide: true, timeout: 60000 });
      for (const line of (r.stdout || '').split(/\r?\n/)) {
        const [pid, exe, ...cmd] = line.split('\t');
        if (Number(pid) && Number(pid) !== process.pid && (mentionsDir(exe, needle) || mentionsDir(cmd.join(' '), needle))) return Number(pid);
      }
    }
  } catch { /* an unreadable process table is not proof of a live process */ }
  return null;
}

// ---- apply ----
function checkEntry(e, ctx) {
  const dir = path.join(e.root, e.name);
  const root = ctx.roots.find(r => same(real(r.dir), real(e.root)));
  if (!root) return 'root is not an allowed temp root';
  if (e.name !== path.basename(e.name) || e.name === '.' || e.name === '..') return 'name is not a single path segment';
  let st;
  try { st = fs.lstatSync(dir); } catch { return 'gone'; }
  if (st.isSymbolicLink()) return 'is a link';
  if (!st.isDirectory()) return 'not a directory';
  // R1: the SAME tri-state judgment as the plan, before removal - a present, refused marker is final and the directory is KEPT
  const judged = judgeEntry(dir, e.name, root.kind, ctx.patterns);
  if (judged.marker.present && !judged.marker.ok) return `${judged.kept}; the directory is kept`;
  if (!judged.hit || judged.hit.pattern !== e.pattern) return 'no longer matches its allow-list pattern or marker';
  const s = scan(dir);
  if (s.newestMs >= ctx.now - ctx.ageHours * HOUR) return 'newer than the age cut now';
  if (new Date(s.newestMs).toISOString() !== e.newest || s.files !== e.files || s.bytes !== e.bytes) return 'changed since the plan';
  if (markerKeepUntil(judged) > ctx.now) return 'kept until later by its marker';
  const pid = ctx.liveProcessInside(dir);
  if (pid) return `a live process (pid ${pid}) is inside`;
  return null;
}

function apply(o, deps = {}) {
  if (!o.plan || !o['plan-hash']) { process.stderr.write('apply needs --plan FILE and --plan-hash HASH\n'); return 2; }
  let plan;
  try { plan = JSON.parse(fs.readFileSync(path.resolve(o.plan), 'utf8')); } catch (e) { process.stderr.write(`cannot read the plan: ${e.message}\n`); return 2; }
  if (plan.schema !== PLAN_SCHEMA) { process.stderr.write('not a temp-retention-plan/1 file\n'); return 2; }
  const recomputed = hashOf(plan);
  if (recomputed !== plan.planHash || recomputed !== String(o['plan-hash']).toLowerCase()) { process.stderr.write(`plan hash mismatch (file says ${plan.planHash}, recomputed ${recomputed}, given ${o['plan-hash']}); nothing removed\n`); return 2; }
  // ARCHIVE COUNT CHECK (P-149): --execute deletes only when the operator states the number of directories they reviewed (the
  // PLAN line prints dirs=N) and the plan is internally consistent. An edited plan whose totals no longer agree with its own
  // entries is refused even when its hash was recomputed, and a swapped plan is refused by the count.
  const inconsistency = planInconsistency(plan);
  if (inconsistency) { process.stderr.write(`archive count check failed: ${inconsistency}; nothing removed\n`); return 2; }
  if (o['archive-count'] !== undefined) {
    const want = Number(o['archive-count']);
    if (typeof o['archive-count'] !== 'string' || !/^[0-9]+$/.test(o['archive-count']) || !Number.isSafeInteger(want)) { process.stderr.write('--archive-count needs a non-negative decimal integer; nothing removed\n'); return 2; }
    if (want !== plan.entries.length) { process.stderr.write(`archive count mismatch: the plan has ${plan.entries.length} directories, --archive-count says ${want}; nothing removed\n`); return 2; }
  } else if (o.execute) {
    process.stderr.write(`apply --execute needs --archive-count N: the number of directories the operator saw in the plan (PLAN dirs=${plan.entries.length}); nothing removed\n`);
    return 2;
  }
  let roots; let pats;
  try { roots = resolveRoots(plan.roots.map(r => r.dir), deps.env, deps.repo || o.repo || DEFAULT_REPO); pats = loadPatterns(path.resolve(o.patterns || PATTERNS_FILE)); } catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  const now = o.now ? Date.parse(o.now) : Date.now();
  const ctx = { roots, patterns: pats.patterns, now, ageHours: plan.ageHours, liveProcessInside: deps.liveProcessInside || liveProcessInside };
  const logFile = `${path.resolve(o.plan)}.removal.jsonl`;
  let removed = 0; let refused = 0; let failed = 0; let bytes = 0; let archived = 0;
  for (const e of plan.entries) {
    const why = checkEntry(e, ctx);
    if (why) { refused++; process.stdout.write(`REFUSED ${e.name}: ${why}\n`); if (o.execute) archived += appendLog(logFile, { name: e.name, root: e.root, action: 'refused', reason: why, at: new Date().toISOString() }); continue; }
    if (!o.execute) { process.stdout.write(`WOULD REMOVE ${e.name} (${e.files} files, ${mb(e.bytes)} MB, ${e.ageHours} h old, ${e.reason})\n`); removed++; bytes += e.bytes; continue; }
    try {
      removeTree(path.join(e.root, e.name));
      removed++; bytes += e.bytes;
      archived += appendLog(logFile, { name: e.name, root: e.root, action: 'removed', size: e.bytes, files: e.files, ageHours: e.ageHours, reason: e.reason, at: new Date().toISOString() });
      process.stdout.write(`REMOVED ${e.name} (${e.files} files, ${mb(e.bytes)} MB)\n`);
    } catch (err) {
      failed++;
      archived += appendLog(logFile, { name: e.name, root: e.root, action: 'failed', error: err.code || err.message, at: new Date().toISOString() });
      process.stdout.write(`FAILED ${e.name}: ${err.code || err.message}\n`);
    }
  }
  process.stdout.write(`RESULT ${o.execute ? 'executed' : 'dry-run'} ${o.execute ? 'removed' : 'would-remove'}=${removed} refused=${refused} failed=${failed} mb=${mb(bytes)}${o.execute ? ` planned=${plan.entries.length} archive=${archived} outcomes=${removed + refused + failed} log=${logFile}` : ''}\n`);
  return refused || failed ? 1 : 0;
}
// The plan's own arithmetic must match its entries: totals.dirs/files/bytes are the sums makePlan wrote. A plan somebody edited
// after review (even with a recomputed hash) is refused here before any entry is re-checked.
function planInconsistency(plan) {
  if (!Array.isArray(plan.entries)) return 'the plan has no entries array';
  const t = plan.totals;
  if (!t || typeof t !== 'object') return 'the plan has no totals';
  if (t.dirs !== plan.entries.length) return `totals.dirs=${t.dirs} but entries=${plan.entries.length}`;
  let files = 0; let bytes = 0;
  for (const e of plan.entries) {
    if (!e || !Number.isSafeInteger(e.files) || e.files < 0 || !Number.isSafeInteger(e.bytes) || e.bytes < 0) return 'an entry has no integer files/bytes';
    files += e.files; bytes += e.bytes;
  }
  if (files !== t.files) return `totals.files=${t.files} but the entries sum to ${files}`;
  if (bytes !== t.bytes) return `totals.bytes=${t.bytes} but the entries sum to ${bytes}`;
  return null;
}
const mb = n => Math.round(n / 1048576 * 10) / 10;
function appendLog(file, row) { fs.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8'); return 1; }

function plan(o, deps = {}) {
  const ageHours = o['age-hours'] === undefined ? DEFAULT_AGE_HOURS : Number(o['age-hours']);
  if (!Number.isFinite(ageHours) || ageHours <= 0) { process.stderr.write('--age-hours needs a positive number\n'); return 2; }
  let roots; let pats;
  try { roots = resolveRoots(o.roots, deps.env, deps.repo || o.repo || DEFAULT_REPO); pats = loadPatterns(path.resolve(o.patterns || PATTERNS_FILE)); } catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  const now = o.now ? Date.parse(o.now) : Date.now();
  if (!Number.isFinite(now)) { process.stderr.write('--now needs an ISO date\n'); return 2; }
  const p = makePlan({ roots, patterns: pats, ageHours, now });
  const out = path.resolve(o.out || path.join(roots[0].dir, `temp-retention-plan-${p.createdAt.replace(/[:.]/g, '-')}.json`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${JSON.stringify(p, null, 2)}\n`, 'utf8');
  for (const e of p.entries) process.stdout.write(`${e.name}\t${e.files} files\t${mb(e.bytes)} MB\t${e.ageHours} h\t${e.pattern}\n`);
  process.stdout.write(`PLAN dirs=${p.totals.dirs} files=${p.totals.files} mb=${mb(p.totals.bytes)} too-recent=${p.skippedTooRecent} links=${p.skippedLinks.length} foreign=${p.foreign.count}${p.foreign.sample.length ? ` (e.g. ${p.foreign.sample.slice(0, 5).join(', ')})` : ''} marker-refused=${p.keptMarkerRefused.count}${p.keptMarkerRefused.sample.length ? ` (e.g. ${p.keptMarkerRefused.sample.slice(0, 5).map(x => `${x.name}:${x.code}`).join(', ')})` : ''}\n`);
  process.stdout.write(`plan-file=${out}\nplan-hash=${p.planHash}\n`);
  return 0;
}

// ---- weekly report: the work drive root against the allow list (read-only) ----
// The report writes nothing unless --out is given. It is the owner-visible half of the write-boundary check: the same allow file
// decides "allowed", and every other top-level entry is listed as foreign. A name that matches a retention pattern is marked so
// the owner sees a known fixture family without a full scan. --baseline compares with an earlier report JSON.
function isoWeek(nowMs) {
  const d = new Date(Date.UTC(new Date(nowMs).getUTCFullYear(), new Date(nowMs).getUTCMonth(), new Date(nowMs).getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-W${String(Math.ceil(((d - yearStart) / 86400000 + 1) / 7)).padStart(2, '0')}`;
}
function report(o, deps = {}) {
  const repo = deps.repo || o.repo || DEFAULT_REPO;
  const env = deps.env || process.env;
  const nowMs = o.now ? Date.parse(o.now) : Date.now();
  if (!Number.isFinite(nowMs)) { process.stderr.write('--now needs an ISO date\n'); return 2; }
  let pats;
  try { pats = loadPatterns(path.resolve(o.patterns || PATTERNS_FILE)); }
  catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  let boundaryDir = null;
  if (o['boundary-root']) boundaryDir = path.resolve(o['boundary-root']);
  else if (env[writeBoundary.BOUNDARY_ENV] && String(env[writeBoundary.BOUNDARY_ENV]).trim()) boundaryDir = path.resolve(env[writeBoundary.BOUNDARY_ENV]);
  else {
    const base = o.roots && o.roots.length ? path.resolve(o.roots[0]) : path.resolve(repo);
    const volume = path.parse(base).root;
    boundaryDir = volume && writeBoundary.driveOf(volume) ? volume : null;
  }
  if (!boundaryDir) { process.stderr.write('the work drive root is not resolvable on this host: pass --boundary-root DIR\n'); return 2; }
  const allowFile = o.allow ? path.resolve(o.allow) : writeBoundary.allowFileFor(repo, env);
  const allow = writeBoundary.loadAllow(allowFile);
  const boundaryDrive = writeBoundary.driveOf(boundaryDir);
  const allowApplies = Boolean(allow.ok && boundaryDrive && boundaryDrive.toLowerCase() === allow.drive.toLowerCase());
  const snap = writeBoundary.snapshot(boundaryDir);
  if (!snap.ok) { process.stderr.write(`the boundary root is unreadable (${snap.problem.code}): ${boundaryDir}\n`); return 2; }
  const lower = n => (process.platform === 'win32' ? n.toLowerCase() : n);
  const entries = [...snap.names.values()].sort((a, b) => a.localeCompare(b)).map(name => ({
    name,
    allowed: Boolean(allowApplies && allow.names.has(lower(name))),
    pattern: (matchByNameOnly(pats.patterns, name, 'drive-root') || {}).pattern || null,
  })).map(row => ({ ...row, foreign: !row.allowed }));
  let baseline = null;
  if (o.baseline) {
    try {
      const prior = JSON.parse(fs.readFileSync(path.resolve(o.baseline), 'utf8'));
      if (!prior || !Array.isArray(prior.entries)) throw Error('no entries array');
      const before = new Set(prior.entries.map(e => lower(String(e && e.name || ''))));
      const now = new Set(entries.map(e => lower(e.name)));
      baseline = { file: path.resolve(o.baseline), added: entries.filter(e => !before.has(lower(e.name))).map(e => e.name), removed: prior.entries.map(e => String(e && e.name || '')).filter(n => n && !now.has(lower(n))) };
    } catch (e) { process.stderr.write(`--baseline is not a temp-retention-report JSON (${(e && e.code) || (e && e.message) || 'unreadable'}); the report runs without it\n`); }
  }
  const body = {
    schema: 'temp-retention-report/1', at: new Date(nowMs).toISOString(), week: isoWeek(nowMs),
    root: boundaryDir, allowFile, allow: allow.ok ? { ok: true, drive: allow.drive, names: allow.names.size, applied: allowApplies } : { ok: false, problem: allow.problem },
    entries,
    totals: { entries: entries.length, allowed: entries.filter(e => e.allowed).length, foreign: entries.filter(e => e.foreign).length, pattern: entries.filter(e => e.pattern).length },
    baseline,
  };
  if (o.out) {
    const out = path.resolve(o.out);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, `${JSON.stringify(body, null, 2)}\n`, 'utf8');
  }
  const foreign = entries.filter(e => e.foreign).map(e => e.name);
  process.stdout.write(`REPORT root=${boundaryDir} week=${body.week} entries=${body.totals.entries} allowed=${body.totals.allowed} foreign=${body.totals.foreign} pattern=${body.totals.pattern} allow=${allow.ok ? body.allow.drive : allow.problem.code}\n`);
  if (foreign.length) process.stdout.write(`FOREIGN ${foreign.slice(0, 20).join(', ')}${foreign.length > 20 ? `, ... (${foreign.length - 20} more)` : ''}\n`);
  if (baseline) process.stdout.write(`BASELINE added=${baseline.added.length}${baseline.added.length ? ` (${baseline.added.slice(0, 10).join(', ')})` : ''} removed=${baseline.removed.length}\n`);
  if (o.out) process.stdout.write(`report-file=${path.resolve(o.out)}\n`);
  return 0;
}

function main(argv, deps = {}) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write('usage: temp-retention.cjs plan|apply [options]  (plan only reads; apply removes only the entries of a saved plan with --plan FILE --plan-hash HASH --execute)\n'); return 0; }
  const cmd = argv[0];
  const o = parse(argv.slice(1));
  if (!['plan', 'apply', 'report'].includes(cmd) || o.error) { process.stderr.write(`${o.error || 'usage: temp-retention.cjs plan|apply|report [options]'}\n`); return 2; }
  if (cmd === 'report') return report(o, deps);
  return cmd === 'plan' ? plan(o, deps) : apply(o, deps);
}

module.exports = { main, makePlan, loadPatterns, matchPattern, launchMarkerMatch, judgeEntry, checkEntry, resolveRoots, scan, hashOf, liveProcessInside, mentionsDir, allowedRoots, planInconsistency, report, PATTERNS_FILE };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

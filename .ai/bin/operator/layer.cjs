'use strict';
// Operator layer of a project: what the operator must see without
// asking anyone, computed from files and processes only. No model is called, nothing leaves the machine.
//   node .ai/bin/operator/layer.cjs status   [--root DIR] [--json] [--all]   (default view: see "status filter" below)
//   node .ai/bin/operator/layer.cjs tick     [--root DIR] [--ack] [--json]
//   node .ai/bin/operator/layer.cjs silence  [--root DIR] [--dry] [--test]
//   node .ai/bin/operator/layer.cjs accept   [--root DIR] --name N [--by WHO] | --before ISO
//   node .ai/bin/operator/layer.cjs step     [--root DIR] --task T --step NAME [--class kernel|certification] -- COMMAND...
//   node .ai/bin/operator/layer.cjs overhead [--root DIR] --task T [--json]
//   node .ai/bin/operator/layer.cjs alerts   [--root DIR] [--limit N]
//   node .ai/bin/operator/layer.cjs settings [--root DIR]
// status: every launch the launch wrapper registered (RUNTIME/NAME.running.json and NAME.terminal.json): alive, stalled
// (alive, no file change in its worktree or log beyond the idle threshold, or running longer than the route p90 plus the
// margin), exited, dead (process gone without a terminal record), the last file change, the last commit and whether the
// handoff is pending (exited and not accepted with `accept`). These columns are the only source for "process alive" and
// "last change" in an operator report.
// status filter: by default the launches that are alive, stalled or dead, every exited launch whose handoff is pending
// (any age), and exited launches that ended in the last 24 hours; --all prints the full history. The counts on the RESULT
// line always cover every record.
// Bounded reads (status, tick and silence): the last change of a worktree is the newest mtime among the files git reports
// as changed (at most 2000 paths) and the head commit time, one git status per distinct worktree run in parallel and one
// batched log per repository, never a walk of the tree; a directory without .git falls back to a walk capped at 5000
// entries and depth 8. Details are computed for every alive launch and for at most 64 distinct worktrees in all (dead
// first, then pending handoffs, newest first); the RESULT line states the caps and how many rows went without details.
// Liveness is one signal-0 probe per distinct pid (or one injected process table), never a process listing per launch.
// tick: one first line NEW, WORK, NOOP or ERROR (exit 1 on ERROR, fail closed). Inputs come from the PROJECT ADAPTER
// below (backlog table, task cards or the kernel candidate registry; worktrees; launch records; review files with a
// verdict), configured by the "operatorLayer" key of protocol-manifest.json, never from paths of the kernel repository.
// silence: a local dead-man switch. When nothing moved for quietMinutes while work is pending it writes the alert file,
// appends one line to the alert log and shows a Windows toast where available. No network, no owner channel.
// Idle threshold: max(floorMinutes, p90Share of the route p90 duration) without a file change, or a runtime above the route
// p90 plus runtimeMargin, when at least minSamples finished launches of the same route exist; else defaultStallMinutes.
// Escalation on the critical path at escalationFactor times the threshold.
// Kernel overhead: `step` meters one kernel step (lock, Evidence, validator, gates) into RUNTIME/kernel-steps.jsonl;
// `overhead` divides the metered kernel time of a task by its wall time. Certification steps are counted separately.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const slots = require('../lib/seat-slots.cjs');
// The one comparison key of a model spelling (a documented alias resolved to its canonical id).
const { modelKey, PLACEHOLDER_MODEL_RE } = require('../accounting/lib/launch-cost.cjs');

const DEFAULTS = Object.freeze({
  runtime: '.ai/runtime',
  reviews: 'docs/reviews',
  worklog: '.ai/worklog',
  backlog: null,
  ownerInbox: null,
  readyStatuses: ['ready'],
  activeStatuses: ['doing', 'in-progress', 'rework', 'review', 'building', 'certifying'],
  criticalPath: [],
  maxParallel: 1,
  idle: { defaultStallMinutes: 30, floorMinutes: 15, p90Share: 0.1, runtimeMargin: 0.1, minSamples: 5, escalationFactor: 2 },
  silence: { quietMinutes: 30, repeatMinutes: 120, toast: true },
  processes: { olderThanHours: 6 },
  schedules: { enabled: true, tickMinutes: 15, silenceMinutes: 20, proxyEnabled: true, proxyMinutes: 1 },
  overhead: { targetMin: 0.05, targetMax: 0.1 },
});
const BACKLOG_KINDS = ['table', 'cards', 'registry', 'none'];
const VERDICT_RE = /\b(?:verdict|вердикт)\b[^\n]{0,60}?\b(PASS|FAIL|BLOCKED|RECOMMENDATION)\b/i;
const WALK_LIMIT = 5000;
const WALK_DEPTH = 8;
const GIT_PATH_CAP = 2000;
const DETAIL_TREES = 64;
const RECENT_EXIT_HOURS = 24;
// A launch that ended within the last hours. An end that is not a valid date is unknown, never the epoch: it is never "long ago".
const endedWithin = (endedAt, now, hours) => { const ms = Date.parse(endedAt); return !Number.isFinite(ms) || now - ms <= hours * 3600000; };
const SKIP_DIRS = new Set(['.git', 'node_modules']);

class LayerError extends Error { constructor(code, detail) { super(`${code}${detail ? `: ${detail}` : ''}`); this.code = code; } }

// ---- settings ----
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const relSafe = v => typeof v === 'string' && v.length > 0 && v.length <= 200 && !path.isAbsolute(v) && !/^[A-Za-z]:/.test(v)
  && !v.split(/[\\/]/).includes('..') && /^[\x20-\x7e]+$/.test(v);
function num(v, key, lo, hi) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) throw new LayerError('SETTINGS_INVALID', `${key} must be a number from ${lo} to ${hi}`);
  return v;
}
function strList(v, key) {
  if (!Array.isArray(v) || v.some(s => typeof s !== 'string' || !s.trim() || s.length > 64)) throw new LayerError('SETTINGS_INVALID', `${key} must be a list of short strings`);
  return v.map(s => s.trim().toLowerCase());
}
function mergeGroup(base, given, key, ranges) {
  if (given === undefined) return { ...base };
  if (!isObj(given)) throw new LayerError('SETTINGS_INVALID', `${key} must be an object`);
  const out = { ...base };
  for (const [k, v] of Object.entries(given)) {
    if (!(k in base)) throw new LayerError('SETTINGS_INVALID', `${key}.${k} is not a known setting`);
    if (typeof base[k] === 'boolean') { if (typeof v !== 'boolean') throw new LayerError('SETTINGS_INVALID', `${key}.${k} must be true or false`); out[k] = v; }
    else out[k] = num(v, `${key}.${k}`, ...ranges[k]);
  }
  return out;
}
// The "operatorLayer" key of protocol-manifest.json; every key optional, unknown keys refused (a typo never silently
// falls back to a default). Paths are relative to the project root.
function parseSettings(raw) {
  if (raw === undefined || raw === null) raw = {};
  if (!isObj(raw)) throw new LayerError('SETTINGS_INVALID', 'operatorLayer must be an object');
  const known = new Set(Object.keys(DEFAULTS));
  for (const k of Object.keys(raw)) if (!known.has(k) && k !== 'comment') throw new LayerError('SETTINGS_INVALID', `${k} is not a known setting`);
  const s = { ...DEFAULTS };
  for (const k of ['runtime', 'reviews', 'worklog', 'ownerInbox']) {
    if (raw[k] === undefined) continue;
    if (raw[k] === null && k === 'ownerInbox') { s[k] = null; continue; }
    if (!relSafe(raw[k])) throw new LayerError('SETTINGS_INVALID', `${k} must be a relative path inside the project`);
    s[k] = raw[k].replace(/\\/g, '/');
  }
  if (raw.backlog !== undefined && raw.backlog !== null) {
    const b = raw.backlog;
    if (!isObj(b) || !BACKLOG_KINDS.includes(b.kind)) throw new LayerError('SETTINGS_INVALID', `backlog.kind must be one of ${BACKLOG_KINDS.join(', ')}`);
    for (const k of Object.keys(b)) if (!['kind', 'file', 'dir', 'idColumn', 'statusColumn'].includes(k)) throw new LayerError('SETTINGS_INVALID', `backlog.${k} is not a known setting`);
    if (b.kind === 'table' || b.kind === 'registry') { if (!relSafe(b.file)) throw new LayerError('SETTINGS_INVALID', 'backlog.file must be a relative path'); }
    if (b.kind === 'cards' && !relSafe(b.dir)) throw new LayerError('SETTINGS_INVALID', 'backlog.dir must be a relative path');
    for (const k of ['idColumn', 'statusColumn']) if (b[k] !== undefined && (typeof b[k] !== 'string' || !b[k].trim())) throw new LayerError('SETTINGS_INVALID', `backlog.${k} must be a column name`);
    s.backlog = { ...b };
  }
  if (raw.readyStatuses !== undefined) s.readyStatuses = strList(raw.readyStatuses, 'readyStatuses');
  if (raw.activeStatuses !== undefined) s.activeStatuses = strList(raw.activeStatuses, 'activeStatuses');
  if (raw.criticalPath !== undefined) s.criticalPath = strList(raw.criticalPath, 'criticalPath');
  if (raw.maxParallel !== undefined) s.maxParallel = num(raw.maxParallel, 'maxParallel', 1, 64);
  s.idle = mergeGroup(DEFAULTS.idle, raw.idle, 'idle', { defaultStallMinutes: [1, 1440], floorMinutes: [1, 1440], p90Share: [0, 1], runtimeMargin: [0, 10], minSamples: [1, 1000], escalationFactor: [1, 10] });
  s.silence = mergeGroup(DEFAULTS.silence, raw.silence, 'silence', { quietMinutes: [1, 1440], repeatMinutes: [1, 10080] });
  s.processes = mergeGroup(DEFAULTS.processes, raw.processes, 'processes', { olderThanHours: [0, 720] });
  s.schedules = mergeGroup(DEFAULTS.schedules, raw.schedules, 'schedules', { tickMinutes: [5, 60], silenceMinutes: [5, 120], proxyMinutes: [1, 60] });
  if (!Number.isInteger(s.schedules.proxyMinutes)) throw new LayerError('SETTINGS_INVALID', 'schedules.proxyMinutes must be an integer');
  s.overhead = mergeGroup(DEFAULTS.overhead, raw.overhead, 'overhead', { targetMin: [0, 1], targetMax: [0, 1] });
  return s;
}
function readManifest(root) {
  let text;
  try { text = fs.readFileSync(path.join(root, 'protocol-manifest.json'), 'utf8'); }
  catch (e) { throw new LayerError('MANIFEST_UNREADABLE', e.code || e.message); }
  try { return JSON.parse(text); } catch { throw new LayerError('MANIFEST_UNREADABLE', 'not valid JSON'); }
}
const loadSettings = root => parseSettings(readManifest(root).operatorLayer);

// ---- roots ----
function git(cwd, args) {
  const r = spawnSync('git', ['-c', 'core.hooksPath=disabled', ...args], { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' } });
  return { code: r.error ? null : r.status, out: (r.stdout || '').trim() };
}
// The main checkout: launch records and runtime state of every worktree live there (as for the launch wrapper).
function mainRoot(dir) {
  const r = git(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return r.code === 0 && r.out ? path.resolve(r.out, '..') : path.resolve(dir);
}
const runtimeOf = (root, s) => path.join(root, s.runtime);

// ---- small io helpers ----
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}
function appendLine(file, obj) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.appendFileSync(file, `${JSON.stringify(obj)}\n`, 'utf8'); }
const alivePid = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const iso = ms => (Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null);
const minutes = ms => Math.round(ms / 6000) / 10;

// Newest mtime under dir (files only; .git and node_modules skipped; walk capped at `limit` entries and `depth` levels,
// truncated says a cap was hit). The fallback for a directory without .git. null when dir is missing.
function lastChange(dir, limit = WALK_LIMIT, depth = WALK_DEPTH) {
  if (!dir) return null;
  let best = 0; let file = null; let seen = 0; let truncated = false;
  const stack = [[dir, 0]];
  try { if (!fs.statSync(dir).isDirectory()) return null; } catch { return null; }
  while (stack.length) {
    const [d, level] = stack.pop();
    let names;
    try { names = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of names) {
      if (++seen > limit) { truncated = true; stack.length = 0; break; }
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (SKIP_DIRS.has(e.name)) continue; if (level + 1 >= depth) truncated = true; else stack.push([p, level + 1]); continue; }
      if (!e.isFile()) continue;
      try { const m = fs.statSync(p).mtimeMs; if (m > best) { best = m; file = p; } } catch { /* vanished */ }
    }
  }
  return { at: best || null, file: file ? path.relative(dir, file).replace(/\\/g, '/') : null, truncated };
}
function lastCommit(dir) {
  if (!dir) return null;
  try { if (!fs.statSync(dir).isDirectory()) return null; } catch { return null; }
  const r = git(dir, ['log', '-1', '--format=%ct %h']);
  const m = /^(\d+) ([0-9a-f]+)$/.exec(r.out);
  return r.code === 0 && m ? { at: Number(m[1]) * 1000, sha: m[2] } : null;
}
// The repository of a worktree root, read from its .git entry without a git call: { common } or null without .git.
function gitDirs(dir) {
  const dot = path.join(dir, '.git');
  let st;
  try { st = fs.statSync(dot); } catch { return null; }
  if (st.isDirectory()) return { common: dot };
  try {
    const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dot, 'utf8'));
    if (!m) return null;
    const own = path.resolve(dir, m[1]);
    let common = own;
    try { common = path.resolve(own, fs.readFileSync(path.join(own, 'commondir'), 'utf8').trim()); } catch { /* a plain gitdir */ }
    return { common };
  } catch { return null; }
}
// Runs in a child node process (one spawnSync for the whole call): a git status per worktree with `limit` in parallel,
// the newest mtime among the changed paths (at most pathCap), then one log per repository for the head commit times.
// Self-contained: its source is passed with -e.
async function gitWorker({ jobs, limit, pathCap }) {
  const { execFile } = require('node:child_process');
  const fsp = require('node:fs').promises;
  const p = require('node:path');
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  const run = (args, cwd) => new Promise(done => execFile('git', ['-c', 'core.hooksPath=disabled', ...args], { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 28, env }, (e, out) => done(e ? null : out)));
  const after = (s, n) => { let i = -1; for (let k = 0; k < n; k++) { i = s.indexOf(' ', i + 1); if (i < 0) return null; } return s.slice(i + 1); };
  const results = {};
  let next = 0;
  const lane = async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      const out = await run(['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all', '--no-renames', '--ignore-submodules=all'], job.dir);
      if (out === null) { results[job.dir] = { ok: false }; continue; }
      const recs = out.split('\0');
      let oid = null; const paths = [];
      for (let i = 0; i < recs.length; i++) {
        const r = recs[i];
        if (r.startsWith('# branch.oid ')) { const v = r.slice(13).trim(); oid = /^[0-9a-f]{7,64}$/.test(v) ? v : null; continue; }
        const f = r[0] === '1' ? after(r, 8) : r[0] === '2' ? after(r, 9) : r[0] === 'u' ? after(r, 10) : r[0] === '?' ? r.slice(2) : null;
        if (r[0] === '2') i++;
        if (f) paths.push(f);
      }
      let at = 0; let file = null;
      for (const f of paths.slice(0, pathCap)) { try { const m = (await fsp.stat(p.join(job.dir, f))).mtimeMs; if (m > at) { at = m; file = f; } } catch { /* deleted or vanished */ } }
      results[job.dir] = { ok: true, oid, change: { at: at || null, file, truncated: paths.length > pathCap, paths: paths.length } };
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, jobs.length)) }, lane));
  const groups = new Map();
  for (const job of jobs) { const r = results[job.dir]; if (r.ok && r.oid) { if (!groups.has(job.common)) groups.set(job.common, new Set()); groups.get(job.common).add(r.oid); } }
  const times = {};
  await Promise.all([...groups].map(async ([common, set]) => {
    const shas = [...set];
    for (let k = 0; k < shas.length; k += 300) {
      const out = await run(['--git-dir', common, 'log', '--no-walk=unsorted', '--ignore-missing', '--format=%H %ct %h', ...shas.slice(k, k + 300)], p.dirname(common));
      for (const line of (out || '').split('\n')) { const m = /^([0-9a-f]+) (\d+) ([0-9a-f]+)$/.exec(line.trim()); if (m) times[m[1]] = { at: Number(m[2]) * 1000, sha: m[3] }; }
    }
  }));
  for (const job of jobs) { const r = results[job.dir]; if (r.ok) r.commit = (r.oid && times[r.oid]) || null; }
  process.stdout.write(JSON.stringify(results));
}
// Bounded facts of each distinct worktree: { change: {at, file, truncated}, commit: {at, sha} | null, via } or null when the
// directory is missing. A git worktree costs one git status (in parallel); without .git, or when git fails, the capped walk.
function treeFacts(dirs, opts = {}) {
  const out = new Map();
  const jobs = [];
  for (const d of new Set(dirs.filter(Boolean))) {
    let isDir = false;
    try { isDir = fs.statSync(d).isDirectory(); } catch { /* missing */ }
    if (!isDir) { out.set(d, null); continue; }
    const g = gitDirs(d);
    if (g) jobs.push({ dir: d, common: g.common });
    else { const w = lastChange(d); out.set(d, { change: w, commit: null, via: w.truncated ? 'walk-capped' : 'walk' }); }
  }
  let results = {};
  if (jobs.length) {
    const limit = opts.gitParallel || Math.max(2, Math.min(8, require('node:os').cpus().length));
    const r = spawnSync(process.execPath, ['-e', `(${gitWorker.toString()})(JSON.parse(require('node:fs').readFileSync(0, 'utf8'))).catch(e => { console.error(e); process.exit(1); })`],
      { input: JSON.stringify({ jobs, limit, pathCap: GIT_PATH_CAP }), encoding: 'utf8', windowsHide: true, maxBuffer: 1 << 28, timeout: 300000 });
    try { if (r.status === 0) results = JSON.parse(r.stdout); } catch { results = {}; }
  }
  for (const j of jobs) {
    const r = results[j.dir];
    if (r && r.ok) out.set(j.dir, { change: r.change, commit: r.commit, via: r.change.truncated ? 'git-capped' : 'git' });
    else { const w = lastChange(j.dir); out.set(j.dir, { change: w, commit: lastCommit(j.dir), via: w.truncated ? 'walk-capped' : 'walk' }); }
  }
  return out;
}
// The newest of the changed files and the head commit of one worktree: { at, file } (file null when the commit is newest).
function factsChange(f) {
  if (!f) return null;
  const c = f.change && f.change.at ? f.change.at : 0;
  const k = f.commit && f.commit.at ? f.commit.at : 0;
  return c >= k ? { at: c || null, file: c ? f.change.file : null } : { at: k, file: null };
}

// ---- launch records (written by the launch wrapper) ----
function readLaunches(runtime) {
  let names;
  try { names = fs.readdirSync(runtime); }
  catch (e) { if (e.code === 'ENOENT') return { launches: [], state: {} }; throw new LayerError('RUNTIME_UNREADABLE', e.code || e.message); }
  const set = new Set(names);
  const byName = new Map();
  for (const f of names) {
    const m = /^(.+)\.(running|terminal)\.json$/.exec(f);
    if (!m) continue;
    const rec = readJson(path.join(runtime, f));
    if (!rec || typeof rec !== 'object') continue;
    const e = byName.get(m[1]) || { name: m[1] };
    e[m[2]] = rec;
    byName.set(m[1], e);
  }
  for (const e of byName.values()) {
    // One identity rule (seat-slots.cjs): a terminal record ends the launch of its running record only when both carry the
    // same attempt (wrapper PID and start). A terminal of another attempt of this name is that attempt's outcome: it is a
    // sample of its route and never ends, names or times the attempt that runs now.
    if (e.running && e.terminal && !slots.sameAttempt(e.running, e.terminal)) { e.otherAttempt = e.terminal; delete e.terminal; }
    // An acceptance or a stop recorded before this attempt started was made for an earlier attempt of the name.
    const startedMs = Date.parse(recOf(e).startedAt);
    const before = at => Number.isFinite(startedMs) && Number.isFinite(Date.parse(at)) && Date.parse(at) < startedMs;
    const accepted = set.has(`${e.name}.accepted.json`) ? readJson(path.join(runtime, `${e.name}.accepted.json`)) : null;
    // an acceptance accepts only with a valid time; a damaged or undated one accepts nothing
    const acceptedValid = accepted && typeof accepted === 'object' && typeof accepted.acceptedAt === 'string' && Number.isFinite(Date.parse(accepted.acceptedAt));
    if (acceptedValid && !before(accepted.acceptedAt)) e.accepted = accepted;
    if (set.has(`${e.name}.stopped.json`)) {
      const stopped = readJson(path.join(runtime, `${e.name}.stopped.json`));
      if (stopOfAttempt(stopped, e.running)) e.stopped = stopped; else e.stopUnproven = true;
    }
  }
  const state = readJson(path.join(runtime, 'operator-layer-state.json')) || {};
  return { launches: [...byName.values()], state };
}
const recOf = e => e.running || e.terminal || {};
// A stop record proves the stop of the attempt that runs now only when it parses, names one process id of that attempt
// and carries a valid stop time not earlier than the attempt start. A damaged, undated or foreign record proves nothing:
// the launch it names stays dead until a record of its own attempt says otherwise.
function stopOfAttempt(stopped, run) {
  if (!stopped || typeof stopped !== 'object' || Array.isArray(stopped) || !run) return false;
  const startedMs = Date.parse(run.startedAt);
  const stoppedMs = typeof stopped.stoppedAt === 'string' ? Date.parse(stopped.stoppedAt) : NaN;
  if (!Number.isFinite(startedMs) || !Number.isFinite(stoppedMs) || stoppedMs < startedMs) return false;
  return Number.isSafeInteger(stopped.pid) && stopped.pid > 0 && (stopped.pid === run.wrapperPid || stopped.pid === run.childPid);
}
const taskOf = e => { const r = recOf(e); const t = (e.terminal && e.terminal.task) || r.task || r.stream || null; return t ? String(t) : null; };
// The route of a launch: the seat route the launcher printed, the route gate's route, the client and model of the
// launch, else the command it started. Finished launches of one route give its p90. The client and model route is keyed by
// the one comparison key of the model spelling (two spellings of one model are one route, never two pools of samples)
// and the folded client slug; a placeholder client or model (unknown, none, null, '-', empty) names no route on every
// source: the printed seat route (client:model) and the gate's route id are read by the same rule, and a source that
// names no route gives way to the next one.
const ROUTE_PLACEHOLDER_RE = PLACEHOLDER_MODEL_RE;
const routePart = v => (typeof v === 'string' && v.trim() && !ROUTE_PLACEHOLDER_RE.test(v.trim()) ? v.trim().toLowerCase() : null);
// A written route: client:model keyed like the launch's client and model, a route id (no colon) as one part.
function namedRoute(value) {
  if (typeof value !== 'string') return null;
  const cut = value.indexOf(':');
  if (cut === -1) return routePart(value);
  const client = routePart(value.slice(0, cut));
  const model = routePart(value.slice(cut + 1)) ? modelKey(value.slice(cut + 1)) : null;
  return client && model ? `${client}:${model}` : null;
}
function routeKey(e) {
  const r = { ...(e.running || {}), ...(e.terminal || {}) };
  const seat = namedRoute(r.seatRoute);
  if (seat) return seat;
  const gated = r.routeGate && r.routeGate.applied === true ? namedRoute(r.routeGate.route) : null;
  if (gated) return gated;
  const op = r.resolver && r.resolver.operator;
  const client = op ? routePart(op.client) : null;
  const model = op && routePart(op.model) ? modelKey(op.model) : null;
  if (client && model) return `${client}:${model}`;
  return `command:${path.basename(String(r.command || 'unknown'))}`;
}
function p90(values) {
  if (!values.length) return null;
  const v = [...values].sort((a, b) => a - b);
  return v[Math.max(0, Math.ceil(0.9 * v.length) - 1)];
}
function routeStats(launches) {
  const by = new Map();
  const sample = (t, k) => {
    if (!t || t.status !== 'DONE' || !(Number(t.wallSeconds) > 0)) return;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(Number(t.wallSeconds));
  };
  for (const e of launches) {
    sample(e.terminal, routeKey(e));
    if (e.otherAttempt) sample(e.otherAttempt, routeKey({ terminal: e.otherAttempt }));
  }
  const out = new Map();
  for (const [k, v] of by) out.set(k, { samples: v.length, p90Seconds: p90(v) });
  return out;
}
// The idle threshold of one route: data first, the documented default otherwise.
function idleThreshold(stat, idle) {
  if (stat && stat.samples >= idle.minSamples && stat.p90Seconds > 0) {
    const p90Min = stat.p90Seconds / 60;
    const stallMinutes = Math.max(idle.floorMinutes, idle.p90Share * p90Min);
    return { stallMinutes: Math.round(stallMinutes * 10) / 10, runtimeLimitMinutes: Math.round(p90Min * (1 + idle.runtimeMargin) * 10) / 10, escalateMinutes: Math.round(stallMinutes * idle.escalationFactor * 10) / 10, source: `route-p90 n=${stat.samples}` };
  }
  return { stallMinutes: idle.defaultStallMinutes, runtimeLimitMinutes: null, escalateMinutes: idle.defaultStallMinutes * idle.escalationFactor, source: 'default' };
}
function acceptedOf(e, state) {
  if (e.accepted) return true;
  const before = state && typeof state.acceptedBefore === 'string' ? Date.parse(state.acceptedBefore) : NaN;
  const ended = e.terminal ? Date.parse(e.terminal.endedAt) : NaN;
  return Number.isFinite(before) && Number.isFinite(ended) && ended <= before;
}

// The last change of the log file of a launch (the file itself, not a walk of its directory).
function logChange(file) {
  try { const st = fs.statSync(file); return st.isFile() ? { at: st.mtimeMs, file: path.basename(file) } : null; } catch { return null; }
}
// One row per launch. lastChange and lastCommit are computed for launches that matter now (running, dead, or exited
// with a pending handoff); a finished and accepted launch keeps its record fields only. Every alive launch gets them;
// the others share a cap of DETAIL_TREES distinct worktrees (dead first, then the newest pending handoffs).
function launchRows(root, settings, opts = {}) {
  const now = opts.now ?? Date.now();
  const processIds = opts.processTable ? new Set(opts.processTable().map(p => p.pid)) : null;
  const probed = new Map();
  const probe = pid => { if (!probed.has(pid)) probed.set(pid, alivePid(pid)); return probed.get(pid); };
  const isAlive = processIds ? pid => processIds.has(pid) : probe;
  const runtime = opts.runtime || runtimeOf(root, settings);
  const { launches, state } = readLaunches(runtime);
  const stats = routeStats(launches);
  const entries = [];
  const want = [];
  for (const e of launches.sort((a, b) => String(recOf(a).startedAt).localeCompare(String(recOf(b).startedAt)) || a.name.localeCompare(b.name))) {
    const r = recOf(e);
    const run = e.running || {};
    const startedMs = Date.parse(r.startedAt);
    const row = { name: e.name, task: taskOf(e), stream: r.stream || null, route: routeKey(e), worktree: r.worktree || run.worktree || null, startedAt: r.startedAt || null, wrapperPid: run.wrapperPid || r.wrapperPid || null, childPid: run.childPid || null };
    const t = e.terminal;
    if (t) {
      Object.assign(row, { state: 'exited', status: t.status, exitCode: t.exitCode, failureClass: t.failureClass || null, endedAt: t.endedAt || null });
      row.handoff = acceptedOf(e, state) ? 'accepted' : 'pending';
    } else if (run.ended) {
      Object.assign(row, { state: 'exited', status: 'UNKNOWN', endedAt: run.ended, handoff: acceptedOf(e, state) ? 'accepted' : 'pending' });
    } else {
      const alive = isAlive(run.wrapperPid) || isAlive(run.childPid);
      if (!alive && e.stopped) Object.assign(row, { state: 'exited', status: 'STOPPED', endedAt: e.stopped.stoppedAt || null });
      else row.state = alive ? 'alive' : 'dead';
      if (!alive && !e.stopped && e.stopUnproven) row.stopRecord = 'unproven';
      row.handoff = alive ? 'n/a' : (acceptedOf(e, state) ? 'accepted' : 'pending');
    }
    // a pending handoff older than the detail window (default 72 hours) keeps its record fields only: an old project
    // with hundreds of unaccepted records must not read every worktree on each status call
    const recent = endedWithin(row.endedAt, now, opts.detailWindowHours || 72);
    const live = row.state === 'alive' || row.state === 'dead' || (row.handoff === 'pending' && recent);
    if (live && (opts.details !== false)) want.push({ row, log: run.log || r.log || null });
    entries.push({ row, startedMs });
  }
  const rank = x => (x.row.state === 'alive' ? 0 : x.row.state === 'dead' ? 1 : 2);
  want.sort((a, b) => rank(a) - rank(b) || String(b.row.endedAt || b.row.startedAt || '').localeCompare(String(a.row.endedAt || a.row.startedAt || '')));
  const cap = opts.detailTrees ?? DETAIL_TREES;
  const trees = new Set();
  const picked = [];
  let withoutDetails = 0;
  for (const x of want) {
    const wt = x.row.worktree ? path.resolve(x.row.worktree) : null;
    if (x.row.state !== 'alive' && wt && !trees.has(wt) && trees.size >= cap) { withoutDetails++; continue; }
    if (wt) trees.add(wt);
    picked.push(x);
  }
  const facts = treeFacts([...trees], opts);
  let capped = 0;
  for (const { row, log } of picked) {
    const f = row.worktree ? facts.get(path.resolve(row.worktree)) : null;
    if (f && /capped/.test(f.via)) capped++;
    const changes = [factsChange(f)];
    if (log) changes.push(logChange(path.resolve(log)));
    const best = changes.filter(Boolean).reduce((a, b) => ((b.at || 0) > (a.at || 0) ? b : a), { at: null, file: null });
    row.lastChange = iso(best.at);
    row.lastChangeFile = best.file;
    row.lastChangeVia = f ? f.via : (best.at ? 'log' : 'none');
    const c = f && f.commit;
    row.lastCommit = c ? iso(c.at) : null;
    row.lastCommitSha = c ? c.sha : null;
  }
  const rows = [];
  for (const { row, startedMs } of entries) {
    if (row.state === 'alive') {
      const th = idleThreshold(stats.get(row.route), settings.idle);
      const since = Math.max(Date.parse(row.lastChange) || 0, Number.isFinite(startedMs) ? startedMs : 0);
      row.idleMinutes = since ? minutes(now - since) : null;
      row.runtimeMinutes = Number.isFinite(startedMs) ? minutes(now - startedMs) : null;
      row.threshold = th;
      const noChange = row.idleMinutes !== null && row.idleMinutes >= th.stallMinutes;
      const over = th.runtimeLimitMinutes !== null && row.runtimeMinutes !== null && row.runtimeMinutes > th.runtimeLimitMinutes;
      if (noChange || over) { row.state = 'stalled'; row.stallReason = noChange ? 'no-file-change' : 'over-route-p90'; }
    }
    rows.push(row);
  }
  const bounds = { detailTrees: cap, detailedTrees: trees.size, withoutDetails, gitPathCap: GIT_PATH_CAP, walkCap: WALK_LIMIT, walkDepth: WALK_DEPTH, capped };
  return { rows, stats, state, bounds };
}
function rowLine(r) {
  const parts = [`${r.state.toUpperCase().padEnd(7)} ${r.name}`, `task=${r.task || '-'}`];
  if (r.status) parts.push(`status=${r.status}`, `exit=${r.exitCode === null || r.exitCode === undefined ? 'none' : r.exitCode}`);
  if (r.failureClass) parts.push(`class=${r.failureClass}`);
  parts.push(`handoff=${r.handoff}`);
  if (r.idleMinutes !== undefined) parts.push(`idle=${r.idleMinutes}m`, `runtime=${r.runtimeMinutes}m`, `threshold=${r.threshold.stallMinutes}m(${r.threshold.source}${r.threshold.runtimeLimitMinutes ? `, limit ${r.threshold.runtimeLimitMinutes}m` : ''})`);
  if (r.stallReason) parts.push(`stall=${r.stallReason}`);
  if ('lastChange' in r) parts.push(`lastChange=${r.lastChange || 'none'}`, `lastCommit=${r.lastCommit ? `${r.lastCommit} ${r.lastCommitSha}` : 'none'}`);
  parts.push(`started=${r.startedAt || '-'}`);
  if (r.endedAt) parts.push(`ended=${r.endedAt}`);
  return parts.join(' ');
}
// The default status view: alive, stalled and dead launches, every pending handoff, and exited launches that ended within
// RECENT_EXIT_HOURS; all=true keeps the full history.
function shownRows(rows, { all = false, now = Date.now() } = {}) {
  if (all) return rows;
  return rows.filter(r => r.state !== 'exited' || r.handoff === 'pending' || endedWithin(r.endedAt, now, RECENT_EXIT_HOURS));
}
const boundsLine = b => `details=${b.detailedTrees}/${b.detailTrees}worktrees withoutDetails=${b.withoutDetails} lastChange=git-changed(cap ${b.gitPathCap} paths)+head,no-git-walk(cap ${b.walkCap} entries depth ${b.walkDepth}) capped=${b.capped}`;
const counts = rows => ({ alive: rows.filter(r => r.state === 'alive').length, stalled: rows.filter(r => r.state === 'stalled').length, dead: rows.filter(r => r.state === 'dead').length, pending: rows.filter(r => r.handoff === 'pending').length });

// ---- project adapter: backlog ----
function cellText(c) { return c.replace(/`/g, '').replace(/\*\*/g, '').replace(/~~/g, '').trim(); }
function splitRow(line) {
  const v = line.trim();
  if (!v.startsWith('|') || !v.endsWith('|')) return null;
  return v.slice(1, -1).split('|').map(cellText);
}
const ID_HEADERS = ['id', 'task', 'stream'];
const STATUS_HEADERS = ['status', 'статус', 'state'];
// Every markdown table of the file whose header names an id column and a status column contributes its rows.
function parseTable(text, b = {}) {
  const items = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < lines.length - 1; i++) {
    const head = splitRow(lines[i]);
    const rule = splitRow(lines[i + 1]);
    if (!head || !rule || !rule.every(c => /^:?-{3,}:?$/.test(c))) continue;
    const low = head.map(h => h.toLowerCase());
    const idCol = b.idColumn ? low.indexOf(b.idColumn.toLowerCase()) : low.findIndex(h => ID_HEADERS.includes(h));
    const stCol = b.statusColumn ? low.indexOf(b.statusColumn.toLowerCase()) : low.findIndex(h => STATUS_HEADERS.includes(h));
    if (idCol < 0 || stCol < 0) continue;
    let j = i + 2;
    for (; j < lines.length; j++) {
      const cells = splitRow(lines[j]);
      if (!cells) break;
      const id = cells[idCol]; const status = (cells[stCol] || '').toLowerCase();
      if (id && status) items.push({ id, status, critical: false });
    }
    i = j - 1;
  }
  return items;
}
const FIELD = (name) => new RegExp(`^\\s*(?:[-*]\\s*)?(?:\\*\\*)?(?:${name})(?:\\*\\*)?\\s*:\\s*(.+?)\\s*$`, 'im');
function parseCard(text, fallbackId) {
  const status = FIELD('status|статус').exec(text);
  if (!status) return null;
  const id = FIELD('id').exec(text);
  const critical = FIELD('critical|критический путь|critical path').exec(text);
  return { id: cellText(id ? id[1] : fallbackId), status: cellText(status[1]).toLowerCase().split(/[\s,;]/)[0], critical: !!critical && /^(yes|true|да|x)\b/i.test(cellText(critical[1])) };
}
// Which backlog this project keeps. An explicit "backlog" setting wins; otherwise the kernel candidate registry when
// present, then docs/backlog/BACKLOG.md (a table), then task cards under docs/backlog/tasks or docs/backlog, else none.
function resolveBacklog(root, settings) {
  if (settings.backlog) return settings.backlog;
  const exists = rel => fs.existsSync(path.join(root, rel));
  if (exists(path.join(settings.runtime, 'CANDIDATES.md'))) return { kind: 'registry', file: `${settings.runtime}/CANDIDATES.md`, auto: true };
  if (exists('docs/backlog/BACKLOG.md')) return { kind: 'table', file: 'docs/backlog/BACKLOG.md', auto: true };
  if (exists('docs/backlog/tasks')) return { kind: 'cards', dir: 'docs/backlog/tasks', auto: true };
  if (exists('docs/backlog')) return { kind: 'cards', dir: 'docs/backlog', auto: true };
  return { kind: 'none', auto: true };
}
function readBacklog(root, settings) {
  const b = resolveBacklog(root, settings);
  const critical = new Set(settings.criticalPath);
  const done = items => ({ backlog: b, items: items.map(it => ({ ...it, critical: it.critical || critical.has(it.id.toLowerCase()) })) });
  if (b.kind === 'none') return done([]);
  if (b.kind === 'registry') {
    let text;
    try { text = fs.readFileSync(path.join(root, b.file)); } catch (e) { throw new LayerError('BACKLOG_UNREADABLE', `${b.file} (${e.code || e.message})`); }
    let parsed;
    try { parsed = require('../lib/candidate-registry.cjs').parseRegistry(text); }
    catch (e) { throw new LayerError('BACKLOG_UNREADABLE', `${b.file} is not a valid candidate registry (${e.code || e.message})`); }
    return done(parsed.rows.map(({ cells }) => ({ id: cells[0], status: cells[4], critical: false, sha: cells[2] })));
  }
  if (b.kind === 'table') {
    let text;
    try { text = fs.readFileSync(path.join(root, b.file), 'utf8'); } catch (e) { throw new LayerError('BACKLOG_UNREADABLE', `${b.file} (${e.code || e.message})`); }
    return done(parseTable(text, b));
  }
  let names;
  try { names = fs.readdirSync(path.join(root, b.dir)).filter(n => n.endsWith('.md')).sort(); }
  catch (e) { throw new LayerError('BACKLOG_UNREADABLE', `${b.dir} (${e.code || e.message})`); }
  const items = [];
  for (const n of names) {
    let text;
    try { text = fs.readFileSync(path.join(root, b.dir, n), 'utf8'); } catch (e) { throw new LayerError('BACKLOG_UNREADABLE', `${b.dir}/${n} (${e.code || e.message})`); }
    const card = parseCard(text, n.replace(/\.md$/, ''));
    if (card) items.push(card);
  }
  return done(items);
}
function backlogMtime(root, b) {
  try {
    if (b.kind === 'table' || b.kind === 'registry') return fs.statSync(path.join(root, b.file)).mtimeMs;
    if (b.kind === 'cards') return Math.max(0, ...fs.readdirSync(path.join(root, b.dir)).map(n => { try { return fs.statSync(path.join(root, b.dir, n)).mtimeMs; } catch { return 0; } }));
  } catch { /* missing */ }
  return 0;
}

// ---- project adapter: worktrees, reviews, owner inbox ----
function worktrees(root) {
  const r = git(root, ['worktree', 'list', '--porcelain']);
  if (r.code !== 0) throw new LayerError('WORKTREES_UNREADABLE', 'git worktree list failed');
  const out = []; let cur = null;
  for (const line of r.out.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) { cur = { path: path.resolve(line.slice(9)) }; out.push(cur); }
    else if (cur && line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  return out;
}
const mentions = (text, id) => { const e = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); return new RegExp(`(?:^|[^A-Za-z0-9])${e}(?:$|[^A-Za-z0-9])`, 'i').test(text); };
function reviewVerdicts(root, settings, sinceMs) {
  const dir = path.join(root, settings.reviews);
  let names;
  try { names = fs.readdirSync(dir); } catch (e) { if (e.code === 'ENOENT') return []; throw new LayerError('REVIEWS_UNREADABLE', e.code || e.message); }
  const out = [];
  for (const n of names.filter(x => x.endsWith('.md'))) {
    let st;
    try { st = fs.statSync(path.join(dir, n)); } catch { continue; }
    if (!st.isFile() || st.mtimeMs <= sinceMs) continue;
    let text = '';
    try { text = fs.readFileSync(path.join(dir, n), 'utf8').slice(0, 200000); } catch { continue; }
    const v = VERDICT_RE.exec(text);
    if (v) out.push({ file: `${settings.reviews}/${n}`, verdict: v[1].toUpperCase(), mtimeMs: st.mtimeMs });
  }
  return out.sort((a, b) => a.mtimeMs - b.mtimeMs);
}
function resolveInbox(root, settings) {
  if (settings.ownerInbox) return settings.ownerInbox;
  return fs.existsSync(path.join(root, 'docs/ops/OWNER-ADDENDA.md')) ? 'docs/ops/OWNER-ADDENDA.md' : null;
}
function inboxDigest(root, rel) {
  if (!rel) return null;
  try { return crypto.createHash('sha256').update(fs.readFileSync(path.join(root, rel))).digest('hex'); }
  catch (e) { if (e.code === 'ENOENT') return 'absent'; throw new LayerError('INBOX_UNREADABLE', `${rel} (${e.code || e.message})`); }
}

// ---- notifier (local only) ----
// The alert file, one line in the alert log and, on Windows with toast enabled, a toast. COLABUS_NOTIFY=off disables
// the toast (tests and headless hosts). Never a network call.
function toast(title, text, env = process.env) {
  if (env.COLABUS_NOTIFY === 'off') return 'off';
  if (process.platform !== 'win32') return `SKIP platform=${process.platform} reason=windows-toast`;
  const script = [
    '$ErrorActionPreference = "Stop"',
    '[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null',
    '$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)',
    '$n = $t.GetElementsByTagName("text")',
    '$n.Item(0).AppendChild($t.CreateTextNode($env:COLABUS_TOAST_TITLE)) | Out-Null',
    '$n.Item(1).AppendChild($t.CreateTextNode($env:COLABUS_TOAST_TEXT)) | Out-Null',
    '$app = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe"',
    '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($t))',
  ].join('; ');
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, timeout: 20000, env: { ...env, COLABUS_TOAST_TITLE: title.slice(0, 120), COLABUS_TOAST_TEXT: text.slice(0, 400) } });
  return r.status === 0 && !r.error ? 'shown' : 'failed';
}
function notify(root, settings, alert, deps = {}) {
  const runtime = runtimeOf(root, settings);
  const shown = settings.silence.toast ? (deps.toast || toast)(alert.title, alert.text) : 'disabled';
  const rec = { schema: 'operator-alert/1', at: new Date(deps.now || Date.now()).toISOString(), kind: alert.kind, line: alert.line, text: alert.text, toast: shown };
  writeJson(path.join(runtime, 'operator-alert.json'), rec);
  appendLine(path.join(runtime, 'operator-alerts.jsonl'), rec);
  return rec;
}

// ---- tick ----
const TICK_STATE = 'operator-layer-tick.json';
const TICK_LAST = 'operator-tick-last.json';
function tick(root, opts = {}) {
  const now = opts.now || Date.now();
  const out = [];
  let settings;
  try { settings = opts.settings || loadSettings(root); } catch (e) { return { verdict: 'ERROR', lines: [`ERROR ${e.message}`] }; }
  const runtime = runtimeOf(root, settings);
  const statePath = path.join(runtime, TICK_STATE);
  const finish = (verdict, lines) => {
    if (!opts.dry) { try { writeJson(path.join(runtime, TICK_LAST), { schema: 'operator-tick-last/1', at: new Date(now).toISOString(), verdict, line: lines[0] }); } catch { /* the verdict stands */ } }
    return { verdict, lines };
  };
  let state = {};
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); }
  catch (e) { if (e.code !== 'ENOENT') return finish('ERROR', [`ERROR tick state unreadable or not JSON (${e.code || 'parse'})`]); }
  const errors = [];
  const safe = (f, fallback) => { try { return f(); } catch (e) { errors.push(e.message); return fallback; } };
  const inboxRel = safe(() => resolveInbox(root, settings), null);
  const digest = safe(() => inboxDigest(root, inboxRel), null);
  if (opts.ack) {
    if (errors.length) return finish('ERROR', [`ERROR ${errors.join('; ')}`]);
    try { writeJson(statePath, { ...state, schema: 'operator-layer-tick/1', ackAt: new Date(now).toISOString(), inboxDigest: digest }); }
    catch (e) { return finish('ERROR', [`ERROR tick state not written (${e.code || e.message})`]); }
    return finish('ACK', [`ACK at=${new Date(now).toISOString()}`]);
  }
  const ackMs = state.ackAt ? Date.parse(state.ackAt) : 0;
  if (state.ackAt !== undefined && !Number.isFinite(ackMs)) errors.push('tick state ackAt is not a valid time');
  const backlog = safe(() => readBacklog(root, settings), { backlog: { kind: 'none' }, items: [] });
  const status = safe(() => launchRows(root, settings, { now, runtime, processTable: opts.processTable }), { rows: [], stats: new Map(), state: {} });
  const trees = safe(() => worktrees(root), []);
  const reviews = safe(() => reviewVerdicts(root, settings, Number.isFinite(ackMs) ? ackMs : 0), []);
  if (errors.length) return finish('ERROR', [`ERROR ${errors.join('; ')}`]);
  // NEW: the owner inbox changed since the last --ack. The first tick records the baseline and is not NEW.
  if (inboxRel) {
    if (state.inboxDigest === undefined) { try { writeJson(statePath, { ...state, schema: 'operator-layer-tick/1', inboxDigest: digest }); } catch { /* next tick retries */ } }
    else if (digest !== state.inboxDigest) return finish('NEW', [`NEW owner-inbox changed file=${inboxRel}`, 'next: read the owner words, act, then run node .ai/bin/operator/layer.cjs tick --ack']);
  }
  const rows = status.rows;
  const liveFor = id => rows.filter(r => (r.state === 'alive' || r.state === 'stalled') && r.task && r.task.toLowerCase() === id.toLowerCase());
  const live = rows.filter(r => r.state === 'alive' || r.state === 'stalled');
  const reasons = [];
  const escalate = [];
  const ready = backlog.items.filter(it => settings.readyStatuses.includes(it.status));
  const active = backlog.items.filter(it => settings.activeStatuses.includes(it.status));
  const readyIdle = ready.filter(it => !liveFor(it.id).length);
  if (readyIdle.length && live.length < settings.maxParallel) reasons.push(`ready-idle tasks=${readyIdle.slice(0, 8).map(it => it.id).join(',')}${readyIdle.length > 8 ? `,+${readyIdle.length - 8}` : ''} running=${live.length} maxParallel=${settings.maxParallel}`);
  const defaultTh = idleThreshold(null, settings.idle);
  const idleActive = active.filter(it => !liveFor(it.id).length).map(it => ({ it, tree: trees.find(w => mentions(w.path, it.id) || (w.branch && mentions(w.branch, it.id))) }));
  const facts = treeFacts(idleActive.filter(x => x.tree).map(x => x.tree.path), opts);
  for (const { it, tree } of idleActive) {
    const ended = rows.filter(r => r.task && r.task.toLowerCase() === it.id.toLowerCase()).map(r => Date.parse(r.endedAt) || 0);
    const lc = tree ? factsChange(facts.get(tree.path)) : null;
    const since = Math.max(lc && lc.at ? lc.at : 0, ...ended, backlogMtime(root, backlog.backlog));
    const idle = since ? minutes(now - since) : null;
    reasons.push(`active-without-launch task=${it.id} status=${it.status}${tree ? ` worktree=${tree.path.replace(/\\/g, '/')}` : ''} lastChange=${lc && lc.at ? iso(lc.at) : 'none'}`);
    if (it.critical && idle !== null && idle >= defaultTh.escalateMinutes) escalate.push(`critical task=${it.id} idle=${idle}m without a live launch (escalate at ${defaultTh.escalateMinutes}m)`);
  }
  const critical = new Set(backlog.items.filter(it => it.critical).map(it => it.id.toLowerCase()));
  for (const r of rows) {
    if (r.state === 'dead' && r.handoff === 'pending') reasons.push(`silent-death name=${r.name} task=${r.task || '-'} started=${r.startedAt}`);
    if (r.state === 'stalled') {
      reasons.push(`stalled name=${r.name} task=${r.task || '-'} idle=${r.idleMinutes}m runtime=${r.runtimeMinutes}m threshold=${r.threshold.stallMinutes}m(${r.threshold.source}) reason=${r.stallReason}`);
      if (r.task && critical.has(r.task.toLowerCase()) && r.idleMinutes >= r.threshold.escalateMinutes) escalate.push(`critical task=${r.task} launch=${r.name} idle=${r.idleMinutes}m (escalate at ${r.threshold.escalateMinutes}m)`);
    }
    if (r.state === 'exited' && r.handoff === 'pending') reasons.push(`handoff-pending name=${r.name} task=${r.task || '-'} status=${r.status} ended=${r.endedAt}`);
  }
  for (const v of reviews) reasons.push(`review-verdict file=${v.file} verdict=${v.verdict}`);
  if (escalate.length) {
    reasons.unshift(...escalate.map(x => `ESCALATE ${x}`));
    if (!opts.dry && !opts.noNotify) {
      const last = state.lastEscalationAt ? Date.parse(state.lastEscalationAt) : 0;
      if (!last || now - last >= settings.silence.repeatMinutes * 60000) {
        try {
          notify(root, settings, { kind: 'escalation', title: 'Operator: critical path idle', text: escalate.join('; ').slice(0, 400), line: `ESCALATE ${escalate.join('; ')}` }, { now, toast: opts.toast });
          writeJson(statePath, { ...readJson(statePath), schema: 'operator-layer-tick/1', lastEscalationAt: new Date(now).toISOString() });
        } catch { /* the WORK line still carries it */ }
      }
    }
  }
  if (reasons.length) {
    out.push(`WORK ${reasons.join('; ')}`);
    out.push('next: open the backlog and node .ai/bin/operator/layer.cjs status, take the next step now, accept finished launches (layer.cjs accept --name N), then run node .ai/bin/operator/layer.cjs tick --ack; an operator report takes the columns process alive and last change only from status and this tick');
    return finish('WORK', out);
  }
  return finish('NOOP', [`NOOP backlog=${backlog.backlog.kind} ready=${ready.length} active=${active.length} running=${live.length} reviews=0`]);
}

// ---- silence ----
const SILENCE_STATE = 'operator-silence-state.json';
function newestIn(dir, re) {
  let best = 0;
  try { for (const f of fs.readdirSync(dir)) if (!re || re.test(f)) { try { best = Math.max(best, fs.statSync(path.join(dir, f)).mtimeMs); } catch { /* vanished */ } } } catch { /* none */ }
  return best;
}
function lastMovement(root, settings) {
  const g = git(root, ['log', '--all', '-1', '--format=%ct']);
  const commit = g.code === 0 && /^\d+$/.test(g.out) ? Number(g.out) * 1000 : 0;
  const runtime = runtimeOf(root, settings);
  const sources = {
    commit,
    launch: newestIn(runtime, /\.(running|terminal)\.json$|\.marker\.txt$/),
    journal: newestIn(path.join(root, settings.worklog), /\.md$/),
    reviews: newestIn(path.join(root, settings.reviews), /\.md$/),
    backlog: 0,
  };
  try { sources.backlog = backlogMtime(root, resolveBacklog(root, settings)); } catch { /* none */ }
  const at = Math.max(...Object.values(sources));
  return { at, sources };
}
function silence(root, opts = {}) {
  const now = opts.now || Date.now();
  let settings;
  try { settings = opts.settings || loadSettings(root); } catch (e) { return { code: 1, lines: [`ERROR ${e.message}`] }; }
  const runtime = runtimeOf(root, settings);
  const moved = lastMovement(root, settings);
  const quiet = moved.at ? minutes(now - moved.at) : Infinity;
  let pending = true; let why = 'no backlog';
  try {
    const b = readBacklog(root, settings);
    const rows = launchRows(root, settings, { now, runtime, details: false, processTable: opts.processTable }).rows;
    const open = b.items.filter(it => settings.readyStatuses.includes(it.status) || settings.activeStatuses.includes(it.status)).length;
    const liveOrPending = rows.filter(r => r.state === 'alive' || r.state === 'dead' || r.handoff === 'pending').length;
    if (b.backlog.kind !== 'none') { pending = open > 0 || liveOrPending > 0; why = `open=${open} launches=${liveOrPending}`; }
    else if (rows.length) { pending = liveOrPending > 0; why = `launches=${liveOrPending}`; }
  } catch (e) { pending = true; why = `inputs unreadable (${e.code || e.message})`; }
  const st = readJson(path.join(runtime, SILENCE_STATE)) || {};
  const sinceAlert = st.lastAlertAt ? minutes(now - Date.parse(st.lastAlertAt)) : Infinity;
  const head = `quiet=${quiet === Infinity ? 'unknown' : `${quiet}m`} threshold=${settings.silence.quietMinutes}m pending=${pending ? 'yes' : 'no'} (${why}) lastAlert=${sinceAlert === Infinity ? 'never' : `${sinceAlert}m ago`}`;
  if (!opts.test) {
    if (quiet < settings.silence.quietMinutes) return { code: 0, lines: [`QUIET-OK ${head}`] };
    if (!pending) return { code: 0, lines: [`QUIET-IDLE ${head}`] };
    if (sinceAlert < settings.silence.repeatMinutes) return { code: 0, lines: [`ALERT-SUPPRESSED ${head} (repeat window ${settings.silence.repeatMinutes}m)`] };
  }
  const text = opts.test ? `Test of the local operator alert (quiet ${quiet === Infinity ? 'unknown' : quiet} min). Not an alarm.` : `No commit, launch, journal, review or backlog change for ${quiet === Infinity ? 'an unknown time' : `${quiet} min`} while work is pending. Open the project and run the operator tick.`;
  const line = `${opts.test ? 'ALERT-TEST' : 'ALERT'} silence ${head}`;
  if (opts.dry) return { code: 0, lines: [`DRY would alert: ${line}`] };
  const rec = notify(root, settings, { kind: opts.test ? 'silence-test' : 'silence', title: 'Operator silent', text, line }, { now, toast: opts.toast });
  if (!opts.test) writeJson(path.join(runtime, SILENCE_STATE), { schema: 'operator-silence/1', lastAlertAt: new Date(now).toISOString(), quietMinutes: quiet === Infinity ? null : quiet });
  return { code: 0, lines: [line, `alert file=${path.relative(root, path.join(runtime, 'operator-alert.json')).replace(/\\/g, '/')} toast=${rec.toast}`] };
}

// ---- accept ----
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
function accept(root, opts) {
  const settings = opts.settings || loadSettings(root);
  const runtime = runtimeOf(root, settings);
  const at = new Date(opts.now || Date.now()).toISOString();
  if (opts.before) {
    if (!Number.isFinite(Date.parse(opts.before))) throw new LayerError('USAGE', '--before needs an ISO time');
    const file = path.join(runtime, 'operator-layer-state.json');
    writeJson(file, { ...(readJson(file) || {}), schema: 'operator-layer-state/1', acceptedBefore: new Date(Date.parse(opts.before)).toISOString(), acceptedBeforeSetAt: at });
    return `ACCEPTED every launch ended before ${new Date(Date.parse(opts.before)).toISOString()}`;
  }
  if (!opts.name || !NAME_RE.test(opts.name)) throw new LayerError('USAGE', '--name needs a launch name');
  if (!fs.existsSync(path.join(runtime, `${opts.name}.terminal.json`)) && !fs.existsSync(path.join(runtime, `${opts.name}.running.json`))) throw new LayerError('UNKNOWN_LAUNCH', opts.name);
  writeJson(path.join(runtime, `${opts.name}.accepted.json`), { schema: 'launch-accepted/1', name: opts.name, acceptedAt: at, by: opts.by || null });
  return `ACCEPTED ${opts.name} at=${at}`;
}

// ---- kernel overhead ----
const STEP_LEDGER = 'kernel-steps.jsonl';
const TASK_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/;
function step(root, opts, deps = {}) {
  if (!opts.task || !TASK_RE.test(opts.task)) throw new LayerError('USAGE', '--task needs a task id');
  if (!opts.step || !/^[a-z][a-z0-9-]{0,39}$/.test(opts.step)) throw new LayerError('USAGE', '--step needs a short lowercase name (lock, evidence, validator, gate, ...)');
  const cls = opts.class || 'kernel';
  if (!['kernel', 'certification'].includes(cls)) throw new LayerError('USAGE', '--class is kernel or certification');
  if (!opts.command || !opts.command.length) throw new LayerError('USAGE', 'step needs a command after --');
  const settings = opts.settings || loadSettings(root);
  const started = Date.now();
  const r = (deps.spawnSync || spawnSync)(opts.command[0], opts.command.slice(1), { stdio: 'inherit', windowsHide: true });
  const ended = Date.now();
  const exitCode = r.error ? null : r.status;
  appendLine(path.join(runtimeOf(root, settings), STEP_LEDGER), { schema: 'kernel-step/1', task: opts.task, step: opts.step, class: cls, startedAt: new Date(started).toISOString(), endedAt: new Date(ended).toISOString(), seconds: Math.round((ended - started) / 100) / 10, exitCode });
  return exitCode === null ? 1 : exitCode;
}
function overhead(root, opts) {
  if (!opts.task || !TASK_RE.test(opts.task)) throw new LayerError('USAGE', '--task needs a task id');
  const settings = opts.settings || loadSettings(root);
  const now = opts.now || Date.now();
  const runtime = runtimeOf(root, settings);
  // A step counts only on its own printed duration; a step without one is unmeasured, never 0 seconds. A total with an
  // unmeasured step is a named lower bound (kernel>=, share>=): its verdict is over when the bound already passes the
  // target and unknown otherwise, never ok. The wall time is the known interval of the task: every launch and every own
  // step, measured or not, by its start and end; a step whose interval is not known leaves the wall time, and so the
  // share, unknown (never the interval of the measured part alone).
  let own = [];
  let steps = [];
  let unmeasured = 0;
  let unmeasuredCert = 0;
  try {
    own = fs.readFileSync(path.join(runtime, STEP_LEDGER), 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(s => s && s.task === opts.task);
    const measured = s => typeof s.seconds === 'number' && Number.isFinite(s.seconds) && s.seconds >= 0;
    steps = own.filter(measured);
    unmeasured = own.length - steps.length;
    unmeasuredCert = own.filter(s => !measured(s) && s.class === 'certification').length;
  }
  catch (e) { if (e.code !== 'ENOENT') throw new LayerError('LEDGER_UNREADABLE', e.code || e.message); }
  const { launches } = readLaunches(runtime);
  const mine = launches.filter(e => (taskOf(e) || '').toLowerCase() === opts.task.toLowerCase());
  const interval = s => {
    const start = typeof s.startedAt === 'string' ? Date.parse(s.startedAt) : NaN;
    const end = typeof s.endedAt === 'string' ? Date.parse(s.endedAt) : NaN;
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? { start, end } : null;
  };
  const known = own.map(interval);
  const starts = [...mine.map(e => Date.parse(recOf(e).startedAt)), ...known.filter(Boolean).map(i => i.start)].filter(Number.isFinite);
  const ends = [...mine.map(e => (e.terminal ? Date.parse(e.terminal.endedAt) : now)), ...known.filter(Boolean).map(i => i.end)].filter(Number.isFinite);
  if (!starts.length) return { task: opts.task, data: false, line: `OVERHEAD task=${opts.task} no-data (no launch with this task and no metered step)` };
  const wall = known.includes(null) ? null : Math.max(1, (Math.max(...ends) - Math.min(...starts)) / 1000);
  const kernel = steps.filter(s => s.class !== 'certification').reduce((a, s) => a + Number(s.seconds), 0);
  const cert = steps.filter(s => s.class === 'certification').reduce((a, s) => a + Number(s.seconds), 0);
  const share = wall === null ? null : Math.round((kernel / wall) * 1000) / 1000;
  const unmeasuredKernel = unmeasured - unmeasuredCert;
  const verdict = share === null ? 'unknown' : share > settings.overhead.targetMax ? 'over' : !unmeasuredKernel && share <= settings.overhead.targetMax ? 'ok' : 'unknown';
  const bound = n => (n ? '>=' : '=');
  const byStep = {};
  for (const s of steps.filter(x => x.class !== 'certification')) byStep[s.step] = Math.round(((byStep[s.step] || 0) + Number(s.seconds)) * 10) / 10;
  return { task: opts.task, data: true, wallSeconds: wall === null ? null : Math.round(wall), kernelSeconds: Math.round(kernel * 10) / 10, certificationSeconds: Math.round(cert * 10) / 10, share, partial: { kernel: unmeasuredKernel > 0, certification: unmeasuredCert > 0 }, target: [settings.overhead.targetMin, settings.overhead.targetMax], verdict, byStep, launches: mine.length, steps: steps.length, unmeasuredSteps: unmeasured,
    line: `OVERHEAD task=${opts.task} wall=${wall === null ? 'unknown' : `${Math.round(wall)}s`} kernel${bound(unmeasuredKernel)}${Math.round(kernel * 10) / 10}s share${share === null ? '=unknown' : `${bound(unmeasuredKernel)}${share}`} target=${settings.overhead.targetMin}-${settings.overhead.targetMax} status=${verdict} certification${bound(unmeasuredCert)}${Math.round(cert * 10) / 10}s (counted separately) launches=${mine.length} steps=${steps.length}${unmeasured ? ` unmeasured=${unmeasured}` : ''}` };
}

// ---- CLI ----
function parseArgs(argv) {
  const o = { _: [] };
  const flags = new Set(['--json', '--ack', '--dry', '--test', '--all']);
  const valued = new Set(['--root', '--name', '--by', '--before', '--task', '--step', '--class', '--limit']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o.command = argv.slice(i + 1); break; }
    if (flags.has(a)) o[a.slice(2)] = true;
    else if (valued.has(a)) { if (i + 1 >= argv.length) return { error: `${a} needs a value` }; o[a.slice(2)] = argv[++i]; }
    else return { error: `unknown argument ${a}` };
  }
  return o;
}
function main(argv, log = s => process.stdout.write(`${s}\n`), deps = {}) {
  const cmd = argv[0];
  const o = parseArgs(argv.slice(1));
  const cmds = ['status', 'tick', 'silence', 'accept', 'step', 'overhead', 'alerts', 'settings'];
  if (!cmds.includes(cmd) || o.error) {
    log(`usage: layer.cjs ${cmds.join('|')} [--root DIR] ...${o.error ? ` (${o.error})` : ''}`);
    log(`  status [--json] [--all]: by default alive, stalled and dead launches, every pending handoff and launches that exited in the last ${RECENT_EXIT_HOURS} hours; --all prints the full history`);
    return 2;
  }
  const root = mainRoot(path.resolve(o.root || process.cwd()));
  try {
    if (cmd === 'settings') { log(JSON.stringify(loadSettings(root), null, 2)); return 0; }
    if (cmd === 'status') {
      const settings = loadSettings(root);
      const { rows, bounds } = launchRows(root, settings, deps);
      const shown = shownRows(rows, { all: o.all, now: deps.now ?? Date.now() });
      const filter = o.all ? 'all' : `default(alive,stalled,dead,pending,exited-within-${RECENT_EXIT_HOURS}h)`;
      if (o.json) { log(JSON.stringify({ schema: 'operator-status/1', root, filter, bounds, rows: shown, counts: counts(rows) }, null, 2)); return 0; }
      for (const r of shown) log(rowLine(r));
      const c = counts(rows);
      log(`RESULT exit=0 launches=${rows.length} shown=${shown.length} alive=${c.alive} stalled=${c.stalled} dead=${c.dead} handoffPending=${c.pending} filter=${filter} ${boundsLine(bounds)}`);
      return 0;
    }
    if (cmd === 'tick') {
      const r = tick(root, { ack: o.ack });
      if (o.json) log(JSON.stringify(r)); else for (const l of r.lines) log(l);
      return r.verdict === 'ERROR' ? 1 : 0;
    }
    if (cmd === 'silence') { const r = silence(root, { dry: o.dry, test: o.test }); for (const l of r.lines) log(l); return r.code; }
    if (cmd === 'accept') { log(accept(root, { name: o.name, by: o.by, before: o.before })); return 0; }
    if (cmd === 'step') return step(root, { task: o.task, step: o.step, class: o.class, command: o.command });
    if (cmd === 'overhead') { const r = overhead(root, { task: o.task }); log(o.json ? JSON.stringify(r, null, 2) : r.line); return 0; }
    if (cmd === 'alerts') {
      const settings = loadSettings(root);
      let lines = [];
      try { lines = fs.readFileSync(path.join(runtimeOf(root, settings), 'operator-alerts.jsonl'), 'utf8').split('\n').filter(Boolean); } catch { /* none */ }
      const n = Math.max(1, Math.min(200, Number(o.limit) || 10));
      for (const l of lines.slice(-n)) { let a = null; try { a = JSON.parse(l); } catch { /* a torn line */ } if (a) log(`${a.at} ${a.line}`); }
      log(`RESULT exit=0 alerts=${lines.length}`);
      return 0;
    }
  } catch (e) {
    log(`${e instanceof LayerError ? 'REFUSED' : 'ERROR'} ${e.message}`);
    return e instanceof LayerError && e.code === 'USAGE' ? 2 : 1;
  }
  return 2;
}

module.exports = { DEFAULTS, LayerError, parseSettings, loadSettings, readManifest, mainRoot, launchRows, shownRows, rowLine, counts, routeKey, routeStats, p90, idleThreshold, parseTable, parseCard, resolveBacklog, readBacklog, reviewVerdicts, lastChange, lastCommit, treeFacts, gitDirs, tick, silence, notify, toast, accept, step, overhead, main, TICK_LAST, TICK_STATE };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

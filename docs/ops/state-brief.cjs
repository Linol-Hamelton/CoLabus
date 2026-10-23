'use strict';
// state-brief: one compact, read-only status page for the owner and the operator session. It replaces 5-8 separate checks.
//
//   node docs/ops/state-brief.cjs [--now <UTC>] [--root <dir>] [--registry <file>] [--launches <file>] [--pending <dir>]
//                                 [--stats-dir <dir>] [--tasks-snapshot <file>] [--tasks <name,name>] [--no-advisory]
//
// Output (stdout), in this order:
//   1. the brief: a fenced ```brief block = the volatile envelope line `== state-brief <UTC> ==` followed by the
//      deterministic payload (tree, registry-open, launches, tasks, freshness, unknowns). This is the F-BRIEF wire form
//      read by `node .ai/bin/protocol-core.cjs artifact-lint` (.ai/core/schema/artifact.schema.md, B-L06/B-L18/B-L24);
//   2. WARN lines (freshness stale T1/T2, optional sources Unknown): advisory, they never raise the exit code;
//   3. the advisory human view (sections: head, wrapper launches, owner channel, cube, cards), unless --no-advisory.
//
// Contract: standalone ADVISORY ops code, Class B.
//   R-IN-1  inputs are repo-state only: git, the candidate registry, the LAUNCHES channel (launch-record/1), the STATS reports,
//           and one read-only observation of the scheduled tasks. RUNS and LAUNCHES are never mixed.
//   R-IN-2  SAME frozen inputs -> SAME payload bytes. Only the envelope is volatile.
//   R-IN-4  every external observation (registry file, launch channel, tasks) is captured with a source-hash; the capture
//           time is provenance (advisory section), never a payload value. Nothing under .ai/runtime is approved truth.
//   R-IN-5  time inside the payload comes only from an explicit input: --now or STATE_BRIEF_NOW. Without it the
//           time-dependent verdicts (freshness T2, stale launches) are Unknown, never computed from the live clock.
//   R-IN-6  a missing REQUIRED source (git tree, registry, launch channel, tasks observation) is the P-L0-002 stop card and
//           exit 2; Unknown never satisfies a required input, nothing is imputed.
//   R-IN-3  no secrets, no env values, no raw diagnostics are printed.
//   R-OUT-1 an unreadable optional source prints Unknown / [UNAVAILABLE] and is listed under `unknowns`.
//   R-OUT-3 the home of the brief is stdout; the producer persists nothing. The caller that redirects it is the named writer.
//           The id `brief` stays PROPOSED (issued only through P-L0-001); this helper is not that artifact.
// Exit: 0 brief printed (WARN never raises it); 2 unusable input (named error on stderr, never a guessed value), a missing
//       required source (stop card on stdout), or a usage error. The brief being printed is not an acceptance (R-OUT-2).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SCRIPT_REPO = path.resolve(__dirname, '..', '..');
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const LIVE = new Set(['building', 'ready', 'certifying', 'certified']);
const DEAD = new Set(['landed', 'retired', 'void', 'superseded']);
const STATUSES = [...LIVE, ...DEAD];
const STALE_HOURS = 24;                 // a launch record still running this long after its start is reported stale
const EVERY_RECORDS = 30;               // T1 and T2 of PROTO-DEC-0167 item 3 (launch-stats.cjs due uses the same numbers)
const EVERY_DAYS = 7;
const STATS_MARKER = /<!-- stats-report launches=(\d+) generated=(\S+) -->/;
const SNAPSHOT_SCHEMA = 'state-brief-observation/1';
const DEFAULT_TASKS = ['ColabsOperatorCodexTick', 'ColabsListenerKeepalive', 'ColabsOwnerAnswersTick'];
const LAUNCHES_REL = path.join('docs', 'product', 'launch-records', 'launches');
// An installed project (docs/ops/pilot-install.cjs) names its own scheduled tasks here; the file is absent in the source checkout,
// where DEFAULT_TASKS stays the answer. Shape: {"schema":"pilot-profile/1","stateBrief":{"tasks":["name", ...]}} (an empty list = no scheduled tasks).
const PROFILE_REL = path.join('docs', 'ops', 'pilot-profile.json');

class InputError extends Error { constructor(input, message) { super(message); this.input = input; } }
class MissingSource extends Error { constructor(source, where) { super(`required source missing: ${source}`); this.source = source; this.where = where; } }

// An I/O failure is reported by its stable code (EBUSY, EPERM, EACCES, ENOENT, EISDIR, ...), never by a stack trace or a raw message.
const reason = e => (e && typeof e.code === 'string' && /^E[A-Z0-9_]+$/.test(e.code) ? e.code : 'EIO');
// Read a REQUIRED input (R-IN-6): a file that vanished is the stop card, any other failure is a named exit-2 input error.
function readRequired(file, input, enc) {
  try { return fs.readFileSync(file, enc); } catch (e) {
    if (reason(e) === 'ENOENT') throw new MissingSource(input, file);
    throw new InputError(input, `${path.basename(file)} cannot be read: reason=${reason(e)}`);
  }
}
function listRequired(dir, input) {
  try { return fs.readdirSync(dir); } catch (e) { throw new InputError(input, `${path.basename(dir)} cannot be listed: reason=${reason(e)}`); }
}

const sha12 = text => `sha256:${crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)}`;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const utcSeconds = d => d.toISOString().replace(/\.\d{3}Z$/, 'Z');

function usage() {
  return ['usage: node docs/ops/state-brief.cjs [--now <YYYY-MM-DDTHH:MM:SSZ>] [--root <dir>] [--registry <file>] [--launches <file>]',
    '       [--pending <dir>] [--stats-dir <dir>] [--tasks-snapshot <file>] [--tasks <name,name>] [--no-advisory]'].join('\n');
}

function parseArgs(argv) {
  const o = { advisory: true };
  const valued = ['--now', '--root', '--registry', '--launches', '--pending', '--stats-dir', '--tasks-snapshot', '--tasks'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-advisory') o.advisory = false;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (valued.includes(a)) {
      if (i + 1 >= argv.length) throw new InputError('usage', `${a} needs a value`);
      o[a.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = argv[++i];
    } else throw new InputError('usage', `unknown option ${a}`);
  }
  return o;
}

// The time input (R-IN-5): --now, else STATE_BRIEF_NOW, else none. Strict form; a value outside it is refused, never guessed.
function timeInput(o) {
  const raw = o.now !== undefined ? o.now : (process.env.STATE_BRIEF_NOW || '');
  if (!raw) return null;
  const m = raw.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d{1,3})?Z$/);
  const ms = m ? Date.parse(`${m[1]}Z`) : NaN;
  if (!m || Number.isNaN(ms)) throw new InputError('now', `${o.now !== undefined ? '--now' : 'STATE_BRIEF_NOW'} must be an ISO-8601 UTC time of the form YYYY-MM-DDTHH:MM:SSZ, got "${raw}"`);
  return { iso: `${m[1]}Z`, ms, from: o.now !== undefined ? '--now' : 'STATE_BRIEF_NOW' };
}

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', timeout: 20000, windowsHide: true });
  return { ok: r.status === 0 && !r.error, out: (r.stdout || '').trim() };
}
// The main checkout above a worktree: the live registry and the runtime observations live there (ops-guard.cjs mainRoot).
function mainRoot(root) {
  const r = git(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  return r.ok && r.out ? path.resolve(r.out, '..') : path.resolve(root);
}

// ---- payload sources -------------------------------------------------------------------------

function readTree(root) {
  const sha = git(root, ['rev-parse', 'HEAD']);
  if (!sha.ok || !/^[0-9a-f]{40}$/.test(sha.out)) throw new MissingSource('tree', `${root} is not a git checkout with a commit (git rev-parse HEAD failed)`);
  const branch = git(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const status = git(root, ['status', '--short']);
  if (!status.ok) throw new MissingSource('tree', `git status failed in ${root}`);
  const dirty = status.out.split('\n').filter(Boolean).length;
  return { value: `${branch.ok && branch.out ? branch.out : 'HEAD'} ${sha.out} ${dirty ? `dirty:${dirty}` : 'clean'}`, dirty };
}

// The candidate registry (docs/ops/CANDIDATES-TEMPLATE.md; the same row grammar ops-guard.cjs reads). A stream is open while
// its latest row is live; a later dead row closes it. Rows outside the grammar are refused (exit 2), never skipped.
function readRegistry(file) {
  if (!fs.existsSync(file)) throw new MissingSource('registry', file);
  const buf = readRequired(file, 'registry');
  const open = new Map();
  let parsed;
  try { parsed = require('../../.ai/bin/lib/candidate-registry.cjs').parseRegistry(buf); }
  catch (e) {
    if (e.code !== 'invalid-registry') throw e;
    throw new InputError('registry', `invalid-registry${e.reason ? ': ' + e.reason : ''}`);
  }
  parsed.rows.forEach(({ cells }) => {
    const [stream, , sha, , status] = cells;
    if (DEAD.has(status)) open.delete(stream);
    else open.set(stream, `${stream}@${sha.slice(0, 8)} ${status}`);
  });
  const items = [...open.values()].sort(cmp);
  return { value: `${items.length}: ${items.join('; ') || 'none'} src=${sha12(buf)}`, count: items.length, rowCount: parsed.rows.length };
}

function readJsonl(file) {
  const out = [];
  readRequired(file, 'launches', 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try { out.push(JSON.parse(line)); } catch { throw new InputError('launches', `${path.basename(file)}:${i + 1} invalid JSON`); }
  });
  return out;
}

// The LAUNCHES channel only (launch-record/1; PROTO-DEC-0167). One launch = its start record joined with its finished event
// by launchId, as launch-stats.cjs joins them. The pending buffer, when present, is part of the same channel.
function readLaunches(file, pendingDir, time) {
  if (!fs.existsSync(file)) throw new MissingSource('launches', file);
  const parts = [{ name: path.basename(file), text: readRequired(file, 'launches', 'utf8') }];
  if (pendingDir && fs.existsSync(pendingDir)) {
    for (const n of listRequired(pendingDir, 'launches').filter(n => n.endsWith('.jsonl')).sort(cmp)) parts.push({ name: `pending/${n}`, text: readRequired(path.join(pendingDir, n), 'launches', 'utf8') });
  }
  const hash = sha12(parts.map(p => `${p.name}\n${p.text}`).join('\n'));
  const by = new Map();
  const recs = readJsonl(file);
  for (const n of parts.slice(1)) recs.push(...readJsonl(path.join(pendingDir, n.name.slice('pending/'.length))));
  for (const r of recs) {
    if (!r || typeof r.launchId !== 'string') continue;
    const l = by.get(r.launchId) || { id: r.launchId };
    if (r.event === 'finished') l.fin = r;
    else if (r.event !== 'review') l.start = r;
    by.set(r.launchId, l);
  }
  const launches = [...by.values()].filter(l => l.start);
  const running = launches.filter(l => !l.fin && !l.start.endedAt);
  const unknowns = [];
  let stale;
  if (!time) { stale = 'Unknown'; unknowns.push('launches.stale(no time input)'); } else {
    let bad = false; let n = 0;
    for (const l of running) {
      const ms = Date.parse(l.start.startedAt);
      if (Number.isNaN(ms)) bad = true; else if (time.ms - ms >= STALE_HOURS * 3600000) n++;
    }
    if (bad) { stale = 'Unknown'; unknowns.push('launches.stale(unparsable startedAt)'); } else stale = String(n);
  }
  const ended = launches.filter(l => (l.fin && l.fin.endedAt) || l.start.endedAt)
    .map(l => ({ id: l.id, at: (l.fin && l.fin.endedAt) || l.start.endedAt, exit: l.fin && l.fin.exitCode !== undefined ? l.fin.exitCode : l.start.exitCode }))
    .sort((a, b) => cmp(b.at, a.at) || cmp(a.id, b.id));
  const last = ended[0] ? `last-ended=${ended[0].id} exit=${ended[0].exit === null || ended[0].exit === undefined ? 'Unknown' : ended[0].exit}` : 'last-ended=none';
  if (ended[0] && (ended[0].exit === null || ended[0].exit === undefined)) unknowns.push('launches.last-ended.exit(not recorded)');
  return { value: `running=${running.length} stale=${stale} ${last} src=${hash}`, count: launches.length, unknowns };
}

// The scheduled tasks: a read-only observation (R-IN-4). Either an injected snapshot file (frozen observation, its own capture
// time) or one live capture through the ScheduledTasks module. The observation is advisory provenance, never approved truth.
function readProfileTasks(root) {
  const file = path.join(root, PROFILE_REL);
  const shown = PROFILE_REL.split(path.sep).join('/');
  if (!fs.existsSync(file)) return null;
  let p;
  try { p = JSON.parse(readRequired(file, 'pilot-profile', 'utf8')); } catch (e) {
    if (e instanceof InputError || e instanceof MissingSource) throw e;
    throw new InputError('pilot-profile', `${shown} is not valid JSON`);
  }
  const t = p && p.schema === 'pilot-profile/1' && p.stateBrief && p.stateBrief.tasks;
  if (!Array.isArray(t) || t.some(n => typeof n !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(n))) {
    throw new InputError('pilot-profile', `${shown}: schema must be pilot-profile/1 with stateBrief.tasks, an array of task names`);
  }
  return t;
}
function readTasks(o, envelopeIso, profileTasks = null) {
  let tasks; let capturedAt; let source;
  if (o.tasksSnapshot) {
    if (!fs.existsSync(o.tasksSnapshot)) throw new MissingSource('tasks', o.tasksSnapshot);
    let snap;
    const text = readRequired(o.tasksSnapshot, 'tasks-snapshot', 'utf8');
    try { snap = JSON.parse(text); } catch { throw new InputError('tasks-snapshot', `${o.tasksSnapshot} is not valid JSON`); }
    if (!snap || snap.schema !== SNAPSHOT_SCHEMA) throw new InputError('tasks-snapshot', `${o.tasksSnapshot}: schema must be ${SNAPSHOT_SCHEMA}`);
    if (!snap.tasks || typeof snap.tasks !== 'object' || Array.isArray(snap.tasks) || Object.values(snap.tasks).some(v => typeof v !== 'string' || !v)) {
      throw new InputError('tasks-snapshot', `${o.tasksSnapshot}: tasks must be an object of non-empty string states`);
    }
    if (typeof snap.capturedAt !== 'string' || !UTC.test(snap.capturedAt)) throw new InputError('tasks-snapshot', `${o.tasksSnapshot}: capturedAt must be a UTC time YYYY-MM-DDTHH:MM:SSZ`);
    tasks = snap.tasks; capturedAt = snap.capturedAt; source = `${typeof snap.source === 'string' && snap.source ? snap.source : 'snapshot'} (snapshot ${path.basename(o.tasksSnapshot)})`;
  } else {
    const names = (o.tasks ? o.tasks.split(',').map(s => s.trim()).filter(Boolean) : (profileTasks || DEFAULT_TASKS));
    if (!names.length && o.tasks) throw new InputError('tasks', '--tasks needs at least one task name');
    for (const n of names) if (!/^[A-Za-z0-9_.-]+$/.test(n)) throw new InputError('tasks', `task name "${n}" is outside [A-Za-z0-9_.-]`);
    tasks = {};
    for (const n of names) {
      // schtasks prints in the OEM code page; the ScheduledTasks module returns the English state name (Ready, Disabled, Running)
      const r = spawnSync('powershell', ['-NoProfile', '-Command', `$t = Get-ScheduledTask -TaskName '${n}' -ErrorAction SilentlyContinue; if ($t) { [string]$t.State } else { 'not installed' }`],
        { encoding: 'utf8', timeout: 20000, windowsHide: true });
      const state = r.status === 0 && !r.error ? (r.stdout || '').trim() : '';
      if (!state) throw new MissingSource('tasks', `live capture of scheduled task ${n} failed (Get-ScheduledTask unavailable); pass --tasks-snapshot <file>`);
      tasks[n] = state;
    }
    capturedAt = envelopeIso; source = names.length ? 'Get-ScheduledTask (live capture)' : `${PROFILE_REL.split(path.sep).join('/')} (no scheduled tasks named)`;
  }
  const lines = Object.keys(tasks).sort(cmp).map(k => `${k}=${tasks[k]}`);
  return { value: `${lines.join('; ') || 'none'} src=${sha12(lines.join('\n') + '\n')}`, capturedAt, source };
}

// Freshness of the launch statistics against the triggers of PROTO-DEC-0167 item 3. T1 is a count and needs no time;
// T2 needs the time input; T3/T4 are event triggers (a decision, a landing) and are not computable here.
function readFreshness(statsDir, launchCount, time) {
  let last = null;
  const unreadable = [];   // OPTIONAL source: any failure here is Unknown plus a WARN naming the source, never an error (R-OUT-1)
  if (statsDir && fs.existsSync(statsDir)) {
    let names = [];
    try { names = fs.readdirSync(statsDir).filter(n => /^STATS-.*\.md$/.test(n)).sort(cmp); } catch (e) { unreadable.push({ name: `${path.basename(statsDir)}/`, why: reason(e) }); }
    for (const name of names) {
      let text;
      try { text = fs.readFileSync(path.join(statsDir, name), 'utf8'); } catch (e) { unreadable.push({ name, why: reason(e) }); continue; }
      const m = text.match(STATS_MARKER);
      if (!m) continue;
      const ts = Date.parse(m[2]);
      if (!Number.isFinite(ts)) continue;
      if (!last || ts > last.ts || (ts === last.ts && cmp(name, last.file) > 0)) last = { file: name, launches: Number(m[1]), generated: m[2], ts };
    }
  }
  const unknowns = []; const warns = [];
  if (unreadable.length) {
    // the newest report cannot be established, so no freshness verdict is derived from the readable remainder
    for (const u of unreadable) {
      unknowns.push(`freshness.stats(${u.name} unreadable ${u.why})`);
      warns.push(`WARN freshness Unknown: optional source ${u.name} cannot be read (reason=${u.why}); T1/T2 not evaluated; advisory, not a block`);
    }
    return { value: 'Unknown T1=Unknown T2=Unknown report=unreadable', unknowns, warns, days: null };
  }
  if (!last) {
    warns.push('WARN freshness stale: no stats report with a stats-report marker (T1/T2 not evaluable; launch-stats.cjs due says YES)');
    return { value: 'stale T1=no-report T2=no-report report=none', unknowns, warns };
  }
  const threshold = last.launches + EVERY_RECORDS;
  const t1 = launchCount >= threshold;
  const t1Text = t1 ? `yes(${launchCount}>=${threshold})` : `no(${launchCount}<${threshold})`;
  let t2Text; let t2 = false;
  if (!time) { t2Text = 'Unknown'; unknowns.push('freshness.T2(no time input)'); } else {
    const days = (time.ms - last.ts) / 86400000;
    t2 = days >= EVERY_DAYS && launchCount - last.launches >= 1;
    t2Text = t2 ? 'yes' : 'no';
  }
  const verdict = t1 || t2 ? 'stale' : (t2Text === 'Unknown' ? 'Unknown' : 'fresh');
  if (launchCount < last.launches) warns.push(`WARN freshness scope: the launch channel read here holds ${launchCount} launches, fewer than the ${last.launches} counted by ${last.file}; the report's scope (for example a pending buffer) is not in this tree, T1 is evaluated on what is here`);
  if (t1) warns.push(`WARN freshness stale: T1 ${launchCount} launches >= ${threshold} (last report ${last.file} at ${last.launches}); advisory, not a block (PROTO-DEC-0167 item 5)`);
  if (t2) warns.push(`WARN freshness stale: T2 ${((time.ms - last.ts) / 86400000).toFixed(1)} days since ${last.file} (${last.generated}) with new launches; advisory, not a block`);
  if (t2Text === 'Unknown') warns.push('WARN freshness T2 not evaluated: no time input (--now or STATE_BRIEF_NOW); the live clock never enters the payload (R-IN-5)');
  return { value: `${verdict} T1=${t1Text} T2=${t2Text} report=${last.file}`, unknowns, warns, days: time ? (time.ms - last.ts) / 86400000 : null };
}

// ---- the stop card (P-L0-002, five blocks) -------------------------------------------------------

function stopCard(err, envelopeIso) {
  return [
    `STOP-QUESTION state-brief ${envelopeIso} (the caller's journal entry is the signal line)`,
    `1. Context: docs/ops/state-brief.cjs collecting the brief payload (the brief contract); about to read the required source "${err.source}".`,
    `2. Problem: tool blocked / required input missing: ${err.message} at ${err.where}. Unknown does not satisfy a required input (R-IN-6); nothing is imputed and no brief is printed.`,
    `3. Options: (a) restore the source or point the tool at it (--registry, --launches, --tasks-snapshot, --root): gain a complete brief, risk none. (b) print a brief with "${err.source}" as Unknown: refused by the contract (R-IN-6, R-OUT-1), risk a brief that reads as complete. (c) declare the source optional: an owner word on the contract, not a tool switch.`,
    '4. Recommendation: (a). The tool does not act on it.',
    `5. Waiting for: the path of the required source "${err.source}", or the owner's word that it is optional.`,
    '',
  ].join('\n');
}

// ---- the advisory human view ------------------------------------------------------------------

function advisory(root, main, ctx) {
  const run = (cmd, args, cwd = root) => { const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 20000, windowsHide: true }); return r.status === 0 && !r.error ? (r.stdout || '').trim() : '[UNAVAILABLE]'; };
  const out = [];
  const say = s => out.push(s);
  say('# advisory (not part of the payload; no acceptance inferred)');
  say(`head: ${run('git', ['log', '--format=%h %s', '-3']).split('\n').map(l => l.slice(0, 90)).join(' | ')}`);
  say(`observation: tasks captured ${ctx.tasks.capturedAt} source=${ctx.tasks.source}; read-only observer data, .ai/runtime is never approved truth (R-IN-4)`);
  say(`registry source: ${ctx.registryPath} (runtime observation; advisory/provenance)`);
  say(`time input: ${ctx.time ? `${ctx.time.from} ${ctx.time.iso}` : 'none (live envelope only; T2 and stale launches not evaluated)'}`);
  if (ctx.freshness.days !== null && ctx.freshness.days !== undefined) say(`stats report age: ${ctx.freshness.days.toFixed(1)} days at the time input`);

  // live launches by the wrapper (runtime markers; a process result, not a review verdict)
  const wrapper = path.join(root, 'docs', 'ops', 'launch-wrapper.cjs');
  const st = fs.existsSync(wrapper) ? run(process.execPath, [wrapper, 'status']).split('\n').filter(l => /^(RUNNING|DONE|FAILED)/.test(l)) : [];
  const running = st.filter(l => l.startsWith('RUNNING') && /alive=true/.test(l));
  const staleMarkers = st.filter(l => l.startsWith('RUNNING') && !/alive=true/.test(l)).length;
  say(`running launches (wrapper, ${running.length}): ${running.map(l => l.split(/\s+/)[1] + ' since ' + ((l.match(/started=(\S+)/) || [])[1] || '').slice(11, 16)).join('; ') || (fs.existsSync(wrapper) ? 'none' : '[UNAVAILABLE]')}`);
  if (staleMarkers) say(`stale running markers: ${staleMarkers} (need wrapper watch; no successful progress inferred)`);
  const recent = st.filter(l => !l.startsWith('RUNNING')).sort((a, b) => ((b.match(/ended=(\S+)/) || [])[1] || '').localeCompare((a.match(/ended=(\S+)/) || [])[1] || '')).slice(0, 5);
  say(`last ended process result (exit0/exit-failed; not a review verdict): ${recent.map(l => { const f = l.split(/\s+/); return `${f[0] === 'DONE' ? 'exit0' : 'exit-failed'} ${f[1]} ${(l.match(/ended=\S{11}(\S{5})/) || [])[1]}`; }).join('; ') || 'none'}`);

  // owner channel (runtime of the main checkout)
  const ans = path.join(main, '.ai', 'runtime', 'owner-answers.jsonl');
  try { say(`owner answers rows: ${fs.readFileSync(ans, 'utf8').split('\n').filter(Boolean).length}`); } catch { say('owner answers: not readable'); }
  const lerr = path.join(main, '.ai', 'runtime', 'listener.err.log');
  try { const t = fs.readFileSync(lerr, 'utf8').split('\n').filter(Boolean).slice(-1)[0] || ''; const kind = !t ? 'none' : /409|Conflict/i.test(t) ? 'CONFLICT_409' : /401|403|unauthorized|forbidden/i.test(t) ? 'AUTH' : /429|quota/i.test(t) ? 'QUOTA' : 'ERROR_PRESENT'; say(`listener last error class: ${kind} (raw diagnostic suppressed)`); } catch { say('listener log: unavailable'); }

  // cube: experts write into their OWN worktrees (sibling worktrees), so count across all of them. The worktree directory is the
  // sibling <main checkout name>WT of the repository (<project>WT); env STATE_BRIEF_CUBE_DIR overrides.
  const cubeRel = path.join('docs', 'cube');
  const wtDir = process.env.STATE_BRIEF_CUBE_DIR ? path.resolve(process.env.STATE_BRIEF_CUBE_DIR) : path.join(path.dirname(main), `${path.basename(main)}WT`);
  let wts = []; try { wts = fs.readdirSync(wtDir).filter(d => d.startsWith('cube')).map(d => path.join(wtDir, d)); } catch { /* none */ }
  const cnt = d => { const unique = new Set(); for (const w of wts) { try { for (const f of fs.readdirSync(path.join(w, cubeRel, d)).filter(f => f.endsWith('.md'))) { const content = fs.readFileSync(path.join(w, cubeRel, d, f), 'utf8').replace(/\r\n/g, '\n').trimEnd(); if (content.endsWith(`${d}_DONE`)) unique.add(crypto.createHash('sha256').update(content).digest('hex')); } } catch { /* missing round is not a completed artifact */ } } return unique.size; };
  const has = f => wts.some(w => fs.existsSync(path.join(w, cubeRel, f)));
  say(`cube (worktrees ${wts.length}): unique marker-complete artifacts R1 ${cnt('R1')}, R2 ${cnt('R2')}, R3 ${cnt('R3')}; marker presence does not establish acceptance; FINAL marker present ${has('FINAL.md') ? 'yes' : 'no'}, owner card present ${has('OWNER-CARD.md') ? 'yes' : 'no'}`);

  // dirty tree and cards
  say(`working tree: ${ctx.tree.dirty} changed/untracked`);
  let cards = []; try { cards = fs.readdirSync(path.join(root, 'docs', 'ops')).filter(f => /OWNER-CARD/.test(f)).sort(cmp).slice(-4); } catch { /* no docs/ops under this root */ }
  say(`latest owner cards: ${cards.join(', ') || 'none'}`);
  return out;
}

// ---- main --------------------------------------------------------------------------------------

function main(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { process.stderr.write(`ERROR input=usage ${e.message}\n${usage()}\n`); return 2; }
  if (o.help) { process.stdout.write(`${usage()}\n`); return 0; }
  let envelopeIso;
  try {
    const root = path.resolve(o.root || SCRIPT_REPO);
    const time = timeInput(o);
    envelopeIso = time ? time.iso : utcSeconds(new Date());   // the only live clock read; it never enters the payload
    const main_ = mainRoot(root);
    const registryPath = path.resolve(o.registry || path.join(main_, '.ai', 'runtime', 'CANDIDATES.md'));
    const launchesPath = path.resolve(o.launches || path.join(root, LAUNCHES_REL, 'LAUNCHES.jsonl'));
    const pendingDir = o.pending ? path.resolve(o.pending) : path.join(path.dirname(launchesPath), 'pending');
    const statsDir = path.resolve(o.statsDir || path.join(path.dirname(launchesPath), 'stats'));

    const tree = readTree(root);
    const registry = readRegistry(registryPath);
    const launches = readLaunches(launchesPath, pendingDir, time);
    const tasks = readTasks(o, envelopeIso, o.tasksSnapshot || o.tasks ? null : readProfileTasks(root));
    const freshness = readFreshness(statsDir, launches.count, time);
    const unknowns = [...launches.unknowns, ...freshness.unknowns].sort(cmp);

    const lines = ['```brief', `== state-brief ${envelopeIso} ==`,
      `tree: ${tree.value}`, `registry-open: ${registry.value}`, `launches: ${launches.value}`, `tasks: ${tasks.value}`,
      `freshness: ${freshness.value}`, `unknowns: ${unknowns.join('; ') || 'none'}`, '```'];
    const warns = [...freshness.warns];
    if (warns.length) lines.push('', ...warns);
    if (o.advisory) lines.push('', ...advisory(root, main_, { tree, tasks, registryPath, time, freshness }));
    process.stdout.write(lines.join('\n') + '\n');
    return 0;
  } catch (e) {
    if (e instanceof MissingSource) { process.stdout.write(stopCard(e, envelopeIso || utcSeconds(new Date()))); return 2; }
    if (e instanceof InputError) { process.stderr.write(`ERROR input=${e.input} ${e.message}\n`); return 2; }
    // the catch-all: any other failure is one named line and exit 2, never a stack trace and never exit 1
    process.stderr.write(`ERROR input=unexpected ${e && e.name ? e.name : 'Error'} reason=${reason(e)}\n`);
    return 2;
  }
}

module.exports = { main, readRegistry, readLaunches, readFreshness, readTasks, timeInput, STALE_HOURS, EVERY_RECORDS, EVERY_DAYS };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

'use strict';
// launch-wrapper: the one way to start a certifier, fixer or any agent session (principle K3; docs/ops/PROCESS-REGISTER.md P-02, P-03, P-05).
// run: claim the stream, run the launch gate (registry tip and pins), start the command, tee its output, and on EVERY exit path write a terminal marker
// (DONE or FAILED with exit code, the last 20 lines and a failure class) and release the claim. watch: find launches whose processes are gone without a
// terminal marker and mark them FAILED (the "died silently" case). status: list running and finished launches.
//   node docs/ops/launch-wrapper.cjs run --stream S --owner O --name N --worktree W [--ttl MIN] [--engine legacy|dispatch]
//        [--pin-files a,b] [--certifier] [--log FILE] [--no-gate] [--runtime DIR] [--registry FILE] [--claims FILE] [--repo DIR]
//        [--stall-seconds N] [--hard-seconds N] [--role R] [--tier T1..T9] [--client C --model M --effort E] -- <command> [args...]
//   node docs/ops/launch-wrapper.cjs watch [--runtime DIR] [--grace-min 5] [--now ISO] [--claims FILE] [--registry FILE] [--repo DIR]
//   node docs/ops/launch-wrapper.cjs status [--runtime DIR]
//   node docs/ops/launch-wrapper.cjs selftest
// Commit detection (P-25, K5-enf cut version, WARN-only): `run` (--worktree is mandatory, exit 2 without it) snapshots HEAD and the current branch ref of that worktree before the
// child starts and after it exits (foreign branches and tags never count); when either moved it prints `WARN agent-committed head-before=<sha> head-after=<sha> refs-changed=N` and records the fact in the terminal
// record's `note` (a launch-record/1 field). It never changes the exit code, blocks, or fails the launch; a snapshot that cannot be taken is recorded as `snapshot-unavailable`.
// Exit of `run`: the command's own exit code (1 when it was killed by a signal), 3 when the gate refused (nothing was started), 2 on usage errors.
// Exit of `watch`: 1 when it marked at least one silent death, else 0. The marker files live in the runtime directory of the MAIN checkout:
// <name>.running.json, <name>.terminal.json and <name>.marker.txt (one line `NAME_DONE exit=N end=ISO` or `NAME_FAILED exit=N class=C end=ISO`).
// --engine dispatch (P4, opt-in; the default legacy keeps the direct-spawn path untouched): the command runs through the L4 executor
// (.ai/bin/protocol-dispatch/executor.cjs executeAttempt) in a per-launch scratch git workdir, under the single liveness (idle 10 min,
// hard 120 min, wake budget 3, own output only), the identity lease (PID + creation time; the lease lives with the executor logs under
// .ai/runtime/dispatch-wrapper in the repo runtime) and the leaf-first stop. The marker, running/terminal records, claims, exit codes and
// the P-25 check keep their legacy shapes. The executor's own semantics apply unchanged: the credential-stripped child environment
// (executorEnv), the binary --version probe, the command-line safety checks and the scope stop on the scratch workdir. A kill by the
// liveness rules is a FAILED marker (exit none, class STALL or INTERRUPTED) and exit code 1, like a legacy signal kill.
// Per-launch temp isolation (, layer 2; P-68): after the gate, `run` creates <root>/<launch name> and gives the child TEMP, TMP and TMPDIR pointing at it.
// root = COLABS_TMP_ROOT when set, else <drive of the repository>:/ColabsTmp (for example <drive>:/ColabsTmp), each only when writable, else the OS temp dir (then the
// directory is named colabs-launch-<name>). The directory carries the marker .colabs-launch-tmp.json. When the child ends (any exit class, a liveness kill included) the
// wrapper removes it if it lies strictly under the root and carries its marker. After a FAILED launch it is kept for 12 hours instead (marker keepUntil) and the terminal
// record's `tempDir` field says so; docs/ops/temp-retention.cjs removes it later (it allows the same root: lib/tmp-root.cjs). A seat that cannot run delete commands therefore leaves nothing behind.
// --name is checked before anything is created (no claim, no temp dir, no file): at most 64 characters of letters, digits, dot, dash, underscore; no leading or trailing dot; no
// reserved Windows device name (exit 2). Any exception after the claim was taken still writes the terminal record, releases the claim and settles the temp dir (kills a started child).
// --stall-seconds N / --hard-seconds N (engine dispatch only, default off) replace the idle window (10 min) and the hard ceiling (120 min) of that
// run, like the same flags of protocol-dispatch.cjs run; without them the defaults above apply. They exist for short probes and for pilots that want a
// tighter idle limit; they never loosen a rule on their own, the wake budget and the own-output rule are unchanged.
// Cost record (): the failure classes of the terminal record include NO_VERDICT (cert-launch printed report=NO_VERDICT: the report has no closed
// verdict token) and TURN_LIMIT (vibe stopped on its turn limit); the last `USAGE ...` line the child printed (tokens and cost basis, cert-launch.cjs and
// fix-launch.cjs print it when the client told its tokens) is copied into the terminal record as `usage`. The wrapper itself reads no client output beyond that.
// Resolver shadow (K-002; PROTO-DEC-0143 item 3): after the gate and before the child starts, `run` asks resolver-shadow.cjs what the
// resolver would choose for the stated --role and --tier (task class) against the operator's --client/--model/--effort, and keeps the
// answer as the `resolver` field of the running and terminal records (and one line of <runtime>/resolver-shadow/). Without --tier the
// field records the error task-class-missing. It never changes the command, the exit code or the gate, and a failure never blocks.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { removeTree, inside } = require('./lib/test-tmp.cjs');
const { configuredTmpRoot, resolveTmpRoot, driveRootCandidate } = require('./lib/tmp-root.cjs');

const MAX_NAME_LENGTH = 64; // the name becomes file names (<name>.running.json.<pid>.tmp) and a directory name under the temp root
const GUARD = path.join(__dirname, 'ops-guard.cjs');
const INTERRUPTED_CODES = new Set([3221225786, 137, 143, -1073741510, 130]);
const LAUNCH_TMP_MARKER = '.colabs-launch-tmp.json';
const KEEP_FAILED_MS = 12 * 3600 * 1000;

function git(cwd, args) { const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); return { code: r.status, out: (r.stdout || '').trim() }; }
function mainRoot(repo) { const r = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']); return r.code === 0 && r.out ? path.resolve(r.out, '..') : path.resolve(repo); }

// K5-enf cut version: HEAD and the current branch ref of the launched worktree ONLY (never the shared refs directory, so a foreign branch or a tag cannot count).
// Two git commands: `rev-parse HEAD`, then `symbolic-ref -q --short HEAD` (+ `rev-parse` of that ref when attached). Detached HEAD: branch null, HEAD only.
// Returns null when git cannot answer (not a repository, unborn HEAD, no git).
function snapshot(dir) {
  try {
    const head = git(dir, ['rev-parse', 'HEAD']);
    if (head.code !== 0 || !head.out) return null;
    const sym = git(dir, ['symbolic-ref', '-q', '--short', 'HEAD']);
    if (sym.code !== 0 || !sym.out) return { head: head.out, branch: null, branchOid: null };
    const branch = `refs/heads/${sym.out}`;
    const oid = git(dir, ['rev-parse', branch]);
    return oid.code === 0 && oid.out ? { head: head.out, branch, branchOid: oid.out } : null;
  } catch { return null; }
}
// Pure: null when nothing moved, else { headBefore, headAfter, changedRefs } (changedRefs holds at most the current branch ref; empty for a detached-HEAD move).
function compareSnapshots(before, after) {
  if (!before || !after) return null;
  const headMoved = before.head !== after.head;
  const branchMoved = before.branch !== after.branch || before.branchOid !== after.branchOid;
  if (!headMoved && !branchMoved) return null;
  const changedRefs = branchMoved ? [...new Set([before.branch, after.branch].filter(Boolean))].sort().slice(0, 1) : [];
  return { headBefore: before.head, headAfter: after.head, changedRefs };
}
// null when nothing moved; the string `snapshot-unavailable` when a snapshot failed; else { line, note }.
function commitNote(before, after) {
  if (!before || !after) return 'snapshot-unavailable';
  const d = compareSnapshots(before, after);
  if (!d) return null;
  return { line: `WARN agent-committed head-before=${d.headBefore} head-after=${d.headAfter} refs-changed=${d.changedRefs.length}`, note: `agent-committed head-before=${d.headBefore} head-after=${d.headAfter} refs-changed=${d.changedRefs.join(',') || '-'}` };
}

function parseArgs(argv) {
  const o = { _: [] };
  const flags = new Set(['--certifier', '--no-gate']);
  const valued = new Set(['--stream', '--owner', '--name', '--worktree', '--ttl', '--engine', '--pin-files', '--log', '--runtime', '--registry', '--claims', '--repo', '--grace-min', '--now', '--stall-seconds', '--hard-seconds', '--role', '--tier', '--client', '--model', '--effort', '--quota-request', '--route']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o.command = argv.slice(i + 1); break; }
    if (flags.has(a)) o[a.slice(2)] = true;
    else if (valued.has(a)) o[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) return { error: `unknown option ${a}` };
    else o._.push(a);
  }
  return o;
}

function classify(exitCode, signal, text) {
  if (signal || INTERRUPTED_CODES.has(exitCode)) return 'INTERRUPTED';
  if (/^SERVED_MODEL_MISMATCH requested=/m.test(text)) return 'SERVED_MODEL_MISMATCH';
  if (/^TURN_LIMIT client=/m.test(text)) return 'TURN_LIMIT';
  if (/\breport=NO_VERDICT\b/.test(text)) return 'NO_VERDICT';
  if (/ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|loadCodeAssist|eligibility|network|\bEOF\b/i.test(text)) return 'TRANSPORT';
  if (/\b429\b|rate.?limit|quota|insufficient (credit|funds)|exhausted/i.test(text)) return 'QUOTA';
  if (/\b401\b|\b403\b|unauthori[sz]ed|invalid api key|forbidden/i.test(text)) return 'AUTH';
  return 'UNKNOWN';
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
function ensureWritable(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const probe = path.join(dir, `.probe-${process.pid}-${Date.now()}`);
  fs.writeFileSync(probe, '');
  fs.unlinkSync(probe);
}
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const alive = pid => { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function guardArgs(o, extra) {
  const a = [GUARD, ...extra];
  for (const k of ['registry', 'claims', 'repo']) if (o[k]) a.push(k === 'registry' ? '--file' : `--${k}`, o[k]);
  return a;
}
const guard = (o, extra) => spawnSync(process.execPath, guardArgs(o, extra), { encoding: 'utf8', windowsHide: true });

// ---- per-launch temp isolation ----
// The root resolution (COLABS_TMP_ROOT, else <drive>:/ColabsTmp, else the OS temp dir) lives in lib/tmp-root.cjs, shared with .
// Pure: null when the name is fit to become a file name and a directory name on every platform, else the reason it is refused.
// Refused: empty, over MAX_NAME_LENGTH, anything but letters, digits, dot, dash and underscore (so no separator, drive letter or space),
// a leading dot (`.`, `..`, `...`, `.hidden`, `..-x`), a trailing dot (Windows drops it, two names would meet), and a reserved Windows device name.
function launchNameProblem(name) {
  if (typeof name !== 'string' || !name) return '--name must not be empty';
  if (name.length > MAX_NAME_LENGTH) return `--name is longer than ${MAX_NAME_LENGTH} characters`;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) return '--name may contain letters, digits, dot, dash and underscore only';
  if (name.startsWith('.')) return '--name must not start with a dot';
  if (name.endsWith('.')) return '--name must not end with a dot';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i.test(name)) return '--name must not be a reserved Windows device name (con, prn, aux, nul, com1-9, lpt1-9)';
  return null;
}
// A fresh directory for this launch. A same-named directory (kept after an earlier failed launch) is never reused or removed here: the new one gets a suffix.
function prepareLaunchTmp(name, root, wrapperPid) {
  const bad = launchNameProblem(name);
  if (bad) throw new Error(bad);
  const leaf = root.kind === 'os-temp' ? `colabs-launch-${name}` : name;
  let dir = path.join(root.dir, leaf);
  for (let i = 0; ; i++) {
    try { fs.mkdirSync(dir); break; } catch (e) {
      if (e.code !== 'EEXIST' || i >= 20) throw e;
      dir = path.join(root.dir, `${leaf}-${Date.now().toString(36)}${i}`);
    }
  }
  writeJson(path.join(dir, LAUNCH_TMP_MARKER), { schema: 'launch-tmp/1', name, wrapperPid, createdAt: new Date().toISOString(), keepUntil: null });
  return { dir, root: root.dir, kind: root.kind, name };
}
const launchTmpEnv = lt => (lt ? { TEMP: lt.dir, TMP: lt.dir, TMPDIR: lt.dir } : {});
// Remove the launch's temp tree (success) or keep it for 12 hours (failure, or a removal that did not work). Returns the terminal record's tempDir field.
function finishLaunchTmp(lt, failed, why, nowMs = Date.now()) {
  if (!lt) return null;
  const markerFile = path.join(lt.dir, LAUNCH_TMP_MARKER);
  const marker = readJson(markerFile);
  const mine = Boolean(marker && marker.schema === 'launch-tmp/1' && marker.name === lt.name && inside(lt.dir, lt.root));
  const keep = reason => {
    const keepUntil = new Date(nowMs + KEEP_FAILED_MS).toISOString();
    if (mine) { try { writeJson(markerFile, { ...marker, keepUntil }); } catch { /* the marker stays as it was */ } }
    return { path: lt.dir, action: 'kept', reason, keepUntil };
  };
  if (!fs.existsSync(lt.dir)) return { path: lt.dir, action: 'gone', reason: null, keepUntil: null };
  if (!mine) return { path: lt.dir, action: 'kept', reason: 'not removed: the directory lost its wrapper marker or is not under the temp root', keepUntil: null };
  if (failed) return keep(`launch failed (${why}); kept for 12 hours, docs/ops/temp-retention.cjs removes it later`);
  try { removeTree(lt.dir); return { path: lt.dir, action: 'removed', reason: null, keepUntil: null }; } catch (e) { return keep(`remove failed (${e.code || e.message}); kept for 12 hours`); }
}
const tempLine = t => (t && t.action === 'kept' ? `TEMP kept ${t.path}: ${t.reason}\n` : '');

function writeTerminal(runtime, name, base, result) {
  const ended = new Date().toISOString();
  const terminal = { ...base, status: result.status, exitCode: result.exitCode, signal: result.signal || null, failureClass: result.status === 'FAILED' ? result.failureClass : null, reason: result.reason || null, endedAt: ended, wallSeconds: Math.round((Date.parse(ended) - Date.parse(base.startedAt)) / 100) / 10, lastLines: result.lastLines || [], ...(result.note ? { note: result.note } : {}), ...(result.tempDir ? { tempDir: result.tempDir } : {}), ...(result.usage ? { usage: result.usage } : {}) };
  writeJson(path.join(runtime, `${name}.terminal.json`), terminal);
  const line = terminal.status === 'DONE' ? `${name}_DONE exit=${terminal.exitCode} end=${ended}` : `${name}_FAILED exit=${terminal.exitCode === null ? 'none' : terminal.exitCode} class=${terminal.failureClass} end=${ended}`;
  fs.appendFileSync(path.join(runtime, `${name}.marker.txt`), `${line}\n`, 'utf8');
  const running = readJson(path.join(runtime, `${name}.running.json`));
  if (running) writeJson(path.join(runtime, `${name}.running.json`), { ...running, ended });
  return terminal;
}

// Everything before the claim is a pure check: a refusal here creates nothing (no claim, no temp dir, no file).
async function run(o, deps = {}) {
  for (const k of ['stream', 'owner', 'name']) if (!o[k]) { process.stderr.write(`run needs --${k}\n`); return 2; }
  const badName = launchNameProblem(o.name);
  if (badName) { process.stderr.write(`${badName}\n`); return 2; }
  if (o.engine && o.engine !== 'legacy' && o.engine !== 'dispatch') { process.stderr.write(`unknown engine ${o.engine} (legacy|dispatch)\n`); return 2; }
  for (const k of ['stall-seconds', 'hard-seconds']) {
    if (o[k] === undefined) continue;
    if (o.engine !== 'dispatch') { process.stderr.write(`--${k} needs --engine dispatch\n`); return 2; }
    const n = Number(o[k]);
    if (!o[k] || !Number.isFinite(n) || n <= 0) { process.stderr.write(`--${k} needs a positive number of seconds\n`); return 2; }
  }
  if (!o.worktree) { process.stderr.write('run needs --worktree (the agent worktree whose HEAD and current branch are watched for commits)\n'); return 2; }
  if (!o.command || !o.command.length) { process.stderr.write('run needs a command after --\n'); return 2; }
  // S5: opt-in only; OFF executes no finance code or I/O and keeps legacy output/argv.
  if (o['quota-request'] !== undefined) {
    const q = require('./quota-launch-hook.cjs').beforeLaunch(o, deps);
    if (!q || q.status !== 'allow') {
      process.stdout.write(`QUOTA ${q && q.status || 'ask-owner'} reason=${q && q.reason || 'preflight-unavailable'}\n`);
      return 3;
    }
  }
  const repo = path.resolve(o.repo || process.cwd());
  const runtime = path.resolve(o.runtime || path.join(mainRoot(repo), '.ai', 'runtime'));
  const say = s => process.stdout.write(`${s}\n`);
  let claimed = false;
  const release = () => { if (claimed) { claimed = false; guard(o, ['release', '--stream', o.stream, '--owner', o.owner]); } };
  // st: what has happened so far, so that the catch below can finish exactly what is still open (temp dir, terminal record, claim, child)
  const st = { started: false, child: null, temp: null, terminal: false, log: null, ring: [], launchTmp: null, base: { name: o.name, stream: o.stream, owner: o.owner, wrapperPid: process.pid, startedAt: new Date().toISOString(), command: o.command[0], certifier: Boolean(o.certifier) } };
  const settleTemp = (failed, why) => { if (!st.temp) st.temp = finishLaunchTmp(st.launchTmp, failed, why); return st.temp; };
  const record = result => { writeTerminal(runtime, o.name, st.base, result); st.terminal = true; };

  // Any exception after the claim was taken lands here: stop the child, settle the temp dir, write the terminal record, release the claim. Each step is
  // guarded on its own, so one failing step (for example a runtime directory that cannot be written) never skips the next.
  const abort = err => {
    const msg = (err && (err.code ? `${err.code}: ${err.message}` : err.message)) || String(err);
    try { process.stderr.write(`launch-wrapper: internal error, the launch is closed as FAILED: ${msg}\n`); } catch { /* stderr closed */ }
    if (st.child && st.child.exitCode === null && !st.child.killed) { try { st.child.kill('SIGKILL'); } catch { /* already gone */ } }
    let tempDir = st.temp;
    // a child that never started has nothing worth debugging: its temp dir goes at once; after a start it is kept 12 hours like any failed launch
    try { tempDir = settleTemp(st.started, 'WRAPPER_ERROR'); } catch (e) { tempDir = null; try { process.stderr.write(`launch-wrapper: temp dir not settled: ${e.message}\n`); } catch { /* stderr closed */ } }
    if (!st.terminal) {
      try { record({ status: 'FAILED', exitCode: null, signal: null, failureClass: 'UNKNOWN', reason: `wrapper error: ${msg}`, lastLines: st.ring.slice(), note: null, tempDir }); } catch (e) { try { process.stderr.write(`launch-wrapper: terminal record not written: ${e.message}\n`); } catch { /* stderr closed */ } }
    }
    try { release(); } catch { /* the claim expires with its ttl */ }
    try { if (st.log) st.log.end(); } catch { /* log already closed */ }
    return 1;
  };

  try {
    if (!o['no-gate']) {
      const c = guard(o, ['claim', '--stream', o.stream, '--owner', o.owner, ...(o.worktree ? ['--worktree', o.worktree] : []), '--ttl', String(o.ttl || 120)]);
      say(`${c.stdout.trim()}${c.stderr.trim()}`);
      if (c.status !== 0) { say('LAUNCH REFUSED by the claim; nothing was started'); return 3; }
      claimed = true;
      const files = (o['pin-files'] || '').split(',').filter(Boolean);
      const g = guard(o, ['launch-gate', '--stream', o.stream, '--owner', o.owner, ...files]);
      say(g.stdout.trim());
      if (g.status !== 0) { release(); say('LAUNCH REFUSED by the gate; nothing was started'); return 3; }
    }

    const startedAt = st.base.startedAt;
    try { st.launchTmp = prepareLaunchTmp(o.name, resolveTmpRoot(repo, deps.env || process.env), process.pid); } catch (e) { say(`WARN temp isolation unavailable (${e.code || e.message}); the child keeps the inherited temp dir`); }
    const launchTmp = st.launchTmp;
    let resolver = null;
    try {
      const shadowTool = deps.resolverShadow || require('./resolver-shadow.cjs');
      const sh = shadowTool.record({ launcher: 'launch-wrapper', name: o.name, launchId: null, role: o.role || null, tier: o.tier || null, stageKind: o.certifier ? 'certification' : 'other', operator: { client: o.client || null, model: o.model || null, effort: o.effort || null } }, { runtimeDir: runtime });
      resolver = { ...sh.resolver, taskClass: sh.taskClass, role: sh.role, operator: sh.operator };
    } catch (e) { resolver = { choice: null, candidates: [], reason: null, ladderVersion: null, error: 'resolver-error', detail: String((e && e.message) || e).slice(0, 200) }; }
    const base = st.base = { ...st.base, startedAt, ...(launchTmp ? { tempDir: launchTmp.dir } : {}), resolver };
    const env = { ...process.env, ...launchTmpEnv(launchTmp), LAUNCH_WRAPPER_NAME: o.name };
    if (o.certifier) env.PROTOCOL_NO_FULL_SUITE = '1';
    const snapDir = path.resolve(o.worktree);
    const snapBefore = snapshot(snapDir);
    const ring = st.ring;
    const log = st.log = o.log ? fs.createWriteStream(path.resolve(o.log), { flags: 'a' }) : null;
    // the last `USAGE ...` line of the child (cert-launch.cjs and fix-launch.cjs print one when the client told its tokens) is copied into the terminal record
    const push = chunk => { const s = String(chunk); if (log) log.write(s); process.stdout.write(s); for (const l of s.split(/\r?\n/)) if (l.trim()) { ring.push(l.slice(0, 300)); if (ring.length > 20) ring.shift(); if (/^USAGE /.test(l)) st.usageLine = l.trim().slice(0, 300); } };
    let finished = false;
    const finish = (exitCode, signal, reason) => {
      if (finished) return 1;
      finished = true;
      const text = ring.join('\n');
      const ok = exitCode === 0 && !signal;
      const detected = commitNote(snapBefore, snapshot(snapDir));
      if (detected && detected.line) { const w = `${detected.line}\n`; if (log) log.write(w); process.stdout.write(w); }
      const note = detected ? (detected.note || detected) : null;
      const failureClass = ok ? null : classify(exitCode, signal, `${text}\n${reason || ''}`);
      const tempDir = settleTemp(!ok, failureClass);
      const tl = tempLine(tempDir);
      if (tl) { if (log) log.write(tl); process.stdout.write(tl); }
      record({ status: ok ? 'DONE' : 'FAILED', exitCode, signal, failureClass, reason, lastLines: ring.slice(), note, tempDir, usage: st.usageLine });
      release();
      if (log) log.end();
      return ok ? 0 : (typeof exitCode === 'number' && exitCode !== 0 ? exitCode : 1);
    };

    if (o.engine === 'dispatch') return await engineRun({ o, deps, repo, runtime, base, snapDir, snapBefore, ring, log, push, release, launchTmp, st, settleTemp, record });
    // the running record keeps its meaning "the child exists" (consumers wait for the file and read childPid), so it is written after the spawn; a runtime directory that
    // cannot be written is found out BEFORE the child starts, by a probe file, and stops the launch while nothing runs
    ensureWritable(runtime);
    return await new Promise((resolve, reject) => {
      try {
        let child;
        try { child = (deps.spawn || spawn)(o.command[0], o.command.slice(1), { env, cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve(finish(null, null, `spawn failed: ${e.message}`)); return; }
        st.child = child;
        st.started = true;
        writeJson(path.join(runtime, `${o.name}.running.json`), { ...base, childPid: child.pid });
        child.stdout.on('data', push);
        child.stderr.on('data', push);
        child.on('error', e => { try { resolve(finish(null, null, `spawn error: ${e.code || e.message}`)); } catch (err) { reject(err); } });
        child.on('close', (code, signal) => { try { resolve(finish(code, signal, null)); } catch (err) { reject(err); } });
      } catch (e) { reject(e); }
    });
  } catch (err) {
    return abort(err);
  }
}

// ---- --engine dispatch (P4): the command runs through the L4 executor, under its liveness, lease and leaf-first stop ----

const ENGINE_STATE_DIR = '.ai/runtime/dispatch-wrapper';
// engine classes that map straight onto a launch-record/1 class; the two vocabularies are separate layers ( P5)
const ENGINE_CLASS_MAP = { AUTH_ERROR: 'AUTH', RATE_LIMIT: 'QUOTA', QUOTA_EXHAUSTED: 'QUOTA', NETWORK_ERROR: 'TRANSPORT', PROVIDER_ERROR: 'TRANSPORT' };

// launch-record/1 failure class of an engine result: STALL stays STALL, the hard ceiling is a supervisor kill (INTERRUPTED),
// a missing declared output is CONTENT, an unrecorded survivor is ORPHAN; a class the executor recognized maps directly,
// everything else keeps the legacy text classification of the child's own output.
function engineFailureClass(res, text) {
  if (!res || res.status === 'DONE') return null;
  if (res.class === 'STALL') return 'STALL';
  if (res.class === 'TIMEOUT') return 'INTERRUPTED';
  if (res.class === 'INVALID_OUTPUT') return 'CONTENT';
  if ((res.unrecordedProcesses || []).length) return 'ORPHAN';
  if (ENGINE_CLASS_MAP[res.class]) return ENGINE_CLASS_MAP[res.class];
  if (Number.isInteger(res.exitCode)) return classify(res.exitCode, null, text);
  return 'UNKNOWN';
}

// A minimal git workdir for the attempt: the executor watches it (progress, scope stop) and runs the command in it.
function prepareEngineScratch(name, baseDir) {
  const dir = fs.mkdtempSync(path.join(baseDir || os.tmpdir(), `lww-${name}-`));
  const g = args => git(dir, args);
  fs.writeFileSync(path.join(dir, 'README.md'), 'launch-wrapper engine scratch\n');
  const ok = g(['init', '-q', '-b', 'main']).code === 0 && g(['add', 'README.md']).code === 0
    && g(['-c', 'user.name=launch-wrapper', '-c', 'user.email=wrapper@example.invalid', 'commit', '-q', '-m', 'scratch']).code === 0;
  if (!ok) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} throw new Error('git scratch preparation failed'); }
  return dir;
}

async function engineRun(ctx) {
  const { o, deps, repo, runtime, base, snapDir, snapBefore, ring, log, push, release, launchTmp, st, settleTemp, record } = ctx;
  const executor = require(path.resolve(__dirname, '..', '..', '.ai', 'bin', 'protocol-dispatch', 'executor.cjs'));
  const slot = { id: `lw-${o.name}`, route: { client: 'child', model: '' } };
  const stateDir = path.resolve(repo, ENGINE_STATE_DIR);
  const logPath = path.join(stateDir, 'logs', `${slot.id}-1.log`);
  const runningPath = path.join(runtime, `${o.name}.running.json`);
  let scratch;
  try {
    scratch = prepareEngineScratch(o.name, launchTmp && launchTmp.dir);
  } catch (e) {
    record({ status: 'FAILED', exitCode: null, signal: null, failureClass: 'UNKNOWN', reason: `engine scratch failed: ${e.message}`, lastLines: [], note: null, tempDir: settleTemp(true, 'UNKNOWN') });
    release();
    if (log) log.end();
    return 1;
  }
  const registry = {
    schema: 'clients/1',
    clients: {
      child: {
        binary: o.command[0], present: true, source: 'launch-wrapper argv', command: o.command,
        model: { how: 'none', listing: null }, effort: { how: 'none', values: null, note: null },
        env: { ...launchTmpEnv(launchTmp), LAUNCH_WRAPPER_NAME: o.name, ...(o.certifier ? { PROTOCOL_NO_FULL_SUITE: '1' } : {}) },
        resume: { command: null, sessionId: null, note: 'none' }, usage: 'none', failureModes: []
      }
    }
  };
  const dispatch = { stateDir: ENGINE_STATE_DIR };
  writeJson(runningPath, { ...base, childPid: null });
  // the running record follows the engine child (the watch command checks it) and the tailer tees the engine log like the legacy pipe
  let childPid = null;
  const pidTimer = setInterval(() => {
    const lease = executor.readLease(slot.id, stateDir);
    const pid = lease && lease.attempts.length ? lease.attempts[lease.attempts.length - 1].root.pid : null;
    if (pid && pid !== childPid) {
      childPid = pid;
      const running = readJson(runningPath);
      if (running && !running.ended) writeJson(runningPath, { ...running, childPid: pid });
    }
  }, 500);
  let tailed = 0;
  const drainTail = () => {
    try {
      if (!fs.existsSync(logPath)) return;
      const size = fs.statSync(logPath).size;
      if (size <= tailed) return;
      const fd = fs.openSync(logPath, 'r');
      try {
        const buf = Buffer.alloc(size - tailed);
        const read = fs.readSync(fd, buf, 0, buf.length, tailed);
        tailed += read;
        if (read > 0) push(buf.toString('utf8', 0, read));
      } finally { fs.closeSync(fd); }
    } catch {}
  };
  const tailTimer = setInterval(drainTail, 250);
  let res;
  // the executor runs in this process: its own temp use (hooks dir, git scratch) follows os.tmpdir(), so TEMP/TMP point at the launch dir for the run
  const savedTemp = {};
  for (const [k, v] of Object.entries(launchTmpEnv(launchTmp))) { savedTemp[k] = process.env[k]; process.env[k] = v; }
  st.started = true;
  try {
    res = await executor.executeAttempt(slot, 1, dispatch, registry, {
      repoRoot: repo, workdir: scratch, sessionId: `${slot.id}-1`, message: 'launch-wrapper engine child',
      ...((deps.engineLimits && deps.engineLimits.stallSeconds) ? { stallSeconds: deps.engineLimits.stallSeconds } : (o['stall-seconds'] ? { stallSeconds: Number(o['stall-seconds']) } : {})),
      ...((deps.engineLimits && deps.engineLimits.hardSeconds) ? { hardSeconds: deps.engineLimits.hardSeconds } : (o['hard-seconds'] ? { hardSeconds: Number(o['hard-seconds']) } : {})),
      ...(deps.executorOpts || {})
    });
  } catch (e) {
    res = { status: 'FAILED', class: 'PROCESS_CRASH', reason: `engine error: ${e.message}`, exitCode: null };
  } finally {
    clearInterval(pidTimer);
    clearInterval(tailTimer);
    drainTail();
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    for (const [k, v] of Object.entries(savedTemp)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  // the running record keeps the engine root identity even after a fast attempt the poller never saw
  const lease = executor.readLease(slot.id, stateDir);
  const rootPid = lease && lease.attempts.length ? lease.attempts[lease.attempts.length - 1].root.pid : null;
  const running = readJson(runningPath);
  if (running && !running.ended) writeJson(runningPath, { ...running, childPid: rootPid });
  const ok = res.status === 'DONE';
  const exitCode = Number.isInteger(res.exitCode) ? res.exitCode : null;
  const text = ring.join('\n');
  const detected = commitNote(snapBefore, snapshot(snapDir));
  if (detected && detected.line) { const w = `${detected.line}\n`; if (log) log.write(w); process.stdout.write(w); }
  const note = detected ? (detected.note || detected) : null;
  const reason = ok ? null : `engine ${res.status}${res.class ? ` class=${res.class}` : ''}${res.reason ? `: ${res.reason}` : ''}`;
  const failureClass = ok ? null : engineFailureClass(res, `${text}\n${reason || ''}`);
  const tempDir = settleTemp(!ok, failureClass);
  const tl = tempLine(tempDir);
  if (tl) { if (log) log.write(tl); process.stdout.write(tl); }
  record({
    status: ok ? 'DONE' : 'FAILED', exitCode, signal: null,
    failureClass,
    reason, lastLines: ring.slice(), note, tempDir, usage: st.usageLine
  });
  release();
  if (log) log.end();
  return ok ? 0 : (exitCode !== null && exitCode !== 0 ? exitCode : 1);
}

function selftest() {
  const assert = require('node:assert/strict');
  const s = (head, branch, oid) => ({ head, branch: branch || null, branchOid: oid || null });
  const m = 'refs/heads/m';
  assert.equal(compareSnapshots(s('a', m, 'a'), s('a', m, 'a')), null);
  assert.deepEqual(compareSnapshots(s('a', m, 'a'), s('b', m, 'b')), { headBefore: 'a', headAfter: 'b', changedRefs: [m] });
  assert.deepEqual(compareSnapshots(s('a'), s('b')), { headBefore: 'a', headAfter: 'b', changedRefs: [] });
  assert.deepEqual(compareSnapshots(s('a', m, 'a'), s('a', m, 'b')).changedRefs, [m]);
  assert.equal(compareSnapshots(null, s('a')), null);
  assert.equal(commitNote(null, s('a')), 'snapshot-unavailable');
  assert.equal(commitNote(s('a', m, 'a'), s('a', m, 'a')), null);
  assert.equal(commitNote(s('a'), s('b')).line, 'WARN agent-committed head-before=a head-after=b refs-changed=0');
  assert.equal(engineFailureClass({ status: 'DONE', class: null }, ''), null);
  assert.equal(engineFailureClass({ status: 'FAILED', class: 'STALL', exitCode: null }, ''), 'STALL');
  assert.equal(engineFailureClass({ status: 'BLOCKED', class: 'TIMEOUT', exitCode: null }, ''), 'INTERRUPTED');
  assert.equal(engineFailureClass({ status: 'FAILED', class: 'INVALID_OUTPUT', exitCode: 0 }, ''), 'CONTENT');
  assert.equal(engineFailureClass({ status: 'BLOCKED', class: 'POLICY_FAILURE', unrecordedProcesses: [4242] }, ''), 'ORPHAN');
  assert.equal(engineFailureClass({ status: 'FAILED', class: 'AUTH_ERROR', exitCode: 7 }, ''), 'AUTH');
  assert.equal(engineFailureClass({ status: 'FAILED', class: 'RATE_LIMIT', exitCode: 7 }, ''), 'QUOTA');
  assert.equal(engineFailureClass({ status: 'FAILED', class: 'PROCESS_CRASH', exitCode: 7 }, 'plain failure'), 'UNKNOWN');
  process.stdout.write('SELFTEST ok\nRESULT exit=0\n');
  return 0;
}

function watch(o) {
  const runtime = path.resolve(o.runtime || path.join(mainRoot(path.resolve(o.repo || process.cwd())), '.ai', 'runtime'));
  const now = o.now ? Date.parse(o.now) : Date.now();
  const grace = Number(o['grace-min'] || 5) * 60000;
  let silent = 0;
  if (!fs.existsSync(runtime)) { process.stdout.write('RESULT exit=0 silent=0 (no runtime directory)\n'); return 0; }
  for (const f of fs.readdirSync(runtime).filter(n => n.endsWith('.running.json'))) {
    const r = readJson(path.join(runtime, f));
    if (!r || r.ended || fs.existsSync(path.join(runtime, `${r.name}.terminal.json`))) continue;
    if (now - Date.parse(r.startedAt) < grace) continue;
    if (alive(r.wrapperPid) || alive(r.childPid)) continue;
    writeTerminal(runtime, r.name, r, { status: 'FAILED', exitCode: null, signal: null, failureClass: 'INTERRUPTED', reason: 'process gone, no terminal marker (died silently)', lastLines: [] });
    if (r.stream && r.owner) guard(o, ['release', '--stream', r.stream, '--owner', r.owner]);
    process.stdout.write(`FAILED_SILENT name=${r.name} stream=${r.stream} owner=${r.owner} started=${r.startedAt} (replace the certifier now)\n`);
    silent++;
  }
  process.stdout.write(`RESULT exit=${silent ? 1 : 0} silent=${silent}\n`);
  return silent ? 1 : 0;
}

function status(o) {
  const runtime = path.resolve(o.runtime || path.join(mainRoot(path.resolve(o.repo || process.cwd())), '.ai', 'runtime'));
  if (!fs.existsSync(runtime)) { process.stdout.write('no runtime directory\nRESULT exit=0\n'); return 0; }
  for (const f of fs.readdirSync(runtime).filter(n => n.endsWith('.terminal.json'))) {
    const t = readJson(path.join(runtime, f));
    if (t) process.stdout.write(`${t.status.padEnd(6)} ${t.name} stream=${t.stream} exit=${t.exitCode} class=${t.failureClass || '-'} wall=${t.wallSeconds}s ended=${t.endedAt}\n`);
  }
  for (const f of fs.readdirSync(runtime).filter(n => n.endsWith('.running.json'))) {
    const r = readJson(path.join(runtime, f));
    if (r && !r.ended && !fs.existsSync(path.join(runtime, `${r.name}.terminal.json`))) process.stdout.write(`RUNNING ${r.name} stream=${r.stream} started=${r.startedAt} alive=${alive(r.wrapperPid) || alive(r.childPid)}\n`);
  }
  process.stdout.write('RESULT exit=0\n');
  return 0;
}

async function main(argv, deps = {}) {
  const cmd = argv[0];
  const o = parseArgs(argv.slice(1));
  if (!['run', 'watch', 'status', 'selftest'].includes(cmd) || o.error) { process.stderr.write(`${o.error || 'usage: launch-wrapper.cjs run|watch|status [options] -- <command>'}\n`); return 2; }
  if (cmd === 'run') return run(o, deps);
  if (cmd === 'watch') return watch(o);
  if (cmd === 'selftest') return selftest();
  return status(o);
}

module.exports = { classify, snapshot, compareSnapshots, commitNote, engineFailureClass, resolveTmpRoot, configuredTmpRoot, driveRootCandidate, launchNameProblem, MAX_NAME_LENGTH, prepareLaunchTmp, finishLaunchTmp, main };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });

'use strict';
// launch-wrapper: the one way to start a certifier, fixer or any agent session.
// run: claim the stream, run the launch gate (registry tip and pins), start the command, tee its output, and on EVERY exit path write a terminal marker
// (DONE or FAILED with exit code, the last 20 lines and a failure class) and release the claim. watch: find launches whose processes are gone without a
// terminal marker and mark them FAILED (the "died silently" case). status: list running and finished launches.
//   node docs/ops/launch-wrapper.cjs run --stream S --owner O --name N --worktree W [--ttl MIN] [--engine legacy|dispatch]
//        [--pin-files a,b] [--certifier] [--log FILE] [--no-gate] [--runtime DIR] [--registry FILE] [--claims FILE] [--repo DIR]
//        [--stall-seconds N] [--hard-seconds N] [--role R] [--tier T1..T9] [--client C --model M --effort E] [--task T]
//        [--route-state ROUTE_ID [--route-override "<owner act>"]] [--seat-cap N] [--client-cap N] [--slot-wait-min M] [--slot-poll-sec S]
//        [--caps FILE] [--launch-role author|certifier|pre-review|unknown] [--idle-minutes N] [--idle-kill-minutes M] -- <command> [args...]
//   node docs/ops/launch-wrapper.cjs watch [--runtime DIR] [--grace-min 5] [--now ISO] [--claims FILE] [--registry FILE] [--repo DIR]
//   node docs/ops/launch-wrapper.cjs status [--runtime DIR] [--repo DIR]
//   node docs/ops/launch-wrapper.cjs verify --name N [--runtime DIR] [--repo DIR] [--timeout SEC] [--poll SEC] [--settle SEC] [--since ISO] [--out FILE]
// LAUNCH-RELIABILITY (no seat dies or idles unseen):
// - seats: the claim, the launch gate and the release name the launch (--seat NAME of ops-guard), so a seat that ends releases only its
//   own seat of the stream's claim and never the claim of a sibling seat of the same stream (finding 3).
// - spawn proof (finding 1): the running record carries spawnProof: "seat-spawn-line" when the child is a kernel seat launcher
//   (cert-launch, fix-launch, run-client by the closed entry grammar of the route gate) under a route record, else "none". The wrapper reads
//   the child's SEAT-SPAWN decision line and the named refusal lines of the launchers (PRECERT_REFUSED, ROUTE_REFUSED, ...) and keeps them as
//   seatSpawn and refusal in the running and terminal records. `verify` waits for that proof (or for the refusal, the end or the timeout) and
//   prints the real state: VERIFY-OK only after the admitted SEAT-SPAWN line of a live launch (or, with spawnProof none, a live launch that
//   stayed up for --settle seconds); VERIFY-REFUSED, VERIFY-DEAD, VERIFY-ENDED or VERIFY-TIMEOUT otherwise.
// - precert (finding 4): a --certifier launch whose child is NOT cert-launch (the operator's kilo, kimi or claude seat runners) and names
//   the head it certifies (--expect-sha, the subject cert-launch gates too) passes the same precert gate as cert-launch (cert-launch.cjs precertStep, .ai/bin/lib/precert-facts.cjs) before the claim, with the same
//   --precert-base/-prev/-journal/-override grammar read from the child command (seat-failover splitPrecert); the wrapper removes those
//   items from such a child command. cert-launch keeps its own gate, so it is never run twice.
// - role (finding 5): --launch-role states the role of the seat once; a cert-launch child that states none gets it appended, a child that
//   states another is a usage error (exit 2). Without it the role is the child's --launch-role, "author" for a fix-launch child, else
//   unknown (gated as a certifier, no silent default).
// - idle (finding 6): with no child output line and no worktree change for --idle-minutes (default 30, 0 = off) the wrapper prints
//   SEAT-IDLE and records idle in the running record (a client that waits for a permission prompt looks exactly like this from outside);
//   with --idle-kill-minutes M (default 0 = off) it stops the child tree after M minutes of it and the launch ends FAILED class IDLE.
//   A FAILED launch that was idle at its end and has no more specific class is IDLE too.
// - classes (findings 2 and 7): TRANSPORT_EXHAUSTED (the child printed SEAT-RETRY-EXHAUSTED: the bounded retry of seat-failover ran out)
//   and WAKEUP_TOOL (the child printed WAKEUP_TOOL client=: the client called its wakeup or pause tool and its run ended there).
// Operator layer: this wrapper is the standard way to start an executor or a reviewer in a
// project (.ai/docs/CLI-AGENTS.md). `run` registers the wrapper and child PID, the worktree, the task (--task T, else the stream) and the
// start time in NAME.running.json; `status` adds to every line what .ai/bin/operator/layer.cjs computes from those records: the
// state (alive, stalled = alive with no file change in the worktree beyond the idle threshold of the route, dead = gone without a
// terminal record, exited), the handoff (pending until the operator accepts the result with layer.cjs accept), the last file change
// and the last commit of the worktree. Those are the only source of the "process alive" and "last change" columns of an operator report.
//   node docs/ops/launch-wrapper.cjs selftest
// Commit detection (WARN-only): `run` (--worktree is mandatory, exit 2 without it) snapshots HEAD and the current branch ref of that worktree before the
// child starts and after it exits (foreign branches and tags never count); when either moved it prints `WARN agent-committed head-before=<sha> head-after=<sha> refs-changed=N` and records the fact in the terminal
// record's `note` (a launch-record/1 field). It never changes the exit code, blocks, or fails the launch; a snapshot that cannot be taken is recorded as `snapshot-unavailable`.
// Exit of `run`: the command's own exit code (1 when it was killed by a signal), 3 when the gate refused (nothing was started), 2 on usage errors.
// Exit of `watch`: 1 when it marked at least one silent death, else 0. The marker files live in the runtime directory of the MAIN checkout:
// <name>.running.json, <name>.terminal.json and <name>.marker.txt (one line `NAME_DONE exit=N end=ISO` or `NAME_FAILED exit=N class=C end=ISO`).
// --engine dispatch (opt-in; the default legacy keeps the direct-spawn path untouched): the command runs through the L4 executor
// (.ai/bin/protocol-dispatch/executor.cjs executeAttempt) in a per-launch scratch git workdir, under the single liveness (idle 10 min,
// hard 120 min, wake budget 3, own output only), the identity lease (PID + creation time; the lease lives with the executor logs under
// .ai/runtime/dispatch-wrapper in the repo runtime) and the leaf-first stop. The marker, running/terminal records, claims, exit codes and
// the commit check keep their legacy shapes. The executor's own semantics apply unchanged: the credential-stripped child environment
// (executorEnv), the binary --version probe, the command-line safety checks and the scope stop on the scratch workdir. A kill by the
// liveness rules is a FAILED marker (exit none, class STALL or INTERRUPTED) and exit code 1, like a legacy signal kill.
// Per-launch temp isolation (layer 2): before the claim, `run` resolves the work root (docs/ops/lib/work-root.cjs:
// PROTOCOL_WORK_ROOT, else COLABS_TMP_ROOT, else the protocol-manifest.json "workRoot" key, else <drive of the repository>:/ColabsTmp (for example <drive>:/ColabsTmp),
// else the OS temp dir) and REFUSES to start (exit 3, a named reason and the recovery line, nothing created: no claim, no temp dir, no file) when that root does not
// exist or sits on the system drive without PROTOCOL_WORK_ROOT_ON_SYSTEM_DRIVE=1 (the single-drive-host opt-in). After the gate, `run` creates <root>/<launch name> and
// gives the child TEMP, TMP, TMPDIR and the toolchain caches (npm_config_cache, PYTHONPYCACHEPREFIX, XDG_CACHE_HOME, NODE_COMPILE_CACHE when already set) pointing
// inside it. The directory carries its launch marker (written and read only by docs/ops/lib/launch-marker.cjs). When the child ends (any exit class, a liveness kill included) the
// wrapper removes it if it lies strictly under the root and carries its marker. After a FAILED launch it is kept for 12 hours instead (marker keepUntil) and the terminal
// record's `tempDir` field says so; the temp retention of the operator removes it later (it allows the same root: lib/tmp-root.cjs). A seat that cannot run delete commands therefore leaves nothing behind.
// --name is checked before anything is created (no claim, no temp dir, no file): at most 64 characters of letters, digits, dot, dash, underscore; no leading or trailing dot; no
// reserved Windows device name (exit 2). Any exception after the claim was taken still writes the terminal record, releases the claim and settles the temp dir (kills a started child).
// --stall-seconds N / --hard-seconds N (engine dispatch only, default off) replace the idle window (10 min) and the hard ceiling (120 min) of that
// run, like the same flags of protocol-dispatch.cjs run; without them the defaults above apply. They exist for short probes and for pilots that want a
// tighter idle limit; they never loosen a rule on their own, the wake budget and the own-output rule are unchanged.
// Cost record: the failure classes of the terminal record include NO_VERDICT (cert-launch printed report=NO_VERDICT: the report has no closed
// verdict token) and TURN_LIMIT (vibe stopped on its turn limit); the last `USAGE ...` line the child printed (tokens and cost basis, cert-launch.cjs and
// fix-launch.cjs print it when the client told its tokens) is copied into the terminal record as `usage`. The wrapper itself reads no client output beyond that.
// Resolver shadow (PROTO-DEC-0143 item 3): after the gate and before the child starts, `run` asks resolver-shadow.cjs what the
// resolver would choose for the stated --role and --tier (task class) against the operator's --client/--model/--effort, and keeps the
// answer as the `resolver` field of the running and terminal records (and one line of <runtime>/resolver-shadow/). Without --tier the
// field records the error task-class-missing. It never changes the command, the exit code or the gate, and a failure never blocks.
// Route gate (PROTO-DEC-0235 item 3a, 0236, 0240): EVERY `run` takes the route step FIRST after the
// argument checks (before the quota hook, the work root, the claim, the ops-guard gate, the launch directory, the records and the child). The route is
// the row of docs/ops/route-state.json named by --route-state ID, or else the row the gate derives from the client and model of the launch
// (route-gate.cjs deriveRoutes: the record is the only table). The client and model of the launch are the wrapper's --client and --model, else the
// --client and --model the child command names after -- (cert-launch, fix-launch and the operator's seat scripts state them there); two different
// values of one name are refused (ROUTE_MISMATCH). The child command is read through the closed entry grammar of a seat launcher (route-gate.cjs
// launchEntry): a seat launcher started as node [--no-warnings | --require VALUE] [--] SCRIPT is decided on the pair it starts first,
// and a command that cannot be shown not to run one is refused (ENTRY_FORM_REFUSED). the route gate (checkRoute) reads the record only through its strict reader,
// runs the one live probe of the route check when the record holds no fresh probe (never for a scarce route) and REFUSES with exit 3, a named reason and
// nothing created when the route failed its probe, is unknown or stale, or contradicts the client or model of the launch. --route-state,
// --route-override, --client and --model may each be given once (a repeat is a usage error, exit 2). --route-override "<owner act>" applies only to
// the overridable reasons (never to a failed route); the decision is printed (ROUTE-GATE ...) and kept as the `routeGate` field of the running and
// terminal records. TRANSITION (PROTO-DEC-0240 item 2): a launch whose client and model match no row is admitted while the record does not carry
// coverage.complete; its records carry routeGate decision=transition naming the missing route, and the same line goes to stderr after the quota step
// when the client of the launch is known. A launch without a known client keeps its output byte identical to the launch before this step
// (the quota tests hold the quota-off path to that); its decision lives in its records. A host project of the pilot kit that
// keeps no docs/ops/route-state.json records routeGate { applied: false, reason: ROUTE_STATE_ABSENT }, with the gate module or without it; a named route there,
// or a missing module beside a present record, is refused with ROUTE_GATE_ERROR. OK_ROUTE_STATE_FILE names another record file (the tests that run
// the wrapper as a child process); the decision then records and prints that file. PROBE ROOT (PROTO-DEC-0240 item 3): the step resolves the probe
// root of the route check (OK_PROBE_TEMP, else a probe folder outside the launch roots), refuses ROUTE_PROBE_ROOT when it lies inside a launch root (the repository, .ai/runtime, the
// state directory, the claims directory, the work root) or a launch root is unresolved, creates it, and runs the gate with TEMP/TMP/TMPDIR of this
// process set to it: the live probe's sandbox and the helper the strict reader compiles once per process on Windows land there, never in the OS temp.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { configuredTmpRoot, resolveTmpRoot, driveRootCandidate } = require('./lib/tmp-root.cjs');
const workRoot = require('./lib/work-root.cjs');
const writeBoundary = require('./lib/write-boundary.cjs');
const seatPersistence = require('./lib/seat-persistence.cjs');
// The route gate is loaded at run time from a resolved path: it is operator tooling of this repository (ROUTE-STATE and the probe of the route check),
// not part of the require() closure the pilot kit ships into other projects (docs/ops/pilot-install.cjs follows literal relative requires only).
const ROUTE_GATE_MODULE = path.join(__dirname, '..', '..', 'tools', 'operator-knowledge', 'route-gate.cjs');
const ROUTE_STATE_FILE = path.join(__dirname, 'route-state.json');
const ROUTE_STATE_FILE_ENV = 'OK_ROUTE_STATE_FILE';
const ROUTE_STATE_ABSENT = Object.freeze({ schema: 'route-gate/1', applied: false, reason: 'ROUTE_STATE_ABSENT' });
// The wrapper's own decision, handed to the child for the spawn point of the SAME client and model (docs/ops/seat-failover.cjs spawnClient,
// routeDecision): the ok live probe of this launch and the owner override given to this launch. Every other decision hands nothing: the
// variable is then not set (a child environment without a decision stays byte identical), and an empty value clears only a decision
// inherited from an outer launch. The spawn point decides every spawn itself; this only spares it a second probe.
const ROUTE_DECISION_ENV = 'OK_ROUTE_DECISION';
// The seat policy of the launch (item 5.9). OK_SEAT_POLICY_FILE names another policy file for
// the tests that run the wrapper as a child process (the same pattern as OK_ROUTE_STATE_FILE).
const SEAT_POLICY_FILE_ENV = 'OK_SEAT_POLICY_FILE';
const seatPolicy = require('../../.ai/bin/lib/seat-policy.cjs');
const seatSlots = require('../../.ai/bin/lib/seat-slots.cjs');
function handedDecision(g) {
  if (!g || g.applied !== true || g.decision !== 'allowed' || typeof g.client !== 'string' || typeof g.model !== 'string') return '';
  const probe = g.probe && g.probe.source === 'live' && g.probe.ok === true ? { ok: true, at: g.probe.at } : null;
  const override = g.override && typeof g.override.act === 'string' ? g.override.act : null;
  return probe || override ? JSON.stringify({ client: g.client, model: g.model, route: g.route, probe, override }) : '';
}
// The inputs of the route step; each may be given once (PROTO-DEC-0240 item 1: a repeated route flag is refused).
const ONCE = new Set(['--route-state', '--route-override', '--client', '--model', '--proxy-wait-min', '--task-file', '--proxy-attempt']);
const LAUNCH_ROLES = ['author', 'certifier', 'pre-review', 'unknown'];

const { launchNameProblem, MAX_NAME_LENGTH } = require('../../.ai/bin/lib/launch-name.cjs');
const GUARD = path.join(__dirname, 'ops-guard.cjs');
const INTERRUPTED_CODES = new Set([3221225786, 137, 143, -1073741510, 130]);

function git(cwd, args) { const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true }); return { code: r.status, out: (r.stdout || '').trim() }; }
function mainRoot(repo) { const r = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']); return r.code === 0 && r.out ? path.resolve(r.out, '..') : path.resolve(repo); }
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// The seat policy of the launch. The canonical file is the policy of the MAIN checkout, so
// every worktree of the repository reads the same policy and a closed policy cannot be
// bypassed by a missing file in another tree.
// -> { ok: true, policy, file, now } | { ok: false, code, detail, file }
// An absent canonical file is an UNCONFIGURED host (no cap at all). An absent or broken file
// that was NAMED (--caps or the test injection) is a refusal: never "uncapped".
function seatPolicyState(o, deps = {}) {
  const envBase = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const main = mainRoot(path.resolve(o.repo || process.cwd()));
  const canonical = seatPolicy.canonicalFile(main);
  const injected = typeof envBase[SEAT_POLICY_FILE_ENV] === 'string' && envBase[SEAT_POLICY_FILE_ENV].trim()
    ? envBase[SEAT_POLICY_FILE_ENV].trim() : null;
  const named = o['caps'] !== undefined ? o['caps'] : null;
  const read = seatPolicy.resolvePolicy({ canonical, named, injected, now });
  if (!read.ok) return { ok: false, code: read.code, detail: read.detail, file: read.file, now };
  return { ok: true, policy: read.policy, file: read.file, now };
}

// The caps of the launch: the policy and the CLI cap. The CLI cap only TIGHTENS: it never
// reopens a zero and never reopens an expired cap.
function seatCapsOf(o, policy, now) {
  const rawClient = o.client || childClient(o) || null;
  const client = rawClient ? seatSlots.canonicalClient(rawClient, require('../../.ai/bin/ops-tools/lib/config.cjs').loadSeatCaps().clients) : null;
  const model = o.model || childOption(o.command || [], 'model');
  const route = seatPolicy.routeOf(policy, client, model);
  const caps = seatPolicy.effectiveCaps(policy, { client, route }, now);
  const cliTotal = o['seat-cap'] !== undefined ? Number(o['seat-cap']) : null;
  const cliClient = o['client-cap'] !== undefined ? Number(o['client-cap']) : null;
  const total = seatPolicy.tighter(caps.total, cliTotal);
  const clientCap = seatPolicy.tighter(caps.client, cliClient);
  return { total, client: clientCap, clientName: client, model, route: caps.route, routeName: route, expired: caps.expired, expiredReason: caps.expiredReason,
    zero: total === 0 || clientCap === 0 || caps.route === 0 };
}

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
  const flags = new Set(['--certifier', '--no-gate', '--cycle-control']);
  flags.add('--proxy-continue');
  const valued = new Set(['--task', '--stream', '--owner', '--name', '--worktree', '--ttl', '--engine', '--pin-files', '--log', '--runtime', '--registry', '--claims', '--repo', '--grace-min', '--now', '--stall-seconds', '--hard-seconds', '--role', '--tier', '--client', '--model', '--effort', '--quota-request', '--route', '--route-state', '--route-override', '--seat-cap', '--client-cap', '--slot-wait-min', '--slot-poll-sec', '--caps', '--launch-role', '--idle-minutes', '--idle-kill-minutes', '--timeout', '--poll', '--settle', '--since', '--out']);
  for (const key of ['--proxy-wait-min', '--task-file', '--proxy-attempt', '--selection-base', '--deviation-reason']) valued.add(key);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o.command = argv.slice(i + 1); break; }
    if (flags.has(a)) o[a.slice(2)] = true;
    // ASSIGN-EXECUTION R1: the launch asks to be assigned; only the value auto exists (checked at the start of runLaunch)
    else if (a === '--assign') { if (Object.hasOwn(o, 'assign')) return { error: 'repeated option --assign' }; if (typeof argv[i + 1] !== 'string' || argv[i + 1].startsWith('--')) return { error: 'option --assign needs a value' }; o.assign = argv[++i]; }
    else if (valued.has(a)) {
      if (ONCE.has(a) && Object.hasOwn(o, a.slice(2))) return { error: `repeated option ${a} (the route step takes one value)` };
      if (ONCE.has(a) && (typeof argv[i + 1] !== 'string' || !argv[i + 1].trim() || argv[i + 1].startsWith('--'))) return { error: `option ${a} needs a value (the route step takes one value)` };
      o[a.slice(2)] = argv[++i];
    }
    else if (a.startsWith('--')) return { error: `unknown option ${a}` };
    else o._.push(a);
  }
  return o;
}

// LAUNCH-RELIABILITY: WAKEUP_TOOL (cert-launch printed WAKEUP_TOOL client=: the client called its wakeup or pause tool) wins over NO_VERDICT,
// the run ended there; TRANSPORT_EXHAUSTED (seat-failover printed SEAT-RETRY-EXHAUSTED: the bounded transport retry ran out) wins over TRANSPORT.
// APPROVAL_STALL is the line a launcher prints when a failed client run ends on a permission prompt (docs/ops/approval-stall.cjs); it wins over NO_VERDICT.
function classify(exitCode, signal, text) {
  if (signal || INTERRUPTED_CODES.has(exitCode)) return 'INTERRUPTED';
  if (/^SERVED_MODEL_MISMATCH requested=\S+ served=\S+ source=\S+ class=SERVED_FAMILY_MISMATCH;/m.test(text)) return 'SERVED_FAMILY_MISMATCH';
  if (/^SERVED_MODEL_MISMATCH requested=/m.test(text)) return 'SERVED_MODEL_MISMATCH';
  if (/^WAKEUP_TOOL client=/m.test(text)) return 'WAKEUP_TOOL';
  if (/^TURN_LIMIT client=/m.test(text)) return 'TURN_LIMIT';
  if (/^APPROVAL_STALL client=/m.test(text)) return 'APPROVAL_STALL';
  if (/\breport=NO_VERDICT\b/.test(text)) return 'NO_VERDICT';
  if (/^SEAT-RETRY-EXHAUSTED /m.test(text)) return 'TRANSPORT_EXHAUSTED';
  if (/\b429\b|rate.?limit|quota|insufficient (credit|funds)|exhausted/i.test(text)) return 'QUOTA';
  if (/\b401\b|\b403\b|unauthori[sz]ed|invalid api key|forbidden/i.test(text)) return 'AUTH';
  if (/EPIPE|broken pipe|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|fetch failed|loadCodeAssist|eligibility|network|\bEOF\b/i.test(text)) return 'TRANSPORT';
  return 'UNKNOWN';
}

function writeJson(file, obj) {
  const atomicPaths = require('../../.ai/bin/lib/path-safe.cjs');
  const root = path.dirname(file);
  const directory = atomicPaths.mkdirGuarded(path.parse(root).root, root);
  if (!directory.ok) throw Object.assign(Error('wrapper-directory-refused'), { code: 'wrapper-directory-refused' });
  const published = atomicPaths.writeAtomicGuarded(file, Buffer.from(JSON.stringify(obj, null, 2) + '\n'), { root });
  if (!published.ok || published.closeError) throw Object.assign(Error('wrapper-write-refused'), { code: 'wrapper-write-refused' });
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
// The root resolution (COLABS_TMP_ROOT, else <drive>:/ColabsTmp, else the OS temp dir) lives in lib/tmp-root.cjs.
// Pure: null when the name is fit to become a file name and a directory name on every platform, else the reason it is refused.
// Refused: empty, over MAX_NAME_LENGTH, anything but letters, digits, dot, dash and underscore (so no separator, drive letter or space),
// a leading dot (`.`, `..`, `...`, `.hidden`, `..-x`), a trailing dot (Windows drops it, two names would meet), and a reserved Windows device name.
// A fresh directory for this launch (docs/ops/lib/work-root.cjs). A same-named directory (kept after an earlier failed launch) is never reused or removed here: the new one gets a suffix.
// The leaf rule stays the wrapper's own: the bare launch name, colabs-launch-<name> only in the OS-temp fallback; the kernel launchers use the colabs-launch- leaf on every root.
// Every cache directory the child environment names is created fresh and exclusively inside the per-launch directory (an existing cache path is refused, never reused).
function prepareLaunchTmp(name, root, wrapperPid, io = fs) {
  const bad = launchNameProblem(name);
  if (bad) throw new Error(bad);
  const lt = workRoot.prepareLaunchDir(name, root, wrapperPid, io);
  try { workRoot.prepareCacheDirs(lt.dir, process.env, io); }
  catch (e) { e.launchTmp = lt; e.tempDir = workRoot.finishLaunchTmp(lt, true, 'CACHE_PREPARE_FAILED'); throw e; }
  return lt;
}
const launchTmpEnv = (lt, baseEnv = process.env) => (lt ? workRoot.launchWorkEnv(lt.dir, baseEnv) : {});
const { finishLaunchTmp } = workRoot;
const tempLine = t => (t && t.action === 'kept' ? `TEMP kept ${t.path}: ${t.reason}\n` : '');

// Every field this wrapper writes into a running or terminal record is listed in seatSlots.RECORD_FIELDS, which the cycle reader
// accepts exactly: a new record field is added to that list in the same change that writes it.
const { seatMarker } = require('../../.ai/bin/lib/seat-marker.cjs');
function writeTerminal(runtime, name, base, result) {
  if (result.seatPersistence) base = { ...base, seatPersistence: result.seatPersistence };
  const ended = new Date().toISOString();
  const last = (result.lastLines || []).filter(l => l.trim()).at(-1) || '';
  const expected = `${base.completionMarker || name.toUpperCase()}_`;
  const routed = last.startsWith(expected) && /^(?:DONE|NO_VERDICT|SERVED_MODEL_MISMATCH) exit=(?:-?\d+|null)(?: report=(?:ok|NO_VERDICT))? route=([a-z][a-z0-9-]*:[A-Za-z0-9][A-Za-z0-9._:/-]{0,127})$/.exec(last.slice(expected.length));
  const terminal = { ...base, status: result.status, exitCode: result.exitCode, signal: result.signal || null, failureClass: result.status === 'FAILED' ? result.failureClass : null, reason: result.reason || null, endedAt: ended, wallSeconds: Math.round((Date.parse(ended) - Date.parse(base.startedAt)) / 100) / 10, lastLines: result.lastLines || [], ...(result.note ? { note: result.note } : {}), ...(result.tempDir ? { tempDir: result.tempDir } : {}), ...(result.usage ? { usage: result.usage } : {}), ...(result.seatSpawn ? { seatSpawn: result.seatSpawn } : {}), ...(result.refusal ? { refusal: result.refusal } : {}), ...(result.idle ? { idle: result.idle } : {}), ...(result.writeBoundary ? { writeBoundary: result.writeBoundary } : {}) };
  Object.assign(terminal, result.usageFields || { tokens: null, cost: { usd: null, basis: 'unknown', priceSnapshot: null, formula: null, reason: 'no structured usage frame from child' } });
  if (routed) terminal.seatRoute = routed[1];
  if (routed && terminal.selectionShadow?.advice) {
    const cut = routed[1].indexOf(':');
    const actual = { client: routed[1].slice(0, cut), model: routed[1].slice(cut + 1), effort: null };
    const original = terminal.selectionShadow.advice;
    const match = require('../../.ai/bin/lib/selection-metrics.cjs').compareRoutes(original.recommended, actual);
    const changed = require('../../.ai/bin/lib/selection-metrics.cjs').compareRoutes(original.actual, actual) === false;
    terminal.selectionShadow = { ...terminal.selectionShadow, advice: { ...original, actual,
      deviationReason: match === true ? 'recommendation-followed' : changed ? 'actual-route-changed' : original.deviationReason } };
  }
  writeJson(path.join(runtime, `${name}.terminal.json`), terminal);
  const token = base.completionMarker || name;
  const line = terminal.status === 'DONE' ? `${token}_DONE exit=${terminal.exitCode} end=${ended}` : `${token}_FAILED exit=${terminal.exitCode === null ? 'none' : terminal.exitCode} class=${terminal.failureClass} end=${ended}`;
  fs.appendFileSync(path.join(runtime, `${name}.marker.txt`), `${line}${routed ? ` route=${routed[1]}` : ''}\n`, 'utf8');
  const running = readJson(path.join(runtime, `${name}.running.json`));
  if (running) writeJson(path.join(runtime, `${name}.running.json`), { ...running, ended });
  return terminal;
}

function markClaimReleased(runtime, name, startedAt) {
  const file = path.join(runtime, `${name}.running.json`);
  const running = readJson(file);
  if (running && running.startedAt === startedAt) {
    try { writeJson(file, { ...running, claimReleasedAt:new Date().toISOString() }); }
    catch { process.stderr.write(`CLAIM_RELEASE_RECORD_FAILED name=${name}\n`); }
  }
}

// The route gate (PROTO-DEC-0240). It runs for EVERY launch before anything of the launch exists and writes nothing: a refusal leaves no claim,
// no record, no temp dir and no file. The time is read once here and handed to the gate; the record file, the probe dependencies, the gate module
// and the time come from deps for the tests only. -> { code: null | 2 | 3, record, notice } where record is the routeGate field of the launch
// records and notice is the transition line the caller prints to stderr after the quota step (null when there is nothing to print).
function routeGateStep(o, deps) {
  const out = deps.routeGate?.say || (s => process.stdout.write(`${s}\n`));
  const gd = deps.routeGate || {};
  const envBase = deps.env || process.env;
  const visible = (v, n) => String(v).replace(/[^\x20-\x7e]/g, '?').slice(0, n);
  const named = o['route-state'] !== undefined;
  const moduleFile = gd.module || ROUTE_GATE_MODULE;
  const fromEnv = typeof envBase[ROUTE_STATE_FILE_ENV] === 'string' && envBase[ROUTE_STATE_FILE_ENV].trim() ? path.resolve(envBase[ROUTE_STATE_FILE_ENV].trim()) : null;
  const recordFile = gd.recordFile ? path.resolve(gd.recordFile) : fromEnv || ROUTE_STATE_FILE;
  // A host project that keeps no ROUTE-STATE record has no route to check, whether the pilot kit installed the gate module or not.
  if (!named && !fromEnv && !fs.existsSync(recordFile)) return { code: null, record: { ...ROUTE_STATE_ABSENT }, notice: null };
  let routeGate;
  try { routeGate = require(moduleFile); } catch (e) {
    out(`ROUTE-GATE REFUSED reason=ROUTE_GATE_ERROR route=${named ? visible(o['route-state'], 64) : 'none'} detail=the route gate module cannot be loaded here (${(e && e.code) || 'error'}); nothing was started`);
    return { code: 3, record: null, notice: null };
  }
  if (named) {
    const idBad = routeGate.routeIdProblem(o['route-state']);
    if (idBad) { process.stderr.write(`${idBad}\n`); return { code: 2, record: null, notice: null }; }
  }
  const overrideBad = routeGate.overrideProblem(o['route-override']);
  if (overrideBad) { process.stderr.write(`--route-override: ${overrideBad}\n`); return { code: 2, record: null, notice: null }; }
  // The launch roots (PROTO-DEC-0240 item 3): every directory this launch writes to - the repository, .ai/runtime, the state directory, the claims
  // directory and the work root. An unresolved work root stays null and the probe root is refused rather than guessed.
  const launchRoots = (() => {
    const repo = path.resolve(o.repo || process.cwd());
    const shared = path.join(mainRoot(repo), '.ai', 'runtime');
    const roots = [repo, shared, path.resolve(o.runtime || shared)];
    if (o.claims) roots.push(path.dirname(path.resolve(o.claims)));
    let dir = null;
    try { dir = workRoot.resolveWorkRoot(repo, envBase, deps.fs || fs).dir || null; } catch { dir = null; }
    roots.push(dir);
    return roots;
  })();
  const recordPart = recordFile === ROUTE_STATE_FILE ? '' : ` record=${visible(recordFile, 200)}`;
  const refuse = (code, detail) => {
    out(`${routeGate.decisionLine({ allowed: false, refusal: { code, detail: visible(detail, 300), overridable: false }, record: null, route: null }, o['route-state'])}${recordPart}`);
    return { code: 3, record: null, notice: null };
  };
  // The client and model of the launch (PROTO-DEC-0240 item 1): the wrapper's own --client and --model, else the ones the child command names
  // (the kernel launchers cert-launch and fix-launch take them, and the operator's seat scripts state them only there). The child command is
  // read only by the one reader the seat launchers use (routeGate.launchIdentity: --client VALUE and --client=VALUE; a repeat, a missing value
  // or another spelling is ROUTE_ARGS_REFUSED). A wrapper value that differs from the child's contradicts it and is refused (ROUTE_MISMATCH).
  // (PROTO-DEC-0240 item 1): the child command is read through the closed entry grammar of a seat
  // launcher (routeGate.launchEntry): a launcher (cert-launch, fix-launch, the operator's run-client, by the real path of its script) is
  // decided on the pair it starts first (the default first route of a fix launch included), any other command on the pair it states, and a
  // command that cannot be shown NOT to run a launcher (a Node option outside the list, a launcher named outside the script position) is
  // refused ENTRY_FORM_REFUSED, all before the claim.
  // Everything the step reads and may write lives in the probe root, which lies outside every launch root (routeGate.inProbeRoot, the one
  // function the launchers' route decisions use too): the sandbox of a live probe, and the private helper compile of the shared strict
  // reader on Windows (.ai/bin/lib/read-handle.cjs; a warm verified cache compiles nothing, the cache lives in the user profile).
  // For the step the OS temp of this process IS the probe root, so a launch
  // writes nothing to the OS temp and nothing under a launch root before its decision.
  let scoped;
  try {
    scoped = routeGate.inProbeRoot({ env: envBase, root: gd.probe && gd.probe.probeTemp, launchRoots }, probeRoot => {
      const child = routeGate.launchEntry(o.command, { cwd: process.cwd() });
      if (child.problem) return { refusal: [child.code, `the child command: ${child.problem}`] };
      const identity = {};
      const from = [];
      for (const name of ['client', 'model']) {
        const flag = `--${name}`;
        // The wrapper's own value is visible ASCII, as the one reader requires of the child's
        if (o[name] !== undefined && !/^[\x21-\x7e]+$/.test(o[name])) return { refusal: ['ROUTE_ARGS_REFUSED', `the launch: invalid-option-value option=${flag}`] };
        if (o[name] !== undefined && child[name] !== undefined && o[name] !== child[name]) return { refusal: ['ROUTE_MISMATCH', `the launch names ${flag} ${visible(o[name], 60)} and ${visible(child[name], 60)} (wrapper and child command must agree)`] };
        identity[name] = o[name] !== undefined ? o[name] : child[name];
        if (o[name] !== undefined) from.push(`wrapper-${name}`); else if (child[name] !== undefined) from.push(`command-${name}`);
      }
      let result;
      try {
        result = routeGate.checkRoute({ routeId: o['route-state'], client: identity.client, model: identity.model, now: gd.now || new Date().toISOString(), override: o['route-override'] },
          { recordFile, probe: { ...(gd.probe || {}), probeTemp: probeRoot }, env: envBase, launchRoots });
      } catch (e) {
        result = { allowed: false, refusal: { code: 'ROUTE_GATE_ERROR', detail: visible((e && (e.code || e.message)) || e, 120), overridable: false }, record: null };
      }
      return { result, identity, from };
    });
  } catch (e) {
    return refuse('ROUTE_GATE_ERROR', visible((e && (e.code || e.message)) || e, 120));
  }
  if (scoped.problem) return refuse('ROUTE_PROBE_ROOT', scoped.problem);
  if (scoped.value.refusal) return refuse(...scoped.value.refusal);
  const { result, identity, from } = scoped.value;
  const line = `${routeGate.decisionLine(result, o['route-state'])}${recordPart}`;
  if (!result.allowed) { out(line); return { code: 3, record: null, notice: null }; }
  const record = { ...result.record, identityFrom: from, ...(recordPart ? { recordFile } : {}) };
  if (record.decision === 'transition') return { code: null, record: { ...record, line }, notice: identity.client !== undefined ? line : null };
  out(line);
  return { code: null, record, notice: null };
}

// Seat ledger (LAUNCH-RELIABILITY): every launch attempt that passed the pure checks before the claim is one line of
// <runtime>/seat-ledger.jsonl (append-only; .ai/bin/lib/rule-gates.cjs recordSeat): time, seat name, stream, client, model, route,
// outcome (done, failed, refused), the refusal or failure class and the exit code. A usage error (exit 2) is not an attempt, and a
// refusal of the route step, the quota step or the work root writes nothing (PROTO-DEC-0240: such a refusal creates no record or
// file of the launch); their named lines stay on stdout. Under node --test (NODE_TEST_CONTEXT) without --runtime the line is not
// written, so a test never writes into the live runtime.
const SLOT_OPTIONS = { 'seat-cap': [0, 999], 'client-cap': [0, 999], 'slot-wait-min': [0, 1440], 'slot-poll-sec': [1, 600] };
// A policy refusal (a closed cap, an expired cap) is not an attempt: it writes no ledger
// line, no claim, no record and no file (the same rule as the route, quota and work-root
// refusals).
const PURE_REFUSALS = new Set(['QUOTA', 'ASSIGN_DEFERRED', 'WORKROOT', 'SLOT_CAP_ZERO', 'SLOT_CAP_EXPIRED', 'SEAT_DOMAIN', 'PROXY_DOWN', 'PROXY_DOWN_TIMEOUT']); // and every exit before trace.routePassed (the route step)
function proxyRuntime(repo) {
  try { return require('../../.ai/bin/operator/layer.cjs').loadSettings(repo).runtime; }
  catch { return '.ai/runtime'; }
}
// The one launch-record directory: run writes its records there and watch, status and verify read them there, so a host
// that configures the operator-layer runtime never has launches the readers cannot see. --runtime overrides it for all.
const recordsRuntime = o => {
  if (o.runtime) return path.resolve(o.runtime);
  const root = mainRoot(path.resolve(o.repo || process.cwd()));
  return path.resolve(path.join(root, proxyRuntime(root)));
};
// The client of the launch named in the child command, read by the one reader (route-gate launchIdentity, which is seat-failover
// identity); unknown where the route gate module is absent (a host of the pilot kit).
// The module path is a parameter, so the product require closure classifies this load with routeGateStep's optional require(moduleFile).
const childClient = (o, moduleFile = ROUTE_GATE_MODULE) => { try { const id = require(moduleFile).launchIdentity(o.command || []); return id && !id.problem && id.client ? id.client : null; } catch { return null; } };
// The kernel seat launcher the child command starts (cert, fix or run-client), read by the closed entry grammar of the route gate
// (route-gate launchEntry: by the real path of the script in the script position); null for any other command or without the gate module.
const childLauncher = (o, moduleFile = ROUTE_GATE_MODULE) => { try { const e = require(moduleFile).launchEntry(o.command || [], { cwd: process.cwd() }); return e && !e.code && e.launcher ? e.launcher : null; } catch { return null; } };
// Optional host execution extension. Installed launchers keep the same inert
// path unless this launch explicitly asks for assignment.
const ASSIGN_EXECUTE_MODULE = path.join(__dirname, '..', '..', 'tools', 'assign', 'assign-execute.cjs');
function assignRuntimeStep(o, deps, kind, role) {
  const api = deps.assignExecute || require(ASSIGN_EXECUTE_MODULE);
  const env = deps.env || process.env;
  const slotOptions = () => ({ repo: path.resolve(o.repo || process.cwd()), inject: seatSlots.injectedRoots(env),
    caps: require('../../.ai/bin/ops-tools/lib/config.cjs').loadSeatCaps() });
  const activeSeats = () => (deps.seatSlots || seatSlots).runningSeats(slotOptions()).map(s => ({ client: s.client, model: s.model }));
  return api.assignStep(o, { env, launcher: kind, role, intake: deps.intake, assertPath: deps.assertPath, activeSeats,
    modeFile: deps.intake?.modeFile, say: deps.say || (s => process.stdout.write(`${s}\n`)),
    reserve: (r, file) => api.reserve(r, file, deps),
    recheck: (r, context) => {
      const candidate = api.inject(o, r);
      const p = seatPolicyState(candidate, deps);
      if (!p.ok) throw Error(p.code);
      const caps = seatCapsOf(candidate, p.policy, p.now);
      if (caps.zero || caps.expiredReason) throw Error(caps.expiredReason || 'SLOT_CAP_ZERO');
      const slots = (deps.seatSlots || seatSlots).slotState({ ...slotOptions(), policy: p.policy, now: p.now }, caps);
      if (!slots.free) throw Error('SLOT_TIMEOUT');
      const gate = routeGateStep(candidate, { ...deps, routeGate: { ...deps.routeGate, say() {} } });
      if (gate.code !== null || gate.record?.decision !== 'allowed') throw Error('route-gate-unproven');
      // A live route probe may refresh the record. Bind the assignment proof
      // to the bytes AFTER that gate, so its own refresh is not a control edit.
      const checked = require(ASSIGN_EXECUTE_MODULE).recheckLaunch(r, context, { ...deps, activeSeats: activeSeats() });
      const proxy = require('../../.ai/bin/ops-tools/proxy-health.cjs');
      const identity = proxy.route({ client: r.client, model: r.model, argv: candidate.command });
      const runtimeDir = path.resolve(o.runtime || path.join(mainRoot(slotOptions().repo), proxyRuntime(mainRoot(slotOptions().repo))));
      const config = require('../../.ai/bin/ops-tools/lib/config.cjs').load({ root: slotOptions().repo }).proxy;
      if (proxy.needsLocalProxy(identity) && !proxy.available(proxy.readState({ ...identity, runtimeDir, config }), proxy.config(config), context.now)) throw Error('PROXY_DOWN');
      return { ...checked, gate, caps: { client: r.client, clientCap: caps.client, running: slots.running, total: caps.total } };
    }, ...(deps.assignment || {}) });
}
// Both option forms of a child argument (--key VALUE, --key=VALUE), the first one; the launchers refuse a repeat themselves.
function childOption(command, key) {
  for (let i = 0; i < command.length; i++) {
    if (command[i] === `--${key}`) return typeof command[i + 1] === 'string' ? command[i + 1] : undefined;
    if (typeof command[i] === 'string' && command[i].startsWith(`--${key}=`)) return command[i].slice(key.length + 3);
  }
  return undefined;
}
// LAUNCH-RELIABILITY finding 5: the role of the seat. -> { role, inject } or { problem }. inject: append --launch-role to a cert-launch child.
function launchRole(o, kind) {
  const wrapperRole = o['launch-role'];
  const stated = childOption(o.command, 'launch-role');
  for (const [where, v] of [['--launch-role', wrapperRole], ['the child --launch-role', stated]]) {
    if (v !== undefined && !LAUNCH_ROLES.includes(v)) return { problem: `${where} must be one of ${LAUNCH_ROLES.join(', ')}` };
  }
  if (wrapperRole !== undefined && stated !== undefined && wrapperRole !== stated) return { problem: `--launch-role ${wrapperRole} and the child --launch-role ${stated} differ (state the role once)` };
  const role = stated || wrapperRole || (kind === 'fix' ? 'author' : 'unknown');
  return { role, inject: kind === 'cert' && stated === undefined && wrapperRole !== undefined };
}
// LAUNCH-RELIABILITY finding 4: the precert gate of a --certifier launch whose child is not cert-launch (cert-launch runs its own).
// The subject is the one cert-launch gates: the head the child names with --expect-sha (every seat runner of the operator names it).
// A child that names no head certifies nothing and is not gated (precert { applied: false, reason: NO_EXPECT_SHA }); a head of --worktree
// that does not start with it is left to the child's own preflight, as in cert-launch. -> { code: null, command } (command: the child
// command without the precert items) or { code: 2|3 }. The gate module is the one of cert-launch, loaded by a computed path (the pilot kit
// ships no precert gate: without it the step records precert { applied: false, reason: PRECERT_GATE_ABSENT } and lets the launch go, as
// ROUTE_STATE_ABSENT does).
const CERT_LAUNCH_MODULE = path.join(__dirname, 'cert-launch.cjs');
function precertWrapperStep(o, kind, role, runtime, deps, say) {
  if (!o.certifier || kind === 'cert') return { code: null, command: o.command, record: null };
  let failover;
  try { failover = require(path.join(__dirname, 'seat-failover.cjs')); } catch { return { code: null, command: o.command, record: { applied: false, reason: 'PRECERT_GATE_ABSENT' } }; }
  const split = failover.splitPrecert(o.command);
  if (split.problem) { process.stderr.write(`PRECERT REFUSED reason=${split.problem}; nothing was started\n`); return { code: 2 }; }
  if (role === 'author' || role === 'pre-review') return { code: null, command: split.rest, record: { applied: false, reason: `ROLE_${role.toUpperCase().replace('-', '_')}` } };
  const expect = childOption(split.rest, 'expect-sha');
  if (!expect) return { code: null, command: split.rest, record: { applied: false, reason: 'NO_EXPECT_SHA' } };
  let gate;
  try { gate = require(deps.certLaunchModule || CERT_LAUNCH_MODULE); } catch { return { code: null, command: split.rest, record: { applied: false, reason: 'PRECERT_GATE_ABSENT' } }; }
  const spawn = deps.spawnSync || spawnSync;
  const worktree = path.resolve(o.worktree);
  const head = (spawn('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout || '').trim();
  const prompt = childOption(split.rest, 'prompt-file');
  const argv = ['--worktree', worktree, '--expect-sha', expect, '--name', o.name, '--launch-role', role, ...(prompt ? ['--prompt-file', prompt] : [])];
  const refused = gate.precertStep(argv, split.opts, { runtimeDir: runtime, say, spawnSync: spawn, ...(deps.precertFacts ? { precertFacts: deps.precertFacts } : {}), ...(deps.kernelRoot ? { kernelRoot: deps.kernelRoot } : {}) });
  if (refused !== null) return { code: refused };
  return { code: null, command: split.rest, record: { applied: true, role, head } };
}
// The child lines the wrapper reads for finding 1: the spawn decision of seat-failover spawnClient and the named refusals of the launchers.
const SPAWN_LINE = /^SEAT-SPAWN route=(\S+) decision=(allowed|transition|refused)\b/;
const REFUSAL_LINES = [
  [/^[A-Z0-9_.-]+_PRECERT_REFUSED\b|^PRECERT REFUSED\b/, 'PRECERT'],
  [/^[A-Z0-9_.-]+_ROUTE_REFUSED\b|^SEAT-FAILOVER REFUSED\b/, 'ROUTE'],
  [/^[A-Z0-9_.-]+_DONE PREFLIGHT_FAIL\b/, 'PREFLIGHT_HEAD'],
  [/^(?:PACKET|EFFORT|KIMI|QWEN) REFUSED\b/, 'LAUNCHER'],
  [/^WORKROOT REFUSED\b/, 'WORKROOT'],
];
function refusalOf(line) { for (const [re, code] of REFUSAL_LINES) if (re.test(line)) return { code, line: line.slice(0, 300) }; return null; }
// Finding 6: the idle watchdog of a legacy launch. Activity is a child output line or a change in the worktree (the operator layer's own
// definition of the last change: .ai/bin/operator/layer.cjs treeFacts; asked only when the output has been silent past the threshold).
const IDLE_DEFAULT_MINUTES = 30;
function worktreeChange(dir) {
  try {
    const layer = require('../../.ai/bin/operator/layer.cjs');
    const facts = layer.treeFacts([dir]).get(dir);
    const c = facts && facts.change && facts.change.at ? facts.change.at : 0;
    const k = facts && facts.commit && facts.commit.at ? facts.commit.at : 0;
    return Math.max(c, k) || null;
  } catch { return null; }
}
// Stops the child and everything it started (the client under cert-launch): taskkill /T on Windows, else the child itself.
function stopTree(child, deps) {
  if (deps.stopTree) return deps.stopTree(child);
  if (process.platform === 'win32' && child.pid) { const r = spawnSync('taskkill', ['/T', '/F', '/PID', String(child.pid)], { windowsHide: true, encoding: 'utf8' }); if (r.status === 0) return; }
  try { child.kill('SIGKILL'); } catch { /* already gone */ }
}
async function run(o, deps = {}) {
  const trace = { refusal: null, failureClass: null, routePassed: false };
  const t0 = Date.now();
  let code;
  try { code = await runLaunch(o, deps, trace); }
  finally { if (trace.assignment?.active && !trace.assignment.deferred) trace.assignment.cancel(trace.refusal || 'not-started'); }
  if (trace.assignment?.record && !trace.assignment.didSpawn() && code !== 4) {
    const reason = trace.refusal || 'launch-not-started';
    trace.refusal = 'ASSIGN_DEFERRED'; code = 4;
    (deps.say || console.log)(`ASSIGN-DEFERRED reason=${reason}; nothing was started`);
  }
  // a usage error of the wrapper ends before the route step; a child that exits 2 is a launch that ran and is recorded as failed
  if (!trace.routePassed || PURE_REFUSALS.has(trace.refusal) || (!o.runtime && (deps.env || process.env).NODE_TEST_CONTEXT)) return code;
  try {
    const repo = path.resolve(o.repo || process.cwd());
    const runtime = path.resolve(o.runtime || path.join(mainRoot(repo), proxyRuntime(mainRoot(repo))));
    const outcome = code === 0 ? 'done' : trace.refusal ? 'refused' : 'failed';
    const actual = trace.assignment?.record ? trace.assignment.currentOptions() : o;
    require('../../.ai/bin/lib/rule-gates.cjs').recordSeat(runtime, { name: o.name, stream: o.stream, owner: o.owner, client: actual.client || childClient(actual) || null, model: actual.model || null,
      route: actual['route-state'] || (trace.assignment?.record ? actual.route : null), outcome, refusalClass: trace.refusal || (code === 0 ? null : trace.failureClass || 'UNKNOWN'), exitCode: code, ms: Date.now() - t0 });
  } catch { /* the ledger never changes the launch */ }
  return code;
}

// Everything before the claim is a pure check: a refusal here creates nothing (no claim, no temp dir, no file).
async function runLaunch(o, deps = {}, trace = {}) {
  const assignmentNotice = s => trace.assignment?.record && !trace.assignment.didSpawn() ? s.replace(/\bREFUSED\b/g, 'DEFERRED') : s;
  for (const k of ['stream', 'owner', 'name']) if (!o[k]) { process.stderr.write(`run needs --${k}\n`); return 2; }
  if (o.assign !== undefined && o.assign !== 'auto') { process.stderr.write('run: --assign takes the value auto\n'); return 2; }
  const badName = launchNameProblem(o.name);
  if (badName) { process.stderr.write(`${badName}\n`); return 2; }
  if (o.engine && o.engine !== 'legacy' && o.engine !== 'dispatch') { process.stderr.write(`unknown engine ${o.engine} (legacy|dispatch)\n`); return 2; }
  for (const k of ['stall-seconds', 'hard-seconds']) {
    if (o[k] === undefined) continue;
    if (o.engine !== 'dispatch') { process.stderr.write(`--${k} needs --engine dispatch\n`); return 2; }
    const n = Number(o[k]);
    if (!o[k] || !Number.isFinite(n) || n <= 0) { process.stderr.write(`--${k} needs a positive number of seconds\n`); return 2; }
  }
  if (o.task !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,79}$/.test(o.task)) { process.stderr.write('--task needs a task id (letters, digits, dot, dash, underscore, colon, slash; at most 80)\n'); return 2; }
  if (!o.worktree) { process.stderr.write('run needs --worktree (the agent worktree whose HEAD and current branch are watched for commits)\n'); return 2; }
  if (!o.command || !o.command.length) { process.stderr.write('run needs a command after --\n'); return 2; }
  for (const [k, [lo, hi]] of Object.entries(SLOT_OPTIONS)) {
    if (o[k] === undefined) continue;
    if (!/^\d{1,4}$/.test(o[k]) || Number(o[k]) < lo || Number(o[k]) > hi) { process.stderr.write(`--${k} needs a whole number from ${lo} to ${hi}\n`); return 2; }
  }
  // LAUNCH-RELIABILITY: the idle options (whole minutes, 0 = off) and the role of the seat, before anything of the launch exists
  for (const k of ['idle-minutes', 'idle-kill-minutes']) {
    if (o[k] !== undefined && (!/^\d{1,4}$/.test(o[k]) || Number(o[k]) > 1440)) { process.stderr.write(`--${k} needs a whole number of minutes from 0 to 1440\n`); return 2; }
  }
  const idleMin = o['idle-minutes'] !== undefined ? Number(o['idle-minutes']) : IDLE_DEFAULT_MINUTES;
  const idleKillMin = o['idle-kill-minutes'] !== undefined ? Number(o['idle-kill-minutes']) : 0;
  if (idleKillMin && (!idleMin || idleKillMin < idleMin)) { process.stderr.write('--idle-kill-minutes needs --idle-minutes on (not 0) and not above it\n'); return 2; }
  const kind = childLauncher(o);
  const roleOf = launchRole(o, kind);
  if (roleOf.problem) { process.stderr.write(`${roleOf.problem}\n`); return 2; }
  if (roleOf.inject) o.command = [...o.command, '--launch-role', roleOf.role];
  if (o.assign === 'auto') {
    let assignment;
    try { assignment = assignRuntimeStep(o, deps, kind, roleOf.role); }
    catch { assignment = { active: true, deferred: true, reason: 'execution-unavailable' }; }
    trace.assignment = assignment;
    if (assignment.deferred) {
      trace.refusal = 'ASSIGN_DEFERRED';
      const reasons = (assignment.skipped || []).map(r => `rank=${r.rank}:${r.reason}`).join(',');
      (deps.say || console.log)(`ASSIGN-DEFERRED reason=${assignment.reason}${reasons ? ` routes=${reasons}` : ''}; nothing was started`);
      return 4;
    }
    if (assignment.options) o = assignment.options;
  }
  if (o['client-cap'] !== undefined && !(o.client || childClient(o))) { process.stderr.write('--client-cap needs the client of the launch (--client, or --client in the command)\n'); return 2; }
  // SEAT-CAPS (item 5.9): the cap precheck runs BEFORE the route step, before the claim and
  // before any file of the launch exists. A closed cap (zero), an expired cap and a broken
  // policy are refusals: nothing is created, no child starts, and the seat ledger gets no
  // line (a policy refusal is not an attempt).
  const policyState = seatPolicyState(o, deps);
  if (!policyState.ok) {
    process.stderr.write(assignmentNotice(`SEAT-CAP REFUSED reason=${policyState.code}${policyState.detail ? ` detail=${policyState.detail}` : ''}; nothing was started\n`));
    return 2;
  }
  const caps = seatCapsOf(o, policyState.policy, policyState.now);
  if (caps.expiredReason) {
    process.stdout.write(assignmentNotice(`SEAT-CAP REFUSED reason=${caps.expiredReason} client=${caps.clientName || '-'} cap=0; nothing was started\n`));
    trace.refusal = 'SLOT_CAP_EXPIRED';
    return 3;
  }
  if (caps.zero) {
    process.stdout.write(assignmentNotice(`SEAT-CAP REFUSED reason=SLOT_CAP_ZERO client=${caps.clientName || '-'} total=${caps.total === null ? '-' : caps.total} client_cap=${caps.client === null ? '-' : caps.client}; nothing was started\n`));
    trace.refusal = 'SLOT_CAP_ZERO';
    return 3;
  }
  let gate = routeGateStep(o, trace.assignment?.record ? { ...deps, routeGate: { ...deps.routeGate, say: s => process.stdout.write(`${assignmentNotice(s)}\n`) } } : deps);
  if (gate.code !== null) return gate.code;
  trace.routePassed = true;
  // Opt-in only; OFF executes no finance code or I/O and keeps legacy output/argv.
  if (o['quota-request'] !== undefined && !trace.assignment?.record) {
    const q = require('./quota-launch-hook.cjs').beforeLaunch(o, deps);
    if (!q || q.status !== 'allow') {
      process.stdout.write(`QUOTA ${q && q.status || 'ask-owner'} reason=${q && q.reason || 'preflight-unavailable'}\n`);
      trace.refusal = 'QUOTA';
      return 3;
    }
  }
  const repo = path.resolve(o.repo || process.cwd());
  const runtime = path.resolve(o.runtime || path.join(mainRoot(repo), proxyRuntime(mainRoot(repo))));
  const emitChunk = deps.write || (s => process.stdout.write(s));
  const rawSay = deps.say || (s => emitChunk(`${s}\n`));
  const say = s => rawSay(assignmentNotice(s));
  const domain = seatSlots.domainRoots({ repo, inject: seatSlots.injectedRoots(deps.env || process.env) });
  // The domain rule (item 5.9): the runtime of a launch must be a root of the domain the
  // counter reads, otherwise the seat would live where no counter sees it. The domain is the
  // kernel runtime under the main root, the operator-kit root under the git common dir and
  // the injected roots of a fixture. A runtime outside it is refused before anything exists.
  if (!domain.roots.some(root => seatSlots.normalizeRoot(root) === seatSlots.normalizeRoot(runtime))) {
    say(`SEAT-DOMAIN REFUSED reason=SEAT-DOMAIN-REFUSED runtime=${runtime} domain=${domain.roots.join(',') || '-'}; nothing was started`);
    trace.refusal = 'SEAT_DOMAIN';
    return 3;
  }
  const proxy = require('../../.ai/bin/ops-tools/proxy-health.cjs');
  if (o['proxy-wait-min'] !== undefined && (!/^\d{1,4}$/.test(o['proxy-wait-min']) || Number(o['proxy-wait-min']) > 1440)) { say('PROXY_CONFIG: --proxy-wait-min needs whole minutes 0..1440'); return 2; }
  let proxyClient = o.client || childClient(o) || (/^cline(?:\.exe|\.cmd)?$/i.test(path.basename(o.command[0])) ? 'cline' : '');
  let proxyRoute;
  try { proxyRoute = proxy.route({ client: proxyClient, model: o.model, argv: o.command }); } catch { say('PROXY_ROUTE REFUSED'); return 2; }
  const proxyConfig = require('../../.ai/bin/ops-tools/lib/config.cjs').load({ root: repo }).proxy;
  let proxyOptions = { ...proxyRoute, argv: o.command, runtimeDir: runtime, config: proxyConfig, waitMs: Number(o['proxy-wait-min'] ?? 45) * 60000, onWait: say, ...(deps.proxy || {}) };
  let taskBefore;
  if (o['task-file']) { try { taskBefore = require('../../.ai/bin/ops-tools/proxy-seats.cjs').facts(o.worktree, o['task-file']); } catch { say('PROXY_TASK REFUSED'); return 2; } }
  const proxyGate = await proxy.waitForProxy(proxyOptions);
  if (!proxyGate.ok) { trace.refusal = proxyGate.reason; say(`${proxyGate.reason}; nothing was started`); return 3; }
  if (taskBefore) { const after = require('../../.ai/bin/ops-tools/proxy-seats.cjs').facts(o.worktree, o['task-file']); if (JSON.stringify(after) !== JSON.stringify(taskBefore)) { say('PROXY_TASK_CHANGED; nothing was started'); return 3; } }
  if (o['proxy-continue'] && (!taskBefore || roleOf.role !== 'author')) { say('PROXY_CONTINUE requires author role and --task-file'); return 2; }
  // PROTO-DEC-0240 item 2: the transition line of a launch whose client is known, after the quota step (the same text is in its records).
  if (gate.notice) process.stderr.write(`${gate.notice}\n`);
  // Launch isolation: a pure check before the claim; a refusal here creates nothing (no claim, no temp dir, no file, no child).
  const envBase = deps.env || process.env;
  const root = workRoot.resolveWorkRoot(repo, envBase, deps.fs || fs);
  const refusal = workRoot.workRootRefusal(root, envBase, deps.fs || fs);
  if (refusal) { say(`WORKROOT REFUSED reason=${refusal.reason} root=${refusal.root}; ${refusal.recovery}; nothing was started`); trace.refusal = 'WORKROOT'; return 3; }
  // LAUNCH-RELIABILITY finding 4: the precert gate of a certifier seat whose child is not cert-launch, before the slot wait and the claim
  const pre = precertWrapperStep(o, kind, roleOf.role, runtime, deps, say);
  if (pre.code !== null) { if (pre.code === 3) trace.refusal = 'PRECERT'; return pre.code; }
  o.command = pre.command;
  // WRITE-BOUNDARY (P-149): the drive root listing of the seat window. A counted entry that is still present is the one
  // refusal of this step; every other outcome is a warning plus an audit counter. It runs before the claim: a refusal
  // creates no claim, no temp dir, no record and no child.
  const boundary = writeBoundary.prepare({ workRootDir: root.dir, env: envBase, repo, runtime });
  if (boundary.note) say(boundary.note);
  if (boundary.refusal) {
    say(`${boundary.refusal.line}; ${boundary.refusal.recovery}; nothing was started`);
    return 3;
  }
  if (!boundary.applied && !['boundary-drive-not-in-allow-file', 'ALLOW_FILE_MISSING'].includes(boundary.reason)) {
    say(`WRITE-BOUNDARY skipped reason=${boundary.reason}${boundary.allowFile ? ` allow=${boundary.allowFile}` : ''}`);
  }
  // LAUNCH-RELIABILITY: the wrapper waits for a free slot BEFORE it takes the claim, so the
  // claim's ttl starts when the seat can start and never lapses in the queue. The wait polls every --slot-poll-sec (default 20)
  // and gives up after --slot-wait-min (default 45): SLOT REFUSED, exit 3, nothing created.
  // SEAT-CAPS (item 5.9): the policy is the only operational source of the caps. The policy
  // and the clock are read again on every tick, and once more at the admission step, after the
  // wait and before the claim and the spawn.
  if (caps.total !== null || caps.client !== null || caps.route !== null || o['seat-cap'] !== undefined || o['client-cap'] !== undefined) {
    const slots = deps.seatSlots || require('../../.ai/bin/lib/seat-slots.cjs');
    const waitMs = Number(o['slot-wait-min'] ?? 45) * 60000;
    const pollMs = Number(o['slot-poll-sec'] ?? 20) * 1000;
    const waitStart = policyState.now;
    let state = null;
    let live = caps;
    for (;;) {
      const fresh = seatPolicyState(o, deps);
      if (!fresh.ok) { say(`SEAT-CAP REFUSED reason=${fresh.code}; nothing was started`); trace.refusal = 'SLOT_CAP_ZERO'; return 3; }
      live = seatCapsOf(o, fresh.policy, fresh.now);
      if (live.expiredReason) { say(`SEAT-CAP REFUSED reason=${live.expiredReason}; nothing was started`); trace.refusal = 'SLOT_CAP_EXPIRED'; return 3; }
      if (live.zero) { say(`SEAT-CAP REFUSED reason=SLOT_CAP_ZERO; nothing was started`); trace.refusal = 'SLOT_CAP_ZERO'; return 3; }
      state = slots.slotState({ runtimeDir: runtime, repo, now: fresh.now, policy: fresh.policy, caps: require('../../.ai/bin/ops-tools/lib/config.cjs').loadSeatCaps(), inject: seatSlots.injectedRoots(deps.env || process.env) }, { total: live.total, client: live.client, clientName: live.clientName, route: live.route, routeName: live.routeName });
      if (state.free) break;
      if (fresh.now - waitStart >= waitMs) break;
      say(`SLOT WAIT running=${state.running} cap=${live.total ?? '-'} client=${live.clientName || '-'} ${state.sameClient}/${live.client ?? '-'}`);
      await sleep(pollMs);
    }
    if (!state.free) {
      say(`SLOT REFUSED reason=SLOT_TIMEOUT running=${state.running} cap=${live.total ?? '-'} client=${live.clientName || '-'} ${state.sameClient}/${live.client ?? '-'} waited=${Math.round(waitMs / 1000)}s; nothing was started`);
      trace.refusal = 'SLOT_TIMEOUT';
      return 3;
    }
    say(`SLOT free running=${state.running} cap=${live.total ?? '-'} client=${live.clientName || '-'} ${state.sameClient}/${live.client ?? '-'}`);
  }
  const proxyLast = await proxy.waitForProxy({ ...proxyOptions, waitMs: 0 });
  if (!proxyLast.ok) { trace.refusal = proxyLast.reason; say(`${proxyLast.reason}; nothing was started`); return 3; }
  // The admission step follows both waits. Re-read before reservations, claim and spawn:
  // a policy closed or expired during the last asynchronous proxy check still refuses.
  const admission = seatPolicyState(o, deps);
  if (!admission.ok) { say(`SEAT-CAP REFUSED reason=${admission.code}; nothing was started`); trace.refusal = 'SLOT_CAP_ZERO'; return 3; }
  const admitted = seatCapsOf(o, admission.policy, admission.now);
  if (admitted.expiredReason) { say(`SEAT-CAP REFUSED reason=${admitted.expiredReason}; nothing was started`); trace.refusal = 'SLOT_CAP_EXPIRED'; return 3; }
  if (admitted.zero) { say(`SEAT-CAP REFUSED reason=SLOT_CAP_ZERO; nothing was started`); trace.refusal = 'SLOT_CAP_ZERO'; return 3; }
  let proxyReservation = null;
  const proxySeats = require('../../.ai/bin/ops-tools/proxy-seats.cjs');
  if (proxy.needsLocalProxy(proxyRoute) && o['proxy-continue']) {
    try {
      if (o['proxy-attempt']) {
        const dir = proxySeats.directory(runtime); const file = proxySeats.reservationFile(dir, proxy.canonical(o.worktree));
        const card = proxySeats.validate(proxy.readJson(dir, file));
        if (card.attempt !== o['proxy-attempt'] || card.name !== o.name || card.owner !== o.owner || !['reserved', 'spawned'].includes(card.state)) throw new Error('PROXY_ATTEMPT');
        const current = proxySeats.facts(o.worktree, o['task-file']);
        if (current.worktree !== card.worktree || current.taskFile !== card.taskFile || current.taskSha256 !== card.taskSha256 || current.branch !== card.branch || current.head !== card.head) throw new Error('PROXY_ATTEMPT_CHANGED');
        proxySeats.candidate(card);
        proxyReservation = { dir, file, card };
      } else {
        const replay = [process.execPath, __filename, 'run'];
        for (const [key, value] of Object.entries(o)) {
          if (['_', 'command', 'proxy-attempt'].includes(key)) continue;
          if (value === true) replay.push(`--${key}`); else if (typeof value === 'string') replay.push(`--${key}`, value);
        }
        replay.push('--', ...o.command);
        proxyReservation = proxySeats.reserve({ ...proxyRoute, name: o.name, stream: o.stream, owner: o.owner, worktree: o.worktree, taskFile: o['task-file'], runtimeDir: runtime,
          registryFile: o.registry || path.join(runtime, 'CANDIDATES.md'), launchRole: roleOf.role, argv: replay, effort: o.effort, engineMode: o.engine, caps: { seat: o['seat-cap'] || null, client: o['client-cap'] || null } });
      }
    } catch (e) { say(`PROXY_RESERVATION REFUSED ${e.message}`); return 3; }
  }
  const attemptId = proxyReservation ? proxyReservation.card.attempt : require('node:crypto').randomUUID();
  const completionMarker = kind === 'cert' && roleOf.role === 'author' ? seatMarker(o.name, roleOf.role) : null;
  const proxyTracker = proxy.tracker(completionMarker || o.name.toUpperCase(), attemptId, proxy.endpoint(proxy.config(proxyOptions.config)));
  // The transport event of the Cline HTTP adapter is bound to the attempt and the endpoint, so a launch that really
  // uses the local proxy hands both to the child. Every other launch keeps the child environment byte identical to
  // the one before this package (tests/quotas.test.cjs S5-23).
  const proxyEnv = proxy.needsLocalProxy(proxyRoute) ? { COLABUS_PROXY_ATTEMPT: attemptId, COLABUS_PROXY_ENDPOINT: proxyTracker.endpoint } : {};
  let proxyLease;
  try { if (proxy.needsLocalProxy(proxyRoute)) proxyLease = proxySeats.lease(runtime, o.worktree, attemptId); }
  catch (e) { say(`PROXY_RESERVATION REFUSED ${e.message}`); return 3; }
  let claimed = false;
  const release = () => {
    try {
      if (!claimed) return;
      let r;
      // The transaction already waits for contention. One further idempotent
      // release covers a failed guard subprocess; a refusal remains explicit.
      for (let attempt = 0; attempt < 2; attempt++) {
        r = guard(o, ['release', '--stream', o.stream, '--owner', o.owner, '--seat', o.name]);
        if (r.status === 0) break;
      }
      if (r.status !== 0) throw Object.assign(Error(`CLAIM_RELEASE_FAILED code=${r.status === null ? 'SPAWN' : r.status}`), { code:'CLAIM_RELEASE_FAILED' });
      claimed = false;
      markClaimReleased(runtime, o.name, st.base.startedAt);
    } finally {
      if (proxyLease) { const r = proxyLease; proxyLease = null; r(); }
    }
  };
  // st: what has happened so far, so that the catch below can finish exactly what is still open (temp dir, terminal record, claim, child)
  const st = { started: false, child: null, temp: null, terminal: false, log: null, ring: [], launchTmp: null, base: { name: o.name, stream: o.stream, task: o.task || o.stream, owner: o.owner, wrapperPid: process.pid, startedAt: new Date().toISOString(), command: o.command[0], client: caps.clientName, model: caps.model || null, certifier: Boolean(o.certifier), routeGate: gate.record, launchRole: roleOf.role, ...(completionMarker ? { completionMarker } : {}), spawnProof: kind && gate.record && gate.record.applied !== false ? 'seat-spawn-line' : 'none', ...(pre.record ? { precert: pre.record } : {}) } };
  const settleTemp = (failed, why) => { if (!st.temp) st.temp = finishLaunchTmp(st.launchTmp, failed, why); return st.temp; };
  const record = result => {
    const actuallyStarted = trace.assignment?.record ? trace.assignment.didSpawn() : st.started;
    if (trace.assignment?.record && !actuallyStarted) result = { ...result, exitCode: 4 };
    if (st.base.assignLaunch) st.base.assignLaunch = { ...st.base.assignLaunch, outcome: {
      status: !actuallyStarted ? 'not-started' : result.status === 'DONE' ? 'done' : 'failed',
      failureClass: actuallyStarted ? result.failureClass || null : null, wallSeconds: null, verdicts: [], closedAt: new Date().toISOString()
    } };
    if (st.started && st.base.launchRole === 'author') {
      result = seatPersistence.terminal(st.base, result);
      st.persistenceBlocked = Boolean(result.seatPersistence.blocked);
      say(`SEAT-PERSISTENCE name=${o.name} state=${result.seatPersistence.state}`);
    }
    trace.failureClass = result.failureClass || null;
    try {
      writeTerminal(runtime, o.name, st.base, result); st.terminal = true;
      if (proxyReservation) {
        const card = proxyReservation.card;
        const launch = require('../../.ai/bin/launch-record.cjs').writeLaunchRecord({ name: o.name, client: proxyClient, model: o.model, effort: o.effort,
          startedAt: st.base.startedAt, endedAt: new Date().toISOString(), exitCode: result.exitCode, failureClass: result.failureClass,
          launchRole: roleOf.role, attempt: card.budget + 1, ...(card.launchId ? { retryOf: card.launchId } : {}),
          note: `proxy-attempt=${card.attempt} retryOf=${card.retryOf || 'none'} reason=${result.failureClass || result.status}` }, { pendingDir: path.join(runtime, 'launch-record-pending'), skipDue: true });
        proxySeats.change(proxyReservation, { state: result.failureClass === 'PROXY_DROP' ? 'pending' : 'released', pid: null, launchId: launch.record.launchId,
          dropId: result.failureClass === 'PROXY_DROP' ? (proxy.readState(proxyOptions) || {}).dropId || null : null });
      }
    } finally { release(); }
  };
  st.proxy = { tracker: proxyTracker, options: proxyOptions, attempt: attemptId, env: proxyEnv };

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
      const c = guard(o, ['claim', '--stream', o.stream, '--owner', o.owner, ...(o.worktree ? ['--worktree', o.worktree] : []), '--ttl', String(o.ttl || 120), '--seat', o.name]);
      say(`${c.stdout.trim()}${c.stderr.trim()}`);
      if (c.status !== 0) { release(); say('LAUNCH REFUSED by the claim; nothing was started'); trace.refusal = 'CLAIM'; return 3; }
      claimed = true;
      const files = (o['pin-files'] || '').split(',').filter(Boolean);
      const g = guard(o, ['launch-gate', '--stream', o.stream, '--owner', o.owner, '--seat', o.name, ...files]);
      say(g.stdout.trim());
      if (g.status !== 0) { release(); say('LAUNCH REFUSED by the gate; nothing was started'); trace.refusal = /PIN_HTML_REFUSED/.test(g.stdout) ? 'TASK_FILE' : 'LAUNCH_GATE'; return 3; }
    }

    const startedAt = st.base.startedAt;
    st.base.wrapperLaunchId = `${o.name}@${startedAt}`;
    // the per-launch directory exists or the launch closes as FAILED (abort path); the child never inherits a temp dir outside the work root
    // DISK-LEAKS dli1: the sweep of dead launchers' directories and the cap on kept ones runs before this launch makes its own; it never throws
    const tempSweep = workRoot.sweepLaunchRoots(root, { io: deps.fs || fs, report: say });
    st.base.tempSweep = tempSweep;
    try { st.launchTmp = prepareLaunchTmp(o.name, root, process.pid); }
    catch (e) { if (e.launchTmp) { st.launchTmp = e.launchTmp; st.temp = e.tempDir; } throw Object.assign(new Error(`work root per-launch directory failed: ${e.message}`), { code: e.code || 'WORKROOT_LAUNCH_DIR_FAILED' }); }
    const launchTmp = st.launchTmp;
    let resolver = null, intake = null;
    try {
      intake = trace.assignment?.intake || require('../../tools/assign/launch-intake.cjs').capture({ launcher: 'launch-wrapper', name: o.name, launchId: null,
        worktree: path.resolve(o.worktree), taskFile: o['task-file'] || childOption(o.command, 'task-file') || childOption(o.command, 'prompt-file') || (o['pin-files'] || '').split(',').filter(Boolean)[0],
        base: o['selection-base'] || childOption(o.command, 'selection-base'),
        deviationReason: o['deviation-reason'] || childOption(o.command, 'deviation-reason'),
        role: roleOf.role !== 'unknown' ? roleOf.role : o.role || (o.certifier ? 'certifier' : 'unknown'),
        say, ownerExplicit: Boolean(o.client || o.model || childOption(o.command, 'client') || childOption(o.command, 'model')),
        operator: { client: o.client || null, model: o.model || null, effort: o.effort || null },
        advisoryOperator: { client: o.client || childOption(o.command, 'client') || null, model: o.model || childOption(o.command, 'model') || null, effort: o.effort || childOption(o.command, 'effort') || null } },
      { ...(deps.intake || {}), resolverShadow: deps.resolverShadow, runtimeDir: runtime });
      const sh = intake.shadow;
      resolver = { ...sh.resolver, taskClass: sh.taskClass, role: sh.role, operator: sh.operator };
    } catch (e) { resolver = { choice: null, candidates: [], reason: null, ladderVersion: null, error: 'resolver-error', detail: String((e && e.message) || e).slice(0, 200) }; }
    const base = st.base = { ...st.base, tempSweep, startedAt, worktree: path.resolve(o.worktree), ...(launchTmp ? { tempDir: launchTmp.dir } : {}), resolver,
      ...(intake ? { taskFrame: intake.taskFrame, selectionShadow: intake.selectionShadow, riskClass: intake.taskFrame.riskClass, tier: intake.taskFrame.tier } : { riskClass: 'A' }) };
    // Only an explicit auto request outside the active execution path can be
    // deferred here. Inert and owner-chosen launches keep their existing path;
    // active assignments already carry the cached intake and fenced decision.
    if (o.assign === 'auto' && !trace.assignment?.inert && !trace.assignment?.record && intake?.selectionShadow.advice?.status !== 'owner-choice') {
      const reason = intake?.selectionShadow.advice?.reason || 'intake-unavailable';
      const tempDir = settleTemp(false, 'ASSIGN_DEFERRED');
      trace.refusal = 'ASSIGN_DEFERRED';
      record({ status: 'FAILED', exitCode: 4, signal: null, failureClass: 'UNKNOWN', reason: `assign-deferred:${reason}`, tempDir });
      release(); say(`ASSIGN-DEFERRED reason=${reason}; nothing was started`); return 4;
    }
    // Launch isolation: the full child environment is built by the shared work-root module, which removes every case variant of the
    // overridden names from the base first (a parent NPM_CONFIG_CACHE would otherwise coexist with our npm_config_cache and win on Windows).
    const env = { ...require('../../.ai/bin/lib/seat-heavy.cjs').seatEnv(workRoot.childLaunchEnv(process.env, launchTmp ? launchTmp.dir : null), o.name), LAUNCH_WRAPPER_NAME: o.name, LAUNCH_WRAPPER_ID: st.base.wrapperLaunchId,
      ...proxyEnv,
      ...(o['cycle-control'] ? {OPS_RUNTIME_DIR:runtime,CYCLE_CONTROL:'1'} : {}) };
    if (o.certifier) env.PROTOCOL_NO_FULL_SUITE = '1';
    // the route check of a seat switch inside the child (seat-failover) reads the same record the route step read; the default record adds nothing
    if (gate.record && gate.record.recordFile) env[ROUTE_STATE_FILE_ENV] = gate.record.recordFile;
    const handed = handedDecision(gate.record);
    if (handed) env[ROUTE_DECISION_ENV] = handed; else if (env[ROUTE_DECISION_ENV] !== undefined) env[ROUTE_DECISION_ENV] = '';
    const snapDir = path.resolve(o.worktree);
    const snapBefore = snapshot(snapDir);
    if (roleOf.role === 'author') st.base.seatPersistenceBefore = seatPersistence.capture(snapDir);
    // The seat window starts here: the wrapper's own per-launch directory already exists, so it is not a new entry. A boundary
    // that cannot be read never blocks the launch; it is recorded as a problem in the terminal record's writeBoundary field.
    const boundaryBefore = writeBoundary.begin(boundary);
    const settleBoundary = () => {
      if (!boundary.applied || !boundaryBefore) return boundary.applied ? null : { applied: false, reason: boundary.reason };
      try { return writeBoundary.settle({ ctx: boundary, before: boundaryBefore, launchName: o.name }); }
      catch (e) { return { applied: true, checked: false, problem: { code: 'BOUNDARY_SETTLE_FAILED', detail: String((e && e.message) || e).slice(0, 160) } }; }
    };
    const ring = st.ring;
    const log = st.log = o.log ? fs.createWriteStream(path.resolve(o.log), { flags: 'a' }) : null;
    // the last `USAGE ...` line of the child (cert-launch.cjs and fix-launch.cjs print one when the client told its tokens) is copied into the terminal record
    // LAUNCH-RELIABILITY: every child line is activity for the idle watchdog; the SEAT-SPAWN decision and a named launcher refusal are kept (finding 1)
    st.lastOutput = Date.now();
    const onLine = l => {
      const m = SPAWN_LINE.exec(l);
      if (m && m[2] !== 'refused' && !st.seatSpawn) { st.seatSpawn = { at: new Date().toISOString(), route: m[1].slice(0, 200), decision: m[2] }; st.markRunning && st.markRunning(); }
      const r = !st.refusal && refusalOf(l);
      if (r) { st.refusal = r; st.markRunning && st.markRunning(); }
    };
    let pendingLine = '';
    const push = (chunk, channel = 'stdout') => {
      if (channel === 'stdout') proxyTracker.push(chunk);
      const s = String(chunk); if (log) log.write(s); emitChunk(s); st.lastOutput = Date.now();
      // Stderr diagnostics cannot enter a structured stdout frame. Preserve
      // their existing fragment order in the diagnostic ring.
      if (channel === 'stderr') {
        for (const l of s.split(/\r?\n/)) if (l.trim()) { ring.push(l.slice(0, 300)); if (ring.length > 20) ring.shift(); onLine(l.trim()); }
        return;
      }
      // A pipe chunk need not end at a line boundary. Bound the carry, including
      // enormous message lines; a suffix of a long line cannot forge a frame.
      const lines = (pendingLine + s).split('\n'); pendingLine = lines.pop();
      for (const raw of lines) {
        const l = raw.replace(/\r$/, '');
        if (!l.trim()) continue;
        ring.push(l.slice(0, 300)); if (ring.length > 20) ring.shift();
        if (/^USAGE /.test(l)) st.usageLine = l.trim().slice(0, 300);
        if (l.startsWith('USAGE_JSON ')) st.usageFields = require('../../.ai/bin/accounting/lib/run-usage.cjs').parseFrame(l);
        onLine(l.trim());
      }
      if (pendingLine.length > 8192) pendingLine = '\0';
    };
    let finished = false;
    const finish = async (exitCode, signal, reason) => {
      if (finished) return 1;
      finished = true;
      if (pendingLine) push('\n');
      const text = ring.join('\n');
      const validCode = (Number.isInteger(exitCode) && exitCode >= 0) ? exitCode : null;
      const ok = validCode === 0 && !signal;
      const detected = commitNote(snapBefore, snapshot(snapDir));
      if (detected && detected.line) { const w = `${detected.line}\n`; if (log) log.write(w); emitChunk(w); }
      const note = detected ? (detected.note || detected) : null;
      const textClass = ok ? null : classify(validCode, signal, `${text}\n${reason || ''}`);
      // finding 6: a kill by the idle watchdog is IDLE; a failed launch still idle at its end with no more specific class is IDLE too
      let failureClass = ok ? null : st.idleKilled ? 'IDLE' : (st.idle && (textClass === 'UNKNOWN' || textClass === 'INTERRUPTED') ? 'IDLE' : textClass);
      proxyTracker.end();
      if (proxy.needsLocalProxy(proxyRoute) && proxyTracker.signal && !proxyTracker.final && !signal && !st.idleKilled) {
        let s; try { s = await proxy.refresh(proxyOptions); } catch { /* unknown never retries */ }
        failureClass = proxy.classifyProxyDrop({ signal: proxyTracker.signal, attempt: attemptId, endpoint: proxyTracker.endpoint, final: proxyTracker.final, exitCode: validCode, failureClass, down: s && s.state === 'down', stopped: fs.existsSync(path.join(runtime, `${o.name}.stopped.json`)) }) || failureClass;
      }
      const boundaryResult = settleBoundary();
      if (boundaryResult && boundaryResult.note) { const w = `${boundaryResult.note}\n`; if (log) log.write(w); emitChunk(w); }
      if (boundaryResult && boundaryResult.warning) { const w = `${boundaryResult.warning}\n`; if (log) log.write(w); emitChunk(w); }
      const tempDir = settleTemp(!ok, failureClass);
      const tl = tempLine(tempDir);
      if (tl) { if (log) log.write(tl); emitChunk(tl); }
      if (st.idleTimer) clearInterval(st.idleTimer);
      record({ status: ok ? 'DONE' : 'FAILED', exitCode: validCode, signal, failureClass, reason: reason || (st.idleKilled ? `idle for ${idleKillMin} min (no output, no worktree change): the child tree was stopped` : null), lastLines: ring.slice(), note, tempDir, usage: st.usageLine, usageFields: st.usageFields, seatSpawn: st.seatSpawn, refusal: st.refusal, idle: st.idle, writeBoundary: boundaryResult });
      release();
      if (log) log.end();
      return st.persistenceBlocked ? 1 : ok ? 0 : (validCode !== null && validCode !== 0 ? validCode : 1);
    };

    if (o.engine === 'dispatch') {
      const gate = await proxy.waitForProxy({ ...proxyOptions, waitMs: 0 });
      if (!gate.ok) return await finish(null, null, gate.reason);
      return await engineRun({ o, deps, repo, runtime, base, snapDir, snapBefore, ring, log, push, release, launchTmp, st, settleTemp, record, settleBoundary });
    }
    // the running record keeps its meaning "the child exists" (consumers wait for the file and read childPid), so it is written after the spawn; a runtime directory that
    // cannot be written is found out BEFORE the child starts, by a probe file, and stops the launch while nothing runs
    ensureWritable(runtime);
    const preSpawnProxy = await proxy.waitForProxy({ ...proxyOptions, waitMs: 0 });
    const preSpawnTask = taskBefore ? proxySeats.facts(o.worktree, o['task-file']) : null;
    if (!preSpawnProxy.ok || (taskBefore && JSON.stringify(taskBefore) !== JSON.stringify(preSpawnTask))) {
      trace.refusal = preSpawnProxy.reason || 'TASK_FILE';
      return await finish(null, null, preSpawnProxy.reason || 'PROXY_TASK_CHANGED');
    }
    return await new Promise((resolve, reject) => {
      try {
        let child;
        if (trace.assignment?.record) {
          try {
            base.assignLaunch = trace.assignment.finalCheck();
            o = trace.assignment.currentOptions();
            gate = trace.assignment.currentFacts().gate || gate;
            base.client = o.client; base.model = o.model; base.routeGate = gate.record;
            proxyClient = o.client;
            proxyRoute = proxy.route({ client: o.client, model: o.model, argv: o.command });
            proxyOptions = { ...proxyOptions, ...proxyRoute, argv: o.command };
            st.proxy.options = proxyOptions;
            if (proxy.needsLocalProxy(proxyRoute)) {
              env.COLABUS_PROXY_ATTEMPT = attemptId; env.COLABUS_PROXY_ENDPOINT = proxyTracker.endpoint;
              if (!proxyLease) proxyLease = proxySeats.lease(runtime, o.worktree, attemptId);
            } else { delete env.COLABUS_PROXY_ATTEMPT; delete env.COLABUS_PROXY_ENDPOINT; }
            const currentHanded = handedDecision(gate.record);
            if (currentHanded) env[ROUTE_DECISION_ENV] = currentHanded;
            else if (env[ROUTE_DECISION_ENV] !== undefined) env[ROUTE_DECISION_ENV] = '';
            if (taskBefore && JSON.stringify(taskBefore) !== JSON.stringify(proxySeats.facts(o.worktree, o['task-file']))) throw Error('task-changed');
            trace.assignment.beforeSpawn();
          }
          catch (e) {
            trace.refusal = 'ASSIGN_DEFERRED';
            trace.assignment.cancel(e.code || e.message);
            base.assignLaunch = { ...trace.assignment.record, outcome: { status: 'not-started', failureClass: null, wallSeconds: null, verdicts: [], closedAt: new Date().toISOString() } };
            const tempDir = settleTemp(false, 'ASSIGN_DEFERRED');
            record({ status: 'FAILED', exitCode: 4, signal: null, failureClass: 'UNKNOWN', reason: `assign-deferred:${e.code || e.message}`, tempDir });
            say(`ASSIGN-DEFERRED reason=${e.code || e.message}${e.skipped ? ` routes=${e.skipped.map(r => `${r.rank}:${r.reason}`).join(',')}` : ''}; nothing was started`);
            resolve(4); return;
          }
        }
        try { child = (deps.spawn || spawn)(o.command[0], o.command.slice(1), { env, cwd: process.cwd(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }); } catch (e) { resolve(finish(null, null, `spawn failed: ${e.message}`)); return; }
        st.lastOutput = Date.now();
        st.child = child;
        if (trace.assignment?.record && Number.isInteger(child.pid) && child.pid > 0) trace.assignment.markSpawned();
        if (proxyReservation) proxySeats.change(proxyReservation, { state: 'spawned', pid: child.pid });
        st.started = true;
        const stopControl = require('./lib/cycle-stop.cjs').watchStop({runtime,name:o.name,startedAt,worktree:base.worktree,child,onNotice:s=>say(`CYCLE-STOP ${s}`)});
        child.on('close',()=>stopControl.close());
        child.on('error',()=>stopControl.close());
        const runningFile = path.join(runtime, `${o.name}.running.json`);
        const runningBase = { ...base, childPid: child.pid, cycleStop:true };
        writeJson(runningFile, runningBase);
        if (trace.assignment?.record) trace.assignment.published();
        // the running record follows the spawn proof, the refusal and the idle flag (written only while the launch is not finished)
        st.markRunning = () => { if (finished) return; try { writeJson(runningFile, { ...runningBase, ...(st.seatSpawn ? { seatSpawn: st.seatSpawn } : {}), ...(st.refusal ? { refusal: st.refusal } : {}), ...(st.idle ? { idle: st.idle } : {}) }); } catch { /* the record stays as it was */ } };
        if (st.seatSpawn || st.refusal) st.markRunning();
        // finding 6: the idle watchdog (deps.idle { tickMs, minuteMs, now, lastChange } is for the tests)
        if (idleMin > 0) {
          const di = deps.idle || {};
          const minuteMs = di.minuteMs || 60000;
          const now = di.now || Date.now;
          const lastChangeOf = di.lastChange || worktreeChange;
          st.idleTimer = setInterval(() => {
            if (finished) return;
            const t = now();
            let last = st.lastOutput;
            if (t - last >= idleMin * minuteMs) { const w = lastChangeOf(base.worktree); if (Number.isFinite(w) && w > last) last = w; }
            const idleMs = t - last;
            if (idleMs >= idleMin * minuteMs) {
              if (!st.idle) {
                st.idle = { since: new Date(last).toISOString(), flaggedAt: new Date(t).toISOString(), minutes: idleMin };
                say(`SEAT-IDLE name=${o.name} idle=${Math.floor(idleMs / minuteMs)}m since=${st.idle.since} (no output and no worktree change; a client waiting for a permission prompt looks the same)`);
                st.markRunning();
              }
              if (idleKillMin && idleMs >= idleKillMin * minuteMs && !st.idleKilled) {
                st.idleKilled = true;
                say(`SEAT-IDLE-STOP name=${o.name} idle=${Math.floor(idleMs / minuteMs)}m limit=${idleKillMin}m; the child tree is stopped and the launch ends FAILED class IDLE`);
                stopTree(child, deps);
              }
            } else if (st.idle && !st.idleKilled) {
              say(`SEAT-ACTIVE name=${o.name} after=${Math.floor((t - Date.parse(st.idle.since)) / minuteMs)}m`);
              st.idle = null;
              st.markRunning();
            }
          }, di.tickMs || Math.min(60000, minuteMs));
          if (st.idleTimer.unref) st.idleTimer.unref();
        }
        child.stdout.on('data', push);
        child.stderr.on('data', chunk => push(chunk, 'stderr'));
        child.on('error', e => { finish(null, null, `spawn error: ${e.code || e.message}`).then(resolve, reject); });
        child.on('close', (code, signal) => { finish(code, signal, null).then(resolve, reject); });
      } catch (e) { reject(e); }
    });
  } catch (err) {
    return abort(err);
  }
}

// ---- --engine dispatch: the command runs through the L4 executor, under its liveness, lease and leaf-first stop ----

const ENGINE_STATE_DIR = '.ai/runtime/dispatch-wrapper';
// engine classes that map straight onto a launch-record/1 class; the two vocabularies are separate layers
const ENGINE_CLASS_MAP = { AUTH_ERROR: 'AUTH', RATE_LIMIT: 'QUOTA', QUOTA_EXHAUSTED: 'QUOTA', NETWORK_ERROR: 'TRANSPORT', PROVIDER_ERROR: 'TRANSPORT' };

// launch-record/1 failure class of an engine result: STALL stays STALL, the hard ceiling is a supervisor kill (INTERRUPTED),
// a missing declared output is CONTENT, an unrecorded survivor is ORPHAN; a class the executor recognized maps directly,
// everything else keeps the legacy text classification of the child's own output.
function engineFailureClass(res, text) {
  if (!res || res.status === 'DONE') return null;
  if ((res.unrecordedProcesses || []).length || /^(?:attempt-not-settled|unsettled-attempt):/.test(res.reason || '')) return 'ORPHAN';
  if (res.class === 'STALL') return 'STALL';
  if (res.class === 'TIMEOUT') return 'INTERRUPTED';
  if (res.class === 'INVALID_OUTPUT') return 'CONTENT';
  if (ENGINE_CLASS_MAP[res.class]) return ENGINE_CLASS_MAP[res.class];
  if (Number.isInteger(res.exitCode) && res.exitCode >= 0) return classify(res.exitCode, null, text);
  return 'UNKNOWN';
}

// Executor signal/error sentinels are not child exit codes. Policy refusals and
// supervisor stops always exit 1, even if the stopped child happened to exit 0/7.
function engineOutcome(res, text) {
  const childCode = Number.isInteger(res.exitCode) && res.exitCode >= 0 ? res.exitCode : null;
  const ok = res.status === 'DONE' && childCode === 0;
  const failureClass = ok ? null : (engineFailureClass(res, text) || 'UNKNOWN');
  const supervisorFailure = res.status === 'BLOCKED' || ['ORPHAN', 'STALL', 'INTERRUPTED'].includes(failureClass);
  const exitCode = supervisorFailure ? null : childCode;
  return { ok, exitCode, failureClass, code: ok ? 0 : (exitCode !== null && exitCode !== 0 ? exitCode : 1) };
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
  const { o, deps, repo, runtime, base, snapDir, snapBefore, ring, log, push, release, launchTmp, st, settleTemp, record, settleBoundary } = ctx;
  const emitChunk = deps.write || (s => process.stdout.write(s));
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
        env: { ...launchTmpEnv(launchTmp), LAUNCH_WRAPPER_NAME: o.name, ...st.proxy.env, LAUNCH_WRAPPER_ID: base.wrapperLaunchId, PROTOCOL_PACKET_ENGINE: 'dispatch', ...(o.certifier ? { PROTOCOL_NO_FULL_SUITE: '1' } : {}), ...(base.routeGate && base.routeGate.recordFile ? { [ROUTE_STATE_FILE_ENV]: base.routeGate.recordFile } : {}), ...(handedDecision(base.routeGate) || process.env[ROUTE_DECISION_ENV] !== undefined ? { [ROUTE_DECISION_ENV]: handedDecision(base.routeGate) } : {}) },
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
    push('\n'); // finish a last structured frame even when the client wrote no LF
    try { fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {}
    for (const [k, v] of Object.entries(savedTemp)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
  // the running record keeps the engine root identity even after a fast attempt the poller never saw
  const lease = executor.readLease(slot.id, stateDir);
  const rootPid = lease && lease.attempts.length ? lease.attempts[lease.attempts.length - 1].root.pid : null;
  const running = readJson(runningPath);
  if (running && !running.ended) writeJson(runningPath, { ...running, childPid: rootPid });
  const text = ring.join('\n');
  let { ok, exitCode, failureClass, code } = engineOutcome(res, text);
  st.proxy.tracker.end();
  if (require('../../.ai/bin/ops-tools/proxy-health.cjs').needsLocalProxy(st.proxy.options) && st.proxy.tracker.signal && !st.proxy.tracker.final && !['ORPHAN', 'STALL', 'INTERRUPTED'].includes(failureClass)) {
    const proxy = require('../../.ai/bin/ops-tools/proxy-health.cjs');
    let s; try { s = await proxy.refresh(st.proxy.options); } catch { /* unknown */ }
    failureClass = proxy.classifyProxyDrop({ signal: st.proxy.tracker.signal, attempt: st.proxy.attempt, endpoint: st.proxy.tracker.endpoint, final: st.proxy.tracker.final,
      exitCode, failureClass, down: s && s.state === 'down', stopped: fs.existsSync(path.join(runtime, `${o.name}.stopped.json`)) }) || failureClass;
  }
  const detected = commitNote(snapBefore, snapshot(snapDir));
  if (detected && detected.line) { const w = `${detected.line}\n`; if (log) log.write(w); process.stdout.write(w); }
  const note = detected ? (detected.note || detected) : null;
  const reason = ok ? null : `engine ${res.status}${res.class ? ` class=${res.class}` : ''}${res.reason ? `: ${res.reason}` : ''}`;
  const boundaryResult = settleBoundary();
  if (boundaryResult && boundaryResult.note) { const w = `${boundaryResult.note}\n`; if (log) log.write(w); emitChunk(w); }
  if (boundaryResult && boundaryResult.warning) { const w = `${boundaryResult.warning}
`; if (log) log.write(w); process.stdout.write(w); }
  const tempDir = settleTemp(!ok, failureClass);
  const tl = tempLine(tempDir);
  if (tl) { if (log) log.write(tl); process.stdout.write(tl); }
  record({
    status: ok ? 'DONE' : 'FAILED', exitCode, signal: null,
    failureClass,
    reason, lastLines: ring.slice(), note, tempDir, usage: st.usageLine, usageFields: st.usageFields, writeBoundary: boundaryResult
  });
  release();
  if (log) log.end();
  return st.persistenceBlocked ? 1 : code;
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
  assert.equal(engineFailureClass({ status: 'BLOCKED', class: 'POLICY_FAILURE', reason: 'attempt-not-settled: process-alive: recorded:4242' }, ''), 'ORPHAN');
  assert.equal(engineFailureClass({ status: 'BLOCKED', class: 'POLICY_FAILURE', reason: 'unsettled-attempt: not settled' }, ''), 'ORPHAN');
  assert.equal(engineFailureClass({ status: 'FAILED', class: 'AUTH_ERROR', exitCode: 7 }, ''), 'AUTH');
  assert.equal(engineFailureClass({ status: 'FAILED', class: 'RATE_LIMIT', exitCode: 7 }, ''), 'QUOTA');
  assert.equal(engineFailureClass({ status: 'FAILED', class: 'PROCESS_CRASH', exitCode: 7 }, 'plain failure'), 'UNKNOWN');
  assert.equal(engineFailureClass({ status: 'FAILED', class: 'PROCESS_CRASH', exitCode: -1 }, 'plain failure'), 'UNKNOWN');
  process.stdout.write('SELFTEST ok\nRESULT exit=0\n');
  return 0;
}

function watch(o) {
  const runtime = recordsRuntime(o);
  const now = o.now ? Date.parse(o.now) : Date.now();
  const grace = Number(o['grace-min'] || 5) * 60000;
  let silent = 0;
  let releaseFailed = false;
  if (!fs.existsSync(runtime)) { process.stdout.write('RESULT exit=0 silent=0 (no runtime directory)\n'); return 0; }
  for (const f of fs.readdirSync(runtime).filter(n => n.endsWith('.running.json'))) {
    const r = readJson(path.join(runtime, f));
    if (!r || r.claimReleasedAt) continue;
    const terminal = readJson(path.join(runtime, `${r.name}.terminal.json`));
    // A wrapper may die after terminal publication and before release. Reconcile
    // only a matching finished generation whose wrapper AND child are gone.
    // Never release on a terminal marker alone or while either process is live.
    if (terminal && ['DONE','FAILED'].includes(terminal.status) && terminal.endedAt
        && terminal.name === r.name && terminal.stream === r.stream && terminal.owner === r.owner
        && seatSlots.sameAttempt(r, terminal) && r.stream && r.owner
        && !alive(r.wrapperPid) && !alive(r.childPid)) {
      const released = guard(o, ['release', '--stream', r.stream, '--owner', r.owner, '--seat', r.name, '--not-after', terminal.endedAt]);
      if (released.status !== 0) { releaseFailed = true; process.stderr.write(`CLAIM_RELEASE_FAILED name=${r.name}\n`); }
      else markClaimReleased(runtime, r.name, r.startedAt);
      continue;
    }
    // A foreign terminal never authorizes release. Preserve an ambiguous record of this attempt for reconciliation
    // rather than replacing it with a new terminal. A terminal of another attempt of the name (a retry reuses the
    // name) is that attempt's outcome: it never hides the silent death of the attempt that runs now.
    if (r.ended || (terminal && seatSlots.sameAttempt(r, terminal))) continue;
    if (now - Date.parse(r.startedAt) < grace) continue;
    if (alive(r.wrapperPid) || alive(r.childPid)) continue;
    const result = seatPersistence.terminal(r, { status: 'FAILED', exitCode: null, signal: null, failureClass: 'INTERRUPTED', reason: 'process gone, no terminal marker (died silently)', lastLines: [] });
    writeTerminal(runtime, r.name, r, result);
    if (r.stream && r.owner) {
      const released = guard(o, ['release', '--stream', r.stream, '--owner', r.owner, '--seat', r.name]);
      if (released.status !== 0) { releaseFailed = true; process.stderr.write(`CLAIM_RELEASE_FAILED name=${r.name}\n`); }
      else markClaimReleased(runtime, r.name, r.startedAt);
    }
    process.stdout.write(`FAILED_SILENT name=${r.name} stream=${r.stream} owner=${r.owner} started=${r.startedAt} (replace the certifier now)\n`);
    silent++;
  }
  process.stdout.write(`RESULT exit=${silent || releaseFailed ? 1 : 0} silent=${silent}\n`);
  return silent || releaseFailed ? 1 : 0;
}

function status(o) {
  const repo = path.resolve(o.repo || process.cwd());
  const runtime = recordsRuntime(o);
  if (!fs.existsSync(runtime)) { process.stdout.write('no runtime directory\nRESULT exit=0\n'); return 0; }
  // The operator layer adds state, handoff, last change and last commit; without it (an older install) the lines stay as they were.
  const rows = new Map();
  let counts = null;
  try {
    const layer = require('../../.ai/bin/operator/layer.cjs');
    const root = mainRoot(repo);
    let settings;
    try { settings = layer.loadSettings(root); } catch { settings = layer.parseSettings({}); }
    const result = layer.launchRows(root, settings, { runtime });
    for (const r of result.rows) rows.set(r.name, r);
    counts = layer.counts(result.rows);
  } catch (e) { process.stdout.write(`WARN status details unavailable: ${String((e && e.message) || e).slice(0, 160)}\n`); }
  const more = (name, running) => {
    const r = rows.get(name);
    if (!r) return '';
    const parts = [`task=${r.task || '-'}`];
    if (running) parts.push(`state=${r.state}`);
    parts.push(`handoff=${r.handoff}`);
    if (r.idleMinutes !== undefined) parts.push(`idle=${r.idleMinutes}m threshold=${r.threshold.stallMinutes}m(${r.threshold.source})`);
    if (r.stallReason) parts.push(`stall=${r.stallReason}`);
    if ('lastChange' in r) parts.push(`lastChange=${r.lastChange || 'none'} lastCommit=${r.lastCommit ? `${r.lastCommit} ${r.lastCommitSha}` : 'none'}`);
    return ` ${parts.join(' ')}`;
  };
  for (const f of fs.readdirSync(runtime).filter(n => n.endsWith('.terminal.json'))) {
    const t = readJson(path.join(runtime, f));
    if (t) process.stdout.write(`${t.status.padEnd(6)} ${t.name} stream=${t.stream} exit=${t.exitCode} class=${t.failureClass || '-'} wall=${t.wallSeconds}s ended=${t.endedAt}${more(t.name, false)}\n`);
  }
  // One identity rule (seat-slots.cjs): only the terminal record of the same attempt (wrapper PID and start) ends a running
  // record; the terminal of another attempt of the name is listed above as that attempt's outcome and hides nothing.
  for (const f of fs.readdirSync(runtime).filter(n => n.endsWith('.running.json'))) {
    const r = readJson(path.join(runtime, f));
    if (r && !r.ended && !seatSlots.sameAttempt(r, readJson(path.join(runtime, `${r.name}.terminal.json`)))) process.stdout.write(`RUNNING ${r.name} stream=${r.stream} started=${r.startedAt} alive=${alive(r.wrapperPid) || alive(r.childPid)}${more(r.name, true)}\n`);
  }
  // WRITE-BOUNDARY (P-149): the audit counters are read from the same runtime directory as the launch records; a counter of
  // one is a warning that a later launch refuses, above one it has already repeated.
  try {
    const wb = writeBoundary.counters(path.join(runtime, writeBoundary.AUDIT_FILE));
    process.stdout.write(`${wb.line}\n`);
  } catch (e) { process.stdout.write(`WRITE-BOUNDARY audit unavailable: ${String((e && e.code) || (e && e.message) || e).slice(0, 80)}\n`); }
  process.stdout.write(`RESULT exit=0${counts ? ` alive=${counts.alive} stalled=${counts.stalled} dead=${counts.dead} handoffPending=${counts.pending}` : ''}\n`);
  return 0;
}

// LAUNCH-RELIABILITY finding 1: the real state of a launch after its start, read from its records and its launch output only (it starts and
// stops nothing). One line, exit 0 for VERIFY-OK and for VERIFY-ENDED status=DONE, else 1 (2 on usage errors):
//   VERIFY-OK N proof=seat-spawn route=R            the admitted SEAT-SPAWN line of a live launch (a kernel seat launcher under a route record)
//   VERIFY-OK N proof=alive-after-settle            spawnProof none (another launcher, or no route record): the launch is live --settle seconds after its start
//   VERIFY-REFUSED N class=C detail                 a named refusal: of the child (PRECERT, ROUTE, PREFLIGHT_HEAD, LAUNCHER, WORKROOT) or, before any record, of the wrapper in --out
//   VERIFY-DEAD N class=C                           the launch ended FAILED, or its wrapper is gone without a terminal record (class INTERRUPTED)
//   VERIFY-ENDED N status=DONE                      the launch already ended DONE
//   VERIFY-TIMEOUT N state=S                        no proof inside --timeout: no-record, or launcher-running-no-spawn
// Records older than --since (default: 60 seconds before the call) belong to an earlier launch of the same name and are not read.
const WRAPPER_REFUSAL = /^(LAUNCH REFUSED.*|ROUTE-GATE REFUSED.*|WORKROOT REFUSED.*|SLOT REFUSED.*|QUOTA (?!allow).*|PRECERT REFUSED.*|[A-Z0-9_.-]+_PRECERT_REFUSED.*|[A-Z0-9_.-]+_ROUTE_REFUSED.*|SEAT-FAILOVER REFUSED.*)$/m;
const REFUSAL_CLASS = [[/PRECERT/, 'PRECERT'], [/ROUTE/, 'ROUTE'], [/^LAUNCH REFUSED by the claim/, 'CLAIM'], [/^LAUNCH REFUSED by the gate/, 'LAUNCH_GATE'], [/^WORKROOT/, 'WORKROOT'], [/^SLOT/, 'SLOT_TIMEOUT'], [/^QUOTA/, 'QUOTA']];
function verifyOnce(o, ctx) {
  const { runtime, since, now, settleMs, io } = ctx;
  const rd = f => { try { return JSON.parse(io.readFileSync(f, 'utf8')); } catch { return null; } };
  const fresh = r => r && typeof r.startedAt === 'string' && Date.parse(r.startedAt) >= since;
  const running = rd(path.join(runtime, `${o.name}.running.json`));
  const terminal = rd(path.join(runtime, `${o.name}.terminal.json`));
  if (fresh(terminal) && (!fresh(running) || running.startedAt === terminal.startedAt)) {
    if (terminal.refusal) return { ok: false, line: `VERIFY-REFUSED ${o.name} class=${terminal.refusal.code} ${String(terminal.refusal.line || '').slice(0, 160)}` };
    if (terminal.status === 'DONE') return { ok: true, line: `VERIFY-ENDED ${o.name} status=DONE exit=${terminal.exitCode}` };
    return { ok: false, line: `VERIFY-DEAD ${o.name} class=${terminal.failureClass || 'UNKNOWN'} exit=${terminal.exitCode === null ? 'none' : terminal.exitCode}` };
  }
  if (fresh(running) && !running.ended) {
    if (running.refusal) return { ok: false, line: `VERIFY-REFUSED ${o.name} class=${running.refusal.code} ${String(running.refusal.line || '').slice(0, 160)}` };
    if (!ctx.alive(running.wrapperPid)) return { ok: false, line: `VERIFY-DEAD ${o.name} class=INTERRUPTED reason=the wrapper is gone without a terminal record` };
    if (running.seatSpawn) return { ok: true, line: `VERIFY-OK ${o.name} proof=seat-spawn route=${running.seatSpawn.route}` };
    if (running.spawnProof !== 'seat-spawn-line' && now - Date.parse(running.startedAt) >= settleMs) return { ok: true, line: `VERIFY-OK ${o.name} proof=alive-after-settle settle=${Math.round(settleMs / 1000)}s` };
    return { ok: null, state: 'launcher-running-no-spawn' };
  }
  const outFile = path.resolve(o.out || path.join(runtime, `${o.name}.launch.out`));
  let text = '';
  try { if (io.statSync(outFile).mtimeMs >= since) text = io.readFileSync(outFile, 'utf8'); } catch { /* no launch output */ }
  const m = WRAPPER_REFUSAL.exec(text);
  if (m) { const cls = (REFUSAL_CLASS.find(([re]) => re.test(m[1])) || [null, 'GATE'])[1]; return { ok: false, line: `VERIFY-REFUSED ${o.name} class=${cls} ${m[1].slice(0, 160)}` }; }
  return { ok: null, state: 'no-record' };
}
async function verify(o, deps = {}) {
  if (!o.name || launchNameProblem(o.name)) { process.stderr.write('verify needs --name (a launch name)\n'); return 2; }
  const num = (k, d, lo, hi) => { if (o[k] === undefined) return d; const n = Number(o[k]); return /^\d{1,5}$/.test(o[k]) && n >= lo && n <= hi ? n : NaN; };
  const timeout = num('timeout', 180, 0, 86400); const poll = num('poll', 5, 1, 600); const settle = num('settle', 45, 0, 3600);
  if ([timeout, poll, settle].some(Number.isNaN)) { process.stderr.write('verify: --timeout, --poll and --settle need whole seconds\n'); return 2; }
  const clock = deps.now || Date.now;
  const since = o.since !== undefined ? Date.parse(o.since) : clock() - 60000;
  if (Number.isNaN(since)) { process.stderr.write('verify: --since must be an ISO time\n'); return 2; }
  const runtime = recordsRuntime(o);
  const sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const end = clock() + timeout * 1000;
  let state = 'no-record';
  for (;;) {
    const r = verifyOnce(o, { runtime, since, now: clock(), settleMs: settle * 1000, io: deps.fs || fs, alive: deps.alive || alive });
    if (r.ok !== null) { process.stdout.write(`${r.line}\n`); return r.ok ? 0 : 1; }
    state = r.state;
    if (clock() >= end) break;
    await sleep(poll * 1000);
  }
  process.stdout.write(`VERIFY-TIMEOUT ${o.name} state=${state} after=${timeout}s\n`);
  return 1;
}

async function main(argv, deps = {}) {
  const cmd = argv[0];
  const o = parseArgs(argv.slice(1));
  if (!['run', 'watch', 'status', 'selftest', 'verify'].includes(cmd) || o.error) { process.stderr.write(`${o.error || 'usage: launch-wrapper.cjs run|watch|status|verify [options] -- <command>'}\n`); return 2; }
  if (cmd === 'run') return run(o, deps);
  if (cmd === 'verify') return verify(o, deps);
  if (cmd === 'watch') return watch(o);
  if (cmd === 'selftest') return selftest();
  return status(o);
}

// The future integration consumes the SAME full local-ref audit as dispatch;
// legacy WARN behaviour is retained pending the scope check and the mode act.
const { permissionAudit, permissionSnapshot } = require('../../.ai/bin/protocol-dispatch/workdir.cjs');
module.exports = { get quotaCoverageAudit() { return require('./quota-launch-hook.cjs').coverageAudit; }, permissionAudit, permissionSnapshot, classify, snapshot, compareSnapshots, commitNote, engineFailureClass, engineOutcome, resolveTmpRoot, configuredTmpRoot, driveRootCandidate, resolveWorkRoot: workRoot.resolveWorkRoot, workRootRefusal: workRoot.workRootRefusal, launchWorkEnv: workRoot.launchWorkEnv, kernelWorkEnv: workRoot.kernelWorkEnv, launchNameProblem, MAX_NAME_LENGTH, prepareLaunchTmp, finishLaunchTmp, writeTerminal, main, launchRole, refusalOf, verifyOnce, SPAWN_LINE, IDLE_DEFAULT_MINUTES };
module.exports.requestStop = require('./lib/cycle-stop.cjs').requestStop;
module.exports.assignRuntimeStep = assignRuntimeStep;
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });

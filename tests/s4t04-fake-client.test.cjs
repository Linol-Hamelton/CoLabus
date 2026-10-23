'use strict';

// Fixtures for the dispatcher rules LV-03 and LV-11 at the executor level, with a fake client that talks.
// Real time, small limits; the client ends itself, so a failed fixture leaves no process behind.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createWakeBudget } = require('../.ai/bin/protocol-dispatch/liveness.cjs');
const { repoRoot } = require('./s4t04-helpers.cjs');

const executor = require('../.ai/bin/protocol-dispatch/executor.cjs');
const { tt, runChecked } = require('./helpers.cjs');
// The dispatch executor in this file makes <temp>/colabs-hooks-* (and clones) in-process: this process's temp dir is a fixture dir from here on.
tt.isolateTemp('iso-');

const TALKER = path.join(__dirname, 's4t04-fake-talker.cjs');

// Every git call of the fixture goes through the shared checked helper: a call with an error, a signal or a status other than 0 stops the setup.
function gitInit(dir, spawn = spawnSync) {
  const run = args => runChecked('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], { cwd: dir, encoding: 'utf8' }, spawn);
  run(['init', '-q']);
  fs.writeFileSync(path.join(dir, 'README.md'), 'fixture\n');
  run(['add', '.']);
  run(['commit', '-q', '-m', 'fixture']);
}

// What a process start costs on this host right now, in seconds; a probe that did not run cleanly measures nothing and throws.
function processStartCost(spawn = spawnSync) {
  const start = Date.now();
  runChecked(process.execPath, ['-e', '0'], {}, spawn);
  return (Date.now() - start) / 1000;
}

// What the fake client itself costs to start on this host right now, in seconds; several samples, worst observed
// (PROTO-DEC-0212 item 4): the worst sample of this run carries the load of this run, and the stop of a
// client is process starts of the same kind. A probe that did not run cleanly measures nothing and throws.
function fakeClientStartCost(samples = 5, spawn = spawnSync) {
  let worst = 0;
  for (let i = 0; i < samples; i++) {
    const start = Date.now();
    runChecked(process.execPath, [TALKER, '0'], {}, spawn);
    worst = Math.max(worst, (Date.now() - start) / 1000);
  }
  return worst;
}

// What one process-table snapshot costs on this host right now, in seconds; several samples, worst observed.
// The stop of a client is dominated by exactly this operation: stopAttempt records the tree, kills, and then
// verifies over up to VERIFY_TRIES fresh tables - on Windows each is a full powershell + CIM query, which
// inflates under load far more than a node start (as measured: a ceiling run at 12.9 s against a
// fake-client-only bound of 9.0 s, the node-start samples having stayed at 0.20 s through the load spike
// that slowed the snapshots). A probe that did not run cleanly measures nothing and throws.
function tableSnapshotCost(samples = 2, probe = snapshotProcesses) {
  let worst = 0;
  for (let i = 0; i < samples; i++) {
    const start = Date.now();
    const table = probe();
    if (!table || !table.length) throw new Error('the process-table probe returned no table');
    worst = Math.max(worst, (Date.now() - start) / 1000);
  }
  return worst;
}

// Negative tests of the two call sites above: each failure kind (status 0 with an error, status 0 with a signal, status 1 with output) is a
// failure at every call, the output notwithstanding; a clean stand-in and the real calls pass.
const FAILURES = [
  [{ status: 0, error: new Error('spawn ENOENT'), stdout: 'out' }, /did not run: spawn ENOENT/],
  [{ status: 0, signal: 'SIGKILL', stdout: 'out' }, /killed by signal SIGKILL/],
  [{ status: 1, stdout: 'out', stderr: 'bad' }, /exited with status 1: bad/],
];
test('a git call of the fixture repository that fails in any way stops the setup, at each of its three calls', () => {
  const ok = { status: 0, signal: null, stdout: '' };
  for (const [failure, re] of FAILURES) {
    for (let bad = 0; bad < 3; bad++) {
      const dir = tt.mkTmp('s4t04-neg-');
      let n = 0;
      assert.throws(() => gitInit(dir, () => (n++ === bad ? failure : ok)), re, `call ${bad + 1} with ${JSON.stringify(failure.signal || failure.status)}`);
      assert.equal(n, bad + 1, 'the setup stops at the failing call');
    }
  }
  const dir = tt.mkTmp('s4t04-neg-');
  gitInit(dir); // the real calls pass
  assert.ok(fs.existsSync(path.join(dir, '.git')));
});
test('the process-start probe of INT-01 that fails in any way measures nothing and throws; a clean probe and the real one return a cost', () => {
  for (const [failure, re] of FAILURES) assert.throws(() => processStartCost(() => failure), re);
  assert.equal(processStartCost(() => ({ status: 0, signal: null })) >= 0, true);
  assert.ok(processStartCost() > 0);
  for (const [failure, re] of FAILURES) assert.throws(() => fakeClientStartCost(5, () => failure), re);
  assert.equal(fakeClientStartCost(2, () => ({ status: 0, signal: null })) >= 0, true);
  assert.ok(fakeClientStartCost() > 0);
  assert.throws(() => tableSnapshotCost(2, () => null), /no table/);
  assert.throws(() => tableSnapshotCost(2, () => []), /no table/);
  assert.equal(tableSnapshotCost(2, () => [{ pid: 1, ppid: 0, createdAt: 'x' }]) >= 0, true);
  assert.ok(tableSnapshotCost() > 0);
});

function setup(tmp, talkSeconds, mode) {
  const work = path.join(tmp, 'work');
  fs.mkdirSync(work);
  gitInit(work);
  const registry = {
    schema: 'clients/1',
    clients: {
      talker: {
        binary: 'node',
        present: true,
        version: process.version,
        verifiedOn: '2026-10-06',
        source: 'node --version',
        command: ['node', TALKER, String(talkSeconds), ...(mode ? [mode] : [])],
        model: { how: 'none', listing: null },
        effort: { how: 'none', values: null, note: null },
        env: {},
        resume: { command: null, sessionId: null, note: 'none' },
        usage: 'none',
        failureModes: []
      }
    }
  };
  const slot = { id: 'int-talker', launch: 'launch.md', out: 'out.txt', route: { client: 'talker', model: 'test' } };
  // absolute: a path relative to the repository root would be resolved against `work` (the repoRoot of the run) and land in an empty chain of directories outside the fixture
  const dispatch = { stateDir: path.join(tmp, 'state') };
  return { work, registry, slot, dispatch, stateDir: dispatch.stateDir };
}

// hooks.before(ctx) returns extra executor options; hooks.after(ctx, res) runs before the temp dir is removed and its value is returned as out
async function run(talkSeconds, limits, mode, hooks = {}) {
  const tmp = tt.mkTmp('s4t04-int-');
  try {
    const ctx = setup(tmp, talkSeconds, mode);
    const { work, registry, slot, dispatch } = ctx;
    const extra = hooks.before ? hooks.before(ctx) : {};
    const started = Date.now();
    const res = await executor.executeAttempt(slot, 1, dispatch, registry, { repoRoot: work, workdir: work, keepWorkdirOnExit: true, ...limits, ...extra });
    const elapsed = (Date.now() - started) / 1000;
    return { res, elapsed, out: hooks.after ? hooks.after(ctx, res) : null };
  } finally {
    // best effort: on Windows the client's own cwd may stay locked for a moment after the stop
    try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); } catch {}
  }
}

test('INT-02 LV-11: a client whose own output keeps growing is never STALL', async () => {
  const { res, elapsed } = await run(6, { stallSeconds: 2, hardSeconds: 60 });
  assert.notEqual(res.class, 'STALL', `INT-02: output grew every 100 ms for 6 s with a 2 s stall interval; got status=${res.status} class=${res.class} after ${elapsed.toFixed(1)} s (the own-log read must work)`);
});

test('INT-01 LV-03: a client that keeps talking still hits the hard ceiling: TIMEOUT and BLOCKED, at hard plus the measured tick costs of this run', async () => {
  // The ceiling moment is measured where it happens: the executor reports the tracker's own
  // elapsed time at the firing tick (verdictElapsedMs), never the wall time of the whole run,
  // which the stop path pollutes by seconds and made the old lower bound unable to pin
  // "never before hard" (a half-hard ceiling passed it; PROTO-DEC-0212 item 4).
  // The bound has BOTH sides, tied to the configured hard limit and to the measured costs of
  // this same run: the ceiling fires not earlier than hard, and not later than hard plus one
  // tick plus the guarded spawns the ticks perform - the worst fake-client start over several
  // samples taken before AND after the attempt, and the process-table snapshots (at most one
  // per 5 s window) the ticks record. The configuration makes both sides falsifiable: the
  // talker outlives the honest ceiling under load (27 s against 15 s hard plus the measured
  // delay bound) but dies before a doubled ceiling (30 s), so a ceiling that no longer fires
  // at hard is caught by the class assertions, not hidden inside the load envelope. The stall
  // window (60 s) is far above hard: a 2 s window made a load-delayed tick flip the verdict
  // to STALL although the client kept talking (observed in a landing train); a talking client's stall behaviour is
  // INT-02's subject, not this ceiling's.
  const HARD_SECONDS = 15;
  // The upper bound reserves the REAL tick interval of this configuration:
  // hardMs times 0.25, exactly as the executor computes it (3.75 s here), never a
  // fixed one second - on a fast host the measured spawn terms vanish and a fixed +1 s
  // would fall below one honest late tick, denying a correct ceiling firing.
  const tickSeconds = executor.tickIntervalMs({ stallMs: 60 * 1000, hardMs: HARD_SECONDS * 1000 }) / 1000;
  const ceilingUpperBound = (start, snapshot) => HARD_SECONDS + tickSeconds + 8 * start + 2 * snapshot;
  const fakeBefore = fakeClientStartCost(5);
  const snapBefore = tableSnapshotCost(2);
  const { res, elapsed } = await run(27, { stallSeconds: 60, hardSeconds: HARD_SECONDS });
  const startCost = Math.max(fakeBefore, fakeClientStartCost(3));
  const snapshotCost = Math.max(snapBefore, tableSnapshotCost(1));
  const ceil = res.verdictElapsedMs / 1000;
  const upper = ceilingUpperBound(startCost, snapshotCost);
  assert.equal(res.class, 'TIMEOUT', `INT-01: the hard ceiling must fire although every tick made progress (got status=${res.status} class=${res.class} after ${elapsed.toFixed(1)} s)`);
  assert.equal(res.status, 'BLOCKED', 'INT-01: R-L3-004.8: reaching the hard ceiling is TIMEOUT and the step is BLOCKED');
  assert.ok(Number.isFinite(ceil) && ceil >= HARD_SECONDS, `INT-01: the ceiling fired at ${Number.isFinite(ceil) ? ceil.toFixed(1) : ceil} s by the tracker clock, before the hard limit of ${HARD_SECONDS} s`);
  assert.ok(ceil <= upper, `INT-01: the ceiling fired at ${ceil.toFixed(1)} s, expected within ${upper.toFixed(1)} s for hard=${HARD_SECONDS} s (${HARD_SECONDS} s plus the real ${tickSeconds.toFixed(2)} s tick plus 8 x the ${startCost.toFixed(2)} s the fake client worst-of-eight costs to start now plus 2 x the ${snapshotCost.toFixed(2)} s a process table costs now)`);
  assert.ok(elapsed >= HARD_SECONDS, `INT-01: the ceiling fired at ${elapsed.toFixed(1)} s, before the hard limit of ${HARD_SECONDS} s`);
  assert.ok(elapsed < HARD_SECONDS + tickSeconds + 10 * startCost + 6 * snapshotCost, `INT-01: the whole run took ${elapsed.toFixed(1)} s, expected under ${(HARD_SECONDS + tickSeconds + 10 * startCost + 6 * snapshotCost).toFixed(1)} s for hard=${HARD_SECONDS} s (hard plus the real ${tickSeconds.toFixed(2)} s tick plus 10 x the ${startCost.toFixed(2)} s the fake client worst-of-eight costs to start now plus 6 x the ${snapshotCost.toFixed(2)} s a process table costs now)`);
});

// The ceiling upper bound reserves the real tick interval of the
// configured hard limit, and the fast and the slow start-cost sample both stay inside the
// property: a fast sample must still reserve one full real tick (the old fixed +1 s fell
// below it), and a slow sample must widen the bound, never narrow it.
test('INT-01 bound: the upper bound carries the real tick interval for a fast and a slow start-cost sample', () => {
  const tick = executor.tickIntervalMs({ stallMs: 60 * 1000, hardMs: 15 * 1000 }) / 1000;
  assert.equal(tick, 3.75, 'the tick interval is the real hardMs times 0.25 as the executor configures it');
  assert.equal(executor.tickIntervalMs({ stallMs: 5 * 1000, hardMs: 200 * 1000 }) / 1000, 1.25, 'the stall quarter clamps the same interval');
  const bound = (start, snapshot) => 15 + executor.tickIntervalMs({ stallMs: 60 * 1000, hardMs: 15 * 1000 }) / 1000 + 8 * start + 2 * snapshot;
  const fast = bound(0.02, 0.02), slow = bound(0.5, 3);
  assert.ok(fast >= 15 + 3.75, `a fast sample still reserves the full real tick interval (${fast.toFixed(2)} s), where the old fixed +1 s bound (${(15 + 1 + 8 * 0.02 + 2 * 0.02).toFixed(2)} s) would deny an honest ceiling one tick late`);
  assert.ok(fast > 15 + 1 + 8 * 0.02 + 2 * 0.02, 'the bound is not the old fixed-one-second bound');
  assert.ok(slow > fast, `a slow start-cost sample widens the bound (${slow.toFixed(2)} s over ${fast.toFixed(2)} s), never narrows it`);
});

// The production shape of a wake: the CLI launches a later attempt of a step whose first launch is long past.

test('LV-08 INT-03: a wake-resume opens its idle window at the resume moment, not at the first launch', async () => {
  const wakeBudget = createWakeBudget();
  // the step began 5 s ago: against that origin a 2 s stall interval would already be spent at the first tick
  const { res, elapsed } = await run(8, { stallSeconds: 2, hardSeconds: 60, attemptKind: 'resume', wake: true, wakeBudget, firstLaunchAt: Date.now() - 5000 }, 'silent');
  assert.equal(res.class, 'STALL', `INT-03: a silent client must still stall (got status=${res.status} class=${res.class})`);
  assert.ok(elapsed >= 1.8, `INT-03: the stall fired after ${elapsed.toFixed(1)} s; the wake must give a full 2 s window from the resume moment`);
  assert.equal(wakeBudget.used(), 1, 'INT-03: the executor takes the wake through the shared budget (tracker.wake), not a CLI counter');
});

test('LV-08 INT-04: the fourth idle stretch is FALLEN: no process is started once the three wakes are used', async () => {
  const wakeBudget = createWakeBudget();
  for (let i = 0; i < 3; i++) wakeBudget.take();
  const { res, elapsed } = await run(8, { stallSeconds: 2, hardSeconds: 60, attemptKind: 'resume', wake: true, wakeBudget }, 'silent');
  assert.equal(res.status, 'FAILED');
  assert.equal(res.class, 'STALL', 'INT-04: an exhausted wake budget is class STALL, the run record then reads FALLEN');
  assert.equal(res.reason, 'wake budget exhausted', `INT-04: refused before launching, not by a stall of the client (took ${elapsed.toFixed(1)} s)`);
  assert.equal(wakeBudget.used(), 3, 'INT-04: the budget does not grow past three');
});


// Lease and process-table hardening (the probes of the process table and the lease/stop path). The process table is injected through
// the executor's snapshotProcesses option: a fake table, driven by the real root PID that the lease records.

const { isPidAlive, snapshotProcesses } = require('../.ai/bin/protocol-dispatch/procfs.cjs');
const leaseLib = require('../.ai/bin/protocol-dispatch/lease.cjs');

const ROOT_T = '2026-10-06T12:00:00.000Z';
const KID_T = '2026-10-06T12:00:01.000Z';
const FAKE_KID = 2000000011; // not a live PID on any supported OS
const FAKE_ORPHAN = 2000000012;
const row = (pid, ppid, createdAt) => ({ pid, ppid, createdAt });

// A table that always lists a bystander (a readable table is never empty), the real root while it lives, and the extras
// `extra(rootPid, rootAlive)` names. The root PID comes from the lease the executor wrote.
function fakeTable(ctx, extra) {
  return () => {
    const lease = executor.readLease(ctx.slot.id, ctx.stateDir);
    const rootPid = lease && lease.attempts.length ? lease.attempts[lease.attempts.length - 1].root.pid : null;
    const rows = [row(1, 0, '2026-10-06T11:00:00.000Z')];
    if (!rootPid) return rows;
    const rootAlive = isPidAlive(rootPid);
    if (rootAlive) rows.push(row(rootPid, 1, ROOT_T));
    rows.push(...extra(rootPid, rootAlive));
    return rows;
  };
}

const leaseOf = ctx => executor.readLease(ctx.slot.id, ctx.stateDir);
const orphanAfterRootDies = (rootPid, rootAlive) => (rootAlive ? [] : [row(FAKE_ORPHAN, rootPid, KID_T)]);

test('LH-01 a lease that cannot be persisted aborts the attempt before anything is launched, with a stated class', async () => {
  const { res, elapsed, out } = await run(4, { stallSeconds: 1, hardSeconds: 60 }, 'silent', {
    // a directory where the lease file belongs: the rename cannot succeed
    before: ctx => { fs.mkdirSync(path.join(ctx.stateDir, `${ctx.slot.id}.lease.json`), { recursive: true }); return {}; },
    after: ctx => {
      const log = path.join(ctx.stateDir, 'logs', `${ctx.slot.id}-1.log`);
      return fs.existsSync(log) ? fs.statSync(log).size : 0;
    }
  });
  assert.equal(res.status, 'BLOCKED');
  assert.equal(res.class, 'POLICY_FAILURE');
  assert.match(res.reason, /^lease-write-failed:/, 'LH-01: the failure names the lease, it is not swallowed');
  assert.ok(elapsed < 2, `LH-01: nothing was launched, so it ends at once (took ${elapsed.toFixed(1)} s)`);
  assert.equal(out, 0, 'LH-01: the client never ran, so its log stays empty');
});

test('LH-02 an unreadable process table at stop time never settles and fails loudly', async () => {
  const { res, out } = await run(4, { stallSeconds: 1, hardSeconds: 60 }, 'silent', {
    before: () => ({ snapshotProcesses: () => null }),
    after: ctx => leaseOf(ctx)
  });
  assert.equal(res.status, 'BLOCKED', 'LH-02: not STALL/FAILED: the step does not go on');
  assert.equal(res.class, 'POLICY_FAILURE');
  assert.equal(res.reason, 'attempt-not-settled: table-unavailable');
  assert.equal(res.underlyingClass, 'STALL');
  assert.equal(out.attempts[0].settled, false, 'LH-02: the lease keeps the attempt unsettled');
  assert.equal(out.attempts[0].unsettledReason, 'table-unavailable');
});

test('LH-03 after the kill loop the table is read again; a surviving recorded descendant keeps the attempt unsettled and blocks the next start', async () => {
  let table = null;
  const { res, out } = await run(4, { stallSeconds: 1, hardSeconds: 60 }, 'silent', {
    before: ctx => { table = fakeTable(ctx, rootPid => [row(FAKE_KID, rootPid, KID_T)]); return { snapshotProcesses: table }; },
    after: ctx => ({ lease: leaseOf(ctx), decision: executor.leaseStartDecision(ctx.slot.id, ctx.stateDir, { snapshotProcesses: table }) })
  });
  assert.equal(res.status, 'BLOCKED');
  assert.match(res.reason, new RegExp(`^attempt-not-settled: process-alive: .*recorded:${FAKE_KID}`), 'LH-03: the survivor is named');
  const a = out.lease.attempts[0];
  assert.equal(a.settled, false, 'LH-03: settled only when the root and every recorded descendant are gone by identity');
  assert.deepEqual(a.descendants.map(d => d.pid), [FAKE_KID]);
  assert.match(a.unsettledReason, /process-alive/);
  assert.deepEqual(out.decision, { allow: false, reason: 'unsettled-attempt' }, 'LH-03: a later start is refused');
});

test('LH-04 a process nobody recorded, alive after the stop, is persisted by identity, keeps the attempt unclean and blocks a start', async () => {
  let table = null;
  const { res, out } = await run(4, { stallSeconds: 1, hardSeconds: 60 }, 'silent', {
    // the orphan appears only once the root is gone, after the last chance to record it
    before: ctx => { table = fakeTable(ctx, orphanAfterRootDies); return { snapshotProcesses: table }; },
    after: ctx => ({ lease: leaseOf(ctx), decision: executor.leaseStartDecision(ctx.slot.id, ctx.stateDir, { snapshotProcesses: table }) })
  });
  assert.equal(res.status, 'BLOCKED');
  assert.match(res.reason, new RegExp(`unrecorded:${FAKE_ORPHAN}`));
  assert.deepEqual(res.unrecordedProcesses, [FAKE_ORPHAN], 'LH-04: the result names it');
  const a = out.lease.attempts[0];
  assert.equal(a.settled, false);
  assert.deepEqual(a.unrecorded.map(u => u.pid), [FAKE_ORPHAN], 'LH-04: persisted in the lease');
  assert.equal(a.unrecorded[0].createdAt, KID_T, 'LH-04: with its creation time, not a bare PID');
  assert.equal(out.decision.allow, false);
});

test('LH-05 the natural-exit path computes unrecorded too and applies the same rule', async () => {
  let table = null;
  // the client ends by itself after 1 s, before the first tick records anything
  const { res, out } = await run(1, { stallSeconds: 5, hardSeconds: 60 }, 'silent', {
    before: ctx => { table = fakeTable(ctx, orphanAfterRootDies); return { snapshotProcesses: table }; },
    after: ctx => leaseOf(ctx)
  });
  assert.equal(res.status, 'BLOCKED', 'LH-05: not INVALID_OUTPUT or DONE: an unclean attempt is not a result');
  assert.match(res.reason, new RegExp(`^attempt-not-settled: process-alive: unrecorded:${FAKE_ORPHAN}`));
  assert.equal(out.attempts[0].settled, false);
});

test('LH-06 contrast: a clean natural exit settles and the run goes on with its normal result', async () => {
  const { res, out } = await run(1, { stallSeconds: 5, hardSeconds: 60 }, 'silent', {
    before: ctx => ({ snapshotProcesses: fakeTable(ctx, () => []) }),
    after: ctx => leaseOf(ctx)
  });
  assert.equal(res.class, 'INVALID_OUTPUT', 'LH-06: the client wrote no declared output, which is a normal failed attempt');
  assert.equal(out.attempts[0].settled, true);
});

test('LH-07 only the owner-facing force-settle, with a recorded ack, releases an attempt left by an unrecorded survivor', async () => {
  let table = null;
  const { out } = await run(4, { stallSeconds: 1, hardSeconds: 60 }, 'silent', {
    before: ctx => { table = fakeTable(ctx, orphanAfterRootDies); return { snapshotProcesses: table }; },
    after: ctx => {
      const needing = executor.attemptsNeedingAck(ctx.slot.id, ctx.stateDir).length;
      const settled = executor.forceSettle(ctx.slot.id, ctx.stateDir, 'owner saw the orphan');
      const lease = { ...leaseOf(ctx), supervisor: null };
      return { needing, settled, a: lease.attempts[0], decision: leaseLib.decideStart({ lease, table: table() }) };
    }
  });
  assert.equal(out.needing, 1);
  assert.equal(out.settled, 1);
  assert.equal(out.a.settled, true);
  assert.equal(out.a.ack.note, 'owner saw the orphan', 'LH-07: the ack is recorded');
  assert.match(out.a.ack.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.deepEqual(out.decision, { allow: true, reason: 'ok' }, 'LH-07: acknowledged, the unrecorded survivor no longer blocks');
});

test('LH-08 a start refused for an unrecorded orphan tells the owner pid, createdAt and the exact --ack command, on screen and in the state file', async () => {
  const cli = require('../.ai/bin/protocol-dispatch/cli.cjs');
  const tmp = tt.mkTmp('s4t04-ref-');
  const logs = [];
  const realLog = console.log;
  try {
    const ORPHAN_AT = '2026-10-06T12:00:03.000Z';
    const stateDir = path.join(tmp, 'state');
    fs.mkdirSync(stateDir);
    const dispatchFile = path.join(tmp, 'dispatch.json');
    fs.writeFileSync(dispatchFile, JSON.stringify({ stateDir: 'state', slots: [{ id: 'slot-o', launch: 'launch.md', out: 'out.txt', route: { client: 'talker', model: 'test' } }] }));
    executor.writeLease('slot-o', stateDir, {
      supervisor: null,
      attempts: [{ root: { pid: 100, createdAt: '2026-10-06T12:00:01.000Z' }, descendants: [], unrecorded: [{ pid: 4242, createdAt: ORPHAN_AT }], settled: true }]
    });
    const table = () => [{ pid: 4242, ppid: 1, createdAt: ORPHAN_AT }];
    console.log = (...a) => logs.push(a.join(' '));
    let code;
    try { code = await cli.runDispatch(dispatchFile, [], { repoRoot: tmp, snapshotProcesses: table }); } finally { console.log = realLog; }
    assert.notEqual(code, 0, 'a refused start is not a success');
    const text = logs.join('\n');
    const command = `node .ai/bin/protocol-dispatch.cjs stop ${dispatchFile} slot-o --ack "<note>"`;
    assert.match(text, /reason=lease-refused slot=slot-o detail=unrecorded-process-alive/);
    assert.ok(text.includes(`orphan pid=4242 createdAt=${ORPHAN_AT}`), `the message names the orphan: ${text}`);
    assert.ok(text.includes(command), `the message carries the exact command: ${text}`);
    const rec = JSON.parse(fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8')).slots['slot-o'].lastRefusedStart;
    assert.equal(rec.reason, 'unrecorded-process-alive');
    assert.deepEqual(rec.orphans, [{ pid: 4242, createdAt: ORPHAN_AT }], 'the launch record carries the orphan identity');
    assert.equal(rec.ackCommand, command);
  } finally {
    console.log = realLog;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

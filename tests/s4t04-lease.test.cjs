'use strict';

// Fixtures for S4-T04 rules LS-* (lease, identity PID + creation time, leaf-first stop; R-L3-004.7).
// Fake process table, no real processes except SL-* which use the current process only.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadSpecModule, requireFn, proc, dispatchDir } = require('./s4t04-helpers.cjs');
const { tt } = require('./helpers.cjs');

const lease = () => loadSpecModule('lease');
const T0 = '2026-10-06T12:00:00.000Z';
const T1 = '2026-10-06T12:00:01.000Z';
const T2 = '2026-10-06T12:00:02.000Z';
const T3 = '2026-10-06T12:00:03.000Z';
const TX = '2026-10-06T11:00:00.000Z'; // another process that reused the PID

const id = (pid, createdAt) => ({ pid, createdAt });

function record(over = {}) {
  return {
    supervisor: id(10, T0),
    attempts: [{ root: id(100, T1), descendants: [id(101, T2)], settled: false }],
    ...over
  };
}

test('LS-01 a process is the same only when PID and creation time both match', () => {
  const sameProcess = requireFn(lease(), 'sameProcess', 'LS-01');
  assert.equal(sameProcess(id(7, T0), proc(7, 1, T0)), true);
  assert.equal(sameProcess(id(7, T0), proc(7, 1, TX)), false, 'LS-01: a reused PID is another process');
  assert.equal(sameProcess(id(7, T0), proc(8, 1, T0)), false);
  assert.equal(sameProcess(id(7, T0), null), false);
});

test('LS-02 a live supervisor (by identity) blocks a second start', () => {
  const decideStart = requireFn(lease(), 'decideStart', 'LS-02');
  const r = decideStart({ lease: record(), table: [proc(10, 1, T0)] });
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'running-supervisor-alive');
});

test('LS-03 a dead supervisor does not release an unsettled attempt', () => {
  const decideStart = requireFn(lease(), 'decideStart', 'LS-03');
  const r = decideStart({ lease: record(), table: [] });
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'unsettled-attempt');
});

test('LS-04 dead supervisor, settled attempt, nothing recorded alive: the start is allowed', () => {
  const decideStart = requireFn(lease(), 'decideStart', 'LS-04');
  const settled = record({ attempts: [{ root: id(100, T1), descendants: [id(101, T2)], settled: true }] });
  const r = decideStart({ lease: settled, table: [proc(1, 0, TX)] });
  assert.deepEqual(r, { allow: true, reason: 'ok' });
});

test('LS-05 a PID reused by another process is not the supervisor', () => {
  const decideStart = requireFn(lease(), 'decideStart', 'LS-05');
  const settled = record({ attempts: [{ root: id(100, T1), descendants: [], settled: true }] });
  assert.deepEqual(decideStart({ lease: settled, table: [proc(10, 1, TX)] }), { allow: true, reason: 'ok' },
    'LS-05: PID 10 is alive but created at another time, so the supervisor is dead and the attempt is settled');
  const r = decideStart({ lease: record(), table: [proc(10, 1, TX)] });
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'unsettled-attempt', 'LS-05: PID reuse must not hide an unsettled attempt either');
});

test('LS-06 a recorded process alive by identity blocks a start whatever state the record was left in', () => {
  const decideStart = requireFn(lease(), 'decideStart', 'LS-06');
  const settled = record({ attempts: [{ root: id(100, T1), descendants: [id(101, T2)], settled: true }] });
  const r = decideStart({ lease: settled, table: [proc(101, 100, T2)] });
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'recorded-process-alive');
  const reused = decideStart({ lease: settled, table: [proc(101, 1, TX)] });
  assert.deepEqual(reused, { allow: true, reason: 'ok' }, 'LS-06: the same PID with another creation time is not the recorded descendant');
});

test('LS-07 the stop plan is leaf first, descendants by PID, the root last through its handle, never a tree kill', () => {
  const planStop = requireFn(lease(), 'planStop', 'LS-07');
  const table = [proc(100, 10, T1), proc(101, 100, T2), proc(102, 101, T3), proc(103, 101, T3)];
  const recorded = { root: id(100, T1), descendants: [id(101, T2), id(102, T3), id(103, T3)] };
  const plan = planStop({ root: recorded.root, recorded: recorded.descendants, table });
  const ops = plan.steps.map(s => s.op);
  assert.ok(ops.every(op => op === 'kill-pid' || op === 'kill-handle'), `LS-07: only kill-pid and kill-handle exist, got ${ops.join(',')}`);
  assert.deepEqual(plan.steps[plan.steps.length - 1], { op: 'kill-handle', pid: 100 }, 'LS-07: the root goes last, through the dispatcher\'s own child handle');
  const order = plan.steps.filter(s => s.op === 'kill-pid').map(s => s.pid);
  assert.deepEqual([...order].sort(), [101, 102, 103]);
  assert.ok(order.indexOf(102) < order.indexOf(101) && order.indexOf(103) < order.indexOf(101), 'LS-07: a parent is stopped only after its children');
  assert.deepEqual(plan.skipped, []);
});

test('LS-08 a descendant is stopped only if its identity is confirmed in the fresh table', () => {
  const planStop = requireFn(lease(), 'planStop', 'LS-08');
  const table = [proc(100, 10, T1), proc(101, 100, TX), proc(102, 100, T3)];
  const plan = planStop({ root: id(100, T1), recorded: [id(101, T2), id(102, T3), id(104, T3)], table });
  assert.deepEqual(plan.steps.filter(s => s.op === 'kill-pid').map(s => s.pid), [102]);
  const reasons = Object.fromEntries(plan.skipped.map(s => [s.pid, s.reason]));
  assert.equal(reasons[101], 'identity-mismatch', 'LS-08: PID 101 now belongs to another process');
  assert.equal(reasons[104], 'not-running', 'LS-08: PID 104 is gone');
});

test('LS-09 a descendant older than its parent is not trusted, an unrecorded child is reported, not killed', () => {
  const planStop = requireFn(lease(), 'planStop', 'LS-09');
  const table = [proc(100, 10, T1), proc(101, 100, T2), proc(102, 101, T0), proc(105, 101, T3)];
  const plan = planStop({ root: id(100, T1), recorded: [id(101, T2), id(102, T0)], table });
  assert.deepEqual(plan.steps.filter(s => s.op === 'kill-pid').map(s => s.pid), [101]);
  assert.equal(plan.skipped.find(s => s.pid === 102).reason, 'older-than-parent');
  assert.deepEqual(plan.unrecorded, [105], 'LS-09: a live child nobody recorded is named for the owner, never selected by parent linkage');
});

test('SL-01 the start lock records PID and creation time, not a bare PID', () => {
  const { takeStartLock, releaseStartLock } = require('../.ai/bin/protocol-dispatch/executor.cjs');
  const dir = tt.mkTmp('s4t04-sl-');
  try {
    assert.equal(takeStartLock('slot-a', dir), true);
    const body = JSON.parse(fs.readFileSync(path.join(dir, 'slot-a.startlock'), 'utf8'));
    assert.equal(body.pid, process.pid, 'SL-01: the lock body is {pid, createdAt}');
    assert.match(String(body.createdAt), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'SL-01: createdAt is an ISO UTC string with milliseconds');
    releaseStartLock('slot-a', dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SL-02 a start lock whose PID is alive but created at another time is stale; the true identity still blocks', () => {
  const { takeStartLock } = require('../.ai/bin/protocol-dispatch/executor.cjs');
  const procfs = require('../.ai/bin/protocol-dispatch/procfs.cjs');
  const identityOf = requireFn(procfs, 'identityOf', 'SL-02');
  const dir = tt.mkTmp('s4t04-sl-');
  try {
    const own = identityOf(process.pid);
    assert.equal(own.pid, process.pid);
    assert.equal(identityOf(process.pid).createdAt, own.createdAt, 'SL-02: the identity is stable between reads');

    fs.writeFileSync(path.join(dir, 'slot-b.startlock'), JSON.stringify({ pid: process.pid, createdAt: '1999-01-01T00:00:00.000Z' }));
    assert.equal(takeStartLock('slot-b', dir), true, 'SL-02: a reused PID does not hold the lock');

    fs.writeFileSync(path.join(dir, 'slot-c.startlock'), JSON.stringify(own));
    assert.equal(takeStartLock('slot-c', dir), false, 'SL-02: the live holder by identity keeps the lock');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LN-01 no kernel dispatch source selects children by parent linkage (taskkill /T)', () => {
  const files = fs.readdirSync(dispatchDir).filter(f => f.endsWith('.cjs')).map(f => path.join(dispatchDir, f));
  files.push(path.join(dispatchDir, '..', 'protocol-dispatch.cjs'));
  const hits = [];
  for (const file of files) {
    fs.readFileSync(file, 'utf8').split(/\r?\n/).forEach((line, i) => {
      if (/['"]\/T['"]/i.test(line)) hits.push(`${path.relative(dispatchDir, file)}:${i + 1}`);
    });
  }
  assert.deepEqual(hits, [], 'LN-01: R-L3-004.7 forbids a tree kill that selects children by parent linkage');
});

// Owner probes R1-R3 and the lease/stop hardening: an unreadable table is null, never [], and never permits anything.

const ack = { at: '2026-10-06T13:00:00.000Z', note: 'owner' };

test('LH-R1 snapshotProcesses says "unavailable" with null, never a bare empty table', () => {
  const procfs = require('../.ai/bin/protocol-dispatch/procfs.cjs');
  const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  const realPath = process.env.PATH;
  const pathKey = Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') || 'PATH';
  try {
    // the Windows reader needs powershell.exe; with an empty PATH it cannot start on any OS, so the read fails
    Object.defineProperty(process, 'platform', { value: 'win32' });
    process.env[pathKey] = '';
    const table = procfs.snapshotProcesses();
    assert.equal(table, null, 'R1: a failed read is null, not [] (which looks like "no processes")');
  } finally {
    Object.defineProperty(process, 'platform', realPlatform);
    process.env[pathKey] = realPath;
  }
  const live = procfs.snapshotProcesses();
  assert.ok(Array.isArray(live) && live.some(p => p.pid === process.pid), 'R1: a real read lists at least this process');
});

test('LH-R3 an unavailable table refuses a start whatever the lease holds (settled or not)', () => {
  const decideStart = requireFn(lease(), 'decideStart', 'LH-R3');
  const settled = record({ attempts: [{ root: id(100, T1), descendants: [id(101, T2)], settled: true }] });
  assert.deepEqual(decideStart({ lease: settled, table: null }), { allow: false, reason: 'table-unavailable' }, 'R3: the recorded executor may still live');
  assert.deepEqual(decideStart({ lease: record(), table: null }), { allow: false, reason: 'table-unavailable' });
  assert.deepEqual(decideStart({ lease: record({ supervisor: null, attempts: [] }), table: null }), { allow: false, reason: 'table-unavailable' });
  assert.deepEqual(decideStart({ lease: settled, table: undefined }), { allow: false, reason: 'table-unavailable' });
  assert.deepEqual(decideStart({ lease: null, table: null }), { allow: true, reason: 'ok' }, 'nothing recorded, nothing to protect');
});

test('LH-R2 planStop with an unavailable table plans nothing and says so, so no caller can settle on it', () => {
  const planStop = requireFn(lease(), 'planStop', 'LH-R2');
  const plan = planStop({ root: id(100, T1), recorded: [id(101, T2)], table: null });
  assert.deepEqual(plan, { steps: [], skipped: [], unrecorded: [], unrecordedIdentities: [], tableUnavailable: true });
  const empty = planStop({ root: id(100, T1), recorded: [id(101, T2)], table: [] });
  assert.ok(!empty.tableUnavailable, 'an empty array is a readable table: its steps stay the old ones');
});

test('LH-V1 verifyStopped: the root and every recorded or unrecorded process must be gone by identity', () => {
  const verifyStopped = requireFn(lease(), 'verifyStopped', 'LH-V1');
  const root = id(100, T1);
  const recorded = [id(101, T2)];
  const unrecorded = [id(105, T3)];
  assert.deepEqual(verifyStopped({ root, recorded, unrecorded, table: null }), { verified: false, reason: 'table-unavailable', alive: [] });
  assert.equal(verifyStopped({ root, recorded, unrecorded, table: [proc(1, 0, TX)] }).verified, true);
  const survivor = verifyStopped({ root, recorded, unrecorded, table: [proc(101, 100, T2)] });
  assert.equal(survivor.verified, false);
  assert.deepEqual(survivor.alive.map(a => `${a.role}:${a.pid}`), ['recorded:101']);
  assert.deepEqual(verifyStopped({ root, recorded, unrecorded, table: [proc(100, 10, T1)] }).alive.map(a => a.role), ['root']);
  assert.deepEqual(verifyStopped({ root, recorded, unrecorded, table: [proc(105, 1, T3)] }).alive.map(a => a.role), ['unrecorded']);
  assert.equal(verifyStopped({ root, recorded, unrecorded, table: [proc(101, 1, TX), proc(105, 1, TX)] }).verified, true, 'a reused PID is another process');
});

test('LH-U1 an unrecorded process alive by identity blocks a start of a settled attempt until the attempt carries an ack', () => {
  const decideStart = requireFn(lease(), 'decideStart', 'LH-U1');
  const unclean = record({ attempts: [{ root: id(100, T1), descendants: [], unrecorded: [id(105, T3)], settled: true }] });
  assert.deepEqual(decideStart({ lease: unclean, table: [proc(105, 1, T3)] }), { allow: false, reason: 'unrecorded-process-alive', orphans: [id(105, T3)] });
  assert.deepEqual(decideStart({ lease: unclean, table: [proc(105, 1, TX)] }), { allow: true, reason: 'ok' }, 'PID reuse is not the unrecorded process');
  const acked = record({ attempts: [{ root: id(100, T1), descendants: [], unrecorded: [id(105, T3)], settled: true, ack }] });
  assert.deepEqual(decideStart({ lease: acked, table: [proc(105, 1, T3)] }), { allow: true, reason: 'ok' }, 'the owner accepted it');
  const ackedRecorded = record({ attempts: [{ root: id(100, T1), descendants: [id(101, T2)], unrecorded: [], settled: true, ack }] });
  assert.equal(decideStart({ lease: ackedRecorded, table: [proc(101, 100, T2)] }).reason, 'recorded-process-alive', 'an ack never covers a recorded process');
});

test('LH-U2 findUnrecorded: an orphan of a dead root is found by the stale parent PID, a reused parent PID is not trusted', () => {
  const findUnrecorded = requireFn(lease(), 'findUnrecorded', 'LH-U2');
  const root = id(100, T1);
  const orphan = [proc(1, 0, TX), proc(105, 100, T3)];
  assert.deepEqual(findUnrecorded({ root, recorded: [], table: orphan }), [id(105, T3)], 'the root is dead, the child still names it');
  const older = [proc(1, 0, TX), proc(105, 100, T0)];
  assert.deepEqual(findUnrecorded({ root, recorded: [], table: older }), [], 'created before the root: not its child');
  const reused = [proc(1, 0, TX), proc(100, 1, T2), proc(105, 100, T3)];
  assert.deepEqual(findUnrecorded({ root, recorded: [], table: reused }), [], 'PID 100 is now another process: its children are not ours');
});

test('LH-W1 writeLease is atomic: a failure throws, leaves the previous lease whole and no temp file behind', () => {
  const executor = require('../.ai/bin/protocol-dispatch/executor.cjs');
  const dir = tt.mkTmp('s4t04-wl-');
  try {
    const good = { supervisor: null, attempts: [{ root: id(100, T1), descendants: [], settled: true }] };
    executor.writeLease('slot-w', dir, good);
    assert.deepEqual(executor.readLease('slot-w', dir), good);

    const circular = { attempts: [] };
    circular.self = circular;
    assert.throws(() => executor.writeLease('slot-w', dir, circular), executor.LeaseWriteError, 'a failed write is an error, not silence');
    assert.deepEqual(executor.readLease('slot-w', dir), good, 'the previous lease is intact');

    fs.mkdirSync(path.join(dir, 'slot-d.lease.json'));
    assert.throws(() => executor.writeLease('slot-d', dir, good), /lease-write-failed/, 'a rename that cannot happen is an error');
    assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), [], 'no temp file is left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LH-O1 the unrecorded refusal names every live orphan (pid + createdAt) of every unacknowledged attempt, and only those', () => {
  const decideStart = requireFn(lease(), 'decideStart', 'LH-O1');
  const two = record({
    supervisor: null,
    attempts: [
      { root: id(100, T1), descendants: [], unrecorded: [id(105, T3), id(106, T3)], settled: true },
      { root: id(200, T1), descendants: [], unrecorded: [id(205, T2)], settled: true, ack },
      { root: id(300, T1), descendants: [], unrecorded: [id(305, T2)], settled: true }
    ]
  });
  const table = [proc(105, 1, T3), proc(106, 1, TX), proc(205, 1, T2), proc(305, 1, T2)];
  const r = decideStart({ lease: two, table });
  assert.equal(r.allow, false);
  assert.equal(r.reason, 'unrecorded-process-alive');
  assert.deepEqual(r.orphans, [id(105, T3), id(305, T2)], 'alive by identity (106 is a reused PID), acknowledged attempt (205) left out');
});

test('LH-O2 refusalReport: lines carry reason, pid and createdAt of every orphan and the exact stop --ack command; other reasons carry no orphans', () => {
  const refusalReport = requireFn(lease(), 'refusalReport', 'LH-O2');
  const decision = { allow: false, reason: 'unrecorded-process-alive', orphans: [id(105, T3), id(305, T2)] };
  const { lines, record: rec } = refusalReport({ dispatchFile: 'docs/ops/d.json', slotId: 'slot-a', decision });
  const text = lines.join('\n');
  assert.match(text, /reason=lease-refused slot=slot-a detail=unrecorded-process-alive/);
  assert.ok(text.includes(`orphan pid=105 createdAt=${T3}`));
  assert.ok(text.includes(`orphan pid=305 createdAt=${T2}`));
  assert.ok(text.includes('node .ai/bin/protocol-dispatch.cjs stop docs/ops/d.json slot-a --ack "<note>"'), 'the exact release command with the real names');
  assert.deepEqual(rec.orphans, [id(105, T3), id(305, T2)]);
  assert.equal(rec.ackCommand, 'node .ai/bin/protocol-dispatch.cjs stop docs/ops/d.json slot-a --ack "<note>"');
  assert.equal(rec.reason, 'unrecorded-process-alive');

  const other = refusalReport({ dispatchFile: 'd.json', slotId: 's', decision: { allow: false, reason: 'recorded-process-alive' } });
  assert.deepEqual(other.record, { reason: 'recorded-process-alive' });
  assert.equal(other.lines.length, 1);
});

'use strict';

// Fixtures for S4-T04 rules LV-* (one liveness, R-L3-004.6 / R-L3-004.8). Fake clock, no real time, no processes.

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSpecModule, requireFn, makeClock, sample, MIN } = require('./s4t04-helpers.cjs');

const live = () => loadSpecModule('liveness');

function tracker(limitsOver = {}) {
  const m = live();
  const resolveLimits = requireFn(m, 'resolveLimits', 'LV-00');
  const createTracker = requireFn(m, 'createTracker', 'LV-00');
  const clock = makeClock();
  const limits = resolveLimits(limitsOver);
  return { clock, limits, t: createTracker({ limits, firstLaunchAt: clock.now() }) };
}

test('LV-01 defaults are idle 10 min, hard 120 min, 3 wakes', () => {
  const resolveLimits = requireFn(live(), 'resolveLimits', 'LV-01');
  assert.deepEqual(resolveLimits({}), { stallMs: 10 * MIN, hardMs: 120 * MIN, maxWakes: 3 });
});

test('LV-02 the dispatch file may set the stall interval 5..120 min, nothing else is accepted', () => {
  const resolveLimits = requireFn(live(), 'resolveLimits', 'LV-02');
  assert.equal(resolveLimits({ stallMin: 5 }).stallMs, 5 * MIN);
  assert.equal(resolveLimits({ stallMin: 120 }).stallMs, 120 * MIN);
  for (const bad of [4, 121, 0, -1, 7.5, '10', NaN]) {
    assert.throws(() => resolveLimits({ stallMin: bad }), e => e.code === 'LIMIT_RANGE', `LV-02: stallMin=${String(bad)} must throw LIMIT_RANGE`);
  }
});

test('LV-03 hard ceiling is checked on every tick and progress never resets it', () => {
  const { clock, t } = tracker();
  let timeoutAt = null;
  for (let minute = 1; minute <= 125; minute++) {
    clock.advance(MIN);
    const r = t.tick(sample(clock.now(), { ownLines: ['step done, continuing'], outputsChanged: true, journalsChanged: true }));
    if (r.verdict === 'TIMEOUT') { timeoutAt = minute; assert.equal(r.state, 'BLOCKED', 'LV-03: TIMEOUT stops the step as BLOCKED'); assert.equal(r.resume, false, 'LV-03: a TIMEOUT session is never resumed'); break; }
    assert.equal(r.verdict, 'OK', `LV-03: minute ${minute} has progress and is under the ceiling`);
  }
  assert.equal(timeoutAt, 120, 'LV-03: the ceiling fires at 120 min from the first launch although every tick made progress');
});

test('LV-04 a wake does not move the hard ceiling (it runs from the first launch)', () => {
  const { clock, t } = tracker();
  clock.advance(10 * MIN);
  assert.equal(t.tick(sample(clock.now())).verdict, 'STALL');
  assert.deepEqual(t.wake(clock.now()), { action: 'WAKE', n: 1 });
  clock.advance(50 * MIN);
  assert.equal(t.tick(sample(clock.now(), { ownLines: ['working again'] })).verdict, 'OK');
  clock.advance(59 * MIN);
  assert.equal(t.tick(sample(clock.now(), { ownLines: ['still working'] })).verdict, 'OK', 'LV-04: 119 min is under the ceiling');
  clock.advance(1 * MIN);
  const r = t.tick(sample(clock.now(), { ownLines: ['still working'] }));
  assert.equal(r.verdict, 'TIMEOUT', 'LV-04: 120 min from the first launch is TIMEOUT even after a wake and fresh progress');
});

test('LV-05 heartbeat, tree mtime and CPU are not progress: the stall fires at idle 10 min', () => {
  const { clock, t } = tracker();
  let verdictAt = null;
  for (let minute = 1; minute <= 12; minute++) {
    clock.advance(MIN);
    const r = t.tick(sample(clock.now(), { heartbeat: true, treeMtimeChanged: true, cpuMs: minute * 60000 }));
    if (r.verdict === 'STALL') { verdictAt = minute; break; }
    assert.equal(r.verdict, 'OK');
  }
  assert.equal(verdictAt, 10, 'LV-05: only the agent\'s own output counts; a live launcher heartbeat does not keep a silent agent alive');
});

test('LV-06 error-only and retry-only lines are not progress; a normal line is', () => {
  const { clock, t } = tracker();
  for (let minute = 1; minute <= 9; minute++) {
    clock.advance(MIN);
    assert.equal(t.tick(sample(clock.now(), { ownLines: ['HTTP 503 Service Unavailable', 'retrying in 5s'] })).verdict, 'OK');
  }
  clock.advance(MIN);
  assert.equal(t.tick(sample(clock.now(), { ownLines: ['HTTP 503 Service Unavailable', 'retrying in 5s'] })).verdict, 'STALL',
    'LV-06: a retry loop reaches the stall interval');

  const b = tracker();
  b.clock.advance(9 * MIN);
  assert.equal(b.t.tick(sample(b.clock.now(), { ownLines: ['wrote section 3'] })).verdict, 'OK');
  b.clock.advance(9 * MIN);
  assert.equal(b.t.tick(sample(b.clock.now())).verdict, 'OK', 'LV-06: idle is measured from the last real progress (9 min)');
  b.clock.advance(1 * MIN);
  assert.equal(b.t.tick(sample(b.clock.now())).verdict, 'STALL', 'LV-06: 10 min after the last real progress');
});

test('LV-07 changed declared outputs and new or grown journals are progress', () => {
  for (const key of ['outputsChanged', 'journalsChanged']) {
    const { clock, t } = tracker();
    clock.advance(9 * MIN);
    assert.equal(t.tick(sample(clock.now(), { [key]: true })).verdict, 'OK');
    clock.advance(9 * MIN);
    assert.equal(t.tick(sample(clock.now())).verdict, 'OK', `LV-07: ${key} reset the idle window`);
  }
});

test('LV-08 three wakes, then FALLEN with class STALL; each wake opens a new idle window', () => {
  const { clock, t } = tracker();
  for (let n = 1; n <= 3; n++) {
    clock.advance(10 * MIN);
    assert.equal(t.tick(sample(clock.now())).verdict, 'STALL', `LV-08: stall before wake ${n}`);
    assert.deepEqual(t.wake(clock.now()), { action: 'WAKE', n });
    clock.advance(9 * MIN);
    assert.equal(t.tick(sample(clock.now())).verdict, 'OK', `LV-08: wake ${n} opened a fresh 10 min window`);
    clock.advance(MIN);
  }
  // 10 min after the third wake: the window expired again with no progress
  assert.deepEqual(t.wake(clock.now()), { action: 'FALLEN', class: 'STALL' }, 'LV-08: the fourth stall is recorded as fallen');
});

test('LV-08 a resumed attempt opens its idle window at the resume moment while the hard ceiling stays at the first launch', () => {
  const m = live();
  const clock = makeClock();
  const limits = requireFn(m, 'resolveLimits', 'LV-08')({ stallMin: 5, hardMin: 30 });
  const firstLaunchAt = clock.now();
  clock.advance(20 * MIN);
  // production shape (cli.cjs): a new tracker for the resumed attempt, firstLaunchAt of the step, idle origin = resume
  const t = requireFn(m, 'createTracker', 'LV-08')({ limits, firstLaunchAt, idleStartAt: clock.now() });
  assert.deepEqual(t.wake(clock.now()), { action: 'WAKE', n: 1 });
  clock.advance(4 * MIN);
  assert.equal(t.tick(sample(clock.now())).verdict, 'OK', 'LV-08: 4 min after the resume the window is still open');
  clock.advance(MIN);
  assert.equal(t.tick(sample(clock.now())).verdict, 'STALL', 'LV-08: the window is exactly the stall interval from the resume');
  clock.advance(5 * MIN);
  const r = t.tick(sample(clock.now()));
  assert.equal(r.verdict, 'TIMEOUT', 'LV-04: the hard ceiling still runs from the first launch (30 min)');
  assert.equal(r.elapsedMs, 30 * MIN);
});

test('LV-08 one wake budget spans the attempts of a wake chain: three wakes, the fourth stretch is FALLEN', () => {
  const m = live();
  const clock = makeClock();
  const limits = requireFn(m, 'resolveLimits', 'LV-08')({});
  const budget = requireFn(m, 'createWakeBudget', 'LV-08')();
  const firstLaunchAt = clock.now();
  for (let n = 1; n <= 3; n++) {
    clock.advance(10 * MIN);
    assert.equal(budget.exhausted(), false);
    const t = m.createTracker({ limits, firstLaunchAt, idleStartAt: clock.now(), wakeBudget: budget });
    assert.deepEqual(t.wake(clock.now()), { action: 'WAKE', n }, `LV-08: wake ${n} of a fresh tracker counts on the shared budget`);
    assert.equal(budget.used(), n);
  }
  assert.equal(budget.exhausted(), true);
  const t4 = m.createTracker({ limits, firstLaunchAt, idleStartAt: clock.now(), wakeBudget: budget });
  assert.deepEqual(t4.wake(clock.now()), { action: 'FALLEN', class: 'STALL' }, 'LV-08: the fourth idle stretch is FALLEN of class STALL');
  assert.equal(budget.used(), 3);
});

test('LV-09 FALLEN is derived only from state FAILED + class STALL of the run record', () => {
  const fallenOf = requireFn(live(), 'fallenOf', 'LV-09');
  assert.equal(fallenOf({ state: 'FAILED', class: 'STALL' }), true);
  for (const rec of [
    { state: 'FAILED', class: 'TIMEOUT' },
    { state: 'BLOCKED', class: 'TIMEOUT' },
    { state: 'BLOCKED', class: 'STALL' },
    { state: 'FAILED', class: 'PROCESS_CRASH' },
    { state: 'FAILED', class: 'INVALID_OUTPUT' },
    { state: 'DONE', class: 'NONE' },
    ...['INTERRUPTED', 'TRANSPORT', 'QUOTA', 'AUTH', 'UNKNOWN', 'CONTENT'].map(c => ({ state: 'FAILED', class: c }))
  ]) {
    assert.equal(fallenOf(rec), false, `LV-09: ${rec.state}/${rec.class} must not be FALLEN (launch-record classes never produce FALLEN)`);
  }
});

test('LV-10 the operator watchdog is a WARN instance of the same liveness, never a second canon and never a kill', () => {
  const warnView = requireFn(live(), 'warnView', 'LV-10');
  assert.equal(warnView({ verdict: 'OK' }), null);
  assert.deepEqual(warnView({ verdict: 'STALL' }), { level: 'WARN', kill: false, verdict: 'STALL' });
  assert.deepEqual(warnView({ verdict: 'TIMEOUT' }), { level: 'WARN', kill: false, verdict: 'TIMEOUT' });
});

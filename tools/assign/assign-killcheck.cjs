'use strict';
// The criteria that return a class (or a route, or everything) from assign to advise. A PURE function: records in, actions out.
// It writes nothing and never returns a release: a class comes back only by an operator act (assign-control.cjs release). Design
// Thresholds are data (assign-execution-policy.json).
//
//   runs        one row per ASSIGNED launch: { assignmentId, taskClass, client, route, status: running | done | failed | not-started,
//               failureClass, startedAt, closedAt, silentMinutes, idleStop }. A repeated assignmentId counts once: the row
//               with the latest closedAt (then startedAt) wins, so a double outcome event never doubles a failure.
//   baseline    the operator's own advise pairs of the same classes: { taskClass, outcome: done | failed, at }
//   violations  post-audit findings against the owner's rules: { assignmentId, taskClass, rule, at }
//   state       what the state file already holds (demoted, quarantinedRoutes, hold): a standing action is not repeated
//   integrity   { feedbackWritable, stateReadable, policyReadable, modeLive }: a false value means advise, without any state write
const DAY = 86400000, HOUR = 3600000;
const ms = s => Date.parse(s);
const at = r => ms(r.closedAt || r.startedAt || 0) || 0;

function latestPerId(runs) {
  const by = new Map();
  for (const r of runs) {
    const prev = by.get(r.assignmentId);
    if (!prev || at(r) >= at(prev)) by.set(r.assignmentId, r);
  }
  return [...by.values()];
}
const classes = rows => [...new Set(rows.map(r => r.taskClass))].sort();

function killcheck(input, policy, now) {
  const src = input || {};
  const { baseline = [], violations = [], state = {}, integrity = {} } = src;
  const k = policy.killcheck;
  const reasons = Object.entries({ 'feedback-unwritable': integrity.feedbackWritable, 'state-unreadable': integrity.stateReadable,
    'policy-unreadable': integrity.policyReadable, 'mode-expired': integrity.modeLive }).filter(([, v]) => v === false).map(([name]) => name);
  // Integrity: the mode falls back to advise for as long as the cause stands, and the state is not touched (it clears itself).
  if (reasons.length) return { effective: 'advise', reasons, actions: [] };
  const runs = latestPerId(Array.isArray(src.runs) ? src.runs : []);
  const standing = { demoted: state.demoted || {}, quarantined: state.quarantinedRoutes || {} };
  const actions = [];
  const push = a => { if (!actions.some(x => x.kind === a.kind && x.target === a.target && x.rule === a.rule)) actions.push(a); };
  const inWindow = (t, days) => now - t <= days * DAY && t <= now;
  const demote = (cls, rule, evidence) => { if (!Object.hasOwn(standing.demoted, cls)) push({ kind: 'demote', target: cls, rule, evidence: evidence.slice(0, 20) }); };

  // 1. owner-rule violations: one is enough, and it stops all of assign
  for (const v of violations) if (!state.hold) push({ kind: 'hold', target: 'all', rule: `owner-rule-${v.rule}`, evidence: [`${v.assignmentId}`] });

  const fr = k.failureRate;
  for (const cls of classes(runs)) {
    const mine = runs.filter(r => r.taskClass === cls);
    // a launch that never started, and a stop by the owner, is not a failure of the model
    const done = mine.filter(r => ['done', 'failed'].includes(r.status) && inWindow(at(r), k.windowDays)).sort((a, b) => at(a) - at(b));
    const failed = done.filter(r => r.status === 'failed');
    // 2. the failure rate against the operator's own choices on the same class; the absolute threshold when the reference is too small
    if (done.length >= fr.minCompleted && failed.length >= fr.minFailures) {
      const ref = baseline.filter(b => b.taskClass === cls && inWindow(ms(b.at), k.windowDays));
      const refRate = ref.length >= fr.minBaselinePairs ? ref.filter(b => b.outcome === 'failed').length / ref.length : fr.absoluteRate;
      const rate = failed.length / done.length;
      if (rate > refRate) demote(cls, 'failure-rate', failed.map(r => r.assignmentId));
    }
    const tail = done.slice(-fr.consecutive);
    if (tail.length === fr.consecutive && tail.every(r => r.status === 'failed')) demote(cls, 'consecutive-failures', tail.map(r => r.assignmentId));

    // 3. stuck seats: a live one blocks its client; repeated idle stops demote the class
    const st = k.stuck;
    const stuck = mine.filter(r => r.status === 'running' && Number.isFinite(r.silentMinutes) && r.silentMinutes > st.silentFactor * policy.seat.idleMinutes);
    for (const r of stuck) push({ kind: 'block-client', target: r.client, rule: 'stuck-seat', evidence: [r.assignmentId] });
    const idleStops = mine.filter(r => r.idleStop === true && inWindow(at(r), st.idleStopWindowDays));
    if (idleStops.length >= st.idleStopsPerWindow) demote(cls, 'idle-stops', idleStops.map(r => r.assignmentId));
    if (stuck.length >= st.idleStopsPerWindow) demote(cls, 'stuck-seats', stuck.map(r => r.assignmentId));
  }

  // 4. limit burning: the failure classes that spend a route's allowance
  const b = k.burn;
  const burned = runs.filter(r => r.status === 'failed' && b.classes.includes(r.failureClass) && inWindow(at(r), b.windowHours / 24));
  const byRoute = new Map();
  for (const r of burned) byRoute.set(r.route, [...(byRoute.get(r.route) || []), r]);
  for (const [route, rows] of byRoute) {
    if (rows.length >= b.perRoute && !Object.hasOwn(standing.quarantined, route)) {
      push({ kind: 'quarantine', target: route, rule: 'limit-burn', until: new Date(now + b.quarantineHours * HOUR).toISOString(), evidence: rows.map(r => r.assignmentId).slice(0, 20) });
    }
  }
  for (const cls of classes(burned)) {
    const routes = new Set(burned.filter(r => r.taskClass === cls).map(r => r.route));
    if (routes.size >= b.distinctRoutes) demote(cls, 'limit-burn-routes', burned.filter(r => r.taskClass === cls).map(r => r.assignmentId));
  }
  return { effective: 'assign', reasons: [], actions };
}

// A synthetic record set used by preflight: the function must be present and must demote three consecutive failures.
function selfTest(policy, now = Date.parse('2026-01-01T00:00:00.000Z')) {
  const cls = 'implementer:B:T1';
  const runs = [1, 2, 3].map(i => ({ assignmentId: `selftest-${i}`, taskClass: cls, client: 'fixture', route: 'fixture:model', status: 'failed',
    failureClass: 'UNKNOWN', startedAt: new Date(now - i * 60000).toISOString(), closedAt: new Date(now - i * 60000 + 1000).toISOString() }));
  const out = killcheck({ runs }, policy, now);
  return out.actions.some(a => a.kind === 'demote' && a.target === cls && a.rule === 'consecutive-failures');
}

module.exports = { killcheck, latestPerId, selfTest };

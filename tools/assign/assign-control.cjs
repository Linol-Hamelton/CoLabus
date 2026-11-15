'use strict';
// Operator and owner commands of the assign mode.
//   init       --by NAME                                   create the empty state file (the enable act; nothing is overwritten)
//   hold       --all | --class C | --route R --by NAME --reason TEXT [--hours N]
//   release    --all | --class C | --route R --by NAME --reason TEXT      the only way back; never called by killcheck
//   list       [--runtime DIR]                             assigned seats that run now, with their age
//   preflight  [--class C ...] [--first-set] [--records FILE] [--route-state-dir DIR]   which locks hold, BEFORE a class is enabled
//   report     [--records FILE] [--runtime DIR]            what the owner reads after every landing (Russian)
// Common: --mode-file FILE (default: the host's assignment-mode.json), --now ISO. Nothing here edits the owner's mode file.
// Exit: 0 done; 2 usage or unreadable input; 3 refused (nothing to release, lock busy).
const fs = require('node:fs');
const path = require('node:path');
const slots = require('../../.ai/bin/lib/seat-slots.cjs');
const state = require('./assign-state.cjs');
const hostMode = require('./host-mode.cjs');
const { killcheck, selfTest } = require('./assign-killcheck.cjs');

const REPORT_FILE = path.join(__dirname, 'assign-report-ru.json');
const FIRST_SET = ['implementer', 'fixer'].flatMap(role => [1, 2, 3, 4].map(n => `${role}:B:T${n}`));
const fail = code => { throw Object.assign(new Error(code), { code }); };
const NOW = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/;
const SPEC = {
  init: { valued: ['--by'], flags: [] },
  hold: { valued: ['--class', '--route', '--by', '--reason', '--hours'], flags: ['--all'] },
  release: { valued: ['--class', '--route', '--by', '--reason'], flags: ['--all'] },
  list: { valued: ['--runtime'], flags: [] },
  preflight: { valued: ['--class', '--records', '--route-state-dir'], flags: ['--first-set'] },
  report: { valued: ['--records', '--runtime'], flags: [] },
};
function parse(argv, command) {
  const spec = SPEC[command];
  if (!spec) fail('CONTROL-USAGE');
  const common = { valued: ['--mode-file', '--now'], flags: [] };
  const opts = { repeat: {} };
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i];
    if ([...spec.flags, ...common.flags].includes(key)) { if (opts[key]) fail('CONTROL-USAGE'); opts[key] = true; continue; }
    if (![...spec.valued, ...common.valued].includes(key) || i + 1 >= argv.length || argv[i + 1].startsWith('--')) fail('CONTROL-USAGE');
    const value = argv[++i];
    if (key === '--class' && command === 'preflight') (opts.repeat[key] = opts.repeat[key] || []).push(value);
    else { if (Object.hasOwn(opts, key)) fail('CONTROL-USAGE'); opts[key] = value; }
  }
  return opts;
}

// ---- records: the evidence of advise pairs and assigned launches, in either shape (launch terminal record, or the operator's evidence rows)
function normalize(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  const frame = rec.taskFrame && typeof rec.taskFrame === 'object' ? rec.taskFrame : null;
  const role = frame ? frame.role : rec.role;
  const risk = frame ? frame.riskClass : rec.riskClass;
  const tier = frame ? frame.tier : /^T[1-9]$/.test(rec.tier) ? rec.tier : null;
  const advice = (rec.selectionShadow && rec.selectionShadow.advice) || rec.advice || null;
  const exit = Number.isInteger(rec.exitCode) ? rec.exitCode : Number.isInteger(rec.exit) ? rec.exit : null;
  return { class: role && risk && tier ? `${role}:${risk}:${tier}` : null, role: role || null, risk: risk || null, tier: tier || null,
    advice: advice && typeof advice === 'object' ? advice : null, assign: rec.assignLaunch || null, exit, at: rec.endedAt || rec.end || rec.startedAt || null };
}
function readRecords(file) {
  const text = fs.readFileSync(file, 'utf8');
  const parsed = text.trimStart().startsWith('[') ? JSON.parse(text) : text.split('\n').filter(l => l.trim()).map(l => JSON.parse(l));
  if (!Array.isArray(parsed) || parsed.length > 200000) fail('CONTROL-RECORDS');
  return parsed.map(normalize).filter(Boolean);
}
function readRuntimeTerminals(dir) {
  const rows = [];
  for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.terminal.json')).sort().slice(-5000)) {
    try { const st = fs.statSync(path.join(dir, name)); if (st.size > 2 * 1024 * 1024) continue; const n = normalize(JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))); if (n) rows.push(n); } catch { /* one bad file never hides the others */ }
  }
  return rows;
}
const sameRoute = (a, b) => a && b && a.client === b.client && a.model === b.model;
const NO_REASON = /^(none|unknown|no-reason|unspecified|not-given)$/;
function pairs(rows) {
  const by = new Map();
  for (const r of rows) {
    if (!r.class || !r.advice) continue;
    const row = by.get(r.class) || { pairs: 0, matched: 0, deviated: 0, noReason: 0 };
    row.pairs++;
    if (r.advice.recommended && r.advice.actual) {
      if (sameRoute(r.advice.recommended, r.advice.actual)) row.matched++;
      else { row.deviated++; if (typeof r.advice.deviationReason !== 'string' || NO_REASON.test(r.advice.deviationReason)) row.noReason++; }
    }
    by.set(r.class, row);
  }
  return by;
}
// The assigned launches (closed field launch-assign/1) as the rows killcheck takes; the operator's own advise outcomes as the reference.
function runsOf(rows) {
  return rows.filter(r => r.assign && r.assign.outcome && r.assign.route).map(r => ({ assignmentId: r.assign.assignmentId, taskClass: r.assign.taskClass,
    client: r.assign.route.client, route: `${r.assign.route.client}:${r.assign.route.model}`, status: r.assign.outcome.status, failureClass: r.assign.outcome.failureClass,
    startedAt: r.assign.decidedAt, closedAt: r.assign.outcome.closedAt, silentMinutes: null, idleStop: r.assign.outcome.failureClass === 'IDLE' }));
}
const baselineOf = rows => rows.filter(r => r.class && r.advice && !r.assign && r.exit !== null && r.at).map(r => ({ taskClass: r.class, outcome: r.exit === 0 ? 'done' : 'failed', at: r.at }));

// ---- route facts for preflight: the same reader the SessionStart summary uses; unreadable is a lock, never a pass
// The launch records the reader loads go to the state: a scarce route is known only from a real launch.
function routeFacts(root, nowIso, opts = {}) {
  try {
    const summary = require('../operator-knowledge/summary.cjs');
    const rs = require('../operator-knowledge/route-state.cjs');
    const loaded = summary.load(root, opts);
    if (!loaded.ok) return { readable: false, total: 0, ok: 0 };
    const result = rs.stateAt(loaded.record, nowIso, { launches: loaded.launches || [] });
    return { readable: true, total: result.routes.length, ok: result.routes.filter(r => r.state === 'ok').length };
  } catch { return { readable: false, total: 0, ok: 0 }; }
}

function preflight(options, deps) {
  const { files, now, nowIso } = options;
  const classes = [...new Set([...(options.classes || []), ...(options.firstSet ? FIRST_SET : [])])];
  if (!classes.length || classes.some(c => !state.CLASS.test(c))) fail('CONTROL-USAGE');
  const rows = options.rows || [];
  const locks = [];
  const out = [`ASSIGN-PREFLIGHT classes=${classes.length} records=${rows.length}`];
  const mode = hostMode.read(files.mode, now, { env: deps.env });
  const stateRead = files.state ? state.read(files.state, now) : { status: 'invalid' };
  out.push(`mode=${mode.mode} reason=${mode.reason} declared=${mode.assignClasses.length} state=${stateRead.status}`);
  if (stateRead.status !== 'ok') locks.push(stateRead.status === 'absent' ? 'state-absent' : 'state-invalid');
  const policy = state.readPolicy();
  if (!policy.ok) locks.push('policy-invalid');
  else if (!selfTest(policy.policy)) locks.push('killcheck-failed');
  const facts = (deps.routeFacts || routeFacts)(deps.root, nowIso, deps.launches === undefined ? {} : { launches: deps.launches });
  out.push(`routes readable=${facts.readable} ok=${facts.ok} total=${facts.total}`);
  if (!facts.readable) locks.push('route-state-unreadable');
  else if (facts.ok === 0) locks.push('route-state-missing', 'served-model-unproven');
  // the frame of every record against the first-class rules: roles, risk class A, the tier range, unknown factors
  const tally = new Map();
  const count = k => tally.set(k, (tally.get(k) || 0) + 1);
  let frameOk = 0;
  for (const r of rows) {
    if (!r.class) { count('frame-unreadable'); continue; }
    if (r.role === 'certifier') { count('role-excluded:certifier'); continue; }
    if (!['implementer', 'fixer'].includes(r.role)) { count(`role-not-in-first-set:${r.role}`); continue; }
    if (r.risk !== 'B') { count('risk-class-A'); continue; }
    if (!/^T[1-4]$/.test(r.tier)) { count(`tier-out-of-range:${r.tier}`); continue; }
    frameOk++;
    if (!r.advice) count('advice-missing');
    else if (typeof r.advice.reason === 'string') count(`advice-reason:${r.advice.reason}`);
  }
  for (const [k, n] of [...tally].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) out.push(`records ${k}=${n}`);
  const tierOut = [...tally.keys()].some(k => k.startsWith('tier-out-of-range:'));
  if (tierOut && frameOk === 0) locks.push('task-tier-all-above-T4');
  for (const c of classes) {
    const inClass = rows.filter(r => r.class === c).length;
    out.push(`class ${c} enabled=${mode.assignClasses.includes(c) ? 'yes' : 'no'} records=${inClass}`);
  }
  const unique = [...new Set(locks)];
  const eligible = unique.length ? 0 : frameOk;
  out.push(`ASSIGN-PREFLIGHT-RESULT frame-eligible=${frameOk} would-be-eligible-now=${eligible} locks=${unique.join(',') || 'none'}`);
  return { lines: out, locks: unique, frameOk, eligible };
}

const fill = (template, values) => template.replace(/\{(\w+)\}/g, (_, k) => (Object.hasOwn(values, k) ? String(values[k]) : `{${k}}`));
function report(options, deps) {
  const { files, now, nowIso } = options;
  const t = JSON.parse(fs.readFileSync(REPORT_FILE, 'utf8'));
  const rows = options.rows || [];
  const mode = hostMode.read(files.mode, now, { env: deps.env });
  const stateRead = files.state ? state.read(files.state, now) : { status: 'invalid', state: null };
  const st = stateRead.status === 'ok' ? stateRead.state : null;
  const policy = state.readPolicy();
  const out = [fill(t.title, { now: nowIso })];
  const left = Date.parse(mode.expiresAt) - now;
  out.push(fill(t.mode, { mode: mode.mode, classes: mode.assignClasses.length, expires: mode.expiresAt || 'нет' }));
  out.push(fill(t.state, { state: stateRead.status, hold: st && st.hold ? 'да' : 'нет', demoted: st ? Object.keys(st.demoted).length : 0,
    quarantined: st ? Object.values(st.quarantinedRoutes).filter(q => Date.parse(q.until) > now).length : 0 }));
  if (mode.mode === 'off' && mode.expiresAt === null && mode.reason === 'mode-missing-or-invalid') out.push(t.expired);
  else if (policy.ok && Number.isFinite(left) && left > 0 && left <= policy.policy.expiry.warnHours * 3600000) out.push(fill(t.expiryWarn, { hours: Math.floor(left / 3600000) }));
  if (mode.mode === 'assign' && mode.assignClasses.length && stateRead.status === 'absent') out.push(t.lockMissing);
  out.push(t.classHeader);
  const p = pairs(rows);
  if (!p.size) out.push(t.noPairs);
  for (const [c, v] of [...p].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) out.push(fill(t.classRow, { class: c, ...v }));
  out.push(t.assignedHeader);
  const runs = runsOf(rows);
  const byClass = new Map();
  for (const r of runs) byClass.set(r.taskClass, [...(byClass.get(r.taskClass) || []), r]);
  if (!byClass.size) out.push(t.noAssigned);
  for (const [c, rs] of [...byClass].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const n = s => rs.filter(r => r.status === s).length;
    out.push(fill(t.assignedRow, { class: c, assigned: rs.length, done: n('done'), failed: n('failed'), notStarted: n('not-started'), running: n('running') }));
  }
  const base = baselineOf(rows);
  out.push(fill(t.baseline, { pairs: base.length, failed: base.filter(b => b.outcome === 'failed').length }));
  out.push(t.criteriaHeader);
  if (!policy.ok) out.push(fill(t.integrity, { reasons: 'policy-unreadable' }));
  else {
    const verdict = killcheck({ runs, baseline: base, state: st || {}, integrity: { stateReadable: stateRead.status !== 'invalid', policyReadable: true } },
      policy.policy, now);
    if (verdict.effective === 'advise') out.push(fill(t.integrity, { reasons: verdict.reasons.join(', ') }));
    if (!verdict.actions.length) out.push(t.noCriteria);
    for (const a of verdict.actions) out.push(fill(t.criteriaRow, { kind: a.kind, target: a.target, rule: a.rule, evidence: (a.evidence || []).join(', ') || 'нет' }));
  }
  return out;
}

function list(options) {
  const dir = options.runtime;
  const out = [];
  for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.running.json')).sort()) {
    try {
      // A seat runs now by the one liveness rule of every seat consumer (seat-slots): an ended marker, a terminal record of the attempt and a marker with no live PID are not running.
      const seat = slots.seatState(dir, name.slice(0, -'.running.json'.length), { now: options.now, ...(options.seat || {}) });
      const m = seat.live ? seat.marker : null;
      if (!m || !m.assignLaunch || !m.assignLaunch.route) continue;
      const started = Date.parse(m.startedAt);
      out.push(`ASSIGN-SEAT name=${name.slice(0, -'.running.json'.length)} class=${m.assignLaunch.taskClass} route=${m.assignLaunch.route.client}:${m.assignLaunch.route.model} ageMinutes=${Number.isFinite(started) ? Math.floor((options.now - started) / 60000) : 'unknown'}`);
    } catch { /* an unreadable marker is not an assigned seat */ }
  }
  return [`ASSIGN-LIST running=${out.length}`, ...out];
}

function main(argv, deps = {}) {
  const out = deps.out || (s => process.stdout.write(`${s}\n`));
  const err = deps.err || (s => process.stderr.write(`${s}\n`));
  try {
    const args = [...argv];
    const command = args.shift();
    const opts = parse(args, command);
    const nowRaw = opts['--now'] || (deps.now ? new Date(deps.now()).toISOString() : new Date().toISOString());
    if (!NOW.test(nowRaw) || !Number.isFinite(Date.parse(nowRaw))) fail('CONTROL-USAGE');
    const now = Date.parse(nowRaw);
    const env = deps.env || process.env;
    const files = state.locate({ modeFile: opts['--mode-file'], env });
    if (!files.mode || !files.state) fail('CONTROL-MODE-FILE');
    const policyDoc = state.readPolicy();
    const by = opts['--by'];
    const scope = (() => {
      const picked = [opts['--all'] ? ['all', null] : null, opts['--class'] ? ['class', opts['--class']] : null, opts['--route'] ? ['route', opts['--route']] : null].filter(Boolean);
      if (picked.length !== 1) fail('CONTROL-USAGE');
      return picked[0];
    });
    if (command === 'init') {
      if (!by) fail('CONTROL-USAGE');
      const done = state.update(files, s => s, { now });
      out(`ASSIGN-INIT state=${done.created ? 'created' : 'exists'} by=${by}`);
    } else if (command === 'hold') {
      if (!by || !opts['--reason'] || !policyDoc.ok) fail(policyDoc.ok ? 'CONTROL-USAGE' : 'CONTROL-POLICY');
      const [kind, target] = scope();
      const hours = opts['--hours'] === undefined ? policyDoc.policy.hold.routeHours : Number(opts['--hours']);
      if (kind === 'route' && !(Number.isFinite(hours) && hours > 0 && hours <= policyDoc.policy.hold.maxRouteHours)) fail('CONTROL-USAGE');
      if (kind !== 'route' && opts['--hours'] !== undefined) fail('CONTROL-USAGE');
      state.update(files, s => state.applyHold(s, { scope: kind, target, at: now, by, reason: opts['--reason'], until: now + hours * 3600000 }), { now });
      out(`ASSIGN-HOLD scope=${kind}${target ? ` target=${target}` : ''} by=${by}; takes effect on the next launch and on the last check before a spawn`);
    } else if (command === 'release') {
      if (!by || !opts['--reason']) fail('CONTROL-USAGE');
      const [kind, target] = scope();
      state.update(files, s => state.applyRelease(s, { scope: kind, target, at: now, by, reason: opts['--reason'] }), { now });
      out(`ASSIGN-RELEASE scope=${kind}${target ? ` target=${target}` : ''} by=${by}`);
    } else if (command === 'list') {
      const dir = opts['--runtime'] ? path.resolve(opts['--runtime']) : path.dirname(files.mode);
      for (const l of list({ runtime: dir, now, seat: deps.seat })) out(l);
    } else if (command === 'preflight') {
      const rows = opts['--records'] ? readRecords(opts['--records']) : [];
      const root = path.resolve(__dirname, '../..');
      const result = preflight({ files, now, nowIso: nowRaw, classes: opts.repeat['--class'], firstSet: opts['--first-set'], rows }, { env, root, routeFacts: deps.routeFacts });
      for (const l of result.lines) out(l);
    } else if (command === 'report') {
      const rows = [...(opts['--records'] ? readRecords(opts['--records']) : []), ...(opts['--runtime'] ? readRuntimeTerminals(path.resolve(opts['--runtime'])) : [])];
      for (const l of report({ files, now, nowIso: nowRaw, rows }, { env })) out(l);
    }
    return 0;
  } catch (e) {
    const code = /^(CONTROL|state-|lock-|hold-|release-|policy-)/.test(e.code || '') ? e.code : 'CONTROL-IO';
    err(`ASSIGN-CONTROL ${code}`);
    return /^(release-nothing|lock-busy)$/.test(code) ? 3 : 2;
  }
}

module.exports = { main, normalize, readRecords, pairs, runsOf, baselineOf, preflight, report, list, FIRST_SET };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

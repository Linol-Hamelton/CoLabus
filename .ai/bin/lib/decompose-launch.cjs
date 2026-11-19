'use strict';
// decompose-launch.cjs - the launch of the children of a decomposition record through the seams of the kernel: the task
// classifier on its two axes, the ranked advice of the selection layer, the route rule of the decomposition layer, the
// kernel launch entry and the terminal record of a seat. Rule ids TD-nn are those of the task decomposition specification.
//
// seatProblem(record, child, facts)            -> why the child has no seat of its own, or null (TD-84)
// launchTask(record, childId, facts)           -> { ok, text, path, seat, marker } | { ok: false, refusals } (TD-84)
// ladderTier(ladder, route)                    -> the tier the model ladder gives the route, or null (TD-86)
// routeRule(child, workClass, tier, floors)    -> { admitted, code, required, strongOnly, detail } (TD-86)
// planChild(record, childId, facts, seams)     -> one plan row; nothing starts and nothing is written (TD-88)
// startPlan(record, opts, facts, seams)        -> { starts, refusals }: who may start now, and why the others may not (TD-89)
// seatEnd(seat, terminal)                      -> how the seat of a running child stands: running, marker or lost (TD-87)
//
// Advise mode: the operator readies each child (the ready event) and names the route of each launch; the advice is shown
// beside the route, never put in its place. The seams of the line (classifier, rubric, advice, ladder, worktree check)
// come in `seams`; nothing here reads a file, the clock or the environment, and nothing here starts a process.
const decompose = require('./decompose.cjs');
const authorReport = require('./author-report.cjs');
const seatMarker = require('./seat-marker.cjs');
const taskLint = require('./task-lint.cjs');

// The closed list of launch refusals, in the order a report lists them (TD-89).
const CODES = Object.freeze(['STATE', 'RUNNING_LIMIT', 'NO_ROUTE', 'ROUTE_WEAK', 'ROUTE_UNKNOWN', 'ROUTE_FAMILY', 'SEAT_NAME',
  'REPORT_SCOPE', 'NO_WORKTREE', 'LAUNCH_REFUSED']);
// A child starts from these states: readied by the operator, or rejected and readied again by its budget (TD-70).
const STARTABLE = new Set(['ready', 'rejected']);
const { SEAT, ROUTE } = decompose.GRAMMAR;
const fold = p => p.toLowerCase();
const unknown = reason => ({ value: null, reason });
const tierNumber = t => (typeof t === 'string' && /^T[1-9]$/.test(t) ? Number(t.slice(1)) : null);
// A control character, the next line character and the line and paragraph separators end a line of output.
const breaksLine = ch => { const c = ch.codePointAt(0); return c < 0x20 || c === 0x7f || c === 0x85 || c === 0x2028 || c === 0x2029; };

// The seat of a child is its launch name and its stream: one safe name that passes the stream grammar of the author
// report and no child of another record of the base already holds (TD-84).
function seatProblem(record, child, facts) {
  const seat = decompose.seatOf(record.parent.id, child.id);
  if (!SEAT.test(seat)) return `${seat} is not a seat name (letters, digits and dashes, at most 64)`;
  try { authorReport.packageName(seat); } catch { return `${seat} is not a stream name (single dashes between letters and digits)`; }
  for (const other of facts.records || []) {
    if (other.unreadable || fold(other.parentId) === fold(record.parent.id)) continue;
    const hit = (other.childIds || []).find(id => decompose.seatOf(other.parentId, id) === seat);
    if (hit) return `${seat} is also the seat of ${hit} of ${other.parentId} (${other.path})`;
  }
  return null;
}

// The task file a seat of the child receives: the task file of the child (its prohibitions, write set and acceptance)
// with a launch section and the end marker of its seat. The launch entry derives the marker from the seat name and lints
// the footer against it; the record marker of the child stays the marker of its result (TD-21, TD-64, TD-84).
function launchTask(record, childId, facts) {
  const out = decompose.render(record, childId, facts);
  if (!out.ok) return out;
  const child = record.children.find(c => c.id === childId);
  const seat = decompose.seatOf(record.parent.id, child.id);
  const marker = `${seatMarker.markerOf(seat)}_DONE`;
  const cut = out.task.lastIndexOf('\n## End\n');
  if (cut < 0) throw new Error('decompose launch: the child task has no end section');
  // The launch intake reads the six factors from lines "name: score" and the planned scope from lines that change a
  // path; the task lint of the launch entry admits no other fence than a command fence, so no intake block is used.
  const text = [
    out.task.slice(0, cut),
    '',
    '## Launch of this child',
    '',
    `- Seat and stream: ${seat}. Author report of the seat: ${authorReport.reportPath(seat)} (a path of the write set).`,
    '- The derived files (the manifest, the consumer index and the other derived files) are written only by the integrator; a commit of this child never holds them.',
    '- The selection facts of this child for the launch intake, the six factors of the record and the write set:',
    ...Object.keys(child.complexity).map(k => `- ${k}: ${child.complexity[k]}`),
    ...child.writeSet.map(p => `- Change ${p}`),
    '',
    '## End',
    '',
    'When the work is committed, end your final message with the line below. It means submitted, not accepted.',
    '',
    marker,
    `Task-End: ${marker}`,
    '',
  ].join('\n');
  const shaped = decompose.endLineProblem(text.split('\n').slice(0, -3));
  if (shaped) return { ok: false, refusals: [{ code: 'SCHEMA', where: 'task', detail: shaped }] };
  const lint = taskLint.lintTask(text, { profile: taskLint.TASK_PROFILE, completion: marker });
  if (!lint.ok) throw new Error(`decompose launch: the launch task fails task lint (${lint.problems.map(x => x.code).join(', ')})`);
  return { ok: true, text, path: `${decompose.DECOMPOSITIONS_DIR}${record.parent.id}/${child.id}.launch.md`, seat, marker };
}

// A route client:model[:effort], or null.
function parseRoute(text) {
  if (typeof text !== 'string' || !ROUTE.test(text)) return null;
  const [client, ...rest] = text.split(':');
  const effort = rest.length > 1 && /^[a-z0-9-]{1,16}$/.test(rest[rest.length - 1]) ? rest.pop() : null;
  return { client, model: rest.join(':'), effort };
}
const routeText = r => `${r.client}:${r.model}${r.effort ? `:${r.effort}` : ''}`;

// An explicit effort matches exactly, as in the selection layer's route constraints; an unspecified effort is no
// stronger than the weakest row of the model. A route the ladder does not hold has no tier, never the top tier.
function ladderTier(ladder, route) {
  const rows = (ladder && Array.isArray(ladder.rows) ? ladder.rows : [])
    .filter(r => r && r.client === route.client && r.routeModel === route.model && Number.isInteger(r.tier));
  const fit = route.effort ? rows.filter(r => r.effort === route.effort) : rows;
  if (!fit.length) return null;
  const tiers = fit.map(r => r.tier);
  return route.effort ? Math.max(...tiers) : Math.min(...tiers);
}

// The route rule of the decomposition layer: a child on kernel or protected files is never given to a weak author. The
// required tier is the tier the record asks of the author or the floor of the class, whichever is higher; a route below
// it is weak; a route without a ladder tier is not shown to be strong, so a kernel or protected child refuses it (TD-86).
function routeRule(child, workClass, tier, floors) {
  const strongOnly = workClass === 'kernel' || workClass === 'protected';
  const floor = workClass === 'kernel' ? floors.kernel : workClass === 'protected' ? floors.protected : 0;
  const required = Math.max(tierNumber(child.author.minTier) || 0, floor);
  if (tier === null) {
    return strongOnly
      ? { admitted: false, code: 'ROUTE_UNKNOWN', required, strongOnly, detail: `the model ladder has no tier for the route; a ${workClass} child takes only a route of tier T${required} or more` }
      : { admitted: true, code: null, required, strongOnly, detail: `the model ladder has no tier for the route; the child asks T${required}` };
  }
  if (tier < required) return { admitted: false, code: 'ROUTE_WEAK', required, strongOnly, detail: `the route has tier T${tier} on the model ladder; the ${workClass} child asks T${required}` };
  return { admitted: true, code: null, required, strongOnly, detail: `T${tier} of T${required}` };
}

// Why the route does not author for the family the record names, or null: the kernel family fold of the model of the
// route is the author family of the child, which is known (TD-26, TD-82).
function familyProblem(record, child, route) {
  const familyOf = decompose.familyTable(record);
  const routeFamily = familyOf(route.model);
  if (decompose.isUnknown(child.author.family)) return `the record names no author family of ${child.id} (${child.author.family.reason}); name the family of the route first`;
  const planned = familyOf(child.author.family);
  if (!routeFamily) return `the kernel family fold does not know the model ${route.model}`;
  if (routeFamily !== planned) return `the model ${route.model} is of the family ${routeFamily}; the record names ${planned} as the author of ${child.id}`;
  return null;
}

// The change rows the classifier reads for the write set of a child: added when the path is not in the base tree.
function writeSetChanges(child, facts) {
  return child.writeSet.map(p => {
    const kind = facts.files[p];
    if (kind === undefined) return { status: 'A', oldMode: '000000', newMode: '100644', paths: [p] };
    const mode = kind === 'exec' ? '100755' : '100644';
    return { status: 'M', oldMode: mode, newMode: mode, paths: [p] };
  });
}

// The two axes of a child (PROTO-DEC-0288 item 2): complexity picks the author, criticality picks the checks. Each axis
// comes from its seam of the line; a seam that is missing or refuses gives that axis as unknown with its reason (TD-88).
function axesOf(record, child, facts, seams) {
  const workClass = decompose.workClassOf(child, facts);
  let complexity;
  try {
    const tier = seams.rubricTier(child.complexity, { kernel: workClass === 'kernel' });
    // A seam that answers without a tier T1..T9 gave no tier: the axis is unknown, never an axis without a tier.
    complexity = tierNumber(tier) === null ? unknown('the rubric of the line gave no tier (it answered nothing that is a tier)')
      : { tier, factors: { ...child.complexity }, workClass };
  } catch (e) { complexity = unknown(`the rubric of the line gave no tier (${seams.reason(e)})`); }
  let criticality;
  try {
    const c = seams.classify({
      role: 'author', packageId: record.parent.package, changes: [], lines: null,
      spec: { schema: 'task-spec/1', openQuestions: 0, writeSet: writeSetChanges(child, facts) },
      history: { failedRounds: child.counters.rounds, verdicts: [], defectClasses: [], unknowns: 0 },
    });
    // As for the rubric: a seam that answers without the three fields of a class gave no class, never an axis with holes.
    if (!c || [c.riskClass, c.verification, c.kind].some(v => typeof v !== 'string' || !v)) throw new RangeError('it answered no class (riskClass, verification and kind are not all text)');
    criticality = { riskClass: c.riskClass, verification: c.verification, kind: c.kind, certificationTier: record.parent.certificationTier };
  } catch (e) { criticality = unknown(`the task classifier of the line gave no class (${seams.reason(e)})`); }
  return { workClass, complexity, criticality };
}

// One row of the plan of a child: its seat, both axes, the route rule, the three advised routes with their reasons and
// the rule applied to each, what keeps it from starting now and what is unknown. Nothing starts (TD-88).
function planChild(record, childId, facts, seams) {
  const child = record.children.find(c => c.id === childId);
  if (!child) throw new RangeError(`decompose launch: no child ${childId}`);
  const seat = decompose.seatOf(record.parent.id, child.id);
  const axes = axesOf(record, child, facts, seams);
  const unknowns = [];
  if (decompose.isUnknown(axes.complexity)) unknowns.push(`complexity: ${axes.complexity.reason}`);
  if (decompose.isUnknown(axes.criticality)) unknowns.push(`criticality: ${axes.criticality.reason}`);
  const blocked = [];
  if (!STARTABLE.has(child.state)) blocked.push({ code: 'STATE', detail: `${child.state}; a child starts when the operator has readied it` });
  const seatWhy = seatProblem(record, child, facts);
  if (seatWhy) blocked.push({ code: 'SEAT_NAME', detail: seatWhy });
  const report = seatWhy ? null : authorReport.reportPath(seat);
  if (report && !child.writeSet.some(w => fold(w) === fold(report))) blocked.push({ code: 'REPORT_SCOPE', detail: `the author report ${report} of the seat is not in the write set` });
  const rule = routeRule(child, axes.workClass, null, facts.policy.floors);
  let advised = [];
  try {
    const task = seatWhy ? null : launchTask(record, childId, facts);
    const advice = seatWhy ? unknown('the child has no seat, so no advice was asked')
      : task.ok ? seams.advise(task.text, record.parent.base) : unknown('the child task cannot be rendered');
    if (decompose.isUnknown(advice)) unknowns.push(`advice: ${advice.reason}`);
    else {
      if (!advice || !Array.isArray(advice.ranked) || (advice.unknown !== undefined && !Array.isArray(advice.unknown))) throw new Error('malformed-advice');
      advised = advice.ranked.slice(0, 3).map(r => {
        if (!r || !Number.isInteger(r.rank) || typeof r.client !== 'string' || typeof r.model !== 'string'
          || !Array.isArray(r.reasons) || !r.reasons.every(x => typeof x === 'string')) throw new Error('malformed-advice');
        const route = { client: r.client, model: r.model, effort: r.effort || null };
        const tier = ladderTier(seams.ladder, route);
        const applied = routeRule(child, axes.workClass, tier, facts.policy.floors);
        const family = familyProblem(record, child, route);
        return { rank: r.rank, route: routeText(route), tier: tier === null ? null : `T${tier}`, admitted: applied.admitted && !family,
          code: applied.code || (family ? 'ROUTE_FAMILY' : null), reasons: [...r.reasons] };
      });
      if (advised.length < 3) unknowns.push(`advice: ${advised.length} of 3 routes (${advice.reason || 'fewer eligible routes'})`);
      for (const u of advice.unknown || []) unknowns.push(`advice: ${u}`);
    }
  } catch (e) {
    advised = [];
    unknowns.push(`advice: the selection layer gave no advice (${seams.reason(e)})`);
  }
  return {
    child: child.id, state: child.state, seat, workClass: axes.workClass,
    complexity: axes.complexity, criticality: axes.criticality,
    rule: { strongOnly: rule.strongOnly, requiredTier: `T${rule.required}` },
    advice: advised, blocked, unknown: unknowns,
  };
}

// Who may start now. opts: { children (ids, or null for every startable child), routes: { child: route text },
// worktreeRoot }. A child the operator named that cannot start gets a refusal by name; a startable child beyond the
// running limit is RUNNING_LIMIT and stays as it is; a refused child never takes a running slot (TD-89).
function startPlan(record, opts, facts, seams) {
  const running = record.children.filter(c => c.state === 'running').length;
  const free = Math.max(0, decompose.MAX_RUNNING - running);
  const named = opts.children;
  const chosen = named ? record.children.filter(c => named.includes(c.id)) : record.children.filter(c => STARTABLE.has(c.state));
  const starts = []; const refusals = [];
  for (const child of chosen) {
    const refuse = (code, detail) => refusals.push({ child: child.id, code, detail });
    const before = refusals.length;
    if (!STARTABLE.has(child.state)) refuse('STATE', `${child.id} is ${child.state}; a child starts when the operator has readied it`);
    const seat = decompose.seatOf(record.parent.id, child.id);
    const seatWhy = seatProblem(record, child, facts);
    if (seatWhy) refuse('SEAT_NAME', seatWhy);
    else {
      const report = authorReport.reportPath(seat);
      if (!child.writeSet.some(w => fold(w) === fold(report))) refuse('REPORT_SCOPE', `the author report ${report} of the seat is not in the write set of ${child.id}`);
    }
    const text = Object.hasOwn(opts.routes || {}, child.id) ? opts.routes[child.id] : undefined;
    const route = parseRoute(text);
    if (!route) refuse('NO_ROUTE', text === undefined ? `the operator named no route for ${child.id}` : `${text} is not a route client:model[:effort]`);
    else {
      const rule = routeRule(child, decompose.workClassOf(child, facts), ladderTier(seams.ladder, route), facts.policy.floors);
      if (!rule.admitted) refuse(rule.code, `${routeText(route)}: ${rule.detail}`);
      // The reviewer and the certifiers were planned against the author family the record names: the model of the route
      // folds to that family, and a running child has a known one (TD-26, TD-82).
      const why = familyProblem(record, child, route);
      if (why) refuse('ROUTE_FAMILY', why);
    }
    const worktree = opts.worktreeRoot ? seams.join(opts.worktreeRoot, seat) : null;
    if (!worktree || !seams.isWorktree(worktree)) refuse('NO_WORKTREE', `no worktree ${seat} under the worktree root`);
    if (refusals.length > before) continue;
    if (starts.length >= free) { refuse('RUNNING_LIMIT', `${running + starts.length} children run; at most ${decompose.MAX_RUNNING} at once`); continue; }
    starts.push({ child: child.id, seat, route: routeText(route), routeParts: route, worktree });
  }
  return { starts, refusals };
}

// How the seat of a running child stands, from the terminal record its launch wrapper writes when the seat ends: no
// record yet is running; DONE with the completion marker of the seat (markerOf of its name, without the _DONE of the task
// footer) is marker (the operator submits the result); any other end is lost: the attempt ended without the marker of
// the child (TD-87).
function seatEnd(seat, terminal) {
  if (terminal === undefined) return { state: 'running' };
  if (terminal === false) return { state: 'unknown', detail: 'the terminal record of the seat cannot be read' };
  if (!terminal || typeof terminal !== 'object' || Array.isArray(terminal)
    || typeof terminal.status !== 'string' || !terminal.status.trim()) return { state: 'unknown', detail: 'the terminal record of the seat is malformed' };
  const marker = seatMarker.markerOf(seat);
  if (terminal.status === 'DONE' && terminal.completionMarker === marker) return { state: 'marker' };
  // The detail is one line of the status output: a status with a line break or a control character is named, never copied.
  if ([...terminal.status].some(breaksLine)) return { state: 'lost', detail: `the seat ended with a status that holds a line break or a control character, not the marker ${marker}` };
  return { state: 'lost', detail: `the seat ended ${terminal.status} without the marker ${marker}` };
}

module.exports = { CODES, STARTABLE, seatProblem, launchTask, parseRoute, routeText, ladderTier, routeRule, familyProblem, axesOf, planChild, startPlan, seatEnd };

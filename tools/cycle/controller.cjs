'use strict';
// Hint mode is the default. Active capabilities live behind explicit flags.
const path = require('node:path');
const reader = require('./reader.cjs');
const state = require('./state.cjs');
const inputs = require('./inputs.cjs');
const ledger = require('./ledger.cjs');
const REPO = path.resolve(__dirname, '../..');
const TEMPLATE = 'docs/ops/cycle/SEAT-STEP-TEMPLATE.md';
const clientKey = (client, caps) => Object.hasOwn(caps.clientAliases, client) ? caps.clientAliases[client] : client;
function capacity(seats, caps) {
  const counts = new Map();
  for (const seat of seats) { const key = clientKey(seat.client, caps); counts.set(key, (counts.get(key) || 0) + 1); }
  return { counts, total:seats.length, unknown:seats.some(s => !s.client || s.client === 'unknown-client') };
}
function reserve(client, budget, caps) {
  const key = clientKey(client, caps);
  const limit = Object.hasOwn(caps.clients, key) ? caps.clients[key] : caps.clients.default;
  if (budget.unknown || budget.total >= caps.total || (budget.counts.get(key) || 0) >= limit) return false;
  budget.total++; budget.counts.set(key, (budget.counts.get(key) || 0) + 1);
  return true;
}
function notices(seats, recs, caps, now) {
  const result = [];
  for (const seat of seats) {
    if (!seat.role || seat.role==='unknown-role' || seat.role==='unknown') continue;
    const sample = recs.filter(r => r.ended && r.exitCode === 0 && r.role === seat.role);
    for (const [metric, value, samples] of [
      ['wallSeconds', (now - seat.startedMs) / 1000, sample.map(r => r.wallSeconds).filter(v => v !== null)],
      ['tokens', seat.tokens, sample.map(r => r.tokens.total).filter(v => v !== null)]
    ]) {
      const p90 = ledger.percentile(samples, 0.9);
      if (value === null || p90 === null) continue;
      const level = value > p90 * caps.runawayFactor ? 'RUNAWAY' : value > p90 * caps.softFactor ? 'SOFT' : null;
      if (level) result.push({ level, seat:seat.name, role:seat.role, metric, value, p90, n:samples.length, action:'notice-only', safePointWaitSeconds:caps.safePointWaitSeconds });
    }
  }
  return result;
}
function plan({ candidates, tips, seats, history, caps, previous, now, selections }) {
  const budget = capacity(seats, caps), wouldLaunch = [], packages = [];
  for (const row of candidates) {
    const item = { ...row, nextStep:null, reason:null, template:TEMPLATE };
    packages.push(item);
    if (tips[row.branch]?.state==='missing') { item.nextStep='closed'; item.reason='no-live-branch'; continue; }
    if (typeof tips[row.branch]!=='string' || !/^[a-f0-9]{40}$/.test(tips[row.branch])) { item.nextStep='blocked'; item.reason='branch-tip-unavailable'; continue; }
    if (tips[row.branch] !== row.sha) { item.nextStep='blocked'; item.reason='stale-registry-sha'; continue; }
    if (row.status === 'building') { item.nextStep='return-to-author'; item.reason='registry-building'; continue; }
    if (seats.some(s => s.stream === row.stream)) { item.nextStep='wait-for-seat'; item.reason='package-running'; continue; }
    if (row.status === 'certified') { item.nextStep='ready-for-train'; item.reason='registry-certified-only'; continue; }
    item.nextStep='certify-registry-sha';
    const selection = selections.find(s => s.stream === row.stream && s.sha === row.sha);
    if (!selection || selection.seats.length === 0) { item.reason='selection-required'; continue; }
    // Reserve the whole independent seat group or none; a partial pair is never proposed.
    const trial = { counts:new Map(budget.counts), total:budget.total, unknown:budget.unknown };
    if (!selection.seats.every(s => reserve(s.client, trial, caps))) { item.nextStep='wait-for-seat'; item.reason='capacity'; continue; }
    budget.counts=trial.counts; budget.total=trial.total;
    for (const seat of selection.seats) wouldLaunch.push({ stream:row.stream, sha:row.sha, ...seat });
    item.reason='hint-only';
  }
  const activity = [previous.lastSeatAt ? Date.parse(previous.lastSeatAt) : null, ...(history.activity || [history.lastActivity]), ...(seats.length ? [now] : [])].filter(v => v !== null && v <= now);
  const lastSeat = activity.length ? Math.max(...activity) : null;
  const since = lastSeat === null ? Date.parse(previous.firstObservedAt) : lastSeat;
  const pending = packages.filter(p => p.nextStep !== 'blocked' && p.nextStep !== 'closed');
  const idle = seats.length === 0 && pending.length > 0 && now - since >= caps.idleSeconds * 1000
    ? pending.map(p => ({ level:'IDLE', stream:p.stream, nextStep:p.nextStep, seconds:Math.floor((now-since)/1000) })) : [];
  return { schema:'cycle-plan/1', mode:'hint', generatedAt:new Date(now).toISOString(), template:TEMPLATE,
    packages, running:seats.length, wouldLaunch, notices:notices(seats, history.recs, caps, now), idle,
    ledger:{ valid:history.recs.length, invalid:history.invalid }, lastSeatAt:lastSeat === null ? null : new Date(lastSeat).toISOString(),
    stage3:['launch-refusal-check-45s','safe-point-stop-with-saved-diff','closed-list-answers'] };
}
function selectionData(file) {
  if (!file) return [];
  const packages = reader.data(file, 'selection').packages;
  const streams = new Set();
  for (const p of packages) {
    if (streams.has(p.stream)) reader.refuse('selection-duplicate-stream');
    streams.add(p.stream);
    const seats = new Set();
    for (const s of p.seats) {
      const key = `${s.client}:${s.model}:${s.role}`;
      if (seats.has(key)) reader.refuse('selection-duplicate-seat');
      seats.add(key);
    }
  }
  return packages;
}
function options(argv) {
  const args = [...argv];
  if (args[0] === 'plan') args.shift(); else if (args[0] && !args[0].startsWith('--')) reader.refuse('usage');
  const out = {}, seen = new Set();
  for (let i=0; i<args.length; i++) {
    const key = args[i];
    if (!['--json','--launch','--allow-stop','--questions','--repo','--registry','--seats','--journal','--caps','--selection','--now'].includes(key) || seen.has(key)) reader.refuse('usage');
    seen.add(key);
    if (key === '--json') out.json=true;
    else if (key === '--launch') out.launch=true;
    else if (key === '--allow-stop') out.allowStop=true;
    else { if (!args[i+1] || args[i+1].startsWith('--')) reader.refuse('usage'); out[key.slice(2)]=args[++i]; }
  }
  return out;
}
function main(argv, deps = {}) {
  const say = deps.say || console.log, error = deps.error || console.error;
  if (argv.includes('--help') || argv.includes('-h')) { say('usage: controller.cjs [plan] [--json] [--launch] [--allow-stop] [--questions FILE] [--repo DIR] [--registry FILE] [--seats DIR] [--journal FILE] [--caps FILE] [--selection FILE] [--now ISO]'); return 0; }
  try {
    const o = options(argv), repoRoot = path.resolve(deps.repoRoot || REPO);
    const nowText = o.now || new Date().toISOString();
    if (!/^\d{4}-\d\d-\d\dT/.test(nowText) || ledger.isoProblem(nowText)) reader.refuse('usage');
    const now = Date.parse(nowText), iso = new Date(now).toISOString();
    const previous = state.snapshot(repoRoot, iso);
    const caps = reader.caps(o.caps || path.join(repoRoot, 'docs/ops/cycle/caps.json'));
    const candidates = inputs.candidates(o.registry || path.join(repoRoot, '.ai/runtime/CANDIDATES.md'));
    const history = inputs.history(o.journal || path.join(repoRoot, ...require('../../.ai/bin/repo-paths.cjs').CATALOG_LAUNCHES, 'LAUNCHES.jsonl'));
    const running = inputs.running(o.seats || path.join(repoRoot, '.ai/runtime'), history, now, deps.probe);
    const tips = Object.create(null);
    for (const row of candidates) tips[row.branch] = (deps.branchTip || inputs.branchTip)(o.repo || repoRoot, row.branch);
    const result = plan({ candidates, tips, seats:running.seats, history, caps, previous:previous.value, now, selections:selectionData(o.selection) });
    result.inactive = running.inactive;
    result.seats = running.seats;
    if(o.questions)result.answers=require('./answers.cjs').questions(o.questions,path.join(repoRoot,'docs/ops/cycle/answers.json'),running.seats);
    const next = { ...previous.value, revision:previous.value.revision + 1, lastObservedAt:iso, lastSeatAt:result.lastSeatAt };
    const emit = () => {
    if (o.json) say(JSON.stringify(result, null, 2));
    else {
      say(`${result.mode.toUpperCase()} template=${TEMPLATE} running=${result.running} wouldLaunch=${result.wouldLaunch.length} valid=${history.recs.length} invalid=${history.invalid}`);
      for (const p of result.packages) say(`PACKAGE ${p.stream} sha=${p.sha} next=${p.nextStep} reason=${p.reason}`);
      for (const s of result.seats) say(`SEAT ${s.name} stream=${s.stream} client=${s.client} role=${s.role} tokens=${s.tokens}`);
      for (const s of result.wouldLaunch) say(`WOULD ${s.stream} sha=${s.sha} client=${s.client} model=${s.model} role=${s.role}`);
      for (const n of result.notices) say(`${n.level} seat=${n.seat} metric=${n.metric} value=${n.value} p90=${n.p90} n=${n.n} action=notice-only`);
      for (const n of result.idle) say(`IDLE ${n.stream} next=${n.nextStep} seconds=${n.seconds}`);
      for (const l of result.launches || []) say(`LAUNCH-CHECK ${l.name} status=${l.status} afterMs=${l.checkedAfterMs} exitCode=${l.exitCode} endState=${l.endState} reason=${l.reason}`);
      for (const s of result.stops || []) say(`STOP ${s.seat} action=${s.action} reason=${s.reason}`);
      for (const a of result.answers || []) say(a.action==='answer' ? `ANSWER seat=${a.seat} class=${a.promptClass} answer=${a.answer}` : a.line);
    }
    return 0;
    };
    if (o.launch || o.allowStop) {
      if (o.now) reader.refuse('launch-clock-override');
      const ctx = {repoRoot,repo:o.repo || repoRoot,registry:o.registry || path.join(repoRoot,'.ai/runtime/CANDIDATES.md'),
        seatsDir:o.seats || path.join(repoRoot,'.ai/runtime'),capsFile:o.caps || path.join(repoRoot,'docs/ops/cycle/caps.json'),history,previous,next,quiet:o.json,launch:Boolean(o.launch)};
      const active = async () => {
        await require('./execute.cjs').execute(result,ctx,deps,async()=>{
        if(o.allowStop) {
          result.mode='stop';
          result.stops=[];
          for(const name of new Set(result.notices.filter(n=>n.level==='RUNAWAY').map(n=>n.seat))) {
            const seat=running.seats.find(s=>s.name===name);
            result.stops.push(await require('./stop.cjs').stopRunaway(seat,caps,{...deps.stop,allowStop:true}));
          }
        }
        });
        return emit();
      };
      return active().catch(e => { error(`REFUSED ${e.code || 'internal'}`); return 1; });
    }
    if (previous.value.controllerPid && inputs.alive(previous.value.controllerPid)) reader.refuse('controller-busy');
    state.save(repoRoot, previous, next);
    return emit();
  } catch (e) { const code = e.code || 'internal'; error(`REFUSED ${code}`); return code === 'usage' ? 2 : 1; }
}
module.exports = { main, plan, capacity, reserve, notices, options, selectionData };
if (require.main === module) Promise.resolve(main(process.argv.slice(2))).then(code => { process.exitCode=code; });

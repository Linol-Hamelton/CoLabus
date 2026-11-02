'use strict';
// The only launch capability is the existing wrapper, with cert-launch as its child.
const path = require('node:path');
const fs = require('node:fs');
const {randomUUID} = require('node:crypto');
const reader = require('./reader.cjs');
const inputs = require('./inputs.cjs');
const state = require('./state.cjs');
const shapes = require('./input-shapes.cjs');
const REPO = path.resolve(__dirname, '../..');
const CHECK_MS = 45000;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function routes(repoRoot, deps) {
  const file = path.join(repoRoot, 'tools/operator-knowledge/route-state.cjs');
  if (!fs.existsSync(file) && !deps.routeReader) reader.refuse('route-module-missing');
  const api = deps.routeReader || require('../operator-knowledge/route-state.cjs');
  const record = api.loadRecord(path.join(repoRoot, 'docs/ops/route-state.json'));
  return { api, record };
}
function checkRoute(data, seat, now) {
  const route = data.record.routes.find(r => r.id === seat.launch.routeId);
  if (!route || route.client !== seat.client || route.model !== seat.model || !route.roles.includes('certifier')) reader.refuse('launch-route-identity');
  const current = data.api.stateOf(data.record, route.id, new Date(now).toISOString());
  if (current.state === 'failed') reader.refuse('launch-route-failed');
  return current;
}
function wrapperArgs(seat, row, ctx) {
  const s = seat.launch;
  if (!s) reader.refuse('launch-spec-missing');
  reader.readText(s.promptFile, 'prompt');
  const runtime = ctx.seatsDir || path.join(ctx.repoRoot,'.ai/runtime');
  const log = path.join(runtime, `${s.name}.${randomUUID()}.cycle-launch.log`);
  return { log, argv:['run','--stream',row.stream,'--owner',`cycle-${s.name}`,'--name',s.name,
    '--worktree',s.worktree,'--repo',ctx.repo,'--runtime',runtime,'--registry',ctx.registry,
    '--certifier','--cycle-control','--client',seat.client,'--model',seat.model,'--role',seat.role,'--tier','T7','--log',log,
    '--',process.execPath,path.join(REPO,'docs/ops/cert-launch.cjs'),'--client',seat.client,'--model',seat.model,
    '--worktree',s.worktree,'--name',s.name,'--prompt-file',s.promptFile,'--expect-sha',row.sha,'--launch-role','certifier'] };
}
async function launchOne(seat, row, ctx, deps) {
  const built = wrapperArgs(seat,row,ctx);
  const startedMs=Date.now();
  // The launch check is immutable. Later wrapper completion updates only the end state.
  let status = null;
  const lines=[];
  const outcome={name:seat.launch.name,client:seat.client,checkedAfterMs:CHECK_MS,status:null,reason:null,exitCode:null,endState:null,log:built.log};
  const ended=code=>{
    status=code;outcome.exitCode=code;
    let terminal=null;
    const file=path.join(ctx.seatsDir || path.join(ctx.repoRoot,'.ai/runtime'),`${seat.launch.name}.terminal.json`);
    if(fs.existsSync(file)) {
      try {const t=inputs.markerPair(path.dirname(file),seat.launch.name).terminal;if(t && t.name===seat.launch.name && Date.parse(t.startedAt)>=startedMs)terminal=t;}catch{ /* unproven terminal cannot classify this launch */ }
    }
    const cls=terminal?.failureClass;
    outcome.endState=cls==='NO_VERDICT'?'no-verdict':cls==='TURN_LIMIT'?'turn-limit':code===0 && (!terminal || terminal.status==='DONE')?'finished':'failed';
  };
  const completion = Promise.resolve().then(() => (deps.wrapper || require('../../docs/ops/launch-wrapper.cjs')).main(built.argv,{
    say:line=>{lines.push(String(line));if(!ctx.quiet)console.log(line);},
    write:chunk=>{lines.push(String(chunk));if(!ctx.quiet)process.stdout.write(chunk);}
  }))
    .then(ended, () => ended(1));
  // Observe completion without awaiting the seat's lifetime or allowing an unhandled rejection.
  completion.catch(()=>{status=1;outcome.exitCode=1;outcome.endState='failed';});
  await (deps.delay || delay)(CHECK_MS);
  const output = shapes.output(lines.join('\n')+'\n'+(deps.output || (file => fs.existsSync(file) ? reader.bytes(file,'launch-output').toString('utf8') : ''))(built.log));
  const refused = /^(?:[^\r\n]*\b)?REFUSED\b/m.test(output);
  outcome.status=status===null?'running':refused?'refused':status!==0?'failed':'finished-early';
  outcome.reason=status===null?null:refused?'launch-refused':status!==0?'launch-exited-nonzero-before-check':'launch-finished-before-check';
  return outcome;
}
async function execute(result, ctx, deps={}, before=null) {
  const out = [];
  return require('./turn.cjs').controlled(ctx,async()=>{
    if(before)await before();
    const reserved=[];
    for (const seat of ctx.launch===false?[]:result.wouldLaunch) {
      if (!seat.launch) reader.refuse('launch-spec-missing');
      const rows = (deps.candidates || inputs.candidates)(ctx.registry);
      const row = rows.find(r => r.stream === seat.stream && r.sha === seat.sha);
      if (!row || (deps.branchTip || inputs.branchTip)(ctx.repo,row.branch) !== row.sha) reader.refuse('launch-stale-sha');
      if ((deps.branchTip || inputs.branchTip)(seat.launch.worktree,null) !== row.sha) reader.refuse('launch-worktree-sha');
      const caps = reader.caps(ctx.capsFile);
      const running = (deps.running || (() => inputs.running(ctx.seatsDir,ctx.history,Date.now())) )();
      const {capacity,reserve} = require('./controller.cjs');
      const observed=new Set(running.seats.map(s=>s.name));
      const budget=capacity([...running.seats,...reserved.filter(s=>!observed.has(s.name))],caps);
      if (!reserve(seat.client,budget,caps)) reader.refuse('launch-capacity');
      checkRoute(routes(ctx.repoRoot,deps),seat,(deps.now || Date.now)());
      reserved.push({name:seat.launch.name,client:seat.client});
      out.push(await launchOne(seat,row,ctx,deps));
    }
    if(ctx.launch!==false){result.mode='launch'; result.launches=out;}
    return result;
  });
}
module.exports={execute,launchOne,wrapperArgs,checkRoute,routes,CHECK_MS};

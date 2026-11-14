'use strict';
// C8: a pure projection. The read adapter and explicitly enabled effects are separate.
const path=require('node:path');
const reader=require('./reader.cjs');
const paths=require('./paths.cjs');
function plan(snapshot) {
  const copies=snapshot.seats.filter(s=>s.ended && s.copy.state!=='verified').map(s=>({
    name:s.name,startedAt:s.startedAt,worktree:s.worktree,state:s.copy.state,reason:s.copy.reason,inventory:s.copy.inventory||'unknown',
    registryStatuses:(snapshot.candidates||[]).filter(r=>r[0]===s.stream).map(r=>r[4]),
    // (d) the seat is the pair (name, worktree); a seat without a resolvable worktree has no call.
    call:s.worktree && paths.key(s.worktree).ok ? ['node','tools/cycle/lifecycle.cjs','--copy-reports','--seat',s.name,'--worktree',s.worktree] : null
  }));
  const retire=snapshot.retire.entries.map(e=>({path:e.path,branch:e.branch,head:e.head,
    state:e.plan,reason:e.reasons.length?e.reasons.join(','):'auto-retire-candidate',
    registryStatuses:(snapshot.candidates||[]).filter(r=>r[1]===e.branch).map(r=>r[4]),
    reports:snapshot.seats.filter(s=>s.worktree && paths.same(s.worktree,e.path)).map(s=>({name:s.name,worktree:s.worktree,ended:s.ended,copy:s.copy.state})),
    // (b) the lifecycle verdict of this worktree and the first item that blocks it.
    lifecycle:require('./lifecycle-apply.cjs').treeView(snapshot,e.path,s=>s.copy?.state),
    call:['node','tools/operator/auto-retire.cjs','--root',snapshot.repo,'--tree',e.path,'--apply']
  }));
  const temps=snapshot.retention.entries.map(e=>({path:path.join(e.root,e.name),reason:e.reason,pattern:e.pattern,
    call:['node','docs/ops/temp-retention.cjs','apply','--plan','<saved-retention-plan>','--plan-hash',snapshot.retention.planHash,'--archive-count',String(snapshot.retention.entries.length),'--execute']}));
  return {schema:'cycle-lifecycle-plan/1',mode:'plan',at:snapshot.at,copies,retire,temps,
    unknown:snapshot.unknown,retention:{planHash:snapshot.retention.planHash,keptMarkerRefused:snapshot.retention.keptMarkerRefused,
      skippedTooRecent:snapshot.retention.skippedTooRecent,foreign:snapshot.retention.foreign}};
}
function options(argv) {
  const args=[...argv];if(args[0]==='plan')args.shift();
  const o={},seen=new Set();
  for(let i=0;i<args.length;i++) {
    const k=args[i];
    if(seen.has(k))reader.refuse('usage');seen.add(k);
    if(['--copy-reports','--apply-retention','--apply-retire','--json'].includes(k))o[k.slice(2)]=true;
    else if(['--repo','--registry','--seats','--journal','--work-area','--seat','--worktree','--now'].includes(k) && args[i+1] && !args[i+1].startsWith('--'))o[k.slice(2)]=args[++i];
    else reader.refuse('usage');
  }
  if(o.seat && !o['copy-reports'] || Object.hasOwn(o,'worktree') && !o.seat)reader.refuse('usage');
  return o;
}
async function main(argv,deps={}) {
  if(argv.includes('--help')||argv.includes('-h')){console.log('usage: lifecycle.cjs [plan] [--json] [--repo DIR] [--registry FILE] [--seats DIR] [--journal FILE] [--work-area DIR] [--now ISO] | --copy-reports --seat ID [--worktree DIR] | --apply-retention | --apply-retire');return 0;}
  try {
    const o=options(argv);let result;
    if(o['copy-reports'] || o['apply-retention'] || o['apply-retire']) {
      if(o.now)reader.refuse('lifecycle-clock-override');
      const repoRoot=path.resolve(o.repo||path.join(__dirname,'../..'));
      const context={repoRoot,runtime:path.resolve(o.seats||path.join(repoRoot,'.ai/runtime'))};
      const {snapshot:post,...effects}=await require('./lifecycle-apply.cjs').apply(o,context,deps);
      result={...plan(post),effects,mode:'apply'};
    }else result=plan((deps.collect||require('./lifecycle-inputs.cjs').collect)(o));
    (deps.say||console.log)(JSON.stringify(result,null,2));return 0;
  }catch(e){(deps.error||console.error)(`REFUSED ${e.code||e.message||'lifecycle-unknown'}${e.candidates?` candidates=${e.candidates.join(',')}`:''}`);return e.code==='usage'?2:1;}
}
module.exports={plan,options,main};
if(require.main===module)main(process.argv.slice(2)).then(code=>{process.exitCode=code;});

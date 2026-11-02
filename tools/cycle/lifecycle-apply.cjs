'use strict';
// Every lifecycle effect shares the stage-3 controller guard and immutable turn claim.
const state=require('./state.cjs'),turn=require('./turn.cjs'),reader=require('./reader.cjs');
const copy=require('./lifecycle-copy.cjs'),inputs=require('./lifecycle-inputs.cjs');
const path=require('node:path');
const paths=require('./paths.cjs');
// (b) The worktree view. The default is BLOCKED: a worktree is eligible only when no
// unknown entry blocks it (a global or unattributed entry blocks every worktree, a
// seat entry the worktree it names), it has at least one seat, every seat on it is
// ended and its reports are byte-verified. The first item that fails is the cause.
function treeView(snapshot,target,copyState=seat=>copy.describe(seat,snapshot).state) {
  // One resolution per spelling for this view.
  const keyOf=inputs.memoKey(),t=keyOf(target);
  const seats=snapshot.seats.filter(s=>{if(!s.worktree || !t.ok)return false;const k=keyOf(s.worktree);return k.ok && k.key===t.key;});
  const item=snapshot.unknown.find(e=>inputs.blocks(e,{name:null,worktree:target},keyOf) || seats.some(seat=>inputs.blocks(e,seat,keyOf)));
  if(item)return {path:target,reason:'lifecycle-inputs-unknown',cause:{seat:item.seat??null,source:item.source??null,reason:item.reason??null}};
  if(!seats.length)return {path:target,reason:'lifecycle-tree-seats-unknown',cause:null};
  const open=seats.find(seat=>!seat.ended);
  if(open)return {path:target,reason:'lifecycle-reports-not-copied',cause:{seat:open.name,source:open.id??null,reason:open.reason??'seat-not-ended'}};
  const pending=seats.find(seat=>copyState(seat)!=='verified');
  if(pending)return {path:target,reason:'lifecycle-reports-not-copied',cause:{seat:pending.name,source:pending.id??null,reason:'reports-not-verified'}};
  return {path:target,reason:null,cause:null};
}
function retirementPlan(snapshot) {
  const targets=[],blocked=[];
  for(const target of snapshot.retire.entries.filter(e=>e.plan==='candidate').map(e=>e.path)) {
    const view=treeView(snapshot,target);
    if(view.reason)blocked.push(view);else targets.push(target);
  }
  return {targets,blocked};
}
function retirementTargets(snapshot) {
  const {targets,blocked}=retirementPlan(snapshot);
  if(blocked.length && !targets.length)reader.refuse(blocked[0].reason);
  return targets;
}
// (d) A seat is named by the pair (name, worktree). An emitted plan item carries both;
// an ambiguous name is refused with its candidates, never as an unknown seat.
function selectSeat(o,snapshot) {
  const named=snapshot.seats.filter(s=>s.name===o.seat);
  let chosen=named;
  if(Object.hasOwn(o,'worktree')) {
    const k=paths.key(o.worktree);if(!k.ok)reader.refuse(k.reason);
    chosen=named.filter(s=>s.worktree && paths.same(s.worktree,o.worktree));
  }
  if(!chosen.length)reader.refuse('lifecycle-seat-unknown');
  if(chosen.length>1)throw Object.assign(new Error('lifecycle-seat-ambiguous'),{code:'lifecycle-seat-ambiguous',candidates:chosen.map(s=>s.worktree)});
  if(!chosen[0].ended)reader.refuse('lifecycle-seat-not-ended');
  return chosen[0];
}
// The dry form of copy-reports for one requested seat: every check, no copy.
function dryCopy(o,snapshot) {
  if(snapshot.unknown.some(inputs.isGlobal))reader.refuse('lifecycle-inputs-unknown');
  const seat=selectSeat(o,snapshot);
  if(snapshot.unknown.find(e=>inputs.blocks(e,seat)))reader.refuse('lifecycle-inputs-unknown');
  return seat;
}
// Per-seat copy outcome: a refusal of one seat is that seat's named state.
function copyOne(seat,snapshot) {
  const own=snapshot.unknown.find(e=>inputs.blocks(e,seat));
  if(own)reader.refuse('lifecycle-inputs-unknown');
  return copy.copy(seat,snapshot);
}
async function apply(o,snapshot,deps={}) {
  const now=new Date().toISOString(),previous=state.snapshot(snapshot.repoRoot,now);
  const ctx={repoRoot:snapshot.repoRoot,seatsDir:snapshot.runtime,previous,next:{...previous.value,revision:previous.value.revision+1,lastObservedAt:now}};
  return turn.controlled(ctx,async()=>{
    const fresh=(deps.collect||inputs.collect)(o),result={copies:[],calls:[],blocked:[]};
    if(o['copy-reports']) {
      if(fresh.unknown.some(inputs.isGlobal))reader.refuse('lifecycle-inputs-unknown');
      if(o.seat)result.copies.push(copyOne(dryCopy(o,fresh),fresh));
      else for(const seat of fresh.seats.filter(s=>s.ended)) {
        try{result.copies.push(copyOne(seat,fresh));}
        catch(e){if(!e.code || e.message!==e.code)throw e;result.copies.push({seat:seat.name,worktree:seat.worktree,state:'refused',reason:e.code});}
      }
    }
    // Prove copy-out before *any* retire call. The delegated tool rechecks its own
    // registry, process table, landing state, archive and worktree safety gates.
    if(o['apply-retire']) {
      const current=(deps.collect||inputs.collect)(o),planned=retirementPlan(current),targets=planned.targets;
      result.blocked.push(...planned.blocked);
      if(planned.blocked.length && !targets.length)reader.refuse(planned.blocked[0].reason);
      for(const target of targets) {
        const outcome=(deps.retire||require('../operator/auto-retire.cjs')).run({repo:current.repo,targets:[target],apply:true});
        result.calls.push({tool:'auto-retire',result:outcome});
        const refused=outcome.entries.find(e=>e.reason);
        if(refused)reader.refuse(refused.reason);
        if(outcome.recordFailed || outcome.entries.some(e=>e.receiptFailed))reader.refuse('lifecycle-retire-record-failed');
      }
    }
    if(o['apply-retention']) {
      const current=(deps.collect||inputs.collect)(o);
      if(current.unknown.some(e=>e.source==='retention') || !current.retention.planHash || !Array.isArray(current.retention.entries))reader.refuse('lifecycle-retention-unknown');
      const file=path.join(snapshot.repoRoot,'.ai/runtime/cycle-controller',`retention-turn-${ctx.next.revision}.json`);
      copy.preserve(snapshot.repoRoot,file,Buffer.from(JSON.stringify(current.retention,null,2)+'\n'));
      const exit=(deps.retention||require('../../docs/ops/temp-retention.cjs')).main([
        'apply','--plan',file,'--plan-hash',current.retention.planHash,'--archive-count',String(current.retention.entries.length),'--execute'
      ],{repo:current.repo});
      result.calls.push({tool:'temp-retention',exit});
      if(exit!==0)reader.refuse('lifecycle-retention-refused');
    }
    const post=(deps.collect||inputs.collect)(o);
    // Test adapters and production adapters both project the bytes after apply.
    result.snapshot={...post,seats:post.seats.map(s=>({...s,copy:s.ended?copy.describe(s,post):s.copy}))};
    return result;
  });
}
module.exports={apply,retirementTargets,retirementPlan,treeView,selectSeat,dryCopy};

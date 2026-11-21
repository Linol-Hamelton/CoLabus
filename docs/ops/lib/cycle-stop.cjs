'use strict';
// Cooperative stop: only the wrapper holding the ChildProcess executes the stop.
const fs=require('node:fs');
const path=require('node:path');
function requestStop(seat,proof) {
  const stop=require('../../../tools/cycle/stop.cjs');
  if(!stop.verifySaved(proof) || !stop.stillSafe(proof) || !seat.runtime)return false;
  const reader=require('../../../tools/cycle/reader.cjs');
  const marker=reader.json(path.join(seat.runtime,`${seat.name}.running.json`),'seat');
  if(marker.cycleStop!==true || marker.name!==seat.name || marker.startedAt!==seat.startedAt || marker.ended || marker.worktree!==seat.worktree)return false;
  const safe=require('../../../.ai/bin/lib/path-safe.cjs');
  return safe.writeAtomicGuarded(path.join(seat.runtime,`${seat.name}.stop-request.json`),Buffer.from(JSON.stringify(proof)+'\n'),{root:seat.runtime}).ok;
}
function watchStop({runtime,name,startedAt,worktree,child,onNotice=()=>{}},deps={}) {
  const file=path.join(runtime,`${name}.stop-request.json`);
  let handled=null;
  const tick=()=>{
    if(!fs.existsSync(file) || child.exitCode!==null)return false;
    try {
      const reader=require('../../../tools/cycle/reader.cjs'),proof=reader.json(file,'stop-request');
      if(proof.startedAt!==startedAt || proof.name!==name || proof.worktree!==worktree || handled===proof.directory)return false;
      handled=proof.directory;
      const stop=deps.savedWork || require('../../../tools/cycle/stop.cjs');
      if(!['commit','tool-call-end'].includes(proof.point) || !stop.verifySaved(proof) || !stop.stillSafe(proof)) {onNotice('stop-proof-refused');return false;}
      const proc=deps.proc || require('../../../.ai/bin/protocol-dispatch/procfs.cjs');
      const lease=deps.lease || require('../../../.ai/bin/protocol-dispatch/lease.cjs');
      const table=proc.snapshotProcesses(),root=table?.find(r=>r.pid===child.pid);
      if(!root || Date.parse(root.createdAt)<Date.parse(startedAt)) {onNotice('stop-process-identity');return false;}
      const plan=lease.planStop({root,recorded:lease.descendantsOf(table,root.pid),table});
      for(const step of plan.steps) {
        if(step.op==='kill-pid')proc.killExact(step.pid);
        else child.kill('SIGKILL');
      }
      onNotice(`stopped-at-safe-point saved=${proof.directory}`);
      return true;
    }catch{onNotice('stop-request-refused');return false;}
  };
  const timer=setInterval(tick,250);timer.unref();
  return {tick,close:()=>clearInterval(timer)};
}
module.exports={requestStop,watchStop};

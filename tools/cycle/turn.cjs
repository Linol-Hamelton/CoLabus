'use strict';
// One immutable, exclusive claim per state revision. Claims are disposable runtime data;
// no release/delete operation is needed, and a crash fails closed on that revision.
const fs=require('node:fs');
const path=require('node:path');
const safe=require('../../.ai/bin/lib/path-safe.cjs');
const reader=require('./reader.cjs');
const {randomUUID}=require('node:crypto');
const state=require('./state.cjs');
function acquire(ctx) {
  if(ctx.previous.value.controllerPid && require('./inputs.cjs').alive(ctx.previous.value.controllerPid))reader.refuse('controller-busy');
  const directory=path.resolve(ctx.seatsDir || path.join(ctx.repoRoot,'.ai/runtime'));
  if(!safe.realInside(path.parse(directory).root,directory,{allowRoot:true}).ok)reader.refuse('controller-guard-directory');
  const file=path.join(directory,'.cycle-controller.guard');
  if(!safe.realInside(directory,file,{refuseHardlinks:true}).ok)reader.refuse('controller-guard-path');
  let fd;
  try{fd=fs.openSync(file,'wx');}catch(e){reader.refuse(e.code==='EEXIST'?'controller-busy':'controller-guard-write');}
  try{fs.writeSync(fd,JSON.stringify({pid:process.pid,revision:ctx.next.revision})+'\n');}finally{fs.closeSync(fd);}
  let released=false;
  return {release:()=>{
    if(released)return;
    if(!safe.realInside(directory,file,{refuseHardlinks:true}).ok)reader.refuse('controller-guard-path');
    // Retain the old guard for diagnosis. No unlink, stale-lock stealing or deletion.
    fs.renameSync(file,path.join(directory,`.cycle-controller.released-${randomUUID()}`));released=true;
  }};
}
async function controlled(ctx,action) {
  const guard=acquire(ctx);let published=false;
  try {
    claim(ctx.repoRoot,ctx.next.revision);
    state.save(ctx.repoRoot,ctx.previous,{...ctx.next,controllerPid:process.pid});published=true;
    return await action();
  } finally {
    try {
      if(published) {
        const current=state.snapshot(ctx.repoRoot,new Date().toISOString());
        if(current.value.controllerPid===process.pid)state.save(ctx.repoRoot,current,{...current.value,revision:current.value.revision+1,controllerPid:null});
      }
    } finally {guard.release();}
  }
}
function claim(repoRoot,revision) {
  if(!Number.isSafeInteger(revision) || revision<1)reader.refuse('controller-claim-revision');
  const directory=path.join(repoRoot,'.ai/runtime/cycle-controller');
  for(const dir of [path.dirname(directory),directory])if(!safe.mkdirGuarded(repoRoot,dir).ok)reader.refuse('controller-claim-directory');
  const file=path.join(directory,`turn-${revision}.claim`);
  if(!safe.realInside(directory,file,{refuseHardlinks:true}).ok)reader.refuse('controller-claim-path');
  let fd;
  try {fd=fs.openSync(file,'wx');}
  catch(e){reader.refuse(e.code==='EEXIST'?'controller-busy':'controller-claim-write');}
  try {fs.writeSync(fd,JSON.stringify({revision,pid:process.pid})+'\n');}
  finally {fs.closeSync(fd);}
  return file;
}
module.exports={claim,acquire,controlled};

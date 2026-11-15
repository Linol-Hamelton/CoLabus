'use strict';
const fs=require('node:fs');
const path=require('node:path');
const crypto=require('node:crypto');
const {spawnSync}=require('node:child_process');
const safe=require('../../.ai/bin/lib/path-safe.cjs');
const reader=require('./reader.cjs');
const digest=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function git(worktree,args) {
  const r=spawnSync('git',['-C',worktree,...args],{encoding:'buffer',timeout:10000,windowsHide:true,maxBuffer:32*1024*1024});
  if(r.status!==0) reader.refuse('stop-git-unavailable');
  return r.stdout;
}
function toolState(file) {
  if(!file || !fs.existsSync(file)) return {available:false,active:[],ends:[],hash:null};
  const raw=reader.readText(file,'client-log'),active=new Set(),ends=[];
  for(const line of raw.trim().split('\n').filter(Boolean)) {
    let event;try{event=require('../../.ai/bin/lib/text-safe.cjs').parseJsonUnique(line);}catch{reader.refuse('stop-log-invalid');}
    require('./event-shape.cjs').event(event);
    const id=event.id || event.item?.id;
    const toolItem=['command_execution','mcp_tool_call','web_search','file_change'].includes(event.item?.type);
    const start=event.type==='tool-call-start' || (event.type==='item.started' && toolItem);
    const end=event.type==='tool-call-end' || (event.type==='item.completed' && toolItem);
    if(start || end) {
      if(typeof id!=='string' || !id) reader.refuse('stop-log-invalid');
      if(start)active.add(id);
      else if(active.delete(id))ends.push(id);
    }
  }
  return {available:true,active:[...active],ends,hash:digest(Buffer.from(raw))};
}
function observation(seat) {
  if(!seat.worktree)reader.refuse('stop-worktree-missing');
  return {head:git(seat.worktree,['rev-parse','HEAD']).toString('utf8').trim(),tools:toolState(seat.clientLog)};
}
function safePoint(before,after) {
  if(after.tools.active.length) return null;
  if(after.head!==before.head) return 'commit';
  if(after.tools.available && after.tools.ends.length>before.tools.ends.length) return 'tool-call-end';
  return null;
}
function snapshot(seat,ignoreDirectory=null) {
  const patch=git(seat.worktree,['diff','HEAD','--binary','--no-ext-diff','--no-textconv']);
  const names=git(seat.worktree,['ls-files','--others','--exclude-standard','-z']).toString('utf8').split('\0').filter(Boolean)
    .filter(n=>!ignoreDirectory || !require('./paths.cjs').inside(ignoreDirectory,path.resolve(seat.worktree,n)));
  const untracked=names.map(name=>{
    const r=safe.readFileGuarded(seat.worktree,path.join(seat.worktree,name),{refuseHardlinks:true});
    if(!r.ok)reader.refuse('stop-untracked-unreadable');
    return {name,sha256:digest(r.bytes)};
  });
  return {patch,untracked};
}
function saveWork(seat,point,observed) {
  if(!/^[a-z0-9][a-z0-9-]{0,63}$/.test(seat.name))reader.refuse('stop-seat-name');
  const work=snapshot(seat);
  const directory=path.join(seat.worktree,'docs/ops/cycle-reports',seat.name,`${Date.now()}-${crypto.randomBytes(5).toString('hex')}`);
  // Fixed report home: never a caller-supplied path, record, review or journal.
  for(const rel of ['docs','docs/ops','docs/ops/cycle-reports',`docs/ops/cycle-reports/${seat.name}`,path.relative(seat.worktree,directory)]) {
    if(!safe.mkdirGuarded(seat.worktree,path.join(seat.worktree,rel)).ok)reader.refuse('stop-save-directory');
  }
  const write=(name,bytes)=>{
    const file=path.join(directory,name);
    if(!safe.writeAtomicGuarded(file,bytes,{root:directory}).ok || !reader.bytes(file,'saved-work').equals(bytes))reader.refuse('stop-save-failed');
    return digest(bytes);
  };
  const patchHash=write('tracked.patch',work.patch);
  const listHash=write('untracked.json',Buffer.from(JSON.stringify(work.untracked,null,2)+'\n'));
  const proof={schema:'cycle-saved-work/1',name:seat.name,startedAt:seat.startedAt,worktree:seat.worktree,clientLog:seat.clientLog || null,
    point,head:observed.head,tools:observed.tools,patchHash,listHash,directory};
  write('saved.json',Buffer.from(JSON.stringify(proof,null,2)+'\n'));
  if(!verifySaved(proof) || !stillSafe(proof))reader.refuse('stop-save-race');
  return proof;
}
function verifySaved(proof) {
  try {
    const root=path.join(proof.worktree,'docs/ops/cycle-reports',proof.name);
    if(!safe.realInside(root,proof.directory).ok)return false;
    return ['tracked.patch','untracked.json'].every((name,i)=>digest(reader.bytes(path.join(proof.directory,name),'saved-work'))===[proof.patchHash,proof.listHash][i]);
  }catch{return false;}
}
function stillSafe(proof) {
  try {
    const obs=observation(proof),work=snapshot(proof,proof.directory);
    return obs.head===proof.head && obs.tools.hash===proof.tools.hash && !obs.tools.active.length && digest(work.patch)===proof.patchHash &&
      digest(Buffer.from(JSON.stringify(work.untracked,null,2)+'\n'))===proof.listHash;
  }catch{return false;}
}
async function stopRunaway(seat,caps,{allowStop=false,wrapper,delay=ms=>new Promise(r=>setTimeout(r,ms)),observe=observation,save=saveWork}={}) {
  if(!allowStop)return {seat:seat.name,action:'notice-only',reason:'stop-not-authorized'};
  const deadline=Date.now()+caps.safePointWaitSeconds*1000;
  const before=observe(seat), polls=Math.ceil(caps.safePointWaitSeconds);
  for(let i=0;i<polls;i++) {
    const remaining=deadline-Date.now();
    if(remaining<=0)break;
    await delay(Math.min(1000,remaining));
    const after=observe(seat),point=safePoint(before,after);
    if(Date.now()>deadline)break;
    if(!point)continue;
    const proof=save(seat,point,after);
    if(!verifySaved(proof) || !stillSafe(proof))reader.refuse('stop-saved-work-required');
    const accepted=(wrapper || require('../../docs/ops/launch-wrapper.cjs')).requestStop(seat,proof);
    return {seat:seat.name,action:accepted?'stop-requested':'notice-only',reason:accepted?point:'wrapper-stop-unavailable',directory:proof.directory};
  }
  return {seat:seat.name,action:'notice-only',reason:'safe-point-timeout'};
}
module.exports={stopRunaway,observation,safePoint,toolState,snapshot,saveWork,verifySaved,stillSafe,digest,git};

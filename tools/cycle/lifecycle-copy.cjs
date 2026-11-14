'use strict';
// Archive layout matches the worktree retirement tool: date/tree-identity/relative-path, where the
// file name carries its content address (first 12 hex digits of sha256), so a file
// that grows after a copy is a NEW version beside the old one. Receipts list
// files [{path, archive, sha256, size}]. A report receipt is never a retirement receipt.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const G=require('../../.ai/bin/lib/path-safe.cjs'),reader=require('./reader.cjs');
const {identity}=require('../operator/auto-retire.cjs');
const paths=require('./paths.cjs');
// An unresolved path is UNKNOWN for this seat: a named refusal, never an exception.
const keyOf=value=>{const k=paths.key(value);if(!k.ok)reader.refuse(k.reason);return k.key;};
const {secretIn}=require('../../.ai/bin/lib/secrets.cjs');
const {findSecretLeak}=require('../../.ai/bin/protocol-hooks.cjs');
// Same filename alphabet and both payload readers as AUTO-RETIRE.
const sensitive=(name,bytes)=>/(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.pypirc|\.netrc|credentials(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|[^/]*\.(?:pem|key|p12|pfx))$/i.test(name)
  || secretIn(bytes.toString('utf8')) || Boolean(findSecretLeak(bytes.toString('utf8')));
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const SCHEMA='cycle-report-archive/3';
function versioned(rel,sha) {
  const folder=path.posix.dirname(rel),leaf=path.posix.basename(rel),ext=path.posix.extname(leaf);
  return (folder==='.'?'':folder+'/')+`${leaf.slice(0,leaf.length-ext.length)}.${sha.slice(0,12)}${ext}`;
}
function guarded(root,file,allowRoot=false) {
  const g=G.realInside(root,file,{allowRoot,refuseHardlinks:true});
  if(!g.ok)reader.refuse('lifecycle-copy-path');return g;
}
function read(root,file){guarded(root,file);const r=G.readFileGuarded(root,file,{refuseHardlinks:true});if(!r.ok)reader.refuse('lifecycle-copy-read');return r.bytes;}
function assertSame(root,file,bytes){const g=guarded(root,file);if(g.exists && !read(root,file).equals(bytes))reader.refuse('lifecycle-archive-conflict');}
function sourceTree(seat,snapshot) {
  if(!seat.ended)reader.refuse('lifecycle-seat-not-ended');
  if(!seat.worktree || !path.isAbsolute(seat.worktree))reader.refuse('lifecycle-worktree-unknown');
  keyOf(seat.worktree); // named refusal for UNC/unmounted before any filesystem lookup
  const tree=guarded(snapshot.workArea,seat.worktree);
  if(!tree.exists || tree.type!=='dir')reader.refuse('lifecycle-worktree-unavailable');
  if(!snapshot.trees.some(w=>paths.same(w.path,seat.worktree)))reader.refuse('lifecycle-worktree-unregistered');
  if((snapshot.seats||[]).some(s=>s.worktree && paths.same(s.worktree,seat.worktree) && !s.ended))reader.refuse('lifecycle-seat-not-ended');
}
// The runtime files of a seat are what EXISTS: the call file and every launch log
// are optional; a missing one is not an error.
function runtimeFiles(seat) {
  const escaped=seat.name.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const pattern=new RegExp(`^${escaped}(?:-call\\.txt|\\.launch\\.out|\\.log|\\.launch\\.log|\\.[a-f0-9-]{36}\\.cycle-launch\\.log|-launch\\.log)$`);
  return fs.readdirSync(seat.runtime).filter(n=>pattern.test(n)).sort();
}
function inventory(seat,snapshot,payload=true) {
  sourceTree(seat,snapshot);
  const files=[];
  function add(root,file,rel){
    const bytes=payload?read(root,file):null;
    if(!payload){files.push({root,source:file,path:rel.replace(/\\/g,'/'),sha256:null,size:fs.statSync(file).size});return;}
    if(sensitive(rel.replace(/\\/g,'/'),bytes))reader.refuse('lifecycle-report-secret');
    const sha256=hash(bytes),posix=rel.replace(/\\/g,'/');
    files.push({root,source:file,path:posix,archive:versioned(posix,sha256),sha256,size:bytes.length});
  }
  function walk(rel){
    const dir=path.join(seat.worktree,rel),g=guarded(seat.worktree,dir);
    if(!g.exists || g.type!=='dir')reader.refuse('lifecycle-report-directory-missing');
    for(const name of fs.readdirSync(dir).sort()){
      if(rel==='.ai/worklog' && name==='README.md')continue;
      const next=path.join(rel,name),file=path.join(seat.worktree,next),s=guarded(seat.worktree,file);
      if(s.type==='dir')walk(next);else if(s.type==='file')add(seat.worktree,file,next);else reader.refuse('lifecycle-copy-path');
    }
  }
  walk('docs/reviews');walk('.ai/worklog');
  if(!files.length)reader.refuse('reports-missing');
  const seats=(snapshot.seats||[seat]).filter(s=>s.worktree && paths.same(s.worktree,seat.worktree));
  const runtimeSeen=new Set();
  for(const member of seats)for(const name of runtimeFiles(member)) {
    const source=path.join(member.runtime,name),key=keyOf(source);
    if(runtimeSeen.has(key))continue;runtimeSeen.add(key);
    add(member.runtime,source,`.ai/runtime/${name}`);
  }
  files.sort((a,b)=>a.path.localeCompare(b.path,'en'));
  if(new Set(files.map(f=>keyOf(path.join(seat.worktree,f.path)))).size!==files.length)reader.refuse('lifecycle-report-collision');
  return files;
}
function location(seat,snapshot) {
  sourceTree(seat,snapshot);
  const root=snapshot.repo;
  const base=path.join(root,'docs/ops/journals-archive'),id=identity(keyOf(seat.worktree));
  guarded(root,base);
  let day=snapshot.at.slice(0,10),foundDay=null;
  const receipts=[],seen=new Set();
  if(fs.existsSync(base))for(const d of fs.readdirSync(base).filter(n=>/^\d{4}-\d{2}-\d{2}$/.test(n)).sort()){
    const dateDir=path.join(base,d);guarded(root,dateDir);
    const matches=fs.readdirSync(dateDir).filter(n=>n.startsWith(`reports-${id}-`) && n.endsWith('.json'));
    for(const name of matches){
      if(seen.has(name))reader.refuse('lifecycle-duplicate-receipt');seen.add(name);
      const file=path.join(dateDir,name);guarded(root,file);receipts.push(file);
    }
    if(matches.length || guarded(root,path.join(dateDir,id)).exists) {
      if(foundDay && foundDay!==d)reader.refuse('lifecycle-archive-conflict');
      foundDay=d;day=d;
    }
  }
  const directory=path.join(base,day,id);
  guarded(root,directory);
  return {root,directory,receipts,id,base,day};
}
function bundle(seat,snapshot) {
  const files=inventory(seat,snapshot),{root,directory,receipts,id,base,day}=location(seat,snapshot);
  const archived=new Map();
  for(const file of receipts) {
    let m;try{m=reader.json(file,'lifecycle-receipt');}catch{reader.refuse('lifecycle-archive-conflict');}
    if(m.schema!==SCHEMA || m.identity!==id || typeof m.worktree!=='string' || !paths.same(m.worktree,seat.worktree) || !Array.isArray(m.files) || !m.files.length)reader.refuse('lifecycle-archive-conflict');
    for(const f of m.files){
      if(typeof f.path!=='string' || path.isAbsolute(f.path) || !/^[a-f0-9]{64}$/.test(f.sha256) || !Number.isSafeInteger(f.size) || f.size<0)reader.refuse('lifecycle-archive-conflict');
      // The archive name is the content address of the listed bytes, nothing else.
      if(f.archive!==versioned(f.path,f.sha256))reader.refuse('lifecycle-archive-conflict');
      const target=path.join(directory,f.archive);guarded(directory,target);
      const key=keyOf(target);
      if(archived.has(key))reader.refuse('lifecycle-duplicate-receipt');
      const bytes=read(root,target);
      if(hash(bytes)!==f.sha256 || bytes.length!==f.size)reader.refuse('lifecycle-archive-conflict');
      archived.set(key,f);
    }
  }
  // A grown, rewritten or new file has a new archive name: a new version, never a conflict.
  const pending=files.filter(f=>!archived.has(keyOf(path.join(directory,f.archive))));
  const manifest={schema:SCHEMA,identity:id,worktree:keyOf(seat.worktree),
    files:pending.map(({path,archive,sha256,size})=>({path,archive,sha256,size}))};
  const bytes=pending.length?Buffer.from(JSON.stringify(manifest,null,2)+'\n'):read(root,receipts[0]);
  const receipt=pending.length?path.join(base,day,`reports-${id}-${hash(bytes)}.json`):receipts[0];
  guarded(root,receipt);guarded(root,directory);
  // Same name with different bytes can only be a hash collision or tampering.
  for(const f of files)assertSame(root,path.join(directory,f.archive),read(f.root,f.source));
  assertSame(root,receipt,bytes);
  return {files,pending,root,directory,receipt,bytes,versions:archived.size+pending.length};
}
function verified(b) {
  if(!fs.existsSync(b.receipt) || !read(b.root,b.receipt).equals(b.bytes))return false;
  return b.files.every(f=>{
    const file=path.join(b.directory,f.archive);return guarded(b.root,file).exists && hash(read(b.root,file))===f.sha256;
  });
}
function describe(seat,snapshot) {
  try {
    const where=location(seat,snapshot);
    if(!where.receipts.length) {
      // No receipt proves that copy-out has not completed. Do not hash the same
      // inherited review corpus for every old seat merely to state that fact.
      inventory(seat,snapshot,false);
      return {state:'pending',reason:'reports-not-copied',inventory:'uninspected'};
    }
    const b=bundle(seat,snapshot),ok=verified(b);
    return {state:ok?'verified':'pending',reason:ok?'reports-byte-verified':'reports-not-copied',inventory:'inspected',versions:b.versions};
  }
  catch(e){return {state:'unknown',reason:e.code||'lifecycle-copy-unreadable'};}
}
function preserve(root,file,bytes) {
  assertSame(root,file,bytes);
  let dir=root;
  for(const part of path.relative(root,path.dirname(file)).split(path.sep).filter(Boolean)){
    dir=path.join(dir,part);if(!G.mkdirGuarded(root,dir).ok)reader.refuse('lifecycle-copy-directory');
  }
  const compare=()=>assertSame(root,file,bytes);
  if(!G.writeAtomicGuarded(file,bytes,{root,onTempWritten:compare}).ok)reader.refuse('lifecycle-copy-write');
  if(!read(root,file).equals(bytes))reader.refuse('lifecycle-copy-mismatch');
}
function copy(seat,snapshot,deps={}) {
  const b=bundle(seat,snapshot);
  for(const f of b.files){
    const bytes=read(f.root,f.source);if(hash(bytes)!==f.sha256)reader.refuse('lifecycle-report-changed');
    if(!guarded(b.root,path.join(b.directory,f.archive)).exists)(deps.preserve||preserve)(b.root,path.join(b.directory,f.archive),bytes);
    if(hash(read(b.root,path.join(b.directory,f.archive)))!==f.sha256)reader.refuse('lifecycle-copy-mismatch');
  }
  const current=inventory(seat,snapshot);
  if(JSON.stringify(current)!==JSON.stringify(b.files))reader.refuse('lifecycle-report-changed');
  if(!fs.existsSync(b.receipt))preserve(b.root,b.receipt,b.bytes);
  if(!verified(b))reader.refuse('lifecycle-copy-mismatch');
  return {seat:seat.name,worktree:seat.worktree,state:'verified',receipt:b.receipt,files:b.files.length,versions:b.versions};
}
module.exports={inventory,bundle,verified,describe,preserve,copy,hash,versioned,runtimeFiles};

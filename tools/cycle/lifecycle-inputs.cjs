'use strict';
// Read-only adapters reuse the ledger, marker validator, registry and sanctioned planners.
const fs=require('node:fs'),path=require('node:path');
const reader=require('./reader.cjs'),inputs=require('./inputs.cjs'),paths=require('./paths.cjs');
const {buildLaunchRecord}=require('../../.ai/bin/launch-record.cjs');
const registry=require('../../.ai/bin/lib/candidate-registry.cjs');
const retire=require('../operator/auto-retire.cjs'),retention=require('../../docs/ops/temp-retention.cjs');
const ROOT=path.resolve(__dirname,'../..');
// C8: POSITIVE PROOF OF END. The default is NOT PROVEN. A worktree is
// eligible for copy and retire only when every attempt that touches it is proven
// ended; an independent test oracle states the same rule.
// The unit is the ATTEMPT (seat name, stream, startedAt). It is ENDED only when:
//  - a terminal marker of the same startedAt exists and parses;
//  - the running marker of the name is absent, or has the same startedAt and the
//    wrapper's end stamp `ended` (launch-wrapper writes the terminal, then stamps
//    the running marker); a later running marker, or an unstamped one, is not;
//  - no live process: no live marker pid of the name, no process row naming the
//    seat as a token, no row whose cwd or command names the attempt's worktree;
//  - every ledger record of the name that starts at or after startedAt-SKEW_MS is
//    this attempt's own record (within SKEW_MS), carries a proven end and names no
//    other worktree. SKEW_MS only adds a requirement; it never proves an end.
// A ledger record of no marker attempt is a ledger-only attempt: HISTORICAL-ENDED
// only when its start is known and older than HISTORICAL_MS, it names a worktree
// that resolves, the name has no marker at all and no live process names it.
// Everything else is NOT proven.
// A seat is (name, worktree identity). An attempt's worktree comes from its own
// markers, else from its own ledger records (exactly one), else it is UNATTRIBUTED:
// an unattributed attempt that is not proven, and an unreadable or future-dated
// marker, block every worktree (scope 'unattributed'); a proven one is excluded.
const SEAT_STATES=['live','ended','historical-ended','unknown'];
const RECORD_STATES=SEAT_STATES;
const PROVEN=new Set(['ended','historical-ended']);
// A ledger record belongs to a marker attempt only when it starts at
// exactly the marker's startedAt: a cycle-controlled launch writes the record with
// the running marker's startedAt (docs/ops/cert-launch.cjs, CYCLE_CONTROL binding).
// A record that starts at any other time (fix-launch and direct launches stamp
// their own clock seconds later) is ANOTHER attempt and is judged on its own.
const SKEW_MS=0;
const HISTORICAL_MS=7*24*3600*1000;
const idTime=id=>{const m=/^L-(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z-/.exec(id||'');return m?Date.UTC(+m[1],m[2]-1,+m[3],+m[4],+m[5],+m[6]):null;};
const startOf=r=>r.startedMs ?? idTime(r.id);
// A worktree is the real path of an existing directory (paths.tree); a
// relative spelling resolves against the repository. Anything else is unresolved.
// One snapshot resolves each spelling once (seatRecords scopes the memo), so every
// rule of that snapshot sees the same answer for the same path.
let treeMemo=null;
const resolveTree=value=>{
  if(!treeMemo)return paths.tree(value,ROOT);
  if(!treeMemo.has(value))treeMemo.set(value,paths.tree(value,ROOT));
  return treeMemo.get(value);
};
// An attempt and a seat keep the canonical spelling of
// a resolved worktree (real), never the one written in a marker or a record, so no
// later rule can resolve a relative spelling against another base.
const treeOf=value=>{
  if(!value)return {key:null,real:null,reason:'seat-worktree-unknown'};
  const k=resolveTree(value);
  return k.ok?{key:k.key,real:k.real,reason:null}:{key:null,real:null,reason:k.reason};
};
const ledgerEnded=(r,now)=>Boolean(r.ended && r.startedMs!==null && r.startedMs<=now && (r.wallSeconds===null || r.startedMs+r.wallSeconds*1000<=now));
// A process row names a seat by a whole token.
const namesSeat=(row,name)=>(' '+String(row?.cmd||'')+' ').split(/[^A-Za-z0-9._-]+/).includes(name);
// The construction is closed: it works
// without any resolution of its own (no walk from the cwd, no swaps inside the line). A line,
// its cwd and every identity of a worktree pass through ONE function, norm; a worktree
// is touched when one of its identities occurs in a normalised text at a segment
// boundary. No word of a line is resolved against the file system or rewritten.
// NORM: the caret escape goes; a quote escaped by backslashes ends a word; a quote
// between two name characters goes (tr"ee is tree, -C"x" is -Cx); every other quote
// (" ' `) is a separator; scheme:// at the start of a word (a URL, forward slashes only)
// leaves its path rooted (a URL keeps its path, a file URL keeps its drive path, a file URL with a host is a
// share); a backslash is a slash; the case folds as paths.key folds; the extended-length
// and device prefixes of a drive path and a pipe go; a single-dash option glued to its value (-Cv)
// is split from it; whitespace, the quotes and = , ; : ( ) [ ] { } | & ! < > ? * are
// separators, except the colon of a drive (x:/); the trailing dots of a name go (Windows
// strips them); separators fold to one space and slashes collapse.
// IDENTITIES of a worktree: its real path and the links to it in its parent directory,
// each with every tail of two or more segments and its last segment.
// MATCH: an identity occurs where the character before is the start, a space or a slash
// and the character after is the end, a space or a slash. The last segment alone (a
// one-segment tail) counts only as a whole word, or when the text in front of it in its
// word, read in front of the cwd when it is relative, spells the worktree's parent
// directory (lexically, an 8.3 name matching the long name it abbreviates): ../tree from
// a sibling, tree/sub from the parent; never a docs subdirectory for a worktree named like it.
// FAIL CLOSED: a line that is not text or is longer than any Windows command line, a cwd
// that does not resolve, a share or device path (//x at a word start), a drive-relative
// or unmounted drive spelling, and a relative path in a row without a cwd make the row
// unresolved: it could touch any worktree.
const LIMIT=32768,WIN=process.platform==='win32',SEPS='\\s=,;:()\\[\\]{}|&!<>?*';
// The colons are folded first (a drive colon stays), so the run of separators has none.
const SEP=new RegExp(`[${SEPS}]`),SEPRUN=new RegExp(`[${SEPS.replace(':','')}]+`,'g'),UNC=new RegExp(`(?:^|[${SEPS}])\\/{2,}[^\\/\\s]`);
const MIDQ=new RegExp(`(?<=[^${SEPS}"'\`])["'\`]+(?=[^${SEPS}"'\`])`,'g'),GLUED=new RegExp(`(^|[${SEPS}])-([a-z])(?=[^${SEPS}-])`,'gi');
const SCHEME=new RegExp(`(^|[${SEPS}])([a-z][a-z0-9+.-]+):\\/\\/`,'gi'),PIPE=new RegExp(`\\/\\/\\.\\/pipe\\/[^${SEPS}]*`,'gi');
const fold=s=>WIN?s.toLowerCase():s;
function norm(text) {
  let problem=null;
  let t=fold(String(text).replace(/\^/g,'').replace(/\\+["'`]/g,' ').replace(MIDQ,'').replace(/["'`]/g,' ')
    .replace(SCHEME,(m,pre,scheme,i,s)=>{
      if(!/^file$/i.test(scheme))return `${pre}${scheme} /`;
      if(s[i+m.length]!=='/')problem=problem||'unc-unsupported';
      return `${pre}${scheme} `;
    }).replace(/\\/g,'/'))
    .replace(/(?:\/\/[?.]\/|\/\?\?\/)(?=[a-z]:\/)/gi,'')
    .replace(PIPE,' ')
    .replace(GLUED,'$1-$2 ')
    .replace(/:/g,(c,i,s)=>{
      if(WIN && /[a-z]/i.test(s[i-1]||'') && (i===1 || SEP.test(s[i-2]) || s[i-2]==='/')) {
        if(s[i+1]==='/')return ':';
        problem=problem||'invalid-path';
      }
      return ' ';
    });
  if(UNC.test(t))problem=problem||'unc-unsupported';
  t=t.replace(SEPRUN,' ').replace(/\/{2,}/g,'/').replace(/(^| )\/(?=[a-z]:\/)/gi,'$1').replace(/([^ /.])\.+(?=[ /]|$)/g,'$1').trim();
  return {text:t,problem};
}
// One process row, normalised: {unresolved, texts, cwds, cwd}. texts are the line and
// the cwd texts (the real path and the spelling of the row); cwd is the key of the cwd.
function viewOf(row,exists) {
  const raw=row?.cmd===undefined || row?.cmd===null?'':row.cmd;
  if(typeof raw!=='string' || raw.length>LIMIT || /[\x00-\x08\x0e-\x1f\x7f]/.test(raw))return {unresolved:'line-unreadable',texts:[],cwds:[],cwd:null};
  let unresolved=null,cwd=null;const cwds=[];
  if(row?.cwd) {
    const c=resolveTree(row.cwd);
    if(!c.ok)unresolved=c.reason;
    else {cwd=c.key;for(const s of [c.key,row.cwd]){const n=norm(s);if(!n.problem && n.text && !cwds.includes(n.text))cwds.push(n.text);}}
  }
  const {text,problem}=norm(raw);
  unresolved=unresolved||problem;
  if(WIN)for(const m of text.matchAll(/(?:^| )([a-z]):\//g))if(!exists(m[1]+':\\'))unresolved=unresolved||'drive-not-mounted';
  if(!row?.cwd && text.split(' ').some(w=>w==='.' || w==='..' || w.includes('/') && !w.startsWith('/') && !/^[a-z]:\//i.test(w)))unresolved=unresolved||'process-cwd-unknown';
  return {unresolved,texts:[text,...cwds].filter(Boolean),cwds,cwd};
}
// The identities of a worktree key, normalised by norm. One snapshot reads each parent
// directory once (seatRecords scopes the memo).
let idMemo=new Map(),linkMemo=new Map();
function links(key) {
  const parent=path.dirname(key);
  if(!linkMemo.has(parent)) {
    let found=[];
    try {
      found=fs.readdirSync(parent,{withFileTypes:true}).filter(d=>d.isSymbolicLink()).map(d=>{
        const k=paths.key(path.join(parent,d.name));
        return k.ok?{key:k.key,spelling:fold(`${parent.replace(/\/+$/,'')}/${d.name}`)}:null;}).filter(Boolean);
    }catch{}
    linkMemo.set(parent,found);
  }
  return linkMemo.get(parent).filter(l=>l.key===key).map(l=>l.spelling);
}
function identities(key) {
  if(!idMemo.has(key))idMemo.set(key,[key,...links(key)].map(s=>{
    const t=norm(s).text,segs=t.split('/');
    return {whole:[t,...segs.map((_,i)=>segs.slice(i).join('/')).slice(1,-1)],one:segs[segs.length-1],parent:segs.slice(0,-1).join('/')};
  }));
  return idMemo.get(key);
}
// . and .. of an absolute spelling, never above its root.
function lexical(p) {
  const out=[];
  for(const s of p.split('/')) {
    if(s==='' ? out.length>0 : s==='.')continue;
    if(s==='..'){if(out.length>1)out.pop();continue;}
    out.push(s);
  }
  return out.join('/');
}
// Two directory spellings are the same segment by segment; an 8.3 segment (name~1)
// matches the long name it abbreviates; a rooted spelling lies on any drive.
const segmentSame=(x,y)=>x===y || /~\d/.test(x) && y.replace(/[ .]/g,'').startsWith(x.split('~')[0].replace(/[ .]/g,''));
function sameDir(a,b) {
  const x=a.split('/'),y=b.split('/');
  if(x[0]==='' && y[0]!=='')y[0]='';
  return x.length===y.length && x.every((s,i)=>segmentSame(s,y[i]));
}
const edge=(t,i)=>i===0 || t[i-1]===' ' || t[i-1]==='/';
const end=(t,j)=>j>=t.length || t[j]===' ' || t[j]==='/';
// The one-segment tail at i: a whole word, or the text in front of it spells the parent
// (read in front of each cwd text when it is relative; no cwd: the row is unresolved
// already, so it counts). A parent name may hold spaces, so the front may start at any
// of the FRONT_WORDS words before the name.
const FRONT_WORDS=16;
const frontSpells=(front,id,view)=>front.startsWith('/') || /^[a-z]:\//i.test(front)
  ? sameDir(lexical(front),id.parent)
  : !view.cwds.length || view.cwds.some(c=>sameDir(lexical(c+'/'+front),id.parent));
function oneTail(t,i,id,view) {
  const j=i+id.one.length;
  if((i===0 || t[i-1]===' ') && (j>=t.length || t[j]===' '))return true;
  for(let s=i,words=0;words<=FRONT_WORDS;s--) {
    if(s===0 || t[s-1]===' '){if(frontSpells(t.slice(s,i),id,view))return true;words++;}
    if(s===0)return false;
  }
  return false;
}
// An absolute word with an 8.3 segment that spells the worktree segment by segment.
function shortName(t,id) {
  const target=`${id.parent}/${id.one}`,n=target.split('/').length;
  return t.split(' ').some(w=>/~\d/.test(w) && (w.startsWith('/') || /^[a-z]:\//i.test(w)) && (s=>s.length>=n && sameDir(s.slice(0,n).join('/'),target))(lexical(w).split('/')));
}
function contains(view,key) {
  for(const id of identities(key))for(const t of view.texts) {
    for(const w of id.whole)for(let i=t.indexOf(w);i>=0;i=t.indexOf(w,i+1))if(edge(t,i) && end(t,i+w.length))return true;
    if(id.one)for(let i=t.indexOf(id.one);i>=0;i=t.indexOf(id.one,i+1))if(edge(t,i) && end(t,i+id.one.length) && oneTail(t,i,id,view))return true;
    if(t.includes('~') && shortName(t,id))return true;
  }
  return false;
}
// A normalised row touches a worktree key when one of its texts (the line, the cwd) does.
const touches=(view,key)=>Boolean(key && contains(view,key));
// The seats a command line launches (`--name X`, the launch-wrapper/cert-launch flag),
// read on the line without quotes, case kept.
const launched=cmd=>[...new Set([...String(cmd||'').replace(/\\+(?=["'`])/g,'').replace(/["'`^]/g,'').matchAll(/(?:^|[\s=,;()[\]{}|&])--name(?:=|\s+)([^\s=,;()[\]{}|&<>?*]+)/g)].map(m=>m[1]))];
// One marker file through the one marker reader: null (absent), {value} or
// {problem}. Each kind is read on its own, so a refusal names its own file.
function readMarker(directory,name,kind,now) {
  try {
    const v=inputs.marker(directory,name,kind);
    if(!v)return null;
    if(!v.startedAt)reader.refuse('lifecycle-marker-time');
    for(const t of [v.startedAt,v.endedAt,v.ended])if(typeof t==='string' && Date.parse(t)>now)reader.refuse('lifecycle-marker-time');
    return {value:v};
  }catch(e){return {problem:e.code||'lifecycle-marker-unreadable'};}
}
// The reason an attempt of a marker is NOT proven ended, or null when it is.
function unproven(at,R,T,recs,key,conflict,live,now) {
  const ms=Date.parse(at);
  if(live)return 'seat-live-process';
  if(conflict)return conflict===true?'seat-marker-identity-conflict':conflict;
  if(!T)return 'seat-terminal-missing';
  if(T.startedAt!==at)return 'seat-terminal-of-other-attempt';
  // The terminal itself proves an end only with a final status and an
  // end time inside [startedAt, now].
  if(!['DONE','FAILED'].includes(T.status) || !(Date.parse(T.endedAt)>=ms && Date.parse(T.endedAt)<=now))return 'seat-terminal-end-unproven';
  if(R && Date.parse(R.startedAt)>ms)return 'seat-newer-running-marker';
  // The running marker of the name is ONE file; when it belongs to an
  // older attempt (even on another worktree) the wrapper never stamped this one.
  if(R && R.startedAt!==at)return 'seat-older-running-marker';
  if(R && R.startedAt===at && !R.ended)return 'seat-running-marker-not-stamped';
  if(R && !(Date.parse(R.ended)>=ms && Date.parse(R.ended)<=now))return 'seat-running-marker-not-stamped';
  if(R && R.startedAt===at && R.stream!==T.stream)return 'seat-marker-identity-conflict';
  // One attempt has one wrapper; two wrapper pids are two launches.
  if(R && R.wrapperPid && T.wrapperPid && R.wrapperPid!==T.wrapperPid)return 'seat-marker-identity-conflict';
  for(const r of recs) {
    const s=startOf(r);
    if(s===null)return 'seat-ledger-time-unknown';
    if(s<ms-SKEW_MS)continue; // an older attempt is judged on its own
    if(s>ms+SKEW_MS)return 'seat-ledger-later-attempt';
    if(!ledgerEnded(r,now))return 'seat-ledger-end-unproven';
    if(r.worktree && key && treeOf(r.worktree).key!==key)return 'seat-ledger-other-worktree';
  }
  return null;
}
function seatRecords(directory,history,now,probe=inputs.alive,rows=[]) {
  treeMemo=new Map();idMemo=new Map();linkMemo=new Map();
  try {return seatRecordsOf(directory,history,now,probe,rows);}
  finally {treeMemo=null;}
}
function seatRecordsOf(directory,history,now,probe,rows) {
  const guarded=require('../../.ai/bin/lib/path-safe.cjs').realInside(path.parse(path.resolve(directory)).root,directory,{allowRoot:true});
  if(!guarded.ok || !guarded.exists || guarded.type!=='dir')reader.refuse('lifecycle-seats-directory');
  const files=fs.readdirSync(directory);
  const names=[...new Set(files.filter(n=>/\.(running|terminal)\.json$/.test(n)).map(n=>n.replace(/\.(running|terminal)\.json$/,'')))].sort();
  // A launch pulse (the oracle's <name>.heartbeat.json and the launcher
  // helper's heartbeat-<name>.txt) proves nothing about an attempt or its worktree.
  const pulses=files.map(n=>({file:n,name:(/^(.+)\.heartbeat\.json$/.exec(n)||/^heartbeat-(.+)\.txt$/.exec(n)||[])[1]})).filter(p=>p.name);
  const byName=new Map();
  for(const r of history.recs){const n=r.seatName||r.id;if(!byName.has(n))byName.set(n,[]);byName.get(n).push(r);}
  const attempts=[],records=[];
  // Each row is normalised once (by norm); one existence check per drive.
  const seen=new Map(),exists=p=>{if(!seen.has(p))seen.set(p,fs.existsSync(p));return seen.get(p);};
  const views=rows.map(row=>({pid:row?.pid??null,...viewOf(row,exists)}));
  const nameLive=(name,markers)=>rows.some(row=>namesSeat(row,name)) || markers.some(v=>probe(v.wrapperPid)||probe(v.childPid));
  const treeLive=key=>views.some(v=>touches(v,key));
  // One attempt; its state follows from the reason it is not proven (null: proven).
  const add=(a,why,live,sources)=>{
    // A not proven attempt whose worktree cannot be resolved is named by the path problem.
    if(why!==null && a.worktree && !a.key)why=treeOf(a.worktree).reason;
    // An attempt without a resolvable worktree is never proven, however
    // well its end is proven: it could be on any worktree.
    // No exception for age. A ledger-only record older
    // than HISTORICAL_MS that names no worktree (a backfilled record: the ledger proves
    // none of its fields) blocks too, as the independent model does
    // (an independent test model holds the same rule: an attempt without paths blocks).
    if(why===null && !a.key)why=a.worktree?treeOf(a.worktree).reason:'seat-worktree-unknown';
    const state=why===null?(a.historical?'historical-ended':'ended'):live?'live':'unknown';
    attempts.push({...a,state,reason:why===null?(state==='ended'?'seat-ended':'historical-ended'):why});
    for(const source of sources)records.push({source,seat:a.name,state});
  };
  for(const name of names) {
    const recs=byName.get(name)||[];
    const running=readMarker(directory,name,'running',now),terminal=readMarker(directory,name,'terminal',now);
    const problems=[['running',running],['terminal',terminal]].filter(([,m])=>m && m.problem);
    if(problems.length) {
      // An unreadable or future-dated marker could be on any worktree: each one is
      // an unattributed entry; the ledger records of the name share its state.
      problems.forEach(([kind,m],i)=>add({name,stream:null,startedAt:null,worktree:null,key:null,id:`${name}.${kind}.json`},m.problem,false,
        i?[`${name}.${kind}.json`]:[`${name}.${kind}.json`,...recs.map(r=>r.id)]));
      continue;
    }
    const R=running?.value||null,T=terminal?.value||null,markers=[R,T].filter(Boolean);
    const live=nameLive(name,markers),owned=new Set();
    for(const at of [...new Set(markers.map(v=>v.startedAt))]) {
      const ms=Date.parse(at),mine=markers.filter(v=>v.startedAt===at);
      const own=recs.filter(r=>startOf(r)!==null && Math.abs(startOf(r)-ms)<=SKEW_MS);
      for(const r of own)owned.add(r);
      // The worktree of THIS attempt: its own markers, else its own ledger records.
      // Identity: the resolved key, or the literal spelling when it cannot be resolved.
      const marked=mine.filter(v=>v.worktree),keys=new Set(marked.map(v=>treeOf(v.worktree).key||`unresolved:${v.worktree}`));
      // Every worktree the attempt names, in its markers AND in its own
      // ledger records. One unresolvable spelling leaves it unattributed; two
      // identities are a conflict, which blocks every worktree.
      const spelled=[...marked.map(v=>v.worktree),...own.filter(r=>r.worktree).map(r=>r.worktree)];
      const broken=spelled.find(v=>!treeOf(v).key),found=new Set(spelled.map(v=>treeOf(v).key));
      let worktree=null,key=null,conflict=false;
      if(keys.size>1 || mine.some(v=>!v.stream))conflict=true;
      else if(broken)worktree=broken;
      else if(found.size>1)conflict='seat-ledger-other-worktree';
      else if(spelled.length)({real:worktree,key}=treeOf(spelled[0]));
      // Live: the name is live, or a process works in this attempt's worktree.
      const busy=live || treeLive(key);
      const why=unproven(at,R,T,recs,key,conflict,busy,now);
      add({name,stream:mine[0].stream||null,startedAt:at,worktree,key},why,busy,[`${name}@${at}`,...own.map(r=>r.id)]);
    }
    // Older or later ledger attempts of a name with markers: never historical.
    for(const r of recs)if(!owned.has(r)) {
      const at=startOf(r),{key,real}=treeOf(r.worktree),busy=live || treeLive(key);
      add({name,stream:null,startedAt:at===null?null:new Date(at).toISOString(),worktree:real||r.worktree||null,key,id:r.id},
        busy?'seat-live-process':'seat-ledger-attempt-unproven',busy,[r.id]);
    }
  }
  // Ledger-only names: each record is its own attempt.
  for(const [name,recs] of byName)if(!names.includes(name))for(const r of recs) {
    const at=startOf(r),{key,real}=treeOf(r.worktree),live=nameLive(name,[]) || treeLive(key);
    const why=live?'seat-live-process':at===null?'seat-ledger-time-unknown':at>now?'seat-ledger-start-in-future':now-at<=HISTORICAL_MS?'seat-ledger-only-recent':null;
    add({name,stream:null,startedAt:at===null?null:new Date(at).toISOString(),worktree:real||r.worktree||null,key,historical:true,id:r.id},why,live,[r.id]);
  }
  // A seat is (name, worktree identity): it is ended only when every attempt is proven.
  const groups=new Map();
  for(const a of attempts) {
    const k=`${a.name}\0${a.key || `unattributed:${a.worktree||''}`}`;
    if(!groups.has(k))groups.set(k,[]);groups.get(k).push(a);
  }
  const seats=[],unknown=[];
  for(const list of groups.values()) {
    list.sort((x,y)=>(Date.parse(y.startedAt)||-Infinity)-(Date.parse(x.startedAt)||-Infinity));
    const newest=list[0],open=list.find(a=>!PROVEN.has(a.state)),lead=open||newest;
    const id=newest.id || (newest.startedAt?buildLaunchRecord({name:newest.name,startedAt:newest.startedAt,endedAt:newest.startedAt}).launchId:newest.name);
    seats.push({id,name:newest.name,startedAt:newest.startedAt,stream:newest.stream,worktree:newest.worktree,
      ended:!open,state:lead.state,reason:lead.reason,runtime:directory,attempts:list.length});
  }
  for(const a of attempts)if(!PROVEN.has(a.state)) {
    const source=a.id || (a.startedAt?`${a.name}@${a.startedAt}`:a.name);
    unknown.push(a.key?{scope:'seat',seat:a.name,worktree:a.key,source,reason:a.reason}
      :{scope:'unattributed',seat:a.name,worktree:null,source,reason:a.reason});
  }
  // A pulse of a name without markers, a process that names a path it
  // cannot resolve, and a process that launches a seat (--name) with no attempt here
  // could be on any worktree. A process inside a worktree (cwd or path argument)
  // blocks that worktree whatever the seats say.
  for(const p of pulses)if(!names.includes(p.name))unknown.push({scope:'unattributed',seat:p.name,worktree:null,source:p.file,reason:'seat-heartbeat-without-marker'});
  const inTree=new Map();
  rows.forEach((row,i)=>{
    const v=views[i],source=`process:${v.pid}`;
    if(v.unresolved)unknown.push({scope:'unattributed',seat:null,worktree:null,source,reason:`process-path-${v.unresolved}`});
    for(const name of launched(row?.cmd))if(!names.includes(name) && !byName.has(name))
      unknown.push({scope:'unattributed',seat:name,worktree:null,source,reason:'seat-live-process'});
    if(v.cwd && !inTree.has(v.cwd))inTree.set(v.cwd,source);
    // The line itself: an entry whose normalised texts (line and cwd) are kept out of
    // every report (a command line may carry a secret); blocks() asks it about one worktree.
    if(v.texts.length)unknown.push(Object.defineProperty({scope:'process',seat:null,worktree:null,source,reason:'tree-live-process'},'view',{value:{texts:v.texts,cwds:v.cwds}}));
  });
  for(const [k,source] of inTree)unknown.push({scope:'tree',seat:null,worktree:k,source,reason:'tree-live-process'});
  if(history.invalid)unknown.push({scope:'input',source:'ledger',reason:'invalid-launch-records',count:history.invalid});
  return {seats,unknown,records,attempts};
}
function emptyRetention(){return {entries:[],planHash:null,keptMarkerRefused:{count:0,sample:[]},skippedTooRecent:0,foreign:{count:0,sample:[]}};}
function readableTree(dir) {
  // Retention's scan tolerates disappearing/unreadable entries. C8 exposes that
  // uncertainty instead of promoting a partial inventory to an apply request.
  for(const name of fs.readdirSync(dir)) {
    const file=path.join(dir,name),st=fs.lstatSync(file);
    if(st.isDirectory() && !st.isSymbolicLink())readableTree(file);
  }
}
function collect(o={},deps={}) {
  const repo=path.resolve(o.repo||ROOT),at=o.now||new Date().toISOString();
  if(require('./ledger.cjs').isoProblem(at))reader.refuse('usage');
  const now=Date.parse(at),directory=path.resolve(o.seats||path.join(repo,'.ai/runtime'));
  const unknown=[];let candidates=[],history={recs:[],byId:new Map()},found={seats:[],unknown:[]},retirePlan={entries:[]},tempPlan=emptyRetention(),trees=[];
  // Input-level unknowns are global; retention's own unknowns gate retention only.
  const attempt=(source,fn,fallback)=>{try{return fn();}catch(e){unknown.push({scope:source==='retention'?'retention':'input',source,reason:e.code||e.message||'unreadable'});return fallback;}};
  candidates=attempt('registry',()=>registry.parseRegistry(reader.readText(o.registry||path.join(repo,'.ai/runtime/CANDIDATES.md'),'registry')).rows.map(r=>r.cells),[]);
  history=attempt('ledger',()=>inputs.history(o.journal||path.join(repo,...require('../../.ai/bin/repo-paths.cjs').CATALOG_LAUNCHES,'LAUNCHES.jsonl')),history);
  // The process table, without this tool and its ancestors (their command lines
  // name the seat and the worktree they act on). An unreadable table is global.
  const rows=attempt('processes',()=>{
    const table=(deps.processes||retire.processes)();
    if(!Array.isArray(table))reader.refuse('process-table-unknown');
    return deps.processes?table:retire.withoutSelf(table);
  },[]);
  found=attempt('seats',()=>seatRecords(directory,history,now,deps.probe,rows),found);unknown.push(...found.unknown);
  const records=found.records||[];
  trees=attempt('worktrees',()=>retire.worktrees(repo),[]);
  retirePlan=attempt('auto-retire',()=>retire.run({repo,plan:true,now}),retirePlan);
  tempPlan=attempt('retention',()=>{
    const roots=retention.resolveRoots([],process.env,repo);
    for(const r of roots)fs.readdirSync(r.dir); // unreadable root never silently means empty
    const planned=retention.makePlan({roots,patterns:retention.loadPatterns(retention.PATTERNS_FILE),ageHours:24,now});
    for(const e of planned.entries)readableTree(path.join(e.root,e.name));
    return planned;
  },tempPlan);
  const main=trees[0]?.path,workArea=path.resolve(o['work-area']||(main?path.join(path.dirname(main),path.basename(main)+'WT'):path.dirname(repo)));
  const snapshot={repo,repoRoot:repo,at,workArea,runtime:directory,candidates,history,trees,seats:found.seats,records,retire:retirePlan,retention:tempPlan,unknown};
  for(const seat of snapshot.seats)seat.copy=seat.ended
    ? (deps.describe||require('./lifecycle-copy.cjs').describe)(seat,snapshot)
    : {state:'unknown',reason:seat.reason};
  return snapshot;
}
// Scope of an unknown entry: input-level (or unscoped) entries and unattributed
// attempts block every effect; a seat entry blocks only that seat (name, worktree)
// and the worktree it names.
const isGlobal=e=>!e.scope || e.scope==='input' || e.scope==='unattributed';
// A caller that asks many questions of one snapshot
// passes one keyOf, so each spelling is resolved once per call, not once per pair.
const sameBy=(keyOf,a,b)=>{const x=keyOf(a),y=keyOf(b);return x.ok && y.ok && x.key===y.key;};
function blocks(e,seat,keyOf=paths.key) {
  if(isGlobal(e))return true;
  // A process inside a worktree blocks that worktree (segment boundary).
  if(e.scope==='tree'){const k=seat.worktree?keyOf(seat.worktree):null;return Boolean(k && k.ok && paths.within(k.key,e.worktree));}
  // A process line blocks the worktree its normalised texts name; an
  // entry that lost its texts (a copy) blocks every worktree it is asked about.
  if(e.scope==='process'){const k=seat.worktree?keyOf(seat.worktree):null;return Boolean(k && k.ok && (!e.view || contains(e.view,k.key)));}
  if(e.scope!=='seat')return false;
  if(e.seat===seat.name && (!e.worktree || !seat.worktree || sameBy(keyOf,e.worktree,seat.worktree)))return true;
  return Boolean(e.worktree && seat.worktree && sameBy(keyOf,e.worktree,seat.worktree));
}
const memoKey=()=>{const memo=new Map();return v=>{if(!memo.has(v))memo.set(v,paths.key(v));return memo.get(v);};};
module.exports={seatRecords,collect,blocks,isGlobal,memoKey,SEAT_STATES,RECORD_STATES,HISTORICAL_MS,SKEW_MS};

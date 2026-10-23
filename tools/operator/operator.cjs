#!/usr/bin/env node
'use strict';
const path=require('node:path');
const S=require('./state.cjs');
const seats=require('./seats.cjs');
const landing=require('./landing.cjs');
const {closedInteger}=require('./closed-number.cjs');
const COMMANDS=['seat','pair','verdicts','land','publish','close','watch','wake','status','task','operate','retire'];
const COMMON=['--repo','--workspace'];
const WATCH_FLAGS=['--contract','--dry-run','--timeout','--wake'];
const ASSIGN_FLAGS=['--assignment','--task','--auto','--client','--model','--reason','--catalog-root','--feedback'];
const SEAT_FLAGS=[...COMMON,...WATCH_FLAGS,...ASSIGN_FLAGS];
const PAIR_FLAGS=[...SEAT_FLAGS,'--certifiers','--super-important'];
const TASK_FLAGS=[...COMMON,'--out','--role','--kind','--verification','--coupling','--super-important','--tokens','--lineage','--route-states','--seats','--attempt-id','--base'];
const OPERATE_FLAGS=[...COMMON,'--owner','--release','--takeover','--reason','--note','--dry-run'];
const BOOLS=['--dry-run','--wake','--auto','--super-important','--release','--retire'];
function flags(o,rest,allowed) {
  for(let i=0;i<rest.length;i++) {
    const key=rest[i];
    if(!allowed.includes(key) || Object.hasOwn(o,key.slice(2))) S.fail('usage');
    if(BOOLS.includes(key)) o[key.slice(2)]=true;
    else { if(!rest[i+1] || rest[i+1].startsWith('--')) S.fail('usage'); o[key.slice(2)]=rest[++i]; }
  }
}
function options(argv) {
  const [command,...rest]=argv;
  if(!COMMANDS.includes(command)) S.fail('usage');
  const o={command};
  if(command==='task') {
    if(!rest.length || rest[0].startsWith('--')) S.fail('usage');
    S.id(rest[0]); o.package=rest[0];
    flags(o,rest.slice(1),TASK_FLAGS);
    if(!o.out || !o.role) S.fail('usage');
    return o;
  }
  if(command==='operate') {
    flags(o,rest,OPERATE_FLAGS);
    if(!o.owner) S.fail('usage');
    S.id(o.owner);
    return o;
  }
  flags(o,rest,command==='pair'?PAIR_FLAGS:command==='seat'?SEAT_FLAGS:command==='land'?[...COMMON,...WATCH_FLAGS,'--retire']:[...COMMON,...WATCH_FLAGS]);
  if(o.timeout!==undefined) { const t=closedInteger(o.timeout,'invalid-timeout'); if(t<1||t>360000) S.fail('invalid-timeout'); }
  if(['seat','pair'].includes(command)) {
    if((o.assignment||o.auto) && !o.task) S.fail('task-required');
    if(o.assignment && o.auto) S.fail('usage');
    // The assignment flags mean something only in the assignment modes: on the
    // classic path they would be parsed and silently ignored. The closed
    // grammar refuses them instead of accepting a no-op.
    if(!(o.assignment||o.auto) && ['task','client','model','reason','catalog-root','feedback'].some(k=>o[k]!==undefined)) S.fail('assignment-mode-required');
    if(o.client!==undefined && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(o.client)) S.fail('invalid-client');
    if(o.model!==undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(o.model)) S.fail('invalid-model');
    if(command==='pair') {
      if(o.client!==undefined || o.model!==undefined || o.reason!==undefined) S.fail('pair-deviation-unsupported');
      if(o.certifiers!==undefined) {
        const c=closedInteger(o.certifiers,'certifiers-invalid');
        if(c<2||c>4) S.fail('certifiers-invalid');
        if(c===4&&!o['super-important']) S.fail('super-important-required');
      }
    }
  }
  return o;
}
function table(ctx,selected) {
  const s=ctx.load();
  const names=selected || Object.keys(s.seats);
  return names.map(raw=>{ const id=S.id(S.seatKey(raw)); if(!s.seats[id]) S.fail('unknown-seat'); return seats.reportStatus(ctx,s.seats[id]); });
}
function diagnosticToken(value,fallback) {
  // Errors may carry foreign messages or credentials. Emit bounded codes only,
  // through the same privacy guard used by assignment feedback, never raw text.
  if(typeof value!=='string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(value)) return fallback;
  try { require('../assign/io.cjs').publicValue(value); return value; }
  catch { return fallback; }
}
function pairDiagnostics(result,emit) {
  if(!result.results || !result.results.some(r=>!r.verdict)) return false;
  // The contract caps pairs at four seats. Keep the output independently bounded
  // and keep the aggregate exit/reason contract unchanged for existing callers.
  for(const row of result.results.slice(0,4)) {
    const seat = diagnosticToken(row.seat,'unknown-seat');
    const reason = diagnosticToken(row.reason,'seat-failed');
    const verdict = ['PASS','FAIL','BLOCKED','RECOMMENDATION'].includes(row.verdict)?row.verdict:'UNKNOWN';
    emit(`PAIR_SEAT seat=${seat} verdict=${verdict} reason=${reason}`);
  }
  return true;
}
async function main(argv,emit=line=>process.stdout.write(line+'\n')) {
  let code=0,reason='ok';
  try {
    // Same closed retire grammar and content proof as the standalone command.
    if(argv[0]==='retire') S.fail('retirement-not-shipped');
    const o=options(argv);
    const ctx=S.createContext({repo:o.repo,workspace:o.workspace});
    ctx.acceptPair=id=>seats.acceptPair(ctx,id);
    ctx.seatStatus=id=>{id=S.id(S.seatKey(id));const s=ctx.load();return s.seats[id]?seats.reportStatus(ctx,s.seats[id]):{done:false,running:false};};
    const bridge=require('./assign-bridge.cjs');
    // Operator files follow the contract rule: relative paths are relative to
    // the workspace, absolute paths stay absolute.
    const rel=v=>v===undefined?undefined:(path.isAbsolute(v)?v:path.join(ctx.workspace,v));
    if(o.command==='operate') {
      await require('./operate.cjs').operate(ctx,{owner:o.owner,release:Boolean(o.release),takeover:o.takeover,reason:o.reason,note:o.note,dryRun:Boolean(o['dry-run'])},emit);
    } else if(o.command==='task') {
      const built=bridge.buildTaskRequest(ctx,{packageId:o.package,role:o.role,kind:o.kind,verification:o.verification,coupling:o.coupling,superImportant:!!o['super-important'],tokens:o.tokens,base:o.base,lineageFile:rel(o.lineage),routeStatesFile:rel(o['route-states']),seats:o.seats,attemptId:o['attempt-id'],out:rel(o.out)});
      for(const line of built.lines) emit(line);
    } else {
      const c=o.contract?ctx.json(ctx.workspace,o.contract):null;
      if(['seat','pair','land','publish','close'].includes(o.command) && !c) S.fail('contract-required');
      if(o.command==='seat' && (o.assignment||o.auto)) {
        const prepared=bridge.prepareLaunch(ctx,{requestFile:rel(o.task),assignmentFile:rel(o.assignment),drafts:[c],
          override:{client:o.client,model:o.model},reason:o.reason,catalogRoot:rel(o['catalog-root']),
          feedbackRoot:rel(o.feedback),dryRun:!!o['dry-run'],pair:false});
        for(const line of prepared.lines) emit(line);
        await bridge.executePrepared(ctx,prepared,locked=>seats.runSeat(locked,prepared.contracts[0],Boolean(o['dry-run']),null,prepared.metas[0]));
      } else if(o.command==='seat') await seats.runSeat(ctx,c,Boolean(o['dry-run']));
      else if(o.command==='pair' && (o.assignment||o.auto)) {
        const count=o.certifiers!==undefined?closedInteger(o.certifiers,'certifiers-invalid'):(o['super-important']?4:2);
        if(c.seats.length!==count) S.fail('certifiers-mismatch');
        const prepared=bridge.prepareLaunch(ctx,{requestFile:rel(o.task),assignmentFile:rel(o.assignment),drafts:c.seats,
          override:null,reason:null,catalogRoot:rel(o['catalog-root']),feedbackRoot:rel(o.feedback),dryRun:!!o['dry-run'],pair:true,pairContract:c});
        for(const line of prepared.lines) emit(line);
        const result=await bridge.executePrepared(ctx,prepared,locked=>seats.runPair(locked,{...c,seats:prepared.contracts},Boolean(o['dry-run']),prepared.metas));
        if(pairDiagnostics(result,emit)) {code=3;reason='pair-incomplete';} // auto
      } else if(o.command==='pair') {
        // The rule holds on EVERY pair launch, the classic contract
        // included: four seats need --super-important, and the count flags are
        // honoured, never silently dropped. The
        // contract's own seat count is the request; a flag that disagrees
        // with it is a refusal.
        if(c.seats.length===4 && !o['super-important']) S.fail('super-important-required');
        const expected=o.certifiers!==undefined?closedInteger(o.certifiers,'certifiers-invalid'):(o['super-important']?4:c.seats.length);
        if(c.seats.length!==expected) S.fail('certifiers-mismatch');
        const result=await seats.runPair(ctx,c,Boolean(o['dry-run']));
        if(pairDiagnostics(result,emit)) {code=3;reason='pair-incomplete';} // classic
      } else if(o.command==='land') await landing.land(ctx,c,Boolean(o['dry-run']),Boolean(o.retire));
      else if(o.command==='publish') {
        const published=await landing.publishLanding(ctx,c,Boolean(o['dry-run']));
        emit(`publication=${published.status} retirement=${published.retirement?.reason || published.retirement?.entries?.length || 0}`);
      }
      else if(o.command==='close') await landing.close(ctx,c,Boolean(o['dry-run']));
      else {
        if(c) {S.keys(c,['seats'],['seats']);if(!Array.isArray(c.seats) || !c.seats.length) S.fail('invalid-watch');c.seats.forEach(id=>S.id(S.seatKey(id)));}
        let rows=table(ctx,c&&c.seats);
        if((o.command==='wake' || o.wake) && !o['dry-run']) {
          if(!c) S.fail('named-seats-required');
          const until=Date.now()+(o.timeout!==undefined?closedInteger(o.timeout,'invalid-timeout'):60000);
          while(rows.some(r=>!r.done) && Date.now()<until) {await new Promise(resolve=>setTimeout(resolve,Math.min(500,until-Date.now())));rows=table(ctx,c.seats);}
          if(rows.some(r=>!r.done)) {code=4;reason='timeout';}
          await ctx.transaction('registry',async()=>ctx.write(ctx.stateRoot,'watch.json',{rows,checkedAt:new Date().toISOString()}));
        }
        emit('seat verdict lines state');
        for(const r of rows) emit(`${S.id(r.seat)} ${r.verdict||'UNKNOWN'} ${r.lines===null?'unknown':r.lines} ${r.done?'done':r.running?'running':'unknown'}`);
        if(o.command==='status') {
          const s=ctx.load();
          emit(`candidates=${Object.keys(s.candidates).length} seats=${rows.length} open-pairs=${Object.values(s.pairs).filter(p=>p.status==='open').length} pending-landings=${Object.values(s.landings).filter(l=>l.status!=='closed').length}`);
          for(const [stream,candidate] of Object.entries(s.candidates)) emit(`candidate ${S.id(stream)} ${S.branch(candidate.branch)} ${S.sha(candidate.sha)} ${['building','ready','certifying','certified','landed','retired','superseded','void'].includes(candidate.status)?candidate.status:'unknown'}`);
          for(const [id,pair] of Object.entries(s.pairs)) emit(`pair ${S.id(id)} ${pair.status==='open'?'open':'closed'}`);
          for(const [id,l] of Object.entries(s.landings)) emit(`landing ${S.id(id)} ${['preparing','ready','landed-local','closing','closed','blocked'].includes(l.status)?l.status:'unknown'}`);
        }
      }
    }
  } catch(e) { code=e.code==='usage'?2:3; reason=/^[A-Za-z][A-Za-z0-9_-]{0,79}(?::[A-Za-z0-9_./-]{1,120})?$/.test(e.code||e.message)?(e.code||e.message):'operation-refused';
    // The ask-owner refusal prints the recommendation it stopped on
    //The lines ride the error, nothing else changes.
    if(Array.isArray(e.lines)) for(const line of e.lines) emit(line); }
  emit(`RESULT exit=${code} reason=${reason}`);
  return code;
}
if(require.main===module) main(process.argv.slice(2)).then(code=>{process.exitCode=code;});
module.exports={main,options,table,pairDiagnostics,COMMANDS};

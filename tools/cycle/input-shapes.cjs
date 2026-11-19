'use strict';
// Validate before any dereference, path operation, liveness or terminal shortcut.
const reader=require('./reader.cjs');
const ledger=require('./ledger.cjs');
const {event}=require('./event-shape.cjs');
// The accepted fields are the lists of what the launch wrapper writes into each record kind; any other field is refused.
const {RECORD_FIELDS}=require('../../.ai/bin/lib/seat-slots.cjs');
const object=v=>v!==null && typeof v==='object' && !Array.isArray(v);
function tempDir(value) {
  // Real legacy terminals retain the string from the running marker. New
  // terminals replace it with finishLaunchTmp's disposition object.
  if(typeof value==='string')return Boolean(value.trim());
  if(!object(value) || Object.keys(value).some(k=>!['path','action','reason','keepUntil'].includes(k)))return false;
  return typeof value.path==='string' && Boolean(value.path.trim()) &&
    ['kept','gone','removed'].includes(value.action) &&
    (value.reason===null || typeof value.reason==='string') &&
    (value.keepUntil===null || typeof value.keepUntil==='string' && !ledger.isoProblem(value.keepUntil));
}
function marker(value, kind='running') {
  const code=kind==='terminal'?'terminal-schema':'seat-schema';
  if(!object(value))reader.refuse(code);
  const strings=['name','stream','startedAt','owner','command','worktree'];
  const booleans=['certifier','cycleStop'];
  const pids=['childPid','wrapperPid'];
  for(const [key,v] of Object.entries(value)) {
    if(['client','model'].includes(key) && v!==null && (typeof v!=='string' || !v.trim()))reader.refuse(code);
    if(strings.includes(key) && (typeof v!=='string' || !v))reader.refuse(code);
    if(booleans.includes(key) && typeof v!=='boolean')reader.refuse(code);
    if(pids.includes(key) && v!==null && (!Number.isSafeInteger(v) || v<=0))reader.refuse(code);
    if(key==='resolver' && v!==null && !object(v))reader.refuse(code);
    if(key==='head' && v!==null && (typeof v!=='string' || !/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(v)))reader.refuse(code);
    if(['candidateBefore','candidateShaUpdate'].includes(key) && v!==null && !object(v))reader.refuse(code);
    if(key==='tempDir' && !tempDir(v))reader.refuse(code);
    if(key==='routeGate' && v!==null && (!object(v) || typeof v.schema!=='string' || !v.schema.startsWith('route-gate/')))reader.refuse(code);
    if(key==='ended' && v!==false && (typeof v!=='string' || ledger.isoProblem(v)))reader.refuse(code);
    if(!RECORD_FIELDS[kind==='terminal'?'terminal':'running'].includes(key))reader.refuse(code);
  }
  if(typeof value.name!=='string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value.name))reader.refuse(code);
  if(kind==='running' && (typeof value.stream!=='string' || !value.stream || typeof value.startedAt!=='string' || ledger.isoProblem(value.startedAt)))reader.refuse(code);
  if(kind==='terminal') {
    if(typeof value.endedAt!=='string' || ledger.isoProblem(value.endedAt) ||
      value.startedAt!==undefined && ledger.isoProblem(value.startedAt))reader.refuse(code);
    for(const [key,v] of Object.entries(value)) {
      if(key==='status' && !['DONE','FAILED'].includes(v))reader.refuse(code);
      if(key==='exitCode' && v!==null && !Number.isSafeInteger(v))reader.refuse(code);
      if(['signal','failureClass','reason','note','usage','seatRoute'].includes(key) && v!==null && typeof v!=='string')reader.refuse(code);
      if(key==='wallSeconds' && (typeof v!=='number' || !Number.isFinite(v) || v<0))reader.refuse(code);
      if(key==='lastLines' && (!Array.isArray(v) || v.some(line=>typeof line!=='string')))reader.refuse(code);
    }
  }
  if(value.resolver) {
    if(value.resolver.operator!==undefined && !object(value.resolver.operator))reader.refuse('seat-affiliation');
    for(const v of [value.resolver.operator?.client,value.resolver.role])if(v!==undefined && v!==null && (typeof v!=='string' || !v.trim()))reader.refuse('seat-affiliation');
  }
  return value;
}
function output(value) {
  if(typeof value!=='string' || value.includes('\0'))reader.refuse('launch-output-invalid');
  return value;
}
module.exports={event,marker,output};

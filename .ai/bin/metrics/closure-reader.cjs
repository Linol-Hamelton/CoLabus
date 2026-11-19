'use strict';
// One closure-ledger grammar for M-010 and M-011. Container errors are named;
// decoded identity fields are refused before trim or UTF-8 replacement can hide data.
const fs = require('node:fs');
const crypto = require('node:crypto');
const textSafe = require('../lib/text-safe.cjs');
const {exceptionRefusal}=require('./refused-package.cjs');
const SOURCE_ISSUE = Symbol('closure-source-issue'), SOURCE_LINE = Symbol('closure-source-line');
// JSON objects are ordered records: render preserves their parsed member order,
// with JSON.stringify's unique minimal escaping and number representation.
function render(row) { return JSON.stringify(row); }

function readJsonlUnsafe(file) {
  const buf = fs.readFileSync(file);
  const d = textSafe.decode(buf, { bom: 'strip', crlf: 'normalise' });
  if (!d.ok) {
    const p=d.problems[0];
    throw Object.assign(Error('source-undecodable'),{sourceReason:'source-undecodable',line:p.line||(p.index===undefined?null:buf.subarray(0,p.index).toString('utf8').split('\n').length)});
  }
  const rows = [];
  const lines=buf.toString('utf8').split('\n');
  lines.forEach((line, i) => {
    if (i===lines.length-1&&line==='') return;
    let o;
    try { o = textSafe.parseJsonUnique(line); }
    catch { o = { [SOURCE_ISSUE]: 'source-invalid-json' }; }
    if (!o || typeof o !== 'object' || Array.isArray(o)) o = { [SOURCE_ISSUE]: 'source-invalid-row' };
    try{if(!o[SOURCE_ISSUE]&&(render(o)!==line||i===lines.length-1))o[SOURCE_ISSUE]='round-trip-jsonl';}
    catch{ o={ [SOURCE_ISSUE]:'source-render-exception' }; }
    Object.defineProperty(o,SOURCE_LINE,{value:i+1});
    rows.push(o);
  });
  return { rows, bytes: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}
function readJsonl(file) {
  try{return readJsonlUnsafe(file);}
  catch(e){
    const refusal=exceptionRefusal(e);
    const rows=[];rows.sourceRefusal=refusal;return {rows,sourceRefusal:refusal};
  }
}

function readableId(value) {
  // Receipt/frame identity is ASCII, exact, never trimmed or normalised. The real
  // CLOSURES.jsonl needs no exception to this grammar. Commit locators are not ids.
  return typeof value === 'string' && /^[A-Z][A-Z0-9]*(-[A-Z0-9]+)+$/.test(value);
}
function readableCommit(value) {
  return typeof value === 'string' && textSafe.decodeText(value,{invisible:'refuse'}).ok && /^[a-f0-9]{1,40}$/.test(value);
}
function receiptOf(r) { return readableId(r.receipt) ? r.receipt : null; }
function closureOf(r) {
  const receipt = receiptOf(r);
  if (receipt === null) return { reason: 'receipt-unreadable' };
  if (!readableId(r.frame)) return { reason: 'receipt-without-frame' };
  return { receipt, frame: r.frame, reason: null };
}
function fieldIssues(r) {
  const issues=[], c=closureOf(r);
  if(c.reason)issues.push(c.reason);
  for(const key of ['dangling_refs','competing_authority'])
    if(!Number.isSafeInteger(r[key])||r[key]<0)issues.push('leak-count-unknown');
  if(!Number.isSafeInteger(r.dangling_refs+r.competing_authority))issues.push('leak-count-unknown');
  for(const key of ['active_bytes_before','active_bytes_after'])
    if(Object.hasOwn(r,key)&&(!Number.isSafeInteger(r[key])||r[key]<0))issues.push(key);
  if(r.closure_commit!=null&&!readableCommit(r.closure_commit))issues.push('closure-commit-unreadable');
  const validStrings=v=>{
    if(typeof v==='string')return textSafe.decodeText(v).ok;
    return !v||typeof v!=='object'||Object.entries(v).every(([k,x])=>textSafe.decodeText(k).ok&&validStrings(x));
  };
  if(!validStrings(r))issues.push('decoded-string-unreadable');
  return [...new Set(issues)];
}
function closureIssues(rows) {
  const seen=new Map(), conflicts=new Set(), duplicates=new Set(), issues=[];
  for(const r of rows) {
    const id=receiptOf(r); if(id===null)continue;
    const signature=JSON.stringify([r.frame,r.dangling_refs,r.competing_authority,r.active_bytes_before,r.active_bytes_after]);
    if(seen.has(id)){duplicates.add(id);if(seen.get(id)!==signature)conflicts.add(id);}else seen.set(id,signature);
  }
  rows.forEach((r,i)=>{
    const row=r[SOURCE_LINE]||i+1;
    if(r[SOURCE_ISSUE])issues.push({field:'value',row,line:row,reason:'non-canonical-input',detail:r[SOURCE_ISSUE]});
    const c=closureOf(r);
    try{for(const detail of fieldIssues(r))issues.push({field:'value',row,line:row,reason:'non-canonical-input',detail});}
    catch{throw Object.assign(Error('source-exception'),{line:row});}
    if(conflicts.has(c.receipt))issues.push({field:'value',row,line:row,receipt:c.receipt,reason:'non-canonical-input',detail:'conflict'});
    else if(duplicates.has(c.receipt))issues.push({field:'value',row,line:row,receipt:c.receipt,reason:'non-canonical-input',detail:'duplicate-receipt'});
    for(const key of ['dangling_refs','competing_authority','active_bytes_before','active_bytes_after']) if(Object.hasOwn(r,key)&&(!Number.isSafeInteger(r[key])||r[key]<0)) issues.push({field:'value',row,line:row,reason:'non-canonical-input',detail:key});
  });
  return {issues,conflicts};
}
function lineOf(row,index) {return row[SOURCE_LINE]||index+1;}
module.exports = { readJsonl, render, readableId, readableCommit, receiptOf, closureOf, closureIssues, fieldIssues, lineOf };

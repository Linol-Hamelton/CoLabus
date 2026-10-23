'use strict';
// M-010 canonical source: ONLY ## Frames and ## Counters (optional parenthesised
// title annotation), until the next column-zero level-1/2 ATX heading. All other
// sections are out of scope. One column-zero GFM table per section; no prose or
// Markdown containers. Outer empty separator lines are outside the data region.
// The table bytes, including line endings, must equal render(parse(table)).
const fs = require('node:fs'), crypto = require('node:crypto');
const ts = require('../lib/text-safe.cjs');
const {exceptionRefusal}=require('./refused-package.cjs');
const HEADERS = {
  Frames: ['ID','Frame','Path','Stream','Size','Status','Round','Opened','Gate owner','Verdict','Record','Suspension: reason; resume; responsible; review date'],
  Counters: ['Counter','Value','As of','Source'],
};
const COUNTERS = ['DIG','DIG_FLOOR','DEFERRED_ACCEPTED','DEFER backlog / cap','Candidates / cap','RER at last gate','Frames closed under P-L0-008 (trial: 5)','Closed frames without a receipt'];
const STATUS = /^(CANDIDATE|ACTIVE|BLOCKED|SUSPENDED|CLOSED|TRANSITION-PENDING|not a frame)(?: \([^\n]*\))?$/;
const cells = line => /^\|[^\n]*\|[ \t]*$/.test(line) ? line.trimEnd().slice(1,-1).split('|').map(s=>s.trim()) : null;
// Closed per-column grammar. Punctuation in prose terminates a token; paths
// are relative docs/ paths. Counter names are the exact closed vocabulary above.
const plain = s => /^[A-Za-z0-9 .,;:/()'-]+$/.test(s)&&/^(?:[^.:]|[.:](?= |$))*$/.test(s);
// A trailing slash is a directory marker, never an empty interior segment.
// Reject Windows aliases as well, although this descriptive field is not opened.
const docsPath = s => /^docs\/(?:[A-Za-z0-9._-]+\/)*[A-Za-z0-9._-]+\/?$/.test(s)&&
  s.replace(/\/$/,'').split('/').every(part=>part!=='.'&&part!=='..'&&!part.endsWith('.')&&!/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part));
const allowedCells = (region,c) => c.every((s,i)=>{
  if(region==='Counters'&&i===0)return COUNTERS.includes(s);
  if(region==='Frames'&&[0,3].includes(i))return /^[A-Z0-9-]+$/.test(s);
  if(region==='Frames'&&i===2)return s==='-'||docsPath(s);
  return plain(s);
});
function render(name, rows) {
  const row = c => {
    if(c.some(s=>/[\\|\t\r\n]/.test(s)))throw Error('unrenderable-cell');
    return '| ' + c.map(s=>String(s).trim()).join(' | ') + ' |\n';
  };
  return row(HEADERS[name]) + row(HEADERS[name].map(()=>'---')) + rows.map(row).join('');
}
function parseFramesUnsafe(file) {
  const buf = fs.readFileSync(file), d = ts.decode(buf, {bom:'strip',crlf:'normalise'});
  if (!d.ok) {
    const p=d.problems[0];
    throw Object.assign(Error('source-undecodable'),{sourceReason:'source-undecodable',line:p.line||(p.index===undefined?null:buf.subarray(0,p.index).toString('utf8').split('\n').length)});
  }
  const lines = d.text.split('\n'), originalLines=buf.toString('utf8').split('\n'), frames = [], counters = {}, unknowns = [], unknownUnits = [], canonicalDifferences=[], semanticRows=[];
  const seenSections = new Set(), seenFrames = new Map(), seenCounters = new Map();
  let region = null, stage = 0, candidates = 0, start=0, parsedRows=[], rowPositions=[], headerAt, delimiterAt;
  const bad = (line, field = 'value', detail = 'line-format') => {
    const physicalLines=originalLines.length-(originalLines.at(-1)===''?1:0);
    line=physicalLines?Math.max(1,Math.min(line,physicalLines)):null;
    const u = {field,line,reason:'non-canonical-input',detail}; unknowns.push(u); unknownUnits.push(u);
  };
  function finish(line) {
    if(!region)return;
    if(stage < 2) bad(line, 'value', 'missing-table:' + region);
    let a=start,b=line-1;
    while(a<b&&originalLines[a]==='')a++;
    while(b>a&&originalLines[b-1]==='')b--;
    let expected;
    try{expected=render(region,parsedRows).split('\n').slice(0,-1);}catch{throw Object.assign(Error('source-exception'),{line:a+1});}
    const expectedByLine=new Map([headerAt,delimiterAt,...rowPositions].map((at,index)=>[at,expected[index]+'\n']));
    for(let j=0;j<b-a;j++) {
      const physical=a+j+1, raw=originalLines[a+j];
      const actual=a+j<b?raw+(a+j<originalLines.length-1?'\n':''):undefined;
      if(actual!==expectedByLine.get(a+j)) {
        canonicalDifferences.push({region,line:physical});
        if(!unknownUnits.some(u=>u.line===physical))bad(physical,'value','round-trip:'+region);
      }
    }
  }
  for(let i=0;i<lines.length;i++) {
    const raw = lines[i], line = i+1;
    try {
    if (/^\ufeff?#{1,2} /.test(raw)) {
      const heading=raw.replace(/^\ufeff/,'');
      const malformed=originalLines[i]!==heading||i===originalLines.length-1;
      if(region&&malformed)bad(line,'value','heading-bytes');
      finish(line);
      const h = /^## (Frames|Counters)(?: \([^\n()]+\))?[ \t]*$/.exec(heading);
      region = h ? h[1] : null; stage = 0;start=i+1;parsedRows=[];rowPositions=[];headerAt=undefined;delimiterAt=undefined;
      if(region) { if(malformed)bad(line,'value','heading-bytes'); if(seenSections.has(region)) bad(line,'value','duplicate-section'); seenSections.add(region); }
      continue;
    }
    if(!region || /^[ \t]*$/.test(raw)) continue;
    const c = cells(raw), header = HEADERS[region];
    let decoded;
    decoded=ts.decodeText(raw,{invisible:'refuse'});
    if(!decoded.ok || /[\\\t]/.test(raw) || !c || c.length !== header.length || stage===2&&!allowedCells(region,c)) { candidates++; bad(line); continue; }
    if(stage === 0) {
      if(JSON.stringify(c) !== JSON.stringify(header)) { candidates++; bad(line,'value','header'); }
      else {stage = 1;headerAt=i;}
      continue;
    }
    if(stage === 1) {
      if(!c.every(s=>/^:?-{3,}:?$/.test(s))) { candidates++; bad(line,'value','separator'); }
      else {stage = 2;delimiterAt=i;}
      continue;
    }
    candidates++;
    parsedRows.push(c);
    rowPositions.push(i);
    semanticRows.push({region,c,line});
    }catch(e){const failure=exceptionRefusal(e,line);throw Object.assign(Error(failure.reason),{sourceReason:failure.reason,line:failure.firstOffendingLine});}
  }
  finish(lines.length+1);
  // Field-contract validation follows byte comparison for every declared region.
  for(const {region,c,line} of semanticRows) {
    if(region === 'Frames') {
      const [id,,p,stream,,statusCell] = c, st = STATUS.exec(statusCell);
      if(!/^F-[0-9]{2}$/.test(id) || !['S1','S2','S3','-'].includes(stream) || !st || c.some(s=>s==='')) { bad(line,id || 'value','frame-row'); continue; }
      const signature = JSON.stringify(c);
      if(seenFrames.has(id)) {
        bad(line,id,'duplicate-id');
        if(seenFrames.get(id) !== signature) { bad(line,id,'conflict'); const prev=frames.find(f=>f.id===id); prev.status=null; prev.openState=false; prev.closedState=false; unknowns.push({field:id,line,reason:'conflict'}); }
        continue;
      }
      seenFrames.set(id,signature);
      const status=st[1]==='not a frame'?'NOT_A_FRAME':st[1];
      frames.push({id,path:p,stream:stream==='-'?null:stream,status,statusCell,openState:['ACTIVE','BLOCKED','SUSPENDED','TRANSITION-PENDING'].includes(status),closedState:status==='CLOSED'});
    } else {
      const [key,rawValue] = c;
      const m = /^(?:-|([0-9]+)(?: \/ ([0-9]+))?(?: \([^\n]*\))?)$/.exec(rawValue);
      if(!COUNTERS.includes(key) || !m || [m[1],m[2]].some(n=>n!==undefined&&!/^(0|[1-9][0-9]*)$/.test(n)) || m[2]!==undefined&&!['DEFER backlog / cap','Candidates / cap'].includes(key) || c.some(s=>s==='')) { bad(line,key,'counter-row'); continue; }
      if(seenCounters.has(key)) {
        bad(line,key,'duplicate-counter');
        if(seenCounters.get(key) !== rawValue) { counters[key]=null; bad(line,key,'conflict'); unknowns.push({field:key,line,reason:'conflict'}); }
        continue;
      }
      seenCounters.set(key,rawValue);
      const n = m[1]===undefined?null:Number(m[1]);
      if(n!==null && (!Number.isSafeInteger(n) || m[2]!==undefined&&!Number.isSafeInteger(Number(m[2])))) { bad(line,key,'unsafe-integer'); counters[key]=null; unknowns.push({field:key,line,reason:'unsafe-integer'}); }
      else { counters[key]=n; if(n===null) unknowns.push({field:key,line,reason:'counter-unknown'}); }
    }
  }
  for(const name of Object.keys(HEADERS)) if(!seenSections.has(name)) bad(1,'value','missing-section:'+name);
  for(const key of ['DIG','DIG_FLOOR','DEFERRED_ACCEPTED']) if(!Object.hasOwn(counters,key)) { counters[key]=null; unknowns.push({field:key,reason:'counter-absent'}); }
  // First physical offence only: no promise about a count or complete diff.
  const offendingLines=[...new Set(unknownUnits.map(u=>u.line))].sort((a,b)=>a-b).slice(0,1);
  canonicalDifferences.splice(0,canonicalDifferences.length,...canonicalDifferences.filter(d=>d.line===offendingLines[0]));
  const read=Math.max(0,candidates-unknownUnits.filter(u=>!u.detail.startsWith('missing-')&&!['duplicate-section'].includes(u.detail)).length);
  return {frames,counters,unknowns,unknownUnits,canonicalDifferences,candidates:read+unknownUnits.length,read,unknown:unknownUnits.length,nonCanonicalCount:offendingLines.length,offendingLines:offendingLines.slice(0,20),bytes:buf.length,sha256:crypto.createHash('sha256').update(buf).digest('hex'),scope:'Only ## Frames and ## Counters; outer empty separator lines are outside each table data region',format:'render(parse(region)) byte equality; | cell | separators and | --- | delimiter, LF, no escapes or tabs, unique ASCII ids/counters'};
}
function parseFrames(file) {
  try{return parseFramesUnsafe(file);}
  catch(e){return exceptionRefusal(e);}
}
module.exports = {parseFrames,render,HEADERS,COUNTERS,STATUS};

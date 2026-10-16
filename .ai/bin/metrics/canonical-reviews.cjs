'use strict';
// M-001/M-003/M-004/M-005: all files recursively, including archive/R2; no
// extension/date/subdirectory exclusion. Header '# Review\nMode: CERTIFYING',
// final own line 'Verdict: TOKEN'; body opaque but shared verdict reader must
// agree. BOM stripped, CRLF normalised. Invalid review poisons the whole package.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const ts=require('../lib/text-safe.cjs');
const {realInside}=require('../lib/path-safe.cjs');
const {readVerdict}=require('../lib/verdict-read.cjs');
const {exceptionRefusal}=require('./refused-package.cjs');
// Protocol transport/seat identifiers, not executor/model routing assignments.
const KNOWN_SEATS=Object.freeze(['agy','kilo','vibe','glm','mimo','codex','claude','opus','deepseek','qwen','mistral','gemini','sol','fable','ds','gpt']);
const REVIEW_FILE=new RegExp('^(\\d{4}-\\d{2}-\\d{2})-([a-z0-9]+(?:-[a-z0-9]+)*)-('+KNOWN_SEATS.join('|')+')(-op)?\\.md$');
const SCOPE='All files recursively below the supplied review directory, including archive and R2; no exclusions';
const FORMAT='YYYY-MM-DD-slug-seat(-op).md, real calendar date, closed seat list; # Review then Mode: CERTIFYING; final line Verdict: PASS|FAIL|BLOCKED|RECOMMENDATION';
function metadata(name) {
  const m=REVIEW_FILE.exec(name), date=m?.[1];
  const stamp=date?new Date(date+'T00:00:00.000Z'):null;
  const realDate=date && Number(date.slice(0,4))>=1 && Number.isFinite(stamp.getTime()) && stamp.toISOString().slice(0,10)===date;
  return {date:date||'',slug:m?m[2]:name,agent:m?m[3]:'unknown',metadataReadable:!!realDate};
}
function discoverReviewsUnsafe(dir) {
  const root=path.resolve(dir), out=[];
  function visit(relative) {
    const full=path.join(root,relative), guard=realInside(root,relative,{refuseHardlinks:true});
    const name=path.basename(relative), meta=metadata(name);
    const base={...meta,file:relative.replaceAll('\\','/'),text:'',bytes:0,sha256:crypto.createHash('sha256').update('').digest('hex'),verdict:null};
    const invalid=detail=>out.push({...base,candidate:true,classification:'non-canonical',discoveryReason:'non-canonical-input',detail});
    if(!guard.ok) {invalid('path:'+guard.reason);return;}
    const st=fs.lstatSync(full);
    if(st.isDirectory()) {
      if(/\.(md|markdown)$/i.test(name)) invalid('review-shaped-directory');
      for(const n of fs.readdirSync(full).sort()) visit(path.join(relative,n));
      return;
    }
    const buf=fs.readFileSync(full);
    base.bytes=buf.length;base.sha256=crypto.createHash('sha256').update(buf).digest('hex');
    const d=ts.decode(buf,{bom:'strip',crlf:'normalise',invisible:'refuse'});
    if(!d.ok){invalid('source-undecodable');return;}
    base.text=d.text;
    // Named not-a-review rule: neither a dated name nor a review/header/verdict
    // marker anywhere in decoded content. An unfinished dated report is invalid.
    const intent=/^\d{4}-/.test(name)||/review|verdict|overall|result\s*[:=]|вердикт|Mode\s*:/i.test(d.text);
    if(!intent){out.push({...base,candidate:false,classification:'not-a-review',discoveryReason:'not-a-review',rule:'no dated name and no review/header/verdict marker'});return;}
    const close=/\nVerdict: (PASS|FAIL|BLOCKED|RECOMMENDATION)\n?$/.exec(d.text);
    const header=d.text.startsWith('# Review\nMode: CERTIFYING\n');
    const v=readVerdict(d.text);
    if(!meta.metadataReadable||!header||!close||v.token!==close[1]) {invalid(!meta.metadataReadable?'filename':!header?'header':!close?'closing-verdict':'verdict-conflict');return;}
    out.push({...base,candidate:true,classification:'read',verdict:close[1],discoveryReason:null});
  }
  for(const n of fs.readdirSync(root).sort()) visit(n);
  return out;
}
function discoverReviews(dir) {
  try{return discoverReviewsUnsafe(dir);}catch(e){const rows=[];rows.sourceRefusal=exceptionRefusal(e);return rows;}
}
function selectPackage(rows,predicate) {
  if(rows.sourceRefusal)return rows;
  // Date slicing never hides a malformed file; canonical reviews outside the
  // declared window remain in the full walk as named, counted exclusions.
  return rows.map(r=>r.classification==='read'&&predicate&&!predicate(r)?{...r,verdict:null,candidate:false,classification:'excluded-by-declared-scope',rule:'canonical review outside declared date window',discoveryReason:null}:r);
}
function reviewCoverage(rows) {
  const counts={read:0,'non-canonical':0,'not-a-review':0,'excluded-by-declared-scope':0};
  const unknownUnits=[],notAReview=[],excluded=[];
  for(const r of rows) {
    const category=r.classification || (r.verdict!=null?'read':r.candidate===false?'not-a-review':'non-canonical');
    if(!Object.hasOwn(counts,category))throw Error('unclassified-review');counts[category]++;
    if(category==='non-canonical') unknownUnits.push({field:'value',report:r.file,reason:'non-canonical-input',detail:r.detail||r.discoveryReason||'verdict-unreadable'});
    if(category==='not-a-review') notAReview.push({file:r.file,reason:'not-a-review',rule:r.rule});
    if(category==='excluded-by-declared-scope')excluded.push({file:r.file,rule:r.rule});
  }
  return {scope:SCOPE,format:FORMAT,walkCount:rows.length,totals:counts,filesRead:rows.length,candidates:counts.read+counts['non-canonical'],read:counts.read,unknown:counts['non-canonical'],nonCanonicalCount:unknownUnits.length,offendingFiles:unknownUnits.slice(0,20).map(u=>u.report),unknownUnits,notAReview,excluded,discoveryUnknowns:unknownUnits.length?[{field:'value',reason:'non-canonical-input',count:unknownUnits.length,files:unknownUnits.slice(0,20).map(u=>u.report)}]:[]};
}
module.exports={KNOWN_SEATS,REVIEW_FILE,metadata,discoverReviews,selectPackage,reviewCoverage};

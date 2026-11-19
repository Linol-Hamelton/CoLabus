'use strict';
// Refused packages expose only the closed refusal shape, including at the CLI.
function refusal(reason='non-canonical-input',lines=[]) {
  const offendingLines=[...new Set(lines.filter(n=>Number.isSafeInteger(n)&&n>0))].sort((a,b)=>a-b).slice(0,20);
  return {value:null,reason,firstOffendingLine:offendingLines[0]??null,offendingLines};
}
function refuseMeasurements(result, fields) {
  if (!result.nonCanonicalCount) return result;
  return refusal('non-canonical-input',result.offendingLines||result.offendingRows||[]);
}
function protect(fn) {
  return (...args)=>{try{return fn(...args);}catch(e){return exceptionRefusal(e);}};
}
// Unknown thrown values can have throwing getters, Proxies or non-string fields.
// Every property read belongs to this boundary; even diagnostic inspection may fail.
function exceptionRefusal(thrown, fallbackLine) {
  try {
    const sourceReason=thrown?.sourceReason,code=thrown?.code,line=thrown?.line,message=thrown?.message;
    const known=['source-unreadable','source-undecodable','source-exception','exception-unreadable'];
    const reason=known.includes(sourceReason)?sourceReason:code||typeof message==='string'&&message.startsWith('source-unreadable')?'source-unreadable':'source-exception';
    return refusal(reason,[Number.isSafeInteger(line)&&line>0?line:fallbackLine]);
  } catch {
    return refusal('exception-unreadable',[fallbackLine]);
  }
}
module.exports={refuseMeasurements,refusal,protect,exceptionRefusal};

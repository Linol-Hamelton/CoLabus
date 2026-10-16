'use strict';
const {parseJsonUnique}=require('../../.ai/bin/lib/text-safe.cjs');
const {deriveServedModel,modelsMatch}=require('../../docs/ops/served-model.cjs');
// Native event envelopes only. Assistant response strings never supply model identity.
function derive(input) {
  if(!['claude','agy','kilo'].includes(input.client)) return deriveServedModel(input);
  const models=[];
  const unknown=()=>({match:false,source:'none'});
  const capture=input.capturedOutput;
  if(typeof capture!=='string') return unknown();
  if(input.client==='kilo') {
    for(const line of capture.split('\n')) {
      const m=/^> (?:build|plan|agent) \u00b7 ([A-Za-z0-9][A-Za-z0-9._:/-]{0,119})$/.exec(line);
      if(m) models.push(m[1]);
    }
  } else {
    let envelopes;
    try { envelopes=[parseJsonUnique(capture.trim())]; }
    catch { try { envelopes=capture.split('\n').filter(x=>x.trim()).map(parseJsonUnique); } catch { return unknown(); } }
    for(const event of envelopes) {
      if(!event || typeof event!=='object' || Array.isArray(event)) return unknown();
      if(input.client==='claude') {
        if(event.type==='system' && event.subtype==='init' && typeof event.model==='string') models.push(event.model);
        if(event.type==='result' && event.modelUsage && typeof event.modelUsage==='object') models.push(...Object.keys(event.modelUsage));
      } else if(event.stats && event.stats.models && typeof event.stats.models==='object' && !Array.isArray(event.stats.models)) {
        models.push(...Object.keys(event.stats.models));
      }
    }
  }
  if(!models.length || models.some(x=>typeof x!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(x)) || new Set(models).size!==1) return unknown();
  return {match:modelsMatch(input.requestedModel,models[0])===true,source:'client-banner'};
}
module.exports={derive};

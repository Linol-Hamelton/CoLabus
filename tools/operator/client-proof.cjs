'use strict';
const {parseJsonUnique}=require('../../.ai/bin/lib/text-safe.cjs');
// The one exported derivation path of docs/ops/served-model.cjs; the old partial export is private.
const {deriveForLaunch,modelsMatch}=require('../../docs/ops/served-model.cjs');
// Native event envelopes only. Assistant response strings never supply model identity.
function derive(input) {
  // The streams arrive as BYTES from the seat runner (run-client.cjs spawns with encoding 'buffer' and hands the
  // buffers on); the ONE entry point of served-model.cjs is the only decode, and this envelope parser reads the text it returned
  // AFTER the check (a stream the strict decode refused has no text: unknown, never a parse of a replaced-byte prefix).
  // A string capture of a direct caller is wrapped to its UTF-8 bytes (its bytes were already lost); the seat runner hands the real bytes.
  const raw = input.capturedOutput;
  const capture = Buffer.isBuffer(raw) || raw instanceof Uint8Array ? raw : typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
  const r = deriveForLaunch({ ...input, model: input.requestedModel, args: [], env: {}, capturedOutput: capture });
  if(!['claude','agy','kilo'].includes(input.client)) return r;
  const unknown=()=>({match:false,source:'none'});
  const text = r.decoded && typeof r.decoded.capturedOutput === 'string' ? r.decoded.capturedOutput : null;
  if(typeof text!=='string') return unknown();
  const models=[];
  if(input.client==='kilo') {
    for(const line of text.split('\n')) {
      const m=/^> (?:build|plan|agent) \u00b7 ([A-Za-z0-9][A-Za-z0-9._:/-]{0,119})$/.exec(line);
      if(m) models.push(m[1]);
    }
  } else {
    let envelopes;
    try { envelopes=[parseJsonUnique(text.trim())]; }
    catch { try { envelopes=text.split('\n').filter(x=>x.trim()).map(parseJsonUnique); } catch { return unknown(); } }
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

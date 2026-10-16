'use strict';
// Private child of launch-wrapper. Raw client output is never forwarded or persisted.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const S = require('./state.cjs');
const { invocation, validateContract } = require('./seats.cjs');
const { derive:deriveServedModel } = require('./client-proof.cjs');
function run(root,input) {
  const request=S.json(root,input),c=validateContract(request.contract);
  S.id(request.runId);
  const wt=fs.realpathSync(request.worktree);
  if(S.git(['rev-parse','HEAD'],wt)!==c.sha) S.fail('candidate-changed');
  const prompt=S.guard(wt,request.prompt);
  const launch=invocation(c,prompt,wt);
  S.guard(path.dirname(launch.command),path.basename(launch.command));
  if(c.route.entry) S.guard(path.dirname(c.route.entry),path.basename(c.route.entry));
  const startedAt=new Date().toISOString();
  const result=spawnSync(launch.command,launch.args,{cwd:wt,env:launch.env,windowsHide:true,encoding:'buffer',maxBuffer:32*1024*1024,timeout:60*60*1000});
  const {decode}=require('../../.ai/bin/lib/text-safe.cjs');
  const decoded=decode(Buffer.concat([result.stdout||Buffer.alloc(0),Buffer.from('\n'),result.stderr||Buffer.alloc(0)]),{bom:'strip',crlf:'normalise'});
  const proof=decoded.ok?deriveServedModel({client:c.route.client,requestedModel:c.route.model,capturedOutput:decoded.text,startedAt,endedAt:new Date().toISOString(),workdir:wt}):null;
  // Only proven native evidence. Unsupported adapters remain unknown, never self-reported.
  const served={match:proof && proof.match===true,source:proof && ['client-banner','client-log','agent-result'].includes(proof.source)?proof.source:'none'};
  S.write(root,`${request.runId}.client.json`,{runId:request.runId,exitCode:Number.isInteger(result.status)?result.status:null,served});
  return result.status===0 && !result.signal && served.match ? 0 : 3;
}
if(require.main===module) {
  try { process.exitCode=run(process.argv[2],process.argv[3]); } catch { process.exitCode=3; }
  process.stdout.write(`CLIENT_RESULT exit=${process.exitCode}\n`);
}
module.exports={run};

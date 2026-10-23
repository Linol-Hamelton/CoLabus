'use strict';
// Private child of launch-wrapper. Raw client output is never forwarded or persisted.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const S = require('./state.cjs');
const { invocation, validateContract } = require('./seats.cjs');
const { derive:deriveServedModel } = require('./client-proof.cjs');
// The one spawn point of a seat client (route decision immediately before the spawn, PROTO-DEC-0240 item 1).
const { spawnClient } = require('../../docs/ops/seat-failover.cjs');
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
  const result=spawnClient({client:c.route.client,model:c.route.model},{command:launch.command,args:launch.args,spawnOptions:{cwd:wt,env:launch.env,windowsHide:true,encoding:'buffer',maxBuffer:32*1024*1024,timeout:60*60*1000}},spawnSync);
  // a refused route started nothing: the seat records no exit code and no served model
  if(result.routeRefusal) { S.write(root,`${request.runId}.client.json`,{runId:request.runId,exitCode:null,served:{match:false,source:'none'},route:result.routeRefusal.code}); return 3; }
  // The streams stay BYTES - the ONE derivation path (through client-proof) is the only decode; a stream the
  // strict decode refused has no text and the seat records unknown, never a parse of a replaced-byte prefix
  const proof=deriveServedModel({client:c.route.client,requestedModel:c.route.model,capturedOutput:Buffer.concat([result.stdout||Buffer.alloc(0),Buffer.from('\n'),result.stderr||Buffer.alloc(0)]),stdout:result.stdout,stderr:result.stderr,startedAt,endedAt:new Date().toISOString(),workdir:wt});
  // Only proven native evidence. Unsupported adapters remain unknown, never self-reported. launcher-model: the explicit --model the launcher passed to agy is a proven source.
  const served={match:proof && proof.match===true,source:proof && ['client-banner','client-log','agent-result','launcher-model'].includes(proof.source)?proof.source:'none'};
  S.write(root,`${request.runId}.client.json`,{runId:request.runId,exitCode:Number.isInteger(result.status)?result.status:null,served});
  return result.status===0 && !result.signal && served.match ? 0 : 3;
}
if(require.main===module) {
  try { process.exitCode=run(process.argv[2],process.argv[3]); } catch { process.exitCode=3; }
  process.stdout.write(`CLIENT_RESULT exit=${process.exitCode}\n`);
}
module.exports={run};

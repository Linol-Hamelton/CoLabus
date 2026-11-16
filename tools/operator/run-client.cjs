'use strict';
// Private child of launch-wrapper. Raw client output is never forwarded or persisted.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const S = require('./state.cjs');
const { invocation, validateContract } = require('./seats.cjs');
const { derive:deriveServedModel } = require('./client-proof.cjs');
// The one spawn point of a seat client (route decision immediately before the spawn, PROTO-DEC-0240 item 1).
const { spawnClient: guardedSpawnClient } = require('../../docs/ops/seat-failover.cjs');
const { fromStreams, stallLine } = require('../../docs/ops/approval-stall.cjs');
const routes = require('./routes.cjs');
// Preserve the line's no-link, fresh-export contract in the unified executor.
const EXPORT_FILE='export.json',CLOCK_SLACK_MS=1000;
function prepareExportDir(dir, fs) {
  try {
    let st=null;
    try { st=fs.lstatSync(dir); } catch(e) { if(e.code!=='ENOENT') return false; }
    if(!st) fs.mkdirSync(dir);
    else if(st.isSymbolicLink() || !st.isDirectory()) return false;
    const file=path.join(dir,EXPORT_FILE);
    let old=null;
    try { old=fs.lstatSync(file); } catch(e) { if(e.code!=='ENOENT') return false; }
    if(old) { if(!old.isFile()) return false; fs.unlinkSync(file); }
    return true;
  } catch { return false; }
}
function exportWrittenByThisRun(dir,startedMs,fs) {
  try {
    const directory=fs.lstatSync(dir);
    if(directory.isSymbolicLink() || !directory.isDirectory()) return false;
    const st=fs.lstatSync(path.join(dir,EXPORT_FILE));
    return st.isFile() && st.mtimeMs>=startedMs-CLOCK_SLACK_MS;
  } catch { return false; }
}
function execute(c, prompt, wt, root, deps = {}) {
  validateContract(c);
  const env = deps.env || routes.machineEnv();
  const io = deps.fs || fs;
  const context = { env, seatMcp:deps.seatMcp, mcpConfigFile:deps.mcpConfigFile };
  let kimi = null, kimiRoute = null, kimiConfigCheck = null, qwen = null, qwenOptions = null;
  try {
    if (c.route.client === 'vibe') {
      context.env = routes.bootstrapVibe(env, deps.home, io);
      context.exportDir = deps.exportDir || io.mkdtempSync(path.join(root,'vibe-proof-'));
      if (!prepareExportDir(context.exportDir,io)) return {exitCode:null,served:{match:false,source:'none'},exportRefused:'vibe-export-dir-refused'};
    }
    if (c.route.client === 'kimi') {
      const mod = deps.kimiRoute || require('../../docs/ops/kimi-route.cjs');
      kimi = mod.launchSession(mod, { model:c.route.model, env, fs:io, tmpRoot:require('../../.ai/bin/lib/seat-mcp.cjs').kimiTmpRoot({ role:c.sealed?'certifier':c.role, root:wt, io }) || root });
      const prepared = kimi.prepare();
      if (!prepared.ok) return { exitCode:3, served:{match:false,source:'none'}, reason:prepared.reason };
      kimiRoute = prepared;
      context.env = kimi.childEnv(env);
      const mcp = require('../../.ai/bin/lib/seat-mcp.cjs');
      const p = mcp.forSeat(context.seatMcp, { role:c.sealed?'certifier':c.role, sealed:c.sealed, root:wt, env });
      if (!mcp.kimiConfig(p, prepared.home, wt, io)) context.seatMcp = mcp.plan({ role:'pre-review', root:wt, env });
      const before = kimi.preSpawn(io);
      if (before) return { exitCode:3, served:{match:false,source:'none'}, reason:before.reason };
    }
    let launch = invocation(c,prompt,wt,context);
    if (c.route.client === 'qwen') {
      qwen = deps.qwen || require('../../docs/ops/qwen-client.cjs');
      qwenOptions = { model:c.route.model, name:'seat-qwen', worktree:wt, promptFile:prompt };
      const check = qwen.preflight(qwenOptions, { userEnv:name => routes.envValue(env,name) }, { env,runtime:root,dryRun:false });
      if (!check.ok) return { exitCode:3, served:{match:false,source:'none'}, reason:'qwen-route-refused' };
      const timeout = require('../../.ai/bin/lib/client-command-timeout.cjs');
      const instruction = timeout.append(`Read and execute the UTF-8 task file ${prompt}.`, timeout.lookup(c.route.client));
      launch = qwen.buildInvocation(qwenOptions,instruction,env);
      const recheck = qwen.recheck(qwenOptions,io);
      if (!recheck.ok) return { exitCode:3, served:{match:false,source:'none'}, reason:'qwen-route-changed' };
    }
    const startedMs=Date.now(),startedAt = new Date(startedMs).toISOString();
    const client = routes.API[c.route.client] ? 'kilo' : c.route.client;
    const spawnClient = deps.spawnClient || guardedSpawnClient;
    const result=spawnClient({client,model:c.route.model,env:launch.env || launch.spawnOptions?.env},{command:launch.command,args:launch.args,spawnOptions:{cwd:wt,env:launch.env || launch.spawnOptions?.env,...(launch.stdio?{stdio:launch.stdio}:{}),windowsHide:true,encoding:'buffer',maxBuffer:32*1024*1024,timeout:deps.timeout || 60*60*1000,...(launch.spawnOptions || {})}},deps.spawnSync || spawnSync);
    if (result.routeRefusal) return {exitCode:null,served:{match:false,source:'none'},route:result.routeRefusal.code};
    const meter = require('../../.ai/bin/accounting/lib/run-usage.cjs');
    // The private Kimi home can disappear in afterRun, including on failure.
    const kimiUsage = kimi ? meter.kimiUsage(kimiRoute?.home) : null;
    if (kimi) kimiConfigCheck = kimi.afterRun(io,result);
    const qwenRun = qwen ? qwen.afterRun(qwenOptions,io,result) : null;
    const endedAt = new Date().toISOString();
    const proof = deriveServedModel({client,requestedModel:c.route.model,args:launch.args,env:launch.env || launch.spawnOptions?.env,exportDir:context.exportDir,kimiRoute,kimiConfigCheck,qwenRoute:qwenRun?.route,qwenClientFault:qwenRun?.clientFault,capturedOutput:Buffer.concat([result.stdout||Buffer.alloc(0),Buffer.from('\n'),result.stderr||Buffer.alloc(0)]),stdout:result.stdout,stderr:result.stderr,startedAt,endedAt,workdir:wt,includeDecoded:true});
    const served = {match:result.status===0 && !result.error && !result.signal && proof?.match===true,source:['client-banner','client-log','agent-result','launcher-model'].includes(proof?.source)?proof.source:'none',...(typeof proof?.servedModel==='string'?{servedModel:proof.servedModel}:{})};
    // Extract with the spawned harness; retain the provider/model for pricing.
    // Qwen stream text must not enter usage extraction (PROTO-DEC-0211).
    const output = client === 'qwen' ? '' : (client === 'codex' ? proof?.decoded?.capturedOutput : proof?.decoded?.stdout) || '';
    const nativeUsage = kimiUsage || meter.extract(client,output,{env:launch.env || launch.spawnOptions?.env,workdir:wt});
    const usage = require('../../.ai/bin/launch-record.cjs').usageRecordFields({client:c.route.client,model:c.route.model,servedModel:served.servedModel,nativeUsage,endedAt,workdir:wt,env:launch.env || launch.spawnOptions?.env});
    const frame = meter.frame(usage.fields);
    if (context.exportDir && !exportWrittenByThisRun(context.exportDir,startedMs,io)) return {exitCode:Number.isInteger(result.status)?result.status:null,served:{match:false,source:'none'},frame,exportMissing:'vibe-export-missing'};
    const stall = fromStreams({client,stdout:result.stdout,stderr:result.stderr,failed:result.status!==0||Boolean(result.signal)});
    if (stall) process.stdout.write(`${stallLine(client,stall)}\n`);
    return { exitCode:Number.isInteger(result.status)?result.status:null, served, frame, ...(stall ? {failureClass:'APPROVAL_STALL'} : {}), ...(deps.observe ? {observation:deps.observe(result)} : {}) };
  } finally {
    if (kimi) kimi.drop();
    if (qwen && qwenOptions) qwen.cleanup(qwenOptions);
    if (context.exportDir && !deps.exportDir) io.rmSync(context.exportDir,{recursive:true,force:true});
  }
}
function run(root,input) {
  const request=S.json(root,input),c=validateContract(request.contract);
  S.id(request.runId);
  const wt=fs.realpathSync(request.worktree);
  if(S.git(['rev-parse','HEAD'],wt)!==c.sha) S.fail('candidate-changed');
  const prompt=S.guard(wt,request.prompt);
  S.guard(path.dirname(c.route.executable),path.basename(c.route.executable));
  // Seat MCP: one plan per seat; a claude kernel seat gets its --mcp-config file next to the request (a write that fails leaves it with no server).
  // A chained certifier seat (contract field chain, PROTO-DEC-0252 item 2) plans kernel like an author seat.
  const mcp=require('../../.ai/bin/lib/seat-mcp.cjs');
  const plan=mcp.forSeat(null,{role:c.sealed?'certifier':c.role,sealed:c.sealed,chained:Boolean(c.chain),root:wt,env:process.env,client:c.route.client});
  let mcpConfigFile=null;
  if(c.route.client==='claude' && plan.mode==='kernel' && plan.list.length) { try {
    if(plan.list.some(s=>s.name==='semgrep')) mcpConfigFile=mcp.claudeConfigFile(plan,{role:c.role,root:wt});
    else { S.write(root,`${request.runId}.mcp.json`,mcp.claudeConfigText(plan.list)); mcpConfigFile=S.guard(root,`${request.runId}.mcp.json`); }
  } catch { mcpConfigFile=null; } }
  if(c.route.entry) S.guard(path.dirname(c.route.entry),path.basename(c.route.entry));
  const {frame,...result}=execute(c,prompt,wt,root,{seatMcp:plan,mcpConfigFile,...(c.route.client==='vibe'?{exportDir:`${prompt}.vibe-export`}:{})});
  const meter=require('../../.ai/bin/accounting/lib/run-usage.cjs');
  S.write(root,`${request.runId}.client.json`,{runId:request.runId,...result,...(frame ? meter.parseFrame(frame) : {})});
  if(frame) process.stdout.write(`\n${frame}\n`);
  return result.exitCode===0 && result.served.match && !result.failureClass && !result.exportMissing && !result.exportRefused ? 0 : 3;
}
if(require.main===module) {
  try { process.exitCode=run(process.argv[2],process.argv[3]); } catch { process.exitCode=3; }
  process.stdout.write(`CLIENT_RESULT exit=${process.exitCode}\n`);
}
module.exports={run,execute};

'use strict';
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const repoPaths = require('../../.ai/bin/repo-paths.cjs');
const { loadRegistry } = require('../../.ai/bin/protocol-dispatch/registry.cjs');
const { effortArgs } = require('../../.ai/bin/protocol-dispatch/clients.cjs');

// <main checkout>/.ai/runtime of the repository these files live in (env OPS_RUNTIME_DIR overrides; repo-paths.cjs)
const DEFAULT_RUNTIME = repoPaths.runtimeDir();
const unknownUsageFields = e => ({ tokens: null, cost: { usd: null, basis: 'unknown', priceSnapshot: null, formula: null, reason: `usage derivation failed: ${String((e && e.message) || e).slice(0, 200)}` } });
const recordFailedLine = e => `RECORD-WRITE-FAILED code=${String((e && e.code) || 'UNKNOWN').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'UNKNOWN'}`;
function value(argv, name, dflt) { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; }
function options(argv) { return { worktree: value(argv, 'worktree'), name: value(argv, 'name'), promptFile: value(argv, 'prompt-file'), expect: value(argv, 'expect-sha'), branch: value(argv, 'branch', ''), dryRun: argv.includes('--dry-run'),
  packetRole: value(argv, 'packet-role'), packetStage: value(argv, 'packet-stage'), packetFrame: value(argv, 'packet-frame'), packetProfile: value(argv, 'packet-profile'), allowExecutorPacket: argv.includes('--allow-executor-packet'),
  effort: value(argv, 'effort', 'high'), tier: value(argv, 'tier', 'T7') }; }
const MODEL = 'claude-sonnet-5-5';
// P-L3-005: the project supplies its own registry, as for cert-launch.
// A missing or broken registry refuses; an absent or unavailable client entry also refuses.
// No fallback or error-message discrimination: only registered clients can begin a task.
function effortFor(o, registry) {
  const reg = registry || loadRegistry();
  const cfg = reg.clients && Object.hasOwn(reg.clients, 'claude') && reg.clients.claude;
  if (!cfg || cfg.present !== true) {
    return { ok: false, args: [], effortUsed: null, error: 'client claude is absent or not present in the registry (P-L3-005)' };
  }
  // Unknown effort of a registered client is distinct from a missing client.
  return effortArgs('claude', o.effort === undefined ? 'high' : o.effort, reg);

}

function buildInvocation(o, env = process.env, packet) {
  const effort = (o.effortArgs ? { args: o.effortArgs } : effortFor(o, o.registry)).args || [];
  const legacyArgText = `Read ${o.promptFile.replace(/\\/g, '/')} and execute it exactly (targeted checks only; end with the DONE or BLOCKED marker named in the prompt).`;
  // One line only: cmd.exe /c ends the command line at the first newline (see cert-launch.cjs buildInvocation).
  const argText = (packet ? `${packet.pointerLine} ${legacyArgText}` : legacyArgText).replace(/[\r\n]+/g, ' ');
  // The text format (default, byte-identical to before) prints no usage; CLAUDE_OUTPUT_FORMAT=json (environment name) appends --output-format json, whose
  // result carries tokens, total_cost_usd (a list-price equivalent on a subscription) and modelUsage (measured 2026-10-10). The default is the owner's call.
  return { command: 'cmd.exe', args: ['/c', 'claude', '--model', MODEL, ...effort, '--dangerously-skip-permissions', '-p', argText, ...(env.CLAUDE_OUTPUT_FORMAT === 'json' ? ['--output-format', 'json'] : [])], spawnOptions: { cwd: o.worktree, encoding: 'utf8', env: { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, maxBuffer: 536870912 }, argText };
}

function main(argv, deps = {}) {
  const o = options(argv);
  const io = deps.fs || fs;
  const spawnSync = deps.spawnSync || childProcess.spawnSync;
  const runtime = deps.runtimeDir || DEFAULT_RUNTIME;
  const say = deps.say || (line => console.log(line));
  if (!o.worktree || !o.name || !o.promptFile || !o.expect) { (deps.error || console.error)('usage: --worktree --name --prompt-file --expect-sha [--branch]'); return 2; }
  const callFile = path.join(runtime, `${o.name}-call.txt`);
  const done = `${o.name.toUpperCase()}_DONE`;
  if (o.dryRun) { say(`DRY-RUN fix-launch name=${o.name}`); return 0; }
  const git = args => spawnSync('git', args, { cwd: o.worktree, encoding: 'utf8' });
  const head = (git(['rev-parse', '--short', 'HEAD']).stdout || '').trim();
  const branch = (git(['rev-parse', '--abbrev-ref', 'HEAD']).stdout || '').trim();
  const shaOk = head === o.expect || (head.length >= 7 && o.expect.length >= 7 && (head.startsWith(o.expect) || o.expect.startsWith(head)));
  if (!shaOk || (o.branch && branch !== o.branch)) {
    io.writeFileSync(callFile, `exit=PREFLIGHT_FAIL head=${head} branch=${branch}\n`, 'utf8');
    return 2;
  }
  if (Boolean(o.packetRole) !== Boolean(o.packetStage)) { (deps.error || console.error)('--packet-role and --packet-stage must be given together'); return 2; }
  const env = deps.env || process.env;
  const dispatchPacket = env.PROTOCOL_PACKET_ENGINE === 'dispatch';
  if (dispatchPacket && !o.packetRole) { o.packetRole = 'fixer'; o.packetStage = 'execute'; }
  let packet = null;
  if (o.packetRole) {
    const packetTool = deps.launchPacket || require('./launch-packet.cjs');
    const gate = dispatchPacket ? require('./launch-packet.cjs').deliveryPolicy(env, o.packetRole, o.allowExecutorPacket)
      : packetTool.policy(env.OPERATOR_PACKET, o.packetRole, o.allowExecutorPacket);
    if (gate.refused) { say(`PACKET REFUSED reason=${gate.refused}; nothing was started`); return 3; }
    if (gate.active) {
      try { packet = packetTool.preparePacket({ worktree: o.worktree, role: o.packetRole, stage: o.packetStage, frame: o.packetFrame, profile: o.packetProfile, client: 'claude' }); }
      catch (error) { say(dispatchPacket ? 'PACKET REFUSED reason=packet-compile-failed; nothing was started' : `PACKET REFUSED reason=${error.message}; nothing was started`); return 3; }
    }
  }
  let eff;
  try { eff = effortFor(o, deps.registry); } catch (error) { say(`EFFORT REFUSED reason=registry unavailable (${error.message}); nothing was started`); return 2; }
  if (!eff.ok) { say(`EFFORT REFUSED reason=${eff.error} (P-L3-005 R-L3-005.7); nothing was started`); return 2; }
  o.effortArgs = eff.args;
  const heartbeat = deps.heartbeat || repoPaths.heartbeatFor(runtime, say);
  const hb = heartbeat.start(o.name);
  const startedAt = (deps.now || (() => new Date()))().toISOString();
  const invocation = buildInvocation(o, env, packet);
  // the resolver's shadow answer, recorded before the client starts; it never changes the invocation built above
  try {
    const shadowTool = deps.resolverShadow || require('./resolver-shadow.cjs');
    let launchId = null; try { launchId = require('../../.ai/bin/launch-record.cjs').buildLaunchRecord({ name: o.name, startedAt }).launchId; } catch { /* no id */ }
    shadowTool.record({ launcher: 'fix-launch', name: o.name, launchId, role: packet ? packet.role : 'fixer', tier: o.tier, stageKind: 'kernel', operator: { client: 'claude', model: MODEL, effort: eff.effortUsed } }, { runtimeDir: runtime, now: () => new Date(startedAt) });
  } catch { /* the shadow never blocks a launch */ }
  const result = spawnSync(invocation.command, invocation.args, invocation.spawnOptions);
  heartbeat.stop(hb);
  const endedAt = (deps.now || (() => new Date()))().toISOString();
  // D9 (PROTO-DEC-0169 item 4): served model from a source outside the report; advisory, never changes exit or marker.
  // The claude -p text route prints no model line, so this records source=none until the client offers one.
  let servedFields = {}; let servedText = ''; let mismatch = null; let servedNote = '';
  try {
    const sm = deps.servedModel || require('./served-model.cjs');
    const served = sm.deriveServedModel({ client: 'claude', requestedModel: MODEL, capturedOutput: `${result.stdout || ''}${result.stderr || ''}`, startedAt, endedAt, logDir: env.MIMOCODE_LOG_DIR, workdir: o.worktree }, env);
    servedFields = sm.recordFields(served); servedText = sm.servedLine(served);
    servedNote = (sm.servedNote && sm.servedNote(served)) || '';
    if (served.match === false && served.servedModel && served.confidence !== 'none') mismatch = served;
  } catch { servedFields = {}; servedText = ''; mismatch = null; servedNote = ''; }
  const mismatchText = mismatch ? `SERVED_MODEL_MISMATCH requested=claude-sonnet-5-5 served=${mismatch.servedModel} source=${mismatch.source}; the launch is not a verdict` : '';
  const marker = mismatch ? done.replace(/_DONE$/, '_SERVED_MODEL_MISMATCH') : done;
  // Tokens and cost (cost-record): claude is a flat-fee client (cost basis subscription); tokens only when the json format was asked for. Never changes the exit.
  const captured = `${result.stdout || ''}${result.stderr || ''}`;
  let usage = { fields: {}, info: {} }; let usageText = '';
  try {
    const writer = deps.usageTool || require('../../.ai/bin/launch-record.cjs');
    usage = writer.usageRecordFields({ client: 'claude', model: 'claude-sonnet-5-5', output: captured, endedAt, env }, deps.usage || {});
    usageText = (writer.usageLine && writer.usageLine(usage.fields)) || '';
  } catch (e) { usage = { fields: unknownUsageFields(e), info: {} }; usageText = ''; }
  const body = usage.info && typeof usage.info.resultText === 'string' ? usage.info.resultText : captured;
  let recordFailed = '';
  try {
    const writer = deps.launchRecord || require('../../.ai/bin/launch-record.cjs');
    const paths = require('../../.ai/bin/launch-record.cjs').recordPaths(o.worktree, o.promptFile);
    writer.writeLaunchRecord({ client: 'claude', model: MODEL, effort: eff.effortUsed, role: packet ? packet.role : 'fixer', stage: packet ? packet.stage : 'execute', taskClass: 'A', route: 'cli:claude', riskClass: 'A', name: o.name, ...paths, head, exitCode: mismatch ? 3 : result.status, startedAt, failureClass: mismatch ? 'SERVED_MODEL_MISMATCH' : undefined,
      note: [mismatch ? `served-model-mismatch served=${mismatch.servedModel}` : '', servedNote, !usage.fields.tokens ? 'usage-unknown reason=no-complete-usage-evidence confidence=unknown' : ''].filter(Boolean).join(' ') || undefined,
      ...(packet ? { packetHash: packet.packetHash, packetProfile: packet.profile, packetBytes: packet.bytes, packetEstTokens: packet.estTokens } : {}), ...servedFields, ...usage.fields });
  } catch (e) { recordFailed = recordFailedLine(e); }
  if (recordFailed) (deps.error || console.error)(recordFailed);
  io.appendFileSync(callFile, `marker=${marker}\n${body}\n${usageText ? `${usageText}\n` : ''}${mismatchText ? `${mismatchText}\n` : ''}${servedText ? `${servedText}\n` : ''}${recordFailed ? `${recordFailed}\n` : ''}${marker} exit=${result.status} end=${endedAt}\n`, 'utf8');
  if (usageText) say(usageText);
  if (mismatchText) say(mismatchText);
  if (servedText) say(servedText);
  say(`${marker} exit=${result.status}`);
  return mismatch ? 3 : (result.status === null ? 1 : result.status);
}

module.exports = { DEFAULT_RUNTIME, value, options, effortFor, buildInvocation, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const repoPaths = require('../../.ai/bin/repo-paths.cjs');
const { loadRegistry } = require('../../.ai/bin/protocol-dispatch/registry.cjs');
const { effortArgs } = require('../../.ai/bin/protocol-dispatch/clients.cjs');
const { identity: seatIdentity, spawnClient, FIX_FIRST } = require('./seat-failover.cjs'); // the one reader of the fallback client and model; the one spawn point of a client; the first route

// <main checkout>/.ai/runtime of the repository these files live in (env OPS_RUNTIME_DIR overrides; repo-paths.cjs)
const DEFAULT_RUNTIME = repoPaths.runtimeDir();
const unknownUsageFields = e => ({ tokens: null, cost: { usd: null, basis: 'unknown', priceSnapshot: null, formula: null, reason: `usage derivation failed: ${String((e && e.message) || e).slice(0, 200)}` } });
const recordFailedLine = e => `RECORD-WRITE-FAILED code=${String((e && e.code) || 'UNKNOWN').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'UNKNOWN'}`;
function value(argv, name, dflt) { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; }
function options(argv) { return { worktree: value(argv, 'worktree'), name: value(argv, 'name'), promptFile: value(argv, 'prompt-file'), expect: value(argv, 'expect-sha'), branch: value(argv, 'branch', ''), dryRun: argv.includes('--dry-run'),
  packetRole: value(argv, 'packet-role'), packetStage: value(argv, 'packet-stage'), packetFrame: value(argv, 'packet-frame'), packetProfile: value(argv, 'packet-profile'), allowExecutorPacket: argv.includes('--allow-executor-packet'),
  effort: value(argv, 'effort', 'high'), tier: value(argv, 'tier', 'T7') }; }
const MODEL = FIX_FIRST.model; // the first route is read from seat-failover FIX_FIRST, the pair the early route check decides
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
  const legacyArgText = `Read ${o.promptFile.replace(/\\/g, '/')} and execute it exactly (run affected tests with node .ai/bin/protocol-test.cjs --root . --affected {baseRef}; the full suite runs in the landing train; end with the DONE or BLOCKED marker named in the prompt).`;
  // One line only: cmd.exe /c ends the command line at the first newline (see cert-launch.cjs buildInvocation).
  // The client is spawned WITHOUT a text encoding (encoding 'buffer'): its streams stay BYTES to the strict decode of
  // the ONE derivation path (deriveForLaunch); nothing here decodes a client stream.
  const argText = (packet ? `${packet.pointerLine} ${legacyArgText}` : legacyArgText).replace(/[\r\n]+/g, ' ');
  // The text format (default, byte-identical to before) prints no usage; CLAUDE_OUTPUT_FORMAT=json (environment name) appends --output-format json, whose
  // result carries tokens, total_cost_usd (a list-price equivalent on a subscription) and modelUsage. The default is the owner's call.
  return { command: 'cmd.exe', args: ['/c', 'claude', '--model', MODEL, ...effort, '--dangerously-skip-permissions', ...(env.COLABUS_SEAT_MCP === '1' ? [] : ['--strict-mcp-config']), '-p', argText, ...(env.CLAUDE_OUTPUT_FORMAT === 'json' ? ['--output-format', 'json'] : [])], spawnOptions: { cwd: o.worktree, encoding: 'buffer', env: { ...env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, maxBuffer: 536870912 }, argText };
}

function main(argv, deps = {}) {
  return require('./seat-failover.cjs').run(argv, deps, launchOnce, 'fix');
}

function launchOnce(argv, deps = {}) {
  const o = options(argv);
  // Recovery changes only the transport/model. The fixer retains its SHA/branch,
  // packet, shadow and report contract on every attempt.
  const stated = deps.seatFallback ? seatIdentity(argv) : null;
  if (stated && stated.problem) throw new Error(stated.problem);
  o.client = stated ? stated.client : FIX_FIRST.client;
  o.model = stated ? stated.model : MODEL;
  o.vibeModels = deps.vibeModels;
  const io = deps.fs || fs;
  const spawnSync = deps.spawnSync || childProcess.spawnSync;
  const runtime = deps.runtimeDir || DEFAULT_RUNTIME;
  const say = deps.say || (line => console.log(line));
  if (!o.worktree || !o.name || !o.promptFile || !o.expect) { (deps.error || console.error)('usage: --worktree --name --prompt-file --expect-sha [--branch]'); return 2; }
  // Launch isolation: the name becomes a directory name under the work root; a traversal is refused here (exit 2) exactly as
  // cert-launch refuses it, before anything is created, and prepareLaunchDir refuses it again defensively.
  if (!require('./launch-packet.cjs').SAFE_SEGMENT.test(o.name)) {
    (deps.error || console.error)('name must be one safe path segment');
    return 2;
  }
  const callFile = path.join(runtime, `${o.name}-call.txt`);
  const done = `${o.name.toUpperCase()}_DONE`;
  if (o.client === 'vibe' && !require('./served-model.cjs').vibeAlias(o.model, o.vibeModels).known) {
    (deps.error || console.error)('unknown vibe model; nothing was started'); return 2;
  }
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
  // Launch isolation (docs/ops/lib/work-root.cjs): the work root of this launcher's repository is enforced for every launched child; TEMP, TMP, TMPDIR
  // and the toolchain caches point inside a per-launch directory created FRESH for this launch (an inherited TEMP that carries the marker of an
  // earlier run is not accepted again) with every cache directory created fresh and exclusively inside it, marker-kept for retention. A refusal
  // starts nothing and names the reason and the recovery line.
  const workTool = deps.workRoot || require('./lib/work-root.cjs');
  const work = workTool.kernelWorkEnv({ repo: path.resolve(__dirname, '..', '..'), name: o.name, env: deps.env || process.env, io });
  if (work.refusal) {
    if (work.tempDir) io.appendFileSync(callFile, `TEMP-DIR ${JSON.stringify(work.tempDir)}\n`, 'utf8');
    io.appendFileSync(callFile, `exit=WORKROOT_REFUSED reason=${work.refusal.reason} root=${work.refusal.root}\nrecovery: ${work.refusal.recovery}\n`, 'utf8');
    say(`WORKROOT REFUSED reason=${work.refusal.reason} root=${work.refusal.root}; ${work.refusal.recovery}; nothing was started`);
    return 3;
  }
  // The creator settles its own kernel directory on every return and exception.
  let tempDir = null;
  const settleLaunch = code => {
    if (tempDir) return tempDir;
    tempDir = require('./lib/work-root.cjs').finishLaunchTmp({ dir: work.dir, root: work.root.dir, name: o.name }, code !== 0, 'KERNEL_EXIT');
    // This precedes the terminal marker; its path is the exact directory created above.
    io.appendFileSync(callFile, `TEMP-DIR ${JSON.stringify(tempDir)}\n`, 'utf8');
    return tempDir;
  };
  try {
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
      try { packet = packetTool.preparePacket({ worktree: o.worktree, role: o.packetRole, stage: o.packetStage, frame: o.packetFrame, profile: o.packetProfile, client: o.client }); }
      catch (error) { say(dispatchPacket ? 'PACKET REFUSED reason=packet-compile-failed; nothing was started' : `PACKET REFUSED reason=${error.message}; nothing was started`); return 3; }
    }
  }
  let eff;
  try { eff = o.client === 'claude' ? effortFor(o, deps.registry) : require('./cert-launch.cjs').effortFor(o, deps.registry); } catch (error) { say(`EFFORT REFUSED reason=registry unavailable (${error.message}); nothing was started`); return 2; }
  if (!eff.ok) { say(`EFFORT REFUSED reason=${eff.error} (P-L3-005 R-L3-005.7); nothing was started`); return 2; }
  o.effortArgs = eff.args;
  // PROTO-DEC-0215 item 1: as in cert-launch, a vibe launch (a seat-fallback route here) gets a NEW EMPTY directory per launch
  // and --output-dir; the served model is read only from its export.json after the exit.
  if (o.client === 'vibe') {
    try { o.exportDir = io.mkdtempSync(path.join(runtime, 'launch-export-')); }
    catch (error) { say(`EXPORT-DIR-FAILED code=${String((error && error.code) || 'UNKNOWN').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'UNKNOWN'}; nothing was started`); return 2; }
  }
  const heartbeat = deps.heartbeat || repoPaths.heartbeatFor(runtime, say);
  const hb = heartbeat.start(o.name);
  const startedAt = (deps.now || (() => new Date()))().toISOString();
  const fixerInvocation = buildInvocation(o, work.env, packet);
  if (o.client === 'claude' && deps.seatFallback) fixerInvocation.args[fixerInvocation.args.indexOf('--model') + 1] = o.model;
  const invocation = o.client === 'claude' ? fixerInvocation : require('./cert-launch.cjs').buildInvocation({ ...o, instructionText: fixerInvocation.argText }, work.env, packet);
  if (o.client === 'agy') invocation.args.push('--model', o.model);
  // the resolver's shadow answer, recorded before the client starts; it never changes the invocation built above
  try {
    const shadowTool = deps.resolverShadow || require('./resolver-shadow.cjs');
    let launchId = null; try { launchId = require('../../.ai/bin/launch-record.cjs').buildLaunchRecord({ name: o.name, startedAt }).launchId; } catch { /* no id */ }
    shadowTool.record({ launcher: 'fix-launch', name: o.name, launchId, role: packet ? packet.role : 'fixer', tier: o.tier, stageKind: 'kernel', operator: { client: o.client, model: o.model, effort: eff.effortUsed } }, { runtimeDir: runtime, now: () => new Date(startedAt) });
  } catch { /* the shadow never blocks a launch */ }
  // The client starts only through the one spawn point (seat-failover spawnClient): the route of o.client and o.model (claude and MODEL on the
  // first launch, the fallback route of a switch) is recorded immediately before the spawn; a refused route starts nothing. The first route was
  // already decided by seat-failover run before anything of the launch existed and is handed here; later spawns are decided here.
  const result = spawnClient({ client: o.client, model: o.model, deps, env, say, io, callFile }, invocation, spawnSync);
  heartbeat.stop(hb);
  if (result.routeRefusal) {
    const refusedMarker = done.replace(/_DONE$/, '_ROUTE_REFUSED');
    io.appendFileSync(callFile, `marker=${refusedMarker}\n${refusedMarker} exit=3 reason=${result.routeRefusal.code} end=${(deps.now || (() => new Date()))().toISOString()}\n`, 'utf8');
    say(`${refusedMarker} exit=3 reason=${result.routeRefusal.code}; the client was not started`);
    return 3;
  }
  const endedAt = (deps.now || (() => new Date()))().toISOString();
  // PROTO-DEC-0169 item 4: served model from a source outside the report; advisory, never changes exit or marker.
  // The ONE derivation path deriveForLaunch(context) reads the launch that really ran - the argv and the spawn
  // environment this launcher started the client with (a seat-fallback route builds it through cert-launch buildInvocation, so a vibe route carries
  // its alias environment and its --output-dir), the export directory, the streams apart - and returns requestedModelVia and the served-model proof
  // TOGETHER. The claude -p text route prints no model line, so this records source=none until the client offers one. No call of requestedModelVia
  // or deriveServedModel remains here.
  let served = null; let servedFields = {}; let servedText = ''; let mismatch = null; let servedNote = '';
  try {
    const sm = deps.servedModel || require('./served-model.cjs');
    // The stream fields are the BYTES spawnSync returned (encoding 'buffer'); the ONE derivation path is the only decode,
    // and the decoded text below (the usage, the call file body) is what it returned AFTER the check. The record fields,
    // the SERVED line and the note travel inside the one return (record, line, note).
    served = sm.deriveForLaunch({ client: o.client, model: o.model, args: invocation.args, env: invocation.spawnOptions && invocation.spawnOptions.env, stdout: result.stdout, stderr: result.stderr, startedAt, endedAt, logDir: env.MIMOCODE_LOG_DIR, workdir: o.worktree, exportDir: o.exportDir, vibeModels: o.vibeModels });
    servedFields = served.record || {}; servedText = served.line || '';
    servedNote = served.note || '';
    if (served.match === false && served.servedModel && served.confidence !== 'none') mismatch = served;
  } catch { served = null; servedFields = {}; servedText = ''; mismatch = null; servedNote = ''; }
  const mismatchText = mismatch ? `SERVED_MODEL_MISMATCH requested=${o.model} served=${mismatch.servedModel} source=${mismatch.source}; the launch is not a verdict` : '';
  const marker = mismatch ? done.replace(/_DONE$/, '_SERVED_MODEL_MISMATCH') : done;
  // Tokens and cost (cost-record): claude is a flat-fee client (cost basis subscription); tokens only when the json format was asked for. Never changes the exit.
  // The decoded text of the streams, produced after the check - never a decode of the launcher's own.
  const decodedStreams = served && served.decoded ? served.decoded : {};
  const captured = `${typeof decodedStreams.stdout === 'string' ? decodedStreams.stdout : ''}${typeof decodedStreams.stderr === 'string' ? decodedStreams.stderr : ''}`;
  let usage = { fields: {}, info: {} }; let usageText = '';
  try {
    const writer = deps.usageTool || require('../../.ai/bin/launch-record.cjs');
    usage = writer.usageRecordFields({ client: o.client, model: o.model, output: captured, endedAt, env }, deps.usage || {});
    usageText = (writer.usageLine && writer.usageLine(usage.fields)) || '';
  } catch (e) { usage = { fields: unknownUsageFields(e), info: {} }; usageText = ''; }
  const body = usage.info && typeof usage.info.resultText === 'string' ? usage.info.resultText : captured;
  settleLaunch(mismatch ? 3 : (result.status === null ? 1 : result.status));
  let recordFailed = '';
  try {
    const writer = deps.launchRecord || require('../../.ai/bin/launch-record.cjs');
    const paths = require('../../.ai/bin/launch-record.cjs').recordPaths(o.worktree, o.promptFile);
    // The argv this launcher really started the client with; a fix round is an author launch. requestedModelVia
    // comes from the one derivation path (a fact of the real argv and spawn environment), never from a second partial computation here.
    const provenance = { requestedModelVia: served ? served.requestedModelVia : undefined, launchRole: 'author' };
    writer.writeLaunchRecord({ client: o.client, model: o.model, effort: eff.effortUsed, role: packet ? packet.role : 'fixer', stage: packet ? packet.stage : 'execute', taskClass: 'A', route: `cli:${o.client}`, riskClass: 'A', name: o.name, ...paths, ...provenance, head, workRootDir: work.dir, exitCode: mismatch ? 3 : result.status, startedAt, failureClass: mismatch ? 'SERVED_MODEL_MISMATCH' : undefined,
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
  } finally {
    settleLaunch(1);
  }
}

module.exports = { DEFAULT_RUNTIME, value, options, effortFor, buildInvocation, main, launchOnce };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

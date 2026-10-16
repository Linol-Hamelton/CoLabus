'use strict';
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const confinement = require('./launch-packet.cjs');
const repoPaths = require('../../.ai/bin/repo-paths.cjs');
const servedModelTool = require('./served-model.cjs');
const { loadRegistry } = require('../../.ai/bin/protocol-dispatch/registry.cjs');
const { effortArgs } = require('../../.ai/bin/protocol-dispatch/clients.cjs');

// <main checkout>/.ai/runtime of the repository these files live in (env OPS_RUNTIME_DIR overrides; repo-paths.cjs)
const DEFAULT_RUNTIME = repoPaths.runtimeDir();
const unknownUsageFields = e => ({ tokens: null, cost: { usd: null, basis: 'unknown', priceSnapshot: null, formula: null, reason: `usage derivation failed: ${String((e && e.message) || e).slice(0, 200)}` } });
// The one line of a failed launch-record write (stderr and call file); the code is the error code (ENOSPC, EACCES, ...) reduced to safe characters.
const recordFailedLine = e => `RECORD-WRITE-FAILED code=${String((e && e.code) || 'UNKNOWN').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'UNKNOWN'}`;

function value(argv, name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
}

function options(argv) {
  return {
    client: value(argv, 'client'), model: value(argv, 'model'), worktree: value(argv, 'worktree'),
    name: value(argv, 'name'), promptFile: value(argv, 'prompt-file'), expect: value(argv, 'expect-sha'),
    argsFile: value(argv, 'args-file', ''), maxTokens: value(argv, 'max-tokens', '16000'),
    expectReport: value(argv, 'expect-report', ''), dryRun: argv.includes('--dry-run'),
    packetRole: value(argv, 'packet-role'), packetStage: value(argv, 'packet-stage'),
    packetFrame: value(argv, 'packet-frame'), packetProfile: value(argv, 'packet-profile'),
    allowExecutorPacket: argv.includes('--allow-executor-packet'),
    effort: value(argv, 'effort', 'high'), tier: value(argv, 'tier', 'T7'),
  };
}

// Report gate is advice (/117). The shared reader owns the grammar and masking.
const { readVerdict } = require('../../.ai/bin/lib/verdict-read.cjs');
const { realInside } = require('../../.ai/bin/lib/path-safe.cjs');
function reportVerdict(input) {
  if (input === undefined || input === null || (typeof input === 'string' && !input.trim()) || (input instanceof Uint8Array && input.length === 0)) return { verdict: null, reason: 'empty' };
  const v = readVerdict(input);
  return { verdict: v.token, reason: v.reason };
}
const REPORT_SLACK_MS = 60000;
function checkReport(io, worktree, expectReport, startedAt) {
  const dir = path.join(worktree, 'docs', 'reviews');
  let names = [];
  try { names = io.readdirSync(dir).filter(n => n.includes(expectReport) && n.endsWith('.md')); } catch { /* no docs/reviews dir */ }
  if (!names.length) return { ok: false, verdict: null, reason: 'missing', file: null };
  const stamp = n => { try { return io.statSync(path.join(dir, n)).mtimeMs; } catch { return 0; } };
  const since = Date.parse(startedAt || '');
  if (!Number.isNaN(since)) {
    const fresh = names.filter(n => stamp(n) >= since - REPORT_SLACK_MS);
    if (!fresh.length) return { ok: false, verdict: null, reason: 'stale', file: [...names].sort((a, b) => stamp(b) - stamp(a))[0] };
    names = fresh;
  }
  const sorted = [...names].sort((a, b) => stamp(b) - stamp(a));
  const file = sorted[0];
  let text;
  try { const g = realInside(path.resolve(worktree), path.join(dir, file), { refuseHardlinks: true }); if (!g.ok) return { ok: false, verdict: null, reason: 'unsafe-path', file }; text = io.readFileSync(g.real); } catch { return { ok: false, verdict: null, reason: 'unreadable', file }; }
  const v = reportVerdict(text);
  if (!Number.isNaN(since) && sorted.length > 1) {
    const verdicts = new Set(sorted.map(n => { try { return (() => { const g = realInside(path.resolve(worktree), path.join(dir, n), { refuseHardlinks: true }); return g.ok ? reportVerdict(io.readFileSync(g.real)).verdict : null; })(); } catch { return null; } }).filter(Boolean));
    if (verdicts.size > 1) return { ok: false, verdict: null, reason: 'ambiguous-reports', file };
  }
  return { ok: v.verdict !== null, verdict: v.verdict, reason: v.reason, file };
}

// ---- vibe turn limit ----
const DEFAULT_VIBE_MAX_TURNS = 200;
// VIBE_MAX_TURNS (an environment NAME; the value is a plain number, never a secret) overrides the 200 turns of vibe for heavy certifications.
function vibeMaxTurns(env) {
  const raw = env && env.VIBE_MAX_TURNS !== undefined ? String(env.VIBE_MAX_TURNS).trim() : '';
  if (raw === '') return { value: DEFAULT_VIBE_MAX_TURNS, invalid: false };
  return /^[1-9]\d{0,3}$/.test(raw) ? { value: Number(raw), invalid: false } : { value: DEFAULT_VIBE_MAX_TURNS, invalid: true };
}
// How vibe -p ends on --max-turns (vibe 2.25.8, vibe/cli/programmatic.py): the turn stops with stop_reason limit; the CLI prints the last assistant text
// (or "The configured conversation limit was reached") on stderr and exits 1. Recognised, in this order, from the session store (stopReason limit),
// the two limit sentences, or exit 1 with the last assistant text repeated after the streamed messages (the only vibe path that prints plain assistant
// text and exits 1; every error path prints an "Error:", "Teleport error:" or "Warning:" prefix). Returns the evidence text, else null.
function vibeTurnLimit({ text, status, stopReason }) {
  if (stopReason === 'limit') return 'session store stopReason=limit';
  const t = String(text || '');
  if (/Turn limit of \d+ reached/.test(t)) return 'sentence "Turn limit of N reached"';
  if (/The configured conversation limit was reached/.test(t)) return 'sentence "The configured conversation limit was reached"';
  if (status !== 1) return null;
  const lines = t.split(/\r?\n/);
  let last = -1; let lastAssistant = '';
  lines.forEach((l, i) => {
    if (l[0] !== '{') return;
    try {
      const j = JSON.parse(l);
      if (j && typeof j === 'object') { last = i; if (j.role === 'assistant' && Array.isArray(j.content)) lastAssistant = j.content.filter(c => c && c.type === 'text').map(c => c.text).join(''); }
    } catch { /* not a message */ }
  });
  const trailing = lines.slice(last + 1).filter(l => l.trim() && !/^Warning:/.test(l)).join('\n').trim();
  if (trailing && lastAssistant.trim() && trailing === lastAssistant.trim() && !/^(Error|Teleport error):/.test(trailing)) return 'exit 1 with the last assistant text repeated on stderr (vibe limit path)';
  return null;
}

// The effort part of the command, from the client registry (P-L3-005). Returns effortArgs() of clients.cjs.
// The project supplies its own registry (PILOT-L4-L6.md); the development registry is never installed.
// A missing or broken registry refuses, with no fallback and no error-message discrimination.
// P-L3-005 Stop conditions also require a present client entry before a task can begin.
// effortArgs retains the registry template and the unknown-effort recording contract.
function effortFor(o, registry) {
  const reg = registry || loadRegistry();
  const cfg = reg.clients && Object.hasOwn(reg.clients, o.client) && reg.clients[o.client];
  if (!cfg || cfg.present !== true) {
    return { ok: false, args: [], effortUsed: null, error: `client ${o.client} is absent or not present in the registry (P-L3-005)` };
  }
  // A known client with no effort setting still records null; absence is a stop, not unknown effort.
  return effortArgs(o.client, o.effort === undefined ? 'high' : o.effort, reg);

}

function buildInvocation(o, env = process.env, packet) {
  const eff = o.effortArgs ? { args: o.effortArgs } : effortFor(o, o.registry);
  const effort = eff.args || [];
  const prompt = o.promptFile.replace(/\\/g, '/');
  const legacyArgText = `Read and execute exactly the task in ${prompt} (targeted only; the LAST line of your report must be the verdict line, for example Verdict: PASS, with one token of PASS, FAIL, BLOCKED or RECOMMENDATION). The environment variable PROTOCOL_NO_FULL_SUITE=1 is set for you.`;
  // One line only: cmd.exe /c ends the command line at the first newline, which silently dropped every argument after
  // argText (the model flag, the tool list, --trust). Any newline inside the pieces is folded to a space as well.
  const argText = (packet ? `${packet.pointerLine} ${legacyArgText}` : legacyArgText).replace(/[\r\n]+/g, ' ');
  const commonEnv = { ...env, PROTOCOL_NO_FULL_SUITE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  if (o.client === 'vibe') return { command: 'cmd.exe', args: ['/c', 'vibe', '-p', argText, '--enabled-tools', 'read_file', '--enabled-tools', 'grep', '--enabled-tools', 'write_file', '--enabled-tools', 'edit', '--enabled-tools', 'bash', '--auto-approve', '--trust', '--max-turns', String(vibeMaxTurns(env).value), '--output', 'streaming', '--workdir', o.worktree], spawnOptions: { cwd: o.worktree, encoding: 'utf8', env: { ...commonEnv, VIBE_ACTIVE_MODEL: servedModelTool.vibeAlias(o.model, o.vibeModels).alias }, maxBuffer: 536870912 }, argText };
  if (o.client === 'codex') return { command: 'cmd.exe', args: ['/c', 'codex', 'exec', '-m', o.model, ...effort, '--approve-for-me', '--skip-git-repo-check', '-C', o.worktree, argText], spawnOptions: { cwd: o.worktree, encoding: 'utf8', env: commonEnv, maxBuffer: 536870912 }, argText };
  if (o.client === 'mimo') return { command: 'cmd.exe', args: ['/c', 'mimo', 'run', argText, '-m', o.model, ...effort, '--yolo', '--format', 'json'], spawnOptions: { cwd: o.worktree, encoding: 'utf8', env: commonEnv, maxBuffer: 536870912 }, argText };
  // agy: the text format (default, byte-identical to before) prints no usage; AGY_OUTPUT_FORMAT=json (environment name) switches to the json format, which
  // carries input, output, thinking and cache tokens (measured 2026-10-10). Changing the default is the owner's call ().
  if (o.client === 'agy') return { command: 'cmd.exe', args: ['/c', 'agy', '--dangerously-skip-permissions', '-p', argText, ...effort, '--output-format', env.AGY_OUTPUT_FORMAT === 'json' ? 'json' : 'text'], spawnOptions: { cwd: o.worktree, encoding: 'utf8', env: commonEnv, maxBuffer: 536870912 }, argText };
  if (o.client === 'dahl') {
    const agent = env.OPENAI_COMPAT_AGENT || path.join(repoPaths.mainRoot(), 'docs', 'research', '2026-09-28-autocycle', 'tools', 'openai-compat-agent.cjs');
    const transcript = o.transcriptFile || path.join(DEFAULT_RUNTIME, `${o.name}-transcript.txt`);
    return { command: 'node', args: [agent, '--model', o.model, '--key-env', 'DAHL_API_KEY', '--prompt-file', o.launchPromptFile || o.promptFile, '--workdir', o.worktree, '--out', transcript, '--max-tokens', o.maxTokens, '--max-steps', '90', '--timeout-ms', '300000', '--allow', 'node', '--allow', 'git'], spawnOptions: { cwd: o.worktree, encoding: 'utf8', env: commonEnv, maxBuffer: 536870912 }, argText };
  }
  return null;
}

function main(argv, deps = {}) {
  const o = options(argv);
  const io = deps.fs || fs;
  const spawnSync = deps.spawnSync || childProcess.spawnSync;
  const runtime = deps.runtimeDir || DEFAULT_RUNTIME;
  const say = deps.say || (line => console.log(line));
  if (!o.client || !o.model || !o.worktree || !o.name || !o.promptFile || !o.expect) {
    (deps.error || console.error)('usage: --client --model --worktree --name --prompt-file --expect-sha');
    return 2;
  }
  if (!confinement.SAFE_SEGMENT.test(o.name)) {
    (deps.error || console.error)('name must be one safe path segment');
    return 2;
  }
  o.vibeModels = deps.vibeModels;
  if (o.client === 'vibe' && !servedModelTool.vibeAlias(o.model, o.vibeModels).known) {
    const known = [...new Set([...(o.vibeModels || []), ...servedModelTool.VIBE_MODELS].map(m => m.alias))].join(', ');
    (deps.error || console.error)(`unknown vibe model "${o.model}": vibe would silently serve its default model. Use one of the aliases (${known}) or a known name; nothing was started`);
    return 2;
  }
  const callFile = path.join(runtime, `${o.name}-call.txt`);
  const done = `${o.name.toUpperCase()}_DONE`;
  if (o.dryRun) { say(`DRY-RUN cert-launch client=${o.client} name=${o.name}`); return 0; }
  try {
    confinement.assertContainedOutput(runtime, callFile, io, true);
    if (o.client === 'dahl') {
      o.transcriptFile = path.join(runtime, `${o.name}-transcript.txt`);
      confinement.assertContainedOutput(runtime, o.transcriptFile, io, true);
    }
  } catch (error) {
    (deps.error || console.error)(`refusing unsafe launcher output: ${error.message}`);
    return 2;
  }
  const git = args => spawnSync('git', args, { cwd: o.worktree, encoding: 'utf8' });
  const head = (git(['rev-parse', '--short', 'HEAD']).stdout || '').trim();
  if (head !== o.expect) {
    io.writeFileSync(callFile, `exit=PREFLIGHT_FAIL head=${head} expected=${o.expect}\n`, 'utf8');
    say(`${done} PREFLIGHT_FAIL`);
    return 2;
  }
  if (Boolean(o.packetRole) !== Boolean(o.packetStage)) { (deps.error || console.error)('--packet-role and --packet-stage must be given together'); return 2; }
  const env = deps.env || process.env;
  const dispatchPacket = env.PROTOCOL_PACKET_ENGINE === 'dispatch';
  if (dispatchPacket && !o.packetRole) { o.packetRole = 'certifier'; o.packetStage = 'accept'; }
  let packet = null;
  if (o.packetRole) {
    const packetTool = deps.launchPacket || require('./launch-packet.cjs');
    const gate = dispatchPacket ? confinement.deliveryPolicy(env, o.packetRole, o.allowExecutorPacket)
      : packetTool.policy(env.OPERATOR_PACKET, o.packetRole, o.allowExecutorPacket);
    if (gate.refused) { say(`PACKET REFUSED reason=${gate.refused}; nothing was started`); return 3; }
    if (gate.active) {
      try {
        packet = packetTool.preparePacket({ worktree: o.worktree, role: o.packetRole, stage: o.packetStage, frame: o.packetFrame, profile: o.packetProfile, client: o.client });
        if (o.client === 'dahl') {
          const dir = path.join(o.worktree, '.ai', 'runtime', 'launch-prompts');
          o.launchPromptFile = path.join(dir, `${o.name}.md`);
          confinement.writeContainedFile(o.worktree, o.launchPromptFile, `${packet.pointerLine}\n\n${io.readFileSync(o.promptFile, 'utf8')}`, io);
        }
      } catch (error) { say(dispatchPacket ? 'PACKET REFUSED reason=packet-compile-failed; nothing was started' : `PACKET REFUSED reason=${error.message}; nothing was started`); return 3; }
    }
  }
  const turns = vibeMaxTurns(env);
  if (o.client === 'vibe' && turns.invalid) say('WARN VIBE_MAX_TURNS ignored (not a whole number from 1 to 9999); the default of 200 turns applies');
  let eff;
  try { eff = effortFor(o, deps.registry); } catch (error) { say(`EFFORT REFUSED reason=registry unavailable (${error.message}); nothing was started`); return 2; }
  if (!eff.ok) { say(`EFFORT REFUSED reason=${eff.error} (P-L3-005 R-L3-005.7); nothing was started`); return 2; }
  o.effortArgs = eff.args;
  const heartbeat = deps.heartbeat || repoPaths.heartbeatFor(runtime, say);
  const hb = heartbeat.start(o.name);
  const startedAt = (deps.now || (() => new Date()))().toISOString();
  const invocation = buildInvocation(o, env, packet);
  if (!invocation) { (deps.error || console.error)(`unknown client ${o.client}`); return 2; }
  // the resolver's shadow answer, recorded before the client starts; it never changes the invocation built above
  try {
    const shadowTool = deps.resolverShadow || require('./resolver-shadow.cjs');
    let launchId = null; try { launchId = require('../../.ai/bin/launch-record.cjs').buildLaunchRecord({ name: o.name, startedAt }).launchId; } catch { /* no id */ }
    shadowTool.record({ launcher: 'cert-launch', name: o.name, launchId, role: packet ? packet.role : 'certifier', tier: o.tier, stageKind: 'certification', operator: { client: o.client, model: o.model, effort: eff.effortUsed } }, { runtimeDir: runtime, now: () => new Date(startedAt) });
  } catch { /* the shadow never blocks a launch */ }
  const result = spawnSync(invocation.command, invocation.args, invocation.spawnOptions);
  heartbeat.stop(hb);
  const report = o.expectReport ? checkReport(io, o.worktree, o.expectReport, startedAt) : { ok: true, verdict: null, reason: null, file: null };
  const reportOk = report.ok;
  const reportWord = o.expectReport ? ` report=${reportOk ? 'ok' : 'NO_VERDICT'}` : '';
  const endedAt = (deps.now || (() => new Date()))().toISOString();
  const captured = `${result.stdout || ''}${result.stderr || ''}`;
  // D9 (PROTO-DEC-0169 item 4): which model actually answered, from a source outside the report. Advisory: a failed
  // derivation changes neither the exit code nor the markers; the SERVED line sits before the terminal marker line.
  let servedFields = {}; let servedText = ''; let mismatch = null; let servedNote = '';
  try {
    const sm = deps.servedModel || servedModelTool;
    const served = sm.deriveServedModel({ client: o.client, requestedModel: o.model, capturedOutput: captured, startedAt, endedAt, logDir: env.MIMOCODE_LOG_DIR, workdir: o.worktree, vibeModels: o.vibeModels }, env);
    servedFields = sm.recordFields(served); servedText = sm.servedLine(served);
    servedNote = (sm.servedNote && sm.servedNote(served)) || '';
    if (served.match === false && served.servedModel && served.confidence !== 'none') mismatch = served;
  } catch { servedFields = {}; servedText = ''; mismatch = null; servedNote = ''; }
  const mismatchText = mismatch ? `SERVED_MODEL_MISMATCH requested=${o.model} served=${mismatch.servedModel} source=${mismatch.source}; the launch is not a verdict` : '';
  const marker = mismatch ? done.replace(/_DONE$/, '_SERVED_MODEL_MISMATCH') : (reportOk ? done : done.replace(/_DONE$/, '_NO_VERDICT'));
  // Tokens and cost (cost-record): from the output the client printed or its own session store; unknown is never zero; advisory, never changes the exit.
  let usage = { fields: {}, info: {} }; let usageText = '';
  try {
    const writer = deps.usageTool || require('../../.ai/bin/launch-record.cjs');
    usage = writer.usageRecordFields({ client: o.client, model: o.model, servedModel: servedFields.servedModel, output: captured, endedAt, env }, deps.usage || {});
    usageText = (writer.usageLine && writer.usageLine(usage.fields)) || '';
  } catch (e) { usage = { fields: unknownUsageFields(e), info: {} }; usageText = ''; }
  let limitEvidence = null;
  try { if (o.client === 'vibe') limitEvidence = vibeTurnLimit({ text: captured, status: result.status, stopReason: usage.info && usage.info.stopReason }); } catch { limitEvidence = null; }
  const limitText = limitEvidence ? `TURN_LIMIT client=vibe max=${turns.value} evidence=${limitEvidence}` : '';
  const reportText = o.expectReport && !reportOk ? `REPORT verdict=none reason=${report.reason}${report.file ? ` file=${report.file}` : ''}` : '';
  const failureClass = mismatch ? 'SERVED_MODEL_MISMATCH' : limitEvidence ? 'TURN_LIMIT' : (!reportOk ? 'NO_VERDICT' : undefined);
  // agy answers in json: the call file keeps the answer text readable (the json stays in the client's own store)
  const body = o.client === 'agy' && usage.info && usage.info.resultText !== null && usage.info.resultText !== undefined ? usage.info.resultText : captured;
  let recordFailed = '';
  try {
    const writer = deps.launchRecord || require('../../.ai/bin/launch-record.cjs');
    // A fixed reason also survives subscription pricing; arbitrary usage errors
    // are never copied into this note.
    const paths = require('../../.ai/bin/launch-record.cjs').recordPaths(o.worktree, o.launchPromptFile || o.promptFile);
    writer.writeLaunchRecord({ client: o.client, model: o.model, effort: eff.effortUsed, role: packet ? packet.role : 'certifier', stage: packet ? packet.stage : 'accept', taskClass: 'A', route: `cli:${o.client}`, riskClass: 'A', name: o.name, ...paths, head, exitCode: reportOk && !mismatch ? result.status : 3, startedAt, failureClass, note: [o.expectReport ? `report=${reportOk ? 'ok' : `NO_VERDICT reason=${report.reason}`}` : '', mismatch ? `served-model-mismatch served=${mismatch.servedModel}` : '', servedNote, o.client === 'agy' && !usage.fields.tokens ? 'usage-unknown reason=no-complete-usage-evidence confidence=unknown' : ''].filter(Boolean).join(' ') || undefined,
      ...(packet ? { packetHash: packet.packetHash, packetProfile: packet.profile, packetBytes: packet.bytes, packetEstTokens: packet.estTokens } : {}), ...servedFields, ...usage.fields });
  } catch (e) { recordFailed = recordFailedLine(e); }
  if (recordFailed) (deps.error || console.error)(recordFailed);
  const extra = [limitText, reportText, usageText, mismatchText, servedText, recordFailed].filter(Boolean).map(l => `${l}\n`).join('');
  io.appendFileSync(callFile, `marker=${marker}\n${body}\n${extra}${marker} exit=${result.status}${reportWord} end=${endedAt}\n`, 'utf8');
  for (const line of [limitText, reportText, usageText, mismatchText, servedText]) if (line) say(line);
  say(`${marker} exit=${result.status}${reportWord}`);
  return !reportOk || mismatch ? 3 : (result.status === null ? 1 : result.status);
}

module.exports = { DEFAULT_RUNTIME, value, options, effortFor, buildInvocation, main, reportVerdict, checkReport, vibeMaxTurns, vibeTurnLimit };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

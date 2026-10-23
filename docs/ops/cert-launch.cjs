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
const LAUNCH_ROLES = ['author', 'certifier', 'pre-review', 'unknown'];
const unknownUsageFields = e => ({ tokens: null, cost: { usd: null, basis: 'unknown', priceSnapshot: null, formula: null, reason: `usage derivation failed: ${String((e && e.message) || e).slice(0, 200)}` } });
// The one line of a failed launch-record write (stderr and call file); the code is the error code (ENOSPC, EACCES, ...) reduced to safe characters.
const recordFailedLine = e => `RECORD-WRITE-FAILED code=${String((e && e.code) || 'UNKNOWN').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'UNKNOWN'}`;

function value(argv, name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
}

// The client and model come from the one reader the recovery and the route step of launch-wrapper use (both forms;
// a repeat, a missing value or another spelling is refused with its named reason).
const { identity: seatIdentity, spawnClient } = require('./seat-failover.cjs'); // at module load: a plan that reads options() loads no module
function options(argv) {
  const stated = seatIdentity(argv);
  if (stated.problem) throw new Error(stated.problem);
  return {
    client: stated.client, model: stated.model, worktree: value(argv, 'worktree'),
    name: value(argv, 'name'), promptFile: value(argv, 'prompt-file'), expect: value(argv, 'expect-sha'),
    argsFile: value(argv, 'args-file', ''), maxTokens: value(argv, 'max-tokens', '16000'),
    expectReport: value(argv, 'expect-report', ''), dryRun: argv.includes('--dry-run'),
    packetRole: value(argv, 'packet-role'), packetStage: value(argv, 'packet-stage'),
    packetFrame: value(argv, 'packet-frame'), packetProfile: value(argv, 'packet-profile'),
    allowExecutorPacket: argv.includes('--allow-executor-packet'),
    effort: value(argv, 'effort', 'high'), tier: value(argv, 'tier', 'T7'),
    // no silent default: a launch whose role the caller did not state is recorded as unknown, never as a certifier launch
    launchRole: value(argv, 'launch-role', 'unknown'),
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
// Each attempt snapshots names, sizes, mtimes and bytes before invoking the client.
// Equal timestamps alone cannot attribute an earlier route's report to this route.
function snapshotReports(io, worktree, expectReport) {
  const dir = path.join(worktree, 'docs', 'reviews');
  let names;
  try { names = io.readdirSync(dir).filter(n => n.includes(expectReport) && n.endsWith('.md')); }
  catch (e) { return e.code === 'ENOENT' ? new Map() : null; }
  const reports = new Map();
  for (const name of names) {
    try {
      const g = realInside(path.resolve(worktree), path.join(dir, name), { refuseHardlinks: true });
      if (!g.ok) { reports.set(name, { unsafe: true }); continue; }
      const stat = io.statSync(g.real);
      reports.set(name, { size: stat.size, mtimeMs: stat.mtimeMs, hash: require('node:crypto').createHash('sha256').update(io.readFileSync(g.real)).digest('hex') });
    } catch { return null; }
  }
  return reports;
}
function checkReport(io, worktree, expectReport, startedAt, before) {
  const dir = path.join(worktree, 'docs', 'reviews');
  let names = [];
  try { names = io.readdirSync(dir).filter(n => n.includes(expectReport) && n.endsWith('.md')); } catch { /* no docs/reviews dir */ }
  if (!names.length) return { ok: false, verdict: null, reason: 'missing', file: null };
  const stamp = n => { try { return io.statSync(path.join(dir, n)).mtimeMs; } catch { return 0; } };
  const since = Date.parse(startedAt || '');
  if (!Number.isNaN(since)) {
    const after = before === undefined ? undefined : snapshotReports(io, worktree, expectReport);
    if (before === null || after === null) return { ok: false, verdict: null, reason: 'unreadable-snapshot', file: null };
    const unsafe = names.find(n => after?.get(n)?.unsafe);
    if (unsafe) return { ok: false, verdict: null, reason: 'unsafe-path', file: unsafe };
    const fresh = names.filter(n => stamp(n) >= since && (before === undefined || (after.has(n) && after.get(n).hash && before.get(n)?.hash !== after.get(n).hash)));
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
  // The client is spawned WITHOUT a text encoding (encoding 'buffer'): its stdout and stderr stay
  // BYTES all the way to the strict decode inside the ONE derivation path (deriveForLaunch decodes them; nothing here decodes a stream).
  const eff = o.effortArgs ? { args: o.effortArgs } : effortFor(o, o.registry);
  const effort = eff.args || [];
  const prompt = o.promptFile.replace(/\\/g, '/');
  const legacyArgText = `Read and execute exactly the task in ${prompt} (run affected tests with node .ai/bin/protocol-test.cjs --root . --affected {baseRef}; the full suite runs in the landing train; the LAST line of your report must be the verdict line, for example Verdict: PASS, with one token of PASS, FAIL, BLOCKED or RECOMMENDATION). The environment variable PROTOCOL_NO_FULL_SUITE=1 is set for you.`;
  // One line only: cmd.exe /c ends the command line at the first newline, which silently dropped every argument after
  // argText (the model flag, the tool list, --trust). Any newline inside the pieces is folded to a space as well.
  const argText = (o.instructionText ?? (packet ? `${packet.pointerLine} ${legacyArgText}` : legacyArgText)).replace(/[\r\n]+/g, ' ');
  const commonEnv = { ...env, PROTOCOL_NO_FULL_SUITE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  if (o.client === 'claude') return { command: 'cmd.exe', args: ['/c', 'claude', '--model', o.model, ...effort, '--dangerously-skip-permissions', '-p', argText], spawnOptions: { cwd: o.worktree, encoding: 'buffer', env: commonEnv, maxBuffer: 536870912 }, argText };
  if (o.client === 'kilo') return { command: 'cmd.exe', args: ['/c', 'kilo', 'run', '-m', o.model, ...effort, '--auto', '--dir', o.worktree, '--format', 'json', argText], spawnOptions: { cwd: o.worktree, encoding: 'buffer', env: commonEnv, maxBuffer: 536870912 }, argText };
  if (o.client === 'vibe') return { command: 'cmd.exe', args: ['/c', 'vibe', '-p', argText, '--enabled-tools', 'read_file', '--enabled-tools', 'grep', '--enabled-tools', 'write_file', '--enabled-tools', 'edit', '--enabled-tools', 'bash', '--auto-approve', '--trust', '--max-turns', String(vibeMaxTurns(env).value), '--output', 'streaming', '--workdir', o.worktree, ...(o.exportDir ? ['--output-dir', o.exportDir] : [])], spawnOptions: { cwd: o.worktree, encoding: 'buffer', env: { ...commonEnv, VIBE_ACTIVE_MODEL: servedModelTool.vibeAlias(o.model, o.vibeModels).alias }, maxBuffer: 536870912 }, argText };
  if (o.client === 'codex') return { command: 'cmd.exe', args: ['/c', 'codex', 'exec', '-m', o.model, ...effort, ...(env.COLABUS_SEAT_MCP === '1' ? [] : ['--ignore-user-config', '-c', 'sandbox_mode=workspace-write', '-c', 'windows.sandbox=unelevated']), '--approve-for-me', '--skip-git-repo-check', '-C', o.worktree, argText], spawnOptions: { cwd: o.worktree, encoding: 'buffer', env: commonEnv, maxBuffer: 536870912 }, argText };
  if (o.client === 'mimo') return { command: 'cmd.exe', args: ['/c', 'mimo', 'run', argText, '-m', o.model, ...effort, '--yolo', '--format', 'json'], spawnOptions: { cwd: o.worktree, encoding: 'buffer', env: commonEnv, maxBuffer: 536870912 }, argText };
  // agy: --model is passed explicitly: without it the seat would run on the CLI default while the record named o.model. agy prints no served-model
  // field of its own; PROTO-DEC-0209 makes the explicit --model the launcher passed the structured source of agy (served-model.cjs reads requestedModelVia).
  // agy: the text format (default, byte-identical to before) prints no usage; AGY_OUTPUT_FORMAT=json (environment name) switches to the json format, which
  // carries input, output, thinking and cache tokens. Changing the default is the owner's call.
  if (o.client === 'agy') return { command: 'cmd.exe', args: ['/c', 'agy', '--dangerously-skip-permissions', '--model', o.model, '-p', argText, ...effort, '--output-format', env.AGY_OUTPUT_FORMAT === 'json' ? 'json' : 'text'], spawnOptions: { cwd: o.worktree, encoding: 'buffer', env: commonEnv, maxBuffer: 536870912 }, argText };
  // qwen (Qwen Code on the DashScope free quota): the prompt goes by stdin, the model is explicit, the key comes from the User environment; docs/ops/qwen-client.cjs.
  if (o.client === 'qwen') return require('./qwen-client.cjs').buildInvocation(o, argText, commonEnv);
  if (o.client === 'dahl') {
    const agent = env.OPENAI_COMPAT_AGENT || path.join(repoPaths.mainRoot(), 'tools', 'openai-compat-agent.cjs');
    const transcript = o.transcriptFile || path.join(DEFAULT_RUNTIME, `${o.name}-transcript.txt`);
    return { command: 'node', args: [agent, '--model', o.model, '--key-env', 'DAHL_API_KEY', '--prompt-file', o.launchPromptFile || o.promptFile, '--workdir', o.worktree, '--out', transcript, '--max-tokens', o.maxTokens, '--max-steps', '90', '--timeout-ms', '300000', '--allow', 'node', '--allow', 'git'], spawnOptions: { cwd: o.worktree, encoding: 'buffer', env: commonEnv, maxBuffer: 536870912 }, argText };
  }
  // kimi (measured on Kimi Code 2.1.1): -p runs one prompt headless and refuses --auto and --yolo (it sets auto itself: file and shell tools work);
  // -m takes the alias of the private config.toml the launcher generates (kimi-code/<model> is the subscription; a moonshot-ai alias is refused in launchOnce and is not in that config); the stream-json format
  // keeps the answer machine-readable in the call file. The explicit -m is the proof of the served model (PROTO-DEC-0211); nothing the client prints or stores is read for the
  // model or for tokens. The working directory is the process cwd (no flag). The command here is the logical name: launchOnce replaces it with the client resolved ONCE to an absolute path (kimi-route.cjs resolveLaunch).
  if (o.client === 'kimi') return { command: 'kimi', args: ['-m', o.model, '-p', argText, '--output-format', 'stream-json'], spawnOptions: { cwd: o.worktree, encoding: 'buffer', env: commonEnv, maxBuffer: 536870912 }, argText };
  return null;
}

// A main checkout keeps .git as a directory (a linked worktree has a .git file); only a main checkout can hold the codex trust that --ignore-user-config drops.
function isMainCheckout(worktree, io) {
  try { return io.statSync(path.join(worktree, '.git')).isDirectory(); } catch { return false; }
}

function main(argv, deps = {}) {
  return require('./seat-failover.cjs').run(argv, deps, launchOnce, 'cert');
}

function launchOnce(argv, deps = {}) {
  const o = options(argv);
  o.seatFallback = deps.seatFallback === true;
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
  // Launch record extension: the role of this launch for the record (author | certifier | pre-review), checked before anything starts
  if (!LAUNCH_ROLES.includes(o.launchRole)) {
    (deps.error || console.error)(`--launch-role must be one of ${LAUNCH_ROLES.join(', ')}; nothing was started`);
    return 2;
  }
  o.vibeModels = deps.vibeModels;
  if (o.client === 'vibe' && !servedModelTool.vibeAlias(o.model, o.vibeModels).known) {
    const known = [...new Set([...(o.vibeModels || []), ...servedModelTool.VIBE_MODELS].map(m => m.alias))].join(', ');
    (deps.error || console.error)(`unknown vibe model "${o.model}": vibe would silently serve its default model. Use one of the aliases (${known}) or a known name; nothing was started`);
    return 2;
  }
  if (o.client === 'qwen') {
    const pf = require('./qwen-client.cjs').preflight(o, deps, { env: deps.env || process.env, runtime, dryRun: o.dryRun });
    if (!pf.ok) { say(`QWEN REFUSED reason=${pf.reason}; nothing was started`); return 2; }
    for (const w of pf.warnings || []) say(w);
  }
  const callFile = path.join(runtime, `${o.name}-call.txt`);
  const done = `${o.name.toUpperCase()}_DONE`;
  // kimi: only the subscription route may start, and it is fixed BY CONSTRUCTION (PROTO-DEC-0211 item 1, PROTO-DEC-0212): the client is started on a private config
  // generated by the launcher from a fixed template (kimi-route.cjs), never on the user's own config, which is not read. Here only the checks that have no side effect run: a
  // moonshot-ai or malformed alias and a missing subscription login are refused BEFORE anything starts (exit 2); the private directory is made just before the start.
  const kimiRoute = o.client === 'kimi' ? (deps.kimiRoute || require('./kimi-route.cjs')) : null;
  const refuseKimi = route => { const text = require('./kimi-route.cjs').safeText; (deps.error || console.error)(`KIMI REFUSED reason=${text(route.reason, 80)}: ${text(route.detail || 'the route is not the Kimi Code subscription', 400)}; nothing was started`); return 2; };
  const env = deps.env || process.env;
  // kimi: the client is resolved ONCE to an absolute path before any key or config read, before the dry run and before the private directory is made or anything is started;
  // a failure refuses the launch with its fixed reason; the dry run takes the same resolution path, so an unresolvable client stops it too.
  const kc = kimiRoute ? (kimiRoute.resolveLaunch || require('./kimi-route.cjs').resolveLaunch)({ env, platform: deps.platform, worktree: o.worktree, tmpRoot: deps.tmpRoot }) : null;
  // a dry run reports the same resolution refusal as a real launch, before anything else is read or created.
  if (o.dryRun && kc && !kc.ok) { say(`DRY-RUN REFUSED ${kc.reason}`); return 2; }
  if (kc && !kc.ok) return refuseKimi(kc);
  if (kimiRoute) {
    let route;
    try { route = kimiRoute.check({ model: o.model, env, fs: io, osHome: deps.kimiOsHome }); } catch (error) { route = { ok: false, reason: 'private-home-unavailable', detail: `the route check failed (${(error && error.code) || 'error'})` }; }
    if (!route.ok) return refuseKimi(route);
  }
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
  // qwen: git is the absolute path the resolver found (never a bare name, never the worktree), with the child environment that does not search the current directory
  const git = args => spawnSync(o.client === 'qwen' ? o.qwen.git : 'git', args, { cwd: o.worktree, encoding: 'utf8', ...(o.client === 'qwen' ? { env: o.qwen.toolEnv } : {}) });
  const head = (git(['rev-parse', ...(/^[a-f0-9]{40}$/.test(o.expect) ? [] : ['--short']), 'HEAD']).stdout || '').trim();
  if (head !== o.expect) {
    io.writeFileSync(callFile, `exit=PREFLIGHT_FAIL head=${head} expected=${o.expect}\n`, 'utf8');
    say(`${done} PREFLIGHT_FAIL`);
    return 2;
  }
  if (Boolean(o.packetRole) !== Boolean(o.packetStage)) { (deps.error || console.error)('--packet-role and --packet-stage must be given together'); return 2; }
  // Launch isolation (docs/ops/lib/work-root.cjs): the work root of this launcher's repository is enforced for every launched child; TEMP, TMP, TMPDIR
  // and the toolchain caches point inside a per-launch directory created FRESH for this launch (an inherited TEMP that carries the marker of an
  // earlier run is not accepted again) with every cache directory created fresh and exclusively inside it, marker-kept for retention. A refusal
  // starts nothing and names the reason and the recovery line.
  const workTool = deps.workRoot || require('./lib/work-root.cjs');
  const work = workTool.kernelWorkEnv({ repo: path.resolve(__dirname, '..', '..'), name: o.name, env, io });
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
  const dispatchPacket = env.PROTOCOL_PACKET_ENGINE === 'dispatch';
  if (dispatchPacket && !o.packetRole) { o.packetRole = deps.seatRole || 'certifier'; o.packetStage = deps.seatRole === 'fixer' ? 'execute' : 'accept'; }
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
  if (o.client === 'codex' && env.COLABUS_SEAT_MCP !== '1' && isMainCheckout(o.worktree, io)) say('WARN codex seat in a main checkout: --ignore-user-config drops the trusted [projects] entry and [hooks.state], so the repository hooks will not run; use a worktree or COLABUS_SEAT_MCP=1');
  let eff;
  try { eff = effortFor(o, deps.registry); } catch (error) { say(`EFFORT REFUSED reason=registry unavailable (${error.message}); nothing was started`); return 2; }
  if (!eff.ok) { say(`EFFORT REFUSED reason=${eff.error} (P-L3-005 R-L3-005.7); nothing was started`); return 2; }
  o.effortArgs = eff.args;
  // PROTO-DEC-0215 item 1: the launcher creates a NEW EMPTY directory per launch (mkdtemp under the launch runtime, drive D) and passes it by
  // --output-dir; the served model is later read only from its export.json. A directory that cannot be created refuses the launch before
  // anything starts: a vibe launch without its export directory can never prove its served model.
  if (o.client === 'vibe') {
    try { o.exportDir = io.mkdtempSync(path.join(runtime, 'launch-export-')); }
    catch (error) { say(`EXPORT-DIR-FAILED code=${String((error && error.code) || 'UNKNOWN').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'UNKNOWN'}; nothing was started`); return 2; }
  }
  const reportsBefore = o.expectReport ? snapshotReports(io, o.worktree, o.expectReport) : undefined;
  // kimi: the private config directory of this launch, after every other refusal and before the heartbeat; the whole life cycle (prepare, the one cleanup of every refusal path,
  // the checks before the start and after the exit) is kimi-route.cjs launchSession; this file holds only the call sites
  const kg = kimiRoute ? (kimiRoute.launchSession || require('./kimi-route.cjs').launchSession)(kimiRoute, { model: o.model, env, fs: io, tmpRoot: deps.tmpRoot, osHome: deps.kimiOsHome, platform: deps.platform, error: deps.error || console.error }) : null;
  if (kg) { const route = kg.prepare(); if (!route.ok) return refuseKimi(route); o.kimiRoute = route; }
  const guarded = kg ? kg.guarded : fn => fn();
  const heartbeat = deps.heartbeat || repoPaths.heartbeatFor(runtime, say);
  const hb = guarded(() => heartbeat.start(o.name));
  let startedAt = (deps.now || (() => new Date()))().toISOString();
  // Wrapped launches bind metadata to the existing running marker. Direct-launch call contracts stay intact.
  const cycleControl=env.CYCLE_CONTROL==='1' && env.LAUNCH_WRAPPER_NAME===o.name;
  if(cycleControl) {
    let marker=null;
    try { marker=require('../../tools/cycle/reader.cjs').json(path.join(runtime,`${o.name}.running.json`),'seat'); } catch { /* unavailable means no attribution */ }
    if(marker?.name===o.name && marker.worktree===path.resolve(o.worktree) && marker.startedAt && !marker.ended) {
      startedAt=marker.startedAt;
      guarded(()=>io.appendFileSync(callFile, `CYCLE_CALL ${JSON.stringify({name:o.name,startedAt,client:o.client,role:o.launchRole})}\n`, 'utf8'));
    }
  }
  const invocation = guarded(() => buildInvocation(o, work.env, packet));
  // kimi: the child gets the private home and no KIMI_* variable of the caller; the user's home, config and variables are out of the route
  if (invocation && kg) invocation.spawnOptions = { ...invocation.spawnOptions, env: kg.childEnv(invocation.spawnOptions.env) };
  // kimi: the spawn uses the resolved absolute path (a shim through the absolute command interpreter), never the bare name
  if (invocation && kg) { invocation.args = [...kc.prefix, ...invocation.args]; invocation.command = kc.command; }
  // Legacy primary argv stays pinned. A substituted agy route must explicitly
  // select its requested model rather than inherit the client's current model.
  if (invocation && o.client === 'agy' && o.seatFallback) invocation.args.push('--model', o.model);
  if (!invocation) { (deps.error || console.error)(`unknown client ${o.client}`); return 2; }
  // the resolver's shadow answer, recorded before the client starts; it never changes the invocation built above
  try {
    const shadowTool = deps.resolverShadow || require('./resolver-shadow.cjs');
    let launchId = null; try { launchId = require('../../.ai/bin/launch-record.cjs').buildLaunchRecord({ name: o.name, startedAt }).launchId; } catch { /* no id */ }
    shadowTool.record({ launcher: 'cert-launch', name: o.name, launchId, role: packet ? packet.role : 'certifier', tier: o.tier, stageKind: 'certification', operator: { client: o.client, model: o.model, effort: eff.effortUsed } }, { runtimeDir: runtime, now: () => new Date(startedAt) });
  } catch { /* the shadow never blocks a launch */ }
  // kimi (PROTO-DEC-0217 item 2): the private config still has the recorded sha256 and file identity; a mismatch refuses the launch and removes the directory
  if (kg) { const before = kg.preSpawn(io); if (before) { heartbeat.stop(hb); return refuseKimi(before); } }
  // qwen: the private settings of the route are made immediately before the start (G1, PROTO-DEC-0212)
  if (o.client === 'qwen') {
    if (invocation.refused) { heartbeat.stop(hb); say(`QWEN REFUSED reason=${invocation.refused}; nothing was started`); return 2; }
    if (!invocation.command) { heartbeat.stop(hb); say('QWEN REFUSED reason=the client was not resolved to an absolute path; nothing was started'); return 2; }
    const gate = require('./qwen-client.cjs').recheck(o); if (!gate.ok) { heartbeat.stop(hb); say(`QWEN REFUSED reason=${gate.reason}; nothing was started`); return 2; }
  }
  // qwen: a spawn that throws is a client that never started (the private directories are still removed by afterRun)
  // kimi: the snapshot of the spawn result is what the check after the exit reads; the guarded wrapper is the kimi life cycle
  // The client starts only through the one spawn point (seat-failover spawnClient): the route of o.client and o.model is decided and recorded
  // immediately before the spawn, on every attempt; a refused route starts nothing and returns the result of a client that never started. The first
  // route was already decided by seat-failover run before anything of the launch existed and is handed to the spawn point.
  // kimi: the snapshot of the spawn result is taken inside the spawn point (seat.snapshot), so the check after the exit reads plain data
  const seat = { client: o.client, model: o.model, deps, env, say, io, callFile, snapshot: kg ? kg.snapshot : undefined };
  let result;
  if (o.client === 'qwen') { try { result = spawnClient(seat, invocation, spawnSync); } catch (error) { result = { error, status: null, stdout: null, stderr: null }; } }
  else result = guarded(() => spawnClient(seat, invocation, spawnSync));
  // kimi: the check after the exit; a client that never started, gave no numeric exit status or ended with a non-zero one is unproven (fixed reason) and its directory is removed too
  const kimiAfter = kg ? kg.afterRun(io, result) : null;
  heartbeat.stop(hb);
  if (result.routeRefusal) {
    // qwen: its private directories are removed as after any run (afterRun reads no output); kimi's went with afterRun above
    if (o.client === 'qwen') { try { require('./qwen-client.cjs').afterRun(o, io, result); } catch { /* the cleanup never hides the refusal */ } }
    const refusedMarker = done.replace(/_DONE$/, '_ROUTE_REFUSED');
    io.appendFileSync(callFile, `marker=${refusedMarker}\n${refusedMarker} exit=3 reason=${result.routeRefusal.code} end=${(deps.now || (() => new Date()))().toISOString()}\n`, 'utf8');
    say(`${refusedMarker} exit=3 reason=${result.routeRefusal.code}; the client was not started`);
    return 3;
  }
  const report = o.expectReport ? checkReport(io, o.worktree, o.expectReport, startedAt, reportsBefore) : { ok: true, verdict: null, reason: null, file: null };
  const reportOk = report.ok;
  const reportWord = o.expectReport ? ` report=${reportOk ? 'ok' : 'NO_VERDICT'}` : '';
  const endedAt = (deps.now || (() => new Date()))().toISOString();
  // The ONE derivation path deriveForLaunch(context) reads the launch that really ran - the
  // argv and the spawn environment the client was started with, the export directory of a vibe launch, the streams it captured - and returns
  // requestedModelVia and the served-model proof TOGETHER (PROTO-DEC-0209: the explicit --model the launcher passed is the structured source of
  // agy). No call of requestedModelVia or deriveServedModel remains here: no caller can hand the derivation a partial argument list.
  // The stream fields are the BYTES spawnSync returned (encoding 'buffer'); the entry point is the ONLY decode, and every text
  // this launcher shows or derives usage from below (the call file body, the usage, the turn-limit evidence) is the DECODED text the entry
  // point returned AFTER the check - never a decode of its own. A stream the decode refused is named by the fixed marker STREAM-REFUSED.
  // The record fields, the SERVED line and the note travel inside the one return (record, line, note); recordFields, servedLine
  // and servedNote are private exports of the derivation module no more.
  // qwen: the structured facts of the run (exit status, byte count and sha256 of each stream), the fault of a run that did not end cleanly and the route verdict; the private
  // directories are removed. NO text of the client output is kept or read anywhere (G3, G4; PROTO-DEC-0211, 0217): the captured text of a qwen launch is empty
  const qwenRun = o.client === 'qwen' ? require('./qwen-client.cjs').afterRun(o, io, result) : null;
  let served = null; let servedFields = {}; let servedText = ''; let mismatch = null; let servedNote = ''; let streamRefused = '';
  try {
    const sm = deps.servedModel || servedModelTool;
    // qwen: the streams are never handed over (their text is not read and not kept, G3/G4); the run's route and client fault travel with the derivation instead,
    // and the launcher states the flag fact it made itself (the cmd.exe shim collapses the child command line into one argv piece).
    // kimi (PROTO-DEC-0211): the route object the launcher prepared and the check made after the exit travel in the same context, so the served
    // model stays the explicit -m over the private subscription config; no file or output of the client is read for the model.
    served = sm.deriveForLaunch({ client: o.client, model: o.model, args: invocation.args, env: invocation.spawnOptions && invocation.spawnOptions.env, stdout: qwenRun ? null : result.stdout, stderr: qwenRun ? null : result.stderr, startedAt, endedAt, workdir: o.worktree, exportDir: o.exportDir, vibeModels: o.vibeModels, ...(qwenRun ? { requestedModelVia: 'flag', qwenRoute: qwenRun.route, qwenClientFault: qwenRun.clientFault } : {}), kimiRoute: o.kimiRoute, kimiConfigCheck: kimiAfter });
    servedFields = served.record || {}; servedText = served.line || '';
    servedNote = served.note || '';
    if (served.match === false && served.servedModel && served.confidence !== 'none') mismatch = served;
    if (Array.isArray(served.refusedStreams) && served.refusedStreams.length) streamRefused = `STREAM-REFUSED streams=${served.refusedStreams.join(',')}`;
  } catch { served = null; servedFields = {}; servedText = ''; mismatch = null; servedNote = ''; streamRefused = ''; }
  // qwen (guarantee G5 of its client): a route that did not hold for the whole run proves nothing, whatever the derivation said; the SERVED line and the record stay silent about it
  if (qwenRun && qwenRun.routeFault) { mismatch = { servedModel: 'unproven', source: 'route-changed' }; servedFields = {}; servedText = ''; servedNote = `route-changed ${qwenRun.routeFault}`; }
  const decodedStreams = served && served.decoded ? served.decoded : {};
  // qwen: the captured text of the run stays empty (no text of the client output is read or kept; the call file carries the structured facts line instead)
  const captured = qwenRun ? '' : `${typeof decodedStreams.stdout === 'string' ? decodedStreams.stdout : ''}${typeof decodedStreams.stderr === 'string' ? decodedStreams.stderr : ''}`;
  const provenance = { requestedModelVia: served ? served.requestedModelVia : undefined, launchRole: o.launchRole };
  const mismatchText = mismatch ? `SERVED_MODEL_MISMATCH requested=${o.model} served=${mismatch.servedModel} source=${mismatch.source}; the launch is not a verdict` : '';
  const marker = mismatch ? done.replace(/_DONE$/, '_SERVED_MODEL_MISMATCH') : (reportOk && !(kimiAfter && kimiAfter.notRun) ? done : done.replace(/_DONE$/, '_NO_VERDICT'));
  // Tokens and cost (cost-record): from the output the client printed or its own session store; unknown is never zero; advisory, never changes the exit.
  let usage = { fields: {}, info: {} }; let usageText = '';
  try {
    const writer = deps.usageTool || require('../../.ai/bin/launch-record.cjs');
    usage = writer.usageRecordFields({ client: o.client, model: o.model, servedModel: servedFields.servedModel, output: captured, endedAt, env }, deps.usage || {});
    usageText = (writer.usageLine && writer.usageLine(usage.fields)) || '';
  } catch (e) { usage = { fields: unknownUsageFields(e), info: {} }; usageText = ''; }
  // qwen (PROTO-DEC-0211): tokens are not counted for this client; the cost is the free quota when the pinned route held (qwen-client.cjs freeQuotaCost), never a priced number
  if (o.client === 'qwen') { try { usage = require('./qwen-client.cjs').usageFields({ model: o.model, servedModel: servedFields.servedModel }); usageText = require('../../.ai/bin/launch-record.cjs').usageLine(usage.fields) || ''; } catch (e) { usage = { fields: unknownUsageFields(e), info: {} }; usageText = ''; } }
  let limitEvidence = null;
  // kimi (PROTO-DEC-0211): tokens are not counted for this client and the cost basis is subscription (the launch started only on the private subscription config);
  // the record note tells the route and that the tokens are not counted (a separate statement, so the record call below is the shared one)
  if (o.client === 'kimi') {
    const served = require('./kimi-served.cjs'); const kimiShow = require('./kimi-route.cjs').show;
    const intact = Boolean(kimiAfter && kimiAfter.ok === true);
    usage = { fields: served.usageFields(intact, served.proofReason(kimiAfter)), info: { reason: served.NOT_COUNTED, stopReason: null, resultText: null } }; usageText = '';
    const routeNote = !o.kimiRoute ? '' : intact ? `kimi-route=generated-config provider=${kimiShow(o.kimiRoute.provider, 64)}` : `kimi-route=unproven reason="${served.proofReason(kimiAfter)}"`;
    servedNote = [servedNote, routeNote, `tokens-not-counted reason="${served.NOT_COUNTED}"`].filter(Boolean).join(' ');
  }
  try { if (o.client === 'vibe') limitEvidence = vibeTurnLimit({ text: captured, status: result.status, stopReason: usage.info && usage.info.stopReason }); } catch { limitEvidence = null; }
  const limitText = limitEvidence ? `TURN_LIMIT client=vibe max=${turns.value} evidence=${limitEvidence}` : '';
  const reportText = o.expectReport && !reportOk ? `REPORT verdict=none reason=${report.reason}${report.file && !qwenRun ? ` file=${report.file}` : ''}` : '';
  const failureClass = mismatch ? 'SERVED_MODEL_MISMATCH' : limitEvidence ? 'TURN_LIMIT' : (!reportOk ? 'NO_VERDICT' : undefined);
  // agy answers in json: the call file keeps the answer text readable (the json stays in the client's own store)
  const bodyRaw = o.client === 'agy' && usage.info && usage.info.resultText !== null && usage.info.resultText !== undefined ? usage.info.resultText : captured;
  const body = qwenRun ? require('./qwen-client.cjs').factsLine(qwenRun.facts) : bodyRaw;
  settleLaunch(!reportOk || mismatch ? 3 : (result.status === null ? 1 : result.status));
  let recordFailed = '';
  try {
    const writer = deps.launchRecord || require('../../.ai/bin/launch-record.cjs');
    // A fixed reason also survives subscription pricing; arbitrary usage errors
    // are never copied into this note.
    const paths = require('../../.ai/bin/launch-record.cjs').recordPaths(o.worktree, o.launchPromptFile || o.promptFile);
    const recordInput = { client: o.client, model: o.model, effort: eff.effortUsed, role: packet ? packet.role : 'certifier', stage: packet ? packet.stage : 'accept', taskClass: 'A', route: `cli:${o.client}`, riskClass: 'A', name: o.name, ...paths, ...provenance, head, workRootDir: work.dir, exitCode: reportOk && !mismatch ? result.status : 3, startedAt, failureClass, note: [o.expectReport ? `report=${reportOk ? 'ok' : `NO_VERDICT reason=${report.reason}`}` : '', mismatch ? `served-model-mismatch served=${mismatch.servedModel}` : '', servedNote, o.client === 'agy' && !usage.fields.tokens ? 'usage-unknown reason=no-complete-usage-evidence confidence=unknown' : '', o.client === 'qwen' ? `tokens-not-counted reason="${require('./qwen-client.cjs').NOT_COUNTED}"` : ''].filter(Boolean).join(' ') || undefined,
      ...(packet ? { packetHash: packet.packetHash, packetProfile: packet.profile, packetBytes: packet.bytes, packetEstTokens: packet.estTokens } : {}), ...servedFields, ...usage.fields };
    if(cycleControl)recordInput.role=o.launchRole;
    writer.writeLaunchRecord(recordInput);
  } catch (e) { recordFailed = recordFailedLine(e); }
  if (recordFailed) (deps.error || console.error)(recordFailed);
  const extra = [limitText, reportText, usageText, mismatchText, servedText, streamRefused, recordFailed].filter(Boolean).map(l => `${l}\n`).join('');
  io.appendFileSync(callFile, `marker=${marker}\n${body}\n${extra}${marker} exit=${result.status}${reportWord} end=${endedAt}\n`, 'utf8');
  for (const line of [limitText, reportText, usageText, mismatchText, servedText, streamRefused]) if (line) say(line);
  say(`${marker} exit=${result.status}${reportWord}`);
  return !reportOk || mismatch ? 3 : (result.status === null ? 1 : result.status);
  } finally {
    settleLaunch(1);
  }
}

module.exports = { DEFAULT_RUNTIME, value, options, effortFor, buildInvocation, main, launchOnce, reportVerdict, checkReport, snapshotReports, vibeMaxTurns, vibeTurnLimit };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

'use strict';
//        [--expect-report-path docs/reviews/<name>.md] [--expect-task-digest HEX] [--expect-receipt-digest HEX]
// Intake integrity (INJECTION-DEFENSE R2, design P2a, P2b, P3, P8, P13; each refusal is a decision of THIS launcher, never an act of the advisory injection scanner):
// --expect-report-path pins the ONE report file the gate reads (docs/reviews/<name>.md, no other name, no mtime race: a file that only holds the substring is not a candidate)
// and switches the report gate to the strict form of gateReportVerdict (a header verdict is required, a conflicting verdict line at any depth refuses); --expect-task-digest
// refuses the start when the task file (--task-file, else the prompt file) no longer has the digest the dispatcher saw (TASK_PIN_REFUSED, exit 3); --expect-receipt-digest does the
// same for the author-check receipt a certifier launch rests on (RECEIPT_PIN_REFUSED, exit 3); a packet whose body holds a credential-shaped string is never written
// (PACKET_SECRET_REFUSED, exit 3, always on). Digests of the task file and the receipt, and the report path, go into the launch record (reportPath, taskSha256, receiptSha256, receiptHead).
const childProcess = require('node:child_process');
// Optional --chain overrides the blind-certifier MCP default: it enables the
// kernel servers for staged earlier reports, only on clients with a per-run MCP switch.
const fs = require('node:fs');
const path = require('node:path');
const confinement = require('./launch-packet.cjs');
const repoPaths = require('../../.ai/bin/repo-paths.cjs');
const servedModelTool = require('./served-model.cjs');
const { loadRegistry } = require('../../.ai/bin/protocol-dispatch/registry.cjs');
const { effortArgs } = require('../../.ai/bin/protocol-dispatch/clients.cjs');
const seatMcp = require('../../.ai/bin/lib/seat-mcp.cjs');

// <main checkout>/.ai/runtime of the repository these files live in (env OPS_RUNTIME_DIR overrides; repo-paths.cjs)
const DEFAULT_RUNTIME = repoPaths.runtimeDir();
const LAUNCH_ROLES = ['author', 'certifier', 'pre-review', 'unknown'];
const { seatMarker } = require('../../.ai/bin/lib/seat-marker.cjs');
const unknownUsageFields = e => ({ tokens: null, cost: { usd: null, basis: 'unknown', priceSnapshot: null, formula: null, reason: `usage derivation failed: ${String((e && e.message) || e).slice(0, 200)}` } });
// The one line of a failed launch-record write (stderr and call file); the code is the error code (ENOSPC, EACCES, ...) reduced to safe characters.
const recordFailedLine = e => `RECORD-WRITE-FAILED code=${String((e && e.code) || 'UNKNOWN').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'UNKNOWN'}`;

// P12(a) (INJECTION-DEFENSE R3, anti-G10): a hook planted in .git/hooks (shared by every linked worktree of the checkout) or a local core.hooksPath runs code at the
// next git call that does not switch hooks off. Every git call of the launchers (the head and status reads, the economy plan, the receipt reader, the mutant check)
// runs through noHooksSpawn: the same switch the kernel's own git calls carry (-c core.hooksPath=disabled, validator/repository.cjs, auto-retire.cjs). Only the
// git command is changed; the client itself is started by the plain spawn.
const GIT_NO_HOOKS = Object.freeze(['-c', 'core.hooksPath=disabled']);
const isGitCommand = command => /^git(\.exe)?$/i.test(path.basename(String(command)));
function noHooksSpawn(spawn) {
  return (command, args, options) => (isGitCommand(command) && Array.isArray(args) ? spawn(command, [...GIT_NO_HOOKS, ...args], options) : spawn(command, args, options));
}

function value(argv, name, dflt) {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : dflt;
}

// The client and model come from the one reader the recovery and the route step of launch-wrapper use (both forms;
// a repeat, a missing value or another spelling is refused with its named reason).
const { identity: seatIdentity, spawnClient, splitPrecert } = require('./seat-failover.cjs'); // at module load: a plan that reads options() loads no module
function options(argv) {
  const stated = seatIdentity(argv);
  if (stated.problem) throw new Error(stated.problem);
  return {
    client: stated.client, model: stated.model, worktree: value(argv, 'worktree'),
    name: value(argv, 'name'), promptFile: value(argv, 'prompt-file'), expect: value(argv, 'expect-sha'),
    taskFile: value(argv, 'task-file'), selectionBase: value(argv, 'selection-base'),
    argsFile: value(argv, 'args-file', ''), maxTokens: value(argv, 'max-tokens', '16000'),
    expectReport: value(argv, 'expect-report', ''), dryRun: argv.includes('--dry-run'),
    expectReportPath: value(argv, 'expect-report-path', ''), expectTaskSha256: value(argv, 'expect-task-digest', ''),
    packetRole: value(argv, 'packet-role'), packetStage: value(argv, 'packet-stage'),
    packetFrame: value(argv, 'packet-frame'), packetProfile: value(argv, 'packet-profile'), packetRetrieval: value(argv, 'packet-retrieval'),
    allowExecutorPacket: argv.includes('--allow-executor-packet'),
    effort: value(argv, 'effort'), tier: value(argv, 'tier', 'T7'),
    // no silent default: a launch whose role the caller did not state is recorded as unknown, never as a certifier launch
    launchRole: value(argv, 'launch-role', 'unknown'),
    // the base of the candidate diff for the certifier budget and scope (default: the merge base with the integration branch)
    economyBase: value(argv, 'economy-base'),
    // --chain (PROTO-DEC-0252 item 2): a chained certifier seat gets the kernel MCP servers; refused for a client without a per-run MCP switch
    chain: argv.includes('--chain'),
  };
}

// The report gate is advice. The shared reader owns the grammar and masking.
const { readVerdict, TOKENS: VERDICT_TOKENS } = require('../../.ai/bin/lib/verdict-read.cjs');
const { realInside } = require('../../.ai/bin/lib/path-safe.cjs');
function reportVerdict(input) {
  if (input === undefined || input === null || (typeof input === 'string' && !input.trim()) || (input instanceof Uint8Array && input.length === 0)) return { verdict: null, reason: 'empty' };
  const v = readVerdict(input);
  return { verdict: v.token, reason: v.reason };
}
// P2b (INJECTION-DEFENSE R2, anti-G3): the strict form of the report gate, used only for a launch that pins its report (--expect-report-path). The shared reader
// (verdict-read.cjs) is NOT changed for any of its consumers; the strictness lives here. (1) The report is a source of the launch verdict only when the header
// carries it (a Mode line and a verdict line in the first 60 lines, as required by the launch prompt): a report whose verdict is only the closing line is
// NO_HEADER_VERDICT. (2) A keyed verdict line (Verdict or Overall with a token, an own line outside code and quotes) at ANY depth below the header window whose token
// differs from the header token is conflicting-sources. Same class of refusal as NO_VERDICT for the record.
const GATE_HEADER_LINES = 60;
const GATE_VERDICT_PATTERN = `(${VERDICT_TOKENS.join('|')})`;
const GATE_KEYED = new RegExp(String.raw`^(?:Verdict: ${GATE_VERDICT_PATTERN}|\*\*Verdict: ${GATE_VERDICT_PATTERN}\*\*|\*\*Verdict:\*\* ${GATE_VERDICT_PATTERN}|Overall: ${GATE_VERDICT_PATTERN}|\*\*Overall: ${GATE_VERDICT_PATTERN}\*\*|\*\*Verdict\*\*: ${GATE_VERDICT_PATTERN}(?:[ \t]+$)?)(?:(?: - | -- | — |: | \().*)?$`);
function gateReportVerdict(input) {
  const base = reportVerdict(input);
  if (base.verdict === null) return base;
  const v = readVerdict(input);
  if (v.source === 'closing') return { verdict: null, reason: 'NO_HEADER_VERDICT' };
  const textSafe = require('../../.ai/bin/lib/text-safe.cjs');
  let text;
  if (input instanceof Uint8Array) { const d = textSafe.decode(input, { bom: 'strip', crlf: 'normalise' }); if (!d.ok) return { verdict: null, reason: 'undecodable' }; text = d.text; }
  else text = String(input).charCodeAt(0) === 0xfeff ? String(input).slice(1) : String(input);
  const lines = textSafe.maskMarkdown(text).lines;
  for (let i = GATE_HEADER_LINES; i < lines.length; i++) {
    const l = lines[i];
    if (!l || l.masked || l.partial) continue;
    // A later verdict line is read as a reader sees it: compatibility forms (full-width letters) fold to ASCII and
    // invisible format characters drop, so a look-alike spelling of a conflicting verdict still conflicts.
    const m = GATE_KEYED.exec(l.text.normalize('NFKC').replace(textSafe.IGNORABLE_FORMAT_RE, ''));
    if (m && m.slice(1).find(Boolean) !== base.verdict) return { verdict: null, reason: 'conflicting-sources' };
  }
  return base;
}
// P2a: the pinned report path is one file of docs/reviews of the worktree: a forward-slash relative path, one segment after docs/reviews/, ending in .md.
const REPORT_PIN = /^docs\/reviews\/([A-Za-z0-9][A-Za-z0-9._-]*\.md)$/;
const reportPinName = pin => { const m = typeof pin === 'string' ? REPORT_PIN.exec(pin) : null; return m && !m[1].includes('..') ? m[1] : null; };
// The names a launch reads as its report: the one pinned file, else every .md of docs/reviews whose NAME holds the substring.
const reportNames = (io, dir, expectReport, pinName) => io.readdirSync(dir).filter(n => (pinName ? n === pinName : n.includes(expectReport)) && n.endsWith('.md'));
// Each attempt snapshots names, sizes, mtimes and bytes before invoking the client.
// Equal timestamps alone cannot attribute an earlier route's report to this route.
function snapshotReports(io, worktree, expectReport, pinName) {
  const dir = path.join(worktree, 'docs', 'reviews');
  let names;
  try { names = reportNames(io, dir, expectReport, pinName); }
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
// The reason a report is PARTIAL (the reader of the acceptance path, review-facts.cjs progressOf): the report cannot be read, it says
// Status: PARTIAL, it keeps an open item that could block, or it holds no progress table at all. One reason list for every launcher path,
// so a report without a progress table is PARTIAL with --expect-report and without it.
function partialReason(pr) {
  return !pr ? 'report-unreadable' : pr.statusPartial ? 'status-partial' : pr.open.length ? 'open-blocking-items' : pr.tables === 0 ? 'progress-table-missing' : null;
}
function checkReport(io, worktree, expectReport, startedAt, before, pinName) {
  const dir = path.join(worktree, 'docs', 'reviews');
  let names = [];
  try { names = reportNames(io, dir, expectReport, pinName); } catch { /* no docs/reviews dir */ }
  if (!names.length) return { ok: false, verdict: null, reason: 'missing', file: null };
  const stamp = n => { try { return io.statSync(path.join(dir, n)).mtimeMs; } catch { return 0; } };
  const since = Date.parse(startedAt || '');
  if (!Number.isNaN(since)) {
    const after = before === undefined ? undefined : snapshotReports(io, worktree, expectReport, pinName);
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
  const v = pinName ? gateReportVerdict(text) : reportVerdict(text);
  if (!Number.isNaN(since) && sorted.length > 1) {
    const verdicts = new Set(sorted.map(n => { try { return (() => { const g = realInside(path.resolve(worktree), path.join(dir, n), { refuseHardlinks: true }); return g.ok ? reportVerdict(io.readFileSync(g.real)).verdict : null; })(); } catch { return null; } }).filter(Boolean));
    if (verdicts.size > 1) return { ok: false, verdict: null, reason: 'ambiguous-reports', file };
  }
  return { ok: v.verdict !== null, verdict: v.verdict, reason: v.reason, file };
}

// ---- wakeup tool (LAUNCH-RELIABILITY finding 7) ----
// A seat whose client calls its wakeup or pause tool ends its run at that call (kilo 7.8.17 schedule_wakeup, measured 2026-10-29: the run
// ended at once, NO_VERDICT, a half-written report). The call is read only from the structured stream of the json clients (kilo and mimo
// print one JSON event per line; a tool call is {"type":"tool_use","part":{"type":"tool","tool":NAME}}); the tool names are a closed list of
// measured names. Returns the tool name of the first such call, else null. A text that only mentions a tool name is never a call.
const WAKEUP_TOOLS = Object.freeze(['schedule_wakeup']);
function wakeupToolCall(client, text) {
  if (client !== 'kilo' && client !== 'mimo') return null;
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const part = event && event.type === 'tool_use' && event.part && typeof event.part === 'object' ? event.part : null;
    if (part && part.type === 'tool' && typeof part.tool === 'string' && WAKEUP_TOOLS.includes(part.tool)) return part.tool;
  }
  return null;
}

// LAUNCH-RELIABILITY (item 8, kilo seats): every kilo seat of the kernel launchers runs with the client tool schedule_wakeup turned off, as the
// operator seat tool does (KILO_CONFIG_CONTENT {"tools":{"schedule_wakeup":false}}, 2026-10-30: DeepSeek certifier seats called it and ended at
// once with no verdict). KILO_CONFIG_CONTENT is kilo's inline config layered over the user's config; a value the caller already set is kept
// and only tools.schedule_wakeup is forced off. A value that is not one JSON object cannot be merged and refuses the launch before anything
// starts (it is never dropped silently). A wakeup call that still happens stays the named class WAKEUP_TOOL (wakeupToolCall above).
function kiloSeatConfig(env) {
  const raw = env && env.KILO_CONFIG_CONTENT;
  let base = {};
  if (raw !== undefined && String(raw).trim() !== '') {
    try { base = JSON.parse(String(raw)); } catch { return { ok: false, reason: 'KILO_CONFIG_CONTENT is not JSON' }; }
    if (!base || typeof base !== 'object' || Array.isArray(base)) return { ok: false, reason: 'KILO_CONFIG_CONTENT is not a JSON object' };
    if (base.tools !== undefined && (!base.tools || typeof base.tools !== 'object' || Array.isArray(base.tools))) return { ok: false, reason: 'KILO_CONFIG_CONTENT tools is not an object' };
  }
  return { ok: true, value: JSON.stringify({ ...base, tools: { ...(base.tools || {}), schedule_wakeup: false } }) };
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
// EFFORT-EXPLICIT: effort must be explicitly provided; no default is applied.
function effortFor(o, registry) {
  const reg = registry || loadRegistry();
  const cfg = reg.clients && Object.hasOwn(reg.clients, o.client) && reg.clients[o.client];
  if (!cfg || cfg.present !== true) {
    return { ok: false, args: [], effortUsed: null, error: `client ${o.client} is absent or not present in the registry (P-L3-005)` };
  }
  // EFFORT-EXPLICIT: pass effort as-is without default; effortArgs will refuse if missing for effort-capable routes
  return effortArgs(o.client, o.effort, reg);

}

function buildInvocation(o, env = process.env, packet) {
  // The client is spawned WITHOUT a text encoding (encoding 'buffer'): its stdout and stderr stay
  // BYTES all the way to the strict decode inside the ONE derivation path (deriveForLaunch decodes them; nothing here decodes a stream).
  const eff = o.effortArgs ? { args: o.effortArgs } : effortFor(o, o.registry);
  const effort = eff.args || [];
  const prompt = o.promptFile.replace(/\\/g, '/');
  const legacyArgText = `Read and execute exactly the task in ${prompt} (the LAST line of your report must be the verdict line, for example Verdict: PASS, with one token of PASS, FAIL, BLOCKED or RECOMMENDATION). The environment variable PROTOCOL_NO_FULL_SUITE=1 is set for you.`;
  // One line only: cmd.exe /c ends the command line at the first newline, which silently dropped every argument after
  // argText (the model flag, the tool list, --trust). Any newline inside the pieces is folded to a space as well.
  const timeout = require('../../.ai/bin/lib/client-command-timeout.cjs');
  const baseText = timeout.append(o.instructionText ?? legacyArgText, timeout.lookup(o.client, o.registry), packet?.pointerLine);
  let argText = (o.economyPointer ? `${o.economyPointer} ${baseText}` : baseText).replace(/[\r\n]+/g, ' ');
  // the certifier budget sets the client's own turn limit where the client has one (cert-economy.cjs TURN_FLAGS)
  const vibeTurns = String(o.turnLimit || vibeMaxTurns(env).value);
  const mcp = seatMcp.forSeat(o.seatMcp, { role: o.launchRole, sealed: o.sealed, chained: o.chain === true, root: o.worktree, env, client: o.client });
  const commonEnv = seatMcp.clientEnv(mcp, o.client, { ...env, PROTOCOL_NO_FULL_SUITE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' });
  if (mcp.list.some(s => s.name === 'semgrep')) argText += ` ${require('../../.ai/bin/lib/semgrep-mcp.cjs').RESTRICTION}`;
  // The MCP set of a seat (seat-mcp.cjs, which supersedes the header above for vibe): a server only on a client proven to reach it; codebase-memory
  // only with the client's read-only switch (codex enabled_tools, claude --disallowedTools, vibe --enabled-tools by name); vibe gets the two servers
  // declared in VIBE_MCP_SERVERS by clientEnv, so its seat no longer depends on the user's vibe config.
  const claudeMcp = mcp.mode === 'user' ? [] : ['--strict-mcp-config', ...(mcp.mode === 'kernel' && o.seatMcpConfigFile ? ['--mcp-config', o.seatMcpConfigFile.replace(/\\/g, '/'), ...seatMcp.claudeArgs(mcp.list)] : [])];
  if (o.client === 'claude') return { command: 'cmd.exe', args: ['/c', 'claude', '--model', o.model, ...effort, ...(o.turnLimit ? ['--max-turns', String(o.turnLimit)] : []), '--dangerously-skip-permissions', ...claudeMcp, '-p', argText, '--output-format', 'json'], spawnOptions: { cwd: o.worktree, encoding: 'buffer', env: commonEnv, maxBuffer: 536870912 }, argText };
  if (o.client === 'kilo') {
    if (o.model.startsWith('external/')) {
      const invocation = o.externalInvocation || require('./lib/external-provider.cjs').buildInvocation({ routeId: o.model.slice('external/'.length), workDir: o.worktree, configDir: o.externalConfigDir || null, role: o.launchRole, prompt: argText, env: commonEnv, table: o.externalRoutes });
      if (!invocation.ok) throw new Error(`EXTERNAL REFUSED reason=${invocation.reason}`);
      return { command: 'cmd.exe', args: ['/c', invocation.command, ...invocation.args.slice(0, -1), argText], spawnOptions: { ...invocation.spawnOptions, env: { ...invocation.spawnOptions.env, PROTOCOL_NO_FULL_SUITE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' }, maxBuffer: 536870912 }, argText };
    }
    const kiloConfig = kiloSeatConfig(commonEnv);
    if (!kiloConfig.ok) throw new Error(`kilo seat config refused: ${kiloConfig.reason}`);
    return { command: 'cmd.exe', args: ['/c', 'kilo', 'run', '-m', o.model, ...effort, '--auto', '--dir', o.worktree, '--format', 'json', argText], spawnOptions: { cwd: o.worktree, encoding: 'buffer', env: { ...commonEnv, KILO_CONFIG_CONTENT: kiloConfig.value }, maxBuffer: 536870912 }, argText };
  }
  // VIBE_CLI=python pins the Python front end (it accepts --output-dir and writes the export); the Rust parser of vibe 2.26.1 refuses the flag.
  if (o.client === 'vibe') return { command: 'cmd.exe', args: ['/c', 'vibe', '-p', argText, '--enabled-tools', 'read_file', '--enabled-tools', 'grep', '--enabled-tools', 'write_file', '--enabled-tools', 'edit', '--enabled-tools', 'bash', ...(mcp.mode === 'kernel' ? seatMcp.vibeArgs(mcp.list) : []), '--auto-approve', '--trust', '--max-turns', vibeTurns, '--output', 'streaming', '--workdir', o.worktree, ...(o.exportDir ? ['--output-dir', o.exportDir] : [])], spawnOptions: { cwd: o.worktree, encoding: 'buffer', env: { ...commonEnv, VIBE_ACTIVE_MODEL: servedModelTool.vibeAlias(o.model, o.vibeModels).alias, VIBE_CLI: 'python' }, maxBuffer: 536870912 }, argText };
  // codex approval (AUTO-APPROVE): --approve-for-me (automatic review, can deny) by default; COLABUS_CODEX_SEAT_APPROVAL=bypass swaps it and the restated sandbox
  // for --dangerously-bypass-approvals-and-sandbox (launchOnce refuses that switch in a main checkout and refuses any other value)
  if (o.client === 'codex') { const bypass = codexSeatApproval(env).mode === 'bypass'; return { command: 'cmd.exe', args: ['/c', 'codex', 'exec', '-m', o.model, ...effort, ...(mcp.mode === 'user' ? [] : ['--ignore-user-config', ...(bypass ? [] : ['-c', 'sandbox_mode=workspace-write', '-c', 'windows.sandbox=unelevated']), ...(mcp.mode === 'kernel' ? seatMcp.codexArgs(mcp.list) : [])]), ...(bypass ? ['--dangerously-bypass-approvals-and-sandbox'] : ['--approve-for-me']), '--skip-git-repo-check', '-C', o.worktree, argText], spawnOptions: { cwd: o.worktree, encoding: 'buffer', env: commonEnv, maxBuffer: 536870912 }, argText }; }
  if (o.client === 'mimo') return { command: 'cmd.exe', args: ['/c', 'mimo', 'run', argText, '-m', o.model, ...effort, '--yolo', '--format', 'json'], spawnOptions: { cwd: o.worktree, encoding: 'buffer', env: commonEnv, maxBuffer: 536870912 }, argText };
  // qwen (Qwen Code on the DashScope free quota): the prompt goes by stdin, the model is explicit, the key comes from the User environment; docs/ops/qwen-client.cjs.
  if (o.client === 'qwen') return require('./qwen-client.cjs').buildInvocation(o, argText, commonEnv);
  if (o.client === 'dahl') {
    const agent = env.OPENAI_COMPAT_AGENT || path.join(repoPaths.mainRoot(), 'tools', 'openai-compat-agent.cjs');
    const transcript = o.transcriptFile || path.join(DEFAULT_RUNTIME, `${o.name}-transcript.txt`);
    return { command: 'node', args: [agent, '--model', o.model, '--key-env', 'DAHL_API_KEY', '--prompt-file', o.launchPromptFile || o.promptFile, '--workdir', o.worktree, '--out', transcript, '--max-tokens', o.maxTokens, '--max-steps', String(o.turnLimit || 90), '--timeout-ms', '300000', '--allow', 'node', '--allow', 'git'], spawnOptions: { cwd: o.worktree, encoding: 'buffer', env: commonEnv, maxBuffer: 536870912 }, argText };
  }
  // kimi (measured on Kimi Code 2.1.1): -p runs one prompt headless and refuses --auto and --yolo (it sets auto itself: file and shell tools work);
  // -m takes the alias of the private config.toml the launcher generates (kimi-code/<model> is the subscription; a moonshot-ai alias is refused in launchOnce and is not in that config); the stream-json format
  // keeps the answer machine-readable in the call file. The explicit -m proves the model (PROTO-DEC-0211); numeric usage is read separately from the private home (PROTO-DEC-0251).
  // The working directory is the process cwd (no flag). launchOnce resolves the command ONCE to an absolute path (kimi-route.cjs resolveLaunch).
  // cline (measured 2026-10-30, cline 3.0.74): its own settings (never --config, --data-dir or -k), stdin closed, --json for the run_result (usage and the model the launcher asked for); the effort is --thinking (cline-route.cjs launchArgs)
  if (o.client === 'cline') return { command: 'cmd.exe', args: ['/c', 'cline', ...require('../../.ai/bin/lib/cline-route.cjs').launchArgs({ model: o.model, worktree: o.worktree, prompt: argText, thinking: o.effort })], spawnOptions: { cwd: o.worktree, encoding: 'buffer', env: commonEnv, maxBuffer: 536870912, stdio: ['ignore', 'pipe', 'pipe'] }, argText };
  if (o.client === 'kimi') return { command: 'kimi', args: ['-m', o.model, '-p', argText, '--output-format', 'stream-json'], spawnOptions: { cwd: o.worktree, encoding: 'buffer', env: commonEnv, maxBuffer: 536870912 }, argText };
  return null;
}

// The codex seat approval switch (AUTO-APPROVE): unset, empty or review keeps --approve-for-me; exactly bypass selects the full bypass; anything else is invalid.
const CODEX_APPROVAL_ENV = 'COLABUS_CODEX_SEAT_APPROVAL';
function codexSeatApproval(env) {
  const v = env[CODEX_APPROVAL_ENV];
  if (v === undefined || v === '' || v === 'review') return { mode: 'review' };
  if (v === 'bypass') return { mode: 'bypass' };
  return { mode: 'review', invalid: true };
}

// The MCP plan of one launch. o.seatMcpConfigFile is set only when the claude config file was written.
function seatMcpPlan(o, work, io) {
  const plan = seatMcp.forSeat(null, { role: o.launchRole, sealed: o.sealed, chained: o.chain === true, root: o.worktree, env: work.env, client: o.client });
  if (o.client !== 'claude' || plan.mode !== 'kernel' || !plan.list.length) return plan;
  try {
    const file = seatMcp.claudeConfigFile(plan, { role: o.launchRole, root: o.worktree, fallback: path.join(work.dir, 'seat-mcp.json'), io });
    o.seatMcpConfigFile = file;
    return plan;
  } catch (error) {
    const note = `claude config file not written (${String((error && error.code) || 'error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40)})`;
    return { ...plan, mode: 'none', list: [], notes: [note], line: seatMcp.line('none', [], [note]) };
  }
}

// The plan line goes to RUNTIME/NAME-seat-mcp.txt beside the call file (the call file format stays as it was); mcp-wiring.cjs metric reads it.
// A failed write is never a refusal: MCP is advisory.
function writeSeatMcpLine(io, runtime, name, line) {
  try { io.writeFileSync(path.join(runtime, `${name}-seat-mcp.txt`), `${line}\n`, 'utf8'); return true; } catch { return false; }
}

// Injection observation (PROTO-DEC-0132 item 1, advisory): before the client starts, the package data files of the launch (the files the prompt names inside
// the worktree and the reports matching --expect-report; injection-scan.cjs packageSet) are scanned and the L1 lines go to RUNTIME/NAME-injection-l1.txt beside
// the call file (the call file format stays as it was); a hit, an unreadable input or a failed scan is also said on stdout, a clean scan is not. The prompt file
// and the task file are the operator's own text and are not scanned. Nothing here refuses, changes the exit or edits a file: any failure is one "unavailable" line.
function observeInjection(o, deps, io, say, runtime) {
  let result;
  try {
    const observe = deps.injectionObserve || require('./injection-scan.cjs').observeLaunch;
    result = observe({ worktree: o.worktree, promptFile: o.promptFile, taskFile: o.taskFile, expectReport: o.expectReport });
  } catch (error) { result = { ok: false, hits: 0, unknown: 0, lines: [`INJECTION-SCAN unavailable reason=${String((error && error.code) || 'ERROR').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'ERROR'}`] }; }
  try { io.writeFileSync(path.join(runtime, `${o.name}-injection-l1.txt`), `${result.lines.join('\n')}\n`, 'utf8'); } catch { /* the observation never blocks */ }
  if (!result.ok || result.hits || result.unknown) for (const line of result.lines) { try { say(line); } catch { /* the observation never blocks */ } }
  return result;
}

// A main checkout keeps .git as a directory (a linked worktree has a .git file); only a main checkout can hold the codex trust that --ignore-user-config drops.
function isMainCheckout(worktree, io) {
  try { return io.statSync(path.join(worktree, '.git')).isDirectory(); } catch { return false; }
}

// ---- intake integrity (INJECTION-DEFENSE R2, design P3, P8, P13) ----
// Every refusal below is a decision of this launcher: the advisory injection scanner never refuses (design section 8, M-09).
const safeCode = e => String((e && e.code) || 'ERROR').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'ERROR';
const shaHex = value => { const m = /^(?:sha256:)?([0-9a-fA-F]{64})$/.exec(String(value || '').trim()); return m ? m[1].toLowerCase() : null; };
const sha256Of = bytes => require('node:crypto').createHash('sha256').update(bytes).digest('hex');
// P3 (anti-G4): the digest of the task file as the launch reads it now. The file is --task-file, else the prompt file: both live outside git and nobody else checks them.
// Without a pin the digest is only recorded; with a pin a different digest, or a file that cannot be read, refuses the start.
function taskPinGate(o, io) {
  let hex = null;
  try { hex = sha256Of(io.readFileSync(path.resolve(o.worktree, o.taskFile || o.promptFile))); } catch { hex = null; }
  if (o.taskPinHex && hex === null) return { ok: false, reason: 'TASK_FILE_UNREADABLE' };
  if (o.taskPinHex && hex !== o.taskPinHex) return { ok: false, reason: 'TASK_HASH_CHANGED' };
  return { ok: true, hex };
}
// P13 (anti-G11): the digest of the applicable author-check receipt of this head. The reader is precert-facts authorReceipt, the one the precert gate and the certifier
// scope use, so the receipt hashed here is the one they accepted. -> { ok, hex, head } or { ok: false, reason }.
function receiptDigest({ worktree, head, authorChecks }, deps = {}) {
  try {
    const reader = deps.authorReceipt || require('../../.ai/bin/lib/precert-facts.cjs').authorReceipt;
    const found = reader(authorChecks, head, require('./cert-economy.cjs').gitOf(worktree, noHooksSpawn(deps.spawnSync || childProcess.spawnSync)));
    if (!found || found.problem || !found.file) return { ok: false, reason: 'RECEIPT_UNAVAILABLE' };
    return { ok: true, hex: sha256Of((deps.fs || fs).readFileSync(found.file)), head: found.receipt && found.receipt.head };
  } catch { return { ok: false, reason: 'RECEIPT_UNAVAILABLE' }; }
}
// The refusal of the start by a pin: the call file says why (exit=NAME_PIN_REFUSED), the launch prints one line and starts nothing.
function pinRefusal(kind, reason, o, io, say, callFile) {
  try { confinement.assertContainedOutput(path.dirname(callFile), callFile, io, true); io.writeFileSync(callFile, `exit=${kind} reason=${reason}\n`, 'utf8'); } catch { /* the refusal stands without its call file */ }
  say(`${o.name.toUpperCase()}_${kind} reason=${reason}; nothing was started`);
  return 3;
}
// P9 (INJECTION-DEFENSE R3, anti-G7): the budget packet of a certifier seat is the launcher's own text, except for a continuation: the name of the draft report and its
// open items were written by the PREVIOUS seat (a model). They are no longer put into the instruction line; the packet names them as data and carries them in the
// block of PROTO-DEC-0132 item 2 (lib/data-block.cjs). The values are still the sanitized ones (cert-economy packetSafe, packetOpen). A format, never a refusal.
function economyPacketText(tool, plan) {
  const draft = plan && plan.continuation;
  if (!draft) return tool.packetText(plan);
  const economy = require('./cert-economy.cjs');
  const items = [`draft report: ${economy.packetSafe(draft.report, 200)}`, ...economy.packetOpen(draft.open).map(item => `open item: ${item}`)];
  const text = tool.packetText({ ...plan, continuation: { ...draft, report: 'file named in the data block below', open: ['the open items in the data block below'] } });
  const wrapped = require('../../.ai/bin/lib/data-block.cjs').wrapData(items.join('\n'), { label: 'Draft of the previous seat' });
  return `${text}\n## Draft of the previous seat\n\n${wrapped}\n`;
}
// P8 (anti-G6): a packet whose body holds a credential-shaped string is never written. The guard wraps the io the packet writers use, so the check sits in front of EVERY write
// of a launch packet (the compiled packet, the certifier budget packet, the file prompt of dahl): nothing reaches the disk. The refusal names the class of the match, never the
// matched text. The body is also given to the advisory injection scan: a hit is one L1 line and never a refusal.
function packetGuard(io, o, deps, say, runtime) {
  const secrets = require('../../.ai/bin/lib/secrets.cjs');
  return Object.assign(Object.create(io), { writeFileSync(file, text, options) {
    // a byte body is read as its text (R2 finding F-2): the scan must never see the JSON spelling of a Buffer
    const kind = secrets.secretKind(ArrayBuffer.isView(text) ? Buffer.from(text.buffer, text.byteOffset, text.byteLength).toString('utf8') : text);
    if (kind) throw Object.assign(new Error('PACKET_SECRET_REFUSED'), { code: 'PACKET_SECRET_REFUSED', kind });
    try {
      const observe = deps.injectionTexts || require('./injection-scan.cjs').observeTexts;
      const seen = observe([{ name: 'packet', text }]);
      if (seen && (seen.flagged || !seen.ok)) {
        for (const line of seen.lines) { try { say(line); } catch { /* advisory */ } }
        try { io.appendFileSync(path.join(runtime, `${o.name}-injection-l1.txt`), `${seen.lines.join('\n')}\n`, 'utf8'); } catch { /* advisory */ }
      }
    } catch { /* the observation never blocks */ }
    return io.writeFileSync(file, text, options);
  } });
}
const isPacketSecretRefusal = error => Boolean(error) && error.code === 'PACKET_SECRET_REFUSED';
function packetSecretRefusal(error, o, io, say, callFile) {
  return pinRefusal('PACKET_SECRET_REFUSED', `credential-shaped-packet kind=${String(error.kind).replace(/[^A-Za-z0-9-]/g, '').slice(0, 40)}`, o, io, say, callFile);
}

function main(argv, deps = {}) {
  return require('./seat-failover.cjs').run(argv, deps, launchOnce, 'cert');
}

// Precert gate (rule gates): the command line of this launcher is the lowest launch layer of a cert-launch seat, so the gate
// sits here; a certifier seat started through another launcher under launch-wrapper --certifier passes this same step there
// (launch-wrapper.cjs precertWrapperStep, LAUNCH-RELIABILITY finding 4). A certifier seat (any --launch-role other than author and
// pre-review) starts only when the candidate head holds the precert facts (.ai/bin/lib/precert-facts.cjs); a refusal names
// each failed fact with its fix, writes exit=PRECERT_REFUSED into the call file and starts nothing (exit 3). The options
// --precert-base REF, --precert-prev SHA, --precert-journal PATH and --precert-override "REASON" are read here and removed
// before the launch options are parsed. A dry run and a head that is not --expect-sha are left to the launch itself.
// The options are read by seat-failover splitPrecert, the reader the entry grammar of the route gate uses too.
// The prompt file of the launch (--prompt-file) is handed to the facts: P-CLEAN passes over it when it is an untracked file
// inside the worktree, and the receipt directory of the author check comes from ruleGates.precert.authorChecks of the
// launching repository.
// Both option forms (--key VALUE and --key=VALUE) are read, as the launch itself reads them (seat-failover normalize).
function optionOf(argv, key) {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === `--${key}`) return argv[i + 1];
    if (typeof argv[i] === 'string' && argv[i].startsWith(`--${key}=`)) return argv[i].slice(key.length + 3);
  }
  return undefined;
}
function precertStep(argv, p, deps) {
  if (argv.includes('--dry-run')) return null;
  const role = optionOf(argv, 'launch-role') || 'unknown';
  if (role === 'author' || role === 'pre-review') return null;
  const worktree = optionOf(argv, 'worktree'); const expect = optionOf(argv, 'expect-sha'); const name = optionOf(argv, 'name');
  if (!worktree || !expect || !name || !confinement.SAFE_SEGMENT.test(name)) return null;
  const spawn = noHooksSpawn(deps.spawnSync || childProcess.spawnSync);
  const head = (spawn('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout || '').trim();
  if (!head || !head.startsWith(expect)) return null;
  const say = deps.say || (line => console.log(line));
  const runtime = deps.runtimeDir || DEFAULT_RUNTIME;
  const kernel = deps.kernelRoot || path.resolve(__dirname, '..', '..');
  // A previous launch with this name and leftover seat journals is not a fresh
  // seat. Refuse before runGate (and before an override can bypass its facts).
  const io = deps.fs || fs;
  const oldSeat = path.join(runtime, `${name}.terminal.json`);
  if (io.existsSync(oldSeat)) {
    const status = spawn('git', ['-C', worktree, 'status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'utf8', windowsHide: true });
    const journals = (status.stdout || '').split('\0').filter(l => l.startsWith('?? .ai/worklog/')).map(l => l.slice(3));
    if (status.status !== 0 || journals.length) {
      say(`${name.toUpperCase()}_PRECERT_REFUSED reason=SEAT_JOURNALS_REUSED journals=${journals.join(',') || 'unreadable'}; use a fresh seat name and worktree; nothing was started`);
      return 3;
    }
  }
  const gates = require('../../.ai/bin/lib/rule-gates.cjs');
  const facts = deps.precertFacts || require('../../.ai/bin/lib/precert-facts.cjs').precertFacts;
  const cfg = gates.config(kernel);
  const derived = cfg.precert && Object.hasOwn(cfg.precert, 'derived') ? cfg.precert.derived : undefined;
  const authorChecks = cfg.precert && Object.hasOwn(cfg.precert, 'authorChecks') ? cfg.precert.authorChecks : undefined;
  const promptFile = optionOf(argv, 'prompt-file');
  const r = gates.runGate({ gate: 'precert', root: kernel, runtime, subject: { name, head }, override: p.override,
    evaluate: () => facts(worktree, { base: p.base, prev: p.prev, journal: p.journal, derived, promptFile, authorChecks, candidateHead: head }) });
  for (const line of r.lines) say(line);
  if (r.ok) {
    // P13 (INJECTION-DEFENSE R2, anti-G11): the digest of the receipt the gate just accepted is pinned for the start of the launch (deps.receiptPin; launchAttempt reads the receipt
    // again). A dispatcher that saw the receipt earlier passes its digest as --expect-receipt-digest: another digest refuses here, before anything starts.
    const wanted = optionOf(argv, 'expect-receipt-digest');
    const digest = authorChecks === undefined ? { ok: false, reason: 'RECEIPT_UNAVAILABLE' } : receiptDigest({ worktree, head, authorChecks }, deps);
    const callPath = path.join(runtime, `${name}-call.txt`);
    if (wanted !== undefined) {
      const hex = shaHex(wanted);
      if (!hex) return pinRefusal('RECEIPT_PIN_REFUSED', 'RECEIPT_PIN_FORMAT', { name }, io, say, callPath);
      if (!digest.ok || digest.hex !== hex) return pinRefusal('RECEIPT_PIN_REFUSED', digest.ok ? 'RECEIPT_HASH_CHANGED' : digest.reason, { name }, io, say, callPath);
    }
    if (digest.ok) deps.receiptPin = { hex: digest.hex, head: digest.head, fullHead: head, authorChecks };
    return null;
  }
  const callFile = path.join(runtime, `${name}-call.txt`);
  try { confinement.assertContainedOutput(runtime, callFile, io, true); io.writeFileSync(callFile, `exit=PRECERT_REFUSED head=${head} facts=${r.refused.map(f => f.code).join(',')}\n`, 'utf8'); } catch { /* the refusal stands without its call file */ }
  say(`${name.toUpperCase()}_PRECERT_REFUSED facts=${r.refused.map(f => f.code).join(',')}; nothing was started`);
  return 3;
}
function cli(argv, deps = {}) {
  const split = splitPrecert(argv);
  if (split.problem) { (deps.error || console.error)(`PRECERT REFUSED reason=${split.problem}; nothing was started`); return 2; }
  deps = { ...deps }; // the precert step hands the pinned receipt to the launch through this copy (deps.receiptPin), never through the caller's object
  const refused = precertStep(split.rest, split.opts, deps);
  // deps.launch: the tests' stand-in for the launch, so a test never starts a seat whatever the gate decides
  return refused !== null ? refused : (deps.launch || main)(split.rest, deps);
}

// A certifier launch whose report ends PARTIAL (an audit item that could block is still open) gets exactly one continuation: a new
// launch named NAME-c1 on the same candidate (or a descendant that adds only reports and journals) whose packet starts from the draft
// and its open items. The continuation itself never continues; any other outcome returns as it was.
function launchOnce(argv, deps = {}) {
  const outcome = {};
  const code = launchAttempt(argv, deps, null, outcome);
  if (!outcome.partial) return code;
  const say = deps.say || (line => console.log(line));
  const o = options(argv);
  const economy = deps.certEconomy || require('./cert-economy.cjs');
  const git = economy.gitOf(o.worktree, noHooksSpawn(deps.spawnSync || childProcess.spawnSync));
  const next = economy.continuationHead(git, o.expect);
  if (!next.ok) { say(`CONTINUATION REFUSED reason=${next.reason}; the PARTIAL report stands`); return code; }
  const swap = (list, key, val) => { const i = list.indexOf(`--${key}`); const out = [...list]; if (i < 0) return null; out[i + 1] = val; return out; };
  const name = `${o.name}-c1`;
  const nextArgv = swap(argv, 'name', name) && swap(swap(argv, 'name', name), 'expect-sha', next.head);
  if (!confinement.SAFE_SEGMENT.test(name) || !nextArgv) { say('CONTINUATION REFUSED reason=options; the PARTIAL report stands'); return code; }
  say(`CONTINUATION name=${name} head=${next.head.slice(0, 12)} open=${outcome.partial.open.length}`);
  return launchAttempt(nextArgv, deps, outcome.partial, {});
}

function launchAttempt(argv, deps = {}, continuation = null, outcome = {}) {
  const o = options(argv);
  o.seatFallback = deps.seatFallback === true;
  const io = deps.fs || fs;
  const spawnSync = deps.spawnSync || childProcess.spawnSync;
  const gitSpawn = noHooksSpawn(spawnSync); // P12(a): the launcher's own git calls; the client is started by spawnSync itself
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
  // P2a and P3 (INJECTION-DEFENSE R2): the pins are checked for their form before anything starts (exit 2); a pinned report path is one file of docs/reviews
  // and, when the substring is also given, holds it; a pinned task digest is one sha256 value.
  if (o.expectReportPath) {
    o.reportPinName = reportPinName(o.expectReportPath);
    if (!o.reportPinName) { (deps.error || console.error)('--expect-report-path must be docs/reviews/<name>.md (one file name, forward slashes); nothing was started'); return 2; }
    if (o.expectReport && !o.reportPinName.includes(o.expectReport)) { (deps.error || console.error)('--expect-report-path must name a file that holds the --expect-report substring; nothing was started'); return 2; }
    if (!o.expectReport) o.expectReport = o.reportPinName.replace(/\.md$/, '');
  }
  if (o.expectTaskSha256) {
    o.taskPinHex = shaHex(o.expectTaskSha256);
    if (!o.taskPinHex) { (deps.error || console.error)('--expect-task-digest must be one sha256 value (64 hex characters); nothing was started'); return 2; }
  }
  // PROTO-DEC-0252 item 2: a chained certifier seat needs the kernel MCP servers; a client without a per-run MCP switch cannot carry them
  if (o.chain && !seatMcp.CHAIN_MCP_CLIENTS.includes(o.client)) {
    (deps.error || console.error)('--chain requires a route with a per-run MCP switch (codex, claude, vibe); nothing was started');
    return 2;
  }
  o.vibeModels = deps.vibeModels;
  if (o.client === 'vibe' && !servedModelTool.vibeAlias(o.model, o.vibeModels).known) {
    const known = [...new Set([...(o.vibeModels || []), ...servedModelTool.VIBE_MODELS].map(m => m.alias))].join(', ');
    (deps.error || console.error)(`unknown vibe model "${o.model}": vibe would silently serve its default model. Use one of the aliases (${known}) or a known name; nothing was started`);
    return 2;
  }
  // a kilo seat starts only with its wakeup tool off (kiloSeatConfig); a caller config that cannot be merged refuses here, before anything starts
  if (o.client === 'kilo') {
    if (o.model.startsWith('external/')) {
      o.externalRoutes = deps.externalRoutes;
      const checked = require('./lib/external-provider.cjs').readRoute({ routeId: o.model.slice('external/'.length), role: o.launchRole, env: deps.env || process.env, table: o.externalRoutes });
      if (!checked.ok) { say(`EXTERNAL REFUSED reason=${checked.reason}; nothing was started`); return 2; }
    }
    if (!o.model.startsWith('external/')) {
      const kiloConfig = kiloSeatConfig(deps.env || process.env);
      if (!kiloConfig.ok) { (deps.error || console.error)(`KILO REFUSED reason=${kiloConfig.reason}; the wakeup tool cannot be turned off; nothing was started`); return 2; }
    }
  }
  if (o.client === 'qwen') {
    const pf = require('./qwen-client.cjs').preflight(o, deps, { env: deps.env || process.env, runtime, dryRun: o.dryRun });
    if (!pf.ok) { say(`QWEN REFUSED reason=${pf.reason}; nothing was started`); return 2; }
    for (const w of pf.warnings || []) say(w);
  }
  const callFile = path.join(runtime, `${o.name}-call.txt`);
  const done = `${seatMarker(o.name, o.launchRole)}_DONE`;
  // kimi: only the subscription route may start, and it is fixed BY CONSTRUCTION (PROTO-DEC-0211 item 1, PROTO-DEC-0212): the client is started on a private config
  // generated by the launcher from a fixed template (kimi-route.cjs), never on the user's own config, which is not read. Here only the checks that have no side effect run: a
  // moonshot-ai or malformed alias and a missing subscription login are refused BEFORE anything starts (exit 2); the private directory is made just before the start.
  const kimiRoute = o.client === 'kimi' ? (deps.kimiRoute || require('./kimi-route.cjs')) : null;
  const refuseKimi = route => { const text = require('./kimi-route.cjs').safeText; (deps.error || console.error)(`KIMI REFUSED reason=${text(route.reason, 80)}: ${text(route.detail || 'the route is not the Kimi Code subscription', 400)}; nothing was started`); return 2; };
  const env = deps.env || process.env;
  // codex approval switch (AUTO-APPROVE): an invalid value, or the bypass in a main checkout, starts nothing (a dry run refuses the same way)
  if (o.client === 'codex') {
    const approval = codexSeatApproval(env);
    if (approval.invalid) { say(`APPROVAL REFUSED reason=${CODEX_APPROVAL_ENV} must be review or bypass; nothing was started`); return 2; }
    if (approval.mode === 'bypass' && isMainCheckout(path.resolve(o.worktree), io)) { say('APPROVAL REFUSED reason=the codex bypass runs only in a linked worktree, not in a main checkout; nothing was started'); return 2; }
  }
  // kimi: the client is resolved ONCE to an absolute path before any key or config read, before the dry run and before the private directory is made or anything is started;
  // a failure refuses the launch with its fixed reason; the dry run takes the same resolution path, so an unresolvable client stops it too.
  const kc = kimiRoute ? (kimiRoute.resolveLaunch || require('./kimi-route.cjs').resolveLaunch)({ env, platform: deps.platform, worktree: o.worktree, tmpRoot: deps.tmpRoot, osHome: deps.kimiOsHome }) : null;
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
  const git = args => gitSpawn(o.client === 'qwen' ? o.qwen.git : 'git', args, { cwd: o.worktree, encoding: 'utf8', ...(o.client === 'qwen' ? { env: o.qwen.toolEnv } : {}) });
  const head = (git(['rev-parse', ...(/^[a-f0-9]{40}$/.test(o.expect) ? [] : ['--short']), 'HEAD']).stdout || '').trim();
  if (head !== o.expect) {
    io.writeFileSync(callFile, `exit=PREFLIGHT_FAIL head=${head} expected=${o.expect}\n`, 'utf8');
    say(`${done} PREFLIGHT_FAIL`);
    return 2;
  }
  if (Boolean(o.packetRole) !== Boolean(o.packetStage)) { (deps.error || console.error)('--packet-role and --packet-stage must be given together'); return 2; }
  // P3 and P13 (INJECTION-DEFENSE R2): the intake pins are checked before anything is created or started. The task file digest is always taken (recorded; a pin refuses a
  // different digest). A certifier launch that passed the precert step carries the digest of the receipt it rested on (deps.receiptPin, cli()); the receipt is read again here
  // and a different digest refuses: a receipt swapped between the gate and the start is not the one the gate accepted.
  const taskPin = taskPinGate(o, io);
  if (!taskPin.ok) return pinRefusal('TASK_PIN_REFUSED', taskPin.reason, o, io, say, callFile);
  o.taskSha256 = taskPin.hex;
  if (deps.receiptPin) {
    const again = receiptDigest({ worktree: o.worktree, head: deps.receiptPin.fullHead, authorChecks: deps.receiptPin.authorChecks }, deps);
    if (!again.ok || again.hex !== deps.receiptPin.hex) return pinRefusal('RECEIPT_PIN_REFUSED', again.ok ? 'RECEIPT_HASH_CHANGED' : again.reason, o, io, say, callFile);
    o.receiptSha256 = again.hex; o.receiptHead = again.head;
  }
  observeInjection(o, deps, io, say, runtime);
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
  // P8: every launch packet is written through this guarded io (a credential-shaped body is refused before the write; see packetGuard)
  const gio = packetGuard(io, o, deps, say, runtime);
  let packet = null;
  if (o.packetRole) {
    const packetTool = deps.launchPacket || require('./launch-packet.cjs');
    const gate = dispatchPacket ? confinement.deliveryPolicy(env, o.packetRole, o.allowExecutorPacket)
      : packetTool.policy(env.OPERATOR_PACKET, o.packetRole, o.allowExecutorPacket);
    if (gate.refused) { say(`PACKET REFUSED reason=${gate.refused}; nothing was started`); return 3; }
    if (gate.active) {
      try {
        packet = packetTool.preparePacket({ worktree: o.worktree, role: o.packetRole, stage: o.packetStage, frame: o.packetFrame, profile: o.packetProfile, client: o.client, ...(o.packetRetrieval === undefined ? {} : { retrieval: o.packetRetrieval }) }, { fs: gio });
        if (o.client === 'dahl') {
          const dir = path.join(o.worktree, '.ai', 'runtime', 'launch-prompts');
          o.launchPromptFile = path.join(dir, `${o.name}.md`);
          const timeout = require('../../.ai/bin/lib/client-command-timeout.cjs'); confinement.writeContainedFile(o.worktree, o.launchPromptFile, timeout.append(io.readFileSync(o.promptFile, 'utf8'), timeout.lookup(o.client, deps.registry), packet.pointerLine, { singleLine: false }), gio);
        }
      } catch (error) { if (isPacketSecretRefusal(error)) return packetSecretRefusal(error, o, io, say, callFile); say(dispatchPacket ? 'PACKET REFUSED reason=packet-compile-failed; nothing was started' : `PACKET REFUSED reason=${error.message}; nothing was started`); return 3; }
    }
  }
  // Certifier budget and scope (cert-economy.cjs): computed before the client starts, written into the packet file of this launch and
  // named by the first words of the instruction; a launch whose packet cannot be written starts nothing.
  let economy = null;
  if (o.launchRole === 'certifier') {
    const tool = deps.certEconomy || require('./cert-economy.cjs');
    try {
      const plan = tool.planFor({ worktree: o.worktree, head, client: o.client, kernelRoot: deps.kernelRoot || path.resolve(__dirname, '..', '..'), base: o.economyBase, continuation }, { ...(deps.certEconomyDeps || {}), fs: io, spawnSync: gitSpawn });
      const rel = `.ai/runtime/launch-prompts/${o.name}-economy-${Date.now().toString(36)}.md`;
      confinement.writeContainedFile(o.worktree, path.join(o.worktree, ...rel.split('/')), economyPacketText(tool, plan), gio);
      economy = { tool, plan, rel };
    } catch (error) { if (isPacketSecretRefusal(error)) return packetSecretRefusal(error, o, io, say, callFile); say(`CERT-ECONOMY REFUSED reason=${String((error && error.message) || error).replace(/[\r\n]+/g, ' ').slice(0, 160)}; nothing was started`); return 3; }
    o.turnLimit = economy.plan.turns.limit || undefined;
    o.economyPointer = `CERTIFIER BUDGET AND SCOPE: read ${economy.rel} first (budget, progress table, required runs, heavy gate); it overrides any instruction to run the full protocol suite.`;
    const p = economy.plan;
    const line = `CERT-ECONOMY turns=${p.budget.turns} tokens=${p.budget.tokens} class=${p.budget.riskClass} limit=${p.turns.limit === null ? 'packet-rule' : `${p.turns.flag}=${p.turns.limit}`} scope=${p.scope.mode} fallbacks=${p.scope.fallbacks.map(f => f.code).join(',') || 'none'} runs=${p.scope.runs.join(',')}${continuation ? ' continuation=yes' : ''}`;
    io.appendFileSync(callFile, `${line}\n`, 'utf8');
    say(line);
  }
  const turns = vibeMaxTurns(env);
  if (o.client === 'vibe' && turns.invalid) say('WARN VIBE_MAX_TURNS ignored (not a whole number from 1 to 9999); the default of 200 turns applies');
  if (o.client === 'codex' && env.COLABUS_SEAT_MCP !== '1' && isMainCheckout(o.worktree, io)) say('WARN codex seat in a main checkout: --ignore-user-config drops the trusted [projects] entry and [hooks.state], so the repository hooks will not run; use a worktree or COLABUS_SEAT_MCP=1');
  let eff;
  try { o.registry = deps.registry; eff = effortFor(o, o.registry); } catch (error) { say(`EFFORT REFUSED reason=registry unavailable (${error.message}); nothing was started`); return 2; }
  if (!eff.ok) { say(`EFFORT REFUSED reason=${eff.error} (P-L3-005 R-L3-005.7); nothing was started`); return 2; }
  o.effortArgs = eff.args;
  // PROTO-DEC-0215 item 1: the launcher creates a NEW EMPTY directory per launch (mkdtemp under the launch runtime, drive D) and passes it by
  // --output-dir; the served model is later read only from its export.json. A directory that cannot be created refuses the launch before
  // anything starts: a vibe launch without its export directory can never prove its served model. The child carries
  // VIBE_CLI=python (set in buildInvocation), so the front end that accepts the flag and writes the export is the one that runs.
  if (o.client === 'vibe') {
    try { o.exportDir = io.mkdtempSync(path.join(runtime, 'launch-export-')); }
    catch (error) { say(`EXPORT-DIR-FAILED code=${String((error && error.code) || 'UNKNOWN').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'UNKNOWN'}; nothing was started`); return 2; }
  }
  const reportsBefore = o.expectReport ? snapshotReports(io, o.worktree, o.expectReport, o.reportPinName) : undefined;
  // A certifier launch without --expect-report names no report, but a PARTIAL one is still never a verdict: every report this seat
  // writes or changes is read for the progress table after the run (snapshot of all reports, the same file-state comparison).
  const reportsBeforeAny = economy && !o.expectReport ? snapshotReports(io, o.worktree, '') : undefined;
  if (o.client === 'kilo' && o.model.startsWith('external/')) {
    o.externalInvocation = require('./lib/external-provider.cjs').buildInvocation({ routeId: o.model.slice('external/'.length), workDir: o.worktree, configDir: work.dir, role: o.launchRole, prompt: '', env: work.env, io, table: o.externalRoutes });
    if (!o.externalInvocation.ok) { say(`EXTERNAL REFUSED reason=${o.externalInvocation.reason}; nothing was started`); return 2; }
  }
  // kimi: the private config directory of this launch, after every other refusal and before the heartbeat; the whole life cycle (prepare, the one cleanup of every refusal path,
  // the checks before the start and after the exit) is kimi-route.cjs launchSession; this file holds only the call sites
  const kg = kimiRoute ? (kimiRoute.launchSession || require('./kimi-route.cjs').launchSession)(kimiRoute, { model: o.model, env, fs: io, tmpRoot: seatMcp.kimiTmpRoot({ role: o.launchRole, root: o.worktree, io }) || deps.tmpRoot, osHome: deps.kimiOsHome, platform: deps.platform, error: deps.error || console.error }) : null;
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
  // The seat's MCP plan for its role; a claude kernel seat gets its --mcp-config file in the launch directory, and a file that cannot be
  // written degrades the seat to no server (MCP is advisory, PROTO-DEC-0170 item 4), never a refusal
  o.seatMcp = seatMcpPlan(o, work, io);
  if (o.client === 'kimi' && o.kimiRoute && !seatMcp.kimiConfig(o.seatMcp, o.kimiRoute.home, o.worktree, io)) {
    o.seatMcp = seatMcp.plan({ role: 'pre-review', root: o.worktree, env: work.env, io });
    o.seatMcp.notes.push('SEMGREP_KIMI_CONFIG_REFUSED: optional server skipped');
    o.seatMcp.line = seatMcp.line(o.seatMcp.mode, o.seatMcp.list, o.seatMcp.notes);
  }
  guarded(() => writeSeatMcpLine(io, runtime, o.name, o.seatMcp.line));
  const invocation = guarded(() => buildInvocation(o, work.env, packet));
  // File-based clients must receive the same policy, not only an unused argText.
  if (o.client === 'dahl' && !o.launchPromptFile) {
    const timeout = require('../../.ai/bin/lib/client-command-timeout.cjs');
    o.launchPromptFile = path.join(o.worktree, '.ai', 'runtime', 'launch-prompts', `${o.name}.md`);
    try { confinement.writeContainedFile(o.worktree, o.launchPromptFile, timeout.append(io.readFileSync(o.promptFile, 'utf8'), timeout.lookup(o.client, o.registry), packet?.pointerLine, { singleLine: false }), gio); }
    catch (error) { if (!isPacketSecretRefusal(error)) throw error; heartbeat.stop(hb); return packetSecretRefusal(error, o, io, say, callFile); }
    invocation.args[invocation.args.indexOf('--prompt-file') + 1] = o.launchPromptFile;
  }
  // kimi: the child gets the private home and no KIMI_* variable of the caller; the user's home, config and variables are out of the route
  if (invocation && kg) invocation.spawnOptions = { ...invocation.spawnOptions, env: kg.childEnv(invocation.spawnOptions.env) };
  // kimi: the spawn uses the resolved absolute path (a shim through the absolute command interpreter), never the bare name
  if (invocation && kg) { invocation.args = [...kc.prefix, ...invocation.args]; invocation.command = kc.command; }
  if (!invocation) { (deps.error || console.error)(`unknown client ${o.client}`); return 2; }
  // The intake and recommendation never change the invocation built above.
  // Certifiers always require an explicit --client/--model route. The assignment
  // switch is telemetry for them, never an automatic route or an admission gate;
  // eligibility also refuses certifier auto-assignment without an explicit route.
  let intake = null;
  try {
    let launchId = null; try { launchId = require('../../.ai/bin/launch-record.cjs').buildLaunchRecord({ name: o.name, startedAt }).launchId; } catch { /* no id */ }
    intake = require('../../tools/assign/launch-intake.cjs').capture({ launcher: 'cert-launch', name: o.name, launchId,
      worktree: o.worktree, taskFile: o.taskFile || o.promptFile, base: o.selectionBase,
      deviationReason: value(argv, 'deviation-reason'),
      role: packet ? packet.role : o.launchRole === 'author' ? 'author' : o.launchRole === 'pre-review' ? 'reviewer' : 'certifier',
      say, ownerExplicit: argv.includes('--client') || argv.includes('--model'),
      operator: { client: o.client, model: o.model, effort: eff.effortUsed } },
    { ...(deps.intake || {}), resolverShadow: deps.resolverShadow, runtimeDir: runtime, shadowDeps: { now: () => new Date(startedAt) } });
  } catch { /* the shadow never blocks a launch */ }
  if (intake?.selectionShadow.advice?.mode === 'assign' && intake.selectionShadow.advice.status === 'needs-operator-choice') {
    heartbeat.stop(hb);
    const reason = intake.selectionShadow.advice.reason;
    settleLaunch(3);
    try {
      (deps.launchRecord || require('../../.ai/bin/launch-record.cjs')).writeLaunchRecord({
        name: o.name, client: o.client, model: o.model, effort: eff.effortUsed, startedAt, ...require('../../.ai/bin/launch-record.cjs').wrapperFields(env, o.name),
        ...require('../../.ai/bin/launch-record.cjs').recordPaths(o.worktree, o.promptFile),
        role: intake.taskFrame.role, taskFrame: intake.taskFrame, selectionShadow: intake.selectionShadow,
        exitCode: 3, failureClass: 'UNKNOWN', verdict: 'NONE', note: `launch-not-started needs-operator-choice reason=${reason}` });
    } catch (e) { const line = recordFailedLine(e); io.appendFileSync(callFile, `${line}\n`, 'utf8'); (deps.error || console.error)(line); }
    io.appendFileSync(callFile, `exit=SELECTION_REFUSED reason=${reason}\n`, 'utf8');
    say(`SELECTION REFUSED needs-operator-choice reason=${reason}; nothing was started`); return 3;
  }
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
  if (o.client === 'qwen' || o.externalInvocation) { try { result = spawnClient(seat, invocation, spawnSync); } catch (error) { result = { error, status: null, stdout: null, stderr: null }; } }
  else result = guarded(() => spawnClient(seat, invocation, spawnSync));
  if (o.externalInvocation) {
    const externalProvider = require('./lib/external-provider.cjs');
    // Mask with the validated invocation's key name even if the route table changed during the run.
    result = externalProvider.maskResult(result, invocation.spawnOptions.env, o.externalInvocation.keyEnv);
  }
  // kimi: the check after the exit; a client that never started, gave no numeric exit status or ended with a non-zero one is unproven (fixed reason) and its directory is removed too
  // Read numeric events while the private home still exists, including failed runs.
  const nativeUsage = o.client === 'kimi' ? require('../../.ai/bin/accounting/lib/run-usage.cjs').kimiUsage(o.kimiRoute && o.kimiRoute.home) : undefined;
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
  // After the exit the export file must be there. A vibe run that wrote no export.json proves no served model
  // (PROTO-DEC-0215 item 1 reads only that file), so the launch is REFUSED with its named reason: an unproven vibe seat never stands.
  let exportMissing = false;
  if (o.client === 'vibe') {
    try { exportMissing = !io.statSync(path.join(o.exportDir, 'export.json')).isFile(); }
    catch { exportMissing = true; }
  }
  const exportMissingText = exportMissing ? 'VIBE-EXPORT-REFUSED reason=export-missing; the launch is not a verdict' : '';
  const report = o.expectReport ? checkReport(io, o.worktree, o.expectReport, startedAt, reportsBefore, o.reportPinName) : { ok: true, verdict: null, reason: null, file: null };
  // Certifier budget: a report with a verdict that keeps an audit item open which could block, says Status: PARTIAL or has no progress
  // table is PARTIAL (the reader of the acceptance path, review-facts.cjs progressOf); it is not a verdict and gets one continuation.
  let partial = null;
  const progressOfFile = name => {
    let text = null;
    try { const g = realInside(path.resolve(o.worktree), path.join(o.worktree, 'docs', 'reviews', name), { refuseHardlinks: true }); if (g.ok) text = io.readFileSync(g.real, 'utf8'); } catch { text = null; }
    return text === null ? null : require('../../.ai/bin/lib/review-facts.cjs').progressOf(text);
  };
  if (economy && report.ok && report.file) {
    const pr = progressOfFile(report.file);
    const why = partialReason(pr);
    if (why) partial = { reason: why, report: `docs/reviews/${report.file}`, open: pr ? economy.tool.packetOpen(pr.open.map(r => r.item)) : [] };
  }
  if (economy && !o.expectReport && !partial) {
    const after = snapshotReports(io, o.worktree, '');
    if (after === null || reportsBeforeAny === null) partial = { reason: 'report-unreadable', report: 'docs/reviews', open: [] };
    else {
      for (const [name, state] of after) {
        // a continuation also re-reads the draft it was started from: a seat that leaves a PARTIAL draft untouched is still PARTIAL
        const draft = continuation && `docs/reviews/${name}` === continuation.report;
        if (!draft && reportsBeforeAny.get(name)?.hash && reportsBeforeAny.get(name).hash === state.hash) continue;
        const pr = state.unsafe ? null : progressOfFile(name);
        const why = partialReason(pr);
        if (why) { partial = { reason: why, report: `docs/reviews/${name}`, open: pr ? economy.tool.packetOpen(pr.open.map(r => r.item)) : [] }; break; }
      }
    }
  }
  if (partial && !continuation) outcome.partial = partial;
  const reportOk = report.ok && !partial;
  const reportWord = o.expectReport ? ` report=${partial ? 'PARTIAL' : reportOk ? 'ok' : 'NO_VERDICT'}` : '';
  const endedAt = (deps.now || (() => new Date()))().toISOString();
  // The ONE derivation path deriveForLaunch(context) reads the launch that really ran - the
  // argv and the spawn environment the client was started with, the export directory of a vibe launch, the streams it captured - and returns
  // requestedModelVia and the served-model proof TOGETHER (PROTO-DEC-0209: the explicit --model the launcher passed is a structured
  // source). No call of requestedModelVia or deriveServedModel remains here: no caller can hand the derivation a partial argument list.
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
  // PROBE-SERVED-MODEL: the named class of the mismatch - SERVED_FAMILY_MISMATCH when the maker families of the requested and the proven model are known and differ, else SERVED_MODEL_MISMATCH
  const mismatchClass = mismatch ? (mismatch.mismatchClass || 'SERVED_MODEL_MISMATCH') : null;
  const mismatchText = mismatch ? `SERVED_MODEL_MISMATCH requested=${o.model} served=${mismatch.servedModel} source=${mismatch.source} class=${mismatchClass}; the launch is not a verdict` : '';
  // finding 7: a wakeup call ends the launch as WAKEUP_TOOL (exit 3) unless the report gate proved a closed verdict of this launch
  let wakeupTool = null;
  try { wakeupTool = wakeupToolCall(o.client, captured); } catch { wakeupTool = null; }
  const wakeupFails = Boolean(wakeupTool) && !(o.expectReport && reportOk);
  const marker = mismatch ? done.replace(/_DONE$/, '_SERVED_MODEL_MISMATCH') : exportMissing ? done.replace(/_DONE$/, '_EXPORT_MISSING') : partial ? done.replace(/_DONE$/, '_PARTIAL') : (reportOk && !(kimiAfter && kimiAfter.notRun) && !wakeupFails ? done : done.replace(/_DONE$/, '_NO_VERDICT'));
  // Tokens and cost (cost-record): from the output the client printed or its own session store; unknown is never zero; advisory, never changes the exit.
  let usage = { fields: {}, info: {} }; let usageText = '';
  try {
    const writer = deps.usageTool || require('../../.ai/bin/launch-record.cjs');
    usage = writer.usageRecordFields({ client: o.client, model: o.model, servedModel: servedFields.servedModel, output: qwenRun ? '' : o.client === 'codex' ? captured : (decodedStreams.stdout || ''), endedAt, env, workdir: o.worktree, nativeUsage }, deps.usage || {});
    usageText = (writer.usageLine && writer.usageLine(usage.fields)) || '';
  } catch (e) { usage = { fields: unknownUsageFields(e), info: {} }; usageText = ''; }
  // qwen (PROTO-DEC-0211): tokens are not counted for this client; the cost is the free quota when the pinned route held (qwen-client.cjs freeQuotaCost), never a priced number
  if (o.client === 'qwen') { try { usage = require('./qwen-client.cjs').usageFields({ model: o.model, servedModel: servedFields.servedModel }); usageText = require('../../.ai/bin/launch-record.cjs').usageLine(usage.fields) || ''; } catch (e) { usage = { fields: unknownUsageFields(e), info: {} }; usageText = ''; } }
  let limitEvidence = null;
  // Numeric usage cannot prove a billing route. An unproven private config keeps
  // its unknown price basis while the measured usage survives (PROTO-DEC-0251).
  if (o.client === 'kimi') {
    const served = require('./kimi-served.cjs'); const kimiShow = require('./kimi-route.cjs').show;
    const intact = Boolean(kimiAfter && kimiAfter.ok === true);
    if (!intact) usage.fields.cost = { ...served.usageFields(false, served.proofReason(kimiAfter)).cost, priceSnapshot: usage.fields.cost.priceSnapshot, reason: 'kimi route unproven; numeric usage retained' };
    usageText = require('../../.ai/bin/launch-record.cjs').usageLine(usage.fields) || '';
    const routeNote = !o.kimiRoute ? '' : intact ? `kimi-route=generated-config provider=${kimiShow(o.kimiRoute.provider, 64)}` : `kimi-route=unproven reason="${served.proofReason(kimiAfter)}"`;
    servedNote = [servedNote, routeNote, !usage.fields.tokens ? 'usage-unknown reason=no-structured-usage' : ''].filter(Boolean).join(' ');
  }
  try { if (o.client === 'vibe') limitEvidence = vibeTurnLimit({ text: captured, status: result.status, stopReason: usage.info && usage.info.stopReason }); } catch { limitEvidence = null; }
  const limitText = limitEvidence ? `TURN_LIMIT client=vibe max=${turns.value} evidence=${limitEvidence}` : '';
  // AUTO-APPROVE: a failed run whose output ends on a permission prompt is APPROVAL_STALL (after TURN_LIMIT, before NO_VERDICT); only a pattern id is printed
  let stall = null;
  try { stall = require('./approval-stall.cjs').approvalStall({ client: o.client, texts: qwenRun ? [] : [decodedStreams.stdout, decodedStreams.stderr], failed: result.status !== 0 || !reportOk, registry: deps.approvalRegistry }); } catch { stall = null; }
  const stallText = stall ? require('./approval-stall.cjs').stallLine(o.client, stall) : '';
  const wakeupText = wakeupTool ? `WAKEUP_TOOL client=${o.client} tool=${wakeupTool}${wakeupFails ? '; the run ended at the wakeup call, the launch is not a verdict' : '; the report holds a closed verdict of this launch'}` : '';
  const reportText = o.expectReport && !reportOk && !partial ? `REPORT verdict=none reason=${report.reason}${report.file && !qwenRun ? ` file=${report.file}` : ''}` : '';
  // The closed failureClass vocabulary of the record (launch-record-validate.cjs) has no export class and the
  // protocol accounting file is not in this task's scope, so the refusal records UNKNOWN there; its named reason travels in
  // the record note, in the VIBE-EXPORT-REFUSED line and in the EXPORT_MISSING marker.
  const failureClass = mismatch ? mismatchClass : exportMissing ? 'UNKNOWN' : partial ? 'PARTIAL' : limitEvidence ? 'TURN_LIMIT' : wakeupFails ? 'WAKEUP_TOOL' : stall ? 'APPROVAL_STALL' : (!reportOk ? 'NO_VERDICT' : undefined);
  const partialText = partial ? `PARTIAL reason=${partial.reason} report=${partial.report}${partial.open.length ? ` open=${partial.open.length}` : ''}${continuation ? ' (continuation: no further continuation)' : ''}` : '';
  // After the seat: a tracked file changed outside the report and journal directories is a mutant the seat left in the tree.
  let mutantText = '';
  if (economy) {
    try { const m = economy.tool.mutantsLeft(economy.tool.gitOf(o.worktree, gitSpawn)); mutantText = !m.ok ? 'MUTANTS-CHECK-FAILED' : m.files.length ? `MUTANTS-LEFT files=${m.files.length} first=${m.files.slice(0, 3).join(',')}` : ''; } catch { mutantText = 'MUTANTS-CHECK-FAILED'; }
  }
  const body = qwenRun ? require('./qwen-client.cjs').factsLine(qwenRun.facts) : captured;
  settleLaunch(!reportOk || mismatch || exportMissing || wakeupFails || stall ? 3 : (result.status === null ? 1 : result.status));
  let recordFailed = '';
  try {
    const writer = deps.launchRecord || require('../../.ai/bin/launch-record.cjs');
    // A fixed reason also survives subscription pricing; arbitrary usage errors
    // are never copied into this note.
    const paths = require('../../.ai/bin/launch-record.cjs').recordPaths(o.worktree, o.launchPromptFile || o.promptFile);
    const recordInput = { client: o.client, model: o.model, effort: eff.effortUsed, role: packet ? packet.role : 'certifier', stage: packet ? packet.stage : 'accept', route: `cli:${o.client}`, name: o.name, ...paths, ...provenance, ...require('../../.ai/bin/launch-record.cjs').wrapperFields(env, o.name), head, workRootDir: work.dir, exitCode: reportOk && !mismatch && !exportMissing && !wakeupFails && !stall ? result.status : 3, startedAt, failureClass, note: [o.expectReport ? `report=${partial ? `PARTIAL reason=${partial.reason}` : reportOk ? 'ok' : `NO_VERDICT reason=${report.reason}`}` : '', mutantText ? mutantText.split(' first=')[0].toLowerCase() : '', mismatch ? `served-model-mismatch served=${mismatch.servedModel}` : '', exportMissing ? 'vibe-export-missing reason=export.json of the launch output directory is absent after the run' : '', stall ? `approval-stall pattern=${stall.id}` : '', servedNote, o.client === 'qwen' ? `tokens-not-counted reason="${require('./qwen-client.cjs').NOT_COUNTED}"` : ''].filter(Boolean).join(' ') || undefined,
      ...(packet ? { packetHash: packet.packetHash, packetProfile: packet.profile, packetBytes: packet.bytes, packetEstTokens: packet.estTokens } : {}), ...servedFields, ...usage.fields,
      ...(economy ? economy.tool.recordFields(economy.plan, usage.fields) : {}) };
    if (intake) Object.assign(recordInput, { taskClass: intake.taskFrame.tier, tier: intake.taskFrame.tier,
      riskClass: intake.taskFrame.riskClass, taskFrame: intake.taskFrame, selectionShadow: intake.selectionShadow });
    else recordInput.riskClass = 'A'; // PROTO-DEC-0136: unavailable intake cannot prove B.
    if (report?.verdict) recordInput.verdict = report.verdict;
    // the intake pins of this launch (design P2a, P3, P13): the path the report gate read, the task digest and the receipt the launch rested on
    if (o.reportPinName) recordInput.reportPath = o.expectReportPath;
    if (o.taskSha256) recordInput.taskSha256 = `sha256:${o.taskSha256}`;
    if (o.receiptSha256) { recordInput.receiptSha256 = `sha256:${o.receiptSha256}`; if (o.receiptHead) recordInput.receiptHead = o.receiptHead; }
    if(cycleControl)recordInput.role=o.launchRole;
    writer.writeLaunchRecord(recordInput);
  } catch (e) { recordFailed = recordFailedLine(e); }
  if (recordFailed) (deps.error || console.error)(recordFailed);
  const extra = [wakeupText, limitText, stallText, partialText, mutantText, reportText, usageText, mismatchText, exportMissingText, servedText, streamRefused, recordFailed].filter(Boolean).map(l => `${l}\n`).join('');
  io.appendFileSync(callFile, `marker=${marker}\n${body}\n${extra}${marker} exit=${result.status}${reportWord} end=${endedAt}\n`, 'utf8');
  (deps.usageWrite || (line => process.stdout.write(`\n${line}\n`)))(require('../../.ai/bin/accounting/lib/run-usage.cjs').frame(usage.fields));
  for (const line of [wakeupText, limitText, stallText, partialText, mutantText, reportText, usageText, mismatchText, exportMissingText, servedText, streamRefused]) if (line) say(line);
  say(`${marker} exit=${result.status}${reportWord}`);
  return !reportOk || mismatch || exportMissing || wakeupFails || stall ? 3 : (result.status === null ? 1 : result.status);
  } finally {
    settleLaunch(1);
  }
}

module.exports = { GIT_NO_HOOKS, noHooksSpawn, economyPacketText, DEFAULT_RUNTIME, CODEX_APPROVAL_ENV, codexSeatApproval, value, options, effortFor, buildInvocation, seatMcpPlan, writeSeatMcpLine, observeInjection, main, cli, splitPrecert, precertStep, launchOnce, reportVerdict, gateReportVerdict, reportPinName, taskPinGate, receiptDigest, packetGuard, isPacketSecretRefusal, packetSecretRefusal, pinRefusal, shaHex, checkReport, snapshotReports, vibeMaxTurns, vibeTurnLimit, wakeupToolCall, WAKEUP_TOOLS, kiloSeatConfig };
if (require.main === module) process.exitCode = cli(process.argv.slice(2));

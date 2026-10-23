'use strict';
// Foreground seat recovery. No inferred routes, no output text in journal metadata.
const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { randomBytes } = require('node:crypto');
const failover = require('../../.ai/bin/protocol-failover.cjs');
const records = require('../../.ai/bin/launch-record.cjs');
const { loadRegistry } = require('../../.ai/bin/protocol-dispatch/registry.cjs');

// Input domain: nonzero exit plus the client's diagnostic channel only.
// Bare numbers and loose words ("auth", "quota", "limit") are not evidence.
const httpAuth = /^(?:Error:\s*)?(?:HTTP(?: error)?\s+401\b|401 Unauthorized\b|invalid (?:API )?key\b)/im;
const httpQuota = /^(?:Error:\s*)?(?:HTTP(?: error)?\s+429\b|429 Too Many Requests\b)/im;
const network = /^(?:(?:Error|TypeError):\s*)?(?:HTTP(?: error)?\s+5\d\d\b|ECONNRESET\b|ECONNREFUSED\b|ETIMEDOUT\b|EAI_AGAIN\b|ENOTFOUND\b|socket hang up\b|fetch failed\b)/im;
const PATTERNS = {
  codex: { AUTH: [httpAuth, /^(?:Error:\s*)?(?:Authentication failed|Please (?:log|sign) in again)\b/im], QUOTA: [httpQuota, /^(?:Error:\s*)?(?:You(?:'ve| have) hit your usage limit|weekly limit (?:reached|exceeded))\b/im] },
  claude: { AUTH: [httpAuth, /^(?:Error:\s*)?(?:OAuth token (?:has )?expired|Invalid authentication token)\b/im], QUOTA: [httpQuota, /^(?:Error:\s*)?(?:You(?:'ve| have) hit your limit|usage limit (?:reached|exceeded)|weekly limit (?:reached|exceeded))\b/im] },
  agy: { AUTH: [httpAuth, /^(?:Error:\s*)?(?:OAuth (?:token )?expired|invalid_grant|UNAUTHENTICATED)\b/im], QUOTA: [httpQuota, /^(?:Error:\s*)?(?:Individual quota reached|RESOURCE_EXHAUSTED)\b/im] },
  vibe: { AUTH: [httpAuth, /^(?:Error:\s*)?AuthenticationError\b/im], QUOTA: [httpQuota, /^(?:Error:\s*)?(?:HTTP(?: error)?\s+402\b[^\n]*Vibe budget exhausted|Vibe budget exhausted)\b/im] },
  kilo: { AUTH: [httpAuth, /^(?:Error:\s*)?AuthenticationError\b/im], QUOTA: [httpQuota, /^(?:Error:\s*)?(?:Insufficient credits|Quota exceeded)\b/im] },
  mimo: { AUTH: [httpAuth, /^(?:Error:\s*)?AuthenticationError\b/im], QUOTA: [httpQuota, /^(?:Error:\s*)?(?:Insufficient balance|Quota exceeded)\b/im] },
  kimi: { AUTH: [httpAuth, /^(?:Error:\s*)?Login required\b/im], QUOTA: [httpQuota, /^(?:Error:\s*)?Quota exceeded\b/im] },
  qwen: { AUTH: [httpAuth, /^(?:Error:\s*)?InvalidApiKey\b/im], QUOTA: [httpQuota, /^(?:Error:\s*)?(?:Free quota exhausted|Quota exceeded)\b/im] },
};
function diagnostics(client, result, env = {}) {
  const stdout = String(result.stdout || '');
  const stderr = String(result.stderr || '').trimEnd();
  // kilo/mimo are invoked with --format json. Only a top-level error event is
  // diagnostic; text parts, assistant messages and nested JSON remain data.
  if (client === 'kilo' || client === 'mimo') {
    const errors = [];
    for (const line of stdout.split(/\r?\n/)) {
      try {
        const event = JSON.parse(line);
        if (event.type === 'error' && event.error && typeof event.error.data?.message === 'string') errors.push(event.error.data.message);
      } catch { /* not a structured event */ }
    }
    if (errors.length) return errors.join('\n');
  }
  if ((client === 'agy' && env.AGY_OUTPUT_FORMAT === 'json') || (client === 'claude' && env.CLAUDE_OUTPUT_FORMAT === 'json')) {
    try {
      const event = JSON.parse(stdout);
      if (event.error && typeof event.error.message === 'string' && !event.result && !event.content) return event.error.message;
    } catch { /* no structured diagnostic */ }
  }
  // Text transports: accept only a standalone terminal stderr diagnostic with
  // the CLI prefix. Never search the model stream or a multiline answer dump.
  // vibe repeats its last assistant message on stderr at the turn limit: reject
  // that echo even if the model chose a native-looking Error: prefix.
  if (!/^(?:Error|ERROR|TypeError|Teleport error): [^\r\n]+$/.test(stderr)) return '';
  const answers = [stdout.trim()];
  for (const line of stdout.split(/\r?\n/)) {
    try {
      const event = JSON.parse(line);
      if (event.role === 'assistant' && Array.isArray(event.content)) answers.push(event.content.filter(p => p.type === 'text').map(p => p.text).join('').trim());
      if (event.type === 'text' && typeof event.part?.text === 'string') answers.push(event.part.text.trim());
    } catch { /* ordinary stdout is always answer data */ }
  }
  if (answers.some(answer => answer && answer.includes(stderr))) return '';
  return stderr.replace(/^(?:ERROR|TypeError|Teleport error): /, 'Error: ');
}
function classify(client, result, env) {
  if (result.status === 0 && !result.error && !result.signal) return 'SUCCESS';
  if (!Number.isInteger(result.status) || result.error || result.signal) return 'OTHER';
  const rules = Object.hasOwn(PATTERNS, client) && PATTERNS[client];
  if (!rules) return 'OTHER';
  const text = diagnostics(client, result, env);
  for (const kind of ['AUTH', 'QUOTA']) if (rules[kind].some(re => re.test(text))) return kind;
  return network.test(text) ? 'TRANSIENT' : 'OTHER';
}
const value = (argv, key, fallback) => { const n = argv.indexOf(`--${key}`); return n < 0 ? fallback : argv[n + 1]; };
// Normalize once before any Git, packet, heartbeat or client work. In particular,
// an equals-form exclusion must never silently disable the independence check.
// launch-role is the record's role field of the launch (PROTO-DEC-0169 item 4 sibling; cert-launch.cjs), a value option of every launcher that wraps here.
const VALUE_OPTIONS = new Set(['client', 'model', 'worktree', 'name', 'prompt-file', 'expect-sha', 'branch', 'args-file', 'max-tokens', 'expect-report', 'packet-role', 'packet-stage', 'packet-frame', 'packet-profile', 'effort', 'tier', 'fallback', 'exclude-families', 'launch-role']);
const FLAG_OPTIONS = new Set(['dry-run', 'allow-executor-packet']);
const OPTION = /^--([a-z][a-z-]*)(?:=(.*))?$/s;
// The value of one value option at argv[i]: the next item (--name VALUE) or the inline part (--name=VALUE).
// -> { value, next } or { problem }; a blank value or one that is itself an option is a missing value.
function optionValue(argv, i, key, inline) {
  const item = inline === undefined ? argv[i + 1] : inline;
  if (typeof item !== 'string' || !item.trim() || item.startsWith('--')) return { problem: `missing-option-value option=--${key}` };
  return { value: item, next: inline === undefined ? i + 2 : i + 1 };
}
function normalize(argv) {
  const out = []; const seen = new Set();
  for (let i = 0; i < argv.length; i++) {
    const match = OPTION.exec(argv[i]);
    if (!match || (!VALUE_OPTIONS.has(match[1]) && !FLAG_OPTIONS.has(match[1]))) throw new Error('unknown-option');
    const [, key, inline] = match;
    if (seen.has(key)) throw new Error(`duplicate-option option=--${key}`);
    seen.add(key);
    if (FLAG_OPTIONS.has(key)) {
      if (inline !== undefined) throw new Error(`unexpected-option-value option=--${key}`);
      out.push(`--${key}`); continue;
    }
    const got = optionValue(argv, i, key, inline);
    if (got.problem) throw new Error(got.problem);
    out.push(`--${key}`, got.value);
    i = got.next - 1;
  }
  return out;
}
// The one reader of the client and model of a launch: the seat launchers (cert-launch, fix-launch), this
// recovery and the route step of launch-wrapper read them only here. tokens may be a launcher argv or a whole
// child command (other items are not options of a launcher and are passed over). Both forms are read
// (--client VALUE, --client=VALUE); a repeated name, a missing value and any other spelling of the name
// (another case, one dash, a colon or a space after it) are refused with a named reason.
// -> { client, model } (undefined when not stated) or { problem }
const IDENTITY_KEYS = ['client', 'model'];
const VISIBLE = /^[\x21-\x7e]+$/;
const LOOKALIKE = Object.fromEntries(IDENTITY_KEYS.map(key => [key, new RegExp(`^-{1,2}${key}(?:$|[=:\\s])`, 'i')]));
function identity(tokens) {
  const out = { client: undefined, model: undefined };
  for (const key of IDENTITY_KEYS) {
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      const match = typeof token === 'string' ? OPTION.exec(token) : null;
      if (!match || match[1] !== key) {
        if (typeof token === 'string' && LOOKALIKE[key].test(token)) return { problem: `unknown-option-form option=--${key}` };
        continue;
      }
      const got = optionValue(tokens, i, key, match[2]);
      if (got.problem) return { problem: got.problem };
      if (out[key] !== undefined) return { problem: `duplicate-option option=--${key}` };
      // A client or model is visible ASCII; an invisible or other character is never a route name
      if (!VISIBLE.test(got.value)) return { problem: `invalid-option-value option=--${key}` };
      out[key] = got.value;
      i = got.next - 1;
    }
  }
  return out;
}
// The first route of a fix launch: fix-launch starts this client and model when no route is substituted. plan, fix-launch and the
// route step of launch-wrapper read it only here.
const FIX_FIRST = Object.freeze({ client: 'claude', model: 'claude-sonnet-5-5' });
// The INTENDED client and model of the first spawn of a launch (PROTO-DEC-0240 item 1), read once through
// the one reader before anything of the launch exists. kind 'fix': the default pair FIX_FIRST, and a stated --client or --model must
// name that same pair (fix-launch never started another first client; a substitute goes in --fallback); any other kind: the stated pair.
// -> { client, model } or { problem }
function intendedPair(tokens, kind) {
  const stated = identity(tokens);
  if (stated.problem || kind !== 'fix') return stated;
  for (const key of IDENTITY_KEYS) if (stated[key] !== undefined && stated[key] !== FIX_FIRST[key]) return { problem: `fix-first-route option=--${key}` };
  return { ...FIX_FIRST };
}
// The route step of launch-wrapper reads a child command through the closed entry grammar of route-gate launchEntry,
// which reads the arguments of a cert or fix launcher with intendedPair and normalize above.
function replace(argv, key, value) {
  const out = [...argv]; const n = out.indexOf(`--${key}`);
  if (n < 0) out.push(`--${key}`, value); else out[n + 1] = value;
  return out;
}
// The one family resolution of the exclusion grammar. Every --exclude-families item
// (a family name or a model spelling) is resolved through model-identity
// declaredFamily; an unknown spelling is refused. the model selection imports this function
// instead of copying the grammar, so both tools resolve an exclusion item identically.
function excludedFamilies(excluded, identity) {
  const id = identity || require('../../.ai/bin/lib/model-identity.cjs');
  const families = excluded.split(',').map(f => id.declaredFamily(f));
  if (families.includes('UNKNOWN')) throw new Error('unknown excluded family');
  return families;
}
function plan(argv, kind, deps) {
  argv = normalize(argv);
  const intended = intendedPair(argv, kind);
  if (intended.problem) throw new Error(intended.problem);
  const first = { client: intended.client, model: intended.model };
  const raw = value(argv, 'fallback', ''); const excluded = value(argv, 'exclude-families', '');
  if (typeof raw !== 'string' || typeof excluded !== 'string' || raw.startsWith('--') || excluded.startsWith('--')) throw new Error('missing option value');
  const routes = [first];
  if (raw) for (const item of raw.split(',')) {
    const m = /^([a-z][a-z0-9-]*):([A-Za-z0-9][A-Za-z0-9._:/-]{0,127})$/.exec(item);
    if (!m) throw new Error('invalid fallback route');
    routes.push({ client: m[1], model: m[2] });
  }
  if (new Set(routes.map(r => `${r.client}:${r.model}`)).size !== routes.length) throw new Error('duplicate route');
  const modelIdentity = excluded ? (deps.modelIdentity || require('../../.ai/bin/lib/model-identity.cjs')) : null;
  const families = excluded ? excludedFamilies(excluded, modelIdentity) : [];
  for (const r of routes) {
    // qwen has an invocation as the PRIMARY route only (its route check and private directories are made by cert-launch before anything starts); as a fallback it stays
    // unsupported-invocation: the substitute launch of a fallback does not make them
    // kimi has an invocation in cert-launch.cjs, so it may be the PRIMARY route (one attempt; its launcher refuses before anything starts when the private subscription config cannot be made); as a fallback it
    // stays unsupported-invocation (the substitute launch of a fallback is not wired for it)
    if (!['codex', 'claude', 'agy', 'vibe', 'kilo', 'mimo', 'dahl'].includes(r.client) && !(r === first && (r.client === 'qwen' || r.client === 'kimi'))) throw new Error(`unsupported-invocation client=${r.client}`);
    if (families.length) {
      const family = modelIdentity.declaredFamily(r.model);
      if (family === 'UNKNOWN' || families.includes(family)) throw new Error('excluded or unknown route family');
    }
  }
  // dahl's legacy primary invocation has no diagnostic adapter for recovery.
  if (routes.slice(1).some(r => r.client === 'dahl')) throw new Error('unsupported-invocation client=dahl');
  if (routes.length > 1) {
    const registry = deps.registry || loadRegistry();
    for (const r of routes.slice(1)) {
      if (!Object.hasOwn(PATTERNS, r.client) || !Object.hasOwn(registry.clients, r.client) || registry.clients[r.client].present !== true) throw new Error('fallback client is unavailable');
    }
  }
  return routes;
}

// The route decision of one client and model (PROTO-DEC-0240 items 1 and 2), the one decision of the spawn point
// (spawnClient below) and of the switch selection. The client and model are decided against the route record by the
// route gate that launch-wrapper runs before the first child (tools/operator-knowledge, loaded at run time only). It
// runs no live probe: a route the gate refuses (failed, stale, unknown status, a probe not fresh in the record), and a
// gate that cannot decide are refused with a recorded line; a client and model that no row of the record names are
// admitted with a recorded transition line while the record does not say its coverage is complete. The decision the
// launch wrapper took for this launch (ROUTE_DECISION_ENV, set by the wrapper in the child environment) is handed on
// only for the SAME client and model: its owner override (an owner act; it never applies to a failed route) and its ok
// live probe of this launch (route-gate checkRoute priorProbe). Without the gate module and the record (a project that
// does not carry them) there is nothing to check. deps.routeGate { module, recordFile, now } is for the tests.
const ROUTE_GATE_MODULE = path.join(__dirname, '..', '..', 'tools', 'operator-knowledge', 'route-gate.cjs');
const ROUTE_STATE_FILE = path.join(__dirname, 'route-state.json');
const ROUTE_STATE_FILE_ENV = 'OK_ROUTE_STATE_FILE';
const ROUTE_DECISION_ENV = 'OK_ROUTE_DECISION';
const envText = (env, key) => (env && typeof env[key] === 'string' && env[key].trim() ? env[key] : null);
// The launch roots of a launcher process (PROTO-DEC-0240 item 3): its repository, the main checkout (its .ai/runtime), the runtime
// directory of the launch and the work root; a root that cannot be resolved stays null, and the probe root is then refused.
function launchRootsOf(deps, env) {
  const repo = path.resolve(__dirname, '..', '..');
  const repoPaths = require('../../.ai/bin/repo-paths.cjs');
  const roots = [repo];
  const add = fn => { try { roots.push(fn() || null); } catch { roots.push(null); } };
  add(() => repoPaths.mainRoot(repo, {}));
  add(() => repoPaths.runtimeDir(env, repo));
  if (deps.runtimeDir) add(() => path.resolve(deps.runtimeDir));
  add(() => require('./lib/work-root.cjs').resolveWorkRoot(repo, env, fs).dir);
  return roots;
}
// The wrapper's decision for this launch, when it names exactly this client and model; anything else is no decision.
function inheritedDecision(route, env) {
  let got;
  try { got = JSON.parse(envText(env, ROUTE_DECISION_ENV) || 'null'); } catch { return null; }
  if (!got || typeof got !== 'object' || got.client !== route.client || got.model !== route.model) return null;
  return got;
}
function routeDecision(route, deps, env, label) {
  const gd = deps.routeGate || {};
  const moduleFile = gd.module || ROUTE_GATE_MODULE;
  // deps.routeGate (the tests) names its own module and record; then nothing is taken from the environment
  const named = gd.module || gd.recordFile ? null : envText(env, ROUTE_STATE_FILE_ENV);
  const fromEnv = named ? path.resolve(named.trim()) : null;
  const recordFile = gd.recordFile ? path.resolve(gd.recordFile) : fromEnv || ROUTE_STATE_FILE;
  if (!fromEnv && !fs.existsSync(moduleFile) && !fs.existsSync(recordFile)) return { admit: true, line: null, code: null };
  // The line shows the pair in visible ASCII, and a pair with any other character is refused, never a transition
  const shown = v => String(v).replace(/[^\x21-\x7e]/g, '?').slice(0, 128);
  const head = `${label} route=${shown(route.client)}:${shown(route.model)}`;
  const bad = IDENTITY_KEYS.find(key => typeof route[key] === 'string' && !VISIBLE.test(route[key]));
  if (bad) return { admit: false, code: 'ROUTE_ARGS_REFUSED', line: `${head} decision=refused reason=ROUTE_ARGS_REFUSED gateRoute=none detail=invalid-option-value option=--${bad}` };
  let result;
  try {
    const gate = require(moduleFile);
    const input = { client: route.client, model: route.model, now: gd.now || new Date().toISOString(), liveProbe: false };
    const wrapper = inheritedDecision(route, env);
    if (wrapper && typeof wrapper.override === 'string' && !gate.overrideProblem(wrapper.override)) input.override = wrapper.override;
    if (wrapper && wrapper.probe && typeof wrapper.route === 'string') input.priorProbe = { route: wrapper.route, ok: wrapper.probe.ok, at: wrapper.probe.at };
    // liveProbe false asks for no probe, and the probe dependency resolves no command, so no probe client can start from here.
    // (PROTO-DEC-0240 item 3): the record is read only inside the one probe root of the gate
    // (gate.inProbeRoot), the root the wrapper uses: the helper the strict reader compiles once per process lands there, never in the
    // OS temp of this launch or under a launch root of it.
    const scoped = gate.inProbeRoot({ env, root: gd.probeRoot, launchRoots: launchRootsOf(deps, env) }, () => gate.checkRoute(input, { recordFile, env, probe: { resolveCommand: () => null } }));
    result = scoped.problem ? { allowed: false, route: null, refusal: { code: 'ROUTE_PROBE_ROOT', detail: String(scoped.problem).replace(/[^\x20-\x7e]/g, '?').slice(0, 300) } } : scoped.value;
  } catch (e) {
    result = { allowed: false, route: null, refusal: { code: 'ROUTE_GATE_ERROR', detail: String((e && e.code) || 'error').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'error' } };
  }
  if (!result.allowed) return { admit: false, code: result.refusal.code, line: `${head} decision=refused reason=${result.refusal.code} gateRoute=${result.route || 'none'} detail=${result.refusal.detail}` };
  const g = result.record;
  if (g.decision === 'transition') return { admit: true, code: null, line: `${head} decision=transition gateRoute=none ${g.missing}; no row of the route record has this client and model` };
  const overridePart = g.override ? ` override="${g.override.act}" overrideApplied=${g.override.applied}${g.override.overridden.length ? ` overridden=${g.override.overridden.join(';')}` : ''}` : '';
  return { admit: true, code: null, line: `${head} decision=allowed gateRoute=${g.route} basis=${g.basis} state=${g.state}${overridePart}` };
}

// THE spawn point of a seat client (PROTO-DEC-0240 item 1; the closed construction of
// PROTO-DEC-0216). cert-launch, fix-launch (every attempt the recovery below makes: the first launch, a TRANSIENT
// retry, a switch to a fallback route) and the seat runner of the operator tools start a client process ONLY through
// this function; a source scan in the route-step tests finds any other spawn of a client command in the operations
// and tool directories. Immediately before the spawn the client and model the caller built the invocation from are decided by
// routeDecision; the decision is recorded (said, and appended to the call file when the caller has one) for every
// spawn. A refused route starts nothing: the result is the one of a client that never started (status null, error
// code ROUTE_REFUSED, empty streams) and carries routeRefusal { code, line } for the caller's marker.
//   seat   { client, model, deps, env, say, io, callFile, snapshot } (snapshot: the kimi copy of the spawn result, kimi-route.cjs)
//   spawn  the spawn function of the caller (its deps.spawnSync or child_process.spawnSync), called only when admitted
// The first spawn of a launch takes the decision run made before anything of the launch existed (deps.routeDecided):
// once, and only for the client and model it was made for; every other spawn is decided here.
const SPAWN_LABEL = 'SEAT-SPAWN';
function decidedEarly(seat) {
  const handed = seat.deps && seat.deps.routeDecided;
  if (!handed || handed.spent || handed.client !== seat.client || handed.model !== seat.model) return null;
  handed.spent = true;
  return handed.decision;
}
function spawnClient(seat, invocation, spawn) {
  const decision = decidedEarly(seat) || routeDecision({ client: seat.client, model: seat.model }, seat.deps || {}, seat.env || process.env, SPAWN_LABEL);
  if (decision.line) {
    (seat.say || console.log)(decision.line);
    if (seat.callFile) (seat.io || fs).appendFileSync(seat.callFile, `${decision.line}\n`, 'utf8');
  }
  if (!decision.admit) {
    return { pid: 0, status: null, signal: null, output: [null, Buffer.alloc(0), Buffer.alloc(0)], stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
      error: Object.assign(new Error(`the route check refused the client (${decision.code}); it was not started`), { code: 'ROUTE_REFUSED' }), routeRefusal: { code: decision.code, line: decision.line } };
  }
  const result = spawn(invocation.command, invocation.args, invocation.spawnOptions);
  return seat.snapshot ? seat.snapshot(result) : result;
}
function switchDecision(route, deps, env) {
  const d = routeDecision(route, deps, env, 'SEAT-ROUTE');
  return { admit: d.admit, line: d.line && d.line.replace(' decision=refused ', ' decision=skipped ') };
}

function run(argv, deps, launchOnce, kind) {
  const say = deps.say || console.log; const error = deps.error || console.error;
  let routes;
  try { argv = normalize(argv); routes = plan(argv, kind, deps); } catch (e) {
    const named = /^(?:unsupported-invocation client=|missing-option-value option=|duplicate-option option=|unexpected-option-value option=|unknown-option$|fix-first-route option=|invalid-option-value option=)/.test(e.message);
    error(`SEAT-FAILOVER REFUSED reason=${named ? e.message : 'invalid-route-or-family'}; nothing was started`); return 2;
  }
  const env = deps.env || process.env;
  const name = value(argv, 'name');
  // PROTO-DEC-0240 item 1: the route of the first spawn, the intended client and model plan read once
  // (the default pair of a fix launch included), is decided HERE, before the first effect of the launch (git, the call file, the
  // heartbeat, the work root and its launch directory, the packet, the shadow, the records): a refused route leaves nothing behind
  // and is named on stdout only. An admitted decision is handed to the spawn point for the first spawn (routeDecided), which does not
  // decide it again; a TRANSIENT retry and a switch are decided at the spawn point.
  const first = routeDecision(routes[0], deps, env, SPAWN_LABEL);
  if (!first.admit) {
    say(first.line);
    say(`${/^[A-Za-z0-9._-]{1,64}$/.test(name || '') ? name.toUpperCase() : 'SEAT'}_ROUTE_REFUSED exit=3 reason=${first.code}; the client was not started`);
    return 3;
  }
  const routeDecided = { client: routes[0].client, model: routes[0].model, decision: first };
  const io = deps.fs || fs;
  const runtime = deps.runtimeDir || require('../../.ai/bin/repo-paths.cjs').runtimeDir();
  const runId = `R-seat-${randomBytes(12).toString('hex')}`;
  let number = 0; let recovered = false;
  for (let index = 0; index < routes.length; index++) {
    const route = routes[index];
    let retried = false;
    for (;;) {
      number++;
      let result = null; let launchRecordFailed = false; let diagnosticEnv = {};
      const lines = []; const errors = []; const appends = [];
      const attemptIO = Object.create(io);
      // Publish only the terminal attempt's legacy marker. Failed attempts get
      // structured safe diagnostics instead of an intermediate *_DONE marker.
      // The route decision of every spawn (spawnClient) is published at once, for every attempt, never buffered with the attempt.
      const spawnLine = text => typeof text === 'string' && text.startsWith(`${SPAWN_LABEL} `);
      attemptIO.appendFileSync = (file, ...args) => {
        if (path.basename(file) === `${name}-call.txt` && !spawnLine(args[0])) appends.push([file, ...args]);
        else io.appendFileSync(file, ...args);
      };
      const attemptDeps = { ...deps, fs: attemptIO, say: line => (spawnLine(line) ? say(line) : lines.push(line)), error: line => errors.push(line),
        routeDecided: number === 1 ? routeDecided : undefined,
        spawnSync: (cmd, args, opts) => {
          const got = (deps.spawnSync || childProcess.spawnSync)(cmd, args, opts);
          if (cmd !== 'git') {
            result = got;
            const formatIndex = args.indexOf('--output-format');
            const format = formatIndex >= 0 ? args[formatIndex + 1] : 'text';
            diagnosticEnv = { AGY_OUTPUT_FORMAT: format, CLAUDE_OUTPUT_FORMAT: format };
          }
          return got;
        },
        launchRecord: { writeLaunchRecord: attemptFields => {
          const cls = classify(route.client, result || {}, diagnosticEnv);
          const fields = { ...attemptFields, attempt: number, attemptClass: cls,
            ...(number > 1 ? { name: `${name}-attempt-${number}` } : {}),
            ...(kind === 'fix' ? { role: 'fixer', stage: 'execute' } : {}),
            ...(cls !== 'SUCCESS' ? { failureClass: cls === 'TRANSIENT' ? 'TRANSPORT' : cls === 'OTHER' ? attemptFields.failureClass || 'UNKNOWN' : cls } : {}),
          };
          try { return (deps.launchRecord || records).writeLaunchRecord(fields); }
          catch (e) { launchRecordFailed = true; throw e; }
        } },
      };
      let args = argv; let launch = launchOnce;
      if (index > 0) {
        args = replace(replace(argv, 'client', route.client), 'model', route.model);
        launch = kind === 'fix' ? require('./fix-launch.cjs').launchOnce : require('./cert-launch.cjs').launchOnce;
        attemptDeps.seatRole = kind === 'fix' ? 'fixer' : 'certifier';
        attemptDeps.seatFallback = true;
      }
      const code = launch(args, attemptDeps);
      if (!result) { for (const a of appends) io.appendFileSync(...a); for (const l of lines) say(l); for (const l of errors) error(l); return code; }
      const cls = classify(route.client, result, diagnosticEnv);
      const retry = cls === 'TRANSIENT' && !retried;
      // A switch goes to the first later route that passes the route check; the check runs before that child starts.
      const switching = (cls === 'AUTH' || cls === 'QUOTA') && index + 1 < routes.length && !launchRecordFailed;
      const routeLines = [];
      let target = -1;
      if (switching) {
        for (let j = index + 1; j < routes.length; j++) {
          const decision = switchDecision(routes[j], deps, env);
          if (decision.line) routeLines.push(decision.line);
          if (decision.admit) { target = j; break; }
        }
      }
      const advance = target > index;
      const noTarget = switching && !advance;
      const next = retry ? route : advance ? routes[target] : null;
      const summary = `SEAT-ATTEMPT attempt=${number} class=${cls} route=${route.client}:${route.model}`;
      let recordFailure = false;
      try {
        const reason = { AUTH: 'AUTH_ERROR', QUOTA: 'QUOTA_EXHAUSTED', TRANSIENT: 'NETWORK_ERROR', OTHER: 'PROCESS_CRASH', SUCCESS: 'SUCCESS' }[cls];
        const tool = deps.failover || failover;
        const stored = tool.appendEvent(value(argv, 'worktree'), { runId, slot: name, attempt: number, route: { ...route, role: index ? `substitute-${index}` : 'primary' }, reasonClass: reason,
          nextRoute: next, nextRouteSource: next ? 'operator-fallback' : 'none-remaining' }, { failoverFile: env.PROTOCOL_FAILOVER_FILE === undefined ? path.join(runtime, 'seat-failover.jsonl') : env.PROTOCOL_FAILOVER_FILE }, env);
        if (stored.skipped) throw new Error('journal disabled');
      } catch { error('SEAT-FAILOVER JOURNAL-WRITE-FAILED; recovery stopped'); recordFailure = true; }
      for (const l of errors) error(l); // one argument each: console.log as say would print the index and the array too
      if (cls !== 'SUCCESS' && cls !== 'OTHER') { say(summary); io.appendFileSync(path.join(runtime, `${name}-call.txt`), `${summary}\n`, 'utf8'); }
      for (const line of routeLines) { say(line); io.appendFileSync(path.join(runtime, `${name}-call.txt`), `${line}\n`, 'utf8'); }
      if (!recordFailure && !launchRecordFailed && (retry || advance)) {
        recovered = true;
        if (retry) { retried = true; (deps.wait || (ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)))(250); continue; }
        index = target - 1;
        break;
      }
      if (recordFailure) {
        // Buffered marker and call body have not been published. A journal
        // failure must never expose a contradictory DONE on either channel.
        const failed = `${name.toUpperCase()}_FAILED exit=3 class=JOURNAL_WRITE_FAILED`;
        say(failed); io.appendFileSync(path.join(runtime, `${name}-call.txt`), `${failed}\n`, 'utf8');
        return 3;
      }
      if (cls === 'AUTH' || cls === 'QUOTA') say(`SEAT-STOP class=${cls} recovery=${cls === 'AUTH' ? 'reauthenticate' : 'wait-for-quota-reset'}-or-supply-an-allowed---fallback`);
      for (const a of appends) {
        if (recovered) a[1] = a[1].replace(/(\n[^\n]+ exit=[^\n]+ end=[^\n]+)\n$/, `$1 route=${route.client}:${route.model}\n`);
        io.appendFileSync(...a);
      }
      for (const line of lines) say(recovered && /^[A-Z0-9_.-]+ exit=/.test(line) ? `${line} route=${route.client}:${route.model}` : line);
      if (noTarget) {
        const refusal = `SEAT-FAILOVER REFUSED reason=ROUTE_NO_ADMISSIBLE_TARGET skipped=${routes.length - index - 1}; no later route passed the route check, so no substitute child was started`;
        error(refusal); io.appendFileSync(path.join(runtime, `${name}-call.txt`), `${refusal}\n`, 'utf8');
        return 3;
      }
      return recordFailure ? 3 : code;
    }
  }
  return 3;
}
module.exports = { classify, plan, run, excludedFamilies, identity, intendedPair, normalize, FIX_FIRST, spawnClient, routeDecision, ROUTE_DECISION_ENV };

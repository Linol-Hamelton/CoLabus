'use strict';
// probe.cjs - the ONE table of client to probe argv and the reduction of a probe answer to a named
// reason (guarantee K5).
//
// One bounded cheap call per client type: a one-word answer, a fixed timeout (150 s), no repository
// write (a fresh directory under a temp root outside the repository), and no secret printed. The raw
// output never leaves this module: runProbe returns { ok, reason, at } and nothing else, so the record
// and every printed line can only carry the closed reason name.
//
// COMMANDS is data and it is the whole table: one entry per client, each a FIXED argv array whose
// elements are separate strings (file and arguments are never joined into a command line). The model
// of the route is substituted as ONE element in the slot below. The child is started WITHOUT a shell
// (spawn with an argument array, windowsVerbatimArguments false), and every value that reaches argv
// first passes the closed model grammar; a value outside it makes the probe FAILED with the reason
// invalid-model-name before anything is created or started. A client absent from the table (including
// an inherited object member such as "constructor") has no probe and its row stays unknown.
//
// F02: the probe directory is created exclusively (a fresh random name under a temp root that is
// outside the repository, on drive D, judged on its real path). ANY failure to create it is the probe
// result FAILED with the reason temp-unavailable: there is no fallback to another directory and no
// undefined cwd. The spawn always receives that directory as cwd.
//
// PROBE-SERVED-MODEL (2026-10-29): a probe also records WHICH model answered (`served`) and where that is proven from (`servedSource`), never from the
// words of the model (a free route once answered with a fabricated SHA and called itself another model). The proof sources are the ones the client writes
// itself at a fixed place: the codex header block of stderr (docs/ops/served-model.cjs deriveForLaunch, unchanged), and the
// kilo banner line of stderr (measured 2026-10-29; proveKilo below). Every other client has no structured source in the probe invocation: served null,
// servedSource none, and the route reads unproven (route-state SERVED_UNPROVEN). A proven served model that is not the requested one fails the probe
// (SERVED_MISMATCH, SERVED_FAMILY_MISMATCH).
//
// A scarce subscription route (claude, codex weekly) is NOT probed by default: the scarce-route question
// is open, and a probe must not burn the limit it measures. refresh.cjs enforces that; this module
// only names the scarce clients.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const clineRoute = require('../../.ai/bin/lib/cline-route.cjs');
const textSafe = require('../../.ai/bin/lib/text-safe.cjs');
const servedModelTool = require('../../docs/ops/served-model.cjs');

const QUESTION = 'reply with the single word OK';
const TIMEOUT_MS = 150000;
const MAX_BUFFER = 8 * 1024 * 1024;
// The shared probe temp is a resolved value: the environment input OK_PROBE_TEMP when it
// is set and not blank, else the operator default: the Probe sibling of the main checkout. refresh.cjs --temp-dir still
// overrides both per run. Whatever the source, makeProbeDir judges the root by tempRootProblem.
// PROTO-DEC-0240 item 3: the probe works in its own root, outside the work root of the launches
// (the temp root of the launch wrapper) and outside .ai/runtime; the launch gate refuses a probe root inside a launch root.
const PROBE_TEMP_ENV = 'OK_PROBE_TEMP';
const DEFAULT_PROBE_TEMP = `${require('../../.ai/bin/repo-paths.cjs').mainRoot().split(path.sep).join('/')}Probe`;
function resolveProbeTemp(env = process.env) {
  const value = env && typeof env[PROBE_TEMP_ENV] === 'string' ? env[PROBE_TEMP_ENV].trim() : '';
  return value || DEFAULT_PROBE_TEMP;
}
const PROBE_TEMP = resolveProbeTemp();
const SCARCE_CLIENTS = Object.freeze(['claude', 'codex']);
const PROBE_REASONS = Object.freeze([
  'TIMEOUT',
  'SPAWN_FAILED',
  'EXIT_NONZERO',
  'NO_ANSWER',
  'AUTH_FAILED',
  'QUOTA_EXCEEDED',
  'PAYMENT_OVERDUE',
  'NO_CREDITS',
  'RATE_LIMITED',
  'PROVIDER_UNAVAILABLE',
  'invalid-model-name',
  'temp-unavailable',
  'SERVED_MISMATCH',
  'SERVED_FAMILY_MISMATCH',
]);
const SERVED_SOURCES = Object.freeze(['client-banner', 'launcher-model', 'agent-result', 'client-log', 'none']);

// The model slot is the one element the route supplies. It is not a client name, a path or a flag: the
// closed grammar below is the only thing that may reach it (letters, digits and . _ : / -; 160 max).
const MODEL_SLOT = '\u0000model\u0000';
const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;

const isWindows = process.platform === 'win32';
const REPO_REAL = (() => {
  try { return fs.realpathSync.native(path.join(__dirname, '..', '..')); } catch { return null; }
})();

// client -> { file, args }. One entry per client type; the model is the route's own spelling, passed as
// one element where the client has a model flag. vibe has NO model flag: its seat is active_model in
// ~/.vibe/config.toml and --agent names an agent, not a model, so the route's model is not selectable
// per call there. Nothing is a shell.
const COMMANDS = Object.freeze(Object.assign(Object.create(null), {
  kilo: { file: 'kilo', args: ['run', '-m', MODEL_SLOT, QUESTION] },
  // kimi: the same machine-readable stream the seats use (cert-launch kimi argv); the text form pinned one
  // client version and broke on every self-update (2.3.3 on 2026-10-27 prints a thinking line first).
  kimi: { file: 'kimi', args: ['-m', MODEL_SLOT, '-p', QUESTION, '--output-format', 'stream-json'] },
  vibe: { file: 'vibe', args: ['-p', QUESTION, '--max-turns', '2'] },
  codex: { file: 'codex', args: ['exec', '-m', MODEL_SLOT, '--skip-git-repo-check', QUESTION] },
  mimo: { file: 'mimo', args: ['run', '-m', MODEL_SLOT, QUESTION] },
  claude: { file: 'claude', args: ['-p', QUESTION, '--model', MODEL_SLOT] },
  // cline (measured 2026-10-30, cline 3.0.74): the argv is built by cline-route.cjs probeArgs (the provider comes from the closed model table, stdin is closed, --json prints the run_result)
  cline: { file: 'cline', args: [] },
}));

// -> null when the model may reach argv, else the reason text. The reader and every writer use this one
// grammar; a route whose model fails it is never started.
function modelProblem(model) {
  if (typeof model !== 'string' || !MODEL_RE.test(model)) {
    return 'the model must be 1 to 160 characters of A-Z a-z 0-9 . _ : / - and start with a letter or digit';
  }
  return null;
}

// -> { file, args } with the model as one element, or null when the client is unknown (own-key only,
// never an inherited member) or the model is outside the grammar. A caller that gets null starts nothing.
function probeCommand(route) {
  if (!route || typeof route.client !== 'string' || !Object.hasOwn(COMMANDS, route.client)) return null;
  if (modelProblem(route.model)) return null;
  if (route.client === 'cline') { const args = clineRoute.probeArgs({ model: route.model, question: QUESTION }); return args ? { file: 'cline', args } : null; }
  const entry = COMMANDS[route.client];
  return { file: entry.file, args: entry.args.map(arg => (arg === MODEL_SLOT ? route.model : arg)) };
}

function isScarce(client) {
  return SCARCE_CLIENTS.includes(client);
}

function stripAnsi(text) {
  return String(text || '').replace(/\x1b\[[0-9;]*m/g, '');
}

// The closed list of known no-answer markers. A client that prints one of these
// lines has no answer, wherever the line appears in stdout. Matched on the trimmed, lowercased line.
const NO_ANSWER_LINES = Object.freeze([
  'no answer returned', 'no answer', 'no answer provided', 'no answer was returned',
  'no response', 'no response returned', 'no output', 'no result', 'no reply',
  'empty response', 'empty output', 'nothing returned', 'unable to answer', 'cannot answer',
]);

// Measured 2026-10-26: only Kimi 2.3.2 has an accepted decorated form. Every pattern matches a whole
// line, in the order header, optional preamble, answer, optional footer. The masked session id is
// the fixture spelling; live ids use session_UUID, as in the recorded Kimi Code stream-json sample.
// Unknown clients/versions get plain OK only.
const ANSWER_DECORATIONS = Object.freeze({
  kimi: Object.freeze({
    versionFamily: '2.3.2',
    header: /^kimi version 2\.3\.2$/,
    preamble: /^\u2022 The user wants just "OK"\.$/,
    answer: /^\u2022 OK$/,
    footer: /^To resume this session: kimi -r (?:session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\(session id\))$/,
  }),
});

// Kimi stream-json (measured 2026-10-28, kimi 2.3.3): one JSON object per line. The closed grammar is
// a version meta line of any 2.x, exactly one assistant entry whose content is the string OK, and an
// optional resume hint; any other line, role, type, content or a parse error is no answer.
const KIMI_VERSION_RE = /^2\.\d{1,3}\.\d{1,3}$/;
function kimiStreamProblem(lines) {
  let answers = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { return 'no-answer'; }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return 'no-answer';
    if (entry.role === 'assistant') {
      if (typeof entry.content !== 'string' || entry.content.trim() !== 'OK' || Object.keys(entry).some(k => !['role', 'content'].includes(k))) return 'no-answer';
      answers += 1;
    } else if (entry.role === 'meta' && entry.type === 'system.version') {
      if (typeof entry.version !== 'string' || !KIMI_VERSION_RE.test(entry.version)) return 'no-answer';
    } else if (entry.role === 'meta' && entry.type === 'session.resume_hint') {
      if (typeof entry.session_id !== 'string' || !/^session_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(entry.session_id)) return 'no-answer';
    } else {
      return 'no-answer';
    }
  }
  return answers === 1 ? null : 'no-answer';
}

// Only stdout can answer. Every non-empty line must belong to the selected closed grammar; a
// question echo, unknown thinking text, duplicate answer or dump cannot precede an otherwise valid OK.
function answerProblem(stdoutPlain, client) {
  // cline prints JSON events: its answer is the run_result (cline-route.cjs probeVerdict), never a bare line
  if (client === 'cline') return 'no-answer';
  const lines = stdoutPlain.split(/\r?\n/);
  if (client === 'kimi' && (lines.find(l => l.trim()) || '').trim().startsWith('{')) return kimiStreamProblem(lines);
  let okIndex = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line && NO_ANSWER_LINES.includes(line.toLowerCase())) return 'no-answer';
    if (okIndex < 0 && line === 'OK') okIndex = i;
  }
  const form = Object.hasOwn(ANSWER_DECORATIONS, client) ? ANSWER_DECORATIONS[client] : null;
  const content = lines.map(line => line.trim()).filter(Boolean);
  if (form && form.header.test(content[0] || '')) {
    let i = 1;
    if (form.preamble.test(content[i] || '')) i += 1;
    if (content[i] !== 'OK' && !form.answer.test(content[i] || '')) return 'no-answer';
    i += 1;
    if (form.footer.test(content[i] || '')) i += 1;
    return i === content.length ? null : 'no-answer';
  }
  if (okIndex < 0) return 'no-answer';
  for (let i = 0; i < okIndex; i += 1) {
    if (lines[i].trim() !== '') return 'no-answer';
  }
  for (let i = okIndex + 1; i < lines.length; i += 1) {
    if (lines[i].trim() !== '') return 'no-answer';
  }
  return null;
}

// The closed reduction: the first matching class wins, in a fixed order. Detail never escapes; the
// caller stores only the returned name.
function reduceOutput(result, timedOut = false, client) {
  const r = result || {};
  if (timedOut || (r.error && (r.error.code === 'ETIMEDOUT' || r.error.code === 'ABORT_ERR'))) return { ok: false, reason: 'TIMEOUT' };
  if (r.error) return { ok: false, reason: 'SPAWN_FAILED' };
  const stdout = stripAnsi(`${r.stdout || ''}`);
  const stderr = stripAnsi(`${r.stderr || ''}`);
  // The success decision comes from the status and the stdout ONLY, as the answer grammar above
  // defines it: a diagnostic stderr that mentions 401, 429, a quota or a balance
  // never fails a probe that exited 0 with a standalone OK. stderr may only NAME the reason of a probe
  // that has already failed.
  // cline prints JSON events: its answer is the run_result, read by cline-route.cjs (a refused provider is named from its own error text)
  const verdict = client === 'cline' ? clineRoute.probeVerdict(stdout) : null;
  if (verdict) {
    if (verdict.ok && r.status === 0) return { ok: true, reason: null };
    if (verdict.reason === 'PROVIDER_UNAVAILABLE' || (verdict.reason === 'NO_ANSWER' && r.status === 0)) return { ok: false, reason: verdict.reason };
  }
  if (r.status === 0 && !answerProblem(stdout, client)) return { ok: true, reason: null };
  // cline: only the answer text of the run_result is scanned for a failure class, never the event envelopes
  const scanned = verdict ? ((clineRoute.parseRun(stdout).run || {}).text || '') : stdout;
  const lower = `${scanned}\n${stderr}`.toLowerCase();
  if (/overdue|past due|payment required/.test(lower)) return { ok: false, reason: 'PAYMENT_OVERDUE' };
  if (/add credits|no credits|credit balance|insufficient balance|insufficient_quota/.test(lower)) return { ok: false, reason: 'NO_CREDITS' };
  if (client === 'mimo' && /^Error: Insufficient account balance$/m.test(stdout)) return { ok: false, reason: 'NO_CREDITS' };
  if (client === 'mimo' && /^Error: Missing API token$/m.test(stdout)) return { ok: false, reason: 'AUTH_FAILED' };
  if (/\b401\b|unauthorized|invalid api key|not logged in|access denied|authentication failed/.test(lower)) return { ok: false, reason: 'AUTH_FAILED' };
  if (/\b429\b|rate limit|too many requests/.test(lower)) return { ok: false, reason: 'RATE_LIMITED' };
  if (/quota|weekly limit|usage limit/.test(lower)) return { ok: false, reason: 'QUOTA_EXCEEDED' };
  if (r.status !== 0) return { ok: false, reason: 'EXIT_NONZERO' };
  return { ok: false, reason: 'NO_ANSWER' };
}

// ---------- the executable (no shell, ever) ----------

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function pathDirs() {
  return String(process.env.PATH || '')
    .split(path.delimiter)
    .map(dir => dir.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean);
}

// The npm .cmd shim is not a PE file: Windows cannot start it without a command interpreter. Instead of
// handing data to cmd.exe, the shim's own single script target is read (an installer artifact, never the
// record) and run with this Node binary. Exactly one "%dp0%\<target>" "%*" line must name an existing
// file inside the shim's own directory; anything else leaves the client unresolvable (SPAWN_FAILED).
function npmShimScript(shim) {
  let text;
  try { text = fs.readFileSync(shim, 'utf8'); } catch { return null; }
  const matches = [...text.matchAll(/"%dp0%\\([^"\r\n]+)"\s+%\*/g)];
  if (matches.length !== 1) return null;
  const dir = path.dirname(path.resolve(shim));
  let candidate;
  try { candidate = fs.realpathSync.native(path.resolve(dir, matches[0][1])); } catch { return null; }
  let realDir;
  try { realDir = fs.realpathSync.native(dir); } catch { return null; }
  if (!isFile(candidate)) return null;
  if (candidate !== realDir && !candidate.startsWith(`${realDir}${path.sep}`)) return null;
  return candidate;
}

// -> { file, prefix } or null. On Windows a .exe is preferred; a .cmd shim is reduced to node + script;
// nothing else is started. On other platforms the name itself is the executable.
function resolveCommand(name) {
  if (!isWindows) return { file: name, prefix: [] };
  for (const dir of pathDirs()) {
    const exe = path.join(dir, `${name}.exe`);
    if (isFile(exe)) return { file: exe, prefix: [] };
  }
  for (const dir of pathDirs()) {
    const shim = path.join(dir, `${name}.cmd`);
    if (!isFile(shim)) continue;
    const script = npmShimScript(shim);
    if (script) return { file: process.execPath, prefix: [script] };
  }
  return null;
}

// ---------- the probe directory (exclusive, outside the repository, on drive D) ----------

function realOf(absolute) {
  let probe = path.resolve(absolute);
  const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(probe), ...rest.reverse()); } catch { /* not there yet */ }
    const up = path.dirname(probe);
    if (up === probe) return path.resolve(absolute);
    rest.push(path.basename(probe));
    probe = up;
  }
}

const lower = value => value.replace(/\\/g, '/').toLowerCase();
const inside = (parent, child) => {
  const p = lower(parent);
  const c = lower(child);
  return c === p || c.startsWith(`${p}/`);
};

// -> null when the temp root may be used, else a named cause. The root may not be a drive root, may not
// be inside the repository and, on Windows, must be on drive D. All three are judged on the real path:
// the spelling is resolved first, so a D-spelled path whose real target is a drive root or on C is
// refused, never used.
function tempRootProblem(root) {
  if (typeof root !== 'string' || !root.trim() || root.includes('\0')) return 'the temp root is empty or malformed';
  if (!path.isAbsolute(root)) return 'the temp root is not an absolute path';
  const resolved = path.resolve(root);
  const real = realOf(resolved);
  if (path.parse(real).root === real) return 'the temp root is a drive root';
  if (isWindows && !/^[Dd]:[\\/]/.test(real)) return 'the temp root is not on drive D';
  if (REPO_REAL && inside(REPO_REAL, real)) return 'the temp root is inside the repository';
  return null;
}

function randomName() {
  return `ok-probe-${process.pid}-${crypto.randomBytes(8).toString('hex')}`;
}

// -> the real path of a freshly created directory, or null. Any failure is null: never another
// directory, never an undefined cwd.
function makeProbeDir(root, deps = {}) {
  if (tempRootProblem(root)) return null;
  const mkdir = deps.mkdirSync || fs.mkdirSync;
  const createName = deps.randomName || randomName;
  try { mkdir(root, { recursive: true }); } catch { return null; }
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const dir = path.join(root, createName());
    try {
      mkdir(dir, { recursive: false });
      const real = fs.realpathSync.native(dir);
      if (!inside(realOf(root), real)) return null;
      return real;
    } catch (e) {
      if (e && e.code === 'EEXIST') continue;
      return null;
    }
  }
  return null;
}

// ---------- the served model of a probe (PROBE-SERVED-MODEL) ----------

const UNPROVEN = reason => ({ served: null, source: 'none', match: 'unknown', family: 'unknown', mismatchClass: null, reason });

// kilo prints the model the client resolved on STDERR as its own line "> <agent> · <model>", between lines that hold colour sequences only (measured
// 2026-10-29 on the free Nemotron route; with --format json the client prints no model). The model cannot write to stderr. Closed rules: only the SGR
// colour sequences of the client are removed, before the strict decode of the whole bytes (every other control or invisible character, a BOM, NUL and a
// damaged byte refuse the stream); the FIRST non-blank line must be the banner; any other banner-shaped line must name the same model; the id passes the
// closed model grammar, is no placeholder and is listed in .ai/docs/clients.json for kilo (as printed, or with the client prefix kilo/ the registry uses) or is the model of the route itself.
const KILO_BANNER = /^> ([a-z][a-z0-9-]{0,31}) \u00b7 (\S+)$/;
const SERVED_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:+/@#~-]{0,119}$/;
function proveKilo(model, stderr) {
  if (!Buffer.isBuffer(stderr) && !(stderr instanceof Uint8Array)) return UNPROVEN('stderr is not bytes');
  const bare = Buffer.from(Buffer.from(stderr).toString('latin1').replace(/\x1b\[[0-9;]*m/g, ''), 'latin1');
  const decoded = textSafe.decode(bare, { bom: 'refuse', crlf: 'normalise', invisible: 'refuse' });
  if (!decoded.ok) return UNPROVEN('unreadable client stream');
  const lines = decoded.text.split('\n');
  const first = lines.find(line => !/^[\t ]*$/.test(line));
  const head = first === undefined ? null : KILO_BANNER.exec(first);
  if (!head) return UNPROVEN('no banner');
  const ids = lines.map(line => KILO_BANNER.exec(line)).filter(Boolean).map(m => m[2]);
  if (ids.some(id => id !== head[2])) return UNPROVEN('conflicting banners');
  const id = head[2];
  if (!SERVED_ID_RE.test(id) || /^(?:unknown|none|null|-)$/i.test(id)) return UNPROVEN('no model id');
  // the allow-list: a model the registry lists for kilo (as printed, or with the client prefix kilo/), or the very model the route names (the owner-declared row
  // of the record; the registry is a pinned source of the model ladder and is not widened for one route)
  const listed = servedModelTool.allowedModel('kilo', id) || servedModelTool.allowedModel('kilo', `kilo/${id}`);
  if (!listed && servedModelTool.modelsMatch(model, id) !== true) return UNPROVEN('model not in allow-list');
  const match = servedModelTool.modelsMatch(model, id);
  const family = servedModelTool.familyMatch(model, id);
  return { served: id, source: 'client-banner', match, family, mismatchClass: servedModelTool.mismatchClassOf(match, family), reason: null };
}

// -> { served, source, match, family, mismatchClass, reason }: served is the proven model id or null (then source is none and reason says why)
function proveServed(input) {
  const { client, model, args, stdout, stderr } = input;
  if (client === 'kilo') return proveKilo(model, stderr);
  if (client === 'codex') {
    const r = servedModelTool.deriveForLaunch({ client, model, args, stdout, stderr });
    if (!r.servedModel || r.confidence === 'none') return UNPROVEN(r.reason || 'no evidence');
    return { served: r.servedModel, source: r.source, match: r.match, family: r.familyMatch, mismatchClass: r.mismatchClass, reason: null };
  }
  return UNPROVEN('no structured source');
}

// One probe. `deps.spawnSync`, `deps.resolveCommand`, `deps.mkdirSync`, `deps.randomName` and
// `deps.nowMs` exist for the tests only; production uses the real child process, the real PATH and the
// real clock. The returned object is exactly what the record may store.
function runProbe(route, deps = {}) {
  const nowMs = deps.nowMs === undefined ? Date.now() : deps.nowMs;
  const at = new Date(nowMs).toISOString();
  if (!route || typeof route.client !== 'string' || !Object.hasOwn(COMMANDS, route.client)) {
    return { skipped: 'NO_PROBE_COMMAND' };
  }
  if (modelProblem(route.model)) return { ok: false, reason: 'invalid-model-name', at };
  const command = probeCommand(route);
  // a Cline model outside the closed table has no provider to ask: no start
  if (!command) return { ok: false, reason: 'invalid-model-name', at };
  const resolve = deps.resolveCommand || resolveCommand;
  const resolved = resolve(command.file);
  if (!resolved) return { ok: false, reason: 'SPAWN_FAILED', at };
  const cwd = makeProbeDir(deps.probeTemp || PROBE_TEMP, deps);
  if (!cwd) return { ok: false, reason: 'temp-unavailable', at };
  const spawn = deps.spawnSync || spawnSync;
  const result = spawn(resolved.file, [...resolved.prefix, ...command.args], {
    cwd,
    encoding: 'buffer',
    timeout: TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
    shell: false,
    // Cline waits for input unless stdin is closed (measured 2026-10-30)
    ...(route.client === 'cline' ? { stdio: clineRoute.STDIO } : {}),
    windowsVerbatimArguments: false,
    env: { ...process.env, TEMP: cwd, TMP: cwd },
  });
  const timedOut = Boolean(result && result.error && result.error.code === 'ETIMEDOUT');
  const reduced = reduceOutput(result, timedOut, route.client);
  // The proof of the served model is read from the client's own bytes; a failed derivation is an unproven one, never a throw.
  let proof;
  try { proof = proveServed({ client: route.client, model: route.model, args: command.args, stdout: result && result.stdout, stderr: result && result.stderr }); } catch { proof = UNPROVEN('no structured source'); }
  const served = proof.served ? { served: proof.served, servedSource: proof.source } : { served: null, servedSource: 'none' };
  if (reduced.ok && proof.match === false) {
    return { ok: false, reason: proof.mismatchClass === 'SERVED_FAMILY_MISMATCH' ? 'SERVED_FAMILY_MISMATCH' : 'SERVED_MISMATCH', at, ...served };
  }
  return { ok: reduced.ok, reason: reduced.reason, at, ...served };
}

module.exports = {
  QUESTION,
  TIMEOUT_MS,
  PROBE_TEMP,
  PROBE_TEMP_ENV,
  DEFAULT_PROBE_TEMP,
  resolveProbeTemp,
  SCARCE_CLIENTS,
  PROBE_REASONS,
  COMMANDS,
  MODEL_RE,
  modelProblem,
  probeCommand,
  isScarce,
  reduceOutput,
  answerProblem,
  proveServed,
  proveKilo,
  SERVED_SOURCES,
  NO_ANSWER_LINES,
  ANSWER_DECORATIONS,
  resolveCommand,
  tempRootProblem,
  realOf,
  inside,
  makeProbeDir,
  runProbe,
};

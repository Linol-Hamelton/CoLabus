'use strict';
// qwen-client.cjs - Qwen Code CLI on the DashScope free quota as a launch client (PROTO-DEC-0211 and 0212).
// Used by cert-launch.cjs (client table and gate), served-model.cjs (served-model proof) and nothing else. Pure except preflight (reads the prompt file and the User
// environment) and the spawn-time guard (recheck, afterRun); never prints or records a key. It reads NO file the client wrote: no session log, no API log, no stream.
// Measured on Qwen Code 0.24.1:
//   command   qwen -m <model> --bare --auth-type openai --approval-mode yolo --output-format text --max-session-turns N -p <ascii line>
//             with the prompt file on STDIN (UTF-8, Cyrillic intact); -p text is appended to the stdin text. Headless yolo writes files and runs shell commands.
//   G1 route  the provider of the run is fixed by the launcher alone: --bare --auth-type openai, with OPENAI_BASE_URL and OPENAI_API_KEY in the CHILD ENVIRONMENT (the key
//             never reaches argv). Measured with local servers: with --bare the base URL of the environment wins over modelProviders, security.auth, proxy, env and model
//             entries of the user, system and workspace settings files and over a .env file; without --bare the workspace settings file beats the user one.
//             Every settings source the client has a redirect for is a launcher-owned file of a private directory made for the launch: QWEN_HOME (user settings and the client
//             state), QWEN_CODE_SYSTEM_SETTINGS_PATH and QWEN_CODE_SYSTEM_DEFAULTS_PATH (the system layer). The user's own settings are never read. The workspace file
//             <cwd>/.qwen/settings.json has no redirect and is NOT pinned or watched: it is only REFUSED when present, at preflight and again at recheck just before the start.
//             One that appears after recheck is not detected; it cannot change the route (measured: --bare and the child environment win). PINNED (read-only, by content and
//             identity, a change during the run even one restored before the child returns voids the launch) are only the launcher-owned files of the private directory.
//   G2 model  the served model is the explicit model the launcher passed with -m (a model of the closed list below, of the DashScope model-id grammar), source launcher-model,
//             and it counts only over the route of G1 (PROTO-DEC-0211 item 1).
//   G3 usage  nothing the client prints or stores is read for the model or for tokens: tokens are null with the reason "not counted for this client"; the cost basis is the
//             free quota when G1 held (PROTO-DEC-0211 items 2 and 3).
//   Env      the child environment is the launch work environment the kernel launchers hand every client (work-root.cjs kernelWorkEnv): TEMP, TMP, TMPDIR and the
//             toolchain caches live inside the per-launch work root, not in the inherited shared directories. This module adds only the key and the launcher-owned
//             settings paths to it (one childEnv function, used by the preflight and by buildInvocation); the private settings directory stays inside the launch root.
//   G4 key    the key is handed to the child in its environment only and never printed or written in any encoding. This is closed by construction, not by redaction:
//             the launcher stores NO text of the client output anywhere (call file, record, screen), only structured facts (the exit status, the byte count and the sha256
//             of each stream) and fixed reason codes, and it never reads the key into an output field. There is no key decoder to bypass (PROTO-DEC-0217).
//   Tools    the client, git (the HEAD read) and reg (the key read) are each resolved ONCE to an absolute path by the shared resolver (lib/client-path.cjs), never from the
//             current directory or a relative PATH entry, and refused when they lie inside the worktree or the launch runtime directory. A .cmd or .bat shim runs through the
//             absolute command interpreter under SystemRoot. On Windows a root, a PATH entry (every one, judged before any search, on the text as given) or a real path of
//             either or of the found client with a segment ending in a space or a dot is refused (path-spelling-refused). Every child of the launcher gets NoDefaultCurrentDirectoryInExePath=1.
//   Trust    the parent environment is trusted (PROTO-DEC-0217: inputs under the same OS user): inherited proxy and TLS variables (HTTPS_PROXY, NODE_OPTIONS, ...) are NOT
//             filtered; only the names that choose a provider or a key are removed (ROUTING_ENV).
const childProcess = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const pathSafe = require('../../.ai/bin/lib/path-safe.cjs');
const clientPath = require('./lib/client-path.cjs');

const DASHSCOPE = { baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', envKey: 'DASHSCOPE_API_KEY' };
// The closed list of free-quota model ids. Seats: strong -> qwen3.8-max, medium -> qwen3.8-flash.
const MODELS = ['qwen3.8-max', 'qwen3.8-flash', 'qwen3.8-2.4t-a95b'];
const SEAT_MODEL = { strong: 'qwen3.8-max', medium: 'qwen3.8-flash' };
// Environment names of the parent that can steer the client to another provider or key; they never reach the child (matched in any letter case: Windows names are). The
// names the launcher sets itself (OPENAI_API_KEY, OPENAI_BASE_URL, QWEN_HOME and the system settings paths) are overwritten after this filter.
const ROUTING_ENV = ['AI_GATEWAY_API_KEY', 'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'OPENAI_MODEL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'GEMINI_API_KEY', 'GOOGLE_API_KEY',
  'QWEN_CODE_SYSTEM_SETTINGS_PATH', 'QWEN_CODE_SYSTEM_DEFAULTS_PATH', 'QWEN_HOME'];
const DEFAULT_TURNS = 200;
const MAX_PROMPT_BYTES = 4 * 1024 * 1024;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const FREE_NOTE = 'free-quota: DashScope Model Studio free quota (no billing configured); no per-launch charge, usd is never a number';
// Closed grammars. A key outside KEY_GRAMMAR never starts a launch (a short or odd key could not be found again in the output); a model outside MODEL_GRAMMAR is not a
// DashScope model id; a path that goes into a command line or the environment is outside ARGV_PATH when it holds a character a command interpreter could expand.
const KEY_GRAMMAR = /^[A-Za-z0-9_.~+=-]{16,256}$/;
const MODEL_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,63}$/;
const LAUNCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const ARGV_PATH = /^[A-Za-z0-9 ._:/\\+@~,=-]*$/;
// the one reason of the record for the tokens of this client (PROTO-DEC-0211 item 2); the route of the proof says how the route was fixed
const NOT_COUNTED = 'not counted for this client';
const ROUTE_HOW = 'launcher-pinned-settings';
// the route proof also says the client was started from the resolved absolute path (the route object is made only after a clean run)
const CLIENT_RESOLVED = 'resolved-path';
const SETTINGS_SOURCES = ['user', 'system', 'defaults'];

// The closed set of reasons a client run that did not end cleanly is recorded with (PROTO-DEC-0211 item 1: no served model without a clean run).
const CLIENT_FAULTS = ['client-not-started', 'no-exit-status', 'client-failed'];

const refuse = reason => ({ ok: false, reason });
const lower = v => String(v === undefined || v === null ? '' : v).trim().toLowerCase();
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const isObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const keyPlausible = k => typeof k === 'string' && KEY_GRAMMAR.test(k) && k.replace(/[^A-Za-z0-9]/g, '').length >= 16;

// strong / medium (the seat words) or one of MODELS; anything else is refused. -> { ok, model } | { ok: false, reason }
function resolveModel(raw) {
  const v = String(raw === undefined || raw === null ? '' : raw).trim();
  if (Object.hasOwn(SEAT_MODEL, v)) return { ok: true, model: SEAT_MODEL[v], seat: v };
  if (MODELS.includes(v)) return { ok: true, model: v };
  // the refused value is caller text and is never repeated
  return refuse(`model is not one of the free-quota models (${MODELS.join(', ')}) or a seat word (strong, medium); gateway ids such as alibaba/... bill per token`);
}

// ---- launcher-owned settings files ----
// A settings file is read through the shared guarded reader (a link, junction, hardlink or a file swapped during the read is refused). The identity of the file
// (device, inode, size, modification and change time) is taken before and after the read and must agree; the pin of a file is its content hash plus that identity,
// so rewriting a file and restoring its bytes still changes the pin (the change time cannot be set back).
const identity = st => `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
const lstatOrNull = p => { try { return fs.lstatSync(p, { bigint: true }); } catch { return null; } };
// -> { state: 'missing' } | { state: 'file', bytes, sha, id } | { state: 'error', code }
function readSetting(root, rel) {
  const g = pathSafe.realInside(root, rel, { refuseHardlinks: true });
  if (!g.ok) return g.reason === 'root-missing' ? { state: 'missing' } : { state: 'error', code: g.reason };
  if (!g.exists) return { state: 'missing' };
  if (g.type !== 'file') return { state: 'error', code: 'not-file' };
  const before = lstatOrNull(g.real);
  if (!before || before.size > BigInt(MAX_SETTINGS_BYTES)) return { state: 'error', code: before ? 'too-large' : 'unreadable' };
  const r = pathSafe.readFileGuarded(root, rel);
  if (!r.ok) return { state: 'error', code: r.reason };
  const after = lstatOrNull(r.real);
  if (!after || identity(before) !== identity(after)) return { state: 'error', code: 'swapped' };
  return { state: 'file', bytes: r.bytes, sha: sha256(r.bytes), id: identity(after) };
}
const pinOf = (label, s) => ({ label, state: s.state, sha: s.sha || null, id: s.id || null });
const pinKey = p => `${p.label}|${p.state}|${p.sha}|${p.id}`;
const samePins = (a, b) => a.length === b.length && a.every((p, i) => pinKey(p) === pinKey(b[i]));

// The settings the launcher writes for the child: DashScope entries of the closed model list only, the key name of the child environment, one JSON object per file.
const settingsBytes = obj => Buffer.from(`${JSON.stringify(obj)}\n`, 'utf8');
const entry = id => ({ id, name: id, baseUrl: DASHSCOPE.baseUrl, envKey: 'OPENAI_API_KEY', generationConfig: { contextWindowSize: 262144 } });
const USER_SETTINGS = settingsBytes({ $version: 4, security: { auth: { selectedType: 'openai' } }, modelProviders: { openai: MODELS.map(entry) } });
const SYSTEM_SETTINGS = settingsBytes({ $version: 4 });

// The named environment variable from the Windows User environment (the registry), or null. Only a plain REG_SZ value counts: an expandable value holds
// %NAME% text the client would not expand the same way. The value is never printed. reg is the ABSOLUTE path the resolver found (a bare name is never spawned:
// without a path the answer is null); the environment of the query is toolEnv.
function readUserEnv(name, run = childProcess.spawnSync, reg = null, toolEnv = null) {
  if (process.platform !== 'win32' || !/^[A-Z][A-Z0-9_]{0,63}$/.test(name) || typeof reg !== 'string' || !path.isAbsolute(reg)) return null;
  const r = run(reg, ['query', 'HKCU\\Environment', '/v', name], { encoding: 'utf8', windowsHide: true, ...(toolEnv ? { env: toolEnv } : {}) });
  if (!r || r.status !== 0) return null;
  const m = new RegExp(`^\\s*${name}\\s+REG_SZ\\s+(.+?)\\s*$`, 'im').exec(String(r.stdout || ''));
  return m ? m[1] : null;
}

// The child environment: routing names removed in any letter case; the DashScope key from the User environment ONLY (a process value of any letter case is dropped,
// with a warning that never holds the value) and handed to the child as OPENAI_API_KEY with the DashScope base URL: the route of the client is these two values and
// the flags, nothing else. The settings of the child (user home, system layer) are the launcher-owned files given by the paths. The key must match KEY_GRAMMAR.
// The parent environment without the names that choose a provider or a key; proxy and TLS names stay (the parent is trusted, see the header).
function scrubbed(env) {
  const out = {}; let processKeyIgnored = false;
  for (const [k, v] of Object.entries(env || {})) {
    const up = k.toUpperCase();
    if (ROUTING_ENV.includes(up)) continue;
    if (up === DASHSCOPE.envKey) { if (String(v === undefined || v === null ? '' : v).trim()) processKeyIgnored = true; continue; }
    out[k] = v;
  }
  return { out, processKeyIgnored };
}
function childEnv(env, key, paths) {
  const { out, processKeyIgnored } = scrubbed(env);
  key = typeof key === 'string' ? key.trim() : '';
  if (!key) return refuse(`${DASHSCOPE.envKey} is not set in the User environment; a process environment value is never used`);
  if (!keyPlausible(key)) return refuse(`${DASHSCOPE.envKey} in the User environment is not a plausible key (16 to 256 characters of letters, digits and _ . ~ + = -, at least 16 letters or digits); its value is not shown`);
  const owned = { QWEN_HOME: paths.home, QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(paths.sys, 'settings.json'), QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(paths.sys, 'system-defaults.json') };
  return { ok: true, processKeyIgnored, key, env: clientPath.childEnv({ ...out, PROTOCOL_NO_FULL_SUITE: '1', PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', OPENAI_API_KEY: key, OPENAI_BASE_URL: DASHSCOPE.baseUrl, ...owned, QWEN_CODE_SUPPRESS_YOLO_WARNING: '1' }), keySource: 'user-env' };
}

// ---- what the launcher keeps of a client run (G4) ----
// Nothing the client printed. The launcher keeps the exit status, the byte count and the sha256 of each stream, and the fixed reason of a run that did not end cleanly.
// A stream is a Buffer when the launcher asked for bytes; a string from a caller is taken as its UTF-8 bytes. The key is never read into any of these fields.
const bytesOf = v => (Buffer.isBuffer(v) ? v : Buffer.from(String(v === undefined || v === null ? '' : v), 'utf8'));
function streamFacts(result) {
  const out = bytesOf(result && result.stdout); const err = bytesOf(result && result.stderr);
  const status = result && Number.isInteger(result.status) ? result.status : null;
  return { exit: status, stdoutBytes: out.length, stdoutSha256: sha256(out), stderrBytes: err.length, stderrSha256: sha256(err) };
}
const factsLine = f => `CLIENT-OUTPUT exit=${f.exit === null ? 'none' : f.exit} stdout.bytes=${f.stdoutBytes} stdout.sha256=${f.stdoutSha256} stderr.bytes=${f.stderrBytes} stderr.sha256=${f.stderrSha256} stored=no`;
// null for a run that started and ended with exit status 0; else one of CLIENT_FAULTS
function clientFault(result) {
  if (!result || result.error) return 'client-not-started';
  if (!Number.isInteger(result.status)) return 'no-exit-status';
  return result.status === 0 ? null : 'client-failed';
}

function maxTurns(env) {
  const raw = env && env.QWEN_MAX_TURNS !== undefined ? String(env.QWEN_MAX_TURNS).trim() : '';
  if (raw === '') return DEFAULT_TURNS;
  return /^[1-9]\d{0,3}$/.test(raw) ? Number(raw) : DEFAULT_TURNS;
}

// The absolute command interpreter for a .cmd or .bat shim: ComSpec when it is an absolute path under SystemRoot, else SystemRoot\System32\cmd.exe; null without SystemRoot.
function commandInterpreter(env) {
  const get = name => { const k = Object.keys(env || {}).find(x => x.toLowerCase() === name.toLowerCase()); return k && typeof env[k] === 'string' ? env[k] : ''; };
  const root = get('SystemRoot');
  if (!root || !path.isAbsolute(root)) return null;
  const inside = p => { const a = path.resolve(root).toLowerCase(); const b = path.resolve(p).toLowerCase(); return b.startsWith(a.endsWith(path.sep) ? a : a + path.sep); };
  const spec = get('ComSpec');
  return spec && path.isAbsolute(spec) && /[\\/]cmd\.exe$/i.test(spec) && inside(spec) ? path.resolve(spec) : path.join(path.resolve(root), 'System32', 'cmd.exe');
}

// All checks before anything starts, in order: model, argv paths (prompt path, worktree, the private directories: data a command interpreter must not expand), workspace
// settings (no redirect exists: refused), prompt file (strict UTF-8), key. Sets o.model (resolved) and o.qwen. -> { ok: true, warnings } | { ok: false, reason }.
// dryRun stops after the model check (no key read, no prompt read, no directory).
function preflight(o, deps, { env, runtime, dryRun }) {
  const io = deps.fs || fs;
  const m = resolveModel(o.model);
  if (!m.ok) return m;
  o.model = m.model;
  if (dryRun) return { ok: true, warnings: [] };
  // the launch name is one safe path segment (the grammar of the cert launcher, checked here too: a direct caller never reaches a directory outside the runtime)
  if (typeof o.name !== 'string' || !LAUNCH_NAME.test(o.name) || o.name.includes('..')) return refuse('the launch name is not one safe path segment (letters, digits, . _ -, no dot-dot, at most 128 characters, starting with a letter or digit)');
  // the directory names are fresh for every launch
  const tag = crypto.randomBytes(4).toString('hex');
  const homeDir = path.join(runtime, `${o.name}-qwen-home-${tag}`);
  const sysDir = path.join(runtime, `${o.name}-qwen-sys-${tag}`);
  for (const [what, p] of [['prompt file', String(o.promptFile)], ['worktree', String(o.worktree)], ['home directory', homeDir], ['system directory', sysDir]]) {
    if (!ARGV_PATH.test(p)) return refuse(`the ${what} path holds a character outside letters, digits, space and . _ : / \\ + @ ~ , = - (non-ASCII text, %, ^, &, |, <, >, " or !): paths go through the cmd.exe command line, which would expand or mangle them`);
  }
  if (lstatOrNull(path.join(o.worktree, '.qwen', 'settings.json'))) return refuse('the worktree holds a .qwen/settings.json: the client reads the workspace settings from the working directory and no redirect exists for them, so a workspace settings file is never judged or watched, the launch is refused');
  let promptText;
  try {
    const buf = io.readFileSync(path.resolve(o.worktree, o.promptFile));
    if (buf.length > MAX_PROMPT_BYTES) return refuse(`the prompt file is larger than ${MAX_PROMPT_BYTES} bytes`);
    promptText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buf);
    if (promptText.charCodeAt(0) === 0xfeff) promptText = promptText.slice(1); // one leading byte-order mark is dropped
  } catch { return refuse('the prompt file cannot be read as UTF-8'); }
  if (promptText.charCodeAt(0) === 0xfeff) return refuse('the prompt file starts with a second byte-order mark: one is dropped, two are refused');
  // the client, git and reg are resolved once to absolute paths (never the current directory, a relative PATH entry, the worktree or the launch runtime directory)
  const resolve = deps.resolveClient || clientPath.resolveClient;
  const tools = {};
  for (const name of ['qwen', 'git', 'reg']) {
    const r = resolve(name, { env, refuseInside: [o.worktree, runtime] });
    if (r && r.reason === 'path-spelling-refused') return refuse('the worktree, the launch runtime directory or a PATH directory has a spelling with a path segment ending in a trailing space or dot, or with leading or trailing whitespace, in the text or in its real path (path-spelling-refused): such a spelling names a different path to the resolver and is refused outright, never normalised, before anything is searched or started');
    if (!r || r.ok !== true || typeof r.path !== 'string' || !path.isAbsolute(r.path)) return refuse(`the ${name} executable was not resolved to an absolute path (${r && r.reason ? r.reason : 'client-not-found'}); the current directory and relative PATH entries are never searched`);
    tools[name] = r.path;
  }
  const shim = process.platform === 'win32' && /\.(?:cmd|bat)$/i.test(tools.qwen);
  let comspec = null;
  if (shim) {
    if (!ARGV_PATH.test(tools.qwen)) return refuse('the resolved qwen path holds a character the command interpreter would expand (client-path-unsafe)');
    comspec = commandInterpreter(env);
    if (!comspec) return refuse('the command interpreter under SystemRoot cannot be found (comspec-unavailable); a shim is never run through a bare cmd.exe');
  }
  const { out: toolBase } = scrubbed(env); const toolEnv = clientPath.childEnv(toolBase);
  const userEnv = deps.userEnv || (name => readUserEnv(name, deps.spawnSync || childProcess.spawnSync, tools.reg, toolEnv));
  const u = userEnv(DASHSCOPE.envKey); const key = typeof u === 'string' ? u.trim() : '';
  const ce = childEnv(env, key, { home: homeDir, sys: sysDir });
  if (!ce.ok) return ce;
  o.qwen = { env: ce.env, key: ce.key, keySource: ce.keySource, promptText, homeDir, sysDir, turns: maxTurns(env), runtime, client: tools.qwen, git: tools.git, comspec, toolEnv };
  const warnings = ce.processKeyIgnored ? [`WARN ${DASHSCOPE.envKey} in the process environment is ignored: the key comes from the User environment only`] : [];
  return { ok: true, warnings };
}

// ---- the spawn-time guard ----
// recheck (immediately before the client starts): the private directories of the launch are made exclusively (a name that exists is refused) with the launcher-owned
// settings files (read-only, pinned by content and identity); a workspace settings file refuses again.
// afterRun (after the child ended): every pin is compared again; a difference of any kind, restored bytes included, voids the launch (routeFault) and the cost is then unknown.
const dirIdOf = st => `${st.dev}:${st.ino}`;
const dirPin = p => { const st = lstatOrNull(p); return st && st.isDirectory() ? `${dirIdOf(st)}:${st.mtimeNs}:${st.ctimeNs}` : null; };
// A directory of this launch: its name must not exist, it is made by the guarded mkdir, it must be empty and a plain directory. -> { ok } | { ok: false, reason }
function makeExclusiveDir(root, dir, what, made) {
  const g = pathSafe.realInside(root, path.basename(dir));
  if (!g.ok || g.exists) return refuse(`the ${what} of the launch cannot be made exclusively (${g.ok ? 'the name exists' : g.reason})`);
  const mk = pathSafe.mkdirGuarded(root, dir);
  if (!mk.ok) return refuse(`the ${what} cannot be made (${mk.reason})`);
  made.push(dir);
  const st = lstatOrNull(dir);
  if (!st || !st.isDirectory()) return refuse(`the ${what} is not a plain directory`);
  try { if (fs.readdirSync(dir).length) return refuse(`the ${what} is not empty after it was made`); } catch { return refuse(`the ${what} cannot be listed`); }
  return { ok: true };
}
function writeOwned(dir, name, bytes) {
  const w = pathSafe.writeAtomicGuarded(name, bytes, { root: dir });
  if (!w.ok) return refuse(`the launcher-owned settings file ${name} cannot be written (${w.reason})`);
  try { fs.chmodSync(path.join(dir, name), 0o444); } catch { return refuse(`the launcher-owned settings file ${name} cannot be made read-only`); }
  const back = readSetting(dir, name);
  if (back.state !== 'file' || back.sha !== sha256(bytes)) return refuse(`the launcher-owned settings file ${name} is not what was written`);
  return { ok: true, pin: pinOf('', back) };
}
function makePrivate(o) {
  const q = o.qwen;
  q.made = [];
  const home = makeExclusiveDir(q.runtime, q.homeDir, 'private home', q.made);
  if (!home.ok) return home;
  const sys = makeExclusiveDir(q.runtime, q.sysDir, 'private system directory', q.made);
  if (!sys.ok) return sys;
  const files = [['user', q.homeDir, 'settings.json', USER_SETTINGS], ['system', q.sysDir, 'settings.json', SYSTEM_SETTINGS], ['defaults', q.sysDir, 'system-defaults.json', SYSTEM_SETTINGS]];
  q.owned = [];
  for (const [label, dir, name, bytes] of files) {
    const w = writeOwned(dir, name, bytes);
    if (!w.ok) return w;
    q.owned.push({ label, dir, name, pin: { ...w.pin, label } });
  }
  q.sysPin = dirPin(q.sysDir);
  return { ok: true };
}
// The private directories of a launch are removed on every path once the run is judged (or the launch refused): the client state and any file it put there do not stay.
// A directory that is no longer a plain directory (a link put in its place) is unlinked, never followed. Best effort: a directory that cannot be removed is left, not hidden.
function cleanup(o) {
  const q = o && o.qwen; const removed = [];
  if (!q) return removed;
  for (const dir of q.made || []) { // only names this launch made
    const st = lstatOrNull(dir);
    if (!st) continue;
    try {
      if (st.isDirectory()) {
        for (const f of ['settings.json', 'system-defaults.json']) { try { fs.chmodSync(path.join(dir, f), 0o666); } catch { /* absent */ } }
        fs.rmSync(dir, { recursive: true, force: true });
      } else fs.rmSync(dir, { force: true });
      removed.push(dir);
    } catch { try { fs.rmdirSync(dir); removed.push(dir); } catch { /* left in place */ } }
  }
  return removed;
}
// Called immediately before the client starts. -> { ok } | { ok: false, reason }
function recheck(o) {
  if (lstatOrNull(path.join(o.worktree, '.qwen', 'settings.json'))) return refuse('the worktree holds a .qwen/settings.json; no redirect exists for the workspace settings');
  const made = makePrivate(o);
  if (!made.ok) cleanup(o);
  return made;
}
// The route proof of G1: all three settings sources of the client are launcher-owned files that kept their pins for the whole run (and the private system directory its
// identity). -> { ok: true, route } | { ok: false, reason }
function routeStable(o) {
  const q = o.qwen;
  if (!q || !Array.isArray(q.owned) || q.owned.map(f => f.label).join() !== SETTINGS_SOURCES.join()) return refuse('the settings sources of the client were not all made by the launcher');
  const now = q.owned.map(f => pinOf(f.label, readSetting(f.dir, f.name)));
  if (!samePins(now, q.owned.map(f => f.pin))) return refuse('a launcher-owned settings file of the client changed during the run');
  if (dirPin(q.sysDir) !== q.sysPin) return refuse('the private system settings directory changed during the run');
  return { ok: true, route: { ok: true, how: ROUTE_HOW, model: o.model, baseUrl: DASHSCOPE.baseUrl, sources: SETTINGS_SOURCES.slice() } };
}
// The verdict of a finished launch, then the private directories are removed (every path: a clean run, a failed one, a voided one). Nothing the client printed is kept or read:
// afterRun returns the structured facts of the streams, the fixed fault of a run that did not end cleanly, and the route verdict.
// The route object (the proof of G2) exists only when the pins held for the whole run AND the client was started from the resolved path and ended with exit status 0.
// -> { facts, clientFault, route, routeFault }
function afterRun(o, io, result) {
  const facts = streamFacts(result); const fault = clientFault(result);
  const s = routeStable(o);
  cleanup(o);
  const route = s.ok && !fault ? { ...s.route, client: CLIENT_RESOLVED, exit: 0 } : null;
  return { facts, clientFault: fault, route, routeFault: s.ok ? null : s.reason };
}

// The spawn description of one launch (the prompt on stdin, the one-line ASCII instruction in -p). The client is the ABSOLUTE path the resolver found: an .exe runs as it is, a
// .cmd or .bat shim runs through the absolute command interpreter with one verbatim command line (every piece quoted; the pieces hold no quote, % ^ or ! character). Without a
// resolved path (a direct call without preflight) there is nothing to start: command is null and the launcher refuses. The instruction line is data too: non-ASCII text and the
// characters a command interpreter expands become ?. The output is read as bytes; the child environment says the current directory is never searched.
function buildInvocation(o, argText, commonEnv) {
  const q = o.qwen || {};
  const line = String(argText).replace(/[^\x20-\x7e]/g, '?').replace(/[%"^!`]/g, '?').replace(/\\+$/, '?');
  const tail = ['-m', o.model, '--bare', '--auth-type', 'openai', '--approval-mode', 'yolo', '--output-format', 'text', '--max-session-turns', String(q.turns || DEFAULT_TURNS), '-p', line];
  // Launch isolation: the child environment is the launch work environment the other clients get (commonEnv already names TEMP, TMP, TMPDIR, the
  // caches and NODE_COMPILE_CACHE inside the per-launch work dir), rebuilt through the SAME childEnv the preflight used: one function, no second copy.
  // Only the key and the launcher-owned settings paths are added; the private settings directory stays inside the launch root (q.homeDir/q.sysDir).
  const live = q.key && typeof q.homeDir === 'string' && typeof q.sysDir === 'string' ? childEnv(commonEnv, q.key, { home: q.homeDir, sys: q.sysDir }) : null;
  if (live && !live.ok) return { command: null, refused: live.reason, args: tail, spawnOptions: { cwd: o.worktree, encoding: 'buffer', env: clientPath.childEnv(commonEnv || {}), maxBuffer: 536870912 }, argText: line };
  const env = live ? live.env : (q.env || clientPath.childEnv(commonEnv));
  const spawnOptions = { cwd: o.worktree, encoding: 'buffer', env, maxBuffer: 536870912 };
  if (typeof q.promptText === 'string') spawnOptions.input = Buffer.from(q.promptText, 'utf8'); // bytes: with encoding buffer a string input is not accepted
  if (typeof q.client !== 'string') return { command: null, args: tail, spawnOptions, argText: line };
  if (q.comspec) {
    spawnOptions.windowsVerbatimArguments = true;
    return { command: q.comspec, args: ['/d', '/s', '/c', `"${[q.client, ...tail].map(a => `"${a}"`).join(' ')}"`], spawnOptions, argText: line };
  }
  return { command: q.client, args: tail, spawnOptions, argText: line };
}

// ---- served model (G2) ----
// The served model of a qwen launch is the explicit model the launcher passed with -m (source launcher-model, confidence derived), PROTO-DEC-0211 item 1. It counts only when
// the route is fixed by construction: the launcher made all three settings sources of the client (afterRun route: the pins held for the whole run), the model is on the closed
// list and of the model-id grammar, and the route names that same model and the DashScope base URL. A caller without such a route, a model that did not reach the client by flag
// or one outside the list gets no proof (unknown with a reason), never a guess. Nothing the client printed or stored is read. -> a served-model result (none() for no proof)
function derive(input, none) {
  const requested = input && input.requestedModel; const route = input && input.qwenRoute;
  // a run that did not end with exit status 0 (or never started) proves nothing, whatever else was handed over; the reason is one of the fixed fault codes
  if (input && input.qwenClientFault !== undefined && input.qwenClientFault !== null) return none(`no launcher-model proof: the client run did not end cleanly (${CLIENT_FAULTS.includes(input.qwenClientFault) ? input.qwenClientFault : 'client-failed'})`, CLIENT_FAULTS.includes(input.qwenClientFault) ? input.qwenClientFault : 'client-failed');
  if (!input || input.requestedModelVia !== 'flag') return none(`no launcher-model evidence for qwen (the model did not reach the client by flag; requestedModelVia ${(input && input.requestedModelVia) || 'unstated'})`, 'no route proof');
  if (typeof requested !== 'string' || !MODEL_GRAMMAR.test(requested) || !MODELS.includes(requested)) return none('the requested model is not a model of the closed DashScope list', 'no route proof');
  if (!isObject(route) || route.ok !== true || route.how !== ROUTE_HOW || route.model !== requested || route.baseUrl !== DASHSCOPE.baseUrl || route.client !== CLIENT_RESOLVED || route.exit !== 0) return none('the launcher did not hold a pinned DashScope route for this model', 'no route proof');
  return { servedModel: requested, source: 'launcher-model', confidence: 'derived', match: modelsEqual(requested, route.model), detail: `the explicit model the launcher passed (-m ${requested}) over the launcher-owned pinned settings of every settings source` };
}

// Exact, case-insensitive. NOT the provider-prefix-tolerant comparison of the other clients: "alibaba/qwen3.8-flash" (the paid gateway id) must never
// match the requested "qwen3.8-flash". -> true | false | 'unknown'
function modelsEqual(requested, served) {
  const a = lower(requested); const b = lower(served);
  if (!a || !b) return 'unknown';
  return a === b;
}

// ---- tokens and cost (G3) ----
// Free quota is a cost basis of its own in the report, but the launch-record validator knows priced | subscription | unknown only (a new basis is a validator, stats and
// schema package): the record carries basis subscription (usd null, never a number) and clientCostBasis free-quota. It needs the proven route: the requested AND the served
// model must be on the closed list; a served model that is not proven (the pinned route was not held) gives cost unknown with a reason, never free.
function freeQuotaCost({ model, servedModel }) {
  const unknown = reason => ({ usd: null, basis: 'unknown', priceSnapshot: null, formula: null, reason });
  if (typeof model !== 'string' || !MODELS.includes(model)) return unknown('the requested model is not on the free-quota list; its cost is not stated');
  if (typeof servedModel !== 'string' || !servedModel) return unknown('the served model is not proven (the pinned route was not held); the route may be a paid one, so the cost is not stated as free');
  if (!MODELS.includes(servedModel)) return unknown('the served model is not on the free-quota list; its cost is not stated');
  return { usd: null, basis: 'subscription', priceSnapshot: null, formula: null, note: FREE_NOTE, clientCostBasis: 'free-quota' };
}

// Tokens are not counted for this client: null with the reason, whatever the client printed (nothing it printed is read). -> { fields: { tokens, cost }, info } (the shape of
// launch-record usageRecordFields)
function usageFields({ model, servedModel }) {
  return { fields: { tokens: null, cost: freeQuotaCost({ model, servedModel }) }, info: { reason: NOT_COUNTED, stopReason: null, resultText: null } };
}

module.exports = { DASHSCOPE, MODELS, SEAT_MODEL, ROUTING_ENV, DEFAULT_TURNS, FREE_NOTE, NOT_COUNTED, ROUTE_HOW, CLIENT_RESOLVED, CLIENT_FAULTS, resolveModel, readUserEnv, childEnv, factsLine, commandInterpreter, maxTurns, preflight, recheck, cleanup, afterRun, buildInvocation, derive, modelsEqual, freeQuotaCost, usageFields };

'use strict';
// kimi-route.cjs - the billing route of a Kimi Code launch, fixed BY CONSTRUCTION (PROTO-DEC-0200 item 6, PROTO-DEC-0211 item 1, PROTO-DEC-0212).
//   check(input)   -> { ok, reason, detail, alias, ... }  no side effect: the alias grammar and the presence of the subscription login
//   prepare(input) -> { ok, how: 'generated-config', alias, provider, host, home, configPath, configSha256, configId } | { ok: false, reason, detail }
//   verify(route, input) -> { ok, reason, detail }  the private config still has the recorded sha256 and file identity (before the start and after the exit)
//   release(route)  -> removes the private directory of a refused launch (the credentials link is detached, never followed)
//   childEnv(env, home) -> the environment of the client: no KIMI_* variable of the caller, KIMI_CODE_HOME = the private home
// Kimi Code 2.1.1 reads its whole configuration from one home directory: KIMI_CODE_HOME (default ~/.kimi-code) holds config.toml, the credentials folder, the
// sessions and the rest; its KIMI_MODEL_*, KIMI_API_KEY, KIMI_BASE_URL and KIMI_CODE_BASE_URL variables can add or redirect a provider. So the route is closed here:
//   1. the launcher creates ONE private directory per launch (fs.mkdirSync of a fresh random name under the launch temp root: it must not exist, owner only) and writes
//      into it, with exclusive create, a config.toml generated from the fixed template below, which holds exactly the Kimi Code subscription provider (the Kimi Code coding endpoint, BASE_URL below) and the one requested
//      kimi-code model row, and nothing else (no moonshot-ai provider, no other model, no service);
//   2. the subscription login is brought in BY REFERENCE: a directory link (a junction on Windows) from <private home>/credentials to the user's credentials folder,
//      so the client reads and refreshes its own token file and the launcher never opens, copies, parses, prints or writes a credential value;
//   3. the client starts with KIMI_CODE_HOME = the private home and with every KIMI_* variable of the caller removed (childEnv), so no variable and no file of the
//      user can add a provider, change a base URL or select another config.
// The user's own config.toml is never read, so there is no TOML reader here and nothing in the user's files can change the route between a check and the start.
// If the private home cannot be created, written or linked, the launch is refused with a named reason (never a fallback to the user's own config), and the private
// directory that was already made is removed before the refusal is returned (PROTO-DEC-0217 item 3).
// TRUST BOUNDARY (PROTO-DEC-0217 items 1 and 2): the operating-system user. "Fixed by construction" holds against INPUTS (environment, the user's config, project files, the
// client's own stores). A concurrent process of the SAME user can replace the private config, the client binary or the client itself: that is outside the boundary and no
// construction inside one account prevents it. Inside the boundary the launcher adds DETECTION: the sha256 and the file identity (device and inode, or the Windows file id)
// of the config are recorded when it is written and checked by verify() immediately before the start (a mismatch refuses the launch, reason private-config-changed) and
// again after the exit (a mismatch makes the served model unknown, never proven).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const clientPath = require('./lib/client-path.cjs');
const { IGNORABLE_FORMAT_RE } = require('../../.ai/bin/lib/text-safe.cjs');

// The closed, case-exact grammar of a subscription alias (kimi-code/<lower case model>, 1-64 characters). An empty, path-like, padded or upper case value is no alias.
const SUBSCRIPTION_ALIAS = /^kimi-code\/[a-z0-9][a-z0-9._-]{0,63}$/;
// scrub: every control, line or paragraph separator and default-ignorable or format code point of a text is written out as its code point and the length is capped
// (the invisible class is the shared one of text-safe.cjs). Every value that goes into an output line passes through it: a newline or an invisible character in an
// alias, a path or an error text can never split or forge a line of the refusal or of the record note.
const scrub = (s, max = 400) => { const t = String(s).replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, c => `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`).replace(IGNORABLE_FORMAT_RE, c => `\\u{${c.codePointAt(0).toString(16)}}`); return t.length > max ? `${t.slice(0, max)}...` : t; };
// A plain value (visible ASCII with no space, quote or backslash: an alias, a host, a provider key like managed:kimi-code) is shown as it is; any other value is quoted.
const show = (s, max = 80) => { const t = String(s); return /^[A-Za-z0-9._:/@%+=-]{0,200}$/.test(t) ? scrub(t, max) : scrub(JSON.stringify(t), max); };
const SUBSCRIPTION_HOST = 'api.kimi.com';
const SUBSCRIPTION_PATH = '/coding';
const PROVIDER_KEY = 'managed:kimi-code';
const BASE_URL = `https://${SUBSCRIPTION_HOST}${SUBSCRIPTION_PATH}/v1`;
// the login of the Kimi Code subscription: the token store entry the client names oauth/kimi-code lives in credentials/kimi-code.json (resolveKimiTokenStorageName of the client)
const OAUTH_KEY = 'oauth/kimi-code';
const CREDENTIALS_FILE = 'kimi-code.json';
const CREDENTIALS_DIR = 'credentials';
const HOME_PREFIX = 'kimi-home-';
const CHANGED = 'private-config-changed';

// The fixed template. The only variable parts are the alias and the model id, both cut from the closed grammar above (no quote, backslash or control character can occur).
function template(alias) {
  const model = alias.slice('kimi-code/'.length);
  return [
    `default_model = "${alias}"`,
    '',
    `[providers."${PROVIDER_KEY}"]`,
    'type = "kimi"',
    `base_url = "${BASE_URL}"`,
    '',
    `[providers."${PROVIDER_KEY}".oauth]`,
    'storage = "file"',
    `key = "${OAUTH_KEY}"`,
    '',
    `[models."${alias}"]`,
    `provider = "${PROVIDER_KEY}"`,
    `model = "${model}"`,
    'max_context_size = 262144',
    'capabilities = [ "thinking", "always_thinking", "image_in", "video_in", "tool_use", "dynamically_loaded_tools" ]',
    'support_efforts = [ "low", "high", "max" ]',
    'default_effort = "high"',
    '',
  ].join('\n');
}

function refuse(reason, alias, detail) { return { ok: false, reason, alias: alias === undefined ? null : alias, provider: null, host: null, detail }; }

// The folder of the user's own Kimi Code data: KIMI_CODE_HOME of the caller when set (a location, never a route), else ~/.kimi-code.
// A relative KIMI_CODE_HOME is made absolute here, once, so the link target never depends on the working directory of a later step.
function userHomeOf(env, osHome) { const own = env && typeof env.KIMI_CODE_HOME === 'string' ? env.KIMI_CODE_HOME : ''; return own !== '' ? path.resolve(own) : path.join(osHome || os.homedir(), '.kimi-code'); }

// No side effect: the alias is of the closed subscription grammar and the subscription login exists (its file is only stat-ed, never opened).
function check(input = {}) {
  const io = input.fs || fs;
  const a = typeof input.model === 'string' ? input.model : '';
  if (!SUBSCRIPTION_ALIAS.test(a)) {
    const perToken = /^moonshot-ai\//i.test(a);
    return refuse(perToken ? 'per-token-alias' : 'not-a-subscription-alias', a.slice(0, 80), perToken ? 'a moonshot-ai alias: the Open Platform bills per token' : 'the alias is not of the form kimi-code/<model> (lower case, closed grammar)');
  }
  const source = path.join(userHomeOf(input.env, input.osHome), CREDENTIALS_DIR);
  let present = false;
  try { present = io.statSync(path.join(source, CREDENTIALS_FILE)).isFile(); } catch { present = false; }
  if (!present) return refuse('credentials-missing', a, `the Kimi Code subscription login (${CREDENTIALS_DIR}/${CREDENTIALS_FILE}) was not found; log in with kimi first`);
  return { ok: true, reason: null, alias: a, source };
}

// The identity of an open file: device and inode as bigint (the Windows file id on Windows). Taken from the descriptor, so it names the file that was read.
const idOf = st => `${st.dev}:${st.ino}`;
const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
const codeOf = error => (error && error.code) || 'error';

// Removes one entry or a whole tree, lstat only: a link (a junction on Windows) is detached itself and its target is never entered. (Kept here and not taken from a
// test helper: this module ships in the pilot kit, whose closure is exact.)
function removeTree(target) {
  const st = (() => { try { return fs.lstatSync(target); } catch (error) { if (error && error.code === 'ENOENT') return null; throw error; } })();
  if (!st) return;
  if (st.isSymbolicLink()) { try { fs.unlinkSync(target); } catch (error) { if (!error || error.code !== 'ENOENT') fs.rmdirSync(target); } return; }
  if (!st.isDirectory()) { fs.unlinkSync(target); return; }
  for (const name of fs.readdirSync(target)) removeTree(path.join(target, name));
  fs.rmdirSync(target);
}

// Removes the private directory of a launch that did not start. Only a directory this module names (kimi-home-<random>) is touched; removeTree uses lstat, so the
// credentials link is detached and its target (the user's login) is never entered.
function release(route) {
  const home = route && typeof route.home === 'string' ? route.home : '';
  if (home === '' || !path.basename(home).startsWith(HOME_PREFIX)) return { removed: false, error: 'not-a-private-home' };
  try { removeTree(home); return { removed: true, error: null }; } catch (error) { return { removed: false, error: codeOf(error) }; }
}

// Creates the private home of one launch and returns the route object the served-model proof takes. Every failure is a named refusal; one made after the directory
// exists removes it first (one cleanup for every refusal path).
function prepare(input = {}) {
  const io = input.fs || fs;
  const checked = check(input);
  if (!checked.ok) return checked;
  const a = checked.alias;
  const platform = input.platform || process.platform;
  const tmpRoot = input.tmpRoot || os.tmpdir();
  const home = path.join(tmpRoot, HOME_PREFIX + crypto.randomBytes(9).toString('hex'));
  // not recursive: the directory must not exist (EEXIST is a refusal), and its parent must
  try { io.mkdirSync(home, { mode: 0o700 }); } catch (error) { return refuse('private-home-unavailable', a, `the private config directory cannot be created (${codeOf(error)})`); }
  const failed = (reason, what, error) => {
    const gone = release({ home });
    return refuse(reason, a, `${what} (${codeOf(error)})${gone.removed ? '' : `; the private directory could not be removed (${gone.error})`}`);
  };
  const config = template(a);
  const configPath = path.join(home, 'config.toml');
  let configId;
  try { io.writeFileSync(configPath, config, { encoding: 'utf8', flag: 'wx' }); configId = idOf(io.statSync(configPath, { bigint: true })); } catch (error) { return failed('private-config-unwritable', 'the private config cannot be written', error); }
  try { io.symlinkSync(checked.source, path.join(home, CREDENTIALS_DIR), platform === 'win32' ? 'junction' : 'dir'); } catch (error) { return failed('credentials-unlinkable', 'the subscription login cannot be linked into the private directory', error); }
  return { ok: true, reason: null, how: 'generated-config', alias: a, provider: PROVIDER_KEY, host: SUBSCRIPTION_HOST, home, configPath, configSha256: sha256(config), configId };
}

// Detection (PROTO-DEC-0217 item 2): the private config still has the sha256 and the file identity recorded when it was written. The file is opened once and both the
// identity and the content come from that one descriptor. Any difference, a missing file or a failed read is "changed".
function verify(route, input = {}) {
  const io = input.fs || fs;
  const changed = detail => ({ ok: false, reason: CHANGED, detail });
  if (!route || route.ok !== true || typeof route.configPath !== 'string' || typeof route.configSha256 !== 'string' || typeof route.configId !== 'string') return changed('no recorded hash and identity of the private config');
  let fd;
  try {
    fd = io.openSync(route.configPath, 'r');
    const id = idOf(io.fstatSync(fd, { bigint: true }));
    const digest = sha256(io.readFileSync(fd));
    if (digest !== route.configSha256) return changed('the content of the private config differs from the one the launcher wrote');
    if (id !== route.configId) return changed('the private config is another file than the one the launcher wrote');
    return { ok: true, reason: null, detail: null };
  } catch (error) { return changed(`the private config cannot be checked (${codeOf(error)})`); } finally { if (fd !== undefined) { try { io.closeSync(fd); } catch { /* nothing to close */ } } }
}

// The environment of the client: the caller's variables except every KIMI_* one (case-insensitive: Windows names are), and KIMI_CODE_HOME set to the private home.
function childEnv(env, home) {
  const out = {};
  for (const [k, v] of Object.entries(env || {})) if (!/^kimi_/i.test(k)) out[k] = v;
  out.KIMI_CODE_HOME = home;
  return out;
}

// Why a launch proves nothing. spawnSync gives { error } and a null status when the client process was never created (ENOENT and the like), a null status with a
// signal when it was killed, and a number when a process ended. Only a client that was spawned from the resolved absolute path (resolveLaunch: a missing client is refused
// before any spawn) AND ended with exit status 0 may be proven; any other number is client-failed (the client or the shell around it failed: the route is not shown to have been used).
const NOT_STARTED = 'client-not-started';
const NO_EXIT_STATUS = 'no-exit-status';
const CLIENT_FAILED = 'client-failed';
function notRunReason(result) {
  if (!result || typeof result !== 'object') return NOT_STARTED;
  const numeric = typeof result.status === 'number' && Number.isInteger(result.status);
  if (result.error && !numeric && !result.signal) return NOT_STARTED;
  if (!numeric || result.signal || result.error) return NO_EXIT_STATUS;
  if (result.status !== 0) return CLIENT_FAILED;
  return null;
}
// The plain-data copy of a spawn result: every field is read ONCE inside its own try, so a null result or a getter that throws (or answers differently on a second read) can
// never escape the launcher. No result is a client that was not started; an unreadable status is no exit status.
function snapshot(raw) {
  if (!raw || typeof raw !== 'object') return { status: null, signal: null, error: { code: 'ENORESULT' }, stdout: '', stderr: '' };
  const read = (name, fallback) => { try { const v = raw[name]; return v === undefined ? fallback : v; } catch { return fallback; } };
  return { status: read('status', null), signal: read('signal', null), error: read('error', null), stdout: read('stdout', ''), stderr: read('stderr', '') };
}

// The client is resolved ONCE to an absolute path by the shared resolver (lib/client-path.cjs) before anything is made or started: the PATH entries inside the worktree and
// the launch temp root are skipped, and a failure refuses the launch with the fixed reason of the resolver. The spawn then uses that absolute path; a .cmd or .bat shim
// runs through the absolute command interpreter under SystemRoot (never the bare name, never the ComSpec variable of the caller).
const RESOLVE_DETAIL = {
  'client-not-found': 'the kimi client was not found in a PATH directory outside the worktree and the temp root',
  'client-path-missing': 'the environment has no PATH to find the kimi client in',
  'client-name-invalid': 'the client name is not a plain file name',
  'path-spelling-refused': 'a worktree, temp root or PATH entry has leading or trailing whitespace, a segment that ends in a space or a dot, or any spelling that is not a plain drive-absolute path (a UNC or loopback UNC spelling, an extended-length or device prefix and a relative PATH entry are all covered by this refusal): Windows reads such a spelling as another name of the same directory or as another namespace',
  'client-path-unsafe': 'the resolved kimi client path has a character a shell would read as syntax',
  'shell-unavailable': 'the system command interpreter could not be located under SystemRoot',
};
const envValue = (env, name) => { const key = Object.keys(env || {}).find(k => k.toLowerCase() === name.toLowerCase()); return key === undefined ? undefined : env[key]; };
function resolveLaunch(input = {}) {
  const env = input.env || process.env;
  const platform = input.platform || process.platform;
  const refuseInside = [input.worktree, input.tmpRoot || os.tmpdir()].filter(root => typeof root === 'string' && root !== '');
  const found = clientPath.resolveClient('kimi', { env, platform, refuseInside });
  const no = reason => ({ ok: false, reason, detail: RESOLVE_DETAIL[reason] || 'the kimi client could not be resolved' });
  if (!found || found.ok !== true) return no(found && found.reason);
  const ext = path.extname(found.path).toLowerCase();
  if (platform === 'win32' && (ext === '.cmd' || ext === '.bat')) {
    if (/[\s&()^%!"<>|;,=]/.test(found.path)) return no('client-path-unsafe');
    const root = envValue(env, 'SystemRoot');
    if (typeof root !== 'string' || !path.isAbsolute(root)) return no('shell-unavailable');
    return { ok: true, path: found.path, command: path.join(root, 'System32', 'cmd.exe'), prefix: ['/d', '/c', found.path] };
  }
  return { ok: true, path: found.path, command: found.path, prefix: [] };
}

const NOT_RUN_DETAIL = { [NOT_STARTED]: 'the client process was not started', [NO_EXIT_STATUS]: 'the client ended without a numeric exit status', [CLIENT_FAILED]: 'the client ended with a non-zero exit status: the use of the subscription route is not shown' };
// The launcher-side life cycle of ONE launch, kept here so that cert-launch.cjs holds only call sites: `mod` is the route module (the real one, or a test double);
// input is { model, env, fs, tmpRoot, osHome, platform, error } (error: the diagnostics sink).
//   prepare()         -> the route object, or a refusal { ok: false, reason, detail }; never throws
//   guarded(fn)       -> fn(); if it throws, the private directory is removed and the failure surfaces unchanged
//   preSpawn(io)      -> null when the private config is still the written file; else the refusal (the directory is removed)
//   snapshot(res)     -> the plain-data copy of a spawn result (a null result or a throwing getter never escapes)
//   afterRun(io, res) -> the check handed to the served-model proof: verify() after a client that started and ended with exit status 0, a fixed unproven reason (and the directory removed) after any other end; never throws
//   resolveLaunch (module level) -> the client resolved once to an absolute path before any spawn
//   childEnv(env)     -> the environment of the client
//   drop()            -> removes the private directory once; a failed removal is named in the diagnostics with its error code, never with a path, and never replaces the main failure
function launchSession(mod, input = {}) {
  const sink = typeof input.error === 'function' ? input.error : () => {};
  const state = { route: null, dropped: false };
  const changed = detail => ({ ok: false, reason: CHANGED, detail });
  const verifyNow = io => {
    try { const r = mod.verify(state.route, { fs: io }); return r && typeof r === 'object' ? r : changed('the private config check gave no answer'); } catch (error) { return changed(`the private config cannot be checked (${codeOf(error)})`); }
  };
  const drop = () => {
    if (!state.route || state.dropped) return;
    state.dropped = true;
    let code = null;
    try { const gone = (mod.release || release)(state.route); if (!gone || gone.removed !== true) code = (gone && gone.error) || 'unknown'; } catch (error) { code = codeOf(error); }
    if (code !== null) { try { sink(`KIMI CLEANUP FAILED code=${scrub(code, 40)}: the private directory of this launch could not be removed`); } catch { /* the diagnostics sink must not hide the main failure */ } }
  };
  return {
    prepare() {
      let r;
      try { r = mod.prepare({ model: input.model, env: input.env, fs: input.fs, tmpRoot: input.tmpRoot, osHome: input.osHome, platform: input.platform }); } catch (error) { r = { ok: false, reason: 'private-home-unavailable', detail: `the private config directory cannot be made (${codeOf(error)})` }; }
      if (!r || r.ok !== true) return r && r.ok === false ? r : { ok: false, reason: 'private-home-unavailable', detail: 'the private config directory cannot be made' };
      state.route = r;
      return r;
    },
    guarded(fn) { try { return fn(); } catch (error) { drop(); throw error; } },
    preSpawn(io) { const before = verifyNow(io); if (before.ok === true) return null; drop(); return before; },
    snapshot,
    afterRun(io, result) {
      let why;
      try { why = notRunReason(snapshot(result)); } catch { why = NO_EXIT_STATUS; }
      if (why) { drop(); return { ok: false, reason: why, notRun: why !== CLIENT_FAILED, detail: NOT_RUN_DETAIL[why] }; }
      return verifyNow(io);
    },
    childEnv(env) { return clientPath.childEnv(mod.childEnv(env, state.route.home)); },
    drop,
  };
}

module.exports = { check, prepare, verify, release, childEnv, launchSession, resolveLaunch, snapshot, notRunReason, NOT_STARTED, NO_EXIT_STATUS, CLIENT_FAILED, template, userHomeOf, SUBSCRIPTION_ALIAS, SUBSCRIPTION_HOST, SUBSCRIPTION_PATH, PROVIDER_KEY, BASE_URL, OAUTH_KEY, CREDENTIALS_FILE, HOME_PREFIX, CHANGED, safeText: scrub, show };

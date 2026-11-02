'use strict';
// Seat routes are the L4 card roster. Credentials stay in the child environment.
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const access = require('../../.ai/bin/access/clients.cjs');
const catalog = require('../../docs/ops/channels-catalog.json');
const API = Object.freeze({
  deepseek: { base: 'https://api.deepseek.com', channel: 'deepseek' },
  openrouter: { base: 'https://openrouter.ai/api/v1', channel: 'openrouter' },
  odirouter: { base: 'https://api.odirouter.ai/v1', channel: 'odirouter' },
  cloudflare: { channel: 'cloudflare', question: 'The card does not specify the account endpoint or model mapping.' },
  vercel: { base: 'https://ai-gateway.vercel.sh/v1', channel: 'gateway' },
});
const BLOCKED = Object.freeze({
  copilot: 'The card does not identify a native served-model proof source; the launch template is implemented.',
  dahl: 'The card has no agent command, approval flags or model proof.',
  opencode: 'The card has no approved command, approval flags or model proof.',
});
const CLIENTS = Object.freeze(['claude','cline','cloudflare','codex','copilot','dahl','deepseek','kilo','kimi','mimo','odirouter','ollama','opencode','openrouter','qwen','vercel','vibe']);
const TOP = Object.freeze(['claude','codex','kimi','vibe','mimo','deepseek']);
const channelFor = id => catalog.channels.find(c => c.id === (API[id]?.channel || id));
const keyNames = id => { if (id === 'vibe') return ['MISTRAL_API_KEY']; if (id === 'qwen') return ['DASHSCOPE_API_KEY']; const k = channelFor(id)?.key; return k ? [k.env, ...(k.aliases || []).map(a => a.name)] : []; };
const envValue = (env, name) => env[Object.keys(env).find(k => k.toLowerCase() === name.toLowerCase())];

function childEnv(env, values) {
  const names = Object.keys(values).map(name => name.toLowerCase());
  return { ...Object.fromEntries(Object.entries(env).filter(([name]) => !names.includes(name.toLowerCase()))), ...values };
}

function nativeModel(id, model) {
  if (typeof model !== 'string' || !model.startsWith(`${id}/`)) return null;
  const native = model.slice(id.length + 1);
  return access.modelName(native) && native.split('/').every(segment => access.modelName(segment)) ? native : null;
}

// ACCESS-INVENTORY refreshes PATH. Refresh only catalog key names from the OS too:
// an editor started before the key was added must not require a restart or a file.
function machineEnv(env = process.env, platform = process.platform, spawn = spawnSync) {
  const names = [...new Set(CLIENTS.flatMap(keyNames))];
  return access.registryKeyEnv(env, names, platform, spawn);
}

// Vibe owns this config format and home override. Never replace an existing
// profile or write credentials; wx also preserves a concurrent creator's file.
function bootstrapVibe(env, home = os.homedir(), io = fs) {
  let configHome = envValue(env, 'VIBE_HOME') || path.join(home, '.vibe');
  if (configHome === '~' || /^~[\\/]/.test(configHome)) configHome = path.join(home, configHome.slice(2));
  configHome = path.resolve(configHome);
  const config = 'active_model = "glm-5-3"\n\n[[models]]\nalias = "glm-5-3"\nprovider = "mistral"\nname = "zai-glm-5-3"\n';
  try {
    io.mkdirSync(configHome, { recursive: true });
    try { io.writeFileSync(path.join(configHome, 'config.toml'), config, { encoding:'utf8', flag:'wx', mode:0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  } catch { throw Error('vibe-bootstrap-unavailable'); }
  const key = envValue(env, 'MISTRAL_API_KEY');
  return childEnv(env, { VIBE_HOME:configHome, ...(key ? { MISTRAL_API_KEY:key } : {}) });
}

function resolveClient(id, env, platform = process.platform, home = os.homedir(), io = access) {
  const found = access.resolve(id, env, platform, home, io);
  if (found || id !== 'mimo') return found;
  // The MiMo npm launcher is a Node script without an extension. Resolve the
  // installed native package rather than running a shell or accepting arbitrary scripts.
  for (const dir of String(envValue(env, 'PATH') || '').split(platform === 'win32' ? ';' : path.delimiter)) {
    const shim = path.join(dir, platform === 'win32' ? 'mimo.cmd' : 'mimo');
    const entry = io.file(shim) && access.npmTarget(shim, io);
    if (!entry || !io.read(entry).startsWith('#!/usr/bin/env node')) continue;
    const base = path.resolve(path.dirname(entry), '..', 'node_modules', "@mimo-ai");
    for (const pkg of [`mimocode-${platform === 'win32' ? 'windows' : platform}-${os.arch()}-baseline`, `mimocode-${platform === 'win32' ? 'windows' : platform}-${os.arch()}`]) {
      const native = path.join(base, pkg, 'bin', platform === 'win32' ? 'mimo.exe' : 'mimo');
      if (io.file(native)) return { path: shim, file: native, prefix: [] };
    }
    const cached = path.join(path.dirname(entry), '.mimocode');
    if (io.file(cached)) return { path: shim, file: cached, prefix: [] };
  }
  return null;
}

function detect(id, deps = {}) {
  if (!CLIENTS.includes(id)) throw Error('unknown-route');
  const env = deps.env || machineEnv(), home = deps.home || os.homedir(), platform = deps.platform || process.platform;
  const harness = API[id] ? 'kilo' : id;
  const resolved = (deps.resolve || resolveClient)(harness, env, platform, home, deps.io || access);
  const present = keyNames(id).some(n => !!envValue(env, n));
  const base = { id, kind: API[id] ? 'API/aggregator' : 'agent CLI', harness, installed: !!resolved, key: present ? 'present' : 'no key', status: 'ready', action: null };
  if (id === 'ollama') return { ...base, status: 'detection-only', action: 'Local model launches are deferred until after 2.0.1.' };
  const question = BLOCKED[id] || API[id]?.question;
  if (question) return { ...base, status: 'BLOCKED-ON-OWNER', action: question };
  if (API[id] && !present) return { ...base, status: 'no key', action: `Set ${keyNames(id)[0]} in the OS environment, then retry.` };
  if (!resolved) return { ...base, status: 'not installed', action: `Install ${harness}, then retry.` };
  if (id === 'qwen' && !present) return { ...base, status: 'no key', action: 'Set DASHSCOPE_API_KEY in the OS environment, then retry.' };
  if (!API[id]) {
    const login = (deps.login || access.login)(id, args => access.execute(resolved,args,env,process.cwd()), home, deps.io || access, Date.now(), false);
    base.login = login.state;
    if (login.state === 'not-logged-in') return { ...base, status: 'no key', action: `Sign in with ${id} login, then retry.` };
    if (id === 'kimi') {
      const check = require('../../docs/ops/kimi-route.cjs').check({ model: 'kimi-code/k3', env, osHome: home });
      if (!check.ok) return { ...base, status: 'no key', action: 'Sign in with kimi first, then retry.' };
    }
  }
  return base;
}

function routeFor(id, model, deps = {}) {
  const env = deps.env || machineEnv();
  const detected = detect(id, { ...deps, env });
  if (detected.status !== 'ready') return { ok: false, ...detected };
  const r = (deps.resolve || resolveClient)(detected.harness, env, deps.platform || process.platform, deps.home || os.homedir(), deps.io || access);
  if (!r || r.prefix.length > 1) return { ok: false, ...detected, status: 'not installed' };
  return { ok: true, route: { client: id, model, transport: `cli-${detected.harness}-${id}`, executable: r.file, ...(r.prefix.length ? { entry: r.prefix[0] } : {}) } };
}

function apiEnvironment(id, model, env) {
  if (!API[id]?.base) throw Error('BLOCKED-ON-OWNER');
  const native = nativeModel(id, model);
  if (!native) throw Error('provider-model-required');
  const names = keyNames(id), selected = names.find(n => !!envValue(env, n));
  if (!selected) throw Error('no key');
  const canonical = names[0];
  const config = { enabled_providers: [id], provider: { [id]: { npm: "@ai-sdk/openai-compatible", models: { [native]: { name: native } }, options: { baseURL: API[id].base, apiKey: `{env:${canonical}}` } } } };
  return childEnv(env, { [canonical]: envValue(env, selected), KILO_CONFIG_CONTENT: JSON.stringify(config) });
}

if (require.main === module) {
  try {
    const env = machineEnv();
    if (process.argv.length !== 2) throw Error('usage: node tools/operator/routes.cjs');
    for (const id of CLIENTS) process.stdout.write(JSON.stringify(detect(id, { env })) + '\n');
  } catch { process.stderr.write('Route inventory unavailable; check OS environment access.\n'); process.exitCode = 2; }
}
module.exports = { CLIENTS, TOP, API, BLOCKED, keyNames, envValue, nativeModel, machineEnv, bootstrapVibe, resolveClient, detect, routeFor, apiEnvironment };

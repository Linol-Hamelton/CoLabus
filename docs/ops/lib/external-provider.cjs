'use strict';
// No live provider is admitted. Only reviewed table entries may select an endpoint.
const fs = require('node:fs');
const path = require('node:path');
const ROUTES = Object.freeze(Object.create(null));
const ID = /^[a-z][a-z0-9-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/;
const KEYS = ['model', 'baseURL', 'keyEnv', 'billing', 'roles', 'context', 'output', 'budget', 'admission'];
const refused = reason => ({ ok: false, reason });
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const exact = (x, keys) => object(x) && Object.keys(x).length === keys.length && keys.every(k => Object.hasOwn(x, k));
const date = x => typeof x === 'string' && /^\d{4}-\d\d-\d\dT\d\d[:]\d\d[:]\d\d\.\d{3}Z$/.test(x) && Number.isFinite(Date.parse(x)) && new Date(x).toISOString() === x && Date.parse(x) <= Date.now();
const positive = x => Number.isSafeInteger(x) && x > 0;
const evidence = x => typeof x === 'string' && /^docs\/(?:[A-Za-z0-9_][A-Za-z0-9._-]*\/)*[A-Za-z0-9_][A-Za-z0-9._-]*\.md$/.test(x);
function source(x) {
  if (!exact(x, ['tokens', 'url', 'readAt']) || !positive(x.tokens) || !date(x.readAt)) return false;
  try { const u = new URL(x.url); return typeof x.url === 'string' && u.href === x.url && u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash; } catch { return false; }
}
function readRoute({ routeId, role = 'probe', env = process.env, table = ROUTES }) {
  if (typeof routeId !== 'string' || /\s/.test(routeId) || !ID.test(routeId) || !object(table) || !Object.hasOwn(table, routeId)) return refused('ROUTE_UNKNOWN');
  const r = table[routeId];
  if (!exact(r, KEYS) || typeof r.model !== 'string' || /\s/.test(r.model) || !MODEL.test(r.model) || typeof r.keyEnv !== 'string' || /\s/.test(r.keyEnv) || !/^[A-Z][A-Z0-9_]{0,79}_KEY$/.test(r.keyEnv) || !['paid-api', 'free', 'free-nim'].includes(r.billing)) return refused('ROUTE_INVALID');
  try {
    const u = new URL(r.baseURL);
    if ((u.protocol !== 'https:' && !(u.protocol === 'http:' && u.hostname === '127.0.0.1' && u.port)) || u.username || u.password || u.search || u.hash || u.href.replace(/\/$/, '') !== r.baseURL.replace(/\/$/, '')) return refused('ROUTE_INVALID');
  } catch { return refused('ROUTE_INVALID'); }
  if (!Array.isArray(r.roles) || !r.roles.length || new Set(r.roles).size !== r.roles.length || r.roles.some(x => !['author', 'fixer', 'pre-review'].includes(x))) return refused('ROUTE_INVALID');
  if (r.billing !== 'paid-api' && r.roles.some(x => x !== 'pre-review')) return refused('ROUTE_ROLE_REFUSED');
  if (role !== 'probe' && !r.roles.includes(role)) return refused(role === 'fixer' ? 'NOT_A_FIXER_ROUTE' : 'ROUTE_ROLE_REFUSED');
  if (!source(r.context) || !source(r.output)) return refused('WINDOW_UNSOURCED');
  const b = r.budget;
  if (!exact(b, ['baseTokens', 'reserveTokens', 'marginTokens', 'outputTokens', 'measuredAt', 'evidence']) || !positive(b.baseTokens) || !positive(b.reserveTokens) || !positive(b.marginTokens) || !positive(b.outputTokens) || !date(b.measuredAt) || !evidence(b.evidence)) return refused('WINDOW_UNSOURCED');
  const total = b.baseTokens + b.reserveTokens + b.marginTokens + b.outputTokens;
  if (!Number.isSafeInteger(total) || b.outputTokens > r.output.tokens || total > r.context.tokens) return refused('WINDOW_TOO_SMALL');
  const a = r.admission;
  if (!exact(a, ['state', 'by', 'at', 'evidence']) || !['candidate', 'admitted'].includes(a.state)) return refused('ROUTE_INVALID');
  if (a.state === 'candidate' ? a.by !== null || a.at !== null || a.evidence !== null : !/^[A-Za-z][A-Za-z0-9-]{0,79}$/.test(a.by) || !date(a.at) || !evidence(a.evidence)) return refused('ROUTE_INVALID');
  if (role !== 'probe' && a.state !== 'admitted') return refused('ROUTE_NOT_ADMITTED');
  const names = Object.keys(env).filter(k => k.toUpperCase() === r.keyEnv);
  if (names.length !== 1 || typeof env[names[0]] !== 'string' || !/^[A-Za-z0-9._~+/=-]+$/.test(env[names[0]]) || /\s/.test(env[names[0]])) return refused('AUTH_FAILED');
  return { ok: true, route: structuredClone(r) };
}
function buildKiloRoute({ routeId, workDir, configDir = workDir, role = 'probe', env = process.env, io = fs, table = ROUTES }) {
  const checked = readRoute({ routeId, role, env, table });
  if (!checked.ok) return checked;
  const r = checked.route;
  const config = {
    enabled_providers: ['external'], model: `external/${routeId}`,
    provider: { external: { npm: "@ai-sdk/openai-compatible", options: { baseURL: r.baseURL, apiKey: `{env:${r.keyEnv}}` },
      models: { [routeId]: { id: r.model, name: r.model, limit: { context: r.context.tokens, output: r.budget.outputTokens } } } } },
    tools: { schedule_wakeup: false },
  };
  try {
    for (const dir of [workDir, configDir]) if (!path.isAbsolute(dir) || io.realpathSync(dir) !== path.resolve(dir) || !io.lstatSync(dir).isDirectory() || io.lstatSync(dir).isSymbolicLink()) return refused('AUTH_FAILED');
    // Exclusive creation refuses old config, links and parallel attempts. Never overwrite user settings.
    io.writeFileSync(path.join(configDir, 'kilo.json'), JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch { return refused('AUTH_FAILED'); }
  const childEnv = Object.fromEntries(Object.entries(env).filter(([k]) => !k.toUpperCase().startsWith('KILO_') && k.toUpperCase() !== r.keyEnv));
  const name = Object.keys(env).find(k => k.toUpperCase() === r.keyEnv);
  return { ok: true, keyEnv: r.keyEnv, model: `external/${routeId}`, env: { ...childEnv, [r.keyEnv]: env[name], KILO_CONFIG: path.join(configDir, 'kilo.json'), KILO_CONFIG_CONTENT: JSON.stringify(config) } };
}
// Both probe and seat use this builder; it never starts a process or falls back to a user route.
function buildInvocation({ routeId, workDir, configDir, role, prompt, env, io, table }) {
  const route = buildKiloRoute({ routeId, workDir, configDir, role, env, io, table });
  if (!route.ok) return route;
  return { ok: true, keyEnv: route.keyEnv, command: 'kilo', args: ['run', '-m', route.model, '--auto', '--dir', workDir, prompt], spawnOptions: { cwd: workDir, env: route.env, encoding: 'buffer', shell: false, windowsVerbatimArguments: false } };
}
// Provider errors may echo the credential. Mask bytes before any call-file or derivation sees them.
function maskResult(result, env, keyEnv) {
  const key = env[keyEnv];
  if (typeof key !== 'string' || !key) return { status: null, stdout: null, stderr: null, error: { code: 'AUTH_FAILED' } };
  const variants = [...new Set([key, JSON.stringify(key).slice(1, -1), Buffer.from(key).toString('base64'), Buffer.from(key).toString('base64url'), encodeURIComponent(key), encodeURIComponent(key).replace(/%[0-9A-F]{2}/g, x => x.toLowerCase())])].sort((a, b) => b.length - a.length).map(x => Buffer.from(x));
  const mask = input => {
    if (input === null || input === undefined) return input;
    const bytes = Buffer.from(input), parts = [];
    let start = 0;
    while (start < bytes.length) {
      let index = -1, needle;
      for (const candidate of variants) {
        const hit = bytes.indexOf(candidate, start);
        if (hit >= 0 && (index < 0 || hit < index)) { index = hit; needle = candidate; }
      }
      if (index < 0) break;
      parts.push(bytes.subarray(start, index), Buffer.from('[REDACTED]')); start = index + needle.length;
    }
    parts.push(bytes.subarray(start)); return Buffer.concat(parts);
  };
  return { status: result.status, signal: result.signal, pid: result.pid, stdout: mask(result.stdout), stderr: mask(result.stderr), ...(result.error ? { error: { code: result.error.code === 'ETIMEDOUT' ? 'ETIMEDOUT' : 'SPAWN_FAILED' } } : {}) };
}
module.exports = { ROUTES, readRoute, buildKiloRoute, buildInvocation, maskResult };

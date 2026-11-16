'use strict';
// Client summaries omit raw banners and credentials; OS environment refresh stays in memory.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const list = dir => { try { return fs.readdirSync(dir); } catch { return []; } };
const file = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const json = text => { try { return JSON.parse(text); } catch { return null; } };
const modelName = s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(s) && !/sk-|eyJ|token|secret/i.test(s) && !/[A-Za-z0-9_-]{40}/.test(s) ? s : null;
const models = text => [...new Set(String(text).split(/\r?\n/).map(s => modelName(s.trim())).filter(Boolean))].sort();

function registryEnv(env, platform, spawn = spawnSync) {
  const copy = { ...env, NO_COLOR: '1' };
  if (platform !== 'win32') return copy;
  if (typeof env.SystemRoot !== 'string' || !path.isAbsolute(env.SystemRoot)) throw new Error('REGISTRY_PATH_UNAVAILABLE');
  const ps = path.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const r = spawn(ps, ['-NoProfile', '-NonInteractive', '-Command', "[Console]::OutputEncoding=[Text.Encoding]::UTF8; [Environment]::GetEnvironmentVariable('Path','Machine')+';'+[Environment]::GetEnvironmentVariable('Path','User')"], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  if (r.status !== 0 || !String(r.stdout || '').trim()) throw new Error('REGISTRY_PATH_UNAVAILABLE');
  // Windows environment names are case insensitive; do not keep an older Path alongside PATH.
  for (const key of Object.keys(copy)) if (key.toLowerCase() === 'path') delete copy[key];
  copy.PATH = String(r.stdout).trim();
  return copy;
}

// Fixed OS metadata query only. Catalog variable names cannot inject PowerShell.
function registryKeyEnv(env, names, platform, spawn = spawnSync) {
  if (!Array.isArray(names) || names.some(n => typeof n !== 'string' || !/^[A-Z][A-Z0-9_]{0,79}$/.test(n))) throw Error('KEY_ENV_NAME_INVALID');
  const out = registryEnv(env, platform, spawn);
  if (platform !== 'win32' || !names.length) return out;
  const script = `[Console]::OutputEncoding=[Text.Encoding]::UTF8; $r=@{}; foreach($n in @(${names.map(n => `'${n}'`).join(',')})) { $v=[Environment]::GetEnvironmentVariable($n,'User'); if(-not $v){$v=[Environment]::GetEnvironmentVariable($n,'Machine')}; if($v){$r[$n]=$v} }; ConvertTo-Json -InputObject $r -Compress`;
  const r = spawn(path.join(env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile','-NonInteractive','-Command',script], { encoding: 'utf8', timeout: 20000, windowsHide: true });
  const values = r.status === 0 ? json(r.stdout) : null;
  if (!values || typeof values !== 'object' || Array.isArray(values)) throw Error('KEY_ENV_UNAVAILABLE');
  for (const name of names) if (typeof values[name] === 'string' && values[name]) {
    for (const k of Object.keys(out)) if (k.toLowerCase() === name.toLowerCase()) delete out[k];
    out[name] = values[name];
  }
  return out;
}

function npmTarget(shim, io = { read, file }) {
  const matches = [...io.read(shim).matchAll(/"%dp0%\\([^"\r\n]+)"\s+%\*/g)];
  if (matches.length !== 1) return null;
  const dir = path.dirname(shim), target = path.resolve(dir, matches[0][1]);
  const relative = path.relative(dir, target);
  if (relative.startsWith('..') || path.isAbsolute(relative) || !io.file(target)) return null;
  return target;
}

function resolve(name, env, platform, home, io = { read, file, list }) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) return null;
  const dirs = String(env.PATH || env.Path || '').split(platform === 'win32' ? ';' : path.delimiter).filter(Boolean);
  const candidates = dirs.flatMap(d => (platform === 'win32' ? ['.exe', '.cmd'] : ['']).map(ext => path.join(d.replace(/^"|"$/g, ''), name + ext)));
  if (name === 'kilo') {
    for (const base of ['.vscode/extensions', '.vscode-insiders/extensions']) {
      const dir = path.join(home, base);
      for (const ext of io.list(dir).filter(n => /^kilocode\./i.test(n)).sort().reverse()) {
        candidates.push(path.join(dir, ext, 'bin', platform === 'win32' ? 'kilo.exe' : 'kilo'));
      }
    }
  }
  for (const candidate of candidates) {
    if (!io.file(candidate)) continue;
    if (name === 'copilot' && /[\\/]extensions[\\/].*copilot|[\\/]github\.copilot[^\\/]*[\\/]/i.test(candidate)) continue;
    if (/\.cmd$/i.test(candidate)) {
      const target = npmTarget(candidate, io);
      if (target && /\.exe$/i.test(target)) return { path: candidate, file: target, prefix: [] };
      if (target && /\.[cm]?js$/i.test(target)) return { path: candidate, file: process.execPath, prefix: [target] };
    } else return { path: candidate, file: candidate, prefix: [] };
  }
  return null;
}

function execute(resolved, args, env, cwd, spawn = spawnSync, timeout = 30000, binary = false) {
  if (!resolved) return { status: null, stdout: '', stderr: '', error: { code: 'ENOENT' } };
  try { return spawn(resolved.file, [...resolved.prefix, ...args], { cwd, env, shell: false, windowsHide: true, encoding: binary ? null : 'utf8', timeout, maxBuffer: 8 * 1024 * 1024 }); }
  catch { return { status: null, error: { code: 'SPAWN_FAILED' } }; }
}

function version(result) {
  const text = `${result.stdout || ''}\n${result.stderr || ''}`;
  if (result.error || result.status !== 0 || /was not found|not installed|cannot find/i.test(text)) return null;
  return /\bv?(\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.]+)?)\b/.exec(text)?.[1] || null;
}

function login(id, run, home, io = { read, list, file }, now = Date.now(), network = true) {
  const unknown = { state: 'unknown', source: 'no-safe-check' };
  if (id === 'claude') {
    const r = run(['auth', 'status']), j = json(r.stdout);
    if (r.error || r.status !== 0 || typeof j?.loggedIn !== 'boolean') return unknown;
    return { state: j.loggedIn ? 'logged-in' : 'not-logged-in', source: 'claude-auth-status', subscription: ['free', 'pro', 'max', 'team', 'enterprise'].includes(j.subscriptionType) ? j.subscriptionType : null };
  }
  if (id === 'codex') {
    const r = run(['login', 'status']), s = `${r.stdout || ''}\n${r.stderr || ''}`;
    return { state: /not logged in/i.test(s) ? 'not-logged-in' : !r.error && r.status === 0 && /logged in/i.test(s) ? 'logged-in' : 'unknown', source: 'codex-login-status' };
  }
  if (id === 'mimo' && network) {
    const r = run(['auth', 'whoami']);
    return { state: /not logged in|unauthorized/i.test(`${r.stdout || ''}${r.stderr || ''}`) ? 'not-logged-in' : !r.error && r.status === 0 && /^\s*Provider:\s*\S+/mi.test(r.stdout || '') ? 'logged-in' : 'unknown', source: 'mimo-auth-whoami' };
  }
  if (id === 'vibe') {
    const j = json(io.read(path.join(home, '.vibe/whoami_cache.json')));
    const entries = Object.values(j || {}).filter(e => e?.payload && Number.isFinite(e.stored_at_timestamp));
    const e = entries.sort((a, b) => b.stored_at_timestamp - a.stored_at_timestamp)[0];
    if (e && e.stored_at_timestamp * 1000 <= now) return { state: 'cached', source: 'vibe-plan-cache', cachedAt: new Date(e.stored_at_timestamp * 1000).toISOString(), subscription: ['free', 'pro', 'team', 'enterprise'].includes(e.payload.plan_type) ? e.payload.plan_type : null };
  }
  if (id === 'kimi') return { state: 'unknown', source: io.list(path.join(home, '.kimi-code/credentials')).length ? 'credential-file-present' : 'credential-file-absent' };
  return unknown;
}

function configuredModels(id, home, io = { read }) {
  const rel = id === 'kimi' ? '.kimi-code/config.toml' : id === 'vibe' ? '.vibe/config.toml' : null;
  if (!rel) return [];
  const text = io.read(path.join(home, rel));
  const found = new Set();
  let modelSection = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) modelSection = /^\s*\[\[?models(?:\.[^\]]+)?\]\]?\s*(?:#.*)?$/.test(line);
    const alias = id === 'kimi' && /^\s*\[models\.(?:"([^"]+)"|([A-Za-z0-9._:/-]+))\]\s*(?:#.*)?$/.exec(line);
    if (alias && modelName(alias[1] || alias[2])) found.add(alias[1] || alias[2]);
    const m = /^\s*(default_model|active_model|model|name)\s*=\s*"([^"\r\n]+)"/.exec(line);
    if (m && (m[1] !== 'name' || modelSection) && modelName(m[2])) found.add(m[2]);
  }
  return [...found].sort();
}

module.exports = { read, list, file, json, modelName, models, registryEnv, registryKeyEnv, npmTarget, resolve, execute, version, login, configuredModels };

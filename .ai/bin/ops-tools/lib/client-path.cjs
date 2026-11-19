'use strict';
// Client PATH resolution for a process started before an install. A long-lived operator
// shell keeps the PATH it was born with; a client installed afterwards is invisible to it.
// On Windows the machine and user Path values are read from the registry (never by
// running a shell) and merged in front of the inherited PATH for the children of this
// process only. The machine PATH is never changed. Only the location is resolved here;
// no client is ever started by this module.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const USER_KEY = 'HKCU\\Environment';
const MACHINE_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment';
const CLIENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const VALUE_LINE = /^\s*Path\s+REG_(?:EXPAND_)?SZ\s+(.*)$/i;

function expand(value, env) {
  const folded = new Map(Object.entries(env || {}).map(([k, v]) => [k.toLowerCase(), v]));
  return String(value).replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name) => {
    const hit = folded.get(name.toLowerCase());
    return typeof hit === 'string' ? hit : whole;
  });
}
function splitPath(value, platform) {
  if (typeof value !== 'string' || !value) return [];
  return value.split(platform === 'win32' ? ';' : ':').map(s => s.trim()).filter(Boolean);
}
function parseRegQuery(text) {
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = VALUE_LINE.exec(line);
    if (m) return m[1].trim();
  }
  return null;
}

// Read both registry Path values. A missing or unreadable value is a problem line, never a
// silent empty PATH: the caller still has the inherited PATH.
function registryEntries(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'win32') return { entries: [], problems: [] };
  const run = options.run || ((command, args, opts) => spawnSync(command, args, opts));
  const env = options.env || process.env;
  const entries = [];
  const problems = [];
  for (const [label, key] of [['machine', MACHINE_KEY], ['user', USER_KEY]]) {
    let r;
    try { r = run('reg', ['query', key, '/v', 'Path'], { encoding: 'utf8', windowsHide: true, timeout: 15000 }); }
    catch (e) { problems.push(`${label}: ${e && e.code ? e.code : 'reg query failed'}`); continue; }
    if (!r || r.error || r.status !== 0) { problems.push(`${label}: ${r && r.error ? r.error.code : `exit ${r && r.status}`}`); continue; }
    const raw = parseRegQuery(r.stdout);
    if (raw === null) { problems.push(`${label}: no Path value in the registry answer`); continue; }
    const value = expand(raw, env);
    entries.push(...splitPath(value, platform));
  }
  return { entries, problems };
}

// The inherited PATH plus the registry entries, registry first so a client installed after
// this process started is found. Case-insensitive de-duplication is right on Windows.
function effectivePath(options = {}) {
  const platform = options.platform || process.platform;
  const entries = options.entries || [];
  const inherited = splitPath(options.processPath === undefined ? process.env.PATH : options.processPath, platform);
  const seen = new Set();
  const out = [];
  for (const entry of [...entries, ...inherited]) {
    const key = platform === 'win32' ? entry.toLowerCase() : entry;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(entry);
  }
  return out.join(platform === 'win32' ? ';' : ':');
}

// Locate a client executable on the effective PATH. A native .exe is preferred; a .cmd,
// .bat or .ps1 shim is reported as a shim and is never spawned by this tool.
function findClient(name, options = {}) {
  if (typeof name !== 'string' || !CLIENT_NAME.test(name)) throw Object.assign(new Error(`CLIENT-NAME-INVALID: ${String(name)}`), { code: 'CLIENT-NAME-INVALID' });
  const platform = options.platform || process.platform;
  const entries = splitPath(options.pathValue || '', platform);
  const exists = options.exists || (file => fs.existsSync(file));
  const suffix = platform === 'win32' ? ['.exe', '.cmd', '.bat', '.ps1', ''] : [''];
  for (const ext of suffix) {
    for (const dir of entries) {
      const file = path.join(dir, `${name}${ext}`);
      if (!exists(file)) continue;
      return { found: true, path: file, shim: ['.cmd', '.bat', '.ps1'].includes(ext), searched: entries.length };
    }
  }
  return { found: false, path: null, shim: false, searched: entries.length };
}

// One call for a launcher: registry entries, the merged PATH and the client location.
function resolveClient(name, options = {}) {
  const platform = options.platform || process.platform;
  const registry = registryEntries({ ...options, platform });
  const pathValue = effectivePath({ platform, entries: registry.entries, processPath: options.processPath === undefined ? process.env.PATH : options.processPath });
  return { pathValue, problems: registry.problems, client: findClient(name, { ...options, platform, pathValue }) };
}

module.exports = { USER_KEY, MACHINE_KEY, expand, splitPath, parseRegQuery, registryEntries, effectivePath, findClient, resolveClient };

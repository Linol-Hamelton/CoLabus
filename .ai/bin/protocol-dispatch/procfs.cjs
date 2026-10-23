'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync, execFileSync } = require('node:child_process');

const JOURNAL_RE = /^\.ai\/worklog\/[a-z][a-z0-9]*-[0-9a-f]{16}\.md$/;

const SAFE_CMD = /^[^%^&|<>']*$/;

const POINTER_PREFIX = 'Read and follow the file ';

function makePointer(target) {
  return `${POINTER_PREFIX}${target.replace(/\\/g, '/')}`;
}

const CRED_ENV_KEYS = ['GH_TOKEN', 'GITHUB_TOKEN', 'GIT_ASKPASS', 'SSH_ASKPASS', 'SSH_AUTH_SOCK'];

const CRED_ENV_SUFFIX = /_(TOKEN|PAT)$/;

const CRED_ENV_NAME = /(^|_)(GH|GITHUB|GIT)(_|$)/;

function getRepoRoot(opts = {}) {
  return opts.repoRoot || process.env.PROTOCOL_REPO_ROOT || process.cwd();
}

let HOOKS_ROOT = null;
let EMPTY_CONFIG_ID = null;

function hooksRoot() {
  if (!HOOKS_ROOT) {
    HOOKS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'colabs-hooks-'));
    const dir = HOOKS_ROOT; const original = fs.lstatSync(dir, { bigint: true }); const real = fs.realpathSync.native(dir);
    process.once('exit', () => {
      try {
        const st = fs.lstatSync(dir, { bigint: true });
        if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== original.dev || st.ino !== original.ino || fs.realpathSync.native(dir) !== real) return;
        if (EMPTY_CONFIG_ID) {
          const file = path.join(dir, 'empty-gitconfig'); const f = fs.lstatSync(file, { bigint: true });
          if (f.isFile() && f.nlink === 1n && f.dev === EMPTY_CONFIG_ID.dev && f.ino === EMPTY_CONFIG_ID.ino) fs.unlinkSync(file);
        }
        fs.rmdirSync(dir); // unknown entries stay; no recursion or link traversal
      } catch { /* killed/busy/replaced: retention is the safety net */ }
    });
  }
  return HOOKS_ROOT;
}

function noHooksPath() {
  return path.join(hooksRoot(), `none-${crypto.randomBytes(8).toString('hex')}`);
}

function gitOpts() {
  return ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${noHooksPath()}`];
}

function git(args, cwd = process.cwd(), opts = {}) {
  return spawnSync('git', [...gitOpts(), ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 1 << 26,
    ...opts
  });
}

function gitIn(dir, args, opts = {}) {
  return git(args, dir, opts);
}

let EMPTY_GLOBAL_CONFIG = null;

function emptyGlobalConfig() {
  if (!EMPTY_GLOBAL_CONFIG) {
    EMPTY_GLOBAL_CONFIG = path.join(hooksRoot(), 'empty-gitconfig');
    fs.writeFileSync(EMPTY_GLOBAL_CONFIG, '');
    EMPTY_CONFIG_ID = fs.lstatSync(EMPTY_GLOBAL_CONFIG, { bigint: true });
  }
  return EMPTY_GLOBAL_CONFIG;
}

function gitEnv() {
  const env = { ...process.env };
  env.GIT_CONFIG_GLOBAL = emptyGlobalConfig();
  env.GIT_CONFIG_SYSTEM = emptyGlobalConfig();
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}

function executorEnv(parentEnv = process.env) {
  const env = { ...parentEnv };
  for (const k of Object.keys(env)) {
    if (CRED_ENV_KEYS.includes(k) || CRED_ENV_SUFFIX.test(k) || CRED_ENV_NAME.test(k)) {
      delete env[k];
    }
  }
  env.GIT_CONFIG_GLOBAL = emptyGlobalConfig();
  env.GIT_CONFIG_SYSTEM = emptyGlobalConfig();
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}

// Launch isolation (the dispatch path): a client's environment overlay names (TEMP, npm_config_cache, ...)
// replace EVERY case variant of the same name in the base first. Windows treats the names case-insensitively, so a parent
// NPM_CONFIG_CACHE would otherwise coexist with the client's npm_config_cache and the child would read the parent's value.
function overlayClientEnv(baseEnv, clientEnv) {
  const env = { ...baseEnv };
  if (clientEnv) {
    const incoming = new Set(Object.keys(clientEnv).map(k => String(k).toLowerCase()));
    for (const k of Object.keys(env)) if (incoming.has(k.toLowerCase())) delete env[k];
    Object.assign(env, clientEnv);
  }
  return env;
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function killExact(pid) {
  if (!pid) return;
  try {
    process.kill(pid, 'SIGKILL');
  } catch {}
}

function execText(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
    timeout: 30000,
    maxBuffer: 1 << 26
  });
}

const WIN_TIME = "$_.CreationDate.ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ', [cultureinfo]::InvariantCulture)";

function winRows(filter) {
  const select = filter ? ` -Filter '${filter}'` : '';
  const script = `Get-CimInstance Win32_Process${select} | ForEach-Object { if ($_.CreationDate) { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, ${WIN_TIME} } }`;
  return execText('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

function parseRows(text) {
  const out = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\s*$/.exec(line);
    if (m) out.push({ pid: Number(m[1]), ppid: Number(m[2]), createdAt: m[3] });
  }
  return out;
}

let CLK_TCK = null;

function clockTicks() {
  if (!CLK_TCK) {
    try { CLK_TCK = Number(execText('getconf', ['CLK_TCK']).trim()) || 100; } catch { CLK_TCK = 100; }
  }
  return CLK_TCK;
}

function linuxRow(pid, btimeMs) {
  try {
    const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = raw.slice(raw.lastIndexOf(')') + 2).split(' ');
    const ppid = Number(fields[1]);
    const startTicks = Number(fields[19]);
    if (!Number.isFinite(ppid) || !Number.isFinite(startTicks)) return null;
    return { pid, ppid, createdAt: new Date(btimeMs + Math.round((startTicks * 1000) / clockTicks())).toISOString() };
  } catch {
    return null;
  }
}

function linuxBootMs() {
  const m = /^btime\s+(\d+)/m.exec(fs.readFileSync('/proc/stat', 'utf8'));
  return m ? Number(m[1]) * 1000 : 0;
}

function psRows() {
  const out = [];
  const raw = execFileSync('ps', ['-axo', 'pid=,ppid=,lstart='], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    env: { ...process.env, LC_ALL: 'C' },
    timeout: 30000,
    maxBuffer: 1 << 26
  });
  for (const line of raw.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
    if (!m) continue;
    const ms = Date.parse(m[3]);
    if (Number.isNaN(ms)) continue;
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), createdAt: new Date(ms).toISOString() });
  }
  return out;
}

// Fresh process table: [{pid, ppid, createdAt}], createdAt ISO UTC with milliseconds. null when it cannot be read:
// an empty array means "no processes", which a readable table never is, and callers must not confuse the two.
function snapshotProcesses() {
  try {
    let rows;
    if (process.platform === 'win32') rows = parseRows(winRows(null));
    else if (process.platform === 'linux') {
      const btimeMs = linuxBootMs();
      rows = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(n => linuxRow(Number(n), btimeMs)).filter(Boolean);
    } else rows = psRows();
    // a readable table always holds at least this process; an empty parse is a failed read
    return rows.length ? rows : null;
  } catch {
    return null;
  }
}

// Identity of one process: {pid, createdAt} (PID alone is reused by the OS), null when it is not running.
function identityOf(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    let row = null;
    if (process.platform === 'win32') row = parseRows(winRows(`ProcessId=${pid}`))[0] || null;
    else if (process.platform === 'linux') row = linuxRow(pid, linuxBootMs());
    else row = psRows().find(p => p.pid === pid) || null;
    return row ? { pid: row.pid, createdAt: row.createdAt } : null;
  } catch {
    return null;
  }
}

function parsePorcelainZ(buf) {
  const entries = [];
  let i = 0;
  while (i < buf.length) {
    const nextZero = buf.indexOf(0, i);
    if (nextZero === -1) break;
    const header = buf.toString('utf8', i, nextZero);
    i = nextZero + 1;
    if (!header) continue;
    const code = header.substring(0, 2);
    let p = header.substring(3);
    if (code.startsWith('R') || code.startsWith('C')) {
      const origZero = buf.indexOf(0, i);
      if (origZero !== -1) {
        i = origZero + 1;
      }
    }
    entries.push({ code, path: p.replace(/\\/g, '/') });
  }
  return entries;
}

function gitProcessIn(dir, args) {
  return spawnSync('git', [...gitOpts(), ...args], {
    cwd: dir,
    windowsHide: true,
    maxBuffer: 1 << 26
  });
}

function readStateRetried(dir, retries = 3) {
  for (let attempt = 0; attempt < retries; attempt++) {
    const r = gitProcessIn(dir, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
    if (r.status === 0 && Buffer.isBuffer(r.stdout)) {
      return parsePorcelainZ(r.stdout);
    }
    const sleepMs = 50 * Math.pow(2, attempt);
    const end = Date.now() + sleepMs;
    while (Date.now() < end) {}
  }
  return null;
}

function checkCommand(cmdString) {
  if (!SAFE_CMD.test(cmdString)) {
    throw new Error(`unsafe characters in command string: ${cmdString}`);
  }
}

module.exports = {
  git,
  gitIn,
  gitEnv,
  gitOpts,
  executorEnv,
  overlayClientEnv,
  isPidAlive,
  killExact,
  snapshotProcesses,
  identityOf,
  parsePorcelainZ,
  gitProcessIn,
  readStateRetried,
  checkCommand,
  makePointer,
  getRepoRoot,
  JOURNAL_RE
};

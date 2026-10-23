'use strict';
// repo-paths: the default places the L4/L6 tooling of docs/ops reads and writes, derived from the repository these files live in
// (the main checkout of its git common dir, like launch-wrapper.cjs and ops-guard.cjs mainRoot), never from a fixed machine path.
// In the main checkout and in every worktree this resolves to the same absolute paths the tools used to hold as
// literals (absolute paths of one machine); in an installed project
// (docs/ops/pilot-install.cjs) it resolves to that project. Env overrides: OPS_RUNTIME_DIR, OPS_LAUNCH_PENDING_DIR.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { decode, parseJsonUnique } = require('./lib/text-safe.cjs');
const { readFileGuarded, realInside } = require('./lib/path-safe.cjs');

const FILE_REPO = path.resolve(__dirname, '..', '..');
const CATALOG_LAUNCHES = ['docs', 'product', 'launch-records', 'launches'];

function mainRoot(repo = FILE_REPO, env = process.env) {
  if (env && env.OPS_REPO_ROOT) return path.resolve(env.OPS_REPO_ROOT);
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8', windowsHide: true });
  const out = (r.stdout || '').trim();
  return r.status === 0 && out ? path.resolve(out, '..') : path.resolve(repo);
}

function runtimeDir(env = process.env, repo = FILE_REPO) {
  if (env && env.OPS_RUNTIME_DIR) return path.resolve(env.OPS_RUNTIME_DIR);
  // (no development alias for the runtime directory)
  return path.join(mainRoot(repo, env), '.ai', 'runtime');
}

function launchesDir(repo = FILE_REPO, env = process.env) {
  return path.join(mainRoot(repo, env), ...CATALOG_LAUNCHES);
}

function pendingDir(env = process.env, repo = FILE_REPO) {
  if (env && env.OPS_LAUNCH_PENDING_DIR) return path.resolve(env.OPS_LAUNCH_PENDING_DIR);
  // (no development alias for the pending launch directory)
  return path.join(launchesDir(repo, env), 'pending');
}

function worktreesDir(env = process.env, repo = FILE_REPO) {
  if (env && (env.OPS_WORKTREE_ROOT || env.OPS_WORKTREE_DIR)) {
    return path.resolve(env.OPS_WORKTREE_ROOT || env.OPS_WORKTREE_DIR);
  }
  return `${mainRoot(repo, env)}WT`;
}

function tempDir(env = process.env, repo = FILE_REPO) {
  if (env && (env.OPS_TEMP_ROOT || env.OPS_TEMP_DIR)) {
    return path.resolve(env.OPS_TEMP_ROOT || env.OPS_TEMP_DIR);
  }
  return `${mainRoot(repo,env)}Tmp`;
}

function archiveDir(env = process.env, repo = FILE_REPO) {
  if (env && (env.OPS_ARCHIVE_ROOT || env.OPS_ARCHIVE_DIR)) {
    return path.resolve(env.OPS_ARCHIVE_ROOT || env.OPS_ARCHIVE_DIR);
  }
  return `${mainRoot(repo,env)}Archive`;
}

function pilotsDir(env = process.env, repo = FILE_REPO) {
  if (env && (env.OPS_PILOTS_ROOT || env.OPS_PILOTS_DIR)) {
    return path.resolve(env.OPS_PILOTS_ROOT || env.OPS_PILOTS_DIR);
  }
  return `${mainRoot(repo,env)}Pilots`;
}

function clientPaths(env = process.env, repo = FILE_REPO) {
  const input = env && env.OPS_CLIENT_PATHS;
  let bytes;
  if (input !== undefined && input !== null) {
    if (typeof input !== 'string' || !input) throw new Error('INVALID_CLIENT_PATHS');
    if (input.startsWith('{') || input.startsWith('[') || input === 'null') bytes = Buffer.from(input);
    else bytes = readConfig(path.resolve(input),false);
  } else {
    bytes = readConfig(path.join(mainRoot(repo,env),'docs','ops','client-paths.json'),true);
    if (bytes === null) return {};
  }
  const decoded = decode(bytes,{bom:'strip',crlf:'normalise',invisible:'refuse'});
  if (!decoded.ok) throw new Error('INVALID_CLIENT_PATHS_TEXT');
  const map = parseJsonUnique(decoded.text);
  if (!map || Array.isArray(map) || typeof map !== 'object') throw new Error('INVALID_CLIENT_PATHS');
  for (const [key,value] of Object.entries(map)) {
    if (!/^[a-z0-9][a-z0-9_-]{0,79}$/.test(key) || typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('INVALID_CLIENT_PATHS');
  }
  return map;
}
function readConfig(file, optional) {
  const guard = realInside(path.parse(file).root,file,{refuseHardlinks:true});
  if (!guard.ok) throw new Error('CLIENT_PATHS_PATH_REFUSED');
  if (!guard.exists && optional) return null;
  const read = readFileGuarded(path.parse(file).root,file);
  if (!read.ok) throw new Error('CLIENT_PATHS_READ_REFUSED');
  return read.bytes;
}

// The launcher heartbeat is an operator-contour runtime helper (<runtime>/launcher-heartbeat.cjs, untracked). Where it exists it is
// used exactly as before; where it does not (an installed project) the launch goes on without a pulse and says so: the L4 liveness
// rule of `launch-wrapper --engine dispatch` is the supervision there.
function heartbeatFor(runtime, say = line => console.log(line)) {
  const file = path.join(runtime, 'launcher-heartbeat.cjs');
  if (fs.existsSync(file)) return require(file);
  say(`HEARTBEAT none: ${file} does not exist; the launch runs without a pulse daemon (use launch-wrapper --engine dispatch for liveness supervision)`);
  return { start: () => null, stop: () => {} };
}

module.exports = {
  FILE_REPO,
  mainRoot,
  runtimeDir,
  launchesDir,
  pendingDir,
  worktreesDir,
  tempDir,
  archiveDir,
  pilotsDir,
  clientPaths,
  heartbeatFor,
};

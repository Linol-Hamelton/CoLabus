'use strict';
// repo-paths: the default places the L4/L6 tooling of docs/ops reads and writes, derived from the repository these files live in
// (the main checkout of its git common dir, like launch-wrapper.cjs and ops-guard.cjs mainRoot), never from a fixed machine path.
// In the main checkout and in every worktree this resolves to the same absolute paths the tools used to hold as
// literals (absolute paths of one machine); in an installed project
// (docs/ops/pilot-install.cjs) it resolves to that project. Env overrides: OPS_RUNTIME_DIR, OPS_LAUNCH_PENDING_DIR.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const FILE_REPO = path.resolve(__dirname, '..', '..');
const CATALOG_LAUNCHES = ['docs', 'product', 'launch-records', 'launches'];

function mainRoot(repo = FILE_REPO) {
  const r = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: repo, encoding: 'utf8', windowsHide: true });
  const out = (r.stdout || '').trim();
  return r.status === 0 && out ? path.resolve(out, '..') : path.resolve(repo);
}

function runtimeDir(env = process.env, repo = FILE_REPO) {
  return env.OPS_RUNTIME_DIR ? path.resolve(env.OPS_RUNTIME_DIR) : path.join(mainRoot(repo), '.ai', 'runtime');
}

function launchesDir(repo = FILE_REPO) {
  return path.join(mainRoot(repo), ...CATALOG_LAUNCHES);
}

function pendingDir(env = process.env, repo = FILE_REPO) {
  return env.OPS_LAUNCH_PENDING_DIR ? path.resolve(env.OPS_LAUNCH_PENDING_DIR) : path.join(launchesDir(repo), 'pending');
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

module.exports = { FILE_REPO, mainRoot, runtimeDir, launchesDir, pendingDir, heartbeatFor };

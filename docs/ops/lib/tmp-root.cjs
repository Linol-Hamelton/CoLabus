'use strict';
// tmp-root: the one place that says which directory holds the per-launch temp dirs (layers 2 and 3).
// The launch wrapper creates <root>/<launch name> here; temp-retention allows exactly the same root, so a kept failed-launch dir is always
// reachable by the safety net. Node builtins only.
//   configuredTmpRoot(repo, env): COLABS_TMP_ROOT when set, else <drive of the repository>:/ColabsTmp (for example <drive>:/ColabsTmp); null when neither exists.
//   resolveTmpRoot(repo, env): the configured root when it is writable, else the OS temp dir.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function writableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.probe-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, '');
    fs.unlinkSync(probe);
    return true;
  } catch { return false; }
}

// Pure: <drive letter of the repository>:/ColabsTmp (for example <drive>:/ColabsTmp); null when the repository path has no drive letter.
function driveRootCandidate(repo) {
  const m = /^([A-Za-z]):[\\/]/.exec(path.resolve(repo));
  return m ? `${m[1].toUpperCase()}:/ColabsTmp` : null;
}

// Pure (no probe, no write): the root the wrapper would try first. `kind` says where it came from.
function configuredTmpRoot(repo, env = process.env) {
  if (env.COLABS_TMP_ROOT) return { dir: path.resolve(env.COLABS_TMP_ROOT), kind: 'colabs-tmp-root' };
  const candidate = repo ? driveRootCandidate(repo) : null;
  return candidate ? { dir: candidate, kind: 'drive-root' } : null;
}

function resolveTmpRoot(repo, env = process.env) {
  const configured = configuredTmpRoot(repo, env);
  if (configured && writableDir(configured.dir)) return configured;
  return { dir: os.tmpdir(), kind: 'os-temp' };
}

module.exports = { writableDir, driveRootCandidate, configuredTmpRoot, resolveTmpRoot };

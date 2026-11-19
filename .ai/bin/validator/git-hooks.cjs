'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

// Read-only Git queries never inherit command or repository redirection. Config
// inspection deliberately retains the user's system/global configuration files.
function gitRead(root, args) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^GIT_/i.test(key) && !/^GIT_CONFIG_(?:GLOBAL|SYSTEM|NOSYSTEM)$/i.test(key)) delete env[key];
  }
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  const result = spawnSync('git', ['-c', 'core.hooksPath=disabled', '-c', 'core.fsmonitor=false', '--no-pager', ...args], {
    cwd: root, env, windowsHide: true, encoding: 'utf8', timeout: 10000,
    maxBuffer: 16 * 1024 * 1024,
  });
  return { code: result.error || !Number.isInteger(result.status) ? -1 : result.status,
    output: result.stdout || '' };
}

// CM-80: planted Git config stops validation; planted hook files are advisory.
// Values and hook bodies never enter diagnostics and no hook is executed.
function checkGitHooks(root, gitUsable, report) {
  if (!gitUsable) return;
  // --get-all reads even shadowed values; a safe final override cannot hide a
  // hostile earlier scope. The command-line disabling value is excluded by
  // inspecting the persistent scopes separately, including worktree config.
  for (const scope of ['system', 'global', 'local', 'worktree']) {
    const got = gitRead(root, ['config', '--includes', `--${scope}`, '--null', '--get-all', 'core.hooksPath']);
    if (got.code === 0) {
      if (got.output.split('\0').some(value => value !== '')) {
        report('CM-80', 'FAIL', `GIT-HOOK-CONFIG: nonempty core.hooksPath in ${scope} configuration permits hook execution`);
      }
    } else if (got.code !== 1) {
      report('CM-80', 'WARN', `GIT-HOOK-UNAVAILABLE: cannot inspect ${scope} configuration`);
    }
  }
  const common = gitRead(root, ['rev-parse', '--git-common-dir']);
  if (common.code !== 0 || !common.output.trim()) {
    report('CM-80', 'WARN', 'GIT-HOOK-UNAVAILABLE: cannot resolve common hook directory');
    return;
  }
  const hooks = path.resolve(root, common.output.trim(), 'hooks');
  let entries;
  try { entries = fs.readdirSync(hooks, { withFileTypes: true }); } catch (error) {
    if (error.code !== 'ENOENT') report('CM-80', 'WARN', 'GIT-HOOK-UNAVAILABLE: cannot list common hook directory');
    return;
  }
  let count = 0;
  for (const entry of entries) {
    if (/\.sample$/i.test(entry.name) || entry.isDirectory()) continue;
    try {
      const stat = fs.lstatSync(path.join(hooks, entry.name));
      if (stat.isSymbolicLink() || (stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111)))) count++;
    } catch { count++; }
  }
  if (count) report('CM-80', 'WARN', `GIT-HOOK-FILE: ${count} executable non-sample hook(s) in common Git directory`);
}

module.exports = { gitRead, checkGitHooks };

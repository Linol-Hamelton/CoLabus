'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const hooks = require('../protocol-hooks.cjs');

const CHECK_TIMEOUT_MS = 900000;
const SUITE_TIMEOUT_MS = 1800000;

const CHECKS = [
  // The record path spawns the Node validator directly. Fixture fast checks
  // stub this same entry, preserving the subprocess boundary and its deadline.
  // The Evidence check name follows this row.
  { name: 'protocol-validate.cjs', quick: true },
  { name: 'protocol-test.cjs', quick: false },
];

function checksFor(root, quick) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'protocol-manifest.json'), 'utf8')); }
  catch (error) { throw new Error(`Cannot read protocol manifest: ${error.message}`); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('Protocol manifest must be a JSON object.');
  }
  // Older manifests had no role and shipped the source suite. Do not treat
  // that absence, an unknown role, or a missing script as an installed runtime.
  const role = Object.hasOwn(manifest, 'role') ? manifest.role : 'source';
  if (!['source', 'installed'].includes(role)) {
    throw new Error('Protocol manifest role must be source or installed.');
  }
  const checks = CHECKS.filter(check => (role !== 'installed' || check.quick) && (!quick || check.quick)).map(c => ({ ...c }));
  if (!quick && manifest.testCommand && typeof manifest.testCommand === 'string' && manifest.testCommand.trim()) {
    checks.push({ name: manifest.testCommand.trim(), quick: false, isCustom: true });
  }
  return checks;
}

function git(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 30000,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`git ${args[0]} failed: ${result.error?.message || (result.stderr || '').trim()}`);
  }
  return result.stdout;
}

// The anchor identifies the exact state the evidence describes. A commit alone
// is not enough: most protocol work is uncommitted when it is handed over.
function anchor(root) {
  let head = null;
  try {
    head = git(root, ['rev-parse', '--verify', '--quiet', 'HEAD']).trim() || null;
  } catch {
    head = null;
  }
  const files = hooks.snapshot(root);
  const names = Object.keys(files).sort();
  const hash = crypto.createHash('sha256');
  for (const name of names) {
    // snapshot() supplies the same Git content/mode identity before and after
    // staging. No separate index-state prefix needs stripping.
    hash.update(`${name}|${files[name]}|`);
  }
  const dirty = typeof files[hooks.DIRTY_SYMBOL] === 'boolean'
    ? files[hooks.DIRTY_SYMBOL]
    : git(root, ['status', '--porcelain', '-uall']).trim().length > 0;
  return {
    commit: head,
    dirty,
    fileCount: names.length,
    digest: `sha256:${hash.digest('hex')}`,
    format: hooks.SNAPSHOT_FORMAT,
  };
}

function powershell() {
  if (process.env.PROTOCOL_TEST_POWERSHELL) return process.env.PROTOCOL_TEST_POWERSHELL;
  return process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
}

function runCheck(root, check) {
  const started = Date.now();
  let result;
  let timeout = CHECK_TIMEOUT_MS;
  const env = check.quick ? { ...process.env, PROTOCOL_SKIP_GATE: '1' } : process.env;
  if (check.isCustom) {
    timeout = SUITE_TIMEOUT_MS;
    result = spawnSync(check.name, { cwd: root, shell: true, encoding: 'utf8', windowsHide: true, timeout, env });
  } else if (check.name === 'protocol-validate.cjs') {
    result = spawnSync(process.execPath,
      [path.join(root, '.ai', 'bin', check.name), '--root', root],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout, env });
  } else if (check.name === 'protocol-test.cjs') {
    timeout = SUITE_TIMEOUT_MS;
    result = spawnSync(process.execPath,
      [path.join(root, '.ai', 'bin', check.name), '--root', root],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout, env: { ...env, PROTOCOL_TEST_POWERSHELL: powershell() } });
  } else {
    // The suite entry remains a PowerShell script.
    result = spawnSync(powershell(),
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, check.name)],
      { cwd: root, encoding: 'utf8', windowsHide: true, timeout, env });
  }
  if (result.error) {
    const limit = result.error.code === 'ETIMEDOUT' ? ` (deadline ${timeout / 1000} s)` : '';
    throw new Error(`${check.name} could not run: ${result.error.message}${limit}`);
  }
  return { name: check.name, code: result.status, seconds: Math.round((Date.now() - started) / 1000), isCustom: Boolean(check.isCustom) };
}

module.exports = { anchor, git, checksFor, runCheck };

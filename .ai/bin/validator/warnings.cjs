'use strict';

// Reasoned, exact-class extension of the CM-70 path allowlists. Legacy
// encoding/advisory lists retain their narrow semantics; they cannot suppress
// CM-71. This source-local file also covers immutable owner-word diagnostics.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const FILE = '.ai/validator-warning-allowlist.json';
function fingerprint(d) {
  return crypto.createHash('sha256').update(d.message).digest('hex');
}
function warningClass(d) {
  if (d.id === 'CM-70') return /^CM-70 ([^:\r\n]+):/.exec(d.message)?.[1].trim() || null;
  if (d.id === 'CM-71') return 'owner-word-anchor';
  return null;
}

function applyWarningAllowlist(root, diagnostics) {
  const full = path.join(root, FILE);
  let policy;
  try { policy = JSON.parse(fs.readFileSync(full, 'utf8')); }
  catch (e) {
    if (e.code === 'ENOENT') return diagnostics;
    return [...diagnostics, { id: 'CM-70', status: 'FAIL', path: FILE, message: 'invalid warning allowlist JSON' }];
  }
  const failures = [];
  const fail = message => failures.push({ id: 'CM-70', status: 'FAIL', path: FILE, message });
  if (!Array.isArray(policy)) {
    fail('warning allowlist must be an array');
    return [...diagnostics, ...failures];
  }
  const suppressed = new Set(), seen = new Set();
  for (const entry of policy) {
    if (!entry || typeof entry.path !== 'string' || !entry.path ||
        /[\\|*\r\n]/.test(entry.path) || path.isAbsolute(entry.path) || /^[A-Za-z]:/.test(entry.path) ||
        entry.path.split('/').some(p => !p || p === '.' || p === '..') ||
        !['CM-70', 'CM-71'].includes(entry.check) || typeof entry.class !== 'string' || !entry.class ||
        typeof entry.reason !== 'string' || !entry.reason.trim() ||
        (entry.check === 'CM-71' && !/^[a-f0-9]{64}$/.test(entry.fingerprint || ''))) {
      fail('warning allowlist entry requires a safe exact path, check, class, reason and CM-71 fingerprint');
      continue;
    }
    const key = [entry.path, entry.check, entry.class, entry.fingerprint || ''].join('|');
    if (seen.has(key)) { fail(`duplicate warning allowlist entry: ${entry.path} ${entry.class}`); continue; }
    seen.add(key);
    const matches = diagnostics.filter(d => d.status === 'WARN' && d.path === entry.path &&
      d.id === entry.check && warningClass(d) === entry.class &&
      (!entry.fingerprint || fingerprint(d) === entry.fingerprint));
    if (!matches.length) { fail(`stale warning allowlist entry: ${entry.path} ${entry.class}`); continue; }
    for (const d of matches) suppressed.add(d);
  }
  return [...diagnostics.filter(d => !suppressed.has(d)), ...failures,
    ...(suppressed.size ? [{ id: 'CM-70', status: 'PASS', path: FILE,
      message: `reasoned warning allowlist: ${suppressed.size} current diagnostics acknowledged` }] : [])];
}

module.exports = { applyWarningAllowlist, warningClass, fingerprint, FILE };

'use strict';
// Source-only operator CLI. Acknowledging --operator declares the caller's
// role; provenance records that declaration, not an authenticated identity.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const F = require('../lib/register-fragments.cjs');
const L = require('../lib/register-launch-ledger.cjs');
const G = require('../lib/register-git.cjs');
const safe = require('../lib/path-safe.cjs');
const { identityOf } = require('../protocol-dispatch/procfs.cjs');
const { isSessionAlive } = require('../protocol-session.cjs');
const { need, fail } = F;
const LOCK = 'register-launches.issue.lock', BOOT = 'register-launches.bootstrap.json';
const stableId = (a, b) => a.ino === b.ino && a.dev === b.dev;
function checked(g, name) {
  G.local(g.common); const file = path.join(g.common, name);
  const r = safe.realInside(g.common, file, { refuseHardlinks: true });
  need(r.ok, 'LAUNCH_PATH_UNSAFE'); return file;
}
function lock(g, owner, deps = {}) {
  const file = checked(g, LOCK); let fd;
  try { fd = fs.openSync(file, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') fail('LAUNCH_BUSY'); throw e; }
  const id = fs.fstatSync(fd, { bigint: true });
  const nonce = crypto.randomBytes(16).toString('hex');
  const identity = (deps.identityOf || identityOf)(process.pid);
  // Unknown identity leaves a diagnostic lock; automatic reclamation is forbidden.
  const record = { owner, nonce, pid: process.pid, hostname: os.hostname(), createdAt: identity?.createdAt || null };
  fs.writeFileSync(fd, JSON.stringify(record) + '\n'); fs.fsyncSync(fd);
  const release = () => {
    try {
      checked(g, LOCK); const st = fs.lstatSync(file, { bigint: true });
      const actual = F.json(fs.readFileSync(file));
      need(stableId(st, id) && actual.owner === owner && actual.nonce === nonce, 'LAUNCH_LOCK_CHANGED');
      fs.unlinkSync(file);
    } finally { fs.closeSync(fd); }
  };
  if (!identity || identity.pid !== process.pid || !record.createdAt) { fs.closeSync(fd); fail('LAUNCH_PROCESS_UNKNOWN'); }
  return { nonce, record, release };
}
function operatorArgs(options) {
  need(options && options.operator === true, 'LAUNCH_OPERATOR_REQUIRED');
  need(typeof options.owner === 'string' && /^[A-Za-z0-9._-]{1,128}$/.test(options.owner), 'LAUNCH_OWNER_INVALID');
  F.scalar(options.ownerAct); need(options.ownerAct.trim().length > 0 && options.ownerAct.length <= 1024, 'LAUNCH_OWNER_INVALID');
}
function bootstrap(g) {
  const file = checked(g, BOOT);
  need(fs.existsSync(file), 'LAUNCH_AUTHORITY_MISSING');
  const value = F.json(fs.readFileSync(file)); F.keys(value, ['schema', 'bootstrapSha', 'baseSha', 'owner', 'ownerAct']);
  need(value.schema === 'register-launch-bootstrap/1' && typeof value.bootstrapSha === 'string' && F.SHA.test(value.bootstrapSha), 'LAUNCH_LEDGER_INVALID');
  return value;
}
function nextLaunchOrdinal(last) {
  need(Number.isInteger(last) && last >= 0 && last <= 999999, 'LAUNCH_LEDGER_INVALID');
  need(last < 999999, 'LAUNCH_EXHAUSTED'); return last + 1;
}
function initLaunchAuthority(options, deps = {}) {
  operatorArgs(options); const g = (deps.boundary || G.boundary)(options.repo); g.commit(options.baseSha);
  const held = lock(g, options.owner, deps);
  try {
    need(!g.current() && !fs.existsSync(checked(g, BOOT)), 'LAUNCH_ALREADY_INITIALIZED');
    const base = g.readTree(options.baseSha);
    const tree = new Map([...base].filter(([p]) => p.toLowerCase().startsWith(F.PREFIXES[0])));
    L.readLaunchLedger(tree);
    const sha = g.publish(tree, null, null, null, held.nonce);
    g.run(['config', '--local', `gc.${G.REF}.reflogExpire`, 'never']);
    g.run(['config', '--local', `gc.${G.REF}.reflogExpireUnreachable`, 'never']);
    const marker = { schema: 'register-launch-bootstrap/1', bootstrapSha: sha, baseSha: options.baseSha, owner: options.owner, ownerAct: options.ownerAct };
    // The durable marker is written BEFORE CAS: a crash cannot permit re-init
    // from an incomplete line after an authority ref has gone missing.
    const fd = fs.openSync(checked(g, BOOT), 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(marker, null, 2) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    const cas = g.result(['update-ref', '--create-reflog', G.REF, sha, '0'.repeat(40)]);
    need(!cas.error && cas.status === 0, 'LAUNCH_REF_MOVED');
    return marker;
  } finally { held.release(); }
}
function envelope(authority, row) {
  const launchId = row.record.launchId;
  const issueCommit = authority.commits.find(c => c.tree.has(row.path)).sha;
  const proof = { launchId, recordDigest: F.digest(row.bytes), issueCommit, bootstrapSha: authority.bootstrapSha };
  L.verifyIssueProofOperator({ bytes: row.bytes, path: row.path, proof, authority });
  return { launchId, packageId: row.record.packageId, packageLabel: row.record.packageLabel, baseSha: row.record.baseSha,
    ...proof, recordBytes: row.bytes };
}
function issueLaunch(options, deps = {}) {
  operatorArgs(options);
  need(typeof options.packageId === 'string' && F.PACKAGE.test(options.packageId) && typeof options.packageLabel === 'string' && F.LABEL.test(options.packageLabel), 'LAUNCH_PACKAGE_INVALID');
  const g = (deps.boundary || G.boundary)(options.repo); g.commit(options.baseSha);
  const held = lock(g, options.owner, deps);
  try {
    const pinned = bootstrap(g); const current = g.current();
    need(current, 'LAUNCH_AUTHORITY_MISSING');
    const authority = g.authority(pinned.bootstrapSha, current);
    g.lineSubset(options.baseSha, authority.tree);
    const existing = authority.rows.find(r => r.record.packageId === options.packageId);
    if (existing) {
      need(existing.record.packageLabel === options.packageLabel, 'LAUNCH_PACKAGE_INVALID');
      return envelope(authority, existing);
    }
    const ordinal = nextLaunchOrdinal(authority.rows.length);
    const launchId = `L${String(ordinal).padStart(6, '0')}`;
    const record = { schema: 'register-launch/1', launchId, packageId: options.packageId, packageLabel: options.packageLabel,
      baseSha: options.baseSha, ordinal, issuedAt: (deps.now || (() => new Date().toISOString()))(),
      provenance: { owner: options.owner, ownerAct: options.ownerAct, previousRecord: authority.rows.length ? F.digest(authority.rows.at(-1).bytes) : null } };
    const bytes = Buffer.from(JSON.stringify(record, null, 2) + '\n'), file = `docs/ops/register-launches/${launchId}.json`;
    F.readLaunch(bytes, file);
    const sha = g.publish(authority.tree, file, bytes, authority.ref, held.nonce);
    if (deps.beforeCAS) deps.beforeCAS({ g, sha, record, held });
    G.local(g.common);
    const cas = g.result(['update-ref', '--create-reflog', G.REF, sha, authority.ref]);
    need(!cas.error && cas.status === 0, 'LAUNCH_REF_MOVED');
    if (deps.afterCAS) deps.afterCAS({ g, sha, record, held });
    // No success envelope escapes until the CAS has succeeded.
    const published = g.authority(authority.bootstrapSha, g.current());
    const row = published.rows.find(r => r.record.launchId === launchId);
    need(row && row.bytes.equals(bytes), 'LAUNCH_REF_MOVED');
    const result = envelope(published, row);
    need(result.issueCommit === sha, 'LAUNCH_REF_MOVED'); return result;
  } finally {
    if (deps.beforeRelease) deps.beforeRelease({ g, held });
    held.release();
  }
}
function recoverLaunchLock(options, deps = {}) {
  operatorArgs(options); const g = (deps.boundary || G.boundary)(options.repo);
  need(typeof options.nonce === 'string' && /^[a-f0-9]{32}$/.test(options.nonce) && typeof options.expectedRef === 'string' && F.SHA.test(options.expectedRef), 'LAUNCH_RECOVERY_INVALID');
  const file = checked(g, LOCK), id = fs.lstatSync(file, { bigint: true }), raw = fs.readFileSync(file), record = F.json(raw);
  F.keys(record, ['owner', 'nonce', 'pid', 'hostname', 'createdAt']);
  need(Number.isInteger(record.pid) && record.pid > 4 && typeof record.createdAt === 'string' && Number.isFinite(Date.parse(record.createdAt)), 'LAUNCH_PROCESS_UNKNOWN');
  need(record.owner === options.lockOwner && record.nonce === options.nonce, 'LAUNCH_LOCK_CHANGED');
  // Same liveness rules as protocol-lock; unknown host/PID stays unknown.
  need((deps.isSessionAlive || isSessionAlive)(record) === false, 'LAUNCH_PROCESS_UNKNOWN');
  need(g.current() === options.expectedRef, 'LAUNCH_REF_MOVED');
  const pinned = bootstrap(g); g.authority(pinned.bootstrapSha, options.expectedRef);
  const target = checked(g, `register-launches.recovered-${record.nonce}.json`);
  need(!fs.existsSync(target), 'LAUNCH_RECOVERY_INVALID');
  const post = fs.lstatSync(checked(g, LOCK), { bigint: true });
  need(stableId(id, post) && fs.readFileSync(file).equals(raw), 'LAUNCH_LOCK_CHANGED');
  fs.renameSync(file, target);
  return { recovered: true, authorityRef: options.expectedRef, archivedLock: path.basename(target) };
}
function main(args) {
  const [command, ...rest] = args, options = { repo: process.cwd() };
  const commonFlags = ['--operator', '--repo', '--owner', '--owner-act'];
  const commandFlags = { init: ['--base'], issue: ['--base', '--package', '--label'], 'recover-lock': ['--nonce', '--lock-owner', '--expected-ref'] };
  need(Object.hasOwn(commandFlags, command), 'LAUNCH_USAGE');
  const names = { '--repo': 'repo', '--package': 'packageId', '--label': 'packageLabel', '--base': 'baseSha', '--owner': 'owner', '--owner-act': 'ownerAct', '--nonce': 'nonce', '--lock-owner': 'lockOwner', '--expected-ref': 'expectedRef' };
  const seen = new Set();
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i]; need(!seen.has(flag), 'LAUNCH_USAGE'); seen.add(flag);
    need(commonFlags.includes(flag) || commandFlags[command].includes(flag), 'LAUNCH_USAGE');
    if (flag === '--operator') options.operator = true;
    else { need(names[flag] && typeof rest[i + 1] === 'string' && !rest[i + 1].startsWith('--'), 'LAUNCH_USAGE'); options[names[flag]] = rest[++i]; }
  }
  const api = { init: initLaunchAuthority, issue: issueLaunch, 'recover-lock': recoverLaunchLock };
  need(Object.hasOwn(api, command), 'LAUNCH_USAGE');
  const result = api[command](options); if (result.recordBytes) result.recordBytes = result.recordBytes.toString('utf8');
  process.stdout.write(JSON.stringify(result) + '\n'); return 0;
}
module.exports = { LOCK, BOOT, nextLaunchOrdinal, initLaunchAuthority, issueLaunch, recoverLaunchLock, main };
if (require.main === module) { try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(e.code || 'LAUNCH_FAILED'); process.exitCode = 1; } }

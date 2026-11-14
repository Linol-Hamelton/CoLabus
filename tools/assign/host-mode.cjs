'use strict';
// Host-owned declaration, shared by every launcher using launch-intake. Never cached.
const path = require('node:path');
const fs = require('node:fs');
const policy = require('./selection-policy.cjs');
const safe = require('../../.ai/bin/lib/path-safe.cjs');
const FILE_REPO = path.resolve(__dirname, '../..');
const inside = (root, file) => {
  const rel = path.relative(root, file);
  return rel === '' || !rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel);
};
// Resolve the operator checkout from Git's on-disk topology without spawning a
// helper on absent/off launches. Never derive authority from the task worktree.
function hostRoot(repo = FILE_REPO) {
  let git = path.join(repo, '.git');
  const st = fs.lstatSync(git);
  if (st.isSymbolicLink()) throw Error('mode-host-invalid');
  if (st.isFile()) {
    if (st.size > 4096) throw Error('mode-host-invalid');
    const m = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(fs.readFileSync(git, 'utf8'));
    if (!m) throw Error('mode-host-invalid');
    git = path.resolve(repo, m[1]);
    const common = path.join(git, 'commondir');
    if (fs.statSync(common).size > 4096) throw Error('mode-host-invalid');
    git = path.resolve(git, fs.readFileSync(common, 'utf8').trim());
  } else if (!st.isDirectory()) throw Error('mode-host-invalid');
  if (path.basename(git) !== '.git') throw Error('mode-host-invalid');
  return fs.realpathSync(path.dirname(git));
}
function resolveFile(worktree, configured, env = process.env) {
  try {
    const host = hostRoot();
    const file = configured ?? env.COLABUS_ASSIGNMENT_MODE_FILE ?? path.join(host, '.ai/runtime/assignment-mode.json');
    if (typeof file !== 'string' || !path.isAbsolute(file)) return null;
    const g = safe.realInside(path.parse(file).root, file, { refuseHardlinks: true });
    if (!g.ok || worktree && inside(fs.realpathSync(worktree), g.real)) return null;
    // An explicit path may be outside Git, or in the main host's runtime. It
    // cannot borrow another package checkout's declaration either.
    for (let dir = path.dirname(g.real); ; dir = path.dirname(dir)) {
      if (fs.existsSync(path.join(dir, '.git'))) {
        if (dir !== host || !inside(path.join(host, '.ai/runtime'), g.real)) return null;
        break;
      }
      if (dir === path.dirname(dir)) break;
    }
    return g.real;
  } catch { return null; }
}
const CLASS = /^(implementer|fixer|reviewer|certifier|critic|researcher|drafter|synthesiser|architect):[AB]:T[1-9]$/;
const KEYS = ['schema', 'mode', 'declaredBy', 'declaredAt', 'expiresAt', 'assignClasses'];
function validate(value, now = Date.now()) {
  const timestamp = s => typeof s === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(s)
    && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== KEYS.length
      || KEYS.some(k => !Object.hasOwn(value, k)) || value.schema !== 'assignment-mode/1'
      || !['off', 'advise', 'assign'].includes(value.mode)
      || typeof value.declaredBy !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value.declaredBy)
      || !timestamp(value.declaredAt) || !timestamp(value.expiresAt) || !Number.isFinite(now)
      || Date.parse(value.declaredAt) > now || Date.parse(value.expiresAt) <= now
      || Date.parse(value.expiresAt) <= Date.parse(value.declaredAt)
      || !Array.isArray(value.assignClasses) || value.assignClasses.length > 200
      || !value.assignClasses.every(c => typeof c === 'string' && CLASS.test(c))
      || new Set(value.assignClasses).size !== value.assignClasses.length) throw new Error('mode-invalid');
  return value;
}
function read(file, now = Date.now(), options = {}) {
  let expiry = null;
  try {
    if (file === null) throw Error('mode-disabled');
    file = resolveFile(options.worktree, file, options.env);
    // An absent host declaration must not start the guarded reader's helper.
    // Existing files still go through the full link, identity and text checks.
    if (!file || !fs.existsSync(file)) throw new Error('mode-absent');
    const doc = policy.readInput(file, 'assignment-mode');
    expiry = doc.obj?.expiresAt;
    return { ...validate(doc.obj, now), reason: Date.parse(expiry) - now <= 86400000 ? 'mode-expiring' : 'mode-declared', sha256: doc.sha256 };
  } catch (e) {
    return { schema: 'assignment-mode/1', mode: 'off', declaredBy: null, declaredAt: null,
      expiresAt: null, assignClasses: [], reason: Number.isFinite(Date.parse(expiry)) && Date.parse(expiry) <= now ? 'mode-expired'
        : e.message === 'mode-absent' ? 'mode-absent' : e.message === 'mode-disabled' ? 'mode-disabled' : 'mode-missing-or-invalid', sha256: null };
  }
}
const taskClass = frame => `${frame.role}:${frame.riskClass}:${frame.tier}`;
// This is eligibility, not launch authority. The launcher must still reserve and
// recheck the selected route. No fallback ladder may pass this boundary.
function eligibility(mode, frame, decision, ownerExplicit = false) {
  if (ownerExplicit) return { status: 'owner-choice', reason: 'owner-explicit-choice' };
  const refuse = reason => ({ status: 'needs-operator-choice', reason });
  if (frame.role === 'certifier') return refuse('certifier-auto-assignment-disabled');
  if (mode.mode !== 'assign') return refuse('mode-not-assign');
  if (!mode.assignClasses.includes(taskClass(frame))) return refuse('class-not-enabled');
  if (!frame.riskKnown || frame.unknown.length || !policy.FACTORS.every(k => Number.isInteger(frame.complexity[k])
      && frame.complexity[k] >= 0 && frame.complexity[k] <= 2)) return refuse('task-factors-unknown');
  if (!decision || decision.source !== 'selection' || decision.selectionFallback || decision.status !== 'ASSIGNED'
      || decision.assignments?.length !== 1) return refuse('assignment-refused');
  if (decision.classification?.features?.some(f => f.value === null || f.reason === 'unknown-caution')) return refuse('assignment-factors-unknown');
  if (decision.assignments[0].quota?.status !== 'allow') return refuse('quota-unverified');
  return { status: 'requires-route-recheck', reason: 'eligibility-only' };
}
module.exports = { read, validate, eligibility, taskClass, hostRoot, resolveFile,
  get DEFAULT() { return resolveFile(undefined, undefined, {}); } };

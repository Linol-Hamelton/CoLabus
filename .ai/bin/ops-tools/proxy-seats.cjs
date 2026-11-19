'use strict';
// Replay is a new author attempt, never a client session resume. Reservations cover
// manual and scheduler launches alike; ambiguous crash windows remain reserved.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const health = require('./proxy-health.cjs');
const safe = require('../lib/path-safe.cjs');
const { secretIn } = require('../lib/secrets.cjs');
const { parseRegistry, ACTIVE_STATUSES } = require('../lib/candidate-registry.cjs');
const { parseOwnerIdentity } = require('../lib/owner-identity.cjs');
const fail = s => { throw new Error(s); };
const git = (wt, args) => {
  const r = spawnSync('git', ['-C', wt, ...args], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) fail('PROXY_GIT'); return r.stdout.trim();
};
function facts(worktree, taskFile) {
  const wt = health.canonical(worktree); const task = safe.readFileGuarded(path.dirname(taskFile), taskFile, { maxBytes: 131072 });
  if (!task.ok) fail('PROXY_TASK');
  return { worktree: wt, taskFile: health.canonical(taskFile), taskSha256: health.hash(task.bytes), head: git(wt, ['rev-parse', 'HEAD']), branch: git(wt, ['branch', '--show-current']) };
}
function directory(runtime) {
  health.ensureDirectory(runtime);
  const dir = path.join(runtime, 'proxy-seats');
  if (!safe.mkdirGuarded(runtime, dir).ok) fail('PROXY_RUNTIME');
  return dir;
}
const reservationFile = (dir, wt) => path.join(dir, `${health.hash(wt)}.json`);
const KEYS = 'schema,state,attempt,retryOf,budget,name,stream,owner,worktree,branch,head,taskFile,taskSha256,argv,pins,launchRole,provider,model,effort,wrapperArgs,engineMode,caps,registryFile,runtimeDir,pid,dropId,launchId'.split(',');
function validate(c) {
  if (!c || Object.keys(c).length !== KEYS.length || KEYS.some(k => !Object.hasOwn(c, k)) || c.schema !== 'proxy-seat/1'
    || !['reserved', 'spawned', 'pending', 'released', 'cancelled'].includes(c.state) || c.launchRole !== 'author'
    || !Number.isInteger(c.budget) || c.budget < 0 || c.budget > 3 || !Array.isArray(c.argv) || !c.argv.length
    || c.argv.some(a => typeof a !== 'string' || /[\0\r\n]/.test(a)) || !/^[0-9a-f]{64}$/.test(c.taskSha256)
    || !/^[0-9a-f]{40}$/.test(c.head) || !c.branch || typeof c.attempt !== 'string' || !Array.isArray(c.pins) || secretIn(JSON.stringify(c))) fail('PROXY_CARD_INVALID');
  if (!/^[0-9a-f-]{36}$/.test(c.attempt) || (c.retryOf !== null && !/^[0-9a-f-]{36}$/.test(c.retryOf))
    || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(c.name) || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(c.stream)
    || !['worktree', 'taskFile', 'registryFile', 'runtimeDir'].every(k => typeof c[k] === 'string' && path.isAbsolute(c[k]))
    || !Array.isArray(c.wrapperArgs) || c.wrapperArgs.some(a => typeof a !== 'string') || !['legacy', 'dispatch'].includes(c.engineMode)
    || (c.pid !== null && (!Number.isInteger(c.pid) || c.pid < 1)) || (c.dropId !== null && (!Number.isInteger(c.dropId) || c.dropId < 0))) fail('PROXY_CARD_INVALID');
  parseOwnerIdentity(c.owner);
  return c;
}
function candidate(c) {
  const r = safe.readFileGuarded(path.dirname(c.registryFile), c.registryFile, { maxBytes: 1048576 });
  if (!r.ok) fail('PROXY_CANDIDATE');
  const rows = parseRegistry(r.bytes).rows.filter(r => r.cells[0] === c.stream);
  if (rows.length !== 1) fail('PROXY_CANDIDATE');
  const row = rows[0];
  if (row.cells[1] !== c.branch || parseOwnerIdentity(row.cells[3]).namespaced !== parseOwnerIdentity(c.owner).namespaced || !ACTIVE_STATUSES.includes(row.cells[4])) fail('PROXY_CANDIDATE');
  // An author may add commits, not replace the branch or move it to an unrelated history.
  git(c.worktree, ['merge-base', '--is-ancestor', c.head, 'HEAD']);
  git(c.worktree, ['merge-base', '--is-ancestor', row.cells[2], 'HEAD']);
  return { row, text: r.bytes.toString('utf8') };
}
function reserve(o) {
  const f = facts(o.worktree, o.taskFile); const dir = directory(o.runtimeDir); const file = reservationFile(dir, f.worktree);
  const unlock = health.lock(dir, `${health.hash(f.worktree)}.lock`);
  try {
    const old = health.readJson(dir, file);
    if (fs.existsSync(path.join(dir, `${health.hash(f.worktree)}.active`))) fail('PROXY_WORKTREE_RESERVED');
    if (fs.existsSync(file) && (!old || !['released', 'cancelled'].includes(validate(old).state))) fail('PROXY_WORKTREE_RESERVED');
    const pins = [];
    for (const arg of o.argv) if (path.isAbsolute(arg) && fs.existsSync(arg) && fs.statSync(arg).isFile()) {
      const r = safe.readFileGuarded(path.dirname(arg), arg, { maxBytes: 16777216 });
      // Native executables are not replay instructions. Script, prompt and task
      // identities are pinned; executable resolution is unchanged from the launch.
      if (!/\.(?:cjs|mjs|js|md|json)$/i.test(arg)) continue;
      if (!r.ok) fail('PROXY_PIN'); pins.push({ file: health.canonical(arg), sha256: health.hash(r.bytes) });
    }
    const card = validate({ schema: 'proxy-seat/1', state: 'reserved', attempt: randomUUID(), retryOf: null, budget: 0,
      name: o.name, stream: o.stream, owner: o.owner, ...f, argv: o.argv, pins, launchRole: o.launchRole,
      provider: o.provider || null, model: o.model || null, effort: o.effort || null, wrapperArgs: o.wrapperArgs || [], engineMode: o.engineMode || 'legacy',
      caps: o.caps || null, registryFile: path.resolve(o.registryFile), runtimeDir: path.resolve(o.runtimeDir), pid: null, dropId: null, launchId: null });
    candidate(card); health.write(dir, file, card); return { card, file, dir };
  } finally { unlock(); }
}
function change(reservation, update) {
  const { dir, file } = reservation; const unlock = health.lock(dir, `${health.hash(reservation.card.worktree)}.lock`);
  try {
    const current = validate(health.readJson(dir, file));
    if (current.attempt !== reservation.card.attempt || ['cancelled', 'released'].includes(current.state)) fail('PROXY_ATTEMPT_CHANGED');
    reservation.card = validate({ ...current, ...update }); health.write(dir, file, reservation.card); return reservation.card;
  } finally { unlock(); }
}
// The attempt a lease file names; null when it names none (a lease of a launch without an attempt, or an unreadable file).
function leaseAttempt(dir, active) {
  const r = safe.readFileGuarded(dir, active, { maxBytes: 4096 });
  if (!r.ok) return null;
  try { const v = JSON.parse(r.bytes.toString('utf8')); return v && typeof v.attempt === 'string' ? v.attempt : null; } catch { return null; }
}
function recover(runtimeDir, worktree, action, attempt, options = {}) {
  const wt = health.canonical(worktree); const dir = directory(runtimeDir); const file = reservationFile(dir, wt);
  if (!['cancel', 'release', 'clear-active'].includes(action) || typeof attempt !== 'string') fail('PROXY_RECOVERY');
  if (action === 'cancel') return change({ dir, file, card: { attempt, worktree: wt } }, { state: 'cancelled' });
  // Recovery acts on the named attempt only. The card, its state, the liveness of the worktree and the owner of the lease
  // are all read under the worktree lock, so an attempt reserved or leased meanwhile is never replaced by the old card and
  // its lease is never removed. Explicit recovery never guesses that a PID or an unrecorded spawn is dead.
  const active = path.join(dir, `${health.hash(wt)}.active`);
  const unlock = health.lock(dir, `${health.hash(wt)}.lock`);
  try {
    const card = validate(health.readJson(dir, file));
    if (card.attempt !== attempt) fail('PROXY_ATTEMPT_CHANGED');
    if (card.state !== 'cancelled') fail('PROXY_RECOVERY_REQUIRES_CANCEL');
    const held = safe.realInside(dir, active, { refuseHardlinks: true });
    if (!held.ok || (held.exists && held.type !== 'file')) fail('PROXY_RECOVERY_ACTIVE_PATH');
    if (action === 'release' && held.exists) fail('PROXY_RECOVERY_ACTIVE');
    if (action === 'clear-active') {
      // A wrapper that crashed while it held the lease leaves <hash>.active behind. The owner clears it only after cancelling
      // the attempt (the owner's word that it is over), only while no recorded seat of the worktree lives and only when the
      // lease names this attempt; then the reservation is released and the worktree can be reserved again.
      if (require('./seat-count.cjs').busyWorktree({ runtimeDir, worktree: wt, ...(options.liveness || {}) })) fail('PROXY_RECOVERY_BUSY');
      if (held.exists && leaseAttempt(dir, active) !== attempt) fail('PROXY_RECOVERY_LEASE_OWNER');
      if (held.exists) fs.unlinkSync(active);
    }
    health.write(dir, file, { ...card, state: 'released' });
  } finally { unlock(); }
}
async function continueDroppedSeats(o) {
  const c = health.config(o.config); const s = health.readState(o);
  if (!health.available(s, c, (o.now || Date.now)())) return [];
  const dir = directory(o.runtimeDir); const results = [];
  for (const name of fs.readdirSync(dir).filter(n => /^[0-9a-f]{64}\.json$/.test(n))) {
    const file = path.join(dir, name); let unlock;
    try {
      unlock = health.lock(dir, name.replace('.json', '.lock'));
      let card = validate(health.readJson(dir, file));
      if (card.state !== 'pending' || card.budget >= c.maxContinuations) continue;
      // A dropped seat whose lease is still held is never continued, and never silently: a wrapper still on its way out
      // clears it on the next tick, a crashed one needs the owner (cancel, then clear-active).
      if (fs.existsSync(path.join(dir, `${health.hash(card.worktree)}.active`))) fail('PROXY_LEASE_ACTIVE');
      if (reservationFile(dir, card.worktree) !== file || card.runtimeDir !== path.resolve(o.runtimeDir)) fail('PROXY_CARD_PATH');
      const f = facts(card.worktree, card.taskFile);
      for (const pin of card.pins) {
        if (!pin || Object.keys(pin).sort().join(',') !== 'file,sha256' || health.canonical(pin.file) !== pin.file) fail('PROXY_PIN');
        const r = safe.readFileGuarded(path.dirname(pin.file), pin.file, { maxBytes: 16777216 });
        if (!r.ok || health.hash(r.bytes) !== pin.sha256) fail('PROXY_PIN');
      }
      if (f.worktree !== card.worktree || f.taskFile !== card.taskFile || f.taskSha256 !== card.taskSha256 || f.branch !== card.branch) fail('PROXY_TASK_CHANGED');
      const stopped = path.join(o.runtimeDir, `${card.name}.stopped.json`);
      if (fs.existsSync(stopped)) fail('PROXY_OWNER_STOP');
      if (require('./seat-count.cjs').busyWorktree({ runtimeDir: o.runtimeDir, worktree: card.worktree, ...(o.liveness || {}) })) continue;
      const pin = candidate(card);
      const argv = card.argv.slice();
      const at = argv.indexOf('--expect-sha'); if (at < 0 || !argv[at + 1]) fail('PROXY_REPLAY_HEAD');
      argv[at + 1] = f.head.slice(0, 8);
      const prior = card.attempt;
      const archive = path.join(dir, 'attempts');
      if (!safe.mkdirGuarded(dir, archive).ok) fail('PROXY_ARCHIVE');
      health.write(archive, path.join(archive, `${prior}.json`), card);
      const attemptDir = path.join(archive, prior);
      if (!safe.mkdirGuarded(archive, attemptDir).ok) fail('PROXY_ARCHIVE');
      for (const suffix of ['.launch.out', '.running.json', '.terminal.json', '.marker.txt', '-call.txt']) {
        const from = path.join(o.runtimeDir, card.name + suffix);
        if (!fs.existsSync(from)) continue;
        const checked = safe.readFileGuarded(o.runtimeDir, from, { maxBytes: 1048576 });
        if (!checked.ok) fail('PROXY_ARCHIVE_READ');
        fs.renameSync(from, path.join(attemptDir, card.name + suffix));
      }
      card = validate({ ...card, head: f.head, argv, attempt: randomUUID(), retryOf: prior, budget: card.budget + 1, state: 'reserved', pid: null });
      // Persist attempt and budget before repin or spawn. Any crash leaves it reserved.
      health.write(dir, file, card);
      const lines = pin.text.split('\n'); const cells = pin.row.cells.slice(); cells[2] = f.head; cells[5] = new Date().toISOString();
      lines[pin.row.index] = `| ${cells.join(' | ')} |`;
      const registryWrite = safe.writeAtomicGuarded(card.registryFile, Buffer.from(lines.join('\n')), { root: path.dirname(card.registryFile) });
      if (!registryWrite.ok) fail('PROXY_REPIN');
      // A new wrapper owns the reserved attempt by its exact id; it cannot reserve twice.
      const split = argv.indexOf('--');
      argv.splice(split, 0, '--proxy-attempt', card.attempt);
      unlock(); unlock = null;
      const child = (o.spawn || spawn)(argv[0], argv.slice(1), { cwd: card.worktree, windowsHide: true, detached: true, stdio: 'ignore', shell: false });
      if (!child || !child.pid) fail('PROXY_SPAWN_UNKNOWN');
      // The child wrapper alone acknowledges spawned. Never overwrite a fast
      // child's terminal/pending update from the parent side of spawn.
      if (child.unref) child.unref(); results.push({ name: card.name, attempt: card.attempt, retryOf: prior });
      const logFile = path.join(o.runtimeDir, 'proxy-continuations.jsonl');
      const releaseLog = health.lock(o.runtimeDir, 'proxy-continuations.lock');
      try {
        const old = fs.existsSync(logFile) ? safe.readFileGuarded(o.runtimeDir, logFile, { maxBytes: 1048576 }) : { ok: true, bytes: Buffer.alloc(0) };
        if (!old.ok) fail('PROXY_LOG');
        if (!safe.writeAtomicGuarded(logFile, Buffer.concat([old.bytes, Buffer.from(`${JSON.stringify({ name: card.name, attempt: card.attempt, retryOf: prior, reason: 'proxy-drop', head: card.head })}\n`)]), { root: o.runtimeDir }).ok) fail('PROXY_LOG');
      } finally { releaseLog(); }
    } catch (e) { results.push({ file: name, refused: e.message }); }
    finally { if (unlock) unlock(); }
  }
  return results;
}
module.exports = { facts, reserve, change, recover, continueDroppedSeats, validate, candidate, directory, reservationFile };
function lease(runtime, worktree, attempt) {
  const dir = directory(runtime); const wt = health.canonical(worktree);
  const file = reservationFile(dir, wt); const card = health.readJson(dir, file);
  if (fs.existsSync(file)) {
    validate(card);
    if (!['released', 'cancelled'].includes(card.state) && card.attempt !== attempt) fail('PROXY_WORKTREE_RESERVED');
  }
  // The lease names its attempt: recovery removes only a lease of the attempt it names.
  const active = `${health.hash(wt)}.active`;
  const release = health.lock(dir, active);
  try { fs.writeFileSync(path.join(dir, active), JSON.stringify({ attempt: typeof attempt === 'string' ? attempt : null })); }
  catch (e) { release(); throw e; }
  return release;
}
module.exports.lease = lease;
if (require.main === module) {
  const [action, runtime, worktree, attempt] = process.argv.slice(2);
  try { recover(path.resolve(runtime), worktree, action, attempt); process.stdout.write('PROXY_RECOVERY_OK\n'); }
  catch (e) { process.stderr.write(`${e.message}\n`); process.exitCode = 3; }
}

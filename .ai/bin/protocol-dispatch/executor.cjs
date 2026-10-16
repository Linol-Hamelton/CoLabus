'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');

let runrecordLib = null;
try {
  runrecordLib = require('../protocol-runrecord.cjs');
} catch {}

const { JOURNAL_RE, makePointer, getRepoRoot, gitIn, executorEnv, isPidAlive, killExact, snapshotProcesses, identityOf, checkCommand } = require('./procfs.cjs');
const { resolveLimits, createTracker, isProgressLine, ERROR_PATTERNS, ERROR_TEXT, RETRY_TEXT } = require('./liveness.cjs');
const { sameProcess, decideStart, descendantsOf, planStop, findUnrecorded, verifyStopped } = require('./lease.cjs');
const { workdirState, prepareWorkdir, dropWorkdir, scopeCheck, lsRemoteSnapshot, remoteAuditVerdict } = require('./workdir.cjs');
const { buildClientCommand, formatCommandLine, probeClient } = require('./clients.cjs');

const FAILURE_CLASSES = [
  'AUTH_ERROR',
  'RATE_LIMIT',
  'QUOTA_EXHAUSTED',
  'MODEL_UNAVAILABLE',
  'NETWORK_ERROR',
  'PROVIDER_ERROR',
  'PROCESS_CRASH',
  'INVALID_OUTPUT',
  'STALL',
  'TIMEOUT',
  'CONFIG_ERROR',
  'POLICY_FAILURE'
];

let OWN_IDENTITY = null;

function ownIdentity() {
  if (!OWN_IDENTITY) OWN_IDENTITY = identityOf(process.pid) || { pid: process.pid, createdAt: null };
  return OWN_IDENTITY;
}

function leasePath(slotId, stateDir) {
  return path.join(stateDir, `${slotId}.lease.json`);
}

function readLease(slotId, stateDir) {
  try {
    const lease = JSON.parse(fs.readFileSync(leasePath(slotId, stateDir), 'utf8'));
    return lease && typeof lease === 'object' && Array.isArray(lease.attempts) ? lease : null;
  } catch {
    return null;
  }
}

class LeaseWriteError extends Error {}

// Atomic: a temp file in the same directory, then a rename. A failure is a LeaseWriteError, never swallowed:
// nothing may go on as if a lease that was not persisted were on disk.
function writeLease(slotId, stateDir, lease) {
  const target = leasePath(slotId, stateDir);
  const tmp = `${target}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(lease, null, 2), 'utf8');
    fs.renameSync(tmp, target);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw new LeaseWriteError(`lease-write-failed: ${e.message}`);
  }
}

// The lease decides a start from the recorded supervisor and attempts (R-L3-004.7), never from a PID alone.
// An unreadable process table refuses the start (reason table-unavailable).
function leaseStartDecision(slotId, stateDir, opts = {}) {
  const lease = readLease(slotId, stateDir);
  if (!lease) return { allow: true, reason: 'ok' };
  return decideStart({ lease, table: (opts.snapshotProcesses || snapshotProcesses)() });
}

let lastRefusal = null;

// Why the last takeStartLock said no (a lease reason, or start-lock-held), for the caller's message.
function startRefusalReason() {
  return lastRefusal ? lastRefusal.reason : null;
}

// The whole decision behind it ({ allow:false, reason, orphans? }), for the caller that tells the owner what to do.
function startRefusalDetail() {
  return lastRefusal;
}

function leaseAllowsStart(slotId, stateDir, opts = {}) {
  const d = leaseStartDecision(slotId, stateDir, opts);
  lastRefusal = d.allow ? null : d;
  return d.allow;
}

// Owner-facing: settle attempts the supervisor could not settle (a surviving process, an unreadable table) with a
// recorded ack. A recorded process that is still alive keeps blocking a start (decideStart); the ack covers only the
// unsettled flag and the unrecorded processes. Returns the number of attempts settled; throws LeaseWriteError.
function forceSettle(slotId, stateDir, note) {
  const lease = readLease(slotId, stateDir);
  if (!lease) return 0;
  let n = 0;
  for (const a of lease.attempts) {
    const hasLiveUnrecorded = !a.ack && Array.isArray(a.unrecorded) && a.unrecorded.length > 0;
    if (a.settled && !hasLiveUnrecorded) continue;
    a.settled = true;
    a.ack = { at: new Date().toISOString(), note: String(note || 'owner-ack') };
    n++;
  }
  if (n) writeLease(slotId, stateDir, lease);
  return n;
}

function attemptsNeedingAck(slotId, stateDir) {
  const lease = readLease(slotId, stateDir);
  return lease ? lease.attempts.filter(a => !a.settled || (!a.ack && (a.unrecorded || []).length)) : [];
}

function lockBody() {
  const own = ownIdentity();
  return JSON.stringify({ pid: own.pid, createdAt: own.createdAt });
}

// A holder is the same process only when PID and creation time both match; a bare PID (old lock) is judged by the PID.
function lockHolderAlive(content) {
  let rec = null;
  try { rec = JSON.parse(content); } catch {}
  if (rec && typeof rec === 'object' && Number.isInteger(rec.pid)) {
    return sameProcess(rec, identityOf(rec.pid));
  }
  const pid = parseInt(String(content).trim(), 10);
  return Boolean(pid) && isPidAlive(pid);
}

function takeStartLock(slotId, stateDir, opts = {}) {
  const lockPath = path.join(stateDir, `${slotId}.startlock`);
  const create = () => {
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, lockBody());
    fs.closeSync(fd);
  };
  lastRefusal = null;
  if (!leaseAllowsStart(slotId, stateDir, opts)) return false;
  try {
    create();
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') {
      try {
        const content = fs.readFileSync(lockPath, 'utf8');
        if (!lockHolderAlive(content)) {
          fs.unlinkSync(lockPath);
          create();
          return true;
        }
      } catch {}
      lastRefusal = { allow: false, reason: 'start-lock-held' };
      return false;
    }
    return false;
  }
}

function releaseStartLock(slotId, stateDir) {
  const lockPath = path.join(stateDir, `${slotId}.startlock`);
  try {
    fs.unlinkSync(lockPath);
  } catch {}
  // the supervisor's tenure ends with the lock; settled attempts and recorded processes still count.
  // A failed write here leaves the dead supervisor's identity in the lease, which identity-based judgement
  // already treats as dead: stated on stderr, not fatal for the callers that release on their way out.
  const lease = readLease(slotId, stateDir);
  if (lease && lease.supervisor) {
    try {
      writeLease(slotId, stateDir, { ...lease, supervisor: null });
    } catch (e) {
      process.stderr.write(`WARN reason=lease-release-failed slot=${slotId} error="${e.message}"\n`);
    }
  }
}

function chunkIsProgress(chunk) {
  if (!chunk || !chunk.length) return false;
  return chunk.split(/\r?\n/).some(isProgressLine);
}

function classifyErrorText(text) {
  if (!text) return null;
  for (const [cls, patterns] of Object.entries(ERROR_PATTERNS)) {
    for (const p of patterns) {
      if (p.test(text)) return cls;
    }
  }
  return null;
}

function writeRepairFile(dir, attemptNum, failingRows, repoRoot = getRepoRoot()) {
  const templatePath = path.resolve(repoRoot, '.ai', 'docs', 'dispatch', 'repair.md');
  let header = '';
  try {
    header = fs.readFileSync(templatePath, 'utf8');
  } catch {
    header = '# Dispatch Repair\n\nRepair only the named outputs.\n';
  }
  const rowsText = (failingRows || []).join('\n');
  const fullContent = `${header.trim()}\n\n## Failing Check Rows\n${rowsText}\n`;
  const relPath = path.join('.ai', 'runtime', `dispatch-repair-${attemptNum}.md`).replace(/\\/g, '/');
  const targetPath = path.resolve(dir, relPath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, fullContent, 'utf8');
  return relPath;
}

function checkCompletion(slot, dir, declaredOutputs, attemptResult, repoRoot = getRepoRoot()) {
  const result = {
    processEnded: attemptResult.exitCode !== null,
    exitCode: attemptResult.exitCode,
    outputsPresent: true,
    outputsNonEmpty: true,
    structuralCheck: 'pass',
    validator: 'n/a',
    evidence: null,
    supervisorDone: false,
    failingRows: []
  };

  const outputs = (declaredOutputs || []).map(p => p.replace(/\\/g, '/'));
  for (const p of outputs) {
    const full = path.resolve(dir, p);
    if (!fs.existsSync(full)) {
      result.outputsPresent = false;
      result.failingRows.push(`OUTPUT_MISSING path=${p}`);
    } else {
      const sz = fs.statSync(full).size;
      if (sz === 0) {
        result.outputsNonEmpty = false;
        result.failingRows.push(`OUTPUT_EMPTY path=${p}`);
      }
      try {
        const buf = fs.readFileSync(full);
        const str = buf.toString('utf8');
        if (str.includes('\uFFFD')) {
          result.structuralCheck = 'fail';
          result.failingRows.push(`ENCODING_ERROR path=${p} contains U+FFFD`);
        }
      } catch {
        result.structuralCheck = 'fail';
        result.failingRows.push(`ENCODING_ERROR path=${p} read error`);
      }
    }
  }

  // Validator
  if (slot.validate && Array.isArray(slot.validate) && slot.validate.length) {
    try {
      const vBin = slot.validate[0];
      const vArgs = slot.validate.slice(1);
      const vr = spawnSync(vBin, vArgs, { cwd: dir, encoding: 'utf8', windowsHide: true });
      if (vr.status === 0) {
        result.validator = 'pass';
      } else {
        result.validator = 'fail';
        result.failingRows.push(`VALIDATOR_FAILED exitCode=${vr.status}`);
      }
    } catch (e) {
      result.validator = 'fail';
      result.failingRows.push(`VALIDATOR_ERROR message="${e.message}"`);
    }
  }

  // Evidence from copied-back or workdir journal
  const st = workdirState(dir);
  if (st) {
    for (const e of st.entries) {
      const norm = e.path.replace(/\\/g, '/');
      if (JOURNAL_RE.test(norm)) {
        const jPath = path.resolve(dir, norm);
        if (fs.existsSync(jPath)) {
          const content = fs.readFileSync(jPath, 'utf8');
          if (/^Evidence:/m.test(content)) {
            result.evidence = norm;
            break;
          }
        }
      }
    }
  }

  if (!result.evidence) {
    result.failingRows.push('MISSING_EVIDENCE journal has no line starting Evidence:');
  }

  if (
    result.processEnded &&
    result.exitCode === 0 &&
    result.outputsPresent &&
    result.outputsNonEmpty &&
    result.structuralCheck === 'pass' &&
    result.validator !== 'fail' &&
    result.evidence !== null
  ) {
    result.supervisorDone = true;
  }

  return result;
}

function mapClassForRunRecord(cls, status) {
  if (status === 'DONE') return 'NONE';
  if (!cls) return 'NONE';
  const CANONICAL_CLASSES = new Set([
    'AUTH_ERROR', 'CONFIG_ERROR', 'MODEL_UNAVAILABLE', 'QUOTA_EXHAUSTED',
    'RATE_LIMIT', 'NETWORK_ERROR', 'PROVIDER_ERROR', 'PROCESS_CRASH',
    'STALL', 'TIMEOUT', 'INVALID_OUTPUT', 'VALIDATION_FAILURE',
    'SEMANTIC_FAILURE', 'DEPENDENCY_FAILURE', 'POLICY_FAILURE',
    'NONE', 'UNCLASSIFIED'
  ]);
  if (CANONICAL_CLASSES.has(cls)) return cls;
  return 'UNCLASSIFIED';
}

function executeAttempt(slot, attemptNumber, dispatch, registry, opts = {}) {
  const repoRoot = getRepoRoot(opts);
  const stateDir = path.resolve(repoRoot, dispatch.stateDir || '.ai/runtime/dispatch');
  fs.mkdirSync(stateDir, { recursive: true });
  const logsDir = path.join(stateDir, 'logs');
  fs.mkdirSync(logsDir, { recursive: true });

  const route = opts.route || slot.route;
  if (!route) {
    return Promise.resolve({ status: 'FAILED', class: 'CONFIG_ERROR', reason: 'no-route' });
  }
  const clientName = route.client;
  const clientCfg = registry.clients[clientName];
  if (!clientCfg) {
    return Promise.resolve({ status: 'FAILED', class: 'CONFIG_ERROR', reason: `unknown client ${clientName}`, exitCode: null, sessionId: null });
  }

  const probeRes = probeClient(clientName, registry, { model: route.model });
  if (!probeRes.ok) {
    const cls = probeRes.state === 'MODEL_UNAVAILABLE' ? 'MODEL_UNAVAILABLE' : 'CONFIG_ERROR';
    return Promise.resolve({ status: 'FAILED', class: cls, reason: probeRes.state, exitCode: null, sessionId: null });
  }

  const attemptKind = opts.attemptKind || 'fresh';
  let dir = opts.workdir;
  let base = null;

  if (!dir) {
    let prepared;
    try {
      prepared = prepareWorkdir(slot, attemptNumber, repoRoot, slot.copyIn, opts.tmpDir);
    } catch (e) {
      return Promise.resolve({ status: 'FAILED', class: 'CONFIG_ERROR', reason: `prepareWorkdir failed: ${e.message}`, exitCode: null, sessionId: null });
    }
    dir = prepared.dir;
    base = prepared.base;
    if (opts.derivedFiles && opts.derivedFiles.length) {
      try {
        require('./packet.cjs').writeFiles(dir, opts.derivedFiles);
      } catch (err) {
        dropWorkdir(dir);
        return Promise.resolve({ status: 'FAILED', class: 'CONFIG_ERROR', reason: `packet files failed: ${err.message}`, exitCode: null, sessionId: null });
      }
    }
  } else {
    try {
      base = gitIn(dir, ['rev-parse', 'HEAD']).stdout.trim();
    } catch {}
    // A resumed attempt reuses a retained workdir. The packet was recompiled at the start of this run, so the derived files of the retained workdir are
    // rewritten from it: otherwise the agent could re-read the OLD instruction while the run record pins the NEW packet hash (wiring certification OBS-1).
    if (opts.derivedFiles && opts.derivedFiles.length) {
      try {
        require('./packet.cjs').writeFiles(dir, opts.derivedFiles);
      } catch (err) {
        return Promise.resolve({ status: 'FAILED', class: 'CONFIG_ERROR', reason: `packet files refresh failed: ${err.message}`, exitCode: null, sessionId: null, workdir: dir });
      }
    }
  }

  const declaredOutputs = [];
  if (slot.out) declaredOutputs.push(slot.out.replace(/\\/g, '/'));
  if (slot.outputs) {
    for (const p of slot.outputs) declaredOutputs.push(p.replace(/\\/g, '/'));
  }

  const logFilePath = path.join(logsDir, `${slot.id}-${attemptNumber}.log`);
  // readable too: the supervisor reads its own log for progress (LV-11); 'a' alone is a write-only descriptor
  const logFd = fs.openSync(logFilePath, 'a+');

  const message = opts.message || makePointer(opts.derivedLaunchRel || slot.launch);

  const tokens = {
    message,
    model: route.model || '',
    effort: route.effort || '',
    workdir: dir,
    title: slot.id,
    logdir: path.join(logsDir, `${slot.id}-log`),
    sessionId: opts.sessionId || `session-${slot.id}-${attemptNumber}`
  };

  const cmdTokens = buildClientCommand(clientCfg, route, tokens, attemptKind);
  const cmdString = formatCommandLine(cmdTokens);
  try {
    checkCommand(cmdString);
  } catch (e) {
    fs.closeSync(logFd);
    if (!opts.keepWorkdirOnExit) dropWorkdir(dir);
    return Promise.resolve({ status: 'BLOCKED', class: 'POLICY_FAILURE', reason: e.message, workdir: dir, logPath: logFilePath });
  }

  const env = executorEnv();
  if (clientCfg.env) Object.assign(env, clientCfg.env);

  const auditBefore = lsRemoteSnapshot(repoRoot);

  let limits;
  try {
    limits = resolveLimits({ stallMin: dispatch.stallMin, hardMin: dispatch.hardMin });
  } catch (e) {
    fs.closeSync(logFd);
    if (!opts.keepWorkdirOnExit) dropWorkdir(dir);
    return Promise.resolve({ status: 'FAILED', class: 'CONFIG_ERROR', reason: e.message, workdir: dir, logPath: logFilePath });
  }
  // test and CLI overrides (--stall-seconds / --hard-seconds) replace the file limits
  if (opts.stallSeconds) limits = { ...limits, stallMs: opts.stallSeconds * 1000 };
  if (opts.hardSeconds) limits = { ...limits, hardMs: opts.hardSeconds * 1000 };

  const knownProcs = {};
  const startTime = Date.now();
  // the hard ceiling runs from the first launch of the step; a wake (resume) passes the original start
  // every attempt opens its own idle window at its own start; a wake-resume (opts.wake) takes one wake from the shared budget
  const tracker = createTracker({ limits, firstLaunchAt: opts.firstLaunchAt || startTime, idleStartAt: startTime, wakeBudget: opts.wakeBudget });
  if (opts.wake) {
    const woke = tracker.wake(startTime);
    if (woke.action === 'FALLEN') {
      fs.closeSync(logFd);
      return Promise.resolve({ status: 'FAILED', class: 'STALL', reason: 'wake budget exhausted', workdir: dir, logPath: logFilePath, sessionId: opts.sessionId || null, exitCode: null });
    }
  }
  let usefulWork = false;
  let lastLogSize = 0;
  let childExited = false;
  let childExitCode = null;
  let failureClass = null;
  let failureReason = null;
  let unrecordedProcesses = [];

  const snapshot = opts.snapshotProcesses || snapshotProcesses;

  const lease = { supervisor: ownIdentity(), attempts: [] };
  const priorLease = readLease(slot.id, stateDir);
  if (priorLease) {
    // an attempt of this step that did not settle (a survivor, an unreadable table) is never launched past
    const open = priorLease.attempts.find(a => !a.settled);
    if (open) {
      fs.closeSync(logFd);
      if (!opts.keepWorkdirOnExit) dropWorkdir(dir);
      return Promise.resolve({ status: 'BLOCKED', class: 'POLICY_FAILURE', reason: `unsettled-attempt: ${open.unsettledReason || 'not settled'}`, workdir: dir, logPath: logFilePath, exitCode: null });
    }
    lease.attempts = priorLease.attempts.slice(-20);
  }

  const attempt = { root: { pid: null, createdAt: null }, descendants: [], unrecorded: [], settled: false };
  lease.attempts.push(attempt);
  let leaseError = null;
  // false when the lease could not be persisted: the caller then stops the attempt and fails with a stated class
  const persist = () => {
    try {
      writeLease(slot.id, stateDir, lease);
      return true;
    } catch (e) {
      leaseError = e.message;
      return false;
    }
  };
  // the intent is on disk before anything is launched: a crash between spawn and the first record is still an unsettled attempt
  if (!persist()) {
    fs.closeSync(logFd);
    if (!opts.keepWorkdirOnExit) dropWorkdir(dir);
    return Promise.resolve({ status: 'BLOCKED', class: 'POLICY_FAILURE', reason: leaseError, workdir: dir, logPath: logFilePath, exitCode: null });
  }

  // signature of what the supervisor can see changing: declared outputs (size+mtime) and new journals (size)
  const progressSignature = () => {
    const parts = [];
    for (const f of declaredOutputs) {
      try {
        const st = fs.statSync(path.join(dir, f));
        if (st.size > 0) parts.push(`${f}:${st.size}:${st.mtimeMs}`);
      } catch {}
    }
    const stNow = workdirState(dir);
    if (stNow) {
      for (const e of stNow.entries) {
        if (e.code !== '??' || !JOURNAL_RE.test(e.path)) continue;
        try { parts.push(`${e.path}:${fs.statSync(path.join(dir, e.path)).size}`); } catch {}
      }
    }
    return parts.sort();
  };

  return new Promise((resolve) => {
    let lastSignature = progressSignature();
    const child = spawn(cmdString, {
      cwd: dir,
      env,
      shell: true,
      stdio: ['ignore', logFd, logFd],
      windowsHide: true
    });

    knownProcs[child.pid] = Date.now();

    attempt.root = { pid: child.pid, createdAt: null };

    // identity of the launched process tree is recorded by PID + creation time, throttled (a read costs a process listing)
    const SNAPSHOT_EVERY_MS = 5000;
    let lastSnapshotAt = 0;
    const recordTree = (table) => {
      if (!table) return;
      const root = table.find(p => p.pid === child.pid);
      if (!root) return;
      attempt.root = { pid: root.pid, createdAt: root.createdAt };
      const known = new Map(attempt.descendants.map(d => [d.pid, d]));
      for (const d of descendantsOf(table, child.pid)) known.set(d.pid, d);
      attempt.descendants = [...known.values()];
      persist();
    };

    const VERIFY_TRIES = 4;
    const VERIFY_WAIT_MS = 300;
    const mergeIdentities = (have, more) => {
      const byPid = new Map((have || []).map(r => [r.pid, r]));
      for (const r of more || []) byPid.set(r.pid, r);
      return [...byPid.values()];
    };

    // Stop and settle, on every way out (stall, ceiling, natural exit): recorded descendants by PID (identity re-confirmed
    // in a fresh table), then the root through its handle; then a fresh table again, and the attempt settles only when the
    // root, every recorded descendant and every unrecorded process is gone by identity. An unreadable table never settles.
    let stopped = false;
    const stopAttempt = async () => {
      if (stopped) return;
      stopped = true;
      if (!child.pid) {
        attempt.settled = true;
        persist();
        return;
      }
      const table = snapshot();
      if (!table) {
        try { child.kill('SIGKILL'); } catch {}
        attempt.settled = false;
        attempt.unsettledReason = 'table-unavailable';
        persist();
        return;
      }
      // what the launched root has under it right now is recorded (identity, persisted) before anything is stopped, so a
      // client the periodic record had not reached yet is stopped like any other recorded descendant; only a process that
      // appears after this table, or an orphan of an already dead root, is unrecorded
      recordTree(table);
      const rootId = attempt.root;
      const plan = planStop({ root: rootId, recorded: attempt.descendants, table });
      for (const step of plan.steps) {
        if (step.op === 'kill-pid') killExact(step.pid);
        else { try { child.kill('SIGKILL'); } catch {} }
      }
      attempt.unrecorded = mergeIdentities(attempt.unrecorded, plan.unrecordedIdentities);

      let verdict = { verified: false, reason: 'table-unavailable', alive: [] };
      // nothing was stopped (the root had already exited and no recorded descendant is running): the table just read
      // is already the after-table, so the first verification does not read a second one
      const nothingStopped = (child.exitCode !== null || child.signalCode !== null) &&!plan.steps.some(s => s.op === 'kill-pid');
      for (let i = 0; i < VERIFY_TRIES; i++) {
        const after = i === 0 && nothingStopped ? table : snapshot();
        if (after) attempt.unrecorded = mergeIdentities(attempt.unrecorded, findUnrecorded({ root: rootId, recorded: attempt.descendants, table: after }));
        verdict = verifyStopped({ root: rootId, recorded: attempt.descendants, unrecorded: attempt.unrecorded, table: after });
        if (verdict.verified) break;
        // Yield so Node can reap its killed child and deliver exit (a Linux zombie can still match
        // PID + creation time until then). Never filter zombie rows: a root/descendant that remains
        // in the fresh table after all four checks is still unverified and keeps the attempt blocked.
        if (i < VERIFY_TRIES - 1) await new Promise(resolve => setTimeout(resolve, VERIFY_WAIT_MS));
      }
      unrecordedProcesses = attempt.unrecorded.map(r => r.pid);
      if (verdict.verified) {
        attempt.settled = true;
        delete attempt.unsettledReason;
      } else {
        attempt.settled = false;
        attempt.unsettledReason = verdict.alive.length ? `${verdict.reason}: ${verdict.alive.map(a => `${a.role}:${a.pid}`).join(',')}` : verdict.reason;
      }
      persist();
    };

    const getLogSize = () => {
      try { return fs.fstatSync(logFd).size; } catch { return 0; }
    };
    const getLogTail = (bytes = 16384) => {
      try {
        const sz = getLogSize();
        const readLen = Math.min(sz, bytes);
        const buf = Buffer.alloc(readLen);
        fs.readSync(logFd, buf, 0, readLen, sz - readLen);
        return buf.toString('utf8');
      } catch { return ''; }
    };

    const tickInterval = Math.max(50, Math.min(15000, Math.floor(limits.stallMs * 0.25), Math.floor(limits.hardMs * 0.25)));

    const timer = setInterval(() => {
      if (childExited) return;
      const curTime = Date.now();
      const curLogSize = getLogSize();
      const ownLines = [];

      if (curLogSize > lastLogSize) {
        const diffBytes = curLogSize - lastLogSize;
        const buf = Buffer.alloc(diffBytes);
        try {
          fs.readSync(logFd, buf, 0, diffBytes, lastLogSize);
          ownLines.push(...buf.toString('utf8').split(/\r?\n/));
        } catch {}
        lastLogSize = curLogSize;
      }

      const signature = progressSignature();
      const changed = signature.join('|') !== lastSignature.join('|');
      lastSignature = signature;
      if (signature.length) usefulWork = true;
      if (curLogSize >= 16384) usefulWork = true;

      const r = tracker.tick({
        now: curTime,
        ownLines,
        outputsChanged: changed,
        journalsChanged: false,
        heartbeat: false,
        treeMtimeChanged: false,
        cpuMs: 0
      });

      if (r.verdict === 'OK') {
        if (curTime - lastSnapshotAt >= SNAPSHOT_EVERY_MS) {
          lastSnapshotAt = curTime;
          recordTree(snapshot());
          if (leaseError) {
            clearInterval(timer);
            cleanupAndResolve();
          }
        }
        return;
      }
      if (r.verdict === 'TIMEOUT') {
        failureClass = 'TIMEOUT';
        failureReason = `elapsed time reached hardMin limit of ${Math.round(limits.hardMs / 1000)} seconds`;
      } else {
        failureClass = 'STALL';
        failureReason = `no progress for ${Math.round(limits.stallMs / 1000)} seconds`;
      }
      clearInterval(timer);
      cleanupAndResolve();
    }, tickInterval);

    async function cleanupAndResolve() {
      if (childExited) return;
      // This is the single stop caller. Claim cleanup and cancel ticks before yielding; an exit
      // during verification still updates childExitCode below, but cannot resolve a second time.
      childExited = true;
      clearInterval(timer);
      await stopAttempt();
      try { fs.closeSync(logFd); } catch {}
      const endTime = Date.now();
      const wallMinutes = Math.max(0, Number(((endTime - startTime) / 60000).toFixed(2)));
      const logText = getLogTail(32768);

      let extractedSessionId = tokens.sessionId;
      const sMatch = logText.match(/(?:SESSION_ID|session(?:_id)?|conversation):\s*(\S+)/i);
      if (sMatch) extractedSessionId = sMatch[1];

      if (leaseError || !attempt.settled) {
        // not clean: the step does not go on past a lease that was not persisted or a process that is still alive
        return resolve({
          status: 'BLOCKED',
          class: 'POLICY_FAILURE',
          reason: leaseError || `attempt-not-settled: ${attempt.unsettledReason}`,
          ...(failureClass ? { underlyingClass: failureClass } : {}),
          ...(unrecordedProcesses.length ? { unrecordedProcesses } : {}),
          wallMinutes,
          useful: usefulWork,
          attemptNumber,
          sessionId: extractedSessionId,
          workdir: dir,
          exitCode: childExitCode,
          logPath: logFilePath
        });
      }

      if (failureClass === 'STALL' || failureClass === 'TIMEOUT') {
        // R-L3-004.8: reaching the hard ceiling is TIMEOUT, the step is BLOCKED and never resumed
        const timedOut = failureClass === 'TIMEOUT';
        return resolve({
          status: timedOut ? 'BLOCKED' : 'FAILED',
          class: failureClass,
          reason: failureReason,
          ...(timedOut ? { resume: false } : {}),
          ...(unrecordedProcesses.length ? { unrecordedProcesses } : {}),
          wallMinutes,
          useful: usefulWork,
          attemptNumber,
          sessionId: extractedSessionId,
          workdir: dir,
          exitCode: childExitCode,
          logPath: logFilePath
        });
      }

      if (childExitCode === 0) {
        const missingOutputs = declaredOutputs.filter(f => !fs.existsSync(path.join(dir, f)) || fs.statSync(path.join(dir, f)).size === 0);
        if (missingOutputs.length) {
          return resolve({
            status: 'FAILED',
            class: 'INVALID_OUTPUT',
            reason: `declared outputs missing or empty: ${missingOutputs.join(', ')}`,
            wallMinutes,
            useful: usefulWork,
            attemptNumber,
            sessionId: extractedSessionId,
            workdir: dir,
            exitCode: childExitCode,
            logPath: logFilePath
          });
        }
      } else {
        const identifiedClass = classifyErrorText(logText);
        const cls = identifiedClass || 'PROCESS_CRASH';
        return resolve({
          status: 'FAILED',
          class: cls,
          reason: `process exited with code ${childExitCode}`,
          wallMinutes,
          useful: usefulWork,
          attemptNumber,
          sessionId: extractedSessionId,
          workdir: dir,
          exitCode: childExitCode,
          logPath: logFilePath
        });
      }

      const sc = scopeCheck(dir, base, declaredOutputs, knownProcs);
      if (sc && sc.bad) {
        return resolve({
          status: 'BLOCKED',
          class: 'POLICY_FAILURE',
          reason: `SCOPE_STOP: ${sc.bad.join('; ')}`,
          workdirKept: dir,
          wallMinutes,
          useful: usefulWork,
          attemptNumber,
          sessionId: extractedSessionId,
          workdir: dir,
          exitCode: childExitCode,
          logPath: logFilePath
        });
      }

      const auditAfter = lsRemoteSnapshot(repoRoot);
      const auditVerdict = remoteAuditVerdict(auditBefore, auditAfter);
      if (auditVerdict.incident.length) {
        return resolve({
          status: 'BLOCKED',
          class: 'POLICY_FAILURE',
          reason: `REMOTE_INCIDENT: ${auditVerdict.incident.join('; ')}`,
          workdirKept: dir,
          wallMinutes,
          useful: usefulWork,
          attemptNumber,
          sessionId: extractedSessionId,
          workdir: dir,
          exitCode: childExitCode,
          logPath: logFilePath
        });
      }

      return resolve({
        status: 'DONE',
        class: null,
        reason: null,
        wallMinutes,
        useful: true,
        attemptNumber,
        sessionId: extractedSessionId,
        workdir: dir,
        exitCode: childExitCode,
        logPath: logFilePath
      });
    }

    child.on('exit', (code, signal) => {
      childExitCode = code !== null ? code : (signal ? -1 : 0);
      cleanupAndResolve();
    });

    child.on('error', (err) => {
      childExitCode = -1;
      failureClass = 'CONFIG_ERROR';
      failureReason = `spawn error: ${err.message}`;
      cleanupAndResolve();
    });

    // the launched root is on disk now; if that cannot be written the attempt is stopped here, with the stated class
    if (!persist()) {
      clearInterval(timer);
      cleanupAndResolve();
    }
  });
}

function updateUsageFile(usageFilePath, repoRoot = getRepoRoot(), runsFilePath = null) {
  if (!usageFilePath || !runrecordLib) return;
  try {
    const fullRuns = runsFilePath || (process.env.PROTOCOL_RUNS_FILE
      ? path.resolve(repoRoot, process.env.PROTOCOL_RUNS_FILE)
      : path.resolve(repoRoot, 'docs/ops/RUNS.jsonl'));
    if (!fs.existsSync(fullRuns)) return;
    const records = runrecordLib.readRecords(fullRuns);
    const rendered = runrecordLib.renderUsage(records);
    fs.mkdirSync(path.dirname(usageFilePath), { recursive: true });
    fs.writeFileSync(usageFilePath, rendered, 'utf8');
  } catch {}
}

function emitFallSignal(signalsFile, runId, client, model, startIso, endIso, isNoResumeGap, repoRoot) {
  try {
    const signalsBin = path.join(repoRoot, '.ai', 'bin', 'protocol-signals.cjs');
    if (!fs.existsSync(signalsBin)) return;
    const { addSignal } = require(signalsBin);
    const rawParticipant = `${client || 'unknown'}:${model || 'unknown'}`;
    const participant = rawParticipant.replace(/[^A-Za-z0-9._:\/@-]/g, '-').slice(0, 80);
    const startMs = new Date(startIso).getTime();
    const endMs = new Date(endIso).getTime();
    const minutes = isNaN(startMs) || isNaN(endMs) ? 0 : Math.max(0, Math.floor((endMs - startMs) / 60000));
    const evidence = `docs/ops/RUNS.jsonl#${runId}`;

    addSignal(signalsFile, {
      type: 'fall',
      participant,
      evidence,
      cost: `minutes=${minutes}`
    });

    if (isNoResumeGap) {
      addSignal(signalsFile, {
        type: 'procedure-gap',
        participant,
        evidence,
        cost: 'unknown'
      });
    }
  } catch (err) {
    console.log(`ERROR reason=signal-append-failed runId=${runId} error="${err.message}"`);
  }
}

module.exports = {
  takeStartLock,
  startRefusalReason,
  startRefusalDetail,
  leaseStartDecision,
  forceSettle,
  attemptsNeedingAck,
  readLease,
  writeLease,
  LeaseWriteError,
  releaseStartLock,
  checkCompletion,
  chunkIsProgress,
  classifyErrorText,
  executeAttempt,
  writeRepairFile,
  mapClassForRunRecord,
  FAILURE_CLASSES,
  ERROR_PATTERNS,
  ERROR_TEXT,
  RETRY_TEXT,
  updateUsageFile,
  emitFallSignal
};

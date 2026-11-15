'use strict';
// LOOP-RUNNER lpr1: supervision of the operator loops of the pure landed policy
// .ai/bin/lib/loop-supervisor.cjs (the LOOPS list there includes route-refresh).
// Every admission is serialized by a mkdir lock, decided on a complete fresh OS snapshot
// (PID plus exact creation time, never the PID alone) and started only from the command
// declared in the ops-tools config; there is no free command text on this command line.
// A launch token is published before spawn: a crash between spawn and the record write
// leaves a token that blocks the next start until the operator inspects the host.
// Stop re-verifies each recorded identity against a fresh filtered snapshot immediately
// before its signal and signals only recorded identities (never a process tree: a queue
// child may have become an independent seat). State is diagnostics, never Evidence.
// Layer: ops-tools command; docs/ops/PROCESS-REGISTER.md P-213. Node builtins only.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const policy = require('../lib/loop-supervisor.cjs');
const snap = require('./lib/loop-snapshot.cjs');
const protectedPaths = require('../lib/protected-paths.cjs');
const safe = require('../lib/path-safe.cjs');

const CONFIG = require('./lib/config.cjs');
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SAFE_WORD = /^-?[A-Za-z0-9][A-Za-z0-9._-]*$/; // one argv token without shell metacharacters
const SAFE_SCRIPT = /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const MAX_ARGV = 8;
const MAX_CHILDREN = 512; // the children bound of the policy record (loop-supervisor MAX_CHILDREN)
const fail = code => { throw Object.assign(new Error(code), { code }); };
const refuseProtected = value => { if (typeof value === 'string' && protectedPaths.hasProtectedName(value)) fail('LOOP-REFUSED-PROTECTED-PATH'); };

// The declared loops section: stateDir is one safe name under the work root; every
// command key is a policy loop id; argv tokens carry no shell metacharacters and the
// last token is a relative script path that must resolve inside the work root.
function validateLoopsSection(loops) {
  if (!loops || typeof loops !== 'object' || Array.isArray(loops)) fail('LOOP-CONFIG-INVALID');
  if (typeof loops.stateDir !== 'string' || !SAFE_SEGMENT.test(loops.stateDir)) fail('LOOP-CONFIG-INVALID');
  const commands = loops.commands;
  if (!commands || typeof commands !== 'object' || Array.isArray(commands)) fail('LOOP-CONFIG-INVALID');
  const out = {};
  for (const [name, argv] of Object.entries(commands)) {
    if (!policy.LOOPS.includes(name)) fail('LOOP-CONFIG-INVALID');
    if (!Array.isArray(argv) || argv.length < 2 || argv.length > MAX_ARGV) fail('LOOP-CONFIG-INVALID');
    for (const token of argv.slice(0, -1)) if (typeof token !== 'string' || !SAFE_WORD.test(token)) fail('LOOP-CONFIG-INVALID');
    const script = argv[argv.length - 1];
    if (typeof script !== 'string' || !SAFE_SCRIPT.test(script) || script.split('/').includes('..')) fail('LOOP-CONFIG-INVALID');
    refuseProtected(script);
    out[name] = Object.freeze([...argv]);
  }
  return { stateDir: loops.stateDir, commands: out };
}

function guarded(stateDir, root, name) {
  refuseProtected(name);
  const got = safe.realInside(root, path.join(stateDir, name), { refuseHardlinks: true });
  if (!got.ok) fail('LOOP-REFUSED-PATH');
  return got.real;
}

function readRecord(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; return { schema: 'loop-runner/unreadable' }; }
  try { return JSON.parse(text); } catch { return { schema: 'loop-runner/unreadable' }; }
}

function writeRecord(file, stateDir, record) {
  const written = safe.writeAtomicGuarded(file, Buffer.from(`${JSON.stringify(record, null, 1)}\n`), { root: stateDir });
  if (!written.ok || written.closeError) fail('LOOP-RECORD-WRITE-FAILED');
}

function main(argv, deps = {}) {
  const env = deps.env || process.env;
  const stdout = deps.stdout || (s => process.stdout.write(s));
  const stderr = deps.stderr || (s => process.stderr.write(s));
  const now = deps.now || (() => Date.now());
  const host = deps.host || os.hostname();
  try {
    const args = [];
    let root = process.cwd();
    for (let i = 0; i < argv.length; i++) {
      const a = argv[i];
      if (a === '--help') { stdout('usage: loops.cjs status [NAME] | start NAME | stop NAME [--root DIR]\n'); return 0; }
      if (a === '--root') { if (!argv[i + 1] || argv[i + 1].startsWith('--')) fail('LOOP-USAGE'); root = argv[++i]; }
      else if (!a.startsWith('-')) args.push(a);
      else fail('LOOP-USAGE');
    }
    const action = args[0], name = args[1];
    if (!['status', 'start', 'stop'].includes(action) || args.length > 2 || (action !== 'status' && !name) || (action === 'status' && args.length > 2)) fail('LOOP-USAGE');
    if (name !== undefined && !policy.LOOPS.includes(name)) fail('LOOP-UNKNOWN');
    refuseProtected(root);
    for (const value of [env.PROTOCOL_OPS_WORK_ROOT]) refuseProtected(value);
    const cfg = deps.config || CONFIG.load({ root: path.resolve(root), env });
    refuseProtected(cfg.workRoot);
    const loops = validateLoopsSection(cfg.config && cfg.config.loops);
    const stateDir = guarded(cfg.workRoot, cfg.workRoot, loops.stateDir);
    const selfPid = process.pid;
    const takeSnapshot = () => deps.snapshot ? deps.snapshot() : snap.collect({ host, selfPid, env });
    const takeFiltered = pid => deps.snapshotOne ? deps.snapshotOne(pid) : snap.collect({ host, selfPid, pids: [pid], env });
    const killOne = pid => deps.kill ? deps.kill(pid) : defaultKill(pid, env);
    const names = name ? [name] : policy.LOOPS;
    if (action === 'status') return status({ names, stateDir, host, now, takeSnapshot, stdout });
    if (!loops.commands[name]) fail('LOOP-UNDECLARED');
    if (action === 'stop' && !fs.existsSync(stateDir)) { stdout(`LOOP ${name} BLOCKED RECORD_REQUIRED\n`); return 2; }
    if (action === 'start') fs.mkdirSync(stateDir, { recursive: true });
    return action === 'start'
      ? start({ name, loops, cfg, stateDir, host, now, takeSnapshot, killOne, stdout, spawn: deps.spawn || spawn })
      : stop({ name, stateDir, host, now, takeSnapshot, takeFiltered, killOne, stdout });
  } catch (e) {
    stderr(`${e.code && /^LOOP-/.test(e.code) ? e.code : 'LOOP-ERROR'}\n`);
    return 2;
  }
}

function verdictOf(record, table, host, loop, nowMs) {
  const start = policy.assessStart({ record, table, host, loop, nowMs });
  if (start.status === 'BLOCKED') return { state: 'BLOCKED', reason: start.reason, start }; // an unverified table or an invalid record is never absence
  if (record === null) return { state: 'ABSENT', start };
  if (start.status === 'DUPLICATE') return { state: 'RUNNING', start };
  return { state: 'DEAD', start }; // STARTABLE with a record: every recorded identity is gone
}

function status({ names, stateDir, host, now, takeSnapshot, stdout }) {
  const table = takeSnapshot(); // status always decides on one complete fresh OS snapshot
  const nowMs = now();
  if (!table) { stdout('LOOP-STATUS UNKNOWN: no complete fresh OS snapshot\n'); return 2; }
  const hasState = fs.existsSync(stateDir);
  const counts = { RUNNING: 0, DEAD: 0, ABSENT: 0, BLOCKED: 0 };
  for (const loop of names) {
    const record = hasState ? readRecord(guarded(stateDir, stateDir, `${loop}.json`)) : null;
    let v = verdictOf(record, table, host, loop, nowMs);
    if (v.state === 'ABSENT' && hasState && fs.existsSync(guarded(stateDir, stateDir, `${loop}.launching`))) {
      v = { state: 'BLOCKED', reason: 'LAUNCH_UNFINISHED', start: v.start }; // a leftover launch token is not absence
    }
    counts[v.state]++;
    const detail = v.state === 'RUNNING' ? ` pid=${record.runner.pid} runId=${record.runId}` : v.state === 'BLOCKED' ? ` ${v.reason}` : '';
    stdout(`LOOP ${loop} ${v.state}${detail}\n`);
  }
  stdout(`LOOP-STATUS loops=${names.length} running=${counts.RUNNING} dead=${counts.DEAD} absent=${counts.ABSENT} blocked=${counts.BLOCKED}\n`);
  return 0;
}

function acquireLock(stateDir, name) {
  const dir = guarded(stateDir, stateDir, `${name}.lock`);
  try { fs.mkdirSync(dir); } catch { return null; } // EEXIST: another admission is serialized first
  fs.writeFileSync(path.join(dir, 'owner.json'), `${JSON.stringify({ pid: process.pid, at: new Date().toISOString() })}\n`);
  return {
    release() {
      try { fs.unlinkSync(path.join(dir, 'owner.json')); } catch { /* the lock dir removal still follows */ }
      try { fs.rmdirSync(dir); } catch { /* a foreign token inside keeps the lock visible */ }
    },
  };
}

function start({ name, loops, cfg, stateDir, host, now, takeSnapshot, killOne, stdout, spawn }) {
  const runId = crypto.randomBytes(16).toString('hex');
  const tokenFile = guarded(stateDir, stateDir, `${name}.launching`);
  let token;
  try { token = fs.openSync(tokenFile, 'wx'); } catch { stdout(`LOOP ${name} BLOCKED LAUNCH_UNFINISHED\n`); return 2; }
  fs.writeFileSync(token, `${JSON.stringify({ schema: 'loop-launch/1', loop: name, runId, pid: process.pid, at: new Date().toISOString() })}\n`);
  fs.closeSync(token);
  const dropToken = () => { try { fs.unlinkSync(tokenFile); } catch { /* already gone */ } };
  const lock = acquireLock(stateDir, name);
  if (!lock) { dropToken(); stdout(`LOOP ${name} BLOCKED LOCKED\n`); return 2; }
  try {
    const table = takeSnapshot();
    if (!table) { dropToken(); stdout(`LOOP ${name} BLOCKED SNAPSHOT_UNAVAILABLE\n`); return 2; }
    const record = readRecord(guarded(stateDir, stateDir, `${name}.json`));
    const verdict = policy.assessStart({ record, table, host, loop: name, nowMs: now() });
    if (verdict.status !== 'STARTABLE') { dropToken(); stdout(`LOOP ${name} ${verdict.status} ${verdict.reason}\n`); return 2; }
    const argv = loops.commands[name];
    const script = guarded(cfg.workRoot, cfg.workRoot, argv[argv.length - 1]);
    if (!fs.existsSync(script) || !fs.statSync(script).isFile()) { dropToken(); stdout(`LOOP ${name} BLOCKED SCRIPT_MISSING\n`); return 2; }
    const log = fs.openSync(guarded(stateDir, stateDir, `${name}.log`), 'a');
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd: cfg.workRoot, detached: true, shell: false, windowsHide: true, stdio: ['ignore', log, log] });
    } catch { fs.closeSync(log); dropToken(); stdout(`LOOP ${name} BLOCKED SPAWN_FAILED\n`); return 2; }
    fs.closeSync(log);
    child.on('error', () => { /* an async spawn failure leaves no pid; the identity check below refuses */ });
    child.unref();
    if (!child.pid) { dropToken(); stdout(`LOOP ${name} BLOCKED SPAWN_FAILED\n`); return 2; }
    const fresh = takeSnapshot(); // a second complete snapshot establishes the runner identity
    const runner = fresh && fresh.processes.find(r => r.pid === child.pid);
    if (!runner) {
      // Never leave an unsupervised loop behind, yet never signal an unproven identity by
      // its pid (that pid may already name a foreign process): stop only the process this
      // call spawned, through its own handle.
      try { child.kill(); } catch { /* no handle left: nothing of this call to stop */ }
      stdout(`LOOP ${name} BLOCKED IDENTITY_UNKNOWN\n`);
      return 2; // the launch token stays: the crash window is operator-visible
    }
    const children = (fresh.byPpid && fresh.byPpid.get(runner.pid)) || [];
    if (children.length > MAX_CHILDREN) { killOne(child.pid); stdout(`LOOP ${name} BLOCKED CHILDREN_OVERFLOW\n`); return 2; }
    writeRecord(guarded(stateDir, stateDir, `${name}.json`), stateDir,
      { schema: policy.SCHEMA, loop: name, host, runId, runner, children });
    dropToken();
    stdout(`LOOP ${name} STARTED pid=${runner.pid} runId=${runId}\n`);
    return 0;
  } finally { lock.release(); }
}

function stop({ name, stateDir, host, now, takeSnapshot, takeFiltered, killOne, stdout }) {
  const lock = acquireLock(stateDir, name);
  if (!lock) { stdout(`LOOP ${name} BLOCKED LOCKED\n`); return 2; }
  try {
    const table = takeSnapshot();
    if (!table) { stdout(`LOOP ${name} BLOCKED SNAPSHOT_UNAVAILABLE\n`); return 2; }
    const recordFile = guarded(stateDir, stateDir, `${name}.json`);
    const record = readRecord(recordFile);
    // A stop signals only after the policy has judged THIS record on THIS table: the two
    // "still alive" verdicts confirm a verified record and table; every other BLOCKED
    // (absent, unreadable or invalid record, unverified table) refuses with zero signals.
    const pre = policy.assessStopped({ record, table, host, loop: name, nowMs: now() });
    if (pre.status === 'BLOCKED' && pre.reason !== 'RUNNER_SURVIVES' && pre.reason !== 'CHILD_SURVIVES') {
      stdout(`LOOP ${name} ${pre.status} ${pre.reason}\n`);
      return 2; // no signals: the record names no verified identities
    }
    for (const identity of [record.runner, ...record.children]) {
      const check = takeFiltered(identity.pid); // identity re-verified immediately before the signal
      const row = check && check.processes.find(r => r.pid === identity.pid);
      if (row && row.created === identity.created) killOne(identity.pid);
    }
    const finalTable = takeSnapshot();
    if (!finalTable) { stdout(`LOOP ${name} BLOCKED SNAPSHOT_UNAVAILABLE\n`); return 2; }
    const verdict = policy.assessStopped({ record, table: finalTable, host, loop: name, nowMs: now() });
    if (verdict.status !== 'STOPPED') { stdout(`LOOP ${name} ${verdict.status} ${verdict.reason}\n`); return 2; }
    fs.unlinkSync(recordFile); // a verified stop retires the record; the next start is NO_RECORD
    stdout(`LOOP ${name} STOPPED\n`);
    return 0;
  } finally { lock.release(); }
}

function defaultKill(pid, env) {
  if (process.platform !== 'win32' || !env.SystemRoot) return false;
  const exe = path.join(env.SystemRoot, 'System32', 'taskkill.exe');
  const r = spawnSync(exe, ['/PID', String(pid), '/F'], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 10000 });
  return !r.error && r.status === 0;
}

module.exports = { main, validateLoopsSection, readRecord, verdictOf, SAFE_WORD, SAFE_SCRIPT };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

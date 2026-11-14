'use strict';
// Detached commands are diagnostics only. Evidence remains owned by protocol-handoff.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const safe = require('./lib/path-safe.cjs');
const fail = reason => { throw Error(`protocol-bg: ${reason}`); };
const id = () => crypto.randomBytes(16).toString('hex');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function nameOf(name) {
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,59}$/.test(name) || safe.segmentProblem(name)) fail('name-refused');
  return name;
}
function guard(root, rel) {
  const g = safe.realInside(root, rel, { refuseHardlinks: true });
  if (!g.ok) fail(`path-${g.reason}`);
  return g.real;
}
function mkdir(root, rel) {
  let result;
  const parts = rel.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const target = guard(root, parts.slice(0, i).join('/'));
    const g = safe.mkdirGuarded(root, target);
    if (!g.ok) {
      const after = safe.realInside(root, target);
      if (!after.ok || after.type !== 'dir') fail(`path-${g.reason}`);
    }
    result = target;
  }
  return result;
}
function write(root, rel, value) {
  const r = safe.writeAtomicGuarded(guard(root, rel), Buffer.from(JSON.stringify(value) + '\n'), { root });
  if (!r.ok) fail(`path-write-${r.reason}`);
}
function read(root, rel) {
  const file = guard(root, rel);
  const before = fs.lstatSync(file, { bigint: true });
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const st = fs.fstatSync(fd, { bigint: true });
    if (!st.isFile() || st.nlink !== 1n || st.ino !== before.ino || st.dev !== before.dev || st.size > 16384n) fail('state-invalid-or-too-large');
    const bytes = Buffer.alloc(Number(st.size));
    if (fs.readSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) fail('state-partial');
    const after = fs.fstatSync(fd, { bigint: true });
    const named = fs.lstatSync(guard(root, rel), { bigint: true });
    if (st.ino !== named.ino || st.dev !== named.dev || st.size !== after.size || st.mtimeNs !== after.mtimeNs || st.ctimeNs !== after.ctimeNs) fail('state-swapped');
    return JSON.parse(bytes.toString('utf8'));
  } finally { fs.closeSync(fd); }
}
function executable(command) {
  if (command === 'node') return process.execPath;
  if (typeof command !== 'string' || !path.isAbsolute(command) || /[\x00-\x1f]/.test(command) ||
    /\.(?:cmd|bat|ps1|sh|js|cjs|mjs)$/i.test(command) || /^(?:cmd|powershell|pwsh|sh|bash|wscript|cscript)(?:\.exe)?$/i.test(path.basename(command)) ||
    (process.platform === 'win32' && !/\.exe$/i.test(command))) fail('executable-native-required');
  const st = fs.lstatSync(command);
  if (!st.isFile() || st.isSymbolicLink()) fail('executable-native-required');
  const fd = fs.openSync(command, 'r');
  try {
    const magic = Buffer.alloc(4); fs.readSync(fd, magic, 0, 4, 0);
    const native = process.platform === 'win32' ? magic.subarray(0, 2).toString('ascii') === 'MZ' :
      process.platform === 'linux' ? magic.equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) :
        ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe'].includes(magic.toString('hex'));
    if (!native) fail('executable-native-required');
  } finally { fs.closeSync(fd); }
  return fs.realpathSync(command);
}
function runtime(root) {
  root = fs.realpathSync(root);
  mkdir(root, '.ai/runtime/command-runs/names'); mkdir(root, '.ai/runtime/command-runs/claims');
  return root;
}
function claim(root, rel, reason) {
  const file = guard(root, rel);
  try { fs.mkdirSync(file); } catch (e) { if (e.code === 'EEXIST') fail(reason); throw e; }
  guard(root, rel);
}
const prefix = name => `.ai/runtime/command-runs/names/${nameOf(name)}`;
function validateRun(run, name) {
  if (!run || run.schema !== 'command-run/1' || run.name !== name || !/^[a-f0-9]{32}$/.test(run.runId) ||
    !/^[a-f0-9]{64}$/.test(run.key) || !Number.isFinite(run.startedMs) || !Array.isArray(run.argv) || !run.argv.length ||
    run.argv.some(s => typeof s !== 'string' || s.includes('\0'))) fail('run-invalid');
  return run;
}
function validateTerminal(t, runId) {
  if (!t || t.runId !== runId || typeof t.endedAt !== 'string' || !Number.isFinite(Date.parse(t.endedAt))) fail('terminal-invalid');
  const keys = Object.keys(t).sort().join();
  if (t.kind === 'exit' && keys === 'code,endedAt,kind,runId' && Number.isInteger(t.code) && t.code >= 0 && t.code <= 0xffffffff) return t;
  if (t.kind === 'signal' && keys === 'endedAt,kind,runId,signal' && typeof t.signal === 'string' && /^SIG[A-Z0-9]+$/.test(t.signal)) return t;
  if (t.kind === 'spawn-error' && keys === 'endedAt,error,kind,runId' && typeof t.error === 'string' && /^[A-Z0-9_]+$/.test(t.error)) return t;
  if (t.kind === 'lost' && keys === 'code,endedAt,kind,runId' && t.code === null) return t;
  fail('terminal-invalid');
}
function start(root, name, argv) {
  nameOf(name);
  if (!Array.isArray(argv) || !argv.length || argv.some(s => typeof s !== 'string' || s.includes('\0')) || Buffer.byteLength(JSON.stringify(argv)) > 12000) fail('argv-invalid');
  argv = [executable(argv[0]), ...argv.slice(1)];
  root = runtime(root);
  if (fs.existsSync(guard(root, prefix(name)))) fail('name-used');
  const cwd = process.platform === 'win32' ? root.toLowerCase() : root;
  const key = hash(JSON.stringify([cwd, argv]));
  // Immutable generations, serialized by exclusive mkdir. An uncertain generation
  // is never reclaimed. A proven terminal permits the next generation only.
  const base = `.ai/runtime/command-runs/claims/${key}`;
  mkdir(root, base);
  let generation = 0;
  while (fs.existsSync(guard(root, `${base}/${generation}`))) {
    let previous;
    try { previous = read(root, `${base}/${generation}/owner.json`); } catch { fail('command-claimed-unknown'); }
    let terminal;
    try {
      const prior = validateRun(read(root, `${prefix(previous.name)}/run.json`), previous.name);
      if (prior.runId !== previous.runId || prior.key !== key) fail('claim-owner-mismatch');
      inspect(root, previous.name, prior);
      terminal = read(root, `${prefix(previous.name)}/terminal.json`); validateTerminal(terminal, previous.runId);
    }
    catch { fail('command-claimed-running-or-unknown'); }
    generation++;
    if (generation > 10000) fail('claim-limit');
  }
  claim(root, `${base}/${generation}`, 'command-claimed-running-or-unknown');
  const run = { schema: 'command-run/1', name, runId: id(), key, argv, startedMs: Date.now() };
  // Reserve the immutable name after the command claim. A crash leaves a refusal,
  // never an automatic retry that could duplicate a record.
  claim(root, prefix(name), 'name-used');
  write(root, `${base}/${generation}/owner.json`, { name, runId: run.runId });
  write(root, `${prefix(name)}/run.json`, run);
  const p = spawn(process.execPath, [__filename, '_supervise', name, run.runId], { cwd: root, env: process.env, detached: true, shell: false, windowsHide: true, stdio: 'ignore' });
  p.on('error', e => write(root, `${prefix(name)}/terminal.json`, { runId: run.runId, kind: 'spawn-error', error: e.code || 'UNKNOWN', endedAt: new Date().toISOString() }));
  p.unref();
  return { state: 'STARTED', name, runId: run.runId };
}
function processRows(pids = []) {
  // Bounded OS query: identity means PID AND creation time, never kill(pid,0).
  pids = [...new Set([process.pid, ...pids].filter(p => Number.isSafeInteger(p) && p > 0))];
  if (process.platform === 'linux') {
    const rows = [];
    try {
      const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
      if (!boot) return null;
      for (const pid of pids) {
        let raw;
        try { raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); }
        catch (e) { if (e.code === 'ENOENT' || e.code === 'ESRCH') continue; return null; }
        const fields = raw.slice(raw.lastIndexOf(')') + 2).trim().split(/\s+/);
        if (!/^\d+$/.test(fields[19] || '')) return null;
        rows.push({ pid, ppid: Number(fields[1]), createdAt: `${boot}:ticks:${fields[19]}` });
      }
      return rows.some(r => r.pid === process.pid) ? rows : null;
    } catch { return null; }
  }
  if (process.platform !== 'win32') return require('./protocol-dispatch/procfs.cjs').snapshotProcesses();
  if (!process.env.SystemRoot) return null;
  const ps = path.join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const filter = pids.map(pid => `ProcessId=${pid}`).join(' OR ');
  const script = `Get-CimInstance Win32_Process -Filter '${filter}' -ErrorAction Stop | ForEach-Object { if ($_.CreationDate) { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, $_.CreationDate.ToUniversalTime().ToString('o', [cultureinfo]::InvariantCulture) } else { 'UNREADABLE' } }`;
  const r = spawnSync(ps, ['-NoProfile', '-NonInteractive', '-Command', script], { shell: false, windowsHide: true, encoding: 'utf8', timeout: 3000, maxBuffer: 1024 * 1024 });
  if (r.error || r.status !== 0) return null;
  const matches = r.stdout.trim().split(/\r?\n/).map(l => /^(\d+) (\d+) (\S+)$/.exec(l));
  if (matches.some(m => !m)) return null;
  const rows = matches.map(m => ({ pid: Number(m[1]), ppid: Number(m[2]), createdAt: m[3] }));
  return rows.some(r => r.pid === process.pid) ? rows : null;
}
function statusOf(identity, { rows } = {}) {
  if (!identity || !Number.isSafeInteger(identity.pid) || identity.pid <= 0 || typeof identity.createdAt !== 'string' || !identity.createdAt || !Array.isArray(rows)) return 'UNKNOWN';
  const matches = rows.filter(r => r?.pid === identity.pid);
  if (matches.length > 1 || matches.some(r => typeof r.createdAt !== 'string' || !r.createdAt)) return 'UNKNOWN';
  return matches.some(r => r.createdAt === identity.createdAt) ? 'RUNNING' : 'LOST';
}
function supervise(root, name, runId) {
  root = runtime(root);
  const rel = prefix(name), run = validateRun(read(root, `${rel}/run.json`), name);
  if (run.runId !== runId) fail('run-mismatch');
  claim(root, `${rel}/supervisor`, 'supervisor-used');
  const identity = processRows()?.find(r => r.pid === process.pid) || null;
  write(root, `${rel}/identity.json`, { runId, identity });
  // Fail closed before the command when the OS cannot supply start identity.
  if (!identity) {
    write(root, `${rel}/terminal.json`, { runId, kind: 'spawn-error', error: 'IDENTITY_UNAVAILABLE', endedAt: new Date().toISOString() });
    return;
  }
  const fd = fs.openSync(guard(root, `${rel}/output.log`), 'ax');
  let child;
  const finish = terminal => write(root, `${rel}/terminal.json`, { runId, ...terminal, endedAt: new Date().toISOString() });
  try { child = spawn(run.argv[0], run.argv.slice(1), { cwd: root, env: process.env, shell: false, windowsHide: true, stdio: ['ignore', fd, fd] }); }
  catch (e) { fs.closeSync(fd); finish({ kind: 'spawn-error', error: e.code || 'UNKNOWN' }); return; }
  fs.closeSync(fd);
  let spawnError = null;
  child.on('error', e => { spawnError = e.code || 'UNKNOWN'; });
  child.on('close', (code, signal) => finish(spawnError ? { kind: 'spawn-error', error: spawnError } : signal ? { kind: 'signal', signal } : Number.isInteger(code) ? { kind: 'exit', code } : { kind: 'spawn-error', error: 'NO_EXIT_CODE' }));
  if (Number.isSafeInteger(child.pid)) {
    // Persist the PID before the bounded query. A crash in either spawn window
    // leaves uncertainty, which recovery treats as a live orphan, never a retry.
    write(root, `${rel}/child.json`, { runId, pid: child.pid, identity: null });
    const row = processRows([child.pid])?.find(r => r.pid === child.pid && r.ppid === process.pid) || null;
    write(root, `${rel}/child.json`, { runId, pid: child.pid, identity: row });
  }
}
function terminalResult(t) {
  if (t.kind === 'exit') return { state: 'EXIT', childExitCode: t.code };
  if (t.kind === 'lost') return { state: 'LOST', kind: 'BG-LOST', childExitCode: t.code };
  return { state: 'FAILED', kind: t.kind, signal: t.signal, error: t.error };
}
function inspect(root, name, run, rowsOf = processRows) {
  const rel = prefix(name);
  const terminal = () => fs.existsSync(guard(root, `${rel}/terminal.json`)) ?
    terminalResult(validateTerminal(read(root, `${rel}/terminal.json`), run.runId)) : null;
  const done = terminal();
  if (done) return done;
  const bound = file => {
    try { const r = read(root, `${rel}/${file}.json`); if (r.runId !== run.runId) fail('identity-mismatch'); return r; }
    catch (e) { if (e.code !== 'ENOENT') throw e; return null; }
  };
  const supervisor = bound('identity');
  if (!supervisor) {
    const after = terminal();
    if (after) return after;
    const state = Date.now() - run.startedMs < 10000 ? 'RUNNING' : 'ORPHAN-RUNNING';
    if (state === 'ORPHAN-RUNNING') write(root, `${rel}/recovery.json`, { runId: run.runId, state, childState: 'UNKNOWN', observedAt: new Date().toISOString() });
    return { state, reason: 'supervisor-identity-unavailable' };
  }
  const child = bound('child');
  const rows = rowsOf([supervisor.identity?.pid, child?.pid]);
  const state = statusOf(supervisor.identity, { rows });
  // A terminal may have appeared during the OS query; it always wins.
  const after = terminal();
  if (after) return after;
  if (state !== 'LOST') return { state };
  if (child?.identity && child.identity.pid !== child.pid) fail('child-identity-mismatch');
  const childState = statusOf(child?.identity, { rows });
  if (childState !== 'LOST') {
    const observation = { runId: run.runId, state: 'ORPHAN-RUNNING', childState, observedAt: new Date().toISOString() };
    write(root, `${rel}/recovery.json`, observation);
    return { state: observation.state, childState };
  }
  // Only absence of the exact child identity permits another generation.
  // A lost supervisor has no reliable exit result; null can never mean success.
  const lost = { runId: run.runId, kind: 'lost', code: null, endedAt: new Date().toISOString() };
  write(root, `${rel}/terminal.json`, lost);
  return terminalResult(lost);
}
function tail(root, file, io = fs) {
  file = guard(root, file);
  let fd;
  try {
    fd = io.openSync(file, 'r');
    const size = io.fstatSync(fd).size, count = Math.min(size, 8192), buf = Buffer.alloc(count);
    const n = io.readSync(fd, buf, 0, count, size - count);
    return buf.subarray(0, n).toString('utf8').split(/\r?\n/).slice(-60).join('\n');
  } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
  finally { if (fd !== undefined) io.closeSync(fd); }
}
function poll(probe, budget, deps = {}) {
  const now = deps.now || Date.now, sleep = deps.sleep || (ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms));
  const end = now() + budget;
  while (true) {
    const r = probe();
    if (r.state !== 'RUNNING' || now() >= end) return r;
    sleep(Math.min(1000, end - now()));
  }
}
function wait(root, name, { seconds = 20 } = {}) {
  if (!Number.isInteger(seconds) || seconds < 0 || seconds > 20) fail('seconds-0-to-20-required');
  root = fs.realpathSync(root);
  const rel = prefix(name), run = validateRun(read(root, `${rel}/run.json`), name);
  const probe = () => inspect(root, name, run);
  // Reserve OS-query headroom under a 30-second client shell boundary.
  const result = poll(probe, Math.max(0, seconds * 1000 - 4000));
  return { ...result, name, runId: run.runId, tail: tail(root, `${rel}/output.log`) };
}
function main(args) {
  const [cmd, name, ...rest] = args;
  let r;
  if (cmd === 'start' && rest[0] === '--') r = start(process.cwd(), name, rest.slice(1));
  else if (cmd === 'wait' && (!rest.length || (rest.length === 2 && rest[0] === '--seconds' && /^\d+$/.test(rest[1])))) r = wait(process.cwd(), name, { seconds: rest.length ? Number(rest[1]) : 20 });
  else if (cmd === '_supervise' && rest.length === 1) { supervise(process.cwd(), name, rest[0]); return 0; }
  else fail('usage start NAME -- EXECUTABLE ARGS | wait NAME [--seconds 0..20]');
  console.log(JSON.stringify(r));
  return ['FAILED', 'LOST', 'UNKNOWN', 'ORPHAN-RUNNING'].includes(r.state) ? 3 : 0;
}
module.exports = { start, wait, tail, poll, statusOf, validateTerminal, executable, claim, inspect, main };
if (require.main === module) { try { process.exitCode = main(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exitCode = 2; } }

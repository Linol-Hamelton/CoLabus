'use strict';
// The persistent reparse-query helper of the installer destination guard (Windows only): one helper process per run,
// started on the first query. It decides exactly one thing: the entry named by the absolute path the guard checks is not
// a reparse point (the answer 4390 to the request just sent). Every other answer, any doubt and any failure return "not
// decided" with a reason, and the caller asks its own per-path query for that entry. A failure of the transport ends the
// helper for the rest of the run; an answer it does not decide (another code) or a name it does not send keeps it.
//
// Build and trust: the shipped C# source (reparse-query.cs beside this file) is compiled on the host by the Framework64
// csc into the per-user cache directory of the descriptor helper (read-handle.cjs: the same directory and the same
// overrides READ_HANDLE_CACHE_DIR and READ_HANDLE_CSC for tests and measurement, its own file names). The file name
// carries the sha256 of the source and of the compiler identity; the sha256 of the executable is recorded beside it at
// publish and verified again immediately before the start. A pair that does not verify is rebuilt and never run; a host
// without the compiler or without a cache directory that verifies never starts a helper.
//
// Transport: synchronous for the caller. A worker thread owns the pipes of the helper; the caller posts the request, waits
// on shared memory with a deadline (Atomics.wait) and parses the raw bytes of the answer itself with a strict grammar.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const NOT_A_REPARSE_POINT = 4390;
const HELLO = 'H reparse-query 1\n';
const ANSWER = /^A ([1-9][0-9]{0,9}) (0|[1-9][0-9]{0,9})\n$/;
const MAX_ANSWER = 64;
const MAX_PATH_BYTES = 32768;
const FIRST_MS = 10000; // the start of the process, its first line and its first answer
const NEXT_MS = 2000;
const CLOSE_MS = 2000; // at the exit of the caller: end of input, then the helper's own exit
// Shared memory: delivery count, kind of the last delivery (1 bytes, 2 ended), its byte count, helper pid, helper exited,
// how it ended; the bytes of the last delivery follow.
const SEQ = 0, KIND = 1, SIZE = 2, PID = 3, EXITED = 4, HOW = 5;
const BYTES_AT = 32;
const ENDINGS = ['exit', 'spawn', 'exit', 'unsolicited'];

const WORKER = `'use strict';
const { workerData, parentPort } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const i32 = new Int32Array(workerData.sab, 0, 8);
const out = new Uint8Array(workerData.sab, ${BYTES_AT}, ${MAX_ANSWER});
let pending = Buffer.alloc(0), waiting = true, ended = false, child = null;
function deliver(kind, bytes) {
  out.fill(0); out.set(bytes.subarray(0, ${MAX_ANSWER}));
  Atomics.store(i32, ${SIZE}, bytes.length); Atomics.store(i32, ${KIND}, kind);
  Atomics.add(i32, ${SEQ}, 1); Atomics.notify(i32, ${SEQ});
}
function end(how) {
  if (ended) return;
  ended = true; Atomics.store(i32, ${HOW}, how); deliver(2, Buffer.alloc(0));
}
try {
  child = spawn(workerData.exe, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  Atomics.store(i32, ${PID}, child.pid || 0);
  child.on('error', () => end(1));
  child.on('exit', () => { Atomics.store(i32, ${EXITED}, 1); Atomics.notify(i32, ${EXITED}); end(2); });
  child.stdin.on('error', () => end(2));
  child.stderr.resume();
  child.stdout.on('data', data => {
    if (ended) return;
    if (!waiting) { end(3); return; }
    pending = Buffer.concat([pending, data]);
    if (pending.includes(10) || pending.length > ${MAX_ANSWER}) { waiting = false; const bytes = pending; pending = Buffer.alloc(0); deliver(1, bytes); }
  });
} catch { end(1); }
parentPort.on('message', message => {
  if (message === 'kill') { try { if (child) child.kill(); } catch { /* already gone */ } return; }
  if (message === 'close') { try { if (child) child.stdin.end(); } catch { /* already gone */ } return; }
  if (ended) return;
  waiting = true; child.stdin.write(Buffer.from(message));
});
`;

const COMPILER = path.join('Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const SIDE_GRAMMAR = /^[0-9a-f]{64}\n$/;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs;

// The Framework64 csc under SystemRoot, or the absolute READ_HANDLE_CSC; a relative override is a configuration error.
function compilerPath() {
  const given = process.env.READ_HANDLE_CSC;
  if (given === undefined) return path.join(process.env.SystemRoot || 'C:\\Windows', COMPILER);
  if (typeof given !== 'string' || !path.isAbsolute(given)) throw new Error('config');
  return given;
}

// The cache directory: READ_HANDLE_CACHE_DIR or %LOCALAPPDATA%\read-handle-cache, a plain directory reached by this very
// spelling (no link, no alias in any component). An absent one is created once, under a parent that verifies the same way,
// and verified again; anything else is null.
function cacheDir() {
  const given = process.env.READ_HANDLE_CACHE_DIR;
  let cache;
  if (given === undefined) {
    const local = process.env.LOCALAPPDATA;
    if (typeof local !== 'string' || !path.isAbsolute(local)) return null;
    cache = path.join(local, 'read-handle-cache');
  } else {
    if (typeof given !== 'string' || !path.isAbsolute(given)) throw new Error('config');
    cache = path.resolve(given);
  }
  const realPath = require('./real-path.cjs').create({ fs });
  const plain = dir => {
    try {
      const st = fs.lstatSync(dir, { bigint: true });
      return st.isDirectory() && !st.isSymbolicLink() && realPath.realPathSync(dir) === path.resolve(dir);
    } catch { return false; }
  };
  if (!fs.existsSync(cache)) {
    if (!plain(path.dirname(cache))) return null;
    try { fs.mkdirSync(cache); } catch { return null; }
  }
  return plain(cache) ? cache : null;
}

// sha256 of a regular file with one link, read through one descriptor whose identity holds around the read, or null.
function fileDigest(file) {
  let fd;
  try {
    const first = fs.lstatSync(file, { bigint: true });
    if (!first.isFile() || first.isSymbolicLink() || first.size > 1048576n) return null;
    fd = fs.openSync(file, 'r');
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !same(opened, first)) return null;
    const hash = crypto.createHash('sha256');
    const chunk = Buffer.alloc(65536);
    for (let n; (n = fs.readSync(fd, chunk, 0, chunk.length, null)) > 0;) hash.update(chunk.subarray(0, n));
    if (!same(fs.fstatSync(fd, { bigint: true }), opened)) return null;
    return hash.digest('hex');
  } catch { return null; } finally { if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* closed */ } } }
}

// The executable verifies only when its own sha256 equals the record published beside it under the same key.
function verifyPair(exe, side) {
  const digest = fileDigest(exe);
  if (digest === null) return null;
  try {
    const st = fs.lstatSync(side, { bigint: true });
    if (!st.isFile() || st.isSymbolicLink() || st.size > 128n) return null;
    const text = fs.readFileSync(side, 'utf8');
    return SIDE_GRAMMAR.test(text) && text.trim() === digest ? digest : null;
  } catch { return null; }
}

// Where the helper of this source and this compiler lives, or why there is none: { exe, side, compiler } or { reason }.
function helperPaths() {
  let compiler, dir;
  try { compiler = compilerPath(); dir = cacheDir(); } catch { return { reason: 'config' }; }
  if (dir === null) return { reason: 'no-cache' };
  let source, identity;
  try { source = fs.readFileSync(path.join(__dirname, 'reparse-query.cs')); } catch { return { reason: 'no-source' }; }
  try { identity = fs.statSync(compiler, { bigint: true }); } catch { return { reason: 'no-compiler' }; }
  const h = crypto.createHash('sha256');
  h.update('reparse-query-v1\0');
  h.update(source);
  h.update(`${compiler}\0${identity.size}\0${identity.mtimeMs}`);
  const key = h.digest('hex');
  return { exe: path.join(dir, `reparse-query-${key}.exe`), side: path.join(dir, `reparse-query-${key}.sha256`), compiler, key };
}

// A verified executable of the shipped source, built and published on the first use: { exe } or { reason }.
function helperExecutable() {
  const where = helperPaths();
  if (where.reason) return where;
  const { exe, side, compiler, key } = where;
  if (verifyPair(exe, side) !== null) return { exe };
  const tag = `reparse-query-${key}`;
  const pExe = path.join(path.dirname(exe), `${tag}.exe.partial-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  const pSide = path.join(path.dirname(exe), `${tag}.sha256.partial-${process.pid}-${crypto.randomBytes(6).toString('hex')}`);
  try {
    const build = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${pExe}`, path.join(__dirname, 'reparse-query.cs')], {
      windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 65536,
    });
    if (build.error || build.status !== 0) return { reason: 'build' };
    const digest = fileDigest(pExe);
    if (digest === null) return { reason: 'build' };
    const fd = fs.openSync(pSide, 'w');
    try { fs.writeSync(fd, `${digest}\n`); } finally { fs.closeSync(fd); }
    fs.renameSync(pExe, exe);
    fs.renameSync(pSide, side);
  } catch { return { reason: 'build' }; } finally {
    for (const p of [pExe, pSide]) { try { fs.unlinkSync(p); } catch { /* published or gone */ } }
  }
  // A concurrent publish may have interleaved: only a verified pair is run.
  return verifyPair(exe, side) !== null ? { exe } : { reason: 'digest' };
}

function create() {
  let state = null; // { worker, i32, bytes, consumed, id } while the helper runs
  let dead = null; // why the helper ended for the rest of this run

  function end(reason) {
    dead = reason;
    if (state) {
      const { worker, i32 } = state;
      state = null;
      try { worker.postMessage('kill'); } catch { /* the worker is gone */ }
      // A helper that hangs is ended from here too: the worker may not run again before this process exits. The worker
      // still holds the process handle until it has seen the exit, so the pid cannot name another process yet.
      const pid = Atomics.load(i32, PID);
      if (pid > 0 && Atomics.load(i32, EXITED) === 0) { try { process.kill(pid); } catch { /* already gone */ } }
      try { worker.terminate().catch(() => {}); } catch { /* already ended */ }
    }
    return { decided: false, reason };
  }

  // The next delivery of the worker within `ms`: { text } (raw bytes, null when oversized), { ended } or null on timeout.
  function receive(ms) {
    const { i32, bytes } = state;
    const deadline = Date.now() + ms;
    while (Atomics.load(i32, SEQ) === state.consumed) {
      const left = deadline - Date.now();
      if (left <= 0) return null;
      Atomics.wait(i32, SEQ, state.consumed, left);
    }
    state.consumed = Atomics.load(i32, SEQ);
    if (Atomics.load(i32, KIND) !== 1) return { ended: ENDINGS[Atomics.load(i32, HOW)] || 'exit' };
    const size = Atomics.load(i32, SIZE);
    return { text: size > MAX_ANSWER ? null : Buffer.from(bytes.subarray(0, size)) };
  }

  function start() {
    if (typeof SharedArrayBuffer !== 'function' || typeof Atomics !== 'object' || typeof Atomics.wait !== 'function') {
      return end('no-shared-memory');
    }
    let Worker;
    try { ({ Worker } = require('node:worker_threads')); } catch { return end('no-worker'); }
    const built = helperExecutable();
    if (built.reason) return end(built.reason);
    const sab = new SharedArrayBuffer(BYTES_AT + MAX_ANSWER);
    const i32 = new Int32Array(sab, 0, 8);
    let worker;
    try { worker = new Worker(WORKER, { eval: true, workerData: { exe: built.exe, sab } }); } catch { return end('no-worker'); }
    worker.unref();
    worker.on('error', () => { /* seen through the shared memory or the deadline */ });
    state = { worker, i32, bytes: new Uint8Array(sab, BYTES_AT, MAX_ANSWER), consumed: 0, id: 0 };
    // At a normal exit or a refusal the caller ends the helper's input and waits, bounded, until the helper has exited on
    // its own: a real end of input, not only the end the system forces on a child when its caller dies (a killed caller's
    // pipe closes, and Node ends the children of a process that exits).
    process.once('exit', () => {
      if (!state || state.i32 !== i32) return;
      try { worker.postMessage('close'); } catch { return; }
      const until = Date.now() + CLOSE_MS;
      while (Atomics.load(i32, EXITED) === 0 && Date.now() < until) Atomics.wait(i32, EXITED, 0, until - Date.now());
    });
    const hello = receive(FIRST_MS);
    if (hello === null) return end('timeout');
    if (hello.ended) return end(hello.ended);
    if (hello.text === null || hello.text.toString('latin1') !== HELLO) return end('version');
    return null;
  }

  // { decided: true } only for the answer 4390 to this very request; otherwise { decided: false, reason }.
  function ask(file) {
    if (dead) return { decided: false, reason: dead };
    // Names are data: only a path that survives the UTF-8 round trip unchanged, holds no NUL and fits the wire is sent;
    // any other stays with the caller for this entry.
    if (typeof file !== 'string' || file.includes('\0')) return { decided: false, reason: 'name' };
    const body = Buffer.from(file, 'utf8');
    if (body.toString('utf8') !== file) return { decided: false, reason: 'name' };
    if (body.length > MAX_PATH_BYTES) return { decided: false, reason: 'name-length' };
    if (!state) {
      start();
      if (dead) return { decided: false, reason: dead };
    }
    const { i32 } = state;
    // Anything that arrived while nothing was asked (an end, a second answer) ends the helper.
    if (Atomics.load(i32, SEQ) !== state.consumed) {
      return end(Atomics.load(i32, KIND) === 2 ? ENDINGS[Atomics.load(i32, HOW)] || 'exit' : 'unsolicited');
    }
    const id = ++state.id;
    try { state.worker.postMessage(Buffer.concat([Buffer.from(`Q ${id} ${body.length}\n`, 'ascii'), body])); }
    catch { return end('post'); }
    const got = receive(id === 1 ? FIRST_MS : NEXT_MS);
    if (got === null) return end('timeout');
    if (got.ended) return end(got.ended);
    const match = got.text === null ? null : ANSWER.exec(got.text.toString('latin1'));
    if (!match) return end('garbage');
    if (Number(match[1]) !== id) return end('wrong-id');
    const code = Number(match[2]);
    if (code > 0xFFFFFFFF) return end('garbage');
    if (code !== NOT_A_REPARSE_POINT) return { decided: false, reason: `code-${code}` };
    return { decided: true };
  }

  return { ask };
}

module.exports = { create, helperPaths };

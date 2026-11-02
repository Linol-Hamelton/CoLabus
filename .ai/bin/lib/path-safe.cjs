'use strict';
// path-safe.cjs - the shared guard of real paths. CommonJS, no
// dependencies. It reads the file system (lstat, realpath); writes use mkdirGuarded or writeAtomicGuarded. The same
// input gives the same answer in every working directory: a relative root is refused, a relative candidate
// is read against the root, never against process.cwd().
//
// realInside(root, candidate, opts) -> { ok: true, real, rel, exists, type } | { ok: false, reason, detail }
//   P1  root is an absolute path of an existing directory, not UNC or a device path. The root itself and
//       its ancestors may be links (the caller chose them); the comparison uses the root's real path.
//   P2  candidate: relative (read against the root) or absolute. An absolute candidate is inside when one
//       of its prefixes has the root's real path (so the root's own spelling, its 8.3 form, another letter
//       case, or a link that aliases the root itself are all accepted); else outside-root.
//   P3  Refused lexically, on every platform (same answer on Windows and POSIX): NUL; UNC and device paths
//       (\\server, \\?\, \\.\, //x, \??\); a drive-relative path (C:x, or \x without a drive, on Windows);
//       an empty, "." or ".." segment; a segment with a character outside the Windows name alphabet
//       (< > " | ? * and code points below 32; a backslash on POSIX); a ":" in a segment (alternate data
//       stream); a trailing dot or space; a reserved device name (CON PRN AUX NUL CONIN$ CONOUT$ COM1-9
//       LPT1-9 and COM/LPT with a superscript digit, any extension, any case).
//   P4  Every segment below the root is walked with lstat from the root's real path: a symbolic link or a
//       junction (Node reports both as links) is refused (link); a component whose real path leaves its
//       parent directory (a mount point or another redirecting reparse point) is refused (reparse); a file
//       in the middle is refused (not-a-directory). Comparison is case-insensitive on Windows (the walk
//       takes the true case and the long name from realpath, which resolves 8.3 names), exact elsewhere
//       (a case difference there is a refusal, never an acceptance).
//   P5  Segments that do not exist yet are allowed (a write target), except a name of the 8.3 alias form
//       (FOO~1.TXT), which could later open another file (short-name).
//   P6  opts.refuseHardlinks: an existing file with a link count above 1 is refused (hardlink).
//       opts.allowRoot: the root itself is accepted (else is-root). A socket, FIFO or device is refused.
//   P7  An error of the file system other than "does not exist" is unreadable: unknown is never inside.
//   P8  detail never holds an absolute path or a user name: only the relative segment and an error code.
//   NOT guaranteed: other reparse points that do not redirect (cloud placeholders, dedup) are not
//   detected; a path can still change after the answer (use writeAtomicGuarded for writes).
//
//   opts must be an object (null or another value: bad-options).
//
// sameFileOrNested(a, b) -> boolean
//   true when a and b (absolute) are one file (same device and inode, so a hardlink or a link to the
//   other counts) or resolve to one path, or one is inside the other. An input that cannot be judged (not
//   absolute, an unreadable component, a file in the middle of the path: ENOTDIR is not a missing tail)
//   gives true: the safe answer for an inputs-versus-outputs guard.
//
// writeAtomicGuarded(target, bytes, { root, mode, onTempWritten })
//   -> { ok: true, real, bytes, dirSynced, closeError? }
//    | { ok: false, reason, detail, tempLeft?, tempLeftReal?, written?, ours?, undone?, remains? }
//   W1  target must pass realInside(root, target, { refuseHardlinks: true }); its directory must exist.
//       The parent and all its ancestors are checked from the volume, then the parent is pinned before
//       temp creation. Windows pin ownership passes from directory to open temp file before first byte.
//   W2  bytes is a Buffer or Uint8Array (a string is refused: its encoding would be a guess).
//   W3  The bytes go to an exclusive temp file (O_CREAT | O_EXCL, O_NOFOLLOW where the platform has it)
//       in the target's real directory and are flushed (fsync). The temp file stays OPEN until after the
//       post-check: on Windows (NTFS, measured) a directory that holds an open file cannot be renamed, nor
//       can any of its ancestors, so no directory on the path can be swapped for a link while it is open.
//   W4  Immediately before the rename the guard runs again: the target must give the same real path, still
//       not be a link or a hardlink, the directory must be the same directory (inode) at the same real
//       path, and the temp file must be the same file (inode) with link count 1; anything else is swapped
//       and nothing is renamed.
//   W5  After the rename the directory must still resolve to its real path (same inode) and the target must
//       be the temp file's inode; else post-check-failed (ok: false) with what happened, as observed:
//         written  the real path the rename resolved to (where it put a file), null when unreadable;
//         ours     true when the file there is the file this call wrote, false when not, null unknown;
//         undone   true when this call took its effect outside the root back: its own file there is
//                  removed (inode checked), or a foreign file that its rename moved (proved by finding
//                  its own file still under the temp name) is renamed back to its old name when that
//                  name is free;
//         remains  [{ path, what }]: what this call leaves that was not asked for; what is 'temp' (its
//                  own temp file), 'written-outside' (its file outside the root), 'moved-foreign' (a
//                  foreign file its rename moved), 'written-elsewhere' (its file inside the root at another
//                  path: the directory was moved after the rename), 'own-file' (its file, found neither
//                  at the target nor in the root); path null when the place is unknown.
//   W6  On every failure after the temp file was created, the file this call wrote and never renamed is
//       removed wherever it is found inside the root (the temp path first, then a walk of the root of at
//       most 20000 entries that follows no link; inode checked immediately before the removal); when it
//       cannot be found or removed, tempLeft names it (base name) and tempLeftReal gives its real path
//       (null when unknown). When its inode cannot be read (fstat failed), it is never removed blind:
//       tempLeft and tempLeftReal name the temp path. Every failure after the temp file was created
//       carries remains (empty when nothing is left). A failure is never reported as ok.
//   W7  The temp handle is closed after the post-check. A close error after a verified rename is reported
//       as closeError on an ok result (the bytes were flushed before the rename and are at the target).
//   NOT guaranteed: on POSIX (and file systems that allow renaming a directory with open files) the gap
//   between the last check and the rename is narrowed, not closed (Node has no rename-no-replace or
//   handle-relative rename); W5 then detects the escape and undoes what it safely can, and a file that the
//   rename replaced at the escaped path cannot be restored. Measured on NTFS only. dirSynced is true only
//   where a directory fsync ran (POSIX), null on Windows. written, tempLeftReal and remains hold absolute
//   machine paths: for the caller's repair, never for a published report.
//   onTempWritten is a test seam: called after the temp file is written, before the second guard.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const WIN = process.platform === 'win32';
const P = WIN ? path.win32 : path.posix;

const DEVICE_STEMS = new Set(['CON', 'PRN', 'AUX', 'NUL', 'CONIN$', 'CONOUT$']);
for (const base of ['COM', 'LPT']) for (const d of '123456789\u00b9\u00b2\u00b3') DEVICE_STEMS.add(base + d);
const SHORT_NAME = /^[^.~]{1,6}~[0-9]+(?:\.[^.]{0,3})?$/;

const fail = (reason, detail) => ({ ok: false, reason, detail });
const key = p => (WIN ? p.toUpperCase() : p);
const sameReal = (a, b) => key(a) === key(b);
const insideOrEqual = (child, parent) => {
  const c = key(child); const p = key(parent);
  if (c === p) return true;
  const sep = p.endsWith(P.sep) ? p : p + P.sep;
  return c.startsWith(sep);
};
const errCode = e => String((e && e.code) || 'UNKNOWN').replace(/[^A-Za-z0-9_]/g, '').slice(0, 24) || 'UNKNOWN';
const show = s => JSON.stringify(String(s).slice(0, 80));

const RETRYABLE_PIN_CODES = ['EBUSY', 'EPERM', 'EACCES'];
const DEFAULT_PIN_ATTEMPTS = 8;
const DEFAULT_PIN_FIRST_DELAY_MS = 25;
const MAX_PIN_ATTEMPTS = 8;
const MAX_PIN_TOTAL_DELAY_MS = 4000;
const defaultSleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// One bound for every retry ladder of one call: the sum of the requested sleeps and the wall-clock time since
// the budget was created both count against MAX_PIN_TOTAL_DELAY_MS (or a smaller retryBudgetMs).
// Private state: callers and hooks cannot supply, observe or reset a budget.
const newRetryBudget = () => ({ spent: 0, startedAt: performance.now() });
const isCount = v => typeof v === 'number' && Number.isInteger(v) && v >= 1;
const isDelay = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;

// Reads and validates the retry options of one ladder ("pin" or "rename") before anything is opened.
// An invalid value is refused (never replaced by a default); a valid count above MAX_PIN_ATTEMPTS and a valid
// delay above the budget are capped. nextDelay(n) is the sleep after failed attempt n, or -1 when the ladder
// is over (attempts or budget exhausted); it books the sleep against the shared budget.
function retryOptions(opts) {
  const bad = name => fail('retry-options-invalid', name);
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) return bad('opts');
  const o = Object.create(null);
  try {
    const proto = Object.getPrototypeOf(opts);
    if (proto !== null && proto !== Object.prototype) return bad('opts');
    for (const name of Reflect.ownKeys(opts)) {
      const d = Object.getOwnPropertyDescriptor(opts, name);
      if (!d || !Object.hasOwn(d, 'value')) return bad(typeof name === 'string' ? name : 'opts');
      o[name] = d.value;
    }
  } catch { return bad('opts'); }
  if (Object.hasOwn(o, 'retryBudget')) return bad('retryBudget');
  for (const kind of ['pin', 'rename']) {
  const attemptsKey = kind + 'Attempts'; const delayKey = kind + 'FirstDelayMs';
  const hookKey = kind === 'pin' ? 'onBeforePinAttempt' : 'onBeforeRenameAttempt';
  if (o[attemptsKey] !== undefined && !isCount(o[attemptsKey])) return bad(attemptsKey);
  if (o[delayKey] !== undefined && !isDelay(o[delayKey])) return bad(delayKey);
  if (o[hookKey] !== undefined && typeof o[hookKey] !== 'function') return bad(hookKey);
  }
  if (o.retryBudgetMs !== undefined && !(isCount(o.retryBudgetMs) && o.retryBudgetMs <= MAX_PIN_TOTAL_DELAY_MS)) return bad('retryBudgetMs');
  if (o.sleep !== undefined && typeof o.sleep !== 'function') return bad('sleep');
  return { ok: true, options: Object.freeze(o) };
}

function retryPlan(o, kind, shared = newRetryBudget()) {
  const attemptsKey = kind + 'Attempts'; const delayKey = kind + 'FirstDelayMs';
  const hookKey = kind === 'pin' ? 'onBeforePinAttempt' : 'onBeforeRenameAttempt';
  const attempts = Math.min(o[attemptsKey] === undefined ? DEFAULT_PIN_ATTEMPTS : o[attemptsKey], MAX_PIN_ATTEMPTS);
  const firstDelayMs = o[delayKey] === undefined ? DEFAULT_PIN_FIRST_DELAY_MS : o[delayKey];
  const limit = o.retryBudgetMs === undefined ? MAX_PIN_TOTAL_DELAY_MS : o.retryBudgetMs;
  const nextDelay = attempt => {
    if (attempt >= attempts) return -1;
    const remaining = limit - Math.max(shared.spent, performance.now() - shared.startedAt);
    if (remaining <= 0) return -1;
    const ms = Math.min(firstDelayMs * (2 ** Math.min(attempt - 1, 30)), remaining);
    shared.spent += ms;
    return ms;
  };
  return { ok: true, attempts, nextDelay, sleep: o.sleep || defaultSleep, hook: o[hookKey] || null };
}

// One open and one stat of the pinned directory. The descriptor is closed again when the stat fails:
// a failed attempt never leaves a handle behind (a retry would otherwise lose the only reference).
function openPinOnce(real, flags) {
  const fd = fs.openSync(real, flags);
  try { return { fd, opened: fs.fstatSync(fd, { bigint: true }) }; } catch (e) {
    try { fs.closeSync(fd); } catch { /* the stat error is the one to report */ }
    throw e;
  }
}

function lexicalProblem(p) {
  if (typeof p !== 'string' || p === '') return ['not-text', 'the path is not a non-empty string'];
  if (p.includes('\0')) return ['nul-byte', 'the path holds a NUL character'];
  if (/^[\\/]{2}/.test(p) || /^[\\/]\?\?[\\/]/.test(p)) return ['unc-or-device', 'UNC and device paths are refused'];
  if (WIN && (/^[A-Za-z]:(?![\\/])/.test(p) || /^[\\/](?![\\/])/.test(p))) return ['drive-relative', 'a drive-relative path depends on the current drive or directory'];
  return null;
}

function segmentProblem(seg) {
  if (seg === '') return ['empty-segment', 'an empty path segment'];
  if (seg === '.' || seg === '..') return ['dot-segment', `segment ${show(seg)}`];
  for (const ch of seg) {
    const cp = ch.codePointAt(0);
    if (cp < 32 || '<>"|?*'.includes(ch) || (!WIN && ch === '\\')) return ['bad-character', `a character outside the name alphabet in ${show(seg.replace(/[\u0000-\u001f]/g, '?'))}`];
  }
  if (seg.includes(':')) return ['stream-name', `":" in segment ${show(seg)}`];
  if (/[. ]$/.test(seg)) return ['trailing-dot-or-space', `segment ${show(seg)} ends with a dot or a space`];
  const dot = seg.indexOf('.');
  const stem = (dot < 0 ? seg : seg.slice(0, dot)).replace(/ +$/, '').toUpperCase();
  if (DEVICE_STEMS.has(stem)) return ['reserved-name', `segment ${show(seg)} is the device ${stem}`];
  return null;
}

const splitSegments = p => p.split(WIN ? /[\\/]/ : /\//);

// The real path of the root, or a refusal.
function realRootOf(root) {
  const lp = lexicalProblem(root);
  if (lp) return fail(lp[0] === 'not-text' ? 'not-text' : lp[0] === 'unc-or-device' ? 'root-unc-or-device' : lp[0], `root: ${lp[1]}`);
  if (!P.isAbsolute(root)) return fail('root-not-absolute', 'the root must be an absolute path');
  let real;
  try { real = fs.realpathSync.native(root); } catch (e) { return fail(e && e.code === 'ENOENT' ? 'root-missing' : 'unreadable', `root: ${errCode(e)}`); }
  let st;
  try { st = fs.statSync(real); } catch (e) { return fail('unreadable', `root: ${errCode(e)}`); }
  if (!st.isDirectory()) return fail('root-not-directory', 'the root is not a directory');
  return { ok: true, real };
}

// The segments of candidate below the root, or a refusal.
function segmentsBelow(realRoot, candidate) {
  if (!P.isAbsolute(candidate)) return { ok: true, segs: splitSegments(candidate) };
  const parsed = P.parse(candidate);
  const all = splitSegments(candidate.slice(parsed.root.length));
  if (all.length && all[all.length - 1] === '' && all.length > 1) all.pop(); // one trailing separator
  for (const s of all) if (s === '.' || s === '..') return fail('dot-segment', `segment ${show(s)}`);
  for (let k = 0; k <= all.length; k++) {
    const prefix = parsed.root + all.slice(0, k).join(P.sep);
    let real;
    try { real = fs.realpathSync.native(prefix); } catch { break; }
    if (sameReal(real, realRoot)) return { ok: true, segs: all.slice(k) };
  }
  return fail('outside-root', 'the candidate is not below the root');
}

function realInside(root, candidate, opts = {}) {
  if (opts === null || typeof opts !== 'object') return fail('bad-options', 'opts must be an object');
  const r = realRootOf(root);
  if (!r.ok) return r;
  const lp = lexicalProblem(candidate);
  if (lp) return fail(lp[0], lp[1]);
  const below = segmentsBelow(r.real, candidate);
  if (!below.ok) return below;
  const segs = below.segs;
  if (segs.length === 0 || (segs.length === 1 && segs[0] === '')) {
    return opts.allowRoot ? { ok: true, real: r.real, rel: '', exists: true, type: 'dir' } : fail('is-root', 'the candidate is the root itself');
  }
  for (const s of segs) { const sp = segmentProblem(s); if (sp) return fail(sp[0], sp[1]); }
  let cur = r.real;
  let st = null;
  for (let i = 0; i < segs.length; i++) {
    const next = P.join(cur, segs[i]);
    const relShown = segs.slice(0, i + 1).join('/');
    try { st = fs.lstatSync(next); } catch (e) {
      if (e && e.code === 'ENOENT') {
        const rest = segs.slice(i);
        const short = rest.find(s => SHORT_NAME.test(s));
        if (short) return fail('short-name', `segment ${show(short)} has the 8.3 alias form and does not exist`);
        const real = P.join(cur, ...rest);
        return { ok: true, real, rel: segs.join('/'), exists: false, type: 'missing' };
      }
      if (e && e.code === 'ENOTDIR') return fail('not-a-directory', `a file in the middle of ${show(relShown)}`);
      return fail('unreadable', `${show(relShown)}: ${errCode(e)}`);
    }
    if (st.isSymbolicLink()) return fail('link', `${show(relShown)} is a symbolic link or junction`);
    let real;
    try { real = fs.realpathSync.native(next); } catch (e) { return fail('unreadable', `${show(relShown)}: ${errCode(e)}`); }
    if (!sameReal(P.dirname(real), cur)) return fail('reparse', `${show(relShown)} leaves its parent directory (mount point or reparse point)`);
    if (i < segs.length - 1 && !st.isDirectory()) return fail('not-a-directory', `${show(relShown)} is not a directory`);
    cur = real;
  }
  if (!st.isFile() && !st.isDirectory()) return fail('not-regular', 'the candidate is neither a file nor a directory');
  if (opts.refuseHardlinks && st.isFile() && st.nlink > 1) return fail('hardlink', `the file has ${st.nlink} links`);
  if (!insideOrEqual(cur, r.real)) return fail('outside-root', 'the real path is not below the root');
  return { ok: true, real: cur, rel: P.relative(r.real, cur).split(P.sep).join('/'), exists: true, type: st.isFile() ? 'file' : 'dir' };
}

// Real path of an absolute path: the deepest existing ancestor through realpath, the rest appended.
function looseReal(p) {
  if (lexicalProblem(p) || !P.isAbsolute(p)) return null;
  const parsed = P.parse(p);
  const segs = splitSegments(p.slice(parsed.root.length)).filter(s => s !== '');
  if (segs.some(s => s === '.' || s === '..')) return null;
  for (let k = segs.length; k >= 0; k--) {
    const prefix = parsed.root + segs.slice(0, k).join(P.sep);
    try {
      const real = fs.realpathSync.native(prefix);
      // A missing tail hangs only below a directory: a file in the middle is not judgeable.
      if (k < segs.length && !fs.statSync(real).isDirectory()) return null;
      return { real: P.join(real, ...segs.slice(k)), exists: k === segs.length };
    } catch (e) {
      // Only a missing segment makes a missing tail; a file in the middle (ENOTDIR) is not judgeable.
      if (!e || e.code !== 'ENOENT') return null;
    }
  }
  return null;
}

function sameFileOrNested(a, b) {
  const ra = looseReal(a); const rb = looseReal(b);
  if (!ra || !rb) return true;
  if (ra.exists && rb.exists) {
    try {
      const sa = fs.statSync(ra.real, { bigint: true }); const sb = fs.statSync(rb.real, { bigint: true });
      if (sa.ino !== 0n && sa.dev === sb.dev && sa.ino === sb.ino) return true;
    } catch { return true; }
  }
  return insideOrEqual(ra.real, rb.real) || insideOrEqual(rb.real, ra.real);
}

// A verified snapshot, never a transaction with a later consumer action. No content
// read by name: open once, fstat/read/fstat on that fd, then query its native real
// path/id/link count and verify the name still identifies the same file. Unsupported
// descriptor queries and every IO/close error refuse without returning any bytes.
// onOpened/onRead are synchronous test seams; they do not bypass any guard.
// opts.maxBytes: the size of the OPENED DESCRIPTOR is judged by its own
// fstat BEFORE any byte is read; a file above the limit is never read into memory (the result
// { ok: false, reason: 'above-read-limit' } keeps that fstat's size in `size` and the stat in
// `st`, and the caller judges the source itself; the identity was proven at the open, and no
// byte of the file ever entered a proof or a memory buffer).
function readFileGuarded(root, candidate, opts = {}) {
  if (!opts || typeof opts !== 'object') return fail('bad-options', 'opts must be an object');
  if (opts.maxBytes !== undefined && (!Number.isSafeInteger(opts.maxBytes) || opts.maxBytes < 0)) return fail('bad-options', 'maxBytes must be a non-negative integer');
  const g = realInside(root, candidate, { refuseHardlinks: true });
  if (!g.ok) return g;
  if (!g.exists || g.type !== 'file') return fail('not-file', 'an existing regular file is required');
  let fd = null; let result;
  const stable = (a, b) => sameId(a, b) && a.ino !== 0n && a.isFile() && b.isFile()
    && a.nlink === 1n && b.nlink === 1n && a.size === b.size
    && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
  try {
    const before = fs.lstatSync(g.real, { bigint: true });
    fd = fs.openSync(g.real, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) | (fs.constants.O_NONBLOCK || 0));
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!stable(before, opened)) throw new Error('swapped');
    // The size is judged by the fstat of the opened descriptor BEFORE the read
    if (opts.maxBytes !== undefined && Number(opened.size) > opts.maxBytes) {
      result = { ok: false, reason: 'above-read-limit', size: Number(opened.size), st: opened };
    } else {
      if (opts.onOpened) opts.onOpened(fd);
      const bytes = fs.readFileSync(fd);
      if (opts.onRead) opts.onRead(fd);
      const after = fs.fstatSync(fd, { bigint: true });
      const native = require('./read-handle.cjs').descriptorInfo(fd);
      const post = realInside(root, candidate, { refuseHardlinks: true });
      if (!stable(opened, after) || !sameReal(native.real, g.real)
          || native.dev !== after.dev || native.ino !== after.ino || native.nlink !== 1n
          || !post.ok || post.type !== 'file' || !sameReal(post.real, g.real)
          || !stable(after, fs.lstatSync(post.real, { bigint: true }))) throw new Error('swapped');
      // st: the fstat of the OPENED DESCRIPTOR the bytes were read from (identity, size and mtime of the READ object, judged at read time; a later
      // stat of the name says nothing about these bytes, so every window or size judgement of a guarded read uses this field)
      result = { ok: true, bytes, real: g.real, st: after };
    }
  } catch (e) { result = fail('read-unverified', errCode(e)); }
  finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch (e) { result = fail('close-failed', errCode(e)); }
    }
  }
  return result;
}

const MAX_WALK = 20000;

// The real path of the file with this device and inode below rootReal (no link is followed), or null when
// it is not found or the walk passed MAX_WALK entries.
function findByInode(rootReal, dev, ino) {
  const stack = [rootReal]; let seen = 0;
  while (stack.length) {
    const d = stack.pop();
    let ents;
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if ((seen += 1) > MAX_WALK) return null;
      const p = P.join(d, e.name);
      if (e.isDirectory()) { stack.push(p); continue; }
      if (!e.isFile()) continue;
      try { const st = fs.lstatSync(p, { bigint: true }); if (st.ino === ino && st.dev === dev) return p; } catch { /* gone meanwhile */ }
    }
  }
  return null;
}

const statOrNull = p => { try { return fs.lstatSync(p, { bigint: true }); } catch { return null; } };
const sameId = (st, id) => Boolean(st && id && st.ino === id.ino && st.dev === id.dev);
// Removes p when it is still the file id (checked immediately before); true when removed.
const unlinkIf = (p, id) => { try { if (!sameId(fs.lstatSync(p, { bigint: true }), id)) return false; fs.unlinkSync(p); return true; } catch { return false; } };

// Hold the parent BEFORE mkdir or temp creation. On Windows libuv's UV_FS_O_EXLOCK
// (0x10000000) opens a directory with no sharing, including no delete sharing.
// NTFS refuses renaming this directory (EBUSY) and any ancestor (EPERM).
// A Windows cwd handle already pins its directory and ancestors, and prevents
// opening that directory exclusively. Use that pin only for our own cwd;
// the trusted synchronous callback must not change cwd before transferring it.
// Opening and verifying the handle is read-only; a swap during open fails before
// the callback. POSIX directory fds do not prevent renames: checks narrow that
// window but do not promise the Windows transaction there.
function withDirectoryPinned(directory, action, opts = {}) {
  const checked = retryOptions(opts);
  if (!checked.ok) return checked;
  return pinWithPlan(directory, action, retryPlan(checked.options, 'pin'));
}

function pinWithPlan(directory, action, plan) {
  const volume = P.parse(directory).root;
  const before = realInside(volume, directory, { allowRoot: true });
  if (!before.ok || !before.exists || before.type !== 'dir') return fail('directory-refused', before.reason || 'not-directory');
  let fd = null; let result;
  const release = () => {
    if (fd === null) return;
    const h = fd; fd = null; fs.closeSync(h);
  };
  try {
    const id = fs.lstatSync(before.real, { bigint: true });
    const cwdReal = WIN ? fs.realpathSync.native(process.cwd()) : null;
    const cwdPinned = WIN && insideOrEqual(cwdReal, before.real);
    const flags = fs.constants.O_RDONLY | (WIN ? (cwdPinned ? 0 : 0x10000000) : (fs.constants.O_DIRECTORY || 0));
    let opened = null;
    for (let attempt = 1; ; attempt++) {
      if (plan.hook) plan.hook(attempt);
      try {
        ({ fd, opened } = openPinOnce(before.real, flags));
        break;
      } catch (e) {
        const wait = WIN && RETRYABLE_PIN_CODES.includes(e && e.code) ? plan.nextDelay(attempt) : -1;
        if (wait < 0) throw e;
        plan.sleep(wait);
        const check = realInside(volume, directory, { allowRoot: true });
        if (!check.ok || !check.exists || check.type !== 'dir') throw e; // gone: the original error stands
        if (!sameReal(check.real, before.real) || !sameId(statOrNull(check.real), id)) {
          return { ...fail('directory-swapped', 'the directory changed while the pin was retried'), cause: errCode(e) };
        }
      }
    }
    const after = realInside(volume, directory, { allowRoot: true });
    if (!opened.isDirectory() || opened.ino === 0n || !sameId(opened, id) || !after.ok
        || !sameReal(after.real, before.real) || !sameId(statOrNull(after.real), id)
        || (cwdPinned && !sameReal(fs.realpathSync.native(process.cwd()), cwdReal))) return fail('directory-swapped', 'parent identity changed during open');
    result = action(release);
  } catch (e) { result = fail('directory-pin-failed', errCode(e)); }
  finally {
    if (fd !== null) {
      try { release(); } catch (e) { result = fail('directory-close-failed', errCode(e)); }
    }
  }
  return result;
}

function mkdirGuarded(root, target, opts = {}) {
  const checked = retryOptions(opts);
  if (!checked.ok) return checked;
  const rg = realInside(P.parse(root).root, root, { allowRoot: true });
  if (!rg.ok || !rg.exists || rg.type !== 'dir') return fail('directory-refused', rg.reason || 'not-directory');
  const g = realInside(root, target, { refuseHardlinks: true });
  if (!g.ok) return g;
  if (g.exists) return g.type === 'dir' ? { ok: true, real: g.real } : fail('not-a-directory', 'existing target is not a directory');
  return pinWithPlan(P.dirname(g.real), () => {
    const next = realInside(root, target, { refuseHardlinks: true });
    if (!next.ok || !sameReal(next.real, g.real) || next.exists) return fail('directory-swapped', 'target changed before mkdir');
    fs.mkdirSync(g.real);
    const post = realInside(root, target);
    return post.ok && post.exists && post.type === 'dir' ? { ok: true, real: post.real } : fail('directory-swapped', 'mkdir target changed');
  }, retryPlan(checked.options, 'pin'));
}

function writeAtomicGuarded(target, bytes, opts = {}) {
  if (!(bytes instanceof Uint8Array)) return fail('not-bytes', 'bytes must be a Buffer or Uint8Array');
  const checked = retryOptions(opts);
  if (!checked.ok) return checked;
  opts = checked.options;
  if (typeof opts.root !== 'string') return fail('not-text', 'opts.root is required');
  // Both ladders are validated before the directory is touched and share one time budget.
  const budget = newRetryBudget();
  const pinPlan = retryPlan(opts, 'pin', budget);
  const renamePlan = retryPlan(opts, 'rename', budget);
  const rg = realInside(P.parse(opts.root).root, opts.root, { allowRoot: true });
  if (!rg.ok || !rg.exists || rg.type !== 'dir') return fail('directory-refused', rg.reason || 'not-directory');
  const g = realInside(opts.root, target, { refuseHardlinks: true });
  if (!g.ok) return g;
  if (g.type === 'dir') return fail('is-directory', 'the target is a directory');
  const parent = P.dirname(g.real);
  if (!statOrNull(parent)?.isDirectory()) return fail('parent-missing', 'the target directory is not a directory');
  return pinWithPlan(parent, release => writeAtomicPinned(target, bytes, opts, release, renamePlan), pinPlan);
}

function writeAtomicPinned(target, bytes, opts, releaseParent, renamePlan) {
  if (!(bytes instanceof Uint8Array)) return fail('not-bytes', 'bytes must be a Buffer or Uint8Array');
  if (!opts || typeof opts.root !== 'string') return fail('not-text', 'opts.root (the directory the caller owns) is required');
  const guard = () => realInside(opts.root, target, { refuseHardlinks: true });
  const g = guard();
  if (!g.ok) return g;
  if (g.type === 'dir') return fail('is-directory', 'the target is a directory');
  const rootReal = realRootOf(opts.root).real;
  const dir = P.dirname(g.real);
  const base = P.basename(g.real);
  let dirId;
  try { dirId = fs.lstatSync(dir, { bigint: true }); if (!dirId.isDirectory()) return fail('parent-missing', 'the target directory is not a directory'); } catch (e) { return fail('parent-missing', `the target directory: ${errCode(e)}`); }
  const tmpName = `.${base}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const tmp = P.join(dir, tmpName);
  const c = fs.constants;
  const flags = c.O_WRONLY | c.O_CREAT | c.O_EXCL | (c.O_NOFOLLOW || 0);
  let fd = null; let created = false; let tmpId = null; let renamed = false;
  const closeFd = () => {
    if (fd === null) return null;
    const f = fd; fd = null;
    try { fs.closeSync(f); return null; } catch (e) { return errCode(e); }
  };
  // W6: the file this call wrote and never renamed is removed wherever it is found inside the root.
  const dropTemp = res => {
    if (!created) return res;
    if (tmpId === null) return { ...res, tempLeft: tmpName, tempLeftReal: tmp, remains: [{ path: tmp, what: 'temp' }] };
    const where = sameId(statOrNull(tmp), tmpId) ? tmp : findByInode(rootReal, tmpId.dev, tmpId.ino);
    if (where && unlinkIf(where, tmpId)) return res.remains ? res : { ...res, remains: [] };
    return { ...res, tempLeft: tmpName, tempLeftReal: where, remains: [...(res.remains || []), { path: where, what: 'temp' }] };
  };
  const cleanup = res => { closeFd(); return dropTemp(res); };
  // W5: a failed post-check, analysed as observed after the rename.
  const afterRename = detail => {
    closeFd();
    let dirNow = null;
    try { dirNow = fs.realpathSync.native(dir); } catch { /* unknown */ }
    const written = dirNow === null ? null : P.join(dirNow, base);
    const w = written === null ? null : statOrNull(written);
    const ours = w === null ? null : sameId(w, tmpId);
    const outside = written !== null && !insideOrEqual(written, rootReal);
    const res = { ...fail('post-check-failed', detail), written, ours, undone: false, remains: [] };
    if (ours) {
      if (outside) { if (unlinkIf(written, tmpId)) res.undone = true; else res.remains.push({ path: written, what: 'written-outside' }); }
      return res;
    }
    // Where is the file this call wrote? Under the temp name: the rename moved a foreign file. Under the
    // target name in the original directory: the rename was right and the directory moved afterwards.
    const found = findByInode(rootReal, tmpId.dev, tmpId.ino);
    const movedAfter = found !== null && P.basename(found) === base && sameId(statOrNull(P.dirname(found)), dirId);
    if (movedAfter && found === g.real) return { ...res, written: found, ours: true };
    if (movedAfter) { res.remains.push({ path: found, what: 'written-elsewhere' }); return res; }
    if (found === null) {
      // Neither the target nor the root holds the file this call wrote: its place is unknown.
      if (w !== null && outside) res.remains.push({ path: written, what: 'moved-foreign' });
      res.remains.push({ path: null, what: 'own-file' });
      return res;
    }
    // The file this call wrote is in the root but not where its rename would have put it: the rename moved
    // a foreign file. Outside the root it goes back to its old name when that name is free.
    if (w !== null && outside) {
      const src = P.join(dirNow, tmpName);
      let back = false;
      if (statOrNull(src) === null) { try { fs.renameSync(written, src); back = sameId(statOrNull(src), w); } catch { /* reported below */ } }
      if (back) res.undone = true; else res.remains.push({ path: written, what: 'moved-foreign' });
    }
    return dropTemp(res); // the file this call wrote never became the target: it is a temp file
  };
  try {
    try { fd = fs.openSync(tmp, flags, opts.mode === undefined ? 0o666 : opts.mode); created = true; } catch (e) { return fail('temp-create-failed', errCode(e)); }
    const st = fs.fstatSync(fd, { bigint: true });
    tmpId = { dev: st.dev, ino: st.ino };
    // Transfer the pin to the open temp file before releasing the exclusive
    // directory handle: NTFS rename needs the directory to be shareable again.
    releaseParent();
    // Recheck before the first byte as well as before rename. The parent pin
    // prevents a Windows swap; POSIX retains its documented last-check window.
    const beforeBytes = guard();
    const rootBeforeBytes = realInside(P.parse(opts.root).root, opts.root, { allowRoot: true });
    if (!beforeBytes.ok || !sameReal(beforeBytes.real, g.real) || !rootBeforeBytes.ok
        || !sameReal(rootBeforeBytes.real, rootReal) || st.nlink !== 1n
        || !sameId(statOrNull(dir), dirId)) return cleanup(fail('swapped', 'path changed before the first byte'));
    let off = 0;
    while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off);
    fs.fsyncSync(fd);
    // The handle stays open (W3): it pins the directory chain on Windows until the post-check is done.
    if (typeof opts.onTempWritten === 'function') opts.onTempWritten({ temp: tmp, target: g.real });
    const g2 = guard();
    if (!g2.ok) return cleanup(fail('swapped', `the second guard refused: ${g2.reason}`));
    if (g2.real !== g.real) return cleanup(fail('swapped', 'the target resolves to another real path'));
    const ts = statOrNull(tmp);
    if (!ts || !ts.isFile() || !sameId(ts, tmpId) || ts.nlink !== 1n) return cleanup(fail('swapped', 'the temp file is not the file this call wrote'));
    let dirReal;
    try { dirReal = fs.realpathSync.native(dir); } catch (e) { return cleanup(fail('swapped', `the directory: ${errCode(e)}`)); }
    if (dirReal !== dir || !sameId(statOrNull(dir), dirId)) return cleanup(fail('swapped', 'the directory is not the directory of the first guard'));
    for (let attempt = 1; ; attempt++) {
      if (attempt > 1) {
        if (renamePlan.hook) renamePlan.hook(attempt);
        const pauseSwap = detail => {
          closeFd();
          return { ...fail('swapped', detail), tempLeft: tmpName, tempLeftReal: tmp, remains: [{ path: tmp, what: 'temp' }] };
        };
        const gAttempt = guard();
        if (!gAttempt.ok || gAttempt.real !== g.real || gAttempt.type === 'dir') return pauseSwap('the target resolves to another real path');
        const tsAttempt = statOrNull(tmp);
        if (!tsAttempt || !tsAttempt.isFile() || !sameId(tsAttempt, tmpId) || tsAttempt.nlink !== 1n) return pauseSwap('the temp file is not the file this call wrote');
        let dirRealAttempt;
        try { dirRealAttempt = fs.realpathSync.native(dir); } catch (e) { return pauseSwap(`the directory: ${errCode(e)}`); }
        if (dirRealAttempt !== dir || !sameId(statOrNull(dir), dirId)) return pauseSwap('the directory is not the directory of the first guard');
      }
      try {
        fs.renameSync(tmp, g.real);
        renamed = true;
        break;
      } catch (e) {
        const wait = WIN && RETRYABLE_PIN_CODES.includes(e && e.code) ? renamePlan.nextDelay(attempt) : -1;
        if (wait < 0) return cleanup(fail('rename-failed', errCode(e)));
        renamePlan.sleep(wait);
      }
    }
    let dirNow = null; let after = null;
    try { dirNow = fs.realpathSync.native(dir); after = fs.lstatSync(g.real, { bigint: true }); } catch (e) { return afterRename(`the check after the rename: ${errCode(e)}`); }
    if (dirNow !== dir || !sameId(statOrNull(dir), dirId)) return afterRename('the directory changed during the rename');
    if (!after.isFile() || !sameId(after, tmpId)) return afterRename('the target is not the file this call wrote');
    const closeError = closeFd();
    let dirSynced = null;
    if (!WIN) {
      let dfd = null;
      try { dfd = fs.openSync(dir, 'r'); fs.fsyncSync(dfd); dirSynced = true; } catch { dirSynced = false; } finally { if (dfd !== null) fs.closeSync(dfd); }
    }
    const ok = { ok: true, real: g.real, bytes: bytes.length, dirSynced };
    return closeError ? { ...ok, closeError } : ok;
  } catch (e) {
    const res = fail('write-failed', errCode(e));
    return renamed ? afterRename(`after the rename: ${errCode(e)}`) : cleanup(res);
  }
}

module.exports = { realInside, sameFileOrNested, writeAtomicGuarded, readFileGuarded, mkdirGuarded, withDirectoryPinned, segmentProblem, lexicalProblem };

'use strict';
// pairs-write: the ONLY file of the pairs recorder that creates, replaces or removes a file on disk. It does one thing: append lines to a pair journal or an
// epoch ledger of the pairs folder, by writing the whole new content into a temporary file of its own and publishing it with one rename.
// What it does about the reviewed attacks and races (the guard of the recorder):
//   - the output folder is resolved again by the caller's guard (checkDir) at write time, after the folder was created, and once more immediately before
//     the rename; any answer that is not the folder accepted first is a refusal, so a link swapped in after the first check cannot redirect the write;
//   - the temporary file is created with exclusive creation (flag wx) under a random name, so an existing file, a hardlink or a link of that name is never
//     opened and never written through; its link count must be 1 before and after the write; it must still be the file that was created (device and
//     inode) and must sit in the accepted folder, checked after it is created and again before the rename;
//   - a journal that is a link or has a link count above 1 is refused;
//   - compare-and-publish: the target is read, the new content is built on exactly those bytes, and immediately before the rename the target is read again;
//     when it differs (another writer appended meanwhile) nothing is published and the append is rebuilt on the new bytes, at most MAX_TRIES times, then it
//     fails with the code APPEND_CONFLICT. A success is never reported for a lost line. The window that remains is the time between the second read and the
//     rename (microseconds): a writer that does not use this module cannot be excluded inside it; the recorder is the single writer of its files by design.
// The only file this module removes is its own temporary file, and only after it created it itself.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_TRIES = 5;
const refuse = reason => Object.assign(new Error(`REFUSED ${reason}`), { code: 'REFUSED' });
const keyOf = p => (process.platform === 'win32' ? p.toLowerCase() : p);
const randomSuffix = () => crypto.randomBytes(6).toString('hex');

/** The target as it is now: null when absent, else its bytes. A link, anything but a regular file, or a link count above 1 is refused. */
function readTarget(target) {
  let st = null;
  try { st = fs.lstatSync(target, { bigint: true }); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  if (!st) return null;
  if (!st.isFile()) throw refuse(`${path.basename(target)} is a link or not a regular file`);
  if (st.nlink > 1n) throw refuse(`${path.basename(target)} has a link count above 1 (a hardlink is never written through)`);
  return fs.readFileSync(target);
}

/** The temporary file is the file that was created, and it sits in the accepted folder (a swapped folder link cannot have redirected it). */
function verifyPlace(tmp, created, dir) {
  const real = fs.realpathSync(tmp);
  if (keyOf(real) !== keyOf(path.join(dir, path.basename(tmp)))) throw refuse('the temporary file is not in the accepted output folder');
  const now = fs.lstatSync(real, { bigint: true });
  if (created.ino !== 0n && (now.ino !== created.ino || now.dev !== created.dev)) throw refuse('the temporary file is not the file that was created');
  if (now.nlink !== 1n) throw refuse('the temporary file has a link count above 1');
}

const sameBytes = (a, b) => (a === null || b === null ? a === b : a.equals(b));

/**
 * Append lines (one per element, a newline is added) to a journal of the accepted output folder; the old bytes stay an exact prefix.
 * @param {{name: string, lines: string[], checkDir: function(): string, hooks?: object, suffix?: function(): string}} o checkDir returns the accepted real path of the output
 *   folder or throws REFUSED; hooks and suffix exist for tests only
 * @returns {{attempts: number, bytes: number}}
 */
function publishAppend({ name, lines, checkDir, hooks = {}, suffix = randomSuffix }) {
  const add = Buffer.from(lines.map(l => `${l}\n`).join(''), 'utf8');
  for (let attempt = 1; attempt <= MAX_TRIES; attempt++) {
    const dir = checkDir();
    fs.mkdirSync(dir, { recursive: true });
    if (keyOf(checkDir()) !== keyOf(dir)) throw refuse('the output folder changed while it was created');
    const target = path.join(dir, name);
    const before = readTarget(target);
    const base = before === null || before.length === 0 || before[before.length - 1] === 0x0a ? (before || Buffer.alloc(0)) : Buffer.concat([before, Buffer.from('\n')]);
    const next = Buffer.concat([base, add]);
    const tmp = path.join(dir, `${name}.tmp-${process.pid}-${suffix()}`);
    let fd;
    try { fd = fs.openSync(tmp, 'wx'); } catch (e) {
      if (e.code === 'EEXIST') throw refuse('the temporary file name already exists (exclusive creation; nothing was opened)');
      throw e;
    }
    let published = false;
    try {
      if (hooks.afterTemp) hooks.afterTemp(tmp);
      const created = fs.fstatSync(fd, { bigint: true });
      if (created.nlink !== 1n) throw refuse('the temporary file has a link count above 1');
      verifyPlace(tmp, created, dir);
      for (let off = 0; off < next.length;) off += fs.writeSync(fd, next, off, next.length - off);
      fs.fsyncSync(fd);
      if (fs.fstatSync(fd, { bigint: true }).nlink !== 1n) throw refuse('the temporary file has a link count above 1');
      fs.closeSync(fd); fd = undefined;
      // Immediately before the rename: the folder is the accepted one, the temporary file is still ours and in it, and the target is what the content was built on.
      const dirNow = checkDir();
      if (keyOf(dirNow) !== keyOf(dir)) throw refuse('the output folder changed before the publish');
      verifyPlace(tmp, created, dirNow);
      if (hooks.beforeCompare) hooks.beforeCompare(target);
      if (!sameBytes(readTarget(target), before)) continue; // another writer appended meanwhile: rebuild on the new bytes
      fs.renameSync(tmp, target); published = true;
      if (!fs.readFileSync(target).equals(next)) throw Object.assign(new Error('APPEND_VERIFY the published file is not what was written'), { code: 'APPEND_VERIFY' });
      return { attempts: attempt, bytes: add.length };
    } finally {
      if (fd !== undefined) { try { fs.closeSync(fd); } catch { /* already closed */ } }
      if (!published) { try { fs.unlinkSync(tmp); } catch { /* it may be gone already */ } }
    }
  }
  throw Object.assign(new Error(`APPEND_CONFLICT ${name} kept changing under the append (${MAX_TRIES} tries); nothing of this append was written`), { code: 'APPEND_CONFLICT' });
}

module.exports = { publishAppend, MAX_TRIES };

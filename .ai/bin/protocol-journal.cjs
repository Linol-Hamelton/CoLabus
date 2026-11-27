#!/usr/bin/env node
'use strict';

// append only through a new newest entry, never edit prior Evidence.
// Caller must use its SessionStart owner. This tool validates layout, not identity.
// Existing handoff reads archived-parent only in the preamble of a legacy journal (in the block form, in the block on
// line 2), so preserve it there.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const textSafe = require('./lib/text-safe.cjs');
const pathSafe = require('./lib/path-safe.cjs');
const hooks = require('./protocol-hooks.cjs');
// The entry is read back through the one entry text model; the input rule below is stricter still: a reserved line or
// a label hidden anywhere in Markdown is refused, never written.
const entryText = require('./lib/entry-text.cjs');
const LABELS = entryText.REQUIRED_LABELS;
// One reading of the archived-parent marker in the preamble, the one model's (parentMarkers): a line of the exact marker
// form that nothing quotes and that stands as a block of its own (a blank line before and after it). The same line in a
// fence, an indented block or a comment is an example, text like any other; glued to a paragraph, or a line that begins
// as the marker comment and is not the exact form (malformed), it is neither marker nor text, and the write proof below
// refuses it by name (ENTRY_AMBIGUOUS: the archived-parent layout is ambiguous) with the line and what clears it. The new entry's
// own input is stricter: any comment that carries the word is refused there (validateBody).
const MARKER_COMMENT = /<!--[^\n]*?archived-parent:/g;
const hash = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

// One lock per session journal, shared by every kernel writer of it: journal add, record, rehash, attach, the archive
// move (manual, and the automatic one of stop and record, the live repair included), the whole-journal move, the stop
// writer and the seat journal commit. The lock is the file .<stem>.add.lock beside the journal, created exclusively and
// held for the writer's whole read, proof and write; it is never waited for: a busy lock refuses with BUSY. Lock order:
// the journal lock, then the shared-document lock that guards .ai/ARCHIVE.md. The whole-journal move runs under the
// shared-document lock its caller took first; neither lock waits, so a busy journal is kept there, never waited for.
// A writer that calls another writer passes its handle, so the nested writer holds the lock once and never refuses
// itself; any other holder, in this process or another, is busy. The lock file names its holder (pid and host): a holder
// on this host whose process is dead is cleared, the dead-holder rule of the shared-document lock; a lock that names no
// holder or a live one is never cleared. Against every kernel writer the lock closes the window between the read and
// the replace. Against a writer that takes no lock (an editor, an older tool) every writer reads the file again right
// before its replace and compares it byte for byte with the snapshot its proof was made on (unchangedOrStale): a change
// is refused as ENTRY_STALE and nothing more is written. That narrows the window to the instant between the last read
// and the replace; the residue is named here, not closed.
const BUSY = 'journal writer is busy or lock needs investigation';
const STALE_REASON = 'the file changed while the tool worked (another writer); nothing more was written; run the command again';
// What clears a damaged block, said without echoing a byte of the journal.
const MARKS_CLEAR = 'the block the tools own on line 2 is damaged; return the first lines to the form the tools write, or take them back from git; the text below the block is not touched; nothing was written';
const owned = new Map();
const journalLockPath = journal => path.resolve(path.dirname(journal), `.${path.basename(journal, '.md')}.add.lock`);

function deadHolder(file) {
  let holder;
  try { holder = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return false; }
  if (!holder || typeof holder !== 'object' || holder.pid === process.pid) return false;
  return require('./protocol-session.cjs').isSessionAlive(holder) === false;
}

function withJournalLock(root, journal, fn, handle = null) {
  const lock = journalLockPath(journal);
  if (handle && owned.get(lock) === handle) return fn(handle);
  if (owned.has(lock)) throw new Error(BUSY);
  let guard = pathSafe.realInside(root, lock, { refuseHardlinks: true });
  if (guard.ok && guard.exists && guard.type === 'file') {
    const seen = fs.lstatSync(guard.real, { bigint: true });
    if (deadHolder(guard.real)) {
      const again = fs.lstatSync(guard.real, { bigint: true });
      if (again.ino === seen.ino && again.dev === seen.dev) {
        fs.unlinkSync(guard.real);
        process.stderr.write('recovered: cleared the journal lock of a dead writer on this host\n');
      }
      guard = pathSafe.realInside(root, lock, { refuseHardlinks: true });
    }
  }
  if (!guard.ok || guard.exists) throw new Error(BUSY);
  let fd = null; let id = null; const mine = { lock };
  try {
    try { fd = fs.openSync(guard.real, 'wx'); } catch { throw new Error(BUSY); }
    id = fs.fstatSync(fd, { bigint: true });
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, hostname: os.hostname(), started: new Date().toISOString() }));
    owned.set(lock, mine);
    return fn(mine);
  } finally {
    if (owned.get(lock) === mine) owned.delete(lock);
    if (fd !== null) fs.closeSync(fd);
    if (id !== null) {
      const now = pathSafe.realInside(root, lock, { refuseHardlinks: true });
      if (now.ok && now.exists) {
        const st = fs.lstatSync(now.real, { bigint: true });
        if (st.ino === id.ino && st.dev === id.dev) fs.unlinkSync(now.real);
      }
    }
  }
}

// The compare before the replace: the file as it stands now against the bytes the proof was made on. A difference (or a
// file gone) is ENTRY_STALE; the caller writes nothing more, and there is no retry inside a tool.
function unchangedOrStale(file, snapshot, rel) {
  let now = null;
  try { now = fs.readFileSync(file); } catch { /* gone: stale */ }
  const before = Buffer.isBuffer(snapshot) ? snapshot : Buffer.from(String(snapshot), 'utf8');
  if (now && now.equals(before)) return;
  throw new Error(`${entryText.ENTRY_STALE}${rel ? ` in ${rel}` : ''}: ${STALE_REASON}.`);
}

function read(root, file, policy = {}) {
  const value = pathSafe.readFileGuarded(root, file);
  if (!value.ok) throw new Error(`journal input refused (${value.reason})`);
  const decoded = textSafe.decode(value.bytes, policy);
  if (!decoded.ok) throw new Error(`journal text refused (${decoded.problems[0].code})`);
  return { bytes: value.bytes, text: decoded.text, real: value.real };
}

function validateBody(body, owner) {
  if (/^## |^Evidence:|journal-checkpoint:/m.test(body) || body.match(MARKER_COMMENT)) throw new Error('entry contains reserved structure');
  if (hooks.findSecretLeak(body)) throw new Error('entry contains an unredacted secret pattern');
  const own = textSafe.maskMarkdown(body).lines.filter(l => !l.masked && !l.partial).map(l => l.text);
  for (const label of LABELS) {
    const pattern = new RegExp(`^${label}:`);
    if (own.filter(l => pattern.test(l)).length !== 1) throw new Error(`entry needs exactly one own ${label} label`);
    if (body.split('\n').filter(l => pattern.test(l)).length !== 1) throw new Error('entry contains duplicate or hidden labels');
  }
  const complete = entryText.latestCompleteEntry('## 2000-01-01 - Input\n\n' + body);
  if (!complete) throw new Error('entry needs all five nonempty labels');
  const agent = owner.replace(/-[a-f0-9]{16}$/, '');
  if (!(entryText.entryField(complete, 'Agent') || '').match(new RegExp(`^${agent}(?:$|[ ,;(])`, 'i'))) throw new Error('entry Agent differs from owner');
}

function compose(previous, body, title, date) {
  // The cut is the model's: the first heading outside a quote, so a quoted example heading in the preamble stays text.
  const first = entryText.splitSections(previous)[0] || '';
  const preamble = /^## /.test(first) ? '' : first;
  const tail = previous.slice(preamble.length);
  // Older entries are preserved bytes and never read for the marker. A journal in the block form keeps its parent in
  // the block the tools own on line 2, so its preamble is text and is not read for a marker (a damaged block is refused
  // by name by the write proof).
  if (entryText.readMarks(previous).form === 'legacy' && entryText.parentMarkers(preamble).length > 1) throw new Error('archived-parent layout is ambiguous');
  const entry = `## ${date} - ${title}\n\n${body.trimEnd()}\n`;
  const checkpoint = `<!-- journal-checkpoint: ${hash(Buffer.from(entry, 'utf8'))} -->\n\n`;
  // The checkpoint is prose metadata, not Evidence. One write publishes both.
  return preamble.trimEnd() + '\n\n' + entry + '\n' + checkpoint + tail;
}

function add(options, deps = {}) {
  const { owner, title, from } = options;
  if (typeof owner !== 'string' || !/^[a-z][a-z0-9_-]*-[a-f0-9]{16}$/.test(owner)) throw new Error('invalid owner name');
  if (typeof title !== 'string' || title.trim() !== title || !title || title.length > 120 || /[\r\n\x00-\x1f\x7f]/.test(title) || hooks.findSecretLeak(title)) throw new Error('invalid title');
  if (!textSafe.decode(Buffer.from(title), { invisible: 'refuse' }).ok) throw new Error('invalid title');
  if (typeof from !== 'string' || !from) throw new Error('missing --from');
  const root = path.resolve(options.root || process.cwd());
  const file = path.join(root, '.ai', 'worklog', `${owner}.md`);
  const source = path.resolve(root, from);
  if (pathSafe.sameFileOrNested(file, source)) throw new Error('entry input aliases journal');
  const input = read(root, source, { invisible: 'refuse', finalNewline: 'refuse' });
  validateBody(input.text, owner);
  const target = pathSafe.realInside(root, file, { refuseHardlinks: true });
  if (!target.ok || !target.exists || target.type !== 'file') throw new Error('start the session before journal add');
  return withJournalLock(root, file, () => {
    if (typeof options.onLocked === 'function') options.onLocked();
    const previous = read(root, file);
    const date = (deps.now || (() => new Date()))().toISOString().slice(0, 10);
    const combined = compose(previous.text, input.text, title, date);
    // The result is proven before the one write: one new complete newest entry, every older section byte for byte, the
    // chain verifies.
    const proof = entryText.checkJournalWrite(previous.text, combined, { kind: 'add' });
    if (!proof.ok) throw new Error(entryText.refusalMessage(proof));
    const result = writeCompared(root, file, Buffer.from(combined, 'utf8'), previous.bytes, null, options.onBeforePublish);
    if (!result.ok || result.closeError) throw new Error(`journal publish refused (${result.reason || result.closeError})`);
    return { owner, checkpoint: hash(Buffer.from(`## ${date} - ${title}\n\n${input.text.trimEnd()}\n`, 'utf8')) };
  });
}

// The one replace of a journal writer: the bytes go to a temp file, the journal is compared with the snapshot of the
// proof (unchangedOrStale) and only then renamed over it. ENTRY_STALE is thrown with nothing written; any other refusal of
// the guarded writer is returned to the caller as it was.
function writeCompared(root, file, bytes, snapshot, rel, beforeCompare) {
  let stale = null;
  const result = pathSafe.writeAtomicGuarded(file, bytes, {
    root,
    onTempWritten: () => {
      if (typeof beforeCompare === 'function') beforeCompare();
      try { unchangedOrStale(file, snapshot, rel); } catch (e) { stale = e; throw e; }
    },
  });
  if (stale) throw stale;
  return result;
}

function main(argv) {
  try {
    if (argv[0] !== 'add') throw new Error('usage: add --owner OWNER --title ASCII --from FILE [--root ROOT]');
    const options = {};
    const allowed = new Set(['--owner', '--title', '--from', '--root']);
    for (let i = 1; i < argv.length; i += 2) {
      if (!allowed.has(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--') || Object.hasOwn(options, argv[i].slice(2))) throw new Error('invalid or duplicate argument');
      if (!/^[\x20-\x7e]+$/.test(argv[i + 1])) throw new Error('CLI values must be ASCII; deliver text through UTF-8 --from file');
      options[argv[i].slice(2)] = argv[i + 1];
    }
    const value = add(options);
    process.stdout.write(`JOURNAL ADDED owner=${value.owner} checkpoint=${value.checkpoint}\n`);
    return 0;
  } catch (e) {
    // No source bytes, argv values, paths or secret matches are echoed.
    const named = /^((?:ENTRY|MARKS)_[A-Z_]+)\b/.exec(String(e && e.message));
    const why = !named ? (String(e && e.message) === BUSY ? BUSY : 'input, layout or publication refused')
      : named[1] === entryText.ENTRY_STALE ? `${named[1]} (${STALE_REASON})`
        : named[1] === entryText.MARKS_BLOCK_DAMAGED ? `${named[1]} (${MARKS_CLEAR})` : `${named[1]} (the write postconditions)`;
    process.stderr.write(`BLOCKED journal add: ${why}\n`);
    return 2;
  }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { add, compose, validateBody, main, withJournalLock, unchangedOrStale, writeCompared, journalLockPath, BUSY };

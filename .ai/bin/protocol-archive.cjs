#!/usr/bin/env node
'use strict';

// Moves older entries from a session journal into .ai/ARCHIVE.md,
// preserving newest entries and provenance headers.
// Reports size limit status for protocol documents.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const lockModule = require('./protocol-lock.cjs');
const hooks = require('./protocol-hooks.cjs');

function extractEntryHash(entryText) {
  const match = entryText.match(/^[ \t]*-[ \t]+entry:[ \t]*(sha256:[a-f0-9]{64})\b/m);
  if (match) {
    const clean = hooks.canonicalEntryBody(entryText);
    const actualHash = `sha256:${crypto.createHash('sha256').update(clean, 'utf8').digest('hex')}`;
    if (actualHash === match[1]) return match[1];
  }
  return null;
}

const DATED_SECTION_SPLIT = new RegExp('(?=' + hooks.DATE_HEADING_M_REGEX.source + ')', 'm');

function splitDatedSections(text) {
  const normalized = String(text).replace(/\r\n/g, '\n');
  return normalized.split(DATED_SECTION_SPLIT).filter(section => hooks.DATE_HEADING_M_REGEX.test(section));
}

function parseArchiveEntryHashes(text) {
  const valid = new Set();
  for (const section of splitDatedSections(text)) {
    const hash = extractEntryHash(section);
    if (hash) valid.add(hash);
  }
  return valid;
}


// A section can carry the tail of a neighbouring dump because the archive
// splitter glued it on. That tail starts at the next "<!-- archived from ... -->"
// provenance marker after this record's own "- entry:" line; cutting there
// recovers the record's own body (a tail marker that does not match its record).
const ARCHIVED_FROM_MARKER_M = /<!--[ \t]*archived from\b/;
const ENTRY_LABEL_LINE_M = /^[ \t]*-[ \t]+entry:[^\n]*$/m;
const ENTRY_LABEL_LINES_M = /^[ \t]*-[ \t]+entry:[^\n]*$/gm;

// Minimum length of the shorter body in a prefix relation. Bodies start with
// the dated heading, so a short common prefix is just a shared heading, not a
// relation between two copies of one record.
const MIN_PREFIX_MATCH = 64;

// The five labels every journal entry carries (AGENTS.md section 5). A record
// with no "- entry:" label line has nothing else that authenticates it, so it
// must at least be a complete entry before it may be appended as new.
const REQUIRED_LABELS = ['Agent', 'Action', 'Result', 'Next step', 'Open'];

function stripNeighbourDumpTail(section) {
  const entryIndex = section.search(ENTRY_LABEL_LINE_M);
  if (entryIndex === -1) return section;
  const lineEnd = section.indexOf('\n', entryIndex);
  if (lineEnd === -1) return section;
  const head = section.slice(0, lineEnd + 1);
  const rest = section.slice(lineEnd + 1);
  const cut = rest.search(ARCHIVED_FROM_MARKER_M);
  if (cut === -1) return section;
  return head + rest.slice(0, cut);
}

// Label-independent identity of a record. Two copies of one entry normalise to
// the same string even when one carries a parser tail, a stale label or is a
// truncation of the other. This identity finds candidates; it never decides a
// skip (see archiveHoldsRawText).
function normalizedEntryBody(section) {
  if (!section) return '';
  const normalized = String(section).replace(/\r\n/g, '\n');
  return hooks.canonicalEntryBody(stripNeighbourDumpTail(normalized));
}

// The raw text of a record as it would be appended: CRLF->LF, and trailing
// whitespace removed (archiveWorklog hands over the entry already trimmed of
// its journal separator; whitespace at the very end is not a line). No marker,
// label, tail or inner whitespace handling is applied here.
function rawEntryText(section) {
  if (!section) return '';
  return String(section).replace(/\r\n/g, '\n').replace(/\s+$/, '');
}

// The only ground for a skip. True when the present record holds every line of
// the incoming raw text, in order, contiguous and line-aligned: the incoming
// text must start at a line start of the present text and its last line must
// end at a line end. A partial last line, a reordered label line, a stripped
// marker tail or a trailing line that canonicalisation would drop all fail
// this check, and the caller then refuses instead of skipping.
function archiveHoldsRawText(incomingRaw, presentRaw) {
  const incoming = rawEntryText(incomingRaw);
  if (incoming.length === 0) return false;
  const present = String(presentRaw || '').replace(/\r\n/g, '\n');
  return (`\n${present}\n`).includes(`\n${incoming}\n`);
}

function isTruncatedCopyOf(incoming, present) {
  if (!incoming || !present) return false;
  return incoming.length >= MIN_PREFIX_MATCH && incoming.length < present.length && present.startsWith(incoming);
}

function isExtensionOf(incoming, present) {
  if (!incoming || !present) return false;
  return present.length >= MIN_PREFIX_MATCH && present.length < incoming.length && incoming.startsWith(present);
}

function missingRequiredLabels(section) {
  return REQUIRED_LABELS.filter(label => hooks.entryField(section, label) === null);
}

// Everything an append must be checked against: every dated section already
// stored, each remembered with its authenticated label (if any), its
// label-independent canonical body (classes C and D) and its raw text, which
// is what a skip is finally proven against. Records are delimited by dated
// headings only, as in the journal (splitDatedSections).
function createArchiveIndex() {
  return { byLabel: new Map(), byBody: new Map(), records: [] };
}

function buildArchiveIndex(archiveText) {
  const index = createArchiveIndex();
  for (const section of splitDatedSections(archiveText)) {
    rememberArchiveEntry(index, extractEntryHash(section), normalizedEntryBody(section), section);
  }
  return index;
}

function rememberArchiveEntry(index, labelHash, body, raw) {
  const record = {
    labelHash: labelHash || null,
    body: body || '',
    raw: String(raw || '').replace(/\r\n/g, '\n'),
  };
  index.records.push(record);
  if (record.labelHash) {
    if (!index.byLabel.has(record.labelHash)) index.byLabel.set(record.labelHash, []);
    index.byLabel.get(record.labelHash).push(record);
  }
  if (record.body.length > 0) {
    if (!index.byBody.has(record.body)) index.byBody.set(record.body, []);
    index.byBody.get(record.body).push(record);
  }
}

// Present records that normalisation relates to the incoming one, each with
// the relation that found it. These are candidates only: a skip still has to
// be proven on the raw text of one of them.
function candidateMatches(index, labelHash, body) {
  const candidates = [];
  if (labelHash) {
    for (const record of index.byLabel.get(labelHash) || []) {
      candidates.push({ record, relation: `entry ${labelHash} is already present in .ai/ARCHIVE.md` });
    }
  }
  for (const record of index.byBody.get(body) || []) {
    candidates.push({ record, relation: 'an identical normalized entry body is already present in .ai/ARCHIVE.md' });
  }
  for (const record of index.records) {
    if (isTruncatedCopyOf(body, record.body)) {
      candidates.push({ record, relation: 'this record is a strict prefix (truncated copy) of a present entry body' });
    }
  }
  return candidates;
}

// Decide what to do with one record about to be archived. 'append' means it is
// new; 'skip' means a present record holds every line of this record's raw
// text, so it must not be duplicated and nothing is lost by pruning it. A
// record that cannot be resolved is refused with a thrown reason instead of
// being silently appended or silently skipped:
// - ambiguous: more than one "- entry:" label line in one record;
// - malformed: empty canonical body; a single label that does not
//   authenticate its body; or no label at all and not all five entry labels;
// - normalised match without raw containment: the record's label or
//   normalised body matches a present record, or is a strict prefix of one,
//   but no such record holds the raw incoming text line for line (a stripped
//   marker tail, a differing label line, a trailing line canonicalisation
//   drops), so a skip would drop text that exists only in the journal;
// - uncertain identity: the record strictly extends a present body, so a
//   skip would drop text that exists only in the journal.
// The prime rule: a refusal never loses text; a skip is allowed only when the
// archive provably holds every line of the incoming raw text. Normalisation
// finds candidates and grounds refusals; it never justifies a skip.
function identifyArchiveEntry(entry, index) {
  const normalized = String(entry).replace(/\r\n/g, '\n');
  const labelLines = normalized.match(ENTRY_LABEL_LINES_M) || [];
  if (labelLines.length > 1) {
    throw new Error(
      `Refusing to archive an ambiguous record: ${labelLines.length} 'entry:' label lines in one record.`);
  }
  const labelHash = extractEntryHash(entry);
  const body = normalizedEntryBody(entry);
  const raw = rawEntryText(entry);
  if (body.length === 0) {
    throw new Error('Refusing to archive a malformed record: its canonical body is empty.');
  }
  const candidates = candidateMatches(index, labelHash, body);
  if (candidates.length > 0) {
    // The single place a skip is decided. Every candidate was found by
    // normalisation; only raw containment turns one into a skip.
    const held = candidates.find(candidate => archiveHoldsRawText(raw, candidate.record.raw));
    if (held) {
      return {
        action: 'skip',
        reason: `${held.relation}; that present entry holds every line of this record's raw text`,
        labelHash, body, raw,
      };
    }
    throw new Error(
      `Refusing to archive a record whose normalized identity matches a present entry (${candidates[0].relation}) `
      + 'but whose raw text is not held line for line by any matching present entry: a skip would drop text that exists '
      + 'only in the journal. Resolve it by hand; nothing was modified.');
  }
  if (index.records.some(record => isExtensionOf(body, record.body))) {
    throw new Error(
      'Refusing to archive a record whose body strictly extends a present entry body: the tail exists only in the journal '
      + 'and the present copy cannot be proven a truncation of this record. Resolve it by hand; nothing was modified.');
  }
  if (labelLines.length === 1 && !labelHash) {
    throw new Error(
      'Refusing to archive a record whose "entry:" label does not match its body and which matches no present copy.');
  }
  const missing = labelLines.length === 0 ? missingRequiredLabels(normalized) : [];
  if (missing.length > 0) {
    throw new Error(
      `Refusing to archive a malformed record: it carries no "entry:" label and lacks the entry label(s) ${missing.join(', ')}; `
      + 'it matches no present copy, so it was neither appended nor pruned.');
  }
  return { action: 'append', reason: 'new entry', labelHash, body, raw };
}

function parseArgs(argv) {
  const command = argv[0];
  const options = { keep: 1, root: process.cwd(), owner: null };
  let target = null;

  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--keep') {
      const val = argv[++i];
      // A positive whole number: a negative value used to act as "keep all but the oldest" and 0 emptied the journal.
      if (!val || !/^[1-9][0-9]*$/.test(val)) throw new Error('Missing or invalid value for --keep (a whole number of at least 1)');
      options.keep = parseInt(val, 10);
    } else if (arg === '--root') {
      const val = argv[++i];
      if (!val) throw new Error('Missing value for --root');
      options.root = val;
    } else if (arg === '--owner') {
      const val = argv[++i];
      if (!val) throw new Error('Missing value for --owner');
      options.owner = val;
    } else if (arg === '--plan' || arg === '--execute') {
      // Both flags belong to the journals command alone; worklog and status
      // refused them before it existed and keep refusing them.
      if (command !== 'journals') throw new Error(`Unknown option: ${arg}`);
      if (arg === '--plan') options.plan = true;
      if (arg === '--execute') options.execute = true;
    } else if (!target && !arg.startsWith('--')) {
      target = arg;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!['worklog', 'journals', 'status'].includes(command)) {
    throw new Error('Usage: protocol-archive.cjs worklog <path> [--keep <n>] [--root <dir>]\n'
      + '       protocol-archive.cjs journals [--plan] [--execute --owner NAME] [--root <dir>]\n'
      + '       protocol-archive.cjs status [--root <dir>]');
  }

  if (command === 'worklog' && !target) {
    throw new Error('Usage: protocol-archive.cjs worklog <path> [--keep <n>] [--root <dir>]');
  }

  if (command === 'journals') {
    if (target) throw new Error('journals takes no path; it plans or moves whole journals of .ai/worklog');
    if (options.plan && options.execute) throw new Error('journals: choose --plan or --execute, not both');
    if (options.execute && !options.owner) {
      throw new Error('journals --execute needs --owner NAME, the session that holds the shared-document lock');
    }
    if (options.owner && !options.execute && !options.plan) {
      // --owner alone is harmless: the plan ignores it. Accepted for symmetry.
    }
  }

  return { command, target, options };
}

function getLineCount(text) {
  if (!text || text.length === 0) return 0;
  const matches = text.match(/\n/g);
  let count = matches ? matches.length : 0;
  if (!text.endsWith('\n')) count++;
  return count;
}

function atomicRename(tempFile, targetFile, retries = 5, delayMs = 50) {
  for (let i = 0; i < retries; i++) {
    try {
      fs.renameSync(tempFile, targetFile);
      return;
    } catch (err) {
      if ((err.code === 'EPERM' || err.code === 'EBUSY' || err.code === 'EACCES') && i < retries - 1) {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.floor(delayMs * Math.pow(1.5, i)));
        continue;
      }
      throw err;
    }
  }
}

// An archive run killed in the middle leaves two things behind: the lock of its temporary owner (archive-<hex>, the pid of the
// killed process) and its temp files in .ai/runtime. A later run recovers both: the lock only when it is one of
// those temporary owners, on this host, with a dead process; any other holder is never cleared automatically. The orphan temp
// files are moved, not deleted, into .ai/runtime/quarantine/<UTC stamp>/ with one line each in MOVES.jsonl there.
function isAbandonedArchiveLock(lock) {
  return Boolean(lock) && /^archive-[0-9a-f]{1,8}$/.test(String(lock.owner)) && !lock.tokenHash
    && lock.hostname === os.hostname() && lock.alive === false;
}

const ORPHAN_TEMP = /^(?:worklog|archive)-atomic-\d+-[a-z0-9]{0,4}\.tmp$/;

function quarantineOrphanTemps(runtimeDir) {
  if (!fs.existsSync(runtimeDir)) return;
  const names = fs.readdirSync(runtimeDir).filter(name => ORPHAN_TEMP.test(name));
  if (!names.length) return;
  const base = path.join(runtimeDir, 'quarantine');
  fs.mkdirSync(base, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  let dir = null;
  for (let n = 0; !dir; n += 1) {
    const candidate = path.join(base, n ? `${stamp}-${n}` : stamp);
    try { fs.mkdirSync(candidate); dir = candidate; } catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  for (const name of names) {
    const from = path.join(runtimeDir, name);
    const bytes = fs.readFileSync(from);
    fs.appendFileSync(path.join(dir, 'MOVES.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), rel: name,
      reason: 'orphan temp file of an interrupted archive run', bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex') })}\n`);
    fs.renameSync(from, path.join(dir, name));
    console.log(`recovered: moved the orphan temp file ${name} to .ai/runtime/quarantine/${path.basename(dir)}`);
  }
}

// --- Journal count hygiene (JOURNAL-HYGIENE) --------------------------------
//
// The worklog count cap (validator CM-22, AGENTS.md section 8) had no tool:
// `worklog` archives entries of ONE journal, and a journal with entries is
// history that AGENTS.md section 5 said is archived by hand, so the count grew
// until the host warned forever. The `journals` command moves whole completed
// session journals into .ai/ARCHIVE.md, oldest first, until the count is
// under the cap with a stated headroom. A move appends the journal's exact
// bytes under a header naming the original file, verifies the appended bytes,
// and only then removes the journal file. Plan is the default and changes
// nothing; execute requires the shared-document lock held by the given owner.

const JOURNAL_FILE_CAP = 300;      // validator CM-22, AGENTS.md section 8
const JOURNAL_COUNT_HEADROOM = 20; // execute moves journals until the count is at most cap - headroom
const JOURNAL_RECENT_WINDOW_MS = 24 * 60 * 60 * 1000; // a journal modified inside this window may be in progress

// The header of one whole-journal record in .ai/ARCHIVE.md. It names the
// original file and the sha256 and length of the appended bytes, so an
// interrupted move (append done, remove not done) is recognised by it.
function journalRecordHeader(name, content) {
  const hash = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
  const dateStamp = new Date().toISOString().split('T')[0];
  return `### From journal .ai/worklog/${name}, archived ${dateStamp} (${content.length} bytes, ${hash})`;
}

function journalHeaderRegex(name) {
  const escaped = name.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&');
  // The header counts as a record boundary only inside the exact framing this
  // tool writes: a --- separator line, then the header line, then a blank
  // line. A line that merely quotes the header inside an archived journal is
  // text, not a boundary, and must not mark the journal as half-moved.
  return new RegExp(
    `\\n---\\n\\n### From journal \\.ai/worklog/${escaped}, archived \\d{4}-\\d{2}-\\d{2} \\((\\d+) bytes, (sha256:[a-f0-9]{64})\\)\\n\\n`);
}

// The bytes appended for one whole-journal record. The journal's own bytes are
// preserved exactly; the one LF added after them (only when the journal has no
// final newline) is record framing outside the journal text, so the archive
// file keeps a proper final newline whatever the journal looked like.
function journalRecordAddition(header, content) {
  const framed = content.length > 0 && content[content.length - 1] === 0x0a
    ? content
    : Buffer.concat([content, Buffer.from('\n', 'utf8')]);
  return Buffer.concat([
    Buffer.from(`\n---\n\n${header}\n\n`, 'utf8'),
    framed,
    Buffer.from('\n', 'utf8'),
  ]);
}

function archiveHoldsBytes(haystack, needle) {
  if (!needle || needle.length === 0) return false;
  return Buffer.isBuffer(haystack) && haystack.includes(needle);
}

// A journal may only be moved when its bytes are plain LF UTF-8 text: the
// archive is a tracked text file under the strict encoding contract
// (PROTO-DEC-0153), so appending CR, NUL, a BOM or invalid UTF-8 would put a
// permanent validator FAIL into the archive. Such a journal is kept, never
// moved; the report names this rule.
function journalEncodingProblem(content) {
  if (content.length === 0) return 'empty';
  if (content[0] === 0xEF && content[1] === 0xBB && content[2] === 0xBF) return 'UTF-8 BOM';
  if (content.includes(0)) return 'NUL byte';
  if (content.includes(13)) return 'CR byte';
  try { new TextDecoder('utf-8', { fatal: true }).decode(content); } catch { return 'invalid UTF-8'; }
  return null;
}

// The liveness signals that keep a journal in place, in the order they are
// checked. Every signal says keep or nothing; when liveness is unknown the
// file stays (the never rule of the task). protocol-session.cjs is required
// lazily inside the check: protocol-session stop requires this module back.
function journalSessionSignal(root, stem) {
  const stateFile = path.join(root, '.ai', 'runtime', `${stem}.json`);
  if (!fs.existsSync(stateFile)) return null;
  let state = null;
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = null; }
  const alive = require('./protocol-session.cjs').isSessionAlive(state);
  if (alive === true) return 'session marker alive';
  if (alive === null) return 'session marker liveness unknown (another host or no readable pid)';
  return null;
}

function dayStamp(ms) {
  return new Date(ms).toISOString().split('T')[0];
}

// A certifying review names its journal with the Receipt-Owner label (or the
// legacy Session label), and the consumers of the Completion gate read that
// journal by name (.ai/bin/protocol-handoff/gate.cjs):
// moving it turns the host validator red with "journal for Receipt-Owner ...
// not found". The plan therefore keeps every owner name it can read from the
// reviews the Completion gate of .ai/TASK.md points at, reading them the same
// way the gate does. Unknown or unreadable means keep: when
// the signal cannot be computed, no journal can be proven safe to move.
const RECEIPT_OWNER_LABEL_M = /^[ \t]*(?:\*\*)?(?:\bReceipt-Owner\b|\bSession\b)(?:\*\*)?\s*:\s*([^\r\n]+)/im;
const COMPLETION_GATE_M = /(?:^|\n)## Completion gate[ \t]*\r?\n([\s\S]*?)(?=(?:\n## )|$)/;

// The header region of a review, the same boundary the gate uses: the text
// before the first line equal to '---'; if there is no such line, before the
// first '## ' heading; if neither exists, the whole file.
function reviewHeaderRegion(reviewText) {
  const lines = String(reviewText).split(/\r?\n/);
  let headerEnd = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') { headerEnd = i; break; }
  }
  if (headerEnd === -1) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].startsWith('## ')) { headerEnd = i; break; }
    }
  }
  return headerEnd === -1 ? String(reviewText) : lines.slice(0, headerEnd).join('\n');
}

// The Receipt-Owner (or legacy Session) names of the reviews the Completion
// gate points at, read with the gate's own path and label extraction. Returns
// { owners, unreadable }: owners is the set of journal stems the gate reads by
// name; unreadable is null, or the reason no journal can be proven safe.
function completionGateReceiptOwners(root) {
  const result = { owners: new Set(), unreadable: null };
  const taskFile = path.join(root, '.ai', 'TASK.md');
  if (!fs.existsSync(taskFile)) return result; // no task file: no gate, no signal
  let taskText;
  try { taskText = fs.readFileSync(taskFile, 'utf8'); } catch {
    result.unreadable = '.ai/TASK.md cannot be read';
    return result;
  }
  const gateMatch = taskText.match(COMPLETION_GATE_M);
  if (!gateMatch) return result; // no Completion gate: nothing points at a review
  const reviewPaths = [];
  for (const label of ['Adversarial review prompt', 'Independent review']) {
    const match = gateMatch[1].match(new RegExp(`^[ \\t]*-[ \\t]+${label}:[ \\t]*(\\S+)[ \\t]*$`, 'm'));
    if (match) reviewPaths.push(match[1].replace(/\\/g, '/').replace(/^\.\//, '').trim());
  }
  for (const rel of reviewPaths) {
    // The same safe-path rule the gate enforces: a review outside the root is
    // not a review this plan can reason about.
    const full = path.resolve(root, rel);
    const relation = path.relative(root, full);
    if (!rel || relation.startsWith('..') || path.isAbsolute(relation)) {
      result.unreadable = `the Completion gate names a review outside the root: ${rel}`;
      return result;
    }
    let reviewText;
    try {
      if (!fs.statSync(full).isFile()) throw new Error('not a file');
      reviewText = fs.readFileSync(full, 'utf8');
    } catch {
      result.unreadable = `the Completion gate names a review that cannot be read: ${rel}`;
      return result;
    }
    const header = reviewHeaderRegion(reviewText);
    let scanned = header;
    while (true) {
      const match = scanned.match(RECEIPT_OWNER_LABEL_M);
      if (!match) break;
      if (match[1].trim()) result.owners.add(match[1].trim());
      scanned = scanned.slice(match.index + match[0].length);
    }
  }
  return result;
}

function journalPlanLimits(options) {
  const cap = Number.isInteger(options.cap) ? options.cap : JOURNAL_FILE_CAP;
  const headroom = Number.isInteger(options.headroom) ? options.headroom : JOURNAL_COUNT_HEADROOM;
  if (cap <= 0 || headroom < 0 || cap - headroom < 0) {
    throw new Error('journal archive limits are invalid: cap must be positive, headroom non-negative');
  }
  return { cap, headroom };
}

// The plan: which journals a run would move, oldest first, and which it keeps,
// with the signal that keeps each one. Read-only over the tree. The cap and
// headroom default to the protocol constants; tests may pass smaller numbers.
function planJournalArchive(root, options = {}) {
  const { cap, headroom } = journalPlanLimits(options);
  const worklogDir = path.join(root, '.ai', 'worklog');
  if (!fs.existsSync(worklogDir)) throw new Error(`No .ai/worklog directory at ${worklogDir}`);
  const archiveFile = path.join(root, '.ai', 'ARCHIVE.md');
  const archiveText = fs.existsSync(archiveFile) ? fs.readFileSync(archiveFile, 'utf8') : null;
  const lockStatus = lockModule.operate(root, 'status');
  const lockOwner = lockStatus.lock ? lockStatus.lock.owner : null;
  const now = Date.now();

  const names = fs.readdirSync(worklogDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
    .map(entry => entry.name)
    .sort();
  const receiptOwners = completionGateReceiptOwners(root);
  const rows = [];
  for (const name of names) {
    const full = path.join(worklogDir, name);
    const stat = fs.statSync(full);
    const content = fs.readFileSync(full);
    const text = content.toString('utf8');
    const stem = name.replace(/\.md$/, '');
    const sections = splitDatedSections(text);
    const row = {
      name, stem, mtimeMs: stat.mtimeMs, bytes: content.length,
      entries: sections.length, keep: null, action: 'move', reason: 'completed session journal',
      missingNewest: sections.length ? missingRequiredLabels(sections[0]) : null,
    };
    rows.push(row);
    // Never-archive signals, in a fixed order; the first that fires wins.
    if (receiptOwners.unreadable) {
      row.keep = `${receiptOwners.unreadable}; no journal can be proven safe to move`;
      continue;
    }
    if (receiptOwners.owners.has(stem)) {
      row.keep = 'a certifying review of the Completion gate of .ai/TASK.md reads this journal by name as its Receipt-Owner';
      continue;
    }
    if (lockOwner === stem) { row.keep = 'the shared-document lock is held by this session'; continue; }
    const sessionSignal = journalSessionSignal(root, stem);
    if (sessionSignal) { row.keep = sessionSignal; continue; }
    if (stat.mtimeMs >= now - JOURNAL_RECENT_WINDOW_MS) { row.keep = 'modified within the recent window (24 h)'; continue; }
    if (sections.length === 0) { row.keep = 'holds no dated entry; prune owns empty journals'; continue; }
    const encoding = journalEncodingProblem(content);
    if (encoding) { row.keep = `refused: not plain LF UTF-8 (${encoding}); the archive is a tracked text file`; continue; }
    // An interrupted move: the append is already in the archive. Finishing it
    // only removes the file, after the bytes are proven present again.
    const headerMatch = archiveText ? journalHeaderRegex(name).exec(archiveText) : null;
    if (headerMatch) {
      const hash = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
      if (Number(headerMatch[1]) === content.length && headerMatch[2] === hash) {
        row.action = 'remove';
        row.reason = 'the append is already in .ai/ARCHIVE.md (an interrupted move); only the removal remains';
      } else {
        row.keep = 'a record naming this journal exists in .ai/ARCHIVE.md with different bytes; resolve by hand';
      }
      continue;
    }
  }
  // The newest journal of each agent whose newest entry is not complete may
  // still be in progress, whatever its mtime says. Journals are newest-first,
  // so the newest entry is the first dated section.
  const newestByAgent = new Map();
  for (const row of rows) {
    const agent = row.stem.split('-')[0];
    const current = newestByAgent.get(agent);
    if (!current || row.mtimeMs > current.mtimeMs) newestByAgent.set(agent, row);
  }
  for (const row of newestByAgent.values()) {
    if (row.keep) continue;
    if (row.entries === 0) continue; // already kept by the empty rule
    if (row.missingNewest.length > 0) {
      row.keep = `the newest journal of agent ${row.stem.split('-')[0]} with an incomplete newest entry (may be in progress)`;
    }
  }

  const total = rows.length;
  const target = cap - headroom;
  const candidates = rows.filter(row => !row.keep).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let taken = 0;
  for (const row of candidates) {
    if (total - taken <= target) break;
    taken += 1;
  }
  const toMove = candidates.slice(0, taken);
  const held = candidates.slice(taken);
  for (const row of held) row.keep = 'target reached; the count is already under the cap with the headroom';
  return {
    root, total, cap, headroom, target,
    toMove, keep: rows.filter(row => row.keep).sort((a, b) => a.mtimeMs - b.mtimeMs),
  };
}

function describeJournalPlan(plan) {
  const lines = [];
  lines.push('AI protocol - journal archive plan (plan only, nothing is changed)');
  lines.push(`Root: ${plan.root}`);
  lines.push(`Journals: ${plan.total} (cap ${plan.cap}, headroom ${plan.headroom}, target ${plan.target}); `
    + `would move ${plan.toMove.length}, keep ${plan.total - plan.toMove.length}`);
  const oneRow = row => `  ${row.name}  ${dayStamp(row.mtimeMs)}  ${row.bytes} bytes  ${row.entries} entries`
    + `  ${row.keep ? 'keep: ' + row.keep : row.reason}`;
  if (plan.toMove.length) {
    lines.push('Would move (oldest first):');
    for (const row of plan.toMove) lines.push(oneRow(row));
  }
  if (plan.keep.length) {
    lines.push(`Keep (${plan.keep.length}):`);
    for (const row of plan.keep) lines.push(oneRow(row));
  }
  return lines.join('\n');
}

// The execute side of the move. The lock must already be held by the given
// owner: the caller acquires it, runs this, then releases it. A failed
// verification aborts the run before the journal is removed, so text is never
// lost and a retry is always safe (idempotent on both sides: an append
// already present is finished by the removal alone).
function executeJournalArchive(root, owner, options = {}) {
  if (!owner) throw new Error('journals --execute needs --owner NAME, the session that holds the shared-document lock');
  const lockStatus = lockModule.operate(root, 'status');
  if (!lockStatus.lock || lockStatus.lock.owner !== owner) {
    const holder = lockStatus.lock ? `it is held by ${lockStatus.lock.owner}` : 'no session holds it';
    throw new Error(`Cannot archive journals: the shared-document lock is not held by ${owner} (${holder}). `
      + 'Acquire it with: node .ai/bin/protocol-lock.cjs acquire --owner NAME, '
      + 'then run journals --execute --owner NAME, then release the lock.');
  }
  const plan = planJournalArchive(root, options);
  const archiveFile = path.join(root, '.ai', 'ARCHIVE.md');
  if (!fs.existsSync(archiveFile)) throw new Error(`ARCHIVE.md not found at ${archiveFile}`);
  const worklogDir = path.join(root, '.ai', 'worklog');
  const runtimeDir = path.join(root, '.ai', 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });
  // The lock is ours, so no other archive run is writing: temp files of an
  // earlier killed run are orphans (same recovery as archiveWorklog).
  quarantineOrphanTemps(runtimeDir);
  const notes = [];
  let moved = 0;
  let finished = 0;
  let skipped = 0;
  for (const row of plan.toMove) {
    const full = path.join(worklogDir, row.name);
    const content = fs.readFileSync(full);
    const sha = `sha256:${crypto.createHash('sha256').update(content).digest('hex')}`;
    // Re-check the per-file signals at execute time: a session may have
    // started or touched this journal since the plan was computed.
    const statNow = fs.statSync(full);
    if (statNow.mtimeMs >= Date.now() - JOURNAL_RECENT_WINDOW_MS) {
      skipped += 1;
      notes.push(`kept ${row.name}: it was modified within the recent window during the run`);
      continue;
    }
    const sessionSignal = journalSessionSignal(root, row.stem);
    if (sessionSignal) {
      skipped += 1;
      notes.push(`kept ${row.name}: ${sessionSignal}`);
      continue;
    }
    if (row.action === 'remove') {
      // An interrupted move: the header names this journal with these exact
      // bytes. Prove the bytes are really in the archive before removing.
      if (!archiveHoldsBytes(fs.readFileSync(archiveFile), content)) {
        throw new Error(`Refusing to finish the interrupted move of ${row.name}: the record header is present, `
          + 'but the archived bytes do not hold the journal byte for byte. Nothing was removed; resolve by hand.');
      }
      fs.rmSync(full);
      finished += 1;
      notes.push(`finished an interrupted move: removed ${row.name} (${content.length} bytes, ${sha}; the append was verified)`);
      continue;
    }
    if (row.bytes !== content.length) {
      skipped += 1;
      notes.push(`kept ${row.name}: its bytes changed since the plan; run the plan again`);
      continue;
    }
    const encodingNow = journalEncodingProblem(content);
    if (encodingNow) {
      skipped += 1;
      notes.push(`kept ${row.name}: refused, not plain LF UTF-8 (${encodingNow})`);
      continue;
    }
    const header = journalRecordHeader(row.name, content);
    const addition = journalRecordAddition(header, content);
    const before = fs.readFileSync(archiveFile);
    const tempArchive = path.join(runtimeDir,
      `archive-atomic-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.tmp`);
    try {
      fs.writeFileSync(tempArchive, Buffer.concat([before, addition]));
      atomicRename(tempArchive, archiveFile);
      // Verify the appended bytes before the journal is removed: the archive
      // must equal old bytes plus the addition and must contain the journal.
      const after = fs.readFileSync(archiveFile);
      if (!after.equals(Buffer.concat([before, addition])) || !archiveHoldsBytes(after, content)) {
        throw new Error(`Archive append for ${row.name} could not be verified; the journal was not removed.`);
      }
      fs.rmSync(full);
    } finally {
      if (fs.existsSync(tempArchive)) { try { fs.unlinkSync(tempArchive); } catch (_) {} }
    }
    moved += 1;
    notes.push(`archived ${row.name} to .ai/ARCHIVE.md (${content.length} bytes, ${sha}); removed the journal`);
  }
  // The summary answers from the directory, not by subtraction from the plan:
  // a journal skipped at execute time is still on disk, and both the printed
  // count and the returned remaining must say so.
  const remaining = fs.readdirSync(worklogDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.md') && entry.name !== 'README.md')
    .length;
  const lines = ['AI protocol - journal archive (execute)',
    `Root: ${root}`,
    `Lock: held by ${owner}`,
    `Journals: ${plan.total} -> ${remaining} (cap ${plan.cap}, headroom ${plan.headroom}, target ${plan.target}); `
    + `moved ${moved}, finished ${finished}, kept ${remaining}`];
  for (const note of notes) lines.push(`  ${note}`);
  process.stdout.write(`${lines.join('\n')}\n`);
  return { moved, finished, skipped, remaining, plan };
}

function archiveWorklog(root, worklogPath, keep = 1, owner = null) {
  const fullWorklog = path.isAbsolute(worklogPath) ? worklogPath : path.join(root, worklogPath);
  if (!fs.existsSync(fullWorklog)) {
    throw new Error(`Worklog not found: ${fullWorklog}`);
  }

  const relativeWorklog = path.relative(root, fullWorklog).replace(/\\/g, '/');
  const content = fs.readFileSync(fullWorklog, 'utf8').replace(/\r\n/g, '\n');

  // Split into preamble and entries (entries start with ## YYYY-MM-DD)
  // Derive lookahead splitter from canonical DATE_HEADING_M_REGEX.
  const entryRegex = new RegExp('(?=' + hooks.DATE_HEADING_M_REGEX.source + ')', 'm');
  const matchIndex = content.search(entryRegex);

  if (matchIndex === -1) {
    console.log(`archived 0 entry(s) from ${relativeWorklog}`);
    return;
  }

  const preamble = content.slice(0, matchIndex);
  const entriesBody = content.slice(matchIndex);
  // Split entries
  const rawEntries = entriesBody.split(entryRegex).filter(e => e.trim().length > 0);

  if (rawEntries.length <= keep) {
    console.log(`archived 0 entry(s) from ${relativeWorklog} (${rawEntries.length} total, keeping ${keep})`);
    return;
  }

  const keptEntries = rawEntries.slice(0, keep);
  const toArchive = rawEntries.slice(keep);

  // Clean each entry of trailing separator lines
  const cleanToArchive = toArchive.map(entry => {
    return entry.replace(/\n-{3,}\s*$/, '').trim();
  });

  const archiveFile = path.join(root, '.ai', 'ARCHIVE.md');
  if (!fs.existsSync(archiveFile)) {
    throw new Error(`ARCHIVE.md not found at ${archiveFile}`);
  }

  const dateStamp = new Date().toISOString().split('T')[0];
  const provenanceHeader = `### From ${relativeWorklog}, archived ${dateStamp}`;

  let lockAcquired = false;
  let tempOwner = null;
  let lockStatus = lockModule.operate(root, 'status');
  if (lockStatus.lock && !(owner && lockStatus.lock.owner === owner) && isAbandonedArchiveLock(lockStatus.lock)) {
    // The holder is a temporary archive owner whose process is gone: a killed run, nothing holds the lock now.
    const gone = lockStatus.lock;
    try { lockModule.operate(root, 'clear-lock'); } catch (_) { /* another run took it first: the refusal below says so */ }
    console.log(`recovered: cleared the abandoned lock of a killed archive run (owner ${gone.owner}, pid ${gone.pid})`);
    lockStatus = lockModule.operate(root, 'status');
  }
  if (lockStatus.lock) {
    if (owner && lockStatus.lock.owner === owner) {
      lockAcquired = false;
    } else {
      throw new Error(`Cannot archive: shared documents lock is held by session ${lockStatus.lock.owner}. `
        + 'Inspect it with: node .ai/bin/protocol-lock.cjs status. A holder whose process is dead (for example an archive run that was killed) '
        + 'is cleared with: node .ai/bin/protocol-lock.cjs clear-lock; a live holder is never cleared.');
    }
  } else {
    tempOwner = owner || ('archive-' + Math.random().toString(16).slice(2, 10));
    lockModule.operate(root, 'acquire', tempOwner);
    lockAcquired = true;
  }

  let tempFile = null;
  let tempArchive = null;
  try {
    // The lock is ours now, so no other archive run is writing: temp files of an earlier killed run are orphans.
    quarantineOrphanTemps(path.join(root, '.ai', 'runtime'));
    // Idempotent append: skip entries already present in ARCHIVE.md. Candidate
    // copies are found by the authenticated label and by the label-independent
    // canonical body (with parser-mismatch normalisation), so copies that are
    // equal, truncated or tail-glued are recognised; a skip is then allowed
    // only when a candidate holds every line of the entry's raw text. A record
    // that cannot be resolved is refused (thrown) and nothing is pruned, so an
    // ambiguous record is never silently appended and a normalised look-alike
    // is never silently dropped. A record accepted here joins the index at
    // once, with its raw text, so a second copy of it later in the same batch
    // is skipped rather than appended twice.
    const existingArchive = fs.readFileSync(archiveFile, 'utf8');
    const archiveIndex = buildArchiveIndex(existingArchive);
    const filteredArchive = [];
    for (const entry of cleanToArchive) {
      const decision = identifyArchiveEntry(entry, archiveIndex);
      if (decision.action === 'append') {
        filteredArchive.push(entry);
        rememberArchiveEntry(archiveIndex, decision.labelHash, decision.body, entry);
      }
    }

    // Extract entry hash of the newest archived entry from the clean archived text
    const archivedHash = cleanToArchive.length > 0 ? extractEntryHash(cleanToArchive[0]) : null;

    // Prepare the new journal content FIRST (tmp file), before touching ARCHIVE.md.
    let cleanPreamble = preamble
      .replace(/<!-- archived-parent:\s*sha256:[a-f0-9]{64} -->\s*/g, '')
      .replace(/\n-{3,}\s*$/, '')
      .trim();
    if (archivedHash) {
      cleanPreamble += `\n\n<!-- archived-parent: ${archivedHash} -->`;
    }
    if (cleanPreamble.length > 0) cleanPreamble += '\n\n---\n\n';

    const cleanKept = keptEntries.map(entry => entry.replace(/\n-{3,}\s*$/, '').trim());
    const newJournalContent = cleanPreamble + cleanKept.join('\n\n---\n\n') + '\n';

    // Write trimmed journal to tmp file first
    const runtimeDir = path.join(root, '.ai', 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    tempFile = path.join(runtimeDir, `worklog-atomic-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.tmp`);
    fs.writeFileSync(tempFile, newJournalContent, 'utf8');

    // Now append to ARCHIVE.md (only entries not already present)
    if (filteredArchive.length > 0) {
      const archiveAddition = `\n---\n\n${provenanceHeader}\n\n` + filteredArchive.join('\n\n---\n\n') + '\n';
      // The archive is replaced as a whole through a temp file, byte for byte (old bytes + the addition). A process killed
      // here leaves the old archive or the new one, never half of an entry that every later run would refuse.
      tempArchive = path.join(runtimeDir, `archive-atomic-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.tmp`);
      fs.writeFileSync(tempArchive, Buffer.concat([fs.readFileSync(archiveFile), Buffer.from(archiveAddition, 'utf8')]));
      atomicRename(tempArchive, archiveFile);

      // Read back the append before replacing the journal. A failed rename
      // must leave the journal intact, while a successful append must be
      // provably present for the next idempotent retry.
      const archiveAfter = fs.readFileSync(archiveFile, 'utf8');
      if (!archiveAfter.endsWith(archiveAddition)) {
        throw new Error('Archive append could not be verified; journal was not pruned.');
      }
      const archiveHashes = parseArchiveEntryHashes(archiveAfter);
      for (const entry of filteredArchive) {
        const hash = extractEntryHash(entry);
        if (hash && !archiveHashes.has(hash)) {
          throw new Error(`Archive append is missing verified entry ${hash}; journal was not pruned.`);
        }
      }
    }

    // Finally rename the tmp journal over the original
    atomicRename(tempFile, fullWorklog);
    console.log(`archived ${toArchive.length} entry(s) from ${relativeWorklog} to .ai/ARCHIVE.md`);
  } finally {
    if (lockAcquired && tempOwner) {
      try { lockModule.operate(root, 'release', tempOwner); } catch (_) {}
    }
    if (tempFile && fs.existsSync(tempFile)) {
      try { fs.unlinkSync(tempFile); } catch (_) {}
    }
    if (tempArchive && fs.existsSync(tempArchive)) {
      try { fs.unlinkSync(tempArchive); } catch (_) {}
    }
  }
}

function archiveStatus(root) {
  // Size-limit table for `status` reporting; the Node validator
  // (`.ai/bin/protocol-validate.cjs`) enforces its own limits. When the two
  // disagree, `status` can report a limit the validator does not enforce.
  const limits = {
    '.ai/TASK.md': 80,
    '.ai/PLAN.md': 1000,
    '.ai/worklog': { fileLimit: 300, lineLimit: 150 }
  };

  console.log('AI Collaboration Protocol - Storage & Archiving Status');
  console.log(`Root: ${root}`);

  const taskFile = path.join(root, '.ai', 'TASK.md');
  if (fs.existsSync(taskFile)) {
    const lines = getLineCount(fs.readFileSync(taskFile, 'utf8'));
    console.log(`.ai/TASK.md: ${lines}/${limits['.ai/TASK.md']} lines`);
  }

  const planFile = path.join(root, '.ai', 'PLAN.md');
  if (fs.existsSync(planFile)) {
    const lines = getLineCount(fs.readFileSync(planFile, 'utf8'));
    console.log(`.ai/PLAN.md: ${lines}/${limits['.ai/PLAN.md']} lines`);
  }

  const worklogDir = path.join(root, '.ai', 'worklog');
  if (fs.existsSync(worklogDir)) {
    const files = fs.readdirSync(worklogDir).filter(f => f.endsWith('.md') && f !== 'README.md');
    console.log(`.ai/worklog/: ${files.length}/${limits['.ai/worklog'].fileLimit} files`);
    if (files.length > limits['.ai/worklog'].fileLimit) {
      console.log(`  over the cap: node .ai/bin/protocol-archive.cjs journals --plan, `
        + `then journals --execute --owner NAME under the shared-document lock`);
    }
    for (const f of files) {
      const full = path.join(worklogDir, f);
      const lines = getLineCount(fs.readFileSync(full, 'utf8'));
      if (lines >= 100) {
        console.log(`  .ai/worklog/${f}: ${lines}/${limits['.ai/worklog'].lineLimit} lines`);
      }
    }
  }
}

function autoArchiveWorklog(root, worklogPath, maxLines = 150, keep = 1, owner = null) {
  const fullWorklog = path.isAbsolute(worklogPath) ? worklogPath : path.join(root, worklogPath);
  if (!fs.existsSync(fullWorklog)) return false;
  const content = fs.readFileSync(fullWorklog, 'utf8');
  if (getLineCount(content) > maxLines) {
    try {
      archiveWorklog(root, worklogPath, keep, owner);
      return true;
    } catch (err) {
      process.stderr.write(`[WARN] autoArchiveWorklog skipped: ${err.message}\n`);
      return false;
    }
  }
  return false;
}

function main() {
  const { command, target, options } = parseArgs(process.argv.slice(2));
  const root = fs.realpathSync(options.root);

  if (command === 'worklog') {
    archiveWorklog(root, target, options.keep, options.owner);
  } else if (command === 'journals') {
    if (options.execute) {
      executeJournalArchive(root, options.owner);
    } else {
      process.stdout.write(`${describeJournalPlan(planJournalArchive(root))}\n`);
    }
  } else if (command === 'status') {
    archiveStatus(root);
  }
}

if (require.main === module) {
  try {
    main();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    process.exit(1);
  }
}

module.exports = {
  archiveWorklog, archiveStatus, autoArchiveWorklog, getLineCount,
  extractEntryHash, parseArchiveEntryHashes,
  // Identification algorithm, exported read-only for the regression tests and
  // the read-only measurement script.
  splitDatedSections, normalizedEntryBody, rawEntryText, archiveHoldsRawText,
  createArchiveIndex, buildArchiveIndex, rememberArchiveEntry, identifyArchiveEntry,
  // Journal count hygiene (JOURNAL-HYGIENE).
  planJournalArchive, executeJournalArchive, describeJournalPlan,
  journalRecordHeader, journalRecordAddition, journalHeaderRegex, archiveHoldsBytes,
  journalEncodingProblem, journalSessionSignal, parseArgs,
  JOURNAL_FILE_CAP, JOURNAL_COUNT_HEADROOM, JOURNAL_RECENT_WINDOW_MS,
};

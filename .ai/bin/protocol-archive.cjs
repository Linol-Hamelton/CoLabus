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
// recovers the record's own body (MiMo class C_tail_marker_mismatch).
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
    } else if (!target && !arg.startsWith('--')) {
      target = arg;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!['worklog', 'status'].includes(command)) {
    throw new Error('Usage: protocol-archive.cjs worklog <path> [--keep <n>] [--root <dir>]\n       protocol-archive.cjs status [--root <dir>]');
  }

  if (command === 'worklog' && !target) {
    throw new Error('Usage: protocol-archive.cjs worklog <path> [--keep <n>] [--root <dir>]');
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
// killed process) and its temp files in .ai/runtime. A later run recovers both (CLEANUP-C D-05): the lock only when it is one of
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
      // here leaves the old archive or the new one, never half of an entry that every later run would refuse (CLEANUP-C D-06).
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
  // the read-only measurement script ().
  splitDatedSections, normalizedEntryBody, rawEntryText, archiveHoldsRawText,
  createArchiveIndex, buildArchiveIndex, rememberArchiveEntry, identifyArchiveEntry,
};

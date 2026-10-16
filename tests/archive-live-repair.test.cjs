'use strict';


const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { repoRoot, makeProtocolFixture, run } = require('./helpers.cjs');

const archiveModule = require('../.ai/bin/protocol-archive.cjs');
const hooks = require('../.ai/bin/protocol-hooks.cjs');

const ENTRY_NEW = '## 2026-09-17 - Newest turn\n\nAgent: tester\n\nAction: Working on new turn.\n\n' +
  'Result: Clean pass.\n\nNext step: Handoff.\n\nOpen: None.\n';

const ENTRY_A = '## 2026-09-16 - Older turn 1\n\nAgent: tester\n\nAction: First turn.\n\n' +
  'Result: Worked.\n\nNext step: Next.\n\nOpen: None.\n';

const ENTRY_B = '## 2026-09-15 - Older turn 2\n\nAgent: tester\n\nAction: Initial turn.\n\n' +
  'Result: Initialized.\n\nNext step: Next.\n\nOpen: None.\n';

const ENTRY_SAME = '## 2026-10-08 - Same heading\n\nAgent: tester\n\nAction: Checked.\n\n' +
  'Result: Passed.\n\nNext step: Review.\n\nOpen: None.';

function archiveTool(root, args) {
  return run(process.execPath, [path.join(repoRoot, '.ai/bin/protocol-archive.cjs'), ...args,
    '--root', root], root);
}

// Record one authenticated (format-2) entry into a throwaway worklog and return
// its exact recorded text (the journal prefix removed).
function recordEntry(root, owner, entry) {
  const journal = `.ai/worklog/${owner}.md`;
  const full = path.join(root, journal);
  fs.writeFileSync(full, `# Worklog: ${owner}\n\n${entry}\n`);
  const result = run(process.execPath, [
    path.join(repoRoot, '.ai/bin/protocol-handoff.cjs'), 'record',
    '--owner', owner, '--quick', '--root', root,
  ], root);
  assert.equal(result.status, 0, result.stderr);
  return fs.readFileSync(full, 'utf8').replace(/^# Worklog: [^\n]*\n\n/, '');
}

function signed(text) {
  const body = `${text}\n\nEvidence:\n- entry hash format: 2\n`;
  const hash = crypto.createHash('sha256').update(hooks.canonicalEntryBody(body)).digest('hex');
  return `${body}- entry: sha256:${hash}\n`;
}

function writeArchive(root, section) {
  fs.writeFileSync(path.join(root, '.ai', 'ARCHIVE.md'), `# Archive\n\n${section}\n`);
}

function writeJournal(root, owner, entries) {
  const journal = `.ai/worklog/${owner}.md`;
  fs.writeFileSync(path.join(root, journal), `# Worklog: ${owner}\n\n${entries.join('\n\n---\n\n')}\n`);
  return journal;
}

function readArchive(root) {
  return fs.readFileSync(path.join(root, '.ai', 'ARCHIVE.md'), 'utf8');
}

function countOccurrences(haystack, needle) {
  return haystack.split(needle).length - 1;
}

function labelOf(entry) {
  const match = entry.match(/^[ \t]*-[ \t]+entry:[ \t]*(sha256:[a-f0-9]{64})/m);
  assert.ok(match, 'expected an entry label in the fixture');
  return match[1];
}

// Run the tool and assert the fail-closed contract of a refusal: non-zero exit,
// a reason on stderr, and both files byte-identical afterwards.
function assertRefused(root, journal, reason) {
  const archiveBefore = readArchive(root);
  const journalBefore = fs.readFileSync(path.join(root, journal), 'utf8');
  const result = archiveTool(root, ['worklog', journal, '--keep', '1']);
  assert.notEqual(result.status, 0, 'the record must be refused');
  assert.match(result.stderr, reason);
  assert.equal(readArchive(root), archiveBefore, 'a refused record must not modify the archive');
  assert.equal(fs.readFileSync(path.join(root, journal), 'utf8'), journalBefore,
    'a refused record must not prune the journal');
  return result;
}

test('tail parser mismatch: a tail-glued copy already present is not appended again', t => {
  const root = makeProtocolFixture(t);
  const recorded = recordEntry(root, 'tail', ENTRY_A);
  const label = labelOf(recorded);

  // The archived copy carries the tail of a neighbouring dump glued on by the
  // historical splitter: its own label no longer matches its body.
  const tailGlued = `${recorded}\n\n<!-- archived from .ai/worklog/other.md 2026-01-01T00:00:00Z -->\n\n` +
    'Neighbour dump body that does not belong to this record.\n';
  writeArchive(root, tailGlued);
  assert.equal(archiveModule.extractEntryHash(tailGlued), null,
    'fixture must reproduce a label/body mismatch to exercise the live gap');
  assert.equal(archiveModule.parseArchiveEntryHashes(`# Archive\n\n${tailGlued}\n`).has(label), false,
    'the mismatched copy is invisible to the old label-only dedup');

  const journal = writeJournal(root, 'tail', [ENTRY_NEW, recorded]);
  const result = archiveTool(root, ['worklog', journal, '--keep', '1']);
  assert.equal(result.status, 0, result.stderr);

  assert.equal(countOccurrences(readArchive(root), label), 1,
    'the tail-mismatched copy must be recognised as present, not appended again');
});

test('exact body duplicate: an identical record is not appended again', t => {
  const root = makeProtocolFixture(t);
  const recorded = recordEntry(root, 'dup', ENTRY_A);
  const label = labelOf(recorded);
  writeArchive(root, recorded);

  const journal = writeJournal(root, 'dup', [ENTRY_NEW, recorded]);
  const result = archiveTool(root, ['worklog', journal, '--keep', '1']);
  assert.equal(result.status, 0, result.stderr);

  assert.equal(countOccurrences(readArchive(root), label), 1);
});

test('truncated copy incoming: a strict prefix of a present body is skipped, nothing is lost', t => {
  const root = makeProtocolFixture(t);
  const recorded = recordEntry(root, 'trunc-in', ENTRY_A);
  writeArchive(root, recorded);
  const archiveBefore = readArchive(root);

  // The journal holds a truncated copy of the record the archive already holds
  // in full: every byte of the copy is present, so pruning it loses nothing.
  const cut = recorded.indexOf('\nNext step:');
  assert.ok(cut > 64, 'expected a reasonably long prefix body');
  const truncated = recorded.slice(0, cut);
  assert.ok(hooks.canonicalEntryBody(truncated).length >= 64, 'prefix body must pass the length gate');

  const journal = writeJournal(root, 'trunc-in', [ENTRY_NEW, truncated]);
  const result = archiveTool(root, ['worklog', journal, '--keep', '1']);
  assert.equal(result.status, 0, result.stderr);

  assert.equal(readArchive(root), archiveBefore, 'a skipped truncated copy must not be appended');
  assert.equal(countOccurrences(readArchive(root), labelOf(recorded)), 1);
  assert.equal(countOccurrences(fs.readFileSync(path.join(root, journal), 'utf8'), '## 2026-09-16 - Older turn 1'), 0,
    'the truncated copy is pruned from the journal because the archive holds its whole text');
});

test('truncated copy present: a record extending a present body is refused, not pruned', t => {
  const root = makeProtocolFixture(t);
  const recorded = recordEntry(root, 'trunc', ENTRY_A);

  // The archive holds only a truncated copy. A startsWith relation does not
  // prove that copy is a truncation of this record, and the tail exists only in
  // the journal: skipping would lose text, so the record is refused.
  const cut = recorded.indexOf('\nNext step:');
  assert.ok(cut > 64, 'expected a reasonably long prefix body');
  writeArchive(root, recorded.slice(0, cut));

  const journal = writeJournal(root, 'trunc', [ENTRY_NEW, recorded]);
  assertRefused(root, journal, /strictly extends a present entry body/i);
  assert.equal(countOccurrences(fs.readFileSync(path.join(root, journal), 'utf8'), 'Next step: Next.'), 1,
    'the tail that exists only in the journal must still be there');
});

test('prefix: a legacy record extending a present legacy body is refused with both files byte-identical', t => {
  const root = makeProtocolFixture(t);
  writeArchive(root, ENTRY_SAME);
  const journal = writeJournal(root, 'prefix', [ENTRY_NEW, `${ENTRY_SAME}\n\nNEW UNIQUE DETAIL`]);
  assertRefused(root, journal, /strictly extends a present entry body/i);
  assert.equal(readArchive(root).includes('NEW UNIQUE DETAIL'), false);
  assert.equal(fs.readFileSync(path.join(root, journal), 'utf8').includes('NEW UNIQUE DETAIL'), true,
    'the unique tail must survive in the journal');
});

test('batch: two identical authenticated copies in one run are appended exactly once', t => {
  const root = makeProtocolFixture(t);
  writeArchive(root, '# Archive\n\n(nothing archived yet)\n');
  const copy = signed(ENTRY_SAME);
  const label = labelOf(copy);

  const journal = writeJournal(root, 'batch', [ENTRY_NEW, copy, copy]);
  const result = archiveTool(root, ['worklog', journal, '--keep', '1']);
  assert.equal(result.status, 0, result.stderr);

  const archiveAfter = readArchive(root);
  assert.equal(countOccurrences(archiveAfter, label), 1, 'the record must be appended exactly once');
  assert.equal(countOccurrences(archiveAfter, '## 2026-10-08 - Same heading'), 1);
  const journalAfter = fs.readFileSync(path.join(root, journal), 'utf8');
  assert.equal(countOccurrences(journalAfter, '## 2026-10-08 - Same heading'), 0,
    'both copies are pruned because the archive now holds the record');
  assert.equal(countOccurrences(journalAfter, '## 2026-09-17 - Newest turn'), 1);
});

test('heading: records differing after an inner "## Details" heading are both kept', t => {
  const root = makeProtocolFixture(t);
  const present = signed(`${ENTRY_SAME}\n\n## Details\nOld detail.`);
  const incoming = signed(`${ENTRY_SAME}\n\n## Details\nNEW UNIQUE DETAIL`);
  writeArchive(root, present);

  // The journal splitter delimits records by dated headings only; the archive
  // index must do the same, or the two records share one truncated prefix.
  assert.equal(archiveModule.splitDatedSections(`# Archive\n\n${present}\n`).length, 1,
    'an inner "## Details" heading must not start a new archive record');

  const journal = writeJournal(root, 'heading', [ENTRY_NEW, incoming]);
  const result = archiveTool(root, ['worklog', journal, '--keep', '1']);
  assert.equal(result.status, 0, result.stderr);

  const archiveAfter = readArchive(root);
  assert.equal(countOccurrences(archiveAfter, labelOf(present)), 1);
  assert.equal(countOccurrences(archiveAfter, labelOf(incoming)), 1, 'the new record must be appended once');
  assert.equal(countOccurrences(archiveAfter, 'Old detail.'), 1);
  assert.equal(countOccurrences(archiveAfter, 'NEW UNIQUE DETAIL'), 1, 'the new text must reach the archive');
  assert.equal(fs.readFileSync(path.join(root, journal), 'utf8').includes('NEW UNIQUE DETAIL'), false,
    'the record is pruned only after its text is in the archive');
});

test('malformed: a record with no label and not the five entry labels is refused, not appended', t => {
  const root = makeProtocolFixture(t);
  writeArchive(root, '# Archive\n\n(nothing archived yet)\n');
  const journal = writeJournal(root, 'malformed', [ENTRY_NEW, '## 2026-10-08 - Same heading\n\nNEW UNIQUE DETAIL']);
  assertRefused(root, journal, /malformed record.*lacks the entry label\(s\) Agent, Action, Result, Next step, Open/i);
  assert.equal(readArchive(root).includes('NEW UNIQUE DETAIL'), false);
  assert.equal(fs.readFileSync(path.join(root, journal), 'utf8').includes('NEW UNIQUE DETAIL'), true);
});

test('malformed: a record missing one of the five labels names the missing label in the reason', t => {
  const root = makeProtocolFixture(t);
  writeArchive(root, '# Archive\n\n(nothing archived yet)\n');
  const missingOpen = ENTRY_SAME.replace('\n\nOpen: None.', '');
  const journal = writeJournal(root, 'missing', [ENTRY_NEW, missingOpen]);
  assertRefused(root, journal, /lacks the entry label\(s\) Open;/);
});

test('stale label with same body: a different label on an identical body is neither appended nor pruned (round 3: refused)', t => {
  const root = makeProtocolFixture(t);
  const recorded = recordEntry(root, 'stale', ENTRY_A);

  // Two copies with byte-identical bodies but labels that do not authenticate
  // them (the historical stale-label form). Normalisation finds the present
  // copy (same canonical body), but the incoming label line is a raw line the
  // archive does not hold, so round 3 refuses instead of skipping: nothing is
  // appended and nothing is pruned.
  const staleArchived = recorded.replace(/(- entry:[ \t]*)(sha256:[a-f0-9]{64})/, `$1sha256:${'0'.repeat(64)}`);
  const staleCandidate = recorded.replace(/(- entry:[ \t]*)(sha256:[a-f0-9]{64})/, `$1sha256:${'1'.repeat(64)}`);
  assert.equal(archiveModule.extractEntryHash(staleArchived), null);
  assert.equal(archiveModule.normalizedEntryBody(staleArchived), archiveModule.normalizedEntryBody(staleCandidate),
    'fixture must normalise both copies to one identity');
  writeArchive(root, staleArchived);

  const journal = writeJournal(root, 'stale', [ENTRY_NEW, staleCandidate]);
  assertRefused(root, journal, /raw text is not held line for line/i);

  const archiveAfter = readArchive(root);
  assert.equal(countOccurrences(archiveAfter, '1'.repeat(64)), 0,
    'the stale-label copy with the same body must not be appended');
  assert.equal(countOccurrences(archiveAfter, '0'.repeat(64)), 1);
  assert.equal(countOccurrences(fs.readFileSync(path.join(root, journal), 'utf8'), '1'.repeat(64)), 1,
    'the incoming label line exists only in the journal and must stay there');
});

test('embedded label: a record carrying two entry labels is refused, not appended', t => {
  const root = makeProtocolFixture(t);
  const recorded = recordEntry(root, 'embed', ENTRY_A);
  const embedded = recorded.replace('Open: None.', `Open: None.\n- entry: sha256:${'a'.repeat(64)}`);
  assert.equal((embedded.match(/^[ \t]*-[ \t]+entry:/gm) || []).length, 2);

  writeArchive(root, recordEntry(root, 'embed-existing', ENTRY_B));
  const journal = writeJournal(root, 'embed', [ENTRY_NEW, embedded]);
  assertRefused(root, journal, /ambiguous/i);
});

test('malformed mismatch: an unauthenticated record with no present copy is refused', t => {
  const root = makeProtocolFixture(t);
  const recorded = recordEntry(root, 'mismatch', ENTRY_A);
  // A record whose own label does not match its body and which has no present
  // copy must be refused rather than silently appended (the live gap).
  const mismatched = recorded.replace(/(- entry:[ \t]*)(sha256:[a-f0-9]{64})/, `$1sha256:${'f'.repeat(64)}`);
  assert.equal(archiveModule.extractEntryHash(mismatched), null);
  writeArchive(root, '# Archive\n\n(no dated sections yet)\n');

  const journal = writeJournal(root, 'mismatch', [ENTRY_NEW, mismatched]);
  assertRefused(root, journal, /label does not match its body/i);
});

test('legitimate new entry: a genuinely new record is still appended', t => {
  const root = makeProtocolFixture(t);
  const existing = recordEntry(root, 'keep', ENTRY_A);
  writeArchive(root, existing);

  const fresh = recordEntry(root, 'fresh', ENTRY_B);
  const freshLabel = labelOf(fresh);
  const journal = writeJournal(root, 'keep', [ENTRY_NEW, fresh]);
  const result = archiveTool(root, ['worklog', journal, '--keep', '1']);
  assert.equal(result.status, 0, result.stderr);

  assert.equal(countOccurrences(readArchive(root), freshLabel), 1,
    'a genuinely new entry must still be appended exactly once');
});

test('two distinct full entries with the same heading are both appended', t => {
  const root = makeProtocolFixture(t);
  writeArchive(root, ENTRY_SAME);
  const other = ENTRY_SAME.replace('Result: Passed.', 'Result: Failed on the second probe.');
  assert.notEqual(other, ENTRY_SAME);

  const journal = writeJournal(root, 'distinct', [ENTRY_NEW, other]);
  const result = archiveTool(root, ['worklog', journal, '--keep', '1']);
  assert.equal(result.status, 0, result.stderr);

  const archiveAfter = readArchive(root);
  assert.equal(countOccurrences(archiveAfter, '## 2026-10-08 - Same heading'), 2,
    'a different full record under the same heading is a new record');
  assert.equal(countOccurrences(archiveAfter, 'Result: Passed.'), 1);
  assert.equal(countOccurrences(archiveAfter, 'Result: Failed on the second probe.'), 1);
});

test('legacy five-label entry without Evidence is appended once and stays idempotent', t => {
  const root = makeProtocolFixture(t);
  writeArchive(root, '# Archive\n\n(nothing archived yet)\n');

  const journal = writeJournal(root, 'legacy', [ENTRY_NEW, ENTRY_SAME]);
  assert.equal(archiveTool(root, ['worklog', journal, '--keep', '1']).status, 0);
  assert.equal(countOccurrences(readArchive(root), '## 2026-10-08 - Same heading'), 1);

  // Second pass with the same journal content restored: no second copy.
  writeJournal(root, 'legacy', [ENTRY_NEW, ENTRY_SAME]);
  assert.equal(archiveTool(root, ['worklog', journal, '--keep', '1']).status, 0);
  assert.equal(countOccurrences(readArchive(root), '## 2026-10-08 - Same heading'), 1,
    'a legacy entry without Evidence is appended exactly once');
});


const MARKER = '<!-- archived from .ai/worklog/x.md 2026-01-01T00:00:00Z -->';
const TAIL = 'UNIQUE TAIL ONLY IN THE JOURNAL';

// Run the real production auto-archive path (protocol-handoff record and
// protocol-session stop call it) in-process and assert the fail-closed
// contract: nothing archived, both files byte-identical, the tail still in the
// journal and never anywhere else.
function assertAutoArchiveRefusedKeepingTail(root, journal, tail) {
  const archiveBefore = readArchive(root);
  const journalBefore = fs.readFileSync(path.join(root, journal), 'utf8');
  assert.ok(journalBefore.includes(tail), 'fixture must put the tail in the journal');
  assert.equal(archiveBefore.includes(tail), false, 'fixture must keep the tail out of the archive');

  const stderrWrite = process.stderr.write;
  let warning = '';
  process.stderr.write = chunk => { warning += String(chunk); return true; };
  let archived;
  try {
    archived = archiveModule.autoArchiveWorklog(root, journal, 0, 1, null);
  } finally {
    process.stderr.write = stderrWrite;
  }
  assert.equal(archived, false, 'the run must be refused, never a skip-and-prune');
  assert.match(warning, /raw text is not held line for line/i);
  assert.equal(readArchive(root), archiveBefore, 'a refused record must not modify the archive');
  assert.equal(fs.readFileSync(path.join(root, journal), 'utf8'), journalBefore,
    'a refused record must not prune the journal');
  const journalAfter = fs.readFileSync(path.join(root, journal), 'utf8');
  const archiveAfter = readArchive(root);
  assert.equal(journalAfter.includes(tail) || archiveAfter.includes(tail), true, 'text must never be lost');
  assert.equal(journalAfter.includes(tail), true, 'the tail exists only in the journal and must stay there');
}

test('An incoming record whose marker tail is stripped by normalisation is refused through autoArchiveWorklog, no text lost', t => {
  const root = makeProtocolFixture(t);
  // The sealed reproduction (ARCH-FIX3-INPUT-mimo-fail.md), fixture for fixture:
  // the archive holds the signed base record plus an inner "## Details"
  // heading; the journal holds the same record followed by a provenance
  // marker and a unique tail. stripNeighbourDumpTail cut the incoming at the
  // marker, its body equalled the present body, and round 2 skipped and pruned
  // it: the tail vanished from both files.
  const present = `${signed(ENTRY_SAME)}\n\n## Details\n`;
  writeArchive(root, present);
  const incoming = `${signed(ENTRY_SAME)}\n\n## Details\n${MARKER}\n\n${TAIL}\n`;
  assert.equal(archiveModule.normalizedEntryBody(incoming), archiveModule.normalizedEntryBody(present),
    'fixture must reproduce the normalised equality that caused the loss');
  const journal = writeJournal(root, 'r', [ENTRY_NEW, incoming]);
  assertAutoArchiveRefusedKeepingTail(root, journal, TAIL);
});

test('archiveHoldsRawText: contiguous, line-aligned containment after CRLF->LF only', () => {
  const held = archiveModule.archiveHoldsRawText;
  assert.equal(held('a\nb\nc', 'a\nb\nc'), true, 'identical');
  assert.equal(held('a\r\nb\r\nc', 'a\nb\nc'), true, 'CRLF incoming against LF present');
  assert.equal(held('a\nb', 'a\nb\nc'), true, 'line-aligned prefix');
  assert.equal(held('b\nc', 'a\nb\nc'), true, 'line-aligned suffix');
  assert.equal(held('a\nb\n\n', 'a\nb\nc'), true, 'trailing whitespace of the incoming is not a line');
  assert.equal(held('a\nb\nc\nd', 'a\nb\nc'), false, 'an extra incoming line is not held');
  assert.equal(held('a\nbc', 'a\nbcd'), false, 'a partial last line is not held');
  assert.equal(held('b\nc', 'ab\nc'), false, 'a partial first line is not held');
  assert.equal(held('a\nc', 'a\nb\nc'), false, 'lines must be contiguous');
  assert.equal(held('b\na', 'a\nb'), false, 'lines must be in order');
  assert.equal(held('a \nb', 'a\nb'), false, 'inner trailing whitespace is a raw difference');
  assert.equal(held('', 'a'), false, 'an empty incoming text is never held');
  assert.equal(held('é', 'é'), false, 'no Unicode normalisation is applied');
});

test('skip path "label present": an extra trailing line that canonicalisation drops is refused, not pruned', t => {
  const root = makeProtocolFixture(t);
  const recorded = recordEntry(root, 'label-raw', ENTRY_A);
  writeArchive(root, recorded);
  // canonicalEntryBody drops a trailing "### From ..." line, so the incoming
  // still authenticates under the same label as the present copy; the raw
  // incoming holds one more line than the archive does.
  const trailing = '### From the owner: KEEP THIS LINE';
  const incoming = `${recorded.trimEnd()}\n\n${trailing}`;
  assert.equal(archiveModule.extractEntryHash(incoming), labelOf(recorded),
    'fixture must authenticate under the present label');
  const journal = writeJournal(root, 'label-raw', [ENTRY_NEW, incoming]);
  assertRefused(root, journal, /entry sha256:[a-f0-9]{64} is already present.*raw text is not held line for line/is);
  assert.equal(fs.readFileSync(path.join(root, journal), 'utf8').includes(trailing), true);
  assert.equal(readArchive(root).includes(trailing), false);
});

test('skip path "label present": the same authenticated record with CRLF line endings is skipped, nothing lost', t => {
  const root = makeProtocolFixture(t);
  const recorded = recordEntry(root, 'label-crlf', ENTRY_A);
  const label = labelOf(recorded);
  writeArchive(root, recorded);
  const crlf = recorded.replace(/\n/g, '\r\n');
  const journal = `.ai/worklog/label-crlf.md`;
  fs.writeFileSync(path.join(root, journal), `# Worklog: label-crlf\r\n\r\n${ENTRY_NEW.replace(/\n/g, '\r\n')}\r\n\r\n---\r\n\r\n${crlf}`);
  const archiveBefore = readArchive(root);
  const result = archiveTool(root, ['worklog', journal, '--keep', '1']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readArchive(root), archiveBefore, 'held line for line after CRLF->LF: skipped, not appended');
  assert.equal(countOccurrences(readArchive(root), label), 1);
});

test('skip path "identical normalized body": a tail-glued incoming copy of a clean present record is refused (reverse of the tail test)', t => {
  const root = makeProtocolFixture(t);
  const recorded = recordEntry(root, 'tail-rev', ENTRY_A);
  writeArchive(root, recorded);
  // The glued tail is cut by stripNeighbourDumpTail on the incoming side, so
  // the normalised bodies are equal; the raw incoming holds the tail.
  const incoming = `${recorded}\n\n${MARKER}\n\n${TAIL}\n`;
  assert.equal(archiveModule.normalizedEntryBody(incoming), archiveModule.normalizedEntryBody(recorded));
  const journal = writeJournal(root, 'tail-rev', [ENTRY_NEW, incoming]);
  assertRefused(root, journal, /identical normalized entry body.*raw text is not held line for line/is);
  assert.equal(fs.readFileSync(path.join(root, journal), 'utf8').includes(TAIL), true);
});

// A format-2 record whose "- entry:" line sits inside the text (text after it
// is part of the canonical body). The placeholder is replaced by the label
// that authenticates the canonical body; canonicalEntryBody removes the label
// line whatever it holds, so the two-pass construction is exact.
function signedInline(textWithPlaceholder) {
  assert.ok(textWithPlaceholder.includes('- entry: PLACEHOLDER'));
  const hash = crypto.createHash('sha256').update(hooks.canonicalEntryBody(textWithPlaceholder)).digest('hex');
  return textWithPlaceholder.replace('- entry: PLACEHOLDER', `- entry: sha256:${hash}`);
}

test('skip path "truncated copy": a prefix body whose raw text carries a stripped tail is refused', t => {
  const root = makeProtocolFixture(t);
  const head = `${ENTRY_SAME}\n\nEvidence:\n- entry hash format: 2\n- entry: PLACEHOLDER\n## Details\nOld detail line one.`;
  const present = signedInline(`${head}\nOld detail line two.`);
  writeArchive(root, present);
  // The marker tail is stripped after the incoming's own "- entry:" line, so
  // its normalised body is a strict prefix of the present body while its raw
  // text holds the marker and the tail.
  const incoming = signedInline(`${head}\n${MARKER}\n\n${TAIL}`);
  const body = archiveModule.normalizedEntryBody(incoming);
  const presentBody = archiveModule.normalizedEntryBody(present);
  assert.ok(body.length >= 64 && body.length < presentBody.length && presentBody.startsWith(body),
    'fixture must be a strict normalised prefix of the present body');
  const journal = writeJournal(root, 'trunc-raw', [ENTRY_NEW, incoming]);
  assertRefused(root, journal, /strict prefix \(truncated copy\).*raw text is not held line for line/is);
  assert.equal(fs.readFileSync(path.join(root, journal), 'utf8').includes(TAIL), true);
  assert.equal(readArchive(root).includes(TAIL), false);
});

test('skip path "truncated copy": a copy cut in the middle of a line is refused, a line-aligned cut is skipped', t => {
  const root = makeProtocolFixture(t);
  const recorded = recordEntry(root, 'trunc-line', ENTRY_A);
  writeArchive(root, recorded);
  const archiveBefore = readArchive(root);

  // Cut inside "Result: Worked." so the last incoming line is a partial line.
  const midLine = recorded.indexOf('Result: Worked.') + 'Result: Wor'.length;
  const partial = recorded.slice(0, midLine);
  assert.ok(archiveModule.normalizedEntryBody(partial).length >= 64);
  const journal = writeJournal(root, 'trunc-line', [ENTRY_NEW, partial]);
  assertRefused(root, journal, /strict prefix \(truncated copy\).*raw text is not held line for line/is);

  // The same record cut at a line end: every line is held, so it is skipped.
  const lineEnd = recorded.indexOf('\n', midLine);
  writeJournal(root, 'trunc-line', [ENTRY_NEW, recorded.slice(0, lineEnd)]);
  const result = archiveTool(root, ['worklog', journal, '--keep', '1']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readArchive(root), archiveBefore);
  assert.equal(fs.readFileSync(path.join(root, journal), 'utf8').includes('## 2026-09-16 - Older turn 1'), false,
    'pruned only because the archive holds every line');
});

test('skip path "in-run batch": a later copy that extends an accepted record past a marker is refused, whole run atomic', t => {
  const root = makeProtocolFixture(t);
  writeArchive(root, '# Archive\n\n(nothing archived yet)\n');
  const copy = signed(ENTRY_SAME);
  const longer = `${copy}\n\n${MARKER}\n\n${TAIL}\n`;
  assert.equal(archiveModule.normalizedEntryBody(longer), archiveModule.normalizedEntryBody(copy));
  const journal = writeJournal(root, 'batch-raw', [ENTRY_NEW, copy, longer]);
  assertRefused(root, journal, /raw text is not held line for line/i);
  assert.equal(readArchive(root).includes('## 2026-10-08 - Same heading'), false,
    'the accepted first copy is not written either: the run is atomic');
  assert.equal(fs.readFileSync(path.join(root, journal), 'utf8').includes(TAIL), true);
});

test('identifyArchiveEntry: every skip is grounded in raw containment, every normalised look-alike without it refuses', () => {
  const present = signed(ENTRY_SAME);
  const index = archiveModule.createArchiveIndex();
  archiveModule.rememberArchiveEntry(index, archiveModule.extractEntryHash(present),
    archiveModule.normalizedEntryBody(present), present);
  assert.equal(index.records[0].raw, present.replace(/\r\n/g, '\n'), 'the index keeps the raw text');

  const exact = archiveModule.identifyArchiveEntry(present, index);
  assert.equal(exact.action, 'skip');
  assert.match(exact.reason, /holds every line of this record's raw text/);

  const glued = `${present}\n\n${MARKER}\n\n${TAIL}`;
  assert.equal(archiveModule.normalizedEntryBody(glued), archiveModule.normalizedEntryBody(present));
  assert.throws(() => archiveModule.identifyArchiveEntry(glued, index), /raw text is not held line for line/);

  const trailingLine = `${present.trimEnd()}\n\n### From the owner: KEEP THIS LINE`;
  assert.equal(archiveModule.extractEntryHash(trailingLine), archiveModule.extractEntryHash(present),
    'a trailing line canonicalisation drops still authenticates under the same label');
  assert.throws(() => archiveModule.identifyArchiveEntry(trailingLine, index), /raw text is not held line for line/);

  const prefix = present.slice(0, present.indexOf('\nNext step:'));
  assert.equal(archiveModule.identifyArchiveEntry(prefix, index).action, 'skip', 'a line-aligned prefix is held');
  assert.throws(() => archiveModule.identifyArchiveEntry(`${prefix}\nNext st`, index),
    /raw text is not held line for line/, 'a partial last line is not held');

  const fresh = signed(ENTRY_SAME.replace('Result: Passed.', 'Result: Different.'));
  assert.equal(archiveModule.identifyArchiveEntry(fresh, index).action, 'append');
});

test('re-archiving the same journal twice stays idempotent for format-2 entries', t => {
  const root = makeProtocolFixture(t);
  const recorded = recordEntry(root, 'idem', ENTRY_A);
  const label = labelOf(recorded);
  writeArchive(root, '# Archive\n\n(nothing archived yet)\n');

  const journal = writeJournal(root, 'idem', [ENTRY_NEW, recorded]);
  assert.equal(archiveTool(root, ['worklog', journal, '--keep', '1']).status, 0);
  // Second pass with the same (already pruned) journal content restored.
  fs.writeFileSync(path.join(root, journal), `# Worklog: idem\n\n${ENTRY_NEW}\n\n---\n\n${recorded}\n`);
  assert.equal(archiveTool(root, ['worklog', journal, '--keep', '1']).status, 0);

  assert.equal(countOccurrences(readArchive(root), label), 1);
});

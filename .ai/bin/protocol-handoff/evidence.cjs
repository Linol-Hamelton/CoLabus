'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const entryText = require('../lib/entry-text.cjs');
const { realInside } = require('../lib/path-safe.cjs');
const realPath = require('../lib/real-path.cjs');

// The owner names that every handoff writer stamps (a session owner of the
// form {agent}-{session} is one): the name of a journal file in .ai/worklog.
const OWNER_NAME = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;

// Cheap, local ownership gate shared by every handoff writer. Check before
// auto-archive or checks as well as at publication: a refusal has no writes.
function assertJournalOwner(journalPath, owner, root = path.resolve(path.dirname(journalPath), '..', '..')) {
  const refuse = () => { throw new Error(`HANDOFF-JOURNAL-OWNER: refused journal ${JSON.stringify(journalPath)}`); };
  const validOwner = typeof owner === 'string' && OWNER_NAME.test(owner);
  if (!validOwner || path.basename(journalPath) !== `${owner}.md`) refuse();
  if (path.relative(root, path.dirname(journalPath)) !== path.join('.ai', 'worklog')) refuse();
  // A matching basename must not alias another journal through a link.
  const guarded = realInside(root, journalPath, { refuseHardlinks: true });
  if (!guarded.ok || !guarded.exists || guarded.type !== 'file') refuse();
  // The input spelling can alias a differently cased filename on NTFS/macOS.
  // Resolve both identities and require the owner's exact name stored on disk.
  let ownerReal;
  try { ownerReal = realPath.realPathSync(path.join(root, '.ai', 'worklog', `${owner}.md`)); }
  catch { refuse(); }
  if (guarded.real !== ownerReal || path.basename(guarded.real) !== `${owner}.md`) refuse();
}

function renderEvidence(state, checks, owner, entryDigest, quick, parentEntry = 'root') {
  const hasCustom = checks.some(c => c.isCustom);
  let scopeLine;
  if (quick) {
    scopeLine = '- scope: validator only; the regression suite was NOT run; host-project tests run separately';
  } else if (hasCustom) {
    scopeLine = '- scope: protocol checks and host-project tests';
  } else {
    scopeLine = '- scope: protocol checks only; host-project tests run separately';
  }
  const lines = [
    'Evidence:',
    `- anchor: ${state.commit || 'no commits'}${state.dirty ? ', uncommitted changes present' : ', clean tree'}`,
    `- digest: ${state.digest} over ${state.fileCount} tracked and untracked files`,
    `- digest format: ${state.format}`,
    `- recorded: ${new Date().toISOString()} by ${owner}`,
    '- entry hash format: 2',
    `- entry: ${entryDigest} of this entry without this block`,
    `- parent-entry: ${parentEntry}`,
    scopeLine,
  ];
  for (const check of checks) {
    lines.push(`- ${check.name}: exit ${check.code} in ${check.seconds}s`);
  }
  lines.push('- reproduce: node .ai/bin/protocol-handoff.cjs verify');
  return lines.join('\n');
}

// Every reading and every rewrite of entry text goes through the one entry text model (lib/entry-text.cjs): sections,
// labels, the Evidence block, the entry hash line and From frames are read only from text outside fenced blocks.
const {
  DATE_HEADING_REGEX, DATE_HEADING_M_REGEX, ENTRY_HASH_FORMAT, hasEntryHashFormat2, canonicalEntryBody, entryDigest,
  newestSection, datedSections, splitEntryTail, recordedEntryHash, evidenceField, parseEvidenceBlock,
  withoutTrailer, formatWithEvidence, findArchivedParent,
} = entryText;

function findParentEntry(journalPath) {
  const text = fs.readFileSync(journalPath, 'utf8');
  const found = newestSection(text);
  if (!found) return 'root';
  const olderSections = found.sections.slice(found.index + 1);
  for (const section of olderSections) {
    if (DATE_HEADING_REGEX.test(section)) {
      const recorded = recordedEntryHash(section);
      if (recorded) {
        if (entryDigest(section) !== recorded) {
          return 'tampered';
        }
        return recorded;
      }
      const ev = parseEvidenceBlock(section);
      if (ev && ev.format >= 4) {
        return 'tampered';
      }
      return 'legacy';
    }
  }
  const archived = findArchivedParent(text);
  if (archived) return archived;
  return 'root';
}

function archiveEntryRecords(text) {
  return datedSections(text).flatMap(section => {
    const recorded = recordedEntryHash(section);
    if (!recorded) return [];
    const actualHash = entryDigest(section);
    const evidence = evidenceField(withoutTrailer(section));
    const parsed = parseEvidenceBlock(evidence);
    const authenticated = hasEntryHashFormat2(section);
    return [{
      hash: recorded,
      actualHash,
      valid: actualHash === recorded,
      hasEvidence: Boolean(parsed && parsed.body),
      parentEntry: parsed ? parsed.parentEntry : null,
      chainRoot: parsed ? parsed.chainRoot : null,
      format: (parsed && parsed.formatStated) ? parsed.format : null,
      authenticated,
    }];
  });
}


function attach(journalPath, block, owner) {
  assertJournalOwner(journalPath, owner);
  // The read, the proof and the one write hold the journal lock, and the write is compared with the bytes read.
  const journalTool = require('../protocol-journal.cjs');
  const root = path.resolve(path.dirname(journalPath), '..', '..');
  journalTool.withJournalLock(root, journalPath, () => {
    const bytes = fs.readFileSync(journalPath);
    const text = bytes.toString('utf8');
    const updated = formatWithEvidence(text, block);
    if (updated === null) throw new Error(`No dated entry in ${journalPath} outside a quote, or its newest entry opens a fence or an HTML comment it never closes. Write (or close) the entry first, then record evidence.`);
    // The block sets the hash its own entry line carries (none when it has no such line).
    const hash = parseEvidenceBlock(block) ? parseEvidenceBlock(block).entry : null;
    const proof = entryText.checkJournalWrite(text, updated, { kind: 'entry', hash });
    if (!proof.ok) throw new Error(entryText.refusalMessage(proof, journalPath));
    const r = journalTool.writeCompared(root, journalPath, Buffer.from(updated), bytes, journalPath);
    if (!r.ok) throw new Error(`journal publication refused (${r.reason})`);
  });
}

// The digest deliberately excludes .ai/worklog, or writing the Evidence block
// would invalidate the evidence the moment it was written. The consequence was
// that the one artifact the protocol calls a record could be rewritten after
// certification and verify would still pass. Three reviewers found it.
//
// The entry hash closes the loop without reintroducing the cycle: it covers the
// entry body with its own Evidence block removed. See DEC-0021.
function entryBody(journalPath) {
  const text = fs.readFileSync(journalPath, 'utf8');
  const found = newestSection(text);
  if (!found) return null;
  return canonicalEntryBody(found.sections[found.index]);
}

function entryHash(journalPath) {
  const body = entryBody(journalPath);
  if (body === null) return null;
  return `sha256:${crypto.createHash('sha256').update(body, 'utf8').digest('hex')}`;
}

function readEvidence(journalPath) {
  const text = fs.readFileSync(journalPath, 'utf8');
  const found = newestSection(text);
  if (!found) return null;
  const body = evidenceField(splitEntryTail(found.sections[found.index]).head);
  return parseEvidenceBlock(body);
}

module.exports = {
  attach,
  assertJournalOwner,
  OWNER_NAME,
  formatWithEvidence,
  readEvidence,
  renderEvidence,
  entryBody,
  entryHash,
  findParentEntry,
  archiveEntryRecords,
  parseEvidenceBlock,
  evidenceField,
  DATE_HEADING_REGEX,
  DATE_HEADING_M_REGEX,
  ENTRY_HASH_FORMAT,
  hasEntryHashFormat2,
  canonicalEntryBody,
  findArchivedParent,
  newestSection
};

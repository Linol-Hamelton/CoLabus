'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
// Entry text is read only through the one entry text model: fenced text is entry data.
const entryText = require('../lib/entry-text.cjs');
const { canonicalEntryBody, datedSections, entryLines, withoutSeparator } = entryText;
const { findParentEntry, parseEvidenceBlock, archiveEntryRecords, findArchivedParent, evidenceField } = require('./evidence.cjs');
const { anchor } = require('./snapshot.cjs');
const { realInside } = require('../lib/path-safe.cjs');

// Verification scope note: verifyArchivedChain detects chain truncation, orphaned segments,
// duplicate copies, and hash tampering/cycles within .ai/ARCHIVE.md along the chain reached
// from archivedParent. Complete replacement or wholesale deletion of archive segments remains
// outside the threat model, consistent with DEC-0016.
function verifyArchivedChain(root, archivedParent) {
  if (!archivedParent) return { ok: true };

  const archivePath = path.join(root, '.ai', 'ARCHIVE.md');
  if (!fs.existsSync(archivePath)) {
    return { ok: false, reason: `archived parent ${archivedParent} specified, but .ai/ARCHIVE.md does not exist.` };
  }
  const archiveText = fs.readFileSync(archivePath, 'utf8').replace(/\r\n/g, '\n');
  const entryLabelCounts = new Map();
  for (const { hash } of entryLines(archiveText)) {
    if (hash) entryLabelCounts.set(hash, (entryLabelCounts.get(hash) || 0) + 1);
  }
  for (const [hash, count] of entryLabelCounts) {
    if (count > 1) return { ok: false, reason: `archive contains duplicate copies of ${hash}.` };
  }

  const records = archiveEntryRecords(archiveText);
  const byHash = new Map();
  for (const record of records) {
    const matches = byHash.get(record.hash) || [];
    matches.push(record);
    byHash.set(record.hash, matches);
  }
  for (const [hash, matches] of byHash) {
    if (matches.length > 1) {
      return { ok: false, reason: `archive contains duplicate copies of ${hash}.` };
    }
  }

  const transitionalRecords = records.filter(r => r.chainRoot === 'transitional');
  if (transitionalRecords.length > 1) {
    return { ok: false, reason: 'archive contains multiple transitional root markers; history may have been truncated.' };
  }

  // Helper to determine if a record is a valid terminal root:
  // Must have recognized Evidence; missing Evidence cannot be trusted as a terminal.
  const isTerminal = r => (
    r.hasEvidence && (
      (r.format !== null && r.format < 4) ||
      r.parentEntry === 'root' ||
      r.parentEntry === 'legacy' ||
      r.chainRoot === 'transitional'
    )
  );

  const visited = new Set();
  const reachedChain = [];
  let current = archivedParent;
  let reachedTerminal = null;

  while (current && current !== 'root' && current !== 'legacy') {
    if (visited.has(current)) {
      return { ok: false, reason: `archived parent chain contains a cycle at ${current}.` };
    }
    visited.add(current);
    const matches = byHash.get(current) || [];
    if (!matches.length) {
      return { ok: false, reason: `archived parent ${current} is missing from .ai/ARCHIVE.md.` };
    }
    const record = matches[0];
    reachedChain.push(record);
    if (!record.hasEvidence) {
      return { ok: false, reason: `archived parent ${current} lacks recognized Evidence in .ai/ARCHIVE.md.` };
    }
    if (!record.valid) {
      return { ok: false, reason: `archived parent ${current} was tampered in .ai/ARCHIVE.md (hash mismatch: expected ${current}, computed ${record.actualHash}).` };
    }
    if (isTerminal(record)) {
      reachedTerminal = record;
      break;
    }
    if (!record.parentEntry) {
      return { ok: false, reason: 'archive contains an orphaned segment; history may have been truncated.' };
    }
    current = record.parentEntry;
  }

  if (!reachedTerminal) {
    return { ok: false, reason: `archive chain from ${archivedParent} did not terminate at a valid root.` };
  }

  // Transitional root marker uniqueness in this chain
  const transitionalInChain = reachedChain.filter(r => r.chainRoot === 'transitional');
  if (transitionalInChain.length > 1) {
    return { ok: false, reason: 'archive contains multiple transitional root markers; history may have been truncated.' };
  }
  if (transitionalInChain.length === 1 && reachedTerminal !== transitionalInChain[0]) {
    return { ok: false, reason: 'archive contains multiple transitional root markers; history may have been truncated.' };
  }

  // Per-chain orphan rule: any record outside the reached set whose parent-entry points into it is an orphaned segment
  for (const r of records) {
    if (!visited.has(r.hash)) {
      if (r.parentEntry && visited.has(r.parentEntry)) {
        return { ok: false, reason: 'archive contains an orphaned segment; history may have been truncated.' };
      }
    }
  }

  return { ok: true };
}

// The chain of one journal, read from its text by the entry text model (the check every journal writer proves on its
// result before it writes), plus the archive chain under --deep.
function verifyJournalChain(root, journalPath, deep = false) {
  const normalized = fs.readFileSync(journalPath, 'utf8').replace(/\r\n/g, '\n');
  const own = entryText.journalChain(normalized);
  if (!own.ok) return own;
  if (deep) {
    const archiveCheck = verifyArchivedChain(root, findArchivedParent(normalized));
    if (!archiveCheck.ok) return archiveCheck;
  }
  return { ok: true };
}

function resolveJournal(root, explicit, owner) {
  if (explicit) return path.resolve(root, explicit);
  if (owner) {
    const byOwner = path.join(root, '.ai', 'worklog', `${owner}.md`);
    if (fs.existsSync(byOwner)) return byOwner;
    throw new Error(`No session journal for owner ${owner}. Create ${path.relative(root, byOwner)} first.`);
  }
  const directory = path.join(root, '.ai', 'worklog');
  if (!fs.existsSync(directory)) {
    throw new Error('No .ai/worklog directory. Start a session, or create the journal by hand.');
  }
  const notJournals = new Set(['README.md']);
  const candidates = fs.readdirSync(directory)
    .filter(name => name.endsWith('.md') && !notJournals.has(name))
    .map(name => ({ name, mtime: fs.statSync(path.join(directory, name)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  if (!candidates.length) throw new Error('No session journal found in .ai/worklog. Create one first.');
  return path.join(directory, candidates[0].name);
}

function checkOwnerReceipt(root, owner, options = {}) {
  let journalPath = options.journalPath;
  if (!journalPath) {
    if (options.journal) {
      journalPath = path.resolve(root, options.journal);
    } else if (owner) {
      if (owner.endsWith('.md') || owner.includes('/') || owner.includes('\\')) {
        journalPath = path.resolve(root, owner);
      } else {
        journalPath = path.join(root, '.ai', 'worklog', `${owner}.md`);
      }
    }
  }
  if (!journalPath) {
    return { ok: false, reason: 'missing-owner', message: 'no owner or journal specified' };
  }
  const relative = path.relative(root, journalPath);
  // A journal of this repository's .ai/worklog is read only when it is proven from the root: no link at .ai, at the folder or
  // at the journal, and no hardlink (the rule of gate.cjs, review-binding and evidence.assertJournalOwner). A journal named
  // elsewhere is the caller's explicit path and is read as given.
  const worklog = path.join(path.resolve(root), '.ai', 'worklog');
  const fold = p => (process.platform === 'win32' ? p.toLowerCase() : p);
  if (fold(path.dirname(path.resolve(journalPath))) === fold(worklog)) {
    const guarded = realInside(path.resolve(root), path.resolve(journalPath), { refuseHardlinks: true });
    if (!guarded.ok || (guarded.exists && guarded.type !== 'file')) {
      return { ok: false, reason: 'journal-not-inside', message: `journal does not stay inside .ai/worklog (${guarded.ok ? guarded.type : guarded.reason})`,
        relative, journalPath };
    }
  }
  if (!fs.existsSync(journalPath)) {
    return {
      ok: false,
      reason: 'missing-journal',
      message: `journal does not exist: ${relative}`,
      relative,
      journalPath,
    };
  }

  const sectionIndex = typeof options.sectionIndex === 'number' ? options.sectionIndex : 0;
  const journalText = fs.readFileSync(journalPath, 'utf8');
  const normalized = journalText.replace(/\r\n/g, '\n');
  const dated = datedSections(normalized);

  if (dated.length === 0) {
    return {
      ok: false,
      reason: 'no-dated-entries',
      message: 'has no dated entry',
      relative,
      journalPath,
    };
  }

  if (sectionIndex >= dated.length) {
    return {
      ok: false,
      reason: 'section-not-found',
      message: `dated section ${sectionIndex} not found`,
      relative,
      journalPath,
    };
  }

  const section = dated[sectionIndex];
  // An entry with two own entry hash lines, a hash line outside its Evidence block or a missing label is in the named
  // state ambiguous: the receipt is refused by that name, never read as one of its readings.
  const reading = entryText.entryState(section);
  if (!reading.ok) {
    return { ok: false, reason: 'entry-ambiguous', state: reading.state, code: reading.code,
      message: `entry is ambiguous (${reading.code}: ${reading.reason}); the receipt is not read.`, relative, journalPath };
  }
  const evBody = evidenceField(withoutSeparator(section));
  if (!evBody) {
    return {
      ok: false,
      reason: 'no-evidence',
      message: sectionIndex === 0
        ? 'has no Evidence block on its newest entry.'
        : `has no Evidence block on dated section ${sectionIndex}.`,
      relative,
      journalPath,
    };
  }

  const evidence = parseEvidenceBlock(evBody);
  if (!evidence) {
    return {
      ok: false,
      reason: 'no-evidence',
      message: sectionIndex === 0
        ? 'has no Evidence block on its newest entry.'
        : `has no Evidence block on dated section ${sectionIndex}.`,
      relative,
      journalPath,
    };
  }

  let state = options.state || anchor(root);
  try {
    const immutable = require('./candidate.cjs').receiptState(root, evidence);
    if (immutable) {
      if (require('./candidate.cjs').guardedText(root, journalPath) !== journalText) throw new Error('candidate journal changed during verification');
      if (options.state && options.state.commit !== immutable.commit) throw new Error('candidate differs from reviewed HEAD');
      if (options.requireFullCandidate && require('./candidate.cjs').candidateReceipt(evidence.body).scope !== 'full') throw new Error('candidate completion requires full checks');
      state = immutable;
    }
  } catch (error) {
    return { ok: false, reason: 'candidate-invalid', message: error.message, evidence, relative, journalPath };
  }

  if (evidence.format !== state.format) {
    return {
      ok: false,
      reason: 'format-mismatch',
      message: `evidence uses digest format ${evidence.format}; ` +
        `this build computes format ${state.format}. The two cannot be compared. Re-record to refresh it.`,
      evidence,
      relative,
      journalPath,
    };
  }

  let warning = null;
  if (!evidence.authenticated) {
    warning = 'evidence is not authenticated (legacy format); re-record to refresh.';
    if (!options.allowLegacy) {
      return {
        ok: false,
        reason: 'unauthenticated',
        message: warning,
        warning,
        evidence,
        relative,
        journalPath,
      };
    }
  }

  if (evidence.entry === null) {
    return {
      ok: false,
      reason: 'predates-hashing',
      message: 'evidence predates entry hashing. Re-record it so the entry itself is covered.',
      warning,
      evidence,
      relative,
      journalPath,
    };
  }

  const clean = canonicalEntryBody(section);
  const actualHash = `sha256:${crypto.createHash('sha256').update(clean, 'utf8').digest('hex')}`;
  if (evidence.entry !== actualHash) {
    return {
      ok: false,
      reason: 'entry-changed',
      message: `entry was changed after it was certified. Recorded ${evidence.entry}, the entry now hashes to ${actualHash}.`,
      warning,
      evidence,
      relative,
      journalPath,
    };
  }

  if (evidence.parentEntry === 'tampered') {
    return {
      ok: false,
      reason: 'tampered-parent',
      message: 'historical link was broken. Entry recorded a tampered parent entry.',
      warning,
      evidence,
      relative,
      journalPath,
    };
  }

  const chainCheck = verifyJournalChain(root, journalPath, Boolean(options.deep));
  if (!chainCheck.ok) {
    return {
      ok: false,
      reason: 'chain-broken',
      message: `historical link was broken. ${chainCheck.reason}`,
      warning,
      evidence,
      relative,
      journalPath,
    };
  }

  if (sectionIndex === 0 && evidence.parentEntry && evidence.parentEntry !== 'root' && evidence.parentEntry !== 'legacy') {
    const expectedParent = findParentEntry(journalPath);
    if (evidence.parentEntry !== expectedParent) {
      return {
        ok: false,
        reason: 'parent-mismatch',
        message: `historical link was broken. Recorded parent ${evidence.parentEntry}, expected ${expectedParent}.`,
        warning,
        evidence,
        relative,
        journalPath,
      };
    }
  }

  const binding = require('../lib/review-binding.cjs');
  const receiptOwner = path.basename(journalPath, '.md');
  let reviewProblem = binding.verifyBindings(root, receiptOwner, section, options.reviewPath || null);
  if ((!reviewProblem || reviewProblem === 'R-BINDING-MISSING') && options.reviewPath) {
    const review = binding.snapshotReview(root, options.reviewPath);
    const facts = require('../lib/review-facts.cjs').certificationFacts(review.text, {
      expectedSha: evidence.commit, servedModel: options.servedModel || null,
    });
    reviewProblem = facts.filter(f => !f.ok).map(f => f.code).join(', ') || reviewProblem;
    if (!evidence.commit) reviewProblem = 'R-SHA';
  }
  if (reviewProblem) return { ok: false, reason: reviewProblem, message: reviewProblem, evidence, relative, journalPath };

  if (evidence.digest !== state.digest) {
    return {
      ok: false,
      reason: 'stale',
      message: `evidence is stale. Recorded ${evidence.digest}, tree is now ${state.digest}.`,
      warning,
      evidence,
      relative,
      journalPath,
    };
  }

  if (/exit [^0]/.test(evidence.body)) {
    return {
      ok: false,
      reason: 'failing-check',
      message: 'evidence matches the tree but records a failing check.',
      warning,
      evidence,
      relative,
      journalPath,
    };
  }

  return {
    ok: true,
    reason: 'matches-current-tree',
    message: 'evidence matches the current tree',
    warning,
    evidence,
    relative,
    journalPath,
  };
}

function reportOne(root, journalPath, state, deep = false, allowLegacy = false) {
  const ev = require('./evidence.cjs').readEvidence(journalPath);
  const isCandidate = Boolean(ev && ev.candidate);
  const result = checkOwnerReceipt(root, journalPath, { journalPath, ...(isCandidate ? {} : { state }), deep, allowLegacy });
  if (result.warning) {
    process.stderr.write(`AI protocol: ${result.relative} ${result.warning}\n`);
  }
  if (!result.ok) {
    process.stderr.write(`AI protocol: ${result.relative} ${result.message}\n`);
    return 1;
  }
  process.stdout.write(`${result.relative}: evidence matches ${isCandidate ? 'the immutable candidate' : 'the current tree'}\n`);
  return 0;
}

module.exports = { verifyJournalChain, verifyArchivedChain, checkOwnerReceipt, resolveJournal, reportOne };

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hooks = require('../protocol-hooks.cjs');
const { DATE_HEADING_M_REGEX, canonicalEntryBody } = hooks;
const { findParentEntry, parseEvidenceBlock, archiveEntryRecords, findArchivedParent } = require('./evidence.cjs');
const { anchor } = require('./snapshot.cjs');

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
  for (const line of archiveText.split('\n')) {
    const match = line.trim().match(/^-[ \t]+entry:[ \t]*(sha256:[a-f0-9]{64})\b/);
    if (match) entryLabelCounts.set(match[1], (entryLabelCounts.get(match[1]) || 0) + 1);
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

function verifyJournalChain(root, journalPath, deep = false) {
  const text = fs.readFileSync(journalPath, 'utf8');
  const normalized = text.replace(/\r\n/g, '\n');
  const sections = normalized.split(/(?=^## )/m);
  const datedSections = sections.filter(s => DATE_HEADING_M_REGEX.test(s));
  const archivedParent = findArchivedParent(normalized);

  for (let i = 0; i < datedSections.length; i++) {
    const section = datedSections[i];
    const evBody = hooks.entryField(section.replace(/\n-{3,}\s*$/, '\n'), 'Evidence');
    if (!evBody) continue;
    const ev = parseEvidenceBlock(evBody);
    if (!ev || !ev.entry) continue;

    const clean = canonicalEntryBody(section);
    const actualEntryHash = `sha256:${crypto.createHash('sha256').update(clean, 'utf8').digest('hex')}`;
    if (ev.entry !== actualEntryHash) {
      return { ok: false, reason: `historical entry at index ${i} was changed after certification. Recorded ${ev.entry}, computed ${actualEntryHash}.` };
    }

    if (ev.parentEntry && ev.parentEntry !== 'root' && ev.parentEntry !== 'legacy') {
      if (ev.parentEntry === 'tampered') {
        return { ok: false, reason: `historical entry at index ${i} recorded a tampered parent entry.` };
      }
      if (i + 1 < datedSections.length) {
        const nextSection = datedSections[i + 1];
        const nextClean = canonicalEntryBody(nextSection);
        const nextHash = `sha256:${crypto.createHash('sha256').update(nextClean, 'utf8').digest('hex')}`;
        if (ev.parentEntry !== nextHash) {
          return { ok: false, reason: `historical link at index ${i} was broken. Recorded parent ${ev.parentEntry}, expected ${nextHash}.` };
        }
      } else {
        if (archivedParent) {
          if (ev.parentEntry !== archivedParent) {
            return { ok: false, reason: `oldest entry parent ${ev.parentEntry} does not match archived-parent marker ${archivedParent}.` };
          }
        }
      }
    } else if (i + 1 < datedSections.length) {
      const authenticated = /(?:^|\n)[ \t]*-[ \t]+entry hash format:[ \t]*2(?:\s|$)/m.test(section);
      if (authenticated && !ev.parentEntry && ev.chainRoot !== 'transitional') {
        return { ok: false, reason: `historical link at index ${i} lacks parent-entry; chain is broken.` };
      }
    }
  }
  if (deep) {
    const archiveCheck = verifyArchivedChain(root, archivedParent);
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
  const sections = normalized.split(/(?=^## )/m);
  const datedSections = sections.filter(s => DATE_HEADING_M_REGEX.test(s));

  if (datedSections.length === 0) {
    return {
      ok: false,
      reason: 'no-dated-entries',
      message: 'has no dated entry',
      relative,
      journalPath,
    };
  }

  if (sectionIndex >= datedSections.length) {
    return {
      ok: false,
      reason: 'section-not-found',
      message: `dated section ${sectionIndex} not found`,
      relative,
      journalPath,
    };
  }

  const section = datedSections[sectionIndex];
  const evBody = hooks.entryField(section.replace(/\n-{3,}\s*$/, '\n'), 'Evidence');
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

  const state = options.state || anchor(root);

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
  const result = checkOwnerReceipt(root, journalPath, { journalPath, state, deep, allowLegacy });
  if (result.warning) {
    process.stderr.write(`AI protocol: ${result.relative} ${result.warning}\n`);
  }
  if (!result.ok) {
    process.stderr.write(`AI protocol: ${result.relative} ${result.message}\n`);
    return 1;
  }
  process.stdout.write(`${result.relative}: evidence matches the current tree\n`);
  return 0;
}

module.exports = { verifyJournalChain, verifyArchivedChain, checkOwnerReceipt, resolveJournal, reportOne };

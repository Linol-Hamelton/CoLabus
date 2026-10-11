'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const hooks = require('../protocol-hooks.cjs');

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

const { DATE_HEADING_REGEX, DATE_HEADING_M_REGEX, ENTRY_HASH_FORMAT, hasEntryHashFormat2, canonicalEntryBody } = hooks;

function findArchivedParent(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  const firstHeading = normalized.search(/^## /m);
  const preamble = firstHeading !== -1 ? normalized.slice(0, firstHeading) : normalized;
  const match = preamble.match(/<!-- archived-parent:\s*(sha256:[a-f0-9]{64})\s*-->/);
  return match ? match[1] : null;
}

function findParentEntry(journalPath) {
  const text = fs.readFileSync(journalPath, 'utf8');
  const found = newestSection(text);
  if (!found) return 'root';
  const olderSections = found.sections.slice(found.index + 1);
  for (const section of olderSections) {
    if (DATE_HEADING_M_REGEX.test(section)) {
      const match = section.match(/^[ \t]*-[ \t]+entry:[ \t]*(sha256:[a-f0-9]{64})\b/m);
      if (match) {
        const clean = canonicalEntryBody(section);
        const actualHash = `sha256:${crypto.createHash('sha256').update(clean, 'utf8').digest('hex')}`;
        if (actualHash !== match[1]) {
          return 'tampered';
        }
        return match[1];
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

function parseEvidenceBlock(body) {
  if (!body) return null;
  const digest = body.match(/^[ \t]*-[ \t]+digest:[ \t]*(sha256:[a-f0-9]{64})\b/m) || body.match(/digest:\s*(sha256:[a-f0-9]{64})/);
  const format = body.match(/^[ \t]*-[ \t]+digest format:[ \t]*(\d+)/m) || body.match(/digest format:\s*(\d+)/);
  const entry = body.match(/^[ \t]*-[ \t]+entry:[ \t]*(sha256:[a-f0-9]{64})\b/m);
  const parent = body.match(/^[ \t]*-[ \t]+parent-entry:[ \t]*(\S+)/m);
  const chainRoot = body.match(/^[ \t]*-[ \t]+chain root:[ \t]*(\S+)/m);
  const authenticated = hasEntryHashFormat2(body);
  return { body, digest: digest ? digest[1] : null, format: format ? Number(format[1]) : 1,
    entry: entry ? entry[1] : null, parentEntry: parent ? parent[1] : null,
    chainRoot: chainRoot ? chainRoot[1] : null, authenticated };
}

function archiveEntryRecords(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  const sections = normalized.split(/(?=^## )/m);
  return sections.filter(section => DATE_HEADING_M_REGEX.test(section)).flatMap(section => {
    const match = section.match(/^[ \t]*-[ \t]+entry:[ \t]*(sha256:[a-f0-9]{64})\b/m);
    if (!match) return [];
    const clean = canonicalEntryBody(section);
    const actualHash = `sha256:${crypto.createHash('sha256').update(clean, 'utf8').digest('hex')}`;
    const evidence = hooks.entryField(section.replace(/(?:\n-{3,}[ \t]*|\n### From [^\r\n]+)*\s*$/, '\n'), 'Evidence');
    const parsed = parseEvidenceBlock(evidence);
    const hasExplicitFormat = Boolean(evidence && /digest format:\s*\d+/.test(evidence));
    const authenticated = hasEntryHashFormat2(section);
    return [{
      hash: match[1],
      actualHash,
      valid: actualHash === match[1],
      hasEvidence: Boolean(parsed && parsed.body),
      parentEntry: parsed ? parsed.parentEntry : null,
      chainRoot: parsed ? parsed.chainRoot : null,
      format: (parsed && hasExplicitFormat) ? parsed.format : null,
      authenticated,
    }];
  });
}

// The newest dated section, complete or not: evidence attaches to what the
// agent just wrote, and an incomplete entry is exactly when it matters.
function newestSection(text) {
  const normalized = text.replace(/\r\n/g, '\n');
  const sections = normalized.split(/(?=^## )/m);
  const index = sections.findIndex(section => DATE_HEADING_REGEX.test(section));
  if (index === -1) return null;
  return { sections, index, normalized };
}

function formatWithEvidence(text, block) {
  const found = newestSection(text);
  if (!found) return null;
  let section = found.sections[found.index];
  const trailing = section.match(/\n(-{3,}\s*)$/);
  const separator = trailing ? `\n${trailing[1]}` : '';
  if (trailing) section = section.slice(0, section.length - separator.length);
  section = section.replace(/\n*Evidence:[\s\S]*$/, '\n');
  section = `${section.replace(/\n+$/, '')}\n\n${block}\n${separator ? `${separator}\n` : ''}`;
  const sections = [...found.sections];
  sections[found.index] = section;
  return sections.join('');
}

function attach(journalPath, block) {
  const text = fs.readFileSync(journalPath, 'utf8');
  const updated = formatWithEvidence(text, block);
  if (updated === null) throw new Error(`No dated entry in ${journalPath}. Write the entry first, then record evidence.`);
  fs.writeFileSync(journalPath, updated);
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
  const body = hooks.entryField(found.sections[found.index].replace(/\n-{3,}\s*$/, '\n'), 'Evidence');
  return parseEvidenceBlock(body);
}

module.exports = {
  attach,
  formatWithEvidence,
  readEvidence,
  renderEvidence,
  entryHash,
  findParentEntry,
  archiveEntryRecords,
  parseEvidenceBlock,
  DATE_HEADING_REGEX,
  DATE_HEADING_M_REGEX,
  ENTRY_HASH_FORMAT,
  hasEntryHashFormat2,
  canonicalEntryBody,
  findArchivedParent,
  newestSection
};

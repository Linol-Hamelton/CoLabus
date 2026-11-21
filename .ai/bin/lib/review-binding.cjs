'use strict';
// Review bindings live inside authenticated Evidence (entry hash format 2).
// A later record may repeat a binding, never change its bytes or owner.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readFileGuarded, realInside } = require('./path-safe.cjs');
const { headerOf } = require('./review-facts.cjs');
const realPath = require('./real-path.cjs');
// Entry text is read through the one entry text model: a fenced binding, hash line or frame is entry data.
const entryText = require('./entry-text.cjs');
const OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
const reviewPath = value => typeof value === 'string' && /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(value)
  && !value.split('/').some(s => s === '.' || s === '..') && !/^\.ai\/(?:worklog|runtime)\//.test(value);
const hash = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
function reviewKey(root, relative) {
  const candidate = path.resolve(root, relative);
  // A review that does not exist yet is named by its nearest existing ancestor; an existing one without a provable real
  // path refuses the binding: its spelling would be a second identity of the same review.
  let resolved;
  try { resolved = realPath.physicalPathSync(candidate); } catch { throw new Error('R-BINDING-HISTORY'); }
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}
function fields(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [...headerOf(text).matchAll(new RegExp(`^[ \\t]*(?:[-*+] +)?(?:\\*\\*)?(?:${escaped})(?:\\*\\*)?[ \\t]*:[ \\t]*([^\\r\\n]+)`, 'gim'))].map(m => m[1].trim());
}
function reviewOwner(text) {
  const owners = [...fields(text, 'Receipt-Owner'), ...fields(text, 'Session')];
  return owners.length === 1 && OWNER.test(owners[0]) ? owners[0] : null;
}
function snapshotReview(root, relative) {
  if (!reviewPath(relative)) throw new Error('R-BINDING-PATH');
  const read = readFileGuarded(root, path.resolve(root, relative));
  if (!read.ok) throw new Error('R-BINDING-UNREADABLE');
  const bytes = read.bytes;
  return { text: bytes.toString('utf8'), sha256: hash(bytes) };
}
function bindingsOf(section) {
  const rows = [];
  for (const line of entryText.bindingLines(section)) {
    let r;
    try { r = JSON.parse(line.slice('- review-binding:'.length)); } catch { throw new Error('R-BINDING-MALFORMED'); }
    if (!r || !reviewPath(r.path) || !OWNER.test(r.owner) || !/^sha256:[a-f0-9]{64}$/.test(r.sha256) ||
        Object.keys(r).sort().join(',') !== 'owner,path,sha256' || rows.some(x => x.path === r.path)) throw new Error('R-BINDING-MALFORMED');
    rows.push(r);
  }
  return rows;
}
function mentionedReviews(text) {
  // A dot may finish a sentence; it must not truncate .md.bak or a longer path.
  return [...new Set([...String(text).replace(/\\/g, '/').matchAll(/(?<![A-Za-z0-9._/\\:-])(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md(?=[.,;:)\]}'"\u2019\u201d]+(?:\s|$)|(?![A-Za-z0-9._/-]))/g)].map(m => m[0]).filter(reviewPath))];
}
const BINDING_HINT = 'Add the exact review path to the newest journal entry, then run node .ai/bin/protocol-handoff.cjs record --owner <Receipt-Owner> --quick.';
function missingBindingWarning(root, owner, rows) {
  if (rows.length) return null;
  const dir = realInside(root, path.join(root, 'docs/reviews'));
  if (!dir.ok || !dir.exists || dir.type !== 'dir') return null;
  // Diagnostic only: never infer a binding from directory discovery.
  let names;
  try { names = fs.readdirSync(dir.real); } catch { return null; }
  for (const name of names) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(name)) continue;
    const report = readFileGuarded(root, path.join(root, 'docs/reviews', name), { maxBytes: 8 * 1024 * 1024 });
    if (report.ok && reviewOwner(report.bytes.toString('utf8')) === owner) return `R-BINDING-MISSING: ${BINDING_HINT}`;
  }
  return null;
}
// A whole-journal frame after the entry's `- entry:` line starts the next archived journal, unless the entry hash covers
// it: a frame quoted inside the entry (its Evidence block stands before that quoted tail) is entry text. The entry ends
// at the first cut its recorded hash authenticates, else at the first frame.
function historicalSection(section) {
  const label = entryText.entryLines(section)[0];
  if (!label) return section;
  const after = label.index + label.line.length;
  const cuts = entryText.journalFrames(section, after).map(at => section.slice(0, at));
  if (!cuts.length) return section;
  return (label.hash && [...cuts, section].find(cut => entryText.entryDigest(cut) === label.hash)) || cuts[0];
}
function historicalClaims(root, relative) {
  const keys = new Map();
  const identity = relative => {
    if (!keys.has(relative)) keys.set(relative, reviewKey(root, relative));
    return keys.get(relative);
  };
  const expected = identity(relative);
  // Every history source is read from the real .ai/worklog folder and .ai/ARCHIVE.md of this repository: the walk starts
  // at the repository root, so a link at .ai, at the folder or at a journal and a hardlinked journal are refused (the rule
  // of gate.cjs and evidence.assertJournalOwner). A source that is not proven refuses the binding: its claims are unknown.
  const top = path.resolve(root);
  const proven = (file, type) => {
    const g = realInside(top, file, { refuseHardlinks: true });
    if (!g.ok || (g.exists && g.type !== type)) throw new Error('R-BINDING-HISTORY');
    return g;
  };
  const dir = path.join(top, '.ai', 'worklog');
  const journals = proven(dir, 'dir').exists ? fs.readdirSync(dir).filter(n => n.endsWith('.md') && n !== 'README.md').map(n => path.join(dir, n)) : [];
  const archive = path.join(top, '.ai', 'ARCHIVE.md');
  if (proven(archive, 'file').exists) journals.push(archive);
  const claims = [];
  for (const file of journals) {
    const g = proven(file, 'file');
    if (!g.exists) throw new Error('R-BINDING-HISTORY');
    const text = fs.readFileSync(g.real, 'utf8').replace(/\r\n/g, '\n');
    if (!mentionedReviews(text).some(p => identity(p) === expected)) continue;
    for (const dated of entryText.datedSections(text)) {
      const section = historicalSection(dated);
      if (!mentionedReviews(section).some(p => identity(p) === expected) || !entryText.hasEntryHashFormat2(section)) continue;
      const recorded = entryText.recordedEntryHash(section);
      if (!recorded || entryText.entryDigest(section) !== recorded) continue;
      const rows = bindingsOf(section).filter(r => identity(r.path) === expected);
      if (rows.length) claims.push(...rows);
      // Conservative migration: a previously receipted reference cannot be
      // adopted by a different session. Use a new review path for a new audit.
      else {
        const by = (entryText.parseEvidenceBlock(section).recordedBy || []).find(owner => OWNER.test(owner));
        if (by) claims.push({ path: relative, owner: by, sha256: null });
      }
    }
  }
  return claims;
}
function bindingProblem(root, row) {
  let current;
  try { current = snapshotReview(root, row.path); } catch (e) { return e.message; }
  if (reviewOwner(current.text) !== row.owner) return 'R-OWNER-CHANGED';
  if (current.sha256 !== row.sha256) return 'R-REVIEW-CHANGED';
  // A history that cannot be read is a named refusal of every caller (record, verify, cert-verdict, cert-count, chain).
  let history;
  try { history = historicalClaims(root, row.path); } catch (e) { return /^R-[A-Z-]+$/.test(e.message) ? e.message : 'R-BINDING-HISTORY'; }
  for (const old of history) {
    if (old.owner !== row.owner) return 'R-OWNER-REBOUND';
    if (old.sha256 && old.sha256 !== row.sha256) return 'R-REVIEW-CHANGED';
  }
  return null;
}
function collectBindings(root, owner, entry) {
  const rows = [];
  for (const relative of mentionedReviews(entry)) {
    let r;
    try { r = snapshotReview(root, relative); } catch { continue; }
    if (!fields(r.text, 'Mode').some(m => m.toUpperCase() === 'CERTIFYING')) continue;
    if (reviewOwner(r.text) !== owner) continue; // authors may cite independent reports
    if (require('./review-facts.cjs').certificationFacts(r.text).some(f => f.code === 'R-STATUS' && !f.ok)) continue;
    const row = { path: relative, owner, sha256: r.sha256 };
    const problem = bindingProblem(root, row);
    if (problem) throw new Error(problem);
    rows.push(row);
  }
  return rows.sort((a, b) => a.path.localeCompare(b.path));
}
function verifyBindings(root, owner, section, reviewPath = null) {
  let rows;
  try { rows = bindingsOf(section); } catch (e) { return e.message; }
  if (reviewPath && !rows.some(r => r.path === reviewPath)) return 'R-BINDING-MISSING';
  for (const row of rows) {
    if (row.owner !== owner) return 'R-OWNER-REBOUND';
    const problem = bindingProblem(root, row);
    if (problem) return problem;
  }
  return null;
}
module.exports = { fields, reviewOwner, snapshotReview, bindingsOf, mentionedReviews, collectBindings, verifyBindings, BINDING_HINT, missingBindingWarning };

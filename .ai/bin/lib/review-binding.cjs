'use strict';
// Review bindings live inside authenticated Evidence (entry hash format 2).
// A later record may repeat a binding, never change its bytes or owner.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readFileGuarded } = require('./path-safe.cjs');
const { headerOf } = require('./review-facts.cjs');
const OWNER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,80}$/;
const reviewPath = value => typeof value === 'string' && /^(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(value)
  && !value.split('/').some(s => s === '.' || s === '..') && !/^\.ai\/(?:worklog|runtime)\//.test(value);
const hash = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
function reviewKey(root, relative) {
  const candidate = path.resolve(root, relative);
  let resolved;
  try { resolved = fs.realpathSync.native(candidate); } catch { resolved = candidate; }
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
  for (const line of String(section).split(/\r?\n/)) {
    if (!line.startsWith('- review-binding:')) continue;
    let r;
    try { r = JSON.parse(line.slice('- review-binding:'.length)); } catch { throw new Error('R-BINDING-MALFORMED'); }
    if (!r || !reviewPath(r.path) || !OWNER.test(r.owner) || !/^sha256:[a-f0-9]{64}$/.test(r.sha256) ||
        Object.keys(r).sort().join(',') !== 'owner,path,sha256' || rows.some(x => x.path === r.path)) throw new Error('R-BINDING-MALFORMED');
    rows.push(r);
  }
  return rows;
}
function mentionedReviews(text) {
  return [...new Set([...String(text).replace(/\\/g, '/').matchAll(/(?<![A-Za-z0-9._/\\:-])(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md(?![A-Za-z0-9._/-])/g)].map(m => m[0]).filter(reviewPath))];
}
function historicalSection(section) {
  const label = /^[ \t]*-[ \t]+entry:[^\r\n]+/m.exec(section);
  if (!label) return section;
  const after = label.index + label[0].length;
  const cut = section.slice(after).search(/\n---\n\n### From journal \.ai\/worklog\/[^\r\n]+, archived \d{4}-\d{2}-\d{2} \(\d+ bytes, sha256:[a-f0-9]{64}\)\n\n/);
  return cut < 0 ? section : section.slice(0, after + cut);
}
function historicalClaims(root, relative) {
  const keys = new Map();
  const identity = relative => {
    if (!keys.has(relative)) keys.set(relative, reviewKey(root, relative));
    return keys.get(relative);
  };
  const expected = identity(relative);
  const hooks = require('../protocol-hooks.cjs');
  const dir = path.join(root, '.ai', 'worklog');
  const journals = fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.md') && n !== 'README.md').map(n => path.join(dir, n)) : [];
  const archive = path.join(root, '.ai', 'ARCHIVE.md');
  if (fs.existsSync(archive)) journals.push(archive);
  const claims = [];
  for (const file of journals) {
    const text = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
    if (!mentionedReviews(text).some(p => identity(p) === expected)) continue;
    for (const rawSection of text.split(/(?=^## )/m)) {
      const section = historicalSection(rawSection);
      if (!hooks.DATE_HEADING_M_REGEX.test(section) || !mentionedReviews(section).some(p => identity(p) === expected) || !hooks.hasEntryHashFormat2(section)) continue;
      const entry = /^- entry: (sha256:[a-f0-9]{64})\b/m.exec(section);
      if (!entry || hash(hooks.canonicalEntryBody(section)) !== entry[1]) continue;
      const rows = bindingsOf(section).filter(r => identity(r.path) === expected);
      if (rows.length) claims.push(...rows);
      // Conservative migration: a previously receipted reference cannot be
      // adopted by a different session. Use a new review path for a new audit.
      else {
        const recorded = /^- recorded: .+ by ([A-Za-z0-9_-]+)$/m.exec(section);
        if (recorded) claims.push({ path: relative, owner: recorded[1], sha256: null });
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
  for (const old of historicalClaims(root, row.path)) {
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
module.exports = { fields, reviewOwner, snapshotReview, bindingsOf, mentionedReviews, collectBindings, verifyBindings };

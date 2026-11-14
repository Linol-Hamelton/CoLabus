'use strict';
// path-grammar.cjs - the closed grammar of a write-set entry, shared by write-set-check.cjs and
// check-plan.cjs. An entry that does not match the grammar is UNPARSED; it is never guessed at.
//
//   entry    := segment ( "/" segment )* [ "/" | "/**" ]
//   segment  := 1..255 characters of letters, digits and . _ @ + = - (Unicode letters and digits
//               included); "*" only in the LAST segment; no "." or ".." segment; no trailing dot;
//               no Windows device name, no 8.3 alias form (tools/gates/reserved-names.cjs)
//
// A backslash is read as "/" (one separator on Windows). Surrounding backticks are removed by the
// callers. Meaning of an entry:
//   exact  "a/b.md"            that path; for the OVERLAP test also everything under it, because
//                               a directory can carry a file's name
//   tree   "a/b/" "a/b/**"       everything under a/b
//   glob   "a/b/c-*.md"         names in a/b matching the glob; for OVERLAP also everything under
// Comparison is without case and after Unicode NFC, because Windows and the default macOS volume
// treat those spellings as one file.

const { segmentProblems } = require('./reserved-names.cjs');

const SEGMENT_CHAR = /^[\p{L}\p{N}._@+=-]$/u;

function fold(s) { return s.normalize('NFC').toUpperCase(); }

function parseEntry(raw) {
  if (typeof raw !== 'string') return { ok: false, raw: String(raw), error: 'not text' };
  const text = raw.normalize('NFC').replace(/\\/g, '/');
  if (text.length === 0) return { ok: false, raw, error: 'empty entry' };
  if (text.startsWith('/')) return { ok: false, raw, error: 'absolute path' };
  let body = text;
  let kind = 'exact';
  if (body.endsWith('/**')) { kind = 'tree'; body = body.slice(0, -3); }
  else if (body.endsWith('/')) { kind = 'tree'; body = body.slice(0, -1); }
  if (body.length === 0) return { ok: false, raw, error: 'no literal directory before the tree mark' };
  const segments = body.split('/');
  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    const last = i === segments.length - 1;
    const problems = segmentProblems(seg.replace(/\*/g, 'x'));
    if (problems.length) return { ok: false, raw, error: `${problems[0].code}: ${problems[0].detail}` };
    for (const ch of seg) {
      if (ch === '*') {
        if (!last || kind === 'tree') return { ok: false, raw, error: `"*" outside the last segment in "${seg}"` };
        continue;
      }
      if (!SEGMENT_CHAR.test(ch)) return { ok: false, raw, error: `character "${ch}" is outside the entry alphabet` };
    }
    if (seg.includes('**')) return { ok: false, raw, error: `"**" inside a segment in "${seg}"` };
  }
  const lastSeg = segments[segments.length - 1];
  if (kind === 'exact' && lastSeg.includes('*')) kind = 'glob';
  return { ok: true, raw, text: segments.join('/') + (kind === 'tree' ? '/' : ''), kind, segments };
}

// A single-segment glob with "*" only, matched without case.
function globToRegExp(glob) {
  const escaped = fold(glob).split('*').map(part => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`, 'u');
}

// Two "*"-globs share a name when the shorter literal head is a head of the longer one and the same
// holds for the tails (the stars absorb everything in between).
function globsIntersect(a, b) {
  const A = fold(a); const B = fold(b);
  const headA = A.split('*')[0]; const headB = B.split('*')[0];
  const tailA = A.split('*').pop(); const tailB = B.split('*').pop();
  const headOk = headA.startsWith(headB) || headB.startsWith(headA);
  const tailOk = tailA.endsWith(tailB) || tailB.endsWith(tailA);
  return headOk && tailOk;
}

function segmentsMeet(a, b) {
  const ga = a.includes('*'); const gb = b.includes('*');
  if (!ga && !gb) return fold(a) === fold(b);
  if (ga && gb) return globsIntersect(a, b);
  return ga ? globToRegExp(a).test(fold(b)) : globToRegExp(b).test(fold(a));
}

// Can one path be written by both entries? Each entry also covers everything under the node it
// names, so only the common prefix of segments has to agree.
function entriesOverlap(a, b) {
  if (!a.ok || !b.ok) throw new Error('entriesOverlap needs two parsed entries');
  const n = Math.min(a.segments.length, b.segments.length);
  for (let i = 0; i < n; i++) if (!segmentsMeet(a.segments[i], b.segments[i])) return false;
  return true;
}

// Does entry e name a concrete repository path p (forward slashes)?
function entryCovers(e, p) {
  const segs = p.split('/');
  if (segs.length < e.segments.length) return false;
  for (let i = 0; i < e.segments.length; i++) if (!segmentsMeet(e.segments[i], segs[i])) return false;
  return true;
}

module.exports = { parseEntry, entriesOverlap, entryCovers, segmentsMeet, globsIntersect, globToRegExp, fold };

'use strict';

// One closed protocol-version grammar. A final negative lookahead also refuses
// a trailing LF (JavaScript's $ anchor alone would accept one).
const VERSION = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-pre\.([1-9][0-9]{0,2}))?(?![\s\S])/;

function parseVersion(value) {
  if (typeof value !== 'string') return null;
  const match = VERSION.exec(value);
  return match ? { release: match.slice(1, 4).map(BigInt), pre: match[4] === undefined ? null : BigInt(match[4]) } : null;
}

function requireVersion(value) {
  if (!parseVersion(value)) throw new Error('Invalid protocol version: expected X.Y.Z or X.Y.Z-pre.N (N=1..999)');
  return value;
}

function releaseParts(value) {
  const parsed = parseVersion(value);
  return parsed && parsed.pre === null ? parsed.release : null;
}

function compareVersions(left, right) {
  const a = parseVersion(left), b = parseVersion(right);
  if (!a || !b) throw new Error('Cannot compare invalid protocol versions');
  for (let i = 0; i < 3; i++) {
    if (a.release[i] !== b.release[i]) return a.release[i] > b.release[i] ? 1 : -1;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  return a.pre > b.pre ? 1 : -1;
}

function releaseAtLeast(target, current) {
  return Boolean(releaseParts(target) && parseVersion(current) && compareVersions(target, current) >= 0);
}

module.exports = { parseVersion, requireVersion, releaseParts, compareVersions, releaseAtLeast };

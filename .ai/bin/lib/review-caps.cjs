'use strict';
// A10-CAPS preparation only: no dispatch/validator caller before S6-L7-ACT.
// Advisory sizing consumes one guarded, decoded snapshot and echoes no content.
const path = require('node:path');
const textSafe = require('./text-safe.cjs');
const pathSafe = require('./path-safe.cjs');
const { lineCount } = require('../protocol-prose.cjs');
const CAPS = Object.freeze({ 'review-prompt': 150, 'review-report': 250 });
function inspectReviewCap(root, file, kind) {
  const unknown = { status: 'UNKNOWN', lines: null, cap: CAPS[kind] || null, blocking: false };
  if (!Object.hasOwn(CAPS, kind) || typeof root !== 'string' || typeof file !== 'string') return unknown;
  const read = pathSafe.readFileGuarded(root, path.resolve(root, file));
  if (!read.ok) return unknown;
  const decoded = textSafe.decode(read.bytes);
  if (!decoded.ok) return unknown;
  const lines = lineCount(decoded.text);
  return { status: lines > CAPS[kind] ? 'WARN' : 'OK', lines, cap: CAPS[kind], blocking: false };
}
module.exports = { inspectReviewCap };

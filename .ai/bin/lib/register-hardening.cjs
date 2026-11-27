'use strict';
// Optional finding metadata is preserved independently of allocated register ids.
const { TextDecoder } = require('node:util');
const { parseJsonUnique } = require('./text-safe.cjs');
const secrets = require('./secrets.cjs');
const protectedPaths = require('./protected-paths.cjs');
const FIELDS = Object.freeze(['sourceReport', 'sourceHash', 'findingId', 'reader', 'originalClass',
  'eligibilityClass', 'reproFile', 'caseId', 'expected', 'fixOwner', 'deferredIn']);
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function relative(v, opts = {}) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(v)) return false;
  const names = protectedPaths.protectedNames(opts);
  return !v.split('/').some(s => s === '.' || s === '..'
    || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(s)
    || names.some(n => s.toLowerCase() === n || s.toLowerCase().startsWith(n + '.')));
}
function parse(raw, limit = 16 * 1024 * 1024) {
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (bytes.length > limit || bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) throw Error('HARDENING_JSON');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  let depth = 0, quoted = false, escaped = false;
  for (const c of text) {
    if (escaped) { escaped = false; continue; }
    if (quoted && c === '\\') { escaped = true; continue; }
    if (c === '"') quoted = !quoted;
    if (!quoted && (c === '{' || c === '[') && ++depth > 32) throw Error('HARDENING_DEPTH');
    if (!quoted && (c === '}' || c === ']')) depth--;
  }
  return parseJsonUnique(text);
}
function validate(rows, prefix = 'hardening') {
  if (!Array.isArray(rows)) return [`${prefix}: expected an array`];
  const problems = [];
  const object = (v, fields, where, required = []) => {
    if (!plain(v)) { problems.push(`${where}: expected an object`); return; }
    for (const k of required) if (!Object.hasOwn(v, k)) problems.push(`${where}.${k}: missing`);
    for (const [k, val] of Object.entries(v)) {
      if (!fields.includes(k)) problems.push(`${where}: unknown field`);
      else if (typeof val !== 'string' || /[\u0000-\u001f\u007f\u0085\u2028\u2029<>&]/.test(val) || secrets.secretIn(val)) problems.push(`${where}.${k}: expected safe single-line text`);
    }
  };
  rows.forEach((row, i) => {
    const where = `${prefix}[${i}]`;
    if (!plain(row)) { problems.push(`${where}: expected an object`); return; }
    object(Object.fromEntries(Object.entries(row).filter(([k]) => !['promotedBy', 'knownLimit'].includes(k))), FIELDS, where, FIELDS);
    if (Object.hasOwn(row, 'promotedBy')) object(row.promotedBy, ['sourceReport', 'sourceHash', 'findingId', 'reader'], `${where}.promotedBy`, ['sourceReport', 'sourceHash', 'findingId', 'reader']);
    if (Object.hasOwn(row, 'knownLimit')) object(row.knownLimit, ['id', 'effect', 'recipe', 'fixedIn'], `${where}.knownLimit`, ['id', 'effect']);
  });
  return problems;
}
module.exports = { FIELDS, plain, relative, parse, validate };

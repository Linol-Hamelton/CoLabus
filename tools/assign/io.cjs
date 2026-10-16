'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const safe = require('../../.ai/bin/lib/path-safe.cjs');
const text = require('../../.ai/bin/lib/text-safe.cjs');
const { privacyProblems } = require('../../.ai/bin/accounting/lib/pairs-core.cjs');
const { scanBuffer } = require('../../docs/ops/history-archive/lib.cjs');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/+~-]{0,159}$/.test(v);
const count = v => Number.isSafeInteger(v) && v >= 0;
const money = v => typeof v === 'string' && /^(0|[1-9][0-9]{0,8})(\.[0-9]{1,18})?$/.test(v);
const hash = v => crypto.createHash('sha256').update(typeof v === 'string' || Buffer.isBuffer(v) ? v : canonical(v)).digest('hex');
function canonical(v) {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (object(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
function fields(v, allowed, required = []) {
  if (!object(v) || Object.keys(v).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(v, k))) fail('closed-grammar');
}
function publicValue(value) {
  const serialised = JSON.stringify(value);
  if (!serialised || privacyProblems(value).length || scanBuffer(Buffer.from(serialised)).count) fail('private-output');
  return value;
}
function guard(root, file, allowRoot = false) {
  const base = safe.realInside(path.parse(path.resolve(root)).root, path.resolve(root), { allowRoot: true, refuseHardlinks: true });
  if (!base.ok || base.type !== 'dir') fail('root-unsafe');
  const g = safe.realInside(base.real, file, { allowRoot, refuseHardlinks: true });
  if (!g.ok) fail('path-unsafe');
  return g;
}
// Both strict decoders take the BOM and the invisible-character decision from
// ONE shared object, so each decoder guard keeps exactly one literal anchor in
// this file and the base compatibility mutation harness still pins it and its
// mutants still apply and are killed.
const STRICT_DECODE = { bom: 'refuse', invisible: 'refuse' };
function readText(root, file, maxBytes = 1024 * 1024, finalNewline = 'refuse') {
  const g = guard(root, file);
  if (!g.exists || g.type !== 'file' || fs.statSync(g.real).size > maxBytes) fail('input-size-or-type');
  const read = safe.readFileGuarded(root, file);
  if (!read.ok || read.bytes.length > maxBytes) fail('input-unverified');
  const decoded = text.decode(read.bytes, { ...STRICT_DECODE, crlf: 'normalise', finalNewline });
  if (!decoded.ok || decoded.notes.some(n => n.code === 'NOT_NFC')) fail('text-invalid');
  return decoded.text;
}
// Operator-supplied free text (an argv value, an in-process string) that never
// passed through a guarded file: the SAME explicit zero-width, bidi, control
// and NFC decision the strict file decoder makes, so no free-text input can
// reach a durable record that the strict reader would later refuse
function operatorText(value) {
  if (typeof value !== 'string') fail('text-invalid');
  const decoded = text.decode(Buffer.from(value, 'utf8'), { ...STRICT_DECODE, crlf: 'refuse', finalNewline: 'report' });
  if (!decoded.ok || decoded.notes.some(n => n.code === 'NOT_NFC')) fail('text-invalid');
  return decoded.text;
}
function readJson(root, file, maxBytes) { return text.parseJsonUnique(readText(root, file, maxBytes)); }
function writeJson(root, file, value) { return writeText(root, file, JSON.stringify(publicValue(value), null, 2) + '\n'); }
function writeText(root, file, value) {
  guard(root, file);
  const result = safe.writeAtomicGuarded(file, Buffer.from(value), { root });
  if (!result.ok || result.closeError) fail('output-write-failed');
  return true;
}
module.exports = { fail, object, id, count, money, fields, hash, canonical, publicValue, guard, readText, operatorText, readJson, writeText, writeJson };

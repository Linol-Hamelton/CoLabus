'use strict';
// All controller input bytes pass through the shared path/text/unique-key guards.
const fs = require('node:fs');
const path = require('node:path');
const safe = require('../../.ai/bin/lib/path-safe.cjs');
const text = require('../../.ai/bin/lib/text-safe.cjs');
const { validate } = require('../../.ai/bin/accounting/lib/schema-check.cjs');
function refuse(code) { throw Object.assign(new Error(code), { code }); }
function bytes(file, what) {
  const result = safe.readFileGuarded(path.parse(path.resolve(file)).root, path.resolve(file), { refuseHardlinks: true });
  if (!result.ok) refuse(`${what}-unreadable`);
  return result.bytes;
}
function readText(file, what) {
  const decoded = text.decode(bytes(file, what), { bom: 'refuse', crlf: 'refuse', invisible: 'refuse', finalNewline: 'refuse' });
  if (!decoded.ok || decoded.notes.some(n => n.code === 'NOT_NFC')) refuse(`${what}-encoding`);
  return decoded.text;
}
function json(file, what) {
  try { return text.parseJsonUnique(readText(file, what)); }
  catch (e) { if (e.code?.startsWith(`${what}-`)) throw e; refuse(`${what}-${e.code || 'json'}`); }
}
function checked(value, schemaName, what) {
  const schema = json(path.join(__dirname, `${schemaName}.schema.json`), 'schema');
  if (validate(schema, value).length) refuse(`${what}-schema`);
  return value;
}
function data(file, kind) { return checked(json(file, kind), kind, kind); }
function caps(file) { return data(file, 'caps'); }
function answers(file) {
  const value = data(file, 'answers');
  const seen = new Set();
  for (const row of value.answers) {
    const key = `${row.client}:${row.promptClass}`;
    if (seen.has(key)) refuse('answers-duplicate-row');
    seen.add(key);
    if ((row.promptClass === 'continue') !== (row.answer === 'continue')) refuse('answers-answer-class');
  }
  return value;
}
module.exports = { bytes, readText, json, checked, data, caps, answers, refuse };

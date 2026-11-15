'use strict';
const { TextDecoder } = require('node:util');
const fail = () => { throw new Error('ACCESS_PUBLIC_DATA_INVALID'); };
const MAX_BYTES = 131072;
// Public exports need not be JCS. Unlike JSON.parse, this reader refuses duplicate
// keys before projection, including escaped aliases, at every nesting level.
function readPublicJson(bytes, maxBytes = MAX_BYTES) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || !Buffer.isBuffer(bytes) || bytes.length > maxBytes ||
    bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))) fail();
  let text;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail(); }
  let i = 0;
  const skip = () => { while (i < text.length && /[ \t\r\n]/.test(text[i])) i++; };
  const string = () => {
    const start = i++;
    while (i < text.length && text[i] !== '"') { if (text[i] === '\\') i++; i++; }
    if (i >= text.length) fail();
    let s;
    try { s = JSON.parse(text.slice(start, ++i)); } catch { fail(); }
    for (let n = 0; n < s.length; n++) {
      const c = s.charCodeAt(n);
      if (c >= 0xd800 && c <= 0xdbff) {
        const next = s.charCodeAt(++n);
        if (!(next >= 0xdc00 && next <= 0xdfff)) fail();
      } else if (c >= 0xdc00 && c <= 0xdfff) fail();
    }
    return s;
  };
  function value(depth) {
    if (depth > 24) fail();
    skip();
    if (text[i] === '"') return string();
    if (text[i] === '{' || text[i] === '[') {
      const object = text[i++] === '{', end = object ? '}' : ']';
      const out = object ? Object.create(null) : [], keys = new Set();
      skip();
      if (text[i] === end) { i++; return out; }
      for (;;) {
        skip();
        if (object) {
          if (text[i] !== '"') fail();
          const key = string();
          if (keys.has(key)) fail();
          keys.add(key); skip();
          if (text[i++] !== ':') fail();
          out[key] = value(depth + 1);
        } else out.push(value(depth + 1));
        skip();
        if (text[i] === end) { i++; return out; }
        if (text[i++] !== ',') fail();
      }
    }
    const m = /^(?:null|true|false|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(text.slice(i));
    if (!m) fail();
    i += m[0].length;
    const out = JSON.parse(m[0]);
    if (typeof out === 'number' && !Number.isFinite(out)) fail();
    return out;
  }
  const out = value(0); skip();
  if (i !== text.length) fail();
  return out;
}
// Only the vocabulary used by these checked-in schemas; unsupported keywords
// are not exposed to an untrusted schema. Errors never include input values.
function validate(schema, value, root = schema) {
  if (schema.$ref) return validate(root.$defs[schema.$ref.split('/').pop()], value, root);
  const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
  if (schema.type && ![].concat(schema.type).some(t => t === type || t === 'integer' && Number.isSafeInteger(value))) fail();
  if (Object.hasOwn(schema, 'const') && value !== schema.const) fail();
  if (schema.enum && !schema.enum.includes(value)) fail();
  if (type === 'number' && (!Number.isFinite(value) || value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity))) fail();
  if (type === 'string' && (value.length < (schema.minLength ?? 0) || value.length > (schema.maxLength ?? 4096) ||
    schema.pattern && !new RegExp(schema.pattern).test(value) || schema.format === 'date-time' && !Number.isFinite(Date.parse(value)))) fail();
  if (type === 'array') {
    if (value.length < (schema.minItems ?? 0) || value.length > (schema.maxItems ?? 4096)) fail();
    if (schema.uniqueItems && new Set(value.map(x => JSON.stringify(x))).size !== value.length) fail();
    for (const item of value) validate(schema.items, item, root);
  }
  if (type === 'object') {
    for (const key of schema.required || []) if (!Object.hasOwn(value, key)) fail();
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema.properties || {}, key)) { if (schema.additionalProperties === false) fail(); }
      else validate(schema.properties[key], value[key], root);
    }
  }
}
const freeze = v => { if (v && typeof v === 'object') { Object.values(v).forEach(freeze); Object.freeze(v); } return v; };
module.exports = { MAX_BYTES, fail, readPublicJson, validate, freeze };

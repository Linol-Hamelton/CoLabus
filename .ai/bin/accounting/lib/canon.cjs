'use strict';
// Canonical JSON and SHA-256 helpers.
// Canonical form: UTF-8, object keys sorted recursively at every depth, no whitespace,
// arrays in their given order. A field named in `omit` is left out at the top level only
// (used to exclude `hash` from the hashed content).

const crypto = require('crypto');

/**
 * Set an own enumerable property. Plain assignment of a key named __proto__ would set the prototype and lose the property
 * (A6-07), so that one key is defined explicitly; every other key keeps the plain assignment.
 * @param {object} obj
 * @param {string} key
 * @param {*} val
 */
function setOwn(obj, key, val) {
  if (key === '__proto__') Object.defineProperty(obj, key, { value: val, enumerable: true, writable: true, configurable: true });
  else obj[key] = val;
}

/**
 * Return a deep copy with object keys sorted recursively.
 * @param {*} value
 * @returns {*}
 */
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value).sort()) setOwn(out, k, sortKeys(value[k]));
    return out;
  }
  return value;
}

/**
 * Canonical JSON string of a value.
 * @param {*} value
 * @param {string[]} [omit] top-level keys to leave out
 * @returns {string}
 */
function canonicalJson(value, omit) {
  let v = value;
  if (omit && omit.length && value && typeof value === 'object' && !Array.isArray(value)) {
    v = {};
    for (const k of Object.keys(value)) if (!omit.includes(k)) setOwn(v, k, value[k]);
  }
  return JSON.stringify(sortKeys(v));
}

/**
 * SHA-256 hex of a string or buffer.
 * @param {string|Buffer} data
 * @returns {string}
 */
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/**
 * Hash of the canonical form of a value (top-level `hash` key excluded).
 * @param {*} value
 * @returns {string}
 */
function hashOf(value) {
  return sha256(canonicalJson(value, ['hash']));
}

module.exports = { sortKeys, canonicalJson, sha256, hashOf };

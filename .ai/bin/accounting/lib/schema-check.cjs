'use strict';
// Minimal JSON Schema subset checker. No dependencies.
// Supported keywords: type (string or array of strings), required, properties,
// additionalProperties (boolean or schema), enum, pattern, items, minimum, maximum,
// minLength, maxLength. Unknown keywords are ignored except that a schema must be an object.

/**
 * @param {*} value
 * @returns {string}
 */
function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (Number.isInteger(value)) return 'integer';
  return typeof value; // string, number, boolean, object
}

/**
 * @param {string} want
 * @param {string} got result of typeOf
 * @returns {boolean}
 */
function typeMatches(want, got) {
  if (want === got) return true;
  return want === 'number' && got === 'integer';
}

/**
 * Validate a value against a schema.
 * @param {object} schema
 * @param {*} value
 * @param {string} [path]
 * @returns {string[]} list of error strings (empty when valid)
 */
function validate(schema, value, path) {
  const at = path || '$';
  const errors = [];
  if (!schema || typeof schema !== 'object') return [`${at}: schema is not an object`];

  const got = typeOf(value);
  if (schema.type !== undefined) {
    const wants = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!wants.some((w) => typeMatches(w, got))) {
      errors.push(`${at}: type ${got}, expected ${wants.join('|')}`);
      return errors;
    }
  }
  if (schema.enum !== undefined && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value))) {
    errors.push(`${at}: value not in enum`);
  }
  if (typeof value === 'string') {
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      errors.push(`${at}: does not match pattern ${schema.pattern}`);
    }
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at}: longer than ${schema.maxLength}`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at}: below minimum ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at}: above maximum ${schema.maximum}`);
  }
  if (got === 'array' && schema.items !== undefined) {
    value.forEach((item, i) => errors.push(...validate(schema.items, item, `${at}[${i}]`)));
  }
  if (got === 'object') {
    const props = schema.properties || {};
    for (const req of schema.required || []) {
      if (!Object.prototype.hasOwnProperty.call(value, req)) errors.push(`${at}: missing required ${req}`);
    }
    for (const k of Object.keys(value)) {
      if (Object.prototype.hasOwnProperty.call(props, k)) {
        errors.push(...validate(props[k], value[k], `${at}.${k}`));
      } else if (schema.additionalProperties === false) {
        errors.push(`${at}: unknown key ${k}`);
      } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
        errors.push(...validate(schema.additionalProperties, value[k], `${at}.${k}`));
      }
    }
  }
  return errors;
}

module.exports = { validate, typeOf };

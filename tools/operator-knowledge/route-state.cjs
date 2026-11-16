'use strict';
// route-state.cjs - the ONE strict reader of the committed seed plus its durable
// route-state.local.json field overlay, and the pure state function
// of the operator knowledge (PROTO-DEC-0235, guarantees K1, K2, K3, K5).
//
// The record is a schema-checked list of routes. Every route field is an object with an explicit tag:
//   declared  balance, limit, plan, price  - written only by declare.cjs, names the owner act and expires
//   measured  probe, performance           - written only by refresh.cjs, names the moment it was measured
// A field without a tag, with the tag of the other kind, or with a name the schema does not know is a
// named refusal of the whole record. There is no second JSON parser and no second decoder here: the
// bytes go through path-safe.readFileGuarded, text-safe.decode and text-safe.parseJsonUnique, exactly
// as the other kernel readers do.
//
// Canonical numbers: before JSON.parse, every number token is checked against its own canonical JSON
// spelling, so 1.0, 1e3, -0 and an integer outside the safe range are named refusals. Two spellings of
// one number never become one value by accident.
//
// stateAt(record, now, {role, launches}) is pure: the time is explicit. Default role is
// author/advice; certifier additionally requires proxy banner/log model proof. A caller that holds
// launch records passes them as launches; without that list a scarce route is unknown (LAUNCH_NOT_READ); a list that is
// not an array of launch objects is refused (LAUNCHES_INVALID). It returns,
// per route, one of
//   ok       the probe is fresh and ok and every required declared field is present and fresh
//   failed   the probe is fresh and not ok, except TIMEOUT (unknown / PROBE_TIMEOUT) and QUOTA_EXHAUSTED
//            (unknown / PROBE_QUOTA_EXHAUSTED: a quota with a reset is not a dead route)
//   unknown  the probe or a declared field is missing, expired or dated in the future
// A value past its expiry is never carried forward: fields[name].value is null and the route is unknown.
// performance is advisory history: its expiry nulls the numbers, but it never decides availability.
//
// Atomic writes: writeRecord sends the exact bytes to the shared path-safe writer (a temp file in the
// same directory, then a rename); a failed writer leaves the old record untouched and is a named
// refusal. The writer is injectable for the failure test only; production uses the shared writer.
//
// Closed lists below are the whole vocabulary of this module. A caller never invents a reason.

const path = require('node:path');
const fs = require('node:fs');

const pathSafe = require('../../.ai/bin/lib/path-safe.cjs');
const textSafe = require('../../.ai/bin/lib/text-safe.cjs');
const accounting = require('../../.ai/bin/accounting/launch-stats.cjs');
const kernel = require('../../.ai/bin/accounting/launch-record-validate.cjs');
const identity = require('./launch-identity.cjs');
const { LIVE_TTL_MS, SCARCE_CLIENTS, isFreshEvidence } = require('./live-policy.cjs');
// The launch evidence reasons that name the served model, not the availability of the route (a probe never replaces them).
const IDENTITY_FAILURES = Object.freeze(['SERVED_MODEL_MISMATCH', 'SERVED_FAMILY_MISMATCH', 'LAUNCH_SERVED_UNPROVEN']);
// The one predicate of a launch evidence that a probe can clear: a failed launch whose failure is one of availability, never one
// of identity. refresh offers and runs a re-probe on it, the gate hint names a re-probe for it, and stateAt replaces it; for an
// identity failure none of the three happens, so no client call is spent on a failure a probe cannot clear.
const probeClears = evidence => Boolean(evidence) && evidence.ok === false && !IDENTITY_FAILURES.includes(evidence.reason);
// The source a probe carries when the operator asked for it explicitly (refresh --probe --reprobe --route ID). Only such a probe
// replaces a failed launch evidence: a probe of any other invocation, the scheduled tick included, never clears a failure.
const REPROBE_SOURCE = 'refresh.cjs --probe --reprobe';

const REPO = path.join(__dirname, '..', '..');
const SCHEMA_FILE = path.join(REPO, 'docs', 'ops', 'route-state.schema.json');
const RECORD_FILE = path.join(REPO, 'docs', 'ops', 'route-state.json');

const DECLARED_FIELDS = Object.freeze(['balance', 'limit', 'plan', 'price']);
const MEASURED_FIELDS = Object.freeze(['probe', 'performance']);
const FIELD_NAMES = Object.freeze([...DECLARED_FIELDS, ...MEASURED_FIELDS]);
const BILLING_KINDS = Object.freeze(['subscription', 'api-key', 'free', 'aggregator']);

// Expiry defaults. Only declare.cjs and refresh.cjs apply them; the record always carries the exact
// moment, so a reader never has to guess how long a value was meant to live.
const DECLARED_DEFAULT_DAYS = Object.freeze({ balance: 1, limit: 1, plan: 7, price: 7 });
const PROBE_TTL_MS = 60 * 60 * 1000;
const PERFORMANCE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const OWNER_ACT_RE = /^(?:(?:PROTO-)?DEC-\d{4}|owner (?:message|answer|directive|word) \d{4}-\d{2}-\d{2})$/;
const ROUTE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CLIENT_RE = /^[a-z][a-z0-9-]{0,63}$/;

// The closed review-outcome enum (the same closed set as .ai/bin/accounting/launch-record-validate.cjs).
const OUTCOMES = Object.freeze(['PASS', 'FAIL', 'BLOCKED', 'RECOMMENDATION', 'NONE']);

// The closed placeholder list: a declared value that is one of these is not a
// value. Matched case-insensitively on the trimmed spelling, plus the empty and all-whitespace forms.
const DECLARED_PLACEHOLDERS = Object.freeze(['-', '?', 'tbd', 'n/a', 'na', 'n-a', 'unknown', 'none', 'null', 'nil', 'empty', 'pending', 'undefined', 'todo', 'not set']);

class Refusal extends Error {
  constructor(code, detail) {
    super(detail || code);
    this.name = 'Refusal';
    this.code = code;
    this.detail = detail || code;
  }
}

const isPlain = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// ---------- one string rule for the reader AND the writer ----------
//
// Every string of the record - a value, a key, a source, a reason - is data of one kind: a single line
// of visible, well-formed text. A line break, a control character, an invisible/format character or a
// lone surrogate is refused by the reader and by both writers with this one function. There is no second
// rule in declare.cjs and none in refresh.cjs: they call stringProblem, and assertRecord calls it for
// every string of a record that is about to be written.

// The decode policy of the record file (loadRecord) and of every string in it.
const RECORD_POLICY = Object.freeze({ bom: 'refuse', crlf: 'refuse', invisible: 'refuse', finalNewline: 'refuse' });
const STRING_POLICY = Object.freeze({ bom: 'refuse', crlf: 'refuse', invisible: 'refuse', finalNewline: 'report' });
const LINE_BREAK_RE = /[\n\r\u0085\u2028\u2029]/;
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

function stringProblem(value, what) {
  if (typeof value !== 'string') return `${what} is not a string`;
  for (let i = 0; i < value.length; i += 1) {
    const c = value.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && value.charCodeAt(i + 1) >= 0xdc00 && value.charCodeAt(i + 1) <= 0xdfff) { i += 1; continue; }
    if (c >= 0xd800 && c <= 0xdfff) return `${what} holds a lone surrogate at offset ${i}`;
  }
  if (LINE_BREAK_RE.test(value)) return `${what} holds a line break`;
  if (CONTROL_RE.test(value)) return `${what} holds a control character`;
  // ONE predicate for the reader and the writer. The writer's read-back decodes
  // the written bytes with STRING_POLICY, so every string is judged here by that same shared decoder
  // (textSafe.decodeText: the decode of a decoded JSON string). Whatever the read-back of the writer
  // would refuse - an NBSP (U+00A0, U+2007, U+202F), a zero-width, filler, bidi, separator or tag
  // character - the reader refuses on load with a named reason, so an escaped character can never be
  // read and then make every later write fail. The derived Default_Ignorable/Cf set
  // (isIgnorableFormat) is refused as well, on top of the decoder.
  const decoded = textSafe.decodeText(value, STRING_POLICY);
  if (!decoded.ok) {
    const first = decoded.problems[0];
    return `${what} holds ${first.code === 'NBSP' ? 'a no-break space' : 'an invisible character'} ${first.detail} (${first.code})`;
  }
  for (let i = 0; i < value.length;) {
    const cp = value.codePointAt(i);
    const width = cp > 0xffff ? 2 : 1;
    if (textSafe.isIgnorableFormat(String.fromCodePoint(cp))) {
      const hex = cp.toString(16).toUpperCase().padStart(4, '0');
      return `${what} holds an invisible character U+${hex}`;
    }
    i += width;
  }
  return null;
}

function assertCleanStrings(node, where = 'record') {
  if (typeof node === 'string') {
    const problem = stringProblem(node, where);
    if (problem) throw new Refusal('RECORD_STRING', problem);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => assertCleanStrings(item, `${where}[${i}]`));
    return;
  }
  if (isPlain(node)) {
    for (const key of Object.keys(node)) {
      const problem = stringProblem(key, `${where} key`);
      if (problem) throw new Refusal('RECORD_STRING', problem);
      assertCleanStrings(node[key], `${where}.${key}`);
    }
  }
}

function timeMs(value, what) {
  if (typeof value !== 'string' || !ISO_RE.test(value)) {
    throw new Refusal('TIME_INVALID', `${what} is not an ISO 8601 UTC time (YYYY-MM-DDTHH:MM:SS[.sss]Z)`);
  }
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) throw new Refusal('TIME_INVALID', `${what} does not name a real instant`);
  // A date such as 2026-02-31 parses with a different spelling; the record must name the instant it means.
  const canonical = new Date(ms).toISOString();
  if (canonical.slice(0, 19) !== value.slice(0, 19)) throw new Refusal('TIME_INVALID', `${what} does not name a real instant`);
  return ms;
}

function isoOf(ms) {
  return new Date(ms).toISOString();
}

function ownerActProblem(value) {
  if (typeof value !== 'string' || !value) return 'a declared field must name the owner act that declared it';
  if (!OWNER_ACT_RE.test(value)) {
    return 'declaredBy must be a decision id (DEC-nnnn or PROTO-DEC-nnnn) or "owner message|answer|directive|word YYYY-MM-DD"';
  }
  const dated = /(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dated) {
    const ms = Date.UTC(Number(dated[1]), Number(dated[2]) - 1, Number(dated[3]));
    const back = new Date(ms);
    if (!Number.isFinite(ms) || back.getUTCFullYear() !== Number(dated[1]) || back.getUTCMonth() !== Number(dated[2]) - 1 || back.getUTCDate() !== Number(dated[3])) {
      return 'the date in declaredBy is not a real calendar date';
    }
  }
  return null;
}

// ---------- the one closed value grammar ----------
//
// normalizeValue(kind, raw) is the single grammar for every value kind of the package. The reader, the
// writer and refresh --stats all call it, so a value the writer would refuse is refused by the reader
// too. A value outside a grammar is a named problem (never a silent correction):
//   outcome       the closed review-outcome enum (PASS, FAIL, BLOCKED, RECOMMENDATION, NONE)
//   isoTime       a calendar-checked ISO 8601 UTC instant
//   identifier    a non-blank, trimmed, single-line string (the route model)
//   share         a finite number between 0 and 1 (the two performance shares also sum to at most 1)
//   declaredValue a non-empty, trimmed, single-line string that is not a known placeholder
//   attribution   the model a launch record names (the identifier grammar; a placeholder is unknown)
//   launchClient  the client a launch record names (the route client grammar; a placeholder is unknown)
//   seconds       a finite number of seconds, at least 0 (a wall time)
//   tokenCount    a safe integer of at least 0 (a count of tokens)
//   exitCode      a safe integer (a process exit code; negative Windows codes included)
//   note          a non-empty string (an approximate-time note of a launch record)
//   backfilled    a boolean (null is unknown: whether the record was backfilled is not known)
//   tokens        a bare count, or a count object of the kernel token-object form: only the
//                 kernel keys, a source that is an identifier, a note that is a note, every count part a
//                 count or null; its value is the total, and an object without a total is unknown
//
// provenance is the optional third argument { record, field }: the launch record a
// value comes from and the name of its field. A backfilled record counts only for the fields whose
// confidence is exact or derived - the kernel rule accounting.usable, never a second list here. Any other
// provenance is UNKNOWN: { value: null, unknown } - never a number, never a measurement of a concrete
// model and never an invalid record. Unknown is decided before the grammar, so it is never imputed.
// The provenance itself is judged too. A backfilled flag that is not a boolean, or a confidence
// outside the kernel enum (exact, derived, inferred, unknown), is a named problem, never "usable".
function provenanceOf(provenance) {
  if (provenance === undefined) return null;
  if (!isPlain(provenance) || !isPlain(provenance.record) || typeof provenance.field !== 'string') return { problem: 'the provenance names no launch record field' };
  const { record, field } = provenance;
  if (Object.hasOwn(record, 'backfilled')) {
    const flag = normalizeValue('backfilled', record.backfilled);
    if (flag.problem) return { problem: `backfilled ${flag.problem}` };
    if (flag.unknown) return { unknown: `${field} of a record whose backfilled flag is unknown` };
  }
  if (record.backfilled === true) {
    if (!isPlain(record.confidence)) return { problem: `confidence of a backfilled record is not an object` };
    if (Object.hasOwn(record.confidence, field) && !kernel.FIELDS.confidence[0]({ [field]: record.confidence[field] })) {
      return { problem: `confidence.${field} is not one of exact, derived, inferred, unknown` };
    }
  }
  if (accounting.usable(record, field)) return null;
  const confidence = typeof record.confidence[field] === 'string' ? record.confidence[field] : 'no';
  return { unknown: `${field} of a backfilled record has ${confidence} confidence, not exact or derived` };
}

// The kernel token-object form (launch-record-validate.cjs, TOKEN_KEYS and tokensProblems): five count
// parts, the total, the source and an optional note.
const TOKEN_PARTS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning']);
const TOKEN_OBJECT_KEYS = Object.freeze([...TOKEN_PARTS, 'total', 'source', 'note']);

function tokensValue(raw) {
  if (typeof raw === 'number') return normalizeValue('tokenCount', raw);
  if (!isPlain(raw)) return { problem: 'is neither a count nor a count object' };
  const extra = Object.keys(raw).filter(key => !TOKEN_OBJECT_KEYS.includes(key));
  if (extra.length) return { problem: `is a count object with ${extra.length} key(s) outside the kernel token-object form` };
  if (!Object.hasOwn(raw, 'source')) return { problem: 'is a count object that names no source (kernel token-object rule)' };
  const source = normalizeValue('identifier', raw.source);
  if (source.problem) return { problem: `source ${source.problem}` };
  if (Object.hasOwn(raw, 'note')) {
    const note = normalizeValue('note', raw.note);
    if (note.problem) return { problem: `note ${note.problem}` };
  }
  for (const key of TOKEN_PARTS) {
    if (!Object.hasOwn(raw, key) || raw[key] === null) continue;
    const part = normalizeValue('tokenCount', raw[key]);
    if (part.problem) return { problem: `${key} ${part.problem}` };
  }
  if (!Object.hasOwn(raw, 'total') || raw.total === null) return { value: null, unknown: 'the count object names no total' };
  const total = normalizeValue('tokenCount', raw.total);
  if (total.problem) return { problem: `total ${total.problem}` };
  return total;
}

// The stored maximum of a performance number. The schema of the stored record is its one source, so an
// input number above it is refused by the one normalization with a named reason instead of aborting
// the whole write later. The schema maximum itself stays for the stored record.
function storedMaximum(key) {
  const defs = loadSchema().$defs;
  const node = isPlain(defs) && isPlain(defs.measuredPerformance) && isPlain(defs.measuredPerformance.properties)
    && isPlain(defs.measuredPerformance.properties.value) && isPlain(defs.measuredPerformance.properties.value.properties)
    ? defs.measuredPerformance.properties.value.properties[key] : null;
  if (!isPlain(node) || typeof node.maximum !== 'number') throw new Refusal('SCHEMA_SHAPE', `the schema names no maximum for performance.${key}`);
  return node.maximum;
}

function normalizeValue(kind, raw, provenance) {
  const origin = provenanceOf(provenance);
  if (origin && origin.problem) return { problem: origin.problem };
  if (origin) return { value: null, unknown: origin.unknown };
  switch (kind) {
    case 'exitCode': {
      if (!Number.isSafeInteger(raw)) return { problem: 'is not a whole exit code' };
      return { value: raw };
    }
    case 'note': {
      if (typeof raw !== 'string' || raw.length === 0) return { problem: 'is not a non-empty string' };
      return { value: raw };
    }
    case 'backfilled': {
      if (raw === null) return { value: null, unknown: 'the backfilled flag is null' };
      if (typeof raw !== 'boolean') return { problem: 'is not a boolean' };
      return { value: raw };
    }
    case 'tokens':
      return tokensValue(raw);
    case 'attribution':
      // A launch record that names a placeholder model ("n/a", "unknown") says the model is not
      // known; that is an unknown attribution, never a concrete model and never a corrupted record.
      if (typeof raw === 'string' && DECLARED_PLACEHOLDERS.includes(raw.trim().toLowerCase())) return { value: null, unknown: 'names a placeholder, not a client or model' };
      return normalizeValue('identifier', raw);
    case 'launchClient': {
      // The client a launch record names is a client name (the grammar of a route client);
      // a placeholder is unknown, as for the model.
      if (typeof raw === 'string' && DECLARED_PLACEHOLDERS.includes(raw.trim().toLowerCase())) return { value: null, unknown: 'names a placeholder, not a client' };
      if (typeof raw !== 'string' || !CLIENT_RE.test(raw)) return { problem: 'is not a client name' };
      return { value: raw };
    }
    case 'outcome': {
      if (typeof raw !== 'string' || !OUTCOMES.includes(raw)) {
        // A foreign value is never converted or echoed: a string is shown cut to 40 characters, anything else by its type.
        const shown = typeof raw === 'string' ? JSON.stringify(raw.slice(0, 40)) : `a ${raw === null ? 'null' : Array.isArray(raw) ? 'array' : typeof raw} value`;
        return { problem: `${shown} is not a review outcome (PASS, FAIL, BLOCKED, RECOMMENDATION, NONE)` };
      }
      return { value: raw };
    }
    case 'isoTime': {
      try { return { value: timeMs(raw, 'the time') }; } catch (e) { return { problem: e.detail || 'is not a real instant' }; }
    }
    case 'identifier': {
      if (typeof raw !== 'string') return { problem: 'is not a string' };
      if (raw.length === 0) return { problem: 'is empty' };
      if (raw.trim() === '') return { problem: 'is whitespace' };
      if (raw !== raw.trim()) return { problem: 'has leading or trailing whitespace' };
      // A placeholder ("unknown", "n/a", ...) names nothing, so it is no identifier.
      if (DECLARED_PLACEHOLDERS.includes(raw.toLowerCase())) return { problem: `"${raw}" is a placeholder, not a value` };
      const stringIssue = stringProblem(raw, 'an identifier');
      if (stringIssue) return { problem: stringIssue };
      return { value: raw };
    }
    case 'seconds': {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0) return { problem: 'is not a finite number of seconds of at least 0' };
      const max = storedMaximum('wallP50');
      if (raw > max) return { problem: `is above the stored maximum of ${max} seconds` };
      return { value: raw };
    }
    case 'tokenCount': {
      if (!Number.isSafeInteger(raw) || raw < 0) return { problem: 'is not a whole count of tokens of at least 0' };
      const max = storedMaximum('tokens');
      if (raw > max) return { problem: `is above the stored maximum of ${max} tokens` };
      return { value: raw };
    }
    case 'share': {
      if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) return { problem: 'is not a share between 0 and 1' };
      return { value: raw };
    }
    case 'declaredValue': {
      if (typeof raw !== 'string') return { problem: 'is not a string' };
      if (raw.length === 0) return { problem: 'is empty' };
      const trimmed = raw.trim();
      if (trimmed === '') return { problem: 'is whitespace' };
      if (DECLARED_PLACEHOLDERS.includes(trimmed.toLowerCase())) return { problem: `"${trimmed}" is a placeholder, not a value` };
      const stringIssue = stringProblem(raw, 'a declared value');
      if (stringIssue) return { problem: stringIssue };
      return { value: raw };
    }
    default:
      return { problem: `unknown value kind ${String(kind).slice(0, 40)}` };
  }
}

// ---------- canonical numbers ----------

// Number tokens of a text, skipping string contents (escaped quotes included). JSON syntax itself is
// judged by JSON.parse; this scanner only has to find every number token of a valid JSON text.
function numberTokens(text) {
  const out = [];
  for (let i = 0; i < text.length;) {
    const ch = text[i];
    if (ch === '"') {
      i += 1;
      while (i < text.length) {
        if (text[i] === '\\') { i += 2; continue; }
        if (text[i] === '"') { i += 1; break; }
        i += 1;
      }
      continue;
    }
    if (ch === '-' || (ch >= '0' && ch <= '9')) {
      const start = i;
      if (text[i] === '-') i += 1;
      while (text[i] >= '0' && text[i] <= '9') i += 1;
      if (text[i] === '.') { i += 1; while (text[i] >= '0' && text[i] <= '9') i += 1; }
      if (text[i] === 'e' || text[i] === 'E') {
        i += 1;
        if (text[i] === '+' || text[i] === '-') i += 1;
        while (text[i] >= '0' && text[i] <= '9') i += 1;
      }
      out.push({ token: text.slice(start, i), index: start });
      continue;
    }
    i += 1;
  }
  return out;
}

function assertCanonicalNumbers(text) {
  for (const { token, index } of numberTokens(text)) {
    const value = Number(token);
    if (!Number.isFinite(value)) throw new Refusal('RECORD_NUMBER', `number at offset ${index} is not finite`);
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new Refusal('RECORD_NUMBER', `integer at offset ${index} is outside the safe integer range`);
    }
    if (JSON.stringify(value) !== token) {
      throw new Refusal('RECORD_NUMBER', `number token ${JSON.stringify(token).slice(0, 40)} at offset ${index} is not its canonical JSON spelling`);
    }
  }
}

// ---------- the JSON Schema subset ----------

function typeMatches(value, type) {
  switch (type) {
    case 'null': return value === null;
    case 'object': return isPlain(value);
    case 'array': return Array.isArray(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'integer': return Number.isInteger(value);
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    default: return false;
  }
}

const sameValue = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function resolveRef(ref, root) {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) return null;
  let node = root;
  for (const raw of ref.slice(2).split('/')) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isPlain(node) || !Object.hasOwn(node, key)) return null;
    node = node[key];
  }
  return node;
}

// Returns a list of { code, path, detail }; an empty list accepts the value.
function validateSchema(value, schema, root, where) {
  if (!isPlain(schema)) return [{ code: 'SCHEMA', path: where, detail: 'the schema node is not an object' }];
  if (Object.hasOwn(schema, '$ref')) {
    const target = resolveRef(schema.$ref, root);
    if (!target) return [{ code: 'REF', path: where, detail: `unresolvable $ref ${String(schema.$ref).slice(0, 80)}` }];
    return validateSchema(value, target, root, where);
  }
  const problems = [];
  const push = (code, detail) => problems.push({ code, path: where || 'record', detail });
  if (Object.hasOwn(schema, 'type')) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some(type => typeMatches(value, type))) {
      push('TYPE', `expected ${types.join(' | ')}`);
      return problems;
    }
  }
  if (Object.hasOwn(schema, 'const') && !sameValue(value, schema.const)) push('CONST', `expected ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some(item => sameValue(value, item))) {
    push('ENUM', `one of ${JSON.stringify(schema.enum)}`);
  }
  if (typeof value === 'string') {
    if (Number.isInteger(schema.minLength) && value.length < schema.minLength) push('MIN_LENGTH', `at least ${schema.minLength} characters`);
    if (Number.isInteger(schema.maxLength) && value.length > schema.maxLength) push('MAX_LENGTH', `at most ${schema.maxLength} characters`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern).test(value)) push('PATTERN', 'does not match the declared form');
  }
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) push('MINIMUM', `at least ${schema.minimum}`);
    if (typeof schema.maximum === 'number' && value > schema.maximum) push('MAXIMUM', `at most ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (Number.isInteger(schema.minItems) && value.length < schema.minItems) push('MIN_ITEMS', `at least ${schema.minItems} items`);
    if (Number.isInteger(schema.maxItems) && value.length > schema.maxItems) push('MAX_ITEMS', `at most ${schema.maxItems} items`);
    if (schema.items) {
      value.forEach((item, i) => problems.push(...validateSchema(item, schema.items, root, `${where}[${i}]`)));
    }
  }
  if (isPlain(value)) {
    for (const key of Array.isArray(schema.required) ? schema.required : []) {
      if (!Object.hasOwn(value, key)) problems.push({ code: 'REQUIRED', path: `${where}.${key}`, detail: 'missing key' });
    }
    const props = isPlain(schema.properties) ? schema.properties : {};
    for (const key of Object.keys(value)) {
      if (Object.hasOwn(props, key)) {
        problems.push(...validateSchema(value[key], props[key], root, `${where}.${key}`));
      } else if (schema.additionalProperties === false) {
        push('ADDITIONAL', `undeclared key ${JSON.stringify(key)}`);
      }
    }
  }
  return problems;
}

// ---------- reading ----------

let cachedSchema = null;

function loadSchema(file = SCHEMA_FILE) {
  if (file === SCHEMA_FILE && cachedSchema) return cachedSchema;
  const abs = path.resolve(file);
  const guarded = pathSafe.readFileGuarded(path.parse(abs).root, abs);
  if (!guarded.ok) throw new Refusal('SCHEMA_UNREADABLE', `${guarded.reason}: ${guarded.detail}`);
  const decoded = textSafe.decode(guarded.bytes, { bom: 'refuse', crlf: 'refuse', invisible: 'refuse', finalNewline: 'refuse' });
  if (!decoded.ok) throw new Refusal('SCHEMA_ENCODING', decoded.problems.map(p => p.code).join(','));
  let schema;
  try {
    schema = textSafe.parseJsonUnique(decoded.text);
  } catch (e) {
    throw new Refusal('SCHEMA_JSON', e.code === 'JSON_DUPLICATE_KEY' ? 'a key appears twice in one object' : 'not valid JSON');
  }
  if (!isPlain(schema)) throw new Refusal('SCHEMA_JSON', 'the schema must be an object');
  if (file === SCHEMA_FILE) cachedSchema = schema;
  return schema;
}

// The semantic checks that a JSON Schema subset cannot express. Each is a named refusal of the whole
// record, never a silent correction.
function assertRecord(obj, schema) {
  if (!isPlain(obj)) throw new Refusal('RECORD_SCHEMA', 'the top level must be an object');
  const problems = validateSchema(obj, schema, schema, 'record');
  if (problems.length) {
    const first = problems[0];
    throw new Refusal('RECORD_SCHEMA', `${first.code} at ${first.path}: ${first.detail}`);
  }
  assertCleanStrings(obj);
  const generatedNorm = normalizeValue('isoTime', obj.generatedAt);
  if (generatedNorm.problem) throw new Refusal('RECORD_TIME', `generatedAt: ${generatedNorm.problem}`);
  // The coverage marker (PROTO-DEC-0240 item 2): who recorded that every route in use has a row, and when.
  if (obj.coverage !== undefined) {
    const byNorm = normalizeValue('identifier', obj.coverage.recordedBy);
    if (byNorm.problem) throw new Refusal('RECORD_VALUE', `coverage.recordedBy: ${byNorm.problem}`);
    const atNorm = normalizeValue('isoTime', obj.coverage.recordedAt);
    if (atNorm.problem) throw new Refusal('RECORD_TIME', `coverage.recordedAt: ${atNorm.problem}`);
  }
  const ids = new Set();
  obj.routes.forEach((route, i) => {
    if (!ROUTE_ID_RE.test(route.id)) throw new Refusal('RECORD_SCHEMA', `routes[${i}].id is not a route id`);
    if (ids.has(route.id)) throw new Refusal('RECORD_SCHEMA', `two routes with id ${route.id}`);
    ids.add(route.id);
    if (!CLIENT_RE.test(route.client)) throw new Refusal('RECORD_SCHEMA', `routes[${i}].client is not a client key`);
    const modelNorm = normalizeValue('identifier', route.model);
    if (modelNorm.problem) throw new Refusal('RECORD_VALUE', `routes[${i}].model: ${modelNorm.problem}`);
    if (new Set(route.requiredDeclared).size !== route.requiredDeclared.length) {
      throw new Refusal('RECORD_SCHEMA', `${route.id}.requiredDeclared names one field twice`);
    }
    for (const fieldName of Object.keys(route.fields)) {
      const field = route.fields[fieldName];
      const start = field.tag === 'declared' ? field.declaredAt : field.measuredAt;
      const startMs = timeMs(start, `${route.id}.${fieldName}.${field.tag === 'declared' ? 'declaredAt' : 'measuredAt'}`);
      const endMs = timeMs(field.expiresAt, `${route.id}.${fieldName}.expiresAt`);
      if (endMs <= startMs) throw new Refusal('RECORD_TIME_ORDER', `${route.id}.${fieldName}: expiresAt is not later than the moment it was written`);
      const sourceNorm = normalizeValue('identifier', field.source);
      if (sourceNorm.problem) throw new Refusal('RECORD_VALUE', `${route.id}.${fieldName}.source: ${sourceNorm.problem}`);
      if (field.tag === 'declared') {
        const problem = ownerActProblem(field.declaredBy);
        if (problem) throw new Refusal('RECORD_OWNER_ACT', `${route.id}.${fieldName}: ${problem}`);
        const valueNorm = normalizeValue('declaredValue', field.value);
        if (valueNorm.problem) throw new Refusal('RECORD_VALUE', `${route.id}.${fieldName}.value: ${valueNorm.problem}`);
      }
      if (fieldName === 'probe') {
        const value = field.value;
        const atMs = timeMs(value.at, `${route.id}.probe.value.at`);
        if (atMs !== timeMs(field.measuredAt, `${route.id}.probe.measuredAt`)) {
          throw new Refusal('RECORD_PROBE_TIME', `${route.id}.probe: value.at is not the envelope's measuredAt`);
        }
        if (value.ok === true && value.reason !== null) throw new Refusal('RECORD_PROBE_SHAPE', `${route.id}.probe: an ok probe carries no reason`);
        if (value.ok === false && typeof value.reason !== 'string') throw new Refusal('RECORD_PROBE_SHAPE', `${route.id}.probe: a failed probe must carry a named reason`);
        if (value.warning && value.ok !== true) throw new Refusal('RECORD_PROBE_SHAPE', `${route.id}.probe: a completion warning requires an answer`);
        // Sources stay paired. Proxy mismatches are retained for certification;
        // launch-command can only identify the exact first-party route model.
        const hasServed = Object.hasOwn(value, 'served'); const hasSource = Object.hasOwn(value, 'servedSource');
        if (hasServed !== hasSource) throw new Refusal('RECORD_PROBE_SERVED', `${route.id}.probe: served and servedSource are written together`);
        if (hasServed) {
          if ((value.served === null) !== (value.servedSource === 'none')) throw new Refusal('RECORD_PROBE_SERVED', `${route.id}.probe: served is null exactly when servedSource is none`);
          if (value.servedSource === 'launch-command' && (!identity.firstParty(route) || value.served !== route.model)) {
            throw new Refusal('RECORD_PROBE_SERVED', `${route.id}.probe: launch-command is restricted to the first-party route model`);
          }
        }
      }
      if (fieldName === 'performance') {
        const value = field.value;
        for (const key of ['verdictShare', 'noVerdictShare']) {
          const shareNorm = normalizeValue('share', value[key]);
          if (value[key] !== null && shareNorm.problem) throw new Refusal('RECORD_PERFORMANCE', `${route.id}.performance.${key}: ${shareNorm.problem}`);
        }
        if (value.verdictShare !== null && value.noVerdictShare !== null && value.verdictShare + value.noVerdictShare > 1) {
          throw new Refusal('RECORD_PERFORMANCE', `${route.id}.performance: verdictShare and noVerdictShare sum to more than 1`);
        }
      }
    }
  });
  return obj;
}

function readRecordText(text, schema = loadSchema()) {
  if (typeof text !== 'string') throw new Refusal('RECORD_JSON', 'the reader takes decoded text');
  assertCanonicalNumbers(text);
  let obj;
  try {
    obj = textSafe.parseJsonUnique(text);
  } catch (e) {
    throw new Refusal(e.code === 'JSON_DUPLICATE_KEY' ? 'RECORD_DUPLICATE_KEY' : 'RECORD_JSON', e.code === 'JSON_DUPLICATE_KEY' ? 'a key appears twice in one object' : 'not valid JSON');
  }
  return assertRecord(obj, schema);
}

function loadCommittedRecord(file = RECORD_FILE, opts = {}) {
  const schema = opts.schema || loadSchema(opts.schemaFile);
  const abs = path.resolve(file);
  const guarded = pathSafe.readFileGuarded(path.parse(abs).root, abs);
  if (!guarded.ok) throw new Refusal('RECORD_UNREADABLE', `${guarded.reason}: ${guarded.detail}`);
  const decoded = textSafe.decode(guarded.bytes, RECORD_POLICY);
  if (!decoded.ok) throw new Refusal('RECORD_ENCODING', decoded.problems.map(p => p.code).join(','));
  return readRecordText(decoded.text, schema);
}

// A local snapshot uses the SAME grammar, but contributes fields only. Metadata and
// coverage always come from Git. A newer expired/future field masks older facts:
// stateAt, not the merger, decides freshness (and never revives an older value).
function localRecordFile(file = RECORD_FILE) {
  const abs = path.resolve(file);
  return abs.endsWith('.json') ? `${abs.slice(0, -5)}.local.json` : `${abs}.local.json`;
}

function sameRoute(a, b) {
  return a.id === b.id && a.client === b.client && a.model === b.model && a.billing === b.billing;
}

const fieldTime = field => timeMs(field.tag === 'declared' ? field.declaredAt : field.measuredAt, 'field time');

function preferProbe(candidate, current) {
  if (!current) return true;
  if (candidate.source === 'launch-journal' && current.source !== 'launch-journal' && timeMs(candidate.expiresAt, 'launch expiry') > fieldTime(current)) return true;
  if (current.source === 'launch-journal' && candidate.source !== 'launch-journal' && timeMs(current.expiresAt, 'launch expiry') > fieldTime(candidate)) return false;
  return fieldTime(candidate) >= fieldTime(current);
}

function mergeLocal(record, local) {
  const merged = structuredClone(record);
  for (const route of merged.routes) {
    const saved = local.routes.find(item => sameRoute(route, item));
    if (!saved) continue;
    for (const [name, field] of Object.entries(saved.fields)) {
      if (name === 'probe' ? preferProbe(field, route.fields[name]) : !route.fields[name] || fieldTime(field) >= fieldTime(route.fields[name])) {
        route.fields[name] = structuredClone(field);
      }
    }
  }
  return merged;
}

function loadRecord(file = RECORD_FILE, opts = {}) {
  const record = loadCommittedRecord(file, opts);
  const localFile = localRecordFile(file);
  // Discover the optional sibling in the already-read source directory. Hosts
  // without an overlay keep their original fixed-source read boundary. Directory
  // entries include dangling links; an existing entry still goes through the
  // guarded reader and cannot turn an unsafe local record into a seed fallback.
  let names;
  try { names = fs.readdirSync(path.dirname(localFile)); } catch {
    throw new Refusal('RECORD_UNREADABLE', 'local route state cannot be inspected');
  }
  const key = name => process.platform === 'win32' ? name.toLowerCase() : name;
  if (!names.some(name => key(name) === key(path.basename(localFile)))) return record;
  return mergeLocal(record, loadCommittedRecord(localFile, opts));
}

function writeLocalRecord(record, file = RECORD_FILE, deps = {}) {
  return writeRecord(record, localRecordFile(file), deps);
}

// Called BEFORE checkout/ref advancement. Preserve the exact envelopes, including
// expired tombstones, and report live owner declarations an incoming tree differs
// from. No value or owner text is printed. Missing route-state in legacy repos is OK.
function preserveForUpdate(file, incomingText, now = isoOf(Date.now()), report = line => process.stderr.write(`${line}\n`)) {
  if (!fs.existsSync(file)) return [];
  const incoming = readRecordText(incomingText);
  return withRecordLock(localRecordFile(file), () => {
    const current = loadRecord(file);
    const nowMs = timeMs(now, 'now');
    const changes = [];
    for (const route of current.routes) {
      const next = incoming.routes.find(item => sameRoute(route, item));
      for (const name of DECLARED_FIELDS) {
        const field = route.fields[name];
        if (!field || !fieldView(field, nowMs).effective) continue;
        if (JSON.stringify(field) !== JSON.stringify(next && next.fields[name])) changes.push(`${route.id}:${name}`);
      }
    }
    writeLocalRecord(current, file);
    for (const item of changes) report(`ROUTE-STATE-PRESERVED live-declaration=${item} local-overlay=retained`);
    return changes;
  });
}

// ---------- the pure state function ----------

function fieldView(field, nowMs) {
  const start = field.tag === 'declared' ? field.declaredAt : field.measuredAt;
  const startMs = timeMs(start, 'field start');
  const endMs = timeMs(field.expiresAt, 'field expiry');
  const future = startMs > nowMs;
  const expired = endMs <= nowMs;
  return {
    tag: field.tag,
    effective: !future && !expired,
    future,
    expired,
    value: !future && !expired ? field.value : null,
    start,
    expiresAt: field.expiresAt,
  };
}

// Pure: nothing in here reads the clock, the file system or the environment. `now` must be an ISO
// string (the caller's time), and the answer for the same (record, now) is always the same.
function stateAt(record, now, opts = {}) {
  const nowMs = timeMs(now, 'now');
  // The launch list is absent (not read) or the joined launch objects of launch-evidence; any other value is a named
  // refusal before a reader dereferences it.
  if (opts.launches !== undefined && opts.launches !== null && (!Array.isArray(opts.launches) || !opts.launches.every(isPlain))) {
    throw new Refusal('LAUNCHES_INVALID', 'launches must be a list of joined launch objects');
  }
  const routes = record.routes.map(route => {
    const fields = {};
    for (const name of Object.keys(route.fields).sort()) fields[name] = fieldView(route.fields[name], nowMs);
    const reasons = [];
    for (const name of route.requiredDeclared) {
      const view = fields[name];
      if (!view) reasons.push(`DECLARED_MISSING:${name}`);
      else if (view.future) reasons.push(`DECLARED_FUTURE:${name}`);
      else if (view.expired) reasons.push(`DECLARED_EXPIRED:${name}`);
    }
    // Only requiredDeclared decides availability. An optional declared field that is
    // expired or dated in the future is informational: its value is null in the fields view above, but it
    // neither changes the state nor adds a reason.
    // Availability is computed, never persisted as an owner declaration. The
    // caller reads launch records once; this function remains deterministic.
    const live = require('./launch-evidence.cjs');
    const launch = live.latestEvidence(opts.launches || [], route, nowMs, opts);
    const recentLaunch = launch || live.hasRecentLaunch(opts.launches || [], route, nowMs);
    const rawProbe = route.fields.probe;
    const probe = fields.probe;
    const advice = opts.purpose === 'advice';
    const probeAt = rawProbe ? timeMs(rawProbe.measuredAt, 'probe time') : NaN;
    const scarce = SCARCE_CLIENTS.includes(route.client);
    const measured = rawProbe ? {
      source: 'probe', basis: 'probe', at: rawProbe.measuredAt,
      expiresAt: isoOf(advice ? probeAt + LIVE_TTL_MS : timeMs(rawProbe.expiresAt, 'probe expiry')),
      servedModel: (live.PROOF_SOURCES.includes(rawProbe.value.servedSource) || (live.firstParty(route) && rawProbe.value.servedSource === 'launcher-model')) ? rawProbe.value.served || null : null, ok: rawProbe.value.ok,
    } : null;
    const measuredFresh = Boolean(measured) && (advice ? isFreshEvidence(measured, nowMs) : probe.effective);
    // A fresh ok probe of the explicit re-probe (REPROBE_SOURCE), measured AFTER the newest launch evidence, when that evidence failed
    // on availability (probeClears), replaces it: that is how a route recovers inside the launch window, on the operator's word only.
    // This is the only place a probe counts for a scarce route; an ok launch is never replaced, a failed probe never replaces
    // anything, and a probe of any other invocation (the scheduled tick included) never clears a failure. A probe proves that the
    // route answers, not which model served it: a launch that failed on identity (a proven other model, an unproven served model of a
    // certifying read) is never replaced by a probe.
    const replacesFailedLaunch = probeClears(launch) && rawProbe?.source === REPROBE_SOURCE && measuredFresh
      && rawProbe.value.ok === true && probeAt > timeMs(launch.at, 'launch time');
    // A launch that ended unknown (no proven answer, no provider or identity failure class) proves nothing, so a fresh probe
    // measured after it decides the route, ok or failed; for a scarce route only the explicit re-probe counts, as above.
    const replacesUnknownLaunch = launch?.unknown === true && measuredFresh && probeAt > timeMs(launch.at, 'launch time')
      && (!scarce || rawProbe?.source === REPROBE_SOURCE);
    const probeEvidence = measured && (!scarce || replacesFailedLaunch || replacesUnknownLaunch) ? measured : null;
    const freshProbe = probeEvidence && measuredFresh;
    // Real seats are primary. Probes fill only routes without a recent launch,
    // including when a newer probe would otherwise hide a real seat's failure.
    const evidence = replacesFailedLaunch || replacesUnknownLaunch ? probeEvidence : launch || (!recentLaunch && freshProbe ? probeEvidence : null);
    let failed = false;
    if (evidence?.source === 'launch') {
      if (!evidence.ok) {
        reasons.push(evidence.reason.startsWith('LAUNCH_') ? evidence.reason : `LAUNCH_${evidence.reason}`);
        // Only a provider or identity failure class closes a route; an end without a proven answer is unknown, named.
        failed = live.FAILURES.includes(evidence.reason);
      }
    } else if (replacesFailedLaunch) {
      // the fresh ok probe stands for the route; it adds no reason
    } else if (replacesUnknownLaunch) {
      if (rawProbe.value.ok !== true && rawProbe.value.reason === 'TIMEOUT') reasons.push('PROBE_TIMEOUT');
      else if (rawProbe.value.ok !== true) {
        failed = true;
        reasons.push(`PROBE_FAILED:${rawProbe.value.reason}`);
      }
    } else if (recentLaunch) reasons.push('LAUNCH_PENDING');
    // A scarce route is known only from a real launch. A caller that read the launch records and found
    // none fresh sees LAUNCH_MISSING; a caller that gave no launch list sees LAUNCH_NOT_READ, never a
    // claim that no launch exists. Both stay unknown.
    else if (SCARCE_CLIENTS.includes(route.client)) reasons.push(Array.isArray(opts.launches) ? 'LAUNCH_MISSING' : 'LAUNCH_NOT_READ');
    else if (!probe) reasons.push('PROBE_MISSING');
    else if (probe.future) reasons.push('PROBE_FUTURE');
    else if (!freshProbe) reasons.push('PROBE_EXPIRED');
    else if (rawProbe.value.ok !== true && rawProbe.value.reason === 'TIMEOUT') reasons.push('PROBE_TIMEOUT');
    else if (rawProbe.value.ok !== true && rawProbe.value.reason === 'QUOTA_EXHAUSTED') reasons.push('PROBE_QUOTA_EXHAUSTED');
    else if (rawProbe.value.ok !== true) {
      failed = true;
      reasons.push(`PROBE_FAILED:${rawProbe.value.reason}`);
    }
    // One identity rule for both kinds of evidence (launch-identity certificationProblem): a probe's own value, or the
    // problem evidenceOf found in an answered launch's own proof. A certifying launch is already refused by its evidence
    // reason; in every other purpose the problem is a warning, and identityProven is false in every purpose.
    const probeProblem = evidence?.source === 'probe' && rawProbe.value.ok === true ? identity.certificationProblem(route, rawProbe.value) : null;
    const certificationProblem = evidence?.source === 'launch' ? evidence.identityProblem || null : probeProblem;
    const certifying = opts.purpose === 'certification' || opts.role === 'certifier';
    if (certifying && probeProblem) reasons.push(probeProblem);
    const unique = [...new Set(reasons)];
    const state = failed ? 'failed' : unique.length ? 'unknown' : 'ok';
    return { id: route.id, state, reasons: unique, fields, evidence,
      warnings: [...(evidence?.warnings || []),
        ...(evidence?.source === 'probe' && rawProbe.value.warning ? [rawProbe.value.warning] : []),
        ...(!certifying && certificationProblem ? [certificationProblem] : [])],
      certification: { identityProven: state === 'ok' && !certificationProblem, reason: certificationProblem },
      identityBasis: evidence?.source === 'launch' ? evidence.basis : evidence && live.PROOF_SOURCES.includes(rawProbe.value.servedSource) ? rawProbe.value.servedSource
        : identity.firstParty(route) ? 'launch-command' : evidence ? rawProbe.value.servedSource || 'none' : 'none' };
  });
  return { at: isoOf(nowMs), routes };
}

function stateOf(record, routeId, now, opts = {}) {
  const result = stateAt(record, now, opts);
  const row = result.routes.find(item => item.id === routeId);
  if (!row) throw new Refusal('ROUTE_UNKNOWN', `no route with id ${routeId}`);
  return row;
}

// ---------- guarded writers ----------

function routeOf(record, routeId) {
  const route = record.routes.find(item => item.id === routeId);
  if (!route) throw new Refusal('ROUTE_UNKNOWN', `no route with id ${routeId}`);
  return route;
}

function assertWritableField(fieldName, kind) {
  if (!FIELD_NAMES.includes(fieldName)) throw new Refusal('FIELD_UNKNOWN', `no field named ${fieldName}`);
  if (kind === 'declared') {
    if (MEASURED_FIELDS.includes(fieldName)) throw new Refusal('FIELD_MEASURED', `${fieldName} is a measured field; only refresh.cjs writes it`);
    if (!DECLARED_FIELDS.includes(fieldName)) throw new Refusal('FIELD_UNKNOWN', `no declared field named ${fieldName}`);
  } else {
    if (DECLARED_FIELDS.includes(fieldName)) throw new Refusal('FIELD_DECLARED', `${fieldName} is a declared field; only declare.cjs writes it`);
    if (!MEASURED_FIELDS.includes(fieldName)) throw new Refusal('FIELD_UNKNOWN', `no measured field named ${fieldName}`);
  }
}

function setDeclared(record, routeId, fieldName, spec) {
  assertWritableField(fieldName, 'declared');
  const route = routeOf(record, routeId);
  const problem = ownerActProblem(spec.declaredBy);
  if (problem) throw new Refusal('OWNER_ACT', problem);
  const valueNorm = normalizeValue('declaredValue', spec.value);
  if (valueNorm.problem) throw new Refusal('VALUE_INVALID', valueNorm.problem);
  if (spec.value.length > 600) throw new Refusal('VALUE_INVALID', 'a declared value is at most 600 characters');
  if (spec.source !== undefined) {
    const sourceNorm = normalizeValue('identifier', spec.source);
    if (sourceNorm.problem) throw new Refusal('SOURCE_INVALID', `the source ${sourceNorm.problem}`);
  }
  const declaredMs = spec.nowMs === undefined ? Date.now() : spec.nowMs;
  const declaredAt = isoOf(declaredMs);
  const days = spec.days === undefined ? DECLARED_DEFAULT_DAYS[fieldName] : spec.days;
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Refusal('DAYS_INVALID', 'days must be an integer between 1 and 3650');
  const expiresAt = isoOf(declaredMs + days * 24 * 60 * 60 * 1000);
  route.fields[fieldName] = {
    tag: 'declared',
    value: spec.value,
    declaredBy: spec.declaredBy,
    declaredAt,
    expiresAt,
    source: spec.source || 'declare.cjs',
  };
  return { field: fieldName, declaredAt, expiresAt };
}

function setMeasured(record, routeId, fieldName, value, spec = {}) {
  assertWritableField(fieldName, 'measured');
  const route = routeOf(record, routeId);
  const measuredMs = spec.nowMs === undefined ? Date.now() : spec.nowMs;
  const ttl = spec.ttlMs === undefined ? (fieldName === 'probe' ? PROBE_TTL_MS : PERFORMANCE_TTL_MS) : spec.ttlMs;
  if (!Number.isInteger(ttl) || ttl <= 0) throw new Refusal('TTL_INVALID', 'ttlMs must be a positive integer');
  route.fields[fieldName] = {
    tag: 'measured',
    value,
    measuredAt: isoOf(measuredMs),
    expiresAt: isoOf(measuredMs + ttl),
    source: spec.source || (fieldName === 'probe' ? 'refresh.cjs --probe' : 'refresh.cjs --stats'),
  };
  return { field: fieldName, measuredAt: isoOf(measuredMs), expiresAt: isoOf(measuredMs + ttl) };
}

// The strict read-back of the written record, run on the TEMPORARY file before the rename
// (one write path). A refusal by the reader, or a difference from the record about to be written, is a named
// refusal: the old record stays byte for byte and the command exits non-zero.
function verifyWritten(tempFile, schema, record) {
  let after;
  try {
    after = loadCommittedRecord(tempFile, { schema });
  } catch (e) {
    throw new Refusal('RECORD_WRITE_VERIFY', `the written record would not read back (${(e && e.code) || 'no code'})`);
  }
  if (JSON.stringify(after) !== JSON.stringify(record)) {
    throw new Refusal('RECORD_WRITE_VERIFY', 'the record read back differs from the record written');
  }
}

function writeRecord(record, file = RECORD_FILE, deps = {}) {
  const schema = deps.schema || loadSchema(deps.schemaFile);
  assertRecord(record, schema);
  const text = `${JSON.stringify(record, null, 2)}\n`;
  assertCanonicalNumbers(text);
  const abs = path.resolve(file);
  const root = path.parse(abs).root;
  const bytes = Buffer.from(text, 'utf8');
  const writer = deps.writer || ((target, data, options) => pathSafe.writeAtomicGuarded(target, data, options));
  // One write path: the serialized record is re-read from the TEMPORARY file with
  // the SAME strict reader and compared with the record, and only when they are equal does the writer
  // rename it over the record. The shared writer runs this check after the temp file is written and
  // before the rename (onTempWritten); a refusal or a difference throws, the old record stays byte for
  // byte, and the command exits non-zero with a named reason. The read-back is never done after the
  // rename, so a record the strict reader would refuse can never replace the old bytes.
  let written;
  try {
    written = writer(abs, bytes, {
      root,
      onTempWritten: ({ temp }) => verifyWritten(temp, schema, record),
    });
  } catch (e) {
    throw new Refusal('WRITE_FAILED', `the atomic writer failed (${(e && e.code) || 'no code'})`);
  }
  if (!written || written.ok !== true) {
    throw new Refusal('WRITE_FAILED', written ? `${written.reason || 'unknown'}: ${written.detail || ''}`.trim() : 'the atomic writer returned no result');
  }
  return { ok: true, path: abs, bytes: bytes.length };
}

// ---------- one writer at a time ----------

// The record is replaced atomically, but two writers that both read before either wrote would still
// lose one update. The lock is one file next to the record, created EXCLUSIVELY (open 'wx'), held for
// the whole read-modify-write and released in a finally. A holder that dies leaves the file behind: a
// lock older than LOCK_STALE_MS is treated as abandoned and removed once, then the wait continues. The
// wait is bounded; running out is a named refusal, never a silent last-write-wins.
const LOCK_WAIT_MS = 10000;
const LOCK_POLL_MS = 25;
const LOCK_STALE_MS = 60000;
const SLEEP_CELL = new Int32Array(new SharedArrayBuffer(4));

function sleepSync(ms) {
  Atomics.wait(SLEEP_CELL, 0, 0, ms);
}

function withRecordLock(file, fn, opts = {}) {
  const target = path.resolve(file);
  // CLASS 3: the record path is proven (a real path not through a link) BEFORE any
  // file is created, so the lock can never be written through a junction the guarded read would refuse.
  const volumeRoot = path.parse(target).root;
  const guard = pathSafe.realInside(volumeRoot, target, { refuseHardlinks: true });
  if (!guard.ok) throw new Refusal('RECORD_UNREADABLE', `the record path is not safe: ${guard.reason}: ${guard.detail}`);
  const lockFile = `${guard.real}.lock`;
  const waitMs = Number.isInteger(opts.waitMs) && opts.waitMs >= 0 ? opts.waitMs : LOCK_WAIT_MS;
  const deadline = Date.now() + waitMs;
  let handle = null;
  for (;;) {
    try {
      handle = fs.openSync(lockFile, 'wx');
      break;
    } catch (e) {
      if (!e || e.code !== 'EEXIST') throw new Refusal('LOCK_FAILED', `the write lock could not be created (${(e && e.code) || 'no code'})`);
      // M07: an existing lock path must be a regular file, never a directory or a link; those are
      // refused, never waited on.
      let st = null;
      try { st = fs.lstatSync(lockFile); } catch { /* the holder released it */ }
      if (st !== null && (!st.isFile() || st.isSymbolicLink())) {
        throw new Refusal('LOCK_FAILED', `the lock path ${path.basename(lockFile)} is ${st.isDirectory() ? 'a directory' : 'a link'}, never waited on`);
      }
      // The deadline is checked on EVERY loop pass, including this failure branch.
      if (Date.now() >= deadline) throw new Refusal('LOCK_TIMEOUT', `another writer holds ${path.basename(lockFile)}`);
      if (st !== null && Date.now() - st.mtimeMs > LOCK_STALE_MS) {
        try { fs.unlinkSync(lockFile); } catch { /* another waiter won */ }
        continue;
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
  try {
    fs.writeSync(handle, JSON.stringify({ pid: process.pid, at: isoOf(Date.now()) }));
    return fn();
  } finally {
    try { fs.closeSync(handle); } catch { /* already closed */ }
    try { fs.unlinkSync(lockFile); } catch { /* already released */ }
  }
}

// ---------- a path flag, judged before it is resolved ----------

// path.resolve hides a ".." segment before the shared guard sees the spelling, so a path that walks out
// and back in passed the guard. The raw spelling is checked here, before any resolution, for every path
// flag of both tools; a dot-dot segment is a named refusal.
function resolvePathArg(raw, name) {
  if (typeof raw !== 'string' || !raw) throw new Refusal('USAGE', `--${name} needs a path`);
  if (raw.includes('\0')) throw new Refusal('PATH_INVALID', `--${name} is malformed`);
  if (raw.split(/[\\/]+/).includes('..')) throw new Refusal('PATH_DOTDOT', `--${name} must not contain a dot-dot segment`);
  return path.resolve(raw);
}

// ---------- command line flags ----------

// A closed, small flag reader: an unknown flag, a repeated flag, a missing value and an unexpected
// positional argument are all USAGE refusals. Boolean flags must not carry "=value".
function parseFlags(argv, allowed, booleans = []) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) { out._.push(arg); continue; }
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(2, eq) : arg.slice(2);
    if (!allowed.includes(name)) throw new Refusal('USAGE', `unknown option --${name}`);
    if (Object.hasOwn(out, name)) throw new Refusal('USAGE', `--${name} given twice`);
    if (booleans.includes(name)) {
      if (eq > 0) throw new Refusal('USAGE', `--${name} takes no value`);
      out[name] = true;
      continue;
    }
    const value = eq > 0 ? arg.slice(eq + 1) : argv[++i];
    if (value === undefined) throw new Refusal('USAGE', `--${name} needs a value`);
    out[name] = value;
  }
  return out;
}

module.exports = {
  Refusal,
  REPO,
  SCHEMA_FILE,
  RECORD_FILE,
  DECLARED_FIELDS,
  MEASURED_FIELDS,
  FIELD_NAMES,
  BILLING_KINDS,
  DECLARED_DEFAULT_DAYS,
  PROBE_TTL_MS,
  PERFORMANCE_TTL_MS,
  ISO_RE,
  OUTCOMES,
  DECLARED_PLACEHOLDERS,
  TOKEN_PARTS,
  TOKEN_OBJECT_KEYS,
  normalizeValue,
  loadSchema,
  loadRecord,
  loadCommittedRecord,
  localRecordFile,
  mergeLocal,
  writeLocalRecord,
  preserveForUpdate,
  readRecordText,
  assertRecord,
  assertCanonicalNumbers,
  numberTokens,
  ownerActProblem,
  validateSchema,
  stringProblem,
  assertCleanStrings,
  stateAt,
  stateOf,
  probeClears,
  REPROBE_SOURCE,
  routeOf,
  setDeclared,
  setMeasured,
  writeRecord,
  withRecordLock,
  resolvePathArg,
  LOCK_WAIT_MS,
  LOCK_STALE_MS,
  parseFlags,
  timeMs,
  isoOf,
};

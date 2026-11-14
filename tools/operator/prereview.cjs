'use strict';
// Advisory free-model pre-review (PROTO-DEC-0206 item 2 (5); PROTO-DEC-0212 design review;
// PROTO-DEC-0216).
// Operator tooling, Class A: it sends text to external services, so the output boundary and the
// outbound scan are the guarantee surface. Every fix is a closed construction, not a check for
// one reproduction. Closed rules of the request: R1 a provider-keyed reasoning whitelist table
// with a closed key grammar and scalar values; R2 the substituted endpoint value grammar and
// the final-URL re-parse; R3 the guarded advisory-home creator, the git-scrubbed main-checkout
// root and the closed-grammar file name; R4 a review input that excludes nothing silently;
// R5 stale registry-lock recovery. Closed rules of the base and the diff: R1 the base reference is data
// (closed grammar, resolved by git rev-parse --verify --end-of-options to a full object id
// that alone is passed to git diff, before a literal --); R2 per-file diff sizes from
// per-file diffs fetched with literal paths (GIT_LITERAL_PATHSPECS=1 on every git call),
// never a pathspec match; R3 the raw endpoint string holds no question mark and no number
// sign at all; R4 every git call runs with every GIT_ variable removed (gitEnv) and the
// repository given by -C; R5 an unknown or missing provider with a non-empty reasoningParams
// refuses with the fixed code (no TypeError) and a negative or non-integer byte budget
// refuses with the fixed code. Closed rules of the change set: R1 the diff of a file is judged by
// its REAL size and completeness on BOTH sides of a rename or a deletion (the change records
// come from git diff --name-status -z and git diff --numstat -z, the per-file diff is fetched
// with the complete literal path set, a rename with a small real diff is sent in full and a
// skip is listed with its reason); R2 ONE parser for every spelling of the CLI numeric option
// --max-diff-bytes (the canonical integer of one to nine digits without a leading zero, or
// the fixed code and exit 2 - never silently ignored, never the default budget); R3 a base
// that resolves to a non-commit object (a blob or a tree) refuses with PREREVIEW-BASE; R5
// resolveBase returns the resolved commit object id, never the raw ref, and the audit-prompt
// cap counts characters of the decoded string, never splitting a surrogate pair. The git
// output rules (PROTO-DEC-0212, 0216; the review input is built from git output that the tool
// parses and decodes, so every rule is replaced by a construction that cannot go wrong):
// C1 NO RENAME PAIRS - every git call that produces review input passes --no-renames, a
// rename is a deletion plus an addition, the numstat and name-status parsers read a flat
// record list of one path per record and a path under a fixed-policy exclude is judged by
// its own path on each side; C2 NO CONFIGURED CONVERTERS - every diff call passes
// --no-textconv --no-ext-diff and the review environment sets GIT_CONFIG_NOSYSTEM=1,
// GIT_CONFIG_GLOBAL to an empty file of the tool's own temp directory and GIT_ATTR_NOSYSTEM=1;
// C3 STRICT DECODING - the diff, the stat, the -z tokens, the prompt file and the registry are
// decoded by the ONE shared strict decoder, and a file whose diff bytes are not valid UTF-8
// is listed as skipped with the reason invalid-utf8 and its size, never sent with replacement
// characters; C4 NO CHILD DIAGNOSTICS - every git child captures and discards stderr and a
// failing git call becomes a fixed named code with no child text; C5 the truncation marker is
// reserved inside the byte budget (the returned text, marker included, is at most
// --max-diff-bytes bytes, and a budget smaller than the marker drops the marker with
// truncated true). The configuration rules (PROTO-DEC-0212, 0216; git's own configuration
// must decide NOTHING about what the reviewer sees, and the tests must not share state):
// E1 every diff call passes --text together with --no-textconv --no-ext-diff --no-renames,
// so a binary attribute, a -diff attribute from any attributes file and a diff driver
// binary=true cannot hide a text file; the binary judgement is the TOOL'S OWN - a file is
// binary when its diff bytes contain a NUL byte, or when they fail the strict UTF-8 decode
//, and numstat is never the judge; the change records come from
// git diff --raw -z --no-renames (one flat record: mode, mode, oid, oid, status, path);
// E2 every diff call passes --ignore-submodules=none, so a gitlink change (mode 160000)
// is never dropped, not even with diff.ignoreSubmodules all configured: it is listed in the
// skipped list with the reason submodule and its two object ids, and the stat view and the
// skipped list account for EVERY changed path of git diff --raw -z --no-renames;
// E3 the advisory home root honors ONE documented environment override
// (PREREVIEW_ADVISORY_ROOT, an absolute path), so every test and every mutant gets its own
// temporary home instead of the shared git-derived home; the default stays the main
// checkout, and the guarded creator and the guarded path checks apply to the override too;
// E4 ONE escape function (escapeForOperator) turns every control character (Cc), every bidi
// and invisible format character (Cf), U+0085, U+2028 and U+2029 into the visible escape
// \uXXXX before a path enters the skip header or the user message, and before the model
// answer enters the advisory JSON; the lock record is read through the shared strict
// decoder, so the C3 sentence "no readFileSync with an encoding" is true;
// E5 the fixed-policy exclude compares the path after Unicode NFC normalisation and
// lower-casing, so a review path in any letter case is excluded like its lower-case spelling.
//
// G1 advisory output is DATA, not text - CLOSED by construction: the review result is written
//    as ONE JSON file .ai/runtime/prereview/<UTC-stamp>-<random>.json with the fixed fields
//    {schema:"prereview/1", advisory:true, mode:"READ-ONLY ADVISORY", verdict:null, route,
//    createdAt, answer}. The model text is the ONE JSON string value "answer"; it is never
//    written as lines of a Markdown or text file, so no CR, LF, U+2028 or any other separator
//    can start a "Verdict:" or "Mode:" line (JSON escapes CR/LF; U+2028/U+2029 are escaped too,
//    so the file bytes hold no raw separator at all). verdict is the constant null: the file
//    cannot be read as a verdict by any parser. The home is always
//    MAIN-CHECKOUT/.ai/runtime/prereview/: the main checkout found by
//    git rev-parse --git-common-dir in an environment where every GIT_* variable is removed
//    (rule R3: a hostile GIT_DIR or GIT_WORK_TREE cannot redirect it), never from a
//    caller "root" or output argument; there is no output base option at all. The home is
//    created by the guarded creator one level at a time (mkdirGuarded, the helper of
//    tools/operator/auto-retire.cjs, with the root check at every step) BEFORE any directory
//    exists outside the root: a junction at any parent refuses before a directory is created.
//    The file name is generated by the tool from a closed grammar (UTC stamp and random hex),
//    never accepted from a caller. The path is checked by the repository guarded path helpers
//    (realInside with refuseHardlinks, case-insensitive containment on Windows, every parent
//    checked, never a junction or a hardlink) and the file is created exclusively ('wx').
// G2 no secrets - CLOSED by construction:
//    (a) reasoningParams is NOT free-form: the whitelist is a table keyed by provider id (in
//        this file and in tools/operator/prereview-routes.schema.md); an unknown provider
//        refuses the route; a key must be in that provider's list (so messages, model and
//        max_tokens are never in any list), key names match /^[a-z][a-z0-9_]{0,31}$/ (no dots,
//        no nesting), and values are scalars only: a string up to 64 characters, a finite
//        number, a boolean or null. An object or array value refuses the registry (rule
//        R1), so a secret-named key cannot enter the request at all; no secret-name hunt is
//        needed. The field name is never reproduced in an error message, only its length.
//    (b) endpoint URLs are parsed with new URL: protocol https (or ${ENV_NAME} placeholders),
//        no username, no password, no query string, no fragment; a loopback http URL is valid
//        only so tests can run fake endpoints. At send time every substituted value must match
//        /^[A-Za-z0-9._-]{1,128}$/ BEFORE it enters the URL, and the FINAL URL is parsed again
//        with the URL class and must satisfy the same contract (rule R2: a question
//        mark, a hash or an at sign cannot be injected through the environment).
//    (c) the assembled body scan runs on the JSON body AND on every string value of it
//        separately, each after removing ONLY default-ignorable/format characters (\p{Cf});
//        newlines and every other character are never removed, so the scanners see the text
//        unchanged (whether a secret split from its marker by a
//        separator matches depends on each pattern's own grammar). Both
//        surfaces use the handoff scanner findSecretLeak (.ai/bin/protocol-hooks.cjs)
//        together with the shared secretIn (.ai/bin/lib/secrets.cjs).
//    (d) error reasons are fixed codes (HTTP_<status>, TIMEOUT, BAD_RESPONSE, TRUNCATED,
//        EMPTY, OVERSIZE, NO_KEY), never response text.
// G3 only proven routes - CLOSED by ONE order in review: (1) the usable() check,
//    (2) the send under a whole-request deadline (AbortSignal.timeout around fetch AND the
//    body read, redirect: 'error'), (3) the body read through a size cap (256 KiB; beyond it
//    the fixed failure OVERSIZE), (4) the registry update (failure or success) FIRST, under
//    the existing single-writer lock, (5) only then the advisory file: a failure to write the
//    advisory file never skips the registry update and never throws past it. A deadline during
//    the body read is TIMEOUT, not BAD_RESPONSE. Times are valid only when
//    new Date(t).toISOString() equals the stored value to the second, so a normalized
//    impossible date (2026-02-30) is refused. usable(route) = status 'ok' AND probe.result
//    'ok' AND a valid ISO probe time; the response is accepted only in one fixed shape
//    (choices[0].message.content a non-empty string, finish_reason 'stop', strict decode of
//    the bytes, duplicate JSON keys refused). Registry updates go through ONE writer: a mkdir
//    lock next to the registry that records its creator pid and creation time in a file inside
//    the lock; a lock older than 5 minutes whose pid is not alive is renamed aside (suffix
//    .stale, never deleted) and the update proceeds, a live or fresh lock waits and then
//    refuses with the fixed code (rule R5); a strict re-read inside the lock, only this
//    run's per-route changes, an atomic write by temp file and rename. A failing mark is never
//    overwritten except by a successful probe of that route. The review input excludes NOTHING
//    silently (rule R4): JSON files are review input; a file skipped for a stated reason
//    (binary or over the per-file cap) is listed with its reason in the payload header, and
//    the stat shows every changed file. The registry is read with the repository strict reader
//    (decode with bom/crlf/invisible refuse and parseJsonUnique).
// G4 bounded cost - CLOSED: paid routes are excluded from probe AND review unless
//    --panel paid|both (or PREREVIEW_PANEL) is given explicitly; probe accepts the same
//    selection.
// The registry stores no key values: each route names its environment variable (keyEnv) and
// the endpoint may carry ${ENV_NAME} placeholders resolved at send time.
//
// CLI:
//   node tools/operator/prereview.cjs review <worktree> <baseRef>
//        [--audit-prompt <path>] [--registry <path>] [--panel free|paid|both] [--max-diff-bytes <n>]
//   node tools/operator/prereview.cjs probe [--registry <path>] [--route <id>] [--panel free|paid|both]
//   node tools/operator/prereview.cjs list [--registry <path>] [--panel free|paid|both]
//        The review output goes to .ai/runtime/prereview/<UTC-stamp>-<random>.json of this checkout.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { secretIn } = require('../../.ai/bin/lib/secrets.cjs');
const { findSecretLeak } = require('../../.ai/bin/protocol-hooks.cjs');
const { decode, parseJsonUnique } = require('../../.ai/bin/lib/text-safe.cjs');
const { realInside, mkdirGuarded } = require('../../.ai/bin/lib/path-safe.cjs');

const SCHEMA = 'prereview-routes/1';
const ADVISORY_SCHEMA = 'prereview/1';
const ADVISORY_MODE = 'READ-ONLY ADVISORY';
const DEFAULT_REGISTRY = path.join(__dirname, 'prereview-routes.json');
const DEFAULT_PANEL = 'free';
const PANELS = ['free', 'paid', 'both'];
const STATUSES = ['unprobed', 'ok', 'failing'];
const PROBE_RESULTS = ['unprobed', 'ok', 'fail'];
const DEFAULT_MAX_DIFF_BYTES = 60000;
const FILE_MAX_DIFF_BYTES = 20000;
const AUDIT_PROMPT_MAX = 12000;
const DEFAULT_TIMEOUT_MS = 120000;
const LOCK_TIMEOUT_MS = 10000;
const STALE_LOCK_MS = 5 * 60 * 1000;
const LOCK_RECORD = 'owner.json';
const MAX_RESPONSE_BYTES = 256 * 1024;
const FAILURE_NOTE = 'The route is marked failing until a new probe of that route succeeds; an empty, truncated, oversized or malformed answer is a route failure, never "no remarks".';
const SECRET_REFUSED_REASON = 'SECRET_REFUSED: the assembled request body matched the shared secret scanner (.ai/bin/protocol-hooks.cjs findSecretLeak and .ai/bin/lib/secrets.cjs secretIn); the send for this route is refused; the matched value is not reproduced here';
// G2a (rule R1): the reasoning whitelist is a table keyed by provider id, written here
// and in tools/operator/prereview-routes.schema.md. An unknown provider refuses the route; a key
// must be in that provider's list (so messages, model and max_tokens are never in any list),
// key names match /^[a-z][a-z0-9_]{0,31}$/ (no dots, no nesting), and values are scalars only:
// a string up to 64 characters, a finite number, a boolean or null. An object or array value
// refuses the registry. Adding a field means adding it here and to the schema table in one
// change; a provider is added the same way, with an empty list when it has no fields.
const REASONING_FIELDS = {
  openrouter: ['reasoning_effort'],
  cloudflare: ['reasoning_effort', 'enable_thinking'],
  dahl: [],
  'ollama-cloud': [],
  vercel: [],
};
const REASONING_KEY = /^[a-z][a-z0-9_]{0,31}$/;
const REASONING_VALUE_MAX = 64;
const ENDPOINT_VALUE = /^[A-Za-z0-9._-]{1,128}$/;
// The base reference is DATA, never an option. The closed grammar
// never starts with a dash and holds no space, and only the object id git resolved is passed
// to git diff, after the options and before a literal --.
const BASE_REF = /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
// The ONE accepted spelling of the CLI numeric option value is the
// canonical integer: one to nine digits, no leading zero. A negative value, a zero, a leading
// zero, an exponent, a hexadecimal spelling, an empty value and a missing value all refuse.
const MAX_DIFF_BYTES_ARG = /^[1-9][0-9]{0,8}$/;
const ADVISORY_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-[0-9a-f]{10}\.json$/;
const FORMAT_CHARS = /\p{Cf}/gu;
// The ONE escape class of the operator boundary. Every control
// character (Cc, which covers CR, LF, DEL and the whole C1 range including U+0085), every
// bidi and invisible format character (Cf, which covers the directional marks and the
// zero-width characters) and the two Unicode line separators U+2028 and U+2029 become the
// visible escape \uXXXX before such text reaches the skip header, the user message or the
// advisory JSON; a raw separator or an invisible mark can never start a line a reader or a
// parser judges.
const OPERATOR_ESCAPE_CHARS = /[\p{Cc}\p{Cf}\u2028\u2029]/gu;
const PLACEHOLDER = /\$\{([A-Z][A-Z0-9_]*)\}/g;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const STRICT_REGISTRY_POLICY = { bom: 'refuse', crlf: 'refuse', invisible: 'refuse' };
const SYSTEM_PROMPT = 'You are a strict code reviewer. Find real defects only: wrong behaviour, missed cases, tests that cannot fail, claims that disagree with the code, security or privacy leaks, encoding or path bugs. For each finding give: file, line or hunk, what is wrong, a concrete input that shows it. If you find nothing real, say NO FINDINGS. Be terse.';
const PROBE_SYSTEM = 'You are a connectivity probe. Reply with OK and your model name.';
const PROBE_USER = 'probe: reply OK and your model name';

const sleepMs = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

// G3: a stored time is valid only when it round-trips through
// new Date(t).toISOString() to the second, so a normalized impossible date (2026-02-30) is
// refused instead of being silently accepted as the day Date.parse rolled it into.
function isIsoTime(value) {
  if (typeof value !== 'string' || !ISO_TIME.test(value)) return false;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return false;
  return d.toISOString().slice(0, 19) === value.slice(0, 19);
}

// G2b: the endpoint is a parsed URL, not a pattern match: https (or ${ENV_NAME} placeholders),
// no username, no password, no query string, no fragment. A loopback http URL is valid only
// so tests can run fake endpoints.
function validUrl(url) {
  if (url.username !== '' || url.password !== '') return false;
  if (url.search !== '' || url.hash !== '') return false;
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && /^(127\.0\.0\.1|localhost|\[::1\])$/.test(url.hostname);
}

function validEndpoint(endpoint) {
  if (typeof endpoint !== 'string') return false;
  // The RAW string is checked first: no question mark and no number
  // sign at all, so an empty query or an empty fragment refuses (new URL reports both as an
  // empty .search/.hash, which the parse checks alone cannot distinguish from absence).
  if (endpoint.includes('?') || endpoint.includes('#')) return false;
  const filled = endpoint.replace(PLACEHOLDER, 'placeholder.invalid');
  if (/[${}]/.test(filled)) return false;
  let url;
  try { url = new URL(filled); } catch { return false; }
  return validUrl(url);
}

function endpointError(message) {
  const e = new Error(`PREREVIEW-ENDPOINT: ${message}`);
  e.prereviewCode = 'ENDPOINT';
  return e;
}

// G2b (rule R2): every substituted value must match /^[A-Za-z0-9._-]{1,128}$/ BEFORE it
// enters the URL (so a question mark, a hash or an at sign cannot be injected through the
// environment), and a placeholder without an environment value is a refusal with a fixed code.
function resolveEndpoint(endpoint) {
  return String(endpoint).replace(PLACEHOLDER, (whole, name) => {
    const value = process.env[name];
    if (value === undefined) throw endpointError(`the ${'$'}{${name}} placeholder has no environment value`);
    if (!ENDPOINT_VALUE.test(value)) throw endpointError('an environment value does not match the endpoint value grammar ^[A-Za-z0-9._-]{1,128}$');
    return value;
  });
}

// G2b (rule R2): the FINAL URL is parsed again with the URL class after the environment
// substitution and must satisfy the same contract as the template: https (a loopback http URL
// only in tests), no username, no password, no query, no fragment.
function finalEndpoint(endpoint) {
  const filled = resolveEndpoint(endpoint);
  // The final endpoint is checked on its RAW string after the
  // substitution: no question mark and no number sign at all, so an empty query or an empty
  // fragment refuses, together with the URL parse checks below.
  if (filled.includes('?') || filled.includes('#')) throw endpointError('the resolved endpoint holds a query or fragment marker on its raw string (an empty query or fragment refuses)');
  if (/[${}]/.test(filled)) throw endpointError('unresolved endpoint markers remain');
  let url;
  try { url = new URL(filled); } catch { throw endpointError('the resolved endpoint does not parse as a URL'); }
  if (!validUrl(url)) throw endpointError('the resolved endpoint must be an https URL without userinfo, query or fragment (a loopback http URL only in tests)');
  return filled;
}

// G2a (rule R1): the whitelist walk. The table is keyed by provider id: an unknown
// provider refuses the route. A key must be in that provider's list and match the closed key
// grammar; values are scalars only (a string up to 64 characters, a finite number, a boolean,
// null); an object or array value refuses the registry. A field name is never reproduced in a
// message, only its length, so secret-named keys cannot be probed through the error text.
function reasoningProblems(route, at, problems) {
  const params = route.reasoningParams;
  if (params === null) return;
  if (typeof params !== 'object' || Array.isArray(params)) {
    problems.push(`${at}: reasoningParams must be an object or null`);
    return;
  }
  const allowed = REASONING_FIELDS[route.provider];
  // An unknown or missing provider with a NON-EMPTY
  // reasoningParams refuses with the fixed code PREREVIEW-REGISTRY (validateRegistry already
  // recorded the provider refusal), never a TypeError from a missing table row.
  if (!Array.isArray(allowed)) return;
  for (const [key, value] of Object.entries(params)) {
    if (!REASONING_KEY.test(key)) {
      problems.push(`${at}: reasoningParams key of ${key.length} characters does not match the closed key grammar ^[a-z][a-z0-9_]{0,31}$ (no dots)`);
      continue;
    }
    if (value !== null && typeof value === 'object') {
      problems.push(`${at}: reasoningParams key of ${key.length} characters holds an ${Array.isArray(value) ? 'array' : 'object'} value; only scalar values are allowed`);
      continue;
    }
    if (typeof value === 'string' && value.length > REASONING_VALUE_MAX) {
      problems.push(`${at}: reasoningParams string value exceeds ${REASONING_VALUE_MAX} characters`);
      continue;
    }
    if (typeof value === 'number' && !Number.isFinite(value)) {
      problems.push(`${at}: reasoningParams number value is not finite`);
      continue;
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' || value === null) {
      if (allowed.includes(key)) continue;
      problems.push(`${at}: reasoningParams field of ${key.length} characters is not whitelisted for provider ${route.provider}`);
    } else {
      problems.push(`${at}: reasoningParams value is not a scalar (string, number, boolean or null)`);
    }
  }
}

function validateRegistry(json) {
  const problems = [];
  if (!json || typeof json !== 'object' || Array.isArray(json)) return ['registry is not an object'];
  if (json.schema !== SCHEMA) problems.push(`schema must be ${SCHEMA}`);
  if (!Array.isArray(json.routes) || json.routes.length === 0) {
    problems.push('routes must be a non-empty array');
    return problems;
  }
  const seen = new Set();
  json.routes.forEach((route, i) => {
    const at = `route ${i}${route && route.id ? ` (${route.id})` : ''}`;
    if (!route || typeof route !== 'object' || Array.isArray(route)) { problems.push(`${at}: not an object`); return; }
    if (typeof route.id !== 'string' || !/^[a-z0-9][a-z0-9.-]*$/.test(route.id)) problems.push(`${at}: id must be a lowercase slug`);
    else if (seen.has(route.id)) problems.push(`${at}: duplicate id`);
    else seen.add(route.id);
    if (typeof route.provider !== 'string' || !route.provider) problems.push(`${at}: provider missing`);
    else if (!Object.hasOwn(REASONING_FIELDS, route.provider)) problems.push(`${at}: provider ${route.provider} is not in the reasoning whitelist table`);
    if (!validEndpoint(route.endpoint)) problems.push(`${at}: endpoint must be an https URL without userinfo, query or fragment (a loopback http URL only in tests), ${'$'}{ENV_NAME} placeholders only`);
    if (typeof route.model !== 'string' || !route.model) problems.push(`${at}: model missing`);
    if (route.keyEnv !== null && (typeof route.keyEnv !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(route.keyEnv))) problems.push(`${at}: keyEnv must be an environment variable name or null`);
    if (typeof route.paid !== 'boolean') problems.push(`${at}: paid must be boolean`);
    if (route.reasoningParams !== null && (typeof route.reasoningParams !== 'object' || Array.isArray(route.reasoningParams))) problems.push(`${at}: reasoningParams must be an object or null`);
    else reasoningProblems(route, at, problems);
    if (!Number.isInteger(route.maxTokens) || route.maxTokens <= 0) problems.push(`${at}: maxTokens must be a positive integer`);
    if (!Number.isInteger(route.probeMaxTokens) || route.probeMaxTokens <= 0) problems.push(`${at}: probeMaxTokens must be a positive integer`);
    const probe = route.probe;
    if (!probe || typeof probe !== 'object' || Array.isArray(probe)) problems.push(`${at}: probe must be an object`);
    else {
      if (probe.time !== null && !isIsoTime(probe.time)) problems.push(`${at}: probe.time must be an ISO 8601 UTC string or null`);
      if (!PROBE_RESULTS.includes(probe.result)) problems.push(`${at}: probe.result must be unprobed, ok or fail`);
      if (typeof probe.note !== 'string' && probe.note !== null) problems.push(`${at}: probe.note must be a string or null`);
    }
    if (!STATUSES.includes(route.status)) problems.push(`${at}: status must be one of ${STATUSES.join(', ')}`);
    else if (route.status === 'ok' && !(probe && probe.result === 'ok' && isIsoTime(probe.time))) {
      problems.push(`${at}: status ok requires a successful probe with a valid ISO time`);
    }
  });
  return problems;
}

// G3: the registry is read only through the strict reader: decode with bom/crlf/invisible
// refuse, then parseJsonUnique (duplicate keys are refused, not last-wins).
function loadRegistry(registryPath) {
  const bytes = fs.readFileSync(registryPath);
  const d = decode(bytes, STRICT_REGISTRY_POLICY);
  if (!d.ok) throw Error(`PREREVIEW-REGISTRY: the strict reader refused ${path.basename(registryPath)}: ${(d.problems || []).map(p => p.code).join(', ')}`);
  let json;
  try { json = parseJsonUnique(d.text); } catch (e) { throw Error(`PREREVIEW-REGISTRY: ${path.basename(registryPath)}: JSON refused: ${String((e && e.message) || e).split(' ')[0]}`); }
  const problems = validateRegistry(json);
  if (problems.length) throw Error(`PREREVIEW-REGISTRY: ${problems.join('; ')}`);
  return json;
}

// G3 + R5: ONE writer. A mkdir lock next to the registry; the lock records its creator pid and
// creation time in a file inside the lock. A lock older than 5 minutes whose pid is not alive
// is renamed aside (suffix .stale, never deleted) and the update proceeds; a live or fresh
// lock is waited for and then refused with the fixed code. A lock without a readable record
// fails closed: it is never stolen, only waited for.
function pidAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (e) { return Boolean(e && e.code === 'EPERM'); }
}

function stealStaleLock(lockPath) {
  let record;
  // The lock record is read as BYTES and decoded with the ONE
  // shared strict decoder (bom strip, crlf normalise), like every other text the tool reads;
  // the private readFileSync(path, 'utf8') of earlier versions is gone, so the C3 sentence "no
  // readFileSync with an encoding" is true. A record that does not decode is not stolen
  // (fail closed), exactly like a record that does not parse.
  try {
    const d = decode(fs.readFileSync(path.join(lockPath, LOCK_RECORD)), GIT_TEXT_POLICY);
    if (!d.ok) return;
    record = JSON.parse(d.text);
  }
  catch { return; }
  const pid = Number(record && record.pid);
  const created = Date.parse(record && record.createdAt);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(created)) return;
  if (Date.now() - created < STALE_LOCK_MS) return;
  if (pidAlive(pid)) return;
  let aside = `${lockPath}.stale`;
  if (fs.existsSync(aside)) aside = `${lockPath}.stale-${Date.now()}`;
  try { fs.renameSync(lockPath, aside); } catch { /* a racing writer recovered it; keep waiting */ }
}

function withRegistryLock(registryPath, fn, lockWaitMs) {
  const lockPath = `${registryPath}.lock`;
  const deadline = Date.now() + (lockWaitMs || LOCK_TIMEOUT_MS);
  for (;;) {
    try { fs.mkdirSync(lockPath); break; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      stealStaleLock(lockPath);
      if (Date.now() > deadline) throw Error('PREREVIEW-REGISTRY-LOCK: another writer holds the registry lock');
      sleepMs(25);
    }
  }
  try {
    fs.writeFileSync(path.join(lockPath, LOCK_RECORD), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, { flag: 'wx' });
    return fn();
  } finally {
    try { fs.unlinkSync(path.join(lockPath, LOCK_RECORD)); } catch { /* the next writer sees a foreign leftover */ }
    try { fs.rmdirSync(lockPath); } catch { /* a stuck lock is reported by the next writer's timeout */ }
  }
}

function writeRegistryAtomic(registryPath, registry) {
  const tmp = `${registryPath}.tmp-${crypto.randomBytes(4).toString('hex')}`;
  fs.writeFileSync(tmp, JSON.stringify(registry, null, 2) + '\n', { flag: 'wx' });
  fs.renameSync(tmp, registryPath);
}

// The only way the registry changes. Changes carry this run's per-route outcome only; a
// failing mark is cleared only by a successful probe of that route ('probe-ok' is the only
// change that may write status ok).
function updateRegistry(registryPath, changes, options) {
  if (!changes || changes.length === 0) return;
  withRegistryLock(registryPath, () => {
    const fresh = loadRegistry(registryPath);
    for (const change of changes) {
      const route = fresh.routes.find(r => r.id === change.id);
      if (!route) continue;
      if (change.kind === 'probe-ok') { route.status = 'ok'; route.probe = change.probe; }
      else if (change.kind === 'probe-fail') { route.status = 'failing'; route.probe = change.probe; }
      else if (change.kind === 'review-fail') { route.status = 'failing'; }
    }
    writeRegistryAtomic(registryPath, fresh);
  }, options && options.lockWaitMs);
}

// G3: the one usability gate, shared by review and listing.
function usable(route) {
  return Boolean(route && route.status === 'ok' && route.probe && route.probe.result === 'ok' && isIsoTime(route.probe.time));
}

function panelAdmits(route, panel) {
  if (panel === 'both') return true;
  return panel === 'paid' ? route.paid === true : route.paid !== true;
}

function usableRoutes(registry, panel) {
  return registry.routes.filter(r => panelAdmits(r, panel) && usable(r));
}

// G4: the panel is explicit or the environment names it; the default stays free.
function resolvePanel(explicit) {
  return explicit || process.env.PREREVIEW_PANEL || DEFAULT_PANEL;
}

// The base rules R4 and R2, the change-set rule R4 and the git output rules C2 and C4
// together: every REVIEW-INPUT git call of the tool (gitIn, used by readDiff)
// runs with an environment built by ONE helper (reviewGitEnv): every inherited GIT_ variable
// is removed (gitEnv, the same scrub the advisory root uses), so a hostile GIT_DIR or
// GIT_WORK_TREE pointing at another repository cannot redirect the source of the review
// input, and only the tool's OWN fixed GIT_ variables are then set: GIT_LITERAL_PATHSPECS=1
// (every path the tool names is a literal path, never a pathspec match, so a file named
// a[1].txt cannot pull its glob neighbours into a per-file diff), GIT_CONFIG_NOSYSTEM=1 and
// GIT_ATTR_NOSYSTEM=1 (the system config and the system attributes file cannot declare a
// diff driver or a textconv), and GIT_CONFIG_GLOBAL pointed at an EMPTY file of the tool's
// own temp directory (a global config cannot declare a diff driver, a textconv or
// core.attributesFile either). A repository whose local config or gitattributes declares a
// textconv, an external diff or a diff driver therefore gives the SAME payload as one
// without it, because every diff call also passes --no-textconv --no-ext-diff. The rule
// E1 adds --text to the same flag list (and git decides nothing about text or binary: a
// binary attribute, a -diff attribute from any attributes file and a diff driver binary=true
// cannot hide a text file), and E2 adds --ignore-submodules=none (a gitlink change is never
// dropped from the change records, whatever diff.ignoreSubmodules says).
// The repository is given by -C on the worktree argument. The one other git call of the
// tool, the advisory-home discovery (advisoryRoot), runs `git rev-parse --git-common-dir`
// in the plain GIT_*-scrubbed environment on the tool's own directory (cwd __dirname, the
// main checkout), with no -C; the author report states exactly this split.
// Every git child process is started with stdout
// captured and stderr captured and DISCARDED (never inherited, never forwarded, never put
// into an error message); a failing git call becomes ONE fixed named code with no child
// text (PREREVIEW-GIT here, PREREVIEW-BASE in resolveBase).
let reviewEnvCache = null;
function reviewGitEnv() {
  if (reviewEnvCache) return reviewEnvCache;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prereview-git-'));
  const identity = fs.lstatSync(dir, { bigint: true }); const real = fs.realpathSync.native(dir);
  const emptyGlobalConfig = path.join(dir, 'empty-config');
  let fileIdentity;
  process.once('exit', () => {
    try {
      const st = fs.lstatSync(dir, { bigint: true });
      if (!st.isDirectory() || st.isSymbolicLink() || st.dev !== identity.dev || st.ino !== identity.ino || fs.realpathSync.native(dir) !== real) return;
      if (fileIdentity) {
        const file = fs.lstatSync(emptyGlobalConfig, { bigint: true });
        if (file.isFile() && file.nlink === 1n && file.dev === fileIdentity.dev && file.ino === fileIdentity.ino) fs.unlinkSync(emptyGlobalConfig);
      }
      fs.rmdirSync(dir);
    } catch { /* only our own file and empty directory; best effort */ }
  });
  fs.writeFileSync(emptyGlobalConfig, '');
  fileIdentity = fs.lstatSync(emptyGlobalConfig, { bigint: true });
  reviewEnvCache = {
    ...gitEnv(),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: emptyGlobalConfig,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_LITERAL_PATHSPECS: '1',
  };
  return reviewEnvCache;
}

function gitIn(worktree, args) {
  try {
    return execFileSync('git', ['-C', worktree, ...args], {
      maxBuffer: 1 << 28, env: reviewGitEnv(), stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    throw Error('PREREVIEW-GIT: a git call that builds the review input failed; the child output is discarded and never reported');
  }
}

// ONE decode function (the shared strict reader of the repository,
// .ai/bin/lib/text-safe.cjs decode, TextDecoder with fatal: true inside it) turns bytes into
// text on every path that does so: the diff, the diff stat, the -z record tokens, the prompt
// file and the registry. There is no second decoder in this file: no readFileSync with an
// encoding, no toString('utf8') on child output. Text that the shared reader refuses is
// never sent with replacement characters: a per-file diff that does not decode is listed in
// the skipped header with the reason invalid-utf8 and its size, exactly like a binary file,
// and a prompt file that does not decode refuses the run with the fixed code. The policy for
// git text output is the same policy the response bodies use (bom strip, crlf normalise);
// the -z record tokens use the strict defaults.
const GIT_TEXT_POLICY = { bom: 'strip', crlf: 'normalise' };

function gitText(buf, what) {
  const d = decode(buf, GIT_TEXT_POLICY);
  if (!d.ok) throw Error(`PREREVIEW-GIT: ${what} is not valid UTF-8; the child output is discarded and never reported`);
  return d.text;
}

// The truncation marker is reserved INSIDE the byte budget: the
// returned text, marker included, is at most maxBytes bytes. For a budget smaller than the
// marker the marker is dropped and the payload says truncated true.
const TRUNCATION_MARKER = '\n[diff truncated]';

function truncateUtf8(text, maxBytes) {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return { text, truncated: false };
  const markerBytes = Buffer.byteLength(TRUNCATION_MARKER);
  const keepMarker = maxBytes >= markerBytes;
  const bodyBudget = keepMarker ? maxBytes - markerBytes : maxBytes;
  let end = bodyBudget;
  for (let i = bodyBudget - 1; i >= Math.max(0, bodyBudget - 4); i--) {
    const b = bytes[i];
    if ((b & 0xC0) === 0x80) continue;
    const need = b < 0x80 ? 1 : b < 0xE0 ? 2 : b < 0xF0 ? 3 : 4;
    if (i + need > bodyBudget) end = i;
    break;
  }
  if (end > 0 && bytes[end - 1] === 0x0D) end -= 1; // never split a CRLF into a lone CR
  const d = decode(bytes.subarray(0, end), GIT_TEXT_POLICY);
  if (!d.ok) throw Error('PREREVIEW-DIFF: the truncated diff prefix does not decode as valid UTF-8');
  return { text: d.text + (keepMarker ? TRUNCATION_MARKER : ''), truncated: true };
}

// R4: the review input excludes NOTHING silently. JSON files are review
// input like any other file; the only skips are a binary file, a file whose diff exceeds the
// per-file cap, a gitlink change (rule E2) and a file under a fixed-policy exclude,
// and each skipped path with its stated reason is listed in the payload header,
// while the stat shows every changed file. The two fixed-policy excludes (session journals and
// review files are protocol artifacts, not review input) are listed too, when they match.
const REVIEW_EXCLUDES = [
  ['.ai/worklog/', 'session journals are protocol artifacts, not review input'],
  ['docs/reviews/', 'review files are protocol artifacts, not review input'],
];

// The base reference is DATA, never an option. It must match the
// closed grammar /^[A-Za-z0-9][A-Za-z0-9._\/-]{0,99}$/ (never starts with a dash, no spaces),
// it is resolved FIRST by git rev-parse --verify --end-of-options REF to a full object id,
// and ONLY that object id is passed to git diff, after the options and before a literal --.
// A base that does not resolve refuses the run with the fixed code PREREVIEW-BASE, never an
// empty input reported as ok and never a file created in the reviewed worktree.
const BASE_GRAMMAR_ERROR = 'PREREVIEW-BASE: the base reference does not match the closed grammar ^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$ (data, never a git option)';

function resolveBase(worktree, baseRef) {
  if (typeof baseRef !== 'string' || !BASE_REF.test(baseRef)) throw Error(BASE_GRAMMAR_ERROR);
  let oid;
  try { oid = gitText(gitIn(worktree, ['rev-parse', '--verify', '--end-of-options', baseRef]), 'the resolved base').trim(); }
  catch { throw Error('PREREVIEW-BASE: the base reference does not resolve in this repository'); }
  if (!OBJECT_ID.test(oid)) throw Error('PREREVIEW-BASE: the resolved base is not a full object id');
  // The resolved base must be a COMMIT object id.
  // `<oid>^{commit}` resolves for a commit, and peels an annotated tag object to the commit it
  // names; a base that resolves to a non-commit object (a blob or a tree) refuses here with
  // the fixed code PREREVIEW-BASE, never a raw child-process message from git diff. Only the
  // resolved full commit object id is returned and passed to git diff, never the raw ref.
  let commit;
  try { commit = gitText(gitIn(worktree, ['rev-parse', '--verify', '--end-of-options', `${oid}^{commit}`]), 'the peeled base commit').trim(); }
  catch { throw Error('PREREVIEW-BASE: the base resolves to a non-commit object (a blob or a tree), which is never a diff base'); }
  if (!OBJECT_ID.test(commit)) throw Error('PREREVIEW-BASE: the resolved base is not a full object id');
  return commit;
}

// A negative or non-integer byte budget refuses with the fixed
// code PREREVIEW-MAX-DIFF-BYTES; nothing is silently replaced by a default.
function checkDiffBudget(maxBytes) {
  if (maxBytes === undefined || maxBytes === null) return;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0) throw Error('PREREVIEW-MAX-DIFF-BYTES: the byte budget must be a positive integer');
}

// ONE parser for every spelling of the CLI numeric option
// --max-diff-bytes: --max-diff-bytes=VALUE and --max-diff-bytes VALUE each either give the
// canonical integer (one to nine digits, no leading zero) or refuse with the fixed code
// PREREVIEW-MAX-DIFF-BYTES, and the CLI exits 2: an empty value, a missing value, a repeated
// option, a negative value, a zero, a leading zero, an exponent and a hexadecimal spelling
// each refuse. Nothing is silently ignored and nothing falls back to the default budget.
function parseByteBudget(argv) {
  let seen = false;
  let value = null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== '--max-diff-bytes' && !arg.startsWith('--max-diff-bytes=')) continue;
    if (seen) throw Error('PREREVIEW-MAX-DIFF-BYTES: the --max-diff-bytes option appears more than once; one value is accepted, none is silently ignored');
    seen = true;
    if (arg === '--max-diff-bytes') {
      if (i + 1 >= argv.length) throw Error('PREREVIEW-MAX-DIFF-BYTES: the --max-diff-bytes value is missing; the default budget is never a silent fallback');
      value = argv[++i];
    } else {
      value = arg.slice('--max-diff-bytes='.length);
    }
  }
  if (!seen) return undefined;
  if (!MAX_DIFF_BYTES_ARG.test(value)) throw Error('PREREVIEW-MAX-DIFF-BYTES: the --max-diff-bytes value is not a canonical integer (one to nine digits, no leading zero); an empty, negative, zero, leading-zero, exponent or hexadecimal spelling refuses');
  return Number(value);
}

// C1, E1 and E2: NO RENAME PAIRS and GIT DECIDES
// NOTHING ABOUT TEXT OR BINARY. Every git call that produces review input passes this one
// flag list: --no-renames (a rename is a deletion plus an addition, so the -z output has no
// pair tokens at all), --no-textconv --no-ext-diff (no configured converter, C2),
// --text (a binary attribute, a -diff attribute from any attributes file and a diff driver
// binary=true cannot hide a text file: git's own binary branch is bypassed, E1), and
// --ignore-submodules=none (a gitlink change is never dropped from any diff output, not
// even with diff.ignoreSubmodules all configured, E2).
const DIFF_FLAGS = ['--no-renames', '--no-textconv', '--no-ext-diff', '--text', '--ignore-submodules=none'];

function zRecords(buf) {
  const records = [];
  let start = 0;
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0) { records.push(buf.subarray(start, i)); start = i + 1; }
  }
  if (start < buf.length) records.push(buf.subarray(start));
  return records;
}

function tokenText(bytes) {
  const d = decode(bytes);
  return d.ok ? d.text : null;
}

// E1 and E2: the change records come from git diff --raw -z --no-renames: ONE flat
// record per change - ":<oldMode> <newMode> <oldOid> <newOid> <status>" followed by the
// path, each NUL-terminated. One path per record, no pair tokens, no alignment between two
// outputs (no numstat/name-status pair: numstat is never the judge of
// anything). The raw record carries the two modes and the two object ids, which is what
// makes the tool's own gitlink judgement possible: a gitlink is a change whose old or
// new mode is 160000. A record whose header does not decode is impossible from git (the
// header is ASCII); it fails closed with the fixed code instead of being skipped silently.
function parseRawChanges(rawBuf) {
  const records = zRecords(rawBuf);
  const changes = [];
  for (let i = 0; i + 1 < records.length; i += 2) {
    const header = tokenText(records[i]);
    if (header === null) throw Error('PREREVIEW-GIT: a --raw record header is not valid UTF-8; the child output is discarded and never reported');
    const fields = header.split(' ');
    const rawPath = records[i + 1];
    changes.push({
      oldMode: fields[0].startsWith(':') ? fields[0].slice(1) : fields[0],
      newMode: fields[1],
      oldOid: fields[2],
      newOid: fields[3],
      status: (fields[4] || '').replace(/[^ADMUTX]/g, ''),
      path: tokenText(rawPath),
      rawPathLength: rawPath.length,
    });
  }
  return changes;
}

// The fixed-policy exclude compares the path after Unicode NFC
// normalisation and lower-casing, so a review path in any letter case is excluded like its lower-case spelling
// (and the Kelvin sign in do\u212As/ lower-cases to k). The prefixes are lower-case ASCII;
// normalising both sides makes the comparison well-defined for every path spelling.
function excludeKey(text) {
  return text.normalize('NFC').toLowerCase();
}

function readDiff({ worktree, baseRef, maxBytes }) {
  checkDiffBudget(maxBytes);
  const limit = maxBytes || DEFAULT_MAX_DIFF_BYTES;
  const base = resolveBase(worktree, baseRef);
  const range = `${base}...HEAD`;
  const stat = gitText(gitIn(worktree, ['diff', '--stat', ...DIFF_FLAGS, range, '--']), 'the diff stat');
  // --no-abbrev: the two object ids of every record are the FULL ids, so the gitlink skip
  // reason names the complete object ids, never an abbreviation.
  const changes = parseRawChanges(gitIn(worktree, ['diff', '--raw', '-z', ...DIFF_FLAGS, '--no-abbrev', range, '--']));
  const skipped = [];
  const policyExcluded = [];
  const parts = [];
  for (const change of changes) {
    // A path under a fixed-policy exclude is judged by its OWN
    // path on each side - the old side of a rename is just a deleted path, so a rename OUT
    // of docs/reviews/ skips the deleted side with the policy reason and reviews the added
    // side. A path that does not decode as UTF-8 cannot be named or fetched at all; it is
    // listed with the reason invalid-utf8 and the byte length, never silently and never
    // through replacement characters.
    if (change.path === null) {
      skipped.push({ path: `(a path of ${change.rawPathLength} bytes that is not valid UTF-8)`, reason: 'invalid-utf8 (the path of this change does not decode as strict UTF-8; the file is not review input)' });
      continue;
    }
    // The exclude is case-folded (NFC then lower-case) on both
    // sides of the comparison.
    const policy = REVIEW_EXCLUDES.find(([prefix]) => excludeKey(change.path).startsWith(excludeKey(prefix)));
    if (policy) { policyExcluded.push({ path: change.path, reason: `excluded by the fixed policy: ${policy[1]}` }); continue; }
    // A gitlink change (mode 160000) is never
    // dropped, whatever diff.ignoreSubmodules says, but it is not code review input either:
    // it is listed in the skipped list with the reason submodule and its two object ids.
    if (change.oldMode === '160000' || change.newMode === '160000') {
      skipped.push({ path: change.path, reason: `submodule (a gitlink change is not review input; the gitlink points at ${change.oldOid} on the base side and at ${change.newOid} on the head side)` });
      continue;
    }
    const raw = gitIn(worktree, ['diff', ...DIFF_FLAGS, range, '--', change.path]);
    // The binary judgement is the TOOL'S OWN. With
    // --text git emits the content of every file, binary attributes and diff drivers
    // included, so a text file can never be hidden as binary; a REALLY binary file - one
    // whose diff bytes contain a NUL byte - is still skipped, with the reason binary.
    if (raw.includes(0)) { skipped.push({ path: change.path, reason: 'binary' }); continue; }
    if (raw.length > FILE_MAX_DIFF_BYTES) { skipped.push({ path: change.path, reason: `oversize (the file diff exceeds the per-file cap of ${FILE_MAX_DIFF_BYTES} bytes)` }); continue; }
    // The per-file diff is decoded with the ONE shared strict
    // decoder; a file whose diff bytes are not valid UTF-8 is NOT sent with replacement
    // characters - it is listed as skipped with the reason invalid-utf8 and its size.
    const d = decode(raw, GIT_TEXT_POLICY);
    if (!d.ok) { skipped.push({ path: change.path, reason: `invalid-utf8 (${(d.problems || []).map(p => p.code).join(', ')}; the diff of this file is ${raw.length} bytes and is not review input)` }); continue; }
    parts.push(d.text);
  }
  const cut = truncateUtf8(parts.join(''), limit);
  return { stat, diff: cut.text, truncated: cut.truncated, skipped, policyExcluded };
}

// The cap counts CHARACTERS of the decoded string (code points,
// never UTF-16 code units), so a cut can never end on the lone high surrogate of a pair and
// the text value never carries an unpaired surrogate.
function capCharacters(text, maxCharacters) {
  const chars = Array.from(text);
  if (chars.length <= maxCharacters) return text;
  return chars.slice(0, maxCharacters).join('');
}

function readAuditPrompt(auditPromptPath) {
  if (auditPromptPath === undefined || auditPromptPath === null) return '';
  if (!fs.existsSync(auditPromptPath)) throw Error(`PREREVIEW-AUDIT-PROMPT: the named audit prompt does not exist: ${path.basename(auditPromptPath)}`);
  // The prompt file is read as BYTES and decoded with the ONE
  // shared strict decoder, exactly like the diff and the registry; the private
  // readFileSync(path, 'utf8') of an earlier version (which replaced invalid bytes with U+FFFD and
  // accepted a BOM, CRLF and a lone CR silently) is gone. A prompt that does not decode
  // refuses the run with the fixed code, and nothing is sent.
  const d = decode(fs.readFileSync(auditPromptPath), GIT_TEXT_POLICY);
  if (!d.ok) throw Error('PREREVIEW-AUDIT-PROMPT: the audit prompt does not decode as strict UTF-8 text (the shared reader refused it); nothing is sent');
  return capCharacters(d.text, AUDIT_PROMPT_MAX);
}

// The ONE escape function of the operator boundary. A
// path that reaches the skip header or the user message, and a model answer that reaches the
// advisory JSON, go through it: every control character (Cc, which covers CR, LF, DEL and
// the whole C1 range including U+0085), every bidi and invisible format character (Cf, which
// covers the directional marks and the zero-width characters), U+2028 and U+2029 become the
// visible escape \uXXXX (four lowercase hex digits), so no raw separator and no invisible
// mark can start or spoof a line a reader or a parser judges. The diff and the stat text are
// NOT escaped: they are code review input, and git quotes the paths it prints there itself.
function escapeForOperator(text) {
  return String(text).replace(OPERATOR_ESCAPE_CHARS, ch => `\\u${ch.codePointAt(0).toString(16).padStart(4, '0')}`);
}

function buildMessages({ stat, diff, truncated, audit, skipped, policyExcluded }) {
  // A skipped path goes through the ONE escape function before it
  // enters the skip header and the user message: a bidi or invisible character in a path
  // becomes the visible escape \uXXXX, never a raw directional mark the reader's renderer
  // would silently reinterpret. The reasons are the tool's own fixed ASCII strings. The
  // header lists every non-review-input path: the review-input skips (binary, oversize,
  // submodule, invalid-utf8) and the fixed-policy excludes (session journals, review files).
  const excluded = [...(skipped || []), ...(policyExcluded || [])];
  const skipHeader = excluded.length
    ? `Skipped files (NOT review input; the stat shows them):\n${excluded.map(s => `${escapeForOperator(s.path)}: ${s.reason}`).join('\n')}\n\n`
    : '';
  const user = `Audit prompt of the package (what it claims and must satisfy):\n${audit}\n\nDiff stat:\n${stat}\n\n${skipHeader}Diff${truncated ? ' (truncated)' : ''}:\n${diff}`;
  return [{ role: 'system', content: SYSTEM_PROMPT }, { role: 'user', content: user }];
}

// The request body is assembled here and scanned as a whole; the authorization header is
// the only part outside the scan, and it is never written anywhere.
function buildBody(route, messages, maxTokens) {
  return { model: route.model, messages, max_tokens: maxTokens, ...(route.reasoningParams || {}) };
}

// G2c: both scanners on one text.
function leakIn(text) {
  return Boolean(findSecretLeak(text) || secretIn(text));
}

// G2c: every string value of the assembled body, at any depth.
function bodyStringValues(value, out) {
  if (typeof value === 'string') { out.push(value); return out; }
  if (value && typeof value === 'object') for (const v of Object.values(value)) bodyStringValues(v, out);
  return out;
}

// G2c: the scan runs on the JSON body AND on every string value of it separately. Each surface
// is scanned after removing ONLY default-ignorable/format characters (\p{Cf}); newlines and
// every other character are never removed, so the scanners see the text unchanged (whether a
// secret SPLIT from its marker by a separator matches depends on
// each scanner pattern's own grammar - Bearer tolerates \s+, the sk- pattern does not - and is
// inside the design bound). The per-value surface is what
// sees the text the receiver decodes: JSON.parse decodes every escape, so a secret hidden
// behind a JSON escape or a control character is caught on the value, not only in the raw
// body. Encodings the handoff scanner does not detect (base64, entities, percent) are outside
// the design bound.
function scanAssembledBody(bodyText) {
  if (leakIn(String(bodyText).replace(FORMAT_CHARS, ''))) return true;
  let parsed = null;
  try { parsed = JSON.parse(bodyText); } catch { return true; }
  return bodyStringValues(parsed, []).some(v => leakIn(v.replace(FORMAT_CHARS, '')));
}

function deadlineError() {
  const e = new Error('TIMEOUT');
  e.name = 'TimeoutError';
  e.code = 'TIMEOUT';
  return e;
}

async function raceWithDeadline(promise, ms) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(deadlineError()), ms); })]);
  } finally { clearTimeout(timer); }
}

function classifyError(error) {
  if (error && error.prereviewCode === 'NO_KEY') return String(error.message);
  if (error && error.prereviewCode === 'ENDPOINT') return 'ENDPOINT_REFUSED';
  if (error && (error.name === 'TimeoutError' || error.name === 'AbortError' || error.code === 'TIMEOUT' || error.code === 'ABORT_ERR')) return 'TIMEOUT';
  return 'BAD_RESPONSE';
}

function outcomeFromError(error) {
  return { state: 'failed', reason: classifyError(error) };
}

// G3 (3): the body bytes are read through the size cap. Past 256 KiB the stream is cancelled
// and the fixed failure OVERSIZE is returned; an endpoint cannot pump unbounded bytes.
async function readCapped(response) {
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        try { await reader.cancel(); } catch { /* the failure stands */ }
        return { code: 'OVERSIZE' };
      }
      chunks.push(Buffer.from(value));
    }
    return { bytes: Buffer.concat(chunks) };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_RESPONSE_BYTES) return { code: 'OVERSIZE' };
  return { bytes };
}

// G3: the fixed response shape. Anything else is a route failure with a fixed code. The body
// bytes are decoded with the strict reader (invalid UTF-8 is refused), and duplicate JSON keys
// are refused, before the shape is judged. A read error propagates: the whole-request deadline
// decides whether it is TIMEOUT, anything else is BAD_RESPONSE.
async function readResponse(response) {
  if (!response || typeof response !== 'object') return { code: 'BAD_RESPONSE' };
  if (!response.ok) return { code: `HTTP_${response.status}` };
  const capped = await readCapped(response);
  if (capped.code) return capped;
  const d = decode(capped.bytes, { bom: 'strip', crlf: 'normalise' });
  if (!d.ok) return { code: 'BAD_RESPONSE' };
  let json;
  try { json = parseJsonUnique(d.text); } catch { return { code: 'BAD_RESPONSE' }; }
  if (!json || typeof json !== 'object' || Array.isArray(json) || json.error) return { code: 'BAD_RESPONSE' };
  const choices = json.choices;
  if (!Array.isArray(choices) || choices.length === 0) return { code: 'BAD_RESPONSE' };
  const choice = choices[0];
  if (!choice || typeof choice !== 'object' || Array.isArray(choice)) return { code: 'BAD_RESPONSE' };
  if (choice.finish_reason === 'length') return { code: 'TRUNCATED' };
  if (choice.finish_reason !== 'stop') return { code: 'BAD_RESPONSE' };
  const content = choice.message && choice.message.content;
  if (typeof content !== 'string') return { code: 'BAD_RESPONSE' };
  if (!content.trim()) return { code: 'EMPTY' };
  return { text: content, usage: json.usage || null };
}

// G3 (2): the whole request - fetch AND the body read - runs under one deadline: the
// AbortSignal is passed to the transport and the entire send is raced against the same
// deadline, so a deadline during the body read is TIMEOUT, never BAD_RESPONSE.
async function sendRoute(route, bodyText, impl, timeoutMs) {
  const deadlineMs = timeoutMs || DEFAULT_TIMEOUT_MS;
  const headers = { 'Content-Type': 'application/json' };
  if (route.keyEnv) {
    const key = process.env[route.keyEnv];
    if (!key) {
      const e = new Error(`NO_KEY: ${route.keyEnv}`);
      e.prereviewCode = 'NO_KEY';
      throw e;
    }
    headers.Authorization = `Bearer ${key}`;
  }
  const options = { method: 'POST', headers, body: bodyText, redirect: 'error', signal: AbortSignal.timeout(deadlineMs) };
  const whole = async () => {
    const response = await (impl || fetch)(finalEndpoint(route.endpoint), options);
    return readResponse(response);
  };
  return raceWithDeadline(whole(), deadlineMs);
}

// G1 (rule R3): the ONE advisory home. Its root is the MAIN checkout, found with
// git rev-parse --git-common-dir in an environment where every GIT_* variable is removed, so
// a hostile GIT_DIR or GIT_WORK_TREE cannot redirect it; the tool's own directory decides,
// never a caller argument.
// The ONE documented override of that root is the environment
// variable PREREVIEW_ADVISORY_ROOT (an absolute path; documented in
// tools/operator/prereview-routes.schema.md). It exists so every test and every mutant gets
// its OWN temporary home instead of the shared home of the main checkout: the tests of one
// process never read or write the advisory files of another process. The default (no
// override set) is unchanged: the main checkout, derived from git, never from a caller
// argument. The guarded creator (ensureAdvisoryHome) and the guarded path checks
// (guardAdvisoryPath) run from the override root exactly as they do from the git-derived
// root, so a hostile override value meets the same junction and hardlink refusals.
function gitEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^GIT_/i.test(k)) env[k] = v;
  return env;
}

function advisoryRoot() {
  const override = process.env.PREREVIEW_ADVISORY_ROOT;
  if (typeof override === 'string' && override !== '') {
    if (!path.isAbsolute(override)) throw Error('PREREVIEW-OUT: the PREREVIEW_ADVISORY_ROOT override must be an absolute path');
    return override;
  }
  let common;
  try {
    // This git child captures and discards stderr too,
    // and its output is decoded with the one shared strict decoder, never with a private
    // utf8 read.
    const out = execFileSync('git', ['rev-parse', '--git-common-dir'], { env: gitEnv(), cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'] });
    const d = decode(out, GIT_TEXT_POLICY);
    if (!d.ok) throw Error('not utf-8');
    common = d.text.trim();
  } catch (e) {
    throw Error('PREREVIEW-OUT: the advisory home needs the main checkout (git rev-parse --git-common-dir failed)');
  }
  if (!common) throw Error('PREREVIEW-OUT: git rev-parse --git-common-dir returned no path');
  const gitDir = path.isAbsolute(common) ? common : path.resolve(__dirname, common);
  const root = path.dirname(gitDir);
  if (!root || !path.isAbsolute(root)) throw Error('PREREVIEW-OUT: the main checkout path is not an absolute path');
  return root;
}

function advisoryHome() {
  return path.join(advisoryRoot(), '.ai', 'runtime', 'prereview');
}

// G1 (rule R3): the home is created by the guarded creator ONE LEVEL AT A TIME with the
// root check at every step (mkdirGuarded, the helper of tools/operator/auto-retire.cjs), BEFORE
// any directory exists outside the root: a junction at any parent refuses before a directory is
// created, so no directory is ever created outside the main checkout.
function ensureAdvisoryHome(root, home) {
  let cur = root;
  for (const part of path.relative(root, home).split(path.sep).filter(Boolean)) {
    cur = path.join(cur, part);
    const made = mkdirGuarded(root, cur);
    if (!made.ok) throw Error(`PREREVIEW-OUT: the guarded creator refused the advisory home (${made.reason})`);
  }
  return cur;
}

function advisoryFileName() {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${stamp}-${crypto.randomBytes(5).toString('hex')}.json`;
}

// G1 (rule R3): the file name is generated by the tool from a closed grammar (a UTC
// stamp and random hex), never accepted from a caller: a caller name is not an input. The guard
// checks the grammar AND the guarded path helpers: realInside runs from the volume root, so
// EVERY parent of the home is walked: a junction or a symlink on any ancestor is refused, the
// containment is case-insensitive on Windows, and an existing file with a link count above 1
// is refused (refuseHardlinks).
function guardAdvisoryPath(home, name) {
  if (typeof home !== 'string' || typeof name !== 'string' || !name) return { ok: false, reason: 'bad-input' };
  if (!ADVISORY_NAME.test(name)) return { ok: false, reason: 'name-grammar' };
  const file = path.join(home, name);
  const g = realInside(path.parse(file).root, file, { refuseHardlinks: true });
  return g.ok ? { ok: true, real: g.real } : { ok: false, reason: g.reason, detail: g.detail };
}

// G1: the file body is ONE JSON line. JSON.stringify escapes CR and LF inside strings; the two
// Unicode line separators JSON keeps raw are escaped here as well, so the file bytes hold no
// separator at all and no parser can see a line starting with "Verdict:" or "Mode:".
function serializeAdvisory(payload) {
  const json = JSON.stringify(payload).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  return `${json}\n`;
}

function advisoryAnswer(entry) {
  // The model answer goes through the ONE escape function before
  // it enters the advisory JSON: every control character (including U+0085), every bidi and
  // invisible format character and U+2028/U+2029 become the visible escape \uXXXX, so no
  // reader and no parser can see a raw separator starting a line inside the answer. The
  // refused and failed branches carry the tool's own fixed ASCII strings and go through the
  // same one function.
  if (entry.state === 'refused') return escapeForOperator(SECRET_REFUSED_REASON);
  if (entry.state === 'failed') return escapeForOperator(`ROUTE FAILED: ${entry.reason}. ${FAILURE_NOTE}`);
  return escapeForOperator(entry.text);
}

function advisoryPayload(send, createdAt) {
  return {
    schema: ADVISORY_SCHEMA,
    advisory: true,
    mode: ADVISORY_MODE,
    verdict: null,
    route: send.route.id,
    createdAt: createdAt || new Date().toISOString(),
    answer: advisoryAnswer(send.entry),
  };
}

function writeAdvisory(payload) {
  const root = advisoryRoot();
  const home = path.join(root, '.ai', 'runtime', 'prereview');
  ensureAdvisoryHome(root, home);
  const name = advisoryFileName();
  const g = guardAdvisoryPath(home, name);
  if (!g.ok) throw Error(`PREREVIEW-OUT: the advisory home refused the output path (${g.reason})`);
  fs.writeFileSync(g.real, serializeAdvisory(payload), { flag: 'wx' });
  return g.real;
}

// Test seam: tests substitute the writer to prove the G3 order (the registry is updated before
// the advisory file is written) without touching the real home. The CLI and the normal path
// never touch it; a test writer receives the payload and stands where writeAdvisory stands.
let advisoryWriter = writeAdvisory;
function setAdvisoryWriter(fn) {
  advisoryWriter = typeof fn === 'function' ? fn : writeAdvisory;
}

async function runReview(opts) {
  if (!opts || !opts.worktree || !opts.baseRef) {
    throw Error('PREREVIEW-USAGE: review needs worktree and baseRef');
  }
  if (opts.outDir) {
    throw Error('PREREVIEW-OUTDIR: no output directory option exists; the advisory home is .ai/runtime/prereview');
  }
  if (opts.root) {
    throw Error('PREREVIEW-OUT: no output base option exists; the advisory home is the repository .ai/runtime/prereview, derived from git');
  }
  const registryPath = opts.registryPath || DEFAULT_REGISTRY;
  const panel = resolvePanel(opts.panel);
  if (!PANELS.includes(panel)) throw Error(`PREREVIEW-PANEL: ${panel} must be one of ${PANELS.join(', ')}`);
  const registry = loadRegistry(registryPath);
  const { stat, diff, truncated, skipped, policyExcluded } = readDiff({ worktree: opts.worktree, baseRef: opts.baseRef, maxBytes: opts.maxBytes });
  const audit = readAuditPrompt(opts.auditPromptPath);
  const routes = usableRoutes(registry, panel);
  const messages = buildMessages({ stat, diff, truncated, audit, skipped, policyExcluded });
  const sends = await Promise.all(routes.map(async route => {
    const bodyText = JSON.stringify(buildBody(route, messages, route.maxTokens));
    if (scanAssembledBody(bodyText)) {
      return { route, entry: { state: 'refused', reason: SECRET_REFUSED_REASON }, ms: null };
    }
    const startedAt = Date.now();
    try {
      const outcome = await sendRoute(route, bodyText, opts.impl, opts.timeoutMs);
      return outcome.code
        ? { route, entry: { state: 'failed', reason: outcome.code }, ms: Date.now() - startedAt }
        : { route, entry: { state: 'ok', text: outcome.text }, ms: Date.now() - startedAt };
    } catch (error) {
      return { route, entry: outcomeFromError(error), ms: Date.now() - startedAt };
    }
  }));
  // G3 (4)+(5): the registry is updated FIRST, whatever the sends brought; only then the
  // advisory files are written, and a failure to write them never skips the registry update
  // and never throws past it.
  const failures = sends.filter(s => s.entry.state === 'failed').map(s => ({ id: s.route.id, kind: 'review-fail' }));
  const updateFirst = () => updateRegistry(registryPath, failures, { lockWaitMs: opts.lockWaitMs });
  const files = [];
  let advisoryError = null;
  const writeFiles = () => {
    for (const send of sends) {
      try { files.push(advisoryWriter(advisoryPayload(send))); }
      catch (e) { advisoryError = 'ADVISORY_WRITE_FAILED'; }
    }
  };
  updateFirst();
  writeFiles();
  return {
    files,
    advisoryError,
    sends: sends.map(s => ({ id: s.route.id, state: s.entry.state, reason: s.entry.reason || null, ms: s.ms || null })),
    refused: sends.filter(s => s.entry.state === 'refused').length,
    failed: sends.filter(s => s.entry.state === 'failed').length,
    ok: sends.filter(s => s.entry.state === 'ok').length,
    usable: routes.length,
    diffBytes: Buffer.byteLength(diff),
    truncated,
    skipped,
    policyExcluded,
  };
}

async function runProbe(opts) {
  const registryPath = (opts && opts.registryPath) || DEFAULT_REGISTRY;
  const panel = resolvePanel(opts && opts.panel);
  if (!PANELS.includes(panel)) throw Error(`PREREVIEW-PANEL: ${panel} must be one of ${PANELS.join(', ')}`);
  const registry = loadRegistry(registryPath);
  let targets;
  if (opts && opts.routeId) {
    const named = registry.routes.filter(r => r.id === opts.routeId);
    if (named.length === 0) throw Error(`PREREVIEW-ROUTE: ${opts.routeId} is not in the registry`);
    if (!panelAdmits(named[0], panel)) throw Error(`PREREVIEW-PANEL: route ${opts.routeId} is paid; name its panel with --panel paid|both`);
    targets = named;
  } else {
    targets = registry.routes.filter(r => panelAdmits(r, panel));
  }
  const messages = [{ role: 'system', content: PROBE_SYSTEM }, { role: 'user', content: PROBE_USER }];
  const probes = [];
  const changes = [];
  for (const route of targets) {
    const bodyText = JSON.stringify(buildBody(route, messages, route.probeMaxTokens));
    const time = new Date().toISOString();
    let result = 'fail';
    let note = 'SECRET_REFUSED';
    if (!scanAssembledBody(bodyText)) {
      try {
        const outcome = await sendRoute(route, bodyText, opts && opts.impl, opts && opts.timeoutMs);
        if (outcome.code) note = outcome.code;
        else { result = 'ok'; note = 'ok'; }
      } catch (error) { note = classifyError(error); }
    }
    probes.push({ id: route.id, time, result, note });
    changes.push(result === 'ok'
      ? { id: route.id, kind: 'probe-ok', probe: { time, result: 'ok', note } }
      : { id: route.id, kind: 'probe-fail', probe: { time, result: 'fail', note } });
  }
  updateRegistry(registryPath, changes, { lockWaitMs: opts && opts.lockWaitMs });
  return probes;
}

function listRoutes(registry, panel) {
  return registry.routes.filter(r => panelAdmits(r, panel))
    .map(r => ({ id: r.id, paid: r.paid, status: r.status, probe: r.probe, usable: usable(r) }));
}

// A numeric-option refusal is a usage refusal: the fixed code goes
// to stderr and the process exits 2, before any run starts (a silent default is never used).
function cliBudgetRefusal(message) {
  console.error(message);
  process.exitCode = 2;
}

function cli() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log('usage: prereview.cjs review <worktree> <baseRef> [--audit-prompt <path>] [--registry <path>] [--panel free|paid|both] [--max-diff-bytes <n>] | probe [--registry <path>] [--route <id>] [--panel free|paid|both] | list [--registry <path>] [--panel free|paid|both]'); return; }
  const flag = name => {
    const i = argv.indexOf(name);
    return i >= 0 && i + 1 < argv.length ? argv.splice(i, 2)[1] : null;
  };
  const command = argv.shift();
  const run = async (promise) => {
    try { await promise; } catch (error) { console.error(String(error.message || error)); process.exitCode = 1; }
  };
  if (command === 'review') {
    const [worktree, baseRef] = argv;
    if (!worktree || !baseRef) {
      console.error('usage: prereview.cjs review <worktree> <baseRef> [--audit-prompt <path>] [--registry <path>] [--panel free|paid|both] [--max-diff-bytes <n>]');
      process.exitCode = 2;
      return;
    }
    // Every spelling of the one numeric option goes through ONE
    // parser before the run starts; a refusal is the fixed code and exit 2.
    let maxBytes;
    try {
      maxBytes = parseByteBudget(argv);
    } catch (error) {
      cliBudgetRefusal(String(error.message || error));
      return;
    }
    void run(runReview({
      worktree, baseRef,
      auditPromptPath: flag('--audit-prompt'),
      registryPath: flag('--registry'),
      panel: flag('--panel'),
      maxBytes,
    }).then(s => {
      for (const send of s.sends) console.log(send.id, send.state, send.reason || '', `${send.ms || 0} ms`);
      console.log(`diff bytes ${s.diffBytes}${s.truncated ? ' (truncated)' : ''}; routes usable ${s.usable}, ok ${s.ok}, failed ${s.failed}, refused ${s.refused}`);
      for (const file of s.files) console.log(`advisory file: ${file}`);
      if (s.advisoryError) console.log(`PREREVIEW: ${s.advisoryError}; the registry was updated first`);
      if (s.refused) console.log('PREREVIEW: send(s) refused by the shared secret scanner; see the advisory file');
      if (s.usable === 0) console.log('PREREVIEW: no usable route (probe first: prereview.cjs probe)');
    }));
    return;
  }
  if (command === 'probe') {
    void run(runProbe({
      registryPath: flag('--registry'), routeId: flag('--route'), panel: flag('--panel'),
    }).then(probes => {
      for (const p of probes) console.log(p.id, p.result, p.time, p.note || '');
    }));
    return;
  }
  if (command === 'list') {
    const registryPath = flag('--registry') || DEFAULT_REGISTRY;
    const panel = resolvePanel(flag('--panel'));
    if (!PANELS.includes(panel)) { console.error(`PREREVIEW-PANEL: ${panel} must be one of ${PANELS.join(', ')}`); process.exitCode = 1; return; }
    void run(Promise.resolve().then(() => {
      const registry = loadRegistry(registryPath);
      for (const r of listRoutes(registry, panel)) console.log(r.id, r.paid ? 'paid' : 'free', r.status, r.probe ? `${r.probe.result} ${r.probe.time || ''}` : '', r.usable ? 'usable' : 'not-usable');
    }));
    return;
  }
  console.error('usage: prereview.cjs review <worktree> <baseRef> [options] | probe [--registry <path>] [--route <id>] [--panel free|paid|both] | list [--registry <path>] [--panel free|paid|both]');
  process.exitCode = 2;
}

module.exports = {
  SCHEMA, ADVISORY_SCHEMA, ADVISORY_MODE, DEFAULT_PANEL, PANELS, STATUSES, SYSTEM_PROMPT, PROBE_USER,
  DEFAULT_TIMEOUT_MS, MAX_RESPONSE_BYTES, REASONING_FIELDS,
  validateRegistry, loadRegistry, updateRegistry, withRegistryLock, writeRegistryAtomic,
  usable, panelAdmits, usableRoutes, resolvePanel, resolveEndpoint, finalEndpoint, validEndpoint,
  readDiff, truncateUtf8, readAuditPrompt, capCharacters, buildMessages, buildBody, scanAssembledBody,
  escapeForOperator, excludeKey,
  resolveBase, parseByteBudget,
  sendRoute, readResponse, readCapped, classifyError, outcomeFromError, pidAlive, stealStaleLock,
  advisoryRoot, advisoryHome, advisoryFileName, ensureAdvisoryHome, guardAdvisoryPath, serializeAdvisory, advisoryPayload, advisoryAnswer,
  writeAdvisory, setAdvisoryWriter, isIsoTime,
  runReview, runProbe, listRoutes, cli,
};

if (require.main === module) cli();

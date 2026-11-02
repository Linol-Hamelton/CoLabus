'use strict';
// launch-marker: the ONE marker module of the launch isolation. The per-launch marker
// file is WRITTEN, READ and JUDGED here and nowhere else: work-root.cjs (the writer of every per-launch directory), launch-wrapper.cjs
// (the 12-hour keep of a failed launch) and the retention tool (the retention safety net) import this module and hold no marker parsing
// of their own. A grep-style structural test of the development repository enforces it: outside this file no production file in docs/ops
// names the marker file, parses JSON at a marker path, or reads/writes the marker file directly.
//   The READER is the shared strict reader of .ai/bin/lib/text-safe.cjs: decode owns the byte classes (a BOM, CRLF, a lone CR, a NUL and
// every invisible class refused; a link or a directory at the marker path is not a marker file) and parseJsonUnique refuses a duplicated
// key of ANY spelling, including the empty key. The fixed schema is exactly the six fields the writer writes - schema, role, name,
// wrapperPid, createdAt, keepUntil - each with its fixed type and value; a missing, extra, wrongly typed or wrongly valued field is a
// named refusal. Identities (the name) follow the CLOSED GRAMMAR of the launcher names: a short run of letters, digits,
// dot, dash and underscore, at most 64 characters, no reserved Windows device name and no placeholder word (unknown, blank, none, null,
// anonymous, unnamed, placeholder, empty) - so no space, separator, JSON-escaped invisible character or junk identity can ever be judged
// valid because it happens to parse. The same grammar governs the launch leaf name in a path (work-root.cjs launchLeafProblem delegates
// to identityProblem here), so an identity in the marker and the identity in the path can never drift apart.
//   markerState(dir, io) is the TRI-STATE judgment: { present: false } when the directory carries no marker file at
// all (the only case a name allow-list may be consulted, and only by the patterns that need no marker), { present: true, ok: true,
// fields } for a marker of the fixed schema, and { present: true, ok: false, problem } for a marker that is present but REFUSED - which
// is FINAL: the directory is KEPT, never reaches a deletion plan, and no name pattern is ever consulted for it. Unknown never becomes
// permission. TRUST BOUNDARY (PROTO-DEC-0217 item 1): a same-user process that swaps the marker between the check and the use is inside
// the trust boundary; the strict reader refuses what it cannot name instead of guessing.
//   writeLaunchMarker(dir, fields, io): the strict writer - it refuses (and never writes) any field set the reader would refuse, so the
// writer and the reader cannot disagree. updateKeepUntil(dir, keepUntil, io): reads through the same strict reader and writes the new
// deadline; a marker the reader refuses is NEVER repaired or overwritten, the problem is returned and the bytes stay as they are.
const fs = require('node:fs');
const path = require('node:path');
const { decode, parseJsonUnique } = require('../../../.ai/bin/lib/text-safe.cjs');

const LAUNCH_TMP_MARKER = '.colabs-launch-tmp.json';
// The role the marker of a per-launch directory carries: retention finds a kept directory by this marker file, never by a name pattern.
const LAUNCH_TMP_ROLE = 'work-root-launch-dir';
const MARKER_FIELDS = ['schema', 'role', 'name', 'wrapperPid', 'createdAt', 'keepUntil'];
const MAX_IDENTITY_LENGTH = 64; // the same ceiling the launch wrapper puts on a launch name
const PLACEHOLDER_IDENTITY = new Set(['unknown', 'blank', 'none', 'null', 'anonymous', 'unnamed', 'placeholder', 'empty', 'tbd']);

// ---- the closed identity grammar ----
// Pure: null when the identity is a short safe run fit for a marker field and a path leaf, else the reason it is refused. The grammar is
// the one the launcher uses for names, plus the placeholder refusal: a marker or a path that claims an identity outside it is refused
// before anything is created, matched or removed.
function identityProblem(name) {
  if (typeof name !== 'string' || !name) return 'the launch name is empty or not a string';
  if (name.length > MAX_IDENTITY_LENGTH) return `the launch name is longer than ${MAX_IDENTITY_LENGTH} characters`;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) return 'the launch name must be one safe path segment (letters, digits, dot, dash, underscore)';
  if (name.endsWith('.')) return 'the launch name must not end with a dot';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(name)) return 'the launch name must not be a reserved Windows device name';
  if (PLACEHOLDER_IDENTITY.has(name.toLowerCase())) return 'the launch name must not be a placeholder word (unknown, blank, none, null, anonymous, unnamed, placeholder, empty, tbd)';
  return null;
}

// ---- the fixed schema ----
function markerIsoProblem(value) {
  if (typeof value !== 'string') return 'not a string';
  const ms = Date.parse(value);
  if (!Number.isFinite(ms)) return 'not a valid ISO time';
  if (new Date(ms).toISOString() !== value) return 'the round trip does not reproduce the written spelling';
  return null;
}
// Pure: null for a marker of the fixed schema, else { code, detail } with a named reason.
function markerProblem(marker) {
  const missing = MARKER_FIELDS.filter(f => !Object.hasOwn(marker, f));
  if (missing.length) return { code: 'MARKER_MISSING_FIELD', detail: `missing field(s): ${missing.join(', ')}` };
  const extra = Object.keys(marker).filter(f => !MARKER_FIELDS.includes(f));
  if (extra.length) return { code: 'MARKER_UNEXPECTED_FIELD', detail: `unexpected field(s): ${extra.join(', ')}` };
  if (marker.schema !== 'launch-tmp/1') return { code: 'MARKER_WRONG_SCHEMA', detail: 'the schema is not the fixed launch-tmp/1' };
  if (marker.role !== LAUNCH_TMP_ROLE) return { code: 'MARKER_WRONG_ROLE', detail: `the role is not the fixed launch-directory role ${LAUNCH_TMP_ROLE}` };
  const identity = identityProblem(marker.name);
  if (identity) return { code: 'MARKER_BAD_NAME', detail: `name: ${identity}` };
  if (!Number.isSafeInteger(marker.wrapperPid) || marker.wrapperPid < 1) return { code: 'MARKER_BAD_WRAPPER_PID', detail: 'wrapperPid is not a positive safe integer' };
  const createdAt = markerIsoProblem(marker.createdAt);
  if (createdAt) return { code: 'MARKER_BAD_CREATED_AT', detail: `createdAt: ${createdAt}` };
  if (marker.keepUntil !== null) {
    const keepUntil = markerIsoProblem(marker.keepUntil);
    if (keepUntil) return { code: 'MARKER_BAD_KEEP_UNTIL', detail: `keepUntil: ${keepUntil}` };
  }
  return null;
}

// readLaunchMarker(dir, io): { ok: true, fields } for a marker of the fixed schema, else { ok: false, problem: { code, detail } } with a
// named reason. The ONLY reader of the marker file: decode as a whole, parseJsonUnique, the fixed schema, nothing else.
function readLaunchMarker(dir, io = fs) {
  let bytes;
  try { bytes = io.readFileSync(path.join(dir, LAUNCH_TMP_MARKER)); }
  catch { return { ok: false, problem: { code: 'MARKER_UNREADABLE', detail: 'the marker file cannot be read' } }; }
  const dec = decode(bytes, { invisible: 'refuse' });
  if (!dec.ok) return { ok: false, problem: { code: `MARKER_DECODE_${dec.problems[0].code}`, detail: dec.problems[0].detail } };
  let marker;
  try { marker = parseJsonUnique(dec.text); }
  catch (e) { return { ok: false, problem: { code: `MARKER_${(e && e.code) || 'JSON'}`, detail: String((e && e.message) || e).slice(0, 120) } }; }
  if (!marker || typeof marker !== 'object' || Array.isArray(marker)) return { ok: false, problem: { code: 'MARKER_NOT_OBJECT', detail: 'the marker is not a JSON object' } };
  const problem = markerProblem(marker);
  if (problem) return { ok: false, problem };
  return { ok: true, fields: marker };
}

// markerState(dir, io): the tri-state judgment. present: false means NO marker file at all - the only case a name
// allow-list may judge the directory (and only by the patterns that need no marker). A marker that is present, whatever it says, puts
// the directory under the marker's judgment alone: valid is a match, refused is FINAL and the directory is KEPT.
function markerState(dir, io = fs) {
  let st;
  try { st = io.lstatSync(path.join(dir, LAUNCH_TMP_MARKER)); }
  catch (e) {
    if (e && e.code === 'ENOENT') return { present: false };
    return { present: true, ok: false, problem: { code: 'MARKER_UNREADABLE', detail: 'the marker file cannot be stat\'d' } };
  }
  if (!st.isFile()) return { present: true, ok: false, problem: { code: 'MARKER_NOT_A_FILE', detail: 'the marker path is not a plain file (a link or a directory is not a marker)' } };
  const read = readLaunchMarker(dir, io);
  return read.ok ? { present: true, ok: true, fields: read.fields } : { present: true, ok: false, problem: read.problem };
}

// The strict writer: it never writes a field set the reader would refuse, so the writer and the reader cannot drift apart. Returns the
// fields it wrote; throws with the marker's named problem code when the fields are not the fixed schema.
function writeLaunchMarker(dir, fields, io = fs, options = {}) {
  const problem = (fields && typeof fields === 'object' && !Array.isArray(fields)) ? markerProblem(fields) : { code: 'MARKER_NOT_OBJECT', detail: 'the marker is not a JSON object' };
  if (problem) throw Object.assign(new Error(`the launch marker is refused and never written: ${problem.code} (${problem.detail})`), { code: problem.code });
  const file = path.join(dir, LAUNCH_TMP_MARKER);
  const bytes = `${JSON.stringify(fields, null, 2)}\n`;
  if (!options.exclusive) io.writeFileSync(file, bytes, 'utf8');
  else {
    // Creation is exclusive; the creator holds the exact file identity even if
    // writing or flushing fails. No rename, shared scratch file or foreign overwrite.
    const fd = io.openSync(file, 'wx', 0o600);
    let failure;
    try {
      if (options.onCreate) options.onCreate(io.fstatSync(fd, { bigint: true }));
      io.writeFileSync(fd, bytes, 'utf8');
      io.fsyncSync(fd);
    } catch (e) { failure = e; throw e; }
    finally {
      try { io.closeSync(fd); } catch (e) { if (!failure) throw e; }
    }
  }
  return fields;
}

// The keep-deadline update of the launch wrapper. A marker the strict reader refuses is NEVER repaired or overwritten: its
// problem is returned and the bytes stay exactly as they are. A valid marker gets the new deadline through the strict writer.
function updateKeepUntil(dir, keepUntil, io = fs) {
  const state = markerState(dir, io);
  if (!state.present) return { ok: false, problem: { code: 'MARKER_ABSENT', detail: 'the directory carries no marker file' } };
  if (!state.ok) return { ok: false, problem: state.problem };
  const problem = markerIsoProblem(keepUntil);
  if (problem) throw Object.assign(new Error(`keepUntil: ${problem}`), { code: 'MARKER_BAD_KEEP_UNTIL' });
  const fields = { ...state.fields, keepUntil };
  writeLaunchMarker(dir, fields, io);
  return { ok: true, fields };
}

module.exports = {
  LAUNCH_TMP_MARKER, LAUNCH_TMP_ROLE, MARKER_FIELDS, MAX_IDENTITY_LENGTH, PLACEHOLDER_IDENTITY,
  identityProblem, markerProblem, markerIsoProblem, readLaunchMarker, markerState, writeLaunchMarker, updateKeepUntil,
};

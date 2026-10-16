'use strict';

// Failover event recorder and resolver recommendation (P-L3-004 R-L3-004.11).
// PROTO-DEC-0148 scopes manual switches; 0174 item 5 motivates machine names.
// No model is launched or selected here. Explicit dispatch routes stay mandatory.
// Shared text-safe owns decoding and unique JSON keys; path-safe owns names,
// ancestry and hardlink checks. Absolute external destinations remain supported
// with a volume-root guard, never with a safety exemption.
// The append unit is LF + JSON + LF in ONE write; leading framing isolates any
// previous crash fragment. Blank separators are visible reader counts. Short
// writes are refused or retried once as a WHOLE frame when concurrent growth is
// observed. No foreign bytes are truncated. fsync precedes close on success.
// This assumes ordinary local append-write semantics, not a lying OS/filesystem.
// Path rechecks narrow TOCTOU; they do not provide portable handle-relative I/O,
// exactly-once delivery, directory-entry durability or power-loss certification.
// All system errors, including close, publish only an allowlisted error code.
// Known secret patterns are rejected/redacted; arbitrary credentials cannot be
// recognized universally. Explicit CLI path output deliberately names the target.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const textSafe = require('./lib/text-safe.cjs');
const pathSafe = require('./lib/path-safe.cjs');
const { findSecretLeak } = require('./protocol-hooks.cjs');

const SCHEMA = 'failover-event/1';

const cliSafe = (s) => (findSecretLeak(String(s)) ? '[redacted]' : String(s)).replace(/[^\x20-\x7E]/g, (ch) => {
  const cp = ch.codePointAt(0);
  return `\\u${cp.toString(16).padStart(4, '0')}`;
});

// Closed failure-class grammar. Mirrors FAILURE_CLASSES of
// .ai/bin/protocol-dispatch/executor.cjs;  fails on drift.
const FAILURE_CLASSES = [
  'AUTH_ERROR',
  'RATE_LIMIT',
  'QUOTA_EXHAUSTED',
  'MODEL_UNAVAILABLE',
  'NETWORK_ERROR',
  'PROVIDER_ERROR',
  'PROCESS_CRASH',
  'INVALID_OUTPUT',
  'STALL',
  'TIMEOUT',
  'CONFIG_ERROR',
  'POLICY_FAILURE'
];

const FALL_KINDS = ['no-resume', 'wake-budget-exhausted', 'three-refusals'];
const NEXT_ROUTE_SOURCES = ['resolver-recommendation', 'none-remaining', 'manual-pending-owner'];

const RE_MACHINE = /^[a-z0-9][a-z0-9-]{0,23}$/;
const RE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
// A model id is route data, not a file name: the live ladder and the client registries carry
// maker-prefixed and kilo-prefixed ids with '/' and ':' (for example deepseek/deepseek-flash,
// kilo/qwen/qwen3.8-27b:free), so the model grammar is its own, wider than RE_NAME.
const RE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,127}$/;
const RE_SLOT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const RE_RUN_ID = /^R-[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const RE_ROUTE_ROLE = /^(primary|substitute-[1-9][0-9]*)$/;
const RE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
// The disabled state is a closed word set, case-insensitive; a padded or lookalike value is
// refused (never silently used as a file name) and an empty string is refused outright.
const RE_DISABLE = /^(off|false)$/i;
const RE_LOOKALIKE_DISABLE = /^\s*(off|false|true|on)\s*$/i;

function validCalendarTime(t) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?Z$/.exec(t);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const h = Number(m[4]);
  const mi = Number(m[5]);
  const s = Number(m[6]);
  if (mo < 1 || mo > 12) return false;
  const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
  const dim = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][mo - 1];
  if (d < 1 || d > dim) return false;
  return h <= 23 && mi <= 59 && s <= 59;
}

// The event grammar is closed: an unknown key is refused, never silently dropped.
const EVENT_KEYS = ['schema', 'time', 'machine', 'runId', 'slot', 'attempt', 'route',
  'reasonClass', 'fallKind', 'nextRoute', 'nextRouteSource', 'resolverVersion'];
const ROUTE_KEYS = ['client', 'model', 'effort', 'role'];
const NEXT_ROUTE_KEYS = ['client', 'model', 'effort'];

class FailoverEventError extends Error {
  constructor(message) {
    super(cliSafe(message));
    this.name = 'FailoverEventError';
  }
}

function machineIdOf(env = process.env) {
  const raw = env && env.PROTOCOL_MACHINE_ID !== undefined ? env.PROTOCOL_MACHINE_ID : null;
  if (raw !== null && raw !== undefined) {
    if (typeof raw !== 'string' || !RE_MACHINE.test(raw)) {
      throw new FailoverEventError(`machine id fails the name grammar: ${RE_MACHINE.source}`);
    }
    return raw;
  }
  let s = String(os.hostname() || '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
  s = s.replace(/-+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return RE_MACHINE.test(s) ? s : 'machine-unknown';
}

// A default/relative destination is confined to repoRoot. An explicit absolute
// destination is checked from its volume root, including all path ancestors.
// off/false are exact case-insensitive switches; padded forms are refused.
// Return the guard root so the open descriptor can be checked against the SAME
// boundary immediately before I/O. repoRoot itself is trusted caller input.
function journalTarget(repoRoot, opts = {}, env = process.env) {
  const raw = opts && opts.failoverFile !== undefined && opts.failoverFile !== null
    ? opts.failoverFile
    : (env && env.PROTOCOL_FAILOVER_FILE !== undefined ? env.PROTOCOL_FAILOVER_FILE : null);
  if (raw === false) return { disabled: true, path: null, guarded: false };
  if (typeof raw === 'string') {
    if (RE_DISABLE.test(raw)) return { disabled: true, path: null, guarded: false };
    if (RE_LOOKALIKE_DISABLE.test(raw)) {
      throw new FailoverEventError('journal path: this value looks like a switch, not a path; disable with exactly "off" or false');
    }
    if (raw === '') {
      throw new FailoverEventError('journal path: an empty value is refused; unset the variable or use "off"');
    }
  }
  const guardedInside = (candidate) => {
    const inside = pathSafe.realInside(repoRoot, candidate, { refuseHardlinks: true });
    if (!inside.ok) {
      throw new FailoverEventError(`journal path is not inside the repository root: ${inside.reason}: ${inside.detail}`);
    }
    return inside;
  };
  if (raw === true || raw === undefined || raw === null) {
    // the derived default path goes through the same real-path guard as a relative path
    // (F-03: a junction at <root>/.ai/runtime used to redirect the default journal out)
    const derived = path.join(repoRoot, '.ai', 'runtime', `executor-failover-${machineIdOf(env)}.jsonl`);
    return { disabled: false, path: guardedInside(derived).real, guarded: true, guardRoot: repoRoot };
  }
  if (typeof raw !== 'string') {
    throw new FailoverEventError('journal path must be a string, "off" or false');
  }
  if (path.isAbsolute(raw)) {
    // The caller chooses the location, never an exemption from link/name checks.
    // A volume root is the boundary so EVERY ancestor of an external target is walked.
    const guardRoot = path.parse(raw).root;
    const checked = pathSafe.realInside(guardRoot, raw, { refuseHardlinks: true });
    if (!checked.ok) throw new FailoverEventError(`journal path refused: ${checked.reason}`);
    return { disabled: false, path: checked.real, guarded: true, guardRoot };
  }
  return { disabled: false, path: guardedInside(raw).real, guarded: true, guardRoot: repoRoot };
}

function buildEvent(raw, env = process.env, opts = {}) {
  const complete = Boolean(opts && opts.complete);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new FailoverEventError('event must be an object');
  }
  if (findSecretLeak(JSON.stringify(raw))) throw new FailoverEventError('event contains a secret pattern');
  const unknown = Object.keys(raw).filter(k => !EVENT_KEYS.includes(k));
  if (unknown.length) {
    throw new FailoverEventError(`unknown event key: ${unknown.join(', ')}`);
  }
  const bad = (what, why) => new FailoverEventError(`${what}: ${why}`);
  const strOrNull = (v, what) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string' || v === '') throw bad(what, 'must be a non-empty string or null');
    return v;
  };

  if (raw.schema !== undefined && raw.schema !== SCHEMA) {
    throw bad('schema', `must be ${SCHEMA}`);
  }
  if (complete && raw.schema === undefined) {
    throw bad('schema', `required in a journal line: must be ${SCHEMA}`);
  }

  let time = strOrNull(raw.time, 'time');
  if (time !== null) {
    if (!RE_TIME.test(time) || !validCalendarTime(time)) {
      throw bad('time', 'must be a real ISO-8601 UTC calendar stamp');
    }
  } else if (complete) {
    throw bad('time', 'required in a journal line: a real ISO-8601 UTC calendar stamp');
  } else {
    time = new Date().toISOString().replace(/(\.\d{3})?Z$/, 'Z');
  }

  let machine = strOrNull(raw.machine, 'machine');
  if (machine === null) {
    if (complete) throw bad('machine', `required in a journal line: must match ${RE_MACHINE.source}`);
    machine = machineIdOf(env);
  }
  if (!RE_MACHINE.test(machine)) throw bad('machine', `must match ${RE_MACHINE.source}`);

  const runId = strOrNull(raw.runId, 'runId');
  if (runId !== null && !RE_RUN_ID.test(runId)) throw bad('runId', `must match ${RE_RUN_ID.source}`);

  const slot = raw.slot;
  if (typeof slot !== 'string' || !RE_SLOT.test(slot)) {
    throw bad('slot', `required, must match ${RE_SLOT.source}`);
  }

  const attempt = raw.attempt;
  if (!Number.isSafeInteger(attempt) || attempt < 1) {
    throw bad('attempt', 'required, must be a safe integer >= 1 (an unknown attempt is never 0)');
  }

  const routeIn = raw.route;
  if (!routeIn || typeof routeIn !== 'object' || Array.isArray(routeIn)) {
    throw bad('route', 'required object { client, model, effort, role }');
  }
  const unknownRoute = Object.keys(routeIn).filter(k => !ROUTE_KEYS.includes(k));
  if (unknownRoute.length) {
    throw bad('route', `unknown key: ${unknownRoute.join(', ')}`);
  }
  if (typeof routeIn.client !== 'string' || !RE_NAME.test(routeIn.client)) {
    throw bad('route.client', `required, must match ${RE_NAME.source}`);
  }
  const model = strOrNull(routeIn.model, 'route.model');
  if (model !== null && !RE_MODEL.test(model)) throw bad('route.model', `must match ${RE_MODEL.source}`);
  const effort = strOrNull(routeIn.effort, 'route.effort');
  if (effort !== null && !RE_NAME.test(effort)) throw bad('route.effort', `must match ${RE_NAME.source}`);
  const role = strOrNull(routeIn.role, 'route.role');
  if (role !== null && !RE_ROUTE_ROLE.test(role)) throw bad('route.role', `must match ${RE_ROUTE_ROLE.source}`);

  const reasonClass = raw.reasonClass;
  if (typeof reasonClass !== 'string' || !FAILURE_CLASSES.includes(reasonClass)) {
    throw bad('reasonClass', `required, one of ${FAILURE_CLASSES.join(', ')}`);
  }
  const fallKind = strOrNull(raw.fallKind, 'fallKind');
  if (fallKind !== null && !FALL_KINDS.includes(fallKind)) {
    throw bad('fallKind', `null or one of ${FALL_KINDS.join(', ')}`);
  }

  const nextRouteIn = raw.nextRoute === undefined ? null : raw.nextRoute;
  let nextRoute = null;
  if (nextRouteIn !== null) {
    if (!nextRouteIn || typeof nextRouteIn !== 'object' || Array.isArray(nextRouteIn)) {
      throw bad('nextRoute', 'null or an object { client, model, effort }');
    }
    const unknownNext = Object.keys(nextRouteIn).filter(k => !NEXT_ROUTE_KEYS.includes(k));
    if (unknownNext.length) {
      throw bad('nextRoute', `unknown key: ${unknownNext.join(', ')}`);
    }
    if (typeof nextRouteIn.client !== 'string' || !RE_NAME.test(nextRouteIn.client)) {
      throw bad('nextRoute.client', `required, must match ${RE_NAME.source}`);
    }
    const nModel = strOrNull(nextRouteIn.model, 'nextRoute.model');
    if (nModel !== null && !RE_MODEL.test(nModel)) throw bad('nextRoute.model', `must match ${RE_MODEL.source}`);
    const nEffort = strOrNull(nextRouteIn.effort, 'nextRoute.effort');
    if (nEffort !== null && !RE_NAME.test(nEffort)) throw bad('nextRoute.effort', `must match ${RE_NAME.source}`);
    nextRoute = { client: nextRouteIn.client, model: nModel, effort: nEffort };
  }

  const nextRouteSource = strOrNull(raw.nextRouteSource, 'nextRouteSource');
  if (nextRouteSource !== null && !NEXT_ROUTE_SOURCES.includes(nextRouteSource)) {
    throw bad('nextRouteSource', `one of ${NEXT_ROUTE_SOURCES.join(', ')} or null`);
  }
  // Cross-field consistency: a recorded next route is only ever the resolver's recommendation;
  // when none remains or the owner decides, the route is null and the source says which.
  if (nextRoute !== null && nextRouteSource !== 'resolver-recommendation') {
    throw bad('nextRouteSource', 'a recorded next route must be a resolver-recommendation');
  }
  if (nextRoute === null && nextRouteSource === 'resolver-recommendation') {
    throw bad('nextRouteSource', 'resolver-recommendation without a next route');
  }
  if (nextRouteSource === null && nextRoute === null) {
    throw bad('nextRouteSource', 'a null next route needs a source (none-remaining or manual-pending-owner)');
  }

  const resolverVersion = strOrNull(raw.resolverVersion, 'resolverVersion');
  if (resolverVersion !== null && (resolverVersion.length > 200 || !/^[\x20-\x7E]+$/.test(resolverVersion))) {
    throw bad('resolverVersion', 'null or printable ASCII up to 200 characters');
  }

  return {
    schema: SCHEMA,
    time,
    machine,
    runId,
    slot,
    attempt,
    route: { client: routeIn.client, model, effort, role },
    reasonClass,
    fallKind,
    nextRoute,
    nextRouteSource,
    resolverVersion
  };
}

// Whole framed append, with bounded recovery. A single successful syscall keeps
// the event boundaries together under local append semantics. Prefixing LF avoids
// the stale tail-observation race without a lock or a destructive repair.
// All paths pass shared guards, then fd/path identity and nlink are checked.
// A substitution during open may leave an empty file outside the intended root;
// it is refused before event bytes, never deleted. The final check/write gap is
// not claimed closed against a hostile actor that can move paths/hardlink files.
function appendEvent(repoRoot, rawEvent, opts = {}, env = process.env) {
  let fd = null;
  try {
    const target = journalTarget(repoRoot, opts, env);
    if (target.disabled) return { skipped: true, path: null, bytes: 0, guarded: false };
    const event = buildEvent(rawEvent, env);
    // Self-framing: even if another writer crashes after our last check, its
    // unfinished tail cannot consume this event. Both boundaries travel in the
    // SAME write. Blank separator lines are intentionally counted by readEvents.
    const buf = Buffer.from('\n' + JSON.stringify(event) + '\n', 'utf8');
    fs.mkdirSync(path.dirname(target.path), { recursive: true });
    fd = fs.openSync(target.path, 'a+');
    if (target.guarded) {
      const g2 = pathSafe.realInside(target.guardRoot, target.path, { refuseHardlinks: true });
      const fdId = fs.fstatSync(fd);
      let st2 = null;
      try { if (g2.ok) st2 = fs.statSync(g2.real); } catch { st2 = null; }
      // Unknown file identity is refused, never assumed equal.
      const sameFile = fdId.ino !== 0 && st2 !== null && fdId.ino === st2.ino && fdId.dev === st2.dev;
      if (!g2.ok || !sameFile || fdId.nlink > 1) {
        throw new FailoverEventError(
          `journal target changed under the writer: ${g2.ok ? 'the open file is not the real journal path' : `${g2.reason}: ${g2.detail}`}`
        );
      }
    }
    const sizeBefore = fs.fstatSync(fd).size;
    const n = fs.writeSync(fd, buf, 0, buf.length);
    if (n !== buf.length && !recoverShortWrite(fd, sizeBefore, 0, n, buf)) {
      throw new FailoverEventError(`short write: ${n} of ${buf.length} bytes and no recovery`);
    }
    fs.fsyncSync(fd);
    return { skipped: false, path: target.path, bytes: buf.length, guarded: target.guarded === true };
  } catch (e) {
    if (e instanceof FailoverEventError) throw e;
    // every system error is wrapped: nothing that escapes appendEvent carries a raw
    // (unrendered) message, so the hook's one ERROR line is safe by construction
    throw new FailoverEventError(`journal append failed: ${systemErrorCode(e)}`);
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); }
      catch (e) { throw new FailoverEventError(`journal close failed: ${systemErrorCode(e)}`); }
    }
  }
}

// OS message strings contain caller-controlled file names and sometimes credentials.
// Diagnostics publish only a closed error-code grammar, never the raw message.
function systemErrorCode(e) {
  return typeof e?.code === 'string' && /^E[A-Z0-9_]{1,30}$/.test(e.code) ? e.code : 'IO_ERROR';
}

// The append point must be newline-terminated (class 7 recovery): a torn tail of an
// earlier crash is terminated with one "\n" so the next event lands on its own line and
// the fragment stays a line of its own. Two concurrent repairs may add two "\n" - that
// is one visible blank line, counted by the reader, never a merged event. Returns the
// number of terminator bytes written (0 or 1); a terminator that cannot land whole is
// a refusal, never a reported success.
function terminateTailIfNeeded(fd, size) {
  if (size <= 0) return 0;
  const tail = Buffer.alloc(1);
  const got = fs.readSync(fd, tail, 0, 1, size - 1);
  if (got !== 1) {
    throw new FailoverEventError(`journal tail read failed: ${got} of 1 bytes`);
  }
  if (tail[0] === 0x0A) return 0;
  const term = Buffer.from('\n', 'utf8');
  const n = fs.writeSync(fd, term, 0, term.length);
  if (n !== term.length) {
    throw new FailoverEventError(`tail terminator short write: ${n} of ${term.length} bytes`);
  }
  return term.length;
}

// Recovery of a short or lying write. Returns true when the event nevertheless landed
// whole (the one interleaved retry succeeded); every other outcome throws a
// FailoverEventError - success is never reported for a line that did not land whole.
function recoverShortWrite(fd, sizeBefore, repaired, n, buf) {
  if (!Number.isSafeInteger(n) || n < 0) throw new FailoverEventError('invalid write byte count');
  const written = Number.isSafeInteger(n) && n > 0 ? n : 0;
  if (n > buf.length) {
    throw new FailoverEventError(
      `lying write: the file system reported ${n} of ${buf.length} requested bytes; the event was not recorded`
    );
  }
  let actual = null;
  try { actual = fs.fstatSync(fd).size; } catch { actual = null; }
  const expected = sizeBefore + repaired + written;
  if (actual === expected) {
    // nobody else wrote into our window: our fragment is the tail. Terminate it (one
    // "\n") so it stays a line of its own and the next event lands whole; refuse.
    // The journal is append-only: the fragment is reported, never erased.
    terminateTailIfNeeded(fd, actual);
    fs.fsyncSync(fd);
    throw new FailoverEventError(
      `short write: ${written} of ${buf.length} bytes; the fragment is terminated and stays a counted corrupt line, the event was not recorded`
    );
  }
  if (actual === null || actual < expected) {
    // the layer reports a size no written byte count explains: no repair can be trusted
    throw new FailoverEventError(
      `short write: ${written} of ${buf.length} bytes, journal size ${actual} instead of ${expected}; the event was not recorded`
    );
  }
  // a second writer appended inside our window (actual > expected): their whole line
  // landed after our fragment; their data is never truncated. Terminate the tail if
  // needed, then write the WHOLE line once more: it lands whole (one atomic write) or
  // the event is refused - the residue fragment stays a visible corrupt line.
  terminateTailIfNeeded(fd, actual);
  const n2 = fs.writeSync(fd, buf, 0, buf.length);
  if (n2 === buf.length) return true;
  try {
    terminateTailIfNeeded(fd, fs.fstatSync(fd).size);
    fs.fsyncSync(fd);
  } catch { /* the refusal below is the answer; the terminator is best effort */ }
  throw new FailoverEventError(
    `short write with a concurrent append: ${written} then ${n2} of ${buf.length} bytes; the event was not recorded whole`
  );
}

// Tolerant reader. The bytes are decoded through the shared guard text-safe: the BOM is
// stripped, CRLF is normalised to LF, both reported; a lone CR, NUL or invalid UTF-8 is an
// explicit refusal (decodeProblems) and the journal is NOT parsed on a refusal - an unknown
// encoding never becomes a guessed count. Torn last lines, corrupt middle lines and
// duplicated whole lines are reported, never silently dropped.
function readBytesGuarded(journalPath) {
  if (typeof journalPath !== 'string' || !path.isAbsolute(journalPath)) {
    throw new FailoverEventError('read path must be absolute');
  }
  const target = journalTarget(path.parse(journalPath).root,
    { failoverFile: journalPath }, {});
  const checked = pathSafe.realInside(target.guardRoot, target.path, { refuseHardlinks: true });
  if (!checked.ok) throw new FailoverEventError(`journal read refused: ${checked.reason}`);
  if (!checked.exists) return null;
  const read = pathSafe.readFileGuarded(target.guardRoot, target.path);
  if (!read.ok) throw new FailoverEventError(`journal read refused: ${read.reason}`);
  return read.bytes;
}

function readEvents(journalPath) {
  const out = {
    exists: false, events: [], torn: 0, missingNewline: false, corrupt: [],
    duplicates: 0, blank: 0, bytes: 0, decodeProblems: [], decodeNotes: []
  };
  const buf = readBytesGuarded(journalPath);
  if (buf === null) return out;
  out.exists = true;
  out.bytes = buf.length;
  const dec = textSafe.decode(buf, { bom: 'strip', crlf: 'normalise' });
  if (!dec.ok) {
    out.decodeProblems = dec.problems.map(p => ({
      code: p.code, detail: p.detail, line: p.line === undefined ? null : p.line,
      column: p.column === undefined ? null : p.column
    }));
    return out;
  }
  out.decodeNotes = dec.notes.map(p => ({ code: p.code, line: p.line === undefined ? null : p.line }));
  const text = dec.text === null ? '' : dec.text;
  if (text === '') return out;
  const rawLines = text.split('\n');
  const endsWithNewline = text.endsWith('\n');
  const seen = new Map();
  for (let i = 0; i < rawLines.length; i++) {
    const line = rawLines[i];
    const isLast = i === rawLines.length - 1;
    if (line === '') {
      if (isLast && endsWithNewline) continue;
      if (isLast) { out.torn++; continue; }
      out.blank++;
      continue;
    }
    let parsed;
    try {
      parsed = textSafe.parseJsonUnique(line);
    } catch (e) {
      if (e.code === 'JSON_DUPLICATE_KEY') {
        out.corrupt.push({ line: i + 1, reason: 'duplicate JSON key' });
        continue;
      }
      if (isLast) out.torn++; else out.corrupt.push({ line: i + 1, reason: 'not JSON' });
      continue;
    }
    try {
      const event = buildEvent(parsed, process.env, { complete: true });
      if (isLast && !endsWithNewline) out.missingNewline = true;
      const canonical = JSON.stringify(event);
      if (seen.has(canonical)) {
        out.duplicates++;
      } else {
        seen.set(canonical, true);
      }
      out.events.push(event);
    } catch (e) {
      // a parseable line that is not a complete valid event is CORRUPT DATA at any
      // position, never a torn line: torn is a physical truncation that fails JSON.parse,
      // and damaged data is never masked as transport damage
      out.corrupt.push({ line: i + 1, reason: e.message });
    }
  }
  return out;
}

// ---------- CLI ----------

function usage() {
  console.log('USAGE:');
  console.log('  record --slot <id> --route <client[:model]> --class <class> --attempt <n>');
  console.log('         [--run-id <id>] [--fall-kind <no-resume|wake-budget-exhausted|three-refusals>]');
  console.log('         [--effort <e>] [--role <primary|substitute-N>] [--journal <path|off>] [--repo-root <dir>]');
  console.log('         [--dispatch <file> --slot <id>]  (next route: the resolver recommendation only)');
  console.log('  read   [--journal <path>] [--repo-root <dir>]');
  console.log('  path   [--journal <path>] [--repo-root <dir>]');
}

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--slot' || a === '--route' || a === '--class' || a === '--attempt' || a === '--run-id'
      || a === '--fall-kind' || a === '--effort' || a === '--role' || a === '--journal' || a === '--repo-root'
      || a === '--dispatch') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) {
        console.log(`ERROR reason=missing-flag-value flag=${cliSafe(a)}`);
        process.exit(2);
      }
      if (Object.hasOwn(opts, a)) {
        console.log(`ERROR reason=duplicate-flag flag=${cliSafe(a)}`);
        process.exit(2);
      }
      opts[a] = v;
    } else {
      console.log(`ERROR reason=unknown-flag flag=${cliSafe(a)}`);
      process.exit(2);
    }
  }
  return opts;
}

function resolverRecommendation(dispatchFile, slotId, currentRoute, opts) {
  const repoRoot = opts.repoRoot ? path.resolve(opts.repoRoot) : path.resolve(__dirname, '..', '..');
  const registry = require('./protocol-dispatch/registry.cjs');
  const resolver = require('./protocol-dispatch/resolver.cjs');
  const readControl = file => {
    const bytes = readBytesGuarded(file);
    if (bytes === null) return null;
    const decoded = textSafe.decode(bytes, { bom: 'strip', crlf: 'normalise' });
    if (!decoded.ok) throw new FailoverEventError('control JSON decoding refused');
    let value;
    try { value = textSafe.parseJsonUnique(decoded.text); }
    catch { throw new FailoverEventError('control JSON syntax or duplicate key refused'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new FailoverEventError('control JSON must be an object');
    return { value, bytes };
  };
  // Validate the SAME bytes we parsed: no second path read can substitute a source.
  const dispatchTarget = journalTarget(repoRoot, {failoverFile: dispatchFile}, {});
  if (dispatchTarget.disabled) return {error:'dispatch-disabled', detail:'a file is required'};
  const source = readControl(dispatchTarget.path);
  if (!source) return {error:'dispatch-missing', detail:'a file is required'};
  const dispatch = registry.validateDispatch(source.value);
  const slots = (dispatch.slots || dispatch.jobs || []).filter(s => s.id === slotId);
  if (slots.length > 1) return { error: 'slot-ambiguous', detail: 'duplicate slot identity' };
  const slot = slots[0];
  if (!slot) return { error: 'slot-not-found', detail: slotId };
  const ladderPath = path.resolve(repoRoot, 'docs/ops/model-ladder.json');
  let ladder = null;
  try {
    const source = readControl(ladderPath);
    if (source) {
      ladder = source.value;
      Object.defineProperty(ladder, 'fileSha256', { value: require('node:crypto').createHash('sha256').update(source.bytes).digest('hex'), enumerable: false });
    }
  } catch { return { error: 'ladder-unreadable', detail: 'existing ladder cannot be read' }; }
  const resolution = resolver.resolveSlot(slot, ladder || {}, {}, { skipProbe: true });
  const plan = [];
  if (resolution.primary) plan.push(resolution.primary);
  for (const s of (resolution.substitutes || [])) plan.push(s);
  const matches = [];
  for (let i = 0; i < plan.length; i++) {
    const r = plan[i];
    if ((r.client || null) === (currentRoute.client || null)
      && (r.model || null) === (currentRoute.model || null)
      && (r.effort || null) === (currentRoute.effort || null)) {
      matches.push(i);
    }
  }
  const routeText = `${currentRoute.client}:${currentRoute.model === null || currentRoute.model === undefined ? '' : currentRoute.model}`
    + (currentRoute.effort ? ` effort=${currentRoute.effort}` : '');
  if (matches.length === 0) {
    return { error: 'route-not-in-plan', detail: routeText };
  }
  if (matches.length > 1) {
    return { error: 'route-ambiguous-in-plan', detail: `${routeText} matches ${matches.length} plan entries` };
  }
  const next = plan[matches[0] + 1] || null;
  return {
    resolution,
    nextRoute: next ? { client: next.client, model: next.model || null, effort: next.effort || null } : null,
    nextRouteSource: next ? 'resolver-recommendation' : 'none-remaining'
  };
}

function main(argv) {
  const cmd = argv[0];
  const opts = parseArgs(argv.slice(1));
  if (cmd !== 'record' && cmd !== 'read' && cmd !== 'path') {
    usage();
    return 2;
  }
  const repoRoot = opts['--repo-root'] ? path.resolve(opts['--repo-root']) : path.resolve(__dirname, '..', '..');
  let journalOverride = opts['--journal'];
  if (journalOverride === undefined && process.env.PROTOCOL_FAILOVER_FILE !== undefined) {
    journalOverride = process.env.PROTOCOL_FAILOVER_FILE;
  }

  try {
    if (cmd === 'path') {
      const target = journalTarget(repoRoot, { failoverFile: journalOverride });
      if (target.disabled) {
        console.log('JOURNAL disabled=true');
        return 0;
      }
      console.log(`JOURNAL path=${cliSafe(target.path)}`);
      return 0;
    }

    if (cmd === 'read') {
      const target = journalTarget(repoRoot, { failoverFile: journalOverride });
      if (target.disabled) {
        console.log('JOURNAL disabled=true');
        return 0;
      }
      const r = readEvents(target.path);
      for (const p of r.decodeProblems) {
        console.log(`DECODE code=${p.code} line=${p.line === null ? '-' : p.line} column=${p.column === null ? '-' : p.column} detail="${cliSafe(p.detail)}"`);
      }
      for (const n of r.decodeNotes) {
        console.log(`NOTE decode code=${n.code} line=${n.line === null ? '-' : n.line}`);
      }
      for (const ev of r.events) console.log(`EVENT ${JSON.stringify(ev)}`);
      console.log(`SUMMARY exists=${r.exists} events=${r.events.length} torn=${r.torn} missingNewline=${r.missingNewline} corrupt=${r.corrupt.length} duplicates=${r.duplicates} blank=${r.blank} bytes=${r.bytes} decodeProblems=${r.decodeProblems.length} decodeNotes=${r.decodeNotes.length}`);
      if (r.torn) console.log('NOTE torn-last-line tolerated and excluded');
      for (const c of r.corrupt) console.log(`CORRUPT line=${c.line} reason="${cliSafe(c.reason)}"`);
      // a journal with damage (a torn tail or a corrupt line) is never a clean pass;
      // duplicates are a data-quality warning: counted and printed, exit 0
      return (r.corrupt.length || r.torn || r.decodeProblems.length) ? 1 : 0;
    }

    // record
    if (!opts['--slot'] || !opts['--route'] || !opts['--class'] || opts['--attempt'] === undefined) {
      console.log('ERROR reason=missing-required-flags required="--slot --route --class --attempt"');
      return 2;
    }
    const attempt = Number(opts['--attempt']);
    if (!/^[1-9][0-9]*$/.test(opts['--attempt']) || !Number.isSafeInteger(attempt) || attempt < 1) {
      console.log('ERROR reason=invalid-attempt attempt must be a safe integer >= 1');
      return 2;
    }
    // The route splits on the FIRST colon only: a model id may itself contain ':'
    // (kilo/qwen/qwen3.8-27b:free), so nothing after the first colon is ever dropped;
    // both halves then pass their closed grammars or the record is refused.
    const routeStr = String(opts['--route']);
    const sepAt = routeStr.indexOf(':');
    const route = {
      client: sepAt === -1 ? routeStr : routeStr.slice(0, sepAt),
      model: sepAt === -1 ? null : routeStr.slice(sepAt + 1),
      effort: opts['--effort'] !== undefined ? opts['--effort'] : null,
      role: opts['--role'] !== undefined ? opts['--role'] : null
    };
    let nextRoute = null;
    let nextRouteSource = 'manual-pending-owner';
    let resolverVersion = null;
    if (opts['--dispatch']) {
      const output = journalTarget(repoRoot, { failoverFile: journalOverride });
      const input = journalTarget(repoRoot, { failoverFile: opts['--dispatch'] }, {});
      const ladderInput = path.resolve(repoRoot, 'docs/ops/model-ladder.json');
      if (!output.disabled && !input.disabled &&
          (pathSafe.sameFileOrNested(output.path, input.path) || pathSafe.sameFileOrNested(output.path, ladderInput))) {
        throw new FailoverEventError('journal overlaps a recommendation input');
      }
      const rec = resolverRecommendation(opts['--dispatch'], opts['--slot'], route, { repoRoot });
      if (rec.error) {
        console.log(`ERROR reason=${rec.error} detail="${cliSafe(rec.detail)}"`);
        return 1;
      }
      nextRoute = rec.nextRoute;
      nextRouteSource = rec.nextRouteSource;
      resolverVersion = rec.resolution ? (rec.resolution.ladderVersion || null) : null;
    }
    const res = appendEvent(repoRoot, {
      slot: opts['--slot'],
      attempt,
      runId: opts['--run-id'] !== undefined ? opts['--run-id'] : null,
      route,
      reasonClass: opts['--class'],
      fallKind: opts['--fall-kind'] !== undefined ? opts['--fall-kind'] : null,
      nextRoute,
      nextRouteSource,
      resolverVersion
    }, { failoverFile: journalOverride });
    if (res.skipped) {
      console.log('RECORD skipped=true reason=writer-off');
      return 0;
    }
    console.log(`RECORD path=${cliSafe(res.path)} bytes=${res.bytes}`);
    return 0;
  } catch (e) {
    if (e instanceof FailoverEventError) {
      console.log(`ERROR reason=invalid-event detail="${cliSafe(e.message)}"`);
      return 1;
    }
    console.log(`ERROR reason=failover-journal-failed detail="${systemErrorCode(e)}"`);
    return 1;
  }
}

if (require.main === module) {
  process.exit(main(process.argv.slice(2)));
}

module.exports = {
  SCHEMA,
  FAILURE_CLASSES,
  machineIdOf,
  journalTarget,
  buildEvent,
  appendEvent,
  readEvents,
  FailoverEventError
};

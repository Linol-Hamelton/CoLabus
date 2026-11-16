'use strict';
// summary.cjs - the bounded ROUTE-STATE summary of the SessionStart injection
// (PROTO-DEC-0235 item 3b, guarantee K6).
//
//   load(root)            the only impure part: reads the record through route-state.cjs loadRecord (no second
//                         reader) and looks whether the operator duties file exists. It never throws: a refusal of
//                         the reader becomes { ok: false, code, detail }.
//   summary(loaded, now)  pure: the text of the block. `now` is the caller's ISO time, never read here. The text
//                         is at most CAP_BYTES bytes of UTF-8 (opts.cap overrides it for the full listing of the
//                         command line below). It is never empty: an unreadable or missing record is one loud line
//                         that starts with "ROUTE-STATE UNREADABLE:".
//
// Per route the summary names the id, the state (ok, FAILED, STALE, UNKNOWN), the reasons of route-state.cjs
// stateAt, and the age of the evidence: the probe and every required declared field. A declared value is printed
// only from the view of stateAt, which is null once the value has expired or is dated in the future; such a value
// is printed as "expired" or "future" and withheld, never as current. Routes are listed by state (ok, FAILED,
// STALE, UNKNOWN: the launchable and the broken first), in the order of the record within a state; the routes
// that do not fit under the cap are counted in the closing line, which is always present.
//
// Command line: node tools/operator-knowledge/summary.cjs [--full]   (--full lifts the cap; exit 0 always prints)

const fs = require('node:fs');
const path = require('node:path');
const rs = require('./route-state.cjs');

const CAP_BYTES = 1500;
const RECORD_REL = 'docs/ops/route-state.json';
const SCHEMA_REL = 'docs/ops/route-state.schema.json';
// Stage 4 of OPERATOR-KNOWLEDGE writes this procedure (PROTO-DEC-0235 item 4); until then the pointer says so.
const DUTIES_REL = 'docs/ops/OPERATOR-DUTIES.md';
const VALUE_CHARS = 32;
const ORDER = Object.freeze(['ok', 'FAILED', 'STALE', 'UNPROVEN', 'UNKNOWN']);
const DETAIL_CHARS = 300;
const LINE_BYTES = 300;
const UNREADABLE = 'ROUTE-STATE UNREADABLE:';

const bytes = text => Buffer.byteLength(text, 'utf8');

// One visible line: control characters and line breaks become spaces, then the text is cut by code points.
function clip(text, chars) {
  const flat = String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').trim();
  const points = Array.from(flat);
  return points.length <= chars ? flat : `${points.slice(0, chars - 3).join('')}...`;
}

// Cut a line to a byte budget on a code point boundary.
function clipBytes(text, max) {
  if (bytes(text) <= max) return text;
  const points = Array.from(text);
  let out = '';
  for (const point of points) {
    if (bytes(out) + bytes(point) + 3 > max) break;
    out += point;
  }
  return `${out}...`;
}

function age(ms) {
  if (!Number.isFinite(ms)) return 'unknown';
  if (ms < 0) return 'in the future';
  const minutes = Math.floor(ms / 60000);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

function load(root, opts = {}) {
  const duties = { path: DUTIES_REL, written: fs.existsSync(path.join(root, ...DUTIES_REL.split('/'))) };
  const file = path.join(root, ...RECORD_REL.split('/'));
  if (!fs.existsSync(file)) return { ok: false, code: 'RECORD_MISSING', detail: `${RECORD_REL} does not exist`, recordPath: RECORD_REL, duties };
  try {
    const record = rs.loadRecord(file, { schemaFile: path.join(root, ...SCHEMA_REL.split('/')) });
    const launches = opts.launches === undefined ? require('./launch-evidence.cjs').readLiveLaunches() : opts.launches;
    return { ok: true, record, launches, recordPath: RECORD_REL, duties };
  } catch (error) {
    const code = error instanceof rs.Refusal ? error.code : 'RECORD_READ_ERROR';
    const detail = error instanceof rs.Refusal ? error.detail : String((error && error.message) || error);
    return { ok: false, code, detail, recordPath: RECORD_REL, duties };
  }
}

function dutiesLine(duties) {
  const where = (duties && typeof duties.path === 'string') ? duties.path : DUTIES_REL;
  return duties && duties.written
    ? `Operator duties: ${where}`
    : `Operator duties: ${where} (not written yet; the project writes it).`;
}

function displayState(row) {
  if (row.state === 'ok') return 'ok';
  if (row.state === 'failed') return 'FAILED';
  const expiredOnly = row.reasons.length > 0 && row.reasons.every(r => r === 'PROBE_EXPIRED' || r.startsWith('DECLARED_EXPIRED:'));
  // PROBE-SERVED-MODEL: the route answered and every declared field is fresh, but the served model is not proven
  if (row.reasons.length === 1 && row.reasons[0] === 'SERVED_UNPROVEN') return 'UNPROVEN';
  return expiredOnly ? 'STALE' : 'UNKNOWN';
}

function fieldText(name, view, nowMs) {
  if (!view) return `${name} none`;
  const withheld = name === 'probe' ? '' : ' (withheld)';
  if (view.future) return `${name} future${withheld}`;
  if (view.expired) return `${name} expired ${age(nowMs - Date.parse(view.expiresAt))} ago${withheld}`;
  const old = age(nowMs - Date.parse(view.start));
  if (name === 'probe') return `probe ${view.value.ok === true ? (typeof view.value.served === 'string' && view.value.served ? 'ok' : 'ok, served model unproven') : view.value.reason === 'TIMEOUT' ? 'timeout' : 'failed'} ${old} old`;
  return `${name}=${JSON.stringify(clip(view.value, VALUE_CHARS))} ${old} old`;
}

function routeLine(row, route, nowMs) {
  const state = displayState(row);
  const reasons = row.state === 'ok' ? (row.warnings?.length ? ` [warning:${row.warnings.join(',')}]` : '') : ` [${row.reasons.join(',')}]`;
  const adviceEvidence = row.evidence && (row.evidence.source === 'launch' || row.fields.probe?.expired);
  const parts = adviceEvidence ? [`evidence=${row.evidence.source} ${age(nowMs - Date.parse(row.evidence.at))} old until ${row.evidence.expiresAt}`] : [fieldText('probe', row.fields.probe, nowMs)];
  if (row.evidence?.basis) parts[0] += ` basis=${row.evidence.basis}`;
  if (row.warnings?.length) parts[0] += ` warnings=${row.warnings.join(',')}`;
  for (const name of route.requiredDeclared) parts.push(fieldText(name, row.fields[name], nowMs));
  return clipBytes(`- ${clip(row.id, 64)} ${state}${reasons}; ${parts.join('; ')}`, LINE_BYTES);
}

function unreadable(loaded, why) {
  const code = loaded && typeof loaded.code === 'string' ? loaded.code : 'RECORD_READ_ERROR';
  const where = loaded && typeof loaded.recordPath === 'string' ? loaded.recordPath : RECORD_REL;
  return `${UNREADABLE} ${clip(code, 40)}: ${clip(why, DETAIL_CHARS)} (${where}). Every route is unknown until the record reads again.\n${dutiesLine(loaded && loaded.duties)}`;
}

// Pure: the same (loaded, now, opts) always gives the same text.
function summary(loaded, now, opts = {}) {
  const cap = opts.cap === undefined ? CAP_BYTES : opts.cap;
  if (!loaded || loaded.ok !== true) return unreadable(loaded, (loaded && loaded.detail) || 'no record was loaded');
  let result;
  try {
    result = rs.stateAt(loaded.record, now, { launches: loaded.launches || [], purpose: 'advice' });
  } catch (error) {
    return unreadable({ ...loaded, code: error instanceof rs.Refusal ? error.code : 'STATE_ERROR' }, (error && error.message) || String(error));
  }
  const nowMs = Date.parse(result.at);
  const counts = { ok: 0, FAILED: 0, STALE: 0, UNPROVEN: 0, UNKNOWN: 0 };
  const rows = result.routes.map((row, i) => ({ row, route: loaded.record.routes[i], state: displayState(row), i }));
  for (const item of rows) counts[item.state] += 1;
  rows.sort((a, b) => (ORDER.indexOf(a.state) - ORDER.indexOf(b.state)) || (a.i - b.i));
  const lines = rows.map(item => routeLine(item.row, item.route, nowMs));
  const generated = Date.parse(loaded.record.generatedAt);
  const head = `ROUTE-STATE at ${result.at.slice(0, 16)}Z from ${loaded.recordPath || RECORD_REL} (generated ${age(nowMs - generated)} ago): `
    + `${lines.length} routes; ok ${counts.ok}, failed ${counts.FAILED}, stale ${counts.STALE}, unknown ${counts.UNKNOWN}${counts.UNPROVEN ? `, unproven ${counts.UNPROVEN}` : ''}. `
    + 'Only an ok route has fresh evidence; a launch on any other is an unproven launch.';
  const tail = dutiesLine(loaded.duties);
  const closing = shown => `Routes shown: ${shown} of ${lines.length}; cut by the ${cap === Infinity ? 'unlimited' : `${cap}-byte`} cap: ${lines.length - shown}`
    + ' (full list: node tools/operator-knowledge/summary.cjs --full).';
  // The closing line is reserved at its longest form before any route line is placed.
  const reserve = bytes(head) + bytes(closing(0)) + bytes(tail) + 3;
  let used = reserve;
  const kept = [];
  for (const line of lines) {
    if (used + bytes(line) + 1 > cap) break;
    kept.push(line);
    used += bytes(line) + 1;
  }
  const text = [head, ...kept, closing(kept.length), tail].join('\n');
  if (bytes(text) > cap) return unreadable({ ...loaded, code: 'SUMMARY_CAP' }, `the fixed lines alone exceed the ${cap}-byte cap`);
  return text;
}

module.exports = { CAP_BYTES, RECORD_REL, SCHEMA_REL, DUTIES_REL, UNREADABLE, load, summary, age, clip, clipBytes };

if (require.main === module && (process.argv.includes('--help') || process.argv.includes('-h'))) {
  process.stdout.write('usage: summary.cjs [--full]  (prints the bounded route-state summary of this repository)\n');
} else if (require.main === module) {
  const full = process.argv.slice(2).includes('--full');
  const root = path.join(__dirname, '..', '..');
  process.stdout.write(`${summary(load(root), new Date().toISOString(), full ? { cap: Infinity } : {})}\n`);
}

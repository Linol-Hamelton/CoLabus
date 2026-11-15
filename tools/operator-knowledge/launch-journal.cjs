'use strict';
// Shared journal reader extracted from refresh; no second JSONL parser.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const rs = require('./route-state.cjs');
const pathSafe = require('../../.ai/bin/lib/path-safe.cjs');
const textSafe = require('../../.ai/bin/lib/text-safe.cjs');
const kernel = require('../../.ai/bin/accounting/launch-record-validate.cjs');
const paths = require('../../.ai/bin/repo-paths.cjs');
const JOURNAL_DIR = paths.launchesDir();
const JOURNAL_FILE = path.join(JOURNAL_DIR, 'LAUNCHES.jsonl');
function defaultJournals() {
  let names = [];
  try {
    names = fs.readdirSync(JOURNAL_DIR).filter(name => /^LAUNCHES-.*\.jsonl$/.test(name)).sort();
  } catch {
    names = [];
  }
  if (!names.length) return [JOURNAL_FILE];
  return names.map(name => path.join(JOURNAL_DIR, name));
}

// Every line keeps its place (file and line number), so an invalid record is reported by name.
function readJournal(file) {
  const abs = path.resolve(file);
  const guarded = pathSafe.readFileGuarded(path.parse(abs).root, abs);
  if (!guarded.ok) throw new rs.Refusal('JOURNAL_UNREADABLE', `${guarded.reason}: ${guarded.detail}`);
  const decoded = textSafe.decode(guarded.bytes, { bom: 'refuse', crlf: 'normalise', invisible: 'refuse' });
  if (!decoded.ok) throw new rs.Refusal('JOURNAL_ENCODING', decoded.problems.map(p => p.code).join(','));
  const entries = [];
  decoded.text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      entries.push({ record: textSafe.parseJsonUnique(line), where: `${path.basename(abs)}:${i + 1}` });
    } catch (e) {
      throw new rs.Refusal('JOURNAL_JSON', `${path.basename(abs)} line ${i + 1}: ${e.code === 'JSON_DUPLICATE_KEY' ? 'a key appears twice' : 'not valid JSON'}`);
    }
  });
  return entries;
}

function readJournals(files) {
  const entries = [];
  for (const file of files) entries.push(...readJournal(file));
  return entries;
}

// What a launch record IS is decided by the kernel, never by a list of this package
// (one decider). The kernel validator launch-record-validate.cjs defines four line forms: a FULL record (it
// has startedAt and NO event field) and the three event records started, finished and review. The
// schema and the event are judged by the kernel's own field predicates (kernel.FIELDS), so every form
// the kernel accepted before this package stays accepted: a record without an event is a full record,
// never an invalid one. A record is invalid only when it is not an object, carries another schema,
// carries an event outside the kernel's events, or has no launchId (the kernel reader launches() has
// always skipped those). The reason is a closed code; refresh prints it with the first line it hit.
function launchRecordProblem(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { code: 'NOT_OBJECT', detail: 'the line is not a JSON object' };
  const [isSchema, schemaForm] = kernel.FIELDS.schema;
  if (!isSchema(rec.schema)) return { code: 'SCHEMA', detail: `schema ${foreignTag(rec.schema)} is not ${schemaForm}` };
  if (Object.hasOwn(rec, 'event')) {
    const [isEvent, eventForm] = kernel.FIELDS.event;
    if (!isEvent(rec.event)) return { code: 'EVENT', detail: `event ${foreignTag(rec.event)} is not one of ${eventForm}` };
  }
  if (typeof rec.launchId !== 'string' || !rec.launchId) return { code: 'LAUNCH_ID', detail: 'the record names no launchId' };
  // The numbers of a record (wall time, instants, exit code, tokens) are judged in ONE place,
  // measure.cjs measureLaunch, where an invalid field makes its own measure null with a named reason.
  return null;
}

// A foreign value in an invalid line is never echoed. The output names its type,
// its length and a short hash, so two reports can be compared without the text itself leaving the journal.
function foreignTag(value) {
  const text = typeof value === 'string' ? value : String(JSON.stringify(value));
  const hash = crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
  const kind = typeof value === 'string' ? `text of ${value.length} characters` : `a ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value} value`;
  return `(${kind}, sha256:${hash})`;
}


module.exports = { defaultJournals, readJournal, readJournals, launchRecordProblem };

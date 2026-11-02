'use strict';
// seat-check.cjs - operator acceptance of a certifier seat by its served model (PROTO-DEC-0169 item 4).
//   node docs/ops/seat-check.cjs --name <launch> [--launch-id <L-...>] [--pending <dir>] [--journal <LAUNCHES.jsonl>] [--authors <model>,<model>]
// Reads the launch records (the pending day files and the tracked journal), takes the newest full record whose launchId
// ends with the launch name (or equals --launch-id), prints requested vs served, and exits:
//   0  the seat is acceptable, or the launch is not a certifier/reviewer seat (the fields are only printed);
//   1  a certifier or reviewer seat whose served model is missing (servedModelSource none) or differs (match=false), whose served family differs from the
//      requested one (SERVED_FAMILY_MISMATCH), or - with --authors - whose PROVEN served model is not independent of the authors (PROBE-SERVED-MODEL:
//      the family of the served model is unknown or equals the family of an author; independence is judged on the model that answered, never the requested one);
//   2  no record found, unusable input.
// Reads files only; writes nothing. Class B operator tool; the result is advisory and never Evidence.
const fs = require('node:fs');
const path = require('node:path');
const { modelsMatch, matchWord, modelFamily, familyMatch } = require('./served-model.cjs');
const { slug, PENDING_DIR } = require('../../.ai/bin/launch-record.cjs');

const DEFAULT_JOURNAL = path.join(path.dirname(PENDING_DIR), 'LAUNCHES.jsonl');
const SEAT_ROLES = new Set(['certifier', 'reviewer']);

function value(argv, name, dflt) { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; }

function readRecords(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const rec = JSON.parse(line); if (rec && typeof rec === 'object' && rec.schema === 'launch-record/1' && typeof rec.launchId === 'string' && rec.startedAt && !rec.event) out.push(rec); } catch { /* a broken line is not a record */ }
  }
  return out;
}

function loadRecords(pendingDir, journal) {
  let files = [];
  try { files = fs.readdirSync(pendingDir).filter(n => n.endsWith('.jsonl')).sort().map(n => path.join(pendingDir, n)); } catch { /* no pending dir */ }
  if (journal && fs.existsSync(journal)) files.unshift(journal);
  return files.flatMap(readRecords);
}

function findRecord(records, { name, launchId }) {
  const suffix = name ? `-${slug(name)}` : null;
  const hits = records.filter(r => (launchId ? r.launchId === launchId : r.launchId.endsWith(suffix)));
  hits.sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
  return hits[0] || null;
}

// The verdict for one record: what it requested, what answered, and whether a seat may be accepted on it.
function assess(rec, authors = []) {
  const requested = rec.tuple && typeof rec.tuple.model === 'string' ? rec.tuple.model : null;
  const served = typeof rec.servedModel === 'string' ? rec.servedModel : null;
  const source = typeof rec.servedModelSource === 'string' ? rec.servedModelSource : 'none';
  const confidence = typeof rec.servedModelConfidence === 'string' ? rec.servedModelConfidence : 'none';
  const match = source === 'none' || !served ? 'unknown' : modelsMatch(requested, served);
  const role = typeof rec.role === 'string' ? rec.role : 'unknown';
  const seat = SEAT_ROLES.has(role);
  const servedFamily = served && source !== 'none' ? modelFamily(served) : 'unknown';
  const family = served && source !== 'none' ? familyMatch(requested, served) : 'unknown';
  const authorFamilies = authors.map(modelFamily);
  let reason = 'ok';
  if (seat && match === false) reason = `served model differs from the requested model: the seat is invalid (PROTO-DEC-0169 item 4)${family === false ? '; the maker families differ (SERVED_FAMILY_MISMATCH)' : ''}`;
  else if (seat && authors.length && source !== 'none' && servedFamily === 'unknown') reason = 'family of the proven served model is unknown: independence of the authors cannot be checked';
  else if (seat && authors.length && source !== 'none' && authorFamilies.includes('unknown')) reason = 'family of an author model is unknown: independence cannot be checked';
  else if (seat && authors.length && source !== 'none' && authorFamilies.includes(servedFamily)) reason = `proven served family ${servedFamily} is the family of an author: the seat is not independent`;
  else if (seat && source === 'none') reason = 'no served-model source: the seat cannot be accepted (PROTO-DEC-0169 item 4)';
  else if (seat && match === 'unknown') reason = 'requested model unknown: the seat cannot be compared';
  else if (!seat) reason = `role ${role} is not a certifier or reviewer seat: printed only`;
  const refused = seat && (source === 'none' || match !== true || reason !== 'ok');
  return { requested, served, source, confidence, match, role, seat, refused, reason, servedFamily, family };
}

function main(argv, deps = {}) {
  const say = deps.say || (line => process.stdout.write(`${line}\n`));
  const name = value(argv, 'name'); const launchId = value(argv, 'launch-id');
  const pendingDir = value(argv, 'pending', deps.pendingDir || PENDING_DIR);
  const journal = value(argv, 'journal', deps.journal || DEFAULT_JOURNAL);
  const authorsArg = value(argv, 'authors');
  const authors = authorsArg ? authorsArg.split(',').map(s => s.trim()).filter(Boolean) : [];
  if (!name && !launchId) { say('ERROR usage: --name <launch> [--launch-id <L-...>] [--pending <dir>] [--journal <file>]'); return 2; }
  const rec = findRecord(loadRecords(pendingDir, journal), { name, launchId });
  if (!rec) { say(`ERROR no launch record for ${launchId || name} under ${pendingDir}${journal ? ` or ${journal}` : ''}`); return 2; }
  const a = assess(rec, authors);
  say(`SEAT launchId=${rec.launchId} client=${rec.tuple ? rec.tuple.client : '-'} role=${a.role} requested=${a.requested || '-'} served=${a.served || '-'} source=${a.source} confidence=${a.confidence} match=${matchWord(a.match)} family=${a.servedFamily}`);
  say(`${a.refused ? 'REFUSED' : 'OK'} ${a.reason}`);
  say(`RESULT exit=${a.refused ? 1 : 0}`);
  return a.refused ? 1 : 0;
}

module.exports = { main, assess, findRecord, loadRecords, readRecords, SEAT_ROLES, DEFAULT_JOURNAL };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

'use strict';
// seat-check.cjs - operator acceptance of a certifier seat by its served model (PROTO-DEC-0169 item 4).
//   node docs/ops/seat-check.cjs --name <launch> [--launch-id <L-...>] [--pending <dir>] [--journal <LAUNCHES.jsonl>] [--authors <model>,<model>]
// Reads the launch records (the pending day files and the tracked journal), takes the newest full record whose launchId
// carries exactly the slug of the launch name after its stamp (or equals --launch-id), prints requested vs served, and exits:
//   0  the seat is acceptable, or the launch is not a certifier/reviewer seat (the fields are only printed);
//   1  a certifier or reviewer seat whose served model is missing (servedModelSource none, or a recovered record), differs (match=false) or is not proven by the
//      proof rule of certifier-rating.cjs (a source or confidence outside its closed lists, a recorded mismatch), whose served family differs from the
//      requested one (SERVED_FAMILY_MISMATCH), or - with --authors - whose PROVEN served model is not independent of the authors (PROBE-SERVED-MODEL:
//      the family of the served model is unknown or equals the family of an author; independence is judged on the model that answered, never the requested one);
//   2  no record found, unusable input.
// Reads files only; writes nothing. Class B operator tool; the result is advisory and never Evidence.
const fs = require('node:fs');
const path = require('node:path');
const { modelFamily, familyMatch, matchWord } = require('./served-model.cjs');
const { slug, PENDING_DIR } = require('../../.ai/bin/launch-record.cjs');
const { recovered } = require('../../.ai/bin/accounting/launch-record-validate.cjs');
const { provenServedModel, sameModel, modelIdOrNull } = require('./certifier-rating.cjs');

const DEFAULT_JOURNAL = path.join(path.dirname(PENDING_DIR), 'LAUNCHES.jsonl');
const SEAT_ROLES = new Set(['certifier', 'reviewer']);

function value(argv, name, dflt) { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : dflt; }

// A record proves a launch only with a start that is a valid date: an undated or damaged record is never the newest one.
const datedMs = value => (typeof value === 'string' && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null);

function readRecords(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try { const rec = JSON.parse(line); if (rec && typeof rec === 'object' && rec.schema === 'launch-record/1' && typeof rec.launchId === 'string' && datedMs(rec.startedAt) !== null && !rec.event) out.push(rec); } catch { /* a broken line is not a record */ }
  }
  return out;
}

function loadRecords(pendingDir, journal) {
  let files = [];
  try { files = fs.readdirSync(pendingDir).filter(n => n.endsWith('.jsonl')).sort().map(n => path.join(pendingDir, n)); } catch { /* no pending dir */ }
  if (journal && fs.existsSync(journal)) files.unshift(journal);
  return files.flatMap(readRecords);
}

// A launch id is L-<stamp>-<slug> and the stamp holds no hyphen, so the slug is everything after the stamp. A name matches only
// the WHOLE slug: a name that is a hyphen suffix of another launch's name never selects that launch.
function idSlug(id) { const m = /^L-[0-9A-Za-z]+-(.+)$/.exec(id); return m ? m[1] : null; }

function findRecord(records, { name, launchId }) {
  const want = name ? slug(name) : null;
  const hits = records.filter(r => datedMs(r.startedAt) !== null && (launchId ? r.launchId === launchId : idSlug(r.launchId) === want));
  hits.sort((a, b) => datedMs(b.startedAt) - datedMs(a.startedAt));
  return hits[0] || null;
}

// One proof rule with the certifier rating: a seat stands only on a served model the rating counts as proven (a source
// and a confidence of the closed lists, no recorded mismatch, the computed match true, not recovered). A value the rating
// refuses as unsafe proves nothing here either.
function proven(rec) {
  try { return provenServedModel(rec, 'seat-check') !== null; } catch { return false; }
}

// The verdict for one record: what it requested, what answered, and whether a seat may be accepted on it.
// A recovered (backfilled) record proves no served model: its served fields read as unknown (the kernel predicate of launch-record-validate.cjs).
// The match is the one model identity of the rating (sameModel: equal model keys), never a comparison of its own; a
// placeholder model (unknown, none, null, '-', empty) on either side is no model, so its match is unknown and a seat on it
// is refused.
function assess(rec, authors = []) {
  const requested = rec.tuple ? modelIdOrNull(rec.tuple.model) : null;
  const back = recovered(rec);
  const served = !back ? modelIdOrNull(rec.servedModel) : null;
  const source = !back && typeof rec.servedModelSource === 'string' ? rec.servedModelSource : 'none';
  const confidence = !back && typeof rec.servedModelConfidence === 'string' ? rec.servedModelConfidence : 'none';
  const match = source === 'none' || !served ? 'unknown' : sameModel(requested, served);
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
  else if (seat && back) reason = 'recovered (backfilled) record: its served model stays unknown, the seat cannot be accepted (PROTO-DEC-0169 item 4)';
  else if (seat && source === 'none') reason = 'no served-model source: the seat cannot be accepted (PROTO-DEC-0169 item 4)';
  else if (seat && !served) reason = 'served model unknown (absent or a placeholder): the seat cannot be compared';
  else if (seat && match === 'unknown') reason = 'requested model unknown: the seat cannot be compared';
  else if (seat && !proven(rec)) reason = 'the served model is not proven (an open source or confidence, or a recorded mismatch): the seat cannot be accepted (PROTO-DEC-0169 item 4)';
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

module.exports = { main, assess, findRecord, idSlug, loadRecords, readRecords, SEAT_ROLES, DEFAULT_JOURNAL };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

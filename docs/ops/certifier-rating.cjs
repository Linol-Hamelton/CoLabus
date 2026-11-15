'use strict';
// certifier-rating.cjs - reproducible certifier rating from recorded verdicts of past
// certifications.
// Replaces an earlier one-off ranking script (a hard-coded repository root, families
// attributed to unconfirmed models). Read-only: no file is written, the corpus is measured in place.
// Root by parameter; no path is hard-coded. Advisory only: never Evidence, never a gate input.
//
//   node docs/ops/certifier-rating.cjs --root <repo> [--reviews <dir>] [--launches <dir>] [--json]
//     exit 0  the corpus was measured (a refused ranking is a valid result, not an error)
//     exit 2  unusable or corrupt input: missing root, a reviews/launches directory outside the
//             root or reached through a link, a JSONL line that does not parse, an invalid-UTF-8
//             or undecodable review, a secret-shaped or unsafe value anywhere in the corpus.
//             The offending file is named by its corpus-relative path (never a machine path,
//             never the value); partial counts are never printed for a corrupt corpus.
//
// The private verdict/text/path rules of an earlier version
// are REPLACED by the shared guards library (one verdict reader -
// .ai/bin/lib/verdict-read.cjs, the strict closing-line grammar plus the template header form;
// .ai/bin/lib/text-safe.cjs for decoding; .ai/bin/lib/path-safe.cjs for real paths). No private
// copies remain. Verdicts: readVerdict decides, its grammar is the domain. Attribution is proven
// only through a launch record that (a) names the report in outputs[] by a real path inside the
// root's docs/reviews, outside archive, (b) names it with the file's byte digest (the proof belongs
// to THIS file), and (c) proves the served model by the seat-check semantics: tuple.model exists,
// source is in the closed enum, confidence is exact or derived, the recorded match is not false
// and tuple.model and servedModel are one model (sameModel, computed, not trusted). Duplicates by byte
// digest form groups whose answer is order-independent; two attributions that disagree give
// CONFLICT. Declared reviewer names are recorded per name (never grouped by a hand-written family
// table, never ranked); a declared name is refused only when no proven attribution covers it.
// No hand-written maker or model names live in this file (an owner rule).

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { readVerdict } = require('../../.ai/bin/lib/verdict-read.cjs');
const textSafe = require('../../.ai/bin/lib/text-safe.cjs');
const { secretIn } = require('../../.ai/bin/lib/secrets.cjs');
const pathSafe = require('../../.ai/bin/lib/path-safe.cjs');
const { recovered } = require('../../.ai/bin/accounting/launch-record-validate.cjs');
// The one model identity of every consumer (the rating at every stage, its groups, the declared cover, seat-check, the
// operator routes and the seat pools): the model key of launch-cost.cjs. Two spellings are one model exactly when their
// keys are equal; a placeholder (unknown, none, null, '-', empty, whatever the casing or padding) has no key.
const { modelKey } = require('../../.ai/bin/accounting/lib/launch-cost.cjs');
// Two spellings of one served model are one model; its name is the smallest spelling seen.
const smaller = (a, b) => (a && a < b ? a : b);
// A spelling that names a model, or null for no model: never a model id, never equal to another value and never a proven
// identity at any proof boundary.
const modelIdOrNull = v => (modelKey(v) === null ? null : v);
// true / false, or 'unknown' when either side is no model id (absent, empty or a placeholder): unknown is never one model.
// Equality of the one key only, so a spelling that part-matches two models never bridges them at any stage.
function sameModel(a, b) {
  if (modelIdOrNull(a) === null || modelIdOrNull(b) === null) return 'unknown';
  return modelKey(a) === modelKey(b);
}
// The spellings of one model (one key) form one group, named by its smallest spelling, whatever the order they were seen
// in. A group name has the key of its members, so a later stage that groups the names again joins exactly the same models.
function modelGroups(spellings) {
  const first = new Map();
  const name = new Map();
  for (const s of [...new Set(spellings.filter(v => modelIdOrNull(v) !== null))].sort()) {
    const key = modelKey(s);
    if (!first.has(key)) first.set(key, s);
    name.set(s, first.get(key));
  }
  return name;
}

const PROOF_SOURCES = ['agent-result', 'client-banner', 'client-log', 'launcher-model']; // served-model.cjs SOURCES minus 'none' (the launcher flag is a proven source)
const PROOF_CONFIDENCE = ['exact', 'derived']; // served-model.cjs CONFIDENCE minus 'none'
const SECRET_RE = /\bsk-[A-Za-z0-9_-]{20,}|\b\d{6,}:[A-Za-z0-9_-]{30,}/;
// A value is secret-shaped by this local form or by the one shared secret scan (every key, token and private key header).
const secretShaped = value => SECRET_RE.test(value) || secretIn(value);
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._~@-]{0,179}$/; // one path segment or one identifier
const SAFE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._~@:/-]{0,179}$/; // a model id may carry provider prefixes (xiaomi/mimo-v2.6-pro)
const SHA256_RE = /^[0-9a-f]{64}$/;
const UNDECLARED = '(undeclared)';

class CorruptError extends Error {
  constructor(message) { super(message); this.corrupt = true; }
}

// Every value that can reach a message is rendered through this: an unsafe or secret-shaped
// label becomes a fixed placeholder, the value is never echoed (defect class 8).
function safeLabel(value) {
  const s = String(value);
  if (secretShaped(s)) return '<unsafe value>';
  if (!/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,180}$/.test(s) || s.length > 200) return '<unsafe value>';
  return s;
}

function assertSafeId(value, what) {
  const s = String(value);
  if (secretShaped(s)) throw new CorruptError(`corrupt: ${what} is secret-shaped (not echoed)`);
  if (!SAFE_ID_RE.test(s)) throw new CorruptError(`corrupt: ${what} is not a safe identifier (not echoed)`);
  return s;
}

// A model id (requested, served, launchId) may carry provider prefixes and colons; the secret
// scan is the same. These are the values that can reach the ranking output when proven.
function assertSafeModelId(value, what) {
  const s = String(value);
  if (secretShaped(s)) throw new CorruptError(`corrupt: ${what} is secret-shaped (not echoed)`);
  if (!SAFE_MODEL_RE.test(s)) throw new CorruptError(`corrupt: ${what} is not a safe model identifier (not echoed)`);
  return s;
}

// A path inside the corpus must be a real file below the root (path-safe guard); a refusal names
// the reason code only, never the guard's detail (it may hold a segment we must not echo).
function guardFile(root, candidate, what) {
  const g = pathSafe.realInside(root, candidate);
  if (!g.ok) throw new CorruptError(`corrupt: ${what} is refused by the path guard (${g.reason})`);
  if (!g.exists) throw new CorruptError(`unusable: ${what} does not exist under the root`);
  if (g.type !== 'file') throw new CorruptError(`corrupt: ${what} is not a regular file`);
  return g;
}

function guardDir(root, candidate, what) {
  const g = pathSafe.realInside(root, candidate);
  if (!g.ok) throw new CorruptError(`corrupt: ${what} is refused by the path guard (${g.reason})`);
  if (!g.exists) return null;
  if (g.type !== 'dir') throw new CorruptError(`corrupt: ${what} is not a directory`);
  return g;
}

function decodeStrict(bytes, label) {
  const d = textSafe.decode(bytes, { bom: 'strip', crlf: 'normalise' });
  if (!d.ok) {
    const codes = d.problems.map(p => p.code).join(', ');
    throw new CorruptError(`corrupt: ${safeLabel(label)} is not decodable text (${codes})`);
  }
  // A second leading byte order mark is text, not the encoding's mark; the shared mask refuses a
  // string that starts with U+FEFF, so it is a controlled refusal here too (the same class as a
  // first leading mark), never a TypeError crash.
  if (d.text.charCodeAt(0) === 0xfeff) throw new CorruptError(`corrupt: ${safeLabel(label)} is not decodable text (a second leading byte order mark)`);
  return d.text;
}

// ---- verdict and declared reviewer ----

// The ONE verdict reader decides. Its grammar: the strict closing
// line plus the template header form behind a Mode line, Markdown structure masked by text-safe.
// A null token is reported as UNKNOWN; this adapter adds no private verdict logic.
function scanVerdict(input) {
  const r = readVerdict(input);
  return r.token || 'UNKNOWN';
}

const REVIEWER_LINE_RE = /^\s*(?:[-*>]\s*)?(?:\*{0,2})(?:Reviewer|Model|Модель|Рецензент)(?:\*{0,2})\s*:\s*(?:\*{0,2})?\s*([^\n]{1,120})/i;
const SECTION_RE = /^#{2,6}\s/;
const FENCE_RE = /^\s{0,3}(?:```|~~~)/;
const HEADER_WINDOW_LINES = 40;

// A declared reviewer name is recorded per name and NEVER ranked; a line inside masked Markdown
// is not a statement. The value is a display string of the corpus (the real reviews carry prose
// names with brackets, commas and Cyrillic), so its grammar is: control characters stripped,
// at most 120 characters, and a SECRET-SHAPED value corrupts the corpus (never echoed) - the one
// hard line of class 8. It is data for the declared report, never a path, never executed.
function scanDeclaredReviewer(text) {
  const lines = textSafe.maskMarkdown(String(text || '')).lines;
  const own = l => l && !l.masked && !l.partial;
  for (let i = 0; i < lines.length && i < HEADER_WINDOW_LINES; i++) {
    const line = lines[i];
    if (own(line) && (SECTION_RE.test(line.text) || FENCE_RE.test(line.text))) break;
    if (!own(line)) continue;
    const m = REVIEWER_LINE_RE.exec(line.text);
    if (!m) continue;
    const name = m[1].replace(/[*_`]/g, '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 120);
    if (secretShaped(name)) throw new CorruptError('corrupt: a declared reviewer value is secret-shaped (not echoed)');
    return name || null;
  }
  return null;
}

// ---- launch corpus (the proof carrier; a broken line is corrupt, never silently skipped) ----

function readLaunchLines(files, read) {
  const records = [];
  for (const file of files) {
    const text = decodeStrict(read(file), file.label);
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { throw new CorruptError(`corrupt: ${safeLabel(file.label)} holds a line that is not JSON`); }
      if (!rec || typeof rec !== 'object' || rec.schema !== 'launch-record/1' || rec.event) continue;
      records.push({ file: file.label, rec });
    }
  }
  return records;
}

// The seat-check semantics (PROTO-DEC-0169 item 4): the served model is proven only when the
// record is not recovered (the kernel predicate of launch-record-validate.cjs),
// requested a known model, the source and confidence are in the closed enum, the recorded
// match is not false AND the computed match of requested versus served is true. Anything else
// proves nothing; a secret-shaped value corrupts the corpus instead of flowing to any output.
function provenServedModel(rec, label) {
  if (!rec || typeof rec !== 'object') return null;
  const requested = rec.tuple ? modelIdOrNull(rec.tuple.model) : null;
  if (!requested) return null; // no requested model (absent, empty or a placeholder): no proof, never a guess
  assertSafeModelId(requested, `${safeLabel(label)} tuple model`);
  if (modelIdOrNull(rec.servedModel) === null) return null; // a placeholder served model is no served model
  assertSafeModelId(rec.servedModel, `${safeLabel(label)} servedModel`);
  if (recovered(rec)) return null; // a recovered (backfilled) record proves nothing: its served model stays unknown
  const source = typeof rec.servedModelSource === 'string' ? rec.servedModelSource : 'none';
  if (!PROOF_SOURCES.includes(source)) return null; // 'none' and any unknown value never prove
  const confidence = typeof rec.servedModelConfidence === 'string' ? rec.servedModelConfidence : 'none';
  if (!PROOF_CONFIDENCE.includes(confidence)) return null;
  if (rec.servedModelMatch !== undefined && rec.servedModelMatch !== true) return null; // a recorded match proves only as the boolean true
  if (sameModel(requested, rec.servedModel) !== true) return null; // computed, not trusted; unknown is never one model
  let launchId = null;
  if (typeof rec.launchId === 'string' && rec.launchId) {
    assertSafeId(rec.launchId, `${safeLabel(label)} launchId`);
    launchId = rec.launchId;
  }
  return { model: rec.servedModel, source, confidence, launchId };
}

const canonProofKey = p => `${p.launchId || ''}|${p.source}|${p.confidence}`;
const minProof = (a, b) => (canonProofKey(a) <= canonProofKey(b) ? a : b);

// buildAttributions(records, resolveOutput): proven-only attribution, order-independent.
//   records: [{ file (a safe label for messages), rec }] in any order.
//   resolveOutput(out, rec) -> the corpus key (the reviews-relative path) or null; the CLI builds
//   it from the path-safe guard and the byte digest, so a proof belongs to THIS file.
// Two records attributing different served models to one report give CONFLICT, never the first;
// equal models (any two spellings of one model) keep one canonical proof (the smallest launchId, source,
// confidence) and the smallest spelling, whatever the order of the records.
function buildAttributions(records, resolveOutput) {
  const byReport = new Map();
  for (const { file, rec } of records) {
    const proven = provenServedModel(rec, file);
    if (!proven) continue;
    for (const out of Array.isArray(rec.outputs) ? rec.outputs : []) {
      const key = resolveOutput(out, rec);
      if (!key) continue;
      if (!byReport.has(key)) byReport.set(key, []);
      byReport.get(key).push(proven);
    }
  }
  const out = {};
  for (const key of [...byReport.keys()].sort()) {
    // One model by the shared alias proof (the same equivalence that proved each record), never by the raw spelling.
    const proofs = byReport.get(key);
    const group = modelGroups(proofs.map(p => p.model));
    const models = new Map();
    for (const p of proofs) {
      const g = group.get(p.model);
      const prev = models.get(g);
      models.set(g, { ...(prev ? minProof(prev, p) : p), model: smaller(prev && prev.model, p.model) });
    }
    if (models.size > 1) {
      out[key] = { model: 'CONFLICT', source: `records attribute ${models.size} different served models to one report`, confidence: null, launchId: null };
      continue;
    }
    out[key] = { ...[...models.values()][0] };
  }
  return out;
}

// ---- the pure rater ----

// reviews: [{ relPath, sha256, verdict, declaredReviewer }] in any order.
// attributions: relPath -> { model: 'CONFLICT' | id, ... } (only proven entries).
// Duplicate byte digests form groups: the whole group is one review; its counts, duplicate count
// and attribution are computed from the group, so the input order never changes the answer.
function rateCertifiers({ reviews, attributions }) {
  const corpus = {
    files: reviews.length,
    uniqueDigests: 0,
    duplicateFiles: 0,
    archiveExcluded: 0,
    noVerdictFiles: 0,
    attributed: 0,
    conflictFiles: 0
  };
  const groups = new Map();
  for (const r of reviews) {
    if (!groups.has(r.sha256)) groups.set(r.sha256, []);
    groups.get(r.sha256).push(r);
  }
  corpus.uniqueDigests = groups.size;

  const rows = [];
  for (const [digest, members] of [...groups.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    members.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    const canonical = members[0];
    corpus.duplicateFiles += members.length - 1;
    if (canonical.verdict === 'UNKNOWN' || !canonical.verdict) corpus.noVerdictFiles++;
    // One digest, one attribution: the models proven across the whole group, grouped by the shared alias proof
    // (two spellings of one model are one model, named by the smallest spelling); disagreement is CONFLICT.
    // A copy whose own attribution is already CONFLICT makes the whole group CONFLICT: a proven copy never outvotes it.
    // A placeholder model is no attribution (never a proven identity).
    const models = new Map();
    let copyConflict = false;
    const attrs = [];
    for (const m of members) {
      const attr = attributions[m.relPath];
      if (!attr || !attr.model) continue;
      if (attr.model === 'CONFLICT') { copyConflict = true; continue; }
      if (modelIdOrNull(attr.model) === null) continue;
      attrs.push(attr);
    }
    const copyGroup = modelGroups(attrs.map(a => a.model));
    for (const attr of attrs) {
      const key = copyGroup.get(attr.model);
      const prev = models.get(key);
      models.set(key, { ...(prev ? minProof(prev, attr) : attr), model: smaller(prev && prev.model, attr.model) });
    }
    let attribution = null;
    if (copyConflict) attribution = { model: 'CONFLICT', source: 'a copy of these bytes carries conflicting proven attributions', confidence: null, launchId: null };
    else if (models.size > 1) attribution = { model: 'CONFLICT', source: 'the same bytes carry two different proven attributions', confidence: null, launchId: null };
    else if (models.size === 1) {
      attribution = { ...[...models.values()][0] };
    }
    if (attribution && attribution.model === 'CONFLICT') corpus.conflictFiles++;
    if (attribution && attribution.model !== 'CONFLICT') corpus.attributed++;
    rows.push({ ...canonical, duplicate: members.length > 1, attribution });
  }

  // Declared names are recorded per name (never grouped by a hand-written family table) and
  // never ranked. A declared name is refused only when no proven attribution of its rows covers
  // it as one model (sameModel): a proven model is never simultaneously refused.
  const byDeclared = new Map();
  const byProvenKey = new Map();
  const provenName = new Map();
  const countInto = (map, key, row) => {
    if (!map.has(key)) map.set(key, { total: 0, counts: { PASS: 0, FAIL: 0, BLOCKED: 0, RECOMMENDATION: 0, UNKNOWN: 0 } });
    const bucket = map.get(key);
    bucket.total++;
    bucket.counts[row.verdict in bucket.counts ? row.verdict : 'UNKNOWN']++;
  };
  const covered = new Set();
  // The ranking groups the proven models of all rows by the same shared alias proof as each digest group.
  const rowGroup = modelGroups(rows.filter(r => r.attribution && r.attribution.model !== 'CONFLICT').map(r => r.attribution.model));
  for (const row of rows) {
    const name = typeof row.declaredReviewer === 'string' && row.declaredReviewer ? row.declaredReviewer : UNDECLARED;
    countInto(byDeclared, name, row);
    if (row.attribution && row.attribution.model !== 'CONFLICT') {
      const model = rowGroup.get(row.attribution.model);
      provenName.set(model, smaller(provenName.get(model), row.attribution.model));
      countInto(byProvenKey, model, row);
      if (name === UNDECLARED || sameModel(row.attribution.model, name) === true) covered.add(name);
    }
  }
  const toList = (map, extra) => [...map.keys()].sort()
    .map(subject => ({ subject, total: map.get(subject).total, counts: map.get(subject).counts, ...extra }));

  const byProven = new Map([...byProvenKey].map(([model, bucket]) => [provenName.get(model), bucket]));
  const declared = toList(byDeclared, { attribution: 'declared-only', proven: false });
  const proven = toList(byProven, { attribution: 'proven-served-model', proven: true });
  const ranking = [...byProven.keys()].sort()
    .map(subject => ({ model: subject, total: byProven.get(subject).total, counts: byProven.get(subject).counts }))
    .sort((a, b) => (b.total - a.total) || (b.counts.PASS - a.counts.PASS) || (a.model < b.model ? -1 : 1));
  const refused = [...byDeclared.keys()].filter(k => !covered.has(k)).sort()
    .map(subject => ({ subject, reason: 'served-model-not-proven', declaredTotal: byDeclared.get(subject).total }));
  const statement = ranking.length === 0
    ? 'Refusal: no model in this corpus has a proven served model; the ranking is empty and every declared name without proof is refused (served model not proven).'
    : `Ranking covers only models with a proven served model (${ranking.length}); every declared name without proof is refused.`;

  return { corpus, declared, proven, ranking, refused, statement };
}

// ---- CLI ----

// Walks the reviews directory below its real path; every entry is re-guarded through path-safe
// (a symlink or junction below the root is refused, never followed), archive is excluded, and
// every name is a safe identifier before it can reach any output.
function walkReviews(root, dirReal, prefix = []) {
  const out = [];
  let entries;
  try { entries = fs.readdirSync(dirReal, { withFileTypes: true }); }
  catch (e) { throw new CorruptError(`unusable: the reviews directory cannot be read (${safeLabel(e.code || 'error')})`); }
  for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const abs = path.join(dirReal, entry.name);
    const rel = prefix.concat(entry.name).join('/');
    // A symlink or junction (Node reports both as links in Dirent) is refused whatever its name,
    // never followed and never silently skipped (defect class 4).
    if (entry.isSymbolicLink()) throw new CorruptError(`corrupt: the corpus entry ${safeLabel(rel)} is a link; the corpus must be real files`);
    if (entry.isDirectory()) {
      if (entry.name.toLowerCase() === 'archive') { out.push({ archive: true }); continue; }
      out.push(...walkReviews(root, abs, prefix.concat(entry.name)));
      continue;
    }
    if (!entry.isFile()) throw new CorruptError(`corrupt: the corpus entry ${safeLabel(rel)} is neither a file nor a directory`);
    if (!entry.name.toLowerCase().endsWith('.md')) continue;
    for (const seg of prefix.concat(entry.name)) assertSafeId(seg, 'a review path segment');
    const g = guardFile(root, abs, `the review ${safeLabel(rel)}`);
    out.push({ rel, full: g.real });
  }
  return out;
}

function listLaunchFiles(root, launchesReal) {
  const files = [];
  const journal = path.join(launchesReal, 'LAUNCHES.jsonl');
  const jg = pathSafe.realInside(root, journal);
  if (!jg.ok) throw new CorruptError(`corrupt: LAUNCHES.jsonl is refused by the path guard (${jg.reason})`);
  if (jg.exists && jg.type !== 'file') throw new CorruptError('corrupt: LAUNCHES.jsonl is not a regular file');
  if (jg.exists) files.push({ path: jg.real, label: 'LAUNCHES.jsonl' });
  const pending = path.join(launchesReal, 'pending');
  const pg = pathSafe.realInside(root, pending);
  if (!pg.ok) throw new CorruptError(`corrupt: the pending launches path is refused by the path guard (${pg.reason})`);
  if (pg.exists) {
    if (pg.type !== 'dir') throw new CorruptError('corrupt: the pending launches path is not a directory');
    let names = [];
    try { names = fs.readdirSync(pg.real).filter(n => n.endsWith('.jsonl')).sort(); } catch { /* unreadable: no evidence from it */ }
    for (const n of names) {
      assertSafeId(n, 'a pending launch file name');
      const g = guardFile(root, path.join(pg.real, n), `the pending launch file ${safeLabel(n)}`);
      files.push({ path: g.real, label: `pending/${n}` });
    }
  }
  return files;
}

function run(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write('usage: node docs/ops/certifier-rating.cjs --root REPO [--reviews DIR] [--launches DIR] [--json]\n'); return 0; }
  const arg = (name, dflt) => { const i = argv.indexOf(`--${name}`); return i >= 0 && i + 1 < argv.length ? argv[i + 1] : dflt; };
  const root = arg('root');
  if (!root || !fs.existsSync(root)) { process.stderr.write('unusable: --root <repo> is required and must exist\n'); return 2; }
  let rootReal;
  try {
    rootReal = fs.realpathSync.native(root);
    if (!fs.statSync(rootReal).isDirectory()) rootReal = null;
  } catch { rootReal = null; }
  if (!rootReal) { process.stderr.write('unusable: --root is not a real existing directory\n'); return 2; }

  // The corpus directories live inside the root (a relative --reviews/--launches is read against
  // the root, never against the working directory); the path-safe guard refuses links below it.
  const reviewsArg = arg('reviews', path.join('docs', 'reviews'));
  const launchesArg = arg('launches', path.join('docs', 'research', '2026-09-30-benchmark-catalog', 'launches'));
  const reviewsDir = guardDir(rootReal, reviewsArg, 'the reviews directory');
  if (!reviewsDir) throw new CorruptError('unusable: no reviews directory under the root');
  const launchesDir = guardDir(rootReal, launchesArg, 'the launches directory');

  const found = walkReviews(rootReal, reviewsDir.real);
  const archiveExcluded = found.filter(f => f.archive).length;
  const files = found.filter(f => !f.archive);
  const reviews = [];
  const byReal = new Map();
  for (const f of files) {
    const bytes = fs.readFileSync(f.full);
    const text = decodeStrict(bytes, f.rel);
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    const row = {
      relPath: f.rel,
      sha256,
      verdict: scanVerdict(text),
      declaredReviewer: scanDeclaredReviewer(text)
    };
    reviews.push(row);
    byReal.set(f.full, row);
  }
  const launchFiles = launchesDir ? listLaunchFiles(rootReal, launchesDir.real) : [];
  const records = readLaunchLines(launchFiles, file => fs.readFileSync(file.path));

  // A launch record attributes a review only when its outputs[] entry names a REAL file inside
  // the root's docs/reviews (outside archive), and names it with the file's byte digest: the
  // proof belongs to THIS file, not to a neighbour with the same name (defect classes 3, 4).
  const resolveOutput = (out) => {
    const raw = String((out && out.path) || '');
    if (!raw) return null;
    const g = pathSafe.realInside(rootReal, raw);
    if (!g.ok || !g.exists || g.type !== 'file') return null;
    const rel = g.rel.split('/');
    if (rel.length < 3 || rel[0] !== 'docs' || rel[1].toLowerCase() !== 'reviews') return null;
    if (rel.slice(2).some(seg => seg.toLowerCase() === 'archive')) return null;
    const row = byReal.get(g.real);
    if (!row) return null;
    const want = String((out && out.sha256) || '');
    const hex = want.startsWith('sha256:') ? want.slice(7) : want;
    if (!SHA256_RE.test(hex) || hex !== row.sha256) return null; // a digest mismatch is not this file
    return row.relPath;
  };
  const attributions = buildAttributions(records, resolveOutput);

  const result = rateCertifiers({ reviews, attributions });
  result.corpus.archiveExcluded = archiveExcluded;
  result.corpus.reviewsDir = String(reviewsArg).split(path.sep).join('/');
  result.corpus.launchesDir = String(launchesArg).split(path.sep).join('/');
  result.corpus.launchRecords = records.length;
  result.corpus.launchFiles = launchFiles.length;

  if (argv.includes('--json')) {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return 0;
  }
  process.stdout.write([
    `Corpus: ${result.corpus.reviewsDir} (inside the root)`,
    `  review files ${result.corpus.files}, unique byte digests ${result.corpus.uniqueDigests}, duplicates ${result.corpus.duplicateFiles}, no-verdict ${result.corpus.noVerdictFiles}, archive excluded ${result.corpus.archiveExcluded}`,
    `  launch records ${result.corpus.launchRecords} in ${result.corpus.launchFiles} file(s); attributed (proven served model) ${result.corpus.attributed}, conflicts ${result.corpus.conflictFiles}`,
    `Proven models (ranked): ${result.ranking.length === 0 ? 'none' : ''}`
  ].concat(result.ranking.map(m => `  ${m.model}: total ${m.total}, PASS ${m.counts.PASS}, FAIL ${m.counts.FAIL}, RECOMMENDATION ${m.counts.RECOMMENDATION}, BLOCKED ${m.counts.BLOCKED}, UNKNOWN ${m.counts.UNKNOWN}`))
    .concat(['Declared names (recorded, never ranked without proof):'])
    .concat(result.declared.map(f => `  ${f.subject}: total ${f.total} (PASS ${f.counts.PASS}, FAIL ${f.counts.FAIL}, REC ${f.counts.RECOMMENDATION}, BLOCKED ${f.counts.BLOCKED}, UNKNOWN ${f.counts.UNKNOWN})`))
    .concat([`Refused to rank: ${result.refused.map(f => f.subject).join(', ') || 'none'}`, result.statement])
    .join('\n') + '\n');
  return 0;
}

if (require.main === module) {
  let status;
  try { status = run(process.argv.slice(2)); }
  catch (e) {
    process.stderr.write(`${e.corrupt ? e.message : `error: ${safeLabel(e.message)}`}\n`);
    status = 2;
  }
  process.exit(status);
}

module.exports = {
  scanVerdict, scanDeclaredReviewer, decodeStrict, rateCertifiers, buildAttributions,
  provenServedModel, sameModel, modelGroups, modelIdOrNull, safeLabel, PROOF_SOURCES, PROOF_CONFIDENCE, HEADER_WINDOW_LINES
};

'use strict';
// Price snapshot (price-snapshot/1): build from fetched or replayed raw responses, write exclusively, load with hash check.

const fs = require('fs');
const path = require('path');
const { canonicalJson, hashOf } = require('./canon.cjs');
const P = require('./price-parse.cjs');
const I = require('./price-ids.cjs');
const SC = require('./schema-check.cjs');

const SCHEMA_FILE = path.resolve(__dirname, '..', 'schema', 'price-snapshot.json');

const SCHEMA = 'price-snapshot/1';
const SOURCES = {
  openrouter: { url: 'https://openrouter.ai/api/v1/models', parse: P.parseOpenRouter, kind: 'list' },
  vercel: { url: 'https://ai-gateway.vercel.sh/v1/models', parse: P.parseVercelList, kind: 'list' },
  huggingface: { url: 'https://router.huggingface.co/v1/models', parse: P.parseHuggingFace, kind: 'list' },
};
const VERCEL_ENDPOINT_BASE = 'https://ai-gateway.vercel.sh/v1/models/';
const VERCEL_ENDPOINT_CAP_DEFAULT = 8;
const VERCEL_ENDPOINT_CAP_MAX = 16;

function endpointUrl(vercelId) {
  return `${VERCEL_ENDPOINT_BASE}${vercelId}/endpoints`;
}

/** Vercel ids whose provider endpoints are worth a request: ladder models whose list entry says the price varies by provider. */
function vercelEndpointTargets(vercelListRecords, cap) {
  const varies = new Set(vercelListRecords.filter((r) => r.flags.includes('varies-by-provider')).map((r) => r.platformModelId));
  const out = [];
  for (const m of I.LADDER_MODELS) {
    if (m.vercel && varies.has(m.vercel) && !out.includes(m.vercel)) out.push(m.vercel);
  }
  return { wanted: out.length, ids: out.slice(0, cap) };
}

/**
 * Assemble the snapshot object.
 * @param {{mode: 'live'|'replay', userAgent: string|null, lists: Array<{platform: string, url: string, fetchedAt: string, status: number, bytes: number, rawSha256: string, text: string}>,
 *   endpoints: Array<{id: string, url: string, fetchedAt: string, status: number, bytes: number, rawSha256: string, text: string}>, endpointCap: number, endpointWanted: number}} input
 */
function buildSnapshot(input) {
  const records = [];
  const sources = [];
  for (const l of input.lists) {
    const spec = SOURCES[l.platform];
    if (!spec) throw new Error(`unknown platform ${l.platform}`);
    const recs = spec.parse(l.text, { fetchedAt: l.fetchedAt, sourceUrl: l.url, rawSha256: l.rawSha256 });
    records.push(...recs);
    sources.push({ platform: l.platform, kind: 'list', url: l.url, fetchedAt: l.fetchedAt, status: l.status, bytes: l.bytes, rawSha256: l.rawSha256, records: recs.length });
  }
  for (const e of input.endpoints) {
    const recs = P.parseVercelEndpoints(e.text, { fetchedAt: e.fetchedAt, sourceUrl: e.url, rawSha256: e.rawSha256 });
    records.push(...recs);
    sources.push({ platform: 'vercel', kind: 'endpoints', url: e.url, fetchedAt: e.fetchedAt, status: e.status, bytes: e.bytes, rawSha256: e.rawSha256, records: recs.length });
  }
  const canon = I.assignCanonical(records);
  records.sort((a, b) => cmpStr(a.platform, b.platform) || cmpStr(a.platformModelId, b.platformModelId) || cmpStr(a.priceKind, b.priceKind) || cmpStr(a.provider || '', b.provider || ''));
  sources.sort((a, b) => cmpStr(a.platform, b.platform) || cmpStr(a.kind, b.kind) || cmpStr(a.url, b.url));
  const capturedAt = sources.map((s) => s.fetchedAt).sort().slice(-1)[0] || null;
  const snap = {
    schema: SCHEMA,
    id: capturedAt ? capturedAt.slice(0, 10) : null,
    mode: input.mode,
    tool: 'price-snapshot',
    userAgent: input.userAgent,
    capturedAt,
    requests: { total: input.lists.length + input.endpoints.length, lists: input.lists.length, vercelEndpoints: input.endpoints.length, vercelEndpointCap: input.endpointCap, vercelEndpointWanted: input.endpointWanted },
    sources,
    counts: counts(records),
    unmatched: canon.unmatched,
    records,
  };
  snap.hash = hashOf(snap);
  return snap;
}

function cmpStr(a, b) { return a < b ? -1 : a > b ? 1 : 0; }

/** Counts per platform (distinct platform model ids) and joins over canonical ids of language models, standard variant. */
function counts(records) {
  const per = {};
  const ids = {};
  for (const r of records) {
    if (!per[r.platform]) per[r.platform] = new Set();
    per[r.platform].add(r.platformModelId);
    if (r.canonicalId && r.modelType === 'language' && r.variant === 'standard') {
      if (!ids[r.canonicalId]) ids[r.canonicalId] = new Set();
      ids[r.canonicalId].add(r.platform);
    }
  }
  const out = { models: {}, records: records.length, canonicalLanguageIds: Object.keys(ids).length, joinedOn1: 0, joinedOn2: 0, joinedOn3: 0 };
  for (const p of Object.keys(per).sort()) out.models[p] = per[p].size;
  for (const s of Object.values(ids)) out[`joinedOn${s.size}`]++;
  return out;
}

/** Compact text: the header on one line, one record per line (a diff of two snapshots stays readable). */
function formatSnapshot(snap) {
  const { records, ...rest } = snap;
  const head = JSON.stringify(rest);
  return `${head.slice(0, -1)},"records":[\n${records.map((r) => JSON.stringify(r)).join(',\n')}\n]}\n`;
}

/**
 * Write a snapshot without ever replacing a file: the content goes to a hidden part file, then a hard link makes the final name,
 * which fails when the name exists. The part file is the tool's own temporary name, never a snapshot.
 * @returns {{file: string, bytes: number}}
 */
function writeSnapshotExclusive(file, snap) {
  const text = formatSnapshot(snap);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) throw Object.assign(new Error(`snapshot ${file} exists; a snapshot is never overwritten`), { code: 'EEXIST' });
  const part = path.join(path.dirname(file), `.${path.basename(file)}.part-${process.pid}-${Date.now()}`);
  fs.writeFileSync(part, text, { flag: 'wx' });
  try {
    fs.linkSync(part, file);
  } catch (e) {
    if (e.code === 'EEXIST') { try { fs.unlinkSync(part); } catch { /* own part file */ } throw Object.assign(new Error(`snapshot ${file} exists; a snapshot is never overwritten`), { code: 'EEXIST' }); }
    // a file system without hard links: exclusive create of the final name (not atomic, never overwrites)
    fs.writeFileSync(file, text, { flag: 'wx' });
  }
  try { fs.unlinkSync(part); } catch { /* own part file */ }
  return { file, bytes: Buffer.byteLength(text) };
}

/** Errors of a snapshot against schema/price-snapshot.json, each with the record it belongs to (a price is a non-negative decimal string). */
function schemaProblems(snap) {
  const schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, 'utf8'));
  return SC.validate(schema, snap).map((e) => {
    const m = /^\$\.records\[(\d+)\]/.exec(e);
    const r = m && snap.records[Number(m[1])];
    return r ? `${e} (record ${r.platform} ${r.platformModelId}${r.provider ? ` / ${r.provider}` : ''})` : e;
  });
}

/** Load a snapshot and verify its schema id, its own hash and every record against schema/price-snapshot.json. Throws with a clear message. */
function loadSnapshot(file) {
  const text = fs.readFileSync(file, 'utf8');
  const snap = JSON.parse(text);
  if (!snap || snap.schema !== SCHEMA) throw new Error(`${file}: not a ${SCHEMA} file`);
  if (hashOf(snap) !== snap.hash) throw new Error(`${file}: snapshot hash does not match its content (edited or damaged)`);
  // the hash only proves the content was not changed after writing; a recomputed hash must not let an invalid price through
  const problems = schemaProblems(snap);
  if (problems.length) throw new Error(`${file}: snapshot does not match schema price-snapshot.json: ${problems.slice(0, 3).join('; ')}${problems.length > 3 ? ` (+${problems.length - 3} more)` : ''}`);
  return snap;
}

module.exports = { schemaProblems, SCHEMA, SOURCES, VERCEL_ENDPOINT_CAP_DEFAULT, VERCEL_ENDPOINT_CAP_MAX, endpointUrl, vercelEndpointTargets, buildSnapshot, counts, writeSnapshotExclusive, loadSnapshot, canonicalJson };

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const safe = require('../../.ai/bin/lib/path-safe.cjs');
const text = require('../../.ai/bin/lib/text-safe.cjs');
const io = require('../assign/io.cjs');
const feedback = require('../assign/feedback.cjs');
const ROW_KEYS = ['schema', 'rowId', 'installId', 'day', 'coreVersion', 'role', 'tier', 'executor', 'servedModel',
  'rounds', 'verdict', 'wallSeconds', 'tokensIn', 'tokensOut', 'costUsd', 'failureClass'];
const HEX = /^[0-9a-f]{32}$/;
const DIGEST = /^[0-9a-f]{64}$/;
// Public client/model identifiers only. No whitespace, slash, colon or arbitrary prose.
const TOKEN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const ROLES = ['author', 'fixer', 'pre-reviewer', 'certifier', 'operator', 'researcher', 'reviewer'];
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const VERDICTS = ['PASS', 'FAIL', 'BLOCKED', 'RECOMMENDATION', 'UNKNOWN'];
const FAILURES = ['none', 'unknown', 'transport', 'timeout', 'quota', 'provider-filter', 'schema', 'tool-error'];
const MAX_ROW = 2048, MAX_FILE = 8 * 1024 * 1024;
const ZERO = '0'.repeat(64);
const isId = v => typeof v === 'string' && HEX.test(v);
const fail = io.fail;
const fields = (v, keys) => io.fields(v, keys, keys);
const hash = io.hash, canonical = io.canonical;
const randomId = () => crypto.randomBytes(16).toString('hex');
let vocabulary;
function publicIdentities() {
  if (vocabulary) return vocabulary;
  const registry = readJson(path.resolve(__dirname, '../../.ai/docs/clients.json'));
  const aliases = readJson(path.resolve(__dirname, '../../docs/product/launch-records/data/model-aliases.json'));
  if (registry.schema !== 'clients/1' || aliases.sv !== 'model-aliases/1') fail('vocabulary-invalid');
  const clients = new Set(), models = new Set();
  const add = (set, value) => { if (typeof value === 'string' && value.length <= 96 && TOKEN.test(value)) { publicValue(value); set.add(value); } };
  for (const [client, entry] of Object.entries(registry.clients)) { add(clients, client); for (const model of entry.models || []) add(models, model); }
  for (const entry of aliases.aliases) add(models, entry.modelId);
  for (const entry of aliases.routeAliases) { add(clients, entry.client); add(models, entry.model); add(models, entry.modelId); }
  if (!clients.size || !models.size) fail('vocabulary-empty');
  vocabulary = { clients, models }; return vocabulary;
}
function publicValue(v) {
  io.publicValue(v);
  // Scan both literal bytes and decoded JSON string values through the common scanners.
  const s = JSON.stringify(v);
  if (/[\u0000-\u001f\u007f-\uffff]/u.test(s) || /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(s)) fail('private-value');
  return v;
}
function date(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v) || v < '2000-01-01' || v > '9999-12-31'
      || new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) !== v) fail('day-invalid');
  return v;
}
function validateRow(row) {
  fields(row, ROW_KEYS);
  publicValue(row);
  if (Buffer.byteLength(JSON.stringify(row)) > MAX_ROW) fail('row-too-large');
  if (row.schema !== 'outcome/1' || !isId(row.rowId) || !isId(row.installId)) fail('row-identity');
  date(row.day);
  if (typeof row.coreVersion !== 'string' || !/^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/.test(row.coreVersion)
      || !ROLES.includes(row.role) || typeof row.tier !== 'string' || !/^T[1-9]$/.test(row.tier)) fail('row-kind');
  fields(row.executor, ['client', 'model', 'effort', 'routeKind']);
  for (const key of ['client', 'model']) if (row.executor[key] !== null && (typeof row.executor[key] !== 'string'
      || row.executor[key].length > 96 || !TOKEN.test(row.executor[key]))) fail('executor-identity');
  const identities = publicIdentities();
  if (row.executor.client !== null && !identities.clients.has(row.executor.client)
      || row.executor.model !== null && !identities.models.has(row.executor.model)) fail('identity-not-public');
  if (!(row.executor.effort === null || EFFORTS.includes(row.executor.effort))
      || !['free', 'subscription', 'direct', 'aggregator', 'unknown'].includes(row.executor.routeKind)) fail('executor-route');
  if (row.servedModel !== null) {
    fields(row.servedModel, ['value', 'source']);
    if (typeof row.servedModel.value !== 'string' || row.servedModel.value.length > 96 || !TOKEN.test(row.servedModel.value)) fail('served-identity');
    if (!identities.models.has(row.servedModel.value)
        || !['provider-response', 'client-metadata'].includes(row.servedModel.source)) fail('served-proof');
  }
  for (const key of ['rounds', 'tokensIn', 'tokensOut']) if (!(row[key] === null || Number.isSafeInteger(row[key]) && row[key] >= 0 && row[key] <= 1e12)) fail('counter-invalid');
  for (const key of ['wallSeconds', 'costUsd']) if (!(row[key] === null || typeof row[key] === 'number' && Number.isFinite(row[key]) && row[key] >= 0 && row[key] <= 1e9)) fail('metric-invalid');
  if (!VERDICTS.includes(row.verdict) || !FAILURES.includes(row.failureClass)) fail('outcome-token');
  return row;
}
function absolute(p) {
  if (typeof p !== 'string' || safe.lexicalProblem(p)) fail('path-invalid');
  const parts = p.replace(/\\/g, '/').split('/');
  if (parts.includes('..') || parts.some(s => s && s !== '.' && !/^[A-Za-z]:$/.test(s) && safe.segmentProblem(s))) fail('path-invalid');
  return path.resolve(p);
}
function guard(p, directory = false) {
  const abs = absolute(p), g = safe.realInside(path.parse(abs).root, abs, { refuseHardlinks: true, allowRoot: true });
  if (!g.ok || directory && (!g.exists || g.type !== 'dir')) fail('path-unsafe');
  return g;
}
function durable(root) {
  const g = guard(root, true), parts = g.real.toLowerCase().split(/[\\/]/);
  if (parts.some((p, i) => p === '.ai' && parts[i + 1] === 'runtime')) fail('durable-root-required');
  return g.real;
}
function readBytes(file) {
  const g = guard(file);
  if (!g.exists || g.type !== 'file' || fs.statSync(g.real).size > MAX_FILE) fail('file-size-or-type');
  const r = safe.readFileGuarded(path.parse(g.real).root, g.real);
  if (!r.ok || r.bytes.length > MAX_FILE) fail('read-unverified');
  return r.bytes;
}
function decode(bytes, finalNewline = 'refuse') {
  const d = text.decode(bytes, { bom: 'refuse', crlf: 'refuse', invisible: 'refuse', finalNewline });
  if (!d.ok || d.notes.length) fail('text-invalid');
  return d.text;
}
function parseLine(bytes) { return text.parseJsonUnique(decode(Buffer.concat([bytes, Buffer.from('\n')]))); }
function readJson(file) { return text.parseJsonUnique(decode(readBytes(file))); }
function writeAtomic(file, bytes) {
  guard(file);
  const r = safe.writeAtomicGuarded(absolute(file), bytes, { root: path.parse(absolute(file)).root, mode: 0o600 });
  if (!r.ok || r.closeError) fail('write-unverified');
}
// Guarded staging writes every byte. linkSync publishes WITHOUT replacing an
// existing name, including one created after the guard. Replacing our staging
// link by a tombstone makes the final file single-linked. No file is deleted.
// A crash between these operations leaves a double-linked output: verify refuses
// it. Both copies are retained for operator recovery; retry uses a fresh name.
function writeNew(file, bytes) {
  const g = guard(file);
  if (g.exists) fail('output-exists');
  const parent = path.dirname(g.real), stage = path.join(parent, `outcomes-stage-${randomId()}.json`);
  if (guard(stage).exists) fail('stage-exists');
  writeAtomic(stage, bytes);
  const st = fs.lstatSync(stage, { bigint: true });
  const published = safe.withDirectoryPinned(parent, release => {
    const again = guard(file), staging = guard(stage), current = fs.lstatSync(staging.real, { bigint: true });
    if (again.exists || again.real !== g.real || current.dev !== st.dev || current.ino !== st.ino) fail('output-changed');
    const fd = fs.openSync(staging.real, 'r');
    try {
      const opened = fs.fstatSync(fd, { bigint: true });
      if (opened.dev !== st.dev || opened.ino !== st.ino || opened.nlink !== 1n) fail('stage-changed');
      release(); // transfer the Windows ancestor pin to the staging descriptor
      fs.linkSync(staging.real, g.real);
    } finally { fs.closeSync(fd); }
    return { ok: true };
  });
  if (!published?.ok) fail('output-refused');
  // Retire the known temporary second link by replacing only our staging name.
  // The normal shared writer correctly refuses nlink=2; prepare the marker
  // through that writer, then rename it over the inode-checked staging link.
  const retireDir = path.join(parent, `outcomes-publish-${randomId()}`);
  const created = safe.mkdirGuarded(path.parse(parent).root, retireDir); if (!created.ok) fail('stage-retire');
  const tombstone = path.join(retireDir, 'published.json');
  writeAtomic(tombstone, Buffer.from('{"published":true}\n'));
  const retired = safe.withDirectoryPinned(parent, release => {
    const now = fs.lstatSync(stage, { bigint: true }), final = fs.lstatSync(g.real, { bigint: true });
    if (now.dev !== st.dev || now.ino !== st.ino || final.dev !== st.dev || final.ino !== st.ino || now.nlink !== 2n) fail('stage-changed');
    release(); fs.renameSync(tombstone, stage); return { ok: true };
  });
  if (!retired?.ok) fail('stage-retire');
  const final = guard(file), end = fs.lstatSync(final.real, { bigint: true });
  if (end.dev !== st.dev || end.ino !== st.ino || !readBytes(file).equals(bytes)) fail('publish-unverified');
}
function withLock(root, action, timeout = 5000) {
  root = durable(root);
  const lock = path.join(root, 'outcomes.lock'), deadline = Date.now() + timeout;
  let identity, fd = null;
  for (;;) {
    if (!guard(lock).exists) {
      const acquired = safe.withDirectoryPinned(root, () => {
        if (guard(lock).exists) return { ok: true, busy: true };
        fs.mkdirSync(lock);
        identity = fs.lstatSync(lock, { bigint: true });
        // An open child pins the lock and its ancestors on NTFS.
        fd = fs.openSync(path.join(lock, 'owner.pin'), 'wx', 0o600);
        return { ok: true, busy: false };
      });
      if (acquired?.ok && !acquired.busy) break;
      // NTFS directory pins deny sharing with EPERM/EACCES as well as EBUSY.
      // Retry only acquisition, under the same deadline; every attempt repeats
      // the full guard and action never runs until the lock is acquired.
      if (acquired?.reason && !['EEXIST', 'EBUSY', 'EPERM', 'EACCES'].includes(acquired.detail)) fail('lock-path');
    }
    if (Date.now() >= deadline) fail('outcomes-busy');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
  try { return action(); } finally {
    const current = guard(lock), now = fs.lstatSync(current.real, { bigint: true });
    if (now.dev !== identity.dev || now.ino !== identity.ino) { if (fd !== null) fs.closeSync(fd); fail('lock-changed'); }
    if (fd !== null) { fs.closeSync(fd); fd = null; }
    const release = safe.withDirectoryPinned(root, unpin => {
      const g = guard(lock), st = fs.lstatSync(g.real, { bigint: true });
      if (st.dev !== identity.dev || st.ino !== identity.ino) fail('lock-changed');
      const retired = path.join(root, `outcomes-retired-${randomId()}`); guard(retired);
      unpin();
      fs.renameSync(lock, retired); return { ok: true };
    });
    if (!release?.ok) fail('lock-release-failed');
  }
}
function installId(root) {
  const file = path.join(root, 'install.json'), g = guard(file);
  if (!g.exists) writeNew(file, Buffer.from(JSON.stringify({ schema: 'outcome-install/1', installId: randomId() }) + '\n'));
  const v = readJson(file); fields(v, ['schema', 'installId']);
  if (v.schema !== 'outcome-install/1' || !isId(v.installId)) fail('install-invalid');
  return v.installId;
}
function splitLedger(raw) {
  const cut = raw.lastIndexOf(10), complete = cut < 0 ? Buffer.alloc(0) : raw.subarray(0, cut + 1), tail = raw.subarray(cut + 1);
  const lines = []; let start = 0;
  for (let i = 0; i < complete.length; i++) if (complete[i] === 10) { lines.push(complete.subarray(start, i)); start = i + 1; }
  return { lines, complete, tail };
}
function readRows(root) {
  root = durable(root);
  const meta = readJson(path.join(root, 'install.json')); fields(meta, ['schema', 'installId']);
  if (meta.schema !== 'outcome-install/1' || !isId(meta.installId)) fail('install-invalid');
  const file = path.join(root, 'rows.jsonl'), raw = guard(file).exists ? readBytes(file) : Buffer.alloc(0);
  const { lines, tail } = splitLedger(raw), byId = new Map(), badIds = new Set(); let invalidRows = tail.length ? 1 : 0;
  for (const line of lines) {
    try {
      if (line.length > MAX_ROW) fail('row-size');
      const row = validateRow(parseLine(line));
      if (row.installId !== meta.installId) fail('source-conflict');
      if (byId.has(row.rowId) && canonical(row) !== canonical(byId.get(row.rowId))) badIds.add(row.rowId);
      else byId.set(row.rowId, row);
    } catch { invalidRows++; }
  }
  return { installId: meta.installId, rows: [...byId.values()].filter(r => !badIds.has(r.rowId)), invalidRows, conflicts: badIds.size, raw };
}
function record(root, input) {
  validateRow(input);
  return withLock(root, () => {
    const localId = installId(root), row = validateRow({ ...input, installId: localId });
    const state = readRows(root);
    // A newline is the commit marker, even when the tail parses as valid JSON.
    // Do not promote it on a new write or an idempotent retry; retain all bytes
    // until a human reviews/restores the ledger.
    if (splitLedger(state.raw).tail.length) fail('ledger-tail-unreviewed');
    if (state.conflicts) fail('row-conflict');
    const previous = state.rows.find(r => r.rowId === row.rowId);
    if (previous) { if (canonical(previous) !== canonical(row)) fail('row-conflict'); return previous; }
    const joined = Buffer.concat([state.raw, Buffer.from(JSON.stringify(row) + '\n')]);
    if (joined.length > MAX_FILE) fail('ledger-full');
    writeAtomic(path.join(root, 'rows.jsonl'), joined);
    return row;
  });
}
function sealBundle(id, rows) {
  const header = { schema: 'outcome-bundle/1', installId: id, count: rows.length };
  return { header: { ...header, digest: hash({ header, rows }) }, rows };
}
function validateBundle(bundle) {
  fields(bundle, ['header', 'rows']); fields(bundle.header, ['schema', 'installId', 'count', 'digest']);
  publicValue(bundle);
  const h = bundle.header;
  if (h.schema !== 'outcome-bundle/1' || !isId(h.installId) || typeof h.digest !== 'string' || !DIGEST.test(h.digest) || !Array.isArray(bundle.rows)
      || h.count !== bundle.rows.length || !Number.isSafeInteger(h.count) || h.count > 10000) fail('bundle-header');
  const seen = new Set();
  for (const row of bundle.rows) {
    validateRow(row);
    if (row.installId !== h.installId || seen.has(row.rowId)) fail('bundle-identity');
    seen.add(row.rowId);
  }
  if (sealBundle(h.installId, bundle.rows).header.digest !== h.digest) fail('bundle-digest');
  return bundle;
}
function makeBundle(root, since) {
  if (since !== undefined) date(since);
  const state = readRows(root);
  io.publicValue(state.raw.toString('utf8'));
  if (state.invalidRows || state.conflicts) fail('ledger-damaged');
  return validateBundle(sealBundle(state.installId, state.rows.filter(r => since === undefined || r.day >= since)));
}
const bundleBytes = bundle => Buffer.from(JSON.stringify(bundle, null, 2) + '\n');
const verifyFile = file => validateBundle(readJson(file));
function writeExport(root, out, since, prepared) {
  if (safe.sameFileOrNested(absolute(root), absolute(out))) fail('output-overlaps-input');
  const bundle = prepared || makeBundle(root, since); validateBundle(bundle);
  writeNew(out, bundleBytes(bundle)); return bundle;
}
function readChain(root, id) {
  root = durable(root);
  if (!isId(id)) fail('source-invalid');
  const file = path.join(root, `${id}.jsonl`), raw = guard(file).exists ? readBytes(file) : Buffer.alloc(0);
  const { lines, complete, tail } = splitLedger(raw), entries = [], byId = new Map(); let previous = ZERO;
  for (const line of lines) {
    const e = parseLine(line); fields(e, ['row', 'previous', 'hash']); validateRow(e.row);
    if (e.row.installId !== id || e.previous !== previous || !DIGEST.test(e.hash) || e.hash !== hash({ row: e.row, previous }) || byId.has(e.row.rowId)) fail('chain-invalid');
    byId.set(e.row.rowId, e.row); entries.push(e); previous = e.hash;
  }
  return { rows: [...byId.values()], entries, previous, raw, complete, tail };
}
function ingest(file, root) {
  const bundle = verifyFile(file);
  root = durable(root);
  if (safe.sameFileOrNested(absolute(file), root)) fail('ingest-overlap');
  return withLock(root, () => {
    const id = bundle.header.installId, state = readChain(root, id), seen = new Map(state.rows.map(r => [r.rowId, r]));
    const additions = []; let previous = state.previous;
    for (const row of bundle.rows) {
      if (seen.has(row.rowId)) { if (canonical(seen.get(row.rowId)) !== canonical(row)) fail('ingest-conflict'); continue; }
      const entry = { row, previous, hash: hash({ row, previous }) }; additions.push(JSON.stringify(entry) + '\n'); previous = entry.hash;
    }
    // Retain the entire damaged snapshot before repairing an uncommitted tail.
    if (state.tail.length) {
      const recovery = path.join(root, `recovery-${id}-${hash(state.raw)}.jsonl`);
      if (guard(recovery).exists) { if (!readBytes(recovery).equals(state.raw)) fail('recovery-conflict'); }
      else writeNew(recovery, state.raw);
    }
    const bytes = Buffer.concat([state.complete, Buffer.from(additions.join(''))]);
    if (bytes.length > MAX_FILE) fail('ledger-full');
    if (additions.length || state.tail.length) writeAtomic(path.join(root, `${id}.jsonl`), bytes);
    return { added: additions.length, duplicate: bundle.rows.length - additions.length };
  });
}
function fromFeedbackEvent(event, context) {
  feedback.validate(event); fields(context, ['installId', 'day', 'coreVersion']);
  if (!isId(context.installId)) fail('install-invalid');
  const outcome = event.event === 'outcome', route = outcome ? event.actual : event.assigned;
  const verdicts = new Set(event.verdicts);
  let cost = null;
  if (outcome && event.costUsd !== null) {
    const normalized = event.costUsd.includes('.') ? event.costUsd.replace(/0+$/, '').replace(/\.$/, '') : event.costUsd;
    const n = Number(normalized);
    if (Number.isFinite(n) && n.toString() === normalized) cost = n;
  }
  return validateRow({ schema: 'outcome/1', rowId: crypto.createHmac('sha256', context.installId).update(event.eventId).digest('hex').slice(0, 32),
    installId: context.installId, day: context.day, coreVersion: context.coreVersion, role: event.role, tier: event.tier,
    executor: { client: route ? route.client : null, model: route ? route.model : null, effort: route ? route.effort : null, routeKind: 'unknown' },
    servedModel: null, rounds: outcome ? event.rounds : null, verdict: outcome && verdicts.size === 1 ? [...verdicts][0] : 'UNKNOWN',
    wallSeconds: outcome ? event.wallSeconds : null, tokensIn: outcome && event.tokens ? event.tokens.input : null,
    tokensOut: outcome && event.tokens ? event.tokens.output : null, costUsd: cost, failureClass: 'unknown' });
}
module.exports = { ROW_KEYS, validateRow, readJson, readRows, record, makeBundle, sealBundle, validateBundle, bundleBytes,
  verifyFile, writeExport, writeNew, readChain, ingest, fromFeedbackEvent, withLock, randomId, absolute, guard, durable, installId };

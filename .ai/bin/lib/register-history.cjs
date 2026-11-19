'use strict';
// Closed historical exceptions. These authorize archival replay, never a live train.
// Source commits and entire blobs are pinned: new duplicates or JSON formatting
// (even with an old row body or indentation) cannot match this ledger.
const { isDeepStrictEqual } = require('node:util');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { digest, need, bytesOf } = require('./register-fragments.cjs');
const { parseJsonUnique } = require('./text-safe.cjs');
const LEDGER_NAME = 'register-history.json';
const LEDGER = path.posix.join('.ai', 'bin', 'lib', LEDGER_NAME);
const LEDGER_DIGEST = 'sha256:e690bfd7b24bc123547463faf8d187549b3b0f6c0019d97b8a2b6fa2d307e2d1';
// One-way fingerprints of every source commit accepted by this closed ledger.
// These disclose no source commit IDs in installed code. Enumerate objects,
// not reachable refs: rewinds, shallow boundaries, grafts and replace refs
// must not hide a pinned commit that is still available to archival replay.
const SOURCE_PINS = new Set([
  '7a44f51f269b7fcbeee26b98d8d225dfc736e9a0751fd9ad84097646588161c7',
  '3868c5029c5b1e32bdeb9b0d14f9a316d71e456d7ebff4ac9f779065495b6468',
  'd5e7969416b45c8ffeaef046062d8c48bd98c4924b39e85ba3e3ed66a135e302',
  'f6f378bb38974e20f3a0b5158b3f614ca654d677cd0e35f53d25530686186b04',
  '1453a26a93b9cfd3f3f5c9f831de8b54c43d6ec0d42199a661b053035fffc9ff',
  '1e90067bda5b2b278eb9d35a98714966de4e0196eab30a4129b2cc8976a65fde',
]);
const OBJECT_ARGS = ['--no-replace-objects', 'cat-file', '--batch-all-objects', '--batch-check=%(objectname) %(objecttype)'];
function requiresLedger(objects) {
  need(typeof objects === 'string', 'REGISTER_HISTORY_LEDGER');
  let required = false;
  for (const row of objects.split('\n').filter(Boolean)) {
    const m = /^([a-f0-9]{40}|[a-f0-9]{64}) (commit|tree|blob|tag)$/.exec(row);
    need(m, 'REGISTER_HISTORY_LEDGER');
    if (m[2] === 'commit' && SOURCE_PINS.has(digest(Buffer.from(m[1])).slice(7))) required = true;
  }
  return required;
}
function localHistoryRequired(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  const r = spawnSync('git', OBJECT_ARGS, { cwd: root, env, encoding: 'utf8',
    windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 * 1024 });
  need(!r.error && r.status === 0, 'REGISTER_HISTORY_LEDGER');
  return requiresLedger(r.stdout);
}
function ledger(raw) {
  need(digest(raw) === LEDGER_DIGEST, 'REGISTER_HISTORY_LEDGER');
  return JSON.parse(raw);
}
// Load immutable constants with the module, keeping compilation free of ambient
// I/O. Installed hosts and unrelated source histories authorize none. A bad
// source companion is never empty; only ENOENT plus proven absence may be empty.
function loadEvents() {
  try {
    const root = path.resolve(__dirname, '../../..');
    const manifest = parseJsonUnique(fs.readFileSync(path.join(root, 'protocol-manifest.json'), 'utf8'));
    if (manifest.role === 'installed') return { events: [], openEvents: [] };
    need(manifest.role === 'source', 'REGISTER_HISTORY_LEDGER');
    const file = path.join(__dirname, LEDGER_NAME);
    let st;
    try { st = fs.lstatSync(file); }
    catch (e) {
      need(e.code === 'ENOENT' && !localHistoryRequired(root), 'REGISTER_HISTORY_LEDGER');
      return { events: [], openEvents: [] };
    }
    need(st.isFile() && !st.isSymbolicLink() && st.nlink === 1 && st.size <= 65536, 'REGISTER_HISTORY_LEDGER');
    return ledger(fs.readFileSync(file));
  } catch { return null; }
}
const DATA = loadEvents();
function events() { need(DATA, 'REGISTER_HISTORY_LEDGER'); return DATA; }
// Live compilation checks the immutable snapshot, independent of local data.
// Historical snapshots predate the companion and remain archive-only.
function sourceTree(tree) {
  const manifest = tree.get('protocol-manifest.json');
  if (!manifest) return false;
  need(manifest.mode === '100644', 'REGISTER_HISTORY_LEDGER');
  return parseJsonUnique(bytesOf(manifest).toString('utf8')).role === 'source';
}
function needsInventory(tree) { return sourceTree(tree) && !tree.has(LEDGER); }
function checkTree(tree, historyRequired = true) {
  if (!sourceTree(tree)) return;
  const entry = tree.get(LEDGER);
  if (!entry && historyRequired === false) { events(); return; }
  need(entry && entry.mode === '100644', 'REGISTER_HISTORY_LEDGER');
  ledger(bytesOf(entry));
}
function openHistory(sourceSha, raw) {
  const OPEN_EVENTS = events().openEvents;
  const event = OPEN_EVENTS.find(e => e.sourceSha === sourceSha && e.openDigest === digest(raw));
  return event ? [JSON.parse(JSON.stringify(event))] : [];
}
function openBytes(reg, sourceSha, history = []) {
  const formats = history.filter(e => Object.hasOwn(e, 'openDigest'));
  need(formats.length <= 1 && formats.every(e => e.sourceSha === sourceSha && verify(e)), 'REGISTER_HISTORY_UNACCEPTED');
  const raw = Buffer.from(JSON.stringify(reg, null, formats[0]?.indent || 2) + '\n');
  need(!formats.length || digest(raw) === formats[0].openDigest, 'REGISTER_HISTORY_UNACCEPTED');
  return raw;
}
function accepted(sourceSha, processDigest) {
  const EVENTS = events().events;
  const e = EVENTS.find(e => [e.introducedBy, e.resolutionParent].includes(sourceSha) && e.processDigest === processDigest);
  return e ? JSON.parse(JSON.stringify({ ...e, sourceSha })) : null;
}
function verify(record) {
  const OPEN_EVENTS = events().openEvents;
  return record !== null && typeof record === 'object' &&
    isDeepStrictEqual(record, Object.hasOwn(record, 'openDigest')
      ? OPEN_EVENTS.find(e => e.sourceSha === record.sourceSha && e.openDigest === record.openDigest)
      : accepted(record.sourceSha, record.processDigest));
}
function inventory(raw, sourceSha, parse) {
  const record = accepted(sourceSha, digest(raw));
  need(record, 'REGISTER_HISTORY_UNACCEPTED');
  const lines = raw.toString('utf8').match(/[^\n]*\n|[^\n]+$/g) || [];
  let occurrence = 0;
  // Reuse the full strict R1 structural parser. Only the second known identity
  // receives a temporary unused parse identity; the original bytes stay intact.
  const patched = lines.map(line => {
    if (!new RegExp('^\\| ' + record.id + ' \\|').test(line)) return line;
    need(digest(Buffer.from(line)) === record.rowDigests[occurrence], 'REGISTER_HISTORY_UNACCEPTED');
    return ++occurrence === 2 ? line.replace(record.id, 'P-9999') : line;
  }).join('');
  need(occurrence === 2, 'REGISTER_HISTORY_UNACCEPTED');
  const rows = parse(patched).rows.map(r => r.id === 'P-9999'
    ? { ...r, id: record.id + '.historical', line: r.line.replace('P-9999', record.id) } : r);
  return { rows, record };
}
function resolution(parentSha, tipSha, id) {
  const EVENTS = events().events;
  return EVENTS.some(e => e.resolutionParent === parentSha && e.resolvedBy === tipSha && id === e.id + '.historical');
}
module.exports = { accepted, verify, inventory, resolution, openHistory, openBytes, checkTree, requiresLedger, needsInventory, OBJECT_ARGS };

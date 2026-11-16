'use strict';
// Deterministic snapshot compiler and byte-exact legacy migration. No ambient I/O.
const { isDeepStrictEqual: equal } = require('node:util');
const F = require('./register-fragments.cjs');
const V = require('./register-view.cjs');
const L = require('./register-landing.cjs');
const H = require('./register-history.cjs');
const { need, digest } = F;
const ROOT = F.LANDING.slice(0, F.LANDING.lastIndexOf('/') + 1);
const LEGACY = ROOT + 'legacy/', BASE = LEGACY + 'BASE.json', STATE = ROOT + 'STATE.json';
const CAP_KEYS = ['schema', 'id', 'sourceSha', 'rawBase64', 'rawDigest'];
const BASE_KEYS = ['schema', 'sourceSha', 'views', 'processLayout', 'openEnvelope', 'processFiles', 'itemFiles'];
const j = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
const entry = bytes => ({ mode: '100644', bytes });
const clone = value => JSON.parse(JSON.stringify(value));
function safePath(p) {
  return typeof p === 'string' && /^[A-Za-z0-9._/-]+$/.test(p) && !p.split('/').some(s => !s || s === '.' || s === '..' || /[. ]$/.test(s));
}
function snapshot(tree) {
  need(tree instanceof Map, 'REGISTER_INPUT');
  const reads = new Map(), frozen = new Map(), folded = new Set(); let total = 0;
  for (const [p, e] of tree) frozen.set(p, { mode: e.mode, bytes: () => {
    if (reads.has(p)) return reads.get(p).bytes;
    need(safePath(p) && !folded.has(p.toLowerCase()) && e.mode === '100644', 'REGISTER_PATH');
    folded.add(p.toLowerCase());
    const bytes = Buffer.from(F.bytesOf(e)); total += bytes.length;
    need(total <= L.MAX_TOTAL, 'REGISTER_LIMIT');
    reads.set(p, { mode: e.mode, bytes }); return bytes;
  } });
  // Alias checks are independent of enumeration/read order, including unused capsules.
  const names = [...tree.keys()].filter(p => typeof p === 'string' &&
    (p.toLowerCase().startsWith(ROOT) || F.PREFIXES.some(prefix => p.toLowerCase().startsWith(prefix))));
  need(new Set(names.map(p => p.toLowerCase())).size === names.length && names.every(safePath), 'REGISTER_PATH');
  return { tree: frozen, reads };
}
function bytesAt(tree, path, limit = L.MAX_FILE) {
  const e = tree.get(path); need(e, 'REGISTER_INPUT_MISSING');
  const bytes = F.bytesOf(e); L.decode(bytes, limit); return bytes;
}
function readJson(tree, path, limit = L.MAX_FILE) { return L.json(bytesAt(tree, path, limit), limit); }
function envelope(reg) {
  const fields = Object.fromEntries(Object.entries(reg).filter(([k]) => k !== 'items'));
  return { fields, itemFieldIndex: Object.keys(reg).indexOf('items') };
}
function restoreEnvelope(env, items) {
  F.keys(env, ['fields', 'itemFieldIndex'], [], 'REGISTER_LEGACY_INVALID');
  need(env.fields && !Array.isArray(env.fields) && typeof env.fields === 'object' && !Object.hasOwn(env.fields, 'items') &&
    Number.isInteger(env.itemFieldIndex) && env.itemFieldIndex >= 0 && env.itemFieldIndex <= Object.keys(env.fields).length, 'REGISTER_LEGACY_INVALID');
  const entries = Object.entries(env.fields); entries.splice(env.itemFieldIndex, 0, ['items', items]);
  return Object.fromEntries(entries);
}
function inventoryProcess(raw, { sourceSha, historical = false } = {}) {
  const source = L.decode(raw), parse = require('./register-renumber.cjs').parseRegisterRows;
  let parsed, acceptedHistory = [];
  try { parsed = parse(source); }
  catch (e) {
    if (!historical || e.code !== 'TRAIN-LAND-PROCESS-DUPLICATE') throw e;
    parsed = H.inventory(raw, sourceSha, parse); acceptedHistory = [parsed.record];
  }
  const byLine = new Map(parsed.rows.map(r => [r.line, r.id])), processRows = new Map(), processLayout = [];
  const lines = source.match(/[^\n]*\n|[^\n]+$/g) || [];
  for (const line of lines) {
    const id = byLine.get(line.endsWith('\n') ? line.slice(0, -1) : line);
    if (id) {
      need(!processRows.has(id), 'REGISTER_LEGACY_INVALID'); processRows.set(id, Buffer.from(line)); processLayout.push({ processId: id });
    } else processLayout.push({ rawBase64: Buffer.from(line).toString('base64') });
  }
  need(processRows.size === parsed.rows.length, 'REGISTER_LEGACY_INVALID');
  return { processRows, processLayout, acceptedHistory };
}
function layoutBytes(layout, processRows, extraRows = []) {
  need(Array.isArray(layout), 'REGISTER_LEGACY_INVALID');
  const seen = new Set(), lines = []; let insertion = -1;
  for (const row of layout) {
    if (Object.hasOwn(row, 'processId')) {
      F.keys(row, ['processId'], [], 'REGISTER_LEGACY_INVALID');
      need(processRows.has(row.processId) && !seen.has(row.processId), 'REGISTER_LEGACY_INVALID');
      seen.add(row.processId); lines.push(processRows.get(row.processId)); insertion = lines.length;
    } else {
      F.keys(row, ['rawBase64'], [], 'REGISTER_LEGACY_INVALID'); lines.push(L.base64(row.rawBase64));
    }
  }
  need(seen.size === processRows.size && (!extraRows.length || insertion >= 0), 'REGISTER_LEGACY_INVALID');
  lines.splice(insertion < 0 ? lines.length : insertion, 0, ...extraRows);
  return Buffer.concat(lines);
}
function capsule(kind, id, sourceSha, raw) {
  return { schema: `register-legacy-${kind}/1`, id, sourceSha, rawBase64: raw.toString('base64'), rawDigest: digest(raw) };
}
function exportLegacy({ tree, sourceSha, viewLabels, historical = false }) {
  need(F.SHA.test(sourceSha), 'REGISTER_INPUT');
  const snap = snapshot(tree), source = snap.tree;
  const process = bytesAt(source, F.COMPILED[0]), open = bytesAt(source, F.COMPILED[1]);
  const table = bytesAt(source, F.COMPILED[2]);
  const openHistory = historical ? H.openHistory(sourceSha, open) : [];
  const reg = L.json(open); need(V.validate(reg).length === 0 && H.openBytes(reg, sourceSha, openHistory).equals(open), 'MIGRATION_BYTES');
  need(Buffer.from(V.renderTable(reg, viewLabels)).equals(table), 'MIGRATION_BYTES');
  const { processRows, processLayout, acceptedHistory } = inventoryProcess(process, { sourceSha, historical });
  const files = new Map(), processFiles = {}, itemFiles = {}, ids = new Set();
  for (const [id, raw] of [...processRows].sort(([a], [b]) => L.ascii(a + '.json', b + '.json'))) {
    const p = LEGACY + `process/${id}.json`, bytes = j(capsule('process', id, sourceSha, raw));
    need(bytes.length <= L.MAX_LINE, 'REGISTER_LIMIT'); files.set(p, entry(bytes)); processFiles[p] = digest(bytes);
  }
  for (const [i, it] of reg.items.entries()) {
    need(it.id === 'OR-' + String(i + 1).padStart(4, '0') && !ids.has(it.id), 'REGISTER_LEGACY_INVALID'); ids.add(it.id);
    // Live input must equal canonical JSON; named archival formatting is pinned above.
    // This is the exact item span,
    // without the four-space indentation supplied by the enclosing items array.
    const raw = Buffer.from(JSON.stringify(it, null, 2));
    const p = LEGACY + `open/${it.id}.json`, bytes = j(capsule('open', it.id, sourceSha, raw));
    need(bytes.length <= L.MAX_LINE, 'REGISTER_LIMIT'); files.set(p, entry(bytes)); itemFiles[p] = digest(bytes);
  }
  const base = { schema: 'register-legacy-base/1', sourceSha, views: Object.fromEntries(F.COMPILED.map((p, i) => [p, digest([process, open, table][i])])),
    processLayout, openEnvelope: envelope(reg), processFiles, itemFiles,
    ...(historical ? { acceptedHistory: [...acceptedHistory, ...openHistory] } : {}) };
  const manifest = j(base); files.set(BASE, entry(manifest));
  const staged = new Map([...tree, ...files]); staged.set(F.LANDING, entry(Buffer.alloc(0)));
  const pins = { migrationSha: sourceSha, manifestDigest: digest(manifest), transitions: [], ...(historical ? { historical: true } : {}) };
  const effective = readLegacy({ tree: staged, legacy: pins });
  const outputs = legacyViews(effective, viewLabels);
  need(outputs.size === 3 && F.COMPILED.every(p => outputs.get(p).equals(bytesAt(source, p))), 'MIGRATION_BYTES');
  return { files, base, ...pins, outputs };
}
function readLegacy({ tree, legacy }) {
  need(legacy && F.SHA.test(legacy.migrationSha) && F.DIGEST.test(legacy.manifestDigest) && Array.isArray(legacy.transitions), 'REGISTER_LEGACY_INVALID');
  const baseRaw = bytesAt(tree, BASE); need(digest(baseRaw) === legacy.manifestDigest, 'REGISTER_LEGACY_INVALID');
  const base = L.json(baseRaw); F.keys(base, BASE_KEYS, legacy.historical === true ? ['acceptedHistory'] : [], 'REGISTER_LEGACY_INVALID');
  need(base.schema === 'register-legacy-base/1' && base.sourceSha === legacy.migrationSha, 'REGISTER_LEGACY_INVALID');
  let acceptedHistory = Object.hasOwn(base, 'acceptedHistory') ? base.acceptedHistory : [];
  need(Array.isArray(acceptedHistory) && acceptedHistory.every(H.verify), 'REGISTER_HISTORY_UNACCEPTED');
  F.keys(base.views, F.COMPILED, [], 'REGISTER_LEGACY_INVALID');
  need(Object.values(base.views).every(h => typeof h === 'string' && F.DIGEST.test(h)), 'REGISTER_LEGACY_INVALID');
  const processRows = new Map(), itemRows = new Map(), expectedPaths = new Set([BASE]);
  for (const [kind, fileMap, rows, grammar, dir] of [['process', base.processFiles, processRows, F.P, 'process'], ['open', base.itemFiles, itemRows, F.OR, 'open']]) {
    need(fileMap && typeof fileMap === 'object' && !Array.isArray(fileMap) && Object.keys(fileMap).join() === Object.keys(fileMap).sort(L.ascii).join(), 'REGISTER_LEGACY_INVALID');
    for (const [p, hash] of Object.entries(fileMap)) {
      const bytes = bytesAt(tree, p, L.MAX_LINE); need(digest(bytes) === hash, 'REGISTER_LEGACY_INVALID');
      const c = L.json(bytes, L.MAX_LINE); F.keys(c, CAP_KEYS, [], 'REGISTER_LEGACY_INVALID');
      const archived = kind === 'process' && typeof c.id === 'string' && c.id.endsWith('.historical') && legacy.historical === true &&
        acceptedHistory.some(h => h.id + '.historical' === c.id);
      need(c.schema === `register-legacy-${kind}/1` && typeof c.id === 'string' && (grammar.test(c.id) || archived) && c.sourceSha === base.sourceSha && p === LEGACY + `${dir}/${c.id}.json` && !rows.has(c.id), 'REGISTER_LEGACY_INVALID');
      const raw = L.base64(c.rawBase64); need(digest(raw) === c.rawDigest, 'REGISTER_LEGACY_INVALID');
      if (kind === 'open') {
        const item = L.json(raw, L.MAX_LINE); need(item.id === c.id && equal(item, JSON.parse(JSON.stringify(item))), 'REGISTER_LEGACY_INVALID');
      } else {
        const id = archived ? c.id.slice(0, -'.historical'.length) : c.id;
        const parsed = inventoryProcess(raw); need(parsed.processRows.size === 1 && parsed.processRows.has(id) && raw.equals(parsed.processRows.get(id)), 'REGISTER_LEGACY_INVALID');
      }
      rows.set(c.id, raw); expectedPaths.add(p);
    }
  }
  const sortedItems = [...itemRows].sort(([a], [b]) => L.ascii(a, b)).map(([, b]) => L.json(b, L.MAX_LINE));
  const reg = restoreEnvelope(base.openEnvelope, sortedItems);
  need(V.validate(reg).length === 0 && reg.items.every((it, i) => it.id === 'OR-' + String(i + 1).padStart(4, '0')), 'REGISTER_LEGACY_INVALID');
  const maxP = () => Math.max(0, ...[...processRows.keys()].map(id => Number(id.split('.')[0].slice(2))));
  const initialMaxP = maxP(), initialItemCount = itemRows.size;
  const baseOpen = H.openBytes(reg, base.sourceSha, acceptedHistory);
  need(digest(layoutBytes(base.processLayout, processRows)) === base.views[F.COMPILED[0]] && digest(baseOpen) === base.views[F.COMPILED[1]], 'REGISTER_LEGACY_INVALID');
  const baseInventory = inventoryProcess(layoutBytes(base.processLayout, processRows), { sourceSha: base.sourceSha, historical: legacy.historical === true });
  need(equal(baseInventory.processRows, processRows) && equal([...baseInventory.acceptedHistory,
    ...H.openHistory(base.sourceSha, baseOpen)], acceptedHistory), 'REGISTER_HISTORY_UNACCEPTED');
  let processLayout = clone(base.processLayout), openEnvelope = clone(base.openEnvelope), previous = null, sourceSha = base.sourceSha;
  const deltas = [];
  for (const t of legacy.transitions) if (t.deltaPath !== null) {
    need(t.deltaPath === LEGACY + `deltas/${t.tipSha}.json` && !expectedPaths.has(t.deltaPath), 'REGISTER_LEGACY_INVALID');
    const raw = bytesAt(tree, t.deltaPath), d = L.json(raw);
    const archive = legacy.historical === true && d.schema === 'register-historical-delta/1';
    F.keys(d, ['schema', 'parentSha', 'tipSha', 'previousDelta', 'changes', 'envelope'], archive ? ['acceptedHistory', 'removed'] : [], 'REGISTER_LEGACY_INVALID');
    need((d.schema === 'register-legacy-delta/1' || archive) && d.parentSha === t.parentSha && d.tipSha === t.tipSha && F.SHA.test(d.parentSha) && F.SHA.test(d.tipSha) && d.previousDelta === previous && Array.isArray(d.changes), 'REGISTER_LEGACY_INVALID');
    if (archive) {
      need(Array.isArray(d.acceptedHistory) && d.acceptedHistory.every(H.verify) && Array.isArray(d.removed) && new Set(d.removed).size === d.removed.length, 'REGISTER_HISTORY_UNACCEPTED');
      for (const id of d.removed) {
        need(H.resolution(d.parentSha, d.tipSha, id) && processRows.has(id), 'REGISTER_HISTORY_UNACCEPTED'); processRows.delete(id);
      }
      acceptedHistory = d.acceptedHistory;
    }
    let prior = ''; let addedItems = 0;
    for (const c of d.changes) {
      F.keys(c, ['kind', 'id', 'beforeDigest', 'afterRawBase64', 'afterDigest'], [], 'REGISTER_LEGACY_INVALID');
      const archived = archive && c.kind === 'process' && acceptedHistory.some(h => h.id + '.historical' === c.id);
      need(['process', 'item'].includes(c.kind) && ((c.kind === 'process' ? F.P : F.OR).test(c.id) || archived), 'REGISTER_LEGACY_INVALID');
      const key = c.kind + '/' + c.id; need(key > prior, 'REGISTER_LEGACY_INVALID'); prior = key;
      const rows = c.kind === 'process' ? processRows : itemRows, before = rows.get(c.id), after = L.base64(c.afterRawBase64);
      need(c.beforeDigest === (before ? digest(before) : null) && digest(after) === c.afterDigest && (!before || !before.equals(after)), 'REGISTER_LEGACY_INVALID');
      if (c.kind === 'process') { const p = inventoryProcess(after), id = archived ? c.id.slice(0, -'.historical'.length) : c.id; need(p.processRows.size === 1 && p.processRows.has(id) && p.processRows.get(id).equals(after), 'REGISTER_LEGACY_INVALID'); }
      else { need(L.json(after).id === c.id, 'REGISTER_LEGACY_INVALID'); if (!before) addedItems++; }
      rows.set(c.id, after);
    }
    need(typeof legacy.verifyDelta === 'function' && legacy.verifyDelta(t, d) === true, 'REGISTER_LEGACY_INVALID');
    if (d.envelope !== null) {
      F.keys(d.envelope, ['beforeDigest', 'afterDigest', 'processLayout', 'openEnvelope'], [], 'REGISTER_LEGACY_INVALID');
      const old = { processLayout, openEnvelope }, next = { processLayout: d.envelope.processLayout, openEnvelope: d.envelope.openEnvelope };
      need(d.envelope.beforeDigest === digest(j(old)) && d.envelope.afterDigest === digest(j(next)) && !equal(old, next), 'REGISTER_LEGACY_INVALID');
      // Git adapter must prove metadata/skeleton authorization, not merely supply hashes.
      processLayout = next.processLayout; openEnvelope = next.openEnvelope;
    }
    const inventory = inventoryProcess(layoutBytes(processLayout, processRows), { sourceSha: d.tipSha, historical: archive });
    sourceSha = d.tipSha;
    const currentReg = restoreEnvelope(openEnvelope, [...itemRows].sort(([a], [b]) => L.ascii(a, b)).map(([, b]) => L.json(b)));
    const currentOpen = H.openBytes(currentReg, sourceSha, acceptedHistory);
    need(equal(inventory.processRows, processRows) && equal([...inventory.acceptedHistory,
      ...H.openHistory(sourceSha, currentOpen)], acceptedHistory), 'REGISTER_HISTORY_UNACCEPTED');
    expectedPaths.add(t.deltaPath); previous = digest(raw);
    deltas.push({ path: t.deltaPath, parentSha: d.parentSha, tipSha: d.tipSha, addedItems,
      maxP: maxP() });
  }
  const actualPaths = [...tree.keys()].filter(p => p.toLowerCase().startsWith(LEGACY));
  need(actualPaths.length === expectedPaths.size && actualPaths.every(p => expectedPaths.has(p)), 'REGISTER_LEGACY_INVALID');
  layoutBytes(processLayout, processRows);
  const effectiveReg = restoreEnvelope(openEnvelope, [...itemRows].sort(([a], [b]) => L.ascii(a, b)).map(([, b]) => L.json(b)));
  need(V.validate(effectiveReg).length === 0, 'REGISTER_LEGACY_INVALID');
  return { base, processRows, itemRows, processLayout, openEnvelope, reg: effectiveReg, initialMaxP, initialItemCount,
    maxP: maxP(), deltas, transitions: legacy.transitions, historical: legacy.historical === true, acceptedHistory, sourceSha };
}
function legacyViews(legacy, labels) {
  const process = layoutBytes(legacy.processLayout, legacy.processRows);
  const reg = restoreEnvelope(legacy.openEnvelope, [...legacy.itemRows].sort(([a], [b]) => L.ascii(a, b)).map(([, bytes]) => L.json(bytes, L.MAX_LINE)));
  return new Map([[F.COMPILED[0], process], [F.COMPILED[1], H.openBytes(reg, legacy.sourceSha, legacy.acceptedHistory)], [F.COMPILED[2], Buffer.from(V.renderTable(reg, labels))]]);
}
function planLegacyDelta({ legacy, parentSha, tipSha, process, open, previousDelta = null, historical = false }) {
  need(F.SHA.test(parentSha) && F.SHA.test(tipSha) && (previousDelta === null || F.DIGEST.test(previousDelta)), 'REGISTER_LEGACY_INVALID');
  need(!historical || legacy.historical === true, 'REGISTER_HISTORY_UNACCEPTED');
  const next = inventoryProcess(process, { sourceSha: tipSha, historical }), reg = L.json(open), removed = [];
  const acceptedHistory = [...next.acceptedHistory, ...(historical ? H.openHistory(tipSha, open) : [])];
  need(V.validate(reg).length === 0 && H.openBytes(reg, tipSha, acceptedHistory).equals(open), 'MIGRATION_BYTES');
  const itemRows = new Map(reg.items.map(it => [it.id, Buffer.from(JSON.stringify(it, null, 2))]));
  need(itemRows.size === reg.items.length, 'REGISTER_LEGACY_INVALID');
  const changes = [];
  for (const [kind, before, after] of [['process', legacy.processRows, next.processRows], ['item', legacy.itemRows, itemRows]]) {
    for (const id of before.keys()) if (!after.has(id)) {
      need(historical && kind === 'process' && H.resolution(parentSha, tipSha, id), 'REGISTER_LEGACY_INVALID'); removed.push(id);
    }
    for (const [id, raw] of after) if (!before.has(id) || !before.get(id).equals(raw)) changes.push({ kind, id,
      beforeDigest: before.has(id) ? digest(before.get(id)) : null, afterRawBase64: raw.toString('base64'), afterDigest: digest(raw) });
  }
  changes.sort((a, b) => L.ascii(a.kind + '/' + a.id, b.kind + '/' + b.id));
  const old = { processLayout: legacy.processLayout, openEnvelope: legacy.openEnvelope };
  const current = { processLayout: next.processLayout, openEnvelope: envelope(reg) };
  const value = { schema: historical ? 'register-historical-delta/1' : 'register-legacy-delta/1', parentSha, tipSha, previousDelta, changes,
    envelope: equal(old, current) ? null : { beforeDigest: digest(j(old)), afterDigest: digest(j(current)), ...current },
    ...(historical ? { acceptedHistory, removed: removed.sort(L.ascii) } : {}) };
  const bytes = j(value); need(bytes.length <= L.MAX_FILE, 'REGISTER_LIMIT');
  return { path: LEGACY + `deltas/${tipSha}.json`, bytes, value, transition: { parentSha, tipSha, landingOrdinals: [], deltaPath: LEGACY + `deltas/${tipSha}.json` } };
}
function inputDigest(reads, schemaState, issueProofs, verifiedProofs, viewLabels) {
  const files = [...reads].sort(([a], [b]) => L.ascii(a, b)).map(([p, e]) => [p, e.mode, digest(e.bytes)]);
  const proofs = [...issueProofs].sort(([a], [b]) => L.numeric(a, b)).map(([id, p]) => [id, p.launchId, p.recordDigest, p.issueCommit, p.bootstrapSha]);
  return digest(Buffer.from(JSON.stringify([schemaState, files, [proofs, [...verifiedProofs].sort(L.ascii)], [viewLabels.registerPath, viewLabels.command]])));
}
function compileRegister({ tree, legacy, issueProofs, schemaState, proofReader, viewLabels, historyRequired = true }) {
  const diagnostics = [];
  try {
    need(['pre-migration', 'active'].includes(schemaState) && issueProofs instanceof Map, 'REGISTER_INPUT');
    need(legacy?.historical !== true, 'REGISTER_HISTORY_ARCHIVE_ONLY');
    F.keys(viewLabels, ['registerPath', 'command'], [], 'REGISTER_INPUT');
    need(viewLabels.registerPath === F.COMPILED[1] && typeof viewLabels.command === 'string' && !/[\r\n]/.test(viewLabels.command), 'REGISTER_INPUT');
    const snap = snapshot(tree), source = snap.tree, proofs = new Set();
    H.checkTree(source, historyRequired);
    const verifyCommit = sha => { need(F.SHA.test(sha), 'REGISTER_PROOF'); const ok = typeof proofReader === 'function' && proofReader(sha) === true; if (ok) proofs.add(sha); return ok; };
    if (schemaState === 'active') {
      need(source.has(STATE) && source.has(F.LANDING) && legacy, 'REGISTER_LANDING_UNAVAILABLE');
      const state = readJson(source, STATE); F.keys(state, ['schema', 'mode', 'migrationSha', 'legacyManifestDigest']);
      need(state.schema === 'register-state/1' && state.mode === 'shadow' && state.migrationSha === legacy.migrationSha && state.legacyManifestDigest === legacy.manifestDigest, 'REGISTER_LANDING_UNAVAILABLE');
    }
    const effective = readLegacy({ tree: source, legacy });
    const inputs = F.readFragmentInputs({ tree: source, issueProofs });
    need(inputs.ok, inputs.diagnostics[0]?.code || 'REGISTER_FRAGMENT');
    const landing = L.readRegisterLanding({ tree: source, launches: L.descriptors(inputs), legacy: effective });
    const fragments = new Map(inputs.fragments.map(f => [`${f.launchId}-${f.slot}`, f]));
    const rows = [], items = [...effective.itemRows.values()].map(b => L.json(b));
    const projectedItems = new Map();
    for (const [id, landed] of landing.byLaunch) {
      for (const slot of Object.keys(landed.processIds).sort(L.numeric)) {
        const f = fragments.get(`${id}-${slot}`); need(f, 'REGISTER_REFERENCE');
        const cells = f.cells.map(c => F.projectRegisterValue(c, landing)); cells[0] = landed.processIds[slot];
        rows.push(Buffer.from('| ' + cells.join(' | ') + ' |\n'));
      }
      for (const slot of Object.keys(landed.itemIds).sort(L.numeric)) {
        const f = fragments.get(`${id}-${slot}`); need(f, 'REGISTER_REFERENCE');
        const it = F.projectRegisterValue(f.item, landing);
        const ordered = Object.fromEntries(V.ITEM_FIELDS.filter(([k]) => Object.hasOwn(it, k)).map(([k]) => [k, it[k]]));
        items.push(ordered); projectedItems.set(`${id}-${slot}`, ordered);
      }
    }
    items.sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3)));
    const reg = restoreEnvelope(effective.openEnvelope, items);
    const process = layoutBytes(effective.processLayout, effective.processRows, rows);
    // Preserve every byte for empty migration. Derive counters only when there are changes.
    if (rows.length || projectedItems.size) {
      V.recount(reg);
      const proposed = require('./register-renumber.cjs').parseRegisterRows(process).rows.filter(r => r.line.split('|').at(-2).trim() === 'proposed').length;
      const proc = reg.sources.find(s => s.key === 'PROC'); need(proc, 'REGISTER_PROC');
      proc.itemsTotal = proposed; if (Object.hasOwn(proc, 'openAtSource')) proc.openAtSource = proposed;
      if (typeof proc.kind === 'string') proc.kind = proc.kind.replace(/the \d+ proposed rows/, `the ${proposed} proposed rows`);
    }
    const logicalBaseline = F.normalizeRegisterBaseline({ compiled: reg, legacy: effective.reg, landing, fragments: inputs.fragments });
    const relations = F.validateFragmentRelations({ tree: source, mode: 'line', schemaState, issueProofs,
      inputs, logicalBaseline, proofReader: verifyCommit });
    need(relations.ok, relations.diagnostics[0]?.code || 'REGISTER_FRAGMENT');
    const version = readJson(source, 'protocol-manifest.json').protocolVersion;
    const sourceIds = Object.fromEntries(['KDR14', 'RR201'].map(k => [k, effective.reg.items.flatMap(it => it.sourceIds).filter(id => id.startsWith(k + ':'))]));
    const semantic = V.checkRegister(reg, { version, processText: L.decode(process), sourceIds, proofReader: proof => {
      const c = /^commit ([a-f0-9]{7,40})(?:\s|$)/.exec(proof || '');
      if (c) { const ok = typeof proofReader === 'function' && proofReader(c[1]) === true; if (ok) proofs.add(c[1]); return ok; }
      const m = /^(?:the decision named by\s+)?(?:file )?(\S+)/.exec(proof || '');
      if (!m || !safePath(m[1]) || !source.has(m[1])) return false;
      bytesAt(source, m[1]); return true;
    } });
    need(semantic.problems.length === 0, 'REGISTER_CHECK');
    require('./register-renumber.cjs').parseRegisterRows(process);
    const outputs = new Map([[F.COMPILED[0], process], [F.COMPILED[1], j(reg)], [F.COMPILED[2], Buffer.from(V.renderTable(reg, viewLabels))]]);
    // The seed pins all three views, including the renderer byte contract.
    if (!landing.byLaunch.size && !effective.deltas.length) need(F.COMPILED.every(p => digest(outputs.get(p)) === effective.base.views[p]), 'MIGRATION_BYTES');
    return { ok: true, outputs, diagnostics, inputDigest: inputDigest(snap.reads, schemaState, issueProofs, proofs, viewLabels), landing };
  } catch (e) {
    diagnostics.push({ path: '', code: e.code || 'REGISTER_INPUT' });
    return { ok: false, diagnostics };
  }
}
function planLanding({ parentTree, parentSha, candidates, issueProofs, legacy, proofReader, schemaState, viewLabels, historyRequired = true }) {
  need(legacy?.historical !== true, 'REGISTER_HISTORY_ARCHIVE_ONLY');
  // One lazy snapshot across planning and compilation: never reread a moving
  // adapter byte supplier to allocate IDs from one state and publish another.
  parentTree = snapshot(parentTree).tree;
  H.checkTree(parentTree, historyRequired);
  const effective = readLegacy({ tree: parentTree, legacy }), inputs = F.readFragmentInputs({ tree: parentTree, issueProofs });
  need(inputs.ok, 'REGISTER_FRAGMENT');
  const planned = L.planEntries({ tree: parentTree, parentSha, candidates, inputs, legacy: effective });
  const tree = new Map(parentTree); tree.set(F.LANDING, entry(planned.bytes));
  const result = compileRegister({ tree, legacy: { ...legacy, transitions: planned.transitions }, issueProofs, schemaState, proofReader, viewLabels, historyRequired });
  need(result.ok, result.diagnostics[0]?.code || 'REGISTER_PLAN_INVALID');
  return { ...planned, outputs: result.outputs, landing: result.landing, inputDigest: result.inputDigest };
}
function compileHistorical({ tree, legacy, viewLabels }) {
  need(legacy?.historical === true && !tree.has(STATE) && !F.bytesOf(tree.get(F.LANDING)).length &&
    ![...tree.keys()].some(p => F.PREFIXES.some(prefix => p.startsWith(prefix))), 'REGISTER_HISTORY_ARCHIVE_ONLY');
  const snap = snapshot(tree), effective = readLegacy({ tree: snap.tree, legacy });
  const outputs = legacyViews(effective, viewLabels);
  return { ok: true, diagnostics: [], outputs, acceptedHistory: effective.acceptedHistory,
    inputDigest: inputDigest(snap.reads, 'historical', new Map(), new Set(), viewLabels) };
}
const SHADOW = ROOT + 'SHADOW.jsonl';
function scopedProofs(tree, proofs) {
  return new Map([...proofs].filter(([id]) => tree.has(F.PREFIXES[0] + id + '.json')));
}
function bootstrapRegister({ parentTree, parentSha, issueProofs, proofReader, viewLabels, historyRequired = true }) {
  need(![...parentTree.keys()].some(p => p.toLowerCase().startsWith(ROOT)), 'REGISTER_BOOTSTRAP_INVALID');
  const seed = exportLegacy({ tree: parentTree, sourceSha: parentSha, viewLabels });
  const files = new Map(seed.files);
  files.set(STATE, entry(j({ schema: 'register-state/1', mode: 'shadow', migrationSha: parentSha, legacyManifestDigest: seed.manifestDigest })));
  files.set(F.LANDING, entry(Buffer.alloc(0))); files.set(SHADOW, entry(Buffer.alloc(0)));
  const tree = new Map([...parentTree, ...files]);
  const result = compileRegister({ tree, legacy: seed, issueProofs: scopedProofs(tree, issueProofs), schemaState: 'active', proofReader, viewLabels, historyRequired });
  need(result.ok && F.COMPILED.every(p => result.outputs.get(p).equals(bytesAt(parentTree, p))), 'REGISTER_BOOTSTRAP_INVALID');
  return { files, tree, legacy: seed, result };
}
function planRegisterTrain({ parentTree, tree, parentSha, tipSha, legacy, issueProofs, proofReader, viewLabels, launchId = null, renumber = null, historyRequired = true }) {
  need(parentTree.has(STATE) && tree.has(STATE), 'REGISTER_LANDING_UNAVAILABLE');
  const before = compileRegister({ tree: parentTree, legacy, issueProofs: scopedProofs(parentTree, issueProofs), schemaState: 'active', proofReader, viewLabels, historyRequired });
  need(before.ok, before.diagnostics[0]?.code || 'REGISTER_INPUT');
  const oldShadow = bytesAt(parentTree, SHADOW), observations = L.readShadow(oldShadow);
  const parentActual = new Map(F.COMPILED.map(p => [p, bytesAt(parentTree, p)]));
  if (!observations.length) need(F.COMPILED.every(p => parentActual.get(p).equals(before.outputs.get(p))), 'REGISTER_PARENT_DRIFT');
  else {
    const last = observations.at(-1).record;
    // A recorded shadow divergence is retained; an unrecorded parent drift refuses.
    need(equal(last.expected, L.shadowHashes(before.outputs)) && equal(last.actual, L.shadowHashes(parentActual)), 'REGISTER_PARENT_DRIFT');
  }
  const actual = new Map(F.COMPILED.map(p => [p, bytesAt(tree, p)]));
  const files = new Map(), next = new Map(tree), transitions = [...legacy.transitions];
  let planned = null;
  if (launchId !== null) {
    need(F.LAUNCH.test(launchId) && F.COMPILED.every(p => actual.get(p).equals(parentActual.get(p))), 'REGISTER_COMPILED_EDIT');
    planned = planLanding({ parentTree: tree, parentSha, candidates: [{ tipSha, launchId }], legacy,
      issueProofs: scopedProofs(tree, issueProofs), proofReader, schemaState: 'active', viewLabels, historyRequired });
    files.set(F.LANDING, entry(planned.bytes)); next.set(F.LANDING, entry(planned.bytes));
    transitions.splice(0, transitions.length, ...planned.transitions);
    renumber = require('./register-renumber.cjs').buildRenumberV2(planned.additions, renumber);
  } else {
    const effective = readLegacy({ tree: parentTree, legacy });
    const priorDelta = [...legacy.transitions].reverse().find(t => t.deltaPath !== null);
    const delta = planLegacyDelta({ legacy: effective, parentSha, tipSha,
      process: actual.get(F.COMPILED[0]), open: actual.get(F.COMPILED[1]),
      previousDelta: priorDelta ? digest(bytesAt(parentTree, priorDelta.deltaPath)) : null });
    const changed = delta.value.changes.length || delta.value.envelope !== null;
    if (changed) { files.set(delta.path, entry(delta.bytes)); next.set(delta.path, entry(delta.bytes)); }
    transitions.push({ parentSha, tipSha, landingOrdinals: [], deltaPath: changed ? delta.path : null });
  }
  const nextLegacy = { ...legacy, transitions, verifyDelta: (t, d) =>
    t.parentSha === parentSha && t.tipSha === tipSha || typeof legacy.verifyDelta === 'function' && legacy.verifyDelta(t, d) === true };
  const result = compileRegister({ tree: next, legacy: nextLegacy, issueProofs: scopedProofs(next, issueProofs), schemaState: 'active', proofReader, viewLabels, historyRequired });
  need(result.ok, result.diagnostics[0]?.code || 'REGISTER_INPUT');
  const observation = L.planShadow({ raw: oldShadow, parentSha, tipSha, inputDigest: result.inputDigest, expected: result.outputs, actual });
  need(observation.appended, 'REGISTER_SHADOW_REPLAY'); files.set(SHADOW, entry(observation.bytes)); next.set(SHADOW, entry(observation.bytes));
  return { files, tree: next, legacy: nextLegacy, result, renumber, differentPaths: L.readShadow(observation.bytes).at(-1).record.differentPaths };
}
module.exports = { ROOT, LEGACY, BASE, STATE, CAP_KEYS, BASE_KEYS, j, entry, safePath, snapshot, bytesAt, readJson,
  envelope, restoreEnvelope, inventoryProcess, layoutBytes, exportLegacy, readLegacy, legacyViews, planLegacyDelta, inputDigest, compileRegister, planLanding, compileHistorical,
  SHADOW, scopedProofs, bootstrapRegister, planRegisterTrain, checkHistoryTree: H.checkTree,
  historyRequired: H.requiresLedger, historyNeedsInventory: H.needsInventory, historyObjectArgs: H.OBJECT_ARGS };

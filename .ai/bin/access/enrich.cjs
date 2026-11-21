'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { discover } = require('./kilo-config.cjs');
const { buildV2, readInventory, modelStatus } = require('./inventory.cjs');
const { readMetadata, safeIdentifier, WORK_KINDS } = require('./metadata.cjs');
const { MAX_BYTES } = require('./public-json.cjs');
const bank = require('./model-bank.json');
const bytes = value => Buffer.from(JSON.stringify(value));
function configFile(file) {
  try { return fs.statSync(file).isFile(); } catch (e) { if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return false; throw Error('CONFIG_UNREADABLE'); }
}
function configRead(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    if (size > MAX_BYTES) throw Error('CONFIG_TOO_LARGE');
    const buffer = Buffer.alloc(MAX_BYTES + 1), count = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (count > MAX_BYTES) throw Error('CONFIG_TOO_LARGE');
    return new (require('node:util').TextDecoder)('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, count));
  } finally { fs.closeSync(fd); }
}
function enrich(base, d) {
  const discovered = discover({ ...d, publicInput: base, read: d.configRead || d.read, file: d.configFile || d.file });
  if (discovered.refused) throw Error('PUBLIC_INPUT_REFUSED');
  const missing = [...discovered.missing], metadata = [bytes(discovered.metadata)];
  // Cline is declaration-only. This explicit public export never reads Cline settings.
  const declaration = path.join(d.root, '.ai', 'access-metadata.cline.json');
  if (d.file(declaration)) {
    try {
      const data = readMetadata(Buffer.from(d.read(declaration)));
      if (data.client !== 'cline' || data.provenance !== 'declared') throw Error('DECLARATION_INVALID');
      metadata.push(bytes(data));
    } catch { missing.push({ id: 'cline-declaration', reason: 'DECLARATION_INVALID', action: 'Owner: declare public Cline metadata' }); }
  } else missing.push({ id: 'cline-declaration', reason: 'DECLARATION_MISSING', action: 'Owner: declare public Cline metadata' });
  const value = JSON.parse(JSON.stringify(buildV2(bytes(base), metadata, d.now)));
  value.missing.push(...missing);
  // Every bank row is judged against the inventory as it was before the bank: the order of the bank never changes which
  // rows are used, which stamp a row keeps or the date of a provider the bank creates.
  const rows = d.bank || bank;
  const configured = value.userProviders.slice(), placeholders = value.models.filter(m => m.providerRef === null);
  // A bank that names one client, provider and model twice with different content contradicts itself: neither row is used.
  const keyOf = b => JSON.stringify([b.client, b.provider, b.id]);
  const contents = new Map();
  for (const b of rows) contents.set(keyOf(b), (contents.get(keyOf(b)) || new Set()).add(JSON.stringify(b)));
  const created = new Set(), seen = new Set();
  for (const b of rows) {
    if (contents.get(keyOf(b)).size > 1 || seen.has(keyOf(b))) continue;
    if (!WORK_KINDS.includes(b.kind) || b.kind === 'unknown') continue;
    try { safeIdentifier(b.client); safeIdentifier(b.provider); safeIdentifier(b.id); } catch { continue; }
    if (!value.clients.some(c => c.id === b.client && c.installed) || b.client === 'cline') continue;
    const routeMatch = value.routes.some(r => r.client === b.client && r.model === b.id);
    const listed = value.clients.some(c => c.id === b.client && c.models.includes(b.id));
    // Only a provider the user configured admits rows that are neither routed nor listed, never one an earlier bank row created.
    if (!configured.some(p => p.client === b.client && p.name === b.provider) && !routeMatch && !listed) continue;
    // A bank row without its own date is unknown and never fresh: it is not used.
    const at = Date.parse(b.at);
    if (!Number.isFinite(at)) continue;
    seen.add(keyOf(b));
    const common = { client: b.client, provenance: 'declared', at: new Date(at).toISOString(), expiresAt: new Date(at + 86400000).toISOString() };
    let provider = value.userProviders.find(p => p.client === b.client && p.name === b.provider);
    if (!provider) { provider = { name: b.provider, keyPresent: false, ...common }; value.userProviders.push(provider); created.add(provider); }
    // A provider the bank creates carries the oldest date of the bank rows that use it, never a newer one.
    else if (created.has(provider) && at < Date.parse(provider.at)) Object.assign(provider, { at: common.at, expiresAt: common.expiresAt });
    const existing = value.models.find(m => m.client === b.client && m.id === b.id && m.providerRef === b.provider);
    if (existing && existing.kind !== 'unknown') continue; // Explicit provider modalities take precedence.
    // The bank only labels a row that is already here (an observed row or a listed placeholder): that row keeps its own
    // measured stamp, for every provider the bank names for it. Only a row the bank alone creates carries the bank row's own
    // date, never a newer one.
    const own = existing || placeholders.find(m => m.client === b.client && m.id === b.id);
    const row = { id: b.id, providerRef: b.provider, kind: b.kind,
      modelKinds: b.kind === 'text' || b.kind === 'vision' ? ['text'] : b.kind === 'speech' ? ['audio'] : b.kind === 'embedding' ? ['embedding'] : ['unknown'],
      ...(own ? { client: own.client, provenance: own.provenance, at: own.at, expiresAt: own.expiresAt } : common),
      paid: typeof b.paid === 'boolean' ? b.paid : 'unknown', probeState: 'unknown' };
    row.status = modelStatus(row, provider, base.network, d.now);
    // Replace only the legacy placeholder or same-provider unknown metadata.
    value.models = value.models.filter(m => !(m.client === row.client && m.id === row.id && (m.providerRef === null || m.providerRef === row.providerRef)));
    value.models.push(row);
  }
  for (const route of value.routes) {
    const candidates = value.models.filter(m => m.client === route.client && m.id === route.model);
    route.kind = candidates.length === 1 ? candidates[0].kind : 'unknown';
  }
  for (const model of value.models) {
    const provider = value.userProviders.find(p => p.client === model.client && p.name === model.providerRef);
    model.status = modelStatus(model, provider, value.network, d.now);
    if (model.status !== 'AVAILABLE') value.missing.push({ id: `${model.client}:${model.id}`, reason: model.status, action: 'Check route metadata and key presence; inventory is advisory' });
  }
  return readInventory(bytes(value));
}
function readCache(input, now = Date.now()) {
  const value = JSON.parse(JSON.stringify(readInventory(input)));
  if (Date.parse(value.at) > now || now - Date.parse(value.at) >= 86400000) throw Error('INVENTORY_EXPIRED');
  if (value.schema === 'access-inventory/2') for (const model of value.models) {
    model.status = modelStatus(model, value.userProviders.find(p => p.client === model.client && p.name === model.providerRef), value.network, now);
    value.missing = value.missing.filter(m => m.id !== `${model.client}:${model.id}`);
    if (model.status !== 'AVAILABLE') value.missing.push({ id: `${model.client}:${model.id}`, reason: model.status, action: 'Refresh public metadata and check key presence' });
  }
  return readInventory(bytes(value));
}
module.exports = { enrich, readCache, configRead, configFile };

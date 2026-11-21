#!/usr/bin/env node
'use strict';
const { readPublicJson, validate, freeze, fail } = require('./public-json.cjs');
const meta = require('./metadata.cjs');
// Legacy routes repeat client model lists. Typed inventory/cache needs a larger
// bound than a single public metadata export or credential-bearing config.
const INVENTORY_MAX_BYTES = 8 * 1024 * 1024;
const INVENTORY_MAX_MODELS = 16384;
const v1Schema = require('./inventory.schema.json');
const { secretIn } = require('../lib/secrets.cjs');
const { object, array, identifier, modelId, time } = meta;
const provenance = { enum: ['observed', 'declared'] };
const stamp = { provenance, at: time, expiresAt: time };
const modelSchema = object({ providerRef: { type: ['string', 'null'], ...Object.fromEntries(Object.entries(identifier).filter(([k]) => k !== 'type')) },
  client: identifier, id: modelId, modelKinds: { ...array({ enum: meta.MODEL_KINDS }, 8), minItems: 1 }, ...stamp,
  kind: { enum: meta.WORK_KINDS },
  paid: { enum: [true, false, 'unknown'] },
  probeState: { const: 'unknown' },
  status: { enum: ['MODEL_KIND_UNKNOWN', 'NETWORK_DISABLED', 'METADATA_EXPIRED', 'KEY_MISSING', 'AVAILABLE', 'BILLING_UNKNOWN', 'AUTH_UNKNOWN'] } });
const v2Schema = freeze({ ...structuredClone(v1Schema), title: 'Access inventory v2',
  required: [...v1Schema.required, 'models', 'userProviders', 'connectorMcp'],
  properties: { ...v1Schema.properties, schema: { const: 'access-inventory/2' },
    models: array(modelSchema, INVENTORY_MAX_MODELS),
    userProviders: array(object({ client: identifier, name: identifier, keyPresent: { type: 'boolean' }, ...stamp }), 128),
    connectorMcp: array(object({ client: identifier, connectorId: identifier,
      serverCount: { type: ['integer', 'null'], minimum: 0, maximum: 64 },
      toolCount: { type: ['integer', 'null'], minimum: 0, maximum: 65536 },
      health: { const: 'unknown' }, ...stamp }), 128) },
  $defs: { ...v1Schema.$defs, route: { ...v1Schema.$defs.route,
    properties: { ...v1Schema.$defs.route.properties, kind: { enum: meta.WORK_KINDS } } } }
});
function readV1(bytes) {
  const value = readPublicJson(bytes, INVENTORY_MAX_BYTES);
  validate(v1Schema, value);
  return freeze(value);
}
function readInventory(bytes) {
  const value = readPublicJson(bytes, INVENTORY_MAX_BYTES);
  if (value?.schema === 'access-inventory/1') return readV1(bytes);
  if (Array.isArray(value?.models) && value.models.length > INVENTORY_MAX_MODELS) throw Error('INVENTORY_MODEL_LIMIT_EXCEEDED');
  validate(v2Schema, value);
  publicBoundary(value);
  meta.unique(value.models, m => `${m.client.toLowerCase()}\0${m.providerRef?.toLowerCase()}\0${m.id}`);
  meta.unique(value.userProviders, p => `${p.client.toLowerCase()}\0${p.name.toLowerCase()}`);
  meta.unique(value.connectorMcp, m => `${m.client.toLowerCase()}\0${m.connectorId.toLowerCase()}`);
  for (const row of [...value.models, ...value.userProviders, ...value.connectorMcp]) {
    meta.safeIdentifier(row.client);
    if (!(Date.parse(row.expiresAt) > Date.parse(row.at)) || Date.parse(row.expiresAt) - Date.parse(row.at) > 86400000) fail();
    if (row.client === 'cline' && row.provenance !== 'declared') fail();
  }
  for (const p of value.userProviders) meta.safeIdentifier(p.name);
  for (const c of value.connectorMcp) {
    meta.safeIdentifier(c.connectorId);
    if (c.serverCount === 0 && c.toolCount !== null && c.toolCount !== 0) fail();
  }
  for (const m of value.models) {
    meta.safeIdentifier(m.id);
    if (m.providerRef !== null) {
      meta.safeIdentifier(m.providerRef);
      if (!value.userProviders.some(p => p.client === m.client && p.name === m.providerRef)) fail();
    }
    if (m.modelKinds.includes('unknown') && (m.modelKinds.length !== 1 || m.kind === 'unknown' && m.status !== 'MODEL_KIND_UNKNOWN')) fail();
    if (m.providerRef === null && !m.modelKinds.includes('unknown')) fail();
    // A stored status is an explanation, not authority. Re-evaluate when used.
  }
  return freeze(value);
}
function toV1(bytes) {
  const value = readInventory(bytes);
  if (value.schema === 'access-inventory/1') return value;
  const { models, userProviders, connectorMcp, ...base } = value;
  base.schema = 'access-inventory/1';
  base.routes = base.routes.map(({ kind, ...route }) => route);
  return readV1(Buffer.from(JSON.stringify(base)));
}
function modelStatus(model, provider, network, now) {
  if (model.modelKinds.includes('unknown') && (!model.kind || model.kind === 'unknown')) return 'MODEL_KIND_UNKNOWN';
  if (!network) return 'NETWORK_DISABLED';
  if (!meta.windowValid(model, now) || !provider || !meta.windowValid(provider, now)) return 'METADATA_EXPIRED';
  if (!provider?.keyPresent) return 'KEY_MISSING';
  if (model.paid === true) return 'AVAILABLE';
  if (model.paid === 'unknown') return 'BILLING_UNKNOWN';
  return 'AUTH_UNKNOWN'; // Metadata never proves a working call or authorises activation.
}
function publicBoundary(value) {
  // Defence in depth on inherited v1 text: preserve ordinary public URLs, never
  // URL credentials, credential-shaped strings or free-form bearer assignments.
  const text = JSON.stringify(value);
  if (secretIn(text) || /https?:\/\/[^\s"/]+@/i.test(text)) fail();
}
function buildV2(v1Bytes, metadataBytes = [], now = Date.now()) {
  const base = readV1(v1Bytes), exports = metadataBytes.map(meta.readMetadata);
  publicBoundary(base);
  meta.unique(exports, x => x.client);
  const value = { ...structuredClone(base), schema: 'access-inventory/2', models: [], userProviders: [], connectorMcp: [] };
  for (const data of exports) {
    const common = { client: data.client, provenance: data.provenance, at: data.at, expiresAt: data.expiresAt };
    value.userProviders.push(...data.userProviders.map(p => ({ ...p, ...common })));
    value.connectorMcp.push(...data.connectorMcp.map(c => ({ ...c, ...common, health: 'unknown' })));
    for (const m of data.models) {
      const row = { providerRef: m.providerRef, client: data.client, id: m.id, modelKinds: meta.modelKinds(m),
        kind: meta.workKind(m),
        ...common, paid: m.paid, probeState: 'unknown' };
      row.status = modelStatus(row, value.userProviders.find(p => p.client === data.client && p.name === m.providerRef), base.network, now);
      value.models.push(row);
    }
  }
  // Existing v1 names carry no modality proof. Never infer a kind from a name,
  // subscription, input vision, successful login or a provider catalogue listing.
  const expiry = new Date(Date.parse(base.at) + 86400000).toISOString();
  for (const c of base.clients) for (const id of c.models) {
    if (!value.models.some(m => m.client === c.id && m.id === id)) value.models.push({ providerRef: null,
      client: c.id, id, kind: 'unknown', modelKinds: ['unknown'], provenance: 'declared', at: base.at, expiresAt: expiry,
      paid: 'unknown', probeState: 'unknown', status: 'MODEL_KIND_UNKNOWN' });
  }
  return readInventory(Buffer.from(JSON.stringify(value)));
}
// Stdin is an explicit public export, NOT a client config file. No file discovery,
// key-store access, settings reads, network requests, cache writes or model calls.
// Every stdin document, the --v2 bundle included, has the bound the inventory reader checks.
async function main(args, input, out = process.stdout, err = process.stderr) {
  try {
    if (args.length !== 1 || !['--v1', '--v2', '--read'].includes(args[0])) fail();
    const bytes = input || await new Promise((resolve, reject) => {
      const chunks = []; let length = 0, refused = false;
      process.stdin.on('data', b => {
        if (refused) return;
        length += b.length;
        if (length > INVENTORY_MAX_BYTES) {
          refused = true; chunks.length = 0; process.stdin.pause(); reject(new Error('SIZE'));
        } else chunks.push(b);
      });
      process.stdin.on('end', () => resolve(Buffer.concat(chunks))); process.stdin.on('error', reject);
    });
    let value;
    if (args[0] === '--v2') {
      const bundle = readPublicJson(bytes, INVENTORY_MAX_BYTES);
      if (!bundle || Object.keys(bundle).sort().join(',') !== 'inventory,metadata' || !Array.isArray(bundle.metadata)) fail();
      value = buildV2(Buffer.from(JSON.stringify(bundle.inventory)), bundle.metadata.map(x => Buffer.from(JSON.stringify(x))));
    } else value = args[0] === '--v1' ? toV1(bytes) : readInventory(bytes);
    out.write(JSON.stringify(value, null, 2) + '\n'); return 0;
  } catch { err.write('ACCESS_PUBLIC_DATA_INVALID\n'); return 1; }
}
// Declared package counts only, not a measured MCP tool listing, health or activation.
// R1a's validated reader remains the sole manifest reader.
function connectorCounts(manifestBytes, readManifest) {
  if (typeof readManifest !== 'function') fail();
  const { manifest } = readManifest(manifestBytes);
  const servers = manifest.contents.mcpServers;
  return freeze({ connectorId: manifest.id, serverCount: servers.length,
    toolCount: servers.reduce((sum, s) => sum + s.toolCount, 0) });
}
module.exports = { INVENTORY_MAX_BYTES, INVENTORY_MAX_MODELS, v2Schema, readV1, readInventory, toV1, modelStatus, buildV2, connectorCounts, main };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });

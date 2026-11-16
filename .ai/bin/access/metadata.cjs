'use strict';
const { readPublicJson, validate, freeze, fail } = require('./public-json.cjs');
const MODEL_KINDS = Object.freeze(['text', 'image-generation', 'image-edit', 'video-generation', 'video-edit', 'audio', 'embedding', 'unknown']);
const WORK_KINDS = Object.freeze(['text', 'image', 'video', 'speech', 'vision', 'embedding', 'unknown']);
const identifier = { type: 'string', minLength: 1, maxLength: 80, pattern: '^[A-Za-z0-9][A-Za-z0-9._-]*$' };
const modelId = { type: 'string', minLength: 1, maxLength: 160, pattern: '^[A-Za-z0-9][A-Za-z0-9._:/-]*$' };
const time = { type: 'string', format: 'date-time', maxLength: 30,
  pattern: '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d{3})?Z$' };
const object = properties => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });
const array = (items, maxItems = 256) => ({ type: 'array', items, maxItems, uniqueItems: true });
const modality = array({ enum: ['text', 'image', 'video', 'audio', 'embedding', 'unknown'] }, 6);
const metadataSchema = object({ schema: { const: 'access-metadata/1' }, client: { enum: ['kilo', 'cline'] },
  provenance: { enum: ['observed', 'declared'] }, at: time, expiresAt: time,
  models: array(object({ providerRef: identifier, id: modelId, inputModalities: modality, outputModalities: modality,
    operations: array({ enum: ['generate', 'edit', 'unknown'] }, 3),
    paid: { enum: [true, false, 'unknown'] } })),
  userProviders: array(object({ name: identifier, keyPresent: { type: 'boolean' } }), 64),
  connectorMcp: array(object({ connectorId: identifier, serverCount: { type: ['integer', 'null'], minimum: 0, maximum: 64 },
    toolCount: { type: ['integer', 'null'], minimum: 0, maximum: 65536 } }), 64)
});
// No URL field, endpoint client, fetch, key-store read or settings reader exists.
// Only public metadata supplied explicitly by the owner crosses this boundary.
function safeIdentifier(s) {
  if (typeof s !== 'string' || /sk-|eyJ|token|secret|password|credential|https?:|\/\/|@/i.test(s) ||
    /^[A-Za-z]:/.test(s) || /(?:^|\/)\.\.?(?:\/|$)/.test(s) || /[A-Za-z0-9_-]{40}/.test(s)) fail();
  return s;
}
function unique(items, key) { if (new Set(items.map(key)).size !== items.length) fail(); }
function windowValid(row, now) {
  const at = Date.parse(row.at), expiry = Date.parse(row.expiresAt);
  return Number.isFinite(now) && Number.isFinite(at) && Number.isFinite(expiry) &&
    at <= now && expiry > now && expiry > at && expiry - at <= 86400000;
}
function modelKinds(model) {
  const kinds = [], output = model.outputModalities, input = model.inputModalities, ops = model.operations;
  if (output.includes('text')) kinds.push('text');
  for (const medium of ['image', 'video']) {
    if (output.includes(medium) && ops.includes('generate')) kinds.push(`${medium}-generation`);
    if (output.includes(medium) && input.includes(medium) && ops.includes('edit')) kinds.push(`${medium}-edit`);
  }
  if (output.includes('audio')) kinds.push('audio');
  if (output.includes('embedding')) kinds.push('embedding');
  return kinds.length ? kinds : ['unknown'];
}
function workKind(model) {
  const output = model.outputModalities;
  for (const k of ['image', 'video', 'embedding']) if (output.includes(k)) return k;
  if (output.includes('audio')) return 'speech';
  if (output.includes('text') && model.inputModalities.includes('audio') && !model.inputModalities.includes('text')) return 'speech';
  if (output.includes('text')) return model.inputModalities.includes('image') || model.inputModalities.includes('video') ? 'vision' : 'text';
  return 'unknown';
}
function readMetadata(bytes) {
  const data = readPublicJson(bytes);
  validate(metadataSchema, data);
  // Cline has no qualified measured-export adapter in R3. Owner declaration only.
  if (data.client === 'cline' && data.provenance !== 'declared') fail();
  if (!(Date.parse(data.expiresAt) > Date.parse(data.at)) || Date.parse(data.expiresAt) - Date.parse(data.at) > 86400000) fail();
  unique(data.userProviders, p => p.name.toLowerCase());
  unique(data.models, m => `${m.providerRef.toLowerCase()}\0${m.id}`);
  unique(data.connectorMcp, m => m.connectorId.toLowerCase());
  for (const p of data.userProviders) safeIdentifier(p.name);
  for (const m of data.models) {
    safeIdentifier(m.providerRef); safeIdentifier(m.id);
    if (!data.userProviders.some(p => p.name === m.providerRef)) fail();
  }
  for (const m of data.connectorMcp) {
    safeIdentifier(m.connectorId);
    if (m.serverCount === 0 && m.toolCount !== null && m.toolCount !== 0) fail();
  }
  return freeze(data);
}
module.exports = { MODEL_KINDS, WORK_KINDS, workKind, metadataSchema: freeze(metadataSchema), identifier: freeze(identifier),
  modelId: freeze(modelId), time: freeze(time), object, array, safeIdentifier, unique, windowValid, modelKinds, readMetadata };

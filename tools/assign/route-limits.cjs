'use strict';
// Pure data validation shared by the guarded catalog reader and bank builder.
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(v);
const cap = v => Number.isSafeInteger(v) && v >= 0 && v <= 10000;
function validateLimits(doc) {
  const bad = () => { throw Object.assign(new Error('route-limits-invalid'), { selectionReason: 'route-limits-invalid' }); };
  if (!object(doc) || doc.schema !== 'assign-route-limits/1' || typeof doc.reason !== 'string' || !doc.reason.trim()
      || !object(doc.clients) || !object(doc.routes) || Object.keys(doc).length !== 4) bad();
  for (const [name, row] of Object.entries(doc.clients)) {
    if (!id(name) || !object(row) || !cap(row.cap) || typeof row.withdrawn !== 'boolean' || Object.keys(row).length !== 2) bad();
  }
  for (const [name, row] of Object.entries(doc.routes)) {
    if (!id(name) || !object(row) || !Object.hasOwn(doc.clients, row.client) || !id(row.provider) || !cap(row.cap) || Object.keys(row).length !== 3) bad();
  }
  return doc;
}
function routeLimit(doc, route) {
  const client = doc?.clients[route.client];
  const special = Object.entries(doc?.routes || {}).find(([name, row]) => row.client === route.client
    && (name === route.bankRoute || row.provider === route.provider || route.model.startsWith(row.provider + '/')))?.[1];
  const capExcludedProviders = special ? [] : Object.values(doc?.routes || {}).filter(r => r.client === route.client).map(r => r.provider);
  return { cap: client?.cap === 0 ? 0 : special?.cap ?? client?.cap ?? null, capProvider: special?.provider ?? null, capExcludedProviders, withdrawn: client?.withdrawn === true };
}
function seatInPool(seat, route) {
  return seat.client === route.client && (route.capProvider ? seat.model.startsWith(route.capProvider + '/')
    : !(route.capExcludedProviders || []).some(p => seat.model.startsWith(p + '/')));
}
function providerExcluded(doc, route) {
  return (doc?.rules || []).some(rule => rule.enabled && rule.kind === 'exclude-provider'
    && rule.providers.some(p => p === route.provider || route.model?.startsWith(p + '/') || route.modelId?.startsWith(p + '/')));
}
module.exports = { validateLimits, routeLimit, seatInPool, providerExcluded };

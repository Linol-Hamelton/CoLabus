'use strict';
// Pure data validation shared by the guarded catalog reader and bank builder.
//
// The seat caps are NOT in this file. They live in the seat policy
// (docs/ops/seat-policy.json of the main checkout, read through
// .ai/bin/lib/seat-policy.cjs), which is the only operational source of a cap.
// What stays here is the withdrawal of a client and the mapping of a sub-route
// to its client and provider.
//
// The nested pools: a seat on a sub-route takes one unit of the CLIENT pool and
// one unit of the ROUTE pool. The client cap and the route cap are therefore
// two numbers, not one: the tighter of the two would free a place the other
// pool still holds.
const { inPool } = require('../../.ai/bin/lib/seat-policy.cjs');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const id = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,159}$/.test(v);
function validateLimits(doc) {
  const bad = () => { throw Object.assign(new Error('route-limits-invalid'), { selectionReason: 'route-limits-invalid' }); };
  if (!object(doc) || doc.schema !== 'assign-route-limits/1' || typeof doc.reason !== 'string' || !doc.reason.trim()
      || !object(doc.clients) || !object(doc.routes) || Object.keys(doc).length !== 4) bad();
  for (const [name, row] of Object.entries(doc.clients)) {
    if (!id(name) || !object(row) || typeof row.withdrawn !== 'boolean' || Object.keys(row).length !== 1) bad();
  }
  for (const [name, row] of Object.entries(doc.routes)) {
    if (!id(name) || !object(row) || !Object.hasOwn(doc.clients, row.client) || !id(row.provider) || Object.keys(row).length !== 2) bad();
  }
  return doc;
}
// The client cap of the policy: the row of the client, else the default client cap, else null
// (no cap in the policy).
function policyClientCap(policy, client) {
  if (!policy || !client) return null;
  const row = policy.clients && policy.clients[client];
  if (row) return row.cap;
  return policy.defaultClient ? policy.defaultClient.cap : null;
}
// The route cap of the policy: the row of the route, when it names this client.
function policyRouteCap(policy, routeId, client) {
  if (!policy || !routeId) return null;
  const row = policy.routes && policy.routes[routeId];
  if (!row || row.client !== client) return null;
  return row.cap;
}
// The limits of one route: the withdrawal, the provider of the sub-route and the two caps of
// the policy. -> { clientCap, routeCap, capProvider, capExcludedProviders, withdrawn }
// A provider names a route, a seat or an owner rule by the one pool rule of the seat policy (inPool): every
// spelling of one model, in any case, is in the pool of its provider.
function routeLimit(doc, route, policy) {
  const client = doc?.clients[route.client];
  const entries = Object.entries(doc?.routes || {});
  const specialEntry = entries.find(([name, row]) => row.client === route.client
    && (name === route.bankRoute || inPool(row.provider, route.provider) || inPool(row.provider, route.model)));
  const special = specialEntry ? specialEntry[1] : null;
  const capExcludedProviders = special ? [] : entries.filter(([, r]) => r.client === route.client).map(([, r]) => r.provider);
  const clientCap = policyClientCap(policy, route.client);
  const routeCap = policyRouteCap(policy, specialEntry ? specialEntry[0] : null, route.client);
  return { clientCap, routeCap, capProvider: special ? special.provider : null, capExcludedProviders,
    withdrawn: Boolean(doc && (!client || client.withdrawn)) };
}
function seatInPool(seat, route) {
  return seat.client === route.client && (route.capProvider ? inPool(route.capProvider, seat.model)
    : !(route.capExcludedProviders || []).some(p => inPool(p, seat.model)));
}
function providerRuleMatches(rule, route) {
  return rule.enabled && (!rule.clients || rule.clients.includes(route.client))
    && (!rule.billings || rule.billings.includes(route.billing))
    && rule.providers.some(p => [route.provider, route.model, route.modelId].some(value => inPool(p, value)));
}
function providerExcluded(doc, route) {
  return (doc?.rules || []).some(rule => rule.kind === 'exclude-provider' && providerRuleMatches(rule, route));
}
function routePriority(doc, route) {
  return Number((doc?.rules || []).some(rule => rule.kind === 'prefer-last-provider' && providerRuleMatches(rule, route)));
}
module.exports = { validateLimits, routeLimit, policyClientCap, policyRouteCap, seatInPool, providerExcluded, routePriority };

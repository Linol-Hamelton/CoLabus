'use strict';
// One closed independence grammar shared by catalog selection and its ladder
// fallback. Unknown input cannot erase exclusions when the source changes.
const ID = /^[a-zA-Z0-9][a-zA-Z0-9._:/+~-]{0,159}$/;
const ident = v => typeof v === 'string' && ID.test(v);
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const LISTS = ['excludeModels', 'excludeProviders', 'excludeClients', 'excludeTransports', 'excludeFamilies'];
const LINEAGE = ['author', 'fixer', 'operator', 'lineage'];
const FIELDS = ['model', 'client', 'transport', 'family', 'provider'];
function refuse() { throw Object.assign(new Error('independence-malformed'), { code: 'INDEPENDENCE_MALFORMED', selectionReason: 'independence-malformed' }); }
function independenceOf(value) {
  if (value === undefined) value = {};
  if (!object(value) || Object.keys(value).some(k => ![...LISTS, ...LINEAGE].includes(k))) refuse();
  const out = { lineage: [] };
  for (const key of LISTS) {
    const list = value[key] === undefined ? [] : value[key];
    if (!Array.isArray(list) || !list.every(ident)) refuse();
    out[key] = list.slice();
  }
  for (const key of LINEAGE) {
    const entries = value[key] === undefined ? [] : Array.isArray(value[key]) ? value[key] : [value[key]];
    for (let entry of entries) {
      if (typeof entry === 'string') { if (!ident(entry)) refuse(); entry = { model: entry }; }
      if (!object(entry) || !Object.keys(entry).length || Object.keys(entry).some(k => !FIELDS.includes(k) || !ident(entry[k]))) refuse();
      out.lineage.push({ ...entry });
    }
  }
  return out;
}
function excludesRoute(ind, route) {
  const models = [route.model, route.modelId].filter(Boolean);
  return ind.excludeModels.some(v => models.includes(v)) || ind.excludeProviders.includes(route.maker)
    || ind.excludeClients.includes(route.client) || ind.excludeTransports.includes(route.transport)
    || ind.excludeFamilies.includes(route.family)
    || ind.lineage.some(v => (v.model !== undefined && models.includes(v.model))
      || (v.client !== undefined && v.client === route.client) || (v.transport !== undefined && v.transport === route.transport)
      || (v.family !== undefined && v.family === route.family) || (v.provider !== undefined && v.provider === route.maker));
}
module.exports = { independenceOf, excludesRoute };

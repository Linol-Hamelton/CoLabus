'use strict';
// Shared stop-event validation without the controller ledger's reporting graph.
const reader = require('./reader.cjs');
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
function event(value) {
  if (!object(value) || typeof value.type !== 'string' || !value.type ||
    (value.id !== undefined && typeof value.id !== 'string') ||
    (value.item !== undefined && (!object(value.item) || (value.item.id !== undefined && typeof value.item.id !== 'string') ||
      (value.item.type !== undefined && typeof value.item.type !== 'string')))) reader.refuse('stop-log-invalid');
  return value;
}
module.exports = { event };

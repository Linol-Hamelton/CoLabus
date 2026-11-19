'use strict';
// Shared contract for route-state and AUTO-ASSIGN-LIVE. The expiry is exclusive.
// Read the canonical advice window shared with AUTO-ASSIGN-LIVE.
const LIVE_TTL_MS = require('../assign/policy.json').adviceRouteMaxAgeMs;
const SCARCE_CLIENTS = Object.freeze(['claude', 'codex']);
function isFreshEvidence(evidence, now) {
  const time = typeof now === 'number' ? now : Date.parse(now);
  const at = Date.parse(evidence?.at);
  const expires = Date.parse(evidence?.expiresAt);
  return Number.isFinite(time) && Number.isFinite(at) && Number.isFinite(expires)
    && at <= time && time < Math.min(expires, at + LIVE_TTL_MS);
}
module.exports = { LIVE_TTL_MS, SCARCE_CLIENTS, isFreshEvidence };

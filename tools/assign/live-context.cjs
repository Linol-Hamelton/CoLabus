'use strict';
// Host-only, read-only projection of the same counter and policy as the gate.
const path = require('node:path');
const slots = require('../../.ai/bin/lib/seat-slots.cjs');
const policy = require('../../.ai/bin/lib/seat-policy.cjs');
function snapshot(repo, options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const env = options.env || process.env;
  const domain = slots.domainRoots({ repo });
  if (!domain.closed.length) throw Error('live-seat-root-unavailable');
  const main = path.resolve(domain.closed[0], '../..');
  const file = policy.canonicalFile(main);
  const got = policy.resolvePolicy({ canonical: file, now, injected: env[policy.ENV] });
  if (!got.ok || !got.configured) throw Error('live-seat-policy-unavailable');
  const seats = slots.runningSeats({ repo, now, policy: got.policy,
    ...(options.runtimeDir ? { runtimeDir: path.resolve(options.runtimeDir) } : {}),
    inject: slots.injectedRoots(env) });
  if (seats.some(s => !s.client || !s.model)) throw Error('live-seat-identity-unknown');
  const effective = JSON.parse(JSON.stringify(got.policy));
  for (const row of [effective.defaultClient, ...Object.values(effective.clients), ...Object.values(effective.routes)].filter(Boolean)) row.cap = policy.entryCap(row, now).cap;
  return { activeSeats: seats.map(s => ({ client: s.client, model: s.model })), totalCap: got.policy.total,
    policy: effective };
}
module.exports = { snapshot };

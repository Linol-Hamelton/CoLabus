'use strict';
// Tracked opt-in hook, no side effect at all while disabled. This never starts a model.
const Q = require('./quota-preflight.cjs');
function beforeLaunch(o, deps = {}) {
  if (o['quota-request'] === undefined) return null;
  if (!o.route || !o.client || !o.model) return { status: 'ask-owner', reason: 'explicit-route-required' };
  return (deps.quotaCheckFile || Q.checkFile)(o['quota-request'], { assertPath: deps.assertPath,
    expectedRoute: { routeId: o.route, client: o.client, model: o.model } });
}
// A proposed mandatory coverage interface. The contract must come from the
// trusted host's reviewed path inventory, never a child's claim of free spend.
// It is deliberately not wired to run(): Class A + the mode act precede that.
function coverageAudit(o, contract) {
  const result = (status, reason) => ({ mode: 'advisory', gateEnabled: false, status, reason });
  const keys = ['schema', 'spend', 'route', 'settlement'];
  if (!contract || Object.keys(contract).length !== keys.length || !keys.every(k => Object.hasOwn(contract, k))
      || contract.schema !== 'quota-coverage/1' || contract.spend !== 'paid' || contract.settlement !== 'required') {
    return result('blocked', 'coverage-contract-unverified');
  }
  const identity = Q.routeIdentity(contract.route);
  if (!identity || !o || o.route !== identity.routeId || o.client !== contract.route.client || o.model !== contract.route.model) return result('blocked', 'coverage-route-disagreement');
  if (typeof o['quota-request'] !== 'string' || !o['quota-request'].trim()) return result('blocked', 'paid-request-required');
  return result('ready', 'request-bound-settlement-required');
}
function settlementAudit(reservationId, completion) {
  const retain = { mode: 'advisory', status: 'retain-reservation', reason: 'billed-cost-unverified', actual: null };
  const keys = ['reservationId', 'usd', 'basis'];
  if (typeof reservationId !== 'string' || !/^[a-f0-9]{64}$/.test(reservationId) || !completion
      || Object.keys(completion).length !== keys.length || !keys.every(k => Object.hasOwn(completion, k))
      || completion.reservationId !== reservationId || completion.basis !== 'billed' || !Q.money(completion.usd)) return retain;
  return { mode: 'advisory', status: 'ready', reason: 'billed-cost-bound', actual: completion.usd };
}
module.exports = { beforeLaunch, coverageAudit, settlementAudit };

'use strict';
// kimi-served.cjs - the served-model proof and the usage fields of a Kimi Code launch (PROTO-DEC-0211, refining PROTO-DEC-0209 item 1).
// Pure: reads nothing, writes nothing, never throws on bad input. It does not open any file of the client.
//   derive(input, env, none) -> the result of served-model.cjs deriveServedModel for client kimi
//   usageFields()            -> the launch-record fields { tokens, cost } of a kimi launch
// The served model of a kimi launch is the explicit model argument the launcher passed to the client (-m kimi-code/<model>), source launcher-model. It counts only
// when the route is fixed by construction: the launcher generated a private config that holds exactly the subscription provider and that one model row, started the
// client on it (kimi-route.cjs prepare and childEnv) and hands the resulting route object (input.kimiRoute, how generated-config) to the derivation. A caller without such
// a route, with an alias outside the closed grammar or with a model that is not the one the private config carries gets no proof (unknown with a reason), never a guess.
// The user's own config and the client's session logs, wire files, state file and printed session hint are NOT read for the route, the model or the tokens (they have no
// closed boundary: PROTO-DEC-0209, PROTO-DEC-0211).
const { SUBSCRIPTION_ALIAS, SUBSCRIPTION_HOST, NOT_STARTED, NO_EXIT_STATUS, CLIENT_FAILED } = require('./kimi-route.cjs');

const NOT_COUNTED = 'not counted for this client';
// the reason of an unknown served model when the private config is not the file the launcher wrote (PROTO-DEC-0217 item 2)
const CHANGED = 'private config changed';
// the reason of an unknown served model when the client was not started, gave no numeric exit status or ended with a non-zero one: the fixed reasons of kimi-route.cjs, nothing else
const RAN_REASONS = [NOT_STARTED, NO_EXIT_STATUS, CLIENT_FAILED];
const proofReason = check => (check && RAN_REASONS.includes(check.reason) ? check.reason : CHANGED);

function derive(input, env, none) {
  const requested = input && input.requestedModel;
  const route = input && input.kimiRoute;
  if (!input || input.requestedModelVia !== 'flag') return none(`no launcher-model evidence for kimi (the model did not reach the client by flag; requestedModelVia ${(input && input.requestedModelVia) || 'unstated'})`, 'no route proof');
  if (typeof requested !== 'string' || !SUBSCRIPTION_ALIAS.test(requested)) return none('the requested model is not a subscription alias of the closed grammar kimi-code/<model>', 'no route proof');
  if (!route || typeof route !== 'object' || route.ok !== true || route.how !== 'generated-config' || route.alias !== requested || route.host !== SUBSCRIPTION_HOST) return none('the launcher did not prepare a private subscription config for this model', 'no route proof');
  // the config check made right after the exit: only an intact private config proves the route; a changed, missing or unchecked one never does
  const after = input.kimiConfigCheck;
  if (!after || typeof after !== 'object') return none('the private config was not checked after the exit', 'no route proof');
  if (after.ok !== true) {
    const why = proofReason(after);
    return none(why === CHANGED ? 'the private config is not the file the launcher wrote (hash or file identity differs): the route of the client is not proven' : 'the client was not started, gave no numeric exit status or ended with a non-zero one: nothing is proven about the launch', why);
  }
  return { servedModel: requested, source: 'launcher-model', confidence: 'derived', match: true, detail: `the explicit model the launcher passed (-m ${requested}) over the private subscription config the launcher generated for it` };
}

// Tokens are not counted for this client. The cost basis is subscription: the launch started only after the route check admitted the subscription route (a refused route
// never reaches the record). The reason is stated in the cost object, so the unknown tokens say why.
// Whether the private config was intact after the exit decides the basis: a changed config means the route is unproven, so the basis is unknown, not subscription.
function usageFields(intact = true, why = CHANGED) {
  return {
    tokens: null,
    cost: { usd: null, basis: intact ? 'subscription' : 'unknown', priceSnapshot: null, formula: null, note: intact ? 'flat-fee client: no per-launch charge; the spend reservation is booked in the route budget ledger, not here' : (why === CHANGED ? 'the private config changed during the launch: the route and its price basis are not proven' : 'the client was not started, gave no numeric exit status or ended with a non-zero one: the route and its price basis are not proven'), reason: NOT_COUNTED },
  };
}

module.exports = { derive, usageFields, proofReason, NOT_COUNTED, CHANGED };

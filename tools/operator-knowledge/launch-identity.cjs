'use strict';
// Identity belongs to the launch, never to answer text.
// The one first-party rule of the probe, the route record and the launch evidence: a client
// launches the model at its own maker. Vibe swaps backends by alias, so only a model its
// measured table knows is its own; any other model is a proxy route and needs a client proof.
const sm = require('../../docs/ops/served-model.cjs');
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/;
function firstParty(route) {
  const { client, model } = route || {};
  if (typeof model !== 'string' || !MODEL.test(model)) return false;
  if (client === 'codex') return /^gpt-/.test(model);
  if (client === 'claude') return /^claude-/.test(model);
  if (client === 'kimi') return /^(?:kimi-code\/)?k[0-9]/i.test(model);
  if (client === 'mimo') return /^xiaomi\/mimo-/.test(model);
  if (client === 'vibe') return /^(?:zai-)?glm-|^mistral-/.test(model) && sm.vibeAlias(model).known;
  return (client === 'opencode' || client === 'minimax') && /^minimax\//i.test(model);
}
// true / false / 'unknown': a vibe alias and its provider name are one model.
function servedMatch(route, served) {
  const alias = name => route.client === 'vibe' ? sm.vibeAlias(name).alias : name;
  return sm.modelsMatch(alias(route.model), alias(served));
}
function certificationProblem(route, value) {
  // A launcher echo (including Cline run_result.model) proves no proxy backend.
  if (!value || !value.served || !['client-banner', 'client-log'].includes(value.servedSource)) return firstParty(route) ? null : 'SERVED_UNPROVEN';
  // A proven served model that is not the requested one restricts certification, first party or not.
  if (servedMatch(route, value.served) === true) return null;
  return sm.familyMatch(route.model, value.served) === false ? 'SERVED_FAMILY_MISMATCH' : 'SERVED_MISMATCH';
}
module.exports = { firstParty, servedMatch, certificationProblem };

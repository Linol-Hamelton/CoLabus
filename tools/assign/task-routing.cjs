'use strict';
// Task routing by class: a task estimated over the bound of a turn-limited
// route never goes there, and a task of a content class a route's provider
// refuses never goes there either. The facts are host data (the route policy
// section taskRouting); an absent file or section means no such rule. An
// unknown estimate never proves that a task fits a turn-limited route.
const path = require('node:path');
const io = require('./io.cjs');
const identity = require('../../.ai/bin/lib/model-identity.cjs');

const FILE = 'docs/ops/routes/POLICY.json';
const ROLES = ['author', 'fixer', 'pre-reviewer', 'certifier', 'operator'];
// The assign roles in the role words of the route policy (as the owner rules read them).
const ROLE_OF = { implementer: 'author', reviewer: 'pre-reviewer', architect: 'operator', critic: 'pre-reviewer',
  researcher: 'author', drafter: 'author', synthesiser: 'author' };
const invalid = () => io.fail('task-routing-invalid');
const list = (v, ok) => Array.isArray(v) && v.length > 0 && v.length <= 50 && v.every(ok) && new Set(v).size === v.length;
const text = v => typeof v === 'string' && v.length > 0 && v.length <= 600;
const fields = (v, allowed, required) => { try { io.fields(v, allowed, required); } catch { invalid(); } };

function validate(section) {
  fields(section, ['rule', 'maxTaskMinutesOnTurnLimited', 'turnLimited', 'contentRefusal'], ['rule', 'maxTaskMinutesOnTurnLimited', 'turnLimited', 'contentRefusal']);
  if (!text(section.rule) || !Number.isSafeInteger(section.maxTaskMinutesOnTurnLimited)
      || section.maxTaskMinutesOnTurnLimited < 1 || section.maxTaskMinutesOnTurnLimited > 10080
      || !Array.isArray(section.turnLimited) || !Array.isArray(section.contentRefusal)) invalid();
  for (const r of section.turnLimited) {
    fields(r, ['client', 'families', 'reason', 'source'], ['client', 'reason', 'source']);
    if (!io.id(r.client) || r.families !== undefined && !list(r.families, io.id) || !text(r.reason) || !text(r.source)) invalid();
  }
  for (const r of section.contentRefusal) {
    fields(r, ['client', 'providers', 'families', 'dimensions', 'roles', 'reason', 'source'], ['client', 'families', 'dimensions', 'reason', 'source']);
    if (!io.id(r.client) || r.providers !== undefined && !list(r.providers, io.id) || !list(r.families, io.id)
        || !list(r.dimensions, io.id) || r.roles !== undefined && !list(r.roles, x => ROLES.includes(x))
        || !text(r.reason) || !text(r.source)) invalid();
  }
  return section;
}

// The route policy of a tree: null when the file or its taskRouting section is
// absent; a present but malformed section refuses (never a silent no-rule).
function load(root) {
  let guarded, doc;
  root = path.resolve(root);
  try { guarded = io.guard(root, FILE); } catch { invalid(); }
  if (!guarded.exists) return null;
  try { doc = io.readJson(root, FILE); } catch { invalid(); }
  if (!io.object(doc)) invalid();
  return Object.hasOwn(doc, 'taskRouting') ? validate(doc.taskRouting) : null;
}

const familiesOf = route => new Set([route.family, route.maker, route.modelId, route.model]
  .filter(v => typeof v === 'string').map(v => identity.canonicalFamily(v)).concat(
    [route.family, route.maker].filter(v => typeof v === 'string').map(v => identity.declaredFamily(v)))
  .filter(f => f && f !== 'UNKNOWN'));
const familyMatch = (want, route) => !want || want.some(f => familiesOf(route).has(identity.declaredFamily(f)));

// The refusal reasons of one route for one task: route-turn-limited when the
// estimate is unknown or over the bound, route-content-refusal for a refused class.
// An unknown provider never proves a route outside a rule that names providers.
function reasons(section, route, task = {}) {
  if (!section) return [];
  const out = [];
  const minutes = task.minutes, role = ROLE_OF[task.role] || task.role;
  const dims = Array.isArray(task.dimensions) ? task.dimensions : [];
  for (const r of section.turnLimited) {
    if (r.client !== route.client || !familyMatch(r.families, route)) continue;
    if (!Number.isFinite(minutes) || minutes < 0 || minutes > section.maxTaskMinutesOnTurnLimited) out.push('route-turn-limited');
  }
  for (const r of section.contentRefusal) {
    if (r.client !== route.client || r.providers && io.id(route.provider) && !r.providers.includes(route.provider)
        || !familyMatch(r.families, route)) continue;
    if (r.roles && !r.roles.includes(role)) continue;
    if (r.dimensions.some(d => dims.includes(d))) out.push('route-content-refusal');
  }
  return [...new Set(out)];
}

// A provider refusal answer: the provider's own opening statement refuses the
// task on content grounds. It is NO_VERDICT, never a pass, beside any verdict
// line. Only the first non-empty line is the provider's position, and only the
// provider's voice counts there (I refuse; your or this request was flagged; our
// policy): a report that describes a checked fixture, or quotes a refusal deeper
// in its body, is not one.
const REFUSAL = [
  /^(?:i['\u2019]m sorry|sorry)[,.]? (?:but )?i (?:can(?:no|['\u2019])t|won['\u2019]t|am unable to) /i,
  /^i (?:can(?:no|['\u2019])t|won['\u2019]t|am unable to) (?:help|assist|comply|provide|review|do|perform)\b/i,
  /^(?:your|this) (?:request|message|prompt|input|content|query|conversation) (?:was|has been|is|may be|might be) flagged (?:as|for) (?:potentially )?(?:harmful|violating|unsafe)/i,
  /^[^\n]{0,200}\bviolat\w* our (?:usage|content) polic/i,
];
function providerRefusal(input) {
  const text = typeof input === 'string' ? input : input instanceof Uint8Array ? Buffer.from(input).toString('utf8') : '';
  const opening = text.replace(/^\uFEFF/, '').trimStart().split('\n', 1)[0].slice(0, 400);
  return REFUSAL.some(r => r.test(opening));
}

module.exports = { FILE, load, validate, reasons, providerRefusal };

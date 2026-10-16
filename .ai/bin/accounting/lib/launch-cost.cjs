'use strict';
// launch-cost.cjs - the cost object of a launch record (PROTO-DEC-0144, 0145, 0169; 0173 item 3; ).
//   priceUsage({ client, model, servedModel, tokens, clientCostUsd, clientCostBasis, at }, { pricesDir, maxAgeHours })
//     -> { usd, basis: 'priced'|'subscription'|'unknown', priceSnapshot, formula, ... }
// Rules (, LAUNCH-RECORD-EXT.md):
//   unknown is NEVER zero: usd is null whenever a number cannot be stated, with the reason.
//   subscription = a flat-fee client (claude Pro, codex ChatGPT, agy Antigravity Pro, copilot): usd null, no per-launch charge; the
//     client's own list-price equivalent (claude total_cost_usd) is kept as listEquivalentUsd, never as a bill. The spend reservation
//     lives in the route budget ledger (docs/ops/ROUTE-BUDGETS.md), not in the record.
//   priced = tokens x the per-million price of the canonical model id in the price snapshot nearest to the launch (the newest one for a live
//     launch), the standard route of the route-price table with the lowest TOTAL for the launch's token mix (a route chosen by the blended price alone can lack a
//     cached price and over-charge the cache reads); a snapshot more than maxAgeHours (48, the
//     chooser's limit) away from the launch is refused and the cost is unknown. Exact decimal arithmetic (lib/decimal.cjs), no float price.
//   The cost never carries a key, an account id or a wallet: only the model, the route platform and the snapshot id.
// Advisory estimate at aggregator list prices: it is NOT the provider invoice (a direct provider price can differ).
const fs = require('node:fs');
const path = require('node:path');
const D = require('./decimal.cjs');
const I = require('./price-ids.cjs');
const S = require('./price-snapshot.cjs');
const T = require('./price-table.cjs');

const PRICES_DIR = path.resolve(__dirname, '..', '..', '..', '..', 'docs', 'product', 'launch-records', 'data', 'prices');
const STALE_HOURS = 48; // the route chooser's limit (lib/route-rank.cjs STALE_HOURS)
const SUBSCRIPTION_CLIENTS = new Set(['claude', 'codex', 'agy', 'copilot']);

// Names the clients use that carry no creator. Each row names its evidence; anything else stays unmatched (never a guess).
const MODEL_ALIASES = {
  'glm-5-3': { id: 'zai/glm-5.3', evidence: 'data/model-aliases.json "glm 5.3" -> zai-glm-5-3 (vibe); the vibe session store logs active_model glm-5-3' },
  'zai-glm-5-3': { id: 'zai/glm-5.3', evidence: 'data/model-aliases.json "glm 5.3" -> zai-glm-5-3 (vibe)' },
  'glm-5-2': { id: 'zai/glm-5.2', evidence: 'same spelling rule as glm-5-3 (vibe model glm-5-2)' },
  'mistral-large-2512': { id: 'mistral/mistral-large-2512', evidence: 'snapshot canonical id mistral/mistral-large-2512 (OpenRouter)' },
  'deepseek-flash': { id: 'deepseek/deepseek-v4.1-flash', evidence: 'data/model-aliases.json "deepseek v4.1 flash" -> deepseek-flash (provider positioning table)' },
  'mistral-medium-3.5': { id: 'mistral/mistral-medium-3.5', evidence: 'data/model-aliases.json "mistral medium 3.5" -> mistral-medium-3.5 (a vibe model name); snapshot canonical id mistral/mistral-medium-3.5' },
  'gpt-6.1-sol': { id: 'openai/gpt-6.1-sol', evidence: 'snapshot canonical id openai/gpt-6.1-sol' },
  'claude-sonnet-5-5': { id: 'anthropic/claude-sonnet-5.5', evidence: 'snapshot canonical id anthropic/claude-sonnet-5.5' },
  'gemini-3.8-flash-high': { id: 'google/gemini-3.8-flash', evidence: 'data/model-aliases.json "gemini 3.8 flash" (effort suffix -high split off)' },
};

// Guard (review finding): a cache count that is null is unknown, and an unknown component makes the cost unknown, UNLESS the priced formula is defined
// without it: the client's printed input count already contains that class (or the client has no such class), so the formula prices it inside `input`.
// Per token source, the classes that are inside input when they are null (each with its evidence; client-usage.cjs header):
//   vibe-session-store  cacheWrite             inputTokens includes every input token; the store has no cache-write count
//   agy-json            cacheWrite             input_tokens includes every input token; Gemini prints no cache-write count
//   agent-result        cacheRead, cacheWrite  tokens_in is the sum of the prompt tokens of every step, cached ones included (an upper bound)
// Every other null cache count (mimo, mimocode-db, codex-json, claude-json, or the classes not listed) gives unknown with the reason.
const INPUT_COVERS = { 'vibe-session-store': ['cacheWrite'], 'agy-json': ['cacheWrite'], 'agent-result': ['cacheRead', 'cacheWrite'] };

const cache = new Map();
function loadSnapshots(pricesDir) {
  const dir = path.resolve(pricesDir || PRICES_DIR);
  if (cache.has(dir)) return cache.get(dir);
  const out = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter(f => /^\d{4}-\d{2}-\d{2}.*\.json$/.test(f)).sort(); } catch { /* no snapshot directory */ }
  for (const name of names) {
    try { const snap = S.loadSnapshot(path.join(dir, name)); out.push({ file: name, snap, at: Date.parse(snap.capturedAt) }); } catch (e) { out.push({ file: name, error: e.message }); }
  }
  cache.set(dir, out);
  return out;
}

function canonicalOf(model) {
  const raw = String(model || '').trim();
  if (!raw) return { id: null, reason: 'no model' };
  const bare = raw.replace(/^openrouter\//i, '');
  const alias = MODEL_ALIASES[bare.toLowerCase()];
  if (alias) return { id: alias.id, via: `alias: ${alias.evidence}` };
  const c = I.canonicalize('input', bare);
  if (!c.canonicalId) return { id: null, reason: `model id "${raw}" has no canonical form (${c.reason})` };
  return { id: c.canonicalId, via: c.via };
}

const unknown = reason => ({ usd: null, basis: 'unknown', priceSnapshot: null, formula: null, reason });

function withClientReport(cost, o) {
  if (typeof o.clientCostUsd === 'number' && o.clientCostUsd >= 0) { cost.clientReportedUsd = o.clientCostUsd; cost.clientCostBasis = o.clientCostBasis || 'client'; }
  return cost;
}

function usageCost({ client, model, servedModel, tokens, clientCostUsd, clientCostBasis, at, now }, opts = {}) {
  const c = String(client || '').toLowerCase();
  const o = { clientCostUsd, clientCostBasis };
  if (SUBSCRIPTION_CLIENTS.has(c)) {
    const cost = { usd: null, basis: 'subscription', priceSnapshot: null, formula: null, note: 'flat-fee client: no per-launch charge; the spend reservation is booked in the route budget ledger, not here' };
    if (typeof clientCostUsd === 'number' && clientCostUsd >= 0) { cost.listEquivalentUsd = clientCostUsd; cost.clientCostBasis = clientCostBasis || 'list'; }
    return cost;
  }
  if (!tokens) return withClientReport(unknown('no token usage for this launch'), o);
  // Guard (review finding): a count that is negative, fractional or not finite is no count; a direct caller gets unknown, never a priced number
  const bad = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total'].filter(k => tokens[k] !== null && tokens[k] !== undefined && !(Number.isSafeInteger(tokens[k]) && tokens[k] >= 0));
  if (bad.length) return withClientReport(unknown(`token counts must be whole numbers >= 0 (${bad.join(', ')})`), o);
  if (!Number.isSafeInteger(tokens.input) || !Number.isSafeInteger(tokens.output)) return withClientReport(unknown('the client does not split input and output tokens'), o);
  const covers = INPUT_COVERS[tokens.source] || [];
  const unpriced = ['cacheRead', 'cacheWrite'].filter(k => (tokens[k] === null || tokens[k] === undefined) && !covers.includes(k));
  if (unpriced.length) return withClientReport(unknown(`${unpriced.join(' and ')} not printed by the client (${tokens.source || 'unknown source'}); the cost needs it`), o);
  const model0 = servedModel || model;
  const canon = canonicalOf(model0);
  if (!canon.id) return withClientReport(unknown(canon.reason), o);
  const books = loadSnapshots(opts.pricesDir).filter(b => b.snap);
  if (!books.length) return withClientReport(unknown('no readable price snapshot in data/prices'), o);
  // Guard (sibling hunt): a launch time that is given but unreadable (or null: the record has none) is unknown, never "now" (today's snapshot for an old
  // launch); only a caller that passes no time at all (a live launch pricing itself) means now
  if (at !== undefined && Number.isNaN(Date.parse(at === null ? '' : String(at)))) return withClientReport(unknown(`the launch time ${JSON.stringify(at)} is not readable, so no price snapshot can be chosen`), o);
  const ref = at !== undefined ? Date.parse(at) : (now ? now.getTime() : Date.now());
  const best = books.map(b => ({ b, d: Math.abs(ref - b.at) })).sort((x, y) => x.d - y.d)[0];
  const limit = (opts.maxAgeHours || STALE_HOURS) * 3600000;
  if (!(best.d <= limit)) return withClientReport(unknown(`price snapshot ${best.b.snap.id} (captured ${best.b.snap.capturedAt}) is ${Math.round(best.d / 3600000)} h from the launch; the limit is ${opts.maxAgeHours || STALE_HOURS} h`), o);
  const table = T.buildTable(best.b.snap, { model: canon.id });
  const entry = table.models[0];
  if (!entry) return withClientReport(unknown(`${canon.id} has no priced route in snapshot ${best.b.snap.id}`), o);
  const read = tokens.cacheRead === null || tokens.cacheRead === undefined ? 0 : tokens.cacheRead;
  const write = tokens.cacheWrite === null || tokens.cacheWrite === undefined ? 0 : tokens.cacheWrite;
  if (!Number.isSafeInteger(read) || !Number.isSafeInteger(write)) return withClientReport(unknown('cache token counts are not integers'), o);
  // The route is the standard (non-free) route with the LOWEST TOTAL for this token mix: a route chosen by the blended input/output price alone can lack a
  // cached price and would charge the cache reads (the bulk of an agent run) at the full input price. A route without a cached price is priced with
  // cache reads at its input price (an upper bound for that route).
  let pick = null;
  for (const route of entry.routes) {
    const pIn = D.parse(route.inputPerM); const pOut = D.parse(route.outputPerM);
    const pCache = route.cachedInputPerM !== null ? D.parse(route.cachedInputPerM) : pIn;
    if (!pIn || !pOut || !pCache) continue;
    let sum = D.mulInt(pIn, BigInt(tokens.input));
    sum = D.add(sum, D.mulInt(pCache, BigInt(read)));
    sum = D.add(sum, D.mulInt(pIn, BigInt(write)));
    sum = D.add(sum, D.mulInt(pOut, BigInt(tokens.output)));
    if (!pick || D.cmp(sum, pick.sum) < 0) pick = { route, sum };
  }
  if (!pick) return withClientReport(unknown(`${canon.id} has no paid standard route in snapshot ${best.b.snap.id}`), o);
  const route = pick.route;
  const usdText = D.toString(D.round(D.shift10(pick.sum, -6), 9));
  const notes = [];
  if (route.cachedInputPerM === null && read > 0) notes.push('cacheRead charged at the input price (the route lists no cached price)');
  for (const k of ['cacheRead', 'cacheWrite']) if (tokens[k] === null || tokens[k] === undefined) notes.push(`${k} not printed by the client: inside input for ${tokens.source} (counted 0 apart)${k === 'cacheRead' ? ', so cached tokens are charged at the input price (an upper bound)' : ''}`);
  const cost = {
    usd: Number(usdText), basis: 'priced',
    priceSnapshot: { id: best.b.snap.id, hash: best.b.snap.hash.slice(0, 12), capturedAt: best.b.snap.capturedAt },
    formula: `(${tokens.input}*${route.inputPerM} + ${read}*${route.cachedInputPerM !== null ? route.cachedInputPerM : route.inputPerM} + ${write}*${route.inputPerM} + ${tokens.output}*${route.outputPerM}) / 1e6 USD; ${canon.id} on ${route.platform}${route.provider ? `/${route.provider}` : ''}, the standard route with the lowest total for this token mix (${entry.routes.length} considered); estimate at list price, not the provider invoice${notes.length ? `; ${notes.join('; ')}` : ''}`,
    model: canon.id,
  };
  return withClientReport(cost, o);
}

module.exports = { usageCost, canonicalOf, loadSnapshots, MODEL_ALIASES, SUBSCRIPTION_CLIENTS, STALE_HOURS, PRICES_DIR, INPUT_COVERS };

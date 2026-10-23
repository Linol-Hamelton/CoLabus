'use strict';
// Canonical model ids for the route price tools (schema/canonical-id.md).
// One canonical id is "<creator>/<slug>": creator from CREATOR_ALIASES, slug lower case, a trailing -YYYYMMDD dropped,
// the variant (free, batch, fast) taken OUT of the id and kept as its own field. The same model on OpenRouter, Vercel AI Gateway
// and Hugging Face then joins on the id. A rule never guesses: an id that no rule covers, a moving alias, an unknown variant
// and two ids of ONE platform that collapse to the same canonical id all stay unmatched and are listed.

const CREATOR_ALIASES = {
  'z-ai': 'zai', zai: 'zai', 'zai-org': 'zai',
  mistral: 'mistral', mistralai: 'mistral',
  alibaba: 'qwen', qwen: 'qwen',
  'deepseek-ai': 'deepseek', deepseek: 'deepseek',
  'meta-llama': 'meta', meta: 'meta',
  xiaomimimo: 'xiaomi', xiaomi: 'xiaomi',
  moonshotai: 'moonshot', moonshot: 'moonshot',
  minimaxai: 'minimax', minimax: 'minimax',
  anthropic: 'anthropic', openai: 'openai', google: 'google', nvidia: 'nvidia', cohere: 'cohere', poolside: 'poolside',
};

// Explicit pairs where a platform spells the same model differently and no rule may decide it. Key: platform|creator/slug as the platform
// writes it, lower case, variant removed. Each row names its evidence.
const ID_ALIASES = {
  'openrouter|mistralai/mistral-medium-3-5': { canonical: 'mistral/mistral-medium-3.5', evidence: 'OpenRouter canonical_slug mistralai/mistral-medium-3.5-20260430 (capture 2026-10-09)' },
};

const VARIANT_COLON = { free: 'free', batch: 'batch' };

/**
 * @typedef {{canonicalId: string|null, variant: string, via: 'rule'|'table'|null, reason: string|null}} Canon
 * @param {string} platform openrouter | vercel | huggingface | groq | ...
 * @param {string} rawId id exactly as the platform writes it
 * @returns {Canon}
 */
function canonicalize(platform, rawId) {
  const none = (reason, variant) => ({ canonicalId: null, variant: variant || 'standard', via: null, reason });
  if (typeof rawId !== 'string' || !rawId.trim()) return none('empty-id');
  let id = rawId.trim();
  if (id.startsWith('~')) return none('moving-alias');
  const parts = id.split('/');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return none('no-creator-slug');
  const creatorRaw = parts[0].toLowerCase();
  let rest = parts[1].toLowerCase();
  let variant = 'standard';
  const colon = rest.indexOf(':');
  if (colon >= 0) {
    const tag = rest.slice(colon + 1);
    rest = rest.slice(0, colon);
    if (!Object.prototype.hasOwnProperty.call(VARIANT_COLON, tag)) return none(`unknown-variant:${tag}`, tag);
    variant = VARIANT_COLON[tag];
  }
  if (/-fast$/.test(rest)) { rest = rest.replace(/-fast$/, ''); variant = variant === 'standard' ? 'fast' : variant; }
  else if (/-free$/.test(rest)) { rest = rest.replace(/-free$/, ''); variant = variant === 'standard' ? 'free' : variant; }
  rest = rest.replace(/-20[2-3]\d[01]\d[0-3]\d$/, '');
  if (!rest) return none('empty-slug');
  const table = ID_ALIASES[`${platform}|${creatorRaw}/${rest}`];
  if (table) return { canonicalId: table.canonical, variant, via: 'table', reason: null };
  // a creator without an alias row keeps its own lower-case spelling: it joins only with an identical spelling, never by guess
  const creator = CREATOR_ALIASES[creatorRaw] || creatorRaw;
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(creator)) return none('odd-characters', variant);
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(rest)) return none('odd-characters', variant);
  return { canonicalId: `${creator}/${rest}`, variant, via: 'rule', reason: null };
}

/**
 * Canonicalize every platform model id of a record list in place and apply the ambiguity rule: two different platform ids of ONE
 * platform that give the same (canonicalId, variant) are both set to unmatched (reason ambiguous:<id>|<id>).
 * @param {Array<{platform: string, platformModelId: string}>} records
 * @returns {{matched: number, unmatched: Array<{platform: string, platformModelId: string, reason: string}>}}
 */
function assignCanonical(records) {
  const byKey = new Map();
  const perId = new Map();
  for (const r of records) {
    const k = `${r.platform}|${r.platformModelId}`;
    if (!perId.has(k)) perId.set(k, canonicalize(r.platform, r.platformModelId));
  }
  for (const [k, c] of perId) {
    if (!c.canonicalId) continue;
    const platform = k.slice(0, k.indexOf('|'));
    const key = `${platform}|${c.canonicalId}|${c.variant}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(k);
  }
  const ambiguous = new Map();
  for (const ids of byKey.values()) if (ids.length > 1) for (const k of ids) ambiguous.set(k, ids.map((x) => x.slice(x.indexOf('|') + 1)).sort().join('|'));
  const unmatched = [];
  const seen = new Set();
  let matched = 0;
  for (const r of records) {
    const c = perId.get(`${r.platform}|${r.platformModelId}`);
    let canonicalId = c.canonicalId;
    let reason = c.reason;
    const ak = `${r.platform}|${r.platformModelId}`;
    if (canonicalId && ambiguous.has(ak)) { canonicalId = null; reason = `ambiguous:${ambiguous.get(ak)}`; }
    r.canonicalId = canonicalId;
    r.canonicalVia = canonicalId ? c.via : null;
    r.variant = c.variant;
    if (canonicalId) matched++;
    else {
      const uk = `${r.platform}|${r.platformModelId}`;
      if (!seen.has(uk)) { seen.add(uk); unmatched.push({ platform: r.platform, platformModelId: r.platformModelId, reason }); }
    }
  }
  return { matched, unmatched };
}

/**
 * Canonical ids that differ only by punctuation or by the creator spelling and sit on DISJOINT platform sets: probably the same model, NOT merged
 * (a rule would be a guess). The list is advice for the owner: one ID_ALIASES row per confirmed pair joins them.
 * @param {Array<{canonicalId: string|null, platform: string, modelType: string|null, variant: string}>} records
 * @returns {Array<{key: string, ids: Array<{canonicalId: string, platforms: string[]}>}>}
 */
function nearMisses(records) {
  const platforms = new Map();
  for (const r of records) {
    if (!r.canonicalId || r.modelType !== 'language' || r.variant !== 'standard') continue;
    if (!platforms.has(r.canonicalId)) platforms.set(r.canonicalId, new Set());
    platforms.get(r.canonicalId).add(r.platform);
  }
  const groups = new Map();
  for (const id of platforms.keys()) {
    const key = id.replace(/^[^/]+\//, '').replace(/[^a-z0-9]/g, '');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(id);
  }
  const out = [];
  for (const [key, ids] of groups) {
    if (ids.length < 2) continue;
    const sets = ids.map((i) => platforms.get(i));
    const disjoint = sets.every((a, i) => sets.every((b, j) => i === j || [...a].every((p) => !b.has(p))));
    if (!disjoint) continue;
    out.push({ key, ids: ids.sort().map((canonicalId) => ({ canonicalId, platforms: [...platforms.get(canonicalId)].sort() })) });
  }
  return out.sort((a, b) => (a.key < b.key ? -1 : 1));
}

// Models of the owner's ladder (docs/ops/model-ladder.json) and of the candidate matrix (MODEL-MATRIX.md), each with the id the
// platform writes where the model exists on it (null: absent in the capture of 2026-10-09). clientModel: how a client names it
// (.ai/docs/clients.json). A test compares the rungs of the ladder file with this table, so a new rung without a row fails.
const LADDER_MODELS = [
  { canonicalId: 'anthropic/claude-opus-5.5', ladder: [{ client: 'claude', model: 'claude-opus-5-5' }], origin: 'ladder rungs 1-3', openrouter: 'anthropic/claude-opus-5.5', vercel: 'anthropic/claude-opus-5.5', huggingface: null },
  { canonicalId: 'openai/gpt-5.6-sol', ladder: [{ client: 'codex', model: 'gpt-5.6-sol' }], origin: 'ladder rung 4', openrouter: 'openai/gpt-5.6-sol', vercel: 'openai/gpt-5.6-sol', huggingface: null },
  { canonicalId: 'openai/gpt-5.6-terra', ladder: [{ client: 'codex', model: 'gpt-5.6-terra' }], origin: 'ladder rung 5', openrouter: 'openai/gpt-5.6-terra', vercel: 'openai/gpt-5.6-terra', huggingface: null },
  { canonicalId: 'openai/gpt-5.6-luna', ladder: [{ client: 'codex', model: 'gpt-5.6-luna' }], origin: 'ladder rung 6', openrouter: 'openai/gpt-5.6-luna', vercel: 'openai/gpt-5.6-luna', huggingface: null },
  { canonicalId: 'deepseek/deepseek-v4.1-flash', ladder: [{ client: 'kilo', model: null }], origin: 'ladder rung 5 (DeepSeek V4.1; model id null in the ladder, deepseek-flash = DeepSeek-V4.1-Flash per the client model contract)', openrouter: 'deepseek/deepseek-v4.1-flash', vercel: 'deepseek/deepseek-v4.1-flash', huggingface: 'deepseek-ai/DeepSeek-V4.1-Flash' },
  { canonicalId: 'google/gemini-3.8-flash', ladder: [{ client: 'agy', model: 'gemini-3.8-flash-high' }], origin: 'ladder rung 5', openrouter: 'google/gemini-3.8-flash', vercel: 'google/gemini-3.8-flash', huggingface: null },
  { canonicalId: 'google/gemini-3.7-flash', ladder: [{ client: 'agy', model: 'gemini-3.7-flash-high' }], origin: 'ladder rung 7', openrouter: 'google/gemini-3.7-flash', vercel: 'google/gemini-3.7-flash', huggingface: null },
  { canonicalId: 'google/gemini-3.6-flash', ladder: [{ client: 'agy', model: 'gemini-3.6-flash-high' }], origin: 'ladder rung 8', openrouter: 'google/gemini-3.6-flash', vercel: 'google/gemini-3.6-flash', huggingface: null },
  { canonicalId: 'mistral/mistral-medium-3.5', ladder: [{ client: 'vibe', model: 'mistral-medium-3.5' }], origin: 'ladder rung 9', openrouter: 'mistralai/mistral-medium-3-5', vercel: 'mistral/mistral-medium-3.5', huggingface: null },
  { canonicalId: 'xiaomi/mimo-v2.6-flash', ladder: [{ client: 'cline', model: 'cline-free/mimo-v2.6-flash' }], origin: 'ladder rung 10', openrouter: 'xiaomi/mimo-v2.6-flash', vercel: 'xiaomi/mimo-v2.6-flash', huggingface: null },
  { canonicalId: 'anthropic/claude-sonnet-4', ladder: [{ client: 'goose', model: 'anthropic/claude-sonnet-4' }], origin: 'ladder rung 10', openrouter: 'anthropic/claude-sonnet-4', vercel: 'anthropic/claude-sonnet-4', huggingface: null },
  { canonicalId: 'qwen/qwen3.8-27b', ladder: [{ client: 'opencode', model: 'cerebras/qwen-3.8-27b' }], origin: 'ladder rung 10', openrouter: 'qwen/qwen3.8-27b', vercel: 'alibaba/qwen3.8-27b', huggingface: 'Qwen/Qwen3.8-27B' },
  { canonicalId: 'anthropic/claude-sonnet-5', ladder: [], origin: 'Public Anthropic workhorse tier', openrouter: 'anthropic/claude-sonnet-5', vercel: 'anthropic/claude-sonnet-5', huggingface: null },
  { canonicalId: 'anthropic/claude-haiku-4.5', ladder: [], origin: 'Public Anthropic', openrouter: 'anthropic/claude-haiku-4.5', vercel: 'anthropic/claude-haiku-4.5', huggingface: null },
  { canonicalId: 'openai/gpt-6-astra', ladder: [], origin: 'Public OpenAI flagship', openrouter: 'openai/gpt-6-astra', vercel: 'openai/gpt-6-astra', huggingface: null },
  { canonicalId: 'zai/glm-5.3', ladder: [], origin: 'vibe zai-glm-5-3 (clients.json)', openrouter: 'z-ai/glm-5.3', vercel: 'zai/glm-5.3', huggingface: 'zai-org/GLM-5.3' },
];

// Subscription clients: a flat or quota fee, not a per-token bill (.ai/docs/clients.json auth and quota fields).
// kilo, mimo, goose, opencode and kimi bill per token or run on a key, so they are not subscription routes here.
// Client model ids mapped to canonical ids where the mapping is plain; every other id of a client stays unmapped and is listed.
const SUBSCRIPTION_CLIENTS = {
  claude: { binary: 'claude', plan: 'Claude Pro subscription', models: { 'claude-opus-5-5': 'anthropic/claude-opus-5.5', 'claude-sonnet-5': 'anthropic/claude-sonnet-5', 'claude-haiku-4-5': 'anthropic/claude-haiku-4.5' } },
  codex: { binary: 'codex', plan: 'ChatGPT subscription', models: { 'gpt-5.6-sol': 'openai/gpt-5.6-sol', 'gpt-5.6-terra': 'openai/gpt-5.6-terra', 'gpt-5.6-luna': 'openai/gpt-5.6-luna', 'gpt-6-astra': 'openai/gpt-6-astra' } },
  agy: { binary: 'agy', plan: 'Antigravity Pro subscription', models: { 'gemini-3.8-flash-high': 'google/gemini-3.8-flash', 'gemini-3.7-flash-high': 'google/gemini-3.7-flash', 'gemini-3.6-flash-high': 'google/gemini-3.6-flash', 'claude-sonnet-4-6': 'anthropic/claude-sonnet-4.6' } },
  copilot: { binary: 'copilot', plan: 'GitHub Copilot premium requests', models: { 'claude-sonnet-5': 'anthropic/claude-sonnet-5', 'claude-opus-5': 'anthropic/claude-opus-5', 'gpt-5.3-codex': 'openai/gpt-5.3-codex', 'gemini-3.5-flash': 'google/gemini-3.5-flash' } },
  vibe: { binary: 'vibe', plan: 'Mistral Pro (Vibe Code allowance)', models: { 'mistral-medium-3.5': 'mistral/mistral-medium-3.5', 'zai-glm-5-3': 'zai/glm-5.3' } },
};

// Free-tier clients: a gateway that serves the model at no charge (clients.json cline quota: cline-free route on the free tier).
const FREE_CLIENTS = {
  cline: { binary: 'cline', plan: 'Cline free gateway', models: { 'cline-free/mimo-v2.6-flash': 'xiaomi/mimo-v2.6-flash' } },
};

/**
 * Join point for the stream that maps benchmark names to ladder ids: the canonical id of a ladder entry (client + model as in docs/ops/model-ladder.json), or null.
 * @param {string} client
 * @param {string|null} model
 * @returns {string|null}
 */
function canonicalForLadder(client, model) {
  const row = LADDER_MODELS.find((m) => m.ladder.some((l) => l.client === client && l.model === model));
  return row ? row.canonicalId : null;
}

module.exports = { nearMisses, canonicalForLadder, CREATOR_ALIASES, ID_ALIASES, LADDER_MODELS, SUBSCRIPTION_CLIENTS, FREE_CLIENTS, canonicalize, assignCanonical };

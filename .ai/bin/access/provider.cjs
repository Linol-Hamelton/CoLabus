'use strict';
// Private child of channels-env. Values exist only in this process's request headers and memory.
const lib = require('../../../docs/ops/channels-lib.cjs');
const verify = require('../../../docs/ops/channels-verify.cjs');
const { modelName } = require('./clients.cjs');
const HOSTS = Object.freeze({
  openrouter: ['openrouter.ai'], deepseek: ['api.deepseek.com'], gateway: ['ai-gateway.vercel.sh'],
  groq: ['api.groq.com'], cerebras: ['api.cerebras.ai'], sambanova: ['api.sambanova.ai'], together: ['api.together.xyz'],
  ollama: ['ollama.com'], odirouter: ['api.odirouter.ai'], huggingface: ['huggingface.co', 'router.huggingface.co'],
  cloudflare: ['api.cloudflare.com'], mistral: ['api.mistral.ai'], openai: ['api.openai.com'], anthropic: ['api.anthropic.com'],
});
const MODEL_URL = Object.freeze({
  openrouter: 'https://openrouter.ai/api/v1/models', deepseek: 'https://api.deepseek.com/models',
  gateway: 'https://ai-gateway.vercel.sh/v1/models', huggingface: 'https://router.huggingface.co/v1/models',
  mistral: 'https://api.mistral.ai/v1/models', openai: 'https://api.openai.com/v1/models', anthropic: 'https://api.anthropic.com/v1/models',
});
const numeric = x => (typeof x === 'number' || typeof x === 'string' && /^-?\d+(?:\.\d+)?$/.test(x)) && Number.isFinite(Number(x)) ? Number(x) : null;

async function inspect(id, deps = {}) {
  const cat = deps.catalog || lib.loadCatalog(), ch = cat.channels.find(c => c.id === id && c.kind === 'api');
  const row = { id: ch ? ch.id : 'unknown', state: 'unknown', balance: [], modelCount: null, models: [] };
  if (!ch?.key || !lib.isOffered(ch) || !Object.hasOwn(HOSTS, id)) return row;
  const env = deps.env || process.env;
  const values = [ch.key.env, ...(ch.key.aliases || []).map(a => a.name)].map(n => env[n]).filter(v => typeof v === 'string' && v);
  if (!values.length) return { ...row, state: 'missing' };
  // Do not let a vendor return a credential in a field labelled model or currency.
  const cleanName = s => typeof s === 'string' && !values.some(v => s.includes(v)) ? modelName(s) : null;
  let names = new Set(), sawModels = false;
  const addModels = j => {
    const arr = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : Array.isArray(j?.result) ? j.result : null;
    if (!arr) return;
    sawModels = true;
    for (const m of arr) { const n = cleanName(m?.id || m?.name); if (n) names.add(n); }
  };
  const guardedFetch = async (url, opts) => {
    const u = new URL(url);
    if (u.protocol !== 'https:' || !HOSTS[id].includes(u.host) || u.username || u.password) throw new Error('HOST_REFUSED');
    const r = await (deps.fetch || fetch)(url, { ...opts, redirect: 'manual' });
    if (r.status >= 200 && r.status < 300) {
      const j = await r.clone().json().catch(() => null);
      addModels(j);
      if (id === 'deepseek' && Array.isArray(j?.balance_infos)) {
        row.balance = j.balance_infos.map(b => ({ currency: ['USD', 'CNY'].includes(b.currency) ? b.currency : null, amount: numeric(b.total_balance) })).filter(b => b.currency && b.amount !== null);
      } else if (id === 'gateway' && numeric(j?.balance) !== null) row.balance = [{ currency: 'USD', amount: numeric(j.balance) }];
      else if (id === 'openrouter' && numeric(j?.data?.limit_remaining) !== null) row.balance = [{ currency: 'USD', amount: numeric(j.data.limit_remaining) }];
    }
    return r;
  };
  // Reuse the project's verifier: its own parser text is consumed only to select a closed state.
  let output = '';
  await verify.main(['--only', id], { catalog: cat, env, store: { list: () => [] }, fetch: guardedFetch, stdout: { write: s => { output += s; } }, stderr: { write() {} } });
  row.state = /: valid(?:;|\n| )/.test(output) ? 'valid' : /: rejected/.test(output) ? 'rejected' : /: no answer/.test(output) ? 'no-answer' : 'unknown';
  const acct = env.CLOUDFLARE_ACCOUNT_ID;
  const url = id === 'cloudflare' && typeof acct === 'string' && /^[a-f0-9]{32}$/.test(acct)
    ? `https://api.cloudflare.com/client/v4/accounts/${acct}/ai/models/search?per_page=100&task=Text%20Generation` : MODEL_URL[id];
  if (url) {
    const headers = id === 'anthropic' ? { 'x-api-key': values[0], 'anthropic-version': '2023-06-01' } : { Authorization: `Bearer ${values[0]}` };
    try {
      const r = await guardedFetch(url, { method: 'GET', headers, signal: AbortSignal.timeout(15000) });
      if (r.status >= 200 && r.status < 300 && row.state === 'unknown' && !ch.key.verify) row.state = 'valid';
    } catch { /* explicit unknown, no error or URL leaves the process */ }
  }
  row.models = [...names].sort();
  row.modelCount = sawModels ? row.models.length : null;
  // Last boundary: even an endpoint echoing a short credential as a number is not stored.
  const text = JSON.stringify(row);
  if (values.some(v => text.includes(v))) return { id, state: 'unknown', balance: [], modelCount: null, models: [] };
  return row;
}
module.exports = { HOSTS, MODEL_URL, inspect };
if (require.main === module) inspect(process.argv[2]).then(row => process.stdout.write(JSON.stringify(row) + '\n'), () => { process.stderr.write('PROVIDER_FAILED\n'); process.exitCode = 1; });

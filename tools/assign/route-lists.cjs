'use strict';
// The route catalog of the host from its two route lists (a Kilo list and a
// Cline list of launch commands). Every command a list names is a route of the
// catalog: the importer never drops, merges or guesses one, and a command line
// outside the grammar refuses the whole import. The lists are read only from the
// paths the host configuration names; this module names no machine path.
// The catalog is a record of launch instructions, not proof that a route answers:
// a route whose provider says its accounts are exhausted is QUOTA_EXHAUSTED (a
// quota with a reset), never a dead route, and it stays in the catalog.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const io = require('./io.cjs');
const text = require('../../.ai/bin/lib/text-safe.cjs');
const identity = require('../../.ai/bin/lib/model-identity.cjs');

const CONFIG = 'docs/ops/routes/route-lists.config.json';
const CATALOG = 'docs/ops/routes/route-catalog.json';
const SCHEMA = 'route-catalog/1';
const LISTS = { kilo: { client: 'kilo', fence: 'powershell' }, cline: { client: 'cline', fence: 'powershell' } };
const EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'thinking', 'tiered'];
const SUFFIX = /-(minimal|low|medium|high|xhigh|max|tiered)$/;
const MODEL = /^[a-z0-9][a-z0-9.:/_-]{0,159}$/i;
const MAX_LIST_BYTES = 1024 * 1024;
const fail = (code, detail) => { throw Object.assign(new Error(detail ? `${code}: ${detail}` : code), { code }); };
const sha = s => crypto.createHash('sha256').update(s).digest('hex');

// The pool a command routes to. The Sub2API pools are named by the model family
// the list serves through them (Claude, Gemini, GPT-OSS; Codex: GPT).
const PROXY_POOLS = [['claude-', 'sub2api-claude', 'anthropic'], ['gemini-', 'sub2api-gemini', 'google'],
  ['gpt-oss-', 'sub2api-gpt-oss', 'openai'], ['gpt-', 'codex-gpt', 'openai'], ['codex-', 'codex-gpt', 'openai']];
function poolOf(provider, model) {
  if (provider === 'kilo' || provider === 'cline') return { group: `${provider}-free`, routeKind: 'free', billing: 'free' };
  if (provider === 'deepseek' || provider === 'nvidia') return { group: `${provider}-api`, routeKind: 'direct-api', billing: 'api-key' };
  if (provider === 'openai-compatible') {
    const pool = PROXY_POOLS.find(([prefix]) => model.startsWith(prefix));
    return { group: pool ? pool[1] : 'sub2api-unknown', routeKind: 'subscription-proxy', billing: 'subscription', family: pool ? pool[2] : null };
  }
  fail('route-lists-provider', provider);
}
// The maker family of a route, or null: the pool's family for a proxy, else the
// canonical family of the model id or of its maker segment. Unknown stays null.
function familyOf(provider, model, pool) {
  if (pool.family !== undefined) return pool.family;
  for (const candidate of [model, model.split('/').at(-1)]) {
    const f = identity.canonicalFamily(candidate);
    if (f && f !== 'UNKNOWN') return f;
  }
  // The maker segment of the id; a direct API without one is its provider's own model.
  const maker = identity.declaredFamily(model.includes('/') ? model.split('/')[0] : provider === 'deepseek' ? provider : '');
  return maker && maker !== 'UNKNOWN' ? maker : null;
}

// One list as routes: { client, provider, model, effort, pass, line }. Inside a
// fence of the list's language, a line whose first word is the client, after any
// leading whitespace and before any whitespace, is a command: it is a route or a
// named refusal, never skipped. The one saved-settings form of the Cline list (no
// provider, no model) is not a route.
function parse(source, list) {
  const spec = LISTS[list];
  if (!spec) fail('route-lists-list', list);
  const decoded = text.decode(Buffer.isBuffer(source) ? source : Buffer.from(String(source), 'utf8'), { bom: 'strip', invisible: 'refuse', crlf: 'normalise', finalNewline: 'report' });
  if (!decoded.ok) fail('route-lists-encoding', list);
  const routes = [];
  let fence = false;
  for (const [index, raw] of decoded.text.split('\n').entries()) {
    const line = raw.trim();
    if (line.startsWith('```')) { fence = !fence && line === '```' + spec.fence ? true : fence && line === '```' ? false : fence; continue; }
    if (!fence || line.split(/\s/, 1)[0] !== spec.client) continue;
    let provider, model, effort = null, pass;
    if (list === 'kilo') {
      const m = /^kilo run --auto (?:--variant ([a-z]+) )?-m (\S+) "[^"\r\n]+"$/.exec(line);
      if (!m || !MODEL.test(m[2]) || !m[2].includes('/')) fail('route-lists-command', `kilo line ${index + 1}`);
      provider = m[2].split('/')[0]; model = m[2].slice(provider.length + 1);
      if (m[1]) { effort = m[1]; pass = '--variant'; }
    } else {
      if (/^cline --auto-approve true "[^"\r\n]+"$/.test(line)) continue;
      const m = /^cline --auto-approve true(?: --thinking ([a-z]+))? -P ([a-z0-9-]+) -m (\S+) "[^"\r\n]+"$/.exec(line);
      if (!m || !MODEL.test(m[3])) fail('route-lists-command', `cline line ${index + 1}`);
      provider = m[2]; model = m[3];
      if (m[1]) { effort = m[1]; pass = '--thinking'; }
    }
    if (effort === null) { const s = SUFFIX.exec(model); if (s) { effort = s[1]; pass = 'model-suffix'; } }
    if (effort === null || !EFFORTS.includes(effort)) fail('route-lists-effort', `${list} line ${index + 1}`);
    routes.push({ client: spec.client, provider, model, effort, pass, line: index + 1 });
  }
  if (fence) fail('route-lists-fence', list);
  if (!routes.length) fail('route-lists-empty', list);
  return { routes, sha256: sha(decoded.text) };
}

const routeId = r => 'rl-' + sha(JSON.stringify([r.client, r.provider, r.model, r.pass, r.effort])).slice(0, 40);
// The catalog of the two lists. Deterministic: the same lists give the same bytes.
function build(kiloSource, clineSource) {
  const sources = [], routes = [];
  for (const [list, source] of [['kilo', kiloSource], ['cline', clineSource]]) {
    const parsed = parse(source, list);
    sources.push({ list, sha256: parsed.sha256, routes: parsed.routes.length });
    for (const r of parsed.routes) {
      const pool = poolOf(r.provider, r.model);
      routes.push({ id: routeId(r), list, line: r.line, client: r.client, provider: r.provider, model: r.model,
        effort: r.effort, effortPass: r.pass, group: pool.group, routeKind: pool.routeKind, billing: pool.billing,
        family: familyOf(r.provider, r.model, pool) });
    }
  }
  const seen = new Set();
  for (const r of routes) { if (seen.has(r.id)) fail('route-lists-duplicate', `${r.list} line ${r.line}`); seen.add(r.id); }
  return { schema: SCHEMA, rule: 'Every launch command of the two route lists of the host is one route here, with its client, provider, model id and effort (a --variant or --thinking flag, or the suffix of the model id). The catalog names routes, never their health: a quota answer of the provider is QUOTA_EXHAUSTED with its reset time and the route stays.', sources, routes };
}
const serialize = catalog => `${JSON.stringify(catalog, null, 2)}\n`;

// A catalog document as the schema and the closed rules state it: every id is
// the hash of its route, ids are unique, every derived field (group, route kind,
// billing, family) is the one its provider and model give, the source counts are
// the route counts.
const CATALOG_SCHEMA = require('./route-catalog.schema.json');
function validateCatalog(doc) {
  const problems = require('../../.ai/bin/accounting/lib/schema-check.cjs').validate(CATALOG_SCHEMA, doc, 'catalog');
  if (problems.length) fail('route-catalog-invalid', problems[0]);
  const ids = new Set();
  for (const r of doc.routes) {
    let pool;
    try { pool = poolOf(r.provider, r.model); } catch { fail('route-catalog-invalid', `route ${r.id}`); }
    if (r.id !== routeId({ ...r, pass: r.effortPass }) || ids.has(r.id) || r.list !== r.client
        || r.group !== pool.group || r.routeKind !== pool.routeKind || r.billing !== pool.billing
        || r.family !== familyOf(r.provider, r.model, pool)) fail('route-catalog-invalid', `route ${r.id}`);
    ids.add(r.id);
  }
  if (doc.sources[0].list !== 'kilo' || doc.sources[1].list !== 'cline'
      || doc.sources.some(s => s.routes !== doc.routes.filter(r => r.list === s.list).length)) fail('route-catalog-invalid', 'source counts');
  return doc;
}
// The tracked catalog of a tree, or null when the host keeps none.
function load(root) {
  let guarded, doc;
  try { guarded = io.guard(path.resolve(root), CATALOG); } catch { fail('route-catalog-invalid'); }
  if (!guarded.exists) return null;
  try { doc = io.readJson(path.resolve(root), CATALOG, 16 * 1024 * 1024); } catch { fail('route-catalog-invalid'); }
  return validateCatalog(doc);
}
// The catalog routes as launch declarations of the selection layer (the shape of
// its command-list routes): unproven, unpriced, a free route advisory only. The
// catalog is checked here too, so no caller derives a role from an unchecked one.
function selectionRoutes(catalog) {
  validateCatalog(catalog);
  return catalog.routes.filter(r => r.family !== null).map(r => {
    const model = r.client === 'kilo' ? `${r.provider}/${r.model}` : r.model;
    const level = r.effort, pass = r.effortPass;
    const routeKind = r.routeKind === 'subscription-proxy' ? 'local-subscription-proxy' : r.routeKind;
    return { id: 'cli-' + sha(JSON.stringify([r.client, r.provider, model, pass, level])).slice(0, 56), client: r.client, provider: r.provider, model,
      reasoning: { level, pass, selectionEffort: ['thinking', 'tiered'].includes(level) ? null : level }, family: r.family,
      billingClass: r.billing, routeKind, proofMethod: r.client === 'kilo' ? 'kilo-banner' : 'cline-run-result-model', price: null, proof: null,
      advisoryLevel: r.billing === 'free' ? 0 : null, roles: r.billing === 'free' ? ['advisory'] : [], group: r.group,
      source: { path: CATALOG, line: catalog.routes.indexOf(r) + 1 } };
  });
}

// The host configuration: the absolute paths of the two lists. Absent: unconfigured.
function config(root, file = CONFIG) {
  let guarded, doc;
  try { guarded = io.guard(path.resolve(root), file); } catch { fail('route-lists-config-invalid'); }
  if (!guarded.exists) fail('route-lists-unconfigured');
  try { doc = io.readJson(path.resolve(root), file); } catch { fail('route-lists-config-invalid'); }
  try { io.fields(doc, ['schema', 'kilo', 'cline', 'reason'], ['schema', 'kilo', 'cline']); } catch { fail('route-lists-config-invalid'); }
  if (doc.schema !== 'route-lists-config/1' || ![doc.kilo, doc.cline].every(p => typeof p === 'string' && path.isAbsolute(p) && p.length < 400)
      || doc.reason !== undefined && typeof doc.reason !== 'string') fail('route-lists-config-invalid');
  return doc;
}
function readList(file) {
  let st;
  try { st = fs.statSync(file); } catch { fail('route-lists-unreadable'); }
  if (!st.isFile() || st.size > MAX_LIST_BYTES) fail('route-lists-unreadable');
  return fs.readFileSync(file);
}
// A fresh catalog from the configured lists of a tree.
function importLists(root, file) {
  const c = config(root, file);
  return build(readList(c.kilo), readList(c.cline));
}
// The export check: the tracked catalog equals a fresh import of the two lists.
// missing: a route a list names and the catalog lacks; extra: the reverse.
function check(root, file) {
  const fresh = importLists(root, file);
  let tracked = null;
  try { tracked = load(root); } catch { tracked = null; }
  const ids = c => new Set((c?.routes || []).map(r => r.id));
  const want = ids(fresh), have = ids(tracked);
  const equal = tracked !== null && serialize(tracked) === serialize(fresh);
  return { ok: equal, missing: [...want].filter(x => !have.has(x)).length, extra: [...have].filter(x => !want.has(x)).length,
    routes: fresh.routes.length, tracked: tracked === null ? null : tracked.routes?.length ?? null };
}

// The class of a provider answer. The account-pool answers of the subscription
// proxy are a quota: QUOTA_EXHAUSTED with the reset time when the answer names
// one (an instant, or a delay after now), else null. Never a dead route.
const QUOTA = [/\bAll available accounts (?:are )?exhausted\b/i, /\b503\b[^\n]{0,40}\bNo available accounts\b/i, /\bNo available accounts\b/i,
  /\bService temporarily unavailable\b/i];
const UNIT = { second: 1e3, seconds: 1e3, s: 1e3, minute: 6e4, minutes: 6e4, min: 6e4, hour: 36e5, hours: 36e5, h: 36e5 };
function answerClass(answer, now = Date.now()) {
  if (typeof answer !== 'string' || !QUOTA.some(r => r.test(answer))) return null;
  let resetAt = null;
  const at = /\breset(?:s)?(?: at)?[: ]+([0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}[:][0-9]{2}(?:[:][0-9]{2}(?:[.][0-9]{1,3})?)?(?:Z|[+-][0-9]{2}[:][0-9]{2}))/i.exec(answer);
  const after = /\b(?:retry[- ]after|reset(?:s)? in|try again in)[: ]+(\d{1,7})\s*(seconds?|minutes?|min|hours?|s|h)?\b/i.exec(answer);
  if (at && Number.isFinite(Date.parse(at[1]))) resetAt = new Date(Date.parse(at[1])).toISOString();
  else if (after && Number.isFinite(now)) resetAt = new Date(now + Number(after[1]) * (UNIT[(after[2] || 'seconds').toLowerCase()] || 1e3)).toISOString();
  return { class: 'QUOTA_EXHAUSTED', resetAt };
}
// A line the provider's account-pool message opens, after optional indentation,
// an error word with its colon and a 4xx or 5xx status: the provider speaking.
// A sentence that quotes the message further in is data, never a quota.
const ENVELOPE_PREFIX = /^[^\S\r\n]*(?:\w*error[^\S\r\n]*:[^\S\r\n]*)?(?:(?:HTTP(?:\/\d+(?:\.\d+)?)?[^\S\r\n]+)?[45]\d\d\b[^\S\r\n]*:?[^\S\r\n]*)?/i;
function quotaLine(line) {
  if (typeof line !== 'string') return false;
  const rest = line.replace(ENVELOPE_PREFIX, '');
  return QUOTA.some(r => r.exec(rest)?.index === 0);
}

function main(argv) {
  const [command, ...rest] = argv;
  const opt = rest[0] === '--config' && rest[1] ? rest[1] : rest.length ? null : undefined;
  if (!['import', 'check'].includes(command) || opt === null || rest.length > 2) {
    process.stderr.write('Usage: route-lists.cjs import|check [--config FILE]\n'); return 2;
  }
  const root = path.resolve(__dirname, '../..');
  try {
    if (command === 'check') {
      const r = check(root, opt);
      process.stdout.write(`ROUTE-LISTS ${r.ok ? 'OK' : 'STALE'} routes=${r.routes} tracked=${r.tracked ?? 'none'} missing=${r.missing} extra=${r.extra}\n`);
      return r.ok ? 0 : 1;
    }
    const catalog = importLists(root, opt);
    io.writeText(root, path.join(root, CATALOG), serialize(catalog));
    process.stdout.write(`ROUTE-LISTS IMPORTED routes=${catalog.routes.length} ${catalog.sources.map(s => `${s.list}=${s.routes}`).join(' ')}\n`);
    return 0;
  } catch (e) {
    process.stdout.write(`ROUTE-LISTS REFUSED ${/^route-lists-[a-z-]+$/.test(e.code || '') ? e.code : 'route-lists-unreadable'}\n`);
    return 2;
  }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { CONFIG, CATALOG, SCHEMA, parse, build, serialize, validateCatalog, load, selectionRoutes, config, importLists, check, answerClass, quotaLine, poolOf, routeId, main };

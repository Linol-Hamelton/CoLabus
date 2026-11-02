#!/usr/bin/env node
'use strict';
// channels-verify: for every key-bearing service whose key is available on this machine, ONE read-only authenticated request to a documented endpoint,
// and a report of name, state and (where the endpoint gives one) the balance (PROTO-DEC-0178 item 3; Class B tooling).
//   node docs/ops/channels-verify.cjs [--alias NAME] [--only a,b] [--root DIR]
// A key is "available" when it is stored for the alias (or the only stored key of the service) or a variable of the catalog for that service is set
// in this environment (the canonical name and its aliases, in catalog order). The endpoint, its host allow-list and the parser come from the catalog
// (key.verify). States: valid (2xx), rejected 401 or 403, no answer (network error or timeout), unknown (anything else, a redirect, a refusal).
// Services without a verified read-only endpoint print "not checked: no verified read-only endpoint" and nothing is requested for them.
// HARD RULES (a static test scans this file for each, and a mutation probe breaks each in a copy):
//   * a request that carries a key goes only to a host of the allow-list of THAT channel, over https; redirects are never followed; timeout 15 s;
//   * a value is used only in the request (a bearer header, or the path of the Telegram URL) and nowhere else: it is never printed, never written,
//     never put in an error text; errors are reported by their CODE only; a URL is never printed; everything printed is scrubbed of every value in play;
//   * no file is written; the tool never accepts a value in argv.
// Telegram: the bot name that getMe returns is compared with key.expectedBot of the catalog; a different name prints a WARNING (the legacy name
// TELEGRAM_BOT_TOKEN can belong to another project's bot).
// Exit: 0 every checked key is valid (and nothing else to report), 1 a key is rejected, gave no answer or is unknown, 2 usage error.
const lib = require('./channels-lib.cjs');

const USAGE = `usage:
  channels-verify [--alias NAME] [--only a,b] [--root DIR]
One read-only request per available key, sent only to the vendor of that key. Values, headers and URLs are never printed.`;

const UA = 'keystore-channels-verify/1';
const TOKEN_IN_URL = /^[A-Za-z0-9:_-]{8,200}$/;

// ---------------------------------------------------------------- arguments
function parse(argv) {
  const o = { alias: null, only: null, root: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--alias' || a === '--only' || a === '--root') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return { error: `${a} needs a value` };
      i++;
      if (a === '--alias') o.alias = v; else if (a === '--root') o.root = v; else o.only = v.split(',').map(s => s.trim()).filter(Boolean);
    } else if (a.startsWith('--')) return { error: `unknown option ${a.split('=')[0]}` };
    else return { error: 'no positional arguments: a key value is never an argument' };
  }
  return o;
}

// ---------------------------------------------------------------- parsers of the answers: only numbers and short plain words survive
const num = (x) => ((typeof x === 'number' && Number.isFinite(x)) || (typeof x === 'string' && /^-?\d+(\.\d+)?$/.test(x)) ? String(x) : null);
const word = (s) => String(s == null ? '' : s).replace(/[^A-Za-z0-9 ._@-]/g, '').slice(0, 40);
const PARSERS = {
  openrouter(j) {
    const d = j && j.data;
    if (!d) return { detail: '' };
    const p = [];
    if (num(d.usage) !== null) p.push(`usage ${num(d.usage)} USD`);
    p.push(d.limit == null ? 'no limit on the key' : `limit ${num(d.limit)} USD`);
    if (num(d.limit_remaining) !== null) p.push(`remaining ${num(d.limit_remaining)} USD`);
    return { detail: p.join(', ') };
  },
  deepseek(j) {
    const b = j && j.balance_infos;
    if (!Array.isArray(b) || !b.length) return { detail: '' };
    return { detail: `balance ${b.map(x => `${word(x && x.currency)} ${num(x && x.total_balance)}`).join('; ')}` };
  },
  models(j) { return { detail: j && Array.isArray(j.data) ? `${j.data.length} models` : '' }; },
  huggingface(j) { return { detail: j && j.name ? `account ${word(j.name)}` : '' }; },
  gateway(j) {
    const p = [];
    if (j && num(j.balance) !== null) p.push(`balance ${num(j.balance)}`);
    if (j && num(j.total_used) !== null) p.push(`used ${num(j.total_used)}`);
    return { detail: p.join(', ') };
  },
  github(j) { return { detail: j && j.login ? `user ${word(j.login)}` : '' }; },
  cloudflare(j) { return { detail: j && j.result && j.result.status ? `token status ${word(j.result.status)}` : '' }; },
  telegram(j) {
    const u = j && j.result && j.result.username ? `@${word(j.result.username)}` : null;
    return u ? { detail: `bot ${u}`, username: u } : { detail: '' };
  },
};

// Only a short code word is ever reported (never the message): a timeout, or the string code of the error (ENOTFOUND, ECONNRESET), else 'error'.
function errCode(e) {
  if (e && (e.name === 'AbortError' || e.name === 'TimeoutError')) return 'timeout';
  const c = (e && e.cause && typeof e.cause.code === 'string' && e.cause.code) || (e && typeof e.code === 'string' && e.code) || 'error';
  return String(c).replace(/[^A-Za-z0-9_]/g, '').slice(0, 24) || 'error';
}

// ---------------------------------------------------------------- the one request
// g: { value, labels, envNames }; spec: key.verify of the channel. Returns { state, detail, username }.
async function requestOnce(g, spec, deps) {
  let built;
  if (spec.auth === 'url-token') {
    if (!TOKEN_IN_URL.test(g.value)) return { state: 'unknown', detail: 'refused: the value cannot be put in a URL path safely' };
    built = spec.url.replace('<token>', g.value);
  } else built = spec.url;
  let u;
  try { u = new URL(built); } catch (e) { return { state: 'unknown', detail: 'refused: not a URL' }; }
  const local = deps.allowLocalHttp === true && u.protocol === 'http:' && u.hostname === '127.0.0.1';
  if ((u.protocol !== 'https:' && !local) || !spec.hosts.includes(u.host)) return { state: 'unknown', detail: 'refused: the host is not in the allow-list' };
  const headers = { 'User-Agent': UA, Accept: 'application/json' };
  if (spec.auth === 'bearer') headers.Authorization = `Bearer ${g.value}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), deps.timeoutMs || 15000);
  try {
    let res;
    try { res = await (deps.fetch || fetch)(built, { method: 'GET', redirect: 'manual', signal: ac.signal, headers }); } catch (e) { return { state: 'no answer', detail: `(${errCode(e)})` }; }
    const s = res.status;
    if (s >= 300 && s < 400) return { state: 'unknown', detail: `redirect not followed (HTTP ${s})` };
    if (s === 401 || s === 403) return { state: `rejected (${s})`, detail: '' };
    if (s < 200 || s >= 300) return { state: 'unknown', detail: `HTTP ${s}` };
    let json = null;
    try { json = await res.json(); } catch (e) { json = null; }
    const parsed = (PARSERS[spec.parse] || (() => ({ detail: '' })))(json);
    let detail = parsed.detail || '';
    return { state: 'valid', detail, username: parsed.username || null };
  } finally { clearTimeout(timer); }
}

// ---------------------------------------------------------------- main
async function main(argv, deps = {}) {
  const out = deps.stdout || process.stdout;
  const err = deps.stderr || process.stderr;
  const seen = [];
  const scrub = (s) => { let o = String(s); for (const v of seen) o = o.split(v).join('[redacted]'); return o; };
  const say = (s) => out.write(`${scrub(s)}\n`);
  const warn = (s) => err.write(`${scrub(s)}\n`);
  const guard = lib.argvGuard(argv);
  if (guard) { warn(`refused: ${guard}`); return 2; }
  const o = parse(argv);
  if (o.error) { warn(`${o.error}\n${USAGE}`); return 2; }
  if (o.help) { say(USAGE); return 0; }

  let cat;
  try { cat = deps.catalog || lib.loadCatalog(); } catch (e) { warn(`catalog: ${e.message}`); return 1; }
  if (o.only) {
    const bad = o.only.filter(id => !lib.findChannel(cat, id));
    if (bad.length) { warn(`refused: not a channel of the catalog: ${bad.join(', ')}`); return 2; }
  }
  if (o.alias !== null && !lib.ALIAS_RE.test(o.alias)) { warn('refused: alias must be letters and digits, start with a letter, at most 24 characters'); return 2; }
  const alias = o.alias === null ? null : o.alias.toUpperCase();
  let store;
  try { store = deps.store || lib.selectStore(deps.env || process.env, deps.platform, undefined, warn); } catch (e) { warn(e.message); return 1; }
  if (store.fake) warn('[fake credential store in use: test mode]');
  const env = deps.env || process.env;
  let stored;
  try { stored = lib.storedKeys(cat, lib.presenceView(store)); } catch (e) { warn('credential store: it could not be read'); return 1; }

  const tally = { checked: 0, valid: 0, rejected: 0, noAnswer: 0, unknown: 0, notChecked: 0, noKey: 0 };
  for (const ch of cat.channels) {
    if (!ch.key || !lib.isOffered(ch) || (o.only && !o.only.includes(ch.id))) continue;
    const k = ch.key;
    const groups = [];
    const add = (label, envName, value) => {
      if (typeof value !== 'string' || !value) return;
      let g = groups.find(x => x.value === value);
      if (!g) { g = { value, labels: [], envNames: [] }; groups.push(g); }
      g.labels.push(label);
      if (envName) g.envNames.push(envName);
      if (!seen.includes(value)) seen.push(value);
    };
    const have = stored.filter(x => x.service === k.service);
    let pickNote = null;
    try {
      if (alias !== null) { const hit = have.find(x => x.alias === alias); if (hit) add(`store ${hit.name}`, null, store.get(hit.name)); }
      else if (have.length === 1) add(`store ${have[0].name}`, null, store.get(have[0].name));
      else if (have.length > 1) pickNote = `several keys are stored (${have.map(x => x.alias).sort().join(', ')}): choose one with --alias`;
    } catch (e) { say(`${ch.id}: the credential store could not be read`); tally.unknown++; continue; }
    for (const n of [k.env, ...(k.aliases || []).map(x => x.name)]) add(`env ${n}`, n, env[n]);
    if (!groups.length) {
      if (pickNote) { say(`${ch.id}: ${pickNote}`); tally.notChecked++; } else { say(`${ch.id}: no key here`); tally.noKey++; }
      continue;
    }
    const spec = k.verify;
    for (const g of groups) {
      if (!spec) {
        say(`${ch.id}: ${g.labels.join(' + ')}: not checked: no verified read-only endpoint`);
        tally.notChecked++;
        continue;
      }
      const r = await requestOnce(g, spec, deps);
      tally.checked++;
      if (r.state === 'valid') tally.valid++; else if (/^rejected/.test(r.state)) tally.rejected++; else if (r.state === 'no answer') tally.noAnswer++; else tally.unknown++;
      const tail = r.detail ? (r.detail.startsWith('(') ? ` ${r.detail}` : `; ${r.detail}`) : '';
      say(`${ch.id}: ${g.labels.join(' + ')}: ${r.state}${tail}`);
      if (r.state === 'valid' && r.username && k.expectedBot && r.username.toLowerCase() !== k.expectedBot.toLowerCase()) {
        say(`WARNING: ${g.envNames.length ? g.envNames.join(' and ') : 'the stored key'} answers as ${r.username}, not the product bot ${k.expectedBot}: it belongs to another project; do not store it as a product key`);
      }
    }
  }
  say(`verify: ${tally.checked} checked, ${tally.valid} valid, ${tally.rejected} rejected, ${tally.noAnswer} no answer, ${tally.unknown} unknown, ${tally.notChecked} not checked, ${tally.noKey} no key here`);
  return tally.rejected || tally.noAnswer || tally.unknown ? 1 : 0;
}

module.exports = { main, parse, PARSERS, USAGE };
if (require.main === module) main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { process.stderr.write('failed: the verify command stopped\n'); process.exitCode = 1; });

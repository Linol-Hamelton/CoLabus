'use strict';
// Per-launch native stores. Never search by recency or copy message/config data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readFileGuarded, realInside } = require('../../lib/path-safe.cjs');
const { decode, parseJsonUnique } = require('../../lib/text-safe.cjs');
const U = require('./client-usage.cjs');
const MAX_BYTES = 64 * 1024 * 1024;
const KINDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total'];
const nat = n => Number.isSafeInteger(n) && n >= 0;
const unknown = reason => ({ tokens: null, reason });

function rows(text) {
  return String(text).split('\n').filter(s => s.trim()).map(s => {
    return parseJsonUnique(s);
  });
}
function read(root, file) {
  const got = readFileGuarded(root, file, { maxBytes: MAX_BYTES, refuseHardlinks: true });
  if (!got.ok) throw new Error('unreadable-store');
  const decoded = decode(got.bytes, { invisible: 'report', crlf: 'normalise' });
  if (!decoded.ok) throw new Error('unreadable-store');
  return rows(decoded.text);
}
function dirs(root, dir) {
  const guard = realInside(path.resolve(root) === path.resolve(dir) ? path.dirname(path.resolve(root)) : root, dir);
  if (!guard.ok) throw new Error('unsafe-store-directory');
  return fs.readdirSync(guard.real, { withFileTypes: true }).filter(e => e.isDirectory() && !e.isSymbolicLink()).map(e => path.join(guard.real, e.name));
}
function totals(events, source, select) {
  const sums = Object.fromEntries(KINDS.map(k => [k, 0]));
  let seen = 0;
  for (const event of events) {
    const counters = select(event);
    if (counters === undefined) continue;
    if (!counters || typeof counters !== 'object') return unknown(`${source}: missing usage counters`);
    seen++;
    for (const key of KINDS) {
      const n = counters[key];
      if (n === null || n === undefined || sums[key] === null) { sums[key] = null; continue; }
      if (!nat(n) || !nat(sums[key] + n)) return unknown(`${source}: invalid or overflowing counters`);
      sums[key] += n;
    }
  }
  if (!seen) return unknown(`${source}: no usage events`);
  const missing = KINDS.filter(k => sums[k] === null);
  return { tokens: { ...sums, source, ...(missing.length ? { note: `not reported: ${missing.join(', ')}` } : {}) }, reason: missing.length ? 'some counters not reported' : null };
}

function kimiUsage(home) {
  if (typeof home !== 'string' || !home) return unknown('kimi-wire: no launcher-owned home');
  try {
    const root = path.join(home, 'sessions');
    const workspaces = dirs(home, root);
    const sessions = workspaces.flatMap(w => dirs(home, w)).filter(d => path.basename(d).startsWith('session_') && U.SESSION_ID.test(path.basename(d).slice(8)));
    if (sessions.length !== 1) return unknown('kimi-wire: missing or ambiguous private session');
    const events = read(home, path.join(sessions[0], 'agents', 'main', 'wire.jsonl'));
    return totals(events, 'kimi-wire', e => {
      if (e.type !== 'usage.record') return undefined;
      if (e.agentId !== 'main') return null;
      const u = e.usage;
      if (!u) return null;
      const counts = [u.inputOther, u.output, u.inputCacheRead, u.inputCacheCreation];
      if (counts.some(n => n !== undefined && n !== null && !nat(n))) return null;
      const total = counts.every(nat) ? counts.reduce((a, b) => a + b, 0) : null;
      return { input: u.inputOther, output: u.output, cacheRead: u.inputCacheRead, cacheWrite: u.inputCacheCreation, reasoning: null, total };
    });
  } catch { return unknown('kimi-wire: unreadable or malformed private session'); }
}

function codexUsage(text, opts = {}) {
  const ids = [...String(text).matchAll(/^session id:\s*([0-9a-f-]{36})\s*$/gmi)].map(m => m[1]);
  if (!ids.length || new Set(ids).size !== 1 || !U.SESSION_ID.test(ids[0])) return unknown('codex-session: no unique session id');
  const id = ids[0];
  const root = opts.codexSessions || path.join((opts.env || process.env).CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
  try {
    const candidates = [];
    // Codex's own YYYY/MM/DD layout; all directories and the opened file are guarded.
    for (const y of dirs(root, root).filter(d => /^\d{4}$/.test(path.basename(d))))
      for (const m of dirs(root, y).filter(d => /^\d{2}$/.test(path.basename(d))))
        for (const d of dirs(root, m).filter(d => /^\d{2}$/.test(path.basename(d))))
          for (const f of fs.readdirSync(d)) if (f.startsWith('rollout-') && f.endsWith(`-${id}.jsonl`)) candidates.push(path.join(d, f));
    if (candidates.length !== 1) return unknown('codex-session: missing or ambiguous session file');
    const events = read(root, candidates[0]);
    const meta = events.filter(e => e.type === 'session_meta');
    if (meta.length !== 1 || meta[0].payload?.id !== id) return unknown('codex-session: session identity mismatch');
    if (opts.workdir && path.resolve(meta[0].payload.cwd || '') !== path.resolve(opts.workdir)) return unknown('codex-session: workdir mismatch');
    const usage = events.filter(e => e.type === 'event_msg' && e.payload?.type === 'token_count' && e.payload.info !== null);
    if (!usage.length) return unknown('codex-session: no token_count snapshot');
    let prev = null;
    for (const e of usage) {
      const u = e.payload.info?.total_token_usage;
      if (!u) return unknown('codex-session: incomplete token_count snapshot');
      for (const k of ['input_tokens', 'output_tokens', 'cached_input_tokens', 'cache_write_input_tokens', 'reasoning_output_tokens', 'total_tokens']) {
        if (u[k] !== undefined && u[k] !== null && (!nat(u[k]) || (prev && nat(prev[k]) && u[k] < prev[k]))) return unknown('codex-session: invalid or decreasing counters');
      }
      prev = u;
    }
    const u = prev;
    if (nat(u.input_tokens) && nat(u.output_tokens) && !nat(u.input_tokens + u.output_tokens)) return unknown('codex-session: overflowing total');
    if (nat(u.cached_input_tokens) && nat(u.input_tokens) && u.cached_input_tokens > u.input_tokens) return unknown('codex-session: invalid cache split');
    if (nat(u.total_tokens) && nat(u.input_tokens) && nat(u.output_tokens) && u.total_tokens !== u.input_tokens + u.output_tokens) return unknown('codex-session: invalid total');
    // Native total_token_usage is cumulative; never sum its snapshots.
    const result = U.fromCodexOutput(JSON.stringify({ type: 'turn.completed', usage: u }));
    if (result.tokens) result.tokens.source = 'codex-session';
    return { ...result, sessionId: id };
  } catch { return unknown('codex-session: unreadable or malformed session'); }
}

function extract(client, text, opts = {}) {
  client = String(client || '').toLowerCase();
  if (client === 'kimi') return kimiUsage(opts.kimiHome);
  if (client === 'kilo') {
    // Kilo is the OpenCode event grammar; its step-finish payload matches MiMo.
    let stream;
    try { stream = rows(text).map(e => JSON.stringify(e.part?.type === 'step-finish' ? { ...e, type: 'step_finish' } : e)).join('\n'); }
    catch { return unknown('kilo-json: malformed event stream'); }
    const got = U.fromMimoJson(stream);
    if (got.tokens) {
      if (KINDS.some(k => got.tokens[k] !== null && got.tokens[k] !== undefined && !nat(got.tokens[k]))) return unknown('kilo-json: overflowing counters');
      got.tokens.source = 'kilo-json';
    }
    return got;
  }
  if (client === 'codex') {
    const got = U.fromCodexOutput(text);
    if (got.tokens?.source === 'codex-json') return KINDS.some(k => got.tokens[k] !== null && got.tokens[k] !== undefined && !nat(got.tokens[k])) ? unknown('codex-json: overflowing counters') : got;
    return codexUsage(text, opts);
  }
  const got = U.extractUsage(client, text, opts);
  if (got.tokens && KINDS.some(k => got.tokens[k] !== null && got.tokens[k] !== undefined && !nat(got.tokens[k]))) return unknown('client usage counters overflow');
  return got;
}

function coverage(records) {
  const launches = new Map();
  for (const r of records) {
    if (!r || (!r.launchId && !r.name) || r.status === 'RUNNING') continue;
    launches.set(r.launchId || r.name, r);
  }
  let known = 0; let priced = 0;
  for (const r of launches.values()) {
    if (r.tokens && ['input', 'output', 'cacheRead'].every(k => nat(r.tokens[k]))) known++;
    if (r.cost && [r.cost.usd, r.cost.listEquivalentUsd].some(n => typeof n === 'number' && Number.isFinite(n) && n >= 0)) priced++;
  }
  const runs = launches.size;
  return { runs, known, priced, share: runs ? known / runs : null };
}

// A small closed wire format between the launcher and wrapper. Project numbers,
// never copy arbitrary strings (messages, client errors, model names or paths).
const SOURCES = new Set(['kimi-wire', 'kilo-json', 'codex-session', 'codex-json', 'claude-json', 'vibe-session-store', 'mimo-json', 'agent-result', 'cline-json', 'opencode-json']);
function frameFields(fields) {
  let tokens = null;
  if (fields?.tokens && SOURCES.has(fields.tokens.source)) {
    if (KINDS.some(k => fields.tokens[k] !== undefined && fields.tokens[k] !== null && !nat(fields.tokens[k]))) return null;
    tokens = { ...Object.fromEntries(KINDS.map(k => [k, fields.tokens[k] ?? null])), source: fields.tokens.source };
    if (KINDS.some(k => tokens[k] === null)) tokens.note = `not reported: ${KINDS.filter(k => tokens[k] === null).join(', ')}`;
  }
  const c = fields?.cost;
  if (!c || !['priced', 'subscription', 'unknown'].includes(c.basis)) return null;
  if (c.usd !== null && !(typeof c.usd === 'number' && Number.isFinite(c.usd) && c.usd >= 0)) return null;
  if ((c.basis === 'priced') !== (typeof c.usd === 'number')) return null;
  const cost = { usd: c.usd, basis: c.basis, priceSnapshot: null, formula: null };
  const s = c.priceSnapshot;
  if (s && /^\d{4}-\d{2}-\d{2}$/.test(s.id) && /^[0-9a-f]{12,64}$/.test(s.hash) && typeof s.capturedAt === 'string' && /^\d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(s.capturedAt)) {
    cost.priceSnapshot = { id: s.id, hash: s.hash, capturedAt: s.capturedAt, stale: s.stale === true };
    cost.formula = 'tokens times snapshot rates / 1e6 USD (list-price estimate)';
  }
  if (c.basis === 'priced' && !cost.priceSnapshot) return null;
  if (typeof c.listEquivalentUsd === 'number' && Number.isFinite(c.listEquivalentUsd) && c.listEquivalentUsd >= 0) cost.listEquivalentUsd = c.listEquivalentUsd;
  if (c.basis === 'subscription') cost.note = 'flat-fee subscription; usd is not a per-run bill';
  if (c.basis === 'unknown' || !tokens || (cost.usd === null && cost.listEquivalentUsd === undefined)) cost.reason = !tokens ? 'structured usage unavailable' : s?.stale ? 'price snapshot stale' : 'price or token class unavailable';
  return { tokens, cost };
}
function frame(fields) { return `USAGE_JSON ${JSON.stringify(frameFields(fields) || { tokens: null, cost: { usd: null, basis: 'unknown', priceSnapshot: null, formula: null, reason: 'invalid usage fields' } })}`; }
function parseFrame(line) {
  if (!line.startsWith('USAGE_JSON ') || line.length > 8192) return null;
  try { return frameFields(parseJsonUnique(line.slice(11))); } catch { return null; }
}
module.exports = { extract, kimiUsage, codexUsage, coverage, frame, parseFrame, frameFields, KINDS };

'use strict';
// Per-launch native stores. Never search by recency or copy message/config data.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { followedPathSync } = require('../../lib/real-path.cjs');
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

const codexRoot = opts => opts.codexSessions || path.join((opts.env || process.env).CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
// Codex's own YYYY/MM/DD layout; all directories are guarded. `days` (a Set of 'YYYY/MM/DD') limits the walk to the days of one window.
function codexFiles(root, accept, days) {
  const out = [];
  for (const y of dirs(root, root).filter(d => /^\d{4}$/.test(path.basename(d))))
    for (const m of dirs(root, y).filter(d => /^\d{2}$/.test(path.basename(d))))
      for (const d of dirs(root, m).filter(d => /^\d{2}$/.test(path.basename(d)) && (!days || days.has(`${path.basename(y)}/${path.basename(m)}/${path.basename(d)}`))))
        for (const f of fs.readdirSync(d)) if (f.startsWith('rollout-') && f.endsWith('.jsonl') && accept(f)) out.push(path.join(d, f));
  return out;
}

// The seat's sessions of one launch window, matched by the seat worktree the log itself names (session_meta cwd) and by the launch window rule
// of client-usage (U.insideLaunchWindow): the session start (the session_meta timestamp) and the session end (the timestamp of the last record of
// the log) both inside [startedAt, endedAt], so an earlier or a later session of the same worktree is never this one; a log whose last record
// carries no time is not shown to lie inside. The main session is the one the CLI started for the task (no parent
// thread); a session whose parent thread is the main session (the auto-review guardian of the CLI) is auxiliary and never the served model.
// Two main sessions of one worktree inside one window are ambiguous: no session, never one of them. A file of the window whose first record
// cannot be read is unknown too (it may be this seat's), unless it was last written before the window opened: a session that started inside
// the window has written its first record by then, so such a file belongs to another session. A sessions folder that does not exist (the CLI
// never ran under that profile) holds no session of the seat; a folder that exists but cannot be walked is unreadable. Each auxiliary model is
// named only from the closed list below, any other as "other".
const CODEX_AUX_MODELS = ['codex-auto-review'];
const CODEX_HEAD_BYTES = 1024 * 1024;
// One folder named two ways (a short 8.3 name, a link) is the same folder when the file system resolves both to one path. The judgment
// is where a link leads, so a link is followed also on a volume whose real path is walked.
const dirText = d => String(d || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
function realDir(d) { try { return dirText(followedPathSync(String(d))); } catch { return null; } }
const sameDir = (a, b) => Boolean(a && b) && (dirText(a) === dirText(b) || (realDir(a) !== null && realDir(a) === realDir(b)));
// -> { meta } with the session_meta payload of the first record, or { mtimeMs } when that record cannot be read
function codexHead(root, file) {
  const guard = realInside(root, file, { refuseHardlinks: true });
  if (!guard.ok) return { mtimeMs: NaN };
  const fd = fs.openSync(guard.real, 'r');
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) return { mtimeMs: NaN };
    const buf = Buffer.alloc(Math.min(CODEX_HEAD_BYTES, st.size));
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    let end = buf.subarray(0, n).indexOf(0x0a);
    if (end < 0) return { mtimeMs: st.mtimeMs };
    // a CRLF log is the same log: the line ends before its CR, as the full read normalises it
    if (end > 0 && buf[end - 1] === 0x0d) end--;
    const d = decode(buf.subarray(0, end), { invisible: 'report', crlf: 'normalise' });
    const j = d.ok ? parseJsonUnique(d.text) : null;
    return j && j.type === 'session_meta' && j.payload && typeof j.payload === 'object' ? { meta: j.payload } : { mtimeMs: st.mtimeMs };
  } catch { return { mtimeMs: NaN }; } finally { fs.closeSync(fd); }
}
function windowDays(s, e) {
  const days = new Set();
  for (let t = s - 86400000; t <= e + 86400000; t += 3600000) days.add(new Date(t).toISOString().slice(0, 10).replace(/-/g, '/'));
  return days;
}
function codexSessionsOf(opts = {}) {
  const win = { startedAt: opts.startedAt, endedAt: opts.endedAt };
  const w = U.launchWindow(win.startedAt, win.endedAt);
  if (!opts.workdir || !w) return { ok: false, reason: 'codex-session: no seat worktree plus launch window' };
  const root = codexRoot(opts);
  try { fs.lstatSync(root); } catch (e) { if (e && e.code === 'ENOENT') return { ok: false, reason: 'codex-session: no session of the seat worktree inside the launch window (no sessions folder)' }; }
  try {
    const heads = [];
    for (const file of codexFiles(root, () => true, windowDays(w.start, w.end))) {
      const head = codexHead(root, file);
      if (!head.meta && head.mtimeMs < w.start) continue;
      if (!head.meta) return { ok: false, reason: 'codex-session: a session file of the window is unreadable' };
      const meta = head.meta;
      // only a log of the worktree whose start lies inside the window is read whole, for the time of its last record
      if (!sameDir(meta.cwd, opts.workdir) || U.insideLaunchWindow({ start: meta.timestamp, end: meta.timestamp }, win) !== true) continue;
      const events = read(root, file);
      const last = events.length ? events[events.length - 1] : null;
      if (U.insideLaunchWindow({ start: meta.timestamp, end: last && last.timestamp }, win) !== true) continue;
      if (typeof meta.id !== 'string' || !U.SESSION_ID.test(meta.id)) return { ok: false, reason: 'codex-session: a session of the seat has no valid id' };
      heads.push({ file, meta, events });
    }
    const mains = heads.filter(h => h.meta.parent_thread_id === undefined || h.meta.parent_thread_id === null);
    if (!mains.length) return { ok: false, reason: 'codex-session: no session of the seat worktree inside the launch window' };
    if (mains.length > 1) return { ok: false, reason: `codex-session: ${mains.length} sessions of the seat worktree inside the launch window; not guessing` };
    const main = mains[0];
    const modelsOf = events => [...new Set(events.filter(x => x.type === 'turn_context').map(x => x.payload && x.payload.model))];
    const auxiliary = [];
    for (const h of heads.filter(x => x !== main)) {
      if (h.meta.parent_thread_id !== main.meta.id) return { ok: false, reason: 'codex-session: a child session of the window belongs to another main session' };
      auxiliary.push({ id: h.meta.id, models: modelsOf(h.events).map(m => (CODEX_AUX_MODELS.includes(m) ? m : 'other')) });
    }
    return { ok: true, main: { id: main.meta.id, file: main.file, events: main.events, models: modelsOf(main.events) }, auxiliary };
  } catch { return { ok: false, reason: 'codex-session: unreadable or malformed session' }; }
}

// The CLI also prints "tokens used" and one figure (fresh input + output, thousands grouped by U+00A0, which the one stream decode reads as a
// space). When that figure is there, the session totals must give the same number; a different number means the log is not this run's.
// A banner label whose figure cannot be read is no agreement either: the log is then not proven to be this run's.
function bannerAgrees(text, tokens) {
  if (!tokens) return true;
  if (!U.codexLabels(text).length) return true;
  const banner = U.fromCodexOutput(text);
  if (!banner.tokens || banner.tokens.source !== 'codex-banner') return false;
  return nat(tokens.input) && nat(tokens.output) && banner.tokens.total === tokens.input + tokens.output;
}

function codexUsage(text, opts = {}) {
  const ids = [...String(text).matchAll(/^session id:\s*([0-9a-f-]{36})\s*$/gmi)].map(m => m[1]);
  // With a seat worktree and a launch window the seat's session is the one main session of that worktree started inside the window, with or
  // without a printed id: a printed id must name that very session (an older session, a child session or one of two main sessions is unknown,
  // never its numbers), and several different printed ids are unknown. A seat worktree without its whole launch window cannot be checked:
  // unknown, never the printed id's numbers.
  if (opts.workdir && !(opts.startedAt && opts.endedAt)) return unknown('codex-session: a seat worktree without its launch window (start and end)');
  if (opts.workdir && opts.startedAt && opts.endedAt) {
    const printed = new Set(ids.map(id => id.toLowerCase()));
    if (printed.size > 1) return unknown('codex-session: several different printed session ids');
    const seat = codexSessionsOf(opts);
    if (!seat.ok) return unknown(seat.reason);
    if (printed.size && !printed.has(String(seat.main.id).toLowerCase())) return unknown('codex-session: the printed session id is not the one main session of the seat worktree in the launch window');
    const got = codexTokens(seat.main.events, seat.main.id);
    return got.tokens && !bannerAgrees(text, got.tokens) ? unknown('codex-session: the session totals differ from the tokens used banner') : got;
  }
  if (!ids.length || new Set(ids).size !== 1 || !U.SESSION_ID.test(ids[0])) return unknown('codex-session: no unique session id');
  const id = ids[0];
  const root = codexRoot(opts);
  try {
    const candidates = codexFiles(root, f => f.endsWith(`-${id}.jsonl`));
    if (candidates.length !== 1) return unknown('codex-session: missing or ambiguous session file');
    const events = read(root, candidates[0]);
    const meta = events.filter(e => e.type === 'session_meta');
    if (meta.length !== 1 || meta[0].payload?.id !== id) return unknown('codex-session: session identity mismatch');
    const got = codexTokens(events, id);
    return got.tokens && !bannerAgrees(text, got.tokens) ? unknown('codex-session: the session totals differ from the tokens used banner') : got;
  } catch { return unknown('codex-session: unreadable or malformed session'); }
}
function codexTokens(events, id) {
  try {
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
module.exports = { extract, kimiUsage, codexUsage, codexSessionsOf, coverage, frame, parseFrame, frameFields, KINDS, CODEX_AUX_MODELS };

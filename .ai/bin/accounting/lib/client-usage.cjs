'use strict';
// client-usage.cjs - what each agent client really says about its own usage (tokens, cost, session id), read from the
// output the launcher captured or from the client's own session store. Pure reading: writes nothing, runs no client,
// never throws (a failure is the `reason` of a result with tokens null). Class B tooling, advisory (PROTO-DEC-0143 item 3).
// Measured on 2026-10-10 (, usage matrix); fixtures are real samples:
//   mimo run --format json   one step_finish event per step: tokens {total,input,output,reasoning,cache{read,write}}, cost USD (client estimate).
//                            input is the fresh (not cached) input; reasoning is separate from output (total = input+output+reasoning+cache).
//   mimocode.db              the same numbers per assistant message (data.tokens, data.cost, data.modelID, data.providerID) by session id.
//   vibe -p --output streaming  prints no usage; every message carries sessionId. The client's unified session store
//                            (~/.vibe/logs/session/unified/<id>/) holds the cumulative tokenUsage and generations/*/runtime-state.json the active model.
//                            inputTokens includes cachedInputTokens.
//   codex exec (text)        only the exit banner "tokens used" + one total; codex exec --json prints turn.completed.usage
//                            (input_tokens includes cached_input_tokens; reasoning_output_tokens is part of output_tokens).
//   claude -p --output-format json   usage {input_tokens, cache_read_input_tokens, cache_creation_input_tokens, output_tokens},
//                            total_cost_usd (list-price equivalent, modelUsage.<model>.costBasis "list"), modelUsage keys = served models.
//   agy -p --output-format json      usage {input_tokens, output_tokens, thinking_tokens, cache_read_tokens, total_tokens}; text mode prints none.
//   openai-compat agent (dahl)       the AGENT_RESULT line: tokens_in, tokens_out.
// Normal form of `tokens`: input = fresh input tokens, cacheRead / cacheWrite = cached tokens read / written, output = all output tokens
// (reasoning included; `reasoning` is the informational part of it), total when the client states one. null = the client does not say.
// Guard (review finding): a counter the client did NOT print stays null, never 0 (an explicitly printed 0 is 0). Consequences, the same for every client:
//   - the cache split is unknown when the cache count is missing: cacheRead null, and for a client whose printed input INCLUDES the cache (codex, vibe, agy)
//     the fresh input is unknown too (input null);
//   - mimo prints reasoning apart from output: without a printed reasoning count the whole output is unknown (output null, reasoning null);
//   - summed over several events, one missing count makes the sum null;
//   - total (the rule): the total the client prints; else the sum of the client's printed counts when they cover every token class of that client (codex
//     json input_tokens + output_tokens, vibe inputTokens + outputTokens, the agent's tokens_in + tokens_out, claude's four usage fields when all four are
//     printed); else null.
// Guard (review finding): an incomplete, truncated or corrupted usage record is never skipped in favour of the rest: the vibe store gives numbers only from
// a complete final cumulative snapshot (in order), and a broken step_finish, turn.completed, last AGENT_RESULT or mimocode.db assistant message makes the
// whole usage unknown (tokens null with the reason).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decode, parseJsonUnique } = require('../../lib/text-safe.cjs');

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MIMO_SESSION = /^ses_[A-Za-z0-9]{8,40}$/;
const MAX_TOKENS = Number.MAX_SAFE_INTEGER;

const nat = v => (Number.isSafeInteger(v) && v >= 0 ? v : null);
const add = (a, b) => (a === null || b === null ? null : a + b);
// a counter that may be missing: undefined or null -> MISSING (stays null), a printed value must be a count, anything else -> BAD
const MISSING = Symbol('missing'); const BAD = Symbol('bad');
const opt = v => (v === undefined || v === null ? MISSING : nat(v) === null ? BAD : v);
const val = v => (v === MISSING ? null : v);
const sumOpt = (a, b) => (a === null || b === MISSING ? null : a + b);
// Guard (sibling hunt): a cached count larger than the input count it is part of is no split (was clamped to the input): both stay null
const cachedPart = (input, cached) => (cached === null || cached === undefined || cached === MISSING || cached > input ? null : cached);
const round9 = x => Math.round(x * 1e9) / 1e9;

// `needle` (optional): only lines holding this text are parsed, so a run with megabytes of tool output costs one scan, not one parse per line
function jsonLines(text, needle) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line[0] !== '{') continue;
    if (needle && !line.includes(needle)) continue;
    try { const j = JSON.parse(line); if (j && typeof j === 'object') out.push(j); } catch { /* not a JSON line */ }
  }
  return out;
}

// Guard (review finding: an incomplete or corrupted usage record was skipped and the rest presented as the known total): the event lines that hold
// `needle`, plus the number of such lines that start like JSON but do not parse (a truncated or corrupted event). A caller that finds broken lines gives
// tokens null with the reason, never the sum of the readable rest.
function eventLines(text, needle) {
  const rows = []; let broken = 0;
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (line[0] !== '{' || !line.includes(needle)) continue;
    try { const j = JSON.parse(line); if (j && typeof j === 'object') rows.push(j); else broken++; } catch { broken++; }
  }
  return { rows, broken };
}

function result(fields) {
  return { tokens: null, clientCostUsd: null, clientCostBasis: null, sessionId: null, model: null, stopReason: null, reason: null, ...fields };
}
const none = reason => result({ reason });

function tokensOf(parts, source, note) {
  const t = { input: parts.input, output: parts.output, cacheRead: parts.cacheRead, cacheWrite: parts.cacheWrite };
  // Guard: a reasoning or total count the client can print but did not is written as null (the key is kept), never left out as if it were 0
  if (parts.reasoning !== undefined) t.reasoning = parts.reasoning;
  if (parts.total !== undefined) t.total = parts.total;
  t.source = source;
  if (note) t.note = note;
  return t;
}

// ---- mimo: step_finish events of `mimo run --format json` ----
// One mimo token object -> its counts (input and output must be printed; reasoning, cache read, cache write and total may be missing: MISSING) or null (bad).
function mimoRow(k) {
  const c = k.cache && typeof k.cache === 'object' ? k.cache : {};
  const row = { input: nat(k.input), output: nat(k.output), reasoning: opt(k.reasoning), read: opt(c.read), write: opt(c.write), total: opt(k.total) };
  return row.input === null || row.output === null || [row.reasoning, row.read, row.write, row.total].includes(BAD) ? null : row;
}
// The sum over several mimo token objects. Output is printed apart from reasoning: output = output + reasoning, unknown when reasoning was not printed.
function mimoSum() {
  const s = { input: 0, outputOnly: 0, reasoning: 0, read: 0, write: 0, total: 0 };
  return {
    add(row) { s.input += row.input; s.outputOnly += row.output; s.reasoning = sumOpt(s.reasoning, row.reasoning); s.read = sumOpt(s.read, row.read); s.write = sumOpt(s.write, row.write); s.total = sumOpt(s.total, row.total); },
    parts() { return { input: s.input, output: s.reasoning === null ? null : s.outputOnly + s.reasoning, cacheRead: s.read, cacheWrite: s.write, reasoning: s.reasoning, total: s.total }; },
    missing() { return ['reasoning', 'read', 'write', 'total'].filter(k => s[k] === null).map(k => ({ read: 'cache read', write: 'cache write' }[k] || k)); },
  };
}
const mimoNote = (head, sum) => `${head}; reasoning folded into output${sum.missing().length ? `; not printed (null): ${sum.missing().join(', ')}${sum.missing().includes('reasoning') ? ' (so the whole output is unknown)' : ''}` : ''}`;
function fromMimoJson(text) {
  const lines = eventLines(text, 'step_finish');
  const steps = lines.rows.filter(e => e.type === 'step_finish');
  const events = steps.filter(e => e.part && e.part.tokens && typeof e.part.tokens === 'object');
  // Guard (sibling of review finding): a step_finish line that does not parse, or a step_finish without tokens, makes the run's usage unknown
  if (lines.broken) return none(`${lines.broken} step_finish line(s) are not readable JSON (truncated or corrupted); the usage of the run is unknown`);
  if (events.length < steps.length) return none(`${steps.length - events.length} step_finish event(s) carry no tokens; the usage of the run is unknown`);
  if (!events.length) return none('no step_finish event with tokens in the output');
  const sum = mimoSum(); let cost = 0; let costSeen = false;
  let sessionId = null;
  for (const e of events) {
    const row = mimoRow(e.part.tokens);
    if (!row) return none('a step_finish event carries a token field that is not a non-negative integer');
    sum.add(row);
    if (typeof e.part.cost === 'number' && Number.isFinite(e.part.cost) && e.part.cost >= 0) { cost += e.part.cost; costSeen = true; }
    sessionId = sessionId || (typeof e.sessionID === 'string' && MIMO_SESSION.test(e.sessionID) ? e.sessionID : null);
  }
  return result({
    tokens: tokensOf(sum.parts(), 'mimo-json', mimoNote(`${events.length} step_finish events`, sum)),
    clientCostUsd: costSeen ? round9(cost) : null, clientCostBasis: costSeen ? 'client' : null, sessionId,
  });
}

// ---- mimocode.db: assistant messages of one or more sessions (the backfill source) ----
// Guard (review finding: a corrupted assistant message was skipped and the rest presented as the whole session): a message whose data is not JSON, an
// assistant message without tokens and one whose tokens are not counts make the session's usage unknown: { unknown: reason }.
function sumMimoMessages(rows) {
  const sum = mimoSum(); let cost = 0; let costSeen = false; let n = 0;
  const models = new Set();
  for (const r of rows) {
    let d; try { d = JSON.parse(r.data); } catch { return { unknown: 'a message of the session is not readable JSON (corrupted); the usage is unknown' }; }
    if (!d || d.role !== 'assistant') continue;
    if (!d.tokens || typeof d.tokens !== 'object') return { unknown: 'an assistant message of the session carries no tokens; the usage is unknown' };
    const row = mimoRow(d.tokens);
    if (!row) return { unknown: 'an assistant message carries a token field that is not a non-negative integer; the usage is unknown' };
    sum.add(row); n++;
    if (typeof d.cost === 'number' && Number.isFinite(d.cost) && d.cost >= 0) { cost += d.cost; costSeen = true; }
    if (d.modelID) models.add(d.providerID ? `${d.providerID}/${d.modelID}` : d.modelID);
  }
  if (!n) return null;
  return { tokens: tokensOf(sum.parts(), 'mimocode-db', mimoNote(`${n} assistant messages`, sum)), cost: costSeen ? round9(cost) : null, models: [...models] };
}

function defaultMimoDb(env = process.env) {
  return env.MIMOCODE_DB || path.join(os.homedir(), '.local', 'share', 'mimocode', 'mimocode.db');
}

function openDb(file) {
  const saved = process.emitWarning;
  process.emitWarning = () => {}; // node:sqlite prints an ExperimentalWarning that would end up in tool output
  try { const { DatabaseSync } = require('node:sqlite'); return new DatabaseSync(file, { readOnly: true }); } finally { process.emitWarning = saved; }
}
const normDir = d => String(d || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// by session id, or by directory + time window (a session whose directory equals the launch workdir and which started inside the window)
// `handle` (from openMimoDb) lets a caller that looks up many launches open the database once.
function fromMimoDb({ dbFile, handle, sessionId, workdir, startedAt, endedAt, slackMs = 30000 }) {
  let db = handle || null;
  try {
    if (!db) {
      if (!dbFile || !fs.existsSync(dbFile)) return none('mimocode.db not found');
      db = openDb(dbFile);
    }
    let ids = [];
    if (sessionId) {
      if (!MIMO_SESSION.test(sessionId)) return none('malformed mimo session id');
      ids = [sessionId];
    } else {
      const s = Date.parse(startedAt); const e = Date.parse(endedAt); const want = normDir(workdir);
      if (!want || Number.isNaN(s) || Number.isNaN(e)) return none('no session id and no workdir plus time window');
      const rows = db.prepare('select id, directory, parent_id from session where time_created >= ? and time_created <= ?').all(s - slackMs, e + slackMs);
      const matched = rows.filter(r => normDir(r.directory) === want);
      if (!matched.length) return none('no mimocode session with this directory inside the launch window');
      // Guard (identity sibling of review finding): the sessions of ONE launch are one root session and its child sessions (subagents, parent_id); two
      // root sessions of the directory in the window are two launches, and their sum would be nobody's usage: ambiguous, never summed
      const inSet = new Set(matched.map(r => r.id));
      const roots = matched.filter(r => !r.parent_id || !inSet.has(r.parent_id));
      if (roots.length > 1) return none(`ambiguous sessions: ${roots.length} root mimocode sessions of this directory inside the launch window; not summed`);
      ids = matched.map(r => r.id);
    }
    const q = db.prepare('select data from message where session_id = ?');
    const rows = ids.flatMap(id => q.all(id));
    const sum = sumMimoMessages(rows);
    if (sum && sum.unknown) return none(sum.unknown);
    if (!sum) return none('the session has no assistant message with tokens');
    return result({ tokens: sum.tokens, clientCostUsd: sum.cost, clientCostBasis: sum.cost === null ? null : 'client', sessionId: ids.length === 1 ? ids[0] : null, model: sum.models.length === 1 ? sum.models[0] : null });
  } catch (e) { return none(`mimocode.db unreadable: ${e.code || e.message}`); } finally { try { if (db && !handle) db.close(); } catch { /* closed */ } }
}
function openMimoDb(file) {
  try { return fs.existsSync(file) ? openDb(file) : null; } catch { return null; }
}

// ---- vibe: streaming output carries the session id; the usage is in the client's session store ----
// Guard (identity sibling): the usage of ONE session; an output that prints two different session ids gives no id (not the first one)
function vibeSessionIdFrom(text) {
  const ids = new Set();
  for (const j of jsonLines(text, 'sessionId')) if (typeof j.sessionId === 'string' && SESSION_ID.test(j.sessionId)) ids.add(j.sessionId);
  return ids.size === 1 ? [...ids][0] : null;
}
function defaultVibeDir(env = process.env) {
  return env.VIBE_SESSION_DIR || path.join(os.homedir(), '.vibe', 'logs', 'session', 'unified');
}
function readVibeSession(sessionId, opts = {}) {
  if (!SESSION_ID.test(String(sessionId || ''))) return none('malformed vibe session id');
  const dir = path.join(opts.sessionsDir || defaultVibeDir(opts.env), sessionId);
  let files;
  try { files = fs.readdirSync(path.join(dir, 'journal')).filter(n => n.endsWith('.jsonl')).sort(); } catch { return none('vibe session store not found'); }
  // Guard (review finding: the last snapshot lacked outputTokens and the OLDER complete snapshot's total was presented as known): only a complete FINAL
  // snapshot gives numbers. The snapshots are the session tokenUsage objects in journal order; the final one must hold inputTokens and outputTokens as counts
  // (cachedInputTokens a count or missing), and no snapshot may be smaller than one before it (the counts are cumulative). A usage line that does not parse
  // (a truncated or corrupted line), an unreadable journal file, a truncated last line of the journal, an incomplete or out-of-order final snapshot: tokens
  // null with the reason. Without any snapshot, the per-call usages are summed only when every one of them is complete. A BOM and CRLF are tolerated.
  let snaps = 0; let final = null; let peak = null; let broken = null; let sums = { i: 0, c: 0, o: 0, n: 0, bad: 0 }; let stopReason = null; let lastLine = null;
  for (const name of files) {
    let text;
    try { text = fs.readFileSync(path.join(dir, 'journal', name), 'utf8').replace(/^\uFEFF/, ''); } catch (e) { broken = broken || `the vibe journal file ${name} cannot be read (${e.code || 'error'})`; continue; }
    for (const raw of text.split('\n')) {
      const line = raw.replace(/\r$/, '');
      if (!line.trim()) continue;
      let j = null; let parsed = true;
      try { j = JSON.parse(line); } catch { parsed = false; }
      lastLine = { name, parsed };
      const projection = line.includes('tokenUsage') || line.includes('"stopReason"');
      const call = line.includes('"usage"') && line.includes('action_result');
      if (!projection && !call) continue;
      if (!parsed || !j || typeof j !== 'object') { broken = broken || `a usage line of the vibe journal ${name} is not readable JSON (truncated or corrupted)`; continue; }
      const p = j.payload || {};
      if (call && j.type === 'action_result' && p.result && p.result.result && p.result.result.usage) {
        const u = p.result.result.usage;
        // Guard: a missing (or malformed) cached count is unknown, never 0; one unknown makes the sum unknown
        if (nat(u.input_tokens) !== null && nat(u.output_tokens) !== null && opt(u.cached_input_tokens) !== BAD) { sums.i += u.input_tokens; sums.c = sums.c === null || nat(u.cached_input_tokens) === null ? null : sums.c + u.cached_input_tokens; sums.o += u.output_tokens; sums.n++; } else sums.bad++;
      }
      for (const d of (Array.isArray(p.delta) ? p.delta : [])) {
        const s = d && d.state && d.state.session; const turn = d && d.state && d.state.latestTurn;
        // a null tokenUsage (an envelope that carries no cumulative state) is no snapshot; any other value is one
        if (s && s.tokenUsage !== undefined && s.tokenUsage !== null) {
          const u = s.tokenUsage && typeof s.tokenUsage === 'object' ? s.tokenUsage : {};
          snaps++;
          const complete = nat(u.inputTokens) !== null && nat(u.outputTokens) !== null && opt(u.cachedInputTokens) !== BAD;
          final = complete ? { i: u.inputTokens, c: nat(u.cachedInputTokens), o: u.outputTokens } : { incomplete: true };
          if (complete) {
            if (peak && (final.i < peak.i || final.o < peak.o)) broken = broken || 'the vibe tokenUsage snapshots are out of order (a later cumulative snapshot is smaller than an earlier one)';
            peak = peak ? { i: Math.max(peak.i, final.i), o: Math.max(peak.o, final.o) } : { i: final.i, o: final.o };
          }
        }
        if (turn && typeof turn.stopReason === 'string') stopReason = turn.stopReason;
      }
    }
  }
  if (lastLine && !lastLine.parsed && lastLine.name === files[files.length - 1]) broken = broken || `the last line of the vibe journal ${lastLine.name} is truncated (not JSON); a final usage snapshot may be lost`;
  if (!broken && final && final.incomplete) broken = 'the final vibe tokenUsage snapshot is incomplete (inputTokens or outputTokens missing or not a count); the older snapshots are not the usage of the run';
  if (!broken && !snaps && sums.bad) broken = `${sums.bad} completion usage(s) of the vibe journal are incomplete; the sum of the others is not the usage of the run`;
  const cumulative = snaps ? final : null;
  const use = broken ? null : cumulative || (sums.n ? { i: sums.i, c: sums.c, o: sums.o } : null);
  let model = null;
  try {
    const gens = fs.readdirSync(path.join(dir, 'generations')).sort();
    for (let k = gens.length - 1; k >= 0 && !model; k--) {
      const rs = JSON.parse(fs.readFileSync(path.join(dir, 'generations', gens[k], 'runtime-state.json'), 'utf8'));
      if (rs && rs.session_metadata && typeof rs.session_metadata.active_model === 'string') model = rs.session_metadata.active_model;
    }
  } catch { /* the model stays unknown */ }
  if (!use) return result({ sessionId, model, stopReason, reason: broken || 'vibe session store holds no token usage' });
  // inputTokens includes the cached ones: without a printed cached count the fresh input is unknown as well (the total stays: input + output cover all)
  const cached = cachedPart(use.i, use.c);
  return result({
    tokens: tokensOf({ input: cached === null ? null : use.i - cached, output: use.o, cacheRead: cached, cacheWrite: null, total: use.i + use.o }, 'vibe-session-store', `${cumulative ? 'session cumulative tokenUsage' : `sum of ${sums.n} completion usages`}; input includes cached${use.c === null ? '; the cached count was not printed, so the fresh input is unknown' : cached === null ? '; the cached count is larger than the input count, so there is no split' : ''}`),
    sessionId, model, stopReason,
  });
}
function vibeMeta(sessionId, opts = {}) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(opts.sessionsDir || defaultVibeDir(opts.env), sessionId, 'meta.json'), 'utf8'));
    return { startTime: m.start_time || null, endTime: m.end_time || null, workdir: (m.environment && m.environment.working_directory) || m.origin_directory || null };
  } catch { return null; }
}
function listVibeSessions(opts = {}) {
  const base = opts.sessionsDir || defaultVibeDir(opts.env);
  let names = [];
  try { names = fs.readdirSync(base).filter(n => SESSION_ID.test(n)); } catch { return []; }
  const out = [];
  for (const id of names) { const m = vibeMeta(id, opts); if (m) out.push({ id, ...m }); }
  return out;
}
function fromVibeByWindow({ workdir, startedAt, endedAt, slackMs = 30000, ...opts }) {
  const want = normDir(workdir); const s = Date.parse(startedAt); const e = Date.parse(endedAt);
  if (!want || Number.isNaN(s) || Number.isNaN(e)) return none('no workdir plus time window');
  const hits = listVibeSessions(opts).filter(m => normDir(m.workdir) === want && Date.parse(m.startTime) >= s - slackMs && Date.parse(m.startTime) <= e + slackMs);
  if (!hits.length) return none('no vibe session with this directory inside the launch window');
  if (hits.length > 1) return none(`${hits.length} vibe sessions match the directory and window; not guessing`);
  return readVibeSession(hits[0].id, opts);
}

// ---- codex ----
function fromCodexOutput(text) {
  const lines = eventLines(text, 'turn.completed');
  const completed = lines.rows.filter(j => j.type === 'turn.completed');
  const turns = completed.filter(j => j.usage && typeof j.usage === 'object');
  // Guard (sibling of review finding): a turn.completed line that does not parse, or one without usage, makes the run's usage unknown
  if (lines.broken) return none(`${lines.broken} turn.completed line(s) are not readable JSON (truncated or corrupted); the usage of the run is unknown`);
  if (turns.length < completed.length) return none(`${completed.length - turns.length} turn.completed event(s) carry no usage; the usage of the run is unknown`);
  if (turns.length) {
    let input = 0; let cached = 0; let write = 0; let output = 0; let reasoning = 0;
    for (const t of turns) {
      const u = t.usage;
      const row = [nat(u.input_tokens), opt(u.cached_input_tokens), opt(u.cache_write_input_tokens), nat(u.output_tokens), opt(u.reasoning_output_tokens)];
      if (row[0] === null || row[3] === null || row.includes(BAD)) return none('turn.completed carries a token field that is not a non-negative integer');
      input += row[0]; cached = sumOpt(cached, row[1]); write = sumOpt(write, row[2]); output += row[3]; reasoning = sumOpt(reasoning, row[4]);
    }
    // input_tokens includes the cached ones: without a printed cached count the fresh input is unknown (the total input + output stays)
    const c = cachedPart(input, cached);
    const missing = [cached === null ? 'cached_input_tokens' : c === null ? 'a split (cached_input_tokens larger than input_tokens)' : '', write === null ? 'cache_write_input_tokens' : '', reasoning === null ? 'reasoning_output_tokens' : ''].filter(Boolean);
    const th = jsonLines(text, 'thread.started').find(j => j.type === 'thread.started' && typeof j.thread_id === 'string');
    return result({ tokens: tokensOf({ input: c === null ? null : input - c, output, cacheRead: c, cacheWrite: write, reasoning, total: input + output }, 'codex-json', `${turns.length} turn.completed events; input includes cached; reasoning is part of output${missing.length ? `; not printed (null): ${missing.join(', ')}` : ''}`), sessionId: th ? th.thread_id : null });
  }
  // Guard (sibling hunt): the banner is the client's LAST lines; a "tokens used" pair inside the answer or a tool output before it is not the banner
  const all = [...String(text || '').matchAll(/^tokens used\s*\r?\n\s*([\d][\d\s\u00A0\u202F.,_]*)\s*$/gm)];
  const m = all.length ? all[all.length - 1] : null;
  if (m) {
    const total = Number(m[1].replace(/[\s\u00A0\u202F.,_]/g, ''));
    if (Number.isSafeInteger(total) && total >= 0 && total <= MAX_TOKENS) {
      const sid = /^session id:\s*([0-9a-f-]{36})\s*$/m.exec(String(text));
      return result({ tokens: tokensOf({ input: null, output: null, cacheRead: null, cacheWrite: null, total }, 'codex-banner', 'the text banner states one total only; no split into input and output'), sessionId: sid ? sid[1] : null });
    }
  }
  return none('no turn.completed usage and no "tokens used" banner');
}

// ---- claude -p --output-format json ----
function parseWhole(text) {
  // A result format is ONE complete object. Earlier neighbours, duplicate keys,
  // or a readable line preceding a truncated result are never this launch's total.
  const decoded = decode(Buffer.from(String(text || ''), 'utf8'), { bom: 'refuse', crlf: 'normalise', invisible: 'refuse' });
  if (!decoded.ok) return null;
  try {
    const j = parseJsonUnique(decoded.text);
    return j && typeof j === 'object' && !Array.isArray(j) ? j : null;
  } catch { return null; }
}
function fromClaudeJson(text) {
  const j = parseWhole(text);
  if (!j || j.type !== 'result' || !j.usage || typeof j.usage !== 'object') return none('no claude result object with usage');
  const u = j.usage;
  const row = [nat(u.input_tokens), nat(u.output_tokens), opt(u.cache_read_input_tokens), opt(u.cache_creation_input_tokens)];
  if (row[0] === null || row[1] === null || row.includes(BAD)) return none('usage carries a token field that is not a non-negative integer');
  // claude's input_tokens excludes the cache: a missing cache count leaves input as printed, the cache count null and the total null (not all four printed)
  const [cr, cw] = [val(row[2]), val(row[3])];
  const missing = [cr === null ? 'cache_read_input_tokens' : '', cw === null ? 'cache_creation_input_tokens' : ''].filter(Boolean);
  if (!missing.length && !Number.isSafeInteger(row[0] + row[1] + cr + cw)) return none('usage counters exceed the safe integer total');
  const models = j.modelUsage && typeof j.modelUsage === 'object' ? Object.keys(j.modelUsage) : [];
  const model = models.length === 1 ? models[0] : null;
  const bases = new Set(models.map(k => j.modelUsage[k] && j.modelUsage[k].costBasis).filter(Boolean));
  const cost = typeof j.total_cost_usd === 'number' && Number.isFinite(j.total_cost_usd) && j.total_cost_usd >= 0 ? round9(j.total_cost_usd) : null;
  return result({
    tokens: tokensOf({ input: row[0], output: row[1], cacheRead: cr, cacheWrite: cw, total: missing.length ? null : row[0] + row[1] + cr + cw }, 'claude-json', `${models.length} model(s) in modelUsage${missing.length ? `; not printed (null): ${missing.join(', ')}` : ''}`),
    clientCostUsd: cost, clientCostBasis: cost === null ? null : (bases.size === 1 ? [...bases][0] : 'client'),
    sessionId: typeof j.session_id === 'string' ? j.session_id : null, model, stopReason: typeof j.terminal_reason === 'string' ? j.terminal_reason : null,
    resultText: typeof j.result === 'string' ? j.result : null, isError: j.is_error === true,
  });
}

// ---- agy -p --output-format json ----
function fromAgyJson(text) {
  const j = parseWhole(text);
  if (!j || !j.usage || typeof j.usage !== 'object') return none('no agy json object with usage (the text output format prints none)');
  const u = j.usage;
  const row = [nat(u.input_tokens), nat(u.output_tokens), opt(u.cache_read_tokens), opt(u.thinking_tokens), opt(u.total_tokens)];
  if (row[0] === null || row[1] === null || row.includes(BAD)) return none('usage carries a token field that is not a non-negative integer');
  // input is assumed to include cache_read: without a printed cache_read the fresh input is unknown too
  const cached = cachedPart(row[0], row[2]);
  const missing = [row[2] === MISSING ? 'cache_read_tokens' : cached === null ? 'a split (cache_read_tokens larger than input_tokens)' : '', row[3] === MISSING ? 'thinking_tokens' : '', row[4] === MISSING ? 'total_tokens' : ''].filter(Boolean);
  return result({
    tokens: tokensOf({ input: cached === null ? null : row[0] - cached, output: row[1], cacheRead: cached, cacheWrite: null, reasoning: val(row[3]), total: val(row[4]) }, 'agy-json', `input assumed to include cache_read (Gemini convention; the measured sample had cache_read 0); thinking is part of output${missing.length ? `; not printed (null): ${missing.join(', ')}` : ''}`),
    sessionId: typeof j.conversation_id === 'string' ? j.conversation_id : null, resultText: typeof j.response === 'string' ? j.response : null, isError: j.status !== undefined && j.status !== 'SUCCESS',
  });
}

// ---- openai-compat agent (dahl) ----
// Guard (sibling of review finding): the LAST AGENT_RESULT line decides; when it does not parse (truncated), the usage is unknown, never an earlier line's
function fromAgentResult(text) {
  const lines = String(text || '').split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^AGENT_RESULT\s+(.*?)\s*$/.exec(lines[i]);
    if (!m) continue;
    try {
      const j = JSON.parse(m[1]);
      if (!j || typeof j !== 'object') return none('the last AGENT_RESULT line is not a JSON object; the usage is unknown');
      const a = nat(j.tokens_in); const b = nat(j.tokens_out);
      if (a === null || b === null) return none('AGENT_RESULT carries no tokens_in / tokens_out');
      return result({ tokens: tokensOf({ input: a, output: b, cacheRead: null, cacheWrite: null, total: a + b }, 'agent-result', 'tokens_in is the sum of the prompt tokens of every step; the agent reports no cached split'), model: typeof j.model === 'string' ? j.model : null, stopReason: typeof j.stop === 'string' ? j.stop : null });
    } catch { return none('the last AGENT_RESULT line is not readable JSON (truncated or corrupted); the usage is unknown'); }
  }
  return none('no AGENT_RESULT line');
}

// One entry point for the launchers. Never throws; `tokens` is null when the client did not say.
function extractUsage(client, text, opts = {}) {
  const c = String(client || '').toLowerCase();
  try {
    if (c === 'mimo') return fromMimoJson(text);
    if (c === 'vibe') {
      const id = vibeSessionIdFrom(text);
      return id ? readVibeSession(id, opts) : none('no single sessionId in the vibe output (none, or several different ones)');
    }
    if (c === 'codex') return fromCodexOutput(text);
    if (c === 'claude') return fromClaudeJson(text);
    if (c === 'agy') return fromAgyJson(text);
    if (c === 'dahl' || c === 'openai-compat') return fromAgentResult(text);
    return none(`no usage source for client ${c || '(none)'}`);
  } catch (e) { return none(`usage extraction failed: ${e.message}`); }
}

module.exports = { extractUsage, fromMimoJson, fromMimoDb, openMimoDb, sumMimoMessages, defaultMimoDb, vibeSessionIdFrom, readVibeSession, fromVibeByWindow, listVibeSessions, vibeMeta, defaultVibeDir, fromCodexOutput, fromClaudeJson, fromAgyJson, fromAgentResult, jsonLines, normDir, SESSION_ID, MIMO_SESSION };

'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SOURCES = ['agent-result', 'client-banner', 'client-log', 'none'];
const CONFIDENCE = ['exact', 'derived', 'none'];
const LOG_NAME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z-.*\.log$/;
const HEAD_BYTES = 65536;
const WINDOW_SLACK_MS = 15000;

function defaultLogDir(env = process.env) {
  if (env.MIMOCODE_LOG_DIR) return env.MIMOCODE_LOG_DIR;
  return path.join(os.homedir(), '.local', 'share', 'mimocode', 'log');
}

// ---- vibe: names and aliases ----
// ~/.vibe/config.toml lists models by ALIAS (the value VIBE_ACTIVE_MODEL must hold) and by provider NAME. The table below is the measured one
// (config of 2026-10-10; clients.json lists only names, so it cannot give the alias). A caller with another config passes input.vibeModels
// ([{ name, alias }]); an entry given there wins. vibe-default is the model vibe falls back to when VIBE_ACTIVE_MODEL names nothing it knows.
const VIBE_MODELS = [
  { name: 'zai-glm-5-3', alias: 'glm-5-3' },
  { name: 'mistral-large-2512', alias: 'mistral-large' },
  { name: 'mistral-medium-3.5', alias: 'mistral-medium-3.5' },
  { name: 'mistral-large-4-0-3', alias: 'mistral-large-4-0-3' },
];
const lower = v => String(v || '').trim().toLowerCase();
// { known, alias, kind: 'alias'|'name'|null }: an alias stays as is, a known name is translated, anything else is not known (alias is then the input).
function vibeAlias(value, models) {
  const v = lower(value);
  const table = [...(Array.isArray(models) ? models : []), ...VIBE_MODELS].filter(m => m && m.name && m.alias);
  if (!v) return { known: false, alias: '', kind: null };
  const byAlias = table.find(m => lower(m.alias) === v);
  if (byAlias) return { known: true, alias: byAlias.alias, kind: 'alias' };
  const byName = table.find(m => lower(m.name) === v);
  if (byName) return { known: true, alias: byName.alias, kind: 'name' };
  return { known: false, alias: String(value).trim(), kind: null };
}

function norm(model) {
  return String(model || '').trim().toLowerCase().replace(/^openrouter\//, '');
}

// true when the two ids name the same model, allowing one to carry a provider prefix the other lacks
// (requested "openrouter/xiaomi/mimo-v2.6-flash", logged "xiaomi/mimo-v2.6-flash"). Anything else is false.
function modelsMatch(requested, served) {
  const a = norm(requested); const b = norm(served);
  if (!a || !b) return 'unknown';
  if (a === b) return true;
  if (a.endsWith(`/${b}`) || b.endsWith(`/${a}`)) return true;
  return false;
}

function fromAgentResult(text) {
  const lines = String(text || '').split(/\r?\n/);
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^AGENT_RESULT(?:\s+(.*?))?\s*$/.exec(lines[i]);
    if (!m) continue;
    let j = null; try { j = JSON.parse(m[1]); } catch { /* not JSON */ }
    found.push({ line: i + 1, model: j && typeof j.model === 'string' && j.model.trim() && j.model === j.model.trim() ? j.model : null, ok: Boolean(j && typeof j === 'object' && !Array.isArray(j)) });
  }
  if (!found.length) return null;
  if (!found[found.length - 1].ok) return { model: null, reason: 'unreadable agent result', detail: `the last AGENT_RESULT line (line ${found[found.length - 1].line}) is not JSON; no proof` };
  if (found.some(f => !f.ok || !f.model)) return { model: null, reason: 'unknown agent result', detail: 'every AGENT_RESULT must name a nonempty model; no proof' };
  const models = [...new Set(found.map(f => f.model).filter(Boolean))];
  if (models.length > 1) return { model: null, reason: 'conflicting headers', detail: `AGENT_RESULT lines name ${models.join(', ')}; no proof` };
  if (!models.length) return null;
  return { model: models[0], detail: `AGENT_RESULT line ${found.filter(f => f.model).at(-1).line}` };
}

function fromMimoBanner(text) {
  const models = [...String(text || '').matchAll(/^\s*>?\s*build\s*(?:\u00b7|\u00c2\u00b7|\?)\s*(\S+)\s*$/gm)].map(m => m[1]);
  if (!models.length) return null;
  const distinct = [...new Set(models)];
  if (distinct.length > 1) return { model: null, reason: 'ambiguous banners', detail: `the output holds build banners of ${distinct.join(', ')}; no proof` };
  return { model: models[0], detail: `banner "build · <model>"${models.length > 1 ? ` (${models.length} banners, all the same)` : ''}` };
}

const SEPARATOR = /^-{4,}\s*$/;
function fromCodexHeader(text) {
  const lines = String(text || '').split(/\r?\n/);
  const models = []; let blocks = 0;
  for (let head = 0; head < lines.length; head++) {
    if (!/^OpenAI Codex\b/.test(lines[head]) || !SEPARATOR.test(lines[head + 1] || '')) continue;
    blocks++;
    const beforeModels = models.length;
    let i = head + 2;
    for (; i < lines.length && i < head + 30 && !SEPARATOR.test(lines[i]); i++) {
      const m = /^model:\s*(\S+)\s*$/.exec(lines[i]);
      if (m) models.push({ model: m[1], line: i + 1 });
    }
    if (!SEPARATOR.test(lines[i] || '')) return { model: null, reason: 'unclosed header', detail: `the codex header block at line ${head + 1} has no closing separator line; no proof` };
    if (models.length === beforeModels) return { model: null, reason: 'unknown header', detail: 'every codex header block must name a model; no proof' };
    head = i;
  }
  if (!models.length) return null;
  const distinct = [...new Set(models.map(m => m.model))];
  if (distinct.length > 1) return { model: null, reason: 'conflicting headers', detail: `the output holds codex header model lines of ${distinct.join(', ')} (${blocks} header block(s)); no proof` };
  return { model: distinct[0], detail: `header line ${models[0].line}${models.length > 1 ? ` (${models.length} model lines in ${blocks} header block(s), all the same)` : ''}` };
}

function logStart(name) {
  const m = LOG_NAME.exec(name);
  if (!m) return null;
  return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]);
}

function readHead(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(HEAD_BYTES);
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0);
    return buf.subarray(0, n).toString('utf8');
  } catch { return ''; } finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}

// Only an llm line with agent=build and mode=primary proves the executor's model; title and subagent lines never do.
// -> [{ model, session }] of every such line (session = its session.id, or null)
function primaryLines(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('service=llm')) continue;
    if (!/\bagent=build\b/.test(line) || !/\bmode=primary\b/.test(line)) continue;
    const prov = /\bproviderID=(\S+)/.exec(line); const mod = /\bmodelID=(\S+)/.exec(line); const ses = /\bsession\.id=(ses_[A-Za-z0-9]+)/.exec(line);
    out.push({ model: mod ? (prov ? `${prov[1]}/${mod[1]}` : mod[1]) : null, session: ses ? ses[1] : null });
  }
  return out;
}
function modelFromLog(file) {
  const first = primaryLines(file)[0];
  return first ? first.model : null;
}
// The mimo session ids the client printed in its json output ("sessionID":"ses_..."), in order of appearance.
function mimoSessionIdsInOutput(text) {
  const ids = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (line[0] !== '{' || !line.includes('sessionID')) continue;
    try { const j = JSON.parse(line); if (j && typeof j.sessionID === 'string' && /^ses_[A-Za-z0-9]{8,40}$/.test(j.sessionID) && !ids.includes(j.sessionID)) ids.push(j.sessionID); } catch { /* not an event line */ }
  }
  return ids;
}

// Slashes, case and a trailing slash are not a difference between two directory names; nothing else is ignored.
function normDir(dir) {
  return String(dir || '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

// The directory the client logged for its instance: the parsed field of its "service=server-proxy directory=<dir>" line.
function dirFromLog(head) {
  for (const line of String(head || '').split(/\r?\n/)) {
    const m = /\bservice=server-proxy\b.*?\bdirectory=(.+?)(?:\s+creating instance)?\s*$/.exec(line);
    if (m) return m[1];
  }
  return null;
}

function fromMimoLog({ startedAt, endedAt, logDir, workdir, capturedOutput }) {
  const s = Date.parse(startedAt); const e = Date.parse(endedAt);
  if (!logDir || !workdir || Number.isNaN(s) || Number.isNaN(e)) return null;
  const want = normDir(workdir);
  if (!want) return null;
  let names;
  try { names = fs.readdirSync(logDir); } catch { return null; }
  const candidates = names.map(n => ({ name: n, start: logStart(n) })).filter(c => c.start !== null && c.start >= s - WINDOW_SLACK_MS && c.start <= e).sort((a, b) => a.name.localeCompare(b.name));
  const printed = mimoSessionIdsInOutput(capturedOutput);
  const hits = [];
  for (const c of candidates) {
    const file = path.join(logDir, c.name);
    const dir = dirFromLog(readHead(file));
    if (dir === null || normDir(dir) !== want) continue;
    for (const l of primaryLines(file)) if (!printed.length || printed.includes(l.session)) hits.push({ ...l, log: c.name });
  }
  if (!hits.length) return printed.length && candidates.length ? { model: null, reason: 'printed session not proven', detail: `no primary build line of the printed mimo session(s) ${printed.join(', ')} in a log of this directory and window; no proof` } : null;
  const models = [...new Set(hits.map(h => h.model))];
  const logs = [...new Set(hits.map(h => h.log))];
  const how = printed.length ? `session ${printed.join(', ')} printed by the client` : 'directory and launch window';
  if (models.length === 1) return { model: models[0], detail: `log ${logs.join(', ')} (${how})` };
  return { model: null, reason: 'ambiguous sessions', detail: `ambiguous sessions: mimo logs ${logs.join(', ')} (${how}) name ${models.join(', ')}; no proof` };
}

// ---- vibe: the unified session store ----
const SESSION_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function defaultVibeSessionRoot(env = process.env) {
  if (env.VIBE_SESSION_ROOT) return env.VIBE_SESSION_ROOT;
  if (env.VIBE_SESSION_DIR) return env.VIBE_SESSION_DIR;
  return path.join(os.homedir(), '.vibe', 'logs', 'session', 'unified');
}

const UNREADABLE = '\u0000unreadable';
const textSafe = require('../../.ai/bin/lib/text-safe.cjs');
const pathSafe = require('../../.ai/bin/lib/path-safe.cjs');
function guardedSessionJson(file) {
  const g = pathSafe.realInside(path.parse(path.resolve(file)).root, path.resolve(file), { refuseHardlinks: true });
  if (!g.ok) throw new Error('session path refused');
  const d = textSafe.decode(fs.readFileSync(g.real), { bom: 'strip', crlf: 'normalise', invisible: 'refuse' });
  if (!d.ok) throw new Error('session text refused');
  return JSON.parse(d.text);
}
function vibeActiveModels(sessionDir) {
  const values = new Set();
  let gens = [];
  try { gens = fs.readdirSync(path.join(sessionDir, 'generations')); } catch { return values; }
  for (const g of gens) {
    const file = path.join(sessionDir, 'generations', g, 'runtime-state.json');
    try {
      const j = guardedSessionJson(file);
      const m = j && j.session_metadata && j.session_metadata.active_model;
      if (typeof m === 'string' && m.trim() && m === m.trim()) values.add(m);
      else values.add(UNREADABLE);
    } catch { values.add(UNREADABLE); }
  }
  return values;
}

// The session ids the client printed in its own output (vibe -p --output streaming: every message line carries "sessionId"), in order of appearance.
function vibeSessionIdsInOutput(text) {
  const ids = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.replace(/^\uFEFF/, '').trim();
    if (line[0] !== '{') continue;
    try { const j = JSON.parse(line); if (j && typeof j.sessionId === 'string' && SESSION_NAME.test(j.sessionId) && !ids.includes(j.sessionId)) ids.push(j.sessionId); } catch { /* not a message line */ }
  }
  return ids;
}
// meta.json of one session folder -> { start, end (NaN while the session runs), dir } or null
function vibeMeta(sessionRoot, name) {
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(sessionRoot, name, 'meta.json'), 'utf8'));
    return { start: Date.parse(meta && meta.start_time), end: Date.parse(meta && meta.end_time), dir: meta && meta.environment && meta.environment.working_directory };
  } catch { return null; }
}
function fromVibeSession({ startedAt, endedAt, sessionRoot, workdir, capturedOutput }) {
  const s = Date.parse(startedAt); const e = Date.parse(endedAt);
  if (!sessionRoot || !workdir || Number.isNaN(s) || Number.isNaN(e)) return null;
  const want = normDir(workdir);
  if (!want) return null;
  const ofDir = m => m && !Number.isNaN(m.start) && normDir(m.dir) === want;
  const overlaps = m => ofDir(m) && m.start <= e && (Number.isNaN(m.end) || m.end >= s - WINDOW_SLACK_MS);
  const startsIn = m => ofDir(m) && m.start >= s - WINDOW_SLACK_MS && m.start <= e;
  const printed = vibeSessionIdsInOutput(capturedOutput);
  let candidates = [];
  if (printed.length) {
    for (const name of printed) {
      if (!startsIn(vibeMeta(sessionRoot, name))) return { model: null, reason: 'printed session not proven', detail: `vibe session ${name} printed by the client is not in the store, or not of this directory and launch window; no proof` };
      candidates.push(name);
    }
  } else {
    let names;
    try { names = fs.readdirSync(sessionRoot).filter(n => SESSION_NAME.test(n)); } catch { return null; }
    const metas = new Map(names.map(n => [n, vibeMeta(sessionRoot, n)]));
    if (![...metas.values()].some(startsIn)) return null;
    candidates = names.filter(n => overlaps(metas.get(n))).sort();
  }
  if (!candidates.length) return null;
  const how = printed.length ? 'printed by the client' : 'directory and launch window';
  const models = new Map();
  for (const name of candidates) {
    const values = vibeActiveModels(path.join(sessionRoot, name));
    if (values.has(UNREADABLE)) return { model: null, reason: 'unreadable generation', detail: `vibe session ${name} has a runtime-state.json that cannot be read; no proof` };
    if (values.size > 1) return { model: null, reason: 'conflicting active_model values', detail: `vibe session ${name} holds conflicting active_model values (${[...values].sort().join(', ')}); no proof` };
    models.set(name, values.size ? [...values][0] : null);
  }
  const distinct = [...new Set(models.values())];
  if (distinct.length === 1 && distinct[0]) return { model: distinct[0], detail: candidates.length === 1 ? `vibe session ${candidates[0]} (${how})` : `vibe sessions ${candidates.join(', ')} (${how}; all ${distinct[0]})` };
  if (candidates.length === 1) return null;
  return { model: null, reason: 'ambiguous sessions', detail: `ambiguous sessions: ${candidates.length} vibe sessions (${how}) show ${[...models].map(([n, m]) => `${n}=${m || 'none'}`).join(', ')}; no proof` };
}

function deriveServedModel(input = {}, env = process.env) {
  const client = String(input.client || '').toLowerCase();
  const text = typeof input.capturedOutput === 'string' ? input.capturedOutput : '';
  const none = (detail, reason) => ({ servedModel: null, source: 'none', confidence: 'none', match: 'unknown', detail, ...(reason ? { reason } : {}) });
  let found = null; let source = 'none'; let confidence = 'none';
  try {
    if (client === 'dahl' || client === 'openai-compat') { found = fromAgentResult(text); source = 'agent-result'; confidence = 'exact'; }
    else if (client === 'codex') { found = fromCodexHeader(text); source = 'client-banner'; confidence = 'exact'; }
    else if (client === 'mimo') {
      found = fromMimoBanner(text);
      if (found && !found.model) return none(found.detail, found.reason);
      if (found) { source = 'client-banner'; confidence = 'exact'; }
      else { found = fromMimoLog({ startedAt: input.startedAt, endedAt: input.endedAt, logDir: input.logDir || defaultLogDir(env), workdir: input.workdir, capturedOutput: text }); source = 'client-log'; confidence = 'derived'; }
    } else if (client === 'vibe') {
      found = fromVibeSession({ startedAt: input.startedAt, endedAt: input.endedAt, sessionRoot: input.sessionRoot || defaultVibeSessionRoot(env), workdir: input.workdir, capturedOutput: text });
      source = 'client-log'; confidence = 'derived';
    } else return none(client ? `no reliable source for client ${client}` : 'no client');
  } catch (error) { return none(`derivation failed: ${error.message}`); }
  if (found && !found.model) return none(found.detail, found.reason);
  if (!found) return none(`no ${source} evidence found for ${client}`);
  // vibe: the requested value may be a name, the session holds an alias; both sides go through the alias table before they are compared
  const match = client === 'vibe' ? modelsMatch(vibeAlias(input.requestedModel, input.vibeModels).alias, vibeAlias(found.model, input.vibeModels).alias) : modelsMatch(input.requestedModel, found.model);
  return { servedModel: found.model, source, confidence, match, detail: found.detail };
}

// The three launch-record fields for a derivation result (servedModel is omitted when there is none).
function recordFields(result) {
  const out = { servedModelSource: result.source, servedModelConfidence: result.confidence };
  if (result.servedModel) out.servedModel = result.servedModel;
  return out;
}

function matchWord(match) { return match === true ? 'yes' : match === false ? 'no' : 'unknown'; }
function servedLine(result) { return `SERVED model=${result.servedModel || '-'} source=${result.source} match=${matchWord(result.match)}${result.reason ? ` reason="${result.reason}"` : ''}`; }
// The record note part for an unproven served model ('' when there is nothing to say).
function servedNote(result) { return result && result.reason ? `served-model-unproven reason="${result.reason}"` : ''; }

module.exports = { deriveServedModel, vibeAlias, VIBE_MODELS, fromVibeSession, vibeActiveModels, vibeSessionIdsInOutput, servedNote, mimoSessionIdsInOutput, primaryLines, defaultVibeSessionRoot, normDir, dirFromLog, modelsMatch, recordFields, servedLine, matchWord, defaultLogDir, fromAgentResult, fromMimoBanner, fromCodexHeader, fromMimoLog, modelFromLog, logStart, SOURCES, CONFIDENCE };

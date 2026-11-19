'use strict';
// quota-reset.cjs - the quota end of a seat: whether the client's own error record says the seat ended on a quota error, and the reset time
// that record names. Pure reading, never throws, writes nothing. Only an error record the client itself wrote is read, never text the model
// wrote (an assistant message, a quote of a log, a fence, a table or a comment names no quota here):
//   vibe    a vibe.log line of a failed model call ("<time> <pid> <tid> WARNING|ERROR Model call failed code=<code> ... details={...}
//           message=<text>", on the client's stderr) and the action_result record of its session journal whose result is a completion_failed
//           event (that record only, never an object nested in another record or in a tool call)
//   claude  the --output-format json result object with is_error true
//   codex   the last stderr line "ERROR: <text>" of a run that exited non-zero
//   kilo    a top-level error event of --format json (error.data.message, error.data.statusCode)
// Any other client has no error record here (no quota). A record is { status, provider, code, message }; the closed formats below read it.
// The result is { format, resetAt } (resetAt an ISO UTC time, or null when the format names no time) or null; the first matching record
// decides and a later one never moves the reset time.
//   vibe-budget-exhausted  a vibe record with httpStatus 402, provider mistral and a body of type billing_api_budget_exhausted or
//                          billing_vibe_budget_exhausted: the plan budget is spent, no reset time is named
//   claude-limit-epoch     a claude record whose whole text is "usage limit reached|<epoch seconds>" (Claude Code): the reset is that epoch
//   reset-at-iso           a claude, codex or kilo record with quota words (usage limit, quota, rate limit, 429 or status 429) and
//                          "resets at" or "try again at" followed by a valid ISO 8601 time that names its offset (Z or +hh:mm)
//   try-again-in           such a record with "try again in" and a duration of days, hours, minutes and seconds that ends the sentence: the
//                          reset is the end of the seat (the time the record was read) plus that duration
// A calendar date that does not exist, an impossible clock or offset, or a duration with an unread tail is no time at all (unknown).
// When the client names no time the owner may declare it: a declared limit of the route whose value says "resets at <ISO 8601 time>"
// (declaredReset, the reset-at-iso grammar without the quota words) is the reset time of a QUOTA failure of that route.
const fs = require('node:fs');
const path = require('node:path');
const FORMATS = Object.freeze(['vibe-budget-exhausted', 'claude-limit-epoch', 'reset-at-iso', 'try-again-in']);
const MAX_LINE = 8192;
const QUOTA_WORDS = /\b(?:usage limit|quota|rate limit|429)\b/i;
// The time token after the reset words; isoTime alone decides whether it is a time (a token with an unread tail is none).
const ISO = '(\\d{4}-\\d{2}-\\d{2}T[0-9:.Z+-]{0,40}[0-9Z])(?=$|[\\s.,;)\\]])';
const RESET_AT = new RegExp(`\\b(?:resets? at|try again at)\\s+${ISO}`, 'i');
const UNIT_MS = { day: 86400000, hour: 3600000, minute: 60000, second: 1000 };
const UNIT = '\\d{1,6}\\s*(?:days?|hours?|minutes?|seconds?)';
const DURATION = new RegExp(`\\btry again in\\s+(${UNIT}(?:(?:\\s*,\\s*|\\s+and\\s+|\\s+)${UNIT})*)(?=\\s*(?:[.;!)]|$))`, 'i');
const ISO_PARTS = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(?:Z|([+-])(\d{2}):(\d{2}))$/;
const isoOf = ms => (Number.isFinite(ms) && ms > 0 && ms < 8.64e15 ? new Date(ms).toISOString() : null);
// An ISO 8601 time with its offset, every field in its calendar range (no rollover of a day, a clock or an offset into a nearby time).
function isoTime(text) {
  const m = ISO_PARTS.exec(String(text || ''));
  if (!m) return null;
  const [y, mo, d, h, mi, s] = [1, 2, 3, 4, 5, 6].map(i => Number(m[i] || 0));
  if (mo < 1 || mo > 12 || d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate() || h > 23 || mi > 59 || s > 59) return null;
  let offset = 0;
  if (m[8]) { const oh = Number(m[9]); const om = Number(m[10]); if (oh > 14 || om > 59) return null; offset = (m[8] === '-' ? -1 : 1) * (oh * 60 + om); }
  return isoOf(Date.UTC(y, mo - 1, d, h, mi, s) + Math.floor(Number(`0.${m[7] || '0'}`) * 1000) - offset * 60000);
}
const record = (status, provider, code, message) => ({ status: Number.isSafeInteger(status) ? status : null, provider: typeof provider === 'string' ? provider : null,
  code: typeof code === 'string' ? code : null, message: String(message).replace(/[\r\n]+/g, ' ').slice(0, MAX_LINE) });
const parse = line => { try { const o = JSON.parse(line); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; } };
const lines = text => String(text || '').split('\n').map(l => l.replace(/\r$/, '')).filter(l => l && l.length <= MAX_LINE);
const VIBE_LOG = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?[+-]\d{2}:\d{2} \d{1,10} \d{1,10} (?:WARNING|ERROR) Model call failed code=([a-z_]{1,64}) (?:[a-z_]{1,32}=\S{1,200} )*details=(\{[^{}]{0,2000}\}) message=(.+)$/;
// One vibe.log line of a failed model call -> record | null.
function vibeLogRecord(line) {
  const m = VIBE_LOG.exec(String(line || ''));
  const d = m && parse(m[2]);
  return d ? record(d.httpStatus, d.provider, m[1], m[3]) : null;
}
// The client's own error records in its streams (the vibe session journal is read by vibeSessionFailures).
function errorRecords(client, { stdout, stderr, exitCode } = {}) {
  const c = String(client || '').toLowerCase();
  const out = [];
  if (c === 'vibe') for (const l of lines(stderr)) { const r = vibeLogRecord(l); if (r) out.push(r); }
  if (c === 'claude') {
    for (const l of [String(stdout || '').trim(), ...lines(stdout)]) {
      const o = l.startsWith('{') ? parse(l) : null;
      if (o && o.type === 'result' && o.is_error === true && typeof o.result === 'string') { out.push(record(null, null, typeof o.subtype === 'string' ? o.subtype : null, o.result)); break; }
    }
  }
  if (c === 'codex' && Number.isInteger(exitCode) && exitCode !== 0) {
    const last = lines(stderr).filter(l => l.trim()).pop();
    const m = last && /^(?:\[[^\]]{1,64}\]\s*)?ERROR:\s*(.+)$/.exec(last);
    if (m) out.push(record(null, null, null, m[1]));
  }
  if (c === 'kilo') {
    for (const l of lines(stdout)) {
      const o = l.startsWith('{') ? parse(l) : null;
      const e = o && o.type === 'error' && o.error && typeof o.error === 'object' ? o.error : null;
      const data = e && e.data && typeof e.data === 'object' ? e.data : {};
      const message = typeof data.message === 'string' ? data.message : e && typeof e.message === 'string' ? e.message : null;
      if (message !== null) out.push(record(data.statusCode, null, typeof e.name === 'string' ? e.name : null, message));
    }
  }
  return out;
}
const VIBE_BUDGET = /^billing_(?:api|vibe)_budget_exhausted$/;
function recordQuota(client, r, atMs) {
  const c = String(client || '').toLowerCase();
  if (c === 'vibe') {
    const body = /\bBody: (\{.*\})$/.exec(r.message);
    const type = body && parse(body[1]) ? parse(body[1]).type : null;
    return r.status === 402 && r.provider === 'mistral' && typeof type === 'string' && VIBE_BUDGET.test(type) ? { format: 'vibe-budget-exhausted', resetAt: null } : null;
  }
  if (!['claude', 'codex', 'kilo'].includes(c)) return null;
  const epoch = c === 'claude' ? /^(?:Claude AI )?usage limit reached\|(\d{10})$/i.exec(r.message.trim()) : null;
  if (epoch) { const resetAt = isoOf(Number(epoch[1]) * 1000); return resetAt ? { format: 'claude-limit-epoch', resetAt } : null; }
  if (!QUOTA_WORDS.test(r.message) && r.status !== 429) return null;
  const at = RESET_AT.exec(r.message);
  if (at) { const resetAt = isoTime(at[1]); return resetAt ? { format: 'reset-at-iso', resetAt } : null; }
  const d = DURATION.exec(r.message);
  if (d && Number.isFinite(atMs)) {
    let ms = 0;
    for (const m of d[1].matchAll(/(\d{1,6})\s*(day|hour|minute|second)s?/gi)) ms += Number(m[1]) * UNIT_MS[m[2].toLowerCase()];
    const resetAt = ms > 0 ? isoOf(atMs + ms) : null;
    return resetAt ? { format: 'try-again-in', resetAt } : null;
  }
  return null;
}
// quotaOfRecords(client, records, at) -> { format, resetAt } | null; `at` is the end of the seat (an ISO time), needed by try-again-in only.
function quotaOfRecords(client, records, at) {
  const atMs = Date.parse(at);
  for (const r of Array.isArray(records) ? records : []) {
    const q = r && typeof r.message === 'string' ? recordQuota(client, r, atMs) : null;
    if (q) return q;
  }
  return null;
}
// The failed model calls of one vibe session, from its own journal (the session of the seat, found by its folder and launch window): the
// error of each action_result record whose result is a completion_failed event, as a record.
const JOURNAL_MAX = 64 * 1024 * 1024;
function vibeSessionFailures(sessionId, opts = {}) {
  const U = require('./client-usage.cjs');
  if (!U.SESSION_ID.test(String(sessionId || ''))) return [];
  const { readFileGuarded } = require('../../lib/path-safe.cjs');
  const base = opts.sessionsDir || U.defaultVibeDir(opts.env);
  const dir = path.join(base, sessionId, 'journal');
  const out = [];
  let files;
  try { files = fs.readdirSync(dir).filter(n => /^[0-9]{1,20}\.jsonl$/.test(n)).sort(); } catch { return []; }
  for (const name of files) {
    const got = readFileGuarded(base, path.join(dir, name), { maxBytes: JOURNAL_MAX, refuseHardlinks: true });
    if (!got.ok) continue;
    for (const line of Buffer.from(got.bytes).toString('utf8').split('\n')) {
      if (!line.includes('completion_failed')) continue;
      const o = parse(line);
      const res = o && o.type === 'action_result' && o.payload && typeof o.payload === 'object' ? o.payload.result : null;
      const e = res && typeof res === 'object' && res.type === 'completion_failed' && res.error && typeof res.error === 'object' ? res.error : null;
      if (!e || typeof e.message !== 'string') continue;
      const d = e.details && typeof e.details === 'object' ? e.details : {};
      out.push(record(d.httpStatus, d.provider, e.code, e.message));
    }
  }
  const seen = new Set();
  return out.filter(r => { const k = JSON.stringify(r); return seen.has(k) ? false : seen.add(k); });
}
// The quota end of one seat: the error records of its own streams first, then (vibe) the failed calls of its own session.
function seatQuota({ client, stdout, stderr, exitCode, at, sessionId, sessionsDir, env } = {}) {
  const own = quotaOfRecords(client, errorRecords(client, { stdout, stderr, exitCode }), at);
  if (own || String(client || '').toLowerCase() !== 'vibe' || !sessionId) return own;
  return quotaOfRecords(client, vibeSessionFailures(sessionId, { sessionsDir, env }), at);
}
// A declared reset time: "resets at <ISO 8601 time with its offset>" in the declared value of the route.
function declaredReset(value) {
  const m = new RegExp(`\\bresets? at\\s+${ISO}`, 'i').exec(String(value || ''));
  return m ? isoTime(m[1]) : null;
}
// The record field: { format, resetAt } with format from the closed list and resetAt null or an ISO UTC time.
function validField(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).sort().join(',') === 'format,resetAt'
    && FORMATS.includes(v.format) && (v.resetAt === null || (typeof v.resetAt === 'string' && isoOf(Date.parse(v.resetAt)) === v.resetAt));
}
module.exports = { FORMATS, isoTime, vibeLogRecord, errorRecords, quotaOfRecords, vibeSessionFailures, seatQuota, declaredReset, validField };

'use strict';
// The read-only measurement ledger of the cycle controller (PROTO-DEC-0229 items 1, 2 and 6; PROTO-DEC-0230).
// Two guarantees of the cycle controller bind this file:
//   C1  the ledger reads launch records only; the only files it ever writes are the two paths named by --out-md and --out-json,
//       each one inside an allowed output directory read from the outputs file of the cycle, only under a generated-report name,
//       never a record, journal, decision or review file or directory, never under .ai (the runtime directory included);
//   C5  soft thresholds and plan warnings print one line each and change nothing (no kill path exists here).
// The record reader is the existing one of .ai/bin/accounting/launch-stats.cjs (launches + usable): this file writes no second
// per-field record reader. The JSON text is read through the shared strict reader (.ai/bin/lib/text-safe.cjs), so a duplicate
// key or a non-object line is a named refusal, never last-key-wins data.
//   node tools/cycle/ledger.cjs report [--since ISO-DATE] [--json] [--out-md FILE] [--out-json FILE]
//                                     [--journal FILE] [--plans FILE]
// Exit: 0 ok; 1 a named data refusal (missing or unreadable journal, record, plans, outputs or a refused output path); 2 usage.
// THE RULE (BY CONSTRUCTION): a measurement tool never turns UNKNOWN into a number.
//   - normalizeRecord() is the ONLY code that reads a raw launch record. It returns one frozen record whose every field is a
//     proven value (the kernel confidence says exact/derived) or null, or a named refusal. An invalid record is counted in the
//     invalid count and in nothing else.
//   - every aggregate takes normalized records only (a WeakSet brand refuses a raw one), so there is no second path from a raw
//     record to a number. A group total is a number only when EVERY record of the group has that proven field.
//   - the client, role, day and month tables come from ONE grouping function over the same normalized list.
const fs = require('node:fs');
const path = require('node:path');
const realPath = require('../../.ai/bin/lib/real-path.cjs');
const pathSafe = require('../../.ai/bin/lib/path-safe.cjs');
const textSafe = require('../../.ai/bin/lib/text-safe.cjs');
const schemaCheck = require('../../.ai/bin/accounting/lib/schema-check.cjs');
const stats = require('../../.ai/bin/accounting/launch-stats.cjs');

const REPO = path.resolve(__dirname, '..', '..');
const LAUNCHES_DIR = path.join(REPO, ...require('../../.ai/bin/repo-paths.cjs').CATALOG_LAUNCHES);
const DEFAULT_JOURNAL = path.join(LAUNCHES_DIR, 'LAUNCHES.jsonl');
const DEFAULT_PLANS = path.join(REPO, 'docs', 'ops', 'cycle', 'plans.json');
const DEFAULT_OUTPUTS = path.join(REPO, 'docs', 'ops', 'cycle', 'outputs.json');
const PLANS_SCHEMA = path.join(__dirname, 'plans.schema.json');
const OUTPUTS_SCHEMA = path.join(__dirname, 'outputs.schema.json');

const VERDICTS = new Set(['PASS', 'FAIL', 'BLOCKED', 'RECOMMENDATION']);
const LIMIT_CLASS = /(?:^|_)LIMIT$/;
const UNKNOWN = '(unknown)';
const KIND_NAMES = ['input', 'output', 'cacheRead', 'cacheWrite'];
const TOKEN_ALIASES = {
  input: ['input', 'inputTokens', 'input_tokens'],
  output: ['output', 'outputTokens', 'output_tokens'],
  cacheRead: ['cacheRead', 'cacheReadTokens', 'cache_read_tokens', 'cache_read_input_tokens'],
  cacheWrite: ['cacheWrite', 'cacheWriteTokens', 'cache_write_tokens', 'cache_write_input_tokens'],
  reasoning: ['reasoning'],
  total: ['total', 'totalTokens', 'total_tokens'],
};
const TOKEN_META = ['source', 'note'];
// The exact key alphabet the record grammar allows. A key outside it is refused, never ignored.
const TOKEN_KEYS = new Set([...Object.values(TOKEN_ALIASES).flat(), ...TOKEN_META]);
const KEY_FIELD = new Map(Object.entries(TOKEN_ALIASES).flatMap(([field, keys]) => keys.map(k => [k, field])));
const SUM_FIELDS = [...KIND_NAMES, 'reasoning'];
const OUTPUT_SUFFIX_DEFAULT = ['.report.md', '.report.json'];

// Raw records are branded here and nowhere else. aggregate() refuses any object that did not come out of normalizeRecord.
const NORMALIZED = new WeakSet();

const refusal = (code, detail) => `REFUSED ${code}: ${detail}`;
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// ---- NORMALISE (the only region that may read a raw launch record) ----

// A calendar-checked ISO date or date-time. Date.parse alone normalises 2026-02-30 into March, so the components are checked.
function isoProblem(s) {
  if (typeof s !== 'string') return 'not-text';
  const m = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})?)?$/.exec(s);
  if (!m) return 'shape';
  const y = Number(m[1]); const mo = Number(m[2]); const d = Number(m[3]);
  if (mo < 1 || mo > 12 || d < 1) return 'calendar';
  if (d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return 'calendar';
  if (m[4] !== undefined) {
    const h = Number(m[4]); const mi = Number(m[5]); const sec = m[6] === undefined ? 0 : Number(m[6]);
    if (h > 23 || mi > 59 || sec > 59) return 'clock';
  }
  return Number.isFinite(Date.parse(s)) ? null : 'parse';
}

// A field is proven when the record is not backfilled, or the kernel confidence for that field is exact/derived. An
// approximate time (a *Note) is not proven.
function proven(rec, field) {
  return stats.usable(rec, field);
}
function provenTime(rec, field) {
  if (!rec || typeof rec[field] !== 'string' || rec[`${field}Note`]) return null;
  if (!proven(rec, field)) return null;
  const t = Date.parse(rec[field]);
  return Number.isFinite(t) ? t : null;
}

// A verdict token counts only when the kernel usable rule says the field may be read. A backfilled record with unknown
// confidence contributes no verdict.
function verdictOf(l) {
  for (const rec of [l.fin, ...(l.fins || []), l.start]) {
    if (!rec) continue;
    for (const field of ['verdict', 'reviewOutcome']) {
      const v = rec[field];
      if (typeof v === 'string' && VERDICTS.has(v.toUpperCase()) && proven(rec, field)) return v.toUpperCase();
    }
  }
  return null;
}

// One end record and one end time, both proven or null. A finished event line proves the launch ended even when the line
// does not carry a usable endedAt.
function endRecordOf(l) {
  if (l.fin && typeof l.fin.endedAt === 'string') return l.fin;
  if (l.start && typeof l.start.endedAt === 'string') return l.start;
  return null;
}
function endTimeOf(l) {
  const rec = endRecordOf(l);
  return rec ? provenTime(rec, 'endedAt') : null;
}
function endedOf(l) {
  return Boolean(l.fin) || endTimeOf(l) !== null;
}

// A wall is a value only when its own record proves it, or when both proven times derive it. The shared wallOf trusts a
// finished wallSeconds without a confidence check, so it is deliberately not used here.
function wallOf(l) {
  const seen = new Set();
  for (const rec of [l.fin, ...(l.fins || []), l.start]) {
    if (!rec || seen.has(rec)) continue;
    seen.add(rec);
    if (typeof rec.wallSeconds === 'number' && proven(rec, 'wallSeconds')) return rec.wallSeconds;
  }
  const s = l.start;
  if (!s || s.backfilled === true) return null;
  const startMs = provenTime(s, 'startedAt');
  const endMs = endTimeOf(l);
  if (startMs === null || endMs === null) return null;
  const sec = (endMs - startMs) / 1000;
  return sec >= 0 ? sec : null;
}

// One token snapshot: the first usable record that yields a proven total. Kinds are read from that same snapshot, never from
// a second one; no snapshot means every token field is unknown.
function resolveTokens(t, keys) {
  let has = false;
  let value = null;
  for (const key of keys) {
    if (!Object.hasOwn(t, key)) continue;
    const v = t[key];
    if (v === undefined) continue;
    if (has && v !== value) return { conflict: true, value: null };
    has = true;
    value = v;
  }
  return { conflict: false, value: has ? value : null };
}
// The kernel total rule (read from .ai/bin/accounting/lib/client-usage.cjs, used exactly): the total the client prints;
// else the sum of the printed counts when they cover every token class; else null. The four classes of the normal form are
// input, output, cacheRead and cacheWrite (reasoning is folded into output), so the derived total is their sum and needs all
// four; a missing class is not derivable (null, never a number) and a sum above Number.MAX_SAFE_INTEGER is overflow.
function deriveTotal(t) {
  const kinds = KIND_NAMES.map(k => resolveTokens(t, TOKEN_ALIASES[k]).value);
  if (!kinds.every(v => typeof v === 'number')) return { total: null, overflow: false };
  const sum = kinds.reduce((a, b) => a + b, 0);
  return Number.isSafeInteger(sum) ? { total: sum, overflow: false } : { total: null, overflow: true };
}
function totalOfTokens(t) {
  if (typeof t === 'number') return Number.isSafeInteger(t) && t >= 0 ? t : null;
  if (!isPlainObject(t)) return null;
  const total = resolveTokens(t, TOKEN_ALIASES.total).value;
  if (typeof total === 'number') return total;
  if (typeof t.source === 'string') return null;
  return deriveTotal(t).total;
}
function tokenSnapshotOf(l) {
  for (const rec of [l.fin, ...(l.fins || []), l.start]) {
    if (!rec || !proven(rec, 'tokens')) continue;
    const t = rec.tokens;
    if (t === null || t === undefined) continue;
    const total = totalOfTokens(t);
    if (total === null) continue;
    return { t, total };
  }
  return null;
}

// Alias spellings are resolved HERE and nowhere else. The whole key alphabet is checked, every count is a non-negative safe
// integer or null, each semantic field may carry only one value under its spellings, and no kind may exceed its own total.
function tokenProblem(t) {
  if (typeof t === 'number') return Number.isSafeInteger(t) && t >= 0 ? null : 'bad-tokens';
  if (!isPlainObject(t)) return 'bad-tokens';
  for (const key of Object.keys(t)) if (!TOKEN_KEYS.has(key)) return `unknown-token-key:${key}`;
  for (const key of Object.keys(t)) {
    const v = t[key];
    if (TOKEN_META.includes(key)) {
      if (v !== null && typeof v !== 'string') return `bad-token-${key}`;
      continue;
    }
    if (v === null) continue;
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return `bad-token-${KEY_FIELD.get(key)}`;
  }
  for (const [field, keys] of Object.entries(TOKEN_ALIASES)) {
    const r = resolveTokens(t, keys);
    if (r.conflict) return `token-alias-conflict:${field}`;
  }
  // The total the above-total rule is judged against: the printed total, else the derived sum of the four classes (when
  // all four are printed). A derived sum above Number.MAX_SAFE_INTEGER is overflow, a named refusal, never an unsafe number.
  const explicit = resolveTokens(t, TOKEN_ALIASES.total).value;
  let total = explicit;
  if (typeof total !== 'number' && typeof t.source !== 'string') {
    const derived = deriveTotal(t);
    if (derived.overflow) return 'token-sum-overflow';
    total = derived.total;
  }
  if (typeof total === 'number') {
    for (const field of SUM_FIELDS) {
      const v = resolveTokens(t, TOKEN_ALIASES[field]).value;
      if (typeof v === 'number' && v > total) return 'token-kind-above-total';
    }
  }
  return null;
}

// Every record of the launch is checked: a token object on a finished line is as much data as one on the start line.
function invalidReasonOfRaw(l) {
  if (l && l.duplicateStart === true) return 'duplicate-start';
  const start = l && l.start;
  if (!isPlainObject(start)) return 'no-start-record';
  if (start.schema !== 'launch-record/1') return 'record-schema';
  const recs = [start, l.fin, ...(l.fins || [])].filter(isPlainObject);
  for (const rec of recs) {
    if (Object.hasOwn(rec, 'wallSeconds') && rec.wallSeconds !== null) {
      if (typeof rec.wallSeconds !== 'number') return 'bad-wall';
      if (!Number.isFinite(rec.wallSeconds) || rec.wallSeconds < 0) return 'negative-wall';
    }
    if (rec.startedAt !== undefined && rec.startedAt !== null && isoProblem(rec.startedAt)) return 'bad-start-time';
    if (rec.endedAt !== undefined && rec.endedAt !== null && isoProblem(rec.endedAt)) return 'bad-end-time';
    if (Object.hasOwn(rec, 'tokens') && rec.tokens !== null && rec.tokens !== undefined) {
      const p = tokenProblem(rec.tokens);
      if (p) return p;
    }
  }
  const startMs = provenTime(start, 'startedAt');
  const endMs = endTimeOf(l);
  if (startMs !== null && endMs !== null && endMs < startMs) return 'end-before-start';
  if (!endedOf(l) && verdictOf(l)) return 'verdict-without-end';
  return null;
}

// ONE function reads a raw launch (the kernel reader's joined unit for one launchId) and returns either a named refusal or
// one frozen record with a fixed shape. Every value below is proven or null; no raw field leaves this function.
function normalizeRecord(raw) {
  const reason = invalidReasonOfRaw(raw);
  if (reason) return { valid: false, reason };
  const l = raw;
  const start = l.start;
  const startedMs = provenTime(start, 'startedAt');
  const ended = endedOf(l);
  const exitCode = stats.exitOf(l);
  const verdict = verdictOf(l);
  let outcome = 'not_ended';
  if (ended) {
    if (verdict) outcome = 'verdict';
    else {
      const cls = stats.failureClassOf(l);
      if (cls && LIMIT_CLASS.test(cls)) outcome = 'at_limit';
      else if (cls === 'NO_VERDICT') outcome = 'no_verdict';
      else outcome = exitCode === 0 ? 'verdict' : 'no_verdict';
    }
  }
  const day = startedMs === null ? null : new Date(startedMs).toISOString().slice(0, 10);
  const tokens = { input: null, output: null, cacheRead: null, cacheWrite: null, total: null };
  const snap = tokenSnapshotOf(l);
  if (snap) {
    tokens.total = snap.total;
    if (isPlainObject(snap.t)) {
      for (const kind of KIND_NAMES) {
        const v = resolveTokens(snap.t, TOKEN_ALIASES[kind]).value;
        tokens[kind] = typeof v === 'number' ? v : null;
      }
    }
  }
  const rec = Object.freeze({
    id: typeof l.id === 'string' ? l.id : null,
    // The canonical launchId carries the wrapper seat name; the real ledger
    // carries its worktree as workdir (channel is NOT the wrapper stream).
    seatName: typeof l.id==='string' ? /^L-\d{8}T\d{6}Z-(.+)$/.exec(l.id)?.[1] || null : null,
    worktree: proven(start,'workdir') && typeof start.workdir==='string' && start.workdir ? start.workdir : null,
    client: proven(start, 'client') && typeof start.tuple?.client === 'string' && start.tuple.client ? start.tuple.client : null,
    role: proven(start, 'role') && typeof start.role === 'string' && start.role ? start.role : null,
    day,
    month: day === null ? null : day.slice(0, 7),
    startedMs,
    ended,
    outcome,
    exitCode,
    wallSeconds: wallOf(l),
    tokens: Object.freeze(tokens),
  });
  NORMALIZED.add(rec);
  return { valid: true, rec };
}
// Compatibility helper (tests and callers that only ask "why"): the same one gate, never a second validity path.
const invalidReasonOf = l => { const n = normalizeRecord(l); return n.valid ? null : n.reason; };
const unfinishedVerdictOf = l => invalidReasonOf(l) === 'verdict-without-end';

// ---- AGGREGATES (normalized records only; a raw field or a kernel reader call below this line is a defect) ----

const pctOf = (a, b) => (b ? Math.round((100 * a) / b) : null);
const pctText = (a, b) => (b ? `${pctOf(a, b)}%` : 'n/a');
const num = x => (x === null || x === undefined ? 'n/a' : (Math.round(x * 10) / 10).toString());
const unknownNum = (x, present) => (!present ? 'n/a' : (x === null ? 'unknown' : num(x)));

// One markdown cell: no line break, no raw pipe or backtick, no control or invisible character and no raw HTML. A hostile
// client name can therefore never open a row of its own, hide a value or add a "Verdict:" line to the report.
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;
function cell(value) {
  let s = value === null || value === undefined ? '' : String(value);
  s = s.replace(/\r\n?|\n/g, ' ');
  s = s.replace(/[\u0000-\u001f\u007f]/g, '?');
  s = s.replace(INVISIBLE, '');
  s = s.replace(/\\/g, '\\\\').replace(/\|/g, '\\|').replace(/`/g, '\\`');
  s = s.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return s;
}

// P50 and P90 by nearest rank over a sorted sample; null for an empty sample, never a zero.
function percentile(xs, p) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const k = Math.min(s.length, Math.max(1, Math.ceil(p * s.length)));
  return s[k - 1];
}

function assertNormalized(group) {
  for (const rec of group) {
    if (!NORMALIZED.has(rec)) throw new Error('aggregate received a raw launch record; normalizeRecord must run first');
  }
}
// A group total is a number only when EVERY record of the group proves that field; one unknown makes it null. Counts are
// always known. Percentiles use the proven successful walls and print their n.
function aggregate(group) {
  assertNormalized(group);
  const a = {
    launches: group.length, ended: 0, verdict: 0, no_verdict: 0, at_limit: 0, not_ended: 0,
    wall_n: 0, wall_p50: null, wall_p90: null,
    tokens_known: 0, input: null, output: null, cache_read: null, cache_write: null, tokens_total: null,
    cache_read_share: null, tokens_limit_or_no_verdict: null,
    verdict_share: null, no_verdict_share: null, limit_share: null,
  };
  const walls = [];
  const sums = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const known = { input: group.length > 0, output: group.length > 0, cacheRead: group.length > 0, cacheWrite: group.length > 0, total: group.length > 0 };
  let wasteKnown = true;
  let waste = 0;
  let wasteSeen = false;
  for (const rec of group) {
    a[rec.outcome] += 1;
    if (rec.outcome !== 'not_ended') a.ended += 1;
    if (rec.exitCode === 0 && rec.wallSeconds !== null) walls.push(rec.wallSeconds);
    for (const kind of KIND_NAMES) {
      const v = rec.tokens[kind];
      if (v === null) known[kind] = false;
      else { sums[kind] += v; if (!Number.isSafeInteger(sums[kind])) known[kind] = false; }
    }
    if (rec.tokens.total === null) known.total = false;
    else { sums.total += rec.tokens.total; a.tokens_known += 1; if (!Number.isSafeInteger(sums.total)) known.total = false; }
    if (rec.outcome === 'at_limit' || rec.outcome === 'no_verdict') {
      wasteSeen = true;
      if (rec.tokens.total === null) wasteKnown = false;
      else { waste += rec.tokens.total; if (!Number.isSafeInteger(waste)) wasteKnown = false; }
    }
  }
  a.wall_n = walls.length;
  a.wall_p50 = percentile(walls, 0.5);
  a.wall_p90 = percentile(walls, 0.9);
  a.verdict_share = pctOf(a.verdict, a.ended);
  a.no_verdict_share = pctOf(a.no_verdict, a.ended);
  a.limit_share = pctOf(a.at_limit, a.ended);
  a.input = known.input ? sums.input : null;
  a.output = known.output ? sums.output : null;
  a.cache_read = known.cacheRead ? sums.cacheRead : null;
  a.cache_write = known.cacheWrite ? sums.cacheWrite : null;
  a.tokens_total = known.total ? sums.total : null;
  if (a.tokens_total !== null && a.tokens_total > 0 && a.cache_read !== null) {
    a.cache_read_share = Math.round((1000 * a.cache_read) / a.tokens_total) / 10;
  }
  a.tokens_limit_or_no_verdict = wasteSeen ? (wasteKnown ? waste : null) : 0;
  return a;
}

// ONE grouping function for every table: client, role, day and month. A null key is skipped (an undated launch never gets a
// day row); a composite key (day + client) keeps the parts apart, never one string split on a separator.
const keyId = k => (Array.isArray(k) ? JSON.stringify(k) : String(k));
function groupBy(recs, keyOf) {
  assertNormalized(recs);
  const rows = new Map();
  for (const rec of recs) {
    const k = keyOf(rec);
    if (k === null || k === undefined) continue;
    const id = keyId(k);
    if (!rows.has(id)) rows.set(id, { key: k, recs: [] });
    rows.get(id).recs.push(rec);
  }
  const cmp = (x, y) => {
    if (Array.isArray(x.key) || Array.isArray(y.key)) {
      const a = Array.isArray(x.key) ? x.key : [x.key];
      const b = Array.isArray(y.key) ? y.key : [y.key];
      for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const c = String(a[i] ?? '').localeCompare(String(b[i] ?? ''));
        if (c) return c;
      }
      return 0;
    }
    return String(x.key).localeCompare(String(y.key));
  };
  return [...rows.values()].sort(cmp);
}

const AGG_COLUMNS = ['launches', 'ended', 'verdict', 'no_verdict', 'at_limit', 'not_ended'];
const table = (head, rows) => [
  `| ${head.join(' | ')} |`,
  `|${'---|'.repeat(head.length)}`,
  ...rows.map(r => `| ${r.map(cell).join(' | ')} |`),
];
function aggregateRow(name, a) {
  return [name, ...AGG_COLUMNS.map(k => a[k]),
    pctText(a.verdict, a.ended), pctText(a.no_verdict, a.ended), pctText(a.at_limit, a.ended),
    a.wall_n, num(a.wall_p50), num(a.wall_p90),
    a.tokens_known, ...['input', 'output', 'cache_read', 'cache_write', 'tokens_total'].map(k => unknownNum(a[k], a.launches > 0)),
    unknownNum(a.cache_read_share, a.launches > 0),
    unknownNum(a.tokens_limit_or_no_verdict, a.launches > 0)];
}
const AGG_HEAD = ['group', 'launches', 'ended', 'verdict', 'no verdict', 'at limit', 'not ended',
  'verdict share', 'no-verdict share', 'limit share', 'wall n', 'wall p50 s', 'wall p90 s',
  'tokens known', 'input', 'output', 'cache read', 'cache write', 'total', 'cache-read share',
  'tokens limit/no-verdict'];

// The bucket is chosen by the date key of every dated launch of that provider. A bucket is a number only when EVERY record
// of the bucket proves its total; a later unknown bucket stays unknown and is never replaced by an earlier known one. A
// stated limit is compared with the EXACT ratio (used*100 against limit*70/90); rounding is display only.
function planRows(recs, plans) {
  assertNormalized(recs);
  const lines = [];
  const json = [];
  for (const row of plans) {
    if (row.tokenLimit === null) continue;
    const of = row.period === 'day' ? (rec => rec.day) : (rec => rec.month);
    const groups = groupBy(recs.filter(rec => rec.client === row.provider), of);
    const last = groups.length ? groups[groups.length - 1] : null;
    const known = Boolean(last) && last.recs.every(rec => rec.tokens.total !== null);
    const used = known ? last.recs.reduce((sum, rec) => sum + rec.tokens.total, 0) : null;
    const percent = used === null ? null : Math.round((1000 * used) / row.tokenLimit) / 10;
    const warning = used === null ? null : used * 100 >= 90 * row.tokenLimit ? 90 : used * 100 >= 70 * row.tokenLimit ? 70 : null;
    const bucket = last ? last.key : null;
    json.push({ provider: row.provider, period: row.period, bucket, used, limit: row.tokenLimit, percent, warning, usage: used === null ? 'unknown' : 'known' });
    const shown = used === null ? 'unknown' : String(used);
    const shownPct = percent === null ? 'unknown' : String(percent);
    const verdict = warning ? `WARN ${warning}` : used === null ? 'UNKNOWN' : 'OK';
    lines.push(`PLAN provider=${cell(row.provider)} period=${cell(row.period)} bucket=${cell(bucket || 'none')} used=${shown} limit=${row.tokenLimit} percent=${shownPct} ${verdict}`);
  }
  return { lines, json };
}

function build(recs, plans, ctx) {
  const invalid = ctx.invalid || { count: 0, reasons: {} };
  const clients = groupBy(recs, rec => rec.client === null ? UNKNOWN : rec.client).map(g => [g.key, aggregate(g.recs)]);
  const roles = groupBy(recs, rec => rec.role === null ? UNKNOWN : rec.role).map(g => [g.key, aggregate(g.recs)]);
  const soft = [];
  for (const g of groupBy(recs.filter(rec => rec.exitCode === 0 && rec.tokens.total !== null), rec => rec.role === null ? UNKNOWN : rec.role)) {
    const tokens = g.recs.map(rec => rec.tokens.total);
    const p90 = percentile(tokens, 0.9);
    const above = tokens.filter(t => p90 !== null && t > p90);
    soft.push({ role: g.key, seats: tokens.length, p90_tokens: p90, seats_above_p90: above.length, max_tokens: tokens.length ? Math.max(...tokens) : null });
  }
  const clientKey = rec => rec.client === null ? UNKNOWN : rec.client;
  const day = groupBy(recs, rec => rec.day === null ? null : [rec.day, clientKey(rec)]).map(g => ({ bucket: g.key[0], provider: g.key[1], agg: aggregate(g.recs) }));
  const month = groupBy(recs, rec => rec.month === null ? null : [rec.month, clientKey(rec)]).map(g => ({ bucket: g.key[0], provider: g.key[1], agg: aggregate(g.recs) }));
  const plan = planRows(recs, plans);
  const undated = recs.filter(rec => rec.day === null).length;
  return { clients, roles, soft, day, month, plan, undated, invalid };
}

function markdown(result, ctx) {
  const lines = [
    '# CYCLE-CONTROL measurement ledger (read-only)',
    '',
    `Generated: ${ctx.generated} | since: ${ctx.since || 'all'} | launches: ${ctx.launches} | invalid: ${result.invalid.count} | scope: ${cell(ctx.scope)}`,
    'Advisory only (PROTO-DEC-0229 item 2): the ledger reads launch records and writes nothing except the paths named by --out-md and --out-json.',
    `Record source: ${cell(ctx.journal)}`,
  ];
  if (result.invalid.count) lines.push(`WARN invalid-records=${result.invalid.count} (${Object.entries(result.invalid.reasons).map(([k, v]) => `${cell(k)}=${v}`).join(', ')}; counted only here, never measured)`);
  if (result.undated) lines.push(`WARN undated-launches=${result.undated} (no proven start time; excluded from the day and month lines${ctx.since ? ' and from the --since filter' : ''})`);
  lines.push('', '## By client', '');
  lines.push(...table(AGG_HEAD, result.clients.map(([name, a]) => aggregateRow(name, a))));
  lines.push('', '## By role', '');
  lines.push(...table(AGG_HEAD, result.roles.map(([name, a]) => aggregateRow(name, a))));
  lines.push('', '## Soft thresholds (notice only, nothing changes)', '');
  const soft = result.soft.filter(s => s.seats_above_p90 > 0);
  lines.push(...(soft.length
    ? soft.map(s => `SOFT role=${cell(s.role)} seats=${s.seats} seats_above_p90=${s.seats_above_p90} p90_tokens=${s.p90_tokens} max_tokens=${s.max_tokens}`)
    : ['SOFT none (no successful seat of a role is above the observed P90 of its role)']));
  lines.push('', '## Daily', '');
  const dayLines = result.day.map(r => ({ ...r.agg, day: r.bucket, provider: r.provider }));
  lines.push(...(dayLines.length ? dayLines.map(a => `DAY ${cell(a.day)} provider=${cell(a.provider)} launches=${a.launches} verdict=${a.verdict} no_verdict=${a.no_verdict} at_limit=${a.at_limit} not_ended=${a.not_ended} tokens=${unknownNum(a.tokens_total, a.launches > 0)}`) : ['DAY none']));
  lines.push('', '## Monthly', '');
  const monthLines = result.month.map(r => ({ ...r.agg, month: r.bucket, provider: r.provider }));
  lines.push(...(monthLines.length ? monthLines.map(a => `MONTH ${cell(a.month)} provider=${cell(a.provider)} launches=${a.launches} verdict=${a.verdict} no_verdict=${a.no_verdict} at_limit=${a.at_limit} not_ended=${a.not_ended} tokens=${unknownNum(a.tokens_total, a.launches > 0)}`) : ['MONTH none']));
  lines.push('', '## Plan warnings', '');
  lines.push(...(result.plan.lines.length ? result.plan.lines : ['PLAN none (every stated limit is null: nothing to warn about)']));
  return `${lines.join('\n')}\n`;
}

function jsonReport(result, ctx) {
  const row = a => ({ ...a });
  return {
    schema: 'cycle-ledger/1',
    generated: ctx.generated,
    since: ctx.since,
    scope: ctx.scope,
    journal: ctx.journal,
    records: ctx.records,
    launches: ctx.launches,
    undated: result.undated,
    invalid: result.invalid,
    clients: result.clients.map(([name, a]) => ({ client: name, ...row(a) })),
    roles: result.roles.map(([name, a]) => ({ role: name, ...row(a) })),
    soft: result.soft,
    days: result.day.map(r => ({ day: r.bucket, provider: r.provider, ...row(r.agg) })),
    months: result.month.map(r => ({ month: r.bucket, provider: r.provider, ...row(r.agg) })),
    plans: result.plan.json,
  };
}

// ---- END AGGREGATES ----

// C1 in code: an output path is accepted only when its real path is inside one configured output directory, its name is NEW
// or ends in a declared generated-report suffix, it is not a record/journal/decision/review name or below such a directory,
// and it is not under .ai (the runtime directory included). Data from the outputs file is checked, never trusted alone.
const PROTECTED_DIRS = ['docs/reviews', 'docs/decisions', 'docs/research', '.ai'];
const FORBIDDEN_SEGMENTS = new Set(['records', 'record', 'journals', 'journal', 'decisions', 'reviews', 'review', 'worklog']);
const FORBIDDEN_NAMES = [
  /\.jsonl$/i,
  /^launches/i,
  /^(?:decisions?|reviews?|records?|journals?)(?:[._-]|\.md$|\.json$|\.jsonl$)/i,
  /^(?:decisions|task|plan|archive|registry|signals)\.md$/i,
  /\.review\.(?:md|json)$/i,
];
function nameProblem(name) {
  for (const re of FORBIDDEN_NAMES) if (re.test(name)) return `its name is a record, journal, decision or review name (${name})`;
  return null;
}
function underDir(root, target) {
  return require('./paths.cjs').inside(root,target);
}
function realDirOf(p) {
  try { return realPath.realPathSync(p); } catch { return null; }
}
function segmentsProblem(rel) {
  const segs = rel.split(/[\\/]/).filter(Boolean);
  for (const s of segs.slice(0, -1)) {
    if (FORBIDDEN_SEGMENTS.has(s.toLowerCase())) return `it is inside the ${s} directory`;
  }
  return null;
}
function hasStreamName(abs) {
  return path.resolve(abs).replace(/^[A-Za-z]:/, '').includes(':');
}
function protectedProblem(target, ctx) {
  for (const [name, input] of ctx.inputs || []) {
    if (pathSafe.sameFileOrNested(target, input)) return `it is, or is inside, ${name}`;
  }
  for (const dir of PROTECTED_DIRS) {
    const root = path.join(ctx.repoRoot, dir);
    if (!fs.existsSync(root)) continue;
    if (pathSafe.sameFileOrNested(target, root)) return `it is, or resolves to, the protected ${dir} directory`;
  }
  return null;
}
function outPlan(out, ctx) {
  if (typeof out !== 'string' || !out.trim() || out.includes('\0')) return { problem: 'the path is empty or malformed' };
  const lexical = pathSafe.lexicalProblem(out);
  if (lexical) return { problem: `the shared path guard refuses the spelling (${lexical[0]}: ${lexical[1]})` };
  if (hasStreamName(out)) return { problem: 'its name holds a colon after the drive (an alternate data stream)' };
  const target = path.resolve(ctx.cwd, out);
  const dirs = ctx.outputDirs || [];
  if (!dirs.length) return { problem: 'no output directory is configured (docs/ops/cycle/outputs.json)' };
  let root = null;
  let inside = null;
  for (const dir of dirs) {
    const g = pathSafe.realInside(dir, target, { refuseHardlinks: true });
    if (g.ok) { root = dir; inside = g; break; }
  }
  if (!inside) return { problem: 'it is outside the allowed output directories' };
  // B2: the output ceiling is fixed and independent of the allow list. The real path of the target must sit under the
  // repository's docs or tools directory, whatever the outputs file of the cycle says; a config that names src (or a
  // junction or dot-dot that resolves outside the two) is refused here, never written.
  const docsReal = realDirOf(path.join(ctx.repoRoot, 'docs'));
  const toolsReal = realDirOf(path.join(ctx.repoRoot, 'tools'));
  if (!(docsReal && underDir(docsReal, inside.real)) && !(toolsReal && underDir(toolsReal, inside.real))) {
    return { problem: 'it is outside the repository docs and tools directories (the output ceiling is fixed)' };
  }
  const name = path.basename(target);
  const nm = nameProblem(name);
  if (nm) return { problem: nm };
  // The whole path at or below the repository (or the drive, for an allowed root outside it), so a records/journal/
  // decision/review directory at any level is refused, including one that is itself the allowed root.
  const relRepo = path.relative(ctx.repoRoot, target);
  const scope = !require('./paths.cjs').same(ctx.repoRoot,target) && underDir(ctx.repoRoot,target)
    ? relRepo
    : path.relative(path.parse(target).root, target);
  const seg = segmentsProblem(scope);
  if (seg) return { problem: seg };
  if (underDir(path.join(ctx.repoRoot, '.ai'), inside.real)) {
    return { problem: 'it is under .ai; the runtime directory is not an output directory' };
  }
  const prot = protectedProblem(target, ctx);
  if (prot) return { problem: prot };
  let parent;
  try { parent = fs.statSync(path.dirname(inside.real)); } catch { return { problem: 'its parent directory does not exist (the ledger creates no directory)' }; }
  if (!parent.isDirectory()) return { problem: 'its parent is not a directory' };
  if (inside.exists) {
    if (inside.type !== 'file') return { problem: 'it is an existing directory' };
    const suffixes = ctx.outputSuffixes || OUTPUT_SUFFIX_DEFAULT;
    if (!suffixes.some(s => name.endsWith(s))) {
      return { problem: `an existing file whose name does not end in a generated-report suffix (${suffixes.join(', ')}) is never replaced` };
    }
  }
  return { target, real: inside.real };
}

function parseArgs(argv) {
  const o = { journal: DEFAULT_JOURNAL, plans: DEFAULT_PLANS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // F09: an option whose value is missing (or is the next option) is a usage error, never silently ignored.
    const take = () => {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return { error: `${a} needs a value` };
      i++;
      return { value: v };
    };
    if (a === '--since') { const r = take(); if (r.error) return r; o.since = r.value; }
    else if (a === '--json') o.json = true;
    else if (a === '--out-md') { const r = take(); if (r.error) return r; o.outMd = r.value; }
    else if (a === '--out-json') { const r = take(); if (r.error) return r; o.outJson = r.value; }
    else if (a === '--journal') { const r = take(); if (r.error) return r; o.journal = r.value; }
    else if (a === '--plans') { const r = take(); if (r.error) return r; o.plans = r.value; }
    else if (a === '--now') { const r = take(); if (r.error) return r; o.now = r.value; }
    else return { error: `unknown argument ${a}` };
  }
  for (const key of ['since', 'outMd', 'outJson', 'journal', 'plans', 'now']) {
    if (o[key] === undefined) continue;
    if (typeof o[key] !== 'string' || !o[key].trim()) return { error: `--${key} needs a value` };
  }
  // M05: an impossible calendar date is a usage error, not a silent normalisation.
  if (o.since !== undefined && isoProblem(o.since)) return { error: '--since must be an ISO date or time' };
  if (o.now !== undefined && isoProblem(o.now)) return { error: '--now must be an ISO time' };
  return o;
}

const decodeStrict = (file, what) => {
  let raw;
  try { raw = fs.readFileSync(file); } catch (e) { return { refusal: refusal(`${what}-unreadable`, `${file} (${e.code || e.message})`) }; }
  const decoded = textSafe.decode(raw, { crlf: 'normalise' });
  // C-02/M02: the shared decoder reports `problems`, not `errors`; a refusal is one named line, never a TypeError.
  if (!decoded.ok) return { refusal: refusal(`${what}-unreadable`, `${file} (${(decoded.problems || []).map(e => `${e.code}: ${e.detail}`).join('; ') || 'refused'})`) };
  return { text: decoded.text };
};
const parseStrictJson = (text, file, what) => {
  try { return { value: textSafe.parseJsonUnique(text) }; } catch (e) {
    const why = e && e.code === 'JSON_DUPLICATE_KEY' ? 'a duplicate key' : `invalid JSON (${(e && e.code) || 'error'})`;
    return { refusal: refusal(`${what}-unreadable`, `${file} (${why})`) };
  }
};

// The journal is read line by line through the shared strict reader. A duplicate key or a non-object line is a named refusal,
// never last-key-wins data and never a silent zero-launch corpus.
function loadJournal(file) {
  const decoded = decodeStrict(file, 'record');
  if (decoded.refusal) return decoded;
  const out = [];
  const lines = decoded.text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const parsed = parseStrictJson(line, `${path.basename(file)}:${i + 1}`, 'record');
    if (parsed.refusal) return parsed;
    const rec = parsed.value;
    if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { refusal: refusal('record-unreadable', `${path.basename(file)}:${i + 1} is not a JSON object`) };
    out.push(rec);
  }
  return { records: out };
}
function plainFileProblem(file, what) {
  let st;
  try { st = fs.statSync(file); } catch (e) { return { refusal: refusal(`${what}-missing`, `${file} (${e.code || e.message})`) }; }
  if (!st.isFile()) return { refusal: refusal(`${what}-unreadable`, `${file} is not a plain file`) };
  return null;
}

function loadPlans(file) {
  const fileProblem = plainFileProblem(file, 'plans');
  if (fileProblem) return fileProblem;
  const decoded = decodeStrict(file, 'plans');
  if (decoded.refusal) return decoded;
  const parsed = parseStrictJson(decoded.text, file, 'plans');
  if (parsed.refusal) return parsed;
  const data = parsed.value;
  if (!fs.existsSync(PLANS_SCHEMA)) return { refusal: refusal('plans-schema-missing', PLANS_SCHEMA) };
  let schema;
  try { schema = JSON.parse(fs.readFileSync(PLANS_SCHEMA, 'utf8')); } catch (e) { return { refusal: refusal('plans-schema-unreadable', `${PLANS_SCHEMA} (${e.code || e.message})`) }; }
  const errors = schemaCheck.validate(schema, data);
  if (errors.length) return { refusal: refusal('plans-schema', `${file}: ${errors.join('; ')}`) };
  const seen = new Set();
  for (const row of data.plans) {
    const key = `${row.provider} | ${row.period}`;
    if (seen.has(key)) return { refusal: refusal('plans-schema', `${file}: duplicate row ${key}`) };
    seen.add(key);
  }
  return { plans: data.plans };
}

// The allow list is data, validated by its own schema: relative directories below the repository root and the generated-report
// name suffixes. The runtime directory is not an output directory.
function loadOutputs(file, repoRoot) {
  const fileProblem = plainFileProblem(file, 'outputs');
  if (fileProblem) return fileProblem;
  const decoded = decodeStrict(file, 'outputs');
  if (decoded.refusal) return decoded;
  const parsed = parseStrictJson(decoded.text, file, 'outputs');
  if (parsed.refusal) return parsed;
  const data = parsed.value;
  let schema;
  try { schema = JSON.parse(fs.readFileSync(OUTPUTS_SCHEMA, 'utf8')); } catch (e) { return { refusal: refusal('outputs-schema-unreadable', `${OUTPUTS_SCHEMA} (${e.code || e.message})`) }; }
  const errors = schemaCheck.validate(schema, data);
  if (errors.length) return { refusal: refusal('outputs-schema', `${file}: ${errors.join('; ')}`) };
  const directories = [];
  for (const dir of data.directories) {
    const segs = dir.split(/[\\/]/);
    if (!dir.trim() || path.isAbsolute(dir) || segs.some(s => s === '..' || s === '' || s === '.')) return { refusal: refusal('outputs-schema', `${file}: "${dir}" must be a relative path below the repository root`) };
    const abs = path.resolve(repoRoot, dir);
    if (underDir(path.join(repoRoot, '.ai'), abs)) return { refusal: refusal('outputs-schema', `${file}: "${dir}" is under .ai, and the runtime directory is not an output directory`) };
    // B2: an allowed directory must sit under the repository docs or tools directory, whatever the schema's own spelling
    // rules permit; the ceiling is fixed and never configurable.
    const docsReal = realDirOf(path.join(repoRoot, 'docs'));
    const toolsReal = realDirOf(path.join(repoRoot, 'tools'));
    if (!(docsReal && underDir(docsReal, abs)) && !(toolsReal && underDir(toolsReal, abs))) {
      return { refusal: refusal('outputs-schema', `${file}: "${dir}" is outside docs/ and tools/ (an output directory must be under one of them)`) };
    }
    const segProblem = segmentsProblem(`${dir}/.probe`);
    if (segProblem) return { refusal: refusal('outputs-schema', `${file}: "${dir}" ${segProblem}`) };
    directories.push(abs);
  }
  if (!directories.length) return { refusal: refusal('outputs-schema', `${file}: no output directory is configured`) };
  if (new Set(data.suffixes).size !== data.suffixes.length) return { refusal: refusal('outputs-schema', `${file}: a generated-report suffix is repeated`) };
  return { directories, suffixes: [...data.suffixes] };
}

// Two or more full/started lines for one launchId are a corpus disagreement: the kernel join would keep only the last, so the
// launch is refused instead of silently losing the first.
function duplicateStarts(records) {
  const counts = new Map();
  for (const r of records) {
    if (!r || typeof r !== 'object' || typeof r.launchId !== 'string') continue;
    if (r.event === 'finished' || r.event === 'review') continue;
    counts.set(r.launchId, (counts.get(r.launchId) || 0) + 1);
  }
  return new Set([...counts].filter(([, n]) => n > 1).map(([id]) => id));
}

// M2: a raw record that the kernel join would drop (no launchId, an orphan finished line) or miscount as one launch (an
// object launchId, an unknown event) is invalid with a named reason, never silently one launch and never silently absent.
const RECORD_EVENTS = new Set(['started', 'finished', 'review']);
function rawRecordProblems(records) {
  const startIds = new Set();
  for (const r of records) if (r && typeof r === 'object' && typeof r.launchId === 'string' && (r.event === undefined || r.event === 'started')) startIds.add(r.launchId);
  const problems = [];
  const clean = [];
  for (const r of records) {
    let p = null;
    if (r.launchId === undefined || r.launchId === null || r.launchId === '') p = 'no-launch-id';
    else if (typeof r.launchId !== 'string') p = 'bad-launch-id';
    else if (r.event !== undefined && !RECORD_EVENTS.has(r.event)) p = 'unknown-event';
    else if ((r.event === 'finished' || r.event === 'review') && !startIds.has(r.launchId)) p = 'orphan-finished';
    if (p) problems.push(p); else clean.push(r);
  }
  return { clean, problems };
}

// Both stages consume the exact same event set, kernel join and normalization gate.
function readLaunches(journal) {
  const loadedJournal = loadJournal(journal);
  if (loadedJournal.refusal) return loadedJournal;
  const { clean, problems: rawProblems } = rawRecordProblems(loadedJournal.records);
  const rawReasonMap = new Map();
  for (const p of rawProblems) rawReasonMap.set(p, (rawReasonMap.get(p) || 0) + 1);
  let all;
  try {
    all = stats.launches(clean);
  } catch (e) {
    return { refusal: refusal('record-unreadable', `${journal}: ${e.message}`) };
  }
  const dups = duplicateStarts(clean);
  for (const l of all) if (dups.has(l.id)) l.duplicateStart = true;
  // ONE normalization pass. The invalid count is the only place a refused record is counted.
  const normalized = all.map(normalizeRecord);
  const reasons = new Map();
  for (const n of normalized) if (!n.valid) reasons.set(n.reason, (reasons.get(n.reason) || 0) + 1);
  for (const [p, n] of rawReasonMap) reasons.set(p, (reasons.get(p) || 0) + n);
  const invalid = { count: [...reasons.values()].reduce((x, y) => x + y, 0), reasons: Object.fromEntries([...reasons].sort()) };
  const valid = normalized.filter(n => n.valid).map(n => n.rec);
  if (!valid.length) {
    const detail = Object.entries(invalid.reasons).map(([k, v]) => `${k}=${v}`).join(', ');
    return { refusal: refusal(invalid.count ? 'records-invalid' : 'records-empty', `${journal}: no launch record is valid${detail ? ` (${detail})` : ''}`) };
  }
  return { all, valid, invalid };
}

function main(argv, deps = {}) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write('usage: node tools/cycle/ledger.cjs report [--since ISO-DATE] [--json] [--out-md FILE] [--out-json FILE] [--journal FILE] [--plans FILE]\n'); return 0; }
  const cmd = argv[0];
  const repoRoot = path.resolve(deps.repoRoot || REPO);
  const cwd = path.resolve(deps.cwd || process.cwd());
  const fail = (line, code) => { process.stderr.write(`${line}\n`); return code; };
  if (cmd !== 'report') return fail('usage: node tools/cycle/ledger.cjs report [--since ISO-DATE] [--json] [--out-md FILE] [--out-json FILE] [--journal FILE] [--plans FILE]', 2);
  const o = parseArgs(argv.slice(1));
  if (o.error) return fail(o.error, 2);
  const journal = path.resolve(cwd, o.journal);
  const plansFile = path.resolve(cwd, o.plans);
  // M5: every filesystem error on the journal path (a concurrent disappearance between existsSync and statSync, a read
  // error) is one named REFUSED line and exit 1, never an uncaught exception.
  let journalStat;
  try {
    if (!fs.existsSync(journal)) return fail(refusal('journal-missing', journal), 1);
    journalStat = fs.statSync(journal);
  } catch (e) {
    return fail(refusal('journal-unreadable', `${journal} (${e.code || e.message})`), 1);
  }
  if (!journalStat.isFile()) return fail(refusal('journal-unreadable', `${journal} is not a plain file`), 1);
  const launches = readLaunches(journal);
  if (launches.refusal) return fail(launches.refusal, 1);
  const { all, valid, invalid } = launches;
  const loaded = loadPlans(plansFile);
  if (loaded.refusal) return fail(loaded.refusal, 1);

  const sinceMs = o.since === undefined ? null : Date.parse(o.since);
  const scoped = sinceMs === null ? valid : valid.filter(rec => rec.startedMs !== null && rec.startedMs >= sinceMs);
  const ctx = {
    repoRoot, cwd, journal, generated: new Date(o.now || Date.now()).toISOString(), since: o.since || null,
    scope: o.since ? `valid launches started at or after ${o.since}` : 'all valid launches in the journal',
    records: all.length, launches: scoped.length, invalid,
    inputs: [['the records directory', path.dirname(journal)], ['the journal', journal], ['the plans file', plansFile]],
    outputDirs: [], outputSuffixes: OUTPUT_SUFFIX_DEFAULT,
  };
  if (o.outMd !== undefined || o.outJson !== undefined) {
    const outputs = loadOutputs(deps.outputsFile || DEFAULT_OUTPUTS, repoRoot);
    if (outputs.refusal) return fail(outputs.refusal, 1);
    ctx.outputDirs = outputs.directories;
    ctx.outputSuffixes = outputs.suffixes;
  }
  const result = build(scoped, loaded.plans, ctx);
  // The undated count names every valid record without a proven start, including records a --since run cannot place.
  result.undated = valid.filter(rec => rec.day === null).length;
  const md = markdown(result, ctx);
  const json = jsonReport(result, ctx);

  const plans = [];
  if (o.outMd !== undefined) {
    const p = outPlan(o.outMd, ctx);
    if (p.problem) return fail(refusal('out-md-refused', p.problem), 1);
    plans.push(['md', p.target, Buffer.from(md, 'utf8')]);
  }
  if (o.outJson !== undefined) {
    const p = outPlan(o.outJson, ctx);
    if (p.problem) return fail(refusal('out-json-refused', p.problem), 1);
    plans.push(['json', p.target, Buffer.from(`${JSON.stringify(json, null, 2)}\n`, 'utf8')]);
  }
  if (plans.length === 2 && pathSafe.sameFileOrNested(plans[0][1], plans[1][1])) return fail(refusal('out-paths-equal', '--out-md and --out-json name one file; nothing was written'), 1);
  // Every guard runs before the first write, so a refused second path leaves no partial report behind.
  for (const [kind, target, bytes] of plans) {
    const written = pathSafe.writeAtomicGuarded(target, bytes, { root: repoRoot });
    if (!written.ok) return fail(refusal(`out-${kind}-write`, `${written.reason}: ${written.detail}`), 1);
  }
  const written = plans.map(p => p[0]).join(',');
  // F06: stdout holds exactly one document. A status line is never mixed into --json output; it goes to stderr.
  if (o.json) process.stdout.write(`${JSON.stringify(json, null, 2)}\n`);
  else if (!written) process.stdout.write(md);
  if (written) process.stderr.write(`wrote ${written} launches=${scoped.length}\n`);
  return 0;
}

module.exports = {
  main, percentile, verdictOf, endedOf, normalizeRecord, invalidReasonOf, unfinishedVerdictOf,
  tokenSnapshotOf, aggregate, build, outPlan, loadOutputs, markdown, jsonReport, loadPlans, loadJournal, cell,
  isoProblem, planRows, groupBy, rawRecordProblems, deriveTotal, LIMIT_CLASS, VERDICTS, readLaunches,
};
if (require.main === module) process.exitCode = main(process.argv.slice(2));

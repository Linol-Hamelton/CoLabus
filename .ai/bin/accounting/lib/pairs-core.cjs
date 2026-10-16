'use strict';
// pairs-core: the pure core of the pairs recorder (PROTO-DEC-0143 item 3, 0144 item 3, 0145, 0173 item 1g). It turns one launch record and the
// resolver shadow record of the same launch into one pair-record/1 (recommendation, assignment, selector, outcome), decides the gate (clean or
// quarantined, with reason codes), names the epoch and checks a record or an epoch ledger line (schema, privacy, advice). It reads no data file and
// writes no file: the readers and the one guarded writer are in lib/pairs-io.cjs and lib/pairs-write.cjs.
// Rules: unknown is null and never zero; nothing of the launch that is free text or a path is copied; a time or a name that is missing stays missing;
// a text that does not have the shape of its field is unknown (null), not copied.

const path = require('node:path');
const fs = require('node:fs');
const { canonicalJson, sha256 } = require('./canon.cjs');
const { validate } = require('./schema-check.cjs');
const { secretIn } = require('../launch-record-validate.cjs');

const SCHEMA = 'pair-record/1';
const EPOCH_SCHEMA = 'pair-epoch/1';
const SCHEMA_DIR = path.join(__dirname, '..', 'schema');
// A role that is expected to end with a verdict token (the launch record of the roles auditor, certifier, reviewer, expert). Any other
// role is not expected to give one, so a missing verdict there is not a failure to give one.
const VERDICT_ROLES = new Set(['auditor', 'certifier', 'reviewer', 'expert']);
const VERDICTS = new Set(['PASS', 'RECOMMENDATION', 'FAIL', 'BLOCKED']);
const SERVED_SOURCES = new Set(['agent-result', 'client-banner', 'client-log']);
const SERVED_CONFIDENCE = new Set(['exact', 'derived']);
const COST_BASES = new Set(['priced', 'subscription', 'unknown']);
const CODES = ['TEST_RECORD', 'CONFLICT', 'NO_RECOMMENDATION', 'NO_SNAPSHOT', 'BAD_VERSION', 'NO_SELECTOR', 'NO_PROMPT_HASH', 'NO_TIMES', 'TIME_ORDER', 'RECOMMENDATION_STALE'];
// PROTO-DEC-0144 item 3: the time order is recommendation R < assignment A < outcome O, strictly. R equal to A, or A before R, is not clean. A
// recommendation made longer than this before the assignment started is stale (it was not the answer to the situation of the launch).
const RECOMMENDATION_MAX_AGE_MS = 10 * 60 * 1000;
const TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
// Shapes of the fields. The same patterns are in schema/pair-record.json and schema/pair-epoch.json.
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.:+/@#~-]{0,119}$/; // a client, model, effort, route or id: no space, so no sentence
const DISPLAY_RE = /^[A-Za-z0-9][A-Za-z0-9 _.&+-]{0,59}$/; // a maker name (never printed by the report)
const TOKEN_RE = /^[A-Za-z0-9_.:+-]{1,80}$/;
const LABEL_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;
const LADDER_VERSION_RE = /^[a-z][a-z0-9-]*\/\d+@\d{4}-\d{2}-\d{2}#sha256:([0-9a-f]{16})$/;
const REGISTRY_VERSION_RE = /^[a-z0-9-]+\/\d+@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z#sha256:[0-9a-f]{16}$/;
const SV_RE = /^[a-z0-9-]+\/\d+$/;

const isStr = v => typeof v === 'string' && v.trim() !== '';
const isInt = v => Number.isInteger(v);
const isCount = v => Number.isSafeInteger(v) && v >= 0;
const timeOf = v => (typeof v === 'string' && TIME_RE.test(v) && !Number.isNaN(Date.parse(v)) ? v : null);
const ms = v => { if (!v) return null; const t = Date.parse(v); return Number.isNaN(t) ? null : t; };
const nameOf = (v, max) => (typeof v === 'string' && v.length <= max && NAME_RE.test(v) ? v : null);
const displayOf = v => (typeof v === 'string' && DISPLAY_RE.test(v) ? v : null);
const tok = v => (typeof v === 'string' && TOKEN_RE.test(v) ? v : null);
const ver = v => (typeof v === 'string' && v.length <= 120 && /^[A-Za-z0-9_.:@#+/-]+$/.test(v) ? v : null);
const tierOf = v => (typeof v === 'string' && /^T[1-9]$/.test(v) ? v : null);
const label = v => (typeof v === 'string' && LABEL_RE.test(v) ? v : null);
const hashOf = v => { const m = typeof v === 'string' ? /^(?:sha256:)?([0-9a-f]{64})$/.exec(v) : null; return m ? m[1] : null; };
const snapshotOf = v => { const m = typeof v === 'string' ? LADDER_VERSION_RE.exec(v) : null; return m ? m[1] : null; };

const normModel = s => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');
/**
 * Compare two model names after normalisation (case and punctuation removed). A route alias may carry a vendor prefix of the same name
 * (zai-glm-5-3 and glm-5-3), so a longer name that ends with the whole shorter one (at least four characters) is the same model.
 * @returns {boolean|null} null when either name is unknown
 */
function sameModel(a, b) {
  if (!isStr(a) || !isStr(b)) return null;
  const x = normModel(a); const y = normModel(b);
  if (!x || !y) return null;
  if (x === y) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  return short.length >= 4 && long.endsWith(short);
}
const sameText = (a, b) => (isStr(a) && isStr(b) ? a.trim().toLowerCase() === b.trim().toLowerCase() : null);

/**
 * The epoch. EXACTLY these fields start a new epoch (PROTO-DEC-0144 item 3): the ladder version (with its snapshot hash), the class registry version,
 * the selector tuple (client, model, effort) and the selector prompt hash. Nothing else does: not the assigned tuple (the comparison is between
 * assignments) and not the hash of the task prompt of a launch (every launch has its own).
 */
function epochOf(f) {
  const t = f.selectorTuple || {};
  const e = {
    ladderVersion: f.ladderVersion || null, classRegistryVersion: f.classRegistryVersion || null,
    selectorTuple: { client: t.client || null, model: t.model || null, effort: t.effort || null }, selectorPromptSha256: f.selectorPromptSha256 || null,
  };
  return { id: `E-${sha256(canonicalJson(e)).slice(0, 10)}`, ...e };
}

/** The class registry version that was current at the launch: the registry file is the current one, so it is known only for a launch after its generation time. */
function registryVersionFor(registry, startedAt) {
  if (!registry || !timeOf(registry.generatedAt) || !/^[0-9a-f]{16}$/.test(registry.sha16 || '') || !startedAt) return null;
  if (registry.sv !== undefined && registry.sv !== null && !SV_RE.test(registry.sv)) return null;
  if (Date.parse(registry.generatedAt) > Date.parse(startedAt)) return null;
  return `${registry.sv || 'model-classes/1'}@${registry.generatedAt}#sha256:${registry.sha16}`;
}

function routeOf(o) {
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null;
  const tier = Number.isInteger(o.tier) && o.tier >= 0 && o.tier <= 99 ? o.tier : null;
  const r = { maker: displayOf(o.maker || o.provider), client: nameOf(o.client, 60), model: nameOf(o.model, 120), effort: nameOf(o.effort, 40), tier, id: nameOf(o.id || o.rung, 80) };
  return r.client || r.model ? r : null;
}

function recommendationOf(s, linkBasis) {
  const r = s.resolver && typeof s.resolver === 'object' ? s.resolver : {};
  const mo = r.makerOrder && typeof r.makerOrder === 'object' ? { key: tok(r.makerOrder.key), date: typeof r.makerOrder.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.makerOrder.date) ? r.makerOrder.date : null } : null;
  const ladderVersion = ver(r.ladderVersion);
  return {
    source: 'resolver-shadow', linkBasis: linkBasis === 'name+time' ? 'name+time' : 'launchId', at: timeOf(s.at), launcher: label(s.launcher),
    choice: routeOf(r.choice), candidates: (Array.isArray(r.candidates) ? r.candidates : []).slice(0, 20).map(routeOf).filter(Boolean),
    reason: tok(r.reason), error: tok(r.error), terminal: tok(r.terminal), ladderVersion, snapshotHash: snapshotOf(ladderVersion), makerOrder: mo,
  };
}

/** The selector (who or what chose the route) exactly as the shadow record names it. A record that names none leaves every field null: it is never inferred from the presence of a shadow record. */
function selectorOf(s) {
  const o = s && s.selector && typeof s.selector === 'object' && !Array.isArray(s.selector) ? s.selector : {};
  const sel = { client: nameOf(o.client, 60), model: nameOf(o.model, 120), effort: nameOf(o.effort, 40), promptSha256: hashOf(o.promptSha256) };
  return { ...sel, source: Object.values(sel).some(v => v !== null) ? 'shadow-record' : null };
}

/**
 * Token figures of a launch record. A component is a known number only when it is a non-negative safe integer; a present component that is negative,
 * fractional, not finite or not a number is null (it is wrong, not zero) and the total is then unknown (null), never a computed number. A component that
 * is absent or null is not given (it adds nothing, it is not a bad one). A total of 0 is a legacy "unknown".
 * @returns {{total: number|null, input: number|null, output: number|null, cacheRead: number|null, cacheWrite: number|null, source: string|null}|null} null when no figure is known
 */
function tokensOf(t) {
  const none = { total: null, input: null, output: null, cacheRead: null, cacheWrite: null, source: null };
  if (typeof t === 'number') return isCount(t) && t > 0 ? { ...none, total: t } : null;
  if (!t || typeof t !== 'object' || Array.isArray(t)) return null;
  const out = { ...none, source: typeof t.source === 'string' && TOKEN_RE.test(t.source) ? t.source.slice(0, 60) : null };
  let bad = false;
  for (const k of ['total', 'input', 'output', 'cacheRead', 'cacheWrite']) {
    const v = t[k];
    if (v === undefined || v === null) continue;
    if (isCount(v)) out[k] = v; else bad = true;
  }
  if (bad) out.total = null;
  else if (out.total === null && out.input !== null && out.output !== null) {
    const sum = out.input + out.output + (out.cacheRead || 0) + (out.cacheWrite || 0);
    out.total = Number.isSafeInteger(sum) && sum > 0 ? sum : null;
  } else if (out.total === 0) out.total = null;
  return Object.values(out).slice(0, 5).every(v => v === null) ? null : out;
}

function costOf(c) {
  if (typeof c === 'number') return Number.isFinite(c) && c > 0 ? { usd: c, basis: null } : null;
  if (!c || typeof c !== 'object' || Array.isArray(c)) return null;
  const basis = COST_BASES.has(c.basis) ? c.basis : null;
  const good = typeof c.usd === 'number' && Number.isFinite(c.usd);
  if (basis === 'priced') return good && c.usd >= 0 ? { usd: c.usd, basis } : { usd: null, basis: 'unknown' };
  if (basis === 'subscription' || basis === 'unknown') return { usd: null, basis };
  return good && c.usd > 0 ? { usd: c.usd, basis: null } : null;
}

function durationOf(l, startedAt, endedAt) {
  if (typeof l.wallSeconds === 'number' && Number.isFinite(l.wallSeconds) && l.wallSeconds >= 0) return l.wallSeconds;
  if (startedAt && endedAt && ms(endedAt) >= ms(startedAt)) return (ms(endedAt) - ms(startedAt)) / 1000;
  return null;
}

function verdictOf(l, role) {
  const token = [l.verdict, l.reviewOutcome].find(v => VERDICTS.has(v));
  if (token) return token;
  if (l.verdict === 'NONE' || l.reviewOutcome === 'NONE' || l.failureClass === 'NO_VERDICT') return 'NO_VERDICT';
  return VERDICT_ROLES.has(role) ? 'NO_VERDICT' : null;
}

function matchOf(rec, a) {
  const none = { match: 'unknown', effortMatch: 'unknown' };
  if (!rec || !rec.choice || !rec.choice.client || !rec.choice.model || !a.client || !a.model) return none;
  const model = sameModel(rec.choice.model, a.model);
  const client = sameText(rec.choice.client, a.client);
  if (model === null || client === null) return none;
  const match = model && client ? 'yes' : 'no';
  const eff = sameText(rec.choice.effort, a.effort);
  return { match, effortMatch: eff === null ? 'unknown' : eff ? 'yes' : 'no' };
}

const slugOf = launchId => String(launchId).replace(/^L-\d{8}T\d{6}Z-/, '');

/**
 * The gate of PROTO-DEC-0144 item 3, recomputed from the record itself (a stored gate is never trusted; a stored CONFLICT only adds).
 * Clean needs: a recommendation with a ladder version of the right shape and its snapshot hash, the selector (client and model) and its prompt hash,
 * all three times and R < A < O strictly with R not older than the tolerance, and no test record. The selector codes are judged only when there is a recommendation.
 */
function gateOf(pair) {
  const codes = new Set();
  if (/^(test|fixture)(-|$)/.test(slugOf(pair.launchId))) codes.add('TEST_RECORD');
  if (pair.isolation && Array.isArray(pair.isolation.codes) && pair.isolation.codes.includes('CONFLICT')) codes.add('CONFLICT');
  const rec = pair.recommendation;
  if (!rec) codes.add('NO_RECOMMENDATION');
  else {
    if (rec.ladderVersion === null || rec.ladderVersion === undefined) codes.add('NO_SNAPSHOT');
    else if (snapshotOf(rec.ladderVersion) === null || rec.snapshotHash !== snapshotOf(rec.ladderVersion)) codes.add('BAD_VERSION');
    const sel = pair.selector || {};
    if (!sel.client || !sel.model) codes.add('NO_SELECTOR');
    if (!sel.promptSha256) codes.add('NO_PROMPT_HASH');
  }
  const a = ms(pair.startedAt); const o = ms(pair.endedAt); const r = rec ? ms(rec.at) : null;
  if (a === null || o === null || (rec && r === null)) codes.add('NO_TIMES');
  if ((r !== null && a !== null && r >= a) || (a !== null && o !== null && a >= o) || (r !== null && o !== null && r >= o)) codes.add('TIME_ORDER');
  else if (r !== null && a !== null && a - r > RECOMMENDATION_MAX_AGE_MS) codes.add('RECOMMENDATION_STALE');
  const ordered = CODES.filter(c => codes.has(c));
  return { gate: ordered.length ? 'quarantined' : 'clean', codes: ordered };
}

function isolationOf(pair) {
  const g = gateOf(pair);
  const known = pair.recommendation && ms(pair.startedAt) !== null && ms(pair.endedAt) !== null && ms(pair.recommendation.at) !== null;
  const order = g.codes.includes('TIME_ORDER') ? 'violated' : g.codes.includes('RECOMMENDATION_STALE') ? 'stale' : known ? 'recommendation<assignment<outcome' : 'unknown';
  return { ...g, origin: g.codes.includes('TEST_RECORD') ? 'test' : 'live', order };
}

/**
 * One pair from one launch (merged events) and its shadow record (or null).
 * @param {{launch: object, shadow: object|null, linkBasis: string|null, machine: string, registry: object|null, conflict?: boolean}} ctx
 */
function buildPair(ctx) {
  const l = ctx.launch; const s = ctx.shadow || null;
  const t = l.tuple && typeof l.tuple === 'object' ? l.tuple : {};
  const startedAt = timeOf(l.startedAt); const endedAt = timeOf(l.endedAt);
  const role = label(l.role) || (s ? label(s.role) : null);
  const recommendation = s ? recommendationOf(s, ctx.linkBasis) : null;
  const selector = selectorOf(s);
  const assignment = { client: nameOf(t.client, 60), model: nameOf(t.model, 120), effort: nameOf(t.effort, 40), route: nameOf(l.route, 120) };
  const servedOk = isStr(l.servedModel) && SERVED_SOURCES.has(l.servedModelSource);
  const served = servedOk ? nameOf(l.servedModel, 120) : null;
  const sm = served && assignment.model ? sameModel(served, assignment.model) : null;
  const m = matchOf(recommendation, assignment);
  const pair = {
    schema: SCHEMA, pairId: `PR-${String(l.launchId).slice(2)}`, launchId: l.launchId, machine: ctx.machine,
    epoch: epochOf({
      ladderVersion: recommendation && snapshotOf(recommendation.ladderVersion) !== null ? recommendation.ladderVersion : null, classRegistryVersion: registryVersionFor(ctx.registry, startedAt),
      selectorTuple: selector, selectorPromptSha256: selector.promptSha256,
    }),
    taskClass: tierOf(s && s.taskClass) || tierOf(l.tier), recordClass: label(l.taskClass), role, startedAt, endedAt,
    recommendation, selector,
    assignment: {
      ...assignment, promptSha256: hashOf(l.promptSha256), servedModel: served, servedModelSource: served ? l.servedModelSource : null,
      servedModelConfidence: served && SERVED_CONFIDENCE.has(l.servedModelConfidence) ? l.servedModelConfidence : null,
      servedMatchesRequested: sm === null ? 'unknown' : sm ? 'yes' : 'no',
    },
    outcome: {
      verdict: verdictOf(l, role), verdictExpected: role ? VERDICT_ROLES.has(role) : null, exitCode: isInt(l.exitCode) ? l.exitCode : null,
      failureClass: typeof l.failureClass === 'string' && /^[A-Z_]{2,24}$/.test(l.failureClass) ? l.failureClass : null,
      durationSeconds: durationOf(l, startedAt, endedAt), tokens: tokensOf(l.tokens), cost: costOf(l.cost),
    },
    match: m.match, effortMatch: m.effortMatch,
  };
  pair.isolation = isolationOf(ctx.conflict ? { ...pair, isolation: { codes: ['CONFLICT'] } } : pair);
  return pair;
}

// ---- privacy and advice ----
const PATH_RES = [
  [/(?<![A-Za-z0-9])[A-Za-z]:[\\/]/, 'a drive path'], [/[\\/]Users[\\/]/i, 'a user folder path'], [/[\\/]home[\\/][^\\/\s]/, 'a home folder path'],
  [/^~[\\/]/, 'a home shortcut path'], [/^\\\\[A-Za-z0-9_.-]+\\/, 'a network share path'],
];
// A phrase that tells the owner what to do with the selection layer. Data fields never carry one, and the report never prints one: it states what the
// data can and cannot support and the owner decides (PROTO-DEC-0143 item 3). Separators of any kind (space, dash, underscore, dot) count as a gap.
const ADVICE_RES = [
  /(?:^|[^a-z])(?:should|must|ought|need|needs|please|recommend|recommended|advise|advised)[^a-z]+(?:to[^a-z]+)?(?:switch|change|move|migrate|replace|go)(?:$|[^a-z])/i,
  /(?:^|[^a-z])switch(?:es|ed|ing)?[^a-z]+(?:to|now|over|on|the|our|selection)(?:$|[^a-z])/i,
  /(?:^|[^a-z])(?:now|then|immediately)[^a-z]+switch(?:$|[^a-z])/i,
  /переключ|перейти на|рекомендуем перейти|следует перейти/i,
];
function walkStrings(value, at, visit) {
  (function walk(v, where) {
    if (typeof v === 'string') visit(v, where);
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${where}[${i}]`));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { walk(k, `${where}.<key>`); walk(x, `${where}.${k}`); }
  })(value, at);
}
/** Problems of a value: a personal or machine path, or a secret-shaped string, anywhere in it (keys included). */
function privacyProblems(value, at = '$') {
  const out = [];
  walkStrings(value, at, (v, where) => {
    for (const [re, what] of PATH_RES) if (re.test(v)) { out.push(`${where}: personal or machine path (${what})`); break; }
    if (secretIn(v)) out.push(`${where}: a secret-shaped string`);
  });
  return out;
}
/** Problems of a value: a sentence that tells the owner to switch, anywhere in it (keys included). */
function adviceProblems(value, at = '$') {
  const out = [];
  walkStrings(value, at, (v, where) => { if (ADVICE_RES.some(re => re.test(v))) out.push(`${where}: a text that advises a switch (content not shown)`); });
  return out;
}
/** A text that may reach the output: itself when it is clean, else a fixed marker. */
const outText = v => (typeof v === 'string' && !privacyProblems(v).length && !adviceProblems(v).length ? v : '[withheld]');

const schemaCache = {};
const schemaOf = name => { if (!schemaCache[name]) schemaCache[name] = JSON.parse(fs.readFileSync(path.join(SCHEMA_DIR, name), 'utf8')); return schemaCache[name]; };
const badTimes = (pairs) => pairs.filter(([, v]) => v !== null && v !== undefined && ms(v) === null).map(([k]) => `${k}: not a real date`);

/** Schema errors, real dates, the epoch against its own fields, privacy and advice problems; empty when the record may be written or reported. */
function validatePair(pair) {
  const errors = validate(schemaOf('pair-record.json'), pair);
  if (errors.length) return [...errors, ...privacyProblems(pair), ...adviceProblems(pair)];
  const problems = [...badTimes([['startedAt', pair.startedAt], ['endedAt', pair.endedAt], ['recordedAt', pair.recordedAt], ['recommendation.at', pair.recommendation && pair.recommendation.at]])];
  const rec = pair.recommendation;
  const wantLadder = rec && snapshotOf(rec.ladderVersion) !== null ? rec.ladderVersion : null;
  const e = pair.epoch;
  if (e.ladderVersion !== wantLadder) problems.push('epoch.ladderVersion: is not the version of the recommendation');
  if (!(e.selectorTuple.client === pair.selector.client && e.selectorTuple.model === pair.selector.model && e.selectorTuple.effort === pair.selector.effort && e.selectorPromptSha256 === pair.selector.promptSha256)) problems.push('epoch: the selector is not the selector of the pair');
  if (epochOf(e).id !== e.id) problems.push('epoch.id: is not the id of its fields');
  return [...problems, ...privacyProblems(pair), ...adviceProblems(pair)];
}

/** The same checks for one pair-epoch/1 line of the epoch ledger (a line that fails is never used and never printed). */
function validateEpoch(line) {
  const errors = validate(schemaOf('pair-epoch.json'), line);
  if (errors.length) return [...errors, ...privacyProblems(line), ...adviceProblems(line)];
  const problems = [...badTimes([['firstStartedAt', line.firstStartedAt], ['recordedAt', line.recordedAt], ['evidence.registryGeneratedAt', line.evidence.registryGeneratedAt]])];
  if (epochOf(line).id !== line.epochId) problems.push('epochId: is not the id of its fields');
  return [...problems, ...privacyProblems(line), ...adviceProblems(line)];
}

/** Events of one launch in source order -> one launch object; the first start line wins, a different second start line is a conflict. */
function mergeEvents(lines) {
  let base = null; let conflict = false; const events = [];
  for (const rec of lines) {
    if (rec.event === 'finished' || rec.event === 'review') events.push(rec);
    else if (!base) base = rec;
    else if (canonicalJson(base) !== canonicalJson(rec)) conflict = true;
  }
  const merged = { ...(base || {}) };
  for (const e of events) {
    const { schema, launchId, event, startedAt, tuple, ...rest } = e; // an event never changes what was assigned or when it started
    if (e.event === 'review') delete rest.endedAt; // the time of a review is not the end of the launch
    Object.assign(merged, rest);
  }
  merged.launchId = lines[0].launchId;
  return { launch: merged, conflict };
}

module.exports = {
  SCHEMA, EPOCH_SCHEMA, CODES, VERDICT_ROLES, RECOMMENDATION_MAX_AGE_MS, LADDER_VERSION_RE, REGISTRY_VERSION_RE, SV_RE, HEX64_RE, normModel, sameModel, epochOf, registryVersionFor, buildPair, gateOf, isolationOf,
  privacyProblems, adviceProblems, outText, validatePair, validateEpoch, mergeEvents, timeOf, snapshotOf, canonicalJson, sha256, slugOf,
};

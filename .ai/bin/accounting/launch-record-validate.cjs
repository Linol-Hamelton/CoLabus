'use strict';
// launch-record-validate.cjs - checks and merges launch records (PROTO-DEC-0145).
// Spec: launches/LAUNCH-RECORD-EXT.md. Class B tool: outside .ai/, writes nothing under .ai/
// and never touches docs/ops/model-ladder.json (PROTO-DEC-0143 item 3). Reads files only, except `merge --apply`.
//   node launch-record-validate.cjs check <file-or-dir> [--journal <LAUNCHES.jsonl>]
//   node launch-record-validate.cjs merge <buffer-dir> --journal <LAUNCHES.jsonl> [--apply]
// Exit: 0 valid / merged; 1 invalid records or a refused merge; 2 unusable input.
// A line is one of: a full record (has startedAt, no event), event "started" (has startedAt), event "finished" or "review"
// (no startedAt). launchId repeats across events. The journal is append-only: a merge never rewrites an existing line.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { writeFileAtomic } = require('./lib/atomic.cjs');
const { secretIn } = require('../lib/secrets.cjs');
const { launchNameProblem } = require('../lib/launch-name.cjs');

const SCHEMA = 'launch-record/1';
const EVENTS = new Set(['started', 'finished', 'review']);
const OUTCOMES = new Set(['PASS', 'RECOMMENDATION', 'FAIL', 'BLOCKED', 'NONE']);
// LAUNCH-RELIABILITY: TRANSPORT_EXHAUSTED: the bounded transport retry of seat-failover ran out; WAKEUP_TOOL: the client called its wakeup or pause
// tool and its run ended there; IDLE: no output and no worktree change past the idle limit of launch-wrapper (a waiting permission prompt looks the same).
// APPROVAL_STALL: a failed launch whose output ends on a permission prompt (AUTO-APPROVE, docs/ops/approval-stall.cjs).
// SERVED_FAMILY_MISMATCH: the same, and the maker families of the requested and the proven model are both known and differ (PROBE-SERVED-MODEL; the free Nemotron route that answered as DeepSeek, 2026-10-28).
// PARTIAL: the certifier report keeps an audit item open that could block (certifier budget); it never certifies.
// PROXY_DROP: the proxied launch ended on a proxy transport drop (PROXY-HEALTH; the proxy tracker of .ai/bin/ops-tools/proxy-health.cjs).
const FAILURE_CLASSES = new Set(['STALL', 'TRANSPORT', 'QUOTA', 'AUTH', 'CONTENT', 'ORPHAN', 'INTERRUPTED', 'UNKNOWN', 'NO_VERDICT', 'TURN_LIMIT', 'APPROVAL_STALL', 'SERVED_MODEL_MISMATCH', 'SERVED_FAMILY_MISMATCH', 'TRANSPORT_EXHAUSTED', 'WAKEUP_TOOL', 'IDLE', 'PARTIAL', 'PROXY_DROP']);
const VARIANTS = new Set(['A', 'B', 'none', 'inline', 'pointer']);
const PAIRS = new Set(['implementer-execute', 'reviewer-accept', 'coordinator-dispatch']);
const CONFIDENCE = new Set(['exact', 'derived', 'inferred', 'unknown']);
// PROTO-DEC-0169 item 4: the served model comes from a source outside the report; see LAUNCH-RECORD-EXT.md.
const SERVED_SOURCES = new Set(['agent-result', 'client-banner', 'client-log', 'launcher-model', 'none']);
const SERVED_CONFIDENCE = new Set(['exact', 'derived', 'none']);
// Launch record extension: how the requested model reached the client, the launch's role, and the source of its cost (derived from cost.basis).
const REQUEST_VIA = new Set(['flag', 'alias-env', 'not-passed']);
const LAUNCH_ROLES = new Set(['author', 'certifier', 'pre-review', 'unknown']);
const COST_SOURCES = new Set(['api-price-table', 'subscription', 'unknown']);
const COST_SOURCE_OF_BASIS = { priced: 'api-price-table', subscription: 'subscription', unknown: 'unknown' };
const STAGES = new Set(['intake', 'frame', 'triage', 'dispatch', 'execute', 'accept', 'freeze', 'close', 'session', 'research', 'any', 'unknown']);

const isStr = v => typeof v === 'string' && v.length > 0;
const isInt = (v, min = 0) => Number.isInteger(v) && v >= min;
const isTime = v => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(v) && !Number.isNaN(Date.parse(v));
const isHash = v => typeof v === 'string' && /^(sha256:)?[0-9a-f]{64}$/.test(v);
const isObj = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// tokens / cost objects (cost-record; docs/product/launch-records/launches/LAUNCH-RECORD-EXT.md). The plain legacy values
// (null, an integer tokens, a number cost) stay valid; an OBJECT must have the exact shape, so a typo or a zero for an unknown cannot be data.
const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning', 'total', 'source', 'note'];
const COST_KEYS = ['usd', 'basis', 'priceSnapshot', 'formula', 'note', 'reason', 'model', 'clientReportedUsd', 'clientCostBasis', 'listEquivalentUsd'];
const COST_BASIS = ['priced', 'subscription', 'unknown'];
function tokensProblems(v) {
  if (!isObj(v)) return [];
  const p = Object.keys(v).filter(k => !TOKEN_KEYS.includes(k)).map(k => `unknown tokens field "${k}"`);
  for (const k of TOKEN_KEYS.slice(0, 6)) if (Object.hasOwn(v, k) && v[k] !== null && !isInt(v[k])) p.push(`tokens.${k} must be a non-negative integer or null`);
  if (!isStr(v.source)) p.push('tokens.source must name where the numbers came from');
  if (Object.hasOwn(v, 'note') && !isStr(v.note)) p.push('tokens.note must be a string');
  return p;
}
function costProblems(v) {
  if (!isObj(v)) return [];
  const p = Object.keys(v).filter(k => !COST_KEYS.includes(k)).map(k => `unknown cost field "${k}"`);
  if (!COST_BASIS.includes(v.basis)) { p.push('cost.basis must be priced | subscription | unknown'); return p; }
  if (v.usd !== null && !(typeof v.usd === 'number' && Number.isFinite(v.usd) && v.usd >= 0)) p.push('cost.usd must be null or a number >= 0');
  for (const k of ['clientReportedUsd', 'listEquivalentUsd']) if (Object.hasOwn(v, k) && !(typeof v[k] === 'number' && Number.isFinite(v[k]) && v[k] >= 0)) p.push(`cost.${k} must be a number >= 0`);
  if (v.basis === 'priced') {
    if (typeof v.usd !== 'number') p.push('a priced cost needs a number usd');
    if (!isObj(v.priceSnapshot) || !isStr(v.priceSnapshot.id) || !isStr(v.priceSnapshot.hash)) p.push('a priced cost needs priceSnapshot {id, hash}');
    if (!isStr(v.formula)) p.push('a priced cost needs its formula');
  } else {
    if (v.usd !== null) p.push(`cost basis ${v.basis} has usd null: an unknown or flat-fee cost is never written as a number (never zero)`);
    if (v.basis === 'unknown' && !isStr(v.reason)) p.push('an unknown cost says why (reason)');
  }
  return p;
}

// Secret shapes: a provider key, a bearer token, a private key block, an assignment of a secret-looking variable.
const NOTE_MAX = 240;
const NOTE_FIELDS = ['note', 'costNote', 'startedAtNote', 'endedAtNote', 'exitCodeNote', 'logNote'];
const PERSONAL_PATH = /(?:\b[A-Za-z]:)?(?:\\\\|\\|\/)(?:Users|home)(?:\\\\|\\|\/)(?!<)(?:[^\\/\s"'<>]|'+(?![',.;:!?)\]}]*(?:[\s"<>]|$)))/iu;
// A redacted profile segment is the whole segment. The note rule of an earlier release stopped at whitespace and at a quote, so its records may hold `<user>` and
// then prose (`<user> due to timeout`) or a closing quote with closing punctuation (`'<user>', see`), and a host that upgrades keeps them valid. Refused, whatever
// the name holds: text glued to `<user>`; apostrophes glued to it and then anything but closing punctuation before a space, a quote or the end (`<user>'Arcy`,
// `<user>'_Alice`, `<user>'` and a separator); a spaced tail, apostrophes included, that runs on to a separator in the same segment and ends there in a name
// character and any apostrophes (`<user> O'Brien'` and a separator); a home segment that starts with apostrophes the same way (PERSONAL_PATH). Each is the rest
// of a profile name. A name never holds a colon, so a drive path stops a tail; a separator after a space, or after a quote that follows one, is no name.
const PARTIAL_PROFILE = /(?:\\\\|\\|\/)(?:Users|home)(?:\\\\|\\|\/)<user>(?:[^\s\\/"'<>]|'+(?![',.;:!?)\]}]*(?:[\s"<>]|$))|\s+[^\\/"<>:\r\n]*[^\s\\/"'<>:]'*[\\/])/iu;
function personalPathIn(value) { return PERSONAL_PATH.test(String(value)) || PARTIAL_PROFILE.test(String(value)); }

// field -> [check, description]; each is optional unless marked in `required` below.
const BASE = {
  schema: [v => v === SCHEMA, `"${SCHEMA}"`],
  launchId: [v => isStr(v) && /^L-\d{8}T\d{6}Z-[a-z0-9-]+$/.test(v), 'L-<YYYYMMDDTHHMMSSZ>-<slug>'],
  wrapperLaunchId: [v => isStr(v) && /^[A-Za-z0-9._-]+@\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)
    && launchNameProblem(v.slice(0, v.indexOf('@'))) === null && isTime(v.slice(v.indexOf('@') + 1)), 'wrapper name joined to UTC start time'],
  event: [v => EVENTS.has(v), 'started | finished | review'],
  startedAt: [isTime, 'UTC time'],
  endedAt: [isTime, 'UTC time'],
  endedAtNote: [isStr, 'string'],
  startedAtNote: [isStr, 'string'],
  callerSession: [isStr, 'string'],
  channel: [v => v === 'catalog-layer', '"catalog-layer"'],
  task: [isStr, 'string'],
  promptPath: [isStr, 'repo path'],
  promptSha256: [isHash, 'sha256 hex'],
  tuple: [v => v && typeof v === 'object' && !Array.isArray(v) && isStr(v.client) && (v.model === null || isStr(v.model)) && (v.effort === null || isStr(v.effort))
    && Object.keys(v).every(k => ['client', 'model', 'effort'].includes(k)), '{client, model|null, effort|null}'],
  workdir: [isStr, 'string'],
  head: [v => isStr(v) && /^[0-9a-f]{7,40}$/.test(v), 'git sha'],
  treeState: [v => v === 'clean' || v === 'dirty', 'clean | dirty'],
  sandbox: [isStr, 'string'],
  calleeSession: [isStr, 'string'],
  exitCode: [v => v === null || Number.isInteger(v), 'integer | null'],
  exitCodeNote: [isStr, 'string'],
  outputs: [v => Array.isArray(v) && v.every(o => o && isStr(o.path) && (o.sha256 === undefined || isHash(o.sha256))), '[{path, sha256}]'],
  tokens: [v => v === null || isInt(v) || isObj(v), 'integer | object | null (an object is checked in detail below)'],
  cost: [v => v === null || (typeof v === 'number' && v >= 0) || isObj(v), 'number | object | null (an object is checked in detail below)'],
  costNote: [isStr, 'string'],
  logPath: [isStr, 'string'],
  logSha256: [isHash, 'sha256 hex'],
  logNote: [isStr, 'string'],
  viaDispatch: [v => typeof v === 'boolean', 'boolean'],
  backfilled: [v => typeof v === 'boolean', 'boolean'],
  verdict: [v => OUTCOMES.has(v), 'PASS | RECOMMENDATION | FAIL | BLOCKED | NONE'],
  note: [v => isStr(v) && v.length <= NOTE_MAX, `string of at most ${NOTE_MAX} characters`],
};
const closed = (v, keys) => isObj(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const FACTORS = ['protectedPaths', 'novelty', 'reversibility', 'ambiguity', 'coupling', 'independentJudgement'];
function launchTaskFrame(v) {
  return closed(v, ['schema', 'role', 'domain', 'riskClass', 'riskKnown', 'tier', 'complexity', 'unknown', 'policyHash', 'taskHash', 'base', 'head', 'pathsHash', 'pathCount', 'riskRules'])
    && v.schema === 'launch-task-frame/1' && /^[a-z-]{1,30}$/.test(v.role)
    && (v.domain === null || /^D-[A-Z]{2,4}$/.test(v.domain)) && ['A', 'B'].includes(v.riskClass) && typeof v.riskKnown === 'boolean'
    && /^T[1-9]$/.test(v.tier) && closed(v.complexity, FACTORS)
    && Object.values(v.complexity).every(n => n === null || Number.isInteger(n) && n >= 0 && n <= 2)
    && [v.unknown, v.riskRules].every(a => Array.isArray(a) && a.length <= 100 && a.every(s => typeof s === 'string' && /^[A-Za-z0-9-]{1,80}$/.test(s)))
    && [v.policyHash, v.pathsHash].every(s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s))
    && (v.taskHash === null || typeof v.taskHash === 'string' && /^[a-f0-9]{64}$/.test(v.taskHash))
    && [v.base, v.head].every(s => s === null || typeof s === 'string' && /^[a-f0-9]{40}$/.test(s)) && isInt(v.pathCount);
}
function launchSelectionShadow(v) {
  const base = ['schema', 'mode', 'launchAuthority', 'choice', 'source', 'reason', 'status'];
  return closed(v, Object.hasOwn(v || {}, 'advice') ? [...base, 'advice'] : base)
    && v.schema === 'launch-selection-shadow/1' && v.mode === 'shadow' && v.launchAuthority === false
    && (v.choice === null || closed(v.choice, ['client', 'model', 'effort']) && isStr(v.choice.client) && isStr(v.choice.model) && (v.choice.effort === null || isStr(v.choice.effort)))
    && [v.source, v.reason].every(s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(s))
    && ['recommended', 'no-recommendation', 'error'].includes(v.status)
    && (!Object.hasOwn(v, 'advice') || launchAdvice(v.advice));
}
function launchAdvice(v) {
  const token = s => typeof s === 'string' && /^[A-Za-z0-9_-]{1,80}$/.test(s);
  const route = (r, nullable = false) => closed(r, ['client', 'model', 'effort'])
    && ['client', 'model'].every(k => nullable && r[k] === null || isStr(r[k])) && (r.effort === null || isStr(r.effort));
  const codes = a => Array.isArray(a) && a.length <= 100 && a.every(token);
  const price = p => p === null || closed(p, ['platform', 'model', 'provider', 'snapshot'])
    && ['platform', 'model', 'snapshot'].every(k => isStr(p[k])) && (p.provider === null || isStr(p.provider));
  const rankedKeys = r => ['rank', 'client', 'model', 'effort', 'reasons', 'unknown',
    ...['costClass', 'estimatedCost', 'priceBasis'].filter(k => Object.hasOwn(r || {}, k))];
  const keys = ['schema', 'mode', 'modeReason', 'taskClass', 'recommended', 'actual', 'handOverride', 'deviationReason', 'ranked', 'unknown', 'status', 'reason'];
  return closed(v, Object.hasOwn(v || {}, 'excluded') ? [...keys, 'excluded'] : keys)
    && v.schema === 'launch-advice/1' && ['advise', 'assign'].includes(v.mode) && token(v.modeReason)
    && typeof v.taskClass === 'string' && /^[a-z-]+:[AB]:T[1-9]$/.test(v.taskClass)
    && (v.recommended === null || route(v.recommended)) && route(v.actual, true) && typeof v.handOverride === 'boolean'
    && token(v.deviationReason) && codes(v.unknown) && ['owner-choice', 'needs-operator-choice', 'requires-route-recheck'].includes(v.status) && token(v.reason)
    && (!Object.hasOwn(v, 'excluded') || Array.isArray(v.excluded) && v.excluded.length <= 10000 && v.excluded.every(r =>
      closed(r, ['client', 'model', 'effort', 'reasons']) && route({ client: r.client, model: r.model, effort: r.effort }) && codes(r.reasons)))
    && Array.isArray(v.ranked) && v.ranked.length <= 3 && v.ranked.every((r, i) => closed(r, rankedKeys(r))
      && r.rank === i + 1 && isStr(r.client) && isStr(r.model) && (r.effort === null || isStr(r.effort)) && codes(r.reasons) && codes(r.unknown)
      && (!Object.hasOwn(r, 'costClass') || token(r.costClass)) && (!Object.hasOwn(r, 'priceBasis') || price(r.priceBasis))
      && (!Object.hasOwn(r, 'estimatedCost') || r.estimatedCost === null || typeof r.estimatedCost === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(r.estimatedCost)));
}
// ASSIGN-EXECUTION (design of the development line, section 5): the authority of an assigned launch lives in this
// field only; selectionShadow stays non-authoritative. Closed schema in two shapes: a launch that was not assigned says why (skipped), an assigned one
// carries the whole decision. Historical records without the field stay unchanged. The raw lock token is never
// recorded, only its hash.
const ASSIGN_SKIPPED = new Set(['owner-explicit', 'class-not-enabled', 'hold', 'launcher-unsupported']);
const ASSIGN_STATUS = new Set(['running', 'done', 'failed', 'not-started']);
function launchAssign(v) {
  const token = s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,119}$/.test(s);
  const sha = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
  const nonNeg = n => Number.isInteger(n) && n >= 0;
  if (!isObj(v) || v.schema !== 'launch-assign/1' || !token(v.assignmentId) || typeof v.taskClass !== 'string' || !/^[a-z-]+:[AB]:T[1-9]$/.test(v.taskClass)) return false;
  if (Object.hasOwn(v, 'skipped')) return closed(v, ['schema', 'assignmentId', 'taskClass', 'skipped']) && ASSIGN_SKIPPED.has(v.skipped);
  const o = v.outcome;
  const ranking = Object.hasOwn(v, 'chosenRank');
  return closed(v, ['schema', 'assignmentId', 'taskClass', 'mode', 'modeSha256', 'stateSha256', 'policySha256', 'decidedAt', 'route', 'injected', 'source',
      'routeRecheck', 'caps', 'quota', 'intent', 'lock', 'outcome', ...(ranking ? ['chosenRank', 'skippedRanks'] : [])])
    && (!ranking || Number.isInteger(v.chosenRank) && v.chosenRank >= 1 && v.chosenRank <= 3 && Array.isArray(v.skippedRanks)
      && v.skippedRanks.length === v.chosenRank - 1 && v.skippedRanks.every((r, i) => closed(r, ['rank', 'route', 'reason']) && r.rank === i + 1
        && typeof r.route === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,299}$/.test(r.route) && token(r.reason)))
    && v.mode === 'assign' && v.source === 'assign' && [v.modeSha256, v.stateSha256, v.policySha256].every(sha) && isTime(v.decidedAt)
    && closed(v.route, ['client', 'model', 'effort']) && isStr(v.route.client) && isStr(v.route.model) && (v.route.effort === null || isStr(v.route.effort))
    && Array.isArray(v.injected) && v.injected.length <= 3 && v.injected.every(k => ['client', 'model', 'effort'].includes(k)) && new Set(v.injected).size === v.injected.length
    && closed(v.routeRecheck, ['recordSha256', 'at', 'servedModelProof']) && sha(v.routeRecheck.recordSha256) && isTime(v.routeRecheck.at) && typeof v.routeRecheck.servedModelProof === 'boolean'
    && closed(v.caps, ['client', 'clientCap', 'running', 'total']) && isStr(v.caps.client) && nonNeg(v.caps.running) && [v.caps.clientCap, v.caps.total].every(n => n === null || nonNeg(n))
    && closed(v.quota, ['status']) && token(v.quota.status)
    && closed(v.intent, ['eventId', 'writtenAt']) && token(v.intent.eventId) && isTime(v.intent.writtenAt)
    && closed(v.lock, ['heldMs', 'tokenSha256']) && nonNeg(v.lock.heldMs) && sha(v.lock.tokenSha256)
    && closed(o, ['status', 'failureClass', 'wallSeconds', 'verdicts', 'closedAt']) && ASSIGN_STATUS.has(o.status)
    && (o.failureClass === null || FAILURE_CLASSES.has(o.failureClass)) && (o.wallSeconds === null || typeof o.wallSeconds === 'number' && o.wallSeconds >= 0)
    && Array.isArray(o.verdicts) && o.verdicts.length <= 10 && o.verdicts.every(x => OUTCOMES.has(x)) && (o.closedAt === null || isTime(o.closedAt));
}
const EXT = {
  taskFrame: [launchTaskFrame, 'launch-task-frame/1'],
  selectionShadow: [launchSelectionShadow, 'launch-selection-shadow/1, no launch authority'],
  assignLaunch: [launchAssign, 'launch-assign/1 (closed: skipped, or the whole assigned decision)'],
  // Additive for historical catalog rows. RUNS.jsonl is a separate channel.
  selection: [v => ['owner', 'resolver', 'layer'].includes(v), 'owner | resolver | layer'],
  role: [isStr, 'string'],
  stage: [v => STAGES.has(v), 'a stage id'],
  taskClass: [isStr, 'string'],
  packetHash: [v => v === '' || isHash(v), 'sha256 hex or empty'],
  // Intake pins of the launchers (launch-record.cjs): the report path of the launch gate, the task file digest, the author-check receipt digest and head.
  reportPath: [v => isStr(v) && /^docs\/reviews\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(v), 'docs/reviews/<name>.md'],
  taskSha256: [isHash, 'sha256 hex'],
  receiptSha256: [isHash, 'sha256 hex'],
  receiptHead: [v => isStr(v) && /^[0-9a-f]{40}$/.test(v), 'full git sha'],
  packetProfile: [v => ['auto', '1', '2', '3', '4', 'full'].includes(v), 'auto | 1 | 2 | 3 | 4 | full'],
  reviewOutcome: [v => v === null || OUTCOMES.has(v), 'PASS | RECOMMENDATION | FAIL | BLOCKED | NONE | null'],
  route: [isStr, 'string'],
  // Launch isolation: the per-launch directory of the child's temp and caches (cert-launch.cjs, fix-launch.cjs; the wrapper records its own tempDir).
  workRootDir: [isStr, 'string'],
  riskClass: [v => v === 'A' || v === 'B', 'A | B'],
  tier: [v => /^T[1-9]$/.test(v), 'T1..T9'],
  attempt: [v => isInt(v, 1), 'integer >= 1'],
  attemptClass: [v => ['SUCCESS', 'AUTH', 'QUOTA', 'TRANSIENT', 'OTHER'].includes(v), 'SUCCESS | AUTH | QUOTA | TRANSIENT | OTHER'],
  retryOf: [v => isStr(v) && /^L-\d{8}T\d{6}Z-[a-z0-9-]+$/.test(v), 'launchId'],
  failureClass: [v => FAILURE_CLASSES.has(v), [...FAILURE_CLASSES].join(' | ')],
  reviewRounds: [v => isInt(v, 0), 'integer >= 0'],
  reviewerLaunchId: [v => isStr(v) && /^L-\d{8}T\d{6}Z-[a-z0-9-]+$/.test(v), 'launchId'],
  variant: [v => VARIANTS.has(v), [...VARIANTS].join(' | ')],
  pairId: [v => PAIRS.has(v), [...PAIRS].join(' | ')],
  packetBytes: [v => isInt(v, 0), 'integer >= 0'],
  packetEstTokens: [v => isInt(v, 0), 'integer >= 0'],
  findingsCount: [v => isInt(v, 0), 'integer >= 0'],
  wallSeconds: [v => typeof v === 'number' && v >= 0, 'number >= 0'],
  confidence: [v => v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(x => CONFIDENCE.has(x)), 'object of exact | derived | inferred | unknown'],
  source: [isStr, 'string'],
  servedModel: [isStr, 'string'],
  servedModelSource: [v => SERVED_SOURCES.has(v), [...SERVED_SOURCES].join(' | ')],
  servedModelConfidence: [v => SERVED_CONFIDENCE.has(v), [...SERVED_CONFIDENCE].join(' | ')],
  requestedModelVia: [v => REQUEST_VIA.has(v), [...REQUEST_VIA].join(' | ')],
  launchRole: [v => LAUNCH_ROLES.has(v), [...LAUNCH_ROLES].join(' | ')],
  costSource: [v => COST_SOURCES.has(v), [...COST_SOURCES].join(' | ')],
  // Certifier budget and scope of a certifier launch (docs/ops/cert-economy.cjs recordFields): numbers, codes and short reasons only.
  certBudget: [v => isObj(v) && isStr(v.formula) && isInt(v.turns, 1) && isInt(v.tokens, 1) && (v.riskClass === 'A' || v.riskClass === 'B'), '{formula, turns, tokens, riskClass, ...}'],
  certScope: [v => isObj(v) && ['economy', 'full'].includes(v.mode) && Array.isArray(v.fallbacks) && v.fallbacks.every(f => isObj(f) && ['a', 'b', 'c', 'd'].includes(f.code)), '{mode: economy | full, fallbacks: [{code: a | b | c | d, ...}], ...}'],
};
const FIELDS = { ...BASE, ...EXT };

function kindOf(rec) {
  if (rec.event === 'finished' || rec.event === 'review') return rec.event;
  if (rec.event === 'started') return 'started';
  return 'full';
}

// A recovered record (backfilled true, or a flag that is not exactly false) was rebuilt after the fact: it never proves an answer, a launch
// or a served model, on any event; its values stay unknown. An absent flag is a live record (an event line carries none); anything that is
// not an object proves nothing either. The one rule of launch-evidence, seat-check, certifier-rating and cert-count.
function recovered(rec) { return !rec || typeof rec !== 'object' || (rec.backfilled !== undefined && rec.backfilled !== false); }

function validateRecord(rec) {
  const errors = [];
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return ['not a JSON object'];
  // Privacy applies to every string, including nested tokens/cost and path
  // fields. Old append-only journals are not rewritten by this validation.
  if (personalPathIn(JSON.stringify(rec))) errors.push('record holds a personal path (a user home folder is never recorded)');
  for (const key of Object.keys(rec)) if (!Object.hasOwn(FIELDS, key)) errors.push(`unknown field "${key}"`);
  const kind = kindOf(rec);
  const need = { full: ['schema', 'launchId', 'startedAt', 'callerSession', 'channel', 'tuple', 'viaDispatch', 'backfilled'],
    started: ['schema', 'launchId', 'startedAt', 'callerSession', 'channel', 'tuple'],
    finished: ['schema', 'launchId', 'endedAt'],
    review: ['schema', 'launchId', 'endedAt'] }[kind];
  for (const [key, [check, desc]] of Object.entries(FIELDS)) {
    if (!Object.hasOwn(rec, key)) continue;
    // The 29 records written before the extension fields existed mark an unknown value with null (and an empty head): that stays valid for the base
    // fields that are not required of this kind of line. Extension fields never use null except reviewOutcome.
    const legacyUnknown = Object.hasOwn(BASE, key) && !need.includes(key) && (rec[key] === null || (key === 'head' && rec[key] === ''));
    if (legacyUnknown) continue;
    if (!check(rec[key])) errors.push(`field "${key}" must be ${desc}`);
  }
  for (const key of need) if (!Object.hasOwn(rec, key)) errors.push(`${kind} record needs "${key}"`);
  if (kind === 'finished' || kind === 'review') if (Object.hasOwn(rec, 'startedAt')) errors.push(`${kind} record must not carry startedAt`);
  if (kind === 'full' || kind === 'started') if (!Object.hasOwn(rec, 'startedAt')) errors.push('start record needs startedAt');
  if (rec.viaDispatch === true) errors.push('viaDispatch must be false in this journal: a dispatched run is logged only in RUNS.jsonl (PROTO-DEC-0145 item 1)');
  if (Object.hasOwn(rec, 'failureClass') && (rec.exitCode === 0)) errors.push('failureClass with exitCode 0');
  if (rec.startedAt && rec.endedAt && Date.parse(rec.endedAt) < Date.parse(rec.startedAt)) errors.push('endedAt is before startedAt');
  if (launchTaskFrame(rec.taskFrame)) for (const key of ['tier', 'riskClass']) {
    if (Object.hasOwn(rec, key) && rec[key] !== rec.taskFrame[key]) errors.push(`${key} conflicts with taskFrame`);
  }
  if (Object.hasOwn(rec, 'retryOf') && rec.retryOf === rec.launchId) errors.push('retryOf points at the record itself');
  // A backfilled record that carries any extension field must say how sure each value is (records backfilled before
  // the extension fields existed have none and stay valid without it).
  const hasExtension = Object.keys(rec).some(k => Object.hasOwn(EXT, k) && k !== 'confidence' && k !== 'source');
  if (rec.backfilled === true && hasExtension && !Object.hasOwn(rec, 'confidence')) errors.push('a backfilled record with extension fields must carry "confidence"');
  // Served model: a value needs a real source; "none" means no value and no confidence beyond none.
  if (Object.hasOwn(rec, 'servedModel') && (!Object.hasOwn(rec, 'servedModelSource') || rec.servedModelSource === 'none')) errors.push('servedModel needs a servedModelSource other than "none"');
  if (rec.servedModelSource === 'none' && Object.hasOwn(rec, 'servedModelConfidence') && rec.servedModelConfidence !== 'none') errors.push('servedModelSource "none" goes with servedModelConfidence "none"');
  if (Object.hasOwn(rec, 'servedModelSource') && rec.servedModelSource !== 'none' && !Object.hasOwn(rec, 'servedModel')) errors.push(`servedModelSource "${rec.servedModelSource}" needs a servedModel`);
  if (Object.hasOwn(rec, 'servedModelConfidence') && rec.servedModelConfidence !== 'none' && rec.servedModelSource === undefined) errors.push('servedModelConfidence needs a servedModelSource');
  // Cost source: it restates cost.basis and needs a cost; the two never disagree. A cost that is not an object (null, a legacy number) is unknown.
  if (Object.hasOwn(rec, 'costSource')) {
    if (!Object.hasOwn(rec, 'cost')) errors.push('costSource needs a cost');
    else {
      const expected = isObj(rec.cost) && Object.hasOwn(COST_SOURCE_OF_BASIS, rec.cost.basis) ? COST_SOURCE_OF_BASIS[rec.cost.basis] : 'unknown';
      if (COST_SOURCES.has(rec.costSource) && rec.costSource !== expected) errors.push(`costSource "${rec.costSource}" disagrees with the cost (expected "${expected}")`);
    }
  }
  if (isObj(rec.tokens)) errors.push(...tokensProblems(rec.tokens).map(m => `field "tokens": ${m}`));
  if (isObj(rec.cost)) errors.push(...costProblems(rec.cost).map(m => `field "cost": ${m}`));
  if (secretIn(rec)) errors.push('a secret-shaped string was found (keys, tokens and env assignments are never recorded)');
  for (const key of NOTE_FIELDS) if (isStr(rec[key]) && personalPathIn(rec[key])) errors.push(`field "${key}" holds a personal path (a user's home folder is never recorded)`);
  return errors;
}

function readJsonl(file) {
  const raw = fs.readFileSync(file);
  if (raw[0] === 0xef && raw[1] === 0xbb) throw new Error(`${file}: BOM`);
  const text = raw.toString('utf8');
  if (text.includes('\r')) throw new Error(`${file}: CR found; LF only`);
  const out = [];
  text.split('\n').forEach((line, i) => {
    if (line.trim() === '') return;
    let rec;
    try { rec = JSON.parse(line); } catch (e) { out.push({ file, line: i + 1, parseError: e.message }); return; }
    out.push({ file, line: i + 1, rec });
  });
  return out;
}

function listFiles(target) {
  const abs = path.resolve(target);
  if (!fs.existsSync(abs)) throw new Error(`no such path: ${target}`);
  if (fs.statSync(abs).isFile()) return [abs];
  return fs.readdirSync(abs).filter(n => n.endsWith('.jsonl')).sort().map(n => path.join(abs, n));
}

// Cross-record rules over a set of lines (buffer and journal together).
function crossCheck(entries, journalEntries = []) {
  const problems = [];
  const starts = new Map();
  // A line that parses as JSON but is not an object (null, 123, a list) is already reported by validateRecord; it must not add a second, confusing "undefined launchId" problem.
  const isRecord = rec => rec && typeof rec === 'object' && !Array.isArray(rec);
  const mark = (e, set) => { if (isRecord(e.rec) && (kindOf(e.rec) === 'full' || kindOf(e.rec) === 'started')) set.set(e.rec.launchId, (set.get(e.rec.launchId) || 0) + 1); };
  const inJournal = new Map();
  for (const e of journalEntries) mark(e, inJournal);
  for (const e of entries) mark(e, starts);
  for (const [id, n] of starts) {
    if (n > 1) problems.push({ launchId: id, error: `launchId has ${n} start records in the input` });
    if (inJournal.has(id)) problems.push({ launchId: id, error: 'launchId already has a start record in the journal' });
  }
  for (const e of entries) {
    if (!isRecord(e.rec)) continue;
    const k = kindOf(e.rec);
    if ((k === 'finished' || k === 'review') && !starts.has(e.rec.launchId) && !inJournal.has(e.rec.launchId)) {
      problems.push({ launchId: e.rec.launchId, error: `${k} record without a start record (input or journal)`, where: `${path.basename(e.file)}:${e.line}` });
    }
    if (e.rec.reviewerLaunchId && !starts.has(e.rec.reviewerLaunchId) && !inJournal.has(e.rec.reviewerLaunchId)) {
      problems.push({ launchId: e.rec.launchId, error: `reviewerLaunchId ${e.rec.reviewerLaunchId} is not a known launch`, where: `${path.basename(e.file)}:${e.line}`, soft: true });
    }
    if (e.rec.retryOf && !starts.has(e.rec.retryOf) && !inJournal.has(e.rec.retryOf)) {
      problems.push({ launchId: e.rec.launchId, error: `retryOf ${e.rec.retryOf} is not a known launch`, where: `${path.basename(e.file)}:${e.line}`, soft: true });
    }
  }
  return problems;
}

// The two immutable legacy records may be read, byte-content identified after
// JSON parsing. No path, user name, date or caller flag exempts a NEW append.
const HISTORICAL_PERSONAL_RECORDS = new Set([
  '7b7dba9819ccf434d45a4f37e944bb075accc55782eee1bacbf4ab91a096b162',
  'b4f73c83b151dfffa4260ac23d79798e928f5a387ac9f87e6f6aa8fa7c244286',
]);
function checkTarget(target, journalFile, { historicalRead = false } = {}) {
  const entries = listFiles(target).flatMap(readJsonl);
  const errors = [];
  for (const e of entries) {
    const where = `${path.basename(e.file)}:${e.line}`;
    if (e.parseError) { errors.push({ where, error: `invalid JSON: ${e.parseError}` }); continue; }
    const legacy = historicalRead && HISTORICAL_PERSONAL_RECORDS.has(crypto.createHash('sha256').update(JSON.stringify(e.rec)).digest('hex'));
    for (const m of validateRecord(e.rec)) {
      if (legacy && m === 'record holds a personal path (a user home folder is never recorded)') continue;
      errors.push({ where, launchId: e.rec && e.rec.launchId, error: m });
    }
  }
  const journal = journalFile && fs.existsSync(journalFile) ? readJsonl(journalFile) : [];
  const cross = crossCheck(entries, journal);
  return { entries, errors, cross, journal };
}

function main(argv) {
  const [command, ...rest] = argv;
  const opt = {};
  const positional = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--apply') opt.apply = true;
    else if (rest[i] === '--journal') opt.journal = rest[++i];
    else if (rest[i].startsWith('--')) { process.stdout.write(`ERROR unknown option ${rest[i]}\n`); return 2; }
    else positional.push(rest[i]);
  }
  try {
    if (command !== 'check' && command !== 'merge') { process.stdout.write('ERROR usage: check <file|dir> [--journal f] | merge <dir> --journal f [--apply]\n'); return 2; }
    if (positional.length !== 1) { process.stdout.write('ERROR exactly one file or directory is required\n'); return 2; }
    if (command === 'merge' && !opt.journal) { process.stdout.write('ERROR merge needs --journal\n'); return 2; }
    const result = checkTarget(positional[0], opt.journal, { historicalRead:command === 'check' });
    for (const e of result.errors) process.stdout.write(`INVALID ${e.where} ${e.launchId || '-'} ${e.error}\n`);
    for (const p of result.cross) process.stdout.write(`${p.soft ? 'WARN' : 'INVALID'} ${p.where || '-'} ${p.launchId} ${p.error}\n`);
    const hard = result.errors.length + result.cross.filter(p => !p.soft).length;
    const total = result.entries.length;
    if (command === 'check' || hard) {
      process.stdout.write(`RESULT exit=${hard ? 1 : 0} lines=${total} invalid=${hard} warnings=${result.cross.filter(p => p.soft).length}\n`);
      return hard ? 1 : 0;
    }
    // merge: append the buffer lines, byte for byte, to the end of the journal; never rewrite an existing line.
    const lines = result.entries.map(e => JSON.stringify(e.rec));
    if (!opt.apply) { process.stdout.write(`RESULT exit=0 lines=${total} would-append=${lines.length} (dry run; add --apply)\n`); return 0; }
    const journalPath = path.resolve(opt.journal);
    const before = fs.existsSync(journalPath) ? fs.readFileSync(journalPath, 'utf8') : '';
    const base = before === '' || before.endsWith('\n') ? before : before + '\n';
    writeFileAtomic(journalPath, base + lines.join('\n') + '\n');
    const after = fs.readFileSync(journalPath, 'utf8');
    process.stdout.write(`RESULT exit=0 appended=${lines.length} journal-lines=${after.split('\n').filter(Boolean).length}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(`ERROR ${error.message}\n`);
    return 2;
  }
}

module.exports = { validateRecord, checkTarget, crossCheck, kindOf, recovered, secretIn, personalPathIn, NOTE_MAX, FIELDS, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

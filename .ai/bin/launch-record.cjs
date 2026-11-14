'use strict';
// Tracked launch-record/1 writer used by the tracked launchers. Its default-off record is the runtime
// writer's format; packetProfile is its one additive field.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const repoPaths = require('./repo-paths.cjs');

// <main checkout>/docs/product/launch-records/launches/pending of the repository these files live in (env OPS_LAUNCH_PENDING_DIR overrides)
const PENDING_DIR = repoPaths.pendingDir();
const DEFAULT_CALLER = 'unattributed';
function stamp(d) { return d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z'); }
function slug(s) { return String(s || 'run').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'run'; }
function dayFile(d, pendingDir = PENDING_DIR) { return path.join(pendingDir, `launches-${d.toISOString().slice(0, 10).replace(/-/g, '')}.jsonl`); }
function sha256File(file) { try { return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`; } catch { return undefined; } }
function put(target, key, value) { if (value !== undefined && value !== null && value !== '') target[key] = value; }
// The record's note: one line of at most NOTE_MAX characters; a user's home folder is reduced to <user> and a note with a secret-shaped string is withheld
// (the same scans as launch-record-validate.cjs, so a built record never fails them because of its note).
const NOTE_MAX = 240;
// Closed home-root list, matching PERSONAL_PATH: optional drive, a separator,
// Users or home, a separator. This also covers POSIX and UNC share prefixes,
// and nested Users/home directories that the frozen validator treats as homes.
const HOME_ROOT = String.raw`((?:\b[A-Za-z]:)?(?:\\\\|\\|\/)(?:Users|home)(?:\\\\|\\|\/))`;
// One rule hides a profile segment in a path field and in a note alike: the whole segment up to the next separator, because a profile name may hold spaces.
const PATH_HOME = new RegExp(HOME_ROOT + String.raw`[^\\/]+`, 'gi');
function hideProfile(text) { return text.replace(PATH_HOME, '$1<user>'); }
function recordPath(value) {
  if (typeof value !== 'string') return value;
  // Collapse repeated/mixed separators without resolving dot segments. Preserve
  // the initial UNC pair, so the metadata retains its network-path spelling.
  const normalized = value.replace(/[\\/]+/g, (separators, offset) =>
    offset === 0 && separators.length > 1 ? separators[0].repeat(2) : separators[0]);
  return hideProfile(normalized);
}
// Launch isolation: workRootDir may legitimately live under the user profile (a single-drive opt-in host; the recovery line itself names %TEMP%).
// The user-name segment is reduced to <user> by the same rule as every other recorded path, so the privacy gate keeps the record instead of losing it.
function redactUserSegment(value) { return typeof value === 'string' ? recordPath(value) : value; }
// Producers prepare path metadata before handing it to the strict writer.
// Hash the real prompt, then redact only home-directory identities in paths;
// buildLaunchRecord still refuses raw personal paths in every record field.
function recordPaths(workdir, promptPath) {
  const fields = { workdir: recordPath(workdir) };
  if (promptPath) {
    fields.promptPath = recordPath(promptPath);
    fields.promptSha256 = sha256File(path.resolve(workdir || '.', promptPath));
  }
  return fields;
}
function noteOf(value) {
  if (value === undefined || value === null) return undefined;
  let s = hideProfile(String(value).replace(/[\r\n\t]+/g, ' ').trim());
  try { if (require(path.join(__dirname, 'accounting', 'launch-record-validate.cjs')).secretIn(s)) s = 'note withheld: it held a secret-shaped string'; } catch { /* no validator: the note stays */ }
  return s.length > NOTE_MAX ? `${s.slice(0, NOTE_MAX - 3)}...` : s;
}

function wrapperFields(env, name) {
  const id = env?.LAUNCH_WRAPPER_ID;
  return env?.LAUNCH_WRAPPER_NAME === name && typeof id === 'string' && id.startsWith(`${name}@`)
    && require('./accounting/launch-record-validate.cjs').FIELDS.wrapperLaunchId[0](id) ? { wrapperLaunchId: id } : {};
}
function buildLaunchRecord(fields) {
  const f = fields || {};
  // Keep producer/reader parity, including explicit null/empty rejection.
  // Omitting selection preserves legacy records; channel alone never implies layer.
  if (Object.hasOwn(f, 'selection')) {
    const validator = require(path.join(__dirname, 'accounting', 'launch-record-validate.cjs'));
    if (!validator.FIELDS.selection[0](f.selection)) throw new Error('launch selection must be owner, resolver or layer');
  }
  const startedAt = f.startedAt ? new Date(f.startedAt) : new Date();
  const endedAt = f.endedAt ? new Date(f.endedAt) : new Date();
  const rec = {
    schema: 'launch-record/1', launchId: `L-${stamp(startedAt)}-${slug(f.name || `${f.role || ''}-${f.stage || ''}`)}`,
    startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), callerSession: f.callerSession || DEFAULT_CALLER,
    channel: 'catalog-layer', viaDispatch: f.viaDispatch === true, backfilled: f.backfilled === true,
    tuple: { client: f.client || 'unknown', model: f.model || null, effort: f.effort || null },
  };
  if (Object.hasOwn(f, 'selection')) rec.selection = f.selection;
  if (Object.hasOwn(f, 'wrapperLaunchId')) {
    if (!require('./accounting/launch-record-validate.cjs').FIELDS.wrapperLaunchId[0](f.wrapperLaunchId)) throw new Error('invalid wrapper launch identity');
    rec.wrapperLaunchId = f.wrapperLaunchId;
  }
  for (const key of ['taskFrame', 'selectionShadow', 'assignLaunch']) if (Object.hasOwn(f, key)) {
    if (!require('./accounting/launch-record-validate.cjs').FIELDS[key][0](f[key])) throw new Error(`invalid launch ${key}`);
    rec[key] = f[key];
  }
  if (f.taskFrame) for (const key of ['tier', 'riskClass']) {
    if (Object.hasOwn(f, key) && f[key] !== f.taskFrame[key]) throw new Error(`launch ${key} conflicts with taskFrame`);
  }
  put(rec, 'task', f.task); put(rec, 'promptPath', f.promptPath);
  // Intake pins (INJECTION-DEFENSE R2, design P2a, P3, P13): the report path the launch gate read, the digest of the task file and the digest and head of the
  // author-check receipt the launch started on. Facts of the launch, hashed from bytes read at the launch, never from a claim.
  for (const key of ['reportPath', 'taskSha256', 'receiptSha256', 'receiptHead']) put(rec, key, f[key]);
  put(rec, 'promptSha256', f.promptSha256 || (f.promptPath ? sha256File(f.promptPath) : undefined));
  for (const key of ['workdir', 'head', 'treeState', 'calleeSession', 'exitCode']) put(rec, key, f[key]);
  put(rec, 'outputs', Array.isArray(f.outputs) ? f.outputs : undefined);
  // tokens and cost (cost-record): an explicit null says the client did not tell; an unknown cost is an object with basis unknown, never a zero.
  if (f.tokens !== undefined) rec.tokens = normaliseTokens(f.tokens);
  if (f.cost !== undefined) { rec.cost = f.cost; if (f.cost === null && f.costNote) rec.costNote = f.costNote; rec.costSource = costSourceOf(f.cost); }
  for (const key of ['role', 'stage', 'taskClass', 'route', 'riskClass', 'tier', 'attempt', 'retryOf', 'verdict']) put(rec, key, f[key]);
  // Launch isolation: the per-launch directory that holds the child's temp and caches (launch-wrapper.cjs records its own tempDir in the launch records it writes).
  // The privacy gate would lose the whole launch record (RECORD-WRITE-FAILED) when a root lives under the user profile. The user-name segment after /Users or /home is recorded as <user> -
  // the validator's own marker for a redacted segment (personalPathIn skips a segment starting with "<"); the rest of the path stays, so the record keeps its value.
  put(rec, 'workRootDir', redactUserSegment(f.workRootDir));
  if (f.exitCode !== undefined && f.exitCode !== 0) put(rec, 'failureClass', f.failureClass);
  for (const key of ['variant', 'pairId', 'packetHash', 'packetProfile', 'packetBytes', 'packetEstTokens', 'findingsCount']) put(rec, key, f[key]);
  // PROTO-DEC-0169 item 4: the served model and its source, as docs/ops/served-model.cjs derived them.
  for (const key of ['servedModel', 'servedModelSource', 'servedModelConfidence']) put(rec, key, f[key]);
  // Launch record extension: how the requested model reached the client and the launch's role (author, certifier, pre-review); additive, see LAUNCH-RECORD-EXT.md.
  for (const key of ['requestedModelVia', 'launchRole']) put(rec, key, f[key]);
  // Certifier budget and scope of a certifier launch (docs/ops/cert-economy.cjs recordFields).
  for (const key of ['certBudget', 'certScope']) put(rec, key, f[key]);
  put(rec, 'note', noteOf(f.note));
  put(rec, 'wallSeconds', Math.round((endedAt.getTime() - startedAt.getTime()) / 1000 * 10) / 10);
  put(rec, 'attemptClass', f.attemptClass);
  const privacy = require(path.join(USAGE_LIBS, '..', 'launch-record-validate.cjs'));
  if (privacy.personalPathIn(JSON.stringify(rec))) throw new Error('launch record holds a personal path');
  return rec;
}

// Tokens, cost and the client's own session id of one finished launch, from the captured output or the client's session store.
// Class B helper libs of the catalog layer do the reading and the pricing (launch-cost.cjs); advisory only:
// a failure here returns an unknown cost and never changes the launch. unknown is never written as zero.
const USAGE_LIBS = path.join(__dirname, 'accounting', 'lib');
function usageRecordFields(input, deps = {}) {
  // { fields: the launch-record fields (tokens, cost, calleeSession), info: what the launcher may print or act on (never recorded) }
  const failed = reason => { const safe = noteOf(reason) || 'usage source unavailable'; return { fields: { tokens: null, cost: { usd: null, basis: 'unknown', priceSnapshot: null, formula: null, reason: safe } }, info: { reason: safe, stopReason: null, resultText: null } }; };
  try {
    const usageLib = deps.clientUsage || { extractUsage: require('./accounting/lib/run-usage.cjs').extract };
    const u = input.nativeUsage || usageLib.extractUsage(input.client, input.output, { env: input.env, workdir: input.workdir, ...(deps.usageOptions || {}) });
    let cost;
    try {
      const costLib = deps.launchCost || require('./accounting/lib/launch-cost.cjs');
      cost = costLib.usageCost({ client: input.client, model: input.model, servedModel: input.servedModel, tokens: u.tokens, clientCostUsd: u.clientCostUsd, clientCostBasis: u.clientCostBasis, at: input.endedAt }, { seatUsage: true, ...(deps.costOptions || {}) });
    } catch { cost = { usd: null, basis: 'unknown', priceSnapshot: null, formula: null, reason: 'usage pricing unavailable' }; }
    if (!u.tokens) cost.reason = noteOf(`no token usage: ${u.reason || 'no structured usage reported'}`);
    const fields = { tokens: u.tokens, cost };
    if (u.sessionId) fields.calleeSession = u.sessionId;
    return { fields, info: { reason: u.reason || null, stopReason: u.stopReason || null, resultText: typeof u.resultText === 'string' ? u.resultText : null } };
  } catch (e) { return failed(`usage derivation failed: ${e.message}`); }
}
// One printable line for the launch output and the call file; null when the client told nothing (the record then says so by itself).
// The launch wrapper copies the last such line into its terminal record.
function usageLine(fields) {
  const t = fields && fields.tokens; const c = fields && fields.cost;
  if (!t) return null;
  const n = v => (v === null || v === undefined ? '-' : String(v));
  const cost = c ? `${c.basis}${typeof c.usd === 'number' ? ` usd=${c.usd}` : ''}` : 'none';
  return `USAGE source=${t.source} input=${n(t.input)} output=${n(t.output)} cacheRead=${n(t.cacheRead)} cacheWrite=${n(t.cacheWrite)} total=${n(t.total)} cost=${cost}`;
}

// ---- launch record extension: honest raw data for the L6 metrics (cost per real finding, certifier calibration) ----
// Token kinds the record always names: a kind the client did not print is an explicit null (unknown), never absent and never zero.
const TOKEN_KINDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];
function normaliseTokens(tokens) {
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return tokens;
  const out = { ...tokens };
  for (const kind of TOKEN_KINDS) if (out[kind] === undefined) out[kind] = null;
  return out;
}
// The source of a cost, derived from the cost object itself (one place, so the two can never disagree): priced = tokens x the price table of a snapshot,
// subscription = a flat-fee client, anything else (an unknown cost, a legacy plain value, no cost) = unknown.
function costSourceOf(cost) {
  const basis = cost && typeof cost === 'object' ? cost.basis : null;
  return basis === 'priced' ? 'api-price-table' : basis === 'subscription' ? 'subscription' : 'unknown';
}
// How the requested model reached the client, read from the argv and the environment the launcher really started it with (never from a claim):
// flag = the model id is the value of the LAST model flag of the options of the argv (the options end at `--`: what follows it is text, never an option);
// alias-env = vibe takes the model by VIBE_ACTIVE_MODEL and the value names the REQUESTED model (a foreign alias is not this request);
// PROTO-DEC-0215 item 4: the alias-env route is a fact of the vibe client ONLY - for any other client, known or not,
// VIBE_ACTIVE_MODEL is not this launch's request and is ignored (not-passed).
// not-passed = the client ran on its own default (or on another model than the requested one).
// The model flags follow each client's own grammar (MODEL_FLAGS); a client this table does not know gets the generic -m/--model, and vibe has no flag.
// `aliasOf(name)` maps a model name to the alias the client is started with (vibe: its alias table), so a name and its alias are one model.
// Only a launch-time fact: the served model stays in servedModel and its proof source (the report text and this value are never a proof of it).
const MODEL_FLAGS = { codex: ['-m', '--model'], mimo: ['-m', '--model'], kilo: ['-m', '--model'], dahl: ['--model'], claude: ['--model'], vibe: [] };
const GENERIC_MODEL_FLAGS = ['-m', '--model'];
function lastModelFlagValue(options, flags) {
  let last = null;
  for (let i = 0; i < options.length; i++) {
    const a = options[i];
    if (flags.includes(a)) { if (i + 1 < options.length) last = options[++i]; continue; }
    const long = flags.find(f => f.startsWith('--') && a.startsWith(`${f}=`));
    if (long) last = a.slice(long.length + 1);
  }
  return last;
}
function requestedModelVia({ client, args, env, model, aliasOf } = {}) {
  const want = typeof model === 'string' ? model.trim() : '';
  if (!want) return 'not-passed';
  const argv = Array.isArray(args) ? args.filter(a => typeof a === 'string') : [];
  const name = typeof client === 'string' ? client.trim().toLowerCase() : '';
  const known = Object.hasOwn(MODEL_FLAGS, name);
  const end = argv.indexOf('--');
  const flagged = lastModelFlagValue(end < 0 ? argv : argv.slice(0, end), known ? MODEL_FLAGS[name] : GENERIC_MODEL_FLAGS);
  if (flagged !== null && flagged.trim() === want) return 'flag';
  // PROTO-DEC-0215 item 4: alias-env only for vibe; every other client (known or unknown) ignores VIBE_ACTIVE_MODEL
  if (name !== 'vibe') return 'not-passed';
  const alias = typeof env === 'object' && env && typeof env.VIBE_ACTIVE_MODEL === 'string' ? env.VIBE_ACTIVE_MODEL.trim() : '';
  if (!alias) return 'not-passed';
  const same = v => { try { return String(typeof aliasOf === 'function' ? aliasOf(v) : v).trim().toLowerCase(); } catch { return String(v).trim().toLowerCase(); } };
  return same(alias) === same(want) ? 'alias-env' : 'not-passed';
}

function dueSignal() {
  try {
    const tool = path.join(repoPaths.mainRoot(), '.ai', 'bin', 'accounting', 'launch-stats.cjs');
    if (!fs.existsSync(tool)) return;
    const r = spawnSync(process.execPath, [tool, 'due', '--include-pending'], { encoding: 'utf8', timeout: 10000 });
    const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
    if (lines.length) process.stderr.write(`${lines[lines.length - 1]}\n`);
  } catch { /* advisory signal only */ }
}

// A record is appended only inside its folder. Right before the folder is created and again right before the append, the folder, the day file and
// every folder between the record root and them are proven real (path-safe realInside): a symbolic link, a junction or another reparse point there
// (or a day file with another hard link) refuses the write with code LAUNCH_RECORD_PATH, so no link takes a record outside its folder. The record
// root is the main checkout for a folder inside it; for any other folder it is the nearest existing folder above it (its own ancestors are the
// caller's choice).
function recordRoot(dir) {
  const main = repoPaths.mainRoot();
  const rel = path.relative(main, dir);
  if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return main;
  let at = path.dirname(dir);
  while (!fs.existsSync(at) && path.dirname(at) !== at) at = path.dirname(at);
  return at;
}
function provenRecordPath(root, target) {
  const g = require('./lib/path-safe.cjs').realInside(root, target, { refuseHardlinks: true });
  if (!g.ok) throw Object.assign(new Error(`the launch record path is refused (${g.reason}: ${g.detail})`), { code: 'LAUNCH_RECORD_PATH' });
}

function writeLaunchRecord(fields, deps = {}) {
  const io = deps.fs || fs;
  const pendingDir = deps.pendingDir || PENDING_DIR;
  const rec = buildLaunchRecord(fields);
  const dir = path.resolve(pendingDir), root = recordRoot(dir);
  provenRecordPath(root, dir);
  io.mkdirSync(pendingDir, { recursive: true });
  const file = dayFile(new Date(rec.startedAt), pendingDir);
  provenRecordPath(root, path.resolve(file));
  io.appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
  if (!deps.skipDue) dueSignal();
  return { file, record: rec };
}

module.exports = { writeLaunchRecord, buildLaunchRecord, wrapperFields, recordPaths, hideProfile, usageRecordFields, usageLine, noteOf, slug, dayFile, normaliseTokens, costSourceOf, requestedModelVia, TOKEN_KINDS, PENDING_DIR, DEFAULT_CALLER, NOTE_MAX };

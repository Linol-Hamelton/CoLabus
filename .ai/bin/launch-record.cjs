'use strict';
// Tracked launch-record/1 writer used by the tracked launchers. Its default-off record is the runtime
// writer's format; packetProfile is the one additive field introduced by L0-L4 integration P2.
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
const HOME = new RegExp(`${HOME_ROOT}(?!<)[^\\\\/\\s"'<>]+`, 'gi');
const PATH_HOME = new RegExp(HOME_ROOT + String.raw`[^\\/]+`, 'gi');
function recordPath(value) {
  if (typeof value !== 'string') return value;
  // Collapse repeated/mixed separators without resolving dot segments. Preserve
  // the initial UNC pair, so the metadata retains its network-path spelling.
  const normalized = value.replace(/[\\/]+/g, (separators, offset) =>
    offset === 0 && separators.length > 1 ? separators[0].repeat(2) : separators[0]);
  return normalized.replace(PATH_HOME, '$1<user>');
}
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
  let s = String(value).replace(/[\r\n\t]+/g, ' ').trim().replace(HOME, '$1<user>');
  try { if (require(path.join(__dirname, 'accounting', 'launch-record-validate.cjs')).secretIn(s)) s = 'note withheld: it held a secret-shaped string'; } catch { /* no validator: the note stays */ }
  return s.length > NOTE_MAX ? `${s.slice(0, NOTE_MAX - 3)}...` : s;
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
  put(rec, 'task', f.task); put(rec, 'promptPath', f.promptPath);
  put(rec, 'promptSha256', f.promptSha256 || (f.promptPath ? sha256File(f.promptPath) : undefined));
  for (const key of ['workdir', 'head', 'treeState', 'calleeSession', 'exitCode']) put(rec, key, f[key]);
  put(rec, 'outputs', Array.isArray(f.outputs) ? f.outputs : undefined);
  // tokens and cost (cost-record): an explicit null says the client did not tell; an unknown cost is an object with basis unknown, never a zero.
  if (f.tokens !== undefined) rec.tokens = f.tokens;
  if (f.cost !== undefined) { rec.cost = f.cost; if (f.cost === null && f.costNote) rec.costNote = f.costNote; }
  for (const key of ['role', 'stage', 'taskClass', 'route', 'riskClass', 'tier', 'attempt', 'retryOf']) put(rec, key, f[key]);
  if (f.exitCode !== undefined && f.exitCode !== 0) put(rec, 'failureClass', f.failureClass);
  for (const key of ['variant', 'pairId', 'packetHash', 'packetProfile', 'packetBytes', 'packetEstTokens', 'findingsCount']) put(rec, key, f[key]);
  // D9 (PROTO-DEC-0169 item 4): the served model and its source, as docs/ops/served-model.cjs derived them.
  for (const key of ['servedModel', 'servedModelSource', 'servedModelConfidence']) put(rec, key, f[key]);
  put(rec, 'note', noteOf(f.note));
  put(rec, 'wallSeconds', Math.round((endedAt.getTime() - startedAt.getTime()) / 1000 * 10) / 10);
  const privacy = require(path.join(USAGE_LIBS, '..', 'launch-record-validate.cjs'));
  if (privacy.personalPathIn(JSON.stringify(rec))) throw new Error('launch record holds a personal path');
  return rec;
}

// Tokens, cost and the client's own session id of one finished launch, from the captured output or the client's session store.
// Class B helper libs of the catalog layer do the reading and the pricing (, launch-cost.cjs); advisory only:
// a failure here returns an unknown cost and never changes the launch. unknown is never written as zero.
const USAGE_LIBS = path.join(__dirname, 'accounting', 'lib');
function usageRecordFields() {
  return { fields: { tokens: null, cost: { usd: null, basis: 'unknown', priceSnapshot: null, formula: null, reason: 'usage-pricing-not-shipped' } }, info: { reason: 'usage-pricing-not-shipped', stopReason: null, resultText: null } };
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

function dueSignal() {
  try {
    const tool = path.join(repoPaths.mainRoot(), '.ai', 'bin', 'accounting', 'launch-stats.cjs');
    if (!fs.existsSync(tool)) return;
    const r = spawnSync(process.execPath, [tool, 'due', '--include-pending'], { encoding: 'utf8', timeout: 10000 });
    const lines = (r.stdout || '').trim().split('\n').filter(Boolean);
    if (lines.length) process.stderr.write(`${lines[lines.length - 1]}\n`);
  } catch { /* advisory signal only */ }
}

function writeLaunchRecord(fields, deps = {}) {
  const io = deps.fs || fs;
  const pendingDir = deps.pendingDir || PENDING_DIR;
  const rec = buildLaunchRecord(fields);
  io.mkdirSync(pendingDir, { recursive: true });
  const file = dayFile(new Date(rec.startedAt), pendingDir);
  io.appendFileSync(file, `${JSON.stringify(rec)}\n`, 'utf8');
  if (!deps.skipDue) dueSignal();
  return { file, record: rec };
}

module.exports = { writeLaunchRecord, buildLaunchRecord, recordPaths, usageRecordFields, usageLine, noteOf, slug, dayFile, PENDING_DIR, DEFAULT_CALLER, NOTE_MAX };

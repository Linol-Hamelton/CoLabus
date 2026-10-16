'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const paths = require('../../.ai/bin/lib/path-safe.cjs');
const text = require('../../.ai/bin/lib/text-safe.cjs');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
function fail(code) { const e = new Error(code); e.code = code; throw e; }
function id(value) { if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value)) fail('invalid-id'); return value; }
// One closed filesystem identity grammar. Non-ASCII names are deliberately
// refused: NFC is applied, but Unicode confusables are not guessed as aliases.
function seatKey(value, relative = false) {
  if (!relative && (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(value))) fail('invalid-id');
  if (typeof value !== 'string') fail('unsafe-path');
  const key = value.normalize('NFC');
  const parts = relative ? key.split('/') : [key];
  if (!key || key.length > 120 || parts.some(p => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(p) || paths.segmentProblem(p))) fail('unsafe-path');
  return process.platform === 'win32' ? key.toLowerCase() : key;
}
// Decode JSON first, then check every string (including keys). Buffer.from
// replaces lone surrogates, so reject those before the shared byte decoder.
function inputText(value) {
  if (typeof value === 'string') {
    if (!value.isWellFormed()) fail('invalid-text');
    const decoded = text.decode(Buffer.from(value,'utf8'), {bom:'refuse',crlf:'refuse',invisible:'refuse',finalNewline:'report'});
    if (!decoded.ok || decoded.notes.some(n => n.code === 'NOT_NFC')) fail('invalid-text');
  } else if (Array.isArray(value)) value.forEach(inputText);
  else if (value && typeof value === 'object') for (const [k,v] of Object.entries(value)) { inputText(k); inputText(v); }
  return value;
}
function isMiMoContract(c) {
  const policy = require('../assign/policy.json').singleSeat;
  const r = c.route || c;
  const fold = v => typeof v === 'string' ? v.toLowerCase() : '';
  // The safety classification comes from the one model identity source and
  // the explicit contract family. A transport name never negates a model match.
  const { canonicalModel } = require('../../.ai/bin/lib/model-identity.cjs');
  const values = [r.model,r.modelId,c.family].map(fold);
  if (!r.model || !c.family) return true; // unknown never removes the lease
  if (policy.clients.includes(fold(r.client)) || values.some(v => v.startsWith(fold(policy.modelPrefix)) || v === 'mimo')) return true;
  // A free-form family label is not proof of a different served family. Only
  // a coherent identity of the closed alias data can lift the lease: a model
  // the identity source does not know, or one of the MiMo prefix, keeps it.
  const model = canonicalModel(r.model);
  if (model === 'UNKNOWN' || model.startsWith(fold(policy.modelPrefix).split('/').at(-1))) return true;
  if (r.modelId && canonicalModel(r.modelId) !== model) return true;
  return false;
}
function sha(value) { if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value)) fail('invalid-sha'); return value; }
function keys(value, allowed, required = []) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k)) || required.some(k => !Object.hasOwn(value, k))) fail('invalid-contract');
}
function guard(root, rel, opts = {}) {
  const p = paths.realInside(root, rel, { refuseHardlinks: true, ...opts });
  if (!p.ok) fail('unsafe-path');
  return p.real;
}
function read(root, rel) {
  const file = guard(root, rel);
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > 4 * 1024 * 1024) fail('invalid-file');
  const decoded = text.decode(fs.readFileSync(file), { bom: 'strip', crlf: 'normalise', invisible: 'refuse', finalNewline: 'refuse' });
  if (!decoded.ok) fail('invalid-text');
  if (guard(root, rel) !== file) fail('path-changed');
  return decoded.text;
}
function json(root, rel) { return text.parseJsonUnique(read(root, rel)); }
function mkdir(root, rel) {
  const p = guard(root, rel);
  fs.mkdirSync(p, { recursive: true });
  return guard(root, rel);
}
function write(root, rel, value, expected) {
  const target = guard(root, rel);
  const parent = path.dirname(target);
  if (parent !== root) mkdir(root, path.relative(root, parent));
  const bytes = Buffer.from(typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n');
  const unchanged = () => expected === undefined || (expected === null ? !fs.existsSync(guard(root, rel))
    : fs.existsSync(guard(root, rel)) && fs.readFileSync(guard(root, rel)).equals(expected));
  if (!unchanged()) fail('invalid-registry');
  let conflict = false;
  const result = paths.writeAtomicGuarded(target, bytes, { root, mode: 0o600, onTempWritten: () => {
    if (!unchanged()) { conflict = true; throw Error('content-changed'); }
  } });
  if (conflict) fail('invalid-registry');
  if (!result.ok || result.closeError) fail('atomic-write-failed');
}
function git(args, cwd) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const k of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG)/.test(k)) delete env[k];
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, env, maxBuffer: 4 * 1024 * 1024 });
  if (r.status !== 0) fail('git-operation-failed');
  // Object contents keep exact whitespace; callers resolving refs get a scalar.
  return args[0] === 'show' ? (r.stdout || '') : (r.stdout || '').trim();
}
function branch(value) { if (typeof value !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,119}$/.test(value) || value.includes('..') || value.endsWith('.lock') || value.endsWith('/') || value.includes('//')) fail('invalid-branch'); return value; }
function freshState() { return { schema: 1, candidates: {}, seats: {}, pairs: {}, landings: {} }; }
// One lease owns the complete launch, including every seat of a pair. No
// blocking wait is used: a failed acquisition unwinds the nested finallys.
// The private WeakMap prevents a caller-supplied flag from claiming ownership.
const launchLeases = new WeakMap();
function launchLocksHeld(ctx) { return launchLeases.has(ctx); }
function launchLockKeys(contracts, pair) {
  const streams = contracts.map(c => pair ? `pair-${hash(c.stream + ':' + c.id).slice(0,24)}` : c.stream);
  return ['operator', ...[...new Set(streams.map(s => `stream-${hash(s).slice(0,20)}`))].sort(), 'registry'];
}
async function acquireAll(ctx, request, fn) {
  const keys = launchLockKeys(request.contracts, request.pair);
  const needsMiMo = request.contracts.some(isMiMoContract);
  if (needsMiMo) keys.push('family-mimo');
  const held = new Set();
  const locked = Object.create(ctx);
  let registryQueue = Promise.resolve();
  locked.transaction = (key, work) => {
    if (!held.has(key)) fail('lock-not-acquired');
    if (key !== 'registry') return work();
    const next = registryQueue.then(work);
    registryQueue = next.catch(() => {});
    return next;
  };
  locked.mimoTransaction = work => {
    if (!held.has('mimo')) fail('lock-not-acquired');
    return work();
  };
  const take = async index => {
    if (index === keys.length) {
      const execute = async () => {
        launchLeases.set(locked, held);
        try { return await fn(locked); } finally { launchLeases.delete(locked); }
      };
      return execute();
    }
    const key = keys[index];
    return ctx.transaction(key, async () => {
      held.add(key);
      try { return await take(index + 1); } finally { held.delete(key); }
    });
  };
  const withHost = async () => {
    held.add('mimo');
    try { return await take(0); } finally { held.delete('mimo'); }
  };
  return needsMiMo ? ctx.mimoTransaction(withHost) : take(0);
}
async function transaction(root, key, fn) {
  id(key);
  const parent = fs.realpathSync(path.dirname(root));
  if (!fs.existsSync(root)) mkdir(parent, path.basename(root));
  const lock = guard(root, `${key}.lock`);
  try { fs.mkdirSync(lock); } catch { fail('operator-busy'); }
  const inode = fs.statSync(lock), token = crypto.randomUUID();
  try {
    write(root, `${key}.lock/owner.json`, { token, machine:hash(os.hostname()).slice(0,16), pid:process.pid, startedAt:new Date().toISOString() });
    return await fn();
  } finally {
    const now = fs.statSync(guard(root, `${key}.lock`));
    const owner = json(root, `${key}.lock/owner.json`);
    if(now.ino !== inode.ino || now.dev !== inode.dev || owner.token !== token) fail('lock-ownership-lost');
    fs.renameSync(lock,guard(root,`${key}-${token}.released`));
  }
}
function createContext({ repo, workspace, stateRoot } = {}) {
  repo = fs.realpathSync(path.resolve(repo || process.cwd()));
  workspace = fs.realpathSync(path.resolve(workspace || path.dirname(repo)));
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], repo);
  stateRoot = stateRoot || path.join(common, 'operator-kit');
  const stateParent = fs.realpathSync(path.dirname(stateRoot));
  stateRoot = guard(stateParent, path.basename(stateRoot));
  // Lock parents already exist. Refusal must never publish the data directory.
  const lockRoot = stateParent;
  const machine = hash(os.hostname()).slice(0, 16);
  const file = `state-${machine}.json`;
  const ctx = { repo, workspace, stateRoot, lockRoot, fail, guard, read, json, write, mkdir, git: (args, cwd = repo) => git(args, cwd) };
  ctx.write = (root, rel, value) => {
    if (root === stateRoot && !fs.existsSync(root)) mkdir(stateParent, path.basename(root));
    return write(root, rel, value);
  };
  ctx.load = () => {
    if (!fs.existsSync(stateRoot)) return freshState();
    if (!fs.existsSync(guard(stateRoot, file))) return freshState();
    const s = json(stateRoot, file);
    keys(s, ['schema', 'candidates', 'seats', 'pairs', 'landings'], ['schema','candidates','seats','pairs','landings']);
    if (s.schema !== 1 || ['candidates','seats','pairs','landings'].some(k => !s[k] || typeof s[k] !== 'object' || Array.isArray(s[k]))) fail('invalid-state');
    return s;
  };
  ctx.save = s => ctx.write(stateRoot, file, s);
  // One common operation lock across worktrees; host lease ignores private TEMP.
  let registryQueue = Promise.resolve();
  ctx.transaction = (key,fn) => {
    if(key !== 'registry') return transaction(lockRoot,key,fn);
    const next = registryQueue.then(()=>transaction(lockRoot,key,fn));
    registryQueue = next.catch(()=>{});
    return next;
  };
  ctx.mimoTransaction = fn => {
    const hostRoot = path.resolve(process.env.COLABUS_OPERATOR_HOST_DIR || path.join(os.homedir(), '.colabus-operator-host'));
    return transaction(hostRoot, 'mimo', fn);
  };
  return ctx;
}
module.exports = { createContext, transaction, fail, id, sha, branch, keys, guard, read, json, write, mkdir, git, hash, freshState, acquireAll, launchLocksHeld, launchLockKeys, seatKey, inputText, isMiMoContract };

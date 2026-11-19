'use strict';
const path = require('node:path');
const base = require('../../../tools/operator-knowledge/probe.cjs');
const clients = require('./clients.cjs');
const served = require('../../../docs/ops/served-model.cjs');

// The answer grammar, Kimi decorations and the Kimi stream-json form included, belongs to
// tools/operator-knowledge/probe.cjs; this wrapper only adds the served-model proof.
function reduce(route, result, log = '', proof = null) {
  const raw = `${result.stdout || ''}\n${result.stderr || ''}\n${log}`;
  const fallback = route.client === 'vibe' && /(?:active[_ ]model|model).{0,180}(?:not configured|not found|unknown|does not exist).{0,240}(?:fall(?:ing)? back|fallback|default)/is.test(raw);
  let reduced = base.reduceOutput(result, false, route.client);
  if (route.client === 'mimo' && reduced.ok) {
    const lines = String(result.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (lines.some(s => s !== 'OK' && !/^> build - [A-Za-z0-9._:/-]+$/.test(s)) || lines.filter(s => s === 'OK').length !== 1) reduced = { ok: false, reason: 'NO_ANSWER' };
  }
  // These measured MiMo errors exit zero; the old reduction did not name them.
  if (!reduced.ok && /insufficient account balance/i.test(raw)) reduced = { ok: false, reason: 'NO_CREDITS' };
  if (!reduced.ok && /missing api token|authentication error/i.test(raw)) reduced = { ok: false, reason: 'AUTH_FAILED' };
  let servedModel = null, source = 'none', match = 'unknown';
  // The shared reader enforces strict UTF-8, guarded file identity, unique JSON keys and
  // the client model allow-list (PROTO-DEC-0209/0215). No second positive proof parser.
  if (proof?.servedModel && ['codex', 'vibe'].includes(route.client)) {
    servedModel = proof.servedModel;
    source = route.client === 'vibe' ? 'client-export' : 'client-banner';
    match = proof.match;
  }
  if (fallback) { source = 'vibe-fallback-warning'; match = false; }
  if (match === false) reduced = { ok: false, reason: 'WRONG_SERVED_MODEL' };
  return { ...reduced, servedModel, source, match };
}

function run(route, resolved, env, home, deps = {}) {
  const at = new Date(deps.now ?? Date.now()).toISOString();
  // A scarce route (claude, codex) is launch-only: a probe would spend its limit, so this entry never starts one.
  if (route && base.isScarce(route.client)) return { ok: null, reason: 'SCARCE_LIMIT', at, servedModel: null, source: 'none', match: 'unknown' };
  const cmd = base.probeCommand(route);
  if (!cmd) return { ok: null, reason: 'NO_PROBE_COMMAND', at, servedModel: null, source: 'none', match: 'unknown' };
  if (!resolved) return { ok: false, reason: 'SPAWN_FAILED', at, servedModel: null, source: 'none', match: 'unknown' };
  const dir = (deps.makeDir || base.makeProbeDir)(base.resolveProbeTemp(env));
  if (!dir) return { ok: false, reason: 'temp-unavailable', at, servedModel: null, source: 'none', match: 'unknown' };
  const logPath = path.join(home, '.vibe/logs/vibe.log');
  // Read only bytes appended during this call, never a prior launch's warning.
  const read = deps.read || clients.read;
  const before = route.client === 'vibe' ? read(logPath) : '';
  const args = route.client === 'vibe' ? [...cmd.args, '--output-dir', dir] : cmd.args;
  const childEnv = { ...env, TEMP: dir, TMP: dir };
  const result = (deps.execute || clients.execute)(resolved, args, childEnv, dir, deps.spawn, base.TIMEOUT_MS, true);
  const after = route.client === 'vibe' ? read(logPath) : '';
  // Rotation or truncation is not attributable to this call.
  const log = after.startsWith(before) ? after.slice(before.length) : '';
  const proof = ['vibe', 'codex'].includes(route.client) ? (deps.derive || served.deriveForLaunch)({ client: route.client, model: route.model, args,
    env: childEnv, stdout: result.stdout, stderr: result.stderr, exportDir: dir, workdir: dir }) : null;
  return { ...reduce(route, result, log, proof), at };
}
module.exports = { reduce, run, isScarce: base.isScarce, QUESTION: base.QUESTION };

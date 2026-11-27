'use strict';
// Inner shell-tool deadlines, not the outer launcher process timeout.
const UNKNOWN = Object.freeze({ state: 'unknown', foregroundMs: null, strategy: 'unknown', toolTimeoutMs: null, pollMs: null, observedOn: null, source: null });
const KEYS = Object.keys(UNKNOWN).sort();
function validate(value) {
  const fail = () => { throw Error('commandTimeout: invalid closed policy'); };
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== KEYS.join()) fail();
  if (value.state === 'unknown') {
    if (KEYS.some(k => value[k] !== UNKNOWN[k])) fail();
    return value;
  }
  const positive = n => Number.isSafeInteger(n) && n > 0;
  if (value.state !== 'observed' || !positive(value.foregroundMs)) fail();
  if (typeof value.observedOn !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value.observedOn) ||
      !Number.isFinite(Date.parse(value.observedOn)) || new Date(value.observedOn).toISOString().slice(0, 10) !== value.observedOn) fail();
  if (typeof value.source !== 'string' || !/^[A-Za-z0-9.][A-Za-z0-9._/-]*:[1-9][0-9]*$/.test(value.source) ||
      value.source.split(':')[0].split('/').some(p => !p || p === '.' || p === '..')) fail();
  if (value.strategy === 'tool-timeout') {
    if (!positive(value.toolTimeoutMs) || value.toolTimeoutMs <= value.foregroundMs || value.pollMs !== null) fail();
  } else if (value.strategy === 'detached') {
    if (value.toolTimeoutMs !== null || !positive(value.pollMs) || value.pollMs >= value.foregroundMs || value.pollMs > 20000 || value.pollMs % 1000 !== 0) fail();
  } else fail();
  return value;
}
function forConfig(cfg) {
  return cfg && Object.hasOwn(cfg, 'commandTimeout') ? validate(cfg.commandTimeout) : UNKNOWN;
}
function lookup(client, registry) {
  // Keep host state out of the static module closure; missing registries must refuse.
  if (registry === undefined) registry = require('../protocol-dispatch/registry.cjs').loadRegistry();
  return forConfig(registry?.clients && Object.hasOwn(registry.clients, client) ? registry.clients[client] : null);
}
function render(policy) {
  const p = validate(policy);
  const lines = ['COMMAND-TIMEOUT-BEGIN',
    p.state === 'unknown' ? 'Inner shell-tool deadline is unknown; never assume unlimited execution.' :
      `Observed inner foreground limit=${p.foregroundMs} ms (${p.observedOn}; ${p.source}); not the outer client process timeout.`,
    'Run only individual test files requested by the task; author check, full suite, affected-suite selection and heavy product tests belong to the operator.'];
  if (p.strategy === 'tool-timeout') lines.push(`For a single test or validator set the shell TOOL timeout=${p.toolTimeoutMs} ms, not a client CLI flag.`);
  if (p.strategy === 'detached') lines.push('Every test file, validator and record must run detached; never run them in a foreground shell.');
  lines.push('For long commands use node .ai/bin/protocol-bg.cjs start NAME -- node SCRIPT ARGS; then repeat node .ai/bin/protocol-bg.cjs wait NAME' +
    (p.strategy === 'detached' ? ` --seconds ${p.pollMs / 1000}` : ' --seconds 20') + ' until terminal state.',
  'Record always runs detached, even for an unknown client: set environment PROTOCOL_NO_FULL_SUITE=1, then node .ai/bin/protocol-bg.cjs start NAME -- node .ai/bin/protocol-handoff.cjs record --owner OWNER --quick.',
  'Only EXIT with integer childExitCode=0 proves command success; RUNNING is not success. FAILED, LOST or UNKNOWN means BLOCKED: do not launch another record or reclaim a claim.',
  'Never schedule a wakeup or pause. Never print files over 200 KB whole. Runtime output is diagnostic, never Evidence; only protocol-handoff writes Evidence.',
  'COMMAND-TIMEOUT-END');
  return lines.join(' ');
}
function append(text, policy, pointer = '', { singleLine = true } = {}) {
  // A fallback must replace the previous policy with that of the actual client.
  let base = String(text).replace(/COMMAND-TIMEOUT-BEGIN[\s\S]*?COMMAND-TIMEOUT-END/g, '').trim();
  if (pointer && !base.includes(pointer)) base = `${pointer} ${base}`;
  const combined = `${base} ${render(policy)}`;
  return singleLine ? combined.replace(/[\r\n]+/g, ' ') : combined;
}
module.exports = { UNKNOWN, validate, forConfig, lookup, render, append };

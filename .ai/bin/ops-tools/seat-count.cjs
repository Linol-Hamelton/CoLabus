'use strict';
// Count the running operator seats of a host. The counter itself is the shared engine
// (.ai/bin/lib/seat-slots.cjs): one identity rule, one liveness rule and one domain for
// every consumer, so the operator and the kernel always see the same seats.
//
// A seat runs when its running record exists, is not ended, is not ended by the terminal
// record of the SAME attempt and one of its processes is alive. The raw output of the launch
// never ends a seat.
//
// The caps come from the seat policy (docs/ops/seat-policy.json of the main checkout). An
// absent policy is an unconfigured host: no client cap and no route cap, the total default of
// the ops config stays in force. A malformed policy is a refusal (exit 2), never "uncapped".
const fs = require('node:fs');
const path = require('node:path');
const { load, loadSeatCaps, loadSeatPolicy } = require('./lib/config.cjs');
const slots = require('../lib/seat-slots.cjs');
const seatPolicy = require('../lib/seat-policy.cjs');

const RUNNING = slots.RUNNING;
const TERMINAL = slots.TERMINAL;

const clientOf = slots.clientOf;
const canonicalClient = slots.canonicalClient;
const recordedClient = slots.recordedClient;
const sameAttempt = slots.sameAttempt;

// The terminal identity of one attempt: the same wrapper PID and the same start. A terminal
// record of another attempt never ends this seat.
function terminalState(marker, terminal) {
  const matches = sameAttempt(marker, terminal);
  return { ended: Boolean(marker && marker.ended) || matches, terminal: matches ? terminal : null };
}

// The cap of one client under the policy. A client without a row takes the default client
// cap; a client without either has no cap (Infinity).
function capFor(client, policy, options = {}) {
  if (!client) return Infinity;
  const patterns = options.patterns || (options.caps ? options.caps.clients : []);
  const caps = seatPolicy.effectiveCaps(policy, { client: canonicalClient(client, patterns) }, options.now === undefined ? Date.now() : options.now);
  return caps.client === null ? Infinity : caps.client;
}

// The state of one seat (the wrapper of the launch with this name).
function seatState(options = {}) {
  const dir = path.resolve(options.runtimeDir || '.');
  const state = slots.seatState(dir, options.name, options);
  const terminal = (() => { try { return JSON.parse((options.io || fs).readFileSync(path.join(dir, options.name + TERMINAL), 'utf8')); } catch { return null; } })();
  const end = terminalState(state.marker, terminal);
  return { ...state, ...end, live: state.live && !end.ended };
}

// The live seats of the domain.
function runningSeats(options = {}) {
  const patterns = options.caps ? options.caps.clients : (options.patterns || []);
  return slots.runningSeats({ ...options, patterns });
}

function countClient(client, options) {
  const canonical = canonicalClient(client, options.caps ? options.caps.clients : (options.patterns || []));
  return runningSeats(options).filter(seat => seat.client === canonical).length;
}

// The worktree guard: one owner per worktree, decided by the identity of the seat.
function busyWorktree(options) {
  return slots.busyWorktree(options);
}

// The pure admission rule. Exported so a mutation can show the cap is the guard.
function admit({ total, cap, clientCount, clientCap, routeCount, routeCap }) {
  return slots.admitPool({ count: total, cap }) && slots.admitPool({ count: clientCount, cap: clientCap })
    && slots.admitPool({ count: routeCount, cap: routeCap });
}

// The caps of one request against the policy and the CLI cap. The CLI cap only tightens: it
// never reopens a zero and never reopens an expired cap.
// -> { totalCap, clientCap, routeCap, expired, expiredReason, zero }
function requestCaps(options = {}) {
  const now = options.now === undefined ? Date.now() : options.now;
  const patterns = options.patterns || (options.caps ? options.caps.clients : []);
  const policy = options.policy || null;
  const client = options.client ? canonicalClient(options.client, patterns) : null;
  const route = seatPolicy.routeOf(policy, client, options.model) || options.route || null;
  const caps = seatPolicy.effectiveCaps(policy, { client, route }, now);
  const cliCap = Number.isSafeInteger(options.cap) ? options.cap : null;
  const defaultTotal = Number.isSafeInteger(options.defaultCap) ? options.defaultCap : null;
  const policyTotal = caps.total === null ? defaultTotal : caps.total;
  const totalCap = seatPolicy.tighter(policyTotal, cliCap);
  const clientCap = caps.client;
  const routeCap = caps.route;
  const zero = (clientCap !== null && clientCap === 0) || (routeCap !== null && routeCap === 0) || (totalCap !== null && totalCap === 0);
  return { totalCap, clientCap, routeCap, routeName: route, expired: caps.expired, expiredReason: caps.expiredReason, zero };
}

// Wait for a free slot. A zero cap is refused at once: no sleep, no wait, no side effect.
async function waitForSlot(options = {}) {
  const proxy = require('./proxy-health.cjs');
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const started = now();
  let caps = requestCaps({ ...options, now: now() });
  if (caps.expiredReason) return { ok: false, reason: caps.expiredReason, expired: true, waitedMs: 0, running: 0, sameClient: 0, ...caps };
  if (caps.zero) return { ok: false, reason: 'SLOT_CAP_ZERO', zero: true, waitedMs: 0, running: 0, sameClient: 0, ...caps };
  const gate = await proxy.waitForProxy({ ...options, config: options.proxyConfig, argv: options.argv, waitMs: options.proxyWaitMs ?? options.timeoutMs });
  if (!gate.ok) return { ok: false, reason: gate.reason, total: 0, clientCount: 0, ...caps };
  const client = options.client ? canonicalClient(options.client, options.caps ? options.caps.clients : (options.patterns || [])) : '';
  for (;;) {
    caps = requestCaps({ ...options, now: now() });
    if (caps.expiredReason) return { ok: false, reason: caps.expiredReason, expired: true, ...caps };
    if (caps.zero) return { ok: false, reason: 'SLOT_CAP_ZERO', zero: true, ...caps };
    const seats = runningSeats({ ...options, now: now() });
    const total = seats.length;
    const clientCount = seats.filter(seat => client ? seat.client === client : !seat.client || seat.client === 'other' || seat.client === 'unknown-client').length;
    const routeCount = caps.routeName ? seats.filter(seat => seat.route === caps.routeName).length : 0;
    if (admit({ total, cap: caps.totalCap, clientCount, clientCap: caps.clientCap, routeCount, routeCap: caps.routeCap })) {
      const last = await proxy.waitForProxy({ ...options, config: options.proxyConfig, waitMs: 0 });
      if (!last.ok) return { ok: false, reason: last.reason, total, client, clientCount, routeCount, seats, ...caps };
      caps = requestCaps({ ...options, now: now() });
      if (caps.expiredReason) return { ok: false, reason: caps.expiredReason, expired: true, total, clientCount, ...caps };
      if (caps.zero) return { ok: false, reason: 'SLOT_CAP_ZERO', zero: true, total, clientCount, ...caps };
      return { ok: true, total, client, clientCount, routeCount, waitedMs: now() - started, seats, ...caps };
    }
    if (now() - started >= options.timeoutMs) {
      return { ok: false, timeout: true, total, client, clientCount, routeCount, waitedMs: now() - started, seats, ...caps };
    }
    await sleep(options.pollMs);
  }
}

function usage() {
  return 'usage: seat-count.cjs [--client CLIENT] [--model MODEL] [--free | --wait CAP] [--json] [--runtime DIR] [--caps FILE]';
}
function number(value, what) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw Object.assign(new Error(`SEAT-COUNT-USAGE: ${what} must be a non-negative number`), { code: 'SEAT-COUNT-USAGE' });
  return n;
}

async function main(argv) {
  const args = argv.slice();
  const value = name => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const client = value('--client') || process.env.SEAT_CLIENT || '';
  const provider = value('--provider');
  const model = value('--model');
  const runtime = value('--runtime');
  const capsFile = value('--caps');
  const poll = value('--poll');
  const timeout = value('--timeout');
  const json = args.includes('--json');
  if (json) args.splice(args.indexOf('--json'), 1);
  const free = args.includes('--free');
  if (free) args.splice(args.indexOf('--free'), 1);
  const waitIndex = args.indexOf('--wait');
  const wait = waitIndex >= 0;
  let cap;
  if (wait) {
    const next = args[waitIndex + 1];
    args.splice(waitIndex, next !== undefined && !next.startsWith('--') ? 2 : 1);
    cap = next !== undefined && !next.startsWith('--') ? number(next, '--wait') : undefined;
  }
  if (args.length || (free && (!client || wait || json))) { process.stderr.write(`${usage()}\n`); return 2; }
  let cfg;
  try { cfg = load({ root: process.cwd() }); } catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  let caps;
  try { caps = loadSeatCaps(); } catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  // The policy is read from the main checkout: a worktree of the same repository reads the
  // same policy, so a closed policy cannot be bypassed by a missing file in another tree.
  // An explicitly named file (--caps) may only TIGHTEN it and is never uncapped.
  let policy;
  try {
    const read = loadSeatPolicy({ file: capsFile, main: cfg.main, env: process.env });
    if (!read.ok) { process.stderr.write(`${read.code}: ${read.detail || ''}\n`); return 2; }
    policy = read.policy;
  } catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  const options = {
    runtimeDir: runtime || cfg.runtimeDir,
    repo: cfg.main,
    inject: slots.injectedRoots(process.env),
    caps,
    policy,
    client,
    provider, model, proxyConfig: cfg.proxy,
    cap: cap === undefined ? cfg.seat.defaultCap : cap,
    defaultCap: cfg.seat.defaultCap,
    maxAgeMs: cfg.seat.maxAgeMs,
    pollMs: poll === undefined ? cfg.seat.pollMs : number(poll, '--poll'),
    timeoutMs: timeout === undefined ? cfg.seat.waitTimeoutMs : number(timeout, '--timeout'),
  };
  if (free) {
    const capsOfClient = requestCaps({ ...options, now: Date.now() });
    const cap = capsOfClient.clientCap === null ? Infinity : capsOfClient.clientCap;
    if (capsOfClient.expiredReason) {
      process.stdout.write(`BUSY ${cap === Infinity ? '-' : cap}/${cap === Infinity ? '-' : cap} reason=${capsOfClient.expiredReason}\n`);
      return 3;
    }
    const n = countClient(client, options);
    const routeCount = capsOfClient.routeName ? runningSeats(options).filter(seat => seat.route === capsOfClient.routeName).length : 0;
    const routeFree = slots.admitPool({ count: routeCount, cap: capsOfClient.routeCap });
    const proxy = require('./proxy-health.cjs');
    // The occupancy query never probes the endpoint and never writes: it reads the state the scheduler tick left.
    // An unknown or stale state is not a pause; the seat count stays the answer to the question that was asked.
    const state = proxy.needsLocalProxy(options) ? proxy.readState({ runtimeDir: options.runtimeDir, config: cfg.proxy }) : null;
    if (state && state.state === 'down') { process.stdout.write(`PAUSED ${n}/${cap}\n`); return 3; }
    process.stdout.write(`${n < cap && routeFree ? 'FREE' : 'BUSY'} ${n}/${cap === Infinity ? '-' : cap}\n`);
    return 0;
  }
  if (!wait) {
    const seats = runningSeats(options);
    if (json) process.stdout.write(`${JSON.stringify(seats, null, 2)}\n`);
    else process.stdout.write(`${seats.length}\n`);
    return 0;
  }
  const result = await waitForSlot(options);
  if (result.ok) {
    process.stdout.write(`SLOT free: ${result.total} running, cap ${result.totalCap === null ? '-' : result.totalCap}; client ${result.client || '-'} ${result.clientCount}/${result.clientCap === null ? '-' : result.clientCap}\n`);
    return 0;
  }
  if (result.reason) {
    process.stdout.write(`SLOT REFUSED reason=${result.reason} client ${options.client || '-'} cap ${result.clientCap === null ? '-' : result.clientCap}; nothing was started\n`);
    return 3;
  }
  process.stdout.write(`SLOT TIMEOUT: ${result.total} running, cap ${result.totalCap === null ? '-' : result.totalCap}; client ${result.client || '-'} ${result.clientCount}/${result.clientCap === null ? '-' : result.clientCap}\n`);
  return 3;
}

module.exports = {
  RUNNING, TERMINAL, clientOf, capFor, canonicalClient, terminalState, seatState, recordedClient,
  runningSeats, countClient, busyWorktree, processStartMs: slots.processStartMs, injectedRoots: slots.injectedRoots, admit, requestCaps, waitForSlot, main,
};
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${e.message}\n`); process.exitCode = 2; });

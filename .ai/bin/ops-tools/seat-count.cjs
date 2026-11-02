'use strict';
// Count running operator seats from the launch markers of the main checkout. A seat runs
// when its running.json has no end field or matching terminal, its output has no end marker and
// the marker is younger than the configured age; a wrapper process that is gone makes the
// seat dead whatever the files say. Route metadata takes precedence over legacy metadata
// and name patterns.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { load, loadSeatCaps } = require('./lib/config.cjs');

const RUNNING = '.running.json';
const TERMINAL = '.terminal.json';

function clientOf(name, caps) {
  const folded = String(name || '').toLowerCase();
  for (const row of caps.clients) if (row.patterns.some(pattern => pattern.test(folded))) return row.name;
  return 'other';
}
function capFor(client, caps) {
  if (!client) return Infinity;
  const row = caps.clients.find(item => item.name === canonicalClient(client, caps));
  return row ? row.cap : caps.defaultCap;
}
function canonicalClient(client, caps) {
  const folded = String(client).toLowerCase();
  return caps.clients.some(row => row.name === folded) ? folded : clientOf(folded, caps);
}

function terminalState(marker, terminal) {
  const matches = Boolean(marker && terminal && Number.isSafeInteger(marker.wrapperPid)
    && marker.wrapperPid > 0 && marker.wrapperPid === terminal.wrapperPid
    && typeof marker.startedAt === 'string' && marker.startedAt.length > 0
    && marker.startedAt === terminal.startedAt);
  return { ended: Boolean(marker && marker.ended) || matches, terminal: matches ? terminal : null };
}

const json = (io, file) => { try { return JSON.parse(io.readFileSync(file, 'utf8')); } catch { return null; } };

// One liveness predicate for counting and the launcher's same-name precheck.
function seatState(options = {}) {
  const io = options.io || fs;
  const runtimeDir = path.resolve(options.runtimeDir || '.');
  const runningFile = path.join(runtimeDir, options.name + RUNNING);
  const marker = json(io, runningFile);
  const state = terminalState(marker, json(io, path.join(runtimeDir, options.name + TERMINAL)));
  const dead = { ...state, marker, live: false };
  if (state.ended || !Number.isSafeInteger(marker && marker.wrapperPid) || marker.wrapperPid <= 0) return dead;
  let st;
  try { st = io.statSync(runningFile); } catch { return dead; }
  const now = options.now === undefined ? Date.now() : options.now;
  const maxAgeMs = options.maxAgeMs === undefined ? 6 * 3600000 : options.maxAgeMs;
  if (now - st.mtimeMs > maxAgeMs) return dead;
  try { (options.kill || process.kill)(marker.wrapperPid, 0); } catch (e) { if (!e || e.code !== 'EPERM') return dead; }
  if (options.processStartMs && options.processStartMs(marker.wrapperPid) > Date.parse(marker.startedAt) + 120000) return dead;
  let out = '';
  try { out = io.readFileSync(path.join(runtimeDir, options.name + '.launch.out'), 'utf8'); } catch { /* no output */ }
  const endMarker = options.endMarker || /_(DONE|NO_VERDICT|BLOCKED)( |$)|terminal record not written|REFUSED/m;
  endMarker.lastIndex = 0;
  if (endMarker.test(out)) return dead;
  return { ...state, marker, live: true, mtimeMs: st.mtimeMs };
}

function recordedClient(marker, name, caps) {
  const route = marker.routeGate && marker.routeGate.client;
  if (typeof route === 'string' && route.trim()) return route;
  const model = String(marker.routeGate && marker.routeGate.model || '');
  const byName = caps ? clientOf(name, caps) : 'other';
  if (/^claude-/.test(model)) return byName === 'cline' ? 'cline' : 'claude';
  if (/^gemini-/.test(model)) return byName === 'kilo' ? 'kilo' : 'cline';
  // Older markers predate routeGate; keep their explicit client before name inference.
  const resolver = marker.resolver && marker.resolver.operator && marker.resolver.operator.client;
  const command = Array.isArray(marker.command) ? marker.command : [];
  const at = command.indexOf('--client');
  const commandClient = at >= 0 ? command[at + 1] : typeof marker.command === 'string' ? path.basename(marker.command).replace(/\.(exe|cmd|bat)$/i, '') : null;
  return [resolver, commandClient].find(value => typeof value === 'string' && value.trim()) || byName;
}

function runningSeats(options = {}) {
  const runtimeDir = path.resolve(options.runtimeDir || '.');
  const io = options.io || fs;
  const caps = options.caps;
  let names;
  try { names = io.readdirSync(runtimeDir).filter(name => name.endsWith(RUNNING)); } catch { return []; }
  const live = [];
  for (const file of names) {
    const name = file.slice(0, -RUNNING.length);
    const state = seatState({ ...options, runtimeDir, name });
    if (!state.live) continue;
    live.push({ name, client: caps ? canonicalClient(recordedClient(state.marker, name, caps), caps) : null, mtimeMs: state.mtimeMs });
  }
  live.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  return live;
}

function countClient(client, options) {
  const canonical = canonicalClient(client, options.caps);
  return runningSeats(options).filter(seat => seat.client === canonical).length;
}

function processStartMs(pid) {
  if (process.platform !== 'win32' && pid === process.pid) return Date.now() - process.uptime() * 1000;
  const r = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${pid}).StartTime.ToUniversalTime().ToString("o")`], { encoding: 'utf8', windowsHide: true, timeout: 20000 })
    : spawnSync('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 20000 });
  return r.error || r.status !== 0 ? NaN : Date.parse(String(r.stdout || '').trim());
}

// The worktree guard deliberately has no age/output cutoff: a live wrapper owns its
// worktree until it writes a terminal record. Unknown process start time stays busy.
function busyWorktree(options) {
  const io = options.io || fs;
  const normalize = file => {
    let real;
    try { real = io.realpathSync.native(file); } catch { real = path.resolve(file); }
    return process.platform === 'win32' ? real.toLowerCase() : real;
  };
  const want = normalize(options.worktree);
  let names;
  for (let attempt = 0; ; attempt++) {
    try { names = io.readdirSync(options.runtimeDir); break; } catch (e) {
      if (e.code === 'ENOENT') return null;
      if (e.code !== 'EBUSY' || attempt >= 4) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  for (const file of names.filter(n => n.endsWith(RUNNING))) {
    const name = file.slice(0, -RUNNING.length);
    if (names.includes(name + TERMINAL)) continue;
    const marker = json(io, path.join(options.runtimeDir, file));
    if (!marker || marker.ended || typeof marker.worktree !== 'string' || normalize(marker.worktree) !== want
      || !Number.isSafeInteger(marker.wrapperPid) || marker.wrapperPid <= 0) continue;
    try { (options.kill || process.kill)(marker.wrapperPid, 0); } catch (e) { if (e.code !== 'EPERM') continue; }
    const created = (options.processStartMs || processStartMs)(marker.wrapperPid);
    if (created > Date.parse(marker.startedAt) + 120000) continue;
    return name;
  }
  return null;
}

// The pure admission rule. Exported so a mutation can show the cap is the guard.
function admit({ total, cap, clientCount, clientCap }) {
  return total < cap && clientCount < clientCap;
}

async function waitForSlot(options = {}) {
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const started = now();
  const cap = options.cap === undefined ? 18 : options.cap;
  const client = options.client ? canonicalClient(options.client, options.caps) : '';
  const clientCap = options.client ? capFor(options.client, options.caps) : Infinity;
  for (;;) {
    const seats = runningSeats({ ...options, now: now() });
    const total = seats.length;
    const clientCount = client ? seats.filter(seat => seat.client === client).length : 0;
    if (admit({ total, cap, clientCount, clientCap })) {
      return { ok: true, total, cap, client, clientCount, clientCap, waitedMs: now() - started, seats };
    }
    if (now() - started >= options.timeoutMs) {
      return { ok: false, timeout: true, total, cap, client, clientCount, clientCap, waitedMs: now() - started, seats };
    }
    await sleep(options.pollMs);
  }
}

function usage() {
  return 'usage: seat-count.cjs [--client CLIENT] [--free | --wait CAP] [--json] [--runtime DIR] [--caps FILE]';
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
  try { caps = loadSeatCaps({ file: capsFile }); } catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  const options = {
    runtimeDir: runtime || cfg.runtimeDir,
    caps,
    client,
    cap: cap === undefined ? cfg.seat.defaultCap : cap,
    maxAgeMs: cfg.seat.maxAgeMs,
    endMarker: cfg.seat.endMarker,
    pollMs: poll === undefined ? cfg.seat.pollMs : number(poll, '--poll'),
    timeoutMs: timeout === undefined ? cfg.seat.waitTimeoutMs : number(timeout, '--timeout'),
  };
  if (free) {
    const n = countClient(client, options);
    const cap = capFor(client, caps);
    process.stdout.write(`${n < cap ? 'FREE' : 'BUSY'} ${n}/${cap}\n`);
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
    process.stdout.write(`SLOT free: ${result.total} running, cap ${result.cap}; client ${result.client || '-'} ${result.clientCount}/${result.clientCap === Infinity ? '-' : result.clientCap}\n`);
    return 0;
  }
  process.stdout.write(`SLOT TIMEOUT: ${result.total} running, cap ${result.cap}; client ${result.client || '-'} ${result.clientCount}/${result.clientCap === Infinity ? '-' : result.clientCap}\n`);
  return 3;
}

module.exports = { RUNNING, TERMINAL, clientOf, capFor, terminalState, seatState, recordedClient, runningSeats, countClient, busyWorktree, processStartMs, admit, waitForSlot, main };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${e.message}\n`); process.exitCode = 2; });

'use strict';
// Identity registry and bounded process cleanup for one test run.
//
// Ownership is proven ONLY by identity: the pair (pid, creation time) of a process the run registered
// (its runner descendants or OS job members). A path, an argv or a
// cwd proves busyness, never ownership, and never licenses a signal by itself. Every signal goes to a
// registered identity after a fresh table confirmed that identity; a reused pid (same pid, newer
// creation time) is not our process and never receives one (rule R1 of the operator collectors).
//
// The boundary outcomes: clean (nothing registered is alive),
// leftover (registered identities were alive and were stopped by us - still red, the file boundary
// was violated), survivors (alive and could not be stopped - red), unverified (the table could not be
// read or a signal was denied - red), registry-unverified (the registry is unreadable but a fresh
// table has no known survivor - advisory). Missing creation times are reported
// separately as UNVERIFIED identity diagnostics, not proof of a leftover or permission to signal.
//
// Telemetry is a closed schema {runId, pid, created, role, outcome} per event, size-bounded; argv is
// never recorded and never printed (a secret can be the first argument).
//
// The collectors are the real operator collectors (.ai/bin/operator/auto-retire.cjs: Windows through
// .ai/bin/operator/auto-retire-processes.ps1, Linux through /proc); any other platform has no
// collector and the boundary is unverified there, never guessed. Collectors are required lazily so a
// standalone driver that ships without this module's siblings still loads its pure helpers.

const fs = require('node:fs');

const REGISTRY_SCHEMA = 'process-registry/1';
const MAX_REGISTRY_ROWS = 512;
const MAX_EVENT_ROWS = 32;
const MAX_REGISTRY_BYTES = 4 * 1024 * 1024;
const GRACE_MS = 1500;
const RECHECKS = 3;
const RECHECK_DELAY_MS = 500;

const isPid = v => Number.isSafeInteger(v) && v > 0;
const isStamp = v => Number.isSafeInteger(v) && v >= 0;

// The registry file: NDJSON, one row per registered identity, appended by the runner at file
// boundaries and read by the driver at the suite boundary. Unreadable or missing is null, never an
// empty guess: a boundary without its registry is unverified.
function readRegistry(file, io = fs) {
  let raw;
  try {
    if (io.statSync(file).size > MAX_REGISTRY_BYTES) return null;
    raw = io.readFileSync(file, 'utf8');
  } catch { return null; }
  const rows = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line); } catch { return null; }
    if (!row || typeof row !== 'object' || row.schema !== REGISTRY_SCHEMA ||
        typeof row.runId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(row.runId)) return null;
    rows.push(row);
  }
  return { rows };
}

function appendRegistry(file, rows, io = fs) {
  if (!file || !Array.isArray(rows) || rows.length === 0) return { written: 0 };
  const capped = rows.slice(0, MAX_REGISTRY_ROWS);
  if (rows.length > MAX_REGISTRY_ROWS) capped.push({ runId: rows[0]?.runId, degraded: true, reason: 'registry-overflow' });
  const body = capped.map(row => `${JSON.stringify({
    schema: REGISTRY_SCHEMA,
    registeredAt: new Date().toISOString(),
    ...row,
  })}\n`).join('');
  io.appendFileSync(file, body);
  return { written: Math.min(rows.length, MAX_REGISTRY_ROWS) };
}

// Register only descendants proven by the fresh table.
// A descendant chains to rootPid by pid and creation time (an ancestor row created after its
// supposed descendant is a reused pid and breaks the chain). The root itself never registers.
function registerFromTable({ table, rootPid }) {
  if (!Array.isArray(table) || !isPid(rootPid)) return [];
  const byPid = new Map();
  for (const row of table) {
    if (row && typeof row === 'object' && !Array.isArray(row) && isPid(row.pid)) byPid.set(row.pid, row);
  }
  const out = new Map();
  const chains = new Map(); // pid -> boolean: known chain verdicts (memo, not a path guard)
  const chainsToRoot = (row, path) => {
    if (!row || typeof row !== 'object' || !isPid(row.pid)) return false;
    if (chains.has(row.pid)) return chains.get(row.pid);
    if (row.pid === rootPid) return true;
    if (path.has(row.pid) || path.size > 32) return false; // a cycle or an overlong chain proves nothing
    if (!isStamp(row.created)) return false;
    const parent = byPid.get(row.ppid);
    if (!parent || !isStamp(parent.created) || parent.created > row.created) return false; // reused pid
    path.add(row.pid);
    const verdict = chainsToRoot(parent, path);
    path.delete(row.pid);
    chains.set(row.pid, verdict);
    if (verdict) out.set(row.pid, { pid: row.pid, created: row.created, role: 'descendant' });
    return verdict;
  };
  for (const row of table) chainsToRoot(row, new Set());
  return [...out.values()].sort((a, b) => a.pid - b.pid);
}

// Verification: every registered identity of THIS run must be absent from the fresh table.
function verifyBoundary({ runId, registry, table }) {
  const rows = Array.isArray(registry) ? registry : (registry && Array.isArray(registry.rows) ? registry.rows : []);
  if (!Array.isArray(table)) return { status: 'unverified', reason: 'table-unavailable', survivors: [], reused: [], absent: [] };
  const survivors = [], reused = [], absent = [], unverified = [];
  for (const rec of rows) {
    if (!rec || !isPid(rec.pid) || (rec.created != null && !isStamp(rec.created))) {
      return { status: 'unverified', reason: 'registry-invalid', survivors: [], reused: [], absent: [] };
    }
    if (rec.runId !== runId) continue;
    const matches = table.filter(row => row && typeof row === 'object' && row.pid === rec.pid);
    if (matches.length === 0) { absent.push(rec); continue; }
    const same = matches.filter(row => row.created === rec.created);
    if (matches.length > 1) return { status: 'unverified', reason: 'duplicate-rows', survivors: [], reused: [], absent: [] };
    if (!isStamp(rec.created) || !isStamp(matches[0].created)) { unverified.push(rec); continue; }
    if (same.length === 1) survivors.push({ ...rec, role: rec.role || 'registered' });
    else reused.push(rec); // same pid, different creation time: a reused pid is not our process
  }
  return {
    status: survivors.length ? 'leftover-candidates' : 'clean',
    reason: null,
    survivors,
    reused,
    absent,
    unverified,
  };
}

// Size-bounded telemetry: the closed event schema, no argv, a truncation marker.
function boundedEvents(events) {
  const list = (Array.isArray(events) ? events : []).slice(0, MAX_EVENT_ROWS)
    .map(event => ({ runId: event.runId, pid: event.pid, created: event.created, role: event.role, outcome: event.outcome }));
  if (Array.isArray(events) && events.length > MAX_EVENT_ROWS) {
    list.push({ truncated: events.length - MAX_EVENT_ROWS });
  }
  return list;
}

// The finalizer core (design 3.2): verify, escalate SIGTERM -> SIGKILL on confirmed identities,
// recheck by a fresh table, and report the boundary outcome. collect() returns a fresh table
// (or null); kill(pid, stage) returns 'stopped' or 'denied'; sleep(ms) waits.
async function enforceBoundary(args) {
  const unverified = [];
  // Registry access is optional for restricted farm users. Keep the loss visible, and still
  // enforce every identity observed directly by the driver. An unavailable table or a known
  // survivor takes precedence over this diagnostic; registry loss never authorizes a signal.
  const unavailable = args.registry == null;
  const result = await runEnforcement({ ...args,
    registry: unavailable ? (args.fallbackRegistry || []) : args.registry }, unverified);
  if (unavailable && result.status === 'clean') {
    result.status = 'registry-unverified';
    result.reason = 'registry-unreadable';
  }
  return { runId: args && args.runId, ...result, unverified };
}

async function runEnforcement({ runId, registry, table, collect, kill, sleep }, unverified) {
  const verify = input => {
    const result = verifyBoundary(input);
    for (const rec of result.unverified || []) {
      if (!unverified.some(row => row.pid === rec.pid && row.created === rec.created)) unverified.push(rec);
    }
    return result;
  };
  const first = verify({ runId, registry, table });
  if (first.status === 'unverified') return { ...first, stopped: false, events: [] };
  if (!first.survivors.length) return { ...first, stopped: false, events: [] };
  // Self-exclusion is necessary but never sufficient permission to signal.
  if (Array.isArray(table) && table.some(row => row?.rootMarker === 'complete' || row?.pid === process.pid)) {
    const safe = require('../operator/auto-retire.cjs').withoutSelf(table);
    const excluded = table.filter(row => row && row.pid && !safe.includes(row));
    const records = Array.isArray(registry) ? registry : registry?.rows || [];
    if (records.some(rec => rec.runId === runId && excluded.some(row => row.pid === rec.pid && row.created === rec.created)))
      return { status: 'unverified', reason: 'self-or-ancestor', survivors: [], stopped: false, events: [] };
  }
  const survivors = first.survivors;
  const events = [];
  const signalAll = (targets, stage) => {
    for (const target of targets) {
      const fresh = verify({ runId, registry: [target], table: collect() });
      if (fresh.status === 'unverified') return fresh;
      if (!fresh.survivors.length) continue;
      const outcome = kill(target.pid, stage);
      if (outcome === 'denied') return { status: 'unverified', reason: 'kill-denied', survivors, reused: [], absent: [] };
      events.push({ runId, pid: target.pid, created: target.created, role: target.role, outcome: stage });
    }
    return null;
  };
  const recheck = () => {
    const fresh = collect();
    if (fresh === null) return { status: 'unverified', reason: 'table-unavailable', survivors, reused: [], absent: [] };
    return verify({ runId, registry: survivors, table: fresh });
  };

  // Stage 1: SIGTERM on identities a fresh table still confirms as ours.
  let check = recheck();
  if (check.status === 'unverified') return { ...check, stopped: false, events: boundedEvents(events) };
  if (check.survivors.length) {
    const failure = signalAll(check.survivors, 'SIGTERM');
    if (failure) return { ...failure, stopped: false, events: boundedEvents(events) };
    await sleep(GRACE_MS);
  }

  // Stage 2: SIGKILL with bounded rechecks; a survivor that survives both is red.
  for (let attempt = 0; attempt <= RECHECKS; attempt++) {
    check = recheck();
    if (check.status === 'unverified') return { ...check, stopped: false, events: boundedEvents(events) };
    if (!check.survivors.length) {
      return { status: 'leftover', reason: 'stopped', stopped: true, survivors, reused: [], absent: [], events: boundedEvents(events) };
    }
    const stage = 'SIGKILL';
    const failure = signalAll(check.survivors, stage);
    if (failure) return { ...failure, stopped: false, events: boundedEvents(events) };
    await sleep(RECHECK_DELAY_MS);
  }
  const final = recheck();
  if (final.status === 'unverified') return { ...final, stopped: false, events: boundedEvents(events) };
  if (!final.survivors.length) {
    return { status: 'leftover', reason: 'stopped', stopped: true, survivors, reused: [], absent: [], events: boundedEvents(events) };
  }
  return { status: 'survivors', reason: 'not-stoppable', stopped: false, survivors, reused: [], absent: [], events: boundedEvents(events) };
}

// One report line per boundary. Identity only: no argv, no paths.
function boundaryLine(result) {
  const status = String(result.status || 'unknown').toUpperCase();
  const ids = (result.survivors || []).slice(0, MAX_EVENT_ROWS)
    .map(s => `pid=${s.pid} created=${s.created} role=${['runner', 'descendant', 'job'].includes(s.role) ? s.role : 'registered'}`)
    .join(' ');
  const truncated = (result.survivors || []).length > MAX_EVENT_ROWS
    ? ` (+${result.survivors.length - MAX_EVENT_ROWS} more)` : '';
  const reason = result.reason ? ` reason=${result.reason}` : '';
  const diagnostic = result.unverified?.length
    ? ` identity=UNVERIFIED reason=creation-time-unavailable count=${result.unverified.length}` : '';
  return `[boundary] PROCESS-BOUNDARY-${status} run=${result.runId ?? 'unknown'} survivors=${(result.survivors || []).length} stopped=${result.stopped === true ? 'yes' : 'no'}${reason}${ids ? ` ${ids}` : ''}${truncated}${diagnostic}`;
}

// The real process table of this host: the operator collectors, nothing else. Windows through the
// PowerShell collector, Linux through /proc, any other platform has no collector (null).
function collectProcesses() {
  try {
    return require('../operator/auto-retire.cjs').processes({ identitiesOnly: true });
  } catch {
    return null;
  }
}

module.exports = {
  REGISTRY_SCHEMA,
  MAX_REGISTRY_ROWS,
  MAX_EVENT_ROWS,
  GRACE_MS,
  RECHECKS,
  RECHECK_DELAY_MS,
  readRegistry,
  appendRegistry,
  registerFromTable,
  verifyBoundary,
  enforceBoundary,
  boundedEvents,
  boundaryLine,
  collectProcesses,
};

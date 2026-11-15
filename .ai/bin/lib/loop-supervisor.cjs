'use strict';

// Pure lifecycle policy, NOT an atomic claim or a process launcher.
// Callers must obtain a complete, fresh OS snapshot and serialize admission.
// A PID is an identity only together with its exact OS creation timestamp.
const LOOPS = Object.freeze(['cert-queue', 'farm-autosubmit', 'heavy-guard', 'seat-priority-guard', 'route-refresh']);
const SCHEMA = 'loop-runner/1';
const MAX_AGE_MS = 5000;
const MAX_CHILDREN = 512;
const pid = v => Number.isSafeInteger(v) && v > 0;
const stamp = v => Number.isSafeInteger(v) && v >= 0;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const identity = v => object(v) && pid(v.pid) && stamp(v.created);
const hostName = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]{0,252}$/.test(v);
const blocked = reason => ({ status: 'BLOCKED', reason });

function inspect(input) {
  if (!object(input) || !LOOPS.includes(input.loop) || !hostName(input.host) || !stamp(input.nowMs)) {
    return { error: 'INPUT_INVALID' };
  }
  const { record, table, host, loop, nowMs } = input;
  if (!object(table) || table.host !== host || table.complete !== true ||
      !stamp(table.observedMs) || table.observedMs > nowMs || nowMs - table.observedMs > MAX_AGE_MS ||
      !Array.isArray(table.processes) || table.processes.length > 65536) return { error: 'TABLE_UNVERIFIED' };
  const byPid = new Map();
  for (const row of table.processes) {
    if (!identity(row) || byPid.has(row.pid)) return { error: 'TABLE_INVALID' };
    byPid.set(row.pid, row);
  }
  // null means a positively established missing record; undefined/read failure is not absence.
  if (record === null) return { missing: true };
  if (!object(record) || record.schema !== SCHEMA || record.loop !== loop || record.host !== host ||
      typeof record.runId !== 'string' || !/^[a-f0-9]{32}$/.test(record.runId) ||
      !identity(record.runner) || !Array.isArray(record.children) || record.children.length > MAX_CHILDREN) {
    return { error: 'RECORD_INVALID' };
  }
  const identities = [record.runner, ...record.children];
  const seen = new Set();
  for (const row of identities) {
    if (!identity(row) || seen.has(row.pid)) return { error: 'RECORD_INVALID' };
    seen.add(row.pid);
  }
  const alive = row => byPid.get(row.pid)?.created === row.created;
  return { runnerAlive: alive(record.runner), childAlive: record.children.some(alive) };
}

function assessStart(input) {
  const state = inspect(input);
  if (state.error) return blocked(state.error);
  if (state.missing) return { status: 'STARTABLE', reason: 'NO_RECORD' };
  if (state.runnerAlive) return { status: 'DUPLICATE', reason: 'RUNNER_ALIVE' };
  if (state.childAlive) return blocked('CHILD_SURVIVES');
  return { status: 'STARTABLE', reason: 'PREVIOUS_GONE' };
}

function assessStopped(input) {
  const state = inspect(input);
  if (state.error) return blocked(state.error);
  if (state.missing) return blocked('RECORD_REQUIRED');
  if (state.runnerAlive) return blocked('RUNNER_SURVIVES');
  if (state.childAlive) return blocked('CHILD_SURVIVES');
  return { status: 'STOPPED', reason: 'ALL_RECORDED_GONE' };
}

module.exports = { SCHEMA, LOOPS, MAX_AGE_MS, assessStart, assessStopped };

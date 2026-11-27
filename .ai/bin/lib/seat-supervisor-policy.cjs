'use strict';

// S1: pure decisions over verified snapshots. No IO, launcher, timer or sender.
// A schema is not authentication: S2/S5 must verify provenance and serialize reads.
const SCHEMA = 'seat-supervisor-policy/1';
const PASS_SCHEMA = 'seat-supervisor-pass/1';
const PASS_SOURCE = 'seat-supervisor/operator-pass.json';
// A producer identity, not a reference to an executable that S5 has yet to ship.
const PASS_WRITER = 'operator-pass-completed/1';
const SILENCE_MS = 1800000, COORDINATOR_MS = 180000, COHORT_MS = 300000;
const MAX_RUNS = 512;
const object = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const integer = v => Number.isSafeInteger(v) && v >= 0;
const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(v) && !/[\r\n]/.test(v);
const keys = (v, names) => object(v) && Object.keys(v).length === names.length && names.every(n => Object.hasOwn(v, n));
const point = v => keys(v, ['bootId', 'monoMs', 'utcMs']) && id(v.bootId) && integer(v.monoMs) && integer(v.utcMs);
const decision = (kind, status, reason) => ({ kind, status, reason });
const unknown = (kind, reason) => decision(kind, 'UNKNOWN', reason);

// Monotonic time wins within a boot. Cross-boot UTC needs external continuity
// verification; rollback or unknown clocks cannot grant a fresh healthy window.
function elapsed(clock, start) {
  if (!point(start)) return null;
  if (start.bootId === clock.bootId) return start.monoMs <= clock.monoMs ? clock.monoMs - start.monoMs : null;
  if (clock.utcTrusted !== true || start.utcMs > clock.utcMs) return null;
  return clock.utcMs - start.utcMs;
}

function silence(input) {
  const kind = 'OPERATOR_SILENT', { work, pass, passFloor, clock, machine } = input;
  if (!object(work) || !['OPEN', 'IDLE', 'UNKNOWN'].includes(work.state)) return unknown(kind, 'WORK_UNKNOWN');
  if (work.state === 'UNKNOWN') return unknown(kind, 'WORK_UNKNOWN');
  if (work.state === 'IDLE') return keys(work, ['state']) ? decision(kind, 'CLEAR', 'IDLE') : unknown(kind, 'WORK_INVALID');
  if (!keys(work, ['state', 'since']) || elapsed(clock, work.since) === null) return unknown(kind, 'CLOCK_UNVERIFIED');
  const floorValid = passFloor === null || (keys(passFloor, ['operatorId', 'bootId', 'sequence']) &&
    id(passFloor.operatorId) && id(passFloor.bootId) && integer(passFloor.sequence) && passFloor.sequence > 0);
  if (!floorValid) return unknown(kind, 'PASS_UNVERIFIED');
  let anchor = work.since;
  if (pass !== null) {
    if (!keys(pass, ['schema', 'source', 'writer', 'machine', 'operatorId', 'sequence', 'completed']) ||
        pass.schema !== PASS_SCHEMA || pass.source !== PASS_SOURCE || pass.writer !== PASS_WRITER ||
        pass.machine !== machine || !id(pass.operatorId) || !integer(pass.sequence) || pass.sequence < 1 ||
        !point(pass.completed)) return unknown(kind, 'PASS_UNVERIFIED');
    if (passFloor !== null && (passFloor.operatorId !== pass.operatorId || passFloor.bootId !== pass.completed.bootId ||
        pass.sequence < passFloor.sequence)) return unknown(kind, 'PASS_SEQUENCE_UNVERIFIED');
    anchor = pass.completed;
  } else if (passFloor !== null) return unknown(kind, 'PASS_DISAPPEARED');
  const age = elapsed(clock, anchor);
  if (age === null) return unknown(kind, 'CLOCK_UNVERIFIED');
  return age >= SILENCE_MS ? decision(kind, 'ALERT', 'PASS_OVERDUE') : decision(kind, 'CLEAR', 'PASS_WITHIN_WINDOW');
}

function coordinator(input) {
  const kind = 'COORDINATOR_UNREACHABLE', { coordinator: probe, clock } = input;
  if (!keys(probe, ['state', 'firstFailure'])) return unknown(kind, 'PROBE_UNVERIFIED');
  if (probe.state === 'REACHABLE' && probe.firstFailure === null) return decision(kind, 'CLEAR', 'REACHABLE');
  if (probe.state !== 'UNREACHABLE') return unknown(kind, 'PROBE_UNVERIFIED');
  const age = elapsed(clock, probe.firstFailure);
  if (age === null) return unknown(kind, 'CLOCK_UNVERIFIED');
  return age > COORDINATOR_MS ? decision(kind, 'ALERT', 'LAN_OUTAGE') : decision(kind, 'CLEAR', 'WITHIN_GRACE');
}

function cohort(input) {
  const kind = 'ALL_SEATS_ENDED', { cohort: group, clock } = input;
  if (group === null) return decision(kind, 'CLEAR', 'NO_COHORT');
  if (!keys(group, ['bootId', 'frozenMonoMs', 'fixed', 'runs']) || group.fixed !== true ||
      !id(group.bootId) || !integer(group.frozenMonoMs) || !Array.isArray(group.runs) ||
      group.runs.length > MAX_RUNS) return unknown(kind, 'COHORT_UNVERIFIED');
  if (group.bootId !== clock.bootId) return unknown(kind, 'COHORT_OTHER_BOOT');
  if (group.frozenMonoMs > clock.monoMs) return unknown(kind, 'CLOCK_UNVERIFIED');
  const seen = new Set(), ends = [];
  let planned = true;
  for (const run of group.runs) {
    if (!keys(run, ['runId', 'endedMonoMs', 'expected', 'exitClass']) ||
        typeof run.runId !== 'string' || run.runId.length !== 32 || !/^[a-f0-9]{32}$/.test(run.runId) || seen.has(run.runId)) return unknown(kind, 'COHORT_UNVERIFIED');
    seen.add(run.runId);
    if (run.endedMonoMs === null) {
      if (run.expected !== null || run.exitClass !== null) return unknown(kind, 'EXIT_UNVERIFIED');
      continue;
    }
    if (!integer(run.endedMonoMs) || run.endedMonoMs < group.frozenMonoMs || run.endedMonoMs > clock.monoMs ||
        typeof run.expected !== 'boolean' || !['SUCCESS', 'FAILURE', 'STOPPED', 'UNKNOWN'].includes(run.exitClass)) return unknown(kind, 'EXIT_UNVERIFIED');
    ends.push(run.endedMonoMs);
    planned = planned && run.expected;
  }
  if (group.runs.length < 2) return decision(kind, 'CLEAR', 'SMALL_COHORT');
  if (ends.length !== group.runs.length) return decision(kind, 'CLEAR', 'COHORT_ACTIVE');
  if (Math.max(...ends) - Math.min(...ends) > COHORT_MS) return decision(kind, 'CLEAR', 'OUTSIDE_WINDOW');
  return decision(kind, 'ALERT', planned ? 'EXPECTED_END' : 'UNEXPECTED_END');
}

function reboot(input) {
  const kind = 'MAIN_PC_REBOOTED';
  if (input.previousBootId === null) return decision(kind, 'CLEAR', 'FIRST_OBSERVATION');
  if (!id(input.previousBootId)) return unknown(kind, 'BOOT_UNVERIFIED');
  return input.previousBootId !== input.clock.bootId ? decision(kind, 'ALERT', 'BOOT_CHANGED') : decision(kind, 'CLEAR', 'SAME_BOOT');
}

function assess(input) {
  const kinds = ['OPERATOR_SILENT', 'COORDINATOR_UNREACHABLE', 'ALL_SEATS_ENDED', 'MAIN_PC_REBOOTED'];
  if (!keys(input, ['schema', 'machine', 'clock', 'previousBootId', 'work', 'pass', 'passFloor', 'coordinator', 'cohort']) ||
      input.schema !== SCHEMA || !id(input.machine) || !keys(input.clock, ['bootId', 'monoMs', 'utcMs', 'utcTrusted']) ||
      !id(input.clock.bootId) || !integer(input.clock.monoMs) || !integer(input.clock.utcMs) || typeof input.clock.utcTrusted !== 'boolean') {
    return { schema: SCHEMA, alarms: kinds.map(kind => unknown(kind, 'INPUT_UNVERIFIED')) };
  }
  return { schema: SCHEMA, alarms: [silence(input), coordinator(input), cohort(input), reboot(input)] };
}

module.exports = { SCHEMA, PASS_SCHEMA, PASS_SOURCE, PASS_WRITER, SILENCE_MS, COORDINATOR_MS, COHORT_MS, assess };

'use strict';

// Lease and stop plan for the dispatcher (S4-T04, R-L3-004.7). Pure: the process table is a parameter.
// A process is identified by PID and creation time together; a stop never selects by parent linkage alone.
//
// lease record: { supervisor: {pid, createdAt}, attempts: [{ root: {pid, createdAt}, descendants: [{pid, createdAt}],
//                 unrecorded: [{pid, createdAt}], settled, unsettledReason?, ack?: {at, note} }] }
// table entry:  { pid, ppid, createdAt }  (createdAt is ISO UTC with milliseconds)
// table:        an array, or null when the process table could not be read. null is never the same as [].

function sameProcess(rec, live) {
  return Boolean(rec) && Boolean(live) && rec.pid === live.pid && rec.createdAt === live.createdAt;
}

function aliveByIdentity(rec, table) {
  return (table || []).some(p => sameProcess(rec, p));
}

// Every live unrecorded process of every attempt that has no ack: the owner needs all of them to know what to check.
function collectOrphans(attempts, table) {
  const out = [];
  for (const a of attempts) {
    if (a.ack) continue;
    for (const r of a.unrecorded || []) {
      if (aliveByIdentity(r, table) && !out.some(o => sameProcess(o, r))) out.push({ pid: r.pid, createdAt: r.createdAt });
    }
  }
  return out;
}

// The owner-facing text of a refused start: the reason, one line per orphan, and the exact release command.
// The record is what the state file keeps; lines is what the CLI prints.
function refusalReport({ dispatchFile, slotId, decision }) {
  const orphans = Array.isArray(decision.orphans) ? decision.orphans : [];
  const record = { reason: decision.reason };
  if (orphans.length) {
    record.orphans = orphans.map(o => ({ pid: o.pid, createdAt: o.createdAt }));
    record.ackCommand = `node .ai/bin/protocol-dispatch.cjs stop ${dispatchFile} ${slotId} --ack "<note>"`;
  }
  const lines = [`ERROR reason=lease-refused slot=${slotId} detail=${decision.reason}`];
  for (const o of record.orphans || []) lines.push(`orphan pid=${o.pid} createdAt=${o.createdAt}`);
  if (record.ackCommand) lines.push(`release: ${record.ackCommand}`);
  return { lines, record };
}

function decideStart({ lease, table }) {
  if (!lease) return { allow: true, reason: 'ok' };
  // an unreadable table cannot show that the recorded processes are gone: no start, whatever the lease says
  if (!Array.isArray(table)) return { allow: false, reason: 'table-unavailable' };
  const attempts = Array.isArray(lease.attempts) ? lease.attempts : [];
  if (aliveByIdentity(lease.supervisor, table)) return { allow: false, reason: 'running-supervisor-alive' };
  if (attempts.some(a => !a.settled)) return { allow: false, reason: 'unsettled-attempt' };
  for (const a of attempts) {
    const recorded = [a.root, ...(a.descendants || [])];
    if (recorded.some(r => aliveByIdentity(r, table))) return { allow: false, reason: 'recorded-process-alive' };
  }
  // a live unrecorded process keeps its attempt unclean until the owner acknowledges it (ack on the attempt)
  for (const a of attempts) {
    if (a.ack) continue;
    if ((a.unrecorded || []).some(r => aliveByIdentity(r, table))) {
      return { allow: false, reason: 'unrecorded-process-alive', orphans: collectOrphans(attempts, table) };
    }
  }
  return { allow: true, reason: 'ok' };
}

function createdMs(rec) {
  return Date.parse(rec.createdAt);
}

// Live descendants of rootPid for RECORDING (identity captured now, confirmed again at stop time).
// A process older than the parent it names is a reused-PID artifact and is not recorded.
function descendantsOf(table, rootPid) {
  const byParent = new Map();
  for (const p of table || []) {
    if (!byParent.has(p.ppid)) byParent.set(p.ppid, []);
    byParent.get(p.ppid).push(p);
  }
  const byPid = new Map((table || []).map(p => [p.pid, p]));
  const out = [];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length) {
    const parentPid = queue.shift();
    const parent = byPid.get(parentPid);
    for (const child of byParent.get(parentPid) || []) {
      if (seen.has(child.pid)) continue;
      if (parent && createdMs(child) < createdMs(parent)) continue;
      seen.add(child.pid);
      out.push({ pid: child.pid, createdAt: child.createdAt });
      queue.push(child.pid);
    }
  }
  return out;
}

// Live processes under the root or a recorded descendant that nobody recorded: reported with their identity, never
// killed. A record whose PID now belongs to another process is not a family member; a child created before the
// parent it names is a reused-PID artifact. The root may already be dead (a stale parent PID still names it).
function findUnrecorded({ root, recorded, table }) {
  const live = new Map((table || []).map(p => [p.pid, p]));
  const recs = [root, ...(recorded || [])].filter(Boolean);
  const recordedPids = new Set(recs.map(r => r.pid));
  const born = new Map();
  for (const r of recs) {
    const now = live.get(r.pid);
    if (now && r.createdAt && now.createdAt !== r.createdAt) continue;
    born.set(r.pid, r.createdAt ? Date.parse(r.createdAt) : null);
  }
  const out = [];
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of live.values()) {
      if (born.has(p.pid) || recordedPids.has(p.pid) || !born.has(p.ppid)) continue;
      const parentBorn = born.get(p.ppid);
      if (parentBorn !== null && createdMs(p) < parentBorn) continue;
      born.set(p.pid, createdMs(p));
      out.push({ pid: p.pid, createdAt: p.createdAt });
      grew = true;
    }
  }
  return out.sort((a, b) => a.pid - b.pid);
}

// Stop plan: recorded descendants by PID, leaves first, only when the fresh table confirms the identity;
// the root goes last through the dispatcher's own child handle. There is no tree operation.
// table === null (unreadable) plans nothing and says so: the caller must not settle on it.
function planStop({ root, recorded, table }) {
  if (!Array.isArray(table)) return { steps: [], skipped: [], unrecorded: [], unrecordedIdentities: [], tableUnavailable: true };
  const live = new Map(table.map(p => [p.pid, p]));
  const skipped = [];
  const toStop = [];
  for (const rec of recorded || []) {
    const now = live.get(rec.pid);
    if (!now) { skipped.push({ pid: rec.pid, reason: 'not-running' }); continue; }
    if (!sameProcess(rec, now)) { skipped.push({ pid: rec.pid, reason: 'identity-mismatch' }); continue; }
    const parent = live.get(now.ppid);
    if (parent && createdMs(now) < createdMs(parent)) { skipped.push({ pid: rec.pid, reason: 'older-than-parent' }); continue; }
    toStop.push(now);
  }

  const depthOf = p => {
    let depth = 0;
    let cur = p;
    const seen = new Set();
    while (cur && !seen.has(cur.pid)) {
      seen.add(cur.pid);
      cur = live.get(cur.ppid);
      depth++;
    }
    return depth;
  };
  toStop.sort((a, b) => depthOf(b) - depthOf(a) || a.pid - b.pid);

  const steps = toStop.map(p => ({ op: 'kill-pid', pid: p.pid }));
  steps.push({ op: 'kill-handle', pid: root.pid });

  const unrecordedIdentities = findUnrecorded({ root, recorded, table });
  return { steps, skipped, unrecorded: unrecordedIdentities.map(u => u.pid), unrecordedIdentities };
}

// After the stop: what is still alive by identity among the root, the recorded descendants and the unrecorded ones.
// table === null cannot verify anything. A root whose creation time was never seen cannot be matched and counts as gone
// (the caller captures the identity from the pre-kill table when it can).
function verifyStopped({ root, recorded, unrecorded, table }) {
  if (!Array.isArray(table)) return { verified: false, reason: 'table-unavailable', alive: [] };
  const alive = [];
  const mark = (rec, role) => { if (rec && rec.createdAt && aliveByIdentity(rec, table)) alive.push({ pid: rec.pid, createdAt: rec.createdAt, role }); };
  mark(root, 'root');
  for (const r of recorded || []) mark(r, 'recorded');
  for (const r of unrecorded || []) mark(r, 'unrecorded');
  return { verified: alive.length === 0, reason: alive.length ? 'process-alive' : 'ok', alive };
}

module.exports = { sameProcess, decideStart, refusalReport, descendantsOf, findUnrecorded, planStop, verifyStopped };

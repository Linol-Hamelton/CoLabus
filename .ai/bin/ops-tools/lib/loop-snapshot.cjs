'use strict';
// LOOP-RUNNER lpr1: the OS process snapshot the LOOP-SUPERVISOR policy requires.
// One row per process: PID, parent PID and the exact creation time in epoch ms.
// Identity is PID together with creation time, never the PID alone. A snapshot is
// complete only when the OS query succeeded, every line parsed and the caller's own
// PID is present (a partial enumeration cannot contain the witness). Any doubt -> null,
// the caller blocks; an unknown creation time is never guessed.
// Layer: ops-tools library; docs/ops/PROCESS-REGISTER.md P-213. Node builtins only.
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const MAX_ROWS = 65536; // the policy table bound

// Pure parser: 'pid ppid createdMs' per line, LF or CRLF. One malformed or
// UNREADABLE line voids the whole table (fail closed, never a partial snapshot).
function parseRows(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const lines = text.trim().split(/\r?\n/);
  if (!lines.length || lines.length > MAX_ROWS) return null;
  const rows = [];
  const seen = new Set();
  for (const line of lines) {
    const m = /^([0-9]{1,10}) ([0-9]{1,10}) ([0-9]{1,15})$/.exec(line);
    if (!m) return null;
    const pid = Number(m[1]), created = Number(m[3]);
    if (!Number.isSafeInteger(pid) || pid < 0 || !Number.isSafeInteger(created) || created < 0) return null;
    if (pid === 0) continue; // the idle pseudo-process is never a loop identity; the policy table refuses it
    if (seen.has(pid)) return null; // one OS row per PID; a duplicate voids the snapshot
    seen.add(pid);
    rows.push({ pid, ppid: Number(m[2]), created });
  }
  return rows.length ? rows : null;
}

// Table contract of .ai/bin/lib/loop-supervisor.cjs, plus ppid kept aside for the
// runner's child discovery. complete is true only with the self-PID witness.
function buildTable({ rows, host, observedMs, selfPid }) {
  if (!Array.isArray(rows) || !rows.length || !rows.some(r => r.pid === selfPid)) return null;
  return {
    host, observedMs, complete: true,
    processes: rows.map(r => ({ pid: r.pid, created: r.created })),
    byPpid: rows.reduce((map, r) => {
      const list = map.get(r.ppid) || []; list.push({ pid: r.pid, created: r.created }); map.set(r.ppid, list); return map;
    }, new Map()),
  };
}

// Windows collector through CIM Win32_Process. CreationDate is converted to Unix ms
// inside PowerShell so no .NET culture or fraction reaches this process. A filtered
// query (pids) re-verifies one identity immediately before a stop signal. A pid that
// is not a positive safe integer is never interpolated into the OS query: null.
function snapshotScript(pids) {
  if (Array.isArray(pids) && pids.length && pids.some(p => !Number.isSafeInteger(p) || p <= 0)) return null;
  const filter = Array.isArray(pids) && pids.length
    ? ` -Filter '${pids.map(p => `ProcessId=${p}`).join(' OR ')}'` : '';
  return 'Get-CimInstance Win32_Process' + filter + ' -ErrorAction Stop | ForEach-Object { ' +
    "if ($_.CreationDate) { '{0} {1} {2}' -f $_.ProcessId, $_.ParentProcessId, [DateTimeOffset]::new($_.CreationDate.ToUniversalTime()).ToUnixTimeMilliseconds() } " +
    "else { 'UNREADABLE' } }";
}

function collect({ host, selfPid, pids, spawn, timeoutMs = 20000, platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32' || !env.SystemRoot) return null;
  const run = spawn || spawnSync;
  const ps = path.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = snapshotScript(pids);
  if (script === null) return null; // an unvalidated pid never reaches the OS query
  const observedMs = Date.now();
  const r = run(ps, ['-NoProfile', '-NonInteractive', '-Command', script],
    { shell: false, windowsHide: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
  if (!r || r.error || r.status !== 0 || typeof r.stdout !== 'string') return null;
  const rows = parseRows(r.stdout);
  if (rows === null) return null;
  if (Array.isArray(pids) && pids.length) {
    // A filtered query has no completeness witness; the caller compares identities.
    return { host, observedMs, complete: false, processes: rows.map(x => ({ pid: x.pid, created: x.created })) };
  }
  return buildTable({ rows, host, observedMs, selfPid });
}

module.exports = { MAX_ROWS, parseRows, buildTable, snapshotScript, collect };

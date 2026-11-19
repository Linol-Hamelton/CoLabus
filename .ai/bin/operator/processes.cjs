'use strict';
// Process report and guarded stop of the operator layer.
//   node .ai/bin/operator/processes.cjs list [--root DIR] [--older-than-hours N] [--all-ages] [--json] [--write-list FILE]
//   node .ai/bin/operator/processes.cjs stop [--root DIR] --pid N
//   node .ai/bin/operator/processes.cjs stop [--root DIR] --list FILE
// list: agent and MCP processes of THIS project (the command line or the working directory names the project or one of
// its worktrees, or the launch wrapper registered the pid), older than N hours (operatorLayer.processes.olderThanHours,
// default 6), with age and CPU seconds. Command lines are shortened and withheld when they carry a credential shape.
// stop --pid: only a pid the launch wrapper registered for a launch that has not ended (RUNTIME/NAME.running.json,
// wrapperPid or childPid), and only while the live process still has the identity of that launch (its creation time fits
// the launch start; a reused pid is refused). Every other process is stopped only through --list FILE: a list written by
// `list --write-list FILE`, in which the owner, after reading it, set "confirmedBy" to their name; each row is stopped
// only when pid, creation time and image name still match. Nothing else is ever stopped.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const layer = require('./layer.cjs');
const slots = require('../lib/seat-slots.cjs');
const { secretIn } = require('../lib/secrets.cjs');

const AGENT_RE = /(?:^|[\\/\s"'])(?:claude|codex|kilo|kilocode|vibe|mimo|mimocode|qwen|kimi|gemini|copilot|opencode|aider|cursor-agent|goose|crush)(?:\.exe|\.cmd|\.js|\.mjs|\.cjs)?(?=$|[\s"'\\/])/i;
const MCP_RE = /mcp|modelcontextprotocol/i;
const LIST_SCHEMA = 'process-stop-list/1';

class ProcError extends Error { constructor(code, detail) { super(`${code}${detail ? `: ${detail}` : ''}`); this.code = code; } }

function runJson(file) {
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 120000 });
  if (r.error || r.status !== 0) return null;
  try { const v = JSON.parse(r.stdout); return Array.isArray(v) ? v : [v]; } catch { return null; }
}
// The live table: [{ pid, ppid, created (unix ms), name, exe, cmd, cpu (seconds), cwd }]. Throws when it cannot be read:
// a report without a table is never shown as "nothing running".
function processTable() {
  if (process.platform === 'win32') {
    const rows = runJson(path.join(__dirname, 'processes.ps1'));
    if (!rows) throw new ProcError('PROCESS_TABLE_UNAVAILABLE', 'the Windows process query failed');
    const cwdScript = path.join(__dirname, 'auto-retire-processes.ps1');
    const cwds = fs.existsSync(cwdScript) ? runJson(cwdScript) : null;
    const byKey = new Map((cwds || []).filter(r => r && r.pid).map(r => [`${r.pid}:${r.created}`, r.cwd || null]));
    return rows.filter(r => r && Number.isInteger(r.pid)).map(r => ({ ...r, cwd: byKey.get(`${r.pid}:${r.created}`) || null }));
  }
  const r = spawnSync('ps', ['-eo', 'pid=,ppid=,etimes=,times=,comm=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error || r.status !== 0) throw new ProcError('PROCESS_TABLE_UNAVAILABLE', 'ps failed');
  const now = Date.now();
  const out = [];
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!m) continue;
    let cwd = null;
    try { cwd = fs.readlinkSync(`/proc/${m[1]}/cwd`); } catch { /* not linux or denied */ }
    out.push({ pid: Number(m[1]), ppid: Number(m[2]), created: Math.round((now - Number(m[3]) * 1000) / 1000) * 1000, cpu: Number(m[4]), name: path.basename(m[5]), exe: null, cmd: m[6] || m[5], cwd });
  }
  return out;
}

const norm = p => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
function within(child, parent) { const c = norm(child); const p = norm(parent); return !!c && !!p && (c === p || c.startsWith(`${p}/`)); }
function classOf(row) {
  const text = `${row.exe || ''} ${row.cmd || ''} ${row.name || ''}`;
  if (MCP_RE.test(text)) return 'mcp';
  if (AGENT_RE.test(` ${text}`)) return 'agent';
  return null;
}
function shownCommand(cmd) {
  const c = String(cmd || '').replace(/\s+/g, ' ').trim();
  if (!c) return '';
  if (secretIn(c) || /(?:api[_-]?key|token|secret|password)\s*[=:]\s*\S{6,}/i.test(c)) return '[command line withheld: credential shape]';
  return c.length > 160 ? `${c.slice(0, 157)}...` : c;
}
// Registered launches that have not ended: pid -> { name, role, startedAt }.
function registered(root, settings) {
  const runtime = path.join(root, settings.runtime);
  const out = new Map();
  let names = [];
  try { names = fs.readdirSync(runtime); } catch { return out; }
  for (const f of names.filter(n => n.endsWith('.running.json'))) {
    const name = f.slice(0, -'.running.json'.length);
    let r;
    try { r = JSON.parse(fs.readFileSync(path.join(runtime, f), 'utf8')); } catch { continue; }
    if (!r || r.ended) continue;
    // One identity rule (seat-slots.cjs): only a terminal record of the same attempt ends the launch; a terminal of
    // another attempt of the name, or one that cannot be read, ends nothing.
    if (names.includes(`${name}.terminal.json`)) {
      let t = null;
      try { t = JSON.parse(fs.readFileSync(path.join(runtime, `${name}.terminal.json`), 'utf8')); } catch { /* unreadable: ends nothing */ }
      if (slots.sameAttempt(r, t)) continue;
    }
    for (const role of ['wrapperPid', 'childPid']) if (Number.isInteger(r[role]) && r[role] > 0) out.set(r[role], { name, role, startedAt: r.startedAt });
  }
  return out;
}
// A registered pid still names the process of that launch: the wrapper was created at most ten minutes before the
// recorded start, the child within ten minutes after it (five seconds of clock slack). A pid created later is a reuse.
function identityFits(reg, row) {
  const start = Date.parse(reg.startedAt);
  if (!Number.isFinite(start) || !Number.isFinite(row.created)) return false;
  if (reg.role === 'wrapperPid') return row.created <= start + 5000 && row.created >= start - 600000;
  return row.created >= start - 5000 && row.created <= start + 600000;
}

function report(root, opts = {}, deps = {}) {
  const settings = opts.settings || layer.loadSettings(root);
  const now = opts.now || Date.now();
  const table = (deps.table || processTable)();
  let trees = [root];
  try { trees = [root, ...(deps.worktrees || defaultWorktrees)(root).filter(p => !within(p, root))]; } catch { /* the root alone */ }
  const reg = registered(root, settings);
  const olderH = opts.olderThanHours !== undefined ? opts.olderThanHours : settings.processes.olderThanHours;
  const rows = [];
  for (const p of table) {
    if (p.pid === process.pid) continue;
    const r0 = reg.get(p.pid);
    const r = r0 && identityFits(r0, p) ? r0 : null;
    const cls = classOf(p);
    let match = null;
    if (r) match = 'registered';
    else if (p.cwd && trees.some(t => within(p.cwd, t))) match = 'cwd';
    else if (p.cmd && trees.some(t => norm(p.cmd).includes(norm(t)))) match = 'cmd';
    if (!match || (!cls && !r)) continue;
    const ageH = Number.isFinite(p.created) ? Math.round(((now - p.created) / 3600000) * 10) / 10 : null;
    rows.push({ pid: p.pid, ppid: p.ppid, created: p.created, name: p.name || null, class: cls || 'launch', match, registered: r ? r.name : null, ageHours: ageH, cpuSeconds: p.cpu === undefined ? null : p.cpu, cmd: shownCommand(p.cmd) });
  }
  const shown = rows.filter(r => opts.allAges || (r.ageHours !== null && r.ageHours >= olderH)).sort((a, b) => (b.ageHours || 0) - (a.ageHours || 0));
  return { root, olderThanHours: olderH, total: rows.length, rows: shown };
}
function defaultWorktrees(root) {
  const r = spawnSync('git', ['worktree', 'list', '--porcelain'], { cwd: root, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) return [];
  return r.stdout.split(/\r?\n/).filter(l => l.startsWith('worktree ')).map(l => path.resolve(l.slice(9)));
}
const line = r => `PROC pid=${r.pid} age=${r.ageHours === null ? '?' : `${r.ageHours}h`} cpu=${r.cpuSeconds === null ? '?' : `${r.cpuSeconds}s`} class=${r.class} match=${r.match}${r.registered ? ` launch=${r.registered}` : ''} name=${r.name || '?'} cmd="${r.cmd}"`;

function killPid(pid, deps = {}) {
  if (deps.kill) return deps.kill(pid);
  if (process.platform === 'win32') {
    const r = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true });
    return r.status === 0 && !r.error;
  }
  try { process.kill(pid, 'SIGTERM'); return true; } catch { return false; }
}
function stopRegistered(root, pid, opts = {}, deps = {}) {
  if (!Number.isInteger(pid) || pid <= 0) throw new ProcError('USAGE', '--pid needs a process id');
  const settings = opts.settings || layer.loadSettings(root);
  const reg = registered(root, settings).get(pid);
  if (!reg) return { ok: false, line: `REFUSED NOT_REGISTERED pid=${pid}: the launch wrapper did not register this pid for a running launch; list it with processes.cjs list --write-list FILE and stop it only through a list the owner confirmed` };
  const row = (deps.table || processTable)().find(p => p.pid === pid);
  if (!row) return { ok: false, line: `REFUSED NOT_RUNNING pid=${pid} launch=${reg.name}` };
  if (!identityFits(reg, row)) return { ok: false, line: `REFUSED PID_REUSED pid=${pid} launch=${reg.name}: the live process was not created by that launch` };
  const ok = killPid(pid, deps);
  if (ok) { try { fs.writeFileSync(path.join(root, settings.runtime, `${reg.name}.stopped.json`), `${JSON.stringify({ schema: 'launch-stopped/1', name: reg.name, pid, role: reg.role, stoppedAt: new Date().toISOString(), by: 'processes.cjs stop --pid' }, null, 2)}\n`); } catch { /* the stop itself stands */ } }
  return { ok, line: `${ok ? 'STOPPED' : 'STOP-FAILED'} pid=${pid} launch=${reg.name} role=${reg.role}` };
}
function readList(file) {
  let v;
  try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new ProcError('LIST_UNREADABLE', e.code || 'not JSON'); }
  if (!v || v.schema !== LIST_SCHEMA || !Array.isArray(v.processes)) throw new ProcError('LIST_INVALID', `schema ${LIST_SCHEMA} with a processes list expected`);
  if (typeof v.confirmedBy !== 'string' || !v.confirmedBy.trim()) throw new ProcError('LIST_NOT_CONFIRMED', 'the owner has not confirmed this list (set "confirmedBy" to their name after reading it)');
  for (const p of v.processes) if (!p || !Number.isInteger(p.pid) || !Number.isFinite(p.created) || typeof p.name !== 'string') throw new ProcError('LIST_INVALID', 'every row needs pid, created and name');
  return v;
}
function stopListed(root, file, opts = {}, deps = {}) {
  const list = readList(file);
  if (list.root && norm(list.root) !== norm(root)) throw new ProcError('LIST_INVALID', 'the list was written for another project');
  const table = (deps.table || processTable)();
  const lines = [];
  let stopped = 0;
  for (const want of list.processes) {
    const row = table.find(p => p.pid === want.pid);
    if (!row) { lines.push(`SKIPPED pid=${want.pid} NOT_RUNNING`); continue; }
    if (row.created !== want.created || String(row.name).toLowerCase() !== want.name.toLowerCase()) { lines.push(`SKIPPED pid=${want.pid} IDENTITY_CHANGED`); continue; }
    const ok = killPid(want.pid, deps);
    if (ok) stopped++;
    lines.push(`${ok ? 'STOPPED' : 'STOP-FAILED'} pid=${want.pid} name=${want.name} confirmedBy=${list.confirmedBy}`);
  }
  lines.push(`RESULT stopped=${stopped} listed=${list.processes.length}`);
  return { lines, stopped };
}
function writeList(root, rep, file) {
  const rows = rep.rows.filter(r => !r.registered).map(r => ({ pid: r.pid, created: r.created, name: r.name, class: r.class, ageHours: r.ageHours, cpuSeconds: r.cpuSeconds, cmd: r.cmd }));
  fs.writeFileSync(file, `${JSON.stringify({ schema: LIST_SCHEMA, root, writtenAt: new Date().toISOString(), confirmedBy: null, note: 'Read every row. Remove rows that must keep running. Set confirmedBy to your name to allow processes.cjs stop --list FILE.', processes: rows }, null, 2)}\n`, 'utf8');
  return rows.length;
}

function main(argv, log = s => process.stdout.write(`${s}\n`), deps = {}) {
  const cmd = argv[0];
  const o = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (['--json', '--all-ages'].includes(a)) o[a.slice(2)] = true;
    else if (['--root', '--older-than-hours', '--pid', '--list', '--write-list'].includes(a) && i + 1 < argv.length) o[a.slice(2)] = argv[++i];
    else { log(`usage error: unknown or incomplete argument ${a}`); return 2; }
  }
  if (!['list', 'stop'].includes(cmd)) { log('usage: processes.cjs list|stop [--root DIR] ...'); return 2; }
  const root = layer.mainRoot(path.resolve(o.root || process.cwd()));
  try {
    if (cmd === 'list') {
      const older = o['older-than-hours'] !== undefined ? Number(o['older-than-hours']) : undefined;
      if (older !== undefined && !(older >= 0)) { log('usage error: --older-than-hours needs a number'); return 2; }
      const rep = report(root, { olderThanHours: older, allAges: o['all-ages'] }, deps);
      if (o.json) log(JSON.stringify(rep, null, 2)); else { for (const r of rep.rows) log(line(r)); }
      if (o['write-list']) log(`LIST written=${writeList(root, rep, path.resolve(o['write-list']))} file=${path.resolve(o['write-list'])} (unconfirmed: the owner sets confirmedBy)`);
      if (!o.json) log(`RESULT exit=0 shown=${rep.rows.length} project=${rep.total} olderThanHours=${rep.olderThanHours}`);
      return 0;
    }
    if (o.pid !== undefined && o.list !== undefined) { log('usage error: --pid or --list, not both'); return 2; }
    if (o.pid !== undefined) { const r = stopRegistered(root, Number(o.pid), {}, deps); log(r.line); return r.ok ? 0 : 3; }
    if (o.list !== undefined) { const r = stopListed(root, path.resolve(o.list), {}, deps); for (const l of r.lines) log(l); return 0; }
    log('usage error: stop needs --pid N or --list FILE');
    return 2;
  } catch (e) {
    log(`REFUSED ${e.message}`);
    return e.code === 'USAGE' ? 2 : 3;
  }
}

module.exports = { processTable, classOf, shownCommand, registered, identityFits, report, stopRegistered, stopListed, readList, writeList, main, LIST_SCHEMA };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

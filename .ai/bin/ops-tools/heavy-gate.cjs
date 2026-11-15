'use strict';
// Heavy-run gate (PROTO-DEC-0249 items 2 and 3, process rows P-153 and P-154): the environment check and the slot of a heavy run.
//   node .ai/bin/ops-tools/heavy-gate.cjs [--tree DIR] [--wait-minutes N] [--cap N] [--train] [--defender warn] [-- COMMAND ARGS...]
// 1. Environment facts: the node running this file is the documented runtime; Defender behavior monitoring is off (Windows);
//    free memory is at least the configured minimum; no other heavy run is live on the same tree. A failed fact prints
//    HEAVY-GATE REFUSED fact=NAME and exits 3, before any wait.
// 2. Slot: waits, polling, until fewer than the cap heavy runs are live on the machine, then prints HEAVY-GATE OK. A heavy run is
//    a protocol-test internal runner or a direct node --test of the product-real or the product-build test file.
//    A waiting train holds a flag file, so a free slot goes to it first; other callers take a ticket and a free slot goes to the
//    oldest live tickets.
// With a command after "--" the gate starts it after the OK, with the same node when the command is "node", and exits with its
// status: that is the way a seat runs a product test, so the slot is counted for the whole run. The gate's own process is never
// counted as a heavy run, so a waiting gate does not block another one.
// The slot is advisory between callers that start in the same poll interval; the next poll corrects an overshoot of one.
//
// The tree of a run reaches the gate as one
// resolved root from --tree, PROTOCOL_HEAVY_TREE or the cwd (that order); the service spawns of the tree carry no
// worktree path in their argv, so the identity of a live heavy run is attributed by the pointer registry first
// (run-<pid>.json {schema, tree, started, kind} under the work root, published atomically by the writer that owns
// the run: protocol-test's internal runner for itself, the gate for its "--" child), by the legacy command-line
// match as the fallback for old-style runs, and a live heavy line that neither can name is an unknown identity and
// refuses (fail-closed, PROTO-DEC-0249 item 3). The pointer's started field is verified against the process start
// time, so a reused pid never reads as its predecessor.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { load } = require('./lib/config.cjs');

const RUNNER = /protocol-test\.cjs["']?\s+--protocol-internal-runner/;
const PRODUCT = /\s--test\s+["']?(.*?[\\/])?tests[\\/]product-(?:build|real(?:-(?:installability|preservation|runtime|policy|hosts|closure|install-load|template|gatef-(?:installer|references)))?)\.test\.cjs(?=["']?(?:\s|$))/;
const SELF = /heavy-gate\.cjs/;
const TREE_KEY = 'PROTOCOL_HEAVY_TREE';
const POINTER_SCHEMA = 'heavy-run/1';

const isHeavyCommand = line => typeof line === 'string' && !SELF.test(line) && (RUNNER.test(line) || PRODUCT.test(line));
const heavyRuns = rows => (Array.isArray(rows) ? rows.filter(row => row && isHeavyCommand(row.cmd)) : null);
const forward = value => String(value).replace(/\\/g, '/').toLowerCase();
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The tree is named in a command line as a whole path: a tree named tree is not mentioned by a path of a tree named tree-two.
// A pointerless row that names no path at all cannot be attributed to any tree and refuses
// (fail-closed); a line that spells an absolute path of some worktree names another tree and is foreign.
// Only an absolute managed script identifies a legacy tree. An absolute node executable,
// log path or unrelated argument cannot establish the cwd of a relative runner.
function legacyTree(line) {
  // Closed legacy spawn forms: node SCRIPT --protocol-internal-runner, or
  // node --test SCRIPT. Later arguments (logs, fixtures) never identify the run.
  const argv = [...String(line).matchAll(/"([^"]*)"|'([^']*)'|([^\s"']+)/g)].map(m => m[1] ?? m[2] ?? m[3]);
  const product = argv[1] === '--test';
  const script = product ? argv[2] : argv[2] === '--protocol-internal-runner' ? argv[1] : null;
  if (!script) return null;
  const normalized = script.replace(/\\/g, '/');
  if (!/^(?:[A-Za-z]:\/|\/)/.test(normalized)) return null;
  const suffix = product ? /\/tests\/product-(?:build|real(?:-(?:installability|preservation|runtime|policy|hosts|closure|install-load|template|gatef-(?:installer|references)))?)\.test\.cjs$/ : /\/\.ai\/bin\/protocol-test\.cjs$/;
  const match = suffix.exec(normalized);
  if (!match) return null;
  const root = normalized.slice(0, match.index);
  return process.platform === 'win32' ? root.replace(/^\/([A-Za-z])\//, '$1:/') : root;
}
const mentionsTree = (line, tree) => new RegExp(`${escape(forward(tree).replace(/\/+$/, ''))}(?![A-Za-z0-9._-])`).test(forward(line));
// Two tree spellings are the same directory for the gate: resolved and folded, so the case of a Windows path never
// splits one tree in two.
const canonicalTree = value => { let p = path.resolve(value); try { p = fs.realpathSync.native(p); } catch { /* legacy absent tree */ } return process.platform === 'win32' ? forward(p) : p; };
const sameTree = (a, b) => a && b && canonicalTree(a) === canonicalTree(b);
const isPlain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const pointerPath = (dir, pid) => path.join(dir, `run-${pid}.json`);

// One pointer of the run registry: absent, bad (unreadable, unparsable or a broken schema) or ok.
function readPointer(dir, pid, files = fs) {
  let text;
  try { text = files.readFileSync(pointerPath(dir, pid), 'utf8'); }
  catch (error) { return error && error.code === 'ENOENT' ? { state: 'absent' } : { state: 'bad', reason: 'unreadable' }; }
  let value;
  try { value = JSON.parse(text); } catch { return { state: 'bad', reason: 'unparsable' }; }
  if (!isPlain(value) || value.schema !== POINTER_SCHEMA || typeof value.tree !== 'string' ||
    !path.isAbsolute(value.tree) || !Number.isSafeInteger(value.started) || value.started <= 0 ||
    typeof value.kind !== 'string' || !value.kind) return { state: 'bad', reason: 'schema' };
  return { state: 'ok', tree: value.tree, started: value.started, kind: value.kind };
}

// Atomic publish: the temp file is written in the same directory and renamed over any older pointer of
// the same pid (a leaked pointer of a reused pid is replaced, never appended to).
function writePointer(dir, pid, value, files = fs) {
  const file = pointerPath(dir, pid);
  const temp = `${file}.${process.pid}.tmp`;
  files.mkdirSync(dir, { recursive: true });
  files.writeFileSync(temp, `${JSON.stringify({ schema: POINTER_SCHEMA, ...value })}\n`);
  files.renameSync(temp, file);
  return file;
}

// Pure decision over the measured facts. defender is 'on', 'off', 'unreadable' or 'not-applicable'.
// processes is null or the live rows {pid, start, cmd}; pointers maps a row pid to its registry state. A
// pointer of a pid with no live row is never consulted: a stale pointer of a dead pid is ignored.
function environmentFacts(input) {
  const refused = [];
  const warnings = [];
  if (!versionOk(input.version, input.nodeVersion)) refused.push(`node=${input.version} (want v${input.nodeVersion}.x; run with the documented Node runtime)`);
  if (input.defender === 'unreadable') refused.push('defender=unreadable');
  else if (input.defender === 'on') {
    const fact = 'defender-behavior-monitoring=on (owner: group policy "Turn on behavior monitoring" = Disabled, or Set-MpPreference -DisableBehaviorMonitoring $true as administrator)';
    if (input.defenderMode === 'warn') warnings.push(fact); else refused.push(fact);
  }
  if (!(input.freeGb >= input.minFreeGb)) refused.push(`free-memory=${Number(input.freeGb).toFixed(1)}GB (want at least ${input.minFreeGb})`);
  if (input.processes === null) refused.push('process-list=unreadable');
  else if (input.tree) for (const fact of attribute({ runs: heavyRuns(input.processes), pointers: input.pointers, tree: input.tree })) refused.push(fact);
  return { refused, warnings };
}

// The identity of every live heavy run. A pointer that can be read but not trusted refuses: an
// unreadable pointer is never masked by the legacy fallback. A trusted pointer that names another
// tree settles the row, and its argv is never re-read: a foreign run that merely mentions our tree
// in its own arguments stays foreign.
function attribute({ runs, pointers, tree }) {
  const refused = [];
  for (const row of runs || []) {
    const pointer = (pointers && pointers.get(row.pid)) || { state: 'absent' };
    if (pointer.state === 'bad') { refused.push(`run-registry=pid ${row.pid} ${pointer.reason}`); continue; }
    if (pointer.state === 'ok') {
      if (!Number.isSafeInteger(row.start) || row.start <= 0) { refused.push(`run-registry=pid ${row.pid} start-unverified`); continue; }
      if (row.start !== pointer.started) { refused.push(`unknown-heavy-run=pid ${row.pid} reused-start`); continue; }
      if (sameTree(pointer.tree, tree)) refused.push(`same-tree-run-live=${tree}`);
      continue;
    }
    const legacy = legacyTree(row.cmd);
    if (mentionsTree(row.cmd, tree) || sameTree(legacy, tree)) refused.push(`same-tree-run-live=${tree}`);
    else if (!legacy) refused.push(`unknown-heavy-run=pid ${row.pid}`);
  }
  return refused;
}

// A free slot goes to the train first; a non-train caller takes it only when no train waits and fewer tickets are ahead of it
// than there are free slots.
function slotFree({ running, cap, isTrain, trainWaiting, ahead }) {
  if (!(running < cap)) return false;
  return isTrain || (!trainWaiting && ahead < cap - running);
}

function powershell(script, spawn) {
  const prelude = "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); $ErrorActionPreference = 'Stop'; ";
  const r = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', prelude + script], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return r.status === 0 ? String(r.stdout || '').trim() : null;
}
// One JSON row preserves embedded line breaks, tabs and Unicode in command lines.
// A row without a usable start is kept (fail-closed), never silently dropped.
function rowOf(line) {
  let row;
  try { row = JSON.parse(line); } catch { return null; }
  if (!isPlain(row) || !Number.isSafeInteger(row.pid) || row.pid <= 0 || typeof row.cmd !== 'string' || !row.cmd.trim()) return null;
  return { pid: row.pid, start: Number.isSafeInteger(row.start) && row.start > 0 ? row.start : null, cmd: row.cmd };
}
function systemProbes(spawn = spawnSync, platform = process.platform) {
  const win = platform === 'win32';
  return {
    creationTime(pid) {
      if (!Number.isSafeInteger(pid) || pid <= 0) return null;
      if (win) {
        const out = powershell(`[DateTimeOffset]::new((Get-Process -Id ${pid} -ErrorAction Stop).StartTime).ToUnixTimeMilliseconds()`, spawn);
        const value = out === null ? NaN : Number(out);
        return Number.isFinite(value) && value > 0 ? Math.trunc(value) : null;
      }
      const r = spawn('ps', ['-p', String(pid), '-o', 'lstart='], { encoding: 'utf8', timeout: 120000, env: { ...process.env, LC_ALL: 'C' } });
      const value = r.status === 0 ? Date.parse(String(r.stdout || '').trim()) : NaN;
      return Number.isFinite(value) && value > 0 ? value : null;
    },
    defender() {
      if (!win) return 'not-applicable';
      const out = powershell('(Get-MpComputerStatus).BehaviorMonitorEnabled', spawn);
      return out === null ? 'unreadable' : /^true$/i.test(out) ? 'on' : 'off';
    },
    processes() {
      if (win) {
        const out = powershell("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { @{pid=[long]$_.ProcessId;start=[DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds();cmd=[string]$_.CommandLine} | ConvertTo-Json -Compress }", spawn);
        if (out === null) return null;
        const rows = out.split(/\r?\n/).filter(Boolean).map(rowOf);
        return rows.some(row => !row) ? null : rows;
      }
      const r = spawn('ps', ['-eo', 'pid=,lstart=,args='], { encoding: 'utf8', timeout: 120000, env: { ...process.env, LC_ALL: 'C' } });
      if (r.status !== 0) return null;
      const parsed = String(r.stdout || '').split(/\r?\n/).filter(Boolean).map(line => {
        const m = /^\s*(\d+)\s+([A-Za-z]{3}\s+[A-Za-z]{3}\s+\d+\s+[\d:]{8}\s+\d{4})\s+(.*)$/.exec(line);
        if (!m) return null;
        const pid = Number(m[1]);
        if (!Number.isSafeInteger(pid) || pid <= 0) return null;
        const at = Date.parse(m[2]);
        return { pid, start: Number.isNaN(at) ? null : at, cmd: m[3] };
      });
      return parsed.some(row => row === null) ? null : parsed;
    },
    freeGb: () => os.freemem() / 1024 ** 3,
  };
}

function ticketsAhead({ queueDir, ticket, alive, fs: files = fs }) {
  let names;
  try { names = files.readdirSync(queueDir).sort(); } catch { return 0; }
  let ahead = 0;
  for (const name of names) {
    if (name === ticket) break;
    const pid = Number(name.split('-')[1]);
    if (!Number.isSafeInteger(pid) || !alive(pid)) { try { files.unlinkSync(path.join(queueDir, name)); } catch { /* already gone */ } continue; }
    ahead++;
  }
  return ahead;
}
const aliveProcess = pid => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

async function acquire(options) {
  const cfg = options.cfg;
  const heavy = cfg.heavy;
  const files = options.fs || fs;
  const probes = options.probes || systemProbes();
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const alive = options.alive || aliveProcess;
  const pid = options.pid || process.pid;
  const lines = [];
  const say = line => { lines.push(line); if (options.say) options.say(line); };
  const tree = options.tree ? path.resolve(options.tree) : null;
  const cap = options.cap || heavy.cap;
  const waitMs = (options.waitMinutes || heavy.waitMinutes) * 60000;

  // The identity facts are read once, before any wait: pointers exist for the row pids only, so a
  // stale pointer of a dead pid is never consulted.
  const processes = probes.processes();
  const runs = processes === null ? null : heavyRuns(processes);
  const pointers = new Map((runs || []).map(row => [row.pid, readPointer(heavy.runsDir, row.pid, files)]));
  const defender = probes.defender();
  const facts = environmentFacts({
    version: options.version || process.version, nodeVersion: heavy.nodeVersion, defender, defenderMode: options.defender,
    freeGb: probes.freeGb(), minFreeGb: heavy.minFreeGb, processes, tree, pointers,
  });
  for (const warning of facts.warnings) say(`HEAVY-GATE WARN fact=${warning}`);
  if (facts.refused.length) {
    for (const fact of facts.refused) say(`HEAVY-GATE REFUSED fact=${fact}`);
    return { ok: false, code: 3, lines, refused: facts.refused };
  }
  // The measured machine facts, one closed line the author check copies into its receipt (it reads this line and nothing else).
  // Said only once the environment is accepted, so a refusal stays the first line of a refused gate.
  say(`HEAVY-GATE FACTS node=${options.version || process.version} defender=${defender}`);

  const ticket = `${String(now()).padStart(15, '0')}-${pid}`;
  const ticketFile = path.join(heavy.queueDir, ticket);
  const dropTicket = () => { try { files.unlinkSync(ticketFile); } catch { /* none */ } };
  const trainWaiting = () => { try { return now() - files.statSync(heavy.trainFlag).mtimeMs < heavy.trainFlagMs; } catch { return false; } };
  const dropFlag = () => { try { files.unlinkSync(heavy.trainFlag); } catch { /* none */ } };
  if (!options.train) { try { files.mkdirSync(heavy.queueDir, { recursive: true }); files.writeFileSync(ticketFile, `${tree || ''}\n`); } catch { /* the queue is advisory */ } }
  const deadline = now() + waitMs;
  try {
    for (;;) {
      const live = probes.processes();
      if (live === null) { say('HEAVY-GATE REFUSED fact=process-list=unreadable'); return { ok: false, code: 3, lines }; }
      const livePointers = new Map(heavyRuns(live).map(row => [row.pid, readPointer(heavy.runsDir, row.pid, files)]));
      const identityRefusals = attribute({ runs: heavyRuns(live), pointers: livePointers, tree });
      if (identityRefusals.length) {
        for (const fact of identityRefusals) say(`HEAVY-GATE REFUSED fact=${fact}`);
        return { ok: false, code: 3, lines, refused: identityRefusals };
      }
      const running = live ? heavyRuns(live).length : cap;
      if (options.train) { try { files.mkdirSync(path.dirname(heavy.trainFlag), { recursive: true }); files.writeFileSync(heavy.trainFlag, `${pid} ${tree || ''}\n`); } catch { /* the flag is advisory */ } }
      const ahead = options.train ? 0 : ticketsAhead({ queueDir: heavy.queueDir, ticket, alive, fs: files });
      if (slotFree({ running, cap, isTrain: Boolean(options.train), trainWaiting: options.train ? false : trainWaiting(), ahead })) {
        say(`HEAVY-GATE OK heavy-runs=${running} cap=${cap} free-memory=${probes.freeGb().toFixed(1)}GB node=${options.version || process.version}`);
        return { ok: true, code: 0, lines };
      }
      if (now() > deadline) {
        say(`HEAVY-GATE REFUSED fact=no-slot heavy-runs=${running} cap=${cap} after ${options.waitMinutes || heavy.waitMinutes} min`);
        return { ok: false, code: 3, lines };
      }
      say(`HEAVY-GATE waiting heavy-runs=${running} cap=${cap}`);
      await sleep(heavy.pollMs);
    }
  } finally {
    // The ticket goes at once: a gate that started its command is a live heavy run and counts as one, not as a ticket ahead.
    dropTicket();
    if (options.train) dropFlag();
  }
}

// One name for the tree, one resolved root: --tree beats PROTOCOL_HEAVY_TREE, the env beats the cwd.
// The chosen source is validated: an empty or whitespace value of a chosen source is a usage error,
// never a silent cwd fallback, and a chosen empty env never breaks a CLI override. A relative value
// resolves against the gate's cwd. The key is read case-insensitively (a Windows child may spell it
// in any case).
function envTree(env) {
  for (const name of Object.keys(env || {})) if (name.toUpperCase() === TREE_KEY) return env[name];
  return undefined;
}
function resolveTree({ cli, env, cwd }) {
  let raw;
  let source;
  if (cli !== undefined) { raw = cli; source = '--tree'; }
  else {
    const value = envTree(env);
    if (value !== undefined) { raw = value; source = TREE_KEY; }
    else { raw = cwd; source = 'cwd'; }
  }
  if (typeof raw !== 'string' || raw.trim() === '') return { ok: false, source, reason: `${source} names no directory` };
  return { ok: true, source, root: path.resolve(cwd, raw) };
}

function usage() { return 'usage: heavy-gate.cjs [--tree DIR] [--wait-minutes N] [--cap N] [--train] [--defender warn] [-- COMMAND ARGS...]\nthe tree comes from --tree, PROTOCOL_HEAVY_TREE or the cwd, in that order\n'; }

async function main(argv, deps = {}) {
  const args = argv.slice();
  const split = args.indexOf('--');
  const command = split >= 0 ? args.splice(split).slice(1) : [];
  const value = name => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const flag = name => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  const treeGiven = args.includes('--tree');
  const tree = value('--tree');
  const waitValue = value('--wait-minutes') || (deps.env || process.env).HEAVY_WAIT_MINUTES;
  const capValue = value('--cap');
  const defender = value('--defender');
  const train = flag('--train');
  if (treeGiven && tree === undefined) { process.stderr.write(usage()); return 2; }
  if (args.length || (split >= 0 && !command.length) || (defender !== undefined && defender !== 'warn')) { process.stderr.write(usage()); return 2; }
  const number = (text, what) => {
    if (text === undefined) return undefined;
    const n = Number(text);
    if (!Number.isSafeInteger(n) || n <= 0) { process.stderr.write(`heavy-gate: ${what} must be a positive integer\n`); return null; }
    return n;
  };
  const waitMinutes = number(waitValue, '--wait-minutes');
  const cap = number(capValue, '--cap');
  if (waitMinutes === null || cap === null) return 2;
  const env = deps.env || process.env;
  const chosen = resolveTree({ cli: tree, env, cwd: deps.cwd || process.cwd() });
  if (!chosen.ok) { process.stderr.write(`heavy-gate: ${chosen.reason}\n` + usage()); return 2; }
  if (!deps.cfg && !fs.statSync(chosen.root, { throwIfNoEntry: false })?.isDirectory()) { process.stderr.write(`heavy-gate: ${chosen.source} names no directory: ${chosen.root}\n`); return 2; }
  // One resolved root feeds the configuration and the slot alike.
  let cfg;
  try { cfg = deps.cfg || (deps.load || load)({ root: chosen.root, env }); }
  catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  const result = await (deps.runAcquire || acquire)({ cfg, tree: chosen.root, waitMinutes, cap, train, defender, say: line => process.stdout.write(`${line}\n`), ...deps.acquire });
  if (!result.ok) return result.code;
  if (!command.length) return 0;
  // The managed child: its cwd is the resolved tree, its env never carries the tree key, and a
  // pointer in the run registry names it, so its process line needs no worktree path. The command
  // itself is arbitrary: its arguments are never rewritten.
  const exe = command[0] === 'node' ? process.execPath : command[0];
  const files = deps.fs || fs;
  const childEnv = { ...env };
  for (const key of Object.keys(childEnv)) if (key.toUpperCase() === TREE_KEY) delete childEnv[key];
  const child = (deps.spawnChild || spawn)(exe, command.slice(1), { cwd: chosen.root, env: childEnv, stdio: 'inherit', windowsHide: true });
  // Subscribe before the synchronous creation-time probe: close/error may already be queued.
  const ended = new Promise(resolve => {
    child.on('error', error => { process.stderr.write(`heavy-gate: cannot start ${command[0]} (${error.code || 'spawn error'})\n`); resolve(2); });
    child.on('close', (code, signal) => resolve(signal ? 1 : (code === null || code === undefined ? 1 : code)));
  });
  if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return ended;
  let pointer;
  try {
    const started = (deps.creationTime || systemProbes().creationTime)(child.pid);
    if (!Number.isSafeInteger(started) || started <= 0) throw new Error('process start is unverified');
    pointer = writePointer(cfg.heavy.runsDir, child.pid, { tree: chosen.root, started, kind: 'gate-child' }, files);
  }
  catch (error) {
    child.kill();
    process.stderr.write(`heavy-gate: cannot register the run (${error.code || error.message}); the command was stopped\n`);
    await ended;
    return 2;
  }
  const status = await ended;
  try { files.unlinkSync(pointer); } catch { /* leaked: the pid is dead, the pointer is stale and ignored */ }
  return status;
}

function versionOk(version, prefix) {
  const want = `v${prefix}`;
  return version === want || String(version).startsWith(`${want}.`);
}

module.exports = { isHeavyCommand, heavyRuns, mentionsTree, sameTree, environmentFacts, attribute, readPointer, writePointer, pointerPath, resolveTree, envTree, slotFree, ticketsAhead, systemProbes, acquire, main, TREE_KEY, POINTER_SCHEMA };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${e.message}\n`); process.exitCode = 2; });

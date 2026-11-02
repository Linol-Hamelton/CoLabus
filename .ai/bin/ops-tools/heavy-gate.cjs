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
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { load } = require('./lib/config.cjs');

const RUNNER = /protocol-test\.cjs\s+--protocol-internal-runner/;
const PRODUCT = /\s--test\s+(\S*[\\/])?tests[\\/]product-(real|build)\.test\.cjs/;
const SELF = /heavy-gate\.cjs/;

const isHeavyCommand = line => typeof line === 'string' && !SELF.test(line) && (RUNNER.test(line) || PRODUCT.test(line));
const heavyRuns = lines => (Array.isArray(lines) ? lines.filter(isHeavyCommand) : null);
const forward = value => String(value).replace(/\\/g, '/').toLowerCase();
const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// The tree is named in a command line as a whole path: a tree named tree is not mentioned by a path of a tree named tree-two.
const mentionsTree = (line, tree) => new RegExp(`${escape(forward(tree).replace(/\/+$/, ''))}(?![A-Za-z0-9._-])`).test(forward(line));

function versionOk(version, prefix) {
  const want = `v${prefix}`;
  return version === want || String(version).startsWith(`${want}.`);
}

// Pure decision over the measured facts. defender is 'on', 'off', 'unreadable' or 'not-applicable'.
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
  else if (input.tree && heavyRuns(input.processes).some(line => mentionsTree(line, input.tree))) refused.push(`same-tree-run-live=${input.tree}`);
  return { refused, warnings };
}

// A free slot goes to the train first; a non-train caller takes it only when no train waits and fewer tickets are ahead of it
// than there are free slots.
function slotFree({ running, cap, isTrain, trainWaiting, ahead }) {
  if (!(running < cap)) return false;
  return isTrain || (!trainWaiting && ahead < cap - running);
}

function powershell(script, spawn) {
  const r = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 120000 });
  return r.status === 0 ? String(r.stdout || '').trim() : null;
}
function systemProbes(spawn = spawnSync, platform = process.platform) {
  const win = platform === 'win32';
  return {
    defender() {
      if (!win) return 'not-applicable';
      const out = powershell('(Get-MpComputerStatus).BehaviorMonitorEnabled', spawn);
      return out === null ? 'unreadable' : /^true$/i.test(out) ? 'on' : 'off';
    },
    processes() {
      if (win) {
        const out = powershell("Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.CommandLine }", spawn);
        return out === null ? null : out.split(/\r?\n/).filter(Boolean);
      }
      const r = spawn('ps', ['-eo', 'args='], { encoding: 'utf8', timeout: 120000 });
      return r.status === 0 ? String(r.stdout || '').split(/\r?\n/).filter(Boolean) : null;
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

  const facts = environmentFacts({
    version: options.version || process.version, nodeVersion: heavy.nodeVersion, defender: probes.defender(), defenderMode: options.defender,
    freeGb: probes.freeGb(), minFreeGb: heavy.minFreeGb, processes: probes.processes(), tree,
  });
  for (const warning of facts.warnings) say(`HEAVY-GATE WARN fact=${warning}`);
  if (facts.refused.length) {
    for (const fact of facts.refused) say(`HEAVY-GATE REFUSED fact=${fact}`);
    return { ok: false, code: 3, lines, refused: facts.refused };
  }

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

function usage() { return 'usage: heavy-gate.cjs [--tree DIR] [--wait-minutes N] [--cap N] [--train] [--defender warn] [-- COMMAND ARGS...]\n'; }

async function main(argv, deps = {}) {
  const args = argv.slice();
  const split = args.indexOf('--');
  const command = split >= 0 ? args.splice(split).slice(1) : [];
  const value = name => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const flag = name => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };
  const tree = value('--tree');
  const waitValue = value('--wait-minutes') || (deps.env || process.env).HEAVY_WAIT_MINUTES;
  const capValue = value('--cap');
  const defender = value('--defender');
  const train = flag('--train');
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
  let cfg;
  try { cfg = deps.cfg || load({ root: path.resolve(tree || process.cwd()), env: deps.env || process.env }); }
  catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  const result = await acquire({ cfg, tree: tree || process.cwd(), waitMinutes, cap, train, defender, say: line => process.stdout.write(`${line}\n`), ...deps.acquire });
  if (!result.ok) return result.code;
  if (!command.length) return 0;
  const exe = command[0] === 'node' ? process.execPath : command[0];
  const r = (deps.spawn || spawnSync)(exe, command.slice(1), { stdio: 'inherit', windowsHide: true });
  if (r.error) { process.stderr.write(`heavy-gate: cannot start ${command[0]} (${r.error.code || 'spawn error'})\n`); return 2; }
  return r.status === null || r.status === undefined ? 1 : r.status;
}

module.exports = { isHeavyCommand, heavyRuns, mentionsTree, environmentFacts, slotFree, ticketsAhead, systemProbes, acquire, main };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${e.message}\n`); process.exitCode = 2; });

'use strict';
// wait-slot: block until fewer than the total cap of the policy run and the named client is
// below its cap. This is the old shell entry point without a shell: the same seat-count
// engine runs in this process.
//   node .ai/bin/ops-tools/wait-slot.cjs [--client CLIENT] [--cap N] [--runtime DIR] [--policy FILE]
// Exit: 0 a slot is free, 3 timed out or the cap is closed, 2 usage or configuration error.
const { load, loadSeatCaps, loadSeatPolicy } = require('./lib/config.cjs');
const seatCount = require('./seat-count.cjs');

async function main(argv) {
  const args = argv.slice();
  const value = name => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const client = value('--client') || process.env.SEAT_CLIENT || '';
  const provider = value('--provider');
  const model = value('--model');
  const runtime = value('--runtime');
  // --policy is the documented name of the seat policy file; --caps is the older spelling that seat-count.cjs also reads.
  const capsFile = value('--policy') || value('--caps');
  const capValue = value('--cap') || process.env.SEAT_CAP;
  if (args.length) { process.stderr.write('usage: wait-slot.cjs [--client CLIENT] [--model MODEL] [--cap N] [--runtime DIR] [--policy FILE | --caps FILE]\n'); return 2; }
  let cfg;
  let caps;
  let policy;
  try {
    cfg = load({ root: process.cwd(), env: process.env });
    caps = loadSeatCaps();
    const read = loadSeatPolicy({ file: capsFile, main: cfg.main, env: process.env });
    if (!read.ok) { process.stderr.write(`${read.code}: ${read.detail || ''}\n`); return 2; }
    policy = read.policy;
  } catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  const cap = capValue === undefined ? null : Number(capValue);
  if (cap !== null && (!Number.isFinite(cap) || cap < 0)) { process.stderr.write('wait-slot: --cap must be a non-negative number\n'); return 2; }
  const result = await seatCount.waitForSlot({
    runtimeDir: runtime || cfg.runtimeDir,
    repo: cfg.main,
    inject: seatCount.injectedRoots ? seatCount.injectedRoots(process.env) : [],
    caps,
    policy,
    client,
    provider, model, proxyConfig: cfg.proxy,
    cap: cap === undefined ? null : cap,
    defaultCap: cfg.seat.defaultCap,
    maxAgeMs: cfg.seat.maxAgeMs,
    pollMs: cfg.seat.pollMs,
    timeoutMs: cfg.seat.waitTimeoutMs,
  });
  if (result.ok) {
    process.stdout.write(`SLOT free: ${result.total} running, cap ${result.totalCap === null ? '-' : result.totalCap}; client ${result.client || '-'} ${result.clientCount}/${result.clientCap === null ? '-' : result.clientCap}\n`);
    return 0;
  }
  // A closed cap and an expired cap are refusals, not timeouts: nothing was started.
  if (result.reason) {
    process.stdout.write(`SLOT REFUSED reason=${result.reason} client ${client || '-'} cap ${result.clientCap === null ? '-' : result.clientCap}; nothing was started\n`);
    return 3;
  }
  process.stdout.write(`SLOT TIMEOUT: ${result.total} running, cap ${result.totalCap === null ? '-' : result.totalCap}\n`);
  return 3;
}

module.exports = { main };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${e.message}\n`); process.exitCode = 2; });

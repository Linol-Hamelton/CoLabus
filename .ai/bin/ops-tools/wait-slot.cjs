'use strict';
// wait-slot: block until fewer than SEAT_CAP (default from the config, 18) seats run and the
// named client is below its data cap. This is the old shell entry point without a shell: the
// same seat-count engine runs in this process.
//   node .ai/bin/ops-tools/wait-slot.cjs [--client CLIENT] [--cap N] [--runtime DIR]
// Exit: 0 a slot is free, 3 timed out, 2 usage or configuration error.
const { load, loadSeatCaps } = require('./lib/config.cjs');
const seatCount = require('./seat-count.cjs');

async function main(argv) {
  const args = argv.slice();
  const value = name => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const client = value('--client') || process.env.SEAT_CLIENT || '';
  const runtime = value('--runtime');
  const capsFile = value('--caps');
  const capValue = value('--cap') || process.env.SEAT_CAP;
  if (args.length) { process.stderr.write('usage: wait-slot.cjs [--client CLIENT] [--cap N] [--runtime DIR]\n'); return 2; }
  let cfg;
  let caps;
  try { cfg = load({ root: process.cwd(), env: process.env }); caps = loadSeatCaps({ file: capsFile }); }
  catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  const cap = capValue === undefined ? cfg.seat.defaultCap : Number(capValue);
  if (!Number.isFinite(cap) || cap < 0) { process.stderr.write('wait-slot: --cap must be a non-negative number\n'); return 2; }
  const result = await seatCount.waitForSlot({
    runtimeDir: runtime || cfg.runtimeDir,
    caps,
    client,
    cap,
    maxAgeMs: cfg.seat.maxAgeMs,
    endMarker: cfg.seat.endMarker,
    pollMs: cfg.seat.pollMs,
    timeoutMs: cfg.seat.waitTimeoutMs,
  });
  if (result.ok) {
    process.stdout.write(`SLOT free: ${result.total} running, cap ${result.cap}; client ${result.client || '-'} ${result.clientCount}/${result.clientCap === Infinity ? '-' : result.clientCap}\n`);
    return 0;
  }
  process.stdout.write(`SLOT TIMEOUT: ${result.total} running, cap ${result.cap}\n`);
  return 3;
}

module.exports = { main };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${e.message}\n`); process.exitCode = 2; });

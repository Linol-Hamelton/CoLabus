'use strict';
// Verify that a launched seat really runs. For each name: wait until its running marker is
// newer than this call, a named refusal appears in its launch output, or the timeout ends.
// Reads only; never starts or stops anything.
//   node .ai/bin/ops-tools/seat-verify.cjs NAME [NAME ...] [--timeout SEC] [--runtime DIR]
// One line per seat: VERIFY-OK | VERIFY-REFUSED class: line | VERIFY-DEAD class | VERIFY-TIMEOUT.
// Exit 0 only when every seat is OK.
const fs = require('node:fs');
const path = require('node:path');
const { load } = require('./lib/config.cjs');
const { terminalState } = require('./seat-count.cjs');
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}(?![\s\S])/;

const REFUSAL = /^(LAUNCH REFUSED.*|PROBLEM .*|SEAT-FAILOVER REFUSED.*|ROUTE-GATE REFUSED.*|FA-CERT_ROUTE_REFUSED.*)$/m;

function classify(text, call) {
  if (text.includes('no live claim')) return 'NO-CLAIM';
  if (text.includes('PIN_HTML_REFUSED')) return 'HTML-IN-TASK';
  if (text.includes('invalid-route-or-family') || (text.toLowerCase().includes('independence') && text.toLowerCase().includes('refus'))) return 'INDEPENDENCE';
  if (text.includes('PREFLIGHT_FAIL') || String(call).includes('PREFLIGHT_FAIL')) return 'PREFLIGHT-HEAD';
  if (/at capacity|Eligibility check failed|EOF|ECONNRESET|ETIMEDOUT|ENOTFOUND|429|quota|exhausted/i.test(`${call || ''}${text || ''}`)) return 'PROVIDER';
  return 'GATE';
}
const read = (io, file) => { try { return io.readFileSync(file, 'utf8'); } catch { return ''; } };
const stamp = (io, file) => { try { return io.statSync(file).mtimeMs; } catch { return null; } };

async function verifySeat(options) {
  const runtimeDir = path.resolve(options.runtimeDir || '.');
  const name = options.name;
  if (typeof name !== 'string' || !SAFE_SEGMENT.test(name)) throw new Error('SEAT-VERIFY-NAME: one safe seat segment is required');
  const timeoutMs = options.timeoutMs === undefined ? 180000 : options.timeoutMs;
  const pollMs = options.pollMs === undefined ? 5000 : options.pollMs;
  const now = options.now || (() => Date.now());
  const sleep = options.sleep || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const io = options.io || fs;
  const kill = options.kill || process.kill;
  const started = options.startedMs === undefined ? now() - 60000 : options.startedMs;
  const out = path.join(runtimeDir, `${name}.launch.out`);
  const running = path.join(runtimeDir, `${name}.running.json`);
  const terminal = path.join(runtimeDir, `${name}.terminal.json`);
  const call = path.join(runtimeDir, `${name}-call.txt`);
  const end = now() + timeoutMs;
  while (now() < end) {
    const text = read(io, out);
    const runningAt = stamp(io, running);
    if (runningAt !== null && runningAt >= started - 5000) {
      let marker;
      try { marker = JSON.parse(io.readFileSync(running, 'utf8')); }
      catch { marker = null; }
      if (!Number.isSafeInteger(marker && marker.wrapperPid) || marker.wrapperPid <= 0) {
        return { ok: false, status: 'REFUSED', line: `VERIFY-REFUSED ${name} GATE: unreadable wrapper pid` };
      }
      if (options.wrapperPid !== undefined && marker.wrapperPid !== options.wrapperPid) {
        await sleep(pollMs);
        continue;
      }
      let record;
      try { record = JSON.parse(read(io, terminal)); } catch { /* no readable terminal */ }
      const state = terminalState(marker, record);
      if (state.ended) {
        const failure = state.terminal && state.terminal.failureClass;
        const kind = failure || classify(text, read(io, call));
        return { ok: false, status: 'DEAD', line: `VERIFY-DEAD ${name} ${kind}: ended inside the window` };
      }
      try { kill(marker.wrapperPid, 0); }
      catch (e) {
        if (e && e.code === 'ESRCH') return { ok: false, status: 'DEAD', line: `VERIFY-DEAD ${name} GATE: wrapper process is gone` };
        return { ok: false, status: 'REFUSED', line: `VERIFY-REFUSED ${name} GATE: wrapper liveness is unknown` };
      }
      return { ok: true, status: 'OK', line: `VERIFY-OK ${name}` };
    }
    const refusal = REFUSAL.exec(text);
    const outputAt = stamp(io, out);
    if (refusal && outputAt !== null && outputAt >= started - 5000) {
      return { ok: false, status: 'REFUSED', line: `VERIFY-REFUSED ${name} ${classify(text, read(io, call))}: ${refusal[1].slice(0, 140)}` };
    }
    await sleep(pollMs);
  }
  return { ok: false, status: 'TIMEOUT', line: `VERIFY-TIMEOUT ${name}: no running marker after ${Math.round(timeoutMs / 1000)} s` };
}

async function main(argv) {
  const args = argv.slice();
  const value = name => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const timeout = value('--timeout');
  const runtime = value('--runtime');
  const names = args.filter(arg => !arg.startsWith('--'));
  if (!names.length || names.length !== args.length) { process.stderr.write('usage: seat-verify.cjs NAME [NAME ...] [--timeout SEC] [--runtime DIR]\n'); return 2; }
  let cfg;
  try { cfg = load({ root: process.cwd() }); } catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  const timeoutMs = timeout === undefined ? cfg.seat.verifyTimeoutMs : Number(timeout) * 1000;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) { process.stderr.write('seat-verify: --timeout must be a non-negative number of seconds\n'); return 2; }
  const started = Date.now() - 60000;
  let bad = 0;
  for (const name of names) {
    const result = await verifySeat({ name, startedMs: started, timeoutMs, pollMs: cfg.seat.verifyPollMs, runtimeDir: runtime || cfg.runtimeDir });
    process.stdout.write(`${result.line}\n`);
    if (!result.ok) bad++;
  }
  return bad ? 1 : 0;
}

module.exports = { REFUSAL, classify, verifySeat, main };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${e.message}\n`); process.exitCode = 2; });

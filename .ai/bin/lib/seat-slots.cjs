'use strict';
// Seat slots: how many launches of the launch wrapper are running, read from its own records in the runtime
// directory. A launch is running when <name>.running.json exists, no <name>.terminal.json is as new or newer,
// its wrapper process is alive and the record is younger than 6 hours (an older one without an end is a dead
// launch). The client of a launch is the --client its wrapper recorded (resolver.operator.client), else unknown.
// waitForSlot blocks until the total and the per-client count are below their caps, polling, and gives up after
// the wait limit: the caller takes its claim only after a slot is free, so a claim never lapses while it waits.
const fs = require('node:fs');
const path = require('node:path');

const MAX_AGE_MS = 6 * 3600 * 1000;
const aliveDefault = pid => { if (!Number.isInteger(pid) || pid <= 0) return false; try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

function runningSeats(runtime, { now = Date.now(), alive = aliveDefault, exclude = null } = {}) {
  let names;
  try { names = fs.readdirSync(runtime); } catch { return []; }
  const out = [];
  for (const f of names) {
    if (!f.endsWith('.running.json')) continue;
    const name = f.slice(0, -'.running.json'.length);
    if (name === exclude) continue;
    let st; try { st = fs.statSync(path.join(runtime, f)); } catch { continue; }
    if (now - st.mtimeMs > MAX_AGE_MS) continue;
    try { if (fs.statSync(path.join(runtime, `${name}.terminal.json`)).mtimeMs >= st.mtimeMs) continue; } catch { /* no terminal record */ }
    let rec = null; try { rec = JSON.parse(fs.readFileSync(path.join(runtime, f), 'utf8')); } catch { /* unreadable: counted, client unknown */ }
    if (rec && Number.isInteger(rec.wrapperPid) && !alive(rec.wrapperPid)) continue;
    const client = rec && rec.resolver && rec.resolver.operator && typeof rec.resolver.operator.client === 'string' ? rec.resolver.operator.client : null;
    out.push({ name, client });
  }
  return out;
}

// caps: { total: N or null, client: N or null, clientName: string or null }. -> { free, running, sameClient }
function slotState(runtime, caps, opts = {}) {
  const seats = runningSeats(runtime, opts);
  const same = caps.clientName ? seats.filter(s => s.client === caps.clientName).length : 0;
  const free = (caps.total == null || seats.length < caps.total) && (caps.client == null || !caps.clientName || same < caps.client);
  return { free, running: seats.length, sameClient: same };
}

// -> Promise { ok, waitedMs, running, sameClient }; ok false after waitMs.
async function waitForSlot(runtime, caps, { waitMs = 45 * 60 * 1000, pollMs = 20000, clock = () => Date.now(), sleep = ms => new Promise(r => setTimeout(r, ms)), onWait = null, ...opts } = {}) {
  const t0 = clock();
  for (let first = true; ; first = false) {
    const s = slotState(runtime, caps, { ...opts, now: clock() });
    if (s.free) return { ok: true, waitedMs: clock() - t0, running: s.running, sameClient: s.sameClient };
    if (clock() - t0 >= waitMs) return { ok: false, waitedMs: clock() - t0, running: s.running, sameClient: s.sameClient };
    if (first && onWait) onWait(s);
    await sleep(pollMs);
  }
}

module.exports = { MAX_AGE_MS, runningSeats, slotState, waitForSlot };

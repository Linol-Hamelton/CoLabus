'use strict';
// The seat watcher: one line per event of the seats and of the farm, each told once (the decisions are lib/seat-watch.cjs).
//   node .ai/bin/ops-tools/seat-watch.cjs scan|run [--runtime DIR] [--farm DIR] [--state DIR] [--interval SEC]
// scan is one pass, run repeats it every --interval seconds (watch.intervalSec of ops-tools.config.json, 60 by default). Read are the
// terminal records of the runtime (seats ended inside the window), the results, queue and beat folders of the farm (results by the stamp of
// their name inside the window). Events: SEAT-END, SHARD-RED, SHARD-REFUSED, RUN-END, UNCLAIMABLE, STALE-BEAT.
// One watcher at a time: the lock file seat-watch.lock of the state folder is created exclusively and names its holder by pid AND process
// creation time (lib/loop-snapshot.cjs collect, read only when the lock is disputed and once for this process); a live holder makes a
// second watcher print WATCHER-ALREADY-RUNNING and exit 0 without a write; a holder whose pid is gone or now belongs to another process
// is moved aside (seat-watch.lock.stale-TIME, never removed) and named; a lock that cannot be read yet and is younger than ten seconds
// is a watcher between its create and its write, so it counts as live.
// A folder read that meets EBUSY or EPERM is retried three times, 200 ms apart; then WATCH-READ-FAILED names it and the pass goes on
// (without RUN-END when the results or the queue could not be read).
// The handled events are a file only appended to (seat-watch-events.jsonl of the state folder): an event is written there first and printed
// after, so a crash between the two never loses the event from the file, and the display of it is not repeated. The watcher writes nothing outside its state folder, stops nothing
// and sends nothing to the owner channel.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const W = require('./lib/seat-watch.cjs');

const LOCK = 'seat-watch.lock';
const EVENTS = 'seat-watch-events.jsonl';
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const WRITE_GRACE_MS = 10000;
const tick = new Int32Array(new SharedArrayBuffer(4));
const sleepSync = ms => Atomics.wait(tick, 0, 0, ms);

function settings(o, cfg) {
  const w = cfg && cfg.config && cfg.config.watch && typeof cfg.config.watch === 'object' ? cfg.config.watch : {};
  const seg = (v, d) => (typeof v === 'string' && SEGMENT.test(v) ? v : d);
  const num = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  const interval = o.interval !== undefined ? Number(o.interval) : num(w.intervalSec, 60);
  if (!Number.isFinite(interval) || interval < 1) throw Error('--interval needs whole seconds of at least 1');
  return {
    runtime: path.resolve(o.runtime || cfg.runtimeDir), farm: path.resolve(o.farm || path.join(cfg.workRoot, seg(w.farmDir, 'farm'))),
    state: path.resolve(o.state || path.join(cfg.workRoot, seg(w.stateDir, 'seat-watch'))), intervalMs: interval * 1000,
    staleMs: num(w.staleBeatMinutes, 15) * 60000, windowMs: num(w.windowHours, 48) * 3600e3,
  };
}

// The creation time of a process in epoch ms, or null when it cannot be read (never a guess).
function createdOf(pid, deps) {
  if (deps.created) return deps.created(pid);
  const snap = require('./lib/loop-snapshot.cjs').collect({ pids: [pid], selfPid: process.pid });
  const row = snap && snap.processes.find(p => p.pid === pid);
  return row ? row.created : null;
}
const aliveOf = deps => deps.alive || (pid => { try { process.kill(pid, 0); return true; } catch (e) { return Boolean(e && e.code === 'EPERM'); } });

// -> release function | null (a live watcher holds the lock)
function takeLock(s, deps, say) {
  const io = deps.fs || fs; const file = path.join(s.state, LOCK);
  const pid = deps.pid || process.pid;
  const created = createdOf(pid, deps);
  // without a readable creation time the holder is named by its pid alone, and the next watcher judges it live while that pid runs
  const me = { pid, created, host: os.hostname(), at: new Date((deps.now || Date.now)()).toISOString() };
  io.mkdirSync(s.state, { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      io.writeFileSync(file, `${JSON.stringify(me)}\n`, { flag: 'wx' });
      return () => { try { const h = JSON.parse(io.readFileSync(file, 'utf8')); if (h.pid === me.pid && h.created === me.created && h.at === me.at) io.unlinkSync(file); } catch { /* the lock is not ours any more */ } };
    } catch (e) { if (!e || e.code !== 'EEXIST') throw e; }
    let holder = null; let unreadable = false;
    try { holder = JSON.parse(io.readFileSync(file, 'utf8')); } catch { holder = { pid: 0 }; unreadable = true; }
    // an unreadable holder younger than WRITE_GRACE_MS is a watcher between its exclusive create and its write: live, never moved aside
    if (unreadable) {
      let age = Infinity; try { age = (deps.now || Date.now)() - io.statSync(file).mtimeMs; } catch { /* gone: the next attempt creates it */ }
      if (age < WRITE_GRACE_MS) return null;
    }
    const alive = aliveOf(deps);
    const verdict = holder && holder.created === null && Number.isSafeInteger(holder.pid) && holder.pid > 0
      ? (alive(holder.pid) ? 'live' : 'stale')
      : W.lockVerdict(holder, { alive, created: p => createdOf(p, deps) });
    if (verdict === 'live') return null;
    const aside = `${file}.stale-${(deps.now || Date.now)()}`;
    try { io.renameSync(file, aside); say(`WATCHER-LOCK-RECOVERED the holder pid=${holder && holder.pid} created=${holder && holder.created} is gone or its pid is reused; kept as ${path.basename(aside)}`); }
    catch (e) { if (!e || e.code !== 'ENOENT') throw e; }
  }
  return null;
}

// One pass: read, decide, append the new events, then print them.
function pass(s, deps, say) {
  const io = deps.fs || fs; const now = (deps.now || Date.now)();
  const sleep = deps.sleepSync || sleepSync;
  const failed = new Set();
  const read = (what, fn, fallback) => {
    try { return W.readRetry(fn, { sleep }); }
    catch (e) { failed.add(what); say(`WATCH-READ-FAILED ${what} ${String((e && e.code) || 'ERROR').replace(/[^A-Z0-9_]/g, '')}`); return fallback; }
  };
  const json = file => { try { return JSON.parse(io.readFileSync(file, 'utf8')); } catch { return null; } };
  const log = path.join(s.state, EVENTS);
  const handled = new Set(read('events', () => (io.existsSync(log) ? io.readFileSync(log, 'utf8') : ''), '').split('\n').map(l => { try { return JSON.parse(l).key; } catch { return null; } }).filter(Boolean));
  const events = [];
  const seats = read('runtime', () => io.readdirSync(s.runtime), []).filter(n => n.endsWith('.terminal.json')).map(n => {
    const file = path.join(s.runtime, n);
    let at = 0; try { at = io.statSync(file).mtimeMs; } catch { return null; }
    return now - at <= s.windowMs ? { name: n.slice(0, -'.terminal.json'.length), terminal: json(file) } : null;
  }).filter(Boolean);
  events.push(...W.seatEvents(seats));
  const from = new Date(now - s.windowMs).toISOString().replace(/[-:]/g, '').slice(0, 15);
  const results = path.join(s.farm, 'results');
  const entries = read('farm results', () => io.readdirSync(results), []).map(folder => {
    const m = /^(\d{8}T\d{6}-shard-.+)\.([A-Za-z0-9_-]{1,64})$/.exec(folder);
    if (!m || folder.slice(0, 15) < from) return null;
    const done = json(path.join(results, folder, 'done.json'));
    return { folder, id: m[1], host: m[2], done, shard: done && done.exit === 2 ? json(path.join(results, folder, 'shard.json')) : null };
  }).filter(Boolean);
  const queued = read('farm queue', () => io.readdirSync(path.join(s.farm, 'queue')), []).filter(n => /^[A-Za-z0-9][A-Za-z0-9._-]*\.json$/.test(n))
    .map(n => ({ id: n.slice(0, -5), job: json(path.join(s.farm, 'queue', n)) }));
  const beats = read('farm beats', () => io.readdirSync(path.join(s.farm, 'beat')), []).filter(n => n.endsWith('.json'))
    .map(n => { const b = json(path.join(s.farm, 'beat', n)); return { host: (b && b.host) || n.slice(0, -5), at: b && b.at }; });
  // a pass whose results or queue read failed tells no RUN-END: an empty fallback would end a run that still has a queued shard
  const runEnds = failed.has('farm results') || failed.has('farm queue') ? [] : W.runEvents(entries, queued.map(q => q.id));
  events.push(...W.shardEvents(entries), ...runEnds, ...W.queueEvents(queued, W.beatingHosts(beats, now, s.staleMs)), ...W.beatEvents(beats, now, s.staleMs));
  let told = 0;
  for (const e of events) {
    if (handled.has(e.key)) continue;
    io.appendFileSync(log, `${JSON.stringify({ key: e.key, at: new Date(now).toISOString(), line: e.line })}\n`);
    handled.add(e.key);
    say(e.line);
    told++;
  }
  return told;
}

async function main(argv, deps = {}) {
  const say = deps.say || (line => process.stdout.write(`${line}\n`));
  const cmd = argv[0];
  const o = {};
  for (let i = 1; i < argv.length; i++) {
    const k = { '--runtime': 'runtime', '--farm': 'farm', '--state': 'state', '--interval': 'interval' }[argv[i]];
    if (!k || argv[i + 1] === undefined) { say(`usage: seat-watch.cjs scan|run [--runtime DIR] [--farm DIR] [--state DIR] [--interval SEC]`); return 2; }
    o[k] = argv[++i];
  }
  if (!['scan', 'run'].includes(cmd)) { say('usage: seat-watch.cjs scan|run [--runtime DIR] [--farm DIR] [--state DIR] [--interval SEC]'); return 2; }
  let s;
  try { s = settings(o, deps.cfg || require('./lib/config.cjs').load({ root: process.cwd() })); }
  catch (e) { say(`SEAT-WATCH REFUSED: ${e.message}`); return 2; }
  const release = takeLock(s, deps, say);
  if (!release) { say(`WATCHER-ALREADY-RUNNING ${path.join(s.state, LOCK)}: another watcher holds it; nothing is written`); return 0; }
  try {
    if (cmd === 'scan') { pass(s, deps, say); return 0; }
    const sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
    for (let n = 0; deps.maxPasses === undefined || n < deps.maxPasses; n++) {
      if (n) await sleep(s.intervalMs);
      try { pass(s, deps, say); } catch (e) { say(`WATCH-PASS-FAILED ${String((e && e.code) || (e && e.message) || e).slice(0, 120)}`); }
    }
    return 0;
  } finally { release(); }
}

module.exports = { LOCK, EVENTS, settings, takeLock, pass, main };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; });

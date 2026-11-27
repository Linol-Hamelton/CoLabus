'use strict';
// The decisions of the seat watcher (.ai/bin/ops-tools/seat-watch.cjs), pure: records in, events and lock verdicts out. Nothing here
// reads, writes or waits, except readRetry, which only repeats the read it is given. Every event has a key; the watcher prints an event
// only when its key is not in its list of handled events, so one event is told once and a new attempt is a new event.
//   seat     the name and the startedAt of a terminal record: a seat restarted under the same name is a new event, never hidden by the old one
//   shard    the results folder ID.HOST with its done record: exit 1 is RED at once, exit 2 (a refused job, malformed-job among them) and
//            any word exit (cancelled, lease-expired) are REFUSED, never done; a green shard is silent
//   run      one line per run name when every shard of the run has ended and none is queued or running, keyed by the folders it sums
//   queue    a queued job pinned to a host outside its allow list, or whose allow list (less its avoided hosts) names no host that beats
//            (a beat no older than the stale limit), is UNCLAIMABLE: no worker will ever take it
//   beat     a host whose beat is older than the stale limit is STALE-BEAT (a line only; the watcher acts on nothing)
const SHARD_TAIL = /^(\d{8}T\d{6})-shard-(.+)-([1-9]\d*)of([1-9]\d*)$/;
const same = (a, b) => String(a || '').toUpperCase() === String(b || '').toUpperCase();
const clean = (v, n = 160) => String(v === undefined || v === null ? '' : v).replace(/[^\x20-\x7e]+/g, ' ').trim().slice(0, n);

// seat: [{ name, terminal }] -> [{ key, line }]
function seatEvents(seats) {
  const out = [];
  for (const { name, terminal: t } of seats) {
    if (!t || typeof t !== 'object' || typeof t.startedAt !== 'string' || !t.startedAt) continue;
    const cls = t.failureClass || (t.refusal && t.refusal.code) || '-';
    out.push({ key: `seat:${name}@${t.startedAt}`, line: `SEAT-END ${clean(name, 64)} status=${clean(t.status || 'UNKNOWN', 20)} class=${clean(cls, 40)} exit=${t.exitCode === undefined || t.exitCode === null ? 'none' : clean(t.exitCode, 12)} marker=${clean(t.completionMarker || t.marker || '-', 64)} started=${clean(t.startedAt, 30)}` });
  }
  return out;
}

// The outcome of one ended shard: green | red | refused (with its reason).
function shardOutcome(done, shard) {
  if (!done || typeof done !== 'object') return null;
  if (done.exit === 0) return { kind: 'green' };
  if (done.exit === 1) return { kind: 'red' };
  const reason = done.exit === 2 ? (shard && shard.refused) || done.error || 'refused' : `${done.exit}`;
  return { kind: 'refused', reason: clean(reason, 120) };
}
// shard: [{ folder, id, host, done, shard }] (done null while it runs) -> [{ key, line }]
function shardEvents(entries) {
  const out = [];
  for (const e of entries) {
    const o = shardOutcome(e.done, e.shard);
    if (!o || o.kind === 'green') continue;
    out.push(o.kind === 'red'
      ? { key: `shard:${e.folder}`, line: `SHARD-RED ${e.id} host=${clean(e.host, 64)}` }
      : { key: `shard:${e.folder}`, line: `SHARD-REFUSED ${e.id} host=${clean(e.host, 64)} reason=${o.reason}` });
  }
  return out;
}
// run: the newest attempt of each shard of a run; one summary when all have ended and none is queued or running
function runEvents(entries, queuedIds = []) {
  const runs = new Map();
  const add = (id, e) => {
    const m = SHARD_TAIL.exec(id); if (!m) return;
    const r = runs.get(m[2]) || { count: Number(m[4]), tails: new Map(), open: false };
    if (Number(m[4]) !== r.count) r.mixed = true;
    if (!e) { r.open = true; runs.set(m[2], r); return; }
    if (!e.done) r.open = true;
    const tail = m[3], was = r.tails.get(tail);
    if (e.done && (!was || String(e.done.at || '') > String(was.done.at || ''))) r.tails.set(tail, e);
    runs.set(m[2], r);
  };
  for (const e of entries) add(e.id, e);
  for (const id of queuedIds) add(id, null);
  const out = [];
  for (const [name, r] of runs) {
    if (r.open || r.mixed || r.tails.size !== r.count) continue;
    const ends = [...r.tails.values()];
    const n = k => ends.filter(e => shardOutcome(e.done, e.shard).kind === k).length;
    out.push({ key: `run:${name}:${ends.map(e => e.folder).sort().join(',')}`, line: `RUN-END ${name} shards=${r.count} green=${n('green')} red=${n('red')} refused=${n('refused')}` });
  }
  return out;
}
// queue: [{ id, job }] and the hosts that beat -> [{ key, line }]
function queueEvents(queued, beatingHosts) {
  const out = [];
  for (const { id, job } of queued) {
    if (!job || typeof job !== 'object') continue;
    const allow = Array.isArray(job.allowHosts) ? job.allowHosts : [];
    const avoid = Array.isArray(job.avoidHosts) ? job.avoidHosts : [];
    if (job.host && !allow.some(h => same(h, job.host))) { out.push({ key: `unclaimable:${id}`, line: `UNCLAIMABLE ${id} host=${clean(job.host, 64)} is outside its allowHosts` }); continue; }
    const usable = (job.host ? [job.host] : allow).filter(h => !avoid.some(a => same(a, h)));
    if (!usable.some(h => beatingHosts.some(b => same(b, h)))) out.push({ key: `unclaimable:${id}`, line: `UNCLAIMABLE ${id} no host of ${job.host ? 'its pin' : 'its allowHosts'} beats on the farm` });
  }
  return out;
}
// The hosts that beat: a beat no older than staleMs. A host whose beat file is stale is not a host that beats for the queue check.
function beatingHosts(beats, now, staleMs) {
  return beats.filter(b => { const t = Date.parse(b.at || ''); return Number.isFinite(t) && now - t <= staleMs; }).map(b => b.host);
}
// beat: [{ host, at }] -> [{ key, line }] for every beat older than staleMs
function beatEvents(beats, now, staleMs) {
  const out = [];
  for (const b of beats) {
    const t = Date.parse(b.at || '');
    if (!Number.isFinite(t) || now - t <= staleMs) continue;
    out.push({ key: `stale:${b.host}@${b.at}`, line: `STALE-BEAT ${clean(b.host, 64)} last=${clean(b.at, 30)} age=${Math.round((now - t) / 60000)}min` });
  }
  return out;
}

// The lock of one watcher: the holder is { pid, created } (created: the creation time of the process in epoch ms). A holder is live only
// when its pid runs AND that process was created at the time the lock names; a pid that runs with another creation time is a reused pid
// and the holder is gone. A creation time that cannot be read is never guessed: the holder stays live (one watcher too few beats two).
// -> 'free' (no holder) | 'live' | 'stale' (gone, the lock may be moved aside)
function lockVerdict(holder, { alive, created }) {
  if (!holder) return 'free';
  if (!Number.isSafeInteger(holder.pid) || holder.pid <= 0 || !Number.isSafeInteger(holder.created)) return 'stale';
  if (!alive(holder.pid)) return 'stale';
  const now = created(holder.pid);
  if (now === null || now === undefined) return 'live';
  return now === holder.created ? 'live' : 'stale';
}

// A read that may meet a transient lock of the folder (EBUSY, EPERM): retried three times, 200 ms apart; then the error goes to the caller.
function readRetry(fn, { tries = 4, waitMs = 200, sleep }) {
  for (let i = 1; ; i++) {
    try { return fn(); }
    catch (e) {
      if (!e || !['EBUSY', 'EPERM'].includes(e.code) || i >= tries) throw e;
      sleep(waitMs);
    }
  }
}

module.exports = { SHARD_TAIL, seatEvents, shardOutcome, shardEvents, runEvents, queueEvents, beatingHosts, beatEvents, lockVerdict, readRetry };

'use strict';
// OPERATOR-PULSE: bounded read-only acquisition and a pure snapshot reducer.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readReceipts } = require('./receipt.cjs');
const { parseRegistry } = require('../../lib/candidate-registry.cjs');
const { secretIn } = require('../../lib/secrets.cjs');
const protectedPaths = require('../../lib/protected-paths.cjs');
const readers = require('./pulse-read.cjs');
const measure = require('../packet-measure.cjs');
const LIMIT = 8 * 1024 * 1024;
const HEADINGS = Object.freeze(['A1 Streams', 'A2 Seats per route', 'B4 Stale packages',
  'B5 Failed seats', 'C6 Health', 'D7 Open owner questions', 'E8 Aging escalation', 'F9 Suite long pole',
  'G10 Durations']);
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const plain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const flat = value => {
  const text = secretIn(String(value ?? '')) ? '[withheld: credential shape]'
    : Array.from(String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ')).slice(0, 240).join('');
  // Data never prints as a reserved report line: a leading alarm shape is
  // marked 'data:' and the duration-comparison shape gains an inner space.
  return text.startsWith('ALARM ') ? `data: ${text}` : text.replaceAll(': today=', ': today =');
};
const fail = (code, detail) => { throw Object.assign(new Error(detail), { code }); };

// Inspect ancestors before following any link. A junction is not a permission to
// read a different tree, even when its target does not contain the protected name.
function refuseProtected(file) {
  if (typeof file === 'string' && protectedPaths.hasProtectedName(file)) fail('PULSE-REFUSED-PROTECTED-PATH', 'protected path');
}
function safePath(file, io = fs) {
  refuseProtected(file);
  if (typeof file !== 'string' || !path.isAbsolute(file) || /[\x00-\x1f]/.test(file)) fail('PULSE-INVALID-PATH', 'absolute path required');
  const resolved = path.resolve(file);
  const parts = [];
  for (let p = resolved; ; p = path.dirname(p)) { parts.unshift(p); if (p === path.dirname(p)) break; }
  for (const p of parts) {
    let st;
    try { st = io.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
    if (st.isSymbolicLink()) fail('PULSE-REFUSED-LINK', 'linked path');
    if (st.isFile() && st.nlink > 1) fail('PULSE-REFUSED-LINK', 'hardlinked file');
  }
  return resolved;
}

function parseCandidates(text) {
  return parseRegistry(text).rows.map(({ cells: c }) => ({ stream: c[0], branch: c[1], sha: c[2], status: c[4], note: c[6] }));
}

function load(root, opts = {}) {
  try {
    if (!Number.isFinite(opts.nowMs)) fail('PULSE-NOW-INVALID', 'finite caller time required');
    const io = opts.io || fs;
    root = safePath(root, io);
    const workRoot = safePath(opts.workRoot || path.join(path.dirname(root), 'ops-work'), io);
    const runtime = safePath(opts.runtimeDir || path.join(root, '.ai/runtime'), io);
    const config = opts.pulse || {};
    const resolve = (value, base) => { refuseProtected(value); return safePath(path.resolve(base, value), io); };
    const files = {
      candidates: path.join(runtime, 'CANDIDATES.md'), runtime,
      queue: resolve(config.queueDir || 'farm/queue', workRoot),
      receipts: safePath(opts.receiptRoot || path.join(workRoot, 'author-checks'), io),
       beats: resolve(config.beatDir || 'farm/beat', workRoot),
       results: resolve(config.resultsDir || 'farm/results', workRoot),
      task: path.join(root, '.ai/TASK.md'),
      register: config.registerPath ? resolve(config.registerPath, root) : null,
      backlog: config.backlogPath ? resolve(config.backlogPath, root) : null,
      classRegistry: config.classRegistryPath ? resolve(config.classRegistryPath, root) : null,
      classWeights: config.classWeightsPath ? resolve(config.classWeightsPath, root) : null,
      priceSnapshots: config.priceSnapshotDir ? resolve(config.priceSnapshotDir, root) : null,
      routeState: config.routeStatePath ? resolve(config.routeStatePath, root) : null,
      // the coupled-set registry: the switch of the packet context and its activation mark
      coupled: path.join(root, ...require('../../protocol-context.cjs').FILES.coupledSets.split('/')),
    };
    for (const key of Object.keys(files).sort()) if (files[key] !== null) safePath(files[key], io);
    const errors = [];
    const absent = [];
    const read = (file, encoding = 'utf8') => {
      if (file === null) fail('PULSE-SOURCE-UNCONFIGURED', 'optional source path is not configured');
      safePath(file, io);
      const st = io.statSync(file);
      if (!st.isFile() || st.size > LIMIT) fail('PULSE-SOURCE-LIMIT', 'source exceeds byte limit or is not a file');
      return io.readFileSync(file, encoding);
    };
    const json = file => readers.json(read(file, null));
    const attempt = (source, section, fn, fallback, optionalPath) => {
      try { return fn(); } catch (e) {
        if (/^PULSE-REFUSED/.test(e.code || '')) throw e;
        if (optionalPath !== undefined && ['ENOENT', 'PULSE-SOURCE-UNCONFIGURED'].includes(e.code)) {
          for (const target of [section].flat()) absent.push({ section: target, source, text: `${source} absent: ${flat(optionalPath || '(not configured)')}` });
          return fallback;
        }
        for (const target of [section].flat()) errors.push({ section: target, text: `${source} UNREADABLE: ${flat(e.code || 'INVALID')}` });
        return fallback;
      }
    };
    const listing = (dir, filter = () => true, limit = 10000) => {
      safePath(dir, io);
      const names = io.readdirSync(dir).filter(filter).sort(cmp);
      if (names.length > limit) fail('PULSE-SOURCE-LIMIT', 'directory exceeds entry limit');
      return names;
    };
    const git = opts.git || (args => {
      const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true,
        timeout: 3000, maxBuffer: 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
      if (r.error || r.status !== 0) fail('PULSE-GIT-UNREADABLE', 'git read failed');
      return String(r.stdout).trim();
    });
    const candidates = attempt('candidates', [0, 2], () => parseCandidates(read(files.candidates)), []);
    // One local Git snapshot, not a subprocess per candidate; exact fully-qualified refs.
    const refs = attempt('branch dates', 2, () => git(['log', '--branches', '--no-walk', '--decorate=full', '--format=%H%x09%ct%x09%D']), '');
    const times = new Map();
    for (const line of refs.split('\n')) {
      const [sha, seconds, decorations = ''] = line.split('\t');
      for (const ref of decorations.split(', ')) {
        const branch = ref.replace(/^HEAD -> /, '');
        if (branch.startsWith('refs/heads/')) times.set(branch.slice(11), { sha, ms: Number(seconds) * 1000 });
      }
    }
    for (const row of candidates) {
      row.commitMs = times.get(row.branch)?.ms;
      row.tip = times.get(row.branch)?.sha || row.sha;
    }
    const lineRef = opts.baseRef || 'origin/v2.0.0';
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(lineRef)) fail('PULSE-CONFIG-INVALID', 'invalid line ref');
    const lineHead = attempt('integration line', 4, () => git(['log', '-1', '--format=%h %ct %s', lineRef, '--']), '');
    // Index relevant launch names only. Unrelated runtime artifacts do not consume
    // the source budget; membership checks below are constant-time.
    const names = attempt('runtime', [0, 1, 2, 3, 4], () => listing(runtime, n => /\.(?:running\.json|terminal\.json|launch\.out)$/.test(n), Infinity), []);
    const nameSet = new Set(names);
    for (const name of names) safePath(path.join(runtime, name), io);
    // ASSIGN-EXECUTION R1: the owner's mode file and the machine state file, read-only and never required from the assign tools (this file is installed in every project).
    const assign = { mode: null, state: null };
    for (const [key, name, reader] of [['mode', 'assignment-mode', readers.assignMode], ['state', 'assign-state', readers.assignState]]) {
      const file = safePath(path.join(runtime, `${name}.json`), io);
      // These exact state files are separate from the launch-only directory index.
      if (io.existsSync(file)) assign[key] = attempt(name, 4, () => reader(read(file)), { invalid: true });
    }
    // Selection inputs: optional sources named by the pulse configuration (the class registry, its weights, the
    // directory of the price snapshots and the route state); the newest snapshot name wins, never an older one.
    const selection = {
      registry: attempt('class registry', 4, () => readers.classRegistry(read(files.classRegistry), read(files.classWeights)), { invalid: true }),
      prices: attempt('price snapshot', 4, () => {
        if (files.priceSnapshots === null) fail('PULSE-SOURCE-UNCONFIGURED', 'optional source path is not configured');
        const newest = listing(files.priceSnapshots).filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n)).at(-1);
        if (!newest) fail('PULSE-SELECTION-PRICES-MISSING', 'no price snapshot');
        return readers.priceSnapshot(newest, read(path.join(files.priceSnapshots, newest)));
      }, { invalid: true }),
      routeState: attempt('route state', 4, () => readers.routeState(read(files.routeState)), { invalid: true }),
    };
    const adviceApi = require('../../lib/selection-metrics.cjs');
    const adviceRows = new Map();
    for (const suffix of ['.running.json', '.terminal.json']) for (const name of names.filter(n => n.endsWith(suffix))) {
      attempt(`advice ${name}`, 0, () => {
        const item = adviceApi.row(json(path.join(runtime, name)), 'wrapper');
        if (item) adviceRows.set(item.id, item);
      }, null);
    }
    const advice = adviceApi.groups([...adviceRows.values()]);
    const adviceDetails = [...adviceRows.values()].filter(row => ['advise', 'assign'].includes(row.adviceMode));
    const advicePairs = adviceApi.correction([...adviceRows.values()]);
    const liveMarkers = [], seatRows = [];
    // The seat-end dictionary is the configured one (opts.endMarker, built by
    // lib/config.cjs from seat.endMarker and passed by pulse.cjs); it is
    // compiled once here through the single whole-end-line implementation of
    // pulse-read and never narrowed (prx419 D-001, prp430). Without it no seat
    // can be decided, so the snapshot is refused rather than guessed.
    if (typeof opts.endMarker !== 'string' && !(opts.endMarker instanceof RegExp)) fail('PULSE-CONFIG-INVALID', 'seat end marker is not configured');
    const seatEnd = readers.endMatcher(opts.endMarker);
    const failures = [];
    const launches = [...new Set(names.map(n => n.replace(/\.(?:running\.json|terminal\.json|launch\.out)$/, '')))];
    const newest = name => Math.max(...['.running.json', '.launch.out'].filter(s => nameSet.has(name + s)).map(s => io.statSync(path.join(runtime, name + s)).mtimeMs), 0);
    const indexed = launches.map(name => ({ name, time: attempt(`seat ${name}`, [0, 1, 2, 3], () => newest(name), 0) }))
      .sort((a, b) => b.time - a.time || cmp(a.name, b.name));
    let outputBytes = 0;
    for (const { name } of indexed) {
      const record = suffix => nameSet.has(name + suffix) ? attempt(`seat source ${name + suffix}`, [0, 1, 2], () => {
        const value = json(path.join(runtime, name + suffix));
        if (!value || !Number.isSafeInteger(value.wrapperPid) || value.wrapperPid <= 0 || readers.timestamp(value.startedAt) > opts.nowMs) throw new Error('invalid seat');
        return value;
      }, null) : null;
      const marker = record('.running.json'), terminal = record('.terminal.json');
      let ended = Boolean(marker?.ended) || Boolean(marker && terminal && marker.wrapperPid === terminal.wrapperPid && marker.startedAt === terminal.startedAt);
      const output = name + '.launch.out';
      // Output is authoritative when present; stale terminal/ended records of a
      // reused launch name must not close a new output with no end marker.
      if (nameSet.has(output)) ended = false;
      if (nameSet.has(output)) attempt(`output ${output}`, [0, 1, 2, 3], () => {
        const file = path.join(runtime, output), st = io.statSync(file);
        if (!st.isFile() || st.mtimeMs > opts.nowMs) fail('PULSE-OUTPUT-INVALID', 'invalid output');
        // Read bounded chunks, including markers before the final tail. A budget
        // exhaustion is UNKNOWN, never proof that a launch is still running.
        let tail = '', fd;
        try {
          fd = io.openSync(file, 'r');
          const buffer = Buffer.alloc(65536);
          const range = (start, end) => {
            const decoder = new TextDecoder('utf-8', { fatal: true });
            for (let position = start; position < end;) {
              const length = Math.min(buffer.length, end - position);
              if (outputBytes + length > 128 * 1024 * 1024) fail('PULSE-SOURCE-LIMIT', 'launch output budget');
              const n = io.readSync(fd, buffer, 0, length, position);
              if (!n) fail('PULSE-OUTPUT-CHANGED', 'short output read');
              position += n; outputBytes += n;
              tail += decoder.decode(buffer.subarray(0, n), { stream: true });
              ended = ended || readers.ended(tail, seatEnd);
              tail = tail.slice(-65536);
            }
            decoder.decode();
          };
          // Align the tail to a UTF-8 codepoint. At most three initial
          // continuation bytes are skipped; a full scan starts at byte zero.
          let tailStart = Math.max(0, st.size - buffer.length);
          if (tailStart) {
            const prefix = Buffer.alloc(4);
            const got = io.readSync(fd, prefix, 0, 4, tailStart);
            let skip = 0;
            while (skip < got && skip < 3 && (prefix[skip] & 0xc0) === 0x80) skip++;
            tailStart += skip;
          }
          range(tailStart, st.size);
          if (!ended && tailStart) {
            if (st.size > 64 * 1024 * 1024) fail('PULSE-SOURCE-LIMIT', 'launch output limit');
            tail = ''; range(0, st.size);
          }
          const after = io.statSync(file);
          if (after.size !== st.size || after.mtimeMs !== st.mtimeMs) fail('PULSE-OUTPUT-CHANGED', 'output moved during read');
        } finally { if (fd !== undefined) io.closeSync(fd); }
        if (opts.nowMs - st.mtimeMs <= 12 * 3600000) {
          const match = tail.match(/([A-Z0-9_-]+_NO_VERDICT exit=[1-9][^\n]*|LAUNCH REFUSED[^\n]*|REFUSED P-[A-Z]+|TURN_LIMIT|SEAT-RETRY-EXHAUSTED)/);
          if (match) failures.push({ name: output, mtimeMs: st.mtimeMs, reason: match[1] });
        }
      }, null);
      if (!ended && (marker || nameSet.has(output))) {
        const client = marker?.routeGate?.client || marker?.client || marker?.engine || 'unknown';
        seatRows.push({ name, client });
        liveMarkers.push({ ...marker, name });
      }
    }
    const beats = [];
    for (const name of attempt('worker beats', 4, () => listing(files.beats, n => n.endsWith('.json')), [], files.beats)) {
      attempt(`beat ${name}`, 4, () => {
        const file = path.join(files.beats, name);
        const data = json(file);
        if (!data || typeof data.host !== 'string' || !data.host || typeof data.state !== 'string' || !data.state
          || (data.job != null && (typeof data.job !== 'object' || Array.isArray(data.job) || typeof data.job.name !== 'string'))) throw new Error('invalid beat');
        const mtimeMs = data.at === undefined ? io.statSync(file).mtimeMs : readers.timestamp(data.at);
        beats.push({ host: data.host || name, state: data.state, job: data.job?.name || '', mtimeMs });
      }, null);
    }
    const disk = attempt('disk', 4, () => {
      const st = io.statfsSync(workRoot);
      const free = Number(st.bavail) * Number(st.bsize);
      if (!Number.isFinite(free) || free < 0) fail('PULSE-DISK-INVALID', 'invalid free bytes');
      return free;
    }, null);
    const task = attempt('TASK', 5, () => readers.text(read(files.task, null)), '');
    const health = [];
    for (const [name, schema] of [['operator-tick-last.json', 'operator-tick-last/1'], ['operator-schedules.json', 'operator-schedules/1']]) {
      const data = attempt(name, 4, () => {
        const record = json(path.join(runtime, name));
        if (record?.schema !== schema) throw new Error('invalid health receipt');
        return record;
      }, null, path.join(runtime, name));
      if (data) health.push({ name, at: data.at, verdict: data.verdict,
        tasks: Array.isArray(data.tasks) ? data.tasks.map(readers.scheduleTask) : [] });
    }
    const register = attempt('open register', [0, 6], () => readers.register(read(files.register, null)), [], files.register);
    // The coverage of the packet: after the activation mark of the coupled-set registry, the author and certifier launches of the record day
    // files without a packet. No mark (the switch off, no registry, a mark after now), no count, and a line of the day files that does not
    // read or a record its reader refused leaves the count unknown (packet-measure.cjs coverageAfter): the line says why. A launch after the
    // moment of the pulse is left out and counted.
    const packetCoverage = attempt('packet coverage', 4, () => {
      let text = null;
      try { text = read(files.coupled); } catch (e) { if (e.code !== 'ENOENT') throw e; }
      const mark = measure.activationOf(text, opts.nowMs);
      if (mark.sinceMs === null) return { ...mark, counts: null };
      // the launch-record day files are found only once a mark exists (the folder of the main checkout of the root)
      const records = safePath(opts.launchRecordsDir || require('../../repo-paths.cjs').pendingDir(opts.recordsEnv || {}, root), io);
      const days = measure.readRecords(records, { fromMs: Math.floor(mark.sinceMs / 86400000) * 86400000, toMs: opts.nowMs, atMs: opts.nowMs },
        { readdirSync: listing, readFileSync: file => read(file, null) });
      return measure.coverageAfter(mark, days);
    }, { state: 'unknown', sinceMs: null, reason: 'unreadable', counts: null });
    const backlog = attempt('backlog', 0, () => readers.backlog(read(files.backlog, null)), [], files.backlog);
    // One directory rule for every live data source: like the runtime index,
    // receipts and farm results have no entry cap. A large directory is read
    // in full; the per-file byte limit is the bound on each member.
    const receiptNames = attempt('author receipts', [2, 8], () => listing(files.receipts, n => n.endsWith('.json'), Infinity), [], files.receipts);
    for (const name of receiptNames) safePath(path.join(files.receipts, name), io);
    const receiptSources = new Map();
    // The receipt source passes the canonical reader (unique keys, NFC) like
    // every other pulse source; the raw text is kept only for the per-file line
    // citations of the author-check long pole (finding 11.99).
    const receiptData = readReceipts(files.receipts, { ...io, readdirSync: () => receiptNames,
      readFileSync: file => {
        const source = read(file);
        readers.json(source);
        receiptSources.set(path.basename(file), source);
        return source;
      } });
    // An unreadable receipt is unknown for the duration medians, for that record only; B4 still names it.
    const durationExcluded = [];
    for (const problem of receiptData.problems) {
      errors.push({ section: 2, text: `author receipt UNREADABLE: ${flat(problem)}` });
      durationExcluded.push({ name: flat(problem).split(':')[0], reason: 'receipt unreadable' });
    }
    const receipts = receiptData.receipts.map(({ name, value }) => {
      const timing = attempt(`author timing ${name}`, 7,
        () => readers.receiptTiming(receiptSources.get(name)), { files: null, lines: {} });
      return { name, head: value.head, branch: value.branch,
      at: value.at, ok: value.ok, failedGroups: Object.keys(value.results || {}).sort(cmp).filter(k => value.results[k]?.exit !== 0),
      // per-file run results the check copied into the receipt (finding 11.99): the pulse
      // reads the long pole of the last author-check run from the receipt itself.
      runFiles: timing.files, runLines: timing.lines };
    });
    const samples = [], farmResults = [];
    const addReceipt = value => {
      if (value.results?.run?.wallMs === undefined) return;
      if (!Number.isFinite(value.results.run.wallMs) || value.results.run.wallMs <= 0) fail('PULSE-DURATION-INVALID', 'invalid wallMs');
      const at = readers.timestamp(value.at);
      if (at > opts.nowMs) fail('PULSE-DURATION-INVALID', 'future receipt');
      samples.push({ kind: 'author-check-driver', at, minutes: value.results.run.wallMs / 60000, key: `${value.branch}|${value.head}|${value.at}` });
    };
    for (const { name, value } of receiptData.receipts) attempt(`duration receipt ${name}`, 8, () => addReceipt(value), null);
    for (const name of attempt('farm results', [4, 8], () => listing(files.results, () => true, Infinity), [], files.results)) {
      const dir = path.join(files.results, name), doneFile = path.join(dir, 'done.json');
      safePath(dir, io); safePath(doneFile, io);
      // An unfinished result directory is normal, not an unreadable done record.
      if (!io.existsSync(doneFile)) continue;
      attempt(`farm result ${name}`, [4, 8], () => {
        const done = json(doneFile), job = json(path.join(dir, 'job.json'));
        if (!done || !job || typeof done.id !== 'string' || done.id !== job.id || typeof done.host !== 'string'
          || !['suite', 'author-check', 'file', 'fast-red', 'shard'].includes(job.kind) || !(Number.isInteger(done.exit) || done.exit === 'cancelled' || done.exit === 'lease-expired' || done.exit === null || done.exit === undefined)) fail('PULSE-RESULT-INVALID', 'invalid done');
        const at = readers.timestamp(done.at);
        if (at > opts.nowMs) fail('PULSE-RESULT-INVALID', 'future done');
        // A missing exit (a killed run) is unknown for this record only; it never taints the section.
        const exitKnown = done.exit !== null && done.exit !== undefined;
        farmResults.push({ name, at, exit: exitKnown ? done.exit : null });
        const kind = job.kind === 'suite' ? 'train-suite' : job.kind === 'author-check' ? 'author-check-farm' : job.kind === 'shard' ? 'farm-shard' : null;
        // A lease expiry has no completed runner duration, even if stale minutes remain.
        if (kind && done.exit === 'lease-expired') { durationExcluded.push({ name, reason: 'lease expired' }); return; }
        // Minutes are validated only for the kinds that enter the medians: a zero-minute
        // job is a measured value, and ordinary fast file jobs carry it.
        if (!kind || done.minutes === undefined) return;
        if (!Number.isFinite(done.minutes) || done.minutes < 0) fail('PULSE-DURATION-INVALID', 'invalid minutes');
        if (!exitKnown) { durationExcluded.push({ name, reason: 'exit missing' }); return; }
        // Farm wall time includes FAST-RED/setup. Do not also count its copied
        // receipt's narrower driver wall time as a second author check.
        if (kind === 'author-check-farm' && done.receipt) {
          if (typeof done.receipt !== 'string' || path.basename(done.receipt) !== done.receipt || !done.receipt.endsWith('.json')) fail('PULSE-RESULT-INVALID', 'invalid receipt path');
          safePath(path.join(dir, done.receipt), io);
          const copied = readReceipts(dir, { ...io, readdirSync: () => [done.receipt], readFileSync: file => JSON.stringify(json(file)) });
          // The copy cannot be read, so it cannot be matched to a driver sample: this record is unknown.
          if (copied.problems.length || copied.receipts.length !== 1) { durationExcluded.push({ name, reason: 'copied receipt unreadable' }); return; }
          const value = copied.receipts[0].value;
          const key = `${value.branch}|${value.head}|${value.at}`;
          for (let i = samples.length - 1; i >= 0; i--) if (samples[i].key === key) samples.splice(i, 1);
        }
        samples.push({ kind, at, minutes: done.minutes, key: `farm:${done.id}|${done.host}` });
      }, null);
    }
    const uniqueSamples = new Map();
    for (const sample of samples) {
      if (uniqueSamples.has(sample.key) && JSON.stringify(uniqueSamples.get(sample.key)) !== JSON.stringify(sample)) errors.push({ section: 8, text: 'duration samples UNREADABLE: conflicting duplicate' });
      uniqueSamples.set(sample.key, sample);
    }
    const queue = attempt('farm queue', [0, 2], () => listing(files.queue, n => n.endsWith('.json')), [], files.queue);
    const queueJobs = [];
    for (const name of queue) attempt(`farm queue ${name}`, [0, 2], () => {
      const job = json(path.join(files.queue, name));
      if (!job || typeof job !== 'object' || Array.isArray(job) || typeof job.id !== 'string'
        || !['suite', 'author-check', 'file', 'fast-red', 'shard'].includes(job.kind) || !/^[0-9a-f]{40}$/.test(job.sha || '')) fail('PULSE-QUEUE-INVALID', 'invalid job');
      queueJobs.push({ sha: job.sha, name: job.name });
    }, null);
    // The long pole of the last full suite run (finding 11.99 / R-L2-013.21): the driver's
    // own timing history, one line per full run. An absent file (no full runs yet) is not
    // an error: the section reports the cause unproven, never silently.
    const suiteTiming = attempt('suite timing', 7, () => {
      try { return readers.scheduleTiming(read(path.join(runtime, 'test-timing.jsonl'))); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    }, null);
    return { ok: true, candidates, markerRows: liveMarkers, seatRows, failures, beats, disk, task, register, backlog, health, packetCoverage,
      suiteTiming,
      queue, queueJobs,
      receipts, lineHead, errors, absent, farmResults, durationExcluded, samples: [...uniqueSamples.values()],
      assign, selection, advice, adviceDetails, advicePairs };
  } catch (e) { return { ok: false, code: e.code || 'PULSE-LOAD-ERROR', detail: flat(e.message) }; }
}

// The long-pole pulse (finding 11.99 / R-L2-013.21): minutes and start offsets, bounded and
// deterministic (duration desc, name asc), and a serial label proven only when the run
// records a window for every file: parallel is proven by one known overlap, serial needs
// every other window known, everything else is reported serial unknown - never guessed.
// Number(null) is 0 and would prove a start that never happened: only numbers are windows.
const POLE_TOP = 5;
function poleMinutes(seconds) {
  return `${(Math.max(0, Number(seconds) || 0) / 60).toFixed(1)} min`;
}
function poleStart(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}
function poleRows(rows) {
  const clean = rows.filter(row => plain(row) && typeof row.name === 'string' && row.name &&
    Number.isFinite(row.seconds) && row.seconds > 0)
    .map(row => readers.timingFile(row.name, row.seconds, row.startMs));
  return clean.slice().sort((a, b) => b.seconds - a.seconds || cmp(a.name, b.name)).slice(0, POLE_TOP);
}
function poleTag(rows, row) {
  if (row.startMs === null || !(row.seconds > 0) || rows.filter(other => other.name === row.name).length !== 1) return 'serial unknown';
  const end = row.startMs + row.seconds * 1000;
  if (!Number.isFinite(end)) return 'serial unknown';
  // Rows are keyed by file name (the ranked copy is a fresh object per row), never by identity.
  const live = rows.filter(other => other.name !== row.name && other.seconds !== 0);
  const known = other => Number.isFinite(other.seconds) && other.seconds >= 0 && poleStart(other.startMs) !== null &&
    Number.isFinite(other.startMs + other.seconds * 1000);
  const overlaps = live.some(other => known(other) &&
    Math.max(row.startMs, other.startMs) < Math.min(end, other.startMs + other.seconds * 1000));
  if (overlaps) return 'parallel';
  return live.every(known) ? 'serial' : 'serial unknown';
}
function poleLine(prefix, rows, row, source) {
  if (!source || source.length > 150) return `${prefix} long pole: UNPROVEN (missing or overlong source address)`;
  const offset = row.startMs === null ? 'unknown' : `${(row.startMs / 60000).toFixed(1)} min`;
  // Source comes first so the bounded output cannot cut away the proof address.
  return `${prefix} long pole: (source: ${source}) ${row.name} ${poleMinutes(row.seconds)}, start offset ${offset}, ${poleTag(rows, row)}`;
}
function receiptRunFiles(receipt) {
  const rows = receipt && plain(receipt.runFiles) ? Object.entries(receipt.runFiles)
    .map(([name, value]) => readers.timingFile(name, plain(value) ? value.seconds : null,
      plain(value) ? value.startMs : null)) : [];
  return { all: rows, top: poleRows(rows) };
}
function scan(snapshot, nowMs) {
  if (!Number.isFinite(nowMs)) fail('PULSE-NOW-INVALID', 'finite caller time required');
  const sections = HEADINGS.map(title => ({ title, lines: [] }));
  const add = (i, text) => sections[i].lines.push(flat(text));
  // Reserved report lines are generated, never data; the emitter keeps their
  // exact shapes while every embedded data fragment still passes flat().
  const emit = (i, text) => sections[i].lines.push(text);
  const counts = { streams: 0, seats: 0, stale: 0, failed: 0, undated: 0 };
  if (!snapshot?.ok) {
    for (let i = 0; i < sections.length; i++) add(i, `PULSE UNREADABLE: ${snapshot?.code || 'NO-SNAPSHOT'} ${snapshot?.detail || ''}`);
    for (const key of Object.keys(counts)) counts[key] = null;
  } else {
    const unknown = i => snapshot.errors.some(e => e.section === i);
    const unreadable = source => snapshot.errors.some(e => e.text.startsWith(`${source} UNREADABLE:`));
    const absent = source => snapshot.absent.some(e => e.source === source);
    const unavailable = source => unreadable(source) || absent(source);
    const candidateKey = r => JSON.stringify([r.branch, r.sha, r.stream, r.status, r.note, r.commitMs, r.tip]);
    const active = snapshot.candidates.filter(r => ['building', 'ready', 'certifying', 'certified'].includes(r.status))
      .slice().sort((a, b) => cmp(candidateKey(a), candidateKey(b)));
    const openBranches = new Set(active.map(r => r.branch));
    counts.streams = openBranches.size;
    counts.seats = snapshot.seatRows.length;
    add(0, `line: ${snapshot.lineHead || 'UNREADABLE'}`);
    add(0, `open packages: ${unreadable('candidates') ? 'UNKNOWN' : counts.streams}; live seats: ${unknown(1) ? 'UNKNOWN' : counts.seats}; farm queue: ${unavailable('farm queue') || snapshot.errors.some(e => e.text.startsWith('farm queue ')) ? 'UNKNOWN' : snapshot.queue.length} (open package = a distinct branch with a building, ready, certifying or certified row)`);
    for (const g of snapshot.advice || []) add(0, `ADVICE class=${g.taskClass} n=${g.pairs} recommended=${g.recommended} followed=${g.matches} deviated=${g.deviations} no-reason=${g.noReason} unknown=${g.unknownComparison} agreement=${g.agreementRate === null ? 'UNKNOWN' : (100 * g.agreementRate).toFixed(1) + '%'} outcomes=${g.outcomes} fallbacks=${g.fallbacks}`);
    if (snapshot.advicePairs) add(0, `SELECTION-PAIRS advised=${snapshot.advicePairs.pairs} comparable=${snapshot.advicePairs.comparable} of ${snapshot.advicePairs.threshold}; correction=${snapshot.advicePairs.correction} (benchmarks and price decide until the threshold)`);
    for (const detail of snapshot.adviceDetails || []) {
      for (const r of detail.ranked.slice(0, 3)) add(0, `ADVICE class=${detail.taskClass} rank=${r.rank} route=${r.client}:${r.model}:${r.effort || 'unknown'} cost=${r.costClass || 'unknown'} estimatedCost=${r.estimatedCost ?? 'unknown'} priceBasis=${r.priceBasis ? JSON.stringify(r.priceBasis) : 'unknown'} reasons=${r.reasons.join(',') || 'selection-ranked'}`);
      if (detail.ranked.length < 3) {
        add(0, `ADVICE class=${detail.taskClass} eligible=${detail.ranked.length} wanted=3 reason=${detail.recommendation ? 'fewer-eligible-routes' : detail.reason}`);
        for (const r of detail.excluded || []) add(0, `ADVICE excluded=${r.client}:${r.model} reasons=${r.reasons.join(',') || 'route-ineligible'}`);
      }
    }
    const statuses = new Map();
    for (const item of snapshot.register) statuses.set(item.status, (statuses.get(item.status) || 0) + 1);
    add(0, `register: ${unavailable('open register') ? 'UNKNOWN' : [...statuses].sort(([a], [b]) => cmp(a, b)).map(([k, n]) => `${k}=${n}`).join(', ') || 'none recorded'}`);
    const backlogStatuses = new Map();
    for (const status of snapshot.backlog) backlogStatuses.set(status, (backlogStatuses.get(status) || 0) + 1);
    add(0, `backlog statuses: ${unavailable('backlog') ? 'UNKNOWN' : [...backlogStatuses].sort(([a], [b]) => cmp(a, b)).map(([k, n]) => `${k}=${n}`).join(', ') || 'none recorded'}`);
    for (const row of active) {
      add(0, `${row.stream} | ${row.branch} | ${row.sha} | ${row.status}`);
      const age = nowMs - row.commitMs;
      // r2 adds train membership; r1 only labels the original 12h observation.
      const moving = snapshot.markerRows.some(s => s.stream === row.stream || s.stream === row.branch)
        || snapshot.queue.some(q => q.includes((row.tip || row.sha).slice(0, 8)))
        || snapshot.queueJobs.some(q => q.sha === (row.tip || row.sha));
      if (unknown(2) || absent('farm queue') || absent('author receipts')) continue;
      if (!Number.isFinite(age)) { add(2, `${row.branch}: commit date UNREADABLE`); counts.stale = null; }
      else if (!moving && age > 12 * 3600000) {
        if (counts.stale !== null) counts.stale++;
        const receipt = snapshot.receipts.slice().sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || cmp(a.name, b.name))
          .find(r => r.branch === row.branch && r.head === (row.tip || row.sha));
        add(2, `${row.branch}: ${Math.floor(age / 3600000)}h; ${receipt ? `receipt ok=${receipt.ok} failed=${receipt.failedGroups.join(',') || 'none'}` : 'no receipt'}; ${row.note}`);
      }
    }
    const groups = new Map();
    for (const seat of snapshot.seatRows) {
      const route = snapshot.markerRows.find(m => m.name === seat.name)?.routeGate;
      const key = route?.model ? `${seat.client || 'unknown'} / ${route.provider || 'unknown'} / ${route.model}` : seat.client || 'unknown';
      groups.set(key, (groups.get(key) || 0) + 1);
    }
    for (const [client, n] of [...groups].sort(([a], [b]) => cmp(a, b))) add(1, `${client}: ${n}`);
    const failures = snapshot.failures.filter(f => nowMs >= f.mtimeMs && nowMs - f.mtimeMs <= 12 * 3600000)
      .slice().sort((a, b) => b.mtimeMs - a.mtimeMs || cmp(b.name, a.name)).slice(0, 40).sort((a, b) => cmp(a.name, b.name));
    counts.failed = failures.length;
    for (const f of failures) add(3, `${f.name}: ${f.reason}`);
    add(4, 'operator loops: absent: process table (filesystem-only report; health records are not process proof)');
    for (const record of snapshot.health.slice().sort((a, b) => cmp(a.name, b.name))) {
      add(4, `${record.name}: ${record.verdict || 'recorded'}; at=${record.at || 'unknown'}`);
      for (const task of record.tasks.slice().sort((a, b) => cmp(`${a.id}|${a.status}`, `${b.id}|${b.status}`))) add(4, `schedule ${task.id || 'UNKNOWN'}: ${task.status || 'UNKNOWN'}`);
    }
    for (const beat of snapshot.beats.slice().sort((a, b) => cmp(`${a.host}|${a.job}|${a.state}|${a.mtimeMs}`, `${b.host}|${b.job}|${b.state}|${b.mtimeMs}`))) {
      add(4, `farm ${beat.host}: ${beat.state}; job=${beat.job}; ageMinutes=${beat.mtimeMs > nowMs ? 'UNKNOWN (future mtime)' : Math.floor((nowMs - beat.mtimeMs) / 60000)}`);
      if (beat.mtimeMs <= nowMs && nowMs - beat.mtimeMs > 180000) emit(4, `ALARM SILENT_WORKER ${flat(beat.host)}: beat age exceeds 180 seconds`);
    }
    for (const result of snapshot.farmResults.slice().sort((a, b) => b.at - a.at || cmp(a.name, b.name)).slice(0, 10)) add(4, `farm result ${result.name}: exit=${result.exit ?? 'unknown'}`);
    add(4, snapshot.disk === null ? 'disk UNREADABLE' : `disk freeBytes: ${snapshot.disk}`);
    add(4, measure.coverageLine(snapshot.packetCoverage));
    add(4, readers.assignLine(snapshot.assign, nowMs));
    for (const line of readers.selectionLines(snapshot.selection, nowMs)) add(4, line);
    try { for (const q of readers.questions(snapshot.task)) add(5, q); }
    catch (e) { add(5, `TASK UNREADABLE: ${flat(e.code || 'INVALID')}`); }
    counts.undated = unknown(6) || absent('open register') ? null : snapshot.register.filter(item => !item.statusAsOf).length;
    add(6, `DEFERRED r2: aging escalation; register undated: ${counts.undated === null ? 'UNKNOWN' : counts.undated}`);
    // F9: the long pole of the slowest runs, every line citing the record it was read from
    // (finding 11.99: a named cause names the file - and line where one exists - that
    // proves it; a cause without a readable record is reported unproven, never silent).
    if (snapshot.suiteTiming) {
      const timing = snapshot.suiteTiming;
      const rows = poleRows(timing.rows);
      add(7, `last full suite run at ${timing.at}: runId ${timing.runId}, ${rows.length} of ${timing.rows.length} files ranked, conc ${timing.conc} (source: .ai/runtime/test-timing.jsonl line ${timing.line})`);
      if (!rows.length) add(7, 'suite long pole: UNPROVEN (no measured file durations)');
      for (const row of rows) add(7, poleLine('suite', timing.rows, row,
        Number.isSafeInteger(timing.line) && timing.line > 0 ? `.ai/runtime/test-timing.jsonl line ${timing.line}` : null));
    } else {
      add(7, `suite long pole: UNPROVEN (${unknown(7) ? 'unreadable timing history' : 'no full-run per-file timing recorded'} at .ai/runtime/test-timing.jsonl)`);
    }
    const newestReceipt = snapshot.receipts.slice().sort((a, b) =>
      Date.parse(b.at) - Date.parse(a.at) || cmp(a.name, b.name))[0] || null;
    const check = receiptRunFiles(newestReceipt);
    if (unreadable('author receipts') || unreadable('author receipt')) {
      add(7, 'author-check long pole: UNPROVEN (unreadable receipt source; latest run cannot be established)');
    } else if (!newestReceipt) {
      add(7, 'author-check long pole: UNPROVEN (no author-check receipt recorded)');
    } else if (!check.top.length) {
      add(7, `author-check long pole: UNPROVEN (receipt ${newestReceipt.name} records no per-file run results)`);
    } else {
      add(7, `author-check run at ${newestReceipt.at} (source: author-check receipt ${newestReceipt.name})`);
      for (const row of check.top) {
        const line = newestReceipt.runLines?.[row.name];
        add(7, poleLine('author-check', check.all, row,
          Number.isSafeInteger(line) && line > 0 ? `receipt ${newestReceipt.name} line ${line}` : null));
      }
    }
    if (unknown(8)) add(8, 'duration medians: UNKNOWN (malformed or unreadable source; alarms withheld)');
    else {
      for (const line of readers.durations(snapshot.samples, nowMs)) emit(8, line);
      // Unknown records are left out of the medians, never counted as zero; the count is named.
      if (snapshot.durationExcluded?.length) emit(8, `duration samples excluded as unknown: ${snapshot.durationExcluded.length} (${[...new Set(snapshot.durationExcluded.map(x => x.reason))].sort(cmp).join(', ')})`);
    }
    for (const item of snapshot.absent.slice().sort((a, b) => a.section - b.section || cmp(a.text, b.text))) add(item.section, item.text);
    for (const error of snapshot.errors.slice().sort((a, b) => a.section - b.section || cmp(a.text, b.text))) add(error.section, error.text);
    if (unreadable('candidates')) counts.streams = null;
    if (unknown(1)) counts.seats = null;
    if (unknown(2) || absent('farm queue') || absent('author receipts')) counts.stale = null;
    if (unknown(3)) counts.failed = null;
    if (unknown(6)) counts.undated = null;
  }
  for (const section of sections) if (!section.lines.length) section.lines.push('none');
  return { sections, counts };
}

module.exports = { HEADINGS, LIMIT, flat, refuseProtected, safePath, parseCandidates, load, scan };

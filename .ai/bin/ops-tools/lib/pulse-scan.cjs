'use strict';
// OPERATOR-PULSE r1: bounded read-only acquisition and a pure snapshot reducer.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const seats = require('../seat-count.cjs');
const { loadSeatCaps } = require('./config.cjs');
const { readReceipts } = require('./receipt.cjs');
const { parseRegistry } = require('../../lib/candidate-registry.cjs');
const { secretIn } = require('../../lib/secrets.cjs');
const protectedPaths = require('../../lib/protected-paths.cjs');
const readers = require('./pulse-read.cjs');
const measure = require('../packet-measure.cjs');
const LIMIT = 8 * 1024 * 1024;
const HEADINGS = Object.freeze(['A1 Streams', 'A2 Seats per route', 'B4 Stale packages',
  'B5 Failed seats', 'C6 Health', 'D7 Open owner questions', 'E8 Aging escalation', 'F9 Suite long pole']);
const cmp = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const plain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const flat = value => secretIn(String(value ?? '')) ? '[withheld: credential shape]'
  : Array.from(String(value ?? '').replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029]/g, ' ')).slice(0, 240).join('');
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
      task: path.join(root, '.ai/TASK.md'),
      register: config.registerPath ? resolve(config.registerPath, root) : null,
      backlog: config.backlogPath ? resolve(config.backlogPath, root) : null,
      // the coupled-set registry: the switch of the packet context and its activation mark
      coupled: path.join(root, ...require('../../protocol-context.cjs').FILES.coupledSets.split('/')),
    };
    for (const key of Object.keys(files).sort()) if (files[key] !== null) safePath(files[key], io);
    const errors = [];
    const read = (file, encoding = 'utf8') => {
      if (file === null) fail('PULSE-SOURCE-UNCONFIGURED', 'optional source path is not configured');
      safePath(file, io);
      const st = io.statSync(file);
      if (!st.isFile() || st.size > LIMIT) fail('PULSE-SOURCE-LIMIT', 'source exceeds byte limit or is not a file');
      return io.readFileSync(file, encoding);
    };
    const json = file => JSON.parse(read(file));
    const attempt = (source, section, fn, fallback) => {
      try { return fn(); } catch (e) {
        if (/^PULSE-REFUSED/.test(e.code || '')) throw e;
        for (const target of [section].flat()) errors.push({ section: target, text: `${source} UNREADABLE: ${flat(e.code || 'INVALID')}` });
        return fallback;
      }
    };
    const listing = dir => {
      safePath(dir, io);
      const names = io.readdirSync(dir).sort(cmp);
      if (names.length > 10000) fail('PULSE-SOURCE-LIMIT', 'directory exceeds entry limit');
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
    const names = attempt('runtime', [0, 1, 2, 3, 4], () => listing(runtime), []);
    // seat-count intentionally tolerates read errors; enforce the security boundary
    // before delegating so its tolerant JSON reader cannot swallow a link refusal.
    for (const name of names) safePath(path.join(runtime, name), io);
    // ASSIGN-EXECUTION R1: the owner's mode file and the machine state file, read-only and never required from the assign tools (this file is installed in every project).
    const assign = { mode: null, state: null };
    if (names.includes('assignment-mode.json')) assign.mode = attempt('assignment-mode', 4, () => readers.assignMode(read(path.join(runtime, 'assignment-mode.json'))), { invalid: true });
    if (names.includes('assign-state.json')) assign.state = attempt('assign-state', 4, () => readers.assignState(read(path.join(runtime, 'assign-state.json'))), { invalid: true });
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
    const markerRows = [];
    for (const name of names.filter(n => n.endsWith('.running.json'))) {
      attempt(`seat ${name}`, [0, 1, 2], () => {
        const marker = json(path.join(runtime, name));
        if (!marker || !Number.isSafeInteger(marker.wrapperPid)) throw new Error('invalid seat');
        markerRows.push({ ...marker, name: name.slice(0, -'.running.json'.length) });
      }, null);
    }
    // The shipped CLI has no --groups option. Reuse its canonical read-only API,
    // never spawn a second counter or invent another liveness predicate.
    const seatRead = file => {
      if (!names.includes(path.basename(file))) return ''; // absent terminal/output is normal
      return attempt(`seat source ${path.basename(file)}`, [0, 1, 2], () => {
        const text = read(file);
        if (file.endsWith('.json') && !JSON.parse(text)) throw new Error('invalid seat source');
        return text;
      }, '');
    };
    const seatRows = attempt('seat-count', [0, 1, 2], () => seats.runningSeats({ runtimeDir: runtime,
      io: { ...io, readdirSync: () => names, readFileSync: seatRead }, caps: opts.caps || loadSeatCaps({ readFile: read }), now: opts.nowMs,
      maxAgeMs: opts.maxAgeMs, endMarker: opts.endMarker, kill: opts.kill }), []);
    const liveNames = new Set(seatRows.map(row => row.name));
    const liveMarkers = markerRows.filter(row => liveNames.has(row.name));
    const failures = [];
    for (const name of names.filter(n => n.endsWith('.launch.out'))) {
      attempt(`output ${name}`, 3, () => {
        const file = path.join(runtime, name);
        safePath(file, io);
        const mtimeMs = io.statSync(file).mtimeMs;
        if (mtimeMs > opts.nowMs || opts.nowMs - mtimeMs > 12 * 3600000) return;
        const match = read(file).slice(-4000).match(/([A-Z0-9_-]+_NO_VERDICT exit=[1-9][^\n]*|LAUNCH REFUSED[^\n]*|REFUSED P-[A-Z]+|TURN_LIMIT|SEAT-RETRY-EXHAUSTED)/);
        if (match) failures.push({ name, mtimeMs, reason: match[1] });
      }, null);
    }
    const beats = [];
    for (const name of attempt('worker beats', 4, () => listing(files.beats), [])) {
      attempt(`beat ${name}`, 4, () => {
        const file = path.join(files.beats, name);
        const data = json(file);
        if (!data || typeof data.host !== 'string' || typeof data.state !== 'string') throw new Error('invalid beat');
        beats.push({ host: data.host || name, state: data.state, job: data.job?.name || '', mtimeMs: io.statSync(file).mtimeMs });
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
      }, null);
      if (data) health.push({ name, at: data.at, verdict: data.verdict,
        tasks: Array.isArray(data.tasks) ? data.tasks.map(readers.scheduleTask) : [] });
    }
    const register = attempt('open register', [0, 6], () => readers.register(read(files.register, null)), []);
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
    const backlog = attempt('backlog', 0, () => readers.backlog(read(files.backlog, null)), []);
    const receiptNames = attempt('author receipts', 2, () => listing(files.receipts), []).filter(n => n.endsWith('.json'));
    for (const name of receiptNames) safePath(path.join(files.receipts, name), io);
    const receiptSources = new Map();
    const receiptData = readReceipts(files.receipts, { ...io, readdirSync: () => receiptNames,
      readFileSync: file => {
        const source = read(file);
        receiptSources.set(path.basename(file), source);
        return source;
      } });
    for (const problem of receiptData.problems) errors.push({ section: 2, text: `author receipt UNREADABLE: ${flat(problem)}` });
    const receipts = receiptData.receipts.map(({ name, value }) => {
      const timing = attempt(`author timing ${name}`, 7,
        () => readers.receiptTiming(receiptSources.get(name)), { files: null, lines: {} });
      return { name, head: value.head, branch: value.branch,
      at: value.at, ok: value.ok, failedGroups: Object.keys(value.results || {}).sort(cmp).filter(k => value.results[k]?.exit !== 0),
      // per-file run results the check copied into the receipt (finding 11.99): the pulse
      // reads the long pole of the last author-check run from the receipt itself.
      runFiles: timing.files, runLines: timing.lines };
    });
    // The long pole of the last full suite run (finding 11.99 / R-L2-013.21): the driver's
    // own timing history, one line per full run. An absent file (no full runs yet) is not
    // an error: the section reports the cause unproven, never silently.
    const suiteTiming = attempt('suite timing', 7, () => {
      try { return readers.scheduleTiming(read(path.join(runtime, 'test-timing.jsonl'))); }
      catch (e) { if (e.code === 'ENOENT') return null; throw e; }
    }, null);
    return { ok: true, candidates, markerRows: liveMarkers, seatRows, failures, beats, disk, task, register, backlog, health, packetCoverage,
      suiteTiming,
      queue: attempt('farm queue', [0, 2], () => listing(files.queue), []),
      receipts, lineHead, errors, assign, advice, adviceDetails };
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
  const counts = { streams: 0, seats: 0, stale: 0, failed: 0, undated: 0 };
  if (!snapshot?.ok) {
    for (let i = 0; i < sections.length; i++) add(i, `PULSE UNREADABLE: ${snapshot?.code || 'NO-SNAPSHOT'} ${snapshot?.detail || ''}`);
    for (const key of Object.keys(counts)) counts[key] = null;
  } else {
    const unknown = i => snapshot.errors.some(e => e.section === i);
    const unreadable = source => snapshot.errors.some(e => e.text.startsWith(`${source} UNREADABLE:`));
    const candidateKey = r => JSON.stringify([r.branch, r.sha, r.stream, r.status, r.note, r.commitMs, r.tip]);
    const active = snapshot.candidates.filter(r => ['building', 'ready', 'certifying', 'certified'].includes(r.status))
      .slice().sort((a, b) => cmp(candidateKey(a), candidateKey(b)));
    counts.streams = active.length;
    counts.seats = snapshot.seatRows.length;
    add(0, `line: ${snapshot.lineHead || 'UNREADABLE'}`);
    add(0, `open packages: ${unknown(0) ? 'UNKNOWN' : active.length}; live seats: ${unknown(1) ? 'UNKNOWN' : counts.seats}; farm queue: ${unknown(0) ? 'UNKNOWN' : snapshot.queue.length}`);
    for (const g of snapshot.advice || []) add(0, `ADVICE class=${g.taskClass} n=${g.pairs} recommended=${g.recommended} followed=${g.matches} deviated=${g.deviations} no-reason=${g.noReason} unknown=${g.unknownComparison} agreement=${g.agreementRate === null ? 'UNKNOWN' : (100 * g.agreementRate).toFixed(1) + '%'} outcomes=${g.outcomes} fallbacks=${g.fallbacks}`);
    for (const detail of snapshot.adviceDetails || []) {
      for (const r of detail.ranked.slice(0, 3)) add(0, `ADVICE class=${detail.taskClass} rank=${r.rank} route=${r.client}:${r.model}:${r.effort || 'unknown'} cost=${r.costClass || 'unknown'} estimatedCost=${r.estimatedCost ?? 'unknown'} priceBasis=${r.priceBasis ? JSON.stringify(r.priceBasis) : 'unknown'} reasons=${r.reasons.join(',') || 'selection-ranked'}`);
      if (detail.ranked.length < 3) {
        add(0, `ADVICE class=${detail.taskClass} eligible=${detail.ranked.length} wanted=3 reason=${detail.recommendation ? 'fewer-eligible-routes' : detail.reason}`);
        for (const r of detail.excluded || []) add(0, `ADVICE excluded=${r.client}:${r.model} reasons=${r.reasons.join(',') || 'route-ineligible'}`);
      }
    }
    const statuses = new Map();
    for (const item of snapshot.register) statuses.set(item.status, (statuses.get(item.status) || 0) + 1);
    add(0, `register: ${unreadable('open register') ? 'UNKNOWN' : [...statuses].sort(([a], [b]) => cmp(a, b)).map(([k, n]) => `${k}=${n}`).join(', ') || 'none recorded'}`);
    const backlogStatuses = new Map();
    for (const status of snapshot.backlog) backlogStatuses.set(status, (backlogStatuses.get(status) || 0) + 1);
    add(0, `backlog statuses: ${unreadable('backlog') ? 'UNKNOWN' : [...backlogStatuses].sort(([a], [b]) => cmp(a, b)).map(([k, n]) => `${k}=${n}`).join(', ') || 'none recorded'}`);
    for (const row of active) {
      add(0, `${row.stream} | ${row.branch} | ${row.sha} | ${row.status}`);
      const age = nowMs - row.commitMs;
      // r2 adds train membership; r1 only labels the original 12h observation.
      const moving = snapshot.markerRows.some(s => s.stream === row.stream || s.stream === row.branch)
        || snapshot.queue.some(q => q.includes((row.tip || row.sha).slice(0, 8)));
      if (unknown(2)) continue;
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
    add(4, 'operator loops: UNREADABLE (no process table in filesystem snapshot)');
    for (const record of snapshot.health.slice().sort((a, b) => cmp(a.name, b.name))) {
      add(4, `${record.name}: ${record.verdict || 'recorded'}; at=${record.at || 'unknown'}`);
      for (const task of record.tasks.slice().sort((a, b) => cmp(`${a.id}|${a.status}`, `${b.id}|${b.status}`))) add(4, `schedule ${task.id || 'UNKNOWN'}: ${task.status || 'UNKNOWN'}`);
    }
    for (const beat of snapshot.beats.slice().sort((a, b) => cmp(`${a.host}|${a.job}|${a.state}|${a.mtimeMs}`, `${b.host}|${b.job}|${b.state}|${b.mtimeMs}`))) {
      add(4, `farm ${beat.host}: ${beat.state}; job=${beat.job}; ageMinutes=${beat.mtimeMs > nowMs ? 'UNKNOWN (future mtime)' : Math.floor((nowMs - beat.mtimeMs) / 60000)}`);
    }
    add(4, snapshot.disk === null ? 'disk UNREADABLE' : `disk freeBytes: ${snapshot.disk}`);
    add(4, measure.coverageLine(snapshot.packetCoverage));
    add(4, readers.assignLine(snapshot.assign, nowMs));
    try { for (const q of readers.questions(snapshot.task)) add(5, q); }
    catch (e) { add(5, `TASK UNREADABLE: ${flat(e.code || 'INVALID')}`); }
    counts.undated = unknown(6) ? null : snapshot.register.filter(item => !item.statusAsOf).length;
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
    for (const error of snapshot.errors.slice().sort((a, b) => a.section - b.section || cmp(a.text, b.text))) add(error.section, error.text);
    if (unknown(0)) counts.streams = null;
    if (unknown(1)) counts.seats = null;
    if (unknown(2)) counts.stale = null;
    if (unknown(3)) counts.failed = null;
    if (unknown(6)) counts.undated = null;
  }
  for (const section of sections) if (!section.lines.length) section.lines.push('none');
  return { sections, counts };
}

module.exports = { HEADINGS, LIMIT, flat, refuseProtected, safePath, parseCandidates, load, scan };

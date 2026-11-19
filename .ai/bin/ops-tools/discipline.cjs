'use strict';
// The discipline guards of the operator (lib/discipline.cjs) as one command.
//   discipline.cjs lines  [--root DIR] [--now ISO]      the guard lines, read-only (the pulse prints the same lines)
//   discipline.cjs tick   [--root DIR] [--now ISO]      the lines, then the owner channel and the operator loop restart
//   discipline.cjs defer  --item ITEM --reason TEXT --trigger TEXT [--deadline ISO] [--state deferred|resumed|dropped]
//   discipline.cjs claims --worktree DIR --report REPORT [--sha FULL_SHA]
// REPORT is the review file of the seat as a relative Markdown path inside the worktree (the review directory is the
// project's own choice); an absolute path or a dot segment is refused.
// tick is the scheduled pass (every 15 minutes from a scheduler outside the operator session). It writes only
// under the work root: its state file, one owner message file per alarm while the owner channel is alive (the
// sender of the host deletes what it delivered; an alive channel is a fresh alive file of that sender) and
// the log of a restart. Every file it writes is a new file of its own (an exclusive create, then a rename over
// the target), so an existing file or a second hard link is never written through. One tick at a time holds
// the side effects: a tick that finds another one holding them prints its lines and changes nothing.
// The owner channel takes an idle alarm after owner.dayMinutes of idle ready work by day
// and at most once in owner.nightRepeatMinutes at night, and a deferral overdue by owner.deferralOverdueMinutes
// once per deferral row. The operator loop (never a seat) is restarted by the command the host declares in
// discipline.operator.restart when the operator journal is silent for more than operator.silentMinutes, at most
// once in operator.cooldownMinutes; a seat environment never restarts anything.
// claims reads the facts of a finished seat in the report's own prose (its CommonMark blocks: code, an HTML block and
// a quote are not its own text; a table row and a heading are): every SHA of the Reviewed commit fields of the header
// should exist and match, and every receipt path the report names in the receipt root should be a file there. A file
// name alone or a path elsewhere is no receipt path: it counts only when it is found there. The words of report prose
// are no exact fact (a true sentence that a receipt is absent, an example path and a table of findings name a path
// too), so claims never refuses: what it proves prints CLAIM-OK, and each fact it cannot verify prints one named
// warning, UNVERIFIABLE with the path or SHA, its line in the report and the reason, then the count of warnings; the
// exit is 0 (2 only for a usage error or an unreadable report). The word accuses no one.
// Layer: ops-tools command; docs/ops/PROCESS-REGISTER.md. Node builtins only.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const config = require('./lib/config.cjs');
const lib = require('./lib/discipline.cjs');
const { seatEnvironment } = require('../lib/seat-heavy.cjs');
const { headerOf } = require('../lib/review-facts.cjs');
const { readFileGuarded } = require('../lib/path-safe.cjs');
const textSafe = require('../lib/text-safe.cjs');
const seatPolicy = require('../lib/seat-policy.cjs');

const fail = (code, detail) => { throw Object.assign(new Error(detail || code), { code }); };
const SHA = /^[a-f0-9]{40}$/;
const SHA40 = /(?<![0-9a-fA-F])[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const REPORT = /^(?:[A-Za-z0-9][A-Za-z0-9._-]*\/)*[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const reportPath = rel => typeof rel === 'string' && rel.length <= 512 && REPORT.test(rel) && !rel.split('/').some(s => s === '.' || s === '..');

function gitIn(root) {
  return args => {
    const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, timeout: 3000, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    if (r.error || r.status !== 0) fail('DISCIPLINE-GIT');
    return String(r.stdout).trim();
  };
}
function context(args, deps) {
  const env = deps.env || process.env;
  const root = path.resolve(args['--root'] || process.cwd());
  const cfg = deps.config || config.load({ root, env });
  const s = lib.settings(cfg.config.discipline);
  const rawNow = args['--now'];
  const nowMs = rawNow === undefined ? (deps.now ? deps.now() : Date.now()) : lib.isoMs(rawNow);
  if (!Number.isFinite(nowMs)) fail('DISCIPLINE-NOW-INVALID');
  const seatTotal = deps.seatTotal !== undefined ? deps.seatTotal : () => {
    const read = seatPolicy.readPolicy(seatPolicy.canonicalFile(cfg.main), { now: nowMs });
    if (!read.ok) fail(read.code);
    return read.policy.total;
  };
  return { env, root, cfg, s, nowMs, seatTotal, io: deps.io || fs, git: deps.git || gitIn(root) };
}
// The first moment a tick saw each ready row (read-only here; tick keeps it).
function readySeen(ctx) {
  try {
    const state = readState(path.join(lib.inside(ctx.cfg.workRoot, ctx.s.stateDir), 'state.json'), ctx.io);
    return new Map(Object.entries(state.readySeen || {}).map(([item, at]) => [item, lib.isoMs(at)]).filter(([, ms]) => ms !== null && ms <= ctx.nowMs));
  } catch { return new Map(); }
}
function evaluateNow(ctx, deps) {
  const pulse = ctx.cfg.config.pulse || {};
  const input = lib.acquire({ runtime: ctx.cfg.runtimeDir, mainRoot: ctx.cfg.main, workRoot: ctx.cfg.workRoot, settings: ctx.s, nowMs: ctx.nowMs, io: ctx.io, git: ctx.git,
    kill: deps.kill, seatTotal: ctx.seatTotal, maxAgeMs: ctx.cfg.seat && ctx.cfg.seat.maxAgeMs, lineRef: ctx.cfg.author && ctx.cfg.author.baseRef,
    resultsDir: pulse.resultsDir, queueDir: pulse.queueDir, readySeen: readySeen(ctx) });
  return { input, ...lib.evaluate(input, ctx.nowMs, ctx.s) };
}

// The pulse section of the guards: [] while the config carries no discipline section.
function pulseLines(cfg, nowMs, deps = {}) {
  if (cfg.config.discipline === undefined) return [];
  try {
    const ctx = { ...context({ '--root': cfg.root }, { ...deps, config: cfg, now: () => nowMs }), nowMs };
    return evaluateNow(ctx, deps).lines;
  } catch (e) {
    return [`discipline guards UNREADABLE: ${lib.flat(e.code || 'INVALID')} (run node .ai/bin/ops-tools/discipline.cjs lines)`];
  }
}

// ---- tick: state, owner channel, restart ----
// The state of the earlier ticks; a field of the wrong shape is rebuilt from this pass and named.
function readState(file, io) {
  const empty = { schema: 'discipline-state/1', ownerIdleAt: null, restartAt: null, deferralNotices: {}, readySeen: {} };
  const plain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  let data;
  try { data = textSafe.parseJsonUnique(lib.readLeaf(file, io)); } catch (e) { return e.code === 'ENOENT' ? empty : { ...empty, unreadable: true }; }
  if (!plain(data) || data.schema !== 'discipline-state/1') return { ...empty, unreadable: true };
  const time = v => (v === null || v === undefined || lib.isoMs(v) !== null ? v ?? null : undefined);
  const state = { schema: data.schema, ownerIdleAt: time(data.ownerIdleAt), restartAt: time(data.restartAt),
    deferralNotices: plain(data.deferralNotices) ? { ...data.deferralNotices } : undefined, readySeen: plain(data.readySeen) ? { ...data.readySeen } : undefined };
  const bad = Object.keys(state).filter(k => state[k] === undefined);
  for (const k of bad) state[k] = empty[k];
  return bad.length ? { ...state, unreadable: true } : state;
}
function writeAtomic(file, text, io) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  io.writeFileSync(tmp, text, { encoding: 'utf8', flag: 'wx' });
  io.renameSync(tmp, file);
}
// One tick at a time holds the side effects (the owner messages, the restart, the state). The holds are a chain of
// numbered locks tick-N.lock, each made by an exclusive create. A pass takes the number after the newest lock only
// while that one is released or left (older than ten minutes: a pass takes under two seconds), so of the passes that
// found the same newest lock at most one takes the next number. The newest lock always stays: a release marks it old,
// and only the pass that took the next number removes the ones below it. A pass delayed between its listing and its
// create that finds a newer number than its own holds nothing. A newest lock that is gone, unreadable or a link holds.
const LOCK_STALE_MS = 10 * 60000;
const tickLocks = (stateDir, io) => io.readdirSync(stateDir).map(n => /^tick-([0-9]{1,9})\.lock$/.exec(n)).filter(Boolean)
  .map(m => Number(m[1])).sort((a, b) => a - b);
function holdTick(stateDir, io) {
  const before = tickLocks(stateDir, io);
  const last = before.length ? before[before.length - 1] : 0;
  if (last) {
    let st;
    try { st = lib.leaf(path.join(stateDir, `tick-${last}.lock`), io); } catch { return null; }
    if (Math.abs(Date.now() - st.mtimeMs) < LOCK_STALE_MS) return null;
  }
  const file = path.join(stateDir, `tick-${last + 1}.lock`);
  let fd;
  try { fd = io.openSync(file, 'wx'); } catch (e) { if (e.code === 'EEXIST') return null; throw e; }
  try { io.writeSync(fd, String(process.pid)); } finally { io.closeSync(fd); }
  if (tickLocks(stateDir, io).some(n => n > last + 1)) { try { io.unlinkSync(file); } catch { /* gone */ } return null; }
  for (const n of before) try { io.unlinkSync(path.join(stateDir, `tick-${n}.lock`)); } catch { /* removed by another pass */ }
  return { file };
}
function releaseTick(lock, io) {
  try { io.utimesSync(lock.file, 0, 0); } catch { /* taken over as left: nothing to release */ }
}
function ownerAlive(ctx) {
  const o = ctx.s.owner;
  if (o.outboxDir === null || o.aliveFile === null) return { alive: false, why: 'not configured' };
  try {
    const st = ctx.io.statSync(lib.inside(ctx.cfg.workRoot, o.aliveFile));
    const age = ctx.nowMs - st.mtimeMs;
    return age <= o.aliveMinutes * 60000 && age >= -60000 ? { alive: true } : { alive: false, why: `alive file ${Math.floor(age / 60000)} min old` };
  } catch { return { alive: false, why: 'no alive file' }; }
}
// The owner messages of this pass (Russian: the owner channel speaks the owner's language).
function ownerMessages(result, state, ctx) {
  const o = ctx.s.owner, now = ctx.nowMs, out = [];
  const idle = result.idle;
  const last = lib.isoMs(state.ownerIdleAt);
  const gap = last === null ? Infinity : now - last;
  if (idle.alarm && (idle.night ? gap >= o.nightRepeatMinutes * 60000 : idle.idleMinutes >= o.dayMinutes && gap >= o.dayMinutes * 60000)) {
    out.push({ kind: 'idle', key: null, text: `IDLE-ALARM: готовая работа ждёт ${idle.idleMinutes} мин, свободных мест ${idle.free}. Пункты: ${idle.items.slice(0, 5).map(i => lib.flat(i.item)).join(', ')}.` });
  }
  for (const r of result.input.deferrals.open || []) {
    if (r.ownerHeld || now - r.deadlineMs <= o.deferralOverdueMinutes * 60000) continue;
    const key = `${r.item}|${r.deadline}|${r.at}`;
    if (state.deferralNotices[key]) continue;
    out.push({ kind: 'deferral', key, text: `DEFERRAL-OVERDUE: ${lib.flat(r.item)} просрочен на ${Math.floor((now - r.deadlineMs) / 3600000)} ч (срок ${r.deadline}). Причина: ${lib.flat(r.reason)}. Триггер: ${lib.flat(r.trigger)}.` });
  }
  return out;
}
function restartDecision(result, state, ctx) {
  const op = ctx.s.operator;
  if (!result.quiet.silent) return { run: false, line: null };
  if (seatEnvironment(ctx.env)) return { run: false, line: 'operator restart: refused in a seat environment' };
  if (op.restart === null) return { run: false, line: 'operator restart: not declared (discipline.operator.restart in the local config)' };
  const last = lib.isoMs(state.restartAt);
  if (last !== null && ctx.nowMs - last < op.cooldownMinutes * 60000) return { run: false, line: `operator restart: cooldown (last ${state.restartAt})` };
  return { run: true, line: null };
}
function restart(ctx, deps, stateDir) {
  const argv = ctx.s.operator.restart;
  const script = lib.inside(ctx.cfg.workRoot, argv[argv.length - 1]);
  if (!ctx.io.existsSync(script)) return { ok: false, line: `operator restart: declared script absent ${lib.flat(argv[argv.length - 1])}` };
  // The restarts are a chain of numbered tokens holding their time. A tick takes the next number by an exclusive
  // create only while the newest token is outside the cooldown, so two ticks that read the state before either
  // wrote it start one loop, whatever their clocks: the second finds the number taken or the new token too recent.
  const cooldown = ctx.s.operator.cooldownMinutes * 60000;
  ctx.io.mkdirSync(stateDir, { recursive: true });
  const numbers = ctx.io.readdirSync(stateDir).map(n => /^restart-seq-([0-9]{1,9})\.token$/.exec(n)).filter(Boolean).map(m => Number(m[1]));
  const last = numbers.length ? Math.max(...numbers) : 0;
  if (last) {
    const token = path.join(stateDir, `restart-seq-${last}.token`);
    let at = null;
    // A token that cannot be read leaves the last restart unknown: no restart until it can be read (one removed
    // meanwhile is no token).
    try { at = lib.isoMs(lib.readLeaf(token, ctx.io).trim()) ?? ctx.io.lstatSync(token).mtimeMs; } catch (e) {
      if (e.code !== 'ENOENT') return { ok: false, line: `operator restart: the newest restart token is unreadable (${lib.flat(e.code || 'INVALID')}); not restarted` };
    }
    if (at !== null && Math.abs(ctx.nowMs - at) < cooldown) return { ok: false, line: 'operator restart: already started within the cooldown' };
  }
  let fd;
  try { fd = ctx.io.openSync(path.join(stateDir, `restart-seq-${last + 1}.token`), 'wx'); }
  catch (e) { if (e.code === 'EEXIST') return { ok: false, line: 'operator restart: already started within the cooldown' }; throw e; }
  try { ctx.io.writeSync(fd, new Date(ctx.nowMs).toISOString()); } finally { ctx.io.closeSync(fd); }
  const logName = `restart-${new Date(ctx.nowMs).toISOString().replace(/[-:.]/g, '')}-${crypto.randomBytes(4).toString('hex')}.log`;
  const log = ctx.io.openSync(path.join(stateDir, logName), 'wx');
  let child = null, error = null;
  try {
    child = (deps.spawn || spawn)(argv[0], [...argv.slice(1, -1), script], { cwd: ctx.cfg.workRoot, detached: true, windowsHide: true, stdio: ['ignore', log, log] });
  } catch (e) { error = e.code || 'SPAWN'; } finally { ctx.io.closeSync(log); }
  // A command that cannot start (absent from the PATH, a launcher removed) gets no pid and reports its error
  // later: it is a failed restart, never a started loop. The token stays spent, so the next try waits the cooldown.
  if (child && typeof child.on === 'function') child.on('error', () => {});
  if (!child || !Number.isSafeInteger(child.pid)) {
    return { ok: false, line: `operator restart: FAILED to start ${lib.flat(argv.join(' '))} (${lib.flat(error || 'no process')}; log ${logName}); next try after the cooldown` };
  }
  if (typeof child.unref === 'function') child.unref();
  return { ok: true, pid: child.pid, line: `OPERATOR-RESTART started pid=${child.pid} command ${lib.flat(argv.join(' '))}` };
}
function tick(ctx, deps) {
  const started = Date.now();
  const result = evaluateNow(ctx, deps);
  const stateDir = lib.inside(ctx.cfg.workRoot, ctx.s.stateDir);
  ctx.io.mkdirSync(stateDir, { recursive: true });
  const lock = holdTick(stateDir, ctx.io);
  if (!lock) return [...result.lines, 'discipline tick: another tick holds the state; this pass sends nothing and restarts nothing'];
  try { return sideEffects(ctx, deps, result, stateDir, started); } finally { releaseTick(lock, ctx.io); }
}
function sideEffects(ctx, deps, result, stateDir, started) {
  const stateFile = path.join(stateDir, 'state.json');
  const state = readState(stateFile, ctx.io);
  const lines = [...result.lines];
  if (state.unreadable) lines.push('discipline state UNREADABLE: rebuilt from this pass');
  const channel = ownerAlive(ctx);
  const messages = ownerMessages(result, state, ctx);
  const stamp = new Date(ctx.nowMs).toISOString().replace(/[-:.]/g, '');
  if (messages.length && !channel.alive) lines.push(`owner channel: not alive (${channel.why}); ${messages.length} alarm(s) kept in the pulse`);
  if (channel.alive) {
    const outbox = lib.inside(ctx.cfg.workRoot, ctx.s.owner.outboxDir);
    ctx.io.mkdirSync(outbox, { recursive: true });
    messages.forEach((m, i) => {
      writeAtomic(path.join(outbox, `${stamp}-${i}-discipline-${m.kind}.txt`), `${m.text}\n`, ctx.io);
      if (m.kind === 'idle') state.ownerIdleAt = new Date(ctx.nowMs).toISOString();
      else state.deferralNotices[m.key] = new Date(ctx.nowMs).toISOString();
      lines.push(`owner channel: sent ${m.kind}`);
    });
  }
  const decision = restartDecision(result, state, ctx);
  if (decision.line) lines.push(decision.line);
  if (decision.run) {
    const r = restart(ctx, deps, stateDir);
    lines.push(r.line);
    if (r.ok) state.restartAt = new Date(ctx.nowMs).toISOString();
  }
  // The first moment a pass saw each ready row: kept while the row stays ready work.
  const seenBefore = state.readySeen && typeof state.readySeen === 'object' ? state.readySeen : {};
  state.readySeen = Object.fromEntries(result.idle.items.filter(i => i.from === 'candidate').slice(0, 200)
    .map(i => [i.item, lib.isoMs(seenBefore[i.item]) !== null ? seenBefore[i.item] : new Date(ctx.nowMs).toISOString()]));
  // The state keeps the notices of the last 14 days only.
  for (const [key, at] of Object.entries(state.deferralNotices)) if (ctx.nowMs - (lib.isoMs(at) || 0) > 14 * 86400000) delete state.deferralNotices[key];
  delete state.unreadable;
  writeAtomic(stateFile, `${JSON.stringify(state, null, 2)}\n`, ctx.io);
  const ms = Date.now() - started, rss = Math.round(process.memoryUsage().rss / 1048576);
  const over = ms > ctx.s.budget.ms || rss > ctx.s.budget.rssMB;
  lines.push(`discipline pass: ms=${ms} rssMB=${rss}${over ? ` OVER BUDGET (limit ${ctx.s.budget.ms} ms, ${ctx.s.budget.rssMB} MB)` : ''}`);
  return lines;
}

// ---- defer: one row of the deferral journal ----
function defer(ctx, args) {
  const row = { schema: 'deferral/1', at: new Date(ctx.nowMs).toISOString(), item: args['--item'], state: args['--state'] || 'deferred' };
  if (row.state === 'deferred') Object.assign(row, { reason: args['--reason'], trigger: args['--trigger'], deadline: args['--deadline'] === undefined ? null : args['--deadline'] });
  if (!lib.deferralRow(row)) fail('DISCIPLINE-DEFER-INVALID', 'item, reason, trigger and an ISO deadline (none only for an owner trigger) are required');
  if (ctx.s.deferral.path === null) fail('DISCIPLINE-DEFER-UNCONFIGURED');
  const file = lib.inside(ctx.cfg.workRoot, ctx.s.deferral.path);
  ctx.io.mkdirSync(path.dirname(file), { recursive: true });
  ctx.io.appendFileSync(file, `${JSON.stringify(row)}\n`, 'utf8');
  return [`DEFERRAL recorded ${lib.flat(row.item)} state=${row.state}${row.deadline ? ` deadline=${row.deadline}` : ''}`];
}

// ---- claims: the exact facts of a finished seat ----
// The report is read as its own prose (lib ownProse: the CommonMark blocks it states itself, never code, an HTML
// block or a quote). The Reviewed commit fields are those of the shared review reader: a line "Reviewed commit[ SHA]:
// value" after any list marks, or a table row whose cell is that label, with compatibility forms folded and format
// characters, emphasis and code marks dropped.
const REVIEWED_LINE = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)*Reviewed[ \t]+commit(?:[ \t]+SHA)?[ \t]*:[ \t]*(.*)$/i;
const REVIEWED_CELL = /^Reviewed[ \t]+commit(?:[ \t]+SHA)?[ \t]*:?$/i;
function reviewedFields(header) {
  const values = [];
  for (const line of header.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[^\S\n]/g, ' ').replace(/[*_`]/g, '').split('\n')) {
    const field = REVIEWED_LINE.exec(line);
    if (field) { values.push(field[1].trim()); continue; }
    const cells = line.includes('|') ? line.split('|').map(c => c.trim()) : [];
    const at = cells.findIndex(c => REVIEWED_CELL.test(c));
    if (at >= 0) values.push(cells.slice(at + 1).filter(Boolean).join(' '));
  }
  return values;
}
// A JSON path token; it may end a sentence (a full stop after it is no part of it), and the extension is any case.
const RECEIPT_PATH = /(?<![A-Za-z0-9._/\\:-])((?:[A-Za-z]:)?[\\/]?(?:[A-Za-z0-9][A-Za-z0-9._-]*[\\/])*[A-Za-z0-9][A-Za-z0-9._-]{0,159}\.json)(?![A-Za-z0-9_-]|\.[A-Za-z0-9_-])/gi;
function claims(args, deps) {
  const worktree = path.resolve(args['--worktree'] || '');
  const rel = args['--report'];
  if (!args['--worktree'] || !reportPath(rel)) fail('DISCIPLINE-USAGE');
  const git = deps.git || gitIn(worktree);
  const expected = args['--sha'] === undefined ? git(['rev-parse', 'HEAD']) : args['--sha'];
  if (!SHA.test(expected)) fail('DISCIPLINE-SHA-INVALID');
  const got = readFileGuarded(worktree, path.join(worktree, rel), { maxBytes: 8 * 1024 * 1024, refuseHardlinks: true });
  if (!got.ok) fail('DISCIPLINE-REPORT-UNREADABLE');
  const decoded = textSafe.decode(got.bytes, { bom: 'strip', crlf: 'normalise' });
  if (!decoded.ok) fail('DISCIPLINE-REPORT-UNREADABLE');
  const prose = lib.ownProse(decoded.text);
  const out = [];
  // Every Reviewed commit field of the header and every full SHA in it: each should be a commit of this repository
  // and the expected one (beyond 32 SHAs the rest is named, not checked).
  const fields = reviewedFields(headerOf(prose.lines.join('\n')));
  const all = [...new Set(fields.flatMap(v => (v.match(SHA40) || []).map(s => s.toLowerCase())))];
  const tokens = all.slice(0, 32);
  const source = decoded.text.split('\n');
  const lineOf = sha => source.findIndex(l => l.toLowerCase().includes(sha)) + 1 || 'unknown';
  if (!tokens.length) out.push('UNVERIFIABLE header-sha: no Reviewed commit SHA in the header');
  for (const sha of tokens) {
    let kind = null;
    try { kind = git(['cat-file', '-t', sha]); } catch { kind = null; }
    if (kind !== 'commit') out.push(`UNVERIFIABLE header-sha-unknown: ${sha} line ${lineOf(sha)}: not a commit of this repository`);
    else if (sha !== expected) out.push(`UNVERIFIABLE header-sha-mismatch: ${sha} line ${lineOf(sha)}: expected ${expected}`);
    else out.push(`CLAIM-OK header-sha ${sha}`);
  }
  if (all.length > tokens.length) out.push(`UNVERIFIABLE header-sha-many: ${all.length} SHAs in the Reviewed commit fields, the first ${tokens.length} checked`);
  if (fields.length > 1) out.push(`UNVERIFIABLE header-sha-fields: ${fields.length} Reviewed commit fields in the header`);
  else if (tokens.length && fields[0].trim().toLowerCase() !== tokens[0]) out.push('UNVERIFIABLE header-sha-text: text after the SHA on the Reviewed commit line');
  // A receipt path is a path in the receipt root (absolute, or from the root's own folder name) in any own block of the
  // report: one that is no file there is a warning at its first line, whatever the words of its block say. Any other
  // JSON name counts only when the receipt root holds it. A block that names no receipt path claims no receipt.
  const receiptRoot = path.resolve(deps.receiptRoot || (deps.config || config.load({ root: worktree, env: deps.env || process.env })).receiptRoot);
  const fold = p => { const f = p.split(path.sep).join('/').replace(/\/+$/, ''); return process.platform === 'win32' ? f.toLowerCase() : f; };
  const rootKey = fold(receiptRoot);
  const named = new Map(); // rel -> { anchored, line }
  for (const [i, block] of prose.blocks.entries()) {
    for (const m of block.matchAll(RECEIPT_PATH)) {
      const raw = m[1].replace(/\\/g, '/');
      let rel = null, anchored = false;
      if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
        const key = fold(path.resolve(raw));
        if (key.startsWith(`${rootKey}/`)) { rel = path.resolve(raw).slice(receiptRoot.length + 1).split(path.sep).join('/'); anchored = true; }
      } else if (fold(raw).startsWith(`${fold(path.basename(receiptRoot))}/`)) { rel = raw.slice(path.basename(receiptRoot).length + 1); anchored = true; }
      else rel = raw;
      if (rel === null || rel.split('/').some(s => s === '.' || s === '..' || !s)) continue;
      const seen = named.get(rel), line = lib.lineAt(prose.places[i], m.index);
      if (!seen || (anchored && !seen.anchored)) named.set(rel, { anchored, line });
    }
  }
  const counted = [];
  for (const [rel, { anchored, line }] of [...named].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    let ok = false;
    try { const real = lib.inside(receiptRoot, rel); ok = fs.lstatSync(real).isFile(); } catch { ok = false; }
    if (ok) { counted.push(rel); out.push(`CLAIM-OK receipt ${lib.flat(rel)}`); }
    else if (anchored) { counted.push(rel); out.push(`UNVERIFIABLE receipt-missing: ${lib.flat(rel)} line ${line}: no file of this name in the receipt root`); }
  }
  const runClaim = /\b(?:author-check|protocol-test\.cjs|full suite)\b[^\n]*\b(?:PASS|passed|green|exit 0|ok=true)\b/i;
  if (!counted.length && prose.blocks.some(l => runClaim.test(l))) out.push('UNVERIFIABLE run-claim: a run is claimed and no receipt is named');
  out.push(`claims warnings: ${out.filter(l => l.startsWith('UNVERIFIABLE ')).length}`);
  return out;
}

function parse(argv) {
  const [command, ...rest] = argv;
  const keys = { lines: ['--root', '--now'], tick: ['--root', '--now'], defer: ['--root', '--now', '--item', '--reason', '--trigger', '--deadline', '--state'],
    claims: ['--worktree', '--report', '--sha'] }[command];
  if (!keys) fail('DISCIPLINE-USAGE');
  const args = {};
  for (let i = 0; i < rest.length; i++) {
    if (!keys.includes(rest[i]) || args[rest[i]] !== undefined || rest[i + 1] === undefined || rest[i + 1].startsWith('--')) fail('DISCIPLINE-USAGE');
    args[rest[i]] = rest[++i];
  }
  return { command, args };
}
function main(argv, deps = {}) {
  const stdout = deps.stdout || (s => process.stdout.write(s));
  const stderr = deps.stderr || (s => process.stderr.write(s));
  try {
    if (argv[0] === '--help' || !argv.length) { stdout('usage: discipline.cjs lines|tick [--root DIR] [--now ISO] | defer --item I --reason R --trigger T [--deadline ISO] [--state S] | claims --worktree DIR --report REPORT [--sha SHA]\n'); return argv.length ? 0 : 2; }
    const { command, args } = parse(argv);
    if (command === 'claims') {
      stdout(`${claims(args, deps).join('\n')}\n`);
      return 0;
    }
    const ctx = context(args, deps);
    const lines = command === 'lines' ? evaluateNow(ctx, deps).lines : command === 'tick' ? tick(ctx, deps) : defer(ctx, args);
    stdout(`${lines.join('\n')}\n`);
    return 0;
  } catch (e) { stderr(`${lib.flat(e.code && /^DISCIPLINE-|^SEAT-POLICY/.test(e.code) ? e.code : e.message)}\n`); return 2; }
}

module.exports = { pulseLines, tick, defer, claims, ownerMessages, restartDecision, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

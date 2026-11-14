'use strict';
// route-gate.cjs - the route step of the launch gate (guarantee K4;
// K5 and K9 as PROTO-DEC-0236 closed them).
//
// checkRoute({ routeId, client, model, now, override }, deps) decides whether a launch may start on its
// ROUTE-STATE row. It is the FIRST step of EVERY docs/ops/launch-wrapper.cjs run (PROTO-DEC-0240 item 1),
// before the quota hook, the work root, the claim, the ops-guard gate, the launch directory, the running
// and terminal records and the child. It writes nothing: no record, no claim, no file. Its only side
// effect is a live probe of the route state (probe.cjs runProbe, 150 s; one 300 s retry on TIMEOUT) when
// the record holds no fresh probe; that probe works in its own root (probeRootFor). The wrapper refuses a
// probe root inside any launch root (probeRootProblem) BEFORE it calls checkRoute, for every launch, and
// runs checkRoute with the OS temp of its process set to that root (PROTO-DEC-0240 item 3).
//
// The route of a launch (PROTO-DEC-0240 items 1 and 2):
//   named    --route-state ID: the row with that id; a client or model of the launch that is not the
//            row's own is ROUTE_MISMATCH (never overridable)
//   derived  no --route-state: deriveRoutes, the rows whose client AND model are exactly the launch's.
//            The rows are the data; this file holds no table of clients or models. One row is the route;
//            two or more are ROUTE_AMBIGUOUS (never overridable: fix the record)
//   none     no row matches: while the record does not carry coverage.complete === true the launch is
//            admitted as a TRANSITION, with a decision record naming the missing route; once the operator
//            records coverage complete, the same launch is ROUTE_UNKNOWN
//
// Nothing here reads the record or runs a probe on its own: the record is read only through the strict
// reader of the route state (route-state.cjs loadRecord, stateOf), the probe is only probe.cjs runProbe and the
// scarce clients are only probe.isScarce. A probe result is cached in the record only by refresh.cjs;
// the gate reuses a fresh ok probe of the record and never writes one.
//
// The time is an explicit input (`now`, an ISO instant). The record file and the probe dependencies come
// from `deps` for the tests only; production reads docs/ops/route-state.json and runs the real probe.
//
// The decision, in this order:
//   ROUTE_RECORD_REFUSED:<code>  the strict reader refused the record (overridable)
//   ROUTE_UNKNOWN                 no row with this id, or no row for the client and model while the
//                                 coverage is recorded complete (never overridable: add the row first)
//   ROUTE_MISMATCH                the named row has another client or model than the launch (never)
//   ROUTE_AMBIGUOUS               two rows share the client and model of the launch (never)
//   ROUTE_FAILED                  the record holds a fresh probe that is not ok (never overridable)
//   ROUTE_STALE                   a required declared field is missing, expired or dated in the future
//                                 (overridable; refused before any probe)
//   ROUTE_SCARCE_UNKNOWN          a scarce route (claude, codex) without a fresh declared limit; such a
//                                 route is never probed by the gate (K9; overridable)
//   ROUTE_NO_PROBE                the client has no row in the probe table (overridable)
//   ROUTE_PROBE_ROOT              the probe root is unusable or inside a launch root (the wrapper's refusal,
//                                 before this function; never overridable)
//   ROUTE_ARGS_REFUSED            the child command states --client or --model twice, without a value or in
//                                 another spelling (launchIdentity; the wrapper's refusal; never overridable)
//   ENTRY_FORM_REFUSED            the child command lies outside the closed entry grammar of a seat launcher and
//                                 cannot be shown not to run one (launchEntry; the wrapper's refusal; never overridable)
//   ROUTE_PROBE_FAILED:<reason>   the live probe failed, timed out or gave no answer (never overridable)
//   ROUTE_GATE_ERROR              the step itself threw (the wrapper refuses; never overridable)
// An override is an owner act (the declare grammar of declare.cjs) given by --route-override. It applies
// only to the overridable reasons and is returned in the record of the decision, which the wrapper
// prints and writes into the running and terminal records of the launch. There is no other bypass.
// A transition is not an override: it is recorded with decision=transition, and an override given with
// it is kept with applied=false.

const fs = require('node:fs');
const path = require('node:path');
const rs = require('./route-state.cjs');
const probe = require('./probe.cjs');
// The one reader of the client and model of a launch (split and equals forms; a repeat, a missing value or another
// spelling is refused with a named reason). It lives in seat-failover, which the seat launchers and the switch use;
// the wrapper reaches it through this module, so the wrapper's own require closure stays as it was.
const seat = require('../../docs/ops/seat-failover.cjs');
const launchIdentity = seat.identity;

const SCHEMA = 'route-gate/1';
const REASONS = Object.freeze([
  'ROUTE_RECORD_REFUSED',
  'ROUTE_UNKNOWN',
  'ROUTE_MISMATCH',
  'ROUTE_AMBIGUOUS',
  'ROUTE_FAILED',
  'ROUTE_STALE',
  'ROUTE_SCARCE_UNKNOWN',
  'ROUTE_NO_PROBE',
  'ROUTE_PROBE_ROOT',
  'ROUTE_ARGS_REFUSED',
  'ENTRY_FORM_REFUSED',
  'ROUTE_PROBE_FAILED',
  'ROUTE_GATE_ERROR',
]);
const OVERRIDABLE = Object.freeze(['ROUTE_RECORD_REFUSED', 'ROUTE_STALE', 'ROUTE_SCARCE_UNKNOWN', 'ROUTE_NO_PROBE']);
const ROUTE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// -> null when the override may be recorded, else the reason it is refused (a usage error of the caller).
function overrideProblem(value) {
  if (value === undefined || value === null) return null;
  return rs.ownerActProblem(value);
}

// -> null when the route id may be looked up, else the usage problem.
function routeIdProblem(value) {
  if (typeof value !== 'string' || !ROUTE_ID_RE.test(value)) return '--route-state must be a route id of docs/ops/route-state.json (a-z, 0-9 and -, at most 64)';
  return null;
}

const refused = (code, detail, extra = {}) => ({ code, detail, overridable: OVERRIDABLE.includes(code), ...extra });
// A launch value as it may appear in a printed line and a detail: visible ASCII only, bounded; absent is (none).
const shown = value => (value === undefined || value === null ? '(none)' : String(value).replace(/[^\x21-\x7e]/g, '?').slice(0, 120));

// The one derivation of the route of a launch (PROTO-DEC-0240 item 1): the rows of the record whose client
// AND model are exactly the client and model of the launch. The record is the only table.
function deriveRoutes(record, client, model) {
  if (typeof client !== 'string' || typeof model !== 'string') return [];
  return record.routes.filter(route => route.client === client && route.model === model);
}

// -> { route, via } | { problem } | { transition } for a record the strict reader accepted.
function resolveRoute(record, { routeId, client, model }) {
  const has = value => value !== undefined && value !== null;
  if (has(routeId)) {
    const route = record.routes.find(item => item.id === routeId);
    if (!route) return { problem: refused('ROUTE_UNKNOWN', `no route with id ${routeId}`) };
    const wrong = [];
    if (has(client) && client !== route.client) wrong.push(`client ${shown(client)} is not ${route.client}`);
    if (has(model) && model !== route.model) wrong.push(`model ${shown(model)} is not ${route.model}`);
    if (wrong.length) return { problem: refused('ROUTE_MISMATCH', `route ${routeId}: ${wrong.join('; ')}`) };
    return { route, via: 'named' };
  }
  const found = deriveRoutes(record, client, model);
  if (found.length > 1) return { problem: refused('ROUTE_AMBIGUOUS', `routes ${found.map(r => r.id).join(',')} share client ${shown(client)} and model ${shown(model)}`) };
  if (found.length === 1) return { route: found[0], via: 'derived' };
  const missing = `client=${shown(client)} model=${shown(model)}`;
  if (record.coverage && record.coverage.complete === true) {
    return { problem: refused('ROUTE_UNKNOWN', `no route has ${missing}; coverage was recorded complete by ${record.coverage.recordedBy}`) };
  }
  return { transition: missing };
}

// The probe root of a launch: the resolved probe temp of probe.cjs (OK_PROBE_TEMP, else its default).
const probeRootFor = env => probe.resolveProbeTemp(env || process.env);

// PROTO-DEC-0240 item 3: -> null when the probe may work in root, else the named cause. The root passes the
// probe's own rule (drive D, outside this repository) and lies inside none of the launch roots; an
// unresolved launch root (not a non-empty string) is a refusal, never a pass.
function probeRootProblem(root, launchRoots) {
  const own = probe.tempRootProblem(root);
  if (own) return own;
  const real = probe.realOf(path.resolve(root));
  for (const launchRoot of launchRoots) {
    if (typeof launchRoot !== 'string' || !launchRoot) return 'a launch root is unresolved, so the probe root cannot be shown to lie outside it';
    if (probe.inside(probe.realOf(path.resolve(launchRoot)), real)) {
      return `the probe root ${shown(root)} is inside the launch root ${shown(launchRoot)}; set ${probe.PROBE_TEMP_ENV} to a directory on drive D outside it`;
    }
  }
  return null;
}

// THE scratch of every read before a client starts (PROTO-DEC-0240 item 3). The
// route step of the wrapper and every route decision of seat-failover (the early check of a launcher run, the spawn point, the
// switch) read the route record, and the wrapper reads the input of a launcher, only inside this function: it takes the probe root
// (given, else probeRootFor), refuses it when probeRootProblem names a cause, creates it and runs fn with TEMP, TMP and TMPDIR of
// this process set to it, so a private helper compile of the shared strict reader on Windows (.ai/bin/lib/read-handle.cjs;
// a warm verified cache compiles nothing and lives in the user profile) and the sandbox of a live probe land there:
// never in the OS temp of the launch, never under a launch root. The variables are
// restored after fn. -> { root, value } or { problem }
const TEMP_KEYS = ['TEMP', 'TMP', 'TMPDIR'];
function inProbeRoot({ env, root, launchRoots }, fn) {
  const probeRoot = root || probeRootFor(env);
  const bad = probeRootProblem(probeRoot, launchRoots);
  if (bad) return { problem: bad };
  // created only when absent: an existing probe root is used as it is
  try { if (!fs.existsSync(probeRoot)) fs.mkdirSync(probeRoot, { recursive: true }); } catch (e) { return { problem: `the probe root cannot be created (${(e && e.code) || 'error'})` }; }
  const saved = TEMP_KEYS.map(k => [k, process.env[k]]);
  try {
    for (const k of TEMP_KEYS) process.env[k] = probeRoot;
    return { root: probeRoot, value: fn(probeRoot) };
  } finally {
    for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
}

// THE entry form of a child command (PROTO-DEC-0240 item 1, K4). A seat launcher
// is a script that starts a client through the one spawn point (seat-failover spawnClient): cert-launch, fix-launch and the
// operator's run-client. The wrapper runs one only in the closed grammar
//   NODE [--no-warnings | --require VALUE | -r VALUE | --require=VALUE]... [--] SCRIPT ARGS...
// NODE is a node executable (named node or node.exe in any case, or the executable of this process). SCRIPT is resolved against the
// working directory of the child by its real path (links, case) and its name is compared with the launcher names without regard to
// case. An inline program (-e, --eval, -p or --print with its code) has no script. The command is
//   a launcher       { launcher, client, model }: the pair the launcher starts first (cert and fix: its arguments read by the one
//                    reader, the default pair of a fix launch included; run-client: the route of its contract input)
//   not a launcher   { launcher: null, client, model }: the pair the command states (the one reader; undefined when not stated)
//   refused          { code, problem }: ENTRY_FORM_REFUSED when the command cannot be shown NOT to run a launcher: a Node option
//                    outside the list before the script, an option without its value, no script, a script that is not an
//                    existing file, launcher arguments outside the launcher's own grammar, or a launcher named anywhere outside
//                    the script position (another interpreter, a shell line, an option value, an inline program);
//                    ROUTE_ARGS_REFUSED when the pair itself is malformed (the refusal of the one reader).
// A script that is not a launcher and starts one itself stays an opaque program: the spawn point decides inside it.
const LAUNCHERS = Object.freeze({ 'cert-launch.cjs': 'cert', 'fix-launch.cjs': 'fix', 'run-client.cjs': 'run-client' });
const NODE_FLAGS = new Set(['--no-warnings']);
const NODE_VALUED = new Set(['--require', '-r']);
const NODE_INLINE = new Set(['-e', '--eval', '-p', '--print']);
const VISIBLE = /^[\x21-\x7e]+$/;
// the one comparison of a launcher name: either slash, any case
const fold = text => String(text).replace(/\\/g, '/').toLowerCase();
const launcherNamed = text => Object.keys(LAUNCHERS).find(name => fold(text).includes(name)) || null;
function realFile(file) {
  try { const real = fs.realpathSync.native(file); return fs.statSync(real).isFile() ? real : null; } catch { return null; }
}
const kindOf = real => (real ? LAUNCHERS[path.basename(fold(real))] || null : null);
// A launcher a token names: by its name in the text, or by the real path of a word that is an existing file (a short name)
function tokenLauncher(token, cwd) {
  const named = launcherNamed(token);
  if (named) return named;
  for (const word of token.split(/[\s"'=,;]+/)) {
    if (!/\.cjs$/i.test(word)) continue;
    const real = realFile(path.resolve(cwd, word));
    if (kindOf(real)) return path.basename(fold(real));
  }
  return null;
}
function launcherPair(kind, args, cwd) {
  const refuse = problem => ({ code: 'ENTRY_FORM_REFUSED', problem });
  if (kind === 'run-client') {
    if (args.length !== 2) return refuse('the launcher run-client.cjs takes its state root and its input file and nothing else');
    let route;
    try { route = require('../operator/state.cjs').json(path.resolve(cwd, args[0]), args[1]).contract.route; } catch (e) {
      return refuse(`the input of the launcher run-client.cjs cannot be read (${String((e && e.code) || 'error').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 40)})`);
    }
    if (!route || typeof route.client !== 'string' || typeof route.model !== 'string') return refuse('the input of the launcher run-client.cjs names no route client and model');
    for (const key of ['client', 'model']) if (!VISIBLE.test(route[key])) return { code: 'ROUTE_ARGS_REFUSED', problem: `invalid-option-value option=--${key}` };
    return { launcher: kind, client: route.client, model: route.model };
  }
  // cert-launch takes its precert options: the one reader removes them, at most once each with one
  // value, before the pair and the launcher grammar are read; a fix launcher has none
  if (kind === 'cert') {
    const split = seat.splitPrecert(args);
    if (split.problem) return refuse(`the arguments of the launcher cert-launch.cjs are outside its grammar (${shown(split.problem)})`);
    args = split.rest;
  }
  const pair = seat.intendedPair(args, kind);
  if (pair.problem) return { code: 'ROUTE_ARGS_REFUSED', problem: pair.problem };
  try { seat.normalize(args, kind); } catch (e) { return refuse(`the arguments of the launcher ${kind}-launch.cjs are outside its grammar (${shown(e.message)})`); }
  return { launcher: kind, client: pair.client, model: pair.model };
}
function launchEntry(command, { cwd = process.cwd() } = {}) {
  const refuse = problem => ({ code: 'ENTRY_FORM_REFUSED', problem });
  if (!Array.isArray(command) || !command.length || command.some(t => typeof t !== 'string')) return refuse('the child command is not a list of strings');
  const node = /^node(?:\.exe)?$/i.test(path.basename(command[0])) || (realFile(command[0]) !== null && fold(realFile(command[0])) === fold(realFile(process.execPath) || ''));
  let at = -1;
  let inline = false;
  if (node) {
    for (let i = 1; i < command.length; i++) {
      const t = command[i];
      if (t === '--') { at = i + 1; break; }
      if (NODE_FLAGS.has(t) || t.startsWith('--require=')) continue;
      if (NODE_VALUED.has(t) || NODE_INLINE.has(t)) {
        if (i + 1 >= command.length) return refuse(`the node option ${t} has no value`);
        if (NODE_INLINE.has(t)) { inline = true; break; }
        i++; continue;
      }
      if (/^--(?:eval|print)=/.test(t)) { inline = true; break; }
      if (t.startsWith('-')) return refuse(`the node option ${shown(t)} before the script is outside the closed grammar (--, --no-warnings, --require, -r, -e, --eval, -p, --print)`);
      at = i; break;
    }
    if (!inline && (at < 0 || at >= command.length)) return refuse('the node command names no script');
    if (!inline) {
      const real = realFile(path.resolve(cwd, command[at]));
      if (!real) return refuse(`the script ${shown(command[at])} is not an existing file`);
      const kind = kindOf(real);
      if (kind) return launcherPair(kind, command.slice(at + 1), cwd);
    }
  }
  // not a launcher by its script: a launcher named anywhere else is a launcher started outside the grammar
  for (const token of command) {
    const name = tokenLauncher(token, cwd);
    if (name) return refuse(`the command names the seat launcher ${name} outside the script position of the closed grammar (node [options] SCRIPT ARGS)`);
  }
  const stated = launchIdentity(command);
  return stated.problem ? { code: 'ROUTE_ARGS_REFUSED', problem: stated.problem } : { launcher: null, client: stated.client, model: stated.model };
}

// The record part of the decision, before any probe. Pure: (record or the reader's refusal, id, now).
// -> { problems: [refusal], probe: 'record' | 'live' | 'none', route, row }
function assess(loaded, routeId, now) {
  if (loaded.refusal) return { problems: [refused('ROUTE_RECORD_REFUSED', loaded.refusal)], probe: 'none', route: null, row: null };
  const route = loaded.record.routes.find(item => item.id === routeId);
  if (!route) return { problems: [refused('ROUTE_UNKNOWN', `no route with id ${routeId}`)], probe: 'none', route: null, row: null };
  const row = rs.stateOf(loaded.record, routeId, now, { launches: loaded.launches || [] });
  if (row.state === 'failed') {
    return { problems: [refused('ROUTE_FAILED', row.reasons.join(','))], probe: 'none', route, row };
  }
  const problems = [];
  const scarce = probe.isScarce(route.client);
  // Preserve the existing bootstrap safety veto: a cached failed probe cannot
  // bootstrap a scarce launch while no real launch has superseded it. This is
  // a refusal, never a healthy/failed state derived from a scarce probe.
  const legacyFailure = row.fields.probe;
  if (scarce && !row.evidence && legacyFailure?.effective && legacyFailure.value.ok === false && legacyFailure.value.reason !== 'TIMEOUT') {
    return { problems: [refused('ROUTE_FAILED', `PROBE_FAILED:${legacyFailure.value.reason}`)], probe: 'none', route, row };
  }
  // For a scarce route the limit is judged by its own rule below, so its declared reasons are not counted twice.
  const declared = row.reasons.filter(r => r.startsWith('DECLARED_') && !(scarce && r.endsWith(':limit')));
  const probeReasons = row.reasons.filter(r => r.startsWith('PROBE_') || r.startsWith('LAUNCH_'));
  if (row.evidence?.source === 'launch' && row.evidence.ok && !declared.length && !scarce) {
    return { problems, probe: 'evidence', route, row };
  }
  if (scarce) {
    // K9: never probed by the gate; allowed only on a declared limit that has not expired.
    const limit = row.fields.limit;
    if (!limit || limit.tag !== 'declared' || !limit.effective) {
      problems.push(refused('ROUTE_SCARCE_UNKNOWN', limit ? (limit.future ? 'DECLARED_FUTURE:limit' : 'DECLARED_EXPIRED:limit') : 'DECLARED_MISSING:limit'));
    }
    if (declared.length) problems.push(refused('ROUTE_STALE', declared.join(',')));
    return { problems, probe: row.evidence?.source === 'launch' && row.evidence.ok ? 'evidence' : 'none', route, row };
  }
  if (declared.length) problems.push(refused('ROUTE_STALE', declared.join(',')));
  if (row.evidence?.source === 'launch' || row.reasons.includes('LAUNCH_PENDING')) {
    problems.push(refused('ROUTE_STALE', row.reasons.filter(r => r.startsWith('LAUNCH_')).join(',')));
    return { problems, probe: 'none', route, row };
  }
  if (!probeReasons.length) return { problems, probe: 'record', route, row };
  if (!Object.hasOwn(probe.COMMANDS, route.client)) {
    problems.push(refused('ROUTE_NO_PROBE', `client ${route.client} has no probe command; ${probeReasons.join(',')}`));
    return { problems, probe: 'none', route, row };
  }
  return { problems, probe: 'live', route, row };
}

function loadRecord(file) {
  try {
    return { record: rs.loadRecord(file) };
  } catch (e) {
    if (e instanceof rs.Refusal) return { refusal: e.code };
    return { refusal: 'RECORD_INTERNAL' };
  }
}

// One decision for one launch. -> { allowed, refusal, record }
//   allowed  true when the launch may go on
//   refusal  null, or { code, detail } of the first reason that stopped it
//   record   the route-gate/1 object the wrapper prints and stores (only for an allowed launch)
//   route    the id of the route the decision is about (named or derived), else null
// deps.env: the environment the probe root is resolved from (default process.env). The wrapper checks that root against
// every launch root before it calls this function (probeRootProblem), for every launch.
function checkRoute(input, deps = {}) {
  const { routeId, client, model, now } = input;
  const override = input.override === undefined ? null : input.override;
  const nowMs = rs.timeMs(now, 'now');
  const loaded = loadRecord(deps.recordFile || rs.RECORD_FILE);
  if (!loaded.refusal) {
    try {
      const canonical = path.resolve(deps.recordFile || rs.RECORD_FILE) === path.resolve(rs.RECORD_FILE);
      loaded.launches = deps.launches || (canonical ? require('./launch-evidence.cjs').readLiveLaunches() : []);
    } catch {
      loaded.refusal = 'LAUNCH_EVIDENCE_UNREADABLE';
    }
  }
  const launch = { client: client === undefined ? null : client, model: model === undefined ? null : model };
  let resolved = { route: null, via: routeId === undefined || routeId === null ? 'derived' : 'named' };
  if (!loaded.refusal) {
    resolved = resolveRoute(loaded.record, { routeId, client, model });
    if (resolved.problem) return { allowed: false, refusal: resolved.problem, record: null, route: routeId === undefined ? null : routeId };
    if (resolved.transition) {
      const record = {
        schema: SCHEMA, applied: true, route: null, via: 'derived', ...launch, now: rs.isoOf(nowMs), decision: 'transition', basis: 'transition',
        state: 'unrecorded', reasons: [], missing: resolved.transition, probe: null,
        override: override === null ? null : { act: override, applied: false, overridden: [] },
      };
      return { allowed: true, refusal: null, record, route: null };
    }
  }
  const id = resolved.route ? resolved.route.id : routeId === undefined ? null : routeId;
  const first = assess(loaded, id, now);
  const canOverride = list => override !== null && list.every(p => p.overridable);
  // liveProbe false (the route check at the spawn point of a seat client, docs/ops/seat-failover.cjs spawnClient): a
  // route that would need a live probe is stale for that check; it never runs a probe. The one exception is the ok live
  // probe the launch wrapper ran for this same route in this launch (input.priorProbe, handed down by the wrapper): it
  // stands for the probe while it is younger than the probe lifetime of the record (route-state PROBE_TTL_MS).
  if (first.probe === 'live' && input.liveProbe === false) {
    const prior = input.priorProbe;
    const priorMs = prior && typeof prior.at === 'string' ? Date.parse(prior.at) : NaN;
    if (prior && prior.route === first.route.id && prior.ok === true && Number.isFinite(priorMs) && priorMs <= nowMs && nowMs - priorMs < rs.PROBE_TTL_MS) {
      first.probe = 'launch';
    } else {
      first.problems.push(refused('ROUTE_STALE', `${first.row.reasons.filter(r => r.startsWith('PROBE_')).join(',')}; the record holds no fresh probe and this check runs no live probe`));
      first.probe = 'none';
    }
  }
  // Every refusal the record decides is final before a probe runs: a probe is never spent on a launch
  // that cannot start, and a never-overridable reason never reaches the override.
  if (first.problems.length && !canOverride(first.problems)) {
    return { allowed: false, refusal: first.problems[0], record: null, route: id };
  }
  let probeView = null;
  if (first.probe === 'evidence') {
    const e = first.row.evidence;
    probeView = { source: 'launch', basis: e.basis, ok: true, reason: null, at: e.at, served: e.servedModel, warnings: e.warnings };
  } else if (first.probe === 'record') {
    const p = first.row.fields.probe;
    const v = p && p.value ? p.value : null;
    probeView = { source: 'record', ok: v ? v.ok : null, reason: v && v.reason ? v.reason : null, at: v ? v.at : null, served: v && typeof v.served === 'string' ? v.served : null };
  } else if (first.probe === 'launch') {
    probeView = { source: 'launch', ok: true, reason: null, at: input.priorProbe.at };
  } else if (first.probe === 'live') {
    const probeDeps = { ...(deps.probe || {}) };
    const probeRoot = probeDeps.probeTemp || probeRootFor(deps.env);
    let result = probe.runProbe(first.route, { ...probeDeps, probeTemp: probeRoot, nowMs, timeoutMs: probe.TIMEOUT_MS });
    if (result.ok !== true && result.reason === 'TIMEOUT') {
      result = probe.runProbe(first.route, { ...probeDeps, probeTemp: probeRoot, nowMs, timeoutMs: probe.RETRY_TIMEOUT_MS });
    }
    if (result.skipped) {
      const problem = refused('ROUTE_NO_PROBE', result.skipped);
      if (!canOverride([...first.problems, problem])) return { allowed: false, refusal: problem, record: null, route: id };
      first.problems.push(problem);
    } else if (result.ok !== true) {
      return { allowed: false, refusal: refused('ROUTE_PROBE_FAILED', result.reason || 'NO_ANSWER'), record: null, route: id };
    } else {
      probeView = { source: 'live', ok: true, reason: null, at: result.at, served: typeof result.served === 'string' ? result.served : null };
    }
  }
  const overridden = first.problems.map(p => `${p.code}:${p.detail}`);
  const record = {
    schema: SCHEMA,
    applied: true,
    route: id,
    via: resolved.via,
    ...launch,
    now: rs.isoOf(nowMs),
    decision: 'allowed',
    basis: overridden.length ? 'override' : first.probe === 'evidence' ? 'launch-evidence' : first.probe === 'live' ? 'live-probe' : first.probe === 'launch' ? 'launch-probe' : probe.isScarce(first.route.client) ? 'declared-limit' : 'record-probe',
    state: first.row ? first.row.state : 'unknown',
    reasons: first.row ? first.row.reasons : [],
    probe: probeView,
    override: override === null ? null : { act: override, applied: overridden.length > 0, overridden },
  };
  return { allowed: true, refusal: null, record, route: id };
}

// What the operator can do next, per reason (the route state tools only).
const HINTS = Object.freeze({
  ROUTE_FAILED: 'refresh after the cause is fixed: node tools/operator-knowledge/refresh.cjs --probe --route ID',
  ROUTE_PROBE_FAILED: 'the live probe was not cached; refresh: node tools/operator-knowledge/refresh.cjs --probe --route ID',
  ROUTE_STALE: 'declare with the owner word: node tools/operator-knowledge/declare.cjs --route ID --field NAME --value V --by "owner message YYYY-MM-DD"',
  ROUTE_SCARCE_UNKNOWN: 'declare the remaining limit with the owner word: node tools/operator-knowledge/declare.cjs --route ID --field limit --value V --by "owner message YYYY-MM-DD"',
  ROUTE_UNKNOWN: 'add the route as a row of docs/ops/route-state.json',
  ROUTE_MISMATCH: 'name the route of this client and model, or drop --route-state and let the gate derive it',
  ROUTE_AMBIGUOUS: 'give each route of docs/ops/route-state.json its own client and model',
  ROUTE_PROBE_ROOT: 'the probe root must lie on drive D outside the work root, the state directory and .ai/runtime',
  ROUTE_ARGS_REFUSED: 'state --client and --model at most once each in the child command, as --client VALUE or --client=VALUE',
  ENTRY_FORM_REFUSED: 'start a seat launcher as node [--no-warnings | --require VALUE] [--] SCRIPT ARGS, with SCRIPT the launcher file itself',
});

// The one printed line of a decision; it carries closed names only (never raw probe output).
function decisionLine(result, routeId) {
  const label = result.route || (routeId === undefined || routeId === null ? 'none' : routeId);
  if (!result.allowed) {
    const r = result.refusal;
    const hint = HINTS[r.code] ? `; ${HINTS[r.code].replace('ID', label)}` : '';
    return `ROUTE-GATE REFUSED reason=${r.code} route=${label} detail=${r.detail}${r.overridable ? ' (overridable with --route-override "<owner act>")' : ''}${hint}; nothing was started`;
  }
  const g = result.record;
  if (g.decision === 'transition') {
    return `ROUTE-GATE transition route=none ${g.missing} now=${g.now}; no row of docs/ops/route-state.json has this client and model; admitted until the coverage is recorded complete (PROTO-DEC-0240 item 2): add the route`;
  }
  // PROBE-SERVED-MODEL: the line says which model the probe proved, or that none was proven (the gate is an availability gate: an unproven route is admitted, visibly)
  const servedPart = g.probe && g.probe.ok === true && (g.probe.source === 'record' || g.probe.source === 'live') ? ` served=${typeof g.probe.served === 'string' && g.probe.served ? g.probe.served : 'unproven'}` : '';
  const probePart = g.probe ? ` probe=${g.probe.source}:${g.probe.ok === true ? 'ok' : g.probe.reason || 'unknown'}@${g.probe.at}${servedPart}` : '';
  const overridePart = g.override ? ` override="${g.override.act}" overrideApplied=${g.override.applied}${g.override.overridden.length ? ` overridden=${g.override.overridden.join(';')}` : ''}` : '';
  return `ROUTE-GATE allowed route=${g.route} basis=${g.basis} state=${g.state} via=${g.via} now=${g.now}${probePart}${overridePart}`;
}


module.exports = { SCHEMA, REASONS, OVERRIDABLE, overrideProblem, routeIdProblem, deriveRoutes, resolveRoute, probeRootFor, probeRootProblem, assess, checkRoute, decisionLine, launchIdentity, launchEntry, inProbeRoot, LAUNCHERS };

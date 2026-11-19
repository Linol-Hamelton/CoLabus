#!/usr/bin/env node
'use strict';
// refresh.cjs - the ONLY writer of MEASURED route fields (guarantees K2 and K5).
//
//   node tools/operator-knowledge/refresh.cjs [--route ID] [--probe] [--reprobe] [--stats] [--force-scarce]
//        [--record FILE] [--journal FILE] [--now ISO]
//
// --probe  runs the tracked probe table (probe.cjs) once per selected route, one bounded cheap call,
//          timeout 150 s, cwd a temp directory outside the repository; the output is reduced to a named
//          reason before anything is stored and the raw output is never written or printed. A timeout
//          is outcome timeout (route unknown, not failed). A recent launch skips the route (LAUNCH_FRESH), except on the
//          explicit re-probe below. A scarce route (claude, codex) is skipped and its row stays unknown, except on the explicit
//          re-probe with --force-scarce: one bounded client call that spends the scarce limit, on the operator's decision only.
// --reprobe with --probe --route ID: the explicit re-probe of a route whose newest launch evidence failed on availability
//          (route-state probeClears). The failed launch then neither skips the probe nor stands in for it, and a fresh ok probe
//          measured after it, stored with the re-probe source, makes the route usable again. Only this invocation clears a failed
//          launch evidence; the scheduled tick never passes the flag. A failure of identity (a proven other model) is never
//          probed: the row names it (IDENTITY_FAILURE) and what clears it, and no client call is made.
// --expired selects missing, future or expired probes only; fresh failures also
//          remain cached until expiry. Suitable for an operator-owned schedule.
// Writes go to the durable local sibling, leaving the tracked seed unchanged.
// --stats  fills the performance field: the kernel launch-stats reader (the same reader CYCLE-CONTROL
//          uses) joins the launch journal with launches(), measure.cjs measureLaunch turns each launch
//          into measurements (the one place), and summarize() gives the median and p90 of
//          the measured durations. There is no second record parser. A group with no usable record gets
//          null everywhere, never zero.
//
// The tool refuses, with a named reason and exit 4: a declared field through setMeasured
// (FIELD_DECLARED), an unknown route, an unreadable journal, a refused record. It never writes a
// declared field and it makes ONE atomic write at the end, so a failure leaves the old record intact.

const path = require('node:path');
const fs = require('node:fs');

const { defaultJournals, readJournals, launchRecordProblem } = require('./launch-journal.cjs');
const accounting = require('../../.ai/bin/accounting/launch-stats.cjs');
const rs = require('./route-state.cjs');
const probe = require('./probe.cjs');
const { measureLaunch } = require('./measure.cjs');
const identity = require('./launch-identity.cjs');
const kernel = require('../../.ai/bin/accounting/launch-record-validate.cjs');
const live = require('./launch-evidence.cjs');

const ALLOWED = ['route', 'probe', 'reprobe', 'stats', 'expired', 'force-scarce', 'record', 'journal', 'now', 'temp-dir', 'help'];
const BOOLEANS = ['probe', 'reprobe', 'stats', 'expired', 'force-scarce', 'help'];
const USAGE = [
  'usage: node tools/operator-knowledge/refresh.cjs [--route ID] [--probe] [--reprobe] [--stats] [--force-scarce]',
  '         [--expired] [--record FILE] [--journal FILE] [--now ISO] [--temp-dir DIR]',
  'writes MEASURED fields only (probe, performance); declared fields are refused (FIELD_DECLARED)',
].join('\n');

// The launch journal is JSONL of launch-record/1 lines. Reading it is not a second record parser: the
// lines are decoded and duplicate keys are refused by the shared readers, and launches() from the
// kernel launch-stats reader builds the launch objects and the reviews.
// The live launch records are the per-machine journals LAUNCHES-<machine>-<YYYYMM>.jsonl (PROTO-DEC-0174 item 2,
// the journal sync note of the launch layer): the old merged LAUNCHES.jsonl
// stopped on 2026-10-02. Without --journal this reader takes every per-machine journal in the directory, in a
// stable order, and lets launches() join the events by launchId; the sync ledger is not a launch journal and
// is never read as one. With no machine journal present it falls back to the merged file.
function journalFilesFor(flags) {
  if (flags.journal) return [rs.resolvePathArg(flags.journal, 'journal')];
  // An explicit standalone probe record has no implicit live history; supply
  // --journal to join one. This also keeps offline fixtures fully isolated.
  return flags.record && !flags.stats ? [] : defaultJournals();
}

const round6 = value => Math.round(value * 1e6) / 1e6;

// The performance value of one route, from the measurements of measureLaunch only: no raw
// record field is read here. null when no measurement exists; unknown is never imputed as zero.
// F03 / H01, R2: a verdict is an outcome of the closed enum with a known
// provenance, so an absent, unknown or invalid outcome enters neither share.
function performanceOf(measurements, route) {
  const group = measurements.filter(m => m.client === route.client && m.model === route.model);
  if (!group.length) return { verdictShare: null, noVerdictShare: null, wallP50: null, wallP90: null, tokens: null };
  // The kernel's own median and p90 (summarize() with min-n 1), over launches that carry nothing but the
  // measured duration: the one number each of them holds is the one summarize() reads.
  const durations = group.map(m => m.duration).filter(duration => duration !== null);
  const summary = accounting.summarize(durations.map(duration => ({ start: { wallSeconds: duration, exitCode: 0 }, reviews: [] })), 1);
  const wallP50 = summary.wallN > 0 ? Number(summary.wallMedian) : null;
  const wallP90 = summary.wallN > 0 ? Number(summary.wallP90) : null;
  const counts = group.map(m => m.tokens).filter(tokens => tokens !== null);
  const outcomes = group.flatMap(m => m.verdicts);
  const withVerdict = outcomes.filter(outcome => outcome !== 'NONE').length;
  // M03: the two shares are exact complements, so the no-verdict share is the rest of
  // the verdict share, never a second independent rounding. Two independent roundings (1/128 -> 0.007813
  // and 127/128 -> 0.992188) can sum to 1.000001 and be refused as RECORD_PERFORMANCE on a correct set.
  const verdictShare = outcomes.length ? round6(withVerdict / outcomes.length) : null;
  const noVerdictShare = outcomes.length ? round6(1 - verdictShare) : null;
  return {
    verdictShare,
    noVerdictShare,
    wallP50: Number.isFinite(wallP50) ? wallP50 : null,
    wallP90: Number.isFinite(wallP90) ? wallP90 : null,
    tokens: counts.length ? counts.reduce((sum, count) => sum + count, 0) : null,
  };
}

// The probe reason of a launch failure (launch-evidence FAILURES) where the two vocabularies differ.
const PROBE_REASON = Object.freeze({ AUTH: 'AUTH_FAILED', QUOTA: 'QUOTA_EXCEEDED', TRANSPORT: 'PROVIDER_UNAVAILABLE',
  TRANSPORT_EXHAUSTED: 'PROVIDER_UNAVAILABLE', PROXY_DROP: 'PROVIDER_UNAVAILABLE', SERVED_MODEL_MISMATCH: 'SERVED_MISMATCH' });

// Completed real seats, joined by the kernel reader, outrank probes for one probe TTL.
// Neither a start event, an exit code alone, nor the model's own words prove an answer.
// The launches are the live reader's one event join (launch-evidence joinEntries): a refused record or conflicting events
// leave their launch out here as there, and a recovered record proves nothing (the kernel predicate).
function recentLaunches(entries, routes, nowMs) {
  const latest = new Map();
  for (const pair of live.joinEntries(entries)) {
    const start = pair.start, fin = pair.fin || (pair.start.event === undefined ? pair.start : null);
    if (!fin) continue;
    if (kernel.recovered(start) || kernel.recovered(fin)) continue;
    const tuple = start.tuple;
    const atMs = Date.parse(fin.endedAt);
    if (!tuple || !Number.isFinite(atMs) || atMs > nowMs || nowMs - atMs >= rs.PROBE_TTL_MS) continue;
    if (!Number.isInteger(fin.exitCode)) continue;
    const startMs = Date.parse(start.startedAt);
    if (!Number.isFinite(startMs) || startMs > atMs) continue;
    for (const route of routes) {
      if (route.client !== tuple.client || route.model !== tuple.model) continue;
      if (start.route && !['auto', 'unknown', 'none', `cli:${route.client}`].includes(start.route) && start.route !== route.id) continue;
      // The launch evidence's one outcome rule decides the failure and the answer; a failure is written in the probe's own
      // reason names.
      const outcome = live.outcomeOf({ ...pair, fin });
      // A launch that ended without a proven answer and without a provider or identity failure class is no measurement of the
      // route: no fact stands in for the probe.
      if (!outcome.failure && !outcome.answered) continue;
      const reason = outcome.failure ? (PROBE_REASON[outcome.failure] || outcome.failure) : null;
      // The launch evidence's one client-proof rule decides what a launch proves.
      const proofRecord = live.proofOf(fin, start);
      const source = proofRecord?.servedModelSource;
      const model = proofRecord?.servedModel;
      const proven = Boolean(proofRecord);
      // A client proof is kept on every route; the launch identity of a first-party route only fills its absence.
      const saved = { ok: reason === null, reason, at: rs.isoOf(atMs),
        served: proven ? model : identity.firstParty(route) ? route.model : null,
        servedSource: proven ? source : identity.firstParty(route) ? 'launch-command' : 'none',
        ...(reason === null && fin.exitCode !== 0 ? { warning: 'EXIT_NONZERO_AFTER_ANSWER' } : {}) };
      // The live reader's one selection order: the newest, a failure on equal time, then an identity problem (launch-identity's
      // one rule, the rule of the live evidence), then one canonical order. The problem ranks only; it is not stored.
      const old = latest.get(route.id);
      const ranked = probe => ({ ...probe, identityProblem: identity.certificationProblem(route, probe) });
      if (!old || live.newestFirst(ranked(saved), ranked(old)) < 0) latest.set(route.id, saved);
    }
  }
  return latest;
}

function launchFacts(files, routes, nowMs) {
  // A host without launch history may probe. An existing unreadable journal is a refusal.
  const present = files.filter(file => {
    try { fs.lstatSync(file); return true; } catch (e) {
      if (e.code === 'ENOENT') return false;
      throw new rs.Refusal('JOURNAL_UNREADABLE', 'launch history cannot be inspected');
    }
  });
  return recentLaunches(readJournals(present), routes, nowMs);
}

// The explicit re-probe: --probe --reprobe --route ID while the newest fresh launch evidence of that route failed on availability
// (route-state probeClears, the predicate stateAt replaces by). The failed launch then neither skips the probe (LAUNCH_FRESH) nor
// stands in for it. Without both the flag and --route no launch window is ever lifted.
function reprobeOf(route, flags, launches, nowMs) {
  if (!flags.route || !flags.reprobe) return false;
  return rs.probeClears(live.latestEvidence(launches, route, nowMs));
}
// The explicit re-probe of a launch that failed on identity: a probe cannot clear it, so none is run. Returns its reason or null.
function identityFailureOf(route, flags, launches, nowMs) {
  if (!flags.route || !flags.reprobe) return null;
  const newest = live.latestEvidence(launches, route, nowMs);
  return newest && newest.ok === false && !rs.probeClears(newest) ? newest.reason : null;
}
const SCARCE_NEEDS_FLAG = 'the explicit re-probe of a scarce route needs --force-scarce (one client call from its limit); no client call was made';
const IDENTITY_CLEARS ='a probe proves availability, not the served model: fix the route model or the client, then a new launch whose client banner or log proves the route model clears it; no client call was made';
function skipProbe(route, flags, nowMs, reprobe = false) {
  const previous = route.fields.probe;
  if (flags.expired && previous && rs.timeMs(previous.measuredAt, 'probe time') <= nowMs && rs.timeMs(previous.expiresAt, 'probe expiry') > nowMs) return 'PROBE_FRESH';
  // A scarce route spends its limit on a probe, and the route state counts a scarce probe only when it replaces an older failed
  // launch evidence. So a scarce route is probed only on the operator's explicit decision for that case: --route ID with
  // --force-scarce while the newest launch evidence of the route failed (one bounded client call). Every other scarce probe is
  // skipped, the flag alone included; nothing probes a scarce route automatically.
  if (probe.isScarce(route.client)) return reprobe && flags['force-scarce'] ? null : 'SCARCE_LIMIT';
  return null;
}

// CLI batch phase; main stays synchronous for the launch gates and fixture callers.
async function mainAsync(argv, deps = {}) {
  try {
    const flags = rs.parseFlags(argv, ALLOWED, BOOLEANS);
    if (!flags.probe || flags.help || flags._.length || flags.expired && !flags.probe || flags.reprobe && !flags.route) return main(argv, deps);
    const nowMs = flags.now ? rs.timeMs(flags.now, '--now') : Date.now();
    const file = flags.record ? rs.resolvePathArg(flags.record, 'record') : rs.RECORD_FILE;
    const before = rs.loadRecord(file), routes = flags.route ? [rs.routeOf(before, flags.route)] : before.routes;
    const files = journalFilesFor(flags);
    if ((flags.stats || flags.journal) && files.some(f => !fs.existsSync(f))) throw new rs.Refusal('JOURNAL_UNREADABLE', 'the requested launch journal is absent');
    const facts = launchFacts(files, routes, nowMs);
    const launches = deps.launches || (flags.journal ? live.readLiveLaunches(files) : file === rs.RECORD_FILE ? live.readLiveLaunches() : []);
    const pending = routes.filter(route => {
      const again = reprobeOf(route, flags, launches, nowMs);
      return (again || (!live.hasRecentLaunch(launches, route, nowMs) && !facts.has(route.id))) && !skipProbe(route, flags, nowMs, again);
    });
    const results = await require('./probe-batch.cjs').runBatch(pending, {
      nowMs, ...(flags['temp-dir'] ? { probeTemp: rs.resolvePathArg(flags['temp-dir'], 'temp-dir') } : {}),
      // The operator's explicit re-probe names its one route; only that scarce route may reach a worker (skipProbe above lets
      // it through only with --force-scarce on a failed launch evidence).
      ...(flags.route && flags.reprobe && flags['force-scarce'] ? { scarceRoute: flags.route } : {}),
    }, deps.batch);
    const byId = new Map(pending.map((r, i) => [r.id, { route: r, value: results[i] }]));
    return main(argv, { ...deps, nowMs, launches, launchFacts: facts, runProbe: route => {
      const saved = byId.get(route.id);
      if (!saved || ['client', 'model', 'billing'].some(k => saved.route[k] !== route[k])) throw new rs.Refusal('ROUTE_CHANGED', 'the probe batch identity changed');
      return saved.value;
    } });
  } catch (e) {
    process.stderr.write(`REFUSED ${e instanceof rs.Refusal ? e.code : 'PROBE_BATCH_FAILED'}\n`);
    return e.code === 'USAGE' ? 2 : 4;
  }
}

function main(argv, deps = {}) {
  try {
    const flags = rs.parseFlags(argv, ALLOWED, BOOLEANS);
    if (flags.help) { process.stdout.write(`${USAGE}\n`); return 0; }
    if (flags._.length) throw new rs.Refusal('USAGE', `unexpected argument ${flags._[0]}`);
    if (!flags.probe && !flags.stats) throw new rs.Refusal('USAGE', 'at least one of --probe and --stats is required');
    if (flags.expired && !flags.probe) throw new rs.Refusal('USAGE', '--expired requires --probe');
    if (flags.reprobe && (!flags.probe || !flags.route)) throw new rs.Refusal('USAGE', '--reprobe requires --probe and --route ID');
    const nowMs = flags.now ? rs.timeMs(flags.now, '--now') : deps.nowMs ?? Date.now();
    const recordFile = flags.record ? rs.resolvePathArg(flags.record, 'record') : rs.RECORD_FILE;
    const journalFiles = journalFilesFor(flags);
    const probeTemp = flags['temp-dir'] ? rs.resolvePathArg(flags['temp-dir'], 'temp-dir') : undefined;
    if (flags.stats) {
      for (const file of journalFiles) {
        if (!fs.existsSync(file)) throw new rs.Refusal('JOURNAL_UNREADABLE', `absent: ${path.basename(file)} does not exist`);
      }
    }
    const before = rs.loadRecord(recordFile);
    const routes = flags.route ? [rs.routeOf(before, flags.route)] : before.routes;
    const rows = [];
    const measurements = [];
    const invalidReasons = new Map();
    const launches = deps.launches || (flags.journal ? live.readLiveLaunches(journalFiles) : recordFile === rs.RECORD_FILE ? live.readLiveLaunches() : []);

    if (flags.probe) {
      const facts = deps.launchFacts || launchFacts(journalFiles, routes, nowMs);
      for (const route of routes) {
        const identityFailure = identityFailureOf(route, flags, launches, nowMs);
        if (identityFailure) {
          rows.push({ route: route.id, action: 'probe', outcome: 'skipped', reason: 'IDENTITY_FAILURE', cause: identityFailure });
          continue;
        }
        const again = reprobeOf(route, flags, launches, nowMs);
        const launched = again ? null : facts.get(route.id);
        // The train's live evidence owns its three-hour window, including pending seats; an explicit re-probe of a failed route does not wait.
        if (!again && live.hasRecentLaunch(launches, route, nowMs)) {
          rows.push({ route: route.id, action: 'probe', outcome: 'skipped', reason: 'LAUNCH_FRESH' });
          continue;
        }
        const skip = launched ? null : skipProbe(route, flags, nowMs, again);
        if (skip) {
          rows.push({ route: route.id, action: 'probe', outcome: 'skipped', reason: skip, ...(skip === 'SCARCE_LIMIT' && again ? { hint: SCARCE_NEEDS_FLAG } : {}) });
          continue;
        }
        let result = launched || (deps.runProbe || probe.runProbe)(route, { nowMs, probeTemp });
        if (result.skipped) {
          rows.push({ route: route.id, action: 'probe', outcome: 'skipped', reason: result.skipped });
          continue;
        }
        // An unseen failure class must not abort the atomic refresh of every route or
        // escape as raw client text. Persist a closed failure and keep the route blocked.
        if (!result.ok && !probe.PROBE_REASONS.includes(result.reason)) {
          result = { ok: false, reason: 'EXIT_NONZERO', at: result.at, served: null, servedSource: 'none' };
        }
        // The explicit re-probe stores its own source: only a probe of that source replaces a failed launch evidence (stateAt).
        measurements.push({ route: route.id, field: 'probe', value: result, ...(launched ? { source: 'launch-journal', measuredMs: Date.parse(result.at) } : again ? { source: rs.REPROBE_SOURCE } : {}) });
        rows.push({ route: route.id, action: 'probe', outcome: result.ok ? 'ok' : result.reason === 'TIMEOUT' ? 'timeout' : result.reason === 'QUOTA_EXHAUSTED' ? 'quota' : 'failed', reason: result.reason || '', warning: result.warning, served: typeof result.served === 'string' ? result.served : null });
      }
    }

    if (flags.stats) {
      const entries = readJournals(journalFiles);
      // A launch record is used only when the kernel's own forms accept it (launchRecordProblem
      // above); anything else is invalid, is counted with its named reason and gives no number.
      const valid = [];
      const whereOf = new Map();
      let invalid = 0;
      const countReason = (code, where, detail) => {
        const seen = invalidReasons.get(code);
        if (seen) seen.count += 1;
        else invalidReasons.set(code, { count: 1, where, detail });
      };
      for (const entry of entries) {
        const problem = launchRecordProblem(entry.record);
        if (problem) { invalid += 1; countReason(problem.code, entry.where, problem.detail); continue; }
        whereOf.set(entry.record, entry.where);
        valid.push(entry.record);
      }
      // Every launch of the kernel join becomes measurements in ONE place, measureLaunch. A
      // launch with an invalid field is counted invalid once, each of its invalid reasons by name with the
      // line it hit; its other measures stay (an invalid field nulls only its own measure).
      const measured = [];
      for (const l of accounting.launches(valid)) {
        const m = measureLaunch(l);
        const problems = m.reasons.filter(r => r.kind === 'invalid');
        if (problems.length) invalid += 1;
        const codes = new Set();
        for (const r of problems) {
          if (codes.has(r.code)) continue;
          codes.add(r.code);
          countReason(r.code, whereOf.get(r.rec) || 'launch', r.detail);
        }
        measured.push(m);
      }
      for (const route of routes) {
        const value = performanceOf(measured, route);
        measurements.push({ route: route.id, field: 'performance', value });
        rows.push({
          route: route.id,
          action: 'stats',
          outcome: value.tokens === null && value.wallP50 === null && value.verdictShare === null ? 'unknown' : 'measured',
          reason: '',
          invalid,
          value,
        });
      }
    }

    // One writer at a time. The slow reads - the probes and the journals - happen
    // above; the lock covers only the fresh read, the measured writes and the one atomic write, so a
    // concurrent declare cannot have its update replaced by a record read before it.
    const record = rs.withRecordLock(rs.localRecordFile(recordFile), () => {
      const current = rs.loadRecord(recordFile);
      for (const item of measurements) {
        const target = rs.routeOf(current, item.route);
        const original = rs.routeOf(before, item.route);
        if (['client', 'model', 'billing'].some(key => target[key] !== original[key])) {
          throw new rs.Refusal('ROUTE_CHANGED', 'the probed route identity changed during refresh');
        }
        const prior = target.fields[item.field];
        // A slower refresh must not overwrite a newer completed measurement.
        if (prior && rs.timeMs(prior.measuredAt, 'measurement time') > nowMs) continue;
        if (prior && prior.source === 'launch-journal' && rs.timeMs(prior.measuredAt, 'measurement time') > (item.measuredMs ?? nowMs)) continue;
        // Fresh real launches supersede synthetic probes, preserving their original time and TTL.
        const measuredMs = item.measuredMs ?? nowMs;
        rs.setMeasured(current, item.route, item.field, item.value, { nowMs: measuredMs, ...(item.source ? { source: item.source } : {}) });
      }
      current.generatedAt = rs.isoOf(nowMs);
      rs.writeLocalRecord(current, recordFile);
      return current;
    });
    const states = rs.stateAt(record, rs.isoOf(nowMs), { launches });
    for (const [code, item] of invalidReasons) {
      process.stdout.write(`INVALID reason=${code} count=${item.count} first=${item.where} detail=${item.detail}\n`);
    }
    for (const row of rows) {
      if (row.action === 'probe') {
        process.stdout.write(`PROBE route=${row.route} outcome=${row.outcome}${row.reason ? ` reason=${row.reason}` : ''}${row.cause ? ` cause=${row.cause}` : ''}${row.warning ? ` warning=${row.warning}` : ''} served=${row.served || 'unproven'}${row.cause ? `; ${IDENTITY_CLEARS}` : row.hint ? `; ${row.hint}` : ''}\n`);
      } else {
        const v = row.value;
        process.stdout.write(`STATS route=${row.route} outcome=${row.outcome} verdictShare=${v.verdictShare === null ? 'null' : v.verdictShare} noVerdictShare=${v.noVerdictShare === null ? 'null' : v.noVerdictShare} wallP50=${v.wallP50 === null ? 'null' : v.wallP50} wallP90=${v.wallP90 === null ? 'null' : v.wallP90} tokens=${v.tokens === null ? 'null' : v.tokens} invalid=${row.invalid}\n`);
      }
    }
    for (const row of states.routes) {
      if (flags.route && row.id !== flags.route) continue;
      process.stdout.write(`STATE route=${row.id} state=${row.state} reasons=${row.reasons.length ? row.reasons.join(',') : 'none'}\n`);
    }
    return 0;
  } catch (e) {
    if (e instanceof rs.Refusal) {
      process.stderr.write(`REFUSED ${e.code}: ${e.detail}\n`);
      return e.code === 'USAGE' ? 2 : 4;
    }
    process.stderr.write(`REFUSED INTERNAL: ${String(e && e.message ? e.message : e).slice(0, 200)}\n`);
    return 4;
  }
}

module.exports = { main, mainAsync, recentLaunches, skipProbe, reprobeOf };
if (require.main === module) mainAsync(process.argv.slice(2)).then(code => { process.exitCode = code; });

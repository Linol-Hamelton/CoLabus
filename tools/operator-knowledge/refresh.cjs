#!/usr/bin/env node
'use strict';
// refresh.cjs - the ONLY writer of MEASURED route fields (guarantees K2 and K5).
//
//   node tools/operator-knowledge/refresh.cjs [--route ID] [--probe] [--stats] [--force-scarce]
//        [--record FILE] [--journal FILE] [--now ISO]
//
// --probe  runs the tracked probe table (probe.cjs) once per selected route, one bounded cheap call,
//          timeout 150 s, cwd a temp directory outside the repository; the output is reduced to a named
//          reason before anything is stored and the raw output is never written or printed. A timeout
//          is a failed probe. A scarce route (claude, codex) is skipped and its row stays unknown
//          unless --force-scarce is given (the scarce-route question is open).
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
const crypto = require('node:crypto');

const pathSafe = require('../../.ai/bin/lib/path-safe.cjs');
const textSafe = require('../../.ai/bin/lib/text-safe.cjs');
const accounting = require('../../.ai/bin/accounting/launch-stats.cjs');
const kernel = require('../../.ai/bin/accounting/launch-record-validate.cjs');
const rs = require('./route-state.cjs');
const probe = require('./probe.cjs');
const { measureLaunch } = require('./measure.cjs');

const JOURNAL_DIR = path.join(rs.REPO, ...require('../../.ai/bin/repo-paths.cjs').CATALOG_LAUNCHES);
const JOURNAL_FILE = path.join(JOURNAL_DIR, 'LAUNCHES.jsonl');
const ALLOWED = ['route', 'probe', 'stats', 'force-scarce', 'record', 'journal', 'now', 'temp-dir', 'help'];
const USAGE = [
  'usage: node tools/operator-knowledge/refresh.cjs [--route ID] [--probe] [--stats] [--force-scarce]',
  '         [--record FILE] [--journal FILE] [--now ISO] [--temp-dir DIR]',
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
function defaultJournals() {
  let names = [];
  try {
    names = fs.readdirSync(JOURNAL_DIR).filter(name => /^LAUNCHES-.*\.jsonl$/.test(name)).sort();
  } catch {
    names = [];
  }
  if (!names.length) return [JOURNAL_FILE];
  return names.map(name => path.join(JOURNAL_DIR, name));
}

// Every line keeps its place (file and line number), so an invalid record is reported by name.
function readJournal(file) {
  const abs = path.resolve(file);
  const guarded = pathSafe.readFileGuarded(path.parse(abs).root, abs);
  if (!guarded.ok) throw new rs.Refusal('JOURNAL_UNREADABLE', `${guarded.reason}: ${guarded.detail}`);
  const decoded = textSafe.decode(guarded.bytes, { bom: 'refuse', crlf: 'normalise', invisible: 'refuse' });
  if (!decoded.ok) throw new rs.Refusal('JOURNAL_ENCODING', decoded.problems.map(p => p.code).join(','));
  const entries = [];
  decoded.text.split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try {
      entries.push({ record: textSafe.parseJsonUnique(line), where: `${path.basename(abs)}:${i + 1}` });
    } catch (e) {
      throw new rs.Refusal('JOURNAL_JSON', `${path.basename(abs)} line ${i + 1}: ${e.code === 'JSON_DUPLICATE_KEY' ? 'a key appears twice' : 'not valid JSON'}`);
    }
  });
  return entries;
}

function readJournals(files) {
  const entries = [];
  for (const file of files) entries.push(...readJournal(file));
  return entries;
}

// What a launch record IS is decided by the kernel, never by a list of this package
// (one decider). The kernel validator launch-record-validate.cjs defines four line forms: a FULL record (it
// has startedAt and NO event field) and the three event records started, finished and review. The
// schema and the event are judged by the kernel's own field predicates (kernel.FIELDS), so every form
// the kernel accepted before this package stays accepted: a record without an event is a full record,
// never an invalid one. A record is invalid only when it is not an object, carries another schema,
// carries an event outside the kernel's events, or has no launchId (the kernel reader launches() has
// always skipped those). The reason is a closed code; refresh prints it with the first line it hit.
function launchRecordProblem(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return { code: 'NOT_OBJECT', detail: 'the line is not a JSON object' };
  const [isSchema, schemaForm] = kernel.FIELDS.schema;
  if (!isSchema(rec.schema)) return { code: 'SCHEMA', detail: `schema ${foreignTag(rec.schema)} is not ${schemaForm}` };
  if (Object.hasOwn(rec, 'event')) {
    const [isEvent, eventForm] = kernel.FIELDS.event;
    if (!isEvent(rec.event)) return { code: 'EVENT', detail: `event ${foreignTag(rec.event)} is not one of ${eventForm}` };
  }
  if (typeof rec.launchId !== 'string' || !rec.launchId) return { code: 'LAUNCH_ID', detail: 'the record names no launchId' };
  // The numbers of a record (wall time, instants, exit code, tokens) are judged in ONE place,
  // measure.cjs measureLaunch, where an invalid field makes its own measure null with a named reason.
  return null;
}

// A foreign value in an invalid line is never echoed. The output names its type,
// its length and a short hash, so two reports can be compared without the text itself leaving the journal.
function foreignTag(value) {
  const text = typeof value === 'string' ? value : String(JSON.stringify(value));
  const hash = crypto.createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12);
  const kind = typeof value === 'string' ? `text of ${value.length} characters` : `a ${value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value} value`;
  return `(${kind}, sha256:${hash})`;
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

function main(argv) {
  try {
    const flags = rs.parseFlags(argv, ALLOWED, ['probe', 'stats', 'force-scarce', 'help']);
    if (flags.help) { process.stdout.write(`${USAGE}\n`); return 0; }
    if (flags._.length) throw new rs.Refusal('USAGE', `unexpected argument ${flags._[0]}`);
    if (!flags.probe && !flags.stats) throw new rs.Refusal('USAGE', 'at least one of --probe and --stats is required');
    const nowMs = flags.now ? rs.timeMs(flags.now, '--now') : Date.now();
    const recordFile = flags.record ? rs.resolvePathArg(flags.record, 'record') : rs.RECORD_FILE;
    const journalFiles = flags.journal ? [rs.resolvePathArg(flags.journal, 'journal')] : defaultJournals();
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

    if (flags.probe) {
      for (const route of routes) {
        if (probe.isScarce(route.client) && !flags['force-scarce']) {
          rows.push({ route: route.id, action: 'probe', outcome: 'skipped', reason: 'SCARCE_LIMIT' });
          continue;
        }
        const result = probe.runProbe(route, { nowMs, probeTemp });
        if (result.skipped) {
          rows.push({ route: route.id, action: 'probe', outcome: 'skipped', reason: result.skipped });
          continue;
        }
        measurements.push({ route: route.id, field: 'probe', value: result });
        rows.push({ route: route.id, action: 'probe', outcome: result.ok ? 'ok' : 'failed', reason: result.reason || '', served: typeof result.served === 'string' ? result.served : null });
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
    const record = rs.withRecordLock(recordFile, () => {
      const current = rs.loadRecord(recordFile);
      for (const item of measurements) rs.setMeasured(current, item.route, item.field, item.value, { nowMs });
      current.generatedAt = rs.isoOf(nowMs);
      rs.writeRecord(current, recordFile);
      return current;
    });
    const states = rs.stateAt(record, rs.isoOf(nowMs));
    for (const [code, item] of invalidReasons) {
      process.stdout.write(`INVALID reason=${code} count=${item.count} first=${item.where} detail=${item.detail}\n`);
    }
    for (const row of rows) {
      if (row.action === 'probe') {
        process.stdout.write(`PROBE route=${row.route} outcome=${row.outcome}${row.reason ? ` reason=${row.reason}` : ''} served=${row.served || 'unproven'}\n`);
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

if (require.main === module) process.exitCode = main(process.argv.slice(2));

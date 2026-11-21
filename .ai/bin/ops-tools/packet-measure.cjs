'use strict';
// packet-measure: the measure of the packet context. Advisory only: it decides nothing, writes nothing and starts no client.
//   node .ai/bin/ops-tools/packet-measure.cjs window --since DAY --until DAY [--line REF] [--records DIR] [--started-after ISO] [--root DIR]
//   node .ai/bin/ops-tools/packet-measure.cjs coverage [--records DIR] [--root DIR] [--now ISO]
//   node .ai/bin/ops-tools/packet-measure.cjs removed-proof [--records DIR] [--root DIR] [--now ISO]
// window: for the packages landed on the integration line between the two UTC days (both included) it counts R1 the author rounds per
// package, R2 the certification rounds of the canonical reviews of the window (the M-003 leaf), R3 the repeat of a finding class, R4 the
// share of mechanical fix rounds and P1 the gated launches of the window without a packet. coverage: P1 after the activation mark of the
// coupled-set registry, the line packet-missing of the pulse. removed-proof: the proof that the bypass of the packet is gone, prepared for
// the operator and never applied. Unknown is null with its reason, never a zero. The inputs are git objects of the root, the launch-record
// day files and the canonical reviews; the same inputs give the same bytes (no clock, no environment in the output). A measurement states
// only what its inputs prove: a launch record is read by one reader of the closed schema (recordRefusal), and a refused record is counted,
// named and leaves the measure over it unknown; a record of the schema whose provenance is not proven (provenanceGap: recovered, or a field
// the measure reads of inferred or unknown confidence) is counted and named beside the measure and never evidence of it. The helpers take
// the moment of the measure as a required input.
// Exit: 0 measured (values may be null); 1 removed-proof not ready; 2 usage or an unreadable source.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const SCHEMA = 'packet-measure/1';
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const DAY_FILE = /^launches-(\d{4})(\d{2})(\d{2})\.jsonl$/;
const DAY_MS = 86400000;
const CERTIFYING = new Set(['PASS', 'RECOMMENDATION']);
// A landing of a package on the integration line: the one squash commit of the landing tool, its branch and the tip it squashed.
const LANDING = /^land (\S+) as one commit \(squash of the branch tip ([0-9a-f]{7,40})/;
const LANDED_TIP = /^Landed-Tip: ([0-9a-f]{40})$/m;
// The context note of a launch record that carried a packet with its context (the certifier and fixer engines write it).
const CONTEXT_NOTE = /(?:^| )packet-context level=(C[1-3]) commit=([0-9a-f]{40})(?: |$)/;
// The count of the rows of the required set that a packet left out because the required set alone passed the safety limit (the engines write it only when it is above zero).
const TRIMMED_NOTE = /(?:^| )packet-trimmed=([1-9][0-9]{0,8})(?: |$)/;
const AUTHOR_END =/(?:^| )author-end=(DONE|BLOCKED|NO_VERDICT)(?: |$)/;
// The proof needs this many author and certifier launches after the activation mark, the first ones in time.
const PROOF_LAUNCHES = 3;
// A share is printed only over at least this many rounds; under it the counts stand alone.
const SMALL = 20;
// Mechanical fix rounds: a round whose every changed file is of the classes below, at least one of them not only a journal or a report.
// The classes are the precert chores of an author round: the manifest entries and test tiers, the suite timing, the derived files and the
// reviewed reader pins. The names are built at run time: the development files among them are not shipped and no shipped text names them.
const MECHANICAL = Object.freeze({
  'protocol-manifest.json': 'manifest-entries',
  [path.posix.join('docs', 'ops', `${['SUITE', 'TIERS'].join('-')}.md`)]: 'test-tiers',
  [path.posix.join('docs', 'ops', 'suite-timing.json')]: 'test-tiers',
  [path.posix.join('docs', 'ops', `${['test', 'consumers'].join('-')}.json`)]: 'consumer-index',
  [path.posix.join('.ai', 'core', 'CATALOG.md')]: 'derived-file',
  [path.posix.join('docs', 'ops', 'OPEN-REGISTER-TABLE.md')]: 'derived-file',
  [path.posix.join('tools', 'archive', `${['corpus', 'readers'].join('-')}.json`)]: 'reviewed-pin',
});
const neutral = file => file.startsWith('.ai/worklog/') || file.startsWith('docs/reviews/') || /^docs\/ops\/[A-Z0-9-]+-AUTHOR-REPORT\.md$/.test(file);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const sha256 = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
const usage = message => Object.assign(new Error(message), { exitCode: 2 });

// ---------- launch records ----------
// The kind of one record for the measure. A refused start (launch-not-started) is no launch; pre-review only warns; an author launch is an
// author launch role, or a fixer or implementer packet of a record that names no launch role; a certifier launch is a certifier packet or
// launch role that is not an author or pre-review launch.
function kindOf(rec) {
  if (!rec || typeof rec !== 'object') return 'other';
  if (typeof rec.note === 'string' && /(?:^| )launch-not-started /.test(rec.note)) return 'refused';
  if (rec.launchRole === 'pre-review') return 'pre-review';
  if (rec.launchRole === 'author' || (rec.launchRole === undefined && ['fixer', 'implementer'].includes(rec.role))) return 'author';
  if (rec.role === 'certifier' || rec.launchRole === 'certifier') return 'certifier';
  return 'other';
}
const startMs = rec => (typeof rec.startedAt === 'string' && ISO.test(rec.startedAt.replace(/\.\d+Z$/, '.000Z')) ? Date.parse(rec.startedAt) : NaN);
// The UTC day of a day file name, as the start of that day in ms, or null for a name that is not a day file.
function dayOf(name) {
  const m = DAY_FILE.exec(name);
  if (!m) return null;
  const ms = Date.parse(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isFinite(ms) && new Date(ms).toISOString().startsWith(`${m[1]}-${m[2]}-${m[3]}`) ? ms : null;
}
// The one reader of a launch record for the measure. A record is a launch only when it is of the closed schema of the launch record
// (launch-record-validate.cjs validateRecord: its one version, every field known, of its type and of its allowed values, the required fields
// of its kind and the rules between fields; the null of a base field that the schema keeps for the records before amendment A-2 included),
// the start of a launch (a full record or a started event; a finished or review event is no start) and its start time names a time that
// exists (30 February is no day). -> null for a launch record, else the name of the refusal. A refused record is never a launch of a count
// or of the proof: it is counted and named, and a measure over it is unknown.
const RECORD_SCHEMA = 'launch-record/1';
const FIELD_REFUSALS = [[/^unknown field /, 'record-field-unknown'], [/ needs "/, 'record-field-missing'], [/^field "/, 'record-field-invalid']];
function recordRefusal(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return 'record-not-an-object';
  if (rec.schema !== RECORD_SCHEMA) return 'record-schema-unknown';
  if (rec.event === 'finished' || rec.event === 'review') return 'record-not-a-start';
  const errors = require('../accounting/launch-record-validate.cjs').validateRecord(rec);
  if (errors.length) return (FIELD_REFUSALS.find(([re]) => errors.some(e => re.test(e))) || [null, 'record-rule-broken'])[1];
  const at = startMs(rec);
  if (!Number.isFinite(at) || new Date(at).toISOString().slice(0, 19) !== rec.startedAt.slice(0, 19)) return 'record-start-not-a-time';
  return null;
}
// The type of a field is not its trust. A record of the schema is evidence of a launch only when its provenance is proven: a recovered
// record (launch-record-validate.cjs recovered: rebuilt after the fact, as the kernel recovery does after a crash) never proves a launch,
// and a field the measure reads whose confidence is inferred or unknown is never counted (LAUNCH-RECORD-EXT.md, analysis rules).
// -> null for a proven record, else the name of the gap. Such a record is valid and no refusal: it is counted and named beside the measure,
// and it never raises a count or makes the proof ready.
const MEASURE_FIELDS = ['launchId', 'startedAt', 'event', 'note', 'launchRole', 'role', 'packetHash', 'packetProfile', 'packetBytes', 'head', 'stream', 'workdir', 'verdict'];
const UNPROVEN_CONFIDENCE = new Set(['inferred', 'unknown']);
function provenanceGap(rec) {
  if (require('../accounting/launch-record-validate.cjs').recovered(rec)) return 'record-recovered';
  const conf = rec.confidence && typeof rec.confidence === 'object' ? rec.confidence : {};
  if (MEASURE_FIELDS.some(f => Object.hasOwn(conf, f) && UNPROVEN_CONFIDENCE.has(conf[f]))) return 'record-provenance-unknown';
  return null;
}
// One day file: its launch records (those the reader above takes and whose provenance is proven), the lines that do not read, the records
// it refused with the count of each refusal, the valid records of no proven provenance with the count of each gap and the digest of its
// bytes. A line with a key twice does not read: JSON.parse would keep the last copy of the key and lose the first.
function parseDay(bytes) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes);
  const { parseJsonUnique } = require('../lib/text-safe.cjs');
  const records = []; let unreadable = 0; let refused = 0; const refusals = {}; let unproven = 0; const gaps = {};
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = parseJsonUnique(line); } catch { unreadable++; continue; }
    const why = recordRefusal(rec);
    if (why !== null) { refused++; refusals[why] = (refusals[why] || 0) + 1; continue; }
    const gap = provenanceGap(rec);
    if (gap !== null) { unproven++; gaps[gap] = (gaps[gap] || 0) + 1; continue; }
    records.push(rec);
  }
  return { records, unreadable, refused, refusals, unproven, gaps, sha256: sha256(Buffer.isBuffer(bytes) ? bytes : Buffer.from(text, 'utf8')) };
}
const addRefusals = (into, from) => { for (const [k, n] of Object.entries(from)) into[k] = (into[k] || 0) + n; return into; };
const sortedRefusals = r => Object.fromEntries(Object.entries(r).sort(([a], [b]) => cmp(a, b)));
// The day files of the folder from the first day to the last (ms of a day start, both included; null is open), read in name order. A launch
// id seen twice is kept once (the first) and counted; the lines that do not read are counted per file and in all. The folder and each day
// file pass the one guard of the record folder (packet-gate.cjs recordFolder and readDayFile): a folder that is a link or junction or whose
// real path is another folder, a day file that is a link or junction, not a plain file of its own or above the byte limit, are refused by
// name, so no record comes from outside the folder; a refusal is never a lower count. The records the reader refused are counted per file
// and in all, with the count of each refusal; so are the valid records of no proven provenance (unproven, with the count of each gap), which
// are never among the records. With atMs, the moment of the measure, a launch that started after it is no evidence at that moment: it is
// left out and counted (future); a launch of exactly that moment is in.
function readRecords(dir, { fromMs = null, toMs = null, atMs = null } = {}, io = fs) {
  const guard = require('../lib/packet-gate.cjs');
  const names = guard.recordFolder(dir, io);
  if (names === null) return { records: [], sources: [], duplicates: 0, folder: 'absent' };
  const picked = names.filter(n => { const d = dayOf(n); return d !== null && (fromMs === null || d >= fromMs) && (toMs === null || d <= toMs); }).sort(cmp);
  const seen = new Set(); const records = []; const sources = []; let duplicates = 0; let unreadable = 0; let refused = 0; let future = 0; const refusals = {};
  let unproven = 0; const gaps = {};
  for (const name of picked) {
    const day = parseDay(guard.readDayFile(dir, name, io));
    let kept = 0;
    for (const rec of day.records) {
      if (Number.isFinite(atMs) && startMs(rec) > atMs) { future++; continue; }
      if (seen.has(rec.launchId)) { duplicates++; continue; } seen.add(rec.launchId); records.push(rec); kept++;
    }
    sources.push({ file: name, sha256: day.sha256, records: kept, unreadableLines: day.unreadable, refusedRecords: day.refused, unprovenRecords: day.unproven });
    unreadable += day.unreadable; refused += day.refused; addRefusals(refusals, day.refusals);
    unproven += day.unproven; addRefusals(gaps, day.gaps);
  }
  // a day file of a day after the moment holds no evidence at that moment: its lines are left out and counted, whatever they hold
  const later = Number.isFinite(atMs) ? names.filter(n => { const d = dayOf(n); return d !== null && d > atMs && (fromMs === null || d >= fromMs); }).sort(cmp) : [];
  for (const name of later) { const bytes = guard.readDayFile(dir, name, io); future += (Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)).split('\n').filter(l => l.trim()).length; }
  return { records, sources, duplicates, unreadable, refused, refusals: sortedRefusals(refusals), unproven, unprovenGaps: sortedRefusals(gaps), future, folder: 'present',
    skipped: names.filter(n => n.endsWith('.jsonl') && dayOf(n) === null).sort(cmp) };
}

// ---------- the activation mark (the coupled-set registry of the root) ----------
// The packet context is active from the mark on: the registry says on and names the UTC time of the switch in packetContextSince. A mark
// of a day or a time that does not exist (30 February, 24:00) is invalid, not the next day; a mark after now (nowMs, when given) is no mark yet.
function activationOf(text, nowMs) {
  if (text === null || text === undefined) return { state: 'off', sinceMs: null, reason: 'no-registry' };
  let data;
  try { data = require('../lib/text-safe.cjs').parseJsonUnique(String(text)); } catch { return { state: 'unknown', sinceMs: null, reason: 'registry-unreadable' }; }
  if (!data || typeof data !== 'object' || Array.isArray(data) || !['on', 'off'].includes(data.packetContext)) return { state: 'unknown', sinceMs: null, reason: 'registry-unreadable' };
  if (data.packetContext !== 'on') return { state: 'off', sinceMs: null, reason: 'switch-off' };
  const since = data.packetContextSince;
  if (since === undefined || since === null) return { state: 'on', sinceMs: null, reason: 'no-activation-mark' };
  if (typeof since !== 'string' || !ISO.test(since) || !Number.isFinite(Date.parse(since))) return { state: 'on', sinceMs: null, reason: 'activation-mark-invalid' };
  const sinceMs = Date.parse(since);
  if (new Date(sinceMs).toISOString().slice(0, 19) !== since.slice(0, 19)) return { state: 'on', sinceMs: null, reason: 'activation-mark-invalid' };
  if (Number.isFinite(nowMs) && sinceMs > nowMs) return { state: 'on', sinceMs: null, reason: 'activation-mark-in-the-future' };
  return { state: 'on', sinceMs, since: new Date(sinceMs).toISOString(), reason: null };
}

// ---------- P1: gated launches without a packet ----------
function coverage(records, fromMs = null, toMs = null) {
  const out = { launches: 0, missing: 0, author: { launches: 0, missing: 0 }, certifier: { launches: 0, missing: 0 }, refused: 0, preReview: 0 };
  for (const rec of records) {
    const at = startMs(rec);
    if ((fromMs !== null && at < fromMs) || (toMs !== null && at >= toMs)) continue;
    const kind = kindOf(rec);
    if (kind === 'refused') { out.refused++; continue; }
    if (kind === 'pre-review') { out.preReview++; continue; }
    if (kind !== 'author' && kind !== 'certifier') continue;
    const has = typeof rec.packetHash === 'string' && rec.packetHash !== '';
    out.launches++; out[kind].launches++;
    if (!has) { out.missing++; out[kind].missing++; }
  }
  return out;
}
// The pulse line: packet-missing with its count after the mark, or UNKNOWN with the reason the count does not exist and each refusal of the
// reader with its count; the launches after the moment of the measure that were left out and the records of no proven provenance, each gap
// with its count, are named when there are any.
function coverageLine(state) {
  if (!state || !state.counts) {
    const named = state && state.refusals ? Object.entries(state.refusals).map(([k, n]) => ` ${k}=${n}`).join('') : '';
    return `packet-missing=UNKNOWN reason=${(state && state.reason) || 'unreadable'}${named}`;
  }
  const c = state.counts;
  const unproven = c.unproven ? ` unproven=${c.unproven}${Object.entries(c.unprovenGaps || {}).map(([k, n]) => ` ${k}=${n}`).join('')}` : '';
  return `packet-missing=${c.missing} of=${c.launches} since=${state.since} author-missing=${c.author.missing}/${c.author.launches} certifier-missing=${c.certifier.missing}/${c.certifier.launches} refused=${c.refused}${unproven}${c.futureExcluded ? ` future-excluded=${c.futureExcluded}` : ''}`;
}

// The size of the packets of the launches after the mark: the delivered bytes of the author and certifier launches that carried a packet,
// as the median, the 75th percentile and the largest, and the launches by the context level of their record note (`none` for a packet
// without a context). A packet is sized by its task, so the size is measured here and never cut; the operator reviews a packet that grows
// past the measured norm. Unknown is null with its reason, never a zero.
function sizeOf(records, fromMs = null, toMs = null) {
  const bytes = [];
  const levels = {};
  let withoutBytes = 0;
  const trimmed = { launches: 0, rows: 0 };
  for (const rec of records) {
    const at = startMs(rec);
    if ((fromMs !== null && at < fromMs) || (toMs !== null && at >= toMs)) continue;
    const kind = kindOf(rec);
    if (kind !== 'author' && kind !== 'certifier') continue;
    if (typeof rec.packetHash !== 'string' || rec.packetHash === '') continue;
    if (!Number.isSafeInteger(rec.packetBytes) || rec.packetBytes < 0) { withoutBytes++; continue; }
    bytes.push(rec.packetBytes);
    const note = typeof rec.note === 'string' ? rec.note : '';
    const ctx = CONTEXT_NOTE.exec(note);
    const level = ctx ? ctx[1] : 'none';
    levels[level] = (levels[level] || 0) + 1;
    const left = ctx ? TRIMMED_NOTE.exec(note) : null;
    if (left) { trimmed.launches++; trimmed.rows += Number(left[1]); }
  }
  return { launches: bytes.length, withoutBytes, bytes: spread(bytes), levels: Object.fromEntries(Object.entries(levels).sort(([a], [b]) => cmp(a, b))), trimmed };
}
// The pulse line: the size and the context level of the packets after the mark, or UNKNOWN with the reason the count does not exist.
function sizeLine(state) {
  if (!state || !state.counts || !state.counts.size) return `packet-size=UNKNOWN reason=${(state && state.reason) || 'unreadable'}`;
  const z = state.counts.size;
  if (!z.bytes) return `packet-size=NONE launches=0${z.withoutBytes ? ` without-bytes=${z.withoutBytes}` : ''}`;
  const levels = Object.entries(z.levels).map(([k, n]) => `${k}=${n}`).join(',');
  return `packet-size median=${z.bytes.median} p75=${z.bytes.p75} max=${z.bytes.max} launches=${z.launches} levels=${levels}${z.trimmed && z.trimmed.launches ? ` trimmed=${z.trimmed.launches} trimmed-rows=${z.trimmed.rows}` : ''}${z.withoutBytes ? ` without-bytes=${z.withoutBytes}` : ''}`;
}

// ---------- git of the root ----------
function gitOf(root, run = spawnSync) {
  return args => {
    const r = run('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } });
    if (!r || r.error || r.status !== 0) throw Object.assign(new Error(`git ${args[0]} failed in the root`), { exitCode: 2 });
    return String(r.stdout);
  };
}
// The integration line: the stated ref, else the integration branch of the manifest of the root on origin, else the local branch.
function lineRef(root, stated, git, io = fs) {
  if (stated !== undefined) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/.test(stated)) throw usage(`line "${String(stated).slice(0, 60)}" is not a ref`);
    return stated;
  }
  let branch;
  try { branch = JSON.parse(io.readFileSync(path.join(root, 'protocol-manifest.json'), 'utf8')).integrationBranch; } catch { branch = undefined; }
  if (typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(branch)) throw usage('no --line and no integrationBranch in the manifest of the root');
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) { try { git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]); return ref; } catch { /* the next ref */ } }
  throw usage(`the integration branch ${branch} names no commit in the root`);
}
// The landings of the line whose commit time falls in [fromMs, toMs): branch, tip, the landing commit and its first parent.
function landings(git, ref, fromMs, toMs) {
  const rows = []; let other = 0;
  for (const entry of git(['log', '--first-parent', '--format=%x1e%H%x1f%P%x1f%ct%x1f%B', ref, '--']).split('\x1e')) {
    if (!entry.trim()) continue;
    const [commit, parents, seconds, body = ''] = entry.split('\x1f');
    const atMs = Number(seconds) * 1000;
    if (!(atMs >= fromMs && atMs < toMs)) continue;
    const m = LANDING.exec(body);
    if (!m) { other++; continue; }
    const trailer = LANDED_TIP.exec(body);
    rows.push({ branch: m[1], tip: trailer && trailer[1].startsWith(m[2]) ? trailer[1] : m[2], landing: commit, parent: parents.split(' ')[0], atMs });
  }
  rows.sort((a, b) => a.atMs - b.atMs || cmp(a.branch, b.branch));
  return { rows, other };
}
// The landed history of one package: its own commits (newest first, the tip at 0) and the fork commits on the line it grew from.
function historyOf(git, pkg) {
  try { git(['cat-file', '-e', `${pkg.tip}^{commit}`]); } catch { return null; }
  const lines = git(['rev-list', '--boundary', pkg.tip, `^${pkg.parent}`, '--']).split('\n').filter(Boolean);
  return { commits: lines.filter(l => !l.startsWith('-')), fork: lines.filter(l => l.startsWith('-')).map(l => l.slice(1)) };
}

// ---------- R1 and R4 of one package ----------
// The author rounds of a landed package: the author launches of its stream with distinct start heads that ended DONE, before the first
// certifying PASS or RECOMMENDATION on the final head (the certified commit nearest the tip). A launch belongs to the stream when its record
// names the stream, else when it started on a commit of the landed history, or on its fork commit in a worktree folder of the stream (one of
// the folders of its other rounds, or the folder named after the branch or after the branch without its first word). A record without
// the end marker of its round counts as ended (the marker is written only behind the gate), and the package says so.
function packageRounds(pkg, hist, records) {
  const row = { branch: pkg.branch, landing: pkg.landing.slice(0, 8), tip: pkg.tip.slice(0, 8), value: null, reason: null, rounds: null, endMarker: null, certified: null, attribution: null };
  if (!hist) return { ...row, reason: 'landed-tip-not-in-the-object-store' };
  const at = new Map(hist.commits.map((c, i) => [c.slice(0, 7), i]));
  const indexOf = head => { if (typeof head !== 'string' || head.length < 7) return null; const i = at.get(head.slice(0, 7)); return i !== undefined && hist.commits[i].startsWith(head) ? i : null; };
  const forkOf = head => (typeof head === 'string' && head.length >= 7 ? hist.fork.find(f => f.startsWith(head)) || null : null);
  const before = records.filter(r => startMs(r) < pkg.atMs);
  const certs = before.filter(r => kindOf(r) === 'certifier' && CERTIFYING.has(r.verdict) && indexOf(r.head) !== null && (r.stream === undefined || r.stream === pkg.branch));
  const authors = before.filter(r => kindOf(r) === 'author');
  const byStream = authors.filter(r => r.stream === pkg.branch);
  const onBranch = authors.filter(r => r.stream === undefined && indexOf(r.head) !== null);
  const dirs = new Set([...byStream, ...onBranch].map(r => r.workdir).filter(d => typeof d === 'string'));
  const names = new Set([pkg.branch, pkg.branch.slice(pkg.branch.indexOf('-') + 1)]);
  const folder = d => (typeof d === 'string' ? d.split(/[\\/]+/).filter(Boolean).pop() : undefined);
  const onFork = authors.filter(r => r.stream === undefined && indexOf(r.head) === null && forkOf(r.head) !== null && (dirs.has(r.workdir) || names.has(folder(r.workdir))));
  const own = [...byStream, ...onBranch, ...onFork];
  row.attribution = { stream: byStream.length, branchCommit: onBranch.length, forkFolder: onFork.length };
  if (!certs.length) return { ...row, reason: own.length ? 'no-certifying-verdict-on-the-landed-history' : 'no-author-launch-and-no-certifying-verdict' };
  const finalIndex = Math.min(...certs.map(r => indexOf(r.head)));
  const first = certs.filter(r => indexOf(r.head) === finalIndex).sort((a, b) => startMs(a) - startMs(b) || cmp(a.launchId, b.launchId))[0];
  row.certified = { head: hist.commits[finalIndex].slice(0, 8), launchId: first.launchId, verdict: first.verdict };
  const ended = own.filter(r => startMs(r) < startMs(first)).filter(r => { const m = AUTHOR_END.exec(typeof r.note === 'string' ? r.note : ''); return !m || m[1] === 'DONE'; });
  const marked = ended.filter(r => AUTHOR_END.test(typeof r.note === 'string' ? r.note : '')).length;
  row.endMarker = !ended.length ? null : marked === ended.length ? 'recorded' : marked === 0 ? 'not-recorded' : 'partly-recorded';
  // a start head as its full commit; the fork has the index one past the oldest commit of the landed history
  const start = new Map();
  for (const r of ended) {
    const i = indexOf(r.head);
    const sha = i !== null ? hist.commits[i] : forkOf(r.head);
    if (sha && !start.has(sha)) start.set(sha, i !== null ? i : hist.commits.length);
  }
  if (!start.size) return { ...row, reason: own.length ? 'no-author-launch-before-the-certifying-verdict' : 'no-author-launch-record' };
  row.rounds = start.size;
  row.value = start.size;
  // the rounds in time order (the oldest start first) and the head each one ends on: the next start, the certified head for the last
  row.heads = [...start.entries()].sort((a, b) => b[1] - a[1]).map(([sha]) => sha);
  row.finalHead = hist.commits[finalIndex];
  return row;
}
// The class of one fix round from the files it changed: mechanical (only the precert chores, with journals and reports), report-only (only
// journals, reports and reviews), empty (no change), or other.
function roundClass(files) {
  if (!files.length) return 'empty';
  if (files.every(neutral)) return 'report-only';
  return files.every(f => neutral(f) || Object.hasOwn(MECHANICAL, f)) ? 'mechanical' : 'other';
}
function fixRounds(git, row) {
  const out = [];
  for (let i = 1; i < row.heads.length; i++) {
    const to = i + 1 < row.heads.length ? row.heads[i + 1] : row.finalHead;
    const files = git(['diff', '--name-only', '--no-renames', row.heads[i], to, '--']).split('\n').filter(Boolean).sort(cmp);
    const kind = roundClass(files);
    out.push({ start: row.heads[i].slice(0, 8), kind, classes: kind === 'mechanical' ? [...new Set(files.filter(f => Object.hasOwn(MECHANICAL, f)).map(f => MECHANICAL[f]))].sort(cmp) : [] });
  }
  return out;
}

// ---------- the numbers ----------
// The median and the 75th percentile by the nearest rank; no number from an empty list.
function spread(values) {
  const v = values.slice().sort((a, b) => a - b);
  if (!v.length) return null;
  const rank = p => v[Math.max(0, Math.ceil(p * v.length) - 1)];
  return { n: v.length, median: rank(0.5), p75: rank(0.75), min: v[0], max: v[v.length - 1] };
}
// R2: the certification rounds per package of the M-003 leaf over the canonical reviews of the window; its refusal is kept as it is.
function certificationRounds(root, sinceDay, untilDay) {
  const leaf = require('../metrics/M-003.cjs');
  const { selectPackage } = require('../metrics/review-discovery.cjs');
  const rows = leaf.listPackage(path.join(root, 'docs', 'reviews'));
  const result = leaf.inventory(rows.sourceRefusal ? rows : selectPackage(rows, r => r.date >= sinceDay && r.date <= untilDay));
  if (result.reason) return { source: 'M-003', value: null, reason: result.reason, firstOffendingLine: result.firstOffendingLine === undefined ? null : result.firstOffendingLine, offendingLines: result.offendingLines || [] };
  return { source: 'M-003', value: result.value, reason: result.value === null ? 'no-readable-round' : null, unit: result.unit, denominator: result.denominator, reviews: result.reviews, packages: result.packages };
}
// R3: the severe findings of the canonical reviews of the window (CRITICAL, BLOCKER, HIGH, MAJOR and MEDIUM) whose class was already found
// on one of the same paths by an earlier review. The class is the Class field of the finding row from the closed list (task-context.cjs
// findingClassOf); a row without it reads as unknown, repeats nothing and is counted apart. The paths of a finding are the files of the line
// commit its row names. An earlier review has an earlier day, or the same day and a name that sorts first; the reviews before the window are
// earlier reviews too. The rows come through the findings extractor of the source repository (protocol-context.cjs findingsExtractor), and
// a checkout without it measures nothing. A share is printed only over at least SMALL classified findings.
const PATH_PATTERN = /[A-Za-z0-9_.@+~-]+(?:\/[A-Za-z0-9_.@+~-]+)+/g;
const REVIEW_NAME = /^\d{4}-\d{2}-\d{2}-[^/\\]+\.md$/;
function classRepeat({ root, lineCommit, sinceDay, untilDay, git }, deps = {}) {
  const io = deps.fs || fs;
  const extractor = deps.extractor !== undefined ? deps.extractor : require('../protocol-context.cjs').findingsExtractor();
  if (!extractor) return { value: null, reason: 'findings-extractor-absent' };
  const TC = require('../lib/task-context.cjs');
  const dir = path.join(root, 'docs', 'reviews');
  let names;
  try { names = io.readdirSync(dir).filter(n => REVIEW_NAME.test(n) && n.slice(0, 10) <= untilDay).sort(cmp); }
  catch (error) { if (error && error.code === 'ENOENT') return { value: null, reason: 'no-reviews' }; throw error; }
  const files = new Set(git(['ls-tree', '-r', '--name-only', '-z', lineCommit]).split('\0').filter(Boolean));
  const rows = [];
  for (const name of names) {
    let records = [];
    try { records = extractor.readReview(`docs/reviews/${name}`, io.readFileSync(path.join(dir, name))).records || []; } catch { records = []; }
    for (const r of records) {
      const text = `${r.full_row || ''}\n${r.text || ''}`;
      const paths = [...new Set((text.match(PATH_PATTERN) || []).map(p => p.replace(/\.+$/, '')))].filter(p => files.has(p));
      rows.push({ day: name.slice(0, 10), name, severe: TC.SEVERE.has(String(r.severity || '').toUpperCase()), cls: TC.findingClassOf(text), paths });
    }
  }
  const earlier = (e, row) => e.day < row.day || (e.day === row.day && e.name < row.name);
  let classified = 0; let repeated = 0; let unclassified = 0; let unplaced = 0;
  for (const row of rows) {
    if (row.day < sinceDay || !row.severe) continue;
    if (row.cls === 'unknown') { unclassified++; continue; }
    if (!row.paths.length) { unplaced++; continue; }
    classified++;
    if (rows.some(e => earlier(e, row) && e.cls === row.cls && e.paths.some(p => row.paths.includes(p)))) repeated++;
  }
  const counts = { unit: 'severe findings of the window with a class and a path of the line', classified, repeated, unclassified, unplaced };
  if (!classified) return { value: null, reason: 'no-classified-finding', ...counts };
  return { value: repeated, reason: classified >= SMALL ? null : 'small-number', ...counts, share: classified >= SMALL ? Math.round((repeated / classified) * 1000) / 1000 : null };
}

function windowMeasure({ root, since, until, line, recordsDir, startedAfter }, deps = {}) {
  if (!DAY.test(String(since)) || !DAY.test(String(until))) throw usage('--since and --until must be UTC days YYYY-MM-DD');
  const fromMs = Date.parse(`${since}T00:00:00Z`), lastMs = Date.parse(`${until}T00:00:00Z`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(lastMs) || lastMs < fromMs) throw usage('the window must name real days, the first not after the last');
  const afterMs = startedAfter === undefined ? null : ISO.test(startedAfter) ? Date.parse(startedAfter) : NaN;
  if (afterMs !== null && !Number.isFinite(afterMs)) throw usage('--started-after must be a UTC time');
  const io = deps.fs || fs;
  const git = deps.git || gitOf(root, deps.spawnSync);
  const ref = lineRef(root, line, git, io);
  const lineCommit = git(['rev-parse', '--verify', `${ref}^{commit}`]).trim();
  const toMs = lastMs + DAY_MS;
  const { rows, other } = landings(git, ref, fromMs, toMs);
  const read = readRecords(recordsDir, { toMs: lastMs }, io);
  const packages = [];
  for (const pkg of rows) {
    const hist = historyOf(git, pkg);
    let r = packageRounds(pkg, hist, read.records);
    if (r.value !== null && afterMs !== null) {
      const first = read.records.filter(x => kindOf(x) === 'author' && x.stream === pkg.branch).map(startMs).sort((a, b) => a - b)[0];
      if (!(first >= afterMs)) r = { ...r, value: null, reason: 'started-before-the-mark' };
    }
    if (r.heads) r.fixRounds = r.value === null ? [] : fixRounds(git, r);
    delete r.heads; delete r.finalHead;
    packages.push(r);
  }
  const measured = packages.filter(p => p.value !== null);
  const reasons = {};
  for (const p of packages) if (p.reason) reasons[p.reason] = (reasons[p.reason] || 0) + 1;
  const rounds = measured.flatMap(p => p.fixRounds || []);
  const count = kind => rounds.filter(r => r.kind === kind).length;
  const mechanical = count('mechanical');
  // P1 of the window from the day files of its days: a line of them that does not read or a record the reader refused may be a gated
  // launch of the window, so P1 is then unknown with the count of each, never a number; so is P1 over a record folder that does not exist.
  // The records of no proven provenance of the window are never in P1: their count stands beside it.
  const ofWindow = read.sources.filter(s => { const d = dayOf(s.file); return d >= fromMs && d <= lastMs; });
  const lost = { unreadableLines: ofWindow.reduce((n, s) => n + s.unreadableLines, 0), refusedRecords: ofWindow.reduce((n, s) => n + s.refusedRecords, 0) };
  const P1 = read.folder === 'absent' ? { unit: 'gated launches of the window without a packet', counts: null, reason: 'records-folder-absent' }
    : lost.unreadableLines || lost.refusedRecords
      ? { unit: 'gated launches of the window without a packet', counts: null, reason: lost.unreadableLines ? 'record-lines-unreadable' : 'records-refused', ...lost }
      : { unit: 'gated launches of the window without a packet', ...coverage(read.records, fromMs, toMs), unprovenRecords: ofWindow.reduce((n, s) => n + s.unprovenRecords, 0) };
  return {
    schema: SCHEMA, advisory: true, window: { since, until, startedAfter: afterMs === null ? null : new Date(afterMs).toISOString() },
    line: { ref, commit: lineCommit, landings: rows.length, otherCommits: other },
    records: { folder: read.folder, files: read.sources.length, records: read.records.length, duplicates: read.duplicates, unreadableLines: read.unreadable || 0,
      refusedRecords: read.refused || 0, refusals: read.refusals || {}, unprovenRecords: read.unproven || 0, unproven: read.unprovenGaps || {}, skipped: read.skipped || [], sources: read.sources },
    R1: { unit: 'author rounds per landed package', value: spread(measured.map(p => p.value)), reason: measured.length ? null : 'no-measurable-package',
      packages: { landed: packages.length, measured: measured.length, unknown: Object.fromEntries(Object.entries(reasons).sort(([a], [b]) => cmp(a, b))) },
      endMarker: { recorded: measured.filter(p => p.endMarker === 'recorded').length, partlyRecorded: measured.filter(p => p.endMarker === 'partly-recorded').length, notRecorded: measured.filter(p => p.endMarker === 'not-recorded').length } },
    R2: certificationRounds(root, since, until),
    R3: classRepeat({ root, lineCommit, sinceDay: since, untilDay: until, git }, deps),
    R4: { unit: 'mechanical fix rounds of the measured packages', fixRounds: rounds.length, mechanical, reportOnly: count('report-only'), empty: count('empty'), other: count('other'),
      share: rounds.length >= SMALL ? Math.round((mechanical / rounds.length) * 1000) / 1000 : null, reason: rounds.length >= SMALL ? null : 'small-number',
      classes: Object.fromEntries([...new Set(Object.values(MECHANICAL))].sort(cmp).map(c => [c, rounds.filter(r => r.classes.includes(c)).length])) },
    P1,
    packages,
  };
}

// ---------- after the activation ----------
function registryText(root, io = fs) {
  const file = path.join(root, ...require('../protocol-context.cjs').FILES.coupledSets.split('/'));
  try { return io.readFileSync(file, 'utf8'); } catch (error) { if (error && error.code === 'ENOENT') return null; throw error; }
}
// The count after the mark from the day files read for it. A line of them that does not read may be a gated launch whose text was damaged,
// so the count is unknown (record-lines-unreadable), never a number; so is a record the reader refused (records-refused, with each refusal
// and its count). A record folder that does not exist holds no record that proves a count: the count is unknown (records-folder-absent).
// The launches after the moment of the measure are not in the records; their count stands beside the counts, and so does the count of the
// records of no proven provenance with each gap (they are never in the counts). The pulse takes the same rule from here.
function coverageAfter(mark, read) {
  if (read.folder === 'absent') return { ...mark, counts: null, reason: 'records-folder-absent' };
  if (read.unreadable) return { ...mark, counts: null, reason: 'record-lines-unreadable', unreadableLines: read.unreadable };
  if (read.refused) return { ...mark, counts: null, reason: 'records-refused', refusedRecords: read.refused, refusals: read.refusals };
  return { ...mark, counts: { ...coverage(read.records, mark.sinceMs, null), size: sizeOf(read.records, mark.sinceMs, null), unproven: read.unproven || 0, unprovenGaps: read.unprovenGaps || {}, futureExcluded: read.future || 0 } };
}
// The moment of the measure is a required input of the helpers: it decides whether the mark is past and which launches are evidence, so a
// helper never reads the clock and a missing moment is a refusal by name. The command line names it (--now, else the clock once).
function momentOf(nowMs) {
  if (!Number.isFinite(nowMs)) throw Object.assign(new Error('moment-of-the-measure-missing: nowMs, the moment of the measure, is a required time'), { reason: 'moment-of-the-measure-missing', exitCode: 2 });
  return nowMs;
}
function coverageMeasure({ root, recordsDir, nowMs }, deps = {}) {
  const at = momentOf(nowMs);
  const io = deps.fs || fs;
  const mark = activationOf(registryText(root, io), at);
  if (mark.sinceMs === null) return { ...mark, counts: null };
  const read = readRecords(recordsDir, { fromMs: Math.floor(mark.sinceMs / DAY_MS) * DAY_MS, toMs: at, atMs: at }, io);
  return coverageAfter(mark, read);
}
// The proof that the bypass of the packet is gone: the first author and certifier launches after the mark, each with its packet hash, its
// profile and a context made for the head it started on. Prepared only: it names the register row and the proof file the operator commits.
// A line of the day files read for it that does not read may be one of those launches: the proof is not ready (record-lines-unreadable);
// so is a record the reader refused (records-refused, with each refusal and its count): the proof is built only from launch records the
// reader took. A launch after the moment of the measure is no evidence at that moment: it is left out, and the proof states how many
// (futureExcluded; null when no record was read). A record of no proven provenance is never one of the launches of the proof: the proof
// states their count with each gap (unprovenRecords, unproven), and a proof short of launches while such records exist says so
// (fewer-than-N-proven-launches).
function removedProof({ root, recordsDir, nowMs }, deps = {}) {
  const at = momentOf(nowMs);
  const io = deps.fs || fs;
  const mark = activationOf(registryText(root, io), at);
  const out = { schema: 'packet-removed-proof/1', ready: false, since: mark.since || null, reason: mark.reason, author: [], certifier: [], register: null, futureExcluded: null };
  if (mark.sinceMs === null) return out;
  const read = readRecords(recordsDir, { fromMs: Math.floor(mark.sinceMs / DAY_MS) * DAY_MS, toMs: at, atMs: at }, io);
  out.futureExcluded = read.future || 0;
  if (read.folder === 'absent') return { ...out, reason: 'records-folder-absent' };
  out.unprovenRecords = read.unproven || 0; out.unproven = read.unprovenGaps || {};
  if (read.unreadable) return { ...out, reason: 'record-lines-unreadable', unreadableLines: read.unreadable };
  if (read.refused) return { ...out, reason: 'records-refused', refusedRecords: read.refused, refusals: read.refusals };
  const after = read.records.filter(r => startMs(r) >= mark.sinceMs).sort((a, b) => startMs(a) - startMs(b) || cmp(a.launchId, b.launchId));
  // the reader took only records of the closed schema: a packet hash is a sha256 or empty, a profile is of its closed list or absent
  for (const kind of ['author', 'certifier']) {
    out[kind] = after.filter(r => kindOf(r) === kind).slice(0, PROOF_LAUNCHES).map(r => {
      const ctx = CONTEXT_NOTE.exec(typeof r.note === 'string' ? r.note : '');
      const why = typeof r.packetHash !== 'string' || !r.packetHash ? 'no-packet-hash' : r.packetProfile === undefined ? 'no-packet-profile'
        : !ctx ? 'no-context-note' : typeof r.head !== 'string' || r.head.length < 7 || !ctx[2].startsWith(r.head) ? 'context-of-another-head' : null;
      return { launchId: r.launchId, head: typeof r.head === 'string' ? r.head : null, packetHash: r.packetHash || null, contextCommit: ctx ? ctx[2] : null, ok: why === null, reason: why };
    });
  }
  const short = ['author', 'certifier'].filter(k => out[k].length < PROOF_LAUNCHES);
  const bad = ['author', 'certifier'].flatMap(k => out[k].filter(x => !x.ok));
  out.ready = !short.length && !bad.length;
  out.reason = out.ready ? null : short.length ? `fewer-than-${PROOF_LAUNCHES}-${out.unprovenRecords ? 'proven-' : ''}launches:${short.join(',')}` : 'a-launch-without-its-packet';
  // the open rows of the register whose kernel home is the packet compiler, and the change the operator applies once the proof is committed
  const lib = require('../lib/bypass-register.cjs');
  const home = require('../lib/packet-gate.cjs').PACKET_HOME;
  let rows = [];
  try { rows = JSON.parse(io.readFileSync(path.join(root, ...lib.FILE.split('/')), 'utf8')).bypasses.filter(b => b && b.status === 'open' && String(b.kernelHome).split(',').map(s => s.trim()).includes(home)).map(b => b.id); } catch { rows = []; }
  const proofFile = path.posix.join('docs', 'ops', ['PACKET', 'ACTIVATION', 'PROOF'].join('-') + '.json');
  out.register = { rows, change: { status: 'removed', removedProof: proofFile }, proofFile, applied: false };
  return out;
}

// ---------- CLI ----------
function parse(argv) {
  const [command, ...rest] = argv;
  const known = { window: ['since', 'until', 'line', 'records', 'started-after', 'root'], coverage: ['records', 'root', 'now'], 'removed-proof': ['records', 'root', 'now'] };
  if (!Object.hasOwn(known, command)) throw usage('usage: packet-measure.cjs window|coverage|removed-proof [options]');
  const o = {};
  for (let i = 0; i < rest.length; i++) {
    const key = rest[i].replace(/^--/, '');
    if (!rest[i].startsWith('--') || !known[command].includes(key) || Object.hasOwn(o, key) || rest[i + 1] === undefined || rest[i + 1].startsWith('--')) throw usage(`unknown or repeated option ${rest[i]}`);
    o[key] = rest[++i];
  }
  return { command, o };
}
function main(argv, deps = {}) {
  const stdout = deps.stdout || (s => process.stdout.write(s));
  const stderr = deps.stderr || (s => process.stderr.write(s));
  try {
    const { command, o } = parse(argv);
    const root = path.resolve(o.root || process.cwd());
    const recordsDir = path.resolve(o.records || require('../repo-paths.cjs').pendingDir(deps.env || process.env, root));
    if (command === 'window') { stdout(`${JSON.stringify(windowMeasure({ root, since: o.since, until: o.until, line: o.line, recordsDir, startedAfter: o['started-after'] }, deps), null, 1)}\n`); return 0; }
    const nowMs = o.now === undefined ? Date.now() : ISO.test(o.now) ? Date.parse(o.now) : NaN;
    if (!Number.isFinite(nowMs)) throw usage('--now must be a UTC time');
    if (command === 'coverage') { const state = coverageMeasure({ root, recordsDir, nowMs }, deps); stdout(`${coverageLine(state)}\n${sizeLine(state)}\n`); return 0; }
    const proof = removedProof({ root, recordsDir, nowMs }, deps);
    stdout(`${JSON.stringify(proof, null, 1)}\n`);
    return proof.ready ? 0 : 1;
  } catch (error) {
    stderr(`PACKET-MEASURE ${String((error && error.message) || error).replace(/[\r\n]+/g, ' ').slice(0, 200)}\n`);
    return 2;
  }
}

module.exports = { SCHEMA, MECHANICAL, kindOf, recordRefusal, provenanceGap, dayOf, parseDay, readRecords, activationOf, coverage, coverageAfter, coverageLine, sizeOf, sizeLine, landings, historyOf, packageRounds, roundClass, fixRounds, spread, certificationRounds, classRepeat, PATH_PATTERN, windowMeasure, coverageMeasure, removedProof, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

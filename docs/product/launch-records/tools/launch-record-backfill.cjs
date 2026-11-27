'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const CALLER = 'launch-record-backfill';
const CLIENT_PATTERNS = [
  ['codex', /\bcodex['",\s]+exec\b|'codex',\s*'exec'/],
  ['mimo', /\bmimo['",\s]+run\b|'mimo',\s*'run'/],
  ['claude', /\bclaude\b.{0,80}(-p|--model|--effort)|'claude',\s*'-p'/],
  ['agy', /\bagy\b.{0,80}(-p|--effort)|'agy',/],
  ['kilo', /\bkilo\b['",\s]+run\b|'kilo',\s*'run'/],
  ['vibe', /\bvibe\b['",\s]+(-p|--prompt)|VIBE_ACTIVE_MODEL|'vibe',/],
  ['copilot', /\bcopilot\b.{0,40}(-p|--model)|'copilot',/],
];

const stampOf = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const slug = s => String(s || 'run').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'run';
const sha256File = p => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return null; } };

function constOf(text, name) {
  const m = new RegExp(`\\bconst\\s+${name}\\s*=\\s*(?:path\\.join\\([^)]*\\)|'([^']*)'|"([^"]*)")`).exec(text);
  if (!m) return null;
  // A JS string literal: "\\\\" in the source is one backslash in the value.
  const unescape = s => s.replace(/\\\\/g, '\\');
  if (m[1] !== undefined || m[2] !== undefined) return unescape(m[1] !== undefined ? m[1] : m[2]);
  const parts = [...m[0].matchAll(/'([^']*)'|"([^"]*)"/g)].map(x => x[1] !== undefined ? x[1] : x[2]);
  return parts.length ? unescape(parts[parts.length - 1]) : null;
}

function readFlag(text, flags) {
  for (const flag of flags) {
    const lit = new RegExp(`['"]${flag}['"],\\s*['"]([^'"]+)['"]`).exec(text) || new RegExp(`${flag}\\s+([A-Za-z0-9._/:-]+)`).exec(text);
    if (lit) return lit[1];
  }
  return null;
}

// What a launcher says about itself. Returns only what is written there.
function readLauncher(file) {
  const text = fs.readFileSync(file, 'utf8');
  const out = { launcher: path.basename(file), client: null, model: null, effort: null, done: null, call: null, prompt: null, workdir: null };
  for (const [client, re] of CLIENT_PATTERNS) if (re.test(text)) { out.client = client; break; }
  const done = /\bconst\s+DONE\s*=\s*'([A-Z0-9_]+)'/.exec(text) || /['"]?([A-Z][A-Z0-9_]{4,}_DONE)\b/.exec(text);
  out.done = done ? done[1] : null;
  out.call = constOf(text, 'CALL') || constOf(text, 'CALL_FILE') || constOf(text, 'OUT');
  out.prompt = constOf(text, 'PROMPT_FILE') || constOf(text, 'PROMPT_PATH');
  out.workdir = constOf(text, 'WORKDIR') || constOf(text, 'WORKTREE') || constOf(text, 'TREE');
  const modelConst = constOf(text, 'MODEL');
  out.model = modelConst || readFlag(text, ['-m', '--model']) || (/VIBE_ACTIVE_MODEL['"]?\s*[:=]\s*['"]([^'"]+)['"]/.exec(text) || [])[1] || null;
  out.effort = readFlag(text, ['--variant', '--effort']) || (/model_reasoning_effort=([a-z]+)/.exec(text) || [])[1] || null;
  return out;
}

// Every completion marker in a call file is one launch: "<DONE> exit=<n> end=<iso>" (end optional in old files), and
// the start marker "# <DONE> start=<iso> pid=<n> model=<id>" when the launcher wrote one.
function readCallFile(file, done) {
  if (!file || !fs.existsSync(file) || !done) return [];
  const text = fs.readFileSync(file, 'utf8');
  const starts = [...text.matchAll(new RegExp(`^# ${done} start=(\\S+)(?: pid=\\d+)?(?: model=(\\S+))?`, 'gm'))].map(m => ({ at: m[1], model: m[2] || null, idx: m.index }));
  const ends = [...text.matchAll(new RegExp(`${done}\\s+exit=(-?\\d+)(?:\\s+end=(\\S+))?`, 'g'))].map(m => ({ exit: Number(m[1]), end: m[2] || null, idx: m.index }));
  const mtime = fs.statSync(file).mtime.toISOString().replace(/\.\d+Z$/, 'Z');
  return ends.map((e, i) => {
    const prevEnd = i > 0 ? ends[i - 1].idx : -1;
    const start = starts.filter(s => s.idx > prevEnd && s.idx < e.idx).pop() || null;
    const last = i === ends.length - 1;
    // The existing journal's precedent (endedAtNote "approx, from the report file mtime"): with no written end time, only the
    // LAST marker of a file may take the file's modification time; earlier markers of the same file get no time at all.
    return { exitCode: e.exit, endedAt: e.end || (last ? mtime : null), endedFromMtime: !e.end && last, startedAt: start && start.at, reportedModel: start && start.model };
  });
}

// ---- call file segments (cost-record): one segment per finished launch of a call file ----
// cert-launch.cjs / fix-launch.cjs append `marker=<NAME>_DONE`, the captured client output, optional USAGE / SERVED lines and the terminal line
// `<NAME>_DONE exit=<n> [report=..] end=<ISO>` for every launch; a segment is everything after the previous terminal line up to and including the next one.
// A launch whose terminal line is missing has no segment (nothing is guessed). { name, slug, exit, end, text }.
const TERMINAL_LINE = /^(\S+?)_(?:DONE|NO_VERDICT|SERVED_MODEL_MISMATCH) exit=(-?\d+|null|[A-Za-z_]+)(?: report=\S+)? end=(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s*$/;
function callSegments(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const out = []; let start = 0;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    const m = TERMINAL_LINE.exec(line.replace(/\r$/, ''));
    if (!m) return;
    out.push({ name: m[1], slug: slug(m[1]), exit: m[2], end: m[3], text: lines.slice(start, i + 1).join('\n') });
    start = i + 1;
  });
  return out;
}
// slug -> call file paths, from file NAMES only (nothing is read): <name>-call.txt
function callFilesBySlug(runtimeDir) {
  const map = new Map();
  let names = [];
  try { names = fs.readdirSync(runtimeDir).filter(n => /-call\.txt$/.test(n)); } catch { return map; }
  for (const n of names) {
    const s = slug(n.replace(/-call\.txt$/, ''));
    if (!map.has(s)) map.set(s, []);
    map.get(s).push(path.join(runtimeDir, n));
  }
  return map;
}

function build(launcher, call, runtimeDir) {
  const rec = {};
  const conf = {};
  const isTime = t => typeof t === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(t) && !Number.isNaN(Date.parse(t));
  let startedAt = isTime(call.startedAt) ? new Date(call.startedAt) : null;
  const endedAt = isTime(call.endedAt) ? new Date(call.endedAt) : null;
  // A model run is never shorter than two seconds: a "start" that is not at least that far before the end was written when
  // the launcher finished, so it is not a start. It is dropped instead of being reported as a zero-second run.
  let startDropped = false;
  if (startedAt && endedAt && endedAt - startedAt < 2000) { startedAt = null; startDropped = true; }
  if (!startedAt && !endedAt) return null; // no time at all: nothing to anchor an id on
  const anchor = startedAt || endedAt;
  const name = launcher.launcher.replace(/-launch\.cjs$/, '');
  rec.schema = 'launch-record/1';
  rec.launchId = `L-${stampOf(anchor)}-${slug(name)}`;
  // A start time that is missing is not guessed: the record is a full record with the end time only, and says so.
  rec.startedAt = (startedAt || endedAt).toISOString();
  conf.startedAt = startedAt ? 'exact' : 'unknown';
  if (endedAt) {
    rec.endedAt = endedAt.toISOString();
    conf.endedAt = call.endedFromMtime ? 'inferred' : 'exact';
    if (call.endedFromMtime) rec.endedAtNote = 'approx, from the call file mtime';
  }
  if (!startedAt && endedAt) rec.startedAtNote = startDropped
    ? 'startedAt is the end time: the written start was less than 2 s before the end (written at finish), so it was dropped'
    : 'startedAt is the end time: the launcher wrote no start time';
  rec.callerSession = CALLER;
  rec.channel = 'catalog-layer';
  rec.viaDispatch = false;
  rec.backfilled = true;
  rec.task = name;
  if (launcher.prompt) {
    rec.promptPath = launcher.prompt;
    const sha = sha256File(path.isAbsolute(launcher.prompt) ? launcher.prompt : path.join(path.dirname(runtimeDir), launcher.prompt));
    if (sha) { rec.promptSha256 = sha; conf.promptSha256 = 'derived'; }
  }
  const model = call.reportedModel || launcher.model || null;
  rec.tuple = { client: launcher.client || 'unknown', model, effort: launcher.effort || null };
  conf.client = launcher.client ? 'derived' : 'unknown';
  conf.model = call.reportedModel ? 'exact' : launcher.model ? 'inferred' : 'unknown';
  conf.effort = launcher.effort ? 'inferred' : 'unknown';
  rec.exitCode = call.exitCode;
  conf.exitCode = 'exact';
  if (startedAt && endedAt) { rec.wallSeconds = Math.round((endedAt - startedAt) / 100) / 10; conf.wallSeconds = 'derived'; }
  if (call.exitCode !== 0) { rec.failureClass = call.exitCode === 3221225786 ? 'INTERRUPTED' : 'UNKNOWN'; conf.failureClass = call.exitCode === 3221225786 ? 'derived' : 'unknown'; }
  rec.confidence = conf;
  rec.source = `${launcher.launcher} + ${path.basename(launcher.call || 'call-file')}`;
  return rec;
}

// `before` (ISO time): records that ended at or after it are left out and counted in report.afterCutoff. It is the cut
// between the backfill and the live helper, so one launch is never recorded twice (once rebuilt, once written live).
function backfill(runtimeDir, before) {
  const cutoff = before ? Date.parse(before) : null;
  const launchers = fs.readdirSync(runtimeDir).filter(n => n.endsWith('-launch.cjs')).sort();
  const records = [];
  const report = { launchers: launchers.length, unreadable: [], noDone: [], noCallFile: [], noMarker: [], notLaunched: [], noTime: [], clientUnknown: [], modelUnknown: [], recordsBuilt: 0 };
  const seen = new Set();
  for (const name of launchers) {
    let l;
    try { l = readLauncher(path.join(runtimeDir, name)); } catch (e) { report.unreadable.push(name); continue; }
    if (!l.done) { report.noDone.push(name); continue; }
    const callPath = l.call ? (path.isAbsolute(l.call) ? l.call : path.join(path.dirname(runtimeDir), l.call)) : null;
    const resolved = callPath && fs.existsSync(callPath) ? callPath : path.join(runtimeDir, `${name.replace(/-launch\.cjs$/, '')}-call.txt`);
    if (!fs.existsSync(resolved)) { report.noCallFile.push(name); continue; }
    l.call = resolved;
    const calls = readCallFile(resolved, l.done);
    if (!calls.length) {
      // A call file overwritten by "exit=PREFLIGHT_FAIL" or "exit=QUIET_TIMEOUT" means the launcher refused to start the agent:
      // that is not a launch of a model, so it is counted apart and never becomes a record.
      const body = fs.readFileSync(resolved, 'utf8');
      (/\bexit=(PREFLIGHT_FAIL|QUIET_TIMEOUT)\b/.test(body) ? report.notLaunched : report.noMarker).push(name);
      continue;
    }
    if (!l.client) report.clientUnknown.push(name);
    if (!l.model) report.modelUnknown.push(name);
    for (const c of calls) {
      const rec = build(l, c, runtimeDir);
      if (!rec) { report.noTime.push(name); continue; }
      if (cutoff !== null && Date.parse(rec.endedAt) >= cutoff) { report.afterCutoff = (report.afterCutoff || 0) + 1; continue; }
      let id = rec.launchId; let n = 2;
      while (seen.has(id)) id = `${rec.launchId}-${n++}`;
      rec.launchId = id; seen.add(id);
      records.push(rec);
    }
  }
  report.recordsBuilt = records.length;
  return { records, report };
}

function main(argv) {
  const opt = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--runtime') opt.runtime = argv[++i];
    else if (argv[i] === '--out') opt.out = argv[++i];
    else if (argv[i] === '--report') opt.report = true;
    else if (argv[i] === '--before') opt.before = argv[++i];
    else { process.stdout.write(`ERROR unknown argument ${argv[i]}\n`); return 2; }
  }
  if (!opt.runtime || !fs.existsSync(opt.runtime)) { process.stdout.write('ERROR --runtime <dir with *-launch.cjs and *-call*.txt> is required\n'); return 2; }
  if (opt.before !== undefined && Number.isNaN(Date.parse(opt.before))) { process.stdout.write('ERROR --before must be an ISO time\n'); return 2; }
  if (opt.out && (/[\\/]\.ai[\\/]/.test(path.resolve(opt.out)) || /model-ladder\.json$/i.test(opt.out))) { process.stdout.write('ERROR refusing to write into .ai/ or model-ladder.json (PROTO-DEC-0143 item 3)\n'); return 2; }
  const { records, report } = backfill(path.resolve(opt.runtime), opt.before);
  if (opt.out) {
    records.sort((a, b) => (a.startedAt < b.startedAt ? -1 : a.startedAt > b.startedAt ? 1 : a.launchId < b.launchId ? -1 : 1));
    fs.writeFileSync(path.resolve(opt.out), records.map(r => JSON.stringify(r)).join('\n') + '\n');
  }
  if (opt.report || !opt.out) process.stdout.write(JSON.stringify(report, (k, v) => (Array.isArray(v) && v.length > 12 ? { count: v.length, first: v.slice(0, 12) } : v), 2) + '\n');
  process.stdout.write(`RESULT exit=0 launchers=${report.launchers} records=${report.recordsBuilt}${opt.out ? ' out=' + opt.out : ''}\n`);
  return 0;
}

module.exports = { readLauncher, readCallFile, callSegments, callFilesBySlug, build, backfill, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

'use strict';
// launch-fill.cjs - fill (coverage) of launch-record/1 extension fields, per channel, plus an evidence-only
// backfill. Class B catalog-layer tool (PROTO-DEC-0143 item 3): reads files; the only write is a NEW backfill
// file, never the journal and never an existing launches/*.jsonl.
// Channels are never mixed (PROTO-DEC-0145 item 1): the LAUNCHES channel (launch-record/1) and the RUNS channel
// (run-record/1) are measured and printed apart, and no number joins them; a cross-channel view is an explicit
// join on the channel label only.
// Honesty (LAUNCH-RECORD-EXT.md): a field counts as filled only when a value exists and, on a backfilled record,
// its confidence is exact or derived; unknown, null or absent is skipped, never imputed. The backfill derives a
// field only from evidence that exists (terminal markers, call files, wrapper running/terminal json, launcher
// constants, git) and records the confidence of every value it writes.
//   node launch-fill.cjs report   [--journal f] [--pending dir] [--runs f] [--runtime dir] [--repo dir] [--json] [--now ISO]
//   node launch-fill.cjs backfill [--journal f] [--pending dir] [--runtime dir] [--repo dir] [--out f] [--apply] [--json] [--now ISO]
//   node launch-fill.cjs served   [--journal f] [--pending dir | --include-pending] [--session-root DIR] [--out f] [--apply] [--json] [--now ISO]  (vibe: served model from the session store)
// Exit: 0 ok / dry run; 1 derived records that fail the validator; 2 usage or unreadable input.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const validator = require('./launch-record-validate.cjs');
const backfillLib = require('./launch-record-backfill.cjs');
const atomic = require('./lib/atomic.cjs');

const BASE = path.resolve(__dirname, '..', 'launches');
const DEFAULT_JOURNAL = path.join(BASE, 'LAUNCHES.jsonl');
const DEFAULT_PENDING = path.join(BASE, 'pending');
const DEFAULT_RUNS = path.resolve(__dirname, '..', '..', '..', 'ops', 'RUNS.jsonl');
const DEFAULT_BACKFILL_DIR = path.join(BASE, 'backfill');
const LAUNCH_SCHEMA = 'launch-record/1';
const RUNS_SCHEMA = 'run-record/1';
const USABLE = new Set(['exact', 'derived']);
const CALLER = 'claude-launch-fill';
const FORBIDDEN_OUT = [/[\\/]\.ai[\\/]/, /model-ladder\.json$/i];
const CLI_CLIENTS = new Set(['codex', 'mimo', 'claude', 'kilo', 'agy', 'vibe', 'copilot']);
const INTERRUPTED_CODES = new Set([3221225786, 137, 143, -1073741510, 130]);
const PROFILE_ENUM = new Set(['auto', '1', '2', '3', '4', 'full']);
const RISK_ENUM = new Set(['A', 'B']);
const STAGE_ENUM = new Set(['intake', 'frame', 'triage', 'dispatch', 'execute', 'accept', 'freeze', 'close', 'session', 'research', 'any', 'unknown']);

// A-2 extension fields (confidence and source are provenance, not coverage).
const EXT_FIELDS = ['role', 'stage', 'taskClass', 'packetHash', 'packetProfile', 'reviewOutcome', 'route', 'riskClass', 'tier', 'attempt', 'retryOf', 'failureClass', 'reviewRounds', 'reviewerLaunchId', 'variant', 'pairId', 'packetBytes', 'packetEstTokens', 'findingsCount', 'wallSeconds'];
// The set the FROZEN measurement named ( 4.1): extension-fields LAUNCHES.jsonl = 0/29.
const MEASURED_FIELDS = ['role', 'tier', 'taskClass', 'packetHash', 'reviewOutcome', 'reviewRounds', 'failureClass', 'packetBytes'];
// Base probes named beside it (model 16/29; exit 1/29).
// tokens and cost (cost-record): filled = the client's tokens are known (some number), resp. the cost is priced or a flat-fee subscription; an unknown cost object does not count.
const BASE_PROBE = ['model', 'exitCode', 'tokens', 'cost'];
const tokensKnown = t => t !== null && t !== undefined && (typeof t === 'number' ? t > 0 : typeof t === 'object' && [t.input, t.output, t.total].some(x => Number.isInteger(x)));
const costKnown = c => c !== null && c !== undefined && (typeof c === 'number' ? c >= 0 : typeof c === 'object' && (c.basis === 'priced' || c.basis === 'subscription'));
const usageProbe = { tokens: tokensKnown, cost: costKnown };
const RUNS_FIELDS = ['role', 'selection', 'frame', 'resolution', 'pins', 'attempts'];

const usage = msg => { process.stdout.write(`ERROR ${msg}\n`); return 2; };
const isFile = p => { try { return fs.statSync(p).isFile(); } catch { return false; } };
const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const readText = f => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const slug = s => String(s || 'run').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'run';
const stampOf = d => d.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
const isTime = t => typeof t === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(t) && !Number.isNaN(Date.parse(t));
const isUsable = (rec, field) => rec.backfilled !== true || USABLE.has(rec.confidence && rec.confidence[field]);
const present = (rec, field) => { const v = rec[field]; return v !== undefined && v !== null && v !== ''; };

function readJsonl(file) {
  const out = [];
  if (!fs.existsSync(file)) return out;
  String(readText(file) || '').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try { out.push(JSON.parse(line)); } catch (e) { throw new Error(`${path.basename(file)}:${i + 1}: invalid JSON`); }
  });
  return out;
}
const jsonlIn = dir => (fs.existsSync(dir) ? fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort().map(n => path.join(dir, n)) : []);

function groupLaunches(recs) {
  const by = new Map();
  for (const r of recs) {
    if (!r || typeof r !== 'object' || !r.launchId) continue;
    const g = by.get(r.launchId) || { id: r.launchId, start: null, fin: null, reviews: [], extra: [] };
    if (r.event === 'review') g.reviews.push(r); else if (r.event === 'finished') g.fin = r; else g.start = r;
    by.set(r.launchId, g);
  }
  return [...by.values()];
}
const scanRecords = g => [g.start, g.fin, ...g.reviews, ...g.extra].filter(Boolean);
function fieldOf(g, field) {
  for (const rec of scanRecords(g)) {
    if (!present(rec, field)) continue;
    if (!isUsable(rec, field)) continue;
    return { value: rec[field], rec };
  }
  return null;
}
function baseProbe(g, field) {
  if (field === 'model') {
    for (const rec of [g.start, g.fin]) if (rec && rec.tuple && rec.tuple.model && isUsable(rec, 'model')) return { value: rec.tuple.model, rec };
    return null;
  }
  if (field === 'exitCode') {
    for (const rec of [g.fin, g.start]) if (rec && typeof rec.exitCode === 'number' && isUsable(rec, 'exitCode')) return { value: rec.exitCode, rec };
  }
  if (usageProbe[field]) {
    for (const rec of [g.fin, g.start, ...g.reviews, ...g.extra]) if (rec && usageProbe[field](rec[field]) && isUsable(rec, field)) return { value: rec[field], rec };
  }
  return null;
}
const readerFor = field => (BASE_PROBE.includes(field) ? g => baseProbe(g, field) : g => fieldOf(g, field));
function measure(groups, fields) {
  const total = groups.length; const rows = {};
  for (const f of fields) {
    const read = readerFor(f); let filled = 0; let exact = 0; let derived = 0;
    for (const g of groups) {
      const hit = read(g); if (!hit) continue;
      filled++;
      const c = hit.rec.backfilled === true ? hit.rec.confidence && hit.rec.confidence[f] : null;
      if (c === 'exact') exact++; else if (c === 'derived') derived++;
    }
    rows[f] = { filled, total, pct: total ? Math.round(1000 * filled / total) / 10 : null, exact, derived };
  }
  return rows;
}
const recordHas = (rec, f) => (BASE_PROBE.includes(f) ? (usageProbe[f] ? usageProbe[f](rec[f]) && isUsable(rec, f) : f === 'model' ? !!(rec.tuple && rec.tuple.model && isUsable(rec, 'model')) : typeof rec.exitCode === 'number' && isUsable(rec, 'exitCode')) : present(rec, f) && isUsable(rec, f));
function measureRecords(recs, fields) {
  const total = recs.length; const rows = {};
  for (const f of fields) { let filled = 0; for (const rec of recs) if (recordHas(rec, f)) filled++; rows[f] = { filled, total, pct: total ? Math.round(1000 * filled / total) / 10 : null }; }
  return rows;
}
const withAny = (groups, fields) => groups.filter(g => fields.some(f => readerFor(f)(g))).length;
const recordsWithAny = (recs, fields) => recs.filter(rec => fields.some(f => recordHas(rec, f))).length;
const pctText = r => (r.total === 0 ? 'n/a' : `${r.pct.toFixed(1)}%`);
function table(title, rows, count, unit) {
  const lines = [title, `${unit}=${count}`, 'field                     filled      pct'];
  for (const f of Object.keys(rows)) { const r = rows[f]; lines.push(`${f.padEnd(22)}${String(r.filled).padStart(7)}${pctText(r).padStart(9)}`); }
  return lines;
}
const measuredLine = (label, n, total) => `${label}: ${n}/${total}${total ? ` (${(100 * n / total).toFixed(1)}%)` : ''}`;

// ---- evidence (read-only) ---------------------------------------------------------------------------------

function splitTop(body) {
  const parts = []; let depth = 0; let cur = '';
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '"' || ch === '\'') {
      cur += ch; i++;
      while (i < body.length) { cur += body[i]; if (body[i] === '\\') { i++; if (i < body.length) cur += body[i]; } else if (body[i] === ch) break; i++; }
    } else if ('{(['.includes(ch)) { depth++; cur += ch; } else if ('})]'.includes(ch)) { depth--; cur += ch; }
    else if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  return parts;
}
function matchBrace(text, open) {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' || ch === '\'') { const q = ch; i++; while (i < text.length) { if (text[i] === '\\') { i += 2; continue; } if (text[i] === q) break; i++; } }
    else if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) return i; }
  }
  return -1;
}
function strLit(s) {
  if (s[0] !== '\'' && s[0] !== '"') return undefined;
  const q = s[0]; let out = '';
  for (let i = 1; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\') { const n = s[++i]; out += n === 'n' ? '\n' : n === 't' ? '\t' : n; }
    else if (ch === q) return out; else out += ch;
  }
  return undefined;
}
function litValue(rest) {
  rest = rest.trim();
  if (rest[0] === '\'' || rest[0] === '"') return strLit(rest);
  if (/^-?\d+(\.\d+)?$/.test(rest)) return Number(rest);
  if (rest === 'true') return true;
  if (rest === 'false') return false;
  return undefined;
}
// Reads only string/number/boolean literals from the writeLaunchRecord({...}) call; a ternary, spread or
// identifier value is left out (never imputed).
function readRecordLiteral(text) {
  const marker = 'writeLaunchRecord(';
  const at = text.indexOf(marker);
  if (at < 0) return {};
  if (text.slice(at + marker.length).trimStart()[0] !== '{') return {};
  const open = text.indexOf('{', at);
  const close = matchBrace(text, open);
  if (close < 0) return {};
  const out = {};
  for (const part of splitTop(text.slice(open + 1, close))) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(part);
    if (!m) continue;
    const v = litValue(part.slice(m[0].length));
    if (v !== undefined) out[m[1]] = v;
  }
  return out;
}
function readLauncherInfo(file) {
  const text = readText(file);
  if (text === null) return null;
  const base = backfillLib.readLauncher(file) || {};
  const fields = readRecordLiteral(text);
  const baseName = path.basename(file).replace(/-launch\.cjs$/, '');
  return {
    file: path.basename(file), fields,
    client: (typeof fields.client === 'string' && fields.client) || base.client || null,
    model: (typeof fields.model === 'string' && fields.model) || base.model || null,
    effort: (typeof fields.effort === 'string' && fields.effort) || base.effort || null,
    name: (typeof fields.name === 'string' && fields.name) || baseName,
    done: base.done || null, call: base.call || null, prompt: base.prompt || null,
  };
}
function resolveCall(runtimeDir, name, info) {
  const candidates = [];
  if (info.call) candidates.push(path.isAbsolute(info.call) ? info.call : path.join(runtimeDir, info.call));
  candidates.push(path.join(runtimeDir, `${name}-call.txt`));
  for (const p of candidates) if (isFile(p)) return p;
  try { const hit = fs.readdirSync(runtimeDir).find(n => n.startsWith(`${name}-call`) && n.endsWith('.txt') && isFile(path.join(runtimeDir, n))); if (hit) return path.join(runtimeDir, hit); } catch { /* dir gone */ }
  return null;
}
const NOT_LAUNCHED = /\bexit=(PREFLIGHT_FAIL|QUIET_TIMEOUT)\b/;
function readEvidenceIndex(runtimeDir) {
  if (!runtimeDir || !fs.existsSync(runtimeDir)) return [];
  const files = fs.readdirSync(runtimeDir).filter(f => isFile(path.join(runtimeDir, f)));
  const index = new Map();
  const get = n => { let e = index.get(n); if (!e) { e = { name: n, files: [], terminal: null, running: null, markers: [], launcher: null, callFile: null, calls: [], notLaunched: false }; index.set(n, e); } return e; };
  for (const f of files) {
    let m;
    if ((m = /^(.*)\.terminal\.json$/.exec(f))) { const e = get(m[1]); e.terminal = readJson(path.join(runtimeDir, f)); e.files.push(f); }
    else if ((m = /^(.*)\.running\.json$/.exec(f))) { const e = get(m[1]); e.running = readJson(path.join(runtimeDir, f)); e.files.push(f); }
    else if ((m = /^(.*)\.marker\.txt$/.exec(f))) { const e = get(m[1]); e.markers = String(readText(path.join(runtimeDir, f)) || '').split('\n').filter(Boolean).map(l => { const x = /exit=(\S+)\s+end=(\S+)/.exec(l); const c = /class=(\S+)/.exec(l); return { line: l, exit: x ? x[1] : null, end: x ? x[2] : null, clazz: c ? c[1] : null }; }); e.files.push(f); }
  }
  for (const f of files) {
    if (!f.endsWith('-launch.cjs')) continue;
    const name = f.replace(/-launch\.cjs$/, '');
    const e = get(name);
    try { e.launcher = readLauncherInfo(path.join(runtimeDir, f)); if (e.launcher) e.files.push(f); } catch { e.launcher = null; }
  }
  for (const e of index.values()) {
    if (!e.launcher) continue;
    const callFile = resolveCall(runtimeDir, e.name, e.launcher);
    if (!callFile) continue;
    const body = readText(callFile) || '';
    if (NOT_LAUNCHED.test(body)) { e.notLaunched = true; continue; }
    e.callFile = callFile;
    e.files.push(path.basename(callFile));
    if (e.launcher.done) { try { e.calls = backfillLib.readCallFile(callFile, e.launcher.done); } catch { e.calls = []; } }
  }
  return [...index.values()];
}

// ---- derivation -------------------------------------------------------------------------------------------

function classify(exitCode, text) {
  const t = String(text || '');
  if (INTERRUPTED_CODES.has(exitCode)) return 'INTERRUPTED';
  if (/ECONNRESET|socket hang up|EOF|fetch failed|EAI_AGAIN|overloaded|gateway|50[23-4]\b/i.test(t)) return 'TRANSPORT';
  if (/429|rate.?limit|quota|insufficient balance|resource.?exhausted|hit your limit/i.test(t)) return 'QUOTA';
  if (/401|403|unauthor|invalid api key|forbidden|not logged in/i.test(t)) return 'AUTH';
  if (/stall|timed?\s?out/i.test(t)) return 'STALL';
  return exitCode !== 0 ? 'UNKNOWN' : null;
}
function gitHasCommit(repo, sha) {
  if (!repo || !/^[0-9a-f]{7,40}$/.test(String(sha || ''))) return false;
  try { return spawnSync('git', ['-C', repo, 'cat-file', '-e', `${sha}^{commit}`], { encoding: 'utf8', windowsHide: true }).status === 0; } catch { return false; }
}
// Enriches a backfillLib record with the extension fields the launcher/runtime json prove. Only valid
// enumerations are written; a malformed literal is dropped, not repaired.
function enrich(base, ev, ctx) {
  const rec = base; const conf = rec.confidence; const f = (ev.launcher && ev.launcher.fields) || {}; const term = ev.terminal || {};
  const setIf = (key, value, sure) => { if (value === undefined || value === null || value === '') return; rec[key] = value; conf[key] = sure; };
  if (typeof f.role === 'string') setIf('role', f.role, 'exact');
  if (typeof f.stage === 'string' && STAGE_ENUM.has(f.stage)) setIf('stage', f.stage, 'exact');
  if (typeof f.taskClass === 'string') setIf('taskClass', f.taskClass, 'exact');
  if (typeof f.route === 'string') setIf('route', f.route, 'exact');
  if (typeof f.riskClass === 'string' && RISK_ENUM.has(f.riskClass)) setIf('riskClass', f.riskClass, 'exact');
  if (typeof f.packetHash === 'string' && /^(sha256:)?[0-9a-f]{64}$/.test(f.packetHash)) setIf('packetHash', f.packetHash.startsWith('sha256:') ? f.packetHash : `sha256:${f.packetHash}`, 'exact');
  if (typeof f.packetProfile === 'string' && PROFILE_ENUM.has(f.packetProfile)) setIf('packetProfile', f.packetProfile, 'exact');
  if (Number.isInteger(f.packetBytes) && f.packetBytes >= 0) setIf('packetBytes', f.packetBytes, 'exact');
  if (Number.isInteger(f.packetEstTokens) && f.packetEstTokens >= 0) setIf('packetEstTokens', f.packetEstTokens, 'exact');
  if (!rec.route) { const c = rec.tuple && rec.tuple.client; if (CLI_CLIENTS.has(c)) setIf('route', `cli:${c}`, 'derived'); }
  if (typeof term.exitCode === 'number' && !Number.isInteger(rec.exitCode)) { rec.exitCode = term.exitCode; conf.exitCode = 'exact'; }
  if (rec.exitCode !== undefined && rec.exitCode !== 0) {
    if (term.failureClass) setIf('failureClass', term.failureClass, 'derived');
    else { const c = classify(rec.exitCode, (term.lastLines || []).join('\n') || `${ev.name} exit=${rec.exitCode}`); if (c) setIf('failureClass', c, 'derived'); }
  }
  if (rec.wallSeconds === undefined && rec.startedAt && rec.endedAt && !rec.startedAtNote && !rec.endedAtNote) {
    const s = (Date.parse(rec.endedAt) - Date.parse(rec.startedAt)) / 1000;
    if (Number.isFinite(s) && s >= 0) setIf('wallSeconds', Math.round(s * 10) / 10, 'derived');
  }
  if (rec.head && ctx.repo && !gitHasCommit(ctx.repo, rec.head)) { delete rec.head; delete conf.head; }
  const src = [...new Set((ev.files || []).concat(ev.callFile ? [path.basename(ev.callFile)] : []))].join(' + ');
  if (src) rec.source = src;
  rec.confidence = conf;
  return rec;
}
function deriveFromEvidence(journalRecs, runtimeDir, repo) {
  const groups = groupLaunches(journalRecs);
  const bySlug = new Map();
  for (const g of groups) bySlug.set(g.id.replace(/^L-\d{8}T\d{6}Z-/, ''), g.id);
  const seen = new Set();
  const records = []; const report = { evidenceSources: 0, notLaunched: 0, noTime: 0, errors: 0, records: 0 };
  const idFor = (name, litName, anchor) => {
    const s = slug(litName || name);
    const preferred = bySlug.get(s) || `L-${stampOf(anchor)}-${s}`;
    let id = preferred; let n = 2; while (seen.has(id)) id = `${preferred}-${n++}`;
    seen.add(id); return id;
  };
  for (const ev of readEvidenceIndex(runtimeDir)) {
    if (!ev.launcher) continue;
    report.evidenceSources++;
    if (ev.notLaunched) { report.notLaunched++; continue; }
    const launcherObj = { launcher: ev.launcher.file, client: ev.launcher.client, model: ev.launcher.model, effort: ev.launcher.effort, done: ev.launcher.done, call: ev.callFile, prompt: ev.launcher.prompt, workdir: null };
    let calls = ev.calls;
    if (!calls.length && ev.terminal && isTime(ev.terminal.startedAt)) calls = [{ exitCode: typeof ev.terminal.exitCode === 'number' ? ev.terminal.exitCode : null, startedAt: ev.terminal.startedAt, endedAt: ev.terminal.endedAt || null, endedFromMtime: false, reportedModel: null }];
    if (!calls.length) { report.noTime++; continue; }
    for (const call of calls) {
      try {
        const base = backfillLib.build(launcherObj, call, runtimeDir);
        if (!base) { report.noTime++; continue; }
        base.launchId = idFor(ev.name, ev.launcher.name, isTime(call.startedAt) ? new Date(call.startedAt) : new Date(call.endedAt));
        records.push(enrich(base, ev, { repo }));
        report.records++;
      } catch { report.errors++; }
    }
  }
  return { records, report };
}
function applyDerived(groups, records) {
  const byId = new Map(groups.map(g => [g.id, g]));
  for (const r of records) {
    if (byId.has(r.launchId)) byId.get(r.launchId).extra.push(r);
    else { const g = { id: r.launchId, start: r, fin: null, reviews: [], extra: [] }; byId.set(r.launchId, g); groups.push(g); }
  }
  return groups;
}

// ---- commands ---------------------------------------------------------------------------------------------

function runLines(runsFile) {
  const lines = [`## channel RUNS (${RUNS_SCHEMA})`];
  if (!fs.existsSync(runsFile)) { lines.push(`not present: ${runsFile} (a dispatched run logs only to RUNS.jsonl; never merged with LAUNCHES)`); return lines; }
  let recs = [];
  try { recs = readJsonl(runsFile); } catch (e) { lines.push(`unreadable: ${e.message}`); return lines; }
  const stray = recs.filter(r => r && r.schema === LAUNCH_SCHEMA).length;
  if (stray) lines.push(`WARN ${stray} launch-record/1 line(s) in the RUNS file were skipped (channels are never mixed)`);
  const runs = recs.filter(r => r && r.schema === RUNS_SCHEMA);
  lines.push(`records=${runs.length} (file ${runsFile})`);
  for (const f of RUNS_FIELDS) { const n = runs.filter(r => present(r, f)).length; lines.push(`  ${f.padEnd(20)}${String(n).padStart(7)}${(runs.length ? `${(100 * n / runs.length).toFixed(1)}%` : 'n/a').padStart(9)}`); }
  return lines;
}
function report(opts) {
  const journalRecs = readJsonl(opts.journal);
  const pendingRecs = opts.pending ? jsonlIn(opts.pending).flatMap(readJsonl) : [];
  const stray = [...journalRecs, ...pendingRecs].filter(r => r && r.schema === RUNS_SCHEMA).length;
  const launchRecs = [...journalRecs, ...pendingRecs].filter(r => r && r.schema !== RUNS_SCHEMA);
  const groups = groupLaunches(launchRecs);
  const lines = ['# launch-fill (advisory; PROTO-DEC-0145 item 1: the channels are never mixed)', ''];
  if (stray) lines.push(`WARN ${stray} run-record/1 line(s) in the LAUNCHES input were skipped (never mixed)`);
  const scope = opts.pending ? 'journal + pending buffer' : 'journal';
  lines.push(...table(`## channel LAUNCHES (${LAUNCH_SCHEMA}) - records (lines) - source: ${scope}`, measureRecords(launchRecs, [...EXT_FIELDS, ...BASE_PROBE]), launchRecs.length, 'records'));
  lines.push(measuredLine(`  measured-extension records (>=1 of ${MEASURED_FIELDS.join(', ')})`, recordsWithAny(launchRecs, MEASURED_FIELDS), launchRecs.length));
  lines.push('');
  lines.push(...table(`## channel LAUNCHES (${LAUNCH_SCHEMA}) - launches (by launchId) - source: ${scope}`, measure(groups, [...EXT_FIELDS, ...BASE_PROBE]), groups.length, 'launches'));
  lines.push(measuredLine(`  measured-extension launches (>=1 of ${MEASURED_FIELDS.join(', ')})`, withAny(groups, MEASURED_FIELDS), groups.length));
  lines.push('');
  lines.push(...runLines(opts.runs));
  lines.push('');
  let after = null;
  if (opts.runtime && fs.existsSync(opts.runtime)) {
    const { records, report: rep } = deriveFromEvidence(launchRecs, opts.runtime, opts.repo);
    const merged = applyDerived(groups.slice(), records);
    const mergedRecords = launchRecs.concat(records);
    lines.push(`## channel LAUNCHES with evidence backfill (dry run; never written) - source: ${scope} + ${rep.records} derived from ${opts.runtime}`);
    lines.push(`derived-from-evidence: sources=${rep.evidenceSources} records=${rep.records} notLaunched=${rep.notLaunched} noTime=${rep.noTime} errors=${rep.errors}`);
    lines.push(...table('derived records (lines, dry run)', measureRecords(mergedRecords, [...EXT_FIELDS, ...BASE_PROBE]), mergedRecords.length, 'records'));
    lines.push(measuredLine(`  measured-extension records (>=1 of ${MEASURED_FIELDS.join(', ')})`, recordsWithAny(mergedRecords, MEASURED_FIELDS), mergedRecords.length));
    lines.push(...table('launches (by launchId, with backfill)', measure(merged, [...EXT_FIELDS, ...BASE_PROBE]), merged.length, 'launches'));
    lines.push(measuredLine(`  measured-extension launches (>=1 of ${MEASURED_FIELDS.join(', ')})`, withAny(merged, MEASURED_FIELDS), merged.length));
    lines.push('');
    after = { records: mergedRecords.length, launches: merged.length, measuredRecords: recordsWithAny(mergedRecords, MEASURED_FIELDS), measuredLaunches: withAny(merged, MEASURED_FIELDS) };
  }
  lines.push(`SUMMARY before-records=${recordsWithAny(launchRecs, MEASURED_FIELDS)}/${launchRecs.length} before-launches=${withAny(groups, MEASURED_FIELDS)}/${groups.length}${after ? ` after-records=${after.measuredRecords}/${after.records} after-launches=${after.measuredLaunches}/${after.launches}` : ''}`);
  lines.push('threshold fill>=80%: proposal only (FINAL 3.1 P09), never a gate input.');
  if (opts.json) process.stdout.write(`${JSON.stringify({ channel: 'LAUNCHES', records: launchRecs.length, launches: groups.length, before: measureRecords(launchRecs, EXT_FIELDS), after }, null, 2)}\n`);
  else process.stdout.write(`${lines.join('\n')}\n`);
  return 0;
}

function backfillCommand(opts) {
  const journalRecs = readJsonl(opts.journal);
  const pendingRecs = opts.pending ? jsonlIn(opts.pending).flatMap(readJsonl) : [];
  const launchRecs = [...journalRecs, ...pendingRecs].filter(r => r && r.schema !== RUNS_SCHEMA);
  const { records, report: rep } = deriveFromEvidence(launchRecs, opts.runtime, opts.repo);
  const invalid = records.map(r => ({ r, errors: validator.validateRecord(r) })).filter(x => x.errors.length);
  for (const x of invalid) process.stdout.write(`INVALID ${x.r.launchId} ${x.errors.join('; ')}\n`);
  const out = opts.out || path.join(DEFAULT_BACKFILL_DIR, `LAUNCHES-BACKFILL-${stampOf(new Date(opts.now || Date.now()))}.jsonl`);
  if (opts.json) process.stdout.write(`${JSON.stringify({ sources: rep.evidenceSources, records: records.length, invalid: invalid.length, notLaunched: rep.notLaunched, noTime: rep.noTime, errors: rep.errors, out, apply: Boolean(opts.apply) }, null, 2)}\n`);
  else process.stdout.write(`backfill apply=${Boolean(opts.apply)} sources=${rep.evidenceSources} records=${records.length} invalid=${invalid.length} notLaunched=${rep.notLaunched} noTime=${rep.noTime} errors=${rep.errors} out=${out}\n`);
  if (!opts.apply) return invalid.length ? 1 : 0;
  if (invalid.length) { process.stdout.write('ERROR refusing to write: derived records fail the validator\n'); return 1; }
  if (FORBIDDEN_OUT.some(re => re.test(path.resolve(out)))) return usage('refusing to write into .ai/ or model-ladder.json (PROTO-DEC-0143 item 3)');
  if (fs.existsSync(out)) return usage(`refusing to overwrite an existing file: ${out} (the backfill is always a NEW file)`);
  atomic.writeFileAtomic(out, `${records.map(r => JSON.stringify(r)).join('\n')}\n`);
  process.stdout.write(`wrote ${out} records=${records.length}\n`);
  return 0;
}

// usage: tokens and cost of HISTORICAL records (journal + pending) from the evidence that still exists; plan by default (a coverage report), --apply writes
// the derived `finished` event lines into a NEW file (never the journal, never a pending file, never an existing file).
//   node launch-fill.cjs usage --runtime DIR [--journal f] [--pending dir | --include-pending] [--mimo-db FILE] [--vibe-dir DIR] [--prices DIR] [--out f] [--apply] [--json] [--now ISO]
function usageCommand(opts) {
  const usageLib = require('./lib/usage-backfill.cjs');
  const clientUsage = require('./lib/client-usage.cjs');
  const journalRecs = readJsonl(opts.journal);
  const pendingRecs = opts.pending ? jsonlIn(opts.pending).flatMap(readJsonl) : [];
  const recs = [...journalRecs, ...pendingRecs].filter(r => r && r.schema !== RUNS_SCHEMA);
  const mimoDb = opts.mimoDb || clientUsage.defaultMimoDb();
  const vibeDir = opts.vibeDir || clientUsage.defaultVibeDir();
  const { events, rows, summary } = usageLib.deriveUsage(recs, { runtimeDir: opts.runtime, mimoDb, vibeDir, pricesDir: opts.prices });
  const out = opts.out || path.join(DEFAULT_BACKFILL_DIR, `LAUNCHES-USAGE-BACKFILL-${stampOf(new Date(opts.now || Date.now()))}.jsonl`);
  const t = summary.total;
  const pct = n => (t.records ? `${(100 * n / t.records).toFixed(1)}%` : 'n/a');
  if (opts.json) process.stdout.write(`${JSON.stringify({ summary, apply: Boolean(opts.apply), out, events: events.length }, null, 2)}
`);
  else {
    const lines = ['# launch-fill usage (advisory; never Evidence; PROTO-DEC-0143 item 3)', `mode=${opts.apply ? 'APPLY' : 'PLAN (nothing is written)'} records=${t.records} (start records of journal + pending) already-filled=${t.already}`,
      `tokens derived: ${t.filled} (${pct(t.filled)}): exact=${t.exact} (the numbers the client printed for that launch), derived=${t.derived} (directory and launch window)`,
      `cost only (flat-fee client, no usage evidence): ${t.costOnly}; cannot be filled: ${t.unfillable}; invalid: ${t.invalid}`,
      `cost basis of the lines: priced=${t.priced} subscription=${t.subscription} unknown=${t.costUnknown}`, '', 'client                 records already filled cost-only cannot'];
    for (const [c, x] of Object.entries(summary.byClient).sort((a, b) => b[1].records - a[1].records)) lines.push(`${c.padEnd(22)} ${String(x.records).padStart(7)} ${String(x.already).padStart(7)} ${String(x.filled).padStart(6)} ${String(x.costOnly).padStart(9)} ${String(x.unfillable).padStart(6)}`);
    lines.push('', 'why a record cannot be (fully) filled:');
    for (const r of summary.reasons.slice(0, 25)) lines.push(`  x${r.count}  ${r.reason.slice(0, 220)}`);
    lines.push('', 'why a cost is unknown although a line was derived:');
    for (const r of summary.costUnknownReasons.slice(0, 15)) lines.push(`  x${r.count}  ${r.reason.slice(0, 220)}`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  if (t.invalid) return 1;
  if (!opts.apply) return 0;
  if (FORBIDDEN_OUT.some(re => re.test(path.resolve(out)))) return usage('refusing to write into .ai/ or model-ladder.json (PROTO-DEC-0143 item 3)');
  if (fs.existsSync(out)) return usage(`refusing to overwrite an existing file: ${out} (the usage backfill is always a NEW file)`);
  if (!events.length) { process.stdout.write('nothing derived: no file written\n'); return 0; }
  atomic.writeFileAtomic(out, `${events.map(e => JSON.stringify(e)).join('\n')}\n`);
  process.stdout.write(`wrote ${out} lines=${events.length}\n`);
  return 0;
}

// served: the served model of HISTORICAL vibe records from the vibe session store;
// plan by default (counts, nothing is written), --apply writes `finished` event lines into a NEW file. Reads only: the records and the session store.
//   node launch-fill.cjs served [--journal f] [--pending dir | --include-pending] [--session-root DIR] [--out f] [--apply] [--json] [--now ISO]
function servedCommand(opts) {
  const served = require('./lib/served-backfill.cjs');
  const journalRecs = readJsonl(opts.journal);
  const pendingRecs = opts.pending ? jsonlIn(opts.pending).flatMap(readJsonl) : [];
  const recs = [...journalRecs, ...pendingRecs].filter(r => r && r.schema !== RUNS_SCHEMA);
  const { events, rows, summary } = served.deriveServed(recs, { sessionRoot: opts.sessionRoot });
  const out = opts.out || path.join(DEFAULT_BACKFILL_DIR, `LAUNCHES-SERVED-BACKFILL-${stampOf(new Date(opts.now || Date.now()))}.jsonl`);
  const t = summary.total;
  if (opts.json) process.stdout.write(`${JSON.stringify({ summary, apply: Boolean(opts.apply), out, events: events.length, rows: rows.length }, null, 2)}\n`);
  else {
    const lines = ['# launch-fill served (advisory; never Evidence; PROTO-DEC-0143 item 3)', `mode=${opts.apply ? 'APPLY' : 'PLAN (nothing is written)'} vibe-records=${t.vibeRecords} (start records of journal + pending) already-with-served-model=${t.already}`,
      `served model derived from the session store: ${t.filled}; cannot be derived: ${t.unfillable}; invalid: ${t.invalid}`,
      `proven (derived or already recorded): match yes=${t.matchYes} no=${t.matchNo} unknown=${t.matchUnknown}`,
      `requested a GLM model: ${t.glmRequested}; served a GLM model: ${t.glmServedGlm}; served a MISTRAL model although GLM was requested: ${t.glmServedMistral}; not proven: ${t.glmUnproven}`, '', 'served models (proven records):'];
    for (const m of summary.servedModels) lines.push(`  ${String(m.count).padStart(5)}  ${m.model}`);
    lines.push('', 'GLM requested, Mistral served, by day of the launch:');
    for (const d of summary.mistralInsteadOfGlmByDay) lines.push(`  ${d.day}  ${d.count}`);
    lines.push('', 'why a served model cannot be derived:');
    for (const r of summary.reasons.slice(0, 25)) lines.push(`  x${r.count}  ${r.reason.slice(0, 220)}`);
    process.stdout.write(`${lines.join('\n')}\n`);
  }
  if (t.invalid) return 1;
  if (!opts.apply) return 0;
  if (FORBIDDEN_OUT.some(re => re.test(path.resolve(out)))) return usage('refusing to write into .ai/ or model-ladder.json (PROTO-DEC-0143 item 3)');
  if (fs.existsSync(out)) return usage(`refusing to overwrite an existing file: ${out} (the served backfill is always a NEW file)`);
  if (!events.length) { process.stdout.write('nothing derived: no file written\n'); return 0; }
  atomic.writeFileAtomic(out, `${events.map(e => JSON.stringify(e)).join('\n')}\n`);
  process.stdout.write(`wrote ${out} lines=${events.length}\n`);
  return 0;
}

function parseArgs(argv) {
  const o = { journal: DEFAULT_JOURNAL, runs: DEFAULT_RUNS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const next = () => argv[++i];
    if (a === '--journal') o.journal = next();
    else if (a === '--pending') o.pending = next();
    else if (a === '--include-pending') o.pending = DEFAULT_PENDING;
    else if (a === '--runs') o.runs = next();
    else if (a === '--mimo-db') o.mimoDb = next();
    else if (a === '--vibe-dir') o.vibeDir = next();
    else if (a === '--session-root') o.sessionRoot = next();
    else if (a === '--prices') o.prices = next();
    else if (a === '--runtime') o.runtime = next();
    else if (a === '--repo') o.repo = next();
    else if (a === '--out') o.out = next();
    else if (a === '--now') o.now = next();
    else if (a === '--apply') o.apply = true;
    else if (a === '--json') o.json = true;
    else return { error: `unknown argument ${a}` };
  }
  if (o.now && Number.isNaN(Date.parse(o.now))) return { error: '--now must be an ISO time' };
  return o;
}
function main(argv) {
  const cmd = argv[0];
  if (cmd !== 'report' && cmd !== 'backfill' && cmd !== 'usage' && cmd !== 'served') return usage('usage: launch-fill.cjs report|backfill|usage|served [options]');
  const o = parseArgs(argv.slice(1));
  if (o.error) return usage(o.error);
  if (!fs.existsSync(o.journal)) return usage(`journal not found: ${o.journal}`);
  if ((cmd === 'backfill' || cmd === 'usage') && !o.runtime) return usage(`${cmd} needs --runtime <dir with the evidence>`);
  if (o.runtime && !fs.existsSync(o.runtime)) return usage(`runtime dir not found: ${o.runtime}`);
  try { return cmd === 'report' ? report(o) : cmd === 'usage' ? usageCommand(o) : cmd === 'served' ? servedCommand(o) : backfillCommand(o); } catch (e) { return usage(e.message); }
}

module.exports = { measure, measureRecords, groupLaunches, withAny, recordsWithAny, deriveFromEvidence, readEvidenceIndex, readRecordLiteral, enrich, classify, EXT_FIELDS, MEASURED_FIELDS, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

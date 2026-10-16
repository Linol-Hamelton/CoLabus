'use strict';
// pairs-io: the files side of the pairs recorder. READS the launch records (pending buffer, tracked journals), the resolver shadow journal, the
// class registry and the ladder digest; WRITES only through appendLines, and only a file named PAIRS-<machine>-<YYYYMM>.jsonl or
// EPOCHS-<machine>.jsonl inside the pairs folder of the layer, a folder that guardOutput accepts (PROTO-DEC-0143 item 3, 0144 item 3: the
// recorder never writes under the protocol folder, into the ladder or into the layer data, and never edits an input). The guard runs before the
// first read AND again, by real path, inside every write (lib/pairs-write.cjs). There is no delete, rename, open or write call in this file: the
// only write is publishAppend of lib/pairs-write.cjs.

const fs = require('node:fs');
const path = require('node:path');
const { sha256 } = require('./canon.cjs');
const { publishAppend } = require('./pairs-write.cjs');
const core = require('./pairs-core.cjs');

const LAYER_REL = ['docs', 'product', 'launch-records'];
const PAIRS_DIR_NAME = 'pairs';
const TARGET_RE = /^(PAIRS-[a-z0-9][a-z0-9_-]{0,31}-\d{6}|EPOCHS-[a-z0-9][a-z0-9_-]{0,31})\.jsonl$/;
const SHADOW_RE = /^resolver-shadow-\d{8}\.jsonl$/;
const LAUNCH_ID_RE = /^L-\d{8}T\d{6}Z-[a-z0-9-]+$/;
const NAME_WINDOW_MS = 120 * 1000;

/** OPS_MACHINE_ID or the host name, reduced to a-z 0-9 _ - (at most 32 characters); null when nothing safe is left. Same rule as the launch journal sync. */
function machineId(raw) {
  const safe = String(raw === undefined || raw === null ? '' : raw).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^[-_]+|[-_]+$/g, '').slice(0, 32).replace(/[-_]+$/, '');
  return safe || null;
}
const targetNameOk = name => typeof name === 'string' && TARGET_RE.test(name);
const slug = s => String(s || 'run').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'run';

const layerDir = repoRoot => path.join(path.resolve(repoRoot), ...LAYER_REL);
const defaultPairsDir = repoRoot => path.join(layerDir(repoRoot), PAIRS_DIR_NAME);

// ---- the output guard ----
const keyOf = p => (process.platform === 'win32' ? p.toLowerCase() : p);
/** The real path of a path that may not exist yet: the nearest existing ancestor is resolved (links followed), the rest is appended. */
function realish(p) {
  let cur = path.resolve(p); const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync(cur), ...rest.reverse()); } catch { /* not there yet */ }
    const up = path.dirname(cur);
    if (up === cur) return path.resolve(p);
    rest.push(path.basename(cur)); cur = up;
  }
}
const within = (child, parent) => { const r = path.relative(keyOf(parent), keyOf(child)); return r === '' || (!r.startsWith('..') && !path.isAbsolute(r)); };
const refuse = reason => Object.assign(new Error(`REFUSED ${reason}`), { code: 'REFUSED' });

const FORBIDDEN_OUT_LADDER = repoRoot => path.join(path.resolve(repoRoot), 'docs', 'ops', 'model-ladder.json'); // the file itself: also named to the guard as an input of every run
const FORBIDDEN_OUT = repoRoot => [path.join(repoRoot, '.ai'), path.join(repoRoot, 'docs', 'ops'), FORBIDDEN_OUT_LADDER(repoRoot), ...['data', 'schema', 'launches', 'tools'].map(d => path.join(layerDir(repoRoot), d))];

/**
 * The folder the recorder may write into: exactly <layer>/pairs, after links are resolved. Refused: anything under the protocol folder, the ladder
 * folder or the layer data, schema, launches and tools folders; anything that is, holds or lies inside an input; anything else.
 * @returns {string} the accepted real path of the pairs folder
 */
function guardOutput(dir, ctx) {
  const root = realish(ctx.repoRoot);
  const out = realish(dir);
  for (const bad of FORBIDDEN_OUT(root).map(realish)) if (within(out, bad)) throw refuse(`output ${out} is inside the protected folder ${bad}`);
  for (const input of (ctx.inputs || []).map(realish)) if (within(out, input) || within(input, out)) throw refuse(`output ${out} overlaps the input ${input}`);
  const expected = path.join(realish(layerDir(root)), PAIRS_DIR_NAME);
  if (keyOf(out) !== keyOf(expected)) throw refuse(`output ${out} is not the pairs folder of the layer (${expected})`);
  return out;
}

/**
 * Append lines to one journal file: the old content stays an exact prefix, the file is replaced atomically, and the output folder is guarded again (by real
 * path) at write time. ctx is the context guardOutput takes ({repoRoot, inputs}); it is required, a write without a guard is refused.
 * @param {string} file the journal; its name must pass targetNameOk and its folder must be accepted by guardOutput
 * @param {string[]} lines
 * @param {{repoRoot: string, inputs?: string[]}} ctx
 * @param {{hooks?: object, suffix?: function}} [deps] test hooks only
 */
function appendLines(file, lines, ctx, deps = {}) {
  const name = path.basename(file);
  if (!targetNameOk(name)) throw refuse(`${name} is not a pair journal or epoch ledger file name`);
  if (!ctx || !ctx.repoRoot) throw refuse('a write needs the output guard context (repo root and inputs)');
  const dir = path.dirname(file);
  return publishAppend({ name, lines, checkDir: () => guardOutput(dir, ctx), hooks: deps.hooks, suffix: deps.suffix });
}

// ---- readers ----
const listJsonl = dir => { try { return fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort(); } catch { return []; } };
function readLines(file) {
  const raw = fs.readFileSync(file);
  if (raw[0] === 0xef && raw[1] === 0xbb && raw[2] === 0xbf) throw new Error('byte order mark');
  return raw.toString('utf8').split('\n').map(t => t.replace(/\r$/, '')).filter(t => t.trim() !== '');
}
const digest = file => { try { return sha256(fs.readFileSync(file)); } catch { return null; } };

/** Launch lines of the pending buffer and the tracked LAUNCHES*.jsonl journals, grouped by launchId (read only). */
function loadLaunches({ pendingDir, launchesDir }) {
  const stats = { files: 0, linesRead: 0, unparsable: 0, notLaunchRecord: 0, unreadableFiles: 0, duplicateSources: 0, sources: [] };
  const groups = new Map();
  const seenLines = new Set();
  const sources = [];
  for (const [dir, filter] of [[pendingDir, () => true], [launchesDir, n => /^LAUNCHES.*\.jsonl$/.test(n)]]) {
    for (const name of listJsonl(dir).filter(filter)) sources.push(path.join(dir, name));
  }
  for (const file of sources) {
    stats.files++;
    let lines;
    try { lines = readLines(file); } catch { stats.unreadableFiles++; stats.sources.push({ file: path.basename(file), sha256: digest(file), lines: 0 }); continue; }
    stats.sources.push({ file: path.basename(file), sha256: digest(file), lines: lines.length });
    for (const text of lines) {
      stats.linesRead++;
      let rec;
      try { rec = JSON.parse(text); } catch { stats.unparsable++; continue; }
      if (!rec || typeof rec !== 'object' || Array.isArray(rec) || rec.schema !== 'launch-record/1' || typeof rec.launchId !== 'string' || !LAUNCH_ID_RE.test(rec.launchId)) { stats.notLaunchRecord++; continue; }
      const key = sha256(text);
      if (seenLines.has(key)) { stats.duplicateSources++; continue; }
      seenLines.add(key);
      if (!groups.has(rec.launchId)) groups.set(rec.launchId, { lines: [], text: [] });
      groups.get(rec.launchId).lines.push(rec); groups.get(rec.launchId).text.push(text);
    }
  }
  return { groups, stats };
}

/** The resolver shadow journal (<runtime>/resolver-shadow/resolver-shadow-YYYYMMDD.jsonl), read only. */
function loadShadows(dir) {
  const stats = { files: 0, records: 0, unreadable: 0, sources: [] };
  const records = [];
  for (const name of listJsonl(dir).filter(n => SHADOW_RE.test(n))) {
    const file = path.join(dir, name); stats.files++;
    let lines;
    try { lines = readLines(file); } catch { stats.unreadable++; continue; }
    stats.sources.push({ file: name, sha256: digest(file), lines: lines.length });
    for (const text of lines) {
      let rec;
      try { rec = JSON.parse(text); } catch { stats.unreadable++; continue; }
      if (!rec || typeof rec !== 'object' || rec.schema !== 'resolver-shadow/1') { stats.unreadable++; continue; }
      stats.records++; records.push(rec);
    }
  }
  records.sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  return { records, stats };
}

/**
 * Link each launch to at most one shadow record: by launchId, else (a wrapper record with launchId null) by launch name and time, only when exactly one launch fits.
 * @returns {{byLaunch: Map<string, {shadow: object, basis: string}>, stats: object}}
 */
function linkShadows(launches, shadows) {
  const stats = { records: shadows.length, withoutLaunch: 0, duplicates: 0, ambiguous: 0 };
  const byLaunch = new Map();
  const starts = new Map([...launches].map(([id, l]) => [id, core.timeOf(l.startedAt) ? Date.parse(l.startedAt) : null]));
  for (const s of shadows) {
    let id = null; let basis = 'launchId';
    if (typeof s.launchId === 'string' && s.launchId) {
      if (launches.has(s.launchId)) id = s.launchId; else { stats.withoutLaunch++; continue; }
    } else {
      basis = 'name+time';
      const at = core.timeOf(s.at) ? Date.parse(s.at) : null;
      const fits = at === null || !s.name ? [] : [...launches.keys()].filter(k => core.slugOf(k) === slug(s.name) && starts.get(k) !== null && Math.abs(starts.get(k) - at) <= NAME_WINDOW_MS);
      if (fits.length > 1) { stats.ambiguous++; continue; }
      if (fits.length === 0) { stats.withoutLaunch++; continue; }
      id = fits[0];
    }
    if (byLaunch.has(id)) { stats.duplicates++; continue; }
    byLaunch.set(id, { shadow: s, basis });
  }
  return { byLaunch, stats };
}

/** The class registry file: schema label, generation time and the first 16 hex digits of its digest; null when it is missing or not JSON. A label or a time that does not have its shape is null (it is never copied). */
function registryInfo(file) {
  try {
    const buf = fs.readFileSync(file); const j = JSON.parse(buf.toString('utf8'));
    return { sv: typeof j.sv === 'string' && core.SV_RE.test(j.sv) ? j.sv : null, generatedAt: core.timeOf(j.generatedAt), sha16: sha256(buf).slice(0, 16) };
  } catch { return null; }
}

/** What the pairs folder already holds: launchIds of every machine and the known epoch ids (read only). */
function loadExisting(pairsDir) {
  const launchIds = new Map(); const epochIds = new Set(); const files = [];
  for (const name of listJsonl(pairsDir)) {
    if (!targetNameOk(name)) continue;
    const file = path.join(pairsDir, name);
    files.push({ file: name, sha256: digest(file) });
    let lines; try { lines = readLines(file); } catch { continue; }
    for (const text of lines) {
      let rec; try { rec = JSON.parse(text); } catch { continue; }
      if (!rec || typeof rec !== 'object') continue;
      // only a field of its proper shape is used: a launch id or an epoch id of any other shape is not a record of that launch or epoch
      if (rec.schema === core.SCHEMA && typeof rec.launchId === 'string' && LAUNCH_ID_RE.test(rec.launchId) && !launchIds.has(rec.launchId)) launchIds.set(rec.launchId, name);
      if (rec.schema === core.EPOCH_SCHEMA && core.validateEpoch(rec).length === 0) epochIds.add(rec.epochId);
    }
  }
  return { launchIds, epochIds, files };
}

/** Every pair line of every PAIRS-*.jsonl of a folder, for the report: valid objects with their file, plus the count of lines that were not. */
function readPairFiles(pairsDir) {
  const out = { pairs: [], epochLines: [], invalid: 0, files: 0 };
  for (const name of listJsonl(pairsDir)) {
    if (!targetNameOk(name)) continue;
    out.files++;
    let lines; try { lines = readLines(path.join(pairsDir, name)); } catch { out.invalid++; continue; }
    for (const text of lines) {
      let rec; try { rec = JSON.parse(text); } catch { out.invalid++; continue; }
      if (rec && rec.schema === core.EPOCH_SCHEMA) out.epochLines.push(rec);
      else if (rec && rec.schema === core.SCHEMA) out.pairs.push({ rec, file: name });
      else out.invalid++;
    }
  }
  return out;
}

module.exports = { LAYER_REL, ladderFile: FORBIDDEN_OUT_LADDER, machineId, targetNameOk, slug, layerDir, defaultPairsDir, guardOutput, appendLines, readLines, loadLaunches, loadShadows, linkShadows, registryInfo, loadExisting, readPairFiles, digest, realish };

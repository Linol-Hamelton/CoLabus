'use strict';
// A documentation shortcut requires a closed path list and a proven full run at
// the exact tested commit. Farm records are read only; no test or gate is run.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { parseJsonUnique } = require('../../lib/text-safe.cjs');
const driver = require('../../protocol-test.cjs');
const EXACT = new Set(['.ai/DECISIONS.md', 'docs/decisions/REGISTRY.md', '.ai/ARCHIVE.md',
  '.ai/TASK.md', '.ai/PLAN.md', 'CHANGELOG.md', 'RELEASE-NOTES.md']);
const SHA = /^[a-f0-9]{40}$/;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
const safeName = name => typeof name === 'string' && !/[\\\x00-\x1f\x7f]/.test(name)
  && !name.split('/').some(p => !p || p === '.' || p === '..');

function documentPath(name) {
  if (!safeName(name)) return false;
  return EXACT.has(name) || (name !== '.ai/worklog/README.md' && /^\.ai\/worklog\/[^/]+\.md$/.test(name))
    || /^docs\/reviews\/(?:[^/]+\/)*[^/]+\.md$/.test(name);
}

function read(file, json = true) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16 * 1024 * 1024) throw Error(`unreadable record: ${file}`);
  const bytes = fs.readFileSync(file);
  return json ? parseJsonUnique(bytes.toString('utf8')) : bytes;
}

// Use the runner's own discovery and tier readers on blobs of the tested commit,
// including forwarding owners. A checkout or the farm's self-reported file list
// cannot supply the full-suite inventory.
function suiteAt(git, head, withMutations = false) {
  const names = git.strict(['ls-tree', '-r', '--name-only', '-z', head]).split('\0').filter(Boolean);
  const manifestName = 'protocol-manifest.json';
  const manifest = parseJsonUnique(git.strict(['show', `${head}:${manifestName}`]));
  if (!Array.isArray(manifest.tests)) throw Error('tested head has no test inventory');
  const wanted = [...new Set([manifestName, ...names.filter(n => /^tests\/[^/]+\.test\.cjs$/.test(n)),
    ...manifest.tests.filter(n => typeof n === 'string' && n.endsWith('.test.cjs'))])];
  if (wanted.some(n => !safeName(n) || !names.includes(n))) throw Error('tested head has an invalid test inventory');
  const raw = git.strict(['cat-file', '--batch'], undefined, {
    input: Buffer.from(wanted.map(n => `${head}:${n}\n`).join('')), buffer: true });
  const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const snapshot = new Map();
  let at = 0;
  for (const name of wanted) {
    const end = bytes.indexOf(10, at), header = bytes.subarray(at, end).toString('ascii');
    const match = /^[a-f0-9]{40} blob ([0-9]+)$/.exec(header);
    if (end < at || !match) throw Error('tested blob batch is incomplete');
    const size = Number(match[1]);
    at = end + 1;
    if (!Number.isSafeInteger(size) || at + size >= bytes.length || bytes[at + size] !== 10) throw Error('tested blob batch is truncated');
    snapshot.set(name, { text: bytes.subarray(at, at + size).toString('utf8') });
    at += size + 1;
  }
  if (at !== bytes.length) throw Error('tested blob batch has extra data');
  const inventory = driver.discoverTestInventory('.', snapshot);
  const tiers = driver.testTierMetadata('.', inventory, snapshot);
  const files = inventory.entries.filter(n => withMutations || tiers[n]?.tier !== 'mutation');
  if (!files.length) throw Error('tested head has an empty full suite');
  return files;
}

function summaryFiles(summary) {
  if (!Array.isArray(summary?.files) || !summary.files.length) return null;
  const files = summary.files.map(f => f?.name);
  if (files.some(n => !safeName(n)) || new Set(files).size !== files.length) return null;
  return files;
}
function green(row) {
  const s = row.summary, c = s?.counts;
  return !row.problem && row.done.exit === 0 && row.done.headOk === true && !row.done.signal
    && s?.schemaVersion === 1 && s.head === row.job.sha && s.dirty === false && s.exit === 0
    && c && ['total', 'pass', 'fail', 'skip'].every(k => Number.isSafeInteger(c[k]) && c[k] >= 0)
    && c.total > 0 && c.fail === 0 && c.total === c.pass + c.skip
    // The runner may lack per-file TAP measurements for forwarding/custom tests.
    // Its run counters and exit prove success; unknown is not a failed file.
    && summaryFiles(s) && wholeFiles(s) && s.files.every(f => ['pass', 'skip', 'unknown'].includes(f.status))
    && (row.job.kind !== 'shard' || Array.isArray(row.job.files) && same(row.job.files, summaryFiles(s)));
}

function shardPlan(job) {
  const p = job.plan;
  return job.kind === 'shard' && p && /^[a-f0-9]{64}$/.test(p.sha256 || '')
    && Number.isSafeInteger(p.count) && p.count > 0 && Number.isSafeInteger(p.index)
    && p.index >= 0 && p.index < p.count && !job.selection
    && Array.isArray(job.files) && job.files.length > 0 && job.files.every(safeName)
    && new Set(job.files).size === job.files.length;
}

function wholeFiles(summary) {
  if (summary.mode === 'full') return summary.selection === null;
  if (summary.mode !== 'diagnostic' || typeof summary.selection !== 'string') return false;
  const tokens = summary.selection.split(' ');
  for (let i = 0; i < tokens.length; i += 2) {
    if (tokens[i] !== '--file' || !safeName(tokens[i + 1])) return false;
  }
  // File patterns select whole files. Compare the actual summary file inventory
  // at the repair/coverage boundary, not the spelling of a selection pattern.
  return tokens.length > 0;
}

function farmRows(results, head, tree) {
  const rows = [];
  for (const entry of fs.readdirSync(results, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name === 'stale') continue;
    const dir = path.join(results, entry.name);
    let job;
    try { job = read(path.join(dir, 'job.json')); }
    catch { throw Error(`farm job unreadable: ${entry.name}`); }
    if (job?.sha !== head || !['suite', 'shard', 'file'].includes(job.kind)) continue;
    const row = { dir, job, done: null, summary: null, problem: null, shard: null };
    rows.push(row);
    try {
      if (typeof job.id !== 'string' || !entry.name.startsWith(`${job.id}.`)
        || !Number.isFinite(Date.parse(job.submittedAt))) throw Error('job identity or time');
      if (job.tree !== tree) throw Error('job tree');
      const doneBytes = read(path.join(dir, 'done.json'), false);
      row.doneSha256 = hash(doneBytes);
      row.done = parseJsonUnique(doneBytes.toString('utf8'));
      if (row.done.id !== job.id || entry.name !== `${job.id}.${row.done.host}` || !Number.isFinite(Date.parse(row.done.at))
        || Date.parse(row.done.at) < Date.parse(job.submittedAt)) throw Error('done identity or time');
      let bytes;
      try { bytes = read(path.join(dir, 'summary.json'), false); }
      catch (error) {
        // Only a terminal failed attempt with a proven selection can be retried
        // without a summary. Corrupt records and unfinished attempts still refuse.
        if (error.code !== 'ENOENT' || !shardPlan(job)
          || !(Number.isInteger(row.done.exit) && row.done.exit !== 0
            || ['cancelled', 'lease-expired'].includes(row.done.exit))) throw error;
        row.missingSummary = true;
        continue;
      }
      row.summarySha256 = hash(bytes);
      row.summary = parseJsonUnique(bytes.toString('utf8'));
      if (row.summary?.head !== head || row.summary.dirty !== false || typeof row.summary.runId !== 'string'
        || !row.summary.runId || !summaryFiles(row.summary) || !wholeFiles(row.summary)) throw Error('summary head or files');
      if (job.kind === 'shard') {
        if (!shardPlan(job)) throw Error('shard plan');
        const shard = read(path.join(dir, 'shard.json'));
        row.shard = shard;
        if (shard.schema !== 'farm-shard-result/1' || shard.jobId !== job.id || shard.head !== head
          || shard.tree !== job.tree || shard.dirty !== false || shard.listOk !== true || shard.refused !== null
          || shard.exit !== row.done.exit || shard.summarySha256 !== hash(bytes)
          || !same(shard.files, job.files) || !same(job.files, summaryFiles(row.summary))
          || JSON.stringify(shard.plan) !== JSON.stringify(job.plan)) throw Error('shard binding');
      }
    } catch { row.problem = `missing or inconsistent farm records: ${entry.name}`; }
  }
  return rows;
}

// A red run needs a later green run of its selection or all failed files.
// Without a summary, a terminal shard attempt needs its whole planned index
// on the same head/tree, even when a rerun has a new plan digest.
function repair(row, rows) {
  if (green(row)) return [row];
  if (!row.problem && row.missingSummary) {
    const later = rows.find(other => green(other) && shardPlan(other.job)
      && other.job.sha === row.job.sha && other.job.tree === row.job.tree
      && other.job.plan.index === row.job.plan.index && other.job.plan.count === row.job.plan.count
      && same(other.job.files, row.job.files) && Date.parse(other.done.at) > Date.parse(row.done.at));
    return later ? [row, later] : null;
  }
  if (row.problem || row.done?.headOk !== true || !Number.isInteger(row.done.exit) || row.done.exit === 0
    || !Number.isInteger(row.summary?.exit) || row.summary.exit === 0) return null;
  const all = summaryFiles(row.summary);
  if (!all || row.summary.files.some(f => !['pass', 'skip', 'unknown', 'fail'].includes(f.status))) return null;
  // A red aggregate cannot prove an unmeasured file passed. Its repair must
  // cover unknown files as well as the files with measured failures.
  const tail = row.summary.files.filter(f => ['fail', 'unknown'].includes(f.status)).map(f => f.name);
  if (!tail.length) return null;
  const later = rows.find(other => green(other) && Date.parse(other.done.at) > Date.parse(row.done.at)
    && (same(summaryFiles(other.summary), all) || same(summaryFiles(other.summary), tail)));
  return later ? [row, later] : null;
}

function fullRun(rows, files) {
  const relevant = rows.filter(r => ['suite', 'shard', 'file'].includes(r.job.kind));
  if (!relevant.some(r => r.job.kind !== 'file')) throw Error('tested head has no full farm run summaries');
  for (const row of relevant) if (!repair(row, rows)) throw Error(row.problem || `unrepaired or unfinished run: ${path.basename(row.dir)}`);
  const proofs = relevant.flatMap(r => repair(r, rows));
  for (const row of relevant.filter(r => r.job.kind === 'suite')) {
    if (row.summary.mode === 'full' && same(summaryFiles(row.summary), files)) return [...new Set([row, ...proofs])];
  }
  const groups = new Map();
  for (const row of relevant.filter(r => r.job.kind === 'shard')) {
    const p = row.job.plan;
    if (!shardPlan(row.job) || p.count > files.length) continue;
    const key = `${p.sha256}:${p.count}:${row.job.tree}`;
    if (!groups.has(key)) groups.set(key, new Map());
    const group = groups.get(key), previous = group.get(p.index);
    if (previous && !same(previous.job.files, row.job.files)) throw Error('one shard index names different selections');
    if (!previous || Date.parse(row.done.at) > Date.parse(previous.done.at)) group.set(p.index, row);
  }
  for (const group of groups.values()) {
    const base = [...group.values()], count = base[0].job.plan.count;
    if (group.size !== count) continue;
    const ran = base.flatMap(r => r.job.files);
    if (new Set(ran).size !== ran.length || !same(ran, files)) continue;
    return [...new Set([...base, ...proofs])];
  }
  throw Error('tested head has no complete full-suite coverage (missing shards or files)');
}

function check({ git, testedHead, head, results, gatesLog }) {
  const fallback = reason => ({ ok: false, verdict: 'FULL-RUN', testedHead, head, reason });
  try {
    if (!SHA.test(testedHead || '')) throw Error('tested head must be a full commit SHA');
    const resolved = git.strict(['rev-parse', '--verify', '--end-of-options', `${testedHead}^{commit}`]).trim();
    if (resolved !== testedHead) throw Error('tested head does not resolve exactly');
    const tree = git.strict(['rev-parse', '--verify', '--end-of-options', `${testedHead}^{tree}`]).trim();
    head = git.strict(['rev-parse', '--verify', '--end-of-options', `${head}^{commit}`]).trim();
    if (!SHA.test(head)) throw Error('train tip is not a commit');
    const paths = git.strict(['diff', '--name-only', '--no-renames', '-z', testedHead, head, '--']).split('\0').filter(Boolean);
    const outside = paths.find(n => !documentPath(n));
    if (outside) return { ...fallback(`path outside document list: ${outside}`), firstOutside: outside, paths };
    // A symlink or submodule at an otherwise allowed name is executable input.
    for (const commit of [testedHead, head]) {
      if (!paths.length) continue;
      const changed = new Set(paths);
      const entries = git.strict(['ls-tree', '-r', '-z', commit]).split('\0')
        .filter(e => changed.has(e.slice(e.indexOf('\t') + 1)));
      if (entries.some(e => !/^100(?:644|755) blob /.test(e))) return fallback('non-regular document path');
    }
    if (!results) throw Error('farm results directory is missing');
    const files = suiteAt(git, testedHead);
    const rows = farmRows(results, testedHead, tree), run = fullRun(rows, files);
    if (!gatesLog) throw Error('tested head gates log is missing');
    const gatesBytes = read(gatesLog, false);
    if (!gatesBytes.length) throw Error('tested head gates log is empty');
    // A concurrent rerun or a partial writer is a named refusal, not a certificate
    // built from records that no longer agree with the state that was inspected.
    if (JSON.stringify(rows) !== JSON.stringify(farmRows(results, testedHead, tree))) throw Error('farm results changed during the check');
    const farmRun = run.map(r => ({ job: r.job.id, summary: r.missingSummary ? null : path.join(r.dir, 'summary.json'),
      runId: r.summary?.runId || null, sha256: r.summarySha256 || null,
      done: { path: path.join(r.dir, 'done.json'), sha256: r.doneSha256 } }));
    const landingRecord = { schema: 'train-docs-landing/1', testedHead, head, farmRun,
      gatesLog: { path: path.resolve(gatesLog), sha256: hash(gatesBytes) }, paths,
      required: ['product gates a-j', 'affected tests', 'document-reading tests'] };
    return { ok: true, verdict: 'DOCS-ONLY', testedHead, head, paths, landingRecord };
  } catch (e) {
    return fallback(e.code ? `required input unavailable: ${e.code}` : e.message);
  }
}

module.exports = { documentPath, suiteAt, farmRows, green, repair, fullRun, check };

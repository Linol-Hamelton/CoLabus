'use strict';
// Canonical inputs: full lower-case Git commit/tree ids; committed regular blobs;
// bounded, unique-key UTF-8 JSON farm records in the installation's declared root.
// Farm JSON may use CRLF; links, duplicate keys, undecodable or moving records
// refuse. Hashes establish repeatability, never the identity of a farm writer.
// Candidate code is never executed. Source tooling is loaded from this installation.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const safe = require('./path-safe.cjs');
const text = require('./text-safe.cjs');
const { secretIn } = require('./secrets.cjs');
const quarantine = require('./flake-quarantine.cjs');
const HOME = path.resolve(__dirname, '../../..');
const SHA = /^[0-9a-f]{40}$/;
const BOUNDARY = 'FARM_WRITER_BOUNDARY: procedural; record digests do not authenticate writers';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const fail = (code, detail) => { throw Object.assign(Error(detail), { code }); };
const farmCode = suffix => `LANDING_FARM_${suffix}`;
const json = bytes => {
  const decoded = text.decode(bytes, { bom: 'refuse', crlf: 'normalise', invisible: 'refuse' });
  if (!decoded.ok) fail(farmCode('RESULT_INVALID'), 'record encoding');
  return text.parseJsonUnique(decoded.text);
};

function gitReader(root, env = process.env) {
  const cleanEnv = { ...env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' };
  for (const k of Object.keys(cleanEnv)) if (/^GIT_/i.test(k) && !['GIT_OPTIONAL_LOCKS', 'GIT_TERMINAL_PROMPT'].includes(k)) delete cleanEnv[k];
  return { strict(args, unused, options = {}) {
    const r = spawnSync('git', args, { cwd: root, env: cleanEnv, encoding: options.buffer ? undefined : 'utf8',
      input: options.input, windowsHide: true, timeout: 30000, maxBuffer: 128 * 1024 * 1024 });
    if (r.error || !(options.accepted || [0]).includes(r.status)) fail('LANDING_REPOSITORY_INVALID', `git ${args[0]} failed`);
    return r.stdout;
  } };
}

// No checkout or candidate script is needed for an exact-tree reader.
function snapshot(git, head) {
  const entries = new Map(git.strict(['ls-tree', '-r', '-z', head]).split('\0').filter(Boolean).map(line => {
    const m = /^([0-7]{6}) (blob|commit) ([0-9a-f]{40})\t(.+)$/.exec(line);
    if (!m) fail('LANDING_REPOSITORY_INVALID', 'tree inventory');
    return [m[4], { mode: m[1], type: m[2], oid: m[3] }];
  }));
  const cache = new Map();
  const bytes = (_, name) => {
    const e = entries.get(name);
    if (!e) return null;
    if (e.type !== 'blob' || !['100644', '100755'].includes(e.mode)) fail('LANDING_REPOSITORY_INVALID', `non-regular blob ${name}`);
    if (!cache.has(name)) cache.set(name, Buffer.from(git.strict(['cat-file', 'blob', e.oid], undefined, { buffer: true })));
    return cache.get(name);
  };
  const query = (_, args) => {
    if (args[0] === 'ls-files') return ''; // committed snapshots have no untracked input
    if (args[0] !== 'grep') fail('LANDING_REPOSITORY_INVALID', 'snapshot query');
    // git grep exit 1 means an empty inventory, not an unavailable repository.
    const output = git.strict(['grep', '-l', '-I', '-E', 'worklog|journals-archive', head, '--', 'tests', 'tools', 'docs/ops'],
      undefined, { accepted: [0, 1] });
    return output.split('\n').filter(Boolean).map(n => n.slice(head.length + 1))
      .filter(n => /\.(cjs|mjs|js|ts|tsx|jsx|py|ps1|sh)$/.test(n) && !n.startsWith('docs/ops/journals-archive/')).sort().join('\n');
  };
  return { bytes, git: query, entries, cache };
}

function readerFacts(root, source, corpus, derived) {
  const findings = derived.pins(root, source);
  if (findings.length) fail('LANDING_READER_PINS', findings.join('\n'));
  const raw = source.bytes(root, derived.PINS);
  corpus.assertInventory(json(raw), root, { bytes: source.bytes,
    discover: () => source.git(root, ['grep']).split('\n').filter(Boolean) });
}

// Reruns copied to another run name retain their original plan/head/tree/index.
// Within a job numeric attempt decides; across jobs submittedAt decides. The id's
// timestamp is not a clock (operators have copied jobs with backdated ids).
// Equal deciding keys remain duplicates for aggregate to refuse.
function rankAttempts(plan, collected) {
  const jobTimes = new Map(collected.jobs.filter(r => r.job.plan?.sha256 === plan.planSha256)
    .map(r => [r.job.id, Date.parse(r.job.submittedAt)]));
  const keys = new Map();
  const key = (id, attempt) => `${jobTimes.get(id)}:${attempt}`;
  for (const r of collected.results) {
    const k = key(r.job.id, r.job.attempt || 0);
    keys.set(k, [jobTimes.get(r.job.id), r.job.attempt || 0]);
    for (const a of r.requeues || []) keys.set(key(r.job.id, a + 1), [jobTimes.get(r.job.id), a + 1]);
  }
  for (const a of collected.attempts) keys.set(key(a.jobId, a.attempt), [jobTimes.get(a.jobId), a.attempt]);
  if ([...keys.values()].some(([t]) => !Number.isFinite(t))) fail(farmCode('RESULT_INVALID'), 'attempt submission time unavailable');
  const ranks = new Map([...keys].sort((a, b) => a[1][0] - b[1][0] || a[1][1] - b[1][1]).map(([k], i) => [k, i]));
  return { ...collected,
    results: collected.results.map(r => ({ ...r, job: { ...r.job, attempt: ranks.get(key(r.job.id, r.job.attempt || 0)) },
      requeues: (r.requeues || []).map(a => ranks.get(key(r.job.id, a + 1)) - 1) })),
    attempts: collected.attempts.map(a => ({ ...a, attempt: ranks.get(key(a.jobId, a.attempt)) })) };
}

function quarantineFacts({ root, source, base, head, git, rows, now }) {
  if (!rows.length) return rows; // the aggregate names missing/pending shards
  const raw = source.bytes(root, quarantine.FILE);
  const register = raw === null ? { state: 'absent', rows: [], closed: new Map(), problems: [] } : quarantine.parseRegister(raw.toString('utf8'));
  if (raw !== null) {
    register.problems.push(...quarantine.treeProblems(root, register.rows, register.closed,
      (_, name, cap) => { const b = source.bytes(root, name); return b && b.length <= cap ? b.toString('utf8') : null; }));
    register.state = register.problems.length ? 'invalid' : 'ok';
  }
  const changed = new Set(git.strict(['diff', '--name-only', '--no-renames', '-z', base, head, '--']).split('\0').filter(Boolean));
  const verdict = quarantine.suiteVerdict({ summaries: rows.filter(r => r.summary).map(r => ({ name: r.dir, data: r.summary })),
    register, nowMs: now, changed });
  if (!verdict.ok) fail(farmCode('RED'), verdict.lines.join('\n'));
  // Only a proven quarantine lowering may normalize the raw fail counters for
  // the strict aggregator. Unknown status is never normalized.
  return rows.map(r => {
    const s = r.summary;
    if (!s || !(s.counts?.fail > 0 || s.files.some(f => f.status === 'fail'))) return r;
    const failures = s.failures;
    if (s.exit !== 0 || !s.quarantine?.lowered || s.quarantine.red !== 0 ||
      !Array.isArray(failures) || !failures.length || failures.length !== s.counts.fail ||
      failures.some(f => f.covered !== true) || s.files.some(f => f.status === 'fail' &&
        (f.quarantined !== true || !failures.some(q => (q.entry || q.file) === f.name)))) return r;
    const summary = { ...s, counts: { ...s.counts, fail: 0, skip: s.counts.skip + s.counts.fail },
      files: s.files.map(f => f.status === 'fail' ? { ...f, status: 'skip' } : f) };
    // The original raw hash was checked before normalization. Preserve it in
    // the raw digest inventory; these in-memory rows have their own hash.
    const summarySha256 = hash(`${JSON.stringify(summary, null, 1)}\n`);
    return { ...r, summary, summarySha256, shard: r.shard && { ...r.shard, summarySha256 } };
  });
}

function landingFacts(options = {}) {
  const root = path.resolve(options.root || process.cwd()), recordsRead = new Map(), listings = new Map(), proofs = [];
  const answer = { schema: 'landing-facts/1', head: SHA.test(options.head || '') ? options.head : null,
    tree: SHA.test(options.tree || '') ? options.tree : null, ok: false, verdict: 'REFUSED',
    applicable: true, writerBoundary: BOUNDARY, reasons: [], records: [] };
  const git = options.git || gitReader(root, options.env);
  const local = name => json(fs.readFileSync(path.join(root, name)));
  let farmRoot;
  const read = (name, isJson = true) => {
    const got = safe.realInside(farmRoot, path.join(farmRoot, name), { refuseHardlinks: true });
    if (!got.ok || !got.exists || got.type !== 'file') fail(farmCode('RESULT_INVALID'), `unsafe or missing ${name}`);
    const file = path.join(farmRoot, name), st = fs.lstatSync(file);
    if (!st.isFile() || st.size > 16 * 1024 * 1024 || st.nlink !== 1) fail(farmCode('RESULT_INVALID'), `record bounds ${name}`);
    const bytes = fs.readFileSync(file), digest = hash(bytes);
    const previous = recordsRead.get(name);
    if (previous && previous !== digest) fail(farmCode('UNSETTLED'), `record changed ${name}`);
    recordsRead.set(name, digest);
    return isJson ? json(bytes) : bytes;
  };
  try {
    const installation = local('protocol-manifest.json');
    const trusted = json(fs.readFileSync(path.join(HOME, 'protocol-manifest.json')));
    const sourceInstallation = fs.existsSync(path.join(HOME, 'tools/farm/share-records.cjs')) || trusted.role === 'source';
    if (sourceInstallation && installation.role === 'installed') fail(farmCode('REQUIRED'), 'source installation cannot skip landing verification through an installed-role manifest');
    // The process environment is not a declaration of a trusted farm root.
    const policy = sourceInstallation ? trusted : installation;
    const workRoot = policy.workRoot;
    const declared = options.farmRoot || policy.landingFarmRoot ||
      (installation.role !== 'installed' && workRoot ? path.join(workRoot, 'farm') : null);
    if (installation.role === 'installed' && !declared) {
      Object.assign(answer, { ok: true, verdict: 'NOT_APPLICABLE', applicable: false, reasons: [{ code: 'LANDING_NOT_APPLICABLE', detail: 'installed project without declared farm root; existing host checks decide' }] });
      return answer;
    }
    if (!declared) fail(farmCode('REQUIRED'), 'installation has no declared farm root');
    if (!path.isAbsolute(declared) || !safe.realInside(declared, declared, { allowRoot: true }).ok) fail(farmCode('RESULT_INVALID'), 'farm root refused');
    farmRoot = path.resolve(declared);
    if (!SHA.test(options.head || '') || !SHA.test(options.tree || '') ||
      git.strict(['rev-parse', '--verify', '--end-of-options', `${options.head}^{commit}`]).trim() !== options.head ||
      git.strict(['rev-parse', '--verify', '--end-of-options', `${options.head}^{tree}`]).trim() !== options.tree) fail(farmCode('HEAD_TREE_MISMATCH'), 'candidate must name its full exact commit and tree');
    const source = snapshot(git, options.head);
    // Source helpers belong to this trusted installation, not to the candidate.
    const load = file => require(file);
    const records = load(path.join(HOME, 'tools/farm/share-records.cjs'));
    const aggregate = load(path.join(HOME, 'tools/farm/shard-aggregate.cjs'));
    const corpus = load(path.join(HOME, 'tools/archive/required-corpus.cjs'));
    const derived = load(path.join(HOME, '.ai/bin/ops-tools/source/derived.cjs'));
    const pb = load(path.join(HOME, 'tools/product/product-build.cjs'));
    const trainDocs = load(path.join(HOME, '.ai/bin/ops-tools/lib/train-docs.cjs'));
    const base = options.base || git.strict(['merge-base', options.head,
      `refs/remotes/origin/${installation.integrationBranch}`]).trim();
    if (!SHA.test(base)) fail('LANDING_REPOSITORY_INVALID', 'candidate base unavailable');
    const content = pb.earlyContentCheck({ root, base, source: options.head, publication: true, typedDeferral: true });
    if (!content.ok) fail('LANDING_PUBLICATION_REFUSED', 'publication provenance findings remain');
    const needsProduct = content.nonCopy?.length > 0;
    const names = fs.readdirSync(path.join(farmRoot, 'shard-plans')).filter(n => /^[A-Za-z0-9._-]+\.json$/.test(n)).sort();
    listings.set('shard-plans', names);
    const plans = names.map(n => ({ name: `shard-plans/${n}`, plan: read(`shard-plans/${n}`) }))
      .filter(r => r.plan.head === options.head);
    if (!plans.length) fail(farmCode('REQUIRED'), 'no raw plan of the candidate');
    const candidates = [];
    for (const { name, plan } of plans) {
      records.verifyPlan(plan);
      if (plan.tree !== options.tree) fail(farmCode('HEAD_TREE_MISMATCH'), 'plan tree differs');
      if (plan.selection !== undefined) fail(farmCode('NOT_FULL'), 'selection plan is not a full run');
      const suite = trainDocs.suiteAt(git, options.head, plan.withMutations).map(name => ({ name, blob: source.entries.get(name)?.oid }));
      const coverage = aggregate.suiteProblem(plan, suite);
      if (coverage) fail(farmCode('COVERAGE_INVALID'), coverage);
      const collected = aggregate.collectShare(farmRoot, plan, options.now || Date.now());
      for (const d of collected.digests) {
        if (d.file.endsWith('/')) continue; // checked again through collectShare below
        if (/^[0-9a-f]{64}$/.test(d.sha256)) {
          read(d.file);
          if (recordsRead.get(d.file) !== d.sha256) fail(farmCode('UNSETTLED'), `collector changed ${d.file}`);
        }
      }
      const times = collected.jobs.filter(r => r.job.plan?.sha256 === plan.planSha256).map(r => Date.parse(r.job.submittedAt));
      candidates.push({ name, plan, suite, collected, stamp: times.length ? Math.max(...times) : -1 });
    }
    // A newer incomplete run of the same candidate cannot hide behind an older green.
    candidates.sort((a, b) => b.stamp - a.stamp);
    const chosen = candidates[0], { plan, suite, collected } = chosen;
    if (candidates.length > 1 && candidates[1].stamp === chosen.stamp) fail(farmCode('RESULT_INVALID'), 'ambiguous deciding plans');
    for (const { job } of collected.jobs) {
      if (job.kind === 'shard' && job.verifies === undefined && job.sha === options.head && job.tree === options.tree &&
        job.plan?.sha256 !== plan.planSha256 && !plans.some(p => p.plan.planSha256 === job.plan?.sha256)) fail(farmCode('COVERAGE_INVALID'), 'rerun names another or missing plan digest');
      if (job.plan?.sha256 === plan.planSha256 && (job.sha !== options.head || job.tree !== options.tree)) fail(farmCode('HEAD_TREE_MISMATCH'), 'job head/tree differs from plan');
    }
    // Validate raw summaries before allowing quarantine to normalize proven failures.
    for (const r of collected.results) {
      if (r.summary && r.shard?.summarySha256 !== r.summarySha256) fail(farmCode('RESULT_INVALID'), 'raw summary hash differs');
      if (r.done?.attempt !== undefined && r.done.attempt !== (r.job.attempt || 0)) fail(farmCode('RESULT_INVALID'), 'done attempt differs from job');
    }
    let ranked = rankAttempts(plan, collected);
    const selecting = aggregate.aggregate({ plan, suite, ...ranked });
    const selected = ranked.results.filter(r => selecting.shards.some(s => s.jobId === r.job.id && s.host === r.done?.host));
    const finished = r => Math.max(...[r.shard?.finishedAt, r.done?.at].map(Date.parse).filter(Number.isFinite));
    answer.decidingAttempts = selected.map(r => {
      const raw = collected.results.find(row => row.dir === r.dir);
      return { index: r.job.plan.index, jobId: r.job.id, host: r.done.host, attempt: raw.job.attempt || 0,
        submittedAt: r.job.submittedAt, finishedAt: r.shard?.finishedAt, doneAt: r.done.at };
    });
    const normalized = quarantineFacts({ root, source, base, head: options.head, git, rows: selected, now: options.now || Date.now() });
    // A backdated submission cannot conceal a later completed red result of the
    // same plan shard. Reuse the ordinary verdict and quarantine policy for it.
    for (const deciding of selected) for (const later of ranked.results.filter(r => r.job.plan.index === deciding.job.plan.index &&
      r.dir !== deciding.dir && finished(r) > finished(deciding))) {
      const checked = quarantineFacts({ root, source, base, head: options.head, git, rows: [later], now: options.now || Date.now() });
      const probe = aggregate.aggregate({ plan, suite, results: [...normalized.filter(r => r.job.plan.index !== later.job.plan.index), ...checked],
        attempts: [], unsettled: [], unread: [] });
      if (probe.verdict !== 'green') fail(farmCode('RED'), `later finished result ${later.dir} supersedes the deciding proof: ${probe.reasons.join('; ')}`);
    }
    const replacements = new Map(normalized.map(r => [r.dir, r]));
    ranked = { ...ranked, results: ranked.results.map(r => replacements.get(r.dir) || r) };
    const receipt = aggregate.aggregate({ plan, suite, ...ranked });
    answer.farm = { plan: chosen.name, planSha256: plan.planSha256, receiptSha256: receipt.receiptSha256,
      shards: receipt.shards, files: receipt.files.length, counts: receipt.counts };
    if (!receipt.ready || receipt.unsettled.length || receipt.unread.length || receipt.pending.length) fail(farmCode('UNSETTLED'), receipt.reasons.join('; '));
    if (!receipt.complete || receipt.shards.length !== plan.count || receipt.unproven !== 0) fail(farmCode('RESULT_INVALID'), receipt.reasons.join('; ') || 'incomplete results');
    if (receipt.verdict !== 'green' || receipt.counts.fail !== 0) {
      const mismatch = selected.some(r => r.shard && (r.shard.head !== options.head || r.shard.tree !== options.tree) || r.summary?.head !== options.head);
      fail(farmCode(mismatch ? 'HEAD_TREE_MISMATCH' : 'RED'), receipt.reasons.join('; '));
    }
    if (needsProduct) {
      for (const row of selected) {
        const dir = `results/${row.dir}/product-gates`;
        let files;
        try { files = fs.readdirSync(path.join(farmRoot, dir)).sort(); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
        listings.set(dir, files);
        if (!Array.isArray(row.shard?.productGates) || JSON.stringify(files) !== JSON.stringify(row.shard.productGates.map(r => r.file))) fail('LANDING_PRODUCT_REQUIRED', 'product inventory is not bound by shard.json');
        for (const n of files) {
          if (!/^[A-Za-z0-9._-]+\.json$/.test(n)) fail('LANDING_PRODUCT_REQUIRED', 'product gate inventory invalid');
          const proof = read(`${dir}/${n}`);
          if (row.shard.productGates.find(r => r.file === n)?.sha256 !== recordsRead.get(`${dir}/${n}`)) fail('LANDING_PRODUCT_REQUIRED', 'product inventory digest differs from shard.json');
          if (proof.schema !== 'farm-suite-product-gates/1' || proof.head !== options.head || proof.tree !== options.tree ||
            proof.jobId !== row.job.id || proof.manifestHash !== content.manifestHash || proof.exit !== 0 || !SHA.test(proof.commit || '') ||
            !Array.isArray(proof.gates) || proof.gates.length !== pb.GATES.length ||
            pb.GATES.some(g => proof.gates.filter(r => r.gate === g && r.status === 'PASS').length !== 1) ||
            !row.summary.files.some(f => f.name.startsWith('tests/') && /^product(?:-real|-build)/.test(f.name.slice('tests/'.length)) && f.status === 'pass')) fail('LANDING_PRODUCT_REQUIRED', 'product gate inventory is not an exact green build of this shard');
          proofs.push(`${dir}/${n}`);
        }
      }
      if (!proofs.length) fail('LANDING_PRODUCT_REQUIRED', 'non-copy projection requires exported gates of a passing product-building test in this run');
    }
    readerFacts(root, source, corpus, derived);
    // Repeat the farm readers after all other computation, including product/pin
    // inspection. No cached green result crosses a landing effect.
    const after = aggregate.collectShare(farmRoot, plan, options.now || Date.now());
    if (JSON.stringify(after.digests) !== JSON.stringify(collected.digests) || after.unsettled.length || after.unread.length) fail(farmCode('UNSETTLED'), 'farm changed during landing check');
    for (const [file, digest] of recordsRead) if (hash(read(file, false)) !== digest) fail(farmCode('UNSETTLED'), `record changed ${file}`);
    for (const [dir, names] of listings) {
      const current = fs.readdirSync(path.join(farmRoot, dir)).filter(n => dir !== 'shard-plans' || /^[A-Za-z0-9._-]+\.json$/.test(n)).sort();
      if (JSON.stringify(current) !== JSON.stringify(names)) fail(farmCode('UNSETTLED'), `inventory changed ${dir}`);
    }
    answer.productProof = proofs;
    Object.assign(answer, { ok: true, verdict: 'PASS' });
  } catch (e) {
    const own = /^LANDING_[A-Z_]+$/.test(e.code || '');
    const detail = own ? String(e.message).slice(0, 12000) : 'invalid or unavailable required input';
    answer.reasons.push({ code: own ? e.code : farmCode('RESULT_INVALID'), detail: secretIn(detail) ? '[REDACTED]' : detail });
  } finally {
    answer.records = [...recordsRead].sort(([a], [b]) => a.localeCompare(b)).map(([file, sha256]) => ({ file, sha256 }));
    answer.recordsSha256 = hash(JSON.stringify(answer.records));
    answer.listings = [...listings].map(([directory, names]) => ({ directory, sha256: hash(JSON.stringify(names)) }));
  }
  return answer;
}

function assertLanding(options) {
  const result = landingFacts(options);
  if (options.say) options.say(`${result.writerBoundary}\n${JSON.stringify(result)}`);
  if (!result.ok) fail(result.reasons[0].code, result.reasons.map(r => `${r.code}: ${r.detail}`).join('; '));
  return result;
}
module.exports = { BOUNDARY, gitReader, snapshot, readerFacts, rankAttempts, quarantineFacts, landingFacts, assertLanding };

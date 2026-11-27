'use strict';
// Closed generated-output inventory; only named owning generators are invoked.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual: equal } = require('node:util');
const { parseJsonUnique } = require('../../lib/text-safe.cjs');
const safe = require('../../lib/path-safe.cjs');
const { createRunTemp, settleRunTemp, runTempEnv } = require('../../lib/run-temp.cjs');

const POLICY_PATH = '.ai/bin/ops-tools/lib/generated.cjs';
const PINS_PATH = 'tools/archive/corpus-readers.json';
const CITATIONS_PATH = 'docs/ops/register-fragments/citation-consumers.json';
// Input-bearing classification fields in PINS_PATH are merged separately.
// Order matters: consumers sees the complete final inventory, and runs last.
const OUTPUTS = Object.freeze([
  { path: '.ai/core/CATALOG.md', tool: '.ai/bin/protocol-core.cjs', args: ['catalog'] },
  { path: 'docs/ops/OPEN-REGISTER-TABLE.md', tool: 'tools/open-register/table.cjs', args: ['--write'] },
  { path: PINS_PATH, tool: 'tools/archive/refresh-reader-pins.cjs', api: 'refresh' },
  { path: 'docs/ops/routes/cli-routes.json', tool: 'docs/ops/routes/generate.cjs', args: [] },
  // Document rows follow the tracked tree; consumers and reviewed non-reader rows are hand-written input.
  // A tree that predates the tool holds the inventory as plain data; it is an output only where its generator is tracked.
  { path: CITATIONS_PATH, tool: 'tools/open-register/citation-rows.cjs', args: ['add'], needsTool: true },
  // Keep the tracked index until the shadow removal criterion is satisfied.
  { path: 'docs/ops/test-consumers.json', tool: 'tools/suite-consumers.cjs', api: 'refresh' },
]);
const PATHS = new Set(OUTPUTS.map(x => x.path));
const fail = detail => { throw Object.assign(Error(detail), { code: 'TRAIN-LAND-GENERATED', detail }); };

function pinMetadata(bytes) {
  let rows;
  try { rows = parseJsonUnique(bytes.toString('utf8')); } catch { fail('reader inventory is invalid JSON'); }
  if (!Array.isArray(rows)) fail('reader inventory must be an array');
  const result = new Map();
  for (const row of rows) {
    if (!row || typeof row.path !== 'string' || result.has(row.path) ||
        !['owner-assertions', 'fixture', 'path-policy', 'adaptive', 'preflight'].includes(row.mode) ||
        typeof row.corpus !== 'string' || !row.corpus || typeof row.property !== 'string' || !row.property) {
      fail('reader inventory has duplicate or unclassified rows');
    }
    const { sha256, ...metadata } = row;
    result.set(row.path, metadata);
  }
  return result;
}

function mergePins(base, ours, theirs) {
  const b = pinMetadata(base), o = pinMetadata(ours), t = pinMetadata(theirs);
  const rows = [];
  for (const name of [...new Set([...b.keys(), ...o.keys(), ...t.keys()])].sort()) {
    const bv = b.get(name), ov = o.get(name), tv = t.get(name);
    let row;
    if (equal(ov, tv)) row = ov;
    else if (equal(ov, bv)) row = tv;
    else if (equal(tv, bv)) row = ov;
    else fail(`hand-written reader classification conflict in ${name}`);
    if (row) rows.push({ ...row, sha256: '0'.repeat(64) });
  }
  return Buffer.from(JSON.stringify(rows, null, 2) + '\n');
}

// The citation inventory mixes derived document rows with hand-written consumers and reviewed
// non-reader rows. Each row merges by its own path, so two packages that add neighbouring rows
// never conflict textually; the owning tool then regenerates the document rows from the tree.
function citationDocument(bytes) {
  let doc;
  try { doc = parseJsonUnique(bytes.toString('utf8')); } catch { fail('citation inventory is invalid JSON'); }
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.consumers) || !Array.isArray(doc.exclusions)) fail('citation inventory has an unexpected shape');
  const rows = {};
  for (const section of ['consumers', 'exclusions']) {
    rows[section] = new Map();
    for (const row of doc[section]) {
      if (!row || typeof row.path !== 'string' || rows[section].has(row.path)) fail('citation inventory has an invalid row');
      rows[section].set(row.path, row);
    }
  }
  return { doc, rows };
}

function mergeCitations(base, ours, theirs) {
  const b = citationDocument(base), o = citationDocument(ours), t = citationDocument(theirs);
  const pick = (bv, ov, tv, what) => {
    if (equal(ov, tv)) return ov;
    if (equal(ov, bv)) return tv;
    if (equal(tv, bv)) return ov;
    return fail(`hand-written citation inventory conflict in ${what}`);
  };
  // Keys come from JSON text: a plain object would turn an own "__proto__" key into its prototype.
  const merged = Object.create(null);
  for (const key of new Set([...Object.keys(o.doc), ...Object.keys(t.doc)])) {
    if (key === 'consumers' || key === 'exclusions') {
      const rows = [];
      for (const path of new Set([...b.rows[key].keys(), ...o.rows[key].keys(), ...t.rows[key].keys()])) {
        const row = pick(b.rows[key].get(path), o.rows[key].get(path), t.rows[key].get(path), path);
        if (row) rows.push(row);
      }
      merged[key] = rows.sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));
    } else {
      const own = d => (Object.hasOwn(d, key) ? d[key] : undefined);
      const value = pick(own(b.doc), own(o.doc), own(t.doc), key);
      if (value !== undefined) merged[key] = value;
    }
  }
  return Buffer.from(JSON.stringify(merged, null, 2) + '\n');
}

function inventory(git, tree) {
  const rows = git.strict(['ls-tree', '-rz', tree]).split('\0').filter(Boolean);
  const result = new Map();
  for (const row of rows) {
    const m = /^([0-7]{6}) blob ([a-f0-9]{40,64})\t([^\0]+)$/.exec(row);
    if (!m) fail('unsupported generated-input tree entry');
    result.set(m[3], { mode: m[1], oid: m[2] });
  }
  return result;
}

function active(git, parent, tip) {
  // Old train receipts remain verifiable under their original tree contract.
  const has = ref => git.strict(['ls-tree', '-z', ref, '--', POLICY_PATH]).length > 0;
  return has(parent) || has(tip);
}

function rebuild(git, tree, parent, options = {}) {
  const entries = inventory(git, tree);
  if (!entries.has(POLICY_PATH)) fail('generated-merge policy cannot be removed during a merge');
  const outputs = OUTPUTS.filter(x => entries.has(x.path) && (!x.needsTool || entries.has(x.tool)));
  if (!outputs.length && !options.union && !options.checkRegister) return { treeOid: tree, generated: [] };
  for (const [name, entry] of entries) {
    if (!['100644', '100755'].includes(entry.mode) || name.includes('\\') || name.startsWith('/') ||
        name.split('/').some(s => safe.segmentProblem(s) || /^\.git$/i.test(s)) || /^[A-Za-z]:/.test(name)) {
      fail(`unsafe generated-input entry ${name}`);
    }
  }
  for (const output of outputs) {
    if (entries.get(output.path).mode !== '100644') fail(`non-regular generated output ${output.path}`);
  }
  // A private repository has its own index, HEAD and config; source objects are
  // read through alternates. Generators cannot stage or alter the caller's tree.
  const runtime = path.join(git.cwd, '.ai/runtime');
  const guarded = safe.realInside(git.cwd, runtime);
  if (!guarded.ok) fail('unsafe generated-merge runtime path');
  fs.mkdirSync(runtime, { recursive: true });
  const temp = createRunTemp({ root: runtime, prefix: 'generated-merge-' });
  if (!temp.ok) fail('cannot create generated-merge scratch repository');
  const repo = path.join(temp.dir, 'repo');
  fs.mkdirSync(repo);
  const call = args => {
    const r = spawnSync('git', ['-c', 'core.hooksPath=disabled-hooks', '-c', 'core.autocrlf=false', ...args], {
      cwd: repo, env: runTempEnv(git.safeEnv, temp.dir), encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 256 * 1024 * 1024,
    });
    if (r.error || r.status !== 0) fail(`scratch Git ${args[0]} failed`);
    return r.stdout;
  };
  const run = (args, label) => {
    const r = spawnSync(process.execPath, args, {
      cwd: repo, env: runTempEnv(git.safeEnv, temp.dir), encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024,
    });
    if (r.error || r.status !== 0) {
      // Tool output is diagnostic and may contain private data. Expose only a
      // closed family of register refusal codes, never stdout or a stack trace.
      const reason = `${r.stdout || ''}\n${r.stderr || ''}`.match(/\b(?:ITEM_CONFLICT|ITEM_REMOVED|PROCESS_CONFLICT|PROCESS_REMOVED|PROCESS_DUPLICATE|PROCESS_COVERAGE|PROCESS_EXHAUSTED|METADATA_CONFLICT|METADATA_REMOVED|FILE_CONFLICT|LOCAL_CHANGE|BASE_NOT_ANCESTOR|UNSAFE_PATH|CHECK_FAILED|CITATION_REFUSED)\b/);
      fail(`${label} failed${reason ? `: ${reason[0]}` : ''}`);
    }
    return r.stdout;
  };
  const assertChanges = (baseline, allowed) => {
    const changed = call(['diff', '--name-only', '-z', baseline, '--']) + call(['ls-files', '--others', '-z']);
    for (const name of changed.split('\0').filter(Boolean)) {
      if (!allowed.has(name)) fail('generator changed a hand-written input');
    }
  };
  try {
    call(['init', '-q', '--template=']);
    const objects = path.resolve(git.cwd, git.strict(['rev-parse', '--git-path', 'objects']).trim());
    fs.writeFileSync(path.join(repo, '.git/objects/info/alternates'), objects.split(path.sep).join('/') + '\n');
    call(['read-tree', tree]);
    call(['checkout-index', '--all', '--force']);
    call(['update-ref', 'HEAD', parent]);
    let unionPaths = [], notRewritten = [], packages = [], generatorBase = tree;
    if (options.union) {
      if (!entries.has('docs/ops/OPEN-REGISTER-TABLE.md')) fail('register union requires its tracked generated table');
      const { base, tip } = options.union;
      const code = "const p=require(process.argv[1]).prepare(process.cwd(),process.argv[2],[process.argv[3],process.argv[4]],{canonical:process.argv[3],scratchRoot:process.argv[5]});p.write();console.log(JSON.stringify({files:[...p.outputs.keys()],notRewritten:p.notRewritten,packages:p.packages}));";
      const plan = JSON.parse(run(['-e', code, path.join(repo, 'tools/open-register/merge.cjs'), base, parent, tip, temp.dir], 'register union'));
      unionPaths = plan.files; notRewritten = plan.notRewritten; packages = plan.packages;
      const packagePaths = new Set(git.strict(['diff', '--name-only', '-z', '--no-renames', base, tip, '--']).split('\0'));
      const primary = new Set(['docs/ops/OPEN-REGISTER.json', 'docs/ops/PROCESS-REGISTER.md', 'docs/ops/OPEN-REGISTER-TABLE.md']);
      for (const name of unionPaths) {
        if (typeof name !== 'string' || (!primary.has(name) && !packagePaths.has(name)) ||
            /^(?:\.ai\/worklog\/|docs\/(?:reviews|archive)\/)|(?:^|\/)ARCHIVE\.md$/.test(name) ||
            !safe.realInside(repo, path.join(repo, name), { refuseHardlinks: true }).ok) fail('unsafe register union output');
      }
      assertChanges(tree, new Set(unionPaths));
      call(['add', '--', ...unionPaths]);
      generatorBase = call(['write-tree']).trim();
    } else if (options.checkRegister) {
      run([path.join(repo, 'tools/open-register/check.cjs')], 'merged register check');
    }
    const fresh = new Map();
    for (const output of outputs) {
      // This is the owning tool FROM THE MERGED TREE, including its merged
      // dependencies. Landing already-authorized local candidates runs their
      // generators; this is not a sandbox for arbitrary untrusted branches.
      const tool = path.join(repo, output.tool);
      if (!fs.existsSync(tool)) fail(`owning generator unavailable: ${output.tool}`);
      // Never let temporary ours bytes masquerade as a successful rebuild.
      // Keep the path in the inventory (consumers needs it), but regenerate
      // pure projections from empty bytes. Pins also carry hand-written input:
      // preserve every metadata field and invalidate only the derived hashes.
      const file = path.join(repo, output.path);
      // The citation inventory is also hand-written input, and its tool keeps what it did not derive.
      const seed = output.path === PINS_PATH ? Buffer.from(JSON.stringify(
        [...pinMetadata(fs.readFileSync(file)).values()].map(row => ({ ...row, sha256: '0'.repeat(64) })), null, 2) + '\n\n')
        : output.path === CITATIONS_PATH ? Buffer.concat([fs.readFileSync(file), Buffer.from('\n')]) : Buffer.alloc(0);
      fs.writeFileSync(file, seed);
      const args = output.api ? ['-e', 'require(process.argv[1]).refresh(process.cwd())', tool] : [tool, ...output.args];
      run(args, `owning generator ${output.tool}`);
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) fail('generator output is not a regular private file');
      if (fs.readFileSync(file).equals(seed)) fail(`owning generator wrote no output: ${output.path} (${output.tool})`);
      fresh.set(output.path, fs.readFileSync(file));
    }
    assertChanges(generatorBase, PATHS);
    // Anchor the checked generator result before the train-owned writer runs.
    // Its only permitted delta is the observation stream, never a generator input.
    call(['add', '-A']);
    const shadowBase = call(['write-tree']).trim();
    // Only train squashes append; author line merges never impersonate a train.
    // The stream already exists in the inventory, so appending cannot change
    // the consumer graph (JSON contents are not graph inputs).
    let shadow = null;
    const shadowPath = 'docs/ops/INDEX-SHADOW.jsonl';
    const shadowMode = JSON.parse(fs.readFileSync(path.join(repo, 'protocol-manifest.json'), 'utf8')).consumerIndex?.mode || 'off';
    if (!['off', 'shadow'].includes(shadowMode)) fail('invalid index shadow mode');
    if (shadowMode === 'shadow' && (!entries.has('.ai/bin/ops-tools/lib/index-shadow.cjs') ||
        !entries.has(shadowPath) || !entries.has('docs/ops/test-consumers.json'))) fail('index shadow inputs unavailable');
    if (options.shadow && shadowMode === 'shadow') {
      const tool = path.join(repo, '.ai/bin/ops-tools/lib/index-shadow.cjs');
      shadow = JSON.parse(run(['-e', 'console.log(JSON.stringify(require(process.argv[1]).record(process.cwd(),process.argv[2],process.argv[3])))',
        tool, parent, options.shadow.tip], 'index shadow'));
    }
    // The observation writer may change only the train-owned stream.
    assertChanges(shadowBase, new Set(shadow?.active ? [shadowPath] : []));
    const updates = [];
    for (const name of new Set([...unionPaths, ...outputs.map(x => x.path), ...(shadow?.active ? [shadowPath] : [])])) {
      const file = path.join(repo, name), st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) fail('generator output is not a regular private file');
      const bytes = fs.readFileSync(file);
      if (fresh.has(name) && !bytes.equals(fresh.get(name))) fail(`output changed after owning generator: ${name} (${outputs.find(output => output.path === name).tool})`);
      const oid = git.strict(['hash-object', '-w', '--stdin'], 'TRAIN-LAND-GENERATED', { input: bytes }).trim();
      updates.push({ path: name, mode: entries.get(name)?.mode || '100644', oid });
    }
    return { updates, generated: outputs.map(x => x.path), notRewritten, packages, shadow };
  } finally {
    const result = settleRunTemp(temp);
    if (!['removed', 'gone'].includes(result.action)) fail('generated-merge scratch cleanup failed');
  }
}

module.exports = { POLICY_PATH, PINS_PATH, CITATIONS_PATH, OUTPUTS, PATHS, mergePins, mergeCitations, active, rebuild };

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
// Input-bearing classification fields in PINS_PATH are merged separately.
// Order matters: consumers sees the complete final inventory, and runs last.
const OUTPUTS = Object.freeze([
  { path: '.ai/core/CATALOG.md', tool: '.ai/bin/protocol-core.cjs', args: ['catalog'] },
  { path: 'docs/ops/OPEN-REGISTER-TABLE.md', tool: 'tools/open-register/table.cjs', args: ['--write'] },
  { path: PINS_PATH, tool: 'tools/archive/refresh-reader-pins.cjs', api: 'refresh' },
  { path: 'docs/ops/routes/cli-routes.json', tool: 'docs/ops/routes/generate.cjs', args: [] },
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
  const outputs = OUTPUTS.filter(x => entries.has(x.path));
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
      const reason = `${r.stdout || ''}\n${r.stderr || ''}`.match(/\b(?:ITEM_CONFLICT|ITEM_REMOVED|PROCESS_CONFLICT|PROCESS_REMOVED|PROCESS_DUPLICATE|PROCESS_COVERAGE|PROCESS_EXHAUSTED|METADATA_CONFLICT|METADATA_REMOVED|FILE_CONFLICT|LOCAL_CHANGE|BASE_NOT_ANCESTOR|UNSAFE_PATH|CHECK_FAILED)\b/);
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
      const seed = output.path === PINS_PATH ? Buffer.from(JSON.stringify(
        [...pinMetadata(fs.readFileSync(file)).values()].map(row => ({ ...row, sha256: '0'.repeat(64) })), null, 2) + '\n\n') : Buffer.alloc(0);
      fs.writeFileSync(file, seed);
      const args = output.api ? ['-e', 'require(process.argv[1]).refresh(process.cwd())', tool] : [tool, ...output.args];
      run(args, `owning generator ${output.tool}`);
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) fail('generator output is not a regular private file');
      if (fs.readFileSync(file).equals(seed)) fail(`owning generator wrote no output: ${output.path} (${output.tool})`);
      fresh.set(output.path, fs.readFileSync(file));
    }
    // A generator may change only its declared output (including untracked files).
    assertChanges(generatorBase, PATHS);
    const updates = [];
    for (const name of new Set([...unionPaths, ...outputs.map(x => x.path)])) {
      const file = path.join(repo, name), st = fs.lstatSync(file);
      if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1) fail('generator output is not a regular private file');
      const bytes = fs.readFileSync(file);
      if (fresh.has(name) && !bytes.equals(fresh.get(name))) fail(`output changed after owning generator: ${name} (${outputs.find(output => output.path === name).tool})`);
      const oid = git.strict(['hash-object', '-w', '--stdin'], 'TRAIN-LAND-GENERATED', { input: bytes }).trim();
      updates.push({ path: name, mode: entries.get(name)?.mode || '100644', oid });
    }
    return { updates, generated: outputs.map(x => x.path), notRewritten, packages };
  } finally {
    const result = settleRunTemp(temp);
    if (!['removed', 'gone'].includes(result.action)) fail('generated-merge scratch cleanup failed');
  }
}

module.exports = { POLICY_PATH, PINS_PATH, OUTPUTS, PATHS, mergePins, active, rebuild };

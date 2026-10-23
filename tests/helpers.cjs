'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
// Fixture directories come from docs/ops/lib/test-tmp.cjs (removed after a passing test, kept for a failed one).
// tests/ is copied into the fixtures of the protocol source, and docs/ops is not part of that copy, so a fixture falls back to a minimal inline version.
const tt = (() => {
  try { return require('../docs/ops/lib/test-tmp.cjs'); } catch { /* no docs/ops here: use the fallback below */ }
  const dirs = new Set();
  const drop = d => { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* left for the OS temp cleanup */ } dirs.delete(d); };
  process.on('exit', () => { if (!process.exitCode) for (const d of [...dirs]) drop(d); });
  return {
    mkTmp(prefix, t) {
      const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
      dirs.add(d);
      if (t && typeof t.after === 'function') t.after(() => { if (t.passed !== false) drop(d); });
      return d;
    },
    cleanup(d) { for (const x of d ? [path.resolve(d)] : [...dirs]) if (dirs.has(x)) drop(x); },
    keep(d) { dirs.delete(path.resolve(d)); },
    isRegistered(d) { return dirs.has(path.resolve(d)); },
    isolateTemp(prefix = 'tmp-iso-') { const d = this.mkTmp(prefix); for (const k of ['TEMP', 'TMP', 'TMPDIR']) process.env[k] = d; return d; },
  };
})();

const repoRoot = path.resolve(__dirname, '..');

// Every test that runs a launcher passes its OWN work root inside its fixture temp directory, and this shared
// helper builds it - a fresh fixture per call, with the work root inside it, so a launcher under test can never create its per-launch
// directory or a cache outside the fixture. The single-drive opt-in is the documented production escape for a host whose own temp lives on
// the system drive; the physical production checks themselves stay active and run on every launch (nothing is stubbed or disabled).
// The env also names a private probe root of the route check (OK_PROBE_TEMP, beside the work root in
// the same fixture), so a launcher under test reads its route record there and never touches the operator's shared probe root; on Windows
// only where the fixture lies on drive D (the probe root rule), else the variable is left out.
function launchWorkRoot(t, leaf = 'work-root') {
  const fixture = tt.mkTmp('launch-workroot-', t);
  const root = path.join(fixture, leaf);
  fs.mkdirSync(root);
  const probe = process.platform !== 'win32' || /^[Dd]:/.test(fixture) ? { OK_PROBE_TEMP: path.join(fixture, 'probe-root') } : {};
  return { root, fixture, env: { PROTOCOL_WORK_ROOT: root, PROTOCOL_WORK_ROOT_ON_SYSTEM_DRIVE: '1', ...probe } };
}

// Every client a launcher starts passes the route check at the one spawn point (spawnClient of the seat failover module), which reads the operator's live route record by default. A launcher test that is not about that check passes this as deps.routeGate:
// a gate module and a route record that do not exist, so the launcher runs as in a project that carries neither (the check has nothing to decide, as in
// a host project of the pilot kit) and the test never depends on the live record or the clock. The route check itself is tested on its own fixture
// records (the route-step and seat failover tests). The paths are checked absent on every call.
const NO_ROUTE_GATE_DIR = path.join(repoRoot, 'tests', 'no-route-gate-absent');
function noRouteGate() {
  const gate = { module: path.join(NO_ROUTE_GATE_DIR, 'absent-gate.cjs'), recordFile: path.join(NO_ROUTE_GATE_DIR, 'absent-record.json') };
  if (fs.existsSync(gate.module) || fs.existsSync(gate.recordFile)) throw new Error(`noRouteGate: ${NO_ROUTE_GATE_DIR} must not exist`);
  return gate;
}

function run(command, args, cwd = repoRoot, options = {}) {
  return spawnSync(command, args, {
    cwd, encoding: 'utf8', windowsHide: true, timeout: 120000,
    maxBuffer: 16 * 1024 * 1024, ...options,
  });
}

// A child process whose result is read only after it ran cleanly: no error, no signal, status 0. Anything else throws with the command and the
// cause in the message, whatever the output holds (a partial output of a failed call must never be taken for an answer). `spawn` is the call
// under test; tests inject a stand-in to show that each kind of failure is a failure.
function runChecked(command, args, options = {}, spawn = spawnSync) {
  const cmd = `${command} ${args.join(' ')}`;
  const r = spawn(command, args, options);
  if (!r || r.error !== undefined) throw new Error(`${cmd} did not run: ${r && r.error ? r.error.message : 'no result'}`);
  if (r.signal !== null && r.signal !== undefined) throw new Error(`${cmd} was killed by signal ${r.signal}`);
  if (r.status !== 0) throw new Error(`${cmd} exited with status ${r.status}: ${String(r.stderr || '').trim()}`);
  return r;
}

function git(cwd, args) {
  return run('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=Protocol Test',
    '-c', 'user.email=protocol-test@example.invalid', ...args], cwd);
}

function runPowerShell(script, args = [], cwd = repoRoot) {
  const shell = process.env.PROTOCOL_TEST_POWERSHELL ||
    (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
  return run(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
    path.resolve(cwd, script), ...args], cwd);
}

function write(root, relative, content) {
  const destination = path.resolve(root, relative);
  const relation = path.relative(root, destination);
  if (relation.startsWith('..') || path.isAbsolute(relation)) {
    throw new Error('Fixture write must stay inside its root');
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, content);
  return destination;
}

const fixturePool = [];
let fixtureFamily = null;

function snapshotFiles(base, relative = '') {
  const files = [];
  const absolute = path.join(base, relative);
  const stat = fs.lstatSync(absolute);
  if (stat.isSymbolicLink()) throw new Error(`Fixture template may not hold links: ${relative}`);
  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(absolute)) files.push(...snapshotFiles(base, path.join(relative, name)));
    return files;
  }
  files.push({ relative, bytes: fs.readFileSync(absolute), mode: stat.mode & 0o777 });
  return files;
}

function restoreFiles(base, files) {
  for (const { relative, bytes, mode } of files) {
    const target = path.join(base, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { mode });
  }
}

function getPooledFixture() {
  while (fixturePool.length > 0) {
    const item = fixturePool.pop();
    if (fs.existsSync(item.root)) {
      return item;
    }
  }
  return null;
}

function releaseFixture(item) {
  try {
    const gitDir = path.join(item.root, '.git');
    if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) {
      throw new Error('.git is missing or not a directory');
    }
    // Wholesale reset: discard the entire consumed `.git` and rebuild it from
    // the family template. This is the only way to guarantee the next pooled
    // consumer is born clean - config, refs (loose and packed), tags,
    // reflogs, HEAD and any other `.git` metadata all come back pristine.
    fs.rmSync(gitDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    if (fs.existsSync(gitDir)) throw new Error('.git survived removal');
    restoreFiles(gitDir, fixtureFamily.gitFiles);

    const r1 = git(item.root, ['reset', '--hard', item.baseCommit]);
    const r2 = git(item.root, ['clean', '-ffdx']);
    const r3 = git(item.root, ['rev-parse', 'HEAD']);
    if (r1.status === 0 && r2.status === 0 && r3.status === 0 && r3.stdout.trim() === item.baseCommit) {
      fixturePool.push(item);
      return;
    }
  } catch {}
  try {
    fs.rmSync(item.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch {}
}

process.on('exit', () => {
  for (const item of fixturePool) {
    try {
      fs.rmSync(item.root, { recursive: true, force: true });
    } catch {}
  }
});

function makeFixture(t) {
  let item = getPooledFixture();
  if (!item) {
    const root = tt.mkTmp('colabs-test-');
    if (!fixtureFamily) {
      for (const args of [
        ['init', '-b', 'main'],
        ['-c', 'user.name=Protocol Test', '-c', 'user.email=protocol-test@example.invalid',
          'commit', '--allow-empty', '-m', 'Test fixture'],
      ]) {
        const result = git(root, args);
        if (result.status !== 0) throw new Error(result.stderr || String(result.error));
      }
      const rev = git(root, ['rev-parse', 'HEAD']);
      const baseCommit = rev.status === 0 ? rev.stdout.trim() : 'HEAD';
      if (baseCommit === 'HEAD') throw new Error('fixture template commit is missing');
      // The pristine `.git` of this first fixture becomes the family template:
      // every later fixture and every release rebuilds from these exact bytes,
      // so pooled consumers cannot inherit git state from each other.
      fixtureFamily = { baseCommit, gitFiles: snapshotFiles(path.join(root, '.git')) };
    } else {
      restoreFiles(path.join(root, '.git'), fixtureFamily.gitFiles);
    }
    item = { root, baseCommit: fixtureFamily.baseCommit };
  }

  t.after(() => {
    // Only this exact, freshly created temporary directory can be removed or reset.
    // the fixture lives in a test-tmp run root (docs/ops/lib/test-tmp.cjs) and carries its registration record
    const resolved = fs.realpathSync(item.root);
    if (!tt.isRegistered(item.root) || !path.basename(resolved).startsWith('colabs-test-')) {
      throw new Error('Refusing cleanup outside the test temporary directory');
    }
    releaseFixture(item);
  });
  return item.root;
}

// The protocol file set a fixture receives, read from the repository once per process.
// Derived from protocol-manifest.json, not from a list of its own. A fourth
// list that had to agree with the manifest is what broke the first CI run.
let protocolFiles = null;
function protocolFileSet() {
  if (protocolFiles) return protocolFiles;
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, 'protocol-manifest.json'), 'utf8'));
  // A fixture stands in for the protocol source repository, so it needs the
  // source-only tooling too. An installed project gets only `managed`.
  const entries = [...manifest.managed, ...manifest.source, ...manifest.tests,
    ...manifest.integration, '.editorconfig', '.codex/config.toml', 'templates'];
  const files = new Map();
  const collect = (sourceRelative, targetRelative) => {
    const source = path.join(repoRoot, sourceRelative);
    if (!fs.existsSync(source)) return;
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) throw new Error(`Fixture source is a link: ${sourceRelative}`);
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(source)) collect(path.join(sourceRelative, name), path.join(targetRelative, name));
      return;
    }
    // A later entry replaces an earlier one at the same target, as the copy order did.
    files.set(targetRelative, { bytes: fs.readFileSync(source), mode: stat.mode & 0o777 });
  };
  for (const relative of entries) collect(relative, relative);
  collect(path.join('templates', 'ai'), '.ai');
  protocolFiles = files;
  return files;
}

// Written, not copied: on Windows the first read of a file created by the copy API costs about
// 13 ms in on-access scanning, 1.2 s per fixture; written bytes cost 0.1 s (measured,
// in a review of the PowerShell refactor).
// No stubbing: every fixture receives the real protocol-validate.cjs and
// protocol-test.cjs, so fixture validation exercises the real tools.
function seedProtocol(root) {
  for (const [relative, { bytes, mode }] of protocolFileSet()) {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes, { mode });
  }
  return root;
}

function makeProtocolFixture(t) {
  return seedProtocol(makeFixture(t));
}

function findGitBash() {
  if (process.platform !== 'win32') return 'bash';
  const located = run('where.exe', ['git.exe']);
  const gitPaths = (located.stdout || '').trim().split(/\r?\n/);
  const candidates = gitPaths.flatMap(file => [
    path.resolve(path.dirname(file), '..', 'bin', 'bash.exe'),
    path.resolve(path.dirname(file), '..', 'usr', 'bin', 'bash.exe'),
  ]);
  candidates.push('C:\\Program Files\\Git\\bin\\bash.exe');
  return candidates.find(candidate => fs.existsSync(candidate)) || null;
}

function smallTreeOffences(dir, { maxBytes = 51200, maxRel = 120, fs: fsx = fs } = {}) {
  const out = [];
  const walk = d => {
    for (const e of fsx.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, e.name); const rel = path.relative(dir, abs).split(path.sep).join('/');
      if (rel.length > maxRel) out.push(`${rel.slice(0, 40)}...: path of ${rel.length} characters`);
      if (e.isDirectory()) walk(abs); else if (e.isFile()) { const n = fsx.statSync(abs).size; if (n > maxBytes) out.push(`${rel}: ${n} bytes`); }
    }
  };
  walk(dir);
  return out;
}
function assertSmallTree(dir, limits) {
  const offences = smallTreeOffences(dir, limits);
  if (offences.length) throw new Error(`fixture over the landing limits: ${offences.join('; ')}`);
}
function watchWrites(mod = fs, { maxBytes = 51200 } = {}) {
  const offences = [];
  const orig = { writeFileSync: mod.writeFileSync, appendFileSync: mod.appendFileSync, copyFileSync: mod.copyFileSync };
  const dataSize = d => (typeof d === 'string' ? Buffer.byteLength(d) : d && typeof d.byteLength === 'number' ? d.byteLength : 0);
  const after = p => {
    try {
      if (typeof p === 'number') return mod.fstatSync(p).size;
      if (typeof p === 'string' || p instanceof URL || Buffer.isBuffer(p)) return mod.statSync(p).size;
      return 0;
    } catch { return 0; }
  };
  const shown = p => (typeof p === 'number' ? `fd:${p}` : path.basename(String(p)));
  const note = (p, n) => { if (n > maxBytes) offences.push(`${shown(p)}: ${n} bytes`); };
  mod.writeFileSync = function (p, d, ...r) { const res = orig.writeFileSync.call(this, p, d, ...r); note(p, Math.max(dataSize(d), after(p))); return res; };
  mod.appendFileSync = function (p, d, ...r) { const res = orig.appendFileSync.call(this, p, d, ...r); note(p, Math.max(dataSize(d), after(p))); return res; };
  mod.copyFileSync = function (s, d, ...r) { const res = orig.copyFileSync.call(this, s, d, ...r); note(d, after(d)); return res; };
  return { offences: () => offences.slice(), stop: () => Object.assign(mod, orig) };
}

module.exports = {
  tt, smallTreeOffences, assertSmallTree, watchWrites,
  repoRoot, run, runChecked, git, runPowerShell, write, makeFixture,
  seedProtocol, makeProtocolFixture, findGitBash, launchWorkRoot, noRouteGate,
};

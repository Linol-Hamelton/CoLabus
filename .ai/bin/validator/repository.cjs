'use strict';

// Node validator engine, repository module.
// Implements CM-06..CM-14 one to one, per the contract map
// of the repository validator.
// The module emits diagnostics through the caller's report() callback and never
// prints, never mutates the working tree and keeps no global state
// of its own. The entry owns check order and rendering.
//
// Porting notes, kept next to the code they concern:
// - PowerShell string comparison operators (-eq, -contains, -in) are
//   case-insensitive; .NET String.StartsWith is case-sensitive. Both behaviors
//   are reproduced here where the .ps1 relies on them.
// - The .ps1 reads the manifest with Get-Content (encoding auto-detection);
//   this port reads UTF-8. Protocol manifests are ASCII, so the two agree on
//   every conforming tree (an assumption of this port).

const fs = require('node:fs');
const path = require('node:path');
const testCommandLib = require(path.join(__dirname, '..', 'lib', 'test-command.cjs'));
const { spawnSync } = require('node:child_process');

function caseInsensitiveEquals(a, b) {
  return a === b || (typeof a === 'string' && typeof b === 'string' &&
    a.toLowerCase() === b.toLowerCase());
}

function isFile(full) {
  try { return fs.statSync(full).isFile(); } catch { return false; }
}

function runGit(root, args) {
  const result = spawnSync('git', ['-C', root, ...args], {
    cwd: root, windowsHide: true, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) return { code: -1, output: '', error: String(result.error.message) };
  return {
    code: result.status,
    output: result.stdout ? result.stdout.toString('utf8') : '',
    error: result.stderr ? result.stderr.toString('utf8') : '',
  };
}

function gitAvailable() {
  const probe = spawnSync('git', ['--version'], { windowsHide: true, encoding: 'utf8' });
  return !probe.error;
}

// CM-06/CM-07: manifest read, role semantics and the required set. On a
// missing or malformed manifest the .ps1 keeps role 'source' and an empty
// required set and continues; this port does the same.
function loadManifest(root, report) {
  const manifestPath = path.join(root, 'protocol-manifest.json');
  let manifest = null;
  if (!isFile(manifestPath)) {
    report('CM-06', 'FAIL', 'missing file: protocol-manifest.json');
  } else {
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      report('CM-06', 'FAIL', `protocol-manifest.json is not valid JSON: ${error.message}`);
      manifest = null;
    }
  }
  const role = manifest && manifest.role !== undefined ? String(manifest.role) : 'source';
  const required = [];
  if (manifest) {
    required.push(...(manifest.managed || []));
    required.push(...(manifest.integration || []));
    for (const relative of (manifest.state || [])) required.push('.ai/' + relative);
    if (role === 'source') {
      required.push(...(manifest.source || []));
      required.push(...(manifest.tests || []));
      for (const relative of (manifest.state || [])) required.push('templates/ai/' + relative);
    }
  }
  // The owner names the owner-words journal (OW R-OW-1); the manifest key is
  // the only place that name lives. Returned as written; the rule-20 module judges the path.
  const ownerWordsJournal = manifest && manifest.ownerWordsJournal !== undefined
    ? manifest.ownerWordsJournal : null;
  let legacyBoundaryManifest = null;
  if (manifest && manifest.legacyBoundaryManifest !== undefined) {
    const relative = manifest.legacyBoundaryManifest;
    const boundaryPath = path.join(root, relative);
    if (isFile(boundaryPath)) {
      try {
        legacyBoundaryManifest = JSON.parse(fs.readFileSync(boundaryPath, 'utf8'));
      } catch (error) {
        report('CM-06', 'WARN', `legacy boundary manifest is not valid JSON: ${error.message}`);
      }
    } else {
      report('CM-06', 'WARN', `legacy boundary manifest not found: ${relative}`);
    }
  }
  return { role, required, legacyBoundaryManifest, ownerWordsJournal };
}

// CM-08: required-file presence, in manifest order.
function checkRequiredFiles(root, required, report) {
  for (const relative of required) {
    if (isFile(path.join(root, relative))) {
      report('CM-08', 'PASS', `present: ${relative}`, relative);
    } else {
      report('CM-08', 'FAIL', `missing file: ${relative}`, relative);
    }
  }
}

// CM-70 support: tracked-only enumeration for the encoding guard. The
// combined listing below cannot be split back into cached and untracked
// entries, and the guard contract is 'tracked files'. Returns null when Git
// cannot list them or the index output is malformed; CM-70 then reports an
// unavailable enumeration rather than passing silently.
function listTrackedFiles(root, options = {}) {
  // One index read supplies paths and modes, including unmerged stages. Keep
  // the path-only API for other consumers; CM-70 also requests the gitlink set.
  const listing = runGit(root, ['ls-files', '--cached', '--stage', '-z']);
  if (listing.code !== 0) return null;
  const files = new Set();
  const gitlinks = new Set();
  for (const entry of listing.output.split('\0').filter(Boolean)) {
    const match = /^([0-7]{6}) [0-9a-f]+ [0-3]\t([\s\S]+)$/.exec(entry);
    if (!match) return null;
    files.add(match[2]);
    if (match[1] === '160000') gitlinks.add(match[2]);
  }
  if (options.gitlinks) for (const relative of gitlinks) options.gitlinks.add(relative);
  return [...files];
}

// CM-09/CM-10/CM-11: git availability, worktree identity, tracked/untracked
// enumeration (NUL-delimited) and history presence. Appends enumerated paths
// to the caller's list, exactly as the .ps1 appends to $paths.
function checkGit(root, paths, report) {
  if (!gitAvailable()) {
    report('CM-09', 'FAIL', 'git is unavailable; install Git and add it to PATH');
    return { gitUsable: false };
  }
  const inside = runGit(root, ['rev-parse', '--is-inside-work-tree']);
  const top = runGit(root, ['rev-parse', '--show-toplevel']);
  if (inside.code !== 0 || inside.output.trim() !== 'true' || top.code !== 0) {
    report('CM-09', 'FAIL', 'not a valid Git working tree at the protocol root');
    return { gitUsable: false };
  }
  if (!caseInsensitiveEquals(path.resolve(top.output.trim()), path.resolve(root))) {
    report('CM-09', 'FAIL', 'protocol root is inside another repository; initialize or use its actual root');
    return { gitUsable: false };
  }
  report('CM-09', 'PASS', 'valid Git working tree');
  const listing = runGit(root, ['ls-files', '--cached', '--others', '--exclude-standard', '-z']);
  if (listing.code !== 0) {
    report('CM-10', 'FAIL', `cannot enumerate Git files: ${listing.error.trim()}`);
  } else {
    for (const relative of listing.output.split('\0')) {
      if (relative.length > 0) paths.push(relative);
    }
  }
  const history = runGit(root, ['rev-list', '--all', '--count']);
  const count = history.output.trim();
  if (history.code !== 0 || !/^\d+$/.test(count)) {
    report('CM-11', 'FAIL', `cannot read Git history: ${history.error.trim()}`);
  } else if (Number(count) === 0) {
    report('CM-11', 'WARN', 'no commits yet; Git history is empty');
  } else {
    report('CM-11', 'PASS', `commits on record: ${count}`);
  }
  return { gitUsable: true };
}

// CM-10: core state is checked even when ignored; never crawl ignored trees.
function appendWorklogFiles(root, paths) {
  const directory = path.join(root, '.ai', 'worklog');
  let entries;
  try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    let stat;
    try { stat = fs.statSync(path.join(directory, entry.name)); } catch { continue; }
    if (!stat.isFile() || !entry.name.endsWith('.md')) continue;
    paths.push('.ai/worklog/' + entry.name);
  }
}

// CM-12: protocol-owned filter. Mirrors Test-ProtocolOwned, including its
// case-sensitive prefix matching and case-insensitive set membership.
function isProtocolOwned(relative, required, role) {
  const normalized = relative.split('\\').join('/');
  if (caseInsensitiveEquals(normalized, '.codex/config.toml')) return false;
  if (required.some(item => caseInsensitiveEquals(item, relative))) return true;
  if (caseInsensitiveEquals(relative, '.github/workflows/protocol.yml')) return true;
  for (const prefix of ['.ai/', 'templates/ai/', 'templates/reviews/', '.claude/hooks/']) {
    if (normalized.startsWith(prefix)) return true;
  }
  if (role === 'source' &&
      (normalized.startsWith('docs/reviews/') || normalized.startsWith('docs/decisions/'))) {
    return true;
  }
  return false;
}

// CM-70 support: one decision for which tracked files are blocking-scanned.
// The source role keeps the certified widened scan (every tracked text file).
// The installed role blocks only on protocol-owned files: line endings,
// BOM and charset of a host file are the host's decision (AGENTS.md section
// 11; the protocol installs no .editorconfig). Callers never re-derive this.
function isBlockingEncodingScan(relative, required, role) {
  if (caseInsensitiveEquals(role, 'source')) return true;
  if (caseInsensitiveEquals(role, 'installed')) {
    return isProtocolOwned(relative, required, role);
  }
  // Unknown or absent role: the guard fails safe to the wider (stricter) set.
  return true;
}

const TEXT_EXTENSIONS = ['.md', '.txt', '.json', '.jsonc', '.sh', '.ps1', '.psm1', '.psd1',
  '.cjs', '.mjs', '.js', '.jsx', '.ts', '.tsx', '.yml', '.yaml', '.toml', '.ini', '.xml',
  '.html', '.css', '.scss', '.svg', '.py', '.rb', '.go', '.rs', '.sql', '.csv'];
const TEXT_NAMES = ['.editorconfig', '.gitattributes', '.gitignore', '.npmrc', '.nvmrc',
  'Dockerfile', 'Makefile'];

// Case-insensitive deduplication with code-unit sort. The original port of
// Sort-Object -Unique used a culture-aware comparer (porting provenance);
// diagnostic ordering is not a contract (CM-49).
function dedupeCaseInsensitive(paths) {
  const seen = new Map();
  for (const relative of paths) {
    const key = relative.toLowerCase();
    if (!seen.has(key)) seen.set(key, relative);
  }
  return [...seen.values()];
}

// CM-13/CM-14: text-file selection and symlink/reparse handling. Emits the
// symlink WARN lines in selection order and returns the files to inspect.
function collectOwnedTextFiles(root, paths, required, role, report) {
  const files = [];
  for (const relative of dedupeCaseInsensitive(paths).sort()) {
    const full = path.join(root, relative);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (!stat.isFile()) continue;
    let reparse = false;
    try { reparse = fs.lstatSync(full).isSymbolicLink(); } catch { reparse = false; }
    if (reparse) {
      report('CM-14', 'WARN', `symlink content not inspected: ${relative}`, relative);
      continue;
    }
    if (!isProtocolOwned(relative, required, role)) continue;
    const name = path.basename(relative);
    const extension = path.extname(relative);
    const extensionMatch = TEXT_EXTENSIONS.some(item => caseInsensitiveEquals(item, extension));
    const nameMatch = TEXT_NAMES.some(item => caseInsensitiveEquals(item, name));
    if (!extensionMatch && !nameMatch) continue;
    files.push({ relative, full });
  }
  return files;
}

// CM-72: in an installed host, a worktree whose HEAD is proven landed in the
// local integration branch (ancestor, or an exact Landed-Tip squash trailer)
// belongs to a closed task and should be retired. WARN only, never FAIL: the
// check is advisory, and any error of its own skips it with one WARN line.
function checkClosedTaskWorktrees(root, role, gitUsable, report) {
  if (role !== 'installed' || !gitUsable) return;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'protocol-manifest.json'), 'utf8')); } catch { return; }
  const branch = manifest && manifest.integrationBranch;
  if (typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch)) return;
  const proofModule = path.join(__dirname, '..', 'operator', 'landed-proof.cjs');
  if (!isFile(proofModule)) return;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' };
  for (const k of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|CONFIG)/.test(k)) delete env[k];
  const raw = (repo, args) => spawnSync('git', ['-c', 'core.hooksPath=disabled', ...args], {
    cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, env,
  });
  try {
    const tip = raw(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`]);
    if (tip.status !== 0 || !/^[0-9a-f]{40}\s*$/.test(tip.stdout || '')) return;
    const list = raw(root, ['worktree', 'list', '--porcelain', '-z']);
    if (list.status !== 0) throw new Error('worktree list');
    const rows = []; let row;
    for (const field of list.stdout.split('\0')) {
      if (field.startsWith('worktree ')) { row = { path: field.slice(9) }; rows.push(row); }
      else if (row && field.startsWith('HEAD ')) row.head = field.slice(5);
      else if (row && field.startsWith('branch ')) row.branch = field.slice(7).replace(/^refs\/heads\//, '');
      else if (row && (field.startsWith('prunable') || field === 'bare')) row.skip = true;
    }
    const protectedNames = new Set([branch, 'main', 'master',
      ...(Array.isArray(manifest.protectedBranches) ? manifest.protectedBranches : [])].map(b => String(b).toLowerCase()));
    const { createLandedProof } = require(proofModule);
    const prove = createLandedProof({ repo: root, line: tip.stdout.trim(), raw, host: true });
    for (const wt of rows.slice(1)) {
      if (wt.skip || !wt.head || (wt.branch && protectedNames.has(wt.branch.toLowerCase())) || !fs.existsSync(wt.path)) continue;
      const p = prove(wt);
      if (p.ok) report('CM-72', 'WARN', `CM-72 closed task worktree still present: ${wt.path.replace(/\\/g, '/')} (${wt.branch || 'detached'}, ${p.landedBy}); list it with node .ai/bin/operator/auto-retire.cjs --root .`);
    }
  } catch {
    report('CM-72', 'WARN', 'CM-72 closed task worktree check skipped: git or the landed proof failed');
  }
}

// CM-73: in an installed host, the operator layer schedules (state tick and
// silence alert, .ai/bin/operator/schedule.cjs) are registered unless the host
// opted out (operatorLayer.schedules.enabled false), and the last tick is not
// older than twice its interval plus five minutes. WARN only, never FAIL. It
// reads the install receipt and the last tick record; it never queries the OS
// scheduler (schedule.cjs check does). A host without the layer is quiet.
function checkOperatorSchedules(root, role, report, now = Date.now()) {
  if (role !== 'installed') return;
  const layerModule = path.join(__dirname, '..', 'operator', 'layer.cjs');
  if (!isFile(layerModule)) return;
  let settings;
  try { settings = require(layerModule).loadSettings(root); } catch (e) {
    report('CM-73', 'WARN', `CM-73 operatorLayer settings in protocol-manifest.json are invalid (${String((e && e.message) || e).slice(0, 160)}); the tick and the silence alert cannot run`);
    return;
  }
  if (!settings.schedules.enabled) return;
  const runtime = path.join(root, settings.runtime);
  const read = name => { try { return JSON.parse(fs.readFileSync(path.join(runtime, name), 'utf8')); } catch { return null; } };
  const receipt = read('operator-schedules.json');
  const fix = 'run node .ai/bin/operator/schedule.cjs install --root . (or opt out with operatorLayer.schedules.enabled false)';
  if (!receipt || receipt.optOut === true || !Array.isArray(receipt.tasks) || receipt.removedAt) {
    report('CM-73', 'WARN', `CM-73 operator schedules are not registered (tick every ${settings.schedules.tickMinutes} min, silence alert every ${settings.schedules.silenceMinutes} min); ${fix}`);
    return;
  }
  const notReal = receipt.tasks.filter(t => !t || t.status !== 'registered');
  if (notReal.length || !receipt.tasks.length) {
    report('CM-73', 'WARN', `CM-73 operator schedules not registered with the system scheduler (backend ${receipt.backend || 'unknown'}: ${notReal.map(t => `${t && t.id}=${t && t.status}`).join(', ') || 'no tasks'}); ${fix}`);
    return;
  }
  const limitMs = (2 * settings.schedules.tickMinutes + 5) * 60000;
  const last = read('operator-tick-last.json');
  const lastAt = last && Date.parse(last.at);
  const since = Number.isFinite(lastAt) ? lastAt : Date.parse(receipt.at);
  if (Number.isFinite(since) && now - since > limitMs) {
    report('CM-73', 'WARN', `CM-73 the last operator tick is ${Math.round((now - since) / 60000)} min old (threshold ${Math.round(limitMs / 60000)} min${Number.isFinite(lastAt) ? '' : ', none since the schedules were registered'}); check the task with node .ai/bin/operator/schedule.cjs check --root .`);
  }
}


// CM-75: in an installed host, when the manifest has no testCommand and no
// recorded none, and detection finds a candidate, print one WARN naming the
// candidate and the exact command to set it. Never FAIL. Silent in source.
function checkHostTestCommand(root, role, report) {
  if (role !== 'installed') return;
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, 'protocol-manifest.json'), 'utf8')); }
  catch { return; }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) return;
  if (testCommandLib.hasRunnableCommand(manifest) || testCommandLib.hasRecordedNone(manifest)) return;
  let candidates = [];
  try { candidates = testCommandLib.detectTestCommand(root); } catch { return; }
  if (!candidates.length) return;
  report('CM-75', 'WARN', testCommandLib.warnMessage(candidates));
}

module.exports = {
  runGit,
  checkClosedTaskWorktrees,
  checkOperatorSchedules,
  checkHostTestCommand,
  loadManifest,
  checkRequiredFiles,
  checkGit,
  listTrackedFiles,
  appendWorklogFiles,
  isProtocolOwned,
  isBlockingEncodingScan,
  collectOwnedTextFiles,
  TEXT_EXTENSIONS,
};

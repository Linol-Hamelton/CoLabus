'use strict';

// P3 Node validator engine, repository module (OT-05 section В5 step 1).
// Implements CM-06..CM-14 one to one, per the contract map
// of the repository validator.
// The module emits diagnostics through the caller's report() callback and never
// prints, never mutates the working tree and keeps no global state
// (final-plan-2 section J). The entry owns check order and rendering.
//
// Porting notes, kept next to the code they concern:
// - PowerShell string comparison operators (-eq, -contains, -in) are
//   case-insensitive; .NET String.StartsWith is case-sensitive. Both behaviors
//   are reproduced here where the .ps1 relies on them.
// - The .ps1 reads the manifest with Get-Content (encoding auto-detection);
//   this port reads UTF-8. Protocol manifests are ASCII, so the two agree on
//   every conforming tree (assumption, recorded in SESSION1.md).

const fs = require('node:fs');
const path = require('node:path');
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
  // PKG-E (L5 W1): the owner names the owner-words journal (OW R-OW-1); the manifest key is
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
// cannot list them; the guard then skips (CM-10 already reports enumeration
// failures).
function listTrackedFiles(root) {
  const listing = runGit(root, ['ls-files', '--cached', '-z']);
  if (listing.code !== 0) return null;
  return listing.output.split('\0').filter(relative => relative.length > 0);
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

module.exports = {
  runGit,
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

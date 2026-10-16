'use strict';

// Coverage ledger and duplicate detection for work done over a corpus.
//
// Two failures in this fleet motivated it, both measured rather than imagined.
//
// 1. Omission. A chain of seven analysis rounds took its scope from a prompt that
//    named its sources, and nobody checked the list against the repository. The
//    primary source had been tracked since the initial commit and was never opened.
//    `cover` answers the question that was never asked: does this set of records
//    account for every unit of the declared corpus, one row each, arithmetic closed.
//
// 2. Copying. Three agents mapped one repository; one submission turned out to be a
//    byte-identical copy of another's, with matching timestamps, and nothing in the
//    protocol noticed. `dup` compares record sets by content hash and reports what
//    is shared.
//
// Output is derived, lives under .ai/runtime/, and is advisory: never Evidence and
// never a gate input (PROTO-DEC-0034 item 1). It reports; it does not decide.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const RUNTIME = path.join('.ai', 'runtime');
const DEFAULT_EXCLUDES = ['.git', 'node_modules', '.ai/runtime'];
const candidate = require('./protocol-handoff/candidate.cjs');
const { readFileGuarded } = require('./lib/path-safe.cjs');
const { decode, parseJsonUnique, ownLines } = require('./lib/text-safe.cjs');
const { secretIn } = require('./lib/secrets.cjs');

// Parsing never runs code. Execution below requires an authenticated receipt
// of this exact candidate and an explicit locator file supplied by the caller.
function parseReproduction(text, verdict) {
  if (!['PASS', 'FAIL', 'BLOCKED', 'RECOMMENDATION'].includes(verdict) || typeof text !== 'string') throw new Error('repro verdict/text refused');
  const d = decode(Buffer.from(text), { invisible: 'refuse' });
  if (!d.ok || /[\r\n]/.test(text) || secretIn(text)) throw new Error('repro text refused');
  if (text === 'none') {
    if (verdict !== 'RECOMMENDATION') throw new Error('none cannot substantiate this verdict');
    return { kind: 'none' };
  }
  if (text.startsWith('external:')) {
    const external = /^external:([A-Za-z0-9][A-Za-z0-9._:/?=&%#@+-]{1,511}); sha256:([a-f0-9]{64}); sanction:((?:PROTO-DEC|DEC)-[0-9]{4})$/.exec(text);
    if (!external) throw new Error('external repro grammar refused');
    return { kind: 'external', location: external[1], sha256: external[2], sanction: external[3], locator: text };
  }
  const m = /^repo:([\p{L}\p{N}_./-]+); interp:(node|pwsh|bash); argv:(\[[^\r\n]*\]); exit:(0|-?[1-9][0-9]*); sha256:([a-f0-9]{64})$/u.exec(text);
  if (!m || m[1].length > 120 || m[1].startsWith('/') || m[1].split('/').some(s => !s || s === '.' || s === '..')) throw new Error('repro grammar/path refused');
  const argv = parseJsonUnique(m[3]);
  if (!Array.isArray(argv) || argv.length > 64 || argv.some(a => typeof a !== 'string' || a.length > 4096 || /[\u0000-\u001f\u007f]/.test(a)) || !Number.isSafeInteger(Number(m[4]))) {
    throw new Error('repro argv/exit refused');
  }
  if ((m[2] === 'node' && !/\.(cjs|mjs|js)$/.test(m[1])) || (m[2] === 'pwsh' && !/\.ps1$/.test(m[1])) ||
      (m[2] === 'bash' && !/\.sh$/.test(m[1]))) throw new Error('repro interpreter/path mismatch');
  return { kind: 'repo', path: m[1], interp: m[2], argv, exit: Number(m[4]), sha256: m[5] };
}

// An approved sanction must name this exact borrowing and its executable local
// copy. Both statements belong to the immutable decision block, never to a
// caller-supplied file or an external response. No URL is fetched.
function sanctionedReproduction(root, state, external, verdict) {
  const decisions = state.rows.find(r => r.name === '.ai/DECISIONS.md' && r.type === 'blob' && ['100644', '100755'].includes(r.mode));
  if (!decisions) throw new Error('external repro decision source missing');
  const decoded = decode(candidate.git(root, ['cat-file', 'blob', decisions.oid], true), { invisible: 'refuse' });
  if (!decoded.ok) throw new Error('external repro decision encoding refused');
  const lines = ownLines(decoded.text).map(l => l.text);
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    const heading = /^### ((?:PROTO-DEC|DEC)-[0-9]{4})$/.exec(lines[i]);
    if (!heading) continue;
    let end = i + 1; while (end < lines.length && !/^### /.test(lines[end])) end++;
    blocks.push({ id: heading[1], lines: lines.slice(i + 1, end) });
  }
  const matches = blocks.filter(b => b.id === external.sanction);
  if (matches.length !== 1) throw new Error('external repro sanction missing or ambiguous');
  const one = name => {
    const found = matches[0].lines.filter(l => l.startsWith(name + ': '));
    if (found.length !== 1) throw new Error('external repro sanction field missing or duplicated');
    return found[0].slice(name.length + 2);
  };
  if (one('Status') !== 'Accepted' || !one('Approved by').trim()) throw new Error('external repro sanction is not approved');
  if (blocks.some(b => b.id !== external.sanction && b.lines.some(l => l.startsWith('Supersedes: ') &&
    l.slice(12).split(/[,; ]+/).includes(external.sanction)))) throw new Error('external repro sanction superseded');
  if (one('External-Reproduction') !== external.locator) throw new Error('external repro sanction names a different borrowing');
  const local = parseReproduction(one('Reproduction'), verdict);
  if (local.kind !== 'repo' || local.sha256 !== external.sha256) throw new Error('external repro local copy must match the sanctioned hash');
  return local;
}

function verifyReproduction(root, options) {
  candidate.guardedText(root, options.journal);
  const receipt = require('./protocol-handoff/chain.cjs').checkOwnerReceipt(root, null, { journal: options.journal });
  if (!receipt.ok) throw new Error('repro candidate Evidence rejected');
  const state = candidate.receiptState(root, receipt.evidence);
  if (!state || state.commit !== options.candidate) throw new Error('repro candidate receipt mismatch');
  const located = readFileGuarded(root, options.locatorFile);
  if (!located.ok) throw new Error('repro locator path refused');
  const decoded = decode(located.bytes, { invisible: 'refuse', finalNewline: 'refuse' });
  if (!decoded.ok) throw new Error('repro locator encoding refused');
  let locator = parseReproduction(decoded.text.replace(/\n$/, ''), options.verdict);
  const external = locator.kind === 'external' ? locator : null;
  if (external) locator = sanctionedReproduction(root, state, external, options.verdict);
  if (locator.kind === 'none') return { kind: 'none', executed: false, candidate: state.commit, candidateDigest: state.digest };
  const row = state.rows.find(r => r.name === locator.path);
  if (!row || row.type !== 'blob' || !['100644', '100755'].includes(row.mode)) throw new Error('repro script is not a tracked regular candidate file');
  const bytes = candidate.git(root, ['cat-file', 'blob', row.oid], true);
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== locator.sha256) throw new Error('repro script hash mismatch');
  return candidate.isolated(root, state, checkout => {
    const script = readFileGuarded(checkout, locator.path);
    if (!script.ok || crypto.createHash('sha256').update(script.bytes).digest('hex') !== locator.sha256) throw new Error('repro checkout script hash mismatch');
    const env = {};
    // No credentials, NODE_OPTIONS, shell startup files or provider environment.
    for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'COMSPEC', 'PATHEXT', 'TEMP', 'TMP']) if (process.env[name]) env[name] = process.env[name];
    env.PROTOCOL_NO_FULL_SUITE = '1';
    const command = locator.interp === 'node' ? process.execPath : locator.interp;
    const args = locator.interp === 'pwsh' ? ['-NoProfile', '-NonInteractive', '-File', script.real, ...locator.argv]
      : locator.interp === 'bash' ? ['--noprofile', '--norc', '--', script.real, ...locator.argv] : [script.real, ...locator.argv];
    const r = spawnSync(command, args, { cwd: checkout, env, shell: false, windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024 });
    if (r.error || !Number.isInteger(r.status) || r.signal) throw new Error('repro execution unavailable or timed out');
    if (r.status !== locator.exit) throw new Error('repro exit mismatch');
    return { kind: external ? 'external' : 'repo', ...(external ? { sanction: external.sanction } : {}), executed: true, candidate: state.commit, candidateDigest: state.digest,
      scriptSha256: locator.sha256, exit: r.status, expectedExit: locator.exit,
      outputSha256: crypto.createHash('sha256').update(r.stdout || Buffer.alloc(0)).update(r.stderr || Buffer.alloc(0)).digest('hex') };
  });
}

function runRepro(argv, root) {
  try {
    const opts = {};
    const names = { '--root': 'root', '--candidate': 'candidate', '--journal': 'journal', '--locator-file': 'locatorFile', '--verdict': 'verdict' };
    for (let i = 1; i < argv.length; i += 2) {
      if (!names[argv[i]] || typeof argv[i + 1] !== 'string' || argv[i + 1].startsWith('--') || Object.hasOwn(opts, names[argv[i]])) throw new Error('repro options refused');
      opts[names[argv[i]]] = argv[i + 1];
    }
    if (!['candidate', 'journal', 'locatorFile', 'verdict'].every(k => typeof opts[k] === 'string')) throw new Error('repro requires candidate, journal, locator-file and verdict');
    const result = verifyReproduction(root, opts);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (e) { process.stderr.write(`repro: ${e.message}\n`); return 2; }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

// An exclusion may be written as `logs` or as `logs/`; both mean the same thing, and
// the author's own dispatch used the trailing-slash form for what turned out to be a
// file. Normalising here also stops `logs` from matching `logs-old`.
function isExcluded(relative, excludes) {
  const normalized = relative.replace(/\\/g, '/');
  return excludes.some(raw => {
    let item = raw.replace(/\\/g, '/');
    while (item.endsWith('/')) item = item.slice(0, -1);
    if (!item) return false;
    return normalized === item || normalized.startsWith(`${item}/`);
  });
}

// A corpus is whatever the repository actually holds, never what a prompt named.
// Git is authoritative when present; a plain walk covers corpora that are not
// repositories, which is the case we hit and would otherwise have no inventory.
function corpus(root, excludes) {
  // -z for the same reason as the session-start inventory: without it git C-quotes
  // every non-ASCII path, and the quoted string is then counted as a unit while the
  // real file is reported missing. NUL separation also settles newlines in a name.
  const git = spawnSync('git', ['-C', root, 'ls-files', '-z'], { encoding: 'utf8' });
  if (git.status === 0 && git.stdout.trim()) {
    return {
      source: 'git ls-files -z',
      units: git.stdout.split('\0').map(line => line.trim()).filter(Boolean)
        .filter(unit => !isExcluded(unit, excludes)).sort(),
      skipped: [],
    };
  }
  const units = [];
  // Anything that is neither a plain file nor a plain directory - a symlink, a
  // Windows junction, a socket - is not followed, because following one can loop.
  // It is named rather than dropped: a silently skipped entry is the failure this
  // tool exists to catch, and the reader has to know the corpus is not complete.
  const skipped = [];
  const walk = directory => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      const relative = path.relative(root, full).replace(/\\/g, '/');
      if (isExcluded(relative, excludes)) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) units.push(relative);
      else skipped.push(relative);
    }
  };
  walk(root);
  return {
    source: 'directory walk (not a git repository)',
    units: units.sort(),
    skipped: skipped.sort(),
  };
}

function listFiles(directory) {
  const out = [];
  const walk = current => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) out.push(full);
    }
  };
  if (fs.existsSync(directory)) walk(directory);
  return out.sort();
}

// Records follow the convention the corpus work already used: one record per unit,
// mirroring the unit path with a suffix.
function cover(root, recordsDir, excludes, suffix) {
  const found = corpus(root, excludes);
  const rows = found.units.map(unit => {
    const record = path.join(recordsDir, `${unit}${suffix}`);
    const exists = fs.existsSync(record) && fs.statSync(record).isFile();
    const sourcePath = path.join(root, unit);
    const sourceExists = fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile();
    return {
      unit,
      sourceHash: sourceExists ? sha256File(sourcePath) : null,
      sourceBytes: sourceExists ? fs.statSync(sourcePath).size : null,
      record: exists ? path.relative(root, record).replace(/\\/g, '/') : null,
      recordHash: exists ? sha256File(record) : null,
      disposition: exists ? 'record' : 'no record',
    };
  });
  const expected = new Set(found.units.map(unit => path.join(recordsDir, `${unit}${suffix}`)));
  const extra = listFiles(recordsDir).filter(file => !expected.has(file))
    .map(file => path.relative(root, file).replace(/\\/g, '/'));
  return { found, rows, extra };
}

// Two records with the same content are either a template applied twice or one
// producer's work appearing under another's name. Both are worth naming.
function duplicates(dirs) {
  const byHash = new Map();
  for (const dir of dirs) {
    for (const file of listFiles(dir)) {
      const hash = sha256File(file);
      if (!byHash.has(hash)) byHash.set(hash, []);
      byHash.get(hash).push({ dir, file, mtime: fs.statSync(file).mtimeMs });
    }
  }
  const across = [];
  const within = [];
  for (const [hash, entries] of byHash) {
    if (entries.length < 2) continue;
    const distinctDirs = new Set(entries.map(entry => entry.dir));
    const sameMtime = new Set(entries.map(entry => entry.mtime)).size === 1;
    const record = { hash, count: entries.length, sameMtime, files: entries.map(e => e.file) };
    if (distinctDirs.size > 1) across.push(record);
    else within.push(record);
  }
  return { across, within };
}

function renderCover(result, recordsDir) {
  const covered = result.rows.filter(row => row.disposition === 'record').length;
  const missing = result.rows.filter(row => row.disposition === 'no record');
  const out = ['# Coverage ledger (derived, advisory)', ''];
  out.push(`- corpus source: ${result.found.source}`);
  out.push(`- records: ${recordsDir.replace(/\\/g, '/')}`);
  out.push(`- generated: ${new Date().toISOString()}`);
  out.push('');
  const skipped = result.found.skipped || [];
  out.push(`units ${result.rows.length}, with record ${covered}, without ${missing.length}, `
    + `unexpected records ${result.extra.length}, not followed ${skipped.length}`);
  out.push(`counts: ${covered} + ${missing.length} = ${result.rows.length}`);
  out.push('');
  out.push('Advisory only: never Evidence, never a gate input. It reports which units of');
  out.push('the corpus have a record. A unit without one is a question, not a verdict: it');
  out.push('may be a deliberate classification such as a generated artifact. A record with');
  out.push('no unit behind it is always wrong. Pass --expect-all when the contract is that');
  out.push('every unit must carry a record.');
  out.push('');
  if (missing.length) {
    out.push('## Units without a record - check each against its declared disposition');
    out.push('');
    for (const row of missing) out.push(`- ${row.unit}`);
    out.push('');
  }
  if (result.extra.length) {
    out.push('## Unexpected - a record with no unit in the corpus');
    out.push('');
    for (const item of result.extra) out.push(`- ${item}`);
    out.push('');
  }
  if (skipped.length) {
    out.push('## Not followed - symlink, junction or other non-regular entry');
    out.push('');
    out.push('The corpus below does not cover these. Resolve them by hand or exclude them');
    out.push('deliberately; leaving them unexamined is the omission this tool reports on.');
    out.push('');
    for (const item of skipped) out.push(`- ${item}`);
    out.push('');
  }
  out.push('## Units');
  out.push('');
  out.push('| unit | bytes | source sha256 | disposition | record sha256 |');
  out.push('| --- | ---: | --- | --- | --- |');
  for (const row of result.rows) {
    out.push(`| ${row.unit} | ${row.sourceBytes === null ? '-' : row.sourceBytes} | `
      + `${row.sourceHash ? row.sourceHash.slice(0, 16) : '-'} | ${row.disposition} | `
      + `${row.recordHash ? row.recordHash.slice(0, 16) : '-'} |`);
  }
  out.push('');
  return out.join('\n');
}

function renderDup(result, dirs) {
  const out = ['# Duplicate report (derived, advisory)', ''];
  out.push(`- compared: ${dirs.map(d => d.replace(/\\/g, '/')).join(', ')}`);
  out.push(`- generated: ${new Date().toISOString()}`);
  out.push('');
  out.push(`identical across sets: ${result.across.length}; identical within one set: `
    + `${result.within.length}`);
  out.push('');
  out.push('A record shared across two producers is not independent work. Identical');
  out.push('modification times alongside identical content indicate a filesystem copy');
  out.push('rather than two runs. This report states what was measured; it assigns no');
  out.push('intent and decides nothing.');
  out.push('');
  for (const [title, group] of [['Across sets', result.across], ['Within one set', result.within]]) {
    if (!group.length) continue;
    out.push(`## ${title}`);
    out.push('');
    for (const item of group) {
      out.push(`- ${item.hash.slice(0, 16)} x${item.count}`
        + `${item.sameMtime ? ' (identical mtime)' : ''}`);
      for (const file of item.files) out.push(`  - ${file.replace(/\\/g, '/')}`);
    }
    out.push('');
  }
  return out.join('\n');
}

function option(argv, name, fallback) {
  const at = argv.indexOf(name);
  return at !== -1 && argv[at + 1] ? argv[at + 1] : fallback;
}

function usage() {
  process.stdout.write(
    'usage:\n'
    + '  protocol-ledger.cjs cover --records <dir> [--root <dir>] [--suffix .md]\n'
    + '                            [--exclude a,b] [--out <file>]\n'
    + '  protocol-ledger.cjs dup <dir> <dir> [<dir>...] [--out <file>]\n');
  process.stdout.write('  protocol-ledger.cjs repro --candidate <full-sha> --journal <repo-path> --locator-file <repo-path> --verdict <token> [--root <dir>]\n');
}

// A directory that is not there must not read as a directory that is empty. An empty
// result from a missing path is a false all-clear, which is worse than no answer.
function requireDir(target, label) {
  if (fs.existsSync(target) && fs.statSync(target).isDirectory()) return true;
  process.stdout.write(`${label} is not an existing directory: ${target}\n`);
  return false;
}

function runCover(argv, root) {
  const recordsDir = option(argv, '--records', null);
  if (!recordsDir) { usage(); return 2; }
  if (!requireDir(root, 'corpus root')) return 2;
  if (!requireDir(path.resolve(recordsDir), 'records directory')) return 2;
  const excludes = option(argv, '--exclude', '').split(',').map(s => s.trim()).filter(Boolean)
    .concat(DEFAULT_EXCLUDES);
  const suffix = option(argv, '--suffix', '.md');
  const result = cover(root, path.resolve(recordsDir), excludes, suffix);
  const out = option(argv, '--out', path.join(root, RUNTIME, 'coverage-ledger.md'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${renderCover(result, recordsDir)}
`, 'utf8');
  const missing = result.rows.filter(row => row.disposition === 'no record').length;
  const expectAll = argv.includes('--expect-all');
  process.stdout.write(`${path.relative(root, out).replace(/\\/g, '/') || out}: `
    + `units ${result.rows.length}, without record ${missing}, `
    + `unexpected ${result.extra.length}
`);
  // A record with no unit behind it is always a defect. A unit with no record is
  // only a defect when the caller declared that every unit must carry one.
  return result.extra.length || (expectAll && missing) ? 1 : 0;
}

function runDup(argv, root) {
  // Positional directories only: an option consumes the argument after it, so a
  // path passed as `--out <file>` must never be mistaken for a set to compare.
  const dirs = [];
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) { i += 1; continue; }
    dirs.push(path.resolve(argv[i]));
  }
  if (dirs.length < 2) { usage(); return 2; }
  // Comparing against a path that does not exist would report "no duplicates" and
  // exit 0 - a clean bill of health for a comparison that never happened.
  for (const dir of dirs) {
    if (!requireDir(dir, 'comparison set')) return 2;
  }
  const unique = new Set(dirs.map(d => path.resolve(d)));
  if (unique.size !== dirs.length) {
    process.stdout.write('the same directory was given twice; every file would match itself\n');
    return 2;
  }
  const result = duplicates(dirs);
  const out = option(argv, '--out', path.join(root, RUNTIME, 'duplicate-report.md'));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, `${renderDup(result, dirs)}
`, 'utf8');
  process.stdout.write(`${path.relative(root, out).replace(/\\/g, '/') || out}: `
    + `across ${result.across.length}, within ${result.within.length}
`);
  return result.across.length ? 1 : 0;
}

function main(argv) {
  const root = path.resolve(option(argv, '--root', process.cwd()));
  if (argv[0] === 'repro') return runRepro(argv, root);
  if (argv[0] === 'cover') return runCover(argv, root);
  if (argv[0] === 'dup') return runDup(argv, root);
  usage();
  return 2;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));

module.exports = { corpus, cover, duplicates, renderCover, renderDup, main, parseReproduction, verifyReproduction, sanctionedReproduction };

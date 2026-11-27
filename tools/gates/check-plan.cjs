#!/usr/bin/env node
'use strict';
// check-plan.cjs - which risk class and which checks does a change need? (PROTO-DEC-0130 item 4,
// PROTO-DEC-0136 items 1, 2 and 4, PROTO-DEC-0169 item 1; cards am1:I-001 and am2:I-002; ported from
// b-scripts-rules f3355928 and adapted to the two-stage classification.)
//
//   PRE_CLASS   over the declared write-set of the launch file (--launch), before the run
//   POST_CLASS  over the actual change after the run: --baseline SHA --scope FILE uses
//               .ai/bin/protocol-scope.cjs checkScope (diff against the baseline plus untracked files);
//               --base SHA --candidate SHA uses git diff between two commits
//   EFFECTIVE   max(declared Class line, PRE_CLASS, POST_CLASS); a POST_CLASS above the declared and
//               PRE classes stops the landing path (exit 1): complete the Class A steps first
//
// Risk classes are POSITIVE: a path is Class B only when it lies in a Class B domain below and meets
// no entry of the Class A list; every other path is Class A ("doubt means Class A"). Class C is never
// derived from paths: a declared C is raised to B by any path. Semantic Class A (authority, security,
// owner approval meaning, ...) cannot be seen in a path: the declared Class line carries it and the
// tool never lowers it.
//
// PRE entries are resolved against the real repo root before classification:
// a junction that carries a Class A tree under a prose spelling must classify as Class A, and an
// entry whose real path leaves the root is exit 2, never a plan. The PRE class also comes from the
// physical layer: every existing file the entry can already write is enumerated
// (the real path of a glob's symlink match, a device-and-inode meet with the Class A trees for a
// hardlink), and an ESCAPE or an UNKNOWN of that layer is exit 2, never a plan. The declared Class
// line is read as a statement of the launch file (outside fenced code and comments, the shared mask
// through tools/gates/report-lines.cjs).
//
// Check classes (PROTO-DEC-0130 item 4) are also positive: a path gets the checks of the one domain
// that contains it; outside every domain it gets the strictest class, the full suite.
//
// Output lines, then exit 0 (plan), 1 (POST raised the class: stop before the merge), 2 (input
// error or an entry it cannot classify: never a plan). --out FILE writes the result as JSON to a new
// file (PROTO-DEC-0136 item 4: a separate generated result artifact; the launch file is never written).

const fs = require('node:fs');
const path = require('node:path');
const realPath = require('../../.ai/bin/lib/real-path.cjs');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const pathSafe = require('../../.ai/bin/lib/path-safe.cjs');
const { safeLine } = require('./diagnostic.cjs');
const { parseEntry, entriesOverlap } = require('./path-grammar.cjs');
const { parseLaunchText, readInputFile, liveLines, resolveEntry, enumerateEntry, physicalMeet, PHYS_WALK_MAX } = require('./write-set-check.cjs');

const RANK = { C: 0, B: 1, A: 2 };

// PROTO-DEC-0136 item 1 paths (absent ones stay listed), the history writers of PROTO-DEC-0169 item 1
// that would otherwise fall into a Class B domain, and the launch-control and gate tools that live in
// the research tools domain.
const CLASS_A = [
  'validate-protocol.ps1', 'test-protocol.ps1', 'setup-ai-protocol.ps1',
  '.ai/bin/', '.ai/core/', '.ai/hooks/', '.claude/', '.codex/', '.githooks/',
  'AGENTS.md', 'CLAUDE.md', 'protocol-manifest.json', '.gitattributes',
  '.ai/DECISIONS.md', '.ai/ARCHIVE.md', 'docs/decisions/REGISTRY.md', 'tests/', 'templates/',
  'tools/gates/',
];

// Domains: prefix segments, "tools" segment required after the prefix (research tools), allowed
// extensions (null = any), whether files may lie deeper than one level below the prefix.
const PROSE = ['.md', '.txt', '.csv', '.tsv', '.html', '.svg', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf'];
const DOMAINS = {
  researchTools: { prefix: ['docs', 'research'], needsTools: true, ext: null, deep: true },
  reviews: { prefix: ['docs', 'reviews'], ext: null, deep: true },
  docsProse: { prefix: ['docs'], ext: PROSE, deep: true },
  journals: { prefix: ['.ai', 'worklog'], ext: ['.md'], deep: false },
  taskFiles: { exact: ['.ai/TASK.md', '.ai/PLAN.md'] },
  core: { trees: ['.ai/bin/', '.ai/hooks/', '.claude/', '.codex/hooks/', 'tests/'], exact: ['validate-protocol.ps1', 'test-protocol.ps1'] },
};
const CLASS_B_DOMAINS = ['researchTools', 'reviews', 'docsProse', 'journals', 'taskFiles'];
const CHECKS = {
  docs: 'the validator (node .ai/bin/protocol-validate.cjs --root .)',
  'research-tool': "the tool's own tests or selftest, then the validator",
  core: 'targeted tests of the affected modules; the full suite only at freeze, before a merge and in a certification',
  strictest: 'the full suite (a path outside every listed class)',
};
// Check domains in precedence order; journals and TASK/PLAN are protocol documents checked by the
// validator (interpretation recorded in the README: the decision text names docs/** only).
const CHECK_DOMAINS = [['researchTools', 'research-tool'], ['reviews', 'docs'], ['docsProse', 'docs'], ['journals', 'docs'], ['taskFiles', 'docs'], ['core', 'core']];

const A_ENTRIES = CLASS_A.map(raw => parseEntry(raw));

function fold(s) { return s.normalize('NFC').toUpperCase(); }
function extOf(name) { const i = name.lastIndexOf('.'); return i > 0 ? name.slice(i).toLowerCase() : ''; }
function startsWithSegs(segs, prefix) { return prefix.every((p, i) => segs[i] !== undefined && fold(segs[i]) === fold(p)); }

// Does the domain contain every path the entry can name? Exact entries are single paths; a glob
// names files of one directory; a tree names everything under it.
function domainContains(domain, e) {
  const segs = e.segments;
  const last = segs[segs.length - 1];
  if (domain.exact || domain.trees) {
    if (domain.exact && e.kind === 'exact' && domain.exact.some(x => fold(x) === fold(segs.join('/')))) return true;
    if (domain.trees) {
      return domain.trees.some(t => {
        const ts = t.slice(0, -1).split('/');
        return segs.length >= ts.length && startsWithSegs(segs, ts);
      });
    }
    return false;
  }
  if (!startsWithSegs(segs, domain.prefix)) return false;
  const rest = segs.slice(domain.prefix.length);
  if (e.kind === 'tree') {
    if (domain.ext) return false;
    if (domain.needsTools) return rest.some(s => fold(s) === 'TOOLS');
    return true;
  }
  // exact or glob: rest must hold at least the file name
  if (rest.length === 0) return false;
  if (!domain.deep && rest.length !== 1) return false;
  if (domain.needsTools && !rest.slice(0, -1).some(s => fold(s) === 'TOOLS')) return false;
  if (domain.ext) {
    // a glob needs a literal extension after its last star
    if (last.includes('*')) {
      const tail = last.slice(last.lastIndexOf('*') + 1);
      if (!tail.includes('.')) return false;
      return domain.ext.includes(tail.slice(tail.lastIndexOf('.')).toLowerCase());
    }
    return domain.ext.includes(extOf(last));
  }
  return true;
}

function classifyEntry(e) {
  const hitA = A_ENTRIES.find(a => entriesOverlap(e, a));
  let risk;
  let reason;
  if (hitA) { risk = 'A'; reason = `meets ${hitA.text}`; }
  else {
    const b = CLASS_B_DOMAINS.find(d => domainContains(DOMAINS[d], e));
    if (b) { risk = 'B'; reason = `class B domain ${b}`; }
    else { risk = 'A'; reason = 'outside every class B domain (doubt means Class A)'; }
  }
  const cd = CHECK_DOMAINS.find(([d]) => domainContains(DOMAINS[d], e));
  return { risk, reason, check: cd ? cd[1] : 'strictest' };
}

// A concrete path from git is classified as an exact entry. Paths outside the entry grammar (spaces,
// for example) still get a class: their segments are compared literally, never guessed.
function classifyPath(p) {
  const e = parseEntry(p);
  if (e.ok) return classifyEntry(e.kind === 'exact' ? e : { ...e, kind: 'exact' });
  const segs = p.split('/');
  return classifyEntry({ ok: true, kind: 'exact', segments: segs, text: p, raw: p });
}

function maxClass(list) { return list.reduce((m, c) => (c && RANK[c] > RANK[m] ? c : m), 'C'); }

function checksFor(set) {
  const order = ['docs', 'research-tool', 'core', 'strictest'];
  const present = order.filter(c => set.has(c));
  // the full suite contains the targeted tests and the selftests; the validator is always kept
  const out = present.filter(c => !(set.has('strictest') && (c === 'core' || c === 'research-tool')));
  if (!out.includes('docs')) out.unshift('docs');
  return out;
}

// The declared Class line, read from the SAME decoded text as the write-set entries (one read:
// two reads of one launch file could disagree when a writer stood between
// them, and a declared class that does not belong to the entries that were classified is unknown,
// never a lucky pair.
function declaredClassText(text) {
  // A Class line is a statement of the launch file: fenced code and comments never declare a class,
  // and a Class line that a foreign span partly covers is ambiguous (a partly masked
  // line is never a statement), never a guessed value and never a silent default.
  const found = new Set();
  for (const { n, line, partial } of liveLines(text)) {
    const m = /^Class:\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    if (partial) return { error: `a Class line is partly masked (line ${n}): the declaration is ambiguous, never guessed` };
    if (!/^[ABC]$/.test(m[1])) return { error: `Class line "${m[1]}" is not exactly one of A, B, C` };
    found.add(m[1]);
  }
  if (found.size > 1) return { error: `Class lines disagree: ${[...found].join(', ')}` };
  return { value: found.size ? [...found][0] : null };
}

const REV = /^[0-9A-Za-z][0-9A-Za-z._/-]{0,199}$/;
function verifyRev(rev, cwd) {
  if (!REV.test(rev) || rev.includes('..')) throw new Error(`revision outside the allowed form: ${rev}`);
  execFileSync('git', ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { cwd, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
}

function diffBetween(base, candidate, cwd) {
  verifyRev(base, cwd); verifyRev(candidate, cwd);
  const out = execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', base, candidate, '--'], { cwd, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return out.toString('utf8').split('\0').filter(Boolean);
}

function plan(input) {
  const lines = [];
  const unparsed = [];
  const checkSet = new Set();
  let pre = null; let post = null;
  const result = { declared: input.declared || null, pre: null, post: null, effective: null, entries: [], paths: [], scope: null };
  if (input.launchRaws) {
    // F-01: the Class A trees are enumerated once, physically: a hardlink of a core file at a prose
    // spelling is one file with a Class A path, whatever realpath reports for the entry.
    let classAPhys = null;
    if (input.rootReal) {
      classAPhys = { targets: [], escapes: [], unknowns: [] };
      for (const a of A_ENTRIES) {
        const p = enumerateEntry(a, input.rootReal, PHYS_WALK_MAX);
        classAPhys.targets.push(...p.targets);
        classAPhys.escapes.push(...p.escapes);
        classAPhys.unknowns.push(...p.unknowns);
      }
      if (classAPhys.escapes.length || classAPhys.unknowns.length) {
        const bad = classAPhys.escapes.length ? `ESCAPE a Class A tree (${classAPhys.escapes[0]})` : `UNKNOWN a Class A tree (${classAPhys.unknowns[0]})`;
        return { exitCode: 2, lines: [...lines, bad, 'NO PLAN: the physical identity of the Class A paths is not whole; the PRE class cannot be taken'], result };
      }
    }
    const classes = [];
    for (const raw of input.launchRaws) {
      let e = parseEntry(raw);
      if (!e.ok) { unparsed.push(`UNPARSED ${raw} (${e.error})`); continue; }
      // F-04: the PRE class comes from the real path (a junction onto .ai/bin is Class A whatever
      // spelling the launch file used); an entry that leaves the repo root cannot be classified.
      if (input.rootReal) {
        const r = resolveEntry(e, input.rootReal);
        if (!r.ok) return { exitCode: 2, lines: [...lines, `${(r.reason || 'escape') === 'escape' ? 'ESCAPE' : 'UNKNOWN'} ${raw} (${r.error})`, 'NO PLAN: an entry whose real path cannot be established cannot be classified'], result };
        e = r.entry;
      }
      let c = classifyEntry(e);
      // F-01: the PRE class also comes from every existing file the entry can already write: the
      // real path of a glob's or tree's link match is a write of that file, and an entry whose
      // physical identity is unknown is never a plan.
      if (input.rootReal) {
        const phys = enumerateEntry(e, input.rootReal, PHYS_WALK_MAX);
        if (phys.escapes.length) return { exitCode: 2, lines: [...lines, `ESCAPE ${raw} (${phys.escapes[0]})`, 'NO PLAN: an entry whose real path leaves the root cannot be classified'], result };
        if (phys.unknowns.length) return { exitCode: 2, lines: [...lines, `UNKNOWN ${raw} (${phys.unknowns[0]})`, 'NO PLAN: an entry whose physical identity is unknown cannot be classified'], result };
        for (const t of phys.targets) {
          const pc = classifyPath(t.key);
          if (RANK[pc.risk] > RANK[c.risk]) c = { ...pc, reason: `${pc.reason} (the real path of an existing file the entry can write)` };
        }
        if (RANK[c.risk] < RANK.A && physicalMeet(phys, classAPhys)) {
          let why = 'one physical file with a Class A path';
          const hit = classAPhys.targets.find(ta => phys.targets.some(tb => (ta.dev === tb.dev && ta.ino === tb.ino) || tb.key === ta.key || tb.key.startsWith(ta.key + '/') || ta.key.startsWith(tb.key + '/')));
          if (hit) why = `one physical file with the Class A path ${hit.key} (a hardlink)`;
          c = { risk: 'A', check: hit ? classifyPath(hit.key).check : c.check, reason: `${c.reason}; ${why}` };
        }
      }
      classes.push(c.risk); checkSet.add(c.check);
      result.entries.push({ entry: raw, ...c });
      lines.push(`PRE-ENTRY ${c.risk} ${c.check} ${raw} (${c.reason})`);
    }
    pre = classes.length ? maxClass(classes) : null;
  }
  if (input.paths) {
    const classes = [];
    for (const p of input.paths) {
      const c = classifyPath(p);
      classes.push(c.risk); checkSet.add(c.check);
      result.paths.push({ path: p, ...c });
      lines.push(`POST-PATH ${c.risk} ${c.check} ${p} (${c.reason})`);
    }
    post = classes.length ? maxClass(classes) : null;
    if (!classes.length) lines.push('POST-PATH none (the change holds no path)');
  }
  if (input.scope) {
    result.scope = input.scope;
    for (const p of input.scope.offendingOutOfScope) lines.push(`SCOPE-ADVICE out of the declared scope: ${p}`);
    for (const f of input.scope.offendingForbidden) lines.push(`SCOPE-ADVICE forbidden path: ${f.path} (rule ${f.forbiddenMatch})`);
  }
  if (unparsed.length) return { exitCode: 2, lines: [...unparsed, 'NO PLAN: an entry outside the grammar cannot be classified'], result };
  if (!pre && !post) return { exitCode: 2, lines: [...lines, 'NO PLAN: nothing to classify (no entry and no changed path)'], result };
  result.pre = pre; result.post = post;
  const effective = maxClass([input.declared, pre, post]);
  result.effective = effective;
  result.checks = checksFor(checkSet).map(c => CHECKS[c]);
  lines.push(`DECLARED ${input.declared || 'none'}`);
  if (pre) lines.push(`PRE_CLASS ${pre}`);
  if (post) lines.push(`POST_CLASS ${post}`);
  lines.push(`EFFECTIVE_CLASS ${effective}`);
  if (input.declared === 'C' && effective !== 'C') lines.push('NOTE a declared Class C is raised: paths alone never prove deterministic accounting');
  lines.push(`CHECKS ${result.checks.join(' + ')}`);
  // A raise exists only against a launch: without PRE there is nothing the change could exceed.
  const before = maxClass([input.declared, pre]);
  if (input.launchRaws && post && RANK[post] > RANK[before]) {
    lines.push(`RAISED POST_CLASS ${post} is above ${before}: stop before the merge and complete the Class ${post} steps (PROTO-DEC-0136 item 4)`);
    return { exitCode: 1, lines, result };
  }
  return { exitCode: 0, lines, result };
}

// --out promises a NEW file, and the publish is an operation that
// cannot replace. The previous write ended in writeAtomicGuarded's rename, and rename replaces:
// a foreign file that appeared at the target between the last check and the rename was destroyed
// with exit 0; the library never promised rename-no-replace, so the promise is closed here at the
// call site. The bytes go to an exclusive temp file (O_CREAT|O_EXCL) in the target's real
// directory and are flushed; the real directory is re-checked; and the target NAME is created with
// a hard link, which is an atomic no-replace: EEXIST when any file (or link) is already there, so
// a foreign file at the target survives every interleaving. The temp handle stays open until the
// link is verified (on Windows it pins the directory chain, the same W3 property the library
// measures); then the temp name is dropped. On POSIX the gap between the re-check and the link is
// narrowed, not closed, but a no-replace link cannot lose foreign bytes in it. A filesystem
// without hard links (EPERM) refuses the write; the artifact is never published half.
function publishNewFile(realDir, target, bytes) {
  const tmpName = `.${path.basename(target)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const tmp = path.join(realDir, tmpName);
  let fd = null;
  let id = null;
  const close = () => { if (fd !== null) { const f = fd; fd = null; try { fs.closeSync(f); } catch { return 'the output handle could not be closed'; } } return null; };
  // Drop the temp name of THIS call only: the inode is checked immediately before the unlink.
  const dropTemp = () => {
    try {
      const st = fs.lstatSync(tmp, { bigint: true });
      if (!id || st.ino !== id.ino || st.dev !== id.dev) return false;
      fs.unlinkSync(tmp);
      return true;
    } catch { return false; }
  };
  try {
    fd = fs.openSync(tmp, 'wx', 0o666);
    const st = fs.fstatSync(fd, { bigint: true });
    id = { dev: st.dev, ino: st.ino };
    let off = 0;
    while (off < bytes.length) off += fs.writeSync(fd, bytes, off, bytes.length - off);
    fs.fsyncSync(fd);
    if (realPath.realPathSync(realDir) !== realDir) throw new Error('the output directory changed during the write; nothing was published');
    try { fs.linkSync(tmp, target); }
    catch (e) {
      if (e && e.code === 'EEXIST') throw new Error('a file appeared at the target during the write; the foreign file was not touched');
      throw e;
    }
    const after = fs.lstatSync(target, { bigint: true });
    if (!id || after.ino !== id.ino || after.dev !== id.dev) throw new Error('the target is not the file this call wrote; nothing foreign was replaced');
    const closeError = close();
    if (!dropTemp()) throw new Error(`the temp name could not be dropped (left: ${tmpName}); the artifact is at the target`);
    if (closeError) throw new Error(closeError);
    return { real: target, bytes: bytes.length };
  } catch (e) {
    close();
    const dropped = dropTemp();
    throw new Error(`--out publish refused: ${e.message}${dropped ? '' : `; a temp file may remain (${tmpName})`}`);
  }
}

function writeOut(file, launch, data) {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  // O-02: every ancestor of the output directory is checked (path-safe realInside from the drive
  // root), not the last component only.
  const guard = pathSafe.realInside(path.parse(dir).root, dir);
  if (!guard.ok || !guard.exists || guard.type !== 'dir') throw new Error(`--out directory is not a real directory: ${dir}`);
  const realDir = guard.real;
  const target = path.join(realDir, path.basename(abs));
  if (launch) {
    const l = realPath.realPathSync(launch);
    const same = process.platform === 'win32' ? l.toLowerCase() === target.toLowerCase() : l === target;
    if (same) throw new Error('--out names the launch file; the launch file is never written');
  }
  // A new file only: an existing file or link at that name is refused, never overwritten.
  const ex = pathSafe.realInside(realDir, target);
  if (!ex.ok) throw new Error(`--out cannot be guarded (${ex.reason}): ${file}`);
  if (ex.exists) throw new Error(`--out names an existing file; a new file only, never an overwrite: ${file}`);
  publishNewFile(realDir, target, Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf8'));
}

// The implicit TASK is also an input: missing is allowed, unreadable/link/invalid text is not.
// The declaration is read by the one shared reader (every own-line Markdown form, refusal
// of an unparseable one, disagreement refused, never first-wins); only the exact/tree path
// grammar of this gate is checked here.
function taskForbiddenText(text) {
  const paths = require('../../.ai/bin/lib/scope-contract.cjs').taskForbiddenDeclaration(text);
  if (!paths) return null;
  for (const p of paths) {
    const e = parseEntry(p);
    if (!e.ok || e.kind === 'glob') throw new Error('the TASK forbidden declaration has a path outside the exact/tree grammar');
  }
  return paths.join('\n');
}

function optionalTask(cwd) {
  const candidate = path.join(cwd, '.ai', 'TASK.md');
  const g = pathSafe.realInside(path.parse(candidate).root, candidate, { refuseHardlinks: true });
  if (!g.ok) throw new Error(`the TASK file cannot be guarded (${g.reason})`);
  return g.exists ? readInputFile(candidate, 'TASK file') : null;
}

function parseArgs(argv) {
  const o = {};
  const flags = ['--launch', '--baseline', '--scope', '--forbidden', '--base', '--candidate', '--cwd', '--out'];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!flags.includes(a)) throw new Error(`unknown argument: ${a}`);
    if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`missing value for ${a}`);
    const key = a.slice(2);
    if (o[key] !== undefined) throw new Error(`${a} given twice`);
    o[key] = argv[++i];
  }
  if (!o.launch && !o.baseline && !o.base) throw new Error('give --launch, --baseline with --scope, or --base with --candidate');
  if ((o.baseline || o.scope) && !(o.baseline && o.scope)) throw new Error('--baseline and --scope go together');
  if ((o.base || o.candidate) && !(o.base && o.candidate)) throw new Error('--base and --candidate go together');
  if (o.baseline && o.base) throw new Error('one POST source: --baseline/--scope or --base/--candidate');
  if (o.forbidden && !o.scope) throw new Error('--forbidden belongs to --scope');
  return o;
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write('usage: check-plan.cjs --launch FILE [--scope FILE] [--forbidden FILE] [--cwd DIR] [--out FILE] | --baseline SHA --scope FILE | --base SHA --candidate SHA\n'); return 0; }
  let o;
  try { o = parseArgs(argv); } catch (e) { process.stderr.write(`ERROR ${safeLine(e.message)}\n`); return 2; }
  const cwd = path.resolve(o.cwd || process.cwd());
  let out;
  try {
    const input = {};
    if (o.launch) {
      input.rootReal = realPath.realPathSync(cwd);
      // The launch file is read ONCE, guarded and decoded once;
      // the write-set entries and the Class declaration come from the same text.
      const launchText = readInputFile(o.launch, 'launch file');
      const t = parseLaunchText(launchText);
      if (!t.found) throw new Error(`launch file has no Write-set line: ${o.launch}`);
      input.launchRaws = t.raws;
      const d = declaredClassText(launchText);
      if (d.error) throw new Error(d.error);
      input.declared = d.value;
    }
    if (o.baseline) {
      const { checkScope, STANDING_DEFAULT_FORBIDDEN } = require('../../.ai/bin/protocol-scope.cjs');
      verifyRev(o.baseline, cwd);
      // Pass the verified text itself. No scratch file or second unguarded read exists.
      const scopeFile = path.resolve(cwd, o.scope);
      const forbiddenFile = o.forbidden ? path.resolve(cwd, o.forbidden) : null;
      const scopeText = readInputFile(scopeFile, 'scope file');
      const taskText = forbiddenFile ? null : optionalTask(cwd);
      const forbiddenText = forbiddenFile ? readInputFile(forbiddenFile, 'forbidden file')
        : (taskText === null ? null : taskForbiddenText(taskText)) ?? STANDING_DEFAULT_FORBIDDEN.join('\n');
      const scope = checkScope(o.baseline, scopeFile, forbiddenFile, cwd, { scopeText, forbiddenText });
      // This detects observed changes; separate file snapshots are not a tree transaction.
      if (readInputFile(scopeFile, 'scope file') !== scopeText) throw new Error('the scope file changed during the run');
      if (forbiddenFile && readInputFile(forbiddenFile, 'forbidden file') !== forbiddenText) throw new Error('the forbidden file changed during the run');
      if (!forbiddenFile && optionalTask(cwd) !== taskText) throw new Error('the TASK file changed during the run');
      input.paths = scope.touchedPaths;
      input.scope = { offendingOutOfScope: scope.offendingOutOfScope, offendingForbidden: scope.offendingForbidden };
    }
    if (o.base) input.paths = diffBetween(o.base, o.candidate, cwd);
    out = plan(input);
    if (o.out && out.exitCode !== 2) writeOut(o.out, o.launch, { tool: 'check-plan/1', launch: o.launch || null, base: o.base || o.baseline || null, candidate: o.candidate || null, exitCode: out.exitCode, ...out.result });
  } catch (e) {
    process.stderr.write(`ERROR ${safeLine(e.message)}\n`);
    return 2;
  }
  for (const line of out.lines) process.stdout.write(`${safeLine(line)}\n`);
  return out.exitCode;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { CLASS_A, DOMAINS, CHECKS, classifyEntry, classifyPath, domainContains, checksFor, declaredClassText, taskForbiddenText, plan, parseArgs, main };

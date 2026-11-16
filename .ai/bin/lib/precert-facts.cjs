'use strict';
// Precert facts: the exact facts a finished author round must hold before a certifier seat starts on it.
// Each fact is { code, ok, level: 'gate'|'warn', detail, fix }; rule-gates.cjs runGate turns them into a decision.
// The candidate's own tools check the candidate's own artifacts (an artifact is fresh when it equals what its own
// generator produces); the list of derived artifacts comes from the configuration of the repository that runs the
// gate, never from the candidate. Read-only: git queries and check commands only.
// opts.candidateHead pins the producer history; later commits may only add seat journals.
// opts.seatJournal names the one untracked journal of this launch. Neither option
// exempts a candidate producer from the committed-byte and Evidence checks.
//   P-HEAD      the worktree is a git tree with a HEAD
//   P-CLEAN     no uncommitted or untracked change outside .ai/worklog; the one exception is the certifier prompt file
//               named by opts.promptFile when it is an untracked file inside the worktree
//   P-BASE      the base of the round is known (--base, else the merge base with the integration branch)
//   P-COMMITS   at least one commit since the base; with a previous certified SHA: HEAD moved on from it by a non-merge commit
//   P-JOURNAL   the producer journal (the newest journal committed since the base) is committed as is and its newest
//               entry carries an Evidence block that verifies on this tree (protocol-handoff verify), or the author-check
//               form (authors run the targeted author check, the full suite runs in the landing train): the Evidence verifies on the tree, its only failing
//               check is the protocol-test line PROTOCOL_NO_FULL_SUITE=1 writes, and a green author-check receipt for this
//               head lies in opts.authorChecks (ruleGates.precert.authorChecks of the launching repository)
//   P-DERIVED   every configured derived artifact present in the tree passes its check command; one that existed at the
//               base and is absent now (a commit deleted it or its generator) is a refusal, not a skipped row
//   P-CITES     dangling claims refuse; explicit non-claim warnings stay visible (protocol-prose check --precert)
//   P-ENROLLED  every test file added under tests/ is enrolled in protocol-manifest.json (source role only)
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const receipts = require('../ops-tools/lib/receipt.cjs');
const realPath = require('./real-path.cjs');
// A journal holds an entry when the one entry text model finds a dated section in it (a fenced heading is entry text).
const { datedSections } = require('./entry-text.cjs');

const DEFAULT_DERIVED = [
  { name: 'core-catalog', path: '.ai/core/CATALOG.md', command: ['node', '.ai/bin/protocol-core.cjs', 'catalog', '--check'], regenerate: 'node .ai/bin/protocol-core.cjs catalog' },
];
const TEST_EXT = /\.(?:cjs|mjs|js)$/;
const REPORT = /(?:^|\/)(?:[^/]*AUTHOR-REPORT[^/]*|[^/]*-audit-prompt)\.md$/;
const ok = code => ({ code, ok: true, level: 'gate' });
const no = (code, detail, fix, level = 'gate') => ({ code, ok: false, level, detail, fix });

function citationFacts(result, reports) {
  const lines = (result.stdout || '').split(/\r?\n/);
  const unresolved = lines.filter(l => /^UNRESOLVED /.test(l));
  const warnings = lines.filter(l => /^WARNING /.test(l));
  const fix = `run node .ai/bin/protocol-prose.cjs check --precert ${reports.join(' ')} and repair every unresolved citation`;
  const facts = [result.status === 0 && !unresolved.length ? ok('P-CITES') : no('P-CITES', `${result.status === 1 ? `${unresolved.length} unresolved citation(s)` : 'the citation check could not read the report'}: ${unresolved.slice(0, 3).join(' | ') || `exit ${result.status}`}`, fix)];
  if (warnings.length) facts.push(no('P-CITES-WARN', `${warnings.length} citation warning(s): ${warnings.slice(0, 3).join(' | ')}`, 'read the named warning classes; spell out ambiguous targets', 'warn'));
  return facts;
}
const plain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const SAFE_REL = /^[A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)*$/;
const safeRel = p => typeof p === 'string' && SAFE_REL.test(p) && !p.split('/').some(s => s === '..' || s === '.');

// A derived-artifact row of the configuration: name, a relative path whose presence enables it, an argv whose
// first item is node (run as this node), an optional regenerate hint and optional needs (relative paths that must all
// exist; default the artifact and the script the command runs). A malformed row is a configuration error.
function derivedRows(list) {
  if (list === undefined) return { rows: DEFAULT_DERIVED, problem: null };
  if (!Array.isArray(list)) return { rows: [], problem: 'ruleGates.precert.derived is not a list' };
  for (const r of list) {
    if (!plain(r) || typeof r.name !== 'string' || !/^[a-z0-9-]{1,40}$/.test(r.name) || !safeRel(r.path)
      || !Array.isArray(r.command) || r.command[0] !== 'node' || r.command.length < 2 || !r.command.every(a => typeof a === 'string' && !/[\r\n\0]/.test(a))
      || (r.needs !== undefined && (!Array.isArray(r.needs) || !r.needs.every(safeRel)))) {
      return { rows: [], problem: `malformed derived row ${JSON.stringify(r).slice(0, 120)}` };
    }
  }
  return { rows: list, problem: null };
}

// The prompt file of the launch as a path relative to the real worktree, or null when it is not a file inside it.
function promptRel(wt, promptFile) {
  if (typeof promptFile !== 'string' || !promptFile.trim()) return null;
  try {
    const root = realPath.realPathSync(wt);
    const real = realPath.realPathSync(path.resolve(wt, promptFile));
    if (!fs.statSync(real).isFile()) return null;
    const rel = path.relative(root, real).replace(/\\/g, '/');
    return safeRel(rel) ? rel : null;
  } catch { return null; }
}

// The author-check form of the Evidence: the verify line that says every check but the failing one passed, and an
// Evidence body whose only failing check is the protocol-test line PROTOCOL_NO_FULL_SUITE=1 writes at once.
const FAILING_ONLY = 'evidence matches the tree but records a failing check.';
// Evidence wire-format compatibility: 1 is the older named-failure form; 3 is the current heavy-run refusal.
// Keep this parser independent of the regression driver: installed gates must load even when that source tool
// is absent. The regression test checks the driver's exported refusal code against the accepted Evidence form.
const NO_FULL_SUITE_LINE = /^- protocol-test\.cjs: exit (?:1|3) in (\d+)s$/;
const NO_FULL_SUITE_MAX_SECONDS = 120;
function failingCheckOnly(output, journal) {
  return String(output || '').split(/\r?\n/).some(l => l.replace(/\\/g, '/').trim() === `AI protocol: ${journal} ${FAILING_ONLY}`);
}
function noFullSuiteForm(body) {
  if (typeof body !== 'string' || !body) return 'the newest entry has no Evidence block';
  const lines = body.replace(/\r\n/g, '\n').split('\n').map(l => l.trimEnd());
  if (lines.some(l => /^- candidate(?:-|:)/.test(l))) return 'the Evidence is an immutable candidate receipt';
  if (!lines.some(l => /^- protocol-validate\.cjs: exit 0 in \d+s$/.test(l))) return 'the Evidence has no passing protocol-validate line';
  const failing = lines.filter(l => /exit [^0]/.test(l));
  if (failing.length !== 1) return `the Evidence records ${failing.length} failing checks`;
  const m = NO_FULL_SUITE_LINE.exec(failing[0]);
  if (!m) return `the failing check is not the PROTOCOL_NO_FULL_SUITE protocol-test line (${(failing[0] || '').slice(0, 80)})`;
  if (Number(m[1]) > NO_FULL_SUITE_MAX_SECONDS) return `protocol-test ran ${m[1]}s: a full suite ran and failed`;
  return null;
}
// The green author-check receipt of this head. -> null or the problem.
const authorReceiptProblem = (dir, sha, git) => authorReceipt(dir, sha, git).problem;
// The same decision with the deciding receipt: { problem, receipt, file } (receipt and file only when problem is null). The certifier
// scope of the launcher (docs/ops/cert-economy.cjs) reads the receipt through this one reader, so it accepts exactly what precert accepts.
function authorReceipt(dir, sha, git) {
  const refuse = problem => ({ problem, receipt: null, file: null });
  if (dir === undefined) return refuse('ruleGates.precert.authorChecks is not configured in the launching repository');
  if (typeof dir !== 'string' || !path.isAbsolute(dir) || /[\r\n\0]/.test(dir)) return refuse('ruleGates.precert.authorChecks is not an absolute directory path');
  let names;
  try { names = fs.readdirSync(dir).filter(n => /\.json$/.test(n)); } catch (e) { return refuse(`the receipt directory cannot be read (${String((e && e.code) || 'error').replace(/[^A-Za-z0-9_]/g, '')})`); }
  const ancestors = new Set((git(['rev-list', '--max-count=200', sha]).stdout || '').split('\n').map(s => s.trim()).filter(Boolean));
  const accepted = new Map();
  const acceptedHead = h => {
    if (!accepted.has(h)) {
      let yes = h === sha;
      if (!yes && ancestors.has(h)) {
        const d = git(['diff', '--name-only', '--no-renames', h, sha]);
        yes = d.status === 0 && (d.stdout || '').split('\n').map(s => s.trim()).filter(Boolean).every(p => p.startsWith('.ai/worklog/'));
      }
      accepted.set(h, yes);
    }
    return accepted.get(h);
  };
  const found = [];
  for (const n of names) {
    let r;
    try { r = JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { continue; }
    if (!plain(r) || typeof r.head !== 'string' || !/^[0-9a-f]{40}$/.test(r.head) || !n.endsWith(`-${r.head.slice(0, 8)}.json`)) continue;
    if (!acceptedHead(r.head)) continue;
    found.push({ n, r, at: Date.parse(r.at) });
  }
  if (!found.length) return refuse(`no author-check receipt for ${sha.slice(0, 12)} (or a journal-only ancestor) in ${dir}`);
  const newest = Math.max(...found.map(f => (Number.isNaN(f.at) ? -Infinity : f.at)));
  const deciding = found.filter(f => (Number.isNaN(f.at) ? -Infinity : f.at) === newest);
  for (const { n, r } of deciding) {
    const tree = git(['rev-parse', '--verify', `${r.head}^{tree}`]);
    // The receipt schemas and their coverage are the rule of the receipt module that author-check writes with; an unknown schema is not green.
    const green = receipts.coverageProblem(r) === null && r.ok === true && plain(r.results) && Object.keys(r.results).length > 0
      && Object.values(r.results).every(x => plain(x) && x.exit === 0) && Array.isArray(r.dirtyNonJournal) && r.dirtyNonJournal.length === 0
      && tree.status === 0 && typeof r.tree === 'string' && r.tree === tree.stdout.trim();
    if (!green) return refuse(`the newest author-check receipt ${n} is not green`);
  }
  return { problem: null, receipt: deciding[0].r, file: path.join(dir, deciding[0].n) };
}

function precertFacts(worktree, opts = {}) {
  const wt = path.resolve(worktree);
  const run = opts.spawn || spawnSync;
  const git = args => run('git', ['-C', wt, ...args], { encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  const node = (args, timeout = 300000) => run(process.execPath, args, { cwd: wt, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, PROTOCOL_NO_FULL_SUITE: '1' } });
  const facts = [];
  const head = git(['rev-parse', '--verify', 'HEAD']);
  if (head.status !== 0 || !/^[0-9a-f]{40}\s*$/.test(head.stdout || '')) return [no('P-HEAD', `${wt} has no HEAD`, 'launch on a git worktree of the candidate')];
  let sha = head.stdout.trim();
  facts.push(ok('P-HEAD'));

  // A seat may append its own journals after the sealed candidate. Only an explicit
  // ancestor pin can separate those commits; never infer a producer from an entry's age.
  if (opts.candidateHead !== undefined) {
    const pinned = git(['rev-parse', '--verify', `${opts.candidateHead}^{commit}`]);
    const candidate = pinned.status === 0 ? pinned.stdout.trim() : '';
    const delta = candidate && git(['diff', '--name-status', '--no-renames', '-z', candidate, 'HEAD']);
    const changes = delta ? delta.stdout.split('\0').filter(Boolean) : [];
    let journalsOnly = changes.length % 2 === 0;
    for (let i = 0; i < changes.length; i += 2) {
      if (changes[i] !== 'A' || !/^\.ai\/worklog\/[^/]+\.md$/.test(changes[i + 1]) || /\/README\.md$/i.test(changes[i + 1])) journalsOnly = false;
    }
    if (!/^[0-9a-f]{40}$/.test(candidate) || git(['merge-base', '--is-ancestor', candidate, 'HEAD']).status !== 0
      || !delta || delta.status !== 0 || !journalsOnly) {
      return [...facts, no('P-CANDIDATE', 'the candidate pin is not an ancestor with only seat journals after it', 'use the final candidate SHA; product changes require a new author round')];
    }
    sha = candidate;
    facts.push(ok('P-CANDIDATE'));
  }

  const st = git(['status', '--porcelain=v1', '-z', '--no-renames', '--untracked-files=all']);
  if (st.status !== 0) facts.push(no('P-CLEAN', 'git status failed', 'repair the worktree'));
  else {
    const prompt = promptRel(wt, opts.promptFile);
    const dirty = st.stdout.split('\0').filter(Boolean).filter(l => !(prompt && l === `?? ${prompt}`)).map(l => l.slice(3))
      .filter(p => p && !p.startsWith('.ai/worklog/') && !p.startsWith('.ai/runtime/'));
    facts.push(dirty.length ? no('P-CLEAN', `${dirty.length} uncommitted path(s): ${dirty.slice(0, 5).join(', ')}`, 'commit the named files (or move them out of the worktree); the round is certified on its final commit') : ok('P-CLEAN'));
  }

  // Classification is diagnostic for seat artifacts, never permission to skip a
  // producer. A caller may identify exactly one untracked journal of this launch.
  const seatJournal = typeof opts.seatJournal === 'string' ? opts.seatJournal.replace(/\\/g, '/') : null;
  const untracked = st.status === 0 ? st.stdout.split('\0').filter(l => l.startsWith('?? .ai/worklog/')).map(l => l.slice(3)) : [];
  if (opts.seatJournal !== undefined) {
    const valid = seatJournal && safeRel(seatJournal) && /^\.ai\/worklog\/[^/]+\.md$/.test(seatJournal)
      && untracked.includes(seatJournal) && git(['cat-file', '-e', `${sha}:${seatJournal}`]).status !== 0;
    facts.push(valid ? { ...ok('P-SEAT-JOURNAL'), detail: `seat journal of this launch ignored: ${seatJournal}` }
      : no('P-SEAT-JOURNAL', 'the seat journal is not an untracked journal outside the candidate', 'name only the fresh journal of this launch, never a candidate journal'));
  }
  const after = sha === head.stdout.trim() ? [] : (git(['diff', '--name-only', sha, 'HEAD', '--', '.ai/worklog/']).stdout || '').split('\n').filter(Boolean);
  for (const journal of new Set([...untracked, ...after])) {
    if (journal === seatJournal || /\/README\.md$/i.test(journal)) continue;
    let body;
    try { body = fs.readFileSync(path.join(wt, journal), 'utf8'); } catch { continue; }
    if (!datedSections(body).length) facts.push(no('P-SEAT-ABANDONED', `abandoned seat without an entry: ${journal}`, 'retain the journal for the operator; do not substitute it for the producer', 'warn'));
  }

  const manifest = (() => { try { const m = JSON.parse(fs.readFileSync(path.join(wt, 'protocol-manifest.json'), 'utf8')); return plain(m) ? m : null; } catch { return null; } })();
  let base = null;
  if (opts.base) {
    const r = git(['rev-parse', '--verify', `${opts.base}^{commit}`]);
    base = r.status === 0 ? r.stdout.trim() : null;
    if (!base) facts.push(no('P-BASE', `the base ${opts.base} is not a commit`, 'pass an existing commit or branch as the precert base'));
  } else {
    const branch = manifest && typeof manifest.integrationBranch === 'string' ? manifest.integrationBranch : null;
    for (const ref of branch ? [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`] : []) {
      const r = git(['merge-base', sha, ref]);
      if (r.status === 0 && r.stdout.trim()) { base = r.stdout.trim(); break; }
    }
    if (!base) facts.push(no('P-BASE', 'no base: no --precert-base and no merge base with the integration branch', 'pass --precert-base REF'));
  }
  if (base) facts.push(ok('P-BASE'));

  if (base) {
    const count = git(['rev-list', '--count', `${base}..${sha}`]);
    facts.push(count.status === 0 && Number(count.stdout.trim()) > 0 ? ok('P-COMMITS') : no('P-COMMITS', `no commit since the base ${base.slice(0, 12)}`, 'finish and commit the author round before certification'));
  }
  if (opts.prev) {
    const prev = git(['rev-parse', '--verify', `${opts.prev}^{commit}`]);
    const p = prev.status === 0 ? prev.stdout.trim() : '';
    if (!p) facts.push(no('P-PREV', `the previous certified commit ${opts.prev} is not a commit`, 'pass the full SHA of the previous certified commit'));
    else if (p === sha) facts.push(no('P-PREV', 'HEAD equals the previous certified commit: the author round produced no commit', 'wait for the author round to commit, or relaunch it'));
    else if (git(['merge-base', '--is-ancestor', p, sha]).status !== 0) facts.push(no('P-PREV', 'the previous certified commit is not an ancestor of HEAD', 'check the worktree and branch of the round'));
    else if (!git(['rev-list', '--no-merges', '--count', `${p}..${sha}`]).stdout.trim().match(/^[1-9]\d*$/)) facts.push(no('P-PREV', 'only merge commits since the previous certified commit', 'the author round must commit its own change'));
    else facts.push(ok('P-PREV'));
  }

  // Producer journal: the newest journal committed since the base, or the named one.
  if (base) {
    let journal = opts.journal ? String(opts.journal).replace(/\\/g, '/') : null;
    if (!journal) {
      const log = git(['log', '--format=', '--name-only', '--diff-filter=AM', `${base}..${sha}`, '--', '.ai/worklog/']);
      journal = (log.stdout || '').split('\n').map(s => s.trim()).find(p => p && !/\/README\.md$/i.test(p)) || null;
    }
    if (!journal || !safeRel(journal) || !journal.startsWith('.ai/worklog/')) facts.push(no('P-JOURNAL', 'no producer journal committed since the base', 'write the journal entry, run node .ai/bin/protocol-handoff.cjs record --owner OWNER on the final tree, commit the journal'));
    else {
      const changed = git(['status', '--porcelain=v1', '--', journal]);
      const tracked = git(['ls-files', '--error-unmatch', '--', journal]);
      const candidateChange = sha === head.stdout.trim() ? { status: 0, stdout: '' } : git(['diff', '--name-only', sha, 'HEAD', '--', journal]);
      if (tracked.status !== 0 || (changed.stdout || '').trim() || candidateChange.status !== 0 || candidateChange.stdout.trim()) facts.push(no('P-JOURNAL', `${journal} differs from the final commit`, 'commit the journal after its Evidence block was recorded'));
      else {
        const v = node([path.join(wt, '.ai', 'bin', 'protocol-handoff.cjs'), 'verify', '--journal', journal], 120000);
        const said = `${v.stdout || ''}${v.stderr || ''}`.split(/\r?\n/).find(l => l.trim()) || `exit ${v.status}`;
        const fix = 'run node .ai/bin/protocol-handoff.cjs record --owner OWNER after the last change, then commit the journal';
        if (v.status === 0) facts.push(ok('P-JOURNAL'));
        else if (v.status !== 1 || !failingCheckOnly(`${v.stdout || ''}\n${v.stderr || ''}`, journal)) facts.push(no('P-JOURNAL', `${journal}: ${said}`, fix));
        else {
          let body = null;
          try { const ev = require('../protocol-handoff/evidence.cjs').readEvidence(path.join(wt, journal)); body = ev && ev.body; } catch { body = null; }
          const form = noFullSuiteForm(body);
          const receipt = form ? null : authorReceiptProblem(opts.authorChecks, sha, git);
          if (form) facts.push(no('P-JOURNAL', `${journal}: ${said} (${form})`, fix));
          else if (receipt) facts.push(no('P-JOURNAL', `${journal}: the Evidence records the PROTOCOL_NO_FULL_SUITE protocol-test line and no green author-check receipt: ${receipt}`, 'run the author check on the final commit (a later journal-only commit is accepted) so its green receipt lands in the configured directory, or record a full Evidence'));
          else facts.push(ok('P-JOURNAL'));
        }
      }
    }
  }

  // Derived artifacts: a configured row runs only where its artifact exists.
  const derived = derivedRows(opts.derived);
  if (derived.problem) facts.push(no('P-DERIVED', derived.problem, 'repair ruleGates.precert.derived in protocol-manifest.json of the launching repository'));
  for (const r of derived.rows) {
    const needs = r.needs || [r.path, ...(r.command[1] !== '-e' && safeRel(r.command[1]) ? [r.command[1]] : [])];
    const absent = needs.filter(p => !fs.existsSync(path.join(wt, p)));
    if (absent.length) {
      // A row skips where its artifact never existed (a host without it); one that existed at the base and is gone now was
      // deleted by a commit of the round, which is no fresh artifact: the check cannot run and the fact is a refusal.
      const gone = base ? absent.filter(p => git(['cat-file', '-e', `${base}:${p}`]).status === 0) : [];
      if (gone.length) facts.push(no(`P-DERIVED:${r.name}`, `${gone.join(', ')} existed at the base ${base.slice(0, 12)} and is gone: a commit deleted what the freshness check of ${r.path} needs`, `restore ${gone[0]}, or remove the ${r.name} row from ruleGates.precert.derived of the launching repository when the artifact is retired on purpose`));
      continue;
    }
    const c = node(r.command.slice(1));
    const said = `${c.stdout || ''}${c.stderr || ''}`.split(/\r?\n/).filter(l => l.trim()).slice(-1)[0] || `exit ${c.status}`;
    facts.push(c.status === 0 ? ok(`P-DERIVED:${r.name}`) : no(`P-DERIVED:${r.name}`, `${r.path} is not fresh (${said})`, r.regenerate ? `run ${r.regenerate} and commit ${r.path}` : `regenerate ${r.path} and commit it`));
  }

  if (base) {
    const diff = git(['diff', '--name-status', '--no-renames', '-z', base, sha]);
    const parts = (diff.stdout || '').split('\0').filter(Boolean);
    const changes = [];
    for (let i = 0; i + 1 < parts.length; i += 2) changes.push({ status: parts[i], path: parts[i + 1] });
    const reports = [...new Set([
      ...changes.filter(c => c.status !== 'D' && REPORT.test(c.path)).map(c => c.path),
      ...(opts.reports || []).map(p => String(p).replace(/\\/g, '/')),
    ])];
    if (!reports.length) facts.push(no('P-CITES', 'no author report or audit prompt changed since the base', 'write the round section of the author report', 'warn'));
    else if (!fs.existsSync(path.join(wt, '.ai', 'bin', 'protocol-prose.cjs'))) facts.push(no('P-CITES', 'protocol-prose.cjs is absent in the candidate', 'check the citations by hand', 'warn'));
    else if (!reports.every(safeRel)) facts.push(no('P-CITES', 'an author report path is not a plain relative path', 'name the report by its repository path'));
    else {
      const c = node([path.join(wt, '.ai', 'bin', 'protocol-prose.cjs'), 'check', '--precert', ...reports]);
      facts.push(...citationFacts(c, reports));
    }
    if (manifest && manifest.role === 'source') {
      const enrolled = new Set([...(manifest.managed || []), ...(manifest.source || []), ...(manifest.tests || [])]);
      const added = changes.filter(c => c.status === 'A' && TEST_EXT.test(c.path));
      const missing = added.filter(c => c.path.startsWith('tests/') && !enrolled.has(c.path)).map(c => c.path);
      facts.push(missing.length ? no('P-ENROLLED', `${missing.length} new test file(s) not in protocol-manifest.json: ${missing.slice(0, 5).join(', ')}`, 'add each to the tests list of protocol-manifest.json') : ok('P-ENROLLED'));
      const elsewhere = added.filter(c => !c.path.startsWith('tests/') && /\.test\.(?:cjs|mjs|js)$/.test(c.path) && !enrolled.has(c.path)).map(c => c.path);
      if (elsewhere.length) facts.push(no('P-ENROLLED-OUTSIDE', `${elsewhere.length} new test file(s) outside tests/ not enrolled: ${elsewhere.slice(0, 3).join(', ')}`, 'enroll them, or say in the author report why they stay out', 'warn'));
    }
  }
  return facts;
}

module.exports = { DEFAULT_DERIVED, precertFacts, derivedRows, noFullSuiteForm, authorReceiptProblem, authorReceipt, NO_FULL_SUITE_MAX_SECONDS, citationFacts };

'use strict';
// The quick author check: the cheap exact checks a round must hold before its farm author check and its readers. One
// module, three callers: the author command (.ai/bin/ops-tools/author-quick.cjs), the precert gate (precert-facts.cjs)
// and the light author check (.ai/bin/ops-tools/author-check.cjs --light). Inputs are explicit (root, base, head, the
// changes of the round); never the cwd and never the candidate's configuration as an authority. Checker code is this
// loaded line's; the candidate root and its git objects are data. Each fact is { code, ok, level, detail, fix }, and a
// refusal names the file and the fix.
//   P-DERIVED:STAGE   every stage of the derived generators is fresh; P-DERIVED:source-pins a source contract pin holds
//   P-CORPUS          the required-corpus reader inventory equals the tracked readers and their pinned bytes
//   P-SPEC-CITES      every citation of the packet compiler specification carries its row text
//   P-CITE-CONSUMERS  the register citation consumer inventory covers every tracked reader of the compiled views
//   P-CITES           the author reports and audit prompts of the round cite only what exists
//   P-AUDIT-PROMPT    a package on high-risk paths names its committed audit prompt in its author report
//   P-PRODUCT-EARLY   the early product gates (a forbidden references, c personal data) on changed shipped files
//   P-PUBLICATION     publication provenance of changed shipped text
//   P-DECISIONS       the candidate holds every accepted decision of the main checkout and the integration line
// The first four are parts of the protocol source repository (its source adapters); a kernel without
// them, or a candidate without the checked data, reports the part as skipped, never as passed. The audit prompt part is the
// rule of the protocol source repository too: an installed project chooses its own review path.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const LINE = path.resolve(__dirname, '..', '..', '..');
const PARTS = Object.freeze(['derived', 'corpus', 'spec-cites', 'cite-consumers', 'prose', 'audit-prompt', 'product-early', 'publication', 'decisions']);
const SOURCE_PARTS = Object.freeze({ derived: 'derivedFacts', corpus: 'corpusFacts', 'spec-cites': 'specFacts', 'cite-consumers': 'consumerFacts' });
const PRODUCT_MANIFEST = 'docs/ops/product/PRODUCT-MANIFEST.json';
const ok = code => ({ code, ok: true, level: 'gate' });
const no = (code, detail, fix, level = 'gate') => ({ code, ok: false, level, detail, fix });
const plain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function sourceParts() {
  // The source repository's adapters; an installed kernel has none of them.
  const file = path.join(LINE, '.ai', 'bin', 'ops-tools', 'source', 'quick-source.cjs');
  return fs.existsSync(file) ? require(file) : null;
}
function gitOf(root, run) {
  const env = { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k))), GIT_NO_REPLACE_OBJECTS: '1' };
  return args => run('git', ['-C', root, ...args], { env, encoding: 'utf8', windowsHide: true, timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
}

// -> { facts, skipped: [{ part, reason }], timing: { part: ms }, totalMs, base, sha, productLines }
// opts.productEarly is the content provider of a caller's harness (author-check --light hands its own in); the presence
// of the product manifest decides only for this kernel's early product gates. productLines are the lines of that run.
function quickFacts(opts = {}) {
  const root = typeof opts.root === 'string' && path.isAbsolute(opts.root) ? path.resolve(opts.root) : null;
  if (!root) throw Object.assign(new Error('AUTHOR-QUICK: an absolute root is required'), { code: 'AUTHOR-QUICK-USAGE' });
  if (typeof opts.base !== 'string' || !opts.base.trim()) throw Object.assign(new Error('AUTHOR-QUICK: an explicit base is required'), { code: 'AUTHOR-QUICK-USAGE' });
  const run = opts.run || spawnSync;
  const git = opts.git || gitOf(root, run);
  const clock = opts.clock || (() => Date.now());
  const parts = opts.parts ? PARTS.filter(p => opts.parts.includes(p)) : PARTS;
  const resolve = rev => { const r = git(['rev-parse', '--verify', `${rev}^{commit}`]); return r.status === 0 ? String(r.stdout).trim() : null; };
  const sha = opts.sha || resolve('HEAD');
  const base = resolve(opts.base);
  const facts = []; const skipped = []; const timing = {}; let productLines = [];
  const started = clock();
  if (!sha || !base) {
    facts.push(no('P-QUICK-INPUT', `${!sha ? `${root} has no HEAD` : `the base ${opts.base} is not a commit`}`, 'run the quick check on a git worktree of the candidate with an existing base commit or branch'));
    return { facts, skipped, timing, totalMs: clock() - started, base, sha, productLines };
  }
  // The fact checks of the precert gate module: the caller's own (precert-facts hands itself in), else this line's.
  const precert = () => (plain(opts.checks) ? opts.checks : require('./precert-facts.cjs'));
  let changes = opts.changes || null; let changesError = opts.changesError || null;
  if (!changes && !changesError) {
    const diff = git(['diff', '--name-status', '--no-renames', '-z', base, sha]);
    if (diff.status === 0) changes = precert().changeRows(diff.stdout);
    else changesError = `candidate objects cannot be read (base ${base}, head ${sha}; exit ${diff.status})`;
  }
  const manifest = opts.manifest !== undefined ? opts.manifest : (() => { try { const m = JSON.parse(fs.readFileSync(path.join(root, 'protocol-manifest.json'), 'utf8')); return plain(m) ? m : null; } catch { return null; } })();
  const atSha = rel => git(['cat-file', '-e', `${sha}:${rel}`]).status === 0;
  const atBase = rel => git(['cat-file', '-e', `${base}:${rel}`]).status === 0;
  const source = parts.some(p => SOURCE_PARTS[p]) ? sourceParts() : null;
  const steps = {
    prose: () => precert().citesFacts({ root, sha, changes, changesError, git, run, ...(plain(opts.cites) ? opts.cites : {}) }),
    'audit-prompt': () => (manifest?.role !== 'source' ? { skip: 'the review path of an installed project is its owner\'s' }
      : changes ? precert().auditPromptFacts({ root, sha, changes, git, launchFiles: opts.launchFiles || [] })
        : [no('P-AUDIT-PROMPT', changesError, 'restore the candidate git objects or fetch the missing base')]),
    'product-early': () => {
      if (!opts.productEarly && !atSha(PRODUCT_MANIFEST)) {
        if (atBase(PRODUCT_MANIFEST)) return [no('P-PRODUCT-EARLY', `${PRODUCT_MANIFEST} existed at the base and is gone`, `restore ${PRODUCT_MANIFEST}`)];
        return { skip: 'the candidate holds no product manifest' };
      }
      const early = (opts.productEarly || require('../ops-tools/product-gate-early.cjs').run)({ root, base, source: sha });
      productLines = Array.isArray(early.lines) ? early.lines.map(String) : [];
      if (early.applicable === false) return { skip: 'the early product gates are absent from installed kernels' };
      if (early.ok) return [{ ...ok('P-PRODUCT-EARLY'), detail: `checked=${(early.checked || []).length} deferred=${(early.deferred || []).length}` }];
      const findings = (early.results || []).filter(r => !r.ok).flatMap(r => r.findings.map(f => `${r.gate}: ${f}`));
      return [no('P-PRODUCT-EARLY', (findings.length ? findings : early.lines || ['the early product check failed']).slice(0, 3).join(' | '),
        'remove the named reference or value from the shipped file, or add an exact allowedReferences row with its reason to the product manifest')];
    },
    publication: () => precert().publicationFacts({ root, base, sha, manifest }),
    decisions: () => {
      const ahead = require('./packet-gate.cjs').decisionsAhead({ worktree: root, commit: sha, run });
      if (ahead.ok) return [ok('P-DECISIONS')];
      return [no('P-DECISIONS', `.ai/DECISIONS.md of the candidate lacks accepted block(s) of ${(ahead.sources || ['the line']).join(', ')}: ${ahead.reason || ahead.missing.slice(0, 8).join(', ')}`,
        'merge the integration line into the branch (git merge origin/BRANCH), then run the checks again')];
    },
  };
  for (const part of parts) {
    const t0 = clock();
    let got;
    try {
      if (SOURCE_PARTS[part]) got = source ? source[SOURCE_PARTS[part]](root) : { facts: [], skipped: 'this kernel carries no source checkers' };
      else got = steps[part]();
    } catch (e) {
      got = [no(`P-QUICK-ERROR:${part}`, String((e && e.message) || e).split(/\r?\n/)[0].slice(0, 300), `repair the cause of the ${part} check; a check that cannot run never passes`)];
    }
    if (Array.isArray(got)) facts.push(...got);
    else if (got && got.skip) skipped.push({ part, reason: got.skip });
    else { facts.push(...(got.facts || [])); if (got.skipped) skipped.push({ part, reason: got.skipped }); }
    timing[part] = Math.max(0, clock() - t0);
  }
  return { facts, skipped, timing, totalMs: Math.max(0, clock() - started), base, sha, productLines };
}

// The printed form: one line per refused or warned fact, a line per skipped part, the timing and the result.
function lines(result) {
  const out = [];
  const said = f => `${f.code}: ${String(f.detail || '').replace(/[\r\n\t]+/g, ' ').slice(0, 400)}${f.fix ? `; fix: ${f.fix}` : ''}`;
  for (const f of result.facts) out.push(f.ok ? `AUTHOR-QUICK OK ${f.code}` : `AUTHOR-QUICK ${f.level === 'warn' ? 'WARN' : 'REFUSED'} ${said(f)}`);
  for (const s of result.skipped) out.push(`AUTHOR-QUICK SKIPPED ${s.part}: ${s.reason}`);
  out.push(`AUTHOR-QUICK TIME total=${result.totalMs}ms ${Object.entries(result.timing).map(([k, v]) => `${k}=${v}`).join(' ')}`);
  const refused = result.facts.filter(f => !f.ok && f.level !== 'warn');
  out.push(`AUTHOR-QUICK ${refused.length ? 'REFUSED' : 'PASS'} refused=${refused.length} warnings=${result.facts.filter(f => !f.ok && f.level === 'warn').length} head=${String(result.sha || '').slice(0, 12)} base=${String(result.base || '').slice(0, 12)}`);
  return out;
}

module.exports = { PARTS, quickFacts, lines };

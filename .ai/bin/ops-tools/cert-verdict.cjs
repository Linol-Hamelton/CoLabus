'use strict';
// Read-only local report checks, not launch/model/independence qualification.
// Usage: cert-verdict.cjs WORKTREE [--sha FULL_SHA] [--report RELATIVE.md] [--json]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const safe = require('../lib/text-safe.cjs');
const { realInside, readFileGuarded } = require('../lib/path-safe.cjs');
const { certificationFacts, reviewedSha, headerOf } = require('../lib/review-facts.cjs');
const binding = require('../lib/review-binding.cjs');
const { readVerdict } = require('../lib/verdict-read.cjs');
const { entryBody, readEvidence } = require('../protocol-handoff/evidence.cjs');
// What an entry claims is its text before its own Evidence block (the one entry text model; fenced text is entry text).
const { claimText } = require('../lib/entry-text.cjs');
const { verifyReceipt } = require('./cert-count.cjs');
const realPath = require('../lib/real-path.cjs');
const SHA = /^(?!([a-f0-9])\1{39}$)[a-f0-9]{40}$/;
const REPORT = /^docs\/reviews\/[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

function read(root, relative) {
  const got = readFileGuarded(root, path.resolve(root, relative), { maxBytes: 8 * 1024 * 1024 });
  if (!got.ok) throw Error('READ');
  const decoded = safe.decode(got.bytes, { bom: 'strip', crlf: 'normalise' });
  if (!decoded.ok) throw Error('TEXT');
  return decoded.text;
}
function git(root, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES'].includes(key.toUpperCase())));
  const r = spawnSync('git', ['-C', root, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 1024 * 1024,
    env,
  });
  if (r.error || r.signal || r.status !== 0) throw Error('GIT');
  return r.stdout.trim();
}
function newestReport(root) {
  const dir = realInside(root, path.join(root, 'docs/reviews'));
  if (!dir.ok || !dir.exists || dir.type !== 'dir') throw Error('REPORT-DIR');
  const rows = fs.readdirSync(dir.real).filter(name => name.endsWith('.md') && !/audit-prompt/i.test(name))
    .map(name => {
      const relative = `docs/reviews/${name}`;
      const file = realInside(root, path.join(root, relative), { refuseHardlinks: true });
      if (!REPORT.test(relative) || !file.ok || !file.exists || file.type !== 'file') throw Error('REPORT-PATH');
      return { relative, time: fs.statSync(file.real).mtimeMs };
    });
  rows.sort((a, b) => b.time - a.time || compare(a.relative, b.relative));
  if (!rows.length) throw Error('REPORT-MISSING');
  return rows[0].relative;
}
function inspect(options, deps = {}) {
  const facts = [];
  const add = (code, ok) => facts.push({ code, ok: ok === true });
  const result = { status: 'NOT-COUNTED', scope: 'local-report', report: null, expectedSha: null,
    owner: null, reportStatus: [], verdict: null, facts, reasons: [] };
  const finish = () => {
    result.reasons = facts.filter(f => !f.ok).map(f => f.code);
    result.status = result.reasons.length ? 'NOT-COUNTED' : 'COUNTED';
    return result;
  };
  let root;
  try {
    root = realPath.realPathSync(path.resolve(options.worktree));
    const top = realPath.realPathSync(git(root, ['rev-parse', '--show-toplevel']));
    if (root !== top) throw Error('NOT-ROOT');
    add('WORKTREE', true);
  } catch { add('WORKTREE', false); return finish(); }
  try {
    result.expectedSha = options.sha === undefined ? git(root, ['rev-parse', 'HEAD']) : options.sha;
    if (typeof result.expectedSha !== 'string' || !SHA.test(result.expectedSha)) throw Error('SHA');
    // An arbitrary full hex string is not a sealed commit in this repository.
    if (git(root, ['cat-file', '-t', result.expectedSha]) !== 'commit') throw Error('COMMIT');
    add('EXPECTED-SHA', true);
  } catch { result.expectedSha = null; add('EXPECTED-SHA', false); }
  let text;
  try {
    result.report = options.report === undefined ? newestReport(root) : options.report;
    if (typeof result.report !== 'string' || !REPORT.test(result.report) || /audit-prompt/i.test(result.report)) throw Error('REPORT');
    text = read(root, result.report);
    add('REPORT-READ', true);
  } catch { result.report = null; add('REPORT-READ', false); return finish(); }
  for (const f of certificationFacts(text, { expectedSha: result.expectedSha || 'INVALID' }).filter(f => f.level === 'gate')) add(f.code, f.ok);
  add('R-EXACT-SHA', result.expectedSha !== null && reviewedSha(text) === result.expectedSha);
  const header = safe.ownLines(headerOf(text)).map(l => l.text).join('\n');
  const modes = binding.fields(header, 'Mode');
  add('R-MODE', modes.length === 1 && modes[0].replace(/[*_`]/g, '').trim() === 'CERTIFYING');
  result.reportStatus = binding.fields(header, 'Status');
  result.verdict = readVerdict(text).token;
  add('R-VERDICT', ['PASS', 'RECOMMENDATION'].includes(result.verdict));
  result.owner = binding.reviewOwner(header);
  add('R-OWNER', result.owner !== null);
  if (result.owner) {
    try {
      const journal = path.join(root, '.ai/worklog', `${result.owner}.md`);
      read(root, `.ai/worklog/${result.owner}.md`);
      const body = entryBody(journal);
      add('R-JOURNAL', body !== null && binding.mentionedReviews(claimText(body)).includes(result.report));
      const evidence = readEvidence(journal);
      const problem = evidence ? binding.verifyBindings(root, result.owner, evidence.body, result.report) : 'R-BINDING-MISSING';
      add('R-BINDING', !!evidence && problem === null);
      if (problem === 'R-BINDING-MISSING') {
        add('R-BINDING-MISSING', false);
        result.bindingHint = binding.BINDING_HINT;
      }
    } catch {
      add('R-JOURNAL', false); add('R-BINDING', false);
      add('R-BINDING-MISSING', false); result.bindingHint = binding.BINDING_HINT;
    }
    try { add('R-RECEIPT', (deps.verifyReceipt || verifyReceipt)(root, result.owner)); }
    catch { add('R-RECEIPT', false); }
  }
  return finish();
}
function format(result, json = false) {
  if (json) return `${JSON.stringify(result)}\n`;
  return [`REPORT ${JSON.stringify(result.report)}`, `EXPECTED-SHA ${JSON.stringify(result.expectedSha)}`,
    `STATUS ${JSON.stringify(result.reportStatus)}`, `VERDICT ${JSON.stringify(result.verdict)}`, `OWNER ${JSON.stringify(result.owner)}`,
    ...result.facts.map(f => `${f.code} ${f.ok ? 'PASS' : 'FAIL'}`),
    ...(result.bindingHint ? [`R-BINDING-MISSING: ${result.bindingHint}`] : []),
    `${result.status}${result.reasons.length ? ` ${result.reasons.join(',')}` : ''}`].join('\n') + '\n';
}
function main(argv) {
  const options = {}; let json = false;
  try {
    if (!argv[0] || argv[0].startsWith('--')) throw Error('USAGE');
    options.worktree = argv[0];
    for (let i = 1; i < argv.length; i++) {
      if (argv[i] === '--json' && !json) { json = true; continue; }
      const key = { '--sha': 'sha', '--report': 'report' }[argv[i]];
      if (!key || Object.hasOwn(options, key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('USAGE');
      options[key] = argv[++i];
    }
    const result = inspect(options);
    process.stdout.write(format(result, json));
    return result.status === 'COUNTED' ? 0 : 1;
  } catch {
    const result = { status: 'NOT-COUNTED', reasons: ['INPUT-REFUSED'] };
    process.stdout.write(argv.includes('--json') ? `${JSON.stringify(result)}\n` : 'NOT-COUNTED INPUT-REFUSED\n');
    return 2;
  }
}
module.exports = { inspect, newestReport, format, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

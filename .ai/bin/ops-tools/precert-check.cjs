'use strict';
// Operator pre-certification check: refuse to dispatch a certifier on a round that did not
// finish. Two facts are judged here.
//   P-AUTHOR-CHECK  a green author-check receipt is bound to HEAD (the one fact RULE-GATES
//                   does not carry; its reader and ledger live in lib/receipt.cjs)
//   the rest        delegated to the precert command of the RULE-GATES gate runner (one
//                   contract, never a second implementation here)
// A tree without the RULE-GATES gate refuses by name: the ported tool must not grow a
// duplicate of precert-facts.cjs while the gate is absent.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { load } = require('./lib/config.cjs');
const receipt = require('./lib/receipt.cjs');

function gitRunner(root, run) {
  const spawn = run || ((file, args, opts) => spawnSync(file, args, opts));
  return args => {
    const r = spawn('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
    if (r.error || r.status !== 0) throw Object.assign(new Error(`PRECERT-GIT: git ${args[0]} failed`), { code: 'PRECERT-GIT' });
    return args.includes('-z') ? (r.stdout || '') : (r.stdout || '').trim();
  };
}

function authorLine(fact) {
  return `${fact.ok ? 'PRECERT-OK' : 'REFUSED'} ${fact.code}: ${fact.detail || ''}${fact.fix ? `; fix: ${fact.fix}` : ''}`;
}

function authorCheckFact(options) {
  const git = options.git;
  let head;
  try { head = git(['rev-parse', 'HEAD']); } catch { return { code: 'P-AUTHOR-CHECK', ok: false, level: 'gate', detail: 'the worktree has no HEAD', fix: 'launch on a git worktree of the candidate' }; }
  let dirty;
  try { dirty = receipt.dirtyNonJournal(git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])); }
  catch { dirty = ['unreadable worktree status']; }
  const judgement = receipt.assess({
    head,
    dirtyNonJournal: dirty,
    treeAt: commit => { try { return git(['rev-parse', `${commit}^{tree}`]); } catch { return null; } },
    worktree: options.worktree,
    receiptDir: options.receiptDir,
    overrideReason: options.overrideReason,
    now: options.now,
    isAncestor: (from, to) => { try { git(['merge-base', '--is-ancestor', from, to]); return true; } catch { return false; } },
    changedBetween: (from, to) => { try { return git(['diff', '--no-renames', '--name-only', '-z', from, to]).split('\0').filter(Boolean); } catch { return null; } },
  });
  if (judgement.ok) return { code: 'P-AUTHOR-CHECK', ok: true, level: 'gate', detail: [judgement.why, ...(judgement.problems || [])].join('; ') };
  return {
    code: 'P-AUTHOR-CHECK', ok: false, level: 'gate',
    detail: judgement.why,
    fix: 'run node .ai/bin/ops-tools/author-check.cjs WORKTREE on the final commit, then retry',
  };
}

// The delegated RULE-GATES fact. Absence is a named refusal, not a pass and not a copy.
function gateFact(options) {
  if (!options.gatesExists) {
    return {
      code: 'P-GATE-UNAVAILABLE', ok: false, level: 'gate', lines: [],
      detail: `the RULE-GATES gate ${options.gates} is absent (it arrives with the RULE-GATES package)`,
      fix: 'land RULE-GATES, or judge the author-check fact alone with --receipt-only while the gate is absent',
    };
  }
  const args = [options.gates, 'precert', '--worktree', options.worktree];
  for (const [flag, value] of [['--base', options.base], ['--prev', options.prev], ['--journal', options.journal], ['--override', options.gateOverride]]) {
    if (typeof value === 'string' && value) args.push(flag, value);
  }
  for (const report of options.reports || []) args.push('--report', report);
  const r = options.runGate ? options.runGate(args) : options.spawn(process.execPath, args, { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: 600000 });
  const lines = `${r.stdout || ''}\n${r.stderr || ''}`.split(/\r?\n/).filter(Boolean);
  return { code: 'P-RULE-GATES', ok: r.status === 0 && !r.error, level: 'gate', lines, detail: lines.find(line => /^(REFUSED|OVERRIDDEN|WARN|GATE-ERROR)/.test(line)) || null };
}

function run(options = {}) {
  const worktree = path.resolve(options.worktree || '.');
  const cfg = options.cfg || load({ root: options.root || worktree, workRoot: options.workRoot, env: options.env || process.env });
  const spawn = options.spawn || ((file, args, opts) => spawnSync(file, args, opts));
  const git = options.git || gitRunner(worktree, spawn);
  const env = options.env || process.env;
  const overrideReason = options.overrideReason !== undefined ? options.overrideReason : env.PRECERT_NO_AUTHOR_CHECK;
  const author = authorCheckFact({ worktree, git, receiptDir: options.receiptDir || cfg.receiptRoot, overrideReason, now: options.now });
  if (options.receiptOnly) {
    const lines = [authorLine(author)];
    return { ok: author.ok, facts: [author], lines, refused: author.ok ? [] : [author.code] };
  }
  const gates = options.gates || cfg.gates;
  const gate = gateFact({
    worktree, gates, gatesExists: options.gatesExists === undefined ? fs.existsSync(gates) : options.gatesExists,
    base: options.base, prev: options.prev, journal: options.journal, gateOverride: options.gateOverride, reports: options.reports,
    runGate: options.runGate, spawn,
  });
  const lines = [authorLine(author)];
  if (gate.lines && gate.lines.length) lines.push(...gate.lines);
  else lines.push(authorLine(gate));
  const facts = [author, gate];
  const refused = facts.filter(fact => !fact.ok).map(fact => fact.code);
  return { ok: refused.length === 0, facts, lines, refused };
}

function main(argv) {
  const args = argv.slice();
  const take = name => { const i = args.indexOf(name); if (i < 0) return undefined; const value = args[i + 1]; args.splice(i, 2); return value; };
  const receiptOnly = args.includes('--receipt-only');
  if (receiptOnly) args.splice(args.indexOf('--receipt-only'), 1);
  const base = take('--base');
  const journal = take('--journal');
  const gateOverride = take('--override');
  const reports = [];
  while (args.includes('--report')) {
    const report = take('--report');
    if (!report || report.startsWith('--')) return 2;
    reports.push(report);
  }
  const worktree = args[0];
  if (!worktree) { process.stdout.write('usage: precert-check.cjs WORKTREE [PREVIOUS_CERT_SHA] [--base REF] [--journal PATH] [--report PATH] [--override REASON] [--receipt-only]\n'); return 2; }
  const result = run({ worktree, prev: args[1], base, journal, gateOverride, reports, receiptOnly });
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  if (result.ok) process.stdout.write('OK\n');
  else process.stdout.write(`NOT CERTIFIABLE: ${result.refused.join(' | ')}\n`);
  return result.ok ? 0 : 1;
}

module.exports = { run, main, authorCheckFact, gateFact };
if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (e) { process.stderr.write(`${/^[A-Z-]+:/.test(e.message) ? e.message : 'PRECERT-REFUSED: ' + e.message}\n`); process.exitCode = 1; }
}

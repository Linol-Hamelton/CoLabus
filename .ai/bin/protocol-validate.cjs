#!/usr/bin/env node
'use strict';

// P3 Node validator entry and CLI (OT-05 section В5 step 5, final-plan-2
// sections I and J). The entry owns the exact check order and the rendering;
// the modules under validator/ export per-check functions and never print.
// All contract-map sections are implemented: entry (CM-01..CM-05, CM-47),
// repository (CM-06..CM-14), text (CM-15..CM-19, CM-21..CM-24, CM-45, CM-70),
// platform (CM-25..CM-29, CM-40..CM-43, CM-46, CM-20 as the one PowerShell
// parser subprocess), governance (CM-30..CM-33, CM-44) and gate structure
// (CM-34..CM-39). CM-70 is the encoding guard added by PROTO-DEC-0153 item 7.
// CM-71 is the rule-20 owner-words check:
// ADVISORY, WARN only, never FAIL, until a separate owner word activates it
// (validator/owner-words.cjs). coverage.notImplemented is empty; the migration is
// complete; direct callers use this Node entry.
//
// Public API (final-plan-2 section J):
//   validate(root, options) -> { diagnostics, counts, exitCode, coverage }
// Synchronous, no global state, no import-time execution, no printing, no
// cwd/env mutation, no persistent cache.
//
// CLI: node protocol-validate.cjs [--root <abs>] [--quiet]
// Unknown arguments fail. --quiet suppresses PASS lines only. Exit 0 when no
// check failed, 1 otherwise (CM-47).
//
// Timing (OT-05 В4): with PROTOCOL_TIMING_DIR set, one JSON line per run is
// appended to <dir>/node.jsonl; without the variable nothing changes.

const fs = require('node:fs');
const path = require('node:path');
const repository = require('./validator/repository.cjs');
const text = require('./validator/text.cjs');
const governance = require('./validator/governance.cjs');
const gateStructure = require('./validator/gate-structure.cjs');
const platform = require('./validator/platform.cjs');
const ownerWords = require('./validator/owner-words.cjs');

const EXECUTED_CHECKS = ['CM-01', 'CM-02', 'CM-03', 'CM-04', 'CM-05', 'CM-06', 'CM-07',
  'CM-08', 'CM-09', 'CM-10', 'CM-11', 'CM-12', 'CM-13', 'CM-14', 'CM-15', 'CM-16', 'CM-17',
  'CM-18', 'CM-19', 'CM-20', 'CM-21', 'CM-22', 'CM-23', 'CM-24', 'CM-25', 'CM-26', 'CM-27',
  'CM-28', 'CM-29', 'CM-30', 'CM-31', 'CM-32', 'CM-33', 'CM-34', 'CM-35', 'CM-36', 'CM-37',
  'CM-38', 'CM-39', 'CM-40', 'CM-41', 'CM-42', 'CM-43', 'CM-44', 'CM-45', 'CM-46', 'CM-47',
  'CM-70', 'CM-71'];
const NOT_IMPLEMENTED_CHECKS = [];

function validate(root, options = {}) {
  void options; // invocation-local options.env reserved for later sections
  const diagnostics = [];
  const report = (id, status, message, relativePath) => {
    diagnostics.push({ id, status, path: relativePath === undefined ? null : relativePath, message });
  };

  // Check order follows the validator contract map.
  const manifest = repository.loadManifest(root, report);
  const required = manifest.required;
  repository.checkRequiredFiles(root, required, report);

  const paths = [...required];
  const gitState = repository.checkGit(root, paths, report);
  repository.appendWorklogFiles(root, paths);

  const files = repository.collectOwnedTextFiles(root, paths, required, manifest.role, report);
  for (const file of files) {
    text.inspectTextFile(file.full, file.relative, report);
  }
  platform.checkPowerShellSyntax(root, files, report);
  text.reportInspectionSummary(files.length, report);

  text.checkJournalCap(paths, report);
  text.checkReviewCorpusBudget(root, manifest.role, report);
  text.checkLineLimits(root, paths, report);
  const tracked = gitState.gitUsable ? repository.listTrackedFiles(root) : null;
  if (gitState.gitUsable) {
    text.checkEncodingGuard(root, tracked, report,
      { knownEmpty: Array.isArray(tracked), role: manifest.role, required });
  }

  platform.checkClaudeImport(root, report);
  platform.checkClaudeHookWiring(root, report);
  platform.checkNodePresence(root, report);
  platform.checkCodexHookWiring(root, report);
  platform.checkBashPresence(root, report);

  const decisions = governance.checkDecisionBlocks(root, report);
  governance.checkDecisionRegistry(root, manifest.role, gitState.gitUsable, decisions, report);
  const task = governance.checkTaskStatus(root, report);
  gateStructure.checkCompletionGate(root, task, manifest.role, gitState.gitUsable,
    manifest.legacyBoundaryManifest, report);

  platform.checkHooksGloballyOff(root, report);
  platform.checkIgnoreRules(root, gitState.gitUsable, report);
  platform.checkVersionCoherence(root, report);
  platform.checkContentDigests(root, manifest.role, report);
  governance.checkDecisionImmutability(root, gitState.gitUsable, report);
  text.checkJournalAgentLines(root, report);
  // CM-71 (PKG-E): advisory rule-20 check; WARN class only, see validator/owner-words.cjs.
  ownerWords.checkOwnerWords(root, {
    gitUsable: gitState.gitUsable, tracked, journal: manifest.ownerWordsJournal,
  }, report);
  platform.checkInstaller(root, manifest.role, report);

  const counts = { pass: 0, warn: 0, fail: 0 };
  for (const diagnostic of diagnostics) {
    if (diagnostic.status === 'PASS') counts.pass++;
    else if (diagnostic.status === 'WARN') counts.warn++;
    else counts.fail++;
  }
  return {
    diagnostics,
    counts,
    exitCode: counts.fail === 0 ? 0 : 1,
    coverage: { executed: EXECUTED_CHECKS, notImplemented: NOT_IMPLEMENTED_CHECKS },
  };
}

function usageAndFail(argument) {
  process.stderr.write(`unknown argument: ${argument}\n`);
  process.stderr.write('usage: node protocol-validate.cjs [--root <abs>] [--quiet]\n');
  return 1;
}

function main() {
  const startMs = Date.now();
  const startUtc = new Date(startMs).toISOString();
  let root = null;
  let quiet = false;
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--root' && index + 1 < args.length) {
      root = path.resolve(args[++index]);
    } else if (args[index] === '--quiet') {
      quiet = true;
    } else {
      return usageAndFail(args[index]);
    }
  }
  if (root === null) root = path.resolve(__dirname, '..', '..');

  const result = validate(root);

  process.stdout.write('AI Collaboration Protocol - validation\n');
  process.stdout.write(`Root: ${root}\n`);
  for (const diagnostic of result.diagnostics) {
    if (quiet && diagnostic.status === 'PASS') continue;
    process.stdout.write(`[${diagnostic.status}] ${diagnostic.message}\n`);
  }
  if (result.exitCode === 0) {
    process.stdout.write(`Protocol OK. ${result.counts.warn} warning(s).\n`);
  } else {
    process.stdout.write(`Protocol BROKEN. ${result.counts.fail} failure(s), ${result.counts.warn} warning(s).\n`);
  }

  const timingDir = process.env.PROTOCOL_TIMING_DIR;
  if (timingDir) {
    const line = JSON.stringify({
      engine: 'node',
      startUtc,
      durationMs: Date.now() - startMs,
      exitCode: result.exitCode,
      root,
    }) + '\n';
    try {
      fs.appendFileSync(path.join(timingDir, 'node.jsonl'), line, 'utf8');
    } catch {
      // Timing is observational (OT-05 В4); a failure to record it must not
      // change the validation result or its exit code.
    }
  }
  return result.exitCode;
}

if (require.main === module) {
  process.exit(main());
}

module.exports = { validate };

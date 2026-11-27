#!/usr/bin/env node
'use strict';
// The quick author check for an author, before the handoff: the same module the precert gate and the light author
// check run (.ai/bin/lib/author-quick.cjs). Read-only; no heavy run, no receipt.
//   node .ai/bin/ops-tools/author-quick.cjs [WORKTREE] [BASE]
// WORKTREE defaults to the checkout this command belongs to, BASE to origin/ plus the integration branch of the
// manifest of this kernel (never of the candidate).
// One line per fact that refuses or warns (each names the file and the fix), one per part that does not apply, the time
// of each part and the result. Exit: 0 nothing refused, 1 a fact refused, 2 usage.
const fs = require('node:fs');
const path = require('node:path');
const quick = require('../lib/author-quick.cjs');
const KERNEL = path.resolve(__dirname, '..', '..', '..');

function main(argv, deps = {}) {
  const out = deps.out || (s => process.stdout.write(`${s}\n`));
  if (argv.length > 2 || argv.some(a => a.startsWith('-'))) { out('usage: author-quick.cjs [WORKTREE] [BASE]'); return 2; }
  const root = path.resolve(argv[0] || KERNEL);
  let base = argv[1];
  if (!base) {
    let branch = null;
    try { branch = JSON.parse(fs.readFileSync(path.join(KERNEL, 'protocol-manifest.json'), 'utf8')).integrationBranch; } catch { branch = null; }
    if (typeof branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(branch)) { out('AUTHOR-QUICK REFUSED no BASE given and no integration branch in the manifest of this kernel'); return 2; }
    base = `origin/${branch}`;
  }
  let result;
  try { result = (deps.quickFacts || quick.quickFacts)({ root, base }); }
  catch (e) { out(`AUTHOR-QUICK REFUSED ${e.message}`); return 2; }
  for (const line of quick.lines(result)) out(line);
  return result.facts.some(f => !f.ok && f.level !== 'warn') ? 1 : 0;
}

module.exports = { main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

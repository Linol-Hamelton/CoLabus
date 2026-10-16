'use strict';
// A private Git source for dispatch tests that must write repo-relative launches.
const fs = require('node:fs');
const path = require('node:path');
const { tt, git, repoRoot } = require('./helpers.cjs');

function makeSourceFixture(prefix) {
  const root = tt.mkTmp(prefix);
  for (const rel of ['.ai/bin', '.ai/core', '.ai/docs', '.ai/TASK.md', '.ai/PLAN.md', '.ai/DECISIONS.md',
    '.ai/worklog/README.md', 'AGENTS.md', 'protocol-manifest.json', '.gitignore', 'tests/fixtures/dispatch-example', 'docs/ops/metrics']) {
    const dest = path.join(root, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.cpSync(path.join(repoRoot, rel), dest, { recursive: true });
  }
  for (const args of [['init', '-b', 'main'], ['add', '.'], ['commit', '-m', 'Isolated dispatch source']]) {
    const r = git(root, args);
    if (r.status !== 0) throw new Error(`fixture git ${args[0]} failed: ${r.stderr || r.error}`);
  }
  return root;
}

module.exports = { makeSourceFixture };

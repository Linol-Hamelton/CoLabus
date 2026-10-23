'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { repoRoot } = require('./helpers.cjs');

test('PROTOCOL.md defines context digest rules and external tooling policy anchors', () => {
  const protocolPath = path.join(repoRoot, '.ai/docs/PROTOCOL.md');
  const protocolText = fs.readFileSync(protocolPath, 'utf8');

  // Pinned Repomix 1.18.0 command
  assert.match(protocolText, /npx -y repomix"@"1\.18\.0 --include "\.ai\/bin\/\*\*,protocol-test\.cjs,tests\/\*\*" --no-git-sort-by-changes --style xml --output \.ai\/runtime\/kernel-digest\.xml/);

  // Advisory / never auto-injected / never Evidence
  assert.match(protocolText, /never auto-injected/i);
  assert.match(protocolText, /never.*Evidence/i);

  // PROTO-DEC-0170: mandatory minimum serena/codebase-memory/qmd, project-chosen extras, measured per-project budget
  assert.match(protocolText, /PROTO-DEC-0170/);
  assert.match(protocolText, /`serena`, `codebase-memory` and `qmd`/);
  assert.match(protocolText, /chosen per project by the user/i);
  assert.match(protocolText, /measured tool-schema size/i);
  assert.match(protocolText, /docs\/MCP-PROJECT\.md/);
  assert.match(protocolText, /Sealed certifiers receive no MCP/);

  // Unchanged by PROTO-DEC-0170: local-only, sandboxed, pinned; the old fixed cap is gone as a rule
  assert.match(protocolText, /local-only, workspace-sandboxed, version-pinned/);
  assert.match(protocolText, /--sandbox/);
  assert.doesNotMatch(protocolText, /At most one MCP server per adoption phase; total tool-schema budget/);
});

test('AGENTS.md section 7 contains external tooling and MCP advisory pointer sentence', () => {
  const agentsPath = path.join(repoRoot, 'AGENTS.md');
  const agentsText = fs.readFileSync(agentsPath, 'utf8');

  assert.match(agentsText, /External tooling and MCP are optional accelerators; they are advisory, never\s+Evidence or gate inputs; see PROTOCOL\.md/);
});

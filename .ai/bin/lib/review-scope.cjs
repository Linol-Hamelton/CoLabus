'use strict';
// The high-risk paths of PROTO-DEC-0038 item 1: one classification for the completion gate (CM-35 light path) and for
// the audit prompt fact of the precert gate. A changed path is high-risk when it is one of the root protocol files,
// lies under a protected prefix, or has an executable extension. Root files and extensions compare without case,
// prefixes with case, as the completion gate always did.
const path = require('node:path');

const ROOT_FILES = Object.freeze(['AGENTS.md', 'CLAUDE.md', 'protocol-manifest.json', '.ai/bin/protocol-validate.cjs', '.ai/bin/protocol-setup.cjs']);
const PREFIXES = Object.freeze(['.ai/', '.claude/', '.github/', '.codex/', 'tests/', 'templates/', 'docs/decisions/']);
const EXEC_EXTENSIONS = Object.freeze(['.ps1', '.psm1', '.cjs', '.mjs', '.js', '.ts', '.sh', '.bat', '.cmd', '.py']);
const same = (a, b) => a.toLowerCase() === b.toLowerCase();

function isHighRisk(rel) {
  if (typeof rel !== 'string' || !rel) return false;
  if (ROOT_FILES.some(item => same(item, rel))) return true;
  if (PREFIXES.some(prefix => rel.startsWith(prefix))) return true;
  const extension = path.extname(rel).toLowerCase();
  return EXEC_EXTENSIONS.some(item => same(item, extension));
}

module.exports = { ROOT_FILES, PREFIXES, EXEC_EXTENSIONS, isHighRisk };

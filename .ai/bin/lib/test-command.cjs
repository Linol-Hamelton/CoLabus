'use strict';
// Host test-command detection (HOST-TESTCMD). Pure: never runs the command.
// Candidates are listed with the evidence file that produced them; more than
// one is a list, never a guess. The reserved manifest value none records an
// explicit decline so the validator stays quiet and record keeps working.
const fs = require('node:fs');
const path = require('node:path');

const TEST_COMMAND_KEY = 'testCommand';
const NONE = 'none';
const MAX_COMMAND_LENGTH = 400;

function readTextIfExists(full) {
  try { return fs.readFileSync(full, 'utf8'); } catch { return null; }
}

function fileExists(full) {
  try { return fs.statSync(full).isFile(); } catch { return false; }
}

function readJsonObject(full) {
  const text = readTextIfExists(full);
  if (text === null) return null;
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

// The npm init placeholder exits 1 without running tests. A real test script
// may still exit 1 on failure; the placeholder is recognized by its text.
function isNpmPlaceholder(script) {
  if (typeof script !== 'string') return true;
  const s = script.trim();
  if (!s) return true;
  if (/no test specified/i.test(s) && /exit\s+1\b/i.test(s)) return true;
  return false;
}

function packageManagerFor(root) {
  const locks = [
    ['npm', 'package-lock.json'],
    ['pnpm', 'pnpm-lock.yaml'],
    ['yarn', 'yarn.lock'],
    ['bun', 'bun.lock'],
    ['bun', 'bun.lockb'],
  ];
  for (const [manager, lock] of locks) {
    if (fileExists(path.join(root, lock))) return { manager, lock };
  }
  return { manager: 'npm', lock: null };
}

function packageTestCommand(manager) {
  if (manager === 'pnpm') return 'pnpm test';
  if (manager === 'yarn') return 'yarn test';
  // bun test is bun's own runner and ignores scripts.test; run the script.
  if (manager === 'bun') return 'bun run test';
  return 'npm test';
}

// pytest.ini is pytest's own file. pyproject.toml and setup.cfg exist in many
// Python projects that do not use pytest, so they count only when they name it.
function detectPython(root) {
  const pyproject = readTextIfExists(path.join(root, 'pyproject.toml'));
  const setupCfg = readTextIfExists(path.join(root, 'setup.cfg'));
  let evidence = null;
  if (fileExists(path.join(root, 'pytest.ini'))) evidence = 'pytest.ini';
  else if (pyproject !== null && /\bpytest\b/i.test(pyproject)) evidence = 'pyproject.toml';
  else if (setupCfg !== null && /\bpytest\b/i.test(setupCfg)) evidence = 'setup.cfg';
  if (!evidence) return null;
  return { command: 'pytest', evidence, kind: 'pytest' };
}

function detectFlutter(root) {
  const full = path.join(root, 'pubspec.yaml');
  if (!fileExists(full)) return null;
  const text = readTextIfExists(full) || '';
  const dependsOnFlutter = /(^|\n)\s*flutter\s*:/.test(text) || /sdk:\s*flutter/.test(text);
  return dependsOnFlutter
    ? { command: 'flutter test', evidence: 'pubspec.yaml', kind: 'flutter' }
    : { command: 'dart test', evidence: 'pubspec.yaml', kind: 'dart' };
}

function detectNode(root) {
  const pkg = readJsonObject(path.join(root, 'package.json'));
  if (!pkg) return null;
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return null;
  if (isNpmPlaceholder(scripts.test)) return null;
  const { manager, lock } = packageManagerFor(root);
  const detail = lock ? 'scripts.test via ' + lock : 'scripts.test';
  return { command: packageTestCommand(manager), evidence: 'package.json', kind: 'node', detail };
}

function detectCargo(root) {
  return fileExists(path.join(root, 'Cargo.toml'))
    ? { command: 'cargo test', evidence: 'Cargo.toml', kind: 'cargo' } : null;
}

function detectGo(root) {
  return fileExists(path.join(root, 'go.mod'))
    ? { command: 'go test ./...', evidence: 'go.mod', kind: 'go' } : null;
}

function detectDotnet(root) {
  let names = [];
  try { names = fs.readdirSync(root).sort(); } catch { return null; }
  const sln = names.find(name => name.toLowerCase().endsWith('.sln'));
  const csproj = names.find(name => name.toLowerCase().endsWith('.csproj'));
  if (sln) return { command: 'dotnet test', evidence: sln, kind: 'dotnet' };
  if (csproj) return { command: 'dotnet test', evidence: csproj, kind: 'dotnet' };
  return null;
}

function detectComposer(root) {
  const pkg = readJsonObject(path.join(root, 'composer.json'));
  if (!pkg) return null;
  const scripts = pkg.scripts;
  if (!scripts || typeof scripts !== 'object' || Array.isArray(scripts)) return null;
  const test = scripts.test;
  const real = typeof test === 'string' ? test.trim() !== ''
    : Array.isArray(test) && test.some(step => typeof step === 'string' && step.trim() !== '');
  if (!real) return null;
  return { command: 'composer test', evidence: 'composer.json', kind: 'composer' };
}

function detectMakefile(root) {
  const name = ['Makefile', 'makefile', 'GNUmakefile'].find(n => fileExists(path.join(root, n)));
  if (!name) return null;
  const text = readTextIfExists(path.join(root, name)) || '';
  if (!/^test\s*:(\s|$)/m.test(text)) return null;
  return { command: 'make test', evidence: name, kind: 'make' };
}

const DETECTORS = [
  detectNode,
  detectPython,
  detectFlutter,
  detectCargo,
  detectGo,
  detectDotnet,
  detectComposer,
  detectMakefile,
];

function detectTestCommand(root) {
  const candidates = [];
  for (const detect of DETECTORS) {
    const hit = detect(root);
    if (!hit) continue;
    const key = hit.command + '|' + hit.evidence;
    if (candidates.some(c => c.command + '|' + c.evidence === key)) continue;
    candidates.push(hit);
  }
  return candidates;
}

function formatCandidate(c) {
  const detail = c.detail ? ' (' + c.detail + ')' : '';
  return c.command + '  [evidence: ' + c.evidence + detail + ']';
}

function formatProposal(candidates) {
  if (candidates.length === 0) {
    return 'No host test command candidate detected.';
  }
  if (candidates.length === 1) {
    return 'Proposed testCommand: ' + formatCandidate(candidates[0]);
  }
  const lines = candidates.map(c => '  - ' + formatCandidate(c));
  return 'Multiple test command candidates; choose one explicitly:\n' + lines.join('\n');
}

// A literal command is stored and later run through a shell by record: one
// line, no control characters, bounded length.
function checkLiteral(raw) {
  if (raw.length > MAX_COMMAND_LENGTH) {
    return 'Literal test command is longer than ' + MAX_COMMAND_LENGTH + ' characters.';
  }
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    return 'Literal test command must be one line without control characters.';
  }
  return null;
}

function resolveChoice(candidates, choice) {
  if (choice === null || choice === undefined || String(choice).trim() === '') {
    return { ok: false, message: 'Choice required: auto, none, or a literal command.' };
  }
  const raw = String(choice).trim();
  if (raw.toLowerCase() === 'none') {
    return { ok: true, command: NONE };
  }
  if (raw.toLowerCase() === 'auto') {
    if (candidates.length === 0) {
      return { ok: false, message: 'auto: no test command candidate detected.' };
    }
    if (candidates.length > 1) {
      const lines = candidates.map(c => '  - ' + formatCandidate(c));
      return { ok: false, message: 'auto: ' + candidates.length + ' candidates; choose one explicitly:\n' + lines.join('\n') };
    }
    return { ok: true, command: candidates[0].command };
  }
  const bad = checkLiteral(raw);
  if (bad) return { ok: false, message: bad };
  return { ok: true, command: raw };
}

// The interactive answer of the installer. Enter or no skips and writes
// nothing; yes accepts only a single proposal; a number picks one of a list.
function interpretAnswer(candidates, answer) {
  const raw = String(answer === null || answer === undefined ? '' : answer).trim();
  if (raw === '' || /^(n|no|skip)$/i.test(raw)) return { ok: true, skip: true };
  if (/^(y|yes)$/i.test(raw)) {
    if (candidates.length !== 1) {
      return { ok: false, message: 'yes is only valid for a single proposal; pick a number, none or a literal command.' };
    }
    return { ok: true, command: candidates[0].command };
  }
  if (/^[0-9]+$/.test(raw)) {
    const index = Number(raw);
    if (index < 1 || index > candidates.length) {
      return { ok: false, message: 'No candidate number ' + raw + '.' };
    }
    return { ok: true, command: candidates[index - 1].command };
  }
  return resolveChoice(candidates, raw);
}

function isNoneValue(value) {
  return typeof value === 'string' && value.trim().toLowerCase() === NONE;
}

function hasRunnableCommand(manifest) {
  if (!manifest || typeof manifest !== 'object') return false;
  const value = manifest[TEST_COMMAND_KEY];
  return typeof value === 'string' && value.trim() !== '' && !isNoneValue(value);
}

function hasRecordedNone(manifest) {
  if (!manifest || typeof manifest !== 'object') return false;
  return isNoneValue(manifest[TEST_COMMAND_KEY]);
}

// Byte-preserving edit of the top level of a JSON object text: returns the
// members with the extent of each key and value so only the testCommand
// member is replaced or appended and every other byte stays as it was.
function topLevelMembers(text) {
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\r\n'.includes(text[i])) i++; };
  const str = () => {
    const start = i;
    i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i++;
    return start;
  };
  const value = () => {
    const start = i;
    if (text[i] === '"') { str(); return start; }
    if (text[i] === '{' || text[i] === '[') {
      let depth = 0;
      while (i < text.length) {
        const ch = text[i];
        if (ch === '"') { str(); continue; }
        if (ch === '{' || ch === '[') depth++;
        if (ch === '}' || ch === ']') { depth--; if (depth === 0) { i++; break; } }
        i++;
      }
      return start;
    }
    while (i < text.length && !',}] \t\r\n'.includes(text[i])) i++;
    return start;
  };
  ws();
  const open = i;
  i++;
  const members = [];
  for (;;) {
    ws();
    if (text[i] === '}') return { open, close: i, members };
    const keyStart = i;
    const keyEnd = (str(), i);
    const key = JSON.parse(text.slice(keyStart, keyEnd));
    ws();
    i++;
    ws();
    const valueStart = value();
    members.push({ key, keyStart, valueStart, valueEnd: i });
    ws();
    if (text[i] === ',') i++;
  }
}

function editManifestText(text, command) {
  const literal = JSON.stringify(String(command));
  const { open, close, members } = topLevelMembers(text);
  const existing = members.filter(m => m.key === TEST_COMMAND_KEY).pop();
  if (existing) {
    return text.slice(0, existing.valueStart) + literal + text.slice(existing.valueEnd);
  }
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (members.length === 0) {
    return text.slice(0, open + 1) + eol + '  "' + TEST_COMMAND_KEY + '": ' + literal + eol + text.slice(close);
  }
  const last = members[members.length - 1];
  const lineStart = text.lastIndexOf('\n', last.keyStart) + 1;
  const indent = /^[ \t]*$/.test(text.slice(lineStart, last.keyStart)) ? text.slice(lineStart, last.keyStart) : '  ';
  return text.slice(0, last.valueEnd) + ',' + eol + indent + '"' + TEST_COMMAND_KEY + '": ' + literal + text.slice(last.valueEnd);
}

function writeManifestTestCommand(manifestPath, command) {
  if (command === null || command === undefined || String(command).trim() === '') {
    throw new Error('testCommand must not be empty; use none to record a decline.');
  }
  const raw = fs.readFileSync(manifestPath);
  if (raw.length >= 3 && raw[0] === 0xEF && raw[1] === 0xBB && raw[2] === 0xBF) {
    throw new Error('protocol-manifest.json must not have a BOM: ' + manifestPath);
  }
  const text = raw.toString('utf8');
  let before;
  try { before = JSON.parse(text); } catch (error) {
    throw new Error('protocol-manifest.json is not valid JSON: ' + error.message);
  }
  if (!before || typeof before !== 'object' || Array.isArray(before)) {
    throw new Error('protocol-manifest.json must be a JSON object.');
  }
  const out = editManifestText(text, command);
  // The edit must change nothing but the one member.
  let after;
  try { after = JSON.parse(out); } catch { throw new Error('manifest edit produced invalid JSON; nothing written.'); }
  const expected = { ...before, [TEST_COMMAND_KEY]: String(command) };
  if (JSON.stringify(Object.entries(after).filter(([k]) => k !== TEST_COMMAND_KEY))
      !== JSON.stringify(Object.entries(expected).filter(([k]) => k !== TEST_COMMAND_KEY))
      || after[TEST_COMMAND_KEY] !== String(command)) {
    throw new Error('manifest edit would change other fields; nothing written.');
  }
  fs.writeFileSync(manifestPath, Buffer.from(out, 'utf8'));
  return out;
}

function setCommandLine(choice) {
  return 'node .ai/bin/protocol-setup.cjs --set-test-command "' + String(choice).trim() + '"';
}

function warnMessage(candidates) {
  if (candidates.length === 1) {
    const c = candidates[0];
    return 'CM-75 host testCommand is not set; detected ' + c.command + ' from ' + c.evidence
      + '; set it with: ' + setCommandLine(c.command) + ' (or --set-test-command "none" to record a decline)';
  }
  const list = candidates.map(c => formatCandidate(c)).join('; ');
  return 'CM-75 host testCommand is not set; ' + candidates.length + ' candidates: ' + list
    + '; set exactly one: ' + candidates.map(c => setCommandLine(c.command)).join(' | ')
    + ' (or --set-test-command "none" to record a decline)';
}

module.exports = {
  TEST_COMMAND_KEY,
  NONE,
  detectTestCommand,
  formatCandidate,
  formatProposal,
  resolveChoice,
  interpretAnswer,
  isNoneValue,
  hasRunnableCommand,
  hasRecordedNone,
  writeManifestTestCommand,
  setCommandLine,
  warnMessage,
  isNpmPlaceholder,
  packageManagerFor,
};

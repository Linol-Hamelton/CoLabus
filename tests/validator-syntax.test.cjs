'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeCli = path.join(__dirname, '..', '.ai', 'bin', 'protocol-validate.cjs');
const { repoRoot, makeFixture, makeProtocolFixture, seedProtocol, runPowerShell, run, write, windowsPowerShellSkip } = require('./helpers.cjs');

const { validate: validateApi } = require('../.ai/bin/protocol-validate.cjs');

function validate(root, options = {}) {
  const result = validateApi(root, options);
  const outLines = [
    'AI Collaboration Protocol - validation',
    `Root: ${root}`,
  ];
  for (const diag of result.diagnostics) {
    outLines.push(`[${diag.status}] ${diag.message}`);
  }
  if (result.exitCode === 0) {
    outLines.push(`Protocol OK. ${result.counts.warn} warning(s).`);
  } else {
    outLines.push(`Protocol BROKEN. ${result.counts.fail} failure(s), ${result.counts.warn} warning(s).`);
  }
  const text = outLines.join('\n') + '\n';
  return { status: result.exitCode, output: text };
}

function succeeds(root) {
  const result = validate(root);
  assert.equal(result.status, 0, result.output);
  return result.output;
}

function fails(root, expected) {
  const result = validate(root);
  assert.equal(result.status, 1, result.output);
  assert.match(result.output, expected);
  return result.output;
}

test('encoding checks ignore scratch files but include tracked ignored files', t => {
  const root = makeProtocolFixture(t);
  write(root, '.ai/scratch/thirdparty.ps1', '# non-ASCII: é\r\n');
  write(root, '.git/internal.md', Buffer.from([0xc3, 0x28]));
  succeeds(root);
  const { git } = require('./helpers.cjs');
  const add = git(root, ['add', '-f', '.ai/scratch/thirdparty.ps1']);
  assert.equal(add.status, 0, add.stderr);
  fails(root, /non-ASCII byte in PowerShell script: \.ai\/scratch\/thirdparty\.ps1/);
});

test('untracked Unicode and literal wildcard filenames are checked as paths', t => {
  const root = makeProtocolFixture(t);
  const filename = '.ai/документ с пробелами [draft].md';
  write(root, filename, Buffer.from([0xc3, 0x28]));
  fails(root, /invalid UTF-8: \.ai\/документ с пробелами \[draft\]\.md/);
  write(root, filename, 'Корректный UTF-8.\n');
  succeeds(root);
});

test('BOM, malformed UTF-8 and CRLF fail independently on every platform', t => {
  const root = makeProtocolFixture(t);
  write(root, '.ai/bom.md', Buffer.from([0xef, 0xbb, 0xbf, 0x61, 10]));
  write(root, '.ai/badutf8.md', Buffer.from([0xc0, 0xaf]));
  write(root, '.ai/utf16.md', Buffer.from([0xff, 0xfe, 0x41, 0]));
  write(root, '.ai/notes.yml', 'root = true\r\n');
  write(root, '.ai/custom.cjs', 'module.exports = {};\r\n');
  write(root, '.ai/pipeline.yml', 'name: test\r\n');

  const output = fails(root, /byte order mark present: \.ai\/bom\.md/);
  assert.match(output, /invalid UTF-8: \.ai\/badutf8\.md/);
  assert.match(output, /invalid UTF-8: \.ai\/utf16\.md/);
  assert.match(output, /CR\/CRLF found.*\.ai\/notes\.yml/);
  assert.match(output, /CR\/CRLF found.*\.ai\/custom\.cjs/);
  assert.match(output, /CR\/CRLF found.*\.ai\/pipeline\.yml/);
});

test('PowerShell syntax fails on Windows', { skip: windowsPowerShellSkip() }, t => {
  const root = makeProtocolFixture(t);
  write(root, '.ai/broken.ps1', 'if (\n');
  fails(root, /PowerShell syntax in \.ai\/broken\.ps1/);
});

test('Linux and macOS CM-20 skip names the reason and never launches PowerShell', () => {
  const { checkPowerShellSyntax } = require('../.ai/bin/validator/platform.cjs');
  for (const platform of ['linux', 'darwin']) {
    const diagnostics = [];
    checkPowerShellSyntax(repoRoot, [{ relative: 'probe.ps1' }], (...d) => diagnostics.push(d), {
      platform, invokeExternal() { assert.fail('PowerShell must not start off Windows'); },
    });
    assert.deepEqual(diagnostics, [['CM-20', 'SKIP', `platform=${platform} reason=powershell-only-check check=CM-20 files=1`]]);
    assert.equal(windowsPowerShellSkip(platform), `platform=${platform} reason=powershell-only-check`);
  }
  assert.equal(windowsPowerShellSkip('win32'), false, 'Windows checks cannot silently skip for a missing host');
});

test('Linux validation retains encoding checks and does not render BROKEN for skipped CM-20', t => {
  const root = makeProtocolFixture(t);
  write(root, '.ai/broken.ps1', 'if (\n');
  const result = validateApi(root, { platform: 'linux' });
  assert.equal(result.exitCode, 0, JSON.stringify(result.diagnostics.filter(d => d.status === 'FAIL')));
  assert.equal(result.counts.skip, 1);
  assert.equal(result.counts.fail, 0);
  const rendered = validate(root, { platform: 'linux' });
  assert.match(rendered.output, /\[SKIP\] platform=linux reason=powershell-only-check check=CM-20/);
  assert.match(rendered.output, /Protocol OK\./);
  assert.doesNotMatch(rendered.output, /Protocol BROKEN|spawnSync pwsh/);
  write(root, '.ai/broken.ps1', '# non-ASCII: \u00e9\n');
  const invalid = validateApi(root, { platform: 'linux' });
  assert.equal(invalid.exitCode, 1, 'a parser skip cannot hide PowerShell encoding defects');
  assert.ok(invalid.diagnostics.some(d => d.status === 'FAIL' && /non-ASCII/.test(d.message)));
});

test('Windows CM-20 still fails closed when its parser is missing or rejects a script', () => {
  const { checkPowerShellSyntax } = require('../.ai/bin/validator/platform.cjs');
  for (const [parsed, expected] of [
    [{ code: -1, output: '', error: 'spawnSync powershell.exe ENOENT' }, 'PowerShell cannot check script syntax: spawnSync powershell.exe ENOENT'],
    [{ code: 0, output: 'probe.ps1\x1fsyntax-error\n', error: '' }, 'PowerShell syntax in probe.ps1: syntax-error'],
  ]) {
    const diagnostics = [], calls = [];
    checkPowerShellSyntax(repoRoot, [{ relative: 'probe.ps1' }], (...d) => diagnostics.push(d), {
      platform: 'win32', invokeExternal(...args) { calls.push(args); return parsed; },
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0][0], /powershell\.exe$/i);
    assert.deepEqual(calls[0][1].slice(0, 3), ['-NoProfile', '-NonInteractive', '-EncodedCommand']);
    assert.equal(diagnostics[0][0], 'CM-20');
    assert.equal(diagnostics[0][1], 'FAIL');
    assert.equal(diagnostics[0][2], expected);
  }
});

test('malformed settings, wrong commands, missing files and fake imports fail', t => {
  const root = makeProtocolFixture(t);
  const settingsPath = path.join(root, '.claude/settings.json');
  const original = fs.readFileSync(settingsPath, 'utf8');
  write(root, '.claude/settings.json', '{broken\n');
  fails(root, /invalid Claude settings JSON/);
  const settings = JSON.parse(original);
  settings.hooks.Stop[0].hooks[0].command = 'echo .claude/hooks/stop-worklog-check.sh';
  write(root, '.claude/settings.json', JSON.stringify(settings) + '\n');
  fails(root, /Stop must configure exactly one canonical protocol hook command/);
  write(root, '.claude/settings.json', original);
  write(root, 'CLAUDE.md', 'Do not mistake this mention of @AGENTS.md for an import.\n');
  fails(root, /must import @AGENTS\.md on its own line/);
  fs.unlinkSync(path.join(root, '.claude/hooks/protocol-hooks.cjs'));
  fails(root, /missing file: \.claude\/hooks\/protocol-hooks\.cjs/);
});

test('a deleted installer fails validation instead of skipping its self-check', t => {
  const root = makeProtocolFixture(t);
  fs.rmSync(path.join(root, '.ai/bin/protocol-setup.cjs'));
  const output = fails(root, /missing file: \.ai[\\/]bin[\\/]protocol-setup\.cjs/);
  assert.match(output, /installer absent/);
});

test('every runtime entrypoint is required, not only the validator', t => {
  for (const entrypoint of ['.ai/bin/protocol-lock.cjs',
    '.ai/bin/protocol-handoff.cjs', '.ai/docs/PROTOCOL.md']) {
    const root = makeProtocolFixture(t);
    fs.rmSync(path.join(root, entrypoint));
    fails(root, new RegExp('missing file: ' + entrypoint));
  }
});

test('globally disabled hooks fail validation in both settings files', t => {
  for (const name of ['.claude/settings.json', '.claude/settings.local.json']) {
    const root = makeProtocolFixture(t);
    const file = path.join(root, name);
    const settings = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    settings.disableAllHooks = true;
    write(root, name, JSON.stringify(settings, null, 2) + '\n');
    fails(root, /disableAllHooks; protocol enforcement is off/);
  }
});

test('ignore rules cancelled by a later negation fail validation', t => {
  const root = makeProtocolFixture(t);
  const current = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
  write(root, '.gitignore', `${current}\n!.ai/runtime/\n!.ai/runtime/**\n`);
  fails(root, /Git does not ignore \.ai\/runtime/);
});

test('hooks left enabled and ignore rules intact still validate', t => {
  const root = makeProtocolFixture(t);
  succeeds(root);
});

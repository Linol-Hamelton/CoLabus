'use strict';

// P3 Node validator engine, platform module (OT-05 section В5 step 4).
// Implements CM-25..CM-29, CM-40..CM-43, CM-46 and CM-20 one to one, per the contract map
// :
//   CM-25 CLAUDE.md import            (:318-323 region, checkClaudeImport)
//   CM-26 Claude hook wiring          (checkClaudeHookWiring)
//   CM-27 Node presence + hook syntax (checkNodePresence)
//   CM-28 Codex hook wiring           (checkCodexHookWiring)
//   CM-29 Bash presence + wrappers     (checkBashPresence)
//   CM-40 hooks globally off          (checkHooksGloballyOff)
//   CM-41 ignore-rule probes          (checkIgnoreRules)
//   CM-42 version coherence           (checkVersionCoherence)
//   CM-43 installed content digests   (checkContentDigests)
//   CM-46 installer presence + self-check (checkInstaller)
//   CM-20 PowerShell script syntax (checkPowerShellSyntax; В5 step 5)
// CM-23, CM-44 and CM-45 live in the text and governance modules (В5 step 5).
// The module emits diagnostics through the caller's report() callback and never
// prints, never mutates the tree and keeps no state (final-plan-2 section J).
// The entry owns check order and rendering.
//
// Porting notes, kept next to the code they concern:
// - PowerShell -eq/-in/-contains are case-insensitive, -ceq/-cin are
//   case-sensitive; each operator is reproduced where the .ps1 uses it.
// - Get-Command -CommandType Application is reproduced by scanning PATH
//   directories in order with the PATHEXT extension list (resolveCommand).
// - Windows PowerShell 5.1 Join-Path normalizes the child's separators to
//   backslashes (measured on the host of record, 5.1.26100.9444:
//   Join-Path 'C:\Program Files\Git' 'bin/bash.exe' -> 'C:\Program
//   Files\Git\bin\bash.exe'), so node's path.join builds byte-identical
//   candidate strings on win32; the printed "Bash available:" line must
//   match the .ps1 byte for byte.
// - CM-42 hashtable enumeration: measured insertion order on the PS 5.1
//   host of record (AGENTS.md before .ai/bin/protocol-setup.cjs); .NET does
//   not guarantee it, and this order is reproduced here.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function isFile(full) {
  try { return fs.statSync(full).isFile(); } catch { return false; }
}

function caseInsensitiveEquals(a, b) {
  return a === b || (typeof a === 'string' && typeof b === 'string' &&
    a.toLowerCase() === b.toLowerCase());
}

// Invoke-External: run a subprocess, capture stdout/stderr as UTF-8, and
// return { code, output, error }. A start failure becomes code -1 with the
// message in error, exactly as the .ps1 catch block does.
function invokeExternal(executable, args, root) {
  let result;
  try {
    result = spawnSync(executable, args, {
      cwd: root, windowsHide: true, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
    });
  } catch (error) {
    return { code: -1, output: '', error: String(error.message) };
  }
  if (result.error) return { code: -1, output: '', error: String(result.error.message) };
  return {
    code: result.status === null ? -1 : result.status,
    output: result.stdout === undefined ? '' : result.stdout,
    error: result.stderr === undefined ? '' : result.stderr,
  };
}

// Read-ProtocolText: strict UTF-8 read; a failure is reported and yields null.
function readProtocolText(full, cmId, report) {
  try {
    return strictUtf8.decode(fs.readFileSync(full));
  } catch {
    report(cmId, 'FAIL', `cannot read UTF-8 text: ${full}`);
    return null;
  }
}

// Get-Command <name> -CommandType Application: first match on PATH, applying
// the PATHEXT extensions per directory. Returns the resolved path or null.
function resolveCommand(name) {
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.MSC')
      .split(';').filter(Boolean).map(item => item.toLowerCase())
    : [''];
  const directories = (process.env.PATH || '').split(path.delimiter);
  for (const directory of directories) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension);
      try {
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch { /* not present */ }
    }
  }
  return null;
}

// Select-Object -Unique: case-insensitive dedupe keeping the first item.
function uniqueCaseInsensitive(values) {
  const seen = new Set();
  const out = [];
  for (const value of values) {
    const key = value.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

// The manifest is parsed again here, silently: the repository module already
// reported read/parse failures, and the .ps1 skips these checks when its
// $manifest is null. Reads use UTF-8 (repository.cjs porting note applies).
function loadManifestObject(root) {
  try {
    return JSON.parse(fs.readFileSync(path.join(root, 'protocol-manifest.json'), 'utf8'));
  } catch {
    return null;
  }
}

// PowerShell -eq $true semantics for the values ConvertFrom-Json can yield:
// true, the number 1 (bool coerces to int) or a string equal to "True".
function isPsEqTrue(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string' && value.toLowerCase() === 'true') return true;
  return false;
}

// CM-25: CLAUDE.md must import @AGENTS.md on its own line.
function checkClaudeImport(root, report) {
  const claudePath = path.join(root, 'CLAUDE.md');
  if (!isFile(claudePath)) return;
  const claudeText = readProtocolText(claudePath, 'CM-25', report);
  if (/^@(?:\.\/)?AGENTS\.md[ \t]*$/m.test(claudeText === null ? '' : claudeText)) {
    report('CM-25', 'PASS', 'CLAUDE.md imports AGENTS.md');
  } else {
    report('CM-25', 'FAIL', 'CLAUDE.md must import @AGENTS.md on its own line');
  }
}

// PS ConvertFrom-Json pipeline semantics: piping $null or an empty string
// yields $null WITHOUT a terminating error (measured, PS 5.1 host of
// record); only a real parse error reaches the caller's catch block.
function parseSettingsJson(text) {
  if (text === null || text.trim() === '') return null;
  return JSON.parse(text);
}

// CM-26: .claude/settings.json must configure exactly one canonical command
// hook for SessionStart and Stop. The expected command is byte-exact.
function claudeExpectedCommand(wrapper) {
  return 'r="$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --show-toplevel 2>/dev/null)"'
    + ' && [ -f "$r/.claude/hooks/' + wrapper + '" ]'
    + ' && bash "$r/.claude/hooks/' + wrapper + '" || true';
}

// Replicates `$settings.hooks.$event | ForEach { $_.hooks }`: a missing group
// list yields one null element, each group's hooks flattens one level, and a
// group without a hooks property yields a null element.
function flattenHookCommands(groups) {
  const elements = groups === null || groups === undefined ? [null] :
    (Array.isArray(groups) ? groups : [groups]);
  const out = [];
  for (const element of elements) {
    const hooks = element === null || element === undefined ? null : element.hooks;
    if (Array.isArray(hooks)) out.push(...hooks);
    else out.push(hooks);
  }
  return out;
}

function checkClaudeHookWiring(root, report) {
  const settingsPath = path.join(root, '.claude', 'settings.json');
  if (!isFile(settingsPath)) return;
  let settings;
  try {
    settings = parseSettingsJson(readProtocolText(settingsPath, 'CM-26', report));
  } catch (error) {
    report('CM-26', 'FAIL', `invalid Claude settings JSON: ${error.message}`);
    return;
  }
  for (const event of ['SessionStart', 'Stop']) {
    const wrapper = event === 'SessionStart' ? 'session-start.sh' : 'stop-worklog-check.sh';
    const expected = claudeExpectedCommand(wrapper);
    const groups = settings === null || typeof settings !== 'object' || settings.hooks === undefined
      ? null : settings.hooks[event];
    const matching = flattenHookCommands(groups).filter(hook =>
      hook !== null && hook !== undefined &&
      caseInsensitiveEquals(String(hook.type), 'command') &&
      hook.command === expected);
    if (matching.length === 1) {
      report('CM-26', 'PASS', `${event} protocol hook command configured`);
    } else {
      report('CM-26', 'FAIL', `${event} must configure exactly one canonical protocol hook command`);
    }
  }
}

// CM-27: Node on PATH, runs, and the three hook modules parse.
function checkNodePresence(root, report) {
  const nodeCommand = resolveCommand('node');
  if (!nodeCommand) {
    report('CM-27', 'FAIL', 'node is unavailable; protocol hooks require Node.js on PATH');
    return;
  }
  const nodeVersion = invokeExternal(nodeCommand, ['--version'], root);
  if (nodeVersion.code !== 0) {
    report('CM-27', 'FAIL', 'Node.js cannot run');
    return;
  }
  report('CM-27', 'PASS', `Node.js available: ${nodeVersion.output.trim()}`);
  for (const relativeModule of ['.ai/bin/protocol-hooks.cjs',
    '.claude/hooks/protocol-hooks.cjs', '.codex/hooks/protocol.cjs']) {
    const engine = path.join(root, relativeModule);
    if (!isFile(engine)) continue;
    const syntax = invokeExternal(nodeCommand, ['--check', engine], root);
    if (syntax.code !== 0) {
      report('CM-27', 'FAIL', `hook module syntax: ${syntax.error.trim()}`);
    } else {
      report('CM-27', 'PASS', `hook module JavaScript syntax: ${relativeModule}`);
    }
  }
}

// CM-28: .codex/hooks.json must configure exactly one canonical command per
// event, with matcher */.*, no execution overrides and timeout 30.
const CODEX_EXPECTED = 'node -e "require(require(\'node:path\').join('
  + 'require(\'node:child_process\').execFileSync(\'git\',[\'rev-parse\','
  + '\'--show-toplevel\'],{encoding:\'utf8\',windowsHide:true}).trim(),'
  + '\'.codex/hooks/protocol.cjs\')).main()"';

function checkCodexHookWiring(root, report) {
  const codexSettingsPath = path.join(root, '.codex', 'hooks.json');
  if (!isFile(codexSettingsPath)) return;
  let codexSettings;
  try {
    codexSettings = parseSettingsJson(readProtocolText(codexSettingsPath, 'CM-28', report));
  } catch (error) {
    report('CM-28', 'FAIL', `invalid Codex hooks: ${error.message}`);
    return;
  }
  try {
    for (const event of ['SessionStart', 'Stop']) {
      const groups = codexSettings === null || typeof codexSettings !== 'object' ||
        codexSettings.hooks === undefined ? null : codexSettings.hooks[event];
      const groupList = groups === null || groups === undefined ? [] :
        (Array.isArray(groups) ? groups : [groups]);
      const matching = [];
      for (const group of groupList) {
        const handlers = group === null || group === undefined || group.hooks === undefined
          ? [] : (Array.isArray(group.hooks) ? group.hooks : [group.hooks]);
        for (const handler of handlers) {
          if (handler === null || handler === undefined) continue;
          if (caseInsensitiveEquals(String(handler.type), 'command') &&
              handler.command === CODEX_EXPECTED) {
            matching.push(handler);
            if (group.matcher && !['*', '.*'].some(item =>
                caseInsensitiveEquals(item, group.matcher))) {
              throw new Error(`${event} protocol hook must match all sources, including resume and compact`);
            }
            if (handler.commandWindows || handler.command_windows ||
                isPsEqTrue(handler.async) || handler.timeout !== 30) {
              throw new Error(`${event} protocol hook has unsupported execution overrides`);
            }
          }
        }
      }
      if (matching.length !== 1) {
        throw new Error(`${event} must configure exactly one canonical Codex protocol hook command`);
      }
      report('CM-28', 'PASS', `Codex ${event} protocol hook configured (host trust checked separately)`);
    }
  } catch (error) {
    report('CM-28', 'FAIL', `invalid Codex hooks: ${error.message}`);
  }
}

// CM-29: a working GNU Bash (Git-Bash preferred) and syntactically valid
// hook wrappers. On Windows, candidate paths derive from the Git command
// location (bin/bash.exe and usr/bin/bash.exe, normalized via path.join),
// followed by a PATH lookup. Porting note: the original .ps1 derived the same
// candidates through Join-Path on the Windows PowerShell 5.1 host of record.
function checkBashPresence(root, report) {
  const candidates = [];
  const gitCommand = resolveCommand('git');
  if (process.platform === 'win32' && gitCommand) {
    const gitDirectory = path.dirname(gitCommand);
    const gitBase = path.dirname(gitDirectory);
    candidates.push(path.join(gitBase, 'bin/bash.exe'), path.join(gitBase, 'usr/bin/bash.exe'));
  }
  const bashCommand = resolveCommand('bash');
  if (bashCommand) candidates.push(bashCommand);
  let bashExecutable = null;
  for (const candidate of uniqueCaseInsensitive(candidates)) {
    if (!isFile(candidate)) continue;
    const bashVersion = invokeExternal(candidate, ['--version'], root);
    if (bashVersion.code === 0 && /GNU bash/i.test(bashVersion.output)) {
      bashExecutable = candidate;
      break;
    }
  }
  if (!bashExecutable) {
    report('CM-29', 'FAIL', 'working Bash unavailable; install Git Bash and configure Claude to use it');
    return;
  }
  report('CM-29', 'PASS', `Bash available: ${bashExecutable}`);
  for (const wrapper of ['session-start.sh', 'stop-worklog-check.sh']) {
    const wrapperPath = path.join(root, '.claude', 'hooks', wrapper);
    if (!isFile(wrapperPath)) continue;
    const syntax = invokeExternal(bashExecutable, ['-n', wrapperPath.split('\\').join('/')], root);
    if (syntax.code !== 0) {
      report('CM-29', 'FAIL', `hook shell syntax in ${wrapper}: ${syntax.error.trim()}`);
    } else {
      report('CM-29', 'PASS', `hook shell syntax: ${wrapper}`);
    }
  }
}

// CM-40: disableAllHooks in either Claude settings file fails validation.
function checkHooksGloballyOff(root, report) {
  for (const settingsName of ['.claude/settings.json', '.claude/settings.local.json']) {
    const settingsFile = path.join(root, settingsName);
    if (!isFile(settingsFile)) continue;
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    } catch {
      continue; // the .ps1 silently skips unparseable settings here
    }
    if (parsed === null || typeof parsed !== 'object') continue;
    if (Object.prototype.hasOwnProperty.call(parsed, 'disableAllHooks') &&
        isPsEqTrue(parsed.disableAllHooks)) {
      report('CM-40', 'FAIL',
        `${settingsName} sets disableAllHooks; protocol enforcement is off while this check would otherwise pass`);
    }
  }
}

// CM-41: ask Git what it ignores; the probe paths must be ignored.
function checkIgnoreRules(root, gitUsable, report) {
  const gitCommand = resolveCommand('git');
  if (!gitCommand || !gitUsable) return;
  for (const probe of ['.ai/runtime/shared-writer.json', '.claude/settings.local.json',
    '.ai/scratch/probe.txt']) {
    const ignored = invokeExternal(gitCommand, ['-C', root, 'check-ignore', '-q', '--no-index', probe], root);
    if (ignored.code === 0) continue;
    if (ignored.code === 1) {
      report('CM-41', 'FAIL', `Git does not ignore ${probe}; session state can reach a commit`);
    } else {
      report('CM-41', 'WARN', `cannot determine the ignore rule for ${probe}`);
    }
  }
}

// CM-42: one protocol version in manifest, AGENTS.md and the installer.
function checkVersionCoherence(root, report) {
  const manifest = loadManifestObject(root);
  if (!manifest || manifest.protocolVersion === undefined) return;
  const declared = String(manifest.protocolVersion);
  const sources = new Map();
  const agentsPath = path.join(root, 'AGENTS.md');
  if (isFile(agentsPath)) {
    const text = readProtocolText(agentsPath, 'CM-42', report);
    const found = text === null ? null :
      /^##\s+AI Collaboration Protocol\s+v(\S+)\s*$/m.exec(text);
    if (found) sources.set('AGENTS.md', found[1]);
  }
  const installerPathForVersion = path.join(root, '.ai', 'bin', 'protocol-setup.cjs');
  if (isFile(installerPathForVersion)) {
    const text = readProtocolText(installerPathForVersion, 'CM-42', report);
    const found = text === null ? null : /protocol v(\d+\.\d+\.\d+)/.exec(text);
    if (found) sources.set('.ai/bin/protocol-setup.cjs', found[1]);
  }
  const drifted = [...sources.keys()].filter(name =>
    !caseInsensitiveEquals(sources.get(name), declared));
  if (drifted.length === 0) {
    report('CM-42', 'PASS', `one protocol version everywhere: ${declared}`);
  } else {
    for (const name of drifted) {
      report('CM-42', 'FAIL',
        `${name} says ${sources.get(name)}; protocol-manifest.json says ${declared}`);
    }
  }
}

// CM-43: installed role content digests. Silent skip for a missing managed
// file is the preserved .ps1 defect D-6 (noted in the contract map).
function sha256Hex(full) {
  return crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
}

function checkContentDigests(root, role, report) {
  if (role === 'source') return;
  const manifest = loadManifestObject(root);
  if (!manifest || !manifest.contentDigest ||
      typeof manifest.contentDigest !== 'object') return;
  const docDigests = [
    'AGENTS.md',
    'CLAUDE.md',
    '.ai/docs/PROTOCOL.md',
    '.ai/docs/CODEX.md',
    '.ai/docs/COPILOT.md',
    '.ai/docs/GLM.md',
    '.ai/docs/PAIRED-CYCLE.md',
    '.github/copilot-instructions.md',
  ];
  let digestsChecked = 0;
  for (const relative of Object.keys(manifest.contentDigest)) {
    const expected = String(manifest.contentDigest[relative]);
    if (!/^sha256:[a-f0-9]{64}$/.test(expected)) {
      report('CM-43', 'FAIL', `content digest for ${relative} is malformed`);
      continue;
    }
    const full = path.join(root, relative);
    if (!isFile(full)) continue;
    digestsChecked++;
    if (('sha256:' + sha256Hex(full)) === expected) continue;
    if (docDigests.some(item => caseInsensitiveEquals(item, relative.split('\\').join('/')))) {
      report('CM-43', 'WARN',
        `${relative} differs from the installed protocol content; it is a document the host may reconcile. Run -Force to take the canonical copy.`);
    } else {
      report('CM-43', 'FAIL',
        `${relative} is not the content this protocol version installed; a partial upgrade or a hand edit. Run node .ai/bin/protocol-setup.cjs --Force from the protocol source repository.`);
    }
  }
  report('CM-43', 'PASS', `verified ${digestsChecked} managed content digest(s)`);
}

// CM-46: the installer must exist in the source role and its no-argument
// self-check must run.
function checkInstaller(root, role, report) {
  const installerPath = path.join(root, '.ai', 'bin', 'protocol-setup.cjs');
  if (role !== 'source') {
    report('CM-46', 'PASS', 'installed project; the installer lives in the protocol source repository');
    return;
  }
  if (!isFile(installerPath)) {
    report('CM-46', 'FAIL', 'installer absent; its self-check cannot run and was not skipped quietly');
    return;
  }
  const selfCheck = invokeExternal(process.execPath, [installerPath], root);
  if (selfCheck.code === 0) {
    report('CM-46', 'PASS', 'installer self-check runs');
    return;
  }
  const detail = (selfCheck.output + '\n' + selfCheck.error)
    .split(/\r?\n/).filter(line => /\S/.test(line));
  const last = detail.length > 0 ? detail[detail.length - 1].trim() :
    `exit code ${selfCheck.code}`;
  report('CM-46', 'FAIL', `installer cannot run: ${last}`);
}

// CM-20: PowerShell script syntax. The one check that stays a PowerShell
// subprocess (final-plan-2 section K): only PowerShell parses PowerShell, and
// the Windows PowerShell host of record (resolved on PATH exactly like the
// installer self-check host; pwsh off Windows) must produce the diagnostics.
// One subprocess per validation parses the whole PowerShell batch; the errors
// are re-emitted per file, byte-identical to the in-process .ps1 loop because
// the parser binary is the same. A missing host is a named required-capability
// FAIL (plan CA-03): never silent, never PASS-when-not-run.
function parserScript(root, relatives) {
  const quote = value => `'${value.split('\'').join('\'\'' )}'`;
  return [
    "$ErrorActionPreference = 'Stop'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `$root = ${quote(root)}`,
    `$files = @(${relatives.map(quote).join(', ')})`,
    'foreach ($file in $files) {',
    '    $tokens = $null',
    '    $errors = $null',
    '    [void][System.Management.Automation.Language.Parser]::ParseFile((Join-Path $root $file), [ref]$tokens, [ref]$errors)',
    '    foreach ($parseError in $errors) {',
    "        [Console]::Out.WriteLine($file + [char]31 + $parseError.Message)",
    '    }',
    '}',
  ].join('\r\n');
}

function checkPowerShellSyntax(root, files, report) {
  const powershellFiles = files.filter(file => {
    const extension = path.extname(file.relative).toLowerCase();
    return extension === '.ps1' || extension === '.psm1' || extension === '.psd1';
  });
  if (powershellFiles.length === 0) return;
  const shellName = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  // resolveCommand cannot append PATHEXT to a name that already carries an
  // extension, so the bare name is the fallback; spawnSync then resolves it
  // through PATH exactly as the installer self-check host does.
  const shell = resolveCommand(shellName) || shellName;
  const encoded = Buffer.from(parserScript(root, powershellFiles.map(file => file.relative)),
    'utf16le').toString('base64');
  const parsed = invokeExternal(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    root);
  if (parsed.code !== 0) {
    const detail = (parsed.error.trim().length > 0 ? parsed.error : parsed.output).trim();
    report('CM-20', 'FAIL', `PowerShell cannot check script syntax: ${detail}`);
    return;
  }
  for (const line of parsed.output.split(/\r?\n/)) {
    const separator = line.indexOf('\x1f');
    if (separator === -1) continue;
    const relative = line.slice(0, separator);
    const message = line.slice(separator + 1);
    report('CM-20', 'FAIL', `PowerShell syntax in ${relative}: ${message}`, relative);
  }
}

module.exports = {
  checkClaudeImport,
  checkClaudeHookWiring,
  checkNodePresence,
  checkCodexHookWiring,
  checkBashPresence,
  checkHooksGloballyOff,
  checkIgnoreRules,
  checkVersionCoherence,
  checkContentDigests,
  checkInstaller,
  checkPowerShellSyntax,
};

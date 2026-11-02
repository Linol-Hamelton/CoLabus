#!/usr/bin/env node
'use strict';
// AI Collaboration Protocol installer, protocol v2.0.1.
// No arguments: read-only check of this checkout.
// --Target <path> [--InitGit]: initialize missing state and merge integration.
// --Force: update managed tooling with backups, preserving existing .ai state.
// --Verify: read-only check; populated state is never compared to templates.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
let testCommandLibCache = null;
function testCommandLib() {
  if (!testCommandLibCache) {
    try {
      testCommandLibCache = require(path.join(__dirname, 'lib', 'test-command.cjs'));
    } catch (error) {
      throw new Error('test-command detection module missing at .ai/bin/lib/test-command.cjs: ' + error.message);
    }
  }
  return testCommandLibCache;
}

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function parseArgs(args) {
  let target = '';
  let force = false;
  let initGit = false;
  let verify = false;
  let testCommand = null;
  let setTestCommand = null;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const lower = arg.toLowerCase();
    if (lower === '-target' || lower === '--target') {
      if (i + 1 < args.length) {
        target = args[++i];
      } else {
        throw new Error('Option --Target requires a path argument.');
      }
    } else if (lower.startsWith('-target=') || lower.startsWith('--target=')) {
      target = arg.slice(arg.indexOf('=') + 1);
    } else if (lower === '-force' || lower === '--force') {
      force = true;
    } else if (lower === '-initgit' || lower === '--initgit' || lower === '-init-git' || lower === '--init-git') {
      initGit = true;
    } else if (lower === '-verify' || lower === '--verify') {
      verify = true;
    } else if (lower === '-test-command' || lower === '--test-command') {
      if (i + 1 < args.length) {
        testCommand = args[++i];
      } else {
        throw new Error('Option --test-command requires auto, none or a literal command.');
      }
    } else if (lower.startsWith('-test-command=') || lower.startsWith('--test-command=')) {
      testCommand = arg.slice(arg.indexOf('=') + 1);
    } else if (lower === '-set-test-command' || lower === '--set-test-command') {
      if (i + 1 < args.length) {
        setTestCommand = args[++i];
      } else {
        throw new Error('Option --set-test-command requires auto, none or a literal command.');
      }
    } else if (lower.startsWith('-set-test-command=') || lower.startsWith('--set-test-command=')) {
      setTestCommand = arg.slice(arg.indexOf('=') + 1);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { target, force, initGit, verify, testCommand, setTestCommand };
}

function isSamePath(a, b) {
  const pa = path.resolve(a).replace(/[\/\\]+$/, '');
  const pb = path.resolve(b).replace(/[\/\\]+$/, '');
  return process.platform === 'win32' ? pa.toLowerCase() === pb.toLowerCase() : pa === pb;
}

function readText(filePath) {
  const buf = fs.readFileSync(filePath);
  return strictUtf8.decode(buf);
}

function sameBytes(fileA, fileB) {
  if (!fs.existsSync(fileA) || !fs.existsSync(fileB)) return false;
  const a = fs.readFileSync(fileA);
  const b = fs.readFileSync(fileB);
  return Buffer.compare(a, b) === 0;
}

function getSha256Hex(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function jsonObject(filePath) {
  let val;
  try {
    val = JSON.parse(readText(filePath));
  } catch {
    throw new Error(`Expected a JSON object: ${filePath}`);
  }
  if (val === null || typeof val !== 'object' || Array.isArray(val)) {
    throw new Error(`Expected a JSON object: ${filePath}`);
  }
  return val;
}

function assertHookSettings(settings, filePath, isSource) {
  if (!settings.hooks) {
    if (isSource) {
      throw new Error(`Source settings must provide SessionStart and Stop hooks: ${filePath}`);
    }
    return;
  }
  if (typeof settings.hooks !== 'object' || settings.hooks === null || Array.isArray(settings.hooks)) {
    throw new Error(`Expected hooks to be a JSON object: ${filePath}`);
  }
  if (isSource && (!settings.hooks.SessionStart || !settings.hooks.Stop)) {
    throw new Error(`Source settings must provide SessionStart and Stop hooks: ${filePath}`);
  }
  for (const [eventName, eventValue] of Object.entries(settings.hooks)) {
    if (!Array.isArray(eventValue)) {
      throw new Error(`Expected hooks.${eventName} to be an array: ${filePath}`);
    }
    for (const group of eventValue) {
      if (typeof group !== 'object' || group === null || Array.isArray(group) || !Array.isArray(group.hooks)) {
        throw new Error(`Expected a hook group with a hooks array: ${filePath}`);
      }
      for (const handler of group.hooks) {
        if (typeof handler !== 'object' || handler === null || Array.isArray(handler)) {
          throw new Error(`Expected each hook handler to be a JSON object: ${filePath}`);
        }
      }
    }
  }
}

function formatBackupStamp(date) {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  const h = String(date.getUTCHours()).padStart(2, '0');
  const min = String(date.getUTCMinutes()).padStart(2, '0');
  const s = String(date.getUTCSeconds()).padStart(2, '0');
  const ms = String(date.getUTCMilliseconds()).padStart(3, '0');
  return `${y}${m}${d}T${h}${min}${s}${ms}Z`;
}

function invokeGit(args, cwd) {
  const res = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
  });
  if (res.status !== 0) {
    const out = ((res.stdout || '') + '\n' + (res.stderr || '')).trim().replace(/\r?\n/g, ' ');
    throw new Error(`git ${args.join(' ')} failed: ${out}`);
  }
  return (res.stdout || '').trim();
}

function hasGit() {
  const res = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true });
  return res.status === 0;
}

function safeDetect(root) {
  try { return testCommandLib().detectTestCommand(root); } catch { return []; }
}

function hasTestCommandLib() {
  try { testCommandLib(); return true; } catch { return false; }
}

function runSetTestCommand(targetRoot, choice) {
  const manifestPath = path.join(targetRoot, 'protocol-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`protocol-manifest.json not found at ${manifestPath}`);
  }
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (error) {
    throw new Error(`protocol-manifest.json is not valid JSON: ${error.message}`);
  }
  // The source repository runs its own regression suite; the field is the host's.
  if (!manifest || manifest.role !== 'installed') {
    throw new Error('--set-test-command applies to an installed host (role installed in protocol-manifest.json).');
  }
  const candidates = safeDetect(targetRoot);
  const resolved = testCommandLib().resolveChoice(candidates, choice);
  if (!resolved.ok) throw new Error(resolved.message);
  testCommandLib().writeManifestTestCommand(manifestPath, resolved.command);
  console.log(`[ok] testCommand written: ${resolved.command}`);
  return 0;
}

// One line from the terminal, synchronously; an end of input is an empty answer.
function readAnswerLine() {
  const buffer = Buffer.alloc(1);
  let line = '';
  for (;;) {
    let n = 0;
    try { n = fs.readSync(0, buffer, 0, 1, null); } catch { n = 0; }
    if (n === 0 || buffer[0] === 10) break;
    line += String.fromCharCode(buffer[0]);
  }
  return line.replace(/\r$/, '');
}

// Interactive install only: a terminal on both ends and no explicit flag.
// Anything that is not an explicit answer writes nothing.
function askTestCommand(candidates) {
  const lib = testCommandLib();
  console.log(lib.formatProposal(candidates));
  const many = candidates.length > 1;
  console.log(many
    ? 'Type a number to choose, none to record a decline, a literal command, or press Enter to skip:'
    : 'Type yes to write it, none to record a decline, a literal command, or press Enter to skip:');
  candidates.forEach((c, index) => { if (many) console.log(`  ${index + 1}. ${lib.formatCandidate(c)}`); });
  const answer = lib.interpretAnswer(candidates, readAnswerLine());
  if (!answer.ok) {
    console.log(`No testCommand written: ${answer.message}`);
    return null;
  }
  return answer.skip ? null : answer.command;
}

function runSetup(cliArgs) {
  let drifted = 0;
  let created = 0;
  let updated = 0;
  let kept = 0;
  let backupRoot = null;
  const selectionWritten = new Set();

  const parsed = parseArgs(cliArgs);
  const SourceRoot = path.resolve(__dirname, '..', '..');
  const TargetRoot = parsed.target ? path.resolve(parsed.target) : SourceRoot;

  // A dedicated setter for an existing host: only the testCommand field is
  // written; the rest of the manifest keeps its bytes and no install runs.
  if (parsed.setTestCommand !== null) {
    if (!hasTestCommandLib()) throw new Error('test-command detection module missing at .ai/bin/lib/test-command.cjs');
    return runSetTestCommand(TargetRoot, parsed.setTestCommand);
  }

  // Resolve an explicit --test-command choice before any write so a refusal
  // (auto with zero or many candidates) changes nothing.
  let resolvedTestCommand = null;
  if (parsed.testCommand !== null) {
    if (!hasTestCommandLib()) throw new Error('test-command detection module missing at .ai/bin/lib/test-command.cjs');
    const early = testCommandLib().resolveChoice(safeDetect(TargetRoot), parsed.testCommand);
    if (!early.ok) throw new Error(early.message);
    resolvedTestCommand = early.command;
  }
  const SelfInstall = isSamePath(TargetRoot, SourceRoot);
  const CheckOnly = Boolean(parsed.verify || SelfInstall);
  const Force = parsed.force;
  const InitGit = parsed.initGit;
  let previousManifest = null;
  const previousPath = path.join(TargetRoot, 'protocol-manifest.json');
  const checkedAttributes = new Map();

  function reportDrift(message) {
    console.log(`[!=] ${message}`);
    drifted++;
  }

  // Ask Windows for ERROR_NOT_A_REPARSE_POINT in its own language. Never calibrate
  // against a failed query: that could turn a shared access error into permission.
  let notReparseReference;
  // These commands use the native console code page. Latin-1 is a lossless
  // byte mapping here; UTF-8 replacement characters could merge distinct errors.
  const nativeText = data => Buffer.from(data || '').toString('latin1').replace(/^[\t\r\n ]+|[\t\r\n ]+$/g, '');
  function notReparseText(systemRoot) {
    if (notReparseReference === undefined) {
      const probe = spawnSync(path.join(systemRoot, 'System32/net.exe'), ['helpmsg', '4390'],
        { windowsHide: true });
      const text = nativeText(probe.stdout);
      notReparseReference = !probe.error && probe.status === 0 && text ? text : null;
    }
    return notReparseReference;
  }

  function assertSafeDestination(relative, allowDirectory = false) {
    const candidate = path.resolve(TargetRoot, relative);
    const rel = path.relative(TargetRoot, candidate);
    if (path.isAbsolute(rel) || rel.split(path.sep).includes('..')) {
      throw new Error(`REFUSED reason=destination-outside: ${relative}`);
    }
    // Walk from the root: lstat must see a dangling parent before its child.
    const components = [TargetRoot];
    for (const segment of rel.split(path.sep).filter(Boolean)) components.push(path.join(components.at(-1), segment));
    for (const current of components) {
      const label = path.relative(TargetRoot, current).split(path.sep).join('/') || '.';
      let entry;
      try { entry = fs.lstatSync(current); } catch (err) {
        if (err.code !== 'ENOENT') throw new Error(`REFUSED reason=destination-unreadable: ${label} (${err.code})`);
        continue;
      }
      if (entry.isSymbolicLink()) throw new Error(`REFUSED reason=destination-link: ${label}`);
      // Node exposes junctions as links, but not every Windows reparse tag.
      // fsutil queries the entry itself, including non-redirecting reparse tags.
      if (process.platform === 'win32') {
        const signature = [entry.dev, entry.ino, entry.mode, entry.ctimeMs, entry.mtimeMs, entry.birthtimeMs].join(':');
        if (checkedAttributes.get(current) !== signature) {
          const systemRoot = process.env.SystemRoot || process.env.SYSTEMROOT;
          if (!systemRoot || !path.isAbsolute(systemRoot)) throw new Error(`REFUSED reason=destination-unreadable: ${label} (system-root)`);
          const fsutil = path.join(systemRoot, 'System32/fsutil.exe');
          const result = spawnSync(fsutil, ['reparsepoint', 'query', current], { windowsHide: true });
          if (result.status === 0) throw new Error(`REFUSED reason=destination-reparse: ${label}`);
          // fsutil may omit the number and print a localized prefix before the
          // system message. Any other query failure, including access denial, refuses.
          const output = nativeText(Buffer.concat([Buffer.from(result.stdout || ''), Buffer.from(result.stderr || '')]));
          const message = /\b4390\b/.test(output) ? null : notReparseText(systemRoot);
          if (result.error || result.status !== 1 || !(/\b4390\b/.test(output) || (message && output.endsWith(message)))) {
            throw new Error(`REFUSED reason=destination-unreadable: ${label} (reparse-query)`);
          }
          checkedAttributes.set(current, signature);
        }
      }
      if (current !== candidate && !entry.isDirectory()) throw new Error(`Destination parent is not a directory: ${label}`);
      if (current === candidate && entry.isDirectory() && !allowDirectory) throw new Error(`Destination file is a directory: ${label}`);
    }
  }

  function backupFile(relative) {
    if (!backupRoot) {
      const stamp = formatBackupStamp(new Date());
      const guid = crypto.randomUUID().replace(/-/g, '');
      backupRoot = path.join(TargetRoot, '.ai', 'backups', `${stamp}-${guid}`);
    }
    const backup = path.join(backupRoot, relative);
    const backupRelative = path.relative(TargetRoot, backup);
    assertSafeDestination(relative);
    assertSafeDestination(backupRelative);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    assertSafeDestination(backupRelative);
    fs.copyFileSync(path.join(TargetRoot, relative), backup);
  }

  function writeBytes(relative, bytes) {
    assertSafeDestination(relative);
    const destination = path.join(TargetRoot, relative);
    const existed = fs.existsSync(destination);
    if (existed) {
      backupFile(relative);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    assertSafeDestination(relative);
    fs.writeFileSync(destination, bytes);
    if (existed) updated++;
    else created++;
    selectionWritten.add(relative);
    console.log(`[ok] written: ${relative}`);
  }

  function installFile(source, destination, isState) {
    const src = path.join(SourceRoot, source);
    const dst = path.join(TargetRoot, destination);
    if (!fs.existsSync(dst)) {
      if (CheckOnly) {
        reportDrift(`Missing: ${destination}`);
      } else {
        writeBytes(destination, fs.readFileSync(src));
      }
      return;
    }
    if (isState || sameBytes(src, dst) || (CheckOnly && hostOwned.has(destination))) {
      kept++;
      return;
    }
    if (CheckOnly) {
      reportDrift(`Managed file differs: ${destination}`);
    } else if (selectionFiles.has(destination) && (hostOwned.has(destination)
      || previousManifest?.role !== 'installed'
      || previousManifest.contentDigest?.[destination] !== 'sha256:' + getSha256Hex(dst))) {
      console.log(`[==] kept host selection file: ${destination}`);
      kept++;
    } else if (Force) {
      writeBytes(destination, fs.readFileSync(src));
    } else {
      console.log(`[==] kept local managed file: ${destination} (use -Force to update with backup)`);
      kept++;
    }
  }

  function prepareSettingsMerge(relative, agentName) {
    const src = path.join(SourceRoot, relative);
    const dst = path.join(TargetRoot, relative);
    const wanted = jsonObject(src);
    assertHookSettings(wanted, src, true);
    if (!fs.existsSync(dst)) {
      return { relative, bytes: fs.readFileSync(src), message: `Missing: ${relative}` };
    }
    const existing = jsonObject(dst);
    assertHookSettings(existing, dst, false);
    const before = JSON.stringify(existing);
    if (!existing.hooks) existing.hooks = {};
    const legacy = {
      SessionStart: [
        '[ -f .claude/hooks/session-start.sh ] && bash .claude/hooks/session-start.sh || true',
        'bash "$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --show-toplevel)/.claude/hooks/session-start.sh"',
      ],
      Stop: [
        '[ -f .claude/hooks/stop-worklog-check.sh ] && bash .claude/hooks/stop-worklog-check.sh || true',
        'bash "$(git -C "${CLAUDE_PROJECT_DIR:-.}" rev-parse --show-toplevel)/.claude/hooks/stop-worklog-check.sh"',
      ],
    };
    for (const [eventName, eventValue] of Object.entries(wanted.hooks)) {
      const commands = [];
      for (const group of eventValue) {
        if (Array.isArray(group.hooks)) {
          for (const h of group.hooks) {
            if (h && typeof h.command === 'string') commands.push(h.command);
          }
        }
      }
      if (relative === '.claude/settings.json' && legacy[eventName]) {
        commands.push(...legacy[eventName]);
      }
      const groups = [];
      const oldEvent = existing.hooks[eventName];
      if (Array.isArray(oldEvent)) {
        for (const group of oldEvent) {
          const remaining = (group.hooks || []).filter(h => {
            if (h && h.type === 'command') {
              const owned = (relative === '.codex/hooks.json')
                ? commands.includes(h.command)
                : commands.some(c => c.toLowerCase() === (h.command || '').toLowerCase());
              return !owned;
            }
            return true;
          });
          if (remaining.length > 0 || (group.hooks && group.hooks.length === 0)) {
            group.hooks = remaining;
            groups.push(group);
          }
        }
      }
      groups.push(...eventValue);
      existing.hooks[eventName] = groups;
    }
    const after = JSON.stringify(existing);
    if (before === after) return { relative, bytes: null, message: '' };
    const merged = JSON.stringify(existing, null, 2) + '\n';
    return { relative, bytes: Buffer.from(merged, 'utf8'), message: `${agentName} protocol hooks need merging` };
  }

  function prepareManifestWrite(manifest) {
    const installed = {
      comment: 'Installed copy. The protocol source repository holds the installer, the test suite and the templates; this project holds only the runtime it needs.',
      protocolVersion: manifest.protocolVersion,
      role: 'installed',
      managed: [...(manifest.managed || [])],
      integration: [...(manifest.integration || [])],
      state: [...(manifest.state || [])],
      ...(manifest.selection ? { selection: manifest.selection } : {}),
    };
    // Host-owned keys survive an update: the integration branch the host lands
    // into, an optional remote, and the branches no cleanup may touch.
    const dstManifest = path.join(TargetRoot, 'protocol-manifest.json');
    if (fs.existsSync(dstManifest)) {
      let current = null;
      try { current = JSON.parse(fs.readFileSync(dstManifest, 'utf8')); } catch { current = null; }
      if (current && current.role === 'installed') {
        for (const key of ['integrationBranch', 'integrationRemote']) {
          if (typeof current[key] === 'string' && current[key]) installed[key] = current[key];
        }
        // The host test command is the host's decision and survives updates.
        if (Object.hasOwn(current, 'testCommand')) {
          installed.testCommand = current.testCommand;
        }
        if (Array.isArray(current.protectedBranches) && current.protectedBranches.every(b => typeof b === 'string' && b)) {
          installed.protectedBranches = [...current.protectedBranches];
        }
        // The host's rule-gate configuration (budgets, demoted gates, allowed identities, derived artifacts) is its own.
        if (current.ruleGates && typeof current.ruleGates === 'object' && !Array.isArray(current.ruleGates)) {
          installed.ruleGates = JSON.parse(JSON.stringify(current.ruleGates));
        }
        // The operator layer settings (adapter, thresholds, schedule opt-out) belong to the host.
        if (current.operatorLayer && typeof current.operatorLayer === 'object' && !Array.isArray(current.operatorLayer)) {
          installed.operatorLayer = JSON.parse(JSON.stringify(current.operatorLayer));
        }
      }
    }
    const contentDigest = {};
    for (const relative of installed.managed) {
      if (relative === 'protocol-manifest.json') continue;
      if (hostOwned.has(relative)) continue;
      const source = path.join(SourceRoot, relative);
      if (selectionFiles.has(relative) && fs.existsSync(path.join(TargetRoot, relative))
          && (hostOwned.has(relative) || previousManifest?.role !== 'installed'
          || previousManifest.contentDigest?.[relative] !== 'sha256:' + getSha256Hex(path.join(TargetRoot, relative)))) {
        // A preserved host modification is no longer a kernel copy. Leaving its
        // old digest here would make every subsequent validation fail.
      } else if (fs.existsSync(source)) {
        contentDigest[relative] = 'sha256:' + getSha256Hex(source);
      }
    }
    installed.contentDigest = contentDigest;
    if (SelfInstall) {
      return { relative: 'protocol-manifest.json', bytes: null, message: '' };
    }
    const json = JSON.stringify(installed, null, 2) + '\n';
    const bytes = Buffer.from(json, 'utf8');
    const dst = path.join(TargetRoot, 'protocol-manifest.json');
    if (fs.existsSync(dst)) {
      const current = fs.readFileSync(dst);
      if (Buffer.compare(current, bytes) === 0) {
        return { relative: 'protocol-manifest.json', bytes: null, message: '' };
      }
    }
    return { relative: 'protocol-manifest.json', bytes, message: 'Manifest needs updating: protocol-manifest.json' };
  }

  function prepareHygieneMerge(relative, scopedContent) {
    const src = path.join(SourceRoot, relative);
    const dst = path.join(TargetRoot, relative);
    const begin = '# BEGIN AI COLLABORATION PROTOCOL';
    const end = '# END AI COLLABORATION PROTOCOL';
    const block = begin + '\n' + scopedContent.trimEnd() + '\n' + end + '\n';
    if (!fs.existsSync(dst)) {
      return { relative, bytes: Buffer.from(block, 'utf8'), message: `Missing: ${relative}` };
    }
    if (sameBytes(src, dst)) return { relative, bytes: null, message: '' };
    const existing = readText(dst).replace(/\r\n/g, '\n');
    const pattern = new RegExp('^' + escapeRegex(begin) + '\\n[\\s\\S]*?^' + escapeRegex(end) + '(?:\\n|$)', 'mg');
    const matches = [...existing.matchAll(pattern)];
    const beginMatches = existing.match(new RegExp(escapeRegex(begin), 'g')) || [];
    const endMatches = existing.match(new RegExp(escapeRegex(end), 'g')) || [];
    if (matches.length > 1 || beginMatches.length !== matches.length || endMatches.length !== matches.length) {
      throw new Error(`Malformed managed block in ${relative}; preserve the file and repair its markers.`);
    }
    let merged;
    if (matches.length === 1) {
      merged = existing.substring(0, matches[0].index) + block + existing.substring(matches[0].index + matches[0][0].length);
    } else {
      merged = existing.replace(/\n+$/, '') + '\n\n' + block;
    }
    if (merged === existing) return { relative, bytes: null, message: '' };
    return { relative, bytes: Buffer.from(merged, 'utf8'), message: `Protocol entries need merging: ${relative}` };
  }

  function prepareIgnoreMerge() {
    const src = path.join(SourceRoot, '.gitignore');
    const dst = path.join(TargetRoot, '.gitignore');
    if (!fs.existsSync(dst)) {
      return { relative: '.gitignore', bytes: fs.readFileSync(src), message: 'Missing: .gitignore' };
    }
    const existing = readText(dst).replace(/\r\n/g, '\n');
    const existingLines = existing.split('\n');
    const srcLines = readText(src).split(/\r?\n/);
    const missing = srcLines.filter(line => line.trim().length > 0 && !line.trimStart().startsWith('#') && !existingLines.includes(line));
    if (missing.length === 0) return { relative: '.gitignore', bytes: null, message: '' };
    const merged = existing.replace(/\n+$/, '') + '\n\n# AI collaboration protocol\n' + missing.join('\n') + '\n';
    return { relative: '.gitignore', bytes: Buffer.from(merged, 'utf8'), message: 'Missing protocol ignore entries' };
  }

  function applyMergePlan(plan) {
    if (plan.bytes === null || plan.bytes === undefined) {
      kept++;
      return;
    }
    if (CheckOnly) {
      reportDrift(plan.message);
      return;
    }
    writeBytes(plan.relative, plan.bytes);
  }

  console.log(`AI Collaboration Protocol installer\nSource: ${SourceRoot}\nTarget: ${TargetRoot}`);
  const manifestPath = path.join(SourceRoot, 'protocol-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error('Required source file missing: protocol-manifest.json');
  }
  const manifest = jsonObject(manifestPath);
  const selectionFiles = new Set(manifest.selection?.files || []);
  const hostOwned = new Set(manifest.selection?.hostOwned || []);
  const managed = manifest.managed || [];
  const state = manifest.state || [];
  const integration = manifest.integration || [];
  const sourceOnly = [
    ...(manifest.source || []),
    ...(manifest.tests || []),
    ...state.map(s => 'templates/ai/' + s),
  ];
  for (const relative of [...managed, ...integration, ...sourceOnly]) {
    if (!fs.existsSync(path.join(SourceRoot, relative))) {
      throw new Error(`Required source file missing: ${relative}`);
    }
  }
  for (const relative of [...managed, ...integration, ...state.map(s => '.ai/' + s), '.ai/backups/.probe']) {
    assertSafeDestination(relative);
  }
  assertSafeDestination('.git', true);
  if (CheckOnly && !fs.existsSync(TargetRoot)) {
    throw new Error(`Target does not exist (verification made no changes): ${TargetRoot}`);
  }
  if (!SelfInstall && fs.existsSync(previousPath)) previousManifest = jsonObject(previousPath);
  const scopedPaths = [...new Set([...managed, ...integration, '.ai/**', 'AGENTS.md', 'CLAUDE.md'])];
  const attributes = scopedPaths.map(p => `${p} text eol=lf`).join('\n');
  const mergePlans = [
    prepareSettingsMerge('.claude/settings.json', 'Claude'),
    prepareSettingsMerge('.codex/hooks.json', 'Codex'),
    prepareManifestWrite(manifest),
    prepareIgnoreMerge(),
    prepareHygieneMerge('.gitattributes', attributes),
  ];
  if (!hasGit()) {
    throw new Error('Git is required but is not available.');
  }
  const gitPath = path.join(TargetRoot, '.git');
  if (!fs.existsSync(gitPath)) {
    if (InitGit && !CheckOnly) {
      fs.mkdirSync(TargetRoot, { recursive: true });
      invokeGit(['-C', TargetRoot, 'init', '-b', 'main'], TargetRoot);
    } else {
      throw new Error('Target needs its own Git repository. Install with -InitGit, then verify.');
    }
  }
  const gitRoot = invokeGit(['-C', TargetRoot, 'rev-parse', '--show-toplevel'], TargetRoot);
  if (path.resolve(gitRoot).toLowerCase().replace(/[\/\\]+$/, '') !== path.resolve(TargetRoot).toLowerCase().replace(/[\/\\]+$/, '')) {
    throw new Error('Git resolved a different repository root.');
  }
  invokeGit(['-C', TargetRoot, 'status', '--porcelain=v1', '-uno'], TargetRoot);
  for (const relative of managed) {
    if (relative === 'protocol-manifest.json') continue;
    installFile(relative, relative, false);
  }
  if (!CheckOnly && selectionFiles.size) console.log(`Selection layer: ${[...selectionFiles].filter(f => selectionWritten.has(f)).join(', ') || 'no files written (host data preserved)'}`);
  for (const relative of state) {
    installFile('templates/ai/' + relative, '.ai/' + relative, true);
  }
  for (const plan of mergePlans) {
    applyMergePlan(plan);
  }
  if (!CheckOnly && resolvedTestCommand !== null) {
    const manifestFile = path.join(TargetRoot, 'protocol-manifest.json');
    if (!fs.existsSync(manifestFile)) throw new Error('protocol-manifest.json missing after install.');
    testCommandLib().writeManifestTestCommand(manifestFile, resolvedTestCommand);
    console.log(`[ok] testCommand written: ${resolvedTestCommand}`);
  } else if (!CheckOnly && parsed.testCommand === null && hasTestCommandLib()) {
    let current = null;
    try { current = JSON.parse(fs.readFileSync(path.join(TargetRoot, 'protocol-manifest.json'), 'utf8')); } catch { current = null; }
    if (!testCommandLib().hasRunnableCommand(current) && !testCommandLib().hasRecordedNone(current)) {
      const candidates = safeDetect(TargetRoot);
      const interactive = candidates.length > 0 && process.stdin.isTTY && process.stdout.isTTY;
      const chosen = interactive ? askTestCommand(candidates) : null;
      if (chosen !== null) {
        testCommandLib().writeManifestTestCommand(path.join(TargetRoot, 'protocol-manifest.json'), chosen);
        console.log(`[ok] testCommand written: ${chosen}`);
      } else {
        if (!interactive) console.log(testCommandLib().formatProposal(candidates));
        console.log('No testCommand written; pass --test-command auto|none|literal for an explicit choice.');
      }
    }
  }
  if (drifted > 0) {
    console.log(`${drifted} difference(s). Install to merge integration; -Force updates managed files with backups. Project state is always kept.`);
    return 1;
  }
  if (CheckOnly) {
    console.log('Structure and integration verified. Project state was checked for existence only.');
  } else {
    console.log(`Done: ${created} created, ${updated} updated, ${kept} kept. Existing project state preserved.`);
  }
  if (backupRoot) {
    console.log(`Previous versions saved to: ${backupRoot}`);
  }
  return 0;
}

function main() {
  try {
    const exitCode = runSetup(process.argv.slice(2));
    process.exit(exitCode);
  } catch (err) {
    console.log(`[error] ${err.message}`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { runSetup, main };

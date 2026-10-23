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

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function parseArgs(args) {
  let target = '';
  let force = false;
  let initGit = false;
  let verify = false;

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
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { target, force, initGit, verify };
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

function runSetup(cliArgs) {
  let drifted = 0;
  let created = 0;
  let updated = 0;
  let kept = 0;
  let backupRoot = null;

  const parsed = parseArgs(cliArgs);
  const SourceRoot = path.resolve(__dirname, '..', '..');
  const TargetRoot = parsed.target ? path.resolve(parsed.target) : SourceRoot;
  const SelfInstall = isSamePath(TargetRoot, SourceRoot);
  const CheckOnly = Boolean(parsed.verify || SelfInstall);
  const Force = parsed.force;
  const InitGit = parsed.initGit;

  function reportDrift(message) {
    console.log(`[!=] ${message}`);
    drifted++;
  }

  function assertSafeDestination(relative) {
    const candidate = path.join(TargetRoot, relative);
    let current = candidate;
    while (current && current.length >= TargetRoot.length) {
      if (fs.existsSync(current)) {
        const lstat = fs.lstatSync(current);
        if (lstat.isSymbolicLink()) {
          throw new Error(`Refusing a linked destination: ${current}`);
        }
        if (current !== candidate && !lstat.isDirectory()) {
          throw new Error(`Destination parent is not a directory: ${current}`);
        }
      }
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
    if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
      throw new Error(`Destination file is a directory: ${candidate}`);
    }
  }

  function backupFile(relative) {
    if (!backupRoot) {
      const stamp = formatBackupStamp(new Date());
      const guid = crypto.randomUUID().replace(/-/g, '');
      backupRoot = path.join(TargetRoot, '.ai', 'backups', `${stamp}-${guid}`);
    }
    const backup = path.join(backupRoot, relative);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    fs.copyFileSync(path.join(TargetRoot, relative), backup);
  }

  function writeBytes(relative, bytes) {
    const destination = path.join(TargetRoot, relative);
    if (fs.existsSync(destination)) {
      backupFile(relative);
      updated++;
    } else {
      created++;
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, bytes);
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
    if (isState || sameBytes(src, dst)) {
      kept++;
      return;
    }
    if (CheckOnly) {
      reportDrift(`Managed file differs: ${destination}`);
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
    };
    const contentDigest = {};
    for (const relative of installed.managed) {
      if (relative === 'protocol-manifest.json') continue;
      const source = path.join(SourceRoot, relative);
      if (fs.existsSync(source)) {
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
  if (fs.existsSync(TargetRoot) && fs.statSync(TargetRoot).isFile()) {
    throw new Error(`Target is not a directory: ${TargetRoot}`);
  }
  if (CheckOnly && !fs.existsSync(TargetRoot)) {
    throw new Error(`Target does not exist (verification made no changes): ${TargetRoot}`);
  }
  for (const relative of [...managed, ...integration, ...state.map(s => '.ai/' + s), '.ai/backups/.probe']) {
    assertSafeDestination(relative);
  }
  const scopedPaths = [...managed, ...integration, '.ai/**'];
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
  for (const relative of state) {
    installFile('templates/ai/' + relative, '.ai/' + relative, true);
  }
  for (const plan of mergePlans) {
    applyMergePlan(plan);
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

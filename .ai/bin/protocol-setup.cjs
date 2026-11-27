#!/usr/bin/env node
'use strict';
// AI Collaboration Protocol installer, protocol v2.0.3-pre.5.
// No arguments: read-only check of this checkout.
// --Target <path> [--InitGit]: initialize missing state and merge integration.
// --Force: update managed tooling with backups, preserving existing .ai state.
// --Verify: read-only check; populated state is never compared to templates.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { requireVersion } = require('./lib/protocol-version.cjs');
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

// The answer of `git check-attr <attribute> -- <path>` for ONE path. Canonical form (P-L9-002): exactly one line,
// "<path>: <attribute>: <value>" + LF, the path being the one asked for, byte for byte, and the value one printable ASCII word
// (for eol, one of the five words git gives it). Scope: this one reader of this one command. Anything else (another path or a
// quoted one, a second line, CRLF, no final LF, a space, an invisible or look-alike character, an eol word that is not one of
// the five) is unknown and returns null; the caller must treat unknown as a refusal, never as an absent attribute.
const EOL_WORDS = new Set(['unspecified', 'set', 'unset', 'lf', 'crlf']);
function parseAttributeAnswer(stdout, relative, attribute) {
  if (typeof stdout !== 'string' || typeof relative !== 'string' || typeof attribute !== 'string') return null;
  const prefix = `${relative}: ${attribute}: `;
  if (!stdout.startsWith(prefix) || !stdout.endsWith('\n')) return null;
  const value = stdout.slice(prefix.length, -1);
  if (!/^[\x21-\x7e]+$/.test(value)) return null;
  if (attribute === 'eol' && !EOL_WORDS.has(value)) return null;
  return value;
}

// The role of a computer in a host project: the owner computer keeps journals, locks and evidence, a staff computer keeps none.
// The installer writes it only on an explicit request. A role that already stands in the target is kept as it is, and a request
// that would change it needs a second, explicit confirmation, so a staff computer never becomes an owner computer by a typo.
const HOST_ROLES = ['owner', 'staff'];
function refuse(reason, message) {
  return new Error(`REFUSED reason=${reason}: ${message}`);
}
// `current` is the installed manifest of the target (null on a first install); `requested` is the value of --host-role or
// undefined. The role a manifest without the field has is owner. Returns what the new manifest holds for the key and where it came from.
function decideHostRole(current, requested, confirmed) {
  const declared = Boolean(current) && Object.hasOwn(current, 'hostRole');
  if (requested === undefined) {
    if (confirmed) throw refuse('host-role-confirm-alone', '--confirm-host-role-change needs --host-role owner|staff');
    return declared ? { set: true, value: current.hostRole, source: 'kept' } : { set: false, value: undefined, source: 'none' };
  }
  if (!HOST_ROLES.includes(requested)) throw refuse('host-role-unknown', `--host-role needs owner or staff, got ${JSON.stringify(requested)}`);
  if (current) {
    const existing = declared ? current.hostRole : 'owner';
    if (existing !== requested && !confirmed) {
      throw refuse('host-role-change', `the target is an installed ${declared ? `computer with hostRole ${JSON.stringify(existing)}` : 'computer without a hostRole (owner mode)'}; changing it to ${requested} needs --confirm-host-role-change in the same command`);
    }
  }
  return { set: true, value: requested, source: 'flag' };
}
function describeHostRole(role) {
  const value = role.set ? JSON.stringify(role.value) : 'none declared (owner mode)';
  return `${value} (${{ flag: 'set by --host-role', kept: 'kept from the target', none: 'not requested' }[role.source]})`;
}

// A present but ambiguous manifest is never a first install. Use the shared
// strict byte decoder and unique-key parser; hooks refuse these inputs too.
function parseHostManifest(bytes) {
  const textSafe = require('./lib/text-safe.cjs');
  const decoded = textSafe.decode(bytes, { bom: 'refuse', crlf: 'normalise' });
  if (!decoded.ok) throw refuse('host-role-manifest', `protocol-manifest.json: ${decoded.problems.map(p => p.code).join(', ')}`);
  let manifest;
  try { manifest = textSafe.parseJsonUnique(decoded.text); }
  catch (e) { throw refuse('host-role-manifest', `protocol-manifest.json: ${e.code}`); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) throw refuse('host-role-manifest', 'protocol-manifest.json: JSON_OBJECT_REQUIRED');
  return manifest;
}

function parseArgs(args) {
  let target = '';
  let force = false;
  let initGit = false;
  let verify = false;
  let testCommand = null;
  let setTestCommand = null;
  let hostRole;
  let confirmHostRole = false;

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
    } else if (arg === '--host-role' || arg.startsWith('--host-role=')) {
      if (hostRole !== undefined) throw new Error('Option --host-role was specified twice.');
      if (lower.includes('=')) {
        hostRole = arg.slice(arg.indexOf('=') + 1);
      } else if (i + 1 < args.length) {
        hostRole = args[++i];
      } else {
        throw new Error('Option --host-role requires owner or staff.');
      }
    } else if (arg === '--confirm-host-role-change') {
      confirmHostRole = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return { target, force, initGit, verify, testCommand, setTestCommand, hostRole, confirmHostRole };
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

function sha256Of(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// The bytes with every CRLF pair as LF. A lone CR stays: it is not a line end this installer may judge.
function lfBytes(buf) {
  if (!buf.includes(0x0d)) return buf;
  const out = [];
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a) continue;
    out.push(buf[i]);
  }
  return Buffer.from(out);
}

// Selection files that a file outside the selection layer imports, directly or through other selection files. Such a module is
// part of the kernel the installed validator and hooks load, so an old copy of it cannot be a host choice. The edges are the
// literal relative require() calls of the product files, the declared dynamic calls and the declared dynamic edges, the same
// inputs the product builder reads to build the file list. A declared seam is not such an edge: its importer guards the load and
// reports an unknown value for a copy that is missing or answers otherwise, so a host copy of the target breaks no kernel file.
// A selection file the manifest declares kernelBound is a kernel tool that a selection root calls (by require or by spawn):
// it is bound as such, with everything it imports, so an older copy is refreshed together with the root that calls it.
const REQUIRE_LITERAL = /\brequire\s*\(\s*(['"])(\.{1,2}\/[^'"\\]+)\1\s*\)/g;
function kernelBoundSelection(sourceRoot, managed, selection) {
  const files = new Set(selection?.files || []);
  const bound = new Set();
  if (!files.size) return bound;
  const edges = file => {
    let text;
    try { text = fs.readFileSync(path.join(sourceRoot, file), 'utf8'); } catch { return []; }
    const out = [];
    for (const match of text.matchAll(REQUIRE_LITERAL)) out.push(path.posix.normalize(path.posix.join(path.posix.dirname(file), match[2])));
    for (const entry of Object.values(selection.dynamicCalls?.[file] || {})) out.push(...(Array.isArray(entry?.files) ? entry.files : []));
    out.push(...(Array.isArray(selection.dynamic?.[file]) ? selection.dynamic[file] : []));
    const seam = selection.seams?.[file]?.files;
    return Array.isArray(seam) ? out.filter(target => !seam.includes(target)) : out;
  };
  const queue = [];
  const visit = file => { for (const target of edges(file)) if (files.has(target) && !bound.has(target)) { bound.add(target); queue.push(target); } };
  for (const file of managed) if (!files.has(file) && /\.c?js$/.test(file)) visit(file);
  const declared = Array.isArray(selection.kernelBound) ? selection.kernelBound : [];
  for (const file of declared) if (typeof file === 'string' && files.has(file) && !bound.has(file)) { bound.add(file); queue.push(file); }
  while (queue.length) visit(queue.pop());
  return bound;
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

function runSetTestCommand(targetRoot, choice, parsed) {
  const manifestPath = path.join(targetRoot, 'protocol-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`protocol-manifest.json not found at ${manifestPath}`);
  }
  const manifest = parseHostManifest(fs.readFileSync(manifestPath));
  // The source repository runs its own regression suite; the field is the host's.
  if (!manifest || manifest.role !== 'installed') {
    throw new Error('--set-test-command applies to an installed host (role installed in protocol-manifest.json).');
  }
  const role = decideHostRole(manifest, parsed.hostRole, parsed.confirmHostRole);
  const candidates = safeDetect(targetRoot);
  const resolved = testCommandLib().resolveChoice(candidates, choice);
  if (!resolved.ok) throw new Error(resolved.message);
  console.log('Host role: ' + describeHostRole(role));
  if (parsed.verify) return 0;
  if (parsed.hostRole !== undefined) {
    // Validate both requests before a single write; no partial role change on a
    // refused command. A setter without a role request keeps its byte-preserving edit.
    manifest.hostRole = role.value;
    manifest.testCommand = resolved.command;
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
  } else {
    testCommandLib().writeManifestTestCommand(manifestPath, resolved.command);
  }
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
  const SelfInstall = isSamePath(TargetRoot, SourceRoot);
  if ((parsed.hostRole !== undefined || parsed.confirmHostRole) && (SelfInstall || !parsed.target)) throw refuse('host-role-no-target', '--host-role and --confirm-host-role-change apply to an install into another project (--Target <path>)');

  // A dedicated setter for an existing host; an explicit role request follows
  // the same rule as an install, without copying any kernel files.
  if (parsed.setTestCommand !== null) {
    if (!hasTestCommandLib()) throw new Error('test-command detection module missing at .ai/bin/lib/test-command.cjs');
    return runSetTestCommand(TargetRoot, parsed.setTestCommand, parsed);
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

  // A persistent helper (lib/reparse-query.cjs) is asked before fsutil and decides only that an entry is not a reparse
  // point. Every query it does not decide, for any reason, is a fallback: it prints one line and goes to fsutil, whose
  // answer and refusal texts are unchanged. The checks before the query (lstat, link, system root) stay ahead of it.
  // The helper opens the path under the extended prefix, which skips the Win32 path parser; fsutil reads the path through
  // that parser. A path the parser may read as another entry or as a device is never asked: anything but a plain drive
  // path, or a component that is empty, ends in a dot or a space (so also `.` and `..`), holds a colon (a stream), a
  // slash, a wildcard or a control character, or names a reserved device (any case, with an extension, colon or padding).
  const reservedDevice = /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9\xb9\xb2\xb3])$/i;
  function parserMayRewrite(file) {
    if (!/^[A-Za-z]:\\/.test(file)) return true;
    if (file.length === 3) return false;
    return file.slice(3).split('\\').some(part => part === '' || /[. ]$/.test(part) || /[\u0000-\u001f/:*?"<>|]/.test(part)
      || reservedDevice.test(part.split('.')[0].replace(/^ +| +$/g, '')));
  }
  let reparseHelper;
  function reparseHelperDecides(current, label) {
    let answer;
    if (parserMayRewrite(current)) answer = { decided: false, reason: 'name-form' };
    else {
      if (reparseHelper === undefined) {
        try { reparseHelper = require(path.join(__dirname, 'lib', 'reparse-query.cjs')).create(); } catch { reparseHelper = null; }
      }
      answer = reparseHelper ? reparseHelper.ask(current) : { decided: false, reason: 'module' };
    }
    if (answer.decided === true) return true;
    process.stderr.write(`[reparse-query] fallback reason=${answer.reason}: ${label}\n`);
    return false;
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
          if (!reparseHelperDecides(current, label)) {
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

  // A selection file the host may own. The host copy is kept when it is provably the host's: it is host-owned data, or the earlier
  // installed manifest recorded a digest of the kernel copy and the file no longer matches it. A file that equals the kernel copy
  // up to line endings is a kernel copy (a Windows checkout with autocrlf only changes the line ends of the bytes the digest saw).
  // Where provenance is unknown (no installed manifest, or one that carries no digest for the file, as every 1.9 manifest) the
  // copy is an older kernel copy rather than a host edit when a kernel file imports it: keeping it leaves the new validator
  // loading a module without the exports it needs, so on update it is refreshed (the old copy goes to the backup).
  // A host edit proven once is remembered: the installed manifest drops the kernel digest of a kept file (the file is no longer a
  // kernel copy), so it records the path under hostEdited, and the next update keeps the file for as long as it is not the kernel
  // copy again. Without that memory the second update would find unknown provenance and replace the edit.
  // Returns 'kernel', 'host-owned', 'host-edit' (proven) or 'host-unknown' (kept because no kernel file imports it).
  const SHA256_WORD = /^sha256:[a-f0-9]{64}$/;
  function previouslyProvenHostEdit(destination) {
    const memory = previousManifest?.role === 'installed' ? previousManifest.hostEdited : undefined;
    if (memory === null || typeof memory !== 'object' || Array.isArray(memory)) return false;
    return Object.hasOwn(memory, destination) && typeof memory[destination] === 'string' && SHA256_WORD.test(memory[destination]);
  }
  function selectionOwner(destination, dst) {
    if (!selectionFiles.has(destination)) return 'kernel';
    if (hostOwned.has(destination)) return 'host-owned';
    const current = fs.readFileSync(dst);
    const recorded = previousManifest?.role === 'installed' ? previousManifest.contentDigest?.[destination] : undefined;
    if (typeof recorded === 'string') {
      return recorded !== 'sha256:' + sha256Of(current) && recorded !== 'sha256:' + sha256Of(lfBytes(current)) ? 'host-edit' : 'kernel';
    }
    const kernelCopy = path.join(SourceRoot, destination);
    if (fs.existsSync(kernelCopy) && Buffer.compare(lfBytes(current), lfBytes(fs.readFileSync(kernelCopy))) === 0) return 'kernel';
    if (previouslyProvenHostEdit(destination)) return 'host-edit';
    return kernelBound.has(destination) ? 'kernel' : 'host-unknown';
  }
  function keepsHostSelection(destination, dst) {
    return selectionOwner(destination, dst) !== 'kernel';
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
    } else if (keepsHostSelection(destination, dst)) {
      console.log(`[==] kept host selection file: ${destination}`);
      if (kernelBound.has(destination) && !hostOwned.has(destination)) {
        console.log(`[!!] ${destination} is changed by the host and kernel files import it; if the validator fails on it, compare it with the kernel copy`);
      }
      kept++;
    } else if (Force) {
      if (selectionFiles.has(destination)) console.log(`[~~] refreshing selection file ${destination}: it is a kernel copy, not a host edit (the previous copy goes to the backup)`);
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
    let installedBefore = null;
    if (fs.existsSync(dstManifest)) {
      const current = parseHostManifest(fs.readFileSync(dstManifest));
      if (current && current.role === 'installed') installedBefore = current;
    }
    // Without --host-role the declaration of the target is kept, including an invalid value so
    // session entry refuses it rather than reverting a staff PC to owner; none is invented.
    const role = decideHostRole(installedBefore, parsed.hostRole, parsed.confirmHostRole);
    if (role.set) installed.hostRole = role.value;
    console.log(`Host role: ${describeHostRole(role)}`);
    const current = installedBefore;
    if (current) {
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
    const contentDigest = {};
    const hostEdited = {};
    for (const relative of installed.managed) {
      if (relative === 'protocol-manifest.json') continue;
      if (hostOwned.has(relative)) continue;
      const source = path.join(SourceRoot, relative);
      const present = selectionFiles.has(relative) && fs.existsSync(path.join(TargetRoot, relative));
      const owner = present ? selectionOwner(relative, path.join(TargetRoot, relative)) : 'kernel';
      if (owner !== 'kernel') {
        // A preserved host modification is no longer a kernel copy. Leaving its
        // old digest here would make every subsequent validation fail; the proven
        // edit is remembered under hostEdited so that the next update keeps it too.
        if (owner === 'host-edit') hostEdited[relative] = 'sha256:' + sha256Of(fs.readFileSync(path.join(TargetRoot, relative)));
      } else if (fs.existsSync(source)) {
        contentDigest[relative] = 'sha256:' + getSha256Hex(source);
      }
    }
    installed.contentDigest = contentDigest;
    if (Object.keys(hostEdited).length) installed.hostEdited = hostEdited;
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

  // The validator refuses CR in a managed file (CM-70). A kept host selection file that holds CRLF (a Windows checkout of a host with
  // autocrlf) is converted to LF, and only that: only managed selection files, only CRLF pairs, only text that decodes as UTF-8,
  // and never a path the host's attributes say must stay CRLF or that a clean filter handles (the bytes would not be what the
  // filter stores). The previous bytes go to the backup, and a skipped file is reported.
  // Returns the value, or null when git cannot say (it failed, did not start, wrote to stderr, or answered in a form
  // parseAttributeAnswer does not know). Null is never "no attribute": the caller keeps the file.
  function attributeValue(relative, attribute) {
    const r = spawnSync('git', ['-C', TargetRoot, 'check-attr', attribute, '--', relative], { encoding: 'utf8', windowsHide: true });
    if (r.error || r.status !== 0 || String(r.stderr ?? '') !== '') return null;
    return parseAttributeAnswer(r.stdout, relative, attribute);
  }
  function normalizeKeptCrlf() {
    for (const relative of managed) {
      if (!selectionFiles.has(relative) || hostOwned.has(relative)) continue;
      const file = path.join(TargetRoot, relative);
      if (!fs.existsSync(file)) continue;
      let bytes;
      try { bytes = fs.readFileSync(file); } catch { continue; }
      if (!bytes.includes(0x0d)) continue;
      const skip = why => console.log(`[!!] CRLF kept in ${relative}: ${why}`);
      if (bytes.includes(0)) { skip('the file is binary'); continue; }
      try { strictUtf8.decode(bytes); } catch { skip('the file is not UTF-8 text'); continue; }
      const eol = attributeValue(relative, 'eol');
      const filter = attributeValue(relative, 'filter');
      const encoding = attributeValue(relative, 'working-tree-encoding');
      // Every doubt keeps the host file: the conversion needs a positive answer for each attribute.
      if (eol === null || filter === null || encoding === null) { skip('the git attributes of it could not be read'); continue; }
      if (eol === 'crlf') { skip('.gitattributes sets eol=crlf for it'); continue; }
      if (eol !== 'unspecified' && eol !== 'lf') { skip(`its eol attribute (${eol}) does not allow the conversion`); continue; }
      if (filter !== 'unspecified') { skip(`a clean filter (${filter}) applies to it`); continue; }
      if (encoding !== 'unspecified') { skip(`working-tree-encoding (${encoding}) applies to it`); continue; }
      const lf = lfBytes(bytes);
      if (lf.includes(0x0d)) { skip('it holds a CR that is not part of a CRLF pair'); continue; }
      writeBytes(relative, lf);
      console.log(`[ok] CRLF converted to LF: ${relative}`);
    }
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
  requireVersion(manifest.protocolVersion);
  const selectionFiles = new Set(manifest.selection?.files || []);
  const hostOwned = new Set(manifest.selection?.hostOwned || []);
  const managed = manifest.managed || [];
  const kernelBound = kernelBoundSelection(SourceRoot, managed, manifest.selection);
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
  if (!SelfInstall && fs.existsSync(previousPath)) previousManifest = parseHostManifest(fs.readFileSync(previousPath));
  // The review template is installed by the pilot kit, not by this installer; a checkout with core.autocrlf=true must still hold it as LF.
  const scopedPaths = [...new Set([...managed, ...integration, '.ai/**', 'AGENTS.md', 'CLAUDE.md', 'templates/reviews/REVIEW.md'])];
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
  if (!CheckOnly && Force) normalizeKeptCrlf();
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

module.exports = { runSetup, main, parseAttributeAnswer, decideHostRole, describeHostRole, parseHostManifest, HOST_ROLES };

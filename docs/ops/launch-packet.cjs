'use strict';
// Compile and place one kernel instruction inside the worktree that will be launched.
//   node launch-packet.cjs --worktree W --role R --stage S [--frame F] [--profile auto|1|2|3|4|full] [--client C]
//   Without --profile the compiler decides (the whole instruction while it fits 100000 bytes, else the first of the levels 3, 2, 1 that fits).
// Exit: 0 packet written; 1 compiler budget/frame gate; 2 usage or unusable input.
const fs = require('node:fs');
const path = require('node:path');

// The kernel reads its records from the working directory at its FIRST load (.ai/bin/lib/records.cjs REPO). A launch that starts in a
// scratch directory (launch-wrapper --engine dispatch runs its command there) has no protocol-manifest.json above it, so the compiler is
// loaded lazily and, only in that case, from the launched worktree. Inside any repository the load is exactly the old one.
let compiler = null;
function loadCompiler(root) {
  if (compiler) return compiler;
  const start = process.cwd();
  let inside = false;
  for (let dir = start; ;) {
    if (fs.existsSync(path.join(dir, 'protocol-manifest.json'))) { inside = true; break; }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    if (!inside) process.chdir(root);
    compiler = require('../../.ai/bin/protocol-packet.cjs');
  } finally {
    if (!inside) process.chdir(start);
  }
  return compiler;
}

const EXECUTOR_ROLES = new Set(['implementer', 'fixer', 'drafter', 'synthesiser']);
const DEFAULT_ROLES = new Set(['certifier', 'reviewer', 'auditor']);
const PROFILES = new Set(['auto', '1', '2', '3', '4', 'full']);
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SHA256 = /^sha256:[0-9a-f]{64}$/;

function realpath(io, file) {
  return io.realpathSync.native ? io.realpathSync.native(file) : io.realpathSync(file);
}

function isInside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

// lstat existence: only ENOENT means absent. A dangling symlink or junction leaf
// or parent still has a directory entry and must never be treated as "no path".
function lstatEntry(io, file) {
  try { return io.lstatSync(file); }
  catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

function physicalRoot(root, io = fs) {
  const absolute = path.resolve(root);
  let stat; let physical;
  try { stat = io.statSync(absolute); physical = realpath(io, absolute); }
  catch (error) { throw new Error(`launched worktree is not usable: ${error.message}`); }
  if (!stat.isDirectory()) throw new Error('launched worktree is not a directory');
  return { absolute, physical };
}

function assertContainedOutput(root, file, io = fs, createParent = false) {
  const boundary = physicalRoot(root, io);
  const target = path.resolve(file);
  if (!isInside(boundary.absolute, target)) throw new Error('output path is outside the launched worktree');
  const parent = path.dirname(target);
  if (!isInside(boundary.absolute, parent)) throw new Error('output parent is outside the launched worktree');

  // Walk the existing parent chain with lstat, never existsSync: a dangling or
  // reparse entry is still a directory entry and must be resolved, not skipped.
  // The deepest existing ancestor is realpath-resolved, which proves every
  // intermediate link in the chain stays inside the physical worktree.
  let cursor = parent;
  let deepest = null;
  for (;;) {
    const entry = lstatEntry(io, cursor);
    if (entry) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) throw new Error('output parent is not a directory');
      let physical;
      try { physical = realpath(io, cursor); }
      catch (error) { throw new Error(`output parent escapes the physical worktree: ${error.message}`); }
      if (!isInside(boundary.physical, physical)) throw new Error('output parent escapes the physical worktree');
      deepest = cursor;
      break;
    }
    if (cursor === boundary.absolute) break;
    const next = path.dirname(cursor);
    if (next === cursor || !isInside(boundary.absolute, next)) throw new Error('output parent is outside the launched worktree');
    cursor = next;
  }
  if (!deepest) throw new Error('output parent is outside the launched worktree');

  // Reject an existing destination leaf of any kind before creating anything:
  // a dangling symlink or junction leaf is exactly what writeFileSync with the
  // wx flag would follow to create a file outside the worktree on Windows.
  const leaf = lstatEntry(io, target);
  if (leaf) {
    if (leaf.isSymbolicLink()) throw new Error('output destination is a symlink or junction');
    if (!leaf.isFile()) throw new Error('output destination is not a regular file');
    let targetPhysical;
    try { targetPhysical = realpath(io, target); }
    catch (error) { throw new Error(`output destination escapes the physical worktree: ${error.message}`); }
    if (!isInside(boundary.physical, targetPhysical)) throw new Error('output destination escapes the physical worktree');
  }

  // Only after the whole chain and the leaf are proven safe may the parent be
  // created, and only below an ancestor already shown to be physically inside.
  if (createParent) io.mkdirSync(parent, { recursive: true });
  const parentEntry = lstatEntry(io, parent);
  if (!parentEntry) throw new Error('output parent does not exist');
  if (!parentEntry.isDirectory() && !parentEntry.isSymbolicLink()) throw new Error('output parent is not a directory');
  let parentPhysical;
  try { parentPhysical = realpath(io, parent); }
  catch (error) { throw new Error(`output parent escapes the physical worktree: ${error.message}`); }
  if (!isInside(boundary.physical, parentPhysical)) throw new Error('output parent escapes the physical worktree');
  return { ...boundary, target };
}

function writeContainedFile(root, file, text, io = fs) {
  const checked = assertContainedOutput(root, file, io, true);
  const present = lstatEntry(io, checked.target);
  if (present) {
    if (present.isSymbolicLink()) throw new Error('output destination is a symlink or junction');
    if (!present.isFile()) throw new Error('output destination is not a regular file');
    if (io.readFileSync(checked.target, 'utf8') === text) return checked.target;
    throw new Error('refusing to replace an existing packet output');
  }
  // Recheck the whole chain immediately before the exclusive create. The leaf
  // was already proven absent with lstat, so writeFileSync with the wx flag can
  // no longer follow a dangling symlink to create a file outside the worktree.
  assertContainedOutput(root, checked.target, io, false);
  io.writeFileSync(checked.target, text, { encoding: 'utf8', flag: 'wx' });
  const after = assertContainedOutput(root, checked.target, io, false);
  if (!isInside(after.physical, realpath(io, after.target))) throw new Error('written output escaped the physical worktree');
  return checked.target;
}

function parseArgs(argv) {
  const o = {};
  const valued = new Set(['--worktree', '--role', '--stage', '--frame', '--profile', '--client']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!valued.has(a)) return { error: `unknown argument ${a}` };
    if (i + 1 >= argv.length) return { error: `${a} needs a value` };
    o[a.slice(2)] = argv[++i];
  }
  return o;
}

function switchRoles(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value || value === 'off') return { enabled: false, roles: new Set() };
  if (value === 'on') return { enabled: true, roles: new Set(DEFAULT_ROLES) };
  const roles = new Set(value.split(',').map(x => x.trim()).filter(Boolean));
  return { enabled: true, roles };
}

function policy(raw, role, allowExecutor) {
  const sw = switchRoles(raw);
  if (!sw.enabled) return { active: false };
  if (EXECUTOR_ROLES.has(role) && !allowExecutor) return { active: false, refused: `executor packet role "${role}" needs --allow-executor-packet` };
  return { active: sw.roles.has(role), allowed: sw.roles };
}

// The dispatch default comes from one shared function; legacy OPERATOR_PACKET is unchanged.
function deliveryPolicy(env, role, allowExecutor, engine = env.PROTOCOL_PACKET_ENGINE || 'legacy') {
  if (engine !== 'dispatch') return policy(env.OPERATOR_PACKET, role, allowExecutor);
  return require('../../.ai/bin/protocol-dispatch/packet.cjs').decision(env);
}

// The profile a caller named, or undefined when it named none. Only the absence of a value means "no profile"; an empty string, `default`, a number or any other
// value is refused, so the marker the compiler uses for an absent profile can never be named from outside.
function namedProfile(raw) {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' || !PROFILES.has(raw)) throw Object.assign(new Error(`unknown packet profile "${String(raw).slice(0, 40)}"`), { exitCode: 2 });
  return raw;
}
// The label a launch record keeps for an unnamed profile: what the compiler delivered (a step-down level, or `full` when the whole instruction fit).
function effectiveProfile(manifest) {
  return manifest && manifest.profile && Number.isInteger(manifest.profile.level) ? String(manifest.profile.level) : 'full';
}

function preparePacket(opts, deps = {}) {
  const io = deps.fs || fs;
  const root = path.resolve(opts.worktree);
  const compile = deps.compile || ((...a) => loadCompiler(root).compile(...a));
  // The default profile is decided in one place, the compiler (PROTO-DEC-0187 item 1): a caller that names no profile passes none, and a name is checked against the closed set.
  // No launcher substitutes `full` for an absent profile; that would be a second, different default.
  const named = namedProfile(opts.profile);
  if (!opts.role || !opts.stage) throw Object.assign(new Error('packet needs role and stage'), { exitCode: 2 });
  if (!SAFE_SEGMENT.test(opts.role) || !SAFE_SEGMENT.test(opts.stage)) throw Object.assign(new Error('packet role and stage must be safe path segments'), { exitCode: 2 });
  physicalRoot(root, io);
  const frame = opts.frame ? path.resolve(root, opts.frame) : undefined;
  if (frame) {
    const checkedFrame = assertContainedOutput(root, frame, io, false);
    if (!lstatEntry(io, checkedFrame.target)) throw Object.assign(new Error('packet frame does not exist'), { exitCode: 2 });
  }
  let result;
  try { result = compile({ root, role: opts.role, stage: opts.stage, frame, ...(named === undefined ? {} : { profile: named }), client: opts.client }); }
  catch (error) { throw Object.assign(new Error(error.message), { exitCode: 2 }); }
  if (!result || result.exit !== 0 || !result.manifest || !result.text) {
    const reason = result && result.report && result.report.reason ? result.report.reason : `compiler exit ${result && result.exit}`;
    throw Object.assign(new Error(reason), { exitCode: result && Number.isInteger(result.exit) ? result.exit : 1 });
  }
  if (!SHA256.test(result.treeSha || '') || !SHA256.test(result.packetHash || '')) throw Object.assign(new Error('compiler returned an invalid SHA-256 identifier'), { exitCode: 2 });
  if (typeof result.text !== 'string' || result.manifest.bytes !== Buffer.byteLength(result.text, 'utf8')
      || !Number.isSafeInteger(result.manifest.estTokens) || result.manifest.estTokens < 0) {
    throw Object.assign(new Error('packet-measurement-invalid'), { exitCode: 2 });
  }
  const dir = path.join(root, '.ai', 'runtime', 'launch-packets');
  const leaf = `${opts.role}-${opts.stage}-${result.treeSha.slice(7, 15)}-${result.packetHash.slice(7, 15)}.md`;
  const file = path.join(dir, leaf);
  writeContainedFile(root, file, result.text, io);
  const relative = path.relative(root, file).split(path.sep).join('/');
  return {
    pointerLine: `Read ${relative} first, it is your compiled instruction`, packetPath: relative,
    packetHash: result.packetHash, role: opts.role, stage: opts.stage, profile: named === undefined ? effectiveProfile(result.manifest) : named,
    bytes: result.manifest.bytes, estTokens: result.manifest.estTokens,
  };
}

function main(argv) {
  const o = parseArgs(argv);
  if (o.error || !o.worktree || !o.role || !o.stage) { process.stderr.write(`${o.error || 'usage: launch-packet.cjs --worktree W --role R --stage S [--frame F] [--profile P] [--client C]'}\n`); return 2; }
  try {
    const result = preparePacket(o);
    process.stdout.write(`POINTER ${result.pointerLine}\n`);
    process.stdout.write(`PACKET packetHash=${result.packetHash} role=${result.role} stage=${result.stage} profile=${result.profile} bytes=${result.bytes} path=${result.packetPath}\nRESULT exit=0\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`PACKET REFUSED reason=${JSON.stringify(error.message)}\nRESULT exit=${error.exitCode || 1}\n`);
    return error.exitCode || 1;
  }
}

module.exports = { EXECUTOR_ROLES, DEFAULT_ROLES, PROFILES, SAFE_SEGMENT, parseArgs, switchRoles, policy, deliveryPolicy, physicalRoot, assertContainedOutput, writeContainedFile, preparePacket, namedProfile, effectiveProfile, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

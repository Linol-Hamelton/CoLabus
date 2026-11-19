'use strict';
// Compile and place one kernel instruction inside the worktree that will be launched.
//   node launch-packet.cjs --worktree W --role R --stage S [--frame F] [--profile auto|1|2|3|4|full] [--client C] [--retrieval FILE] [--context FILE]
//   Without --profile the compiler decides (the whole instruction while it fits 100000 bytes, else the first of the levels 3, 2, 1 that fits).
//   The architecture context is not counted in that load target: a packet is refused for its size only above the safety limit of the compiler.
// Exit: 0 packet written; 1 compiler budget/frame gate; 2 usage or unusable input.
const fs = require('node:fs');
const path = require('node:path');
const realPath = require('../../.ai/bin/lib/real-path.cjs');

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
  return io.realpathSync.native ? realPath.forFs(io).realPathSync(file) : io.realpathSync(file);
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
  const valued = new Set(['--worktree', '--role', '--stage', '--frame', '--profile', '--client', '--retrieval', '--context']);
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

function readRetrieval(value, io) {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object') return value;
  let text;
  try { text = io.readFileSync(path.resolve(String(value)), 'utf8'); } catch (error) { throw Object.assign(new Error(`retrieval result ${String(value).slice(0, 120)} is not readable (${error.code || 'error'})`), { exitCode: 2 }); }
  try { return JSON.parse(text); } catch { throw Object.assign(new Error(`retrieval result ${String(value).slice(0, 120)} is not JSON`), { exitCode: 2 }); }
}

// ---------- the architecture context of a launch ----------
// While the packet context is switched on in the coupled-set registry of the candidate commit, every author and certifier launch carries a
// packet compiled with the architecture context of its task: the packet role follows the launch role unless the caller names one, and the
// context is resolved from the git objects of the candidate commit, or a document made for that commit is taken. The launch gate of the
// packet has a key of its own (protocol-context.cjs gateAt): while the gate is on and the context off, the launch still gets the packet of
// its role, compiled without a context, and the gate still stands behind it. With both off nothing here is resolved or written, and the
// launch is the one without it.
// The documents go to the launch-context folder of the runtime root of the worktree, a path relative to the worktree with forward slashes.
const CONTEXT_DIR = path.posix.join('.ai', 'runtime', 'launch-context');
const LAUNCH_PACKET_ROLES = Object.freeze({ author: ['implementer', 'execute'], fixer: ['fixer', 'execute'], certifier: ['certifier', 'accept'], 'pre-review': ['reviewer', 'accept'] });
const STREAM = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
// A refusal of the context step carries the code of the launch gate it means (.ai/bin/lib/packet-gate.cjs contextStepCode); an unreadable switch carries
// none, the state of the gate is not known and the launch is refused as it was.
const refuseContext = reason => Object.assign(new Error(reason), { code: 'CONTEXT_REFUSED', exitCode: 3, gate: require('../../.ai/bin/lib/packet-gate.cjs').contextStepCode(reason) });
const reasonText = error => String((error && error.message) || error).replace(/[\r\n]+/g, ' ').slice(0, 200);
function contextTool(root) {
  loadCompiler(root);
  return require('../../.ai/bin/protocol-context.cjs');
}
// The level the resolver is asked for: the contextLevel of the client in .ai/docs/clients.json, and without one C3 (the whole context of the task)
// for a client that opens files and C1 for one that does not. The level follows what the task and the client need, never the size of the packet;
// the pulse shows the delivered level and size of every launch.
function contextLevelFor(root, client) {
  const profile = loadCompiler(root).clientProfile(root, client);
  return profile.contextLevel || (profile.fileAccess ? 'C3' : 'C1');
}
// The base of the candidate: the stated revision, else the merge base with the integration branch (the one rule of cert-economy.cjs baseOf).
function contextBase(worktree, stated, run) {
  const economy = require('./cert-economy.cjs');
  const b = economy.baseOf(worktree, stated, economy.gitOf(worktree, run));
  if (!b.ok) throw refuseContext(`context-base-unknown ${b.reason}`);
  return b.sha;
}
// The stream of the launch: the stated one, else the branch the worktree stands on; a detached head or a branch that is no plain name names none here (knownStream looks further).
function contextStream(stated, branch) {
  const name = stated !== undefined ? stated : branch;
  if (typeof name !== 'string' || !STREAM.test(name) || name === 'HEAD') throw refuseContext(stated !== undefined ? 'context-stream-unsafe' : 'context-stream-unknown');
  return name;
}
// A detached head names no branch, and the certifier procedure launches from a detached worktree on the exact commit. The stream is then taken from
// what the launch already knows, both read in the shared runtime folder of the main checkout: first the live claim of this worktree (a claim that
// reads by its schema, names an owner, has not run out its time and is not dated ahead), then the live candidate row of that exact commit (a row
// that is building, ready, certifying or certified). A retired, void, superseded or landed row, an expired claim and a claim of another worktree
// are never a source. Only a source that names no stream leaves it unknown; one that names two refuses as ambiguous.
const CLAIM_CLOCK_SKEW_MS = 60000;
const CLAIM_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const LIVE_CANDIDATE = ['building', 'ready', 'certifying', 'certified'];
// The claims of the file, or null when the file does not read by the schema of the claims register (one bad row makes it unusable, as for the register itself).
// The register is read the way its tool reads it (docs/ops/ops-guard.cjs readClaims): the bytes decode with a byte order mark stripped, line ends
// normalised and invisible characters refused, the keys are those of the register, the stream is one of its names, the owner reads with its
// machine and names its namespaced owner truly, the dates are real UTC times in one spelling and the seats are those of the register.
const CLAIM_STREAM = /^[a-z0-9][a-z0-9-]{0,127}$/;
const CLAIM_SEAT = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;
const claimDate = value => {
  if (typeof value !== 'string' || !CLAIM_DATE.test(value)) return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === (value.includes('.') ? value : `${value.slice(0, -1)}.000Z`);
};
const claimTtl = n => Number.isSafeInteger(n) && n >= 1 && n <= 525600;
function readClaimRows(input) {
  const safe = require('../../.ai/bin/lib/text-safe.cjs');
  let parsed;
  try {
    const decoded = safe.decode(Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8'), { bom: 'strip', crlf: 'normalise', invisible: 'refuse' });
    if (!decoded.ok) return null;
    parsed = safe.parseJsonUnique(decoded.text);
  } catch { return null; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).join() !== 'claims' || !Array.isArray(parsed.claims)) return null;
  const owners = require('../../.ai/bin/lib/owner-identity.cjs');
  const streams = new Set();
  for (const c of parsed.claims) {
    if (!c || typeof c !== 'object' || Array.isArray(c) || typeof c.stream !== 'string' || !CLAIM_STREAM.test(c.stream) || streams.has(c.stream)) return null;
    streams.add(c.stream);
    let identity;
    try { identity = owners.parseOwnerIdentity(c.owner, c.machine); } catch { return null; }
    if (c.namespacedOwner !== undefined && c.namespacedOwner !== identity.namespaced) return null;
    if (!claimDate(c.since) || !claimTtl(c.ttlMin)) return null;
    if (c.worktree !== undefined && c.worktree !== null && (typeof c.worktree !== 'string' || !path.isAbsolute(c.worktree))) return null;
    if (c.seats !== undefined) {
      if (!Array.isArray(c.seats)) return null;
      const names = new Set();
      for (const seat of c.seats) {
        if (!seat || typeof seat !== 'object' || Array.isArray(seat) || Object.keys(seat).some(k => !['name', 'since', 'ttlMin', 'generationSince'].includes(k))
          || typeof seat.name !== 'string' || !CLAIM_SEAT.test(seat.name) || seat.name.endsWith('.') || names.has(seat.name) || !claimDate(seat.since)
          || (seat.generationSince !== undefined && !claimDate(seat.generationSince)) || !claimTtl(seat.ttlMin)) return null;
        names.add(seat.name);
      }
    }
  }
  return parsed.claims;
}
function knownStream(root, head, run, io, now = Date.now()) {
  const main = require('../../.ai/bin/lib/packet-gate.cjs').mainCheckout(run, root);
  if (!main) return null;
  const readIn = name => { try { return io.readFileSync(path.join(main, '.ai', 'runtime', name)); } catch { return null; } };
  const only = (streams, source) => {
    const names = [...new Set(streams)];
    if (names.length > 1) throw refuseContext(`context-stream-ambiguous ${source} names ${names.join(' and ')}`);
    return names.length === 1 && STREAM.test(names[0]) && names[0] !== 'HEAD' ? names[0] : null;
  };
  const claims = readIn('claims.json');
  if (claims !== null) {
    const same = (a, b) => typeof a === 'string' && typeof b === 'string' && path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase();
    const live = c => { const since = Date.parse(c.since); return since <= now + CLAIM_CLOCK_SKEW_MS && since + c.ttlMin * 60000 > now; };
    const found = only((readClaimRows(claims) || []).filter(c => same(c.worktree, root) && live(c)).map(c => c.stream), 'the claims of this worktree');
    if (found) return found;
  }
  const registry = readIn('CANDIDATES.md');
  if (registry !== null) {
    let rows = [];
    try { rows = require('../../.ai/bin/lib/candidate-registry.cjs').parseRegistry(String(registry)).rows.map(r => r.cells).filter(c => c[2] === head && LIVE_CANDIDATE.includes(c[4])); } catch { rows = []; }
    return only(rows.map(c => c[0]), 'the candidate registry');
  }
  return null;
}
// A context document named by the caller is taken only when it was made for the commit the launch stands on.
function contextCommitOf(root, file, io) {
  const target = path.resolve(root, file);
  assertContainedOutput(root, target, io, false);
  if (!lstatEntry(io, target)) throw refuseContext('context-document-missing');
  let doc;
  try { doc = require('../../.ai/bin/lib/text-safe.cjs').parseJsonUnique(io.readFileSync(target, 'utf8')); } catch { throw refuseContext('context-document-unreadable'); }
  return { rel: path.relative(root, target).split(path.sep).join('/'), commit: doc && typeof doc.commit === 'string' ? doc.commit : null,
    stream: doc && typeof doc.stream === 'string' && STREAM.test(doc.stream) && doc.stream !== 'HEAD' ? doc.stream : null };
}
// One decision for every launcher. null while the switch is off at the head or when the launch role has no packet role; else the packet role, its
// stage, the context document of the candidate commit, relative to the worktree, and the stream it was made for (the launch record names it).
// A refusal carries the code CONTEXT_REFUSED.
// The switch at the head of the launched worktree: { state: on|off, commit }; a registry of the commit that does not read refuses the launch.
function contextSwitchAt(worktree, head, deps = {}) {
  const root = path.resolve(worktree);
  let sw;
  try { sw = (deps.contextSwitch || ((dir, at) => contextTool(dir).switchAt(dir, at)))(root, head); }
  catch { throw refuseContext('context-switch-unreadable'); }
  return sw && sw.state === 'on' ? sw : { state: 'off', commit: sw ? sw.commit || null : null };
}
// The launch gate at the head of the launched worktree: { state: on|off, commit }; a registry that does not read refuses the launch.
function gateSwitchAt(worktree, head, deps = {}) {
  const root = path.resolve(worktree);
  let gate;
  try { gate = (deps.gateSwitch || ((dir, at) => contextTool(dir).gateAt(dir, at)))(root, head); }
  catch { throw refuseContext('gate-switch-unreadable'); }
  return gate && gate.state === 'on' ? { state: 'on', commit: gate.commit } : { state: 'off', commit: gate ? gate.commit || null : null };
}
// A plan carries gate on or off: the engines stop a launch by the codes of the gate only while it is on, and a refusal of the context step
// carries the state of the gate (gateOn) for the same reason.
function contextPacket(input, deps = {}) {
  const root = path.resolve(input.worktree);
  const sw = contextSwitchAt(root, input.head, deps);
  const gate = gateSwitchAt(root, input.head, deps);
  if (sw.state !== 'on' && gate.state !== 'on') return null;
  try { return contextPlan(input, deps, root, sw, gate); }
  catch (error) { if (error && error.code === 'CONTEXT_REFUSED') error.gateOn = gate.state === 'on'; throw error; }
}
function contextPlan(input, deps, root, sw, gate) {
  const io = deps.fs || fs;
  const named = Boolean(input.packetRole);
  // a launch role is looked up among the own keys of the table only: a name the object inherits is no launch role
  const [role, stage] = named ? [input.packetRole, input.packetStage] : (typeof input.launchRole === 'string' && Object.hasOwn(LAUNCH_PACKET_ROLES, input.launchRole) ? LAUNCH_PACKET_ROLES[input.launchRole] : []);
  if (!role) return null;
  if (named && EXECUTOR_ROLES.has(role) && !input.allowExecutor) throw refuseContext(`executor packet role "${role}" needs --allow-executor-packet`);
  const launchRole = EXECUTOR_ROLES.has(role) ? 'author' : 'certifier';
  // the gate on and the context off: the packet of the role without a context; a document handed in is not taken
  if (sw.state !== 'on') return { role, stage, context: null, commit: gate.commit, gate: 'on' };
  if (input.contextFile !== undefined) {
    // the map of a checker is built from the candidate commit by the launcher itself, never handed in, so no author can narrow it
    if (launchRole !== 'author') throw refuseContext('context-document-for-a-checker');
    const given = contextCommitOf(root, input.contextFile, io);
    if (given.commit !== sw.commit) throw refuseContext('context-commit-differs');
    return { role, stage, context: given.rel, commit: sw.commit, gate: gate.state, ...(given.stream ? { stream: given.stream } : {}) };
  }
  if (!input.taskFile) throw refuseContext('context-task-missing');
  const run = input.run || deps.spawnSync || require('node:child_process').spawnSync;
  let branch = input.branch;
  if (input.stream === undefined && branch === undefined) {
    const r = run('git', ['-C', root, 'rev-parse', '--abbrev-ref', 'HEAD'], { encoding: 'utf8', windowsHide: true });
    branch = r && r.status === 0 ? String(r.stdout || '').trim() : undefined;
  }
  let stream;
  try { stream = contextStream(input.stream, branch); }
  catch (error) {
    // a stated stream is never replaced; only a launch that names none looks further, and refuses as before when no source names one
    const found = input.stream === undefined && error && error.message === 'context-stream-unknown' ? knownStream(root, input.head, run, io) : null;
    if (!found) throw error;
    stream = found;
  }
  const base = contextBase(root, input.base, run);
  let level, r;
  try {
    level = contextLevelFor(root, input.client);
    r = contextTool(root).resolve({ root, commit: sw.commit, base, stream, launchRole, task: path.resolve(input.taskFile), level });
  } catch (error) { throw refuseContext(`context-resolve-failed ${reasonText(error)}`); }
  const rel = `${CONTEXT_DIR}/${launchRole}-${r.doc.level}-${require('node:crypto').createHash('sha256').update(r.text).digest('hex').slice(0, 16)}.json`;
  writeContainedFile(root, path.join(root, ...rel.split('/')), r.text, io);
  return { role, stage, context: rel, commit: sw.commit, stream, gate: gate.state };
}

// The pointer of a prompt follows the packet the launch compiled. A prompt whose first line is the pointer line of another compiled packet
// (a launch moved to a client whose packet differs, or a prompt written for another head) is read through a copy in the launch-prompt
// folder of the worktree whose first line points to this packet; the prompt file itself never changes, so the pins on it hold.
// -> the copy (an absolute path), or null when the prompt names no other packet.
const POINTER_LINE = /^Read (\.ai\/runtime\/launch-packets\/[A-Za-z0-9._-]+\.md) first, it is your compiled instruction\r?$/;
function followPointer({ worktree, promptFile, name, packet }, io = fs) {
  if (!packet || typeof packet.packetPath !== 'string' || typeof packet.pointerLine !== 'string' || typeof promptFile !== 'string') return null;
  const root = path.resolve(worktree);
  let text;
  try { text = io.readFileSync(path.resolve(root, promptFile), 'utf8'); } catch { return null; }
  const end = text.indexOf('\n');
  const m = POINTER_LINE.exec(end < 0 ? text : text.slice(0, end));
  if (!m || m[1] === packet.packetPath) return null;
  if (typeof name !== 'string' || !SAFE_SEGMENT.test(name)) throw Object.assign(new Error('the launch name is no safe file name for the copy of its prompt'), { exitCode: 2 });
  const copy = path.join(root, '.ai', 'runtime', 'launch-prompts', `${name}-pointer.md`);
  writeContainedFile(root, copy, `${packet.pointerLine}${end < 0 ? '\n' : text.slice(end)}`, io);
  return copy;
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
  // Rules retrieval: a retrieval result (rules-retrieval/1, made by .ai/bin/protocol-retrieval.cjs) is data the compiler checks and applies;
  // a path is read here, an object is passed as it is. No retrieval given: the packet is the one compiled without it.
  const retrieval = readRetrieval(opts.retrieval, io);
  // The architecture context: a task-context/1 document inside the launched worktree (contextPacket above); the compiler checks and applies it.
  const context = opts.context ? path.resolve(root, opts.context) : undefined;
  if (context) {
    const checkedContext = assertContainedOutput(root, context, io, false);
    if (!lstatEntry(io, checkedContext.target)) throw Object.assign(new Error('packet context document does not exist'), { exitCode: 2 });
  }
  let result;
  try { result = compile({ root, role: opts.role, stage: opts.stage, frame, ...(named === undefined ? {} : { profile: named }), client: opts.client, ...(retrieval === undefined ? {} : { retrieval }), ...(context === undefined ? {} : { context }) }); }
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
    ...(result.manifest.retrieval ? { retrieval: { source: result.manifest.retrieval.source, applied: result.manifest.retrieval.applied, note: result.manifest.retrieval.note } } : {}),
    ...(result.manifest.context ? { context: { level: result.manifest.context.level, commit: result.manifest.context.commit, targets: result.manifest.context.rows.targets, trimmed: result.manifest.context.trimmed } } : {}),
  };
}

function main(argv) {
  const o = parseArgs(argv);
  if (o.error || !o.worktree || !o.role || !o.stage) { process.stderr.write(`${o.error || 'usage: launch-packet.cjs --worktree W --role R --stage S [--frame F] [--profile P] [--client C] [--retrieval FILE] [--context FILE]'}\n`); return 2; }
  try {
    const result = preparePacket(o);
    if (result.retrieval) process.stdout.write(`RETRIEVAL source=${result.retrieval.source} applied=${result.retrieval.applied} note=${JSON.stringify(result.retrieval.note)}
`);
    if (result.context) process.stdout.write(`CONTEXT level=${result.context.level} commit=${result.context.commit}\n`);
    process.stdout.write(`POINTER ${result.pointerLine}\n`);
    process.stdout.write(`PACKET packetHash=${result.packetHash} role=${result.role} stage=${result.stage} profile=${result.profile} bytes=${result.bytes} path=${result.packetPath}\nRESULT exit=0\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`PACKET REFUSED reason=${JSON.stringify(error.message)}\nRESULT exit=${error.exitCode || 1}\n`);
    return error.exitCode || 1;
  }
}

module.exports = { loadCompiler, EXECUTOR_ROLES, DEFAULT_ROLES, PROFILES, SAFE_SEGMENT, CONTEXT_DIR, LAUNCH_PACKET_ROLES, parseArgs, switchRoles, policy, deliveryPolicy, physicalRoot, assertContainedOutput, writeContainedFile, contextSwitchAt, gateSwitchAt, contextPacket, followPointer, contextLevelFor, contextBase, contextStream, knownStream, preparePacket, namedProfile, effectiveProfile, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

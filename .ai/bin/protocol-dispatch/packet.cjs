'use strict';
// Packet wiring for protocol-dispatch (PROTO-DEC-0162, 0165).
// Dispatch delivery defaults ON (PROTO-DEC-0183.5). Explicit 0/off or slot.packet=false rolls it back.
// Legacy launchers keep their existing policy. Compilation failures block the slot before any client launches.
// The dispatch module imports the compiler; the compiler imports nothing of dispatch (one direction only).

const fs = require('node:fs');
const path = require('node:path');
const paths = require('../lib/path-safe.cjs');
const texts = require('../lib/text-safe.cjs');
const PG = require('../lib/packet-gate.cjs');

const SWITCH = 'PROTOCOL_PACKET_WIRING';
const MARKER = '{{PACKET}}';
const RUNTIME_DIR = '.ai/runtime/dispatch-packet';

// The one default/rollback decision shared by the dispatch CLI and tracked launchers.
function decision(env = process.env, slot = {}, engine = 'dispatch') {
  if (engine !== 'dispatch') return { active: false };
  const raw = env[SWITCH];
  if (raw !== undefined && typeof raw !== 'string') return { active: false, refused: 'packet-switch-invalid' };
  const value = raw === undefined ? '' : raw.trim().toLowerCase();
  if (!['', '1', 'on', '0', 'off'].includes(value)) return { active: false, refused: 'packet-switch-invalid' };
  return { active: value !== '0' && value !== 'off' && slot.packet !== false };
}
const enabled = (env = process.env) => decision(env).active;
// Slot-aware form for the dispatch CLI (one decision, one extra positive rule). The default has no context to compile for a slot that carries no
// packet key: the launch proceeds without a packet and says so (skipped, never silent). An explicit ON (1/on) still demands a packet, and a
// partial context (packet key without role/stage) is refused by prepare().
function slotDecision(env = process.env, slot = {}) {
  const base = decision(env, slot);
  if (!base.active || slot.packet !== undefined) return base;
  const raw = typeof env[SWITCH] === 'string' ? env[SWITCH].trim().toLowerCase() : '';
  return raw === '' ? { active: false, skipped: 'packet-context-absent' } : base;
}
// The launch gate of the packet for one slot (lib/packet-gate.cjs), only while its key is on at the head of the repository the dispatch runs in or
// on the integration line (protocol-context.cjs gateAt). A slot whose seat is an executor or a checker starts only with a packet, from a head whose
// decision log holds every accepted block of the main checkout and of the integration line; while the packet context is switched on too, the
// packet carries a context document made for that head. A reviewer slot gets the same findings as warnings. The dispatcher has no bypass: a
// refused slot is blocked with the code. An unreadable switch or gate key refuses a gated slot. The switch of the context is read only for a
// gated slot while the gate is on, the one case it decides anything in.
// -> { state: 'off' } or { state: 'on', kind, findings: [{ code, reason }] }
function gateSlot(slot, repoRoot, env = process.env, deps = {}, kind = PG.slotGateOf(slot && slot.role)) {
  const root = path.resolve(repoRoot);
  // The caller can pass the kind resolved from its single read of the slot role.
  const unreadable = () => (kind ? { state: 'on', kind, findings: [{ code: PG.CODES.required, reason: 'packet-switch-unreadable' }] } : { state: 'off' });
  let sw; let gate;
  try { gate = (deps.gateAt || (dir => require('../protocol-context.cjs').gateAt(dir, 'HEAD')))(root); } catch { return unreadable(); }
  if (!gate || gate.state !== 'on') return { state: 'off' };
  if (!kind) return { state: 'on', kind: null, findings: [] };
  try { sw = (deps.switchAt || (dir => require('../protocol-context.cjs').switchAt(dir, 'HEAD')))(root); } catch { return unreadable(); }
  const findings = [];
  const spec = slot.packet;
  const contextOn = Boolean(sw && sw.state === 'on');
  if (!decision(env, slot).active || !spec || typeof spec !== 'object') findings.push({ code: PG.CODES.required, reason: spec === false ? 'packet-off-for-the-slot' : !spec ? 'packet-key-absent' : 'packet-switched-off' });
  else if (!contextOn) { /* the context is switched off: the packet of the slot comes without one */ }
  else if (!spec.context) findings.push({ code: PG.CODES.context, reason: 'context-absent' });
  else {
    const read = paths.readFileGuarded(root, spec.context);
    let commit = null;
    try { commit = read.ok ? texts.parseJsonUnique(Buffer.from(read.bytes).toString('utf8')).commit : null; } catch { commit = null; }
    if (commit !== sw.commit) findings.push({ code: PG.CODES.stale, reason: 'context-commit-differs' });
  }
  const ahead = PG.decisionsAhead({ worktree: root, commit: gate.commit, run: deps.run || require('node:child_process').spawnSync, io: deps.fs || fs });
  if (!ahead.ok) findings.push(PG.decisionsRefusal(ahead));
  return { state: 'on', kind, findings, context: contextOn };
}
// The gate of one slot of a dispatch run: a slot whose role the gate does not name is never stopped, warned or given the gate (gateSlot answers
// it with no finding and prepare looks only at a slot that stops), so its run reads nothing for the gate: no key, no switch, no git process.
function launchGate(slot, repoRoot, env = process.env, deps = {}) {
  const kind = PG.slotGateOf(slot && slot.role);
  return kind ? gateSlot(slot, repoRoot, env, deps, kind) : { state: 'off' };
}
const hex = value => String(value || '').replace(/^sha256:/, '');
const safeName = id => String(id).replace(/[^A-Za-z0-9._-]/g, '_');

// Total text conversion: a hostile value (null-prototype object, throwing toString/getter/Proxy) never throws, it yields a constant.
const UNPRINTABLE = 'unprintable compiler value';
function safeString(value) {
  try { return String(value); } catch { return UNPRINTABLE; }
}
function reasonOf(e) {
  let message;
  try { message = e && e.message; } catch { return UNPRINTABLE; }
  return safeString(message || e);
}
// Compiler errors are untrusted: only fixed diagnostics and numeric exits leave the process.
const oneLine = (value, max) => {
  const s = safeString(value);
  return ['null', 'undefined', UNPRINTABLE].includes(s) || /^compile exit [0-9]{1,3}$/.test(s)
    ? s.slice(0, max) : 'compiler diagnostic withheld';
};

// One compile per slot and run, in process. The shape is decided once for the whole slot: "pointer" is used only when every route
// of the slot is the same client and that client can open a file; otherwise the compiled text is delivered inline.
// TOTAL: whatever the compiler throws or returns, this returns a result and never throws with the start lock held.
function prepare(slot, repoRoot, routeClients, deps = {}) {
  try {
    return prepareChecked(slot, repoRoot, routeClients, deps);
  } catch (e) {
    return { ok: false, reason: `packet-compile-failed: ${oneLine(reasonOf(e), 300)}` };
  }
}

function prepareChecked(slot, repoRoot, routeClients, deps) {
  const spec = slot.packet;
  if (!spec || typeof spec !== 'object' || !slot.role || !spec.stage) return { ok: false, reason: 'packet-context-required' };
  if (typeof slot.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(slot.id)
      || paths.segmentProblem(slot.id) || /^(?:sk-|ghp_|github_pat_)/i.test(slot.id)) {
    return { ok: false, reason: 'packet-slot-id-invalid' };
  }
  const clients = [...new Set((routeClients || []).filter(Boolean))];
  const client = clients[0] || undefined;
  if (spec.frame) {
    const frame = paths.readFileGuarded(path.resolve(repoRoot), spec.frame);
    if (!frame.ok) return { ok: false, reason: 'packet-frame-unreadable' };
  }
  // The architecture context of the slot is the same task-context/1 document the launchers give the compiler; it checks and applies it.
  if (spec.context) {
    const context = paths.readFileGuarded(path.resolve(repoRoot), spec.context);
    if (!context.ok) return { ok: false, reason: 'packet-context-unreadable' };
  }
  let compiler;
  try { compiler = deps.compiler || require('../protocol-packet.cjs'); } catch { return { ok: false, reason: 'packet-compiler-unavailable' }; }
  let result;
  try {
    result = compiler.compile({
      root: repoRoot,
      role: slot.role,
      stage: spec.stage,
      frame: spec.frame ? path.resolve(repoRoot, spec.frame) : undefined,
      triggers: spec.triggers,
      client,
      ...(spec.context ? { context: path.resolve(repoRoot, spec.context) } : {}),
    });
  } catch (e) {
    return { ok: false, reason: `packet-compile-failed: ${oneLine(reasonOf(e), 300)}` };
  }
  // A null, undefined or otherwise result-less compiler outcome is the same contract violation as an incomplete one: fail closed and visibly.
  if (!result || typeof result !== 'object') {
    return { ok: false, reason: `packet-compile-failed: the compiler returned no result (${result === null ? 'null' : typeof result})` };
  }
  // Snapshot the result once: every property read is guarded, so a throwing getter or Proxy becomes a managed refusal.
  let snap;
  try {
    snap = { exit: result.exit, text: result.text, packetHash: result.packetHash, treeSha: result.treeSha, manifest: result.manifest };
    if (snap.exit !== 0) snap.why = result.report && result.report.reason ? result.report.reason : `compile exit ${safeString(snap.exit)}`;
    else if (snap.manifest) snap.fileAccess = Boolean(snap.manifest.fileAccess);
  } catch (e) {
    return { ok: false, reason: `packet-compile-failed: the compiler result could not be read (${oneLine(reasonOf(e), 200)})` };
  }
  // the floor of the architecture context that does not fit is named by its code (the compiler gives that one diagnostic as a fixed word)
  if (snap.exit !== 0 && safeString(snap.why).startsWith(PG.CODES.floor)) return { ok: false, reason: PG.CODES.floor };
  if (snap.exit !== 0) return { ok: false, reason: `packet-compile-failed: ${oneLine(snap.why, 300)}` };
  // A compiler that reports success without text or hashes (a contract violation) must fail closed like any other compile failure, never throw with the start lock held.
  if (typeof snap.text !== 'string' || !snap.text || !snap.packetHash || !snap.treeSha || !snap.manifest) {
    return { ok: false, reason: 'packet-compile-failed: the compiler returned exit 0 without a complete packet (text, packetHash, treeSha, manifest)' };
  }
  if (typeof snap.packetHash !== 'string' || typeof snap.treeSha !== 'string'
      || !/^sha256:[0-9a-f]{64}$/.test(snap.packetHash) || !/^sha256:[0-9a-f]{64}$/.test(snap.treeSha)) {
    return { ok: false, reason: 'packet-compile-failed: invalid packet identity' };
  }
  const bytes = Buffer.byteLength(snap.text, 'utf8');
  const estTokens = snap.manifest.estTokens;
  if (!Number.isSafeInteger(estTokens) || estTokens < 0 || snap.manifest.bytes !== bytes) {
    return { ok: false, reason: 'packet-measurement-invalid' };
  }
  // the gate of a slot that stops: while the context is switched on, the packet carries the architecture context with at least one target path
  if (deps.gate && deps.gate.kind === 'required' && deps.gate.context !== false) {
    let rows = null;
    try { rows = snap.manifest.context ? snap.manifest.context.rows : null; } catch { rows = null; }
    const missing = PG.contextProblem(rows ? { context: { targets: rows.targets } } : null);
    if (missing) return { ok: false, reason: `${missing.code} ${missing.reason}` };
  }
  const read = paths.readFileGuarded(path.resolve(repoRoot), slot.launch);
  if (!read.ok) return { ok: false, reason: 'packet-launch-unreadable' };
  const decoded = texts.decode(read.bytes, { bom: 'strip', crlf: 'normalise', invisible: 'refuse' });
  if (!decoded.ok) return { ok: false, reason: 'packet-launch-invalid-text' };
  const launchText = decoded.text;
  const markers = launchText.split(MARKER).length - 1;
  if (markers === 0 && spec.mode === 'inline') return { ok: false, reason: 'packet-marker-missing' };
  if (markers > 1) return { ok: false, reason: 'packet-marker-multiple' };
  if (markers === 1 && !texts.maskMarkdown(launchText).lines.some(l => !l.masked && !l.partial && l.text.includes(MARKER))) {
    return { ok: false, reason: 'packet-marker-hidden' };
  }

  const fileAccess = snap.fileAccess;
  const shape = spec.mode !== 'inline' && fileAccess && clients.length <= 1 ? 'pointer' : 'inline';
  const name = safeName(slot.id);
  const launchRel = `${RUNTIME_DIR}/${name}.launch.md`;
  const packetRel = `${RUNTIME_DIR}/${name}.packet.md`;
  const insert = shape === 'pointer'
    ? `Compiled instruction: read ${packetRel} before you start. It is subordinate to AGENTS.md and .ai/DECISIONS.md.`
    : snap.text.replace(/\n+$/, '');
  const files = [{ rel: launchRel, text: markers ? launchText.replace(MARKER, () => insert) : `${insert}\n\n${launchText}` }];
  if (shape === 'pointer') files.push({ rel: packetRel, text: snap.text });
  return {
    ok: true,
    shape,
    derivedRel: launchRel,
    files,
    packetHash: hex(snap.packetHash),
    treeSha: hex(snap.treeSha),
    bytes, estTokens, role: slot.role, stage: spec.stage,
    text: snap.text,
    manifest: snap.manifest,
  };
}

function measurementFields(info) {
  return { packetHash: `sha256:${info.packetHash}`, packetBytes: info.bytes, packetEstTokens: info.estTokens, role: info.role, stage: info.stage };
}

// Audit copy beside the other runtime packets (FINAL plan section 5); never fails a launch.
function persist(info, slot, repoRoot) {
  try {
    const stem = `${safeName(slot.id)}-${safeName(slot.packet.stage)}-${info.treeSha.slice(0, 8)}-${info.packetHash.slice(0, 8)}`;
    writeFiles(repoRoot, [
      { rel: `.ai/runtime/packets/${stem}.md`, text: info.text },
      { rel: `.ai/runtime/packets/${stem}.manifest.json`, text: JSON.stringify({ ...info.manifest, shape: info.shape, slot: slot.id }, null, 2) + '\n' },
    ]);
    return { ok: true };
  } catch { return { ok: false, reason: 'packet-audit-copy-refused' }; }
}

// Writes the derived files into a fresh workdir. The directory is under .ai/runtime, which git ignores, so the scope check of the
// completion contract does not see them as undeclared changes.
function writeFiles(workdir, files) {
  for (const f of files) {
    const root = path.resolve(workdir);
    const checked = paths.realInside(root, f.rel, { refuseHardlinks: true });
    if (!checked.ok) throw new Error('packet-output-refused');
    const relativeParent = path.relative(root, path.dirname(checked.real));
    let parent = root;
    for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
      parent = path.join(parent, segment);
      if (!paths.mkdirGuarded(root, parent).ok) throw new Error('packet-output-refused');
    }
    const written = paths.writeAtomicGuarded(checked.real, Buffer.from(f.text, 'utf8'), { root });
    if (!written.ok) throw new Error('packet-output-refused');
  }
}

module.exports = { decision, slotDecision, gateSlot, launchGate, enabled, prepare, measurementFields, persist, writeFiles, SWITCH, MARKER, RUNTIME_DIR };

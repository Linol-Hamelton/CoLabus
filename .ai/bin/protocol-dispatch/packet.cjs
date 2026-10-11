'use strict';
// Packet wiring for protocol-dispatch (PROTO-DEC-0162, 0165; design ).
// DEFAULT OFF: nothing here runs unless PROTOCOL_PACKET_WIRING=1 AND the slot carries a `packet` key. With the switch off dispatch
// behaves byte for byte as before. With the switch on a compile failure FAILS CLOSED: the slot is BLOCKED and nothing is launched.
// The dispatch module imports the compiler; the compiler imports nothing of dispatch (one direction only).

const fs = require('node:fs');
const path = require('node:path');

const SWITCH = 'PROTOCOL_PACKET_WIRING';
const MARKER = '{{PACKET}}';
const RUNTIME_DIR = '.ai/runtime/dispatch-packet';

const enabled = (env = process.env) => env[SWITCH] === '1';
const hex = value => String(value || '').replace(/^sha256:/, '');
const safeName = id => String(id).replace(/[^A-Za-z0-9._-]/g, '_');

// Total text conversion: a hostile value (null-prototype object, throwing toString/getter/Proxy) never throws, it yields a constant (wiring delta certification F-002/F-003).
const UNPRINTABLE = 'unprintable compiler value';
function safeString(value) {
  try { return String(value); } catch { return UNPRINTABLE; }
}
function reasonOf(e) {
  let message;
  try { message = e && e.message; } catch { return UNPRINTABLE; }
  return safeString(message || e);
}
const oneLine = (value, max) => safeString(value).replace(/["\r\n]+/g, ' ').slice(0, max);

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
  const clients = [...new Set((routeClients || []).filter(Boolean))];
  const client = clients[0] || undefined;
  let compiler;
  try { compiler = deps.compiler || require('../protocol-packet.cjs'); } catch (e) { return { ok: false, reason: `packet-compiler-unavailable: ${safeString(reasonOf(e)).slice(0, 200)}` }; }
  let result;
  try {
    result = compiler.compile({
      root: repoRoot,
      role: slot.role,
      stage: spec.stage,
      frame: spec.frame ? path.resolve(repoRoot, spec.frame) : undefined,
      triggers: spec.triggers,
      client,
    });
  } catch (e) {
    return { ok: false, reason: `packet-compile-failed: ${oneLine(reasonOf(e), 300)}` };
  }
  // A null, undefined or otherwise result-less compiler outcome is the same contract violation as an incomplete one: fail closed and visibly (wiring delta certification F-001).
  if (!result || typeof result !== 'object') {
    return { ok: false, reason: `packet-compile-failed: the compiler returned no result (${result === null ? 'null' : typeof result})` };
  }
  // Snapshot the result once: every property read is guarded, so a throwing getter or Proxy becomes a managed refusal (F-003).
  let snap;
  try {
    snap = { exit: result.exit, text: result.text, packetHash: result.packetHash, treeSha: result.treeSha, manifest: result.manifest };
    if (snap.exit !== 0) snap.why = result.report && result.report.reason ? result.report.reason : `compile exit ${safeString(snap.exit)}`;
    else if (snap.manifest) snap.fileAccess = Boolean(snap.manifest.fileAccess);
  } catch (e) {
    return { ok: false, reason: `packet-compile-failed: the compiler result could not be read (${oneLine(reasonOf(e), 200)})` };
  }
  if (snap.exit !== 0) return { ok: false, reason: `packet-compile-failed: ${oneLine(snap.why, 300)}` };
  // A compiler that reports success without text or hashes (a contract violation) must fail closed like any other compile failure, never throw with the start lock held (wiring certification OBS-4).
  if (typeof snap.text !== 'string' || !snap.text || !snap.packetHash || !snap.treeSha || !snap.manifest) {
    return { ok: false, reason: 'packet-compile-failed: the compiler returned exit 0 without a complete packet (text, packetHash, treeSha, manifest)' };
  }
  const base = path.resolve(repoRoot, slot.launch);
  let launchText;
  try { launchText = fs.readFileSync(base, 'utf8'); } catch (e) { return { ok: false, reason: `packet-launch-unreadable: ${slot.launch}` }; }
  const markers = launchText.split(MARKER).length - 1;
  if (markers === 0) return { ok: false, reason: `packet-marker-missing: ${slot.launch} has no ${MARKER}` };
  if (markers > 1) return { ok: false, reason: `packet-marker-multiple: ${slot.launch} has ${markers} ${MARKER}` };

  const fileAccess = snap.fileAccess;
  const shape = spec.mode === 'pointer' && fileAccess && clients.length <= 1 ? 'pointer' : 'inline';
  const name = safeName(slot.id);
  const launchRel = `${RUNTIME_DIR}/${name}.launch.md`;
  const packetRel = `${RUNTIME_DIR}/${name}.packet.md`;
  const insert = shape === 'pointer'
    ? `Compiled instruction: read ${packetRel} before you start. It is subordinate to AGENTS.md and .ai/DECISIONS.md.`
    : snap.text.replace(/\n+$/, '');
  const files = [{ rel: launchRel, text: launchText.replace(MARKER, () => insert) }];
  if (shape === 'pointer') files.push({ rel: packetRel, text: snap.text });
  return {
    ok: true,
    shape,
    derivedRel: launchRel,
    files,
    packetHash: hex(snap.packetHash),
    treeSha: hex(snap.treeSha),
    bytes: Buffer.byteLength(snap.text, 'utf8'),
    text: snap.text,
    manifest: snap.manifest,
  };
}

// Audit copy beside the other runtime packets (FINAL plan section 5); never fails a launch.
function persist(info, slot, repoRoot) {
  try {
    const dir = path.resolve(repoRoot, '.ai/runtime/packets');
    fs.mkdirSync(dir, { recursive: true });
    const stem = `${safeName(slot.id)}-${safeName(slot.packet.stage)}-${info.treeSha.slice(0, 8)}-${info.packetHash.slice(0, 8)}`;
    fs.writeFileSync(path.join(dir, `${stem}.md`), info.text, 'utf8');
    fs.writeFileSync(path.join(dir, `${stem}.manifest.json`), JSON.stringify({ ...info.manifest, shape: info.shape, slot: slot.id }, null, 2) + '\n', 'utf8');
  } catch { /* audit copy only */ }
}

// Writes the derived files into a fresh workdir. The directory is under .ai/runtime, which git ignores, so the scope check of the
// completion contract does not see them as undeclared changes.
function writeFiles(workdir, files) {
  for (const f of files) {
    const target = path.resolve(workdir, f.rel);
    if (!target.startsWith(path.resolve(workdir) + path.sep)) throw new Error(`derived path escapes the workdir: ${f.rel}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.text, 'utf8');
  }
}

module.exports = { enabled, prepare, persist, writeFiles, SWITCH, MARKER, RUNTIME_DIR };

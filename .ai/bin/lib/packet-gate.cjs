'use strict';
// packet-gate.cjs - the launch gate of the compiled packet. It decides nothing while its key in the coupled-set registry is off at the
// candidate commit and on the integration line (protocol-context.cjs gateAt); the key is separate from the switch of the packet context.
// While the gate is on, an author or certifier launch starts only with the packet of its role, made for the head and the kernel it starts
// on, from a commit whose decision log holds every accepted block of the main checkout and of the integration line; while the context is
// switched on too, that packet carries the architecture context of its task. Any other start is refused before the client by one of five named codes (CODES), with the
// line of the call file and a launch record. The one way past a refusal is a dated, open row of the kernel bypass register on the base
// commit whose kernel home is the packet compiler, inside its launch limit and its age; the launch record names the row and the number of
// its use. No environment value opens the gate. A pre-review launch is never stopped: the same findings are warnings and it goes on.
// The certifier and fixer engines and the dispatcher call these functions at their gate points. The readers take the git runner of the
// launcher and read git objects of the launched worktree, the decision log of its main checkout and the folder of the launch records.
const fs = require('node:fs');
const path = require('node:path');

const CODES = Object.freeze({
  required: 'PACKET_REQUIRED_REFUSED', context: 'PACKET_CONTEXT_REQUIRED_REFUSED', stale: 'PACKET_STALE_REFUSED',
  floor: 'CONTEXT_FLOOR_OVER_BUDGET', decisions: 'DECISIONS_AHEAD_REFUSED',
});
const CODE_SET = new Set(Object.values(CODES));
// The launch roles the gate stops (an author round, a fix round, a certification) and the one it only warns (a pre-review).
const REQUIRED = new Set(['author', 'fixer', 'certifier']);
const ADVISORY = new Set(['pre-review']);
const gateOf = launchRole => (REQUIRED.has(launchRole) ? 'required' : ADVISORY.has(launchRole) ? 'advisory' : null);
// The same for a dispatch slot, which names the packet role of its seat: an executor or a checker is stopped, a reviewer warned. A role is
// looked up among the own keys of the table only, so a name the object inherits (constructor, toString, __proto__) is no role.
const SLOT_GATE = Object.freeze({ implementer: 'required', fixer: 'required', drafter: 'required', synthesiser: 'required', certifier: 'required', auditor: 'required', reviewer: 'advisory' });
const slotGateOf = role => (typeof role === 'string' && Object.hasOwn(SLOT_GATE, role) ? SLOT_GATE[role] : null);

const DECISIONS = '.ai/DECISIONS.md';
const MANIFEST = 'protocol-manifest.json';
const PACKET_HOME = '.ai/bin/protocol-packet.cjs';
const BYPASS_ID = /^BP-\d{3}$/;
const DAY_MS = 86400000;
const oneLine = (value, max = 200) => String(value === undefined || value === null ? '' : value).replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
const refusal = (code, reason) => ({ code, reason: oneLine(reason) || 'refused' });

// A compile that did not give a packet: the floor of the context that does not fit is its own code, every other failure means no packet.
function compileRefusal(error) {
  const message = oneLine(error && error.message, 400);
  if (message.startsWith(CODES.floor)) {
    const m = /takes (\d+) bytes and the instruction leaves (\d+) bytes/.exec(message);
    return refusal(CODES.floor, m ? `floor-over-budget floor=${m[1]} room=${m[2]}` : 'floor-over-budget');
  }
  return refusal(CODES.required, 'packet-compile-failed');
}
// A packet that carries no architecture context, or one that names no target path of the task, gives the checker no map.
function contextProblem(packet) {
  if (!packet || !packet.context) return refusal(CODES.context, 'context-absent');
  if (!Number.isInteger(packet.context.targets) || packet.context.targets < 1) return refusal(CODES.context, 'context-without-targets');
  return null;
}
// The gate code of a refusal of the context step: a document made for another head is stale, an executor role nobody allowed is no packet,
// and every other refusal of the step leaves the packet without its context.
function contextStepCode(reason) {
  const word = String(reason || '').split(' ')[0];
  if (word === 'context-switch-unreadable' || word === 'gate-switch-unreadable') return null;
  if (word === 'context-commit-differs') return CODES.stale;
  if (word === 'executor') return CODES.required;
  return CODES.context;
}

// ---------- the readers (git objects of the launched worktree, through the runner of the launcher) ----------
function gitOut(run, worktree, args) {
  const r = run('git', ['-C', worktree, '-c', 'core.quotepath=false', ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
  return r && !r.error && r.status === 0 ? String(r.stdout || '') : null;
}
const blobAt = (run, worktree, rev, file) => gitOut(run, worktree, ['cat-file', 'blob', `${rev}:${file}`]);
// The main checkout of a worktree: the folder that holds its common git directory, or none for a bare repository.
function mainCheckout(run, worktree) {
  const out = gitOut(run, worktree, ['rev-parse', '--git-common-dir']);
  if (out === null) return null;
  const common = path.resolve(worktree, out.trim());
  return path.basename(common) === '.git' ? path.dirname(common) : null;
}
// The ids of the accepted blocks of one decision log text, sorted.
function acceptedIds(text) {
  if (typeof text !== 'string' || !text) return [];
  const index = require('../protocol-index.cjs');
  return [...new Set(index.parseBlocks(text).filter(b => b.body.some(l => l.trim() === 'Status: Accepted')).map(b => b.id))].sort();
}
// The accepted blocks the candidate commit does not hold although the main checkout or the integration line does: a launch on such a
// commit works under rules it cannot see, so it waits until the branch has taken the line in. The integration branch is the one the
// manifest of the commit names; a source that does not exist adds nothing, a main decision log that exists and does not read refuses.
function decisionsAhead({ worktree, commit, run, io = fs }) {
  const candidate = new Set(acceptedIds(blobAt(run, worktree, commit, DECISIONS)));
  const sources = [];
  const main = mainCheckout(run, worktree);
  if (main) {
    let text = null;
    try { text = io.readFileSync(path.join(main, ...DECISIONS.split('/')), 'utf8'); }
    catch (error) { if (!error || error.code !== 'ENOENT') return { ok: false, reason: 'decisions-unreadable source=main-checkout', missing: [] }; }
    if (text !== null) sources.push({ name: 'main-checkout', ids: acceptedIds(text) });
  }
  let branch = null;
  try { const m = JSON.parse(blobAt(run, worktree, commit, MANIFEST) || 'null'); branch = m && typeof m.integrationBranch === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]{0,100}$/.test(m.integrationBranch) ? m.integrationBranch : null; } catch { branch = null; }
  for (const ref of branch ? [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`] : []) {
    const text = blobAt(run, worktree, ref, DECISIONS);
    if (text !== null) sources.push({ name: ref, ids: acceptedIds(text) });
  }
  const missing = [...new Set(sources.flatMap(s => s.ids.filter(id => !candidate.has(id))))].sort();
  return { ok: missing.length === 0, missing, sources: sources.map(s => s.name) };
}
const decisionsRefusal = ahead => refusal(CODES.decisions, ahead.reason || `missing=${ahead.missing.slice(0, 8).join(',')}${ahead.missing.length > 8 ? `,+${ahead.missing.length - 8}` : ''}`);

// ---------- the launch-record day files (the one guard of every reader of the record folder: the bypass uses and the packet measure) ----------
// The record folder is read only as a folder of its own path: a folder that is a link or junction, or whose real path is another folder (a link
// or junction on its path), is refused by name, so no record comes from another folder. A day file is read only as a plain file of the folder:
// a link or junction, anything that is not a regular file and a file with a second hard link are refused by name, and so is a file above
// DAY_FILE_MAX bytes (the source limit of the pulse, which reads the same files), before and after the read. A refusal is never a lower count.
// The io of a caller may leave out lstatSync or realpathSync; the file system answers them then.
const DAY_FILE_MAX = 8 * 1024 * 1024;
const recordsRefusal = (reason, message) => Object.assign(new Error(message), { reason, exitCode: 2 });
const lstatOf = io => (typeof io.lstatSync === 'function' ? p => io.lstatSync(p) : p => fs.lstatSync(p));
const samePath = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
// -> the names of the folder, or null for a folder that does not exist
function recordFolder(dir, io = fs) {
  let names;
  try { names = io.readdirSync(dir); } catch (error) { if (error && error.code === 'ENOENT') return null; throw error; }
  if (lstatOf(io)(dir).isSymbolicLink()) throw recordsRefusal('folder-link', 'the record folder is a link or junction; records are read only from a folder of its own path');
  const real = typeof io.realpathSync === 'function' ? io.realpathSync(dir) : fs.realpathSync(dir);
  if (!samePath(path.resolve(String(real)), path.resolve(dir))) throw recordsRefusal('folder-elsewhere', 'the real path of the record folder is another folder (a link or junction on its path)');
  return names;
}
// -> the bytes of one day file of the folder
function readDayFile(dir, name, io = fs) {
  const file = path.join(dir, name);
  const st = lstatOf(io)(file);
  if (st.isSymbolicLink()) throw recordsRefusal('day-file-link', `day file ${name} is a link or junction; records are read only from plain files of the folder`);
  if (!st.isFile() || st.nlink > 1) throw recordsRefusal('day-file-not-plain', `day file ${name} is not a plain file of its own (a directory, a device or a second hard link)`);
  if (st.size > DAY_FILE_MAX) throw recordsRefusal('day-file-over-limit', `day file ${name} has ${st.size} bytes, above the limit of ${DAY_FILE_MAX}`);
  const bytes = io.readFileSync(file);
  if (bytes.length > DAY_FILE_MAX) throw recordsRefusal('day-file-grew', `day file ${name} grew above the limit of ${DAY_FILE_MAX} bytes while it was read`);
  return bytes;
}

// ---------- the bypass (a row of the kernel bypass register, never an environment value) ----------
// The uses of one row so far: the launch records of the record folder whose note names the row. A folder that does not exist holds
// none; a folder or a day file the guard above refuses is no count (bypass-records-REASON), and then the bypass is refused. A line of a day
// file that is no JSON object may be a use whose text was damaged (bypass-use-line-malformed); a line with a key twice may hide a use behind
// the last copy of the key (bypass-use-line-duplicate-key); an object that is not a launch record of the schema, which every kind of record
// writes with its schema and its launch id (launch-record/1, the one version), may be a record that lost them (bypass-use-record-unknown-schema);
// a note that is no string may be a damaged one (bypass-use-note-malformed). Each leaves the count unknown: it is never taken lower than the
// records. A record of the schema without a note is a launch without a bypass: the schema keeps the note optional and a launch by a bypass
// always writes the note with the row first.
const RECORD_SCHEMA = 'launch-record/1';
const recordsError = error => (error && typeof error.reason === 'string' ? new Error(`bypass-records-${error.reason}`) : error);
function bypassUses(dir, id, io = fs) {
  if (typeof id !== 'string' || !BYPASS_ID.test(id)) throw new Error('bypass-id-invalid');
  let names;
  try { names = recordFolder(dir, io); } catch (error) { throw recordsError(error); }
  if (names === null) return 0;
  const { parseJsonUnique } = require('./text-safe.cjs');
  const token = new RegExp(`(?:^| )packet-bypass=${id}(?: |$)`);
  let count = 0;
  for (const name of names.filter(n => /^launches-\d{8}\.jsonl$/.test(n)).sort()) {
    let bytes;
    try { bytes = readDayFile(dir, name, io); } catch (error) { throw recordsError(error); }
    for (const line of (Buffer.isBuffer(bytes) ? bytes.toString('utf8') : String(bytes)).split('\n')) {
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { rec = null; }
      if (!rec || typeof rec !== 'object' || Array.isArray(rec)) throw new Error('bypass-use-line-malformed');
      try { parseJsonUnique(line); } catch { throw new Error('bypass-use-line-duplicate-key'); }
      if (rec.schema !== RECORD_SCHEMA || typeof rec.launchId !== 'string' || !rec.launchId) throw new Error('bypass-use-record-unknown-schema');
      if (rec.note !== undefined && typeof rec.note !== 'string') throw new Error('bypass-use-note-malformed');
      if (typeof rec.note === 'string' && token.test(rec.note)) count++;
    }
  }
  return count;
}
// The names of the refusals of bypassUses that the engine keeps in its reason; any other failure of the count is bypass-uses-unreadable.
const BYPASS_USE_REFUSAL = /^bypass-(?:use-[a-z-]+|records-[a-z-]+)$/;
// One row stands in for the packet when it is on the base commit (so no branch grants itself a bypass), sound, open, dated, not older than
// the age limit of the register, its kernel home is the packet compiler, and this use stays inside its launch limit (the larger of the
// counted records and the number the register states). The row is the owner's record of the bypass. -> { ok, id, use, limit } or a reason.
function bypassFor({ worktree, base, id, run, nowMs, uses }) {
  if (typeof id !== 'string' || !BYPASS_ID.test(id)) return { ok: false, reason: 'bypass-id-invalid' };
  const lib = require('./bypass-register.cjs');
  const text = blobAt(run, worktree, base, lib.FILE);
  if (text === null) return { ok: false, reason: 'bypass-register-absent' };
  let reg;
  try { reg = JSON.parse(text); } catch { return { ok: false, reason: 'bypass-register-unreadable' }; }
  if (lib.registerProblems(reg).length) return { ok: false, reason: 'bypass-register-unsound' };
  const row = reg.bypasses.find(r => r.id === id);
  if (!row) return { ok: false, reason: 'bypass-unknown' };
  if (row.status !== 'open') return { ok: false, reason: 'bypass-removed' };
  if (!row.kernelHome.split(',').map(s => s.trim()).includes(PACKET_HOME)) return { ok: false, reason: 'bypass-not-for-the-packet' };
  if (row.since === 'unknown') return { ok: false, reason: 'bypass-undated' };
  if (!Number.isFinite(nowMs) || nowMs - Date.parse(`${row.since}T00:00:00Z`) > reg.maxAgeDays * DAY_MS) return { ok: false, reason: 'bypass-expired' };
  const counted = Math.max(Number.isInteger(uses) ? uses : 0, row.usesBasis === 'not-counted-yet' ? 0 : row.usesCounted);
  const limit = lib.effectiveLimit(row);
  if (counted + 1 > limit) return { ok: false, reason: 'bypass-exhausted' };
  return { ok: true, id, use: counted + 1, limit };
}
const bypassNote = (b, code) => `packet-bypass=${b.id} use=${b.use}/${b.limit} code=${code}`;

// ---------- staleness at the start and the end of an author round ----------
// The packet file of the launch against the kernel of the worktree and the head it stands on right before the client starts: another
// kernel, another head or a changed body is stale.
function staleProblem({ worktree, packetPath, head, compiler, io = fs }) {
  let state;
  try { state = compiler.packetState(io.readFileSync(path.join(worktree, ...String(packetPath).split('/')), 'utf8'), { root: worktree, head }); }
  catch { return refusal(CODES.stale, 'packet-unreadable-or-altered'); }
  if (!state.stale) return null;
  return refusal(CODES.stale, state.packetTree !== state.currentTree ? 'kernel-changed' : 'head-moved');
}
// The last line of the final text that closes an author round: the seat marker with _DONE, or with _BLOCKED and its reason. The seat marker
// is the seat name upper-cased with every other sign an underscore (the author prompt), or the name upper-cased as it is.
function authorEnd(text, name) {
  if (typeof text !== 'string' || typeof name !== 'string' || !name) return null;
  const upper = name.toUpperCase();
  const markers = [...new Set([upper.replace(/[^A-Z0-9]/g, '_'), upper])];
  const lines = text.split('\n').map(l => l.replace(/\s+$/, ''));
  for (let i = lines.length - 1; i >= 0; i--) {
    for (const m of markers) {
      if (lines[i] === `${m}_DONE`) return 'DONE';
      if (lines[i] === `${m}_BLOCKED` || lines[i].startsWith(`${m}_BLOCKED `) || lines[i].startsWith(`${m}_BLOCKED:`)) return 'BLOCKED';
    }
  }
  return null;
}

module.exports = { CODES, CODE_SET, gateOf, slotGateOf, compileRefusal, contextProblem, contextStepCode, mainCheckout, acceptedIds, decisionsAhead, decisionsRefusal, recordFolder, readDayFile, DAY_FILE_MAX, bypassUses, BYPASS_USE_REFUSAL, bypassFor, bypassNote, staleProblem, authorEnd, PACKET_HOME, BYPASS_ID };

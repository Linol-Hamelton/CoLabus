'use strict';
// client-data: where a class K client (docs/ops/client-home.json) keeps its growing data during a seat, and the credential files it needs
// there. The seat gets a FRESH data home inside its launch directory (client-data/xdg-data, client-data/xdg-state); the files named in
// "seed" are copied byte for byte from the user's data home to the exact place the client reads them (<xdg-data>/<dataDir>/<name>), so a
// client is never started without the credentials it needs. The content of a credential file is never read, hashed, printed or logged: the
// copy is a file copy, and only names are ever written to a log. A client whose seed is incomplete, or that is not enabled in the table, is
// UNSEATED with a named reason: no variable is set, the client writes where it wrote before and the pulse watches that place.
// removeSeed deletes exactly the files this module could have placed (the names of the table, below the client-data directory of one launch
// directory) in every completion class; sweepSeeds does the same for a launch directory whose owner is PROVEN dead, whatever its keep deadline
// (the 12 hours of a failed launch never apply to a credential copy).
//   loadTable(file, io): the strict table, or throws
//   plan(client, { table, home }): { client, active, class, reason, dataDir, seed }
//   prepare({ dir, client, table, home, makeLeaf, io }): { env, seeded, unseated, disabled }: unseated is a failure of this launch, disabled the table's reason
//   removeSeed(dir, { table, io }): { removed, failed }
//   sweepSeeds(root, { table, io, now, isAlive, startMs }): { examined, cleaned, failed }
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { decode, parseJsonUnique } = require('../../../.ai/bin/lib/text-safe.cjs');

const TABLE_FILE = path.join(__dirname, '..', 'client-home.json');
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const DATA = 'client-data';

function loadTable(file = TABLE_FILE, io = fs) {
  // the shared strict reader: a key stated twice is refused (also when one is an escape spelling of the other), never resolved to the last value; keys that differ in letter case are two keys
  const dec = decode(io.readFileSync(file));
  if (!dec.ok) throw new Error(`client-home.json: not strictly readable (${dec.problems[0].code})`);
  const t = parseJsonUnique(dec.text);
  if (!t || t.schema !== 'client-home/1' || !t.clients || typeof t.clients !== 'object') throw new Error('client-home.json: not a client-home/1 table');
  for (const [id, c] of Object.entries(t.clients)) {
    if (!SAFE_NAME.test(id) || !c || (c.class !== 'K' && c.class !== 'O') || typeof c.enabled !== 'boolean' || typeof c.reason !== 'string' || !c.reason) throw new Error(`client-home.json: bad row ${id}`);
    if (c.class === 'K') {
      if (!SAFE_NAME.test(String(c.dataDir)) || !Array.isArray(c.seed) || c.seed.some(n => !SAFE_NAME.test(String(n)) || n === '.' || n === '..')) throw new Error(`client-home.json: bad seed of ${id}`);
    }
  }
  return t;
}

function plan(client, { table, home = os.homedir() } = {}) {
  const t = table || loadTable();
  const c = typeof client === 'string' && Object.hasOwn(t.clients, client) ? t.clients[client] : null;
  if (!c) return { client, active: false, class: null, reason: 'client-not-in-table', dataDir: null, seed: [] };
  if (c.class !== 'K') return { client, active: false, class: c.class, reason: `class-O: ${c.reason}`, dataDir: null, seed: [] };
  if (!c.enabled) return { client, active: false, class: 'K', reason: c.reason, dataDir: c.dataDir, seed: c.seed };
  return { client, active: true, class: 'K', reason: c.reason, dataDir: c.dataDir, seed: c.seed, source: path.join(home, '.local', 'share', c.dataDir) };
}

// A plain file of the user's data home: a link, a directory or a missing file is not a seed (the client would start without its credentials).
function seedProblem(source, name, io) {
  let st;
  try { st = io.lstatSync(path.join(source, name)); } catch { return `seed-missing:${name}`; }
  if (st.isSymbolicLink()) return `seed-is-a-link:${name}`;
  if (!st.isFile()) return `seed-not-a-file:${name}`;
  return null;
}

function prepare({ dir, client, table, home = os.homedir(), makeLeaf, io = fs }) {
  const p = plan(client, { table, home });
  // A client that is not enabled in the table is a standing fact, not a launch event: its reason is returned as `disabled` and not as a failure.
  if (!p.active) return { env: {}, seeded: [], unseated: null, disabled: p.class === 'K' ? p.reason : null };
  for (const name of p.seed) { const bad = seedProblem(p.source, name, io); if (bad) return { env: {}, seeded: [], unseated: bad }; }
  const data = makeLeaf(dir, `${DATA}/xdg-data`);
  const state = makeLeaf(dir, `${DATA}/xdg-state`);
  const target = path.join(data, p.dataDir);
  io.mkdirSync(target);
  const seeded = [];
  try {
    for (const name of p.seed) { io.copyFileSync(path.join(p.source, name), path.join(target, name), fs.constants.COPYFILE_EXCL); seeded.push(name); }
  } catch (e) {
    removeSeed(dir, { table, io });
    return { env: {}, seeded: [], unseated: `seed-copy-failed:${(e && e.code) || 'error'}` };
  }
  return { env: { XDG_DATA_HOME: data, XDG_STATE_HOME: state }, seeded, unseated: null };
}

// 'plain' when every directory on the way below the launch directory is a plain directory, 'absent' when one is missing, else 'link': a link on
// the way would make a removal act on a file outside the launch directory.
function wayState(dir, parts, io) {
  let cur = dir;
  for (const p of parts) {
    cur = path.join(cur, p);
    let st;
    try { st = io.lstatSync(cur); } catch (e) { return e && e.code === 'ENOENT' ? 'absent' : 'link'; }
    if (st.isSymbolicLink() || !st.isDirectory()) return 'link';
  }
  return 'plain';
}

// The names this module could have placed, below one launch directory. Plain files and links are unlinked as themselves, never followed, and
// only through plain directories.
function removeSeed(dir, { table, io = fs } = {}) {
  const t = table || loadTable();
  const out = { removed: [], failed: [] };
  for (const [id, c] of Object.entries(t.clients)) {
    if (c.class !== 'K') continue;
    const way = wayState(dir, [DATA, 'xdg-data', c.dataDir], io);
    if (way === 'absent') continue;
    if (way !== 'plain') { for (const name of c.seed) out.failed.push(`${id}/${name}`); continue; }
    for (const name of c.seed) {
      const file = path.join(dir, DATA, 'xdg-data', c.dataDir, name);
      let st;
      try { st = io.lstatSync(file); } catch (e) { if (e && e.code === 'ENOENT') continue; out.failed.push(`${id}/${name}`); continue; }
      if (st.isDirectory()) { out.failed.push(`${id}/${name}`); continue; }
      try { io.unlinkSync(file); out.removed.push(`${id}/${name}`); } catch { out.failed.push(`${id}/${name}`); }
    }
  }
  return out;
}

// The names removeSeed would remove, without removing anything (the dry sweep).
function presentSeeds(dir, { table, io = fs } = {}) {
  const t = table || loadTable();
  const found = [];
  for (const [id, c] of Object.entries(t.clients)) {
    if (c.class !== 'K') continue;
    if (wayState(dir, [DATA, 'xdg-data', c.dataDir], io) !== 'plain') continue;
    for (const name of c.seed) { try { io.lstatSync(path.join(dir, DATA, 'xdg-data', c.dataDir, name)); found.push(`${id}/${name}`); } catch { /* absent */ } }
  }
  return found;
}

function sweepSeeds(root, { table, io = fs, now = Date.now(), isAlive, startMs, dry = false } = {}) {
  const owned = require('../../../.ai/bin/lib/owned-temp.cjs');
  const marker = require('./launch-marker.cjs');
  const res = { examined: 0, cleaned: [], failed: [], skipped: null };
  const tbl = table || loadTable();
  let names;
  try { names = io.readdirSync(root); } catch { return { ...res, skipped: 'root-unreadable' }; }
  for (const name of names) {
    const dir = path.join(root, name);
    let st;
    try { st = io.lstatSync(dir); } catch { continue; }
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    // Only a directory that holds a copy is judged: the proof of death may start a process, and a work root holds hundreds of directories.
    if (!presentSeeds(dir, { table: tbl, io }).length) continue;
    const m = marker.markerState(dir, io);
    if (!m.present || !m.ok) continue;
    const owner = { pid: m.fields.wrapperPid, host: m.fields.host || null, createdAt: m.fields.createdAt };
    if (!owned.ownerState(owner, { isAlive, startMs, now }).dead) continue;
    res.examined++;
    const r = dry ? { removed: presentSeeds(dir, { table: tbl, io }), failed: [] } : removeSeed(dir, { table: tbl, io });
    if (r.failed.length) res.failed.push(name);
    else if (r.removed.length) res.cleaned.push(name);
  }
  return res;
}

module.exports = { TABLE_FILE, DATA, loadTable, plan, prepare, removeSeed, presentSeeds, sweepSeeds };

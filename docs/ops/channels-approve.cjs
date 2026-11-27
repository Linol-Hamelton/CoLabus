#!/usr/bin/env node
'use strict';
// channels-approve: the auto-approval setting of every client, owned by the kernel (AUTO-APPROVE).
//   node docs/ops/channels-approve.cjs check [--client id,id] [--home DIR] [--registry FILE] [--json]
//   node docs/ops/channels-approve.cjs apply --client id,id|all [--write] [--archive-dir DIR] [--home DIR] [--registry FILE] [--json]
// The one source is the autoApprove block of each client in .ai/docs/clients.json: the interactive config file (home-relative), its format, the
// keys and values that mean auto-approve, the seat flags and the stall patterns (docs/ops/approval-stall.cjs).
// check reads each config read-only and reports per client: on, off (with the exact key and its current value), unknown (no measured key in the
// registry, or the config file is absent) or error (a parse problem, or a refused path: resolveFile). A current value is printed only when it is an
// exact word of the closed vocabulary of its key (approve-config vocabulary and safeValue); every other value prints only its kind.
// apply is a dry run unless --write is given. With --write, per client: the file is read once (a parse error, invalid UTF-8, a missing file or a
// refused path refuses), the edit is computed by approve-config (every other byte kept: TOML tables never repeated, JSONC comments kept), the
// original bytes are copied first into a dated archive directory (default: CONFIG-DIR/.auto-approve-archive/YYYY-MM-DD/CLIENT-NAME.STAMP.bak,
// exclusive create, read back and compared), the file is re-read and must still hold the bytes the edit was computed from, the new bytes are
// written by the shared guarded writer (.ai/bin/lib/path-safe.cjs writeAtomicGuarded), and the result is read back and checked on. A file
// already on is not touched. A link, junction or hard link as the config or on its path is never followed or replaced.
// It is a separate tool, not a channels-doctor subcommand: the doctor is read-only by contract (it writes only its status file) and works from
// the channel catalog; this tool works from the client registry and has a writing mode.
// Exit: 0 every checked or applied client is on (or unknown), 1 a client is off or was refused, 2 usage error or unreadable registry.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const cfg = require('./lib/approve-config.cjs');
const paths = require('../../.ai/bin/lib/path-safe.cjs');

const REGISTRY = path.resolve(__dirname, '..', '..', '.ai', 'docs', 'clients.json');
const FORMATS = ['json', 'jsonc', 'toml', 'ps-profile'];

function parseArgs(argv) {
  const o = { cmd: argv[0], clients: [], write: false, json: false };
  if (!['check', 'apply'].includes(o.cmd)) return { error: 'the first argument must be check or apply' };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--write') o.write = true;
    else if (a === '--json') o.json = true;
    else if (['--client', '--home', '--registry', '--archive-dir'].includes(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) return { error: `${a} needs a value` };
      if (a === '--client') o.clients.push(...v.split(',').filter(Boolean));
      else o[a === '--archive-dir' ? 'archiveDir' : a.slice(2)] = v;
    } else return { error: `unknown option ${a}` };
  }
  if (o.cmd === 'check' && (o.write || o.archiveDir)) return { error: 'check never writes: --write and --archive-dir belong to apply' };
  if (o.cmd === 'apply' && !o.clients.length) return { error: 'apply needs --client id,id or --client all' };
  return o;
}

function loadSpecs(file) {
  const reg = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!reg || reg.schema !== 'clients/1' || !reg.clients || typeof reg.clients !== 'object') throw new Error('not a clients/1 registry');
  const out = {};
  for (const [id, c] of Object.entries(reg.clients)) {
    const a = c && c.autoApprove;
    if (!a || !a.interactive || !a.seat) throw new Error(`client ${id} has no autoApprove block`);
    out[id] = a;
  }
  return out;
}

// The config path of a registry file: { ok, file } or { ok: false, reason }. The file is home-relative (~/a/b); a segment that is empty, . or ..,
// or holds a backslash or a colon, refuses before any join (a join would normalize .. away and leave the home); the joined path must stay inside
// the home, and then path-safe realInside walks it from the real home: a symbolic link or junction on the path or as the config, a hard link
// (link count above 1), a reparse point or a real path outside the home refuses by its named reason. A missing config passes here (read refuses).
function resolveFile(file, home) {
  if (typeof file !== 'string' || !file.startsWith('~/')) return { ok: false, reason: 'the registry file is not home-relative (~/...)' };
  const segs = file.slice(2).split('/');
  if (segs.some(s => !s || s === '.' || s === '..' || /[\\:]/.test(s))) return { ok: false, reason: 'the registry file has an empty, . or .. segment, a backslash or a colon; refused' };
  const joined = path.join(home, ...segs);
  const rel = path.relative(home, joined);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, reason: 'the registry file leaves the home directory; refused' };
  const g = paths.realInside(home, joined, { refuseHardlinks: true });
  if (!g.ok) return { ok: false, reason: `the config path is refused (${g.reason}): ${PATH_REASONS[g.reason] || 'not a plain file inside the home'}` };
  if (g.exists && g.type !== 'file') return { ok: false, reason: 'the config path is refused (not-a-file): it is a directory' };
  return { ok: true, file: joined };
}
const PATH_REASONS = {
  link: 'a symbolic link or junction is on the path or is the config; it is never followed or replaced',
  hardlink: 'the config is a hard link (link count above 1); a write would split it from its other names',
  reparse: 'a component leaves its parent directory (a mount point or another reparse point)',
  'outside-root': 'the real path is outside the home',
};

function inspect(id, a, home, io) {
  const it = a.interactive;
  const row = { client: id, state: 'unknown', file: it.file || null, keys: [], reason: null, seat: a.seat.flags.join(' ') || `(${a.seat.mode})` };
  if (it.state !== 'measured' || !FORMATS.includes(it.format) || !it.file) { row.reason = 'no measured auto-approve key in the registry'; return row; }
  const resolved = resolveFile(it.file, home);
  if (!resolved.ok) { row.state = 'error'; row.reason = resolved.reason; return row; }
  const file = resolved.file;
  let buf;
  try { buf = io.readFileSync(file); } catch (e) { row.reason = e.code === 'ENOENT' ? 'config file not found' : `config file not readable (${e.code || 'error'})`; return row; }
  try {
    const { text } = cfg.decode(buf);
    const st = cfg.state(text, it);
    row.keys = st.keys.map(k => ({ key: k.name, on: k.on, current: cfg.safeValue(k.current, k.words), want: cfg.safeValue(k.want, k.words) }));
    row.state = st.keys.every(k => k.on) ? 'on' : 'off';
  } catch (e) {
    if (!(e instanceof cfg.ConfigError)) throw e;
    row.state = 'error'; row.reason = `parse error: ${e.message}`;
  }
  return row;
}

const pad = n => String(n).padStart(2, '0');
const stamp = d => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}${String(d.getUTCMilliseconds()).padStart(3, '0')}Z`;
const day = d => `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;

// One client of apply; returns a row with action: skipped (no measured key) | already-on | planned | written | refused.
function applyOne(id, a, o, deps) {
  const io = deps.fs; const home = deps.home; const now = deps.now();
  const row = inspect(id, a, home, io);
  const it = a.interactive;
  if (it.state !== 'measured') return { ...row, action: 'skipped' };
  if (row.state === 'unknown' || row.state === 'error') return { ...row, action: 'refused', reason: row.reason };
  if (row.state === 'on') return { ...row, action: 'already-on' };
  const resolved = resolveFile(it.file, home);
  if (!resolved.ok) return { ...row, state: 'error', action: 'refused', reason: resolved.reason };
  const file = resolved.file;
  let before; let decoded; let next;
  try {
    before = io.readFileSync(file);
    decoded = cfg.decode(before);
    next = cfg.encode(decoded.bom, cfg.set(decoded.text, it));
  } catch (e) {
    if (!(e instanceof cfg.ConfigError) && !e.code) throw e;
    return { ...row, action: 'refused', reason: e instanceof cfg.ConfigError ? `parse error: ${e.message}` : `config file not readable (${e.code})` };
  }
  const changes = row.keys.filter(k => !k.on).map(k => `${k.key}: ${k.current} -> ${k.want}`);
  if (!o.write) return { ...row, action: 'planned', changes };
  const dir = path.dirname(file); const base = path.basename(file);
  const archive = o.archiveDir ? path.join(path.resolve(o.archiveDir), day(now)) : path.join(dir, '.auto-approve-archive', day(now));
  // the client id is part of the name: two profile wrappers may share one config file
  const backup = path.join(archive, `${id}-${base}.${stamp(now)}.bak`);
  // the archive is walked like the config: the default one from the real home, an --archive-dir from that directory (the caller's choice, made
  // when missing); a link or junction on the way refuses before and after the directory is made
  const archiveRoot = o.archiveDir ? path.resolve(o.archiveDir) : home;
  const archiveGuard = () => { const g = paths.realInside(archiveRoot, archive); return g.ok && (!g.exists || g.type === 'dir') ? null : (g.reason || 'not-a-directory'); };
  try {
    if (o.archiveDir) io.mkdirSync(archiveRoot, { recursive: true });
    const pre = archiveGuard();
    if (pre) return { ...row, action: 'refused', reason: `the backup directory is refused (${pre}); the config was not written` };
    io.mkdirSync(archive, { recursive: true });
    const post = archiveGuard();
    if (post) return { ...row, action: 'refused', reason: `the backup directory is refused (${post}); the config was not written` };
    io.writeFileSync(backup, before, { flag: 'wx' });
    if (!io.readFileSync(backup).equals(before)) return { ...row, action: 'refused', reason: 'the backup did not read back equal; the config was not written', backup };
  } catch (e) { return { ...row, action: 'refused', reason: `the backup could not be written (${e.code || 'error'}); the config was not written` }; }
  // the shared guarded writer (path-safe writeAtomicGuarded): an exclusive temporary file in the real directory, the path checked again just
  // before the rename (no link, no hard link, same directory), and the result checked after it; a refusal leaves the config as it was
  try {
    if (!io.readFileSync(file).equals(before)) return { ...row, action: 'refused', reason: 'the config changed while it was being edited; nothing was written', backup };
  } catch (e) { return { ...row, action: 'refused', reason: `the config could not be read again (${e.code || 'error'}); nothing was written`, backup }; }
  const w = paths.writeAtomicGuarded(file, next, { root: home });
  if (!w.ok) return { ...row, action: 'refused', reason: `the config could not be written (${w.reason}); the backup is kept`, backup };
  const after = inspect(id, a, home, io);
  if (!io.readFileSync(file).equals(next) || after.state !== 'on') return { ...after, action: 'refused', reason: 'the written config did not read back as on; restore it from the backup', backup };
  return { ...after, action: 'written', changes, backup };
}

function selected(specs, wanted) {
  if (!wanted.length || wanted.includes('all')) return { ids: Object.keys(specs), unknown: wanted.filter(w => w !== 'all' && !specs[w]) };
  return { ids: wanted.filter(w => specs[w]), unknown: wanted.filter(w => !specs[w]) };
}

function renderRow(r) {
  const keys = r.keys.map(k => (k.on ? `${k.key}=${k.current}` : `${k.key} is ${k.current}, want ${k.want}`)).join('; ');
  const where = r.file ? ` ${r.file}` : '';
  const act = r.action ? ` [${r.action}]` : '';
  const tail = [keys, r.reason, r.backup ? `backup ${r.backup}` : '', r.changes && r.changes.length ? `changes: ${r.changes.join(', ')}` : ''].filter(Boolean).join(' | ');
  return `${r.client}: ${r.state}${act}${where}${tail ? ` - ${tail}` : ''} (seat: ${r.seat})`;
}

function main(argv, deps = {}) {
  const out = deps.stdout || process.stdout; const err = deps.stderr || process.stderr;
  const o = parseArgs(argv);
  if (o.error) { err.write(`${o.error}\nusage: channels-approve check|apply [--client id,id|all] [--write] [--archive-dir DIR] [--home DIR] [--registry FILE] [--json]\n`); return 2; }
  let specs;
  try { specs = deps.specs || loadSpecs(path.resolve(o.registry || REGISTRY)); } catch (e) { err.write(`registry: ${e.message}\n`); return 2; }
  const sel = selected(specs, o.clients);
  if (sel.unknown.length) { err.write(`unknown client(s): ${sel.unknown.join(', ')}\n`); return 2; }
  const d = { fs: deps.fs || fs, home: path.resolve(o.home || deps.home || os.homedir()), now: deps.now || (() => new Date()) };
  const rows = sel.ids.map(id => (o.cmd === 'check' ? inspect(id, specs[id], d.home, d.fs) : applyOne(id, specs[id], o, d)));
  const lines = [`channels-approve ${o.cmd}${o.cmd === 'apply' && !o.write ? ' (dry run: nothing written; add --write)' : ''}: ${rows.length} client(s)`, ...rows.map(renderRow)];
  const text = o.json ? JSON.stringify({ cmd: o.cmd, write: o.write, rows }, null, 2) : lines.join('\n');
  const leaks = require('./channels-lib.cjs').scanText(text);
  if (leaks.length) { err.write(`refused to print: ${leaks.length} line(s) have the shape of a secret\n`); return 1; }
  out.write(text + '\n');
  return rows.some(r => r.state === 'off' || r.state === 'error' || r.action === 'refused' || r.action === 'planned') ? 1 : 0;
}

module.exports = { main, parseArgs, loadSpecs, inspect, applyOne, resolveFile, REGISTRY };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

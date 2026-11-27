'use strict';
// Shared reads of the worktree inventory and the landing cleanup: git, the candidate registry and the seat
// records of the runtime directory. Nothing here changes anything.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readLanding } = require('../../operator/landed-proof.cjs');
const textSafe = require('../../lib/text-safe.cjs');
const { attemptOf, sameAttempt } = require('../../lib/seat-slots.cjs');

const SHA_FULL = /^[0-9a-f]{40}$/;

const norm = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const samePath = (a, b) => norm(a) === norm(b);
// True when `child` is `parent` or lies below it.
const within = (child, parent) => { const c = norm(child); const p = norm(parent); return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep); };

// The physical place of a path that may not exist yet: the real path of its nearest existing ancestor plus the rest, so a
// junction or a symbolic link on the way is resolved. A path that cannot be resolved stays as written.
function physical(p) {
  let rest = '';
  let here = path.resolve(p);
  for (;;) {
    try { return path.join(fs.realpathSync(here), rest); } catch { /* go one level up */ }
    const up = path.dirname(here);
    if (up === here) return path.resolve(p);
    rest = path.join(path.basename(here), rest);
    here = up;
  }
}

// A git reader that returns the trimmed output, or null when git failed.
function gitReader(spawn = spawnSync) {
  return (args, cwd) => {
    const r = spawn('git', args, { cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
    return r.error || r.status !== 0 ? null : String(r.stdout || '').trim();
  };
}

function listWorktrees(git, main) {
  const rows = [];
  let current = null;
  for (const line of (git(['worktree', 'list', '--porcelain'], main) || '').split('\n')) {
    if (line.startsWith('worktree ')) { current = { path: line.slice(9).trim() }; rows.push(current); }
    else if (!current) continue;
    else if (line.startsWith('HEAD ')) current.head = line.slice(5).trim();
    else if (line.startsWith('branch ')) current.branch = line.slice(7).trim().replace('refs/heads/', '');
    else if (line.trim() === 'detached') current.detached = true;
    else if (line.startsWith('prunable')) current.prunable = true;
  }
  return rows;
}

// The candidate registry: a table whose first two columns are the stream and its branch. A row is closed when any later
// column says landed or superseded. present is false when the file cannot be read: a cleanup then has no knowledge of
// what is in work and must not remove anything.
function readRegistry(runtimeDir, files = fs) {
  let text;
  try { text = files.readFileSync(path.join(runtimeDir, 'CANDIDATES.md'), 'utf8'); } catch { return { present: false, open: new Set(), closed: new Set(), landed: new Set(), packages: new Map() }; }
  const open = new Set();
  const closed = new Set();
  const landed = new Set();
  const packages = new Map();
  for (const row of text.split('\n')) {
    const c = row.split('|').map(s => s.trim());
    if (c.length <= 5 || !c[1] || /^[-:]+$/.test(c[1]) || c[1] === 'stream') continue;
    if (c.slice(2).some(x => /^(landed|superseded)$/.test(x))) { closed.add(c[1]); if (c[2]) closed.add(c[2]); }
    else { open.add(c[1]); if (c[2]) open.add(c[2]); }
    if (c.slice(3).some(x => x === 'landed')) { landed.add(c[1]); if (c[2]) landed.add(c[2]); }
    for (const key of [c[1], c[2]].filter(Boolean)) packages.set(key.toLowerCase(), { stream: c[1], branch: c[2] });
  }
  return { present: true, open, closed, landed, packages };
}

// Longest suffix first: the package name itself may contain hyphens and client names.
const SEAT_SUFFIX = /-(certifier)$/i;
function treePackage(w, seats, registry) {
  const basename = path.basename(w.path);
  const match = basename.match(SEAT_SUFFIX);
  const seat = seats.seats.find(s => s.worktree && samePath(s.worktree, w.path));
  const names = [seat && seat.stream, match ? basename.slice(0, -match[0].length) : '', w.branch, basename].filter(Boolean);
  const records = names.flatMap(n => [n, `ops-${n}`]).map(n => registry.packages.get(n.toLowerCase())).filter(Boolean);
  const keys = [...new Set([...names, ...records.flatMap(r => [r.stream, r.branch])].filter(Boolean))];
  return { kind: match ? match[1].toLowerCase() : 'author', names: keys, branch: records[0]?.branch || w.branch || null };
}

function packageLanded(w, seats, registry, line, git, main) {
  const pkg = treePackage(w, seats, registry);
  if (pkg.names.some(n => registry.open.has(n))) return false;
  const tip = pkg.branch ? git(['rev-parse', '--verify', `refs/heads/${pkg.branch}`], main) : null;
  if (pkg.branch && !tip) return false;
  // A seat may be pinned to a pre-squash commit; prove its package's current tip, not the base it forked from.
  const head = tip || w.head;
  if (tip && w.head !== tip && !line.isLandedTip(w.head) && git(['merge-base', '--is-ancestor', w.head, tip], main) === null) return false;
  if (!tip && pkg.kind !== 'author' && !pkg.names.some(n => registry.landed.has(n))) return false;
  return line.isLandedTip(head) || (pkg.names.some(n => registry.landed.has(n)) && line.inLine(head));
}

const BRANCH_RETENTION_MS = 72 * 3600000;
function branchKeepReason(name, sha, registry, line, git, main, now) {
  if (!registry.present || registry.open.has(name)) return 'package is open or registry unreadable';
  if (!(line.isLandedTip(sha) || (registry.landed.has(name) && line.inLine(sha)))) return 'no landed record for this tip';
  const history = git(['log', '--format=%ct %at', sha], main);
  if (!history) return 'commit dates unreadable';
  for (const row of history.split('\n')) {
    const dates = row.trim().split(/\s+/).map(Number);
    if (dates.length !== 2 || dates.some(t => !Number.isSafeInteger(t) || t <= 0)) return 'commit dates unreadable';
    if (dates.some(t => now - t * 1000 < BRANCH_RETENTION_MS)) return 'commit younger than 72 hours';
  }
  return null;
}

// One record per seat: live until a terminal record of the same attempt (the shared rule of seat-slots.cjs: the same wrapper
// PID and the same start as the running record) can be read, in whatever order the two files were written. The launch wrapper
// writes the terminal record first and then stamps the running record (`ended`, later `claimReleasedAt`), so the running record
// of an ended seat is the newer file; a relaunch writes a running record of a new attempt, which the old terminal record never
// ends. A terminal record of another attempt and one that cannot be read end nothing: in doubt the seat is live and its tree is
// kept. The `ended` stamp alone ends nothing here: as in the retire proof of the cycle lifecycle inputs, only the terminal record
// of the attempt proves the end (seat-slots and seat-count also count a stamped record without one as ended).
// A running record that cannot be read or is not a JSON object makes the whole list unreadable (names in `unreadable`): which
// tree it guards is unknown. `attempt` is the attempt of the running record (null without one): a step that acts on an earlier
// read compares it, so a seat that started again since is never taken for the one that was read.
// Canonical form of a record (P-L9-002, read by the shared strict reader of text-safe.cjs): UTF-8 without a byte order mark,
// no NUL, no invisible or look-alike control character, no lone CR (CRLF is read as LF), one JSON object, and no key twice in
// any object (last-key-wins would let a second `worktree` hide the first). Anything else is an unreadable record.
function readSeatRecord(file, files) {
  const bytes = files.readFileSync(file);
  const decoded = typeof bytes === 'string' ? textSafe.decodeText(bytes, SEAT_POLICY) : textSafe.decode(bytes, SEAT_POLICY);
  if (!decoded.ok) throw Object.assign(new Error('non-canonical text'), { code: decoded.problems[0].code });
  return textSafe.parseJsonUnique(decoded.text);
}
const SEAT_POLICY = { bom: 'refuse', crlf: 'normalise', invisible: 'refuse', finalNewline: 'report' };

function seatRecords(runtimeDir, files = fs) {
  let names;
  try { names = files.readdirSync(runtimeDir); } catch { return { readable: false, seats: [], unreadable: [] }; }
  const seats = [];
  const unreadable = [];
  for (const file of names) {
    if (!file.endsWith('.running.json')) continue;
    const name = file.slice(0, -'.running.json'.length);
    let data;
    try { data = readSeatRecord(path.join(runtimeDir, file), files); } catch { unreadable.push(file); continue; }
    if (!data || typeof data !== 'object' || Array.isArray(data)) { unreadable.push(file); continue; }
    let terminalAt = null;
    try {
      const terminal = path.join(runtimeDir, `${name}.terminal.json`);
      const at = files.statSync(terminal).mtimeMs;
      if (sameAttempt(data, readSeatRecord(terminal, files))) terminalAt = at;
    } catch { /* no terminal record, or one that cannot be read: it ends nothing */ }
    seats.push({ name, worktree: typeof data.worktree === 'string' ? data.worktree : null, stream: typeof data.stream === 'string' ? data.stream : '',
      live: terminalAt === null, terminalAt, attempt: attemptOf(data) });
  }
  return { readable: unreadable.length === 0, seats, unreadable };
}

// Facts about the line (the base branch the landings go into): which tips are in it or cited as landed by its history.
function lineFacts(git, main, lineRef) {
  const raw = git(['log', '--no-show-signature', '--no-notes', '--grep=^land ', '--format=%H%x00%B%x00', lineRef], main);
  const exactTips = new Set();
  const badPrefixes = new Set();
  if (typeof raw === 'string' && raw.length > 0) {
    const fields = raw.split('\0');
    for (let i = 0; i + 1 < fields.length; i += 2) {
      const commit = fields[i].trim();
      const message = fields[i + 1];
      if (!SHA_FULL.test(commit) || !message.startsWith('land ')) continue;
      const parsed = readLanding(message);
      if (parsed.reason) {
        for (const m of message.matchAll(/[0-9a-f]{8}/g)) badPrefixes.add(m[0]);
      } else if (parsed.tip) {
        exactTips.add(parsed.tip);
      } else if (parsed.prefix && !badPrefixes.has(parsed.prefix)) {
        const dis = git(['rev-parse', `--disambiguate=${parsed.prefix}`], main);
        if (typeof dis === 'string' && dis.length > 0) {
          const ids = dis.split('\n').map(s => s.trim()).filter(Boolean);
          if (ids.length === 1 && SHA_FULL.test(ids[0]) && !badPrefixes.has(ids[0].slice(0, 8))) exactTips.add(ids[0]);
        }
      }
    }
  }
  const cited = sha => typeof sha === 'string' && SHA_FULL.test(sha) && !badPrefixes.has(sha.slice(0, 8)) && exactTips.has(sha);
  const inLine = sha => typeof sha === 'string' && SHA_FULL.test(sha) && git(['merge-base', '--is-ancestor', sha, lineRef], main) !== null;
  return { isLandedTip: cited, inLine };
}
const lineRefOf = baseRef => (baseRef.startsWith('refs/') ? baseRef : `refs/remotes/${baseRef}`);

module.exports = { norm, samePath, within, physical, gitReader, listWorktrees, readRegistry, seatRecords, lineFacts, lineRefOf,
  SEAT_SUFFIX, treePackage, packageLanded, branchKeepReason, BRANCH_RETENTION_MS };

'use strict';
// Shared reads of the worktree inventory and the landing cleanup: git, the candidate registry and the seat
// records of the runtime directory. Nothing here changes anything.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const norm = p => (process.platform === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p));
const samePath = (a, b) => norm(a) === norm(b);
// True when `child` is `parent` or lies below it.
const within = (child, parent) => { const c = norm(child); const p = norm(parent); return c === p || c.startsWith(p.endsWith(path.sep) ? p : p + path.sep); };

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
  try { text = files.readFileSync(path.join(runtimeDir, 'CANDIDATES.md'), 'utf8'); } catch { return { present: false, open: new Set(), closed: new Set() }; }
  const open = new Set();
  const closed = new Set();
  for (const row of text.split('\n')) {
    const c = row.split('|').map(s => s.trim());
    if (c.length <= 5 || !c[1] || /^[-:]+$/.test(c[1]) || c[1] === 'stream') continue;
    if (c.slice(2).some(x => /^(landed|superseded)$/.test(x))) { closed.add(c[1]); if (c[2]) closed.add(c[2]); }
    else { open.add(c[1]); if (c[2]) open.add(c[2]); }
  }
  return { present: true, open, closed };
}

// One record per seat: live when its running record has no terminal record written after it.
function seatRecords(runtimeDir, files = fs) {
  let names;
  try { names = files.readdirSync(runtimeDir); } catch { return { readable: false, seats: [] }; }
  const seats = [];
  for (const file of names) {
    if (!file.endsWith('.running.json')) continue;
    const name = file.slice(0, -'.running.json'.length);
    let data;
    try { data = JSON.parse(files.readFileSync(path.join(runtimeDir, file), 'utf8')); } catch { continue; }
    if (!data || typeof data !== 'object') continue;
    let runningAt = 0;
    let terminalAt = null;
    try { runningAt = files.statSync(path.join(runtimeDir, file)).mtimeMs; } catch { /* unknown age */ }
    try { terminalAt = files.statSync(path.join(runtimeDir, `${name}.terminal.json`)).mtimeMs; } catch { /* no terminal record */ }
    seats.push({ name, worktree: typeof data.worktree === 'string' ? data.worktree : null, stream: typeof data.stream === 'string' ? data.stream : '',
      live: terminalAt === null || terminalAt < runningAt, terminalAt });
  }
  return { readable: true, seats };
}

// Facts about the line (the base branch the landings go into): which tips are in it or cited as landed by its history.
function lineFacts(git, main, lineRef) {
  const trailers = (git(['log', '--format=%(trailers:key=Landed-Tip,valueonly)', lineRef], main) || '').split('\n').map(s => s.trim()).filter(Boolean);
  // A squash without the trailer names its tip in the subject: "squash of the branch tip XXXXXXXX".
  const prefixes = (git(['log', '--format=%s', lineRef], main) || '').split('\n').map(s => (s.match(/squash of the branch tip ([0-9a-f]{8,40})/) || [])[1]).filter(Boolean);
  // Heads in worktree rows may be abbreviated and trailers are full: compare by common prefix in both directions.
  const samePrefix = (a, b) => (a.length <= b.length ? b.startsWith(a) : a.startsWith(b));
  const cited = sha => !!sha && [...trailers, ...prefixes].some(t => samePrefix(t, sha));
  const inLine = sha => !!sha && git(['merge-base', '--is-ancestor', sha, lineRef], main) !== null;
  return { isLandedTip: cited, inLine };
}
const lineRefOf = baseRef => (baseRef.startsWith('refs/') ? baseRef : `refs/remotes/${baseRef}`);

module.exports = { norm, samePath, within, gitReader, listWorktrees, readRegistry, seatRecords, lineFacts, lineRefOf };

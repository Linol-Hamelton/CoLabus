'use strict';
// Resolve a client executable to an absolute path from PATH, never from the current directory.
// Canonical shared text: kept byte-identical in the branches that carry it (copy, never edit one copy).
// A name that is not a bare file name, or that has no match in a PATH directory outside the refused
// roots, gives { ok: false, reason } and the launcher refuses the launch before any spawn.
// Every root, every PATH directory and every candidate is compared by its PROVEN real path (junctions and
// links resolved by the real path helper), so a link-spelled worktree or temp root cannot hide a client inside
// it. A refused root without a provable real path refuses the launch (root-real-path-unproven); a PATH
// directory without one is never searched: its spelling never stands in for its target.
const fs = require('node:fs');
const path = require('node:path');
const realPath = require('../../../.ai/bin/lib/real-path.cjs');

const WINDOWS_EXTENSIONS = ['.exe', '.cmd', '.bat'];

// Proven real path of an existing path; for a missing path the real path of its nearest existing parent
// plus the missing tail. An existing object whose real path cannot be proven (a junction into a volume
// without a Mount Manager name, a link the walk refuses, a dangling link) gives null.
function realOf(value) {
  try { return realPath.physicalPathSync(path.resolve(value)); } catch { return null; }
}

// On Windows a trailing space or dot on a path segment names the same directory for the process and git
// but not for a real-path comparison: such spellings are refused outright, never normalised. The check
// reads the text AS GIVEN (no trim, no resolve, no normalisation first), so a segment hidden by a later
// '..' or by trimming is still seen; a value with leading or trailing whitespace is odd as a whole.
function oddSpelling(value, win) {
  if (!win || typeof value !== 'string') return false;
  if (/^\s|\s$/.test(value)) return true;
  return value.split(/[\\/]/).some(seg => seg.length > 0 && seg !== '.' && seg !== '..' && /[ .]$/.test(seg));
}

// On Windows every root, PATH entry and resolved real path must be a plain drive-absolute path (C:\ or C:/):
// a UNC spelling (including the loopback forms of a local drive), an extended-length or device prefix and any
// other form live in a different namespace than the real-path comparison and are refused outright.
function notDriveAbsolute(value, win) {
  return win && typeof value === 'string' && !/^[A-Za-z]:[\\/]/.test(value);
}

function insideRoot(realRoot, realTarget, win) {
  const norm = value => (win ? value.toLowerCase() : value);
  const r = norm(realRoot);
  const t = norm(realTarget);
  return t === r || t.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

function resolveClient(name, options = {}) {
  const env = options.env || process.env;
  const win = (options.platform || process.platform) === 'win32';
  const cwd = options.cwd || process.cwd();
  const rawRoots = [cwd, ...(Array.isArray(options.refuseInside) ? options.refuseInside : [])]
    .filter(root => typeof root === 'string' && root.length > 0);
  if (rawRoots.some(root => oddSpelling(root, win) || notDriveAbsolute(root, win))) return { ok: false, reason: 'path-spelling-refused' };
  const refusedRoots = rawRoots.map(realOf);
  if (refusedRoots.includes(null)) return { ok: false, reason: 'root-real-path-unproven' };
  if (refusedRoots.some(root => oddSpelling(root, win) || notDriveAbsolute(root, win))) return { ok: false, reason: 'path-spelling-refused' };
  const refused = target => refusedRoots.some(root => insideRoot(root, target, win));
  if (typeof name !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name)) return { ok: false, reason: 'client-name-invalid' };
  const pathValue = env[win ? (Object.keys(env).find(k => k.toLowerCase() === 'path') || 'PATH') : 'PATH'];
  if (typeof pathValue !== 'string' || !pathValue) return { ok: false, reason: 'client-path-missing' };
  const exts = win ? WINDOWS_EXTENSIONS : [''];
  // Every PATH entry is judged BEFORE any search, by its spelling as given and by its real path
  // (a junction into a directory with an odd real name is refused too); an empty entry and an entry
  // without a provable real path are skipped.
  const dirs = [];
  for (const raw of pathValue.split(win ? ';' : ':')) {
    if (raw === '') continue;
    const dir = raw.replace(/^"(.*)"$/, '$1');
    if (oddSpelling(dir, win)) return { ok: false, reason: 'path-spelling-refused' };
    if (!path.isAbsolute(dir)) continue;
    if (notDriveAbsolute(dir, win)) return { ok: false, reason: 'path-spelling-refused' }; // a relative entry means the current directory: never
    const realDir = realOf(dir);
    if (realDir === null) continue;
    if (oddSpelling(realDir, win) || notDriveAbsolute(realDir, win)) return { ok: false, reason: 'path-spelling-refused' };
    dirs.push({ dir, realDir });
  }
  for (const { dir, realDir } of dirs) {
    if (refused(realDir)) continue;
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      let st;
      try { st = fs.lstatSync(candidate); } catch { continue; }
      if (!st.isFile() && !st.isSymbolicLink()) continue;
      let real;
      try { real = (fs.realpathSync.native ? realPath.realPathSync : fs.realpathSync)(candidate); } catch { continue; }
      let realStat;
      try { realStat = fs.statSync(real); } catch { continue; }
      if (!realStat.isFile()) continue;
      if (oddSpelling(real, win) || notDriveAbsolute(real, win)) return { ok: false, reason: 'path-spelling-refused' };
      if (refused(real)) continue;
      return { ok: true, path: real };
    }
  }
  return { ok: false, reason: 'client-not-found' };
}

// Environment for the child: the current directory is never searched for executables.
function childEnv(env = process.env) {
  return { ...env, NoDefaultCurrentDirectoryInExePath: '1' };
}

module.exports = { resolveClient, childEnv };

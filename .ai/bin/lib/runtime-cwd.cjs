'use strict';
// No process is started with its working directory inside .ai/runtime.
// A process whose cwd lies there holds the directory pin
// (EBUSY) and blocks the cleanup and the pins of the other seats. The launch wrapper
// (docs/ops/launch-wrapper.cjs run) and the operator entry points (docs/ops/seat-failover.cjs run for
// cert-launch and fix-launch, .ai/bin/ops-tools/author-launch.cjs) refuse such a cwd through this one
// guard and name the directory. Pure: the only I/O is the realpath normalization of
// seat-slots.normalizeRoot; the caller passes the roots to police.
const path = require('node:path');
const { normalizeRoot } = require('./seat-slots.cjs');

// The normalized identity of child is the root itself or below it (real path, folded on Windows).
function insideDir(child, dir, io) {
  const c = normalizeRoot(String(child), io);
  const d = normalizeRoot(String(dir), io);
  if (c === d) return true;
  const sep = path.sep;
  return c.startsWith(d.endsWith(sep) ? d : d + sep);
}

// The roots one launch polices: the .ai/runtime of the main checkout plus the effective runtime of the
// launch when it differs. -> [absolute directories], deduplicated by normalized identity.
function launchRuntimeRoots(main, runtime, io) {
  const roots = [];
  const seen = new Set();
  for (const dir of [path.join(path.resolve(String(main)), '.ai', 'runtime'), runtime ? path.resolve(String(runtime)) : null]) {
    if (!dir) continue;
    const key = normalizeRoot(dir, io);
    if (seen.has(key)) continue;
    seen.add(key);
    roots.push(dir);
  }
  return roots;
}

// -> null when the cwd is outside every root, else { code, cwd, runtime } naming the containing root.
function runtimeCwdRefusal(options = {}) {
  const cwd = options.cwd !== undefined && options.cwd !== null ? String(options.cwd) : process.cwd();
  const io = options.io;
  for (const root of options.roots || []) {
    if (typeof root !== 'string' || !root) continue;
    if (insideDir(cwd, root, io)) return { code: 'RUNTIME_CWD_REFUSED', cwd: path.resolve(cwd), runtime: path.resolve(root) };
  }
  return null;
}

function refusalLine(r) {
  return `RUNTIME-CWD REFUSED reason=${r.code} cwd=${r.cwd} runtime=${r.runtime}; nothing was started`;
}

module.exports = { insideDir, launchRuntimeRoots, runtimeCwdRefusal, refusalLine };

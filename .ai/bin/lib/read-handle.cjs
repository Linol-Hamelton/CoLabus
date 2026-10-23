'use strict';
// Native descriptor query, not a path guard. path-safe owns all containment checks.
// Windows: a child receives a duplicate of the already-open fd as stdin; the helper
// queries that handle, never opens by name. Compile once per process in a private
// OS-temp directory, no executable cache from another process. Normal exit removes
// only this process's own directory and files; a killed process leaves retention work.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
let helper = null;

// Best effort at exit, including failed compilation. Never recurse, follow a link,
// or remove a foreign file. The directory and each output retain their identities.
function ownHelperDirectory(dir) {
  const identity = fs.lstatSync(dir, { bigint: true });
  const real = fs.realpathSync.native(dir);
  const outputs = new Map();
  const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
  process.once('exit', () => {
    try {
      const current = fs.lstatSync(dir, { bigint: true });
      if (!current.isDirectory() || current.isSymbolicLink() || !same(current, identity) || fs.realpathSync.native(dir) !== real) return;
      for (const [file, original] of outputs) {
        try {
          const st = fs.lstatSync(file, { bigint: true });
          if (st.isFile() && !st.isSymbolicLink() && st.nlink === 1n && same(st, original)) fs.unlinkSync(file);
        } catch { /* missing, replaced or busy: leave it for retention */ }
      }
      fs.rmdirSync(dir); // unknown entries keep the directory; never recurse
    } catch { /* an exit hook must never throw */ }
  });
  return file => {
    try { const st = fs.lstatSync(file, { bigint: true }); if (st.isFile() && !st.isSymbolicLink()) outputs.set(file, st); } catch { /* no output */ }
  };
}

function descriptorInfo(fd) {
  if (process.platform === 'linux') {
    const real = fs.readlinkSync(`/proc/self/fd/${fd}`);
    if (!path.isAbsolute(real) || real.endsWith(' (deleted)')) throw new Error('descriptor-path-unknown');
    const st = fs.fstatSync(fd, { bigint: true });
    return { real, dev: st.dev, ino: st.ino, nlink: st.nlink };
  }
  if (process.platform !== 'win32') throw new Error('descriptor-platform-unsupported');
  if (helper === null) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'path-handle-'));
    const remember = ownHelperDirectory(dir);
    const source = path.join(dir, 'read-handle.cs');
    fs.copyFileSync(path.join(__dirname, 'read-handle.cs'), source);
    remember(source);
    const exe = path.join(dir, 'read-handle.exe');
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    let build;
    try { build = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${exe}`, source], {
      windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 65536,
    }); } finally { remember(exe); }
    if (build.error || build.status !== 0) throw new Error('descriptor-helper-unavailable');
    helper = exe;
  }
  const run = spawnSync(helper, [], { stdio: [fd, 'pipe', 'pipe'], windowsHide: true,
    encoding: 'utf8', timeout: 10000, maxBuffer: 65536 });
  if (run.error || run.status !== 0) throw new Error('descriptor-query-failed');
  const m = /^([A-Za-z0-9+/]+={0,2})\|(\d+)\|(\d+)\|(\d+)\r?\n$/.exec(run.stdout);
  if (!m) throw new Error('descriptor-response-unknown');
  const bytes = Buffer.from(m[1], 'base64');
  if (bytes.toString('base64') !== m[1]) throw new Error('descriptor-response-unknown');
  const real = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  return { real, dev: BigInt(m[2]), ino: BigInt(m[3]), nlink: BigInt(m[4]) };
}

module.exports = { descriptorInfo };

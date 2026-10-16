'use strict';
// Native descriptor query, not a path guard. path-safe owns all containment checks.
// Windows: a child receives a duplicate of the already-open fd as stdin; the helper
// queries that handle, never opens by name. Compile once per process in a private
// OS-temp directory, no executable cache from another process and no cleanup.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
let helper = null;

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
    const source = path.join(dir, 'read-handle.cs');
    fs.copyFileSync(path.join(__dirname, 'read-handle.cs'), source);
    const exe = path.join(dir, 'read-handle.exe');
    const compiler = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    const build = spawnSync(compiler, ['/nologo', '/target:exe', `/out:${exe}`, source], {
      windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 65536,
    });
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

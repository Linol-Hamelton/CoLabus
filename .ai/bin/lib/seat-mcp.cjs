'use strict';
// Seat MCP: the kernel gives a launched seat the two mandatory servers qmd and codebase-memory and no other
// server of the user's configuration. One policy for every launcher (docs/ops/cert-launch.cjs, docs/ops/fix-launch.cjs, tools/operator/seats.cjs).
//   mode kernel: author, fixer and pre-review seats get exactly the two servers.
//   mode none:   certifier and unknown seats get no server (PROTO-DEC-0170 item 4: sealed certifiers receive no MCP; the index also holds the other
//                seats' review reports, which a sealed certifier must not read).
//   mode user:   COLABUS_SEAT_MCP=1 (exactly that string) keeps the old behaviour: the client loads its own user configuration.
// MCP output is advisory (PROTO-DEC-0170 item 4): a server that cannot be resolved is left out with a note and the launch goes on.
// Measured on the clients:
//   codex: `-c mcp_servers.<name>.url='...'` and `.command`/`.args` add a server on top of --ignore-user-config; a backslash path is mangled on the
//          cmd.exe /c line (`C:\Program Files\...` arrived as `C:Program Files`), a forward-slash path arrives intact, so every path here is written with /.
//   vibe 2.26.1: an MCP tool is published as <server name>_<tool name> (core/tools/mcp/registry.py alias=server.name) and --enabled-tools takes globs.
//   claude: --strict-mcp-config with --mcp-config FILE loads only the servers of FILE.
const fs = require('node:fs');
const path = require('node:path');

const SERVER_NAMES = Object.freeze(['qmd', 'codebase-memory']);
const QMD_URL = 'http://localhost:8181/mcp';
// local-only (PROTO-DEC-0170 item 1): an http URL on this machine, no query, no credentials, no quote
const LOCAL_URL = /^http:\/\/(localhost|127\.0\.0\.1)(:[0-9]{1,5})?(\/[A-Za-z0-9._~/-]*)?$/;
// a path that would break the cmd.exe /c line or a TOML literal string is never used
const UNSAFE_PATH = /[&|<>^%!"'`\r\n\t]/;
const KERNEL_ROLES = new Set(['author', 'fixer', 'pre-review']);
const VIBE_PATTERNS = Object.freeze(SERVER_NAMES.map(name => `${name}_*`));

function policy({ role, env = process.env } = {}) {
  if (env.COLABUS_SEAT_MCP === '1') return { mode: 'user', reason: 'COLABUS_SEAT_MCP=1' };
  if (KERNEL_ROLES.has(role)) return { mode: 'kernel', reason: `role ${role}` };
  return { mode: 'none', reason: `role ${String(role || 'unknown').replace(/[^A-Za-z0-9-]/g, '').slice(0, 20) || 'unknown'}: PROTO-DEC-0170 item 4` };
}

const slashes = p => String(p).replace(/\\/g, '/');

// Where the codebase-memory server lives: COLABUS_CBM_BIN (an absolute path of bin.js), else the npm global location of this user. The command is the
// absolute node of the launcher itself. Nothing is spawned or downloaded here (no automatic installation, PROTOCOL.md MCP policy item 3).
function cbmCandidates(env) {
  const out = [];
  if (env.COLABUS_CBM_BIN) out.push(env.COLABUS_CBM_BIN);
  if (env.APPDATA) out.push(path.join(env.APPDATA, 'npm', 'node_modules', 'codebase-memory-mcp', 'bin.js'));
  return out;
}

function servers({ env = process.env, io = fs, execPath = process.execPath } = {}) {
  const notes = [];
  const list = [];
  const url = env.COLABUS_QMD_URL === undefined ? QMD_URL : String(env.COLABUS_QMD_URL);
  const port = LOCAL_URL.exec(url) && LOCAL_URL.exec(url)[2];
  if (LOCAL_URL.test(url) && (!port || (Number(port.slice(1)) >= 1 && Number(port.slice(1)) <= 65535))) list.push({ name: 'qmd', transport: 'http', url });
  else notes.push('qmd left out: COLABUS_QMD_URL is not a local http URL with a port from 1 to 65535');
  const isFile = p => { try { return io.statSync(p).isFile(); } catch { return false; } };
  let bin = null;
  for (const candidate of cbmCandidates(env)) {
    if (!path.isAbsolute(candidate) || UNSAFE_PATH.test(candidate)) continue;
    if (isFile(candidate)) { bin = candidate; break; }
  }
  if (!bin) notes.push('codebase-memory left out: bin.js not found (set COLABUS_CBM_BIN)');
  else if (UNSAFE_PATH.test(execPath)) notes.push('codebase-memory left out: the node path holds a character the command line cannot carry');
  else if (!path.isAbsolute(execPath) || !isFile(execPath)) notes.push('codebase-memory left out: the node path is not the absolute path of a file');
  else list.push({ name: 'codebase-memory', transport: 'stdio', command: slashes(execPath), args: [slashes(bin)] });
  return { list, notes };
}

// claude: the --mcp-config file text (the measured user-scope entry shape of ~/.claude.json)
function claudeConfigText(list) {
  const mcpServers = {};
  for (const s of list) mcpServers[s.name] = s.transport === 'http' ? { type: 'http', url: s.url } : { type: 'stdio', command: s.command, args: s.args, env: {} };
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}
// codex: -c overrides, TOML literal strings (single quotes, never escapes), forward slashes
function codexArgs(list) {
  const out = [];
  for (const s of list) {
    if (s.transport === 'http') out.push('-c', `mcp_servers.${s.name}.url='${s.url}'`);
    else out.push('-c', `mcp_servers.${s.name}.command='${s.command}'`, '-c', `mcp_servers.${s.name}.args=[${s.args.map(a => `'${a}'`).join(', ')}]`);
  }
  return out;
}
// vibe: the extra --enabled-tools patterns (the servers themselves come from the user's vibe config; the doctor checks they are registered)
function vibeArgs() { return VIBE_PATTERNS.flatMap(p => ['--enabled-tools', p]); }

// The one line a launcher prints and keeps in its call file; the metric reads it to tell an offered seat from one that was not.
function line(mode, list, notes = []) {
  return `SEAT_MCP mode=${mode} servers=${mode === 'kernel' && list.length ? list.map(s => s.name).join(',') : '-'}${notes.length ? ` note="${notes.join('; ')}"` : ''}`;
}

// Everything a launcher needs for one launch: { mode, reason, list, notes, line }. Mode kernel with no resolvable server is still kernel (the vibe
// patterns and the line say what was offered); a launcher that cannot write the claude config file degrades that seat to none.
function plan({ role, env = process.env, io = fs, execPath = process.execPath } = {}) {
  const p = policy({ role, env });
  if (p.mode !== 'kernel') return { ...p, list: [], notes: [], line: line(p.mode, []) };
  const s = servers({ env, io, execPath });
  return { ...p, list: s.list, notes: s.notes, line: line(p.mode, s.list, s.notes) };
}

module.exports = { SERVER_NAMES, QMD_URL, LOCAL_URL, UNSAFE_PATH, KERNEL_ROLES, VIBE_PATTERNS, policy, servers, claudeConfigText, codexArgs, vibeArgs, line, plan };

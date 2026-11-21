'use strict';
// Seat MCP: the kernel gives a launched seat the two mandatory servers qmd and codebase-memory and no other
// server of the user's configuration. One policy for every launcher (docs/ops/cert-launch.cjs, docs/ops/fix-launch.cjs, tools/operator/seats.cjs).
//   mode kernel: author, fixer and pre-review seats get exactly the two servers, and a CHAINED certifier seat
//                (chained: true, PROTO-DEC-0252 item 2: every later certifier of a package may use the kernel MCP
//                set) gets them too. Only the clients with a per-run MCP switch can carry it (CHAIN_MCP_CLIENTS).
//   mode none:   blind certifier and unknown seats get no server (PROTO-DEC-0170 item 4: the first, blind
//                certifier receives no MCP; the index also holds the other seats' review reports, which a blind
//                certifier must not read).
//   mode user:   COLABUS_SEAT_MCP=1 (exactly that string) keeps the old behaviour: the client loads its own user configuration.
// MCP output is advisory (PROTO-DEC-0170 item 4): a server that cannot be resolved is left out with a note and the launch goes on.
// Measured on the clients:
//   codex: `-c mcp_servers.<name>.url='...'` and `.command`/`.args` add a server on top of --ignore-user-config; a backslash path is mangled on the
//          cmd.exe /c line (`C:\Program Files\...` arrived as `C:Program Files`), a forward-slash path arrives intact, so every path here is written with /.
//          `.enabled_tools=[...]` is the server's tool allow list (codex 0.161.0 `mcp get --json` shows it, a wrong type is refused).
//   vibe 2.26.1 (Unified Harness, VIBE_CLI=python): a tool is routed as mcp_SERVER.TOOL; --enabled-tools globs match its display name SERVER_TOOL
//          with every character outside [A-Za-z0-9_$] made _ (mistralai_vibe_local_harness/vibe/_mcp_naming.py, _mcp_models.py MCPToolFilter), so
//          qmd_query and codebase_memory_search_graph: the old pattern codebase-memory_* matched nothing. VIBE_MCP_SERVERS (the environment layer,
//          merged with the user config by name) declares the servers; a stdio command given as a string is cut by shlex.split (a Windows path loses
//          its backslashes and splits at the space), so the command is a one-element list.
//   claude: --strict-mcp-config with --mcp-config FILE loads only the servers of FILE; --disallowedTools removes a tool from the model's context,
//          and a deny rule blocks in every mode, bypassPermissions included (code.claude.com/docs/en/permission-modes, cli-reference).
// A seat gets codebase-memory only through a client switch that limits it to the read-only tools, and a client gets a
// server only when it is proven to reach it (PROVEN below); anything else is left out of the seat with a named reason.
const fs = require('node:fs');
const path = require('node:path');

const SERVER_NAMES = Object.freeze(['qmd', 'codebase-memory']);
const QMD_URL = 'http://localhost:8181/mcp';
// local-only (PROTO-DEC-0170 item 1): an http URL on this machine, no query, no credentials, no quote
const LOCAL_URL = /^http:\/\/(localhost|127\.0\.0\.1)(:[0-9]{1,5})?(\/[A-Za-z0-9._~/-]*)?$/;
// a path that would break the cmd.exe /c line or a TOML literal string is never used
const UNSAFE_PATH = /[&|<>^%!"'`\r\n\t]/;
const KERNEL_ROLES = new Set(['author', 'fixer', 'pre-review']);
// The clients with a per-run MCP switch: only they can carry the kernel set of a chained certifier
// (PROTO-DEC-0252 item 2); the launchers refuse a chained seat on any other route (chain-mcp-unsupported).
const CHAIN_MCP_CLIENTS = Object.freeze(['codex', 'claude', 'vibe']);
// codebase-memory 0.12.1 publishes 17 tools; its own readOnlyHint marks 13 of them read-only (the tool list through the vibe harness).
// delete_project, index_repository, ingest_traces and manage_adr delete or rewrite the shared index: no seat gets them.
const CBM_TOOLS = Object.freeze(['check_index_coverage', 'compare_graphs', 'delete_project', 'detect_changes', 'get_architecture', 'get_code_snippet', 'get_file_outline',
  'get_graph_schema', 'index_repository', 'index_status', 'ingest_traces', 'list_projects', 'manage_adr', 'query_graph', 'search_code', 'search_graph', 'trace_path']);
const CBM_READ_ONLY = Object.freeze(['check_index_coverage', 'compare_graphs', 'detect_changes', 'get_architecture', 'get_code_snippet', 'get_file_outline',
  'get_graph_schema', 'index_status', 'list_projects', 'query_graph', 'search_code', 'search_graph', 'trace_path']);
const CBM_DENIED = Object.freeze(CBM_TOOLS.filter(t => !CBM_READ_ONLY.includes(t)));
// the vibe display name of a server tool, the name its --enabled-tools globs match
const vibeName = (server, tool) => `${server}_${tool}`.replace(/[^A-Za-z0-9_$]/g, '_');
// qmd publishes only read-only tools; both servers are named tool by tool, so a server of the user whose name only starts with qmd_ (display names
// qmd_NAME_TOOL, which a qmd_* glob would match) publishes into a kernel seat only a tool whose display name equals a kernel one (a server
// qmd_multi with a tool get is qmd_multi_get, the name of the qmd tool multi_get): the display name cannot tell two such servers apart
const QMD_TOOLS = Object.freeze(['get', 'multi_get', 'query', 'status']);
const VIBE_PATTERNS = Object.freeze({ qmd: Object.freeze(QMD_TOOLS.map(t => vibeName('qmd', t))), 'codebase-memory': Object.freeze(CBM_READ_ONLY.map(t => vibeName('codebase-memory', t))) });
// The clients proven to reach a kernel server through their own MCP stack (its tool list or a completed call through that client), and the clients
// whose per-run switch limits codebase-memory to CBM_READ_ONLY (measured on the clients):
//   codex 0.161.0: completed qmd and codebase-memory McpToolCall items in its session store; switch enabled_tools.
//   claude 2.1.312: session store, completed mcp__qmd__ and mcp__codebase-memory__ tool results; switch --disallowedTools.
//   vibe 2.26.1: harness streamable-http tool list and status calls to qmd, harness stdio tool list (17) and index_status to codebase-memory;
//                switch --enabled-tools.
//   kimi: completed codebase-memory list_projects calls; no measured qmd call and no measured read-only switch.
// A server a client is not proven to reach is left out of its seat (MCP_CLIENT_UNPROVEN), and so is codebase-memory on a client without a proven
// read-only switch (MCP_READ_ONLY_UNPROVEN): the kernel never hands a seat a broken or a destructive server.
const PROVEN = Object.freeze({
  codex: Object.freeze({ qmd: true, 'codebase-memory': true, readOnly: 'enabled_tools' }),
  claude: Object.freeze({ qmd: true, 'codebase-memory': true, readOnly: '--disallowedTools' }),
  vibe: Object.freeze({ qmd: true, 'codebase-memory': true, readOnly: '--enabled-tools' }),
  kimi: Object.freeze({ qmd: false, 'codebase-memory': true, readOnly: null }),
});

function policy({ role, sealed = false, root, io = fs, env = process.env, chained = false } = {}) {
  // A chained certifier (PROTO-DEC-0252 item 2) is a sealed seat that still gets the kernel set; the explicit seal of any other seat is never bypassed.
  const chainedCertifier = role === 'certifier' && chained === true;
  // Optional-off keeps the pre-Semgrep opt-out.
  if ((!sealed || chainedCertifier) && env.COLABUS_SEAT_MCP === '1' && require('./semgrep-mcp.cjs').selection(root, io).state !== 'selected') return { mode: 'user', reason: 'COLABUS_SEAT_MCP=1' };
  if (chainedCertifier) return { mode: 'kernel', reason: 'chained certifier: PROTO-DEC-0252 item 2' };
  if (sealed || !KERNEL_ROLES.has(role)) return { mode: 'none', reason: 'sealed, certifier or unknown role: PROTO-DEC-0254' };
  return { mode: 'kernel', reason: `role ${role}` };
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
  for (const s of list) mcpServers[s.name] = s.transport === 'http' ? { type: 'http', url: s.url } : { type: 'stdio', command: s.command, args: s.args, env: s.env || {} };
  return `${JSON.stringify({ mcpServers }, null, 2)}\n`;
}
// codex: -c overrides, TOML literal strings (single quotes, never escapes), forward slashes; codebase-memory with its read-only allow list
function codexArgs(list) {
  const out = [];
  for (const s of list) {
    if (s.transport === 'http') out.push('-c', `mcp_servers.${s.name}.url='${s.url}'`);
    else out.push('-c', `mcp_servers.${s.name}.command='${s.command}'`, '-c', `mcp_servers.${s.name}.args=[${s.args.map(a => `'${a}'`).join(', ')}]`);
    if (s.name === 'codebase-memory') out.push('-c', `mcp_servers.${s.name}.enabled_tools=[${CBM_READ_ONLY.map(t => `'${t}'`).join(', ')}]`);
    for (const [k, v] of Object.entries(s.env || {})) out.push('-c', `mcp_servers.${s.name}.env.${k}='${v}'`);
  }
  return out;
}
// claude: the codebase-memory tools outside the read-only list, denied by name (claude has no per-server allow list; a deny rule holds under
// --dangerously-skip-permissions). One comma-separated value, so the variadic flag never takes the next argument.
function claudeArgs(list = []) { return list.some(s => s.name === 'codebase-memory') ? ['--disallowedTools', CBM_DENIED.map(t => `mcp__codebase-memory__${t}`).join(',')] : []; }
// vibe: the --enabled-tools patterns of the servers in the plan (a server left out of the plan gets no pattern)
function vibeArgs(list = []) {
  const names = list.map(s => s.name);
  return [...names.flatMap(n => (Object.hasOwn(VIBE_PATTERNS, n) ? VIBE_PATTERNS[n] : [])), ...(names.includes('semgrep') ? require('./semgrep-mcp.cjs').TOOLS.map(t => `semgrep_${t}`) : [])].flatMap(p => ['--enabled-tools', p]);
}
// vibe: the VIBE_MCP_SERVERS entry of a kernel server (the stdio command is a one-element list: a string is cut by shlex.split)
function vibeServer(s) {
  return s.transport === 'http' ? { name: s.name, transport: 'streamable-http', url: s.url }
    : { name: s.name, transport: 'stdio', command: [s.command], args: s.args, ...(s.name === 'codebase-memory' ? { disabled_tools: [...CBM_DENIED] } : {}) };
}

// The one line a launcher prints and keeps in its call file; the metric reads it to tell an offered seat from one that was not.
function line(mode, list, notes = []) {
  return `SEAT_MCP mode=${mode} servers=${mode === 'kernel' && list.length ? list.map(s => s.name).join(',') : '-'}${notes.length ? ` note="${notes.join('; ')}"` : ''}`;
}

// Everything a launcher needs for one launch: { mode, reason, list, notes, line }. Mode kernel with no resolvable server is still kernel (the line
// says what was offered); a launcher that cannot write the claude config file degrades that seat to none, and forSeat applies the client's proof.
function plan({ role, sealed = false, root, env = process.env, io = fs, execPath = process.execPath, chained = false } = {}) {
  const p = policy({ role, sealed, root, io, env, chained });
  if (p.mode !== 'kernel') return { ...p, list: [], notes: [], line: line(p.mode, []),
    ...(p.mode === 'none' && require('./semgrep-mcp.cjs').selection(root, io).state === 'selected' ? { semgrepBlocked: true } : {}) };
  const s = servers({ env, io, execPath });
  if (role === 'author' || role === 'fixer') {
    const optional = require('./semgrep-mcp.cjs').resolve({ root, env, io, execPath });
    s.notes.push(...optional.notes);
    if (optional.descriptor) { s.list.push(optional.descriptor); s.notes.push(require('./semgrep-mcp.cjs').RESTRICTION); }
  }
  return { ...p, list: s.list, notes: s.notes, line: line(p.mode, s.list, s.notes) };
}

function clientEnv(p, client, env) {
  const s = p.list.find(s => s.name === 'semgrep');
  // a vibe kernel seat gets the kernel servers declared by the kernel (the environment layer outranks the user config and is merged with it by
  // name, vibe core/config/vibe_schema.py mcp_servers WithUnionMerge), so the seat no longer depends on the user's entries
  const kernel = client === 'vibe' && p.mode === 'kernel' ? p.list.filter(x => SERVER_NAMES.includes(x.name)).map(vibeServer) : [];
  // An absent/disabled optional server must leave legacy launch bytes intact.
  // An explicitly selected server still needs a disabled entry for forbidden roles.
  if (!s && !p.semgrepBlocked && !kernel.length) return env;
  // the optional server keeps its first place; vibe merges the list by name, so the order is not read
  if (client === 'vibe') return { ...env, VIBE_MCP_SERVERS: JSON.stringify([...(s || p.semgrepBlocked ? [{ name: 'semgrep', transport: 'stdio', command: s ? s.command : process.execPath,
    args: s ? s.args : [], env: s ? s.env : {}, disabled: !s }] : []), ...kernel]) };
  const key = { kilo: 'KILO_CONFIG_CONTENT', mimo: 'MIMOCODE_CONFIG_CONTENT' }[client];
  if (!key) return env;
  let config = {};
  try { config = JSON.parse(env[key] || '{}'); } catch { return env; }
  if (!config || typeof config !== 'object' || Array.isArray(config)) return env;
  return { ...env, [key]: JSON.stringify({ ...config, mcp: { ...(config.mcp || {}), semgrep: s ? { type: 'local', command: [s.command, ...s.args], environment: s.env, enabled: true } : { enabled: false } } }) };
}
// The kernel servers of a plan that the named client is proven to reach (PROVEN); every server left out gets a named note. A kernel plan left with
// no server at all becomes mode none. Without a client name the plan is returned as it is (the launcher names the client at the use site).
function reach(p, client) {
  if (p.mode !== 'kernel' || typeof client !== 'string') return p;
  const proof = Object.hasOwn(PROVEN, client) ? PROVEN[client] : {};
  const list = []; const notes = [...(p.notes || [])];
  for (const s of p.list) {
    if (!SERVER_NAMES.includes(s.name)) list.push(s);
    else if (proof[s.name] !== true) notes.push(`MCP_CLIENT_UNPROVEN: ${s.name} left out for ${client} (no tool list or completed call through this client is measured)`);
    else if (s.name === 'codebase-memory' && !proof.readOnly) notes.push(`MCP_READ_ONLY_UNPROVEN: codebase-memory left out for ${client} (no per-run switch limits it to the read-only tools)`);
    else list.push(s);
  }
  if (list.length === p.list.length) return p;
  if (!list.length) return { ...p, mode: 'none', reason: `no kernel server is proven for ${client}`, list, notes, line: line('none', list, notes) };
  return { ...p, list, notes, line: line(p.mode, list, notes) };
}
// The caller may carry a cached plan; role authority is always rechecked at the use site.
function forSeat(candidate, options) {
  const p = policy(options).mode === 'none' ? plan(options) : candidate || plan(options);
  if ((!['author', 'fixer'].includes(options.role) || (options.client && !['claude', 'codex', 'vibe', 'kilo', 'mimo', 'kimi'].includes(options.client))) && p.list.some(s => s.name === 'semgrep')) {
    const list = p.list.filter(s => s.name !== 'semgrep');
    const notes = p.notes.filter(n => !n.startsWith('SEMGREP_LOCAL_ONLY:')).concat('SEMGREP_CLIENT_UNMEASURED: optional server skipped');
    return reach({ ...p, list, notes, line: line(p.mode, list, notes) }, options.client);
  }
  return reach(p, options.client);
}
function kimiTmpRoot({ role, root, io = fs } = {}) {
  if (!['author', 'fixer'].includes(role) || require('./semgrep-mcp.cjs').selection(root, io).state !== 'selected') return undefined;
  try {
    let dir = io.realpathSync(root);
    for (const part of ['.ai', 'runtime', 'semgrep-seats']) {
      dir = path.join(dir, part);
      if (!io.existsSync(dir)) io.mkdirSync(dir, { mode: 0o700 });
      if (io.lstatSync(dir).isSymbolicLink() || io.realpathSync(dir) !== dir) return undefined;
    }
    return dir;
  } catch { return undefined; }
}
function kimiConfig(p, home, root, io = fs) {
  if (!p.list.some(s => s.name === 'semgrep')) return true;
  try {
    const rel = path.relative(io.realpathSync(root), io.realpathSync(home));
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || io.lstatSync(home).isSymbolicLink()) return false;
    io.writeFileSync(path.join(home, 'mcp.json'), claudeConfigText(p.list), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return true;
  } catch { return false; }
}
function claudeConfigFile(p, { role, root, fallback, io = fs }) {
  let file = fallback;
  if (p.list.some(s => s.name === 'semgrep')) {
    const dir = kimiTmpRoot({ role, root, io });
    if (!dir) throw new Error('SEMGREP_CONFIG_ROOT_REFUSED');
    file = path.join(dir, `claude-${require('node:crypto').randomBytes(12).toString('hex')}.json`);
  }
  io.writeFileSync(file, claudeConfigText(p.list), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return file;
}
module.exports = { SERVER_NAMES, QMD_URL, LOCAL_URL, UNSAFE_PATH, KERNEL_ROLES, CHAIN_MCP_CLIENTS, CBM_TOOLS, CBM_READ_ONLY, CBM_DENIED, VIBE_PATTERNS, PROVEN, vibeName, policy, servers,
  claudeConfigText, codexArgs, claudeArgs, vibeArgs, vibeServer, line, plan, clientEnv, reach, forSeat, kimiTmpRoot, kimiConfig, claudeConfigFile };

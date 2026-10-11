'use strict';
// Measures the tool-schema size of MCP servers (PROTO-DEC-0170 item 3): starts each server locally over stdio from its configured
// command, sends initialize + notifications/initialized + tools/list (following nextCursor until it is absent), and prints tools count, pages, bytes and
// estimated tokens (bytes / 4) per server. Advisory only: the figure is never Evidence and never a gate input.
//
//   node docs/ops/mcp-schema-budget.cjs --config .mcp.json [--server NAME[,NAME]] [--timeout-ms N] [--json]
//
// Config: a JSON file with an "mcpServers" object ({ name: { command, args, env } }, the .mcp.json shape). Servers of another
// transport (url / type http) are not started: they are reported as "not measured" and never contacted.
// Output never contains env values, command arguments, or raw server stderr: only the server name, the command's base name,
// the counts and a short failure class. Exit 0: every selected server answered. Exit 2: a server did not answer, or bad usage.
// Nothing is installed, downloaded or written; the tool only spawns the configured commands.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_TIMEOUT_MS = 60000;
const PROTOCOL_VERSION = '2025-06-18';
const MAX_PAGES = 100;
const MAX_LINE_BYTES = 16 * 1024 * 1024;

function parseArgs(argv) {
  const o = { config: '', servers: [], timeoutMs: DEFAULT_TIMEOUT_MS, json: false };
  const need = (i, name) => { if (i + 1 >= argv.length) throw new Error(`${name} needs a value`); return argv[i + 1]; };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--config') { o.config = need(i, a); i++; }
    else if (a.startsWith('--config=')) o.config = a.slice(9);
    else if (a === '--server') { o.servers.push(...need(i, a).split(',').filter(Boolean)); i++; }
    else if (a.startsWith('--server=')) o.servers.push(...a.slice(9).split(',').filter(Boolean));
    else if (a === '--timeout-ms') { o.timeoutMs = Number(need(i, a)); i++; }
    else if (a.startsWith('--timeout-ms=')) o.timeoutMs = Number(a.slice(13));
    else if (a === '--json') o.json = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.config) throw new Error('--config <file> is required');
  if (!Number.isInteger(o.timeoutMs) || o.timeoutMs < 100) throw new Error('--timeout-ms must be an integer >= 100');
  return o;
}

function loadConfig(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { throw new Error(`cannot read config: ${file}`); }
  let json;
  try { json = JSON.parse(text.replace(/^\uFEFF/, '')); } catch { throw new Error(`config is not valid JSON: ${file}`); }
  const servers = json && typeof json === 'object' ? json.mcpServers : null;
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new Error('config has no "mcpServers" object');
  return servers;
}

// ${VAR} and ${VAR:-default} in command, args and env values, as the clients expand them. Values are never printed.
function expand(v, env) {
  return String(v).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, n, d) => (env[n] !== undefined && env[n] !== '' ? env[n] : d !== undefined ? d : ''));
}

function candidateExts(env) {
  if (process.platform !== 'win32') return [''];
  const pathext = (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean).map(x => x.toLowerCase());
  return [...new Set(['.cmd', '.exe', ...pathext, ''])];
}
function findOnPath(cmd, env) {
  if (path.isAbsolute(cmd) || /[\\/]/.test(cmd)) return fs.existsSync(cmd) ? cmd : null;
  const exts = candidateExts(env);
  const dirs = String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean);
  for (const d of dirs) {
    for (const e of exts) {
      const full = path.join(d, cmd + e);
      try { if (fs.statSync(full).isFile()) return full; } catch { /* next */ }
    }
  }
  return null;
}
const winQuote = s => `"${String(s).replace(/"/g, '""')}"`;
function plan(command, args, env) {
  if (process.platform !== 'win32') return { file: command, args, opts: {} };
  const resolved = findOnPath(command, env) || command;
  if (/\.(cmd|bat)$/i.test(resolved)) {
    return { file: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${[winQuote(resolved), ...args.map(winQuote)].join(' ')}"`], opts: { windowsVerbatimArguments: true } };
  }
  return { file: resolved, args, opts: {} };
}

function killTree(child) {
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    else child.kill('SIGKILL');
  } catch { /* already gone */ }
}

// One server: initialize, tools/list (all pages, at most MAX_PAGES; a cursor loop or the cap is a failure). Resolves { ok, tools, bytes, tokens } or { ok:false, reason }.
function measureServer(name, spec, timeoutMs) {
  return new Promise(resolve => {
    const baseEnv = { ...process.env };
    const env = { ...baseEnv };
    for (const [k, v] of Object.entries(spec.env && typeof spec.env === 'object' ? spec.env : {})) env[k] = expand(v, baseEnv);
    const command = expand(spec.command, baseEnv);
    const args = (Array.isArray(spec.args) ? spec.args : []).map(a => expand(a, baseEnv));
    const p = plan(command, args, env);
    let child;
    let done = false;
    let buf = '';
    let nextId = 1;
    const tools = [];
    let pages = 0;
    const seenCursors = new Set();
    const finish = r => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (child) { try { child.stdin.end(); } catch { /* closed */ } killTree(child); }
      resolve(r);
    };
    const fail = reason => finish({ ok: false, reason });
    const timer = setTimeout(() => fail(`no answer within ${timeoutMs} ms`), timeoutMs);
    try {
      child = spawn(p.file, p.args, { env, cwd: process.cwd(), stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true, ...p.opts });
    } catch { fail('could not start the command'); return; }
    child.on('error', () => fail('could not start the command'));
    child.on('exit', code => fail(`server exited (code ${code === null ? 'signal' : code}) before it answered`));
    child.stdin.on('error', () => { /* a dead server is reported by the exit handler */ });
    const send = m => { try { child.stdin.write(`${JSON.stringify(m)}\n`); } catch { /* reported by exit */ } };
    const initId = nextId++;
    send({ jsonrpc: '2.0', id: initId, method: 'initialize', params: { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: 'mcp-schema-budget', version: '1.0.0' } } });
    let listId = 0;
    const askList = cursor => { listId = nextId++; send({ jsonrpc: '2.0', id: listId, method: 'tools/list', params: cursor ? { cursor } : {} }); };
    const onMessage = msg => {
      if (!msg || typeof msg !== 'object' || msg.id === undefined) return; // log notifications and requests from the server are ignored
      if (msg.id === initId) {
        if (msg.error) { fail('initialize was refused'); return; }
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        askList();
      } else if (msg.id === listId) {
        if (msg.error || !msg.result || !Array.isArray(msg.result.tools)) { fail('tools/list failed or malformed'); return; }
        tools.push(...msg.result.tools);
        pages++;
        const cursor = msg.result.nextCursor;
        if (cursor) {
          // A partial list is never reported as a measurement: a repeated cursor or the page cap is a named failure.
          if (seenCursors.has(cursor)) { fail(`pagination loop: the server repeated a cursor after ${pages} pages`); return; }
          if (pages >= MAX_PAGES) { fail(`page cap ${MAX_PAGES} reached and the tool list is not finished`); return; }
          seenCursors.add(cursor);
          askList(cursor);
        } else {
          const bytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
          finish({ ok: true, tools: tools.length, pages, bytes, tokens: Math.ceil(bytes / 4) });
        }
      }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buf += chunk;
      if (buf.length > MAX_LINE_BYTES) { fail('server output exceeded the size limit'); return; }
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; } // non-JSON lines (banners) are not protocol
        onMessage(msg);
      }
    });
  });
}

async function run(argv, io = {}) {
  const out = io.out || (s => process.stdout.write(`${s}\n`));
  const err = io.err || (s => process.stderr.write(`${s}\n`));
  let o;
  try { o = parseArgs(argv); } catch (e) {
    err(`mcp-schema-budget: ${e.message}`);
    err('usage: node docs/ops/mcp-schema-budget.cjs --config <file> [--server NAME[,NAME]] [--timeout-ms N] [--json]');
    return 2;
  }
  let servers;
  try { servers = loadConfig(path.resolve(o.config)); } catch (e) { err(`mcp-schema-budget: ${e.message}`); return 2; }
  const names = o.servers.length ? o.servers : Object.keys(servers);
  const unknown = names.filter(n => !Object.prototype.hasOwnProperty.call(servers, n));
  if (unknown.length) { err(`mcp-schema-budget: not in the config: ${unknown.join(', ')}`); return 2; }
  if (!names.length) { err('mcp-schema-budget: the config lists no servers'); return 2; }
  const rows = [];
  for (const name of names) {
    const spec = servers[name];
    if (!spec || typeof spec.command !== 'string' || !spec.command) {
      rows.push({ name, command: '-', ok: false, notMeasured: true, reason: 'not a stdio server (no command); never contacted' });
      continue;
    }
    const r = await measureServer(name, spec, o.timeoutMs);
    rows.push({ name, command: path.basename(spec.command).replace(/\$\{[^}]*\}/g, '${..}'), ...r });
  }
  const measured = rows.filter(r => r.ok);
  const failed = rows.filter(r => !r.ok);
  const total = measured.length
    ? { tools: measured.reduce((s, r) => s + r.tools, 0), bytes: measured.reduce((s, r) => s + r.bytes, 0), tokens: measured.reduce((s, r) => s + r.tokens, 0) }
    : { tools: null, bytes: null, tokens: null };
  if (o.json) {
    out(JSON.stringify({ tool: 'mcp-schema-budget', estimate: 'tokens = ceil(bytes / 4)', servers: rows, total }, null, 2));
  } else {
    for (const r of rows) {
      if (r.ok) out(`SERVER ${r.name} command=${r.command} tools=${r.tools} pages=${r.pages} bytes=${r.bytes} tokens~${r.tokens}`);
      else out(`SERVER ${r.name} command=${r.command} NOT MEASURED: ${r.reason}`);
    }
    if (measured.length) out(`TOTAL measured=${measured.length} failed=${failed.length} tools=${total.tools} bytes=${total.bytes} tokens~${total.tokens} (estimate = bytes/4, advisory, never Evidence)`);
    else out(`TOTAL not measured (measured=0 failed=${failed.length}; no server answered, so there is no number)`);
  }
  const code = failed.length ? 2 : 0;
  if (!o.json) out(`RESULT exit=${code}`);
  return code;
}

if (require.main === module) {
  run(process.argv.slice(2)).then(c => process.exit(c), e => { process.stderr.write(`mcp-schema-budget: ${e.message}\n`); process.exit(2); });
}
module.exports = { run, parseArgs, loadConfig, measureServer, expand, findOnPath, plan };

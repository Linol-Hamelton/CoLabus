#!/usr/bin/env node
'use strict';
// mcp-wiring: the kernel owns the two mandatory MCP servers qmd and codebase-memory (PROTO-DEC-0170 item 1) for every
// client and every seat. This tool is advisory (PROTO-DEC-0170 item 4): its output is never Evidence and never a gate input.
//   node .ai/bin/mcp-wiring.cjs clients [--json]                               the client registry: config file, entry formats, how to verify
//   node .ai/bin/mcp-wiring.cjs doctor [--home DIR] [--no-probe] [--json]       read-only: per client, are qmd and codebase-memory registered and reachable
//   node .ai/bin/mcp-wiring.cjs apply [--home DIR] [--client NAME]... [--apply] add the missing entries; a dry run unless --apply; backup first;
//                                                                              byte-preserving (insert or append only); a file that does not parse, is a link,
//                                                                              or whose real path leaves the home is refused
//   node .ai/bin/mcp-wiring.cjs host plan [--root DIR]                         the host defaults: .cbmignore patterns, the qmd collection plan, the hook state
//   node .ai/bin/mcp-wiring.cjs host apply [--root DIR] [--apply] [--reindex-hook]
//                                                                              writes the missing .cbmignore patterns; the post-merge reindex hook only with
//                                                                              the switch --reindex-hook (owner rule: machine-changing features are switches)
//   node .ai/bin/mcp-wiring.cjs metric [--runtime DIR] [--launches FILE]... [--since YYYY-MM-DD] [--json]
//                                                                              MCP tool calls per seat from the call files, next to the tokens of the record
// Nothing here starts, installs or downloads an MCP server (PROTOCOL.md MCP policy item 3); the doctor's only probe is one local HTTP request to qmd.
// Exit codes: 0 done (doctor: every client registered, no server found unreachable), 1 a finding (doctor: something missing, apply: a refusal), 2 usage.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const seatMcp = require('./lib/seat-mcp.cjs');

const SERVERS = seatMcp.SERVER_NAMES;
// The baseline the 2.0.1 release compares against (the seat call files of the 7 days before it: no seat called qmd or codebase-memory).
const BASELINE = Object.freeze({ date: '2026-10-28', seats: 308, qmdSeats: 0, cbmSeats: 0 });

// ---------- client registry (measured on the clients from hand-made working entries) ----------
const jsonHttp = { claude: url => ({ type: 'http', url }), kimi: url => ({ url, transport: 'http' }), opencode: url => ({ type: 'remote', url, enabled: true }) };
const jsonStdio = { claude: (command, args) => ({ type: 'stdio', command, args, env: {} }), plain: (command, args) => ({ command, args }), opencode: (command, args) => ({ type: 'local', command: [command, ...args], enabled: true }) };
const CLIENTS = Object.freeze({
  claude: { file: '.claude.json', format: 'json', container: 'mcpServers', http: jsonHttp.claude, stdio: jsonStdio.claude, applyBy: 'command',
    verify: 'claude mcp list', note: 'the running client rewrites ~/.claude.json, so apply prints the claude mcp add commands instead of editing the file' },
  codex: { file: '.codex/config.toml', format: 'toml-table', verify: 'codex mcp list --json', note: 'table [mcp_servers.NAME]: url for http, command and args for stdio' },
  vibe: { file: '.vibe/config.toml', format: 'toml-array', verify: 'unknown: vibe 2.26.1 has no MCP list command; a seat started with --enabled-tools qmd_* shows qmd_ tool events',
    note: 'array [[mcp_servers]] with name, transport streamable-http or stdio; tools are published as NAME_TOOL' },
  kilo: { file: '.config/kilo/kilo.jsonc', format: 'jsonc', container: 'mcp', http: jsonHttp.opencode, stdio: jsonStdio.opencode, verify: 'kilo mcp list' },
  mimo: { file: '.config/mimocode/mimocode.jsonc', format: 'jsonc', container: 'mcp', http: jsonHttp.opencode, stdio: jsonStdio.opencode, verify: 'mimo mcp list' },
  kimi: { file: '.kimi-code/mcp.json', format: 'json', container: 'mcpServers', http: jsonHttp.kimi, stdio: jsonStdio.plain, verify: 'unknown: kimi is not on PATH here (the launcher resolves it to an absolute path)' },
});

class ParseError extends Error {}

// ---------- TOML: a strict reader of the subset the client configs use; anything it does not understand is a ParseError (apply refuses) ----------
function parseToml(text) {
  const root = {}; const frozen = new WeakSet(); const tablesOfArrays = new WeakSet(); const defined = new Set();
  let i = 0; let line = 1;
  const fail = m => { throw new ParseError(`TOML line ${line}: ${m}`); };
  const peek = (k = 0) => text[i + k];
  const ws = () => { while (peek() === ' ' || peek() === '\t') i++; };
  const comment = () => { if (peek() === '#') while (i < text.length && peek() !== '\n') { if (peek() === '\r' && peek(1) !== '\n') fail('bare carriage return'); i++; } };
  const eol = () => { ws(); comment(); if (i >= text.length) return; if (peek() === '\r' && peek(1) === '\n') i++; if (peek() !== '\n') fail(`unexpected ${JSON.stringify(peek())}`); i++; line++; };
  const gap = () => { for (;;) { ws(); comment(); if (peek() === '\r' && peek(1) === '\n') i++; if (peek() === '\n') { i++; line++; continue; } return; } };
  function basic(multi) {
    let out = '';
    for (;;) {
      if (i >= text.length) fail('unterminated string');
      const c = text[i];
      if (multi && text.startsWith('"""', i)) { let q = 3; while (text[i + q] === '"' && q < 5) q++; out += '"'.repeat(q - 3); i += q; return out; }
      if (!multi && c === '"') { i++; return out; }
      if (c === '\n') { if (!multi) fail('newline in a string'); line++; out += c; i++; continue; }
      if (c === '\r' && multi && text[i + 1] === '\n') { out += c; i++; continue; }
      if (c === '\u007f' || (c < ' ' && c !== '\t')) fail('a control character in a string');
      if (c === '\\') {
        const e = text[i + 1];
        const map = { b: '\b', t: '\t', n: '\n', f: '\f', r: '\r', '"': '"', '\\': '\\', e: '\u001b' };
        if (map[e] !== undefined) { out += map[e]; i += 2; continue; }
        if (e === 'u' || e === 'U') { const len = e === 'u' ? 4 : 8; const hex = text.slice(i + 2, i + 2 + len); if (!/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== len) fail('bad unicode escape'); out += String.fromCodePoint(parseInt(hex, 16)); i += 2 + len; continue; }
        if (multi && /[ \t\r\n]/.test(e)) { let j = i + 1; while (/[ \t]/.test(text[j] || '')) j++; if (text[j] === '\r') j++; if (text[j] !== '\n') fail('bad line-ending backslash'); while (/[ \t\r\n]/.test(text[j] || '')) { if (text[j] === '\n') line++; j++; } i = j; continue; }
        fail(`bad escape \\${e}`);
      }
      out += c; i++;
    }
  }
  function literal(multi) {
    const end = multi ? "'''" : "'";
    const j = text.indexOf(end, i);
    if (j < 0) fail('unterminated literal string');
    let k = j; if (multi) while (text[k + 3] === "'" && k - j < 2) k++;
    const out = text.slice(i, k);
    if (!multi && /[\r\n]/.test(out)) fail('newline in a literal string');
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|\r(?!\n)/.test(out)) fail('a control character in a literal string');
    line += (out.match(/\n/g) || []).length; i = k + end.length; return out;
  }
  function str() {
    if (text.startsWith('"""', i)) { i += 3; if (peek() === '\r' && peek(1) === '\n') i += 2; else if (peek() === '\n') i++; return basic(true); }
    if (text.startsWith("'''", i)) { i += 3; if (peek() === '\r' && peek(1) === '\n') i += 2; else if (peek() === '\n') i++; return literal(true); }
    if (peek() === '"') { i++; return basic(false); }
    if (peek() === "'") { i++; return literal(false); }
    return null;
  }
  function key() {
    const parts = [];
    for (;;) {
      ws();
      let part;
      if (peek() === '"' || peek() === "'") { part = peek() === '"' ? (i++, basic(false)) : (i++, literal(false)); }
      else { const m = /^[A-Za-z0-9_-]+/.exec(text.slice(i, i + 256)); if (!m) fail('bad key'); part = m[0]; i += part.length; }
      parts.push(part); ws();
      if (peek() === '.') { i++; continue; }
      return parts;
    }
  }
  function value() {
    ws();
    const s = str(); if (s !== null) return s;
    if (peek() === '[') {
      i++; const arr = []; frozen.add(arr);
      for (;;) { gap(); if (peek() === ']') { i++; return arr; } arr.push(value()); gap(); if (peek() === ',') { i++; continue; } if (peek() === ']') { i++; return arr; } fail('bad array'); }
    }
    if (peek() === '{') {
      i++; const tbl = {}; ws();
      if (peek() === '}') { i++; frozen.add(tbl); return tbl; }
      for (;;) { const k = key(); if (peek() !== '=') fail('expected = in an inline table'); i++; setKey(tbl, k, value()); ws(); if (peek() === ',') { i++; continue; } if (peek() === '}') { i++; frozen.add(tbl); return tbl; } fail('bad inline table'); }
    }
    const m = /^[0-9A-Za-z_+\-.:]+(?: [0-9]{2}:[0-9]{2}[0-9A-Za-z_+\-.:]*)?/.exec(text.slice(i, i + 64));
    if (!m) fail('expected a value');
    const t = m[0]; i += t.length;
    if (t === 'true') return true; if (t === 'false') return false;
    if (/^[+-]?(0|[1-9](_?[0-9])*)$/.test(t) || /^0x[0-9A-Fa-f](_?[0-9A-Fa-f])*$|^0o[0-7](_?[0-7])*$|^0b[01](_?[01])*$/.test(t)) return Number(t.replace(/_/g, ''));
    if (/^[+-]?(0|[1-9](_?[0-9])*)(\.[0-9](_?[0-9])*)?([eE][+-]?[0-9](_?[0-9])*)?$/.test(t) || /^[+-]?(inf|nan)$/.test(t)) return Number(t.replace(/_/g, '').replace(/inf/, 'Infinity'));
    if (/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?$|^\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(t)) return t;
    fail(`bad value ${JSON.stringify(t.slice(0, 20))}`);
  }
  function setKey(table, parts, v) {
    let t = table;
    for (const p of parts.slice(0, -1)) {
      if (t[p] === undefined) t[p] = {};
      else if (typeof t[p] !== 'object' || Array.isArray(t[p]) || frozen.has(t[p])) fail(`key ${parts.join('.')} extends a value`);
      t = t[p];
    }
    const last = parts[parts.length - 1];
    if (Object.hasOwn(t, last)) fail(`duplicate key ${parts.join('.')}`);
    t[last] = v;
  }
  function walk(parts, forArray) {
    let t = root;
    for (const [n, p] of parts.entries()) {
      const lastPart = n === parts.length - 1;
      if (lastPart && forArray) {
        if (t[p] === undefined) { t[p] = []; tablesOfArrays.add(t[p]); }
        if (!Array.isArray(t[p]) || !tablesOfArrays.has(t[p])) fail(`[[${parts.join('.')}]] is not an array of tables`);
        const fresh = {}; t[p].push(fresh); return fresh;
      }
      if (t[p] === undefined) t[p] = {};
      let next = t[p];
      if (Array.isArray(next)) { if (!tablesOfArrays.has(next) || lastPart) fail(`table ${parts.join('.')} redefines an array`); next = next[next.length - 1]; }
      if (typeof next !== 'object' || next === null || frozen.has(next)) fail(`table ${parts.join('.')} extends a value`);
      t = next;
    }
    return t;
  }
  let current = root;
  for (;;) {
    gap();
    if (i >= text.length) break;
    if (peek() === '[') {
      const arr = peek(1) === '[';
      i += arr ? 2 : 1;
      const parts = key();
      if (arr ? !text.startsWith(']]', i) : peek() !== ']') fail('bad table header');
      i += arr ? 2 : 1;
      if (!arr) { const id = JSON.stringify(parts); if (defined.has(id)) fail(`table ${parts.join('.')} defined twice`); defined.add(id); }
      current = walk(parts, arr);
      eol();
      continue;
    }
    const parts = key();
    if (peek() !== '=') fail('expected =');
    i++;
    setKey(current, parts, value());
    eol();
  }
  return root;
}

// ---------- JSON with comments: one scanner gives the parse text (comments and trailing commas removed) and the insertion offsets ----------
function scanJson(text, allowComments) {
  let out = ''; let i = 0; let depth = 0; let rootOpen = -1;
  const members = []; // depth-1 keys: { key, valueStart }
  let lastString = null; let lastStringEnd = -1;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1; while (j < text.length && text[j] !== '"') { if (text[j] === '\\') j++; j++; }
      if (j >= text.length) throw new ParseError('unterminated string');
      const raw = text.slice(i, j + 1); out += raw; lastString = raw; lastStringEnd = j + 1; i = j + 1;
      continue;
    }
    if (allowComments && c === '/' && text[i + 1] === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (allowComments && c === '/' && text[i + 1] === '*') { const j = text.indexOf('*/', i + 2); if (j < 0) throw new ParseError('unterminated comment'); out += ' '; i = j + 2; continue; }
    if (c === ':' && depth === 1 && lastString !== null && /^\s*$/.test(text.slice(lastStringEnd, i).replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, ''))) {
      // the value starts after the blanks and the comments that follow the colon
      let k = i + 1;
      for (;;) { while (/\s/.test(text[k] || '')) k++; if (allowComments && text.startsWith('//', k)) { while (k < text.length && text[k] !== '\n') k++; continue; } if (allowComments && text.startsWith('/*', k)) { const e = text.indexOf('*/', k + 2); if (e < 0) break; k = e + 2; continue; } break; }
      try { members.push({ key: JSON.parse(lastString), valueStart: k }); } catch { throw new ParseError('bad key'); }
    }
    if (c === ',' && allowComments) {
      let k = i + 1;
      for (;;) { while (/\s/.test(text[k] || '')) k++; if (text.startsWith('//', k)) { while (k < text.length && text[k] !== '\n') k++; continue; } if (text.startsWith('/*', k)) { const e = text.indexOf('*/', k + 2); if (e < 0) break; k = e + 2; continue; } break; }
      if (text[k] === '}' || text[k] === ']') { i++; continue; }
    }
    if (c === '{' || c === '[') { if (depth === 0 && c === '{' && rootOpen < 0) rootOpen = i; depth++; }
    if (c === '}' || c === ']') depth--;
    out += c; i++;
  }
  return { parseText: out, rootOpen, rootHasMember: members.length > 0, members };
}
function parseJsonish(text, format) {
  const scan = scanJson(text, format === 'jsonc');
  let value;
  try { value = JSON.parse(scan.parseText); } catch (e) { throw new ParseError(`JSON: ${e.message}`); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ParseError('the top level is not an object');
  return { value, scan };
}

function parseConfig(text, format) {
  if (text.charCodeAt(0) === 0xfeff) throw new ParseError('the file starts with a byte order mark');
  if (format === 'toml-table' || format === 'toml-array') return { value: parseToml(text) };
  return parseJsonish(text, format);
}

// ---------- expected entries and registration ----------
function expectedServers(opts = {}) {
  const env = opts.env || process.env;
  const s = seatMcp.servers({ env, io: opts.io || fs, execPath: opts.execPath || process.execPath });
  // native paths for the client files (JSON escapes them, TOML keeps them in literal strings); the seat argv uses forward slashes
  return { list: s.list.map(x => x.transport === 'http' ? x : { ...x, command: path.normalize(x.command), args: x.args.map(a => path.normalize(a)) }), notes: s.notes };
}
function entryOf(client, value, name) {
  const spec = CLIENTS[client];
  if (spec.format === 'toml-array') return Array.isArray(value.mcp_servers) ? value.mcp_servers.find(e => e && e.name === name) : undefined;
  const container = spec.format === 'toml-table' ? value.mcp_servers : value[spec.container];
  return container && typeof container === 'object' && !Array.isArray(container) ? container[name] : undefined;
}
// What an entry is: { kind: 'http', url } | { kind: 'stdio', command, args } | { kind: 'other' }
function entryKind(entry) {
  if (!entry || typeof entry !== 'object') return { kind: 'other' };
  const url = entry.url || entry.serverUrl;
  if (typeof url === 'string') return { kind: 'http', url };
  if (Array.isArray(entry.command)) return { kind: 'stdio', command: entry.command[0], args: entry.command.slice(1) };
  if (typeof entry.command === 'string') return { kind: 'stdio', command: entry.command, args: Array.isArray(entry.args) ? entry.args : [] };
  return { kind: 'other' };
}
const samePath = (a, b) => typeof a === 'string' && typeof b === 'string' && path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase();
// a command that runs node: the expected one, or a node binary named differently (node, node.exe, another absolute path of node)
const nodeCommand = (command, want) => samePath(command, want.command) || (typeof command === 'string' && /^node(\.exe)?$/i.test(path.basename(command)));
function registration(entry, want) {
  if (entry === undefined) return 'missing';
  // opencode clients write enabled: false, a client entry may also carry disabled: true
  if (entry && (entry.enabled === false || entry.disabled === true)) return 'disabled';
  const k = entryKind(entry);
  if (want.transport === 'http') return k.kind === 'http' && k.url === want.url ? 'ok' : 'differs';
  if (k.kind !== 'stdio') return 'differs';
  // the stdio server is the same bin.js run by node; a right bin.js behind a command that is not node is not a working entry
  return nodeCommand(k.command, want) && k.args.some(a => samePath(a, want.args[0])) ? 'ok' : 'differs';
}

function home(opts) { return opts.home || os.homedir(); }

// Why a write to target would leave base, or null. The real path of the target's directory and of the target itself must stay inside the real
// path of base (a junction or a symlink never carries a write out of --home or --root); an existing target that is a link or has a second hard
// link is refused, since a replace would cut the link and an append would change a file that also lives elsewhere.
function writeTargetProblem(base, target, io = fs) {
  const realpath = io.realpathSync || fs.realpathSync;
  const real = p => (realpath.native || realpath)(p);
  const inside = (root, p) => { const rel = path.relative(root, p); return rel !== '' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel); };
  let realBase; try { realBase = real(base); } catch (e) { return `the directory ${base} does not resolve (${e.code || 'error'})`; }
  let realDir; try { realDir = real(path.dirname(target)); } catch (e) { return `the directory of ${target} does not resolve (${e.code || 'error'})`; }
  if (realDir !== realBase && !inside(realBase, realDir)) return `the real directory ${realDir} is outside ${realBase}`;
  let st; try { st = io.lstatSync(target); } catch (e) { return e.code === 'ENOENT' ? null : `${target} cannot be inspected (${e.code || 'error'})`; }
  if (st.isSymbolicLink()) return `${target} is a link (edit its target by hand)`;
  if (st.nlink > 1) return `${target} has ${st.nlink} hard links (a write would change a file that also lives elsewhere)`;
  let realFile; try { realFile = real(target); } catch (e) { return `${target} does not resolve (${e.code || 'error'})`; }
  return inside(realBase, realFile) ? null : `the real path ${realFile} is outside ${realBase}`;
}

// ---------- doctor ----------
function probeHttp(url, timeoutMs = 3000) {
  return new Promise(resolve => {
    let done = false; const finish = v => { if (!done) { done = true; resolve(v); } };
    try {
      const req = require('node:http').request(url, { method: 'GET', timeout: timeoutMs }, res => { res.resume(); finish({ reachable: true, detail: `HTTP ${res.statusCode}` }); });
      req.on('timeout', () => { req.destroy(); finish({ reachable: false, detail: 'timeout' }); });
      req.on('error', e => finish({ reachable: false, detail: String((e && e.code) || 'error') }));
      req.end();
    } catch (e) { finish({ reachable: false, detail: String((e && e.code) || 'error') }); }
  });
}
async function doctor(opts = {}) {
  const io = opts.io || fs;
  const want = expectedServers(opts);
  const reach = {};
  for (const s of want.list) {
    if (s.transport === 'http') reach[s.name] = opts.noProbe ? { reachable: null, detail: 'not probed' } : await (opts.probe || probeHttp)(s.url);
    else reach[s.name] = { reachable: io.existsSync(s.args[0]) && io.existsSync(s.command), detail: 'bin.js and node present (not spawned)' };
  }
  for (const name of SERVERS) if (!reach[name]) reach[name] = { reachable: false, detail: 'not resolved on this machine' };
  // a stdio entry with an absolute command is reachable only if that configured command exists too (not only the node of this tool)
  const reachOf = (name, w, entry) => {
    const k = w && w.transport === 'stdio' ? entryKind(entry) : null;
    if (!k || k.kind !== 'stdio' || typeof k.command !== 'string' || !path.isAbsolute(k.command)) return reach[name];
    const present = io.existsSync(k.command);
    return { reachable: reach[name].reachable && present, detail: present ? reach[name].detail : 'the configured command does not exist' };
  };
  const rows = [];
  for (const [client, spec] of Object.entries(CLIENTS)) {
    const file = path.join(home(opts), spec.file);
    const row = { client, file, servers: {} };
    let text = null;
    try { text = io.readFileSync(file, 'utf8'); } catch (e) { row.state = e.code === 'ENOENT' ? 'no-config' : 'unreadable'; }
    let value = null;
    if (text !== null) { try { value = parseConfig(text, spec.format).value; row.state = 'parsed'; } catch (e) { row.state = 'parse-error'; row.error = e.message; } }
    for (const name of SERVERS) {
      const w = want.list.find(s => s.name === name);
      const entry = value ? entryOf(client, value, name) : undefined;
      const reg = value ? (w ? registration(entry, w) : (entry === undefined ? 'missing' : 'present')) : 'unknown';
      const r = reachOf(name, w, entry);
      row.servers[name] = { registered: reg, reachable: r.reachable, detail: r.detail };
    }
    rows.push(row);
  }
  // OK only when every entry is registered and no server was found unreachable (not probed, --no-probe, is not a finding)
  const ok = rows.every(r => SERVERS.every(n => r.servers[n].registered === 'ok' && r.servers[n].reachable !== false));
  return { ok, notes: want.notes, rows };
}
function doctorText(result) {
  const lines = ['mcp-wiring doctor (advisory; never Evidence)'];
  for (const r of result.rows) {
    lines.push(`${r.client.padEnd(6)} ${r.state.padEnd(11)} ${SERVERS.map(n => `${n}=${r.servers[n].registered}/${r.servers[n].reachable === null ? 'unprobed' : r.servers[n].reachable ? 'reachable' : 'unreachable'}`).join(' ')}${r.error ? ` (${r.error})` : ''}`);
  }
  for (const n of result.notes) lines.push(`note: ${n}`);
  lines.push(`DOCTOR ${result.ok ? 'OK' : 'FINDINGS'}`);
  return lines.join('\n');
}

// ---------- apply ----------
const nl = text => (text.includes('\r\n') ? '\r\n' : '\n');
const tomlLiteral = s => { if (/['\r\n]/.test(s)) throw new ParseError(`a path holding a quote or a newline cannot be a TOML literal string: ${JSON.stringify(s)}`); return `'${s}'`; };
function tomlBlock(client, s, eolText) {
  const lines = client === 'vibe' ? ['[[mcp_servers]]', `name = ${tomlLiteral(s.name)}`] : [`[mcp_servers.${s.name}]`];
  if (s.transport === 'http') { if (client === 'vibe') lines.push("transport = 'streamable-http'"); lines.push(`url = ${tomlLiteral(s.url)}`); }
  else { if (client === 'vibe') lines.push("transport = 'stdio'"); lines.push(`command = ${tomlLiteral(s.command)}`, `args = [${s.args.map(tomlLiteral).join(', ')}]`); }
  return lines.join(eolText);
}
// One planned edit: { client, file, action: 'none'|'insert'|'command'|'refuse', reason, text, offset, missing }
function planClient(client, opts, want) {
  const spec = CLIENTS[client];
  const io = opts.io || fs;
  const file = path.join(home(opts), spec.file);
  let text;
  try { text = io.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { client, file, action: 'skip', reason: 'no config file (the client is not installed here or never ran)' } : { client, file, action: 'refuse', reason: `unreadable (${e.code})` }; }
  if (spec.applyBy !== 'command') { const outside = writeTargetProblem(home(opts), file, io); if (outside) return { client, file, action: 'refuse', reason: `outside the home: ${outside}` }; }
  let parsed;
  try { parsed = parseConfig(text, spec.format); } catch (e) { return { client, file, action: 'refuse', reason: `parse error: ${e.message}` }; }
  const states = want.list.map(s => ({ s, reg: registration(entryOf(client, parsed.value, s.name), s) }));
  const differ = states.filter(x => x.reg === 'differs' || x.reg === 'disabled').map(x => `${x.s.name} ${x.reg}`);
  const missing = states.filter(x => x.reg === 'missing').map(x => x.s);
  if (!missing.length) return { client, file, action: 'none', reason: differ.length ? `present but not as expected (left as it is): ${differ.join(', ')}` : 'registered', missing: [] };
  if (spec.applyBy === 'command') {
    const cmds = missing.map(s => s.transport === 'http' ? `claude mcp add --scope user --transport http ${s.name} ${s.url}` : `claude mcp add-json --scope user ${s.name} ${JSON.stringify(JSON.stringify(spec.stdio(s.command, s.args)))}`);
    return { client, file, action: 'command', reason: spec.note, text: cmds.join('\n'), missing };
  }
  const e = nl(text);
  let insert; let offset;
  try {
    if (spec.format === 'toml-table' || spec.format === 'toml-array') {
      offset = text.length;
      insert = `${text.length && !text.endsWith('\n') ? e : ''}${text.length ? e : ''}# mcp-wiring: kernel MCP servers${e}${missing.map(s => tomlBlock(client, s, e)).join(e + e)}${e}`;
    } else {
      const entries = missing.map(s => [s.name, s.transport === 'http' ? spec.http(s.url) : spec.stdio(s.command, s.args)]);
      const member = spec.container ? parsed.scan.members.find(m => m.key === spec.container) : null;
      if (member && text[member.valueStart] !== '{') return { client, file, action: 'refuse', reason: `${spec.container} is not an object` };
      const open = member ? member.valueStart : parsed.scan.rootOpen;
      const after = text.slice(open + 1);
      const indentMatch = /^\r?\n([ \t]*)/.exec(after);
      const lead = indentMatch ? `${e}${indentMatch[1]}` : '';
      const hasMember = member ? /^\s*(\/\/[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*[^\s}]/.test(after) : parsed.scan.rootHasMember;
      const body = member ? entries.map(([k, v]) => `${lead}${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(',')
        : `${lead}${JSON.stringify(spec.container)}: {${entries.map(([k, v]) => `${JSON.stringify(k)}: ${JSON.stringify(v)}`).join(', ')}}`;
      offset = open + 1;
      insert = `${body}${hasMember ? ',' : ''}`;
    }
  } catch (err) { return { client, file, action: 'refuse', reason: err.message }; }
  const out = text.slice(0, offset) + insert + text.slice(offset);
  // the result must parse, keep every value it had and gain exactly the missing entries; else nothing is written
  let after;
  try { after = parseConfig(out, spec.format).value; } catch (err) { return { client, file, action: 'refuse', reason: `the edited file would not parse (${err.message})` }; }
  const before = parsed.value;
  const expectedValue = JSON.parse(JSON.stringify(before));
  for (const s of missing) {
    const v = spec.format === 'toml-table' ? (s.transport === 'http' ? { url: s.url } : { command: s.command, args: s.args })
      : spec.format === 'toml-array' ? (s.transport === 'http' ? { name: s.name, transport: 'streamable-http', url: s.url } : { name: s.name, transport: 'stdio', command: s.command, args: s.args })
        : (s.transport === 'http' ? spec.http(s.url) : spec.stdio(s.command, s.args));
    if (spec.format === 'toml-array') (expectedValue.mcp_servers = expectedValue.mcp_servers || []).push(v);
    else { const key = spec.format === 'toml-table' ? 'mcp_servers' : spec.container; (expectedValue[key] = expectedValue[key] || {})[s.name] = v; }
  }
  if (canonical(after) !== canonical(expectedValue)) return { client, file, action: 'refuse', reason: 'the edited file would change more than the missing entries' };
  if (out.slice(0, offset) !== text.slice(0, offset) || out.slice(offset + insert.length) !== text.slice(offset)) return { client, file, action: 'refuse', reason: 'the edit is not byte-preserving' };
  return { client, file, action: 'insert', reason: `adds ${missing.map(s => s.name).join(', ')}`, text: insert, offset, out, original: text, missing };
}
function canonical(v) {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') return `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
  return JSON.stringify(v);
}
function apply(opts = {}) {
  const io = opts.io || fs;
  const want = expectedServers(opts);
  const clients = opts.clients && opts.clients.length ? opts.clients : Object.keys(CLIENTS);
  const unknown = clients.filter(c => !Object.hasOwn(CLIENTS, c));
  if (unknown.length) return { code: 2, lines: [`unknown client: ${unknown.join(', ')} (known: ${Object.keys(CLIENTS).join(', ')})`] };
  const lines = []; let refused = 0;
  const stamp = (opts.now || (() => new Date()))().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  for (const client of clients) {
    const p = planClient(client, opts, want);
    lines.push(`${client}: ${p.action} - ${p.reason}`);
    if (p.action === 'refuse') { refused++; continue; }
    if (p.action === 'command') { lines.push(...p.text.split('\n').map(l => `  run: ${l}`)); continue; }
    if (p.action !== 'insert') continue;
    lines.push(...p.text.split(/\r?\n/).filter(Boolean).map(l => `  + ${l}`));
    if (!opts.apply) continue;
    const backup = `${p.file}.mcp-wiring-${stamp}.bak`;
    const tmp = `${p.file}.mcp-wiring-${stamp}.tmp`;
    let staged = false;
    const changed = () => Object.assign(new Error('changed'), { code: 'CHANGED_SINCE_READ' });
    try {
      io.copyFileSync(p.file, backup, fs.constants.COPYFILE_EXCL);
      // the file must still be what was planned against; else nothing is written
      if (io.readFileSync(p.file, 'utf8') !== p.original) throw changed();
      io.writeFileSync(tmp, p.out, { encoding: 'utf8', flag: 'wx' });
      staged = true;
      // and again right before the rename: a writer that came in while the new text was staged keeps its change (no lock exists across
      // processes, so a write between this read and the rename is still possible; the window is two system calls)
      if (io.readFileSync(p.file, 'utf8') !== p.original) throw changed();
      io.renameSync(tmp, p.file);
      lines.push(`  written; backup ${backup}`);
    } catch (e) {
      refused++;
      lines.push(`  NOT written (${String((e && e.code) || 'error').replace(/[^A-Za-z0-9_]/g, '')})${staged ? `; the planned text stays in ${tmp}` : ''}`);
    }
  }
  for (const n of want.notes) lines.push(`note: ${n}`);
  lines.push(opts.apply ? `APPLY ${refused ? 'REFUSED' : 'DONE'}` : 'DRY RUN: nothing written (add --apply)');
  return { code: refused ? 1 : 0, lines };
}

// ---------- host defaults ----------
const CBMIGNORE = Object.freeze([
  '# codebase-memory ignore rules (mcp-wiring default): keep the code graph to the live project.',
  'docs/ops/journals-archive/',
  '**/archive/',
  '.ai/runtime/',
  '**/node_modules/',
  '**/.unison*',
  '**/~syncthing~*',
  '**/.stversions/',
]);
// Markdown that the qmd plan leaves out: session journals and archives (history, searched by other means)
const QMD_EXCLUDE = [/^\.ai\/worklog\//, /(^|\/)journals-archive\//, /(^|\/)archive\//, /^\.ai\/runtime\//, /(^|\/)node_modules\//];
const HOOK_MARK = '# mcp-wiring post-merge reindex';
function hostHook() {
  return ['#!/bin/sh', `${HOOK_MARK} (opt-in: node .ai/bin/mcp-wiring.cjs host apply --apply --reindex-hook). Advisory: a failure never blocks the merge.`,
    '# Runs detached; one run at a time (mkdir lock in the git directory).',
    'top=$(git rev-parse --show-toplevel 2>/dev/null) || exit 0',
    'lock="$(git rev-parse --git-common-dir)/mcp-reindex.lock"',
    'mkdir "$lock" 2>/dev/null || exit 0',
    '(',
    '  command -v qmd >/dev/null 2>&1 && { qmd update; qmd embed; }',
    "  command -v codebase-memory-mcp >/dev/null 2>&1 && codebase-memory-mcp cli --quiet index_repository \"{\\\"repo_path\\\":\\\"$top\\\",\\\"mode\\\":\\\"fast\\\"}\"",
    '  rmdir "$lock"',
    ') >/dev/null 2>&1 &',
    'exit 0', ''].join('\n');
}
function gitOut(root, args) {
  const r = require('node:child_process').spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}
// The anchored exclusions name directories that may hold untracked Markdown (the runtime, new journals): a directory above one is never globbed whole.
const QMD_EXCLUDED_DIRS = ['.ai/worklog', '.ai/runtime'];
// qmd has a mask and no exclusion, so a directory that holds an excluded path is never given "**/*.md": it gets "*.md" for its own files and
// each of its subdirectories is planned the same way; an excluded subdirectory gets no collection. The root is always split this way.
function qmdPlan(root, files) {
  const name = path.basename(path.resolve(root)).toLowerCase().replace(/[^a-z0-9-]/g, '-') || 'host';
  const excluded = f => QMD_EXCLUDE.some(rx => rx.test(f));
  const under = (dir, f) => dir === '.' || f.startsWith(`${dir}/`);
  const plan = [];
  const add = (dir, mask, count) => {
    const id = dir === '.' ? 'root' : dir.replace(/^\./, '').replace(/[^A-Za-z0-9-]/g, '-').toLowerCase();
    plan.push({ collection: `${name}-${id}`, dir, count, mask, command: `qmd collection add ${JSON.stringify(path.resolve(root, dir).replace(/\\/g, '/'))} --name ${name}-${id} --mask "${mask}"` });
  };
  const walk = (dir, list) => {
    const md = list.filter(f => f.endsWith('.md') && !excluded(f));
    if (!md.length) return;
    const clean = dir !== '.' && !list.some(excluded) && !QMD_EXCLUDED_DIRS.some(d => under(dir, d));
    if (clean) { add(dir, '**/*.md', md.length); return; }
    const own = md.filter(f => path.posix.dirname(f) === dir);
    if (own.length) add(dir, '*.md', own.length);
    const subs = new Map();
    for (const f of list) {
      const rest = dir === '.' ? f : f.slice(dir.length + 1);
      if (!rest.includes('/')) continue;
      const sub = dir === '.' ? rest.split('/')[0] : `${dir}/${rest.split('/')[0]}`;
      if (!subs.has(sub)) subs.set(sub, []);
      subs.get(sub).push(f);
    }
    for (const sub of [...subs.keys()].sort()) if (!excluded(`${sub}/x.md`)) walk(sub, subs.get(sub));
  };
  walk('.', files.filter(f => typeof f === 'string' && f && !f.startsWith('/')));
  return plan.sort((a, b) => a.dir.localeCompare(b.dir));
}
function hostState(root, io = fs, files) {
  const cbmFile = path.join(root, '.cbmignore');
  let cbmText = null; try { cbmText = io.readFileSync(cbmFile, 'utf8'); } catch { /* absent */ }
  const have = new Set((cbmText || '').split(/\r?\n/).map(l => l.trim()));
  const missing = CBMIGNORE.filter(l => !l.startsWith('#') && !have.has(l));
  const gitDir = gitOut(root, ['rev-parse', '--git-common-dir']);
  const hookFile = gitDir ? path.resolve(root, gitDir.trim(), 'hooks', 'post-merge') : null;
  let hook = 'no-git';
  if (hookFile) { try { hook = io.readFileSync(hookFile, 'utf8').includes(HOOK_MARK) ? 'kernel' : 'foreign'; } catch { hook = 'absent'; } }
  const tracked = files || (gitOut(root, ['ls-files', '-z']) || '').split('\0').filter(Boolean);
  return { cbmFile, cbmText, missing, hookFile, hook, qmd: qmdPlan(root, tracked) };
}
function hostPlanText(st) {
  const out = ['mcp-wiring host plan (advisory)', `.cbmignore: ${st.cbmText === null ? 'absent' : 'present'}; missing default patterns: ${st.missing.length ? st.missing.join(' ') : 'none'}`,
    `post-merge reindex hook: ${st.hook} (opt-in: host apply --apply --reindex-hook)`, 'qmd collection plan (run by hand; qmd keeps one index per user):'];
  for (const q of st.qmd) out.push(`  ${q.command}    # ${q.count} Markdown files`);
  if (!st.qmd.length) out.push('  none: no tracked Markdown outside journals and archives');
  return out.join('\n');
}
function hostApply(opts = {}) {
  const io = opts.io || fs; const root = path.resolve(opts.root || '.');
  const st = hostState(root, io, opts.files);
  const lines = [hostPlanText(st)]; let refused = 0;
  if (st.missing.length) {
    const e = st.cbmText ? nl(st.cbmText) : '\n';
    const add = st.cbmText === null ? `${CBMIGNORE.join('\n')}\n` : `${st.cbmText.length && !st.cbmText.endsWith('\n') ? e : ''}${st.missing.join(e)}${e}`;
    lines.push(`.cbmignore: ${st.cbmText === null ? 'create' : 'append'} ${st.missing.length} pattern(s)`);
    const outside = writeTargetProblem(root, st.cbmFile, io);
    if (outside) { refused++; lines.push(`  refused, outside the root: ${outside}`); }
    else if (opts.apply) { try { if (st.cbmText === null) io.writeFileSync(st.cbmFile, add, { encoding: 'utf8', flag: 'wx' }); else io.appendFileSync(st.cbmFile, add, 'utf8'); lines.push('  written'); } catch (e) { refused++; lines.push(`  NOT written (${String(e.code || 'error').replace(/[^A-Za-z0-9_]/g, '')})`); } }
  }
  if (opts.reindexHook) {
    if (st.hook === 'no-git') { refused++; lines.push('reindex hook: refused, not a git checkout'); }
    else if (st.hook === 'foreign') { refused++; lines.push(`reindex hook: refused, ${st.hookFile} exists and is not the kernel hook (merge it by hand)`); }
    else if (st.hook === 'kernel') lines.push('reindex hook: already installed');
    else {
      lines.push(`reindex hook: install ${st.hookFile}`);
      if (opts.apply) { try { io.mkdirSync(path.dirname(st.hookFile), { recursive: true }); io.writeFileSync(st.hookFile, hostHook(), { encoding: 'utf8', flag: 'wx', mode: 0o755 }); lines.push('  written'); } catch (e) { refused++; lines.push(`  NOT written (${String(e.code || 'error').replace(/[^A-Za-z0-9_]/g, '')})`); } }
    }
  }
  lines.push(opts.apply ? `HOST APPLY ${refused ? 'REFUSED' : 'DONE'}` : 'DRY RUN: nothing written (add --apply)');
  return { code: refused ? 1 : 0, lines };
}

// ---------- metric ----------
// MCP server of a tool name: claude mcp__qmd__query, vibe and opencode qmd_query, codex qmd.query; anything else is not one of the two
function serverOf(name) {
  const m = /^mcp__(qmd|codebase-memory)__/.exec(name) || /^(qmd|codebase-memory)[_.][A-Za-z]/.exec(name);
  return m ? m[1] : null;
}
// Structured tool events of one call file: one per tool call id (a status update of the same call is not a second call). Plain text that only
// mentions a server (the prompt names qmd) is never counted, and neither is an example inside a Markdown code fence (a quoted prompt or report).
function toolEvents(text) {
  const events = new Map(); let anon = 0; let fence = null;
  const add = (id, name) => { if (typeof name !== 'string' || !name) return; events.set(id ? `id:${id}` : `n:${anon++}`, name); };
  for (const raw of String(text).split(/\r?\n/)) {
    const l = raw.trim();
    const mark = /^(`{3,}|~{3,})/.exec(l);
    if (mark) { if (fence === null) fence = mark[1][0]; else if (mark[1][0] === fence) fence = null; continue; }
    if (fence !== null) continue;
    const codexText = /^tool ([A-Za-z0-9_-]+)\.([A-Za-z0-9_]+)\(/.exec(l);
    if (codexText) { add(null, `${codexText[1]}.${codexText[2]}`); continue; }
    if (l[0] !== '{') continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (!j || typeof j !== 'object') continue;
    if (j.type === 'effect' && j.detail && typeof j.detail.toolName === 'string') add(j.id, j.detail.toolName);
    else if (j.type === 'tool_use' && j.part && j.part.type === 'tool') add(j.part.callID || j.part.id, j.part.tool);
    else if (j.role === 'assistant' && Array.isArray(j.tool_calls)) for (const tc of j.tool_calls) add(tc && tc.id, tc && tc.function && tc.function.name);
    else if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) for (const c of j.message.content) { if (c && c.type === 'tool_use') add(c.id, c.name); }
    else if (j.item && typeof j.item === 'object' && typeof j.item.type === 'string' && /^item\./.test(String(j.type))) {
      if (j.item.type === 'mcp_tool_call') add(j.item.id, `${j.item.server}.${j.item.tool}`);
      else if (/^(command_execution|file_change|web_search)$/.test(j.item.type)) add(j.item.id, j.item.type);
    }
  }
  return [...events.values()];
}
function launchRecords(files, io) {
  const byName = new Map();
  for (const f of files) {
    let text; try { text = io.readFileSync(f, 'utf8'); } catch { continue; }
    for (const l of text.split(/\r?\n/)) {
      if (!l.trim()) continue;
      let j; try { j = JSON.parse(l); } catch { continue; }
      const m = typeof j.launchId === 'string' && /^L-\d{8}T\d{6}Z-(.+)$/.exec(j.launchId);
      if (m) byName.set(m[1], j);
    }
  }
  return byName;
}
function defaultLaunchFiles(io) {
  try {
    const rp = require('./repo-paths.cjs');
    const dirs = [rp.launchesDir(), rp.pendingDir()];
    return dirs.flatMap(d => { try { return io.readdirSync(d).filter(n => /^LAUNCHES.*\.jsonl$|^launches-\d{8}\.jsonl$/.test(n)).map(n => path.join(d, n)); } catch { return []; } });
  } catch { return []; }
}
function metric(opts = {}) {
  const io = opts.io || fs;
  const runtime = opts.runtime || (() => { try { return require('./repo-paths.cjs').runtimeDir(); } catch { return path.resolve('.ai/runtime'); } })();
  if (opts.since && !realDate(opts.since)) throw new Error(`since: ${JSON.stringify(String(opts.since).slice(0, 20))} is not a date that exists (YYYY-MM-DD)`);
  const since = opts.since ? Date.parse(`${opts.since}T00:00:00Z`) : null;
  const records = launchRecords(opts.launches && opts.launches.length ? opts.launches : defaultLaunchFiles(io), io);
  let names = [];
  try { names = io.readdirSync(runtime).filter(n => n.endsWith('-call.txt')); } catch { /* no runtime */ }
  const seats = [];
  for (const n of names.sort()) {
    const file = path.join(runtime, n);
    let st; try { st = io.statSync(file); } catch { continue; }
    if (since !== null && st.mtimeMs < since) continue;
    const name = n.slice(0, -'-call.txt'.length);
    let text = ''; try { text = io.readFileSync(file, 'utf8'); } catch { continue; }
    const events = toolEvents(text);
    const calls = { qmd: 0, 'codebase-memory': 0 };
    for (const e of events) { const s = serverOf(e); if (s) calls[s]++; }
    let offered = 'unknown';
    try { const m = /^SEAT_MCP mode=(kernel|none|user) servers=(\S+)/.exec(io.readFileSync(path.join(runtime, `${name}-seat-mcp.txt`), 'utf8')); if (m) offered = m[1] === 'kernel' ? m[2] : m[1]; } catch { /* a launch before MCP-WIRING */ }
    const rec = records.get(name);
    const tokens = rec && rec.tokens && Number.isFinite(rec.tokens.total) ? rec.tokens.total : null;
    // no structured tool event at all: the client's output format is not one this reader knows, so the counts are unknown, never zero
    seats.push({ name, client: rec && rec.tuple ? rec.tuple.client : null, role: rec ? rec.role || rec.launchRole || null : null, offered, toolEvents: events.length,
      qmd: events.length ? calls.qmd : null, cbm: events.length ? calls['codebase-memory'] : null, tokens });
  }
  const known = seats.filter(s => s.toolEvents > 0);
  // the call counts are sums over the readable seats only (countsOver); with no readable seat they are unknown, never zero
  const overKnown = f => (known.length ? f() : null);
  const summary = { seats: seats.length, readable: known.length, unknownFormat: seats.length - known.length, countsOver: 'readable seats',
    qmdSeats: overKnown(() => known.filter(s => s.qmd > 0).length), cbmSeats: overKnown(() => known.filter(s => s.cbm > 0).length),
    qmdCalls: overKnown(() => known.reduce((a, s) => a + s.qmd, 0)), cbmCalls: overKnown(() => known.reduce((a, s) => a + s.cbm, 0)), offeredSeats: seats.filter(s => !['unknown', 'none', 'user'].includes(s.offered)).length,
    tokensKnown: seats.filter(s => s.tokens !== null).length, tokens: seats.reduce((a, s) => a + (s.tokens || 0), 0), baseline: BASELINE };
  return { runtime, seats, summary };
}
function metricText(r) {
  const s = r.summary;
  const lines = ['mcp-wiring metric (advisory; never Evidence)', 'seat\tclient\toffered\ttool-events\tqmd\tcodebase-memory\ttokens'];
  for (const x of r.seats) lines.push([x.name, x.client || '-', x.offered, x.toolEvents, x.qmd === null ? 'unknown' : x.qmd, x.cbm === null ? 'unknown' : x.cbm, x.tokens === null ? 'unknown' : x.tokens].join('\t'));
  const u = v => (v === null ? 'unknown' : v);
  lines.push(`METRIC seats=${s.seats} readable=${s.readable} unknown-format=${s.unknownFormat} offered=${s.offeredSeats} qmd-seats=${u(s.qmdSeats)} qmd-calls=${u(s.qmdCalls)} cbm-seats=${u(s.cbmSeats)} cbm-calls=${u(s.cbmCalls)} tokens=${s.tokens} tokens-known=${s.tokensKnown}`);
  lines.push(`the qmd and cbm counts are over the ${s.readable} readable seat(s); ${s.unknownFormat} seat(s) of an unknown output format are not in them`);
  lines.push(`BASELINE ${s.baseline.date} seats=${s.baseline.seats} qmd-seats=${s.baseline.qmdSeats} cbm-seats=${s.baseline.cbmSeats}`);
  return lines.join('\n');
}

// ---------- CLI ----------
// YYYY-MM-DD of a day that exists (Date.parse would roll 2026-02-31 over to March)
function realDate(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}
function args(argv) {
  const o = { clients: [], launches: [] };
  const take = (i, name) => { if (i + 1 >= argv.length) throw new Error(`${name} needs a value`); return argv[i + 1]; };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--home') o.home = take(i++, a); else if (a === '--root') o.root = take(i++, a); else if (a === '--runtime') o.runtime = take(i++, a);
    else if (a === '--client') o.clients.push(take(i++, a)); else if (a === '--launches') o.launches.push(take(i++, a));
    else if (a === '--since') { o.since = take(i++, a); if (!realDate(o.since)) throw new Error('--since takes YYYY-MM-DD, a date that exists'); }
    else if (a === '--apply') o.apply = true; else if (a === '--json') o.json = true; else if (a === '--no-probe') o.noProbe = true; else if (a === '--reindex-hook') o.reindexHook = true;
    else if (a.startsWith('--')) throw new Error(`unknown option ${a}`);
    else rest.push(a);
  }
  return { o, rest };
}
async function main(argv, out = line => console.log(line)) {
  let parsed; try { parsed = args(argv); } catch (e) { out(`usage: ${e.message}`); return 2; }
  const { o, rest } = parsed;
  const [cmd, sub] = rest;
  if (cmd === 'clients') { const rows = Object.entries(CLIENTS).map(([c, s]) => ({ client: c, file: `~/${s.file}`, format: s.format, container: s.container || 'mcp_servers', applyBy: s.applyBy || 'edit', verify: s.verify, note: s.note || '' })); out(o.json ? JSON.stringify(rows, null, 2) : rows.map(r => `${r.client}\t${r.file}\t${r.format}\t${r.container}\tapply=${r.applyBy}\tverify: ${r.verify}`).join('\n')); return 0; }
  if (cmd === 'doctor') { const r = await doctor(o); out(o.json ? JSON.stringify(r, null, 2) : doctorText(r)); return r.ok ? 0 : 1; }
  if (cmd === 'apply') { const r = apply(o); for (const l of r.lines) out(l); return r.code; }
  if (cmd === 'host' && sub === 'plan') { const st = hostState(path.resolve(o.root || '.')); out(o.json ? JSON.stringify(st, null, 2) : hostPlanText(st)); return 0; }
  if (cmd === 'host' && sub === 'apply') { const r = hostApply(o); for (const l of r.lines) out(l); return r.code; }
  if (cmd === 'metric') { const r = metric(o); out(o.json ? JSON.stringify(r, null, 2) : metricText(r)); return 0; }
  out('usage: mcp-wiring.cjs clients|doctor|apply|host plan|host apply|metric (see the header of this file)');
  return 2;
}

module.exports = { CLIENTS, CBMIGNORE, BASELINE, HOOK_MARK, ParseError, parseToml, scanJson, parseConfig, expectedServers, entryOf, registration, doctor, doctorText, planClient, apply, hostState, hostApply, hostHook, qmdPlan, serverOf, toolEvents, metric, metricText, main };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(`mcp-wiring: ${error && error.message}`); process.exitCode = 1; });

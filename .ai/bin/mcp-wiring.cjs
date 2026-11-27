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
//   node .ai/bin/mcp-wiring.cjs metric [--json]                                the MCP call metric is not available in this release: the command prints one
//                                                                              line that says so, reads nothing, prints no count and exits 0 (the options of
//                                                                              the counting code are still accepted, so a script that passes them does not
//                                                                              fail); the counting code below is kept for a later release and is reached
//                                                                              only by its development tests, never by this command
// Nothing here installs or downloads an MCP server (PROTOCOL.md MCP policy item 3). The doctor's probe is one MCP tools/list per distinct entry the
// clients configure: an HTTP request for a local URL, and for codebase-memory a short stdio run of the configured node and bin.js (only an entry
// that is the kernel's bin.js run by node is ever started); --no-probe starts nothing.
// Exit codes: 0 done (doctor: every client registered, no server found unreachable), 1 a finding (doctor: something missing, apply: a refusal), 2 usage.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const seatMcp = require('./lib/seat-mcp.cjs');
const semgrep = require('./lib/semgrep-mcp.cjs');
const realPath = require('./lib/real-path.cjs');

const SERVERS = seatMcp.SERVER_NAMES;
// The baseline the 2.0.1 release compares against (the seat call files of the 7 days before it: no call of qmd or codebase-memory was observed in
// them; like every count of the metric, a seat count no source showed is null, never a zero).
const BASELINE = Object.freeze({ date: '2026-10-28', seats: 308, qmdSeats: null, cbmSeats: null });

// ---------- client registry (measured on the clients from hand-made working entries) ----------
const jsonHttp = { claude: url => ({ type: 'http', url }), kimi: url => ({ url, transport: 'http' }), opencode: url => ({ type: 'remote', url, enabled: true }), cline: url => ({ type: 'streamableHttp', url, disabled: false }) };
const jsonStdio = { claude: (command, args, env = {}) => ({ type: 'stdio', command, args, env }), plain: (command, args, env) => ({ command, args, ...(env ? { env } : {}) }), opencode: (command, args, env) => ({ type: 'local', command: [command, ...args], enabled: true, ...(env ? { environment: env } : {}) }),
  cline: (command, args, env) => ({ type: 'stdio', command, args, disabled: false, ...(env ? { env } : {}) }) };
const CLIENTS = Object.freeze({
  claude: { file: '.claude.json', format: 'json', container: 'mcpServers', http: jsonHttp.claude, stdio: jsonStdio.claude, applyBy: 'command',
    verify: 'claude mcp list', note: 'the running client rewrites ~/.claude.json, so apply prints the claude mcp add commands instead of editing the file' },
  codex: { file: '.codex/config.toml', format: 'toml-table', verify: 'codex mcp list --json', note: 'table [mcp_servers.NAME]: url for http, command and args for stdio' },
  vibe: { file: '.vibe/config.toml', format: 'toml-array', verify: 'mcp-wiring doctor (vibe 2.26.1 has mcp add and remove, no list): a tools/list through the configured entry',
    note: 'array [[mcp_servers]] with name, transport streamable-http (http is the same client) or stdio; a stdio command is a one-element list (a string is cut by shlex.split); a tool is routed as mcp_NAME.TOOL and --enabled-tools matches NAME_TOOL with every character outside [A-Za-z0-9_$] made _' },
  kilo: { file: '.config/kilo/kilo.jsonc', format: 'jsonc', container: 'mcp', http: jsonHttp.opencode, stdio: jsonStdio.opencode, verify: 'kilo mcp list' },
  mimo: { file: '.config/mimocode/mimocode.jsonc', format: 'jsonc', container: 'mcp', http: jsonHttp.opencode, stdio: jsonStdio.opencode, verify: 'mimo mcp list' },
  kimi: { file: '.kimi-code/mcp.json', format: 'json', container: 'mcpServers', http: jsonHttp.kimi, stdio: jsonStdio.plain, verify: 'unknown: kimi is not on PATH here (the launcher resolves it to an absolute path)' },
  // cline 3.x (measured): its own settings file, type streamableHttp or stdio, tools named mcp__SERVER__TOOL; the file holds the owner's settings:
  // the doctor only reads it and apply prints the entries to add, it never writes there; a value of the file is never printed
  cline: { file: '.cline/data/settings/cline_mcp_settings.json', format: 'json', container: 'mcpServers', http: jsonHttp.cline, stdio: jsonStdio.cline, applyBy: 'owner',
    verify: 'mcp-wiring doctor: a tools/list through the configured entry', note: 'owner settings: apply prints the entries, the owner adds them' },
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
  // opencode keeps the whole argv in command; vibe may give a one-element command list and the arguments in args
  if (Array.isArray(entry.command)) return { kind: 'stdio', command: entry.command[0], args: [...entry.command.slice(1), ...(Array.isArray(entry.args) ? entry.args : [])] };
  if (typeof entry.command === 'string') return { kind: 'stdio', command: entry.command, args: Array.isArray(entry.args) ? entry.args : [] };
  return { kind: 'other' };
}
// vibe 2.26.1 cuts a string command with shlex.split (core/config/models.py MCPStdio.argv): a blank, a quote or a backslash breaks it apart
// (C:\Program Files\nodejs\node.exe becomes C:Program and Filesnodejsnode.exe), so such an entry never starts; a one-element list is kept whole
function vibeCommandProblem(client, entry) {
  return client === 'vibe' && entry && typeof entry.command === 'string' && /[\s'"\\]/.test(entry.command) ? 'vibe cuts this string command with shlex.split (write it as a one-element list)' : null;
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
  if (want.name === 'semgrep') return samePath(k.command, want.command) && JSON.stringify(k.args) === JSON.stringify(want.args) &&
    Object.entries(want.env || {}).every(([key, value]) => (entry.env || entry.environment || {})[key] === value) &&
    Object.keys(entry.env || entry.environment || {}).every(key => Object.hasOwn(want.env || {}, key)) ? 'ok' : 'differs';
  // the stdio server is the same bin.js run by node; a right bin.js behind a command that is not node is not a working entry
  return nodeCommand(k.command, want) && k.args.some(a => samePath(a, want.args[0])) ? 'ok' : 'differs';
}

function home(opts) { return opts.home || os.homedir(); }

// Why a write to target would leave base, or null. The real path of the target's directory and of the target itself must stay inside the real
// path of base (a junction or a symlink never carries a write out of --home or --root); an existing target that is a link or has a second hard
// link is refused, since a replace would cut the link and an append would change a file that also lives elsewhere.
function writeTargetProblem(base, target, io = fs) {
  // Where each path leads, links followed as the native real path does, also on a volume without a Mount Manager name.
  const real = p => realPath.forFs(io.realpathSync ? io : fs).followedPathSync(p);
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
// a parse message may quote the file (V8 shows the text near the error, ..."API_KEY": sk-..."), and that text may hold a key: only the words before
// the first quote and the position are printed
const quietParseMessage = message => {
  const text = String(message); const head = text.split(/["'`]/)[0].trim();
  const where = /position \d+(?: \(line \d+ column \d+\))?/.exec(text);
  return where && !head.includes(where[0]) ? `${head} (${where[0]})` : head;
};
// The probe is one MCP tools/list through an entry (the daemon alone answering proves nothing about a client): streamable HTTP
// (the transport every client uses for qmd) to a local URL, and a short stdio run of node and the kernel's bin.js for codebase-memory. It resolves
// { reachable, detail, tools } with tools [{ name, readOnly }] (readOnly is the server's own readOnlyHint) when the list came back.
const RPC_INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-wiring-doctor', version: '1' } } };
const RPC_READY = { jsonrpc: '2.0', method: 'notifications/initialized' };
const RPC_LIST = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
const toolsOf = msg => (msg && msg.result && Array.isArray(msg.result.tools) ? msg.result.tools.map(t => ({ name: String(t && t.name), readOnly: Boolean(t && t.annotations && t.annotations.readOnlyHint === true) })) : null);
// the JSON-RPC answer with this id in an HTTP body: plain JSON or the data lines of an event stream
function rpcOf(body, id) {
  const texts = /^\s*\{/.test(body) ? [body] : String(body).split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trim());
  for (const t of texts) { try { const j = JSON.parse(t); if (j && j.id === id) return j; } catch { /* another line */ } }
  return null;
}
function httpRpc(url, method, message, session, timeoutMs) {
  return new Promise(resolve => {
    let done = false; const finish = v => { if (!done) { done = true; resolve(v); } };
    try {
      const body = message ? JSON.stringify(message) : '';
      const headers = { accept: 'application/json, text/event-stream', ...(message ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}), ...(session ? { 'mcp-session-id': session } : {}) };
      const req = require('node:http').request(url, { method, timeout: timeoutMs, headers }, res => {
        let text = ''; res.setEncoding('utf8');
        res.on('data', c => { text += c; if (text.length > 4 * 1024 * 1024) req.destroy(); });
        res.on('end', () => finish({ status: res.statusCode, session: res.headers['mcp-session-id'] || session, text }));
        res.on('error', e => finish({ error: String((e && e.code) || 'error') }));
      });
      req.on('timeout', () => { req.destroy(); finish({ error: 'timeout' }); });
      req.on('error', e => finish({ error: String((e && e.code) || 'error') }));
      req.end(body);
    } catch (e) { finish({ error: String((e && e.code) || 'error') }); }
  });
}
async function probeHttpTools(url, timeoutMs = 5000) {
  const init = await httpRpc(url, 'POST', RPC_INIT, null, timeoutMs);
  if (init.error) return { reachable: false, detail: init.error };
  const answer = init.status === 200 ? rpcOf(init.text, 1) : null;
  if (!answer || answer.error) return { reachable: false, detail: `initialize: HTTP ${init.status}` };
  await httpRpc(url, 'POST', RPC_READY, init.session, timeoutMs);
  const list = await httpRpc(url, 'POST', RPC_LIST, init.session, timeoutMs);
  if (init.session) await httpRpc(url, 'DELETE', null, init.session, timeoutMs);
  const tools = list.error ? null : toolsOf(rpcOf(list.text, 2));
  return tools ? { reachable: true, detail: `tools/list ${tools.length}`, tools } : { reachable: false, detail: `tools/list: ${list.error || `HTTP ${list.status}`}` };
}
function probeStdioTools(command, args, { cwd, env, timeoutMs = 20000 } = {}) {
  return new Promise(resolve => {
    let child = null; let done = false; let buf = ''; let timer = null;
    const finish = v => {
      if (done) return; done = true; clearTimeout(timer);
      // the end of stdin stops the server (bin.js hands the same pipes to its binary); a kill only if it is still there 5 s later
      try { child.stdin.end(); } catch { /* gone */ }
      const killer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 5000); killer.unref();
      child.once('exit', () => clearTimeout(killer));
      resolve(v);
    };
    try { child = require('node:child_process').spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true }); } catch (e) { resolve({ reachable: false, detail: String((e && e.code) || 'error') }); return; }
    timer = setTimeout(() => finish({ reachable: false, detail: 'timeout' }), timeoutMs);
    child.on('error', e => finish({ reachable: false, detail: String((e && e.code) || 'error') }));
    child.on('exit', code => finish({ reachable: false, detail: `exited ${code} before tools/list` }));
    child.stdin.on('error', () => { /* a server that exits early closes its stdin */ });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buf += chunk;
      for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
        const text = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        let j; try { j = JSON.parse(text); } catch { continue; }
        if (j && j.id === 1) { if (j.error) { finish({ reachable: false, detail: 'initialize refused' }); return; } child.stdin.write(`${JSON.stringify(RPC_READY)}\n${JSON.stringify(RPC_LIST)}\n`); }
        else if (j && j.id === 2) { const tools = toolsOf(j); finish(tools ? { reachable: true, detail: `tools/list ${tools.length}`, tools } : { reachable: false, detail: 'tools/list refused' }); return; }
      }
    });
    child.stdin.write(`${JSON.stringify(RPC_INIT)}\n`);
  });
}
// the default probe of one target: { transport: 'http', url } or { transport: 'stdio', command, args, env }
function probeTarget(target, opts = {}) {
  if (target.transport === 'http') return probeHttpTools(target.url, opts.timeoutMs);
  return probeStdioTools(target.command, target.args, { cwd: opts.root ? path.resolve(opts.root) : process.cwd(), env: { ...process.env, ...(target.env || {}) }, timeoutMs: opts.timeoutMs });
}
// What the tools/list of codebase-memory says about the read-only switch: a tool the kernel does not know (no client switch covers it: the claude deny
// list names tools) or a read-only tool the server no longer marks read-only is a finding.
function cbmToolProblems(tools) {
  if (!Array.isArray(tools)) return [];
  const out = [];
  const unknown = tools.filter(t => !seatMcp.CBM_TOOLS.includes(t.name)).map(t => t.name);
  if (unknown.length) out.push(`codebase-memory publishes tools the kernel does not know: ${unknown.join(', ')}`);
  const loose = tools.filter(t => seatMcp.CBM_READ_ONLY.includes(t.name) && !t.readOnly).map(t => t.name);
  if (loose.length) out.push(`codebase-memory no longer marks read-only: ${loose.join(', ')}`);
  return out;
}
async function doctor(opts = {}) {
  const io = opts.io || fs;
  const want = expectedServers(opts);
  // one probe per distinct target: clients that configure the same entry share its answer
  const cache = new Map();
  const probe = target => { const key = JSON.stringify(target); if (!cache.has(key)) cache.set(key, Promise.resolve((opts.probe || probeTarget)(target, opts))); return cache.get(key); };
  // What a client entry reaches. The probe goes through the client's own entry: a local URL, or node and the kernel's bin.js (no other command is
  // ever started). An entry that cannot be probed that way (missing, disabled, another server) is reported against the kernel's server instead.
  const reachOf = async (name, w, entry, reg) => {
    if (!w) return { reachable: false, detail: 'not resolved on this machine' };
    const k = entryKind(entry);
    // a stdio entry with an absolute command is reachable only if that configured command exists too (not only the node of this tool)
    if (w.transport === 'stdio' && k.kind === 'stdio' && typeof k.command === 'string' && path.isAbsolute(k.command) && !io.existsSync(k.command)) return { reachable: false, detail: 'the configured command does not exist' };
    // a stdio entry is started only as node with exactly the kernel's bin.js (no other argument, no entry environment: NODE_OPTIONS could load code)
    const own = reg === 'ok' ? (k.kind === 'http' || (k.args.length === 1 && samePath(k.args[0], w.args[0]))) : (k.kind === 'http' && seatMcp.LOCAL_URL.test(k.url));
    const target = own && k.kind === 'http' ? { transport: 'http', url: k.url } : own && k.kind === 'stdio' ? { transport: 'stdio', command: k.command, args: k.args }
      : w.transport === 'http' ? { transport: 'http', url: w.url } : { transport: 'stdio', command: w.command, args: w.args };
    if (opts.noProbe) return target.transport === 'http' ? { reachable: null, detail: 'not probed' } : { reachable: io.existsSync(target.args[0]) && io.existsSync(target.command), detail: 'bin.js and node present (not started)' };
    const r = await probe(target);
    return { ...r, detail: `${r.detail}${own ? '' : ' (the kernel server: this client has no entry to probe)'}` };
  };
  const rows = [];
  for (const [client, spec] of Object.entries(CLIENTS)) {
    const file = path.join(home(opts), spec.file);
    const row = { client, file, servers: {} };
    let text = null;
    try { text = io.readFileSync(file, 'utf8'); } catch (e) { row.state = e.code === 'ENOENT' ? 'no-config' : 'unreadable'; }
    let value = null;
    if (text !== null) { try { value = parseConfig(text, spec.format).value; row.state = 'parsed'; } catch (e) { row.state = 'parse-error'; row.error = quietParseMessage(e.message); } }
    for (const name of SERVERS) {
      const w = want.list.find(s => s.name === name);
      const entry = value ? entryOf(client, value, name) : undefined;
      let reg = value ? (w ? registration(entry, w) : (entry === undefined ? 'missing' : 'present')) : 'unknown';
      const broken = reg === 'ok' ? vibeCommandProblem(client, entry) : null;
      if (broken) reg = 'differs';
      const r = broken ? { reachable: false, detail: broken } : await reachOf(name, w, entry, reg);
      const problems = name === 'codebase-memory' ? cbmToolProblems(r.tools) : [];
      row.servers[name] = { registered: reg, reachable: r.reachable, detail: r.detail, ...(Array.isArray(r.tools) ? { tools: r.tools.length } : {}), ...(problems.length ? { problems } : {}) };
    }
    rows.push(row);
  }
  // OK only when every entry is registered, no server was found unreachable (not probed, --no-probe, is not a finding) and the codebase-memory
  // tools are the ones the read-only switches cover
  const ok = rows.every(r => SERVERS.every(n => r.servers[n].registered === 'ok' && r.servers[n].reachable !== false && !r.servers[n].problems));
  const optional = semgrep.resolve({ root: opts.root, env: opts.env || process.env, io, execPath: opts.execPath || process.execPath });
  const measurement = opts.probeSemgrep ? await semgrep.probe(optional, opts.timeoutMs) : null;
  const unwired = ['copilot', 'qwen', 'cline'];
  const optionalClients = [...Object.keys(CLIENTS).filter(c => !unwired.includes(c)), ...unwired].map(client => ({ client,
    state: unwired.includes(client) ? 'not-wired-for-semgrep' : optional.state,
    measurement: unwired.includes(client) ? 'unmeasured' : measurement?.ok ? 'measured' : 'unmeasured' }));
  return { ok, notes: [...want.notes, ...optional.notes], rows, optional: { semgrep: { state: measurement ? measurement.ok ? 'ready' : 'differs' : optional.state, measurement,
    instruction: 'Set COLABUS_SEMGREP_BIN to local CLI 1.183.0; select .ai/mcp-optional.json; doctor --root PROJECT --probe-semgrep' } }, optionalClients };
}
function doctorText(result) {
  const lines = ['mcp-wiring doctor (advisory; never Evidence)'];
  for (const r of result.rows) {
    lines.push(`${r.client.padEnd(6)} ${r.state.padEnd(11)} ${SERVERS.map(n => `${n}=${r.servers[n].registered}/${r.servers[n].reachable === null ? 'unprobed' : r.servers[n].reachable ? 'reachable' : 'unreachable'}`).join(' ')}${r.error ? ` (${r.error})` : ''}`);
    for (const n of SERVERS) {
      const s = r.servers[n];
      if (s.reachable === false || s.tools !== undefined) lines.push(`  ${r.client} ${n}: ${s.detail}`);
      for (const p of s.problems || []) lines.push(`  ${r.client} ${n}: ${p}`);
    }
  }
  for (const n of result.notes) lines.push(`note: ${n}`);
  if (result.optional) lines.push(`semgrep=${result.optional.semgrep.state} (optional; mandatory OK unchanged)`);
  for (const r of result.optionalClients || []) lines.push(`semgrep client=${r.client} state=${r.state} measurement=${r.measurement}`);
  lines.push(`DOCTOR ${result.ok ? 'OK' : 'FINDINGS'}`);
  return lines.join('\n');
}

// ---------- apply ----------
const nl = text => (text.includes('\r\n') ? '\r\n' : '\n');
const tomlLiteral = s => { if (/['\r\n]/.test(s)) throw new ParseError(`a path holding a quote or a newline cannot be a TOML literal string: ${JSON.stringify(s)}`); return `'${s}'`; };
function tomlBlock(client, s, eolText) {
  const lines = client === 'vibe' ? ['[[mcp_servers]]', `name = ${tomlLiteral(s.name)}`] : [`[mcp_servers.${s.name}]`];
  if (s.transport === 'http') { if (client === 'vibe') lines.push("transport = 'streamable-http'"); lines.push(`url = ${tomlLiteral(s.url)}`); }
  // vibe cuts a string command with shlex.split: its command is a one-element list
  else { if (client === 'vibe') lines.push("transport = 'stdio'"); lines.push(client === 'vibe' ? `command = [${tomlLiteral(s.command)}]` : `command = ${tomlLiteral(s.command)}`, `args = [${s.args.map(tomlLiteral).join(', ')}]`); }
  if (s.env) lines.push(`env = { ${Object.entries(s.env).map(([k, v]) => `${k} = ${tomlLiteral(v)}`).join(', ')} }`);
  return lines.join(eolText);
}
// One planned edit: { client, file, action: 'none'|'insert'|'command'|'refuse', reason, text, offset, missing }
function planClient(client, opts, want) {
  const spec = CLIENTS[client];
  const io = opts.io || fs;
  const file = path.join(home(opts), spec.file);
  let text;
  try { text = io.readFileSync(file, 'utf8'); } catch (e) { return e.code === 'ENOENT' ? { client, file, action: 'skip', reason: 'no config file (the client is not installed here or never ran)' } : { client, file, action: 'refuse', reason: `unreadable (${e.code})` }; }
  if (spec.applyBy !== 'command' && spec.applyBy !== 'owner') { const outside = writeTargetProblem(home(opts), file, io); if (outside) return { client, file, action: 'refuse', reason: `outside the home: ${outside}` }; }
  let parsed;
  try { parsed = parseConfig(text, spec.format); } catch (e) { return { client, file, action: 'refuse', reason: `parse error: ${quietParseMessage(e.message)}` }; }
  const states = want.list.map(s => { const entry = entryOf(client, parsed.value, s.name); const reg = registration(entry, s); return { s, reg: reg === 'ok' && vibeCommandProblem(client, entry) ? 'differs' : reg }; });
  const differ = states.filter(x => x.reg === 'differs' || x.reg === 'disabled').map(x => `${x.s.name} ${x.reg}`);
  const missing = states.filter(x => x.reg === 'missing').map(x => x.s);
  if (!missing.length) return { client, file, action: 'none', reason: differ.length ? `present but not as expected (left as it is): ${differ.join(', ')}` : 'registered', missing: [] };
  if (spec.applyBy === 'command') {
    const cmds = missing.map(s => s.transport === 'http' ? `claude mcp add --scope user --transport http ${s.name} ${s.url}` : `claude mcp add-json --scope user ${s.name} ${JSON.stringify(JSON.stringify(spec.stdio(s.command, s.args, s.env)))}`);
    return { client, file, action: 'command', reason: spec.note, text: cmds.join('\n'), missing };
  }
  // the owner's settings: the entries to add are printed (kernel values only), the file is never written
  if (spec.applyBy === 'owner') return { client, file, action: 'owner', reason: spec.note, text: missing.map(s => `${JSON.stringify(s.name)}: ${JSON.stringify(s.transport === 'http' ? spec.http(s.url) : spec.stdio(s.command, s.args, s.env))}`).join('\n'), missing };
  const e = nl(text);
  let insert; let offset;
  try {
    if (spec.format === 'toml-table' || spec.format === 'toml-array') {
      offset = text.length;
      insert = `${text.length && !text.endsWith('\n') ? e : ''}${text.length ? e : ''}# mcp-wiring: kernel MCP servers${e}${missing.map(s => tomlBlock(client, s, e)).join(e + e)}${e}`;
    } else {
      const entries = missing.map(s => [s.name, s.transport === 'http' ? spec.http(s.url) : spec.stdio(s.command, s.args, s.env)]);
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
      : spec.format === 'toml-array' ? (s.transport === 'http' ? { name: s.name, transport: 'streamable-http', url: s.url } : { name: s.name, transport: 'stdio', command: [s.command], args: s.args })
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
    if (p.action === 'owner') { lines.push(...p.text.split('\n').map(l => `  owner adds to mcpServers: ${l}`)); continue; }
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

// ---------- metric (dormant: not available in this release) ----------
// No command reaches the counting code below: the metric command prints the one line METRIC_UNAVAILABLE and reads nothing, and the module
// exports the counting code only as dormantMetric, for its development tests. No switch, variable or option turns it on: shipping it again is a
// change of this code.
const METRIC_UNAVAILABLE = 'mcp-wiring metric: the MCP call metric is not available in this release; nothing is read and no count is printed';
//
// The contract of the dormant code: no source the metric reads can prove that it holds a seat's whole session, so the metric never claims that any seat's evidence
// is whole. Per seat and in total it reports only the calls observed, each count a lower bound (atLeast) with the source it came from (from), and
// the reason for every source that could not be read (reasons; a read error is a named reason, never an empty result taken for a fact). A count
// no source showed is null and the text shows it as unknown: the metric never prints a zero, an exact count or an exact total. The reasons of
// the run (an input of every seat that could not be read: the runtime directory, a launch file) are named apart.
//
// The kernel server of a tool name, in every form the clients write (measured on the clients): claude, kimi and cline mcp__SERVER__TOOL; codex
// names server and tool in fields of their own; vibe 2.26 (Unified Harness) mcp_NAME.TOOL (NAME the server name with every character outside
// [A-Za-z0-9_$] made _, a digest suffix after a collision of two such names); kilo and mimo (opencode) SERVER_TOOL, as the tool name or as the
// name inside their mcp_tool_use wrapper; the vibe display form NAME_TOOL. A name gives a kernel server exactly only when it splits into server
// and tool in one way: one __ after mcp__, a harness name without a digest suffix, one _ or . in a joined name. A name that a kernel server and
// another server could both have written (qmd_multi_get: qmd and multi_get, or a server qmd_multi and get) is ambiguous: it is never counted
// and it leaves the seat unknown. Anything else is not a kernel server.
const KERNEL_NAMES = Object.freeze({ qmd: 'qmd', 'codebase-memory': 'codebase-memory', codebase_memory: 'codebase-memory', semgrep: 'semgrep' });
// { server, exact } of a tool name, or null when no kernel server can have written it
function kernelName(name) {
  if (typeof name !== 'string' || !name) return null;
  const harness = /^mcp_([^._][^.]*)\.(.+)$/.exec(name);
  if (harness) { const m = /^(qmd|codebase_memory|semgrep)(_[0-9a-f]{8,64})?$/.exec(harness[1]); return m ? { server: KERNEL_NAMES[m[1]], exact: !m[2] } : null; }
  const prefixed = name.startsWith('mcp__'); const text = prefixed ? name.slice(5) : name; const splits = [];
  for (let i = 0; i < text.length; i++) {
    if (prefixed ? text.startsWith('__', i) : text[i] === '_' || text[i] === '.') splits.push([text.slice(0, i), text.slice(i + (prefixed ? 2 : 1))]);
  }
  const real = splits.filter(([s, t]) => s && t);
  // claude names a server as it is configured: the kernel's is codebase-memory, a server codebase_memory is another one
  const kernel = real.find(([s]) => Object.hasOwn(KERNEL_NAMES, s) && !(prefixed && s === 'codebase_memory'));
  return kernel ? { server: KERNEL_NAMES[kernel[0]], exact: real.length === 1 } : null;
}
const serverOf = name => { const k = kernelName(name); return k && k.exact ? k.server : null; };
// a tool call that starts a subagent or a child session whose transcript the client keeps apart from the seat's own: claude and kimi Task and
// Agent, codex spawn_agent and collab tool calls, opencode task with a prompt (the mimo task tool that keeps a task list, input operation, is none)
const childTool = (name, input) => /^(Task|Agent|spawn_agent)$/.test(name)
  || (name === 'task' && !(input && typeof input === 'object' && input.operation && !input.prompt && !input.subagent_type));
const callOf = (name, input) => { const k = kernelName(name); return { name, server: k && k.exact ? k.server : null, ambiguous: Boolean(k && !k.exact), child: childTool(name, input) }; };
// codex names the server in a field of its own: exactly a kernel server name, or another server
const codexCall = (server, tool) => ({ name: `${server}.${tool}`, server: ['qmd', 'codebase-memory', 'semgrep'].includes(server) ? server : null, ambiguous: false, child: false });
// The calls of one source of a seat, each once by its identity across every file that source reads: the id its client gives the call, or else
// its content (the name and the arguments). A replay or a copy of a call (a child rollout that replays its parent's history, a subagent
// transcript, a status row of the same call) is that call again; a call without an id whose content an identified call shares is that call; an
// id that two different calls carry is one call of no server (conflict). The count may be smaller than the calls made, never larger.
const contentOf = (call, input) => `${call.name}\u0000${canonical(input === undefined ? null : input)}`;
function callBook() {
  const byId = new Map(); const byContent = new Map(); const contents = new Set();
  const add = (id, call, input, at = 0) => {
    if (typeof call.name !== 'string' || !call.name) return;
    const content = contentOf(call, input); contents.add(content);
    if (typeof id === 'string' && id) {
      const had = byId.get(id);
      if (!had) byId.set(id, { ...call, content, at }); else if (had.name !== call.name) byId.set(id, { ...had, server: null, conflict: true });
    } else if (!byContent.has(content)) byContent.set(content, { ...call, content, at });
  };
  const calls = () => { const named = new Set([...byId.values()].map(c => c.content)); return [...byId.values(), ...[...byContent.values()].filter(c => !named.has(c.content))]; };
  // whether a call is one this book already holds: the same id, or for a call without an id the same content
  const holds = (id, call, input) => (typeof id === 'string' && id ? byId.has(id) : contents.has(contentOf(call, input)));
  return { add, calls, holds, ids: () => [...byId.keys()] };
}
// the calls of a list of events by server: { toolEvents, qmd, cbm, semgrep }
function callCounts(events) {
  const c = { toolEvents: events.length, qmd: 0, cbm: 0, semgrep: 0 };
  for (const e of events) if (e.server) c[e.server === 'codebase-memory' ? 'cbm' : e.server]++;
  return c;
}
// One call file: its structured tool events (each call once, as callBook keeps it: a status row of the same call is no second call), its format, whether
// that format shows tool calls at all, the session ids it names, the launches it holds (marker= lines), the events the lower bound may count and
// the problem that keeps the file, or a part of it, from counting (null when there is none). Plain text that only mentions a server (the prompt
// names qmd) is never counted, and neither is an example inside a Markdown code fence (a quoted prompt or report). The final answer of claude
// --output-format json and of codex exec without --json shows no tool call: such a seat's calls come only from its client's session store.
// The format is what the client writes first, never a later line: the launcher writes each launch output (stdout, then stderr) after its marker=
// line, and the first line of the first output is an event of a JSON stream format or the one result object of claude --output-format json; a
// file without a marker line is one output. Any other first line makes the output plain text, so an answer that quotes a JSONL line or a tool
// line is no stream. codex exec text is known by its declared header, the banner (OpenAI Codex vN, a dashed line, the settings with the session
// id, a dashed line); its tool lines share one grammar with the answer text (tool S.T(...)), so it proves no call and gives only the session id.
// A stream counts towards the lower bound only as the client's own record of one session: one stream format, one session it names, opening with
// the record its client writes first (STREAM_START, measured on the call files of each client); its events count up to the first line of
// another writer inside it. Otherwise problem names why: two stream formats (mixed), two sessions (sessions), a damaged event inside it
// (unparsable) or a cut one at its end (truncated), a line of another writer between its events (interleaved: text, an object that is no event,
// a Markdown fence), no first record (no-start), no session id (no-session-id).
const STREAM_START = Object.freeze({
  'vibe-streaming': j => j.type === 'message' && j.role === 'user', // the prompt
  'opencode-json': j => j.type === 'step_start',
  'codex-json': j => j.type === 'thread.started',
  'claude-stream-json': j => j.type === 'system' && j.subtype === 'init',
  'role-stream-json': j => j.role === 'meta' && j.type === 'system.version', // kimi opens with its version
});
// the error event a client writes into its own stream (opencode names its session in it, measured on its call files; codex exec --json writes
// type error with a message, its event schema): an event of that stream, never a tool call
const STREAM_ERROR = Object.freeze({ 'opencode-json': j => j.type === 'error' && typeof j.sessionID === 'string', 'codex-json': j => j.type === 'error' && typeof j.message === 'string' });
// every event line of a JSON stream format opens the same way: a line that opens so (blanks aside) or is cut inside that opening and does not
// parse is a cut or damaged event of the stream
const STREAM_OPENING = Object.freeze({ 'vibe-streaming': '{"id":', 'opencode-json': '{"type":', 'codex-json': '{"type":', 'claude-stream-json': '{"type":', 'role-stream-json': '{"role":' });
const opensLike = (format, l) => l.length > 1 && (new RegExp(`^\\{\\s*"${STREAM_OPENING[format].slice(2, -2)}"\\s*:`).test(l) || STREAM_OPENING[format].startsWith(l.replace(/\s+/g, '')));
// the stream format of one parsed line; claude-result is the one result object of claude --output-format json (a stream only after claude events)
function streamOf(j) {
  if (j.type === 'effect' || (typeof j.sessionId === 'string' && typeof j.turnId === 'string')) return 'vibe-streaming';
  if (j.part && typeof j.part === 'object' && /^(tool_use|step_start|step_finish|text|reasoning)$/.test(String(j.type))) return 'opencode-json';
  if (/^(thread\.started|turn\.(started|completed|failed)|item\.(started|updated|completed))$/.test(String(j.type))) return 'codex-json';
  if ((j.type === 'system' && j.subtype === 'init') || ((j.type === 'assistant' || j.type === 'user') && j.message)) return 'claude-stream-json';
  if (j.type === 'result') return 'claude-result';
  if (/^(assistant|tool|user|system|meta)$/.test(String(j.role))) return 'role-stream-json';
  return null;
}
const SESSION_OF = Object.freeze({ 'vibe-streaming': j => j.sessionId, 'opencode-json': j => j.sessionID || (j.part && j.part.sessionID), 'codex-json': j => (j.type === 'thread.started' ? j.thread_id : null),
  'claude-stream-json': j => j.session_id, 'claude-result': j => j.session_id, 'role-stream-json': j => (j.type === 'session.resume_hint' ? j.session_id : null) });
const CODEX_BANNER = /^OpenAI Codex v\d/;
const DASHES = /^-{4,}$/;
function readTranscript(text) {
  const book = callBook(); let fence = null; let format = null; let result = false; let header = false; let firstCut = false; let decided = false;
  const ids = new Set(); const broken = []; const strays = []; let launches = 0; let mixed = false; let started = false; let lastAt = -1;
  const add = (at, id, call, input) => book.add(id, call, input, at);
  const lines = String(text).split(/\r?\n/);
  // the launcher lines before the first marker= line are no output of the client
  let output = !lines.some(l => /^marker=\S/.test(l.trim())); let first = output;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i].trim();
    if (/^marker=\S/.test(l)) { launches++; output = true; first = true; continue; }
    if (!output || !l) continue;
    if (first) {
      // the first record of the first output decides the format (a line that opens like a stream event and does not parse is a cut first event,
      // not plain text); the first record of a later output gives only the session id of a claude result
      first = false;
      let j = null; let cut = false;
      if (l[0] === '{') { try { j = JSON.parse(l); } catch { cut = Object.keys(STREAM_OPENING).some(f => opensLike(f, l)); } }
      const f = j && typeof j === 'object' ? streamOf(j) : null;
      if (f === 'claude-result') { const sid = SESSION_OF[f](j); if (typeof sid === 'string' && sid) ids.add(sid); if (!decided) { decided = true; result = true; } continue; }
      if (!decided) { decided = true; firstCut = cut; if (f) { format = f; started = STREAM_START[f](j); } }
    }
    if (format === null) {
      // plain text: only the codex banner is read, for the session id inside it; a JSON line or a tool line is text of the answer
      if (CODEX_BANNER.test(l) && DASHES.test(String(lines[i + 1] || '').trim())) {
        header = true;
        for (let k = i + 2; k < lines.length && !DASHES.test(lines[k].trim()); k++) { const b = /^session id:\s*([A-Za-z0-9-]{1,80})$/.exec(lines[k].trim()); if (b) ids.add(b[1]); }
      }
      continue;
    }
    // inside a stream: a fence, a fenced line, text and an object that is no event are lines of another writer (strays), never events
    const mark = /^(`{3,}|~{3,})/.exec(l);
    if (mark) { strays.push(i); if (fence === null) fence = mark[1][0]; else if (mark[1][0] === fence) fence = null; continue; }
    if (fence !== null || l[0] !== '{') { strays.push(i); continue; }
    let j; try { j = JSON.parse(l); } catch { broken.push({ i, l }); continue; }
    let f = j && typeof j === 'object' ? streamOf(j) : null;
    if (f === 'claude-result' && format === 'claude-stream-json') f = format;
    if (!f && STREAM_ERROR[format] && STREAM_ERROR[format](j)) f = format;
    if (!f) { strays.push(i); continue; }
    // an event of another stream format makes the file mixed
    if (f !== format) { mixed = true; continue; }
    const sid = SESSION_OF[f](j);
    if (typeof sid === 'string' && sid) ids.add(sid);
    lastAt = i;
    if (j.type === 'effect' && j.detail && typeof j.detail.toolName === 'string') add(i, j.id, callOf(j.detail.toolName, j.detail.args), j.detail.args);
    else if (j.type === 'tool_use' && j.part && j.part.type === 'tool') {
      const input = j.part.state && j.part.state.input;
      // the opencode wrapper of an MCP call names the tool inside it; a wrapper without that name is an MCP call of a server nobody can name
      const call = j.part.tool === 'mcp_tool_use' ? (input && typeof input.name === 'string' && input.name ? callOf(input.name) : { name: 'mcp_tool_use', server: null, ambiguous: true, child: false }) : callOf(j.part.tool, input);
      add(i, j.part.callID || j.part.id, call, input);
    } else if (j.role === 'assistant' && Array.isArray(j.tool_calls)) { for (const tc of j.tool_calls) if (tc && tc.function) add(i, tc.id, callOf(tc.function.name), tc.function.arguments); }
    else if (j.type === 'assistant' && j.message && Array.isArray(j.message.content)) { for (const c of j.message.content) if (c && c.type === 'tool_use') add(i, c.id, callOf(c.name, c.input), c.input); }
    else if (j.item && typeof j.item === 'object' && typeof j.item.type === 'string' && /^item\./.test(String(j.type))) {
      if (j.item.type === 'mcp_tool_call') add(i, j.item.id, codexCall(j.item.server, j.item.tool), j.item.arguments);
      else if (j.item.type === 'collab_tool_call') add(i, j.item.id, { name: j.item.type, server: null, ambiguous: false, child: true });
      else if (/^(command_execution|file_change|web_search)$/.test(j.item.type)) add(i, j.item.id, { name: j.item.type, server: null, ambiguous: false, child: false });
    }
  }
  // a line that opens like an event of the format and does not parse: before the last event damaged, after it cut; any other line before the
  // last event was written by someone else (after it: stderr and the launcher's lines)
  const damaged = format ? broken.filter(b => opensLike(format, b.l)) : [];
  const inside = [...strays, ...broken.filter(b => !damaged.includes(b)).map(b => b.i)].filter(i => i < lastAt);
  const firstStray = inside.length ? Math.min(...inside) : Infinity;
  const problem = format === null ? (firstCut ? 'unparsable' : null) : mixed ? 'mixed' : ids.size > 1 ? 'sessions'
    : damaged.some(b => b.i < lastAt) ? 'unparsable' : inside.length ? 'interleaved' : damaged.length ? 'truncated' : !started ? 'no-start'
      : !ids.size ? 'no-session-id' : null;
  const all = book.calls();
  const own = format !== null && started && !mixed && ids.size === 1;
  return { events: all, observed: own ? all.filter(e => e.at < firstStray) : [], format: format || (result ? 'claude-result' : header ? 'codex-text' : 'unknown'), showsTools: format !== null,
    sessionIds: [...ids], launches, problem };
}
function toolEvents(text) { return readTranscript(text).events.map(e => e.name); }

// ---------- the client session stores (read only) ----------
// codex keeps every exec session as a rollout CODEX_HOME/sessions/YYYY/MM/DD/rollout-STAMP-ID.jsonl: its first line (session_meta) names the
// same id and the working directory, every line is a record with a type and a payload, its McpToolCall items name server and tool, and each of
// its spawn_agent function calls starts a subagent; a child session (a subagent, a guardian review) is a rollout of its own whose session_meta
// names its parent (parent_thread_id, and source thread_spawn for a subagent; a fork also forked_from_id). A forked child replays its parent's
// history: the parent's calls again with the same item ids, arguments and results, right after its own session_meta or after the parent's.
// claude keeps the transcript of a session as CLAUDE_CONFIG_DIR/projects/DIR/ID.jsonl, each line of the conversation naming its sessionId; each
// Task or Agent call starts a subagent whose transcript lies in DIR/ID/subagents, its rows naming the same sessionId and at times a call of the
// session again by its tool_use id (measured on the session stores of both clients).
// A seat is bound to exactly its own session by the exact id its call file or its launch records (calleeSession) name, never by a prefix, a
// time window or a directory alone. Every source is read best effort and counts only with what is the seat's own: the rows of a rollout up to
// the first line that is no whole record of that session (a line that does not parse or is no object, a line of no type, another session's
// session_meta), the conversation rows of a claude transcript that name the seat's id, and the children found. Each call counts once by its
// identity (callBook) across the seat's sessions, their child rollouts and their subagent transcripts; a session that is itself a child or a
// fork replays the session it names, so what that session's rollout holds is not the seat's. Whatever could not be read is a named reason,
// never an empty result taken for a fact: a store directory that cannot be listed; no file or two files of the id; a file that cannot be read,
// is empty, damaged or cut, or is of another session or directory; a line inside a rollout that is not its own; conversation rows without the
// id; a child rollout or subagent transcript that cannot be read; the rollout of the session a child seat names; fewer child transcripts than
// the calls that started children; a rollout of that day or the next whose first record names no id (it may be a child of any session).
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,79}$/;
const samePlace = p => String(p).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
// the names in a directory and the read error: a directory that does not exist holds nothing, any other error is named, never an empty listing
const listDir = (dir, io) => {
  try { return { names: io.readdirSync(dir), error: null }; } catch (e) { return { names: [], error: e && (e.code === 'ENOENT' || e.code === 'ENOTDIR') ? null : String((e && e.code) || 'error') }; }
};
// the session files of a store by the exact id in their names, listed once per metric run; errors collects the listings that failed
function storeIndex(dirs, io, idOf, errors) {
  const index = new Map();
  for (const dir of dirs) {
    const l = listDir(dir, io); if (l.error) errors.push(l.error);
    for (const n of l.names) { const id = idOf(n); if (id) { if (!index.has(id)) index.set(id, []); index.get(id).push(path.join(dir, n)); } }
  }
  return index;
}
// the session_meta payload of a rollout from its first line (codex writes it whole, the base instructions included, well inside 128 KB), or null
function rolloutMeta(file, io, buf) {
  let head;
  try { const fd = io.openSync(file, 'r'); try { head = buf.subarray(0, io.readSync(fd, buf, 0, buf.length, 0)).toString('utf8'); } finally { io.closeSync(fd); } }
  catch { try { head = String(io.readFileSync(file, 'utf8')).slice(0, buf.length); } catch { return null; } }
  const end = head.indexOf('\n');
  try { const j = JSON.parse(end >= 0 ? head.slice(0, end) : head); return j && j.type === 'session_meta' && j.payload && typeof j.payload === 'object' ? j.payload : null; } catch { return null; }
}
const dayOf = file => path.dirname(file).split(/[\\/]/).slice(-3).join('-');
const nextDay = day => { const t = Date.parse(`${day}T00:00:00Z`); return Number.isFinite(t) ? new Date(t + 86400000).toISOString().slice(0, 10) : ''; };
function codexIndex(home, io) {
  const root = path.join(home, 'sessions'); const dirs = []; const errors = [];
  const below = dir => { const l = listDir(dir, io); if (l.error) errors.push(l.error); return l.names; };
  for (const y of below(root)) for (const mo of below(path.join(root, y))) for (const d of below(path.join(root, y, mo))) dirs.push(path.join(root, y, mo, d));
  const byId = storeIndex(dirs, io, n => { const m = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)\.jsonl$/.exec(n); return m ? m[1] : null; }, errors);
  const children = new Map(); const unattributed = new Set(); const buf = Buffer.alloc(131072);
  for (const [id, files] of byId) for (const file of files) {
    const meta = files.length === 1 ? rolloutMeta(file, io, buf) : null;
    if (!meta || meta.id !== id) { unattributed.add(dayOf(file)); continue; }
    const parent = meta.parent_thread_id;
    const spawned = Boolean(meta.source && meta.source.subagent && meta.source.subagent.thread_spawn);
    if (typeof parent === 'string' && parent) { if (!children.has(parent)) children.set(parent, []); children.get(parent).push({ id, file, spawned }); }
  }
  // a child starts while its parent runs: on the parent's day or the next
  return { byId, children, unreadable: errors.length > 0, unattributedNear: file => unattributed.has(dayOf(file)) || unattributed.has(nextDay(dayOf(file))) };
}
function claudeIndex(home, io) {
  const root = path.join(home, 'projects'); const errors = [];
  const l = listDir(root, io); if (l.error) errors.push(l.error);
  const byId = storeIndex(l.names.map(d => path.join(root, d)), io, n => (n.endsWith('.jsonl') ? n.slice(0, -'.jsonl'.length) : null), errors);
  return { byId, unreadable: errors.length > 0 };
}
// every non-blank line of a session file that is one JSON object, how many of them come before the first line that is not (whole), and the
// first problem: empty, or a line that is not one (the last line: truncated)
function jsonRows(text) {
  const lines = String(text).split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return { rows: [], whole: 0, problem: 'empty' };
  const rows = []; let problem = null; let whole = null;
  for (let i = 0; i < lines.length; i++) {
    let j = null; try { j = JSON.parse(lines[i]); } catch { j = null; }
    if (j && typeof j === 'object' && !Array.isArray(j)) rows.push(j);
    else if (!problem) { problem = i === lines.length - 1 ? 'truncated' : 'unparsable'; whole = rows.length; }
  }
  return { rows, whole: whole === null ? rows.length : whole, problem };
}
// one rollout read as the session of this id: { read, calls, spawns, origin, problems }; parent is the parent's id for a child, workdir the seat's
// working directory, origin the session its session_meta names as its parent or as the one it was forked from. A rollout that does not open with
// its session_meta, or is of another session or directory, shows nothing of this seat; the rows from the first line that is no whole record of
// this session on do not count either.
function codexRollout(file, id, parent, workdir, io) {
  let text; try { text = io.readFileSync(file, 'utf8'); } catch { return { read: false, calls: [], spawns: 0, problems: ['unreadable'] }; }
  const r = jsonRows(text);
  const head = r.whole ? r.rows[0] : null;
  const meta = head && head.type === 'session_meta' && head.payload && typeof head.payload === 'object' ? head.payload : null;
  if (!meta) return { read: false, calls: [], spawns: 0, problems: [r.problem || 'no-start'] };
  if (meta.id !== id || (parent && meta.parent_thread_id !== parent) || (typeof workdir === 'string' && typeof meta.cwd === 'string' && samePlace(meta.cwd) !== samePlace(workdir))) return { read: false, calls: [], spawns: 0, problems: ['foreign'] };
  const calls = []; let spawns = 0; let stray = false;
  for (const j of r.rows.slice(1, r.whole)) {
    if (typeof j.type !== 'string' || !j.payload || typeof j.payload !== 'object' || (j.type === 'session_meta' && j.payload.id !== id)) { stray = true; break; }
    const it = j.payload.item;
    if (it && it.type === 'McpToolCall' && typeof it.server === 'string' && typeof it.tool === 'string') calls.push({ id: it.id, call: codexCall(it.server, it.tool), input: it.arguments });
    else if (j.payload.type === 'function_call' && j.payload.name === 'spawn_agent') spawns++;
  }
  const origin = [meta.parent_thread_id, meta.forked_from_id].find(x => typeof x === 'string' && x) || null;
  return { read: true, calls, spawns, origin, problems: [r.problem, stray ? 'foreign-record' : null].filter(Boolean) };
}
// every call a rollout holds, its own and those it replays (each row that parses), as a book: what a child or a fork of it replays
function rolloutBook(file, io) {
  let text; try { text = io.readFileSync(file, 'utf8'); } catch { return null; }
  const book = callBook();
  for (const j of jsonRows(text).rows) {
    const it = j.payload && typeof j.payload === 'object' ? j.payload.item : null;
    if (it && it.type === 'McpToolCall' && typeof it.server === 'string' && typeof it.tool === 'string') book.add(it.id, codexCall(it.server, it.tool), it.arguments);
  }
  return book;
}
// the codex session of this id with every child rollout below it, each call added once to the seat's book: { read, reasons, sessions }, sessions
// the ids of the rollouts read
function codexSession(idx, id, workdir, io, book) {
  const reasons = idx.unreadable ? ['codex-store-unreadable'] : [];
  const files = idx.byId.get(id) || [];
  if (files.length !== 1) return { read: false, reasons: [...reasons, files.length ? 'codex-session-ambiguous' : 'codex-session-missing'], sessions: [] };
  const own = codexRollout(files[0], id, null, workdir, io);
  reasons.push(...own.problems.map(p => `codex-session-${p}`));
  if (!own.read) return { read: false, reasons, sessions: [] };
  // a session that is itself a child or a fork replays the session it names: what that session's rollout holds is not the seat's, and without
  // that rollout no call can be told apart from a replay
  let theirs = null;
  if (own.origin) {
    const of = idx.byId.get(own.origin) || [];
    theirs = of.length === 1 ? rolloutBook(of[0], io) : null;
    if (!theirs) return { read: false, reasons: [...reasons, `codex-session-parent-${of.length > 1 ? 'ambiguous' : of.length ? 'unreadable' : 'missing'}`], sessions: [] };
  }
  const kids = []; const seen = new Set([id]); const queue = [{ id, spawns: own.spawns }];
  while (queue.length) {
    const p = queue.shift();
    const found = (idx.children.get(p.id) || []).filter(c => !seen.has(c.id));
    // each spawn_agent call starts a subagent with a rollout of its own: fewer such rollouts than calls means a child transcript is missing
    if (found.filter(c => c.spawned).length < p.spawns) reasons.push('codex-session-child-missing');
    for (const c of found) {
      seen.add(c.id);
      const k = (idx.byId.get(c.id) || []).length > 1 ? { calls: [], spawns: 0, problems: ['ambiguous'] } : codexRollout(c.file, c.id, p.id, null, io);
      kids.push(k); queue.push({ id: c.id, spawns: k.spawns });
    }
  }
  for (const k of kids) reasons.push(...k.problems.map(x => `codex-session-child-${x}`));
  if (idx.unattributedNear(files[0])) reasons.push('codex-session-unattributed-rollout');
  for (const x of [own, ...kids]) for (const c of x.calls) if (!theirs || !theirs.holds(c.id, c.call, c.input)) book.add(c.id, c.call, c.input);
  return { read: true, reasons, sessions: [...seen] };
}
// the transcripts below a directory (the subagents of a claude session, and theirs), a few levels deep: { files, top, error }
function transcriptsBelow(dir, io, depth = 0) {
  const l = listDir(dir, io); const out = { files: [], top: 0, error: l.error };
  for (const n of l.names) {
    if (n.endsWith('.jsonl')) { out.files.push(path.join(dir, n)); out.top++; } else if (depth < 3) { const s = transcriptsBelow(path.join(dir, n), io, depth + 1); out.files.push(...s.files); out.error = out.error || s.error; }
  }
  return out;
}
// the tool calls of the conversation rows that name this session id, added to the book; { children, unnamed, foreign }: the calls that start a
// subagent, and whether a conversation row names no id or another one (neither counts)
function claudeCalls(rows, id, book) {
  const seen = { children: 0, unnamed: false, foreign: false };
  for (const j of rows) {
    if (typeof j.sessionId === 'string' && j.sessionId !== id) { seen.foreign = true; continue; }
    if (j.type !== 'user' && j.type !== 'assistant') continue;
    if (j.sessionId !== id) { seen.unnamed = true; continue; }
    if (j.type !== 'assistant' || !j.message || !Array.isArray(j.message.content)) continue;
    for (const c of j.message.content) {
      if (!c || c.type !== 'tool_use' || typeof c.name !== 'string' || !c.name) continue;
      book.add(c.id, callOf(c.name, c.input), c.input);
      if (/^(Task|Agent)$/.test(c.name)) seen.children++;
    }
  }
  return seen;
}
// the claude session of this id with the transcripts of its subagents, each call added once to the seat's book: { read, reasons, sessions }
function claudeSession(idx, id, io, book) {
  const reasons = idx.unreadable ? ['claude-store-unreadable'] : [];
  const files = idx.byId.get(id) || [];
  if (files.length !== 1) return { read: false, reasons: [...reasons, files.length ? 'claude-session-ambiguous' : 'claude-session-missing'], sessions: [] };
  let text; try { text = io.readFileSync(files[0], 'utf8'); } catch { return { read: false, reasons: [...reasons, 'claude-session-unreadable'], sessions: [] }; }
  const r = jsonRows(text);
  if (r.problem) reasons.push(`claude-session-${r.problem}`);
  const own = claudeCalls(r.rows, id, book);
  const subs = transcriptsBelow(path.join(path.dirname(files[0]), id, 'subagents'), io);
  if (subs.error) reasons.push('claude-session-subagents-unreadable');
  const flags = [own];
  for (const f of subs.files) {
    let s; try { s = jsonRows(io.readFileSync(f, 'utf8')); } catch { reasons.push('claude-session-subagents-unreadable'); continue; }
    if (s.problem) reasons.push(`claude-session-subagent-${s.problem}`);
    flags.push(claudeCalls(s.rows, id, book));
  }
  if (flags.some(x => x.foreign)) reasons.push('claude-session-foreign');
  if (flags.some(x => x.unnamed)) reasons.push('claude-session-unnamed');
  // each Task or Agent call of the session keeps its subagent's transcript in the subagents directory
  if (own.children > subs.top) reasons.push('claude-session-subagents-missing');
  return { read: true, reasons, sessions: [id] };
}
// What the sources of one seat showed: { observations, reasons, ties }; an observation is { source, events } of the call file, or of the sessions
// of every exact id the seat names in its client's store, each call once across all of them; ties are the sessions the seat names or read and
// the ids of the calls its store showed. recs are the launch records of the seat name, one per launch.
function seatEvents(t, recs, client, store) {
  const callee = [...new Set(recs.map(r => r.calleeSession).filter(s => typeof s === 'string' && s))];
  const ids = [...new Set([...t.sessionIds, ...callee])];
  const kind = client === 'codex' ? 'codex' : client === 'claude' || t.format === 'claude-result' ? 'claude' : null;
  const workdir = id => { const r = recs.find(x => x.calleeSession === id) || (recs.length === 1 ? recs[0] : null); return r ? r.workdir : undefined; };
  const launches = Math.max(t.launches, recs.length);
  const reasons = []; const observations = [];
  // several launches of one seat name: its sources may hold only some of them
  if (launches > 1) reasons.push('launches');
  // one launch that names two sessions ties neither to the seat: nothing of it counts (the sessions of several launches do)
  const tied = launches > 1 || ids.length <= 1;
  if (!tied) reasons.push('session-id-conflict');
  if (t.problem) reasons.push(`call-file-${t.problem}`);
  if (t.showsTools && tied) observations.push({ source: 'call-file', events: t.observed });
  const ties = tied ? ids.map(id => `session:${id}`) : [];
  let read = 0;
  if (kind && tied) {
    if (!store) reasons.push(`${kind}-session-store-off`);
    else if (!ids.length) reasons.push(`${kind}-no-session-id`);
    else {
      const book = callBook();
      for (const id of ids) {
        if (!SESSION_ID.test(id)) { reasons.push(`${kind}-session-id-malformed`); continue; }
        const s = kind === 'codex' ? codexSession(store.codex(), id, workdir(id), store.io, book) : claudeSession(store.claude(), id, store.io, book);
        reasons.push(...s.reasons);
        if (s.read) { read++; ties.push(...s.sessions.map(x => `session:${x}`)); }
      }
      if (read) { observations.push({ source: `${kind}-session`, events: book.calls() }); ties.push(...book.ids().map(x => `${kind}-call:${x}`)); }
    }
  }
  // without a session read: a call file that shows no tool call is no source of them, and a subagent it started keeps its calls elsewhere
  if (!read && !t.showsTools) reasons.push('call-file-no-tools');
  else if (!read && t.events.some(e => e.child)) reasons.push('call-file-subagents');
  // a name of two possible servers is never counted, and neither is the server of an id that two different calls carry
  for (const o of observations) if (o.events.some(e => e.ambiguous)) reasons.push(`${o.source}-ambiguous-tool-name`);
  for (const o of observations) if (o.events.some(e => e.conflict)) reasons.push(`${o.source}-call-id-conflict`);
  return { observations, reasons: [...new Set(reasons)], ties: [...new Set(ties)] };
}
// the launch records of every seat name, one per launch id (a launch written to the month file and to the day file, or pending and then final,
// is one launch: its last record), in launch order; a file that cannot be read and a line that does not parse are reasons of the run
function launchRecords(files, io, run) {
  const byName = new Map(); let unreadable = 0; let unparsable = 0;
  for (const f of files) {
    let text; try { text = io.readFileSync(f, 'utf8'); } catch { unreadable++; continue; }
    for (const l of text.split(/\r?\n/)) {
      if (!l.trim()) continue;
      let j; try { j = JSON.parse(l); } catch { unparsable++; continue; }
      const m = j && typeof j.launchId === 'string' && /^L-\d{8}T\d{6}Z-(.+)$/.exec(j.launchId);
      if (m) { if (!byName.has(m[1])) byName.set(m[1], new Map()); byName.get(m[1]).set(j.launchId, j); }
    }
  }
  if (unreadable) run.push(`launch-file-unreadable(${unreadable})`);
  if (unparsable) run.push(`launch-record-unparsable(${unparsable})`);
  return new Map([...byName].map(([name, recs]) => [name, [...recs.keys()].sort().map(k => recs.get(k))]));
}
function defaultLaunchFiles(io, run) {
  let rp; try { rp = require('./repo-paths.cjs'); } catch { return []; }
  return [rp.launchesDir(), rp.pendingDir()].flatMap(d => {
    const l = listDir(d, io); if (l.error) run.push(`launch-dir-unreadable(${l.error})`);
    return l.names.filter(n => /^LAUNCHES.*\.jsonl$|^launches-\d{8}\.jsonl$/.test(n)).map(n => path.join(d, n));
  });
}
function metric(opts = {}) {
  const io = opts.io || fs;
  const runtime = opts.runtime || (() => { try { return require('./repo-paths.cjs').runtimeDir(); } catch { return path.resolve('.ai/runtime'); } })();
  if (opts.since && !realDate(opts.since)) throw new Error(`since: ${JSON.stringify(String(opts.since).slice(0, 20))} is not a date that exists (YYYY-MM-DD)`);
  const since = opts.since ? Date.parse(`${opts.since}T00:00:00Z`) : null;
  // the reasons of the run: an input of every seat that could not be read
  const run = [];
  const records = launchRecords(opts.launches && opts.launches.length ? opts.launches : defaultLaunchFiles(io, run), io, run);
  let names = [];
  try { names = io.readdirSync(runtime).filter(n => n.endsWith('-call.txt')); } catch (e) { run.push(`runtime-unreadable(${(e && e.code) || 'error'})`); }
  // the session stores are listed only when a seat needs them, and never with --no-session-store
  const env = opts.env || process.env;
  const codexHome = opts.codexHome || env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const claudeHome = opts.claudeHome || env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  let codexIdx = null; let claudeIdx = null;
  const store = opts.noSessionStore ? null : { io, codex: () => codexIdx || (codexIdx = codexIndex(codexHome, io)), claude: () => claudeIdx || (claudeIdx = claudeIndex(claudeHome, io)) };
  const seats = []; const ties = [];
  for (const n of names.sort()) {
    const file = path.join(runtime, n);
    // a call file that cannot be read is a seat with that reason, never a missing one
    let st = null; try { st = io.statSync(file); } catch { st = null; }
    if (st && since !== null && st.mtimeMs < since) continue;
    const name = n.slice(0, -'-call.txt'.length);
    let text = null; try { text = io.readFileSync(file, 'utf8'); } catch { text = null; }
    const recs = records.get(name) || [];
    const rec = recs.length ? recs[recs.length - 1] : null;
    const client = rec && rec.tuple ? rec.tuple.client : null;
    const t = readTranscript(text === null ? '' : text);
    const got = text === null ? { observations: [], reasons: ['call-file-unreadable'] } : seatEvents(t, recs, client, store);
    // each count is the most calls one source showed (the call file and the session store hold the same calls), with that source: a lower bound;
    // null when no source showed one, never a zero
    const atLeast = { toolEvents: null, qmd: null, cbm: null, semgrep: null }; const from = { toolEvents: null, qmd: null, cbm: null, semgrep: null };
    for (const o of got.observations) { const c = callCounts(o.events); for (const k of Object.keys(atLeast)) if (c[k] > (atLeast[k] || 0)) { atLeast[k] = c[k]; from[k] = o.source; } }
    let offered = 'unknown';
    try { const m = /^SEAT_MCP mode=(kernel|none|user) servers=(\S+)/.exec(io.readFileSync(path.join(runtime, `${name}-seat-mcp.txt`), 'utf8')); if (m) offered = m[1] === 'kernel' ? m[2] : m[1]; } catch { /* a launch before MCP-WIRING */ }
    const tokens = rec && rec.tokens && Number.isFinite(rec.tokens.total) ? rec.tokens.total : null;
    seats.push({ name, client, role: rec ? rec.role || rec.launchRole || null : null, offered, format: t.format, sources: got.observations.map(o => o.source), atLeast, from, reasons: got.reasons, tokens });
    ties.push(got.ties || []);
  }
  const sources = { 'call-file': 0, 'codex-session': 0, 'claude-session': 0 };
  for (const s of seats) for (const src of s.sources) sources[src]++;
  const reasons = {};
  for (const s of seats) for (const x of s.reasons) reasons[x] = (reasons[x] || 0) + 1;
  // seats that name or read one session, or whose store showed one call (a seat that resumes another's session, a seat bound to a child of
  // another's), may show the same calls: they are one group in the totals, and a group counts its largest seat, never the sum
  const up = seats.map((_, i) => i); const find = i => (up[i] === i ? i : (up[i] = find(up[i]))); const first = new Map();
  ties.forEach((keys, i) => { for (const k of keys) { if (first.has(k)) up[find(i)] = find(first.get(k)); else first.set(k, i); } });
  const groups = new Map(); seats.forEach((s, i) => { const g = find(i); if (!groups.has(g)) groups.set(g, []); groups.get(g).push(s); });
  const shared = [...groups.values()].filter(g => g.length > 1).reduce((a, g) => a + g.length, 0);
  if (shared) run.push(`seats-share-sessions(${shared})`);
  // the totals add up what the groups observed: lower bounds, null when no seat observed a call
  const sum = k => [...groups.values()].reduce((a, g) => a + Math.max(...g.map(s => s.atLeast[k] || 0)), 0) || null;
  const count = k => [...groups.values()].filter(g => g.some(s => s.atLeast[k])).length || null;
  const summary = { seats: seats.length, sources, reasons, run, atLeast: { qmdCalls: sum('qmd'), cbmCalls: sum('cbm'), semgrepCalls: sum('semgrep'), qmdSeats: count('qmd'), cbmSeats: count('cbm') },
    offeredSeats: seats.filter(s => !['unknown', 'none', 'user'].includes(s.offered)).length,
    tokensKnown: seats.filter(s => s.tokens !== null).length, tokens: seats.reduce((a, s) => a + (s.tokens || 0), 0), baseline: BASELINE };
  return { runtime, seats, summary };
}
function metricText(r) {
  const s = r.summary;
  // a count is a lower bound with the source that showed it, unknown when no source showed a call: never a zero, never an exact count
  const lowerBound = v => (v ? `>=${v}` : 'unknown');
  const cell = (x, k) => (x.atLeast[k] ? `${lowerBound(x.atLeast[k])} (${x.from[k]})` : lowerBound(null));
  const total = (key, v) => `${key}${v ? lowerBound(v) : `=${lowerBound(v)}`}`;
  const lines = ['mcp-wiring metric (advisory; never Evidence)', 'seat\tclient\toffered\tsources\ttool-events\tqmd\tcodebase-memory\ttokens\treasons'];
  for (const x of r.seats) lines.push([x.name, x.client || '-', x.offered, x.sources.join(',') || '-', cell(x, 'toolEvents'), cell(x, 'qmd'), cell(x, 'cbm'), x.tokens === null ? 'unknown' : x.tokens, x.reasons.join(',') || '-'].join('\t'));
  const a = s.atLeast;
  lines.push(`METRIC seats=${s.seats} offered=${s.offeredSeats} ${total('qmd-seats', a.qmdSeats)} ${total('qmd-calls', a.qmdCalls)} ${total('cbm-seats', a.cbmSeats)} ${total('cbm-calls', a.cbmCalls)} tokens=${s.tokens} tokens-known=${s.tokensKnown}`);
  lines.push(`SOURCES call-file=${s.sources['call-file']} codex-session=${s.sources['codex-session']} claude-session=${s.sources['claude-session']}`);
  lines.push(`REASONS ${Object.keys(s.reasons).sort().map(k => `${k}=${s.reasons[k]}`).join(' ') || 'none'}`);
  lines.push(`RUN-REASONS ${s.run.join(' ') || 'none'}`);
  lines.push('every count is the calls the sources that were read showed, each call once by its id (a replay or a copy is the same call), a lower bound (>=N) with the source it came from; a count no source showed is unknown, never a zero; no seat\'s evidence is taken as whole, so no count and no total is exact; seats that name or read one session count once in the totals, by their largest seat; REASONS names, by seat, each source that could not be read, RUN-REASONS each input of the run and the seats that share a session');
  lines.push(`BASELINE ${s.baseline.date} seats=${s.baseline.seats} ${total('qmd-seats', s.baseline.qmdSeats)} ${total('cbm-seats', s.baseline.cbmSeats)} (no call observed in their call files)`);
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
    else if (a === '--probe-semgrep') o.probeSemgrep = true;
    else if (a === '--codex-home') o.codexHome = take(i++, a); else if (a === '--claude-home') o.claudeHome = take(i++, a); else if (a === '--no-session-store') o.noSessionStore = true;
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
  if (cmd === 'semgrep' && sub === 'apply') { const r = await applySemgrep(o); for (const l of r.lines) out(l); return r.code; }
  if (cmd === 'clients') { const rows = Object.entries(CLIENTS).map(([c, s]) => ({ client: c, file: `~/${s.file}`, format: s.format, container: s.container || 'mcp_servers', applyBy: s.applyBy || 'edit', verify: s.verify, note: s.note || '' })); out(o.json ? JSON.stringify(rows, null, 2) : rows.map(r => `${r.client}\t${r.file}\t${r.format}\t${r.container}\tapply=${r.applyBy}\tverify: ${r.verify}`).join('\n')); return 0; }
  if (cmd === 'doctor') { const r = await doctor(o); out(o.json ? JSON.stringify(r, null, 2) : doctorText(r)); return r.ok ? 0 : 1; }
  if (cmd === 'apply') { const r = apply(o); for (const l of r.lines) out(l); return r.code; }
  if (cmd === 'host' && sub === 'plan') { const st = hostState(path.resolve(o.root || '.')); out(o.json ? JSON.stringify(st, null, 2) : hostPlanText(st)); return 0; }
  if (cmd === 'host' && sub === 'apply') { const r = hostApply(o); for (const l of r.lines) out(l); return r.code; }
  // the MCP call metric is not available in this release: one line, nothing read, no count, exit 0 (the counting code is dormant)
  if (cmd === 'metric') { out(o.json ? JSON.stringify({ available: false, note: METRIC_UNAVAILABLE }) : METRIC_UNAVAILABLE); return 0; }
  out('usage: mcp-wiring.cjs clients|doctor|apply|host plan|host apply|metric (see the header of this file)');
  return 2;
}

async function applySemgrep(opts = {}) {
  const io = opts.io || fs;
  const r = semgrep.resolve({ root: opts.root, env: opts.env || process.env, io });
  const lines = [...r.notes];
  const finish = note => ({ code: 0, lines: [...lines, note] });
  if (!opts.root || !r.descriptor) return finish('SEMGREP_SKIPPED: explicit project selection and local executable required');
  const measured = await (opts.measure || semgrep.probe)(r);
  if (!measured.ok) return finish(`SEMGREP_SKIPPED: ${measured.reason || 'SEMGREP_PROBE_REFUSED'}`);
  if (measured.bytes > semgrep.BYTES || measured.tokens > semgrep.TOKENS) return finish('SEMGREP_BUDGET_REFUSED: optional apply skipped');
  if (measured.version !== semgrep.VERSION || measured.profile !== semgrep.PROFILE || measured.tools !== 3 || measured.provenance !== 'local-cli' || !Number.isInteger(measured.bytes) || measured.bytes < 1 || measured.tokens !== Math.ceil(measured.bytes / 4)) return finish('SEMGREP_MEASUREMENT_REFUSED: optional apply skipped');
  const file = path.resolve(opts.root, '.ai/semgrep-mcp.json');
  const problem = writeTargetProblem(path.resolve(opts.root), file, io);
  if (problem) return finish('SEMGREP_WRITE_REFUSED: unsafe project target');
  const text = seatMcp.claudeConfigText([r.descriptor]);
  try {
    const before = io.readFileSync(file, 'utf8');
    return finish(before === text ? 'SEMGREP_ALREADY_APPLIED' : 'SEMGREP_CONFIG_EXISTS: foreign or changed entry left untouched');
  } catch (e) { if (e.code !== 'ENOENT') return finish('SEMGREP_READ_REFUSED'); }
  if (!opts.apply) return finish('DRY RUN: project .ai/semgrep-mcp.json; nothing written (add --apply)');
  try { io.writeFileSync(file, text, { encoding: 'utf8', flag: 'wx', mode: 0o600 }); return finish('SEMGREP_APPLIED: project .ai/semgrep-mcp.json'); }
  catch { return finish('SEMGREP_WRITE_REFUSED: nothing overwritten'); }
}
module.exports = { CLIENTS, CBMIGNORE, BASELINE, HOOK_MARK, ParseError, parseToml, scanJson, parseConfig, expectedServers, entryOf, registration, doctor, doctorText, planClient, apply, applySemgrep, hostState, hostApply, hostHook, qmdPlan, serverOf, kernelName, toolEvents,
  readTranscript, probeTarget, METRIC_UNAVAILABLE, main,
  // the counting code of the MCP call metric, for its development tests only: no command and no shipped reader calls it in this release
  dormantMetric: Object.freeze({ metric, metricText }) };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, error => { console.error(`mcp-wiring: ${error && error.message}`); process.exitCode = 1; });

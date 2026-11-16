'use strict';
// Restricted stdio endpoint. No prompts, resources, server-initiated requests, or arbitrary method forwarding.
const { spawn, spawnSync } = require('node:child_process');
const profile = require('./semgrep-mcp.cjs');
const MAX_LINE = 1024 * 1024;
function bridge({ child, input = process.stdin, output = process.stdout, root = process.cwd(), timeoutMs = 30000 }) {
  let stopped = false, serial = 0, ready = false;
  const pending = new Map();
  const emit = j => { if (!stopped) output.write(JSON.stringify({ jsonrpc: '2.0', ...j }) + '\n'); };
  const fail = (id, message, code = -32601) => emit({ id, error: { code, message } });
  const stop = () => { if (stopped) return; stopped = true; for (const p of pending.values()) clearTimeout(p.timer); pending.clear(); profile.killTree(child); input.pause(); };
  function forward(request, state) {
    const id = ++serial;
    // A tools/call that runs past the budget fails with the named stall, not a generic
    // timeout: the pinned local server (1.183.0) finishes the scan in seconds but only
    // delivers the JSON-RPC response after it reads the next inbound message, so the
    // endpoint reports the known defect by name and the seat keeps its mandatory tools.
    const timer = setTimeout(() => { pending.delete(id); ready = false; fail(state.id, state.method === 'tools/call'
      ? 'SEMGREP_RESPONSE_STALL: the local server did not deliver the tool response within the budget (known upstream delivery defect of the pinned CLI 1.183.0: a tools response is flushed only when the server reads another inbound message; the scan itself finishes in seconds); optional stays optional and the seat keeps running'
      : 'SEMGREP_TIMEOUT', -32000); stop(); }, timeoutMs);
    pending.set(id, { ...state, timer });
    child.stdin.write(JSON.stringify({ ...request, jsonrpc: '2.0', id }) + '\n');
  }
  function request(j) {
    if (!j || j.jsonrpc !== '2.0' || typeof j.method !== 'string') return;
    if (j.id === undefined) { if (j.method === 'notifications/initialized') child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: j.method }) + '\n'); return; }
    if (!['string', 'number'].includes(typeof j.id)) return;
    const empty = { 'prompts/list': { prompts: [] }, 'resources/list': { resources: [] }, 'resources/templates/list': { resourceTemplates: [] }, ping: {} };
    if (Object.hasOwn(empty, j.method)) return emit({ id: j.id, result: empty[j.method] });
    if (j.method === 'initialize') return forward({ ...j, params: { ...j.params, capabilities: { roots: { listChanged: false } } } }, { id: j.id, method: j.method });
    if (j.method === 'tools/list') {
      ready = false;
      return forward({ method: 'tools/list', params: {} }, { id: j.id, method: j.method, tools: [], cursors: [] });
    }
    if (j.method === 'tools/call' && ready && j.params && profile.TOOLS.includes(j.params.name)) return forward(j, { id: j.id, method: j.method });
    fail(j.id, 'SEMGREP_METHOD_REFUSED: local-v1 tools only; list the validated catalog before calling');
  }
  function response(j) {
    // Never forward elicitation, resource updates, log messages or unsolicited server data.
    if (!j) return;
    if (j.method) {
      if (j.id !== undefined) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: j.id, ...(j.method === 'roots/list'
        ? { result: { roots: [{ uri: require('node:url').pathToFileURL(root).href, name: 'selected-project' }] } }
        : { error: { code: -32601, message: 'SEMGREP_METHOD_REFUSED' } }) }) + '\n');
      return;
    }
    if (!pending.has(j.id)) return;
    const p = pending.get(j.id); pending.delete(j.id); clearTimeout(p.timer);
    if (j.error || !j.result || typeof j.result !== 'object') { ready = false; return fail(p.id, 'SEMGREP_SERVER_ERROR', -32000); }
    if (p.method === 'initialize') return emit({ id: p.id, result: { protocolVersion: j.result.protocolVersion, serverInfo: { name: 'semgrep-local-v1', version: profile.VERSION }, capabilities: { tools: {} } } });
    if (p.method === 'tools/list') {
      const r = j.result;
      if (!Array.isArray(r.tools)) return fail(p.id, 'SEMGREP_TOOLS_REFUSED', -32000);
      p.tools.push(...r.tools);
      if (p.tools.length > profile.TOOLS.length || r.tools.some(t => !t || !profile.TOOLS.includes(t.name))) return fail(p.id, 'SEMGREP_TOOLS_REFUSED', -32000);
      if (r.nextCursor !== undefined) {
        if (typeof r.nextCursor !== 'string' || p.cursors.includes(r.nextCursor) || p.cursors.length >= 10) return fail(p.id, 'SEMGREP_CURSOR_REFUSED', -32000);
        p.cursors.push(r.nextCursor);
        return forward({ method: 'tools/list', params: { cursor: r.nextCursor } }, p);
      }
      const problem = profile.toolsProblem(p.tools);
      if (problem) return fail(p.id, problem, -32000);
      ready = true;
      return emit({ id: p.id, result: { tools: p.tools } });
    }
    emit({ id: p.id, result: j.result });
  }
  function lines(stream, accept) {
    let buffer = '';
    stream.setEncoding('utf8');
    stream.on('data', chunk => {
      if (stopped) return;
      buffer += chunk;
      if (Buffer.byteLength(buffer, 'utf8') > MAX_LINE) { ready = false; stop(); return; }
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        if (!line.trim()) continue;
        try { accept(JSON.parse(line)); } catch { ready = false; stop(); break; }
      }
    });
  }
  lines(input, request); lines(child.stdout, response);
  child.stderr.resume();
  child.on('error', () => { for (const p of pending.values()) fail(p.id, 'SEMGREP_PROCESS_ERROR', -32000); stop(); });
  child.on('exit', () => { for (const p of pending.values()) fail(p.id, 'SEMGREP_PROCESS_EXIT', -32000); stop(); });
  child.stdin.on('error', stop); input.on('end', stop); input.on('error', stop); output.on('error', stop);
  return stop;
}
function main(argv, deps = {}) {
  if (argv.length !== 4 || argv[0] !== '--bin' || argv[2] !== '--root') throw new Error('SEMGREP_ARGUMENTS_REFUSED');
  const fs = require('node:fs'), path = require('node:path');
  const bin = profile.binary({ COLABUS_SEMGREP_BIN: argv[1] });
  if (!bin || !path.isAbsolute(argv[3]) || !fs.statSync(argv[3]).isDirectory()) throw new Error('SEMGREP_PATH_REFUSED');
  const env = profile.childEnv();
  const check = (deps.spawnSync || spawnSync)(bin, ['--version'], { shell: false, cwd: argv[3], env, encoding: 'utf8', timeout: 10000, maxBuffer: 65536, windowsHide: true });
  if (check.status !== 0 || String(check.stdout).trim() !== profile.VERSION) throw new Error('SEMGREP_VERSION_REFUSED');
  const child = (deps.spawn || spawn)(bin, ['mcp', '--transport', 'stdio'], { shell: false, cwd: argv[3], env, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  return bridge({ child, root: argv[3] });
}
module.exports = { bridge, main };
if (require.main === module) { try { main(process.argv.slice(2)); } catch { process.stderr.write('SEMGREP_START_REFUSED: verify local CLI 1.183.0 and project path\n'); process.exitCode = 1; } }

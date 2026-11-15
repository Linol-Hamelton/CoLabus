'use strict';
// Optional, project-scoped Semgrep (PROTO-DEC-0254). Resolution never spawns or installs.
const fs = require('node:fs');
const path = require('node:path');
const VERSION = '1.183.0';
const PROFILE = 'local-v1';
const BYTES = 3251;
const TOKENS = 813;
const TOOLS = Object.freeze(['get_supported_languages', 'semgrep_scan_with_custom_rule', 'get_abstract_syntax_tree']);
const ENV = Object.freeze({ PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8', SEMGREP_SEND_METRICS: 'off', SEMGREP_ENABLE_VERSION_CHECK: '0', SEMGREP_MCP_DISABLE_TRACING: 'true',
  SEMGREP_RULE_SCHEMA_DISABLED: 'true', SEMGREP_FINDINGS_DISABLED: 'true', SEMGREP_SCAN_DISABLED: 'true',
  SEMGREP_SCAN_REMOTE_DISABLED: 'true', SEMGREP_SCAN_SUPPLY_CHAIN_DISABLED: 'true',
  GET_SUPPORTED_LANGUAGES_DISABLED: 'false', SEMGREP_SCAN_WITH_CUSTOM_RULE_DISABLED: 'false',
  GET_ABSTRACT_SYNTAX_TREE_DISABLED: 'false', SEMGREP_FINDINGS_ELICITATION_ENABLED: 'false' });
const RESTRICTION = 'SEMGREP_LOCAL_ONLY: do not call setup_semgrep_mcp, write_custom_semgrep_rule, semgrep:// resources or semgrep login; the seat filter refuses them.';
const unsafe = /[&|<>^%!"'`\r\n\t]/;
const slash = p => p.replace(/\\/g, '/');
function binary(env, io = fs) {
  const candidates = env.COLABUS_SEMGREP_BIN !== undefined ? [env.COLABUS_SEMGREP_BIN] :
    String(env.PATH || env.Path || '').split(path.delimiter).filter(Boolean).map(d => path.join(d, process.platform === 'win32' ? 'semgrep.exe' : 'semgrep'));
  for (const p of candidates) {
    if (typeof p !== 'string' || !path.isAbsolute(p) || unsafe.test(p) || (process.platform === 'win32' && !/\.exe$/i.test(p))) continue;
    try { if (io.statSync(p).isFile()) return path.resolve(p); } catch { /* next */ }
  }
  return null;
}
function selection(root, io = fs) {
  if (!root) return { state: 'disabled', notes: [] };
  const file = path.resolve(root, '.ai/mcp-optional.json');
  try {
    // A project selection cannot be redirected to another project through a junction/link.
    const st = io.lstatSync(file);
    const rel = path.relative(io.realpathSync(root), io.realpathSync(file));
    if (st.isSymbolicLink() || st.nlink > 1 || rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('unsafe selection');
    const j = JSON.parse(io.readFileSync(file, 'utf8'));
    if (j.schema !== 'optional-mcp/1' || !j.semgrep || typeof j.semgrep.enabled !== 'boolean') throw new Error('schema');
    if (!j.semgrep.enabled) return { state: 'disabled', notes: [] };
    const s = j.semgrep;
    if (s.profile !== PROFILE) return { state: 'disabled', notes: ['SEMGREP_PROFILE_REFUSED: only local-v1 is permitted'] };
    if (s.version !== VERSION) return { state: 'disabled', notes: ['SEMGREP_VERSION_REFUSED: expected CLI 1.183.0'] };
    if (s.schemaBytes !== BYTES || s.schemaTokensEstimate !== TOKENS)
      return { state: 'disabled', notes: ['SEMGREP_BUDGET_REFUSED: measured local-v1 budget is 3251 bytes / 813 estimated tokens'] };
    return { state: 'selected', notes: [], selection: s };
  } catch (e) {
    return e.code === 'ENOENT' ? { state: 'disabled', notes: [] } : { state: 'disabled', notes: ['SEMGREP_SELECTION_REFUSED: invalid or unsafe project selection'] };
  }
}
function resolve({ root, env = process.env, io = fs, execPath = process.execPath } = {}) {
  const picked = selection(root, io);
  if (picked.state !== 'selected') return picked;
  const bin = binary(env, io);
  if (!bin) return { ...picked, state: 'not-installed', notes: ['SEMGREP_BINARY_REFUSED: set COLABUS_SEMGREP_BIN to the absolute local CLI executable'] };
  const wrapper = path.join(__dirname, 'semgrep-seat-server.cjs');
  if (!path.isAbsolute(execPath) || unsafe.test(execPath) || unsafe.test(wrapper) || unsafe.test(path.resolve(root)))
    return { state: 'disabled', notes: ['SEMGREP_PATH_REFUSED: unsafe launcher or project path'] };
  return { ...picked, state: 'unverified-version', bin, descriptor: { name: 'semgrep', transport: 'stdio', command: slash(execPath),
    args: [slash(wrapper), '--bin', slash(bin), '--root', slash(path.resolve(root))], env: { ...ENV } } };
}
function toolsProblem(tools, budget = BYTES) {
  if (!Array.isArray(tools) || tools.length !== TOOLS.length || new Set(tools.map(t => t && t.name)).size !== TOOLS.length || tools.some(t => !t || !TOOLS.includes(t.name))) return 'SEMGREP_TOOLS_REFUSED';
  const bytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
  return bytes > Math.min(BYTES, budget) || Math.ceil(bytes / 4) > TOKENS ? 'SEMGREP_BUDGET_REFUSED' : null;
}
// Child receives only OS/Python runtime necessities, never the parent's API/OAuth credentials.
function childEnv(env = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(env)) if (/^(PATH|PATHEXT|SYSTEMROOT|WINDIR|COMSPEC|TEMP|TMP|TMPDIR|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|VIRTUAL_ENV|LANG|LC_ALL)$/i.test(k)) out[k] = v;
  return { ...out, ...ENV };
}
function killTree(child) {
  if (child?.exitCode !== null && child?.exitCode !== undefined) return;
  if (!child || !child.pid) { try { child?.kill(); } catch { /* gone */ } return; }
  try {
    if (process.platform === 'win32') {
      const systemRoot = process.env.SystemRoot || process.env.WINDIR;
      if (!systemRoot || !path.isAbsolute(systemRoot)) { child.kill(); return; }
      require('node:child_process').spawnSync(path.join(systemRoot, 'System32/taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { shell: false, stdio: 'ignore', timeout: 5000, windowsHide: true });
    }
    else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
  } catch { try { child.kill(); } catch { /* gone */ } }
}
function probe(resolved, timeoutMs = 30000) {
  if (!resolved.descriptor) return Promise.resolve({ ok: false, reason: 'SEMGREP_NOT_SELECTED' });
  return new Promise(resolveResult => {
    const s = resolved.descriptor;
    const child = require('node:child_process').spawn(s.command, s.args, { cwd: s.args.at(-1), env: { ...childEnv(), ...s.env }, shell: false, detached: process.platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let done = false, buffer = '';
    const finish = r => { if (done) return; done = true; clearTimeout(timer); child.stdin.end(); setTimeout(() => killTree(child), 200); resolveResult(r); };
    const timer = setTimeout(() => finish({ ok: false, reason: 'SEMGREP_TIMEOUT' }), timeoutMs);
    const send = j => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...j }) + '\n');
    child.on('error', () => finish({ ok: false, reason: 'SEMGREP_PROCESS_ERROR' }));
    child.on('exit', () => finish({ ok: false, reason: 'SEMGREP_PROCESS_EXIT' }));
    child.stdin.on('error', () => finish({ ok: false, reason: 'SEMGREP_PROCESS_ERROR' }));
    child.stderr.resume(); child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      buffer += chunk;
      if (buffer.length > 1024 * 1024) return finish({ ok: false, reason: 'SEMGREP_RESPONSE_TOO_LARGE' });
      for (;;) {
        const end = buffer.indexOf('\n'); if (end < 0) break;
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let j; try { j = JSON.parse(line); } catch { return finish({ ok: false, reason: 'SEMGREP_INVALID_JSON' }); }
        if (j.error) return finish({ ok: false, reason: /^SEMGREP_[A-Z_]+/.exec(j.error.message || '')?.[0] || 'SEMGREP_PROBE_REFUSED' });
        if (j.id === 1 && j.result) { send({ method: 'notifications/initialized' }); send({ id: 2, method: 'tools/list' }); }
        if (j.id === 2 && j.result) {
          const tools = j.result.tools;
          const problem = toolsProblem(tools);
          if (problem) return finish({ ok: false, reason: problem });
          const bytes = Buffer.byteLength(JSON.stringify(tools), 'utf8');
          return finish({ ok: true, version: VERSION, profile: PROFILE, tools: tools.length, bytes, tokens: Math.ceil(bytes / 4), provenance: 'local-cli' });
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'colabus-semgrep-probe', version: '1' } } });
  });
}
module.exports = { VERSION, PROFILE, BYTES, TOKENS, TOOLS, ENV, RESTRICTION, binary, selection, resolve, toolsProblem, childEnv, killTree, probe };

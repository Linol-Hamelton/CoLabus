'use strict';
// Bounded, explicitly requested local inputs for the sealed opencode route.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { isProtectedPath } = require('../../.ai/bin/lib/protected-paths.cjs');
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');

const MODEL = 'minimax/MiniMax-M3';
const MAX_FILES = 32;
const MAX_FILE = 2 * 1024 * 1024;
const MAX_TOTAL = 8 * 1024 * 1024;
const fail = reason => { throw new Error(`OPENCODE_INPUTS_REFUSED ${reason}`); };
const slash = p => p.replace(/\\/g, '/');
function localPath(p) {
  if (typeof p !== 'string' || !p || /[\x00-\x1f*?<>|]/.test(p) || /^[/\\]{2}/.test(p)
      || isProtectedPath(p, { mode: 'segment' }) || p.toLowerCase().includes(os.hostname().toLowerCase()) || p.includes('://')) fail('local-path-required');
  // A colon is legal only as the drive designator, never an alternate stream.
  if (p.replace(/^[A-Za-z]:/, '').includes(':')) fail('alternate-stream');
  return p;
}
function plainPath(file, io = fs) {
  localPath(file);
  const absolute = path.resolve(file);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const st = io.lstatSync(current);
    if (st.isSymbolicLink()) fail('link');
  }
  return absolute;
}
function readFile(file, limit, io = fs) {
  const full = plainPath(file, io);
  const before = io.lstatSync(full);
  if (!before.isFile() || before.nlink !== 1 || before.size > limit) fail('file-type-or-size');
  const fd = io.openSync(full, 'r');
  try {
    const st = io.fstatSync(fd);
    if (!st.isFile() || st.nlink !== 1 || st.size > limit || st.ino !== before.ino || st.dev !== before.dev) fail('file-changed');
    const data = Buffer.alloc(st.size + 1);
    let count = 0;
    while (count < data.length) {
      const n = io.readSync(fd, data, count, data.length - count, count);
      if (!n) break;
      count += n;
    }
    const after = io.fstatSync(fd);
    plainPath(full, io);
    const named = io.lstatSync(full);
    if (count !== st.size || after.size !== st.size || after.mtimeMs !== st.mtimeMs
        || after.ctimeMs !== st.ctimeMs || named.ino !== st.ino || named.dev !== st.dev || named.nlink !== 1) fail('file-changed');
    return data.subarray(0, count);
  } finally { io.closeSync(fd); }
}
function text(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
  catch { fail('utf8-required'); }
}
function exactKeys(o, keys) {
  return o && typeof o === 'object' && !Array.isArray(o)
    && Object.keys(o).sort().join(',') === keys.sort().join(',');
}
function plan(o, io = fs) {
  if (o.client !== 'opencode') {
    if (o.opencodeInputs) fail('wrong-client');
    return null;
  }
  if (o.model !== MODEL || o.launchRole !== 'certifier' || !o.expectReport || o.chain) fail('sealed-minimax-certifier-required');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(o.name)) fail('name');
  const worktree = plainPath(path.resolve(localPath(o.worktree)), io);
  if (!io.lstatSync(worktree).isDirectory()) fail('worktree');
  const resolve = p => path.resolve(worktree, localPath(p));
  if (!o.opencodeInputs) fail('request-required');
  const request = JSON.parse(text(readFile(resolve(o.opencodeInputs), 65536, io)));
  if (!exactKeys(request, ['version', 'files', 'ownerConfirmation']) || request.version !== 1
      || !Array.isArray(request.files) || request.files.length > MAX_FILES) fail('request-schema');
  const names = new Set(['cert-prompt.md', 'inputs.json', 'tmp', 'config']);
  let total = 0;
  const files = request.files.map(row => {
    if (!exactKeys(row, ['source', 'name']) || typeof row.name !== 'string'
        || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(row.name)
        || /[.]$/.test(row.name) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(row.name)
        || names.has(row.name.toLowerCase())) fail('input-name');
    names.add(row.name.toLowerCase());
    const bytes = readFile(resolve(row.source), MAX_FILE, io);
    total += bytes.length;
    if (total > MAX_TOTAL) fail('total-size');
    return { name: row.name, source: row.source, bytes, sha256: createHash('sha256').update(bytes).digest('hex') };
  });
  if (typeof request.ownerConfirmation !== 'string' || !files.some(f => f.name === request.ownerConfirmation)) fail('owner-confirmation-required');
  const bytes = readFile(resolve(o.promptFile), MAX_FILE, io);
  total += bytes.length;
  if (total > MAX_TOTAL) fail('total-size');
  const rel = `.ai/runtime/mmx-inputs/${o.name}`;
  let prompt = text(bytes);
  for (const f of [...files].sort((a, b) => b.source.length - a.source.length)) {
    // The header remains authoritative for alternative source-path spellings.
    if (!path.isAbsolute(f.source) && !/[/\\]/.test(f.source)) continue;
    const replacement = `${rel}/${f.name}`;
    const count = prompt.split(f.source).length - 1;
    if (Buffer.byteLength(prompt) + count * (Buffer.byteLength(replacement) - Buffer.byteLength(f.source)) > MAX_FILE) fail('rendered-prompt-size');
    prompt = prompt.split(f.source).join(replacement);
    const normalized = slash(f.source), normalizedCount = prompt.split(normalized).length - 1;
    if (Buffer.byteLength(prompt) + normalizedCount * (Buffer.byteLength(replacement) - Buffer.byteLength(normalized)) > MAX_FILE) fail('rendered-prompt-size');
    prompt = prompt.split(slash(f.source)).join(`${rel}/${f.name}`);
  }
  const mapping = files.map(f => `${JSON.stringify(f.source)} => ${rel}/${f.name}`).join('\n');
  prompt = `# Sealed certification inputs\n\nWork only inside this worktree. Use relative paths. No MCP. Never request external directories.\nRead owner confirmation ${rel}/${request.ownerConfirmation}.\nDeclared inputs (use the local copy even when the task spells the source differently):\n${mapping}\n\n${prompt}`;
  const renderedBytes = Buffer.byteLength(prompt);
  if (renderedBytes > MAX_FILE || total - bytes.length + renderedBytes > MAX_TOTAL) fail('rendered-prompt-size');
  return { worktree, rel, files, prompt };
}
function prepare(p, io = fs) {
  plainPath(p.worktree, io);
  let parent = p.worktree;
  for (const part of ['.ai', 'runtime', 'mmx-inputs']) {
    parent = path.join(parent, part);
    try { io.mkdirSync(parent); } catch (e) { if (e.code !== 'EEXIST') throw e; }
    plainPath(parent, io);
    if (!io.lstatSync(parent).isDirectory()) fail('staging-parent');
  }
  const dir = path.join(p.worktree, ...p.rel.split('/')), promptFile = `${p.rel}/CERT-PROMPT.md`;
  io.mkdirSync(dir); // Exclusive: a reused launch never consumes an earlier prompt.
  const write = (name, data) => {
    plainPath(dir, io);
    io.writeFileSync(path.join(dir, name), data, { flag: 'wx', mode: 0o600 });
  };
  for (const f of p.files) write(f.name, f.bytes);
  write(path.basename(promptFile), p.prompt);
  write('inputs.json', `${JSON.stringify({ version: 1, files: p.files.map(({ name, sha256, bytes }) => ({ name, sha256, size: bytes.length })) }, null, 2)}\n`);
  io.mkdirSync(path.join(dir, 'tmp'));
  io.mkdirSync(path.join(dir, 'config'));
  return { promptFile, dir, temp: path.join(dir, 'tmp'), config: path.join(dir, 'config'), executable: p.executable };
}
function preflight(o, io, deps = {}) {
  const p = plan(o, io);
  if (!p) return null;
  const env = deps.env || process.env, platform = deps.platform || process.platform;
  const resolver = deps.resolveClient || require('./lib/client-path.cjs').resolveClient;
  const found = resolver('opencode', { env, platform, cwd: o.worktree, refuseInside: [o.worktree, deps.runtimeDir].filter(Boolean) });
  if (!found?.ok || typeof found.path !== 'string' || !path.isAbsolute(found.path)) fail('executable-unavailable');
  let command = found.path, prefix = [];
  if (platform === 'win32' && /\.(cmd|bat)$/i.test(found.path)) {
    if (/[\s&()^%!"<>|;,=]/.test(found.path)) fail('executable-path-unsafe');
    const rootKey = Object.keys(env).find(k => k.toLowerCase() === 'systemroot');
    const root = rootKey && env[rootKey];
    if (typeof root !== 'string' || !/^[A-Za-z]:[/\\]/.test(root)) fail('shell-unavailable');
    command = path.join(root, 'System32', 'cmd.exe'); prefix = ['/d', '/c', found.path];
  }
  p.executable = { command, prefix };
  return p;
}
function buildInvocation(o, argText, env) {
  const stage = o.opencodeStage;
  if (o.model !== MODEL || !stage?.executable) fail('stage-required');
  // Config stays per-launch. Authentication remains in the client's data store.
  // The CLI reads its inline config after the private config directory.
  // Accept provider definitions explicitly supplied by the caller without reading
  // its credential files or importing its MCP, plugins or permission settings.
  let supplied;
  try { supplied = JSON.parse(env.OPENCODE_CONFIG_CONTENT || '{}'); } catch { fail('provider-config-json'); }
  if (!supplied || typeof supplied !== 'object' || Array.isArray(supplied)
      || (supplied.provider !== undefined && (!supplied.provider || typeof supplied.provider !== 'object' || Array.isArray(supplied.provider)))) fail('provider-config-schema');
  const childEnv = { ...env, TEMP: stage.temp, TMP: stage.temp, TMPDIR: stage.temp,
    XDG_CONFIG_HOME: stage.config, OPENCODE_CONFIG_DIR: stage.config,
    OPENCODE_DISABLE_PROJECT_CONFIG: 'true', OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
    OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...(supplied.provider ? { provider: supplied.provider } : {}), permission: { external_directory: 'deny', question: 'deny' } }) };
  delete childEnv.OPENCODE_CONFIG;
  const instruction = `Read ${stage.promptFile} and execute it exactly. Work only inside this worktree; use the declared local copies. Never use MCP, pause or schedule a wakeup. ${argText}`;
  return { command: stage.executable.command, args: [...stage.executable.prefix, 'run', '-m', MODEL, '--format', 'json', instruction],
    spawnOptions: { cwd: o.worktree, encoding: 'buffer', env: childEnv, maxBuffer: 536870912, stdio: ['ignore', 'pipe', 'pipe'], timeout: require('../../.ai/bin/lib/opencode-route.cjs').SEAT_TIMEOUT_MS, killSignal: 'SIGKILL' }, argText: instruction };
}
module.exports = { MODEL, MAX_FILES, MAX_FILE, MAX_TOTAL, plan, preflight, prepare, buildInvocation };

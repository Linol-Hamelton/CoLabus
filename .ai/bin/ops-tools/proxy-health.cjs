'use strict';
// Endpoint availability only. No credentials, redirects, inference or client configuration.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const safe = require('../lib/path-safe.cjs');
const realPath = require('../lib/real-path.cjs');
const DEFAULTS = Object.freeze({ host: '127.0.0.1', port: 8317, path: '/v1/models', timeoutMs: 3000, staleMs: 90000, tickMs: 60000, stableUpTicks: 2, maxContinuations: 3 });
const REASONS = new Set(['HTTP_OK', 'HTTP_AUTH', 'HTTP_REDIRECT', 'HTTP_NOT_FOUND', 'HTTP_RATE_LIMIT', 'HTTP_5XX', 'HTTP_STATUS', 'INVALID_BODY', 'OVERSIZE', 'EOF', 'TIMEOUT', 'CONN_REFUSED', 'CONN_RESET', 'INVALID_HTTP']);
const fail = code => { throw new Error(code); };
function config(given = {}) {
  const c = { ...DEFAULTS, ...given };
  if (Object.keys(c).some(k => !(k in DEFAULTS)) || !['127.0.0.1', '::1'].includes(c.host) || c.path !== '/v1/models') fail('PROXY_CONFIG');
  for (const k of ['port', 'timeoutMs', 'staleMs', 'tickMs', 'stableUpTicks', 'maxContinuations']) if (!Number.isSafeInteger(c[k]) || c[k] < 1) fail('PROXY_CONFIG');
  if (c.port > 65535 || c.timeoutMs > 30000 || c.tickMs < 60000 || c.stableUpTicks < 2 || c.maxContinuations > 3) fail('PROXY_CONFIG');
  return c;
}
const endpoint = c => `http://${c.host === '::1' ? '[::1]' : c.host}:${c.port}${c.path}`;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const canonical = p => { const r = realPath.realPathSync(p); return process.platform === 'win32' ? r.toLowerCase() : r; };
function ensureDirectory(dir) {
  dir = path.resolve(dir);
  if (fs.existsSync(dir)) { const r = safe.realInside(path.parse(dir).root, dir, { allowRoot: true }); if (!r.ok || r.type !== 'dir') fail('PROXY_RUNTIME'); return dir; }
  const parent = ensureDirectory(path.dirname(dir));
  if (!safe.mkdirGuarded(parent, dir).ok) fail('PROXY_RUNTIME'); return dir;
}
function route(input = {}) {
  if (input.client !== 'cline') return { client: input.client, provider: null, model: input.model || null };
  const found = {};
  const args = input.argv || [];
  for (let i = 0; i < args.length; i++) {
    const m = /^(?:-P|--provider|-m|--model)(?:=(.*))?$/.exec(args[i]);
    if (!m) continue;
    const key = /^(?:-P|--provider)/.test(args[i]) ? 'provider' : 'model';
    const v = m[1] === undefined ? args[++i] : m[1];
    if (found[key] !== undefined || typeof v !== 'string' || !v || v.startsWith('-') || !/^[\x21-\x7e]+$/.test(v)) fail('PROXY_ROUTE');
    found[key] = v;
  }
  for (const key of ['provider', 'model']) if (input[key] !== undefined && input[key] !== null) {
    if (found[key] !== undefined && found[key] !== input[key]) fail('PROXY_ROUTE');
    found[key] = input[key];
  }
  return { client: 'cline', provider: found.provider || null, model: found.model || null };
}
const needsLocalProxy = input => { const r = route(input); return r.client === 'cline' && r.provider !== 'cline'; };
function probe(given = {}) {
  const c = config(given);
  return new Promise(resolve => {
    let done = false; let response; let req;
    const finish = reason => {
      if (done) return; done = true; clearTimeout(timer);
      if (response) response.destroy(); if (req) req.destroy();
      resolve({ state: ['HTTP_OK', 'HTTP_AUTH'].includes(reason) ? 'up' : 'down', reason });
    };
    const timer = setTimeout(() => finish('TIMEOUT'), c.timeoutMs);
    req = http.get({ hostname: c.host, port: c.port, path: c.path, agent: false, headers: { Connection: 'close' } }, res => {
      response = res; let size = 0; const chunks = [];
      res.on('data', chunk => { size += chunk.length; if (size > 16384) finish('OVERSIZE'); else chunks.push(chunk); });
      res.on('aborted', () => finish('EOF'));
      res.on('error', () => finish('EOF'));
      res.on('close', () => { if (!res.complete) finish('EOF'); });
      res.on('end', () => {
        const s = res.statusCode;
        if (s >= 500) return finish('HTTP_5XX');
        if (s >= 300 && s < 400) return finish('HTTP_REDIRECT');
        if (s === 404) return finish('HTTP_NOT_FOUND');
        if (s === 429) return finish('HTTP_RATE_LIMIT');
        if (![200, 401, 403].includes(s)) return finish('HTTP_STATUS');
        try { const b = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!b || typeof b !== 'object' || Array.isArray(b) || (s === 200 && !Array.isArray(b.data))) return finish('INVALID_BODY'); } catch { return finish('INVALID_BODY'); }
        finish(s === 200 ? 'HTTP_OK' : 'HTTP_AUTH');
      });
    });
    req.on('error', e => finish(({ ECONNREFUSED: 'CONN_REFUSED', ECONNRESET: 'EOF', ETIMEDOUT: 'TIMEOUT' })[e.code] || 'INVALID_HTTP'));
  });
}
function readJson(root, file) {
  const r = safe.readFileGuarded(root, file, { maxBytes: 262144 });
  if (!r.ok) return null;
  try { return JSON.parse(r.bytes.toString('utf8')); } catch { return null; }
}
function write(root, file, value) {
  const r = safe.writeAtomicGuarded(file, Buffer.from(`${JSON.stringify(value)}\n`), { root });
  if (!r.ok) fail(`PROXY_WRITE_${r.reason}`);
}
// No lock stealing: a crash leaves an explicit unknown reservation for operator recovery.
function lock(root, name) {
  const file = path.join(root, name);
  const r = safe.realInside(root, file, { refuseHardlinks: true });
  if (!r.ok || r.exists) fail('PROXY_LOCKED');
  let fd;
  try { fd = fs.openSync(file, 'wx'); } catch (e) { if (e.code === 'EEXIST') fail('PROXY_LOCKED'); throw e; }
  fs.closeSync(fd);
  return () => fs.unlinkSync(file);
}
const STATE_KEYS = 'schema,endpoint,state,reason,checkedAt,lastUpAt,lastDownAt,dropId,generation,consecutiveOk,consecutiveFailures,stableTicks,lastTickAt'.split(',');
function validState(s, c) {
  return s && Object.keys(s).length === STATE_KEYS.length && STATE_KEYS.every(k => Object.hasOwn(s, k)) && s.schema === 'proxy-health/1'
    && s.endpoint === endpoint(c) && ['up', 'down'].includes(s.state) && REASONS.has(s.reason)
    && (s.state === 'up') === ['HTTP_OK', 'HTTP_AUTH'].includes(s.reason)
    && ['checkedAt', 'dropId', 'generation', 'consecutiveOk', 'consecutiveFailures', 'stableTicks', 'lastTickAt'].every(k => Number.isSafeInteger(s[k]) && s[k] >= 0)
    && s.lastTickAt <= s.checkedAt
    && s.stableTicks <= s.consecutiveOk
    && ['lastUpAt', 'lastDownAt'].every(k => s[k] === null || (Number.isSafeInteger(s[k]) && s[k] <= s.checkedAt));
}
function readState(options = {}) {
  const c = config(options.config); const now = (options.now || Date.now)();
  const s = readJson(options.runtimeDir, path.join(options.runtimeDir, 'proxy-health.json'));
  return validState(s, c) && s.checkedAt <= now && now - s.checkedAt <= c.staleMs ? s : null;
}
const available = (s, c, now) => Boolean(s && validState(s, c) && s.state === 'up' && s.stableTicks >= c.stableUpTicks && s.checkedAt <= now && now - s.checkedAt <= c.staleMs && now - s.lastTickAt <= c.tickMs + c.staleMs);
async function refresh(options) {
  const c = config(options.config); const root = options.runtimeDir;
  ensureDirectory(root);
  const release = lock(root, 'proxy-health.lock');
  try {
    const file = path.join(root, 'proxy-health.json');
    const prev = readJson(root, file);
    if (fs.existsSync(file) && !validState(prev, c)) fail('PROXY_CACHE_INVALID');
    const result = await (options.probe || probe)(c); const now = (options.now || Date.now)();
    if (!REASONS.has(result.reason) || (result.state === 'up') !== ['HTTP_OK', 'HTTP_AUTH'].includes(result.reason)) fail('PROXY_PROBE_INVALID');
    if (prev && now < prev.checkedAt) fail('PROXY_CLOCK');
    const up = result.state === 'up';
    const spaced = options.tick && (!prev || now - prev.lastTickAt >= c.tickMs);
    const s = { schema: 'proxy-health/1', endpoint: endpoint(c), ...result, checkedAt: now,
      lastUpAt: up ? now : prev && prev.lastUpAt || null, lastDownAt: up ? prev && prev.lastDownAt || null : now,
      dropId: (prev ? prev.dropId : 0) + (!up && (!prev || prev.state === 'up') ? 1 : 0), generation: (prev ? prev.generation : 0) + 1,
      consecutiveOk: up ? (prev ? prev.consecutiveOk : 0) + 1 : 0, consecutiveFailures: up ? 0 : (prev ? prev.consecutiveFailures : 0) + 1,
      stableTicks: up ? (prev && prev.state === 'up' && now - prev.lastTickAt <= c.tickMs + c.staleMs ? prev.stableTicks : 0) + (spaced ? 1 : 0) : 0,
      lastTickAt: spaced ? now : prev ? prev.lastTickAt : 0 };
    write(root, file, s);
    if (!prev || prev.state !== s.state) {
      const log = path.join(root, 'proxy-health.jsonl');
      const old = fs.existsSync(log) ? safe.readFileGuarded(root, log, { maxBytes: 1048576 }) : { ok: true, bytes: Buffer.alloc(0) };
      if (!old.ok) fail('PROXY_LOG_INVALID');
      const written = safe.writeAtomicGuarded(log, Buffer.concat([old.bytes, Buffer.from(`${JSON.stringify(s)}\n`)]), { root });
      if (!written.ok) fail('PROXY_LOG_WRITE');
    }
    return s;
  } finally { release(); }
}
async function waitForProxy(options) {
  if (!needsLocalProxy(options)) return { ok: true, applied: false };
  const c = config(options.config); const now = options.now || Date.now; const start = now();
  const waitMs = options.waitMs === undefined ? 2700000 : options.waitMs;
  if (!Number.isFinite(waitMs) || waitMs < 0) fail('PROXY_WAIT_INVALID');
  let announced = false;
  for (;;) {
    let s = readState(options); let refreshReason = null;
    if (!s) {
      try { s = await refresh(options); } catch (e) {
        // Contention is unknown health: wait for the current writer, without
        // stealing its lock. Permanent state/I/O errors fail closed by cause.
        refreshReason = /^PROXY_[A-Za-z0-9_-]+$/.test(e.message) ? e.message : 'PROXY_REFRESH_FAILED';
        if (refreshReason !== 'PROXY_LOCKED') return { ok: false, reason: refreshReason, state: null };
      }
    }
    if (available(s, c, now())) return { ok: true, applied: true, state: s };
    if (!announced && options.onWait) { options.onWait(`PROXY PAUSED endpoint=${endpoint(c)} dropId=${s ? s.dropId : 'unknown'} reason=${refreshReason || s.reason}`); announced = true; }
    const remaining = waitMs - (now() - start);
    if (remaining <= 0) return { ok: false, reason: refreshReason || (waitMs === 0 ? 'PROXY_DOWN' : 'PROXY_DOWN_TIMEOUT'), state: s };
    await (options.sleep || (ms => new Promise(r => setTimeout(r, ms))))(Math.min(options.pollMs || 20000, remaining));
  }
}
function tracker(marker, attempt, url) {
  let carry = ''; let discard = false;
  // Agent prompts use underscores; cert-launch preserves dots and dashes and
  // prints a structured exit summary instead of forwarding captured output.
  const markers = [...new Set([marker, marker.replace(/[^A-Z0-9_]/g, '_')])];
  const t = { final: false, signal: null, endpoint: url, push(chunk) {
    const lines = (carry + String(chunk)).split('\n'); carry = lines.pop();
    for (const raw of lines) {
      const line = raw.replace(/\r$/, '');
      if (!discard && markers.some(m => line.startsWith(m) && /^(?:_DONE|_DONE exit=\d+(?: report=[^\r\n]+)?|_BLOCKED(?: [^\r\n]+)?)$/.test(line.slice(m.length)))) t.final = true;
      if (!discard && line.startsWith('PROXY_TRANSPORT ')) {
        try { const s = JSON.parse(line.slice(16)); if (validSignal(s, attempt, url)) t.signal = s; } catch { /* unknown */ }
      }
      discard = false;
    }
    if (carry.length > 8192) { carry = ''; discard = true; }
  }, end() { t.push('\n'); } };
  return t;
}
function validSignal(s, attempt, url) {
  return s && Object.keys(s).sort().join(',') === 'attempt,code,endpoint,schema' && s.schema === 'proxy-transport/1' && s.attempt === attempt && s.endpoint === url && ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EOF'].includes(s.code);
}
// Adapter API: call only from the HTTP request error callback, with that
// request's URL. Never manufacture this event from a model message or regex.
function transportEvent(error, requestUrl, env = process.env) {
  const s = { schema: 'proxy-transport/1', attempt: env.COLABUS_PROXY_ATTEMPT, endpoint: requestUrl, code: error && error.code };
  return env.COLABUS_PROXY_ENDPOINT === requestUrl && validSignal(s, env.COLABUS_PROXY_ATTEMPT, requestUrl) ? `PROXY_TRANSPORT ${JSON.stringify(s)}\n` : null;
}
function classifyProxyDrop(o) {
  return !o.final && !o.stopped && Number.isInteger(o.exitCode) && o.exitCode > 0 && o.down && o.failureClass === 'TRANSPORT' && validSignal(o.signal, o.attempt, o.endpoint) ? 'PROXY_DROP' : null;
}
// The runtime dir of the probe: the operator settings of the root name it (RUNTIME/.ai/runtime by default). The
// scheduler task names the root only, so the command it registers stays inside the length the Task Scheduler takes.
function runtimeDir(root, settings = null) {
  const s = settings || require('../operator/layer.cjs').loadSettings(root);
  return path.join(root, s.runtime);
}
async function main(argv, io = {}) {
  const stdout = io.stdout || process.stdout;
  const cmd = argv[0]; let root = process.cwd(); let runtime;
  for (let i = 1; i < argv.length; i++) { if (argv[i] === '--root') root = path.resolve(argv[++i]); else if (argv[i] === '--runtime') runtime = path.resolve(argv[++i]); else fail('PROXY_USAGE'); }
  const settings = require('../operator/layer.cjs').loadSettings(root);
  const o = { runtimeDir: runtime || runtimeDir(root, settings), config: require('./lib/config.cjs').load({ root }).proxy };
  o.config = { ...o.config, tickMs: settings.schedules.proxyMinutes * 60000 };
  if (!['probe', 'status', 'tick'].includes(cmd)) fail('PROXY_USAGE');
  const s = cmd === 'status' ? readState(o) : await refresh({ ...o, tick: cmd === 'tick' });
  const continued = cmd === 'tick' && settings.schedules.proxyEnabled ? await require('./proxy-seats.cjs').continueDroppedSeats(o) : [];
  stdout.write(`${JSON.stringify(s)}\n`);
  // Every continuation reaches the owner: a continued seat is shown, a refused one is shown by its reason and fails the tick.
  for (const r of continued) stdout.write(`${r.refused ? 'PROXY_CONTINUATION_REFUSED' : 'PROXY_CONTINUATION'} ${JSON.stringify(r)}\n`);
  return s && !continued.some(r => r.refused) ? 0 : 3;
}
module.exports = { DEFAULTS, config, endpoint, hash, canonical, ensureDirectory, route, needsLocalProxy, probe, readState, available, refresh, waitForProxy, tracker, validSignal, transportEvent, classifyProxyDrop, readJson, write, lock, runtimeDir, main };
if (require.main === module) main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { process.stderr.write(`${e.message}\n`); process.exitCode = 3; });

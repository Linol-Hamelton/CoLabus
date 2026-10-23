'use strict';
// Offline, advisory inspection. Configuration is not proof of runtime isolation.
const path = require('node:path');
const crypto = require('node:crypto');
const textSafe = require('../../.ai/bin/lib/text-safe.cjs');
const pathSafe = require('../../.ai/bin/lib/path-safe.cjs');
const { secretIn } = require('../../.ai/bin/lib/secrets.cjs');

const MANDATORY_MCP = ['serena', 'codebase-memory', 'qmd'];
// Reviewed installation pins, matching MCP-REQUIRED-AND-OPTIONAL.md, not model routes.
const MCP_MINIMUM_SPECS = {
  serena: { pin: 'b6fbb6f70940fae4acb3db57dadd8af1eca1a671', package: 'serena-agent' },
  'codebase-memory': { pin: '0.11.0', package: 'codebase-memory-mcp' },
  qmd: { pin: '2.8.3', package: '@' + 'tobilu/qmd' },
};
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const keys = (x, allowed) => object(x) && Object.keys(x).every(k => allowed.includes(k));
const positive = x => Number.isSafeInteger(x) && x > 0;

function readJson(root, rel) {
  const g = pathSafe.realInside(root, rel, { refuseHardlinks: true });
  if (!g.ok) return { state: 'unverified' };
  if (!g.exists) return { state: 'absent' };
  const r = pathSafe.readFileGuarded(root, rel);
  if (!r.ok) return { state: 'unverified' };
  const d = textSafe.decode(r.bytes, { invisible: 'refuse' });
  if (!d.ok) return { state: 'unverified' };
  try { return { state: 'read', value: textSafe.parseJsonUnique(d.text), bytes: r.bytes }; }
  catch { return { state: 'unverified' }; }
}

function validEntry(c) {
  return keys(c, ['type', 'command', 'args', 'cwd', 'env', 'disabled', 'url', 'transport'])
    && typeof c.command === 'string' && Array.isArray(c.args) && c.args.every(a => typeof a === 'string')
    && (c.type === undefined || typeof c.type === 'string')
    && (c.transport === undefined || typeof c.transport === 'string')
    && (c.cwd === undefined || typeof c.cwd === 'string')
    && (c.disabled === undefined || typeof c.disabled === 'boolean')
    && (c.env === undefined || (object(c.env) && Object.values(c.env).every(v => typeof v === 'string')));
}

function serenaOptions(args) {
  const expected = 'git+https://github.com/oraios/serena@' + MCP_MINIMUM_SPECS.serena.pin;
  if (args[0] !== '--from' || args[1] !== expected || args[2] !== 'serena' || args[3] !== 'start-mcp-server') return null;
  const opts = new Map();
  for (let i = 4; i < args.length; i++) {
    const k = args[i];
    if (opts.has(k)) return null;
    if (k === '--project-from-cwd') { opts.set(k, true); continue; }
    if (!['--context', '--enable-web-dashboard', '--open-web-dashboard', '--enable-gui-log-window'].includes(k)) return null;
    const v = args[++i];
    if (k === '--context' ? !['claude-code', 'codex', 'agent'].includes(v) : !['True', 'False'].includes(v)) return null;
    opts.set(k, v);
  }
  return opts;
}

function checkPin(root, id, c) {
  const spec = MCP_MINIMUM_SPECS[id];
  if (!spec) return false;
  // An environment override can change the loaded runtime. Do not call it verified.
  if (c.env && Object.keys(c.env).length) return false;
  if (id === 'serena') return c.command === 'uvx' && serenaOptions(c.args) !== null;
  const expected = spec.package + '@' + spec.pin;
  if (c.command === 'npx') {
    const a = c.args[0] === '--yes' ? c.args.slice(1) : c.args;
    return a[0] === expected && (id === 'qmd' ? a.length === 2 && a[1] === 'mcp' : a.length === 1);
  }
  if (c.command !== 'node' || !c.args[0] || (id === 'qmd' ? c.args.length !== 2 || c.args[1] !== 'mcp' : c.args.length !== 1)) return false;
  // A package path containing a version is not a version measurement. Read its manifest.
  const entry = pathSafe.realInside(root, c.args[0], { refuseHardlinks: true });
  if (!entry.ok || !entry.exists || entry.type !== 'file') return false;
  const suffix = id === 'qmd' ? path.join('bin', 'qmd') : 'bin.js';
  const packageRoot = id === 'qmd' ? path.dirname(path.dirname(entry.real)) : path.dirname(entry.real);
  if (path.join(packageRoot, suffix) !== entry.real) return false;
  const manifest = path.join(packageRoot, 'package.json');
  const r = readJson(root, path.relative(root, manifest));
  return r.state === 'read' && object(r.value) && r.value.name === spec.package && r.value.version === spec.pin;
}

function measurements(root, config) {
  const read = readJson(root, 'docs/ops/mcp-minimum-evidence.json');
  if (read.state !== 'read') return null;
  const x = read.value;
  if (!keys(x, ['schema', 'configSha256', 'budgetTokens', 'servers']) || x.schema !== 'mcp-minimum-evidence/1'
      || !positive(x.budgetTokens) || !object(x.servers) || !config.bytes
      || x.configSha256 !== crypto.createHash('sha256').update(config.bytes).digest('hex')) return null;
  const tokens = {};
  for (const [id, tools] of Object.entries(x.servers)) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(id) || !Array.isArray(tools) || !tools.length) return null;
    const names = new Set();
    for (const t of tools) {
      if (!keys(t, ['name', 'description', 'inputSchema']) || typeof t.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,127}$/.test(t.name)
          || names.has(t.name) || !object(t.inputSchema) || t.inputSchema.type !== 'object'
          || (t.description !== undefined && typeof t.description !== 'string')) return null;
      names.add(t.name);
    }
    tokens[id] = Math.ceil(Buffer.byteLength(JSON.stringify(tools), 'utf8') / 4);
  }
  return { budget: x.budgetTokens, tokens };
}

function diagnoseMcpMinimum(root, opts = {}, deps = {}) {
  const projectRoot = path.resolve(root || opts.root || process.cwd());
  const read = readJson(projectRoot, '.mcp.json');
  const config = read.state === 'read' && keys(read.value, ['mcpServers']) && object(read.value.mcpServers) ? read.value.mcpServers : null;
  const measured = config ? measurements(projectRoot, read) : null;
  const ids = [...MANDATORY_MCP];
  if (config) for (const id of Object.keys(config).sort()) {
    if (/^[a-z][a-z0-9-]{0,63}$/.test(id) && !secretIn(id) && !ids.includes(id)) ids.push(id);
  }
  const total = measured && ids.every(id => positive(measured.tokens[id])) ? ids.reduce((n, id) => n + measured.tokens[id], 0) : null;
  const listings = deps.listings || opts.listings || {};
  const servers = ids.map(id => {
    const aliases = [...new Set([id, id.replace(/-/g, '_')])];
    const entries = config ? aliases.filter(a => Object.hasOwn(config, a)) : [];
    const c = entries.length === 1 ? config[entries[0]] : null;
    const valid = validEntry(c);
    const local = valid && (c.type === undefined || c.type === 'stdio') && (c.transport === undefined || c.transport === 'stdio') && c.url === undefined;
    const cwd = valid && pathSafe.realInside(projectRoot, c.cwd === undefined ? projectRoot : c.cwd, { allowRoot: true });
    const workspace = local && cwd.ok && cwd.exists && cwd.type === 'dir'
      && (id !== 'serena' || serenaOptions(c.args)?.get('--project-from-cwd') === true);
    const pinned = valid && checkPin(projectRoot, id, c);
    const observed = Object.values(listings).filter(l => l && l.status === 'ok')
      .flatMap(l => aliases.filter(a => Object.hasOwn(l.servers || {}, a)).map(a => l.servers[a]));
    const runtime = observed.length && observed.every(s => s === 'connected') ? 'connected (observed)' : 'unverified (no unanimous connected observation)';
    const configStatus = c && valid && c.disabled !== true && local && pinned && workspace ? 'configured (runtime unverified)' : 'unavailable or unverified (advisory)';
    const serena = valid && id === 'serena' ? serenaOptions(c.args) : null;
    const dashboardOff = local && serena?.get('--enable-web-dashboard') === 'False' && serena?.get('--open-web-dashboard') === 'False';
    return {
      id,
      inventory: entries.length > 1 ? 'unverified (ambiguous aliases)' : c ? valid ? 'configured' : 'unverified (config shape)' : config ? 'missing' : read.state === 'absent' ? 'missing' : 'unverified (config input)',
      pin: pinned ? 'configured (exact pin)' : 'unverified (no exact executable pin)',
      sandbox: workspace ? 'configured (workspace stdio; OS isolation unverified)' : 'unverified (workspace stdio not established)',
      network: dashboardOff ? 'configured (dashboards disabled; network isolation unverified)' : 'unverified (network isolation not measured)',
      schemaBudget: total === null ? 'unverified (complete config-bound tool schema capture required)' : `${total <= measured.budget ? 'within' : 'exceeded'} (aggregate estimated tokens ${total}; recorded budget ${measured.budget})`,
      runtime,
      status: configStatus,
    };
  });
  return { servers, summary: `MCP minimum: ${servers.filter(s => s.status.startsWith('configured')).length}/${servers.length} configured; runtime isolation unverified (advisory only; completion gates never depend on MCP)`, advisory: true, gatesAffected: false, exitCode: 0 };
}

module.exports = { diagnoseMcpMinimum, MANDATORY_MCP, MCP_MINIMUM_SPECS };

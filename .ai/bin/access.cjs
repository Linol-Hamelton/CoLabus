#!/usr/bin/env node
'use strict';
// One read-only inventory. The only writes are one per-machine JSON record in this checkout's ignored runtime.
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cli = require('./access/clients.cjs');
const probe = require('./access/probe.cjs');
const lib = require('../../docs/ops/channels-lib.cjs');
const pathSafe = require('./lib/path-safe.cjs');
const v2 = require('./access/enrich.cjs');
const { toV1, INVENTORY_MAX_BYTES } = require('./access/inventory.cjs');
const ROOT = path.resolve(__dirname, '../..');
const AGGREGATORS = new Set(['openrouter', 'gateway', 'odirouter', 'huggingface', 'spacebunny', 'dahl', 'typesafe']);
const USAGE = 'node .ai/bin/access.cjs [--probe] [--force-scarce] [--no-network] [--json] [--v1] [--cached]';
const name = s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(s) ? s : null;
const unknownProbe = reason => ({ ok: null, reason, at: null, servedModel: null, source: 'none', match: 'unknown' });

function parse(args) {
  if (args.some(a => !['--probe', '--force-scarce', '--no-network', '--json', '--v1', '--cached', '--help'].includes(a))) throw new Error('USAGE');
  // --force-scarce is a legacy flag: it is accepted and changes nothing, a scarce route is never probed.
  return { probe: args.includes('--probe'), network: !args.includes('--no-network'), json: args.includes('--json'), help: args.includes('--help'), v1: args.includes('--v1'), cached: args.includes('--cached') };
}

function defaultDeps() {
  return { root: ROOT, home: os.homedir(), hostname: os.hostname(), now: Date.now(), platform: process.platform,
    env: process.env, catalog: lib.loadCatalog(), read: cli.read, list: cli.list, file: cli.file,
    projectRoot: process.cwd(), configRead: v2.configRead, configFile: v2.configFile,
    registryEnv: cli.registryEnv, resolve: cli.resolve, execute: cli.execute,
    loadRoutes: file => require('../../tools/operator-knowledge/route-state.cjs').loadRecord(file) };
}

// Typed projection after channels-env: never retain the child's transcript, even its errors.
function providerRow(raw, id) {
  const j = cli.json(raw);
  const state = ['valid', 'rejected', 'no-answer', 'missing', 'unknown'].includes(j?.state) ? j.state : 'unknown';
  const models = Array.isArray(j?.models) ? [...new Set(j.models.map(cli.modelName).filter(Boolean))].sort() : [];
  const balance = Array.isArray(j?.balance) ? j.balance.filter(b => ['USD', 'CNY'].includes(b?.currency) && Number.isFinite(b.amount)).map(b => ({ currency: b.currency, amount: b.amount })) : [];
  return { id, state, models, modelCount: Number.isInteger(j?.modelCount) && j.modelCount >= 0 ? models.length : null, balance };
}

async function collect(opts, d) {
  const env = d.registryEnv(d.env, d.platform);
  const io = { read: d.read, list: d.list, file: d.file };
  const record = { schema: 'access-inventory/1', machine: crypto.createHash('sha256').update(d.hostname).digest('hex').slice(0, 16), at: new Date(d.now).toISOString(), network: opts.network, clients: [], keys: [], providers: [], routes: [], works: [], missing: [], selection: { measured: [], declaredExpired: [] } };
  const resolved = new Map();
  const runNode = args => d.execute({ file: process.execPath, prefix: [] }, args, env, d.root, undefined, 240000);
  const catalogClients = d.catalog.channels.filter(c => c.kind === 'cli' && lib.isOffered(c));
  // Known subscription clients absent from the install catalog are still discovered. Never invent pins or auth commands.
  const extraClients = ['qwen', 'gemini'].filter(id => !catalogClients.some(c => c.id === id)).map(id => ({ id, kind: 'cli',
    login: { method: 'unknown' }, userAction: `Install or sign in to ${id}; install pin and login command not verified in channels-catalog` }));
  for (const ch of [...catalogClients, ...extraClients]) {
    const r = d.resolve(ch.id, env, d.platform, d.home, io);
    const run = args => d.execute(r, args, env, d.root);
    const ver = r ? cli.version(run(['--version'])) : null;
    const installed = !!r && !!ver;
    const auth = installed ? cli.login(ch.id, run, d.home, io, d.now, opts.network) : { state: 'unknown', source: 'not-installed' };
    const row = { id: ch.id, installed, path: installed ? r.path : null, version: ver, login: auth, models: installed ? cli.configuredModels(ch.id, d.home, io) : [] };
    if (installed) {
      resolved.set(ch.id, r);
      if (opts.network && ['kilo', 'mimo'].includes(ch.id)) {
        const listing = run(['models']);
        if (!listing.error && listing.status === 0) row.models = cli.models(listing.stdout);
      }
    }
    record.clients.push(row);
    if (!installed) {
      const install = ch.install;
      const pinned = install?.verified && install.pin && install.command?.split(' ').includes(install.pin);
      record.missing.push({ id: ch.id, action: pinned ? install.command : ch.userAction, reason: pinned ? 'install' : 'install-command-unverified' });
    } else if (auth.state === 'logged-in') record.works.push({ id: ch.id, basis: 'login-checked' });
    if (installed && auth.state !== 'logged-in' && ch.login?.method !== 'none') record.missing.push({ id: ch.id, action: ch.login?.command?.join(' ') || ch.userAction, reason: auth.state === 'not-logged-in' ? 'login' : 'login-validity-unknown' });
  }

  const keysResult = runNode([path.join(d.root, 'docs/ops/channels-keys.cjs'), 'list', '--json']);
  const keyList = keysResult.status === 0 ? cli.json(keysResult.stdout) : null;
  if (!Array.isArray(keyList)) record.missing.push({ id: 'key-store', reason: 'unknown', action: 'node docs/ops/channels-keys.cjs list' });
  for (const k of Array.isArray(keyList) ? keyList : []) {
    if (lib.parseStoredName(k?.name) && name(k.service) && name(k.alias)) record.keys.push({ name: k.name, service: k.service, alias: k.alias, channel: name(k.channel) });
  }
  for (const ch of d.catalog.channels.filter(c => c.kind === 'api' && c.key && lib.isOffered(c))) {
    const have = record.keys.filter(k => k.service === ch.key.service);
    const envNames = [ch.key.env, ...(ch.key.aliases || []).map(a => a.name)].filter(n => !!d.env[n]);
    if (!have.length && !envNames.length) {
      const page = lib.keyPage(ch);
      record.missing.push({ id: ch.id, reason: 'key-missing', action: `node docs/ops/channels-keys.cjs add ${ch.id} --alias main${page.usable ? '; ' + page.url : '; key page unverified'}` });
    }
    // Each stored account gets a separate child; aliases are not silently chosen.
    const accounts = have.length ? have.map(k => k.alias) : [null];
    for (const alias of accounts) {
      let row = providerRow('', ch.id);
      if (opts.network && (have.length || envNames.length)) {
        const args = [path.join(d.root, 'docs/ops/channels-env.cjs'), 'run', '--keys', ch.id, '--redact'];
        if (alias) args.push('--alias', `${ch.key.service}=${alias}`);
        args.push('--', process.execPath, path.join(__dirname, 'access/provider.cjs'), ch.id);
        const r = runNode(args);
        if (!r.error && r.status === 0) row = providerRow(r.stdout, ch.id);
      } else if (!have.length && !envNames.length) row.state = 'missing';
      row.alias = alias;
      row.keyNames = [...have.filter(k => !alias || k.alias === alias).map(k => k.name), ...envNames];
      row.kind = AGGREGATORS.has(ch.id) ? 'aggregator' : 'direct';
      record.providers.push(row);
      if (row.state === 'valid') record.works.push({ id: ch.id, basis: 'key-verified' });
      else if (row.state !== 'missing') record.missing.push({ id: ch.id, reason: row.state, action: `node docs/ops/channels-verify.cjs --only ${ch.id}${alias ? ' --alias ' + alias : ''}` });
    }
  }

  // Production uses the same local-overlay reader as the launch gate. Fixture IO
  // remains injectable for client discovery tests that do not create a route tree.
  const routeFile = path.join(d.root, 'docs/ops/route-state.json');
  let routes = null;
  try { routes = d.loadRoutes ? d.loadRoutes(routeFile) : cli.json(d.read(routeFile)); } catch { /* advisory unknown */ }
  if (!routes || routes.schema !== 'route-state/1' || !Array.isArray(routes.routes)) record.missing.push({ id: 'route-state', reason: 'unknown', action: 'Configure route-state with the refresh and declare writers' });
  for (const r of routes?.routes || []) {
    if (!name(r.id) || !name(r.client) || !cli.modelName(r.model)) continue;
    const expired = Object.entries(r.fields || {}).filter(([k, v]) => name(k) && v?.tag === 'declared' && (!Number.isFinite(Date.parse(v.expiresAt)) || Date.parse(v.expiresAt) <= d.now)).map(([k]) => k);
    let p = unknownProbe('NOT_REQUESTED');
    if (opts.probe) {
      if (!opts.network) p = unknownProbe('NETWORK_DISABLED');
      else if (probe.isScarce(r.client)) p = unknownProbe('SCARCE_LIMIT');
      else p = (d.probe || probe.run)(r, resolved.get(r.client), env, d.home, { now: d.now });
    }
    const row = { id: r.id, client: r.client, model: r.model, models: record.clients.find(c => c.id === r.client)?.models || [], declaredExpired: expired, probe: p,
      refreshCommand: `node tools/operator-knowledge/refresh.cjs --route ${r.id} --probe` };
    record.routes.push(row);
    if (typeof p.ok === 'boolean') record.selection.measured.push({ route: r.id, probe: p });
    if (p.ok) record.works.push({ id: r.id, basis: p.match === true ? 'probe-model-proven' : 'probe-answer-model-unknown' });
    if (expired.length) record.selection.declaredExpired.push({ route: r.id, fields: expired });
  }
  return record;
}

function render(record) {
  const lines = ['What works', ...record.works.map(w => `${w.id}: ${w.basis}`), '', 'Clients | installed | version | login'];
  if (record.schema === 'access-inventory/2') {
    lines.unshift('Role: operator. Inventory is advisory; key presence is not working access.',
      'Models by kind | client | model | paid | status',
      ...record.models.map(m => `${m.kind} | ${m.client} | ${m.id} | ${m.paid} | ${m.status}`),
      'Client providers | name | key present', ...record.userProviders.map(p => `${p.client} | ${p.name} | ${p.keyPresent}`), '');
  }
  for (const c of record.clients) lines.push(`${c.id} | ${c.installed} | ${c.version || '-'} | ${c.login.state} (${c.login.source})`);
  lines.push('', 'API provider | kind | account | state | balance | model count');
  for (const p of record.providers) lines.push(`${p.id} | ${p.kind} | ${p.alias || 'environment'} | ${p.state} | ${p.balance.map(b => b.amount + ' ' + b.currency).join(', ') || 'unknown'} | ${p.modelCount ?? 'unknown'}`);
  lines.push('', 'Missing / next action');
  for (const m of record.missing) lines.push(`${m.id}: ${m.reason}; ${m.action}`);
  lines.push('', 'Selection input | probe | served model | expired declarations');
  for (const r of record.routes) lines.push(`${r.id} | ${r.probe.ok === null ? r.probe.reason : r.probe.ok ? 'ok' : r.probe.reason} | ${r.probe.servedModel || 'unknown'} (${r.probe.match}) | ${r.declaredExpired.join(',') || '-'}\n  ${r.refreshCommand}`);
  lines.push('The inventory is advisory. Only refresh and declare write route-state; expired declarations stay expired.');
  return lines.join('\n') + '\n';
}

function save(record, root = ROOT) {
  if (!/^[a-f0-9]{16}$/.test(record.machine)) throw new Error('RUNTIME_PATH_REFUSED');
  const dir = path.join(root, '.ai/runtime/access');
  const target = path.join(dir, `${record.machine}.json`);
  // Reuse the shared pinned-directory writer: atomic publication, link/hardlink refusal and
  // identity checks at write time, including a destination swapped after the initial check.
  for (const rel of ['.ai', '.ai/runtime', '.ai/runtime/access']) {
    if (!pathSafe.mkdirGuarded(root, path.join(root, rel)).ok) throw new Error('RUNTIME_PATH_REFUSED');
  }
  if (!pathSafe.writeAtomicGuarded(target, Buffer.from(JSON.stringify(record, null, 2) + '\n'), { root, mode: 0o600 }).ok) throw new Error('RUNTIME_PATH_REFUSED');
  return target;
}

async function main(args, deps) {
  const out = deps?.stdout || process.stdout;
  try {
    const opts = parse(args);
    if (opts.help) { out.write(USAGE + '\n'); return 0; }
    const d = deps || defaultDeps();
    let record, legacy;
    if (opts.cached) {
      const machine = crypto.createHash('sha256').update(d.hostname).digest('hex').slice(0, 16);
      const got = pathSafe.readFileGuarded(d.root, path.join(d.root, '.ai/runtime/access', `${machine}.json`), { maxBytes: INVENTORY_MAX_BYTES });
      if (!got.ok) throw Error('INVENTORY_CACHE_MISSING');
      record = v2.readCache(got.bytes, d.now);
      if (record.machine !== machine) throw Error('INVENTORY_MACHINE_MISMATCH');
    } else {
      legacy = await collect(opts, d);
      record = opts.v1 ? legacy : v2.enrich(legacy, d);
      (d.save || save)(record, d.root);
    }
    const output = opts.v1 ? legacy || toV1(Buffer.from(JSON.stringify(record))) : record;
    out.write(opts.json ? JSON.stringify(output, null, 2) + '\n' : render(output));
    return 0;
  } catch (e) {
    const code = ['INVENTORY_CACHE_MISSING', 'INVENTORY_EXPIRED', 'INVENTORY_MACHINE_MISMATCH', 'INVENTORY_MODEL_LIMIT_EXCEEDED', 'PUBLIC_INPUT_REFUSED'].includes(e?.message) ? e.message : 'ACCESS_INVENTORY_FAILED';
    (deps?.stderr || process.stderr).write(`${code}; use --help for usage; no raw client errors are printed\n`); return 1;
  }
}
module.exports = { parse, collect, providerRow, render, save, main, defaultDeps };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });

#!/usr/bin/env node
'use strict';
// channels-doctor: ONE checklist of what the user must do to connect the channels (CLI, API, MCP) of a project (, Class B).
//   node docs/ops/channels-doctor.cjs [--root DIR] [--want id,id] [--network] [--no-mcp] [--out FILE] [--json] [--catalog FILE]
// Read-only: it installs, starts, logs in and writes nothing except the status file (default <root>/.ai/runtime/CHANNELS-STATUS.md,
// untracked). Per channel it reports installed / logged-in / key-present / needs-user-action. A key is reported BY NAME ONLY: the
// doctor holds presenceView(store), which has no get(); it never sees a value, a prefix or a length. MCP servers are asked of the
// clients' own listing commands (claude mcp list, codex mcp list --json, vibe config); only server NAMES and a status word are
// kept from that output, never a command line, URL or argument (those can carry keys).
// --network lets it run the commands the catalog marks as network (gh auth status, claude mcp list health check, mimo auth whoami).
// Wanted channels: --want, plus <root>/docs/channels-project.json {"schema":"channels-project/1","want":[...]}. Required tools
// (git, node) and the mandatory MCP minimum are always wanted.
// Exit: 0 nothing for the user to do, 1 actions pending, 2 usage error or unreadable input. Every check is injectable (deps).
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const lib = require('./channels-lib.cjs');

// The vendor page and the hint of a key, appended to an [add-key] line (round 2); an unreachable or missing page is marked, never offered as working.
function pageText(ch) {
  const kp = lib.keyPage(ch);
  if (kp.usable) return `; key page: ${kp.url} - ${kp.hint}`;
  return `; ${kp.hint ? kp.hint + ' (' + kp.note + ')' : kp.note}`;
}

const ACTION_ORDER = ['install', 'login', 'authorize', 'add-key', 'connect', 'repair'];

function parseArgs(argv) {
  const o = { want: [], network: false, mcp: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--network') o.network = true;
    else if (a === '--no-mcp') o.mcp = false;
    else if (a === '--json') o.json = true;
    else if (['--root', '--out', '--catalog', '--want'].includes(a)) {
      const v = argv[++i];
      if (v === undefined) return { error: `${a} needs a value` };
      if (a === '--want') o.want.push(...v.split(',').filter(Boolean)); else o[a.slice(2)] = v;
    } else return { error: `unknown option ${a}` };
  }
  return o;
}

const norm = (s) => String(s).toLowerCase().replace(/[\s_]+/g, '-');

// ---- parsers of the clients' own listings: names and a status word only
function parseClaudeList(text) {
  const servers = {};
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(.+?):\s+\S.*$/.exec(line.trim());
    if (!m) continue;
    const name = m[1].trim();
    if (!name || /^checking\b/i.test(name)) continue;
    const st = line.slice(line.lastIndexOf(' - ') >= 0 ? line.lastIndexOf(' - ') : 0);
    let status = 'listed';
    if (/needs?\s+auth|unauthori[sz]ed|auth(entication)?\s+required/i.test(st)) status = 'needs-auth';
    else if (/pending approval/i.test(st)) status = 'pending-approval';
    else if (/fail|error|not connected|disconnected/i.test(st)) status = 'failed';
    else if (/connected/i.test(st)) status = 'connected';
    servers[name] = status;
  }
  return servers;
}

function parseCodexJson(text) {
  const servers = {};
  let data;
  try { data = JSON.parse(text); } catch (e) { return null; }
  const items = Array.isArray(data) ? data : (data && Array.isArray(data.servers) ? data.servers : null);
  if (!items) return null;
  for (const it of items) {
    if (!it || typeof it.name !== 'string') continue;
    let status = 'listed';
    for (const [k, v] of Object.entries(it)) {
      if (/auth/i.test(k) && typeof v === 'string' && /not.?logged|unauth|needs?|required/i.test(v)) status = 'needs-auth';
    }
    if (it.enabled === false) status = 'disabled';
    servers[it.name] = status;
  }
  return servers;
}

// vibe config: the format of the real output is NOT verified; take names from `name = "x"` lines and nothing else.
function parseVibeConfig(text) {
  const servers = {};
  for (const m of String(text).matchAll(/^\s*name\s*=\s*"([^"\r\n]{1,80})"/gm)) servers[m[1]] = 'listed';
  return servers;
}

function listClient(ch, deps, notes) {
  const spec = ch.mcpList;
  const r = deps.exec(spec.command, { timeout: 60000 });
  if (r.error || r.code === null) { notes.push(`${ch.id}: ${spec.command.join(' ')} could not run`); return { status: 'failed', servers: {} }; }
  let servers = null;
  if (ch.id === 'claude') servers = parseClaudeList(r.stdout);
  else if (ch.id === 'codex') servers = parseCodexJson(r.stdout);
  else if (ch.id === 'vibe') servers = parseVibeConfig(r.stdout);
  if (servers === null) { notes.push(`${ch.id}: the listing was not understood (format not verified); no server verdict`); return { status: 'failed', servers: {} }; }
  if (r.code !== 0 && !Object.keys(servers).length) { notes.push(`${ch.id}: ${spec.command.join(' ')} exited ${r.code}`); return { status: 'failed', servers: {} }; }
  return { status: 'ok', servers };
}

function authorizeHint(client, server) {
  if (client === 'claude') return `open Claude Code, run /mcp, select ${server} and authorize in the browser`;
  if (client === 'codex') return `run: codex mcp login ${server} (browser)`;
  return `authorize ${server} in ${client} (browser)`;
}

// The mandatory MCP minimum (serena, codebase-memory, qmd; PROTO-DEC-0170): a missing, unauthorised or failed one is reported with the exact
// pinned connection fragment of docs/ops/MCP-REQUIRED-AND-OPTIONAL.md section 1.3 (catalog `connect`). The doctor only PRINTS it: it never
// edits a client config and never installs a server.
function connectDetail(ch, client) {
  const c = ch.mandatory && ch.connect;
  const lines = c && c.fragments && c.fragments[client];
  if (!lines) return null;
  const pre = c.prerequisite ? `install once: ${c.prerequisite}; ` : '';
  const ph = (c.placeholders || []).length ? ` (${c.placeholders.join('; ')})` : '';
  return { text: `pinned ${c.pin}; ${pre}add to ${c.target[client]}${ph}`, fragment: lines.slice() };
}

function run(opts, deps) {
  const cat = deps.catalog;
  const view = deps.view;
  const env = deps.env;
  const memo = new Map();
  const exec = (cmd, o) => { const k = cmd.join('|'); if (!memo.has(k)) memo.set(k, deps.exec(cmd, o)); return memo.get(k); };
  const root = opts.root || process.cwd();
  const keysTool = lib.toolRel('channels-keys.cjs', root);
  const want = new Set(opts.want || []);
  if (deps.projectWant) for (const w of deps.projectWant) want.add(w);
  const result = { generated: deps.now, device: deps.hostname, platform: deps.platform, network: !!opts.network, doctorTool: lib.toolRel('channels-doctor.cjs', root), channels: [], extras: [], actions: [], notes: [], notOffered: [] };
  const addAction = (type, channel, text, extra) => result.actions.push(extra ? { type, channel, text, client: extra.client, fragment: extra.fragment } : { type, channel, text });

  const stored = lib.storedKeys(cat, view);
  const keyState = (ch) => {
    if (!ch.key) return null;
    const inStore = stored.filter(k => k.service === ch.key.service).map(k => k.alias);
    const names = [ch.key.env, ...(ch.key.aliases || []).map(a => a.name)];
    const inEnv = names.filter(n => typeof env[n] === 'string' && env[n].length > 0);
    return { inStore, inEnv, present: inStore.length > 0 || inEnv.length > 0 };
  };

  // 1. client listings (MCP)
  const listings = {};
  if (opts.mcp !== false) {
    for (const ch of cat.channels) {
      if (ch.kind !== 'cli' || !ch.mcpList || !lib.isOffered(ch)) continue;
      const inst = exec(ch.check.command, { timeout: 30000 });
      if (inst.error || inst.code !== 0) continue;
      if (ch.mcpList.network && !opts.network) { listings[ch.id] = { status: 'skipped', servers: {}, why: 'needs --network (the client health-checks its servers)' }; continue; }
      listings[ch.id] = listClient(ch, { exec }, result.notes);
    }
  }
  result.listings = Object.fromEntries(Object.entries(listings).map(([k, v]) => [k, { status: v.status, why: v.why || null, servers: v.servers }]));
  const anyListing = Object.values(listings).some(l => l.status === 'ok');
  const seenServer = new Set();
  const findServer = (ch) => {
    const names = (ch.mcpNames || [ch.id]).map(norm);
    const hits = [];
    for (const [client, l] of Object.entries(listings)) {
      for (const [srv, st] of Object.entries(l.servers || {})) if (names.includes(norm(srv))) { hits.push({ client, server: srv, status: st }); seenServer.add(client + '\u0000' + srv); }
    }
    return hits;
  };

  // 2. channels
  for (const ch of cat.channels) {
    if (!lib.isOffered(ch)) {
      result.notOffered.push({ id: ch.id, kind: ch.kind, why: ch.excluded ? `excluded by ${ch.excluded}` : 'unverified in the catalog' });
      continue;
    }
    const wanted = want.has(ch.id) || ch.required === true;
    const row = { id: ch.id, kind: ch.kind, wanted, state: 'ready', installed: null, login: null, key: null, mcp: null, notes: [] };
    const ks = keyState(ch);
    if (ks) row.key = ks.present ? `present (${[ks.inStore.length ? 'store:' + ks.inStore.join('/') : '', ks.inEnv.length ? 'env:' + ks.inEnv.join('/') : ''].filter(Boolean).join(' ')})` : 'missing';
    const before = result.actions.length;

    if (ch.kind === 'cli') {
      const r = exec(ch.check.command, { timeout: 30000 });
      row.installed = !r.error && r.code === 0;
      if (r.error && r.error.code !== 'ENOENT') row.notes.push(`${ch.check.command[0]} could not run (${r.error.code || 'error'})`);
      if (!row.installed) {
        if (wanted) addAction('install', ch.id, ch.install && ch.install.verified && ch.install.command ? `install ${ch.title}: ${ch.install.command}` : `install ${ch.title} (no verified install command recorded: ${ch.install ? ch.install.evidence : 'see vendor page'})`);
        else row.state = 'not-installed';
      } else {
        if (ch.login.method === 'none') row.login = 'n/a';
        else if (ch.login.check && (!ch.login.check.network || opts.network)) {
          const l = exec(ch.login.check.command, { timeout: 30000 });
          row.login = l.error ? 'unknown' : (l.code === 0 ? 'logged-in' : 'not-logged-in');
        } else if (ch.login.check) row.login = 'not-checked (network)';
        else row.login = 'unknown (no verified read-only check)';
        if (row.login === 'not-logged-in') addAction('login', ch.id, ch.login.command ? `log in to ${ch.title}: ${ch.login.command.join(' ')} (${ch.login.method})` : `log in to ${ch.title} (${ch.login.method}; login command not verified: ${ch.login.note})`);
        else if (/^unknown/.test(row.login) && wanted) row.notes.push('login cannot be verified automatically: confirm by starting the client once');
        for (const dep of ch.needsKeys || []) {
          const dc = lib.findChannel(cat, dep);
          const dks = dc && keyState(dc);
          if (dc && lib.isOffered(dc) && dks && !dks.present) addAction('add-key', ch.id, `${ch.title} needs the ${dep} key: node ${keysTool} add ${dep} --alias main (name ${dc.key.env}; start ${ch.id} through channels-env so it sees it)${pageText(dc)}`);
        }
      }
    } else if (ch.kind === 'api') {
      if (!ks.present) {
        if (wanted) addAction('add-key', ch.id, `add the ${ch.title} key: node ${keysTool} add ${ch.id} --alias main (name ${ch.key.env})${pageText(ch)}`);
        else row.state = 'optional-no-key';
      } else if (ks.inStore.length && ks.inEnv.length) row.notes.push(`also set in the environment as ${ks.inEnv.join(', ')}: keep one place (run channels-dedupe)`);
      else if (!ks.inStore.length && ks.inEnv.length) row.notes.push(`present in the environment only (${ks.inEnv.join(', ')}): move it into the store with channels-keys add`);
      if (ks.inStore.length > 1) row.notes.push(`${ks.inStore.length} accounts stored (${ks.inStore.join(', ')})`);
    } else if (ch.kind === 'mcp') {
      const hits = opts.mcp === false ? [] : findServer(ch);
      row.mcp = hits.length ? hits.map(h => `${h.client}:${h.status}`).join(' ') : (anyListing ? 'not configured' : 'not checked');
      for (const h of hits) {
        const d = connectDetail(ch, h.client);
        if (h.status === 'needs-auth') addAction('authorize', ch.id, `${ch.id} needs authorization: ${authorizeHint(h.client, h.server)}${d ? `; the pinned entry for ${h.client} is below (${d.text})` : ''}`, d && { client: h.client, fragment: d.fragment });
        else if (h.status === 'failed') addAction('repair', ch.id, `${ch.id} failed to connect in ${h.client}: check its command and (if it needs one) its key, then re-run the doctor${d ? `; the pinned entry for ${h.client} is below (${d.text})` : ''}`, d && { client: h.client, fragment: d.fragment });
      }
      if (!hits.length && anyListing && wanted) {
        const okClients = Object.entries(listings).filter(([, l]) => l.status === 'ok').map(([k]) => k);
        const shown = ch.mandatory ? okClients.filter(k => connectDetail(ch, k)) : [];
        if (shown.length) {
          for (const k of shown) { const d = connectDetail(ch, k); addAction('connect', ch.id, `connect ${ch.id} in ${k}: ${d.text}`, { client: k, fragment: d.fragment }); }
        } else addAction('connect', ch.id, ch.install && ch.install.verified && ch.install.command ? `connect ${ch.id}: ${ch.install.command}` : `connect ${ch.id} (see ${ch.install ? ch.install.evidence : 'the MCP recommender'})`);
      }
      else if (!hits.length && anyListing) row.state = 'not-configured';
      else if (!anyListing) { row.state = 'not-checked'; if (wanted) row.notes.push('cannot tell: no client listing was available (run with --network, or a client is not installed)'); }
      if (ch.key && !ks.present && (hits.length || wanted)) addAction('add-key', ch.id, `${ch.id} needs a key: node ${keysTool} add ${ch.id} --alias main (name ${ch.key.env}); start the client through channels-env${pageText(ch)}`);
    }
    if (result.actions.length > before) row.state = 'needs-user-action';
    else if (ch.kind === 'cli' && row.installed && /^(unknown|not-checked)/.test(row.login || '')) row.state = 'installed';
    result.channels.push(row);
  }

  // 3. servers found in the clients that the catalog does not know
  for (const [client, l] of Object.entries(listings)) {
    for (const [srv, st] of Object.entries(l.servers || {})) {
      if (seenServer.has(client + '\u0000' + srv)) continue;
      result.extras.push({ client, server: srv, status: st });
      if (st === 'needs-auth' && want.has(norm(srv))) addAction('authorize', srv, `${srv} needs authorization: ${authorizeHint(client, srv)}`);
    }
  }

  result.actions.sort((a, b) => ACTION_ORDER.indexOf(a.type) - ACTION_ORDER.indexOf(b.type));
  return result;
}

const cell = (s) => String(s == null ? '' : s).replace(/\|/g, '/').replace(/\r?\n/g, ' ');

function render(res) {
  const L = [];
  L.push('# Channels status', '');
  L.push(`Generated: ${res.generated} | device: ${res.device} (${res.platform}) | network checks: ${res.network ? 'on' : 'off'}`);
  L.push(`Key values are never read or shown here: only NAMES and presence. Keys are per device. Re-run \`node ${res.doctorTool || 'docs/ops/channels-doctor.cjs'} --network\` until "Your actions" is empty.`, '');
  L.push(`## Your actions (${res.actions.length})`, '');
  if (!res.actions.length) L.push('Nothing to do.');
  res.actions.forEach((a, i) => {
    L.push(`${i + 1}. [${a.type}] ${a.text}`);
    if (a.fragment) L.push('', '   ```' + (a.client === 'claude' ? 'json' : 'toml'), ...a.fragment.map(l => `   ${l}`), '   ```', '');
  });
  L.push('', '## Channels', '', '| id | kind | state | installed | login | key | mcp | notes |', '|---|---|---|---|---|---|---|---|');
  for (const c of res.channels) L.push(`| ${cell(c.id)} | ${c.kind} | ${c.state}${c.wanted || /^(optional-no-key|not-installed|not-configured|not-checked)$/.test(c.state) ? '' : ' (optional)'} | ${cell(c.installed === null ? '-' : c.installed)} | ${cell(c.login || '-')} | ${cell(c.key || '-')} | ${cell(c.mcp || '-')} | ${cell(c.notes.join('; '))} |`);
  if (res.extras.length) {
    L.push('', '## MCP servers found in the clients but not in the catalog (names and status only)', '', '| client | server | status |', '|---|---|---|');
    for (const e of res.extras) L.push(`| ${cell(e.client)} | ${cell(e.server)} | ${cell(e.status)}${e.status === 'needs-auth' ? ' (optional: authorize only if you want it)' : ''} |`);
  }
  if (res.notOffered.length) {
    L.push('', '## Not offered (unverified or excluded)', '');
    for (const n of res.notOffered) L.push(`- ${n.id} (${n.kind}): ${n.why}`);
  }
  if (res.notes.length) { L.push('', '## Notes', ''); for (const n of res.notes) L.push(`- ${n}`); }
  L.push('');
  return L.join('\n');
}

function summary(res, file) {
  const ready = res.channels.filter(c => c.state === 'ready').length;
  const lines = [`channels doctor: ${res.channels.length} offered channels checked, ${ready} ready, ${res.actions.length} action(s) for the user, ${res.notOffered.length} not offered; network checks ${res.network ? 'on' : 'off'}`];
  res.actions.slice(0, 12).forEach((a, i) => { lines.push(`  ${i + 1}. [${a.type}] ${a.text}`); for (const l of a.fragment || []) lines.push(`       ${l}`); });
  if (res.actions.length > 12) lines.push(`  ... ${res.actions.length - 12} more in the status file`);
  if (file) lines.push(`status file: ${file}`);
  return lines.join('\n');
}

function main(argv, deps = {}) {
  const out = deps.stdout || process.stdout;
  const err = deps.stderr || process.stderr;
  const o = parseArgs(argv);
  if (o.error) { err.write(`${o.error}\nusage: channels-doctor [--root DIR] [--want id,id] [--network] [--no-mcp] [--out FILE] [--json] [--catalog FILE]\n`); return 2; }
  const root = path.resolve(o.root || process.cwd());
  let cat;
  try { cat = deps.catalog || lib.loadCatalog(o.catalog); } catch (e) { err.write(`catalog: ${e.message}\n`); return 2; }
  let store;
  try { store = deps.store || lib.selectStore(deps.env || process.env, deps.platform, undefined, (m) => err.write(`${m}\n`)); } catch (e) { err.write(`${e.message}\n`); return 2; }
  let projectWant = [];
  const pf = path.join(root, 'docs', 'channels-project.json');
  if (fs.existsSync(pf)) {
    try { const p = JSON.parse(fs.readFileSync(pf, 'utf8')); if (p.schema !== 'channels-project/1' || !Array.isArray(p.want)) throw new Error('bad shape'); projectWant = p.want; } catch (e) { err.write('docs/channels-project.json is not a valid channels-project/1 file\n'); return 2; }
  }
  for (const id of [...o.want, ...projectWant]) if (!lib.findChannel(cat, id)) err.write(`warning: unknown channel in the want list: ${id}\n`);
  for (const c of cat.channels) if (c.mandatory) o.want.push(c.id);
  const exec = deps.exec || ((cmd, opts) => lib.runCommand(cmd, opts));
  let res;
  try {
    res = run(o, { catalog: cat, view: lib.presenceView(store), env: deps.env || process.env, exec, projectWant, now: (deps.now || new Date()).toISOString(), hostname: deps.hostname || os.hostname(), platform: deps.platform || process.platform });
  } catch (e) { err.write(`doctor failed: ${e.message}\n`); return 2; }
  const text = render(res);
  const leaks = lib.scanText(text);
  if (leaks.length) { err.write(`refused to write the status file: ${leaks.length} line(s) have the shape of a secret (lines ${leaks.map(l => l.line).join(', ')})\n`); return 1; }
  const file = path.resolve(o.out || path.join(root, '.ai', 'runtime', 'CHANNELS-STATUS.md'));
  try { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); } catch (e) { err.write(`cannot write ${file} (${e.code || 'error'})\n`); return 2; }
  out.write((o.json ? JSON.stringify(res, null, 2) : summary(res, file)) + '\n');
  return res.actions.length ? 1 : 0;
}

module.exports = { main, run, render, parseClaudeList, parseCodexJson, parseVibeConfig, parseArgs };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

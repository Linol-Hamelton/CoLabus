#!/usr/bin/env node
'use strict';
// channels-dedupe: find duplicate and misplaced keys in a project. REPORT ONLY: it deletes, edits and moves nothing, and every
// removal is the user's decision (deletion rule). Class B tooling.
//   node docs/ops/channels-dedupe.cjs [--root DIR] [--all] [--out FILE] [--catalog FILE] [--no-user-env]
// It reports, as file:line and NAME only (never a value, a prefix or a length):
//   1. the same service under different names (catalog key.env + key.aliases, and KEYSTORE_<SERVICE>_<ALIAS>), with where each is used;
//   2. secret-shaped strings in the tree (the SECRETS patterns of launch-record-validate);
//   3. config files that hold a literal key where a ${VAR} reference belongs (.mcp.json and friends, toml, yaml, env files);
//   4. a service whose key sits in more than one place (OS store, process environment, user environment, env files, config files).
// Files are the tracked and untracked-not-ignored ones (git ls-files -co --exclude-standard) plus .env* files on disk.
// Exit: 0 clean, 1 findings, 2 usage error.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const lib = require('./channels-lib.cjs');

const SELF = [/^docs\/ops\/channels-[a-z-]+\.(cjs|json)$/, /^docs\/ops\/channels-[a-z-]+\.test\.cjs$/, /^docs\/ops\/CHANNELS[A-Z-]*\.md$/, /^docs\/ops\/skills\/channels-onboarding\//];
const SKIP_EXT = /\.(png|jpe?g|gif|webp|ico|pdf|zip|gz|tgz|7z|woff2?|ttf|eot|mp[34]|mov|exe|dll|so|dylib|bin|lock|wasm)$/i;
const CODE_EXT = /\.(cjs|mjs|js|ts|tsx|jsx|json|jsonl|toml|ya?ml|ps1|sh|py|ini|cfg|env)$/i;
const CONFIG_EXT = /(\.(json|toml|ya?ml|ini|cfg|env)$|(^|\/)\.env[^/]*$)/i;
const MAX_BYTES = 1024 * 1024;
const SECRETISH = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i;

function parseArgs(argv) {
  const o = { all: false, userEnv: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') o.all = true;
    else if (a === '--no-user-env') o.userEnv = false;
    else if (['--root', '--out', '--catalog'].includes(a)) { const v = argv[++i]; if (v === undefined) return { error: `${a} needs a value` }; o[a.slice(2)] = v; }
    else return { error: `unknown option ${a}` };
  }
  return o;
}

function listFiles(root) {
  const r = spawnSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: root, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  let files;
  if (r.status === 0) files = r.stdout.split('\n').filter(Boolean);
  else {
    files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(path.join(root, d), { withFileTypes: true })) {
        const rel = d ? `${d}/${e.name}` : e.name;
        if (e.isDirectory()) { if (!['node_modules', '.git'].includes(e.name)) walk(rel); } else files.push(rel);
      }
    };
    walk('');
  }
  const extra = new Set();
  for (const d of ['', '.ai/runtime']) {
    let ents = [];
    try { ents = fs.readdirSync(path.join(root, d)); } catch (e) { /* absent */ }
    for (const n of ents) if (/^\.env/.test(n) || /\.env$/i.test(n)) extra.add(d ? `${d}/${n}` : n);
  }
  return [...new Set([...files, ...extra])];
}

function readText(root, rel) {
  const p = path.join(root, rel);
  let st;
  try { st = fs.statSync(p); } catch (e) { return null; }
  if (!st.isFile() || st.size > MAX_BYTES || st.size === 0) return null;
  const buf = fs.readFileSync(p);
  if (buf.subarray(0, 4096).includes(0)) return null;
  return buf.toString('utf8');
}

function nameTable(cat) {
  const byName = new Map();
  for (const ch of cat.channels) {
    if (!ch.key) continue;
    byName.set(ch.key.env, { service: ch.key.service, channel: ch.id, kind: 'canonical' });
    for (const a of ch.key.aliases || []) byName.set(a.name, { service: ch.key.service, channel: ch.id, kind: 'alias' });
  }
  return byName;
}

function isReference(v) {
  return /^\$\{?[A-Za-z_]/.test(v) || /^%[A-Za-z_]/.test(v) || /^<.*>$/.test(v) || /^\{\{/.test(v) || /^env:/i.test(v) || /^\$\(/.test(v);
}
function isPlaceholder(v) {
  return /^[A-Z][A-Z0-9_]*$/.test(v) || /(your|example|placeholder|changeme|redacted|xxx|\*\*\*|todo|<|unset|none|null|true|false|^\.\.\.|process\.env|os\.environ)/i.test(v) || v.length < 8;
}

// A config line that assigns a literal to a secret-looking name: returns the NAME or null.
function literalAssignment(line) {
  const m = /^\s*["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*[:=]\s*["']?([^\s"',#;]+)/.exec(line);
  if (!m || !SECRETISH.test(m[1])) return null;
  // names that describe a key (keySource, keyEnv, tokenFile, max_tokens) are not the key itself
  if (/(source|env|name|path|file|ref|var|url|type|count|limit|usage|id)$/i.test(m[1]) || /^(max|min)[_A-Z]/i.test(m[1])) return null;
  const v = m[2].replace(/[\]}),]+$/, '');
  if (isReference(v) || isPlaceholder(v) || /^[\d.]+$/.test(v)) return null;
  return m[1];
}

// MCP client configs (.mcp.json, .vscode/mcp.json, .cursor/mcp.json): env, headers and args of every server.
function mcpLiterals(text) {
  let j;
  try { j = JSON.parse(text); } catch (e) { return []; }
  const servers = j.mcpServers || j.servers || {};
  const out = [];
  for (const s of Object.values(servers)) {
    if (!s || typeof s !== 'object') continue;
    for (const [k, v] of Object.entries(s.env || {})) if (SECRETISH.test(k) && typeof v === 'string' && v && !isReference(v) && !isPlaceholder(v)) out.push(k);
    for (const [k, v] of Object.entries(s.headers || {})) if (/(auth|key|token|secret)/i.test(k) && typeof v === 'string' && v && !isReference(v) && !/Bearer\s+\$\{/.test(v)) out.push(k);
    const args = Array.isArray(s.args) ? s.args : [];
    args.forEach((a, i) => {
      if (typeof a !== 'string') return;
      const eq = /^(--?[A-Za-z0-9_-]*(key|token|secret|password)[A-Za-z0-9_-]*)=(.+)$/i.exec(a);
      if (eq && !isReference(eq[3]) && !isPlaceholder(eq[3])) out.push(eq[1]);
      else if (/^--?[A-Za-z0-9_-]*(key|token|secret|password)[A-Za-z0-9_-]*$/i.test(a) && typeof args[i + 1] === 'string' && !isReference(args[i + 1]) && !isPlaceholder(args[i + 1])) out.push(a);
    });
  }
  return out;
}

const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const isMcpConfig =(rel) => /(^|\/)(\.mcp\.json|mcp\.json|mcp-config\.json)$/.test(rel);
const lineOf = (text, name) => { const lines = text.split('\n'); const i = lines.findIndex(l => l.includes(name)); return i >= 0 ? i + 1 : 1; };

function analyse(opts, deps) {
  const root = opts.root;
  const cat = deps.catalog;
  const names = nameTable(cat);
  const nameRe = new RegExp(`(?<![A-Za-z0-9_])(${[...names.keys()].sort((a, b) => b.length - a.length).join('|')})(?![A-Za-z0-9_])`, 'g');
  const storedRe = /(?<![A-Za-z0-9_])KEYSTORE_([A-Z0-9]+)_([A-Z][A-Z0-9]{0,23})(?![A-Za-z0-9_])/g;
  const services = new Map(cat.channels.filter(c => c.key).map(c => [c.key.service, c.id]));
  const occ = new Map();   // name -> { service, code: [], docs: [] }
  const secretShaped = []; const literalCfg = []; const envFileDefs = new Map(); // service -> [{file,line,name}]
  // Fixed order: git lists tracked files before untracked ones, so the scan order (and every first-occurrence list) is sorted here.
  const files = listFiles(root).filter(f => !SKIP_EXT.test(f) && !SELF.some(re => re.test(f))).sort(byCodeUnit);
  let scanned = 0;
  for (const rel of files) {
    const text = readText(root, rel);
    if (text === null) continue;
    scanned++;
    const isCode = CODE_EXT.test(rel) || /(^|\/)\.env[^/]*$/.test(rel);
    const isConfig = CONFIG_EXT.test(rel);
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 4000) continue;
      const seen = new Set();
      const note = (name, service) => {
        if (seen.has(name)) return; seen.add(name);
        if (!occ.has(name)) occ.set(name, { service, code: [], docs: [] });
        occ.get(name)[isCode ? 'code' : 'docs'].push(`${rel}:${i + 1}`);
      };
      nameRe.lastIndex = 0; let m;
      while ((m = nameRe.exec(line))) note(m[1], names.get(m[1]).service);
      storedRe.lastIndex = 0;
      while ((m = storedRe.exec(line))) if (services.has(m[1])) note(m[0], m[1]);
      if (lib.localSecretIn(line)) {
        const nm = /\b([A-Z][A-Z0-9_]*(?:API_KEY|TOKEN|SECRET|PASSWORD))\b/.exec(line);
        secretShaped.push({ file: rel, line: i + 1, name: nm ? nm[1] : '-' });
      }
      if (isConfig && !isMcpConfig(rel)) {
        const nm = literalAssignment(line);
        if (nm) {
          literalCfg.push({ file: rel, line: i + 1, name: nm });
          const info = names.get(nm);
          if (info && /(^|\/)\.env[^/]*$|\.env$/i.test(rel)) { if (!envFileDefs.has(info.service)) envFileDefs.set(info.service, []); envFileDefs.get(info.service).push({ file: rel, line: i + 1, name: nm }); }
        }
      }
    }
    if (isMcpConfig(rel)) for (const nm of new Set(mcpLiterals(text))) literalCfg.push({ file: rel, line: lineOf(text, nm), name: nm });
  }

  // 1. same service, different names
  // Output order is fixed: services alphabetical; within a service the canonical catalog name first, then the rest alphabetical.
  const canonical = new Map(cat.channels.filter(c => c.key).map(c => [c.key.service, c.key.env]));
  const byService = new Map();
  for (const [name, o] of occ) { if (!byService.has(o.service)) byService.set(o.service, []); byService.get(o.service).push({ name, code: o.code, docs: o.docs }); }
  const sameService = [];
  for (const service of [...byService.keys()].sort(byCodeUnit)) {
    const list = byService.get(service);
    list.sort((a, b) => (a.name === canonical.get(service) ? -1 : b.name === canonical.get(service) ? 1 : byCodeUnit(a.name, b.name)));
    const withCode = list.filter(x => x.code.length);
    if (withCode.length >= 2) sameService.push({ service, scope: 'code/config', names: list });
    else if (list.length >= 2) sameService.push({ service, scope: 'documentation only', names: list });
  }

  // 4. one service in several places
  const view = deps.view; const env = deps.env;
  const stored = lib.storedKeys(cat, view);
  const multi = [];
  for (const ch of cat.channels) {
    if (!ch.key) continue;
    const where = [];
    const st = stored.filter(k => k.service === ch.key.service);
    if (st.length) where.push(`OS store (${st.map(k => k.name).join(', ')})`);
    const allNames = [ch.key.env, ...(ch.key.aliases || []).map(a => a.name)];
    for (const n of allNames) if (typeof env[n] === 'string' && env[n].length) where.push(`process environment (${n})`);
    if (opts.userEnv && deps.userEnvHas) for (const n of allNames) if (deps.userEnvHas(n)) where.push(`user environment (${n})`);
    for (const d of envFileDefs.get(ch.key.service) || []) where.push(`env file ${d.file}:${d.line} (${d.name})`);
    for (const d of literalCfg) if (allNames.includes(d.name) && !(envFileDefs.get(ch.key.service) || []).some(e => e.file === d.file && e.line === d.line)) where.push(`config file ${d.file}:${d.line} (${d.name})`);
    if (where.length >= 2) multi.push({ service: ch.key.service, channel: ch.id, where });
  }
  return { scanned, sameService, secretShaped, literalCfg, multi };
}

function render(res, all, generated) {
  const L = ['# Channels duplicate report', '', `Generated: ${generated}. REPORT ONLY: nothing was changed or deleted; every removal is the user's decision. File:line and NAMES only, never values.`, `Files scanned: ${res.scanned}.`, ''];
  const cap = (arr) => (all ? arr : arr.slice(0, 8));
  L.push(`## 1. The same service under different names (${res.sameService.length})`, '');
  if (!res.sameService.length) L.push('none');
  for (const s of res.sameService) {
    L.push(`- service ${s.service} (${s.scope}): ${s.names.map(n => n.name).join(' vs ')}. May be one duplicate, or two accounts (then add the second with --second-account). Decide, then keep ONE canonical name.`);
    for (const n of s.names) {
      L.push(`  - ${n.name}: ${n.code.length} in code/config, ${n.docs.length} in docs`);
      for (const w of cap(n.code)) L.push(`    - ${w}`);
      if (!all && n.code.length > 8) L.push(`    - ... ${n.code.length - 8} more (--all)`);
      if (!n.code.length) for (const w of cap(n.docs).slice(0, 3)) L.push(`    - ${w} (docs)`);
    }
  }
  L.push('', `## 2. Secret-shaped strings in the tree (${res.secretShaped.length})`, '');
  if (!res.secretShaped.length) L.push('none');
  for (const s of cap(res.secretShaped)) L.push(`- ${s.file}:${s.line}  name ${s.name}`);
  if (!all && res.secretShaped.length > 8) L.push(`- ... ${res.secretShaped.length - 8} more (--all)`);
  L.push('', `## 3. Config files with a literal key where a \${VAR} reference belongs (${res.literalCfg.length})`, '');
  if (!res.literalCfg.length) L.push('none');
  for (const s of cap(res.literalCfg)) L.push(`- ${s.file}:${s.line}  name ${s.name}`);
  if (!all && res.literalCfg.length > 8) L.push(`- ... ${res.literalCfg.length - 8} more (--all)`);
  L.push('', `## 4. A key in more than one place (${res.multi.length})`, '');
  if (!res.multi.length) L.push('none');
  for (const m of res.multi) L.push(`- ${m.service} (${m.channel}): ${m.where.join('; ')}. Keep the OS store; remove the others yourself after checking they are copies.`);
  L.push('');
  return L.join('\n');
}

function main(argv, deps = {}) {
  const out = deps.stdout || process.stdout; const err = deps.stderr || process.stderr;
  const o = parseArgs(argv);
  if (o.error) { err.write(`${o.error}\nusage: channels-dedupe [--root DIR] [--all] [--out FILE] [--catalog FILE] [--no-user-env]\n`); return 2; }
  const root = path.resolve(o.root || process.cwd());
  let cat;
  try { cat = deps.catalog || lib.loadCatalog(o.catalog); } catch (e) { err.write(`catalog: ${e.message}\n`); return 2; }
  let store;
  try { store = deps.store || lib.selectStore(deps.env || process.env, deps.platform, undefined, (m) => err.write(`${m}\n`)); } catch (e) { err.write(`${e.message}\n`); return 2; }
  const platform = deps.platform || process.platform;
  const userEnvHas = deps.userEnvHas || (platform === 'win32' ? (n) => spawnSync('reg', ['query', 'HKCU\\Environment', '/v', n], { stdio: 'ignore', windowsHide: true }).status === 0 : null);
  let res;
  try { res = analyse({ root, userEnv: o.userEnv }, { catalog: cat, view: lib.presenceView(store), env: deps.env || process.env, userEnvHas }); } catch (e) { err.write(`dedupe failed: ${e.message}\n`); return 2; }
  const text = render(res, o.all, (deps.now || new Date()).toISOString());
  if (lib.scanText(text).length) { err.write('refused to print: the report itself has a secret-shaped line (bug); nothing written\n'); return 1; }
  if (o.out) { fs.mkdirSync(path.dirname(path.resolve(o.out)), { recursive: true }); fs.writeFileSync(path.resolve(o.out), text, 'utf8'); }
  out.write(text);
  return (res.sameService.length || res.secretShaped.length || res.literalCfg.length || res.multi.length) ? 1 : 0;
}

module.exports = { main, analyse, render, literalAssignment, mcpLiterals, parseArgs };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

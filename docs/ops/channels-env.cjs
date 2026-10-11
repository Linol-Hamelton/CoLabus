#!/usr/bin/env node
'use strict';
// channels-env: run ONE command with the needed keys loaded from the OS credential store into the CHILD environment only
// (, Class B tooling).
//   node docs/ops/channels-env.cjs run [--keys openrouter,telegram] [--alias SERVICE=ALIAS]... [--strict]
//                                      [--redact | --no-redact] [--dry-run] -- <command> [args...]
// The values go into the child's environment block and nowhere else: not into a file, not into the parent shell, not into this
// process's own environment, not into the transcript. With no --keys the keys of the wanted channels of the project are used
// (docs/channels-project.json) plus the keys their CLI channels need; keys that switch a client's billing (billingSwitch in the
// catalog, e.g. ANTHROPIC_API_KEY) are injected only when named in --keys.
// Output redaction: when this process's stdout is not a terminal (an agent transcript, a pipe) the child's stdout and stderr are
// filtered and every exact copy of an injected value is replaced by [REDACTED:ENV]. Only exact text is caught: a child that
// prints a transformed copy (base64, url-encoded, split) defeats the filter, so run trusted commands only.
// Exit: the child's exit code; 1 refused or failed; 2 usage error; 127 command not found.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const lib = require('./channels-lib.cjs');

const USAGE = 'usage: channels-env run [--keys a,b] [--alias SERVICE=ALIAS]... [--strict] [--redact|--no-redact] [--dry-run] -- <command> [args...]';

function parse(argv) {
  const o = { keys: null, alias: {}, strict: false, redact: null, dry: false, cmd: [] };
  let i = 0;
  for (; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') { o.cmd = argv.slice(i + 1); break; }
    if (a === '--strict') o.strict = true;
    else if (a === '--redact') o.redact = true;
    else if (a === '--no-redact') o.redact = false;
    else if (a === '--dry-run') o.dry = true;
    else if (a === '--keys') { const v = argv[++i]; if (v === undefined) return { error: '--keys needs a value' }; o.keys = v.split(',').filter(Boolean); }
    else if (a === '--alias') {
      const v = argv[++i]; const m = v && /^([A-Z0-9]+)=([A-Za-z][A-Za-z0-9]{0,23})$/.exec(v);
      if (!m) return { error: '--alias needs SERVICE=ALIAS' };
      o.alias[m[1]] = m[2].toUpperCase();
    } else return { error: `unknown option ${a.split('=')[0]}` };
  }
  return o;
}

// Which channels' keys: --keys wins; otherwise the project file (want + needsKeys), minus billingSwitch keys.
function neededChannels(cat, o, root) {
  if (o.keys) {
    const out = [];
    for (const id of o.keys) {
      const ch = lib.findChannel(cat, id);
      if (!ch || !ch.key) return { error: `"${id}" is not a channel that holds a key` };
      if (!lib.isOffered(ch)) return { error: `channel ${id} is not offered (unverified or excluded)` };
      out.push(ch);
    }
    return { channels: out };
  }
  const file = path.join(root, 'docs', 'channels-project.json');
  if (!fs.existsSync(file)) return { error: 'no --keys and no docs/channels-project.json: name the keys with --keys <channel,...>' };
  let want;
  try { want = JSON.parse(fs.readFileSync(file, 'utf8')).want || []; } catch (e) { return { error: 'docs/channels-project.json is not valid JSON' }; }
  const ids = new Set();
  for (const id of want) {
    const ch = lib.findChannel(cat, id);
    if (!ch) continue;
    if (ch.key) ids.add(ch.id);
    for (const dep of ch.needsKeys || []) ids.add(dep);
  }
  const out = [];
  for (const id of ids) { const ch = lib.findChannel(cat, id); if (ch && ch.key && lib.isOffered(ch) && !ch.key.billingSwitch) out.push(ch); }
  return { channels: out };
}

async function main(argv, deps = {}) {
  const err = deps.stderr || process.stderr;
  const outStream = deps.stdout || process.stdout;
  const warn = (s) => err.write(s + '\n');
  if (argv[0] !== 'run') { warn(USAGE); return 2; }
  const o = parse(argv.slice(1));
  if (o.error) { warn(`${o.error}\n${USAGE}`); return 2; }
  if (!o.cmd.length && !o.dry) { warn(`missing command after --\n${USAGE}`); return 2; }
  let cat;
  try { cat = deps.catalog || lib.loadCatalog(); } catch (e) { warn(`catalog: ${e.message}`); return 1; }
  const root = deps.root || process.cwd();
  const sel = neededChannels(cat, o, root);
  if (sel.error) { warn(`refused: ${sel.error}`); return 2; }
  let store;
  try { store = deps.store || lib.selectStore(deps.env || process.env, deps.platform, undefined, warn); } catch (e) { warn(e.message); return 1; }
  if (store.fake) warn('[fake credential store in use: test mode]');

  let stored;
  try { stored = lib.storedKeys(cat, lib.presenceView(store)); } catch (e) { warn(e.message); return 1; }
  const inject = {}; const names = []; const missing = [];
  for (const ch of sel.channels) {
    const have = stored.filter(k => k.service === ch.key.service);
    if (!have.length) { missing.push(ch.id); continue; }
    let pick = null;
    if (o.alias[ch.key.service]) {
      pick = have.find(k => k.alias === o.alias[ch.key.service]);
      if (!pick) { warn(`refused: ${ch.id} has no alias ${o.alias[ch.key.service]} on this device (have: ${have.map(k => k.alias).join(', ')})`); return 1; }
    } else if (have.length === 1) pick = have[0];
    else { warn(`refused: ${ch.id} has several keys (${have.map(k => k.alias).join(', ')}); choose one with --alias ${ch.key.service}=<ALIAS>`); return 1; }
    let v;
    try { v = store.get(pick.name); } catch (e) { warn(e.message); return 1; }
    if (v === null) { missing.push(ch.id); continue; }
    inject[ch.key.env] = v; names.push({ env: ch.key.env, stored: pick.name });
    // an alias marked inject:true in the catalog is set to the same value (PROTO-DEC-0178: the three legacy DeepSeek names for code that still reads them)
    for (const a of ch.key.aliases || []) if (a.inject === true) { inject[a.name] = v; names.push({ env: a.name, stored: pick.name }); }
  }
  if (missing.length) {
    warn(`missing on this device: ${missing.join(', ')} (add with: node ${lib.toolRel('channels-keys.cjs', process.cwd())} add <channel> --alias <name>)`);
    if (o.strict) return 1;
  }
  if (o.dry) {
    outStream.write(names.length ? names.map(n => `${n.env} <- ${n.stored}`).join('\n') + '\n' : 'no keys would be injected\n');
    return 0;
  }
  // The child gets a COPY of the environment plus the keys. process.env of this process is never modified.
  const env = Object.assign({}, deps.env || process.env, inject);
  const platform = deps.platform || process.platform;
  const resolved = lib.resolveCommand(o.cmd, platform, env, deps.exists);
  delete env[lib.FAKE_STORE_ENV]; delete env[lib.ALLOW_FAKE_ENV];
  if (resolved.error) { warn(resolved.error); return 1; }
  const stdoutIsTTY = deps.stdoutIsTTY !== undefined ? deps.stdoutIsTTY : !!process.stdout.isTTY;
  const redact = o.redact === null ? !stdoutIsTTY : o.redact;
  const spawner = deps.spawn || spawn;
  const pairs = names.map(n => ({ name: n.env, value: inject[n.env] }));
  return new Promise((resolve) => {
    let child;
    try {
      child = spawner(resolved.file, resolved.args, { env, stdio: redact ? ['inherit', 'pipe', 'pipe'] : 'inherit', windowsHide: true, windowsVerbatimArguments: !!resolved.verbatim });
    } catch (e) { warn(`cannot start the command (${e.code || 'error'})`); return resolve(127); }
    if (redact) {
      for (const [stream, sink] of [[child.stdout, deps.childOut || process.stdout], [child.stderr, deps.childErr || process.stderr]]) {
        if (!stream) continue;
        const r = lib.makeRedactor(pairs);
        stream.setEncoding('utf8');
        stream.on('data', c => { const s = r.push(c); if (s) sink.write(s); });
        stream.on('end', () => { const s = r.flush(); if (s) sink.write(s); });
      }
    }
    child.on('error', (e) => { warn(`cannot start the command (${e.code || 'error'})`); resolve(e.code === 'ENOENT' ? 127 : 1); });
    child.on('close', (code, signal) => resolve(code === null ? (signal ? 1 : 1) : code));
  });
}

module.exports = { main, parse, neededChannels };
if (require.main === module) main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { process.stderr.write(`failed: ${e.message}\n`); process.exitCode = 1; });

#!/usr/bin/env node
'use strict';
// channels-keys: add, rotate, list and remove channel keys in the OS credential store (Class B tooling).
//   node docs/ops/channels-keys.cjs list [--json]
//   node docs/ops/channels-keys.cjs add <channel> --alias <name> [--second-account]
//   node docs/ops/channels-keys.cjs rotate <channel> --alias <name>
//   node docs/ops/channels-keys.cjs remove <channel> --alias <name> --confirm-alias <name>
// The VALUE is read from a hidden-input prompt (a terminal) or from stdin (a pipe). It is NEVER accepted in argv, never echoed,
// never logged, never written to a file by this tool. The stored name is KEYSTORE_<SERVICE>_<ALIAS>; one key per (service, account).
// There is deliberately no command that prints, exports or copies a value: keys are per device.
// Exit: 0 done, 1 refused or failed, 2 usage error. The agent must not run add, rotate or remove: the user types the value.
const lib = require('./channels-lib.cjs');

const USAGE = `usage:
  channels-keys list [--json]
  channels-keys add <channel> --alias <name> [--second-account]
  channels-keys rotate <channel> --alias <name>
  channels-keys remove <channel> --alias <name> --confirm-alias <name>
The value is typed at the hidden prompt or piped on stdin; it is never an argument.`;

const NEVER = new Set(['get', 'show', 'print', 'reveal', 'dump', 'export', 'import', 'copy', 'sync', 'cat', 'echo']);

function parse(argv) {
  const o = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--second-account' || a === '--json') o.flags[a.slice(2)] = true;
    else if (a === '--alias' || a === '--confirm-alias') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return { error: `${a} needs a value` };
      o.flags[a.slice(2)] = v; i++;
    } else if (a.startsWith('--')) return { error: `unknown option ${a.split('=')[0]}` };
    else o._.push(a);
  }
  return o;
}

function readAll(stream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    stream.on('data', c => chunks.push(Buffer.from(c)));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', reject);
  });
}

// Hidden input on a terminal (raw mode, no echo); a pipe is read to its end. Only one trailing newline is removed.
function readSecret(prompt, io) {
  const { stdin, stderr } = io;
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    return new Promise((resolve, reject) => {
      let buf = '';
      stderr.write(prompt);
      stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
      const done = (fn, v) => { stdin.removeListener('data', onData); stdin.setRawMode(false); stdin.pause(); stderr.write('\n'); fn(v); };
      const onData = (chunk) => {
        for (const ch of chunk) {
          if (ch === '\r' || ch === '\n') return done(resolve, buf);
          if (ch === '\u0003') return done(reject, new Error('cancelled'));
          if (ch === '\u007f' || ch === '\b') buf = buf.slice(0, -1); else buf += ch;
        }
      };
      stdin.on('data', onData);
    });
  }
  return readAll(stdin).then(t => t.replace(/\r?\n$/, ''));
}

function readLine(prompt, io) {
  const { stdin, stderr } = io;
  return new Promise((resolve, reject) => {
    stderr.write(prompt);
    stdin.setEncoding('utf8'); stdin.resume();
    let buf = '';
    const onData = (c) => { buf += c; const i = buf.search(/\r?\n/); if (i >= 0) { stdin.removeListener('data', onData); stdin.pause(); resolve(buf.slice(0, i)); } };
    stdin.on('data', onData);
    stdin.on('error', reject);
  });
}

async function main(argv, deps = {}) {
  const out = deps.stdout || process.stdout;
  const err = deps.stderr || process.stderr;
  const say = (s) => out.write(s + '\n');
  const warn = (s) => err.write(s + '\n');
  const cmd = argv[0];
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { say(USAGE); return cmd ? 0 : 2; }
  if (NEVER.has(cmd)) { warn(`refused: "${cmd}" does not exist. A key value is never displayed, exported or copied: keys are per device, each device adds its own.`); return 2; }
  const guard = lib.argvGuard(argv);
  if (guard) { warn(`refused: ${guard}`); return 2; }
  const o = parse(argv.slice(1));
  if (o.error) { warn(`${o.error}\n${USAGE}`); return 2; }

  let cat;
  try { cat = deps.catalog || lib.loadCatalog(); } catch (e) { warn(`catalog: ${e.message}`); return 1; }
  let store;
  try { store = deps.store || lib.selectStore(deps.env || process.env, deps.platform, undefined, warn); } catch (e) { warn(e.message); return 1; }
  const platform = deps.platform || process.platform;
  if (store.fake) warn('[fake credential store in use: test mode, nothing reaches the OS store]');
  const io = { stdin: deps.stdin || process.stdin, stderr: err };

  if (cmd === 'list') {
    if (o._.length) { warn('list takes no arguments'); return 2; }
    let keys;
    try { keys = lib.storedKeys(cat, lib.presenceView(store)); } catch (e) { warn(e.message); return 1; }
    if (o.flags.json) {
      say(JSON.stringify(keys.map(k => {
        const ch = k.channel && lib.findChannel(cat, k.channel);
        return { name: k.name, service: k.service, alias: k.alias, channel: k.channel, env: ch ? ch.key.env : null, usedBy: ch ? ch.key.usedBy : null };
      }), null, 2));
      return 0;
    }
    if (!keys.length) { say('no keys stored on this device (names only are ever listed)'); return 0; }
    for (const k of keys) {
      const ch = k.channel && lib.findChannel(cat, k.channel);
      const used = ch ? (ch.key.usedBy.length ? `usedBy=${ch.key.usedBy.length} file(s)` : 'usedBy=none recorded (retire it if nothing uses it)') : 'service not in the catalog';
      say(`${k.name}  channel=${k.channel || '-'}  alias=${k.alias}  env=${ch ? ch.key.env : '-'}  ${used}`);
    }
    return 0;
  }

  if (!['add', 'rotate', 'remove'].includes(cmd)) { warn(`unknown command ${cmd}\n${USAGE}`); return 2; }
  if (o._.length !== 1) { warn(`${cmd} takes exactly one channel id (values are never arguments)\n${USAGE}`); return 2; }
  const ch = lib.findChannel(cat, o._[0]);
  if (!ch || !ch.key) { warn(`refused: "${o._[0]}" is not a channel that holds a key (see docs/ops/channels-catalog.json)`); return 2; }
  if (!lib.isOffered(ch)) { warn(`refused: channel ${ch.id} is not offered (${ch.excluded ? 'excluded by ' + ch.excluded : 'unverified in the catalog'}); ${ch.userAction}`); return 2; }
  const alias = o.flags.alias;
  if (!alias) { warn(`${cmd} needs --alias <name>`); return 2; }
  if (!lib.ALIAS_RE.test(alias)) { warn('refused: alias must be letters and digits, start with a letter, at most 24 characters'); return 2; }
  const name = lib.storedName(ch.key.service, alias);
  let existing;
  try { existing = lib.storedKeys(cat, lib.presenceView(store)).filter(k => k.service === ch.key.service); } catch (e) { warn(e.message); return 1; }
  const same = existing.find(k => k.name === name);

  if (cmd === 'add') {
    if (same) { warn(`refused: ${name} already exists. To replace the value use: rotate ${ch.id} --alias ${alias}`); return 1; }
    if (existing.length && !o.flags['second-account']) {
      warn(`refused: ${ch.id} already has a key (${existing.map(k => k.alias).join(', ')}). One key per (service, account): rotate it, or pass --second-account if this is a different account of the same service.`);
      return 1;
    }
  } else if (cmd === 'rotate') {
    if (!same) { warn(`refused: ${name} does not exist. To create it use: add ${ch.id} --alias ${alias}`); return 1; }
  } else if (cmd === 'remove') {
    if (!same) { warn(`refused: ${name} does not exist`); return 1; }
    let again = o.flags['confirm-alias'];
    if (again === undefined && io.stdin.isTTY) again = await (deps.readLine || readLine)(`Type the alias again to remove ${name}: `, io);
    if (again === undefined) { warn('refused: remove needs the alias typed twice: --alias <name> --confirm-alias <name> (the user decides, never the agent)'); return 2; }
    if (again !== alias) { warn('refused: the two aliases differ; nothing was removed'); return 1; }
    try { store.remove(name); } catch (e) { warn(e.message); return 1; }
    say(`removed ${name}. Revoke the key in the provider account too (rotation notes: channel ${ch.id}).`);
    return 0;
  }

  // the vendor page and the hint of the key go before the hidden prompt; an unreachable page is marked and not offered
  for (const l of lib.keyPageLines(ch)) say(l);
  let value;
  try { value = await (deps.readSecret || readSecret)(`Value for ${name} (hidden, not shown, not stored anywhere else): `, io); } catch (e) { warn(`input failed: ${e.message}`); return 1; }
  const bad = lib.checkValue(value, platform);
  if (bad) { warn(`refused: ${bad}; nothing was stored`); return 1; }
  try {
    store.set(name, value);
    if (!store.has(name)) { warn(`failed: ${name} is not present after the write`); return 1; }
  } catch (e) { warn(e.message); return 1; }
  say(`${cmd === 'add' ? 'stored' : 'rotated'} ${name} (env ${ch.key.env}; the value is not shown)`);
  if (cmd === 'rotate') say(`Now revoke the OLD key in the provider account. ${ch.key.rotation}`);
  if (ch.key.billingSwitch) say(`note: ${ch.key.env} changes who pays for a client that also has a subscription login; channels-env injects it only when you name it with --keys ${ch.id}.`);
  return 0;
}

module.exports = { main, parse, readSecret, USAGE };
if (require.main === module) main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { process.stderr.write(`failed: ${e.message}\n`); process.exitCode = 1; });

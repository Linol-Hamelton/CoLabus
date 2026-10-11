#!/usr/bin/env node
'use strict';
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const lib = require('./channels-lib.cjs');
const keys = require('./channels-keys.cjs');
const doctor = require('./channels-doctor.cjs');
const verify = require('./channels-verify.cjs');

const USAGE = `usage:
  channels-wizard [--alias NAME] [--only a,b] [--list] [--root DIR]
Walks the services of the catalog and asks, for each, to add the key or skip it. The value is typed at the hidden prompt
(or piped on stdin when there is no terminal); it is never an argument and never shown.`;

const LOGIN_FIRST = ['claude', 'codex', 'vibe', 'mimo'];
const MAX_TRIES = 3;

// ---------------------------------------------------------------- arguments
function parse(argv) {
  const o = { alias: null, only: null, list: false, root: null, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') o.list = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--alias' || a === '--only' || a === '--root') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) return { error: `${a} needs a value` };
      i++;
      if (a === '--alias') o.alias = v;
      else if (a === '--root') o.root = v;
      else o.only = v.split(',').map(s => s.trim()).filter(Boolean);
    } else if (a.startsWith('--')) return { error: `unknown option ${a.split('=')[0]}` };
    else return { error: 'no positional arguments: a key value is never an argument' };
  }
  return o;
}

// A default alias from the host name: letters and digits only, starts with a letter, at most 24 characters.
function defaultAlias(hostname) {
  let s = String(hostname || '').replace(/[^A-Za-z0-9]/g, '');
  if (!s) s = 'MAIN';
  if (!/^[A-Za-z]/.test(s)) s = `H${s}`;
  return s.slice(0, 24).toUpperCase();
}

// ---------------------------------------------------------------- input
// Terminal: one line per call (the hidden value is read by channels-keys.readSecret in raw mode, which needs the stream free).
function readLineTty(prompt, io) {
  const { stdin, stderr } = io;
  return new Promise((resolve, reject) => {
    stderr.write(prompt);
    stdin.setEncoding('utf8'); stdin.resume();
    let buf = '';
    const onEnd = () => { stdin.removeListener('data', onData); resolve(null); };
    const onData = (c) => {
      buf += c;
      const i = buf.search(/\r?\n/);
      if (i >= 0) { stdin.removeListener('data', onData); stdin.removeListener('end', onEnd); stdin.pause(); resolve(buf.slice(0, i)); }
    };
    stdin.on('data', onData); stdin.on('end', onEnd); stdin.on('error', reject);
  });
}

// Pipe: every line of stdin is an answer, in order; the value of a key is the next line after its "add" (the hidden-prompt text goes to stderr).
function makeQueue(stdin, stderr) {
  const lines = [];
  let partial = '';
  let ended = false;
  let waiter = null;
  const wake = () => { if (waiter) { const w = waiter; waiter = null; w(); } };
  stdin.setEncoding('utf8');
  stdin.on('data', (c) => {
    partial += c;
    let i;
    while ((i = partial.search(/\r?\n/)) >= 0) {
      lines.push(partial.slice(0, i));
      partial = partial.slice(partial[i] === '\r' ? i + 2 : i + 1);
    }
    wake();
  });
  stdin.on('end', () => { if (partial) { lines.push(partial); partial = ''; } ended = true; wake(); });
  stdin.on('error', () => { ended = true; wake(); });
  const next = async (prompt) => {
    stderr.write(prompt);
    while (!lines.length && !ended) await new Promise(r => { waiter = r; });
    stderr.write('\n');
    return lines.length ? lines.shift() : null;
  };
  return { ask: next, secret: async (prompt) => { const v = await next(prompt); if (v === null) throw new Error('input ended'); return v; } };
}

// ---------------------------------------------------------------- catalog views
function keyChannels(cat) { return cat.channels.filter(c => c.key); }
function loginChannels(cat) {
  const withLogin = cat.channels.filter(c => lib.isOffered(c) && c.login && Array.isArray(c.login.command) && c.login.command.length && c.login.command.every(x => typeof x === 'string'));
  const rank = (c) => { const i = LOGIN_FIRST.indexOf(c.id); return i < 0 ? LOGIN_FIRST.length : i; };
  return withLogin.map((c, i) => ({ c, i })).sort((a, b) => rank(a.c) - rank(b.c) || a.i - b.i).map(x => x.c);
}
function whyNotOffered(ch) {
  if (ch.excluded) return `excluded by ${ch.excluded}`;
  return String(ch.userAction || 'unverified in the catalog').replace(/^Not offered:\s*/, '');
}
function namesOf(ch) { return [ch.key.env, ...(ch.key.aliases || []).map(a => a.name)]; }

// Login command run by the default runner: the catalog command, resolved for Windows shims, with the terminal inherited.
function runLoginDefault(cmdline) {
  const r = lib.resolveCommand(cmdline, process.platform, process.env);
  if (r.error) return { code: null, error: r.error };
  const res = spawnSync(r.file, r.args, { stdio: 'inherit', windowsHide: false, windowsVerbatimArguments: !!r.verbatim });
  return { code: res.status, error: res.error ? (res.error.code || 'error') : null };
}

// Opens a catalog page in the default browser: the platform opener, the URL as ONE argument (never a shell string). Only an https URL without
// spaces is opened. `run` is spawnSync (injected in tests).
function openUrlWith(run, url, platform) {
  if (typeof url !== 'string' || !/^https:\/\/[^\s]+$/.test(url)) return { code: null, error: 'not an https url' };
  let file; let args;
  if (platform === 'win32') { file = 'rundll32'; args = ['url.dll,FileProtocolHandler', url]; }
  else if (platform === 'darwin') { file = 'open'; args = [url]; }
  else { file = 'xdg-open'; args = [url]; }
  const r = run(file, args, { stdio: 'ignore', windowsHide: true });
  return { code: r.status, error: r.error ? (r.error.code || 'error') : null };
}
const openUrlDefault = (url) => openUrlWith(spawnSync, url, process.platform);

// ---------------------------------------------------------------- main
async function main(argv, deps = {}) {
  const out = deps.stdout || process.stdout;
  const err = deps.stderr || process.stderr;
  const say = (s) => out.write(`${s}\n`);
  const warn = (s) => err.write(`${s}\n`);
  const guard = lib.argvGuard(argv);
  if (guard) { warn(`refused: ${guard}`); return 2; }
  const o = parse(argv);
  if (o.error) { warn(`${o.error}\n${USAGE}`); return 2; }
  if (o.help) { say(USAGE); return 0; }

  let cat;
  try { cat = deps.catalog || lib.loadCatalog(); } catch (e) { warn(`catalog: ${e.message}`); return 1; }
  const known = new Set(cat.channels.map(c => c.id));
  if (o.only) {
    const bad = o.only.filter(id => !known.has(id));
    if (bad.length) { warn(`refused: not a channel of the catalog: ${bad.join(', ')}`); return 2; }
  }
  let alias = o.alias;
  if (alias !== null && !lib.ALIAS_RE.test(alias)) { warn('refused: alias must be letters and digits, start with a letter, at most 24 characters'); return 2; }

  let store;
  try { store = deps.store || lib.selectStore(deps.env || process.env, deps.platform, undefined, warn); } catch (e) { warn(e.message); return 1; }
  const platform = deps.platform || process.platform;
  if (store.fake) warn('[fake credential store in use: test mode, nothing reaches the OS store]');
  const stdin = deps.stdin || process.stdin;
  const tty = deps.tty !== undefined ? !!deps.tty : !!stdin.isTTY;
  const hostAlias = defaultAlias(deps.hostname !== undefined ? deps.hostname : os.hostname());

  const load = () => {
    const byService = new Map();
    for (const k of lib.storedKeys(cat, lib.presenceView(store))) { if (!byService.has(k.service)) byService.set(k.service, []); byService.get(k.service).push(k); }
    return byService;
  };
  let stored;
  try { stored = load(); } catch (e) { warn(e.message); return 1; }

  const wantKey = (c) => !o.only || o.only.includes(c.id);
  const chans = keyChannels(cat).filter(wantKey);
  const logins = loginChannels(cat).filter(wantKey);
  const aliasUp = (a) => String(a).toUpperCase();

  if (o.list) {
    const a = alias || hostAlias;
    say(`Services of the catalog (names only; alias ${a}). Run the wizard without --list to add keys: node ${lib.toolRel('channels-wizard.cjs', o.root || process.cwd())}`);
    for (const ch of chans) {
      const have = (stored.get(ch.key.service) || []);
      const mine = have.some(k => k.alias === aliasUp(a));
      const state = !lib.isOffered(ch) ? `not offered: ${whyNotOffered(ch)}` : mine ? 'stored for this alias' : have.length ? `stored under ${have.map(k => k.alias).join(', ')}` : 'not stored';
      say(`  ${ch.id}  names=${namesOf(ch).join('|')}  as=${lib.storedName(ch.key.service, a)}  ${state}`);
    }
    if (logins.length) { say('Client logins (the wizard runs one only on your "y"):'); for (const c of logins) say(`  ${c.id}: ${c.login.command.join(' ')}`); }
    return 0;
  }

  // The input functions. A terminal reads lines itself and the hidden value through channels-keys; a pipe is one answer per line.
  let ask; let secret;
  const queue = !tty && !deps.ask ? makeQueue(stdin, err) : null;
  if (deps.ask) ask = deps.ask;
  else if (tty) ask = (p) => readLineTty(p, { stdin, stderr: err });
  else ask = queue.ask;
  if (deps.readSecret) secret = deps.readSecret;
  else if (tty) secret = keys.readSecret;
  else secret = (p) => queue.secret(p);
  let asked = 0;
  let ended = false;
  const prompt = async (text) => {
    const a = await ask(text);
    if (a === null) {
      if (!asked) { const e = new Error('no answers'); e.noAnswers = true; throw e; }
      ended = true;
      return 'q';
    }
    asked++;
    return String(a).trim().toLowerCase();
  };
  const choose = async (text, allowed, dflt) => {
    for (let t = 0; t < MAX_TRIES; t++) {
      const a = await prompt(text);
      if (ended) return 'q';
      if (a === '') return dflt;
      if (allowed.includes(a)) return a;
      warn(`  answer one of: ${allowed.join(', ')} (Enter = ${dflt})`);
    }
    return dflt;
  };

  const summary = { added: [], rotated: [], skipped: [], already: [], notOffered: [], failed: [], loginsRun: [], loginsSkipped: [], loginsFailed: [] };
  try {
    if (alias === null) {
      say('Machine alias: one key per service and per machine is stored as KEYSTORE_<SERVICE>_<ALIAS> (for example LAPTOP or DESKTOP).');
      for (let t = 0; alias === null; t++) {
        if (t >= MAX_TRIES) { warn('refused: no valid alias'); return 2; }
        const a = (await ask(`Machine alias [${hostAlias}]: `));
        if (a === null) { if (!asked) { const e = new Error('no answers'); e.noAnswers = true; throw e; } return 2; }
        asked++;
        const v = String(a).trim() || hostAlias;
        if (lib.ALIAS_RE.test(v)) alias = v; else warn('  alias must be letters and digits, start with a letter, at most 24 characters');
      }
    }
    const A = aliasUp(alias);
    say('');
    say(`Keys of the project, one by one (alias ${A}). Add the key, or skip the service: a skipped service stays untouched.`);
    say('Type the value only at the hidden prompt, in your own terminal: it is never shown, never an argument, never put into a file.');
    say('Create one key per machine at the provider and set a credit limit there (the kernel rule: 10 USD per key).');

    say('Answers: a add (hidden prompt), e take the value of a variable that is already set in this environment, o open the vendor key page, s skip, r rotate, q quit.');
    // The environment of this machine: a variable is read only by a NAME that the catalog lists for the service, and only on an explicit e.
    const envSource = deps.env || process.env;
    const isSet = (name) => typeof envSource[name] === 'string' && envSource[name].length > 0;
    const takeNames = (ch) => [ch.key.env, ...(ch.key.aliases || []).filter(x => !x.notKeystore).map(x => x.name)];
    const open = deps.openUrl || openUrlDefault;

    let n = 0;
    let quit = false;
    for (const ch of chans) {
      if (quit) break;
      n++;
      say('');
      say(`[${n}/${chans.length}] ${ch.title || ch.id} (${ch.id})`);
      if (!lib.isOffered(ch)) { say(`  not offered: ${whyNotOffered(ch)}`); summary.notOffered.push(ch.id); continue; }
      const k = ch.key;
      const name = lib.storedName(k.service, alias);
      const have = stored.get(k.service) || [];
      const mine = have.some(x => x.alias === A);
      const others = have.filter(x => x.alias !== A);
      say(`  the project reads: ${namesOf(ch).join(', ')}`);
      say(`  stored as: ${name}`);
      say(`  used by: ${k.usedBy && k.usedBy.length ? k.usedBy.join(', ') : 'none recorded'}`);
      if (k.console) say(`  console: ${k.console}`);
      if (k.billingSwitch) say(`  note: ${k.env} changes who pays for a client that also has a subscription login`);
      say(`  state: ${mine ? 'a key is already stored for this alias' : others.length ? `no key for this alias; stored under ${others.map(x => x.alias).join(', ')}` : 'no key stored'}`);
      if (ch.unverifiedNote) say(`  UNVERIFIED: ${ch.unverifiedNote}`);
      for (const m of (k.companions || [])) say(`  also needed (not a secret, not stored here): ${m.name}`);
      for (const l of lib.keyPageLines(ch)) say(l);
      for (const x of (k.aliases || [])) if (x.notKeystore && isSet(x.name)) say(`  warning: ${x.name} is set in this environment but is not taken by e: ${x.note}`);
      const kp = lib.keyPage(ch);
      const envNames = mine ? [] : takeNames(ch).filter(isSet);
      const allowed = (mine ? ['r'] : ['a'].concat(envNames.length ? ['e'] : [])).concat(kp.usable ? ['o'] : [], ['s', 'q']);
      const menu = `  ${mine ? '[r] rotate' : '[a] add'}${envNames.length ? `  [e] take ${envNames[0]}${envNames.length > 1 ? ' (or another set name)' : ''} from this environment` : ''}${kp.usable ? '  [o] open the key page' : ''}  [s] skip (default)  [q] quit: `;
      let a;
      for (;;) {
        a = await choose(menu, allowed, 's');
        if (a !== 'o') break;
        const r = open(kp.url);
        say(r && r.code === 0 ? `  opened ${kp.url}` : `  could not open the browser (${r && r.error ? r.error : 'error'}); open ${kp.url} yourself`);
      }
      if (a === 'q') { quit = true; break; }
      if (a === 's') { (mine ? summary.already : summary.skipped).push(ch.id); continue; }
      let from = null;
      if (a === 'e') {
        from = envNames[0];
        if (envNames.length > 1) {
          const pick = await choose(`  which variable? ${envNames.map((v, i) => `[${i + 1}] ${v}`).join('  ')} (Enter = 1): `, envNames.map((v, i) => String(i + 1)), '1');
          if (ended) { quit = true; break; }
          from = envNames[Number(pick) - 1];
        }
      }
      const cmd = a === 'r' ? 'rotate' : 'add';
      let second = false;
      if (cmd === 'add' && others.length) {
        const y = await choose(`  ${ch.id} already has a key under ${others.map(x => x.alias).join(', ')}. A second key must be a different ACCOUNT of the same service. Add it as a second account? [y/N]: `, ['y', 'n'], 'n');
        if (y !== 'y') { summary.skipped.push(ch.id); continue; }
        second = true;
      }
      // the value of e is read from the named variable here and handed to channels-keys like a hidden-prompt value (same validation, same store)
      const source = from ? async () => envSource[from] : secret;
      let done = false;
      for (let t = 0; !done; t++) {
        const args = [cmd, ch.id, '--alias', alias].concat(second ? ['--second-account'] : []);
        const code = await keys.main(args, { catalog: cat, store, stdout: out, stderr: err, stdin, readSecret: source, platform, env: deps.env });
        if (code === 0) {
          done = true;
          (cmd === 'add' ? summary.added : summary.rotated).push(from ? `${name} (taken from ${from})` : name);
          try { stored = load(); } catch (e) { warn(e.message); summary.failed.push(ch.id); }
          break;
        }
        // the same environment value would fail the same way: no retry for e
        const retry = ended || from ? 'n' : await choose('  not stored. Try again? [y/N]: ', ['y', 'n'], 'n');
        if (retry !== 'y' || t + 1 >= MAX_TRIES) { summary.failed.push(ch.id); break; }
      }
    }

    // Phase 2: client logins, only on an explicit y.
    if (!quit && logins.length) {
      say('');
      say('Client logins (optional). Each prints its exact command; it runs only when you answer y, with your terminal, so a browser or a hidden prompt works.');
      let lq = false;
      for (const c of logins) {
        if (lq) break;
        say('');
        say(`${c.title} (${c.id}): ${c.login.command.join(' ')}`);
        if (c.login.note) say(`  ${c.login.note}`);
        const y = await choose('  Run now? [y/N] (q = stop the logins): ', ['y', 'n', 'q'], 'n');
        if (y === 'q') { lq = true; break; }
        if (y !== 'y') { summary.loginsSkipped.push(c.id); continue; }
        const r = (deps.runLogin || runLoginDefault)(c.login.command);
        const res = r && typeof r.then === 'function' ? await r : r;
        if (!res || res.code !== 0) { summary.loginsFailed.push(c.id); warn(`  login ${c.id} did not finish (${res && res.error ? res.error : `exit ${res ? res.code : 'unknown'}`}); the wizard goes on`); } else summary.loginsRun.push(c.id);
      }
    }
  } catch (e) {
    if (e && e.noAnswers) {
      warn('refused: stdin is not a terminal and carries no answers; nothing was changed. Run the wizard in a terminal.');
      return 2;
    }
    warn(`failed: ${e && e.message ? e.message : 'error'}`);
    return 1;
  }

  // Summary: names only.
  say('');
  say('Summary (names only, no values):');
  const fmt = (l) => (l.length ? l.join(', ') : 'none');
  say(`  added: ${fmt(summary.added)}`);
  say(`  rotated: ${fmt(summary.rotated)}`);
  say(`  skipped: ${fmt(summary.skipped)}`);
  say(`  already stored (kept): ${fmt(summary.already)}`);
  say(`  not offered: ${fmt(summary.notOffered)}`);
  if (summary.failed.length) say(`  NOT stored (failed): ${fmt(summary.failed)}`);
  if (summary.loginsRun.length || summary.loginsFailed.length || summary.loginsSkipped.length) {
    say(`  logins run: ${fmt(summary.loginsRun)}; failed: ${fmt(summary.loginsFailed)}; skipped: ${fmt(summary.loginsSkipped)}`);
  }
  say(`  list what is stored: node ${lib.toolRel('channels-keys.cjs', o.root || process.cwd())} list`);
  say(`  check every key (read-only, one request per key, only to its own vendor): node ${lib.toolRel('channels-verify.cjs', o.root || process.cwd())} --alias ${aliasUp(alias)}`);

  if (!ended) {
    let v = 'n';
    try { v = await choose('Run the verify command now (read-only: one request per available key, sent only to the vendor of that key)? [y/N]: ', ['y', 'n'], 'n'); } catch (e) { v = 'n'; }
    if (v === 'y') {
      const root = path.resolve(o.root || process.cwd());
      const run = deps.runVerify || ((a) => verify.main(a, { stdout: out, stderr: err, store, platform, env: deps.env }));
      const code = await run(['--alias', aliasUp(alias), '--root', root]);
      say(`verify exit ${code} (0 = every key that answered is valid, 1 = a key was rejected or gave no answer)`);
    }
  }

  if (!ended) {
    let d = 'n';
    try { d = await choose('Run the channels doctor now (read-only)? [y/N]: ', ['y', 'n'], 'n'); } catch (e) { d = 'n'; }
    if (d === 'y') {
      const root = path.resolve(o.root || process.cwd());
      const run = deps.runDoctor || ((a) => doctor.main(a, { stdout: out, stderr: err, store: lib.presenceView(store), catalog: cat, platform, env: deps.env, exec: deps.doctorExec }));
      const code = await run(['--root', root]);
      say(`doctor exit ${code} (0 = nothing to do, 1 = actions pending for you)`);
    }
  }
  return summary.failed.length ? 1 : 0;
}

module.exports = { main, parse, defaultAlias, makeQueue, keyChannels, loginChannels, openUrlWith, USAGE };
if (require.main === module) main(process.argv.slice(2)).then(c => { process.exitCode = c; }, e => { process.stderr.write(`failed: ${e.message}\n`); process.exitCode = 1; });

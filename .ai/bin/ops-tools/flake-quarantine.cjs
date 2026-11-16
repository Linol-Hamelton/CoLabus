#!/usr/bin/env node
'use strict';
// The command of the flaky-test quarantine register (one reader: ../lib/flake-quarantine.cjs).
//   node .ai/bin/ops-tools/flake-quarantine.cjs add --file F --test NAME --signature TEXT --cause TEXT --owner TEXT
//     --plan OR-nnnn --evidence TEXT --by NAME [--extends FQ-nnn] [--set YYYY-MM-DD] [--root DIR]
//   node .ai/bin/ops-tools/flake-quarantine.cjs list [--now ISO] [--root DIR]
// add appends one row after every rule of the register and the tree facts hold; it refuses by name a row without a
// cause, an owner, a plan item, evidence or its author, a product gate, a short signature, a second row over an active
// one and an extension without a new cause. list prints every row with its state at the given time.
// Exit 0 done, 1 refused, 2 usage.
const path = require('node:path');
const q = require('../lib/flake-quarantine.cjs');

const VALUE_FLAGS = {
  add: ['--file', '--test', '--signature', '--cause', '--owner', '--plan', '--evidence', '--by', '--extends', '--set', '--root'],
  list: ['--now', '--root'],
};

function parse(argv) {
  const cmd = argv[0];
  if (!Object.hasOwn(VALUE_FLAGS, cmd)) throw new Error('QUARANTINE-USAGE: add | list');
  const opts = {};
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i];
    if (!VALUE_FLAGS[cmd].includes(flag)) throw new Error(`QUARANTINE-USAGE: unknown flag ${String(flag).slice(0, 40)} for ${cmd}`);
    const key = flag.slice(2);
    if (Object.hasOwn(opts, key)) throw new Error(`QUARANTINE-USAGE: duplicate flag ${flag}`);
    if (i + 1 >= argv.length) throw new Error(`QUARANTINE-USAGE: missing value for ${flag}`);
    opts[key] = argv[++i];
  }
  return { cmd, opts };
}

function main(argv, deps = {}) {
  const out = deps.stdout || (s => process.stdout.write(s));
  const errOut = deps.stderr || (s => process.stderr.write(s));
  let parsed;
  try { parsed = parse(argv); } catch (e) { errOut(`${e.message}\n`); return 2; }
  const { cmd, opts } = parsed;
  const root = path.resolve(opts.root || deps.cwd || process.cwd());
  const nowMs = deps.nowMs ?? (opts.now ? Date.parse(opts.now) : Date.now());
  if (!Number.isFinite(nowMs)) { errOut('QUARANTINE-USAGE: --now must be an ISO time\n'); return 2; }
  if (cmd === 'add') {
    const result = q.addRow(root, opts, nowMs);
    if (!result.ok) { errOut(`QUARANTINE REFUSED ${result.code}: ${result.detail}\n`); return 1; }
    out(`QUARANTINE ADDED ${result.row.id} file=${result.row.file} until=${result.row.ends} plan=${result.row.plan}\n`);
    return 0;
  }
  const register = q.read(root);
  out(`QUARANTINE register=${register.state} rows=${register.rows.length}\n`);
  for (const p of register.problems) out(`QUARANTINE problem ${p}\n`);
  for (const r of register.rows) {
    const state = q.isActive(r, nowMs) ? 'active' : nowMs < Date.parse(`${r.set}T00:00:00Z`) ? 'not-started' : 'expired';
    out(`${r.id} ${state} ${r.set}..${r.ends} ${r.file} ${JSON.stringify(r.test)} signature=${JSON.stringify(r.signature)} plan=${r.plan} owner=${JSON.stringify(r.owner)}\n`);
  }
  return register.state === 'invalid' ? 1 : 0;
}

module.exports = { main, parse };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

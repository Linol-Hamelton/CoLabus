#!/usr/bin/env node
'use strict';
// The command of the flaky-test quarantine register (one reader: ../lib/flake-quarantine.cjs).
//   node .ai/bin/ops-tools/flake-quarantine.cjs add --file F --test NAME --signature TEXT --cause TEXT --owner TEXT
//     --plan OR-nnnn --evidence TEXT --by NAME [--extends FQ-nnn] [--set YYYY-MM-DD] [--root DIR]
//   node .ai/bin/ops-tools/flake-quarantine.cjs close --id FQ-nnn --fix COMMIT --proof FILE.json --by NAME [--root DIR]
//   node .ai/bin/ops-tools/flake-quarantine.cjs list [--now ISO] [--root DIR]
// add appends one row after every rule of the register and the tree facts hold; it refuses by name a row without a
// cause, an owner, a plan item, evidence or its author, a product gate, a short signature, a second row over an active
// one and an extension without a new cause. close appends one close record after the row it ends (the row is never
// edited): the commit of the fix and the proof file {file, head, runs, rerun}: at least five green runs of the test file
// in a row on a head that holds the fix and, when the row names a host in its evidence, a green rerun record; a close
// without a valid proof is refused by the name of the missing part (CLOSE-FIX, CLOSE-PROOF-RUNS, CLOSE-PROOF-RERUN, ...).
// list prints every row with its state at the given time (a closed row is closed, never active) and every close record.
// Exit 0 done, 1 refused, 2 usage.
const fs = require('node:fs');
const path = require('node:path');
const q = require('../lib/flake-quarantine.cjs');
const textSafe = require('../lib/text-safe.cjs');

const VALUE_FLAGS = {
  add: ['--file', '--test', '--signature', '--cause', '--owner', '--plan', '--evidence', '--by', '--extends', '--set', '--root'],
  close: ['--id', '--fix', '--proof', '--by', '--root'],
  list: ['--now', '--root'],
};

function parse(argv) {
  const cmd = argv[0];
  if (!Object.hasOwn(VALUE_FLAGS, cmd)) throw new Error('QUARANTINE-USAGE: add | close | list');
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

// The proof file: one regular JSON file of bounded size, every key once.
function readProof(file, root) {
  try {
    const full = path.resolve(root, file);
    const st = fs.lstatSync(full);
    if (!st.isFile() || st.size > q.MAX_PROOF_BYTES) return { error: `--proof must be a regular file of at most ${q.MAX_PROOF_BYTES} bytes` };
    return { value: textSafe.parseJsonUnique(fs.readFileSync(full, 'utf8')) };
  } catch (e) {
    return { error: `--proof is not readable JSON with every key once (${(e && e.code) || 'error'})` };
  }
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
  if (cmd === 'close') {
    const proof = typeof opts.proof === 'string' ? readProof(opts.proof, root) : { value: null };
    if (proof.error) { errOut(`QUARANTINE REFUSED QUARANTINE-CLOSE-PROOF: ${proof.error}\n`); return 1; }
    const result = q.closeRow(root, { id: opts.id, fix: opts.fix, proof: proof.value, by: opts.by }, nowMs);
    if (!result.ok) { errOut(`QUARANTINE REFUSED ${result.code}: ${result.detail}\n`); return 1; }
    const c = result.close;
    out(`QUARANTINE CLOSED ${c.closes} fix=${c.fix.slice(0, 12)} runs=${c.proof.runs.length} rerun=${c.proof.rerun ? c.proof.rerun.host : 'none'}\n`);
    return 0;
  }
  const register = q.read(root);
  const closed = q.closedOf(register);
  out(`QUARANTINE register=${register.state} rows=${register.rows.length} closed=${closed.size}\n`);
  for (const p of register.problems) out(`QUARANTINE problem ${p}\n`);
  for (const r of register.rows) {
    const state = closed.has(r.id) ? 'closed' : q.isActive(r, nowMs) ? 'active' : nowMs < Date.parse(`${r.set}T00:00:00Z`) ? 'not-started' : 'expired';
    out(`${r.id} ${state} ${r.set}..${r.ends} ${r.file} ${JSON.stringify(r.test)} signature=${JSON.stringify(r.signature)} plan=${r.plan} owner=${JSON.stringify(r.owner)}\n`);
  }
  for (const c of closed.values()) {
    out(`${c.closes} closed-by ${JSON.stringify(c.closedBy)} at ${c.closedAt} fix=${c.fix.slice(0, 12)} head=${c.proof.head.slice(0, 12)} runs=${c.proof.runs.length} rerun=${c.proof.rerun ? JSON.stringify(c.proof.rerun.host) : 'none'} proof=${c.proof.file}\n`);
  }
  return register.state === 'invalid' ? 1 : 0;
}

module.exports = { main, parse };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

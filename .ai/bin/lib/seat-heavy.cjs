'use strict';
// Cooperative launch boundary, inherited by Node children through NODE_OPTIONS.
// It is not an OS sandbox: a caller able to erase its environment can evade it.
const fs = require('node:fs');
const path = require('node:path');
const REASON = "heavy runs are the operator's: the operator runs them on the farm; run single files with --file, or a closed FAST-RED check with node --test";
// G5-FASTRED-LIGHT (operator finding 11.95, fix round g5fl2): the closed
// allow-list of the operator FAST-RED short checks that run `node --test`
// directly. A seat may run exactly these targets; classification
// is the resolved cwd-relative path, never a name the seat can choose, so a
// renamed or unknown test file, a directory, bare --test discovery and every
// option after --test stay refused, with or without an inherited grant. When
// the operator FAST-RED step list changes, this list follows in the same
// round. The full suite, --affected, product-build, product-real and the
// mutation drivers never join this list.
// Derive concrete targets only from this module's source tree. Products have
// no source checks, so their list stays empty even if the caller adds tests.
const SOURCE_ROOT = path.resolve(__dirname, '..', '..', '..');
const SEAT_LIGHT_CHECKS = fs.existsSync(path.join(SOURCE_ROOT, 'PRODUCT-VERSION.json')) ? [] : [
  'app-channel-render',
  'archive-leak-citations',
  'archive-required-corpus',
  'cycle-routegate-marker',
  'ladder-build',
  'manifest',
  'packet-spec-cites',
  'product-publication',
  'suite-consumers',
  'suite-consumers-fresh',
  'suite-tier-oracle',
  'suite-tiers',
].map(name => path.posix.join('tests', `${name}.test.cjs`)).filter(rel => {
  try { return fs.statSync(path.join(SOURCE_ROOT, rel)).isFile(); }
  catch { return false; } // Missing or unreadable source checks never grant a run.
});
const LIGHT_SET = new Set(SEAT_LIGHT_CHECKS);
function seatEnvironment(env) {
  return Object.keys(env).some(key => key.toUpperCase() === 'OK_SEAT_NAME');
}
function localRefusal(env) {
  if (seatEnvironment(env)) return 'HEAVY-SEAT-LOCAL';
  return env.PROTOCOL_OPERATOR_HEAVY === '1' ? null : 'HEAVY-OPERATOR-GRANT-REQUIRED';
}
// INJECTION-DEFENSE R3, P10 (anti-G9): the environment a seat inherits is closed in two places. (1) The whole GIT_* family is dropped (git reads
// GIT_CONFIG_COUNT/KEY_n/VALUE_n, GIT_SSH_COMMAND, GIT_EXTERNAL_DIFF, GIT_ASKPASS, GIT_EXEC_PATH, GIT_DIR, GIT_WORK_TREE ... from the environment and runs the
// command or reads the repository they name) except a closed list whose VALUE is checked, never only its name: a config redirection survives only when it
// names an empty file (an empty config injects nothing; the dispatch executor sets exactly that), the no-system switch only as 1, the two
// prompt/lock switches carry no command. (2) NODE_OPTIONS of the parent is no longer appended after the preload: the seat gets the preload alone, so a
// payload --require of the parent is not loaded into the seat. Keys are matched case-insensitively (Windows environment names).
const GIT_KEPT = new Set(['GIT_TERMINAL_PROMPT', 'GIT_OPTIONAL_LOCKS']);
function emptyConfigFile(value, stat = fs.statSync) {
  try { const entry = stat(String(value)); return entry.isFile() && entry.size === 0; }
  catch { return false; }
}
function gitKept(key, value) {
  const upper = key.toUpperCase();
  if (GIT_KEPT.has(upper)) return true;
  if (upper === 'GIT_CONFIG_NOSYSTEM') return value === '1';
  if (upper === 'GIT_CONFIG_GLOBAL' || upper === 'GIT_CONFIG_SYSTEM') return emptyConfigFile(value);
  return false;
}
function seatEnv(parent, name) {
  const env = { ...parent };
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase();
    // PROTOCOL_OPERATOR_HEAVY is the only grant spelling; no retired grant shape is ever passed on
    if (['OK_SEAT_NAME', 'PROTOCOL_OPERATOR_HEAVY', 'NODE_OPTIONS'].includes(upper)) delete env[key];
    else if (upper.startsWith('GIT_') && !gitKept(key, env[key])) delete env[key];
  }
  env.OK_SEAT_NAME = name || 'kernel-seat';
  env.NODE_OPTIONS = `--require ${JSON.stringify(path.resolve(__filename).replace(/\\/g, '/'))}`;
  return env;
}
// A raw runner invocation is light only when every element after the single
// --test marker resolves, from the working directory, to a file on the closed
// list: at least one target, no repeat markers, no extra options. Anything
// else (bare --test discovery, directories, unknown or renamed files, extra
// flags) fails closed.
function lightSeatCheck(argv, cwd = process.cwd(), exists = fs.existsSync) {
  const index = argv.indexOf('--test');
  if (index === -1 || argv.indexOf('--test', index + 1) !== -1) return false;
  const targets = argv.slice(index + 1);
  if (targets.length === 0) return false;
  for (const target of targets) {
    if (target.startsWith('-')) return false;
    const resolved = path.resolve(cwd, target);
    if (!exists(resolved)) return false;
    if (!LIGHT_SET.has(path.relative(cwd, resolved).replace(/\\/g, '/'))) return false;
  }
  return true;
}
function rawTestRefusal(argv, env) {
  return argv.includes('--test') && localRefusal(env) !== null
    ? (seatEnvironment(env) && lightSeatCheck(argv) ? null : REASON)
    : null;
}
module.exports = { seatEnvironment, localRefusal, seatEnv, rawTestRefusal, lightSeatCheck, SEAT_LIGHT_CHECKS };
// --require runs in the parent before Node discovers any test file. The driver
// uses node:test run() with an explicit selection, so single --file runs stay
// open, and the closed FAST-RED checks above keep their raw --test runs open
// in seats. In runner mode process.argv.slice(1) carries the positional test
// targets exactly as typed (argv[0] is the executable, there is no script
// slot); any other kind of node process never reaches the check.
if (process.execArgv.includes('--test')) {
  const refusal = rawTestRefusal([...process.execArgv, ...process.argv.slice(1)], process.env);
  if (refusal) {
    process.stderr.write(`${refusal}\n`);
    process.exit(3);
  }
}

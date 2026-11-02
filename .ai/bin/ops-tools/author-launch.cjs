'use strict';
// Launch an AUTHOR seat: lint the task file, check the worktree and the registry pin, wait
// for a slot, build the seat prompt, start the launch wrapper with an argv array and verify
// that the seat really runs. No shell, no bash seat script, no client started here.
//   node .ai/bin/ops-tools/author-launch.cjs NAME WORKTREE TASK STREAM CLIENT MODEL
//        --owner OWNER --wrapper FILE --engine FILE [--timeout SEC (>0)] [--no-wait] [--dry-run]
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const { parseRegistry } = require('../lib/candidate-registry.cjs');
const { parseOwnerIdentity } = require('../lib/owner-identity.cjs');
const paths = require('../lib/path-safe.cjs');
const { load, loadSeatCaps } = require('./lib/config.cjs');
const clientPath = require('./lib/client-path.cjs');
const seatCount = require('./seat-count.cjs');
const seatVerify = require('./seat-verify.cjs');

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const PLACEHOLDER = new Set(['unknown', 'blank', 'none', 'null', 'anonymous', 'unnamed', 'placeholder', 'empty', 'tbd']);
const ANGLE = /[<>]/;
const ENTITY = /&[A-Za-z#]/;
const SHA = /^[0-9a-f]{40}$/;

function nameProblem(name) {
  if (typeof name !== 'string' || !NAME.test(name)) return 'the name must be one safe path segment (letters, digits, dot, dash, underscore)';
  if (name.endsWith('.')) return 'the name must not end with a dot';
  if (/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\.|$)/i.test(name)) return 'the name must not be a reserved Windows device name';
  if (PLACEHOLDER.has(name.toLowerCase())) return 'the name must not be a placeholder word';
  return null;
}

// The angle-bracket and entity refusal, with the line numbers a caller can act on.
function taskFileProblems(text) {
  const problems = [];
  String(text).split(/\r?\n/).forEach((line, index) => {
    if (ANGLE.test(line)) problems.push({ line: index + 1, kind: 'angle bracket' });
    else if (ENTITY.test(line)) problems.push({ line: index + 1, kind: 'ampersand entity' });
  });
  return problems;
}

function markerOf(name) { return name.toUpperCase().replace(/[^A-Z0-9_]/g, '_'); }

function buildPrompt({ worktree, taskFile, name, text }) {
  const marker = markerOf(name);
  return [
    '# You are the AUTHOR of this fix round (not a certifier).',
    '',
    `Work only inside ${worktree} (a git worktree on a branch). Read and execute the task file ${taskFile} completely: it names the rules, the reports to read and the work to do. You MAY edit files, run tests and make small commits in that worktree. Do not push. Do not run any delete command. Never print secrets. Which tests to run (affected, targeted or the full suite) is set by the task file; nothing in this header overrides it. End your final message with the single line ${marker}_DONE (or ${marker}_BLOCKED and the reason).`,
    '',
    'The task file follows verbatim:',
    '',
    String(text).replace(/\r\n/g, '\n'),
  ].join('\n');
}

// The launch wrapper argv. Every element is one argument; no shell string exists.
function buildArgv({ wrapper, engine, nodeCli, stream, owner, name, worktree, promptFile, client, model, sha, wrapperArgs, engineArgs }) {
  return [
    nodeCli, wrapper, 'run', '--stream', stream, '--owner', owner, '--name', name, '--certifier',
    '--worktree', worktree, '--pin-files', promptFile, '--client', client, '--model', model, '--launch-role', 'author', ...(wrapperArgs || []),
    '--', nodeCli, engine, '--client', client, '--model', model, '--worktree', worktree,
    '--name', name, '--prompt-file', promptFile, '--expect-sha', sha.slice(0, 8), '--expect-report', 'none',
    ...(engineArgs || []),
  ];
}

function registryRow(text, stream) {
  let parsed;
  try { parsed = parseRegistry(text); } catch { return { problem: 'the candidate registry is not valid' }; }
  const rows = parsed.rows.filter(row => row.cells[0] === stream);
  if (!rows.length) return { parsed, row: null };
  if (rows.length > 1) return { problem: `stream ${stream} is named twice in the candidate registry` };
  return { parsed, row: rows[0] };
}
function repin(text, parsed, row, sha) {
  const cells = row.cells.slice();
  cells[2] = sha;
  const lines = text.split('\n');
  lines[row.index] = `| ${cells.join(' | ')} |`;
  const next = lines.join('\n');
  parseRegistry(next);
  return next;
}

function preflight(options) {
  const problem = nameProblem(options.name);
  if (problem) return { refuse: `AUTHOR-LAUNCH REFUSED: ${problem}` };
  if (!options.stream || /[|\r\n]/.test(options.stream)) return { refuse: 'AUTHOR-LAUNCH REFUSED: the stream is empty or unsafe' };
  if (!options.client || !options.model) return { refuse: 'AUTHOR-LAUNCH REFUSED: the client and the model are required' };
  const worktree = path.resolve(options.worktree || '.');
  if (!fs.existsSync(path.join(worktree, '.git'))) return { refuse: `AUTHOR-LAUNCH REFUSED: ${worktree} is not a worktree` };
  const real = file => fs.existsSync(file) ? fs.realpathSync.native(file) : path.resolve(file);
  const fold = file => process.platform === 'win32' ? file.toLowerCase() : file;
  if (fold(real(worktree)) === fold(real(options.main))) return { refuse: 'AUTHOR-LAUNCH REFUSED: the main checkout is not an author worktree' };
  let text;
  try { text = fs.readFileSync(path.resolve(options.taskFile), 'utf8'); } catch (e) { return { refuse: `AUTHOR-LAUNCH REFUSED: the task file is unreadable (${e.code || 'read failed'})` }; }
  const problems = taskFileProblems(text);
  if (problems.length) {
    const lines = problems.slice(0, 5).map(item => item.line).join(' ');
    return { refuse: `AUTHOR-LAUNCH REFUSED: the task file has angle brackets or ampersand entities (lines: ${lines}); fix them (use braces) and call again` };
  }
  const git = options.run || ((file, args, opts) => spawnSync(file, args, opts));
  const head = git('git', ['-C', worktree, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true });
  const headText = typeof head === 'string' ? head : String(head && head.stdout || '');
  const headOk = typeof head === 'string' || Boolean(head && !head.error && head.status === 0);
  if (!headOk || !SHA.test(headText.trim())) return { refuse: `AUTHOR-LAUNCH REFUSED: ${worktree} has no HEAD` };
  return { worktree, taskFile: path.resolve(options.taskFile), text, sha: headText.trim() };
}

async function launch(options = {}) {
  if (options.timeoutMs !== undefined && (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0)) {
    return { ok: false, exit: 2, lines: ['AUTHOR-LAUNCH REFUSED: --timeout must be a finite positive number of seconds'] };
  }
  const cfg = options.cfg || load({ root: options.root || process.cwd(), env: options.env || process.env });
  const check = preflight({ ...options, main: cfg.main });
  if (check.refuse) return { ok: false, exit: 2, lines: [check.refuse] };
  const { worktree, taskFile, text, sha } = check;
  const lines = [];
  const marker = markerOf(options.name);

  // Validate every launcher input before any registry or prompt write.
  const launchConfig = cfg.config.launch || {};
  const wrapper = options.wrapper || launchConfig.wrapper;
  const engine = options.engine || launchConfig.engine;
  if (!wrapper || !engine) return { ok: false, exit: 2, lines: ['AUTHOR-LAUNCH REFUSED: LAUNCHER-NOT-CONFIGURED: name --wrapper and --engine'] };
  const resolve = file => path.isAbsolute(file) ? file : path.resolve(cfg.root, file);
  const wrapperFile = resolve(wrapper);
  const engineFile = resolve(engine);
  for (const [label, file] of [['wrapper', wrapperFile], ['engine', engineFile]]) {
    let regular = false;
    try { regular = fs.statSync(file).isFile(); } catch { /* refused below */ }
    if (!regular) return { ok: false, exit: 2, lines: [`AUTHOR-LAUNCH REFUSED: the ${label} ${file} is not a file`] };
  }
  const rawOwner = options.owner !== undefined ? options.owner : launchConfig.owner || (cfg.config.candidate && cfg.config.candidate.owner);
  let owner;
  try { owner = parseOwnerIdentity(rawOwner).namespaced; }
  catch { return { ok: false, exit: 2, lines: ['AUTHOR-LAUNCH REFUSED: a valid owner is required (--owner or launch.owner)'] }; }

  // Resolve the client before the registry can be repinned.
  let location;
  try {
    location = clientPath.resolveClient(options.client, {
      platform: options.platform || process.platform,
      processPath: options.env && options.env.PATH || process.env.PATH,
      run: options.regRun,
    });
  } catch (e) { return { ok: false, exit: 2, lines: [`AUTHOR-LAUNCH REFUSED: ${e.message}`] }; }
  const pathValue = location.pathValue;
  for (const problem of location.problems) lines.push(`AUTHOR-LAUNCH NOTE: client PATH ${problem}`);
  if (!location.client.found) lines.push(`AUTHOR-LAUNCH NOTE: client ${options.client} is not on the resolved PATH (${location.client.searched} entries)`);

  // Never overwrite a prompt or repin a row while this seat name is still live.
  if (seatCount.seatState({ runtimeDir: cfg.runtimeDir, name: options.name, processStartMs: options.processStartMs || seatCount.processStartMs, maxAgeMs: cfg.seat.maxAgeMs, endMarker: cfg.seat.endMarker }).live) {
    return { ok: false, exit: 2, lines: [...lines, 'AUTHOR-LAUNCH REFUSED: this seat name already has a live wrapper'] };
  }
  const busy = seatCount.busyWorktree({ runtimeDir: cfg.runtimeDir, worktree, kill: options.kill, processStartMs: options.processStartMs });
  if (busy) return { ok: false, exit: 3, lines: [...lines, `AUTHOR-LAUNCH REFUSED: seat ${busy} is live in ${worktree}; one author per worktree`] };

  // The registry pin: a row for the stream either names this head or is repinned here, so
  // the next session does not launch a candidate on a stale commit.
  const registryFile = options.registryFile || path.join(cfg.runtimeDir, 'CANDIDATES.md');
  let pin = { row: null };
  if (fs.existsSync(registryFile)) {
    const registryText = fs.readFileSync(registryFile, 'utf8');
    pin = registryRow(registryText, options.stream);
    if (pin.problem) return { ok: false, exit: 2, lines: [`AUTHOR-LAUNCH REFUSED: ${pin.problem}`] };
    if (pin.row) {
      let rowOwner;
      try { rowOwner = parseOwnerIdentity(pin.row.cells[3]).namespaced; } catch { /* invalid owner is foreign */ }
      if (rowOwner !== owner) return { ok: false, exit: 2, lines: ['AUTHOR-LAUNCH REFUSED: the registry row belongs to another owner'] };
    }
    if (!pin.row) lines.push(`AUTHOR-LAUNCH NOTE: no registry row for ${options.stream}; the seat starts unregistered`);
    else if (pin.row.cells[2] !== sha) {
      if (options.repin === false) lines.push(`AUTHOR-LAUNCH NOTE: registry sha ${pin.row.cells[2].slice(0, 8)} differs from the worktree head ${sha.slice(0, 8)}; --no-repin left the row as it is`);
      else if (options.dryRun) lines.push(`AUTHOR-LAUNCH NOTE: registry sha ${pin.row.cells[2].slice(0, 8)} differs from the worktree head ${sha.slice(0, 8)}; a real launch would repin the row`);
      else {
        lines.push(`AUTHOR-LAUNCH NOTE: registry sha ${pin.row.cells[2].slice(0, 8)} differs from the worktree head ${sha.slice(0, 8)}; repinning the registry row to the head`);
        const next = repin(registryText, pin.parsed, pin.row, sha);
        const written = paths.writeAtomicGuarded(registryFile, Buffer.from(next, 'utf8'), { root: path.dirname(registryFile) });
        if (!written.ok) return { ok: false, exit: 2, lines: [`AUTHOR-LAUNCH REFUSED: the registry repin was refused (${written.reason || 'write refused'})`] };
      }
    }
  } else lines.push(`AUTHOR-LAUNCH NOTE: no candidate registry at ${registryFile}; the seat starts unregistered`);

  if (options.wait !== false && !options.dryRun) {
    const caps = options.caps || loadSeatCaps();
    const slot = await seatCount.waitForSlot({
      runtimeDir: cfg.runtimeDir, caps, client: options.client, cap: cfg.seat.defaultCap,
      maxAgeMs: cfg.seat.maxAgeMs, endMarker: cfg.seat.endMarker, pollMs: cfg.seat.pollMs, timeoutMs: cfg.seat.waitTimeoutMs,
    });
    if (!slot.ok) return { ok: false, exit: 3, lines: [...lines, `SEAT CAP: no free slot, nothing started (${slot.total} running, client ${options.client} ${slot.clientCount}/${slot.clientCap})`] };
    const busyAfterWait = seatCount.busyWorktree({ runtimeDir: cfg.runtimeDir, worktree, kill: options.kill, processStartMs: options.processStartMs });
    if (busyAfterWait) return { ok: false, exit: 3, lines: [...lines, `AUTHOR-LAUNCH REFUSED: seat ${busyAfterWait} is live in ${worktree}; one author per worktree`] };
  }

  fs.mkdirSync(cfg.promptRoot, { recursive: true });
  const promptFile = path.join(cfg.promptRoot, `${options.name}-PROMPT.md`);
  fs.writeFileSync(promptFile, buildPrompt({ worktree, taskFile, name: options.name, text }), 'utf8');

  const argv = buildArgv({
    wrapper: wrapperFile, engine: engineFile, nodeCli: process.execPath, stream: options.stream, owner,
    name: options.name, worktree, promptFile, client: options.client, model: options.model, sha,
    wrapperArgs: options.wrapperArgs, engineArgs: options.engineArgs,
  });
  if (options.dryRun) return { ok: true, exit: 0, argv, promptFile, sha, lines: [...lines, `AUTHOR-LAUNCH DRY-RUN: ${JSON.stringify(argv)}`] };

  fs.mkdirSync(cfg.runtimeDir, { recursive: true });
  // Keep every previous attempt, but never reuse its state or clobber a live wrapper.
  const oldFiles = ['.launch.out', '.running.json', '.terminal.json', '-call.txt']
    .map(suffix => path.join(cfg.runtimeDir, options.name + suffix)).filter(file => fs.existsSync(file));
  if (oldFiles.length) {
    const archive = path.join(cfg.runtimeDir, 'attempts', `${options.name}-${randomUUID()}`);
    fs.mkdirSync(archive, { recursive: true });
    for (const file of oldFiles) fs.renameSync(file, path.join(archive, path.basename(file)));
  }
  const outFile = path.join(cfg.runtimeDir, `${options.name}.launch.out`);
  const out = fs.openSync(outFile, 'w');
  const startedMs = Date.now();
  let child;
  try {
    const spawnFn = options.spawn || spawn;
    child = spawnFn(argv[0], argv.slice(1), {
      cwd: cfg.main, detached: true, windowsHide: true, stdio: ['ignore', out, out],
      env: { ...(options.env || process.env), PATH: pathValue },
    });
  } finally { fs.closeSync(out); }
  if (!child || !child.pid) return { ok: false, exit: 1, lines: [...lines, 'AUTHOR-LAUNCH REFUSED: the wrapper did not start'] };
  if (typeof child.unref === 'function') child.unref();
  lines.push(`AUTHOR-LAUNCH started name=${options.name} pid=${child.pid} head=${sha.slice(0, 8)} output=${outFile}`);

  const verify = options.verify || seatVerify.verifySeat;
  const verified = await verify({
    name: options.name, startedMs, wrapperPid: child.pid, runtimeDir: cfg.runtimeDir,
    timeoutMs: options.timeoutMs ?? cfg.seat.verifyTimeoutMs, pollMs: cfg.seat.verifyPollMs,
  });
  lines.push(verified.line);
  lines.push(`${verified.ok ? marker + '_DONE' : marker + '_BLOCKED'} ${verified.line}`);
  return { ok: verified.ok, exit: verified.ok ? 0 : 1, argv, promptFile, sha, lines };
}

async function main(argv) {
  const args = argv.slice();
  const value = name => { const i = args.indexOf(name); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
  const owner = value('--owner'); const wrapper = value('--wrapper'); const engine = value('--engine');
  const timeout = value('--timeout'); const registryFile = value('--file');
  const noWait = args.includes('--no-wait'); if (noWait) args.splice(args.indexOf('--no-wait'), 1);
  const dryRun = args.includes('--dry-run'); if (dryRun) args.splice(args.indexOf('--dry-run'), 1);
  const noRepin = args.includes('--no-repin'); if (noRepin) args.splice(args.indexOf('--no-repin'), 1);
  const [name, worktree, taskFile, stream, client, model] = args;
  if (!name || !worktree || !taskFile || !stream || !client || !model) {
    process.stderr.write('usage: author-launch.cjs NAME WORKTREE TASK STREAM CLIENT MODEL --owner O --wrapper FILE --engine FILE [--timeout SEC] [--no-wait] [--dry-run] [--no-repin]\n');
    return 2;
  }
  const result = await launch({ name, worktree, taskFile, stream, client, model, owner, wrapper, engine, timeoutMs: timeout === undefined ? undefined : Number(timeout) * 1000, wait: !noWait, dryRun, repin: !noRepin, registryFile });
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  return result.exit;
}

module.exports = { taskFileProblems, buildPrompt, buildArgv, registryRow, repin, preflight, launch, main, nameProblem, markerOf };
if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; }, e => { process.stderr.write(`${e.message}\n`); process.exitCode = 1; });

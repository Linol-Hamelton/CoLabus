'use strict';
// A single-attempt queue contract, not a scheduler. All writers share this lock.
// The durable reservation precedes removal and spawn: an interrupted attempt is
// retired, never automatically retried. A stale lock needs operator investigation.
// One exception (ASSIGN-EXECUTION R1, design rev2 section 4.9): a launch that printed ASSIGN-DEFERRED and exited 4 started nothing, so it is put back
// in the queue and its attempt is not spent (state and outcome deferred, attempts 0). Only the LAST event of a key decides whether it is used.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const schema = require('./cert-queue.schema.json');
const realPath = require('../lib/real-path.cjs');
const EVENT = 'cert-queue-event/1';
const LIMIT = 1;
const safeName = new RegExp(schema.properties.key.pattern);
const fail = code => { throw Object.assign(new Error(code), { code }); };

function validate(row) {
  if (!row || typeof row !== 'object' || Array.isArray(row) ||
      Object.keys(row).length !== schema.required.length ||
      schema.required.some(key => !Object.hasOwn(row, key)) || row.schema !== schema.properties.schema.const) fail('QUEUE-RECORD');
  for (const key of ['key', 'client', 'stream']) {
    if (typeof row[key] !== 'string' || !safeName.test(row[key])) fail('QUEUE-RECORD');
  }
  if (typeof row.worktree !== 'string' || !new RegExp(schema.properties.worktree.pattern).test(row.worktree)) fail('QUEUE-RECORD');
  return row;
}

// Deliberate migration only. JSONL is the on-disk format; a bare key is never a record.
function parseLegacyLine(line) {
  const fields = typeof line === 'string' && line.trim() ? line.trim().split(/\s+/) : [];
  if (fields.length !== 4) fail('QUEUE-FIELDS');
  const [key, client, stream, worktree] = fields;
  return validate({ schema: schema.properties.schema.const, key, client, stream, worktree });
}

function regular(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1) fail('QUEUE-PATH');
    return true;
  } catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}
function readLines(file, code) {
  if (!regular(file)) return [];
  const text = fs.readFileSync(file, 'utf8');
  // A torn append must block, not erase the durable reservation from memory.
  if (text && !text.endsWith('\n')) fail(code);
  return text.split('\n').filter(line => line.trim()).map(line => {
    try { return JSON.parse(line); } catch { fail(code); }
  });
}
function readQueue(file) {
  const seen = new Set();
  return readLines(file, 'QUEUE-RECORD').map(row => {
    validate(row);
    if (seen.has(row.key)) fail('QUEUE-DUPLICATE');
    seen.add(row.key);
    return row;
  });
}
function readLog(file) {
  return readLines(file, 'QUEUE-LOG').map(e => {
    if (!e || typeof e !== 'object' || Array.isArray(e) || e.schema !== EVENT ||
        typeof e.key !== 'string' || !safeName.test(e.key) ||
        !['queued', 'launched', 'refused', 'retired', 'deferred'].includes(e.state) ||
        !['queued', 'unknown', 'claimed', 'refused', 'precert-refused', 'retired', 'deferred'].includes(e.outcome) ||
        ![0, 1].includes(e.attempts) || e.limit !== LIMIT ||
        typeof e.reason !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_,.:-]*$/.test(e.reason) ||
        !(e.childExitCode === null || Number.isSafeInteger(e.childExitCode)) ||
        typeof e.time !== 'string' || !Number.isFinite(Date.parse(e.time))) fail('QUEUE-LOG');
    try { validate({ schema: schema.properties.schema.const, key: e.key, client: e.client, stream: e.stream, worktree: e.worktree }); }
    catch { fail('QUEUE-LOG'); }
    if ((e.state === 'queued' && (e.attempts !== 0 || e.outcome !== 'queued')) ||
        (e.state === 'launched' && (e.attempts !== LIMIT || e.outcome !== 'claimed')) ||
        (e.state === 'refused' && (e.attempts !== LIMIT || !['refused', 'precert-refused'].includes(e.outcome))) ||
        (e.state === 'retired' && !['unknown', 'retired'].includes(e.outcome)) ||
        (e.state === 'deferred' && (e.attempts !== 0 || e.outcome !== 'deferred')) || (e.outcome === 'deferred' && e.state !== 'deferred') ||
        (e.outcome === 'unknown' && e.attempts !== LIMIT)) fail('QUEUE-LOG');
    return e;
  });
}
function paths(files) {
  if (!files || typeof files.queue !== 'string' || typeof files.log !== 'string') fail('QUEUE-PATH');
  const resolve = file => path.join(realPath.realPathSync(path.dirname(path.resolve(file))), path.basename(file));
  const queue = resolve(files.queue);
  const log = resolve(files.log);
  const fold = file => process.platform === 'win32' ? file.toLowerCase() : file;
  const lock = `${queue}.lock`;
  if (fold(queue) === fold(log) || fold(lock) === fold(log)) fail('QUEUE-PATH');
  regular(queue); regular(log);
  return { queue, log, lock };
}
function withLock(files, fn) {
  const named = paths(files);
  try { fs.mkdirSync(named.lock); } catch (e) { if (e.code === 'EEXIST') fail('QUEUE-BUSY'); throw e; }
  try { return fn(named); } finally { fs.rmdirSync(named.lock); }
}
function writeQueue(file, rows) {
  rows.forEach(validate);
  regular(file);
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx');
  try {
    fs.writeFileSync(fd, rows.map(row => JSON.stringify(row) + '\n').join(''), 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
}
function append(file, event) {
  regular(file);
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | (fs.constants.O_NOFOLLOW || 0));
  try {
    if (fs.fstatSync(fd).nlink !== 1) fail('QUEUE-PATH');
    fs.writeFileSync(fd, `${JSON.stringify(event)}\n`, 'utf8');
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
function event(row, state, outcome, reason, attempts, childExitCode = null) {
  return { ...row, schema: EVENT, time: new Date().toISOString(), state, outcome, reason, attempts, limit: LIMIT, childExitCode };
}
// A deferred event returns the key to the queue, so it clears the use before it; a reservation or a retirement after it uses the key again.
function used(log, key) {
  let spent = false;
  for (const e of log) {
    if (e.key !== key) continue;
    if (e.state === 'deferred') spent = false;
    else if (e.attempts >= LIMIT || e.state === 'retired') spent = true;
  }
  return spent;
}

function add(files, row) {
  validate(row);
  return withLock(files, names => {
    const rows = readQueue(names.queue);
    const log = readLog(names.log);
    if (used(log, row.key)) fail('QUEUE-REPLAY');
    if (rows.some(r => r.key === row.key)) fail('QUEUE-DUPLICATE');
    if (log.some(e => e.key === row.key)) fail('QUEUE-REPLAY');
    const entry = event(row, 'queued', 'queued', 'QUEUED', 0);
    append(names.log, entry);
    writeQueue(names.queue, [...rows, row]);
    return entry;
  });
}
function retire(files, key) {
  return withLock(files, names => {
    const rows = readQueue(names.queue);
    readLog(names.log);
    const row = rows.find(r => r.key === key);
    if (!row) fail('QUEUE-NOT-FOUND');
    const entry = event(row, 'retired', 'retired', 'QUEUE-RETIRED', 0);
    append(names.log, entry);
    writeQueue(names.queue, rows.filter(r => r.key !== key));
    return entry;
  });
}
function classify(child) {
  if (!child || child.error) return { state: 'refused', outcome: 'refused', reason: 'QUEUE-SPAWN-FAILED' };
  const output = `${child.stdout || ''}\n${child.stderr || ''}`;
  const reason = (output.match(/(?:reason|facts)=([A-Za-z0-9][A-Za-z0-9_,.:-]*)/) || [])[1];
  if (/PRECERT[_ -]REFUSED|NOT CERTIFIABLE/i.test(output)) return { state: 'refused', outcome: 'precert-refused', reason: reason || 'PRECERT-REFUSED' };
  // ASSIGN-DEFERRED is nothing started and nothing refused: the exit code 4, the line, and no REFUSED word anywhere in the output.
  if (child.status === 4 && /^ASSIGN-DEFERRED\b/m.test(output) && !/\bREFUSED\b|_REFUSED\b/i.test(output)) return { state: 'deferred', outcome: 'deferred', reason: reason || 'ASSIGN-DEFERRED' };
  if (/\bREFUSED\b|_REFUSED\b/i.test(output)) return { state: 'refused', outcome: 'refused', reason: reason || 'QUEUE-GATE-REFUSED' };
  if (child.signal || !Number.isSafeInteger(child.status)) return { state: 'refused', outcome: 'refused', reason: 'QUEUE-LAUNCH-INTERRUPTED' };
  if (child.status === 0 && /^RESULT exit=0 claimed(?:\s|$)/m.test(output)) return { state: 'launched', outcome: 'claimed', reason: 'CLAIMED' };
  return { state: 'refused', outcome: 'refused', reason: child.status === 0 ? 'QUEUE-LAUNCH-UNCONFIRMED' : 'QUEUE-LAUNCH-EXIT' };
}
function attempt(files, key, launch) {
  if (typeof launch !== 'function') fail('QUEUE-COMMAND');
  return withLock(files, names => {
    const rows = readQueue(names.queue);
    const log = readLog(names.log);
    if (used(log, key)) fail('QUEUE-REPLAY');
    const row = rows.find(r => r.key === key);
    if (!row) fail('QUEUE-NOT-FOUND');
    append(names.log, event(row, 'retired', 'unknown', 'QUEUE-ATTEMPT-RESERVED', 1));
    // Removal by equality, before launch, makes every result terminal. If a write
    // or the process fails, the durable reservation still prohibits replay.
    writeQueue(names.queue, rows.filter(r => r.key !== key));
    let child;
    try { child = launch(Object.freeze({ ...row })); } catch { child = { error: true }; }
    const result = classify(child);
    const entry = event(row, result.state, result.outcome, result.reason, result.state === 'deferred' ? 0 : 1,
      child && Number.isSafeInteger(child.status) ? child.status : null);
    // Back in the queue BEFORE the event: a crash between the two leaves the row queued under the reservation (the attempt stays spent, the safe side).
    if (result.state === 'deferred') writeQueue(names.queue, rows);
    append(names.log, entry);
    return entry;
  });
}

function main(argv) {
  try {
    const args = [...argv];
    const command = args.shift();
    const split = args.indexOf('--');
    const child = split < 0 ? [] : args.splice(split).slice(1);
    const opts = {};
    while (args.length) {
      const flag = args.shift();
      if (!['--queue', '--log', '--record', '--key', '--line'].includes(flag) || Object.hasOwn(opts, flag) || !args.length) fail('QUEUE-USAGE');
      opts[flag] = args.shift();
    }
    const allowed = command === 'add' ? ['--queue', '--log', '--record', '--line'] : command === 'list' ? ['--queue', '--log'] : ['--queue', '--log', '--key'];
    if (Object.keys(opts).some(k => !allowed.includes(k)) || (command !== 'attempt' && child.length)) fail('QUEUE-USAGE');
    const files = { queue: opts['--queue'], log: opts['--log'] };
    let result;
    if (command === 'add') {
      if (Boolean(opts['--record']) === Boolean(opts['--line'])) fail('QUEUE-USAGE');
      let row;
      try { row = opts['--line'] ? parseLegacyLine(opts['--line']) : JSON.parse(opts['--record']); } catch (e) { fail(e.code === 'QUEUE-FIELDS' ? e.code : 'QUEUE-RECORD'); }
      result = add(files, row);
    } else if (command === 'list') result = withLock(files, names => { readLog(names.log); return readQueue(names.queue); });
    else if (command === 'retire' && opts['--key']) result = retire(files, opts['--key']);
    else if (command === 'attempt' && opts['--key'] && child.length) {
      if (!path.isAbsolute(child[0])) fail('QUEUE-COMMAND');
      result = attempt(files, opts['--key'], row => {
        const argv = child.map(arg => arg.replace(/\{(key|client|stream|worktree)\}/g, (_, name) => row[name]));
        if (!path.isAbsolute(argv[0])) fail('QUEUE-COMMAND');
        return spawnSync(argv[0], argv.slice(1), { encoding: 'utf8', windowsHide: true, shell: false, timeout: 300000, maxBuffer: 1024 * 1024 });
      });
    } else fail('QUEUE-USAGE');
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return ['refused', 'precert-refused'].includes(result.outcome) ? 3 : result.outcome === 'deferred' ? 4 : 0;
  } catch (e) {
    process.stderr.write(`${/^QUEUE-[A-Z-]+$/.test(e.code || '') ? e.code : 'QUEUE-IO'}\n`);
    return 2;
  }
}
module.exports = { validate, parseLegacyLine, readQueue, readLog, add, retire, classify, attempt, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

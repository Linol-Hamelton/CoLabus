#!/usr/bin/env node
'use strict';
// run-and-record: run one command and append one launch-record/1 line to docs/ops/LAUNCHES-PILOT.jsonl of this repository.
//   node docs/ops/pilot-kit/run-and-record.cjs [--client C] [--model M] [--effort E] [--role R] [--stage S] [--task T] [--name N]
//        [--prompt-file F] [--log F --client-log-dir D] [--caller ID] [--journal F] -- <command> [args...]
// The command output passes through unchanged and its exit code is this process's exit code. No gates, no registry, no network.
// servedModel is recorded only when served-model.cjs is part of this kit (or of the checkout this file is run from) and finds it.
// --log F is evidence only together with --client-log-dir D, the CLIENT's own log directory: served-model.cjs reads the file itself (whole; a log
// above its read limit is an unreadable source, never a head-and-tail prefix) and only when F lies inside D and was written during the run; any other
// file is not evidence (a transcript the model wrote proves nothing).
// --export-dir is GONE. The export directory of a vibe run is a NEW EMPTY per-launch directory this kit creates itself
// (mkdtemp under the temporary directory; an existing path is never used) and passes to the command as `--output-dir`; the served model of a vibe
// run is proven only from that directory's export.json. A command that already passes --output-dir is refused: the kit owns the directory.
// The ONE derivation path is served-model.cjs deriveForLaunch(context) - this runner hands it
// the command it really ran (the argv, including the --output-dir it appended), the spawn environment, the streams it captured WHOLE AS BYTES
// (nothing here decodes a byte: the entry point is the only decode, and the decoded text comes back after the check) and the export directory,
// and records the requestedModelVia and the served-model proof it returns together.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..', '..', '..');
const KEEP = 256 * 1024;

// A module of the kit: <kit>/src/<repo-relative path> first, then the same path in the checkout this file lives in.
function load(rel) {
  for (const base of [path.join(__dirname, 'src'), REPO]) {
    const full = path.join(base, rel);
    if (fs.existsSync(full)) return require(full);
  }
  return null;
}

function parse(argv) {
  // An arbitrary --export-dir is never this launch's proof; the option is refused before anything starts
  if (argv.includes('--export-dir')) throw new Error('--export-dir is not accepted any more: the kit creates a new empty per-launch output directory itself and passes it to the command as --output-dir');
  const o = { cmd: [] };
  const names = { '--client': 'client', '--model': 'model', '--effort': 'effort', '--role': 'role', '--stage': 'stage', '--task': 'task', '--name': 'name',
    '--prompt-file': 'promptPath', '--log': 'log', '--client-log-dir': 'clientLogDir', '--caller': 'callerSession', '--journal': 'journal' };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--') { o.cmd = argv.slice(i + 1); break; }
    if (!Object.hasOwn(names, argv[i]) || i + 1 >= argv.length) throw new Error(`bad option: ${argv[i]}`);
    o[names[argv[i]]] = argv[++i];
  }
  if (!o.cmd.length) throw new Error('usage: run-and-record.cjs [options] -- <command> [args...]');
  return o;
}

function classify(signal, text) {
  if (signal) return 'INTERRUPTED';
  if (/\b429\b|rate limit|quota/i.test(text)) return 'QUOTA';
  if (/\b401\b|unauthori[sz]ed|invalid api key/i.test(text)) return 'AUTH';
  if (/ECONNRESET|ETIMEDOUT|socket hang up|EOF/i.test(text)) return 'TRANSPORT';
  return 'UNKNOWN';
}

const quoteWin = s => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`);
function gitOut(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return r.status === 0 ? r.stdout.trim() : null;
}

function runChild(cmd, cwd) {
  return new Promise(resolve => {
    const shell = process.platform === 'win32' && !/\.(exe|com)$/i.test(cmd[0]);
    const child = shell
      ? spawn(cmd.map(quoteWin).join(' '), { cwd, shell: true, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true })
      : spawn(cmd[0], cmd.slice(1), { cwd, stdio: ['inherit', 'pipe', 'pipe'], windowsHide: true });
    // The two streams are captured as BYTES and never decoded here - the ONE derivation path decodes them
    // (a damaged byte or an invisible character refuses the stream instead of becoming a replaced character), and any text this runner
    // shows or classifies is the decoded text it returned AFTER the check. KEEP caps the bytes kept for the derivation.
    let first = null;
    let last = null;
    const per = { out: { first: null, last: null, len: 0 }, err: { first: null, last: null, len: 0 } };
    const capTo = (buf, max) => (buf.length > max ? buf.subarray(0, max) : buf);
    const keep = (d, which) => {
      const buf = Buffer.isBuffer(d) ? d : Buffer.from(d);
      if (first === null) first = capTo(buf, KEEP);
      else if (first.length < KEEP) first = capTo(Buffer.concat([first, buf]), KEEP);
      last = last === null ? buf.subarray(-KEEP) : Buffer.concat([last, buf]).subarray(-KEEP);
      const p = per[which];
      p.len += buf.length;
      p.first = p.first === null ? capTo(buf, KEEP) : capTo(Buffer.concat([p.first, buf]), KEEP);
      p.last = p.last === null ? buf.subarray(-KEEP) : Buffer.concat([p.last, buf]).subarray(-KEEP);
    };
    // A stream that fits KEEP is whole in its head; a longer one is NEVER handed to the derivation as a head-and-tail
    // prefix (a second header block in the unread middle would be lost and the prefix could prove the first record alone): the runner
    // names the stream in unreadableStreams and the derivation gives unknown with the reason "stream above the read limit"
    const streamBytes = p => (p.len <= KEEP ? p.first : null);
    child.stdout.on('data', d => { process.stdout.write(d); keep(d, 'out'); });
    child.stderr.on('data', d => { process.stderr.write(d); keep(d, 'err'); });
    child.on('error', e => resolve({ code: 127, signal: null, first: Buffer.from(`${e.message}\n`), last: null, stdout: null, stderr: null, unreadableStreams: [], wholeCapture: true }));
    child.on('close', (code, signal) => resolve({ code, signal, first, last, stdout: streamBytes(per.out), stderr: streamBytes(per.err), unreadableStreams: [...(per.out.len > KEEP ? ['stdout'] : []), ...(per.err.len > KEEP ? ['stderr'] : [])], wholeCapture: per.out.len + per.err.len <= KEEP }));
  });
}

async function main(argv) {
  let o;
  try { o = parse(argv); } catch (e) { process.stderr.write(`run-and-record: ${e.message}\n`); return 2; }
  const record = load('.ai/bin/launch-record.cjs');
  const validator = load('.ai/bin/accounting/launch-record-validate.cjs');
  if (!record || !validator) { process.stderr.write('run-and-record: the kit is incomplete (launch-record.cjs or the validator is missing)\n'); return 2; }
  const cwd = process.cwd();
  const journal = path.resolve(cwd, o.journal || path.join(REPO, 'docs', 'ops', 'LAUNCHES-PILOT.jsonl'));
  const head = gitOut(cwd, ['rev-parse', 'HEAD']);
  const dirty = gitOut(cwd, ['status', '--porcelain=v1']);
  const startedAt = new Date();
  // A vibe run gets a NEW EMPTY per-launch directory this kit creates itself (mkdtemp never returns an existing
  // path) and the command is started with `--output-dir <dir>`; the served model is read only from that directory's export.json later.
  // A command that already passes --output-dir is refused: the kit owns the output directory of the launch.
  let exportDir;
  if (String(o.client || '').toLowerCase() === 'vibe') {
    if (o.cmd.includes('--output-dir')) { process.stderr.write('run-and-record: the command already passes --output-dir (the kit owns the per-launch output directory); nothing was started\n'); return 2; }
    try { exportDir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-and-record-export-')); }
    catch (e) { process.stderr.write(`run-and-record: EXPORT-DIR-FAILED code=${String((e && e.code) || 'UNKNOWN').replace(/[^A-Za-z0-9_]/g, '').slice(0, 40) || 'UNKNOWN'}; nothing was started\n`); return 2; }
    o.cmd = [...o.cmd, '--output-dir', exportDir];
  }
  const res = await runChild(o.cmd, cwd);
  const endedAt = new Date();

  let served = null;
  const sm = load('docs/ops/served-model.cjs');
  if (sm && typeof sm.deriveForLaunch === 'function') {
    // The ONE derivation path. The context is the run that really happened: the command this runner spawned
    // (its argv IS the real argv, the --output-dir of the kit's own new directory included), the spawn environment, the streams captured
    // whole as BYTES (a stream above KEEP is named unreadable instead, and so is the mixed capture when it does not fit
    // KEEP), the log file by name - read whole by served-model.cjs itself, only inside the client's own log directory - and the per-launch
    // export directory the kit created for a vibe run (PROTO-DEC-0215 item 1; its export.json is the only proof source of the run).
    const logFiles = o.log && o.clientLogDir ? [path.resolve(cwd, o.log)] : [];
    if (o.log && !o.clientLogDir) process.stderr.write('run-and-record: --log is not evidence without --client-log-dir (the client\'s own log directory); it is not read\n');
    const unreadableStreams = res.unreadableStreams || [];
    const wholeCapture = res.wholeCapture !== false;
    const capture = wholeCapture && res.first !== null ? Buffer.concat([res.first, Buffer.from('\n'), res.last || Buffer.alloc(0)]) : null;
    try {
      // The allow-list of a pilot run is the PROJECT's registry (P-L3-005: the registry is project-owned and the kit never
      // installs the development one); the runner hands the derivation the project's file when it exists, and without one the gate
      // refuses every id (fail-closed, exactly as an installed project without registered clients).
      const projectRegistry = path.join(REPO, '.ai', 'docs', 'clients.json');
      served = sm.deriveForLaunch({ client: o.client, model: o.model, args: o.cmd, env: process.env, capturedOutput: capture, stdout: res.stdout, stderr: res.stderr, ...(unreadableStreams.length ? { unreadableStreams } : {}), logFiles, clientLogDir: o.clientLogDir ? path.resolve(cwd, o.clientLogDir) : undefined, ...(exportDir ? { exportDir } : {}), ...(fs.existsSync(projectRegistry) ? { clientsFile: projectRegistry } : {}), startedAt: startedAt.toISOString(), endedAt: endedAt.toISOString(), workdir: cwd });
    } catch (e) { process.stderr.write(`run-and-record: served-model check failed: ${e.message}\n`); }
  }
  // The ONLY text this runner shows or classifies is the decoded text the ONE derivation path returned AFTER the check
  // (a capture that did not decode - refused bytes, or a stream above KEEP - has no text here: the failure class says UNKNOWN).
  const text = served && served.decoded && typeof served.decoded.capturedOutput === 'string' ? served.decoded.capturedOutput : '';
  const fields = {
    name: o.name || `${o.client || 'run'}-${crypto.randomBytes(2).toString('hex')}`, startedAt, endedAt,
    callerSession: o.callerSession || 'pilot-kit', client: o.client || 'unknown', model: o.model || null, effort: o.effort || null,
    task: o.task, role: o.role, stage: o.stage, exitCode: res.code === null ? null : res.code,
    ...record.recordPaths(cwd, o.promptPath && fs.existsSync(path.resolve(cwd, o.promptPath)) ? o.promptPath : undefined),
  };
  if (head && /^[0-9a-f]{7,40}$/.test(head)) { fields.head = head; fields.treeState = dirty ? 'dirty' : 'clean'; }
  if (res.code !== 0) fields.failureClass = classify(res.signal, text);
  const rec = record.buildLaunchRecord(fields);
  if (served && typeof served.requestedModelVia === 'string') rec.requestedModelVia = served.requestedModelVia;
  // The record fields travel inside the one return of the derivation (record); an old served-model copy without them
  // falls back to the fields of the result itself
  if (served && served.servedModel) Object.assign(rec, served.record || { servedModel: served.servedModel, servedModelSource: served.source, servedModelConfidence: served.confidence });

  const errors = validator.validateRecord(rec);
  const secret = errors.some(e => /secret-shaped/.test(e));
  for (const e of errors) process.stderr.write(`run-and-record: record WARN: ${e}\n`);
  if (secret) {
    process.stderr.write('run-and-record: the record contains a secret-shaped string; NOT written\n');
  } else {
    fs.mkdirSync(path.dirname(journal), { recursive: true });
    fs.appendFileSync(journal, `${JSON.stringify(rec)}\n`, 'utf8');
    process.stderr.write(`run-and-record: ${rec.launchId} exit=${rec.exitCode} served=${rec.servedModel || 'none'} -> ${path.relative(cwd, journal) || journal}\n`);
  }
  return res.code === null ? 1 : res.code;
}

if (require.main === module) main(process.argv.slice(2)).then(code => { process.exitCode = code; });

module.exports = { main, parse, classify };

#!/usr/bin/env node
'use strict';
// run-and-record: run one command and append one launch-record/1 line to  of this repository.
//   node docs/ops/pilot-kit/run-and-record.cjs [--client C] [--model M] [--effort E] [--role R] [--stage S] [--task T] [--name N]
//        [--prompt-file F] [--log F] [--caller ID] [--journal F] -- <command> [args...]
// The command output passes through unchanged and its exit code is this process's exit code. No gates, no registry, no network.
// servedModel is recorded only when served-model.cjs is part of this kit (or of the checkout this file is run from) and finds it.
const fs = require('node:fs');
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
  const o = { cmd: [] };
  const names = { '--client': 'client', '--model': 'model', '--effort': 'effort', '--role': 'role', '--stage': 'stage', '--task': 'task', '--name': 'name',
    '--prompt-file': 'promptPath', '--log': 'log', '--caller': 'callerSession', '--journal': 'journal' };
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
    let first = '';
    let last = '';
    const keep = d => {
      const s = d.toString('utf8');
      if (first.length < KEEP) first += s.slice(0, KEEP - first.length);
      last = (last + s).slice(-KEEP);
    };
    child.stdout.on('data', d => { process.stdout.write(d); keep(d); });
    child.stderr.on('data', d => { process.stderr.write(d); keep(d); });
    child.on('error', e => resolve({ code: 127, signal: null, first: `${e.message}\n`, last: '' }));
    child.on('close', (code, signal) => resolve({ code, signal, first, last }));
  });
}

async function main(argv) {
  let o;
  try { o = parse(argv); } catch (e) { process.stderr.write(`run-and-record: ${e.message}\n`); return 2; }
  const record = load('docs/ops/launch-record.cjs');
  const validator = load('docs/product/launch-records/tools/launch-record-validate.cjs');
  if (!record || !validator) { process.stderr.write('run-and-record: the kit is incomplete (launch-record.cjs or the validator is missing)\n'); return 2; }
  const cwd = process.cwd();
  const journal = path.resolve(cwd, o.journal || path.join(REPO, 'docs', 'ops', 'LAUNCHES-PILOT.jsonl'));
  const head = gitOut(cwd, ['rev-parse', 'HEAD']);
  const dirty = gitOut(cwd, ['status', '--porcelain=v1']);
  const startedAt = new Date();
  const res = await runChild(o.cmd, cwd);
  const endedAt = new Date();

  const text = `${res.first}\n${res.last}`;
  const fields = {
    name: o.name || `${o.client || 'run'}-${crypto.randomBytes(2).toString('hex')}`, startedAt, endedAt,
    callerSession: o.callerSession || 'pilot-kit', client: o.client || 'unknown', model: o.model || null, effort: o.effort || null,
    task: o.task, role: o.role, stage: o.stage, workdir: cwd, exitCode: res.code === null ? null : res.code,
    promptPath: o.promptPath && fs.existsSync(path.resolve(cwd, o.promptPath)) ? o.promptPath : undefined,
    promptSha256: o.promptPath && fs.existsSync(path.resolve(cwd, o.promptPath)) ? `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.resolve(cwd, o.promptPath))).digest('hex')}` : undefined,
  };
  if (head && /^[0-9a-f]{7,40}$/.test(head)) { fields.head = head; fields.treeState = dirty ? 'dirty' : 'clean'; }
  if (res.code !== 0) fields.failureClass = classify(res.signal, text);
  const rec = record.buildLaunchRecord(fields);

  let served = null;
  const sm = load('docs/ops/served-model.cjs');
  if (sm && typeof sm.deriveServedModel === 'function') {
    let captured = text;
    if (o.log) { try { captured += `\n${fs.readFileSync(path.resolve(cwd, o.log), 'utf8').slice(0, KEEP)}`; } catch { /* a missing log is simply no evidence */ } }
    try {
      served = sm.deriveServedModel({ client: o.client, requestedModel: o.model, capturedOutput: captured, startedAt: rec.startedAt, endedAt: rec.endedAt, workdir: cwd });
      if (served && served.servedModel) Object.assign(rec, typeof sm.recordFields === 'function' ? sm.recordFields(served) : { servedModel: served.servedModel });
    } catch (e) { process.stderr.write(`run-and-record: served-model check failed: ${e.message}\n`); }
  }

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

'use strict';
// Schedules of the operator layer: the state tick every tickMinutes
// (default 15), silence alert (default 20) and local proxy probe (default 1).
//   node .ai/bin/operator/schedule.cjs install [--root DIR] [--backend schtasks|cron|dry|off]
//   node .ai/bin/operator/schedule.cjs remove  [--root DIR] [--backend ...]
//   node .ai/bin/operator/schedule.cjs check   [--root DIR] [--backend ...]
// Opt-out: "operatorLayer": { "schedules": { "enabled": false } } in protocol-manifest.json; install then registers
// nothing and records the opt-out, and the validator stays quiet (CM-73).
// Backends: schtasks (Windows Task Scheduler, the default on Windows: one task per job, every N minutes, the current
// user, interactive), cron (other systems: nothing is changed, crontab lines are printed for the owner to add),
// Hosts without Cline can set schedules.proxyEnabled=false. Reinstall upgrades an old two-job receipt.
// dry (no system call; tests and product builds), off (nothing at all). The environment name COLABUS_SCHEDULER picks the
// backend when --backend is absent. The receipt RUNTIME/operator-schedules.json is what the validator reads.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const layer = require('./layer.cjs');
const realPath = require('../lib/real-path.cjs');

const BACKENDS = ['schtasks', 'cron', 'dry', 'off'];
const RECEIPT = 'operator-schedules.json';
const TR_LIMIT = 261;

function taskBase(root) {
  // A root without a provable real path throws: its spelling would name a second task for the same project.
  const real = realPath.physicalPathSync(root);
  const hash = crypto.createHash('sha256').update(real.replace(/\\/g, '/').toLowerCase()).digest('hex').slice(0, 8);
  const name = path.basename(real).replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 24) || 'project';
  return `CoLabus-${name}-${hash}`;
}
function jobs(root, settings) {
  const script = path.join(root, '.ai', 'bin', 'operator', 'layer.cjs');
  const base = taskBase(root);
  return [
    { id: 'tick', name: `${base}-tick`, everyMinutes: settings.schedules.tickMinutes, args: [script, 'tick', '--root', root] },
    { id: 'silence', name: `${base}-silence`, everyMinutes: settings.schedules.silenceMinutes, args: [script, 'silence', '--root', root] },
    // The proxy job names no --runtime: the probe reads the same operator settings and resolves the runtime dir
    // itself (RUNTIME/.ai/runtime by default). The extra absolute path only made the Task Scheduler command
    // longer than its 261 character limit, and the proxy job then never registered.
    ...(settings.schedules.proxyEnabled ? [{ id: 'proxy', name: `${base}-proxy`, everyMinutes: settings.schedules.proxyMinutes,
      args: [path.join(root, '.ai/bin/ops-tools/proxy-health.cjs'), 'tick', '--root', root] }] : []),
  ];
}
const quote = a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a);
const commandLine = (job, nodePath = process.execPath) => [nodePath, ...job.args].map(quote).join(' ');
// A project under the system temp directory is a scratch copy (tests, builds): without an explicit backend it gets dry,
// so no forgotten scratch install leaves a task in the scheduler of the machine.
function pickBackend(opt, env = process.env, root = null) {
  const explicit = opt || env.COLABUS_SCHEDULER;
  let b = explicit || (process.platform === 'win32' ? 'schtasks' : 'cron');
  if (!explicit && root && underTemp(root)) b = 'dry';
  if (!BACKENDS.includes(b)) throw new Error(`unknown scheduler backend ${b} (${BACKENDS.join('|')})`);
  return b;
}
function underTemp(root) {
  // Unknown counts as under temp: a root whose real path cannot be proven gets the dry backend, never a real task.
  const real = p => { try { return realPath.physicalPathSync(p); } catch { return null; } };
  const tReal = real(require('node:os').tmpdir());
  const rReal = real(root);
  if (tReal === null || rReal === null) return true;
  const t = tReal.replace(/\\/g, '/').toLowerCase();
  const r = rReal.replace(/\\/g, '/').toLowerCase();
  return r === t || r.startsWith(`${t}/`);
}
function schtasks(args, deps) {
  const r = (deps.spawnSync || spawnSync)('schtasks', args, { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  return { ok: !r.error && r.status === 0, status: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.trim() };
}
function receiptPath(root, settings) { return path.join(root, settings.runtime, RECEIPT); }
function writeReceipt(root, settings, rec) {
  const file = receiptPath(root, settings);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
}

function install(root, opts = {}, deps = {}) {
  const settings = opts.settings || layer.loadSettings(root);
  const backend = pickBackend(opts.backend, deps.env, root);
  const at = new Date().toISOString();
  const lines = [];
  if (!settings.schedules.enabled) {
    writeReceipt(root, settings, { schema: 'operator-schedules/1', root, at, backend, optOut: true, tasks: [] });
    return { code: 0, lines: ['SCHEDULES opt-out: operatorLayer.schedules.enabled is false; nothing registered'] };
  }
  if (backend === 'off') return { code: 0, lines: ['SCHEDULES off: COLABUS_SCHEDULER=off; nothing registered and no receipt written'] };
  const tasks = [];
  let failed = 0;
  for (const job of jobs(root, settings)) {
    const tr = commandLine(job, deps.nodePath);
    const rec = { id: job.id, name: job.name, everyMinutes: job.everyMinutes, command: tr };
    if (backend === 'dry') { rec.status = 'dry'; lines.push(`SCHEDULE dry ${job.name} every ${job.everyMinutes} min: ${tr}`); }
    else if (backend === 'cron') { rec.status = 'manual'; lines.push(`SCHEDULE manual: add this crontab line: */${job.everyMinutes} * * * * ${tr}`); }
    else if (tr.length > TR_LIMIT) { rec.status = 'failed'; rec.reason = 'TR_TOO_LONG'; failed++; lines.push(`SCHEDULE FAILED ${job.name}: the command is ${tr.length} characters, Task Scheduler takes ${TR_LIMIT}; move the project to a shorter path or register it by hand`); }
    else {
      const r = schtasks(['/Create', '/F', '/SC', 'MINUTE', '/MO', String(job.everyMinutes), '/TN', job.name, '/TR', tr], deps);
      rec.status = r.ok ? 'registered' : 'failed';
      if (!r.ok) { failed++; rec.reason = `schtasks exit ${r.status}`; }
      lines.push(`SCHEDULE ${r.ok ? 'registered' : 'FAILED'} ${job.name} every ${job.everyMinutes} min${r.ok ? '' : ` (schtasks exit ${r.status})`}`);
    }
    tasks.push(rec);
  }
  writeReceipt(root, settings, { schema: 'operator-schedules/1', root, at, backend, optOut: false, tasks });
  return { code: failed ? 1 : 0, lines };
}
function remove(root, opts = {}, deps = {}) {
  const settings = opts.settings || layer.loadSettings(root);
  const backend = pickBackend(opts.backend, deps.env, root);
  const lines = [];
  let failed = 0;
  for (const job of jobs(root, settings)) {
    if (backend !== 'schtasks') { lines.push(`SCHEDULE ${backend} ${job.name}: nothing to remove here${backend === 'cron' ? ' (remove the crontab line by hand)' : ''}`); continue; }
    const q = schtasks(['/Query', '/TN', job.name], deps);
    if (!q.ok) { lines.push(`SCHEDULE absent ${job.name}`); continue; }
    const r = schtasks(['/Delete', '/F', '/TN', job.name], deps);
    if (!r.ok) failed++;
    lines.push(`SCHEDULE ${r.ok ? 'removed' : 'REMOVE-FAILED'} ${job.name}`);
  }
  const file = receiptPath(root, settings);
  const old = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } })();
  if (old) writeReceipt(root, settings, { ...old, removedAt: new Date().toISOString(), tasks: (old.tasks || []).map(t => ({ ...t, status: 'removed' })) });
  return { code: failed ? 1 : 0, lines };
}
function check(root, opts = {}, deps = {}) {
  const settings = opts.settings || layer.loadSettings(root);
  const backend = pickBackend(opts.backend, deps.env, root);
  if (!settings.schedules.enabled) return { code: 0, lines: ['SCHEDULES opt-out'] };
  const lines = [];
  let missing = 0;
  for (const job of jobs(root, settings)) {
    if (backend !== 'schtasks') { lines.push(`SCHEDULE ${backend} ${job.name}: not checkable here`); continue; }
    const q = schtasks(['/Query', '/TN', job.name], deps);
    if (!q.ok) missing++;
    lines.push(`SCHEDULE ${q.ok ? 'present' : 'MISSING'} ${job.name}`);
  }
  return { code: missing ? 1 : 0, lines };
}

function main(argv, log = s => process.stdout.write(`${s}\n`), deps = {}) {
  const cmd = argv[0];
  const o = {};
  for (let i = 1; i < argv.length; i++) {
    if (['--root', '--backend'].includes(argv[i]) && i + 1 < argv.length) o[argv[i].slice(2)] = argv[++i];
    else { log(`usage error: unknown or incomplete argument ${argv[i]}`); return 2; }
  }
  if (!['install', 'remove', 'check'].includes(cmd)) { log('usage: schedule.cjs install|remove|check [--root DIR] [--backend schtasks|cron|dry|off]'); return 2; }
  const root = layer.mainRoot(path.resolve(o.root || process.cwd()));
  try {
    const r = ({ install, remove, check })[cmd](root, { backend: o.backend }, deps);
    for (const l of r.lines) log(l);
    return r.code;
  } catch (e) { log(`REFUSED ${e.message}`); return 2; }
}

module.exports = { BACKENDS, RECEIPT, taskBase, jobs, commandLine, pickBackend, install, remove, check, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('./lib/config.cjs');
const core = require('./lib/pulse-scan.cjs');
const { within } = require('./lib/worktrees.cjs');

function routeHealthLines(root, nowMs, deps = {}) {
  const io = deps.io || fs;
  const recordFile = path.join(root, 'docs/ops/route-state.json');
  if (!deps.routeHealth && !io.existsSync(recordFile)) return [];
  try {
    core.safePath(recordFile, io);
    const read = deps.routeHealth || (() => {
      const rs = require('../../../tools/operator-knowledge/route-state.cjs');
      const live = require('../../../tools/operator-knowledge/launch-evidence.cjs');
      const health = require('../../../tools/operator-knowledge/health.cjs');
      const schemaFile = path.join(root, 'docs/ops/route-state.schema.json');
      core.safePath(schemaFile, io);
      return health.health(rs.loadRecord(recordFile, { schemaFile }), live.readLiveLaunches(), new Date(nowMs).toISOString());
    });
    const h = read();
    return [`route health: ok=${h.counts.ok}/${h.total} failed=${h.counts.failed} unknown=${h.counts.unknown} at=${core.flat(h.at)}`,
      ...h.routes.filter(r => r.state !== 'ok').map(r => `route ${core.flat(r.id)} ${core.flat(r.state)}: ${core.flat(r.reasons.join(','))}`)];
  } catch (e) {
    if (/^PULSE-REFUSED/.test(e.code || e.message || '')) throw e;
    return ['route health UNREADABLE: run node tools/operator-knowledge/health.cjs'];
  }
}

// The flaky-test quarantine: the register state and every active row (a quarantined test is shown, never hidden).
function quarantineLines(root, nowMs, deps = {}) {
  try {
    return (deps.quarantine || require('../lib/flake-quarantine.cjs')).pulseLines(root, nowMs);
  } catch {
    return ['flake quarantine UNREADABLE: run node .ai/bin/ops-tools/flake-quarantine.cjs list'];
  }
}

function render(result, nowMs, trigger, capBytes = 12288) {
  if (!Number.isSafeInteger(capBytes) || capBytes < 1024 || capBytes > 1048576) throw new Error('PULSE-CAP-INVALID');
  const stamp = new Date(nowMs).toISOString();
  const header = `# Operator pulse ${stamp} (trigger: ${Array.from(core.flat(trigger)).slice(0, 80).join('')})`;
  const total = result.sections.reduce((n, s) => n + s.lines.length, 0);
  const kept = result.sections.map(() => []);
  const build = cut => [header, ...result.sections.flatMap((s, i) => ['', `## ${s.title}`, '', ...kept[i].map(l => `- ${l}`)]),
    '', `lines cut: ${cut}`, ''].join('\n');
  let shown = 0;
  // Reserve the longest closing counter before adding content; keep every heading.
  let used = Buffer.byteLength(build(total));
  for (let i = 0; i < result.sections.length; i++) {
    for (const line of result.sections[i].lines) {
      const bytes = Buffer.byteLength(`- ${line}\n`);
      if (used + bytes > capBytes) break;
      kept[i].push(line); used += bytes; shown++;
    }
  }
  const text = build(total - shown);
  if (Buffer.byteLength(text) > capBytes) throw new Error('PULSE-CAP-INVALID');
  return text;
}

function outputPath(outDir, cfg, io = fs) {
  const out = core.safePath(outDir, io);
  for (const root of [cfg.root, cfg.main]) {
    if (within(out, root) || within(root, out)) throw new Error('PULSE-REFUSED-OUTPUT-TREE');
  }
  for (let p = out; ; p = path.dirname(p)) {
    core.safePath(path.join(p, '.git'), io);
    if (io.existsSync(path.join(p, '.git'))) throw new Error('PULSE-REFUSED-OUTPUT-TREE');
    if (p === path.dirname(p)) break;
  }
  return out;
}

function main(argv, deps = {}) {
  const io = deps.io || fs;
  const env = deps.env || process.env;
  const stdout = deps.stdout || (s => process.stdout.write(s));
  const stderr = deps.stderr || (s => process.stderr.write(s));
  try {
    const args = {};
    for (let i = 0; i < argv.length; i++) {
      const key = argv[i];
      if (key === '--help' && argv.length === 1) {
        stdout('usage: pulse.cjs [trigger-name] [--trigger NAME] [--now ISO] [--root DIR] [--out-dir DIR]\n');
        return 0;
      }
      if (['--trigger', '--now', '--root', '--out-dir'].includes(key)) {
        if (args[key] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('PULSE-USAGE');
        args[key] = argv[++i];
      } else if (!key.startsWith('-') && args['--trigger'] === undefined) args['--trigger'] = key;
      else throw new Error('PULSE-USAGE');
    }
    const rawNow = args['--now'] || env.COLABUS_PULSE_NOW;
    if (rawNow && !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{3})?Z$/.test(rawNow)) throw new Error('PULSE-NOW-INVALID');
    const nowMs = rawNow ? Date.parse(rawNow) : Date.now();
    if (!Number.isFinite(nowMs)) throw new Error('PULSE-NOW-INVALID');
    if (rawNow && new Date(nowMs).toISOString() !== rawNow.replace(/Z$/, rawNow.includes('.') ? 'Z' : '.000Z')) throw new Error('PULSE-NOW-INVALID');
    for (const value of [args['--root'], args['--out-dir'], env.PROTOCOL_OPS_WORK_ROOT]) core.refuseProtected(value);
    const root = core.safePath(path.resolve(args['--root'] || process.cwd()), io);
    // Guard config reads too, before the shared loader follows workRoot/localConfig.
    let configRefusal;
    const guardedRead = f => {
      try {
        const text = io.readFileSync(core.safePath(f, io), 'utf8');
        let data;
        try { data = JSON.parse(text); } catch { return text; }
        for (const value of [data?.workRoot, data?.operatorLayer?.runtime, data?.pulse?.outDir, data?.pulse?.queueDir, data?.pulse?.beatDir,
          data?.pulse?.registerPath, data?.pulse?.backlogPath]) core.refuseProtected(value);
        return text;
      }
      catch (e) { if (/^PULSE-REFUSED/.test(e.code || '')) configRefusal = e; throw e; }
    };
    let cfg;
    try { cfg = deps.config || config.load({ root, env, readFile: guardedRead,
      exists: f => io.existsSync(core.safePath(f, io)) });
    } catch (e) { throw configRefusal || e; }
    if (configRefusal) throw configRefusal;
    for (const p of [cfg.root, cfg.main, cfg.workRoot, cfg.runtimeDir, cfg.receiptRoot]) core.safePath(p, io);
    const pulse = cfg.config.pulse || {};
    for (const key of ['registerPath', 'backlogPath']) {
      core.refuseProtected(pulse[key]);
      if (pulse[key] !== undefined && (typeof pulse[key] !== 'string' || !pulse[key])) throw new Error('PULSE-CONFIG-INVALID');
    }
    for (const key of ['outDir', 'queueDir', 'beatDir']) {
      core.refuseProtected(pulse[key]);
      if (pulse[key] !== undefined) core.safePath(path.resolve(cfg.workRoot, pulse[key]), io);
    }
    const out = outputPath(path.resolve(cfg.workRoot, args['--out-dir'] || pulse.outDir || 'auto/pulse'), cfg, io);
    const stamp = new Date(nowMs).toISOString().replace(/[-:.]/g, '');
    const targets = [path.join(out, `PULSE-${stamp}.md`), path.join(out, 'LATEST.md')];
    for (const f of targets) core.safePath(f, io);
    const snapshot = core.load(root, { ...cfg, io, pulse, nowMs, git: deps.git, caps: deps.caps,
      kill: deps.kill, maxAgeMs: cfg.seat.maxAgeMs, endMarker: cfg.seat.endMarker, baseRef: cfg.author?.baseRef,
      launchRecordsDir: deps.launchRecordsDir, recordsEnv: env });
    if (!snapshot.ok && /^PULSE-REFUSED/.test(snapshot.code)) throw new Error(snapshot.code);
    const result = core.scan(snapshot, nowMs);
    result.sections[4].lines.unshift(...routeHealthLines(root, nowMs, deps), ...quarantineLines(root, nowMs, deps));
    const text = render(result, nowMs, args['--trigger'] || 'manual', pulse.capBytes);
    io.mkdirSync(out, { recursive: true });
    for (const file of targets) {
      core.safePath(file, io);
      io.writeFileSync(file, text, { encoding: 'utf8', flag: 'w' });
    }
    const unknown = !snapshot.ok || snapshot.errors.length > 0;
    const count = value => value === null ? 'UNKNOWN' : value;
    stdout(`PULSE ${unknown ? 'UNREADABLE' : 'written'}: streams=${count(result.counts.streams)} stale=${count(result.counts.stale)} failed=${count(result.counts.failed)}\n`);
    return 0;
  } catch (e) { stderr(`${core.flat(e.code?.startsWith('PULSE-') ? e.code : e.message)}\n`); return 2; }
}

module.exports = { render, outputPath, routeHealthLines, quarantineLines, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const config = require('./lib/config.cjs');
const core = require('./lib/pulse-scan.cjs');
const { within } = require('./lib/worktrees.cjs');
const realPath = require('../lib/real-path.cjs');

// The switch of the real-path walk in this environment: one line only while it is not on (off, force or invalid).
function realPathLines(env) {
  const s = realPath.create({ env, platform: 'win32' }).state();
  if (s.switch === 'on') return [];
  const effect = s.switch === 'force' ? 'every drive volume is walked' : 'a volume without a Mount Manager name (a RAM disk) stays unreadable';
  return [`real path walk ${s.switch}: ${s.variable}=${core.flat(String(env[s.variable]).slice(0, 16))}; ${effect}`];
}

// The reset time of a quota failure (route health quotaReset): the time and where it comes from, or unknown when nothing names one.
const RESET_SOURCES = ['client-text', 'route-declaration', 'none'];
function quotaLine(q) {
  if (!q || typeof q !== 'object' || !RESET_SOURCES.includes(q.source)) return '';
  const at = typeof q.at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(q.at) ? q.at : 'unknown';
  return `; quota reset ${at} (${q.source})`;
}
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
      ...h.routes.filter(r => r.state !== 'ok').map(r => `route ${core.flat(r.id)} ${core.flat(r.state)}: ${core.flat(r.reasons.join(','))}${quotaLine(r.quotaReset)}`)];
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

// The discipline guards (discipline.cjs): idle ready work, owed findings, deferrals, the train tip run, host
// exclusions and the operator journal; no line while the config carries no discipline section.
function disciplineLines(cfg, nowMs, deps = {}) {
  try {
    return (deps.discipline || require('./discipline.cjs').pulseLines)(cfg, nowMs, deps);
  } catch {
    return ['discipline guards UNREADABLE: run node .ai/bin/ops-tools/discipline.cjs lines'];
  }
}

// Guard lines are reserved like alarms: the report cap never cuts them before inventory lines.
const GUARD_LINE = /^(?:IDLE-ALARM|FINDING-OWED|DEFERRAL-OVERDUE|TIP-RUN-DUE|HOST-REVIEW-DUE|OPERATOR-SILENT) /;

function render(result, nowMs, trigger, capBytes = 12288) {
  if (!Number.isSafeInteger(capBytes) || capBytes < 1024 || capBytes > 1048576) throw new Error('PULSE-CAP-INVALID');
  const stamp = new Date(nowMs).toISOString();
  const header = `# Operator pulse ${stamp} (trigger: ${Array.from(core.flat(trigger)).slice(0, 80).join('')})`;
  const total = result.sections.reduce((n, s) => n + s.lines.length, 0);
  const kept = result.sections.map(() => []);
  const selected = result.sections.map(() => new Set());
  const build = cut => [header, ...result.sections.flatMap((s, i) => ['', `## ${s.title}`, '', ...kept[i].map(l => `- ${l}`)]),
    '', `lines cut: ${cut}`, ''].join('\n');
  let shown = 0;
  // Reserve the longest closing counter before adding content; keep every heading.
  let used = Buffer.byteLength(build(total));
  // Reserve alarms and duration comparisons before a large package inventory can
  // consume the report cap. Final output retains source order within each section.
  for (const pattern of [/^ALARM /, GUARD_LINE, /: today=/]) for (let i = 0; i < result.sections.length; i++) {
    for (const [j, line] of result.sections[i].lines.entries()) if (pattern.test(line) && !selected[i].has(j)) {
      const bytes = Buffer.byteLength(`- ${line}\n`);
      if (used + bytes <= capBytes) { selected[i].add(j); used += bytes; shown++; }
    }
  }
  for (let i = 0; i < result.sections.length; i++) {
    for (const [j, line] of result.sections[i].lines.entries()) {
      if (selected[i].has(j)) continue;
      const bytes = Buffer.byteLength(`- ${line}\n`);
      if (used + bytes > capBytes) break;
      selected[i].add(j); used += bytes; shown++;
    }
    kept[i] = result.sections[i].lines.filter((_, j) => selected[i].has(j));
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
        for (const value of [data?.workRoot, data?.operatorLayer?.runtime, data?.pulse?.outDir, data?.pulse?.queueDir, data?.pulse?.beatDir, data?.pulse?.resultsDir,
          data?.pulse?.registerPath, data?.pulse?.backlogPath, data?.pulse?.classRegistryPath,
          data?.pulse?.classWeightsPath, data?.pulse?.priceSnapshotDir, data?.pulse?.routeStatePath]) core.refuseProtected(value);
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
    for (const key of ['registerPath', 'backlogPath', 'classRegistryPath', 'classWeightsPath', 'priceSnapshotDir', 'routeStatePath']) {
      core.refuseProtected(pulse[key]);
      if (pulse[key] !== undefined && (typeof pulse[key] !== 'string' || !pulse[key])) throw new Error('PULSE-CONFIG-INVALID');
    }
    for (const key of ['outDir', 'queueDir', 'beatDir', 'resultsDir']) {
      core.refuseProtected(pulse[key]);
      if (pulse[key] !== undefined && (typeof pulse[key] !== 'string' || !pulse[key])) throw new Error('PULSE-CONFIG-INVALID');
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
    // A data line never reads as a guard line: only the guard pass below writes one.
    for (const section of result.sections) section.lines = section.lines.map(line => GUARD_LINE.test(line) ? `data: ${line}` : line);
    result.sections[4].lines.unshift(...realPathLines(env), ...routeHealthLines(root, nowMs, deps), ...quarantineLines(root, nowMs, deps),
      ...(cfg.config.discipline === undefined ? [] : disciplineLines(cfg, nowMs, { ...deps, env })));
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

module.exports = { render, outputPath, routeHealthLines, realPathLines, quarantineLines, disciplineLines, GUARD_LINE, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

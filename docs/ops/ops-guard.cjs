'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const STATUSES = ['building', 'ready', 'certifying', 'certified', 'landed', 'void', 'superseded'];
const LIVE = new Set(['building', 'ready', 'certifying', 'certified']);
const DEAD = new Set(['void', 'superseded']);

function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: (r.stdout || '').trim() };
}
function mainRoot(repo) {
  const r = git(repo, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (r.code === 0 && r.out) return path.resolve(r.out, '..');
  return path.resolve(repo);
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tips') o.tips = true;
    else if (['--file', '--claims', '--repo', '--now', '--stream', '--owner', '--worktree', '--ttl', '--register'].includes(a)) o[a.slice(2)] = argv[++i];
    else if (a.startsWith('--')) return { error: `unknown option ${a}` };
    else o._.push(a);
  }
  return o;
}

function readRegistry(file) {
  if (!fs.existsSync(file)) throw new Error(`registry not found: ${file} (create it from docs/ops/CANDIDATES-TEMPLATE.md)`);
  const rows = [];
  const problems = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const t = line.trim();
    if (!t.startsWith('|') || /^\|\s*-/.test(t) || /^\|\s*stream\s*\|/i.test(t)) return;
    const c = t.replace(/^\||\|$/g, '').split('|').map(x => x.trim());
    if (c.length < 6) { problems.push(`line ${i + 1}: needs 6 columns (stream | branch | sha | owner | status | updated | note)`); return; }
    const [stream, branch, sha, owner, status, updated, note] = c;
    if (!/^[a-z0-9][a-z0-9-]*$/.test(stream)) problems.push(`line ${i + 1}: bad stream "${stream}"`);
    if (!/^[0-9a-f]{7,40}$/.test(sha)) problems.push(`line ${i + 1}: sha "${sha}" is not 7..40 hex`);
    if (!STATUSES.includes(status)) problems.push(`line ${i + 1}: status "${status}" is not one of ${STATUSES.join(', ')}`);
    if (!owner) problems.push(`line ${i + 1}: owner is empty`);
    rows.push({ line: i + 1, stream, branch, sha, owner, status, updated, note: note || '' });
  });
  return { rows, problems };
}

function currentOf(rows, stream) {
  const live = rows.filter(r => r.stream === stream && LIVE.has(r.status));
  return { live, current: live[live.length - 1] || null };
}

function validate(file, repo, tips) {
  const { rows, problems } = readRegistry(file);
  const streams = [...new Set(rows.map(r => r.stream))];
  for (const s of streams) {
    const { live } = currentOf(rows, s);
    if (live.length > 1) problems.push(`stream "${s}" has ${live.length} live candidates (${live.map(r => r.branch + '@' + r.sha).join(', ')}); mark all but one void or superseded`);
  }
  for (const r of rows) {
    if (git(repo, ['cat-file', '-e', `${r.sha}^{commit}`]).code !== 0) problems.push(`line ${r.line}: ${r.sha} is not a commit of this repository`);
    if (tips && LIVE.has(r.status)) {
      const tip = git(repo, ['rev-parse', '--verify', r.branch]);
      if (tip.code !== 0) problems.push(`line ${r.line}: branch "${r.branch}" does not exist`);
      else if (!tip.out.startsWith(r.sha)) problems.push(`line ${r.line}: STALE - ${r.branch} is at ${tip.out.slice(0, 9)}, the registry says ${r.sha}; update the row (and re-pin launchers)`);
    }
  }
  return { rows, problems, streams };
}

function pinCheck(rows, stream, files) {
  const { current } = currentOf(rows, stream);
  const problems = [];
  if (!current) return { problems: [`stream "${stream}" has no live candidate`], warnings: [] };
  const others = rows.filter(r => r.stream === stream && r !== current);
  const warnings = [];
  for (const f of files) {
    if (!fs.existsSync(f)) { problems.push(`${f}: not found`); continue; }
    const text = fs.readFileSync(f, 'utf8');
    const tokens = new Set(text.match(/\b[0-9a-f]{7,40}\b/g) || []);
    for (const o of others) {
      const hit = [...tokens].some(t => t.startsWith(o.sha) || o.sha.startsWith(t));
      if (hit && !(current.sha.startsWith(o.sha) || o.sha.startsWith(current.sha))) problems.push(`${f}: names ${o.sha} (${o.branch}, ${o.status}), not the live candidate ${current.sha}`);
      if (o.branch !== current.branch && new RegExp(`(^|[^A-Za-z0-9._/-])${o.branch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^A-Za-z0-9._-])`).test(text)) problems.push(`${f}: names branch "${o.branch}" (${o.status}), the live branch is "${current.branch}"`);
    }
    if (![...tokens].some(t => t.startsWith(current.sha) || current.sha.startsWith(t))) warnings.push(`${f}: does not name the live candidate ${current.sha}`);
  }
  return { problems, warnings, current };
}

function readClaims(file) {
  try { const c = JSON.parse(fs.readFileSync(file, 'utf8')); return Array.isArray(c.claims) ? c.claims : []; } catch { return []; }
}
function writeClaims(file, claims) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ claims }, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}
const alive = (c, now) => Date.parse(c.since) + c.ttlMin * 60000 > now;

const REGISTER_STATUSES = ['implemented', 'partial', 'proposed', 'retired'];
const PATH_PATTERN = /(?:docs|\.ai|\.kilo|tests)\/[A-Za-z0-9._\/-]+\.(?:md|cjs|json)/g;
// The register of operating processes (docs/ops/PROCESS-REGISTER.md): one row per process, so a process that was built is not forgotten.
function checkRegister(file, rootOrRoots) {
  const roots = [].concat(rootOrRoots);
  if (!fs.existsSync(file)) throw new Error(`register not found: ${file}`);
  const problems = [];
  const ids = new Set();
  let rows = 0;
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    const t = line.trim();
    if (!t.startsWith('|') || /^\|\s*-/.test(t) || /^\|\s*id\s*\|/i.test(t)) return;
    const c = t.replace(/^\||\|$/g, '').split('|').map(x => x.trim());
    rows++;
    if (c.length < 9) { problems.push(`line ${i + 1}: needs 9 columns (id | process | since | trigger | command | documented in | owner | enforced by | status)`); return; }
    const [id, name, since, trigger, command, doc, owner, enforced, status] = c;
    if (!/^P-\d{2,3}$/.test(id)) problems.push(`line ${i + 1}: id "${id}" is not P-NN`);
    if (ids.has(id)) problems.push(`line ${i + 1}: duplicate id ${id}`);
    ids.add(id);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(since)) problems.push(`line ${i + 1}: ${id} since "${since}" is not YYYY-MM-DD`);
    for (const [k, v] of Object.entries({ name, trigger, command, doc, owner, enforced })) if (!v) problems.push(`line ${i + 1}: ${id} ${k} is empty`);
    if (!REGISTER_STATUSES.includes(status)) problems.push(`line ${i + 1}: ${id} status "${status}" is not one of ${REGISTER_STATUSES.join(', ')}`);
    if (status === 'implemented' || status === 'partial') {
      for (const p of new Set(`${command} ${doc}`.match(PATH_PATTERN) || [])) {
        if (!roots.some(r => fs.existsSync(path.join(r, p)))) problems.push(`line ${i + 1}: ${id} names ${p}, which does not exist`);
      }
    }
  });
  return { rows, problems };
}

function main(argv) {
  const cmd = argv[0];
  const o = parseArgs(argv.slice(1));
  if (!cmd || o.error) { process.stderr.write(`${o.error || 'usage: ops-guard.cjs candidates|pin-check|claim|release|status|launch-gate [options]'}\n`); return 2; }
  const repo = path.resolve(o.repo || process.cwd());
  const root = mainRoot(repo);
  const registry = path.resolve(o.file || path.join(root, '.ai', 'runtime', 'CANDIDATES.md'));
  const claimsFile = path.resolve(o.claims || path.join(path.dirname(registry), 'claims.json'));
  const now = o.now ? Date.parse(o.now) : Date.now();
  if (Number.isNaN(now)) { process.stderr.write('--now must be an ISO time\n'); return 2; }
  const say = s => process.stdout.write(`${s}\n`);

  try {
    if (cmd === 'candidates') {
      const v = validate(registry, repo, o.tips);
      for (const s of v.streams) { const c = currentOf(v.rows, s).current; say(`stream ${s}: ${c ? `${c.branch} @ ${c.sha} (${c.status}, owner ${c.owner})` : 'no live candidate'}`); }
      v.problems.forEach(p => say(`PROBLEM ${p}`));
      say(`RESULT exit=${v.problems.length ? 1 : 0} streams=${v.streams.length} rows=${v.rows.length} problems=${v.problems.length}`);
      return v.problems.length ? 1 : 0;
    }
    if (cmd === 'register') {
      // Files a row names are looked for in the checkout being checked AND in the main checkout: in a linked worktree a new row
      // names new files that exist only there until the branch lands, while untracked runtime files (.ai/runtime/...) exist only in
      // the main checkout (CLEANUP-C found `register` failing on every unlanded branch).
      const top = git(repo, ['rev-parse', '--show-toplevel']);
      const base = top.code === 0 && top.out ? path.resolve(top.out) : root;
      const file = path.resolve(o.register || path.join(base, 'docs', 'ops', 'PROCESS-REGISTER.md'));
      const r = checkRegister(file, [...new Set([base, root])]);
      r.problems.forEach(p => say(`PROBLEM ${p}`));
      say(`RESULT exit=${r.problems.length ? 1 : 0} processes=${r.rows} problems=${r.problems.length}`);
      return r.problems.length ? 1 : 0;
    }
    if (cmd === 'pin-check') {
      if (!o.stream || !o._.length) { process.stderr.write('pin-check needs --stream and at least one file\n'); return 2; }
      const { rows, problems: reg } = readRegistry(registry);
      const r = pinCheck(rows, o.stream, o._);
      [...reg, ...r.problems].forEach(p => say(`PROBLEM ${p}`));
      r.warnings.forEach(w => say(`WARN ${w}`));
      say(`RESULT exit=${reg.length + r.problems.length ? 1 : 0} files=${o._.length}`);
      return reg.length + r.problems.length ? 1 : 0;
    }
    if (cmd === 'claim' || cmd === 'release') {
      if (!o.stream || !o.owner) { process.stderr.write(`${cmd} needs --stream and --owner\n`); return 2; }
      const all = readClaims(claimsFile);
      const live = all.filter(c => alive(c, now));
      if (cmd === 'release') {
        const next = all.filter(c => !(c.stream === o.stream && c.owner === o.owner));
        writeClaims(claimsFile, next.filter(c => alive(c, now)));
        say(`RESULT exit=0 released=${all.length - next.length}`);
        return 0;
      }
      const clash = live.find(c => c.owner !== o.owner && (c.stream === o.stream || (o.worktree && c.worktree && path.resolve(c.worktree) === path.resolve(o.worktree))));
      if (clash) { say(`REFUSED stream ${clash.stream} / worktree ${clash.worktree || '-'} is claimed by ${clash.owner} since ${clash.since} (ttl ${clash.ttlMin} min); wait, ask the owner, or let the claim expire`); say('RESULT exit=1'); return 1; }
      const ttl = Number(o.ttl || 120);
      if (!Number.isInteger(ttl) || ttl < 1) { process.stderr.write('--ttl must be a positive integer (minutes)\n'); return 2; }
      const kept = live.filter(c => !(c.stream === o.stream && c.owner === o.owner));
      kept.push({ stream: o.stream, owner: o.owner, worktree: o.worktree ? path.resolve(o.worktree) : null, since: new Date(now).toISOString(), ttlMin: ttl });
      writeClaims(claimsFile, kept);
      say(`RESULT exit=0 claimed stream=${o.stream} owner=${o.owner} ttl=${ttl}`);
      return 0;
    }
    if (cmd === 'status') {
      const claims = readClaims(claimsFile);
      if (!claims.length) say('no claims');
      for (const c of claims) say(`${alive(c, now) ? 'LIVE   ' : 'EXPIRED'} stream=${c.stream} owner=${c.owner} worktree=${c.worktree || '-'} since=${c.since} ttl=${c.ttlMin}`);
      say('RESULT exit=0');
      return 0;
    }
    if (cmd === 'launch-gate') {
      if (!o.stream || !o.owner || !o._.length) { process.stderr.write('launch-gate needs --stream, --owner and at least one launcher or prompt file\n'); return 2; }
      const v = validate(registry, repo, true);
      const problems = [...v.problems];
      const claim = readClaims(claimsFile).find(c => alive(c, now) && c.stream === o.stream);
      if (!claim) problems.push(`no live claim on stream "${o.stream}": run ops-guard claim first`);
      else if (claim.owner !== o.owner) problems.push(`stream "${o.stream}" is claimed by ${claim.owner}, not ${o.owner}`);
      const p = pinCheck(v.rows, o.stream, o._);
      problems.push(...p.problems);
      problems.forEach(x => say(`PROBLEM ${x}`));
      p.warnings.forEach(w => say(`WARN ${w}`));
      say(`RESULT exit=${problems.length ? 1 : 0} stream=${o.stream} candidate=${p.current ? `${p.current.branch}@${p.current.sha}` : 'none'}`);
      return problems.length ? 1 : 0;
    }
    process.stderr.write(`unknown command ${cmd}\n`);
    return 2;
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }
}

module.exports = { readRegistry, validate, pinCheck, currentOf, checkRegister, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

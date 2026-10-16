'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { decode, parseJsonUnique } = require('../../.ai/bin/lib/text-safe.cjs');
const paths = require('../../.ai/bin/lib/path-safe.cjs');
const numbers = require('../../tools/operator/closed-number.cjs');
const repoPaths = require('../../.ai/bin/repo-paths.cjs');
const ownerIdentity = require('../../.ai/bin/lib/owner-identity.cjs');
const refuse = code => { throw new Error(code); };
const STREAM = /^[a-z0-9][a-z0-9-]{0,127}$/;

function safeMachineId(raw) {
  return ownerIdentity.safeMachineId(raw);
}

function parseOwner(rawOwner, explicitMachine = null) {
  return ownerIdentity.parseOwnerIdentity(rawOwner, explicitMachine);
}
const sameOwner = (a,b) => a.namespaced === b.namespaced;

const STATUSES = ['building', 'ready', 'certifying', 'certified', 'landed', 'void', 'superseded'];
const LIVE = new Set(['building', 'ready', 'certifying', 'certified']);
const DEAD = new Set(['void', 'superseded']);

function git(repo, args) {
  const r = spawnSync('git', args, { cwd: repo, encoding: 'utf8', windowsHide: true });
  return { code: r.status, out: (r.stdout || '').trim() };
}
function mainRoot(repo) {
  return repoPaths.mainRoot(repo);
}

function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tips') o.tips = true;
    else if (['--file', '--claims', '--repo', '--now', '--stream', '--owner', '--worktree', '--ttl', '--register', '--machine', '--preferred'].includes(a)) {
      if (i + 1 >= argv.length || argv[i+1].startsWith('--') || Object.hasOwn(o,a.slice(2))) return { error:'missing or duplicate option value' };
      o[a.slice(2)] = argv[++i];
    }
    else if (a.startsWith('--')) return { error: `unknown option ${a}` };
    else o._.push(a);
  }
  return o;
}

function readRegistry(file) {
  if (!fs.existsSync(file)) throw new Error(`registry not found: ${file} (create it from docs/ops/CANDIDATES-TEMPLATE.md)`);
  const {parseRegistry}=require('../../.ai/bin/lib/candidate-registry.cjs');
  try {
    const parsed=parseRegistry(fs.readFileSync(file));
    return {rows:parsed.rows.map(({index,cells})=>{
      const [stream,branch,sha,owner,status,updated,note]=cells;
      return {line:index+1,stream,branch,sha,owner,status,updated,note};
    }),problems:[]};
  } catch(error) {
    if(error.code!=='invalid-registry')throw error;
    return {rows:[],problems:[error.reason ? `invalid-registry: ${error.reason} (line ${error.line})` : 'invalid-registry']};
  }
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
    if (s.startsWith('desk-')) {
      const base = s.slice(5);
      if (streams.includes(base)) {
        const liveDesk = currentOf(rows, s).current;
        const liveBase = currentOf(rows, base).current;
        if (liveDesk && liveBase) {
          problems.push(`cross-machine stream collision: desktop stream "${s}" and laptop stream "${base}" are both live candidates (${liveDesk.branch}@${liveDesk.sha} vs ${liveBase.branch}@${liveBase.sha})`);
        }
      }
    }
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
  const guard = paths.realInside(path.parse(file).root,file,{refuseHardlinks:true});
  if (!guard.ok) refuse('CLAIMS_PATH_REFUSED');
  if (!guard.exists) return [];
  const read = paths.readFileGuarded(path.parse(file).root,file);
  if (!read.ok) refuse('CLAIMS_READ_REFUSED');
  const decoded = decode(read.bytes,{bom:'strip',crlf:'normalise',invisible:'refuse'});
  if (!decoded.ok) refuse('CLAIMS_TEXT_REFUSED');
  const c = parseJsonUnique(decoded.text);
  if (!c || Array.isArray(c) || typeof c !== 'object' || !Array.isArray(c.claims) || Object.keys(c).some(k=>k!=='claims')) refuse('CLAIMS_SCHEMA');
  const streams = new Set();
  for (const row of c.claims) {
    if (!row || typeof row !== 'object' || typeof row.stream !== 'string' || !STREAM.test(row.stream) || streams.has(row.stream)) refuse('CLAIMS_SCHEMA');
    streams.add(row.stream);
    const identity = parseOwner(row.owner,row.machine);
    if (row.namespacedOwner !== undefined && row.namespacedOwner !== identity.namespaced) refuse('CLAIMS_IDENTITY');
    if (typeof row.since !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(row.since) || !Number.isFinite(Date.parse(row.since))
        || !Number.isSafeInteger(row.ttlMin) || row.ttlMin < 1 || row.ttlMin > 525600
        || (row.worktree !== undefined && row.worktree !== null && (typeof row.worktree !== 'string' || !path.isAbsolute(row.worktree)))) refuse('CLAIMS_SCHEMA');
  }
  return c.claims;
}
function writeClaims(file, claims) {
  const written = paths.writeAtomicGuarded(file,Buffer.from(JSON.stringify({claims},null,2)+'\n'),{root:path.dirname(file)});
  if (!written.ok) refuse('CLAIMS_WRITE_REFUSED');
}
function withClaimsTransaction(file, action) {
  const parent = path.dirname(file);
  const guard = paths.realInside(path.parse(file).root,file,{refuseHardlinks:true});
  if (!guard.ok) refuse('CLAIMS_PATH_REFUSED');
  fs.mkdirSync(parent,{recursive:true});
  const result = paths.withDirectoryPinned(parent,() => {
    const lock = `${file}.lock`;
    const check = paths.realInside(path.parse(file).root,lock,{refuseHardlinks:true});
    if (!check.ok || check.exists) return {ok:false,reason:'CLAIMS_BUSY'};
    let fd;
    try { fd = fs.openSync(lock,'wx'); } catch { return {ok:false,reason:'CLAIMS_BUSY'}; }
    try { return {ok:true,fd,id:fs.fstatSync(fd,{bigint:true}),lock}; }
    catch {
      try { fs.closeSync(fd); } finally { fs.unlinkSync(lock); }
      return {ok:false,reason:'CLAIMS_TRANSACTION_REFUSED'};
    }
  });
  if (!result.ok) refuse(result.reason || 'CLAIMS_TRANSACTION_REFUSED');
  // The open lock file retains the parent chain pin on Windows. Do not retain
  // an exclusive directory handle during atomic publication (NTFS rename).
  try { return action(); }
  finally {
    // Always release the descriptor before another filesystem operation,
    // including guards that may throw when the lock disappears.
    fs.closeSync(result.fd);
    let matches = false;
    try {
      const post = paths.realInside(path.parse(file).root,result.lock,{refuseHardlinks:true});
      if (post.ok && post.exists) {
        const id = fs.lstatSync(result.lock,{bigint:true});
        matches = id.ino === result.id.ino && id.dev === result.id.dev;
      }
    } catch { refuse('CLAIMS_LOCK_CHANGED'); }
    if (!matches) refuse('CLAIMS_LOCK_CHANGED');
    fs.unlinkSync(result.lock);
  }
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
  numbers.classifyProcessRows(fs.readFileSync(file)).forEach(row => {
    if (row.kind === 'non-row') return;
    rows++;
    if (row.kind === 'refused' && row.line.trim().replace(/^\||\|$/g, '').split('|').length !== 9) {
      problems.push(`line ${row.lineNumber}: ${row.reason}: needs 9 columns (id | process | since | trigger | command | documented in | owner | enforced by | status)`); return;
    }
    if (row.kind === 'refused') { problems.push(`line ${row.lineNumber}: ${row.reason}`); return; }
    const t = row.line.trim(); const i = row.lineNumber - 1;
    const c = t.replace(/^\||\|$/g, '').split('|').map(x => x.trim());
    if (c.length < 9) { problems.push(`line ${i + 1}: needs 9 columns (id | process | since | trigger | command | documented in | owner | enforced by | status)`); return; }
    const [id, name, since, trigger, command, doc, owner, enforced, status] = c;
    numbers.closedProcessNumber(id);
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
      if (!STREAM.test(o.stream)) refuse('INVALID_STREAM');
      const parsed = parseOwner(o.owner,o.machine);
      const requestedTree = o.worktree ? fs.realpathSync.native(path.resolve(o.worktree)) : null;
      if (requestedTree && !fs.statSync(requestedTree).isDirectory()) refuse('INVALID_WORKTREE');
      return withClaimsTransaction(claimsFile,() => {
      const all = readClaims(claimsFile);
      const live = all.filter(c => alive(c, now));
      if (cmd === 'release') {
        const next = all.filter(c => c.stream !== o.stream || !sameOwner(parseOwner(c.owner,c.machine),parsed));
        writeClaims(claimsFile, next.filter(c => alive(c, now)));
        say(`RESULT exit=0 released=${all.length - next.length}`);
        return 0;
      }
      // Cross-machine collision check: desk operates on desk-* streams/branches.
      // Laptop claims cannot collide with an existing desktop branch desk-<stream>.
      // Desk claims cannot collide with an existing laptop branch <stream>.
      const baseStream = o.stream.replace(/^desk-/, '');
      if (!baseStream || (parsed.machine === 'desk' && !o.stream.startsWith('desk-'))) refuse('DESK_STREAM_PREFIX_REQUIRED');
      const branches = git(repo,['for-each-ref','--format=%(refname:short)','refs/heads/']);
      if (branches.code !== 0) refuse('BRANCHES_UNKNOWN');
      const opposite = o.stream.startsWith('desk-') ? baseStream : `desk-${baseStream}`;
      if (branches.out.split('\n').includes(opposite)) {
        say(`REFUSED stream ${o.stream} collides with branch ${opposite}`);
        say('RESULT exit=1'); return 1;
      }
      const clash = live.find(c => {
        const cOwner = parseOwner(c.owner, c.machine);
        if (sameOwner(cOwner,parsed)) return false;
        return c.stream.replace(/^desk-/,'') === baseStream
          || (requestedTree && c.worktree && paths.sameFileOrNested(requestedTree,c.worktree));
      });
      if (clash) {
        const clashOwner = clash.namespacedOwner || (clash.machine ? `${clash.machine}/${clash.owner}` : clash.owner);
        say(`REFUSED stream ${clash.stream} / worktree ${clash.worktree || '-'} is claimed by ${clashOwner} since ${clash.since} (ttl ${clash.ttlMin} min); wait, ask the owner, or let the claim expire`);
        say('RESULT exit=1');
        return 1;
      }
      const ttl = o.ttl === undefined ? 120 : numbers.closedInteger(o.ttl,'INVALID_TTL');
      if (ttl < 1 || ttl > 525600) { process.stderr.write('--ttl must be a positive integer (minutes)\n'); return 2; }
      const kept = live.filter(c => {
        if (c.stream !== o.stream) return true;
        const cOwner = parseOwner(c.owner, c.machine);
        return !sameOwner(cOwner,parsed);
      });
      kept.push({ stream: o.stream, owner: parsed.owner, machine: parsed.machine, namespacedOwner: parsed.namespaced, worktree: requestedTree, since: new Date(now).toISOString(), ttlMin: ttl });
      writeClaims(claimsFile, kept);
      say(`RESULT exit=0 claimed stream=${o.stream} owner=${parsed.namespaced} machine=${parsed.machine || '-'} ttl=${ttl}`);
      return 0;
      });
    }
    if (cmd === 'status') {
      const claims = readClaims(claimsFile);
      if (!claims.length) say('no claims');
      for (const c of claims) {
        const oName = c.namespacedOwner || (c.machine ? `${c.machine}/${c.owner}` : c.owner);
        say(`${alive(c, now) ? 'LIVE   ' : 'EXPIRED'} stream=${c.stream} owner=${oName}${c.machine ? ` machine=${c.machine}` : ''} worktree=${c.worktree || '-'} since=${c.since} ttl=${c.ttlMin}`);
      }
      say('RESULT exit=0');
      return 0;
    }
    if (cmd === 'launch-gate') {
      if (!o.stream || !o.owner || !o._.length) { process.stderr.write('launch-gate needs --stream, --owner and at least one launcher or prompt file\n'); return 2; }
      const v = validate(registry, repo, true);
      const problems = [...v.problems];
      const claim = readClaims(claimsFile).find(c => alive(c, now) && c.stream === o.stream);
      const parsedReq = parseOwner(o.owner,o.machine);
      if (!claim) problems.push(`no live claim on stream "${o.stream}": run ops-guard claim first`);
      else {
        const claimOwner = parseOwner(claim.owner, claim.machine);
        const matchOwner = sameOwner(claimOwner,parsedReq);
        if (!matchOwner) problems.push(`stream "${o.stream}" is claimed by ${claim.namespacedOwner || (claim.machine ? `${claim.machine}/${claim.owner}` : claim.owner)}, not ${parsedReq.namespaced}`);
      }
      const p = pinCheck(v.rows, o.stream, o._);
      problems.push(...p.problems);
      problems.forEach(x => say(`PROBLEM ${x}`));
      p.warnings.forEach(w => say(`WARN ${w}`));
      say(`RESULT exit=${problems.length ? 1 : 0} stream=${o.stream} candidate=${p.current ? `${p.current.branch}@${p.current.sha}` : 'none'}`);
      return problems.length ? 1 : 0;
    }
    if (cmd === 'next-number' || cmd === 'allocate-number') {
      const top = git(repo, ['rev-parse', '--show-toplevel']);
      const base = top.code === 0 && top.out ? path.resolve(top.out) : root;
      const file = path.resolve(o.register || path.join(base, 'docs', 'ops', 'PROCESS-REGISTER.md'));
      if (!fs.existsSync(file)) { process.stderr.write(`register not found: ${file}\n`); return 2; }
      const content = fs.readFileSync(file, 'utf8');
      const cn = numbers;
      const preferred = o.preferred !== undefined ? o.preferred : null;
      const next = preferred !== null ? cn.allocateProcessNumber(content, preferred) : cn.nextProcessNumber(content);
      const formatted = cn.formatProcessNumber(next);
      say(`NEXT_NUMBER ${formatted}`);
      say(`RESULT exit=0 next=${formatted} number=${next}`);
      return 0;
    }
    process.stderr.write(`unknown command ${cmd}\n`);
    return 2;
  } catch (e) {
    process.stderr.write(`${e.message}\n`);
    return 2;
  }
}

module.exports = { readRegistry, validate, pinCheck, currentOf, checkRegister, safeMachineId, parseOwner, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

'use strict';

// Local, non-publishing landing. All Git and state writes run under the operator transaction.
// runCheck and seatStatus are trusted host interfaces, never contract-supplied commands.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { sameFileOrNested } = require('../../.ai/bin/lib/path-safe.cjs');
const { decode, parseJsonUnique } = require('../../.ai/bin/lib/text-safe.cjs');
const { readVerdict } = require('../../.ai/bin/lib/verdict-read.cjs');
const processNumbers = require('./closed-number.cjs');

const REGISTER = 'docs/ops/PROCESS-REGISTER.md';
const MANIFEST = 'protocol-manifest.json';
const OWNER = 'docs/ops/owner-words.md';
// Callable preparation only: land() does not enable a draft delegation gate.
// The authenticated host must bind the actual merge/ref effect, hold its lock,
// and persist backup + both journals before any outside-repository operation.
function delegationPreflight(root, file, request, prior) {
  const d = require('../../.ai/bin/protocol-delegation.cjs');
  return prior ? d.recheckOperation(prior, file, request, root) : d.planOperation(file, request, root);
}
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;
const SHA = /^[0-9a-f]{40}$/;
const fail = code => { throw new Error(code); };
function id(value) { if (typeof value !== 'string' || !ID.test(value)) fail('INVALID_ID'); return value; }
function rel(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(value)
      || value.split('/').some(p => p === '.' || p === '..')) fail('INVALID_RELATIVE_PATH');
  return value;
}
function branch(ctx, value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value)) fail('INVALID_BRANCH');
  ctx.git(['check-ref-format', '--branch', value]);
  return value;
}
function plain(value) { return value && typeof value === 'object' && !Array.isArray(value); }
function text(input) {
  const result = decode(Buffer.from(input), { bom: 'strip', crlf: 'normalise', invisible: 'refuse' });
  if (!result.ok) fail('INVALID_TEXT');
  return result.text;
}
function rows(source) {
  const result = []; const numbers = new Set(); const meanings = new Set();
  for (const row of processNumbers.readProcessRows(text(source))) {
    if (numbers.has(row.number) || meanings.has(row.body)) fail('DUPLICATE_REGISTER');
    numbers.add(row.number); meanings.add(row.body); result.push(row);
  }
  return result;
}
function mergeRegister(base, ours, theirs) {
  const b = rows(base); const a = rows(ours); const t = rows(theirs);
  const skeleton = s => { const data = new Set(rows(s).map(r=>r.line)); return text(s).split('\n').filter(l=>!data.has(l)).join('\n'); };
  if (skeleton(ours) !== skeleton(theirs) || skeleton(base) !== skeleton(ours)) fail('REGISTER_NONMECHANICAL');
  for (const old of b) {
    if (!a.some(r => r.line === old.line) || !t.some(r => r.line === old.line)) fail('REGISTER_NONMECHANICAL');
  }
  const combined = a.slice(); let next = processNumbers.nextProcessNumber([...a,...t].map(r=>r.number));
  for (const incoming of t) {
    if (combined.some(r => r.line === incoming.line)) continue;
    if (combined.some(r => r.body === incoming.body)) fail('DUPLICATE_REGISTER');
    const number = combined.some(r => r.number === incoming.number) ? next++ : incoming.number;
    combined.push({ number, body: incoming.body, line: `| ${processNumbers.formatProcessNumber(number)} |${incoming.body}` });
  }
  const additions = combined.slice(a.length).map(r => r.line);
  const lines = text(ours).split('\n');
  let last = -1;
  const data = new Set(a.map(r=>r.line));
  lines.forEach((line, i) => { if (data.has(line)) last = i; });
  if (last < 0) fail('REGISTER_EMPTY');
  lines.splice(last + 1, 0, ...additions);
  const result = lines.join('\n'); rows(result); return result;
}
function mergeManifest(ours, theirs) {
  let a; let b;
  try { a = parseJsonUnique(text(ours)); b = parseJsonUnique(text(theirs)); } catch { fail('MANIFEST_INVALID'); }
  if (!plain(a) || !plain(b) || !isDeepStrictEqual(Object.keys(a).sort(), Object.keys(b).sort())) fail('MANIFEST_NONMECHANICAL');
  const out = Object.create(null);
  for (const key of Object.keys(a)) {
    if (Array.isArray(a[key]) && Array.isArray(b[key])) {
      if (!['managed', 'source', 'tests', 'integration', 'state'].includes(key)) fail('MANIFEST_NONMECHANICAL');
      if (![...a[key], ...b[key]].every(v => typeof v === 'string')) fail('MANIFEST_NONMECHANICAL');
      out[key] = [...new Set([...a[key], ...b[key]])];
    } else {
      if (!isDeepStrictEqual(a[key], b[key])) fail('MANIFEST_NONMECHANICAL');
      out[key] = a[key];
    }
  }
  return `${JSON.stringify(out, null, 2)}\n`;
}
function clean(ctx, worktree) {
  if (ctx.git(['status', '--porcelain=v1', '--untracked-files=all'], worktree).trim()) fail('WORKTREE_DIRTY');
}
function at(ctx, worktree, sha) {
  if (ctx.git(['rev-parse', 'HEAD'], worktree).trim() !== sha) fail('TIP_CHANGED');
}
function ancestry(ctx, sha, head, cwd) {
  try { ctx.git(['merge-base', '--is-ancestor', sha, head], cwd); } catch { fail('NOT_LANDED'); }
}
function readAt(ctx, cwd, sha, file) { return ctx.git(['show', `${sha}:${rel(file)}`], cwd); }

function checkCitations(ctx, cwd, original, files) {
  let checked = 0;
  for (const file of files) {
    const source = text(ctx.read(cwd, file));
    // References in code spans and examples are also checked: a stale example is still stale.
    const pattern = /((?:docs|tools|tests|templates|\.ai)\/[A-Za-z0-9_./-]+\.[A-Za-z0-9]+):(\d+)(?:-(\d+))?/g;
    for (const match of source.matchAll(pattern)) {
      const target = rel(match[1]); const start = Number(match[2]); const end = Number(match[3] || match[2]);
      const current = text(ctx.read(cwd, target)).split('\n');
      if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start || end > current.length) fail('STALE_CITATION');
      let before;
      try { before = text(readAt(ctx, cwd, original, target)).split('\n'); } catch { before = null; }
      if (before && before.slice(start - 1, end).join('\n') !== current.slice(start - 1, end).join('\n')) fail('STALE_CITATION');
      checked++;
    }
  }
  return checked;
}
async function check(ctx, name, cwd, contract) {
  const specs = {
    validator: ['.ai/bin/protocol-validate.cjs', '--root', '.'],
    register: ['docs/ops/ops-guard.cjs', 'register', '--register', REGISTER],
    suite: ['.ai/bin/protocol-test.cjs', '--root', '.'],
  };
  const args = specs[name];
  ctx.guard(cwd, args[0]);
  const result = ctx.runCheck ? await ctx.runCheck(name, cwd, args) : spawnSync(process.execPath, args, {
    cwd, encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, ...(name === 'suite' && contract.powershell ? { PROTOCOL_TEST_POWERSHELL: contract.powershell } : {}) },
  });
  if (!result || result.status !== 0 || result.error || result.signal) fail(`${name.toUpperCase()}_FAILED`);
}
function validateLand(ctx, c) {
  if (!plain(c)) fail('INVALID_CONTRACT');
  if (Object.keys(c).some(k => !['id', 'localOnly', 'mainBranch', 'mainWorktree', 'scratch', 'branches', 'pairs', 'citations', 'powershell'].includes(k))) fail('INVALID_CONTRACT');
  id(c.id); branch(ctx, c.mainBranch);
  if (c.localOnly !== true || c.push !== undefined || c.remote !== undefined) fail('PUBLICATION_FORBIDDEN');
  if (!Array.isArray(c.branches) || !c.branches.length || !Array.isArray(c.pairs) || !c.pairs.length
      || !Array.isArray(c.citations) || !c.citations.length) fail('INVALID_CONTRACT');
  const branches = new Set(); const streams = new Set();
  for (const b of c.branches) {
    if (!plain(b) || !SHA.test(b.sha)) fail('INVALID_SHA');
    if (Object.keys(b).some(k => !['branch', 'sha', 'stream'].includes(k))) fail('INVALID_CONTRACT');
    branch(ctx, b.branch); id(b.stream);
    if (b.branch === c.mainBranch || branches.has(b.branch) || streams.has(b.stream)) fail('DUPLICATE_BRANCH');
    branches.add(b.branch); streams.add(b.stream);
    if (ctx.git(['rev-parse', `refs/heads/${b.branch}`]).trim() !== b.sha) fail('TIP_CHANGED');
  }
  c.pairs.forEach(id); if (new Set(c.pairs).size !== c.pairs.length) fail('DUPLICATE_PAIR');
  c.citations.forEach(rel);
  const scratch = ctx.guard(ctx.workspace, rel(c.scratch)); const main = ctx.guard(ctx.workspace, rel(c.mainWorktree));
  if (sameFileOrNested(scratch, main) || sameFileOrNested(scratch, ctx.repo) || sameFileOrNested(scratch, ctx.stateRoot)) fail('OVERLAPPING_PATHS');
  if (fs.existsSync(scratch)) fail('SCRATCH_EXISTS');
  if (c.powershell !== undefined && (typeof c.powershell !== 'string' || !path.isAbsolute(c.powershell) || !fs.statSync(c.powershell).isFile())) fail('INVALID_POWERSHELL');
  if (ctx.git(['symbolic-ref', '--short', 'HEAD'], main).trim() !== c.mainBranch) fail('MAIN_BRANCH_MISMATCH');
  if (ctx.git(['rev-parse', '--path-format=absolute', '--git-common-dir'], main).trim()
      !== ctx.git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()) fail('REPOSITORY_MISMATCH');
  clean(ctx, main);
  return { scratch, main, original: ctx.git(['rev-parse', 'HEAD'], main).trim() };
}
async function acceptedReports(ctx, c, state) {
  const reports = [];
  for (const pair of c.pairs) {
    const meta = state.pairs[pair];
    if (!meta || !c.branches.some(b => b.stream === meta.stream && b.sha === meta.sha)) fail('PAIR_CANDIDATE_MISMATCH');
    const accepted = await ctx.acceptPair(pair);
    if (!Array.isArray(accepted) || accepted.length < 2) fail('SEALED_PAIR_REQUIRED');
    const transports = new Set();
    for (const r of accepted) {
      id(r.seat); id(r.transport);
      if (r.sha !== meta.sha || !['PASS', 'RECOMMENDATION'].includes(r.verdict)) fail('SEALED_PAIR_REQUIRED');
      const root = ctx.guard(ctx.workspace, rel(r.worktree));
      const contents = text(ctx.read(root, rel(r.report)));
      if (readVerdict(contents).token !== r.verdict) fail('REPORT_CHANGED');
      transports.add(r.transport); reports.push({ ...r, contents });
    }
    if (transports.size < 2) fail('DIFFERENT_TRANSPORTS_REQUIRED');
  }
  for (const b of c.branches) if (!c.pairs.some(p => state.pairs[p].stream === b.stream)) fail('UNCERTIFIED_BRANCH');
  if (new Set(reports.map(r => r.seat)).size !== reports.length) fail('DUPLICATE_SEAT');
  return reports;
}
// The read-only validation of a land contract: every refusal here is
// deterministic, so it runs BEFORE the operator transaction creates its
// lock; the transaction body re-runs it under the lock as the
// authority for concurrent changes.
async function landPreflight(ctx, c) {
  const locations = validateLand(ctx, c); const state = ctx.load();
  if (state.landings[c.id]) fail('LANDING_EXISTS');
  const reports = await acceptedReports(ctx, c, state);
  if (!ctx.seatStatus) fail('SEAT_STATUS_REQUIRED');
  for (const [seat, data] of Object.entries(state.seats)) {
    if (!c.branches.some(b => b.stream === data.stream)) continue;
    const status = await ctx.seatStatus(seat);
    if (!status || status.done !== true || status.running !== false) fail('WORKTREE_ACTIVE_OR_UNKNOWN');
    if (c.branches.some(b => b.sha === (data.sha || data.contract?.sha)) && status.verdict === 'FAIL') fail('SEALED_FAIL_PRESENT');
  }
  return { locations, state, reports };
}
async function land(ctx, contract, dryRun = false, retire = false) {
  const perform = async () => {
    const c = contract;
    const { locations, state, reports } = await landPreflight(ctx, c);
    if (dryRun) return { id: c.id, status: 'dry-run', branches: c.branches.length, reports: reports.length, localOnly: true };
    const { scratch, main, original } = locations;
    const record = { id: c.id, status: 'preparing', original, mainBranch: c.mainBranch,
      mainWorktree: c.mainWorktree, scratch: c.scratch, branches: c.branches, pairs: c.pairs, reports: reports.map(({ contents, ...r }) => r), moves: [] };
    state.landings[c.id] = record; ctx.save(state);
    try {
      ctx.guard(ctx.workspace, c.scratch);
      ctx.git(['worktree', 'add', '--detach', scratch, original]);
      for (const b of c.branches) {
        try { ctx.git(['merge', '--no-ff', '--no-edit', b.sha], scratch); } catch {
          const conflicts = ctx.git(['diff', '--name-only', '--diff-filter=U'], scratch).trim().split('\n').filter(Boolean);
          if (!conflicts.length) fail('MERGE_FAILED');
          for (const file of conflicts) {
            rel(file); ctx.guard(scratch, file);
            let resolved;
            if (file === REGISTER) resolved = mergeRegister(readAt(ctx, scratch, ':1', file), readAt(ctx, scratch, ':2', file), readAt(ctx, scratch, ':3', file));
            else if (file === MANIFEST) resolved = mergeManifest(readAt(ctx, scratch, ':2', file), readAt(ctx, scratch, ':3', file));
            else if (file === OWNER) resolved = readAt(ctx, scratch, original, file);
            else fail(`UNRESOLVED_CONFLICT:${file}`);
            ctx.write(scratch, file, resolved); ctx.git(['add', '--', file], scratch);
          }
          ctx.git(['commit', '--no-edit'], scratch);
        }
      }
      rows(ctx.read(scratch, REGISTER));
      for (const report of reports) {
        const target = `docs/reviews/operator-${c.id}-${report.seat}.md`;
        if (fs.existsSync(ctx.guard(scratch, target))) fail('REPORT_TARGET_EXISTS');
        ctx.write(scratch, target, report.contents); ctx.git(['add', '--', target], scratch);
      }
      ctx.git(['commit', '-m', `ops: preserve sealed reports for ${c.id}`], scratch);
      const merged = ctx.git(['rev-parse', 'HEAD'], scratch).trim();
      record.citationsChecked = checkCitations(ctx, scratch, original, c.citations);
      await check(ctx, 'validator', scratch, c);
      await check(ctx, 'register', scratch, c);
      record.suiteAttempted = true; ctx.save(state);
      await check(ctx, 'suite', scratch, c);
      clean(ctx, scratch);
      at(ctx, scratch, merged);
      // Revalidate after the potentially long suite; main and sealed reports may have moved.
      at(ctx, main, original); clean(ctx, main);
      if (ctx.git(['symbolic-ref', '--short', 'HEAD'], main).trim() !== c.mainBranch) fail('MAIN_BRANCH_MISMATCH');
      const latest = await acceptedReports(ctx, c, ctx.load());
      if (!isDeepStrictEqual(latest, reports)) fail('REPORT_CHANGED');
      for (const b of c.branches) if (ctx.git(['rev-parse', `refs/heads/${b.branch}`]).trim() !== b.sha) fail('TIP_CHANGED');
      record.status = 'ready'; record.sha = merged; ctx.save(state);
      ctx.git(['merge', '--ff-only', merged], main);
      at(ctx, main, merged);
      record.status = 'landed-local'; ctx.save(state);
      return { id: c.id, status: record.status, sha: merged, reports: reports.length, localOnly: true };
    } catch (error) {
      record.status = 'blocked'; record.reason = /^[A-Z_]+(?::[A-Za-z0-9_./-]+)?$/.test(error.message) ? error.message : 'LANDING_FAILED';
      ctx.save(state); throw new Error(record.reason);
    }
  };
  // A real land refuses before the operator transaction creates its
  // lock, so a refused land leaves no lock and no tombstone in the state
  // root. The full-suite marker is a static environment fact, checked once
  // here exactly where the dry-run return used to exclude it.
  if (!dryRun) {
    await landPreflight(ctx, contract);
    if (process.env.PROTOCOL_NO_FULL_SUITE === '1' && !ctx.runCheck) fail('FULL_SUITE_FORBIDDEN');
  }
  const result = await (dryRun ? perform() : ctx.transaction('operator', perform));
  if (retire && !dryRun) result.retirement = await retireLanding(ctx, contract.id, false);
  return result;
}

// Retirement is a final, explicit step. A cleanup failure must not relabel a
// successfully landed commit as a failed landing. The caller can retry retire.
async function retireLanding(ctx, landingId, dryRun = true) {
  id(landingId);
  const state = ctx.load(); const record = state.landings[landingId];
  if (!record || !['landed-local', 'closed'].includes(record.status)) fail('LANDING_NOT_COMPLETE');
  const main = ctx.guard(ctx.workspace, record.mainWorktree);
  ancestry(ctx, record.sha, 'HEAD', main);
  const all = fail('RETIREMENT_NOT_SHIPPED').parseWorktrees(ctx.git(['worktree', 'list', '--porcelain']));
  const targets = all.filter(w => record.branches.some(b => w.branch === b.branch)).map(w => w.path);
  for (const seat of Object.values(state.seats)) {
    if (!record.branches.some(b => b.stream === seat.stream && b.sha === (seat.sha || seat.contract?.sha))) continue;
    const root = ctx.guard(ctx.workspace, rel(seat.worktree || seat.contract?.worktree));
    if (fs.existsSync(root)) targets.push(root);
  }
  const options = { repo: ctx.repo, base: record.mainBranch, managedRoots: [ctx.workspace],
    targets: [...new Set(targets)], execute: !dryRun };
  const receipt = ctx.retire ? await ctx.retire(options) : fail('RETIREMENT_NOT_SHIPPED');
  if (!dryRun) await ctx.transaction('operator', async () => {
    const latest = ctx.load(); latest.landings[landingId].retirement = receipt.receipt;
    for (const b of record.branches) {
      const candidate = latest.candidates[b.stream];
      if (candidate && candidate.sha === b.sha && (!candidate.branch || candidate.branch === b.branch)) candidate.status = 'landed';
    }
    ctx.save(latest);
  });
  return receipt;
}

// The read-only validation of a close contract: every refusal here is
// deterministic, so it runs BEFORE the operator transaction creates its
// lock; the transaction body re-runs it under the lock.
async function preflightClose(ctx, contract) {
  if (!plain(contract)) fail('INVALID_CONTRACT');
    if (Object.keys(contract).some(k => !['id', 'quarantine', 'artifacts'].includes(k))) fail('INVALID_CONTRACT');
    id(contract.id); rel(contract.quarantine);
    if (contract.artifacts !== undefined && !Array.isArray(contract.artifacts)) fail('INVALID_CONTRACT');
    const state = ctx.load(); const record = state.landings[contract.id];
    if (!record || !['landed-local', 'closing', 'closed'].includes(record.status)) fail('LANDING_NOT_COMPLETE');
    const main = ctx.guard(ctx.workspace, record.mainWorktree);
    if (ctx.git(['symbolic-ref', '--short', 'HEAD'], main).trim() !== record.mainBranch) fail('MAIN_BRANCH_MISMATCH');
    ancestry(ctx, record.sha, 'HEAD', main);
    for (const b of record.branches) ancestry(ctx, b.sha, 'HEAD', main);
    const streams = new Set(record.branches.map(b => b.stream));
    const seats = Object.entries(state.seats).filter(([, s]) => streams.has(s.stream)
      && record.branches.some(b => b.sha === (s.sha || s.contract?.sha)));
    const recoveredRoot = source => {
      const from = ctx.guard(ctx.workspace, source);
      if (fs.existsSync(from)) return from;
      const move = (record.moves || []).find(m => m.source === source);
      if (!move) fail('MOVE_STATE_UNKNOWN');
      const to = ctx.guard(ctx.workspace, move.destination);
      const known = ctx.git(['worktree', 'list', '--porcelain']);
      if (!known.split('\n').includes(`worktree ${to.split(path.sep).join('/')}`)) fail('MOVE_STATE_UNKNOWN');
      return to;
    };
    if (!ctx.seatStatus) fail('SEAT_STATUS_REQUIRED');
    for (const [seat] of seats) {
      const status = await ctx.seatStatus(seat);
      if (!status || status.done !== true || status.running !== false) fail('WORKTREE_ACTIVE_OR_UNKNOWN');
    }
    const imports = [];
    for (const artifact of contract.artifacts || []) {
      if (!plain(artifact) || Object.keys(artifact).some(k => !['seat', 'path'].includes(k))) fail('INVALID_ARTIFACT');
      id(artifact.seat); rel(artifact.path);
      if (!/^(?:\.ai\/worklog|docs\/reviews)\/[A-Za-z0-9_.-]+\.md$/.test(artifact.path)) fail('INVALID_ARTIFACT');
      const seat = seats.find(([name]) => name === artifact.seat)?.[1];
      if (!seat) fail('ARTIFACT_SEAT_MISMATCH');
      const root = recoveredRoot(seat.worktree);
      const contents = text(ctx.read(root, artifact.path));
      const target = ctx.guard(main, artifact.path);
      const prior = imports.find(a => a.path === artifact.path);
      if (prior && prior.contents !== contents) fail('ARTIFACT_COLLISION');
      if (fs.existsSync(target) && ctx.read(main, artifact.path) !== contents) fail('ARTIFACT_COLLISION');
      if (!prior) imports.push({ path: artifact.path, contents });
    }
    if (!record.importsStarted) clean(ctx, main);
    else {
      // Retry may see only our exact, immutable artifact bytes, never an unrelated edit.
      const dirty = ctx.git(['status', '--porcelain=v1', '--untracked-files=all'], main).trim().split('\n').filter(Boolean);
      if (dirty.some(row => !imports.some(a => row.slice(3) === a.path))) fail('WORKTREE_DIRTY');
    }
    const trees = record.moves?.length ? record.moves.map(m => m.source) : [...new Set([record.scratch, ...seats.map(([, s]) => s.worktree)])];
    const planned = [];
    for (let i = 0; i < trees.length; i++) {
      const source = rel(trees[i]); const destination = `${contract.quarantine}/${record.id}-${i}`;
      const from = ctx.guard(ctx.workspace, source); const to = ctx.guard(ctx.workspace, destination);
      if (sameFileOrNested(from, main) || sameFileOrNested(to, main) || sameFileOrNested(from, to)
          || sameFileOrNested(to, ctx.stateRoot)) fail('OVERLAPPING_PATHS');
      const prior = (record.moves || []).find(m => m.source === source);
      if (prior && prior.destination !== destination) fail('QUARANTINE_CHANGED');
      if (!prior && fs.existsSync(to)) fail('QUARANTINE_EXISTS');
      if (!prior && ctx.git(['rev-parse', '--show-toplevel'], from).trim().replace(/\\/g, '/') !== from.replace(/\\/g, '/')) fail('NOT_WORKTREE_ROOT');
      planned.push({ source, destination, moved: prior?.moved === true });
    }
  return { record, state, main, seats, imports, planned };
}
async function close(ctx, contract, dryRun = false) {
  const perform = async () => {
    const { record, state, main, seats, imports, planned } = await preflightClose(ctx, contract);
    if (dryRun) return { id: record.id, status: 'dry-run', worktrees: planned.length };
    record.status = 'closing'; record.moves = planned; ctx.save(state);
    if (imports.length && !record.importsCommitted) {
      record.importsStarted = true; ctx.save(state);
      for (const artifact of imports) {
        ctx.write(main, artifact.path, artifact.contents);
        ctx.git(['add', '--', artifact.path], main);
      }
      if (ctx.git(['diff', '--cached', '--name-only'], main).trim()) {
        ctx.git(['commit', '-m', `ops: preserve stream records for ${record.id}`, '--', ...imports.map(a => a.path)], main);
      }
      record.importsCommitted = true; ctx.save(state);
    }
    for (const move of planned) {
      if (move.moved) continue;
      const from = ctx.guard(ctx.workspace, move.source); const to = ctx.guard(ctx.workspace, move.destination);
      // A crash after Git moved but before save is recoverable only when Git identifies the destination.
      if (!fs.existsSync(from) && fs.existsSync(to)) {
        const known = ctx.git(['worktree', 'list', '--porcelain']);
        if (!known.split('\n').includes(`worktree ${to.split(path.sep).join('/')}`)) fail('MOVE_STATE_UNKNOWN');
      } else {
        for (const [seat, s] of seats.filter(([, s]) => s.worktree === move.source)) {
          const status = await ctx.seatStatus(seat);
          if (!status || status.done !== true || status.running !== false) fail('WORKTREE_ACTIVE_OR_UNKNOWN');
        }
        fs.mkdirSync(path.dirname(to), { recursive: true });
        ctx.guard(ctx.workspace, move.destination);
        ctx.git(['worktree', 'move', from, to]);
      }
      move.moved = true;
      for (const [, s] of seats.filter(([, s]) => s.worktree === move.source)) {
        s.originalWorktree = move.source; s.worktree = move.destination; s.quarantine = move.destination;
      }
      ctx.save(state);
    }
    for (const b of record.branches) {
      ancestry(ctx, b.sha, 'HEAD', main);
      if (state.candidates[b.stream] && state.candidates[b.stream].sha === b.sha) state.candidates[b.stream].status = 'landed';
    }
    record.status = 'closed'; ctx.save(state);
    return { id: record.id, status: 'closed', worktrees: planned.length, branchesPreserved: true };
  };
  // A real close refuses before the operator transaction creates
  // its lock, so a refused close leaves no lock and no tombstone in the
  // state root.
  if (!dryRun) await preflightClose(ctx, contract);
  return dryRun ? perform() : ctx.transaction('operator', perform);
}

// Local land() stays non-publishing. This explicit publication command retires
// only that landing's stream, only after a successful integration push.
async function publishLanding(ctx, contract, dryRun = true) {
  if (!plain(contract) || Object.keys(contract).some(k => !['id', 'remote', 'archiveRoot'].includes(k))) fail('INVALID_CONTRACT');
  if (contract.archiveRoot !== undefined && typeof contract.archiveRoot !== 'string') fail('INVALID_CONTRACT');
  id(contract.id); const remote = contract.remote || 'origin'; id(remote);
  const record = ctx.load().landings[contract.id];
  if (!record || !['landed-local', 'closed'].includes(record.status)) fail('LANDING_NOT_COMPLETE');
  const main = ctx.guard(ctx.workspace, rel(record.mainWorktree));
  const manifest = JSON.parse(ctx.read(main, MANIFEST));
  if (manifest.integrationBranch !== record.mainBranch) fail('INTEGRATION_MISMATCH');
  branch(ctx, record.mainBranch);
  ancestry(ctx, record.sha, `refs/heads/${record.mainBranch}`, main);
  clean(ctx, main);
  const targets = require('./auto-retire.cjs').worktrees(main).filter(w => record.branches.some(b => w.branch === b.branch)).map(w => w.path);
  for (const seat of Object.values(ctx.load().seats)) {
    if (!record.branches.some(b => b.stream === seat.stream && b.sha === (seat.sha || seat.contract?.sha))) continue;
    const target = ctx.guard(ctx.workspace, rel(seat.worktree || seat.contract?.worktree));
    if (fs.existsSync(target)) targets.push(target);
  }
  if (dryRun) return { status: 'dry-run', targets: [...new Set(targets)] };
  ctx.git(['push', '--', remote, `refs/heads/${record.mainBranch}:refs/heads/${record.mainBranch}`], main);
  ancestry(ctx, record.sha, `refs/remotes/${remote}/${record.mainBranch}`, main);
  const options = { repo: main, remote, integrationBranch: record.mainBranch, targets: [...new Set(targets)], ageHours: 0, apply: true, ...(contract.archiveRoot === undefined ? {} : { archiveRoot: contract.archiveRoot }) };
  try {
    const registry = path.join(main, '.ai/runtime/CANDIDATES.md');
    if (fs.existsSync(registry)) for (const b of record.branches) {
      require('../../docs/ops/ops-guard.cjs').landRows(registry, { ...b, repo: main, now: Date.now(), integrationRef: `refs/remotes/${remote}/${record.mainBranch}` });
    }
    if (!targets.length) return { status: 'pushed', retirement: { entries: [] } };
    const retirement = ctx.autoRetire ? await ctx.autoRetire(options) : require('./auto-retire.cjs').run(options);
    return { status: 'pushed', retirement };
  } catch (e) { return { status: 'pushed', retirement: { reason: /^[A-Z_]+$/.test(e.message) ? e.message : 'RETIRE_REFUSED' } }; }
}
module.exports = { delegationPreflight, land, close, retireLanding, publishLanding, mergeRegister, mergeManifest, checkCitations };

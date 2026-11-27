#!/usr/bin/env node
'use strict';
// Deterministic train squash builder and pre-push train verifier.
// Shipped kernel tool in .ai/bin/ops-tools: CommonJS, zero unshipped imports,
// never invokes a shell or execSync, never writes a manual SHA.
//   node .ai/bin/ops-tools/train-land.cjs squash --branch <name> --summary <text> [--stage <N>] [--co-author "<Name <email>>"] [--base <ref>] [--repo <dir>]
//   node .ai/bin/ops-tools/train-land.cjs verify [--base <ref>] [--head <ref>] [--allow-archived] [--repo <dir>]
//   node .ai/bin/ops-tools/train-land.cjs push --remote <name> [--head <ref>] [--repo <dir>]
//   node .ai/bin/ops-tools/train-land.cjs merge --ref <ref> --summary <text> [--repo <dir>]
//   node .ai/bin/ops-tools/train-land.cjs register-plan --base <ref> --candidate <branch> [--candidate <branch>] [--repo <dir>]
//   node .ai/bin/ops-tools/train-land.cjs suite --summary <run-summary.json> [--summary <file>]... [--base <ref>] [--head <ref>] [--repo <dir>]
//   node .ai/bin/ops-tools/train-land.cjs docs-check --tested-head <full-SHA> --head <ref> [--results <farm-results>] --gates-log <file> [--repo <dir>]
const fs = require('node:fs');
const path = require('node:path');
const realPath = require('../lib/real-path.cjs');
const { spawnSync } = require('node:child_process');
const { isDeepStrictEqual } = require('node:util');
const { decode, maskMarkdown, parseJsonUnique } = require('../lib/text-safe.cjs');
const { readLanding } = require('../operator/landed-proof.cjs');
const { load } = require('./lib/config.cjs');
const generated = require('./lib/generated.cjs');
const { readRenumber, parseRegisterRows, validateRenumberV2 } = require('../lib/register-renumber.cjs');
const registerLanding = require('../lib/register-landing.cjs');
const { isProtectedPath } = require('../lib/protected-paths.cjs');
const registerFragments = require('../lib/register-fragments.cjs');
const registerCompiler = require('../lib/register-compiler.cjs');
const consumerMode = require('../lib/register-consumer-mode.cjs');
const launchLedger = require('../lib/register-launch-ledger.cjs');
const sharedDocs = require('./lib/shared-docs.cjs');
const quarantine = require('../lib/flake-quarantine.cjs');
const landingFacts = require('../lib/landing-facts.cjs');
const RENUMBER_CONTRACT = 'register-renumber/1';
// The sweep of the cleanup after the landing is an operator tool of the source checkout, loaded at run time from its resolved path so the
// product require closure holds no landing tooling; a copy without it prints no plan line.
const POST_LANDING_SWEEP_MODULE = path.join(__dirname, 'post-landing-sweep.cjs');

const SHA = /^[0-9a-f]{40}$/;
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const MERGE_ENTRY = /^([0-7]{6}) ([0-9a-f]{40}|[0-9a-f]{64}) ([123])\t([^\0]+)$/;
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const REMOTE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const POSITIVE_INT = /^[1-9][0-9]{0,5}$/;
const CO_AUTHOR_RE = /^[^<>\r\n\0]+ <[^<>\s\r\n\0]+@[^<>\s\r\n\0]+>$/;
const FORBIDDEN_TEXT = /[\x00-\x1f\x7f]/;
const INJECTED_TRAILER = /(?:landed-tip|co-authored-by|register-renumber)\s*:/i;
const SQUASH_SUBJECT_RE = /^land ([A-Za-z0-9][A-Za-z0-9._/-]*)(?: stage ([1-9][0-9]{0,5}))? as one commit \(squash of the branch tip ([0-9a-f]{8}): ([^\r\n\0]+)\)$/;
function isIntegrationSubject(subject) {
  if (!subject.startsWith('train ') || /[\r\n\0]/.test(subject)) return false;
  const rest = subject.slice(6);
  const sep = rest.indexOf(' integration: ');
  if (sep < 2 || rest[0] !== 't') return false;
  return POSITIVE_INT.test(rest.slice(1, sep)) && rest.length > sep + 14;
}
const P_NUMBER_BODY = '(?:[0-9]{2}|[1-9][0-9]{2,3})';
const CLOSED_P_NUMBER = new RegExp(`^P-${P_NUMBER_BODY}$`);

// Train segment trailers on integration commits (TRAIN-STACK, finding 11.105).
// Train-Base declares the train base (the previous train head); Train-Withdraw
// names a withdrawn earlier landing so a later segment may re-land the branch.
const TRAIN_BASE_RE = /^Train-Base: ([0-9a-f]{40})$/;
const TRAIN_WITHDRAW_RE = /^Train-Withdraw: ([A-Za-z0-9][A-Za-z0-9._/-]*) ([0-9a-f]{40})$/;
function parseTrainTrailers(message) {
  let base = null;
  const withdraws = [];
  for (const line of message.split('\n')) {
    if (/^train-base\s*:/i.test(line)) {
      const m = TRAIN_BASE_RE.exec(line);
      if (!m || base !== null) throw err('TRAIN-LAND-TRAIN-TRAILER', 'malformed or duplicate Train-Base trailer');
      base = m[1];
    } else if (/^train-withdraw\s*:/i.test(line)) {
      const m = TRAIN_WITHDRAW_RE.exec(line);
      if (!m) throw err('TRAIN-LAND-TRAIN-TRAILER', 'malformed Train-Withdraw trailer');
      withdraws.push({ branch: m[1], tip: m[2] });
    }
  }
  return { base, withdraws };
}
function isAncestorOrEqual(git, a, b) {
  return a === b || git.raw(['merge-base', '--is-ancestor', a, b]).status === 0;
}

const MANIFEST_PATH = 'protocol-manifest.json';
const REGISTER_PATH = 'docs/ops/PROCESS-REGISTER.md';
const OPEN_REGISTER_PATH = 'docs/ops/OPEN-REGISTER.json';
const SNAPSHOT_PATHS = new Set(['docs/ops/test-consumers.json', '.ai/core/CATALOG.md']);
const MECHANICAL_PATHS = new Set([MANIFEST_PATH, REGISTER_PATH, ...SNAPSHOT_PATHS]);
const MANIFEST_ARRAY_KEYS = new Set(['managed', 'source', 'tests', 'integration', 'state']);
const SEQUENCER_MARKERS = ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'BISECT_LOG', 'rebase-merge', 'rebase-apply'];
const MAX_BUFFER = 256 * 1024 * 1024;
const GIT_TIMEOUT_MS = 120000;

const plain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const err = (code, detail) => Object.assign(new Error(`${code}: ${detail}`), { code, detail });
const failResult = (code, detail) => ({ ok: false, code, detail });

function cleanGitEnv(baseEnv = process.env) {
  const out = {};
  for (const [k, v] of Object.entries(baseEnv || {})) {
    if (k === 'GIT_CONFIG_GLOBAL' || k === 'GIT_CONFIG_SYSTEM' || k === 'GIT_CONFIG_NOSYSTEM' || k === 'GIT_EXEC_PATH') {
      out[k] = v;
      continue;
    }
    if (/^GIT_/i.test(k)) continue;
    out[k] = v;
  }
  out.GIT_TERMINAL_PROMPT = '0';
  out.GIT_NO_REPLACE_OBJECTS = '1';
  return out;
}

function makeGit(cwd, env = process.env, spawn = spawnSync) {
  const safeEnv = cleanGitEnv(env);
  const fixed = ['-c', 'core.hooksPath=disabled-hooks', '-c', 'commit.gpgsign=false', '-c', 'core.quotePath=false', '-c', 'core.autocrlf=false'];
  const raw = (args, opts = {}) => spawn('git', [...fixed, ...args], {
    cwd: opts.cwd || cwd,
    encoding: opts.buffer ? 'buffer' : 'utf8',
    input: opts.input,
    windowsHide: true,
    timeout: opts.timeout || GIT_TIMEOUT_MS,
    maxBuffer: MAX_BUFFER,
    stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    env: opts.env ? { ...safeEnv, ...opts.env } : safeEnv,
  });
  const strict = (args, code = 'TRAIN-LAND-GIT', opts = {}) => {
    const r = raw(args, opts);
    if (r.error || r.status !== 0) {
      const msg = r.error ? r.error.message : String(r.stderr || `git ${args[0]} exited ${r.status}`).trim().split('\n')[0];
      throw err(code, msg || `git ${args[0]} failed`);
    }
    return opts.buffer ? r.stdout : String(r.stdout || '');
  };
  return { raw, strict, cwd, safeEnv };
}

function validateSafeText(value, field) {
  if (typeof value !== 'string' || value.trim() === '' || value !== value.trim()) {
    throw err('TRAIN-LAND-ARGS', `${field} must be a non-empty trimmed string`);
  }
  if (FORBIDDEN_TEXT.test(value)) {
    throw err('TRAIN-LAND-ARGS', `${field} contains CR, LF, NUL or control characters`);
  }
  const d = decode(Buffer.from(value, 'utf8'), { bom: 'refuse', crlf: 'refuse', invisible: 'refuse' });
  if (!d.ok) throw err('TRAIN-LAND-ARGS', `${field} contains invalid UTF-8 or invisible characters`);
  if (INJECTED_TRAILER.test(value)) {
    throw err('TRAIN-LAND-ARGS', `${field} may not contain trailer declarations`);
  }
  return value;
}

function validateRefToken(value, field) {
  if (typeof value !== 'string' || !value || value.startsWith('-') || FORBIDDEN_TEXT.test(value) || /\s|\.\.|@\{|[~^:?*[\\]/.test(value)) {
    throw err('TRAIN-LAND-ARGS', `${field} is not a safe Git ref`);
  }
  return value;
}

function validateBranchName(value, git) {
  if (typeof value !== 'string' || !BRANCH_RE.test(value) || value.startsWith('-') || value.includes('..') || value.endsWith('/') || value.endsWith('.lock') || value.includes('//')) {
    throw err('TRAIN-LAND-ARGS', 'invalid --branch name');
  }
  if (git) {
    const chk = git.raw(['check-ref-format', '--branch', value]);
    if (chk.error || chk.status !== 0) throw err('TRAIN-LAND-ARGS', 'git check-ref-format rejected --branch');
  }
  return value;
}

function parseArgs(argv) {
  if (!Array.isArray(argv) || !argv.length) throw err('TRAIN-LAND-ARGS', 'missing subcommand (squash | merge | verify | push | register-plan)');
  const cmd = argv[0];
  if (!['squash', 'merge', 'verify', 'push', 'register-plan', 'register-bootstrap', 'register-readiness', 'integration', 'suite', 'docs-check'].includes(cmd)) {
    throw err('TRAIN-LAND-ARGS', `unknown subcommand: ${String(cmd).slice(0, 40)}`);
  }
  const allowed = {
    squash: new Set(['--branch', '--summary', '--stage', '--co-author', '--base', '--repo', '--register-plan']),
    merge: new Set(['--ref', '--summary', '--repo']),
    integration: new Set(['--summary', '--owner', '--repo']),
    verify: new Set(['--base', '--head', '--repo', '--allow-archived']),
    push: new Set(['--remote', '--head', '--repo']),
    'register-plan': new Set(['--base', '--candidate', '--repo']),
    'register-bootstrap': new Set(['--parent', '--tool-tip', '--approval', '--repo']),
    'register-readiness': new Set(['--head', '--repo']),
    suite: new Set(['--summary', '--base', '--head', '--repo']),
    'docs-check': new Set(['--tested-head', '--head', '--results', '--gates-log', '--repo']),
  }[cmd];
  const booleans = new Set(['--allow-archived']);
  const seen = new Set();
  const opts = { cmd };
  for (let i = 1; i < argv.length; i++) {
    const tok = argv[i];
    if (typeof tok !== 'string' || !tok.startsWith('--') || tok.includes('=')) {
      throw err('TRAIN-LAND-ARGS', `unexpected argument: ${String(tok).slice(0, 40)}`);
    }
    if (tok === '--tip' || tok === '--sha') {
      throw err('TRAIN-LAND-ARGS', `${tok} is forbidden: Landed-Tip is computed only from refs/heads/<branch>`);
    }
    if (!allowed.has(tok)) {
      throw err('TRAIN-LAND-ARGS', `unknown or disallowed flag ${tok} for ${cmd}`);
    }
    if (seen.has(tok) && !(cmd === 'register-plan' && tok === '--candidate') && !(cmd === 'suite' && tok === '--summary')) {
      throw err('TRAIN-LAND-ARGS', `duplicate flag ${tok}`);
    }
    seen.add(tok);
    if (booleans.has(tok)) {
      opts.allowArchived = true;
      continue;
    }
    if (i + 1 >= argv.length) throw err('TRAIN-LAND-ARGS', `missing value for ${tok}`);
    const val = argv[++i];
    if (typeof val !== 'string' || val === '') throw err('TRAIN-LAND-ARGS', `empty value for ${tok}`);
    const key = tok.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (cmd === 'register-plan' && tok === '--candidate') (opts.candidates ||= []).push(val);
    else if (cmd === 'suite' && tok === '--summary') (opts.summaries ||= []).push(val);
    else opts[key] = val;
  }
  if (cmd === 'squash') {
    if (!opts.branch || !opts.summary) throw err('TRAIN-LAND-ARGS', 'squash requires --branch and --summary');
    validateBranchName(opts.branch, null);
    validateSafeText(opts.summary, '--summary');
    if (opts.stage !== undefined && !POSITIVE_INT.test(String(opts.stage))) {
      throw err('TRAIN-LAND-ARGS', '--stage must be a positive integer without leading zeros');
    }
    if (opts.coAuthor !== undefined) {
      validateSafeText(opts.coAuthor, '--co-author');
      if (!CO_AUTHOR_RE.test(opts.coAuthor)) throw err('TRAIN-LAND-ARGS', '--co-author must match "Name <email>"');
    }
    if (opts.base !== undefined) validateRefToken(opts.base, '--base');
  } else if (cmd === 'docs-check') {
    if (!SHA.test(opts.testedHead || '') || !opts.head) throw err('TRAIN-LAND-ARGS', 'docs-check requires --tested-head full SHA and --head');
    validateRefToken(opts.head, '--head');
    for (const key of ['results', 'gatesLog']) if (opts[key] !== undefined && FORBIDDEN_TEXT.test(opts[key])) throw err('TRAIN-LAND-ARGS', `invalid ${key} path`);
  } else if (cmd === 'register-bootstrap') {
    if (!SHA.test(opts.parent || '') || !SHA.test(opts.toolTip || '') || !opts.approval) throw err('TRAIN-LAND-ARGS', 'bootstrap requires --parent SHA --tool-tip SHA --approval FILE');
  } else if (cmd === 'register-plan') {
    if (!opts.base || !opts.candidates?.length) throw err('TRAIN-LAND-ARGS', 'register-plan requires --base and --candidate');
    validateRefToken(opts.base, '--base');
    opts.candidates.forEach(b => validateBranchName(b, null));
  } else if (cmd === 'integration') {
    validateSafeText(opts.summary, '--summary');
    if (!isIntegrationSubject(opts.summary) || !opts.owner) throw err('TRAIN-LAND-ARGS', 'integration requires a train integration subject and --owner');
  } else if (cmd === 'merge') {
    validateRefToken(opts.ref, '--ref');
    validateSafeText(opts.summary, '--summary');
  } else if (cmd === 'suite') {
    if (!opts.summaries?.length) throw err('TRAIN-LAND-ARGS', 'suite requires at least one --summary');
    if (opts.summaries.some(file => FORBIDDEN_TEXT.test(file))) throw err('TRAIN-LAND-ARGS', 'invalid --summary path');
    if (opts.base !== undefined) validateRefToken(opts.base, '--base');
    if (opts.head !== undefined && opts.head !== 'HEAD') validateRefToken(opts.head, '--head');
  } else if (cmd === 'verify' || cmd === 'register-readiness') {
    if (opts.base !== undefined) validateRefToken(opts.base, '--base');
    if (opts.head !== undefined && opts.head !== 'HEAD') validateRefToken(opts.head, '--head');
  } else if (cmd === 'push') {
    if (!opts.remote || !REMOTE_RE.test(opts.remote)) throw err('TRAIN-LAND-ARGS', 'push requires a valid --remote name');
    if (opts.head !== undefined && opts.head !== 'HEAD') validateRefToken(opts.head, '--head');
  }
  if (opts.repo !== undefined && (typeof opts.repo !== 'string' || FORBIDDEN_TEXT.test(opts.repo))) {
    throw err('TRAIN-LAND-ARGS', 'invalid --repo path');
  }
  return opts;
}

function buildSquashMessage({ branch, stage, tip, summary, coAuthor, notRewritten = [], renumber = null }) {
  if (!SHA.test(tip)) throw err('TRAIN-LAND-INTERNAL', 'tip must be 40 lowercase hex');
  const stagePart = stage !== undefined && stage !== null ? ` stage ${stage}` : '';
  const subject = `land ${branch}${stagePart} as one commit (squash of the branch tip ${tip.slice(0, 8)}: ${summary})`;
  const trailers = [`Landed-Tip: ${tip}`];
  if (renumber) {
    if (renumber.version === 2) validateRenumberV2(renumber);
    trailers.unshift(`Register-Renumber: ${JSON.stringify(renumber)}`);
  }
  if (coAuthor !== undefined && coAuthor !== null) trailers.push(`Co-Authored-By: ${coAuthor}`);
  const note = notRewritten.length ? `Register references not rewritten (immutable history):\n${JSON.stringify(notRewritten)}\n\n` : '';
  return `${subject}\n\n${note}${trailers.join('\n')}\n`;
}

// Preview only. No number allocation, index write, launch issuance or publication.
// The execution path will have to re-read all these pins before any effect.
function registerPlanFromGit(git, parentSha, branches) {
  const candidates = branches.map(branch => {
    validateBranchName(branch, git);
    const tipSha = resolveCommitOid(git, `refs/heads/${branch}`, 'TRAIN-LAND-BRANCH');
    const base = computeUniqueMergeBase(git, parentSha, tipSha);
    const changed = git.strict(['diff', '--name-only', '--no-renames', base, tipSha, '--', ...registerFragments.PREFIXES])
      .trim().split('\n').filter(Boolean);
    const ids = new Set();
    for (const p of changed) {
      const mode = git.strict(['ls-tree', tipSha, '--', p]).trim();
      if (!/^100644 blob [a-f0-9]{40}\t/.test(mode)) throw err('REGISTER_PLAN_INVALID', 'register input must be a regular file');
      const bytes = git.strict(['show', `${tipSha}:${p}`], 'REGISTER_PLAN_INVALID', { buffer: true });
      if (p.startsWith(registerFragments.PREFIXES[0])) ids.add(registerFragments.readLaunch(bytes, p).launchId);
      else ids.add(registerFragments.parseFragment(p, bytes).launchId);
    }
    if (ids.size > 1) throw err('REGISTER_PLAN_INVALID', 'a candidate must identify exactly one launch');
    const launchId = ids.size ? [...ids][0] : null;
    if (launchId !== null) {
      const p = registerFragments.PREFIXES[0] + launchId + '.json';
      const mode = git.strict(['ls-tree', tipSha, '--', p]).trim();
      if (!/^100644 blob [a-f0-9]{40}\t/.test(mode)) throw err('REGISTER_PLAN_INVALID', 'candidate launch record unavailable');
      registerFragments.readLaunch(git.strict(['show', `${tipSha}:${p}`], 'REGISTER_PLAN_INVALID', { buffer: true }), p);
    }
    return { branch, launchId, tipSha };
  });
  return registerLanding.createRegisterPlan({ parentSha, candidates });
}
function registerPlan(options = {}) {
  try {
    const repo = path.resolve(options.repo || process.cwd());
    const git = attachGitMeta(repo, options.env || process.env, options.spawn);
    validateRefToken(options.base, '--base');
    if (!Array.isArray(options.candidates) || !options.candidates.length) throw err('TRAIN-LAND-ARGS', 'register-plan requires candidates');
    const parentSha = resolveCommitOid(git, options.base, 'TRAIN-LAND-BASE');
    const plan = registerPlanFromGit(git, parentSha, options.candidates);
    // A preview is refused if any input moved even while it was being read.
    if (resolveCommitOid(git, options.base, 'REGISTER_PLAN_MOVED') !== parentSha) throw err('REGISTER_PLAN_MOVED', 'base moved during preview');
    for (const c of plan.candidates) if (resolveCommitOid(git, `refs/heads/${c.branch}`, 'REGISTER_PLAN_MOVED') !== c.tipSha) {
      throw err('REGISTER_PLAN_MOVED', 'candidate tip moved during preview');
    }
    return { ok: true, plan };
  } catch (e) { return failResult(e.code || 'REGISTER_PLAN_INVALID', e.detail || e.message); }
}

const registerTrees = new WeakMap();
const registerContexts = new WeakMap();
// Immutable Git object snapshots; blobs are loaded once, only if consumed.
function registerTree(git, ref) {
  const pinned = SHA.test(ref);
  let cachedTrees = registerTrees.get(git);
  if (!cachedTrees) { cachedTrees = new Map(); registerTrees.set(git, cachedTrees); }
  if (pinned && cachedTrees.has(ref)) return cachedTrees.get(ref);
  const tree = new Map();
  for (const row of git.strict(['ls-tree', '-r', '-z', '--full-tree', ref]).split('\0').filter(Boolean)) {
    const m = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(row);
    if (!m || tree.has(m[4])) throw err('REGISTER_INPUT', 'invalid Git tree inventory');
    let cached;
    tree.set(m[4], { mode: m[1], bytes: () => {
      if (cached === undefined) {
        const size = Number(git.strict(['cat-file', '-s', m[3]]).trim());
        if (!Number.isSafeInteger(size) || size < 0 || size > registerLanding.MAX_FILE) throw err('REGISTER_LIMIT', 'oversize register input');
        cached = git.strict(['cat-file', 'blob', m[3]], 'REGISTER_INPUT', { buffer: true });
        if (cached.length !== size) throw err('REGISTER_INPUT', 'partial register blob');
      }
      return cached;
    } });
  }
  if (pinned) cachedTrees.set(ref, tree);
  return tree;
}

function registerAuthority(git, trees) {
  const ref = 'refs/register/launches';
  const paths = new Map();
  for (const tree of trees) for (const [p, e] of tree) if (p.startsWith(registerFragments.PREFIXES[0])) {
    const bytes = registerFragments.bytesOf(e);
    if (paths.has(p) && !paths.get(p).equals(bytes)) throw err('LAUNCH_PROVENANCE_MISSING', 'issuance bytes differ');
    paths.set(p, bytes);
  }
  if (!paths.size) return { issueProofs: new Map(), pin: null, recheck() {} };
  const pin = resolveCommitOid(git, ref, 'LAUNCH_AUTHORITY_MISSING');
  const rows = git.strict(['rev-list', '--reverse', '--topo-order', '--parents', pin]).trim().split('\n');
  const commits = rows.map(row => {
    const [sha, ...parents] = row.split(' '), tree = registerTree(git, sha);
    if ([...tree.values()].some(e => e.mode !== '100644')) throw err('LAUNCH_LEDGER_INVALID', 'non-regular authority record');
    return { sha, parents, tree };
  });
  const authority = { bootstrapSha: commits[0].sha, commits };
  const known = new Set(commits.map(c => c.sha));
  const reflog = git.strict(['reflog', 'show', '--format=%H', ref]).trim().split('\n').filter(Boolean);
  if (!reflog.length || reflog.some(sha => !known.has(sha))) throw err('LAUNCH_LEDGER_INVALID', 'rewound issuance authority');
  const issueProofs = new Map();
  for (const [p, bytes] of paths) {
    const record = registerFragments.readLaunch(bytes, p);
    const first = commits.find(c => c.tree.has(p));
    if (!first) throw err('LAUNCH_PROVENANCE_MISSING', 'record absent from authority');
    const proof = { launchId: record.launchId, recordDigest: registerFragments.digest(bytes), issueCommit: first.sha, bootstrapSha: authority.bootstrapSha };
    launchLedger.verifyIssueProofOperator({ bytes, path: p, proof, authority });
    issueProofs.set(record.launchId, proof);
  }
  return { issueProofs, pin, recheck() {
    if (resolveCommitOid(git, ref, 'LAUNCH_AUTHORITY_MISSING') !== pin) throw err('REGISTER_PLAN_MOVED', 'issuance authority moved');
  } };
}

// Only this Git boundary can prove an unrelated repository has no pinned
// historical objects. Pure compiler callers default to requiring the ledger.
function registerHistoryRequired(git, trees) {
  if (trees.every(tree => !registerCompiler.historyNeedsInventory(tree))) return true;
  return registerCompiler.historyRequired(git.strict(registerCompiler.historyObjectArgs, 'REGISTER_HISTORY_LEDGER'));
}
function assertRegisterIntegration(git, parent, result) {
  const tree = registerTree(git, result);
  registerCompiler.checkHistoryTree(tree, registerHistoryRequired(git, [tree]));
  if (!git.strict(['ls-tree', parent, '--', registerCompiler.STATE]).trim()) return;
  const changed = git.strict(['diff', '--name-only', '-z', '--no-renames', parent, result, '--']).split('\0')
    .filter(p => registerFragments.COMPILED.includes(p) || p.toLowerCase().startsWith(registerCompiler.ROOT));
  if (changed.length) throw err('REGISTER_INTEGRATION_DRIFT', 'integration changes protected register inputs or views');
}

const registerViewLabels = Object.freeze(registerLabels());
function registerCandidate(baseTree, tipTree) {
  const F = registerFragments, ids = new Set();
  for (const p of new Set([...baseTree.keys(), ...tipTree.keys()])) if (F.PREFIXES.some(prefix => p.toLowerCase().startsWith(prefix))) {
    const before = baseTree.get(p), after = tipTree.get(p);
    if (before && after && before.mode === after.mode && F.bytesOf(before).equals(F.bytesOf(after))) continue;
    if (before || !after || after.mode !== '100644') throw err('FRAGMENT_IMMUTABLE', 'candidate changes an existing or non-regular fragment');
    const bytes = F.bytesOf(after);
    ids.add(p.startsWith(F.PREFIXES[0]) ? F.readLaunch(bytes, p).launchId : F.parseFragment(p, bytes).launchId);
  }
  if (ids.size > 1) throw err('FRAGMENT_FOREIGN', 'candidate changes more than one launch');
  const launchId = ids.size ? [...ids][0] : null;
  if (launchId) {
    const blocked = F.checkPackageWrites({ baseTree, tree: tipTree });
    if (blocked.length) throw err(blocked[0].code, 'launch candidate edits shared register inputs');
    const record = tipTree.get(F.PREFIXES[0] + launchId + '.json');
    if (!record || baseTree.has(F.PREFIXES[0] + launchId + '.json')) throw err('FRAGMENT_IMMUTABLE', 'new launch needs its issued record');
    const r = F.readLaunch(F.bytesOf(record), F.PREFIXES[0] + launchId + '.json');
    for (const [p, e] of tipTree) if (F.PREFIXES.slice(1).some(prefix => p.startsWith(prefix))) {
      const f = F.parseFragment(p, F.bytesOf(e));
      if (f.launchId === launchId && f.packageId !== r.packageId) throw err('FRAGMENT_FOREIGN', 'fragment package differs from issuance');
    }
  }
  return launchId;
}
function sameRegisterFiles(expected, actual, includeViews = false) {
  const F = registerFragments;
  const paths = new Set([...expected.keys(), ...actual.keys()].filter(p => p.toLowerCase().startsWith(registerCompiler.ROOT) || includeViews && F.COMPILED.includes(p)));
  for (const p of paths) {
    const a = expected.get(p), b = actual.get(p);
    if (!a || !b || a.mode !== b.mode || !F.bytesOf(a).equals(F.bytesOf(b))) throw err('REGISTER_LANDING_INVALID', `register transition differs at ${p}`);
  }
}
function registerProofReader(git) {
  return sha => /^[a-f0-9]{7,40}$/.test(sha) && git.raw(['cat-file', '-t', sha]).stdout?.toString().trim() === 'commit';
}
function validateTrainLaunch(parentTree, planned, launchId, authority, proofReader) {
  if (launchId === null) return;
  // Validate the provisional numeric projection while keeping train-owned
  // artifacts identical in both package snapshots. Original package writes
  // were separately checked against its actual merge-base by registerCandidate.
  const F = registerFragments, C = registerCompiler, tree = new Map(planned.tree), baseTree = new Map(parentTree);
  for (const p of [...tree.keys()]) if (p.toLowerCase().startsWith(C.ROOT)) tree.delete(p);
  for (const [p, e] of parentTree) if (p.toLowerCase().startsWith(C.ROOT)) tree.set(p, e);
  for (const [p, bytes] of planned.result.outputs) { tree.set(p, C.entry(bytes)); baseTree.set(p, C.entry(bytes)); }
  const record = F.readLaunch(F.bytesOf(tree.get(F.PREFIXES[0] + launchId + '.json')), F.PREFIXES[0] + launchId + '.json');
  const result = F.validateFragments({ tree, baseTree, mode: 'package', packageId: record.packageId, launchId,
    issueProofs: C.scopedProofs(tree, authority.issueProofs), schemaState: 'active', proofReader,
    projectionContext: { legacy: C.readLegacy({ tree: parentTree, legacy: planned.parentLegacy }).reg, landing: planned.result.landing } });
  if (!result.ok) throw err(result.diagnostics[0]?.code || 'REGISTER_FRAGMENT', 'package validator refused provisional launch projection');
}
function registerContext(git, head, authority) {
  let contexts = registerContexts.get(git);
  if (!contexts) { contexts = new Map(); registerContexts.set(git, contexts); }
  const cacheKey = head + ':' + authority.pin;
  if (contexts.has(cacheKey)) return contexts.get(cacheKey);
  const C = registerCompiler, F = registerFragments, tree = registerTree(git, head);
  if (!tree.has(C.STATE)) {
    const history = git.strict(['log', '--first-parent', '-1', '--format=%H', head, '--', C.STATE]).trim();
    if (history || [...tree.keys()].some(p => p.toLowerCase().startsWith(C.ROOT))) throw err('REGISTER_LANDING_UNAVAILABLE', 'missing or partial register seed after bootstrap');
    return null;
  }
  const state = C.readJson(tree, C.STATE);
  F.keys(state, ['schema', 'mode', 'migrationSha', 'legacyManifestDigest'], [], 'REGISTER_LANDING_UNAVAILABLE');
  consumerMode.modeOf(tree);
  if (git.raw(['merge-base', '--is-ancestor', state.migrationSha, head]).status !== 0) throw err('REGISTER_LANDING_UNAVAILABLE', 'migration outside parent chain');
  const rows = git.strict(['rev-list', '--first-parent', '--reverse', '--parents', `${state.migrationSha}..${head}`]).trim().split('\n');
  let parent = state.migrationSha, previousTree = registerTree(git, parent), legacy = null;
  const shadowTransitions = [], proofReader = registerProofReader(git);
  for (const row of rows) {
    const [sha, ...parents] = row.split(' '), actual = registerTree(git, sha);
    if (parents.length !== 1 || parents[0] !== parent) throw err('REGISTER_LANDING_INVALID', 'nonlinear shadow history');
    const message = git.strict(['log', '-1', '--format=%B', sha]), subject = message.split('\n')[0];
    if (legacy === null) {
      if (subject !== `register bootstrap from ${parent}`) throw err('REGISTER_BOOTSTRAP_INVALID', 'seed needs a separate bootstrap transition');
      const seed = C.bootstrapRegister({ parentTree: previousTree, parentSha: parent, issueProofs: authority.issueProofs, proofReader, viewLabels: registerViewLabels,
        historyRequired: registerHistoryRequired(git, [previousTree]) });
      sameRegisterFiles(seed.tree, actual, true);
      // A bootstrap changes only its exact seed files.
      const changed = git.strict(['diff', '--name-only', '-z', parent, sha]).split('\0').filter(Boolean);
      if (changed.length !== seed.files.size || changed.some(p => !seed.files.has(p))) throw err('REGISTER_BOOTSTRAP_INVALID', 'bootstrap includes unrelated changes');
      legacy = seed.legacy;
    } else if (subject === `register consumers ${consumerMode.modeOf(actual)} from ${parent}`) {
      verifyConsumerTransition(git, parent, sha, actual, { tree: previousTree, legacy, shadowTransitions });
    } else if (isIntegrationSubject(subject)) {
      if (/(?:landed-tip|register-renumber)\s*:/i.test(message)) throw err('REGISTER_INTEGRATION_DRIFT', 'integration has landing trailers');
      assertRegisterIntegration(git, parent, sha);
    } else if (!subject.startsWith('land ')) {
      assertRegisterIntegration(git, parent, sha);
    } else {
      const landed = readLanding(message);
      if (!SQUASH_SUBJECT_RE.test(subject) || landed.reason || landed.form !== 'TRAILER') throw err('REGISTER_INTEGRATION_DRIFT', 'unrecognized transition after seed');
      const base = computeUniqueMergeBase(git, parent, landed.tip), tipTree = registerTree(git, landed.tip);
      const launchId = registerCandidate(registerTree(git, base), tipTree);
      const ordinary = computeLegacySquashTree(git, base, parent, landed.tip, { purpose: 'train-squash' });
      const planned = C.planRegisterTrain({ parentTree: previousTree, tree: registerTree(git, ordinary.treeOid), parentSha: parent,
        tipSha: landed.tip, legacy, issueProofs: authority.issueProofs, proofReader, viewLabels: registerViewLabels, launchId, renumber: ordinary.renumber || null,
        historyRequired: registerHistoryRequired(git, [previousTree, registerTree(git, ordinary.treeOid)]) });
      validateTrainLaunch(previousTree, { ...planned, parentLegacy: legacy }, launchId, authority, proofReader);
      sameRegisterFiles(planned.tree, actual, true);
      if (!isDeepStrictEqual(readRenumber(message), planned.renumber || null)) throw err('TRAIN-LAND-RENUMBER', 'historical map differs from allocation replay');
      shadowTransitions.push({ parentSha: parent, tipSha: landed.tip, resultSha: sha, inputDigest: planned.result.inputDigest,
        expected: planned.result.outputs, actual: planned.observed,
        parentViews: new Map(F.COMPILED.map(p => [p, C.bytesAt(previousTree, p)])), renumberMessage: message });
      legacy = planned.legacy;
    }
    parent = sha; previousTree = actual;
  }
  if (!legacy || state.migrationSha !== legacy.migrationSha || state.legacyManifestDigest !== legacy.manifestDigest) throw err('REGISTER_BOOTSTRAP_INVALID', 'seed manifest pin differs');
  const stats = registerLanding.verifyShadowTransitions({ raw: C.bytesAt(tree, C.SHADOW), transitions: shadowTransitions });
  const context = { tree, legacy, stats, shadowTransitions };
  contexts.set(cacheKey, context);
  return context;
}

function writeRegisterTree(git, treeOid, files, parent, rebuild = false, shadowOptions = null) {
  const gitDir = path.resolve(git.cwd, git.strict(['rev-parse', '--git-dir']).trim());
  const index = path.join(gitDir, `register-train-idx-${process.pid}-${require('node:crypto').randomBytes(12).toString('hex')}`);
  try {
    const idx = makeGitWithIndex(git, index); idx(['read-tree', treeOid]);
    const apply = updates => { for (const u of updates) idx(['update-index', '--add', '--cacheinfo', `${u.mode},${u.oid},${u.path}`]); };
    apply([...files].map(([p, e]) => ({ path: p, mode: '100644', oid: git.strict(['hash-object', '-w', '--stdin'], 'REGISTER_INPUT', { input: registerFragments.bytesOf(e) }).trim() })));
    let result = idx(['write-tree']).trim();
    if (rebuild && generated.active(git, parent, result)) {
      const regenerated = generated.rebuild(git, result, parent, { shadow: shadowOptions ? { tip: shadowOptions.tip } : null });
      apply(regenerated.updates || []); result = idx(['write-tree']).trim();
      if (shadowOptions) shadowOptions.capture(regenerated.shadow || null);
    }
    if (!SHA.test(result)) throw err('REGISTER_INPUT', 'invalid private tree');
    return result;
  } finally { try { fs.unlinkSync(index); } catch { /* private temporary index only */ } }
}

function computeExpectedSquashTree(git, mergeBaseOid, parentOid, tipOid, { purpose = 'train-squash' } = {}) {
  const ordinary = computeLegacySquashTree(git, mergeBaseOid, parentOid, tipOid, { purpose });
  if (purpose === 'author-merge') return ordinary;
  const ordinaryTree = registerTree(git, ordinary.treeOid);
  const historyRequired = registerHistoryRequired(git, [ordinaryTree]);
  registerCompiler.checkHistoryTree(ordinaryTree, historyRequired);
  const parentTree = registerTree(git, parentOid), tipTree = registerTree(git, tipOid);
  consumerMode.sameMode(parentTree, tipTree);
  const launchId = registerCandidate(registerTree(git, computeUniqueMergeBase(git, parentOid, tipOid)), tipTree);
  if (!parentTree.has(registerCompiler.STATE)) {
    registerContext(git, parentOid, { issueProofs: new Map(), pin: null });
    if (launchId || [...parentTree.keys()].some(p => p.toLowerCase().startsWith(registerCompiler.ROOT))) throw err('REGISTER_LANDING_UNAVAILABLE', 'bootstrap required before launch squash');
    return ordinary;
  }
  const authority = registerAuthority(git, [parentTree, tipTree]);
  const context = registerContext(git, parentOid, authority);
  const planned = registerCompiler.planRegisterTrain({ parentTree, tree: registerTree(git, ordinary.treeOid), parentSha: parentOid, tipSha: tipOid,
    legacy: context.legacy, issueProofs: authority.issueProofs, proofReader: registerProofReader(git), viewLabels: registerViewLabels, launchId, renumber: ordinary.renumber || null, historyRequired });
  validateTrainLaunch(parentTree, { ...planned, parentLegacy: context.legacy }, launchId, authority, registerProofReader(git));
  authority.recheck();
  let shadow = ordinary.shadow || null;
  const treeOid = writeRegisterTree(git, ordinary.treeOid, planned.files, parentOid, true,
    { tip: tipOid, capture: value => { shadow = value; } });
  return { ...ordinary, treeOid, shadow, renumber: planned.renumber,
    register: { differentPaths: planned.differentPaths } };
}

function verifyRegisterExecutionPlan(git, plan, head, branch) {
  registerLanding.verifyRegisterPlanPins({ plan, ...registerPlanFromGit(git, plan.parentSha, plan.candidates.map(c => c.branch)) });
  const planTree = registerTree(git, plan.parentSha), tips = plan.candidates.map(c => registerTree(git, c.tipSha));
  const authority = registerAuthority(git, [planTree, ...tips]);
  const combined = new Map(planTree);
  for (let i = 0; i < tips.length; i++) {
    const base = registerTree(git, computeUniqueMergeBase(git, plan.parentSha, plan.candidates[i].tipSha));
    if (registerCandidate(base, tips[i]) !== plan.candidates[i].launchId) throw err('REGISTER_PLAN_MOVED', 'candidate identity differs');
    for (const [p, e] of tips[i]) if (registerFragments.PREFIXES.some(prefix => p.startsWith(prefix))) {
      if (combined.has(p) && !registerFragments.bytesOf(combined.get(p)).equals(registerFragments.bytesOf(e))) throw err('FRAGMENT_IMMUTABLE', 'plan replaces an issued fragment');
      combined.set(p, e);
    }
  }
  if (plan.candidates.some(c => c.launchId !== null)) {
    const context = registerContext(git, plan.parentSha, authority);
    if (!context) throw err('REGISTER_LANDING_UNAVAILABLE', 'plan needs a separately bootstrapped base');
    const inputs = registerFragments.readFragmentInputs({ tree: combined, issueProofs: authority.issueProofs });
    if (!inputs.ok) throw err(inputs.diagnostics[0]?.code || 'REGISTER_FRAGMENT', 'invalid plan fragment inputs');
    registerLanding.planEntries({ tree: combined, parentSha: plan.parentSha, inputs,
      legacy: registerCompiler.readLegacy({ tree: combined, legacy: context.legacy }),
      candidates: plan.candidates.filter(c => c.launchId !== null).map(({ tipSha, launchId }) => ({ tipSha, launchId })) });
  }
  authority.recheck();
  if (git.raw(['merge-base', '--is-ancestor', plan.parentSha, head]).status !== 0) throw err('REGISTER_PLAN_MOVED', 'plan base is outside HEAD chain');
  const lines = head === plan.parentSha ? [] : git.strict(['rev-list', '--first-parent', '--reverse', '--parents', `${plan.parentSha}..${head}`]).trim().split('\n');
  let parent = plan.parentSha, count = 0, replay = null;
  const seen = new Set();
  for (const line of lines) {
    const [sha, ...parents] = line.split(' ');
    if (parents.length !== 1 || parents[0] !== parent) throw err('REGISTER_PLAN_MOVED', 'nonlinear plan parent chain');
    const message = git.strict(['log', '-1', '--format=%B', sha]);
    if (isIntegrationSubject(message.split('\n')[0])) {
      if (/(?:landed-tip|register-renumber)\s*:/i.test(message)) throw err('REGISTER_PLAN_MOVED', 'integration carries landing trailers');
      assertRegisterIntegration(git, parent, sha);
    } else {
      const c = plan.candidates[count], landed = readLanding(message);
      if (!c || !SQUASH_SUBJECT_RE.test(message.split('\n')[0]) || landed.reason || landed.form !== 'TRAILER' ||
          landed.branch !== c.branch || landed.tip !== c.tipSha) throw err('REGISTER_PLAN_MOVED', 'plan prefix differs from committed chain');
      const checked = verifySingleLandCommit(git, sha, parent, { seenBranches: seen, allowArchived: false });
      if (!checked.ok) throw err(checked.code, checked.detail);
      if (c.branch === branch) replay = sha;
      count++;
    }
    parent = sha;
  }
  if (replay) return { replay };
  if (plan.candidates[count]?.branch !== branch) throw err('REGISTER_PLAN_DEPENDENCY', 'squash must select the next unlanded plan candidate');
  return { candidate: plan.candidates[count] };
}

function registerBootstrap(options = {}) {
  try {
    const repo = path.resolve(options.repo || process.cwd()), git = attachGitMeta(repo, options.env || process.env, options.spawn);
    if (!SHA.test(options.parent || '') || !SHA.test(options.toolTip || '')) throw err('TRAIN-LAND-ARGS', 'bootstrap pins must be full SHA');
    assertCleanAndNoSequencer(git, repo);
    const parent = resolveCommitOid(git, 'HEAD');
    const approvalFile = path.resolve(repo, options.approval || '');
    const readApproval = () => {
      if (isProtectedPath(approvalFile, { mode: 'segment' }) ||
          /(?:^|[\\/])\.ai[\\/]runtime(?:[\\/]|$)/i.test(approvalFile)) throw err('REGISTER_BOOTSTRAP_AUTHORITY', 'approval must be an owner artifact outside disposable runtime');
      const r = require('../lib/path-safe.cjs').readFileGuarded(path.parse(approvalFile).root, approvalFile);
      if (!r.ok || r.bytes.length > 65536) throw err('REGISTER_BOOTSTRAP_AUTHORITY', 'approval must be a bounded guarded local owner artifact');
      const a = registerLanding.json(r.bytes);
      registerFragments.keys(a, ['schema', 'approvedBy', 'parentSha', 'toolSha'], [], 'REGISTER_BOOTSTRAP_AUTHORITY');
      if (a.schema !== 'register-bootstrap-approval/1' || !registerBootstrapOwners(registerTree(git, options.parent)).has(a.approvedBy) || a.parentSha !== options.parent || a.toolSha !== options.toolTip) throw err('REGISTER_BOOTSTRAP_AUTHORITY', 'operator approval does not match pinned bootstrap');
      return r.bytes;
    };
    const approval = readApproval();
    const parentTree = registerTree(git, parent), toolTree = registerTree(git, options.toolTip);
    const authority = registerAuthority(git, [parentTree]);
    if (parent !== options.parent) {
      const context = registerContext(git, parent, authority);
      if (!context || context.legacy.migrationSha !== options.parent) throw err('REGISTER_PLAN_MOVED', 'bootstrap parent moved');
      // A retry proves the bootstrap is the first commit after the approved parent.
      const chain = git.strict(['rev-list', '--first-parent', '--reverse', `${options.parent}..${parent}`]).trim().split('\n');
      return { ok: true, commit: chain[0], replay: true, generated: [] };
    }
    // The operator pins the certified tool. Executed local modules must match it,
    // and the bootstrap parent must already contain the same executable code.
    const verifyTool = () => {
      const sourceRoot = path.resolve(__dirname, '..', '..', '..');
      const loaded = new Set([__filename, ...Object.keys(require.cache)].filter(file =>
        file.startsWith(path.join(sourceRoot, '.ai', 'bin') + path.sep)));
      for (const file of loaded) {
        const p = path.relative(sourceRoot, file).split(path.sep).join('/'), e = toolTree.get(p), old = parentTree.get(p);
        const local = require('../lib/path-safe.cjs').readFileGuarded(repo, path.join(repo, p));
        if (!e || !old || !local.ok || e.mode !== '100644' || old.mode !== e.mode || !registerFragments.bytesOf(e).equals(local.bytes) ||
            !registerFragments.bytesOf(e).equals(registerFragments.bytesOf(old)) || !registerFragments.bytesOf(e).equals(fs.readFileSync(file))) {
          throw err('REGISTER_BOOTSTRAP_TOOL', `executed module differs from the certified pin or parent: ${p}`);
        }
      }
    };
    verifyTool();
    const seed = registerCompiler.bootstrapRegister({ parentTree, parentSha: parent, issueProofs: authority.issueProofs,
      proofReader: registerProofReader(git), viewLabels: registerViewLabels, historyRequired: registerHistoryRequired(git, [parentTree]) });
    const tree = writeRegisterTree(git, parent, seed.files, parent);
    const commit = git.strict(['commit-tree', tree, '-p', parent, '-m', `register bootstrap from ${parent}\n`], 'REGISTER_BOOTSTRAP_INVALID').trim();
    if (!SHA.test(commit)) throw err('REGISTER_BOOTSTRAP_INVALID', 'invalid bootstrap commit');
    registerContext(git, commit, authority);
    verifyTool();
    assertCleanAndNoSequencer(git, repo);
    authority.recheck();
    if (resolveCommitOid(git, 'HEAD') !== parent || !approval.equals(readApproval())) throw err('REGISTER_PLAN_MOVED', 'bootstrap pins or approval moved');
    const sym = git.raw(['symbolic-ref', '-q', 'HEAD']), target = sym.status === 0 ? String(sym.stdout).trim() : null;
    const checkout = prepareCheckout(git, parent, tree, 'bootstrap', 'TRAIN-LAND-GIT');
    let checkingOut = false, checkedOut = false;
    try {
      checkingOut = true;
      checkout(); checkedOut = true;
      if (target) git.strict(['update-ref', target, commit, parent]);
      else git.strict(['update-ref', '--no-deref', 'HEAD', commit, parent]);
    } catch (e) {
      // A failure after the checkout began resets nothing (see leftAsIs).
      if (checkingOut) e.detail = `${e.detail || e.message}; ${leftAsIs(git, parent, tree, 'bootstrap', checkedOut)}`;
      throw e;
    }
    return { ok: true, commit, tree, generated: [] };
  } catch (e) { return failResult(e.code || 'REGISTER_BOOTSTRAP_INVALID', e.detail || e.message); }
}
function checkConsumerOpenPackages(git, parentSha, tree, packages, { livePins = false } = {}) {
  const C = registerCompiler, F = registerFragments;
  if (!Array.isArray(packages) || new Set(packages.map(p => p?.branch)).size !== packages.length) throw err('REGISTER_LEGACY_PACKAGE', 'duplicate or missing package inventory');
  for (const p of packages) {
    F.keys(p, ['branch', 'tipSha'], [], 'REGISTER_LEGACY_PACKAGE');
    validateBranchName(p.branch, git);
    if (!SHA.test(p.tipSha) || livePins && resolveCommitOid(git, `refs/heads/${p.branch}`) !== p.tipSha) throw err('REGISTER_PLAN_MOVED', 'open package inventory moved');
    const base = computeUniqueMergeBase(git, parentSha, p.tipSha), tip = registerTree(git, p.tipSha);
    consumerMode.sameMode(tree, tip);
    const changed = git.strict(['diff', '--name-only', '-z', base, p.tipSha, '--']).split('\0');
    if (changed.some(name => F.COMPILED.includes(name) || name.toLowerCase().startsWith(C.ROOT))) throw err('REGISTER_LEGACY_PACKAGE', 'convert and recertify the pinned legacy package');
  }
}
function consumerActivationReady(git, parentSha, context, approval, { livePins = false } = {}) {
  const C = registerCompiler, F = registerFragments;
  const q = consumerMode.qualification(context.tree, approval.qualification);
  const ready = registerLanding.shadowReadiness({ raw: C.bytesAt(context.tree, C.SHADOW), transitions: context.shadowTransitions });
  if (!ready.shadowReady) throw err('REGISTER_SHADOW_NOT_READY', 'verified compiler streak or coverage is incomplete');
  const historical = C.readJson(context.tree, q.historical.path), triples = new Set();
  if (historical.schema !== 'register-historical/1' || !Array.isArray(historical.records)) throw err('REGISTER_MODE_QUALIFICATION', 'historical corpus is unavailable');
  const roundtrip = (sha, pins) => {
    if (!SHA.test(sha)) throw err('REGISTER_MODE_QUALIFICATION', 'historical source is not pinned');
    const source = registerTree(git, sha), views = new Map(F.COMPILED.map(p => [p, source.get(p)]));
    if (pins && !F.COMPILED.every(p => F.digest(C.bytesAt(source, p)) === pins[p])) throw err('REGISTER_MODE_QUALIFICATION', 'historical view pin differs');
    const seed = C.exportLegacy({ tree: views, sourceSha: sha, viewLabels: registerViewLabels, historical: true });
    const input = { tree: new Map([...views, ...seed.files, [F.LANDING, C.entry(Buffer.alloc(0))]]), legacy: seed, viewLabels: registerViewLabels };
    const compiled = C.compileHistorical(input);
    if (!F.COMPILED.every(p => compiled.outputs.get(p).equals(C.bytesAt(source, p)))) throw err('MIGRATION_BYTES', 'historical roundtrip differs');
    return { input, source, seed };
  };
  for (const record of historical.records) {
    if (!SHA.test(record.sha) || !SHA.test(record.parentSha) || git.strict(['rev-parse', record.sha + '^']).trim() !== record.parentSha) throw err('REGISTER_MODE_QUALIFICATION', 'historical parent pin differs');
    const old = roundtrip(record.parentSha, record.parentViews), current = roundtrip(record.sha, record.views);
    const triple = F.digest(Buffer.from(F.COMPILED.map(p => F.digest(C.bytesAt(current.source, p))).join('\n')));
    triples.add(triple);
    const delta = C.planLegacyDelta({ legacy: C.readLegacy(old.input), parentSha: record.parentSha, tipSha: record.sha,
      process: C.bytesAt(current.source, F.COMPILED[0]), open: C.bytesAt(current.source, F.COMPILED[1]), historical: true });
    old.input.tree.set(delta.path, C.entry(delta.bytes));
    old.input.legacy = { ...old.input.legacy, transitions: [delta.transition], verifyDelta: (t, d) => isDeepStrictEqual(t, delta.transition) && isDeepStrictEqual(d, delta.value) };
    const replay = C.compileHistorical(old.input);
    if (!F.COMPILED.every(p => replay.outputs.get(p).equals(C.bytesAt(current.source, p)))) throw err('MIGRATION_BYTES', 'historical replay differs');
  }
  if (triples.size < 20) throw err('REGISTER_MODE_QUALIFICATION', 'historical corpus needs twenty distinct triples');
  const migration = roundtrip(context.legacy.migrationSha);
  if (!q.migration.every((r, i) => r.actual === F.digest(C.bytesAt(migration.source, F.COMPILED[i])))) throw err('MIGRATION_BYTES', 'migration qualification differs');
  const shadow = require('../lib/register-consumers.cjs').shadowCorpus({ repo: git.cwd, targetSha: parentSha, paths: q.consumerReports });
  if (shadow.unexplained !== 0 || !shadow.records.some(r => r.typed.length)) throw err('REGISTER_CONSUMER_SHADOW', 'consumer shadow has unexplained differences or no claims');
  checkConsumerOpenPackages(git, parentSha, context.tree, q.openPackages, { livePins });
  const compiled = C.compileRegister({ tree: context.tree, legacy: context.legacy,
    issueProofs: registerAuthority(git, [context.tree]).issueProofs, proofReader: registerProofReader(git),
    schemaState: 'active', viewLabels: registerViewLabels, historyRequired: registerHistoryRequired(git, [context.tree]) });
  if (!compiled.ok || !F.COMPILED.every(p => compiled.outputs.get(p).equals(C.bytesAt(context.tree, p)))) throw err('REGISTER_PARENT_DRIFT', 'compiled views differ at cut-over');
  if (q.farm.some(r => r.inputDigest !== compiled.inputDigest || !isDeepStrictEqual(r.hashes,
    F.COMPILED.map(p => F.digest(compiled.outputs.get(p)))))) throw err('REGISTER_MODE_QUALIFICATION', 'two-host hashes do not describe this input');
  return shadow;
}
function verifyConsumerTransition(git, parentSha, resultSha, tree, context) {
  const rows = consumerMode.records(tree), record = rows.at(-1);
  if (!record || record.parentSha !== parentSha) throw err('REGISTER_MODE_HISTORY', 'mode transition is not pinned to its parent');
  const owners = registerBootstrapOwners(context.tree);
  consumerMode.approvalFor(context.tree, record.approval, parentSha, record.to, owners);
  if (record.to === 'active') consumerActivationReady(git, parentSha, context, record.approval);
  const expected = consumerMode.transition({ tree: context.tree, parentSha, to: record.to, approval: record.approval });
  sameRegisterFiles(expected.tree, tree, true);
  const changed = git.strict(['diff', '--name-only', '-z', parentSha, resultSha]).split('\0').filter(Boolean);
  if (changed.length !== expected.files.size || changed.some(p => !expected.files.has(p))) throw err('REGISTER_MODE_HISTORY', 'mode transition changes unrelated files');
}
function registerConsumerMode(options = {}) {
  try {
    const repo = path.resolve(options.repo || process.cwd()), git = attachGitMeta(repo, options.env || process.env, options.spawn);
    if (!SHA.test(options.parent || '') || !SHA.test(options.toolTip || '') || !consumerMode.MODES.includes(options.to)) throw err('TRAIN-LAND-ARGS', 'consumer transition needs pinned parent/tool and target mode');
    assertCleanAndNoSequencer(git, repo);
    const approvalFile = path.resolve(repo, options.approval || '');
    const readApproval = () => {
      if (isProtectedPath(approvalFile, { mode: 'segment' }) ||
          /(?:^|[\\/])\.ai[\\/]runtime(?:[\\/]|$)/i.test(approvalFile)) throw err('REGISTER_MODE_AUTHORITY', 'approval must be a durable local owner artifact');
      const r = require('../lib/path-safe.cjs').readFileGuarded(path.parse(approvalFile).root, approvalFile);
      if (!r.ok || r.bytes.length > 65536) throw err('REGISTER_MODE_AUTHORITY', 'approval must be a bounded regular file');
      return r.bytes;
    };
    const approvalBytes = readApproval(), approval = registerLanding.json(approvalBytes);
    const approvedTree = registerTree(git, options.parent);
    consumerMode.approvalFor(approvedTree, approval, options.parent, options.to, registerBootstrapOwners(approvedTree));
    if (approval.toolSha !== options.toolTip) throw err('REGISTER_MODE_AUTHORITY', 'tool pin differs from owner approval');
    const head = resolveCommitOid(git, 'HEAD'), tree = registerTree(git, head), authority = registerAuthority(git, [tree]);
    const context = registerContext(git, head, authority);
    if (!context) throw err('REGISTER_LANDING_UNAVAILABLE', 'verified bootstrap required');
    if (head !== options.parent) {
      // Only an exact prior transition at HEAD is an idempotent retry.
      const parents = git.strict(['rev-list', '--parents', '-1', head]).trim().split(' ');
      const record = consumerMode.records(tree).at(-1);
      if (parents.length !== 2 || parents[1] !== options.parent || record?.to !== options.to ||
          !isDeepStrictEqual(record.approval, approval)) throw err('REGISTER_PLAN_MOVED', 'approved parent moved');
      authority.recheck();
      if (resolveCommitOid(git, 'HEAD') !== head || !approvalBytes.equals(readApproval())) throw err('REGISTER_PLAN_MOVED', 'retry input moved');
      return { ok: true, commit: head, replay: true, mode: options.to };
    }
    if (options.to === 'active') consumerActivationReady(git, head, context, approval, { livePins: true });
    const toolTree = registerTree(git, options.toolTip);
    const verifyTool = () => {
      const sourceRoot = path.resolve(__dirname, '../../..');
      for (const file of new Set([__filename, ...Object.keys(require.cache)].filter(f => f.startsWith(path.join(sourceRoot, '.ai', 'bin') + path.sep)))) {
        const p = path.relative(sourceRoot, file).split(path.sep).join('/'), pinned = toolTree.get(p), installed = tree.get(p);
        const read = require('../lib/path-safe.cjs').readFileGuarded(repo, path.join(repo, p));
        if (!pinned || !installed || pinned.mode !== '100644' || installed.mode !== '100644' || !read.ok ||
            !registerFragments.bytesOf(pinned).equals(registerFragments.bytesOf(installed)) ||
            !registerFragments.bytesOf(pinned).equals(read.bytes) || !read.bytes.equals(fs.readFileSync(file))) throw err('REGISTER_MODE_TOOL', 'executed code differs from the owner pin');
      }
    };
    verifyTool();
    const next = consumerMode.transition({ tree, parentSha: head, to: options.to, approval });
    const oid = writeRegisterTree(git, head, next.files, head);
    const commit = git.strict(['commit-tree', oid, '-p', head, '-m', `register consumers ${options.to} from ${head}\n`]).trim();
    registerContext(git, commit, authority);
    verifyTool(); authority.recheck(); assertCleanAndNoSequencer(git, repo);
    if (resolveCommitOid(git, 'HEAD') !== head || !approvalBytes.equals(readApproval())) throw err('REGISTER_PLAN_MOVED', 'transition input moved');
    if (options.to === 'active') consumerActivationReady(git, head, context, approval, { livePins: true });
    const symbolic = git.raw(['symbolic-ref', '-q', 'HEAD']);
    if (symbolic.error || ![0, 1].includes(symbolic.status)) throw err('REGISTER_PLAN_MOVED', 'cannot pin target ref');
    const target = symbolic.status === 0 ? String(symbolic.stdout).trim() : null;
    let checkedOut = false;
    try {
      git.strict(['read-tree', '--reset', '-u', oid]); checkedOut = true;
      if (target) git.strict(['update-ref', target, commit, head]);
      else git.strict(['update-ref', '--no-deref', 'HEAD', commit, head]);
    } catch (e) {
      if (checkedOut && resolveCommitOid(git, 'HEAD') === head) git.raw(['read-tree', '--reset', '-u', head]);
      throw e;
    }
    return { ok: true, commit, mode: options.to, replay: false };
  } catch (e) { return failResult(e.code || 'REGISTER_MODE_INVALID', e.detail || e.message); }
}
function registerReadiness(options = {}) {
  try {
    const repo = path.resolve(options.repo || process.cwd()), git = attachGitMeta(repo, options.env || process.env, options.spawn);
    const ref = options.head || 'HEAD', head = resolveCommitOid(git, ref);
    const authority = registerAuthority(git, [registerTree(git, head)]), context = registerContext(git, head, authority);
    if (!context) throw err('REGISTER_LANDING_UNAVAILABLE', 'register has not been bootstrapped');
    const readiness = registerLanding.shadowReadiness({ raw: registerCompiler.bytesAt(context.tree, registerCompiler.SHADOW), transitions: context.shadowTransitions });
    authority.recheck();
    if (resolveCommitOid(git, ref) !== head) throw err('REGISTER_PLAN_MOVED', 'readiness head moved');
    return { ok: true, head, mode: consumerMode.modeOf(context.tree), ...readiness };
  } catch (e) { return failResult(e.code || 'REGISTER_INPUT', e.detail || e.message); }
}
function readRegisterSnapshot({ repo = process.cwd(), ref, env = process.env }) {
  const git = attachGitMeta(path.resolve(repo), env), head = resolveCommitOid(git, ref);
  const tree = registerTree(git, head), authority = registerAuthority(git, [tree]), context = registerContext(git, head, authority);
  if (!context) throw err('REGISTER_LANDING_UNAVAILABLE', 'active snapshot requires verified bootstrap history');
  authority.recheck();
  return { tree, legacy: context.legacy, issueProofs: authority.issueProofs, proofReader: registerProofReader(git), schemaState: 'active',
    historyRequired: registerHistoryRequired(git, [tree]) };
}
function readRegisterPackageSnapshot({ repo = process.cwd(), ref, env = process.env }) {
  const git = attachGitMeta(path.resolve(repo), env), head = resolveCommitOid(git, ref);
  const tree = registerTree(git, head), manifest = registerCompiler.readJson(tree, MANIFEST_PATH);
  if (typeof manifest.integrationBranch !== 'string' || !BRANCH_RE.test(manifest.integrationBranch)) throw err('REGISTER_BASE_UNKNOWN', 'candidate has no integration line');
  let line = null;
  for (const name of [`refs/remotes/origin/${manifest.integrationBranch}`, `refs/heads/${manifest.integrationBranch}`]) {
    const r = git.raw(['rev-parse', '--verify', '--quiet', `${name}^{commit}`]);
    if (!r.error && r.status === 0 && SHA.test(String(r.stdout).trim())) { line = String(r.stdout).trim(); break; }
    if (r.error || r.status !== 1) throw err('REGISTER_BASE_UNKNOWN', 'cannot resolve integration line');
  }
  if (!line) throw err('REGISTER_BASE_UNKNOWN', 'candidate has no integration line');
  const baseSha = computeUniqueMergeBase(git, head, line), baseTree = registerTree(git, baseSha), lineTree = registerTree(git, line);
  consumerMode.sameMode(lineTree, tree);
  const authority = registerAuthority(git, [lineTree, tree]), context = registerContext(git, line, authority);
  if (!context) throw err('REGISTER_LANDING_UNAVAILABLE', 'candidate requires verified integration history');
  const launchId = registerCandidate(baseTree, tree);
  const blocked = registerFragments.checkPackageWrites({ baseTree, tree });
  if (blocked.length) throw err(blocked[0].code, 'package edits train-owned register data');
  // A package must rebase after mode/landing changes. Its train-owned bytes
  // cannot be silently replaced by a newer line while checking its citations.
  sameRegisterFiles(lineTree, tree, true);
  authority.recheck();
  if (resolveCommitOid(git, ref) !== head) throw err('REGISTER_PLAN_MOVED', 'candidate moved');
  const packageId = launchId ? registerFragments.readLaunch(registerFragments.bytesOf(tree.get(registerFragments.PREFIXES[0] + launchId + '.json')),
    registerFragments.PREFIXES[0] + launchId + '.json').packageId : null;
  return { tree, legacy: context.legacy, issueProofs: registerCompiler.scopedProofs(tree, authority.issueProofs),
    proofReader: registerProofReader(git), schemaState: 'active', historyRequired: registerHistoryRequired(git, [tree]),
    registerPackage: { sha: head, baseSha, tree, baseTree, packageId, launchId } };
}

function legacyRenumberReceipt(git, parent, tip) {
  // Missing maps are grandfathered only when BOTH recorded inputs actually
  // contain the older train tool. An absent tool is unknown, never legacy.
  const tool = '.ai/bin/ops-tools/train-land.cjs';
  return [parent, tip].every(ref => git.strict(['ls-tree', ref, '--', tool]).trim() &&
    !git.strict(['show', `${ref}:${tool}`]).includes(RENUMBER_CONTRACT));
}

// Run against the final tree, even on a clean text merge or without generators.
function validateMergedRegister(git, tree) {
  if (!git.strict(['ls-tree', tree, '--', REGISTER_PATH]).trim()) return;
  const text = git.strict(['show', `${tree}:${REGISTER_PATH}`]);
  const rows = parseRegisterRows(text).rows;
  const proposed = rows.filter(r => r.line.split('|').map(c => c.trim())[9] === 'proposed');
  if (!proposed.length) return;
  let register;
  try { register = parseJsonUnique(git.strict(['show', `${tree}:${OPEN_REGISTER_PATH}`])); }
  catch { throw err('TRAIN-LAND-PROCESS-COVERAGE', 'missing or invalid open register'); }
  for (const row of proposed) {
    const matching = (register.items || []).filter(item => item.sourceKey === 'PROC' && item.sourceIds?.includes(`PROC:${row.id}`));
    if (matching.length !== 1) throw err('TRAIN-LAND-PROCESS-COVERAGE', `${row.id} requires exactly one PROC item`);
  }
}

// Strict process-register reader without importing development-only tools/operator/*
function resolveRegister3Way(baseBuf, oursBuf, theirsBuf) {
  const b = parseRegisterRows(baseBuf);
  const o = parseRegisterRows(oursBuf);
  const t = parseRegisterRows(theirsBuf);
  if (b.skeleton !== o.skeleton || o.skeleton !== t.skeleton) {
    throw err('TRAIN-LAND-CONFLICT', 'PROCESS-REGISTER.md non-row skeleton changed');
  }
  // Every base row must remain byte-identical in both ours and theirs (no 3-way delete/modify)
  for (const br of b.rows) {
    if (!o.rows.some(r => r.line === br.line) || !t.rows.some(r => r.line === br.line)) {
      throw err('TRAIN-LAND-CONFLICT', `PROCESS-REGISTER.md modified or deleted base row ${br.id}`);
    }
  }
  const combined = o.rows.slice();
  for (const tr of t.rows) {
    const sameLine = combined.find(r => r.line === tr.line);
    if (sameLine) continue;
    // Closed rule: any P-number collision with different row text refuses (no silent renumbering in shipped squash)
    if (combined.some(r => r.id === tr.id || r.body === tr.body)) {
      throw err('TRAIN-LAND-CONFLICT', `PROCESS-REGISTER.md collision on ${tr.id}`);
    }
    combined.push(tr);
  }
  const additions = combined.slice(o.rows.length).map(r => r.line);
  const dataLines = new Set(o.rows.map(r => r.line));
  let lastIdx = -1;
  o.lines.forEach((l, idx) => { if (dataLines.has(l)) lastIdx = idx; });
  if (lastIdx < 0) throw err('TRAIN-LAND-CONFLICT', 'PROCESS-REGISTER.md has no process rows');
  const outLines = o.lines.slice();
  outLines.splice(lastIdx + 1, 0, ...additions);
  const rendered = outLines.join('\n');
  parseRegisterRows(rendered);
  return Buffer.from(rendered, 'utf8');
}

function parseManifestStrict(buf) {
  const d = decode(Buffer.isBuffer(buf) ? buf : Buffer.from(buf, 'utf8'), { bom: 'refuse', crlf: 'refuse', invisible: 'refuse' });
  if (!d.ok) throw err('TRAIN-LAND-CONFLICT', 'protocol-manifest.json failed strict decode');
  let obj;
  try { obj = parseJsonUnique(d.text); } catch { throw err('TRAIN-LAND-CONFLICT', 'protocol-manifest.json is invalid or has duplicate keys'); }
  if (!plain(obj)) throw err('TRAIN-LAND-CONFLICT', 'protocol-manifest.json root is not an object');
  return obj;
}

function resolveManifest3Way(baseBuf, oursBuf, theirsBuf) {
  const b = parseManifestStrict(baseBuf);
  const o = parseManifestStrict(oursBuf);
  const t = parseManifestStrict(theirsBuf);
  const keys = Object.keys(b).sort();
  if (!isDeepStrictEqual(keys, Object.keys(o).sort()) || !isDeepStrictEqual(keys, Object.keys(t).sort())) {
    throw err('TRAIN-LAND-CONFLICT', 'protocol-manifest.json top-level key set changed');
  }
  const out = Object.create(null);
  for (const key of Object.keys(o)) {
    const bv = b[key], ov = o[key], tv = t[key];
    if (MANIFEST_ARRAY_KEYS.has(key)) {
      if (!Array.isArray(bv) || !Array.isArray(ov) || !Array.isArray(tv)) throw err('TRAIN-LAND-CONFLICT', `manifest ${key} is not an array`);
      if (![...bv, ...ov, ...tv].every(x => typeof x === 'string')) throw err('TRAIN-LAND-CONFLICT', `manifest ${key} holds non-string`);
      const oSet = new Set(ov), tSet = new Set(tv);
      // 3-way deletion rule: if one side deleted a base item and the other side modified the array, refuse if ambiguous;
      // specifically, neither side may delete an item present in base when both sides touched the manifest
      for (const item of bv) {
        if (!oSet.has(item) || !tSet.has(item)) {
          throw err('TRAIN-LAND-CONFLICT', `manifest ${key} deleted base entry ${item} in 3-way conflict`);
        }
      }
      out[key] = [...new Set([...ov, ...tv])];
    } else if (key === 'testTiers') {
      if (!plain(bv) || !plain(ov) || !plain(tv)) throw err('TRAIN-LAND-CONFLICT', 'manifest testTiers is not an object');
      for (const bk of Object.keys(bv)) {
        if (!Object.hasOwn(ov, bk) || !Object.hasOwn(tv, bk)) {
          throw err('TRAIN-LAND-CONFLICT', `manifest testTiers deleted base key ${bk}`);
        }
        const oChanged = !isDeepStrictEqual(ov[bk], bv[bk]);
        const tChanged = !isDeepStrictEqual(tv[bk], bv[bk]);
        if (oChanged && tChanged && !isDeepStrictEqual(ov[bk], tv[bk])) {
          throw err('TRAIN-LAND-CONFLICT', `manifest testTiers conflicting edit on ${bk}`);
        }
      }
      const mergedTiers = Object.create(null);
      for (const k of Object.keys(ov)) {
        mergedTiers[k] = Object.hasOwn(bv, k) && !isDeepStrictEqual(tv[k], bv[k]) ? tv[k] : ov[k];
      }
      for (const k of Object.keys(tv)) {
        if (Object.hasOwn(mergedTiers, k)) {
          if (!Object.hasOwn(bv, k) && !isDeepStrictEqual(ov[k], tv[k])) {
            throw err('TRAIN-LAND-CONFLICT', `manifest testTiers collision on new key ${k}`);
          }
        } else {
          mergedTiers[k] = tv[k];
        }
      }
      out[key] = mergedTiers;
    } else {
      const oChanged = !isDeepStrictEqual(ov, bv);
      const tChanged = !isDeepStrictEqual(tv, bv);
      if (oChanged && tChanged && !isDeepStrictEqual(ov, tv)) {
        throw err('TRAIN-LAND-CONFLICT', `manifest non-mechanical conflict on ${key}`);
      }
      out[key] = tChanged ? tv : ov;
    }
  }
  return Buffer.from(`${JSON.stringify(out, null, 2)}\n`, 'utf8');
}

// Parse NUL-separated `git merge-tree --write-tree -z --no-messages --merge-base=<mb> <ours> <theirs>`
function parseMergeTreeOutput(out, status) {
  const tokens = out.split('\0');
  if (tokens.pop() !== '') throw err('TRAIN-LAND-GIT', 'git merge-tree output is not NUL-terminated');
  if (!tokens.length || !OBJECT_ID.test(tokens[0])) throw err('TRAIN-LAND-GIT', 'git merge-tree output missing root tree OID');
  const treeOid = tokens[0];
  const conflicts = new Map();
  for (const tok of tokens.slice(1)) {
    const m = MERGE_ENTRY.exec(tok);
    if (!m) throw err('TRAIN-LAND-GIT', 'unrecognized conflict entry in git merge-tree output');
    const [, mode, oid, stage, relPath] = m;
    if (!conflicts.has(relPath)) conflicts.set(relPath, new Map());
    const stageMap = conflicts.get(relPath);
    if (stageMap.has(stage)) throw err('TRAIN-LAND-GIT', `duplicate stage ${stage} for ${relPath}`);
    stageMap.set(stage, { mode, oid });
  }
  if (status === 0 && conflicts.size > 0) throw err('TRAIN-LAND-GIT', 'git merge-tree exited 0 with conflict stages');
  if (status === 1 && conflicts.size === 0) throw err('TRAIN-LAND-GIT', 'git merge-tree exited 1 without conflict stages');
  return { treeOid, conflicts };
}

// Shared deterministic tree computation used by BOTH squash and verify!
function computeLegacySquashTree(git, mergeBaseOid, parentOid, tipOid, { purpose = 'train-squash' } = {}) {
  if (!['train-squash', 'author-merge'].includes(purpose)) throw err('REGISTER_PURPOSE', 'explicit computation purpose required');
  // Preserve the train's writer boundary before inspecting any shadow state.
  const source = purpose === 'author-merge' ? parentOid : tipOid;
  const owned = git.strict(['diff', '--name-only', '-z', '--no-renames', mergeBaseOid, source, '--'])
    .split('\0').filter(p => p.toLowerCase().startsWith('docs/ops/register/'));
  if (owned.length) throw err('REGISTER_LANDING_WRITER', `package edits train-owned path ${owned[0]}`);
  const shadowPath = 'docs/ops/INDEX-SHADOW.jsonl';
  // A package cannot forge train observations, including deleting the stream.
  const streamChanged = git.strict(['diff', '--name-only', mergeBaseOid, tipOid, '--', shadowPath]).trim();
  const bootstrap = !git.strict(['ls-tree', '-z', mergeBaseOid, '--', shadowPath]) &&
    git.strict(['ls-tree', '-z', tipOid, '--', shadowPath]) && !git.strict(['show', `${tipOid}:${shadowPath}`]);
  if (streamChanged && !bootstrap && purpose !== 'author-merge') {
    throw err('TRAIN-LAND-CONFLICT', 'package changed train-owned observation stream');
  }
  const deferShadow = purpose === 'train-squash' && Boolean(git.strict(['ls-tree', parentOid, '--', registerCompiler.STATE]).trim());
  const regenerate = generated.active(git, parentOid, tipOid);
  const r = git.raw(['merge-tree', '--write-tree', '-z', '--no-messages', `--merge-base=${mergeBaseOid}`, parentOid, tipOid]);
  if (r.error || (r.status !== 0 && r.status !== 1)) {
    throw err('TRAIN-LAND-GIT', `git merge-tree failed (${r.status})`);
  }
  const { treeOid, conflicts } = parseMergeTreeOutput(String(r.stdout || ''), r.status);
  // Every call site passes the fork point of parentOid/tipOid as mergeBaseOid
  // (finding 11.105.3); a separate register base no longer exists.
  const registerBase = mergeBaseOid;
  const registerChanged = ref => git.strict(['diff', '--name-only', registerBase, ref, '--', OPEN_REGISTER_PATH, REGISTER_PATH]).length > 0;
  const processChanged = ref => git.strict(['diff', '--name-only', registerBase, ref, '--', REGISTER_PATH]).length > 0;
  const bothRegisters = registerChanged(parentOid) && registerChanged(tipOid);
  const union = regenerate && (conflicts.has(OPEN_REGISTER_PATH) || (bothRegisters && (processChanged(parentOid) || processChanged(tipOid))));
  const checkRegister = regenerate && !union && (registerChanged(parentOid) || registerChanged(tipOid));
  const validateRegister = registerChanged(parentOid) || registerChanged(tipOid);
  if (r.status === 0 && !regenerate) {
    if (validateRegister) validateMergedRegister(git, treeOid);
    return { treeOid, conflicts: [] };
  }
  const updates = [];
  for (const [relPath, stages] of conflicts.entries()) {
    if (!MECHANICAL_PATHS.has(relPath) && !(regenerate && generated.PATHS.has(relPath)) && !(union && relPath === OPEN_REGISTER_PATH)) {
      throw err('TRAIN-LAND-CONFLICT', `non-mechanical conflict in ${relPath}`);
    }
    const s1 = stages.get('1'), s2 = stages.get('2'), s3 = stages.get('3');
    if (regenerate && generated.PATHS.has(relPath) && relPath !== generated.PINS_PATH && relPath !== generated.CITATIONS_PATH) {
      // Pure projections have no hand-written bytes: add/add and delete/modify
      // are equally rebuildable. Linked/executable outputs still refuse.
      if ([...stages.values()].some(s => s.mode !== '100644')) {
        throw err('TRAIN-LAND-CONFLICT', `mode conflict on generated path ${relPath}`);
      }
      updates.push({ path: relPath, mode: '100644', oid: (s2 || s3).oid });
      continue;
    }
    // All 3 stages must exist as regular non-executable files (100644): any delete/modify, add/add mode mismatch, symlink or submodule refuses!
    if (!s1 || !s2 || !s3 || s1.mode !== '100644' || s2.mode !== '100644' || s3.mode !== '100644') {
      throw err('TRAIN-LAND-CONFLICT', `delete/modify or mode conflict on mechanical path ${relPath}`);
    }
    if (union && [OPEN_REGISTER_PATH, REGISTER_PATH].includes(relPath)) {
      updates.push({ path: relPath, mode: '100644', oid: s2.oid });
      continue;
    }
    let resolvedBuf;
    if (SNAPSHOT_PATHS.has(relPath)) {
      updates.push({ path: relPath, mode: '100644', oid: s2.oid });
      continue;
    }
    const bBuf = git.strict(['cat-file', 'blob', s1.oid], 'TRAIN-LAND-GIT', { buffer: true });
    const oBuf = git.strict(['cat-file', 'blob', s2.oid], 'TRAIN-LAND-GIT', { buffer: true });
    const tBuf = git.strict(['cat-file', 'blob', s3.oid], 'TRAIN-LAND-GIT', { buffer: true });
    if (regenerate && relPath === generated.PINS_PATH) resolvedBuf = generated.mergePins(bBuf, oBuf, tBuf);
    else if (regenerate && relPath === generated.CITATIONS_PATH) resolvedBuf = generated.mergeCitations(bBuf, oBuf, tBuf);
    else if (relPath === MANIFEST_PATH) resolvedBuf = resolveManifest3Way(bBuf, oBuf, tBuf);
    else if (relPath === REGISTER_PATH) resolvedBuf = resolveRegister3Way(bBuf, oBuf, tBuf);
    else throw err('TRAIN-LAND-CONFLICT', `unhandled conflict path ${relPath}`);

    const blobOid = git.strict(['hash-object', '-w', '--stdin'], 'TRAIN-LAND-GIT', { input: resolvedBuf }).trim();
    if (!OBJECT_ID.test(blobOid)) throw err('TRAIN-LAND-GIT', 'invalid blob OID from hash-object');
    updates.push({ path: relPath, mode: '100644', oid: blobOid });
  }

  // Construct exact resolved tree in a temporary Git index file without touching the repository's live index or working tree!
  const gitDir = path.resolve(git.cwd, git.strict(['rev-parse', '--git-dir']).trim());
  const tmpIndex = path.join(gitDir, `train-land-idx-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`);
  try {
    const idxGit = makeGitWithIndex(git, tmpIndex);
    idxGit(['read-tree', treeOid]);
    for (const u of updates) {
      idxGit(['update-index', '--cacheinfo', `${u.mode},${u.oid},${u.path}`]);
    }
    let finalTree = idxGit(['write-tree']).trim();
    if (!OBJECT_ID.test(finalTree)) throw err('TRAIN-LAND-GIT', 'write-tree returned invalid OID');
    let rebuilt = [];
    let notRewritten = [];
    let renumber = null;
    let shadow = null;
    if (regenerate) {
      const result = generated.rebuild(git, finalTree, parentOid, { union: union ? { base: registerBase, tip: tipOid } : null, checkRegister,
        shadow: purpose === 'author-merge' || deferShadow ? null : { tip: tipOid } });
      for (const u of result.updates || []) idxGit(['update-index', '--cacheinfo', `${u.mode},${u.oid},${u.path}`]);
      finalTree = idxGit(['write-tree']).trim();
      rebuilt = result.generated;
      notRewritten = result.notRewritten || [];
      shadow = result.shadow || null;
      const packages = (result.packages || []).filter(p => !p.canonical).map(p => ({ commit: p.commit,
        ids: Object.fromEntries(Object.entries(p.ids).filter(([from, to]) => from !== to)) })).filter(p => Object.keys(p.ids).length);
      if (packages.length) renumber = { version: 1, packages, notRewritten };
    }
    if (validateRegister) validateMergedRegister(git, finalTree);
    return { treeOid: finalTree, conflicts: [...conflicts.keys()].sort(), generated: rebuilt, notRewritten, renumber, shadow };
  } finally {
    try { fs.unlinkSync(tmpIndex); } catch { /* ignore absent temp index */ }
  }
}

function makeGitWithIndex(git, indexFile) {
  return (args, input) => {
    const r = spawnSync('git', ['-c', 'core.hooksPath=disabled-hooks', '-c', 'core.quotePath=false', '-c', 'core.autocrlf=false', ...args], {
      cwd: git.cwd,
      encoding: 'utf8',
      input,
      windowsHide: true,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: { ...git.safeEnv, GIT_INDEX_FILE: indexFile },
    });
    if (r.error || r.status !== 0) {
      throw err('TRAIN-LAND-GIT', String(r.stderr || (r.error && r.error.message) || 'index operation failed').trim().split('\n')[0]);
    }
    return String(r.stdout || '');
  };
}

function attachGitMeta(cwd, env, spawn) {
  const g = makeGit(cwd, env, spawn);
  g.cwd = cwd;
  g.safeEnv = cleanGitEnv(env);
  return g;
}

function assertCandidateLanding(git, head, base) {
  if (!git.cwd) throw err('LANDING_REPOSITORY_INVALID', 'landing requires a bound repository');
  const root = git.strict(['rev-parse', '--show-toplevel']).trim();
  return landingFacts.assertLanding({ root, head,
    tree: git.strict(['rev-parse', '--verify', `${head}^{tree}`]).trim(),
    base, env: git.safeEnv, say: console.log });
}

function resolveCommitOid(git, ref, code = 'TRAIN-LAND-REF') {
  validateRefToken(ref, 'ref');
  const r = git.raw(['rev-parse', '--verify', '--quiet', '--end-of-options', `${ref}^{commit}`]);
  const oid = String(r.stdout || '').trim();
  if (r.error || r.status !== 0 || !SHA.test(oid)) {
    throw err(code, `cannot resolve commit for ${ref}`);
  }
  return oid;
}

function defaultBaseRef(repo, env) {
  try {
    const cfg = load({ root: repo, cwd: repo, env });
    if (cfg && cfg.author && cfg.author.baseRef) return cfg.author.baseRef;
  } catch { /* fallback to manifest */ }
  try {
    const m = JSON.parse(fs.readFileSync(path.join(repo, MANIFEST_PATH), 'utf8'));
    if (typeof m.integrationBranch === 'string' && m.integrationBranch) return `origin/${m.integrationBranch}`;
  } catch { /* fallback */ }
  return 'origin/v2.0.0';
}

function integrationBranchOf(repo) {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(repo, MANIFEST_PATH), 'utf8'));
    if (typeof m.integrationBranch === 'string' && BRANCH_RE.test(m.integrationBranch)) return m.integrationBranch;
  } catch { /* fallback */ }
  return 'v2.0.0';
}

function assertCleanAndNoSequencer(git, repo) {
  const gitDirRaw = git.strict(['rev-parse', '--git-dir'], 'TRAIN-LAND-GIT').trim();
  const gitDir = path.resolve(repo, gitDirRaw);
  for (const marker of SEQUENCER_MARKERS) {
    if (fs.existsSync(path.join(gitDir, marker))) {
      throw err('TRAIN-LAND-SEQUENCER', `unfinished Git operation (${marker} present)`);
    }
  }
  const st = git.strict(['status', '--porcelain=v1', '-z', '--untracked-files=all'], 'TRAIN-LAND-GIT');
  if (st.length > 0) {
    throw err('TRAIN-LAND-DIRTY', 'working tree or index has uncommitted or untracked changes');
  }
}

function computeUniqueMergeBase(git, a, b) {
  const r = git.raw(['merge-base', '--all', a, b]);
  if (r.error || r.status !== 0) throw err('TRAIN-LAND-BASE', 'no common merge-base between base and tip');
  const bases = String(r.stdout || '').trim().split('\n').map(s => s.trim()).filter(Boolean);
  if (bases.length !== 1 || !SHA.test(bases[0])) {
    throw err('TRAIN-LAND-BASE', `expected unique merge-base, found ${bases.length}`);
  }
  return bases[0];
}

function preserveRouteState(repo, git, tree) {
  const file = path.join(repo, 'docs', 'ops', 'route-state.json');
  if (!fs.existsSync(file)) return;
  const incoming = git.strict(['show', `${tree}:docs/ops/route-state.json`], 'TRAIN-LAND-ROUTE-STATE');
  require('../../../tools/operator-knowledge/route-state.cjs').preserveForUpdate(file, incoming);
}

// Git on Windows walks a junction as a plain folder and writes through it, so a link inside the work tree would take a write of the checkout
// outside it. The checkout refuses where a path it creates, changes or deletes, or a folder of such a path, is a symbolic link, a junction or
// another reparse point: Node's lstat reports a junction as a symbolic link, and the real path of every folder must be its own place below the
// real work tree, which also refuses a mount point or another reparse point that redirects. A path the starting HEAD tracks as a symbolic link
// is Git's own entry: the checkout removes or replaces that link itself and never writes through it, and nothing below it is walked.
const FOLD_CASE = process.platform === 'win32' || process.platform === 'darwin';
function linkGuard(top) {
  const realTop = realPath.realPathSync(top);
  const same = (a, b) => (FOLD_CASE ? a.toLowerCase() === b.toLowerCase() : a === b);
  // What sits at a path of the work tree: null when nothing does, else its lstat (device and inode as bigint) and why a write there could leave
  // the work tree (or null).
  const look = at => {
    const abs = path.join(top, ...at.split('/'));
    let st;
    try { st = fs.lstatSync(abs, { bigint: true }); } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
      return { st: null, problem: `it cannot be read (${e.code || 'no code'})` };
    }
    if (st.isSymbolicLink()) return { st, problem: 'it is a symbolic link, a junction or another reparse point' };
    if (!st.isDirectory()) return { st, problem: null };
    let real = null;
    try { real = realPath.realPathSync(abs); } catch { /* a folder whose real path cannot be read is never safe */ }
    return { st, problem: real !== null && same(real, path.join(realTop, ...at.split('/'))) ? null : 'its real path is not its place in the work tree (a mount point or another reparse point)' };
  };
  // The first of the paths or of their folders where a write could leave the work tree, with the reason, or null.
  const first = (files, { own = new Set(), foldersOnly = false } = {}) => {
    const seen = new Set();
    for (const file of files) {
      const parts = file.split('/');
      for (let i = 1; i <= parts.length; i++) {
        const at = parts.slice(0, i).join('/'), folder = i < parts.length;
        if (!folder && foldersOnly) break;
        if (folder && seen.has(at)) continue;
        const found = look(at);
        if (!found || (found.st && found.st.isSymbolicLink() && own.has(at))) break;
        if (found.problem) return { at, problem: found.problem };
        if (!folder || !found.st.isDirectory()) break;
        seen.add(at);
      }
    }
    return null;
  };
  return { look, first };
}
const linkRefusal = (what, found, state) => err('TRAIN-LAND-LINK',
  `the ${what} checkout refuses ${JSON.stringify(found.at)}: ${found.problem}, so a write there could leave the work tree; ${state}`);

// What Git wrote for one path into the private stage folder, read into memory: a file with its mode, a symbolic link, or a folder.
function readStaged(file) {
  const st = fs.lstatSync(file);
  if (st.isSymbolicLink()) return { link: fs.readlinkSync(file, { encoding: 'buffer' }) };
  if (st.isDirectory()) return { dir: true };
  if (!st.isFile()) throw new Error('not a file');
  return { bytes: fs.readFileSync(file), mode: st.mode & 0o777 };
}

// Removes only what this call staged: each staged path and then its folders, deepest first, never through a link. Anything else stays.
function clearStage(stage, files) {
  const folders = new Set();
  for (const file of files) {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) folders.add(parts.slice(0, i).join('/'));
    const at = path.join(stage, ...parts);
    try { if (fs.lstatSync(at).isDirectory()) fs.rmdirSync(at); else fs.unlinkSync(at); } catch { /* not staged */ }
  }
  for (const folder of [...folders].sort((a, b) => b.length - a.length)) {
    try { fs.rmdirSync(path.join(stage, ...folder.split('/'))); } catch { /* absent or not empty */ }
  }
  try { fs.rmdirSync(stage); } catch { /* absent or not empty */ }
}

// The checkout writes the work tree itself; Git writes only the index and the private stage folder. Right before Git updates the index the call
// records every existing folder of every path the checkout changes (device and inode) and what sits at every path it removes; each later step
// proves every folder of its path real (see linkGuard) and still the recorded folder. A file is removed or created only through a handle that
// is proven to be the file at its path: right after the open the handle's device and inode equal those of the path, with every folder proven
// before and after that comparison, and while the handle is open NTFS lets no folder above the file be renamed, so the removal or the write
// reaches that file and no other. A file the call just created whose proof fails is its own new file: the call closes it, removes it through the
// path that reached it while that path still names it (device and inode), and refuses with the path named. After the writes every recorded
// folder and every created entry is proven once more, before HEAD moves.
function checkoutWriter(top, guard, what, code) {
  const full = at => path.join(top, ...at.split('/'));
  const folderOf = file => (file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : '');
  const foldersOf = file => { const parts = file.split('/'); return parts.slice(1).map((_, i) => parts.slice(0, i + 1).join('/')); };
  const stat = at => {
    try { return fs.lstatSync(full(at), { bigint: true }); } catch (e) {
      if (e.code === 'ENOENT' || e.code === 'ENOTDIR') return null;
      throw err(code, `${JSON.stringify(at)} cannot be read (${e.code || 'no code'})`);
    }
  };
  const folders = new Map(), entries = new Map(), placed = new Map();
  // A folder this call removed is no longer recorded, under any spelling of its name, nor is anything below it.
  const forget = gone => {
    const key = at => (FOLD_CASE ? at.toLowerCase() : at), g = key(gone);
    for (const at of [...folders.keys()]) if (key(at) === g || key(at).startsWith(`${g}/`)) folders.delete(at);
  };
  const snapshot = (paths, removed) => {
    for (const file of paths) for (const at of foldersOf(file)) {
      if (folders.has(at)) continue;
      const st = stat(at);
      if (!st || !st.isDirectory()) break;
      folders.set(at, st);
    }
    for (const file of removed) entries.set(file, stat(file));
  };
  // The first folder from the top of the work tree down to `at` (itself included) that is not real or not the recorded folder, or null. A folder
  // that was not there when the checkout began is recorded the first time it is proven real.
  const chainProblem = at => {
    const parts = at ? at.split('/') : [];
    for (let i = 1; i <= parts.length; i++) {
      const sub = parts.slice(0, i).join('/'), found = guard.look(sub);
      if (!found) return { at: sub, problem: 'it is missing' };
      if (found.problem) return { at: sub, problem: found.problem };
      if (!found.st.isDirectory()) return { at: sub, problem: 'it is not a folder' };
      const was = folders.get(sub);
      if (!was) folders.set(sub, found.st);
      else if (was.dev !== found.st.dev || was.ino !== found.st.ino) return { at: sub, problem: 'it is not the folder the checkout recorded before it wrote (another writer replaced it)' };
    }
    return null;
  };
  // Null when `made` (the lstat or the open handle of what the call reached at the path) is what the path names, with every folder proven
  // before and after the path is read; else the first problem.
  const provenAt = (file, made) => {
    const before = chainProblem(folderOf(file));
    if (before) return before;
    const now = stat(file);
    if (!now || now.dev !== made.dev || now.ino !== made.ino) return { at: file, problem: 'it is not the entry this call opened or created there (another writer swapped a folder of it)' };
    return chainProblem(folderOf(file));
  };
  // Removes the entry this call just created, through the path that reached it, only while the path still names it.
  const undoCreate = (file, made) => {
    try {
      const now = stat(file);
      if (!now || now.dev !== made.dev || now.ino !== made.ino) return false;
      if (now.isDirectory()) fs.rmdirSync(full(file)); else fs.unlinkSync(full(file));
      return true;
    } catch { return false; }
  };
  // One path the starting HEAD holds that the landed tree drops or replaces. A file is removed only while the open handle is the file that sat
  // there when the checkout began (same device, inode, size and modification time, so another writer's later edit is never removed) and the file
  // at its path; the removal must take that name from the handle. A symbolic link the starting HEAD tracks and a submodule folder have no handle:
  // the same proof is made with lstat, and a submodule folder is removed only when it is empty, as Git does.
  const remove = file => {
    const was = entries.get(file), now = stat(file);
    if (!was) {
      if (now) throw err(code, `${JSON.stringify(file)} appeared after the checkout began, so it is not removed`);
      return;
    }
    if (!now) return;
    const before = chainProblem(folderOf(file));
    if (before) throw linkRefusal(what, before, `the checkout stopped before removing ${JSON.stringify(file)}`);
    if (!was.isFile()) {
      const problem = provenAt(file, was);
      if (problem) throw linkRefusal(what, problem, `the checkout stopped before removing ${JSON.stringify(file)}`);
      try {
        if (was.isDirectory()) fs.rmdirSync(full(file));
        else try { fs.unlinkSync(full(file)); } catch (e) { if (e.code !== 'EPERM' && e.code !== 'EISDIR') throw e; fs.rmdirSync(full(file)); }
      } catch (e) {
        if (!was.isDirectory()) throw err(code, `${JSON.stringify(file)} could not be removed (${e.code || e.message})`);
      }
      return;
    }
    let fd;
    try { fd = fs.openSync(full(file), 'r'); } catch (e) { throw err(code, `${JSON.stringify(file)} could not be opened for its removal (${e.code || e.message})`); }
    let open = true;
    try {
      const h = fs.fstatSync(fd, { bigint: true });
      const problem = provenAt(file, h);
      if (problem) throw linkRefusal(what, problem, `the checkout stopped before removing ${JSON.stringify(file)}`);
      if (h.dev !== was.dev || h.ino !== was.ino || h.size !== was.size || h.mtimeNs !== was.mtimeNs) {
        throw err(code, `${JSON.stringify(file)} changed after the checkout began (another writer), so it is not removed`);
      }
      try { fs.unlinkSync(full(file)); } catch (e) { throw err(code, `${JSON.stringify(file)} could not be removed (${e.code || e.message})`); }
      const left = fs.fstatSync(fd, { bigint: true }).nlink;
      fs.closeSync(fd);
      open = false;
      // A volume without POSIX delete removes the name when the last handle closes; either way the path must no longer name the file.
      if (left >= h.nlink && stat(file)) throw linkRefusal(what, { at: file, problem: 'its removal did not reach the file this call proved (another writer swapped a folder of it)' }, 'a file outside the work tree may have been removed');
    } finally { if (open) fs.closeSync(fd); }
  };
  // The folders the removals emptied, deepest first, as Git removes them; a folder a placed path needs, or one that is not empty, stays.
  const sweep = (removed, kept) => {
    const needed = new Set(kept.flatMap(foldersOf));
    const emptied = [...new Set(removed.flatMap(foldersOf))].filter(at => !needed.has(at)).sort((a, b) => b.length - a.length);
    for (const at of emptied) {
      if (chainProblem(at)) continue;
      try { fs.rmdirSync(full(at)); forget(at); } catch { /* not empty or in use: it stays, as with Git */ }
    }
  };
  // One path the landed tree holds there: each folder is checked (and created when missing, right after the folders above it are proven) before
  // the next step, then the entry is created exclusively and proven before a byte is written.
  const place = (file, entry) => {
    const parts = file.split('/');
    for (let i = 1; i < parts.length; i++) {
      const at = parts.slice(0, i).join('/');
      const found = guard.look(at);
      if (found && found.problem) throw linkRefusal(what, { at, problem: found.problem }, `the checkout stopped before writing ${JSON.stringify(file)}`);
      if (found) {
        if (!found.st.isDirectory()) throw err(code, `${JSON.stringify(at)} is not a folder, so ${JSON.stringify(file)} cannot be checked out`);
        continue;
      }
      const above = chainProblem(folderOf(at));
      if (above) throw linkRefusal(what, above, `the checkout stopped before writing ${JSON.stringify(file)}`);
      try { fs.mkdirSync(full(at)); } catch (e) { if (e.code !== 'EEXIST') throw err(code, `the folder ${JSON.stringify(at)} could not be created (${e.code || 'no code'})`); }
    }
    const chain = chainProblem(folderOf(file));
    if (chain) throw linkRefusal(what, chain, `the checkout stopped before writing ${JSON.stringify(file)}`);
    const abs = full(file);
    let fd;
    try {
      if (entry.link) fs.symlinkSync(entry.link, abs);
      else if (entry.dir) fs.mkdirSync(abs);
      else fd = fs.openSync(abs, 'wx', entry.mode);
    } catch (e) { throw err(code, `${JSON.stringify(file)} could not be checked out (${e.code === 'EEXIST' ? 'it already exists, no checkout' : e.code || e.message})`); }
    let open = fd !== undefined;
    try {
      const made = open ? fs.fstatSync(fd, { bigint: true }) : stat(file);
      const problem = made ? provenAt(file, made) : { at: file, problem: 'what this call created there cannot be found' };
      if (problem) {
        if (open) { fs.closeSync(fd); open = false; }
        const removed = made ? undoCreate(file, made) : false;
        throw linkRefusal(what, problem, `the checkout stopped at ${JSON.stringify(file)}; ${removed ? 'the entry it had just created there was removed' : 'the entry it had just created could not be found at its path and was left where it is'}`);
      }
      if (open) {
        try { fs.writeFileSync(fd, entry.bytes); } catch (e) { throw err(code, `${JSON.stringify(file)} could not be written (${e.code || e.message})`); }
      }
      placed.set(file, made);
    } finally { if (open) fs.closeSync(fd); }
  };
  // After the writes: every recorded folder that is still there is real and the recorded one, and every created entry is still at its path.
  const after = () => {
    for (const at of folders.keys()) {
      const found = chainProblem(at);
      if (found && found.problem !== 'it is missing') return found;
    }
    for (const [file, made] of placed) {
      const now = stat(file);
      if (!now || now.dev !== made.dev || now.ino !== made.ino) return { at: file, problem: 'it is not the entry this call created there (another writer moved it)' };
    }
    return null;
  };
  return { snapshot, remove, sweep, place, after };
}

// The checkout to the landed tree never lets Git write the work tree: a two-tree read-tree with -u counts a file Git ignores as expendable, so it
// would overwrite one at a path the landed tree adds and delete one in a folder that tree turns into a file, and Git on Windows writes through a
// junction. Before anything is written, every path the landed tree adds is refused while anything outside the index sits at it, under it or at
// one of its folders (an untracked or ignored file, a folder that holds one), and every path the checkout changes is refused while it or one of
// its folders is a link. Git writes every path the landed tree adds or replaces into a private stage folder of the Git directory, through a
// private index, before anything else is written. Then a two-tree read-tree from the starting HEAD to the landed tree
// without -u updates the index alone, and Git refuses where a file it changes or deletes differs from that HEAD; this call removes each file the landed tree drops or replaces, removes the folders that left empty, and creates each path the landed tree adds or
// replaces, never over anything (a file is opened exclusively), so a file another writer puts there after the check is kept and the checkout
// stops; see checkoutWriter for the proofs. A refresh of the index records the stat data, as a checkout by Git would.
function prepareCheckout(git, startOid, treeOid, what, code) {
  const top = path.resolve(git.cwd, git.strict(['rev-parse', '--show-toplevel'], code).trim());
  const rows = git.strict(['diff-tree', '-r', '-z', '--no-renames', startOid, treeOid], code).split('\0');
  const changed = [], added = [], removed = [], placed = [], own = new Set();
  for (let i = 0; i + 1 < rows.length; i += 2) {
    const row = /^:([0-7]{6}) ([0-7]{6}) [0-9a-f]+ [0-9a-f]+ ([A-Z])$/.exec(rows[i]);
    if (!row) throw err(code, `unexpected diff-tree output for the ${what} tree`);
    changed.push(rows[i + 1]);
    if (row[3] === 'A') added.push(rows[i + 1]);
    if (row[1] === '120000') own.add(rows[i + 1]);
    // A submodule that moves to another commit changes the index alone, as with Git.
    if (row[3] === 'M' && row[2] === '160000') continue;
    if (row[3] !== 'A') removed.push(rows[i + 1]);
    if (row[3] !== 'D') placed.push(rows[i + 1]);
  }
  const guard = linkGuard(top);
  const linked = guard.first(changed, { own });
  if (linked) throw linkRefusal(what, linked, 'nothing was written to the index or the work tree');
  // With no exclude rule applied, ls-files --others lists every file outside the index, ignored or not.
  const outside = at => git.strict(['--literal-pathspecs', 'ls-files', '-z', '--others', '--', at], code, { cwd: top }).split('\0').filter(Boolean);
  const held = new Set(), folders = new Set();
  for (const file of added) {
    const parts = file.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const at = parts.slice(0, i).join('/'), folder = i < parts.length;
      if (folder && folders.has(at)) continue;
      let st = null;
      try { st = fs.lstatSync(path.join(top, at)); } catch (e) { if (e.code === 'ENOENT') break; }
      if (folder && st && st.isDirectory()) { folders.add(at); continue; }
      for (const f of outside(at)) held.add(f);
      break;
    }
  }
  if (held.size) {
    const names = [...held].sort();
    throw err('TRAIN-LAND-DIRTY', `the ${what} tree adds paths where the work tree holds files that are not in the index (untracked or ignored): ` +
      `${JSON.stringify(names.slice(0, 10))}${names.length > 10 ? ` and ${names.length - 10} more` : ''}; nothing was written to the index or the work tree`);
  }
  const recheck = () => {
    const now = guard.first(changed, { own });
    if (now) throw linkRefusal(what, now, 'the checkout stopped before its first write');
  };
  const staged = new Map();
  if (placed.length) {
    const list = `${placed.join('\0')}\0`;
    const gitDir = path.resolve(git.cwd, git.strict(['rev-parse', '--git-dir'], code).trim());
    const random = require('node:crypto').randomBytes(12).toString('hex');
    const index = path.join(gitDir, `train-land-idx-${process.pid}-${random}`), stage = path.join(gitDir, `train-land-stage-${random.slice(0, 12)}`);
    let madeStage = false;
    try {
      const idx = makeGitWithIndex({ ...git, cwd: top }, index);
      idx(['read-tree', treeOid]);
      fs.mkdirSync(stage);
      madeStage = true;
      // The stage path is longer than the work tree path by the Git directory, so Git may use the long path form there.
      git.strict(['-c', 'core.longpaths=true', 'checkout-index', '-z', '--stdin', `--prefix=${stage.split(path.sep).join('/')}/`], code, { cwd: top, input: list, env: { GIT_INDEX_FILE: index } });
      for (const file of placed) {
        try { staged.set(file, readStaged(path.join(stage, ...file.split('/')))); } catch (e) { throw err(code, `the staged ${what} path ${JSON.stringify(file)} could not be read (${e.code || e.message})`); }
      }
    } finally {
      try { fs.unlinkSync(index); } catch { /* private temporary index only */ }
      if (madeStage) clearStage(stage, placed);
    }
  }
  const linkedNow = guard.first(changed, { own });
  if (linkedNow) throw linkRefusal(what, linkedNow, 'nothing was written to the index or the work tree');
  return () => {
    recheck();
    const writer = checkoutWriter(top, guard, what, code);
    writer.snapshot(changed, removed);
    git.strict(['read-tree', '-m', startOid, treeOid], code);
    for (const file of removed) writer.remove(file);
    writer.sweep(removed, placed);
    for (const file of placed) writer.place(file, staged.get(file));
    // The files this call created carry no stat data in the index yet; a refresh records it, as a checkout by Git would.
    git.strict(['update-index', '-q', '--refresh'], code, { cwd: top });
    const moved = writer.after();
    if (moved) throw linkRefusal(what, moved, 'it was found after the checkout wrote the work tree, and HEAD was not moved');
  };
}

// A landing that fails after its checkout began never rewrites the checkout to recover. A reset there can overwrite bytes of another writer (a
// tracked, staged, untracked or ignored file, in any folder of the work tree), and no check made before the reset still holds when it runs. So
// HEAD, the index and every work file stay exactly as the failure left them and no commit is made; the refusal states that state and the commands
// an operator runs by hand, once no other writer is active, to bring the index and the work tree back to HEAD. It only reads HEAD to say so.
function leftAsIs(git, startOid, treeOid, what, checkedOut) {
  const now = git.raw(['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
  const head = now.error || now.status !== 0 ? '' : String(now.stdout || '').trim();
  const at = !SHA.test(head) ? `HEAD could not be read (the starting HEAD was ${startOid})`
    : head === startOid ? `HEAD is still the starting HEAD ${startOid}`
      : `HEAD is ${head}: another writer moved it from the starting HEAD ${startOid}`;
  const tree = checkedOut ? `the index and the work tree hold the ${what} tree ${treeOid} this call checked out`
    : `the checkout of the ${what} tree ${treeOid} stopped part way, so the index and the work tree may hold part of it`;
  return `nothing was reset and no commit was made: ${at}; ${tree}, together with any change of another writer. By hand, once no other writer is active: ` +
    `git status --porcelain=v1 --untracked-files=all --ignored, copy aside every file listed there that another writer owns, then git read-tree --reset -u ${SHA.test(head) ? head : startOid}`;
}

function squash(options = {}) {
  try {
    const repo = path.resolve(options.repo || process.cwd());
    const env = options.env || process.env;
    const git = attachGitMeta(repo, env, options.spawn);
    const branch = validateBranchName(options.branch, git);
    const summary = validateSafeText(options.summary, '--summary');
    const stage = options.stage !== undefined && options.stage !== null ? String(options.stage) : undefined;
    if (stage !== undefined && !POSITIVE_INT.test(stage)) {
      throw err('TRAIN-LAND-ARGS', '--stage must be a positive integer');
    }
    const coAuthor = options.coAuthor !== undefined && options.coAuthor !== null ? validateSafeText(options.coAuthor, '--co-author') : undefined;
    if (coAuthor !== undefined && !CO_AUTHOR_RE.test(coAuthor)) {
      throw err('TRAIN-LAND-ARGS', '--co-author must match "Name <email>"');
    }

    assertCleanAndNoSequencer(git, repo);

    const headOid = resolveCommitOid(git, 'HEAD', 'TRAIN-LAND-HEAD');
    const baseRef = options.base || defaultBaseRef(repo, env);
    const baseOid = resolveCommitOid(git, baseRef, 'TRAIN-LAND-BASE');
    if (git.raw(['merge-base', '--is-ancestor', baseOid, headOid]).status !== 0) {
      throw err('TRAIN-LAND-BASE', `base ${baseRef} (${baseOid.slice(0, 8)}) is not an ancestor of HEAD (${headOid.slice(0, 8)})`);
    }

    const branchRef = `refs/heads/${branch}`;
    const tipOid = resolveCommitOid(git, branchRef, 'TRAIN-LAND-BRANCH');
    assertCandidateLanding(git, tipOid, computeUniqueMergeBase(git, baseOid, tipOid));
    const readPlan = () => {
      const r = require('../lib/path-safe.cjs').readFileGuarded(repo, path.resolve(repo, options.registerPlan));
      if (!r.ok || r.bytes.length > registerLanding.MAX_FILE) throw err('REGISTER_PLAN_INVALID', 'plan must be a bounded guarded local file');
      return r.bytes;
    };
    const planBytes = options.registerPlan === undefined ? null : readPlan();
    const plan = planBytes === null ? null : registerLanding.readRegisterPlan(planBytes);
    const recheckPlan = () => {
      if (resolveCommitOid(git, baseRef, 'REGISTER_PLAN_MOVED') !== baseOid) throw err('REGISTER_PLAN_MOVED', 'base ref moved during squash');
      if (plan) {
        if (!planBytes.equals(readPlan())) throw err('REGISTER_PLAN_MOVED', 'plan file moved during execution');
        registerLanding.verifyRegisterPlanPins({ plan, ...registerPlanFromGit(git, plan.parentSha, plan.candidates.map(c => c.branch)) });
      }
    };
    sharedDocs.assertPackage(git.strict, computeUniqueMergeBase(git, baseOid, tipOid), tipOid);
    const execution = plan ? verifyRegisterExecutionPlan(git, plan, headOid, branch) : null;
    if (execution?.replay) {
      recheckPlan();
      if (resolveCommitOid(git, 'HEAD') !== headOid) throw err('REGISTER_PLAN_MOVED', 'HEAD moved during retry');
      return { ok: true, commit: execution.replay, branch, tip: tipOid, replay: true, generated: [], conflicts: [] };
    }
    const candidate = registerPlanFromGit(git, plan?.parentSha || headOid, [branch]).candidates[0];
    if (candidate.launchId && !plan) throw err('REGISTER_PLAN_REQUIRED', 'launch squash requires --register-plan');
    const authority = registerAuthority(git, [registerTree(git, headOid), registerTree(git, tipOid)]);
    if (!plan) {
      const commits = git.strict(['rev-list', '--first-parent', `${baseOid}..${headOid}`]).trim().split('\n').filter(Boolean);
      for (const commit of commits) {
        const message = git.strict(['log', '-1', '--format=%B', commit]), landed = readLanding(message);
        if (landed.form !== 'TRAILER' || landed.reason || landed.tip !== tipOid || landed.branch !== branch) continue;
        const parents = git.strict(['rev-list', '--parents', '-n', '1', commit]).trim().split(' ');
        if (parents.length !== 2) throw err('REGISTER_LANDING_REPLAY', 'existing landing has ambiguous parent');
        const check = verifySingleLandCommit(git, commit, parents[1], { seenBranches: new Set(), allowArchived: false });
        if (!check.ok) throw err(check.code, check.detail);
        authority.recheck();
        if (resolveCommitOid(git, 'HEAD') !== headOid || resolveCommitOid(git, branchRef) !== tipOid) throw err('REGISTER_PLAN_MOVED', 'retry inputs moved');
        return { ok: true, commit, branch, tip: tipOid, replay: true, generated: [], conflicts: [] };
      }
    }
    if (git.raw(['merge-base', '--is-ancestor', tipOid, headOid]).status === 0) {
      throw err('TRAIN-LAND-ALREADY-ANCESTOR', `branch ${branch} (${tipOid.slice(0, 8)}) is already an ancestor of HEAD`);
    }

    // The squash base is the true fork point of the branch against the line head,
    // never the older line base: a branch that merged a stacked train tip squashes
    // against that tip (finding 11.105.3). --base keeps its ancestry and replay roles.
    const mb = computeUniqueMergeBase(git, headOid, tipOid);
    const { treeOid, conflicts, generated: rebuilt = [], notRewritten = [], renumber = null, shadow = null } = computeExpectedSquashTree(git, mb, headOid, tipOid);
    const message = buildSquashMessage({ branch, stage, tip: tipOid, summary, coAuthor, notRewritten, renumber });

    // Re-verify clean state and immobile HEAD/tip right before effect
    assertCleanAndNoSequencer(git, repo);
    if (resolveCommitOid(git, 'HEAD', 'TRAIN-LAND-HEAD') !== headOid || resolveCommitOid(git, branchRef, 'TRAIN-LAND-BRANCH') !== tipOid) {
      throw err('TRAIN-LAND-RACE', 'HEAD or branch tip moved during squash preparation');
    }
    recheckPlan(); authority.recheck();
    assertCandidateLanding(git, tipOid, mb);
    if (resolveCommitOid(git, 'HEAD') !== headOid || resolveCommitOid(git, branchRef) !== tipOid) {
      throw err('TRAIN-LAND-RACE', 'HEAD or candidate moved during landing proof');
    }

    // Create the commit object first and verify it, then check out its tree (see prepareCheckout and leftAsIs) and advance HEAD by compare-and-swap as the last step.
    // A failure after the checkout began resets nothing: HEAD, the index and the work files stay as they are and the refusal says how to go back by hand.
    const sym = git.raw(['symbolic-ref', '-q', 'HEAD']);
    const headTarget = sym.status === 0 ? String(sym.stdout || '').trim() : null;
    let checkingOut = false;
    let changedWorktree = false;
    try {
      const newCommit = git.strict(['commit-tree', treeOid, '-p', headOid, '-m', message], 'TRAIN-LAND-COMMIT').trim();
      if (!SHA.test(newCommit)) throw err('TRAIN-LAND-COMMIT', 'commit-tree did not return a 40-hex SHA');
      const selfCheck = verifyRange(git, baseOid, headOid, newCommit, { allowArchived: false });
      if (!selfCheck.ok) throw err(selfCheck.code, selfCheck.detail);
      const checkout = prepareCheckout(git, headOid, treeOid, 'squash', 'TRAIN-LAND-COMMIT');
      preserveRouteState(repo, git, treeOid);
      checkingOut = true;
      checkout();
      changedWorktree = true;
      if (typeof options.beforeCommit === 'function') options.beforeCommit();
      if (resolveCommitOid(git, 'HEAD', 'TRAIN-LAND-HEAD') !== headOid || resolveCommitOid(git, branchRef, 'TRAIN-LAND-BRANCH') !== tipOid) {
        throw err('TRAIN-LAND-RACE', 'HEAD or branch moved before CAS');
      }
      recheckPlan(); authority.recheck();
      if (headTarget) git.strict(['update-ref', headTarget, newCommit, headOid], 'TRAIN-LAND-COMMIT');
      else git.strict(['update-ref', '--no-deref', 'HEAD', newCommit, headOid], 'TRAIN-LAND-COMMIT');
      return { ok: true, commit: newCommit, branch, tip: tipOid, tree: treeOid, conflicts, generated: rebuilt, shadow };
    } catch (innerErr) {
      if (checkingOut) innerErr.detail = `${innerErr.detail || innerErr.message}; ${leftAsIs(git, headOid, treeOid, 'squash', changedWorktree)}`;
      throw innerErr;
    }
  } catch (e) {
    return failResult(e.code || 'TRAIN-LAND-ERROR', e.detail || e.message);
  }
}

// Author line merges use the same generated-tree calculation as train squashes.
// These are ordinary two-parent commits, never land commits in a squash train.
function merge(options = {}) {
  try {
    const repo = path.resolve(options.repo || process.cwd());
    const git = attachGitMeta(repo, options.env || process.env, options.spawn);
    const ref = validateRefToken(options.ref, '--ref');
    const summary = validateSafeText(options.summary, '--summary');
    assertCleanAndNoSequencer(git, repo);
    const head = resolveCommitOid(git, 'HEAD', 'TRAIN-LAND-HEAD');
    const tip = resolveCommitOid(git, ref);
    if (git.raw(['merge-base', '--is-ancestor', tip, head]).status === 0) {
      throw err('TRAIN-LAND-ALREADY-ANCESTOR', `${ref} is already an ancestor of HEAD`);
    }
    const base = computeUniqueMergeBase(git, head, tip);
    const expected = computeExpectedSquashTree(git, base, head, tip, { purpose: 'author-merge' });
    assertCleanAndNoSequencer(git, repo);
    if (resolveCommitOid(git, 'HEAD') !== head || resolveCommitOid(git, ref) !== tip) {
      throw err('TRAIN-LAND-RACE', 'HEAD or merge ref moved during preparation');
    }
    const commit = git.strict(['commit-tree', expected.treeOid, '-p', head, '-p', tip, '-m', `Merge ${ref}: ${summary}`], 'TRAIN-LAND-COMMIT').trim();
    if (!SHA.test(commit)) throw err('TRAIN-LAND-COMMIT', 'commit-tree did not return a 40-hex SHA');
    const sym = git.raw(['symbolic-ref', '-q', 'HEAD']);
    const target = sym.status === 0 ? String(sym.stdout || '').trim() : null;
    let checkingOut = false;
    let checkedOut = false;
    try {
      const checkout = prepareCheckout(git, head, expected.treeOid, 'merge', 'TRAIN-LAND-COMMIT');
      preserveRouteState(repo, git, expected.treeOid);
      checkingOut = true;
      checkout();
      checkedOut = true;
      if (typeof options.beforeCommit === 'function') options.beforeCommit();
      if (target) git.strict(['update-ref', target, commit, head], 'TRAIN-LAND-COMMIT');
      else git.strict(['update-ref', '--no-deref', 'HEAD', commit, head], 'TRAIN-LAND-COMMIT');
      return { ok: true, commit, tip, tree: expected.treeOid, generated: expected.generated || [], conflicts: expected.conflicts };
    } catch (e) {
      // A failure after the checkout began resets nothing (see leftAsIs).
      if (checkingOut) e.detail = `${e.detail || e.message}; ${leftAsIs(git, head, expected.treeOid, 'merge', checkedOut)}`;
      throw e;
    }
  } catch (e) {
    return failResult(e.code || 'TRAIN-LAND-ERROR', e.detail || e.message);
  }
}

// Staged operator integration: authority is measured here, never supplied by a candidate.
function integration(options = {}) {
  try {
    const repo = path.resolve(options.repo || process.cwd());
    const git = attachGitMeta(repo, options.env || process.env, options.spawn);
    const summary = validateSafeText(options.summary, '--summary');
    if (!isIntegrationSubject(summary)) throw err('TRAIN-LAND-ARGS', 'invalid integration subject');
    const authority = sharedDocs.lockAuthority(git.strict, repo, options.owner, options.env || process.env);
    const headTarget = git.strict(['symbolic-ref', 'HEAD']).trim();
    if (git.strict(['symbolic-ref', '--short', 'HEAD']).trim() !== integrationBranchOf(repo)) {
      throw err('TRAIN-LAND-SHARED-DOC', 'operator integration requires the integration branch');
    }
    const gitDir = path.resolve(repo, git.strict(['rev-parse', '--git-dir']).trim());
    const pending = SEQUENCER_MARKERS.find(item => fs.existsSync(path.join(gitDir, item)));
    if (pending) throw err('TRAIN-LAND-SEQUENCER', `unfinished Git operation (${pending} present)`);
    const head = resolveCommitOid(git, 'HEAD');
    const tree = git.strict(['write-tree']).trim();
    if (tree === git.strict(['rev-parse', 'HEAD^{tree}']).trim()) throw err('TRAIN-LAND-SHARED-DOC', 'integration index is empty');
    const check = () => {
      authority.recheck();
      if (resolveCommitOid(git, 'HEAD') !== head || git.strict(['symbolic-ref', 'HEAD']).trim() !== headTarget || git.strict(['write-tree']).trim() !== tree) {
        throw err('TRAIN-LAND-RACE', 'integration HEAD or index moved');
      }
      if (git.strict(['diff', '--no-ext-diff', '--name-only', '-z']).length ||
          git.strict(['ls-files', '--others', '--exclude-standard', '-z']).length) {
        throw err('TRAIN-LAND-DIRTY', 'integration requires only staged changes');
      }
    };
    check();
    const commit = git.strict(['commit-tree', tree, '-p', head, '-m', summary]).trim();
    if (!SHA.test(commit)) throw err('TRAIN-LAND-COMMIT', 'commit-tree did not return a 40-hex SHA');
    assertRegisterIntegration(git, head, commit);
    sharedDocs.attest(git.strict, authority, commit, head, tree);
    sharedDocs.assertIntegration(git.strict, commit, head);
    if (typeof options.beforeCommit === 'function') options.beforeCommit();
    check();
    git.strict(['update-ref', headTarget, commit, head], 'TRAIN-LAND-COMMIT');
    return { ok: true, commit };
  } catch (e) { return failResult(e.code || 'TRAIN-LAND-ERROR', e.detail || e.message); }
}

// opts: { seenBranches, allowArchived, superseded, withdrawCovered, recompute }.
// recompute=false seals a landing of a closed segment: every structural check
// still runs, only the squash recompute (tree equality, renumber replay) is
// skipped; it ran when the segment was open and at the squash self-check.
function verifySingleLandCommit(git, commitOid, parentOid, opts) {
  const { seenBranches, allowArchived, superseded = false, withdrawCovered = false, recompute = true } = opts;
  const message = git.strict(['log', '-1', '--no-show-signature', '--no-notes', '--format=%B', commitOid], 'TRAIN-LAND-GIT');
  const firstLine = message.split('\n')[0];
  const subjMatch = SQUASH_SUBJECT_RE.exec(firstLine);
  if (!subjMatch) {
    return failResult('TRAIN-LAND-TRAILER', `commit ${commitOid.slice(0, 8)} violates strict squash subject grammar`);
  }
  const [, subjBranch, , subjSha8] = subjMatch;
  const parsed = readLanding(message);
  if (parsed.reason || parsed.form !== 'TRAILER' || !parsed.tip || !SHA.test(parsed.tip)) {
    return failResult('TRAIN-LAND-TRAILER', `commit ${commitOid.slice(0, 8)} missing or invalid Landed-Tip trailer (${parsed.reason || 'LEGACY_FORBIDDEN'})`);
  }
  if (parsed.branch !== subjBranch || parsed.tip.slice(0, 8) !== subjSha8) {
    return failResult('TRAIN-LAND-TRAILER', `commit ${commitOid.slice(0, 8)} subject sha8 (${subjSha8}) disagrees with Landed-Tip (${parsed.tip.slice(0, 8)})`);
  }
  if (seenBranches.has(subjBranch)) {
    return failResult('TRAIN-LAND-DUPLICATE-BRANCH', `branch ${subjBranch} appears more than once in the train`);
  }
  seenBranches.add(subjBranch);

  const tip = parsed.tip;
  // Verify tip object exists as a commit
  const cat = git.raw(['rev-parse', '--verify', '--quiet', '--end-of-options', `${tip}^{commit}`]);
  if (cat.status !== 0 || String(cat.stdout || '').trim() !== tip) {
    return failResult('TRAIN-LAND-UNREACHABLE', `Landed-Tip ${tip} is not a valid commit object`);
  }
  try { assertCandidateLanding(git, tip, computeUniqueMergeBase(git, parentOid, tip)); }
  catch (e) { return failResult(e.code || 'LANDING_FARM_RESULT_INVALID', e.detail || e.message); }

  // Lifecycle contract (Design Review item 5):
  // Default pre-push mode requires live refs/heads/<branch> === tip byte-for-byte.
  // Explicit --allow-archived allows an archived/retired branch iff tip is reachable from refs/heads/ or refs/archive/.
  const liveBranch = git.raw(['rev-parse', '--verify', '--quiet', '--end-of-options', `refs/heads/${subjBranch}^{commit}`]);
  const liveOid = liveBranch.status === 0 ? String(liveBranch.stdout || '').trim() : null;
  if (!allowArchived) {
    if (liveOid !== tip) {
      // A superseded landing accepts its tip as an ancestor of the live branch
      // (legacy re-land) or as withdrawn+still pinned (explicit Train-Withdraw).
      const relaxed = superseded && liveOid !== null && (withdrawCovered || isAncestorOrEqual(git, tip, liveOid));
      if (!relaxed) {
        return failResult('TRAIN-LAND-TIP-MISMATCH', `refs/heads/${subjBranch} is ${liveOid || 'absent'}, expected Landed-Tip ${tip}`);
      }
    }
  } else if (liveOid !== null && liveOid !== tip) {
    const relaxed = superseded && (withdrawCovered || isAncestorOrEqual(git, tip, liveOid));
    if (!relaxed) {
      return failResult('TRAIN-LAND-TIP-MISMATCH', `live refs/heads/${subjBranch} moved to ${liveOid}, expected ${tip}`);
    }
  }

  const pins = String(git.strict(['for-each-ref', `--contains=${tip}`, '--format=%(refname)', 'refs/heads/', 'refs/archive/'], 'TRAIN-LAND-GIT'))
    .trim().split('\n').filter(Boolean);
  if (!pins.length) {
    return failResult('TRAIN-LAND-UNREACHABLE', `Landed-Tip ${tip} is not pinned under refs/heads/ or refs/archive/`);
  }

  // Verify squash diff / tree equality against computeExpectedSquashTree at the
  // true fork point mb(parentOid, tip): a branch that merged a stacked train tip
  // squashes against that tip, never against the older line base (finding 11.105.3).
  const mb = computeUniqueMergeBase(git, parentOid, tip);
  sharedDocs.assertPackage(git.strict, mb, tip);
  if (!recompute) return { ok: true, commit: commitOid, branch: subjBranch, tip, pins, superseded, withdrawCovered };
  let expected;
  try {
    expected = computeExpectedSquashTree(git, mb, parentOid, tip);
  } catch (e) {
    return failResult(e.code === 'TRAIN-LAND-CONFLICT' ? 'TRAIN-LAND-DIFF-MISMATCH' : (e.code || 'TRAIN-LAND-DIFF-MISMATCH'), e.detail || e.message);
  }
  try {
    const recorded = readRenumber(message);
    const historical = recorded === null && expected.renumber && legacyRenumberReceipt(git, parentOid, tip);
    if (!historical && !isDeepStrictEqual(recorded, expected.renumber || null)) {
      return failResult('TRAIN-LAND-RENUMBER', 'Register-Renumber disagrees with the recomputed map');
    }
  } catch (e) { return failResult(e.code, e.detail); }
  const actualTree = git.strict(['rev-parse', `${commitOid}^{tree}`], 'TRAIN-LAND-GIT').trim();
  if (actualTree !== expected.treeOid) {
    const diff = git.strict(['diff-tree', '-r', '--name-only', expected.treeOid, actualTree], 'TRAIN-LAND-GIT').trim();
    return failResult('TRAIN-LAND-DIFF-MISMATCH', `commit ${commitOid.slice(0, 8)} tree differs from squash of ${tip.slice(0, 8)} (${diff.split('\n')[0] || 'tree mismatch'})`);
  }
  return { ok: true, commit: commitOid, branch: subjBranch, tip, pins, superseded, withdrawCovered };
}

function verifyRange(git, trainBaseOid, rangeStartOid, headOid, { allowArchived = false } = {}) {
  if (git.raw(['merge-base', '--is-ancestor', rangeStartOid, headOid]).status !== 0) {
    return failResult('TRAIN-LAND-BASE', `base ${rangeStartOid.slice(0, 8)} is not an ancestor of head ${headOid.slice(0, 8)}`);
  }
  if (rangeStartOid === headOid) {
    return failResult('TRAIN-LAND-EMPTY', 'train range is empty');
  }
  const revOut = git.strict(['rev-list', '--reverse', '--parents', `${rangeStartOid}..${headOid}`], 'TRAIN-LAND-GIT').trim();
  if (!revOut) return failResult('TRAIN-LAND-EMPTY', 'train range contains no commits');

  const lines = revOut.split('\n').filter(Boolean);
  for (const line of lines) {
    const parts = line.trim().split(' ');
    if (parts.slice(1).length !== 1) {
      return failResult('TRAIN-LAND-MERGE', `merge or root commit ${parts[0].slice(0, 8)} is forbidden in squash train`);
    }
  }
  // Pass 1: classify commits and split the range into train segments.
  // A segment is closed by its last integration commit; consecutive integration
  // commits share one segment. The tail after the last integration commit is
  // the open segment and keeps the full squash recompute; every closed segment
  // is sealed by its integration commit (TRAIN-STACK, finding 11.105).
  const commits = [];
  const withdrawals = [];
  {
    let seg = 0, segBase = rangeStartOid, lastInteg = null;
    for (const line of lines) {
      const [commitOid, parentOid] = line.trim().split(' ');
      const message = git.strict(['log', '-1', '--no-show-signature', '--no-notes', '--format=%B', commitOid], 'TRAIN-LAND-GIT');
      const subject = message.split('\n')[0];
      const kind = subject.startsWith('land ') ? 'land'
        : subject === `register bootstrap from ${parentOid}` || /^register consumers (?:active|shadow) from [a-f0-9]{40}$/.test(subject) ? 'bootstrap'
        : isIntegrationSubject(subject) ? 'integration' : 'other';
      if (kind !== 'integration' && lastInteg !== null) { segBase = lastInteg; lastInteg = null; seg++; }
      if (kind === 'integration') {
        let tt;
        try { tt = parseTrainTrailers(message); } catch (e) { return failResult(e.code, e.detail || e.message); }
        if (tt.base !== null && tt.base !== segBase) {
          return failResult('TRAIN-LAND-TRAIN-BASE', `integration commit ${commitOid.slice(0, 8)} declares Train-Base ${tt.base.slice(0, 8)}, the segment base is ${segBase.slice(0, 8)}`);
        }
        for (const w of tt.withdraws) withdrawals.push({ ...w, order: commits.length });
        lastInteg = commitOid;
      }
      commits.push({ oid: commitOid, parent: parentOid, subject, message, kind, seg });
    }
  }
  const openSeg = commits.length && commits[commits.length - 1].kind !== 'integration' ? commits[commits.length - 1].seg : -1;

  // Pass 2: withdrawal trailers must name a real earlier landing, and a re-land
  // of a branch in a later segment is legal only per withdrawn earlier landing
  // or per tip ancestry (legacy supersession); otherwise it stays a duplicate.
  const landMeta = new Map();
  {
    const ordered = [];
    commits.forEach((c, order) => {
      if (c.kind !== 'land') return;
      const parsed = readLanding(c.message);
      if (parsed.reason || parsed.form !== 'TRAILER' || !parsed.tip || !SHA.test(parsed.tip)) return;
      ordered.push({ oid: c.oid, seg: c.seg, order, branch: parsed.branch, tip: parsed.tip });
    });
    for (const w of withdrawals) {
      if (!ordered.some(l => l.branch === w.branch && l.tip === w.tip && l.order < w.order)) {
        return failResult('TRAIN-LAND-TRAIN-TRAILER', `Train-Withdraw ${w.branch} ${w.tip.slice(0, 8)} names no earlier landing of the range`);
      }
    }
    const byBranch = new Map();
    for (const l of ordered) {
      const list = byBranch.get(l.branch) || [];
      if (list.length) {
        const prev = list[list.length - 1];
        if (prev.seg !== l.seg) {
          const covered = withdrawals.some(w => w.branch === prev.branch && w.tip === prev.tip && prev.order < w.order && w.order < l.order);
          if (!covered && !isAncestorOrEqual(git, prev.tip, l.tip)) {
            return failResult('TRAIN-LAND-DUPLICATE-BRANCH', `branch ${l.branch} lands again in a later segment without a Train-Withdraw or tip ancestry`);
          }
          landMeta.set(prev.oid, { superseded: true, withdrawCovered: covered });
        }
      }
      list.push(l);
      byBranch.set(l.branch, list);
    }
    // A landing named by a Train-Withdraw is superseded even when the branch
    // never re-lands in the range: its tip needs pins, not live equality.
    for (const w of withdrawals) {
      for (const l of ordered) {
        if (l.branch === w.branch && l.tip === w.tip && l.order < w.order) {
          landMeta.set(l.oid, { superseded: true, withdrawCovered: true });
        }
      }
    }
  }

  const landings = [];
  let bootstrapCount = 0;
  let seenBranches = new Set();
  let seenSeg = -1;
  for (const c of commits) {
    if (c.kind === 'land') {
      if (c.seg !== seenSeg) { seenBranches = new Set(); seenSeg = c.seg; }
      const meta = landMeta.get(c.oid) || {};
      const check = verifySingleLandCommit(git, c.oid, c.parent, {
        seenBranches, allowArchived,
        superseded: Boolean(meta.superseded), withdrawCovered: Boolean(meta.withdrawCovered),
        recompute: c.seg === openSeg,
      });
      if (!check.ok) return check;
      landings.push({ commit: check.commit, branch: check.branch, tip: check.tip, superseded: check.superseded, withdrawCovered: check.withdrawCovered });
    } else if (c.kind === 'bootstrap') {
      try {
        const authority = registerAuthority(git, [registerTree(git, c.parent)]);
        registerContext(git, c.oid, authority); authority.recheck(); bootstrapCount++;
      } catch (e) { return failResult(e.code || 'REGISTER_BOOTSTRAP_INVALID', e.detail || e.message); }
    } else if (c.kind === 'integration') {
      if (/(?:landed-tip|register-renumber)\s*:/i.test(c.message)) {
        return failResult('TRAIN-LAND-INTEGRATION-TRAILER', `integration commit ${c.oid.slice(0, 8)} must not carry landing trailers`);
      }
      try { assertRegisterIntegration(git, c.parent, c.oid); }
      catch (e) { return failResult(e.code, e.detail); }
      try { sharedDocs.assertIntegration(git.strict, c.oid, c.parent); }
      catch (e) { return failResult(e.code, e.detail); }
    } else {
      // A revert is no train commit: it lands as a package branch (revert on a branch, then squash it), and a landing it replaces is
      // named by a Train-Withdraw trailer in the segment that re-lands the branch.
      const revert = /^revert\b/i.test(c.subject) ? '; a revert is landed as a package branch: commit it on a branch and land that branch with train-land squash (a landing it replaces is withdrawn with a Train-Withdraw trailer)' : '';
      return failResult('TRAIN-LAND-SUBJECT', `unexpected commit subject in train (${c.oid.slice(0, 8)}): ${c.subject.slice(0, 80)}${revert}`);
    }
  }
  if (!landings.length && !bootstrapCount) {
    return failResult('TRAIN-LAND-EMPTY', 'train range contains no land commits');
  }
  return { ok: true, base: trainBaseOid, head: headOid, landings };
}

function verify(options = {}) {
  try {
    const repo = path.resolve(options.repo || process.cwd());
    const env = options.env || process.env;
    const git = attachGitMeta(repo, env, options.spawn);
    const baseRef = options.base || defaultBaseRef(repo, env);
    const headRef = options.head || 'HEAD';
    const baseOid = resolveCommitOid(git, baseRef, 'TRAIN-LAND-BASE');
    const headOid = resolveCommitOid(git, headRef, 'TRAIN-LAND-HEAD');
    return verifyRange(git, baseOid, baseOid, headOid, { allowArchived: Boolean(options.allowArchived) });
  } catch (e) {
    return failResult(e.code || 'TRAIN-LAND-ERROR', e.detail || e.message);
  }
}

function push(options = {}) {
  try {
    const repo = path.resolve(options.repo || process.cwd());
    const env = options.env || process.env;
    const remote = options.remote;
    if (typeof remote !== 'string' || !REMOTE_RE.test(remote)) {
      throw err('TRAIN-LAND-ARGS', 'push requires a valid --remote name');
    }
    if (options.base !== undefined) {
      throw err('TRAIN-LAND-ARGS', 'push does not accept --base; base is bound to refs/remotes/<remote>/<integrationBranch>');
    }
    const git = attachGitMeta(repo, env, options.spawn);
    const integrationBranch = integrationBranchOf(repo);
    const trackingRef = `refs/remotes/${remote}/${integrationBranch}`;
    const baseOid = resolveCommitOid(git, trackingRef, 'TRAIN-LAND-REMOTE');
    const headRef = options.head || 'HEAD';
    const headOid = resolveCommitOid(git, headRef, 'TRAIN-LAND-HEAD');

    const check = verifyRange(git, baseOid, baseOid, headOid, { allowArchived: false });
    if (!check.ok) return check;

    if (typeof options.beforePush === 'function') options.beforePush();

    // Re-read every Landed-Tip after beforePush. Reference checks follow the
    // potentially long farm read, so its duration does not widen their race.
    for (const l of check.landings) assertCandidateLanding(git, l.tip, computeUniqueMergeBase(git, baseOid, l.tip));

    // Re-verify immobile refs right before effect (remote tracking ref, head if symbolic, and every landed branch tip)
    if (resolveCommitOid(git, trackingRef, 'TRAIN-LAND-REMOTE') !== baseOid) {
      return failResult('TRAIN-LAND-RACE', `${trackingRef} moved before push`);
    }
    if (resolveCommitOid(git, headRef, 'TRAIN-LAND-HEAD') !== headOid) {
      return failResult('TRAIN-LAND-RACE', `${headRef} moved before push`);
    }
    for (const l of check.landings) {
      const liveNow = resolveCommitOid(git, `refs/heads/${l.branch}`, 'TRAIN-LAND-RACE');
      if (liveNow === l.tip) continue;
      // A superseded landing keeps its verify-time relaxation: the recorded tip
      // stays valid as an ancestor of the live branch or as withdrawn and pinned.
      if (l.superseded && (l.withdrawCovered || isAncestorOrEqual(git, l.tip, liveNow))) continue;
      return failResult('TRAIN-LAND-RACE', `refs/heads/${l.branch} moved from ${l.tip.slice(0, 8)} to ${liveNow.slice(0, 8)} before push`);
    }

    const pushArgs = [
      'push',
      `--force-with-lease=refs/heads/${integrationBranch}:${baseOid}`,
      '--',
      remote,
      `${headOid}:refs/heads/${integrationBranch}`,
    ];
    const res = options.spawnPush ? options.spawnPush(pushArgs) : git.raw(pushArgs);
    if (!res || res.error || res.status !== 0) {
      return failResult('TRAIN-LAND-PUSH', String((res && res.stderr) || (res && res.error && res.error.message) || 'git push failed').trim().split('\n')[0]);
    }
    return { ok: true, remote, integrationBranch, base: baseOid, head: headOid, landings: check.landings };
  } catch (e) {
    return failResult(e.code || 'TRAIN-LAND-ERROR', e.detail || e.message);
  }
}

// The suite verdict of a train head: any failed test stops the train, except a failure covered by an active row of the
// flaky-test quarantine, which is counted and listed. Every run summary of the head (shards and reruns) is read; a summary
// that exited nonzero is red; each covered failure is judged again against the change of the whole train (base...head),
// today, and every host of the given summaries (a test that failed on every host that ran it is never covered).
const MAX_SUMMARY_BYTES = 16 * 1024 * 1024;
function suite({ repo, summaries, base, head }) {
  const root = path.resolve(repo);
  const resolvedBase = quarantine.baseRef(root, [base]);
  const changed = quarantine.changedFiles(root, resolvedBase, head || 'HEAD');
  const read = file => {
    try {
      const st = fs.lstatSync(file);
      if (!st.isFile() || st.size > MAX_SUMMARY_BYTES) return { name: file, data: null };
      return { name: file, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch { return { name: file, data: null }; }
  };
  const verdict = quarantine.suiteVerdict({ summaries: summaries.map(read), register: quarantine.read(root), nowMs: Date.now(), changed });
  return { ...verdict, base: resolvedBase, changedKnown: changed instanceof Set };
}

function run(argv, deps = {}) {
  const parsed = parseArgs(argv);
  const common = { repo: parsed.repo || deps.cwd || process.cwd(), env: deps.env || process.env, spawn: deps.spawn };
  if (parsed.cmd === 'docs-check') return docsCheck({ ...common, ...parsed });
  if (parsed.cmd === 'integration') return integration({ ...common, summary: parsed.summary, owner: parsed.owner });
  if (parsed.cmd === 'register-plan') return registerPlan({ ...common, base: parsed.base, candidates: parsed.candidates });
  if (parsed.cmd === 'register-bootstrap') return registerBootstrap({ ...common, parent: parsed.parent, toolTip: parsed.toolTip, approval: parsed.approval });
  if (parsed.cmd === 'register-readiness') return registerReadiness({ ...common, head: parsed.head });
  if (parsed.cmd === 'suite') return suite({ ...common, summaries: parsed.summaries, base: parsed.base, head: parsed.head });
  if (parsed.cmd === 'merge') return merge({ ...common, ref: parsed.ref, summary: parsed.summary });
  if (parsed.cmd === 'squash') {
    return squash({ ...common, branch: parsed.branch, summary: parsed.summary, stage: parsed.stage, coAuthor: parsed.coAuthor, base: parsed.base, registerPlan: parsed.registerPlan });
  }
  if (parsed.cmd === 'verify') {
    return verify({ ...common, base: parsed.base, head: parsed.head, allowArchived: parsed.allowArchived });
  }
  return push({ ...common, remote: parsed.remote, head: parsed.head, spawnPush: deps.spawnPush });
}

function main(argv, deps = {}) {
  const out = deps.quiet ? () => {} : s => process.stdout.write(`${s}\n`);
  const errOut = deps.quiet ? () => {} : s => process.stderr.write(`${s}\n`);
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    errOut(`${e.code || 'TRAIN-LAND-ARGS'}: ${e.detail || e.message}`);
    return 2;
  }
  const common = { repo: parsed.repo || deps.cwd || process.cwd(), env: deps.env || process.env, spawn: deps.spawn };
  if (parsed.cmd === 'docs-check') {
    const result = docsCheck({ ...common, ...parsed });
    out(`${result.verdict} tested-head=${result.testedHead} head=${result.head}`);
    if (result.reason) out(result.reason);
    for (const name of result.paths || []) out(name);
    if (result.landingRecord) out(JSON.stringify(result.landingRecord));
    return result.verdict === 'DOCS-ONLY' ? 0 : 1;
  }
  if (parsed.cmd === 'integration') {
    const result = integration({ ...common, summary: parsed.summary, owner: parsed.owner });
    if (!result.ok) { errOut(`TRAIN-LAND REFUSED ${result.code}: ${result.detail}`); return 1; }
    out(`TRAIN-LAND INTEGRATION commit=${result.commit}`); return 0;
  }
  if (parsed.cmd === 'suite') {
    const result = suite({ ...common, summaries: parsed.summaries, base: parsed.base, head: parsed.head });
    out(`TRAIN-SUITE base=${result.base || 'unknown'} changed=${result.changedKnown ? 'known' : 'unknown'}`);
    for (const line of result.lines) out(line);
    return result.ok ? 0 : 1;
  }
  if (parsed.cmd === 'register-readiness') {
    const result = registerReadiness({ ...common, head: parsed.head });
    if (!result.ok) { errOut(`TRAIN-LAND REFUSED ${result.code}: ${result.detail}`); return 1; }
    out(JSON.stringify(result)); return 0;
  }
  if (parsed.cmd === 'register-plan') {
    const result = registerPlan({ ...common, base: parsed.base, candidates: parsed.candidates });
    if (!result.ok) { errOut(`TRAIN-LAND REFUSED ${result.code}: ${result.detail}`); return result.code === 'TRAIN-LAND-ARGS' ? 2 : 1; }
    out(JSON.stringify(result.plan)); return 0;
  }
  const result = parsed.cmd === 'merge'
    ? merge({ ...common, ref: parsed.ref, summary: parsed.summary })
    : parsed.cmd === 'register-bootstrap'
    ? registerBootstrap({ ...common, parent: parsed.parent, toolTip: parsed.toolTip, approval: parsed.approval })
    : parsed.cmd === 'squash'
    ? squash({ ...common, branch: parsed.branch, summary: parsed.summary, stage: parsed.stage, coAuthor: parsed.coAuthor, base: parsed.base, registerPlan: parsed.registerPlan })
    : parsed.cmd === 'verify'
      ? verify({ ...common, base: parsed.base, head: parsed.head, allowArchived: parsed.allowArchived })
      : push({ ...common, remote: parsed.remote, head: parsed.head, spawnPush: deps.spawnPush });

  if (!result.ok) {
    errOut(`TRAIN-LAND REFUSED ${result.code}: ${result.detail}`);
    return result.code === 'TRAIN-LAND-ARGS' ? 2 : 1;
  }
  if (parsed.cmd === 'register-bootstrap') {
    out(`TRAIN-LAND BOOTSTRAP commit=${result.commit} replay=${Boolean(result.replay)}`);
  } else if (parsed.cmd === 'merge') {
    out(`TRAIN-LAND MERGE commit=${result.commit} tip=${result.tip} rebuilt=${result.generated.join(',')}`);
  } else if (parsed.cmd === 'squash') {
    if (result.shadow?.warning) out(`TRAIN-LAND WARN ${result.shadow.warning} divergence=${result.shadow.divergence}`);
    out(`TRAIN-LAND SQUASH commit=${result.commit} branch=${result.branch} tip=${result.tip} rebuilt=${result.generated.join(',')}`);
  } else if (parsed.cmd === 'verify') {
    out(`TRAIN-LAND VERIFY OK base=${result.base.slice(0, 8)} head=${result.head.slice(0, 8)} landings=${result.landings.length}`);
  } else {
    out(`TRAIN-LAND PUSH OK remote=${result.remote} branch=${result.integrationBranch} head=${result.head}`);
    // The plan of the cleanup after the landing, dry: one line, never a refusal of the landing (the exit code does not depend on it).
    let planLine = null;
    try { planLine = require(POST_LANDING_SWEEP_MODULE).dryLine({ repo: common.repo, env: common.env, spawn: deps.spawn }); } catch { /* no sweep module in this copy: no line */ }
    if (planLine) out(planLine);
  }
  return 0;
}

// Reuse the owning-generator inventory so the projection retains its exact label.
function registerLabels() {
  const table = generated.OUTPUTS.find(row => row.path === registerFragments.COMPILED[2]);
  if (!table || !Array.isArray(table.args)) throw err('REGISTER_INPUT', 'register table generator unavailable');
  return { registerPath: OPEN_REGISTER_PATH, command: ['node', table.tool, ...table.args].join(' ') };
}

// Owner identities are project data, pinned to the approved bootstrap parent.
// A mutable working copy or a candidate branch cannot supply approval authority.
function registerBootstrapOwners(tree) {
  try {
    const entry = tree.get('.ai/docs/owners.json');
    if (!entry || entry.mode !== '100644') throw Error('missing regular owner list');
    const data = registerLanding.json(registerFragments.bytesOf(entry), 65536);
    registerFragments.keys(data, ['owners']);
    if (!Array.isArray(data.owners) || !data.owners.length) throw Error('empty owner list');
    data.owners.forEach(name => registerFragments.scalar(name));
    return new Set(data.owners);
  } catch {
    throw err('REGISTER_BOOTSTRAP_AUTHORITY', 'approved parent must contain a valid closed owner list');
  }
}

function docsCheck(options) {
  try {
    const repo = path.resolve(options.repo || process.cwd());
    const git = makeGit(repo, options.env || process.env, options.spawn);
    const results = options.results || path.join(load({ root: repo, cwd: repo, env: options.env }).workRoot, 'farm', 'results');
    return require('./lib/train-docs.cjs').check({ git, testedHead: options.testedHead, head: options.head, results, gatesLog: options.gatesLog });
  } catch (e) {
    return { ok: false, verdict: 'FULL-RUN', testedHead: options.testedHead, head: options.head, reason: e.code || e.message };
  }
}

module.exports = {
  docsCheck,
  integration,
  registerLabels,
  registerBootstrapOwners,
  parseArgs,
  buildSquashMessage,
  resolveManifest3Way,
  resolveRegister3Way,
  computeExpectedSquashTree,
  registerPlanFromGit,
  registerPlan,
  registerBootstrap,
  registerReadiness,
  registerConsumerMode,
  consumerActivationReady,
  checkConsumerOpenPackages,
  readRegisterSnapshot,
  readRegisterPackageSnapshot,
  registerTree,
  registerAuthority,
  verifyRegisterExecutionPlan,
  assertRegisterIntegration,
  registerContext,
  registerCandidate,
  validateTrainLaunch,
  squash,
  merge,
  verify,
  push,
  suite,
  run,
  main,
};

if (require.main === module) process.exitCode = main(process.argv.slice(2));

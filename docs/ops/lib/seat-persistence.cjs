'use strict';
// Author-seat persistence. Git plumbing never checks out, resets or stashes work.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const hooks = require('../../../.ai/bin/protocol-hooks.cjs');
const entryText = require('../../../.ai/bin/lib/entry-text.cjs');
const { anchor } = require('../../../.ai/bin/protocol-handoff/snapshot.cjs');
const { checkOwnerReceipt } = require('../../../.ai/bin/protocol-handoff/chain.cjs');
const { secretIn } = require('../../../.ai/bin/lib/secrets.cjs');
const { readFileGuarded } = require('../../../.ai/bin/lib/path-safe.cjs');
const { hasProtectedName } = require('../../../.ai/bin/lib/protected-paths.cjs');
// The one journal lock of every kernel journal writer: the commit reads, checks and commits the journal while it holds it.
const journalTool = require('../../../.ai/bin/protocol-journal.cjs');
const JOURNAL = /^\.ai\/worklog\/([a-z0-9][a-z0-9-]{1,80})\.md$/;
const CRASH = new Set(['TRANSPORT', 'TRANSPORT_EXHAUSTED', 'PROXY_DROP', 'INTERRUPTED']);
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
function refused(state) { throw Object.assign(new Error(state), { state }); }
function git(root, args, options = {}, accepted = [0]) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (/^GIT_(?:DIR|WORK_TREE|COMMON_DIR|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/i.test(key)) delete env[key];
  const r = spawnSync('git', ['--literal-pathspecs', '-C', root, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 30000, maxBuffer: 16 * 1024 * 1024,
    ...options, env: { ...env, GIT_TERMINAL_PROMPT: '0', ...(options.env || {}) },
  });
  if (r.error || !accepted.includes(r.status)) refused('GIT_FAILED');
  return r.stdout;
}
function readJournal(root, rel) {
  const r = readFileGuarded(root, path.join(root, rel), { maxBytes: 200 * 1024 });
  if (!r.ok) refused('JOURNAL_PATH_REFUSED');
  return r.bytes;
}
function dirtyJournals(root) {
  // ls-files -z is unambiguous even for whitespace, quotes and newlines.
  const names = git(root, ['ls-files', '-z', '--modified', '--others', '--exclude-standard', '--', '.ai/worklog']);
  const staged = git(root, ['diff', '--cached', '--name-only', '-z', '--', '.ai/worklog']);
  return [...new Set((names + staged).split('\0').filter(p => JOURNAL.test(p) && !p.endsWith('/README.md')))];
}
function head(root) {
  const branch = git(root, ['symbolic-ref', '-q', 'HEAD']).trim();
  if (!branch.startsWith('refs/heads/')) refused('BRANCH_REFUSED');
  // An unborn branch is a valid baseline; only persistence writes need a commit.
  return { branch, head: git(root, ['rev-parse', '--verify', '--quiet', 'HEAD'], {}, [0, 1]).trim() || null };
}
function capture(root) {
  try {
    root = fs.realpathSync(root);
    if (hasProtectedName(root, { mode: 'word' })) refused('WORKTREE_REFUSED');
    if (fs.realpathSync(git(root, ['rev-parse', '--show-toplevel']).trim()) !== root) refused('WORKTREE_REFUSED');
    const journals = {};
    for (const rel of dirtyJournals(root)) journals[rel] = hash(readJournal(root, rel));
    return { root, ...head(root), journals };
  } catch (e) { return { error: e.state || 'CAPTURE_FAILED' }; }
}
function sameBranch(root, before) {
  const current = head(root);
  if (current.branch !== before.branch) refused('BRANCH_CHANGED');
  if (before.head) {
    if (!current.head) refused('HEAD_CHANGED');
    git(root, ['merge-base', '--is-ancestor', before.head, current.head]);
  }
  return current;
}
function indexPath(root) { return path.resolve(root, git(root, ['rev-parse', '--git-path', 'index']).trim()); }
function tempIndex(root, fn) {
  // Kept beside the per-worktree index, never in the product tree or another worktree.
  const file = `${indexPath(root)}.seat-${crypto.randomUUID()}`;
  try { return fn({ GIT_INDEX_FILE: file }); }
  finally { try { fs.unlinkSync(file); } catch { /* absent or retained for diagnosis */ } }
}
function safeTree(root, tree, base) {
  const names = git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', base, tree]).split('\0').filter(Boolean);
  for (const name of names) {
    const row = git(root, ['ls-tree', '-z', tree, '--', name]);
    if (!row) continue; // deletion: no new bytes enter the object database
    const m = /^(\d+) (\w+) ([a-f0-9]+)\t/.exec(row);
    if (!m || m[2] !== 'blob') refused('CHECKPOINT_SPECIAL_FILE');
    const content = git(root, ['cat-file', 'blob', m[3]]);
    if (secretIn(name) || secretIn(content) || hooks.findSecretLeak(content)) refused('SECRET_REFUSED');
  }
}
function checkpoint(root, seat, before, current) {
  if (!current.head) refused('HEAD_UNBORN');
  const index = indexPath(root);
  // An active Git writer or unresolved merge cannot be captured faithfully.
  let fd;
  try { fd = fs.openSync(`${index}.lock`, 'wx'); } catch { refused('INDEX_BUSY'); }
  try {
    const staged = tempIndex(root, env => {
      fs.copyFileSync(index, env.GIT_INDEX_FILE);
      return git(root, ['write-tree'], { env }).trim();
    });
    const tree = tempIndex(root, env => {
      git(root, ['read-tree', current.head], { env });
      git(root, ['add', '-A', '--', '.'], { env });
      return git(root, ['write-tree'], { env }).trim();
    });
    if (tree === git(root, ['rev-parse', `${current.head}^{tree}`]).trim() && staged === tree) return { state: 'CHECKPOINT_CLEAN' };
    safeTree(root, staged, current.head);
    safeTree(root, tree, current.head);
    sameBranch(root, before);
    if (head(root).head !== current.head) refused('HEAD_CHANGED');
    const indexCommit = git(root, ['commit-tree', staged, '-p', current.head], { input: `checkpoint: seat ${seat} index\n` }).trim();
    const commit = git(root, ['commit-tree', tree, '-p', indexCommit], { input: `checkpoint: seat ${seat} client crash\n` }).trim();
    // A unique branch is an archival checkpoint, never a replacement for the author branch.
    const ref = `refs/heads/seat-checkpoints/${seat}/${crypto.randomUUID()}`;
    git(root, ['update-ref', ref, commit, '0'.repeat(current.head.length)]);
    return { state: 'CHECKPOINT_SAVED', ref, commit, indexCommit };
  } finally { fs.closeSync(fd); fs.unlinkSync(`${index}.lock`); }
}
function commitJournal(root, seat, rel, before) {
  try {
    return journalTool.withJournalLock(root, path.join(root, rel), () => commitJournalLocked(root, seat, rel, before));
  } catch (e) {
    if (e.message === journalTool.BUSY) refused('JOURNAL_BUSY');
    throw e;
  }
}
function commitJournalLocked(root, seat, rel, before) {
  const original = readJournal(root, rel);
  // The newest entry by the one entry text model, the entry the receipt check below reads: a dated heading quoted in a
  // fence or an HTML comment is entry text, never the entry.
  const section = entryText.datedSections(original.toString('utf8'))[0];
  if (!section || !hooks.latestCompleteEntry(section)) refused('JOURNAL_INCOMPLETE');
  if (secretIn(original.toString('utf8')) || hooks.findSecretLeak(original.toString('utf8'))) refused('SECRET_REFUSED');
  const current = sameBranch(root, before);
  if (!current.head) refused('HEAD_UNBORN');
  const state = anchor(root);
  const receipt = checkOwnerReceipt(root, JOURNAL.exec(rel)[1], { journalPath: path.join(root, rel), state });
  if (!receipt.ok || receipt.evidence.digest !== state.digest) refused('JOURNAL_EVIDENCE_INVALID');
  const owner = JOURNAL.exec(rel)[1];
  if (!new RegExp(`^- recorded: \\S+ by ${owner}$`, 'm').test(receipt.evidence.body)) refused('JOURNAL_OWNER_INVALID');
  const index = indexPath(root);
  let fd;
  try { fd = fs.openSync(`${index}.lock`, 'wx'); } catch { refused('INDEX_BUSY'); }
  let published = false;
  try {
    // Preserve every unrelated staged entry, including a partial staging.
    fs.writeFileSync(fd, fs.readFileSync(index));
    const stagedChanges = git(root, ['diff', '--cached', '--name-only', '--', rel]).trim();
    if (stagedChanges && git(root, ['diff', '--name-only', '--', rel]).trim()) refused('JOURNAL_INDEX_DIVERGED');
    const result = tempIndex(root, env => {
      git(root, ['read-tree', current.head], { env });
      git(root, ['add', '--', rel], { env });
      const tree = git(root, ['write-tree'], { env }).trim();
      const changed = git(root, ['diff-tree', '--no-commit-id', '--name-only', '-r', '-z', current.head, tree]).split('\0').filter(Boolean);
      if (changed.length !== 1 || changed[0] !== rel) refused('JOURNAL_SCOPE_REFUSED');
      const entry = /^(\d+) blob ([a-f0-9]+)\t/.exec(git(root, ['ls-tree', tree, '--', rel]));
      if (!entry) refused('JOURNAL_SCOPE_REFUSED');
      git(root, ['update-index', '--add', '--cacheinfo', `${entry[1]},${entry[2]},${rel}`], { env: { GIT_INDEX_FILE: `${index}.lock` } });
      if (!readJournal(root, rel).equals(original) || anchor(root).digest !== state.digest) refused('TREE_CHANGED');
      sameBranch(root, before);
      const commit = git(root, ['commit-tree', tree, '-p', current.head], { input: `journal: seat ${seat} verified handoff\n` }).trim();
      git(root, ['update-ref', current.branch, commit, current.head]);
      published = true;
      return { state: 'JOURNAL_COMMITTED', journal: rel, commit };
    });
    fs.closeSync(fd); fd = null;
    fs.renameSync(`${index}.lock`, index);
    return result;
  } catch (e) {
    if (published) refused('JOURNAL_INDEX_RECONCILE_REQUIRED');
    throw e;
  } finally {
    if (fd !== null) fs.closeSync(fd);
    // Keep the recovery index after publication if reconciliation failed.
    if (!published) { try { fs.unlinkSync(`${index}.lock`); } catch { /* retained lock */ } }
  }
}
function settle({ worktree, name, launchRole, seatPersistenceBefore }, result) {
  if (launchRole !== 'author') return { state: 'NOT_AUTHOR' };
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(name || '')) return { state: 'SEAT_NAME_REFUSED', blocked: true };
  if (!seatPersistenceBefore || seatPersistenceBefore.error) return { state: 'BASELINE_UNAVAILABLE', blocked: true };
  if (result.failureClass === 'ORPHAN') return { state: 'CHILD_UNSETTLED', blocked: true };
  const before = seatPersistenceBefore;
  let saved = null;
  try {
    const root = fs.realpathSync(worktree);
    if (root !== before.root || hasProtectedName(root, { mode: 'word' })) refused('WORKTREE_REFUSED');
    const current = sameBranch(root, before);
    if (CRASH.has(result.failureClass) || /EPIPE|broken pipe|class=PROCESS_CRASH/i.test(result.reason || '')) saved = checkpoint(root, name, before, current);
    const candidates = dirtyJournals(root).filter(rel => hash(readJournal(root, rel)) !== before.journals[rel]);
    if (candidates.length > 1) refused('JOURNAL_AMBIGUOUS');
    if (!candidates.length) return { state: saved ? saved.state : 'NO_JOURNAL_CHANGE', ...(saved ? { checkpoint: saved } : {}) };
    return { ...commitJournal(root, name, candidates[0], before), ...(saved ? { checkpoint: saved } : {}) };
  } catch (e) { return { state: e.state || 'PERSISTENCE_FAILED', blocked: true, ...(saved ? { checkpoint: saved } : {}) }; }
}
function terminal(base, result) {
  const persistence = settle(base, result);
  return { ...result, seatPersistence: persistence,
    ...(persistence.blocked ? { status: 'FAILED', failureClass: result.failureClass || 'CONTENT', reason: persistence.state } : {}) };
}
module.exports = { capture, settle, terminal };

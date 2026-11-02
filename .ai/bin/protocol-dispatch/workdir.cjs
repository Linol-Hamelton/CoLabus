'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { getRepoRoot, git, gitIn, tree, readStateRetried, JOURNAL_RE } = require('./procfs.cjs');

const NO_PUSH = { key: 'url.no-push://blocked.insteadOf', value: '' };

function workdirState(dir) {
  const entries = readStateRetried(dir);
  if (!entries) return null;
  return { entries };
}

function prepareWorkdir(slot, attemptNumber, repoRoot = getRepoRoot(), copyIn = [], tmpDir = null) {
  const baseDir = tmpDir || os.tmpdir();
  const dir = fs.mkdtempSync(path.join(baseDir, `disp-${slot.id}-${attemptNumber}-`));
  const rClone = gitIn(repoRoot, ['clone', '--shared', '--no-checkout', repoRoot, dir]);
  if (rClone.status !== 0) {
    dropWorkdir(dir);
    throw new Error(`git clone failed: ${rClone.stderr || rClone.stdout}`);
  }
  const rCo = gitIn(dir, ['checkout', 'HEAD']);
  if (rCo.status !== 0) {
    dropWorkdir(dir);
    throw new Error(`git checkout failed: ${rCo.stderr || rCo.stdout}`);
  }
  gitIn(dir, ['config', NO_PUSH.key, NO_PUSH.value]);

  const base = gitIn(dir, ['rev-parse', 'HEAD']).stdout.trim();

  if (Array.isArray(copyIn)) {
    for (const rel of copyIn) {
      const src = path.resolve(repoRoot, rel);
      const dst = path.resolve(dir, rel);
      if (fs.existsSync(src)) {
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
      }
    }
  }

  return { dir, base };
}

function dropWorkdir(dir) {
  if (!dir) return;
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function scopeViolations(dir, baseHead, declaredOutputs) {
  const bad = [];
  const rRev = gitIn(dir, ['rev-parse', 'HEAD']);
  const curHead = (rRev.stdout || '').trim();
  if (curHead !== baseHead) {
    bad.push(`HEAD changed from ${baseHead} to ${curHead}`);
  }

  const rRemotes = gitIn(dir, ['remote', '-v']);
  const remoteLines = (rRemotes.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  for (const line of remoteLines) {
    const parts = line.split(/\s+/);
    if (parts[0] !== 'origin') {
      bad.push(`unauthorized remote added: ${parts[0]}`);
    }
  }

  const rCfg = gitIn(dir, ['config', '--get', NO_PUSH.key]);
  if ((rCfg.stdout || '').trim() !== NO_PUSH.value) {
    bad.push(`push prevention config ${NO_PUSH.key} altered`);
  }

  const st = workdirState(dir);
  if (!st) {
    bad.push('failed to read git status');
    return bad;
  }

  const allowedOutputs = (declaredOutputs || []).map(p => p.replace(/\\/g, '/'));
  for (const e of st.entries) {
    const norm = e.path.replace(/\\/g, '/');
    if (allowedOutputs.includes(norm)) continue;
    if (JOURNAL_RE.test(norm)) continue;
    bad.push(`unauthorized file touched: ${norm} (${e.code})`);
  }

  return bad;
}

function scopeCheck(dir, baseHead, declaredOutputs, knownProcs = {}) {
  const bad = scopeViolations(dir, baseHead, declaredOutputs);
  return { bad: bad.length ? bad : null };
}

// Journal imports land in the repository by default. PROTOCOL_JOURNAL_IMPORT_ROOT redirects
// them (tests bind it to their temp root so a dispatch run never writes into the tracked tree).
function journalImportRoot(repoRoot) {
  const override = process.env.PROTOCOL_JOURNAL_IMPORT_ROOT;
  return override ? path.resolve(override) : repoRoot;
}

function importResults(dir, declaredOutputs, repoRoot = getRepoRoot()) {
  const imported = [];
  const declaredNorm = (declaredOutputs || []).map(p => p.replace(/\\/g, '/'));
  const jRoot = journalImportRoot(repoRoot);

  for (const p of declaredNorm) {
    const src = path.resolve(dir, p);
    if (fs.existsSync(src)) {
      const dst = path.resolve(jRoot, p);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      fs.copyFileSync(src, dst);
      imported.push(p);
    }
  }

  const st = workdirState(dir);
  if (st) {
    for (const e of st.entries) {
      const norm = e.path.replace(/\\/g, '/');
      if (JOURNAL_RE.test(norm)) {
        const src = path.resolve(dir, norm);
        const dst = path.resolve(jRoot, norm);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(src, dst);
        imported.push(norm);
      }
    }
  }

  return imported;
}

function lsRemoteSnapshot(repoRoot = getRepoRoot()) {
  const r = gitIn(repoRoot, ['ls-remote']);
  if (r.status !== 0) return null;
  return (r.stdout || '').trim();
}

function remoteAuditVerdict(beforeSnapshot, afterSnapshot) {
  if (beforeSnapshot === null || afterSnapshot === null) {
    return { incident: [] };
  }
  if (beforeSnapshot !== afterSnapshot) {
    return { incident: ['remote refs changed during attempt execution'] };
  }
  return { incident: [] };
}

// An explicit advisory interface for BOTH launch paths. Not wired as a new
// gate: the scope check and the integration act must land first. A local snapshot cannot
// detect a commit subsequently reset, an external push, or arbitrary shell effects.
function completePermissionSnapshot(s) {
  const sha = v => typeof v === 'string' && /^[0-9a-f]{40}$/.test(v);
  if (!s || !sha(s.head) || !Array.isArray(s.refs)) return false;
  const names = new Set();
  return s.refs.every(r => {
    if (!Array.isArray(r) || r.length !== 2 || !sha(r[1]) || typeof r[0] !== 'string'
        || !/^refs\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_.-]+)+$/.test(r[0])
        || r[0].split('/').some(p => p === '.' || p === '..' || p.endsWith('.') || p.endsWith('.lock'))
        || r[0].includes('..') || names.has(r[0])) return false;
    names.add(r[0]); return true;
  });
}
function permissionSnapshot(dir, runGit = gitIn) {
  try {
    const head = runGit(dir, ['rev-parse', 'HEAD']);
    const refs = runGit(dir, ['for-each-ref', '--format=%(refname) %(objectname)']);
    if (head.status !== 0 || refs.status !== 0) return null;
    const snapshot = { head: String(head.stdout || '').trim(), refs: String(refs.stdout || '').trim().split(/\r?\n/).filter(Boolean).map(l => l.split(' ')) };
    return completePermissionSnapshot(snapshot) ? snapshot : null;
  } catch { return null; }
}
function permissionAudit(before, after) {
  const result = (status, reasons) => ({ mode: 'advisory', noCommit: 'detect-only', status, reasons });
  if (!completePermissionSnapshot(before) || !completePermissionSnapshot(after)) return result('unknown', ['snapshot-unavailable']);
  const reasons = [];
  if (before.head !== after.head) reasons.push('head-changed');
  const canonical = s => JSON.stringify(s.refs.slice().sort((a, b) => a[0].localeCompare(b[0])));
  if (canonical(before) !== canonical(after)) reasons.push('refs-changed');
  return result(reasons.length ? 'violation' : 'clear', reasons);
}

module.exports = {
  permissionSnapshot,
  permissionAudit,
  prepareWorkdir,
  dropWorkdir,
  scopeCheck,
  scopeViolations,
  importResults,
  lsRemoteSnapshot,
  remoteAuditVerdict,
  workdirState,
  NO_PUSH
};

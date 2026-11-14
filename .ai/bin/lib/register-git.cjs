'use strict';
// Source-only Git boundary for the single operator. No checkout/index mutation.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const safe = require('./path-safe.cjs');
const { hasProtectedName } = require('./protected-paths.cjs');
const F = require('./register-fragments.cjs');
const L = require('./register-launch-ledger.cjs');
const REF = 'refs/register/launches';
const { need, fail } = F;
function local(file) {
  need(typeof file === 'string' && path.isAbsolute(file) && !hasProtectedName(file, { mode: 'segment' }), 'LAUNCH_PATH_UNSAFE');
  const r = safe.realInside(path.parse(file).root, file, { refuseHardlinks: true, allowRoot: true });
  need(r.ok && r.exists, 'LAUNCH_PATH_UNSAFE'); return r.real;
}
function boundary(repo) {
  repo = local(repo);
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  function result(args, input, extra = {}) {
    local(repo);
    return spawnSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], { cwd: repo, env: { ...env, ...extra }, input,
      windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 * 1024 });
  }
  function run(args, input, extra) {
    const r = result(args, input, extra); need(!r.error && r.status === 0, 'LAUNCH_GIT_FAILED'); return r.stdout;
  }
  const common = local(path.resolve(repo, run(['rev-parse', '--git-common-dir']).toString('utf8').trim()));
  need(run(['rev-parse', '--show-object-format']).toString().trim() === 'sha1', 'LAUNCH_GIT_FAILED');
  const commit = sha => {
    need(typeof sha === 'string' && F.SHA.test(sha), 'LAUNCH_BASE_INVALID');
    const r = result(['cat-file', '-t', sha]); need(!r.error && r.status === 0 && r.stdout.toString().trim() === 'commit', 'LAUNCH_BASE_INVALID'); return sha;
  };
  const current = () => {
    const r = result(['rev-parse', '--verify', '-q', REF]);
    if (!r.error && r.status === 1) return null;
    need(!r.error && r.status === 0, 'LAUNCH_GIT_FAILED'); const sha = r.stdout.toString().trim();
    need(F.SHA.test(sha), 'LAUNCH_LEDGER_INVALID'); return sha;
  };
  function readTree(sha) {
    commit(sha); const entries = new Map();
    const rows = run(['ls-tree', '-r', '-z', '--full-tree', sha]).toString('utf8').split('\0').filter(Boolean);
    for (const row of rows) {
      const m = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t([\s\S]+)$/.exec(row);
      need(m, 'LAUNCH_GIT_FAILED');
      const oid = m[3]; entries.set(m[4], { mode: m[1], oid, bytes: () => run(['cat-file', 'blob', oid]) });
    }
    return entries;
  }
  function batchBlobs(oids) {
    if (!oids.length) return new Map();
    const raw = run(['cat-file', '--batch'], Buffer.from(oids.join('\n') + '\n')); let offset = 0; const blobs = new Map();
    for (const oid of oids) {
      const end = raw.indexOf(10, offset); need(end !== -1, 'LAUNCH_LEDGER_INVALID');
      const m = /^([a-f0-9]{40}) blob ([0-9]+)$/.exec(raw.subarray(offset, end).toString('ascii'));
      need(m && m[1] === oid && Number(m[2]) <= F.MAX_BYTES, 'LAUNCH_LEDGER_INVALID');
      const size = Number(m[2]); offset = end + 1;
      need(offset + size < raw.length && raw[offset + size] === 10, 'LAUNCH_LEDGER_INVALID');
      blobs.set(oid, raw.subarray(offset, offset + size)); offset += size + 1;
    }
    need(offset === raw.length, 'LAUNCH_LEDGER_INVALID'); return blobs;
  }
  function authority(bootstrapSha, expectedRef = current()) {
    need(expectedRef, 'LAUNCH_AUTHORITY_MISSING');
    const tip = readTree(expectedRef);
    const blobs = batchBlobs([...new Set([...tip.values()].map(e => e.oid))]);
    for (const [p, e] of tip) { e.bytes = blobs.get(e.oid); F.readLaunch(F.bytesOf(e), p); }
    const history = run(['log', '--reverse', '--format=COMMIT %H %P', '--name-status', '--no-renames', '--root', expectedRef]).toString('utf8');
    const commits = []; let tree = new Map(); let header = null, additions = [];
    const flush = () => {
      if (!header) return;
      need(commits.length === 0 ? header.parents.length === 0 : header.parents.length === 1 && header.parents[0] === commits.at(-1).sha, 'LAUNCH_LEDGER_INVALID');
      need(commits.length === 0 || additions.length === 1, 'LAUNCH_LEDGER_INVALID');
      tree = new Map(tree);
      for (const p of additions) { need(!tree.has(p) && tip.has(p), 'LAUNCH_LEDGER_INVALID'); tree.set(p, tip.get(p)); }
      commits.push({ ...header, tree });
    };
    for (const line of history.split('\n')) {
      if (line.startsWith('COMMIT ')) {
        flush(); const parts = line.trim().split(' '); header = { sha: parts[1], parents: parts.slice(2) }; additions = [];
      } else if (line) {
        const file = line.slice(2);
        need(line.startsWith('A\t') && file.startsWith(F.PREFIXES[0])
          && /^L[0-9]{6}\.json$/.test(file.slice(F.PREFIXES[0].length)), 'LAUNCH_LEDGER_INVALID'); additions.push(file);
      }
    }
    flush();
    need(commits.length > 0 && commits[0].sha === bootstrapSha && tree.size === tip.size, 'LAUNCH_LEDGER_INVALID');
    const known = new Set(commits.map(c => c.sha));
    const reflog = run(['reflog', 'show', '--format=%H', REF]).toString().trim().split('\n').filter(Boolean);
    // A valid but rewound prefix must never make an issued ordinal reusable.
    // Ref-local never-expire policy is installed once by explicit bootstrap.
    need(reflog.length > 0 && reflog.every(sha => known.has(sha)), 'LAUNCH_LEDGER_INVALID');
    const rows = L.readLaunchLedger(tree);
    // Historical tampering M/D is already refused above, so current bytes are
    // the first bytes introduced by each A record. Verify per-commit continuity.
    for (const c of commits) L.readLaunchLedger(c.tree);
    return { bootstrapSha, commits, tree, rows, ref: expectedRef };
  }
  function lineSubset(baseSha, tree) {
    const base = readTree(baseSha);
    for (const [p, e] of base) if (p.toLowerCase().startsWith(F.PREFIXES[0])) {
      need(tree.has(p) && F.bytesOf(e).equals(F.bytesOf(tree.get(p))), 'LAUNCH_LEDGER_INVALID');
    }
  }
  function publish(tree, recordPath, bytes, parent, nonce) {
    const index = path.join(common, `register-launches-index-${nonce}`);
    need(safe.realInside(common, index, { refuseHardlinks: true }).ok && !fs.existsSync(index), 'LAUNCH_PATH_UNSAFE');
    const extra = { GIT_INDEX_FILE: index };
    let identity;
    try {
      if (parent) run(['read-tree', parent], undefined, extra);
      else {
        run(['read-tree', '--empty'], undefined, extra);
        for (const [p, e] of tree) {
          const oid = run(['hash-object', '-w', '--stdin'], F.bytesOf(e)).toString().trim();
          run(['update-index', '--add', '--cacheinfo', `100644,${oid},${p}`], undefined, extra);
        }
      }
      if (recordPath) {
        const oid = run(['hash-object', '-w', '--stdin'], bytes).toString().trim();
        run(['update-index', '--add', '--cacheinfo', `100644,${oid},${recordPath}`], undefined, extra);
      }
      const oid = run(['write-tree'], undefined, extra).toString().trim();
      if (fs.existsSync(index)) identity = fs.lstatSync(index, { bigint: true });
      const args = ['commit-tree', oid, ...(parent ? ['-p', parent] : [])];
      return run(args, Buffer.from(recordPath ? `Issue ${path.posix.basename(recordPath)}\n` : 'Register launch authority bootstrap\n')).toString().trim();
    } finally {
      if (identity && fs.existsSync(index)) {
        const check = safe.realInside(common, index, { refuseHardlinks: true }); const st = fs.lstatSync(index, { bigint: true });
        need(check.ok && st.ino === identity.ino && st.dev === identity.dev, 'LAUNCH_PATH_UNSAFE'); fs.unlinkSync(index);
      }
    }
  }
  return { repo, common, run, result, commit, current, readTree, authority, lineSubset, publish };
}
module.exports = { REF, local, boundary };

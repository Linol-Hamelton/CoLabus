'use strict';
// G5: dispatch only. The existing farm submit owns mirror pushes and queue
// writes. No local fallback after a farm error and no manufactured receipt.
const fs = require('node:fs');
const path = require('node:path');
const { localRefusal } = require('../../lib/seat-heavy.cjs');
const refuse = reason => ({ ok: false, refused: true, code: 3, lines: [`AUTHOR-CHECK REFUSED ${reason}; nothing was run locally`] });
function route(cfg, env, exists = fs.existsSync) {
  const mode = cfg.heavyChecks === undefined ? 'local' : cfg.heavyChecks;
  if (!['local', 'farm', 'auto'].includes(mode)) return refuse('HEAVY-CHECKS-CONFIG');
  const farm = cfg.farmSubmit;
  const available = typeof farm === 'string' && path.isAbsolute(farm) && exists(farm);
  const executor = mode === 'auto' ? (available ? 'farm' : 'local') : mode;
  if (executor === 'farm' && !available) return refuse('FARM-SUBMIT-MISSING');
  if (executor === 'local') {
    const reason = localRefusal(env);
    if (reason) return refuse(reason);
  }
  return { executor };
}
function submit({ root, cfg, git, spawn, base, env }) {
  try {
    // Existing submit accepts HEAD+branch only, not an arbitrary base or a dirty
    // patch. Refuse inputs it cannot faithfully represent.
    if (base !== 'origin/v2.0.0') return refuse('FARM-BASE-UNSUPPORTED');
    if (require('./receipt.cjs').dirtyNonJournal(git(['status', '--porcelain=v1', '-z', '--untracked-files=all'])).length) return refuse('FARM-DIRTY');
    const head = git(['rev-parse', 'HEAD']);
    const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
    if (!/^[a-f0-9]{40}$/.test(head) || branch === 'HEAD' ||
        !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(branch) || branch.split('/').some(part => !part || part.startsWith('.') || part.endsWith('.') || part.endsWith('.lock')) || branch.includes('..')) return refuse('FARM-IDENTITY');
    const name = `${branch.replace(/[^A-Za-z0-9._-]/g, '_')}-${head.slice(0, 8)}`;
    const r = spawn(process.execPath, [cfg.farmSubmit, 'author-check', name, branch, head], {
      cwd: root, env: { ...env }, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 1024 * 1024,
    });
    if (r.error || r.status !== 0) return refuse('FARM-SUBMIT-FAILED');
    const match = /^SUBMITTED ([A-Za-z0-9._-]+) ([a-f0-9]{8})\r?$/m.exec(String(r.stdout || ''));
    if (!match || match[2] !== head.slice(0, 8)) return refuse('FARM-SUBMIT-UNCONFIRMED');
    return { ok: false, queued: true, code: 0, head, jobId: match[1], lines: [`AUTHOR-CHECK QUEUED ${match[1]} ${head}; result and receipt pending on farm`] };
  } catch { return refuse('FARM-SUBMIT-ERROR'); }
}
module.exports = { route, submit };

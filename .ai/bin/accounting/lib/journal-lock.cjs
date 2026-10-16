'use strict';
// Cooperative exclusive transaction lock. A crash leaves the lock for explicit recovery;
// age alone is never permission to remove it. No input path is written.
const fs = require('node:fs');
const path = require('node:path');
const { realInside } = require('../../lib/path-safe.cjs');

function withJournalLock(root, work) {
  const directory = realInside(path.parse(root).root, root, { allowRoot: true });
  if (!directory.ok || !directory.exists || directory.type !== 'dir') throw Object.assign(new Error('journal lock directory refused'), { code: 'UNSAFE-PATH' });
  const dirId = fs.statSync(directory.real);
  const file = path.join(root, '.launch-journal-sync.lock');
  const guard = realInside(root, file, { refuseHardlinks: true });
  if (!guard.ok) throw Object.assign(new Error(`journal lock refused: ${guard.reason}`), { code: 'UNSAFE-PATH' });
  let fd;
  try { fd = fs.openSync(guard.real, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | (fs.constants.O_NOFOLLOW || 0), 0o600); }
  catch (e) { if (e.code === 'EEXIST') throw Object.assign(new Error('journal transaction busy; retry with a fresh plan; abandoned locks require explicit recovery'), { code: 'JOURNAL-BUSY' }); throw e; }
  const held = fs.fstatSync(fd);
  const ours = () => {
    try {
    const dir = realInside(path.parse(root).root, root, { allowRoot: true });
    if (!dir.ok || dir.real !== directory.real) return false;
    const ds = fs.statSync(dir.real);
    if (ds.dev !== dirId.dev || ds.ino !== dirId.ino) return false;
    const g = realInside(root, file, { refuseHardlinks: true });
    if (!g.ok || g.real !== guard.real) return false;
    const s = fs.statSync(g.real);
      return s.dev === held.dev && s.ino === held.ino;
    } catch { return false; }
  };
  try {
    if (!ours()) throw Object.assign(new Error('journal lock changed before transaction'), { code: 'LOCK-CHANGED' });
    const result = work();
    if (!ours()) throw Object.assign(new Error('journal lock changed during transaction'), { code: 'LOCK-CHANGED' });
    return result;
  } finally {
    // Release only this invocation's inode, never another writer's lock.
    const release = ours();
    fs.closeSync(fd);
    if (release) fs.unlinkSync(file);
  }
}
module.exports = { withJournalLock };

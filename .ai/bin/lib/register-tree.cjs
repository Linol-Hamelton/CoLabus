'use strict';
// Immutable Git object reads shared by history and the package gate.
const { createHash } = require('node:crypto');
const { TextDecoder } = require('node:util');
const F = require('./register-fragments.cjs');
const oidOf = (type, bytes) => createHash('sha1').update(`${type} ${bytes.length}\0`).update(bytes).digest('hex');
function readGitTree(git, sha) {
  F.need(typeof git === 'function' && typeof sha === 'string' && F.SHA.test(sha), 'REGISTER_TREE_INVALID');
  const run = args => {
    const r = git(args, true);
    F.need(!r.error && r.status === 0 && Buffer.isBuffer(r.stdout), 'REGISTER_TREE_INVALID');
    return r.stdout;
  };
  const commit = run(['cat-file', 'commit', sha]);
  F.need(oidOf('commit', commit) === sha, 'REGISTER_TREE_INVALID');
  const header = /^tree ([a-f0-9]{40})\n/.exec(commit.toString('ascii'));
  F.need(header, 'REGISTER_TREE_INVALID');
  const treeOid = header[1], rawTree = run(['cat-file', 'tree', treeOid]);
  F.need(oidOf('tree', rawTree) === treeOid, 'REGISTER_TREE_INVALID');
  let listing;
  try { listing = new TextDecoder('utf-8', { fatal: true }).decode(run(['ls-tree', '-r', '-z', '--full-tree', treeOid])); }
  catch { F.fail('REGISTER_TREE_INVALID'); }
  F.need(!listing || listing.endsWith('\0'), 'REGISTER_TREE_INVALID');
  const tree = new Map();
  for (const row of listing ? listing.slice(0, -1).split('\0') : []) {
    const m = /^([0-7]{6}) (blob|commit) ([a-f0-9]{40})\t([^\0]+)$/.exec(row);
    F.need(m && !tree.has(m[4]), 'REGISTER_TREE_INVALID');
    const [, mode, type, oid, file] = m;
    let bytes;
    tree.set(file, Object.freeze({ mode, oid, bytes: () => {
      F.need(type === 'blob', 'REGISTER_TREE_INVALID');
      if (bytes === undefined) {
        bytes = run(['cat-file', 'blob', oid]);
        F.need(oidOf('blob', bytes) === oid, 'REGISTER_TREE_INVALID');
      }
      return Buffer.from(bytes);
    } }));
  }
  return { sha, treeOid, tree };
}
module.exports = { readGitTree };

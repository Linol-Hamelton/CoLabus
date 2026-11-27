'use strict';
// Explicit pinned-history adapter. It does not select or enable a consumer mode.
// Historical definitions: PROCESS-REGISTER.md and OPEN-REGISTER.json.
const { followedPathSync } = require('./real-path.cjs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const F = require('./register-fragments.cjs');
const C = require('./register-compiler.cjs');
const L = require('./register-launch-ledger.cjs');
const R = require('./register-renumber.cjs');
const { readLanding } = require('../operator/landed-proof.cjs');
const { readGitTree } = require('./register-tree.cjs');
const { isProtectedPath } = require('./protected-paths.cjs');
const M = require('./register-consumer-mode.cjs');
// The landing history readers of the train lander are loaded at run time from a resolved path: landing tooling with its own
// operator dependencies is not part of the module closure the pilot kit ships with this reader (docs/ops/pilot-install.cjs
// follows literal relative requires only).
const TRAIN_LAND_MODULE = path.join(__dirname, '..', 'ops-tools', 'train-land.cjs');
function openRegisterHistory({ repo, targetSha }) {
  F.need(typeof repo === 'string' && path.isAbsolute(repo) && !isProtectedPath(repo, { mode: 'segment' }), 'CITE_SOURCE_UNKNOWN');
  // The protection is judged where the repository really lives: a local alias is followed to its target.
  repo = followedPathSync(repo);
  F.need(!isProtectedPath(repo, { mode: 'segment' }), 'CITE_SOURCE_UNKNOWN');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  const git = (args, binary = false) => spawnSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], {
    cwd: repo, env, encoding: binary ? undefined : 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 * 1024,
  });
  const run = args => { const r = git(args); F.need(!r.error && r.status === 0, 'CITE_SOURCE_UNKNOWN'); return r.stdout; };
  F.need(run(['rev-parse', '--show-object-format']).trim() === 'sha1', 'CITE_SOURCE_UNKNOWN');
  const target = readGitTree(git, targetSha);
  const train = require(TRAIN_LAND_MODULE);
  const read = sha => readGitTree(git, sha);
  const definitions = new Map();
  function legacyReader(sourceSha) {
    if (definitions.has(sourceSha)) { const r = definitions.get(sourceSha); return { processIds: [...r.processIds], itemIds: [...r.itemIds] }; }
    const source = read(sourceSha), p = source.tree.get(F.COMPILED[0]), o = source.tree.get(F.COMPILED[1]);
    F.need(p?.mode === '100644' && o?.mode === '100644', 'CITE_SOURCE_UNKNOWN');
    const process = C.inventoryProcess(F.bytesOf(p), { sourceSha, historical: true });
    // A historical duplicate is ambiguous even if the closed archival ledger
    // permits replaying its bytes. It cannot silently choose one definition.
    F.need(![...process.processRows.keys()].some(id => !F.P.test(id)), 'CITE_SOURCE_UNKNOWN');
    const open = require('./register-landing.cjs').json(F.bytesOf(o));
    F.need(Array.isArray(open.items) && open.items.every(it => F.OR.test(it.id)) &&
      new Set(open.items.map(it => it.id)).size === open.items.length, 'CITE_SOURCE_UNKNOWN');
    const result = { processIds: [...process.processRows.keys()], itemIds: open.items.map(it => it.id) };
    definitions.set(sourceSha, { processIds: [...result.processIds], itemIds: [...result.itemIds] });
    return result;
  }
  function legacyMapReader({ sourceSha, targetSha: requested }) {
    F.need(requested === targetSha, 'CITE_SOURCE_UNKNOWN');
    const source = read(sourceSha);
    if (sourceSha === targetSha) return null;
    const rows = run(['rev-list', '--first-parent', '--parents', targetSha]).trim().split('\n').reverse().map(row => row.split(' '));
    const messages = new Map();
    const messageAt = sha => {
      if (!messages.has(sha)) messages.set(sha, run(['show', '-s', '--no-show-signature', '--no-notes', '--format=%B', sha]));
      return messages.get(sha);
    };
    const ancestor = rows.findIndex(([sha]) => sha === sourceSha);
    let start = ancestor + 1, matched = ancestor !== -1, mapSource = sourceSha;
    if (!matched) {
      start = rows.findIndex(([sha]) => {
        const message = messageAt(sha);
        if (!message.includes(sourceSha)) return false;
        const landing = readLanding(message), map = R.readRenumber(message);
        if (landing.tip === sourceSha || (map?.version === 2 ? map.legacy : map)?.packages?.some(p => p.commit === sourceSha)) return true;
        return false;
      });
      if (start === -1) start = rows.findIndex(([sha]) => {
        const landing = readLanding(messageAt(sha));
        if (landing.reason || landing.form !== 'TRAILER') return false;
        const relation = git(['merge-base', '--is-ancestor', sourceSha, landing.tip]);
        F.need(!relation.error && [0, 1].includes(relation.status), 'CITE_SOURCE_UNKNOWN');
        if (relation.status !== 0) return false;
        const tip = read(landing.tip);
        const unchanged = F.COMPILED.slice(0, 2).every(p => source.tree.get(p)?.mode === '100644' &&
          source.tree.get(p)?.oid === tip.tree.get(p)?.oid);
        F.need(unchanged, 'CITE_SOURCE_UNKNOWN');
        mapSource = landing.tip; return true;
      });
      F.need(start !== -1, 'CITE_SOURCE_UNKNOWN');
    }
    const composed = {};
    for (const [sha, ...parents] of rows.slice(start)) {
      const message = messageAt(sha);
      const hasTrailer = /^land /.test(message) || /(?:register-renumber|landed-tip)\s*:/i.test(message);
      if (!hasTrailer) continue;
      F.need(parents.length === 1, 'CITE_LANDING_INVALID');
      const landing = readLanding(message);
      F.need(!landing.reason && landing.form === 'TRAILER', 'CITE_LANDING_INVALID');
      const map = R.readRenumber(message);
      // Recompute the complete squash tree and mapping; syntax alone cannot
      // authorize either a v1 trailer or the legacy component of v2.
      const verified = train.verify({ repo, base: parents[0], head: sha, allowArchived: true, env });
      F.need(verified.ok === true, 'CITE_LANDING_INVALID');
      const legacy = map === null ? { packages: [], notRewritten: [] } : map.version === 2 ? map.legacy : map;
      F.need(map === null || map.version === 1 || map.version === 2, 'CITE_LANDING_INVALID');
      F.keys(legacy, map?.version === 1 ? ['version', 'packages', 'notRewritten'] : ['packages', 'notRewritten']);
      F.need(Array.isArray(legacy.packages) && Array.isArray(legacy.notRewritten), 'CITE_LANDING_INVALID');
      const own = legacy.packages.filter(p => p.commit === mapSource);
      F.need(own.length <= 1, 'CITE_LANDING_INVALID');
      if (own.length || landing.tip === mapSource) {
        F.need(!matched, 'CITE_LANDING_INVALID'); matched = true;
        Object.assign(composed, own[0]?.ids || {});
      }
      // Once source is on the canonical line its allocated numbers are stable;
      // unrelated package maps must never be applied just because IDs coincide.
    }
    F.need(matched, 'CITE_SOURCE_UNKNOWN');
    const historical = legacyReader(sourceSha), current = legacyReader(targetSha);
    for (const [ids, valid] of [[historical.processIds, current.processIds], [historical.itemIds, current.itemIds]]) {
      F.need(ids.every(id => valid.includes(composed[id] || id)), 'CITE_SOURCE_UNKNOWN');
    }
    return { version: 1, packages: [{ commit: sourceSha, ids: composed }], notRewritten: [] };
  }
  function loadInputs() {
    try { return train.readRegisterSnapshot({ repo, ref: targetSha, env }); }
    catch { return train.readRegisterPackageSnapshot({ repo, ref: targetSha, env }); }
  }
  function loadSnapshot() {
    const verified = loadInputs();
    const result = C.compileRegister({ ...verified, tree: target.tree, viewLabels: train.registerLabels() });
    F.need(result.ok, 'CITE_SNAPSHOT_INVALID');
    // The landing projection (compiled register equals legacy union landed items)
    // is an active-consumer invariant. A shadow-mode target still keeps the
    // legacy compiled views while its landing journal records the landed plan;
    // enforcing the projection there would refuse every Git-bound shadow
    // snapshot. Shadow targets validate their landing, launches and fragments
    // without the active-mode baseline rewrite.
    const active = M.modeOf(target.tree) === 'active';
    const legacy = active ? C.readLegacy({ tree: target.tree, legacy: verified.legacy }) : null;
    return L.loadRegisterSnapshot({ ...verified, tree: target.tree, sha: targetSha,
      schemaState: active ? verified.schemaState : 'pre-migration',
      landingReader: () => result.landing,
      projectionContext: active ? { legacy: legacy.reg, landing: result.landing } : undefined });
  }
  return Object.freeze({ sha: targetSha, treeOid: target.treeOid, read, legacyReader, legacyMapReader, loadSnapshot, loadInputs });
}
module.exports = { openRegisterHistory };

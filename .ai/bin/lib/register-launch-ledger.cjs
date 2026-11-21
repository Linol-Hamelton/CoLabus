'use strict';
// Pure issue/proof/snapshot readers. Operator Git authority is implemented by
// ops-tools/register-launch; isolated validators never allocate numbers.
const F = require('./register-fragments.cjs');
const { need, fail } = F;
const snapshots = new WeakMap();
function readLaunchLedger(tree) {
  try {
    need(tree instanceof Map);
    const records = [...tree].map(([path, entry]) => ({ path, bytes: F.bytesOf(entry) }));
    const rows = records.map(r => ({ ...r, record: F.readLaunch(r.bytes, r.path) })).sort((a, b) => a.record.ordinal - b.record.ordinal);
    let previous = null; const packages = new Set();
    rows.forEach((r, i) => {
      need(r.record.ordinal === i + 1 && r.record.provenance.previousRecord === previous && !packages.has(r.record.packageId));
      packages.add(r.record.packageId); previous = F.digest(r.bytes);
    });
    return rows;
  } catch { fail('LAUNCH_LEDGER_INVALID'); }
}
function verifyIssueProofOperator({ bytes, path, proof, authority }) {
  const record = F.verifyIssueProofOffline({ bytes, path, proof });
  try {
    need(authority && authority.bootstrapSha === proof.bootstrapSha && Array.isArray(authority.commits));
    need(authority.commits.length > 0 && authority.commits[0].sha === proof.bootstrapSha);
    let previous = new Map(); let first = null;
    for (const commit of authority.commits) {
      need(typeof commit.sha === 'string' && F.SHA.test(commit.sha) && commit.tree instanceof Map);
      need(commit.parents.length === (previous.size === 0 && commit.sha === proof.bootstrapSha ? 0 : 1));
      const idx = authority.commits.indexOf(commit);
      if (idx > 0) need(commit.parents[0] === authority.commits[idx - 1].sha);
      readLaunchLedger(commit.tree);
      if (idx > 0) need(commit.tree.size === previous.size + 1);
      for (const [p, entry] of previous) need(commit.tree.has(p) && F.bytesOf(entry).equals(F.bytesOf(commit.tree.get(p))));
      if (!first && commit.tree.has(path)) first = commit.sha;
      previous = commit.tree;
    }
    need(first === proof.issueCommit && previous.has(path) && F.bytesOf(previous.get(path)).equals(bytes));
    return record;
  } catch { fail('LAUNCH_PROVENANCE_MISSING'); }
}
function checkLanding(landing, launches) {
  try {
    F.keys(landing, ['version', 'byLaunch', 'bySlot']);
    need(landing.version === 1 && landing.byLaunch instanceof Map && landing.bySlot instanceof Map);
    const seenP = new Set(), seenI = new Set(), slots = new Set();
    let ordinal = 0;
    for (const [launchId, r] of landing.byLaunch) {
      F.keys(r, ['schema', 'landingOrdinal', 'launchId', 'packageId', 'parentSha', 'tipSha', 'issueDigest', 'fragmentDigests', 'processIds', 'itemIds', 'previousEntry']);
      const issued = launches.get(launchId);
      need(issued && r.schema === 'register-landing/1' && r.launchId === launchId && r.packageId === issued.packageId && r.issueDigest === issued.issueDigest);
      need(r.landingOrdinal === ++ordinal && F.SHA.test(r.parentSha) && F.SHA.test(r.tipSha));
      need(ordinal === 1 ? r.previousEntry === null : F.DIGEST.test(r.previousEntry));
      for (const [kind, ids, seen, grammar] of [['S', r.processIds, seenP, F.P], ['I', r.itemIds, seenI, F.OR]]) {
        F.keys(ids, issued.slots[kind]);
        for (const slot of issued.slots[kind]) {
          const id = ids[slot]; need(typeof id === 'string' && grammar.test(id) && !seen.has(id)); seen.add(id);
          const key = `${launchId}-${slot}`; slots.add(key);
          const value = landing.bySlot.get(key);
          F.keys(value, ['launchId', 'packageId', 'slot', 'processId', 'itemId']);
          need(value.launchId === launchId && value.packageId === r.packageId && value.slot === slot);
          need(kind === 'S' ? value.processId === id && value.itemId === null : value.itemId === id && value.processId === null);
        }
      }
      F.keys(r.fragmentDigests, Object.keys(issued.fragmentDigests));
      for (const [path, hash] of Object.entries(issued.fragmentDigests)) need(r.fragmentDigests[path] === hash);
    }
    need(landing.bySlot.size === slots.size && [...landing.bySlot.keys()].every(k => slots.has(k)));
    return landing;
  } catch { fail('CITE_LANDING_INVALID'); }
}
function stateDigest(snapshot) {
  const serial = x => x instanceof Map ? [...x].map(([k, v]) => [k, serial(v)]) : Array.isArray(x) ? x.map(serial) : x && typeof x === 'object' ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, serial(v)])) : x;
  return F.digest(Buffer.from(JSON.stringify(serial(snapshot))));
}
function isRegisterSnapshot(snapshot) {
  try { return snapshots.has(snapshot) && snapshots.get(snapshot) === stateDigest(snapshot); } catch { return false; }
}
function loadRegisterSnapshot({ tree, reader, sha, issueProofs, landingReader, schemaState, proofReader, projectionContext }) {
  try {
    need(typeof sha === 'string' && F.SHA.test(sha));
    if (reader !== undefined) { need(tree === undefined && typeof reader === 'function'); tree = reader(); }
    const result = F.readFragmentInputs({ tree, issueProofs });
    if (!result.ok) {
      if (result.diagnostics.some(d => d.path.startsWith(F.PREFIXES[0]))) fail('LAUNCH_LEDGER_INVALID');
      fail('CITE_SNAPSHOT_INVALID');
    }
    const launches = new Map([...result.launches].sort(([a], [b]) => a < b ? -1 : 1).map(([id, r]) => [id, {
      packageId: r.packageId, packageLabel: r.packageLabel, slots: { S: [], I: [] }, issueDigest: r.issueDigest, fragmentDigests: {},
    }]));
    for (const f of result.fragments) {
      const r = launches.get(f.launchId); r.slots[f.kind].push(f.slot); r.fragmentDigests[f.path] = f.digest;
    }
    let landing = null;
    if (tree.has(F.LANDING)) {
      need(typeof landingReader === 'function', 'CITE_LANDING_INVALID');
      landing = checkLanding(landingReader({ tree, launches }), launches);
    } else need(schemaState === 'pre-migration' && landingReader === undefined, 'CITE_LANDING_INVALID');
    const relations = F.validateFragments({ tree, mode: 'line', issueProofs, schemaState, proofReader,
      projectionContext: projectionContext && { ...projectionContext, landing } });
    need(relations.ok, 'CITE_SNAPSHOT_INVALID');
    const snapshot = { sha, launches, landing };
    snapshots.set(snapshot, stateDigest(snapshot));
    return snapshot;
  } catch (e) {
    if (['CITE_LANDING_INVALID', 'LAUNCH_LEDGER_INVALID'].includes(e.code)) throw e;
    fail('CITE_SNAPSHOT_INVALID');
  }
}
module.exports = { readLaunchLedger, verifyIssueProofOffline: F.verifyIssueProofOffline, verifyIssueProofOperator, loadRegisterSnapshot, isRegisterSnapshot };

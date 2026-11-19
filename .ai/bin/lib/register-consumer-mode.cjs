'use strict';
// The only consumer selector is the mode in the pinned register STATE.
const F = require('./register-fragments.cjs');
const C = require('./register-compiler.cjs');
const J = require('./register-landing.cjs');
const MODE_LOG = C.ROOT + 'CONSUMERS.jsonl';
const MODES = Object.freeze(['shadow', 'active']);
function modeOf(tree) {
  if (!tree.has(C.STATE)) {
    F.need(![...tree.keys()].some(p => p.toLowerCase().startsWith(C.ROOT)), 'REGISTER_LANDING_UNAVAILABLE');
    return 'shadow';
  }
  F.need(tree.get(C.STATE).mode === '100644', 'REGISTER_LANDING_UNAVAILABLE');
  const s = C.readJson(tree, C.STATE);
  F.keys(s, ['schema', 'mode', 'migrationSha', 'legacyManifestDigest']);
  F.need(s.schema === 'register-state/1' && MODES.includes(s.mode) && F.SHA.test(s.migrationSha) &&
    F.DIGEST.test(s.legacyManifestDigest), 'REGISTER_LANDING_UNAVAILABLE');
  return s.mode;
}
function sameMode(line, candidate) {
  F.need(modeOf(line) === modeOf(candidate), 'REGISTER_MODE_MISMATCH');
}
function records(tree) {
  const e = tree.get(MODE_LOG);
  if (!e) return [];
  F.need(e.mode === '100644', 'REGISTER_MODE_HISTORY');
  const text = J.decode(F.bytesOf(e));
  F.need(text.endsWith('\n'), 'REGISTER_MODE_HISTORY');
  let previous = null, expectedFrom = 'shadow';
  const rows = text.slice(0, -1).split('\n').map(line => {
    F.need(Buffer.byteLength(line) < J.MAX_LINE, 'REGISTER_MODE_HISTORY');
    const r = J.json(Buffer.from(line));
    F.keys(r, ['schema', 'parentSha', 'from', 'to', 'approval', 'previous']);
    F.need(r.schema === 'register-consumer-transition/1' && F.SHA.test(r.parentSha) &&
      r.from === expectedFrom && MODES.includes(r.to) && r.from !== r.to && r.previous === previous &&
      JSON.stringify(r) === line, 'REGISTER_MODE_HISTORY');
    previous = F.digest(Buffer.from(line + '\n'));
    expectedFrom = r.to;
    return r;
  });
  F.need(modeOf(tree) === expectedFrom, 'REGISTER_MODE_HISTORY');
  return rows;
}
function transition({ tree, parentSha, to, approval }) {
  F.need(tree.has(C.STATE) && F.SHA.test(parentSha) && MODES.includes(to), 'REGISTER_MODE_INVALID');
  const from = modeOf(tree);
  F.need(from !== to, 'REGISTER_MODE_REPLAY');
  const prior = records(tree), old = tree.has(MODE_LOG) ? F.bytesOf(tree.get(MODE_LOG)) : Buffer.alloc(0);
  const record = { schema: 'register-consumer-transition/1', parentSha, from, to, approval,
    previous: prior.length ? F.digest(Buffer.from(JSON.stringify(prior.at(-1)) + '\n')) : null };
  const next = new Map(tree), state = { ...C.readJson(tree, C.STATE), mode: to };
  const files = new Map([[C.STATE, C.entry(C.j(state))],
    [MODE_LOG, C.entry(Buffer.concat([old, Buffer.from(JSON.stringify(record) + '\n')]))]]);
  for (const [p, e] of files) next.set(p, e);
  // No register number, seed, fragment, landing or shadow entry is rewritten.
  records(next);
  return { tree: next, files, record };
}
function approvalFor(tree, approval, parentSha, to, owners) {
  F.keys(approval, ['schema', 'approvedBy', 'parentSha', 'toolSha', 'to'],
    to === 'active' ? ['decision', 'qualification'] : [], 'REGISTER_MODE_AUTHORITY');
  F.need(approval.schema === 'register-consumer-approval/1' && approval.parentSha === parentSha &&
    approval.to === to && F.SHA.test(approval.toolSha) && owners.has(approval.approvedBy), 'REGISTER_MODE_AUTHORITY');
  if (to === 'active') {
    F.need(/^PROTO-DEC-[0-9]{4}$/.test(approval.decision) && typeof approval.qualification === 'string', 'REGISTER_MODE_AUTHORITY');
    const text = C.bytesAt(tree, '.ai/DECISIONS.md').toString('utf8');
    const blocks = text.split(/^### /m).filter(b => b.startsWith(approval.decision + '\n'));
    F.need(blocks.length === 1, 'REGISTER_MODE_AUTHORITY');
    const block = blocks[0];
    F.need(/^Status: Accepted$/m.test(block) && block.split('\n').some(l =>
      l === 'Approved by: ' + approval.approvedBy || l.startsWith('Approved by: ' + approval.approvedBy + ' (')) &&
      /^Register-consumers: active$/m.test(block) && block.split('\n').includes('Qualification: ' + approval.qualification), 'REGISTER_MODE_AUTHORITY');
  }
}
function qualification(tree, name) {
  F.need(typeof name === 'string' && /^docs\/[A-Za-z0-9_./-]+\.json$/.test(name) &&
    !name.split('/').some(p => p === '..' || p === '.'), 'REGISTER_MODE_QUALIFICATION');
  const q = C.readJson(tree, name);
  F.keys(q, ['schema', 'consumerReports', 'pStatus', 'conversion', 'historical', 'migration', 'farm', 'openPackages'], [], 'REGISTER_MODE_QUALIFICATION');
  F.need(q.schema === 'register-consumer-qualification/1', 'REGISTER_MODE_QUALIFICATION');
  for (const artifact of [q.pStatus, q.conversion, q.historical]) {
    F.keys(artifact, ['path', 'digest'], [], 'REGISTER_MODE_QUALIFICATION');
    F.need(typeof artifact.path === 'string' && C.safePath(artifact.path) && F.DIGEST.test(artifact.digest) &&
      tree.get(artifact.path)?.mode === '100644' && F.digest(C.bytesAt(tree, artifact.path)) === artifact.digest, 'REGISTER_MODE_QUALIFICATION');
  }
  F.need(Array.isArray(q.migration) && q.migration.length === 3 && q.migration.every(r =>
    r && F.DIGEST.test(r.expected) && r.expected === r.actual), 'REGISTER_MODE_QUALIFICATION');
  F.need(Array.isArray(q.farm) && q.farm.length === 2 && new Set(q.farm.map(r => typeof r.host === 'string' ? r.host.toLowerCase() : null)).size === 2 &&
    q.farm.every(r => typeof r.host === 'string' && r.host.trim() && r.host === r.host.trim() && F.DIGEST.test(r.inputDigest) &&
      Array.isArray(r.hashes) && r.hashes.length === 3 && r.hashes.every(h => F.DIGEST.test(h)) &&
      r.rehearsal?.switch === r.rehearsal?.reswitch && F.DIGEST.test(r.rehearsal?.switch) &&
      F.DIGEST.test(r.rehearsal?.rollback) && typeof r.report === 'string' && C.safePath(r.report) &&
      tree.has(r.report)) && require('node:util').isDeepStrictEqual(q.farm[0].hashes, q.farm[1].hashes) &&
    q.farm[0].inputDigest === q.farm[1].inputDigest, 'REGISTER_MODE_QUALIFICATION');
  F.need(require('node:util').isDeepStrictEqual(q.farm[0].rehearsal, q.farm[1].rehearsal), 'REGISTER_MODE_QUALIFICATION');
  F.need(Array.isArray(q.openPackages), 'REGISTER_LEGACY_PACKAGE');
  return q;
}
module.exports = { MODE_LOG, MODES, modeOf, sameMode, records, transition, approvalFor, qualification };

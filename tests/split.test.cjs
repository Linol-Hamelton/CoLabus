'use strict';

// Split smoke tests for the protocol-dispatch / protocol-handoff modularization
// (the modularization plan). One require() per leaf plus one per
// entry file: the entry-file assertions pin the exact public key sets (18/18 and
// 54/54), so a dropped public name or a leaked internal cross-leaf name both fail;
// the per-leaf assertions pin each leaf's declared export slice (public plus the
// internal cross-leaf names the plan declares), so an accidental spread or a
// missing internal binding fails too.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');

test('handoff entry file exports exactly the 19 public names', () => {
  const handoff = require('../.ai/bin/protocol-handoff.cjs');
  assert.deepEqual(Object.keys(handoff).sort(), [
    'anchor', 'archiveEntryRecords', 'attach', 'canonicalEntryBody', 'checkOwnerReceipt',
    'DATE_HEADING_M_REGEX', 'DATE_HEADING_REGEX', 'ENTRY_HASH_FORMAT', 'entryHash',
    'findParentEntry', 'formatWithEvidence', 'gateCheck', 'hasEntryHashFormat2',
    'parseEvidenceBlock', 'readEvidence', 'renderEvidence', 'verifyArchivedChain',
    'verifyJournalChain', 'main',
  ].sort());
});

test('dispatch entry file exports exactly the 54 public names', () => {
  const dispatch = require('../.ai/bin/protocol-dispatch.cjs');
  assert.deepEqual(Object.keys(dispatch).sort(), [
    'buildClientCommand', 'checkCommand', 'checkCompletion', 'chunkIsProgress',
    'classifyErrorText', 'computePins', 'dropWorkdir', 'ERROR_PATTERNS', 'ERROR_TEXT',
    'executeAttempt', 'executorEnv', 'FAILURE_CLASSES', 'formatCommandLine', 'getRepoRoot',
    'git', 'gitEnv', 'gitIn', 'gitOpts', 'gitProcessIn', 'identityOf', 'importResults', 'isPidAlive',
    'killExact', 'loadDispatch', 'loadLadder', 'loadRegistry', 'lsRemoteSnapshot', 'main',
    'makePointer', 'mapClassForRunRecord', 'NO_PUSH', 'parsePorcelainZ', 'parseUsageFromLog',
    'prepareWorkdir', 'probeAll', 'probeClient', 'readStateRetried', 'releaseStartLock',
    'remoteAuditVerdict', 'reportDispatch', 'RETRY_TEXT', 'resolveCommand', 'resolveSlot',
    'runDispatch', 'scopeCheck', 'scopeViolations', 'snapshotProcesses', 'takeStartLock',
    'validateDispatch', 'validateRegistry', 'verifyLadderSectionSha256', 'verifyPins',
    'workdirState', 'writeRepairFile',
  ].sort());
});

test('handoff leaves export their declared slice, internal cross-leaf names included', () => {
  const snapshot = require('../.ai/bin/protocol-handoff/snapshot.cjs');
  assert.deepEqual(Object.keys(snapshot).sort(), ['anchor', 'checksFor', 'git', 'runCheck'].sort());

  const evidence = require('../.ai/bin/protocol-handoff/evidence.cjs');
  assert.deepEqual(Object.keys(evidence).sort(), [
    'archiveEntryRecords', 'attach', 'canonicalEntryBody', 'DATE_HEADING_M_REGEX',
    'DATE_HEADING_REGEX', 'entryHash', 'ENTRY_HASH_FORMAT', 'findArchivedParent',
    'findParentEntry', 'formatWithEvidence', 'hasEntryHashFormat2', 'newestSection',
    'parseEvidenceBlock', 'readEvidence', 'renderEvidence',
  ].sort());

  const chain = require('../.ai/bin/protocol-handoff/chain.cjs');
  assert.deepEqual(Object.keys(chain).sort(),
    ['checkOwnerReceipt', 'reportOne', 'resolveJournal', 'verifyArchivedChain', 'verifyJournalChain'].sort());

  const gate = require('../.ai/bin/protocol-handoff/gate.cjs');
  assert.deepEqual(Object.keys(gate).sort(), ['gateCheck'].sort());

  // The five re-exported names are the same objects protocol-hooks.cjs defines:
  // re-exported from evidence.cjs, not duplicated.
  const hooks = require('../.ai/bin/protocol-hooks.cjs');
  for (const name of ['DATE_HEADING_REGEX', 'DATE_HEADING_M_REGEX', 'ENTRY_HASH_FORMAT']) {
    assert.equal(evidence[name], hooks[name], `${name} must be the protocol-hooks value`);
  }
  assert.equal(evidence.hasEntryHashFormat2, hooks.hasEntryHashFormat2);
  assert.equal(evidence.canonicalEntryBody, hooks.canonicalEntryBody);
});

test('dispatch leaves export their declared slice, internal cross-leaf names included', () => {
  const procfs = require('../.ai/bin/protocol-dispatch/procfs.cjs');
  assert.deepEqual(Object.keys(procfs).sort(), [
    'checkCommand', 'executorEnv', 'getRepoRoot', 'git', 'gitEnv', 'gitIn', 'gitOpts', 'gitProcessIn',
    'identityOf', 'isPidAlive', 'JOURNAL_RE', 'killExact', 'makePointer', 'overlayClientEnv', 'parsePorcelainZ',
    'readStateRetried', 'snapshotProcesses',
  ].sort());

  const workdir = require('../.ai/bin/protocol-dispatch/workdir.cjs');
  assert.deepEqual(Object.keys(workdir).sort(), [
    'dropWorkdir', 'importResults', 'lsRemoteSnapshot', 'NO_PUSH', 'prepareWorkdir',
    'permissionAudit', 'permissionSnapshot',
    'remoteAuditVerdict', 'scopeCheck', 'scopeViolations', 'workdirState',
  ].sort());

  const registry = require('../.ai/bin/protocol-dispatch/registry.cjs');
  assert.deepEqual(Object.keys(registry).sort(),
    ['clientsProjection', 'ladderSourceDigests', 'loadDispatch', 'loadLadder', 'loadRegistry', 'validateDispatch', 'validateRegistry', 'verifyLadderSectionSha256'].sort());

  const resolver = require('../.ai/bin/protocol-dispatch/resolver.cjs');
  assert.deepEqual(Object.keys(resolver).sort(),
    ['computePins', 'launchLine', 'resolveCommand', 'resolveSlot', 'shadowResolve', 'verifyPins'].sort());

  const clients = require('../.ai/bin/protocol-dispatch/clients.cjs');
  assert.deepEqual(Object.keys(clients).sort(),
    ['buildClientCommand', 'effortArgs', 'formatCommandLine', 'parseUsageFromLog', 'probeAll', 'probeClient'].sort());

  const executor = require('../.ai/bin/protocol-dispatch/executor.cjs');
  assert.deepEqual(Object.keys(executor).sort(), [
    'attemptsNeedingAck', 'checkCompletion', 'chunkIsProgress', 'classifyErrorText', 'emitFallSignal',
    'ERROR_PATTERNS', 'ERROR_TEXT', 'executeAttempt', 'FAILURE_CLASSES', 'forceSettle',
    'leaseStartDecision', 'LeaseWriteError', 'mapClassForRunRecord', 'readLease', 'releaseStartLock',
    'RETRY_TEXT', 'startRefusalDetail', 'startRefusalReason', 'takeStartLock', 'tickIntervalMs', 'updateUsageFile',
    'writeLease', 'writeRepairFile',
  ].sort());

  const cli = require('../.ai/bin/protocol-dispatch/cli.cjs');
  assert.deepEqual(Object.keys(cli).sort(),
    ['acceptSlot', 'checkDispatch', 'reportDispatch', 'runDispatch', 'statusDispatch', 'stopSlot'].sort());
});

test('registry default path still resolves .ai/docs/clients.json one level deeper', () => {
  // loadRegistry's default is anchored on the registry leaf's own __dirname, which
  // moved one directory deeper in the split; the extra '..' keeps it at .ai/docs.
  const registry = require('../.ai/bin/protocol-dispatch/registry.cjs');
  const reg = registry.loadRegistry();
  assert.equal(reg.schema, 'clients/1');
  assert.ok(reg.clients && reg.clients.claude, 'the live registry at .ai/docs/clients.json must load');
});

test('no leaf requires the entry file, protocol-session, protocol-lock or protocol-archive', () => {
  // Leaves may reach protocol-hooks.cjs directly, but never back into the entry
  // file or the lock/session/archive chain (PROTO-DEC-0039 item 3's cycle).
  const fs = require('node:fs');
  const leafDirs = ['.ai/bin/protocol-handoff', '.ai/bin/protocol-dispatch'];
  const forbidden = /require\((['"])(\.\.\/)*(\.\/)?protocol-(session|lock|archive|handoff|dispatch)\.cjs\1\)/;
  for (const dir of leafDirs) {
    for (const name of fs.readdirSync(path.join(repoRoot, dir))) {
      const text = fs.readFileSync(path.join(repoRoot, dir, name), 'utf8');
      assert.doesNotMatch(text, forbidden, `${dir}/${name} must not require a forbidden module`);
    }
  }
});

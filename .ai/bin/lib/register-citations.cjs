'use strict';
// Consumer seam for STATE.mode. Production stays shadow until the reviewed
// switch round supplies an active context from a pinned, verified snapshot.
const F = require('./register-fragments.cjs');
const R = require('./register-reference.cjs');
const L = require('./register-launch-ledger.cjs');
const contexts = new WeakSet();

function isRegisterCitations(value) { return contexts.has(value); }

function createRegisterCitations(options = {}) {
  const mode = options.mode;
  if (mode === undefined || mode === 'shadow') return null;
  F.need(mode === 'active', 'CITE_MODE_INVALID');
  const { snapshot, legacyReader, legacyMapReader } = options;
  F.need(L.isRegisterSnapshot(snapshot), 'CITE_SNAPSHOT_INVALID');
  F.need(typeof legacyReader === 'function' && typeof legacyMapReader === 'function', 'CITE_SOURCE_UNKNOWN');
  const targetSha = snapshot.sha;
  const verify = () => F.need(L.isRegisterSnapshot(snapshot), 'CITE_SNAPSHOT_INVALID');
  const context = Object.freeze({
    sha: targetSha,
    assertTree(tree, issueProofs) {
      verify();
      const inputs = F.readFragmentInputs({ tree, issueProofs });
      F.need(inputs.ok, inputs.diagnostics[0]?.code || 'CITE_SNAPSHOT_INVALID');
      const launches = require('./register-landing.cjs').descriptors(inputs);
      F.need(require('node:util').isDeepStrictEqual(launches, snapshot.launches), 'CITE_SNAPSHOT_INVALID');
      if (snapshot.landing !== null) {
        const entries = require('./register-landing.cjs').readEntries(tree);
        F.need(entries.length === snapshot.landing.byLaunch.size && entries.every(({ record }) =>
          require('node:util').isDeepStrictEqual(record, snapshot.landing.byLaunch.get(record.launchId))), 'CITE_SNAPSHOT_INVALID');
      } else F.need(!tree.has(F.LANDING), 'CITE_SNAPSHOT_INVALID');
    },
    scan(text, settings = {}) {
      verify();
      return R.scanRegisterReferences(text, settings);
    },
    resolve(token, settings = {}) {
      verify();
      F.need(settings.targetSha === undefined || settings.targetSha === targetSha, 'CITE_SOURCE_UNKNOWN');
      const value = R.resolveRegisterReference(token, snapshot, {
        ...settings, targetSha, legacyReader,
        // R2a calls this callback with targetSha. Preserve the source separately.
        legacyMapReader: () => {
          const map = legacyMapReader({ sourceSha: settings.sourceSha, targetSha });
          F.need(map !== null || settings.sourceSha === targetSha, 'CITE_SOURCE_UNKNOWN');
          return map;
        },
      });
      if (value.launchId === null && (settings.expectedPackageId !== undefined || settings.expectedLaunchId !== undefined)) {
        const owners = [...(snapshot.landing?.bySlot.values() || [])].filter(slot =>
          value.processId !== null ? slot.processId === value.processId : slot.itemId === value.itemId);
        F.need(owners.length === 1, 'CITE_FOREIGN');
        const owner = owners[0];
        F.need(settings.expectedPackageId === undefined || owner.packageId === settings.expectedPackageId, 'CITE_FOREIGN');
        F.need(settings.expectedLaunchId === undefined || owner.launchId === settings.expectedLaunchId, 'CITE_FOREIGN');
      }
      return value;
    },
  });
  contexts.add(context);
  return context;
}

module.exports = { createRegisterCitations, isRegisterCitations };

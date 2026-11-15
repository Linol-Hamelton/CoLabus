'use strict';
// Pure typed references. Git reads and the R1 trailer reader are injected.
const F = require('./register-fragments.cjs');
const { maskMarkdown } = require('./text-safe.cjs');
const { need, fail } = F;
function parseRegisterReference(token) {
  need(typeof token === 'string', 'CITE_INVALID');
  if (F.P.test(token)) return { kind: 'process-number', processId: token };
  if (F.OR.test(token)) return { kind: 'item-number', itemId: token };
  const m = /^(L(?!000000)[0-9]{6})(?:-([SI][1-9][0-9]{0,5}))?$/.exec(token);
  need(m, 'CITE_INVALID');
  return { kind: !m[2] ? 'launch' : m[2][0] === 'S' ? 'process-slot' : 'item-slot', launchId: m[1], slot: m[2] || null };
}
function scanRegisterReferences(source, context = {}) {
  need(typeof source === 'string', 'CITE_INVALID');
  let scan = source;
  if (context.kind === 'example' && context.field !== 'structural') {
    const lines = source.split('\n');
    for (const l of maskMarkdown(source).lines) if (l.kinds.some(k => ['fence', 'fence-parity'].includes(k))) lines[l.line - 1] = ' '.repeat(lines[l.line - 1].length);
    scan = lines.join('\n');
  }
  // '-' is part of the launch token: that spelling is malformed, not a range.
  need(!/L[0-9]{6}(?:-[SI][0-9]+)?\s*(?:\.\.|\u2013|\u2014)\s*L[0-9]/.test(scan), 'CITE_RANGE_UNSUPPORTED');
  const result = [];
  const tokens = /[A-Za-z0-9_-]*L[0-9]{3,}[A-Za-z0-9_-]*|(?<![A-Za-z0-9_-])(?:P-(?:[0-9]{2}|[1-9][0-9]{2,3})|OR-[0-9]{4})(?![A-Za-z0-9_])/g;
  for (const m of scan.matchAll(tokens)) {
    const token = m[0];
    if (/^(?:P-|OR-)/.test(token) && !token.includes('L')) {
      const after = scan.slice(m.index + token.length), before = scan.slice(0, m.index);
      if (/^\s*(?:\.\.|[-\u2013\u2014])\s*(?:(?:P-|OR-))?[0-9]/.test(after)
        || /(?:P-|OR-)[0-9]+\s*(?:\.\.|[-\u2013\u2014])\s*$/.test(before)) continue;
    }
    const ref = parseRegisterReference(token);
    result.push({ token, offset: m.index, ref });
  }
  return result;
}
function legacy(ref, context) {
  need(typeof context.sourceSha === 'string' && F.SHA.test(context.sourceSha), 'CITE_SOURCE_UNKNOWN');
  need(typeof context.legacyReader === 'function' && typeof context.legacyMapReader === 'function', 'CITE_SOURCE_UNKNOWN');
  const historical = context.legacyReader(context.sourceSha);
  need(historical && Array.isArray(historical.processIds) && Array.isArray(historical.itemIds), 'CITE_SOURCE_UNKNOWN');
  const isProcess = ref.kind === 'process-number';
  need(!context.processRequired || isProcess, 'CITE_PROCESS_MISSING');
  const id = isProcess ? ref.processId : ref.itemId;
  const ids = isProcess ? historical.processIds : historical.itemIds;
  need(ids.includes(id), 'CITE_SOURCE_UNKNOWN');
  const map = context.legacyMapReader(context.targetSha || context.sourceSha);
  let target = id;
  if (map !== null) {
    try {
      F.keys(map, ['version', 'packages', 'notRewritten']);
      need(map.version === 1 && Array.isArray(map.packages) && Array.isArray(map.notRewritten));
      const commits = new Set();
      for (const pkg of map.packages) {
        F.keys(pkg, ['commit', 'ids']);
        need(typeof pkg.commit === 'string' && F.SHA.test(pkg.commit) && !commits.has(pkg.commit)); commits.add(pkg.commit);
        need(pkg.ids && typeof pkg.ids === 'object' && !Array.isArray(pkg.ids));
        for (const [from, to] of Object.entries(pkg.ids)) {
          need(typeof to === 'string' && (F.P.test(from) && F.P.test(to) || F.OR.test(from) && F.OR.test(to)));
          if (pkg.commit === context.sourceSha && from === id) target = to;
        }
      }
    } catch { fail('CITE_LANDING_INVALID'); }
  }
  return { launchId: null, packageId: null, slot: null, phase: 'landed',
    processId: isProcess ? target : null, itemId: isProcess ? null : target, sourceSha: context.sourceSha };
}
function resolveRegisterReference(input, snapshot, context = {}) {
  // Re-parse structured inputs too: callers cannot relabel an I slot as a P slot.
  const token = typeof input === 'string' ? input : input?.launchId ? `${input.launchId}${input.slot ? '-' + input.slot : ''}` : input?.processId || input?.itemId;
  const ref = parseRegisterReference(token);
  const { isRegisterSnapshot } = require('./register-launch-ledger.cjs');
  need(isRegisterSnapshot(snapshot), 'CITE_SNAPSHOT_INVALID');
  if (['process-number', 'item-number'].includes(ref.kind)) return legacy(ref, context);
  const record = snapshot.launches.get(ref.launchId);
  need(record, 'CITE_LAUNCH_UNKNOWN');
  if (context.expectedPackageId !== undefined) need(record.packageId === context.expectedPackageId, 'CITE_FOREIGN');
  if (context.expectedLaunchId !== undefined) need(ref.launchId === context.expectedLaunchId, 'CITE_FOREIGN');
  let slot = ref.slot;
  if (!slot && context.processRequired) {
    need(record.slots.S.length > 0, 'CITE_PROCESS_MISSING');
    need(record.slots.S.length === 1, 'CITE_AMBIGUOUS');
    slot = record.slots.S[0];
  }
  if (slot) need(record.slots[slot[0]].includes(slot), 'CITE_SLOT_UNKNOWN');
  need(!context.processRequired || slot?.startsWith('S'), 'CITE_PROCESS_MISSING');
  const landed = snapshot.landing?.byLaunch.get(ref.launchId);
  const mapped = slot && landed ? snapshot.landing.bySlot.get(`${ref.launchId}-${slot}`) : null;
  need(!landed || !slot || mapped, 'CITE_LANDING_INVALID');
  return { launchId: ref.launchId, packageId: record.packageId, slot, phase: landed ? 'landed' : 'issued',
    processId: mapped?.processId || null, itemId: mapped?.itemId || null, sourceSha: snapshot.sha };
}
module.exports = { parseRegisterReference, scanRegisterReferences, resolveRegisterReference };

'use strict';
// Pure journal reader and allocation. Publication belongs to the train adapter.
const { TextDecoder } = require('node:util');
const F = require('./register-fragments.cjs');
const T = require('./text-safe.cjs');
const { need, digest } = F;
const MAX_LINE = 1024 * 1024, MAX_FILE = 32 * 1024 * 1024, MAX_TOTAL = 128 * 1024 * 1024;
const ORDER = ['schema', 'landingOrdinal', 'launchId', 'packageId', 'parentSha', 'tipSha', 'issueDigest', 'fragmentDigests', 'processIds', 'itemIds', 'previousEntry'];
const ascii = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const numeric = (a, b) => Number(a.slice(1)) - Number(b.slice(1));
function decode(raw, limit = MAX_FILE) {
  need(Buffer.isBuffer(raw) && raw.length <= limit, 'REGISTER_LIMIT');
  let value;
  try { value = new TextDecoder('utf-8', { fatal: true }).decode(raw); } catch { F.fail('REGISTER_TEXT'); }
  need(!raw.subarray(0, 3).equals(Buffer.from([239, 187, 191])) && !value.includes('\r') && !value.includes('\0'), 'REGISTER_TEXT');
  return value;
}
function json(raw, limit = MAX_FILE) {
  const source = decode(raw, limit);
  let depth = 0, quoted = false, escaped = false;
  for (const ch of source) {
    if (escaped) { escaped = false; continue; }
    if (quoted && ch === '\\') { escaped = true; continue; }
    if (ch === '"') { quoted = !quoted; continue; }
    if (!quoted) {
      if (ch === '{' || ch === '[') need(++depth <= 24, 'REGISTER_LIMIT');
      if (ch === '}' || ch === ']') depth--;
    }
  }
  try { return T.parseJsonUnique(source); } catch { F.fail('REGISTER_SCHEMA'); }
}
function base64(value) {
  need(typeof value === 'string' && value.length <= Math.ceil(MAX_LINE / 3) * 4 && !/[^A-Za-z0-9+/=]/.test(value), 'REGISTER_BASE64');
  const raw = Buffer.from(value, 'base64');
  need(raw.toString('base64') === value, 'REGISTER_BASE64');
  decode(raw, MAX_LINE); return raw;
}
function descriptors(inputs) {
  const launches = new Map([...inputs.launches].map(([id, r]) => [id, {
    packageId: r.packageId, packageLabel: r.packageLabel, slots: { S: [], I: [] }, issueDigest: r.issueDigest, fragmentDigests: {},
  }]));
  for (const f of [...inputs.fragments].sort((a, b) => ascii(a.path, b.path))) {
    const r = launches.get(f.launchId); need(r && r.packageId === f.packageId, 'REGISTER_LANDING_INVALID');
    r.slots[f.kind].push(f.slot); r.fragmentDigests[f.path] = f.digest;
  }
  for (const r of launches.values()) for (const k of ['S', 'I']) r.slots[k].sort(numeric);
  return launches;
}
function allocate(issued, state) {
  const processIds = {}, itemIds = {};
  for (const s of [...issued.slots.S].sort(numeric)) {
    need(++state.p <= 9999, 'REGISTER_EXHAUSTED'); processIds[s] = 'P-' + String(state.p).padStart(2, '0');
  }
  for (const s of [...issued.slots.I].sort(numeric)) {
    need(++state.i <= 9999, 'REGISTER_EXHAUSTED'); itemIds[s] = 'OR-' + String(state.i).padStart(4, '0');
  }
  return { processIds, itemIds };
}
function readEntries(tree) {
  const e = tree.get(F.LANDING); need(e, 'REGISTER_LANDING_UNAVAILABLE');
  const raw = F.bytesOf(e), source = decode(raw);
  need(!source || source.endsWith('\n'), 'REGISTER_LANDING_INVALID');
  const entries = []; let previous = null;
  for (const line of source ? source.slice(0, -1).split('\n') : []) {
    const bytes = Buffer.from(line + '\n');
    need(bytes.length <= MAX_LINE, 'REGISTER_LIMIT');
    const r = json(bytes, MAX_LINE); F.keys(r, ORDER, [], 'REGISTER_LANDING_INVALID');
    need(JSON.stringify(r) === line && Object.keys(r).join() === ORDER.join(), 'REGISTER_LANDING_INVALID');
    need(r.schema === 'register-landing/1' && r.landingOrdinal === entries.length + 1 && r.previousEntry === previous, 'REGISTER_LANDING_INVALID');
    need(F.LAUNCH.test(r.launchId) && F.PACKAGE.test(r.packageId) && F.SHA.test(r.parentSha) && F.SHA.test(r.tipSha), 'REGISTER_LANDING_INVALID');
    previous = digest(bytes); entries.push({ record: r, bytes });
  }
  return entries;
}
function readRegisterLanding({ tree, launches, legacy }) {
  try {
    need(tree instanceof Map && launches instanceof Map && legacy && Array.isArray(legacy.transitions), 'REGISTER_LANDING_INVALID');
    const entries = readEntries(tree), byLaunch = new Map(), bySlot = new Map();
    const state = { p: legacy.initialMaxP, i: legacy.initialItemCount };
    let ordinal = 0, deltaIndex = 0;
    const transitionTips = new Set();
    for (const t of legacy.transitions) {
      F.keys(t, ['parentSha', 'tipSha', 'landingOrdinals', 'deltaPath']);
      need(F.SHA.test(t.parentSha) && F.SHA.test(t.tipSha) && Array.isArray(t.landingOrdinals), 'REGISTER_LANDING_INVALID');
      need(!transitionTips.has(t.tipSha), 'REGISTER_LANDING_INVALID'); transitionTips.add(t.tipSha);
      if (t.deltaPath !== null) {
        const step = legacy.deltas[deltaIndex++];
        need(step && step.path === t.deltaPath && step.parentSha === t.parentSha && step.tipSha === t.tipSha && !t.landingOrdinals.length, 'REGISTER_LANDING_INVALID');
        state.p = Math.max(state.p, step.maxP); state.i += step.addedItems;
      }
      for (const n of t.landingOrdinals) {
        need(n === ++ordinal, 'REGISTER_LANDING_INVALID');
        const r = entries[n - 1]?.record, issued = r && launches.get(r.launchId);
        need(r && issued && !byLaunch.has(r.launchId) && r.parentSha === t.parentSha && r.tipSha === t.tipSha, 'REGISTER_LANDING_INVALID');
        need(r.packageId === issued.packageId && r.issueDigest === issued.issueDigest, 'REGISTER_LANDING_INVALID');
        const expected = allocate(issued, state);
        for (const k of ['processIds', 'itemIds', 'fragmentDigests']) {
          const value = k === 'fragmentDigests' ? issued.fragmentDigests : expected[k];
          need(JSON.stringify(r[k]) === JSON.stringify(value), 'REGISTER_LANDING_INVALID');
        }
        byLaunch.set(r.launchId, r);
        for (const [kind, ids] of [['S', r.processIds], ['I', r.itemIds]]) for (const [slot, id] of Object.entries(ids)) {
          bySlot.set(`${r.launchId}-${slot}`, { launchId: r.launchId, packageId: r.packageId, slot,
            processId: kind === 'S' ? id : null, itemId: kind === 'I' ? id : null });
        }
      }
    }
    need(ordinal === entries.length && deltaIndex === legacy.deltas.length, 'REGISTER_LANDING_INVALID');
    // Legacy additions may not claim numbers already allocated to launch fragments.
    const processIds = new Set(legacy.processRows.keys()), itemIds = new Set(legacy.itemRows.keys());
    for (const r of byLaunch.values()) {
      for (const id of Object.values(r.processIds)) { need(!processIds.has(id), 'REGISTER_LANDING_INVALID'); processIds.add(id); }
      for (const id of Object.values(r.itemIds)) { need(!itemIds.has(id), 'REGISTER_LANDING_INVALID'); itemIds.add(id); }
    }
    return { version: 1, byLaunch, bySlot };
  } catch (e) {
    if (['REGISTER_LIMIT', 'REGISTER_LANDING_UNAVAILABLE', 'REGISTER_EXHAUSTED'].includes(e.code)) throw e;
    F.fail('REGISTER_LANDING_INVALID');
  }
}
function planEntries({ tree, parentSha, candidates, inputs, legacy }) {
  need(F.SHA.test(parentSha) && Array.isArray(candidates), 'REGISTER_PLAN_INVALID');
  const launches = descriptors(inputs), landing = readRegisterLanding({ tree, launches, legacy });
  const old = F.bytesOf(tree.get(F.LANDING));
  const state = { p: Math.max(legacy.maxP, ...[...landing.bySlot.values()].map(r => Number(r.processId?.slice(2)) || 0)),
    i: legacy.itemRows.size + [...landing.bySlot.values()].filter(r => r.itemId).length };
  const ids = new Set(), tips = new Set();
  for (const c of candidates) {
    F.keys(c, ['tipSha', 'launchId'], [], 'REGISTER_PLAN_INVALID');
    need(typeof c.tipSha === 'string' && F.SHA.test(c.tipSha) && typeof c.launchId === 'string' && F.LAUNCH.test(c.launchId), 'REGISTER_PLAN_INVALID');
  }
  const ordered = [...candidates].sort((a, b) => numeric(a.launchId, b.launchId));
  const available = new Set(landing.byLaunch.keys());
  for (const c of ordered) {
    const refs = inputs.fragments.filter(f => f.launchId === c.launchId).flatMap(f => {
      const values = f.kind === 'S' ? f.cells : Object.values(f.item).flat();
      return values.filter(v => typeof v === 'string').flatMap(v => require('./register-reference.cjs').scanRegisterReferences(v, { field: 'structural' }));
    });
    need(refs.every(r => !r.ref.slot || r.ref.launchId === c.launchId || available.has(r.ref.launchId)), 'REGISTER_PLAN_DEPENDENCY');
    available.add(c.launchId);
  }
  let previous = old.length ? digest(Buffer.from(decode(old).trimEnd().split('\n').at(-1) + '\n')) : null;
  const additions = [], transitions = [...legacy.transitions];
  for (const c of ordered) {
    F.keys(c, ['tipSha', 'launchId']);
    need(F.SHA.test(c.tipSha) && F.LAUNCH.test(c.launchId) && !ids.has(c.launchId) && !tips.has(c.tipSha), 'REGISTER_PLAN_INVALID');
    ids.add(c.launchId); tips.add(c.tipSha);
    const issued = launches.get(c.launchId); need(issued, 'REGISTER_PLAN_INVALID');
    const existing = landing.byLaunch.get(c.launchId);
    if (existing) { need(existing.tipSha === c.tipSha, 'REGISTER_LANDING_REPLAY'); continue; }
    const r = { schema: 'register-landing/1', landingOrdinal: landing.byLaunch.size + additions.length + 1,
      launchId: c.launchId, packageId: issued.packageId, parentSha, tipSha: c.tipSha, issueDigest: issued.issueDigest,
      fragmentDigests: issued.fragmentDigests, ...allocate(issued, state), previousEntry: previous };
    const bytes = Buffer.from(JSON.stringify(r) + '\n'); need(bytes.length <= MAX_LINE, 'REGISTER_LIMIT');
    additions.push(bytes); previous = digest(bytes);
    transitions.push({ parentSha, tipSha: c.tipSha, landingOrdinals: [r.landingOrdinal], deltaPath: null });
  }
  const bytes = Buffer.concat([old, ...additions]); need(bytes.length <= MAX_FILE, 'REGISTER_LIMIT');
  return { bytes, additions, transitions };
}
function verifyLandingTransition({ parentTree, resultTree, parentSha, tipSha, proofs, compile, plan }) {
  need(parentTree instanceof Map && resultTree instanceof Map && F.SHA.test(parentSha) && F.SHA.test(tipSha) && typeof compile === 'function' && typeof plan === 'function', 'REGISTER_LANDING_INVALID');
  const before = F.bytesOf(parentTree.get(F.LANDING)), after = F.bytesOf(resultTree.get(F.LANDING));
  need(after.length >= before.length && after.subarray(0, before.length).equals(before), 'REGISTER_LANDING_INVALID');
  const parent = readEntries(parentTree), result = readEntries(resultTree);
  need(result.length >= parent.length, 'REGISTER_LANDING_INVALID');
  const newRows = result.slice(parent.length);
  need(newRows.length === 1 && newRows[0].record.parentSha === parentSha && newRows[0].record.tipSha === tipSha, 'REGISTER_LANDING_INVALID');
  // Every prior register input is immutable. Candidate S/I/issue additions are
  // supplied by the adapter; the journal itself is always recomputed from parent.
  for (const [p, entry] of parentTree) if (F.PREFIXES.some(prefix => p.startsWith(prefix)) || p.startsWith(F.LANDING.slice(0, F.LANDING.lastIndexOf('/') + 1)) && p !== F.LANDING) {
    const current = resultTree.get(p);
    need(current && current.mode === entry.mode && F.bytesOf(current).equals(F.bytesOf(entry)), 'REGISTER_LANDING_INVALID');
  }
  const combined = new Map(resultTree); combined.set(F.LANDING, parentTree.get(F.LANDING));
  const planned = plan({ tree: combined, parentSha, candidates: [{ tipSha, launchId: newRows[0].record.launchId }], proofs });
  need(planned && Buffer.isBuffer(planned.bytes) && planned.bytes.equals(after), 'REGISTER_LANDING_INVALID');
  const expected = compile({ tree: resultTree, proofs });
  need(expected.ok && expected.outputs instanceof Map && expected.outputs.size === F.COMPILED.length && F.COMPILED.every(p => Buffer.isBuffer(expected.outputs.get(p))), 'REGISTER_LANDING_INVALID');
  for (const [p, bytes] of expected.outputs) need(F.bytesOf(resultTree.get(p)).equals(bytes), 'REGISTER_LANDING_INVALID');
  return true;
}
// A plan pins inputs only. It never reserves a number or grants publication.
function planBranch(value) {
  need(typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    && !value.includes('..') && !value.includes('//') && !value.includes('@{')
    && value.split('/').every(part => part && !part.startsWith('.') && !part.endsWith('.') && !part.endsWith('.lock')),
  'REGISTER_PLAN_INVALID');
  return value;
}
function createRegisterPlan({ parentSha, candidates }) {
  need(typeof parentSha === 'string' && F.SHA.test(parentSha) && Array.isArray(candidates) && candidates.length > 0,
    'REGISTER_PLAN_INVALID');
  const branches = new Set(), tips = new Set(), launches = new Set();
  const ordered = candidates.map(c => {
    F.keys(c, ['branch', 'launchId', 'tipSha'], [], 'REGISTER_PLAN_INVALID');
    planBranch(c.branch);
    need(typeof c.tipSha === 'string' && F.SHA.test(c.tipSha) && (c.launchId === null ||
      typeof c.launchId === 'string' && F.LAUNCH.test(c.launchId)), 'REGISTER_PLAN_INVALID');
    need(!branches.has(c.branch) && !tips.has(c.tipSha) && (c.launchId === null || !launches.has(c.launchId)), 'REGISTER_PLAN_INVALID');
    branches.add(c.branch); tips.add(c.tipSha); if (c.launchId !== null) launches.add(c.launchId);
    return { branch: c.branch, launchId: c.launchId, tipSha: c.tipSha };
  }).sort((a, b) => a.launchId === null && b.launchId === null ? ascii(a.tipSha, b.tipSha)
    : a.launchId === null ? -1 : b.launchId === null ? 1 : numeric(a.launchId, b.launchId));
  const body = { schema: 'register-plan/1', parentSha, candidates: ordered };
  const plan = { ...body, digest: digest(Buffer.from(JSON.stringify(body))) };
  need(Buffer.byteLength(JSON.stringify(plan) + '\n') <= MAX_FILE, 'REGISTER_LIMIT');
  return plan;
}
function readRegisterPlan(raw) {
  const r = json(raw); F.keys(r, ['schema', 'parentSha', 'candidates', 'digest'], [], 'REGISTER_PLAN_INVALID');
  need(r.schema === 'register-plan/1', 'REGISTER_PLAN_INVALID');
  const expected = createRegisterPlan(r);
  need(raw.equals(Buffer.from(JSON.stringify(expected) + '\n')), 'REGISTER_PLAN_INVALID');
  return expected;
}
function verifyRegisterPlanPins({ plan, parentSha, candidates }) {
  // Re-read live Git inputs at the adapter, including every tip in the plan.
  const recorded = readRegisterPlan(Buffer.from(JSON.stringify(plan) + '\n'));
  const current = createRegisterPlan({ parentSha, candidates });
  need(recorded.digest === current.digest, 'REGISTER_PLAN_MOVED');
  return recorded;
}
const SHADOW_ORDER = ['schema', 'parentSha', 'tipSha', 'inputDigest', 'expected', 'actual', 'differentPaths', 'previousEntry'];
const viewPaths = () => [...F.COMPILED].sort(ascii);
function shadowHashes(outputs) {
  need(outputs instanceof Map && outputs.size === F.COMPILED.length, 'REGISTER_SHADOW_INVALID');
  return Object.fromEntries(viewPaths().map(p => {
    const raw = outputs.get(p); need(Buffer.isBuffer(raw) && raw.length <= MAX_FILE, 'REGISTER_SHADOW_INVALID');
    return [p, digest(raw)];
  }));
}
function shadowRecord({ parentSha, tipSha, inputDigest, expected, actual }, previousEntry) {
  need(typeof parentSha === 'string' && F.SHA.test(parentSha) && typeof tipSha === 'string' && F.SHA.test(tipSha)
    && typeof inputDigest === 'string' && F.DIGEST.test(inputDigest), 'REGISTER_SHADOW_INVALID');
  const expectedHashes = shadowHashes(expected), actualHashes = shadowHashes(actual);
  const differentPaths = viewPaths().filter(p => !expected.get(p).equals(actual.get(p)));
  return { schema: 'register-shadow/1', parentSha, tipSha, inputDigest,
    expected: expectedHashes, actual: actualHashes, differentPaths, previousEntry };
}
function readShadow(raw) {
  const source = decode(raw); need(!source || source.endsWith('\n'), 'REGISTER_SHADOW_INVALID');
  const entries = [], tips = new Set(); let previous = null;
  for (const line of source ? source.slice(0, -1).split('\n') : []) {
    const bytes = Buffer.from(line + '\n'), r = json(bytes, MAX_LINE);
    F.keys(r, SHADOW_ORDER, [], 'REGISTER_SHADOW_INVALID');
    need(r.schema === 'register-shadow/1' && Object.keys(r).join() === SHADOW_ORDER.join()
      && line === JSON.stringify(r) && previous === r.previousEntry, 'REGISTER_SHADOW_INVALID');
    need(typeof r.parentSha === 'string' && F.SHA.test(r.parentSha) && typeof r.tipSha === 'string' && F.SHA.test(r.tipSha)
      && typeof r.inputDigest === 'string' && F.DIGEST.test(r.inputDigest) && !tips.has(r.tipSha), 'REGISTER_SHADOW_INVALID');
    for (const k of ['expected', 'actual']) {
      F.keys(r[k], viewPaths(), [], 'REGISTER_SHADOW_INVALID');
      need(Object.keys(r[k]).join() === viewPaths().join() && Object.values(r[k]).every(v =>
        typeof v === 'string' && F.DIGEST.test(v)), 'REGISTER_SHADOW_INVALID');
    }
    need(Array.isArray(r.differentPaths) && JSON.stringify(r.differentPaths) === JSON.stringify(viewPaths().filter(p =>
      r.expected[p] !== r.actual[p])), 'REGISTER_SHADOW_INVALID');
    entries.push({ record: r, bytes }); tips.add(r.tipSha); previous = digest(bytes);
  }
  return entries;
}
function planShadow({ raw, ...observation }) {
  const entries = readShadow(raw), existing = entries.find(e => e.record.tipSha === observation.tipSha);
  const previous = existing ? existing.record.previousEntry : entries.length ? digest(entries.at(-1).bytes) : null;
  const record = shadowRecord(observation, previous), bytes = Buffer.from(JSON.stringify(record) + '\n');
  need(bytes.length <= MAX_LINE, 'REGISTER_LIMIT');
  if (existing) {
    need(existing.bytes.equals(bytes), 'REGISTER_SHADOW_REPLAY');
    return { bytes: Buffer.from(raw), appended: false, record };
  }
  const result = Buffer.concat([raw, bytes]); need(result.length <= MAX_FILE, 'REGISTER_LIMIT');
  return { bytes: result, appended: true, record };
}
// Only the Git/compile adapter supplies these transitions. Rebuild every
// observation from its pinned inputs; a well-formed chain alone proves nothing.
function verifyShadowTransitions({ raw, transitions }) {
  const entries = readShadow(raw);
  need(Array.isArray(transitions) && entries.length === transitions.length, 'REGISTER_SHADOW_INVALID');
  const resultShas = new Set(); let previous = null;
  const stats = { attempted: 0, clean: 0, divergent: 0, cleanStreak: 0,
    coverage: { 'PROCESS-only': 0, 'OPEN-only': 0, 'PROCESS+OPEN': 0, renumber: 0 } };
  for (let i = 0; i < transitions.length; i++) {
    const t = transitions[i];
    F.keys(t, ['parentSha', 'tipSha', 'resultSha', 'inputDigest', 'expected', 'actual', 'parentViews', 'renumberMessage'], [], 'REGISTER_SHADOW_INVALID');
    need(typeof t.resultSha === 'string' && F.SHA.test(t.resultSha) && !resultShas.has(t.resultSha), 'REGISTER_SHADOW_INVALID');
    resultShas.add(t.resultSha);
    const record = shadowRecord(t, previous), bytes = Buffer.from(JSON.stringify(record) + '\n');
    need(entries[i].bytes.equals(bytes), 'REGISTER_SHADOW_INVALID'); previous = digest(bytes);
    shadowHashes(t.parentViews);
    need(typeof t.renumberMessage === 'string', 'REGISTER_SHADOW_INVALID');
    let receipt;
    try { receipt = require('./register-renumber.cjs').readRenumber(t.renumberMessage); }
    catch { F.fail('REGISTER_SHADOW_INVALID'); }
    const renumber = receipt?.version === 2 ? { version: 1, ...receipt.legacy } : receipt;
    if (renumber !== null) {
      F.keys(renumber, ['version', 'packages', 'notRewritten'], [], 'REGISTER_SHADOW_INVALID');
      need(renumber.version === 1 && Array.isArray(renumber.packages) && Array.isArray(renumber.notRewritten), 'REGISTER_SHADOW_INVALID');
      const commits = new Set();
      for (const pkg of renumber.packages) {
        F.keys(pkg, ['commit', 'ids'], [], 'REGISTER_SHADOW_INVALID');
        need(typeof pkg.commit === 'string' && F.SHA.test(pkg.commit) && !commits.has(pkg.commit)
          && pkg.ids !== null && typeof pkg.ids === 'object' && !Array.isArray(pkg.ids), 'REGISTER_SHADOW_INVALID'); commits.add(pkg.commit);
        for (const [from, to] of Object.entries(pkg.ids)) need(typeof to === 'string' && from !== to
          && (F.P.test(from) && F.P.test(to) || F.OR.test(from) && F.OR.test(to)), 'REGISTER_SHADOW_INVALID');
      }
    }
    stats.attempted++;
    if (record.differentPaths.length) {
      stats.divergent++; stats.cleanStreak = 0;
      for (const k of Object.keys(stats.coverage)) stats.coverage[k] = 0;
      continue;
    }
    stats.clean++; stats.cleanStreak++;
    const process = !t.parentViews.get(F.COMPILED[0]).equals(t.actual.get(F.COMPILED[0]));
    const open = !t.parentViews.get(F.COMPILED[1]).equals(t.actual.get(F.COMPILED[1]));
    if (process && open) stats.coverage['PROCESS+OPEN']++;
    else if (process) stats.coverage['PROCESS-only']++;
    else if (open) stats.coverage['OPEN-only']++;
    if ((process || open) && renumber && renumber.packages.some(p => Object.keys(p.ids).length > 0)) stats.coverage.renumber++;
  }
  return stats;
}
function shadowReadiness({ raw, transitions }) {
  const stats = verifyShadowTransitions({ raw, transitions });
  return { stats, shadowReady: stats.cleanStreak >= 20 && Object.values(stats.coverage).every(n => n >= 5),
    switchRequires: ['migration-roundtrip-3/3', 'historical-distinct-triples>=20-with-replay-3/3',
      'zero-unexpected-process-conflicts', 'mixed-plan-scratch-retry', 'two-farm-hosts-identical-three-hashes', 'R2c-owner-switch'] };
}
module.exports = { MAX_LINE, MAX_FILE, MAX_TOTAL, ORDER, ascii, numeric, decode, json, base64, descriptors, allocate,
  readEntries, readRegisterLanding, planEntries, verifyLandingTransition, planBranch, createRegisterPlan, readRegisterPlan,
  verifyRegisterPlanPins, SHADOW_ORDER, shadowHashes, readShadow, planShadow, verifyShadowTransitions, shadowReadiness };

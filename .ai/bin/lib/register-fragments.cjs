'use strict';
// register-*/1: pure bytes/tree validation. A tree is Map<path,{mode,bytes}>;
// bytes may be a lazy () => Buffer supplied by the Git boundary. No ambient I/O.
const crypto = require('node:crypto');
const text = require('./text-safe.cjs');
const hardening = require('./register-hardening.cjs');
const { parseVersion, releaseParts, compareVersions } = require('./protocol-version.cjs');
const MAX_BYTES = 65536;
const REGISTER_STATUSES = Object.freeze(['implemented', 'partial', 'proposed', 'retired']);
const SHA = /^[a-f0-9]{40}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const PACKAGE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const LABEL = /^(?:[A-Z0-9][A-Z0-9-]{0,63}|none)$/;
const LAUNCH = /^L(?!000000)[0-9]{6}$/;
const SLOT = /^[SI][1-9][0-9]{0,5}$/;
const P = /^P-(?:[0-9]{2}|[1-9][0-9]{2,3})$/;
const OR = /^OR-[0-9]{4}$/;
const LAYERS = new Set(['release', 'product', 'package-finding', 'carried', 'temp-hygiene', 'process', 'operator', 'docs', 'review', 'backlog', 'test', 'VOICE',
  'L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'X-CLEANUP', 'X-DOCS', 'X-GOVERNANCE', 'X-MACHINES', 'X-MCP', 'X-OPERATOR', 'X-PILOTS',
  'X-PRODUCT', 'X-SECURITY', 'X-SELECTION', 'X-TOPOLOGY']);
const PREFIXES = ['docs/ops/register-launches/', 'docs/ops/process/fragments/', 'docs/ops/open/fragments/'];
const COMPILED = ['docs/ops/PROCESS-REGISTER.md', 'docs/ops/OPEN-REGISTER.json', 'docs/ops/OPEN-REGISTER-TABLE.md'];
const LANDING = 'docs/ops/register/LANDING.jsonl';
const fail = code => { const e = new Error(code); e.code = code; throw e; };
const need = (value, code = 'FRAGMENT_SCHEMA') => { if (!value) fail(code); };
const digest = bytes => 'sha256:' + crypto.createHash('sha256').update(bytes).digest('hex');
const plain = v => v !== null && typeof v === 'object' && !Array.isArray(v) && [null, Object.prototype].includes(Object.getPrototypeOf(v));
function keys(v, required, optional = [], code = 'FRAGMENT_SCHEMA') {
  need(plain(v) && required.every(k => Object.hasOwn(v, k)) && Object.keys(v).every(k => required.includes(k) || optional.includes(k)), code);
}
function scalar(v, empty = false) {
  need(typeof v === 'string' && (empty || v.length > 0), 'FRAGMENT_TEXT');
  need(v === v.normalize('NFC') && !/[\p{Cc}\p{Cs}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\p{Cf}\u00a0\u2007\u202f]/u.test(v), 'FRAGMENT_TEXT');
}
function strings(v, nonempty = false) {
  need(Array.isArray(v) && (!nonempty || v.length > 0));
  v.forEach(s => scalar(s));
  need(new Set(v).size === v.length, 'FRAGMENT_DUPLICATE');
}
function calendar(v) {
  return typeof v === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v)
    && Number.isFinite(Date.parse(v)) && new Date(v).toISOString().slice(0, 10) === v;
}
function decode(bytes) {
  need(Buffer.isBuffer(bytes) && bytes.length <= MAX_BYTES, 'FRAGMENT_TEXT');
  const d = text.decode(bytes, { bom: 'refuse', crlf: 'refuse', invisible: 'refuse', finalNewline: 'refuse' });
  need(d.ok && !d.notes.some(p => p.code === 'NOT_NFC') && d.text.endsWith('\n') && !d.text.endsWith('\n\n'), 'FRAGMENT_TEXT');
  need(!/[\p{Default_Ignorable_Code_Point}\p{Cf}\p{Cs}]/u.test(d.text), 'FRAGMENT_TEXT');
  return d.text;
}
function json(bytes) {
  let v;
  try { v = text.parseJsonUnique(decode(bytes)); } catch (e) { fail(e.code === 'FRAGMENT_TEXT' ? e.code : 'FRAGMENT_SCHEMA'); }
  const walk = (x, depth = 0) => {
    need(depth <= 24);
    if (typeof x === 'string') scalar(x, true);
    else if (Array.isArray(x)) x.forEach(y => walk(y, depth + 1));
    else if (plain(x)) for (const [k, y] of Object.entries(x)) { scalar(k); walk(y, depth + 1); }
    else need(x === null || typeof x === 'boolean' || (typeof x === 'number' && Number.isSafeInteger(x)));
  };
  walk(v);
  return v;
}
function bytesOf(entry) {
  need(entry && entry.mode === '100644', 'FRAGMENT_PATH');
  const b = typeof entry.bytes === 'function' ? entry.bytes() : entry.bytes;
  need(Buffer.isBuffer(b), 'FRAGMENT_TEXT');
  return b;
}
function readLaunch(bytes, file) {
  try {
    const r = json(bytes);
    keys(r, ['schema', 'launchId', 'packageId', 'packageLabel', 'baseSha', 'ordinal', 'issuedAt', 'provenance']);
    ['schema', 'launchId', 'packageId', 'packageLabel', 'baseSha', 'issuedAt'].forEach(k => scalar(r[k]));
    need(r.schema === 'register-launch/1' && LAUNCH.test(r.launchId) && PACKAGE.test(r.packageId) && LABEL.test(r.packageLabel));
    need(Number.isInteger(r.ordinal) && r.ordinal === Number(r.launchId.slice(1)) && SHA.test(r.baseSha));
    need(typeof r.issuedAt === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(r.issuedAt)
      && Number.isFinite(Date.parse(r.issuedAt)) && new Date(r.issuedAt).toISOString() === r.issuedAt);
    keys(r.provenance, ['owner', 'ownerAct', 'previousRecord']);
    scalar(r.provenance.owner); scalar(r.provenance.ownerAct);
    need(/^[A-Za-z0-9._-]{1,128}$/.test(r.provenance.owner) && r.provenance.ownerAct.trim().length > 0 && r.provenance.ownerAct.length <= 1024);
    need(r.ordinal === 1 ? r.provenance.previousRecord === null : DIGEST.test(r.provenance.previousRecord));
    need(file === `docs/ops/register-launches/${r.launchId}.json`);
    return r;
  } catch { fail('LAUNCH_LEDGER_INVALID'); }
}
function verifyIssueProofOffline({ bytes, path, proof }) {
  try {
    keys(proof, ['launchId', 'recordDigest', 'issueCommit', 'bootstrapSha']);
    need(LAUNCH.test(proof.launchId) && DIGEST.test(proof.recordDigest) && SHA.test(proof.issueCommit) && SHA.test(proof.bootstrapSha));
    need(digest(bytes) === proof.recordDigest);
    const record = readLaunch(bytes, path);
    need(record.launchId === proof.launchId);
    return record;
  } catch { fail('LAUNCH_PROVENANCE_MISSING'); }
}
function parseFragment(path, bytes) {
  let value; let cells = null; let kind;
  const pm = /^docs\/ops\/process\/fragments\/(L[0-9]{6})-(S[1-9][0-9]{0,5})\.md$/.exec(path);
  const im = /^docs\/ops\/open\/fragments\/(L[0-9]{6})-(I[1-9][0-9]{0,5})\.json$/.exec(path);
  need(pm || im, 'FRAGMENT_PATH');
  if (pm) {
    kind = 'S';
    const lines = decode(bytes).split('\n');
    need(lines.length === 5 && lines[0] === '<!-- register-process/1' && lines[2] === '-->', 'FRAGMENT_TEXT');
    try { value = json(Buffer.from(lines[1] + '\n')); } catch { fail('FRAGMENT_SCHEMA'); }
    keys(value, ['schema', 'launchId', 'packageId', 'slot']);
    need(value.schema === 'register-process/1');
    const row = lines[3];
    need(row.startsWith('| ') && row.endsWith(' |'), 'FRAGMENT_TEXT');
    cells = row.slice(2, -2).split(' | ');
    need(cells.length === 9 && cells.every(c => c.length && c === c.trim() && !/[|\r\n]/.test(c)), 'FRAGMENT_TEXT');
    cells.forEach(c => scalar(c));
    const kinds = text.maskMarkdown(row).lines[0].kinds;
    need(kinds.every(k => ['table', 'code-span', 'inline-link', 'html-inline-tag'].includes(k))
      && !/<\/?summary(?:\s|\/?>)/i.test(row), 'FRAGMENT_TEXT');
    // Unpaired delimiters are data-loss signals, not a request to mask the row.
    for (const cell of cells) {
      need((cell.match(/`/g) || []).length % 2 === 0 && !/```|~~~/.test(cell), 'FRAGMENT_TEXT');
      for (let i = 0; i < cell.length; i++) if (cell[i] === '[') {
        const link = text.readInlineLink(cell, i);
        need(link !== null, 'FRAGMENT_TEXT'); i = link.end - 1;
      }
    }
    need(calendar(cells[2]) && REGISTER_STATUSES.includes(cells[8]));
    need(cells[0] === `${value.launchId}-${value.slot}`, 'FRAGMENT_ID_MISMATCH');
  } else {
    kind = 'I'; value = json(bytes);
    keys(value, ['schema', 'launchId', 'packageId', 'slot', 'item']);
    need(value.schema === 'register-open/1');
    const it = value.item;
    keys(it, ['id', 'sourceKey', 'sourceIds', 'title', 'status', 'statusAsOf', 'class', 'layer', 'ownerAct', 'target', 'package'],
      ['statusProof', 'dependsOn', 'nextStep', 'note', 'evidence', 'hardening']);
    for (const [k, v] of Object.entries(it)) {
      if (k === 'hardening') need(hardening.validate(v).length === 0, 'FRAGMENT_SCHEMA');
      else if (['sourceIds', 'dependsOn'].includes(k)) strings(v, k === 'sourceIds');
      else if (k === 'ownerAct') need(typeof v === 'boolean');
      else if (k === 'evidence' && Array.isArray(v)) v.forEach(s => scalar(s, true));
      else scalar(v, k === 'target' || ['nextStep', 'note', 'evidence'].includes(k));
    }
    need(!JSON.stringify(it).match(/[<>&]/), 'FRAGMENT_TEXT');
    need(it.title.trim().length > 0);
    need(['open', 'partial', 'unknown', 'closed', 'withdrawn'].includes(it.status) && calendar(it.statusAsOf) && ['A', 'B'].includes(it.class));
    need(LAYERS.has(it.layer));
    need(it.id === `${value.launchId}-${value.slot}`, 'FRAGMENT_ID_MISMATCH');
  }
  const m = pm || im;
  ['launchId', 'packageId', 'slot'].forEach(k => scalar(value[k]));
  need(LAUNCH.test(value.launchId) && PACKAGE.test(value.packageId) && SLOT.test(value.slot));
  need(value.launchId === m[1] && value.slot === m[2], 'FRAGMENT_ID_MISMATCH');
  return { path, kind, ...value, cells, digest: digest(bytes) };
}
function same(a, b) {
  return !a && !b || Boolean(a && b && a.mode === b.mode && bytesOf(a).equals(bytesOf(b)));
}
function checkPackageWrites({ baseTree, tree }) {
  need(baseTree instanceof Map && tree instanceof Map);
  const paths = new Set([...COMPILED, LANDING, ...baseTree.keys(), ...tree.keys()].filter(p =>
    COMPILED.includes(p) || p.toLowerCase().startsWith('docs/ops/register/')));
  return [...paths].sort().filter(p => !same(baseTree.get(p), tree.get(p))).map(path => ({
    path, code: COMPILED.includes(path) ? 'REGISTER_COMPILED_EDIT' : 'REGISTER_LANDING_WRITER',
  }));
}
const normalized = new WeakMap();
const fragmentInputs = new WeakMap();
const inputState = r => digest(Buffer.from(JSON.stringify([r.diagnostics, r.fragments, [...r.launches]])));
function projectRegisterValue(value, landing) {
  if (typeof value === 'string') {
    const refs = require('./register-reference.cjs').scanRegisterReferences(value, { field: 'structural' });
    let result = value;
    for (const ref of refs.reverse()) if (ref.ref.slot) {
      const mapped = landing.bySlot.get(ref.token);
      need(mapped, 'REGISTER_REFERENCE');
      const replacement = ref.ref.slot[0] === 'S' ? mapped.processId : mapped.itemId;
      need(replacement, 'REGISTER_REFERENCE');
      result = result.slice(0, ref.offset) + replacement + result.slice(ref.offset + ref.token.length);
    }
    return result;
  }
  if (Array.isArray(value)) return value.map(v => projectRegisterValue(v, landing));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, k === 'hardening' ? structuredClone(v) : projectRegisterValue(v, landing)]));
  return value;
}
function normalizeRegisterBaseline({ compiled, legacy, landing, fragments }) {
  const { isDeepStrictEqual: equal } = require('node:util');
  need(compiled && legacy && Array.isArray(compiled.items) && Array.isArray(legacy.items) && landing?.bySlot instanceof Map && Array.isArray(fragments), 'REGISTER_PROJECTION');
  const expected = new Map(legacy.items.map(it => [it.id, it])), reverse = new Map();
  need(expected.size === legacy.items.length, 'REGISTER_PROJECTION');
  for (const f of fragments.filter(f => f.kind === 'I')) {
    const key = `${f.launchId}-${f.slot}`, mapped = landing.bySlot.get(key);
    if (!mapped) continue;
    const projected = projectRegisterValue(f.item, landing);
    need(mapped.itemId === projected.id && !expected.has(projected.id), 'REGISTER_PROJECTION');
    expected.set(projected.id, projected); reverse.set(projected.id, key);
  }
  need(expected.size === compiled.items.length, 'REGISTER_PROJECTION');
  const seen = new Set();
  for (const it of compiled.items) {
    need(!seen.has(it.id) && expected.has(it.id) && equal(it, expected.get(it.id)), 'REGISTER_PROJECTION'); seen.add(it.id);
  }
  // Legacy nodes remain exactly once. Landed fragments are added once by the relation pass.
  const baseline = { ...legacy, items: legacy.items.map(it => ({ ...it,
    ...(it.dependsOn ? { dependsOn: it.dependsOn.map(id => reverse.get(id) || id) } : {}) })) };
  normalized.set(baseline, { hash: digest(Buffer.from(JSON.stringify(baseline))), reverse }); return baseline;
}
function readFragmentInputs({ tree, issueProofs }) {
  const diagnostics = []; const fragments = []; const launches = new Map();
  const add = (path, code) => diagnostics.push({ path: String(path).replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, c => `\\u${c.codePointAt(0).toString(16).padStart(4, '0')}`), code });
  const attempt = (path, fn) => { try { return fn(); } catch (e) { add(path, e.code || 'FRAGMENT_SCHEMA'); } };
  attempt('', () => {
    need(tree instanceof Map && [...tree.keys()].every(p => typeof p === 'string'));
    need(issueProofs instanceof Map, 'LAUNCH_PROVENANCE_MISSING');
  });
  if (diagnostics.length) return { ok: false, diagnostics, fragments, launches };
  const paths = [...tree.keys()].filter(p => PREFIXES.some(prefix => p.toLowerCase().startsWith(prefix))).sort();
  const folded = new Set();
  for (const path of paths) attempt(path, () => {
    need(!folded.has(path.toLowerCase()), 'FRAGMENT_DUPLICATE'); folded.add(path.toLowerCase());
    const bytes = bytesOf(tree.get(path));
    if (path.startsWith(PREFIXES[0])) {
      const r = readLaunch(bytes, path);
      verifyIssueProofOffline({ bytes, path, proof: issueProofs.get(r.launchId) });
      need(!launches.has(r.launchId) && ![...launches.values()].some(v => v.packageId === r.packageId), 'FRAGMENT_DUPLICATE');
      launches.set(r.launchId, { ...r, issueDigest: digest(bytes) });
    } else fragments.push(parseFragment(path, bytes));
  });
  fragments.sort((a, b) => Number(a.launchId.slice(1)) - Number(b.launchId.slice(1)) || (a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0) || Number(a.slot.slice(1)) - Number(b.slot.slice(1)));
  const result = { ok: diagnostics.length === 0, diagnostics, fragments, launches };
  fragmentInputs.set(result, { tree, digest: inputState(result) }); return result;
}
function validateFragmentRelations({ tree, baseTree, mode, packageId, launchId, issueProofs, schemaState, proofReader, inputs, logicalBaseline }) {
  const { fragments, launches } = inputs;
  const diagnostics = [...inputs.diagnostics];
  const inputProblems = diagnostics.length;
  const add = (path, code) => diagnostics.push({ path, code });
  const attempt = (path, fn) => { try { return fn(); } catch (e) { add(path, e.code || 'FRAGMENT_SCHEMA'); } };
  attempt('', () => {
    need(fragmentInputs.get(inputs)?.tree === tree && fragmentInputs.get(inputs)?.digest === inputState(inputs), 'REGISTER_INPUT');
    need(['package', 'line'].includes(mode) && ['pre-migration', 'active'].includes(schemaState));
    if (mode === 'package') need(baseTree instanceof Map && PACKAGE.test(packageId) && LAUNCH.test(launchId));
    if (schemaState === 'active') need(tree.has(LANDING) && logicalBaseline && normalized.get(logicalBaseline)?.hash === digest(Buffer.from(JSON.stringify(logicalBaseline))), 'REGISTER_LANDING_UNAVAILABLE');
  });
  if (diagnostics.length > inputProblems) return { ok: false, diagnostics, fragments, launches };
  if (mode === 'package') {
    diagnostics.push(...checkPackageWrites({ baseTree, tree }));
    const changed = new Set([...baseTree.keys(), ...tree.keys()]);
    for (const path of [...changed].sort()) if (PREFIXES.some(p => path.toLowerCase().startsWith(p)) && !same(baseTree.get(path), tree.get(path))) attempt(path, () => {
      need(!baseTree.has(path), 'FRAGMENT_IMMUTABLE');
      const own = path === `${PREFIXES[0]}${launchId}.json` || fragments.some(f => f.path === path && f.launchId === launchId && f.packageId === packageId);
      need(own, 'FRAGMENT_FOREIGN');
      const issued = launches.get(launchId);
      need(issued && issued.packageId === packageId, 'FRAGMENT_FOREIGN');
      need(!baseTree.has(`${PREFIXES[0]}${launchId}.json`), 'FRAGMENT_IMMUTABLE');
    });
  }
  if (inputProblems) {
    diagnostics.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
    return { ok: false, diagnostics, fragments, launches };
  }
  let baseline = logicalBaseline;
  if (!baseline) attempt(COMPILED[1], () => {
    const b = tree.get(COMPILED[1]); need(b, 'FRAGMENT_REFERENCE');
    // Legacy registers can exceed the per-fragment cap; never truncate them.
    const raw = bytesOf(b); baseline = text.parseJsonUnique(new TextDecoder('utf-8', { fatal: true }).decode(raw));
    need(Array.isArray(baseline.sources) && Array.isArray(baseline.items), 'FRAGMENT_REFERENCE');
  });
  let version;
  attempt('protocol-manifest.json', () => {
    const entry = tree.get('protocol-manifest.json'); need(entry, 'FRAGMENT_REFERENCE');
    version = text.parseJsonUnique(bytesOf(entry).toString('utf8')).protocolVersion;
    need(parseVersion(version), 'FRAGMENT_REFERENCE');
  });
  const byId = new Map(); const legacySources = (baseline?.items || []).flatMap(it => it.sourceIds || []);
  const sources = new Set(legacySources);
  attempt(COMPILED[1], () => need(sources.size === legacySources.length && new Set((baseline?.items || []).map(it => it.id)).size === (baseline?.items || []).length, 'FRAGMENT_DUPLICATE'));
  const graph = new Map((baseline?.items || []).map(it => [it.id, it.dependsOn || []]));
  for (const f of fragments) attempt(f.path, () => {
    const id = `${f.launchId}-${f.slot}`; const r = launches.get(f.launchId);
    need(r && r.packageId === f.packageId, 'FRAGMENT_ID_MISMATCH');
    need(!byId.has(id), 'FRAGMENT_DUPLICATE'); byId.set(id, f);
    if (f.kind === 'S') {
      if (['implemented', 'partial'].includes(f.cells[8])) {
        for (const p of new Set(`${f.cells[4]} ${f.cells[5]}`.match(/(?:docs|\.ai|\.kilo|tests)\/[A-Za-z0-9._\/-]+\.(?:md|cjs|json)/g) || [])) need(tree.has(p), 'FRAGMENT_REFERENCE');
      }
    } else {
      const it = f.item;
      need(it.package === r.packageLabel, 'FRAGMENT_ID_MISMATCH');
      need(['KDR14', 'RR201', 'PROC', 'BACKLOG', 'OPMEM', 'DOCS', 'REV'].includes(it.sourceKey) && baseline && baseline.sources.some(s => s.key === it.sourceKey), 'FRAGMENT_REFERENCE');
      for (const sid of it.sourceIds) {
        need(/^[A-Z0-9]+:[A-Za-z0-9._-]+$/.test(sid) && baseline.sources.some(s => sid.startsWith(s.key + ':')), 'FRAGMENT_REFERENCE');
        need(!sources.has(sid), 'FRAGMENT_DUPLICATE'); sources.add(sid);
      }
      if (['closed', 'withdrawn'].includes(it.status)) {
        need(it.target === '' && typeof it.statusProof === 'string', 'FRAGMENT_REFERENCE');
        const fileProof = !it.statusProof.includes('..') && tree.has(it.statusProof) && tree.get(it.statusProof).mode === '100644';
        if (fileProof) bytesOf(tree.get(it.statusProof));
        const commit = /^commit ([a-f0-9]{40})(?:\s|$)/.exec(it.statusProof);
        need(fileProof || Boolean(commit && typeof proofReader === 'function' && proofReader(commit[1]) === true), 'FRAGMENT_REFERENCE');
      } else if (it.target !== 'later') {
        need(parseVersion(version) && releaseParts(it.target), 'FRAGMENT_REFERENCE');
        need(compareVersions(it.target, version) >= 0, 'FRAGMENT_REFERENCE');
      }
      graph.set(id, (it.dependsOn || []).map(d => normalized.get(logicalBaseline)?.reverse.get(d) || d));
    }
  });
  for (const f of fragments) attempt(f.path, () => {
    const values = f.kind === 'S' ? f.cells : Object.values(f.item).flat();
    for (const value of values) if (typeof value === 'string') for (const { ref } of require('./register-reference.cjs').scanRegisterReferences(value, { field: 'structural' })) {
      need(!ref.launchId || launches.has(ref.launchId) && (!ref.slot || byId.has(`${ref.launchId}-${ref.slot}`)), 'REGISTER_REFERENCE');
    }
    if (f.kind === 'I' && f.item.sourceKey === 'PROC') {
      need(f.item.sourceIds.length === 1 && /^PROC:L[0-9]{6}-S[1-9][0-9]{0,5}$/.test(f.item.sourceIds[0]), 'FRAGMENT_PROC_COVERAGE');
      const process = byId.get(f.item.sourceIds[0].slice(5));
      need(process && process.kind === 'S' && process.launchId === f.launchId && process.packageId === f.packageId, 'FRAGMENT_PROC_COVERAGE');
    }
    if (f.kind === 'S') {
      const count = fragments.filter(it => it.kind === 'I' && it.item.sourceKey === 'PROC' && it.item.sourceIds.includes(`PROC:${f.launchId}-${f.slot}`)).length;
      need(f.cells[8] === 'proposed' ? count === 1 : count <= 1, 'FRAGMENT_PROC_COVERAGE');
    }
  });
  // Dependencies belong to the merged graph, including legacy components
  // that are not reachable from this package's own items.
  for (const id of graph.keys()) attempt(byId.get(id)?.path || COMPILED[1], () => {
      const visit = start => {
        const active = new Set(), done = new Set(), pending = [[start, false]];
        while (pending.length) {
          const [node, exit] = pending.pop();
          if (exit) { active.delete(node); done.add(node); continue; }
          need(!active.has(node), 'FRAGMENT_DEPENDENCY');
          if (done.has(node)) continue;
          active.add(node); pending.push([node, true]);
          for (const d of graph.get(node) || []) {
            need(graph.has(d) && (OR.test(d) || /^L(?!000000)[0-9]{6}-I[1-9][0-9]{0,5}$/.test(d)), 'FRAGMENT_DEPENDENCY');
            pending.push([d, false]);
          }
        }
      };
      visit(id);
  });
  diagnostics.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  return { ok: diagnostics.length === 0, diagnostics, fragments, launches };
}
function validateFragments(options) {
  const inputs = readFragmentInputs(options);
  let logicalBaseline;
  if (options.schemaState === 'active') {
    try {
      need(options.projectionContext, 'REGISTER_LANDING_UNAVAILABLE');
      const compiled = text.parseJsonUnique(bytesOf(options.tree.get(COMPILED[1])).toString('utf8'));
      logicalBaseline = normalizeRegisterBaseline({ compiled, ...options.projectionContext, fragments: inputs.fragments });
    } catch (e) { return { ...inputs, ok: false, diagnostics: [...inputs.diagnostics, { path: LANDING, code: e.code || 'REGISTER_LANDING_UNAVAILABLE' }] }; }
  }
  return validateFragmentRelations({ ...options, inputs, logicalBaseline });
}
module.exports = { MAX_BYTES, REGISTER_STATUSES, SHA, DIGEST, PACKAGE, LABEL, LAUNCH, SLOT, P, OR, PREFIXES, COMPILED, LANDING,
  fail, need, keys, scalar, strings, calendar, decode, json, bytesOf, readLaunch, digest, parseFragment, verifyIssueProofOffline, checkPackageWrites, readFragmentInputs, validateFragmentRelations, projectRegisterValue, normalizeRegisterBaseline, validateFragments };

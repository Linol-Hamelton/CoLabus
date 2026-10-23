'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const root = path.resolve(__dirname, '..');
if (process.env.PRODSEL_MUTATION) {
  const m = JSON.parse(fs.readFileSync(process.env.PRODSEL_MUTATION, 'utf8'));
  const native = Module._extensions['.cjs'] || Module._extensions['.js'];
  Module._extensions['.cjs'] = (mod, file) => {
    if (file !== path.join(root, m.file)) return native(mod, file);
    const source = fs.readFileSync(file, 'utf8');
    if (m.entry) mod._compile(source + `\nmodule.exports.${m.entry} = undefined;\n`, file);
    else { assert.ok(source.includes(m.from)); mod._compile(source.replace(m.from, m.to), file); }
  };
}
const shipped = fs.existsSync(path.join(root, 'PRODUCT-VERSION.json'));
const modules = [
  ['tools/assign/io.cjs', 'readJson'], ['tools/assign/complexity.cjs', 'complexity'],
  ['tools/assign/selection-policy.cjs', 'loadPolicy'],
  ['tools/assign/feedback.cjs', 'read'], ['tools/assign/route-order.cjs', 'routeOrder'],
  ['tools/assign/assign.cjs', 'assign'], ['tools/operator/state.cjs', 'id'],
  ['tools/operator/seats.cjs', 'validateContract'], ['tools/operator/landing.cjs', 'mergeManifest'],
  ['tools/operator/assign-bridge.cjs', 'loadLayer'], ['tools/outcomes/outcomes.cjs', 'validateRow'],
];
for (const [file, entry] of modules) test(`runtime closure loads ${file}`, () => {
  assert.equal(typeof require(path.join(root, file))[entry], 'function');
});
test('canonical policy loads and its byte pin matches the shipped projection', () => {
  const policy = require('../tools/assign/selection-policy.cjs');
  const doc = policy.loadPolicy();
  assert.equal(doc.sha256, policy.CANONICAL_SHA256);
  assert.equal(policy.validatePolicySource(doc), doc);
});

test('portable registry loads through the strict shipped loader', () => {
  const r = require('../.ai/bin/protocol-dispatch/registry.cjs').loadRegistry();
  assert.equal(r.schema, 'clients/1');
  if (shipped) for (const client of Object.values(r.clients)) {
    assert.equal(client.present, false); assert.deepEqual(client.env, {});
    assert.equal(client.verifiedOn, null);
  }
});
test('operator explicit route contract and invocation stay usable without a catalog', () => {
  const seats = require('../tools/operator/seats.cjs');
  const contract = { id: 'seat-one', stream: 'stream-one', branch: 'ops-sample', sha: 'a'.repeat(40),
    worktree: 'seat-one', report: 'docs/reviews/seat-one.md', role: 'certifier',
    identity: 'reviewer-one', family: 'reviewer-family', sealed: true,
    route: { client: 'codex', model: 'gpt-5.6-sol', transport: 'sample', executable: process.execPath },
    instructions: 'Read the assigned files.',
    lineage: { author: 'author-one', operator: 'operator-one', fixers: [], preReviewers: [] } };
  assert.equal(seats.validateContract(contract), contract);
  const call = seats.invocation(contract, 'prompt.md', root);
  assert.ok(JSON.stringify(call).includes('gpt-5.6-sol'));
});
test('product catalog-dependent flow refuses deterministically', { skip: !shipped }, () => {
  const bridge = require('../tools/operator/assign-bridge.cjs');
  assert.throws(() => bridge.loadLayer(root), /catalog-unavailable/);
  const q = { task: { packageId: 'sample' }, role: 'author', tokens: null,
    lineage: { author: [], fixer: [], preReviewer: [], operator: [], certifiers: [] }, activeSeats: [], routeStates: [] };
  const r = require('../tools/assign/assign.cjs').assign(q, { repoRoot: root });
  assert.equal(r.status, 'BLOCKED');
  assert.equal(r.selectionFallback.reason, 'selection-not-shipped');
});
test('injected catalog cannot bypass unshipped selection', { skip: !shipped }, () => {
  const q = { task: { packageId: 'sample' }, role: 'author', tokens: null,
    lineage: { author: [], fixer: [], preReviewer: [], operator: [], certifiers: [] }, activeSeats: [], routeStates: [] };
  const catalog = { ok: true, aliases: { routeAliases: [] }, version: 'sample', hashes: {} };
  for (const role of ['author', 'fixer', 'pre-reviewer', 'certifier', 'operator']) {
    for (const tokens of [null, { input: 1000, output: 1000 }]) {
      const r = require('../tools/assign/assign.cjs').assign({ ...q, role, tokens }, { repoRoot: root, catalog });
      assert.equal(r.status, 'BLOCKED', role);
      assert.equal(r.selectionFallback.reason, 'selection-not-shipped', role);
    }
  }
});

test('snapshot writer output validates and loads through its own schema', () => {
  const base = shipped ? 'docs/product/launch-records/' : 'docs/launch-records/';
  const snapshot = require(path.join(root, base, 'tools/lib/price-snapshot.cjs'));
  const schema = JSON.parse(fs.readFileSync(path.join(root, base, 'schema/price-snapshot.json')));
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'snapshot-contract-'));
  for (let n = 0; n < 10; n++) {
    const text = '{"data":[]}';
    const snap = snapshot.buildSnapshot({ mode: n % 2 ? 'live' : 'replay', userAgent: n % 2 ? 'sample' : null,
      lists: [{ platform: n % 2 ? 'vercel' : 'openrouter', text,
        url: snapshot.SOURCES[n % 2 ? 'vercel' : 'openrouter'].url,
        fetchedAt: `2026-10-${String(n + 1).padStart(2, '0')}T00:00:00.000Z`, status: 200,
        bytes: text.length, rawSha256: 'a'.repeat(64) }], endpoints: [], endpointCap: n, endpointWanted: 0 });
    assert.equal(snap.tool, 'price-snapshot');
    assert.ok(schema.properties.tool.enum.includes(snap.tool));
    assert.ok(schema.properties.tool.enum.includes('route-price.cjs'), 'existing snapshots remain readable');
    assert.deepEqual(snapshot.schemaProblems(snap), []);
    const file = path.join(dir, `${n}.json`); fs.writeFileSync(file, JSON.stringify(snap));
    assert.deepEqual(snapshot.loadSnapshot(file), snap);
    const legacy = { ...snap, tool: 'route-price.cjs' }; delete legacy.hash;
    legacy.hash = require(path.join(root, base, 'tools/lib/canon.cjs')).hashOf(legacy);
    fs.writeFileSync(file, JSON.stringify(legacy)); assert.deepEqual(snapshot.loadSnapshot(file), legacy);
  }
});

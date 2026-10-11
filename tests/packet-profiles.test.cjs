'use strict';
// Load profiles of the compiler (procedure.schema.md 4.3): four levels, level 4 = the unchanged default, --profile auto from role x tier.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repoRoot } = require('./helpers.cjs');
const packet = require('../.ai/bin/protocol-packet.cjs');
const { tt } = require('./helpers.cjs');

const CORE = path.join(repoRoot, '.ai', 'core');
const PAIRS = [['implementer', 'execute'], ['reviewer', 'accept'], ['coordinator', 'dispatch']];

function kernelCopy(t) {
  const root = tt.mkTmp('colabs-profiles-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  fs.cpSync(CORE, path.join(root, '.ai', 'core'), { recursive: true });
  return root;
}
const frameWith = (tier, stage = 'execute') => [
  'goal: finish the thing', 'non-goals: []', 'sources: [docs/x.md: tracked]', 'baseline: 0123456789012345678901234567890123456789',
  'scope-id: task:profiles', 'parent-scope: -', 'scope: [docs/reviews/*]', 'forbidden: [**]', 'risk: low', `tier: ${tier}`,
  'success: [budget gate]', 'budgets: {attempts: 1}', `stage: ${stage}`,
].join('\n') + '\n';
function frameIn(root, tier, stage) {
  const rel = path.join('.ai', 'runtime', 'frame.txt');
  fs.mkdirSync(path.join(root, '.ai', 'runtime'), { recursive: true });
  fs.writeFileSync(path.join(root, rel), frameWith(tier, stage));
  return path.join(root, rel);
}
const compile = (root, role, stage, extra) => packet.compile({ root, role, stage, client: 'claude', ...extra });

test('default is unchanged: no flag, full and 4 give the same bytes; the manifest has no profile field', t => {
  const root = kernelCopy(t);
  for (const [role, stage] of PAIRS) {
    const base = compile(root, role, stage);
    assert.equal(base.exit, 0);
    assert.equal(base.manifest.profile, undefined);
    for (const p of ['full', '4']) assert.equal(compile(root, role, stage, { profile: p }).text, base.text, `${role}/${stage} profile ${p}`);
  }
});

test('the levels shrink the packet: 1 < 2 < 3 < 4 for the three pilot pairs; level 1 is under a third of the full packet', t => {
  const root = kernelCopy(t);
  for (const [role, stage] of PAIRS) {
    const size = p => compile(root, role, stage, { profile: p }).manifest.bytes;
    const [l1, l2, l3, l4] = ['1', '2', '3', '4'].map(size);
    assert.ok(l1 < l2 && l2 < l3 && l3 < l4, `${role}/${stage}: ${l1} ${l2} ${l3} ${l4}`);
    assert.ok(l1 * 3 < l4, `${role}/${stage}: level 1 (${l1}) is not under a third of full (${l4})`);
  }
});

test('level 1 carries the team rules, the role and the stop conditions, and cuts the governance rules and the procedure steps', t => {
  const root = kernelCopy(t);
  const r = compile(root, 'implementer', 'execute', { profile: '1' });
  for (const id of ['R-L0-01', 'R-L0-05', 'R-L0-07', 'R-L0-10', 'R-L0-11']) assert.ok(r.text.includes(`${id}.`), `${id} missing`);
  for (const id of ['R-L0-12', 'R-L0-17', 'R-L0-21']) assert.ok(!r.text.includes(`${id}.`), `${id} must be cut at level 1`);
  assert.ok(/ROLE-implementer Limits/.test(r.text), 'role Limits missing');
  assert.ok(!/P-L2-003 Steps/.test(r.text), 'the procedure Steps must be a pointer, not text');
  assert.ok(r.manifest.degraded.some(d => d.step === 'profile-1'), 'cuts are rows of the manifest');
  assert.equal(r.manifest.profile.level, 1);
});

test('--profile auto takes the level from the role and the tier of the frame', t => {
  const root = kernelCopy(t);
  const cases = [['implementer', 'execute', 'T1', 1], ['implementer', 'execute', 'T5', 2], ['implementer', 'execute', 'T8', 3],
    ['certifier', 'accept', 'T1', 3], ['certifier', 'accept', 'T7', 4], ['owner', 'intake', 'T9', 2], ['reviewer', 'accept', 'T2', 2]];
  for (const [role, stage, tier, level] of cases) {
    const r = compile(root, role, stage, { profile: 'auto', frame: frameIn(root, tier, stage) });
    assert.equal(r.manifest.profile.level, level, `${role} ${tier}`);
    assert.equal(r.manifest.profile.tier, tier);
  }
});

test('auto without a frame tier, an unknown profile and a malformed profiles block are named refusals; a role without a row means full', t => {
  const root = kernelCopy(t);
  assert.throws(() => compile(root, 'implementer', 'execute', { profile: 'auto' }), /needs a frame with a tier/);
  assert.throws(() => compile(root, 'implementer', 'execute', { profile: 'banana' }), /unknown profile/);
  const schema = path.join(root, '.ai', 'core', 'schema', 'procedure.schema.md');
  const text = fs.readFileSync(schema, 'utf8');
  // a role without a row: full (never less)
  fs.writeFileSync(schema, text.replace('implementer: T1-T3=1, T4-T6=2, T7-T9=3\n', ''));
  const r = compile(root, 'implementer', 'execute', { profile: 'auto', frame: frameIn(root, 'T1') });
  assert.equal(r.manifest.profile.level, 4);
  assert.ok(r.manifest.profile.note);
  assert.equal(r.manifest.bytes, compile(root, 'implementer', 'execute', { frame: frameIn(root, 'T1') }).manifest.bytes);
  // a gap in the bands
  fs.writeFileSync(schema, text.replace('implementer: T1-T3=1, T4-T6=2, T7-T9=3', 'implementer: T1-T3=1, T5-T9=2'));
  assert.throws(() => compile(root, 'implementer', 'execute', { profile: 'auto', frame: frameIn(root, 'T1') }), /cover T1\.\.T9/);
  // an unknown role in the table
  fs.writeFileSync(schema, text.replace('implementer: T1-T3=1', 'banana: T1-T9=1\nimplementer: T1-T3=1'));
  assert.throws(() => compile(root, 'implementer', 'execute', { profile: '1' }), /unknown role "banana"/);
});

test('a rule asked for with --needs-rules is never cut by a profile', t => {
  const root = kernelCopy(t);
  const plain = compile(root, 'implementer', 'execute', { profile: '1' });
  assert.ok(!plain.text.includes('R-L2-003.1.'), 'precondition: the rule is not in level 1');
  const forced = compile(root, 'implementer', 'execute', { profile: '1', needsRules: ['R-L2-003.1'] });
  assert.ok(forced.text.includes('R-L2-003.1.'));
});

test('a client without file access gets no pointer lines at a light level: the cut blocks are dropped and named in the manifest', t => {
  const root = kernelCopy(t);
  const r = compile(root, 'implementer', 'execute', { profile: '1', client: 'webbee' });
  assert.equal(r.exit, 0);
  assert.equal(r.manifest.pointers.length, 0);
  assert.ok(!/open on the trigger/.test(r.text.split('## binding basis')[0].split('## stop conditions')[1] || ''));
  assert.ok(r.manifest.degraded.filter(d => d.step === 'profile-1').every(d => d.to !== 'pointer'));
});

test('the binding basis names only the records whose text is in the packet', t => {
  const root = kernelCopy(t);
  const full = compile(root, 'implementer', 'execute');
  const light = compile(root, 'implementer', 'execute', { profile: '1' });
  assert.ok(light.manifest.bindingBasis.length < full.manifest.bindingBasis.length);
  const inText = new Set(light.manifest.selected.filter(s => s.level === 'operational' || s.level === 'fields' || s.level === 'names').map(s => s.id));
  for (const b of light.manifest.bindingBasis) assert.ok(inText.has(b.id), b.id);
});

test('a ROOT rule asked for with --needs-rules survives levels 1 and 2 (certification F-001); without the request it is cut', t => {
  const root = kernelCopy(t);
  for (const level of ['1', '2']) {
    assert.ok(!compile(root, 'implementer', 'execute', { profile: level }).text.includes('R-L0-12.'), `precondition: R-L0-12 is cut at level ${level}`);
    const forced = compile(root, 'implementer', 'execute', { profile: level, needsRules: ['R-L0-12'] });
    assert.ok(forced.text.includes('R-L0-12.'), `R-L0-12 must survive at level ${level}`);
    assert.ok(forced.text.includes('R-L0-01.'), 'the team rules stay');
  }
});

test('the profiles block: duplicate role, overlapping or malformed bands, an unclosed block and the team-rules line are named refusals (R-004, R-001, R-002)', t => {
  const root = kernelCopy(t);
  const schema = path.join(root, '.ai', 'core', 'schema', 'procedure.schema.md');
  const text = fs.readFileSync(schema, 'utf8');
  const IMPL = 'implementer: T1-T3=1, T4-T6=2, T7-T9=3';
  const TEAM = text.split('\n').find(l => l.startsWith('team-rules: '));
  const refuse = (edited, profile, pattern) => {
    fs.writeFileSync(schema, edited);
    assert.throws(() => compile(root, 'implementer', 'execute', { profile }), pattern);
  };
  refuse(text.replace(IMPL, `${IMPL}\nimplementer: T1-T9=1`), '1', /duplicate role/);
  refuse(text.replace(IMPL, 'implementer: T1-T4=1, T4-T9=2'), '1', /gap or an overlap/);
  refuse(text.replace(IMPL, 'implementer: T3-T1=1, T4-T9=2'), '1', /malformed band/);
  refuse(text.replace(IMPL, 'implementer: T1-T3=7, T4-T9=2'), '1', /malformed band/);
  refuse(text.replace('```profiles\n', '```profiles\nthis is not a key value line\n'), '1', /malformed profiles line/);
  refuse(text.replace(`${TEAM}\n`, ''), '1', /need the team-rules line/);
  refuse(text.replace(TEAM, `${TEAM}\n${TEAM}`), '1', /duplicate team-rules/);
  refuse(text.replace('R-L0-03', 'R-L0-99'), '1', /not a rule of the root/);
  // a typo in the list does not break the default (level 4) and level 3, which do not use it
  fs.writeFileSync(schema, text.replace('R-L0-03', 'R-L0-99'));
  assert.equal(compile(root, 'implementer', 'execute').exit, 0);
  assert.equal(compile(root, 'implementer', 'execute', { profile: '3' }).exit, 0);
  // without the team-rules line only levels 3 and 4 work
  fs.writeFileSync(schema, text.replace(`${TEAM}\n`, ''));
  assert.equal(compile(root, 'implementer', 'execute', { profile: '3' }).exit, 0);
});

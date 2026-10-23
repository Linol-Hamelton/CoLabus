'use strict';
// Load profiles of the compiler (procedure.schema.md 4.3): four levels, level 4 = the unchanged default, --profile auto from role x tier.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repoRoot, launchWorkRoot, noRouteGate } = require('./helpers.cjs');
const packet = require('../.ai/bin/protocol-packet.cjs');
const { tt } = require('./helpers.cjs');
const launch = require('../docs/ops/launch-packet.cjs');
const certLaunch = require('../docs/ops/cert-launch.cjs');
const fixLaunch = require('../docs/ops/fix-launch.cjs');
const dispatchPacket = require('../.ai/bin/protocol-dispatch/packet.cjs');
// The calibration farm is a development-only tool and is not shipped in the product: the cases that start it run where it exists.
// Only the absence of the farm file itself (the exact resolved path) makes the farm absent; any other error while loading an existing farm (a missing
// dependency of its own included) is rethrown, so a broken farm fails this file instead of skipping its cases. The guard is a function of its own so
// that the tests at the end of this file can run it against a farm that exists and cannot load, and against a copy of it with a widened catch.
function loadFarm(file, load = require, exists = fs.existsSync) {
  try { return load(file); } catch (e) { if (e && e.code === 'MODULE_NOT_FOUND' && !exists(file)) return null; throw e; }
}
const FARM_PATH = path.join(__dirname, '..', 'docs', 'ops', 'calibration-farm.cjs');
const farm = loadFarm(FARM_PATH);

const CORE = path.join(repoRoot, '.ai', 'core');
const PAIRS = [['implementer', 'execute'], ['reviewer', 'accept'], ['coordinator', 'dispatch']];

// A copy of the live kernel. A test whose premise is "the default is stepped down" or "the default fits whole" must make that premise, not find it in the size the
// live kernel has today (a kernel that shrinks below the gate, or grows far above it, must not turn a correct compiler into a failing test). `size` shapes the copy:
// 'big' sets every rule text to 300 bytes so that every role-stage default is over the 100000-byte gate (it steps down), 'small' cuts every rule text to one word so that every default fits whole.
const RULE_LINE = /^(\s*(?:-\s+)?R-[A-Za-z0-9][A-Za-z0-9.-]*\.\s+)(.+)$/;
function reshape(dir, size) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isDirectory()) reshape(f, size);
    else if (f.endsWith('.md')) fs.writeFileSync(f, fs.readFileSync(f, 'utf8').split('\n').map(l => (RULE_LINE.test(l) ? (size === 'big' ? l.replace(RULE_LINE, (m, head) => `${head}${'x'.repeat(300)}`) : l.replace(RULE_LINE, '$1Norm.')) : l)).join('\n'));
  }
}
function kernelCopy(t, size) {
  const root = tt.mkTmp('colabs-profiles-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  fs.cpSync(CORE, path.join(root, '.ai', 'core'), { recursive: true });
  if (size) reshape(path.join(root, '.ai', 'core'), size);
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

// What the delivered text carries, read from the text itself (the render format of blockText): the sections that are text (id, section, path), the pointer
// lines (id, path, section) and the binding basis. The manifest must say exactly that and no more, whatever level or step-down produced the packet.
function deliveredOf(text) {
  const sections = []; const pointers = []; const basis = [];
  for (const line of text.split('\n')) {
    let m = /^### (\S+) (.+) \[(\S+)#(.+)\](?: \(fields: names only\))?$/.exec(line);
    if (m) { assert.equal(m[2], m[4], 'the heading is written twice in a section line'); sections.push(`${m[1]}|${m[2]}|${m[3]}`); continue; }
    m = /^- if (.+): open (\S+)#(.+) \((\S+)\)$/.exec(line);
    if (m) { pointers.push(`${m[4]}|${m[3]}|${m[2]}`); continue; }
    m = /^- (\S+) owner_approval=(PROTO-DEC-\d+|DEC-\d+)(?: \[active-in-build\])?$/.exec(line);
    if (m) basis.push(`${m[1]}|${m[2]}`);
  }
  return { sections: sections.sort(), pointers: pointers.sort(), basis: basis.sort() };
}
let approvalMap = null;
function approvals() {
  if (approvalMap) return approvalMap;
  approvalMap = new Map();
  const walk = dir => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) { walk(f); continue; }
      if (!f.endsWith('.md')) continue;
      const head = fs.readFileSync(f, 'utf8').split('\n---')[0];
      const id = /^id: (\S+)$/m.exec(head); const approval = /^owner_approval: (\S+)$/m.exec(head);
      if (id && approval) approvalMap.set(id[1], approval[1]);
    }
  };
  walk(CORE);
  assert.ok(approvalMap.size > 50, `the approvals of the records are read: ${approvalMap.size}`);
  return approvalMap;
}
function assertManifestIsTheText(r, label) {
  const got = deliveredOf(r.text);
  const sel = r.manifest.selected;
  const key = s => `${s.id}|${s.section}|${s.path}`;
  const asText = sel.filter(s => ['operational', 'fields', 'names'].includes(s.level)).map(key).sort();
  const asPointer = [...sel.filter(s => s.level === 'pointer').map(s => `${s.id}|${s.section}|${s.path}`), ...r.manifest.pointers.map(p => `${p.id}|${p.section}|${p.path}`)].sort();
  assert.ok(got.sections.length > 5, `${label}: the delivered text has sections`);
  assert.deepEqual(asText, got.sections, `${label}: manifest.selected lists exactly the sections that are text in the packet`);
  assert.deepEqual(asPointer, got.pointers, `${label}: the pointer lines of the packet are the pointers of the manifest`);
  // The basis is the pair (record, the decision that approves it), not the record alone: the value of the manifest is the value of the delivered text, and both are the
  // owner_approval of the record's own front matter on the tree (the reshaping of the test kernels never touches a front matter)
  assert.deepEqual(r.manifest.bindingBasis.map(b => `${b.id}|${b.ownerApproval}`).sort(), got.basis, `${label}: the binding basis of the manifest (record and approving decision) is the one in the packet`);
  for (const b of r.manifest.bindingBasis) assert.equal(b.ownerApproval, approvals().get(b.id), `${label}: ${b.id} is approved by the decision its own record names`);
  assert.equal(r.manifest.bytes, Buffer.byteLength(r.text, 'utf8'), `${label}: bytes`);
}

test('default is the whole instruction when it fits the byte gate: no flag, full and 4 give the same bytes; the manifest has no profile field', t => {
  const root = kernelCopy(t, 'small'); // every default fits whole by construction, whatever size the live kernel has
  let fitting = 0;
  for (const [role, stage] of PAIRS) {
    const base = compile(root, role, stage);
    assert.equal(base.exit, 0, `${role}/${stage}: a default packet is never over the byte gate (PROTO-DEC-0187 item 1)`);
    assert.ok(base.manifest.bytes <= 100000, `${role}/${stage}: ${base.manifest.bytes}`);
    if (compile(root, role, stage, { profile: '4' }).exit !== 0) continue; // the whole instruction is over the gate: the next test
    fitting++;
    assert.equal(base.manifest.profile, undefined);
    for (const p of ['full', '4']) assert.equal(compile(root, role, stage, { profile: p }).text, base.text, `${role}/${stage} profile ${p}`);
  }
  assert.equal(fitting, PAIRS.length, 'every pair is a real fit on the small kernel');
});

// PROTO-DEC-0187 item 1: 100000 bytes stays the one limit; a default that exceeds it is reduced with the load levels 1-4, a packet over the
// limit is refused with a named reason. The budget is lowered here so that the result does not depend on how big the kernel is today.
test('a default call over the byte gate steps down to the first load level that fits; full and 4 are refused, never reduced', t => {
  const root = kernelCopy(t);
  const size = p => compile(root, 'implementer', 'execute', { profile: p }).manifest.bytes;
  const [l1, l2, l3, l4] = ['1', '2', '3', '4'].map(size);
  // A client without file access can still shed the list of the other records before any level is cut (about 2 KB here), so each budget sits
  // well below the size of the level above it: the level is then the only thing that can make the packet fit.
  const MARGIN = 5000;
  for (const [budget, level] of [[l4 - MARGIN, 3], [l3 - MARGIN, 2], [l2 - MARGIN, 1]]) {
    const r = compile(root, 'implementer', 'execute', { budgetBytes: budget });
    assert.equal(r.exit, 0, `budget ${budget}`);
    assert.ok(r.manifest.bytes <= budget, `${r.manifest.bytes} <= ${budget}`);
    assert.equal(r.manifest.profile.level, level);
    assert.equal(r.manifest.profile.requested, 'default');
    assert.match(r.manifest.profile.note, /PROTO-DEC-0187 item 1/);
    assert.ok(r.manifest.degraded.some(d => d.step === `profile-${level}`), 'the cuts are rows of the manifest');
    assert.equal(r.text, compile(root, 'implementer', 'execute', { budgetBytes: budget, profile: String(level) }).text, 'the same bytes as the named level');
    assertManifestIsTheText(r, `step-down to level ${level}`);
    assert.deepEqual(r.manifest.selected, compile(root, 'implementer', 'execute', { budgetBytes: budget, profile: String(level) }).manifest.selected, 'the selection of the named level');
    for (const n of ['Purpose', 'Rules', 'Rights', 'Duties', 'Limits']) assert.ok(r.manifest.selected.some(s => s.id === 'ROLE-implementer' && s.section === n && s.level === 'operational'), `the role section ${n} stays`);
    for (const p of ['full', '4']) {
      const refused = compile(root, 'implementer', 'execute', { budgetBytes: budget, profile: p });
      assert.equal(refused.exit, 1, `profile ${p} is never reduced`);
      assert.ok(refused.report.reason && refused.report.bytes > budget, 'a named reason with the measured size');
    }
  }
  assert.ok(l1 < l2 && l2 < l3 && l3 < l4);
  // a NAMED `auto` is a request for one level and is never stepped further down: over the gate it is refused at its own level
  const auto = compile(root, 'implementer', 'execute', { profile: 'auto', frame: frameIn(root, 'T8', 'execute'), budgetBytes: l3 - MARGIN });
  assert.equal(auto.exit, 1, 'auto over the gate is refused');
  assert.equal(auto.manifest.profile.level, 3, 'the refusal names the level that auto asked for');
  assert.equal(auto.manifest.profile.requested, 'auto');
  // nothing fits, not even level 1: a named refusal with the measurement of the whole instruction, never a cut below level 1
  const none = compile(root, 'implementer', 'execute', { budgetBytes: l1 - MARGIN });
  assert.equal(none.exit, 1);
  assert.equal(none.manifest.profile, undefined);
  assert.ok(none.report.reason && none.report.bytes > l1 - MARGIN);
});

test('a default step-down never cuts a rule asked for with --needs-rules, the root invariants or the stop conditions of the stage', t => {
  const root = kernelCopy(t);
  const l4 = compile(root, 'implementer', 'execute', { profile: '4' });
  const stepped = compile(root, 'implementer', 'execute', { budgetBytes: l4.manifest.bytes - 5000, needsRules: ['R-L2-003.1'] });
  assert.equal(stepped.exit, 0);
  assert.ok(stepped.text.includes('R-L2-003.1.'));
  for (const id of ['R-L0-01', 'R-L0-05', 'R-L0-07', 'R-L0-10', 'R-L0-11']) assert.ok(stepped.text.includes(`${id}.`), `${id} is a root invariant and stays`);
  const p0 = s => s.priority === 'P0';
  const lost = l4.manifest.selected.filter(p0).filter(s => !stepped.manifest.selected.some(x => x.id === s.id && x.section === s.section && x.level === s.level));
  assert.deepEqual(lost, [], 'no P0 block is cut by the step-down');
});

// The measured surface of PROTO-DEC-0187 item 1 on the live kernel: every role and stage, for a client without file access (the heaviest delivery) and
// for a client that opens files. A default that is over the gate would be a refusal at the start of a real launch.
test('every default role-stage packet of the live kernel is at or below 100000 bytes, for a client without file access and for one with it', () => {
  const schema = fs.readFileSync(path.join(CORE, 'schema', 'procedure.schema.md'), 'utf8');
  const dictBlock = schema.slice(schema.indexOf('```dict'));
  const dict = k => new RegExp(`^${k}: (.+)$`, 'm').exec(dictBlock)[1].split(', ').filter(x => x !== 'all' && x !== 'any');
  const roles = dict('roles');
  const stages = dict('stages');
  assert.ok(roles.length >= 14 && stages.length >= 10, 'the dictionaries are read');
  const over = [];
  for (const client of [undefined, 'claude']) {
    for (const role of roles) {
      for (const stage of stages) {
        const r = packet.compile({ role, stage, client });
        if (r.exit !== 0 || r.manifest.bytes > 100000) over.push(`${client || 'no-client'} ${role}/${stage} exit=${r.exit} ${r.manifest && r.manifest.bytes}`);
      }
    }
  }
  assert.deepEqual(over, []);
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
  // `default` is the marker of an absent --profile, never a value a caller can name (closed grammar: full, auto, 1, 2, 3, 4)
  for (const v of ['default', 'DEFAULT', '', ' 3', '03', 3.5, null]) assert.throws(() => compile(root, 'implementer', 'execute', { profile: v }), /unknown profile/, `profile ${JSON.stringify(v)}`);
  // A profile is a string at the compiler boundary too, as at the launcher: the number 3 is not the profile "3" (String(3) is in the closed list, so a text check alone lets it in),
  // and neither is an array or a String object whose text is a name; the refusal names the reason (a string)
  for (const v of [3, 4, 1, 2, true, ['3'], new String('3'), { toString: () => '3' }]) {
    assert.throws(() => compile(root, 'implementer', 'execute', { profile: v }), /unknown profile "[^"]*" \(a string: full, auto, 1, 2, 3, 4\)/, `non-string profile ${typeof v} ${Array.isArray(v) ? 'array' : ''}`);
  }
  assert.equal(compile(root, 'implementer', 'execute', { profile: '3' }).exit, 0, 'the string "3" is still a profile');
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

test('a ROOT rule asked for with --needs-rules survives levels 1 and 2; without the request it is cut', t => {
  const root = kernelCopy(t);
  for (const level of ['1', '2']) {
    assert.ok(!compile(root, 'implementer', 'execute', { profile: level }).text.includes('R-L0-12.'), `precondition: R-L0-12 is cut at level ${level}`);
    const forced = compile(root, 'implementer', 'execute', { profile: level, needsRules: ['R-L0-12'] });
    assert.ok(forced.text.includes('R-L0-12.'), `R-L0-12 must survive at level ${level}`);
    assert.ok(forced.text.includes('R-L0-01.'), 'the team rules stay');
  }
});

test('the profiles block: duplicate role, overlapping or malformed bands, an unclosed block and the team-rules line are named refusals', t => {
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

// The coordinator is the role whose default is stepped down on the live kernel for a client without file access: the step-down may take P2 and P3
// blocks only, in every stage. The whole instruction is measured with a budget raised for this one call, so that the comparison does not depend on it.
test('the coordinator default step-down on the live kernel loses no P0 block and cuts only P2 and P3 blocks, in every stage', () => {
  const stages = ['intake', 'frame', 'triage', 'dispatch', 'execute', 'accept', 'freeze', 'close', 'session', 'research'];
  const key = s => `${s.id}#${s.section}`;
  let stepped = 0;
  for (const stage of stages) {
    const whole = packet.compile({ role: 'coordinator', stage, profile: '4', budgetBytes: 1000000 });
    const def = packet.compile({ role: 'coordinator', stage });
    assert.equal(def.exit, 0, stage);
    if (!def.manifest.profile) continue; // fits as a whole: nothing to check
    stepped++;
    const kept = new Map(def.manifest.selected.map(s => [key(s), s]));
    for (const s of whole.manifest.selected.filter(x => x.priority === 'P0')) {
      assert.ok(kept.has(key(s)) && kept.get(key(s)).level === s.level, `${stage}: P0 block kept: ${key(s)}`);
    }
    const priority = new Map(whole.manifest.selected.map(s => [key(s), s.priority]));
    for (const d of def.manifest.degraded.filter(x => x.step === `profile-${def.manifest.profile.level}`)) {
      assert.ok(['P2', 'P3'].includes(priority.get(`${d.id}#${d.section}`)), `${stage}: only P2 and P3 are cut: ${d.id}#${d.section}`);
    }
  }
  // no premise is asserted: when the kernel shrinks until nothing is stepped down, the loop above checks nothing and passes (the mechanism is covered above)
  void stepped;
});

// The cells of the live kernel where the default is stepped down (client without file access, coordinator) and where it fits: in each, the manifest describes the text.
test('manifest.selected, the pointers and the binding basis equal the delivered text: stepped default, fitting default, every named level', t => {
  const root = kernelCopy(t);
  const CELLS = [['coordinator', 'dispatch', undefined], ['coordinator', 'execute', undefined], ['coordinator', 'dispatch', 'kimi'], ['reviewer', 'accept', undefined], ['implementer', 'execute', 'claude']];
  // the live kernel, whatever its size: the manifest describes the text, stepped or whole
  for (const [role, stage, client] of CELLS) {
    const r = packet.compile({ root, role, stage, client });
    assert.equal(r.exit, 0, `${role}/${stage}/${client}`);
    assertManifestIsTheText(r, `live default ${role}/${stage}/${client}`);
  }
  // the premises are made here: on the big kernel every default is over the gate and steps down, on the small one every default fits whole
  const big = kernelCopy(t, 'big');
  const small = kernelCopy(t, 'small');
  for (const [role, stage, client] of CELLS) {
    const s = packet.compile({ root: big, role, stage, client });
    assert.equal(s.exit, 0, `big ${role}/${stage}/${client}`);
    assert.equal(packet.compile({ root: big, role, stage, client, profile: '4' }).exit, 1, `big ${role}/${stage}/${client}: the whole instruction is over the gate`);
    assert.ok(s.manifest.profile && s.manifest.profile.level < 4, `big ${role}/${stage}/${client}: really stepped down`);
    assert.ok(s.manifest.degraded.some(d => d.step === `profile-${s.manifest.profile.level}`));
    assertManifestIsTheText(s, `stepped default ${role}/${stage}/${client}`);
    const w = packet.compile({ root: small, role, stage, client });
    assert.equal(w.exit, 0, `small ${role}/${stage}/${client}`);
    assert.equal(w.manifest.profile, undefined, `small ${role}/${stage}/${client}: whole, no profile field`);
    assert.equal(w.manifest.selected.length, packet.compile({ root: small, role, stage, client, profile: 'full' }).manifest.selected.length);
    assertManifestIsTheText(w, `fitting default ${role}/${stage}/${client}`);
  }
  for (const level of ['full', '4', '3', '2', '1']) assertManifestIsTheText(compile(root, 'implementer', 'execute', { profile: level }), `named ${level}`);
  assertManifestIsTheText(compile(root, 'implementer', 'execute', { profile: '1', client: 'webbee' }), 'named 1, no file access');
});

// PROTO-DEC-0187 item 1: the default is decided in ONE place, the compiler. A caller that names no profile passes none: compile(), preparePacket, the dispatch wiring,
// cert-launch, fix-launch and the calibration farm all deliver the same bytes for the same role and stage, and none of them writes `full` for an absent profile.
test('one default profile for every caller: compile, preparePacket, dispatch wiring, cert-launch, fix-launch and the farm agree on the reduced default', t => {
  // The reduced default is made by the big kernel (every default over the gate) and the whole default by the small one; neither premise is read from the live size
  const withClients = size => {
    const dir = kernelCopy(t, size);
    fs.mkdirSync(path.join(dir, '.ai', 'docs'), { recursive: true });
    fs.copyFileSync(path.join(repoRoot, '.ai', 'docs', 'clients.json'), path.join(dir, '.ai', 'docs', 'clients.json'));
    return dir;
  };
  const root = withClients('big');
  for (const [shape, kernel] of [['big', root], ['small', withClients('small')]]) for (const [role, stage] of [['coordinator', 'dispatch'], ['coordinator', 'execute'], ['reviewer', 'accept']]) {
    const direct = packet.compile({ root: kernel, role, stage });
    assert.equal(direct.exit, 0, `${shape} ${role}/${stage}`);
    assert.ok(direct.manifest.bytes <= 100000, `${role}/${stage}: ${direct.manifest.bytes} bytes`);
    const level = direct.manifest.profile ? String(direct.manifest.profile.level) : 'full';
    assert.equal(packet.compile({ root: kernel, role, stage, profile: '4' }).exit === 0, shape === 'small', `${shape} ${role}/${stage}: the whole instruction ${shape === 'small' ? 'fits' : 'is over the gate'}`);
    if (shape === 'big') assert.notEqual(level, 'full', `${role}/${stage}: the default is reduced`); else assert.equal(level, 'full', `${role}/${stage}: the default is whole`);
    const root = kernel; // eslint-disable-line no-shadow
    const prepared = launch.preparePacket({ worktree: root, role, stage });
    assert.equal(fs.readFileSync(path.join(root, prepared.packetPath), 'utf8'), direct.text, `${role}/${stage}: preparePacket delivers the compiler default byte for byte`);
    assert.equal(prepared.packetHash, direct.packetHash);
    assert.equal(prepared.bytes, direct.manifest.bytes);
    assert.equal(prepared.profile, level, 'the launch record keeps the delivered level');
    // the calibration farm (development only): an unnamed profile is passed on unnamed and the packet is the compiler default
    if (farm) {
      const farmed = farm.packetFromCompiler(root, role, stage, undefined, undefined);
      assert.equal(farmed.hash, direct.packetHash, `${role}/${stage}: the farm delivers the compiler default`);
      assert.equal(farmed.profile, level);
    }
    // the dispatch wiring: its compile call carries no profile key and it delivers the same packet
    const seen = [];
    const slot = { id: 'one-default', role, launch: 'launch.md', packet: { mode: 'inline', stage } };
    fs.writeFileSync(path.join(root, 'launch.md'), `# Work\n${dispatchPacket.MARKER}\n`);
    const wired = dispatchPacket.prepare(slot, root, [], { compiler: { compile: o => { seen.push(o); return packet.compile(o); } } });
    assert.equal(wired.ok, true, wired.reason);
    assert.equal(seen.length, 1);
    assert.equal(Object.hasOwn(seen[0], 'profile'), false, 'the dispatch wiring names no profile');
    assert.equal(wired.packetHash, direct.packetHash.replace(/^sha256:/, ''));
  }
  // cert-launch and fix-launch: no --packet-profile means no profile at all; a named one is passed through untouched
  for (const tool of [certLaunch, fixLaunch]) {
    assert.equal(tool.options(['--packet-role', 'reviewer', '--packet-stage', 'accept']).packetProfile, undefined);
    assert.equal(tool.options(['--packet-role', 'reviewer', '--packet-stage', 'accept', '--packet-profile', '4']).packetProfile, '4');
  }
  // a named profile keeps its meaning: full is never reduced, so it is refused when the whole instruction is over the gate
  const refused = (opts, code) => assert.throws(() => launch.preparePacket({ worktree: root, role: 'coordinator', stage: 'dispatch', ...opts }, {}), e => e.exitCode === code, JSON.stringify(opts));
  refused({ profile: 'full' }, 1);
  refused({ profile: '4' }, 1);
  // level 1: on the big copy (every rule text 300 bytes) level 3 of coordinator/dispatch is 118639 bytes once the 25 records of PROTO-DEC-0192 are active, so the named level that must fit is the lightest
  assert.equal(launch.preparePacket({ worktree: root, role: 'coordinator', stage: 'dispatch', profile: '1' }).profile, '1');
  // the marker of an absent profile is not a value a caller can name, at the launcher either
  for (const v of ['default', 'DEFAULT', '', ' 3', '03', 3, 3.5, false, {}]) refused({ profile: v }, 2);
  // and the refusal is the launcher's own: the compiler is never called with such a value
  for (const v of ['default', 'DEFAULT', '', ' 3', 3, false, {}]) {
    let called = 0;
    assert.throws(() => launch.preparePacket({ worktree: root, role: 'coordinator', stage: 'dispatch', profile: v }, { compile: () => { called++; throw new Error('compiler reached'); } }), e => e.exitCode === 2 && !/compiler reached/.test(e.message), JSON.stringify(v));
    assert.equal(called, 0, `the compiler is not reached with profile ${JSON.stringify(v)}`);
  }
});

// A second default profile is found by the parse of the JavaScript, by what the code MEANS and not by a list of syntax forms. The meaning: a value that is the
// caller's profile (an identifier or a member named profile / packetProfile / packet-profile, a computed 'packet-profile' key, a call that reads one: value(argv, 'packet-profile')) FALLS BACK to a
// text of the code's own. A text is a string literal, a template literal, or any conditional / logical / `+` expression that can yield one. The falling back is written with `||`, `??`, a conditional
// that passes the profile on in one branch and a text in the other, an assignment (`=`, `||=`, `??=`), a declaration, a destructuring or parameter default, an object property, or a call that
// passes 'packet-profile' with a text after it. This scan is the SECOND line of defence; the first is the behaviour test below (every caller started through its real entry).
const { parse: parseJs, walk: walkJs } = require('./operator-auto-js-parse.cjs');
function defaultProfileSites(source) {
  const ast = parseJs(source);
  const lineOf = at => source.slice(0, at).split('\n').length;
  const text = node => source.slice(node.start, node.end).replace(/\s+/g, ' ').trim().slice(0, 100);
  const NAME = /^(profile|packetProfile|packet-profile)$/;
  const strOf = node => (node && node.type === 'Literal' && typeof node.value === 'string' ? node.value
    : node && node.type === 'TemplateLiteral' && node.expressions.length === 0 ? node.quasis[0].value.cooked : undefined);
  // an expression that can yield a text of the code's own
  const textual = node => !!node && (strOf(node) !== undefined || node.type === 'TemplateLiteral'
    || (node.type === 'ConditionalExpression' && (textual(node.consequent) || textual(node.alternate)))
    || (node.type === 'LogicalExpression' && (textual(node.left) || textual(node.right)))
    || (node.type === 'BinaryExpression' && node.operator === '+' && (textual(node.left) || textual(node.right)))
    || (node.type === 'SequenceExpression' && textual(node.expressions[node.expressions.length - 1])));
  const profileLike = node => {
    if (!node) return false;
    if (node.type === 'ChainExpression') return profileLike(node.expression);
    if (node.type === 'Identifier') return NAME.test(node.name);
    if (node.type === 'MemberExpression') return node.computed ? NAME.test(strOf(node.property) || '') : NAME.test(node.property.name || '');
    if (node.type === 'CallExpression') return node.arguments.some(a => NAME.test(strOf(a) || ''));
    return false;
  };
  // an expression that passes the caller's profile on (as it is, or through a fallback or a conditional)
  const flows = node => !!node && (profileLike(node)
    || (node.type === 'LogicalExpression' && (flows(node.left) || flows(node.right)))
    || (node.type === 'ConditionalExpression' && (flows(node.consequent) || flows(node.alternate))));
  const keyName = p => (p.key.type === 'Identifier' && !p.computed ? p.key.name : strOf(p.key) || '');
  const sites = [];
  walkJs(ast, node => {
    const hit = () => sites.push({ line: lineOf(node.start), text: text(node) });
    if (node.type === 'LogicalExpression' && (node.operator === '||' || node.operator === '??') && flows(node.left) && textual(node.right)) hit();
    else if (node.type === 'ConditionalExpression' && ((flows(node.consequent) && textual(node.alternate)) || (flows(node.alternate) && textual(node.consequent)))) hit();
    else if (node.type === 'AssignmentExpression' && ['=', '||=', '??='].includes(node.operator) && profileLike(node.left) && textual(node.right)) hit();
    else if (node.type === 'VariableDeclarator' && profileLike(node.id) && textual(node.init)) hit();
    else if (node.type === 'AssignmentPattern' && profileLike(node.left) && textual(node.right)) hit();
    else if (node.type === 'Property' && !node.shorthand && NAME.test(keyName(node)) && textual(node.value)) hit();
    else if (node.type === 'CallExpression') {
      const at = node.arguments.findIndex(a => strOf(a) === 'packet-profile');
      if (at >= 0 && textual(node.arguments[at + 1])) hit();
    }
  });
  return sites;
}

test('no launcher or tool of the repository writes a default profile of its own for an absent --profile (source scan)', () => {
  const dirs = ['docs/ops', '.ai/bin', 'tools'];
  const files = [];
  const walk = d => {
    for (const e of fs.readdirSync(path.join(repoRoot, d), { withFileTypes: true })) {
      const rel = `${d}/${e.name}`;
      if (e.isDirectory()) { if (!/^(node_modules|runtime|journals-archive|farm|\.git)$/.test(e.name)) walk(rel); } else if (/\.cjs$/.test(e.name) && !/\.test\.cjs$/.test(e.name)) files.push(rel);
    }
  };
  for (const d of dirs) if (fs.existsSync(path.join(repoRoot, d))) walk(d);
  assert.ok(files.length > 100, `the scan reads the real tree: ${files.length} files`);
  const hits = [];
  const advisory = [];
  for (const f of files) {
    const src = fs.readFileSync(path.join(repoRoot, f), 'utf8');
    for (const h of defaultProfileSites(src)) {
      // PROTO-DEC-0193: this exact, separately named full measurement is
      // advisory; actual delivery still calls compile(options) without profile.
      const line = src.split('\n')[h.line - 1].trim();
      if (f === '.ai/bin/protocol-core.cjs' && line === "try { full = compile({ ...options, profile: 'full' }); } catch { full = null; }") advisory.push(h);
      // Train integration: in an event SCHEMA table (the one that also lists ROLE_ENUM) `packetProfile` is a
      // field TYPE name (the schema declares the field's type as the string type), not a default profile value.
      // Matched by the exact line text and the schema marker, never by a path of a source file.
      else if (line === "packetProfile: 'string'," && /ROLE_ENUM/.test(src)) continue;
      else hits.push(`${f}:${h.line}: ${h.text}`);
    }
  }
  assert.equal(advisory.length, 1, 'exactly one explicit full-profile advisory measurement');
  // The compiler is the ONE place that decides the default (the marker `default`, procedure.schema.md 4.3): its one site is expected and bounded to exactly one; every other file has none.
  const ONE_PLACE = '.ai/bin/protocol-packet.cjs';
  assert.equal(hits.filter(h => h.startsWith(`${ONE_PLACE}:`)).length, 1, 'the compiler decides the default in exactly one site');
  assert.deepEqual(hits.filter(h => !h.startsWith(`${ONE_PLACE}:`)), [], 'a second default profile');
  // the scan itself sees what it is for: the former sites, restored one at a time, and the same in forms a line scan misses (broken over lines, parenthesised, nullish, destructured)
  const samples = [
    "value(argv, 'packet-profile', 'full')", "const profile = opts.profile || 'full';", "o['packet-profile'] || 'full'", "let profile = 'full';", "const x = { profile: 'full' };",
    "const profile = supplied ||\n 'full';", "const profile = (supplied\n  ?? 'full');", "profile = a.b\n  .profile ||\n  \"full\";", "function f({ profile = 'full' }) {}", "const { profile = 'full' } = o;",
    "value(argv,\n 'packet-profile',\n 'full')", "const p = o.packetProfile ||\n 'full';", "const p = o['packet-profile']\n || 'full';",
    // The same meaning in the forms a syntax scan misses - a conditional, a template literal, a profile read through a call or a computed key under another name,
    // a default parameter or destructuring default with a template, a fallback hidden in a conditional inside `||`, a negated test, a logical assignment, an optional chain
    "const profile = o.profile ? o.profile : 'full';", 'const profile = o.profile || `full`;', "const call = (o['packet-profile'] ? o['packet-profile'] : 'full');",
    'const p = value(argv,"packet-profile") || "full";', 'const prof = argv["packet-profile"] || "full";', 'const prof = argv[`packet-profile`] ?? "full";',
    "const q = !o.profile ? 'full' : o.profile;", "const q = typeof o.profile === 'string' ? o.profile : `full`;", 'function f(profile = `full`) {}', 'const { packetProfile = `full` } = o;',
    "const r = (o.profile ? o.profile : undefined) || 'full';", "o.profile ??= 'full';", "o.profile ||= `full`;", "x({ 'packet-profile': 'full' });",
    "const profile = pick ? 'full' : 'cut';", "const pp = o?.profile ?? 'full';", 'value(argv, `packet-profile`, `full`);',
  ];
  for (const sample of samples) assert.ok(defaultProfileSites(sample).length > 0, `the scan catches: ${JSON.stringify(sample)}`);
  // and it does not flag a profile that has no default string
  for (const sample of ['const profile = opts.profile;', 'const profile = opts.profile || undefined;', "const label = profile === 'full' ? 'whole' : 'cut';", "const m = { full: 'full' };",
    "const level = profile ? String(profile) : 'whole';", 'const p = o.profile === undefined ? undefined : o.profile;', "const s = o.profile + '';", "const ok = flag ? 'a' : 'b';", 'const v = value(argv, `packet-role`) || `reviewer`;',
  ]) assert.equal(defaultProfileSites(sample).length, 0, `the scan passes: ${sample}`);
});

// The property is proved on BEHAVIOUR. Every caller of the packet compiler is started through its real entry (cmdRun of the farm through main, main of cert-launch, fix-launch and
// launch-packet, prepare of the dispatch wiring) with no profile named; the compiler is replaced by a probe at its module boundary (the same object every launcher loads), and what the compiler is
// handed is what is asserted: no profile at all. A caller that supplies a profile of its own, in whatever syntax, hands the probe a text and fails here. A named profile is passed on untouched.
function probed(fn) {
  const seen = [];
  const original = packet.compile;
  const out = process.stdout.write; const err = process.stderr.write;
  packet.compile = opts => { seen.push(opts); throw new Error('probe: the compiler was reached'); };
  process.stdout.write = () => true; process.stderr.write = () => true; // the entries print their refusal; the probe makes one on purpose
  try { fn(); } finally { packet.compile = original; process.stdout.write = out; process.stderr.write = err; }
  return seen;
}
test('every caller of the compiler, started through its real entry with no profile named, hands the compiler none; a named profile is passed on untouched (behaviour)', t => {
  const work = tt.mkTmp('k2a2p-', t);
  const wt = path.join(work, 'wt'); fs.mkdirSync(path.join(wt, '.ai', 'runtime'), { recursive: true });
  const runtimeDir = path.join(work, 'rt'); fs.mkdirSync(runtimeDir);
  fs.writeFileSync(path.join(wt, 'launch.md'), `# Work\n${dispatchPacket.MARKER}\n`);
  const routesFile = path.join(work, 'routes.json');
  if (farm) {
    const realRoute = JSON.parse(fs.readFileSync(farm.DEFAULT_ROUTES_FILE, 'utf8')).routes.find(r => !r.parked); // a route of the tracked file, so no address is written here; never contacted: the probe stops the run at the compiler
    fs.writeFileSync(routesFile, JSON.stringify({ schema: 'farm-routes/1', routes: [{ ...realRoute, id: 'probe-route', keyEnv: 'K2A2_PROBE_KEY_PRESENCE' }] }));
  }
  const launcherDeps = env => ({ routeGate: noRouteGate(), env: { ...launchWorkRoot(t).env, OPERATOR_PACKET: env }, runtimeDir, say: () => {}, error: () => {}, spawnSync: () => ({ stdout: 'abc1234\n', status: 0 }) });
  const named = profile => (profile === undefined ? [] : [profile]);
  const entries = {
    'cert-launch': profile => certLaunch.main(['--client', 'codex', '--model', 'm', '--worktree', wt, '--name', 'probe-cert', '--prompt-file', 'p.md', '--expect-sha', 'abc1234',
      '--packet-role', 'certifier', '--packet-stage', 'accept', ...named(profile).flatMap(p => ['--packet-profile', p])], launcherDeps('on')),
    'fix-launch': profile => fixLaunch.main(['--worktree', wt, '--name', 'probe-fix', '--prompt-file', 'p.md', '--expect-sha', 'abc1234', '--packet-role', 'fixer', '--packet-stage', 'execute',
      '--allow-executor-packet', ...named(profile).flatMap(p => ['--packet-profile', p])], launcherDeps('fixer')),
    'launch-packet (CLI)': profile => launch.main(['--worktree', wt, '--role', 'reviewer', '--stage', 'accept', ...named(profile).flatMap(p => ['--profile', p])]),
  };
  if (farm) entries['calibration-farm (run)'] = profile => {
    process.env.K2A2_PROBE_KEY_PRESENCE = '1'; // the farm reads only the presence of the variable named by a route
    try {
      farm.main(['run', '--tasks', 'review-01', '--routes', 'probe-route', '--packet', 'on', '--packet-client', 'kilo', '--routes-file', routesFile, '--agent', path.join(repoRoot, 'docs', 'ops', 'farm', 'fake-agent.cjs'),
        '--journal', path.join(work, 'journal.jsonl'), '--runs-dir', path.join(work, 'runs'), ...named(profile).flatMap(p => ['--packet-profile', p])]);
    } finally { delete process.env.K2A2_PROBE_KEY_PRESENCE; }
  };
  for (const [name, start] of Object.entries(entries)) {
    const none = probed(() => start(undefined));
    assert.equal(none.length, 1, `${name}: the real entry reached the compiler`);
    assert.equal(none[0].profile, undefined, `${name}: no profile named, so the compiler is handed none`);
    assert.equal(Object.hasOwn(none[0], 'profile'), false, `${name}: not even an empty profile key`);
    const four = probed(() => start('4'));
    assert.equal(four.length, 1, `${name}: the real entry reached the compiler with a named profile`);
    assert.equal(four[0].profile, '4', `${name}: a named profile is passed on untouched (the probe does see a profile)`);
  }
  // the dispatch wiring: its compile call carries no profile key
  const seen = [];
  const slot = { id: 'probe', role: 'reviewer', launch: 'launch.md', packet: { mode: 'inline', stage: 'accept' } };
  dispatchPacket.prepare(slot, wt, [], { compiler: { compile: o => { seen.push(o); throw new Error('probe: the compiler was reached'); } } });
  assert.equal(seen.length, 1, 'dispatch wiring: reached the compiler');
  assert.equal(Object.hasOwn(seen[0], 'profile'), false, 'dispatch wiring: names no profile');
  // the SessionStart hook: its packet line is the last production caller; started through its real entry with role and stage set, its compile call carries no profile key
  const hooks = require('../.ai/bin/protocol-hooks.cjs');
  const keys = ['PROTOCOL_PACKET_SESSIONSTART', 'PROTOCOL_PACKET_ROLE', 'PROTOCOL_PACKET_STAGE'];
  const saved = keys.map(k => [k, process.env[k]]);
  Object.assign(process.env, { PROTOCOL_PACKET_SESSIONSTART: '1', PROTOCOL_PACKET_ROLE: 'reviewer', PROTOCOL_PACKET_STAGE: 'accept' });
  let hookSeen;
  try { hookSeen = probed(() => hooks.context(repoRoot, '.ai/worklog/probe.md', 'claude')); } finally { for (const [k, v] of saved) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
  assert.equal(hookSeen.length, 1, 'SessionStart hook: reached the compiler');
  assert.equal(Object.hasOwn(hookSeen[0], 'profile'), false, 'SessionStart hook: names no profile');
  assert.equal(hookSeen[0].role, 'reviewer', 'SessionStart hook: the probe sees the role of the environment');
});

// ---- the farm guard (loadFarm, near the top of this file): the farm is skipped only when its own file is absent; a farm that exists and cannot load fails.
// farmGuardFailures runs every case against a guard and returns what the guard does wrong, so the same cases check the real guard (nothing wrong) and a mutant (something wrong).
function farmGuardFailures(guard) {
  const wrong = [];
  const missing = Object.assign(new Error('Cannot find module'), { code: 'MODULE_NOT_FOUND' });
  const other = new TypeError('a broken farm');
  const check = (name, fn) => { try { fn(); } catch (e) { wrong.push(`${name}: ${e.message.split('\n')[0]}`); } };
  check('an absent farm file is absent', () => assert.equal(guard('farm.cjs', () => { throw missing; }, () => false), null));
  check('a farm that exists and loads is returned', () => assert.equal(guard('farm.cjs', () => ({ loaded: 1 }), () => true).loaded, 1));
  check('a farm that exists and misses a dependency throws that error', () => assert.throws(() => guard('farm.cjs', () => { throw missing; }, () => true), e => e === missing));
  check('a farm that exists and throws another error throws it', () => assert.throws(() => guard('farm.cjs', () => { throw other; }, () => true), e => e === other));
  check('another error is thrown even when the file is absent', () => assert.throws(() => guard('farm.cjs', () => { throw other; }, () => false), e => e === other));
  // the same with the real require and the real file system: a farm file on disk that requires a module that is not there
  const dir = tt.mkTmp('farm-guard-');
  fs.writeFileSync(path.join(dir, 'broken-farm.cjs'), "'use strict';\nmodule.exports = require('./dependency-that-is-absent.cjs');\n");
  fs.writeFileSync(path.join(dir, 'good-farm.cjs'), "'use strict';\nmodule.exports = { good: true };\n");
  check('a real farm file with an absent dependency throws', () => assert.throws(() => guard(path.join(dir, 'broken-farm.cjs'), require, fs.existsSync), e => e.code === 'MODULE_NOT_FOUND' && /dependency-that-is-absent/.test(e.message)));
  check('a real farm file that loads is returned', () => assert.equal(guard(path.join(dir, 'good-farm.cjs'), require, fs.existsSync).good, true));
  check('a real absent farm file is absent', () => assert.equal(guard(path.join(dir, 'no-such-farm.cjs'), require, fs.existsSync), null));
  return wrong;
}
// A copy of the guard with one piece of its condition cut out (compiled from its own source, so the mutation is of the code that runs).
function farmGuardMutant(cut) {
  const source = loadFarm.toString();
  assert.ok(source.includes(cut), `the guard still contains the piece ${cut}`);
  return new Function(`return (${source.replace(cut, '')})`)();
}

test('the farm guard: an absent farm file is skipped; a farm that exists and throws MODULE_NOT_FOUND for its own dependency fails instead of skipping', () => {
  assert.deepEqual(farmGuardFailures(loadFarm), []);
  const dir = tt.mkTmp('farm-guard-run-');
  fs.writeFileSync(path.join(dir, 'farm.cjs'), "'use strict';\nrequire('./absent-internal.cjs');\n");
  assert.throws(() => loadFarm(path.join(dir, 'farm.cjs')), /absent-internal/, 'with the default loader too');
  assert.equal(loadFarm(path.join(dir, 'absent-farm.cjs')), null);
  assert.ok(farm === null || typeof farm.main === 'function', 'the farm of this tree is absent or a loaded module');
});

test('the farm guard mutations are killed: a catch widened to any MODULE_NOT_FOUND, or to any error, makes the guard cases fail', () => {
  const widened = farmGuardFailures(farmGuardMutant(" && !exists(file)"));
  assert.ok(widened.some(w => /misses a dependency/.test(w)) && widened.some(w => /real farm file with an absent dependency/.test(w)), `widened to any MODULE_NOT_FOUND: ${widened.join(' | ')}`);
  const anyError = farmGuardFailures(farmGuardMutant("e && e.code === 'MODULE_NOT_FOUND' && "));
  assert.ok(anyError.some(w => /another error is thrown even when the file is absent/.test(w)), `widened to any error: ${anyError.join(' | ')}`);
  const noRethrow = farmGuardFailures(new Function(`return (${loadFarm.toString().replace('throw e;', 'return null;')})`)());
  assert.ok(noRethrow.length > 0, 'a guard that swallows every error is killed');
});

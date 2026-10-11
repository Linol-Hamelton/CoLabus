'use strict';
// Packet wiring (PROTO-DEC-0162, 0165; ): default OFF, byte-identical when off, fail closed when on.
// Targeted: runs the real dispatch binary with a fake client; no model, no network.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const DISPATCH_BIN = path.join(repoRoot, '.ai', 'bin', 'protocol-dispatch.cjs');
const FAKE = path.join(__dirname, 'wiring-fake-client.cjs');
const registry = require('../.ai/bin/protocol-dispatch/registry.cjs');
const packet = require('../.ai/bin/protocol-dispatch/packet.cjs');
const runrecord = require('../.ai/bin/protocol-runrecord.cjs');
const hooks = require('../.ai/bin/protocol-hooks.cjs');
const { tt } = require('./helpers.cjs');

const WORK = path.join('.ai', 'runtime', 'wiring-test');
fs.mkdirSync(path.join(repoRoot, WORK), { recursive: true });
const SUITE = tt.mkTmp('wiring-');
// the dispatch child clones into <temp>/disp-* and makes <temp>/colabs-hooks-*: its temp dir is a fixture dir inside SUITE
const CHILD_TMP = path.join(SUITE, 't');
fs.mkdirSync(CHILD_TMP);
const rel = p => p.replace(/\\/g, '/');

function setup(tag, launchText, slotExtra, topExtra = {}, clientName = 'claude', mode = '') {
  const dir = path.join(SUITE, tag);
  fs.mkdirSync(dir, { recursive: true });
  const launch = rel(path.join(WORK, `${tag}-launch.md`));
  fs.writeFileSync(path.join(repoRoot, launch), launchText, 'utf8');
  const reg = path.join(dir, 'clients.json');
  const lead = mode ? [`mode=${mode}`] : [];
  fs.writeFileSync(reg, JSON.stringify({
    schema: 'clients/1',
    clients: {
      [clientName]: {
        binary: 'node', present: true, version: process.version, verifiedOn: '2026-10-05', source: 'node --version',
        command: ['node', FAKE, ...lead, '{workdir}', '{message}'],
        model: { how: 'none', listing: null }, effort: { how: 'none', values: null, note: null }, env: {},
        resume: mode ? { command: ['node', FAKE, ...lead, '{workdir}', '{message}', '--resume={sessionId}'], sessionId: 'printed', note: 'supports resume' }
          : { command: null, sessionId: null, note: 'none' },
        usage: 'none', failureModes: [],
      },
    },
  }), 'utf8');
  const out = rel(path.join(WORK, `${tag}-out.json`));
  const disp = path.join(dir, 'disp.json');
  fs.writeFileSync(disp, JSON.stringify({
    stateDir: rel(path.relative(repoRoot, path.join(dir, 'state'))),
    stallMin: 10, hardMin: 60,
    ...topExtra,
    slots: [{ id: tag, launch, out, route: { client: clientName, model: 'test' }, ...slotExtra }],
  }), 'utf8');
  return { dir, reg, disp, out, launch, runs: path.join(dir, 'RUNS.jsonl'), imports: path.join(dir, 'imports') };
}

function run(s, env = {}) {
  fs.writeFileSync(s.runs, '', 'utf8');
  const r = spawnSync(process.execPath, [DISPATCH_BIN, 'run', s.disp, '--registry', s.reg], {
    cwd: repoRoot, encoding: 'utf8', windowsHide: true,
    env: { ...process.env, TEMP: CHILD_TMP, TMP: CHILD_TMP, TMPDIR: CHILD_TMP, PROTOCOL_RUNS_FILE: s.runs, PROTOCOL_SIGNALS_FILE: path.join(s.dir, 'SIGNALS.md'), PROTOCOL_JOURNAL_IMPORT_ROOT: s.imports, TEST_DISPATCH_OUT_FILE: s.out, ...env },
  });
  const records = fs.existsSync(s.runs) ? fs.readFileSync(s.runs, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
  const outPath = path.join(s.imports, s.out);
  return { code: r.status === null ? -1 : r.status, stdout: r.stdout || '', stderr: r.stderr || '', records, report: fs.existsSync(outPath) ? JSON.parse(fs.readFileSync(outPath, 'utf8')) : null };
}
fs.writeFileSync(path.join(SUITE, 'SIGNALS.md'), '# Signals ledger\n\nAppend-only.\n\n', 'utf8');

const LAUNCH = '# Task\n\nDo the work.\n\n{{PACKET}}\n\nThen stop.\n';
const ON = { PROTOCOL_PACKET_WIRING: '1' };
const SPEC = mode => ({ role: 'implementer', packet: { mode, stage: 'execute' } });

test('slot key packet and packetPolicy are validated', () => {
  const base = { slots: [{ id: 's', launch: 'a.md', route: { client: 'c', model: 'm' }, role: 'implementer', packet: { mode: 'inline', stage: 'execute' } }] };
  assert.doesNotThrow(() => registry.validateDispatch(JSON.parse(JSON.stringify(base))));
  const bad = patch => { const o = JSON.parse(JSON.stringify(base)); patch(o); return () => registry.validateDispatch(o); };
  assert.throws(bad(o => { o.slots[0].packet.mode = 'both'; }), /mode must be "inline" or "pointer"/);
  assert.throws(bad(o => { delete o.slots[0].role; }), /needs a role/);
  assert.throws(bad(o => { o.slots[0].packet.stage = 'Execute!'; }), /stage must be a stage id/);
  assert.throws(bad(o => { o.slots[0].packet.extra = 1; }), /unknown packet key/);
  assert.throws(bad(o => { o.slots[0].packet.frame = '../x.md'; }), /safe relative path/);
  assert.throws(bad(o => { o.packetPolicy = 'maybe'; }), /packetPolicy must be/);
  assert.throws(bad(o => { o.packetPolicy = 'required'; delete o.slots[0].packet; }), /needs a packet key/);
  assert.doesNotThrow(bad(o => { o.packetPolicy = 'required'; }));
});

test('prepare: inline puts the compiled text at the marker; marker problems and compile failures are reasons, not exceptions', () => {
  const s = setup('unit', LAUNCH, SPEC('inline'));
  const slot = JSON.parse(fs.readFileSync(s.disp, 'utf8')).slots[0];
  const ok = packet.prepare(slot, repoRoot, ['claude']);
  assert.equal(ok.ok, true, ok.reason);
  assert.equal(ok.shape, 'inline');
  const text = ok.files[0].text;
  assert.ok(!text.includes('{{PACKET}}') && text.includes('Then stop.') && /^packet: tool=/m.test(text));
  assert.match(ok.packetHash, /^[0-9a-f]{64}$/);
  assert.match(ok.treeSha, /^[0-9a-f]{64}$/);
  fs.writeFileSync(path.join(repoRoot, slot.launch), '# no marker\n');
  assert.match(packet.prepare(slot, repoRoot, ['claude']).reason, /^packet-marker-missing/);
  fs.writeFileSync(path.join(repoRoot, slot.launch), '{{PACKET}}\n{{PACKET}}\n');
  assert.match(packet.prepare(slot, repoRoot, ['claude']).reason, /^packet-marker-multiple/);
  fs.writeFileSync(path.join(repoRoot, slot.launch), LAUNCH);
  const badRole = packet.prepare({ ...slot, role: 'no-such-role' }, repoRoot, ['claude']);
  assert.equal(badRole.ok, false);
  assert.match(badRole.reason, /^packet-compile-failed/);
  assert.match(packet.prepare(slot, repoRoot, ['no-such-client']).reason, /^packet-compile-failed/);
});

test('prepare: pointer shape only for one file-capable client; any other case is inline', () => {
  const s = setup('shape', LAUNCH, SPEC('pointer'));
  const slot = JSON.parse(fs.readFileSync(s.disp, 'utf8')).slots[0];
  const one = packet.prepare(slot, repoRoot, ['claude']);
  assert.equal(one.shape, 'pointer');
  assert.equal(one.files.length, 2);
  assert.match(one.files[0].text, /Compiled instruction: read \.ai\/runtime\/dispatch-packet\/shape\.packet\.md before you start/);
  assert.equal(packet.prepare(slot, repoRoot, ['claude', 'codex']).shape, 'inline', 'two clients: a substitute may not open files');
  assert.equal(packet.prepare(slot, repoRoot, ['kimi']).shape, 'inline', 'a client without file access never gets a pointer');
});

test('switch OFF: the run is identical to a run without the key (message, pins, record); nothing derived is written', () => {
  const withKey = setup('off-key', LAUNCH, SPEC('inline'));
  const without = setup('off-plain', LAUNCH, {});
  const a = run(withKey);
  const b = run(without);
  assert.equal(a.code, 0, a.stdout + a.stderr);
  assert.equal(b.code, 0, b.stdout + b.stderr);
  assert.ok(!/PACKET slot=/.test(a.stdout), 'no packet line while off');
  assert.match(a.report.message, new RegExp(`${withKey.launch.replace(/[.\\/]/g, m => '\\' + m)}`), 'the message points at the original launch file');
  assert.equal(a.report.derivedRel, null);
  assert.deepEqual(a.report.packetFiles, []);
  const pa = a.records[0].pins; const pb = b.records[0].pins;
  assert.equal(pa.corpusHash, null);
  assert.ok(!('packetHash' in pa));
  assert.deepEqual(Object.keys(pa).sort(), Object.keys(pb).sort(), 'the pins have exactly the keys of a run without the feature');
  assert.equal(a.records[0].state, 'DONE');
});

test('switch ON, inline: the agent is pointed at the derived launch file that carries the compiled instruction; the record has the hashes', () => {
  const s = setup('on-inline', LAUNCH, SPEC('inline'));
  const r = run(s, ON);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /^PACKET slot=on-inline shape=inline hash=[0-9a-f]{12} bytes=\d+/m);
  assert.equal(r.report.derivedRel, '.ai/runtime/dispatch-packet/on-inline.launch.md');
  assert.ok(r.report.derivedExists && !r.report.derivedHasMarker && r.report.derivedHasIdentity);
  const pins = r.records[0].pins;
  assert.match(pins.packetHash, /^[0-9a-f]{64}$/);
  assert.match(pins.corpusHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(runrecord.validateRecord ? runrecord.validateRecord(r.records[0]) : [], [], 'the run record still validates');
  const audit = fs.readdirSync(path.join(repoRoot, '.ai', 'runtime', 'packets')).filter(n => n.startsWith('on-inline-execute-'));
  assert.ok(audit.some(n => n.endsWith('.md')) && audit.some(n => n.endsWith('.manifest.json')), 'an audit copy and its manifest exist');
});

test('switch ON, pointer: the derived file holds one pointer line and the packet file is beside it', () => {
  const s = setup('on-pointer', LAUNCH, SPEC('pointer'));
  const r = run(s, ON);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /shape=pointer/);
  assert.deepEqual(r.report.packetFiles, ['on-pointer.launch.md', 'on-pointer.packet.md']);
  assert.match(r.report.derivedHead, /Task|Do the work/);
});

test('switch ON fails closed: compile failure and marker problems BLOCK the slot and launch nothing', () => {
  const cases = [
    ['blocked-role', LAUNCH, { role: 'no-such-role', packet: { mode: 'inline', stage: 'execute' } }, /packet-compile-failed/],
    ['blocked-stage', LAUNCH, { role: 'implementer', packet: { mode: 'inline', stage: 'no-such-stage' } }, /packet-compile-failed/],
    ['blocked-marker', '# no marker here\n', SPEC('inline'), /packet-marker-missing/],
  ];
  for (const [tag, launch, extra, why] of cases) {
    const s = setup(tag, launch, extra);
    const r = run(s, ON);
    assert.equal(r.code, 1, `${tag}: ${r.stdout}`);
    assert.match(r.stdout, new RegExp(`^BLOCKED slot=${tag} class=POLICY_FAILURE reason="`, 'm'));
    assert.match(r.stdout, why);
    assert.equal(r.report, null, `${tag}: the client must not have run`);
    assert.equal(r.records.length, 0, `${tag}: no run record for a launch that never happened`);
  }
});

test('a stale packet hash from an earlier run with the switch on never leaks into a run without it', () => {
  const s = setup('stale', LAUNCH, SPEC('inline'));
  assert.equal(run(s, ON).code, 0);
  const again = run(s, {});
  assert.equal(again.code, 0, again.stdout + again.stderr);
  const last = again.records[again.records.length - 1];
  assert.equal(last.pins.corpusHash, null);
  assert.ok(!('packetHash' in last.pins));
});

test('run record: packetHash must be 64 hex or null', () => {
  const s = setup('rr', LAUNCH, SPEC('inline'));
  const rec = run(s, ON).records[0];
  assert.ok(rec);
  const good = JSON.parse(JSON.stringify(rec));
  const bad = JSON.parse(JSON.stringify(rec)); bad.pins.packetHash = 'xyz';
  const errors = r => (runrecord.validateRecord ? runrecord.validateRecord(r) : []);
  assert.deepEqual(errors(good), []);
  assert.ok(errors(bad).some(e => /packetHash/.test(e)));
});

test('R-1 / OBS-1: a crash-RESUME with the packet on rewrites the derived launch file of the retained workdir; the agent never re-reads a stale copy', () => {
  const s = setup('resume', LAUNCH, SPEC('inline'), {}, 'claude', 'crash-resume');
  const r = run(s, ON);
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const rec = r.records[0];
  assert.equal(rec.state, 'DONE');
  assert.equal(rec.attempts.length, 2, 'a fresh attempt that crashed and one resume');
  assert.equal(rec.attempts[1].kind, 'resume');
  assert.equal(r.report.resumed, true, 'the report comes from the resumed attempt');
  assert.equal(r.report.derivedIsStale, false, 'the stale copy written before the crash was refreshed');
  assert.ok(r.report.derivedExists && !r.report.derivedHasMarker && r.report.derivedHasIdentity, 'the refreshed file carries the compiled instruction');
  assert.match(rec.pins.packetHash, /^[0-9a-f]{64}$/);
});

test('OBS-4: a compiler that reports success without a complete packet fails closed with a reason, never throws', () => {
  const s = setup('contract', LAUNCH, SPEC('inline'));
  const slot = JSON.parse(fs.readFileSync(s.disp, 'utf8')).slots[0];
  for (const broken of [{ exit: 0 }, { exit: 0, text: '' , packetHash: 'sha256:a', treeSha: 'sha256:b', manifest: {} }, { exit: 0, text: 'x', packetHash: 'sha256:a', treeSha: 'sha256:b' }]) {
    const out = packet.prepare(slot, repoRoot, ['claude'], { compiler: { compile: () => broken } });
    assert.equal(out.ok, false);
    assert.match(out.reason, /^packet-compile-failed: the compiler returned exit 0 without a complete packet/);
  }
});

test('OBS-4 / F-001: a null or undefined compiler result (or a thrown null) fails closed with a reason, never throws', () => {
  const s = setup('contract-null', LAUNCH, SPEC('inline'));
  const slot = JSON.parse(fs.readFileSync(s.disp, 'utf8')).slots[0];
  for (const [value, word] of [[null, 'null'], [undefined, 'undefined'], ['ok', 'string'], [7, 'number']]) {
    const out = packet.prepare(slot, repoRoot, ['claude'], { compiler: { compile: () => value } });
    assert.equal(out.ok, false);
    assert.equal(out.reason, `packet-compile-failed: the compiler returned no result (${word})`);
  }
  const thrown = packet.prepare(slot, repoRoot, ['claude'], { compiler: { compile: () => { throw null; } } });
  assert.equal(thrown.ok, false);
  assert.match(thrown.reason, /^packet-compile-failed: null$/);
});

test('OBS-4 / F-002 / F-003: a hostile thrown value or a hostile compiler result is a managed refusal, never a throw', () => {
  const s = setup('contract-hostile', LAUNCH, SPEC('inline'));
  const slot = JSON.parse(fs.readFileSync(s.disp, 'utf8')).slots[0];
  const boom = () => { throw new Error('boom'); };
  const full = { packetHash: 'sha256:a', treeSha: 'sha256:b', manifest: {} };
  const thrown = [
    Object.create(null),
    { message: { toString: boom } },
    { message: null, toString: boom },
    new Proxy({}, { get: boom }),
  ];
  for (const value of thrown) {
    const out = packet.prepare(slot, repoRoot, ['claude'], { compiler: { compile: () => { throw value; } } });
    assert.equal(out.ok, false);
    assert.match(out.reason, /^packet-compile-failed: /);
  }
  const results = [
    { exit: 0, get text() { throw new Error('tg'); }, ...full },
    { get exit() { throw new Error('eg'); } },
    new Proxy({}, { get: boom }),
    { exit: 0, text: 'x', packetHash: 'sha256:a', treeSha: 'sha256:b', manifest: new Proxy({}, { get: boom }) },
    { exit: 3, report: { get reason() { throw new Error('rg'); } } },
    { exit: 3, report: { reason: Object.create(null) } },
  ];
  for (const value of results) {
    const out = packet.prepare(slot, repoRoot, ['claude'], { compiler: { compile: () => value } });
    assert.equal(out.ok, false);
    assert.match(out.reason, /^packet-compile-failed: /);
  }
});

test('SessionStart line: absent by default; one line when its own switch is on; never throws', () => {
  const ctx = env => {
    const saved = { ...process.env };
    Object.assign(process.env, env);
    try { return hooks.context(repoRoot, '.ai/worklog/codex-0000000000000000.md', 'codex'); } finally { process.env = saved; }
  };
  const off = ctx({ PROTOCOL_PACKET_SESSIONSTART: '' });
  assert.ok(!/^Packet:/m.test(off));
  const on = ctx({ PROTOCOL_PACKET_SESSIONSTART: '1', PROTOCOL_PACKET_ROLE: '', PROTOCOL_PACKET_STAGE: '' });
  const lines = on.split('\n').filter(l => l.startsWith('Packet:'));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /treeSha=sha256:[0-9a-f]{64}; compile with: node \.ai\/bin\/protocol-packet\.cjs compile-packet --role <role> --stage <stage>/);
  const withPair = ctx({ PROTOCOL_PACKET_SESSIONSTART: '1', PROTOCOL_PACKET_ROLE: 'implementer', PROTOCOL_PACKET_STAGE: 'execute' });
  assert.match(withPair, /^Packet: role=implementer stage=execute packetHash=sha256:[0-9a-f]{64} treeSha=/m);
  const broken = ctx({ PROTOCOL_PACKET_SESSIONSTART: '1', PROTOCOL_PACKET_ROLE: 'no-such-role', PROTOCOL_PACKET_STAGE: 'execute' });
  assert.match(broken, /^Packet: (compile for role=no-such-role stage=execute failed|not available)/m);
});

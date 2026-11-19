'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const dispatch = require('../.ai/bin/protocol-dispatch.cjs');
const runrecord = require('../.ai/bin/protocol-runrecord.cjs');
const { tt } = require('./helpers.cjs');
// The dispatch executor in this file makes <temp>/colabs-hooks-* (and clones) in-process: this process's temp dir is a fixture dir from here on.
tt.isolateTemp('iso-');

const sourceRoot = path.resolve(__dirname, '..');
const { makeSourceFixture } = require('./test-tmp-source.cjs');
const repoRoot = makeSourceFixture('dispatch-source-');
const DISPATCH_BIN = path.resolve(sourceRoot, '.ai', 'bin', 'protocol-dispatch.cjs');
// neutral synthetic dispatch fixtures: every launch of DISPATCH.json exists, none of MISSING-DISPATCH.json does
const REAL_DISPATCH = path.resolve(repoRoot, 'tests', 'fixtures', 'dispatch-example', 'DISPATCH.json');
const R3_DISPATCH = path.resolve(__dirname, 'fixtures', 'dispatch-example', 'MISSING-DISPATCH.json');

const TEST_TMP_DIR = path.join('.ai', 'runtime', 'dispatch-cli-test');
const testTmpAbs = path.resolve(repoRoot, TEST_TMP_DIR);
fs.mkdirSync(testTmpAbs, { recursive: true });
const DEFAULT_OUT_FILE = path.join(TEST_TMP_DIR, 'out1.txt').replace(/\\/g, '/');

// In-process runner for protocol-dispatch CLI commands.
// Executes internal JSON and argument logic via dispatch.main without spawning an outer process.
async function runInProcess(args, cwd = repoRoot, extraEnv = {}) {
  const origLog = console.log;
  const origErr = console.error;
  let stdout = '';
  let stderr = '';
  console.log = (...msgs) => { stdout += msgs.map(m => typeof m === 'string' ? m : String(m)).join(' ') + '\n'; };
  console.error = (...msgs) => { stderr += msgs.map(m => typeof m === 'string' ? m : String(m)).join(' ') + '\n'; };

  const prevEnv = { ...process.env };
  const prevCwd = process.cwd();
  try {
    Object.assign(process.env, {
      TEST_DISPATCH_OUT_FILE: DEFAULT_OUT_FILE,
      ...extraEnv
    });
    if (cwd && cwd !== prevCwd) {
      process.chdir(cwd);
    }
    const code = await dispatch.main(args);
    return {
      code: code === null || code === undefined ? 0 : code,
      stdout,
      stderr
    };
  } finally {
    console.log = origLog;
    console.error = origErr;
    for (const key of Object.keys(process.env)) {
      if (!(key in prevEnv)) delete process.env[key];
    }
    Object.assign(process.env, prevEnv);
    if (process.cwd() !== prevCwd) {
      try { process.chdir(prevCwd); } catch {}
    }
  }
}

test('T1: no arguments exits 2 with USAGE row', async () => {
  const r = await runInProcess([]);
  assert.equal(r.code, 2);
  assert.match(r.stdout, /^USAGE /m);
});

test('T2: unknown command or flag exits 2 with ERROR row', async () => {
  const r1 = await runInProcess(['unknown-cmd']);
  assert.equal(r1.code, 2);
  assert.match(r1.stdout, /^ERROR reason=unknown-command/m);

  const r2 = await runInProcess(['probe', '--unknown-flag']);
  assert.equal(r2.code, 2);
  assert.match(r2.stdout, /^ERROR reason=unknown-flag/m);
});

test('T3: registry loader validation', () => {
  // Committed registry loads cleanly
  const reg = dispatch.loadRegistry();
  assert.equal(reg.schema, 'clients/1');
  assert.ok(reg.clients.claude);

  // Unknown top-level key exits 2
  assert.throws(() => dispatch.validateRegistry({ schema: 'clients/1', clients: {}, extra: 1 }));

  // Missing required key in client
  assert.throws(() => dispatch.validateRegistry({ schema: 'clients/1', clients: { fake: { binary: 'x' } } }));

  // Wrong type for present
  assert.throws(() => dispatch.validateRegistry({
    schema: 'clients/1',
    clients: {
      fake: {
        binary: 'fake', present: 'yes', version: '1', verifiedOn: '2026-09-26', source: 's',
        command: [], model: {}, effort: {}, env: {}, resume: {}, usage: 'none', failureModes: []
      }
    }
  }));
});

test('T4: dispatch loader validation', async () => {
  // Unknown top-level key
  assert.throws(() => dispatch.validateDispatch({ unknown: 123 }));

  // Unsafe paths
  assert.throws(() => dispatch.validateDispatch({ slots: [{ id: 's1', launch: '../unsafe.md' }] }));
  assert.throws(() => dispatch.validateDispatch({ slots: [{ id: 's1', launch: 'C:/abs.md' }] }));
  assert.throws(() => dispatch.validateDispatch({ slots: [{ id: 's1', launch: 'foo"bar.md' }] }));

  // stallMin / hardMin out of range
  assert.throws(() => dispatch.validateDispatch({ stallMin: 2, slots: [{ id: 's1', launch: 'valid.md' }] }));
  assert.throws(() => dispatch.validateDispatch({ stallMin: 150, slots: [{ id: 's1', launch: 'valid.md' }] }));
  assert.throws(() => dispatch.validateDispatch({ hardMin: 5, slots: [{ id: 's1', launch: 'valid.md' }] }));
  assert.throws(() => dispatch.validateDispatch({ hardMin: 800, slots: [{ id: 's1', launch: 'valid.md' }] }));

  // Missing launch file exits 1 on check
  const tmp = tt.mkTmp('disp-test-');
  const dispPath = path.join(tmp, 'disp.json');
  fs.writeFileSync(dispPath, JSON.stringify({
    slots: [{ id: 's1', launch: 'missing-launch-file.md', route: { client: 'kilo', model: 'deepseek/deepseek-flash', effort: 'high' } }]
  }), 'utf8');

  const r = await runInProcess(['check', dispPath]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^ERROR reason=launch-missing slot=s1 path=missing-launch-file\.md/m);
  fs.rmSync(tmp, { recursive: true, force: true });
});

for (const [client, flag] of Object.entries({ claude: '--effort', codex: '-c', copilot: '--reasoning-effort', kilo: '--variant', mimo: '--variant', cline: '--thinking' })) {
  test(`EFC5: ${client} resume carries the fresh launch effort through its registry flag`, () => {
    const { buildClientCommand } = require('../.ai/bin/protocol-dispatch/clients.cjs');
    const cfg = dispatch.loadRegistry().clients[client];
    for (const effort of [cfg.effort.values.find(value => value !== 'high'), 'high']) {
      const route = { client, effort, model: 'test' };
      const tokens = { ...route, message: 'read wake.md', sessionId: 'session-test', workdir: 'workdir' };
      const expected = client === 'codex' ? `model_reasoning_effort=${effort}` : effort;
      for (const kind of ['fresh', 'resume']) {
        const argv = buildClientCommand(cfg, route, tokens, kind);
        assert.ok(argv.includes(flag), `${kind} needs ${flag}`);
        assert.equal(argv[argv.indexOf(flag) + 1], expected, kind);
        assert.equal(argv.filter(a => a === flag).length, 1, 'one effort flag');
      }
      const explicitMessage = { ...cfg, resume: { command: [...cfg.resume.command, '{message}'] } };
      const argv = buildClientCommand(explicitMessage, route, tokens, 'resume');
      const timeout = require('../.ai/bin/lib/client-command-timeout.cjs');
      const message = timeout.append(tokens.message, timeout.forConfig(cfg));
      assert.equal(argv.at(-1), message, 'the trailing message retains the actual timeout policy');
      assert.equal(argv.filter(a => a === message).length, 1, 'one trailing message');
      assert.ok(argv.indexOf(flag) < argv.indexOf(message), 'resume options precede the trailing message');
      const existingItem = { ...cfg, resume: { command: [...cfg.resume.command, cfg.command.find(i => i?.if === 'effort')] } };
      assert.equal(buildClientCommand(existingItem, route, tokens, 'resume').filter(a => a === flag).length, 1);
      assert.throws(() => buildClientCommand(cfg, { client }, tokens, 'resume'), /effort is required/);
      assert.throws(() => buildClientCommand(cfg, { client, effort: 'invalid' }, tokens, 'resume'), /is not in/);
    }
  });
}

test('EFC5: owner route validation rejects capable clients without effort, including fallback routes', async () => {
  const registry = dispatch.loadRegistry();
  for (const client of ['claude', 'codex', 'copilot', 'kilo', 'mimo', 'cline']) {
    const slot = { id: 'owner', launch: 'launch.md', route: { client, model: 'test' } };
    assert.throws(() => dispatch.validateDispatch({ slots: [slot] }, registry), /effort-refused:.*effort is required/);
    slot.route.effort = 'high';
    assert.doesNotThrow(() => dispatch.validateDispatch({ slots: [slot] }, registry));
    slot.fallback = [{ client, model: 'test' }];
    assert.throws(() => dispatch.validateDispatch({ slots: [slot] }, registry), /effort-refused/);
  }
  const tmp = tt.mkTmp('efc5-owner-');
  const file = path.join(tmp, 'dispatch.json');
  fs.writeFileSync(file, JSON.stringify({ slots: [{ id: 'owner', launch: 'launch.md', route: { client: 'codex' } }] }));
  const result = await runInProcess(['check', file]);
  assert.equal(result.code, 2);
  assert.match(result.stdout, /effort-refused:.*effort is required/);
});

test('EFC5: missing effort template is refused before a resume can claim effortUsed', () => {
  const { buildClientCommand, effortArgs } = require('../.ai/bin/protocol-dispatch/clients.cjs');
  const cfg = structuredClone(dispatch.loadRegistry().clients.codex);
  cfg.command = cfg.command.filter(i => i?.if !== 'effort');
  const result = effortArgs('codex', 'high', { clients: { codex: cfg } }, { requireTemplate: true });
  assert.equal(result.ok, false);
  assert.equal(result.effortUsed, null);
  assert.match(result.error, /effort-template-missing/);
  assert.throws(() => buildClientCommand(cfg, { client: 'codex', effort: 'high' }, {}, 'resume'), /effort-template-missing/);
});

test('EFC5: direct resume refuses missing effort before probing an absent binary', async () => {
  const cfg = structuredClone(dispatch.loadRegistry().clients.codex);
  cfg.binary = 'efc5-client-must-never-spawn';
  const result = await dispatch.executeAttempt({ id: 'refused', route: { client: 'codex' } }, 1, {}, { clients: { codex: cfg } }, { repoRoot: testTmpAbs, attemptKind: 'resume' });
  assert.equal(result.class, 'CONFIG_ERROR');
  assert.match(result.reason, /effort-refused:.*effort is required/);
  assert.equal(result.effortUsed, null);
});

test('EFM15: effort validation precedes selected Cline proxy admission without executor writes', async t => {
  const root = tt.mkTmp('disp-proxy-effort-');
  const cli = require('../.ai/bin/protocol-dispatch/cli.cjs');
  const health = require('../.ai/bin/ops-tools/proxy-health.cjs');
  const registryFile = path.join(sourceRoot, '.ai/docs/clients.json');
  const file = path.join(root, 'dispatch.json');
  const selected = { id: 'selected', launch: 'task.md', route: { client: 'cline', provider: 'openai-compatible', model: 'fixture-model', effort: 'high' } };
  const other = { ...selected, id: 'other' };
  const calls = [];
  t.mock.method(health, 'waitForProxy', async options => {
    calls.push(options);
    return { ok: false, reason: 'PROXY_DOWN' };
  });
  const write = slots => fs.writeFileSync(file, JSON.stringify({ slots, stateDir: 'absent-state' }));
  const options = { repoRoot: root, registry: registryFile, proxyWaitMs: 17 };
  fs.writeFileSync(path.join(root, 'protocol-manifest.json'), '{}');
  for (const effort of [undefined, 'invalid']) {
    write([{ ...selected, route: { ...selected.route, effort } }]);
    await assert.rejects(cli.runDispatch(file, [], options), /effort-refused:/);
    const refusal = await dispatch.executeAttempt({ ...selected, route: { ...selected.route, effort } }, 1, {}, dispatch.loadRegistry(registryFile), options);
    assert.equal(refusal.status, 'FAILED');
    assert.equal(refusal.class, 'CONFIG_ERROR');
    assert.match(refusal.reason, /effort-refused:/);
    assert.equal(refusal.effortUsed, null);
    assert.equal(calls.length, 0);
  }
  const brokenRegistry = dispatch.loadRegistry(registryFile);
  brokenRegistry.clients.cline.command = brokenRegistry.clients.cline.command.filter(item => item?.if !== 'effort');
  const missingTemplate = await dispatch.executeAttempt(selected, 1, {}, brokenRegistry, options);
  assert.equal(missingTemplate.class, 'CONFIG_ERROR');
  assert.match(missingTemplate.reason, /effort-template-missing:/);
  assert.equal(missingTemplate.effortUsed, null);
  const unknown = await dispatch.executeAttempt(selected, 1, {}, { clients: {} }, options);
  assert.equal(unknown.class, 'CONFIG_ERROR');
  assert.equal(unknown.reason, 'unknown client cline');
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(root, '.ai/runtime/dispatch')), false);
  write([{ ...selected, fallback: [{ ...selected.route, effort: undefined }] }]);
  await assert.rejects(cli.runDispatch(file, [], options), /effort-refused:/);
  assert.equal(calls.length, 0);
  write([other, selected]);
  assert.equal(await cli.runDispatch(file, ['selected'], options), 3);
  assert.equal(calls.length, 1);
  const gate = calls[0];
  assert.equal(gate.client, 'cline');
  assert.equal(gate.provider, 'openai-compatible');
  assert.equal(gate.model, 'fixture-model');
  assert.equal(gate.waitMs, 17);
  assert.equal(gate.argv.filter(a => a === '--thinking').length, 1);
  assert.equal(gate.argv[gate.argv.indexOf('--thinking') + 1], 'high');
  assert.equal(gate.argv[gate.argv.indexOf('-P') + 1], 'openai-compatible');
  assert.equal(gate.argv[gate.argv.indexOf('-m') + 1], 'fixture-model');
  assert.ok(gate.argv.indexOf('--thinking') < gate.argv.length - 1);
  assert.match(gate.argv.at(-1), /COMMAND-TIMEOUT-BEGIN/);
  assert.equal(fs.existsSync(path.join(root, 'absent-state')), false);
});

test('T5: check parity: DISPATCH.json exits 0, MISSING-DISPATCH.json exits 1 with 10 launch-missing rows', async () => {
  const tmpRoot = tt.mkTmp('disp-t5-');
  try {
    const targetDir = path.join(tmpRoot, 'docs', 'example-run', 'prompts');
    fs.mkdirSync(path.dirname(targetDir), { recursive: true });
    fs.cpSync(path.resolve(repoRoot, 'tests', 'fixtures', 'dispatch-example'), targetDir, { recursive: true });

    const copiedDispatch = path.join(targetDir, 'DISPATCH.json');
    const r1 = await runInProcess(['check', copiedDispatch], tmpRoot);
    assert.equal(r1.code, 0);
    const expectedSlots = JSON.parse(fs.readFileSync(REAL_DISPATCH, 'utf8')).slots.length;
    assert.match(r1.stdout, new RegExp(`^CHECK dispatch=.* slots=${expectedSlots}`, 'm'));

    const r2 = await runInProcess(['check', R3_DISPATCH], tmpRoot);
    assert.equal(r2.code, 1);
    assert.match(r2.stdout, /^CHECK dispatch=.* slots=10/m);
    const missingRows = r2.stdout.trim().split(/\r?\n/).filter(l => l.startsWith('ERROR reason=launch-missing'));
    assert.equal(missingRows.length, 10);
    assert.ok(!r2.stdout.includes('ERROR reason=unknown-'));
  } finally {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
  }
});

test('T11: credential canaries absent from child env, GIT_CONFIG_NOSYSTEM=1 present', () => {
  const canaryParent = {
    ...process.env,
    GH_TOKEN: 'canary-gh',
    GITHUB_TOKEN: 'canary-github',
    X_GIT_TOKEN: 'canary-x-git',
    SSH_AUTH_SOCK: 'canary-sock',
    CUSTOM_VAR: 'preserved'
  };

  const childEnv = dispatch.executorEnv(canaryParent);
  assert.equal(childEnv.GH_TOKEN, undefined);
  assert.equal(childEnv.GITHUB_TOKEN, undefined);
  assert.equal(childEnv.X_GIT_TOKEN, undefined);
  assert.equal(childEnv.SSH_AUTH_SOCK, undefined);
  assert.equal(childEnv.GIT_CONFIG_NOSYSTEM, '1');
  assert.equal(childEnv.CUSTOM_VAR, 'preserved');
});

test('T14: failure classification and bare-number guards', () => {
  // Each failure class is recognized from matching samples
  assert.equal(dispatch.classifyErrorText('HTTP 401 Unauthorized'), 'AUTH_ERROR');
  assert.equal(dispatch.classifyErrorText('status 403 Forbidden: authentication failed'), 'AUTH_ERROR');
  assert.equal(dispatch.classifyErrorText('HTTP 429 Too Many Requests: rate limit exceeded'), 'RATE_LIMIT');
  assert.equal(dispatch.classifyErrorText('quota exceeded for current billing period; RESOURCE_EXHAUSTED'), 'QUOTA_EXHAUSTED');
  assert.equal(dispatch.classifyErrorText('model gpt-5.9 not found on server'), 'MODEL_UNAVAILABLE');
  assert.equal(dispatch.classifyErrorText('FetchError: ECONNRESET network error'), 'NETWORK_ERROR');
  assert.equal(dispatch.classifyErrorText('HTTP 503 Service Unavailable: overloaded_error'), 'PROVIDER_ERROR');

  // Bare-number guards: "line 503" and "429 tokens" must NOT match!
  assert.equal(dispatch.classifyErrorText('Compilation error at line 503 in main.rs'), null);
  assert.equal(dispatch.classifyErrorText('Prompt processed: 429 tokens used successfully'), null);
});

test('T15: needs and when skipping rules', async () => {
  const tmp = tt.mkTmp('disp-when-');
  const launchFile = path.join(TEST_TMP_DIR, 'when-launch.md').replace(/\\/g, '/');
  const checkRel = path.join(TEST_TMP_DIR, 'flag.txt').replace(/\\/g, '/');
  const checkFile = path.resolve(repoRoot, checkRel);

  try {
    fs.mkdirSync(path.dirname(path.resolve(repoRoot, launchFile)), { recursive: true });
    fs.writeFileSync(path.resolve(repoRoot, launchFile), '# When launch\n', 'utf8');
    fs.writeFileSync(checkFile, 'DONE_ALREADY', 'utf8');

    const dispPath = path.join(tmp, 'disp-when.json');
    fs.writeFileSync(dispPath, JSON.stringify({
      stateDir: path.relative(repoRoot, path.join(tmp, 'state')).replace(/\\/g, '/'),
      slots: [
        {
          id: 's-skipped',
          launch: launchFile,
          when: {
            file: checkRel,
            notMatch: 'DONE_ALREADY'
          },
          route: { client: 'kilo', model: 'deepseek/deepseek-flash', effort: 'high' }
        },
        {
          id: 's-waiting',
          launch: launchFile,
          needs: ['s-unmet-dep'],
          route: { client: 'kilo', model: 'deepseek/deepseek-flash', effort: 'high' }
        }
      ]
    }), 'utf8');

    const r = await runInProcess(['run', dispPath]);
    assert.match(r.stdout, /^SKIP slot=s-skipped reason=when-matched/m);
    assert.match(r.stdout, /^WAIT slot=s-waiting reason=needs/m);
  } finally {
    try { fs.unlinkSync(checkFile); } catch {}
    try { fs.unlinkSync(path.resolve(repoRoot, launchFile)); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('T17: probe command output and exits', async () => {
  const tmp = tt.mkTmp('disp-probe-');
  const fakeRegPath = path.join(tmp, 'clients.json');
  fs.writeFileSync(fakeRegPath, JSON.stringify({
    schema: 'clients/1',
    clients: {
      c_ok: {
        binary: 'node',
        present: true,
        version: process.version,
        verifiedOn: '2026-09-26',
        source: 'node --version',
        command: ['node'],
        model: { how: 'none', listing: null },
        effort: { how: 'none', values: null, note: null },
        env: {},
        resume: { command: null, sessionId: null, note: 'none' },
        usage: 'none',
        failureModes: []
      },
      c_absent: {
        binary: 'nonexistent_bin_123456789',
        present: true,
        version: '1.0',
        verifiedOn: '2026-09-26',
        source: 's',
        command: ['nonexistent_bin_123456789'],
        model: { how: 'none', listing: null },
        effort: { how: 'none', values: null, note: null },
        env: {},
        resume: { command: null, sessionId: null, note: 'none' },
        usage: 'none',
        failureModes: []
      },
      c_changed: {
        binary: 'node',
        present: true,
        version: 'wrong-version-999',
        verifiedOn: '2026-09-26',
        source: 's',
        command: ['node'],
        model: { how: 'none', listing: null },
        effort: { how: 'none', values: null, note: null },
        env: {},
        resume: { command: null, sessionId: null, note: 'none' },
        usage: 'none',
        failureModes: []
      }
    }
  }), 'utf8');

  const rOk = await runInProcess(['probe', '--registry', fakeRegPath, 'c_ok']);
  assert.equal(rOk.code, 0);
  assert.match(rOk.stdout, /^PROBE client=c_ok state=OK/m);

  const rAbsent = await runInProcess(['probe', '--registry', fakeRegPath, 'c_absent']);
  assert.equal(rAbsent.code, 1);
  assert.match(rAbsent.stdout, /^PROBE client=c_absent state=ABSENT/m);

  const rChanged = await runInProcess(['probe', '--registry', fakeRegPath, 'c_changed']);
  assert.equal(rChanged.code, 1);
  assert.match(rChanged.stdout, /^PROBE client=c_changed state=VERSION_CHANGED/m);

  fs.rmSync(tmp, { recursive: true, force: true });
});

test('T18: every stdout line matches uppercase token format', async () => {
  const lines = [
    (await runInProcess([])).stdout,
    (await runInProcess(['unknown-cmd'])).stdout,
    (await runInProcess(['probe', '--unknown-flag'])).stdout,
    (await runInProcess(['check', REAL_DISPATCH])).stdout,
    (await runInProcess(['check', R3_DISPATCH])).stdout
  ].join('').trim().split(/\r?\n/).filter(Boolean);

  const tokenRe = /^(USAGE|ERROR|CHECK|PROBE|DISPATCH|ATTEMPT|DONE|BLOCKED|FALLEN|WAIT|SKIP|REPAIR|START|STATUS|REPORT)\b/;
  for (const l of lines) {
    assert.match(l, tokenRe, `line does not match uppercase token format: ${l}`);
  }
});

test('T19: no dispatch leaf names a research path; pointer template exactly once', () => {
  // The split moved the script body into .ai/bin/protocol-dispatch/ leaves; the
  // pointer template now lives in the procfs leaf. The pin follows the text.
  const leafDir = path.join(repoRoot, '.ai', 'bin', 'protocol-dispatch');
  let code = fs.readFileSync(DISPATCH_BIN, 'utf8');
  for (const name of fs.readdirSync(leafDir).filter(n => n.endsWith('.cjs'))) {
    code += '\n' + fs.readFileSync(path.join(leafDir, name), 'utf8');
  }
  // The product ships no research corpus, so no dispatch leaf may name a
  // path of one; the ban covers every corpus path.
  const researchPaths = code.match(/docs\/research\/[a-zA-Z0-9._/-]+/g) || [];
  assert.deepEqual(researchPaths, []);
  const matches = code.match(/Read and follow the file /g) || [];
  assert.equal(matches.length, 1, 'pointer template must appear exactly once');
});

// The cost rules of one slot and of the dispatch, as an oracle over one compiled module.
const costRules = ({ slotCost, addCumulativeCost }) => {
  const run = (amount, unit = 'tokens') => ({ usage: amount === null ? null : { amount, unit } });
  const unknown = { actual: null, unit: null };
  assert.deepEqual(slotCost([run(1000), run(2500)]), { actual: 3500, unit: 'tokens' });
  assert.deepEqual(slotCost([run(1000), run(null)]), unknown, 'an attempt with no usage leaves the slot unknown');
  assert.deepEqual(slotCost([run(1000), {}]), unknown);
  assert.deepEqual(slotCost([run(1000), run(NaN)]), unknown);
  assert.deepEqual(slotCost([run(1000), run(Infinity)]), unknown);
  assert.deepEqual(slotCost([run(1e308), run(1e308)]), unknown, 'a sum that is not finite is unknown');
  assert.deepEqual(slotCost([run(10, 'USD'), run(5, 'credits')]), unknown);
  assert.deepEqual(slotCost([run(10, 'USD'), run(5, null)]), unknown, 'an amount without a unit is not in the unit of the sum');
  assert.deepEqual(slotCost([]), unknown);

  const empty = { sum: 0, unit: null, unknown: false };
  let total = addCumulativeCost(empty, { actual: 3500, unit: 'tokens' }, 2);
  assert.deepEqual(total, { sum: 3500, unit: 'tokens', unknown: false });
  assert.deepEqual(addCumulativeCost(total, unknown, 0), total, 'a slot without attempts adds nothing');
  total = addCumulativeCost(total, { actual: 500, unit: 'tokens' }, 1);
  assert.deepEqual(total, { sum: 4000, unit: 'tokens', unknown: false });
  const after = addCumulativeCost(total, unknown, 1);
  assert.equal(after.unknown, true, 'a slot of unknown cost makes the cumulative cost unknown');
  assert.equal(addCumulativeCost(after, { actual: 10, unit: 'tokens' }, 1).unknown, true, 'a later known slot does not revive it');
  assert.equal(addCumulativeCost(total, { actual: 10, unit: 'USD' }, 1).unknown, true, 'another unit makes it unknown');
  assert.equal(addCumulativeCost(empty, unknown, 1).unknown, true, 'the first slot already counts');
  assert.equal(addCumulativeCost({ sum: 1e308, unit: 'tokens', unknown: false }, { actual: 1e308, unit: 'tokens' }, 1).unknown, true,
    'a cumulative sum that is not finite is unknown');
};

const CLI_FILE = path.join(sourceRoot, '.ai', 'bin', 'protocol-dispatch', 'cli.cjs');
// The run command compiled with one change, at its own path so its requires resolve as in the repository.
function cliMutant(from, to) {
  const Module = require('node:module');
  const text = fs.readFileSync(CLI_FILE, 'utf8');
  assert.equal(text.split(from).length, 2, 'unique mutant anchor');
  const m = new Module(CLI_FILE, module); m.filename = CLI_FILE;
  m.paths = Module._nodeModulePaths(path.dirname(CLI_FILE));
  m._compile(text.replace(from, () => to), CLI_FILE);
  return m.exports;
}

test('T27b: slot and dispatch cost: an attempt without a measured amount makes the cost unknown, never a partial sum', () => {
  costRules(require('../.ai/bin/protocol-dispatch/cli.cjs'));
});

for (const [label, from, to] of [
  ['the measured attempts alone are summed', 'if (!measured.length || measured.length !== attempts.length)', 'if (!measured.length)'],
  ['a slot cost that is not finite is written', 'return Number.isFinite(sum) ? { actual: Number(sum.toFixed(6)), unit: [...units][0] } : { actual: null, unit: null };',
    'return { actual: Number(sum.toFixed(6)), unit: [...units][0] };'],
  ['a slot of unknown cost is skipped in the cumulative cost', 'if (cost.actual === null) return attemptCount > 0 ? { ...total, unknown: true } : total;', 'if (cost.actual === null) return total;'],
  ['another unit joins the cumulative sum', 'if (total.unit !== cost.unit) return { ...total, unknown: true };', 'if (false) return { ...total, unknown: true };'],
  ['a cumulative sum that is not finite is written', 'return Number.isFinite(sum) ? { sum, unit: total.unit, unknown: false } : { ...total, unknown: true };',
    'return { sum, unit: total.unit, unknown: false };'],
]) {
  test(`T27b mutant killed: ${label}`, () => {
    costRules(require('../.ai/bin/protocol-dispatch/cli.cjs'));
    assert.throws(() => costRules(cliMutant(from, to)), assert.AssertionError);
  });
}

test('T27: AC-usage: parse attempt usage from log across all parsers and negative patterns', () => {
  const usageFixturesDir = path.resolve(__dirname, 'fixtures', 'dispatch', 'usage');

  // 1. Kilo parser (kilo-json)
  const kiloRes = dispatch.parseUsageFromLog(path.join(usageFixturesDir, 'kilo.log'), 'kilo-json');
  assert.equal(kiloRes.found, true);
  assert.equal(kiloRes.usage.amount, 0.005);
  assert.equal(kiloRes.usage.unit, 'USD');
  assert.deepEqual(kiloRes.tokens, { in: 200, out: 100, source: 'client-output' });

  // 2. MiMo parser (kilo-json)
  const mimoRes = dispatch.parseUsageFromLog(path.join(usageFixturesDir, 'mimo.log'), 'kilo-json');
  assert.equal(mimoRes.found, true);
  assert.equal(mimoRes.usage.amount, 0.02);
  assert.equal(mimoRes.usage.unit, 'USD');
  assert.deepEqual(mimoRes.tokens, { in: 450, out: 150, source: 'client-output' });

  // 3. Copilot credits (AI Credits 12.5)
  const copilotRes = dispatch.parseUsageFromLog(path.join(usageFixturesDir, 'copilot.log'), 'copilot-credits');
  assert.equal(copilotRes.found, true);
  assert.equal(copilotRes.usage.amount, 12.5);
  assert.equal(copilotRes.usage.unit, 'credits');
  assert.deepEqual(copilotRes.tokens, { in: null, out: null, source: 'none' });

  // 4. Codex tokens (tokens used\n12,345)
  const codexRes = dispatch.parseUsageFromLog(path.join(usageFixturesDir, 'codex.log'), 'codex-tokens');
  assert.equal(codexRes.found, true);
  assert.equal(codexRes.usage.amount, 12345);
  assert.equal(codexRes.usage.unit, 'tokens');
  assert.deepEqual(codexRes.tokens, { in: null, out: null, source: 'none' });

  // 5. Negative patterns: "line 503" and "429 tokens" must NOT be parsed as usage
  for (const parser of ['codex-tokens', 'copilot-credits', 'kilo-json']) {
    const negRes = dispatch.parseUsageFromLog(path.join(usageFixturesDir, 'negative.log'), parser);
    assert.equal(negRes.found, false, `negative.log should not match parser ${parser}`);
    assert.equal(negRes.usage.amount, null);
    assert.equal(negRes.usage.unit, null);
    assert.deepEqual(negRes.tokens, { in: null, out: null, source: 'none' });
  }

  // 6. Log without usage
  for (const parser of ['codex-tokens', 'copilot-credits', 'kilo-json']) {
    const noRes = dispatch.parseUsageFromLog(path.join(usageFixturesDir, 'no-usage.log'), parser);
    assert.equal(noRes.found, false);
    assert.equal(noRes.usage.amount, null);
    assert.equal(noRes.usage.unit, null);
    assert.deepEqual(noRes.tokens, { in: null, out: null, source: 'none' });
  }

  // 7. usage=none client
  const noneRes = dispatch.parseUsageFromLog(path.join(usageFixturesDir, 'codex.log'), 'none');
  assert.equal(noneRes.found, false);
  assert.equal(noneRes.usage.amount, null);
  assert.equal(noneRes.usage.unit, null);
  assert.deepEqual(noneRes.tokens, { in: null, out: null, source: 'none' });
});

test('AC-usage: a figure a step does not state stays unknown; a partial sum is never presented as complete', () => {
  const tmp = tt.mkTmp('kilo-usage-partial-');
  const parse = events => {
    const p = path.join(tmp, 'partial.jsonl');
    fs.writeFileSync(p, events.map(e => JSON.stringify(e)).join(String.fromCharCode(10)) + String.fromCharCode(10), 'utf8');
    return dispatch.parseUsageFromLog(p, 'kilo-json');
  };
  const input = parse([{ type: 'step-finish', tokens: { input: 7 } }]);
  assert.deepEqual(input.tokens, { in: 7, out: null, source: 'client-output' }, 'a missing output is null, not 0');
  assert.deepEqual(input.usage, { amount: null, unit: null }, 'no cost stated, none invented');
  const partial = parse([{ type: 'step-finish', cost: 1, tokens: { input: 3, output: 5 } }, { type: 'step-finish', tokens: { input: 4 } }]);
  assert.deepEqual(partial.usage, { amount: null, unit: null }, 'one step without cost: the sum of the others is not the cost');
  assert.deepEqual(partial.tokens, { in: 7, out: null, source: 'client-output' }, 'input is complete, output is not');
  const complete = parse([{ type: 'step-finish', cost: 1, tokens: { input: 3, output: 5 } }, { type: 'step-finish', cost: 0.5, tokens: { input: 4, output: 6 } }]);
  assert.deepEqual(complete.tokens, { in: 7, out: 11, source: 'client-output' });
  assert.deepEqual(complete.usage, { amount: 1.5, unit: 'USD' });
  const zero = parse([{ type: 'step-finish', cost: 0, tokens: { input: 0, output: 0 } }]);
  assert.deepEqual([zero.usage.amount, zero.tokens.in, zero.tokens.out], [0, 0, 0], 'a stated zero stays a zero');
  const nothing = parse([{ type: 'step-finish' }]);
  assert.equal(nothing.found, false);
  assert.deepEqual(nothing.tokens, { in: null, out: null, source: 'none' });
});

test('AC-usage: a negative or non-finite figure measures nothing; values never cancel into a complete total', () => {
  const tmp = tt.mkTmp('usage-unmeasured-');
  const parse = (text, parser) => {
    const p = path.join(tmp, 'usage.log');
    fs.writeFileSync(p, text, 'utf8');
    return dispatch.parseUsageFromLog(p, parser);
  };
  const kilo = lines => parse(lines.join(String.fromCharCode(10)) + String.fromCharCode(10), 'kilo-json');
  const cancel = kilo(['{"type":"step-finish","cost":1,"tokens":{"input":3,"output":2}}', '{"type":"step-finish","cost":-1,"tokens":{"input":-3,"output":2}}']);
  assert.deepEqual(cancel.usage, { amount: null, unit: null }, 'cost 1 and -1 is no measured total of 0');
  assert.deepEqual(cancel.tokens, { in: null, out: 4, source: 'client-output' }, 'input 3 and -3 is unknown; the stated output stays');
  const infinite = kilo(['{"type":"step-finish","cost":1e999,"tokens":{"input":1e999}}']);
  assert.equal(infinite.found, false, 'an infinity is no measurement');
  assert.deepEqual([infinite.usage.amount, infinite.tokens.in], [null, null]);
  const overflow = kilo(['{"type":"step-finish","cost":1e308}', '{"type":"step-finish","cost":1e308}']);
  assert.deepEqual(overflow.usage, { amount: null, unit: null }, 'a total that is not finite is unknown');
  const huge = '9'.repeat(400);
  for (const [parser, text] of [['copilot-credits', `AI Credits 2\nAI Credits ${huge}\n`], ['codex-tokens', `tokens used: 10\ntokens used: ${huge}\n`]]) {
    const r = parse(text, parser);
    assert.equal(r.found, false, parser);
    assert.equal(r.usage.amount, null, parser);
  }
  assert.equal(parse('AI Credits 2\nAI Credits 0.5\n', 'copilot-credits').usage.amount, 2.5, 'finite credits still add up');
});

test('AC-usage (PUB-FIX4 pfx4e): a text figure is one whole token; a numeric prefix, a sign or a broken group measures nothing', () => {
  const tmp = tt.mkTmp('usage-token-');
  const amount = (text, parser) => {
    const p = path.join(tmp, 'usage.log');
    fs.writeFileSync(p, text + '\n', 'utf8');
    const r = dispatch.parseUsageFromLog(p, parser);
    return r.found ? r.usage.amount : null;
  };
  // Sol p4s904 F3: a figure that starts like a number and is not one leaves the total unknown, never its prefix or the rest.
  for (const text of ['AI Credits 1e5', 'AI Credits 1.2.3', 'AI Credits 2\nAI Credits -1', 'AI Credits +3', 'AI Credits 12.5,', 'AI Credits .5', 'AI Credits 0x10', 'AI Credits 2\nAI Credits 3credits']) {
    assert.equal(amount(text, 'copilot-credits'), null, JSON.stringify(text));
  }
  for (const [text, expected] of [['AI Credits 12.5', 12.5], ['AI Credits 0', 0], ['AI Credits 2\nAI Credits 0.5', 2.5], ['AI Credits used: none', null]]) {
    assert.equal(amount(text, 'copilot-credits'), expected, JSON.stringify(text));
  }
  for (const text of ['tokens used: 1.5', 'tokens used: 1e5', 'tokens used: 2\ntokens used: -1', 'tokens used: 10 64', 'tokens used: 1,23,456', 'tokens used: 10,644.5',
    'tokens used: 12 345 total', 'tokens used\n10 644,000', 'tokens used: 1.5.K', 'tokens used: 1.234K', 'tokens used: +7']) {
    assert.equal(amount(text, 'codex-tokens'), null, JSON.stringify(text));
  }
  for (const [text, expected] of [['tokens used: 10 644', 10644], ['tokens used\n12,345', 12345], ['tokens used: 1 234 567', 1234567], ['tokens used: 7', 7],
    ['tokens used: 10k', 10000], ['tokens used: 10 k', 10000], ['tokens used: 1.5K', 1500], ['tokens used: 2,5M', 2500000], ['tokens used successfully', null]]) {
    assert.equal(amount(text, 'codex-tokens'), expected, JSON.stringify(text));
  }
  // Sol p5s915 F3: every label row has a figure; a split number, a word, a Unicode minus or a count beyond the safe range is no
  // figure, and a valid row before it never reads as the whole total.
  for (const text of ['AI Credits 1 234', 'AI Credits 1\u00A0234', 'AI Credits 2\nAI Credits unknown', 'AI Credits 2\nAI Credits NaN',
    'AI Credits 2\nAI Credits \u22121', 'AI Credits 9007199254740993']) {
    assert.equal(amount(text, 'copilot-credits'), null, JSON.stringify(text));
  }
  for (const [text, expected] of [['AI Credits 12.5 (premium)', 12.5], ['AI Credits 2\nAI Credits 0.5 used', 2.5]]) {
    assert.equal(amount(text, 'copilot-credits'), expected, JSON.stringify(text));
  }
  for (const text of ['tokens used: 2\ntokens used: unknown', 'tokens used: 2\ntokens used: \u22121', 'tokens used: 2\ntokens used \u22121', 'tokens used: 9007199254740993',
    'tokens used: 9,007,199,254,740,993', 'tokens used: 9007199254740991\ntokens used: 1', 'tokens used: 2\ntokens used\nNaN', 'tokens used: 2\ntokens used:']) {
    assert.equal(amount(text, 'codex-tokens'), null, JSON.stringify(text));
  }
  for (const [text, expected] of [['tokens used: 2\nthe tokens used successfully', 2], ['tokens used:\n1,234', 1234], ['tokens used\n\n12,345', 12345], ['tokens used: 9007199254740991', 9007199254740991]]) {
    assert.equal(amount(text, 'codex-tokens'), expected, JSON.stringify(text));
  }
  // the kilo step tokens are whole counts too: a fraction or a rounded huge number leaves that figure unknown
  const kilo = lines => { const p = path.join(tmp, 'kilo.log'); fs.writeFileSync(p, lines.join('\n') + '\n', 'utf8'); return dispatch.parseUsageFromLog(p, 'kilo-json'); };
  assert.deepEqual(kilo(['{"type":"step-finish","cost":1,"tokens":{"input":0.4,"output":2}}']).tokens, { in: null, out: 2, source: 'client-output' });
  assert.deepEqual(kilo(['{"type":"step-finish","tokens":{"input":0.4,"output":2}}', '{"type":"step-finish","tokens":{"input":0.6,"output":2}}']).tokens,
    { in: null, out: 4, source: 'client-output' }, 'two fractions are no whole count even when they sum to one');
  assert.deepEqual(kilo(['{"type":"step-finish","cost":1,"tokens":{"input":3,"output":9007199254740993}}']).tokens, { in: 3, out: null, source: 'client-output' });
  assert.deepEqual(kilo(['{"type":"step-finish","tokens":{"input":9007199254740991,"output":1}}', '{"type":"step-finish","tokens":{"input":1,"output":1}}']).tokens,
    { in: null, out: 2, source: 'client-output' }, 'a sum beyond the safe range is unknown');
});

test('AC-usage (PUB-FIX4 pfx4g): every whitespace splits a copilot figure; the two codex readers share one label and one count rule', () => {
  const tmp = tt.mkTmp('usage-pfx4g-');
  const banner = require('../.ai/bin/accounting/lib/client-usage.cjs');
  const amount = (text, parser) => {
    const p = path.join(tmp, 'usage.log');
    fs.writeFileSync(p, text + '\n', 'utf8');
    const r = dispatch.parseUsageFromLog(p, parser);
    return r.found ? r.usage.amount : null;
  };
  // DeepSeek p6d942 C: a number split by any JavaScript whitespace is no figure, never its first group.
  for (const ch of ['\u2009', '\u3000', '\u2028', '\u2029', '\u1680', '\u2000', '\u200A', '\u205F', '\uFEFF', '\u000B', '\u000C']) {
    assert.equal(amount(`AI Credits 1${ch}234`, 'copilot-credits'), null, JSON.stringify(ch));
    assert.equal(amount(`AI Credits 2\nAI Credits 1${ch}234`, 'copilot-credits'), null, JSON.stringify(ch));
  }
  assert.equal(amount('AI Credits 1\u2009(premium)', 'copilot-credits'), 1, 'a word after the space stays a note');
  // Sol p6s940 F3: every label has its figure; an empty last label, spaces only, glued text or a second label on the line.
  for (const text of ['AI Credits 2\nAI Credits', 'AI Credits 2\nAI Credits \t', 'AI Credits 2 AI Credits unknown', 'AI Credits 2\nAI Credits:', 'AI Credits 2\nAI Credits1']) {
    assert.equal(amount(text, 'copilot-credits'), null, JSON.stringify(text));
  }
  assert.equal(amount('AI Credits 2 AI Credits 3', 'copilot-credits'), 5, 'two labels on one line are two figures');
  assert.equal(amount('tokens used: 2\ntokens used\u00a0-1', 'codex-tokens'), null, 'Sol p6s940 O06');
  assert.equal(amount('tokens used: 2\ntokens used\u202f3', 'codex-tokens'), 5, 'Sol p6s940 O07');
  assert.equal(banner.fromCodexOutput('tokens used\n123\nanswer\ntokens used\u00a0\nunknown\n').tokens, null, 'Sol p6s940 O15');
  // DeepSeek p6d942 D: one label rule and one count rule; a text with one label reads the same total in both readers (the
  // dispatch reader also reads K and M suffixes, which the banner reader, exact totals only, does not).
  for (const text of ['tokens used: 456', 'tokens used:\n1,234', 'tokens used 77', 'Tokens Used: 9', 'tokens used\n146\u2009124', 'tokens used\n146\u202F124',
    'tokens used\n146\t124', 'tokens used\n146_124', 'tokens used\u3000: 5', 'tokens used: unknown', 'tokens used\u2009\u22121', 'tokens used: 1.5',
    'tokens used:', 'the tokens used successfully']) {
    assert.equal(amount(text, 'codex-tokens'), banner.fromCodexOutput(text + '\n').tokens?.total ?? null, JSON.stringify(text));
  }
  assert.equal(amount('tokens used: 2\ntokens used\u3000: 5', 'codex-tokens'), 7);
  assert.equal(amount('tokens used: 2\ntokens used\u2009\u22121', 'codex-tokens'), null);
  assert.equal(amount('tokens used: 10\u2009k', 'codex-tokens'), 10000);
});

test('codex usage parser with grouping, colon, K/M suffixes, and raw line', () => {
  const tmp = tt.mkTmp('codex-usage-');
  try {
    const checkCase = (text) => {
      const p = path.join(tmp, 'test.log');
      fs.writeFileSync(p, text, 'utf8');
      return dispatch.parseUsageFromLog(p, 'codex-tokens');
    };

    // 1. "10 644"
    const r1 = checkCase('tokens used\n10 644');
    assert.equal(r1.found, true);
    assert.equal(r1.usage.amount, 10644);
    assert.equal(r1.usage.unit, 'tokens');

    // 2. "10" + NBSP + "644"
    const r2 = checkCase('tokens used\n10\u00A0644');
    assert.equal(r2.found, true);
    assert.equal(r2.usage.amount, 10644);

    // 3. "10,644"
    const r3 = checkCase('tokens used\n10,644');
    assert.equal(r3.found, true);
    assert.equal(r3.usage.amount, 10644);

    // 4. "tokens used: 10 644"
    const r4 = checkCase('tokens used: 10 644');
    assert.equal(r4.found, true);
    assert.equal(r4.usage.amount, 10644);

    // 5. Real captured pair (cr-verifier-1.log:3883-3884): "tokens used\n252" + NBSP + "154" -> expected 252154
    const r5 = checkCase('tokens used\n252\u00A0154\nDone: [VERIFICATION.md]');
    assert.equal(r5.found, true);
    assert.equal(r5.usage.amount, 252154);
    assert.ok(r5.rawUsage && r5.rawUsage.includes('252\u00A0154'), 'rawUsage must be captured');

    // 6. Dot as grouping character
    const r6 = checkCase('tokens used: 10.644');
    assert.equal(r6.found, true);
    assert.equal(r6.usage.amount, 10644);

    // 7. K and M suffixes
    const r7a = checkCase('tokens used: 10k');
    assert.equal(r7a.found, true);
    assert.equal(r7a.usage.amount, 10000);

    const r7b = checkCase('tokens used: 1.5K');
    assert.equal(r7b.found, true);
    assert.equal(r7b.usage.amount, 1500);

    const r7c = checkCase('tokens used: 2.5M');
    assert.equal(r7c.found, true);
    assert.equal(r7c.usage.amount, 2500000);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('T29: AC-usage: report distinct reasons and renderUsage table', async () => {
  const tmp = tt.mkTmp('disp-t29-');

  try {
    const fakeRegPath = path.join(tmp, 'clients.json');
    fs.writeFileSync(fakeRegPath, JSON.stringify({
      schema: 'clients/1',
      clients: {
        noneClient: {
          binary: 'node',
          present: true,
          version: '1',
          verifiedOn: '2026-09-26',
          source: 'none',
          command: ['node', '-e', ''],
          model: { how: 'none', listing: null },
          effort: { how: 'none', values: null, note: null },
          env: {},
          resume: { command: null, sessionId: null, note: 'none' },
          usage: 'none',
          failureModes: []
        },
        codexClient: {
          binary: 'node',
          present: true,
          version: '1',
          verifiedOn: '2026-09-26',
          source: 'none',
          command: ['node', '-e', ''],
          model: { how: 'none', listing: null },
          effort: { how: 'none', values: null, note: null },
          env: {},
          resume: { command: null, sessionId: null, note: 'none' },
          usage: 'codex-tokens',
          failureModes: []
        },
        copilotClient: {
          binary: 'node',
          present: true,
          version: '1',
          verifiedOn: '2026-09-26',
          source: 'none',
          command: ['node', '-e', ''],
          model: { how: 'none', listing: null },
          effort: { how: 'none', values: null, note: null },
          env: {},
          resume: { command: null, sessionId: null, note: 'none' },
          usage: 'copilot-credits',
          failureModes: []
        }
      }
    }), 'utf8');

    const dispPath = path.join(tmp, 'disp.json');
    fs.writeFileSync(dispPath, JSON.stringify({
      slots: [
        { id: 'slot-none', launch: 'tests/fixtures/dispatch/hang-launch.md', out: 'out.txt', route: { client: 'noneClient', model: 'm1' } },
        { id: 'slot-parser-empty', launch: 'tests/fixtures/dispatch/hang-launch.md', out: 'out.txt', route: { client: 'codexClient', model: 'm2' } },
        { id: 'slot-with-usage', launch: 'tests/fixtures/dispatch/hang-launch.md', out: 'out.txt', route: { client: 'copilotClient', model: 'm3' } }
      ]
    }), 'utf8');

    const runsFile = path.join(tmp, 'RUNS.jsonl');
    const records = [
      {
        schema: 'run-record/1',
        runId: 'R-20260927T000000Z-slot-none',
        slot: 'slot-none',
        frame: 'task:test',
        role: null,
        selection: 'owner',
        resolution: { ladderSnapshot: null, primary: { client: 'noneClient', model: 'm1', effort: null }, substitutes: [], excluded: [], skipped: [], unverified: [], approval: null, shortfall: null },
        pins: { head: 'a'.repeat(40), launchFile: 'launch.md', launchSha256: 'b'.repeat(64), roleSha256: null, corpusHash: null, dispatchVersion: '1' },
        attempts: [{
          n: 1, kind: 'fresh', reason: 'first', routeRole: 'primary',
          route: { client: 'noneClient', model: 'm1', effort: null },
          effortUsed: null, modelRan: { id: 'm1', source: 'requested' },
          sessionId: null, start: '2026-09-27T00:00:00Z', end: '2026-09-27T00:01:00Z',
          exitCode: 0, class: 'NONE',
          tokens: { in: null, out: null, source: 'none' },
          usage: { amount: null, unit: null }
        }],
        budget: { freshUsed: 1, resumes: 0, stallMin: 10, hardMin: 60 },
        cost: { estimated: null, actual: null, cumulative: null, unit: null },
        completion: { processEnded: true, exitCode: 0, outputsPresent: true, outputsNonEmpty: true, structuralCheck: 'pass', validator: 'pass', evidence: 'evidence.md', supervisorDone: true },
        state: 'DONE', fallen: false, transitions: [], outputs: ['out.txt']
      },
      {
        schema: 'run-record/1',
        runId: 'R-20260927T000000Z-slot-parser-empty',
        slot: 'slot-parser-empty',
        frame: 'task:test',
        role: null,
        selection: 'owner',
        resolution: { ladderSnapshot: null, primary: { client: 'codexClient', model: 'm2', effort: null }, substitutes: [], excluded: [], skipped: [], unverified: [], approval: null, shortfall: null },
        pins: { head: 'a'.repeat(40), launchFile: 'launch.md', launchSha256: 'b'.repeat(64), roleSha256: null, corpusHash: null, dispatchVersion: '1' },
        attempts: [{
          n: 1, kind: 'fresh', reason: 'first', routeRole: 'primary',
          route: { client: 'codexClient', model: 'm2', effort: null },
          effortUsed: null, modelRan: { id: 'm2', source: 'requested' },
          sessionId: null, start: '2026-09-27T00:00:00Z', end: '2026-09-27T00:01:00Z',
          exitCode: 0, class: 'NONE',
          tokens: { in: null, out: null, source: 'none' },
          usage: { amount: null, unit: null }
        }],
        budget: { freshUsed: 1, resumes: 0, stallMin: 10, hardMin: 60 },
        cost: { estimated: null, actual: null, cumulative: null, unit: null },
        completion: { processEnded: true, exitCode: 0, outputsPresent: true, outputsNonEmpty: true, structuralCheck: 'pass', validator: 'pass', evidence: 'evidence.md', supervisorDone: true },
        state: 'DONE', fallen: false, transitions: [], outputs: ['out.txt']
      },
      {
        schema: 'run-record/1',
        runId: 'R-20260927T000000Z-slot-with-usage',
        slot: 'slot-with-usage',
        frame: 'task:test',
        role: null,
        selection: 'owner',
        resolution: { ladderSnapshot: null, primary: { client: 'copilotClient', model: 'm3', effort: null }, substitutes: [], excluded: [], skipped: [], unverified: [], approval: null, shortfall: null },
        pins: { head: 'a'.repeat(40), launchFile: 'launch.md', launchSha256: 'b'.repeat(64), roleSha256: null, corpusHash: null, dispatchVersion: '1' },
        attempts: [{
          n: 1, kind: 'fresh', reason: 'first', routeRole: 'primary',
          route: { client: 'copilotClient', model: 'm3', effort: null },
          effortUsed: null, modelRan: { id: 'm3', source: 'requested' },
          sessionId: null, start: '2026-09-27T00:00:00Z', end: '2026-09-27T00:01:00Z',
          exitCode: 0, class: 'NONE',
          tokens: { in: null, out: null, source: 'none' },
          usage: { amount: 12.5, unit: 'credits' }
        }],
        budget: { freshUsed: 1, resumes: 0, stallMin: 10, hardMin: 60 },
        cost: { estimated: null, actual: 12.5, cumulative: 12.5, unit: 'credits' },
        completion: { processEnded: true, exitCode: 0, outputsPresent: true, outputsNonEmpty: true, structuralCheck: 'pass', validator: 'pass', evidence: 'evidence.md', supervisorDone: true },
        state: 'DONE', fallen: false, transitions: [], outputs: ['out.txt']
      }
    ];

    for (const rec of records) {
      assert.deepEqual(runrecord.validateRecord(rec), []);
      fs.appendFileSync(runsFile, JSON.stringify(rec) + '\n', 'utf8');
    }

    const r = await runInProcess([
      'report', dispPath,
      '--registry', fakeRegPath,
      '--runs-file', runsFile
    ]);

    assert.equal(r.code, 0);
    // Reason 1: client usage=none in clients.json
    assert.match(r.stdout, /REPORT slot=slot-none route=noneClient:m1 state=DONE attempts=1 outputs="out\.txt" usage=none \(client usage=none in clients\.json\)/);
    // Reason 2: parser <key> found no usage in log
    assert.match(r.stdout, /REPORT slot=slot-parser-empty route=codexClient:m2 state=DONE attempts=1 outputs="out\.txt" usage=none \(parser codex-tokens found no usage in log\)/);
    // With usage
    assert.match(r.stdout, /REPORT slot=slot-with-usage route=copilotClient:m3 state=DONE attempts=1 outputs="out\.txt" usage=12\.5 credits/);
    // Old wording completely removed
    assert.ok(!r.stdout.includes('client reported no tokens/cost'));

    // renderUsage table
    const table = runrecord.renderUsage(records);
    // Assert headers
    assert.ok(table.includes('| Run | Slot | Selection | Client | Model ran | Effort used | Fresh/Resume | Wall min | Tokens in/out | Cost | State |'));
    // Cost column has rendered cost
    assert.ok(table.includes('12.50 credits'));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test.after(() => {
  try { fs.rmSync(testTmpAbs, { recursive: true, force: true }); } catch {}
});

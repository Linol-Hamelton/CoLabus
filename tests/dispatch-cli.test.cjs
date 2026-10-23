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
    slots: [{ id: 's1', launch: 'missing-launch-file.md', route: { client: 'agy', model: 'gemini-3.8-flash' } }]
  }), 'utf8');

  const r = await runInProcess(['check', dispPath]);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /^ERROR reason=launch-missing slot=s1 path=missing-launch-file\.md/m);
  fs.rmSync(tmp, { recursive: true, force: true });
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
          route: { client: 'agy', model: 'gemini-3.8-flash' }
        },
        {
          id: 's-waiting',
          launch: launchFile,
          needs: ['s-unmet-dep'],
          route: { client: 'agy', model: 'gemini-3.8-flash' }
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

test('T19: only the AUTO1 read-only adapter may name a research path; pointer template exactly once', () => {
  // The split moved the script body into .ai/bin/protocol-dispatch/ leaves; the
  // pointer template now lives in the procfs leaf. The pin follows the text.
  const leafDir = path.join(repoRoot, '.ai', 'bin', 'protocol-dispatch');
  let code = fs.readFileSync(DISPATCH_BIN, 'utf8');
  for (const name of fs.readdirSync(leafDir).filter(n => n.endsWith('.cjs'))) {
    code += '\n' + fs.readFileSync(path.join(leafDir, name), 'utf8');
  }
  // /119 explicitly allow this source-only read connection. Keep the
  // ban on every other corpus path instead of disguising the dependency.
  const researchPaths = code.match(/docs\/research\/[a-zA-Z0-9._/-]+/g) || [];
  assert.deepEqual(researchPaths, []);
  const matches = code.match(/Read and follow the file /g) || [];
  assert.equal(matches.length, 1, 'pointer template must appear exactly once');
});

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

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const dispatch = require('../.ai/bin/protocol-dispatch.cjs');
const runrecord = require('../.ai/bin/protocol-runrecord.cjs');
const { tt } = require('./helpers.cjs');
require('./suite-stable-cases.cjs');

const sourceRoot = path.resolve(__dirname, '..');
const { makeSourceFixture } = require('./test-tmp-source.cjs');
const repoRoot = makeSourceFixture('dispatch-source-');
const DISPATCH_BIN = path.resolve(sourceRoot, '.ai', 'bin', 'protocol-dispatch.cjs');
// neutral synthetic dispatch fixtures: every launch of DISPATCH.json exists, none of MISSING-DISPATCH.json does
const REAL_DISPATCH = path.resolve(repoRoot, 'tests', 'fixtures', 'dispatch-example', 'DISPATCH.json');
const R3_DISPATCH = path.resolve(__dirname, 'fixtures', 'dispatch-example', 'MISSING-DISPATCH.json');
const FAKE_CLIENT = path.resolve(__dirname, 'dispatch-fake-client.cjs');

const TEST_TMP_DIR = path.join('.ai', 'runtime', 'dispatch-test');
const testTmpAbs = path.resolve(repoRoot, TEST_TMP_DIR);
fs.mkdirSync(testTmpAbs, { recursive: true });
const DEFAULT_OUT_FILE = path.join(TEST_TMP_DIR, 'out1.txt').replace(/\\/g, '/');
process.env.TEST_DISPATCH_OUT_FILE = DEFAULT_OUT_FILE;

// Dispatch runs clone the repository into <temp>/disp-<slot>-<n>-* and keep the clone on BLOCKED/FAILED. Every run here gets TEMP/TMP/TMPDIR of one fixture dir
// (removed by the helper when the file ends well, kept when it fails), so nothing lands in the real temp dir.
const CHILD_TMP = tt.mkTmp('dc-');
const CHILD_TMP_ENV = { TEMP: CHILD_TMP, TMP: CHILD_TMP, TMPDIR: CHILD_TMP };
const TEST_SUITE_TMP = tt.mkTmp('disp-suite-');
const DEFAULT_TEST_RUNS = path.join(TEST_SUITE_TMP, 'RUNS.jsonl');
const DEFAULT_TEST_SIGNALS = path.join(TEST_SUITE_TMP, 'SIGNALS.md');
fs.writeFileSync(DEFAULT_TEST_RUNS, '', 'utf8');
fs.writeFileSync(DEFAULT_TEST_SIGNALS, '# Signals ledger\n\nAppend-only.\n\n', 'utf8');
process.env.PROTOCOL_RUNS_FILE = DEFAULT_TEST_RUNS;
process.env.PROTOCOL_SIGNALS_FILE = DEFAULT_TEST_SIGNALS;

// Bind journal imports into the suite temp root so no dispatch run in this
// suite ever writes into the tracked tree; a killed run leaves a clean git status.
const JOURNAL_IMPORT_ROOT = path.join(TEST_SUITE_TMP, 'journal-import');
process.env.PROTOCOL_JOURNAL_IMPORT_ROOT = JOURNAL_IMPORT_ROOT;
const TEST_JOURNAL = path.join(JOURNAL_IMPORT_ROOT, '.ai', 'worklog', 'gemini-0123456789abcdef.md');

const getTrackedStatus = () => {
  const r = spawnSync('git', ['status', '--porcelain'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    windowsHide: true
  });
  return (r.stdout || '')
    .split('\n')
    .map(l => l.trimEnd())
    .filter(l => Boolean(l) && !l.startsWith('?? '));
};
const initialTrackedStatus = getTrackedStatus();

const getFixturesStatus = () => {
  const r = spawnSync('git', ['status', '--porcelain', 'tests/fixtures'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    windowsHide: true
  });
  return (r.stdout || '')
    .split('\n')
    .map(l => l.trimEnd())
    .filter(Boolean);
};
const initialFixturesStatus = getFixturesStatus();

const runBin = (args, cwd = repoRoot, extraEnv = {}) => {
  const r = spawnSync(process.execPath, [DISPATCH_BIN, ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      ...CHILD_TMP_ENV,
      PROTOCOL_RUNS_FILE: DEFAULT_TEST_RUNS,
      PROTOCOL_SIGNALS_FILE: DEFAULT_TEST_SIGNALS,
      TEST_DISPATCH_OUT_FILE: DEFAULT_OUT_FILE,
      ...extraEnv
    }
  });
  return {
    code: r.status === null ? -1 : r.status,
    stdout: r.stdout || '',
    stderr: r.stderr || ''
  };
};


const runInProcess = async (args, cwd = repoRoot, extraEnv = {}) => {
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
      ...CHILD_TMP_ENV,
      PROTOCOL_RUNS_FILE: DEFAULT_TEST_RUNS,
      PROTOCOL_SIGNALS_FILE: DEFAULT_TEST_SIGNALS,
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
};

test('T6: end-to-end run with fake client in work mode', async () => {
  const tmp = tt.mkTmp('disp-e2e-');
  const launchFile = path.join(TEST_TMP_DIR, 'fake-launch.md').replace(/\\/g, '/');
  const outFile = DEFAULT_OUT_FILE;

  fs.mkdirSync(path.dirname(path.resolve(repoRoot, launchFile)), { recursive: true });
  fs.writeFileSync(path.resolve(repoRoot, launchFile), '# Fake launch prompt\n', 'utf8');

  const fakeRegPath = path.join(tmp, 'clients.json');
  fs.writeFileSync(fakeRegPath, JSON.stringify({
    schema: 'clients/1',
    clients: {
      fake: {
        binary: 'node',
        present: true,
        version: 'fake-v1',
        verifiedOn: '2026-09-26',
        source: 'node --version',
        command: ['node', FAKE_CLIENT, 'work', '{workdir}', '{workdir}'],
        model: { how: 'none', listing: null },
        effort: { how: 'none', values: null, note: null },
        env: {},
        resume: { command: null, sessionId: null, note: 'none' },
        usage: 'none',
        failureModes: []
      }
    }
  }), 'utf8');

  const dispPath = path.join(tmp, 'disp.json');
  fs.writeFileSync(dispPath, JSON.stringify({
    stateDir: path.relative(repoRoot, path.join(tmp, 'state')).replace(/\\/g, '/'),
    usageFile: path.relative(repoRoot, path.join(tmp, 'usage.md')).replace(/\\/g, '/'),
    stallMin: 10,
    hardMin: 60,
    slots: [
      {
        id: 'fake-slot',
        launch: launchFile,
        out: outFile,
        route: { client: 'fake', model: 'test' }
      }
    ]
  }), 'utf8');

  const journalPath = TEST_JOURNAL;

  try {
    // Probe level 0 test with fake client (in-process unit check)
    const probeR = await runInProcess(['probe', '--registry', fakeRegPath, 'fake']);
    assert.equal(probeR.code, 1); // version mismatch because node --version != fake-v1
    assert.match(probeR.stdout, /^PROBE client=fake state=VERSION_CHANGED/m);

    // Update fake registry with actual node version
    const nodeVer = process.version;
    const regObj = JSON.parse(fs.readFileSync(fakeRegPath, 'utf8'));
    regObj.clients.fake.version = nodeVer;
    fs.writeFileSync(fakeRegPath, JSON.stringify(regObj), 'utf8');

    const probeR2 = await runInProcess(['probe', '--registry', fakeRegPath, 'fake']);
    assert.equal(probeR2.code, 0);
    assert.match(probeR2.stdout, /^PROBE client=fake state=OK/m);

    // Real spawnSync integration run
    const r = runBin(['run', dispPath, '--registry', fakeRegPath]);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^DONE slot=fake-slot/m);

    // Declared output must exist under the suite import override root, not the tracked tree
    assert.ok(fs.existsSync(path.join(JOURNAL_IMPORT_ROOT, outFile)));
    // Journal must have been imported into the suite temp root, not the tracked tree
    assert.ok(fs.existsSync(journalPath));
  } finally {
    // Cleanup imported test artifacts
    try { fs.unlinkSync(path.join(JOURNAL_IMPORT_ROOT, outFile)); } catch {}
    try { fs.unlinkSync(journalPath); } catch {}
    try { fs.unlinkSync(path.resolve(repoRoot, launchFile)); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('T7-T10: policy and scope violations end in BLOCKED with clone kept', () => {
  const tmp = tt.mkTmp('disp-viol-');
  const launchFile = path.join(TEST_TMP_DIR, 'viol-launch.md').replace(/\\/g, '/');
  const outFile = DEFAULT_OUT_FILE;

  fs.mkdirSync(path.dirname(path.resolve(repoRoot, launchFile)), { recursive: true });
  fs.writeFileSync(path.resolve(repoRoot, launchFile), '# Viol launch prompt\n', 'utf8');

  const testViolationMode = (vMode) => {
    const fakeRegPath = path.join(tmp, `clients-${vMode}.json`);
    fs.writeFileSync(fakeRegPath, JSON.stringify({
      schema: 'clients/1',
      clients: {
        fake: {
          binary: 'node',
          present: true,
          version: process.version,
          verifiedOn: '2026-09-26',
          source: 'node --version',
          command: ['node', FAKE_CLIENT, vMode, '{workdir}', '{workdir}'],
          model: { how: 'none', listing: null },
          effort: { how: 'none', values: null, note: null },
          env: {},
          resume: { command: null, sessionId: null, note: 'none' },
          usage: 'none',
          failureModes: []
        }
      }
    }), 'utf8');

    const dispPath = path.join(tmp, `disp-${vMode}.json`);
    fs.writeFileSync(dispPath, JSON.stringify({
      stateDir: path.relative(repoRoot, path.join(tmp, `state-${vMode}`)).replace(/\\/g, '/'),
      slots: [{ id: `viol-${vMode}`, launch: launchFile, out: outFile, route: { client: 'fake', model: 'test' } }]
    }), 'utf8');

    const r = runBin(['run', dispPath, '--registry', fakeRegPath]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^BLOCKED slot=viol-/m);

    // Forbidden file must NOT have been copied back
    assert.ok(!fs.existsSync(path.resolve(repoRoot, 'forbidden-escape.txt')));
  };

  try {
    testViolationMode('write-escape'); // T7
    testViolationMode('commit-escape'); // T8
    testViolationMode('remote-escape'); // T9
  } finally {
    try { fs.unlinkSync(path.resolve(repoRoot, launchFile)); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('T12, T13: STALL at --stall-seconds and TIMEOUT at --hard-seconds', async () => {
  const tmp = tt.mkTmp('disp-timeout-');
  const launchFile = path.join(TEST_TMP_DIR, 'hang-launch.md').replace(/\\/g, '/');
  const outFile = DEFAULT_OUT_FILE;

  const runTimedMode = async (tMode, flag, sec) => {
    const fakeRegPath = path.join(tmp, `clients-${tMode}.json`);
    fs.writeFileSync(fakeRegPath, JSON.stringify({
      schema: 'clients/1',
      clients: {
        fake: {
          binary: 'node',
          present: true,
          version: process.version,
          verifiedOn: '2026-09-26',
          source: 'node --version',
          command: ['node', FAKE_CLIENT, tMode, '{workdir}', '{workdir}'],
          model: { how: 'none', listing: null },
          effort: { how: 'none', values: null, note: null },
          env: {},
          resume: { command: null, sessionId: null, note: 'none' },
          usage: 'none',
          failureModes: []
        }
      }
    }), 'utf8');

    const dispPath = path.join(tmp, `disp-${tMode}.json`);
    fs.writeFileSync(dispPath, JSON.stringify({
      stateDir: path.relative(repoRoot, path.join(tmp, `state-${tMode}`)).replace(/\\/g, '/'),
      slots: [{ id: `timed-${tMode}`, launch: launchFile, out: outFile, route: { client: 'fake', model: 'test' } }]
    }), 'utf8');

    const r = await runInProcess(['run', dispPath, '--registry', fakeRegPath, flag, String(sec)]);
    assert.equal(r.code, 1);
    return r;
  };

  try {
    fs.mkdirSync(path.dirname(path.resolve(repoRoot, launchFile)), { recursive: true });
    fs.writeFileSync(path.resolve(repoRoot, launchFile), '# Hang launch\n', 'utf8');

    const rStall = await runTimedMode('silent', '--stall-seconds', 1);
    assert.match(rStall.stdout, /^FAILED slot=timed-silent class=STALL/m);

    const rTimeout = await runTimedMode('always-talking', '--hard-seconds', 2);
    assert.match(rTimeout.stdout, /^(?:FAILED|BLOCKED) slot=timed-always-talking class=TIMEOUT/m);
  } finally {
    try { fs.unlinkSync(path.resolve(repoRoot, launchFile)); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('T16: second run of live slot exits 1 due to start lock', () => {
  const tmp = tt.mkTmp('disp-lock-');
  const acquired = dispatch.takeStartLock('lock-slot', tmp);
  assert.equal(acquired, true);

  // Second acquisition while lock held
  const second = dispatch.takeStartLock('lock-slot', tmp);
  assert.equal(second, false);

  dispatch.releaseStartLock('lock-slot', tmp);
  const third = dispatch.takeStartLock('lock-slot', tmp);
  assert.equal(third, true);

  dispatch.releaseStartLock('lock-slot', tmp);
  fs.rmSync(tmp, { recursive: true, force: true });
});


test('T20: AC-7, AC-12: transient retry, run record validation, usage render', () => {
  const tmp = tt.mkTmp('disp-t20-');
  const launchFile = path.join(TEST_TMP_DIR, 't20-launch.md').replace(/\\/g, '/');
  const outFile = DEFAULT_OUT_FILE;

  fs.mkdirSync(path.dirname(path.resolve(repoRoot, launchFile)), { recursive: true });
  fs.writeFileSync(path.resolve(repoRoot, launchFile), '# T20 launch\n', 'utf8');

  const fakeRegPath = path.join(tmp, 'clients.json');
  fs.writeFileSync(fakeRegPath, JSON.stringify({
    schema: 'clients/1',
    clients: {
      fake: {
        binary: 'node',
        present: true,
        version: process.version,
        verifiedOn: '2026-09-26',
        source: 'node --version',
        command: ['node', FAKE_CLIENT, 'transient-retry', '{workdir}', '{workdir}'],
        model: { how: 'none', listing: null },
        effort: { how: 'none', values: null, note: null },
        env: {},
        resume: { command: null, sessionId: null, note: 'none' },
        usage: 'none',
        failureModes: []
      }
    }
  }), 'utf8');

  const runsFile = path.join(tmp, 'RUNS.jsonl');
  const usageFile = path.join(tmp, 'usage.md');
  const dispPath = path.join(tmp, 'disp.json');
  fs.writeFileSync(dispPath, JSON.stringify({
    stateDir: path.relative(repoRoot, path.join(tmp, 'state')).replace(/\\/g, '/'),
    usageFile: path.relative(repoRoot, usageFile).replace(/\\/g, '/'),
    stallMin: 10,
    hardMin: 60,
    slots: [
      {
        id: 't20-slot',
        launch: launchFile,
        out: outFile,
        route: { client: 'fake', model: 'test' }
      }
    ]
  }), 'utf8');

  const marker = path.join(tmp, 'fake-transient.txt');

  try {
    const r = runBin([
      'run',
      dispPath,
      '--registry', fakeRegPath,
      '--runs-file', runsFile,
      '--fast-retry'
    ], repoRoot, { FAKE_TRANSIENT_MARKER: marker });

    assert.equal(r.code, 0, `${r.stdout}\n${r.stderr}`);
    assert.match(r.stdout, /^RUN slot=t20-slot attempt=1/m);
    assert.match(r.stdout, /^RUN slot=t20-slot attempt=2/m);
    assert.match(r.stdout, /^DONE slot=t20-slot/m);

    assert.ok(fs.existsSync(runsFile), 'RUNS.jsonl must exist');
    const records = runrecord.readRecords(runsFile);
    assert.equal(records.length, 1);
    const rec = records[0];
    assert.equal(rec.state, 'DONE');
    assert.equal(rec.budget.freshUsed, 2);
    assert.equal(rec.budget.resumes, 0);
    assert.equal(rec.attempts[0].reason, 'first');
    assert.equal(rec.attempts[1].reason, 'transient-retry');

    const valErrors = runrecord.validateRecord(rec);
    assert.deepEqual(valErrors, []);

    assert.ok(fs.existsSync(usageFile), 'usageFile must be rendered');
  } finally {
    try { fs.unlinkSync(marker); } catch {}
    try { fs.unlinkSync(path.resolve(repoRoot, launchFile)); } catch {}
    try { fs.unlinkSync(path.resolve(repoRoot, outFile)); } catch {}
    try { fs.unlinkSync(TEST_JOURNAL); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('T21: AC-8: STALL recovery with wakes and fallen = true', async () => {
  const tmp = tt.mkTmp('disp-t21-');
  const launchFile = path.join(TEST_TMP_DIR, 't21-launch.md').replace(/\\/g, '/');
  const outFile = DEFAULT_OUT_FILE;

  try {
    fs.mkdirSync(path.dirname(path.resolve(repoRoot, launchFile)), { recursive: true });
    fs.writeFileSync(path.resolve(repoRoot, launchFile), '# T21 launch\n', 'utf8');

    const fakeRegPath = path.join(tmp, 'clients.json');
    fs.writeFileSync(fakeRegPath, JSON.stringify({
      schema: 'clients/1',
      clients: {
        fake: {
          binary: 'node',
          present: true,
          version: process.version,
          verifiedOn: '2026-09-26',
          source: 'node --version',
          command: ['node', FAKE_CLIENT, 'stall-wake', '{workdir}', '{workdir}'],
          model: { how: 'none', listing: null },
          effort: { how: 'none', values: null, note: null },
          env: {},
          resume: {
            command: ['node', FAKE_CLIENT, 'stall-wake', '{workdir}', '{workdir}', '--resume={sessionId}'],
            sessionId: 'printed',
            note: 'supports resume'
          },
          usage: 'none',
          failureModes: []
        }
      }
    }), 'utf8');

    const runsFile = path.join(tmp, 'RUNS.jsonl');
    const dispPath = path.join(tmp, 'disp.json');
    fs.writeFileSync(dispPath, JSON.stringify({
      stateDir: path.relative(repoRoot, path.join(tmp, 'state')).replace(/\\/g, '/'),
      stallMin: 10,
      hardMin: 60,
      slots: [
        {
          id: 't21-slot',
          launch: launchFile,
          out: outFile,
          route: { client: 'fake', model: 'test' }
        }
      ]
    }), 'utf8');

    const r = await runInProcess([
      'run',
      dispPath,
      '--registry', fakeRegPath,
      '--runs-file', runsFile,
      '--stall-seconds', '1'
    ]);

    assert.equal(r.code, 1);
    assert.match(r.stdout, /^FAILED slot=t21-slot class=STALL/m);

    assert.ok(fs.existsSync(runsFile), 'RUNS.jsonl must exist');
    const records = runrecord.readRecords(runsFile);
    assert.equal(records.length, 1);
    const rec = records[0];
    assert.equal(rec.state, 'FAILED');
    assert.equal(rec.fallen, true, 'fallen must be true on stall exhaustion');

    // Verify attempt kinds and reasons
    assert.equal(rec.attempts[0].kind, 'fresh');
    assert.equal(rec.attempts[0].reason, 'first');
    assert.equal(rec.attempts[1].kind, 'resume');
    assert.equal(rec.attempts[1].reason, 'resume');
    assert.equal(rec.attempts[2].kind, 'resume');
    assert.equal(rec.attempts[3].kind, 'resume');

    const valErrors = runrecord.validateRecord(rec);
    assert.deepEqual(valErrors, []);
  } finally {
    try { fs.unlinkSync(path.resolve(repoRoot, launchFile)); } catch {}
    try { fs.unlinkSync(path.resolve(repoRoot, outFile)); } catch {}
    try { fs.unlinkSync(TEST_JOURNAL); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('T22: AC-9: INVALID_OUTPUT repair resume', async () => {
  const tmp = tt.mkTmp('disp-t22-');
  const launchFile = path.join(TEST_TMP_DIR, 't22-launch.md').replace(/\\/g, '/');
  const outFile = DEFAULT_OUT_FILE;

  fs.mkdirSync(path.dirname(path.resolve(repoRoot, launchFile)), { recursive: true });
  fs.writeFileSync(path.resolve(repoRoot, launchFile), '# T22 launch\n', 'utf8');

  const fakeRegPath = path.join(tmp, 'clients.json');
  fs.writeFileSync(fakeRegPath, JSON.stringify({
    schema: 'clients/1',
    clients: {
      fake: {
        binary: 'node',
        present: true,
        version: process.version,
        verifiedOn: '2026-09-26',
        source: 'node --version',
        command: ['node', FAKE_CLIENT, 'repair-mode', '{workdir}', '{workdir}'],
        model: { how: 'none', listing: null },
        effort: { how: 'none', values: null, note: null },
        env: {},
        resume: {
          command: ['node', FAKE_CLIENT, 'repair-mode', '{workdir}', '{workdir}', '--resume={sessionId}'],
          sessionId: 'printed',
          note: 'supports resume'
        },
        usage: 'none',
        failureModes: []
      }
    }
  }), 'utf8');

  const runsFile = path.join(tmp, 'RUNS.jsonl');
  const dispPath = path.join(tmp, 'disp.json');
  fs.writeFileSync(dispPath, JSON.stringify({
    stateDir: path.relative(repoRoot, path.join(tmp, 'state')).replace(/\\/g, '/'),
    stallMin: 10,
    hardMin: 60,
    slots: [
      {
        id: 't22-slot',
        launch: launchFile,
        out: outFile,
        route: { client: 'fake', model: 'test' }
      }
    ]
  }), 'utf8');

  try {
    const r = await runInProcess([
      'run',
      dispPath,
      '--registry', fakeRegPath,
      '--runs-file', runsFile,
      '--fast-retry'
    ]);

    assert.equal(r.code, 0);
    assert.match(r.stdout, /^DONE slot=t22-slot/m);

    const records = runrecord.readRecords(runsFile);
    assert.equal(records.length, 1);
    const rec = records[0];
    assert.equal(rec.state, 'DONE');
    assert.equal(rec.attempts.length, 2);
    assert.equal(rec.attempts[0].kind, 'fresh');
    assert.equal(rec.attempts[0].reason, 'first');
    assert.equal(rec.attempts[1].kind, 'resume');
    assert.equal(rec.attempts[1].reason, 'repair');

    const valErrors = runrecord.validateRecord(rec);
    assert.deepEqual(valErrors, []);
  } finally {
    try { fs.unlinkSync(path.resolve(repoRoot, launchFile)); } catch {}
    try { fs.unlinkSync(path.resolve(repoRoot, outFile)); } catch {}
    try { fs.unlinkSync(TEST_JOURNAL); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('T23: AC-10: Launch pinning mismatch BLOCKED pin-changed, and --revise starts new run', async () => {
  const tmp = tt.mkTmp('disp-t23-');
  const launchFile = path.join(TEST_TMP_DIR, 't23-launch.md').replace(/\\/g, '/');
  const outFile = DEFAULT_OUT_FILE;

  fs.mkdirSync(path.dirname(path.resolve(repoRoot, launchFile)), { recursive: true });
  fs.writeFileSync(path.resolve(repoRoot, launchFile), '# T23 initial launch\n', 'utf8');

  const fakeRegPath = path.join(tmp, 'clients.json');
  fs.writeFileSync(fakeRegPath, JSON.stringify({
    schema: 'clients/1',
    clients: {
      fake: {
        binary: 'node',
        present: true,
        version: process.version,
        verifiedOn: '2026-09-26',
        source: 'node --version',
        command: ['node', FAKE_CLIENT, 'auth-error', '{workdir}', '{workdir}'],
        model: { how: 'none', listing: null },
        effort: { how: 'none', values: null, note: null },
        env: {},
        resume: { command: null, sessionId: null, note: 'none' },
        usage: 'none',
        failureModes: []
      }
    }
  }), 'utf8');

  const dispPath = path.join(tmp, 'disp.json');
  fs.writeFileSync(dispPath, JSON.stringify({
    stateDir: path.relative(repoRoot, path.join(tmp, 'state')).replace(/\\/g, '/'),
    slots: [
      {
        id: 't23-slot',
        launch: launchFile,
        out: outFile,
        route: { client: 'fake', model: 'test' }
      }
    ]
  }), 'utf8');

  try {
    // First run: records pins, fails with AUTH_ERROR
    const r1 = await runInProcess(['run', dispPath, '--registry', fakeRegPath]);
    assert.equal(r1.code, 1);

    // Modify launch file
    fs.writeFileSync(path.resolve(repoRoot, launchFile), '# T23 TAMPERED launch\n', 'utf8');

    // Second run without --revise: BLOCKED pin-changed
    const r2 = await runInProcess(['run', dispPath, '--registry', fakeRegPath]);
    assert.equal(r2.code, 1);
    assert.match(r2.stdout, new RegExp(`^BLOCKED slot=t23-slot class=POLICY_FAILURE reason="pin-changed ${launchFile}"`, 'm'));

    // Third run with --revise: starts fresh revision
    const r3 = await runInProcess(['run', dispPath, '--registry', fakeRegPath, '--revise']);
    assert.equal(r3.code, 1);
    assert.match(r3.stdout, /^RUN slot=t23-slot attempt=1/m);
  } finally {
    try { fs.unlinkSync(path.resolve(repoRoot, launchFile)); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('T24: AC-11: Completion contract requires Evidence line', async () => {
  const tmp = tt.mkTmp('disp-t24-');
  const launchFile = path.join(TEST_TMP_DIR, 't24-launch.md').replace(/\\/g, '/');
  const outFile = DEFAULT_OUT_FILE;

  fs.mkdirSync(path.dirname(path.resolve(repoRoot, launchFile)), { recursive: true });
  fs.writeFileSync(path.resolve(repoRoot, launchFile), '# T24 launch\n', 'utf8');

  // Fake client without Evidence line in journal
  const fakeScript = path.join(tmp, 'no-evidence-client.cjs');
  fs.writeFileSync(fakeScript, `
    const fs = require('fs');
    const path = require('path');
    const root = process.argv[2] || '.';
    const out = path.join(root, ${JSON.stringify(outFile)});
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, 'valid output without evidence\\n', 'utf8');
    const j = path.join(root, '.ai/worklog/gemini-0123456789abcdef.md');
    fs.mkdirSync(path.dirname(j), { recursive: true });
    fs.writeFileSync(j, '# Session journal\\nNo evidence here\\n', 'utf8');
    process.exit(0);
  `, 'utf8');

  const fakeRegPath = path.join(tmp, 'clients.json');
  fs.writeFileSync(fakeRegPath, JSON.stringify({
    schema: 'clients/1',
    clients: {
      fake: {
        binary: 'node',
        present: true,
        version: process.version,
        verifiedOn: '2026-09-26',
        source: 'node --version',
        command: ['node', fakeScript, '{workdir}'],
        model: { how: 'none', listing: null },
        effort: { how: 'none', values: null, note: null },
        env: {},
        resume: { command: null, sessionId: null, note: 'none' },
        usage: 'none',
        failureModes: []
      }
    }
  }), 'utf8');

  const dispPath = path.join(tmp, 'disp.json');
  fs.writeFileSync(dispPath, JSON.stringify({
    stateDir: path.relative(repoRoot, path.join(tmp, 'state')).replace(/\\/g, '/'),
    slots: [
      {
        id: 't24-slot',
        launch: launchFile,
        out: outFile,
        route: { client: 'fake', model: 'test' }
      }
    ]
  }), 'utf8');

  try {
    const r = await runInProcess(['run', dispPath, '--registry', fakeRegPath]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /^FAILED slot=t24-slot class=INVALID_OUTPUT/m);
  } finally {
    try { fs.unlinkSync(path.resolve(repoRoot, launchFile)); } catch {}
    try { fs.unlinkSync(path.resolve(repoRoot, outFile)); } catch {}
    try { fs.unlinkSync(TEST_JOURNAL); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('T25: AC-7: PROCESS_CRASH recovery via resume', async () => {
  const tmp = tt.mkTmp('disp-t25-');
  const launchFile = path.join(TEST_TMP_DIR, 't25-launch.md').replace(/\\/g, '/');
  const outFile = DEFAULT_OUT_FILE;

  fs.mkdirSync(path.dirname(path.resolve(repoRoot, launchFile)), { recursive: true });
  fs.writeFileSync(path.resolve(repoRoot, launchFile), '# T25 launch\n', 'utf8');

  const fakeRegPath = path.join(tmp, 'clients.json');
  fs.writeFileSync(fakeRegPath, JSON.stringify({
    schema: 'clients/1',
    clients: {
      fake: {
        binary: 'node',
        present: true,
        version: process.version,
        verifiedOn: '2026-09-26',
        source: 'node --version',
        command: ['node', FAKE_CLIENT, 'crash-resume', '{workdir}', '{workdir}'],
        model: { how: 'none', listing: null },
        effort: { how: 'none', values: null, note: null },
        env: {},
        resume: {
          command: ['node', FAKE_CLIENT, 'crash-resume', '{workdir}', '{workdir}', '--resume={sessionId}'],
          sessionId: 'printed',
          note: 'supports resume'
        },
        usage: 'none',
        failureModes: []
      }
    }
  }), 'utf8');

  const runsFile = path.join(tmp, 'RUNS.jsonl');
  const dispPath = path.join(tmp, 'disp.json');
  fs.writeFileSync(dispPath, JSON.stringify({
    stateDir: path.relative(repoRoot, path.join(tmp, 'state')).replace(/\\/g, '/'),
    slots: [
      {
        id: 't25-slot',
        launch: launchFile,
        out: outFile,
        route: { client: 'fake', model: 'test' }
      }
    ]
  }), 'utf8');

  try {
    const r = await runInProcess([
      'run',
      dispPath,
      '--registry', fakeRegPath,
      '--runs-file', runsFile,
      '--fast-retry'
    ]);

    assert.equal(r.code, 0);
    assert.match(r.stdout, /^DONE slot=t25-slot/m);

    const records = runrecord.readRecords(runsFile);
    assert.equal(records.length, 1);
    const rec = records[0];
    assert.equal(rec.state, 'DONE');
    assert.equal(rec.attempts.length, 2);
    assert.equal(rec.attempts[0].kind, 'fresh');
    assert.equal(rec.attempts[0].reason, 'first');
    assert.equal(rec.attempts[1].kind, 'resume');
    assert.equal(rec.attempts[1].reason, 'resume');

    const valErrors = runrecord.validateRecord(rec);
    assert.deepEqual(valErrors, []);
  } finally {
    try { fs.unlinkSync(path.resolve(repoRoot, launchFile)); } catch {}
    try { fs.unlinkSync(path.resolve(repoRoot, outFile)); } catch {}
    try { fs.unlinkSync(TEST_JOURNAL); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('T26: AC-10: dispatcher fall signal test', async () => {
  const tmp = tt.mkTmp('disp-t26-');
  const launchFile = path.join(TEST_TMP_DIR, 't26-launch.md').replace(/\\/g, '/');
  const outFile = DEFAULT_OUT_FILE;

  fs.mkdirSync(path.dirname(path.resolve(repoRoot, launchFile)), { recursive: true });
  fs.writeFileSync(path.resolve(repoRoot, launchFile), '# T26 launch\n', 'utf8');

  try {
    // Case 1: STALL fake client exhausting its wakes adds one fall line with evidence=docs/ops/RUNS.jsonl#<runId>
    const fakeRegPath = path.join(tmp, 'clients-wakes.json');
    fs.writeFileSync(fakeRegPath, JSON.stringify({
      schema: 'clients/1',
      clients: {
        fake: {
          binary: 'node',
          present: true,
          version: process.version,
          verifiedOn: '2026-09-26',
          source: 'node --version',
          command: ['node', FAKE_CLIENT, 'stall-wake', '{workdir}', '{workdir}'],
          model: { how: 'none', listing: null },
          effort: { how: 'none', values: null, note: null },
          env: {},
          resume: {
            command: ['node', FAKE_CLIENT, 'stall-wake', '{workdir}', '{workdir}', '--resume={sessionId}'],
            sessionId: 'printed',
            note: 'supports resume'
          },
          usage: 'none',
          failureModes: []
        }
      }
    }), 'utf8');

    const runsFile1 = path.join(tmp, 'RUNS1.jsonl');
    const signalsFile1 = path.join(tmp, 'SIGNALS1.md');
    const dispPath1 = path.join(tmp, 'disp1.json');
    fs.writeFileSync(dispPath1, JSON.stringify({
      stateDir: path.relative(repoRoot, path.join(tmp, 'state1')).replace(/\\/g, '/'),
      stallMin: 10,
      hardMin: 60,
      slots: [
        {
          id: 't26-slot1',
          launch: launchFile,
          out: outFile,
          route: { client: 'fake', model: 'test-model' }
        }
      ]
    }), 'utf8');

    const r1 = await runInProcess([
      'run',
      dispPath1,
      '--registry', fakeRegPath,
      '--runs-file', runsFile1,
      '--signals-file', signalsFile1,
      '--stall-seconds', '1'
    ]);

    assert.equal(r1.code, 1);
    assert.ok(fs.existsSync(signalsFile1), 'signalsFile1 must exist');
    const content1 = fs.readFileSync(signalsFile1, 'utf8');
    const lines1 = content1.split('\n').filter(l => l.startsWith('Signal: '));
    assert.ok(lines1.length >= 1, 'must add at least 1 signal line on wake exhaustion');
    assert.ok(lines1.every(l => l.includes(' | fall | ')), 'must be fall signal');
    assert.match(lines1[0], /fake:test-model/, 'participant must match client:model');

    const records1 = runrecord.readRecords(runsFile1);
    assert.equal(records1.length, 1);
    const runId1 = records1[0].runId;
    assert.ok(lines1[0].includes(`docs/ops/RUNS.jsonl#${runId1}`), 'evidence must point to runId in RUNS.jsonl');

    // Case 2: Fake client without resume.command adds fall and procedure-gap
    const fakeRegNoResume = path.join(tmp, 'clients-no-resume.json');
    fs.writeFileSync(fakeRegNoResume, JSON.stringify({
      schema: 'clients/1',
      clients: {
        fake: {
          binary: 'node',
          present: true,
          version: process.version,
          verifiedOn: '2026-09-26',
          source: 'node --version',
          command: ['node', FAKE_CLIENT, 'stall-wake', '{workdir}', '{workdir}'],
          model: { how: 'none', listing: null },
          effort: { how: 'none', values: null, note: null },
          env: {},
          resume: {
            command: null,
            sessionId: null,
            note: 'no resume'
          },
          usage: 'none',
          failureModes: []
        }
      }
    }), 'utf8');

    const runsFile2 = path.join(tmp, 'RUNS2.jsonl');
    const signalsFile2 = path.join(tmp, 'SIGNALS2.md');
    const dispPath2 = path.join(tmp, 'disp2.json');
    fs.writeFileSync(dispPath2, JSON.stringify({
      stateDir: path.relative(repoRoot, path.join(tmp, 'state2')).replace(/\\/g, '/'),
      stallMin: 10,
      hardMin: 60,
      slots: [
        {
          id: 't26-slot2',
          launch: launchFile,
          out: outFile,
          route: { client: 'fake', model: 'test-no-res' }
        }
      ]
    }), 'utf8');

    const r2 = await runInProcess([
      'run',
      dispPath2,
      '--registry', fakeRegNoResume,
      '--runs-file', runsFile2,
      '--signals-file', signalsFile2,
      '--stall-seconds', '1'
    ]);

    assert.equal(r2.code, 1);
    assert.ok(fs.existsSync(signalsFile2), 'signalsFile2 must exist');
    const content2 = fs.readFileSync(signalsFile2, 'utf8');
    const lines2 = content2.split('\n').filter(l => l.startsWith('Signal: '));
    assert.ok(lines2.length >= 2, 'must add signal lines (fall and procedure-gap)');
    const fallLine = lines2.find(l => l.includes(' | fall | '));
    const gapLine = lines2.find(l => l.includes(' | procedure-gap | '));
    assert.ok(fallLine, 'must have fall signal');
    assert.ok(gapLine, 'must have procedure-gap signal');
    assert.ok(gapLine.includes('unknown'), 'procedure-gap cost must be unknown');

    const records2 = runrecord.readRecords(runsFile2);
    assert.equal(records2.length, 1);
    const runId2 = records2[0].runId;
    assert.ok(fallLine.includes(`docs/ops/RUNS.jsonl#${runId2}`));
    assert.ok(gapLine.includes(`docs/ops/RUNS.jsonl#${runId2}`));

    // Case 3: A failing ledger leaves run record unchanged and prints ERROR row
    const badSignalsFile = path.join(tmp, 'BAD_SIGNALS.md');
    fs.writeFileSync(badSignalsFile, 'Corrupted invalid header line\n\n\n\n', 'utf8');

    const runsFile3 = path.join(tmp, 'RUNS3.jsonl');
    const dispPath3 = path.join(tmp, 'disp3.json');
    fs.writeFileSync(dispPath3, JSON.stringify({
      stateDir: path.relative(repoRoot, path.join(tmp, 'state3')).replace(/\\/g, '/'),
      stallMin: 10,
      hardMin: 60,
      slots: [
        {
          id: 't26-slot3',
          launch: launchFile,
          out: outFile,
          route: { client: 'fake', model: 'test-fail' }
        }
      ]
    }), 'utf8');

    const r3 = await runInProcess([
      'run',
      dispPath3,
      '--registry', fakeRegNoResume,
      '--runs-file', runsFile3,
      '--signals-file', badSignalsFile,
      '--stall-seconds', '1'
    ]);

    assert.match(r3.stdout, /ERROR reason=signal-append-failed runId=R-/, 'must print ERROR reason=signal-append-failed row');
    assert.ok(fs.existsSync(runsFile3), 'runsFile3 must still exist');
    const records3 = runrecord.readRecords(runsFile3);
    assert.equal(records3.length, 1, 'run record must still be written');
    assert.equal(records3[0].state, 'FAILED');
  } finally {
    try { fs.unlinkSync(path.resolve(repoRoot, launchFile)); } catch {}
    try { fs.unlinkSync(path.resolve(repoRoot, outFile)); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('T28: AC-usage: two-attempt sum, mixed units giving actual=null, and cost recording', async () => {
  const tmp = tt.mkTmp('disp-t28-');
  const launchFile = path.join(TEST_TMP_DIR, 't28-launch.md').replace(/\\/g, '/');
  const outFile = DEFAULT_OUT_FILE;

  try {
    fs.mkdirSync(path.dirname(path.resolve(repoRoot, launchFile)), { recursive: true });
    fs.writeFileSync(path.resolve(repoRoot, launchFile), '# T28 launch\n', 'utf8');

    const runnerScript = path.join(tmp, 'runner.cjs');
    fs.writeFileSync(runnerScript, `'use strict';
const fs = require('fs');
const path = require('path');
const mode = process.argv[2];
const tmpDir = process.argv[3];
const workdir = process.cwd();

const outPath = path.join(workdir, ${JSON.stringify(outFile)});
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, 'output\\n', 'utf8');

const journalDir = path.join(workdir, '.ai', 'worklog');
fs.mkdirSync(journalDir, { recursive: true });
fs.writeFileSync(path.join(journalDir, 'gemini-0123456789abcdef.md'), '# Worklog\\n\\nEvidence: ok\\n', 'utf8');

const marker = path.join(tmpDir, 'marker.txt');
if (mode === 'two-attempts') {
  if (!fs.existsSync(marker)) {
    fs.writeFileSync(marker, 'attempt1', 'utf8');
    console.log('tokens used\\n1,000');
    process.exit(1);
  } else {
    console.log('tokens used\\n2,500');
    process.exit(0);
  }
}
`, 'utf8');

    const fakeRegPath = path.join(tmp, 'clients.json');
    fs.writeFileSync(fakeRegPath, JSON.stringify({
      schema: 'clients/1',
      clients: {
        fakeRunner: {
          binary: 'node',
          present: true,
          version: process.version,
          verifiedOn: '2026-09-26',
          source: 'node --version',
          command: ['node', runnerScript, 'two-attempts', tmp],
          model: { how: 'none', listing: null },
          effort: { how: 'none', values: null, note: null },
          env: {},
          resume: { command: null, sessionId: null, note: 'none' },
          usage: 'codex-tokens',
          failureModes: []
        }
      }
    }), 'utf8');

    const runsFile = path.join(tmp, 'runs.jsonl');
    const dispPath = path.join(tmp, 'disp.json');
    fs.writeFileSync(dispPath, JSON.stringify({
      stateDir: path.relative(repoRoot, path.join(tmp, 'state')).replace(/\\/g, '/'),
      slots: [
        {
          id: 'slot-two-attempts',
          launch: launchFile,
          out: outFile,
          route: { client: 'fakeRunner', model: 'm1' }
        }
      ]
    }), 'utf8');

    const r = await runInProcess([
      'run', dispPath,
      '--registry', fakeRegPath,
      '--runs-file', runsFile,
      '--fast-retry'
    ]);
    assert.equal(r.code, 0);

    const recs = runrecord.readRecords(runsFile);
    assert.equal(recs.length, 1);
    const rec = recs[0];
    assert.equal(rec.attempts.length, 2);
    assert.equal(rec.attempts[0].usage.amount, 1000);
    assert.equal(rec.attempts[0].usage.unit, 'tokens');
    assert.equal(rec.attempts[1].usage.amount, 2500);
    assert.equal(rec.attempts[1].usage.unit, 'tokens');
    assert.equal(rec.cost.actual, 3500);
    assert.equal(rec.cost.cumulative, 3500);
    assert.equal(rec.cost.unit, 'tokens');
    assert.equal(rec.cost.estimated, null);

    const valErrors = runrecord.validateRecord(rec);
    assert.deepEqual(valErrors, []);

    // Also verify mixed units giving actual=null via a constructed 2-attempt record
    const mixedRec = JSON.parse(JSON.stringify(rec));
    mixedRec.runId = 'R-20260927T000000Z-mixed';
    mixedRec.slot = 'mixed';
    mixedRec.attempts[0].usage = { amount: 10, unit: 'USD' };
    mixedRec.attempts[1].usage = { amount: 5, unit: 'credits' };
    mixedRec.cost = { estimated: null, actual: null, cumulative: null, unit: null };
    const mixedValErrors = runrecord.validateRecord(mixedRec);
    assert.deepEqual(mixedValErrors, []);
  } finally {
    try { fs.unlinkSync(path.resolve(repoRoot, launchFile)); } catch {}
    try { fs.unlinkSync(path.resolve(repoRoot, outFile)); } catch {}
    try { fs.unlinkSync(TEST_JOURNAL); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('T30: Item 4: dispatch attempt without --runs-file appends to dispatch.runsFile or docs/ops/RUNS.jsonl, and report reads canonical store', async () => {
  const tmp = tt.mkTmp('disp-item4-');
  const launchFile = path.join(TEST_TMP_DIR, 'item4-launch.md').replace(/\\/g, '/');
  const outFile = DEFAULT_OUT_FILE;

  fs.mkdirSync(path.dirname(path.resolve(repoRoot, launchFile)), { recursive: true });
  fs.writeFileSync(path.resolve(repoRoot, launchFile), '# Item 4 Launch\n', 'utf8');

  const customRuns = path.join(TEST_TMP_DIR, 'custom-runs.jsonl').replace(/\\/g, '/');
  const customRunsRel = customRuns;

  // Verify validateDispatch allows runsFile
  const testDispObj = {
    version: 1,
    stateDir: path.join(TEST_TMP_DIR, 'state-item4').replace(/\\/g, '/'),
    runsFile: customRunsRel,
    slots: [
      {
        id: 'slot-item4',
        launch: launchFile,
        out: outFile,
        route: { client: 'fake', model: 'test' }
      }
    ]
  };
  dispatch.validateDispatch(testDispObj);

  const regPath = path.join(tmp, 'clients.json');
  fs.writeFileSync(regPath, JSON.stringify({
    schema: 'clients/1',
    clients: {
      fake: {
        binary: 'node',
        present: true,
        version: process.version,
        verifiedOn: '2026-09-27',
        source: 'node --version',
        command: ['node', FAKE_CLIENT, 'work', '{workdir}', '{workdir}'],
        model: { how: 'none', listing: null },
        effort: { how: 'none', values: null, note: null },
        env: {},
        resume: { command: null, sessionId: null, note: 'none' },
        usage: 'none',
        failureModes: []
      }
    }
  }), 'utf8');

  const dispPath = path.join(tmp, 'DISPATCH.json');
  fs.writeFileSync(dispPath, JSON.stringify(testDispObj, null, 2), 'utf8');

  const origRunsEnv = process.env.PROTOCOL_RUNS_FILE;
  delete process.env.PROTOCOL_RUNS_FILE;

  try {
    // Run dispatch WITHOUT passing opts.runsFile - should resolve dispatch.runsFile
    const code = await dispatch.runDispatch(dispPath, [], {
      repoRoot,
      registry: regPath,
      fastRetry: true
    });
    assert.equal(code, 0);

    const customRunsAbs = path.resolve(repoRoot, customRuns);
    assert.ok(fs.existsSync(customRunsAbs), 'custom runsFile must exist');

    const records = runrecord.readRecords(customRunsAbs);
    assert.equal(records.length, 1);
    assert.equal(records[0].slot, 'slot-item4');
    assert.equal(records[0].state, 'DONE');
    assert.equal(records[0].attempts.length, 1);

    const errors = runrecord.validateRecord(records[0]);
    assert.deepEqual(errors, []);

    // Verify reportDispatch reads from dispatch.runsFile when opts.runsFile is omitted
    let reportLogs = [];
    const origLog = console.log;
    console.log = (...args) => reportLogs.push(args.join(' '));
    try {
      const repCode = dispatch.reportDispatch(dispPath, { repoRoot, registry: regPath });
      assert.equal(repCode, 0);
    } finally {
      console.log = origLog;
    }
    const reportOut = reportLogs.join('\n');
    assert.match(reportOut, /REPORT slot=slot-item4 route=fake:test state=DONE attempts=1/);
    assert.ok(!reportOut.includes('(no-run-record)'));
  } finally {
    if (origRunsEnv !== undefined) {
      process.env.PROTOCOL_RUNS_FILE = origRunsEnv;
    }
    try { fs.unlinkSync(path.resolve(repoRoot, customRuns)); } catch {}
    try { fs.unlinkSync(path.resolve(repoRoot, launchFile)); } catch {}
    try { fs.unlinkSync(path.resolve(repoRoot, outFile)); } catch {}
    try { fs.unlinkSync(TEST_JOURNAL); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('dispatch without PROTOCOL_RUNS_FILE/PROTOCOL_REPO_ROOT and no dispatch.runsFile writes to fixture docs/ops/RUNS.jsonl', async (t) => {
  const { makeFixture } = require('./helpers.cjs');

  const fixture = makeFixture(t);
  const initialTracked = initialTrackedStatus;

  const launchFile = path.join(fixture, 'LAUNCH.md');
  fs.writeFileSync(launchFile, '# Test Launch\n', 'utf8');

  const dispatchObj = {
    version: 1,
    stateDir: path.join(fixture, '.ai', 'runtime', 'test').replace(/\\/g, '/'),
    slots: [
      {
        id: 'slot-f2a05',
        launch: 'LAUNCH.md',
        out: 'out-f2a05.txt',
        route: { client: 'fake', model: 'test' }
      }
    ]
  };
  const dispPath = path.join(fixture, 'DISPATCH.json');
  fs.writeFileSync(dispPath, JSON.stringify(dispatchObj, null, 2), 'utf8');

  const regPath = path.join(fixture, 'clients.json');
  fs.writeFileSync(regPath, JSON.stringify({
    schema: 'clients/1',
    clients: {
      fake: {
        binary: 'node',
        present: true,
        version: process.version,
        verifiedOn: '2026-09-29',
        source: 'node --version',
        command: ['node', FAKE_CLIENT, 'work', '{workdir}', '{workdir}'],
        model: { how: 'none', listing: null },
        effort: { how: 'none', values: null, note: null },
        env: {},
        resume: { command: null, sessionId: null, note: 'none' },
        usage: 'none',
        failureModes: []
      }
    }
  }), 'utf8');

  const cleanEnv = { ...process.env };
  delete cleanEnv.PROTOCOL_RUNS_FILE;
  delete cleanEnv.PROTOCOL_REPO_ROOT;
  delete cleanEnv.PROTOCOL_JOURNAL_IMPORT_ROOT;
  delete cleanEnv.TEST_DISPATCH_OUT_FILE;
  Object.assign(cleanEnv, CHILD_TMP_ENV);

  const r = spawnSync(process.execPath, [DISPATCH_BIN, 'run', dispPath, '--registry', regPath, '--fast-retry'], {
    cwd: fixture,
    encoding: 'utf8',
    windowsHide: true,
    env: cleanEnv,
    timeout: 30000
  });

  const fixtureRunsFile = path.join(fixture, 'docs', 'ops', 'RUNS.jsonl');
  assert.ok(fs.existsSync(fixtureRunsFile), 'fixture RUNS.jsonl must exist');
  const records = runrecord.readRecords(fixtureRunsFile);
  assert.equal(records.length, 1, 'should have one record');
  assert.equal(records[0].slot, 'slot-f2a05');

  const finalTracked = getTrackedStatus();
  assert.deepEqual(initialTracked, finalTracked, 'real tree must be unchanged');
});


test('the imported journal is bound to the test temp root, never the tracked tree', () => {
  const tmp = tt.mkTmp('disp-w5-');
  const journalRoot = path.join(tmp, 'journal-root');
  const launchFile = path.join(TEST_TMP_DIR, 'w5-launch.md').replace(/\\/g, '/');
  const outFile = DEFAULT_OUT_FILE;
  const journalRel = '.ai/worklog/gemini-0123456789abcdef.md';
  const journalInTemp = path.join(journalRoot, '.ai', 'worklog', 'gemini-0123456789abcdef.md');
  const journalInRepo = path.resolve(repoRoot, journalRel);

  fs.mkdirSync(path.dirname(path.resolve(repoRoot, launchFile)), { recursive: true });
  fs.writeFileSync(path.resolve(repoRoot, launchFile), '# journal launch\n', 'utf8');

  const fakeRegPath = path.join(tmp, 'clients.json');
  fs.writeFileSync(fakeRegPath, JSON.stringify({
    schema: 'clients/1',
    clients: {
      fake: {
        binary: 'node',
        present: true,
        version: process.version,
        verifiedOn: '2026-09-26',
        source: 'node --version',
        command: ['node', FAKE_CLIENT, 'work', '{workdir}', '{workdir}'],
        model: { how: 'none', listing: null },
        effort: { how: 'none', values: null, note: null },
        env: {},
        resume: { command: null, sessionId: null, note: 'none' },
        usage: 'none',
        failureModes: []
      }
    }
  }), 'utf8');

  const dispPath = path.join(tmp, 'disp.json');
  fs.writeFileSync(dispPath, JSON.stringify({
    stateDir: path.relative(repoRoot, path.join(tmp, 'state')).replace(/\\/g, '/'),
    slots: [
      { id: 'w5-slot', launch: launchFile, out: outFile, route: { client: 'fake', model: 'test' } }
    ]
  }), 'utf8');

  try {
    const r = runBin(['run', dispPath, '--registry', fakeRegPath], repoRoot, {
      PROTOCOL_JOURNAL_IMPORT_ROOT: journalRoot
    });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /^DONE slot=w5-slot/m);

    assert.ok(fs.existsSync(journalInTemp), 'the imported journal must land inside the test temp root');
    assert.ok(!fs.existsSync(journalInRepo), 'the imported journal must never land in the tracked tree');
    const porcelain = spawnSync('git', ['status', '--porcelain'], {
      cwd: path.resolve(__dirname, '..'),
      encoding: 'utf8',
      windowsHide: true
    }).stdout || '';
    assert.ok(!porcelain.includes('gemini-0123456789abcdef'), `git status must stay clean of the test journal: ${porcelain}`);
  } finally {
    try { fs.unlinkSync(journalInTemp); } catch {}
    try { fs.unlinkSync(journalInRepo); } catch {}
    try { fs.unlinkSync(path.resolve(repoRoot, launchFile)); } catch {}
    try { fs.unlinkSync(path.resolve(repoRoot, outFile)); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The two library-level runDispatch calls below are the private cross-leaf binding
// tests the modularization plan requires (Rev 7, section 5): they prove cli.cjs
// resolves executor.cjs's updateUsageFile/emitFallSignal through the split without a
// ReferenceError, at the library level the CLI-spawned fixtures never reach.

test('library-level runDispatch with dispatch.usageFile renders the usage file', async () => {
  const tmp = tt.mkTmp('disp-b1-');
  const launchFile = path.join(TEST_TMP_DIR, 'b1-launch.md').replace(/\\/g, '/');

  fs.mkdirSync(path.dirname(path.resolve(repoRoot, launchFile)), { recursive: true });
  fs.writeFileSync(path.resolve(repoRoot, launchFile), '# usage launch\n', 'utf8');

  try {
    const fakeRegPath = path.join(tmp, 'clients.json');
    fs.writeFileSync(fakeRegPath, JSON.stringify({
      schema: 'clients/1',
      clients: {
        fake: {
          binary: 'node',
          present: true,
          version: process.version,
          verifiedOn: '2026-10-02',
          source: 'node --version',
          command: ['node', FAKE_CLIENT, 'work', '{workdir}', '{workdir}'],
          model: { how: 'none', listing: null },
          effort: { how: 'none', values: null, note: null },
          env: {},
          resume: { command: null, sessionId: null, note: 'none' },
          usage: 'none',
          failureModes: []
        }
      }
    }), 'utf8');

    const runsFile = path.join(tmp, 'RUNS.jsonl');
    const signalsFile = path.join(tmp, 'SIGNALS.md');
    const usageFile = path.join(tmp, 'usage.md');
    const dispPath = path.join(tmp, 'disp.json');
    fs.writeFileSync(dispPath, JSON.stringify({
      stateDir: path.relative(repoRoot, path.join(tmp, 'state')).replace(/\\/g, '/'),
      usageFile: path.relative(repoRoot, usageFile).replace(/\\/g, '/'),
      stallMin: 10,
      hardMin: 60,
      slots: [
        {
          id: 'b1-slot',
          launch: launchFile,
          out: DEFAULT_OUT_FILE,
          route: { client: 'fake', model: 'test' }
        }
      ]
    }), 'utf8');

    const code = await dispatch.runDispatch(dispPath, [], {
      repoRoot, registry: fakeRegPath, runsFile, signalsFile
    });

    assert.equal(code, 0);
    assert.ok(fs.existsSync(usageFile), 'the usage file must be rendered by the library-level runDispatch');
    const usageText = fs.readFileSync(usageFile, 'utf8');
    assert.ok(usageText.includes('b1-slot'), 'the rendered usage table must name the slot');
  } finally {
    try { fs.unlinkSync(path.resolve(repoRoot, launchFile)); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});


test('library-level runDispatch on stall exhaustion emits the fall signal', async () => {
  const tmp = tt.mkTmp('disp-b2-');
  const launchFile = path.join(TEST_TMP_DIR, 'b2-launch.md').replace(/\\/g, '/');

  fs.mkdirSync(path.dirname(path.resolve(repoRoot, launchFile)), { recursive: true });
  fs.writeFileSync(path.resolve(repoRoot, launchFile), '# stall launch\n', 'utf8');

  try {
    const fakeRegPath = path.join(tmp, 'clients-no-resume.json');
    fs.writeFileSync(fakeRegPath, JSON.stringify({
      schema: 'clients/1',
      clients: {
        fake: {
          binary: 'node',
          present: true,
          version: process.version,
          verifiedOn: '2026-10-02',
          source: 'node --version',
          command: ['node', FAKE_CLIENT, 'stall-wake', '{workdir}', '{workdir}'],
          model: { how: 'none', listing: null },
          effort: { how: 'none', values: null, note: null },
          env: {},
          resume: { command: null, sessionId: null, note: 'no resume' },
          usage: 'none',
          failureModes: []
        }
      }
    }), 'utf8');

    const runsFile = path.join(tmp, 'RUNS.jsonl');
    const signalsFile = path.join(tmp, 'SIGNALS.md');
    const dispPath = path.join(tmp, 'disp.json');
    fs.writeFileSync(dispPath, JSON.stringify({
      stateDir: path.relative(repoRoot, path.join(tmp, 'state')).replace(/\\/g, '/'),
      stallMin: 10,
      hardMin: 60,
      slots: [
        {
          id: 'b2-slot',
          launch: launchFile,
          out: DEFAULT_OUT_FILE,
          route: { client: 'fake', model: 'test-no-res' }
        }
      ]
    }), 'utf8');

    const code = await dispatch.runDispatch(dispPath, [], {
      repoRoot, registry: fakeRegPath, runsFile, signalsFile, stallSeconds: 1
    });

    assert.equal(code, 1);
    assert.ok(fs.existsSync(signalsFile), 'the fixture signalsFile must exist');
    const lines = fs.readFileSync(signalsFile, 'utf8').split('\n').filter(l => l.startsWith('Signal: '));
    const fallLine = lines.find(l => l.includes(' | fall | '));
    assert.ok(fallLine, 'a fall signal must land in the fixture signalsFile without a ReferenceError');
    assert.ok(fallLine.includes('fake:test-no-res'), 'the fall signal must name client:model');
  } finally {
    try { fs.unlinkSync(path.resolve(repoRoot, launchFile)); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// The successful-start behavior test the golden corpus deliberately excludes: start
// spawns a detached, unref'd child and forwards no --registry/--ladder, so the fixture
// confines the child through its own loadRegistry default (.ai/docs/clients.json inside
// the fixture root). Teardown waits for that child's observed exit; on timeout the
// harness kills and reaps exactly that fixture PID and fails.

test('START: a successful start runs a confined child whose exit is observed before teardown', async (t) => {
  const helpers = require('./helpers.cjs');
  const root = helpers.makeFixture(t);
  helpers.seedProtocol(root);

  const fakeClientRel = path.join('tests', 'dispatch-fake-client.cjs').replace(/\\/g, '/');
  fs.writeFileSync(path.join(root, '.ai', 'docs', 'clients.json'), JSON.stringify({
    schema: 'clients/1',
    clients: {
      fake: {
        binary: 'node',
        present: true,
        version: process.version,
        verifiedOn: '2026-10-02',
        source: 'node --version',
        command: ['node', fakeClientRel, 'work', '{workdir}', '{workdir}'],
        model: { how: 'none', listing: null },
        effort: { how: 'none', values: null, note: null },
        env: {},
        resume: { command: null, sessionId: null, note: 'none' },
        usage: 'none',
        failureModes: []
      }
    }
  }, null, 2), 'utf8');
  fs.writeFileSync(path.join(root, 'start-launch.md'), '# Start launch\n', 'utf8');
  fs.writeFileSync(path.join(root, 'dispatch.json'), JSON.stringify({
    version: 1,
    stateDir: 'start-state',
    stallMin: 10,
    hardMin: 60,
    slots: [
      {
        id: 'start-slot',
        launch: 'start-launch.md',
        packet: false, // This isolated START contract intentionally exercises the legacy no-packet fixture.
        out: 'tests/fixtures/dispatch/out1.txt',
        route: { client: 'fake', model: 'test' }
      }
    ]
  }, null, 2), 'utf8');

  for (const gitArgs of [
    ['add', '-A'],
    ['-c', 'user.name=Protocol Test', '-c', 'user.email=protocol-test@example.invalid',
      'commit', '-m', 'Start fixture content'],
  ]) {
    const result = helpers.git(root, gitArgs);
    assert.equal(result.status, 0, result.stderr || String(result.error));
  }

  const childEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(PROTOCOL_|TEST_DISPATCH_)/.test(k)) continue;
    childEnv[k] = v;
  }
  Object.assign(childEnv, CHILD_TMP_ENV);
  const r = spawnSync(process.execPath, [
    path.join(root, '.ai', 'bin', 'protocol-dispatch.cjs'),
    'start', 'dispatch.json'
  ], { cwd: root, encoding: 'utf8', windowsHide: true, env: childEnv, timeout: 60000 });

  assert.equal(r.status, 0, r.stderr);
  const pidMatch = (r.stdout || '').match(/^START dispatch=dispatch\.json pid=(\d+)$/m);
  assert.ok(pidMatch, `start must print its child pid: ${r.stdout}`);
  const childPid = Number(pidMatch[1]);

  // Bounded wait for the detached child's observed exit; never tear the fixture down
  // first, and never leave the child running.
  const deadline = Date.now() + 60000;
  let exited = false;
  while (Date.now() < deadline) {
    try {
      process.kill(childPid, 0);
    } catch {
      exited = true;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!exited) {
    try { process.kill(childPid); } catch {}
    assert.fail(`the start child ${childPid} did not exit within the bounded wait`);
  }

  // Behavior assertions after the observed exit: the DONE analogue is the slot state,
  // plus the run record in the fixture-default runs file.
  const stateFile = path.join(root, 'start-state', 'state.json');
  assert.ok(fs.existsSync(stateFile), 'the child must have written its state file');
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  assert.equal(state.slots['start-slot'].status, 'DONE', 'the started child must complete its slot');
  const runsFile = path.join(root, 'docs', 'ops', 'RUNS.jsonl');
  assert.ok(fs.existsSync(runsFile), 'the child must append to the fixture-default runs file');
  const records = runrecord.readRecords(runsFile);
  assert.equal(records.length, 1);
  assert.equal(records[0].slot, 'start-slot');
});


test('Guard test: test suite leaves no changes to tracked files', () => {
  const currentRaw = spawnSync('git', ['status', '--porcelain'], {
    cwd: path.resolve(__dirname, '..'),
    encoding: 'utf8',
    windowsHide: true
  }).stdout || '';
  const current = currentRaw.split('\n').map(l => l.trimEnd()).filter(l => Boolean(l) && !l.startsWith('?? '));
  const changed = current.filter(l => !initialTrackedStatus.includes(l));
  assert.deepEqual(changed, [], `Test suite modified tracked files:\n${changed.join('\n')}`);
  assert.ok(!changed.some(l => l.includes('.ai/SIGNALS.md')), '.ai/SIGNALS.md polluted');
  assert.ok(!changed.some(l => l.includes('docs/ops/RUNS.jsonl')), 'docs/ops/RUNS.jsonl polluted');
  assert.ok(!changed.some(l => l.includes('hang-launch.md')), 'hang-launch.md modified/deleted');
  assert.ok(!changed.some(l => l.includes('t21-launch.md')), 't21-launch.md modified/deleted');

  const currentFixtures = getFixturesStatus();
  const changedFixtures = currentFixtures.filter(l => !initialFixturesStatus.includes(l));
  assert.deepEqual(changedFixtures, [], `Test suite modified or created files under tests/fixtures:\n${changedFixtures.join('\n')}`);

  // The fake client's journal never reaches the tracked tree, not even as an
  // untracked file a killed run would leave behind.
  assert.ok(!fs.existsSync(path.resolve(repoRoot, '.ai/worklog/gemini-0123456789abcdef.md')),
    'the fake client journal leaked into the tracked tree');
  const porcelainAll = currentRaw;
  assert.ok(!porcelainAll.includes('gemini-0123456789abcdef'),
    `git status must stay clean of the fake client journal:\n${porcelainAll}`);
});

test.after(() => {
  try { fs.rmSync(testTmpAbs, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(TEST_SUITE_TMP, { recursive: true, force: true }); } catch {}
});

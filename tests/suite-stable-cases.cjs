'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { tt } = require('./helpers.cjs');
const fake = path.join(__dirname, 'dispatch-fake-client.cjs');

function setup(t) {
  const root = tt.mkTmp('suite-stable-probe-', t);
  const preload = path.join(root, 'slow-stdout.cjs');
  fs.writeFileSync(preload, `const fs = require('node:fs');
const Module = require('node:module');
const compile = Module.prototype._compile;
Module.prototype._compile = function(content, filename) {
  if (filename === ${JSON.stringify(fake)} && process.env.SUITE_STABLE_FAKE_SOURCE) content = fs.readFileSync(process.env.SUITE_STABLE_FAKE_SOURCE, 'utf8');
  return compile.call(this, content, filename);
};
const write = process.stdout.write.bind(process.stdout);
process.stdout.write = (data, cb) => { setTimeout(() => write(data, cb), 100); return true; };
`);
  const marker = path.join(root, 'retry.marker');
  const run = (extra = {}, mode = 'transient-retry', args = []) => {
    const env = { ...process.env, FAKE_TRANSIENT_MARKER: marker, TEST_DISPATCH_OUT_FILE: 'out.txt', ...extra };
    delete env.NODE_TEST_CONTEXT;
    return spawnSync(process.execPath, ['--require', preload, fake, mode, root, root, ...args], {
      env, encoding: 'utf8', windowsHide: true, timeout: 60000
    });
  };
  return { root, marker, run };
}

test('SUITE-STABLE first diagnostic survives an asynchronous stdout write before exit', t => {
  const f = setup(t), r = f.run();
  assert.ifError(r.error);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /HTTP 429 Too Many Requests: rate limit exceeded/);
  assert.equal(fs.readFileSync(f.marker, 'utf8'), '1');
});
test('SUITE-STABLE retry output survives an asynchronous stdout write before exit', t => {
  const f = setup(t);
  fs.writeFileSync(f.marker, '1');
  const r = f.run();
  assert.ifError(r.error);
  assert.equal(r.status, 0);
  assert.match(r.stdout, /PROGRESS succeeded on retry/);
  assert.equal(fs.existsSync(f.marker), false);
  assert.equal(fs.readFileSync(path.join(f.root, 'out.txt'), 'utf8'), 'result from fake client\n');
  assert.ok(fs.existsSync(path.join(f.root, '.ai/worklog/gemini-0123456789abcdef.md')));
});
test('SUITE-STABLE markers in separate roots never consume another run retry', t => {
  const a = setup(t), b = setup(t);
  for (const f of [a, b]) assert.equal(f.run().status, 1);
  assert.equal(a.run().status, 0);
  assert.equal(fs.readFileSync(b.marker, 'utf8'), '1');
  assert.equal(b.run().status, 0);
});
test('SUITE-STABLE a missing marker directory cannot report a successful retry', t => {
  const f = setup(t), r = f.run({ FAKE_TRANSIENT_MARKER: path.join(f.root, 'missing', 'marker') });
  assert.ifError(r.error);
  assert.notEqual(r.status, 0);
  assert.equal(fs.existsSync(path.join(f.root, 'out.txt')), false);
});
test('SUITE-STABLE an unwritable declared output cannot report success', t => {
  const f = setup(t);
  fs.writeFileSync(f.marker, '1');
  fs.mkdirSync(path.join(f.root, 'out.txt'));
  const r = f.run();
  assert.ifError(r.error);
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(r.stdout, /PROGRESS succeeded/);
});

for (const [mode, code, diagnostic, args = []] of [
  ['work', 0, 'PROGRESS step 2 completed'],
  ['auth-error', 1, '401 Unauthorized'],
  ['rate-limit', 1, 'HTTP 429'],
  ['quota-exhausted', 1, 'RESOURCE_EXHAUSTED'],
  ['model-unavailable', 1, 'model gpt-unknown'],
  ['network-error', 1, 'ECONNRESET'],
  ['provider-error', 1, 'HTTP 503'],
  ['process-crash', 42, 'PROGRESS useful progress'],
  ['invalid-output-missing', 0, 'without writing outputs'],
  ['invalid-output-empty', 0, 'writing 0 bytes'],
  ['repair-mode', 0, 'SESSION_ID: fake-repair'],
  ['repair-mode', 0, 'repair finished successfully', ['--resume']],
  ['crash-resume', 42, 'SESSION_ID: fake-crash'],
  ['crash-resume', 0, 'crash resumed successfully', ['--resume']]
]) test(`SUITE-STABLE stdout flush: ${mode} ${args.join(' ')}`, t => {
  const f = setup(t), r = f.run({}, mode, args);
  assert.ifError(r.error);
  assert.equal(r.status, code);
  assert.ok(r.stdout.includes(diagnostic), 'the complete diagnostic reached the reader');
});

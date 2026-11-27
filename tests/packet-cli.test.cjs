'use strict';
// The CLI boundary of the packet compiler: exit codes, output files, --check and frame lint. Everything else is
// tested in-process in tests/packet.test.cjs (PROTO-DEC-0165 item 5).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repoRoot, run } = require('./helpers.cjs');
const { tt } = require('./helpers.cjs');

const TOOL = path.join(repoRoot, '.ai', 'bin', 'protocol-packet.cjs');
const cli = (args, cwd = repoRoot) => {
  const r = run(process.execPath, [TOOL, ...args], cwd);
  return { status: r.status, out: r.stdout + r.stderr };
};
function kernelCopy(t) {
  const root = tt.mkTmp('colabs-packet-cli-');
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  fs.cpSync(path.join(repoRoot, '.ai', 'core'), path.join(root, '.ai', 'core'), { recursive: true });
  return root;
}

test('compile-packet writes the packet and its manifest, prints PACKET and RESULT rows, exit 0', t => {
  const root = kernelCopy(t);
  // the premise of `--client claude` is a client that opens files; a root without the registry reads it as a client without file access (full text, 80970 bytes, soft target missed once the 25 records of PROTO-DEC-0192 are active)
  fs.mkdirSync(path.join(root, '.ai', 'docs'), { recursive: true });
  fs.copyFileSync(path.join(repoRoot, '.ai', 'docs', 'clients.json'), path.join(root, '.ai', 'docs', 'clients.json'));
  const manifestOut = path.join(root, 'manifest.json');
  const r = cli(['compile-packet', '--role', 'implementer', '--stage', 'execute', '--client', 'claude', '--root', root, '--manifest-out', manifestOut]);
  assert.equal(r.status, 0, r.out);
  assert.match(r.out, /^PACKET role=implementer stage=execute bytes=\d+ estTokens=\d+ estimated=true softTokens=25000 degraded=0 packetHash=sha256:[0-9a-f]{64} treeSha=sha256:[0-9a-f]{64} path=\.ai\/runtime\/packets\/implementer-execute-[0-9a-f]{8}-[0-9a-f]{8}\.md$/m);
  assert.match(r.out, /^RESULT exit=0 softMissed=false$/m);
  const file = r.out.match(/path=(\S+)/)[1];
  const packetText = fs.readFileSync(path.join(root, file), 'utf8');
  assert.match(packetText.split('\n')[0], /^authority: /);
  const manifest = JSON.parse(fs.readFileSync(manifestOut, 'utf8'));
  assert.equal(manifest.schema, 'packet/1');
  assert.equal(manifest.packetHash, r.out.match(/packetHash=(\S+)/)[1]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, file.replace(/\.md$/, '.json')), 'utf8')), manifest);
  // a second run reproduces the same bytes and the same file name
  const again = cli(['compile-packet', '--role', 'implementer', '--stage', 'execute', '--client', 'claude', '--root', root]);
  assert.equal(again.out.match(/path=(\S+)/)[1], file);
  assert.equal(fs.readFileSync(path.join(root, file), 'utf8'), packetText);
});

test('--stdout prints the packet text; unknown input exits 2 with an ERROR row', t => {
  const root = kernelCopy(t);
  const printed = cli(['compile-packet', '--role', 'reviewer', '--stage', 'accept', '--root', root, '--stdout']);
  assert.equal(printed.status, 0, printed.out);
  assert.match(printed.out, /^authority: AGENTS\.md/);
  for (const args of [['--role', 'plumber', '--stage', 'execute'], ['--role', 'reviewer', '--stage', 'freeze-dry'], ['--role', 'reviewer', '--stage', 'accept', '--bogus', 'x'], ['--stage', 'accept']]) {
    const bad = cli(['compile-packet', ...args, '--root', root]);
    assert.equal(bad.status, 2, `${args.join(' ')}: ${bad.out}`);
    assert.match(bad.out, /^ERROR reason=/m);
  }
  assert.equal(cli(['no-such-command']).status, 2);
});

test('a byte-gate failure exits 1 with a REPORT row naming the offenders and the owner card', t => {
  const root = kernelCopy(t);
  const r = cli(['compile-packet', '--role', 'coordinator', '--stage', 'dispatch', '--client', 'claude', '--budget-bytes', '4000', '--root', root]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^REPORT reason=.* offenders=\S+ card="PROTO-DEC-0161 item 3/m);
  assert.match(r.out, /^RESULT exit=1 /m);
});

test('check: a packet built from another tree is stale (exit 1), a current one is not (exit 0)', t => {
  const root = kernelCopy(t);
  const built = cli(['compile-packet', '--role', 'auditor', '--stage', 'triage', '--root', root]);
  const packetFile = path.join(root, built.out.match(/path=(\S+)/)[1]);
  const fresh = cli(['check', '--packet', packetFile, '--root', root]);
  assert.equal(fresh.status, 0, fresh.out);
  assert.match(fresh.out, /^RESULT exit=0 stale=false$/m);
  const edited = path.join(root, '.ai', 'core', 'L0-meta', 'P-L0-001-procedure-lifecycle.md');
  fs.writeFileSync(edited, fs.readFileSync(edited, 'utf8') + ' ');
  const stale = cli(['check', '--packet', packetFile, '--root', root]);
  assert.equal(stale.status, 1, stale.out);
  assert.match(stale.out, /^RESULT exit=1 stale=true$/m);
  fs.writeFileSync(path.join(root, 'junk.md'), 'no identity line here\n');
  assert.equal(cli(['check', '--packet', path.join(root, 'junk.md'), '--root', root]).status, 2);
});

test('frame lint: an informal operator frame exits 1 and names the missing fields; a missing file exits 2', t => {
  const root = kernelCopy(t);
  fs.writeFileSync(path.join(root, 'frame.md'), '# Task-frame: x\n\n- Role: DeepSeek\n- Write-set: docs/x.md only\n');
  const r = cli(['frame', 'lint', '--frame', path.join(root, 'frame.md'), '--root', root]);
  assert.equal(r.status, 1, r.out);
  assert.match(r.out, /^MISSING field=goal$/m);
  assert.match(r.out, /^RESULT exit=1 required=\d+ missing=\d+ problems=0$/m);
  assert.equal(cli(['frame', 'lint', '--frame', path.join(root, 'absent.md'), '--root', root]).status, 2);
});


const COMPLETE_FRAME = [
  'goal: finish the thing',
  'non-goals: []',
  'sources: [docs/x.md: tracked]',
  'baseline: 0123456789012345678901234567890123456789',
  'scope-id: task:fixround',
  'parent-scope: -',
  'scope: [docs/reviews/*]',
  'forbidden: [**]',
  'risk: high',
  'tier: T3',
  'success: [budget gate]',
  'budgets: {attempts: 1}',
  'stage: execute',
].join('\n') + '\n';

test('smokes: draft force-include, junction frame and a damaged kernel all exit 2', t => {
  const root = kernelCopy(t);
  // A draft record is never force-included into an active packet (TOOL-protocol-packet was active from PROTO-DEC-0184; the copy is set back to draft)
  const tool = path.join(root, '.ai', 'core', 'L3-tools', 'TOOL-protocol-packet.md');
  fs.writeFileSync(tool, fs.readFileSync(tool, 'utf8').replace('status: active', 'status: draft'));
  const draft =cli(['compile-packet', '--role', 'implementer', '--stage', 'execute', '--needs-rules', 'R-L3-protocol-packet.1', '--root', root]);
  assert.equal(draft.status, 2, draft.out);
  assert.match(draft.out, /status \\"draft\\"/);
  // A junction inside the root does not smuggle in a frame from outside it
  const outside = tt.mkTmp('colabs-packet-out-');
  t.after(() => fs.rmSync(outside, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  fs.writeFileSync(path.join(outside, 'frame.md'), COMPLETE_FRAME.replace('finish the thing', 'EXTERNAL_FRAME_MARKER'));
  fs.symlinkSync(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  const junction = cli(['compile-packet', '--role', 'implementer', '--stage', 'execute', '--frame', path.join(root, 'linked', 'frame.md'), '--root', root]);
  assert.equal(junction.status, 2, junction.out);
  assert.match(junction.out, /symlink|outside the repository root/);
  // A kernel root without its Rules section refuses the compile
  const rootFile = path.join(root, '.ai', 'core', 'L0-ROOT.md');
  fs.writeFileSync(rootFile, fs.readFileSync(rootFile, 'utf8').replace(/\n## Rules\n[\s\S]*?(?=\n## )/, ''));
  const damaged = cli(['compile-packet', '--role', 'implementer', '--stage', 'execute', '--root', root]);
  assert.equal(damaged.status, 2, damaged.out);
  assert.match(damaged.out, /no \\"## Rules\\" section/);
});

test('smoke: a contradictory frame fails compile-packet with exit 1 and a named report; frame lint names the duplicate', t => {
  const root = kernelCopy(t);
  fs.writeFileSync(path.join(root, 'frame.md'), COMPLETE_FRAME + 'goal: second contradictory value\n');
  const lint = cli(['frame', 'lint', '--frame', path.join(root, 'frame.md'), '--root', root]);
  assert.equal(lint.status, 1, lint.out);
  assert.match(lint.out, /PROBLEM reason="field \\"goal\\" appears 2 times; one field = one value"/);
  const compile = cli(['compile-packet', '--role', 'implementer', '--stage', 'execute', '--frame', path.join(root, 'frame.md'), '--root', root]);
  assert.equal(compile.status, 1, compile.out);
  assert.match(compile.out, /^REPORT reason="the frame does not pass its schema lint/);
  assert.match(compile.out, /appears 2 times/);
  assert.match(compile.out, /^RESULT exit=1$/m);
  assert.ok(!fs.existsSync(path.join(root, '.ai', 'runtime', 'packets')), 'no packet file is written for a refused frame');
});

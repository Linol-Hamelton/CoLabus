'use strict';
// docs/ops/kernel-install.cjs: where the kernel block goes in a host's AGENTS.md and CLAUDE.md. The host owns
// those files; the kernel owns one marker block. These tests need no product build and run in the development tree and in the product.
// Full installation into fixture hosts also runs in the installability gate of the product build.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const tt = require('../docs/ops/lib/test-tmp.cjs');
// KERNEL_INSTALL_UNDER_TEST points the byte matrix at another copy of the module (an older or a mutated one) to show which rows it breaks
const ki = require(process.env.KERNEL_INSTALL_UNDER_TEST || '../docs/ops/kernel-install.cjs');

const BLOCK = Buffer.from(`${ki.START}\n# Kernel\n\nRules.\n${ki.END}\n`);
const host = (t, files) => {
  const dir = tt.mkTmp('ki-host-', t);
  for (const [rel, bytes] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), bytes); }
  return dir;
};
const B = s => Buffer.from(s, 'utf8');
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const S = ki.START;
const E = ki.END;
test('owner-full staff startup replaces only kernel blocks and keeps host instructions out of the write set', t => {
  const start = 'STAFF-PC: hostRole: "staff". Role: operator; read the access cache.';
  for (const rel of ['AGENTS.md', 'CLAUDE.md']) {
    const original = B(`# Product\r\n${S}\nold kernel\n${E}\nUse .agents/skills/product/SKILL.md\r\n`);
    const dir = host(t, { [rel]: original });
    const block = B(`${S}\n${start}\n${E}\n`);
    const planned = ki.planInstruction(dir, rel, block);
    assert.equal(planned.action, 'replace-block'); assert.equal(planned.rel, rel);
    assert.deepEqual(ki.hostBytes(rel, planned.bytes), ki.hostBytes(rel, original));
    assert(planned.bytes.includes(B('hostRole: "staff"')));
    assert.deepEqual(fs.readFileSync(path.join(dir, rel)), original, 'planning has no write side effects');
    assert.deepEqual(ki.parseArgs(['--target', dir, '--profile', 'owner-full']), {
      target: dir, update: false, dryRun: false, profile: 'owner-full'
    });
  }
});
// The host bytes of a file, computed here independently of the module: the file without the region from the start marker line
// through the end marker line and its own line end. Marker lines are found by plain line comparison (the matrix has no fences).
function hostOf(buf) {
  const s = buf.indexOf(B(S));
  if (s < 0) return buf;
  const e = buf.indexOf(B(E), s);
  let after = e + B(E).length;
  if (buf[after] === 0x0d && buf[after + 1] === 0x0a) after += 2; else if (buf[after] === 0x0a) after += 1;
  return Buffer.concat([buf.subarray(0, s), buf.subarray(after)]);
}

// Each row: the host's original bytes, the action, and the exact expected file. The rule: every host byte outside the block stays.
const MATRIX = [
  ['LF, no block', B('# Host\n\nOwn rules.\n'), 'prepend-block', o => Buffer.concat([BLOCK, o])],
  ['CRLF, no block', B('# Host\r\n\r\nOwn rules.\r\n'), 'prepend-block', o => Buffer.concat([BLOCK, o])],
  ['mixed CRLF and LF, no block', B('# Host\r\nline two\nline three\r\n'), 'prepend-block', o => Buffer.concat([BLOCK, o])],
  ['no final newline, no block', B('# Host\n\nlast line'), 'prepend-block', o => Buffer.concat([BLOCK, o])],
  ['BOM and LF, no block', Buffer.concat([BOM, B('# Host\nOwn.\n')]), 'prepend-block', o => Buffer.concat([BOM, BLOCK, o.subarray(3)])],
  ['BOM, CRLF, no final newline, no block', Buffer.concat([BOM, B('# Host\r\nOwn.')]), 'prepend-block', o => Buffer.concat([BOM, BLOCK, o.subarray(3)])],
  ['block at the start (LF)', B(`${S}\nold\n${E}\n# Host\n`), 'replace-block', () => Buffer.concat([BLOCK, B('# Host\n')])],
  ['block in the middle (CRLF)', B(`# Before\r\n${S}\r\nold\r\n${E}\r\n# After\r\n`), 'replace-block', () => Buffer.concat([B('# Before\r\n'), BLOCK, B('# After\r\n')])],
  ['block at the end, no final newline', B(`# Before\n${S}\nold\n${E}`), 'replace-block', () => Buffer.concat([B('# Before\n'), BLOCK])],
  ['BOM, then the block (CRLF)', Buffer.concat([BOM, B(`${S}\r\nold\r\n${E}\r\n# After\r\n`)]), 'replace-block', () => Buffer.concat([BOM, BLOCK, B('# After\r\n')])],
  ['BOM, host text, block, host text', Buffer.concat([BOM, B(`# Before\r\n${S}\nold\n${E}\n# After`)]), 'replace-block', () => Buffer.concat([BOM, B('# Before\r\n'), BLOCK, B('# After')])],
  ['the current block already in place', Buffer.concat([B('# Before\r\n'), BLOCK, B('# After\r\n')]), 'unchanged', o => o],
];

test('byte matrix: every host byte outside the block stays (BOM, CRLF, LF, mixed, no final newline; block at start, middle, end)', t => {
  const broken = [];
  for (const [name, original, action, expected] of MATRIX) {
    const dir = host(t, { 'AGENTS.md': original });
    let p;
    try { p = ki.planInstruction(dir, 'AGENTS.md', BLOCK); } catch (e) { broken.push(`${name}: refused ${e.id || e.message}`); continue; }
    if (p.action !== action) broken.push(`${name}: action ${p.action}, expected ${action}`);
    if (!p.bytes.equals(expected(original))) broken.push(`${name}: bytes differ from the expected file`);
    if (!hostOf(p.bytes).equals(hostOf(original))) broken.push(`${name}: host bytes outside the block changed`);
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), p.bytes);
    const again = ki.planInstruction(dir, 'AGENTS.md', BLOCK);
    if (again.action !== 'unchanged' || !again.bytes.equals(p.bytes)) broken.push(`${name}: a second run is not "unchanged"`);
  }
  assert.deepEqual(broken, [], broken.join('\n'));
});

test('a second kernel block, marker text that is not a line of its own, and a block inside a code fence', t => {
  const refused = (text, id) => assert.throws(() => ki.planInstruction(host(t, { 'AGENTS.md': B(text) }), 'AGENTS.md', BLOCK), e => e.id === id, text);
  refused(`${S}\na\n${E}\n# middle\n${S}\nb\n${E}\n`, 'R10');
  refused(`${S}\r\na\r\n${E}\r\n${S}\r\nb\r\n${E}\r\n`, 'R10');
  refused(`# Host\nThe kernel writes ${S} here.\n`, 'R10');
  refused(`# Host\n  ${S}\nx\n  ${E}\n`, 'R10');
  refused(`# Host\n${S} trailing\n`, 'R10');
  // a marker line inside a fenced code block is an example in the host's text, never the kernel block
  const fenced = B(`# Host\n\n\`\`\`markdown\n${S}\nexample\n${E}\n\`\`\`\n\n~~~\n${S}\n~~~\n`);
  const dir = host(t, { 'AGENTS.md': fenced });
  const p = ki.planInstruction(dir, 'AGENTS.md', BLOCK);
  assert.equal(p.action, 'prepend-block');
  assert.ok(p.bytes.equals(Buffer.concat([BLOCK, fenced])));
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), p.bytes);
  assert.equal(ki.planInstruction(dir, 'AGENTS.md', BLOCK).action, 'unchanged', 'the fenced example is not a second block');
});

test('a file edited, replaced by a link or created between the plan and the write is caught right before the write', t => {
  const dir = host(t, { 'AGENTS.md': B('# Host\n') });
  const p = ki.planInstruction(dir, 'AGENTS.md', BLOCK);
  assert.equal(ki.changedSincePlan(dir, p), null, 'unchanged since the plan');
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# Host, edited meanwhile\n');
  assert.match(ki.changedSincePlan(dir, p), /changed during the install/);
  const fresh = host(t, {});
  const c = ki.planInstruction(fresh, 'CLAUDE.md', BLOCK);
  fs.writeFileSync(path.join(fresh, 'CLAUDE.md'), '# appeared\n');
  assert.match(ki.changedSincePlan(fresh, c), /appeared during the install/);
  const swapped = host(t, { 'AGENTS.md': B('# Host\n'), 'elsewhere/AGENTS.md': B('# other\n') });
  const s = ki.planInstruction(swapped, 'AGENTS.md', BLOCK);
  fs.renameSync(path.join(swapped, 'AGENTS.md'), path.join(swapped, 'moved-away.md'));
  fs.symlinkSync(path.join(swapped, 'elsewhere'), path.join(swapped, 'AGENTS.md'), 'junction');
  assert.match(ki.changedSincePlan(swapped, s), /replaced by a link/);
});

test('a hard-linked or read-only instruction file is refused before any write', t => {
  const dir = host(t, { 'AGENTS.md': B('# Host\n'), 'other/name.md': B('x\n') });
  fs.linkSync(path.join(dir, 'AGENTS.md'), path.join(dir, 'other', 'AGENTS-alias.md'));
  assert.throws(() => ki.planInstruction(dir, 'AGENTS.md', BLOCK), e => e.id === 'R9' && /hard links/.test(e.message));
  const ro = host(t, { 'CLAUDE.md': B('# Host\n') });
  fs.chmodSync(path.join(ro, 'CLAUDE.md'), 0o444);
  t.after(() => { try { fs.chmodSync(path.join(ro, 'CLAUDE.md'), 0o644); } catch { /* fixture cleanup only */ } });
  assert.throws(() => ki.planInstruction(ro, 'CLAUDE.md', BLOCK), e => e.id === 'R9' && /read-only/.test(e.message));
  const asDir = host(t, { 'AGENTS.md/inner.md': B('x\n') });
  assert.throws(() => ki.planInstruction(asDir, 'AGENTS.md', BLOCK), e => e.id === 'R9', 'an existing directory named AGENTS.md');
});

test('an absent instruction file is created with the block alone', t => {
  const p = ki.planInstruction(host(t, {}), 'AGENTS.md', BLOCK);
  assert.equal(p.action, 'create');
  assert.ok(p.bytes.equals(BLOCK));
});

test('a host file without the block keeps every original byte after the block (CRLF and no final newline included)', t => {
  const original = Buffer.from('# Host rules\r\n\r\n- keep this\r\n- and this, no final newline');
  const p = ki.planInstruction(host(t, { 'AGENTS.md': original }), 'AGENTS.md', BLOCK);
  assert.equal(p.action, 'prepend-block');
  assert.ok(p.bytes.equals(Buffer.concat([BLOCK, original])));
});

test('a host file with the block gets only the block replaced; text before and after it stays', t => {
  const old = `Intro of the host.\n${ki.START}\nOLD KERNEL TEXT\n${ki.END}\nHost text after.\n`;
  const p = ki.planInstruction(host(t, { 'CLAUDE.md': old }), 'CLAUDE.md', BLOCK);
  assert.equal(p.action, 'replace-block');
  assert.equal(p.bytes.toString('utf8'), `Intro of the host.\n${BLOCK.toString('utf8')}Host text after.\n`);
  const again = ki.planInstruction(host(t, { 'CLAUDE.md': p.bytes }), 'CLAUDE.md', BLOCK);
  assert.equal(again.action, 'unchanged', 'a second run changes nothing');
});

test('a kernel copy from an earlier install (digest recorded by the installed manifest) is replaced whole; an edited copy is not', t => {
  const old = Buffer.from('# AGENTS.md\n\n## AI Collaboration Protocol v1.0.0\n\nold managed rules\n');
  const digest = `sha256:${crypto.createHash('sha256').update(old).digest('hex')}`;
  const manifest = `${JSON.stringify({ role: 'installed', contentDigest: { 'AGENTS.md': digest } })}\n`;
  const p = ki.planInstruction(host(t, { 'AGENTS.md': old, 'protocol-manifest.json': manifest }), 'AGENTS.md', BLOCK);
  assert.equal(p.action, 'replace-kernel-copy');
  assert.ok(p.bytes.equals(BLOCK));
  const edited = Buffer.concat([old, Buffer.from('a line the host added\n')]);
  const q = ki.planInstruction(host(t, { 'AGENTS.md': edited, 'protocol-manifest.json': manifest }), 'AGENTS.md', BLOCK);
  assert.equal(q.action, 'prepend-block', 'host bytes are never replaced');
});

test('refusals: two blocks, an end before the start, invalid UTF-8 and a link are refused before any write', t => {
  const twice = `${ki.START}\na\n${ki.END}\n${ki.START}\nb\n${ki.END}\n`;
  assert.throws(() => ki.planInstruction(host(t, { 'AGENTS.md': twice }), 'AGENTS.md', BLOCK), e => e.id === 'R10');
  assert.throws(() => ki.planInstruction(host(t, { 'AGENTS.md': `${ki.START}\nno end\n` }), 'AGENTS.md', BLOCK), e => e.id === 'R10');
  assert.throws(() => ki.planInstruction(host(t, { 'AGENTS.md': `${ki.END}\n${ki.START}\n` }), 'AGENTS.md', BLOCK), e => e.id === 'R10');
  assert.throws(() => ki.planInstruction(host(t, { 'AGENTS.md': Buffer.from([0xc3, 0x28]) }), 'AGENTS.md', BLOCK), e => e.id === 'R9');
  const dir = host(t, { 'elsewhere/x.md': 'x\n' });
  fs.symlinkSync(path.join(dir, 'elsewhere'), path.join(dir, 'AGENTS.md'), 'junction');
  assert.throws(() => ki.planInstruction(dir, 'AGENTS.md', BLOCK), e => e.id === 'R9', 'a link (a junction here) is never written through');
});

test('usage errors exit 2 and change nothing', () => {
  const lines = [];
  assert.equal(ki.main([], s => lines.push(s)), 2);
  assert.equal(ki.main(['--target'], s => lines.push(s)), 2);
  assert.equal(ki.main(['--target', 'x', '--force-everything'], s => lines.push(s)), 2);
  assert.ok(lines.every(l => /usage error/.test(l)), lines.join('\n'));
});

function instructionAttributes(t, setupSource, kind = 'blank', hostRole) {
  const { spawnSync } = require('node:child_process');
  const Module = require('node:module');
  const source = host(t, {});
  const repo = path.resolve(__dirname, '..');
  fs.mkdirSync(path.join(source, '.ai/bin/lib'), { recursive: true });
  fs.copyFileSync(path.join(repo, '.ai/bin/lib/text-safe.cjs'), path.join(source, '.ai/bin/lib/text-safe.cjs'));
  fs.copyFileSync(path.join(repo, '.ai/bin/lib/protocol-version.cjs'), path.join(source, '.ai/bin/lib/protocol-version.cjs'));
  const integration = ['.gitattributes', '.gitignore', '.claude/settings.json', '.codex/hooks.json'];
  for (const rel of integration) {
    fs.mkdirSync(path.dirname(path.join(source, rel)), { recursive: true });
    fs.copyFileSync(path.join(repo, rel), path.join(source, rel));
  }
  fs.writeFileSync(path.join(source, 'protocol-manifest.json'), JSON.stringify({ protocolVersion: '2.0.1', managed: [], state: [], integration }));
  const filename = path.join(source, '.ai/bin/protocol-setup.cjs');
  const loaded = new Module(filename, module);
  loaded.filename = filename;
  loaded.paths = Module._nodeModulePaths(path.dirname(filename));
  loaded._compile(setupSource, filename);
  const dir = host(t, { 'README.md': '# Host\n', '.gitattributes': '# Host attributes\n*.own -text\n' });
  function git(args) {
    const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 30000 });
    assert.equal(r.status, 0, r.stderr || String(r.error));
    return r.stdout;
  }
  git(['init', '-b', 'main']);
  git(['config', 'core.autocrlf', 'true']);
  if (kind !== 'blank') for (const rel of ['AGENTS.md', 'CLAUDE.md']) fs.writeFileSync(path.join(dir, rel), kind === 'crlf' ? '# Own\r\n' : '# Own\n');
  git(['add', '.']); git(['commit', '-qm', 'Seed']);
  assert.equal(loaded.exports.runSetup(['--Target', dir]), 0);
  if (hostRole !== undefined) {
    const file = path.join(dir, 'protocol-manifest.json');
    const installed = JSON.parse(fs.readFileSync(file, 'utf8'));
    installed.hostRole = hostRole;
    fs.writeFileSync(file, JSON.stringify(installed, null, 2) + '\n');
  }
  const attrs = () => fs.readFileSync(path.join(dir, '.gitattributes'));
  const first = attrs();
  const managed = first.toString().split('# BEGIN AI COLLABORATION PROTOCOL\n')[1].split('# END AI COLLABORATION PROTOCOL')[0];
  for (const rel of ['AGENTS.md', 'CLAUDE.md']) {
    assert.ok(managed.split('\n').includes(`${rel} text eol=lf`), `${rel} must be inside the managed block`);
    assert.equal(first.toString().split(`${rel} text eol=lf`).length - 1, 1, 'one owner per attribute');
    const old = fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel)) : null;
    const p = ki.planInstruction(dir, rel, BLOCK);
    fs.writeFileSync(path.join(dir, rel), p.bytes);
    if (old) assert.deepEqual(ki.hostBytes(rel, p.bytes), old);
  }
  assert.equal(loaded.exports.runSetup(['--Target', dir, '--Force']), 0);
  if (hostRole !== undefined) assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'protocol-manifest.json'), 'utf8')).hostRole, hostRole);
  assert.deepEqual(attrs(), first, 'second install must be byte-stable');
  // Exercise the update of an existing managed block with the instruction rules absent.
  fs.writeFileSync(path.join(dir, '.gitattributes'), first.toString().replace(/^AGENTS\.md text eol=lf\n|^CLAUDE\.md text eol=lf\n/gm, ''));
  assert.equal(loaded.exports.runSetup(['--Target', dir, '--Force']), 0);
  assert.deepEqual(attrs(), first, 'update must restore both rules inside the block');
  assert.equal(git(['check-attr', 'eol', '--', 'AGENTS.md', 'CLAUDE.md']).trim(), 'AGENTS.md: eol: lf\nCLAUDE.md: eol: lf');
  git(['add', '.']); git(['commit', '-qm', 'Install']);
  for (const rel of ['AGENTS.md', 'CLAUDE.md']) fs.renameSync(path.join(dir, rel), path.join(dir, `${rel}.saved`));
  git(['checkout-index', '--force', '--', 'AGENTS.md', 'CLAUDE.md']);
  for (const rel of ['AGENTS.md', 'CLAUDE.md']) assert.ok(!fs.readFileSync(path.join(dir, rel)).includes(B('\r\n')), `${rel}: real checkout must use LF`);
}

const setupSource = () => fs.readFileSync(path.join(__dirname, '../.ai/bin/protocol-setup.cjs'), 'utf8');

test('explicit staff hostRole survives full kernel update; dropping its preservation is killed', t => {
  const original = setupSource();
  instructionAttributes(t, original, 'blank', 'staff');
  const from = 'if (role.set) installed.hostRole = role.value;';
  assert.equal(original.split(from).length, 2);
  assert.throws(() => instructionAttributes(t, original.replace(from, ''), 'blank', 'staff'), { code: 'ERR_ASSERTION' });
});
test('managed instruction attributes survive real autocrlf checkout and update with byte-stable repeats', t => {
  for (const kind of ['blank', 'crlf', 'lf']) instructionAttributes(t, setupSource(), kind);
});

test('host CRLF warning names both files, preserves bytes and gives an executable normalisation command', t => {
  const plans = ['AGENTS.md', 'CLAUDE.md'].map(rel => ki.planInstruction(host(t, { [rel]: '# Own\r\n' }), rel, BLOCK));
  const warnings = ki.instructionWarnings(plans);
  assert.deepEqual(warnings.map(w => w.rel), ['AGENTS.md', 'CLAUDE.md']);
  for (const [i, w] of warnings.entries()) {
    assert.match(w.message, /HOST_CRLF/);
    assert.ok(w.message.includes(w.rel));
    assert.match(w.message, /node -e/);
    assert.equal(ki.hostBytes(plans[i].rel, plans[i].bytes).toString(), '# Own\r\n');
    const dir = host(t, { [w.rel]: plans[i].bytes });
    const command = w.message.match(/node -e "([^"]+)"/)[1];
    const r = require('node:child_process').spawnSync(process.execPath, ['-e', command], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 10000 });
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.readFileSync(path.join(dir, w.rel)).includes(B('\r\n')), false);
  }
  const lf = ki.planInstruction(host(t, { 'AGENTS.md': '# Own\n' }), 'AGENTS.md', BLOCK);
  assert.deepEqual(ki.instructionWarnings([lf]), []);
});

test('instruction attribute mutants are killed by the managed-block checkout and repeat test', t => {
  const original = setupSource();
  const mutants = [
    ['instruction rules removed', "'.ai/**', 'AGENTS.md', 'CLAUDE.md'", "'.ai/**'"],
    ['instruction rules outside block', "const block = begin + '\\n' + scopedContent.trimEnd() + '\\n' + end + '\\n';", "const block = begin + '\\n' + scopedContent.replace(/^AGENTS\\.md text eol=lf\\n|^CLAUDE\\.md text eol=lf$/gm, '').trimEnd() + '\\n' + end + '\\n' + (relative === '.gitattributes' ? 'AGENTS.md text eol=lf\\nCLAUDE.md text eol=lf\\n' : '');"],
    ['repeat not byte-stable', "if (merged === existing) return", "merged += '# extra\\n'; if (merged === existing) return"],
  ];
  for (const [name, from, to] of mutants) {
    assert.ok(original.includes(from), `mutation anchor: ${name}`);
    const changed = original.replace(from, to);
    assert.throws(() => instructionAttributes(t, changed), { code: 'ERR_ASSERTION' }, name);
  }
});

// The role of a computer: --host-role owner|staff and --confirm-host-role-change. The fixtures are a small stand-in for a built product
// (the two installers and the libraries they load, the block texts, a source manifest); no product is built here.
const hooks = require('../.ai/bin/protocol-hooks.cjs');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const REPO = path.resolve(__dirname, '..');
const SETUP_FILE = '.ai/bin/protocol-setup.cjs';
const KI_FILE = 'docs/ops/kernel-install.cjs';
const INTEGRATION = ['.gitignore', '.gitattributes', '.claude/settings.json', '.codex/hooks.json'];
const put = (dir, rel, bytes) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), bytes); };
// A change that must find its anchor exactly once, so a mutant that no longer applies fails loudly.
const mutate = (from, to) => text => { assert.equal(text.split(from).length, 2, `mutation anchor: ${from}`); return text.replace(from, () => to); };
function miniProduct(t, change = {}) {
  const dir = host(t, {});
  for (const rel of [KI_FILE, SETUP_FILE, '.ai/bin/lib/test-command.cjs', '.ai/bin/lib/text-safe.cjs', '.ai/bin/lib/protocol-version.cjs', '.ai/bin/lib/path-safe.cjs', '.ai/bin/lib/real-path.cjs', '.ai/bin/lib/read-handle.cjs', '.ai/bin/lib/read-handle.cs', ...INTEGRATION]) {
    const text = fs.readFileSync(path.join(REPO, rel), 'utf8');
    put(dir, rel, change[rel] ? change[rel](text) : text);
  }
  for (const rel of Object.values(ki.BLOCKS)) put(dir, rel, BLOCK);
  put(dir, 'protocol-manifest.json', JSON.stringify({ protocolVersion: '2.0.3', role: 'source', managed: [], integration: INTEGRATION, state: [] }));
  const load = rel => createRequire(path.join(dir, rel))(path.join(dir, rel));
  return { dir, setup: load(SETUP_FILE), ki: load(KI_FILE) };
}
function gitIn(dir, args) {
  const r = spawnSync('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.autocrlf=false', ...args], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  assert.equal(r.status, 0, r.stderr || String(r.error));
}
const commitAll = dir => { gitIn(dir, ['add', '.']); gitIn(dir, ['commit', '-qm', 'Seed', '--allow-empty']); };
// A host project in a git repository with a clean tree; `manifest` is the protocol-manifest.json it already holds, if any.
function hostRepo(t, manifest) {
  const files = { 'README.md': '# Host\n', '.ai/TASK.md': '# Task\n' };
  if (manifest !== undefined) files['protocol-manifest.json'] = `${JSON.stringify(manifest, null, 2)}\n`;
  const dir = host(t, files);
  gitIn(dir, ['init', '-b', 'main']);
  commitAll(dir);
  return dir;
}
function tree(dir) {
  const out = {};
  const walk = rel => {
    for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      if (rel === '' && e.name === '.git') continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r); else out[r] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, r))).digest('hex');
    }
  };
  walk('');
  return out;
}
function captured(fn) {
  const lines = [];
  const was = console.log;
  console.log = (...a) => lines.push(a.join(' '));
  try { return { result: fn(), lines }; } finally { console.log = was; }
}
const manifestOf = dir => JSON.parse(fs.readFileSync(path.join(dir, 'protocol-manifest.json'), 'utf8'));
const manifestBytes = dir => fs.readFileSync(path.join(dir, 'protocol-manifest.json'));
function roleCtx(t, change) {
  const p = miniProduct(t, change);
  const run = (dir, ...args) => captured(() => p.setup.runSetup(['--Target', dir, ...args]));
  const refused = (dir, args, reason) => {
    const before = tree(dir);
    assert.throws(() => run(dir, ...args), e => e.message.startsWith(`REFUSED reason=${reason}`), `${reason}: ${args.join(' ')}`);
    assert.deepEqual(tree(dir), before, `${reason}: nothing was written (${args.join(' ')})`);
  };
  return { ...p, run, refused };
}
const INSTALLED = { role: 'installed', managed: [], integration: [], state: [] };
const withRole = hostRole => ({ ...INSTALLED, hostRole });
const NO_ROLE = { set: false, value: undefined, source: 'none' };
const kept = value => ({ set: true, value, source: 'kept' });
const flag = value => ({ set: true, value, source: 'flag' });
// [the installed manifest of the target (null: a first install), --host-role, the confirmation flag, the decision or the refusal reason]
const DECISIONS = [
  [null, undefined, false, NO_ROLE],
  [INSTALLED, undefined, false, NO_ROLE],
  [withRole('staff'), undefined, false, kept('staff')],
  [withRole('owner'), undefined, false, kept('owner')],
  [withRole('STAFF'), undefined, false, kept('STAFF')],
  [null, 'staff', false, flag('staff')],
  [null, 'owner', false, flag('owner')],
  [withRole('staff'), 'staff', false, flag('staff')],
  [withRole('owner'), 'owner', false, flag('owner')],
  [INSTALLED, 'owner', false, flag('owner')],
  [withRole('staff'), 'owner', false, 'host-role-change'],
  [withRole('owner'), 'staff', false, 'host-role-change'],
  [INSTALLED, 'staff', false, 'host-role-change'],
  [withRole('STAFF'), 'staff', false, 'host-role-change'],
  [withRole('staff'), 'owner', true, flag('owner')],
  [withRole('owner'), 'staff', true, flag('staff')],
  [INSTALLED, 'staff', true, flag('staff')],
  [withRole('STAFF'), 'staff', true, flag('staff')],
  [withRole('staff'), 'staff', true, flag('staff')],
  [null, 'STAFF', false, 'host-role-unknown'],
  [null, 'manager', false, 'host-role-unknown'],
  [null, '', false, 'host-role-unknown'],
  [withRole('staff'), 'owner ', true, 'host-role-unknown'],
  [withRole('staff'), 'Staff', true, 'host-role-unknown'],
  [null, undefined, true, 'host-role-confirm-alone'],
  [withRole('staff'), undefined, true, 'host-role-confirm-alone'],
];

// Each rule is one assertion group on its own small fixture, so a mutant of the installers runs only the groups that must kill it.
const ROLE_RULES = {
  decide(t, c) {
    for (const [current, requested, confirmed, expected] of DECISIONS) {
      const label = `${JSON.stringify(current)} ${requested} ${confirmed}`;
      if (typeof expected === 'string') assert.throws(() => c.setup.decideHostRole(current, requested, confirmed), e => e.message.startsWith(`REFUSED reason=${expected}`), label);
      else assert.deepEqual(c.setup.decideHostRole(current, requested, confirmed), expected, label);
    }
  },
  written(t, c) {
    const staff = hostRepo(t);
    assert.equal(c.run(staff, '--host-role', 'staff').result, 0);
    assert.equal(manifestOf(staff).hostRole, 'staff', 'a first install with --host-role staff writes staff');
    const owner = hostRepo(t);
    assert.equal(c.run(owner, '--host-role=owner').result, 0);
    assert.equal(manifestOf(owner).hostRole, 'owner', 'a first install with --host-role owner writes owner');
    const none = hostRepo(t);
    c.run(none);
    assert.equal(Object.hasOwn(manifestOf(none), 'hostRole'), false, 'without the flag no role is invented');
  },
  kept(t, c) {
    const dir = hostRepo(t, withRole('staff'));
    c.run(dir, '--Force');
    const before = manifestBytes(dir);
    assert.equal(manifestOf(dir).hostRole, 'staff', 'an update without the flag keeps the role');
    c.run(dir, '--host-role', 'staff');
    assert.deepEqual(manifestBytes(dir), before, 'the same role needs no confirmation and changes no byte');
    c.run(dir, '--host-role=staff', '--confirm-host-role-change');
    assert.deepEqual(manifestBytes(dir), before, 'the same role with the confirmation changes no byte');
  },
  refusedWritesNothing(t, c) {
    c.refused(hostRepo(t, withRole('staff')), ['--Force', '--host-role', 'owner'], 'host-role-change');
    c.refused(hostRepo(t), ['--host-role', 'manager'], 'host-role-unknown');
    c.refused(hostRepo(t), ['--confirm-host-role-change'], 'host-role-confirm-alone');
  },
  changeWrites(t, c) {
    const dir = hostRepo(t, withRole('staff'));
    c.run(dir, '--Force', '--host-role', 'owner', '--confirm-host-role-change');
    assert.equal(manifestOf(dir).hostRole, 'owner', 'staff to owner with the confirmation');
    c.run(dir, '--Force');
    assert.equal(manifestOf(dir).hostRole, 'owner', 'the changed role is then kept');
  },
  parse(t, c) {
    assert.throws(() => c.setup.runSetup(['--Target', c.dir, '--host-role']), /--host-role requires owner or staff/);
    assert.throws(() => c.setup.runSetup(['--Target', c.dir, '--host-role', 'staff', '--host-role', 'owner']), /specified twice/);
    assert.throws(() => c.setup.runSetup(['--host-role', 'staff']), /REFUSED reason=host-role-no-target/);
    assert.throws(() => c.setup.runSetup(['--Target', c.dir, '--host-role', 'staff']), /REFUSED reason=host-role-no-target/, 'the product itself is not a target');
  },
  check(t, c) {
    const dir = hostRepo(t, withRole('staff'));
    c.run(dir, '--Force');
    const synced = tree(dir);
    let v = c.run(dir, '--Verify', '--host-role', 'staff');
    assert.ok(v.lines.includes('Host role: "staff" (set by --host-role)'), v.lines.join('\n'));
    v = c.run(dir, '--Verify');
    assert.ok(v.lines.includes('Host role: "staff" (kept from the target)'), v.lines.join('\n'));
    v = c.run(hostRepo(t), '--Verify');
    assert.ok(v.lines.includes('Host role: none declared (owner mode) (not requested)'), v.lines.join('\n'));
    c.refused(dir, ['--Verify', '--host-role', 'owner'], 'host-role-change');
    assert.deepEqual(tree(dir), synced, 'the check mode writes nothing');
  },
  kiParse(t, c) {
    assert.deepEqual(c.ki.parseArgs(['--target', 'x']), { target: 'x', update: false, dryRun: false, profile: undefined }, 'without the flags the options are what they were');
    assert.equal(c.ki.parseArgs(['--target', 'x', '--host-role', 'staff']).hostRole, 'staff');
    assert.equal(c.ki.parseArgs(['--target', 'x', '--host-role=owner', '--confirm-host-role-change']).confirmHostRoleChange, true);
    for (const bad of [['--host-role', 'manager'], ['--host-role=STAFF'], ['--host-role', '--update'], ['--host-role=staff', '--host-role', 'owner'], ['--confirm-host-role-change']]) {
      assert.throws(() => c.ki.parseArgs(['--target', 'x', ...bad]), /--host-role|--confirm-host-role-change/, bad.join(' '));
    }
    assert.match(fs.readFileSync(path.join(c.dir, KI_FILE), 'utf8').split('\n').find(l => l.includes("throw new Error('usage:")), /--host-role owner\|staff \[--confirm-host-role-change\]/, 'the usage text names the flags');
    assert.equal(c.ki.installedManifest(host(t, {})), null, 'no manifest: a first install');
    assert.equal(c.ki.installedManifest(host(t, { 'protocol-manifest.json': '{"role":"source"}' })), null, 'a source manifest is no earlier install');
    assert.deepEqual(c.ki.installedManifest(host(t, { 'protocol-manifest.json': '{"role":"installed","hostRole":"staff"}' })), { role: 'installed', hostRole: 'staff' });
  },
  kiRefusal(t, c) {
    const dir = hostRepo(t, withRole('staff'));
    const before = tree(dir);
    for (const args of [['--host-role', 'owner'], ['--host-role', 'owner', '--update'], ['--host-role', 'owner', '--dry-run']]) {
      const lines = [];
      assert.equal(c.ki.main(['--target', dir, ...args], s => lines.push(s)), 2, args.join(' '));
      assert.ok(lines.some(l => l.startsWith('REFUSED R12:') && l.includes('host-role-change') && l.includes('--confirm-host-role-change')), lines.join('\n'));
    }
    assert.deepEqual(tree(dir), before, 'a refused role change writes nothing');
    const lines = [];
    assert.equal(c.ki.main(['--target', dir, '--host-role', 'owner', '--confirm-host-role-change', '--dry-run'], s => lines.push(s)), 0, lines.join('\n'));
  },
  kiDry(t, c) {
    const dir = hostRepo(t);
    c.run(dir);
    commitAll(dir);
    const before = tree(dir);
    const lines = [];
    assert.equal(c.ki.main(['--target', dir, '--host-role', 'staff', '--confirm-host-role-change', '--dry-run'], s => lines.push(s)), 0, lines.join('\n'));
    assert.ok(lines.includes('kernel-install: host role "staff" (set by --host-role)'), lines.join('\n'));
    assert.ok(lines.some(l => /\[!=\] Manifest needs updating/.test(l)), `the dry run shows the role as a manifest difference:\n${lines.join('\n')}`);
    assert.deepEqual(tree(dir), before, 'the dry run writes nothing');
  },
  kiInstall(t, c) {
    const dir = hostRepo(t);
    const lines = [];
    // the stand-in has no validator, so the checks after the writes report a failure; the writes themselves are what is asserted
    c.ki.main(['--target', dir, '--host-role', 'staff'], s => lines.push(s));
    assert.ok(lines.includes('kernel-install: host role "staff" (set by --host-role)'), lines.join('\n'));
    assert.equal(manifestOf(dir).hostRole, 'staff', 'the one install command writes the role into the manifest of the project');
    assert.equal(hooks.hostRole(dir), 'staff');
    const started = hooks.run('SessionStart', { cwd: dir }, 'claude');
    assert.equal(started.hookSpecificOutput.additionalContext, hooks.STAFF_CONTEXT, 'the session hook of the project runs in staff mode');
    assert.deepEqual(hooks.run('Stop', { cwd: dir }, 'claude'), {});
    assert.deepEqual(fs.readdirSync(path.join(dir, '.ai')), ['TASK.md'], 'staff mode writes no journal, lock, runtime or evidence file');
  },
};

test('--host-role: written on a first install, kept without the flag, a change needs the confirmation, unknown values are refused first', t => {
  for (const [name, rule] of Object.entries(ROLE_RULES)) {
    const c = roleCtx(t);
    assert.doesNotThrow(() => rule(t, c), name);
  }
});

test('the test-command setter applies the role rule before writing either field', t => {
  const c = roleCtx(t);
  for (const [current, requested, confirmed, expected] of DECISIONS.filter(row => row[0])) {
    const dir = hostRepo(t, { ...current, testCommand: 'old' });
    const args = ['--set-test-command', 'none', ...(requested === undefined ? [] : ['--host-role', requested]), ...(confirmed ? ['--confirm-host-role-change'] : [])];
    if (typeof expected === 'string') c.refused(dir, args, expected);
    else {
      assert.equal(c.run(dir, ...args).result, 0);
      const result = manifestOf(dir);
      assert.equal(result.testCommand, 'none');
      assert.equal(result.hostRole, expected.value);
      const otherFields = value => Object.fromEntries(Object.entries(value).filter(([k]) => !['hostRole', 'testCommand'].includes(k)));
      assert.deepEqual(otherFields(result), otherFields(current));
    }
  }
  for (const args of [[], ['--Target', c.dir]]) {
    assert.throws(() => c.setup.runSetup([...args, '--set-test-command', 'none', '--host-role', 'staff']), /host-role-no-target/);
  }
  const dir = hostRepo(t, { ...withRole('staff'), testCommand: 'old' });
  const before = tree(dir);
  c.run(dir, '--set-test-command', 'none', '--Verify', '--host-role', 'owner', '--confirm-host-role-change');
  assert.deepEqual(tree(dir), before, 'verification writes neither field');
  assert.throws(() => c.run(dir, '--set-test-command', 'auto', '--host-role', 'owner', '--confirm-host-role-change'), /auto/);
  assert.deepEqual(tree(dir), before, 'a refused test command cannot change the role');
});

test('every installer entry refuses ambiguous manifest bytes and keys before any write, as hooks do', t => {
  const c = roleCtx(t);
  const valid = JSON.stringify(withRole('staff')) + '\n';
  const bad = [
    [Buffer.concat([BOM, B(valid)]), /BOM/],
    [B('{"role":"installed","hostRole":"staff","hostRole":"owner"}\n'), /JSON_DUPLICATE_KEY/],
    [B('{"role":"installed","hostRole":"staff","host\\u0052ole":"owner"}\n'), /JSON_DUPLICATE_KEY/],
    [B('{"role":"installed",'), /JSON_SYNTAX/],
    [Buffer.from([0xc3, 0x28]), /UTF8/],
    [B('[]\n'), /JSON_OBJECT_REQUIRED/],
  ];
  for (const [bytes, reason] of bad) {
    const dir = hostRepo(t);
    put(dir, 'protocol-manifest.json', bytes);
    commitAll(dir);
    const before = tree(dir);
    assert.throws(() => hooks.hostRole(dir), /HOST_ROLE_UNKNOWN/);
    for (const flags of [[], ['--host-role', 'owner']]) {
      for (const extra of [[], ['--Force'], ['--Verify'], ['--set-test-command', 'none'], ['--test-command', 'none']]) {
        assert.throws(() => c.run(dir, ...extra, ...flags), reason);
        assert.deepEqual(tree(dir), before);
      }
      for (const extra of [[], ['--update'], ['--dry-run']]) {
        const lines = [];
        assert.equal(c.ki.main(['--target', dir, ...extra, ...flags], s => lines.push(s)), 2);
        assert.match(lines.join('\n'), reason);
        assert.deepEqual(tree(dir), before);
      }
    }
  }
  const dir = hostRepo(t);
  put(dir, 'protocol-manifest.json', valid.replace(/\n/g, '\r\n'));
  assert.equal(hooks.hostRole(dir), 'staff');
  assert.equal(c.setup.parseHostManifest(manifestBytes(dir)).hostRole, 'staff');
  assert.equal(c.ki.installedManifest(dir).hostRole, 'staff');
  c.refused(dir, ['--host-role', 'owner'], 'host-role-change');
});

test('both installers accept only lower-case double-dash role flags and name unknown spellings', t => {
  const c = roleCtx(t);
  const dir = hostRepo(t, withRole('staff'));
  const before = tree(dir);
  for (const arg of ['-host-role=owner', '--HOST-ROLE=owner', '--Host-Role=owner', '-confirm-host-role-change', '--CONFIRM-HOST-ROLE-CHANGE', '--confirm-host-role-change=true']) {
    assert.throws(() => c.run(dir, arg), e => /Unknown argument/.test(e.message) && e.message.includes(arg));
    const lines = [];
    assert.equal(c.ki.main(['--target', dir, arg], s => lines.push(s)), 2);
    assert.ok(lines.some(s => s.includes(arg)), arg);
    assert.deepEqual(tree(dir), before);
  }
});

test('every assertion group of the role flag has a mutant of the installers that it kills', t => {
  const S = SETUP_FILE;
  const K = KI_FILE;
  const change = 'if (existing !== requested && !confirmed) {';
  const mutants = [
    ['setup writes owner for staff', S, 'if (role.set) installed.hostRole = role.value;', "if (role.set) installed.hostRole = 'owner';", 'written'],
    ['setup drops the role', S, 'if (role.set) installed.hostRole = role.value;', '', 'written'],
    ['setup invents a role', S, "{ set: false, value: undefined, source: 'none' }", "{ set: true, value: 'owner', source: 'none' }", 'decide'],
    ['setup drops a kept role', S, "declared ? { set: true, value: current.hostRole, source: 'kept' }", "declared ? { set: false, value: undefined, source: 'kept' }", 'kept'],
    ['setup drops a kept role', S, "declared ? { set: true, value: current.hostRole, source: 'kept' }", "declared ? { set: false, value: undefined, source: 'kept' }", 'decide'],
    ['setup refuses the same role', S, change, 'if (!confirmed) {', 'decide'],
    ['setup refuses the same role', S, change, 'if (!confirmed) {', 'kept'],
    ['setup allows a change', S, change, 'if (false) {', 'decide'],
    ['setup allows a change', S, change, 'if (false) {', 'refusedWritesNothing'],
    ['setup treats no role as the requested one', S, "const existing = declared ? current.hostRole : 'owner';", 'const existing = declared ? current.hostRole : requested;', 'decide'],
    ['setup ignores the confirmation', S, change, 'if (existing !== requested) {', 'decide'],
    ['setup ignores the confirmation', S, change, 'if (existing !== requested) {', 'changeWrites'],
    ['setup accepts an unknown value', S, 'if (!HOST_ROLES.includes(requested)) throw', 'if (false) throw', 'decide'],
    ['setup accepts an unknown value', S, 'if (!HOST_ROLES.includes(requested)) throw', 'if (false) throw', 'refusedWritesNothing'],
    ['setup accepts the confirmation alone', S, "if (confirmed) throw refuse('host-role-confirm-alone'", "if (false) throw refuse('host-role-confirm-alone'", 'decide'],
    ['setup accepts the confirmation alone', S, "if (confirmed) throw refuse('host-role-confirm-alone'", "if (false) throw refuse('host-role-confirm-alone'", 'refusedWritesNothing'],
    ['setup accepts a second --host-role', S, "if (hostRole !== undefined) throw new Error('Option --host-role was specified twice.');", '', 'parse'],
    ['setup invents a missing value', S, "throw new Error('Option --host-role requires owner or staff.');", "hostRole = 'staff';", 'parse'],
    ['setup accepts the flag without a target', S, '(SelfInstall || !parsed.target)', 'false', 'parse'],
    ['setup does not report the role', S, 'console.log(`Host role: ${describeHostRole(role)}`);', '', 'check'],
    ['installer accepts an unknown value', K, "if (!setupApi.HOST_ROLES.includes(value)) throw new Error('--host-role needs owner or staff');", '', 'kiParse'],
    ['installer accepts a second --host-role', K, "if (roleSeen) throw new Error('--host-role was specified twice');", '', 'kiParse'],
    ['installer accepts the confirmation alone', K, 'if (o.confirmHostRoleChange && o.hostRole === undefined) throw new Error(', 'if (false) throw new Error(', 'kiParse'],
    ['installer reads no earlier manifest', K, "return m && m.role === 'installed' ? m : null;", 'return null;', 'kiParse'],
    ['installer lets a change through', K, 'setupApi.decideHostRole(installedManifest(target), o.hostRole, o.confirmHostRoleChange === true)', 'setupApi.decideHostRole(null, o.hostRole, true)', 'kiRefusal'],
    ['installer names no refusal', K, "throw new Refusal('R12', e.message);", "throw new Refusal('R1', e.message);", 'kiRefusal'],
    ['installer does not forward the role to the install', K, "...(o.update ? ['--Force'] : []), ...roleArgs]);", "...(o.update ? ['--Force'] : [])]);", 'kiInstall'],
    ['installer does not forward the role to the dry run', K, "'--Verify', ...roleArgs]", "'--Verify']", 'kiDry'],
    ['installer does not report the role', K, 'log(`kernel-install: host role ${setupApi.describeHostRole(role)}`);', '', 'kiDry'],
  ];
  assert.deepEqual(Object.keys(ROLE_RULES).filter(rule => !mutants.some(m => m[4] === rule)), [], 'a rule without a mutant');
  for (const [name, file, from, to, rule] of mutants) {
    const c = roleCtx(t, { [file]: mutate(from, to) });
    assert.throws(() => ROLE_RULES[rule](t, c), Error, `${name} survives ${rule}`);
  }
});

// The live candidate registry of a host: a heading an earlier skeleton wrote is migrated line for line, the rows untouched; any
// other registry the grammar refuses stops the install before a write, with the fix.
const ROW = '| hpf-stream | ops-hpf | 0123456789abcdef0123456789abcdef01234567 | host-owner | ready | 2026-11-19 | n |';
const TABLE = `| stream | branch | sha | owner | status | updated | note |\n|---|---|---|---|---|---|---|\n${ROW}\n`;
const LEGACY = `# Реестр кандидатов проекта (пустой каркас pilot-install)\n\nЖивой реестр проекта.\n\n${TABLE}`;
test('an upgrade migrates the registry heading an earlier skeleton wrote; the rows and every other line stay byte for byte', t => {
  const dir = host(t, { [ki.REGISTRY_REL]: B(LEGACY) });
  const plan = ki.registryPlan(dir);
  assert.equal(plan.action, 'migrated');
  assert.equal(plan.line, 1);
  assert.deepEqual(plan.bytes, B(LEGACY.replace('# Реестр кандидатов проекта (пустой каркас pilot-install)', '# Operator candidates')));
  const { parseRegistry } = require('../.ai/bin/lib/candidate-registry.cjs');
  assert.deepEqual(parseRegistry(plan.bytes).rows.map(r => r.cells), [ROW.split('|').slice(1, -1).map(c => c.trim())]);
  assert.deepEqual(fs.readFileSync(path.join(dir, ki.REGISTRY_REL)), B(LEGACY), 'planning writes nothing');
});
test('a registry that passes the grammar, and an absent one, are left as they are', t => {
  assert.equal(ki.registryPlan(host(t, { [ki.REGISTRY_REL]: B(`# Operator candidates\n\n${TABLE}`) })).action, 'valid');
  assert.equal(ki.registryPlan(host(t, { 'README.md': B('x\n') })).action, 'absent');
});
test('a registry the grammar refuses without a recognised heading, or still refuses after the migration, stops the install by name with the fix', t => {
  for (const text of [`# Реестр\n\n${TABLE}`, LEGACY.replace(ROW, ROW.replace('ready', 'unknown-status')), `${LEGACY}# Реестр кандидатов проекта (пустой каркас pilot-install)\n`]) {
    const dir = host(t, { [ki.REGISTRY_REL]: B(text) });
    assert.throws(() => ki.registryPlan(dir), e => e.id === 'R13' && /does not pass the registry grammar/.test(e.message) && /fix: the registry needs exactly one heading line "# Operator candidates"/.test(e.message));
    assert.deepEqual(fs.readFileSync(path.join(dir, ki.REGISTRY_REL)), B(text));
  }
});
// A late concurrent write: another registry writer adds a row after the check and before the replace. The writer is a child process
// that migrates the heading and appends its row inside the registry transaction, as cand-add, refresh-sha and the launch claim write;
// it starts at the moment of the replace, and the replace waits until the row is in the file or the child has stood at the lock a while.
const LATE = `| late-stream | ops-late | ${'f'.repeat(40)} | host-owner | ready | 2026-11-19 | late |`;
const LATE_WRITER = `const fs = require('node:fs'), path = require('node:path');
const [file, marker, row, guard, registry, paths] = process.argv.slice(1);
const g = require(guard), r = require(registry), p = require(paths);
fs.writeFileSync(marker, 'started');
g.withRegistryTransaction(file, () => {
  const now = fs.readFileSync(file), m = r.migrateHeading(now);
  const w = p.writeAtomicGuarded(file, Buffer.from((m.action === 'migrated' ? m.bytes : now).toString('utf8') + row + '\\n'), { root: path.dirname(file) });
  if (!w.ok) process.exit(3);
});`;
function lateWrite(t, mod) {
  const dir = host(t, { [ki.REGISTRY_REL]: B(LEGACY) });
  const file = path.join(dir, ki.REGISTRY_REL), marker = path.join(dir, 'late-writer-started');
  const plan = mod.registryPlan(dir);
  assert.equal(plan.action, 'migrated');
  const pathSafe = require('../.ai/bin/lib/path-safe.cjs');
  const real = pathSafe.writeAtomicGuarded;
  const sleep = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  let child = null, said = '';
  pathSafe.writeAtomicGuarded = (target, bytes, options) => {
    if (child === null && path.resolve(target) === path.resolve(file)) {
      const modules = ['../docs/ops/ops-guard.cjs', '../.ai/bin/lib/candidate-registry.cjs', '../.ai/bin/lib/path-safe.cjs'].map(rel => path.join(__dirname, rel));
      // the error output of the writer is kept: an exit code alone does not say why the writer failed
      child = require('node:child_process').spawn(process.execPath, ['-e', LATE_WRITER, file, marker, LATE, ...modules], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
      child.stderr.on('data', d => { said += d; });
      const until = Date.now() + 20000;
      let started = null;
      while (Date.now() < until && !fs.readFileSync(file, 'utf8').includes(LATE)) {
        if (started === null && fs.existsSync(marker)) started = Date.now();
        if (started !== null && Date.now() - started > 1500) break;
        sleep(25);
      }
    }
    return real(target, bytes, options);
  };
  let failed;
  try { failed = mod.writeRegistry(plan); } finally { pathSafe.writeAtomicGuarded = real; }
  assert.notEqual(child, null, 'the replace of the registry was reached');
  return { failed, file, exited: new Promise(resolve => child.on('close', code => resolve(code))), said: () => said };
}
// The module compiled from changed source at its own path, so its relative requires and the shared module cache stay as they are.
function compiledAs(file, source) {
  const Module = require('node:module');
  const m = new Module(file, module);
  m.filename = file; m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(source, file);
  return m.exports;
}
test('a row another registry writer adds after the check and before the replace of the migration is kept; without the transaction it is lost', async t => {
  const { parseRegistry } = require('../.ai/bin/lib/candidate-registry.cjs');
  const kept = lateWrite(t, ki);
  assert.equal(kept.failed, null);
  assert.equal(await kept.exited, 0, `the late writer wrote its row: ${kept.said()}`);
  const text = fs.readFileSync(kept.file, 'utf8');
  assert.ok(text.startsWith('# Operator candidates\n'), text);
  assert.deepEqual(parseRegistry(text).rows.map(r => r.cells[0]), ['hpf-stream', 'late-stream']);
  const file = path.join(REPO, KI_FILE);
  const unguarded = compiledAs(file, mutate("require('./ops-guard.cjs').withRegistryTransaction(file, () => withRegistryLock(file, () => {", '((at, action) => action())(file, () => withRegistryLock(file, () => {')(fs.readFileSync(file, 'utf8')));
  const lost = lateWrite(t, unguarded);
  assert.equal(lost.failed, null);
  assert.equal(await lost.exited, 0, lost.said());
  assert.equal(fs.readFileSync(lost.file, 'utf8').includes('late-stream'), false, 'the test reproduces the lost row when the migration takes no transaction');
});
// A writer that holds the registry lock (and no transaction) read the table before the migration and replaces it after: the migration
// waits for the lock and then finds the bytes changed, so neither write is lost. Without the lock the migration writes at once and the
// other writer's replace drops the migrated heading.
const LOCK_WRITER = `const fs = require('node:fs');
const [file, marker, row, registry] = process.argv.slice(1);
require(registry).withRegistryLock(file, () => {
  const before = fs.readFileSync(file);
  fs.writeFileSync(marker, 'locked');
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1500);
  fs.writeFileSync(file, Buffer.concat([before, Buffer.from(row + '\\n', 'utf8')]));
});`;
async function lockedWrite(t, mod) {
  const dir = host(t, { [ki.REGISTRY_REL]: B(LEGACY) });
  const file = path.join(dir, ki.REGISTRY_REL), marker = path.join(dir, 'lock-writer-started');
  const plan = mod.registryPlan(dir);
  assert.equal(plan.action, 'migrated');
  const child = require('node:child_process').spawn(process.execPath, ['-e', LOCK_WRITER, file, marker, LATE, path.join(REPO, '.ai/bin/lib/candidate-registry.cjs')], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  let said = '';
  child.stderr.on('data', d => { said += d; });
  const exited = new Promise(resolve => child.on('close', code => resolve(code)));
  const until = Date.now() + 20000;
  while (Date.now() < until && !fs.existsSync(marker)) await new Promise(resolve => setTimeout(resolve, 25));
  assert.ok(fs.existsSync(marker), 'the other writer holds the registry lock');
  const failed = mod.writeRegistry(plan);
  assert.equal(await exited, 0, `the other writer wrote its row: ${said}`);
  return { failed, text: fs.readFileSync(file, 'utf8') };
}
test('the migration waits for a writer that holds the registry lock and keeps its row; without the lock the migrated heading is lost', async t => {
  const kept = await lockedWrite(t, ki);
  assert.match(kept.failed, /changed since the check; nothing was written to it/);
  assert.ok(kept.text.includes(LATE), kept.text);
  const file = path.join(REPO, KI_FILE);
  const unlocked = compiledAs(file, mutate('withRegistryTransaction(file, () => withRegistryLock(file, () => {', 'withRegistryTransaction(file, () => ((at, action) => action())(file, () => {')(fs.readFileSync(file, 'utf8')));
  const lost = await lockedWrite(t, unlocked);
  assert.equal(lost.failed, null, 'the unlocked migration wrote at once');
  assert.equal(lost.text.startsWith('# Operator candidates\n'), false, 'the test reproduces the lost heading when the migration takes no lock');
});
test('a row written between the check and the migration transaction stops the migration and stays', t => {
  const dir = host(t, { [ki.REGISTRY_REL]: B(LEGACY) });
  const plan = ki.registryPlan(dir);
  const changed = B(`${LEGACY.replace('# Реестр кандидатов проекта (пустой каркас pilot-install)', '# Operator candidates')}${LATE}\n`);
  fs.writeFileSync(path.join(dir, ki.REGISTRY_REL), changed);
  assert.match(ki.writeRegistry(plan), /changed since the check; nothing was written to it/);
  assert.deepEqual(fs.readFileSync(path.join(dir, ki.REGISTRY_REL)), changed);
});

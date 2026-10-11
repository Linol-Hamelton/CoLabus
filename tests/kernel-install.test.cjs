'use strict';
// docs/ops/kernel-install.cjs: where the kernel block goes in a host's AGENTS.md and CLAUDE.md (owner ). The host owns
// those files; the kernel owns one marker block. These tests need no product build and run in the development tree and in the product.
// The full install into fixture hosts runs in  (development) and in the audit gate f of the product build.
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

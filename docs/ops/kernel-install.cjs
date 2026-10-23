#!/usr/bin/env node
'use strict';
// kernel-install: install (or update) the CoLabus kernel into a HOST project from the PRODUCT repository.
//   node docs/ops/kernel-install.cjs --target <project> [--update] [--dry-run]
// What it does, in order: refuse anything unsafe before the first write; run the base installer of this checkout
// (.ai/bin/protocol-setup.cjs --Target <project>, with --Force on --update); then write the kernel block into the project's
// AGENTS.md and CLAUDE.md; then run the project's validator and the layer lint and print the result.
// The host owns AGENTS.md and CLAUDE.md. The kernel owns exactly one marker block in each:
//   <!-- colabs-kernel:start --> ... <!-- colabs-kernel:end -->
// A file that is absent is created with the block alone; a file that holds the block gets the block replaced in place; a file
// without the block gets the block in front of its original bytes (after a byte order mark, when it has one). Every host byte
// outside the block stays as it was: byte order mark, CRLF or LF, a last line without a newline. One exception: a file whose
// bytes equal the digest the project's installed protocol-manifest.json recorded for it is a kernel copy from an earlier install
// (when AGENTS.md was a managed file), so it is replaced by the block. The block texts come from docs/product/host-block/ of
// this checkout, which only a product build writes; a development checkout is refused.
// It never commits or pushes. The shared atomic writer may clean up its own temporary file.
// Exit 0 done, 1 install or checks failed, 2 refused or bad usage.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const textSafe = require('../../.ai/bin/lib/text-safe.cjs');
const pathSafe = require('../../.ai/bin/lib/path-safe.cjs');

const SOURCE = path.resolve(__dirname, '..', '..');
const SETUP = path.join(SOURCE, '.ai', 'bin', 'protocol-setup.cjs');
const BLOCKS = { 'AGENTS.md': 'docs/product/host-block/AGENTS.block.md', 'CLAUDE.md': 'docs/product/host-block/CLAUDE.block.md' };
const START = '<!-- colabs-kernel:start -->';
const END = '<!-- colabs-kernel:end -->';

class Refusal extends Error { constructor(id, message) { super(message); this.id = id; } }

function parseArgs(argv) {
  const o = { target: '', update: false, dryRun: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') { if (i + 1 >= argv.length) throw new Error('--target needs a path'); o.target = argv[++i]; }
    else if (a.startsWith('--target=')) o.target = a.slice(9);
    else if (a === '--update') o.update = true;
    else if (a === '--dry-run') o.dryRun = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  if (!o.target) throw new Error('usage: node docs/ops/kernel-install.cjs --target <project> [--update] [--dry-run]');
  return o;
}

function checkedRoot(root, id = 'R9') {
  const g = pathSafe.realInside(path.parse(root).root, root, { allowRoot: true });
  if (!g.ok || !g.exists || g.type !== 'dir') throw new Refusal(id, `directory path refused: ${g.reason || 'not-directory'}`);
  return g.real;
}
function checkedFile(root, rel, optional = false) {
  checkedRoot(root);
  const g = pathSafe.realInside(root, rel, { refuseHardlinks: true });
  if (!g.ok) throw new Refusal('R9', `${rel}: ${g.reason === 'hardlink' ? 'hard links are refused' : `file path refused (${g.reason})`}`);
  if (!g.exists && optional) return null;
  const r = pathSafe.readFileGuarded(root, rel);
  if (!r.ok) throw new Refusal('R9', `${rel}: guarded read refused (${r.reason})`);
  return r.bytes;
}
function decoded(rel, buf) {
  // This is a semantic view only. Original buffers remain the sole write source;
  // BOM, CRLF and final-newline notes never cause rewritten host bytes.
  const d = textSafe.decode(buf, { bom: 'strip', crlf: 'normalise', invisible: 'report', finalNewline: 'report' });
  if (!d.ok) throw new Refusal('R9', `${rel}: text decoding refused (${d.problems.map(p => p.code).join(', ')})`);
  return d;
}
function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
  return { status: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
const sha256 = buf => `sha256:${crypto.createHash('sha256').update(buf).digest('hex')}`;

// The file is handled as BYTES, never as decoded text: a decoder drops a byte order mark, and a CRLF or a missing final newline
// must survive as they are. The kernel block region of a file is the start marker line through the end marker line and that line's
// own line end (CRLF, LF or none at the end of the file). Everything outside that region is the host's and stays byte for byte:
//   no block:   block inserted at the very start, after a byte order mark when there is one (BOM + block + the rest);
//   one block:  only the region is replaced (bytes before it + block + bytes after it).
// Marker comments are a domain format. The shared Markdown mask decides whether
// one is its own comment or belongs to a surrounding code/HTML example.
const BOM = Buffer.from([0xef, 0xbb, 0xbf]);
// Byte offsets only; decoded lines and Markdown structure come from text-safe.
function byteLines(buf) {
  const lines = [];
  let at = 0;
  while (at < buf.length) {
    const nl = buf.indexOf(0x0a, at);
    const eolEnd = nl < 0 ? buf.length : nl + 1;
    let end = nl < 0 ? buf.length : nl;
    if (end > at && buf[end - 1] === 0x0d) end -= 1;
    lines.push({ start: at, end, eolEnd });
    at = eolEnd;
  }
  return lines;
}
// The marker lines of a file (outside fences), or a Refusal for an ambiguous form.
function markerLines(rel, buf, bomLen) {
  const found = [];
  const d = decoded(rel, buf);
  const texts = d.text.split('\n');
  // Neutralise only exact domain delimiters in this classification view. Their
  // own HTML-comment syntax must not hide them; surrounding HTML/fences still
  // mask the surrogate through the shared Markdown implementation.
  const mask = textSafe.maskMarkdown(texts.map(t => t === START || t === END ? 'kernel-marker' : t).join('\n'));
  for (const [i, l] of byteLines(buf).entries()) {
    const line = mask.lines[i];
    const text = texts[i];
    if (line.kinds.some(k => k === 'fence' || k === 'fence-parity')) continue;
    if (text === START || text === END) {
      const own = !line.masked && !line.partial;
      if (!own) continue;
      found.push({ kind: text === START ? 'start' : 'end', start: i === 0 ? l.start + bomLen : l.start, eolEnd: l.eolEnd }); continue;
    }
    if (text.includes(START) || text.includes(END)) throw new Refusal('R10', `${rel} line ${i + 1}: kernel block marker text that is not a marker line of its own (inline, indented or with other text); make it a line of its own or remove it`);
  }
  return found;
}
// The host bytes of a file: the file without its kernel block region (used to prove that a plan keeps them).
function hostBytes(rel, buf) {
  const bomLen = buf.subarray(0, 3).equals(BOM) ? 3 : 0;
  const m = markerLines(rel, buf, bomLen);
  if (!m.length) return buf;
  return Buffer.concat([buf.subarray(0, m[0].start), buf.subarray(m[1].eolEnd)]);
}

// The block text and where it goes. Throws a Refusal for anything that could lose host text.
function planInstruction(target, rel, block) {
  const full = path.join(target, rel);
  const old = checkedFile(target, rel, true);
  if (old === null) return { rel, action: 'create', bytes: block, old: null };
  try { fs.accessSync(full, fs.constants.W_OK); } catch { throw new Refusal('R9', `${rel} is not writable (read-only); nothing was changed`); }
  const mode = fs.statSync(full).mode & 0o777;
  const bomLen = old.subarray(0, 3).equals(BOM) ? 3 : 0;
  const markers = markerLines(rel, old, bomLen);
  const starts = markers.filter(x => x.kind === 'start').length;
  const ends = markers.length - starts;
  if (starts !== ends || starts > 1) throw new Refusal('R10', `${rel} holds ${starts} start and ${ends} end marker line(s) of the kernel block; it must hold none or exactly one pair`);
  let plan;
  if (starts === 1) {
    if (markers[0].kind !== 'start') throw new Refusal('R10', `${rel}: the kernel block end marker comes before its start marker`);
    const next = Buffer.concat([old.subarray(0, markers[0].start), block, old.subarray(markers[1].eolEnd)]);
    plan = { rel, action: next.equals(old) ? 'unchanged' : 'replace-block', bytes: next, old };
  } else {
    const recorded = installedDigest(target, rel);
    if (recorded && recorded === sha256(old)) return { rel, action: 'replace-kernel-copy', bytes: block, old, mode };
    plan = { rel, action: 'prepend-block', bytes: Buffer.concat([old.subarray(0, bomLen), block, old.subarray(bomLen)]), old };
  }
  // the invariant itself, checked on the planned bytes before anything is written
  if (!hostBytes(rel, plan.bytes).equals(hostBytes(rel, old))) throw new Refusal('R10', `${rel}: the planned file would not keep the host bytes outside the block; nothing was changed`);
  return { ...plan, mode };
}
// Right before the write: the file is still exactly what the plan was made from (absent, or the same bytes in a regular file with
// one link). Returns the reason it is not, or null.
function changedSincePlan(target, p) {
  let bytes;
  try { bytes = checkedFile(target, p.rel, true); } catch { return 'was removed or replaced by a link during the install (guarded read refused)'; }
  if (p.old === null) return bytes === null ? null : 'appeared during the install';
  if (bytes === null) return 'was removed or replaced by a link during the install';
  return bytes.equals(p.old) ? null : 'changed during the install';
}
function installedDigest(target, rel) {
  try {
    const bytes = checkedFile(target, 'protocol-manifest.json', true);
    if (bytes === null) return null;
    const m = JSON.parse(decoded('protocol-manifest.json', bytes).text);
    return m && m.role === 'installed' && m.contentDigest && typeof m.contentDigest[rel] === 'string' ? m.contentDigest[rel] : null;
  } catch { return null; }
}

function preflight(o) {
  const target = path.resolve(o.target);
  if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) throw new Refusal('R1', `target is not a directory: ${target}`);
  const rt = checkedRoot(target, 'R1');
  if (pathSafe.sameFileOrNested(target, SOURCE)) throw new Refusal('R6', 'the target is this kernel checkout or contains it; install into another project');
  for (const blockRel of Object.values(BLOCKS)) {
    if (!fs.existsSync(path.join(SOURCE, blockRel))) throw new Refusal('R8', `${blockRel} is missing: this checkout is not a built product (a development checkout has no host block); install from the product repository`);
  }
  let manifest;
  try { manifest = JSON.parse(decoded('protocol-manifest.json', checkedFile(SOURCE, 'protocol-manifest.json')).text); } catch { throw new Refusal('R8', 'protocol-manifest.json of this checkout is unreadable'); }
  if (manifest.role !== 'source') throw new Refusal('R8', `this checkout is not an installation source (manifest role "${manifest.role}")`);
  for (const rel of Object.keys(BLOCKS)) if ((manifest.managed || []).includes(rel)) throw new Refusal('R8', `${rel} is a managed file of this checkout: it is not a product build (in the product the host owns ${rel})`);
  const top = git(target, ['rev-parse', '--show-toplevel']);
  if (top.status !== 0 || path.relative(checkedRoot(path.resolve(top.out), 'R2'), rt) !== '') throw new Refusal('R2', `the target is not the root of a git repository: ${target}`);
  const dirty = git(target, ['status', '--porcelain=v1', '--untracked-files=no']);
  if (dirty.status !== 0) throw new Refusal('R3', `git status failed in the target: ${dirty.err}`);
  if (dirty.out) throw new Refusal('R3', `the target has uncommitted changes in tracked files (${dirty.out.split('\n').length} path(s)); commit or stash them first so the install is one reviewable diff`);
  const plans = [];
  for (const [rel, blockRel] of Object.entries(BLOCKS)) {
    const block = checkedFile(SOURCE, blockRel);
    const d = decoded(blockRel, block);
    const text = d.text;
    if (!text.startsWith(`${START}\n`) || !text.endsWith(`${END}\n`)) throw new Refusal('R8', `${blockRel} is not a kernel block (it must start with ${START} and end with ${END})`);
    let inner;
    try { inner = markerLines(blockRel, block, 0); } catch (e) { throw new Refusal('R8', e.message); }
    if (inner.length !== 2 || inner[0].start !== 0 || inner[1].eolEnd !== block.length || d.bom || d.lineEndings.crlf) throw new Refusal('R8', `${blockRel} is not a kernel block (exactly one start line first, one end line last, LF line ends, no other marker)`);
    plans.push(planInstruction(target, rel, block));
  }
  return { target, plans };
}

function nodeRun(cwd, args) {
  const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true, env: { ...process.env, PROTOCOL_NO_FULL_SUITE: '1' }, maxBuffer: 256 * 1024 * 1024 });
  return { status: r.status, out: `${r.stdout || ''}${r.stderr || ''}` };
}
function checks(target) {
  const v = nodeRun(target, [path.join('.ai', 'bin', 'protocol-validate.cjs'), '--root', '.']);
  const l = nodeRun(target, [path.join('.ai', 'bin', 'protocol-core.cjs'), 'lint', '.ai/core']);
  const lr = l.out.split(/\r?\n/).find(x => x.startsWith('RESULT ')) || '';
  const f = /findings=(\d+)/.exec(lr);
  const vLines = v.out.split(/\r?\n/).filter(Boolean);
  return {
    validate: { ok: v.status === 0, status: v.status, summary: vLines[vLines.length - 1] || '', fails: vLines.filter(x => /\[FAIL\]/.test(x)) },
    lint: { ok: l.status === 0 && f !== null && f[1] === '0', status: l.status, result: lr },
  };
}

function main(argv, log = s => process.stdout.write(`${s}\n`)) {
  let o;
  try { o = parseArgs(argv); } catch (e) { log(`usage error: ${e.message}`); return 2; }
  let pre;
  try { pre = preflight(o); } catch (e) { if (e instanceof Refusal) { log(`REFUSED ${e.id}: ${e.message}`); return 2; } throw e; }
  const { target, plans } = pre;
  log(`kernel-install: source ${SOURCE}`);
  log(`kernel-install: target ${target}${o.update ? ' (update)' : ''}`);
  if (o.dryRun) {
    const v = nodeRun(SOURCE, [SETUP, '--Target', target, '--Verify']);
    const diffs = v.out.split(/\r?\n/).filter(l => l.startsWith('[!=]'));
    log(`dry-run: the base installer reports ${diffs.length} difference(s)${o.update ? ' (all would be written, managed files with a backup)' : ' (missing files would be created; differing managed files are kept without --update)'}:`);
    for (const l of diffs.slice(0, 80)) log(`  ${l}`);
    for (const p of plans) log(`dry-run: ${p.rel}: ${p.action}`);
    log('dry-run: then the validator and the layer lint would run in the target; nothing was changed');
    return 0;
  }
  const setup = nodeRun(SOURCE, [SETUP, '--Target', target, ...(o.update ? ['--Force'] : [])]);
  const setupLines = setup.out.split(/\r?\n/).filter(l => /^(Done:|Previous versions saved to:|\[error\]|\[==\])/.test(l));
  if (setup.status !== 0) {
    log(`install: FAILED (exit ${setup.status}); AGENTS.md and CLAUDE.md were not touched`);
    for (const l of setup.out.split(/\r?\n/).filter(Boolean).slice(-12)) log(`  ${l}`);
    return 1;
  }
  for (const l of setupLines) log(`install: ${l}`);
  // the plans were made before the base install on purpose: the digest rule reads the manifest of the EARLIER install, which the
  // base install rewrites; the base install itself never writes AGENTS.md or CLAUDE.md of a product (they are not managed there)
  // checked again right before each write: the file is still the one the plan was made from (no swap, no edit, no link since)
  for (const p of plans) {
    if (p.action !== 'unchanged') {
      const why = changedSincePlan(target, p);
      if (why) { log(`block: ${p.rel}: ${why}; nothing was written to it`); return 1; }
      checkedRoot(target);
      const written = pathSafe.writeAtomicGuarded(path.join(target, p.rel), p.bytes, { root: target, mode: p.mode });
      if (!written.ok) { log(`block: ${p.rel}: guarded write refused (${written.reason})`); return 1; }
    }
    log(`block: ${p.rel}: ${p.action}`);
  }
  const c = checks(target);
  log(`validate: ${c.validate.ok ? 'OK' : 'FAILED'} (exit ${c.validate.status}) ${c.validate.summary}`);
  log(`lint: ${c.lint.ok ? 'OK' : 'FAILED'} (exit ${c.lint.status}) ${c.lint.result}`);
  for (const l of c.validate.fails) log(`  ${l}`);
  if (!c.validate.ok || !c.lint.ok) { log('The changes are in the working tree of the target; nothing was committed. Fix the reported problems or revert with git.'); return 1; }
  log('Done. Nothing was committed or pushed: review the change with `git -C <target> diff` and `git -C <target> status`, then commit it.');
  log('Next (optional): the pilot kit on its own branch: node docs/ops/pilot-install.cjs --target <target> --dry-run');
  return 0;
}

module.exports = { main, planInstruction, changedSincePlan, preflight, hostBytes, START, END, BLOCKS };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

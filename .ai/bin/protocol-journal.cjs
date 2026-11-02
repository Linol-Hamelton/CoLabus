#!/usr/bin/env node
'use strict';

// append only through a new newest entry, never edit prior Evidence.
// Caller must use its SessionStart owner. This tool validates layout, not identity.
// Existing handoff reads archived-parent only in the preamble, so preserve it there.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const textSafe = require('./lib/text-safe.cjs');
const pathSafe = require('./lib/path-safe.cjs');
const hooks = require('./protocol-hooks.cjs');
const LABELS = ['Agent', 'Action', 'Result', 'Next step', 'Open'];
// One rule for the archived-parent marker. It is structural only as a whole HTML comment
// before the first '## ' heading (what protocol-handoff and protocol-archive read). Prose
// that merely mentions "archived-parent:" is not a marker; a comment that carries the
// word without the exact marker form is malformed structure.
const MARKER_COMMENT = /<!--[^\n]*?archived-parent:/g;
const MARKER_VALID = /<!-- archived-parent:\s*sha256:[a-f0-9]{64}\s*-->/g;
const hash = bytes => `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;

function read(root, file, policy = {}) {
  const value = pathSafe.readFileGuarded(root, file);
  if (!value.ok) throw new Error(`journal input refused (${value.reason})`);
  const decoded = textSafe.decode(value.bytes, policy);
  if (!decoded.ok) throw new Error(`journal text refused (${decoded.problems[0].code})`);
  return { bytes: value.bytes, text: decoded.text, real: value.real };
}

function validateBody(body, owner) {
  if (/^## |^Evidence:|journal-checkpoint:/m.test(body) || body.match(MARKER_COMMENT)) throw new Error('entry contains reserved structure');
  if (hooks.findSecretLeak(body)) throw new Error('entry contains an unredacted secret pattern');
  const own = textSafe.maskMarkdown(body).lines.filter(l => !l.masked && !l.partial).map(l => l.text);
  for (const label of LABELS) {
    const pattern = new RegExp(`^${label}:`);
    if (own.filter(l => pattern.test(l)).length !== 1) throw new Error(`entry needs exactly one own ${label} label`);
    if (body.split('\n').filter(l => pattern.test(l)).length !== 1) throw new Error('entry contains duplicate or hidden labels');
  }
  const complete = hooks.latestCompleteEntry('## 2000-01-01 - Input\n\n' + body);
  if (!complete) throw new Error('entry needs all five nonempty labels');
  const agent = owner.replace(/-[a-f0-9]{16}$/, '');
  if (!(hooks.entryField(complete, 'Agent') || '').match(new RegExp(`^${agent}(?:$|[ ,;(])`, 'i'))) throw new Error('entry Agent differs from owner');
}

function compose(previous, body, title, date) {
  const split = previous.search(/^## /m);
  const preamble = split < 0 ? previous : previous.slice(0, split);
  const tail = split < 0 ? '' : previous.slice(split);
  // Older entries are preserved bytes and never read for the marker.
  const valid = preamble.match(MARKER_VALID) || [];
  if (valid.length > 1 || (preamble.match(MARKER_COMMENT) || []).length !== valid.length) throw new Error('archived-parent layout is ambiguous');
  const entry = `## ${date} - ${title}\n\n${body.trimEnd()}\n`;
  const checkpoint = `<!-- journal-checkpoint: ${hash(Buffer.from(entry, 'utf8'))} -->\n\n`;
  // The checkpoint is prose metadata, not Evidence. One write publishes both.
  return preamble.trimEnd() + '\n\n' + entry + '\n' + checkpoint + tail;
}

function add(options, deps = {}) {
  const { owner, title, from } = options;
  if (typeof owner !== 'string' || !/^[a-z][a-z0-9_-]*-[a-f0-9]{16}$/.test(owner)) throw new Error('invalid owner name');
  if (typeof title !== 'string' || title.trim() !== title || !title || title.length > 120 || /[\r\n\x00-\x1f\x7f]/.test(title) || hooks.findSecretLeak(title)) throw new Error('invalid title');
  if (!textSafe.decode(Buffer.from(title), { invisible: 'refuse' }).ok) throw new Error('invalid title');
  if (typeof from !== 'string' || !from) throw new Error('missing --from');
  const root = path.resolve(options.root || process.cwd());
  const file = path.join(root, '.ai', 'worklog', `${owner}.md`);
  const source = path.resolve(root, from);
  if (pathSafe.sameFileOrNested(file, source)) throw new Error('entry input aliases journal');
  const input = read(root, source, { invisible: 'refuse', finalNewline: 'refuse' });
  validateBody(input.text, owner);
  const target = pathSafe.realInside(root, file, { refuseHardlinks: true });
  if (!target.ok || !target.exists || target.type !== 'file') throw new Error('start the session before journal add');
  const lock = path.join(root, '.ai', 'worklog', `.${owner}.add.lock`);
  const lockGuard = pathSafe.realInside(root, lock, { refuseHardlinks: true });
  if (!lockGuard.ok || lockGuard.exists) throw new Error('journal writer is busy or lock needs investigation');
  let fd = null; let id = null;
  try {
    fd = fs.openSync(lockGuard.real, 'wx');
    id = fs.fstatSync(fd, { bigint: true });
    if (typeof options.onLocked === 'function') options.onLocked();
    const previous = read(root, file);
    const date = (deps.now || (() => new Date()))().toISOString().slice(0, 10);
    const combined = compose(previous.text, input.text, title, date);
    const result = pathSafe.writeAtomicGuarded(file, Buffer.from(combined, 'utf8'), {
      root,
      onTempWritten: () => {
        if (typeof options.onBeforePublish === 'function') options.onBeforePublish();
        if (hash(read(root, file).bytes) !== hash(previous.bytes)) throw new Error('journal changed before publish');
      },
    });
    if (!result.ok || result.closeError) throw new Error(`journal publish refused (${result.reason || result.closeError})`);
    return { owner, checkpoint: hash(Buffer.from(`## ${date} - ${title}\n\n${input.text.trimEnd()}\n`, 'utf8')) };
  } finally {
    if (fd !== null) fs.closeSync(fd);
    if (id !== null) {
      const now = pathSafe.realInside(root, lock, { refuseHardlinks: true });
      if (now.ok && now.exists) {
        const st = fs.lstatSync(now.real, { bigint: true });
        if (st.ino === id.ino && st.dev === id.dev) fs.unlinkSync(now.real);
      }
    }
  }
}

function main(argv) {
  try {
    if (argv[0] !== 'add') throw new Error('usage: add --owner OWNER --title ASCII --from FILE [--root ROOT]');
    const options = {};
    const allowed = new Set(['--owner', '--title', '--from', '--root']);
    for (let i = 1; i < argv.length; i += 2) {
      if (!allowed.has(argv[i]) || !argv[i + 1] || argv[i + 1].startsWith('--') || Object.hasOwn(options, argv[i].slice(2))) throw new Error('invalid or duplicate argument');
      if (!/^[\x20-\x7e]+$/.test(argv[i + 1])) throw new Error('CLI values must be ASCII; deliver text through UTF-8 --from file');
      options[argv[i].slice(2)] = argv[i + 1];
    }
    const value = add(options);
    process.stdout.write(`JOURNAL ADDED owner=${value.owner} checkpoint=${value.checkpoint}\n`);
    return 0;
  } catch (e) {
    // No source bytes, argv values, paths or secret matches are echoed.
    process.stderr.write('BLOCKED journal add: input, layout or publication refused\n');
    return 2;
  }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { add, compose, validateBody, main };

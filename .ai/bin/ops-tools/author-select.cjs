'use strict';
// Author test selection. Depth 1: an enrolled test whose text names a changed file. Depth 2:
// also a test that names a non-test module which names a changed file. Heavy tests join only
// by the trigger configured for them. The parser is the driver's own enrollment; no code of
// the inspected tree is executed.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const plain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const names = file => [file, path.posix.basename(file)];

function gitRunner(root, run) {
  const spawn = run || ((file, args, opts) => spawnSync(file, args, opts));
  return args => {
    const r = spawn('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, maxBuffer: 256 * 1024 * 1024 });
    if (r.error || r.status !== 0) {
      const detail = r.error ? r.error.code : `exit ${r.status}`;
      throw Object.assign(new Error(`AUTHOR-SELECT-GIT: git ${args[0]} failed (${detail})`), { code: 'AUTHOR-SELECT-GIT' });
    }
    return r.stdout || '';
  };
}

function select(options = {}) {
  const root = path.resolve(options.root || '.');
  const base = options.base || 'origin/v2.0.0';
  const depth = options.depth === undefined ? 2 : Number(options.depth);
  if (![1, 2].includes(depth)) throw Object.assign(new Error('AUTHOR-SELECT-USAGE: depth must be 1 or 2'), { code: 'AUTHOR-SELECT-USAGE' });
  const git = options.git || gitRunner(root, options.run);
  const read = file => (options.readFile || (f => fs.readFileSync(f, 'utf8')))(path.join(root, file));
  const exists = options.exists || (file => fs.existsSync(path.join(root, file)));
  const author = options.author || {};
  const manifestFile = path.join(root, 'protocol-manifest.json');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { throw Object.assign(new Error(`AUTHOR-SELECT-MANIFEST: ${manifestFile} is unreadable`), { code: 'AUTHOR-SELECT-MANIFEST' }); }
  if (!plain(manifest) || !Array.isArray(manifest.tests)) throw Object.assign(new Error('AUTHOR-SELECT-MANIFEST: the manifest has no tests list'), { code: 'AUTHOR-SELECT-MANIFEST' });

  const changed = git(['diff', '--no-renames', '--name-only', '-z', `${base}...HEAD`]).split('\0')
    .concat(git(['diff', '--no-renames', '--name-only', '-z', 'HEAD']).split('\0'), git(['ls-files', '-z', '--others', '--exclude-standard']).split('\0'))
    .filter(Boolean).filter((file, index, all) => all.indexOf(file) === index);

  // The manifest counts only through the keys that changed: test enrollment alone is the
  // manifest test's own job in the common set, not a reason to select every test.
  let manifestKeys = [];
  if (changed.includes('protocol-manifest.json')) {
    let before = {};
    try { before = JSON.parse(git(['show', `${base}:protocol-manifest.json`])); } catch { before = {}; }
    const keys = new Set([...Object.keys(before), ...Object.keys(manifest)]);
    manifestKeys = [...keys].filter(key => JSON.stringify(before[key]) !== JSON.stringify(manifest[key]));
  }
  const testOnly = new Set(Array.isArray(author.manifestTestOnly) ? author.manifestTestOnly : ['tests', 'testTiers']);
  const manifestRelevant = manifestKeys.some(key => !testOnly.has(key));

  const enrolled = manifest.tests.filter(test => exists(test));
  const tracked = git(['ls-files']).split('\n').filter(file => /\.(c?js|mjs)$/.test(file) && exists(file));
  const ignore = Array.isArray(author.ignore) ? author.ignore : [];
  const code = changed
    .filter(file => !ignore.some(re => re.test(file)))
    .filter(file => file !== 'protocol-manifest.json' || manifestRelevant);

  const text = new Map();
  const body = file => { if (!text.has(file)) { try { text.set(file, read(file)); } catch { text.set(file, ''); } } return text.get(file); };
  const mentions = (file, target) => names(target).some(name => body(file).includes(name));

  const selected = new Map();
  const add = (test, why) => { if (!selected.has(test)) selected.set(test, why); };
  const common = Array.isArray(author.common) ? author.common : [];
  for (const test of common) if (exists(test)) add(test, 'common');
  for (const file of changed) if (enrolled.includes(file)) add(file, 'changed test');
  const heavy = plain(author.heavy) ? author.heavy : {};
  const isHeavy = test => Object.hasOwn(heavy, test);
  for (const test of enrolled) {
    if (isHeavy(test)) continue;
    const hit = code.find(file => file !== test && mentions(test, file));
    if (hit) add(test, `d1 ${hit}`);
  }
  if (depth >= 2) {
    const middles = tracked.filter(file => !enrolled.includes(file) && !/\.test\.c?js$/.test(file)
      && code.some(changedFile => changedFile !== file && /\.(c?js|mjs|json)$/.test(changedFile) && mentions(file, changedFile)));
    for (const test of enrolled) {
      if (isHeavy(test) || selected.has(test)) continue;
      const hit = middles.find(file => mentions(test, file));
      if (hit) add(test, `d2 ${hit}`);
    }
  }
  for (const [test, trigger] of Object.entries(heavy)) {
    if (!enrolled.includes(test)) continue;
    const hit = code.find(file => trigger.test(file));
    if (hit) add(test, `heavy trigger ${hit}`);
  }

  // Time estimate from the recorded suite timing when the tree has one.
  let estimateMs = 0;
  let timedFiles = 0;
  try {
    const timing = JSON.parse(read('docs/ops/suite-timing.json'));
    const rows = Array.isArray(timing.files) ? timing.files : [];
    const byName = new Map();
    const byOwner = new Map();
    for (const row of rows) {
      if (!plain(row) || typeof row.name !== 'string') continue;
      byName.set(row.name, Math.max(byName.get(row.name) || 0, row.attributedMs || 0));
      if (typeof row.owner === 'string') byOwner.set(row.owner, Math.max(byOwner.get(row.owner) || 0, row.attributedMs || 0));
    }
    for (const test of selected.keys()) {
      const ms = byName.get(test) || byOwner.get(test);
      if (ms) { estimateMs += ms; timedFiles++; }
    }
  } catch { /* no timing table on this tree */ }

  return {
    worktree: root, base, depth, manifestKeys,
    changed: changed.length, enrolled: enrolled.length, selected: selected.size,
    cpuMinutesKnown: Math.round(estimateMs / 60000), timedFiles,
    tests: [...selected.keys()],
    reasons: Object.fromEntries(selected),
  };
}

function main(argv) {
  const args = argv.slice();
  const list = {};
  const value = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  if (args.includes('--json')) { list.json = true; args.splice(args.indexOf('--json'), 1); }
  const depthValue = value('--depth');
  if (depthValue !== undefined) { list.depth = Number(depthValue); args.splice(args.indexOf('--depth'), 2); }
  const root = path.resolve(args[0] || '.');
  const base = args[1] && !args[1].startsWith('--') ? args[1] : 'origin/v2.0.0';
  let author;
  try { author = require('./lib/config.cjs').load({ root }).author; } catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  let result;
  try { result = select({ root, base, depth: list.depth, author }); }
  catch (e) { process.stderr.write(`${e.message}\n`); return 2; }
  if (list.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  else process.stdout.write(`${path.basename(root)} changed=${result.changed} selected=${result.selected}/${result.enrolled} cpu~${result.cpuMinutesKnown}min (timed ${result.timedFiles})\n`);
  return 0;
}

module.exports = { select, gitRunner, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

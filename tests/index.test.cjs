'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { run, write, makeProtocolFixture } = require('./helpers.cjs');
const index = require('../.ai/bin/protocol-index.cjs');

const BLOCK = (id, date, decision, extra = '') =>
  `### ${id}\n\nStatus: Accepted\nDate: ${date}\n${extra}` +
  `\nContext:\nSomething forced a choice.\n\nDecision:\n${decision}\n\n` +
  'Reasoning:\nBecause.\n\nAlternatives rejected:\nNothing.\n\n' +
  'Consequences:\nNone.\n\nApproved by: Owner Name\n';

function seed(t) {
  const root = makeProtocolFixture(t);
  write(root, '.ai/DECISIONS.md',
    '# Architectural and Technical Decisions\n\n' +
    BLOCK('DEC-0001', '2026-01-01',
      '1. Every `.ps1` file is ASCII-only. A second sentence must not appear.',
      'Reopen-trigger: owner-directive\n') +
    '\n---\n\n' +
    BLOCK('DEC-0002', '2026-01-02',
      'The gate reads `validate-protocol.ps1` and `.ai/bin/protocol-lock.cjs`.',
      'Supersedes: DEC-0001\n') +
    '\n---\n\n' +
    BLOCK('DEC-nnnn', '', '_What was chosen._'));
  return root;
}

function build(root) {
  return index.build(root);
}

test('the index covers every real block and excludes the template', t => {
  const root = seed(t);
  const result = build(root);
  const ids = result.rows.map(row => row.id);
  assert.deepEqual(ids, ['DEC-0001', 'DEC-0002']);
  assert.doesNotMatch(result.content, /DEC-nnnn/);
});

// The block end rule of the index, as oracles over one module: each runs a scenario and asserts the rows.
const blockEnds = (api, root) => {
  write(root, '.ai/DECISIONS.md', '# Decisions\n\n' +
    BLOCK('DEC-0001', '2026-01-01', 'The gate reads `validate-protocol.ps1`.') +
    '\n#### Scope\n\nAlso `.ai/bin/protocol-lock.cjs`.\n\n## Notes\n\nUnrelated `AGENTS.md`.\n\n' +
    BLOCK('DEC-0002', '2026-01-02', 'Plain.') + '\n# Elsewhere\n\nUnrelated `CLAUDE.md`.\n');
  const rows = api.build(root).rows;
  assert.deepEqual(rows.map(row => row.id), ['DEC-0001', 'DEC-0002']);
  assert.deepEqual(rows[0].paths, ['.ai/bin/protocol-lock.cjs', 'validate-protocol.ps1']);
  assert.deepEqual(rows[1].paths, []);
};
const fencedLines = (api, root) => {
  write(root, '.ai/DECISIONS.md', '# Decisions\n\n' +
    BLOCK('DEC-0001', '2026-01-01', 'The gate reads `validate-protocol.ps1`.') +
    '\n```bash\n# install the lock\n## not a section\n```\n\nAlso `.ai/bin/protocol-lock.cjs`.\n\n```\n### DEC-0009\n```\n\n' +
    BLOCK('DEC-0002', '2026-01-02', 'Plain.') + '\n```\nnever closed\n\n## Notes\n\nUnrelated `AGENTS.md`.\n');
  const rows = api.build(root).rows;
  assert.deepEqual(rows.map(row => row.id), ['DEC-0001', 'DEC-0002'], 'a fenced heading starts no block');
  assert.deepEqual(rows[0].paths, ['.ai/bin/protocol-lock.cjs', 'validate-protocol.ps1'], 'a fenced comment ends no block');
  assert.deepEqual(rows[1].paths, [], 'a fence that never closes fences nothing');
};

// A setext heading (= or - under a paragraph) ends the block like an ATX one; a fenced underline and
// a thematic break after a blank line end nothing.
const setextEnds = (api, root) => {
  write(root, '.ai/DECISIONS.md', '# Decisions\n\n' +
    BLOCK('DEC-0001', '2026-01-01', 'The gate reads `validate-protocol.ps1`.') +
    '\n~~~md\nExample\n=======\n~~~\n\nAlso `.ai/bin/protocol-lock.cjs`.\n\n---\n\nStill `.ai/bin/protocol-index.cjs`.\n\nNotes\n=======\n\nUnrelated `AGENTS.md`.\n\n' +
    BLOCK('DEC-0002', '2026-01-02', 'Plain.') + '\nElsewhere\n---\n\nUnrelated `CLAUDE.md`.\n');
  const rows = api.build(root).rows;
  assert.deepEqual(rows.map(row => row.id), ['DEC-0001', 'DEC-0002']);
  assert.deepEqual(rows[0].paths, ['.ai/bin/protocol-index.cjs', '.ai/bin/protocol-lock.cjs', 'validate-protocol.ps1']);
  assert.deepEqual(rows[1].paths, []);
};

test('a setext heading ends the block; a fenced underline and a thematic break after a blank line stay inside', t => {
  setextEnds(index, makeProtocolFixture(t));
});

test('a block ends at the next heading of its level or above; a lower heading stays inside', t => {
  blockEnds(index, makeProtocolFixture(t));
});

test('a fenced line is never a heading: an example ends and starts no block, a fence that never closes fences nothing', t => {
  fencedLines(index, makeProtocolFixture(t));
});

// The module compiled with one change, at its own path so its requires resolve as in the repository.
function indexMutant(from, to) {
  const file = path.join(__dirname, '../.ai/bin/protocol-index.cjs');
  const text = fs.readFileSync(file, 'utf8');
  assert.equal(text.split(from).length, 2, 'unique mutant anchor');
  const m = new Module(file, module); m.filename = file;
  m.paths = Module._nodeModulePaths(path.dirname(file));
  m._compile(text.replace(from, () => to), file);
  return m.exports;
}

for (const [label, from, to, oracle] of [
  ['a later section stays in the block', '/^ {0,3}#{1,3}(?:[ \\t]|$)/.test(line)) {', 'false) {', blockEnds],
  ['a setext heading stays in the block', 'if (setext.has(i) || ', 'if (', setextEnds],
  ['a lower heading ends the block', '#{1,3}(?:[ \\t]|$)/.test(line)', '#{1,6}(?:[ \\t]|$)/.test(line)', blockEnds],
  ['a fenced line is read as a heading', 'if (fenced[i]) {', 'if (false) {', fencedLines],
  ['a fence that never closes hides the rest', "fenceMap(lines, 'show')", "fenceMap(lines, 'hide')", fencedLines],
]) {
  test(`index mutant killed: ${label}`, t => {
    oracle(index, makeProtocolFixture(t));
    assert.throws(() => oracle(indexMutant(from, to), makeProtocolFixture(t)), assert.AssertionError);
  });
}

test('the normative line is the first sentence, numbering stripped, never a paraphrase', t => {
  const root = seed(t);
  const rows = build(root).rows;
  assert.equal(rows[0].norm, 'Every `.ps1` file is ASCII-only.');
  assert.equal(rows[0].trigger, 'owner-directive');
  assert.equal(rows[1].supersedes, 'DEC-0001');
});

test('the reverse index maps a path to the decisions that name it', t => {
  const root = seed(t);
  const result = build(root);
  assert.match(result.content, /`validate-protocol\.ps1` -> DEC-0002/);
  assert.match(result.content, /`\.ai\/bin\/protocol-lock\.cjs` -> DEC-0002/);
});

test('the index carries the source hash and --check detects a stale one', t => {
  const root = seed(t);
  const first = run(process.execPath, [path.join(root, '.ai/bin/protocol-index.cjs')], root);
  assert.equal(first.status, 0, first.stderr);
  const built = fs.readFileSync(path.join(root, index.OUTPUT), 'utf8');
  assert.match(built, /^- source sha256: [0-9a-f]{64}$/m);

  const fresh = run(process.execPath,
    [path.join(root, '.ai/bin/protocol-index.cjs'), '--check'], root);
  assert.equal(fresh.status, 0, fresh.stdout);

  fs.appendFileSync(path.join(root, '.ai/DECISIONS.md'),
    `\n---\n\n${BLOCK('DEC-0003', '2026-01-03', 'A later decision changes the file.')}`);
  const stale = run(process.execPath,
    [path.join(root, '.ai/bin/protocol-index.cjs'), '--check'], root);
  assert.equal(stale.status, 1, 'a changed source must make the index stale');
  assert.match(stale.stdout, /stale/);
});

test('the index is derived state and never claims authority', t => {
  const root = seed(t);
  const content = build(root).content;
  assert.match(content, /derived, disposable/);
  assert.match(content, /never cited as Evidence/);
  // It must live under the disposable runtime directory, not in tracked state.
  assert.match(index.OUTPUT.replace(/\\/g, '/'), /^\.ai\/runtime\//);
});

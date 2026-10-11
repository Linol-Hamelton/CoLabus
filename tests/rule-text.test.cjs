'use strict';
// K5: the one definition of "text" (records.cjs textOf / hasText / ruleText / parseRuleId / bodyStructure). In-process, no spawns.
// The closed list of forms is ; this file pins the shared functions that both lint and the compiler call.
const test = require('node:test');
const assert = require('node:assert/strict');
const { textOf, hasText, ruleText, parseRuleId, bodyStructure } = require('../.ai/bin/lib/records.cjs');

const HOLLOW = [
  '', ' ', '\t', '.', '-', '---', '***', '()', '[]', '""', "''", '``', '` `', '`` ``', '<!-- -->', '<!-- a --> <!-- b -->',
  '&nbsp;', '&#8203;', ' ', '　', '​', '‍', '﻿', '⁠', '­',
  'ᅟ', 'ᅠ', 'ㅤ', 'ﾠ', '឴', '️', '\u{E0041}', '\\', '\\.', '\\`\\`',
];
const REAL = ['Do the thing.', '1', '`code`', '`<!-- x -->`', '`&nbsp;`', '\\`x\\`', 'a <!-- c --> b', '&#65;', '- item 2', 'Ж'];

test('K5 hollow text carries no letter or digit; real text does', () => {
  for (const v of HOLLOW) assert.equal(hasText(v), false, JSON.stringify(v));
  for (const v of REAL) assert.equal(hasText(v), true, JSON.stringify(v));
});

test('K5 literal mode keeps entities as the literal name (paths and globs)', () => {
  assert.equal(hasText('&nbsp;'), false);
  assert.equal(hasText('&nbsp;', { literal: true }), true);
  assert.equal(textOf('src/**', { literal: true }), 'src/**');
  assert.equal(textOf('&#8203;', { literal: true }), '&#8203;');
});

test('K5 a rule line parses only when text follows its marker; the hollow ones are no rule', () => {
  assert.equal(parseRuleId('R-L0-01. A real rule.'), 'R-L0-01');
  assert.equal(parseRuleId('- R-L0-01. A real rule.'), 'R-L0-01');
  assert.equal(ruleText('R-L0-01. A real rule.'), 'A real rule.');
  assert.equal(ruleText('not a rule'), null);
  for (const tail of HOLLOW.filter(x => x.trim() !== '')) {
    for (const lead of ['R-L0-01. ', '- R-L0-01. ']) assert.equal(parseRuleId(lead + tail), null, JSON.stringify(lead + tail));
  }
  for (const line of ['R-L0-01.', 'R-L0-01. ', 'R-L0-01.\t', '- R-L0-01.']) assert.equal(parseRuleId(line), null, JSON.stringify(line));
});

test('K5 bodyStructure reports a hollow rule as unparsed (lint F10) with hollow=true, a bare marker as malformed, a real rule as a rule', () => {
  const lines = ['---', '---', '', '## Rules', 'R-L0-01. Real.', 'R-L0-02. .', '- R-L0-03. ``', 'R-L0-04.', 'R-L0-05. <!-- gone -->', '## Evidence', 'R-L0-09. Outside the Rules section.'];
  const body = bodyStructure({ bodyStart: 2, lines });
  assert.deepEqual(body.rules.map(r => r.id), ['R-L0-01']);
  assert.deepEqual(body.unparsed.map(u => [u.line, u.hollow, u.id]), [[6, true, 'R-L0-02'], [7, true, 'R-L0-03'], [8, false, null], [9, true, 'R-L0-05']]);
});

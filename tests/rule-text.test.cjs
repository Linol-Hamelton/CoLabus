'use strict';
// The one definition of "text" (records.cjs textOf / hasText / ruleText / parseRuleId / bodyStructure). In-process, no spawns.
// This file pins the shared functions that both lint and the compiler call.
const test = require('node:test');
const assert = require('node:assert/strict');
const { textOf, hasText, ruleText, parseRuleId, bodyStructure } = require('../.ai/bin/lib/records.cjs');

const HOLLOW = [
  '', ' ', '\t', '.', '-', '---', '***', '()', '[]', '""', "''", '``', '` `', '`` ``', '<!-- -->', '<!-- a --> <!-- b -->',
  '&nbsp;', '&#8203;', ' ', '　', '​', '‍', '﻿', '⁠', '­',
  'ᅟ', 'ᅠ', 'ㅤ', 'ﾠ', '឴', '️', '\u{E0041}', '\\', '\\.', '\\`\\`',
];
const REAL = ['Do the thing.', '1', '`code`', '`<!-- x -->`', '`&nbsp;`', '\\`x\\`', 'a <!-- c --> b', '&#65;', '- item 2', 'Ж'];

test('hollow text carries no letter or digit; real text does', () => {
  for (const v of HOLLOW) assert.equal(hasText(v), false, JSON.stringify(v));
  for (const v of REAL) assert.equal(hasText(v), true, JSON.stringify(v));
});

test('literal mode keeps entities as the literal name (paths and globs)', () => {
  assert.equal(hasText('&nbsp;'), false);
  assert.equal(hasText('&nbsp;', { literal: true }), true);
  assert.equal(textOf('src/**', { literal: true }), 'src/**');
  assert.equal(textOf('&#8203;', { literal: true }), '&#8203;');
});

test('a rule line parses only when text follows its marker; the hollow ones are no rule', () => {
  assert.equal(parseRuleId('R-L0-01. A real rule.'), 'R-L0-01');
  assert.equal(parseRuleId('- R-L0-01. A real rule.'), 'R-L0-01');
  assert.equal(ruleText('R-L0-01. A real rule.'), 'A real rule.');
  assert.equal(ruleText('not a rule'), null);
  for (const tail of HOLLOW.filter(x => x.trim() !== '')) {
    for (const lead of ['R-L0-01. ', '- R-L0-01. ']) assert.equal(parseRuleId(lead + tail), null, JSON.stringify(lead + tail));
  }
  for (const line of ['R-L0-01.', 'R-L0-01. ', 'R-L0-01.\t', '- R-L0-01.']) assert.equal(parseRuleId(line), null, JSON.stringify(line));
});

test('bodyStructure reports a hollow rule as unparsed (lint F10) with hollow=true, a bare marker as malformed, a real rule as a rule', () => {
  const lines = ['---', '---', '', '## Rules', 'R-L0-01. Real.', 'R-L0-02. .', '- R-L0-03. ``', 'R-L0-04.', 'R-L0-05. <!-- gone -->', '## Evidence', 'R-L0-09. Outside the Rules section.'];
  const body = bodyStructure({ bodyStart: 2, lines });
  assert.deepEqual(body.rules.map(r => r.id), ['R-L0-01']);
  assert.deepEqual(body.unparsed.map(u => [u.line, u.hollow, u.id]), [[6, true, 'R-L0-02'], [7, true, 'R-L0-03'], [8, false, null], [9, true, 'R-L0-05']]);
});

test('L5L6 the metric anchor M<nnn> parses as a rule id (R-L6-M001.<k>), the anchor grammar of metric records; attackers of the closed grammar stay unparsed', () => {
  // anchorFor of protocol-core.cjs already returns R-L6-M<nnn> for
  // metric records; before this grammar landed those rule lines fell to `unparsed` (F10).
  assert.equal(parseRuleId('R-L6-M001.1. A metric rule.'), 'R-L6-M001.1');
  assert.equal(parseRuleId('- R-L6-M012.5. Freshness is a rule, not a heading.'), 'R-L6-M012.5');
  assert.equal(parseRuleId('R-L6-m001.1. A lowercase word stays a word anchor, never a metric anchor.'), 'R-L6-m001.1');
  const lines = ['---', '---', '', '## Rules', 'R-L6-M001.1. Real metric rule.', 'R-L6-M001.2. .', 'R-L6-M01.1. Two digits is not an anchor.', 'R-L6-M001a.1. A letter tail is not an anchor.', '## Evidence'];
  const body = bodyStructure({ bodyStart: 2, lines });
  assert.deepEqual(body.rules.map(r => r.id), ['R-L6-M001.1']);
  assert.deepEqual(body.unparsed.map(u => [u.line, u.hollow, u.id]), [[6, true, 'R-L6-M001.2'], [7, false, null], [8, false, null]]);
});

test('L5L6 fix1 the M-alternative accepts only the three-digit metric anchor and widens nothing else', () => {
  // Does RULE_ID accept only the new metric rule ids
  // (R-L6-M<nnn>.<k>) and nothing more? Negative battery plus the unchanged neighbours.
  for (const line of [
    'R-L6-M01.1. Two digits is not a metric anchor.',
    'R-L6-M001a.1. A letter tail is not a metric anchor.',
    'R-L6-M0001.1. Four digits is not a metric anchor.',
    'R-L6-M.1. A bare M is not a metric anchor.',
    'M001.1. Without the record prefix it is not a rule id.',
  ]) {
    assert.equal(parseRuleId(line), null, JSON.stringify(line));
  }
  // The neighbours of the alternative behave exactly as before it: numeric ids, S anchors
  // and word anchors parse; a four-digit numeric id stays unparsed.
  assert.equal(parseRuleId('R-L6-001.1. A numeric rule id parses.'), 'R-L6-001.1');
  assert.equal(parseRuleId('R-L6-0001.1. Four digits is not a numeric anchor.'), null);
  assert.equal(parseRuleId('R-L6-S001.1. An S anchor parses.'), 'R-L6-S001.1');
  assert.equal(parseRuleId('R-L6-word.1. A word anchor parses.'), 'R-L6-word.1');
  assert.equal(parseRuleId('R-L5-M001.1. A metric anchor outside L6 parses by layer-agnostic grammar.'), 'R-L5-M001.1');
});

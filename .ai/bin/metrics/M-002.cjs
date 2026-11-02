'use strict';
// M-002: owner clarifications per stop-question.
// Owner-card metric; debt row L6-M002. Separate leaf file.
// ADVISORY only. Unknown is never a number.
//
//   node .ai/bin/metrics/M-002.cjs [--a DIR] [--b DIR]
//     --a/--b  directories of owner cards (default: docs/ops split into two comparable
//              date packages: kernel-completion window >=2026-10-05 and earlier).
// Exit: 0 computed (value may be null); 2 usage, unreadable or undecodable source.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const textSafe = require('../lib/text-safe.cjs');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const OPS = path.join(ROOT, 'docs', 'ops');
const SINCE = '2026-10-05';
// Closed grammar of an owner-card file name (allow-list): the token OWNER-CARD and a
// calendar date in the name. Councils, tasks and tables are not stop-question cards.
const CARD_FILE = /OWNER-CARD.*(\d{4}-\d{2}-\d{2})\.md$/;
// Own line (outside fences) that opens the stop question; the owner card form allows ONE.
// \b is ASCII-only in JavaScript and never fires after Cyrillic, so the boundary is
// an explicit lookahead.
const QUESTION_HEADING = /^#{1,6}\s+Вопрос(?=\s|$|:)/i;

function usage(msg) { process.stderr.write(String(msg) + '\n'); return 2; }
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }

function readText(file) {
  const buf = fs.readFileSync(file);
  const d = textSafe.decode(buf, { bom: 'strip', crlf: 'normalise' });
  if (!d.ok) throw new Error('undecodable: ' + path.relative(ROOT, file));
  return { text: d.text, bytes: buf.length, sha256: sha256(buf) };
}

function listPackage(dir) {
  const abs = path.resolve(dir);
  const names = fs.readdirSync(abs).filter((n) => n.endsWith('.md')).sort();
  const out = [];
  for (const name of names) {
    const m = CARD_FILE.exec(name);
    if (!m) continue;
    const file = path.join(abs, name);
    const { text, bytes, sha256: sha } = readText(file);
    const mask = textSafe.maskMarkdown(text);
    let questions = 0;
    for (const row of mask.lines) {
      if (!row || row.masked || row.partial) continue;
      if (QUESTION_HEADING.test(row.text)) questions++;
    }
    out.push({ file: name, date: m[1], bytes, sha256: sha, questions });
  }
  return out;
}

function inventory(rows) {
  const total = rows.length;
  const withOne = rows.filter((r) => r.questions === 1).length;
  const withZero = rows.filter((r) => r.questions === 0).length;
  const withMany = rows.filter((r) => r.questions > 1).length;
  // Clarifications per stop-question need the owner's answer joined back to the card;
  // answers live in later addenda/owner-tasks and are not linked per card. Never imputed.
  return {
    cards: total,
    cardsWithExactlyOneQuestionHeading: withOne,
    cardsWithZeroQuestionHeadings: withZero,
    cardsWithMultipleQuestionHeadings: withMany,
    value: null,
    unit: 'ownerClarificationsPerStopQuestion',
    denominator: {
      n: total,
      of: 'owner_cards_in_package',
      note: 'form compliance is measured; the clarification ratio needs a per-card answer join that does not exist',
    },
    unknowns: [
      { field: 'ownerClarifications', reason: 'owner answers are not recorded per card (no answer-id join to OT addenda)' },
      { field: 'stopQuestions', reason: 'counted only as markdown Вопрос headings; a card written without the heading is 0, not missing, and is reported separately' },
    ],
    sources: rows.map((r) => ({ path: 'docs/ops/' + r.file, sha256: r.sha256, bytes: r.bytes, questions: r.questions })),
  };
}

function main(argv) {
  let a = OPS, b = OPS, filterA = (r) => r.date >= SINCE, filterB = (r) => r.date < SINCE;
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--a' || k === '--b') {
      const dir = argv[++i];
      if (!dir) return usage('missing value for ' + k);
      if (k === '--a') { a = dir; filterA = null; } else { b = dir; filterB = null; }
    } else return usage('unknown argument: ' + k);
  }
  let rowsA, rowsB;
  try {
    rowsA = listPackage(a).filter((r) => (filterA ? filterA(r) : true));
    rowsB = listPackage(b).filter((r) => (filterB ? filterB(r) : true));
  } catch (e) { return usage(e.message); }
  const pa = inventory(rowsA); pa.name = 'kernel-completion-window'; pa.path = 'docs/ops (date>=' + SINCE + ')';
  const pb = inventory(rowsB); pb.name = 'pre-window'; pb.path = 'docs/ops (date<' + SINCE + ')';
  const result = {
    metric: 'M-002',
    title: 'Owner clarifications per stop-question',
    advisory: true,
    generatedAt: new Date().toISOString(),
    value: null,
    unit: 'ownerClarificationsPerStopQuestion',
    denominator: { n: pa.cards + pb.cards, of: 'owner_cards_across_both_packages', note: 'ratio stays null without the answer join' },
    unknowns: pa.unknowns,
    packages: { a: pa, b: pb },
    consumer: {
      decision: 'when and which stop-question to place on an owner card (the owner card form)',
      status: 'form rule unchanged; fill measured',
      basis: 'one-question form compliance is measured per package; the clarification ratio cannot change the card form until answers are joined per card',
    },
  };
  process.stdout.write(JSON.stringify(result, null, 1) + '\n');
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { CARD_FILE, QUESTION_HEADING, listPackage, inventory, SINCE };

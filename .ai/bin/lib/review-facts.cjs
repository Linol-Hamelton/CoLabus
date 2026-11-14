'use strict';
// Review facts: what a review file must carry before it can accept a card or complete a task. Exact text facts only.
//   R-ADVISORY      the review declares an advisory mode (a Mode line or a Mode table cell with ADVISORY, or the
//                   [MODE: READ-ONLY ADVISORY] marker standing at the start of a line), read after the normalisation below
//   R-SHA           the Reviewed commit field of the header (Reviewed commit or Reviewed commit SHA, as a line or a table
//                   row) names a full 40-hex commit SHA that is not a placeholder (one digit repeated); with an expected SHA,
//                   every SHA of that field is exactly the expected one. A SHA in any other field (Baseline, a fix baseline,
//                   a note) or in a comment never counts
//   R-EXIT          the review states at least one exit code (an "exit N" / "exit code N" / "exit=N" text, or a table with an Exit,
//                   Exit code, Код or Код выхода column and a row whose exit cell starts with an integer token)
// The header is the text before the first line that is --- or starts with "## " (the whole file when neither appears).
// R-SHA reads only the header. R-ADVISORY reads the whole file outside closed fenced code blocks: a Mode line below the header
// border declares the mode as much as one above it, and a fence that is never closed hides nothing.
// Blockquoted Mode lines and body-list Mode examples are quotations; header-list Mode lines remain declarations.
// The explicit advisory marker still counts at the start of a line, even inside a blockquote or list.
// R-ADVISORY keeps gate-structure.cjs's comment, emphasis, table-cell and Mode-value rules and extends its Unicode
// handling: compatibility forms folded and combining marks dropped (NFKD: fullwidth letters and colon, accents), format
// characters dropped (a byte order mark, zero-width and direction marks), Unicode line separators turned into line breaks,
// every other Unicode space (a no-break space included) turned into a plain space, the Cyrillic, Greek and small-capital
// letters that look like a Latin one turned into it, comment delimiters into spaces, and a table row with a Mode cell
// read as a Mode line of each of its other cells. Emphasis and spaces inside Mode values are ignored, as in the validator.
// A Mode value is advisory when ADVISORY stands in it outside parentheses, or inside parentheses when the rest of the value
// does not say CERTIFYING ("Mode: CERTIFYING (not ADVISORY)" is certifying, "Mode: (ADVISORY)" is not). The marker counts
// only at the start of a line (after a list marker, a quote mark or a table bar): a marker quoted inside a sentence is a quote.
// Matching is case-insensitive.
const MODE_LINE = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+|>[ \t]*)*[*_`]*Mode(?![a-z0-9])[*_`]*\s*:\s*([^\r\n]+)/gim;
const MODE_CELL = /^[*_`]*Mode(?![a-z0-9])[*_`]*[ \t]*:?/i;
const ADVISORY_MARKER = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+|>[ \t]*|\|[ \t]*)*\[[ \t*_`]*MODE[ \t*_`]*:[^\]\r\n]{0,80}ADVISORY[^\]\r\n]{0,80}\]?/im;
const REVIEWED_LINE = /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+|>[ \t]*)*Reviewed[ \t]+commit(?:[ \t]+SHA)?[ \t]*:[ \t]*(.*)$/i;
const REVIEWED_CELL = /^Reviewed[ \t]+commit(?:[ \t]+SHA)?[ \t]*:?$/i;
const SHA40 = /(?<![0-9a-fA-F])[0-9a-fA-F]{40}(?![0-9a-fA-F])/g;
const EXIT_TEXT = /\bexit(?:[ \t]+code)?[ \t]*[=:]?[ \t]*-?\d{1,10}\b/i;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/;
// Letters of other scripts that a reader takes for a Latin one: code point of the look-alike, the Latin letter.
const LOOKALIKES = new Map([
  [0x410, 'A'], [0x412, 'B'], [0x415, 'E'], [0x41A, 'K'], [0x41C, 'M'], [0x41D, 'H'], [0x41E, 'O'], [0x420, 'P'], [0x421, 'C'], [0x422, 'T'],
  [0x425, 'X'], [0x406, 'I'], [0x408, 'J'], [0x405, 'S'], [0x430, 'a'], [0x435, 'e'], [0x43E, 'o'], [0x440, 'p'], [0x441, 'c'], [0x445, 'x'],
  [0x443, 'y'], [0x456, 'i'], [0x458, 'j'], [0x455, 's'], [0x501, 'd'], [0x4CF, 'l'], [0x4BB, 'h'], [0x51B, 'q'], [0x51D, 'w'],
  [0x391, 'A'], [0x392, 'B'], [0x395, 'E'], [0x396, 'Z'], [0x397, 'H'], [0x399, 'I'], [0x39A, 'K'], [0x39C, 'M'], [0x39D, 'N'], [0x39F, 'O'],
  [0x3A1, 'P'], [0x3A4, 'T'], [0x3A5, 'Y'], [0x3A7, 'X'], [0x3BF, 'o'], [0x3BD, 'v'], [0x3B9, 'i'], [0x3C1, 'p'], [0x585, 'o'], [0x131, 'i'], [0x251, 'a'],
  [0x1D00, 'a'], [0x299, 'b'], [0x1D04, 'c'], [0x1D05, 'd'], [0x1D07, 'e'], [0x262, 'g'], [0x29C, 'h'], [0x26A, 'i'], [0x1D0A, 'j'], [0x1D0B, 'k'],
  [0x29F, 'l'], [0x1D0D, 'm'], [0x274, 'n'], [0x1D0F, 'o'], [0x1D18, 'p'], [0x280, 'r'], [0xA731, 's'], [0x1D1B, 't'], [0x1D1C, 'u'], [0x1D20, 'v'],
  [0x28F, 'y'], [0x1D22, 'z'],
]);
const LOOKALIKE = new RegExp(`[${[...LOOKALIKES.keys()].map(c => String.fromCodePoint(c)).join('')}]`, 'g');

// A leading integer token may be followed by a whitespace-separated remark.
// Decimal, hex, overlong and embedded numbers are not exit codes.
const exitColumn = cell => /^(?:exit(?:[ \t]+code)?|код(?:[ \t]+выхода)?)$/i.test(cell.replace(/[*_`]/g, '').trim());
const integerExit = cell => /^(-?\d{1,10})(?=\s|$)/.exec(cell.replace(/[*_`]/g, '').trim())?.[1] ?? null;
// A bare column header with no integer row states no exit code.
const cellsOf = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
function exitInTable(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    if (!/^[ \t]*\|/.test(lines[i])) continue;
    const col = cellsOf(lines[i]).findIndex(exitColumn);
    for (let j = i + 1; col >= 0 && j < lines.length && /^[ \t]*\|/.test(lines[j]); j++) {
      if (integerExit(cellsOf(lines[j])[col] || '') !== null) return true;
    }
  }
  return false;
}
function headerOf(text) {
  const lines = String(text).split(/\r?\n/);
  const end = lines.findIndex(l => l.trim() === '---' || l.startsWith('## '));
  return end < 0 ? lines.join('\n') : lines.slice(0, end).join('\n');
}
// The text without its closed fenced code blocks (a fence line and the line that closes it with the same mark and at least
// as long). A fence with no closing line is not a block: everything after it stays.
function outsideFences(text) {
  const lines = String(text).split(/\r?\n/);
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE.exec(lines[i]);
    if (open) {
      const mark = open[1];
      const close = new RegExp(`^[ \\t]{0,3}${mark[0] === '`' ? '`' : '~'}{${mark.length},}[ \\t]*$`);
      let end = -1;
      for (let j = i + 1; j < lines.length && end < 0; j++) if (close.test(lines[j])) end = j;
      if (end >= 0) { i = end; continue; }
    }
    out.push(lines[i]);
  }
  return out.join('\n');
}
function modeText(text) {
  const folded = text.normalize('NFKD').replace(/[\p{Mn}\p{Cf}]/gu, '').replace(LOOKALIKE, c => LOOKALIKES.get(c.codePointAt(0)));
  const lines = folded.replace(/[\u0085\u2028\u2029]/g, '\n').replace(/[^\S\r\n]/g, ' ')
    .split('<!--').join(' ').split('-->').join(' ').replace(/(^|\n)([ \t]*)\* /g, '$1$2- ').replace(/[*_`]/g, '').split(/\r?\n/);
  const out = [];
  let body = false;
  for (const line of lines) {
    if (line.trim() === '---' || line.startsWith('## ')) body = true;
    // Blockquotes quote Mode lines; body lists can quote them too. A standalone
    // advisory marker still declares advisory, including inside a blockquote.
    if (/^[ \t]*>/.test(line) && !ADVISORY_MARKER.test(line)) continue;
    if (body && /^[ \t]*(?:[-+]|\d+[.)])[ \t]+Mode\s*:/i.test(line)) continue;
    out.push(line);
    if (!line.includes('|')) continue;
    const cells = line.split('|').map(c => c.trim());
    if (cells.some(c => MODE_CELL.test(c))) for (const c of cells) if (c) out.push(MODE_CELL.test(c) ? c : `Mode: ${c}`);
  }
  return out.join('\n');
}
// A Mode value declares advisory when ADVISORY stands outside its parentheses, or inside them when the rest of the value does
// not name a certifying mode.
function advisoryValue(value) {
  const flat = value.replace(/[ \t]/g, '');
  const outside = flat.replace(/\([^()]*\)/g, '');
  if (/ADVISORY/i.test(outside)) return true;
  return /ADVISORY/i.test(flat) && !/CERTIF/i.test(outside);
}
function isAdvisory(text) {
  const mode = modeText(outsideFences(text));
  return [...mode.matchAll(MODE_LINE)].some(m => advisoryValue(m[1])) || ADVISORY_MARKER.test(mode);
}
// The 40-hex SHAs of the Reviewed commit field(s) of the header: a "Reviewed commit[ SHA]: value" line or a table row
// whose cell is that label (the cells after it are its value). Compatibility forms are folded, emphasis is dropped, a
// comment is invisible; look-alike letters are not folded, so a label spelt with them is no label.
function reviewedShas(header) {
  const text = header.normalize('NFKC').replace(/\p{Cf}/gu, '').replace(/[\u0085\u2028\u2029]/g, '\n').replace(/[^\S\r\n]/g, ' ')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/[*_`]/g, '');
  const found = [];
  const values = [];
  for (const line of text.split(/\r?\n/)) {
    const field = REVIEWED_LINE.exec(line);
    if (field) { values.push(field[1].trim()); found.push(...(field[1].match(SHA40) || [])); continue; }
    if (!line.includes('|')) continue;
    const cells = line.split('|').map(c => c.trim());
    const at = cells.findIndex(c => REVIEWED_CELL.test(c));
    if (at >= 0) { const value = cells.slice(at + 1).join(' ').trim(); values.push(value); found.push(...(value.match(SHA40) || [])); }
  }
  return { shas: found.map(s => s.toLowerCase()), values };
}
function reviewFacts(text, { expectedSha = null } = {}) {
  const t = String(text === undefined || text === null ? '' : text);
  const header = headerOf(t);
  const facts = [];
  const advisory = isAdvisory(t);
  facts.push(advisory ? { code: 'R-ADVISORY', ok: false, level: 'gate', detail: 'the review is written in READ-ONLY ADVISORY mode', fix: 'an advisory review never accepts a card or completes a task; a certifying seat writes Mode: CERTIFYING' } : { code: 'R-ADVISORY', ok: true, level: 'gate' });
  const field = reviewedShas(header);
  const shas = field.shas.filter(s => !/^(.)\1{39}$/.test(s));
  const expected = expectedSha ? String(expectedSha).toLowerCase() : null;
  if (!shas.length) facts.push({ code: 'R-SHA', ok: false, level: 'gate', detail: 'the Reviewed commit field of the header names no full commit SHA (missing or a placeholder)', fix: 'name the reviewed commit by its full 40-hex SHA in the Reviewed commit field of the header' });
  else if (expected && !field.shas.every(s => s === expected)) facts.push({ code: 'R-SHA', ok: false, level: 'gate', detail: `the Reviewed commit field of the header does not name only the sealed commit ${expected.slice(0, 12)}`, fix: 'review the sealed commit and name it, alone, in the Reviewed commit field of the header' });
  else facts.push({ code: 'R-SHA', ok: true, level: 'gate' });
  facts.push(EXIT_TEXT.test(t) || exitInTable(t) ? { code: 'R-EXIT', ok: true, level: 'gate' } : { code: 'R-EXIT', ok: false, level: 'gate', detail: 'the review states no exit code of any check it ran', fix: 'state each command the review ran with its exit code' });
  return facts;
}
const problems = facts => facts.filter(f => !f.ok).map(f => f.code);

// The certification minimum is defined here once. Basic reviewFacts remains
// available to historical/advisory readers; acceptance always uses this layer.
const MIN_EXECUTED_CHECKS = 2;
function visibleText(text) {
  let fence = null;
  return String(text).replace(/<!--[\s\S]*?(?:-->|$)/g, '').split(/\r?\n/).filter(line => {
    const m = /^\s*(`{3,}|~{3,})/.exec(line);
    if (m) { if (!fence) fence = m[1][0]; else if (m[1][0] === fence) fence = null; return false; }
    return !fence && !/^\s*>/.test(line);
  }).join('\n').normalize('NFKC').replace(/\p{Cf}/gu, '');
}
function headerValues(text, name) {
  const re = new RegExp(`^[ \\t]*(?:[-*+] +)?(?:\\*\\*)?(?:${name})(?:\\*\\*)?[ \\t]*:[ \\t]*(.*)$`, 'gim');
  return [...headerOf(visibleText(text)).matchAll(re)].map(m => m[1].trim());
}
function reviewedSha(text) {
  const { values } = reviewedShas(headerOf(visibleText(text)));
  if (values.length !== 1) return null;
  const m = /^`?([a-f0-9]{40})`?$/i.exec(values[0]);
  return m && !/^(.)\1{39}$/.test(m[1]) ? m[1].toLowerCase() : null;
}
const tableCells = line => line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
function executedChecks(text) {
  const lines = visibleText(text).split('\n');
  const checks = new Map();
  const add = (command, exit) => {
    const c = command.replace(/^[\s`*_]+|[\s`*_]+$/g, '').trim();
    if (!/^[A-Za-z0-9_./\\:-]+(?:\s|$)/.test(c) || /^(?:none|n\/a|unknown|placeholder)$/i.test(c) ||
        /protocol-session\.cjs|protocol-handoff\.cjs\s+(?:record|rehash)\b/.test(c) || !/^-?\d{1,10}$/.test(exit)) return;
    checks.set(c.replace(/\s+/g, ' '), Number(exit));
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*\|/.test(line) && i + 1 < lines.length) {
      const head = tableCells(line).map(c => c.replace(/[*_`]/g, '').toLowerCase());
      const command = head.findIndex(c => /^(?:command|команда)$/.test(c)), exit = head.findIndex(exitColumn);
      const divider = tableCells(lines[i + 1]);
      if (command >= 0 && exit >= 0 && divider.length === head.length && divider.every(c => /^:?-{3,}:?$/.test(c))) {
        for (let j = i + 2; j < lines.length && /^\s*\|/.test(lines[j]); j++) {
          const cells = tableCells(lines[j]);
          if (cells.length === head.length) {
            const code = integerExit(cells[exit]);
            if (code !== null) add(cells[command], code);
          }
        }
      }
    }
    const m = /^\s*(?:[-*+] +)?(?:Checks?:\s*)?(.+?)\s*(?::|;|\s[-–]\s)?\s+\(?exit(?:\s+code)?\s*[=:]?\s*(-?\d{1,10})(?:\s|[.;,)]|$)/i.exec(line);
    if (m && !line.trim().startsWith('|')) add(m[1].replace(/[:;]$/, ''), m[2]);
  }
  return [...checks].map(([command, exit]) => ({ command, exit }));
}
// The progress table of a certifier report (certifier budget, docs/ops/cert-economy.cjs): a table whose first three header cells are
// exactly Audit item, State and Blocking, read from the visible text only (a table inside a code fence, a quote or a comment is an
// example, not progress). The table is the whole block from its header to the next heading or the end of the report: a blank line or a
// text line between two rows does not end it, so an open item written after one is read as well and can never slip past the acceptance
// path (F-01). A row is open unless its State is done (the State is read without letter case and without spacing, so done, DONE and
// ' done ' are one state); it could block unless its Blocking cell is no. One reader for the acceptance path below and the launcher:
// -> { tables, items: [{ item, state, blocking }], open: [items that are open and could block], statusPartial }.
function progressOf(text) {
  const lines = visibleText(text).split('\n');
  const clean = c => c.replace(/[*_`]/g, '').trim().toLowerCase();
  const items = []; let tables = 0;
  // the header of a progress table: its first three cells are exactly Audit item, State and Blocking
  const headOf = line => tableCells(line).map(clean);
  const isHead = head => head[0] === 'audit item' && head[1] === 'state' && head[2] === 'blocking';
  // the divider of a table: one cell per header cell, three dashes or more in every cell
  const isDivider = (line, cells) => {
    if (typeof line !== 'string' || !line.includes('|')) return false;
    const d = tableCells(line);
    return d.length === cells && d.every(c => /^:?-{3,}:?$/.test(c));
  };
  // a heading ends the block of a table
  const isHeading = line => /^\s{0,3}#{1,6}(?:\s|$)/.test(line);
  for (let i = 0; i + 1 < lines.length; i++) {
    // a table row has a pipe; the edge pipes are optional (a table without them is still a table), so a second table written
    // without them is read like the first and an open item in it can never slip past the acceptance path
    if (!lines[i].includes('|')) continue;
    const head = headOf(lines[i]);
    if (!isHead(head)) continue;
    if (!isDivider(lines[i + 1], head.length)) continue;
    tables++;
    // the block of the table: from its header to the next heading or the end of the report
    let end = lines.length;
    for (let k = i + 2; k < lines.length; k++) if (isHeading(lines[k])) { end = k; break; }
    let j = i + 2;
    for (; j < end; j++) {
      const line = lines[j];
      if (!line.trim()) continue;         // a blank line between two rows does not end the table
      if (!/\|/.test(line)) continue;      // a text line between two rows is not a row and does not end the table
      const rowHead = headOf(line);
      // the next table of the block: its header and its divider start it, the outer loop reads it
      if (isHead(rowHead)) { if (isDivider(lines[j + 1], rowHead.length)) break; continue; }
      const cells = tableCells(line);
      if (cells.every(c => /^:?-{2,}:?$/.test(c))) continue;  // a divider line is not a row
      items.push({ item: cells[0].replace(/[*_`]/g, '').trim(), state: clean(cells[1] || ''), blocking: clean(cells[2] || '') });
    }
    i = j - 1;
  }
  const statusPartial = [...visibleText(text).matchAll(/^[ \t]*(?:[-*+] +)?(?:\*\*)?(?:Status|Статус)(?:\*\*)?\s*:\s*([^\r\n]+)/gim)].some(m => /^PARTIAL\b/i.test(m[1].replace(/[*_`]/g, '').trim()));
  return { tables, items, open: items.filter(r => r.state !== 'done' && r.blocking !== 'no'), statusPartial };
}
// R-CHAIN (PROTO-DEC-0252 items 3 and 5): a CHAINED certifier report carries, for each earlier report path the
// launch contract named (opts.chain), exactly one section whose heading is `## Chain review: <path>`, holding at
// least two reproduction statements (`- Reproduction:` lines with content). Read on the visible text only, so a
// fenced, quoted or commented line can never fake a section or a reproduction. Without the sections the
// chained report fails acceptance (the launcher fails the seat; the report never silently turns advisory).
const CHAIN_HEAD = /^## Chain review: (\S+)\s*$/;
const CHAIN_REPRO = /^\s*[-*+] +Reproduction(?:\s+\d+)?\s*:\s*\S/;
function chainSections(text) {
  const sections = new Map();
  let current = null;
  for (const line of visibleText(text).split('\n')) {
    const head = CHAIN_HEAD.exec(line);
    if (head) { current = head[1]; if (!sections.has(current)) sections.set(current, 0); continue; }
    if (/^\s{0,3}#{1,6}(?:\s|$)/.test(line)) { current = null; continue; }
    if (current !== null && CHAIN_REPRO.test(line)) sections.set(current, sections.get(current) + 1);
  }
  return sections;
}
function chainFact(text, paths) {
  const sections = chainSections(text);
  const missing = paths.filter(p => !sections.has(p));
  const short = paths.filter(p => sections.has(p) && sections.get(p) < 2);
  const ok = missing.length === 0 && short.length === 0;
  return { code: 'R-CHAIN', ok, level: 'gate', detail: ok ? 'one review section per earlier report, each with at least two reproductions'
    : `chained review sections missing or thin: ${[...missing.map(p => `${p} (no section)`), ...short.map(p => `${p} (${sections.get(p)}/2 reproductions)`)].join('; ').slice(0, 200)}`,
    fix: 'write one "## Chain review: <path>" section per earlier report, each with at least two "- Reproduction:" lines (PROTO-DEC-0252 item 3)' };
}
function certificationFacts(text, { expectedSha = null, servedModel = null, chain = null } = {}) {
  // One answer for R-SHA and R-ADVISORY: both come from reviewFacts on the file itself (not on visibleText, which drops
  // an unclosed fence tail and every blockquote line), so a gate that reads certificationFacts and one that reads
  // reviewFacts agree on the same bytes. visibleText still feeds the facts that only certification has. The one extra
  // R-SHA rule of certification: the header names the reviewed commit by exactly one labelled line or table row.
  const raw = reviewFacts(String(text), { expectedSha });
  const facts = reviewFacts(visibleText(text)).filter(f => f.code === 'R-EXIT');
  const rawSha = raw.find(f => f.code === 'R-SHA');
  const labelled = reviewedShas(headerOf(String(text))).values.length;
  facts.unshift(raw.find(f => f.code === 'R-ADVISORY'), labelled > 1
    ? { code: 'R-SHA', ok: false, level: 'gate', detail: 'the header names the reviewed commit on more than one labelled line', fix: 'name the reviewed commit once, in the Reviewed commit field of the header' }
    : rawSha);
  const checks = executedChecks(text);
  facts.push({ code: 'R-CHECKS', ok: checks.length >= MIN_EXECUTED_CHECKS, level: 'gate', detail: `at least ${MIN_EXECUTED_CHECKS} distinct executed commands with integer exit codes are required` });
  const statuses = [...visibleText(text).matchAll(/^[ \t]*(?:[-*+] +)?(?:\*\*)?(?:Status|Статус)(?:\*\*)?\s*:\s*([^\r\n]+)/gim)].map(m => m[1].replace(/[*_`]/g, '').trim().toUpperCase());
  const unfinished = /^(?:(?:Status|Статус)\s*:\s*)?(?:IN PROGRESS|PROVISIONAL)$/im.test(visibleText(text).replace(/[*_`]/g, '').trim());
  // Only COMPLETE accepts one closed bracketed remark, with no trailing text.
  facts.push({ code: 'R-STATUS', ok: !unfinished && statuses.length > 0 && statuses.every(s => /^(?:FINAL|COMPLETED|ЗАВЕРШЁН|COMPLETE(?:[ \t]+(?:\([^()\r\n]*\)|\[[^\[\]\r\n]*\]))?)$/.test(s)), level: 'gate', detail: 'the review must have a final status and no unfinished status' });
  // A report with an audit item still open that could block is PARTIAL and never certifies, whatever its status and verdict say.
  const progress = progressOf(text);
  const partial = progress.statusPartial || progress.open.length > 0;
  facts.push({ code: 'R-PARTIAL', ok: !partial, level: 'gate', detail: partial ? `PARTIAL report: ${progress.open.length ? `open audit items that could block: ${progress.open.slice(0, 5).map(r => r.item.slice(0, 80)).join('; ')}` : 'Status: PARTIAL'}` : 'no open blocking audit item' });
  if (servedModel !== null) {
    const { canonicalModel } = require('./model-identity.cjs');
    const declared = headerValues(text, 'Reviewer[ -]model');
    const expected = canonicalModel(servedModel);
    let actual = 'UNKNOWN';
    if (declared.length === 1) {
      actual = canonicalModel(declared[0].replace(/^`|`$/g, ''));
    }
    facts.push({ code: 'R-MODEL', ok: expected !== 'UNKNOWN' && actual === expected, level: 'gate', detail: 'Reviewer model differs from the served-model proof of this seat run' });
  }
  if (chain !== null) facts.push(chainFact(text, chain));
  return facts;
}
module.exports = { headerOf, reviewFacts, problems, certificationFacts, reviewedSha, executedChecks, progressOf, chainSections, MIN_EXECUTED_CHECKS };

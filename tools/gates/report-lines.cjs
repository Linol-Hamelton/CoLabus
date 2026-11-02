'use strict';
// report-lines.cjs - the one line selection of the gates tools.
// Everything about what a Markdown line IS belongs to the shared reader .ai/bin/lib/text-safe.cjs
// (the shared guards library): this module only adds the project's own convention that a
// `<data id=N> ... </data id=N>` block quotes foreign text (PROTO-DEC-0132 item 2), which the
// shared mask does not know.
//
//   analyzeText(text) -> { statements, ledger, ledgerForeign, ledgerLost, lines, stripped }
//     stripped    the text with every data-block line replaced by a masked nonempty placeholder
//                 (line count and final-nonempty boundary are kept), so a reader
//                 that does not know the convention - the shared verdict reader - cannot read a
//                 quoted foreign verdict or ledger out of a data block
//     statements  [{ n, line }]  the document's own statements: wholly outside every masked span
//                 (a verdict line, a Class line); a partly masked line is never a statement
//     ledger      [{ n, line }]  statements plus lines masked only as a Markdown table: a findings
//                 ledger is the report's own data, so its rows come back even though the mask
//                 covers them; a table inside a fence, a comment, a quote or a data block does not
//     ledgerLost  [{ n, kinds }] a line shaped like a table row that the mask never gave a table
//                 kind: an inline span (code, link) opened in an earlier row crossed the row
//                 boundary and covered it, wholly or in part (the shared mask
//                 lets an inline span cross table rows, so the row is routed to `lines` only and
//                 the loss would be silent). It is reported, never dropped: the caller makes the
//                 ledger unknown. A row inside a fence, a comment, a quote, a data block or a raw
//                 HTML element carries a block kind and is foreign by design: the row that opened
//                 the span still has its table kind and is reported as ledgerForeign.
//     lines       [{ n, line, partial }]  every line outside whole-line masks, with its original
//                 text: the write-set grammar reads its own backticked entries out of them, so a
//                 partly masked line (inline code) is kept and the caller decides (shared guards, section 2)
//
// A data block opens on a line that is a statement or is masked only as the HTML block the opening
// tag itself starts (kinds html-block/html-inline-tag), exactly as before the round: a quoted or
// fenced `<data id=N>` never opens one. While a data block is open every line is skipped, masked or
// not, until the line that is exactly its `</data id=N>`; an unclosed block swallows the rest.
// No private BOM, CRLF, fence or comment handling lives anywhere else in tools/gates: files are
// decoded by text-safe decode before they reach this module.

const textSafe = require('../../.ai/bin/lib/text-safe.cjs');

const DATA_OPEN = /^<data id=([0-9A-Za-z]+)>/;
const DATA_PLACEHOLDER = '<!-- foreign data -->';
const OPEN_KINDS = new Set(['html-block', 'html-inline-tag']);
const TABLE_KIND = 'table';
// Inline formatting a table row may hold and still be the report's own ledger data (a backticked
// reproduction is the corpus norm). Any other mask on a table line is foreign text inside the
// ledger: the row is reported, never silently dropped (a dropped open row would be a wrong pass).
const ROW_INLINE_KINDS = new Set(['code-span', 'inline-link', 'html-inline-tag']);
// A lost row carries only inline kinds: a block kind (fence, comment, quote, element, ...) is a
// foreign context by design, and the row that opened it still reports itself as ledgerForeign.
const LOST_INLINE_KINDS = new Set(['code-span', 'inline-link', 'html-inline-tag']);
// A line shaped like a table row. A legitimate row is always masked whole as a table (the mask's
// own M7), so a shaped line that never became one was covered by something else.
// The shape is BOTH GFM forms - a leading pipe (the old form) or a pipe
// with a space on at least one side, the conservative pipe-less form. An unspaced "a|b" of prose
// is not a lost row (it stays a partial line, never a statement); a partly covered pipe-less row
// whose visible text still holds a spaced pipe is reported instead of silently vanishing.
// The row shape is judged on the text a reader can see: the leading-pipe form reads the raw
// line (a wholly covered row keeps its own shape), and the spaced-pipe form reads the line with
// every masked span replaced by one placeholder, so a pipe inside inline code, a link or a tag
// (`Mode: CERTIFYING | ADVISORY`) is prose, not a table row shape.
const tableShapedOn = (raw, visible) => raw.startsWith('|') || /(^|\s)\|(\s|$)/.test(visible);
const onlyInlineKinds = kinds => kinds.length > 0 && kinds.every(k => LOST_INLINE_KINDS.has(k));

function analyzeText(text) {
  const mask = textSafe.maskMarkdown(text);
  const out = { statements: [], ledger: [], ledgerForeign: [], ledgerLost: [], lines: [], stripped: [] };
  // The intervals the mask covers on each line (spans carry 1-based lines, 0-based columns,
  // end exclusive), used to build the visible text of a line: masked parts become placeholders.
  const covered = [];
  // A table row is complete only when its inline spans stay on that row. Inspect the shared
  // mask's spans, not another spelling of a row: a wholly covered pipe-less row has no visible
  // delimiter at all. Reporting the boundary row also catches every later swallowed shape.
  const crossRowInline = new Set();
  for (const s of mask.spans) {
    for (let i = s.startLine; i <= s.endLine; i++) {
      (covered[i] || (covered[i] = [])).push([i === s.startLine ? s.startCol : 0, i === s.endLine ? s.endCol : Infinity]);
      if (s.endLine > s.startLine && ROW_INLINE_KINDS.has(s.kind)) crossRowInline.add(i);
    }
  }
  const visibleText = (n, raw) => {
    const parts = (covered[n] || []).slice().sort((a, b) => a[0] - b[0]);
    if (!parts.length) return raw;
    let out2 = ''; let at = 0;
    for (const [from, to] of parts) {
      if (from > at) out2 += raw.slice(at, from);
      out2 += '\uFFFC';
      at = Math.max(at, to);
    }
    return out2 + raw.slice(Math.min(at, raw.length));
  };
  let data = null;
  // A lost row is reported only beside a table the mask did recognise (a neighbour line of the
  // table kind, or a lost row already reported in the chain): a row away from every table cannot
  // hide a finding of a ledger the reader reads, and reporting it would only turn prose with a
  // spaced pipe (`Mode: CERTIFYING | Receipt-Owner: ...`) into a false unknown.
  const tableKindLine = new Set(mask.lines.filter(l => l.kinds.includes(TABLE_KIND)).map(l => l.line));
  const besideTable = n => tableKindLine.has(n - 1) || tableKindLine.has(n + 1);
  for (const l of mask.lines) {
    const t = l.text.trim();
    const vis = l.masked || l.partial ? visibleText(l.line, l.text).trim() : t;
    if (data) { out.stripped.push(DATA_PLACEHOLDER); if (t === `</data id=${data}>`) data = null; continue; }
    const wholly = !l.masked && !l.partial;
    const tagLine = l.masked && [...l.kinds].every(k => OPEN_KINDS.has(k));
    if (wholly || tagLine) {
      const d = DATA_OPEN.exec(t);
      // Neither erase the line nor turn it into whitespace: that shifts the header window or
      // resurrects an earlier verdict as the closing line. The shared reader masks this marker.
      if (d) { out.stripped.push(DATA_PLACEHOLDER); if (!t.endsWith(`</data id=${d[1]}>`)) data = d[1]; continue; }
    }
    if (l.masked) {
      out.stripped.push(l.text);
      // a table line is the report's own ledger data; a table inside a fence, a comment, a quote,
      // a data block or a raw-HTML element carries other kinds and never comes back. A table line
      // whose only other kinds are inline formatting is data; a table line holding anything else
      // masked (a comment inside a cell, an element) is foreign text inside the ledger: it is
      // reported, so the caller makes the ledger unknown instead of silently losing the row.
      if (l.kinds.includes(TABLE_KIND)) {
        const rest = l.kinds.filter(k => k !== TABLE_KIND);
        if (crossRowInline.has(l.line)) out.ledgerForeign.push({ n: l.line, kinds: [...rest, 'cross-row-inline'] });
        else if (rest.every(k => ROW_INLINE_KINDS.has(k))) out.ledger.push({ n: l.line, line: l.text });
        else out.ledgerForeign.push({ n: l.line, kinds: rest });
      } else if (besideTable(l.line) && tableShapedOn(t, vis) && onlyInlineKinds(l.kinds)) {
        out.ledgerLost.push({ n: l.line, kinds: [...l.kinds] });
        tableKindLine.add(l.line);
      }
      continue;
    }
    out.stripped.push(l.text);
    out.lines.push({ n: l.line, line: l.text, partial: l.partial });
    if (wholly) { out.statements.push({ n: l.line, line: l.text }); out.ledger.push({ n: l.line, line: l.text }); }
    else if (l.partial && besideTable(l.line) && tableShapedOn(t, vis) && onlyInlineKinds(l.kinds)) {
      out.ledgerLost.push({ n: l.line, kinds: [...l.kinds] });
      tableKindLine.add(l.line);
    }
  }
  return { ...out, stripped: out.stripped.join('\n') };
}

module.exports = { analyzeText };

'use strict';
// ONE shared closed grammar for every numeric operator token: the task
// helper's --seats, --coupling and --tokens and the seat/pair --timeout and
// --certifiers all pass through this single normaliser. The token is a plain
// decimal integer (zero, or a nonzero-leading body of ASCII digits) and
// nothing else: `1e0`, `0x1`, `1.0`, `+1`, a blank, a full-width digit or any
// other spelling is refused with the caller's own refusal code, never
// silently coerced by Number().
const S = require('./state.cjs');
const CLOSED_INTEGER = /^(0|[1-9][0-9]{0,8})$/;
function closedInteger(value, code) {
  if (typeof value !== 'string' || !CLOSED_INTEGER.test(value)) S.fail(code);
  return Number(value);
}
const { decode, maskMarkdown } = require('../../.ai/bin/lib/text-safe.cjs');
// Canonical register spelling: two digits below 100, then 3 or 4 nonzero-leading digits.
const P_NUMBER_BODY = '(?:[0-9]{2}|[1-9][0-9]{2,3})';
const CLOSED_P_NUMBER = new RegExp(`^P-${P_NUMBER_BODY}$`);

function processCitations(text) {
  if (typeof text !== 'string') S.fail('INVALID_CITATION_SOURCE');
  const tokens = new RegExp(`(?<![\\w-])P-${P_NUMBER_BODY}\\b`, 'g');
  const result = [];
  for (const match of text.matchAll(tokens)) {
    const before = text.slice(0, match.index), after = text.slice(match.index + match[0].length);
    // A range is a different grammar, including its second endpoint. A suffix
    // such as P-1000-based is ordinary prose after a canonical citation.
    const startsRange = /^\s*(?:\.\.|[-\u2013\u2014])\s*(?:P-)?[0-9]/.test(after);
    const endsRange = /P-[0-9]+\s*(?:\.\.|[-\u2013\u2014])\s*$/.test(before);
    if (startsRange || endsRange) continue;
    result.push(match[0]);
  }
  return result;
}

function closedProcessNumber(value, code = 'INVALID_PROCESS_NUMBER') {
  if (typeof value !== 'string' || !CLOSED_P_NUMBER.test(value)) S.fail(code);
  return Number(value.slice(2));
}

function formatProcessNumber(num, code = 'INVALID_PROCESS_NUMBER') {
  const n = typeof num === 'number' ? num : (typeof num === 'string' && CLOSED_INTEGER.test(num) ? Number(num) : null);
  if (n === null || !Number.isSafeInteger(n) || n < 0 || n > 9999) S.fail(code);
  return `P-${String(n).padStart(2, '0')}`;
}

function classifyProcessRows(source) {
  if (typeof source !== 'string' && !Buffer.isBuffer(source)) S.fail('INVALID_REGISTER_SOURCE');
  const decoded = decode(Buffer.isBuffer(source) ? source : Buffer.from(source), { bom:'strip', crlf:'normalise', invisible:'refuse' });
  if (!decoded.ok) S.fail('INVALID_REGISTER_TEXT');
  const rows = [];
  const lines = decoded.text.split('\n');
  // Decide table membership BEFORE interpreting cells. Neutral cells prevent an
  // HTML/code/comment opener in data from masking this row or subsequent rows.
  // The shared mask still excludes enclosing fences, quotes and HTML blocks.
  const structure = lines.map(line => /^ {0,3}\|/.test(line) ? line.match(/^ */)[0] + '| cell |' : line).join('\n');
  for (const context of maskMarkdown(structure).lines) {
    const l = { ...context, text:lines[context.line - 1] };
    const meta = { line:l.text, lineNumber:l.line };
    const ambiguous = /^\s+\|/.test(l.text) && !/^ {0,3}\|/.test(l.text)
      && (l.kinds.includes('table') || (l.kinds.every(k=>k==='indented-code') && /^ *\t/.test(l.text)));
    if (ambiguous) { rows.push({ ...meta, kind:'refused', reason:'AMBIGUOUS_REGISTER_ROW' }); continue; }
    if (l.kinds.some(k => !['table','code-span','inline-link','html-inline-tag'].includes(k))) {
      rows.push({ ...meta, kind:/^ {0,3}\t[ \t]*\|/.test(l.text) && l.kinds.every(k=>k==='indented-code') ? 'refused' : 'non-row', reason:'AMBIGUOUS_REGISTER_ROW' });
      continue;
    }
    const match = /^ {0,3}\|[ \t]*([^|]*?)[ \t]*\|(.*)$/.exec(l.text);
    if (!match) {
      rows.push({ ...meta, kind:/^ {0,3}\|/.test(l.text) ? 'refused' : 'non-row', reason:'INVALID_REGISTER_ROW' });
      continue;
    }
    const id = match[1].trim();
    const cells = l.text.trim().replace(/^\||\|$/g,'').split('|').map(c=>c.trim());
    const labels = cells.map(c=>c.toLowerCase()).join('|');
    const header = ['id|process', 'id|process|since|trigger|command|documented in|owner|enforced by|status', 'stream|branch|sha|owner|status|updated|note'].includes(labels);
    const separator = cells.every(c=>/^:?-{3,}:?$/.test(c));
    if (header || separator) { rows.push({ ...meta, kind:'non-row' }); continue; }
    // Full process registers have nine cells. Two-cell compact registers are a
    // supported legacy input of the shared numeric reader (not checkRegister).
    if (!/\|[ \t]*$/.test(l.text) || ![2,9].includes(cells.length)) {
      rows.push({ ...meta, id, kind:'refused', reason:'INVALID_REGISTER_ROW' }); continue;
    }
    if (!CLOSED_P_NUMBER.test(id)) { rows.push({ ...meta, id, kind:'refused', reason:'INVALID_PROCESS_NUMBER' }); continue; }
    const cellKinds = maskMarkdown(l.text).lines[0].kinds;
    const plainCells = cellKinds.every(k => ['table','code-span','inline-link','html-inline-tag'].includes(k))
      && !/<\/?summary(?:\s|\/?>)/i.test(l.text);
    if (!plainCells) {
      // The row's identity is known even when its presentation is unsupported.
      // Reserve it for allocation; strict readers and register still refuse it.
      rows.push({ ...meta, id, number:closedProcessNumber(id), kind:'refused', reason:'INVALID_REGISTER_ROW' }); continue;
    }
    rows.push({ ...meta, kind:'valid', number:closedProcessNumber(id), id, body:match[2] });
  }
  return rows;
}

function processRows(source, allocation = false) {
  const classes = classifyProcessRows(source);
  const reserved = row => allocation && row.reason === 'INVALID_REGISTER_ROW' && Number.isInteger(row.number);
  const refused = classes.find(row=>row.kind==='refused' && !reserved(row));
  if (refused) S.fail(`${refused.reason} line ${refused.lineNumber}`);
  return classes.filter(row=>row.kind==='valid' || reserved(row));
}

function readProcessRows(source) { return processRows(source); }

function scanProcessNumbers(registerSource) {
  const items = Array.isArray(registerSource) || registerSource instanceof Set
    ? [...registerSource].map(item => typeof item === 'number'
      ? closedProcessNumber(formatProcessNumber(item)) : closedProcessNumber(item))
    : processRows(registerSource, true).map(r => r.number);
  const unique = new Set(items);
  if (typeof registerSource === 'string' || Buffer.isBuffer(registerSource)) {
    if (unique.size !== items.length) S.fail('DUPLICATE_REGISTER');
  }
  return [...unique].sort((a,b) => a-b);
}

function nextProcessNumber(registerSource) {
  const nums = scanProcessNumbers(registerSource);
  const next = nums.length ? Math.max(...nums) + 1 : 0;
  formatProcessNumber(next); // Exhaustion is a refusal, never an invalid emitted token.
  return next;
}

function allocateProcessNumber(registerSource, preferred = null) {
  const nums = new Set(scanProcessNumbers(registerSource));
  if (preferred !== null && preferred !== undefined) {
    const p = typeof preferred === 'string' && preferred.startsWith('P-')
      ? closedProcessNumber(preferred) : closedProcessNumber(formatProcessNumber(preferred));
    if (!nums.has(p)) return p;
  }
  return nextProcessNumber(registerSource);
}

module.exports = {
  closedInteger,
  readProcessRows,
  classifyProcessRows,
  processCitations,
  closedProcessNumber,
  formatProcessNumber,
  scanProcessNumbers,
  nextProcessNumber,
  allocateProcessNumber,
};

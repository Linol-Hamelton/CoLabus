'use strict';
// task-lint.cjs - shared linting library for task/prompt files
// Provides: lintTask(text, context), checkTaskContext(context, io), lintTaskFile(file, context, io)
// Context: { profile, worktree, completion }
// Profiles: 'task' (author ANGLE/ENTITY policy) and 'pin' (PIN_HTML predicate only)
// The library is the ONE place that decides the profile of a call that names none:
// an absent profile (undefined or null) resolves to the task profile; a caller that
// wants the pin profile must name it. Pure function, no spawn/network/write.

const fs = require('node:fs');
const path = require('node:path');

// Text safety utilities from text-safe.cjs
const { decode } = require('./text-safe.cjs');

// Profile names, exported so callers pass them by identifier, never as literals
const TASK_PROFILE = 'task';
const PIN_PROFILE = 'pin';

// The resolved profile of a context: a named profile passes through, an absent one is the task profile
function resolveProfile(context) {
  if (context && context.profile !== undefined && context.profile !== null) return context.profile;
  return TASK_PROFILE;
}

// Maximum file size: 1 MiB
const MAX_SIZE = 1024 * 1024;

// Token pattern: [A-Z0-9][A-Z0-9_.-]{0,127}
const TOKEN_PATTERN = /^[A-Z0-9][A-Z0-9_.-]{0,127}$/;

// Footer pattern: exactly "Task-End: TOKEN" in column 1, last non-empty line
const FOOTER_PATTERN = /^Task-End: ([A-Z0-9][A-Z0-9_.-]{0,127})$/;

// Command fence languages (lowercase)
const ALLOWED_FENCE_LANGUAGES = new Set(['sh', 'bash', 'powershell', 'ps1', 'cmd', 'console']);

// Inline command executables (ASCII only)
const ALLOWED_INLINE_EXECUTABLES = new Set([
  'node', 'git', 'npm', 'npx', 'pwsh', 'powershell', 'cmd', 'python',
]);

// Angle bracket pattern
const ANGLE = /[<>]/;

// Ampersand entity pattern
const ENTITY = /&[A-Za-z#]/;

// HTML pattern for pin profile - matches the existing ops-guard.cjs PIN_HTML pattern
// Rejects: < followed by letter/slash/!, or & followed by # or named entities
const PIN_HTML = /<[A-Za-z/!?]|&(?:#|[A-Za-z][A-Za-z0-9]*;|AElig|AMP|Aacute|Acirc|Agrave|Aring|Atilde|Auml|COPY|Ccedil|ETH|Eacute|Ecirc|Egrave|Euml|GT|Iacute|Icirc|Igrave|Iuml|LT|Ntilde|Oacute|Ocirc|Ograve|Oslash|Otilde|Ouml|QUOT|REG|THORN|Uacute|Ucirc|Ugrave|Uuml|Yacute|aacute|acirc|acute|aelig|agrave|amp|aring|atilde|auml|brvbar|ccedil|cedil|cent|copy|curren|deg|divide|eacute|ecirc|egrave|eth|euml|frac12|frac14|frac34|gt|iacute|icirc|iexcl|igrave|iquest|iuml|laquo|lt|macr|micro|middot|nbsp|not|ntilde|oacute|ocirc|ograve|ordf|ordm|oslash|otilde|ouml|para|plusmn|pound|quot|raquo|reg|sect|shy|sup1|sup2|sup3|szlig|thorn|times|uacute|ucirc|ugrave|uml|uuml|yacute|yen|yuml)/;

/**
 * Check task context validity
 * @param {object} context - { profile, worktree, completion }
 * @param {object} io - { stat: function(file) }
 * @returns { { ok: boolean, problems: Array<{code: string, line: null, column: null, detail?: string}> } }
 */
function checkTaskContext(context, io = {}) {
  const problems = [];
  const stat = io.stat || fs.statSync;

  // Profile must be 'task' or 'pin'; an absent profile resolves to the task profile
  const profile = resolveProfile(context);
  if (profile !== TASK_PROFILE && profile !== PIN_PROFILE) {
    problems.push({ code: 'INVALID_PROFILE', line: null, column: null, detail: 'unknown lint profile' });
  }

  // Worktree must be an absolute existing directory
  if (context.worktree) {
    try {
      const worktreeStats = stat(context.worktree);
      if (!worktreeStats.isDirectory()) {
        problems.push({ code: 'INVALID_WORKTREE', line: null, column: null, detail: 'worktree is not a directory' });
      }
    } catch (e) {
      problems.push({ code: 'INVALID_WORKTREE', line: null, column: null, detail: `worktree does not exist or cannot be accessed: ${e.code || 'stat failed'}` });
    }
  }

  // Completion token must match pattern
  if (context.completion && !TOKEN_PATTERN.test(context.completion)) {
    problems.push({ code: 'INVALID_TOKEN', line: null, column: null, detail: `completion token must match ${TOKEN_PATTERN.toString()}` });
  }

  return { ok: problems.length === 0, problems };
}

/**
 * Lint a task text for problems
 * @param {string} text - The task text
 * @param {object} context - { profile, worktree, completion }
 * @returns { { ok: boolean, problems: Array<{code: string, line: number, column: number, detail?: string}> } }
 */
function lintTask(text, context = {}) {
  const problems = [];
  const lines = text.split('\n');
  const profile = resolveProfile(context);
  if (profile !== TASK_PROFILE && profile !== PIN_PROFILE) {
    return { ok: false, problems: [{ code: 'INVALID_PROFILE', line: null, column: null, detail: 'unknown lint profile' }] };
  }

  // Normalize line endings for checking (CRLF -> LF)
  const normalizedLines = lines.map(line => line.replace('\r', ''));
  const normalizedText = normalizedLines.join('\n');

  // Profile-specific checks
  if (profile === TASK_PROFILE) {
    // Check for angle brackets
    for (let i = 0; i < normalizedLines.length; i++) {
      const line = normalizedLines[i];
      if (ANGLE.test(line)) {
        const match = line.match(ANGLE);
        const column = line.indexOf(match[0]) + 1;
        problems.push({ code: 'ANGLE_BRACKET', line: i + 1, column, detail: 'angle bracket not allowed in task profile' });
      }
      // Check for ampersand entities
      if (ENTITY.test(line)) {
        const match = line.match(ENTITY);
        const column = line.indexOf(match[0]) + 1;
        problems.push({ code: 'AMPERSAND_ENTITY', line: i + 1, column, detail: 'ampersand entity not allowed in task profile' });
      }
    }

    // Check footer
    const footerProblems = checkFooter(normalizedLines, context.completion);
    problems.push(...footerProblems);

    // Check command fences
    const fenceProblems = checkCommandFences(normalizedLines);
    problems.push(...fenceProblems);

    // Check inline commands
    const inlineProblems = checkInlineCommands(normalizedLines);
    problems.push(...inlineProblems);
  } else if (profile === PIN_PROFILE) {
    // Pin profile: check for HTML and HTML references using unified pattern
    for (let i = 0; i < normalizedLines.length; i++) {
      const line = normalizedLines[i];
      const match = line.match(PIN_HTML);
      if (match) {
        const column = line.indexOf(match[0]) + 1;
        const isHtmlTag = match[0].startsWith('<');
        problems.push({ 
          code: isHtmlTag ? 'PIN_HTML' : 'PIN_HTML_REFERENCES', 
          line: i + 1, 
          column, 
          detail: isHtmlTag ? 'HTML tag not allowed in pin profile' : 'HTML entity reference not allowed in pin profile'
        });
      }
    }
  }

  // Pin files retain only the legacy HTML predicate, without task grammar.
  if (profile === TASK_PROFILE) {
    const asciiProblems = checkCommandZoneASCII(normalizedLines);
    problems.push(...asciiProblems);
    problems.push(...checkContinuations(normalizedLines));
  }

  // Deduplicate problems by code+line+column
  const seen = new Set();
  const uniqueProblems = [];
  for (const p of problems) {
    const key = `${p.code}:${p.line}:${p.column}`;
    if (!seen.has(key)) {
      seen.add(key);
      uniqueProblems.push(p);
    }
  }

  return { ok: uniqueProblems.length === 0, problems: uniqueProblems };
}

/**
 * Check footer: Task-End: TOKEN in column 1, last non-empty line
 * @param {Array<string>} lines 
 * @param {string} expectedToken 
 * @returns {Array<{code: string, line: number, column: number, detail?: string}>}
 */
function checkFooter(lines, expectedToken) {
  const problems = [];
  const layout = commandLayout(lines);
  const footers = lines.map((line, index) =>
    !layout.rows[index].fenced && /^Task-End:/.test(line) ? index : -1).filter(index => index >= 0);
  if (footers.length > 1) {
    problems.push({ code: 'DUPLICATE_FOOTER', line: footers[1] + 1, column: 1, detail: 'task footer must occur exactly once outside fences' });
  }
  
  // Find the last non-empty line
  let lastNonEmptyIndex = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i].trim() !== '') {
      lastNonEmptyIndex = i;
      break;
    }
  }

  if (lastNonEmptyIndex < 0) {
    problems.push({ code: 'MISSING_FOOTER', line: null, column: null, detail: 'no content in file' });
    return problems;
  }

  const lastLine = lines[lastNonEmptyIndex];
  
  // Footer must be in column 1
  if (layout.rows[lastNonEmptyIndex].fenced || !lastLine.startsWith('Task-End: ')) {
    problems.push({ code: 'MISSING_FOOTER', line: lastNonEmptyIndex + 1, column: 1, detail: 'file must end with "Task-End: TOKEN" in column 1' });
    return problems;
  }

  // Check if footer is properly formatted
  const footerMatch = lastLine.match(FOOTER_PATTERN);
  if (!footerMatch) {
    problems.push({ code: 'INVALID_FOOTER', line: lastNonEmptyIndex + 1, column: 1, detail: 'footer must be "Task-End: TOKEN" where TOKEN matches the pattern' });
    return problems;
  }

  const foundToken = footerMatch[1];
  
  // If expectedToken is provided, check it matches
  if (expectedToken && foundToken !== expectedToken) {
    problems.push({ code: 'WRONG_FOOTER_TOKEN', line: lastNonEmptyIndex + 1, column: 1, detail: 'footer does not match the expected completion token' });
  }

  return problems;
}

/**
 * Check command fences
 * @param {Array<string>} lines 
 * @returns {Array<{code: string, line: number, column: number, detail?: string}>}
 */
// One fence grammar supplies boundaries to every rule, including malformed
// fences. Recovery closes a malformed closing delimiter but still refuses it.
function commandLayout(lines) {
  const problems = [];
  const rows = [];
  let opening = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const delimiter = /^\s*(?:`{3,}|~{3,})/.test(line);
    rows.push({ fenced: opening !== null || delimiter, delimiter });
    if (!delimiter) continue;
    if (opening !== null) {
      if (line !== '```') {
        problems.push({ code: 'FENCE_MISMATCH', line: i + 1, column: 1, detail: 'closing fence must be exactly three backticks in column 1' });
      }
      opening = null;
      continue;
    }
    opening = i;
    const match = /^```([^\s`]*)$/.exec(line);
    if (!match) {
      problems.push({ code: 'INVALID_FENCE_FORMAT', line: i + 1, column: 1, detail: 'opening fence must be three backticks and one lowercase language in column 1' });
    } else if (!ALLOWED_FENCE_LANGUAGES.has(match[1])) {
      problems.push({ code: 'INVALID_FENCE_LANGUAGE', line: i + 1, column: 1, detail: 'command fence language is not allowed' });
    }
  }
  if (opening !== null) {
    problems.push({ code: 'UNCLOSED_FENCE', line: opening + 1, column: 1, detail: 'command fence has no closing delimiter' });
  }
  return { rows, problems };
}

function checkCommandFences(lines) {
  return commandLayout(lines).problems;
}

function inlineSpans(line) {
  const spans = [];
  const pattern = /`+/g;
  let match;
  while ((match = pattern.exec(line)) !== null) {
    const index = match.index;
    const ticks = match[0].length;
    const start = pattern.lastIndex;
    const close = pattern.exec(line);
    const content = line.slice(start, close ? close.index : line.length);
    const closed = Boolean(close && close[0].length === ticks);
    const executable = content.split(' ', 1)[0];
    spans.push({ index, end: close ? pattern.lastIndex : line.length, ticks, content, closed,
      command: ALLOWED_INLINE_EXECUTABLES.has(executable) && (closed || ticks > 1) });
    if (!close) break;
  }
  return spans;
}

/**
 * Check inline commands
 * @param {Array<string>} lines 
 * @returns {Array<{code: string, line: number, column: number, detail?: string}>}
 */
function checkInlineCommands(lines) {
  const problems = [];
  const { rows } = commandLayout(lines);
  for (let i = 0; i < lines.length; i++) {
    if (rows[i].fenced) continue;
    for (const span of inlineSpans(lines[i])) {
      if (span.command && (span.ticks !== 1 || !span.closed)) {
        problems.push({ code: 'INVALID_INLINE_FORMAT', line: i + 1, column: span.index + 1, detail: 'inline commands require exactly one backtick on each side' });
      }
    }
  }

  return problems;
}

/**
 * Check that command zones are ASCII only
 * @param {Array<string>} lines 
 * @returns {Array<{code: string, line: number, column: number, detail?: string}>}
 */
function checkCommandZoneASCII(lines) {
  const problems = [];
  const { rows } = commandLayout(lines);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const zones = rows[i].fenced || /^Command: /.test(line)
      ? [{ content: line, start: 0 }]
      : inlineSpans(line).filter(span => span.command).map(span => ({ content: span.content, start: span.index + span.ticks }));
    for (const zone of zones) {
      const index = zone.content.search(/[^\x00-\x7f]/);
      if (index >= 0) {
        problems.push({ code: 'NON_ASCII_IN_COMMAND', line: i + 1, column: zone.start + index + 1, detail: 'non-ASCII character in command zone' });
        break; // One diagnostic per line, including malformed/unclosed fences.
      }
    }
  }

  return problems;
}

function checkContinuations(lines) {
  const problems = [];
  const { rows } = commandLayout(lines);
  for (let i = 0; i < lines.length; i++) {
    if (rows[i].fenced) continue;
    const line = lines[i].trimEnd();
    if (!/[\\`^]$/.test(line)) continue;
    if (line.endsWith('`') && inlineSpans(line).some(span => span.closed && span.end === line.length)) continue;
    problems.push({ code: 'COMMAND_CONTINUATION', line: i + 1, column: line.length, detail: 'continuation outside a command fence is not allowed' });
  }
  return problems;
}

/**
 * Lint a task file
 * @param {string} file - Path to the file
 * @param {object} context - { profile, worktree, completion }
 * @param {object} io - { stat: function(file), readFile: function(file, encoding) }
 * @returns { { ok: boolean, problems: Array<{code: string, line: number|null, column: number|null, detail?: string}> } }
 */
function lintTaskFile(file, context = {}, io = {}) {
  const stat = io.stat || fs.statSync;
  const readFile = io.readFile || fs.readFileSync;

  // Check file exists and is a regular file
  let fileStats;
  try {
    fileStats = stat(file);
    if (!fileStats.isFile()) {
      return { ok: false, problems: [{ code: 'NOT_A_FILE', line: null, column: null, detail: `${file} is not a regular file` }] };
    }
  } catch (e) {
    return { ok: false, problems: [{ code: 'FILE_READ_ERROR', line: null, column: null, detail: `cannot read ${file}: ${e.code || 'stat failed'}` }] };
  }

  // Check file size
  if (fileStats.size > MAX_SIZE) {
    return { ok: false, problems: [{ code: 'FILE_TOO_LARGE', line: null, column: null, detail: `file size ${fileStats.size} exceeds maximum ${MAX_SIZE}` }] };
  }

  // Read file
  let bytes;
  try {
    bytes = readFile(file, null); // Read as Buffer
  } catch (e) {
    return { ok: false, problems: [{ code: 'FILE_READ_ERROR', line: null, column: null, detail: `cannot read ${file}: ${e.code || 'read failed'}` }] };
  }

  if (bytes.length > MAX_SIZE) {
    return { ok: false, problems: [{ code: 'FILE_TOO_LARGE', line: null, column: null, detail: 'file exceeds the maximum byte size' }] };
  }

  // Decode with text-safe - refuse BOM and CRLF, normalise CRLF, refuse invisible chars, report final newline
  const decodeResult = decode(bytes, { bom: 'refuse', crlf: 'refuse', invisible: 'refuse', finalNewline: 'report' });
  
  if (!decodeResult.ok) {
    // Convert text-safe problems to our format
    const problems = decodeResult.problems.map(p => ({
      code: `TEXT_SAFE_${p.code}`,
      line: p.line || null,
      column: p.column || null,
      detail: p.detail,
    }));
    return { ok: false, problems };
  }

  const text = decodeResult.text;
  
  // Lint the task text
  const lintResult = lintTask(text, context);
  
  // Combine problems
  const allProblems = [...lintResult.problems];
  
  return { ok: allProblems.length === 0, problems: allProblems };
}

module.exports = { lintTask, checkTaskContext, lintTaskFile, resolveProfile, TASK_PROFILE, PIN_PROFILE, TOKEN_PATTERN, FOOTER_PATTERN, MAX_SIZE };

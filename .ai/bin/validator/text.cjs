'use strict';

// P3 Node validator engine, text module (OT-05 section В5 steps 2 and 5).
// Implements CM-15..CM-19, CM-21, CM-22, CM-23, CM-24, CM-45 and
// CM-70 (encoding guard). CM-20 (PowerShell syntax check) lives in the
// platform module as a PowerShell subprocess: only PowerShell parses
// PowerShell (final-plan-2 section K). The module emits diagnostics through
// the caller's report() callback and never prints.
//
// Line counting has one owner (final-plan-2 section I): this module owns
// Get-LineCount semantics; the governance module consumes them later.

const fs = require('node:fs');
const path = require('node:path');
const { TEXT_EXTENSIONS } = require('./repository.cjs');

const strictUtf8 = new TextDecoder('utf-8', { fatal: true });

function isFile(full) {
  try { return fs.statSync(full).isFile(); } catch { return false; }
}

function extensionOf(relative) {
  return path.extname(relative);
}

// Get-LineCount: count of LF bytes, plus one when the text does not end in
// LF; zero for empty text.
function lineCount(text) {
  if (text.length === 0) return 0;
  let count = 0;
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) count++;
  }
  if (!text.endsWith('\n')) count++;
  return count;
}

// Read-ProtocolText: strict UTF-8 read; a failure is reported and yields null.
function readProtocolText(full, report) {
  try {
    return strictUtf8.decode(fs.readFileSync(full));
  } catch {
    report('CM-24', 'FAIL', `cannot read UTF-8 text: ${full}`);
    return null;
  }
}

// CM-15..CM-19: byte-level encoding checks for one protocol-owned text file.
// The check order matches the .ps1 loop exactly.
function inspectTextFile(full, relative, report) {
  const bytes = fs.readFileSync(full);
  if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) {
    report('CM-15', 'FAIL', `byte order mark present: ${relative}`, relative);
  }
  try {
    strictUtf8.decode(bytes);
  } catch {
    report('CM-16', 'FAIL', `invalid UTF-8: ${relative}`, relative);
  }
  if (bytes.includes(0)) {
    report('CM-17', 'FAIL', `NUL byte in text (possibly UTF-16): ${relative}`, relative);
  }
  if (bytes.includes(13)) {
    report('CM-18', 'FAIL', `CR/CRLF found; use LF line endings: ${relative}`, relative);
  }
  const extension = extensionOf(relative).toLowerCase();
  if (extension === '.ps1' || extension === '.psm1' || extension === '.psd1') {
    if (bytes.some(byte => byte > 127)) {
      report('CM-19', 'FAIL', `non-ASCII byte in PowerShell script: ${relative}`, relative);
    }
    // CM-20 runs in the platform module, batched into one PowerShell
    // subprocess per validation (final-plan-2 section K).
  }
}

// CM-21: inspection summary, always emitted, even for zero files.
function reportInspectionSummary(count, report) {
  report('CM-21', 'PASS',
    `inspected ${count} protocol-owned text files for UTF-8, BOM, LF and PowerShell syntax`);
}

// CM-22: journal count cap, WARN-first (PROTO-DEC-0057, PROTO-DEC-0037).
// Counted over the case-insensitively deduplicated path list, exactly like the
// .ps1 pipeline ($paths | Where ... | Sort-Object -Unique).
function checkJournalCap(paths, report) {
  const seen = new Set();
  let count = 0;
  for (const relative of paths) {
    const normalized = relative.split('\\').join('/');
    if (!/^\.ai\/worklog\/[^/]+\.md$/.test(normalized) ||
        caseInsensitiveEquals(normalized, '.ai/worklog/README.md')) continue;
    const key = normalized.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    count++;
  }
  if (count > 300) {
    report('CM-22', 'WARN', `${count} session journals in .ai/worklog (cap 300, ` +
      'PROTO-DEC-0057, WARN-first per PROTO-DEC-0037); archive completed sessions into .ai/ARCHIVE.md');
  }
}

function caseInsensitiveEquals(a, b) {
  return a === b || (typeof a === 'string' && typeof b === 'string' &&
    a.toLowerCase() === b.toLowerCase());
}

function escapeRegExp(value) {
  return value.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&');
}

// CM-23: active review corpus budget, role source only, WARN-first
// (AGENTS.md section 8, PROTO-DEC-0057, PROTO-DEC-0037). The walk excludes
// the archive/ subtree and never descends into or counts reparse points,
// symlinks and junctions. Unreadable directories are skipped silently. The KB
// figure rounds to one decimal, midpoint to even, and prints with the
// invariant decimal point. Porting note: the original .ps1 walked a queue,
// tested attribute bit 1024, applied [math]::Round(x, 1) and formatted with
// the current culture.
function checkReviewCorpusBudget(root, role, report) {
  if (!caseInsensitiveEquals(role, 'source')) return;
  const activeReviewsDir = path.join(root, 'docs', 'reviews');
  let activeStat;
  try { activeStat = fs.statSync(activeReviewsDir); } catch { return; }
  if (!activeStat.isDirectory()) return;
  let archiveFull = null;
  const archivePath = path.join(activeReviewsDir, 'archive');
  try { fs.statSync(archivePath); archiveFull = archivePath; } catch { archiveFull = null; }
  const archiveKey = archiveFull === null ? null : archiveFull.toLowerCase();
  let activeCount = 0;
  let activeBytes = 0;
  const queue = [activeReviewsDir];
  while (queue.length > 0) {
    const currentDir = queue.shift();
    let entries;
    try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(currentDir, entry.name);
      let isReparsePoint = false;
      try { isReparsePoint = fs.lstatSync(full).isSymbolicLink(); } catch { continue; }
      if (isReparsePoint) continue;
      if (entry.isDirectory()) {
        const lowered = full.toLowerCase();
        if (archiveKey !== null &&
            (lowered === archiveKey ||
             lowered.startsWith(archiveKey + path.sep) ||
             lowered.startsWith(archiveKey + '/'))) {
          continue;
        }
        queue.push(full);
      } else if (entry.isFile()) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { continue; }
        activeCount++;
        activeBytes += size;
      }
    }
  }
  if (activeCount > 400 || activeBytes > 8 * 1024 * 1024) {
    report('CM-23', 'WARN',
      `active docs/reviews/ exceeds budget (${activeCount} files / ${formatKilobytes(activeBytes)} KB; ` +
      'limit 400 files / 8192 KB, PROTO-DEC-0150); archive non-active reviews to docs/reviews/archive/');
  }
}

// [math]::Round($bytes / 1KB, 1): one decimal, .NET midpoint-to-even.
function formatKilobytes(bytes) {
  const scaled = (bytes / 1024) * 10;
  const floor = Math.floor(scaled);
  const diff = scaled - floor;
  let tenths;
  if (diff > 0.5) tenths = floor + 1;
  else if (diff < 0.5) tenths = floor;
  else tenths = floor % 2 === 0 ? floor : floor + 1;
  return String(tenths / 10);
}

// CM-45: a journal belongs to one session; an entry naming a different agent
// is a WARN, not a FAIL. The .ps1 enumerates with Get-ChildItem (no -Force, so
// hidden files are skipped - this port cannot read the DOS hidden attribute
// and assumes no hidden journals) in culture sort order; the line order is not
// a contract (CM-49).
function checkJournalAgentLines(root, report) {
  const directory = path.join(root, '.ai', 'worklog');
  let names;
  try { names = fs.readdirSync(directory); } catch { return; }
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    if (caseInsensitiveEquals(name, 'README.md')) continue;
    const full = path.join(directory, name);
    if (!isFile(full)) continue;
    const prefix = name.replace(/\.md$/i, '').split('-')[0];
    const body = readProtocolText(full, report);
    if (body === null) continue;
    const agentLine = /^Agent:[ \t]*(.+)$/m.exec(body);
    if (agentLine === null) continue;
    if (!new RegExp(escapeRegExp(prefix), 'i').test(agentLine[1])) {
      report('CM-45', 'WARN',
        `${name} holds an entry whose Agent line does not name ${prefix}`,
        '.ai/worklog/' + name);
    }
  }
}

// CM-24: line limits for .ai/TASK.md (80), .ai/PLAN.md (1000, PROTO-DEC-0150 item 3) and each journal
// (150). The .ps1 walks a hashtable; this port walks an insertion-ordered Map.
// The order of these per-file lines is not a contract (CM-49).
function checkLineLimits(root, paths, report) {
  const limits = new Map([['.ai/TASK.md', 80], ['.ai/PLAN.md', 1000]]);
  const seen = new Set();
  for (const relative of paths) {
    const normalized = relative.split('\\').join('/');
    if (/^\.ai\/worklog\/[^/]+\.md$/.test(normalized)) {
      const key = normalized.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        limits.set(normalized, 150);
      }
    }
  }
  for (const [relative, limit] of limits) {
    const full = path.join(root, relative);
    if (!isFile(full)) continue;
    const content = readProtocolText(full, report);
    if (content === null) continue;
    const count = lineCount(content);
    if (count > limit) {
      report('CM-24', 'FAIL', `${relative}: ${count} lines exceeds limit of ${limit}`, relative);
    } else {
      report('CM-24', 'PASS', `${relative}: ${count}/${limit} lines`, relative);
    }
  }
}

const ENCODING_GUARD_SCOPE = ['.ai/', 'docs/', 'patern/'];
const ENCODING_GUARD_SKIP = ['.ai/runtime/', 'node_modules/', '.git/'];
const ENCODING_GUARD_BOM_EXTENSIONS = new Set([...TEXT_EXTENSIONS, '.jsonl', '.markdown']);
const ENCODING_GUARD_MOJIBAKE_EXTENSIONS = new Set(['.md', '.txt', '.json', '.jsonl']);
const ENCODING_GUARD_REPORT_CAP = 20;

// UTF-8 bytes of fragments produced by reading UTF-8 Cyrillic as CP1251 and
// re-encoding as UTF-8. Escapes keep this source file free of mojibake bytes
// (PROTO-DEC-0153 item 6: no mojibake propagation).
const MOJIBAKE_BYTE_PATTERNS = [
  Buffer.from('\u0420\u00b5\u0420', 'utf8'), // U+0420 U+00B5 U+0420
  Buffer.from('\u0421\u0402\u0420', 'utf8'), // U+0421 U+0402 U+0420
  Buffer.from('\u0420\u0405\u0420', 'utf8'), // U+0420 U+0405 U+0420
  Buffer.from('\u0421\u201a\u0420', 'utf8'), // U+0421 U+201A U+0420
  Buffer.from('\u0432\u0402', 'utf8'),       // U+0432 U+0402
  Buffer.from('\u0420\u0454\u0420', 'utf8'), // U+0420 U+0454 U+0420
];

function loadEncodingAllowlist(root) {
  const full = path.join(root, '.ai', 'encoding-allowlist.txt');
  let content;
  try {
    content = strictUtf8.decode(fs.readFileSync(full));
  } catch {
    return [];
  }
  const entries = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    entries.push(line.split('\\').join('/').toLowerCase());
  }
  return entries;
}

function isEncodingAllowlisted(normalized, allowlist) {
  const lowered = normalized.toLowerCase();
  for (const entry of allowlist) {
    if (entry.endsWith('*')) {
      if (lowered.startsWith(entry.slice(0, -1))) return true;
    } else if (lowered === entry) {
      return true;
    }
  }
  return false;
}

function hasUtf16ByteOrderMark(bytes) {
  return bytes.length >= 2 &&
    ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
}

function hasMojibakeSignature(bytes) {
  for (const pattern of MOJIBAKE_BYTE_PATTERNS) {
    if (bytes.includes(pattern)) return true;
  }
  // 'C3 90' (U+00D0, eth) followed by a Cyrillic UTF-8 lead byte (D0/D1):
  // a Latin-1 reading of UTF-8 Cyrillic left next to intact Cyrillic text.
  for (let at = bytes.indexOf(0xc3); at !== -1 && at + 2 < bytes.length; at = bytes.indexOf(0xc3, at + 1)) {
    if (bytes[at + 1] === 0x90 && (bytes[at + 2] === 0xd0 || bytes[at + 2] === 0xd1)) return true;
  }
  return false;
}

// CM-70: trackedFiles comes from repository.listTrackedFiles (tracked only,
// NUL-delimited, one call). Zero hits emit nothing by design; the report is
// capped at ENCODING_GUARD_REPORT_CAP hit lines plus one '+N more' summary,
// and a hidden FAIL keeps its severity so the exit code stays truthful.
function checkEncodingGuard(root, trackedFiles, report) {
  if (!Array.isArray(trackedFiles) || trackedFiles.length === 0) return;
  const allowlist = loadEncodingAllowlist(root);
  const hits = [];
  for (const relative of trackedFiles) {
    const normalized = relative.split('\\').join('/');
    if (!ENCODING_GUARD_SCOPE.some(prefix => normalized.startsWith(prefix))) continue;
    if (ENCODING_GUARD_SKIP.some(prefix => normalized.startsWith(prefix))) continue;
    if (isEncodingAllowlisted(normalized, allowlist)) continue;
    const extension = extensionOf(normalized).toLowerCase();
    if (!ENCODING_GUARD_BOM_EXTENSIONS.has(extension)) continue;
    const full = path.join(root, relative);
    let stat;
    try { stat = fs.lstatSync(full); } catch { continue; }
    if (!stat.isFile() || stat.isSymbolicLink()) continue;
    let bytes;
    try { bytes = fs.readFileSync(full); } catch { continue; }
    if (hasUtf16ByteOrderMark(bytes)) {
      hits.push({ status: 'FAIL', message: `CM-70 UTF-16 BOM: ${normalized}`, path: normalized });
    }
    if (ENCODING_GUARD_MOJIBAKE_EXTENSIONS.has(extension) && hasMojibakeSignature(bytes)) {
      hits.push({ status: 'WARN', message: `CM-70 mojibake: ${normalized}`, path: normalized });
    }
  }
  for (const hit of hits.slice(0, ENCODING_GUARD_REPORT_CAP)) {
    report('CM-70', hit.status, hit.message, hit.path);
  }
  if (hits.length > ENCODING_GUARD_REPORT_CAP) {
    const hidden = hits.slice(ENCODING_GUARD_REPORT_CAP);
    const hiddenBom = hidden.some(hit => hit.status === 'FAIL');
    report('CM-70', hiddenBom ? 'FAIL' : 'WARN',
      `${hiddenBom ? 'CM-70 UTF-16 BOM' : 'CM-70 mojibake'}: +${hidden.length} more`);
  }
}

module.exports = {
  inspectTextFile,
  reportInspectionSummary,
  checkJournalCap,
  checkReviewCorpusBudget,
  checkLineLimits,
  checkJournalAgentLines,
  checkEncodingGuard,
  readProtocolText,
  lineCount,
};

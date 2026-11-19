'use strict';

// Node validator engine, text module.
// Implements CM-15..CM-19, CM-21, CM-22, CM-23, CM-24, CM-45 and
// CM-70 (encoding guard). CM-20 (PowerShell syntax check) lives in the
// platform module as a PowerShell subprocess: only PowerShell parses
// PowerShell. The module emits diagnostics through
// the caller's report() callback and never prints.
//
// Line counting has one owner: this module owns
// Get-LineCount semantics; the governance module consumes them later.

const fs = require('node:fs');
const path = require('node:path');
const textSafe = require('../lib/text-safe.cjs');
const pathSafe = require('../lib/path-safe.cjs');
const repository = require('./repository.cjs');

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
    // subprocess per validation.
  }
}

// CM-21: inspection summary, always emitted, even for zero files.
function reportInspectionSummary(count, report, options = {}) {
  report('CM-21', 'PASS',
    (options.platform || process.platform) === 'win32'
      ? `inspected ${count} protocol-owned text files for UTF-8, BOM, LF and PowerShell syntax`
      : `inspected ${count} protocol-owned text files for UTF-8, BOM and LF; PowerShell syntax is platform-specific`);
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
      'PROTO-DEC-0057, WARN-first per PROTO-DEC-0037); archive completed sessions into .ai/ARCHIVE.md with: '
      + 'node .ai/bin/protocol-archive.cjs journals --plan, then journals --execute --owner NAME under the shared-document lock');
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
// fails for new entries; historical mismatches remain WARN (no -Force).
// It skips hidden files; this port cannot read DOS hidden attributes and assumes no hidden journals.
// Culture sort order in the .ps1 is not a line-order contract (CM-49).
function checkJournalAgentLines(root, report, options = {}) {
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
    checkJournalEvidenceOwners(body, name, report);
    // Check every dated entry, including those after a valid first entry.
    // Agent prefixes are matched as whole tokens, never as substrings.
    // Fenced examples remain data rather than identity declarations.
    // Unchanged baseline mismatches retain their historical WARN policy.
    // A new mismatch fails when Git establishes the comparison baseline.
    // Evidence-owner warnings above keep their independent policy.
    checkJournalAgentEntries(root, body, name, prefix, report, options);
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

// A UTF-16 byte order mark (FF FE or FE FF) is a FAIL: tracked text is UTF-8
// without BOM. The strong UTF-8-read-as-CP1251 mojibake signatures below are
// a WARN: quarantined history stays visible without breaking the build.
// Allowlist: .ai/encoding-allowlist.txt, one repo-relative path per line,
// '#' comments, a trailing '*' matches any suffix.
// Known binary suffixes and a NUL in the first 8000 bytes exclude binary data.
// A UTF-16 BOM still identifies a text encoding violation rather than binary data.
// ENCODING_GUARD_SCOPE: all tracked formats except this explicit binary domain.
const ENCODING_BINARY_EXTENSIONS = new Set(['.jar', '.zip', '.png', '.jpg', '.jpeg', '.gif',
  '.ico', '.pdf', '.woff', '.woff2', '.ttf', '.otf', '.exe', '.dll', '.so', '.dylib',
  '.class', '.bin', '.db', '.sqlite', '.gz', '.tgz', '.7z', '.fig']);
const ENCODING_SIGNATURE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico',
  '.avif', '.bmp', '.tif', '.tiff', '.pdf', '.zip', '.gz', '.7z', '.tar', '.woff', '.woff2',
  '.ttf', '.otf', '.exe', '.dll', '.pdb', '.mp3', '.mp4', '.wav', '.ogg', '.wasm']);
const ENCODING_GUARD_MOJIBAKE_EXTENSIONS = new Set(['.md', '.txt', '.json', '.jsonl']);
const ENCODING_GUARD_REPORT_CAP = 20;

// Additional recognised media signatures retain their binary classification.
function isBinaryFormat(extension, bytes) {
  if (ENCODING_BINARY_EXTENSIONS.has(extension)) return true;
  if (!hasUtf16ByteOrderMark(bytes) && bytes.subarray(0, 8000).includes(0)) return true;
  if (!ENCODING_SIGNATURE_EXTENSIONS.has(extension)) return false;
  const starts = a => bytes.subarray(0, a.length).equals(Buffer.from(a));
  if (extension === '.png') return starts([137, 80, 78, 71, 13, 10, 26, 10]);
  if (['.jpg', '.jpeg'].includes(extension)) return starts([255, 216, 255]);
  if (extension === '.gif') return bytes.subarray(0, 6).toString('ascii') === 'GIF87a' || bytes.subarray(0, 6).toString('ascii') === 'GIF89a';
  if (['.webp', '.wav', '.avif'].includes(extension)) return (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && ['WEBP', 'WAVE'].includes(bytes.subarray(8, 12).toString('ascii'))) || bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  if (extension === '.pdf') return bytes.subarray(0, 5).toString('ascii') === '%PDF-';
  if (['.exe', '.dll'].includes(extension)) return bytes.subarray(0, 2).toString('ascii') === 'MZ';
  if (extension === '.zip') return starts([80, 75, 3, 4]) || starts([80, 75, 5, 6]);
  if (extension === '.gz') return starts([31, 139]);
  if (extension === '.7z') return starts([55, 122, 188, 175, 39, 28]);
  if (extension === '.wasm') return starts([0, 97, 115, 109]);
  if (extension === '.ico') return starts([0, 0, 1, 0]);
  if (['.woff', '.woff2', '.otf'].includes(extension)) return ['wOFF', 'wOF2', 'OTTO'].includes(bytes.subarray(0, 4).toString('ascii'));
  if (extension === '.ttf') return starts([0, 1, 0, 0]);
  if (extension === '.bmp') return bytes.subarray(0, 2).toString('ascii') === 'BM';
  if (['.tif', '.tiff'].includes(extension)) return starts([73, 73, 42, 0]) || starts([77, 77, 0, 42]);
  if (extension === '.ogg') return bytes.subarray(0, 4).toString('ascii') === 'OggS';
  if (extension === '.mp3') return bytes.subarray(0, 3).toString('ascii') === 'ID3' || (bytes[0] === 255 && (bytes[1] & 224) === 224);
  if (extension === '.mp4') return bytes.subarray(4, 8).toString('ascii') === 'ftyp';
  if (extension === '.pdb') return bytes.subarray(0, 9).toString('ascii') === 'Microsoft';
  if (extension === '.tar') return bytes.subarray(257, 262).toString('ascii') === 'ustar';
  return false;
}

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

function loadPathAllowlist(root, fileName) {
  const full = path.join(root, '.ai', fileName);
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

function loadEncodingAllowlist(root) {
  return loadPathAllowlist(root, 'encoding-allowlist.txt');
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
//
// Scope: repository.isBlockingEncodingScan decides
// which tracked files are blocking-scanned. In the installed role only
// protocol-owned files can FAIL; a host file is never failed (AGENTS.md
// section 11). Unreadable host paths and gitlinks yield one advisory WARN.
// Gitlinks are never opened, even in source/protocol scope, where a non-file
// still FAILs. Modes come from the same index enumeration as the paths.
// Decoder-note WARNs honour .ai/advisory-allowlist.txt (same grammar as the
// mojibake allowlist); that file never suppresses a FAIL or a mojibake line.
function checkEncodingGuard(root, trackedFiles, report, options = {}) {
  // An empty listing is unknown, never a silent pass. Only a caller that obtained it from a
  // successful git enumeration says so (knownEmpty); the result is then an explicit WARN.
  if (Array.isArray(trackedFiles) && trackedFiles.length === 0 && options.knownEmpty === true) {
    report('CM-70', 'WARN', 'CM-70 no tracked files; nothing to scan');
    return;
  }
  if (!Array.isArray(trackedFiles) || trackedFiles.length === 0) {
    report('CM-70', 'FAIL', 'CM-70 tracked text enumeration unavailable or empty');
    return;
  }
  const role = options.role === undefined ? null : String(options.role);
  const required = Array.isArray(options.required) ? options.required : [];
  const allowlist = options.rawWarnings ? [] : loadEncodingAllowlist(root);
  const advisoryAllowlist = options.rawWarnings ? [] : loadPathAllowlist(root, 'advisory-allowlist.txt');
  const hits = [];
  for (const relative of trackedFiles) {
    const normalized = relative.split('\\').join('/');
    const extension = extensionOf(normalized).toLowerCase();
    const blocking = repository.isBlockingEncodingScan(normalized, required, role);
    const unreadableStatus = blocking ? 'FAIL' : 'WARN';
    if (options.gitlinks && options.gitlinks.has(relative)) {
      hits.push({ status: unreadableStatus, message: blocking
        ? `CM-70 tracked text unreadable: ${normalized}`
        : `CM-70 host gitlink not scanned: ${normalized}`, path: normalized });
      continue;
    }
    const full = path.join(root, relative);
    const guarded = pathSafe.realInside(root, full, { refuseHardlinks: true });
    if (!guarded.ok || !guarded.exists || guarded.type !== 'file') {
      hits.push({ status: unreadableStatus, message: `CM-70 tracked text unreadable: ${normalized}`, path: normalized });
      continue;
    }
    let bytes;
    try { bytes = fs.readFileSync(guarded.real); } catch {
      hits.push({ status: unreadableStatus, message: `CM-70 tracked text unreadable: ${normalized}`, path: normalized });
      continue;
    }
    if (isBinaryFormat(extension, bytes)) continue;
    if (!blocking) {
      // Host file in the installed role: never failed. The single advisory the
      // package still claims for a host file is invalid UTF-8 (a decoding
      // error, not a style choice); BOM, CRLF and charset stay the host's.
      const hostDecoded = textSafe.decode(bytes);
      if (hostDecoded.problems.some(problem => problem.code === 'INVALID_UTF8')) {
        hits.push({ status: 'WARN', message: `CM-70 host text invalid UTF-8: ${normalized}`, path: normalized });
      }
      continue;
    }
    if (hasUtf16ByteOrderMark(bytes)) {
      hits.push({ status: 'FAIL', message: `CM-70 UTF-16 BOM: ${normalized}`, path: normalized });
    } else {
      const decoded = textSafe.decode(bytes);
      for (const problem of decoded.problems) {
        hits.push({ status: 'FAIL', message: `CM-70 ${problem.code}: ${normalized}`, path: normalized });
      }
      // Decoder notes are advisory, including invisible characters, non-NFC
      // and a missing final LF. Deduplicate by class per file; never print data.
      // The mojibake allowlist cannot conceal unrelated decoder diagnostics;
      // the advisory allowlist silences notes on declared test corpora only.
      if (!isEncodingAllowlisted(normalized, advisoryAllowlist)) {
        for (const code of new Set(decoded.notes.map(note => note.code))) {
          hits.push({ status: 'WARN', message: `CM-70 ${code}: ${normalized}`, path: normalized });
        }
      }
    }
    if (['.ps1', '.psm1', '.psd1'].includes(extension) && bytes.some(byte => byte > 127)) {
      hits.push({ status: 'FAIL', message: `CM-70 non-ASCII PowerShell: ${normalized}`, path: normalized });
    }
    if (!isEncodingAllowlisted(normalized, allowlist) && ENCODING_GUARD_MOJIBAKE_EXTENSIONS.has(extension) && hasMojibakeSignature(bytes)) {
      hits.push({ status: 'WARN', message: `CM-70 mojibake: ${normalized}`, path: normalized });
    }
  }
  const reportCap = options.reportCap === undefined ? ENCODING_GUARD_REPORT_CAP : options.reportCap;
  for (const hit of hits.slice(0, reportCap)) {
    report('CM-70', hit.status, hit.message, hit.path);
  }
  if (hits.length > reportCap) {
    const hidden = hits.slice(reportCap);
    const hiddenFailure = hidden.some(hit => hit.status === 'FAIL');
    const advisoryKind = hidden.every(hit => hit.message.startsWith('CM-70 mojibake:')) ? 'CM-70 mojibake' : 'CM-70 tracked text warnings';
    report('CM-70', hiddenFailure ? 'FAIL' : 'WARN',
      `${hiddenFailure ? 'CM-70 tracked text failures' : advisoryKind}: +${hidden.length} more`);
  }
}

// CM-78: the adversarial prompt and review report line caps of AGENTS.md section 2
// item 3 (prompts at most 150 lines, reports at most 250 lines, PROTO-DEC-0038
// item 3), source role only, WARN by default so existing history never breaks. A
// prompt is an .md or .markdown file of docs/reviews whose base name carries 'prompt';
// every other Markdown file there is a report. The walk is the CM-23 one: the archive/ subtree is
// excluded and reparse points are never descended. A recorded incident expansion is
// recognised by an entry in .ai/review-size-allowlist.txt (one repo-relative path per
// line, '#' comments, exact paths only; wildcards do not grant an expansion).
// The entry's comment names the incident. Diagnostics are
// deterministic: sorted by path.
function checkReviewFileCaps(root, role, report) {
  if (!caseInsensitiveEquals(role, 'source')) return;
  const activeReviewsDir = path.join(root, 'docs', 'reviews');
  let activeStat;
  try { activeStat = fs.statSync(activeReviewsDir); } catch { return; }
  if (!activeStat.isDirectory()) return;
  const allowlist = loadPathAllowlist(root, 'review-size-allowlist.txt');
  const archivePath = path.join(activeReviewsDir, 'archive');
  let archiveKey = null;
  try { fs.statSync(archivePath); archiveKey = archivePath.toLowerCase(); } catch { archiveKey = null; }
  const files = [];
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
      } else if (entry.isFile() && /\.(md|markdown)$/i.test(entry.name)) {
        files.push(full);
      }
    }
  }
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const full of files) {
    const relative = path.relative(root, full).split(path.sep).join('/');
    if (allowlist.includes(relative.toLowerCase())) continue;
    const content = readProtocolText(full, report);
    if (content === null) continue;
    const prompt = path.basename(full).toLowerCase().includes('prompt');
    const limit = prompt ? 150 : 250;
    const count = lineCount(content);
    if (count > limit) {
      report('CM-78', 'WARN',
        `${relative}: ${count} lines exceeds the ${prompt ? 'prompt' : 'report'} cap of ${limit} ` +
        '(AGENTS.md section 2 item 3, PROTO-DEC-0038 item 3; a recorded incident expansion is an entry in .ai/review-size-allowlist.txt)',
        relative);
    }
  }
}


module.exports = {
  inspectTextFile,
  reportInspectionSummary,
  checkJournalCap,
  checkReviewCorpusBudget,
  checkReviewFileCaps,
  checkLineLimits,
  checkJournalAgentLines,
  checkEncodingGuard,
  readProtocolText,
  lineCount,
};

// RULE-GATES audit hook: count CM-45 WARN diagnostics with this stable
// HANDOFF-EVIDENCE-OWNER prefix and path. Advisory only; no ledger dependency.
function checkJournalEvidenceOwners(body, name, report) {
  // Read through the one entry text model: a fenced example of the format names no recorder.
  const entryText = require('../lib/entry-text.cjs');
  const owner = name.replace(/\.md$/i, '');
  for (const section of entryText.datedSections(body)) {
    const block = entryText.parseEvidenceBlock(entryText.evidenceField(section));
    if (!block) continue;
    // An entry in the named state ambiguous (two own entry hash lines, a hash line outside its block, a receipt field
    // stated twice, a missing label) is reported by that state; its recorder lines are still each compared below.
    const reading = entryText.entryState(section);
    if (!reading.ok) {
      report('CM-45', 'WARN', `ENTRY-STATE-AMBIGUOUS: ${name} holds an entry in state ambiguous (${reading.code}: ${reading.reason})`,
        '.ai/worklog/' + name);
    }
    for (const recorder of block.recordedBy) {
      if (recorder !== owner) {
        report('CM-45', 'WARN',
          `HANDOFF-EVIDENCE-OWNER: ${name} holds Evidence recorded by ${recorder}, expected ${owner}`,
          '.ai/worklog/' + name);
      }
    }
  }
}

function checkJournalAgentEntries(root, body, name, prefix, report, options) {
  const entryText = require('../lib/entry-text.cjs');
  const entries = entryText.splitSections(body.replace(/\r\n/g, '\n'), /^## \d{4}-\d{2}-\d{2} /);
  let before = null;
  for (const section of entries) {
    const agents = [...journalFields(section).matchAll(/^Agent:[ \t]*(.+)$/gm)];
    if (!agents.length) continue;
    if (agents.length === 1 && new RegExp(`(?:^|[^A-Za-z0-9])${escapeRegExp(prefix)}(?:$|[^A-Za-z0-9])`, 'i').test(agents[0][1])) continue;
    if (before === null) {
      const { gitRead } = require('./git-hooks.cjs');
      const baseline = require('./governance.cjs').integrityBaseline(root);
      const got = gitRead(root, ['show', `${baseline.ref || 'HEAD'}:.ai/worklog/${name}`]);
      before = got.code === 0 ? entryText.splitSections(got.output.replace(/\r\n/g, '\n'), /^## \d{4}-\d{2}-\d{2} /) : [];
    }
    const oldIndex = before.indexOf(section);
    const historical = oldIndex !== -1;
    if (historical) before.splice(oldIndex, 1);
    report('CM-45', options.gitUsable && !historical ? 'FAIL' : 'WARN',
      `${name} holds an entry whose Agent line does not name ${prefix}${historical ? ' (historical)' : ''}`,
      '.ai/worklog/' + name);
  }
}

function journalFields(section) {
  return require('../lib/entry-text.cjs').fenceMask(section);
}

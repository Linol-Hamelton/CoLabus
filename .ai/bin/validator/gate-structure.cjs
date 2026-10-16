'use strict';

// P3 Node validator engine, gate-structure module (OT-05 section В5 step 3).
// Implements CM-34..CM-39 one to one, per the contract map:
//   CM-34 completion gate presence, CM-35 light-path selection (silent),
//   CM-36 light-path review checks, CM-37 strict-path prompt + review checks,
//   CM-38 cited-review scan, CM-39 gate-check invocation.
// The module emits diagnostics through the caller's report() callback and never
// prints, never mutates the working tree and keeps no global state
// (final-plan-2 section J). The entry owns check order and rendering.
//
// Porting notes, kept next to the code they concern:
// - The advisory/certifying header rules (A-1, F-005, F-008, P2 round 5) are
//   ported operation for operation: the linear comment/fence stripper, the
//   NBSP/emphasis/table-cell normalizer and the Mode declaration regexes keep
//   their .NET semantics (IgnoreCase where the .ps1 passes it).
// - The safe-path rule implements the contract directly: '..' substring
//   rejection (D-3 preserved), root containment and a reparse-point walk over
//   the existing segments (lstat treats junctions and symlinks as links on
//   Windows). Porting provenance: it mirrors Test-ProtocolSafePath from the
//   retired validate-protocol.ps1.
// - Cited reviews are deduplicated case-insensitively and sorted with the
//   locale comparer, approximating Sort-Object -Unique (culture sort).
// - The .ps1 reads $env:PROTOCOL_SKIP_GATE; this port reads the same process
//   environment (CM-49 environment dependence).

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const { readProtocolText } = require('./text.cjs');

function isFile(full) {
  try { return fs.statSync(full).isFile(); } catch { return false; }
}

function caseInsensitiveEquals(a, b) {
  return a === b || (typeof a === 'string' && typeof b === 'string' &&
    a.toLowerCase() === b.toLowerCase());
}

function runExternal(executable, args, root) {
  const result = spawnSync(executable, args, {
    cwd: root, windowsHide: true, encoding: 'buffer', maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) return { code: -1, output: '', error: String(result.error.message) };
  return {
    code: result.status,
    output: result.stdout ? result.stdout.toString('utf8') : '',
    error: result.stderr ? result.stderr.toString('utf8') : '',
  };
}

// Safe-path check (D-3): '..' rejection is substring-based.
function isProtocolSafePath(root, relative) {
  if (typeof relative !== 'string' || relative.trim().length === 0) return false;
  const normalized = relative.trim().split('\\').join('/');
  if (normalized.includes('..') || normalized.startsWith('/') ||
      /^[a-zA-Z]:/.test(normalized)) {
    return false;
  }
  try {
    const baseFull = path.resolve(root).replace(/[\\/]+$/, '');
    const targetFull = path.resolve(path.join(baseFull, normalized));
    if (!(targetFull.startsWith(baseFull + path.sep) || targetFull.startsWith(baseFull + '/') ||
          targetFull === baseFull)) {
      return false;
    }
    const relPortion = targetFull.slice(baseFull.length).replace(/^[\\/]+/, '');
    if (relPortion.length > 0) {
      const segments = relPortion.split(/[\\/]+/).filter(segment => segment.length > 0);
      let current = baseFull;
      for (const segment of segments) {
        current = path.join(current, segment);
        let stat;
        try { stat = fs.lstatSync(current); } catch (error) {
          if (error.code === 'ENOENT') continue;
          return false;
        }
        if (stat.isSymbolicLink()) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

// Get-GitBlobSha: SHA-1 of "blob <size>\0<content>".
function gitBlobSha(filePath) {
  if (!isFile(filePath)) return null;
  try {
    const content = fs.readFileSync(filePath);
    const header = Buffer.from('blob ' + content.length + '\0', 'utf8');
    return crypto.createHash('sha1').update(Buffer.concat([header, content])).digest('hex');
  } catch {
    return null;
  }
}

// Remove-ProtocolHeaderInvisible: linear pass removing HTML comments and fenced
// code blocks (F-008); an unterminated region swallows the rest, as in .NET.
function removeHeaderInvisible(text) {
  if (text === null || text.length === 0) return '';
  let out = '';
  let index = 0;
  while (index < text.length) {
    const commentStart = text.indexOf('<!--', index);
    const fenceStart = text.indexOf('```', index);
    const isComment = commentStart >= 0 && (fenceStart < 0 || commentStart < fenceStart);
    let cut;
    let after;
    let terminator;
    if (isComment) { cut = commentStart; after = 4; terminator = '-->'; }
    else if (fenceStart >= 0) { cut = fenceStart; after = 3; terminator = '```'; }
    else { out += text.slice(index); break; }
    out += text.slice(index, cut);
    const end = text.indexOf(terminator, cut + after);
    if (end < 0) break;
    index = end + terminator.length;
  }
  return out;
}

// Convert-ProtocolHeaderNormalized (P2 round 5): NBSP to space, comment
// delimiters to spaces, emphasis removed, and a Mode table cell rewritten as a
// plain "Mode: <value>" line (nearest non-empty neighbour when the cell itself
// is empty); any other cell of the row naming ADVISORY declares Mode as well.
function convertHeaderNormalized(headerRegion) {
  if (headerRegion === null || headerRegion.length === 0) return '';
  let text = headerRegion.split('\u00A0').join(' ');
  text = text.split('<!--').join(' ').split('-->').join(' ');
  text = text.replace(/[*_`]/g, '');
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.includes('|')) { out.push(line); continue; }
    const cells = line.split('|');
    let modeIndex = -1;
    let inCell = '';
    for (let index = 0; index < cells.length; index++) {
      const cellMatch = /^Mode(?![a-z0-9])[ \t]*:?[ \t]*(.*)$/i.exec(cells[index].trim());
      if (cellMatch) { modeIndex = index; inCell = cellMatch[1].trim(); break; }
    }
    if (modeIndex < 0) { out.push(line); continue; }
    if (inCell !== '') {
      out.push('Mode: ' + inCell);
    } else {
      let value = '';
      for (let index = modeIndex + 1; index < cells.length; index++) {
        const candidate = cells[index].trim();
        if (candidate !== '') { value = candidate; break; }
      }
      if (value === '') {
        for (let index = modeIndex - 1; index >= 0; index--) {
          const candidate = cells[index].trim();
          if (candidate !== '') { value = candidate; break; }
        }
      }
      out.push('Mode: ' + value);
    }
    for (let index = 0; index < cells.length; index++) {
      if (index === modeIndex) continue;
      const cell = cells[index].trim();
      if (cell !== '' && cell.toUpperCase().includes('ADVISORY')) {
        out.push('Mode: ' + cell);
      }
    }
  }
  return out.join('\n');
}

// Mode declaration, every form the A-1 line regex catches, IgnoreCase.
const MODE_DECLARATION =
  /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+|>[ \t]*)*[*_`]*Mode(?![a-z0-9])[*_`]*\s*:\s*([^\r\n]+)/gim;
const ADVISORY_MARKER = /\[[ \t*_`]*MODE[ \t*_`]*:[^\]]{0,80}ADVISORY[^\]]{0,80}\]?/im;
const REVIEWER_FIELD = /^[ \t]*(?:\*\*)?\bReviewer\b(?:\*\*)?\s*:\s*([^\r\n]+)/im;
const VERDICT_FIELD = /^[ \t]*(?:\*\*)?\bVerdict\b(?:\*\*)?\s*:\s*([^\r\n]+)/im;
const RECEIPT_FIELD =
  /^[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+|>[ \t]*)*[*_`]*(?:Receipt-Owner|Session)(?![a-z0-9-])[*_`]*[ \t]*:[ \t]*([^\r\n]*)/gim;
const TRANSCRIBED = /transcribed\s+(?:from\s+chat\s+)?by|transcription\s+fallback/i;
const PROMPT_IDENTITY = /(unified.{0,80}adversarial|adversarial.{0,80}unified).{0,80}prompt/is;

function normalizeModeValue(value) {
  return value.replace(/[*_` \t]/g, '').toUpperCase();
}

function markerReason(headerRegion) {
  const visible = removeHeaderInvisible(headerRegion);
  const marker = ADVISORY_MARKER.exec(visible);
  if (marker) return 'carries the advisory marker ' + marker[0].replace(/\s+/g, ' ').trim();
  return null;
}

// Get-ProtocolAdvisoryReason: ADVISORY in any Mode declaration, then the
// advisory marker; no whitelist, no Receipt-Owner requirement.
function advisoryReason(headerRegion) {
  if (headerRegion === null || headerRegion.length === 0) return null;
  for (const modeLine of convertHeaderNormalized(headerRegion).matchAll(MODE_DECLARATION)) {
    const value = modeLine[1];
    if (normalizeModeValue(value).includes('ADVISORY')) {
      return 'has Mode: ' + value.trim();
    }
  }
  return markerReason(headerRegion);
}

// Get-ProtocolCertifyingReason (Round-1 whitelist plus legacy boundary,
// ADV-007-2/FR-1). Returns a FAIL reason, a "WARN: ..." reason for files in the
// frozen legacy boundary manifest, or null when the review certifies.
function certifyingReason(headerRegion, relative, root, legacyBoundaryManifest) {
  if (headerRegion === null || headerRegion.length === 0) return null;

  let isLegacy = false;
  if (relative && legacyBoundaryManifest && legacyBoundaryManifest.boundary) {
    const normalizedPath = relative.split('\\').join('/');
    const currentBlobSha = gitBlobSha(path.join(root, relative));
    if (currentBlobSha) {
      for (const entry of legacyBoundaryManifest.boundary) {
        if (entry.path === normalizedPath && entry.blob === currentBlobSha) {
          isLegacy = true;
          break;
        }
      }
    }
  }

  // Marker check first, defence in depth (ADV-007-2).
  const marker = markerReason(headerRegion);
  if (marker) return marker;

  const modeLines = [...convertHeaderNormalized(headerRegion).matchAll(MODE_DECLARATION)];
  for (const modeLine of modeLines) {
    const value = modeLine[1];
    if (normalizeModeValue(value).includes('ADVISORY')) {
      return 'has Mode: ' + value.trim();
    }
  }

  // Reviewer and Verdict run on both WARN and non-WARN branches (FR-1).
  const reviewerMatch = REVIEWER_FIELD.exec(headerRegion);
  if (reviewerMatch === null || reviewerMatch[1].trim().length === 0) {
    return 'must name a Reviewer';
  }
  const verdictMatch = VERDICT_FIELD.exec(headerRegion);
  if (verdictMatch === null || verdictMatch[1].trim().length === 0) {
    return 'PASS or RECOMMENDATION';
  }
  const rawVerdict = verdictMatch[1].trim().toUpperCase();
  if (rawVerdict !== 'PASS' && rawVerdict !== 'RECOMMENDATION') {
    return 'PASS or RECOMMENDATION';
  }

  let hasReceipt = false;
  for (const receipt of headerRegion.matchAll(RECEIPT_FIELD)) {
    if (receipt[1].trim().length > 0) { hasReceipt = true; break; }
  }

  if (modeLines.length === 0) {
    if (isLegacy) return 'WARN: legacy review missing Mode: CERTIFYING';
    return 'declares no Mode';
  }
  if (modeLines.length > 1) return 'declares Mode ' + modeLines.length + ' times';
  const value = modeLines[0][1];
  if (normalizeModeValue(value) !== 'CERTIFYING') return 'has Mode: ' + value.trim();
  if (!hasReceipt) {
    if (isLegacy) return 'WARN: legacy review missing Receipt-Owner';
    return 'lacks a non-empty Receipt-Owner (or legacy Session)';
  }
  return null;
}

// Header region: up to the first '---' line, else the first '## ' heading; the
// whole file when neither appears, empty when the region ends at line zero.
function headerRegionOf(content) {
  const reviewLines = content.split(/\r?\n/);
  let headerEnd = -1;
  for (let index = 0; index < reviewLines.length; index++) {
    if (reviewLines[index].trim() === '---') { headerEnd = index; break; }
  }
  if (headerEnd === -1) {
    for (let index = 0; index < reviewLines.length; index++) {
      if (reviewLines[index].startsWith('## ')) { headerEnd = index; break; }
    }
  }
  if (headerEnd === -1) return content;
  if (headerEnd <= 0) return '';
  return reviewLines.slice(0, headerEnd).join('\n');
}

// Gate field value: trim, backslashes to forward slashes, drop a leading ./.
function normalizeGatePath(value) {
  return value.trim().split('\\').join('/').replace(/^\.\//, '');
}

// CM-34..CM-39: the completed-task gate block. task is the result of
// checkTaskStatus (null when its Status line was absent or ambiguous).
function checkCompletionGate(root, task, role, gitUsable, legacyBoundaryManifest, report) {
  if (task === null || !/^Completed(?:[ .;:-]|$)/i.test(task.status)) return;
  const gate = /^## Completion gate[ \t]*\r?\n(?<body>[\s\S]*?)(?=^## |(?![\s\S]))/ms.exec(task.text);
  if (gate === null) {
    report('CM-34', 'FAIL',
      'completed task requires a ## Completion gate section with an adversarial prompt and independent review');
    return;
  }
  const gateBody = gate.groups.body;
  const scopeField = /^[ \t]*- Scope:[ \t]*(\S+)[ \t]*$/m.exec(gateBody);
  const declaredScope = scopeField !== null ? scopeField[1].trim() : null;
  const baselineField = /^[ \t]*- Baseline:[ \t]*(\S+)[ \t]*$/m.exec(gateBody);
  const declaredBaseline = baselineField !== null ? baselineField[1].trim() : null;
  const promptField = /^[ \t]*- Adversarial review prompt:[ \t]*(\S+)[ \t]*$/m.exec(gateBody);
  const reviewField = /^[ \t]*- Independent review:[ \t]*(\S+)[ \t]*$/m.exec(gateBody);

  // CM-35: light-path selection (C40-01/02/05). Emits nothing; it only picks
  // the branch. Protected paths are checked on the raw set BEFORE the review
  // artifact is excluded, and the remainder must be non-empty and inside the
  // declared scope's allowlist.
  let isLightPath = false;
  let verifiedBaseline = null;
  if (declaredScope !== null &&
      (caseInsensitiveEquals(declaredScope, 'docs') || caseInsensitiveEquals(declaredScope, 'config')) &&
      declaredBaseline !== null && /^[0-9a-f]{40}$/i.test(declaredBaseline)) {
    if (gitUsable) {
      const revRes = runExternal('git', ['-C', root, 'rev-parse', '--verify', declaredBaseline + '^{commit}'], root);
      const ancRes = runExternal('git', ['-C', root, 'merge-base', '--is-ancestor', declaredBaseline, 'HEAD'], root);
      if (revRes.code === 0 && ancRes.code === 0) {
        const diffRes = runExternal('git', ['-C', root, 'diff', '--name-only', declaredBaseline], root);
        const untrackedRes = runExternal('git', ['-C', root, 'ls-files', '--others', '--exclude-standard'], root);
        if (diffRes.code === 0 && untrackedRes.code === 0) {
          const rawLines = [];
          if (diffRes.output) rawLines.push(...diffRes.output.split(/[\r\n]+/));
          if (untrackedRes.output) rawLines.push(...untrackedRes.output.split(/[\r\n]+/));
          const rawChanged = [];
          for (const line of rawLines) {
            const rel = line.trim().split('\\').join('/');
            if (!rel) continue;
            const lower = rel.toLowerCase();
            if (lower.startsWith('.ai/worklog/') || lower === '.ai/worklog') continue;
            if (lower.startsWith('.ai/runtime/') || lower === '.ai/runtime') continue;
            if (lower === '.ai/task.md') continue;
            if (!rawChanged.some(item => caseInsensitiveEquals(item, rel))) rawChanged.push(rel);
          }
          const rootProtectedFiles = ['AGENTS.md', 'CLAUDE.md', 'protocol-manifest.json',
            '.ai/bin/protocol-validate.cjs', '.ai/bin/protocol-setup.cjs'];
          const protectedPrefixes = ['.ai/', '.claude/', '.github/', '.codex/', 'tests/',
            'templates/', 'docs/decisions/'];
          const execExtensions = ['.ps1', '.psm1', '.cjs', '.mjs', '.js', '.ts', '.sh',
            '.bat', '.cmd', '.py'];
          let hasProtected = false;
          for (const changed of rawChanged) {
            if (rootProtectedFiles.some(item => caseInsensitiveEquals(item, changed))) {
              hasProtected = true;
              break;
            }
            if (protectedPrefixes.some(prefix => changed.startsWith(prefix))) {
              hasProtected = true;
              break;
            }
            const extension = path.extname(changed).toLowerCase();
            if (execExtensions.some(item => caseInsensitiveEquals(item, extension))) {
              hasProtected = true;
              break;
            }
          }
          if (!hasProtected) {
            const declaredReviewRel = reviewField !== null ? normalizeGatePath(reviewField[1]) : '';
            const remaining = [];
            for (const changed of rawChanged) {
              if (declaredReviewRel && caseInsensitiveEquals(changed, declaredReviewRel)) continue;
              remaining.push(changed);
            }
            if (remaining.length > 0) {
              let allMatch = true;
              if (caseInsensitiveEquals(declaredScope, 'docs')) {
                const docExtensions = ['.md', '.txt', '.rst'];
                for (const changed of remaining) {
                  if (caseInsensitiveEquals(changed, 'README.md') ||
                      caseInsensitiveEquals(changed, 'CHANGELOG.md')) continue;
                  if (changed.startsWith('docs/') && !changed.startsWith('docs/decisions/')) {
                    const extension = path.extname(changed).toLowerCase();
                    if (docExtensions.some(item => caseInsensitiveEquals(item, extension))) continue;
                  }
                  allMatch = false;
                  break;
                }
              } else if (caseInsensitiveEquals(declaredScope, 'config')) {
                const configAllowlist = ['.gitattributes', '.gitignore', '.editorconfig'];
                for (const changed of remaining) {
                  if (!configAllowlist.some(item => caseInsensitiveEquals(item, changed))) {
                    allMatch = false;
                    break;
                  }
                }
              } else {
                allMatch = false;
              }
              if (allMatch) {
                isLightPath = true;
                verifiedBaseline = declaredBaseline;
              }
            }
          }
        }
      }
    }
  }

  if (isLightPath) {
    // CM-36: light path needs the independent review only.
    if (reviewField === null) {
      report('CM-36', 'FAIL', 'completed task is missing its independent review field');
    } else {
      const relative = normalizeGatePath(reviewField[1]);
      if (!isProtocolSafePath(root, relative)) {
        report('CM-36', 'FAIL', `independent review must be a safe path inside the repository root: ${relative}`);
      } else if (caseInsensitiveEquals(role, 'source') && !relative.startsWith('docs/reviews/')) {
        report('CM-36', 'FAIL', `in source repository, independent review must be under docs/reviews/: ${relative}`);
      } else {
        const full = path.join(root, relative);
        if (!isFile(full)) {
          report('CM-36', 'FAIL', `completed task independent review is missing: ${relative}`);
        } else {
          const content = readProtocolText(full, report);
          if (content === null || content.trim().length === 0) {
            report('CM-36', 'FAIL', `completed task independent review must not be empty: ${relative}`);
          } else {
            const headerRegion = headerRegionOf(content);
            if (TRANSCRIBED.test(content)) {
              report('CM-36', 'FAIL',
                `independent review ${relative} is transcribed; transcribed reviews cannot satisfy the independent review gate`);
            } else {
              const reason = advisoryReason(headerRegion);
              if (reason) {
                report('CM-36', 'FAIL',
                  `independent review ${relative} ${reason}; advisory reviews cannot satisfy the independent review gate`);
              } else {
                const reviewer = REVIEWER_FIELD.exec(headerRegion);
                const verdict = VERDICT_FIELD.exec(headerRegion);
                if (reviewer === null) {
                  report('CM-36', 'FAIL', `independent review must name a Reviewer: ${relative}`);
                } else if (verdict === null) {
                  report('CM-36', 'FAIL', `independent review must have a PASS or RECOMMENDATION verdict: ${relative}`);
                } else {
                  const rawVerdict = verdict[1].trim().toUpperCase();
                  if (rawVerdict !== 'PASS' && rawVerdict !== 'RECOMMENDATION') {
                    report('CM-36', 'FAIL',
                      `independent review must have a PASS or RECOMMENDATION verdict: ${relative}`);
                  } else {
                    report('CM-36', 'PASS',
                      `independent review certified (light path: ${declaredScope}, ${verifiedBaseline}): ${relative}`);
                  }
                }
              }
            }
          }
        }
      }
    }
  } else {
    // CM-37: strict path. The prompt and the review are separate artifacts.
    const gateFiles = [
      { label: 'adversarial review prompt', match: promptField },
      { label: 'independent review', match: reviewField },
    ];
    const normPrompt = promptField !== null ? normalizeGatePath(promptField[1]) : '';
    const normReview = reviewField !== null ? normalizeGatePath(reviewField[1]) : '';
    if (promptField !== null && reviewField !== null && caseInsensitiveEquals(normPrompt, normReview)) {
      report('CM-37', 'FAIL', 'adversarial prompt and independent review must be separate artifacts');
    }
    for (const gateFile of gateFiles) {
      if (gateFile.match === null) {
        report('CM-37', 'FAIL', `completed task is missing its ${gateFile.label} field`);
        continue;
      }
      const relative = normalizeGatePath(gateFile.match[1]);
      if (!isProtocolSafePath(root, relative)) {
        report('CM-37', 'FAIL', `${gateFile.label} must be a safe path inside the repository root: ${relative}`);
        continue;
      }
      if (caseInsensitiveEquals(role, 'source') && !relative.startsWith('docs/reviews/')) {
        report('CM-37', 'FAIL', `in source repository, ${gateFile.label} must be under docs/reviews/: ${relative}`);
        continue;
      }
      const full = path.join(root, relative);
      if (!isFile(full)) {
        report('CM-37', 'FAIL', `completed task ${gateFile.label} is missing: ${relative}`);
        continue;
      }
      const content = readProtocolText(full, report);
      if (content === null || content.trim().length === 0) {
        report('CM-37', 'FAIL', `completed task ${gateFile.label} must not be empty: ${relative}`);
        continue;
      }
      if (gateFile.label === 'adversarial review prompt') {
        if (!PROMPT_IDENTITY.test(content)) {
          report('CM-37', 'FAIL',
            `${gateFile.label} must identify a unified adversarial audit prompt: ${relative}`);
        } else {
          report('CM-37', 'PASS', `completion gate prompt found: ${relative}`);
        }
      } else {
        const headerRegion = headerRegionOf(content);
        if (TRANSCRIBED.test(content)) {
          report('CM-37', 'FAIL',
            `independent review ${relative} is transcribed; transcribed reviews cannot satisfy the independent review gate`);
        } else {
          const reason = certifyingReason(headerRegion, relative, root, legacyBoundaryManifest);
          if (reason) {
            if (reason.startsWith('WARN:')) {
              report('CM-37', 'WARN', reason);
            } else {
              report('CM-37', 'FAIL',
                `independent review ${relative} ${reason}; advisory reviews cannot satisfy the independent review gate`);
            }
          } else {
            const reviewer = REVIEWER_FIELD.exec(headerRegion);
            const verdict = VERDICT_FIELD.exec(headerRegion);
            if (reviewer === null) {
              report('CM-37', 'FAIL', `independent review must name a Reviewer: ${relative}`);
            } else if (verdict === null) {
              report('CM-37', 'FAIL', `independent review must have a PASS or RECOMMENDATION verdict: ${relative}`);
            } else {
              const rawVerdict = verdict[1].trim().toUpperCase();
              if (rawVerdict !== 'PASS' && rawVerdict !== 'RECOMMENDATION') {
                report('CM-37', 'FAIL',
                  `independent review must have a PASS or RECOMMENDATION verdict: ${relative}`);
              } else {
                report('CM-37', 'PASS', `independent review certified: ${relative}`);
              }
            }
          }
        }
      }
    }
  }

  // CM-38: every review artifact cited anywhere in TASK must exist and be
  // non-empty.
  const citedReviews = [];
  const citedSeen = new Set();
  for (const match of task.text.matchAll(/docs\/reviews\/[a-z0-9._-]+\.md/gi)) {
    const value = match[0].split('\\').join('/');
    const key = value.toLowerCase();
    if (!citedSeen.has(key)) {
      citedSeen.add(key);
      citedReviews.push(value);
    }
  }
  citedReviews.sort((a, b) => a.localeCompare(b));
  for (const citedRelative of citedReviews) {
    const citedFull = path.join(root, citedRelative);
    if (!isFile(citedFull)) {
      report('CM-38', 'FAIL', `completed task cites missing review artifact: ${citedRelative}`);
    } else {
      const citedContent = readProtocolText(citedFull, report);
      if (citedContent === null || citedContent.trim().length === 0) {
        report('CM-38', 'FAIL', `completed task cites empty review artifact: ${citedRelative}`);
      }
    }
  }

  // CM-39: fresh gate-check through protocol-handoff.cjs, unless evidence
  // recording set the skip handshake (PROTO-DEC-0032 item 8).
  if (caseInsensitiveEquals(role, 'source')) {
    const nodeProbe = spawnSync('node', ['--version'], { windowsHide: true, encoding: 'utf8' });
    if (!nodeProbe.error) {
      if (process.env.PROTOCOL_SKIP_GATE === '1') {
        report('CM-39', 'PASS', 'gate-check skipped during evidence recording');
      } else {
        const gateScript = path.join(root, '.ai', 'bin', 'protocol-handoff.cjs');
        if (isFile(gateScript)) {
          const gateRes = runExternal('node', [gateScript, 'gate-check', '--root', root], root);
          if (gateRes.code !== 0) {
            const combined = (gateRes.error + '\n' + gateRes.output).trim();
            const nonEmpty = combined.split('\n').filter(line => line.trim().length > 0);
            let lastLine = nonEmpty.length > 0 ? nonEmpty[nonEmpty.length - 1] : '';
            if (!lastLine) lastLine = 'gate-check failed';
            const message = lastLine.trim().replace(/^(?:AI protocol:\s*)?(?:gate-check:\s*)?/, '');
            report('CM-39', 'FAIL', `gate-check: ${message}`);
          } else {
            report('CM-39', 'PASS', 'completion gate verified fresh by gate-check');
          }
        }
      }
    }
  }
}

module.exports = {
  checkCompletionGate,
};

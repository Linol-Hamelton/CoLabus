'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const hooks = require('../protocol-hooks.cjs');
const { DATE_HEADING_M_REGEX } = hooks;
const { anchor, git } = require('./snapshot.cjs');
const { checkOwnerReceipt } = require('./chain.cjs');

// Validates that a path is relative, stays strictly inside the repository root,
// contains no traversal ('..'), and resolves with no reparse point / symlink escape.
// Accept only relative paths strictly inside the root, without '..' or link escapes.
function isSafeInRoot(root, relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) return false;
  const clean = relPath.trim().replace(/\\/g, '/');
  if (clean.includes('..') || clean.startsWith('/') || path.isAbsolute(clean) || /^[a-zA-Z]:/.test(clean)) {
    return false;
  }
  const rootResolved = path.resolve(root);
  const fullResolved = path.resolve(rootResolved, clean);
  const rel = path.relative(rootResolved, fullResolved);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return false;
  }
  const relPortion = path.relative(rootResolved, fullResolved);
  if (relPortion && relPortion !== '.') {
    const segments = relPortion.split(/[/\\]+/).filter(Boolean);
    let current = rootResolved;
    for (const seg of segments) {
      current = path.join(current, seg);
      try {
        const st = fs.lstatSync(current);
        if (st.isSymbolicLink()) {
          return false;
        }
      } catch (err) {
        if (err.code !== 'ENOENT') {
          return false;
        }
      }
    }
  }
  if (fs.existsSync(fullResolved)) {
    try {
      const real = fs.realpathSync(fullResolved);
      const relReal = path.relative(fs.realpathSync(rootResolved), real);
      if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
        return false;
      }
    } catch (_) {
      return false;
    }
  }
  return true;
}

// FR-1: Compute git blob SHA for a file (SHA-1 of "blob <size>\0<content>")
function gitBlobSha(filePath) {
  try {
    const content = fs.readFileSync(filePath);
    const header = Buffer.from(`blob ${content.length}\0`, 'utf8');
    const blobContent = Buffer.concat([header, content]);
    return crypto.createHash('sha1').update(blobContent).digest('hex');
  } catch {
    return null;
  }
}

// FR-1: Check if a review file is in the legacy boundary manifest
function isLegacyBoundaryFile(root, filePath) {
  let manifestPath;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'protocol-manifest.json'), 'utf8'));
    if (manifest && typeof manifest === 'object' && !Array.isArray(manifest) && manifest.legacyBoundaryManifest) {
      manifestPath = path.join(root, manifest.legacyBoundaryManifest);
    }
  } catch {
    return false;
  }
  if (!manifestPath || !fs.existsSync(manifestPath)) {
    return false;
  }
  try {
    const boundaryManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!boundaryManifest || !Array.isArray(boundaryManifest.boundary)) {
      return false;
    }
    const normalizedPath = filePath.replace(/\\/g, '/');
    const currentBlobSha = gitBlobSha(path.join(root, filePath));
    if (!currentBlobSha) {
      return false;
    }
    for (const entry of boundaryManifest.boundary) {
      if (entry.path === normalizedPath && entry.blob === currentBlobSha) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

function gateCheck(root, options = {}) {
  const taskPath = path.join(root, '.ai', 'TASK.md');
  if (!fs.existsSync(taskPath)) {
    process.stderr.write('AI protocol: gate-check: .ai/TASK.md does not exist.\n');
    return 1;
  }
  const taskText = fs.readFileSync(taskPath, 'utf8');
  const statusMatch = taskText.match(/^Status:[ \t]*(\S.*)$/m);
  const taskStatus = statusMatch ? statusMatch[1].trim() : 'Unknown';

  if (!taskStatus.match(/^Completed(?:[ .;:-]|$)/i)) {
    process.stdout.write(`not applicable: task status is ${taskStatus}\n`);
    return 0;
  }

  let manifestRole = 'source';
  const manifestPath = path.join(root, 'protocol-manifest.json');
  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      if (manifest && typeof manifest === 'object' && !Array.isArray(manifest)) {
        manifestRole = Object.hasOwn(manifest, 'role') ? manifest.role : 'source';
      }
    } catch {
      // default to source
    }
  }

  const gateMatch = taskText.match(/(?:^|\n)## Completion gate[ \t]*\r?\n([\s\S]*?)(?=(?:\n## )|$)/);
  if (!gateMatch) {
    process.stderr.write('AI protocol: gate-check: completed task requires a ## Completion gate section.\n');
    return 1;
  }
  const gateBody = gateMatch[1];
  const scopeMatch = gateBody.match(/^[ \t]*-[ \t]+Scope:[ \t]*(\S+)[ \t]*$/m);
  const declaredScope = scopeMatch ? scopeMatch[1].trim() : null;
  const baselineMatch = gateBody.match(/^[ \t]*-[ \t]+Baseline:[ \t]*(\S+)[ \t]*$/m);
  const declaredBaseline = baselineMatch ? baselineMatch[1].trim() : null;
  const promptMatch = gateBody.match(/^[ \t]*-[ \t]+Adversarial review prompt:[ \t]*(\S+)[ \t]*$/m);
  const reviewMatch = gateBody.match(/^[ \t]*-[ \t]+Independent review:[ \t]*(\S+)[ \t]*$/m);

  let isLightPath = false;
  let verifiedBaseline = null;
  const promptRel = promptMatch ? promptMatch[1].replace(/\\/g, '/').replace(/^\.\//, '').trim() : null;
  const reviewRel = reviewMatch ? reviewMatch[1].replace(/\\/g, '/').replace(/^\.\//, '').trim() : null;

  if ((declaredScope === 'docs' || declaredScope === 'config') && declaredBaseline && /^[0-9a-f]{40}$/.test(declaredBaseline)) {
    let baselineCommit = null;
    try {
      const revRes = git(root, ['rev-parse', '--verify', `${declaredBaseline}^{commit}`]).trim();
      if (revRes) {
        git(root, ['merge-base', '--is-ancestor', declaredBaseline, 'HEAD']);
        baselineCommit = declaredBaseline;
      }
    } catch {
      baselineCommit = null;
    }

    if (baselineCommit) {
      let diffOut = null;
      let untrackedOut = null;
      try {
        diffOut = git(root, ['diff', '--name-only', baselineCommit]);
        untrackedOut = git(root, ['ls-files', '--others', '--exclude-standard']);
      } catch {
        diffOut = null;
      }

      if (diffOut !== null && untrackedOut !== null) {
        const rawList = diffOut.split(/\r?\n/).concat(untrackedOut.split(/\r?\n/));
        // Step 1: Raw changed set; exclude ONLY .ai/worklog/**, .ai/runtime/**, .ai/TASK.md.
        const rawChanged = new Set();
        for (const line of rawList) {
          const rel = line.replace(/\\/g, '/').trim();
          if (!rel) continue;
          if (rel.startsWith('.ai/worklog/') || rel === '.ai/worklog') continue;
          if (rel.startsWith('.ai/runtime/') || rel === '.ai/runtime') continue;
          if (rel === '.ai/TASK.md') continue;
          rawChanged.add(rel);
        }

        // Step 2: Protected path check on raw set before review exclusion.
        const rootProtectedFiles = new Set([
          'AGENTS.md',
          'CLAUDE.md',
          'protocol-manifest.json',
          '.ai/bin/protocol-validate.cjs',
          '.ai/bin/protocol-setup.cjs',
        ]);
        const protectedDirPrefixes = [
          '.ai/',
          '.claude/',
          '.github/',
          '.codex/',
          'tests/',
          'templates/',
          'docs/decisions/',
        ];
        const executableExtensions = new Set([
          '.ps1', '.psm1', '.cjs', '.mjs', '.js', '.ts', '.sh', '.bat', '.cmd', '.py',
        ]);

        function isProtectedPath(rel) {
          if (rootProtectedFiles.has(rel)) return true;
          for (const prefix of protectedDirPrefixes) {
            if (rel.startsWith(prefix)) return true;
          }
          const ext = path.extname(rel).toLowerCase();
          if (executableExtensions.has(ext)) return true;
          return false;
        }

        let hasProtected = false;
        for (const cf of rawChanged) {
          if (isProtectedPath(cf)) {
            hasProtected = true;
            break;
          }
        }

        if (!hasProtected) {
          // Step 3: Remove review artifact after protected check
          const remaining = new Set(rawChanged);
          if (reviewRel) {
            remaining.delete(reviewRel);
          }

          // Step 4: Empty remaining forces strict path
          if (remaining.size > 0) {
            let allMatch = true;
            if (declaredScope === 'docs') {
              const docExtensions = new Set(['.md', '.txt', '.rst']);
              for (const cf of remaining) {
                if (cf === 'README.md' || cf === 'CHANGELOG.md') {
                  continue;
                }
                if (cf.startsWith('docs/') && !cf.startsWith('docs/decisions/')) {
                  const ext = path.extname(cf).toLowerCase();
                  if (docExtensions.has(ext)) {
                    continue;
                  }
                }
                allMatch = false;
                break;
              }
            } else if (declaredScope === 'config') {
              const configAllowlist = new Set(['.gitattributes', '.gitignore', '.editorconfig']);
              for (const cf of remaining) {
                if (!configAllowlist.has(cf)) {
                  allMatch = false;
                  break;
                }
              }
            } else {
              allMatch = false;
            }

            if (allMatch) {
              isLightPath = true;
              verifiedBaseline = baselineCommit;
            }
          }
        }
      }
    }
  }

  if (isLightPath) {
    if (!reviewRel) {
      process.stderr.write('AI protocol: gate-check: completed task is missing its independent review field.\n');
      return 1;
    }
    if (!isSafeInRoot(root, reviewRel)) {
      process.stderr.write(`AI protocol: gate-check: independent review must be a safe path inside repository root: ${reviewRel}\n`);
      return 1;
    }
    if (manifestRole === 'source' && !reviewRel.startsWith('docs/reviews/')) {
      process.stderr.write(`AI protocol: gate-check: in source repository, independent review must be under docs/reviews/: ${reviewRel}\n`);
      return 1;
    }
    const full = path.join(root, reviewRel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      process.stderr.write(`AI protocol: gate-check: independent review file does not exist: ${reviewRel}\n`);
      return 1;
    }
    const reviewContent = fs.readFileSync(full, 'utf8');
    if (!reviewContent.trim()) {
      process.stderr.write(`AI protocol: gate-check: independent review file is empty: ${reviewRel}\n`);
      return 1;
    }

    const reviewLines = reviewContent.split(/\r?\n/);
    let headerEnd = -1;
    for (let i = 0; i < reviewLines.length; i++) {
      if (reviewLines[i].trim() === '---') {
        headerEnd = i;
        break;
      }
    }
    if (headerEnd === -1) {
      for (let i = 0; i < reviewLines.length; i++) {
        if (reviewLines[i].startsWith('## ')) {
          headerEnd = i;
          break;
        }
      }
    }
    const headerRegion = headerEnd === -1 ? reviewContent : reviewLines.slice(0, headerEnd).join('\n');

    const modeMatch = headerRegion.match(/^[ \t]*(?:\*\*)?\bMode\b(?:\*\*)?\s*:\s*([^\r\n]+)/im);
    const declaredMode = modeMatch ? modeMatch[1].trim() : null;
    if (declaredMode && declaredMode.toUpperCase() === 'ADVISORY') {
      process.stderr.write(`AI protocol: gate-check: independent review ${reviewRel} has Mode: ADVISORY; advisory reviews cannot satisfy the independent review gate.\n`);
      return 1;
    }
    if (/(?:transcribed\s+(?:from\s+chat\s+)?by|transcription\s+fallback)/i.test(reviewContent)) {
      process.stderr.write(`AI protocol: gate-check: independent review ${reviewRel} is transcribed; transcribed reviews cannot satisfy the independent review gate.\n`);
      return 1;
    }

    const reviewerMatch = headerRegion.match(/^[ \t]*(?:\*\*)?\bReviewer\b(?:\*\*)?\s*:\s*([^\r\n]+)/im);
    if (!reviewerMatch) {
      process.stderr.write(`AI protocol: gate-check: independent review ${reviewRel} is missing a Reviewer.\n`);
      return 1;
    }

    const verdictMatch = headerRegion.match(/^[ \t]*(?:\*\*)?\bVerdict\b(?:\*\*)?\s*:\s*([^\r\n]+)/im);
    if (!verdictMatch) {
      process.stderr.write(`AI protocol: gate-check: independent review ${reviewRel} is missing a Verdict.\n`);
      return 1;
    }
    const rawVerdict = verdictMatch[1].trim();
    const verdictToken = rawVerdict.toUpperCase();
    if (verdictToken !== 'PASS' && verdictToken !== 'RECOMMENDATION') {
      process.stderr.write(`AI protocol: gate-check: independent review ${reviewRel} verdict must be PASS or RECOMMENDATION, got ${rawVerdict}.\n`);
      return 1;
    }

    process.stdout.write(`completion gate verified (light path: ${declaredScope}, baseline: ${verifiedBaseline}): ${reviewRel}\n`);
    return 0;
  }

  if (!promptMatch) {
    process.stderr.write('AI protocol: gate-check: completed task is missing its adversarial review prompt field.\n');
    return 1;
  }
  if (!reviewMatch) {
    process.stderr.write('AI protocol: gate-check: completed task is missing its independent review field.\n');
    return 1;
  }

  if (promptRel === reviewRel) {
    process.stderr.write('AI protocol: gate-check: adversarial prompt and independent review must be separate artifacts.\n');
    return 1;
  }

  const gateFiles = [
    { label: 'adversarial review prompt', rel: promptRel },
    { label: 'independent review', rel: reviewRel },
  ];

  for (const item of gateFiles) {
    if (!isSafeInRoot(root, item.rel)) {
      process.stderr.write(`AI protocol: gate-check: ${item.label} must be a safe path inside repository root: ${item.rel}\n`);
      return 1;
    }
    if (manifestRole === 'source' && !item.rel.startsWith('docs/reviews/')) {
      process.stderr.write(`AI protocol: gate-check: in source repository, ${item.label} must be under docs/reviews/: ${item.rel}\n`);
      return 1;
    }
    const full = path.join(root, item.rel);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      process.stderr.write(`AI protocol: gate-check: ${item.label} file does not exist: ${item.rel}\n`);
      return 1;
    }
    const content = fs.readFileSync(full, 'utf8');
    if (!content.trim()) {
      process.stderr.write(`AI protocol: gate-check: ${item.label} file is empty: ${item.rel}\n`);
      return 1;
    }
  }



  const reviewContent = fs.readFileSync(path.join(root, reviewRel), 'utf8');

  // Define the header region deterministically: the text before the first line equal to '---';
  // if there is no such line, before the first '## ' heading; if neither exists, the whole file.
  const reviewLines = reviewContent.split(/\r?\n/);
  let headerEnd = -1;
  for (let i = 0; i < reviewLines.length; i++) {
    if (reviewLines[i].trim() === '---') {
      headerEnd = i;
      break;
    }
  }
  if (headerEnd === -1) {
    for (let i = 0; i < reviewLines.length; i++) {
      if (reviewLines[i].startsWith('## ')) {
        headerEnd = i;
        break;
      }
    }
  }
  const headerRegion = headerEnd === -1 ? reviewContent : reviewLines.slice(0, headerEnd).join('\n');

  // Date check: must have a valid ISO date in header
  const dateMatch = headerRegion.match(/^[ \t]*(?:\*\*)?\bDate\b(?:\*\*)?\s*:\s*([^\r\n]+)/im);
  if (!dateMatch || !dateMatch[1].trim()) {
    process.stderr.write(`AI protocol: gate-check: independent review ${reviewRel} is missing or has an invalid Date.\n`);
    return 1;
  }
  const dateStr = dateMatch[1].trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    process.stderr.write(`AI protocol: gate-check: independent review ${reviewRel} is missing or has an invalid Date.\n`);
    return 1;
  }

  // Mode: ADVISORY or transcribed reviews cannot satisfy independent slot
  const modeMatch = headerRegion.match(/^[ \t]*(?:\*\*)?\bMode\b(?:\*\*)?\s*:\s*([^\r\n]+)/im);
  const declaredMode = modeMatch ? modeMatch[1].trim() : null;
  if (declaredMode && declaredMode.toUpperCase() === 'ADVISORY') {
    process.stderr.write(`AI protocol: gate-check: independent review ${reviewRel} has Mode: ADVISORY; advisory reviews cannot satisfy the independent review gate.\n`);
    return 1;
  }
  if (/(?:transcribed\s+(?:from\s+chat\s+)?by|transcription\s+fallback)/i.test(reviewContent)) {
    process.stderr.write(`AI protocol: gate-check: independent review ${reviewRel} is transcribed; transcribed reviews cannot satisfy the independent review gate.\n`);
    return 1;
  }

  // Reviewer check: must name a Reviewer
  const reviewerMatch = headerRegion.match(/^[ \t]*(?:\*\*)?\bReviewer\b(?:\*\*)?\s*:\s*([^\r\n]+)/im);
  if (!reviewerMatch || !reviewerMatch[1].trim()) {
    process.stderr.write(`AI protocol: gate-check: independent review ${reviewRel} is missing a Reviewer.\n`);
    return 1;
  }

  // Verdict check: must be PASS or RECOMMENDATION
  const verdictMatch = headerRegion.match(/^[ \t]*(?:\*\*)?\bVerdict\b(?:\*\*)?\s*:\s*([^\r\n]+)/im);
  if (!verdictMatch) {
    process.stderr.write(`AI protocol: gate-check: independent review ${reviewRel} is missing a Verdict.\n`);
    return 1;
  }
  const rawVerdict = verdictMatch[1].trim();
  const verdictToken = rawVerdict.toUpperCase();
  if (verdictToken !== 'PASS' && verdictToken !== 'RECOMMENDATION') {
    process.stderr.write(`AI protocol: gate-check: independent review ${reviewRel} verdict must be PASS or RECOMMENDATION, got ${rawVerdict}.\n`);
    return 1;
  }

  // FR-1 fix: Legacy boundary determined by frozen manifest, not Date line
  // A review is legacy only when its normalized path AND the git blob SHA of its
  // current content match a boundary entry in the legacyBoundaryManifest.
  const isLegacy = isLegacyBoundaryFile(root, reviewRel);
  const isNew = !isLegacy;

  // Mode: CERTIFYING required for new reviews
  if (!declaredMode) {
    if (isNew) {
      process.stderr.write(`AI protocol: gate-check: independent review ${reviewRel} is missing Mode: CERTIFYING.\n`);
      return 1;
    }
    process.stdout.write(`[WARN] legacy review ${reviewRel} missing Mode: CERTIFYING\n`);
  } else if (declaredMode.toUpperCase() !== 'CERTIFYING') {
    process.stderr.write(`AI protocol: gate-check: independent review ${reviewRel} mode must be CERTIFYING, got ${declaredMode}.\n`);
    return 1;
  }

  // Receipt-Owner (Session fallback)
  const ownerMatch = headerRegion.match(/^[ \t]*(?:\*\*)?(?:\bReceipt-Owner\b|\bSession\b)(?:\*\*)?\s*:\s*([^\r\n]+)/im);
  const receiptOwner = ownerMatch ? ownerMatch[1].trim() : null;

  if (!receiptOwner) {
    if (isNew) {
      process.stderr.write(`AI protocol: gate-check: independent review ${reviewRel} is missing Receipt-Owner.\n`);
      return 1;
    }
    process.stdout.write(`[WARN] legacy review ${reviewRel} missing Receipt-Owner\n`);
  }

  // Receipt field is optional and informational only (empty is valid)
  const receiptMatch = headerRegion.match(/^[ \t]*(?:\*\*)?\bReceipt\b(?:\*\*)?\s*:\s*([^\r\n]*)/im);

  const state = options.state || anchor(root);

  // Candidate journals to check
  let candidateJournals = [];
  if (receiptOwner) {
    const ownerJournal = path.join(root, '.ai', 'worklog', `${receiptOwner}.md`);
    if (!fs.existsSync(ownerJournal)) {
      process.stderr.write(`AI protocol: gate-check: journal for Receipt-Owner "${receiptOwner}" not found: ${path.relative(root, ownerJournal)}.\n`);
      return 1;
    }
    candidateJournals.push({ owner: receiptOwner, journalPath: ownerJournal });
  } else {
    // Legacy without Receipt-Owner: scan .ai/worklog
    const worklogDir = path.join(root, '.ai', 'worklog');
    if (fs.existsSync(worklogDir)) {
      const files = fs.readdirSync(worklogDir).filter(f => f.endsWith('.md') && f !== 'README.md');
      for (const file of files) {
        candidateJournals.push({ owner: path.basename(file, '.md'), journalPath: path.join(worklogDir, file) });
      }
    }
  }

  if (candidateJournals.length === 0) {
    if (isLegacy && !receiptOwner) {
      process.stdout.write(`[WARN] legacy review ${reviewRel} has no session journals in .ai/worklog\n`);
      return 0;
    }
    process.stderr.write(`AI protocol: gate-check: no session journals available in .ai/worklog to verify review ${reviewRel}.\n`);
    return 1;
  }

  // Find a section that satisfies the binding
  let reviewPathFound = false;
  let evidenceFound = false;
  let lastFailureReason = null;
  let verifiedBinding = null;

  const normReviewRel = reviewRel.replace(/\\/g, '/');
  const escapedReviewRel = normReviewRel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const reviewPathRegex = new RegExp(escapedReviewRel + '(?![A-Za-z0-9._/-])');

  for (const cand of candidateJournals) {
    const journalText = fs.readFileSync(cand.journalPath, 'utf8');
    const norm = journalText.replace(/\r\n/g, '\n');
    const sections = norm.split(/(?=^## )/m);
    const datedSections = sections.filter(s => DATE_HEADING_M_REGEX.test(s));

    for (let i = 0; i < datedSections.length; i++) {
      const sectionText = datedSections[i];
      const normSection = sectionText.replace(/\\/g, '/');
      if (!reviewPathRegex.test(normSection)) {
        continue;
      }
      reviewPathFound = true;
      const evBody = hooks.entryField(sectionText.replace(/\n-{3,}\s*$/, '\n'), 'Evidence');
      if (!evBody) {
        lastFailureReason = 'entry has no Evidence block';
        continue;
      }
      evidenceFound = true;
      const checkRes = checkOwnerReceipt(root, cand.owner, {
        journalPath: cand.journalPath,
        sectionIndex: i,
        deep: true,
        allowLegacy: isLegacy,
        state,
      });
      if (checkRes.ok) {
        verifiedBinding = { owner: cand.owner, journalPath: cand.journalPath, sectionIndex: i };
        break;
      } else {
        lastFailureReason = checkRes.message;
      }
    }
    if (verifiedBinding) break;
  }

  if (verifiedBinding) {
    const relJournal = path.relative(root, verifiedBinding.journalPath);
    process.stdout.write(`completion gate verified: ${reviewRel} bound to ${relJournal} (section ${verifiedBinding.sectionIndex})\n`);
    return 0;
  }

  // Binding failed; provide distinguished error message
  const primaryOwner = receiptOwner || candidateJournals[0].owner;
  const primaryRel = path.relative(root, path.join(root, '.ai', 'worklog', `${primaryOwner}.md`));

  if (!reviewPathFound) {
    if (isLegacy && !receiptOwner) {
      process.stdout.write(`[WARN] legacy review ${reviewRel} not mentioned in any journal in .ai/worklog\n`);
      return 0;
    }
    process.stderr.write(`AI protocol: gate-check: journal ${primaryRel} does not mention independent review ${reviewRel}.\n`);
    return 1;
  }
  if (!evidenceFound) {
    process.stderr.write(`AI protocol: gate-check: journal ${primaryRel} entry mentioning ${reviewRel} has no Evidence block.\n`);
    return 1;
  }
  process.stderr.write(`AI protocol: gate-check: journal ${primaryRel} evidence failed verification: ${lastFailureReason || 'receipt does not verify'}.\n`);
  return 1;
}

module.exports = { gateCheck };

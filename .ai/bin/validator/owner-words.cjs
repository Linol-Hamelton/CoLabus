'use strict';

// CM-71: rule 20 (<word>@<branch>@<sha>) over the tracked owner-words journal of the owner.
// Contract: the owner-words rules R-20-1..R-20-3, defined in sections 2.1 and 4 of
// the owner-words contract; the artifact lint rows B-L14 and B-L16; and
// the sections 4-6 of
// docs/ops/OWNER-WORDS-JOURNAL.md.
//
// ADVISORY BY DESIGN. Every finding is WARN: this module never reports FAIL, never changes the
// validator exit code and closes no gate, until a separate owner word activates it
// (OWNER-WORDS R-20-3; PROTO-DEC-0168 item 3). The operator's manual
// rule-20 gate (R-20-2) stays binding whatever this check prints.
//
// Inputs are repository state only: the journal file under the root (default
// docs/ops/owner-words.md, or the owner-named path in protocol-manifest.json "ownerWordsJournal")
// and the local Git refs through `git rev-parse` / `git cat-file`. Never .ai/runtime (AGENTS
// section 1: not a source of truth; a manifest path under it is refused), never the network
// (no fetch; a branch absent from refs/heads and refs/remotes/origin is reported unresolved,
// never guessed).
//
// What it decides, per owner word (a `record` block carrying `word-id`):
//   - no addendum-ref, or one that does not resolve: finding (the journal is derived, R-OW-2);
//   - binding outside the one grammar of lib/artifacts.cjs parseBinding: finding (short or
//     malformed sha, no branch, unknown clause);
//   - standing: never compared with Git; no finding (R-BK-2);
//   - candidate: anchor sha != branch head is ALWAYS a divergence finding; it is reported VOID
//     only when the word itself carries the clause `void-on:registry-row`, the registry-row binding of
//     the void to the registry row (B-L14: both conditions, or divergence without void). The
//     registry `.ai/runtime/CANDIDATES.md` is never read here: the clause is the word's own
//     declaration, the registry comparison stays the manual gate;
//   - plan: anchor must be <sha256>@<commit> (B-L16 form) and the commit must exist locally; the
//     drift of the frozen artifact against its sha256 is deferred (the wire form names no
//     artifact path to hash).

const fs = require('node:fs');
const path = require('node:path');
const { runGit } = require('./repository.cjs');
const { fences, fieldMap, parseBinding } = require('../lib/artifacts.cjs');

const CHECK = 'CM-71';
const PREFIX = 'CM-71 rule 20 (advisory)';
const DEFAULT_JOURNAL = 'docs/ops/owner-words.md';
const SHA40 = /^[0-9a-f]{40}$/;

function isFile(full) {
  try { return fs.statSync(full).isFile(); } catch { return false; }
}

// A repository-relative POSIX path that stays inside the root: no absolute form, no
// backslash, no empty, `.` or `..` segment.
function safeRelative(relative) {
  if (typeof relative !== 'string' || relative === '' || path.isAbsolute(relative) || /\\/.test(relative)) return null;
  if (/^[A-Za-z]:/.test(relative)) return null;
  const segments = relative.split('/');
  if (segments.some(s => s === '' || s === '.' || s === '..')) return null;
  return relative;
}

function underRuntime(relative) {
  return relative === '.ai/runtime' || relative.startsWith('.ai/runtime/');
}

// Local refs only: the branch itself, then its origin tracking ref. No fetch, no network.
function resolveHead(root, branch) {
  for (const ref of [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`]) {
    const r = runGit(root, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]);
    const sha = r.output.trim();
    if (r.code === 0 && SHA40.test(sha)) return { ref, sha };
  }
  return null;
}

function commitExists(root, sha) {
  return runGit(root, ['cat-file', '-e', `${sha}^{commit}`]).code === 0;
}

function checkOwnerWords(root, state, report) {
  const { gitUsable, tracked, journal } = state;
  let relJournal = DEFAULT_JOURNAL;
  if (journal !== null && journal !== undefined) {
    const named = typeof journal === 'string' ? journal : '';
    if (underRuntime(named)) {
      report(CHECK, 'WARN', `${PREFIX}: ownerWordsJournal ${named} is under .ai/runtime, which is never an input (AGENTS section 1); the journal was not read`);
      return;
    }
    const safe = safeRelative(named);
    if (!safe) {
      report(CHECK, 'WARN', `${PREFIX}: ownerWordsJournal in protocol-manifest.json is not a safe repository-relative path: ${String(journal)}; the journal was not read`);
      return;
    }
    relJournal = safe;
  }
  const full = path.join(root, relJournal);
  if (!isFile(full)) {
    report(CHECK, 'PASS', `${PREFIX}: no owner-words journal at ${relJournal}; nothing to check`, relJournal);
    return;
  }
  if (!gitUsable) {
    report(CHECK, 'WARN', `${PREFIX}: ${relJournal} is present but Git is unusable; anchors were not compared`, relJournal);
    return;
  }
  const warn = (line, message) => report(CHECK, 'WARN', `${PREFIX}: ${relJournal}:${line}: ${message}`, relJournal);
  if (tracked && !tracked.includes(relJournal)) {
    report(CHECK, 'WARN', `${PREFIX}: ${relJournal} is not tracked by Git; the journal is a tracked append-only file (OWNER-WORDS R-OW-1)`, relJournal);
  }
  // The BOM strip uses the U+FEFF escape, never a literal U+FEFF byte in this
  // protocol source file (PROTO-DEC-0153 item 6; CM-70 ZERO_WIDTH).
  const text = fs.readFileSync(full, 'utf8').replace(/^\uFEFF/, '').replace(/\r\n/g, '\n');
  const { blocks, unclosed } = fences(text.split('\n'));
  const counts = { words: 0, divergence: 0, void: 0, malformed: 0, unresolved: 0 };
  if (unclosed && unclosed.info === 'record') {
    counts.malformed++;
    warn(unclosed.line, 'unclosed record block; the words after it were not read (fail-closed)');
  }
  for (const block of blocks) {
    if (block.info !== 'record') continue;
    const { fields } = fieldMap(block.content);
    if (!fields.has('word-id')) continue; // owner cards and other records are not words
    counts.words++;
    const line = block.line;
    const id = fields.get('word-id').value.trim() || `record at line ${line}`;

    const addendum = fields.get('addendum-ref');
    if (!addendum || addendum.value.trim() === '') {
      counts.malformed++;
      warn(line, `${id}: no addendum reference; a derived journal row without its Addendum is not a word (OWNER-WORDS R-OW-2, lint B-L12)`);
    } else {
      const target = addendum.value.trim().replace(/:\d+(-\d+)?$/, '');
      if (!safeRelative(target) || !isFile(path.join(root, target))) {
        counts.malformed++;
        warn(line, `${id}: addendum-ref does not resolve: ${addendum.value.trim()}`);
      }
    }

    const binding = fields.get('binding');
    if (!binding) {
      counts.malformed++;
      warn(line, `${id}: no binding; the kind of the word is unknown and never guessed (B-L13)`);
      continue;
    }
    const parsed = parseBinding(binding.value);
    if (parsed.errors.length) {
      counts.malformed++;
      for (const error of parsed.errors) warn(line, `${id}: malformed binding "${binding.value}": ${error}`);
      continue;
    }
    if (parsed.kind === 'standing') continue; // R-BK-2: Git movement never voids a standing word
    if (parsed.kind === 'plan') {
      if (parsed.planMalformed) {
        counts.malformed++;
        warn(line, `${id}: malformed binding "${binding.value}": ${parsed.planMalformed}`);
      } else if (!commitExists(root, parsed.sha)) {
        counts.unresolved++;
        warn(line, `${id}: publication commit ${parsed.sha} not found locally (B-L16); the frozen artifact cannot be compared`);
      }
      continue; // artifact drift against sha256 is deferred: the wire form names no artifact path
    }
    const head = resolveHead(root, parsed.branch);
    if (!head) {
      counts.unresolved++;
      warn(line, `${id}: anchor branch ${parsed.branch} not found locally (refs/heads, refs/remotes/origin); divergence cannot be judged`);
      continue;
    }
    if (head.sha === parsed.sha) continue;
    counts.divergence++;
    const where = `divergence, ${head.ref} is ${head.sha}, the word is anchored at ${parsed.sha}`;
    if (parsed.voidOn === 'registry-row') {
      counts.void++;
      warn(line, `${id}: ${where}; VOID by the word's own clause void-on:registry-row (B-L14) until the owner renews it`);
    } else {
      const why = parsed.voidOn ? `the clause void-on:${parsed.voidOn} is not bound to the registry row` : 'the word carries no void clause';
      warn(line, `${id}: ${where}; not void: ${why} (B-L14: void needs both the word's clause and the registry-row binding)`);
    }
  }
  report(CHECK, 'PASS', `${PREFIX}: inspected ${counts.words} owner words in ${relJournal}; divergences=${counts.divergence} void=${counts.void} malformed=${counts.malformed} unresolved=${counts.unresolved}`, relJournal);
}

module.exports = { checkOwnerWords, DEFAULT_JOURNAL };

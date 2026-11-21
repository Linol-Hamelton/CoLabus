'use strict';

// Node validator engine, governance module.
// Implements CM-30..CM-33 and CM-44 one to one with these contracts:
//   CM-30 decision block structure, CM-31 supersedes references,
//   CM-32 decision registry (WARN-first, role source), CM-33 task status,
//   CM-44 decision immutability vs HEAD.
// The module emits diagnostics through the caller's report() callback and never
// prints, never mutates the working tree and keeps no global state
// of its own. The entry owns check order and rendering.
//
// Porting notes, kept next to the code they concern:
// - .NET \d matches Unicode digits, the JS port matches ASCII digits only; the
//   decision corpus is ASCII, so the two agree on every conforming tree.
// - .NET TryParseExact('yyyy-MM-dd') requires a real calendar date; the port
//   validates the shape and round-trips the day count of the month.
// - PowerShell -eq/-match/-contains are case-insensitive, -ceq/-cnotmatch are
//   case-sensitive; each comparison below reproduces the operator it mirrors.
// - The registry coverage WARNs are ordered by code-unit sort of the decision
//   id. Porting note: the original .ps1 sorted them with Sort-Object (culture
//   sort); both agree on this corpus.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { readProtocolText } = require('./text.cjs');
const crypto = require('node:crypto');
const { gitRead } = require('./git-hooks.cjs');
const pathSafe = require('../lib/path-safe.cjs');

function isFile(full) {
  try { return fs.statSync(full).isFile(); } catch { return false; }
}

function caseInsensitiveEquals(a, b) {
  return a === b || (typeof a === 'string' && typeof b === 'string' &&
    a.toLowerCase() === b.toLowerCase());
}

function escapeRegExp(value) {
  return value.replace(/[$()*+.?[\\\]^{|}]/g, '\\$&');
}

// Invoke-External equivalent: UTF-8 captured streams, working directory root,
// code -1 when the process cannot start at all.
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

// [datetime]::TryParseExact 'yyyy-MM-dd' (InvariantCulture): exact shape plus a
// real calendar date (year >= 1).
function isValidStrictDate(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return day <= daysInMonth;
}

const PLACEHOLDER_APPROVER = /^(?:[_<{\[]|[-?]+$|(?:TBD|TODO|pending|unknown|none|n\/a|a human name|human name|your name)(?:\b|$))/i;

// Decision block pattern, byte-for-byte the .ps1 one modulo \z, which JS spells
// (?![\s\S]). The heading terminator is #{1,3} plus a space (preserved from the PowerShell validator).
const DECISION_BLOCK_PATTERN =
  /^### (?<id>(?:PROTO-)?DEC-(?<number>\d+))[^\r\n]*(?:\n|(?![\s\S]))(?<body>[\s\S]*?)(?=^#{1,3}[ \t]+|(?![\s\S]))/gms;

// CM-30/CM-31: block structure and supersedes references. Returns the parsed
// blocks and the seen-id set for the registry check, or null when the file is
// missing or unreadable (the .ps1 leaves $seen/$blocks $null then).
function checkDecisionBlocks(root, report) {
  const decisionPath = path.join(root, '.ai', 'DECISIONS.md');
  if (!isFile(decisionPath)) return null;
  const decisionText = readProtocolText(decisionPath, report);
  if (decisionText === null) return null;
  const seen = new Set();
  const blocks = [];
  const supersedeRefs = [];
  for (const block of decisionText.matchAll(DECISION_BLOCK_PATTERN)) {
    const id = block.groups.id;
    const body = block.groups.body;
    if (block.groups.number.length !== 4) {
      report('CM-30', 'FAIL', `${id} must use four digits`);
    }
    if (seen.has(id)) report('CM-30', 'FAIL', `duplicate decision: ${id}`);
    seen.add(id);
    // A Supersedes pointing at nothing makes the log unreadable (DEC-0013).
    for (const reference of body.matchAll(/^Supersedes:[ \t]*(.*)$/gm)) {
      for (const target of reference[1].matchAll(/(?:PROTO-)?DEC-\d{4}/g)) {
        supersedeRefs.push({ from: id, to: target[0] });
      }
    }
    const fields = {};
    for (const field of ['Status', 'Date', 'Approved by']) {
      const pattern = new RegExp('^' + escapeRegExp(field) + ':[ \\t]*(.*)$', 'gm');
      const values = [...body.matchAll(pattern)];
      if (values.length > 1) report('CM-30', 'FAIL', `${id} has duplicate ${field} fields`);
      fields[field] = values.length > 0 ? values[0][1].trim() : '';
    }
    const status = fields['Status'];
    if (!/^(Accepted|Superseded by (?:PROTO-)?DEC-\d{4})$/.test(status) &&
        !(caseInsensitiveEquals(id, 'DEC-0014') && caseInsensitiveEquals(status, 'Proposed'))) {
      report('CM-30', 'FAIL',
        `${id} has missing or invalid Status (Proposed is forbidden; drafts belong in PLAN.md)`);
    }
    if (!isValidStrictDate(fields['Date'])) {
      report('CM-30', 'FAIL', `${id} requires a valid Date: YYYY-MM-DD`);
    }
    if (caseInsensitiveEquals(status, 'Accepted') || /^Superseded by /i.test(status)) {
      const approver = fields['Approved by'];
      if (approver.trim().length === 0 || PLACEHOLDER_APPROVER.test(approver)) {
        report('CM-30', 'FAIL', `${id} requires a non-placeholder Approved by field`);
      }
    }
    blocks.push({ id, body });
  }
  if (blocks.length === 0) {
    report('CM-30', 'WARN', 'no numbered decisions recorded yet');
  } else {
    report('CM-30', 'PASS',
      `inspected ${blocks.length} decision blocks; approval text is not proof of human authorization`);
  }
  for (const reference of supersedeRefs) {
    if (!seen.has(reference.to)) {
      report('CM-31', 'FAIL', `${reference.from} supersedes ${reference.to}, which does not exist`);
    } else if (caseInsensitiveEquals(reference.to, reference.from)) {
      report('CM-31', 'FAIL', `${reference.from} supersedes itself`);
    }
  }
  return { seen, blocks };
}

// PowerShell -match is case-insensitive, so the .ps1 registry row and line
// patterns capture case-mutated ids (e.g. `| dec-0001 |`); the `i` flag keeps
// the port byte-compatible. Id set membership stays ordinal (Set), matching
// the .ps1 StringComparer::Ordinal sets, so a case-mutated id is still
// reported as both missing and unknown.
const REGISTRY_ROW_PATTERN =
  /^\s*\|\s*((?:PROTO-)?DEC-\d{4})\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]*)\|\s*([^|]*)\|\s*([^|]*)\|/i;
const REGISTRY_LINE_PATTERN = /^\s*\|\s*(?:PROTO-)?DEC-\d{4}\s*\|/i;
const HEAD_DECISION_ID_PATTERN = /^###\s+((?:PROTO-)?DEC-\d{4})/gm;
const VALID_TRIGGERS = ['invariant-broken', 'metric-drop', 'new-external-data',
  'security-finding', 'owner-directive', 'higher-source-contradiction', 'none'];

// CM-32: decision registry, WARN-first, role source only. decisions is the
// result of checkDecisionBlocks (null when that check did not run); an empty
// decisions corpus suppresses the coverage WARNs exactly like the .ps1
// `if ($seen)` on an empty dictionary.
function checkDecisionRegistry(root, role, gitUsable, decisions, report) {
  if (!caseInsensitiveEquals(role, 'source')) return;
  const registryRel = 'docs/decisions/REGISTRY.md';
  const registryPath = path.join(root, registryRel);
  if (!isFile(registryPath)) {
    report('CM-32', 'WARN',
      'docs/decisions/REGISTRY.md is missing; decision registry should track accepted/frozen status');
    return;
  }
  const registryText = readProtocolText(registryPath, report);
  if (registryText === null) return;
  const rows = [];
  for (const line of registryText.split(/\r?\n/)) {
    const row = REGISTRY_ROW_PATTERN.exec(line);
    if (row) rows.push({ id: row[1].trim() });
  }
  const regIds = [];
  for (const row of rows) {
    if (!regIds.includes(row.id)) regIds.push(row.id);
  }
  const regIdSet = new Set(regIds);

  if (decisions !== null && decisions.seen.size > 0) {
    for (const decId of [...decisions.seen.keys()].sort()) {
      if (!regIdSet.has(decId)) {
        report('CM-32', 'WARN', `decision registry missing entry for decision ${decId}`);
      }
    }
    for (const rid of [...regIds].sort()) {
      if (!decisions.seen.has(rid)) {
        report('CM-32', 'WARN',
          `decision registry contains unknown decision ${rid} not present in .ai/DECISIONS.md`);
      }
    }
  }

  if (gitUsable) {
    const headReg = runExternal('git', ['-C', root, 'show', 'HEAD:' + registryRel], root);
    if (headReg.code === 0 && headReg.output.trim().length > 0) {
      const headLines = headReg.output.split(/\r?\n/)
        .filter(line => REGISTRY_LINE_PATTERN.test(line)).map(line => line.trim());
      const currLines = registryText.split(/\r?\n/)
        .filter(line => REGISTRY_LINE_PATTERN.test(line)).map(line => line.trim());
      let immutableOk = true;
      for (let index = 0; index < headLines.length; index++) {
        if (index >= currLines.length || currLines[index] !== headLines[index]) {
          immutableOk = false;
          break;
        }
      }
      if (!immutableOk) {
        report('CM-32', 'WARN',
          'docs/decisions/REGISTRY.md modified or removed existing rows from HEAD; registry is append-only');
      }
    }
    const headDec = runExternal('git', ['-C', root, 'show', 'HEAD:.ai/DECISIONS.md'], root);
    if (headDec.code === 0 && headDec.output.trim().length > 0) {
      // PowerShell hashtables are case-insensitive; the port compares lowered ids.
      const headDecSet = new Set([...headDec.output.matchAll(HEAD_DECISION_ID_PATTERN)]
        .map(match => match[1].toLowerCase()));
      if (decisions !== null && decisions.blocks.length > 0) {
        for (const block of decisions.blocks) {
          if (!headDecSet.has(block.id.toLowerCase())) {
            const trigger = /^Reopen-trigger:[ \t]*(.*)$/m.exec(block.body);
            if (trigger === null || trigger[1].trim().length === 0) {
              report('CM-32', 'WARN', `new decision block ${block.id} missing Reopen-trigger field`);
            } else {
              const value = trigger[1].trim().toLowerCase();
              if (!VALID_TRIGGERS.includes(value)) {
                report('CM-32', 'WARN', `new decision block ${block.id} has unknown Reopen-trigger: ${value}`);
              }
            }
          }
        }
      }
    }
  }
  report('CM-32', 'PASS', `inspected decision registry with ${rows.length} entries`);
}

// CM-33: task status. Returns the status and the whole task text for the
// completion-gate check, or null when the file is missing/unreadable or the
// Status line count is wrong (taskStatus stays unset in the .ps1 then).
function checkTaskStatus(root, report) {
  const taskPath = path.join(root, '.ai', 'TASK.md');
  if (!isFile(taskPath)) return null;
  const taskText = readProtocolText(taskPath, report);
  if (taskText === null) return null;
  const statuses = [...taskText.matchAll(/^Status:[ \t]*(.*)$/gm)];
  if (statuses.length !== 1) {
    report('CM-33', 'FAIL', '.ai/TASK.md requires exactly one Status line');
    return null;
  }
  const taskStatus = statuses[0][1].trim();
  if (/^No active task(?:[ .;:-]|$)/i.test(taskStatus)) {
    report('CM-33', 'WARN', 'no active task; owner supplies the next objective');
  } else if (/^(In progress|Active|Completed|Blocked|Planned|Pending|Ready)(?:[ .;:-]|$)/i.test(taskStatus)) {
    report('CM-33', 'PASS', `task status: ${taskStatus}`);
  } else {
    report('CM-33', 'FAIL',
      '.ai/TASK.md has an invalid Status; use In progress, Completed, Blocked, Planned or No active task');
  }
  return { status: taskStatus, text: taskText };
}

// CM-44: a written decision block is never edited again (DEC-0021). The
// committed .ai/DECISIONS.md from HEAD is compared block by block under the
// same tail normalisation the .ps1 applies (CRLF to LF, trailing separator
// and blank lines stripped), including the .ps1's raw-tail special case for
// the last committed block. PowerShell hashtables are case-insensitive, so
// block keys are lowered; ids print in their original case. The changed and
// deleted FAIL lines follow .NET hashtable enumeration order in the .ps1 and
// Map insertion order here; that order is not a contract (CM-49). The file is
// read again here without a second diagnostic: the .ps1 reuses its earlier
// $decisionText, and an unreadable file already failed once at the CM-30
// read; a null read parses as no blocks, exactly like the .ps1's $null.
const IMMUTABILITY_BLOCK_PATTERN =
  /^### (?<id>(?:PROTO-)?DEC-(?<number>\d{4}))(?<headingSuffix>[^\r\n]*)(?:\n|(?![\s\S]))(?<body>[\s\S]*?)(?=^#{1,3}[ \t]+|(?![\s\S]))/gm;

const strictUtf8Decoder = new TextDecoder('utf-8', { fatal: true });

function readRawText(full) {
  try {
    return strictUtf8Decoder.decode(fs.readFileSync(full));
  } catch {
    return null;
  }
}

function stripImmutabilityTail(raw) {
  return raw.replace(/(?:\r?\n)+---\s*$/, '').replace(/(?:\r?\n)+$/, '');
}

function parseImmutabilityBlocks(text) {
  const normalized = text.split('\r\n').join('\n');
  const blocks = new Map();
  const rawBodies = new Map();
  let lastId = null;
  let lastKey = null;
  for (const match of normalized.matchAll(IMMUTABILITY_BLOCK_PATTERN)) {
    const id = match.groups.id;
    const key = id.toLowerCase();
    lastId = id;
    lastKey = key;
    rawBodies.set(key, match.groups.body);
    blocks.set(key, {
      id,
      value: match.groups.headingSuffix + '\n' + stripImmutabilityTail(match.groups.body),
    });
  }
  return { blocks, rawBodies, lastId, lastKey };
}

function checkDecisionImmutability(root, gitUsable, report) {
  const decisionPath = path.join(root, '.ai', 'DECISIONS.md');
  if (!gitUsable || !isFile(decisionPath)) return;
  const committed = runExternal('git', ['-C', root, 'show', 'HEAD:.ai/DECISIONS.md'], root);
  if (committed.code !== 0) {
    report('CM-44', 'WARN',
      'no committed .ai/DECISIONS.md to compare against; immutability guarantee is OFF until .ai/ is committed to Git (run: git add .ai && git commit)');
    return;
  }
  const before = parseImmutabilityBlocks(committed.output);
  const currentText = readRawText(decisionPath);
  const current = parseImmutabilityBlocks(currentText === null ? '' : currentText);
  const changed = [];
  const deleted = [];
  for (const [key, entry] of before.blocks) {
    const currentEntry = current.blocks.get(key);
    if (currentEntry === undefined) {
      deleted.push(entry.id);
    } else if (currentEntry.value !== entry.value) {
      changed.push(entry.id);
    }
  }
  if (changed.length === 0 && deleted.length === 0 && before.lastId !== null &&
      current.blocks.size === before.blocks.size) {
    const currentRaw = current.rawBodies.get(before.lastKey);
    const beforeRaw = before.rawBodies.get(before.lastKey);
    if (currentRaw !== beforeRaw) {
      if (currentRaw !== undefined && /(?:\r?\n)+---\s*$/.test(currentRaw)) {
        if (stripImmutabilityTail(currentRaw) !== stripImmutabilityTail(beforeRaw)) {
          changed.push(before.lastId);
        }
      } else {
        changed.push(before.lastId);
      }
    }
  }
  if (changed.length === 0 && deleted.length === 0) {
    report('CM-44', 'PASS', `${before.blocks.size} committed decision blocks are unchanged`);
  } else {
    for (const id of changed) {
      report('CM-44', 'FAIL', `${id} was edited after it was written; a decision block is never rewritten`);
    }
    for (const id of deleted) {
      report('CM-44', 'FAIL', `${id} was deleted; a decision block is never removed`);
    }
  }
}

module.exports = {
  checkDecisionBlocks,
  checkDecisionRegistry,
  checkTaskStatus,
  checkDecisionImmutability,
  checkSharedDocuments,
  checkDecisionIntegrity,
  decisionHashes,
  integrityBaseline,
};

const INTEGRITY_MARKER = /^<!-- decision-integrity: v1 baseline=([a-f0-9]{40,64}) -->$/gm;
const REGISTRY_REL = path.join('docs', 'decisions', 'REGISTRY.md');
// The provenance baseline is a decision number with the pinned hashes of every
// block up to it: membership in that list, never an unused decision number,
// determines which protocol blocks predate structured provenance.
const LEGACY = require('./decision-legacy.cjs');

// The listed blocks bind only the decision log that holds the baseline block;
// another log keeps the snapshot of its own integrity baseline.
function legacyMigration(hashes, legacy) {
  if (!hashes.has(legacy.baseline.toLowerCase())) return null;
  return new Map(Object.entries(legacy.blocks).map(([key, sha256]) => [key, { id: key.toUpperCase(), sha256 }]));
}

function guardedText(root, relative) {
  const got = pathSafe.readFileGuarded(root, path.join(root, relative), { refuseHardlinks: true });
  return got.ok ? new TextDecoder('utf-8', { fatal: true }).decode(got.bytes) : null;
}

// One immutable baseline makes grandfathering stable after a new commit. The
// registry opts in by appending a marker; old six-column rows are never edited.
function integrityBaseline(root) {
  let registry;
  try { registry = guardedText(root, REGISTRY_REL); } catch { return { active: false, ref: 'HEAD' }; }
  const markers = [...(registry || '').matchAll(INTEGRITY_MARKER)];
  if (!markers.length) return { active: false, ref: 'HEAD', registry };
  if (markers.length !== 1) return { active: true, invalid: true, registry };
  return { active: true, ref: markers[0][1], registry };
}

// Canonical bytes: full heading plus the existing immutability-normalized body,
// LF endings and one final LF. Internal separators and all content remain bound.
function decisionHashes(body) {
  const parsed = parseImmutabilityBlocks(body);
  return new Map([...parsed.blocks].map(([key, entry]) => [key, {
    id: entry.id,
    sha256: crypto.createHash('sha256').update(`### ${entry.id}${entry.value}\n`, 'utf8').digest('hex'),
  }]));
}

// CM-81: a diff is an observable fact; a transient lock is not a lock history.
function checkSharedDocuments(root, gitUsable, report) {
  if (!gitUsable) return;
  for (const relative of ['.ai/TASK.md', '.ai/PLAN.md', '.ai/DECISIONS.md']) {
    const got = gitRead(root, ['diff', '--no-ext-diff', '--quiet', 'HEAD', '--', relative]);
    if (got.code === 1) report('CM-81', 'WARN',
      `SHARED-DOCUMENT-DIFF: ${relative} differs from HEAD; lock history is unavailable, verify cooperative lock use`, relative);
    else if (got.code !== 0) report('CM-81', 'WARN', `SHARED-DOCUMENT-UNAVAILABLE: cannot compare ${relative}`, relative);
  }
}

// A decision block after the baseline may instead carry the provenance record
// "source; date; channel; who transcribed"; data and commit approvals never can.
const PROVENANCE_RECORD = '[^;\\s][^;\\n]*?;[ \\t]*\\d{4}-\\d{2}-\\d{2};[ \\t]*[^;\\s][^;\\n]*?;[ \\t]*[^;\\s][^;\\n]*?';
const PROVENANCE_LINE = new RegExp(`^Provenance:[ \\t]*(decision:((?:PROTO-)?DEC-\\d{4})|session:([a-z][a-z0-9]*-[a-z0-9-]+)|(${PROVENANCE_RECORD}))[ \\t]*$`, 'gm');

// The date field of a record is a real calendar day (2026-02-30 and 2026-99-99 are not).
function calendarDate(record) {
  const m = /;[ \t]*(\d{4})-(\d{2})-(\d{2});/.exec(record);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])], day = new Date(Date.UTC(y, mo - 1, d));
  return day.getUTCFullYear() === y && day.getUTCMonth() === mo - 1 && day.getUTCDate() === d;
}

function provenanceValid(root, text, ownId, priorIds) {
  const notes = [...unfencedText(text).matchAll(PROVENANCE_LINE)];
  if (notes.length !== 1) return false;
  const [, , decision, session, record] = notes[0];
  if (record) return ownId !== null && calendarDate(record);
  if (decision) return decision !== ownId && priorIds.has(decision);
  let journal;
  try { journal = guardedText(root, path.join('.ai', 'worklog', `${session}.md`)); } catch { return false; }
  // The reference proves an operator-session artifact exists, not human intent.
  return Boolean(journal && /^Agent:[^\n]*(?:\boperator\b|оператор)/im.test(journal) &&
    journal.includes(` by ${session}\n`) && /^## \d{4}-\d{2}-\d{2} /m.test(journal));
}

function unfencedText(text) {
  return require('../lib/entry-text.cjs').fenceMask(text);
}

function approvedSections(text) {
  // Fenced examples are inert before dividing into authority-sized sections.
  return unfencedText(text).split(/(?=^#{1,3} )/m).filter(section => /^Approved by:[ \t]*\S/m.test(section));
}

// CM-82 retains committed enrollment history, including after a later commit
// changes both a block and its pin. CM-83 uses immutable migration membership:
// the legacy list where the log holds its baseline block, else the baseline snapshot.
function checkDecisionIntegrity(root, gitUsable, report, legacyList = LEGACY) {
  if (!gitUsable) return;
  const baseline = integrityBaseline(root);
  if (baseline.invalid) {
    report('CM-82', 'FAIL', 'DECISION-HASH-BASELINE: ambiguous integrity baseline'); return;
  }
  const registryPath = REGISTRY_REL.split(path.sep).join('/');
  // A commit removing the marker cannot turn enrollment back off. Locate its
  // historical introduction independently of the current registry contents.
  const boundaries = gitRead(root, ['log', '--full-history', '--format=%H', '-G', '^<!-- decision-integrity: v1 baseline=',
    '--', registryPath]);
  if (boundaries.code !== 0) {
    report('CM-82', baseline.active ? 'FAIL' : 'WARN', 'DECISION-HASH-BASELINE: migration history unavailable'); return;
  }
  for (const ref of new Set(boundaries.output.trim().split(/\s+/).filter(Boolean))) {
    const snapshot = gitRead(root, ['show', `${ref}:${registryPath}`]);
    if (snapshot.code !== 0) {
      report('CM-82', 'FAIL', 'DECISION-HASH-BASELINE: migration registry unavailable'); return;
    }
    for (const marker of snapshot.output.matchAll(INTEGRITY_MARKER)) {
      if (!baseline.active || marker[1] !== baseline.ref) {
        report('CM-82', 'FAIL', 'DECISION-HASH-BASELINE: committed migration boundary changed'); return;
      }
    }
  }
  const old = gitRead(root, ['show', `${baseline.ref}:.ai/DECISIONS.md`]);
  if (old.code !== 0) {
    report('CM-82', baseline.active ? 'FAIL' : 'WARN', 'DECISION-HASH-BASELINE: baseline decisions unavailable'); return;
  }
  if (baseline.active && gitRead(root, ['merge-base', '--is-ancestor', baseline.ref, 'HEAD']).code !== 0) {
    report('CM-82', 'FAIL', 'DECISION-HASH-BASELINE: baseline is not an ancestor of HEAD'); return;
  }
  let current;
  try { current = guardedText(root, '.ai/DECISIONS.md'); } catch { current = null; }
  if (current === null) { report('CM-82', 'FAIL', 'DECISION-HASH-UNREADABLE: decisions unavailable'); return; }
  const hashes = decisionHashes(current), previous = decisionHashes(old.output);
  const migrationRef = baseline.ref;
  const listed = legacyMigration(hashes, legacyList);
  const migration = listed ? null : gitRead(root, ['show', `${migrationRef}:.ai/DECISIONS.md`]);
  if (migration && migration.code !== 0) {
    report('CM-82', baseline.active ? 'FAIL' : 'WARN', 'DECISION-HASH-BASELINE: migration decisions unavailable'); return;
  }
  const migrationHashes = listed || decisionHashes(migration.output);
  const baselineRegistry = gitRead(root, ['show', `${baseline.ref}:${REGISTRY_REL.split(path.sep).join('/')}`]);
  const legacyRows = new Set(baselineRegistry.code === 0 ? baselineRegistry.output.split('\n') : []);
  const enrolled = new Map();
  const conflicted = new Set();
  for (const line of (baseline.registry || '').split('\n')) {
    if (!REGISTRY_LINE_PATTERN.test(line)) continue;
    const cells = line.trim().split('|').slice(1, -1).map(cell => cell.trim());
    if (cells.length === 6) continue;
    if (cells.length !== 7 || !/^[a-f0-9]{64}$/.test(cells[6])) {
      report('CM-82', baseline.active && !legacyRows.has(line) ? 'FAIL' : 'WARN', 'DECISION-HASH-ROW: expected six legacy columns or seven columns ending in SHA-256'); continue;
    }
    const key = cells[0].toLowerCase();
    // Every pin stays binding; a later row cannot silently replace a hash.
    if (enrolled.has(key) && enrolled.get(key) !== cells[6]) {
      conflicted.add(key);
      report('CM-82', 'FAIL', `DECISION-HASH-CONFLICT: ${cells[0]} has conflicting pins`);
    }
    enrolled.set(key, cells[6]);
    if (!hashes.has(key) || hashes.get(key).sha256 !== cells[6]) report('CM-82', 'FAIL', `DECISION-HASH-MISMATCH: ${cells[0]} changed after enrollment`);
  }
  if (baseline.active) {
    // Git content addresses are immutable across ordinary descendant commits.
    // Retain every enrollment, including new decisions pinned after migration.
    const history = gitRead(root, ['log', '--full-history', '--format=%H', `${migrationRef}..HEAD`, '--', registryPath]);
    if (history.code !== 0) {
      report('CM-82', 'FAIL', 'DECISION-HASH-BASELINE: enrollment history unavailable'); return;
    }
    const refs = new Set([baseline.ref, migrationRef, ...history.output.trim().split(/\s+/).filter(Boolean)]);
    const currentRows = new Set((baseline.registry || '').split('\n'));
    const pinned = new Map();
    for (const ref of refs) {
      const snapshot = gitRead(root, ['show', `${ref}:${REGISTRY_REL.split(path.sep).join('/')}`]);
      if (snapshot.code !== 0) {
        report('CM-82', 'FAIL', 'DECISION-HASH-BASELINE: enrollment registry unavailable'); return;
      }
      for (const marker of snapshot.output.matchAll(INTEGRITY_MARKER)) {
        if (marker[1] !== baseline.ref) {
          report('CM-82', 'FAIL', 'DECISION-HASH-BASELINE: committed migration boundary changed'); return;
        }
      }
      for (const line of snapshot.output.split('\n')) {
        if (!REGISTRY_LINE_PATTERN.test(line)) continue;
        const cells = line.trim().split('|').slice(1, -1).map(cell => cell.trim());
        if (cells.length !== 7 || !/^[a-f0-9]{64}$/.test(cells[6])) continue;
        const key = cells[0].toLowerCase();
        if (pinned.has(key) && pinned.get(key) !== cells[6]) conflicted.add(key);
        pinned.set(key, cells[6]);
        if (enrolled.get(key) !== cells[6] || !currentRows.has(line)) report('CM-82', 'FAIL', `DECISION-HASH-REGISTRY: ${cells[0]} committed pin removed or rewritten`);
        if (hashes.get(key)?.sha256 !== cells[6]) report('CM-82', 'FAIL', `DECISION-HASH-MISMATCH: ${cells[0]} changed or deleted after enrollment`);
      }
    }
    // The named migration also binds blocks whose pins were removed together
    // with their text. A new pin cannot bless a rewrite of an existing block.
    for (const [key, entry] of migrationHashes) {
      if (hashes.get(key)?.sha256 !== entry.sha256) report('CM-82', 'FAIL', `DECISION-HASH-MISMATCH: ${entry.id} changed or deleted after migration`);
    }
  }
  let legacy = 0;
  const priorIds = new Set();
  for (const [key, entry] of parseImmutabilityBlocks(current).blocks) {
    const historical = migrationHashes.get(key)?.sha256 === hashes.get(key).sha256;
    // The legacy list pins a listed block by its hash; a block after the
    // baseline, or a listed block whose bytes changed, still needs its registry hash.
    const unconflicted = !conflicted.has(key);
    if (!enrolled.has(key) && !(listed !== null && historical && unconflicted)) {
      report('CM-82', baseline.active && !previous.has(key) ? 'FAIL' : 'WARN', `DECISION-HASH-MISSING: ${entry.id} has no registry hash`);
    }
    // A listed block is pinned by the legacy list itself; a snapshot block also needs its registry pin.
    const pinnedLegacy = historical && unconflicted && (listed !== null || enrolled.get(key) === hashes.get(key).sha256);
    if (pinnedLegacy) legacy++;
    else if (/^Approved by:[ \t]*\S/m.test(entry.value) && !provenanceValid(root, entry.value, entry.id, priorIds)) {
      if (!baseline.active && previous.has(key)) legacy++;
      else report('CM-83', baseline.active ? 'FAIL' : 'WARN', `APPROVAL-PROVENANCE: new decision ${entry.id} lacks a verifiable prior decision or operator session reference`, '.ai/DECISIONS.md');
    }
    priorIds.add(entry.id);
  }
  if (legacy) report('CM-83', 'WARN', `APPROVAL-PROVENANCE-LEGACY: ${legacy} historical decision(s); enrolled blocks retain their verified registry hashes`);
  // Unchanged baseline data cannot introduce a new approval. Git names the
  // changed tracked files plus untracked files; safe descriptor reads then
  // inspect that delta, avoiding thousands of native opens on every validation.
  const corpus = ['docs/reviews', '.ai/worklog', '.ai/ARCHIVE.md'];
  const changed = gitRead(root, ['diff', '--no-ext-diff', '--name-only', '-z', baseline.ref, '--', ...corpus]);
  const untracked = gitRead(root, ['ls-files', '-o', '--exclude-standard', '-z', '--', ...corpus]);
  if (changed.code !== 0 || untracked.code !== 0) { report('CM-83', 'WARN', 'APPROVAL-PROVENANCE-UNAVAILABLE: data corpus unavailable'); return; }
  let historical = 0;
  for (const relative of new Set((changed.output + untracked.output).split('\0').filter(name => /\.md$/i.test(name)))) {
    let text;
    try { text = guardedText(root, relative); } catch { text = null; }
    if (text === null) { report('CM-83', 'WARN', 'APPROVAL-PROVENANCE-UNREADABLE: data file unavailable', relative); continue; }
    const sections = approvedSections(text);
    if (!sections.length) continue;
    const before = gitRead(root, ['show', `${baseline.ref}:${relative}`]);
    const oldSections = approvedSections(before.code === 0 ? before.output : '');
    for (const section of sections) {
      if (provenanceValid(root, section, null, priorIds)) continue;
      const approval = section.match(/^Approved by:[^\n]*$/gm).join('\n');
      const index = oldSections.findIndex(s => s.match(/^Approved by:[^\n]*$/gm).join('\n') === approval);
      if (index !== -1) { oldSections.splice(index, 1); historical++; }
      else report('CM-83', baseline.active ? 'FAIL' : 'WARN', 'APPROVAL-PROVENANCE: data approval lacks a verifiable decision or operator session reference', relative);
    }
  }
  if (historical) report('CM-83', 'WARN', `APPROVAL-PROVENANCE-LEGACY: ${historical} historical data section(s) lack structured provenance`);
  if (baseline.active) {
    const log = gitRead(root, ['log', '--format=%B%x00', `${baseline.ref}..HEAD`]);
    if (log.code !== 0) report('CM-83', 'WARN', 'APPROVAL-PROVENANCE-UNAVAILABLE: commit messages unavailable');
    else for (const message of log.output.split('\0')) {
      if (approvedSections(message).length && !provenanceValid(root, message, null, priorIds)) {
        report('CM-83', 'FAIL', 'APPROVAL-PROVENANCE: commit approval lacks a verifiable reference');
      }
    }
  }
}

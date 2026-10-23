'use strict';

// Node validator engine, governance module.
// Implements CM-30..CM-33 and CM-44 one to one with these contracts:
//   CM-30 decision block structure, CM-31 supersedes references,
//   CM-32 decision registry (WARN-first, role source), CM-33 task status,
//   CM-44 decision immutability vs HEAD.
// The module emits diagnostics through the caller's report() callback and never
// prints, never mutates the working tree and keeps no global state
// (final-plan-2 section J). The entry owns check order and rendering.
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
};

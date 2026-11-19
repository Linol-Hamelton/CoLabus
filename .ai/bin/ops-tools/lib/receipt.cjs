'use strict';
// Author-check receipts: the one reader of the receipt binding and the one writer of the
// receipt ledger, shared by author-check (writer) and precert-check (judge). A receipt
// names a commit and a tree; it is green for HEAD only, or for an ancestor whose later
// commits touch nothing but session journals and inert audit prompts.
const fs = require('node:fs');
const path = require('node:path');

const SCHEMA = 3;
const SHA = /^[0-9a-f]{40}$/;
const JOURNAL = /^\.ai\/worklog\//;
const INERT = /^docs\/reviews\/[^/]+-audit-prompt\.md$/;

const plain = v => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
const inert = file => JOURNAL.test(file) || INERT.test(file);

// Porcelain -z keeps spaces and rename endpoints unambiguous. Both endpoints of
// a rename must be journals before it can be exempted from the live-tree check.
function dirtyNonJournal(status) {
  const entries = String(status).split('\0');
  const dirty = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const files = [entry.slice(3)];
    if (/^[RC]|^.[RC]/.test(entry)) files.push(entries[++i] || '');
    if (files.some(file => !JOURNAL.test(file))) dirty.push(entry);
  }
  return dirty;
}

// Every readable receipt in a directory, newest first by its recorded time. A malformed
// file is listed as a problem and never becomes a receipt.
function readReceipts(dir, io = fs) {
  let names;
  try { names = io.readdirSync(dir).filter(name => name.endsWith('.json')).sort(); } catch { return { receipts: [], problems: [] }; }
  const receipts = [];
  const problems = [];
  for (const name of names) {
    const file = path.join(dir, name);
    let value;
    try { value = JSON.parse(io.readFileSync(file, 'utf8')); } catch { problems.push(`${name}: unreadable or not JSON`); continue; }
    if (!plain(value) || ![2, SCHEMA].includes(value.schema) || !SHA.test(value.head || '') || typeof value.at !== 'string'
      || !Number.isFinite(Date.parse(value.at)) || typeof value.ok !== 'boolean') {
      problems.push(`${name}: not an author-check receipt of schema 2 or ${SCHEMA}`);
      continue;
    }
    receipts.push({ file, name, value });
  }
  receipts.sort((a, b) => Date.parse(b.value.at) - Date.parse(a.value.at));
  return { receipts, problems };
}

// The binding. A green receipt for another commit is refused by name; only a move whose
// whole diff is journals and audit prompts is accepted on top of a green receipt.
function coverageProblem(value) {
  if (value.schema === 2) return null; // historical receipts remain readable
  if (value.schema !== SCHEMA) return 'unsupported receipt schema';
  const c = value.coverage;
  const strings = list => Array.isArray(list) && list.every(n => typeof n === 'string' && n.length > 0) && new Set(list).size === list.length;
  if (!plain(c) || !strings(c.selected) || !strings(c.entryFiles) || !strings(c.ran) ||
      !Array.isArray(c.coveredBy) || !Array.isArray(c.refused) || !strings(c.unaccounted) ||
      c.complete !== true || c.ok !== true || c.refused.length || c.unaccounted.length) return 'missing or refused selected-file coverage';
  if (!plain(value.groups) || !Object.values(value.groups).every(strings)) return 'missing selection groups';
  const selected = Object.values(value.groups).flat();
  if (new Set(selected).size !== selected.length || selected.length !== c.selected.length || selected.some(n => !c.selected.includes(n))) return 'coverage differs from selected groups';
  // An entry file is a driver file that ran. The run proves it: the result of a selection part lists it among its passed
  // files (author-check writes passedFiles for every part). The coverage lists alone are the receipt's word, not a run.
  const passed = new Set(Object.keys(value.groups).flatMap(part => {
    const row = plain(value.results) ? value.results[part] : null;
    return plain(row) && Array.isArray(row.passedFiles) ? row.passedFiles.filter(n => typeof n === 'string') : [];
  }));
  if (c.entryFiles.some(n => !passed.has(n))) return 'coverage names an entry file that no part of the run passed';
  if (c.ran.some(n => !c.entryFiles.includes(n)) || c.coveredBy.some(row => !plain(row) ||
      typeof row.file !== 'string' || row.file === row.entry || !c.entryFiles.includes(row.entry) ||
      !['consumer-index', 'require-graph'].includes(row.source) ||
      (row.source === 'consumer-index' && row.index !== 'docs/ops/test-consumers.json') ||
      (row.source === 'require-graph' && (!strings(row.path) || row.path[0] !== row.entry || row.path.at(-1) !== row.file)))) return 'coverage names an unrun or unproven owner';
  const accounted = [...c.ran, ...c.coveredBy.map(row => row.file)];
  if (accounted.length !== selected.length || new Set(accounted).size !== accounted.length ||
      selected.some(n => !accounted.includes(n))) return 'selected-file coverage invariant failed';
  return null;
}

function covers(receipt, head, deps = {}) {
  if (!plain(receipt)) return { ok: false, why: 'not a receipt' };
  if (receipt.ok !== true) return { ok: false, why: `the author check itself failed (${receipt.branch || 'unknown branch'})` };
  if (!plain(receipt.results) || !Object.keys(receipt.results).length || Object.values(receipt.results).some(result => !plain(result) || result.exit !== 0)) return { ok: false, why: 'the receipt contains missing or failed check results' };
  const problem = coverageProblem(receipt);
  if (problem) return { ok: false, why: problem };
  if (!Array.isArray(receipt.dirtyNonJournal) || receipt.dirtyNonJournal.length) return { ok: false, why: 'the receipt was written on a tree with uncommitted non-journal changes' };
  if (!SHA.test(head || '')) return { ok: false, why: 'HEAD is not a full commit id' };
  if (!SHA.test(receipt.tree || '') || typeof deps.treeAt !== 'function' || deps.treeAt(receipt.head) !== receipt.tree) return { ok: false, why: 'the receipt tree does not match its commit' };
  if (receipt.head === head) return { ok: true, why: 'the receipt is bound to HEAD' };
  if (typeof deps.isAncestor !== 'function' || !deps.isAncestor(receipt.head, head)) return { ok: false, why: `the receipt is for another commit (${String(receipt.head).slice(0, 8)})` };
  const changed = typeof deps.changedBetween === 'function' ? deps.changedBetween(receipt.head, head) : null;
  if (!Array.isArray(changed)) return { ok: false, why: 'the commits between the receipt and HEAD cannot be read' };
  const outside = changed.filter(file => typeof file !== 'string' || !inert(file));
  if (outside.length) return { ok: false, why: `the tree moved after the receipt: ${outside.slice(0, 3).join(', ')}` };
  return { ok: true, why: 'the receipt is on an ancestor and only journals changed since' };
}

// Judge the directory for one HEAD. A recorded override is accepted only with a reason
// and is appended to the ledger before the answer, so it can never be silent.
function assess(options) {
  const head = options.head;
  const dir = options.receiptDir;
  const { receipts, problems } = readReceipts(dir, options.io || fs);
  const deps = { isAncestor: options.isAncestor, changedBetween: options.changedBetween, treeAt: options.treeAt };
  // The newest applicable attempt is authoritative, including a failed attempt.
  // A later failure must never revive an older green receipt on HEAD/ancestors.
  const item = receipts.find(row => row.value.head === head || (typeof deps.isAncestor === 'function' && deps.isAncestor(row.value.head, head)));
  const verdict = options.dirtyNonJournal && options.dirtyNonJournal.length
    ? { ok: false, why: 'the live worktree has uncommitted non-journal changes' }
    : covers((item || receipts[0] || {}).value, head, deps);
  if (item && verdict.ok) return { ok: true, receipt: item, why: verdict.why, problems };
  const reason = typeof options.overrideReason === 'string' ? options.overrideReason.trim() : '';
  if (reason) {
    appendLedger(dir, { at: new Date(options.now || Date.now()).toISOString(), override: reason, worktree: options.worktree || null, head }, options.io || fs);
    return { ok: true, override: reason, why: 'author check overridden with a recorded reason' };
  }
  const why = receipts.length ? verdict.why : 'no author-check receipt exists';
  return { ok: false, why: problems.length ? `${why}; ${problems.join('; ')}` : why, problems };
}

function appendLedger(dir, row, io = fs) {
  io.mkdirSync(dir, { recursive: true });
  io.appendFileSync(path.join(dir, 'ledger.jsonl'), `${JSON.stringify(row)}\n`, 'utf8');
}

function writeReceipt(dir, receipt, io = fs) {
  io.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${receipt.branch}-${receipt.head.slice(0, 8)}.json`);
  io.writeFileSync(file, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return file;
}

module.exports = { SCHEMA, SHA, JOURNAL, INERT, inert, dirtyNonJournal, readReceipts, covers, assess, appendLedger, writeReceipt, coverageProblem };

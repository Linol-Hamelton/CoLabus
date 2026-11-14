'use strict';
// Read-only qualification of ONE report against ONE completed launch-record/1.
// No HEAD fallback, report discovery, launch, receipt signing or landing.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const safe = require('../lib/text-safe.cjs');
const { readFileGuarded } = require('../lib/path-safe.cjs');
const { certificationFacts, headerOf } = require('../lib/review-facts.cjs');
const binding = require('../lib/review-binding.cjs');
const { canonicalModel } = require('../lib/model-identity.cjs');
const { readVerdict } = require('../lib/verdict-read.cjs');
const { entryBody, readEvidence } = require('../protocol-handoff/evidence.cjs');
// What an entry claims is its text before its own Evidence block (the one entry text model; fenced text is entry text).
const { claimText } = require('../lib/entry-text.cjs');
const { recovered } = require('../accounting/launch-record-validate.cjs');
const MAX_BYTES = 8 * 1024 * 1024;
const SHA = /^(?!([a-f0-9])\1{39}$)[a-f0-9]{40}$/;
const SOURCES = new Set(['agent-result', 'client-banner', 'client-log', 'launcher-model']);

function readText(file, root = path.parse(path.resolve(file)).root) {
  const result = readFileGuarded(root, path.resolve(file), { maxBytes: MAX_BYTES });
  if (!result.ok) throw Error('UNREADABLE');
  const decoded = safe.decode(result.bytes, { bom: 'strip', crlf: 'normalise' });
  if (!decoded.ok) throw Error('UNDECODABLE');
  return decoded.text;
}
function launchRecord(text, id) {
  let rows;
  try { rows = [safe.parseJsonUnique(text)]; }
  catch { rows = text.split('\n').filter(l => l.trim()).map(l => safe.parseJsonUnique(l)); }
  if (rows.some(r => !r || r.schema !== 'launch-record/1')) throw Error('LAUNCH-SCHEMA');
  const selected = id === undefined ? rows : rows.filter(r => r.launchId === id);
  if (selected.length !== 1) throw Error('LAUNCH-SELECTION');
  return selected[0];
}
function sameRoot(a, b) {
  try { return fs.realpathSync.native(a) === fs.realpathSync.native(b); } catch { return false; }
}
function sameModel(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const model = canonicalModel(a);
  return model !== 'UNKNOWN' && model === canonicalModel(b);
}
// Separate proof class: opencode `export SESSION` JSON, NOT generated text parts.
// Every assistant message must belong to this session and name the same model.
function opencodeProof(value, record) {
  if (record.tuple?.client !== 'opencode' || typeof record.calleeSession !== 'string' || !record.calleeSession ||
      value?.info?.id !== record.calleeSession || !Array.isArray(value.messages)) return false;
  const assistants = value.messages.filter(m => m?.info?.role === 'assistant');
  return assistants.length > 0 && assistants.every(m => {
    const info = m.info;
    return info.sessionID === record.calleeSession && typeof info.providerID === 'string' &&
      typeof info.modelID === 'string' && sameModel(`${info.providerID}/${info.modelID}`, record.servedModel);
  });
}
function verifyReceipt(root, owner) {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../protocol-handoff.cjs'),
    'verify', '--root', root, '--owner', owner], {
    cwd: root, encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024, windowsHide: true,
  });
  // Never copy subprocess diagnostics: they may contain private paths or text.
  return !result.error && !result.signal && Number.isInteger(result.status) && result.status === 0;
}
function count(options, deps = {}) {
  const facts = [];
  const add = (code, ok) => facts.push({ code, ok: ok === true });
  const root = path.resolve(options.root || process.cwd());
  let record, report, owner, proofClass = null;
  try { record = launchRecord(readText(options.launch), options.launchId); add('LAUNCH-RECORD', true); }
  catch { add('LAUNCH-RECORD', false); }
  if (record) {
    add('LAUNCH-SHA', typeof record.head === 'string' && SHA.test(record.head));
    add('LAUNCH-WORKTREE', typeof record.workdir === 'string' && path.isAbsolute(record.workdir) && sameRoot(record.workdir, root));
    add('LAUNCH-ROLE', record.launchRole === undefined ? record.role === 'certifier' : record.launchRole === 'certifier' && record.role === 'certifier');
    add('LAUNCH-EXIT', Number.isInteger(record.exitCode) && record.exitCode === 0);
    let proven = false;
    try {
      // A recovered (backfilled) record proves no served model in either proof class: it stays unknown (the kernel predicate).
      const known = !recovered(record);
      const confidence = known && ['exact', 'derived'].includes(record.servedModelConfidence);
      if (options.opencodeJson !== undefined) {
        proofClass = 'OPENCODE-JSON';
        proven = confidence && opencodeProof(safe.parseJsonUnique(readText(options.opencodeJson)), record);
      } else if (record.tuple?.client !== 'opencode') {
        proofClass = 'LAUNCH-RECORD';
        proven = confidence && SOURCES.has(record.servedModelSource) && sameModel(record.servedModel, record.servedModel);
      }
      add('SERVED-PROOF', proven);
      add('SERVED-REQUEST', known && sameModel(record.tuple?.model, record.servedModel));
    } catch { add('SERVED-PROOF', false); add('SERVED-REQUEST', false); }
  }
  try {
    // The shared grammar refuses traversal, runtime/journal files and aliases.
    if (!binding.mentionedReviews(options.report).includes(options.report)) throw Error('REPORT-PATH');
    report = readText(path.resolve(root, options.report), root);
    add('REPORT-READ', true);
  } catch { add('REPORT-READ', false); }
  if (report !== undefined) {
    // Always require an expected SHA/model; missing launch data cannot disable a fact.
    const review = certificationFacts(report, { expectedSha: record?.head || 'INVALID', servedModel: record?.servedModel || 'UNKNOWN' });
    for (const f of review.filter(f => f.level === 'gate')) add(f.code, f.ok);
    const visibleHeader = safe.ownLines(headerOf(report)).map(l => l.text).join('\n');
    const modes = binding.fields(visibleHeader, 'Mode');
    add('R-MODE', modes.length === 1 && modes[0].replace(/[*_`]/g, '').trim() === 'CERTIFYING');
    const verdict = readVerdict(report);
    add('R-VERDICT', ['PASS', 'RECOMMENDATION'].includes(verdict.token));
    owner = binding.reviewOwner(visibleHeader);
    add('R-OWNER', owner !== null);
    if (owner) {
      const journal = path.join(root, '.ai/worklog', `${owner}.md`);
      try {
        readText(journal, root);
        const body = entryBody(journal);
        const narrative = body === null ? '' : claimText(body);
        add('R-JOURNAL', body !== null && binding.mentionedReviews(narrative).includes(options.report));
        const ev = readEvidence(journal);
        add('R-BINDING', !!ev && binding.verifyBindings(root, owner, ev.body, options.report) === null);
      } catch { add('R-JOURNAL', false); add('R-BINDING', false); }
      try { add('R-RECEIPT', (deps.verifyReceipt || verifyReceipt)(root, owner)); }
      catch { add('R-RECEIPT', false); }
    }
  }
  const reasons = facts.filter(f => !f.ok).map(f => f.code);
  return { status: reasons.length ? 'NOT-COUNTED' : 'COUNTED', proofClass, facts, reasons };
}
function main(argv) {
  const options = {};
  const flags = { '--root': 'root', '--launch': 'launch', '--launch-id': 'launchId', '--report': 'report', '--opencode-json': 'opencodeJson' };
  try {
    for (let i = 0; i < argv.length; i += 2) {
      const key = flags[argv[i]];
      if (!key || Object.hasOwn(options, key) || !argv[i + 1] || argv[i + 1].startsWith('--')) throw Error('USAGE');
      options[key] = argv[i + 1];
    }
    if (!options.launch || !options.report) throw Error('USAGE');
    const result = count(options);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return result.status === 'COUNTED' ? 0 : 1;
  } catch {
    process.stdout.write(`${JSON.stringify({ status: 'NOT-COUNTED', reasons: ['INPUT-REFUSED'] })}\n`);
    return 2;
  }
}
module.exports = { launchRecord, opencodeProof, verifyReceipt, count, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

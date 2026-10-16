#!/usr/bin/env node
'use strict';

// Attaches verifiable evidence to a session journal entry.
//
// The protocol used to transfer assertions: an agent wrote "the suite passes"
// and the next agent had no way to check. This records what actually ran, the
// exact tree it ran against, and lets anyone re-verify later.
//
//   record  --owner <session> [--journal <path>] [--quick]
//           [--candidate <full-sha> --baseline <full-sha> [--check <probe-script>]]
//   verify  [--journal <path>]
//   rehash  --owner <session> --reason <text> [--journal <path>]
//   state
//
// record exits non-zero when a check fails, so a red tree cannot produce a
// green receipt.


const fs = require('node:fs');
const path = require('node:path');
const hooks = require('./protocol-hooks.cjs');
const archive = require('./protocol-archive.cjs');
const snapshot = require('./protocol-handoff/snapshot.cjs');
const evidence = require('./protocol-handoff/evidence.cjs');
const chain = require('./protocol-handoff/chain.cjs');
const gate = require('./protocol-handoff/gate.cjs');
const { anchor, checksFor, runCheck } = snapshot;
const { renderEvidence, formatWithEvidence, newestSection, findParentEntry, entryHash, readEvidence } = evidence;
const { verifyJournalChain, resolveJournal, reportOne } = chain;
const { gateCheck } = gate;
const candidate = require('./protocol-handoff/candidate.cjs');
const { writeAtomicGuarded } = require('./lib/path-safe.cjs');
const { spawnSync } = require('node:child_process');
const { secretIn } = require('./lib/secrets.cjs');

function main(argv) {
  const command = argv[0];
  const options = {};
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--quick') { options.quick = true; continue; }
    if (argv[i] === '--deep') { options.deep = true; continue; }
    if (argv[i] === '--allow-legacy') { options.allowLegacy = true; continue; }
    const value = argv[i + 1];
    if (!value) throw new Error(`Missing value for ${argv[i]}`);
    if (['--candidate', '--baseline'].includes(argv[i]) && options[argv[i].slice(2)] !== undefined) throw new Error('duplicate candidate option');
    if (argv[i] === '--owner') options.owner = value;
    else if (argv[i] === '--journal') options.journal = value;
    else if (argv[i] === '--root') options.root = value;
    else if (argv[i] === '--reason') options.reason = value;
    else if (argv[i] === '--candidate') options.candidate = value;
    else if (argv[i] === '--baseline') options.baseline = value;
    else if (argv[i] === '--check') (options.checks ||= []).push(value);
    else throw new Error('Usage: protocol-handoff.cjs record|verify|rehash|state|gate-check [--owner id] [--journal path] [--root path] [--reason text] [--quick] [--deep] [--allow-legacy]');
    i += 1;
  }
  const root = fs.realpathSync(path.resolve(options.root || path.join(__dirname, '..', '..')));
  if (options.baseline && !options.candidate) throw new Error('--baseline needs --candidate');
  if (options.checks && (command !== 'record' || !options.candidate)) throw new Error('--check needs record --candidate');
  if (options.candidate && !['record', 'verify'].includes(command)) throw new Error('--candidate is only valid for record/verify');
  let state = null;
  const getState = () => {
    if (!state) state = anchor(root);
    return state;
  };

  if (command === 'state') {
    process.stdout.write(`${JSON.stringify(getState(), null, 2)}\n`);
    return 0;
  }

  if (command === 'record') {
    if (!options.owner) throw new Error('record needs --owner <session id>');
    const immutable = options.candidate ? candidate.candidateState(root, options.candidate, options.baseline) : null;
    if (immutable && (!/^[a-z0-9][a-z0-9-]{1,80}$/.test(options.owner) || secretIn(options.owner))) {
      throw new Error('candidate owner identifier refused');
    }
    const journalPath = resolveJournal(root, options.journal, options.owner);
    // Auto-archive older entries if journal exceeded 150 lines (Fork 2).
    try {
      if (!immutable) archive.autoArchiveWorklog(root, journalPath, 150, 1, options.owner);
    } catch { }
    const journalText = immutable ? candidate.guardedText(root, journalPath) : fs.readFileSync(journalPath, 'utf8');
    const secretLeak = hooks.findSecretLeak(journalText);
    if (immutable && secretIn(journalText)) throw new Error('candidate journal contains a credential-shaped value');
    if (secretLeak) {
      throw new Error(`Unredacted secret pattern detected in ${path.relative(root, journalPath)}: "${secretLeak.slice(0, 16)}...". ` +
        'Remove or redact secrets before recording evidence.');
    }
    let candidateScope = null;
    const checks = immutable ? candidate.isolated(root, immutable, checkout => {
      const quick = Boolean(options.quick || process.env.PROTOCOL_NO_FULL_SUITE === '1');
      const selected = options.checks || [];
      if (new Set(selected).size !== selected.length) throw new Error('duplicate targeted check');
      for (const rel of selected) {
        if (!/^tests\/[A-Za-z0-9_/-]+(?:\.test)?\.cjs$/.test(rel) || rel.split('/').some(s => s === '..' || s === '.') ||
            secretIn(rel) || !immutable.rows.some(row => row.name === rel && row.type === 'blob')) throw new Error('targeted check path refused');
      }
      candidateScope = quick ? (selected.length ? 'targeted' : 'validator-only') : 'full';
      if (anchor(checkout).digest !== immutable.digest) throw new Error('isolated candidate initial digest mismatch');
      const results = checksFor(checkout, quick).map(check => runCheck(checkout, check));
      for (const rel of selected) {
        const started = Date.now();
        const r = spawnSync(process.execPath, [path.join(checkout, rel)], { cwd: checkout, shell: false, windowsHide: true,
          timeout: 900000, stdio: 'ignore', env: { ...process.env, PROTOCOL_NO_FULL_SUITE: '1' } });
        results.push({ name: `targeted:${rel}`, code: r.error || !Number.isInteger(r.status) ? 2 : r.status,
          seconds: Math.round((Date.now() - started) / 1000) });
      }
      if (anchor(checkout).digest !== immutable.digest || candidate.git(checkout, ['rev-parse', 'HEAD']).trim() !== immutable.commit) {
        throw new Error('isolated candidate changed during checks');
      }
      return results;
    }) : checksFor(root, options.quick).map(check => runCheck(root, check));
    const failed = checks.filter(check => check.code !== 0);
    // Re-anchor: the checks may have touched the tree. Evidence must describe
    // the state it was actually measured against.
    const after = immutable ? { ...immutable, dirty: anchor(root).dirty } : anchor(root);
    // Hash the entry as it stands before the block is attached, so the
    // hash covers the claim and not itself.
    let parentEntry = findParentEntry(journalPath);
    if (parentEntry === 'tampered') {
      throw new Error(`Cannot record evidence in ${path.relative(root, journalPath)}: historical entry link is tampered. ` +
        'Previous entry hash does not match its contents.');
    }
    let chainCheck = verifyJournalChain(root, journalPath);
    if (!chainCheck.ok) {
      throw new Error(`Cannot record evidence in ${path.relative(root, journalPath)}: historical entry link is tampered. ${chainCheck.reason}`);
    }
    const provisionalEntry = `sha256:${'0'.repeat(64)}`;
    let evidenceBlock = renderEvidence(
      after, checks, options.owner, provisionalEntry, Boolean(options.quick || (immutable && candidateScope !== 'full')), parentEntry,
    );
    const bindCandidate = block => immutable ? block.replace('- recorded:', [
      `- candidate: ${immutable.commit}`, `- candidate-baseline: ${immutable.baseline}`,
      `- candidate-tree: ${immutable.tree}`, `- candidate-digest: ${immutable.digest}`,
      `- candidate-scope: ${candidateScope}`, `- candidate-checks: ${checks.length}`, '- recorded:',
    ].join('\n')) : block;
    evidenceBlock = bindCandidate(evidenceBlock);

    let currentJournalText = fs.readFileSync(journalPath, 'utf8');
    let projected = formatWithEvidence(currentJournalText, evidenceBlock);
    if (projected === null) {
      throw new Error(`No dated entry in ${path.relative(root, journalPath)}. Write the entry first, then record evidence.`);
    }

    if (archive.getLineCount(projected) > 150) {
      if (immutable) throw new Error('candidate journal exceeds 150 lines; archive separately before recording');
      const foundSection = newestSection(currentJournalText);
      const firstHeading = currentJournalText.replace(/\r\n/g, '\n').search(/^## /m);
      const preamble = firstHeading !== -1 ? currentJournalText.slice(0, firstHeading) : '';
      const dummyArchivedMarker = '<!-- archived-parent: sha256:' + '0'.repeat(64) + ' -->\n\n---\n\n';
      const singleEntryText = (preamble.trim() ? preamble.trim() + '\n\n' : '') + dummyArchivedMarker + foundSection.sections[foundSection.index];
      const singleProjected = formatWithEvidence(singleEntryText, evidenceBlock);
      if (archive.getLineCount(singleProjected) > 150) {
        throw new Error(`Cannot record evidence in ${path.relative(root, journalPath)}: journal entry is too long; split the entry before recording.`);
      }

      // Archive older entries first (keep newest = 1)
      archive.autoArchiveWorklog(root, journalPath, 0, 1, options.owner);
      currentJournalText = fs.readFileSync(journalPath, 'utf8');

      // Re-evaluate chain links in case parent entry moved to archive
      parentEntry = findParentEntry(journalPath);
      if (parentEntry === 'tampered') {
        throw new Error(`Cannot record evidence in ${path.relative(root, journalPath)}: historical entry link is tampered. ` +
          'Previous entry hash does not match its contents.');
      }
      chainCheck = verifyJournalChain(root, journalPath);
      if (!chainCheck.ok) {
        throw new Error(`Cannot record evidence in ${path.relative(root, journalPath)}: historical entry link is tampered. ${chainCheck.reason}`);
      }

      evidenceBlock = renderEvidence(
        after, checks, options.owner, provisionalEntry, Boolean(options.quick || (immutable && candidateScope !== 'full')), parentEntry,
      );
      evidenceBlock = bindCandidate(evidenceBlock);
      projected = formatWithEvidence(currentJournalText, evidenceBlock);
      if (archive.getLineCount(projected) > 150) {
        throw new Error(`Cannot record evidence in ${path.relative(root, journalPath)}: journal entry is too long; split the entry before recording.`);
      }
    }

    if (immutable && candidate.guardedText(root, journalPath) !== journalText) throw new Error('candidate journal changed during checks');
    const publish = text => {
      if (!immutable) { fs.writeFileSync(journalPath, text); return; }
      const r = writeAtomicGuarded(journalPath, Buffer.from(text), { root });
      if (!r.ok) throw new Error('candidate journal publication refused');
    };
    // Candidate receipts publish once, with the final entry hash already in memory.
    // An interrupted writer never leaves a provisional zero hash on disk.
    if (!immutable) publish(projected);
    const dated = newestSection(projected);
    const entryDigest = immutable ? `sha256:${require('node:crypto').createHash('sha256')
      .update(hooks.canonicalEntryBody(dated.sections[dated.index]), 'utf8').digest('hex')}` : entryHash(journalPath);
    const updated = (immutable ? projected : fs.readFileSync(journalPath, 'utf8'))
      .replace(`- entry: ${provisionalEntry}`, `- entry: ${entryDigest}`);
    publish(updated);
    process.stdout.write(`${path.relative(root, journalPath)}: evidence recorded\n`);
    process.stdout.write('Protocol checks only; run and report the host project tests separately.\n');
    for (const check of checks) process.stdout.write(`  ${check.name}: exit ${check.code}\n`);
    if (failed.length) {
      process.stderr.write(`AI protocol: ${failed.length} check(s) failed; the evidence records the failure.\n`);
      return 1;
    }
    return 0;
  }

  if (command === 'verify') {
    const state = getState();
    // With an explicit target, judge that one journal. Without one, ask the
    // real question: does any journal hold evidence for the tree as it is now?
    // Picking the newest by modification time was wrong, because a checkout or
    // a merge rewrites every file and scrambles the order.
    if (options.journal || options.owner) {
      const journalPath = resolveJournal(root, options.journal, options.owner);
      if (options.candidate) {
        const ev = readEvidence(journalPath);
        const receipt = ev && candidate.candidateReceipt(ev.body);
        if (!receipt || receipt.sha !== options.candidate || (options.baseline && receipt.baseline !== options.baseline)) {
          throw new Error('requested candidate does not match receipt');
        }
      }
      return reportOne(root, journalPath, state, Boolean(options.deep), Boolean(options.allowLegacy));
    }
    const directory = path.join(root, '.ai', 'worklog');
    if (!fs.existsSync(directory)) {
      process.stderr.write('AI protocol: no .ai/worklog directory.\n');
      return 1;
    }
    const journals = fs.readdirSync(directory)
      .filter(name => name.endsWith('.md') && name !== 'README.md')
      .map(name => path.join(directory, name));
    const carrying = journals
      .map(file => ({ file, evidence: readEvidence(file) }))
      .filter(item => item.evidence);
    if (!carrying.length) {
      process.stderr.write('AI protocol: no journal carries an Evidence block. ' +
        'Run: node .ai/bin/protocol-handoff.cjs record --owner <session-id>\n');
      return 1;
    }
    const matching = carrying.filter(item => {
      if (/(?:^|\n)- candidate(?:-|:)/.test(item.evidence.body)) {
        try {
          const receipt = candidate.candidateReceipt(item.evidence.body);
          if (receipt.sha !== (options.candidate || state.commit) || (options.baseline && receipt.baseline !== options.baseline)) return false;
        } catch { return false; }
        return chain.checkOwnerReceipt(root, item.file, { journalPath: item.file, deep: Boolean(options.deep) }).ok;
      }
      if (options.candidate) return false;
      if (!item.evidence.authenticated) return false;
      if (item.evidence.format !== state.format) return false;
      if (item.evidence.digest !== state.digest) return false;
      if (item.evidence.entry !== entryHash(item.file)) return false;
      if (item.evidence.parentEntry === 'tampered') return false;
      if (/exit [^0]/.test(item.evidence.body)) return false;
      const chain = verifyJournalChain(root, item.file, Boolean(options.deep));
      return chain.ok;
    });
    if (matching.length) {
      for (const item of matching) {
        const immutable = candidate.candidateReceipt(item.evidence.body);
        process.stdout.write(`${path.relative(root, item.file)}: evidence matches ${immutable ? 'immutable candidate ' + immutable.sha : 'the current tree'}\n`);
      }
      return 0;
    }
    process.stderr.write(`AI protocol: no evidence matches the current tree ${state.digest}.\n`);
    for (const item of carrying) {
      const why = !item.evidence.authenticated
        ? 'evidence is not authenticated (legacy format)'
        : (item.evidence.entry !== null && item.evidence.entry !== entryHash(item.file)
        ? 'the entry was changed after it was certified'
        : item.evidence.format !== state.format
        ? `recorded with digest format ${item.evidence.format}, not comparable`
        : (item.evidence.digest === state.digest ? 'records a failing check' : 'anchored to a different tree'));
      process.stderr.write(`  ${path.relative(root, item.file)}: ${why}\n`);
    }
    return 1;
  }

  if (command === 'rehash') {
    if (!options.owner) throw new Error('rehash needs --owner <session id>');
    if (!options.reason) throw new Error('rehash needs --reason <text> explaining why the entry was changed');
    const journalPath = resolveJournal(root, options.journal, options.owner);
    const evidence = readEvidence(journalPath);
    if (!evidence) throw new Error(`No Evidence block in ${path.relative(root, journalPath)}. Record evidence first.`);
    if (!evidence.entry) throw new Error('Evidence predates entry hashing. Re-record instead.');
    // Add the sanitized marker before hashing because authenticated Evidence
    // metadata is part of the canonical entry body.
    const text = fs.readFileSync(journalPath, 'utf8');
    const marker = `- sanitized: ${new Date().toISOString()} reason: ${options.reason}`;
    const withMarker = text.includes('- sanitized:') ? text
      : text.replace(/(- reproduce: node .ai\/bin\/protocol-handoff\.cjs verify)/, `${marker}\n$1`);
    if (withMarker !== text) fs.writeFileSync(journalPath, withMarker);
    const currentHash = entryHash(journalPath);
    if (evidence.entry === currentHash && withMarker === text) {
      process.stdout.write(`${path.relative(root, journalPath)}: entry hash already matches; nothing to rehash.\n`);
      return 0;
    }
    const updated = withMarker.replace(
      /^(- entry: )sha256:[a-f0-9]{64}( of this entry without this block)?$/m,
      (m, p1, p2) => `${p1}${currentHash}${p2 || ''}`
    );
    if (updated === text) throw new Error('Could not locate the entry hash line in the Evidence block.');
    fs.writeFileSync(journalPath, updated);
    process.stdout.write(`${path.relative(root, journalPath)}: entry hash updated (was ${evidence.entry}, now ${currentHash})\n`);
    process.stdout.write(`Reason: ${options.reason}\n`);
    return 0;
  }

  if (command === 'gate-check') {
    return gateCheck(root, options);
  }

  throw new Error('Usage: protocol-handoff.cjs record|verify|rehash|state|gate-check');
}

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { process.stderr.write('AI protocol: ' + error.message + '\n'); process.exitCode = error.exitCode === 2 ? 2 : 1; }
}
module.exports = {
  main,
  anchor: snapshot.anchor,
  attach: evidence.attach,
  formatWithEvidence: evidence.formatWithEvidence,
  readEvidence: evidence.readEvidence,
  renderEvidence: evidence.renderEvidence,
  entryHash: evidence.entryHash,
  findParentEntry: evidence.findParentEntry,
  verifyJournalChain: chain.verifyJournalChain,
  verifyArchivedChain: chain.verifyArchivedChain,
  archiveEntryRecords: evidence.archiveEntryRecords,
  parseEvidenceBlock: evidence.parseEvidenceBlock,
  DATE_HEADING_REGEX: evidence.DATE_HEADING_REGEX,
  DATE_HEADING_M_REGEX: evidence.DATE_HEADING_M_REGEX,
  ENTRY_HASH_FORMAT: evidence.ENTRY_HASH_FORMAT,
  hasEntryHashFormat2: evidence.hasEntryHashFormat2,
  canonicalEntryBody: evidence.canonicalEntryBody,
  checkOwnerReceipt: chain.checkOwnerReceipt,
  gateCheck: gate.gateCheck
};

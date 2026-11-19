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
// The one journal lock and the compare before the replace of every journal writer.
const journalTool = require('./protocol-journal.cjs');
const snapshot = require('./protocol-handoff/snapshot.cjs');
const evidence = require('./protocol-handoff/evidence.cjs');
// The one entry text model: the entry's own hash line and Evidence block, never a fenced example of them.
const entryText = require('./lib/entry-text.cjs');
const chain = require('./protocol-handoff/chain.cjs');
const gate = require('./protocol-handoff/gate.cjs');
const { anchor, checksFor, runCheck } = snapshot;
const { renderEvidence, formatWithEvidence, newestSection, findParentEntry, entryHash, readEvidence, assertJournalOwner } = evidence;
const { verifyJournalChain, resolveJournal, reportOne } = chain;
const { gateCheck } = gate;
const candidate = require('./protocol-handoff/candidate.cjs');
const { realInside } = require('./lib/path-safe.cjs');
const { spawnSync } = require('node:child_process');
const { secretIn } = require('./lib/secrets.cjs');
const reviewBinding = require('./lib/review-binding.cjs');

const PROVISIONAL_ENTRY = `sha256:${'0'.repeat(64)}`;

// The journal text with the block attached to its newest entry and the entry's own hash line set to the final entry hash,
// proven by the write postconditions of the entry text model (entryText.checkJournalWrite): { projected, updated } or
// { refusal } naming why nothing may be written.
function stampRecord(text, block, rel) {
  const projected = formatWithEvidence(text, block);
  if (projected === null) {
    return { refusal: `No dated entry in ${rel} outside a quote, or its newest entry opens a fence or an HTML comment it never closes. Write (or close) the entry first, then record evidence.` };
  }
  const dated = newestSection(projected);
  const digest = entryText.entryDigest(dated.sections[dated.index]);
  // The entry's own hash line in its own block is stamped, never a quoted example of the line.
  const updated = entryText.setEntryHash(projected, digest, PROVISIONAL_ENTRY);
  if (updated === null) {
    return { refusal: `${entryText.ENTRY_AMBIGUOUS}: cannot record evidence in ${rel}: an entry hash line of the entry stands before its Evidence block. ` +
      'Quote it as code (a fence or an indent) or remove it, then record again; nothing was written.' };
  }
  const proof = entryText.checkJournalWrite(text, updated, { kind: 'entry', hash: digest });
  if (!proof.ok) return { refusal: `Cannot record evidence: ${entryText.refusalMessage(proof, rel)}` };
  return { projected, updated };
}

// True when the newest entry with the block exceeds the journal line limit even alone under the preamble and an
// archived-parent marker: no archive move makes it fit.
function tooLongAlone(text, block) {
  const found = newestSection(text);
  const preamble = entryText.preamble(text);
  const marker = '<!-- archived-parent: sha256:' + '0'.repeat(64) + ' -->\n\n---\n\n';
  const single = (preamble.trim() ? preamble.trim() + '\n\n' : '') + marker + found.sections[found.index];
  return archive.getLineCount(formatWithEvidence(single, block)) > 150;
}

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
  // The launcher declares this mode explicitly for certifiers. Do not infer it
  // from a client's inherited no-full-suite guard or weaken receipt verification.
  if (command === 'record' && process.env.PROTOCOL_HANDOFF_MODE === 'certifier-validator-only') options.quick = true;
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
    assertJournalOwner(journalPath, options.owner, root);
    const relJournal = path.relative(root, journalPath);
    // The record is proven on the journal as it stands before anything is written (the archive move below included): a
    // block of the same shape is stamped in memory and the write postconditions are checked; a refusal writes nothing.
    // A broken historical link is refused first, by its name and by the phrase its readers match.
    {
      const standing = immutable ? candidate.guardedText(root, journalPath) : fs.readFileSync(journalPath, 'utf8');
      const placeholder = { commit: null, dirty: false, digest: `sha256:${'0'.repeat(64)}`, fileCount: 0, format: 0 };
      const parent = findParentEntry(journalPath);
      const link = parent === 'tampered' ? { ok: false, reason: 'Previous entry hash does not match its contents.' } : verifyJournalChain(root, journalPath);
      if (!link.ok) {
        throw new Error(`Cannot record evidence: ${entryText.ENTRY_CHAIN_BROKEN} in ${relJournal}: historical entry link is tampered. ${link.reason}; nothing was written.`);
      }
      const dry = stampRecord(standing, renderEvidence(placeholder, [], options.owner, PROVISIONAL_ENTRY, true, parent), relJournal);
      if (dry.refusal) throw new Error(dry.refusal);
      // An entry too long for the journal alone is refused before the archive move: a block of the lines the receipt
      // will hold (one per check and per review binding) stands in for it.
      if (!immutable) {
        const lines = checksFor(root, options.quick).map(check => ({ ...check, code: 0, seconds: 0 }));
        const bindings = reviewBinding.collectBindings(root, options.owner, evidence.entryBody(journalPath));
        const standIn = renderEvidence(placeholder, lines, options.owner, PROVISIONAL_ENTRY, Boolean(options.quick), parent)
          .replace('- recorded:', [...bindings.map(row => `- review-binding: ${JSON.stringify(row)}`), '- recorded:'].join('\n'));
        if (tooLongAlone(standing, standIn)) throw new Error(`Cannot record evidence in ${relJournal}: journal entry is too long; split the entry before recording.`);
      }
    }
    // Auto-archive older entries if journal exceeded 150 lines (Fork 2).
    try {
      if (!immutable) archive.autoArchiveWorklog(root, journalPath, 150, 1, options.owner);
    } catch { }
    const journalText = immutable ? candidate.guardedText(root, journalPath) : fs.readFileSync(journalPath, 'utf8');
    const reviewBindings = reviewBinding.collectBindings(root, options.owner, evidence.entryBody(journalPath));
    const bindingWarning = reviewBinding.missingBindingWarning(root, options.owner, reviewBindings);
    if (bindingWarning) process.stderr.write(`[WARN] ${bindingWarning}\n`);
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
    if (JSON.stringify(reviewBinding.collectBindings(root, options.owner, evidence.entryBody(journalPath))) !== JSON.stringify(reviewBindings)) {
      throw new Error('R-REVIEW-CHANGED during checks');
    }
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
    const provisionalEntry = PROVISIONAL_ENTRY;
    let evidenceBlock = renderEvidence(
      after, checks, options.owner, provisionalEntry, Boolean(options.quick || (immutable && candidateScope !== 'full')), parentEntry,
    );
    const bindCandidate = original => {
      const block = original.replace('- recorded:', [...reviewBindings.map(row => `- review-binding: ${JSON.stringify(row)}`), '- recorded:'].join('\n'));
      return immutable ? block.replace('- recorded:', [
      `- candidate: ${immutable.commit}`, `- candidate-baseline: ${immutable.baseline}`,
      `- candidate-tree: ${immutable.tree}`, `- candidate-digest: ${immutable.digest}`,
      `- candidate-scope: ${candidateScope}`, `- candidate-checks: ${checks.length}`, '- recorded:',
      ].join('\n')) : block;
    };
    evidenceBlock = bindCandidate(evidenceBlock);

    // From the read the receipt is stamped on to its one write, record holds the journal lock (the automatic archive move
    // inside holds it once, through the handle), and the write is compared with the bytes read (ENTRY_STALE otherwise).
    journalTool.withJournalLock(root, journalPath, lock => {
      let currentJournalBytes = fs.readFileSync(journalPath);
      let currentJournalText = currentJournalBytes.toString('utf8');
      let stamped = stampRecord(currentJournalText, evidenceBlock, relJournal);
      if (stamped.refusal) throw new Error(stamped.refusal);
      let projected = stamped.projected;

      if (archive.getLineCount(projected) > 150) {
        if (immutable) throw new Error('candidate journal exceeds 150 lines; archive separately before recording');
        if (tooLongAlone(currentJournalText, evidenceBlock)) {
          throw new Error(`Cannot record evidence in ${path.relative(root, journalPath)}: journal entry is too long; split the entry before recording.`);
        }

        // Archive older entries first (keep newest = 1)
        archive.autoArchiveWorklog(root, journalPath, 0, 1, options.owner, lock);
        currentJournalBytes = fs.readFileSync(journalPath);
        currentJournalText = currentJournalBytes.toString('utf8');

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
        stamped = stampRecord(currentJournalText, evidenceBlock, relJournal);
        if (stamped.refusal) throw new Error(stamped.refusal);
        projected = stamped.projected;
        if (archive.getLineCount(projected) > 150) {
          throw new Error(`Cannot record evidence in ${path.relative(root, journalPath)}: journal entry is too long; split the entry before recording.`);
        }
      }

      if (immutable && candidate.guardedText(root, journalPath) !== journalText) throw new Error('candidate journal changed during checks');
      const publish = text => {
        assertJournalOwner(journalPath, options.owner, root);
        const r = journalTool.writeCompared(root, journalPath, Buffer.from(text), currentJournalBytes, relJournal);
        if (!r.ok) throw new Error(immutable ? 'candidate journal publication refused' : `journal publication refused (${r.reason})`);
      };
      // Every receipt publishes once, with the final entry hash already in memory and the write proven (stampRecord): a
      // refusal writes nothing and an interrupted writer never leaves a provisional zero hash on disk.
      publish(stamped.updated);
    });
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
    // The folder is proven from the repository root, and a journal that is a link or a hardlink is not read (the rule of
    // gate.cjs and chain.checkOwnerReceipt): only this repository's own journals carry Evidence for its tree.
    const folder = realInside(path.resolve(root), path.resolve(directory));
    if (!folder.ok || folder.type !== 'dir') {
      process.stderr.write(`AI protocol: .ai/worklog is not a real folder inside the repository (${folder.ok ? folder.type : folder.reason}); no journal is read.\n`);
      return 1;
    }
    const journals = fs.readdirSync(directory)
      .filter(name => name.endsWith('.md') && name !== 'README.md')
      .map(name => path.join(directory, name))
      .filter(file => {
        const inside = realInside(path.resolve(root), path.resolve(file), { refuseHardlinks: true });
        if (inside.ok && inside.type === 'file') return true;
        process.stdout.write(`[WARN] journal ${path.relative(root, file).replace(/\\/g, '/')} does not stay inside .ai/worklog (${inside.ok ? inside.type : inside.reason}); not read\n`);
        return false;
      });
    const carrying = journals
      .map(file => ({ file, evidence: readEvidence(file) }))
      .filter(item => item.evidence);
    if (!carrying.length) {
      process.stderr.write('AI protocol: no journal carries an Evidence block. ' +
        'Run: node .ai/bin/protocol-handoff.cjs record --owner <session-id>\n');
      return 1;
    }
    const matching = carrying.filter(item => {
      if (item.evidence.candidate) {
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
      return chain.checkOwnerReceipt(root, item.file, { journalPath: item.file, state, deep: Boolean(options.deep) }).ok;
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
      const bindingProblem = reviewBinding.verifyBindings(root, path.basename(item.file, '.md'), item.evidence.body);
      const why = bindingProblem || (!item.evidence.authenticated
        ? 'evidence is not authenticated (legacy format)'
        : (item.evidence.entry !== null && item.evidence.entry !== entryHash(item.file)
        ? 'the entry was changed after it was certified'
        : item.evidence.format !== state.format
        ? `recorded with digest format ${item.evidence.format}, not comparable`
        : (item.evidence.digest === state.digest ? 'records a failing check' : 'anchored to a different tree')));
      process.stderr.write(`  ${path.relative(root, item.file)}: ${why}\n`);
    }
    return 1;
  }

  if (command === 'rehash') {
    if (!options.owner) throw new Error('rehash needs --owner <session id>');
    if (!options.reason) throw new Error('rehash needs --reason <text> explaining why the entry was changed');
    const journalPath = resolveJournal(root, options.journal, options.owner);
    assertJournalOwner(journalPath, options.owner, root);
    const evidence = readEvidence(journalPath);
    if (!evidence) throw new Error(`No Evidence block in ${path.relative(root, journalPath)}. Record evidence first.`);
    if (!evidence.entry) throw new Error('Evidence predates entry hashing. Re-record instead.');
    // Add the sanitized marker before hashing because authenticated Evidence
    // metadata is part of the canonical entry body. The read, the proof and the one write hold the journal lock, and the
    // write is compared with the bytes read.
    return journalTool.withJournalLock(root, journalPath, () => {
      const bytes = fs.readFileSync(journalPath);
      const text = bytes.toString('utf8');
      const marker = `- sanitized: ${new Date().toISOString()} reason: ${options.reason}`;
      const withMarker = entryText.addEvidenceLine(text, marker);
      if (withMarker === null) throw new Error('Could not locate the Evidence block of the newest entry.');
      // The new hash is computed in memory and the journal is written once: a refusal writes nothing.
      const dated = newestSection(withMarker);
      const currentHash = entryText.entryDigest(dated.sections[dated.index]);
      if (evidence.entry === currentHash && withMarker === text) {
        process.stdout.write(`${path.relative(root, journalPath)}: entry hash already matches; nothing to rehash.\n`);
        return 0;
      }
      const updated = entryText.setEntryHash(withMarker, currentHash);
      if (updated === null || updated === text) throw new Error('Could not locate the entry hash line in the Evidence block; nothing was written.');
      const proof = entryText.checkJournalWrite(text, updated, { kind: 'entry', hash: currentHash, restamp: true });
      if (!proof.ok) throw new Error(`Cannot rehash: ${entryText.refusalMessage(proof, path.relative(root, journalPath))}`);
      const written = journalTool.writeCompared(root, journalPath, Buffer.from(updated), bytes, path.relative(root, journalPath));
      if (!written.ok) throw new Error(`journal publication refused (${written.reason})`);
      process.stdout.write(`${path.relative(root, journalPath)}: entry hash updated (was ${evidence.entry}, now ${currentHash})\n`);
      process.stdout.write(`Reason: ${options.reason}\n`);
      return 0;
    });
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

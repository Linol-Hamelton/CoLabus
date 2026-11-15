'use strict';
// One reader and one proof for advisory plans, retirement and receipt recovery.
// All Git operations are read-only. A context is a snapshot of ONE line tip;
// apply must create a fresh context at the last recheck (pins can disappear).
const SHA = /^[0-9a-f]{40}$/;
const BRANCH = '[A-Za-z0-9][A-Za-z0-9._/-]*';
// The one Landed-Tip trailer reader. Presence is authoritative, including
// malformed/quoted trailers. Both kernel and host accept the trailer as the
// last line of the message or directly above the last Co-Authored-By line.
function readTrailer(message, { lastLine = false } = {}) {
  const lines = message.trimEnd().split('\n');
  const trailers = lines.map((s, i) => ({ s, i })).filter(({ s }) => /landed-tip\s*:/i.test(s));
  if (!trailers.length) return null;
  if (trailers.length !== 1) return { reason: 'TRAILER_MULTIPLE' };
  const { s, i } = trailers[0];
  let fenced = null;
  for (const previous of lines.slice(0, i)) {
    const mark = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(previous);
    if (!mark) continue;
    if (!fenced) fenced = { char: mark[1][0], length: mark[1].length };
    else if (mark[1][0] === fenced.char && mark[1].length >= fenced.length && /^\s*$/.test(mark[2])) fenced = null;
  }
  if (/^\s*>/.test(s) || fenced) return { reason: 'TRAILER_QUOTED' };
  if (!/^Landed-Tip: [0-9a-f]{40}$/.test(s)) return { reason: 'TRAILER_INVALID' };
  const aboveCoAuthor = i === lines.length - 2 && /^Co-Authored-By: [^\r\n]+$/.test(lines[i + 1]);
  if (i === 0 || !(aboveCoAuthor || (lastLine && i === lines.length - 1))) return { reason: 'TRAILER_POSITION' };
  const tip = s.slice(12);
  return { prefix: tip.slice(0, 8), tip, form: 'TRAILER' };
}
// Host landings are local squash commits of any subject: only the exact
// trailer proves them, never an eight-character or free-text citation.
function readHostLanding(message) {
  const trailer = readTrailer(message, { lastLine: true });
  if (!trailer) return { reason: 'TIP_MISSING' };
  return trailer.reason ? trailer : { branch: null, ...trailer };
}
function readLanding(message) {
  const subject = message.split('\n')[0];
  const heading = new RegExp(`^land (${BRANCH})(?: stage [1-9][0-9]*)? as one commit(?:$| \\(squash of the )`).exec(subject);
  if (!subject.startsWith('land ')) return { reason: 'NON_LANDING_COMMIT' };
  if (!heading) return { reason: 'LANDING_GRAMMAR' };
  // Never silently fall back to a different legacy declaration in the same message.
  const trailer = readTrailer(message, { lastLine: true });
  if (trailer) return trailer.reason ? trailer : { branch: heading[1], ...trailer };
  // Count declarations, not arbitrary hashes in review provenance. Repeated
  // declarations (even of the same tip) are ambiguous and never authorize work.
  const declarations = [...message.matchAll(/\b(?:branch )?tip\s+(\S+)/g)];
  if (declarations.length !== 1) return { reason: declarations.length ? 'MULTIPLE_TIPS' : 'TIP_MISSING' };
  const token = declarations[0][1];
  if (!/^[0-9a-f]{8}[:;]$/.test(token)) return { reason: 'TIP_PREFIX_INVALID' };
  const marker = `squash of the (?:certified )?branch tip ${token.slice(0, 8)}[:;]`;
  if (!new RegExp(`(?:^|[ (\\n])${marker}`).test(message)) return { reason: 'LANDING_GRAMMAR' };
  return { branch: heading[1], prefix: token.slice(0, 8) };
}
function createLandedProof({ repo, line, raw, registryRows = [], host = false }) {
  const cache = new Map();
  let landings;
  let provenTips;
  const ancestorCache = new Map();
  const tipHistories = new Map();
  const refused = (detail, reason = 'NOT_LANDED') => ({ ok: false, reason, detail });
  function call(args, negative = false) {
    const r = raw(repo, args);
    if (r.error || typeof r.stdout !== 'string' || ![0, ...(negative ? [1] : [])].includes(r.status)) {
      throw Error('GIT_REFUSED');
    }
    return r;
  }
  function messages() {
    if (!landings) {
      // No date cut in production: older legitimate landings remain proofs.
      // NUL is forbidden inside a commit message and separates exact records.
      // Local log.showSignature/gpg.program must not turn this read into an
      // executable verifier. Filter output before buffering; the reader still
      // checks the subject (grep can also match a line in a non-landing body).
      // A host reads every commit that mentions the trailer in any case, so a
      // malformed trailer is named rather than skipped, and parses only it.
      const filter = host ? ['--regexp-ignore-case', '--grep=landed-tip'] : ['--grep=^land '];
      const fields = call(['log', '--no-show-signature', '--no-notes', ...filter, '--format=%H%x00%B%x00', line]).stdout.split('\0');
      landings = [];
      for (let i = 0; i + 1 < fields.length; i += 2) {
        const commit = fields[i].trim(), message = fields[i + 1];
        if (!SHA.test(commit)) throw Error('GIT_REFUSED');
        if (host) { landings.push({ commit, ...readHostLanding(message), message }); continue; }
        if (!message.startsWith('land ')) continue;
        landings.push({ commit, ...readLanding(message), message });
      }
    }
    return landings;
  }
  function direct(head) {
    if (cache.has(head)) return cache.get(head);
    let proof;
    if (!SHA.test(head || '')) return refused('HEAD_UNRESOLVED');
    const resolved = call(['rev-parse', '--verify', '--quiet', `${head}^{commit}`], true);
    if (resolved.status === 1 || resolved.stdout.trim() !== head) return refused('HEAD_UNRESOLVED');
    const anc = call(['merge-base', '--is-ancestor', head, line], true);
    if (anc.status === 0) proof = { ok: true, landedBy: 'ANCESTOR', evidence: { head, line } };
    else {
      const prefix = head.slice(0, 8), all = messages();
      // Invalid declarations which mention this head must not be masked by a
      // second, apparently valid declaration in the same commit message.
      const bad = all.find(m => m.reason && m.message.includes(prefix));
      const cited = all.filter(m => !m.reason && (m.tip ? m.tip === head : m.prefix === prefix));
      if (!cited.length) proof = refused(bad ? bad.reason : 'NO_LANDING_CITATION');
      else if (new Set(cited.map(m => m.branch)).size !== 1) proof = refused('LANDING_BRANCH_AMBIGUOUS');
      else {
        const objects = call(['rev-parse', `--disambiguate=${prefix}`]).stdout.trim().split('\n').filter(Boolean);
        if (!cited[0].tip && (objects.length !== 1 || objects[0] !== head)) proof = refused('TIP_AMBIGUOUS');
        else {
          const pins = call(['for-each-ref', `--contains=${head}`, '--format=%(refname)', 'refs/heads/', 'refs/archive/']).stdout.trim().split('\n').filter(Boolean);
          if (!pins.length) proof = refused('TIP_NOT_PINNED');
          else proof = { ok: true, landedBy: 'SQUASH_CITED', evidence: { head, line, landing: cited[0].commit, branch: cited[0].branch, prefix, pins, citationForm: cited[0].form || 'LEGACY_8' } };
        }
      }
    }
    cache.set(head, proof);
    return proof;
  }
  function ancestorOfProven(head) {
    if (ancestorCache.has(head)) return ancestorCache.get(head);
    if (!provenTips) {
      // Finite snapshot: pinned ref tips plus cited tips which may be pinned
      // through a descendant ref. Worktree HEADs and Markdown are never pins.
      const pinned = call(['for-each-ref', '--format=%(objectname)', 'refs/heads/', 'refs/archive/']).stdout.trim().split('\n').filter(Boolean);
      if (pinned.some(t => !SHA.test(t))) throw Error('GIT_REFUSED');
      const candidates = new Set(pinned);
      for (const m of messages().filter(m => !m.reason)) {
        if (m.tip) candidates.add(m.tip);
        else {
          const ids = call(['rev-parse', `--disambiguate=${m.prefix}`]).stdout.trim().split('\n').filter(Boolean);
          if (ids.length === 1 && SHA.test(ids[0])) candidates.add(ids[0]);
        }
      }
      const collected = [];
      for (const tip of [...candidates].sort()) {
        const p = direct(tip);
        if (!p.ok || !['ANCESTOR', 'SQUASH_CITED'].includes(p.landedBy)) continue;
        // Kind 1 also needs a pin when used as the source of kind 4.
        const pins = call(['for-each-ref', `--contains=${tip}`, '--format=%(refname)', 'refs/heads/', 'refs/archive/']).stdout.trim().split('\n').filter(Boolean);
        if (!pins.length) continue;
        // Read each history once; merge-base confirms only positive matches.
        // This avoids O(heads * tips) negative Git processes on the real corpus.
        const history = tipHistories.get(tip) || new Set(call(['rev-list', tip]).stdout.trim().split('\n').filter(Boolean));
        if ([...history].some(id => !SHA.test(id))) throw Error('GIT_REFUSED');
        tipHistories.set(tip, history);
        collected.push({ tip, proof: p, pins, history });
      }
      provenTips = collected; // publish only a complete snapshot (timeouts retry)
    }
    const matched = [];
    for (const candidate of provenTips) {
      // Equality remains the exact-tip/certifier rule. Kind 4 cannot bypass it.
      if (candidate.tip === head || !candidate.history.has(head)) continue;
      if (call(['merge-base', '--is-ancestor', head, candidate.tip], true).status === 0) matched.push(candidate);
    }
    const first = matched[0];
    const result = first ? { ok: true, landedBy: 'ANCESTOR_OF_PROVEN_TIP', evidence: {
      head, line, provenTip: first.tip, matchedTips: matched.map(m => m.tip), provenBy: first.proof.landedBy,
      tipEvidence: first.proof.evidence, pins: first.pins,
    } } : null;
    ancestorCache.set(head, result);
    return result;
  }
  return function prove(tree) {
    try {
      const proof = direct(tree.head);
      if (!proof.ok) {
        if (proof.detail === 'HEAD_UNRESOLVED') return proof;
        return ancestorOfProven(tree.head) || proof;
      }
      if (proof.landedBy === 'ANCESTOR' || tree.branch) return proof;
      // Detached certifiers have no trustworthy branch name in worktree list.
      // Bind them by exact full SHA to the shared registry AND the landing's
      // branch, never by directory spelling or by a later branch tip.
      const rows = registryRows.filter(r => r.sha === tree.head);
      if (!rows.length) return ancestorOfProven(tree.head) || refused('CERTIFIER_TIP_MISMATCH');
      const row = rows.find(r => r.branch === proof.evidence.branch);
      if (!row) return ancestorOfProven(tree.head) || refused('REGISTRY_BRANCH_MISMATCH');
      return { ok: true, landedBy: 'CERTIFIER_DETACHED', evidence: { ...proof.evidence, provenBy: proof.landedBy, registry: { branch: row.branch, sha: row.sha, stream: row.stream } } };
    } catch (e) {
      if (e.message !== 'GIT_REFUSED') throw e;
      return refused('GIT_CALL_FAILED', 'GIT_REFUSED');
    }
  };
}
module.exports = { readLanding, readHostLanding, readTrailer, createLandedProof };

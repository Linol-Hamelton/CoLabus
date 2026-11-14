'use strict';
const fs = require('node:fs');
const path = require('node:path');
const accounting = require('../../.ai/bin/accounting/launch-stats.cjs');
const paths = require('../../.ai/bin/repo-paths.cjs');
const kernel = require('../../.ai/bin/accounting/launch-record-validate.cjs');
const { LIVE_TTL_MS, isFreshEvidence } = require('./live-policy.cjs');
const FAILURES = Object.freeze(['TRANSPORT_EXHAUSTED', 'TRANSPORT', 'PROXY_DROP', 'QUOTA', 'AUTH',
  'PROVIDER_UNAVAILABLE', 'QUOTA_EXCEEDED', 'AUTH_FAILED', 'PAYMENT_OVERDUE', 'NO_CREDITS',
  'SERVED_MODEL_MISMATCH', 'SERVED_FAMILY_MISMATCH']);
const PROOF_SOURCES = Object.freeze(['client-banner', 'client-log']);

// accounting.launches remains the only event join. Repeated journal/pending
// copies are deduplicated; conflicting starts or terminal exits cannot certify.
// Two terminal records conflict when they differ in anything the outcome or the proof reads: the answer signs of
// answerSigns and the recovered flag included, so the input order never picks the answer (refresh joins here too).
function joinEntries(entries) {
  const { launchRecordProblem } = require('./launch-journal.cjs');
  const seen = new Set(), starts = new Set(), terminal = new Map(), bad = new Set(), records = [];
  for (const entry of entries) {
    const r = entry.record;
    if (launchRecordProblem(r) || kernel.validateRecord(r).length) { if (r?.launchId) bad.add(r.launchId); continue; }
    const key = JSON.stringify(r);
    if (seen.has(key)) continue;
    seen.add(key);
    if (!r.event || r.event === 'started') {
      if (starts.has(r.launchId)) bad.add(r.launchId);
      starts.add(r.launchId);
    }
    if ((!r.event || r.event === 'finished') && Object.hasOwn(r, 'exitCode')) {
      const signature = JSON.stringify([r.exitCode, r.endedAt, r.failureClass || null, r.servedModel || null,
        r.servedModelSource || null, r.servedModelConfidence || null, r.verdict || null, r.tokens?.output ?? null, r.launchRole || null, r.role || null,
        kernel.recovered(r), answerSigns(r, true)]);
      if (terminal.has(r.launchId) && terminal.get(r.launchId) !== signature) bad.add(r.launchId);
      terminal.set(r.launchId, signature);
    }
    records.push(r);
  }
  return accounting.launches(records.filter(r => !bad.has(r.launchId)));
}

function readLiveLaunches(files) {
  const reader = require('./launch-journal.cjs');
  if (files !== undefined) return joinEntries(reader.readJournals(files));
  const journals = reader.defaultJournals().filter(file => fs.existsSync(file));
  // Unsynced launches are the freshest records. Read only the canonical pending
  // directories; the sync ledger and wrapper diagnostic JSON are never evidence.
  for (const dir of [paths.pendingDir(), path.join(paths.runtimeDir(), 'launch-record-pending')]) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter(n => n.endsWith('.jsonl')).sort()) journals.push(path.join(dir, name));
  }
  return joinEntries(reader.readJournals([...new Set(journals)]));
}

// Identity follows the launched route, never answer text. The first-party rule is
// launch-identity's one function, shared with the probe and the route record.
const { firstParty, servedMatch, certificationProblem } = require('./launch-identity.cjs');
// A proven id is one of the closed grammar the route record stores (the served pattern of route-state.schema.json, the
// grammar served-model.cjs accepts at every point a served id is read): a value outside it never proves.
const PROOF_ID = new RegExp(require('../../docs/ops/route-state.schema.json').$defs.measuredProbe.properties.value.properties.served.pattern);
// The one client-proof rule of a launch, shared with refresh. Proof keys must travel together
// in one producer record. Never combine a requested model from one event with an unrelated
// proof from another event.
function proofOf(...records) {
  return records.find(r => r && typeof r.servedModel === 'string' && PROOF_ID.test(r.servedModel) && PROOF_SOURCES.includes(r.servedModelSource)
    && ['exact', 'derived'].includes(r.servedModelConfidence)) || null;
}
const VERDICTS = Object.freeze(['PASS', 'FAIL', 'BLOCKED', 'RECOMMENDATION']);
const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
// The answer signs one record carries, as a fixed tuple: a verdict, client output tokens, the launcher's report validation
// marker report=ok (read on the terminal record only) and a non-empty Markdown output. A recovered record (the kernel
// predicate: backfilled, or a flag that is not exactly false) carries none, on any event, a review included.
function answerSigns(r, terminal) {
  if (kernel.recovered(r)) return [false, false, false, false];
  return [VERDICTS.includes(r.verdict), Number.isSafeInteger(r.tokens?.output) && r.tokens.output > 0,
    terminal && typeof r.note === 'string' && /(?:^| )report=ok(?: |$)/.test(r.note),
    Array.isArray(r.outputs) && r.outputs.some(o => /\.md$/i.test(o?.path || '') && /^[a-f0-9]{64}$/.test(o?.sha256 || '') && o.sha256 !== EMPTY_SHA256)];
}
// The one outcome rule of a joined launch, shared with refresh. failure: the kernel's failure class of the launch when it
// is a provider or identity failure (FAILURES), else null. answered: a sign the launcher or the client owns that the
// model answered (answerSigns of the terminal record or the start, or the verdict of a review that is not recovered).
// Neither a start event, an exit code alone, nor the model's own words prove an answer.
function outcomeOf(launch) {
  const s = launch.start, f = launch.fin || s;
  const reason = accounting.failureClassOf(launch);
  const answered = answerSigns(f, true).includes(true) || answerSigns(s, false).includes(true)
    || (launch.reviews || []).some(r => !kernel.recovered(r) && VERDICTS.includes(r.verdict));
  return { failure: FAILURES.includes(reason) ? reason : null, answered };
}
function certification(launch, opts) {
  if (opts.purpose === 'certification' || opts.role === 'certifier') return true;
  // Advice reports route availability even when an unproven certifier answered;
  // that answer still cannot qualify as certification evidence.
  if (opts.purpose === 'advice') return false;
  return [launch.start, launch.fin].some(r => r?.launchRole === 'certifier' || r?.role === 'certifier');
}
// A recovered record (backfilled true, or a flag that is not exactly false) never proves an
// answer or a served model, on either event: its values stay unknown (refresh.cjs does the same).
// The rule is the kernel's one predicate, shared with seat-check, certifier-rating and cert-count.
const { recovered } = kernel;
function evidenceOf(launch, route, opts = {}) {
  const s = launch.start, f = launch.fin || s;
  if (!s || s.tuple?.client !== route.client || s.tuple?.model !== route.model || recovered(s) || recovered(f)) return null;
  const start = Date.parse(s.startedAt), end = Date.parse(f.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || !Number.isInteger(f.exitCode)) return null;
  const base = { source: 'launch', basis: 'launch-command', at: new Date(end).toISOString(), expiresAt: new Date(end + LIVE_TTL_MS).toISOString(), servedModel: null, ok: false,
    warnings: f.exitCode !== 0 ? ['LAUNCH_EXIT_NONZERO'] : [], identityProblem: null };
  const outcome = outcomeOf(launch);
  if (outcome.failure) return { ...base, reason: outcome.failure };
  if (!outcome.answered) return { ...base, reason: f.exitCode !== 0 ? 'LAUNCH_EXIT_NONZERO' : 'LAUNCH_NO_ANSWER' };
  const proof = proofOf(f, s);
  const matched = proof && servedMatch(route, proof.servedModel) === true;
  // An answered launch carries the identity problem of launch-identity's one rule (the rule of a stored probe), so the
  // state names a proven other model or an unproven proxy in every purpose, not only for certification.
  const identityProblem = certificationProblem(route, proof && { served: proof.servedModel, servedSource: proof.servedModelSource });
  // The launch identity of a first-party route never overrides a proof of another model.
  if (firstParty(route) && (!proof || matched)) return { ...base, servedModel: route.model, ok: true, reason: null, identityProblem };
  if (certification(launch, opts)) {
    if (!proof) return { ...base, reason: 'LAUNCH_SERVED_UNPROVEN', identityProblem };
    if (!matched) return { ...base, basis: 'client-proof', reason: 'SERVED_MODEL_MISMATCH', identityProblem };
  }
  // For authors/advice an answer proves availability even without model proof.
  // Keep servedModel null unless a client-owned proof actually matches.
  return { ...base, basis: proof ? 'client-proof' : 'launch-command', servedModel: matched ? route.model : null, ok: true, reason: null, identityProblem };
}

// The one selection order of launch evidence, shared with refresh: the newest first; a failure wins equal timestamps, then
// an identity problem (a proven other model or an unproven proxy: PUB-FIX4 pfx4g, Sol p6s940 F4), so neither reader and no
// purpose drops the restriction an equal-time launch proves; then one canonical order of the values, so input order is
// never an availability or identity policy.
function newestFirst(a, b) {
  const x = JSON.stringify(a), y = JSON.stringify(b);
  return Date.parse(b.at) - Date.parse(a.at) || Number(a.ok) - Number(b.ok)
    || Number(!a.identityProblem) - Number(!b.identityProblem) || (x < y ? -1 : x > y ? 1 : 0);
}
function latestEvidence(launches, route, now, opts = {}) {
  const candidates = launches.map(l => evidenceOf(l, route, opts)).filter(e => e && isFreshEvidence(e, now));
  candidates.sort(newestFirst);
  return candidates[0] || null;
}
function hasRecentLaunch(launches, route, now) {
  return launches.some(l => l.start?.tuple?.client === route.client && l.start?.tuple?.model === route.model
    && !recovered(l.start) && Number.isFinite(Date.parse(l.start.startedAt))
    && Date.parse(l.start.startedAt) <= now && now < Date.parse(l.start.startedAt) + LIVE_TTL_MS)
    || latestEvidence(launches, route, now) !== null;
}
module.exports = { FAILURES, PROOF_SOURCES, firstParty, proofOf, outcomeOf, newestFirst, joinEntries, readLiveLaunches, evidenceOf, latestEvidence, hasRecentLaunch };

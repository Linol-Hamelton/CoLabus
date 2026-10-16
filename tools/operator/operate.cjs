'use strict';
// L1-DYNAMIC-OPERATOR: the one command that takes the operator role.
// `operate` loads the operator context from files (registry, seats, pairs,
// pending landings, the last handover) and writes the operator claim in one
// operation under the common operator lock. The role is held by a claim file in
// the operator state root, never by a chat statement (ROLE-operator draft,
// operator contract). Nothing here launches, lands or deletes anything.
// Every refusal is an S.fail with a literal reason, so the refusal inventory of
// the operator package sees each one.
const crypto = require('node:crypto');
const fs = require('node:fs');
const S = require('./state.cjs');
const seats = require('./seats.cjs');
const CLAIM = 'operator-claim.json', HANDOVER = 'operator-handover.json';
const CLAIM_KEYS = ['schema', 'owner', 'token', 'claimedAt', 'renewedAt', 'handoverFrom', 'handoverDigest', 'takeover'];
const HANDOVER_KEYS = ['schema', 'from', 'releasedAt', 'note', 'counts', 'digest'];
const COUNT_KEYS = ['candidates', 'seats', 'openPairs', 'pendingLandings'];
const NOTE_LIMIT = 2000, REASON_LIMIT = 300;
const iso = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) && Number.isFinite(Date.parse(value));
// Keys are sorted at every depth: a nested object (the counts) is part of the digest.
const sorted = value => Array.isArray(value) ? value.map(sorted) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])])) : value;
const canonical = value => JSON.stringify(sorted(value));
const digestOf = handover => crypto.createHash('sha256').update(canonical({ ...handover, digest: undefined })).digest('hex');
// Free text written into a record: non-blank, closed length, no control
// character, the shared text decision (BOM, bidi, zero width, NFC, lone
// surrogates) and the secret scan every contract goes through. The text is
// stored exactly as given, or the whole operation is refused.
function textOk(value, limit) {
  if (typeof value !== 'string' || !value.trim() || value.length > limit || /[\u0000-\u001f\u007f]/.test(value)) return false;
  try { S.inputText(value); } catch { return false; }
  return !require('../../.ai/bin/protocol-hooks.cjs').findSecretLeak(JSON.stringify(value));
}
function present(ctx, file) {
  return fs.existsSync(ctx.stateRoot) && fs.existsSync(ctx.guard(ctx.stateRoot, file));
}
function claimValid(claim) {
  try {
    S.keys(claim, CLAIM_KEYS, ['schema', 'owner', 'token', 'claimedAt']);
    S.id(claim.owner);
    if (claim.renewedAt !== undefined && !iso(claim.renewedAt)) return false;
    if (claim.handoverFrom !== undefined) S.id(claim.handoverFrom);
    if (claim.handoverDigest !== undefined && !/^[0-9a-f]{64}$/.test(claim.handoverDigest)) return false;
    if (claim.takeover !== undefined) {
      S.keys(claim.takeover, ['from', 'reason'], ['from', 'reason']);
      S.id(claim.takeover.from);
      if (!textOk(claim.takeover.reason, REASON_LIMIT)) return false;
    }
    return claim.schema === 'operator-claim/1' && /^[0-9a-f]{32}$/.test(claim.token) && iso(claim.claimedAt);
  } catch { return false; }
}
function handoverValid(handover) {
  try {
    S.keys(handover, HANDOVER_KEYS, HANDOVER_KEYS);
    S.keys(handover.counts, COUNT_KEYS, COUNT_KEYS);
    S.id(handover.from);
    if (!COUNT_KEYS.every(key => Number.isSafeInteger(handover.counts[key]) && handover.counts[key] >= 0)) return false;
    return handover.schema === 'operator-handover/1' && iso(handover.releasedAt) && /^[0-9a-f]{64}$/.test(handover.digest)
      && textOk(handover.note, NOTE_LIMIT) && digestOf(handover) === handover.digest;
  } catch { return false; }
}
// A record that cannot be read is never treated as absent: an unknown state is
// refused, not taken over as an empty one (R-L1-operator.3).
function readClaim(ctx) {
  if (!present(ctx, CLAIM)) return null;
  let claim = null;
  try { claim = ctx.json(ctx.stateRoot, CLAIM); } catch { claim = null; }
  if (!claim || !claimValid(claim)) S.fail('invalid-claim');
  return claim;
}
function readHandover(ctx) {
  if (!present(ctx, HANDOVER)) return null;
  let handover = null;
  try { handover = ctx.json(ctx.stateRoot, HANDOVER); } catch { handover = null; }
  if (!handover || !handoverValid(handover)) S.fail('invalid-handover');
  return handover;
}
// The operator context as bounded lines. The registry must pass the strict
// parser: an unreadable registry refuses the whole operation.
function context(ctx) {
  const lines = [], registry = seats.registryDocument(ctx), state = ctx.load();
  const live = registry.rows.filter(row => ['building', 'ready', 'certifying', 'certified'].includes(row.cells[4]));
  lines.push(`registry rows=${registry.rows.length} live=${live.length}`);
  for (const { cells } of live) lines.push(`registry-live ${S.id(cells[0])} ${S.branch(cells[1])} ${S.sha(cells[2])} ${cells[4]}`);
  const rows = Object.keys(state.seats).map(id => seats.reportStatus(ctx, state.seats[S.id(S.seatKey(id))]));
  const open = Object.entries(state.pairs).filter(([, pair]) => pair.status === 'open');
  const pending = Object.entries(state.landings).filter(([, landing]) => landing.status !== 'closed');
  lines.push(`context candidates=${Object.keys(state.candidates).length} seats=${rows.length} open-pairs=${open.length} pending-landings=${pending.length}`);
  for (const row of rows) lines.push(`seat ${S.id(row.seat)} ${row.verdict || 'UNKNOWN'} ${row.lines === null ? 'unknown' : row.lines} ${row.done ? 'done' : row.running ? 'running' : 'unknown'}`);
  for (const [id] of open) lines.push(`pair ${S.id(id)} open`);
  for (const [id, landing] of pending) lines.push(`landing ${S.id(id)} ${['preparing', 'ready', 'landed-local', 'closing', 'blocked'].includes(landing.status) ? landing.status : 'unknown'}`);
  return { lines, counts: { candidates: Object.keys(state.candidates).length, seats: rows.length, openPairs: open.length, pendingLandings: pending.length } };
}
const claimLine = claim => `operator-claim holder=${claim.owner} since=${claim.claimedAt}`;
// o = { owner, release, takeover, reason, note, dryRun }
async function operate(ctx, o, emit) {
  const owner = S.id(o.owner), now = () => new Date().toISOString();
  if (o.release && o.takeover !== undefined) S.fail('usage');
  if (o.reason !== undefined && o.takeover === undefined || o.note !== undefined && !o.release) S.fail('usage');
  if (o.takeover !== undefined) { S.id(o.takeover); if (!textOk(o.reason, REASON_LIMIT)) S.fail('takeover-reason-required'); }
  const note = o.release ? (o.note === undefined ? 'released without a note' : o.note) : undefined;
  if (o.release && !textOk(note, NOTE_LIMIT)) S.fail('invalid-handover-note');
  const run = async () => {
    const claim = readClaim(ctx), handover = readHandover(ctx), loaded = context(ctx);
    if (o.release) {
      if (!claim || claim.owner !== owner) { if (claim) emit(claimLine(claim)); S.fail('not-operator'); }
      const record = { schema: 'operator-handover/1', from: owner, releasedAt: now(), note, counts: loaded.counts };
      record.digest = digestOf(record);
      if (o.dryRun) { for (const line of loaded.lines) emit(line); emit(`operator-release holder=${owner} mode=dry-run`); return; }
      // The handover is published before the claim is retired: an interrupted
      // release leaves the claim held and the retry rewrites the same handover.
      ctx.write(ctx.stateRoot, HANDOVER, record);
      fs.renameSync(ctx.guard(ctx.stateRoot, CLAIM), ctx.guard(ctx.stateRoot, `operator-claim-${claim.token}.released`));
      emit(`operator-release holder=${owner} handover=written`);
      return;
    }
    const fresh = extra => ({ schema: 'operator-claim/1', owner, token: crypto.randomBytes(16).toString('hex'), claimedAt: now(), ...extra, ...(handover ? { handoverFrom: handover.from, handoverDigest: handover.digest } : {}) });
    let next, mode;
    // A takeover names the exact holder it replaces and the reason; it is never
    // a no-op: without that holder present it is refused.
    if (o.takeover !== undefined) {
      if (!claim || claim.owner !== o.takeover || claim.owner === owner) { if (claim) emit(claimLine(claim)); S.fail('takeover-target-mismatch'); }
      next = fresh({ takeover: { from: claim.owner, reason: o.reason } }); mode = 'taken-over';
    } else if (!claim) { next = fresh({}); mode = 'claimed'; }
    else if (claim.owner === owner) { next = { ...claim, renewedAt: now() }; mode = 'renewed'; }
    else { emit(claimLine(claim)); S.fail('operator-claimed'); }
    for (const line of loaded.lines) emit(line);
    if (o.dryRun) { emit(`operator-claim holder=${owner} mode=dry-run would=${mode}`); return; }
    ctx.write(ctx.stateRoot, CLAIM, next);
    // A new claim consumes the handover it just read: the file is kept under a
    // name that records what it was, never deleted and never shown twice.
    const consume = handover && (mode !== 'renewed' || next.handoverDigest === handover.digest);
    if (consume) fs.renameSync(ctx.guard(ctx.stateRoot, HANDOVER), ctx.guard(ctx.stateRoot, `operator-handover-${handover.digest.slice(0, 16)}.read`));
    if (consume) emit(`handover from=${handover.from} at=${handover.releasedAt} candidates=${handover.counts.candidates} seats=${handover.counts.seats} open-pairs=${handover.counts.openPairs} pending-landings=${handover.counts.pendingLandings} note=${JSON.stringify(handover.note)}`);
    else emit('handover none');
    emit(`operator-claim holder=${owner} mode=${mode} since=${next.claimedAt}`);
  };
  // A dry run reads only: it takes no lock and creates no directory.
  return o.dryRun ? run() : ctx.transaction('operator', run);
}
module.exports = { operate, readClaim, readHandover, context, digestOf, CLAIM, HANDOVER };

'use strict';
// The assignment bridge: the only module that knows both the operator kit and
// the assignment layer. It never launches anything itself: it verifies an assignment
// against the hard constraints AGAIN (the hard floors, independence, one MiMo seat,
// route availability, staleness), fills seat contracts with an EXPLICIT route
// (client and model are always named) and records feedback.
// Nothing in an assignment file is trusted: every row is re-derived from the
// selection layer and every route state is re-verified against the clock.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const S = require('./state.cjs');
const seatsApi = require('./seats.cjs');
const { closedInteger } = require('./closed-number.cjs');
const io = require('../assign/io.cjs');
const { providerExcluded, seatInPool } = require('../assign/route-limits.cjs');
const ownerFilter = require('../../.ai/bin/lib/selection-owner.cjs');
const { assign, quotaContext, quotaPreview, loadOwnerRules, ownerRuleReasons } = require('../assign/assign.cjs');
const { complexity, KINDS } = require('../assign/complexity.cjs');
const tc = require('../assign/task-classifier.cjs');
const selectionPolicy = require('../assign/selection-policy.cjs');
let cachedPolicies;
function policies() {
  if (!cachedPolicies) {
    const canonicalPolicy = selectionPolicy.loadPolicy().obj;
    cachedPolicies = { canonicalPolicy, policy: selectionPolicy.assignPolicy(canonicalPolicy) };
  }
  return cachedPolicies;
}
const feedback = require('../assign/feedback.cjs');
const adapter = { loadCatalog: () => ({ ok: false, reason: 'selection-not-shipped' }) };
const { independenceOf, excludesRoute } = require('../../.ai/bin/lib/selection-constraints.cjs');
const { maskMarkdown } = require('../../.ai/bin/lib/text-safe.cjs');
const { sameFileOrNested } = require('../../.ai/bin/lib/path-safe.cjs');
const { readVerdict } = require('../../.ai/bin/lib/verdict-read.cjs');
const risk = require('../../docs/ops/risk-class.cjs');
const routeState = require('../operator-knowledge/route-state.cjs');
const ASSIGN_ROLES = { author:'author', fixer:'fixer', reviewer:'pre-reviewer', certifier:'certifier' };
const CONTROL_KEYS = ['author','fixer','preReviewer','operator','certifiers'];
const ASSIGN_ROOT = path.resolve(__dirname, '../..');

function machineId() { return 'm-' + io.hash(os.hostname()).slice(0, 24); }

// An operator-provided file anywhere on the machine: real file, no links, no
// hardlinks, strict UTF-8 (BOM refused), unique JSON keys, closed by the
// assign io guards. The content never reaches output unscanned.
function readOperatorJson(file, maxBytes = 4 * 1024 * 1024) {
  const abs = path.resolve(file);
  const dir = path.dirname(abs);
  const g = io.guard(dir, path.basename(abs));
  if (!g.exists || g.type !== 'file') S.fail('input-file-missing');
  const value = io.readJson(dir, path.basename(abs), maxBytes);
  // JSON escapes are decoded only after the file text guard has run. Check
  // every resulting key and value before any caller can publish it.
  S.inputText(value);
  return value;
}

function isMiMo(row) {
  const { policy } = policies();
  // cline serves a closed model table since 2026-10-30 (cline-route.cjs): the singleSeat client rule holds only for a model outside it or one that names MiMo
  if (row.client === 'cline') return require('../../.ai/bin/lib/cline-route.cjs').holdsMimoLease(row.model) || [row.model, row.modelId].some(m => typeof m === 'string' && /(?:^|[/:])mimo(?:$|[-/])/i.test(m));
  return policy.singleSeat.clients.includes(row.client)
    || [row.model, row.modelId].some(m => typeof m === 'string' && /(?:^|[/:])mimo(?:$|[-/])/i.test(m));
}

// Seats of this repository that may still be running hold their route.
function kitActiveSeats(ctx) {
  const s = ctx.load();
  return Object.values(s.seats)
    .filter(r => r.endedAt === null && r.contract && r.contract.route && r.contract.route.client && r.contract.route.model)
    .map(r => ({ client: r.contract.route.client, model: r.contract.route.model }));
}

function loadLayer(catalogRoot) {
  const root = catalogRoot ? path.resolve(catalogRoot) : ASSIGN_ROOT;
  const catalog = adapter.loadCatalog({ repoRoot: root });
  if (!catalog.ok) S.fail('catalog-unavailable');
  return catalog;
}

// Route identity re-derived from the selection layer (the positive grammar:
// a route exists only when the clients registry positively lists the model).
function layerIndex(catalog) {
  let rows;
  try { rows = adapter.routes(catalog); } catch { S.fail('catalog-unavailable'); }
  const map = new Map();
  for (const r of rows) {
    // Neither an advisory choice nor a manual override can resurrect a closed
    // client, a non-text model or a provider the owner has excluded. A closed
    // client (cap 0) and a closed route (route cap 0) both close the row.
    if (r.closed || r.withdrawn || r.kind !== 'text' || providerExcluded(catalog.ownerRules, r)) continue;
    const key = `${r.client}\u0000${r.model}`;
    const identity = { modelId: r.modelId, maker: r.maker, transport: r.cfg.transport || r.client, family: (r.alias && r.alias.family) || r.modelId,
      provider: r.provider, billing: r.billing,
      clientCap: r.clientCap === undefined ? null : r.clientCap, routeCap: r.routeCap === undefined ? null : r.routeCap,
      capProvider: r.capProvider || null, capExcludedProviders: r.capExcludedProviders || [] };
    const found = map.get(key);
    if (found) {
      const { efforts, ...foundIdentity } = found;
      if (io.canonical(foundIdentity) !== io.canonical(identity)) S.fail('route-identity-conflict');
      efforts.add(r.effort);
    }
    else map.set(key, { ...identity, efforts: new Set([r.effort]) });
  }
  return map;
}

// The nested pools of the seat policy (item 5.9): a seat on a sub-route takes one unit of
// the CLIENT pool and one unit of the ROUTE pool. The check is pure over the given seats; a seat is in the
// route pool by the one pool rule of the selection (seatInPool), so every spelling of one model takes the same unit.
function poolReached(row, seats) {
  const client = seats.filter(s => s.client === row.client);
  if (row.clientCap !== null && row.clientCap !== undefined && client.length >= row.clientCap) return true;
  if (row.routeCap !== null && row.routeCap !== undefined) {
    const route = seats.filter(s => seatInPool(s, row));
    if (route.length >= row.routeCap) return true;
  }
  return false;
}

// The seat contract's own lineage is a second source the operator file
// controls. For a reviewing seat the author, operator, fixer and pre-reviewer
// it names must not be the very model about to review: the kit checks that
// against the contract's self-declared labels, the bridge re-checks it against
// the layer-derived route identity.
function seatLineage(request, drafts, role) {
  const tokens = CONTROL_KEYS.flatMap(k => request.lineage[k]);
  if (!['certifier', 'pre-reviewer'].includes(role)) return tokens;
  for (const d of drafts) tokens.push(d.lineage.author, d.lineage.operator, ...d.lineage.fixers, ...d.lineage.preReviewers);
  return tokens;
}

// The re-checks the task demands. Runs on every chosen row and every override,
// regardless of what the file claims.
function checkRoute({ index, request, row, role, tier, riskClass, lineage, chosen, activeSeats, now, ownerContext, eligibleRoutes = [] }) {
  const { policy } = policies();
  const route = index.get(`${row.client}\u0000${row.model}`);
  if (!route || route.modelId === null) S.fail('route-unknown');
  if (row.modelId !== route.modelId || row.maker !== route.maker
      || row.transport !== route.transport || row.family !== route.family) S.fail('route-identity-conflict');
  if (row.effort !== null && row.effort !== undefined && !route.efforts.has(row.effort)) S.fail('route-effort-conflict');
  // The closed set of reviewing roles in BOTH spellings: the kit role reviewer
  // arrives here as the assign role pre-reviewer, so both must be listed or the
  // check is a dead branch. The maker comes from the
  // catalog entry, never from the model name, and folds to one case on both
  // sides: a loadable layer that spells the excluded maker differently is
  // still refused.
  if (['certifier','reviewer','pre-reviewer'].includes(role)
      && policy.reviewExcludedMakers.some(m => String(m).toLowerCase() === String(route.maker || '').toLowerCase())) S.fail('add60-route-forbidden');
  // The spending guard is a hard constraint, re-derived here for the chosen and
  // the override row alike: an excluded row may never launch through the
  // override path. Same semantics as the assign layer's exclusion,
  // including the risk class: the bridge uses the highest DERIVED risk of the
  // task, never the operator's declared spelling, so it can never be stricter
  // or looser than the layer that made the decision.
  if (policy.topModel.modelIds.some(m => m === row.model || m === route.modelId)
      && (policy.topModel.forbiddenKinds.includes(request.task.kind)
        || Number(String(tier).slice(1)) < policy.topModel.minTier
        || !(riskClass === 'A' && io.count(request.task.failedRounds) && request.task.failedRounds >= policy.topModel.minFailedRounds
          || request.task.superImportant === true || request.task.kind === 'design'))) S.fail('top-model-policy');
  // The owner rules hold for the chosen and the override row alike, read from
  // the same data file as the assign layer; the identity comes from the catalog
  // entry, the effort from the row.
  let ownerRules;
  try { ownerRules = loadOwnerRules(ASSIGN_ROOT); } catch { S.fail('owner-rules-invalid'); }
  const ownerReasons = ownerRuleReasons(ownerRules, { model: row.model, modelId: route.modelId, maker: route.maker, effort: row.effort ?? null });
  if (ownerReasons.includes('owner-model-excluded')) S.fail('owner-model-excluded');
  if (ownerReasons.includes('owner-effort-range')) S.fail('owner-effort-range');
  let ind;
  try { ind = independenceOf({ lineage }); }
  catch { S.fail('independence-violation'); }
  if (excludesRoute(ind, { model: row.model, modelId: route.modelId, maker: route.maker, client: row.client, transport: route.transport, family: route.family })) S.fail('independence-violation');
  const ownerPool = ownerFilter.filterRoutes([{ ...row, ...route, model: row.model, client: row.client, effort: row.effort ?? null }], { ownerRules, role,
    mode: 'assign', tier, requireOwnerRules: true, ownerContext: { ...ownerContext, now, activeSeats: [...request.activeSeats, ...activeSeats, ...chosen] },
    alternativeRoutes: eligibleRoutes, independence: { lineage } });
  if (!ownerPool.allowed.length) S.fail(ownerPool.reason === 'independence' ? 'independence-violation' : ownerPool.reason);
  if (isMiMo(row) && (request.activeSeats.some(isMiMo) || activeSeats.some(isMiMo) || chosen.some(isMiMo))) S.fail('mimo-busy');
  if (chosen.some(c => c.transport === row.transport)) S.fail('duplicate-transport');
  if (chosen.some(c => c.modelId === row.modelId || c.family === row.family)) S.fail('same-model-family');
  const st = (request.routeStates || []).find(s => s.client === row.client && s.model === row.model);
  if (!st) S.fail('route-state-missing');
  const at = Date.parse(st.at);
  if (typeof st.at !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d[:]\d\d[:]\d\d\.\d{3}Z$/.test(st.at)
      || !Number.isFinite(at) || at > now || now - at > policy.routeProofMaxAgeMs) S.fail('route-proof-stale');
  if (st.available !== true) S.fail('route-unavailable');
  if (st.servedModel !== row.model || !/^[a-f0-9]{64}$/.test(st.proofSha256 || '')) S.fail('served-model-unproven');
  if (typeof st.balanceUsd === 'number' && (!Number.isFinite(st.balanceUsd) || st.balanceUsd <= 0)
      || !(typeof st.balanceUsd === 'number' && st.balanceUsd > 0) && !(st.billingKnown === true && ['free', 'subscription'].includes(route.billing))) S.fail('route-no-balance');
}

// A stale assignment is refused: the tier and the policy hash recorded in the
// file must match a fresh recomputation, and the whole file must reproduce.
function verifyDecision(file, decision) {
  const { canonicalPolicy } = policies();
  if (!io.object(file) || file.schema !== 'assignment/1') S.fail('assignment-schema');
  io.publicValue(file);
  if (file.status !== 'ASSIGNED') S.fail(`assign-blocked:${/^[a-z0-9-]{1,60}$/.test(file.reason || '') ? file.reason : 'reason-unknown'}`);
  if (file.role !== decision.role) S.fail('assignment-stale');
  if (!io.object(file.classification) || file.classification.policyHash !== io.hash(canonicalPolicy.taskPolicy)) S.fail('policy-stale');
  if (file.tier !== decision.tier) S.fail('assignment-stale');
  if (io.canonical(file) !== io.canonical(decision)) S.fail('assignment-not-reproducible');
}

// Draft contract grammar for the assignment modes: the route names the local
// executable; client/model/transport/effort are optional constraints. Everything
// else is checked by the strict contract validator on a completed probe.
function validateDraft(draft) {
  if (!io.object(draft) || !io.object(draft.route)) S.fail('invalid-contract');
  S.keys(draft.route, ['client','model','transport','effort','executable','entry'], ['executable']);
  const r = draft.route;
  if (r.client !== undefined && !seatsApi.CLIENTS.includes(r.client)) S.fail('explicit-route-required');
  if (r.model !== undefined && (typeof r.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(r.model))) S.fail('explicit-route-required');
  if (r.transport !== undefined) S.id(r.transport);
  if (r.effort !== undefined && !/^[a-z][a-z0-9-]{0,24}$/.test(r.effort)) S.fail('invalid-effort');
  // The probe completes the route so the landed validator checks every other
  // field; the filled contract is validated again in full before launch.
  const canonical = seatsApi.validateDraftContract({ ...draft, route: { client:'codex', model:'probe-model', transport:'probe-transport', executable:r.executable, ...(r.entry !== undefined ? { entry:r.entry } : {}) } });
  return { ...draft, id:canonical.id, worktree:canonical.worktree, report:canonical.report };
}

// Fill a draft with the explicit route row; a present constraint that the row
// violates is a refusal, never a silent deviation. A declared family that
// names a layer route's family must name THIS route's family: a label
// borrowed from another model would move the kit's family-based checks off
// the route that actually runs. A free-form family label that
// names no layer family stays the kit's own grammar.
function fillContract(draft, row, layerFamilies, riskClass) {
  const r = draft.route;
  // The contract carries the DERIVED risk class, never the operator's spelling
  // (PROTO-DEC-0186 item 3 reads it): a draft that names another class refuses.
  if (draft.riskClass !== undefined && draft.riskClass !== riskClass) S.fail('invalid-contract');
  if (r.client !== undefined && r.client !== row.client) S.fail('route-client-conflict');
  if (r.model !== undefined && r.model !== row.model) S.fail('route-model-conflict');
  if (r.transport !== undefined && r.transport !== row.transport) S.fail('route-transport-conflict');
  if (r.effort !== undefined && r.effort !== row.effort) S.fail('route-effort-conflict');
if (layerFamilies.has(draft.family) && draft.family !== row.family) S.fail('route-family-conflict');
  return seatsApi.validateContract({ ...draft, ...(riskClass ? { riskClass } : {}), route: { client: row.client, model: row.model, transport: row.transport,
    ...(row.effort ? { effort: row.effort } : {}), executable: r.executable, ...(r.entry !== undefined ? { entry: r.entry } : {}) } });
}

// Pair rows come from the ordered qualified candidates with the same pairwise
// rules the assign layer uses; one greedy pass, no hidden second ranking.
function choosePairRows(decision, drafts) {
  const rows = [];
  for (const draft of drafts) {
    const row = decision.candidates.find(cand => !rows.includes(cand)
      && (draft.route.client === undefined || cand.client === draft.route.client)
      && (draft.route.model === undefined || cand.model === draft.route.model)
      && (draft.route.transport === undefined || cand.transport === draft.route.transport)
      && (draft.route.effort === undefined || cand.effort === draft.route.effort)
      && rows.every(x => x.transport !== cand.transport && x.modelId !== cand.modelId && x.family !== cand.family)
      && !(isMiMo(cand) && rows.some(isMiMo)));
    if (!row) S.fail('no-independent-qualified-seats');
    rows.push(row);
  }
  return rows;
}

// The whole ancestor chain is walked BEFORE anything is created: a link
// anywhere on the way out of the real tree refuses with no side effect.
// The created root is guarded again immediately after, so a
// swap between the two checks still cannot reach the write. The disposable
// `.ai/runtime` decision comes FIRST, from the resolved path string alone,
// so a refused root never creates itself or any parent.
function ensureFeedbackRoot(root) {
  const abs = path.resolve(root);
  feedback.refuseDisposableRoot(abs);
  io.guard(path.parse(abs).root, abs, true);
  fs.mkdirSync(abs, { recursive: true });
  return io.guard(abs, abs, true).real;
}

// The deterministic launch refusals of the executing seats, re-run here
// read-only BEFORE the feedback root exists: a stale candidate, a used seat
// id, an occupied worktree or a report that already exists in the worktree
// (or in the commit a fresh worktree will check out) refuses while the tree
// still holds no new directory and no recorded event.
// runSeat keeps its own checks under the lock as the authority for races.
function preflightSeat(ctx, c) {
  seatsApi.validateContract(c);
  if (ctx.git(['rev-parse','--verify',`refs/heads/${c.branch}^{commit}`]) !== c.sha) S.fail('stale-candidate');
  const wt = ctx.guard(ctx.workspace, c.worktree);
  if (wt === ctx.repo) S.fail('author-checkout-forbidden');
  seatsApi.checkWorktree(ctx, c, wt);
  const s = ctx.load();
  if (s.seats[c.id]) S.fail('seat-id-already-used');
  if (fs.existsSync(wt)) { if (fs.existsSync(ctx.guard(wt, c.report))) S.fail('report-already-exists'); }
  else if (seatsApi.reportInCommit(ctx,c)) S.fail('report-already-exists');
  if (Object.values(s.seats).some(x => sameFileOrNested(ctx.guard(ctx.workspace, S.seatKey(x.worktree, true)), wt) && !seatsApi.reportStatus(ctx, x).done)) S.fail('seat-already-active');
  // The chained-seat refusals (PROTO-DEC-0252) are deterministic registry reads: they refuse here too, before
  // the feedback root exists; runSeat re-runs them under the stream lock as the authority for races.
  seatsApi.preflightChain(ctx, c);
  seatsApi.preflightRegistry(ctx);
  seatsApi.preflightNative(c);
  seatsApi.invocation(c, path.join(wt, '.ai/runtime/opkit-preflight.md'), wt);
}

// A second writer holds the exclusive lock for milliseconds; the append is
// retried so a line is never lost to a busy refusal. Idempotence is by
// eventId, so a retry after a partial failure writes nothing twice.
function appendWithRetry(fn, attempts = 6, waitMs = 200) {
  for (let i = 0; ; i++) {
    try { return fn(); }
    catch (e) {
      if (e.code !== 'feedback-busy' || i + 1 >= attempts) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, waitMs * (i + 1));
    }
  }
}

function recordAssignmentSeats(root, decision, rows, machine, ids) {
  appendWithRetry(() => feedback.recordAssignment(root, { ...decision, assignments: rows }, machine, ids));
}

// The deviation record, written at launch time: what was recommended, what
// will actually run, and the operator reason. Metrics stay null until the seat
// ends; a crash between the two leaves the deviation itself on record.
function recordDeviation(root, seatAssignmentId, tier, role, machine, recommended, actual, reason) {
  appendWithRetry(() => feedback.append(root, { schema:'assign-feedback/1', eventId:`deviation-${seatAssignmentId}`,
    assignmentId: seatAssignmentId, machine, tier, role, event:'outcome',
    assigned:{ client:recommended.client, model:recommended.model, effort:recommended.effort },
    actual:{ client:actual.client, model:actual.model, effort:actual.effort },
    rounds:null, verdicts:[], wallSeconds:null, tokens:null, costUsd:null, handOverride:true, reason }));
}

function recordSeatOutcome(ctx, seatRecord, result, meta) {
  const start = Date.parse(seatRecord.startedAt), end = Date.parse(seatRecord.endedAt);
  const wallSeconds = Number.isFinite(start) && Number.isFinite(end) && end >= start ? (end - start) / 1000 : null;
  // The failure reason of a FAILED seat belongs in the ledger record too,
  // bounded and through the shared free-text decision: it must not live only
  // in the seat registry. A reason that somehow fails the
  // decision degrades to no key, never to a lost outcome.
  const failed = !result.done || !result.verdict;
  let failureReason = null;
  if (failed && typeof result.reason === 'string' && result.reason.length <= 60 && !/[\u0000-\u001f\u007f]/.test(result.reason)) {
    try { failureReason = io.operatorText(result.reason); } catch { failureReason = null; }
  }
  appendWithRetry(() => feedback.recordOutcome(meta.feedbackRoot, meta.assignmentId, meta.machine, {
    actual: meta.actual, rounds: result.verdict ? 1 : null, verdicts: result.verdict ? [result.verdict] : [],
    wallSeconds, tokens: null, costUsd: null, handOverride: Boolean(meta.handOverride),
    ...(failureReason ? { failureReason } : {}), ...(meta.reason ? { reason: meta.reason } : {}) }));
}

function assignmentLines(decision, rows, metas) {
  const lines = [];
  for (const [i, row] of rows.entries()) {
    lines.push(`ASSIGNMENT seat=${metas[i].seat} assignmentId=${metas[i].assignmentId} tier=${decision.tier} role=${decision.role}`
      + ` client=${row.client} model=${row.model} effort=${row.effort === null || row.effort === undefined ? 'unknown' : row.effort}`
      + ` transport=${row.transport} family=${row.family} class=${row.class === null || row.class === undefined ? 'unknown' : row.class}`
      + ` cost=${row.estimatedCost === null || row.estimatedCost === undefined ? 'unknown' : row.estimatedCost}`
      + ` quota=${row.quota && row.quota.status ? row.quota.status : 'unverified'}`);
  }
  for (const f of decision.classification.decidedBy) lines.push(`ASSIGN-REASON feature=${f.feature} tier=T${f.tier} reason=${f.reason} value=${JSON.stringify(f.value)}`);
  for (const meta of metas) if (meta.deviation) lines.push(`DEVIATION seat=${meta.seat} recommended=${meta.deviation.recommended.client}/${meta.deviation.recommended.model} actual=${meta.deviation.actual.client}/${meta.deviation.actual.model} reason=${meta.reason}`);
  return lines;
}

// One prepare path for --auto and --assignment: the decision is always
// recomputed in-process now (never taken from the file), the file only has to
// reproduce it. Returns the filled contracts, the feedback metadata and the
// lines to print before launching.
function prepareLaunch(ctx, opts) {
  for (const field of ['requestFile','assignmentFile','catalogRoot','feedbackRoot']) S.inputText(opts[field]);
  // Operator-supplied free text is decided AND validated BEFORE anything is
  // created or launched: an invisible, bidi or non-NFC deviation reason can
  // never reach a record, the feedback root or the client, so no half-written
  // feedback can exist. The closed reason grammar
  // - non-blank, at most 300 characters, no control characters - and the
  // private-shape check run at the same place, before the request is even
  // read, so a refused reason leaves no new directory and no new file behind
  // UTF-8 encoding replaces lone surrogates; refuse that loss before the
  // established operatorText guard receives the original reason.
  if (typeof opts.reason === 'string' && Buffer.from(opts.reason, 'utf8').toString('utf8') !== opts.reason) S.inputText(opts.reason);
  const reasonText = opts.reason === undefined || opts.reason === null ? null : io.operatorText(opts.reason);
  if (reasonText !== null && (!reasonText.trim() || reasonText.length > 300 || /[\u0000-\u001f\u007f]/.test(reasonText))) S.fail('deviation-reason-required');
  if (reasonText !== null) io.publicValue(reasonText);
  const request = readOperatorJson(opts.requestFile);
  const catalog = loadLayer(opts.catalogRoot);
  const nowIso = new Date().toISOString();
  const decision = assign(request, { catalog, now: nowIso, repoRoot: ASSIGN_ROOT, mode: 'assign', ownerContext: ctx.ownerContext });
  const derivedRisk = decision.classification.riskClass;
  if (opts.assignmentFile) verifyDecision(readOperatorJson(opts.assignmentFile), decision);
  if (decision.status !== 'ASSIGNED') S.fail(`assign-blocked:${/^[a-z0-9-]{1,60}$/.test(decision.reason || '') ? decision.reason : 'reason-unknown'}`);
  // Keep the canonical result: metadata, hashes and contracts must consume
  // the same key, including the ask-owner diagnostic path.
  const drafts = opts.drafts.map(validateDraft);
  const role = ASSIGN_ROLES[drafts[0].role];
  if (!role || drafts.some(d => ASSIGN_ROLES[d.role] !== role)) S.fail('role-unsupported');
  if (role !== request.role) S.fail('role-mismatch');
  if (opts.pair && (role !== 'certifier' || request.seats !== 2)) S.fail('pair-request-invalid');
  const index = layerIndex(catalog);
  const activeSeats = kitActiveSeats(ctx);
  const lineage = seatLineage(request, drafts, role);
  const chosen = [];
  let rows;
  if (opts.pair) rows = choosePairRows(decision, drafts);
  else {
    rows = [decision.assignments[0]];
    if (!rows[0]) S.fail('assign-blocked:no-recommendation');
  }
  // PROTO-DEC-0182 item 1: an executing seat
  // runs only on an EXPLICIT route named by the operator's tool - both client
  // AND model on the command line or in the seat draft - or on a row named by
  // the validated assignment file. A recommendation alone never starts a
  // client: the recommended rows are printed and the dispatch stops with
  // ask-owner before anything is created or launched.
  // A dry run executes nothing, so it stays the advisory print of the
  // recommendation and asks nothing.
  if (!opts.dryRun) {
    const namedByDraft = d => d.route.client !== undefined && d.route.model !== undefined;
    const authoritative = Boolean(opts.assignmentFile)
      || (!opts.pair && opts.override && opts.override.client && opts.override.model)
      || drafts.every(namedByDraft);
    if (!authoritative) {
      const e = new Error('ask-owner-explicit-route');
      e.code = 'ask-owner-explicit-route';
      e.lines = assignmentLines(decision, rows, rows.map((row, i) => ({ seat: drafts[i].id,
        assignmentId: `${decision.assignmentId}-${i}-${io.hash(drafts[i].id).slice(0, 10)}` })));
      throw e;
    }
    // The hard checks of a real dispatch run against the REAL selection layer,
    // the repository's own catalog: a caller-supplied catalog root can plant
    // any entry (makers, classes, prices), so it can never validate an
    // executing launch - not even for an explicitly named route, and an
    // assignment file does not change that. The
    // repository's offline test suite declares its fixture layer through
    // OPAUTO_TEST_FIXTURES=1; a dry run keeps any root because it is advisory.
    const realLayer = opts.catalogRoot === undefined || path.resolve(opts.catalogRoot) === ASSIGN_ROOT;
    if (!realLayer && process.env.OPAUTO_TEST_FIXTURES !== '1') S.fail('real-layer-required');
  }
  for (const row of rows) { checkRoute({ index, request, row, role, tier: decision.tier, riskClass: derivedRisk, lineage, chosen, activeSeats, now: Date.parse(nowIso), ownerContext: ctx.ownerContext, eligibleRoutes: decision.candidates }); chosen.push(row); }
  const machine = machineId();
  // The deviation is resolved BEFORE anything is created: the wanted row, its
  // hard re-checks and the reason an actual deviation requires are all
  // decided while the tree still holds no new directory and no new file, so a
  // refused override is a refusal with no side effect either.
  let finalRows = rows;
  let deviation = null;
  if (!opts.pair && (opts.override && (opts.override.client || opts.override.model))) {
    const recommended = rows[0];
    const wanted = { client: opts.override.client || recommended.client, model: opts.override.model || recommended.model };
    if (wanted.client !== recommended.client || wanted.model !== recommended.model) {
      const pool = [...decision.candidates, ...decision.excluded];
      const actual = pool.find(r => r.client === wanted.client && r.model === wanted.model);
      if (!actual) S.fail('override-route-unknown');
      checkRoute({ index, request, row: actual, role, tier: decision.tier, riskClass: derivedRisk, lineage, chosen: [], activeSeats, now: Date.parse(nowIso), ownerContext: ctx.ownerContext, eligibleRoutes: decision.candidates });
      if (!reasonText) S.fail('deviation-reason-required');
      finalRows = [actual];
      deviation = { recommended, actual };
    }
  }
  // Quota: with a reservation context the preflight must allow every seat
  // that will actually launch, and the budget is SHARED across all of them:
  // each allowed preflight commits its reservation into the same context, so
  // the next seat sees the spent budget and a refusing seat fails the whole
  // launch before anything is created. Without a context the quota
  // stays unverified and the explicit operator launch proceeds
  // (an explicit route, never a model choice).
  const quota = request.reservationContext !== undefined ? quotaContext(request.reservationContext) : null;
  if (quota) for (const row of finalRows) if (quotaPreview(quota, row, request.tokens, Date.parse(nowIso), true).status !== 'allow') S.fail('quota-refused');
  const layerFamilies = new Set([...index.values()].map(v => v.family));
  let filled = drafts.map((d, i) => fillContract(d, finalRows[i], layerFamilies, derivedRisk));
  // PROTO-DEC-0252: the blind/chained decision is fixed HERE, at contract build time (F6 of the design): a
  // certifier seat is blind iff no finished qualifying earlier report of its candidate exists now; a chained
  // contract names ALL of them. A seat built blind stays blind even when a parallel seat finishes first.
  if (role === 'certifier') filled = filled.map(c => seatsApi.chainEnrichment(ctx, c));
  if (opts.pair) seatsApi.validatePair({ ...opts.pairContract, seats: filled });
  // The deterministic launch refusals of the seats
  // that will run are decided here as well, read-only, BEFORE the feedback
  // root exists - a stale candidate, a used seat or pair id, an occupied
  // worktree, a report that already exists. After this point a refusal is a
  // genuine concurrent or environmental failure, never an input the command
  // could have known in advance. A dry run is advisory and changes nothing,
  // so it keeps printing the plan and leaves the refusal to runSeat.
  if (!opts.dryRun) {
    for (const c of filled) preflightSeat(ctx, c);
    if (opts.pair && ctx.load().pairs[opts.pairContract.id]) S.fail('pair-id-already-used');
    if (fs.existsSync(ctx.lockRoot) && fs.existsSync(ctx.guard(ctx.lockRoot, 'operator.lock'))) S.fail('operator-busy');
  }
  // Every refusal above leaves the tree untouched: the feedback root is the
  // FIRST thing this path creates. A dry run creates
  // nothing: no feedback directory is made and no event is written.
  const feedbackRoot = path.resolve(opts.feedbackRoot || path.join(ctx.stateRoot, 'assign-feedback'));
  // Feedback publication must never create or modify any prospective seat
  // worktree (nor its parent). Use the shared real-path comparison: it handles
  // missing tails, aliases and Windows case folding, and fails closed when
  // the relationship cannot be established. Both seats and dry runs agree.
  if (filled.some(c => sameFileOrNested(feedbackRoot, ctx.guard(ctx.workspace, c.worktree)))) S.fail('feedback-worktree-overlap');
  if (!opts.dryRun) {
    feedback.refuseDisposableRoot(feedbackRoot);
    io.guard(path.parse(feedbackRoot).root, feedbackRoot, true);
    if (fs.existsSync(path.join(feedbackRoot, 'feedback.lock'))) S.fail('feedback-busy');
  }
  const metas = [];
  for (const [i, row] of rows.entries()) {
    // Per-seat identity: two different seats launched from one attempt record
    // two assignment events. The contract id makes the identity of
    // the recorded assignment the SEAT's; the hash keeps it deterministic.
    const assignmentId = `${decision.assignmentId}-${i}-${io.hash(drafts[i].id).slice(0, 10)}`;
    const meta = { seat: drafts[i].id, assignmentId, feedbackRoot, machine,
      actual: { client: row.client, model: row.model, effort: row.effort === null || row.effort === undefined ? 'none' : row.effort },
      handOverride: false, reason: null, deviation: null };
    metas.push(meta);
  }
  if (deviation) {
    metas[0].actual = { client: deviation.actual.client, model: deviation.actual.model, effort: deviation.actual.effort === null || deviation.actual.effort === undefined ? 'none' : deviation.actual.effort };
    metas[0].handOverride = true;
    metas[0].reason = reasonText.trim();
    metas[0].deviation = deviation;
  }
  // The recommendation is what the log records as assigned; a deviated seat
  // keeps the recommended row in its assignment event and the override in the
  // deviation and outcome events.
  const recordedRows = (!opts.pair && metas[0].deviation) ? rows : finalRows;
  const dimMeta = decision.classification && decision.classification.dimension !== undefined
    ? { dimension: decision.classification.dimension, dimensionSource: decision.classification.dimensionSource }
    : undefined;
  // The caps of the rows that will really launch, so the dispatch can re-check them
  // against the FRESH active seats (a seat that started in the meantime takes one unit
  // of the client pool and one of the route pool).
  const capRows = finalRows.map(r => ({ client: r.client, model: r.model,
    clientCap: r.clientCap === undefined ? null : r.clientCap, routeCap: r.routeCap === undefined ? null : r.routeCap,
    capProvider: r.capProvider || null, capExcludedProviders: r.capExcludedProviders || [] }));
  const events = feedback.assignmentEvents({...decision, assignments:recordedRows}, machine, metas.map(m => m.assignmentId));
  if (!opts.pair && metas[0].deviation) events.push(feedback.deviationEvent(metas[0].assignmentId, decision.tier, decision.role, machine, metas[0].deviation.recommended, metas[0].deviation.actual, metas[0].reason, dimMeta));
  if (!opts.dryRun) feedback.preflightBatch(feedbackRoot, events);
  return { contracts: filled, metas, decision, lines: assignmentLines(decision, rows, metas), events, feedbackRoot, dryRun:opts.dryRun, pair:opts.pair ? opts.pairContract.id : null, capRows };
}

async function executePrepared(ctx, prepared, launch) {
  if (prepared.dryRun) return launch(ctx);
  return S.acquireAll(ctx, {contracts:prepared.contracts,pair:prepared.pair}, async locked => {
    for (const c of prepared.contracts) preflightSeat(locked,c);
    if (prepared.pair && locked.load().pairs[prepared.pair]) S.fail('pair-id-already-used');
    // The caps are re-checked against the FRESH active seats and the chosen set right
    // before the dispatch: the prepare step ran earlier, and a seat that started in the
    // meantime takes one unit of the client pool and one of the route pool.
    const fresh = kitActiveSeats(locked);
    const chosen = [];
    for (const row of prepared.capRows || []) {
      if (poolReached(row, [...fresh, ...chosen])) S.fail('seat-cap-reached');
      chosen.push({ client: row.client, model: row.model });
    }
    feedback.preflightBatch(prepared.feedbackRoot, prepared.events);
    // One atomic publication includes all assignments AND any deviation.
    ensureFeedbackRoot(prepared.feedbackRoot);
    appendWithRetry(() => feedback.appendBatch(prepared.feedbackRoot, prepared.events));
    return launch(locked);
  });
}

// A class number is a whole token: it is never followed by a letter or a
// decimal tail, so "defect class 1.5" and "defect class 3x" are garbage, not
// classes 1 and 3. Both boundaries are Unicode-aware: a letter of
// any script, a digit, an underscore or a combining mark on either side of the
// token means no token at all, exactly like the round-token grammar (its left
// boundary).
const DEFECT_RE = () => /(?:^|[^a-z0-9\p{L}\p{Nd}\p{M}_])defect class(?:es)?\s*:?\s*([0-9]{1,2}(?![0-9a-z\p{L}\p{Nd}\p{M}_])(?!\.\p{Nd})(?:\s*[,;]\s*[0-9]{1,2}(?![0-9a-z\p{L}\p{Nd}\p{M}_])(?!\.\p{Nd}))*)/giu;

// Round identity for failedRounds: a FAIL verdict counts the ROUND it belongs
// to, not the file that carries it, so two certifier reports of one round are
// one failed round. The token grammar is closed (round/rnd/r plus
// one or two bounded digits, so "round 123" is never round 12) and a fenced or
// quoted line is not the document's own statement. A filename token and a
// content token that disagree leave the round unknown, so the file keeps its
// own identity; no token at all is the file's own identity too (fail-safe).
// A round number is a whole bounded token: it is never followed by a letter,
// another digit or a decimal tail, so "round 1x" and "round 1.5" are not round
// 1. Every round token of one text is read, not only the first per
// line: a line that carries two tokens names its round twice, so a body whose
// tokens disagree is a conflict, never a silent first-token win.
function roundTokensOf(text) {
  const out = [];
  // The LEFT boundary is Unicode-aware exactly like the right one: a letter of
  // any script, a digit of any script, an underscore or a combining mark
  // before the token means no token, so "\u044fr1", "_r1" and "2r1" are never
  // a round. The right boundary stays closed: a garbage tail
  // after the number is not a number either.
  const re = /(?:^|[^a-z0-9\p{L}\p{Nd}\p{M}_])(?:round|rnd|r)[ \t-]*([0-9]{1,2})(?![0-9a-z\p{L}\p{Nd}\p{M}_])(?!\.\p{Nd})/giu;
  let m;
  while ((m = re.exec(text))) out.push(Number(m[1]));
  return out;
}
function roundTokenOf(text) {
  const all = roundTokensOf(text);
  return all.length ? all[0] : null;
}
// Two round tokens that disagree inside one body are disagreeing sources of
// the same report: the body's round stays unknown and the file keeps its own
// identity; the first token never silently wins. A conflict is
// reported separately from "no token at all", so the caller can tell an
// unknown body from a conflicting one.
function contentRoundToken(content) {
  const seen = new Set();
  for (const line of maskMarkdown(content).lines) {
    if (line.masked || line.partial) continue;
    for (const t of roundTokensOf(line.text)) seen.add(t);
  }
  return { round: seen.size === 1 ? [...seen][0] : null, conflict: seen.size > 1 };
}
function roundIdentity(name, content) {
  // The filename is a source like the body: EVERY round token it carries is
  // read, and tokens that disagree inside the filename itself leave the
  // report's round unknown, so the file keeps its own identity and two
  // `round1-round2-*` files never collapse into one failed round.
  const body = contentRoundToken(content);
  const fileTokens = roundTokensOf(name);
  const fileSeen = new Set(fileTokens);
  // The agreed filename token and the conflict flag derive from the same
  // computation: a filename that disagrees with itself has no agreed token,
  // so the guard that keeps a conflicting filename unknown sits ON the token
  // the identity would otherwise use, and a test that reaches a conflicting
  // filename always exercises it.
  const fn = fileSeen.size === 1 ? [...fileSeen][0] : null;
  const fileConflict = fn === null && fileTokens.length > 1;
  // A body with conflicting round tokens stays UNKNOWN: the filename token is
  // another source of the same report, never an override of a conflict
  // A conflicting filename identity stays UNKNOWN too: the body
  // round is another source of the same report, never a rescue of a
  // self-conflicting filename, so `round1-round2-*` with a body naming one of
  // them still keeps the file identity.
  if (body.conflict || fileConflict) return `file:${name}`;
  if (fn !== null && body.round !== null && fn !== body.round) return `file:${name}`;
  const r = fn !== null ? fn : body.round;
  return r === null ? `file:${name}` : `round:${r}`;
}

// A report belongs to the package only under the repository's own naming
// convention: the date, then the package id as one whole segment. A loose
// substring match pulls sibling packages' reports into the history.
// A sibling package's report belongs to that package alone.
function packageReportRe(id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\d{4}-\\d{2}-\\d{2}-${escaped}(?:[-.][^/]*)?$`);
}

// When the operator gives no --route-states file, project route availability
// from docs/ops/route-state.json through its strict reader.
// Advisory selection uses the same fresh declarations and measured state as
// the route gate, but accepts measured evidence for three hours independently
// of the live probe expiry. Balance, price and proof digest stay unknown.
// A latest failed probe sets available false (route-unavailable). A
// missing record is an empty projection (the pre-fix behaviour); an unreadable
// or refused record is a loud refusal, never a silent empty list.
function projectRouteStates(ctx, nowIso, counts = {}, execution = false) {
  if (typeof counts === 'boolean') { execution = counts; counts = {}; }
  Object.assign(counts, { stale: 0, unknown: 0 });
  const recordFile = path.join(ctx.repo, 'docs', 'ops', 'route-state.json');
  const schemaFile = path.join(ctx.repo, 'docs', 'ops', 'route-state.schema.json');
  if (!fs.existsSync(recordFile)) return [];
  if (!fs.existsSync(schemaFile)) S.fail('route-state-unreadable');
  let record;
  try {
    record = routeState.loadRecord(recordFile, { schemaFile });
  } catch (e) {
    S.fail('route-state-unreadable');
  }
  // Only this advice view extends evidence usability; the stored probe and the
  // live route gate keep their own expiry. Required declarations use nowIso.
  const adviceRecord = { ...record, routes: record.routes.map(route => {
    const probe = route.fields.probe;
    if (probe?.tag !== 'measured') return route;
    const at = Math.min(Date.parse(probe.measuredAt), Date.parse(probe.value.at));
    if (!Number.isFinite(at)) return route;
    return { ...route, fields: { ...route.fields, probe: { ...probe,
      expiresAt: new Date(at + policies().policy.adviceRouteMaxAgeMs + 1).toISOString() } } };
  }) };
  // Real seats are primary evidence of the advice view, as in the operator's
  // route summary; the spawn-time view keeps its fresh probe proof only.
  // Only a seat that finished proves the route here: a failed or partial
  // launch is a real seat's failure, never an answer that revives the route.
  const state = routeState.stateAt(adviceRecord, nowIso, { launches: !execution && Array.isArray(ctx.launches) ? ctx.launches : [], requireSuccess: true });
  return state.routes.map((row, i) => {
    const route = record.routes[i];
    const probe = route.fields.probe;
    const seat = row.evidence?.source === 'launch' ? row.evidence : null;
    const value = seat ? { at: seat.at, ok: seat.ok, served: seat.servedModel, servedSource: seat.servedModel ? seat.basis : 'none' }
      : probe?.tag === 'measured' ? probe.value : null;
    const age = value ? Date.parse(nowIso) - Date.parse(value.at) : NaN;
    // The live reader permits unproven author probes; assignment advice keeps
    // its own served-model requirement even when that broader state is ok.
    const proven = typeof value?.served === 'string' && value.served.length > 0
      && typeof value.servedSource === 'string' && value.servedSource !== 'none';
    const maxAge = execution ? policies().policy.routeProofMaxAgeMs : policies().policy.adviceRouteMaxAgeMs;
    const effective = row.state === 'ok' && Number.isFinite(age) && age >= 0 && age <= maxAge && proven;
    const stale = !effective && (row.state === 'stale' || Object.values(row.fields || {}).some(f => f.expired === true)
      || (row.state === 'ok' && proven));
    if (stale) counts.stale++;
    else if (row.state === 'unknown' || !proven) counts.unknown++;
    if (execution) {
      const age = Date.parse(nowIso) - Date.parse(value?.at);
      const declared = route.requiredDeclared.every(k => row.fields[k]?.value !== null && row.fields[k]?.value !== undefined);
      const available = effective && value.ok === true && age <= policies().policy.routeProofMaxAgeMs && declared;
      const balance = row.fields.balance?.value;
      // A bare numeric declaration can be a balance; narrative text is not parsed into money.
      const balanceUsd = typeof balance === 'string' && /^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(balance) ? Number(balance) : null;
      return { client: route.client, model: route.model, available, probeOk: effective && value.ok === true,
        at: effective ? new Date(Date.parse(value.at)).toISOString() : null, servedModel: effective ? value.served ?? null : null,
        proofSha256: available && value.servedSource && value.servedSource !== 'none' ? io.hash(route) : null,
        balanceUsd, billingKnown: available && (route.billing === 'free' || route.billing === 'subscription'
          ? route.requiredDeclared.length > 0 : balanceUsd !== null && balanceUsd > 0), priceRoute: null };
    }
    return {
      client: route.client,
      model: route.model,
      available: Boolean(effective && value.ok === true),
      probeOk: Boolean(effective && value.ok === true),
      at: effective && typeof value.at === 'string' ? value.at : null,
      balanceUsd: null,
      servedModel: effective ? value.served ?? null : null,
      proofSha256: null,
      priceRoute: null,
    };
  });
}

// The task descriptor helper: every feature is derived from the repository
// (diff against the base branch, PRE risk classifier) and the reviews folder
// (shared verdict reader, masked Markdown for the defect-class scan). The
// operator judgments the repository cannot know stay null (unknown), never
// invented defaults.
function buildTaskRequest(ctx, opts) {
  const { canonicalPolicy } = policies();
  for (const field of ['out','lineageFile','routeStatesFile','complexityFile','taskSpecFile']) S.inputText(opts[field]);
  S.id(opts.packageId);
  if (opts.kind !== undefined && !KINDS.includes(opts.kind)) S.fail('kind-invalid');
  if (opts.verification !== undefined && !Object.hasOwn(canonicalPolicy.taskPolicy.verification, opts.verification)) S.fail('verification-invalid');
  if (opts.dimension !== undefined) tc.validateDimensionPair(opts.dimension, 'operator-override');
  // A numeric operator flag is a closed whole token: every one of them goes
  // through the ONE shared decimal grammar, so blank or garbage is refused,
  // never silently coerced to a number, and the assign layer's own
  // feature-number-invalid code names the refusal. The value is decided here,
  // before any repository command runs.
  const coupling = opts.coupling === undefined ? null : closedInteger(opts.coupling, 'feature-number-invalid');
  if (opts.role === undefined || !Object.values(ASSIGN_ROLES).includes(opts.role) && opts.role !== 'operator') S.fail('role-invalid');
  let baseName = opts.base;
  if (baseName === undefined) {
    let hasV2 = false;
    try { ctx.git(['rev-parse', '--verify', 'v2.0.0']); hasV2 = true; } catch { hasV2 = false; }
    baseName = hasV2 ? 'v2.0.0' : 'main';
  }
  const base = S.branch(baseName);
  const mergeBase = ctx.git(['merge-base', base, 'HEAD']);
  const spec = opts.taskSpecFile === undefined ? undefined : tc.validateSpec(readOperatorJson(opts.taskSpecFile, 64 * 1024));
  const verdicts = [], defectClasses = new Set();
  const failedRoundIds = new Set();
  let unknowns = 0;
  const reviewsReal = path.join(ctx.repo, 'docs', 'reviews');
  if (fs.existsSync(reviewsReal)) {
    for (const name of fs.readdirSync(reviewsReal).filter(n => n.endsWith('.md') && packageReportRe(opts.packageId).test(n)).sort()) {
      const rel = `docs/reviews/${name}`;
      let content;
      try { content = ctx.read(ctx.repo, rel); } catch { unknowns++; continue; }
      const v = readVerdict(content);
      if (v.token && ['closing', 'both'].includes(v.source)) { verdicts.push(v.token); if (v.token === 'FAIL') failedRoundIds.add(roundIdentity(name, content)); }
      else unknowns++;
      for (const line of maskMarkdown(content).lines) {
        if (line.masked || line.partial) continue;
        const re = DEFECT_RE();
        let m;
        while ((m = re.exec(line.text))) {
          for (const tok of m[1].split(/\s*[,;]\s*/)) { const n = Number(tok); if (n >= 1 && n <= 14) defectClasses.add(n); }
        }
      }
    }
  }
  const history = { failedRounds: failedRoundIds.size, verdicts: verdicts.slice().sort(), defectClasses: [...defectClasses].sort((a, b) => a - b), unknowns };
  const proposed = tc.classifyFromRepo({ repo: ctx.repo, base: mergeBase, packageId: opts.packageId, role: opts.role, spec, history,
    git: args => ctx.git(args), readUtf8: (root, rel) => ctx.read(root, rel) });
  const task = { ...proposed, superImportant: Boolean(opts.superImportant) };
  for (const [field, value] of Object.entries({ kind: opts.kind, verification: opts.verification,
    coupling: opts.coupling === undefined ? undefined : coupling,
    complexity: opts.complexityFile === undefined ? undefined : readOperatorJson(opts.complexityFile) })) {
    if (value === undefined) continue;
    if (field === 'complexity') {
      const factors = canonicalPolicy.taskPolicy.factors;
      if (!io.object(value) || Object.keys(value).length !== factors.length || factors.some(f => !Object.hasOwn(value, f))) S.fail('complexity-invalid');
      for (const f of factors) if (!Number.isInteger(value[f]) || value[f] < 0 || value[f] > 2) S.fail('complexity-score-invalid');
    }
    if (io.canonical(value) !== io.canonical(proposed[field])) task.classifierDisagreements.push({ field, proposed: proposed[field], operator: value });
    task[field] = value;
  }
  if (opts.dimension !== undefined) { task.dimension = opts.dimension; task.dimensionSource = 'operator-override'; }
  const paths = task.paths;
  if (!paths.length) S.fail('no-changes');
  const classification = complexity(task, canonicalPolicy);
  let tokens = null;
  if (opts.tokens !== undefined) {
    // The documented NxM form: each side is the same closed decimal integer
    // the single numeric grammar accepts, and both sides must be at least
    // one token, exactly what the assign layer's own count guard demands.
    const parts = opts.tokens.split('x');
    if (parts.length !== 2) S.fail('tokens-invalid');
    tokens = { input: closedInteger(parts[0], 'tokens-invalid'), output: closedInteger(parts[1], 'tokens-invalid') };
    if (tokens.input < 1 || tokens.output < 1) S.fail('tokens-invalid');
  }
  const lineage = opts.lineageFile ? readOperatorJson(opts.lineageFile) : { author: [], fixer: [], preReviewer: [], operator: [], certifiers: [] };
  io.fields(lineage, CONTROL_KEYS, CONTROL_KEYS);
  for (const k of CONTROL_KEYS) if (!Array.isArray(lineage[k])) S.fail('lineage-invalid');
  const nowIso = new Date().toISOString();
  const routeStates = opts.routeStatesFile ? readOperatorJson(opts.routeStatesFile) : projectRouteStates(ctx, nowIso);
  if (!Array.isArray(routeStates)) S.fail('route-states-invalid');
  const seats = opts.seats === undefined ? 1 : closedInteger(opts.seats, 'seats-invalid');
  if (![1, 2].includes(seats) || seats === 2 && opts.role !== 'certifier') S.fail('seats-invalid');
  // An absent attempt id stays ABSENT: null is an invalid attemptId value for
  // the assign layer, so the default descriptor must not carry the key at all
  // A provided one is validated here, fail closed.
  const request = { task, role: opts.role, tokens, lineage,
    activeSeats: kitActiveSeats(ctx), routeStates, seats,
    ...(opts.attemptId !== undefined ? { attemptId: opts.attemptId } : {}) };
  if (opts.attemptId !== undefined && !io.id(opts.attemptId)) S.fail('attempt-id-invalid');
  io.publicValue(request);
  const out = path.resolve(opts.out);
  const outDir = path.dirname(out);
  if (!fs.existsSync(outDir)) S.fail('output-dir-missing');
  if (require('../../.ai/bin/lib/path-safe.cjs').sameFileOrNested(out, ctx.repo)) S.fail('output-inside-repo');
  io.writeJson(outDir, path.basename(out), request);
  // The exclusion summary (SELECTION-DATA item 1): run the selection layer on
  // the exact request and count every refusal reason, so one `task PACKAGE`
  // prints the exclusion counts per reason without a separate assign run. The
  // catalog is the repository's own; a refused catalog degrades to no summary,
  // never to a broken descriptor.
  let exclusionSummary = null;
  try {
    const assignment = assign(request, { now: nowIso, repoRoot: ASSIGN_ROOT });
    exclusionSummary = assignment.exclusionSummary || {};
  } catch { exclusionSummary = null; }
  const excludedLine = exclusionSummary === null
    ? 'TASK-EXCLUDED unavailable'
    : `TASK-EXCLUDED ${Object.entries(exclusionSummary).sort((a, b) => a[0].localeCompare(b[0])).map(([r, n]) => `${r}=${n}`).join(' ') || 'none'}`;
  const unknown = Object.entries({ verification: task.verification, coupling: task.coupling, superImportant: opts.superImportant ? true : null, ...(tokens === null ? {} : { tokens }) })
    .filter(([, v]) => v === null || v === undefined).map(([k]) => k);
  const outLines = [
    `TASK package=${task.packageId} base=${base} paths=${task.files} lines=${task.lines === null ? 'unknown' : task.lines} class=${task.riskClass} kind=${task.kind}`,
    `TASK-REVIEWS verdicts=${JSON.stringify(task.verdicts)} failedRounds=${task.failedRounds} defectClasses=${JSON.stringify(task.defectClasses)} unknowns=${task.unknowns}`,
    `TASK-TIER tier=${classification.tier} decidedBy=${classification.decidedBy.map(f => `${f.feature}(T${f.tier})`).join(',')}`,
    excludedLine,
    `TASK-CLASSIFIER-DIFF ${JSON.stringify(task.classifierDisagreements)}`,
    `TASK-OUT written=1 unknownEdit=${unknown.length ? unknown.join(',') : 'none'} dimension=${task.dimension} source=${task.dimensionSource}`
  ];
  return { request, classification, exclusionSummary, lines: outLines };
}

// Read-only intake adapter. The engine owns ranking; unknown history, quota and
// route facts stay unknown. No invented history or parallel resolver ladder.
function recommendLaunch(input, frame, context, deps = {}) {
  const now = deps.now || new Date().toISOString();
  const root = deps.repoRoot || ASSIGN_ROOT;
  const d = context.descriptor || {};
  if (!frame.riskKnown || frame.unknown.some(s => /invalid|input-unknown|diff-unknown|intake-unavailable/.test(s))) {
    return { decision: null, unknown: ['task-frame-unusable'], reason: 'task-frame-unusable' };
  }
  const role = { implementer: 'author', fixer: 'fixer', reviewer: 'pre-reviewer', certifier: 'certifier', architect: 'operator' }[frame.role];
  if (!role) return { decision: null, unknown: ['assignment-role-unknown'], reason: 'assignment-role-unknown' };
  const kind = { implementer: frame.domain === 'D-DOC' ? 'document' : 'author', fixer: 'fix-round', reviewer: 'pre-review', certifier: 'certify', architect: 'design' }[frame.role];
  const proposed = context.classified || {};
  const task = { ...proposed, packageId: 'launch-intake', kind: proposed.kind || kind, paths: context.paths?.length ? context.paths : undefined,
    riskClass: frame.riskClass, files: frame.pathCount,
    ...(selectionPolicy.FACTORS.every(k => Number.isInteger(frame.complexity[k])) ? { complexity: frame.complexity } : {}),
    ...Object.fromEntries(['failedRounds', 'verdicts', 'defectClasses', 'unknowns', 'verification', 'superImportant']
      .filter(k => Object.hasOwn(d, k)).map(k => [k, d[k]])), coupling: proposed.coupling !== undefined ? proposed.coupling : frame.complexity.coupling };
  // A frame and its selection always use the same full feature set. The intake
  // names inferred/history facts; the engine must not silently replace T2 by T9.
  if (complexity(task, policies().canonicalPolicy).tier !== frame.tier) {
    return { decision: null, unknown: ['task-class-conflict'], reason: 'task-class-conflict' };
  }
  // Explicitly copy the closed descriptor subset; do not persist prose/paths.
  if (task.paths === undefined) delete task.paths;
  const unknown = [];
  let inherited;
  try { inherited = independenceOf(input.independence); }
  catch { return { decision: null, unknown: ['lineage-invalid'], reason: 'lineage-invalid' }; }
  let lineage = d.lineage;
  if (!lineage && input.independence) {
    lineage = { author: inherited.lineage, fixer: [], preReviewer: [], operator: [], certifiers: [] };
  }
  if (!lineage) unknown.push('lineage-unknown');
  if (role === 'certifier' && (!lineage || ![...lineage.author || [], ...lineage.fixer || []].length)) {
    return { decision: null, unknown: ['lineage-unknown'], reason: 'certifier-lineage-unknown' };
  }
  if (role === 'certifier') {
    const ids = require('../../.ai/bin/lib/model-identity.cjs');
    const authors = [...lineage.author, ...lineage.fixer];
    if (authors.some(a => ids.canonicalFamily(typeof a === 'string' ? a : a.model) === 'UNKNOWN'
        && ids.declaredFamily(a?.family) === 'UNKNOWN')) return { decision: null, unknown: ['lineage-family-unknown'], reason: 'certifier-lineage-unknown' };
  }
  lineage ||= { author: [], fixer: [], preReviewer: [], operator: [], certifiers: [] };
  if (!d.tokens) unknown.push('tokens-unknown');
  let live;
  try { live = deps.activeSeats ? { activeSeats: deps.activeSeats, totalCap: deps.totalCap ?? null }
    : (deps.seatSnapshot || require('../assign/live-context.cjs').snapshot)(root, { now: Date.parse(now), env: deps.env, runtimeDir: deps.runtimeDir }); }
  catch { return { decision: null, unknown: ['active-seats-unknown'], reason: 'active-seats-unknown' }; }
  if (live.totalCap !== null && live.activeSeats.length >= live.totalCap) return { decision: null, unknown: [], reason: 'total-seat-cap-reached' };
  const routeStateCounts = { stale: 0, unknown: 0 };
  // The launch journals of this checkout describe this checkout's routes only;
  // another repository root brings its own launches or none.
  let launches = [];
  if (deps.launches !== undefined) launches = deps.launches;
  else if (!deps.projectRouteStates && deps.execution !== true && path.resolve(root) === path.resolve(ASSIGN_ROOT)) {
    try { launches = require('../operator-knowledge/launch-evidence.cjs').readLiveLaunches(); }
    catch { unknown.push('launch-evidence-unreadable'); }
  }
  const request = { task, role, tokens: d.tokens || null, lineage,
    activeSeats: live.activeSeats, routeStates: (deps.projectRouteStates || projectRouteStates)({ repo: root, launches }, now, routeStateCounts, deps.execution === true),
    ...(deps.reservationContext || input.reservationContext || d.reservationContext ? { reservationContext: deps.reservationContext || input.reservationContext || d.reservationContext } : {}) };
  const dimensions = (proposed.dimensions || []).map(x => x.id);
  const manifest = new Set(policies().canonicalPolicy.manifestOwned);
  if ((context.paths || []).some(p => /^RC-A(?:01|05|06)-/.test(risk.classifyPath(p, { manifest }).rule)
      || /(?:security|secret|injection|path-safe|auth|credential)/i.test(p))) dimensions.push('D-SEC');
  if (d.domain === 'D-SEC') dimensions.push('D-SEC');
  const minutes = Number.isFinite(d.estimatedMinutes) && d.estimatedMinutes >= 0 && d.estimatedMinutes <= 10080 ? d.estimatedMinutes : null;
  const reviewScope = ['full', 'merge-delta'].includes(d.reviewScope) ? d.reviewScope : null;
  if (minutes === null) unknown.push('task-duration-unknown');
  if (role === 'certifier' && reviewScope === null) unknown.push('review-scope-unknown');
  const taskFacts = { riskClass: frame.riskClass, dimensions, minutes, reviewScope };
  const ownerContext = { ...deps.ownerContext, now, activeSeats: live.activeSeats, taskFacts };
  const rawDecision = (deps.assign || assign)(request, { repoRoot: root, now, mode: input.assignmentMode, ownerContext, seatPolicy: live.policy });
  const filterContext = { repoRoot: root, role, mode: input.assignmentMode, tier: frame.tier, ownerContext,
    requireOwnerRules: input.assignmentMode === 'assign',
    independence: { ...inherited, lineage: [...inherited.lineage, ...CONTROL_KEYS.flatMap(k => lineage[k])] } };
  const pool = ownerFilter.filterRoutes(rawDecision.candidates || [], filterContext);
  const selected = ownerFilter.filterRoutes(rawDecision.assignments || [], { ...filterContext, alternativeRoutes: rawDecision.candidates || [] });
  const assignments = selected.allowed.length === rawDecision.assignments?.length ? selected.allowed : [];
  const decision = { ...rawDecision, candidates: pool.allowed, assignments,
    excluded: [...rawDecision.excluded || [], ...pool.excluded.map(e => ({ ...e.route, reasons: e.reasons }))],
    ...(!assignments.length && rawDecision.assignments?.length ? { status: 'BLOCKED', reason: selected.reason } : {}) };
  for (const feature of decision.classification?.features || []) if (feature.reason === 'unknown-caution') unknown.push(`assignment-unknown-${feature.feature}`);
  // A money-order caution is a named unknown of the advice; it keeps assign with the operator.
  for (const caution of decision.routeOrder?.cautions || []) unknown.push(`route-order-${caution}`);
  const staleOnly = !decision.assignments?.length && request.routeStates.length > 0
    && request.routeStates.every(r => r.available !== true) && routeStateCounts.stale > 0;
  return { decision, unknown, taskFacts, routeStateCounts, ...(input.execution === true ? { request } : {}), reason: staleOnly ? 'route-state-stale' : decision.reason };
}

// Spawn-time verification uses the catalog identity, current host slots, fresh
// route evidence and the same owner/lineage/quota constraints as selection.
function recheckLaunch(row, execution, deps = {}) {
  const now = deps.now ?? Date.now(), root = deps.repoRoot || ASSIGN_ROOT;
  const request = { ...execution.request, activeSeats: deps.activeSeats,
    routeStates: (deps.projectRouteStates || projectRouteStates)({ repo: root }, new Date(now).toISOString(), true) };
  if (!request.task || !Array.isArray(request.activeSeats)) S.fail('execution-facts-unavailable');
  const index = layerIndex(loadLayer(root));
  const identity = index.get(`${row.client}\u0000${row.model}`);
  if (!identity) S.fail('route-unknown');
  const canonical = { ...row, ...identity };
  const lineage = CONTROL_KEYS.flatMap(k => request.lineage[k]);
  checkRoute({ index, request, row: canonical, role: execution.decision.role, tier: execution.decision.tier,
    riskClass: request.task.riskClass, lineage, chosen: [], activeSeats: [], now,
    ownerContext: deps.ownerContext, eligibleRoutes: execution.decision.candidates || [] });
  if (poolReached(canonical, request.activeSeats)) S.fail('route-cap-reached');
  const quota = quotaPreview(quotaContext(request.reservationContext), canonical, request.tokens, now);
  if (quota.status !== 'allow') S.fail(quota.reason || 'quota-unverified');
  const proof = request.routeStates.find(s => s.client === row.client && s.model === row.model);
  return { ok: true, routeRecheck: { recordSha256: proof.proofSha256, at: new Date(now).toISOString(), servedModelProof: true } };
}

module.exports = { machineId, readOperatorJson, loadLayer, layerIndex, poolReached, checkRoute, verifyDecision, validateDraft, recommendLaunch, recheckLaunch,
  fillContract, choosePairRows, ensureFeedbackRoot, preflightSeat, appendWithRetry, recordAssignmentSeats, recordDeviation,
  recordSeatOutcome, assignmentLines, prepareLaunch, executePrepared, buildTaskRequest, projectRouteStates, kitActiveSeats, isMiMo, ASSIGN_ROLES, KINDS };

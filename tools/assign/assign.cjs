'use strict';
const path = require('node:path');
const io = require('./io.cjs');
const { complexity } = require('./complexity.cjs');
const routeOrderLib = require('./route-order.cjs');
const policy = require('./policy.json');
const adapter = { loadCatalog: () => ({ ok: false, reason: 'selection-not-shipped' }), select: () => ({ ok: false, reason: 'selection-not-shipped' }) };
const { independenceOf, excludesRoute } = require('../../.ai/bin/lib/selection-constraints.cjs');
const s5 = require('../../docs/ops/quota-preflight.cjs');
const D = require('../../.ai/bin/accounting/lib/decimal.cjs');
const ROLES = { author: 'implementer', fixer: 'fixer', 'pre-reviewer': 'reviewer', certifier: 'certifier', operator: 'architect' };
const ROOT = path.resolve(__dirname, '../..');
const controlKeys = ['author', 'fixer', 'preReviewer', 'operator', 'certifiers'];
const clone = v => JSON.parse(JSON.stringify(v));
function requestOf(q) {
  io.fields(q, ['task', 'role', 'tokens', 'lineage', 'activeSeats', 'routeStates', 'seats', 'reservationContext', 'attemptId'], ['task', 'role', 'tokens', 'lineage', 'activeSeats', 'routeStates']);
  io.publicValue(q);
  if (q.attemptId !== undefined && !io.id(q.attemptId)) io.fail('attempt-id-invalid');
  if (!Object.hasOwn(ROLES, q.role) || !(q.tokens === null || io.object(q.tokens) && Object.keys(q.tokens).length === 2 && io.count(q.tokens.input) && io.count(q.tokens.output))) io.fail('request-invalid');
  io.fields(q.lineage, controlKeys, controlKeys);
  for (const key of controlKeys) if (!Array.isArray(q.lineage[key])) io.fail('lineage-invalid');
  const ind = independenceOf({ lineage: controlKeys.flatMap(k => q.lineage[k]) });
  const seats = q.seats ?? 1;
  if (![1, 2].includes(seats) || seats === 2 && q.role !== 'certifier') io.fail('seat-count-invalid');
  if (!Array.isArray(q.activeSeats) || !q.activeSeats.every(s => io.object(s) && io.id(s.client) && io.id(s.model) && Object.keys(s).every(k => ['client', 'model'].includes(k)))) io.fail('active-seats-invalid');
  if (!Array.isArray(q.routeStates) || q.routeStates.length > 10000) io.fail('route-states-invalid');
  const seen = new Set();
  for (const s of q.routeStates) {
    io.fields(s, ['client', 'model', 'available', 'balanceUsd', 'servedModel', 'proofSha256', 'at', 'priceRoute'], ['client', 'model']);
    if (!io.id(s.client) || !io.id(s.model)) io.fail('route-state-invalid');
    const id = `${s.client}:${s.model}`; if (seen.has(id)) io.fail('route-state-conflict'); seen.add(id);
  }
  return { seats, ind };
}
const isMiMo = r => policy.singleSeat.clients.includes(r.client) || [r.model, r.modelId].some(m => typeof m === 'string' && m.startsWith(policy.singleSeat.modelPrefix));
function stateOf(q, r, now) {
  const s = q.routeStates.find(s => s.client === r.client && s.model === r.model);
  if (!s) return undefined;
  // AUTO-1 checks one day; this wrapper enforces the operational fifteen-minute bound.
  const at = Date.parse(s.at);
  const fresh = typeof s.at === 'string' && /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/.test(s.at)
    && Number.isFinite(at) && new Date(at).toISOString() === s.at && at <= now && now - at <= policy.routeMaxAgeMs;
  return fresh ? s : { ...s, proofSha256: null };
}
function quotaContext(value) {
  if (value === undefined) return null;
  io.fields(value, ['snapshot', 'policy', 'states', 'requests'], ['snapshot', 'policy', 'states', 'requests']);
  io.fields(value.policy, ['cashDaily', 'vibeDaily', 'reserveFraction'], ['cashDaily', 'vibeDaily', 'reserveFraction']);
  if (!io.money(value.policy.cashDaily) || !io.money(value.policy.vibeDaily) || value.policy.reserveFraction !== policy.dailyCeilings.reserveFraction
      || D.cmp(D.parse(value.policy.cashDaily), D.parse(policy.dailyCeilings.cash)) > 0
      || D.cmp(D.parse(value.policy.vibeDaily), D.parse(policy.dailyCeilings.vibe)) > 0) io.fail('quota-policy-over-ceiling');
  if (!Array.isArray(value.states) || !value.states.length || !Array.isArray(value.requests)) io.fail('quota-context-invalid');
  for (const s of value.states) if (s5.stateProblem(s, s.machine)) io.fail('quota-state-invalid');
  if (new Set(value.states.map(s => s.machine)).size !== value.states.length) io.fail('quota-state-conflict');
  for (const r of value.requests) if (!io.object(r) || !s5.routeIdentity(r.route)) io.fail('quota-request-invalid');
  if (new Set(value.requests.map(r => `${r.route.client}:${r.route.model}`)).size !== value.requests.length) io.fail('quota-request-conflict');
  return clone(value);
}
function withPriceBindings(catalog, q) {
  if (!catalog.ok) return catalog;
  const updated = { ...catalog, aliases: { ...catalog.aliases, routeAliases: catalog.aliases.routeAliases.map(a => ({ ...a })) } };
  for (const state of q.routeStates) {
    if (!state.priceRoute) continue;
    const ref = state.priceRoute;
    io.fields(ref, ['platform', 'model', 'provider', 'priceKind', 'variant'], ['platform', 'model', 'provider']);
    if (!io.id(ref.platform) || !io.id(ref.model) || !(ref.provider === null || io.id(ref.provider))) io.fail('price-binding-invalid');
    const alias = updated.aliases.routeAliases.find(a => a.client === state.client && a.model === state.model);
    if (!alias || alias.modelId === null) io.fail('price-binding-identity-unknown');
    const canonical = require('../../.ai/bin/accounting/lib/price-ids.cjs').canonicalForLadder(state.client, state.model);
    const rows = catalog.prices.records.filter(p => p.platform === ref.platform && p.platformModelId === ref.model && p.provider === ref.provider
      && p.priceKind === (ref.priceKind || 'list') && p.variant === (ref.variant || 'standard'));
    if (rows.length !== 1 || !(rows[0].canonicalId && [canonical, alias.modelId, alias.model].includes(rows[0].canonicalId)
      || [alias.modelId, alias.model].includes(rows[0].platformModelId))) io.fail('price-binding-model-mismatch');
    alias.priceRoute = { ...ref };
  }
  return updated;
}
function quotaPreview(ctx, candidate, tokens, now, commit = false) {
  if (!ctx) return { status: 'unverified', reason: 's5-context-not-provided', reservationRequired: true };
  const request = ctx.requests.find(r => r.route.client === candidate.client && r.route.model === candidate.model);
  if (!request || !tokens || !request.maxTokens || !io.count(request.maxTokens.input) || !io.count(request.maxTokens.output)
      || request.maxTokens.input < tokens.input || request.maxTokens.output < tokens.output) return { status: 'refuse', reason: 's5-bound-or-route-missing', reservationRequired: true };
  const states = clone(ctx.states);
  const result = s5.preflight(clone(request), { snapshot: ctx.snapshot, policy: ctx.policy, now,
    store: { transaction: fn => fn(states[0], states.slice(1)) } });
  if (commit && result.status === 'allow') ctx.states = states;
  return { status: result.status, reason: result.reason, reservedUsd: result.reservedUsd ?? null, reservationRequired: true };
}
function fallback(q, classification, reason, root, now) {
  // A corrupt catalog is never replaced by an old catalog. The existing resolver's
  // ladder is a separate diagnostic source; unknown class/price/strength cannot qualify.
  let result;
  try {
    const ladder = io.readJson(root, 'docs/ops/model-ladder.json');
    const registry = io.readJson(root, '.ai/docs/clients.json');
    result = require('../../.ai/bin/protocol-dispatch/resolver.cjs').resolveSlot({ id: q.task.packageId, floor: classification.tier, role: ROLES[q.role],
      substitutes: 2, independence: { lineage: controlKeys.flatMap(k => q.lineage[k]) } }, ladder, registry,
    { probeFn: (client, model) => { const s = stateOf(q, { client, model }, now); return { ok: Boolean(s?.available === true && s.servedModel === model && /^[a-f0-9]{64}$/.test(s.proofSha256 || '') && typeof s.balanceUsd === 'number' && s.balanceUsd > 0) }; } });
  } catch { result = { admissible: [], reason: 'fallback-unavailable' }; }
  return { source: 'ladder', selectionFallback: { reason }, candidates: [], excluded: [],
    fallback: { reason: /^[a-z-]+$/.test(result.reason || '') ? result.reason : 'fallback-unverified', rows: result.admissible?.length ?? null },
    assignments: [], status: 'BLOCKED', reason: 'fallback-strength-and-price-unverified' };
}
function assign(q, options = {}) {
  const { seats, ind } = requestOf(q);
  const classification = complexity(q.task);
  const now = Date.parse(options.now || new Date().toISOString());
  if (!Number.isFinite(now)) io.fail('clock-invalid');
  const root = options.repoRoot || ROOT;
  //  () switch: options.routeOrder overrides the tracked data;
  // absent or disabled data leaves the outputs byte-identical; a present but
  // corrupt file is BLOCKED with a recorded reason, never a silent disable.
  let orderData = Object.hasOwn(options, 'routeOrder') ? options.routeOrder : null, orderProblem = null;
  try {
    if (!Object.hasOwn(options, 'routeOrder')) orderData = routeOrderLib.loadRouteOrderData(root);
    // null explicitly disables; every other present value must prove its
    // grammar BEFORE enabled is read, including disabled overrides.
    else if (orderData !== null) {
      try { routeOrderLib.validateData(orderData); }
      catch { io.fail('route-order-data-invalid'); }
    }
  } catch (e) {
    if (e.code !== 'route-order-data-invalid') throw e; orderProblem = 'route-order-data-invalid';
  }
  const catalog = withPriceBindings(options.catalog || adapter.loadCatalog({ repoRoot: root, now: new Date(now).toISOString() }), q);
  let choice;
  if (orderProblem) {
    choice = { source: 'selection', selectionFallback: { reason: orderProblem }, catalogVersion: catalog.ok ? catalog.version : null,
      catalogHashes: catalog.ok ? catalog.hashes : {}, candidates: [], excluded: [], pairExcluded: [],
      assignments: [], status: 'BLOCKED', reason: orderProblem };
  } else if (!catalog.ok) choice = fallback(q, classification, catalog.reason, root, now);
  else {
    const result = adapter.select({ role: ROLES[q.role], taskClass: classification.tier, tokens: q.tokens, substitutes: 10,
      independence: { lineage: controlKeys.flatMap(k => q.lineage[k]) } }, catalog, { routeStateFn: r => stateOf(q, r, now) });
    if (!result.ok) choice = fallback(q, classification, result.reason, root, now);
    else {
      const transportById = new Map(adapter.routes(catalog).map(r => [ `${r.client}:${r.model}:${r.effort || 'unknown'}`, { transport: r.cfg.transport || r.client, family: r.alias?.family || r.modelId } ]));
      const quota = quotaContext(q.reservationContext), candidates = [], excluded = [], rowsMeta = [];
      for (const r of result.candidates) {
        const identity = transportById.get(r.id), reasons = [...r.excluded, ...r.reasons.filter(x => x !== 'thin-evidence')];
        const route = { ...r, ...identity };
        if (['certifier', 'pre-reviewer'].includes(q.role) && policy.reviewExcludedMakers.includes(r.maker)) reasons.push('add60');
        if (excludesRoute(ind, route)) reasons.push('independence');
        if (policy.topModel.modelIds.some(m => m === r.model || m === r.modelId)
            && (policy.topModel.forbiddenKinds.includes(q.task.kind) || Number(classification.tier.slice(1)) < policy.topModel.minTier
              || !(classification.riskClass === 'A' && io.count(q.task.failedRounds) && q.task.failedRounds >= policy.topModel.minFailedRounds
                || q.task.superImportant === true || q.task.kind === 'design'))) reasons.push('top-model-policy');
        if (isMiMo(route) && q.activeSeats.some(isMiMo)) reasons.push('mimo-busy');
        if (!io.id(route.transport) || !io.id(route.family)) reasons.push('route-identity-unknown');
        const preview = r.qualified ? quotaPreview(quota, r, q.tokens, now) : null;
        if (preview && !['allow', 'unverified'].includes(preview.status)) reasons.push(preview.reason);
        const row = { client: r.client, model: r.model, modelId: r.modelId, effort: r.effort, maker: r.maker, transport: route.transport,
          family: route.family, class: r.class, score: r.score, estimatedCost: r.price.perTask, priceBasis: r.price.basis,
          reasons: [...new Set(reasons)].sort(), quota: preview };
        const qualifiedRow = r.qualified && !row.reasons.length;
        if (qualifiedRow) candidates.push(row); else excluded.push(row);
        rowsMeta.push({ row, qualified: qualifiedRow });
      }
      // The kind key stands before the existing price-per-task key.
      // The selector orders rows by class and price; refused and
      // kept-but-unqualified rows move to excluded with the exact reason, kept
      // qualified rows are re-ordered by kind (and, inside subscription, by
      // the minimal-sufficient rule). An absent or non-closed task
      // kind is the unknown tier with caution, never a throw.
      let routeOrderMeta = null;
      if (orderData && orderData.enabled === true) {
        const journal = routeOrderLib.loadFarmRuns(root);
        const decision = routeOrderLib.routeOrder(rowsMeta.map(({ row, qualified }) => ({
          route: `${row.client}:${row.model}`, qualified, reasons: row.reasons, priceKnown: row.estimatedCost !== null,
          classRank: row.class !== null && adapter.CLASSES.includes(row.class) ? adapter.CLASSES.indexOf(row.class) : null,
          cost: row.estimatedCost
        })), { data: orderData, taskKind: q.task.kind ?? null, farmRuns: journal.rows });
        const refusals = new Map(decision.refused.map(f => [f.index, f]));
        const position = new Map([...decision.ordered, ...decision.unqualified].map(o => [o.index, o]));
        for (const [i, meta] of rowsMeta.entries()) {
          const ref = refusals.get(i), pos = position.get(i);
          meta.row.routeKind = (ref || pos).kind;
          meta.row.routeOrderReason = ref ? ref.reason : pos.reason;
          if (ref) { meta.row.reasons = [...new Set([...meta.row.reasons, ref.reason])].sort(); meta.qualified = false; }
        }
        candidates.length = 0; excluded.length = 0;
        const kept = new Set(decision.ordered.map(o => o.index));
        for (const o of decision.ordered) candidates.push(rowsMeta[o.index].row);
        for (const [i, meta] of rowsMeta.entries()) if (!kept.has(i)) excluded.push(meta.row);
        routeOrderMeta = { applied: true, order: decision.order, taskKind: decision.taskKind, cautions: decision.cautions,
          problems: journal.problems, invalidJournalRows: journal.invalidRows };
      }
      const assignments = [], pairExcluded = [];
      for (const row of candidates) {
        if (assignments.length === seats) break;
        if (assignments.some(a => a.transport === row.transport || a.modelId === row.modelId || a.family === row.family || isMiMo(a) && isMiMo(row))) {
          const reasons = [];
          if (assignments.some(a => a.transport === row.transport)) reasons.push('same-transport');
          if (assignments.some(a => a.modelId === row.modelId || a.family === row.family)) reasons.push('same-model-family');
          if (isMiMo(row) && assignments.some(isMiMo)) reasons.push('mimo-busy');
          pairExcluded.push({ ...row, reasons }); continue;
        }
        const preview = quotaPreview(quota, row, q.tokens, now, true);
        if (!['allow', 'unverified'].includes(preview.status)) { pairExcluded.push({ ...row, reasons: [preview.reason], quota: preview }); continue; }
        assignments.push({ ...row, role: q.role, quota: preview });
      }
      choice = { source: 'selection', selectionFallback: null, catalogVersion: catalog.version, catalogHashes: catalog.hashes,
        ...(routeOrderMeta ? { routeOrder: routeOrderMeta } : {}),
        candidates, excluded, pairExcluded, assignments: assignments.length === seats ? assignments : [],
        status: assignments.length === seats ? 'ASSIGNED' : 'BLOCKED', reason: assignments.length === seats ? 'selection-ranked' : 'no-independent-qualified-seats' };
    }
  }
  const output = { schema: 'assignment/1', attemptId: q.attemptId ?? null, role: q.role, tier: classification.tier, classification, ...choice,
    launchAuthority: false, reservationRequired: true };
  output.assignmentId = io.hash(output);
  return io.publicValue(output);
}
function main(argv) {
  try {
    if (![1, 3].includes(argv.length) || argv.length === 3 && argv[1] !== '--out') io.fail('usage');
    const input = path.resolve(argv[0]); const inputRoot = path.dirname(input);
    const q = io.readJson(inputRoot, input);
    const output = assign(q);
    let target = null;
    if (argv.length === 3) {
      target = path.resolve(argv[2]);
      const same = require('../../.ai/bin/lib/path-safe.cjs').sameFileOrNested(input, target);
      if (same) io.fail('input-output-overlap');
      const targetGuard = io.guard(path.dirname(target), target);
      if (targetGuard.exists && targetGuard.type !== 'file') io.fail('output-target-not-file');
    }
    // The standalone CLI owns one output directory. It records BEFORE emission;
    // --out chooses that directory, otherwise  is the output.
    // Pure assign() has no writes; launcher callers use recordAssignment themselves.
    const outputRoot = target ? path.dirname(target) : path.join(__dirname, 'output');
    const feedbackRoot = path.join(outputRoot, 'feedback');
    // The overlap refusals are decided BEFORE any output directory is
    // created: a refused input leaves no new directory behind (round 7).
    if (require('../../.ai/bin/lib/path-safe.cjs').sameFileOrNested(input, feedbackRoot)
        || target && require('../../.ai/bin/lib/path-safe.cjs').sameFileOrNested(target, feedbackRoot)) io.fail('feedback-output-overlap');
    require('./feedback.cjs').refuseDisposableRoot(feedbackRoot);
    if (!target) { io.guard(__dirname, outputRoot); require('node:fs').mkdirSync(outputRoot, { recursive: true }); io.guard(__dirname, outputRoot); }
    io.guard(outputRoot, feedbackRoot); require('node:fs').mkdirSync(feedbackRoot, { recursive: true }); io.guard(outputRoot, feedbackRoot);
    const machine = 'm-' + io.hash(require('node:os').hostname()).slice(0, 24);
    require('./feedback.cjs').recordAssignment(feedbackRoot, output, machine);
    if (target) {
      io.writeJson(path.dirname(target), target, output);
    } else process.stdout.write(JSON.stringify(output, null, 2) + '\n');
    return output.status === 'ASSIGNED' ? 0 : 1;
  } catch { process.stderr.write('Assignment input or output refused; content withheld\n'); return 2; }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { assign, main, quotaPreview, quotaContext, withPriceBindings };

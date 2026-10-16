'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { getRepoRoot, gitIn } = require('./procfs.cjs');
const { loadRegistry, loadDispatch, loadLadder, verifyLadderSectionSha256 } = require('./registry.cjs');
const { probeClient } = require('./clients.cjs');
const { independenceOf, excludesRoute } = require('../lib/selection-constraints.cjs');

// An adapter diagnostic is not a usable recommendation. Require a closed
// positive result shape and an admitted, qualified primary before changing source.
const selectionObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const selectionId = v => typeof v === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:/+~-]{0,159}$/.test(v);
const selectionRoute = r => selectionObject(r) && r.qualified === true && selectionId(r.id)
  && selectionId(r.client) && selectionId(r.model) && selectionId(r.modelId)
  && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(r.effort)
  && ['workhorse', 'second', 'flagship'].includes(r.class) && typeof r.score === 'number' && Number.isFinite(r.score) && r.score >= 0 && r.score <= 1
  && typeof r.price?.perTask === 'string' && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(r.price.perTask)
  && Array.isArray(r.excluded) && r.excluded.length === 0;
function selectionProblem(result) {
  if (!selectionObject(result) || typeof result.ok !== 'boolean') return 'selection-result-malformed';
  if (result.ok === false) return typeof result.reason === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(result.reason) ? result.reason : 'selection-result-malformed';
  if (result.source !== 'selection' || result.selection !== 'resolver' || !Array.isArray(result.candidates) || !Array.isArray(result.admissible) || !Array.isArray(result.substitutes)) return 'selection-result-malformed';
  if (result.primary === null && result.admissible.length === 0 && result.substitutes.length === 0 && result.reason === 'selection-no-qualified-route') return 'selection-no-qualified-route';
  if (result.reason !== 'selection-ranked' || !selectionRoute(result.primary) || !result.substitutes.every(selectionRoute)) return 'selection-result-malformed';
  const named = [result.primary, ...result.substitutes];
  if (new Set(named.map(r => r.id)).size !== named.length || !named.every(r => result.admissible.includes(r) && result.candidates.includes(r))) return 'selection-result-malformed';
  return null;
}
function selectionFallbackOf(result, reason) {
  const hashes = {};
  // Hash provenance contains only the catalog's named inputs, never arbitrary
  // adapter text or absolute machine paths supplied through a test seam.
  for (const [key, hash] of Object.entries(selectionObject(result?.hashes) ? result.hashes : {})) {
    if (key === '.ai/docs/clients.json' && typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)) hashes[key] = hash;
  }
  return { reason, hashes };
}

function computePins(slot, dispatchPath, repoRoot = getRepoRoot()) {
  let head = '';
  try {
    const r = gitIn(repoRoot, ['rev-parse', 'HEAD']);
    head = (r.stdout || '').trim();
  } catch {}
  if (!head || !/^[0-9a-f]{40}$/.test(head)) {
    head = '0000000000000000000000000000000000000000';
  }

  const launchFull = path.resolve(repoRoot, slot.launch);
  let launchSha256 = '';
  if (fs.existsSync(launchFull)) {
    launchSha256 = crypto.createHash('sha256').update(fs.readFileSync(launchFull)).digest('hex');
  }

  const dispatchFull = path.resolve(repoRoot, dispatchPath);
  let dispatchVersion = '';
  if (fs.existsSync(dispatchFull)) {
    dispatchVersion = crypto.createHash('sha256').update(fs.readFileSync(dispatchFull)).digest('hex');
  }

  const copyInHashes = {};
  if (Array.isArray(slot.copyIn)) {
    for (const c of slot.copyIn) {
      const full = path.resolve(repoRoot, c);
      if (fs.existsSync(full)) {
        copyInHashes[c] = crypto.createHash('sha256').update(fs.readFileSync(full)).digest('hex');
      }
    }
  }

  return {
    head,
    launchFile: slot.launch.replace(/\\/g, '/'),
    launchSha256,
    roleSha256: null,
    corpusHash: null,
    dispatchVersion,
    copyInHashes
  };
}

function verifyPins(pins, slot, dispatchPath, repoRoot = getRepoRoot()) {
  if (!pins) return { ok: false, reason: 'pins-missing' };
  const current = computePins(slot, dispatchPath, repoRoot);
  if (current.launchSha256 !== pins.launchSha256) {
    return { ok: false, reason: `pin-changed ${slot.launch.replace(/\\/g, '/')}` };
  }
  if (current.dispatchVersion !== pins.dispatchVersion) {
    return { ok: false, reason: `pin-changed ${dispatchPath.replace(/\\/g, '/')}` };
  }
  if (pins.copyInHashes) {
    for (const [p, h] of Object.entries(pins.copyInHashes)) {
      if (current.copyInHashes[p] !== h) {
        return { ok: false, reason: `pin-changed ${p.replace(/\\/g, '/')}` };
      }
    }
  }
  return { ok: true };
}

// K-003 (rank scale): tiers T1-T9 are relative inside one maker (P-L3-003 R-L3-003.3, P-L2-002 tier table, PROTO-DEC-0086 item 5).
// The resolver therefore orders candidates only WITHIN one maker. Across makers it uses nothing but the explicit order of the
// ladder file for the task class (ladder.makerOrder[floor] = { order, source, date, by }, data supplied by the owner or the
// operator). When the admissible candidates span several makers and no such order exists, it invents none: no primary, the
// candidate set, the reason cross-maker-order-missing and a stop-question (P-L0-002). It reads only the ladder file it is given
// and the client registry for the liveness probe. AUTO-1 allows an explicit read-only
// selection recommendation; real dispatch remains OFF by default (/119).
const CROSS_MAKER_MISSING = 'cross-maker-order-missing';

function makerOrderFor(ladder, floorKey) {
  const mo = ladder && ladder.makerOrder && ladder.makerOrder[floorKey];
  if (!mo || !Array.isArray(mo.order) || !mo.order.length || !mo.source || !mo.date) return null;
  return { key: floorKey, order: mo.order.slice(), source: mo.source, date: mo.date, by: mo.by || null };
}

function stopQuestionText(slot, floorKey, candidates) {
  const makers = candidates.map(c => c.maker);
  return [
    `STOP-QUESTION resolver ${CROSS_MAKER_MISSING} slot=${slot.id} task-class=${floorKey}`,
    `1. Context: choosing the executor of slot ${slot.id} (role ${slot.role || '-'}, floor ${floorKey}); admissible makers: ${makers.join(', ')}.`,
    '2. Problem: rule missing: tiers are provider-relative (P-L3-003 R-L3-003.3), so no rule orders these makers against each other, and the ladder holds no explicit maker order for this task class.',
    `3. Options: (a) name the maker order for ${floorKey} (owner or operator, with source and date), rebuilt into the ladder by docs/ops/ladder-build.cjs --maker-order; (b) name the route of this slot directly (slot.route, selection owner); (c) narrow the slot (independence) to one maker.`,
    '4. Recommendation: (b) for this launch, (a) for the task class; the resolver does not act on it.',
    `5. Waiting for: a maker order for ${floorKey} or a named route for slot ${slot.id}.`,
  ].join('\n');
}

//  (: no Mistral certifiers) and  item 2: a choice for a certifier or a reviewer (or any slot of the
// certification stage) never names Mistral. An owner rule about roles, not ladder data, so the resolver applies it to every slot
// without a route: the dispatch run, the resolve verb and the shadow record obey it alike. An explicit slot.route is the owner's
// own word and is returned untouched before this rule is reached.
const ROLE_RULE = { roles: ['certifier', 'reviewer'], stageKinds: ['certification'], excludeProviders: ['Mistral'], source: 'owner rule of the kernel ' };

function roleRuleOf(slot) {
  const role = typeof slot.role === 'string' ? slot.role.trim().toLowerCase() : '';
  if (!ROLE_RULE.roles.includes(role) && !ROLE_RULE.stageKinds.includes(slot.stageKind)) return null;
  return { role: slot.role || null, stageKind: slot.stageKind || null, excludeProviders: ROLE_RULE.excludeProviders.slice(), source: ROLE_RULE.source };
}

// Common row view of a ladder/1 rung or a ladder/2 row: maker, tier test against the floor and the order inside the maker.
function ladderRows(ladder) {
  if (ladder.schema === 'ladder/2') {
    return (ladder.rows || []).map((r, i) => ({ ...r, rung: r.id, label: r.id, provider: r.maker, model: r.routeModel, makerModel: r.model, tiers: r.tier === null || r.tier === undefined ? [] : [r.tier], _pos: i, _v: 2 }));
  }
  return (ladder.rungs || []).map((r, i) => ({ ...r, maker: r.provider || null, _pos: i, _v: 1 }));
}
// Inside one maker: ladder/2 takes the lowest tier that meets the floor first (the closest fit, then up); ladder/1 keeps the owner's
// rung order (largest rung number first, then the lowest order), which is the behaviour of 0.x inside one provider.
function withinMaker(a, b) {
  if (a._v === 2) return (a.tier - b.tier) || (a._pos - b._pos);
  if (b.rung !== a.rung) return b.rung - a.rung;
  return a.order - b.order;
}

function resolveSlot(slot, ladder, registry = {}, opts = {}) {
  if (slot.route) {
    return {
      selection: 'owner',
      ladderSnapshot: null,
      primary: slot.route,
      substitutes: (slot.fallback || []).slice(0, 2),
      excluded: [],
      skipped: [],
      unverified: [],
      approval: slot.approval || null,
      shortfall: null,
      admissible: [slot.route],
      ladderVersion: ladderVersionOf(ladder),
      candidates: [],
      reason: 'owner-route',
      makerOrder: null,
      roleRule: null,
      stopQuestion: null,
      terminal: null
    };
  }

  // Explicit switch, default OFF here. Owner routes return before this boundary.
  // The adapter lives in source-only catalog tools and never launches a client.
  const independence = independenceOf(slot.independence);
  let selectionFallback = null;
  if (opts.selectionEnabled === true) {
    try {
      const adapter = { recommend: () => ({ ok: false, reason: 'selection-not-shipped' }) };
      const result = adapter.recommend(slot, opts);
      const problem = selectionProblem(result);
      if (problem === null) return result;
      selectionFallback = selectionFallbackOf(result, problem);
    } catch { selectionFallback = { reason: 'selection-unavailable', hashes: {} }; }
  }

  const floorNum = parseInt(slot.floor.replace(/^T/, ''), 10);
  const substitutesCount = slot.substitutes !== undefined ? slot.substitutes : 2;
  const isLong = slot.long !== undefined ? Boolean(slot.long) : true;
  const stageKind = slot.stageKind || 'other';

  const excluded = [];
  const skipped = [];
  const unverified = [];
  const admissible = [];

  const probeFn = opts.probeFn || ((client, model) => {
    if (opts.skipProbe) return { ok: true, state: 'OK' };
    const reg = registry.clients ? registry : (opts.registry ? loadRegistry(opts.registry) : loadRegistry());
    return probeClient(client, reg, { model });
  });

  const floorKey = `T${floorNum}`;
  const roleRule = roleRuleOf(slot);
  for (const rung of ladderRows(ladder)) {
    // 1. Route data
    if (!rung.client || !rung.model) {
      excluded.push({ rung: rung.rung, label: rung.label, reason: 'route-unknown' });
      continue;
    }
    if (!rung.maker) {
      excluded.push({ rung: rung.rung, label: rung.label, reason: 'maker-unknown' });
      continue;
    }

    // 2. Hard constraints
    if (slot.constraints && slot.constraints.contextMin) {
      const minCtx = slot.constraints.contextMin;
      if (rung.contextWindow === null || rung.contextWindow === undefined) {
        unverified.push({ rung: rung.rung, constraint: 'contextMin' });
      } else if (rung.contextWindow < minCtx) {
        excluded.push({ rung: rung.rung, label: rung.label, reason: 'context-window' });
        continue;
      }
    }

    // 3. Floor, inside the maker's own scale (a tier is never compared with another maker's tier)
    if (!rung.tiers || !rung.tiers.length) {
      excluded.push({ rung: rung.rung, label: rung.label, reason: 'tier-unknown' });
      continue;
    }
    const maxTier = Math.max(...rung.tiers);
    if (maxTier < floorNum) {
      excluded.push({ rung: rung.rung, label: rung.label, reason: 'below-floor' });
      continue;
    }
    // a ladder/2 cell whose effort the client registry cannot set is never requested (P-L3-005 R-L3-005.7)
    if (rung.effortStatus === 'not-in-registry-values') {
      excluded.push({ rung: rung.rung, label: rung.label, reason: 'effort-not-settable' });
      continue;
    }

    // 4. Role rule of the owner (), then independence
    if (roleRule && roleRule.excludeProviders.includes(rung.maker)) {
      excluded.push({ rung: rung.rung, label: rung.label, reason: 'role-rule' });
      continue;
    }
    if (slot.independence) {
      if (excludesRoute(independence, { ...rung, modelId: rung.makerModel, transport: registry.clients?.[rung.client]?.transport || rung.client })) {
        excluded.push({ rung: rung.rung, label: rung.label, reason: 'independence' });
        continue;
      }
    }

    // 5. Approval
    if (rung.approval === 'owner-long-task' && isLong && !slot.approval) {
      skipped.push({ rung: rung.rung, label: rung.label, reason: 'needs-approval' });
      continue;
    }

    // 6. Liveness
    const probe = probeFn(rung.client, rung.model);
    if (!probe.ok) {
      const reason = probe.state ? `unavailable:${probe.state}` : 'unavailable';
      skipped.push({ rung: rung.rung, label: rung.label, reason: 'unavailable', detail: reason });
      continue;
    }

    admissible.push(rung);
  }

  // 7. Order inside each maker, then across makers only by the explicit order of the task class
  const byMaker = new Map();
  for (const r of admissible) {
    if (!byMaker.has(r.maker)) byMaker.set(r.maker, []);
    byMaker.get(r.maker).push(r);
  }
  for (const list of byMaker.values()) list.sort(withinMaker);
  const candidates = [...byMaker.values()].map(list => list[0]);
  let reason = null;
  let order = null;
  let makerOrder = null;
  if (byMaker.size === 1) {
    order = [...byMaker.keys()];
    reason = 'single-maker';
  } else if (byMaker.size > 1) {
    makerOrder = makerOrderFor(ladder, floorKey);
    const listed = makerOrder ? makerOrder.order.filter(m => byMaker.has(m)) : [];
    if (!listed.length) {
      reason = CROSS_MAKER_MISSING;
    } else {
      order = listed;
      reason = 'maker-order';
      for (const [m, list] of byMaker) {
        if (!listed.includes(m)) for (const r of list) skipped.push({ rung: r.rung, label: r.label, reason: 'maker-not-ordered' });
      }
    }
  }

  // 8. Primary and substitutes: the best of each ordered maker in turn, then the next of each (a substitute of another maker first)
  const ranked = [];
  if (order) {
    const lists = order.map(m => byMaker.get(m).slice());
    for (let depth = 0; lists.some(l => l.length > depth); depth++) {
      for (const l of lists) if (l.length > depth) ranked.push(l[depth]);
    }
  }
  const primary = ranked.length > 0 ? ranked[0] : null;
  const substitutes = ranked.slice(1, 1 + substitutesCount);

  // 9. Terminal cases
  let terminal = null;
  let shortfallStr = null;
  let stopQuestion = null;

  if (reason === CROSS_MAKER_MISSING) {
    terminal = CROSS_MAKER_MISSING;
    stopQuestion = stopQuestionText(slot, floorKey, candidates);
  } else if (!primary) {
    terminal = 'no-admissible-rung';
  } else {
    const shortfallCount = substitutesCount - substitutes.length;
    if (shortfallCount > 0) {
      shortfallStr = `shortfall=${shortfallCount}`;
      if (stageKind === 'kernel' || stageKind === 'certification') {
        terminal = 'shortfall';
      }
    }
  }

  return {
    selection: 'resolver',
    ...(selectionFallback ? { source: 'ladder', selectionFallback } : {}),
    ladderSnapshot: ladder.schema === 'ladder/2' ? (ladder.asOf || null) : ((ladder.source && ladder.source.snapshot) || null),
    ladderVersion: ladderVersionOf(ladder),
    primary,
    substitutes,
    excluded,
    skipped,
    unverified,
    approval: slot.approval || null,
    shortfall: shortfallStr,
    admissible,
    candidates,
    reason,
    makerOrder,
    roleRule,
    stopQuestion,
    terminal
  };
}

function ladderVersionOf(ladder) {
  if (!ladder) return null;
  const stamp = ladder.schema === 'ladder/2' ? ladder.asOf : (ladder.source && ladder.source.snapshot);
  return `${ladder.schema || 'unknown'}@${stamp || 'unknown'}${ladder.fileSha256 ? `#sha256:${ladder.fileSha256.slice(0, 16)}` : ''}`;
}

function resolveCommand(dispatchFile, slotId, opts = {}) {
  const repoRoot = getRepoRoot(opts);
  const ladderPath = opts.ladder || path.resolve(repoRoot, 'docs/ops/model-ladder.json');
  const ladder = loadLadder(ladderPath, repoRoot);

  const checkLadder = verifyLadderSectionSha256(ladder, repoRoot);
  if (!checkLadder.ok) {
    console.log('ERROR reason=ladder-stale');
    return 1;
  }

  const dispatch = loadDispatch(dispatchFile);
  const slots = dispatch.slots || dispatch.jobs;
  const slot = slots.find(s => s.id === slotId);
  if (!slot) {
    console.log(`ERROR reason=slot-not-found slot=${slotId}`);
    return 2;
  }

  const registry = loadRegistry(opts.registry);
  const res = resolveSlot(slot, ladder, registry, opts);

  if (res.primary) {
    console.log(`RESOLVE slot=${slot.id} primary=${res.primary.client}:${res.primary.model || ''} rung=${res.primary.rung}`);
    for (let i = 0; i < res.substitutes.length; i++) {
      const sub = res.substitutes[i];
      console.log(`SUBSTITUTE n=${i + 1} route=${sub.client}:${sub.model || ''} rung=${sub.rung}`);
    }
  }

  for (const e of res.excluded) {
    console.log(`EXCLUDED rung=${e.rung} reason=${e.reason} label="${e.label || ''}"`);
  }
  for (const s of res.skipped) {
    console.log(`SKIPPED rung=${s.rung} reason=${s.reason} label="${s.label || ''}"`);
  }
  for (const u of res.unverified) {
    console.log(`UNVERIFIED rung=${u.rung} constraint=${u.constraint}`);
  }

  if (res.terminal === CROSS_MAKER_MISSING) {
    for (const c of res.candidates) {
      console.log(`CANDIDATE maker=${c.maker} route=${c.client}:${c.model || ''} rung=${c.rung}`);
    }
    console.log(`ASK_OWNER reason=${CROSS_MAKER_MISSING} task-class=T${slot.floor.replace(/^T/, '')}`);
    console.log(res.stopQuestion);
    return 1;
  }
  if (res.terminal === 'no-admissible-rung') {
    console.log('ERROR reason=no-admissible-rung');
    return 1;
  }
  if (res.terminal === 'shortfall') {
    console.log('ASK_OWNER reason=shortfall');
    return 1;
  }

  return 0;
}

// ---- recording mode (shadow): PROTO-DEC-0143 item 3 keeps selection with the operator until the owner's switch ----
// A launcher calls shadowResolve BEFORE it starts the client, with the role and the task class (floor tier) it states and the
// operator's own choice. The result is what the resolver WOULD choose; it is recorded next to the launch and changes nothing in
// the launch. It never throws: any failure becomes resolver.error (task-class-missing, ladder-stale, resolver-error). Liveness
// probes are skipped (probe: skipped): a shadow call starts no client process.
function routeOf(r) {
  if (!r) return null;
  return { maker: r.maker || r.provider || null, client: r.client, model: r.model || null, effort: r.effort || null, tier: r.tier || (Array.isArray(r.tiers) && r.tiers.length ? Math.max(...r.tiers) : null), id: r.rung || r.id,
    ...(Object.hasOwn(r, 'modelId') ? { modelId: r.modelId, class: r.class, score: r.score, dimension: r.dimension, price: r.price, budget: r.budget, qualified: r.qualified, reasons: r.reasons, excluded: r.excluded } : {}) };
}

function launchLine(tuple = {}) {
  return `Launch: model=${tuple.model || 'unknown'} effort=${tuple.effort || 'unknown'} client=${tuple.client || 'unknown'}`;
}

function resolverLine(shadow) {
  const r = (shadow && shadow.resolver) || {};
  const c = r.choice;
  const choice = c ? `${c.client}:${c.model} effort=${c.effort || 'unknown'}` : 'none';
  return `Resolver: choice=${choice} reason=${r.error ? `error:${r.error}` : (r.reason || r.terminal || '-')} task-class=${(shadow && shadow.taskClass) || '-'} ladder=${r.ladderVersion || '-'}${r.source === 'selection' ? ` source=${r.source}${r.catalogVersion ? ` catalog=${r.catalogVersion}` : ''}` : ''}`;
}

function shadowResolve(input = {}, opts = {}) {
  const op = input.operator || {};
  let selectionFallback = null;
  const out = {
    schema: 'resolver-shadow/1',
    role: input.role || null,
    taskClass: input.tier || null,
    stageKind: input.stageKind || 'other',
    probe: 'skipped',
    operator: { client: op.client || null, model: op.model || null, effort: op.effort || null },
    resolver: null
  };
  try {
    if (typeof input.tier !== 'string' || !/^T[1-9]$/.test(input.tier)) {
      out.resolver = { choice: null, substitutes: [], candidates: [], reason: null, ladderVersion: null, error: 'task-class-missing' };
    } else {
      const repoRoot = opts.repoRoot || path.resolve(__dirname, '..', '..', '..');
      const slot = { id: `shadow-${input.name || 'launch'}`, launch: 'shadow', role: input.role || 'unknown', floor: input.tier, stageKind: out.stageKind, substitutes: 2, ...(input.dimension ? { dimension: input.dimension } : {}), ...(input.tokens ? { tokens: input.tokens } : {}), ...(input.independence !== undefined ? { independence: input.independence } : {}) };
      independenceOf(slot.independence);
      let selectionResult = null;
      if (opts.selectionEnabled !== false) {
        try {
          const adapter = { recommend: () => ({ ok: false, reason: 'selection-not-shipped' }) };
          const result = adapter.recommend(slot, { ...opts, repoRoot });
          const problem = selectionProblem(result);
          if (problem === null) selectionResult = result;
          else selectionFallback = selectionFallbackOf(result, problem);
        } catch { selectionFallback = { reason: 'selection-unavailable', hashes: {} }; }
      }
      if (selectionResult) {
        const res = selectionResult;
        out.resolver = { choice: routeOf(res.primary), substitutes: res.substitutes.map(routeOf), candidates: res.candidates.map(routeOf), reason: res.reason, terminal: res.terminal, ladderVersion: null, source: 'selection', catalogVersion: res.catalogVersion, hashes: res.hashes };
      } else {
      const ladder = loadLadder(opts.ladder || 'docs/ops/model-ladder.json', repoRoot);
      const check = verifyLadderSectionSha256(ladder, repoRoot);
      if (!check.ok) {
        out.resolver = { choice: null, substitutes: [], candidates: [], reason: null, ladderVersion: ladderVersionOf(ladder), error: 'ladder-stale', detail: check.reason };
      } else {
        const res = resolveSlot(slot, ladder, {}, { skipProbe: true });
        out.resolver = {
          choice: routeOf(res.primary),
          substitutes: res.substitutes.map(routeOf),
          candidates: res.candidates.map(routeOf),
          reason: res.reason,
          terminal: res.terminal,
          ladderVersion: res.ladderVersion,
          ...(res.makerOrder ? { makerOrder: { key: res.makerOrder.key, source: res.makerOrder.source, date: res.makerOrder.date } } : {}),
          ...(res.roleRule ? { roleRule: res.roleRule } : {}),
          ...(res.stopQuestion ? { stopQuestion: res.stopQuestion } : {})
        };
      }
      if (opts.selectionEnabled !== false) Object.assign(out.resolver, { source: 'ladder', catalogVersion: null, hashes: {}, ...(selectionFallback ? { selectionFallback } : {}) });
      }
    }
  } catch (e) {
    out.resolver = { choice: null, substitutes: [], candidates: [], reason: null, ladderVersion: null, error: 'resolver-error', detail: opts.selectionEnabled === false ? String((e && e.message) || e).slice(0, 200) : (/^[A-Z][A-Z0-9_]{0,39}$/.test(e?.code || '') ? e.code : 'ladder-unavailable'), ...(selectionFallback ? { selectionFallback } : {}) };
  }
  if (opts.selectionEnabled !== false && out.resolver && !out.resolver.source) Object.assign(out.resolver, { source: 'ladder', catalogVersion: null, hashes: {} });
  out.launchLines = [launchLine(out.operator), resolverLine(out)];
  return out;
}

module.exports = { resolveSlot, resolveCommand, computePins, verifyPins, shadowResolve, launchLine };

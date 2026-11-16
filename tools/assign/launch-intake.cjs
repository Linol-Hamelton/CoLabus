'use strict';
// Launch intake: off/shadow or one assign-bridge advisory source. No argv changes.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const policyApi = require('./selection-policy.cjs');
const ownerFilter = require('../../.ai/bin/lib/selection-owner.cjs');
const risk = require('../../docs/ops/risk-class.cjs');
const { rubricTier, complexity } = require('./complexity.cjs');
const classifier = require('./task-classifier.cjs');
const dimensionRegistry = require('./dimension-registry.cjs').load();
const hash = v => createHash('sha256').update(typeof v === 'string' ? v : JSON.stringify(v)).digest('hex');
// A launch domain is a task-scope ID of the dimension registry; a layer ID or a removed ID is never one.
const DOMAINS = dimensionRegistry.taskIds;
const ROLES = { author: 'implementer', fixer: 'fixer', implementer: 'implementer', certifier: 'certifier', 'certifier-strong': 'certifier', 'certifier-medium': 'certifier', 'pre-review': 'reviewer', reviewer: 'reviewer', critic: 'critic', researcher: 'researcher', drafter: 'drafter', synthesiser: 'synthesiser', architect: 'architect', 'procedure-author': 'architect' };
const DOMAIN = dimensionRegistry.roles;
const plain = v => v && typeof v === 'object' && !Array.isArray(v);
const code = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v) ? v : 'unknown';

// An explicit descriptor may be the whole JSON task or a fenced selection-intake block.
// Plain Markdown can supply individual rubric scores. Prose is never executed or stored.
function descriptor(text) {
  const blocks = [...text.matchAll(/```selection-intake\s*\n([\s\S]*?)\n```/g)];
  if (text.includes('```selection-intake') && blocks.length !== 1) throw new Error('task-block-invalid');
  const block = blocks[0];
  if (block || text.trimStart().startsWith('{')) {
    const obj = require('../../.ai/bin/lib/text-safe.cjs').parseJsonUnique(block ? block[1] : text);
    const d = obj.schema === 'selection-task/1' ? obj.task : obj;
    if (!plain(d)) throw new Error('task-descriptor-invalid');
    return d;
  }
  const complexity = {};
  for (const key of policyApi.FACTORS) {
    const re = new RegExp(`^[ \\t]*(?:-[ \\t]*)?${key}:[ \\t]*([^\\r\\n]*)$`, 'gm');
    const hits = [...text.matchAll(re)];
    if (hits.length > 1) throw new Error('task-score-duplicate');
    if (hits.length) {
      const value = hits[0][1].trim();
      if (!/^[012]$/.test(value)) throw new Error('task-score-invalid');
      complexity[key] = Number(value);
    }
  }
  const domains = [...text.matchAll(/^\s*(?:-\s*)?domain:\s*(D-[A-Z]+)\s*$/gm)];
  if (domains.length > 1) throw new Error('task-domain-duplicate');
  // One plain scope line declares the write scope as exact repository paths separated by commas; the frame
  // checks every path as it checks the paths of a block, so an empty or invalid entry is a named unknown.
  const scopes = [...text.matchAll(/^[ \t]*(?:-[ \t]*)?scope:[ \t]*([^\r\n]*)$/gm)];
  if (scopes.length > 1) throw new Error('task-scope-duplicate');
  const specs = [...text.matchAll(/```task-spec\s*\n([\s\S]*?)\n```/g)];
  if (text.includes('```task-spec') && specs.length !== 1) throw new Error('task-spec-invalid');
  return { complexity, ...(domains.length ? { domain: domains[0][1] } : {}),
    ...(scopes.length ? { paths: scopes[0][1].split(',').map(p => p.trim().replace(/^`|`$/g, '')) } : {}),
    ...(specs.length ? { spec: classifier.validateSpec(require('../../.ai/bin/lib/text-safe.cjs').parseJsonUnique(specs[0][1])) } : {}) };
}

function repository(worktree, statedBase, run = spawnSync) {
  const git = args => {
    const r = run('git', ['-C', worktree, ...args], { encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 4 * 1024 * 1024 });
    if (r.error || r.status !== 0) throw new Error('intake-git-unavailable');
    return String(r.stdout || '');
  };
  const head = git(['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(head)) throw new Error('intake-head-invalid');
  let base;
  if (statedBase) base = git(['rev-parse', '--verify', '--end-of-options', `${statedBase}^{commit}`]).trim();
  else base = head; // A launch measures this task, never the inherited train.
  if (!/^[a-f0-9]{40}$/.test(base || '')) throw new Error('intake-base-unknown');
  // No rename detection: both ends count. Raw modes also preserve symlinks/gitlinks.
  const paths = [], changes = []; let special = false;
  for (const index of [false, true]) {
    const parts = git(['diff', ...(index ? ['--cached'] : []), '--raw', '--no-renames', '--no-ext-diff', '-z', base, '--']).split('\0');
    for (let i = 0; i < parts.length && parts[i]; i += 2) {
      const m = /^:(\d{6}) (\d{6}) [0-9a-f]+ [0-9a-f]+ [A-Z]$/.exec(parts[i]);
      if (!m || !parts[i + 1]) throw new Error('intake-diff-invalid');
      special ||= [m[1], m[2]].some(v => v === '120000' || v === '160000');
      paths.push(parts[i + 1]);
      changes.push({ status: parts[i].slice(-1), oldMode: m[1], newMode: m[2], paths: [parts[i + 1]] });
    }
  }
  const untracked = git(['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean);
  paths.push(...untracked);
  for (const p of untracked) changes.push({ status: 'A', oldMode: '000000', newMode: '100644', paths: [p] });
  const stats = git(['diff', '--numstat', '--no-renames', '--no-ext-diff', '-z', base, '--']).split('\0').filter(Boolean);
  let lines = 0;
  for (const row of stats) {
    const m = /^(\d+)\t(\d+)\t/.exec(row);
    if (!m) { lines = null; break; }
    lines += Number(m[1]) + Number(m[2]);
  }
  if (untracked.length) lines = null;
  return { head, base, paths, special, changes: [...new Map(changes.map(c => [JSON.stringify(c), c])).values()], lines };
}

const operational = p => /^\.ai\/(?:worklog|runtime)\//.test(p);
function taskRole(stated, text = '') {
  if (Object.hasOwn(ROLES, stated)) return ROLES[stated];
  const found = [...text.matchAll(/\byou are (?:the |an? )?(AUTHOR|FIXER|CERTIFIER|REVIEWER|RESEARCHER|ARCHITECT)\b/gi)]
    .map(m => ROLES[m[1].toLowerCase()]);
  return new Set(found).size === 1 ? found[0] : 'unknown';
}
function prosePaths(text, role) {
  // Planned scope needs a positive task intent. A check command, read-only
  // source or a "do not touch" instruction is not a declared write target.
  const matches = [...text.matchAll(/(?:^|[\s`("'])((?:\.ai|\.claude|tools|tests|docs|templates)\/[A-Za-z0-9_./-]+\.(?:cjs|mjs|js|ts|json|md|py|sh|ps1))(?=$|[\s`"'),:;.])/gm)];
  return [...new Set(matches.filter(m => {
    const start = Math.max(text.lastIndexOf('\n', m.index), text.lastIndexOf('. ', m.index), text.lastIndexOf('; ', m.index)) + 1;
    const prefix = text.slice(start, m.index).trim();
    const intent = /\b(?:update|edit|modify|change|fix|add|create|write|implement|save|produce)\b/i.test(prefix)
      || ['certifier', 'reviewer'].includes(role) && /\b(?:review|audit|inspect)\b/i.test(prefix);
    const command = /\b(?:node|npm|npx|python|pwsh|powershell)(?:\.exe)?(?:\s+--[A-Za-z-]+)*\s*$/i.test(prefix);
    return intent && !command && !/\b(?:do not|don't|never)\b/i.test(prefix);
  }).map(m => m[1]).filter(p => !operational(p) && risk.normalisePath(p).ok))].sort();
}
function frame(input, deps = {}) {
  const policy = deps.policy || policyApi.loadPolicy().obj;
  let text = '', d = {}, repo = null;
  const unknown = [];
  try {
    if (typeof input.text === 'string') text = input.text;
    else {
      const file = path.resolve(input.worktree, input.taskFile || '');
      const g = require('../../.ai/bin/lib/path-safe.cjs').readFileGuarded(path.parse(file).root, file);
      if (!g.ok || g.bytes.length > 200 * 1024) throw new Error('task-unreadable');
      const decoded = require('../../.ai/bin/lib/text-safe.cjs').decode(g.bytes, { bom: 'refuse', crlf: 'normalise', invisible: 'refuse' });
      if (!decoded.ok) throw new Error('task-encoding');
      text = decoded.text;
    }
    d = descriptor(text);
  } catch (e) { unknown.push('task-input-unknown', code(e.message)); }
  const role = taskRole(input.role, text);
  if (!Object.hasOwn(ROLES, input.role) && role !== 'unknown') unknown.push('role-from-task-text');
  try { repo = deps.repository || repository(input.worktree, input.base, deps.run); }
  catch (e) { unknown.push('diff-unknown', code(e.message)); }
  const declared = Array.isArray(d.paths) && d.paths.length && d.paths.every(p => typeof p === 'string' && risk.normalisePath(p).ok) ? d.paths : [];
  if (d.paths !== undefined && declared !== d.paths) unknown.push('declared-paths-invalid');
  const writeSet = d.spec?.writeSet;
  const actualPaths = (repo?.paths || []).filter(p => !operational(p));
  const planned = !actualPaths.length ? prosePaths(text, role) : [];
  const paths = [...new Set((writeSet ? writeSet.flatMap(c => c.paths) : declared.length ? declared : actualPaths.length ? actualPaths : planned)
    .filter(p => !operational(p)))].sort();
  if (planned.length && !writeSet && !declared.length) unknown.push('scope-from-task-text');
  if (declared.length || writeSet) unknown.push('scope-from-task-declaration');
  // Preserve real modes when known; planned paths carry an explicit estimate.
  const changes = repo?.changes?.filter(c => c.paths.some(p => paths.includes(p))) || [];
  const covered = new Set(changes.flatMap(c => c.paths));
  for (const p of paths) if (!covered.has(p)) changes.push({ status: 'M', oldMode: '100644', newMode: '100644', paths: [p] });
  let spec = d.spec;
  const explicitRubric = policyApi.FACTORS.every(k => Number.isInteger(d.complexity?.[k]) && d.complexity[k] >= 0 && d.complexity[k] <= 2);
  // Ordinary prose can close a bounded advisory rubric. The inference is named
  // in unknown, so it never authorizes assign. Missing/poisoned prose stays unknown.
  if (spec === undefined && !explicitRubric && text.trim() && paths.length && !unknown.includes('task-input-unknown')
      && /\b(?:fix|update|edit|implement|add|build|review|audit|author|document|test)\b/i.test(text)) {
    spec = { schema: 'task-spec/1', openQuestions: 1, precedent: 'partial',
      requiresMigration: /\b(?:migrat\w*|schema)\b/i.test(text),
      externalEffect: /\b(?:deploy|publish|upload|production|database)\b/i.test(text),
      specPrecision: ['certifier', 'reviewer'].includes(role) ? 'review' : role === 'architect' ? 'open' : 'exact' };
    unknown.push('rubric-inferred-from-task-text');
  }
  let classified = null;
  if (spec !== undefined || changes.length) {
    try {
      if (spec !== undefined) classifier.validateSpec(spec);
      const classifierRole = { implementer: 'author', fixer: 'fixer', reviewer: 'pre-reviewer', certifier: 'certifier', architect: 'operator' }[role];
      const history = d.history || { failedRounds: 0, verdicts: [], defectClasses: [], unknowns: 0 };
      // The classifier receives actual modes and both staged and unstaged paths.
      // Missing launch history is explicit in the context, never represented as observed.
      classified = classifier.classifyTask({ packageId: 'launch-intake', role: classifierRole,
        changes, lines: repo?.lines ?? null, spec, history,
        manifestCtx: { manifest: new Set(policy.manifestOwned) } });
      if (!d.history) unknown.push('history-unknown');
      if (spec === undefined && !explicitRubric && classified.complexity) unknown.push('rubric-inferred-from-scope');
    } catch (e) { unknown.push('classifier-input-invalid', code(e.code || e.message)); }
  }
  const ctx = { manifest: new Set(policy.manifestOwned) };
  const rows = paths.map(p => risk.classifyPath(p, ctx));
  // An unreadable diff cannot be proved B even if the task declares only documents.
  const riskKnown = Boolean(repo && paths.length && !unknown.includes('declared-paths-invalid'));
  const riskClass = !riskKnown || repo.special || rows.some(r => r.cls === 'A') ? 'A' : 'B';
  const scores = Object.fromEntries(policyApi.FACTORS.map(k => [k, null]));
  if (classified?.complexity) Object.assign(scores, classified.complexity);
  const supplied = d.complexity;
  if (supplied !== undefined && (!plain(supplied) || Object.keys(supplied).some(k => !policyApi.FACTORS.includes(k)))) unknown.push('rubric-invalid');
  else if (supplied) for (const k of policyApi.FACTORS) {
    if (Number.isInteger(supplied[k]) && supplied[k] >= 0 && supplied[k] <= 2) scores[k] = supplied[k];
    else if (supplied[k] !== undefined) unknown.push(`score-invalid-${k}`);
  }
  const protectedScore = rows.some(r => /^RC-A(?:01|02|03|04|05|06|10)-/.test(r.rule)) ? 2 : rows.some(r => r.cls === 'A') ? 1 : 0;
  if (riskKnown) scores.protectedPaths = Math.max(scores.protectedPaths || 0, protectedScore);
  const layers = new Set(paths.map(p => /^\.ai\/core\/(L[0-9])/.exec(p)?.[1]
    || (/\.(?:md|txt|rst)$/i.test(p) ? 'documentation' : p.split('/').slice(0, 2).join('/'))));
  if (riskKnown) scores.coupling = Math.max(scores.coupling || 0, Math.min(2, layers.size - 1));
  const judgement = role === 'certifier' || role === 'architect' ? 2 : ['reviewer', 'critic'].includes(role) ? 1 : role === 'unknown' ? null : 0;
  if (judgement !== null) scores.independentJudgement = Math.max(scores.independentJudgement || 0, judgement);
  for (const k of policyApi.FACTORS) if (scores[k] === null) unknown.push(`score-unknown-${k}`);
  if (role === 'unknown') unknown.push('role-unknown');
  // Risk and tier are separate axes. Only an implementing frame inherits the kernel floor.
  const kernel = ['implementer', 'fixer', 'architect'].includes(role) && rows.some(r => r.cls === 'A');
  let tier = rubricTier(scores, { certification: role === 'certifier', kernel }, policy);
  if (classified && policyApi.FACTORS.every(k => Number.isInteger(scores[k]))) {
    const task = { ...classified, complexity: scores, riskClass };
    const structured = complexity(task, policy);
    tier = `T${Math.max(Number(tier.slice(1)), Number(structured.tier.slice(1)))}`;
  }
  const documentation = paths.length > 0 && paths.every(p => /\.(?:md|txt|rst)$/i.test(p));
  const domain = DOMAINS.includes(d.domain) ? d.domain : documentation && ['implementer', 'fixer'].includes(role) ? 'D-DOC' : DOMAIN[role] || null;
  if (deps.context) Object.assign(deps.context, { paths, descriptor: d, classified });
  return { schema: 'launch-task-frame/1', role, domain, riskClass, riskKnown,
    tier: unknown.some(s => /invalid|input-unknown|diff-unknown|role-unknown/.test(s)) ? `T${policy.taskPolicy.unknownTier}` : tier,
    complexity: scores, unknown: [...new Set(unknown)].sort(), policyHash: hash(policy),
    taskHash: text ? hash(text) : null, base: repo?.base || null, head: repo?.head || null,
    pathsHash: hash(paths), pathCount: paths.length, riskRules: [...new Set(rows.map(r => r.rule))].sort() };
}

function recommendation(shadow, context = {}) {
  const r = shadow?.resolver || {};
  const route = r.choice;
  const pool = ownerFilter.filterRoutes(route ? [route] : [], { ...context, alternativeRoutes: r.candidates || [] });
  const choice = pool.allowed.length && route && typeof route.client === 'string' && typeof route.model === 'string'
    ? { client: route.client, model: route.model, effort: route.effort || null } : null;
  return { schema: 'launch-selection-shadow/1', mode: 'shadow', launchAuthority: false,
    choice, source: code(r.source), reason: code(r.error || (route && !choice && pool.reason) || r.reason || r.terminal),
    status: r.error ? 'error' : choice ? 'recommended' : 'no-recommendation' };
}

// Single seam for author, certifier, wrapper and future operator queue callers.
// Runtime host extension: portable launchers do not acquire the operator kit's
// route-state dependencies merely by being installed or required.
const launchBridge = (moduleFile = path.resolve(__dirname, '../operator/assign-bridge.cjs')) => require(moduleFile);
function capture(input, deps = {}) {
  const modeApi = require('./host-mode.cjs');
  // Read host authority for every launch, including one missing its task file.
  const modeFile = Object.hasOwn(deps, 'modeFile') ? deps.modeFile : undefined;
  const mode = modeApi.read(modeFile, deps.now ? Date.parse(deps.now()) : Date.now(), { worktree: input.worktree, env: deps.env });
  const say = deps.say || input.say || (s => process.stderr.write(`${s}\n`));
  if (mode.mode !== 'off') say(`SELECTION mode=${mode.mode} reason=${mode.reason} expires=${mode.expiresAt || 'unknown'}`);
  // A host declaration that exists but is not in force is never a silent off.
  else if (['mode-expired', 'mode-missing-or-invalid'].includes(mode.reason)) say(`SELECTION mode=off reason=${mode.reason}`);
  const context = {};
  let taskFrame;
  try { taskFrame = frame(input, { ...deps, context }); }
  catch {
    const role = Object.hasOwn(ROLES, input.role) ? ROLES[input.role] : 'unknown';
    taskFrame = { schema: 'launch-task-frame/1', role, domain: DOMAIN[role] || null, riskClass: 'A', riskKnown: false, tier: 'T9',
      complexity: Object.fromEntries(policyApi.FACTORS.map(k => [k, null])), unknown: ['intake-unavailable'],
      policyHash: hash('unavailable'), taskHash: null, base: null, head: null, pathsHash: hash([]), pathCount: 0, riskRules: [] };
  }
  if (mode.mode !== 'off') {
    let result;
    const operator = input.advisoryOperator || input.operator;
    try { result = (deps.assignBridge || launchBridge()).recommendLaunch({ ...input, operator, assignmentMode: mode.mode }, taskFrame, context, deps.bridgeDeps); }
    catch { result = { decision: null, unknown: ['assign-bridge-unavailable'], reason: 'assign-bridge-unavailable' }; }
    const decision = result.decision;
    // Fallback from assign is diagnostic only, never a second recommendation.
    const layerDecision = decision?.source === 'selection' && !decision.selectionFallback ? decision : null;
    const filterContext = { repoRoot: deps.bridgeDeps?.repoRoot, role: taskFrame.role, mode: mode.mode, tier: taskFrame.tier,
      ownerContext: { ...deps.bridgeDeps?.ownerContext, now: deps.bridgeDeps?.now || (deps.now ? deps.now() : new Date().toISOString()),
        activeSeats: deps.bridgeDeps?.activeSeats, taskFacts: result.taskFacts },
      independence: lineageIndependence(context.descriptor) };
    const selectedPool = ownerFilter.filterRoutes(layerDecision?.assignments || [], { ...filterContext, alternativeRoutes: layerDecision?.candidates || [] });
    const selected = selectedPool.allowed[0];
    const rankedPool = ownerFilter.filterRoutes(layerDecision?.candidates || [], filterContext);
    const choice = selected ? { client: selected.client, model: selected.model, effort: selected.effort || null } : null;
    const actual = { client: operator?.client || null, model: operator?.model || null, effort: operator?.effort || null };
    const match = require('../../.ai/bin/lib/selection-metrics.cjs').compareRoutes(choice, actual);
    const differs = match === null ? null : !match;
    const ownerExplicit = input.ownerExplicit === true;
    const deviation = input.deviationReason || context.descriptor?.deviationReason;
    const deviationCode = code(deviation) !== 'unknown' && !require('../../.ai/bin/lib/secrets.cjs').secretIn(deviation) ? code(deviation) : 'unknown';
    // The owner's classes are read only while the host mode is assign; an off declaration passes no class.
    const ownerClassesApi = require('./owner-classes.cjs');
    const ownerDeclaration = mode.mode === 'assign' ? ownerClassesApi.read(deps.ownerClassesFile) : { on: false, reason: 'mode-not-assign', classes: [] };
    const ownerAdmission = ownerClassesApi.admit(ownerDeclaration, taskFrame,
      { descriptor: context.descriptor, repositoryRole: repositoryRole(input.worktree) }, deps.assignState || {});
    const eligibility = modeApi.eligibility(mode, taskFrame, decision, ownerExplicit, ownerAdmission.ownerClass);
    const advice = { schema: 'launch-advice/1', mode: mode.mode, modeReason: mode.reason,
      taskClass: modeApi.taskClass(taskFrame), recommended: choice, actual, handOverride: ownerExplicit,
      deviationReason: deviationCode !== 'unknown' ? deviationCode
        : differs === false ? 'recommendation-followed'
        : differs === true ? 'operator-choice-reason-not-provided' : choice ? 'operator-choice-partial' : 'no-recommendation',
      ranked: rankedPool.allowed.slice(0, 3).map((r, i) => ({ rank: i + 1,
        client: r.client, model: r.model, effort: r.effort || null,
        costClass: code(r.billing || r.routeKind), estimatedCost: r.estimatedCost ?? null, priceBasis: r.priceBasis ?? null,
        reasons: [...new Set([...(r.reasons || []), ...(r.class ? [`class-${code(r.class)}`] : []),
          r.routeOrderReason || 'selection-ranked'])].map(code),
        unknown: (r.reasons || []).filter(s => /unknown|unproven|unverified/.test(s)).map(code) })),
      excluded: [...(layerDecision?.excluded || []), ...selectedPool.excluded.map(e => ({ ...e.route, reasons: e.reasons })),
        ...rankedPool.excluded.map(e => ({ ...e.route, reasons: e.reasons }))].map(r => ({
          client: r.client, model: r.model, effort: r.effort || null, reasons: (r.reasons || []).map(code) })),
      unknown: [...new Set([...taskFrame.unknown, ...(result.unknown || [])])].map(code).sort(),
      status: eligibility.status, reason: eligibility.reason };
    if (ownerExplicit && !(actual.client && actual.model)) advice.unknown.push('operator-choice-partial');
    if (!choice && mode.mode === 'advise') advice.reason = code((selectedPool.excluded.length && selectedPool.reason) || result.reason || decision?.reason || 'no-eligible-route');
    if (mode.reason === 'mode-expiring') advice.unknown.push('mode-expiring');
    if (advice.status === 'requires-route-recheck' && advice.unknown.length) {
      advice.status = 'needs-operator-choice'; advice.reason = 'selection-facts-unknown';
    }
    // Only the fenced execution path supplies an execution policy. Advice
    // alone never authorizes a spawn or represents old argv as an assignment.
    if (advice.status === 'requires-route-recheck' && !(input.execution === true && deps.executionPolicy?.ok === true)) { advice.status = 'needs-operator-choice'; advice.reason = 'assign-execution-not-enabled'; }
    const selectionShadow = { schema: 'launch-selection-shadow/1', mode: 'shadow', launchAuthority: false,
      choice, source: 'assign-bridge', reason: code(!choice ? (selectedPool.excluded.length && selectedPool.reason) || advice.reason : result.reason || decision?.reason),
      status: choice ? 'recommended' : 'no-recommendation', advice };
    const shadow = { resolver: { choice, source: 'assign-bridge', reason: selectionShadow.reason,
      catalogVersion: decision?.catalogVersion || null, hashes: decision?.catalogHashes || {}, exclusionSummary: decision?.exclusionSummary || {} },
      taskClass: taskFrame.tier, role: taskFrame.role, operator };
    const lines = [`SELECTION ${mode.mode} class=${advice.taskClass} status=${advice.status} reason=${advice.reason}${result.routeStateCounts ? ` route-state-stale=${result.routeStateCounts.stale} route-state-unknown=${result.routeStateCounts.unknown}` : ''} unknown=${advice.unknown.join(',') || 'none'}`,
      ...advice.ranked.map(r => `SELECTION rank=${r.rank} route=${r.client}:${r.model}:${r.effort || 'unknown'} cost=${r.costClass} estimatedCost=${r.estimatedCost ?? 'unknown'} priceBasis=${r.priceBasis ? JSON.stringify(r.priceBasis) : 'unknown'} reasons=${r.reasons.join(',')} unknown=${r.unknown.join(',') || 'none'}`),
      ...(advice.ranked.length < 3 ? [`SELECTION eligible=${advice.ranked.length} wanted=3 reason=${choice ? 'fewer-eligible-routes' : advice.reason}`,
        ...advice.excluded.map(r => `SELECTION excluded=${r.client}:${r.model} reasons=${r.reasons.join(',') || 'route-ineligible'}`)] : []),
      `SELECTION recommended=${choice ? `${choice.client}:${choice.model}` : 'none'} actual=${actual.client || 'unknown'}:${actual.model || 'unknown'} handOverride=${ownerExplicit} deviation=${advice.deviationReason}`];
    for (const line of lines) say(line);
    return { taskFrame, selectionShadow, shadow, ...(input.execution === true ? { execution: { request: result.request, decision: layerDecision } } : {}) };
  }
  let shadow;
  try {
    // Fields introduced for advice must not leak into the legacy shadow seam.
    const { advisoryOperator, ownerExplicit, say, ...shadowInput } = input;
    const descriptorIndependence = lineageIndependence(context.descriptor);
    const independence = descriptorIndependence !== undefined ? descriptorIndependence : input.independence;
    shadow = (deps.resolverShadow || require('../../docs/ops/resolver-shadow.cjs')).record({
      ...shadowInput, role: taskFrame.role, tier: taskFrame.tier, dimension: taskFrame.domain, taskFrame,
      ...(independence !== undefined ? { independence } : {}),
      stageKind: taskFrame.role === 'certifier' ? 'certification' : input.stageKind || 'other',
    }, { runtimeDir: deps.runtimeDir, ...(deps.shadowDeps || {}) });
  } catch { shadow = { resolver: { error: 'resolver-error' } }; }
  const descriptorIndependence = lineageIndependence(context.descriptor);
  return { taskFrame, selectionShadow: recommendation(shadow, { repoRoot: deps.shadowDeps?.resolverOpts?.repoRoot,
    tier: taskFrame.tier, ownerContext: deps.shadowDeps?.resolverOpts?.ownerContext,
    role: taskFrame.role, independence: descriptorIndependence !== undefined ? descriptorIndependence : input.independence }), shadow };
}

// The role the repository of the task worktree declares (source or installed); unreadable is unknown, never installed.
function repositoryRole(worktree) {
  try {
    const role = require('../../.ai/bin/lib/text-safe.cjs').parseJsonUnique(fs.readFileSync(path.join(path.resolve(worktree), 'protocol-manifest.json'), 'utf8')).role;
    return ['source', 'installed'].includes(role) ? role : null;
  } catch { return null; }
}

function lineageIndependence(descriptor) {
  if (descriptor?.independence !== undefined) return descriptor.independence;
  const lineage = descriptor?.lineage;
  if (lineage === undefined) return undefined;
  if (!plain(lineage) || !['author', 'fixer', 'preReviewer', 'operator', 'certifiers'].every(k => Array.isArray(lineage[k]))) return null;
  return { lineage: ['author', 'fixer', 'preReviewer', 'operator', 'certifiers'].flatMap(k => lineage[k]) };
}
module.exports = { frame, capture, repository, descriptor, recommendation, DOMAINS };

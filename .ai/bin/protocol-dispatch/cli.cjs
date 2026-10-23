'use strict';

const fs = require('node:fs');
const path = require('node:path');

let runrecordLib = null;
try {
  runrecordLib = require('../protocol-runrecord.cjs');
} catch {}

const { makePointer, getRepoRoot } = require('./procfs.cjs');
const { dropWorkdir, importResults } = require('./workdir.cjs');
const { loadRegistry, loadDispatch, loadLadder, verifyLadderSectionSha256 } = require('./registry.cjs');
const { computePins, verifyPins, resolveSlot } = require('./resolver.cjs');
const packetWiring = require('./packet.cjs');
const { parseUsageFromLog } = require('./clients.cjs');
const { fallenOf, createWakeBudget } = require('./liveness.cjs');
const { refusalReport } = require('./lease.cjs');
const {
  takeStartLock,
  startRefusalDetail,
  releaseStartLock,
  forceSettle,
  attemptsNeedingAck,
  executeAttempt,
  checkCompletion,
  writeRepairFile,
  mapClassForRunRecord,
  updateUsageFile,
  emitFallSignal
} = require('./executor.cjs');

const sleepAsync = ms => new Promise(resolve => setTimeout(resolve, ms));

const { appendEvent: appendFailoverEventLib } = require('../protocol-failover.cjs');

function appendFailoverEvent(repoRoot, event, opts) {
  try {
    appendFailoverEventLib(repoRoot, event, opts || {});
  } catch (err) {
    console.log(`ERROR reason=failover-journal-append-failed error="${err.message}"`);
  }
}

async function runDispatch(dispatchFile, slotsToRun = [], opts = {}) {
  const repoRoot = getRepoRoot(opts);
  const dispatch = loadDispatch(dispatchFile);
  const registry = loadRegistry(opts.registry);
  const ladderPath = opts.ladder || path.resolve(repoRoot, 'docs/ops/model-ladder.json');
  let ladder = null;
  try {
    if (fs.existsSync(ladderPath)) {
      ladder = loadLadder(ladderPath, repoRoot);
    }
  } catch {}

  const stateDir = path.resolve(repoRoot, dispatch.stateDir || '.ai/runtime/dispatch');
  fs.mkdirSync(stateDir, { recursive: true });
  const stateFile = path.join(stateDir, 'state.json');

  let state = { slots: {} };
  try {
    if (fs.existsSync(stateFile)) state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {}
  if (!state || typeof state !== 'object' || !state.slots) state = { slots: {} };
  if (!state.slots) state.slots = {};

  const runsFile = opts.runsFile
    ? path.resolve(repoRoot, opts.runsFile)
    : (process.env.PROTOCOL_RUNS_FILE
        ? path.resolve(repoRoot, process.env.PROTOCOL_RUNS_FILE)
        : (dispatch.runsFile
            ? path.resolve(repoRoot, dispatch.runsFile)
            : path.resolve(repoRoot, 'docs/ops/RUNS.jsonl')));

  const signalsFile = opts.signalsFile
    ? path.resolve(repoRoot, opts.signalsFile)
    : (process.env.PROTOCOL_SIGNALS_FILE
        ? path.resolve(repoRoot, process.env.PROTOCOL_SIGNALS_FILE)
        : path.resolve(repoRoot, '.ai/SIGNALS.md'));

  const slotsList = dispatch.slots || dispatch.jobs;
  const targetSlots = slotsToRun.length
    ? slotsList.filter(s => slotsToRun.includes(s.id))
    : slotsList;

  let anyFailed = false;

  let dispatchRunningSum = 0;
  let dispatchRunningUnit = null;
  let dispatchMixedUnits = false;
  let dispatchHasAnyCost = false;

  for (const slot of targetSlots) {
    if (slot.when) {
      const whenFile = path.resolve(repoRoot, slot.when.file);
      if (fs.existsSync(whenFile)) {
        const content = fs.readFileSync(whenFile, 'utf8');
        if (slot.when.notMatch && new RegExp(slot.when.notMatch).test(content)) {
          console.log(`SKIP slot=${slot.id} reason=when-matched`);
          state.slots[slot.id] = { status: 'SKIPPED', route: slot.route };
          fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
          continue;
        }
      }
    }

    if (slot.needs && slot.needs.length) {
      const unmet = slot.needs.filter(reqId => {
        const cur = state.slots[reqId];
        return !cur || cur.status !== 'DONE';
      });
      if (unmet.length) {
        console.log(`WAIT slot=${slot.id} reason=needs waiting="${unmet.join(',')}"`);
        anyFailed = true;
        continue;
      }
    }

    const locked = takeStartLock(slot.id, stateDir, { snapshotProcesses: opts.snapshotProcesses });
    if (!locked) {
      console.log(`ERROR reason=start-lock-held slot=${slot.id}`);
      const refusal = startRefusalDetail();
      if (refusal && refusal.reason !== 'start-lock-held') {
        const { lines, record } = refusalReport({ dispatchFile, slotId: slot.id, decision: refusal });
        for (const line of lines) console.log(line);
        // the launch record of a refused start: the reason, every orphan and the command that releases them
        const refused = state.slots[slot.id] || {};
        refused.lastRefusedStart = { at: new Date().toISOString(), ...record };
        state.slots[slot.id] = refused;
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
      }
      anyFailed = true;
      continue;
    }

    if (state.slots[slot.id] && state.slots[slot.id].lastRefusedStart) delete state.slots[slot.id].lastRefusedStart;

    let resolution;
    if (slot.route) {
      resolution = resolveSlot(slot, ladder, registry, opts);
    } else {
      if (!ladder) {
        console.log(`ERROR reason=ladder-missing slot=${slot.id}`);
        releaseStartLock(slot.id, stateDir);
        anyFailed = true;
        continue;
      }
      const checkLadder = verifyLadderSectionSha256(ladder, repoRoot);
      if (!checkLadder.ok) {
        console.log('ERROR reason=ladder-stale');
        releaseStartLock(slot.id, stateDir);
        return 1;
      }
      resolution = resolveSlot(slot, ladder, registry, opts);
      if (resolution.terminal === 'no-admissible-rung') {
        const ruled = resolution.roleRule ? ` role-rule=${resolution.roleRule.excludeProviders.join(',')}` : '';
        console.log(`ERROR reason=no-admissible-rung slot=${slot.id}${ruled}`);
        state.slots[slot.id] = { status: 'BLOCKED', reason: 'no-admissible-rung' };
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
        releaseStartLock(slot.id, stateDir);
        anyFailed = true;
        continue;
      }
      if (resolution.terminal === 'cross-maker-order-missing') {
        // Tiers are provider-relative; with no explicit maker order for the task class the resolver chose nothing
        console.log(`ASK_OWNER reason=cross-maker-order-missing slot=${slot.id}`);
        state.slots[slot.id] = { status: 'BLOCKED', reason: 'cross-maker-order-missing' };
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
        releaseStartLock(slot.id, stateDir);
        anyFailed = true;
        continue;
      }
      if (!(resolution.reason === 'single-maker' && resolution.terminal === 'shortfall')) {
        const p = resolution.primary;
        const mo = resolution.makerOrder;
        const clean = v => String(v === null || v === undefined ? '-' : v).replace(/["\r\n]+/g, "'");
        const recommendation = {
          choice: p ? { maker: p.maker || null, client: p.client, model: p.model || null, effort: p.effort || null } : null,
          substitutes: (resolution.substitutes || []).map(s => ({ maker: s.maker || null, client: s.client, model: s.model || null, effort: s.effort || null })),
          reason: resolution.reason || null,
          makerOrder: mo ? { key: mo.key, source: mo.source, date: mo.date, by: mo.by || null } : null
        };
        // a model whose registry name is not its launch value (vibe: zai-glm-5-3 is launched as glm-5-3, any other value silently serves Mistral)
        const aliasOf = r => { const cfg = registry && registry.clients ? registry.clients[r.client] : null; const a = cfg && cfg.launchAliases && typeof cfg.launchAliases === 'object' ? cfg.launchAliases[r.model] : null; return typeof a === 'string' && a ? `${r.client}:${r.model}->${clean(a)}` : null; };
        const aliases = [...new Set([p, ...(resolution.substitutes || [])].filter(Boolean).map(aliasOf).filter(Boolean))];
        if (aliases.length) recommendation.launchAliases = aliases;
        const choice = p ? `${p.client}:${p.model || ''} effort=${p.effort || 'unknown'} maker=${p.maker || '-'}` : 'none';
        const subs = recommendation.substitutes.map(s => `${s.client}:${s.model || ''}`).join(',') || '-';
        const orderPart = mo ? `order-key=${mo.key} order-date=${clean(mo.date)} order-by=${clean(mo.by)} order-source="${clean(mo.source)}"` : 'order=none';
        console.log(`RECOMMEND slot=${slot.id} choice=${choice} substitutes=${subs} reason=${resolution.reason || '-'} ${orderPart}${aliases.length ? ` launch-alias=${aliases.join(',')}` : ''} advisory=true`);
        const askReason = resolution.reason === 'maker-order' ? 'maker-order-advisory' : 'resolver-choice-advisory';
        console.log(`ASK_OWNER reason=${askReason} slot=${slot.id}`);
        state.slots[slot.id] = { status: 'BLOCKED', reason: askReason, recommendation };
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
        releaseStartLock(slot.id, stateDir);
        anyFailed = true;
        continue;
      }
      if (resolution.terminal === 'shortfall') {
        console.log(`ASK_OWNER reason=shortfall slot=${slot.id}`);
        state.slots[slot.id] = { status: 'BLOCKED', reason: 'shortfall' };
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
        releaseStartLock(slot.id, stateDir);
        anyFailed = true;
        continue;
      }
    }

    const slotState = state.slots[slot.id] || { attempts: [] };

    // Launch pinning
    if (opts.revise || !slotState.pins) {
      const nowIso = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
      slotState.runId = `R-${nowIso}-${slot.id}`;
      slotState.pins = computePins(slot, dispatchFile, repoRoot);
    } else {
      const pCheck = verifyPins(slotState.pins, slot, dispatchFile, repoRoot);
      if (!pCheck.ok) {
        console.log(`BLOCKED slot=${slot.id} class=POLICY_FAILURE reason="${pCheck.reason}"`);
        slotState.status = 'BLOCKED';
        slotState.class = 'POLICY_FAILURE';
        slotState.reason = pCheck.reason;
        state.slots[slot.id] = slotState;
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
        releaseStartLock(slot.id, stateDir);
        anyFailed = true;
        continue;
      }
    }

    const routes = [];
    if (resolution.primary) routes.push({ role: 'primary', route: resolution.primary });
    if (resolution.substitutes && resolution.substitutes[0]) {
      routes.push({ role: 'substitute-1', route: resolution.substitutes[0] });
    }
    if (resolution.substitutes && resolution.substitutes[1]) {
      routes.push({ role: 'substitute-2', route: resolution.substitutes[1] });
    }

    // Default ON through the shared decision; explicit rollback preserves the old launch.
    let packetInfo = null;
    const packetGate = packetWiring.slotDecision(process.env, slot);
    if (packetGate.skipped) {
      console.log(`PACKET_SKIPPED slot=${slot.id} reason=${packetGate.skipped}`);
      slotState.packetSkipped = packetGate.skipped;
    }
    if (packetGate.active || packetGate.refused) {
      // prepare() is total by contract; this guard converts any leftover throw into the same visible refusal, never an escape under the start lock.
      let prep;
      try {
        prep = packetGate.refused ? { ok: false, reason: packetGate.refused }
          : packetWiring.prepare(slot, repoRoot, routes.map(r => r.route && r.route.client));
      } catch (e) {
        prep = { ok: false, reason: 'packet-compile-failed: preparation threw' };
      }
      if (!prep || typeof prep !== 'object') prep = { ok: false, reason: 'packet-compile-failed: prepare returned no result' };
      if (!prep.ok) {
        console.log(`BLOCKED slot=${slot.id} class=POLICY_FAILURE reason="${prep.reason}"`);
        slotState.status = 'BLOCKED';
        slotState.class = 'POLICY_FAILURE';
        slotState.reason = prep.reason;
        state.slots[slot.id] = slotState;
        fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
        releaseStartLock(slot.id, stateDir);
        anyFailed = true;
        continue;
      }
      packetInfo = prep;
      const auditCopy = packetWiring.persist(prep, slot, repoRoot);
      if (!auditCopy.ok) console.log(`PACKET_AUDIT_REFUSED slot=${slot.id} reason=${auditCopy.reason}`);
      slotState.pins.packetHash = prep.packetHash;
      slotState.pins.corpusHash = prep.treeSha;
      console.log(`PACKET slot=${slot.id} shape=${prep.shape} hash=${prep.packetHash.slice(0, 12)} bytes=${prep.bytes}`);
    }
    if (!packetInfo) {
      // A state file from an earlier run with the wiring on must not leak a stale packet hash into a run without one.
      delete slotState.pins.packetHash;
      slotState.pins.corpusHash = null;
    }
    const launchPointer = () => makePointer(packetInfo ? packetInfo.derivedRel : slot.launch);

    let routeIdx = 0;
    let freshPrimary = 0;
    const freshSubs = { 'substitute-1': 0, 'substitute-2': 0 };
    let freshTotal = 0;
    let wakeBudget = createWakeBudget();
    let crashResumeDone = false;
    let repairResumeDone = false;

    let currentWorkdir = null;
    let lastSessionId = null;
    let lastAttemptResult = null;
    let lastCompletion = null;

    const recordAttempts = [];
    const transitions = [];
    let curState11 = 'DISPATCHED';

    const addTransition = (to, reason) => {
      const at = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
      transitions.push({ from: curState11, to, at, reason });
      curState11 = to;
    };

    addTransition('LAUNCHED', packetInfo ? `initial-launch ${JSON.stringify(packetWiring.measurementFields(packetInfo))}` : 'initial-launch');

    let finalState = null;
    let fallen = false;
    const hardSeconds = opts.hardSeconds || (dispatch.hardMin ? dispatch.hardMin * 60 : 7200);
    const slotStartTime = Date.now();

    while (!finalState) {
      if ((Date.now() - slotStartTime) >= hardSeconds * 1000) {
        addTransition('BLOCKED', 'hard-ceiling-reached');
        finalState = 'BLOCKED';
        break;
      }
      if (freshTotal >= 6) {
        addTransition('FAILED', 'budget-exhausted-fresh');
        finalState = 'FAILED';
        break;
      }

      let attemptKind = 'fresh';
      let isWake = false;
      let attemptReason = 'first';
      let messageToUse = null;

      const curRouteEntry = routes[routeIdx];
      const curClientName = curRouteEntry?.route?.client;
      const curClientCfg = curClientName ? registry.clients[curClientName] : null;
      const clientCanResume = Boolean(curClientCfg && curClientCfg.resume && curClientCfg.resume.command);

      if (lastAttemptResult && lastAttemptResult.class === 'STALL' && clientCanResume && !wakeBudget.exhausted() && lastSessionId && currentWorkdir) {
        attemptKind = 'resume';
        attemptReason = 'resume';
        messageToUse = makePointer('.ai/docs/dispatch/wake.md');
        isWake = true;
        addTransition('RESUMING', `wake-resume-${wakeBudget.used() + 1}`);
      } else if (lastAttemptResult && lastAttemptResult.class === 'PROCESS_CRASH' && clientCanResume && !crashResumeDone && lastSessionId && currentWorkdir) {
        attemptKind = 'resume';
        attemptReason = 'resume';
        messageToUse = launchPointer();
        crashResumeDone = true;
        addTransition('RESUMING', 'crash-resume');
      } else if (
        lastAttemptResult &&
        (lastAttemptResult.class === 'INVALID_OUTPUT' || lastAttemptResult.class === 'VALIDATION_FAILURE') &&
        clientCanResume &&
        !repairResumeDone &&
        lastSessionId &&
        currentWorkdir
      ) {
        attemptKind = 'resume';
        attemptReason = 'repair';
        const failingRows = (lastCompletion && lastCompletion.failingRows) || [lastAttemptResult.reason || 'invalid-output'];
        const repairRel = writeRepairFile(currentWorkdir, recordAttempts.length + 1, failingRows, repoRoot);
        messageToUse = makePointer(repairRel);
        repairResumeDone = true;
        addTransition('RECOVERING', 'repair-start');
        addTransition('RESUMING', 'repair-resume');
      } else {
        // Fresh attempt
        if (lastAttemptResult && lastAttemptResult.class === 'STALL' && wakeBudget.exhausted()) {
          fallen = true;
        }

        const curRouteEntry = routes[routeIdx];
        if (!curRouteEntry) {
          finalState = fallen ? 'FAILED' : 'FAILED';
          addTransition('FAILED', 'no-routes-remaining');
          break;
        }

        const role = curRouteEntry.role;
        if (role === 'primary') {
          if (freshPrimary < 2) {
            freshPrimary++;
            attemptReason = recordAttempts.length === 0 ? 'first' : 'transient-retry';
          } else {
            routeIdx++;
            continue;
          }
        } else {
          if (freshSubs[role] < 2) {
            freshSubs[role]++;
            attemptReason = (routes[routeIdx - 1] && routes[routeIdx - 1].role !== role) ? 'route-change' : 'transient-retry';
          } else {
            routeIdx++;
            continue;
          }
        }

        freshTotal++;
        attemptKind = 'fresh';
        wakeBudget = createWakeBudget();
        crashResumeDone = false;
        repairResumeDone = false;

        if (currentWorkdir) {
          dropWorkdir(currentWorkdir);
          currentWorkdir = null;
        }
        addTransition('RUNNING', `fresh-attempt-${role}`);
      }

      const activeRouteEntry = routes[routeIdx];
      const attemptNum = recordAttempts.length + 1;
      const attemptStartIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

      console.log(`RUN slot=${slot.id} attempt=${attemptNum} route=${activeRouteEntry.route.client}:${activeRouteEntry.route.model || ''}`);

      const res = await executeAttempt(slot, attemptNum, dispatch, registry, {
        repoRoot,
        route: activeRouteEntry.route,
        attemptKind,
        wake: isWake,
        wakeBudget,
        sessionId: lastSessionId,
        workdir: currentWorkdir,
        message: messageToUse,
        derivedFiles: packetInfo ? packetInfo.files : null,
        derivedLaunchRel: packetInfo ? packetInfo.derivedRel : null,
        stallSeconds: opts.stallSeconds,
        hardSeconds: opts.hardSeconds,
        firstLaunchAt: slotStartTime,
        tmpDir: opts.tmpDir,
        keepWorkdirOnExit: true
      });

      lastAttemptResult = res;
      lastSessionId = res.sessionId;
      currentWorkdir = res.workdir;

      const attemptEndIso = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

      const activeClientName = activeRouteEntry.route.client;
      const activeClientCfg = (registry && registry.clients && activeClientName) ? registry.clients[activeClientName] : null;
      const attemptUsageParser = activeClientCfg ? (activeClientCfg.usage || 'none') : 'none';
      const attemptLogPath = res.logPath || path.join(stateDir, 'logs', `${slot.id}-${attemptNum}.log`);
      const attemptUsage = parseUsageFromLog(attemptLogPath, attemptUsageParser);

      const declaredOutputs = [];
      if (slot.out) declaredOutputs.push(slot.out.replace(/\\/g, '/'));
      if (slot.outputs) for (const p of slot.outputs) declaredOutputs.push(p.replace(/\\/g, '/'));

      let completionObj = null;
      let mappedClass = 'NONE';

      if (res.status === 'DONE') {
        completionObj = checkCompletion(slot, currentWorkdir, declaredOutputs, res, repoRoot);
        lastCompletion = completionObj;
        if (completionObj.supervisorDone) {
          mappedClass = 'NONE';
          finalState = 'DONE';
          addTransition('DONE', 'completion-contract-passed');
        } else {
          res.status = 'FAILED';
          res.class = completionObj.validator === 'fail' ? 'VALIDATION_FAILURE' : 'INVALID_OUTPUT';
          res.reason = completionObj.failingRows.join('; ') || 'completion-contract-failed';
          mappedClass = mapClassForRunRecord(res.class, 'FAILED');
        }
      } else if (res.status === 'BLOCKED') {
        mappedClass = mapClassForRunRecord(res.class, 'BLOCKED');
        finalState = 'BLOCKED';
        addTransition('BLOCKED', res.class === 'TIMEOUT' ? 'timeout-ceiling-reached' : (res.reason || 'policy-failure'));
      } else {
        mappedClass = mapClassForRunRecord(res.class, 'FAILED');
      }

      recordAttempts.push({
        n: attemptNum,
        kind: attemptKind,
        reason: attemptReason,
        routeRole: activeRouteEntry.role,
        route: {
          client: activeRouteEntry.route.client,
          model: activeRouteEntry.route.model,
          effort: activeRouteEntry.route.effort || null
        },
        effortUsed: activeRouteEntry.route.effort || null,
        modelRan: {
          id: activeRouteEntry.route.model || null,
          source: 'requested'
        },
        sessionId: lastSessionId || null,
        start: attemptStartIso,
        end: attemptEndIso,
        exitCode: (res.exitCode !== undefined && res.exitCode !== null) ? res.exitCode : null,
        class: mappedClass,
        tokens: attemptUsage.tokens,
        usage: attemptUsage.usage,
        rawUsage: attemptUsage.rawUsage || null
      });

      if (res.class === 'STALL') {
        const isNoResume = !clientCanResume;
        if (isNoResume || wakeBudget.exhausted()) {
          fallen = true;
          emitFallSignal(
            signalsFile,
            slotState.runId,
            activeRouteEntry.route.client,
            activeRouteEntry.route.model,
            attemptStartIso,
            attemptEndIso,
            isNoResume,
            repoRoot
          );
          // P-L3-004 R-L3-004.11: one failover journal event per fall. The next route is the
          // resolver's recommendation - the next entry of the resolver-ordered routes list -
          // never a hand choice; the writer records and never runs a model. Disable with
          // --failover-file off / opts.failoverFile === false / PROTOCOL_FAILOVER_FILE=off.
          const nextEntry = routes[routeIdx + 1];
          appendFailoverEvent(repoRoot, {
            runId: (typeof slotState.runId === 'string' && slotState.runId.startsWith('R-')) ? slotState.runId : null,
            slot: slot.id,
            attempt: attemptNum,
            route: {
              client: activeRouteEntry.route.client,
              model: activeRouteEntry.route.model || null,
              effort: activeRouteEntry.route.effort || null,
              role: activeRouteEntry.role
            },
            reasonClass: 'STALL',
            fallKind: isNoResume ? 'no-resume' : 'wake-budget-exhausted',
            nextRoute: nextEntry ? {
              client: nextEntry.route.client,
              model: nextEntry.route.model || null,
              effort: nextEntry.route.effort || null
            } : null,
            nextRouteSource: nextEntry ? 'resolver-recommendation' : 'none-remaining',
            resolverVersion: resolution.ladderVersion || null
          }, { failoverFile: opts.failoverFile });
        }
      }

      if (finalState === 'DONE') {
        importResults(currentWorkdir, declaredOutputs, repoRoot);
        dropWorkdir(currentWorkdir);
        currentWorkdir = null;
        console.log(`DONE slot=${slot.id}`);
        break;
      } else if (finalState === 'BLOCKED') {
        if (!res.workdirKept) {
          dropWorkdir(currentWorkdir);
          currentWorkdir = null;
        }
        console.log(`BLOCKED slot=${slot.id} class=${res.class || 'POLICY_FAILURE'} reason="${res.reason}"`);
        anyFailed = true;
        break;
      } else {
        // Failed attempt: the action follows the failure class
        if (res.class === 'AUTH_ERROR' || res.class === 'CONFIG_ERROR') {
          routeIdx++;
        } else if (res.class === 'MODEL_UNAVAILABLE') {
          routeIdx++;
        } else if (res.class === 'QUOTA_EXHAUSTED') {
          routeIdx++;
          if (routeIdx >= routes.length) {
            console.log(`ASK_OWNER reason=quota-exhausted slot=${slot.id}`);
            finalState = 'BLOCKED';
            addTransition('BLOCKED', 'quota-exhausted-all-routes');
            anyFailed = true;
            break;
          }
        } else if (res.class === 'RATE_LIMIT') {
          if (!opts.fastRetry) await sleepAsync(60000);
        } else if (res.class === 'NETWORK_ERROR' || res.class === 'PROVIDER_ERROR') {
          if (!opts.fastRetry) await sleepAsync(30000);
        } else if (res.class === 'INVALID_OUTPUT' || res.class === 'VALIDATION_FAILURE') {
          if (repairResumeDone) {
            routeIdx++;
          }
        }
      }
    }

    if (!finalState) {
      finalState = 'FAILED';
      addTransition('FAILED', 'terminated-without-resolution');
      anyFailed = true;
    }

    if (currentWorkdir && !lastAttemptResult?.workdirKept) {
      dropWorkdir(currentWorkdir);
    }

    slotState.status = finalState;
    slotState.class = lastAttemptResult ? lastAttemptResult.class : null;
    slotState.reason = lastAttemptResult ? lastAttemptResult.reason : null;
    slotState.attempts = recordAttempts;
    state.slots[slot.id] = slotState;
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');

    releaseStartLock(slot.id, stateDir);

    if (finalState === 'FAILED') {
      console.log(`FAILED slot=${slot.id} class=${slotState.class || 'UNKNOWN'} reason="${slotState.reason || ''}"`);
      anyFailed = true;
    }

    // Build run record for RUNS.jsonl
    const declaredOutputs = [];
    if (slot.out) declaredOutputs.push(slot.out.replace(/\\/g, '/'));
    if (slot.outputs) for (const p of slot.outputs) declaredOutputs.push(p.replace(/\\/g, '/'));

    // Cost computation (PROTO-DEC-0075 item 9)
    const attemptsWithAmount = recordAttempts.filter(
      a => a.usage && typeof a.usage.amount === 'number' && !isNaN(a.usage.amount)
    );

    let actualCost = null;
    let slotUnit = null;

    if (attemptsWithAmount.length > 0) {
      const units = new Set(attemptsWithAmount.map(a => a.usage.unit).filter(Boolean));
      if (units.size === 1) {
        slotUnit = Array.from(units)[0];
        const sum = attemptsWithAmount.reduce((acc, a) => acc + a.usage.amount, 0);
        actualCost = Number(sum.toFixed(6));
      }
    }

    if (actualCost !== null && slotUnit !== null) {
      if (!dispatchHasAnyCost) {
        dispatchHasAnyCost = true;
        dispatchRunningUnit = slotUnit;
        dispatchRunningSum = actualCost;
      } else if (!dispatchMixedUnits) {
        if (dispatchRunningUnit === slotUnit) {
          dispatchRunningSum = Number((dispatchRunningSum + actualCost).toFixed(6));
        } else {
          dispatchMixedUnits = true;
        }
      }
    } else if (attemptsWithAmount.length > 0) {
      dispatchMixedUnits = true;
    }

    let cumulativeCost = null;
    let costUnit = null;

    if (dispatchHasAnyCost && !dispatchMixedUnits) {
      cumulativeCost = dispatchRunningSum;
    }

    if (actualCost !== null) {
      costUnit = slotUnit;
    } else if (cumulativeCost !== null) {
      costUnit = dispatchRunningUnit;
    }

    const runRecordObj = {
      schema: 'run-record/1',
      runId: slotState.runId || `R-${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}-${slot.id}`,
      slot: slot.id,
      frame: slot.frame || 'task:default',
      role: slot.role || null,
      selection: resolution.selection,
      resolution: {
        ladderSnapshot: resolution.ladderSnapshot || null,
        primary: resolution.primary ? {
          client: resolution.primary.client,
          model: resolution.primary.model,
          effort: resolution.primary.effort || null
        } : null,
        substitutes: (resolution.substitutes || []).map(s => ({
          client: s.client,
          model: s.model,
          effort: s.effort || null
        })),
        excluded: (resolution.excluded || []).map(e => ({ rung: String(e.rung), reason: String(e.reason) })),
        skipped: (resolution.skipped || []).map(s => ({ rung: String(s.rung), reason: String(s.reason) })),
        unverified: (resolution.unverified || []).map(u => ({ rung: String(u.rung), constraint: String(u.constraint) })),
        approval: resolution.approval || null,
        shortfall: resolution.shortfall || null
      },
      pins: {
        head: slotState.pins.head,
        launchFile: slotState.pins.launchFile,
        launchSha256: slotState.pins.launchSha256,
        roleSha256: null,
        corpusHash: slotState.pins.corpusHash || null,
        ...(slotState.pins.packetHash ? { packetHash: slotState.pins.packetHash } : {}),
        dispatchVersion: slotState.pins.dispatchVersion
      },
      attempts: recordAttempts,
      budget: {
        freshUsed: recordAttempts.filter(a => a.kind === 'fresh').length,
        resumes: recordAttempts.filter(a => a.kind === 'resume').length,
        stallMin: dispatch.stallMin || 10,
        hardMin: dispatch.hardMin || 120
      },
      cost: { estimated: null, actual: actualCost, cumulative: cumulativeCost, unit: costUnit },
      completion: lastCompletion ? {
        processEnded: lastCompletion.processEnded,
        exitCode: (lastCompletion.exitCode !== undefined && lastCompletion.exitCode !== null) ? lastCompletion.exitCode : null,
        outputsPresent: lastCompletion.outputsPresent,
        outputsNonEmpty: lastCompletion.outputsNonEmpty,
        structuralCheck: lastCompletion.structuralCheck,
        validator: lastCompletion.validator,
        evidence: lastCompletion.evidence,
        supervisorDone: lastCompletion.supervisorDone
      } : {
        processEnded: true,
        exitCode: (lastAttemptResult && lastAttemptResult.exitCode !== undefined && lastAttemptResult.exitCode !== null) ? lastAttemptResult.exitCode : null,
        outputsPresent: false,
        outputsNonEmpty: false,
        structuralCheck: 'none',
        validator: 'n/a',
        evidence: null,
        supervisorDone: false
      },
      state: finalState,
      fallen: recordAttempts.length > 0 && fallenOf({ state: finalState, class: recordAttempts[recordAttempts.length - 1].class }),
      transitions,
      outputs: declaredOutputs
    };

    if (runrecordLib) {
      try {
        runrecordLib.appendRecord(runsFile, runRecordObj);
      } catch (err) {
        console.error(`RUNRECORD_ERROR: ${err.message}`);
      }
    }

    if (dispatch.usageFile) {
      updateUsageFile(path.resolve(repoRoot, dispatch.usageFile), repoRoot, runsFile);
    }
  }

  return anyFailed ? 1 : 0;
}

function checkDispatch(dispatchFile, opts = {}) {
  const dispatch = loadDispatch(dispatchFile);
  const repoRoot = getRepoRoot(opts);
  const slots = dispatch.slots || dispatch.jobs;

  console.log(`CHECK dispatch=${dispatchFile} slots=${slots.length}`);

  let missing = 0;
  for (const s of slots) {
    const launchPath = path.resolve(repoRoot, s.launch);
    if (!fs.existsSync(launchPath)) {
      console.log(`ERROR reason=launch-missing slot=${s.id} path=${s.launch}`);
      missing++;
    }
  }

  let invalidRoute = 0;
  for (const s of slots) {
    if (!s.route) {
      if (!s.role || !s.floor) {
        console.log(`ERROR reason=missing-role-or-floor slot=${s.id}`);
        invalidRoute++;
      }
    }
  }

  if (missing > 0 || invalidRoute > 0) return 1;
  return 0;
}

function statusDispatch(dispatchFile, opts = {}) {
  const dispatch = loadDispatch(dispatchFile);
  const repoRoot = getRepoRoot(opts);
  const stateDir = path.resolve(repoRoot, dispatch.stateDir || '.ai/runtime/dispatch');
  const stateFile = path.join(stateDir, 'state.json');
  let state = { slots: {} };
  try {
    if (fs.existsSync(stateFile)) state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {}

  const slots = dispatch.slots || dispatch.jobs;
  for (const s of slots) {
    const cur = state.slots[s.id] || { status: 'NOT_STARTED', attempts: [] };
    const routeStr = s.route ? `${s.route.client}:${s.route.model || ''}` : 'none';
    console.log(`SLOT id=${s.id} status=${cur.status} route=${routeStr} attempts=${cur.attempts ? cur.attempts.length : 0}`);
  }
  return 0;
}

function reportDispatch(dispatchFile, opts = {}) {
  const dispatch = loadDispatch(dispatchFile);
  const repoRoot = getRepoRoot(opts);
  const runsFile = opts.runsFile
    ? path.resolve(repoRoot, opts.runsFile)
    : (process.env.PROTOCOL_RUNS_FILE
        ? path.resolve(repoRoot, process.env.PROTOCOL_RUNS_FILE)
        : (dispatch.runsFile
            ? path.resolve(repoRoot, dispatch.runsFile)
            : path.resolve(repoRoot, 'docs/ops/RUNS.jsonl')));

  let records = [];
  if (runrecordLib && fs.existsSync(runsFile)) {
    try {
      records = runrecordLib.readRecords(runsFile);
    } catch {}
  }

  let registry = null;
  try {
    registry = opts.registry
      ? (typeof opts.registry === 'object' ? opts.registry : loadRegistry(opts.registry))
      : loadRegistry();
  } catch {}

  const slots = dispatch.slots || dispatch.jobs;
  for (const s of slots) {
    const outputs = s.outputs || (s.out ? [s.out] : []);
    const matching = records.filter(r => r.slot === s.id);
    if (!matching.length) {
      const routeStr = s.route ? `${s.route.client}:${s.route.model || ''}` : 'none';
      console.log(`REPORT slot=${s.id} route=${routeStr} state=NOT_STARTED attempts=0 outputs="${outputs.join(',')}" usage=none (no-run-record)`);
    } else {
      const rec = matching[matching.length - 1];
      const lastAttempt = (rec.attempts && rec.attempts.length) ? rec.attempts[rec.attempts.length - 1] : null;
      const clientName = (lastAttempt && lastAttempt.route) ? lastAttempt.route.client : (s.route ? s.route.client : null);
      const clientCfg = (registry && registry.clients && clientName) ? registry.clients[clientName] : null;
      const usageKey = clientCfg ? (clientCfg.usage || 'none') : 'none';

      const routeStr = (lastAttempt && lastAttempt.route) ? `${lastAttempt.route.client}:${lastAttempt.route.model || ''}` : 'none';
      let usageStr;
      if (lastAttempt && lastAttempt.usage && lastAttempt.usage.amount !== null) {
        usageStr = `${lastAttempt.usage.amount} ${lastAttempt.usage.unit}`;
      } else {
        if (usageKey === 'none') {
          usageStr = 'none (client usage=none in clients.json)';
        } else {
          usageStr = `none (parser ${usageKey} found no usage in log)`;
        }
      }
      console.log(`REPORT slot=${s.id} route=${routeStr} state=${rec.state} attempts=${rec.attempts ? rec.attempts.length : 0} outputs="${outputs.join(',')}" usage=${usageStr}`);
    }
  }
  return 0;
}

function stopSlot(dispatchFile, slotId, opts = {}) {
  const dispatch = loadDispatch(dispatchFile);
  const repoRoot = getRepoRoot(opts);
  const stateDir = path.resolve(repoRoot, dispatch.stateDir || '.ai/runtime/dispatch');
  const stateFile = path.join(stateDir, 'state.json');
  let state = { slots: {} };
  try {
    if (fs.existsSync(stateFile)) state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {}

  // Only this owner-facing verb may force-settle an attempt the supervisor could not settle, and only with --ack <note>.
  const needAck = attemptsNeedingAck(slotId, stateDir);
  let ackedCount = 0;
  if (needAck.length && opts.ack) {
    try {
      ackedCount = forceSettle(slotId, stateDir, opts.ack);
    } catch (e) {
      console.log(`ERROR reason=lease-write-failed slot=${slotId} detail="${e.message}"`);
      return 1;
    }
  }
  releaseStartLock(slotId, stateDir);
  const cur = state.slots[slotId] || {};
  cur.status = 'STOPPED';
  state.slots[slotId] = cur;
  try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8'); } catch {}
  console.log(`STOP slot=${slotId} pids=none`);
  if (ackedCount) console.log(`ACK slot=${slotId} settled=${ackedCount}`);
  else if (needAck.length) console.log(`WARN reason=unsettled-attempt slot=${slotId} attempts=${needAck.length} ack=required`);
  return 0;
}

function acceptSlot(dispatchFile, slotId, reason = 'accepted', opts = {}) {
  const dispatch = loadDispatch(dispatchFile);
  const repoRoot = getRepoRoot(opts);
  const stateDir = path.resolve(repoRoot, dispatch.stateDir || '.ai/runtime/dispatch');
  const stateFile = path.join(stateDir, 'state.json');
  let state = { slots: {} };
  try {
    if (fs.existsSync(stateFile)) state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {}

  const cur = state.slots[slotId] || {};
  cur.status = 'ACCEPTED';
  cur.acceptedReason = reason;
  state.slots[slotId] = cur;
  try { fs.writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8'); } catch {}
  console.log(`ACCEPT slot=${slotId} reason="${reason}"`);
  return 0;
}

module.exports = { reportDispatch, runDispatch, checkDispatch, statusDispatch, stopSlot, acceptSlot };

'use strict';

const { spawn } = require('node:child_process');
const procfs = require('./protocol-dispatch/procfs.cjs');
const workdir = require('./protocol-dispatch/workdir.cjs');
const registry = require('./protocol-dispatch/registry.cjs');
const resolver = require('./protocol-dispatch/resolver.cjs');
const clients = require('./protocol-dispatch/clients.cjs');
const executor = require('./protocol-dispatch/executor.cjs');
const cli = require('./protocol-dispatch/cli.cjs');
const { loadRegistry } = registry;
const { probeAll } = clients;
const { resolveCommand } = resolver;
const { runDispatch, checkDispatch, statusDispatch, reportDispatch, stopSlot, acceptSlot } = cli;

async function main(argv) {
  if (!argv || !argv.length) {
    console.log('USAGE command=[probe|check|run|start|status|stop|accept|report|resolve]');
    return 2;
  }

  const cmd = argv[0];
  const rest = argv.slice(1);

  let registryPath = null;
  let modelArg = null;
  let smokeArg = null;
  let stallSec = null;
  let hardSec = null;
  let ladderArg = null;
  let runsFileArg = null;
  let signalsFileArg = null;
  let failoverFileArg = null;
  let ackArg = null;
  let reviseFlag = false;
  let fastRetryFlag = false;
  const positional = [];

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--registry') {
      registryPath = rest[++i];
      if (!registryPath || registryPath.startsWith('--')) {
        console.log('ERROR reason=missing-flag-value flag=--registry');
        return 2;
      }
    } else if (a === '--model') {
      modelArg = rest[++i];
      if (!modelArg || modelArg.startsWith('--')) {
        console.log('ERROR reason=missing-flag-value flag=--model');
        return 2;
      }
    } else if (a === '--smoke') {
      smokeArg = rest[++i];
      if (!smokeArg || smokeArg.startsWith('--')) {
        console.log('ERROR reason=missing-flag-value flag=--smoke');
        return 2;
      }
    } else if (a === '--ladder') {
      ladderArg = rest[++i];
      if (!ladderArg || ladderArg.startsWith('--')) {
        console.log('ERROR reason=missing-flag-value flag=--ladder');
        return 2;
      }
    } else if (a === '--runs-file') {
      runsFileArg = rest[++i];
      if (!runsFileArg || runsFileArg.startsWith('--')) {
        console.log('ERROR reason=missing-flag-value flag=--runs-file');
        return 2;
      }
    } else if (a === '--signals-file') {
      signalsFileArg = rest[++i];
      if (!signalsFileArg || signalsFileArg.startsWith('--')) {
        console.log('ERROR reason=missing-flag-value flag=--signals-file');
        return 2;
      }
    } else if (a === '--failover-file') {
      failoverFileArg = rest[++i];
      if (!failoverFileArg || failoverFileArg.startsWith('--')) {
        console.log('ERROR reason=missing-flag-value flag=--failover-file');
        return 2;
      }
    } else if (a === '--ack') {
      ackArg = rest[++i];
      if (!ackArg || ackArg.startsWith('--')) {
        console.log('ERROR reason=missing-flag-value flag=--ack');
        return 2;
      }
    } else if (a === '--revise') {
      reviseFlag = true;
    } else if (a === '--fast-retry') {
      fastRetryFlag = true;
    } else if (a === '--stall-seconds') {
      const v = rest[++i];
      const n = Number(v);
      if (!v || isNaN(n) || n <= 0) {
        console.log('ERROR reason=invalid-number flag=--stall-seconds');
        return 2;
      }
      stallSec = n;
    } else if (a === '--hard-seconds') {
      const v = rest[++i];
      const n = Number(v);
      if (!v || isNaN(n) || n <= 0) {
        console.log('ERROR reason=invalid-number flag=--hard-seconds');
        return 2;
      }
      hardSec = n;
    } else if (a.startsWith('--')) {
      console.log(`ERROR reason=unknown-flag flag=${a}`);
      return 2;
    } else {
      positional.push(a);
    }
  }

  try {
    switch (cmd) {
      case 'probe': {
        const reg = loadRegistry(registryPath);
        const res = probeAll(reg, { model: modelArg, smoke: smokeArg }, positional);
        for (const line of res.rows) console.log(line);
        return res.ok ? 0 : 1;
      }
      case 'check': {
        if (!positional.length) {
          console.log('ERROR reason=missing-dispatch-file');
          return 2;
        }
        return checkDispatch(positional[0], { registry: registryPath });
      }
      case 'resolve': {
        if (positional.length < 2) {
          console.log('ERROR reason=missing-resolve-arguments');
          return 2;
        }
        return resolveCommand(positional[0], positional[1], {
          ladder: ladderArg,
          registry: registryPath
        });
      }
      case 'run': {
        if (!positional.length) {
          console.log('ERROR reason=missing-dispatch-file');
          return 2;
        }
        const dispatchFile = positional[0];
        const slotIds = positional.slice(1);
        return await runDispatch(dispatchFile, slotIds, {
          registry: registryPath,
          ladder: ladderArg,
          runsFile: runsFileArg,
          signalsFile: signalsFileArg,
          failoverFile: failoverFileArg,
          revise: reviseFlag,
          fastRetry: fastRetryFlag,
          stallSeconds: stallSec,
          hardSeconds: hardSec
        });
      }
      case 'start': {
        if (!positional.length) {
          console.log('ERROR reason=missing-dispatch-file');
          return 2;
        }
        const dispatchFile = positional[0];
        const slotIds = positional.slice(1);
        const sub = spawn(process.execPath, [__filename, 'run', dispatchFile, ...slotIds], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true
        });
        sub.unref();
        console.log(`START dispatch=${dispatchFile} pid=${sub.pid}`);
        return 0;
      }
      case 'status': {
        if (!positional.length) {
          console.log('ERROR reason=missing-dispatch-file');
          return 2;
        }
        return statusDispatch(positional[0], { registry: registryPath });
      }
      case 'stop': {
        if (positional.length < 2) {
          console.log('ERROR reason=missing-stop-arguments');
          return 2;
        }
        return stopSlot(positional[0], positional[1], { registry: registryPath, ack: ackArg });
      }
      case 'accept': {
        if (positional.length < 2) {
          console.log('ERROR reason=missing-accept-arguments');
          return 2;
        }
        const reason = positional.slice(2).join(' ') || 'accepted';
        return acceptSlot(positional[0], positional[1], reason, { registry: registryPath });
      }
      case 'report': {
        if (!positional.length) {
          console.log('ERROR reason=missing-dispatch-file');
          return 2;
        }
        return reportDispatch(positional[0], { registry: registryPath, runsFile: runsFileArg });
      }
      default: {
        console.log(`ERROR reason=unknown-command command=${cmd}`);
        return 2;
      }
    }
  } catch (e) {
    console.log(`ERROR reason=execution-error message="${e.message}"`);
    return 2;
  }
}

if (require.main === module) {
  main(process.argv.slice(2)).then(code => {
    if (code !== null && code !== undefined) process.exitCode = code;
  }).catch(() => {
    process.exitCode = 2;
  });
}

module.exports = {
  main,
  loadRegistry: registry.loadRegistry,
  validateRegistry: registry.validateRegistry,
  loadDispatch: registry.loadDispatch,
  validateDispatch: registry.validateDispatch,
  loadLadder: registry.loadLadder,
  verifyLadderSectionSha256: registry.verifyLadderSectionSha256,
  resolveSlot: resolver.resolveSlot,
  resolveCommand: resolver.resolveCommand,
  computePins: resolver.computePins,
  verifyPins: resolver.verifyPins,
  writeRepairFile: executor.writeRepairFile,
  checkCompletion: executor.checkCompletion,
  mapClassForRunRecord: executor.mapClassForRunRecord,
  makePointer: procfs.makePointer,
  buildClientCommand: clients.buildClientCommand,
  formatCommandLine: clients.formatCommandLine,
  probeClient: clients.probeClient,
  probeAll: clients.probeAll,
  executeAttempt: executor.executeAttempt,
  prepareWorkdir: workdir.prepareWorkdir,
  dropWorkdir: workdir.dropWorkdir,
  scopeCheck: workdir.scopeCheck,
  scopeViolations: workdir.scopeViolations,
  importResults: workdir.importResults,
  lsRemoteSnapshot: workdir.lsRemoteSnapshot,
  remoteAuditVerdict: workdir.remoteAuditVerdict,
  workdirState: workdir.workdirState,
  readStateRetried: procfs.readStateRetried,
  gitProcessIn: procfs.gitProcessIn,
  parsePorcelainZ: procfs.parsePorcelainZ,
  executorEnv: procfs.executorEnv,
  gitEnv: procfs.gitEnv,
  gitOpts: procfs.gitOpts,
  git: procfs.git,
  gitIn: procfs.gitIn,
  takeStartLock: executor.takeStartLock,
  releaseStartLock: executor.releaseStartLock,
  checkCommand: procfs.checkCommand,
  chunkIsProgress: executor.chunkIsProgress,
  classifyErrorText: executor.classifyErrorText,
  parseUsageFromLog: clients.parseUsageFromLog,
  reportDispatch: cli.reportDispatch,
  runDispatch: cli.runDispatch,
  killExact: procfs.killExact,
  identityOf: procfs.identityOf,
  snapshotProcesses: procfs.snapshotProcesses,
  isPidAlive: procfs.isPidAlive,
  FAILURE_CLASSES: executor.FAILURE_CLASSES,
  ERROR_PATTERNS: executor.ERROR_PATTERNS,
  ERROR_TEXT: executor.ERROR_TEXT,
  RETRY_TEXT: executor.RETRY_TEXT,
  NO_PUSH: workdir.NO_PUSH,
  getRepoRoot: procfs.getRepoRoot
};

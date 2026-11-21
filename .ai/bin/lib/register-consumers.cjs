'use strict';
// Pinned consumer routing and repeatable citation shadow observations.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const F = require('./register-fragments.cjs');
const C = require('./register-compiler.cjs');
const M = require('./register-consumer-mode.cjs');
const { createRegisterCitations } = require('./register-citations.cjs');
const { readGitTree } = require('./register-tree.cjs');
const { isProtectedPath } = require('./protected-paths.cjs');
// The package snapshot reader of the train lander is loaded at run time from a resolved path: it is landing tooling with its own
// operator dependencies, not part of the module closure the pilot kit ships with a library that only routes citations
// (docs/ops/pilot-install.cjs follows literal relative requires only).
const TRAIN_LAND_MODULE = path.join(__dirname, '..', 'ops-tools', 'train-land.cjs');
const unseeded = new Set();
const stages = new WeakSet(), legacy = Object.freeze({});
function legacyOptions() { return { registerStage: legacy }; }
function openConsumerStage({ repo = process.cwd(), targetSha } = {}) {
  repo = path.resolve(repo);
  F.need(!isProtectedPath(repo, { mode: 'segment' }), 'CITE_SOURCE_UNKNOWN');
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/i.test(k)));
  const git = (args, binary = false) => spawnSync('git', ['--no-replace-objects', '-c', 'core.fsmonitor=false', ...args], {
    cwd: repo, env, encoding: binary ? undefined : 'utf8', windowsHide: true, timeout: 10000, maxBuffer: 64 * 1024 * 1024,
  });
  if (targetSha === undefined) {
    const r = git(['rev-parse', '--verify', '-q', 'HEAD^{commit}']);
    if (!r.error && (r.status === 1 || r.status === 128) && !r.stdout.trim()) {
      const inside = git(['rev-parse', '--is-inside-work-tree']);
      if (!inside.error && (inside.status === 0 || !require('node:fs').existsSync(path.join(repo, '.git')))) return null;
    }
    F.need(!r.error && r.status === 0, 'CITE_SOURCE_UNKNOWN'); targetSha = r.stdout.trim();
  }
  const key = repo + ':' + targetSha;
  if (unseeded.has(key)) return null;
  const pinned = readGitTree(git, targetSha), mode = M.modeOf(pinned.tree);
  if (!pinned.tree.has(C.STATE)) {
    const history = git(['log', '--first-parent', '-1', '--format=%H', targetSha, '--', C.STATE]);
    F.need(!history.error && history.status === 0 && !history.stdout.trim(), 'REGISTER_LANDING_UNAVAILABLE');
    if (unseeded.size >= 64) unseeded.clear(); unseeded.add(key);
    return null;
  }
  let history, citations, failure = null;
  try {
    history = require('./register-history-git.cjs').openRegisterHistory({ repo, targetSha });
    citations = createRegisterCitations({ mode: 'active', snapshot: history.loadSnapshot(),
      legacyReader: history.legacyReader, legacyMapReader: history.legacyMapReader });
  } catch (e) {
    if (mode === 'active') throw e;
    failure = e.code || 'CITE_SNAPSHOT_INVALID';
  }
  const observations = [];
  function observe(text, options = {}) {
    const sourceSha = options.sourceSha || targetSha;
    F.need(F.SHA.test(sourceSha) && typeof text === 'string', 'CITE_SOURCE_UNKNOWN');
    const record = { targetSha, sourceSha, inputDigest: F.digest(Buffer.from(text)),
      consumer: options.consumer || 'citations', typed: [], differences: [], unexplained: 0 };
    try {
      F.need(!failure, failure);
      const baseline = history.legacyReader(sourceSha), settings = { ...options, sourceSha };
      let rows;
      if (record.consumer === 'closed-number') {
        const numeric = require('../../../tools/operator/closed-number.cjs');
        // Run the real process-required consumer, including its refusal of I slots.
        try {
          const values = numeric.processCitations(text, { registerCitations: citations, registerOptions: settings });
          const tokens = citations.scan(text, settings);
          rows = values.map((value, i) => ({ ref: tokens[i].token, line: 1, outcome: 'resolved', register: value }));
        } catch (e) { rows = [{ ref: text.trim().slice(0, 160), line: 1, outcome: 'unresolved', reason: e.code || 'CITE_INVALID' }]; }
        record.legacyTokens = numeric.processCitations(text, legacyOptions());
      } else {
        // Fleet and prose share this exact pure register-row consumer.
        rows = require('../protocol-prose.cjs').registerCitationsOf({ registerCitations: citations, registerOptions: settings }, text);
      }
      if (record.consumer === 'precert') {
        const unresolved = rows.filter(r => r.outcome === 'unresolved');
        record.fact = require('./precert-facts.cjs').citationFacts({ status: unresolved.length ? 1 : 0,
          stdout: unresolved.map(r => 'UNRESOLVED ' + r.reason).join('\n') }, [])[0];
      }
      for (const row of rows) {
        const typed = { token: row.ref, line: row.line, outcome: row.outcome,
          ...(row.register ? { value: row.register } : { reason: row.reason }) };
        record.typed.push(typed);
        const legacy = record.consumer === 'closed-number' ? record.legacyTokens.includes(row.ref)
          : ['precert', 'prose'].includes(record.consumer) ? null
          : /^P-/.test(row.ref) ? baseline.processIds.includes(row.ref)
          : /^OR-/.test(row.ref) ? (record.consumer === 'fleet' ? null : baseline.itemIds.includes(row.ref)) : null;
        const resolved = row.outcome === 'resolved';
        if (legacy === null && resolved) record.differences.push({ token: row.ref, kind: 'newly-resolved' });
        else if (legacy !== resolved) {
          record.differences.push({ token: row.ref, kind: 'unexplained', reason: row.reason || 'resolution-changed' });
          record.unexplained++;
        }
      }
    } catch (e) {
      record.differences.push({ kind: 'unexplained', reason: e.code || 'CITE_SNAPSHOT_INVALID' }); record.unexplained++;
    }
    observations.push(record); return record;
  }
  const stage = Object.freeze({ sha: targetSha, mode, tree: pinned.tree,
    citations: mode === 'active' ? citations : null, shadowCitations: citations,
    observe, observations, historyError: failure,
    packageInput() {
      const input = require(TRAIN_LAND_MODULE).readRegisterPackageSnapshot({ repo, ref: targetSha, env });
      return input.registerPackage ? { ...input.registerPackage, issueProofs: input.issueProofs,
        schemaState: input.schemaState, proofReader: input.proofReader,
        projectionContext: { legacy: C.readLegacy(input).reg, landing: history.loadSnapshot().landing } } : null;
    } });
  stages.add(stage); return stage;
}
function route(options = {}, repo, targetSha) {
  // Existing in-process contexts are explicit test/adapter seams, never CLI flags.
  if (options.registerStage === legacy) return { ...options, registerStage: null, registerCitations: null };
  if (options.registerCitations !== undefined && options.registerCitations !== null) {
    F.need(require('./register-citations.cjs').isRegisterCitations(options.registerCitations), 'CITE_SNAPSHOT_INVALID');
    return options;
  }
  if (options.registerStage !== undefined && options.registerStage !== null) {
    F.need(stages.has(options.registerStage), 'CITE_SNAPSHOT_INVALID');
    return { ...options, registerCitations: options.registerStage.citations };
  }
  const stage = openConsumerStage({ repo, targetSha });
  return { ...options, registerStage: stage, registerCitations: stage?.citations || null,
    registerOptions: { ...options.registerOptions, ...(stage ? { sourceSha: targetSha || stage.sha } : {}) } };
}
function shadowCorpus({ repo, targetSha, paths }) {
  const stage = openConsumerStage({ repo, targetSha });
  F.need(stage && stage.shadowCitations && !stage.historyError, 'REGISTER_CONSUMER_SHADOW');
  F.need(Array.isArray(paths) && paths.length > 0 && new Set(paths).size === paths.length, 'REGISTER_CONSUMER_CORPUS');
  const records = [];
  for (const p of [...paths].sort()) {
    F.need(typeof p === 'string' && /^(?:docs\/|\.ai\/worklog\/)[A-Za-z0-9_./-]+\.md$/.test(p) &&
      !p.split('/').some(s => s === '..' || s === '.'), 'REGISTER_CONSUMER_CORPUS');
    const e = stage.tree.get(p); F.need(e?.mode === '100644', 'REGISTER_CONSUMER_CORPUS');
    const text = require('./register-landing.cjs').decode(F.bytesOf(e));
    for (const consumer of ['precert', 'prose', 'fleet', 'closed-number']) {
      records.push({ path: p, ...stage.observe(text, { consumer, sourceSha: targetSha }) });
    }
  }
  const unexplained = records.reduce((n, r) => n + r.unexplained, 0);
  return { schema: 'register-consumer-shadow/1', targetSha, records, unexplained,
    digest: F.digest(Buffer.from(JSON.stringify(records))) };
}
module.exports = { openConsumerStage, route, shadowCorpus, legacyOptions };

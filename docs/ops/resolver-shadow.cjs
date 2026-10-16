'use strict';
// resolver-shadow: the recording mode (shadow) of the resolver for real launches (K-002; PROTO-DEC-0143 item 3, 0173 item 6).
// cert-launch, fix-launch and launch-wrapper call record() BEFORE they start the client, with the role and the task class (floor
// tier) they state and the operator's own choice. It asks .ai/bin/protocol-dispatch/resolver.cjs shadowResolve what the resolver
// WOULD choose and appends one resolver-shadow/1 line to <runtime>/resolver-shadow/resolver-shadow-YYYYMMDD.jsonl, keyed by the
// launcher, the launch name and the launchId the launch record will carry. The operator's choice is never changed, and nothing
// here can block or fail a launch: a failing resolver is recorded as resolver.error, a failing write as writeError.
// Why a companion journal and not a field of launch-record/1: the layer's validator (launch-record-validate.cjs) rejects unknown
// fields, and the schema is revised only by its own step.
//   node docs/ops/resolver-shadow.cjs launch-line --name N [--runtime DIR]
// prints the Launch: line of P-L2-002 R-L2-002.5 and the Resolver: line of the newest record of launch N, for the journal.
// Exit: 0 printed; 1 no record of that name; 2 usage.
const fs = require('node:fs');
const path = require('node:path');
const repoPaths = require('../../.ai/bin/repo-paths.cjs');

const RESOLVER = path.join(__dirname, '..', '..', '.ai', 'bin', 'protocol-dispatch', 'resolver.cjs');
const shadowDir = runtime => path.join(runtime, 'resolver-shadow');
const dayFile = (runtime, d) => path.join(shadowDir(runtime), `resolver-shadow-${d.toISOString().slice(0, 10).replace(/-/g, '')}.jsonl`);

function fallback(input, code, detail) {
  const op = input.operator || {};
  const operator = { client: op.client || null, model: op.model || null, effort: op.effort || null };
  return {
    schema: 'resolver-shadow/1', role: input.role || null, taskClass: input.tier || null, stageKind: input.stageKind || 'other', probe: 'skipped', operator,
    resolver: { choice: null, substitutes: [], candidates: [], reason: null, ladderVersion: null, error: code, ...(detail ? { detail: String(detail).slice(0, 200) } : {}) },
    launchLines: [`Launch: model=${operator.model || 'unknown'} effort=${operator.effort || 'unknown'} client=${operator.client || 'unknown'}`, `Resolver: choice=none reason=error:${code} task-class=${input.tier || '-'} ladder=-`],
  };
}

// input: { launcher, name, launchId, role, tier, stageKind, operator: { client, model, effort } }
function record(input = {}, deps = {}) {
  const now = (deps.now || (() => new Date()))();
  let shadow;
  try {
    const resolver = deps.resolver || require(RESOLVER);
    shadow = resolver.shadowResolve(input, { now: now.toISOString(), ...(deps.resolverOpts || {}) });
    if (!shadow || typeof shadow !== 'object' || !shadow.resolver) shadow = fallback(input, 'resolver-error', 'shadowResolve returned no result');
  } catch (e) {
    shadow = fallback(input, 'resolver-error', e && e.message);
  }
  const line = { ...shadow, at: now.toISOString(), launcher: input.launcher || null, name: input.name || null, launchId: input.launchId || null };
  if (deps.write !== false) {
    try {
      const io = deps.fs || fs;
      const runtime = deps.runtimeDir || repoPaths.runtimeDir();
      io.mkdirSync(shadowDir(runtime), { recursive: true });
      io.appendFileSync(dayFile(runtime, now), `${JSON.stringify(line)}\n`, 'utf8');
    } catch (e) {
      line.writeError = (e && (e.code || e.message)) || 'write-failed';
    }
  }
  return line;
}

function newest(runtime, name) {
  const dir = shadowDir(runtime);
  let files = [];
  try { files = fs.readdirSync(dir).filter(n => /^resolver-shadow-\d{8}\.jsonl$/.test(n)).sort().reverse(); } catch { return null; }
  for (const f of files) {
    const lines = fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).reverse();
    for (const l of lines) { try { const r = JSON.parse(l); if (r && r.name === name) return r; } catch { /* torn line */ } }
  }
  return null;
}

function main(argv, deps = {}) {
  const say = deps.say || (l => process.stdout.write(`${l}\n`));
  const val = n => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
  if (argv[0] !== 'launch-line' || !val('name')) { say('usage: resolver-shadow.cjs launch-line --name N [--runtime DIR]'); return 2; }
  const r = newest(path.resolve(val('runtime') || repoPaths.runtimeDir()), val('name'));
  if (!r) { say(`NONE no resolver-shadow record for ${val('name')}`); return 1; }
  for (const l of r.launchLines || []) say(l);
  return 0;
}

module.exports = { record, newest, shadowDir, dayFile, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

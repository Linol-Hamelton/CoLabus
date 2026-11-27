'use strict';
const path = require('node:path');
const O = require('./outcomes.cjs');
const safe = require('../../.ai/bin/lib/path-safe.cjs');
// The refusal is a named code, never a raw file-system message: the constant names
// this CLI throws itself, or e.code for the shared guards; anything else (an
// unexpected host error) is withheld under one fixed name instead of leaking it.
const REFUSAL_NAMES = new Set(['usage', 'root', 'input-overlap', 'output-overlap']);
function main(argv) {
  try {
    const command = argv[0], args = argv.slice(1), options = {}, positional = [];
    const allowed = { record: ['--root', '--input'], export: ['--root', '--out', '--since', '--yes'], verify: [], ingest: ['--into', '--lock-ms'] };
    if (!Object.hasOwn(allowed, command)) throw new Error('usage');
    for (let i = 0; i < args.length; i++) {
      const flag = args[i];
      if (!flag.startsWith('--')) { positional.push(flag); continue; }
      if (!allowed[command].includes(flag) || Object.hasOwn(options, flag)) throw new Error('usage');
      if (flag === '--yes') options[flag] = true;
      else { if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error('usage'); options[flag] = args[++i]; }
    }
    if (['verify', 'ingest'].includes(command) ? positional.length !== 1 : positional.length !== 0) throw new Error('usage');
    if (command === 'verify') { const b = O.verifyFile(positional[0]); process.stdout.write(`VERIFIED ${b.header.count} rows\n`); return 0; }
    if (command === 'ingest') {
      if (!options['--into']) throw new Error('usage');
      // --lock-ms is the documented exact wall-clock deadline of withLock: a contender that
      // must refuse under contention refuses at the deadline, independent of host load and of
      // the derived default budget (which legitimately grows with the measured hold cost).
      // Without the flag the derived default budget applies. The value passes the ONE shared
      // strict parser: every non-canonical spelling refuses by name with
      // exit 2, never exit 0 and never INGESTED.
      const lockMs = options['--lock-ms'] === undefined ? null : O.parseTimeoutMs(options['--lock-ms']);
      const r = O.ingest(positional[0], options['--into'], lockMs); process.stdout.write(`INGESTED ${r.added} rows; duplicates ${r.duplicate}\n`); return 0;
    }
    let root = options['--root'];
    if (!root) {
      const ai = path.join(process.cwd(), '.ai'); O.guard(ai, true);
      root = path.join(ai, 'outcomes');
      const r = safe.mkdirGuarded(process.cwd(), root); if (!r.ok) throw new Error('root');
    }
    O.durable(root);
    if (command === 'record') {
      if (!options['--input']) throw new Error('usage');
      if (safe.sameFileOrNested(O.absolute(root), O.absolute(options['--input']))) throw new Error('input-overlap');
      const input = O.readJson(options['--input']); O.validateRow(input);
      const row = O.record(root, { ...input, rowId: O.randomId() });
      process.stdout.write(`RECORDED ${row.rowId}\n`); return 0;
    }
    if (!options['--out']) throw new Error('usage');
    if (safe.sameFileOrNested(O.absolute(root), O.absolute(options['--out']))) throw new Error('output-overlap');
    const bundle = O.makeBundle(root, options['--since']), bytes = O.bundleBytes(bundle);
    // This is the exact file, including header and every nullable metric.
    process.stdout.write(`PREVIEW outcome-bundle/1\nSIZE ${bytes.length} bytes\n`);
    process.stdout.write(bytes);
    if (!options['--yes']) { process.stdout.write('NOT WRITTEN; review the preview and repeat with --yes\n'); return 1; }
    O.writeExport(root, options['--out'], options['--since'], bundle);
    process.stdout.write('WRITTEN\n'); return 0;
  } catch (e) { const named = e && (typeof e.code === 'string' && e.code ? e.code : REFUSAL_NAMES.has(e.message) ? e.message : 'unspecified'); process.stderr.write('OUTCOMES refused: ' + named + '; content withheld\n'); return 2; }
}
if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { main };

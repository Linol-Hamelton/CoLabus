'use strict';
// Optional source publication checker. Installed kernels have no source build
// infrastructure; absence there is explicit, never a publication certificate.
const fs = require('node:fs');
const path = require('node:path');
const HOME = path.resolve(__dirname, '..', '..', '..');

function run({ root = HOME, base = 'origin/v2.0.0', source = 'HEAD' } = {}) {
  root = path.resolve(root);
  const lines = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(HOME, 'protocol-manifest.json'), 'utf8'));
    if (manifest.role === 'installed' || fs.existsSync(path.join(HOME, 'PRODUCT-VERSION.json'))) {
      return { ok: true, applicable: false, partial: true, lines: ['PRODUCT-GATE-EARLY NOT-APPLICABLE: publication source checker is absent from installed kernels'] };
    }
    // The module belongs to this kernel, never to the candidate fixture root.
    const file = path.join(HOME, 'tools', 'product', 'product-build.cjs');
    const checker = require(file);
    const value = checker.earlyContentCheck({ root, base, source });
    for (const result of value.results) {
      lines.push(`PRODUCT-GATE-EARLY ${result.gate}: ${result.ok ? 'PASS' : 'FAIL'}`);
      for (const finding of result.findings) lines.push(`${result.gate}: ${finding}`);
    }
    lines.push(`PRODUCT-GATE-EARLY PARTIAL: checked=${value.checked.length} deferred=${value.deferred.length}; build gates remain pending`);
    for (const row of value.deferred) lines.push(`PRODUCT-GATE-EARLY DEFERRED ${row.file}: ${row.reason}`);
    return { ...value, applicable: true, lines };
  } catch (e) {
    return { ok: false, partial: true, code: 2, lines: [`PRODUCT-GATE-EARLY REFUSED: ${e.message}`] };
  }
}

function main(argv) {
  if (argv.length > 2 || argv.some(x => x.startsWith('--'))) {
    process.stderr.write('Usage: product-gate-early.cjs [ROOT [BASE]]\n');
    return 2;
  }
  const result = run({ root: argv[0] || HOME, base: argv[1] });
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  return result.code || (result.ok ? 0 : 1);
}

module.exports = { run, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

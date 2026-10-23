'use strict';
// Offline derivation: node docs/ops/pin-separators-build.cjs <confusables.txt>
// Prints the JSON snapshot to stdout; callers choose where to save it.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const VERSION = '18.0.0';
const UPSTREAM_SHA256 = '6ed3ee967c9dfdf6677d563c9985182fbc50a2efb7d6059cd57b2e2ce18f5b92';
// UTS representatives are not necessarily ASCII. These two policy aliases
// retain the existing middle-dot family and include the entire long-dash family.
const PROTOTYPES = { '\u00b7': '.', '\u30fc': '-' };
function derive(bytes, licenseText) {
  if (crypto.createHash('sha256').update(bytes).digest('hex') !== UPSTREAM_SHA256) throw Error('upstream SHA-256 mismatch');
  const text = bytes.toString('utf8');
  if (!text.includes(`# Version: ${VERSION}\n`)) throw Error('Unicode version mismatch');
  const mappings = new Map();
  const decode = hex => hex.trim().split(/\s+/).map(c => String.fromCodePoint(parseInt(c, 16))).join('');
  for (const line of text.split('\n')) {
    const row = /^([0-9A-F ]+)\s*;\s*([0-9A-F ]+)\s*;/.exec(line);
    if (row) mappings.set(decode(row[1]), decode(row[2]));
  }
  function prototype(glyph, seen = new Set()) {
    if (Object.hasOwn(PROTOTYPES, glyph)) return PROTOTYPES[glyph];
    if (!mappings.has(glyph)) return glyph;
    if (seen.has(glyph)) throw Error('confusables cycle');
    return [...mappings.get(glyph)].map(c => prototype(c, new Set([...seen, glyph]))).join('');
  }
  const entries = [...new Set([...mappings.keys(), ...Object.keys(PROTOTYPES)])]
    .sort((a, b) => a.codePointAt(0) - b.codePointAt(0))
    .map(glyph => [glyph, prototype(glyph)])
    .filter(([, target]) => /^[-./_]+$/.test(target));
  // These are character prototypes, not filesystem paths. Numeric code-point
  // arrays represent repeated dots/slashes without ambiguous path-like strings.
  const characters = Object.fromEntries(entries.map(([glyph, target]) => [
    'U+' + glyph.codePointAt(0).toString(16).toUpperCase().padStart(4, '0'),
    [...target].map(c => c.codePointAt(0)),
  ]));
  return {
    source: 'Unicode UTS #39 confusables.txt',
    version: VERSION,
    snapshotDate: '2026-08-06',
    upstreamSha256: UPSTREAM_SHA256,
    policy: 'Recursive UTS prototypes composed only of -./_, including sequences; middle dot -> dot and long-dash representative U+30FC -> hyphen; numeric code-point arrays, applied before NFKD',
    prototypeAliases: PROTOTYPES,
    derivation: 'node docs/ops/pin-separators-build.cjs <pinned confusables.txt>; characters sorted by source code point',
    charactersEncoding: 'U+HEX keys; prototypes are numeric Unicode code-point arrays',
    charactersSha256: crypto.createHash('sha256').update(JSON.stringify(characters)).digest('hex'),
    characters,
    licenseText,
  };
}
module.exports = { derive };
if (require.main === module) {
  const { licenseText } = require(path.join(__dirname, 'lib/pin-separators.json'));
  const json = JSON.stringify(derive(fs.readFileSync(process.argv[2]), licenseText), null, 2)
    .replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  process.stdout.write(json + '\n');
}

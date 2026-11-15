'use strict';
// Read-only meter over terminal records. One terminal record per seat launch.
const fs = require('node:fs');
const path = require('node:path');
const { coverage } = require('./lib/run-usage.cjs');
function summary(dir) {
  const records = [];
  let unreadable = 0;
  for (const file of fs.readdirSync(dir).filter(n => n.endsWith('.terminal.json'))) {
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (!record || !['DONE', 'FAILED'].includes(record.status)) throw new Error('invalid-terminal');
      records.push({ ...record, launchId: file });
    } catch { unreadable++; }
  }
  const out = coverage(records);
  // Unreadable terminal records are unknown launches, never removed from the denominator.
  out.runs += unreadable; out.unreadable = unreadable;
  out.share = out.runs ? out.known / out.runs : null;
  return out;
}
if (require.main === module) {
  try {
    const out = summary(path.resolve(process.argv[2] || '.ai/runtime'));
    process.stdout.write(`RUN-USAGE known=${out.known}/${out.runs} share=${out.share === null ? 'null' : out.share.toFixed(4)} priced=${out.priced}/${out.runs} unreadable=${out.unreadable}\n`);
  } catch { process.stderr.write('RUN-USAGE unavailable: terminal directory unreadable\n'); process.exitCode = 1; }
}
module.exports = { summary };

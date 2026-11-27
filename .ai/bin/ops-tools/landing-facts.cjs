#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { landingFacts, BOUNDARY } = require('../lib/landing-facts.cjs');
function main(argv, say = console.log) {
  const allowed = new Set(['--repo', '--head', '--tree', '--base', '--farm-root']);
  const fields = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!allowed.has(argv[i]) || !argv[i + 1] || Object.hasOwn(fields, argv[i])) {
      say(BOUNDARY); say('REFUSED LANDING_ARGUMENTS_INVALID'); return 2;
    }
    fields[argv[i]] = argv[i + 1];
  }
  const result = landingFacts({ root: path.resolve(fields['--repo'] || process.cwd()), head: fields['--head'],
    tree: fields['--tree'], base: fields['--base'], farmRoot: fields['--farm-root'] });
  say(BOUNDARY);
  for (const row of result.decidingAttempts || []) say(`LANDING-DECIDING shard=${row.index + 1} job=${row.jobId} host=${row.host} attempt=${row.attempt} submittedAt=${row.submittedAt} finishedAt=${row.finishedAt} doneAt=${row.doneAt}`);
  say(JSON.stringify(result));
  return result.ok ? 0 : 1;
}
module.exports = { main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

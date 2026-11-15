'use strict';

// Inherited only by children of the runner. File exit is distinct from pipe close.
const fs = require('node:fs');
const file = process.env.PROTOCOL_PROCESS_REGISTRY;
const runId = process.env.PROTOCOL_PROCESS_RUN;
if (file && runId) {
  const append = row => {
    try { fs.appendFileSync(file, JSON.stringify({ schema: 'process-registry/1', runId, ...row }) + '\n'); }
    catch { process.stderr.write('[boundary] registry=UNVERIFIED reason=child-registration\n'); }
  };
  if (process.platform === 'linux') {
    try {
      const stat = fs.readFileSync('/proc/self/stat', 'utf8');
      const created = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]);
      append({ pid: process.pid, created, role: 'descendant' });
    } catch { append({ pid: process.pid, created: null, role: 'descendant' }); }
  }
  const files = JSON.parse(process.env.PROTOCOL_PROCESS_FILES || '[]');
  if (files.includes(process.argv[1])) process.once('exit', () => append({ fileExit: process.argv[1] }));
}

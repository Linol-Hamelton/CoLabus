'use strict';
// Fake dispatch client for tests/packet-wiring.test.cjs: records what the agent was told and what it can see in its workdir.
// usage: node wiring-fake-client.cjs [mode=<mode>] <workdir> <message...> [--resume=<id>]   (the message is the pointer text dispatch builds)
// modes: (none) write the report and exit 0; crash-resume: the FRESH attempt corrupts the derived launch file (a stale copy) and exits 42 with a session id,
// the RESUME attempt reports what it finds in the derived launch file and exits 0 (wiring certification R-1 / OBS-1).
const fs = require('node:fs');
const path = require('node:path');

let args = process.argv.slice(2);
let mode = '';
if (args[0] && args[0].startsWith('mode=')) { mode = args[0].slice(5); args = args.slice(1); }
const resumeArg = args.find(a => a.startsWith('--resume='));
args = args.filter(a => !a.startsWith('--resume='));
const [workdir, ...messageParts] = args;
const message = messageParts.join(' ');
const rel = process.env.TEST_DISPATCH_OUT_FILE;
const m = /(\.ai\/runtime\/dispatch-packet\/[A-Za-z0-9._-]+\.launch\.md)/.exec(message);
const derivedRel = m ? m[1] : null;
const derivedPath = derivedRel ? path.join(workdir, derivedRel) : null;

if (mode === 'crash-resume' && !resumeArg) {
  if (derivedPath && fs.existsSync(derivedPath)) fs.writeFileSync(derivedPath, 'STALE-DERIVED launch text from before the kernel changed\n', 'utf8');
  console.log('PROGRESS first attempt did some work');
  console.log('SESSION_ID: wiring-crash-session-1');
  process.exit(42);
}

const derived = derivedPath && fs.existsSync(derivedPath) ? fs.readFileSync(derivedPath, 'utf8') : null;
const packetDir = path.join(workdir, '.ai', 'runtime', 'dispatch-packet');
const packetFiles = fs.existsSync(packetDir) ? fs.readdirSync(packetDir).sort() : [];

const report = {
  message,
  mode,
  resumed: Boolean(resumeArg),
  derivedRel,
  derivedExists: derived !== null,
  derivedHasMarker: derived !== null && derived.includes('{{PACKET}}'),
  derivedHasIdentity: derived !== null && /^packet: tool=/m.test(derived),
  derivedIsStale: derived !== null && derived.includes('STALE-DERIVED'),
  derivedHead: derived === null ? null : derived.split('\n').slice(0, 3).join('\n'),
  packetFiles,
};
const out = path.resolve(workdir, rel);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report), 'utf8');
const dir = path.join(workdir, '.ai', 'worklog');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'gemini-0123456789abcdef.md'), '# Session journal\n\nEvidence: recorded\n', 'utf8');
console.log('PROGRESS step 1 completed');
process.exit(0);

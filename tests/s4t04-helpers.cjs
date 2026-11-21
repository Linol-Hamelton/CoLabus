'use strict';

// Shared helpers for the dispatcher watchdog fixtures.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const repoRoot = path.resolve(__dirname, '..');
const dispatchDir = path.join(repoRoot, '.ai', 'bin', 'protocol-dispatch');

// A module the spec requires. A missing module is a named assertion failure, never a bare require error.
// S4T04_<NAME>_MODULE overrides the path, so the fixtures can be checked against a reference implementation.
function loadSpecModule(name) {
  const override = process.env[`S4T04_${name.toUpperCase()}_MODULE`];
  const file = override || path.join(dispatchDir, `${name}.cjs`);
  assert.ok(fs.existsSync(file), `DISPATCH-MODULE-MISSING: spec requires .ai/bin/protocol-dispatch/${name}.cjs (not implemented yet)`);
  return require(file);
}

function requireFn(mod, fn, rule) {
  assert.equal(typeof mod[fn], 'function', `${rule}: spec requires the function ${fn}() to be exported`);
  return mod[fn];
}

// Fake clock: the pure modules take `now` in every sample, so time moves only when the test says so.
function makeClock(startMs = Date.UTC(2026, 9, 6, 12, 0, 0)) {
  let t = startMs;
  return {
    now: () => t,
    advance: ms => { t += ms; return t; }
  };
}

const MIN = 60 * 1000;

// One liveness sample. Every signal defaults to "nothing happened".
function sample(now, over = {}) {
  return {
    now,
    ownLines: [],
    outputsChanged: false,
    journalsChanged: false,
    heartbeat: false,
    treeMtimeChanged: false,
    cpuMs: 0,
    ...over
  };
}

// Fake process table: what a fresh process-table read returns. createdAt is an ISO UTC string with milliseconds.
function proc(pid, ppid, createdAt) {
  return { pid, ppid, createdAt };
}

module.exports = { repoRoot, dispatchDir, loadSpecModule, requireFn, makeClock, sample, proc, MIN };

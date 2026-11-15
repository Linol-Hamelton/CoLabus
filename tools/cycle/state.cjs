'use strict';
const fs = require('node:fs');
const path = require('node:path');
const safe = require('../../.ai/bin/lib/path-safe.cjs');
const reader = require('./reader.cjs');
function location(repoRoot) {
  const directory = path.join(repoRoot, '.ai/runtime/cycle-controller');
  const target = path.join(directory, 'state.json');
  // The state capability has one fixed basename and one fixed parent. No caller path is accepted.
  if (!require('./paths.cjs').same(path.dirname(target),directory) || path.basename(target) !== 'state.json') reader.refuse('state-target');
  const guard = safe.realInside(repoRoot, target, { refuseHardlinks:true });
  if (!guard.ok) reader.refuse('state-path');
  return { directory, target };
}
function validate(value) {
  reader.checked(value, 'state', 'state');
  for (const key of ['firstObservedAt','lastObservedAt','lastSeatAt']) {
    if (key === 'lastSeatAt' && value[key] === null) continue;
    if (typeof value[key] !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value[key]) ||
        !Number.isFinite(Date.parse(value[key])) || new Date(value[key]).toISOString() !== value[key]) reader.refuse('state-time');
  }
  if (value.firstObservedAt > value.lastObservedAt || (value.lastSeatAt && value.lastSeatAt > value.lastObservedAt)) reader.refuse('state-time-order');
  return value;
}
function snapshot(repoRoot, now) {
  const { target } = location(repoRoot);
  if (!fs.existsSync(target)) return { expected:null, value:validate({ schema:'cycle-controller/1', revision:0, firstObservedAt:now, lastObservedAt:now, lastSeatAt:null }) };
  const expected = reader.bytes(target, 'state');
  const value = reader.json(target, 'state');
  if (!expected.equals(reader.bytes(target, 'state'))) reader.refuse('state-read-race');
  validate(value);
  if (now < value.lastObservedAt) reader.refuse('state-clock-regression');
  return { expected, value };
}
function save(repoRoot, previous, next) {
  validate(next);
  if (next.revision !== previous.value.revision + 1) reader.refuse('state-revision');
  const { directory, target } = location(repoRoot);
  // mkdirGuarded validates every ancestor, including a runtime junction.
  const runtime = safe.mkdirGuarded(repoRoot, path.dirname(directory));
  if (!runtime.ok) reader.refuse('state-directory');
  const made = safe.mkdirGuarded(repoRoot, directory);
  if (!made.ok) reader.refuse('state-directory');
  const compare = () => {
    const current = fs.existsSync(target) ? reader.bytes(target, 'state') : null;
    if (current === null ? previous.expected !== null : previous.expected === null || !current.equals(previous.expected)) reader.refuse('state-concurrent-change');
  };
  compare();
  const content = Buffer.from(JSON.stringify(next, null, 2) + '\n');
  const result = safe.writeAtomicGuarded(target, content, { root:directory, onTempWritten:compare });
  if (!result.ok) reader.refuse('state-atomic-write');
  if (!reader.bytes(target, 'state').equals(content)) reader.refuse('state-reread-mismatch');
  validate(reader.json(target, 'state'));
}
module.exports = { location, validate, snapshot, save };

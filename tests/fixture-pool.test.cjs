'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeFixture, git } = require('./helpers.cjs');

// F-CODEX-01 regression: releaseFixture must reset local Git config before a
// fixture re-enters the pool, otherwise `git config` writes from one test are
// visible to the next consumer of the pooled fixture.
function acquire() {
  let release = null;
  const root = makeFixture({ after: fn => { release = fn; } });
  assert.equal(typeof release, 'function');
  return { root, release };
}

test('pooled fixture release removes local git config set by the previous consumer', t => {
  const first = acquire();
  const marker = git(first.root, ['config', 'protocol.fixturePoolProbe', 'polluted-by-fixture-a']);
  assert.equal(marker.status, 0, marker.stderr);
  const set = git(first.root, ['config', '--get', 'protocol.fixturePoolProbe']);
  assert.equal(set.stdout.trim(), 'polluted-by-fixture-a');
  first.release();

  const second = acquire();
  t.after(() => { second.release(); });

  // The second acquisition must be the pooled reuse itself, otherwise the
  // assertions below would pass vacuously on a freshly built repository.
  assert.equal(second.root, first.root, 'expected the released fixture to be pooled and reused');

  const leaked = git(second.root, ['config', '--get', 'protocol.fixturePoolProbe']);
  assert.equal(leaked.stdout.trim(), '', 'local git config must not survive fixture release');
  assert.notEqual(leaked.status, 0, 'probe config key must be absent in the reused fixture');
  assert.equal(fs.existsSync(path.join(second.root, 'leak.txt')), false);
});

// F-R2B-CODEX-01 regression: removing loose refs under .git/refs/heads does
// not clear .git/packed-refs or tags. A consumer that packs its refs (branch
// plus tag via `git pack-refs --all --prune`) must not leak either into the
// next pooled acquisition.
test('pooled fixture release clears packed refs and tags left by the previous consumer', t => {
  const first = acquire();
  const steps = [
    ['config', 'protocol.fixturePoolProbe', 'polluted-by-fixture-a'],
    ['branch', 'pool-leak-branch'],
    ['tag', 'pool-leak-tag'],
    ['pack-refs', '--all', '--prune'],
  ];
  for (const args of steps) {
    const result = git(first.root, args);
    assert.equal(result.status, 0, `${args.join(' ')}: ${result.stderr}`);
  }
  const packed = fs.readFileSync(path.join(first.root, '.git', 'packed-refs'), 'utf8');
  assert.match(packed, /pool-leak-branch/, 'precondition: the probe branch must live in packed-refs');
  first.release();

  const second = acquire();
  t.after(() => { second.release(); });
  assert.equal(second.root, first.root, 'expected the released fixture to be pooled and reused');

  const refs = git(second.root, ['for-each-ref', '--format=%(refname)', 'refs/heads', 'refs/tags']);
  assert.equal(refs.status, 0, refs.stderr);
  assert.deepEqual(refs.stdout.trim().split(/\r?\n/), ['refs/heads/main'],
    'reacquired fixture must hold only refs/heads/main - no packed refs, no tags');
  assert.equal(fs.existsSync(path.join(second.root, '.git', 'packed-refs')), false,
    'packed-refs must not survive fixture release');
  const config = git(second.root, ['config', '--get', 'protocol.fixturePoolProbe']);
  assert.notEqual(config.status, 0, 'probe config key must be absent in the reused fixture');
});

// F-GLM-01 regression: releaseFixture pruned refs/heads/* before
// `git reset --hard`, so a checked-out non-main branch was recreated and HEAD
// stayed attached to it, handing the next consumer a stale branch.
test('pooled fixture release restores HEAD and prunes a checked-out non-main branch', t => {
  const first = acquire();
  const created = git(first.root, ['checkout', '-b', 'feature-x']);
  assert.equal(created.status, 0, created.stderr);
  const head = git(first.root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  assert.equal(head.stdout.trim(), 'feature-x', 'precondition: the probe branch must be checked out');
  fs.writeFileSync(path.join(first.root, 'leak.txt'), 'pollute');
  first.release();

  const second = acquire();
  t.after(() => { second.release(); });
  assert.equal(second.root, first.root, 'expected the released fixture to be pooled and reused');

  const onBranch = git(second.root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  assert.equal(onBranch.status, 0, onBranch.stderr);
  assert.equal(onBranch.stdout.trim(), 'main', 'HEAD must be back on main in the reacquired fixture');
  const refs = git(second.root, ['for-each-ref', '--format=%(refname)', 'refs/heads']);
  assert.deepEqual(refs.stdout.trim().split(/\r?\n/), ['refs/heads/main'],
    'the checked-out probe branch must not survive fixture release');
  assert.equal(fs.existsSync(path.join(second.root, 'leak.txt')), false);
  assert.equal(fs.existsSync(path.join(second.root, '.git', 'internal.md')), false);
});

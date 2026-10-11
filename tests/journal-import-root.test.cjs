'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const dispatch = require('../.ai/bin/protocol-dispatch.cjs');
const { tt } = require('./helpers.cjs');
// The dispatch executor in this file makes <temp>/colabs-hooks-* (and clones) in-process: this process's temp dir is a fixture dir from here on.
tt.isolateTemp('iso-');

const repoRoot = path.resolve(__dirname, '..');

test('journal-import-root: declared outputs respect PROTOCOL_JOURNAL_IMPORT_ROOT', async (t) => {
  // Create a temporary directory for the test
  const testTmp = tt.mkTmp('journal-import-test-');
  t.after(() => {
    fs.rmSync(testTmp, { recursive: true, force: true });
  });

  // Set up the override directory
  const overrideRoot = path.join(testTmp, 'override-root');
  fs.mkdirSync(overrideRoot, { recursive: true });

  // Save original env and set the override
  const origEnv = process.env.PROTOCOL_JOURNAL_IMPORT_ROOT;
  t.after(() => {
    process.env.PROTOCOL_JOURNAL_IMPORT_ROOT = origEnv;
    if (origEnv === undefined) {
      delete process.env.PROTOCOL_JOURNAL_IMPORT_ROOT;
    }
  });
  process.env.PROTOCOL_JOURNAL_IMPORT_ROOT = overrideRoot;

  // Create a temporary workdir with declared outputs
  const workdir = path.join(testTmp, 'workdir');
  fs.mkdirSync(workdir, { recursive: true });

  // Create some declared outputs in the workdir
  const declaredOutputs = [
    '.ai/worklog/test-agent-0123456789abcdef.md',
    'tests/results/output.txt'
  ];

  for (const output of declaredOutputs) {
    const fullPath = path.resolve(workdir, output);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, `content of ${output}`, 'utf8');
  }

  // Call importResults
  const imported = dispatch.importResults(workdir, declaredOutputs, repoRoot);

  // Check that files were imported
  assert.equal(imported.length, 2, 'Both files should be imported');

  // The bug: declared outputs are copied to repoRoot instead of overrideRoot
  // After fix: they should be in overrideRoot
  for (const output of declaredOutputs) {
    const expectedPath = path.resolve(overrideRoot, output);
    const wrongPath = path.resolve(repoRoot, output);

    // Check that file exists in the correct location (overrideRoot)
    assert.ok(fs.existsSync(expectedPath), 
      `File ${output} should exist at override location: ${expectedPath}`);

    // Check that file does NOT exist in the wrong location (repoRoot)
    assert.ok(!fs.existsSync(wrongPath),
      `File ${output} should NOT exist at repoRoot location: ${wrongPath}`);

    // Verify content
    const content = fs.readFileSync(expectedPath, 'utf8');
    assert.equal(content, `content of ${output}`, 
      `File ${output} should have correct content`);
  }
});

test('journal-import-root: journals respect PROTOCOL_JOURNAL_IMPORT_ROOT', async (t) => {
  // Create a temporary directory for the test
  const testTmp = tt.mkTmp('journal-import-test-');
  t.after(() => {
    fs.rmSync(testTmp, { recursive: true, force: true });
  });

  // Set up the override directory
  const overrideRoot = path.join(testTmp, 'override-root');
  fs.mkdirSync(overrideRoot, { recursive: true });

  // Save original env and set the override
  const origEnv = process.env.PROTOCOL_JOURNAL_IMPORT_ROOT;
  t.after(() => {
    process.env.PROTOCOL_JOURNAL_IMPORT_ROOT = origEnv;
    if (origEnv === undefined) {
      delete process.env.PROTOCOL_JOURNAL_IMPORT_ROOT;
    }
  });
  process.env.PROTOCOL_JOURNAL_IMPORT_ROOT = overrideRoot;

  // Create a temporary workdir with a journal file
  const workdir = path.join(testTmp, 'workdir');
  fs.mkdirSync(workdir, { recursive: true });

  // Create a journal file in the workdir (git status would show this as untracked)
  const journalPath = '.ai/worklog/glm-0123456789abcdef.md';
  const fullJournalPath = path.resolve(workdir, journalPath);
  fs.mkdirSync(path.dirname(fullJournalPath), { recursive: true });
  fs.writeFileSync(fullJournalPath, '# Journal\n\nContent here\n', 'utf8');

  // Simulate git status showing the journal as untracked
  // We need to set up git in workdir
  const git = require('node:child_process').spawnSync;
  git('git', ['init'], { cwd: workdir, encoding: 'utf8', windowsHide: true });
  git('git', ['config', 'user.email', 'test@example.com'], { cwd: workdir, encoding: 'utf8', windowsHide: true });
  git('git', ['config', 'user.name', 'Test'], { cwd: workdir, encoding: 'utf8', windowsHide: true });

  // Call importResults with no declared outputs (journal should still be imported)
  const imported = dispatch.importResults(workdir, [], repoRoot);

  // Check that journal was imported
  assert.equal(imported.length, 1, 'Journal should be imported');

  // Journals should go to overrideRoot
  const expectedJournalPath = path.resolve(overrideRoot, journalPath);
  const wrongJournalPath = path.resolve(repoRoot, journalPath);

  assert.ok(fs.existsSync(expectedJournalPath),
    `Journal should exist at override location: ${expectedJournalPath}`);

  assert.ok(!fs.existsSync(wrongJournalPath),
    `Journal should NOT exist at repoRoot location: ${wrongJournalPath}`);
});

test('journal-import-root: without override, uses repoRoot', async (t) => {
  // Create a temporary directory for the test
  const testTmp = tt.mkTmp('journal-import-test-');
  t.after(() => {
    fs.rmSync(testTmp, { recursive: true, force: true });
  });

  // Clear the override
  const origEnv = process.env.PROTOCOL_JOURNAL_IMPORT_ROOT;
  t.after(() => {
    process.env.PROTOCOL_JOURNAL_IMPORT_ROOT = origEnv;
    if (origEnv === undefined) {
      delete process.env.PROTOCOL_JOURNAL_IMPORT_ROOT;
    }
  });
  delete process.env.PROTOCOL_JOURNAL_IMPORT_ROOT;

  // Create a temporary workdir with declared outputs
  const workdir = path.join(testTmp, 'workdir');
  fs.mkdirSync(workdir, { recursive: true });

  // Create a declared output
  const declaredOutput = 'tests/results/output.txt';
  const fullPath = path.resolve(workdir, declaredOutput);
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  fs.writeFileSync(fullPath, 'content here', 'utf8');

  // Call importResults
  const imported = dispatch.importResults(workdir, [declaredOutput], repoRoot);

  // Without override, should use repoRoot
  const expectedPath = path.resolve(repoRoot, declaredOutput);

  // Clean up if it exists (it will after the fix, but we need to verify it was created)
  t.after(() => {
    if (fs.existsSync(expectedPath)) {
      fs.rmSync(expectedPath, { force: true });
    }
  });

  assert.ok(fs.existsSync(expectedPath),
    `Without override, file should exist at repoRoot: ${expectedPath}`);

  const content = fs.readFileSync(expectedPath, 'utf8');
  assert.equal(content, 'content here', 'Content should be correct');
});

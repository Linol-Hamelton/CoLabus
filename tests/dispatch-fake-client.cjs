'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');

const args = process.argv.slice(2);
const mode = args[0] || 'work';
const outdir = args[1] || '.';
const root = args[2] || '.';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const writeStdout = text => new Promise((resolve, reject) =>
  process.stdout.write(text, error => error ? reject(error) : resolve()));

const writeJournal = () => {
  const dir = path.join(root, '.ai', 'worklog');
  fs.mkdirSync(dir, { recursive: true });
  const journalFile = path.join(dir, 'gemini-0123456789abcdef.md');
  fs.writeFileSync(journalFile, '# Session journal\n\nEvidence: recorded\n', 'utf8');
};

const writeOutput = (content = 'result from fake client\n') => {
  const rel = process.env.TEST_DISPATCH_OUT_FILE || path.join('tests', 'fixtures', 'dispatch', 'out1.txt');
  const p = path.resolve(root, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, 'utf8');
};

(async () => {
  switch (mode) {
    case 'work': {
      writeOutput();
      writeJournal();
      await writeStdout('PROGRESS step 1 completed' + '\n');
      await writeStdout('PROGRESS step 2 completed' + '\n');
      process.exitCode = 0; return;
    }
    case 'auth-error': {
      await writeStdout('Error: 401 Unauthorized - invalid credentials' + '\n');
      process.exitCode = 1; return;
    }
    case 'rate-limit': {
      await writeStdout('HTTP 429 Too Many Requests - rate limit exceeded' + '\n');
      process.exitCode = 1; return;
    }
    case 'quota-exhausted': {
      await writeStdout('Error: quota exceeded for current billing period; RESOURCE_EXHAUSTED' + '\n');
      process.exitCode = 1; return;
    }
    case 'model-unavailable': {
      await writeStdout('Error: model gpt-unknown not found and does not exist' + '\n');
      process.exitCode = 1; return;
    }
    case 'network-error': {
      await writeStdout('FetchError: ECONNRESET socket hang up network error' + '\n');
      process.exitCode = 1; return;
    }
    case 'provider-error': {
      await writeStdout('HTTP 503 Service Unavailable: provider error overloaded' + '\n');
      process.exitCode = 1; return;
    }
    case 'process-crash': {
      writeOutput('partial work\n');
      await writeStdout('PROGRESS useful progress line 1' + '\n');
      process.exitCode = 42; return;
    }
    case 'invalid-output-missing': {
      await writeStdout('PROGRESS fake work without writing outputs' + '\n');
      process.exitCode = 0; return;
    }
    case 'invalid-output-empty': {
      writeOutput('');
      await writeStdout('PROGRESS fake work writing 0 bytes' + '\n');
      process.exitCode = 0; return;
    }
    case 'silent': {
      await sleep(120000);
      process.exitCode = 0; return;
    }
    case 'always-talking': {
      for (let i = 0; i < 300; i++) {
        await writeStdout(`PROGRESS line ${i}` + '\n');
        await sleep(300);
      }
      process.exitCode = 0; return;
    }
    case 'write-escape': {
      writeOutput();
      fs.writeFileSync(path.join(root, 'forbidden-escape.txt'), 'escaped write\n', 'utf8');
      writeJournal();
      process.exitCode = 0; return;
    }
    case 'commit-escape': {
      writeOutput();
      writeJournal();
      spawnSync('git', ['add', '.'], { cwd: root });
      spawnSync('git', ['-c', 'user.name=Fake', '-c', 'user.email=fake@example.com', 'commit', '-m', 'unauthorized commit'], { cwd: root });
      process.exitCode = 0; return;
    }
    case 'remote-escape': {
      writeOutput();
      writeJournal();
      spawnSync('git', ['remote', 'add', 'evil', 'https://example.com/evil.git'], { cwd: root });
      process.exitCode = 0; return;
    }
    case 'push-escape': {
      writeOutput();
      writeJournal();
      const r = spawnSync('git', ['push', 'origin', 'HEAD'], { cwd: root, encoding: 'utf8' });
      await writeStdout(`push result: ${r.status} ${r.stderr || ''}` + '\n');
      process.exitCode = 0; return;
    }
    case 'env-dump': {
      writeOutput(JSON.stringify(process.env, null, 2));
      writeJournal();
      await writeStdout('PROGRESS dumped env' + '\n');
      process.exitCode = 0; return;
    }
    case 'repair-mode': {
      const isResume = args.slice(1).some(a => a === '--resume' || a === '-r' || a.startsWith('--resume=') || a === 'resume' || a === '--session' || String(a).includes('dispatch-repair'));
      if (isResume) {
        writeOutput('repaired valid content\n');
        writeJournal();
        await writeStdout('PROGRESS repair finished successfully' + '\n');
        process.exitCode = 0; return;
      } else {
        writeOutput('');
        await writeStdout('SESSION_ID: fake-repair-session-1234' + '\n');
        process.exitCode = 0; return;
      }
      break;
    }
    case 'crash-resume': {
      const isResume = args.slice(1).some(a => a === '--resume' || a === '-r' || a.startsWith('--resume=') || a === 'resume' || a === '--session');
      if (isResume) {
        writeOutput('work completed after crash\n');
        writeJournal();
        await writeStdout('PROGRESS crash resumed successfully' + '\n');
        process.exitCode = 0; return;
      } else {
        writeOutput('partial work\n');
        await writeStdout('PROGRESS useful progress line 1' + '\n');
        await writeStdout('SESSION_ID: fake-crash-session-1234' + '\n');
        process.exitCode = 42; return;
      }
      break;
    }
    case 'stall-wake': {
      const hasWake = args.some(a => String(a).includes('wake.md'));
      const marker = path.join(os.tmpdir(), 'fake-stall-wakes.txt');
      let wakes = 0;
      try { wakes = parseInt(fs.readFileSync(marker, 'utf8'), 10) || 0; } catch {}
      if (hasWake) {
        wakes++;
        fs.writeFileSync(marker, String(wakes), 'utf8');
        await writeStdout('SESSION_ID: fake-stall-session-1234' + '\n');
        await writeStdout(`PROGRESS wake ${wakes} acknowledged` + '\n');
        await sleep(120000);
      } else {
        try { fs.unlinkSync(marker); } catch {}
        await writeStdout('SESSION_ID: fake-stall-session-1234' + '\n');
        await sleep(120000);
      }
      process.exitCode = 0; return;
    }
    case 'transient-retry': {
      const marker = process.env.FAKE_TRANSIENT_MARKER || path.join(os.tmpdir(), 'fake-transient.txt');
      if (!fs.existsSync(marker)) {
        fs.writeFileSync(marker, '1', 'utf8');
        // Let the write callback acknowledge the diagnostic before ending the process.
        await writeStdout('HTTP 429 Too Many Requests: rate limit exceeded\n');
        process.exitCode = 1;
        return;
      } else {
        try { fs.unlinkSync(marker); } catch {}
        writeOutput();
        writeJournal();
        await writeStdout('PROGRESS succeeded on retry\n');
        process.exitCode = 0;
        return;
      }
      break;
    }
    default: {
      console.error(`unknown fake client mode: ${mode}`);
      process.exitCode = 2; return;
    }
  }
})();

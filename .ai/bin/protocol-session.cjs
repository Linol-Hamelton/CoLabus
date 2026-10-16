#!/usr/bin/env node
'use strict';

// Session entry point for assistants without hooks.
//
// Claude and Codex get their journal and their context from a SessionStart
// hook. Any other assistant, reached through a chat panel or a custom
// endpoint, gets nothing: no journal, no injected state, no Stop reminder.
// It could still take part, because AGENTS.md section 5 defines the naming,
// but it had to know to do all of it by hand.
//
// This runs the same engine the hooks run, so a session started here is
// indistinguishable from a hooked one.
//
//   start --agent <name> [--session <id>]   create the journal, print context
//   stop  --agent <name> --session <id>     the Stop check, as a message
//   whoami --agent <name> --session <id>    print the journal and owner name
//
// The printed owner name is what to pass to protocol-lock.cjs and
// protocol-handoff.cjs, so one identity covers journal, lock and evidence.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const hooks = require('./protocol-hooks.cjs');

const RECENT_WINDOW_MS = 15 * 60 * 1000; // 15 minutes (D2 heuristic)

function checkProcessAlive(pid) {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 4) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function isSessionAlive(record) {
  if (!record || record.hostname !== os.hostname()) return null;
  if (typeof record.supervisorPid === 'number' && Number.isInteger(record.supervisorPid) && record.supervisorPid > 4) {
    if (checkProcessAlive(record.supervisorPid)) return true;
    // dead supervisorPid falls through to pid
  }
  const targetPid = (typeof record.sessionPid === 'number' && Number.isInteger(record.sessionPid) && record.sessionPid > 4)
    ? record.sessionPid
    : record.pid;
  if (typeof targetPid !== 'number' || !Number.isInteger(targetPid) || targetPid <= 4) return null;
  return checkProcessAlive(targetPid);
}

const isProcessAlive = isSessionAlive;

// Live state that lives in .ai/runtime next to the disposable files (breaker latch, budgets, claims, the candidate registry,
// handover notes). cleanup-runtime never moves it, whatever its age (CLEANUP-C D-01). More names go into
// .ai/runtime/cleanup-keep.txt: one exact name or `prefix*` per line. The keep list is live state itself (CLEANUP-C round 1, C-01).
const KEEP_LIST_NAME = 'cleanup-keep.txt';
const LIVE_RUNTIME_STATE = [/^(?:operator|telegram|owner)-/, /^(?:claims\.json|CANDIDATES\.md|cleanup-keep\.txt)$/, /\.running\.json$/];

function isLiveRuntimeState(name) {
  return LIVE_RUNTIME_STATE.some(pattern => pattern.test(name));
}

// The keep list is read once, before any entry is looked at, so the order of the directory listing can never decide whether an
// entry it protects is still protected. A list that exists but cannot be read stops the run: a half-known list protects nothing.
function readKeepList(runtimeDir) {
  let text;
  try { text = fs.readFileSync(path.join(runtimeDir, KEEP_LIST_NAME), 'utf8'); } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error(`Cannot read ${KEEP_LIST_NAME} (${error.code || error.message}); nothing was moved.`);
  }
  return text.split(/\r?\n/).map(line => line.trim()).filter(line => line && !line.startsWith('#'));
}

function isKept(keepList, name) {
  return keepList.some(line => (line.endsWith('*') ? name.startsWith(line.slice(0, -1)) : name === line));
}

// Scripts never delete (owner rule): what cleanup-runtime takes out of .ai/runtime is moved, byte for byte, into
// .ai/runtime/quarantine/<UTC stamp>/ and every move is one line in MOVES.jsonl there. restore-runtime puts a stamp back.
const STAMP_PATTERN = /^\d{8}T\d{6}Z(?:-\d+)?$/;

function utcStamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function makeQuarantine(runtimeDir) {
  const base = path.join(runtimeDir, 'quarantine');
  let dir = null;
  const open = () => {
    if (dir) return dir;
    fs.mkdirSync(base, { recursive: true });
    const stamp = utcStamp();
    for (let n = 0; ; n += 1) {
      const candidate = path.join(base, n ? `${stamp}-${n}` : stamp);
      try { fs.mkdirSync(candidate); dir = candidate; return dir; } catch (error) { if (error.code !== 'EEXIST') throw error; }
    }
  };
  return {
    stamp: () => (dir ? path.basename(dir) : null),
    // rel is the path under .ai/runtime with forward slashes; the move log line is written first, then the file is moved.
    move(fullPath, rel, reason) {
      const target = path.join(open(), ...rel.split('/'));
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const size = fs.statSync(fullPath).size;
      fs.appendFileSync(path.join(dir, 'MOVES.jsonl'),
        `${JSON.stringify({ at: new Date().toISOString(), rel, reason, bytes: size, sha256: sha256File(fullPath) })}\n`);
      fs.renameSync(fullPath, target);
    },
  };
}

// A session snapshot has the shape the hooks write (a numeric version and a files map); a file of any other shape is not one,
// unless a journal with the same stem exists. A corrupt snapshot of a live journal is still protected as before.
function isSnapshotFile(fullPath, worklogDir) {
  if (fs.existsSync(path.join(worklogDir, `${path.basename(fullPath, '.json')}.md`))) return true;
  try {
    const state = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
    return Boolean(state) && typeof state === 'object' && Number.isInteger(state.version)
      && Boolean(state.files) && typeof state.files === 'object' && !Array.isArray(state.files);
  } catch { return false; }
}

const SESSION_USAGE = 'Usage: protocol-session.cjs start|stop|whoami|prune|cleanup-runtime|restore-runtime --agent <name> [--session <id>] [--root <path>] [--supervisor-pid <pid>] [--force]\n'
  + '  cleanup-runtime [--apply] [--force] [--root <path>]   without --apply it only reports what it would move; --apply moves it into .ai/runtime/quarantine/<stamp>/\n'
  + '  restore-runtime [--stamp <stamp> [--apply]] [--root <path>]   without --stamp it lists the stamps; without --apply it only reports';

function parse(argv) {
  const command = argv[0];
  const options = {};
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') { options.dryRun = true; continue; }
    if (argv[i] === '--force') { options.force = true; continue; }
    if (argv[i] === '--apply') { options.apply = true; continue; }
    const value = argv[i + 1];
    if (!value) throw new Error(`Missing value for ${argv[i]}`);
    if (argv[i] === '--agent') options.agent = value;
    else if (argv[i] === '--session') options.session = value;
    else if (argv[i] === '--supervisor-pid') options.supervisorPid = value;
    else if (argv[i] === '--root') options.root = value;
    else if (argv[i] === '--stamp') options.stamp = value;
    else throw new Error(SESSION_USAGE);
    i += 1;
  }
  // prune, cleanup-runtime and restore-runtime are about directory hygiene, not about one assistant.
  if (!['prune', 'cleanup-runtime', 'restore-runtime'].includes(command) && !options.agent) {
    throw new Error('This command needs --agent <name>, for example --agent qwen');
  }
  if (options.agent && !hooks.AGENT_NAME.test(options.agent)) {
    throw new Error('Agent name must be 2 to 24 lowercase letters, digits or hyphens, starting with a letter.');
  }
  return { command, options };
}

function main(argv) {
  const { command, options } = parse(argv);
  const input = { cwd: options.root || process.cwd() };

  if (command === 'start') {
    if (options.supervisorPid !== undefined) {
      const supPid = Number(options.supervisorPid);
      if (!Number.isInteger(supPid) || supPid <= 4 || supPid > 0x7fffffff) {
        throw new Error(`Invalid --supervisor-pid: ${options.supervisorPid} (must be an integer > 4 (reserved system PID))`);
      }
      if (!checkProcessAlive(supPid)) {
        throw new Error(`Invalid --supervisor-pid: process ${supPid} is not alive`);
      }
      input.supervisor_pid = supPid;
    }
    input.session_id = options.session || crypto.randomBytes(8).toString('hex');
    const result = hooks.run('SessionStart', input, options.agent);
    const paths = hooks.sessionPaths(
      fs.realpathSync(input.cwd), input.session_id, options.agent);
    const owner = path.basename(paths.worklog, '.md');
    const state = hooks.readState(paths.state);
    const token = state ? (state.nonce || '') : '';

    process.stdout.write(`${result.hookSpecificOutput.additionalContext}\n`);
    process.stdout.write('---\n\n');
    process.stdout.write(`Session id: ${options.session || input.session_id}\n`);
    process.stdout.write(`Owner name for the lock and for evidence: ${owner}\n`);
    process.stdout.write(`Session token: ${token}\n`);
    if (input.supervisor_pid) {
      process.stdout.write(`Session supervisor PID for lock calls: ${input.supervisor_pid}\n`);
    } else {
      process.stdout.write(`Session PID for lock calls: ${process.pid}\n`);
    }
    process.stdout.write(`Journal: ${paths.worklog}\n`);
    return 0;
  }

  if (command === 'stop') {
    if (!options.session) throw new Error('stop needs the --session id that start printed');
    input.session_id = options.session;
    const result = hooks.run('Stop', input, options.agent);
    if (result && result.systemMessage) {
      process.stderr.write(`${result.systemMessage}\n`);
      return 1;
    }
    // An empty result means the Stop check found nothing to warn about, which
    // also happens when nothing changed and nothing was written. Saying a
    // handoff was recorded in that case was a claim the tool could not support.
    const paths = hooks.sessionPaths(
      fs.realpathSync(input.cwd), options.session, options.agent);
    const file = path.join(
      fs.realpathSync(input.cwd), paths.worklog);
    let entry = null;
    try { entry = hooks.latestCompleteEntry(fs.readFileSync(file, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    process.stdout.write(entry
      ? `Nothing outstanding. ${paths.worklog} holds a complete entry.\n`
      : `Nothing changed in the tree, and ${paths.worklog} holds no complete entry. Nothing was handed off.\n`);
    if (result && (result.durationSec !== undefined || result.changedFiles !== undefined)) {
      const elapsed = (result.durationSec !== undefined && result.durationSec !== null)
        ? ` in ~${result.durationSec}s` : '';
      const firstEdit = (result.firstEditMs !== undefined && result.firstEditMs !== null)
        ? `, first edit at +${result.firstEditMs}ms` : '';
      const handoff = result.handoffComplete !== undefined
        ? `, handoff ${result.handoffComplete ? 'complete' : 'incomplete'}` : '';
      process.stdout.write(`Session telemetry: ${result.changedFiles || 0} file(s) changed${elapsed}${firstEdit}${handoff}.\n`);
    }
    // Surface advisory warnings (missing Evidence, non-standard format, out-of-role work).
    if (result && result.stopWarnings && result.stopWarnings.length) {
      process.stderr.write('\nAdvisory:\n');
      for (const warning of result.stopWarnings) {
        process.stderr.write(`  [WARN] ${warning}\n`);
      }
    }
    // Auto-archive older entries if journal exceeded 150 lines (Fork 2).
    try {
      const archive = require('./protocol-archive.cjs');
      const owner = path.basename(paths.worklog, '.md');
      archive.autoArchiveWorklog(fs.realpathSync(input.cwd), paths.worklog, 150, 1, owner);
    } catch { }
    return 0;
  }

  if (command === 'prune') {
    // Every SessionStart creates a journal, so a session that starts and writes
    // nothing leaves an empty file behind. Only files that hold nothing at all
    // are removed. Matching the canonical heading alone deleted a full audit
    // whose heading carried a time stamp, so any ATX heading or any entry label
    // now counts as content; a nonstandard entry is kept, never destroyed.
    // Active sessions (whose process is alive) and active lock holders are
    // protected from accidental removal unless --force is specified.
    // fs, path, os are module-level imports
    const root = fs.realpathSync(input.cwd);
    const directory = path.join(root, '.ai', 'worklog');
    if (!fs.existsSync(directory)) throw new Error('No .ai/worklog directory here.');

    let activeLockOwner = null;
    try {
      const lockData = JSON.parse(fs.readFileSync(path.join(root, '.ai', 'runtime', 'shared-writer.json'), 'utf8'));
      activeLockOwner = lockData && lockData.owner;
    } catch { }


    const holdsContent = text => /^##[ \t]/m.test(text) || /^(?:Agent|Action|Result|Next step|Open):/m.test(text);
    const empty = fs.readdirSync(directory)
      .filter(name => name.endsWith('.md') && name !== 'README.md')
      .filter(name => !holdsContent(fs.readFileSync(path.join(directory, name), 'utf8')));
    if (!empty.length) {
      process.stdout.write('No empty journals.\n');
      return 0;
    }
    let removedCount = 0;
    for (const name of empty) {
      const owner = path.basename(name, '.md');
      const journalPath = path.join(directory, name);
      const journalStat = fs.statSync(journalPath);
      const isRecent = journalStat.mtimeMs >= (Date.now() - RECENT_WINDOW_MS);

      if (activeLockOwner && owner === activeLockOwner) {
        process.stdout.write(`skipping ${name} (active lock holder)\n`);
        continue;
      }

      const stateFile = path.join(root, '.ai', 'runtime', `${owner}.json`);
      let state = null;
      let hasState = false;
      if (fs.existsSync(stateFile)) {
        try {
          state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
          hasState = true;
        } catch { }
      }

      const liveness = hasState ? isSessionAlive(state) : null;

      // Table 5.2: true -> skip (even with --force)
      if (liveness === true) {
        const livePid = (state && (state.supervisorPid || state.pid)) || 'unknown';
        process.stdout.write(`skipping ${name} (active session process ${livePid})\n`);
        continue;
      }

      if (!options.force) {
        // Table 5.2: null -> preserve
        if (hasState && liveness === null) {
          process.stdout.write(`skipping ${name} (unknown liveness or foreign host)\n`);
          continue;
        }

        // 5.3 Recency fallback: when liveness is false or null (e.g. missing state),
        // treat as active while mtime >= now - RECENT_WINDOW (15 min)
        if (isRecent) {
          process.stdout.write(`skipping ${name} (recent empty journal)\n`);
          continue;
        }
      } else {
        // With --force:
        // Table 5.2: null -> --force may quarantine with an audit message
        if (hasState && liveness === null) {
          process.stderr.write(`[AUDIT WARN] quarantining foreign host or unknown liveness journal ${name} with --force\n`);
        }
        // --force overrides recency for liveness === false or missing state
      }

      if (options.dryRun) { process.stdout.write(`would quarantine ${name}\n`); continue; }
      const quarantine = path.join(root, '.ai', 'runtime', 'pruned');
      fs.mkdirSync(quarantine, { recursive: true });
      fs.renameSync(journalPath, path.join(quarantine, name));
      // Its snapshot is disposable too and belongs to a session that is gone: moved next to the journal, not deleted.
      if (fs.existsSync(stateFile)) {
        let stateTarget = path.join(quarantine, `${owner}.json`);
        if (fs.existsSync(stateTarget)) stateTarget = path.join(quarantine, `${owner}.${Date.now()}.json`);
        fs.renameSync(stateFile, stateTarget);
      }
      process.stdout.write(`quarantined ${name}\n`);
      removedCount += 1;
    }
    process.stdout.write(`${removedCount} journal(s) quarantined.\n`);
    return 0;
  }

  if (command === 'cleanup-runtime') {
    // Move orphaned snapshots whose journals no longer exist, stale temporary files (*.tmp), dead session snapshots older
    // than 24h and other stale files into .ai/runtime/quarantine/<stamp>/. Shared-writer state and live state are never touched.
    // Dry run is the default: nothing changes unless --apply is given, and --dry-run always wins over --apply.
    // Nothing is deleted: the quarantine keeps every file byte for byte and MOVES.jsonl logs one line per move.
    // fs, path, os are module-level imports
    const root = fs.realpathSync(input.cwd);
    const runtimeDir = path.join(root, '.ai', 'runtime');
    if (!fs.existsSync(runtimeDir)) { process.stdout.write('No .ai/runtime directory.\n'); return 0; }
    const worklogDir = path.join(root, '.ai', 'worklog');
    const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const tempCutoff = Date.now() - 60 * 60 * 1000;
    const dry = !options.apply || Boolean(options.dryRun);
    const quarantine = makeQuarantine(runtimeDir);
    const keepList = readKeepList(runtimeDir);
    let cleaned = 0;

    let activeLockOwner = null;
    try {
      const lockData = JSON.parse(fs.readFileSync(path.join(runtimeDir, 'shared-writer.json'), 'utf8'));
      activeLockOwner = lockData && lockData.owner;
    } catch { }

    // One place for every removal: report it, and move it only when applying.
    const take = (fullPath, rel, label) => {
      if (dry) { process.stdout.write(`would move ${label} ${rel} to quarantine\n`); return; }
      quarantine.move(fullPath, rel, label);
      process.stdout.write(`moved ${label} ${rel} to quarantine/${quarantine.stamp()}\n`);
      cleaned += 1;
    };

    for (const name of fs.readdirSync(runtimeDir)) {
      const fullPath = path.join(runtimeDir, name);
      let stat;
      try { stat = fs.statSync(fullPath); } catch (error) {
        // vanished between readdir and stat, or a dangling link: not ours to decide, and never a reason to stop the run
        if (error.code === 'ENOENT') continue;
        throw error;
      }
      // Never touch directories (pruned/, quarantine/, codex-schema/) or lock files.
      if (stat.isDirectory()) continue;
      if (name.startsWith('shared-writer')) continue;

      // The keep list and the names written in it are protected before anything else, whatever their age or suffix.
      if (name === KEEP_LIST_NAME || isKept(keepList, name)) continue;

      // Temporary files older than 1 hour (*.tmp)
      if (name.endsWith('.tmp') && stat.mtimeMs < tempCutoff) {
        take(fullPath, name, 'temp');
        continue;
      }

      // Live state is never moved, whatever its age or its name shape.
      if (isLiveRuntimeState(name)) continue;

      // Snapshots: .json files of the shape the hooks write (anything else is an ordinary file for the age rule below)
      if (name.endsWith('.json') && isSnapshotFile(fullPath, worklogDir)) {
        const owner = name.replace(/\.json$/, '');
        if (activeLockOwner && owner === activeLockOwner) continue;

        let state = null;
        try { state = JSON.parse(fs.readFileSync(fullPath, 'utf8')); } catch { }

        const liveness = isSessionAlive(state);

        // Table 5.2 (:247): true -> skip (even with --force)
        if (liveness === true) continue;

        const journal = name.replace(/\.json$/, '.md');
        // Orphaned snapshots: .json files whose journal no longer exists
        if (!fs.existsSync(path.join(worklogDir, journal))) {
          take(fullPath, name, 'orphan');
          continue;
        }

        // Table 5.2 (:247): null -> preserve (even with --force)
        if (liveness === null) continue;

        // Snapshots from dead session processes older than 24 hours (or if --force and process dead)
        // Table 5.2 (:261): false -> existing --force/24h rule
        if (options.force || stat.mtimeMs < (Date.now() - 24 * 60 * 60 * 1000)) {
          if (liveness === false) {
            take(fullPath, name, 'dead session snapshot');
            continue;
          }
        }

        // Stale snapshots older than 7 days — only if process is confirmed dead
        // Table 5.2 (:272): false -> existing 7d rule
        if (stat.mtimeMs < cutoff && liveness === false) {
          take(fullPath, name, 'stale');
          continue;
        }

        continue;
      }

      // Non-snapshot files older than 7 days (logs, scripts, probes).
      if (stat.mtimeMs < cutoff) take(fullPath, name, 'stale');
    }
    // Quarantined journals (pruned/) older than 30 days are moved on into the quarantine of this run, not deleted.
    const prunedDir = path.join(runtimeDir, 'pruned');
    if (fs.existsSync(prunedDir)) {
      const prunedCutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
      for (const name of fs.readdirSync(prunedDir)) {
        const fullPath = path.join(prunedDir, name);
        let stat;
        try { stat = fs.statSync(fullPath); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
        // The pruned/ quarantine holds moved journals. A directory in it is not one: leave it for the owner.
        if (stat.isDirectory()) { process.stdout.write(`skipping quarantined directory ${name}\n`); continue; }
        if (stat.mtimeMs < prunedCutoff) take(fullPath, `pruned/${name}`, 'quarantined journal');
      }
    }
    if (dry) {
      process.stdout.write('Dry run: nothing was changed. Run again with --apply to move the files listed above into .ai/runtime/quarantine/.\n');
    } else if (cleaned > 0) {
      process.stdout.write(`${cleaned} file(s) moved to .ai/runtime/quarantine/${quarantine.stamp()}. `
        + `Restore: node .ai/bin/protocol-session.cjs restore-runtime --stamp ${quarantine.stamp()} --apply\n`);
    } else {
      process.stdout.write('0 file(s) moved.\n');
    }
    return 0;
  }

  if (command === 'restore-runtime') {
    // Put the files of one cleanup-runtime run back where they were. Nothing is overwritten: a name that exists again is left
    // in the quarantine. Without --stamp it lists the stamps; without --apply it only reports.
    const root = fs.realpathSync(input.cwd);
    const runtimeDir = path.join(root, '.ai', 'runtime');
    const base = path.join(runtimeDir, 'quarantine');
    if (!options.stamp) {
      const stamps = fs.existsSync(base) ? fs.readdirSync(base).filter(name => STAMP_PATTERN.test(name)).sort() : [];
      process.stdout.write(stamps.length ? `${stamps.join('\n')}\n` : 'No quarantine stamps.\n');
      return 0;
    }
    if (!STAMP_PATTERN.test(options.stamp)) throw new Error(`Not a quarantine stamp: ${options.stamp}`);
    const dir = path.join(base, options.stamp);
    const logFile = path.join(dir, 'MOVES.jsonl');
    if (!fs.existsSync(logFile)) throw new Error(`No move log for stamp ${options.stamp}`);
    const dry = !options.apply || Boolean(options.dryRun);
    let restored = 0;
    let left = 0;
    for (const line of fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean)) {
      let item;
      try { item = JSON.parse(line); } catch { process.stdout.write(`skipping an unreadable log line: ${line.slice(0, 60)}\n`); left += 1; continue; }
      const parts = typeof item.rel === 'string' ? item.rel.split('/') : [];
      if (!parts.length || parts.some(part => !part || part === '.' || part === '..' || /[\\:]/.test(part))) {
        process.stdout.write(`skipping an unsafe log entry: ${String(item.rel).slice(0, 60)}\n`); left += 1; continue;
      }
      const from = path.join(dir, ...parts);
      const to = path.join(runtimeDir, ...parts);
      if (!fs.existsSync(from)) { process.stdout.write(`${item.rel}: not in the quarantine (already restored)\n`); continue; }
      if (fs.existsSync(to)) { process.stdout.write(`${item.rel}: left in the quarantine, a file with that name exists again\n`); left += 1; continue; }
      if (item.sha256 && sha256File(from) !== item.sha256) { process.stdout.write(`${item.rel}: left in the quarantine, its bytes changed after the move\n`); left += 1; continue; }
      if (dry) { process.stdout.write(`would restore ${item.rel}\n`); continue; }
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.renameSync(from, to);
      fs.appendFileSync(path.join(dir, 'RESTORES.log'), `${new Date().toISOString()} restored ${item.rel}\n`);
      process.stdout.write(`restored ${item.rel}\n`);
      restored += 1;
    }
    process.stdout.write(dry
      ? 'Dry run: nothing was changed. Run again with --apply to restore.\n'
      : `${restored} file(s) restored, ${left} left in the quarantine. A restored file keeps its old modification time, so a later cleanup-runtime --apply may move it again.\n`);
    return 0;
  }

  if (command === 'whoami') {
    if (!options.session) throw new Error('whoami needs the --session id that start printed');
    const paths = hooks.sessionPaths(
      fs.realpathSync(input.cwd), options.session, options.agent);
    const owner = path.basename(paths.worklog, '.md');
    const state = hooks.readState(paths.state);
    const token = state ? (state.nonce || null) : null;
    const supervisorPid = state ? (state.supervisorPid || null) : null;
    process.stdout.write(`${JSON.stringify({ owner, worklog: paths.worklog, sessionToken: token, supervisorPid }, null, 2)}\n`);
    return 0;
  }

  throw new Error(SESSION_USAGE);
}

module.exports = {
  main,
  parse,
  isSessionAlive,
  isProcessAlive,
  checkProcessAlive,
  RECENT_WINDOW_MS,
};

if (require.main === module) {
  try { process.exitCode = main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`AI protocol: ${error.message}\n`); process.exitCode = 1; }
}

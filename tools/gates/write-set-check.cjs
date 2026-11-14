#!/usr/bin/env node
'use strict';
// write-set-check.cjs - may these tasks run at the same time? (PROTO-DEC-0130 item 3; cards am1:I-001
// and am2:I-002; ported from b-scripts-rules f3355928 onto the current tree.)
//
// Each task gives its write-set either as `Write-set:` lines of its launch file (--task, --dir) or
// as an L2 task-frame scope file (--scope, the format read by .ai/bin/protocol-scope.cjs checkScope).
// The answer is GO (exit 0) or WAIT (exit 1) with one line per reason:
//   MISSING      the launch file has no Write-set line (PROTO-DEC-0130 item 3: the task waits)
//   UNPARSED     an entry outside the closed grammar of tools/gates/path-grammar.cjs
//   ESCAPE       an entry (or a link under a glob or inside its tree) whose real path leaves --root
//   UNKNOWN      the physical identity of an entry cannot be established (an unreadable directory,
//                a tree over the walk bound): unknown is never a pass, the task waits
//   OVERLAP      two tasks can write one path or one physical file
//   EXCLUSIVE    two tasks write the one-task-at-a-time paths of item 3 (validator, suite, .ai/bin,
//                hooks, .claude), even at different files or through hardlinks
//   OPERATOR     a task names a common document that only the operator and scripts writes
//   FORBIDDEN    an entry meets a path of the --forbidden list (L2 task-frame forbidden list)
//   TOO-MANY     more tasks than --max-sessions
// Exit 2: an input cannot be read or the command is malformed (never GO).
//
// Two layers decide every question:
//   lexical   the resolved entry grammar of tools/gates/path-grammar.cjs (case, NFC, the real path
//             of the literal head), which also covers files that do not exist yet
//   physical  every existing file the entry can already write: its real path and its device and
//             inode (a hardlink is one file however it is spelled); globs are expanded in their
//             resolved real directory, trees are walked (bound PHYS_WALK_MAX), a link found under
//             an entry is resolved and is ESCAPE when it leaves --root
// OVERLAP, EXCLUSIVE, OPERATOR and FORBIDDEN fire when either layer meets.
//
// It reads launch files as data: nothing in them is executed, and only statement lines outside
// fenced code, HTML comments and <data id=N> blocks are read (the shared mask of
// .ai/bin/lib/text-safe.cjs through tools/gates/report-lines.cjs). Every input file is a verified
// readFileGuarded descriptor snapshot from the drive root: links in ANY ancestor and hardlinks
// are refused. It advises the launch; it does not start, stop or certify anything.

const fs = require('node:fs');
const path = require('node:path');
const textSafe = require('../../.ai/bin/lib/text-safe.cjs');
const pathSafe = require('../../.ai/bin/lib/path-safe.cjs');
const { analyzeText } = require('./report-lines.cjs');
const { safeLine } = require('./diagnostic.cjs');
const { parseEntry, entriesOverlap, fold, globToRegExp } = require('./path-grammar.cjs');

// PROTO-DEC-0130 item 3, kept even where the path is absent today (PROTO-DEC-0136 item 1 rule);
// .codex/hooks/ is the current home of the Codex hooks (interpretation recorded in the README).
const EXCLUSIVE = ['validate-protocol.ps1', 'test-protocol.ps1', '.ai/bin/', '.ai/hooks/', '.claude/', '.codex/hooks/'];
// PROTO-DEC-0130 item 3 common documents at their current paths, and the shared documents of
// AGENTS.md section 6 (one writer, through the lock).
const OPERATOR_ONLY = [
  '.ai/DECISIONS.md',
  'docs/decisions/REGISTRY.md',
  '.ai/TASK.md',
  '.ai/PLAN.md',
  '.ai/ARCHIVE.md',
];
// PROTO-DEC-0130 item 7: more than 3 sessions only after ops-loop, verdict-check, write-set-check
// and check-plan are ready. That readiness is not something this tool can see, so 3 is the default.
const DEFAULT_MAX_SESSIONS = 3;
const HARD_MAX_SESSIONS = 6;
// The physical layer walks at most this many entries under one entry (a tree or a matched
// directory); above it the answer is UNKNOWN and the task waits, never a pass.
const PHYS_WALK_MAX = 20000;

function parsed(list) { return list.map(raw => parseEntry(raw)); }
const EXCLUSIVE_ENTRIES = parsed(EXCLUSIVE);
const OPERATOR_ENTRIES = parsed(OPERATOR_ONLY);

const errCode = e => String((e && e.code) || 'UNKNOWN').replace(/[^A-Za-z0-9_]/g, '').slice(0, 24) || 'UNKNOWN';

// Read and identity check are one shared operation; a guard followed by a named read is not enough.
function readInputFile(file, label) {
  const abs = path.resolve(file);
  const guard = pathSafe.readFileGuarded(path.parse(abs).root, abs);
  if (!guard.ok) {
    if (guard.reason === 'link') throw new Error(`${label} is a link (refused): ${file}`);
    if (guard.reason === 'not-regular') throw new Error(`${label} is not a regular file: ${file}`);
    throw new Error(`${label} is not readable as a real file (${guard.reason}): ${file}`);
  }
  const d = textSafe.decode(guard.bytes, { bom: 'strip', crlf: 'normalise', invisible: 'refuse', finalNewline: 'report' });
  if (!d.ok) throw new Error(`${label} is not decodable text (${d.problems.map(p => p.code).join(', ')})`);
  return d.text;
}

// Lines of a launch file that count: outside fences, comments and data blocks, through the shared
// mask (tools/gates/report-lines.cjs). A partly masked line keeps its original text, because the
// write-set grammar reads its own backticked entries out of it; `partial` tells the caller that the
// line is not the document's own statement.
function liveLines(text) {
  return analyzeText(text).lines.map(({ n, line, partial }) => ({ n, line, partial }));
}

// Write-set line grammar: "Write-set:" then either
//   backticked entries: the entries are exactly the `...` spans, and what is left between them may
//   only be commas, semicolons, dots and spaces ("`a`, `b`." is two entries); any other leftover text
//   ("(new)", "and its tests") comes back as one more token, so it is UNPARSED, never dropped;
//   plain entries: a comma-separated list of single words ("a/x.md, a/y.md"). Anything else
//   (prose without backticks, several bare words) is ONE token carrying the raw
//   text, so it is UNPARSED, never a set of phantom bare-word entries.
// A trailing comma requires the immediate next live line with 0..3 leading spaces.
// Repeated declarations must describe the same folded set; disagreement refuses.
function splitEntries(text) {
  if (text.trim() === '') return [];
  if (text.includes('`')) {
    const tokens = [];
    const residue = text.replace(/`([^`]*)`/g, (_, inner) => { tokens.push(inner); return ' '; });
    if (!/^[\s,;.]*$/.test(residue)) tokens.push(residue.trim());
    return tokens;
  }
  const parts = text.split(',').map(s => s.trim()).filter(s => s !== '');
  if (parts.length && parts.every(p => !/\s/.test(p))) return parts;
  return [text.trim()];
}

// The text is parsed separately from the read, so a caller that
// guards and decodes a file once can feed both the entries and the declarations from ONE read;
// the file wrappers keep the old one-call shape.
function parseLaunchText(text) {
  const live = liveLines(text);
  let raws = [];
  let found = false;
  for (let i = 0; i < live.length; i++) {
    const m = /^Write-set:(.*)$/.exec(live[i].line);
    if (!m) continue;
    const current = [];
    let rest = m[1];
    current.push(...splitEntries(rest));
    while (/,\s*$/.test(rest)) {
      const next = live[i + 1];
      if (!next || next.n !== live[i].n + 1 || !/^ {0,3}\S/.test(next.line)) {
        throw new Error('write-set continuation is missing or crosses a masked line');
      }
      i++;
      rest = live[i].line;
      current.push(...splitEntries(rest));
    }
    const signature = entries => JSON.stringify([...new Set(entries.map(fold))].sort());
    if (found && signature(raws) !== signature(current)) throw new Error('Write-set declarations disagree');
    raws = current;
    found = true;
  }
  return { source: 'launch', found: found && raws.length > 0, raws };
}

function parseLaunch(file) {
  return { file, ...parseLaunchText(readInputFile(file, 'launch file')) };
}

// The L2 task-frame scope file, read the way protocol-scope.cjs checkScope reads it (one path per
// line, # comments, "- " bullets, backticks). "!" exclusions only narrow a set; ignoring them can
// only add overlaps, so mixed input keeps its inclusions only. A scope of exclusions alone is
// refused by the shared reader (it names no work), never read as an empty or open scope.
function parseScopeText(text) {
  const raws = require('../../.ai/bin/lib/scope-contract.cjs').parsePaths(text)
    .filter(l => !l.startsWith('!'));
  return { source: 'scope', found: raws.length > 0, raws };
}

function parseScope(file) {
  return { file, ...parseScopeText(readInputFile(file, 'scope file')) };
}

function samePrefix(child, parent) {
  if (process.platform === 'win32') { child = child.toLowerCase(); parent = parent.toLowerCase(); }
  return child === parent || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);
}

// Replace the literal head of an entry by its real path under root, one segment at a time: every
// existing segment is resolved (a junction inside the path carries the tree it names), a segment
// that does not exist is looked up by fold in its parent (an NFC entry names
// an NFD file - comparison is without case and after NFC, the disk is not), and an error of the
// file system is unknown, never absence. The rest of the entry is kept as written.
function resolveEntry(entry, rootReal) {
  const literal = entry.kind === 'glob' ? entry.segments.slice(0, -1) : entry.segments.slice();
  let cur = rootReal;
  let depth = 0;
  for (let i = 0; i < literal.length; i++) {
    let st = null;
    let name = literal[i];
    // The comparison grammar folds NFC and case, so every matching disk spelling
    // belongs to the same logical entry even when an exact spelling exists.
    let matches;
    try { matches = fs.readdirSync(cur).filter(nm => fold(nm) === fold(name)); }
    catch (e) { return { ok: false, reason: 'unreadable', error: `the parent cannot be listed (${errCode(e)})` }; }
    if (matches.length > 1) return { ok: false, reason: 'unreadable', error: 'the spelling names more than one entry' };
    try { st = fs.lstatSync(path.join(cur, name)); } catch (e) {
      if (e && e.code === 'ENOENT') {
        let names;
        try { names = fs.readdirSync(cur); } catch (e2) { return { ok: false, reason: 'unreadable', error: `the parent of "${literal[i]}" cannot be listed (${errCode(e2)})` }; }
        const hit = names.filter(nm => fold(nm) === fold(literal[i]));
        if (hit.length === 1) {
          name = hit[0];
          try { st = fs.lstatSync(path.join(cur, name)); } catch (e2) { return { ok: false, reason: 'unreadable', error: `"${literal[i]}" cannot be read (${errCode(e2)})` }; }
        } else if (hit.length > 1) return { ok: false, reason: 'unreadable', error: `the spelling of "${literal[i]}" names more than one entry` };
        else break; // a not-yet-existing tail
      } else return { ok: false, reason: 'unreadable', error: `the real path of "${literal[i]}" cannot be established (${errCode(e)})` };
    }
    if (!st) break;
    let real;
    try { real = fs.realpathSync.native(path.join(cur, name)); } catch (e) { return { ok: false, reason: 'unreadable', error: `"${literal[i]}" cannot be resolved (${errCode(e)})` }; }
    if (!samePrefix(real, rootReal)) return { ok: false, reason: 'escape', error: `real path ${real} is outside the root` };
    cur = real;
    depth = i + 1;
  }
  if (depth === 0) return { ok: true, entry };
  const rel = path.relative(rootReal, cur);
  const head = rel === '' ? [] : rel.split(path.sep);
  return { ok: true, entry: { ...entry, segments: [...head, ...entry.segments.slice(depth)] } };
}

// One physical file or directory this call could write: its real path below the root (case-folded on
// Windows) and its device and inode, so a hardlink of it at any other path is the same target.
function statTarget(rootReal, real) {
  const st = fs.statSync(real, { bigint: true });
  const rel = path.relative(rootReal, real).split(path.sep).join('/');
  return { key: process.platform === 'win32' ? rel.toUpperCase() : rel, dev: st.dev, ino: st.ino };
}

// Every existing file the entry can already write. Globs are expanded in their resolved real
// directory; trees and matched directories are walked; a link under the entry is resolved, and it
// is ESCAPE when it leaves the root. The walk is bounded; above the bound the answer is UNKNOWN.
function enumerateEntry(entry, rootReal, walkMax = PHYS_WALK_MAX) {
  const out = { targets: [], escapes: [], unknowns: [], count: 0, walkMax };
  const record = (p) => {
    let st;
    try { st = fs.lstatSync(p); } catch (e) { if (e && e.code === 'ENOENT') return; out.unknowns.push(`a file cannot be read (${errCode(e)})`); return; }
    if (st.isSymbolicLink()) {
      let real;
      try { real = fs.realpathSync.native(p); } catch (e) { out.unknowns.push(`a link cannot be resolved (${errCode(e)})`); return; }
      if (!samePrefix(real, rootReal)) { out.escapes.push(`${path.basename(p)} resolves outside the root`); return; }
      let stt;
      try { stt = fs.statSync(real); } catch (e) { out.unknowns.push(`a link target cannot be read (${errCode(e)})`); return; }
      try { out.targets.push(statTarget(rootReal, real)); } catch (e) { out.unknowns.push(`a file cannot be read (${errCode(e)})`); return; }
      if (stt.isDirectory()) walk(real);
      return;
    }
    if (!st.isFile() && !st.isDirectory()) return;
    try { out.targets.push(statTarget(rootReal, p)); } catch (e) { out.unknowns.push(`a file cannot be read (${errCode(e)})`); return; }
    if (st.isDirectory()) walk(p);
  };
  const walk = (dirReal) => {
    let names;
    try { names = fs.readdirSync(dirReal, { withFileTypes: true }); }
    catch (e) { out.unknowns.push(`a directory cannot be listed (${errCode(e)})`); return; }
    for (const ent of names) {
      if (++out.count > walkMax) { out.unknowns.push(`more than ${walkMax} entries under it`); return; }
      record(path.join(dirReal, ent.name));
    }
  };
  if (entry.kind === 'glob') {
    const dirReal = path.join(rootReal, ...entry.segments.slice(0, -1));
    let st;
    try { st = fs.statSync(dirReal); } catch (e) { if (e && e.code === 'ENOENT') return out; out.unknowns.push(`the directory of the pattern cannot be read (${errCode(e)})`); return out; }
    if (!st.isDirectory()) { out.unknowns.push('the directory of the pattern is not a directory'); return out; }
    const re = globToRegExp(entry.segments[entry.segments.length - 1]);
    let names;
    try { names = fs.readdirSync(dirReal, { withFileTypes: true }); }
    catch (e) { out.unknowns.push(`a directory cannot be listed (${errCode(e)})`); return out; }
    for (const ent of names) {
      if (++out.count > walkMax) { out.unknowns.push(`more than ${walkMax} entries under it`); return out; }
      if (re.test(fold(ent.name))) record(path.join(dirReal, ent.name));
    }
    return out;
  }
  record(path.join(rootReal, ...entry.segments));
  return out;
}

const EMPTY_PHYS = () => ({ targets: [], escapes: [], unknowns: [], count: 0 });

// Two physical target sets meet: one real path equals or lies inside the other, or the two are one
// file by device and inode (a hardlink at a different path).
function physicalMeet(a, b) {
  for (const ta of a.targets) for (const tb of b.targets) {
    if (ta.key === tb.key || ta.key.startsWith(tb.key + '/') || tb.key.startsWith(ta.key + '/')) return true;
    if (ta.dev === tb.dev && ta.ino === tb.ino) return true;
  }
  return false;
}

function checkTasks(tasks, options = {}) {
  const lines = [];
  const maxSessions = options.maxSessions || DEFAULT_MAX_SESSIONS;
  const walkMax = options.physWalkMax || PHYS_WALK_MAX;
  const rootReal = options.root ? fs.realpathSync.native(options.root) : null;
  const resolveStatic = (raw) => {
    const e = parseEntry(raw);
    if (!e.ok) return { raw, entry: e, phys: EMPTY_PHYS(), resolveError: null };
    let resolved = e;
    let phys = EMPTY_PHYS();
    let resolveError = null;
    if (rootReal) {
      const r = resolveEntry(e, rootReal);
      // F-03: a resolution failure is never discarded: the entry stays lexical (a lexical meet is
      // still reported), and the failure itself becomes a line, so the answer is never GO.
      if (!r.ok) resolveError = { reason: r.reason || 'escape', error: r.error };
      else { resolved = r.entry; phys = enumerateEntry(resolved, rootReal, walkMax); }
    }
    return { raw, entry: resolved, phys, resolveError };
  };
  // F-03: the forbidden list goes through the same real-path resolution as the task entries.
  const forbidden = (options.forbidden || []).map(raw => {
    const w = resolveStatic(raw);
    if (!w.entry.ok) { lines.push(`UNPARSED ${options.forbiddenFile || 'forbidden'} ${w.raw} (${w.entry.error})`); return w; }
    if (w.resolveError) { lines.push(`${w.resolveError.reason === 'escape' ? 'ESCAPE' : 'UNKNOWN'} ${options.forbiddenFile || 'forbidden'} ${w.raw} (${w.resolveError.error})`); return w; }
    if (rootReal) {
      for (const es of w.phys.escapes) lines.push(`ESCAPE ${options.forbiddenFile || 'forbidden'} ${w.raw} (${es})`);
      for (const u of w.phys.unknowns) lines.push(`UNKNOWN ${options.forbiddenFile || 'forbidden'} ${w.raw} (${u})`);
    }
    return w;
  });
  const exclusive = rootReal ? EXCLUSIVE.map(raw => resolveStatic(raw)) : EXCLUSIVE_ENTRIES.map(e => ({ raw: e.raw, entry: e, phys: EMPTY_PHYS(), resolveError: null }));
  const operator = rootReal ? OPERATOR_ONLY.map(raw => resolveStatic(raw)) : OPERATOR_ENTRIES.map(e => ({ raw: e.raw, entry: e, phys: EMPTY_PHYS(), resolveError: null }));
  // An escape recorded under a static exclusive or operator path was
  // dropped by this loop while enumerateEntry reported it: the physical identity of the static
  // set was not whole and the answer was GO (reproduced: the hardlink of the target of a link
  // under .ai/bin is a second task on .ai/bin and was allowed). An escape or an unknown under a
  // static path is UNKNOWN now: the tasks wait, never GO - the tool cannot know which physical
  // files the exclusive or operator paths are while one of their links leaves the root.
  for (const s of [...exclusive, ...operator]) {
    if (s.resolveError) lines.push(`UNKNOWN ${s.raw} (${s.resolveError.error}: the physical identity of an exclusive or operator path is unknown)`);
    else {
      for (const es of s.phys.escapes) lines.push(`UNKNOWN ${s.raw} (${es}: a link under an exclusive or operator path resolves outside the root, the physical identity of the set is not whole)`);
      for (const u of s.phys.unknowns) lines.push(`UNKNOWN ${s.raw} (${u}: the physical identity of an exclusive or operator path is unknown)`);
    }
  }
  const meets = (a, b) => entriesOverlap(a.entry, b.entry) || physicalMeet(a.phys, b.phys);
  if (tasks.length > maxSessions) lines.push(`TOO-MANY ${tasks.length} task(s) (limit ${maxSessions})`);
  const ready = [];
  for (const t of tasks) {
    if (!t.found) { lines.push(`MISSING ${t.file}`); continue; }
    const entries = [];
    let bad = false;
    for (const raw of t.raws) {
      const e = parseEntry(raw);
      if (!e.ok) { lines.push(`UNPARSED ${t.file} ${raw} (${e.error})`); bad = true; continue; }
      let resolved = { raw, entry: e, phys: EMPTY_PHYS() };
      if (rootReal) {
        const r = resolveEntry(e, rootReal);
        if (!r.ok) { lines.push(`${(r.reason || 'escape') === 'escape' ? 'ESCAPE' : 'UNKNOWN'} ${t.file} ${raw} (${r.error})`); bad = true; continue; }
        const phys = enumerateEntry(r.entry, rootReal, walkMax);
        for (const es of phys.escapes) { lines.push(`ESCAPE ${t.file} ${raw} (${es})`); bad = true; }
        for (const u of phys.unknowns) { lines.push(`UNKNOWN ${t.file} ${raw} (${u})`); bad = true; }
        resolved = { raw, entry: r.entry, phys };
      }
      entries.push(resolved);
    }
    if (!bad) ready.push({ file: t.file, entries });
  }
  for (const t of ready) {
    for (const w of t.entries) {
      for (const op of operator) if (op.entry.ok && meets(w, op)) lines.push(`OPERATOR ${t.file} ${w.raw} (${op.raw} is written only by the operator and scripts)`);
      for (const f of forbidden) if (f.entry.ok && meets(w, f)) lines.push(`FORBIDDEN ${t.file} ${w.raw} (meets ${f.raw})`);
    }
  }
  for (let i = 0; i < ready.length; i++) {
    for (let j = i + 1; j < ready.length; j++) {
      const a = ready[i]; const b = ready[j];
      for (const ea of a.entries) for (const eb of b.entries) {
        if (meets(ea, eb)) {
          const how = entriesOverlap(ea.entry, eb.entry) ? '' : '; one physical file';
          lines.push(`OVERLAP ${ea.raw} ${eb.raw} (${a.file} ${b.file}${how})`);
        }
      }
      const exA = a.entries.filter(e => exclusive.some(x => x.entry.ok && meets(e, x)));
      const exB = b.entries.filter(e => exclusive.some(x => x.entry.ok && meets(e, x)));
      if (exA.length && exB.length) lines.push(`EXCLUSIVE ${exA[0].raw} ${exB[0].raw} (${a.file} ${b.file}: one task at a time on validator, suite, .ai/bin, hooks, .claude)`);
    }
  }
  if (lines.length) return { exitCode: 1, lines: [...lines, `WAIT ${tasks.length} task(s)`] };
  return { exitCode: 0, lines: [`WRITE-SET OK ${tasks.length} task(s)`] };
}

function listDir(dir) {
  const abs = path.resolve(dir);
  const guard = pathSafe.realInside(path.parse(abs).root, abs);
  if (!guard.ok) throw new Error(`--dir is not a real directory (${guard.reason}): ${dir}`);
  if (!guard.exists) throw new Error(`--dir does not exist: ${dir}`);
  if (guard.type !== 'dir') throw new Error(`--dir is not a real directory: ${dir}`);
  const files = fs.readdirSync(guard.real, { withFileTypes: true })
    .filter(e => e.name.toLowerCase().endsWith('.md')).map(e => path.join(dir, e.name)).sort();
  if (!files.length) throw new Error(`no .md launch file in ${dir}`);
  return files;
}

function parseArgs(argv) {
  const o = { launches: [], scopes: [], forbidden: null, root: null, maxSessions: DEFAULT_MAX_SESSIONS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      if (i + 1 >= argv.length || argv[i + 1].startsWith('--')) throw new Error(`missing value for ${a}`);
      return argv[++i];
    };
    if (a === '--task') o.launches.push(value());
    else if (a === '--dir') o.launches.push(...listDir(value()));
    else if (a === '--scope') o.scopes.push(value());
    else if (a === '--forbidden') o.forbidden = value();
    else if (a === '--root') o.root = value();
    else if (a === '--max-sessions') {
      const v = value();
      if (!/^[1-9]$/.test(v) || Number(v) > HARD_MAX_SESSIONS) throw new Error(`--max-sessions must be 1..${HARD_MAX_SESSIONS} (PROTO-DEC-0130 item 3)`);
      o.maxSessions = Number(v);
    } else throw new Error(`unknown argument: ${a}`);
  }
  return o;
}

function main(argv) {
  if (argv.includes('--help') || argv.includes('-h')) { process.stdout.write('usage: write-set-check.cjs (--task FILE | --dir DIR | --scope FILE)... [--root DIR] [--forbidden FILE] [--max-sessions N]  (GO exit 0, WAIT exit 1, usage exit 2)\n'); return 0; }
  let o;
  try { o = parseArgs(argv); } catch (e) { process.stderr.write(`ERROR ${safeLine(e.message)}\n`); return 2; }
  if (!o.launches.length && !o.scopes.length) { process.stderr.write('ERROR no task given (--task, --dir or --scope)\n'); return 2; }
  let result;
  try {
    const seen = new Map();
    const tasks = [];
    for (const [file, kind] of [...o.launches.map(f => [f, 'launch']), ...o.scopes.map(f => [f, 'scope'])]) {
      const t = kind === 'launch' ? parseLaunch(file) : parseScope(file);
      // One physical launch file twice: the same inode (a hardlink or another spelling) is the
      // same task, not two (the certification matrix noted the old key missed hardlinks).
      const st = fs.statSync(file, { bigint: true });
      const key = `${st.dev}:${st.ino}`;
      if (seen.has(key)) throw new Error(`one task given twice: ${seen.get(key)} and ${file}`);
      seen.set(key, file);
      tasks.push({ ...t, file: file.replace(/\\/g, '/') });
    }
    const forbidden = o.forbidden ? parseScope(o.forbidden).raws : [];
    if (o.forbidden && !forbidden.length) throw new Error(`forbidden list is empty: ${o.forbidden} (an empty input is never read as no constraint)`);
    if (o.root) {
      const st = fs.statSync(o.root);
      if (!st.isDirectory()) throw new Error(`--root is not a directory: ${o.root}`);
    }
    result = checkTasks(tasks, { root: o.root || process.cwd(), forbidden, forbiddenFile: o.forbidden, maxSessions: o.maxSessions });
  } catch (e) {
    process.stderr.write(`ERROR ${safeLine(e.message)}\n`);
    return 2;
  }
  for (const line of result.lines) process.stdout.write(`${safeLine(line)}\n`);
  return result.exitCode;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));

module.exports = { EXCLUSIVE, OPERATOR_ONLY, DEFAULT_MAX_SESSIONS, HARD_MAX_SESSIONS, PHYS_WALK_MAX, liveLines, splitEntries, parseLaunch, parseLaunchText, parseScope, parseScopeText, readInputFile, resolveEntry, enumerateEntry, physicalMeet, checkTasks, parseArgs, main };

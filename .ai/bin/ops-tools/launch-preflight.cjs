'use strict';
// Launch preflight: facts a launch is checked against before it spends a seat. A refusal names its fact; a fact that is only
// possible is a warning. Read-only except `retire`, which replaces the candidate registry atomically while it holds the registry lock, after
// the shared reader accepts the new text and only while the file still holds the bytes the rows were judged on (a row a tool adds meanwhile
// waits for the lock; a row a lock-free writer adds is kept: the rows are judged again).
//   lineage   a certifier of a family that authored a round of the package. The facts, two sources that are added together (neither
//             drops a family the other proves): the seat records of the launches of the package that were no certifier and no
//             pre-review (stream, model and client the launcher wrote; the role of a record is its launchRole, since the launcher also
//             sets `certifier` for an author seat; a record without a model names no family through a route client), and the writer of
//             each journal entry whose title names the package and whose Agent line gives the writer a role in the round (author,
//             implementer, merger or fixer). Only the writer's own identity counts: the model stands before the role or, for a route
//             client, as the word right after it; the rest of the line (a session, a task, a review that was read) names no author,
//             and no report or other prose ever refuses a certifier.
//   stream    the stream of a launch on a detached head, derived from the one candidate row that holds the head
//   override  the written reason of an override has its length before the first entry of a batch starts
//   rows      candidate rows of an active status whose branch exists nowhere
//   launch-preflight.cjs override --text TEXT
//   launch-preflight.cjs lineage --worktree DIR --stream S [--branch B] [--runtime DIR] --client C --model M
//   launch-preflight.cjs stream --registry FILE --head SHA
//   launch-preflight.cjs rows --repo DIR --registry FILE [--remote NAME] [--retire --date YYYY-MM-DD]
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { parseRegistry, withRegistryLock } = require('../lib/candidate-registry.cjs');
const { overrideProblem, OVERRIDE_MIN } = require('../lib/rule-gates.cjs');
const { maskMarkdown } = require('../lib/text-safe.cjs');
const { writeAtomicGuarded } = require('../lib/path-safe.cjs');
const ACTIVE = ['building', 'ready', 'certifying', 'certified'];
const SHA = /^[0-9a-f]{40}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// The model families by the names a report, a journal or a launch writes. A route client (kilo, cline) names no family; its model does.
const FAMILIES = [['claude', /\b(?:claude|anthropic|opus|sonnet|haiku|fable)\b/i], ['gpt', /\b(?:gpt|codex|openai|sol)\b/i], ['gemini', /\b(?:gemini|argon)\b/i],
  ['glm', /\b(?:glm|zhipu)\b/i], ['deepseek', /\bdeepseek\b/i], ['kimi', /\b(?:kimi|moonshot)\b/i], ['mimo', /\b(?:mimo|xiaomi)\b/i], ['minimax', /\bminimax\b/i],
  ['qwen', /\bqwen\b/i], ['mistral', /\bmistral\b/i], ['copilot', /\bcopilot\b/i]];
const spacedOf = text => String(text === undefined || text === null ? '' : text).replace(/[-_./:]+/g, ' ');
function familyOf(text) {
  const spaced = spacedOf(text);
  const hit = FAMILIES.find(([, re]) => re.test(spaced));
  return hit ? hit[0] : null;
}
// Every family a piece of text names. A path names no family (a task folder called kimi-tasks is no Kimi).
function familiesOf(text) {
  const spaced = spacedOf(String(text === undefined || text === null ? '' : text).replace(/\S*[\\/]\S*/g, ' '));
  return FAMILIES.filter(([, re]) => re.test(spaced)).map(([name]) => name);
}
// A role that shaped a round: an item of the writer line (between commas, semicolons and parentheses) that starts with it ("role AUTHOR",
// "round lgf2 author") or says "as the author". "certifier, not author", "не автор", "author report reader" and a line that only reads
// the author journals of others are no role.
const ROLE_NAME = '(?:author|автор|implementer|merger|aborted merge|merge|fixer)(?![\\p{L}\\p{N}])(?!\\s+report)';
const ROLE_ITEM = new RegExp(`^(?:role\\s+|round\\s+\\S+\\s+)?(?:as\\s+)?(?:an?\\s+|the\\s+)?${ROLE_NAME}|(?<![\\p{L}\\p{N}])as\\s+(?:an?\\s+|the\\s+)?${ROLE_NAME}`, 'iu');
// The writer of a journal entry: the items of its Agent line up to and including the first that gives a role in the round (the client,
// the model and the role stand there; a session, a task or a review the writer read stand after). When those items name no model (a
// route client writes `cline, AUTHOR; Gemini by the owner`), the first word of the item right after the role is the model, if it is
// a family name. No role item: no round.
function writerOf(agent, names = []) {
  const items = String(agent).split(/[(),;]/);
  const at = items.findIndex(item => ROLE_ITEM.test(item.trim()));
  if (at < 0) return null;
  const taken = items.slice(0, at + 1).join(' ');
  if (familiesOf(withoutNames(taken, names)).length) return taken;
  const next = String(items[at + 1] === undefined ? '' : items[at + 1]).replace(/^[\s*_`]+/, '').split(/\s+/)[0];
  return familyOf(next) ? `${taken} ${next}` : taken;
}
// The family of a launch record: its model, else its client when the client is no route.
function recordFamily(record) {
  const named = value => (typeof value === 'string' ? value : '');
  return familyOf(named(record.model)) || (/^(?:kilo|cline)$/i.test(named(record.client)) ? null : familyOf(named(record.client)));
}
// The launches of the package that wrote a round: the seat records (`NAME.running.json`, `NAME.terminal.json`) the launcher keeps in the
// runtime folder, whose stream is a name of the package and whose launch was no certifier and no pre-review.
function seatFamilies(runtimeDir, names) {
  const found = [];
  let files = [];
  try { files = fs.readdirSync(runtimeDir).filter(n => /\.(?:running|terminal)\.json$/.test(n)).sort(); } catch { return found; }
  const mention = names.map(n => `"${n}"`);
  for (const file of files) {
    const text = read(path.join(runtimeDir, file));
    if (text === null || !mention.some(m => text.toLowerCase().includes(m))) continue;
    let record;
    try { record = JSON.parse(text); } catch { continue; }
    if (!record || typeof record !== 'object' || ['certifier', 'pre-review'].includes(record.launchRole)) continue;
    // The launcher sets `certifier` for a launch of any role (it names the wrapper mode); the role of the seat is launchRole. A record
    // that states no role is an author only when it says it was no certifier.
    if (record.launchRole !== 'author' && record.certifier !== false) continue;
    const stream = [record.stream, record.task].find(v => typeof v === 'string' && names.includes(v.toLowerCase()));
    const family = stream && recordFamily(record);
    if (family) found.push([family, file]);
  }
  return found;
}
// The lines the document itself states: a fenced example or a quotation is not a statement of the document. Inline code and a link are
// part of a statement (a title names its package in code); an HTML comment or tag inside a line is not.
const STATED_SPANS = new Set(['code-span', 'inline-link']);
function ownText(text) {
  const plain = String(text).replace(/^\uFEFF/, '');
  try {
    const masked = maskMarkdown(plain);
    return masked.lines.filter(l => !l.masked).map(l => {
      if (!l.partial) return l.text;
      const cuts = masked.spans.filter(s => !STATED_SPANS.has(s.kind) && s.startLine <= l.line && l.line <= s.endLine)
        .map(s => [s.startLine === l.line ? s.startCol : 0, s.endLine === l.line ? s.endCol : l.text.length]).sort((a, b) => a[0] - b[0]);
      let out = '', at = 0;
      for (const [from, to] of cuts) { if (to <= at) continue; out += `${l.text.slice(at, Math.max(from, at))} `; at = to; }
      return out + l.text.slice(at);
    });
  } catch { return plain.split(/\r?\n/); }
}
function read(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }
const escapeRe = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
// A title names a package when its whole id stands in it: PULSE-R20 and PULSE-R2-B are other packages than PULSE-R2.
const idPattern = n => `(?<![A-Za-z0-9-])${escapeRe(n)}(?![A-Za-z0-9]|-[A-Za-z0-9]|\\.[0-9])`;
const namesPackage = (title, names) => names.some(n => new RegExp(idPattern(n), 'i').test(title));
// A writer line that names its own package (`author of QWEN-CLIENT`) names no other family through the id.
const withoutNames = (text, names) => names.reduce((out, n) => out.replace(new RegExp(idPattern(n), 'gi'), ' '), text);

// The families that authored a round of the package, each with the file that says so: the seat records of its author launches
// (`runtimeDir`) and the writer of every journal entry that names the package in its title and gives its writer a role in the round.
// A report is prose of a reader as much as of a writer and states no author. The names of the package: the stream, the branch,
// the branch without its ops- prefix, and the streams of the candidate rows that hold the branch or the head (`names`).
function authorLineage(root, { stream, branch, names: more, runtimeDir } = {}) {
  const found = new Map();
  const add = (families, source) => { for (const family of families) found.set(family, [...(found.get(family) || []), source]); };
  const stripped = typeof branch === 'string' ? branch.replace(/^ops-/i, '') : null;
  const names = [...new Set([stream, branch, stripped, ...(Array.isArray(more) ? more : [])].filter(n => typeof n === 'string' && n).map(n => n.toLowerCase()))];
  if (typeof runtimeDir === 'string' && runtimeDir && names.length) for (const [family, file] of seatFamilies(runtimeDir, names)) add([family], `seat record ${file}`);
  const dir = path.join(root, '.ai', 'worklog');
  let journals = [];
  try { journals = fs.readdirSync(dir).filter(n => n.endsWith('.md') && n !== 'README.md').sort(); } catch { journals = []; }
  for (const name of journals) {
    const text = read(path.join(dir, name));
    if (text === null) continue;
    for (const entry of ownText(text).join('\n').split(/^(?=## )/m)) {
      const title = (/^## (.*)$/m.exec(entry) || [])[1];
      const agent = (/^Agent:[ \t]*(.*)$/m.exec(entry) || [])[1];
      const writer = title && agent && namesPackage(title, names) ? writerOf(agent, names) : null;
      if (writer !== null) add(familiesOf(withoutNames(writer, names)), `.ai/worklog/${name}`);
    }
  }
  return found;
}
// The family of a certifier launch: its model, else its client when the client is no route.
function certifierFamily({ client, model }) {
  return familyOf(model) || (/^(?:kilo|cline)$/i.test(client || '') ? null : familyOf(client));
}
function lineageProblem(who, lineage) {
  const family = certifierFamily(who);
  if (!family || !lineage.has(family)) return null;
  return { code: 'LINEAGE-CERTIFIER', family, detail: `the ${family} family authored a round of this package (${[...new Set(lineage.get(family))].slice(0, 3).join(', ')}); a certifier of another family is needed` };
}

// The stream of a launch on a detached head: the one candidate row that names the head; none or several name no stream.
function streamFromRegistry(registryText, head) {
  if (!SHA.test(head || '')) return { stream: null, reason: 'head' };
  let rows;
  try { rows = parseRegistry(registryText).rows; } catch { return { stream: null, reason: 'registry-unreadable' }; }
  const holders = rows.filter(r => ACTIVE.includes(r.cells[4]) && r.cells[2] === head);
  if (holders.length === 1) return { stream: holders[0].cells[0], reason: null };
  return { stream: null, reason: holders.length ? 'several-rows' : 'no-row' };
}
// The streams of the active rows that hold a branch or a head: the names under which the package wrote its report and its journals.
function registryStreams(registryText, { branch, head } = {}) {
  let rows;
  try { rows = parseRegistry(registryText).rows; } catch { return []; }
  return [...new Set(rows.filter(r => ACTIVE.includes(r.cells[4]) && ((branch && r.cells[1] === branch) || (SHA.test(head || '') && r.cells[2] === head))).map(r => r.cells[0]))];
}

// Rows of an active status whose branch is neither a local branch nor a branch of the remote: the exact fact that a launch gate
// cannot satisfy for them. `exists` answers for one branch name.
function deletedBranchRows(registryText, exists) {
  return parseRegistry(registryText).rows.filter(r => ACTIVE.includes(r.cells[4]) && !exists(r.cells[1])).map(r => ({ stream: r.cells[0], branch: r.cells[1], status: r.cells[4], index: r.index, cells: r.cells }));
}
function retireRows(registryText, rows, date) {
  if (!DATE.test(date || '')) throw Error('PREFLIGHT-DATE');
  const lines = registryText.split('\n');
  for (const row of rows) {
    const cells = row.cells.slice();
    cells[4] = 'retired'; cells[5] = date; cells[6] = `${cells[6]} (branch deleted)`.slice(0, 400);
    lines[row.index] = `| ${cells.join(' | ')} |`;
  }
  const next = lines.join('\n');
  parseRegistry(next);
  return next;
}
// The registry replaced in one step with the rows judged on the bytes it holds, while the registry lock is held (a tool that adds a row
// waits for it). A writer that takes no lock can still change the file: when it changed between the judgement and the replacement, the
// rows are judged again on the new bytes (three times at most).
function retireInFile(file, exists, date, beforeReplace) {
  return withRegistryLock(file, () => retireLocked(file, exists, date, beforeReplace));
}
function retireLocked(file, exists, date, beforeReplace) {
  for (let attempt = 0; attempt < 3; attempt++) {
    const text = fs.readFileSync(file, 'utf8');
    const rows = deletedBranchRows(text, exists);
    if (!rows.length) return 0;
    const next = retireRows(text, rows, date);
    if (beforeReplace) beforeReplace(attempt);
    if (fs.readFileSync(file, 'utf8') !== text) continue;
    if (!writeAtomicGuarded(file, Buffer.from(next, 'utf8'), { root: path.dirname(file) }).ok) throw Error('REGISTRY-WRITE');
    return rows.length;
  }
  throw Error('REGISTRY-BUSY');
}

// Whether a branch exists, answered by git: exit 0 is a branch, exit 1 is none; a repository git cannot read, or any other exit, proves
// nothing and refuses (a row is never retired on an error).
function gitExists(repo, remote) {
  const git = args => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  const inside = git(['rev-parse', '--git-dir']);
  if (inside.error || inside.status !== 0) throw Error('GIT-REFUSED');
  return branch => ['refs/heads/', `refs/remotes/${remote}/`].some(prefix => {
    const r = git(['rev-parse', '--verify', '--quiet', `${prefix}${branch}`]);
    if (r.error || (r.status !== 0 && r.status !== 1)) throw Error('GIT-REFUSED');
    return r.status === 0;
  });
}
// A remote that is configured but holds no fetched branch says nothing about the rows: no row is retired on it.
function remoteFetched(repo, remote) {
  const git = args => spawnSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true });
  const names = git(['remote']);
  if (names.error || names.status !== 0) throw Error('GIT-REFUSED');
  if (!names.stdout.split('\n').map(s => s.trim()).includes(remote)) return true;
  const refs = git(['for-each-ref', '--count=1', `refs/remotes/${remote}/`]);
  if (refs.error || refs.status !== 0) throw Error('GIT-REFUSED');
  return refs.stdout.trim() !== '';
}
function flags(argv, allowed, bare = []) {
  const o = {};
  for (let i = 0; i < argv.length; i++) {
    if (bare.includes(argv[i])) { o[argv[i].slice(2)] = true; continue; }
    const key = allowed[argv[i]];
    if (!key || Object.hasOwn(o, key) || argv[i + 1] === undefined) throw Error('USAGE');
    o[key] = argv[++i];
  }
  return o;
}
function main(argv, out = s => process.stdout.write(`${s}\n`), deps = {}) {
  try {
    const cmd = argv[0], rest = argv.slice(1);
    if (cmd === 'override') {
      const o = flags(rest, { '--text': 'text' });
      if (o.text === undefined) throw Error('USAGE');
      const bad = overrideProblem(o.text);
      out(bad ? `LAUNCH-PREFLIGHT REFUSED ${bad}: the override reason must be at least ${OVERRIDE_MIN} visible characters on one line; no entry was started` : 'LAUNCH-PREFLIGHT OK override');
      return bad ? 1 : 0;
    }
    if (cmd === 'lineage') {
      const o = flags(rest, { '--worktree': 'worktree', '--stream': 'stream', '--branch': 'branch', '--runtime': 'runtimeDir', '--client': 'client', '--model': 'model' });
      const problem = lineageProblem(o, authorLineage(path.resolve(o.worktree), o));
      out(problem ? `LAUNCH-PREFLIGHT REFUSED ${problem.code} family=${problem.family}: ${problem.detail}` : 'LAUNCH-PREFLIGHT OK lineage');
      return problem ? 1 : 0;
    }
    if (cmd === 'stream') {
      const o = flags(rest, { '--registry': 'registry', '--head': 'head' });
      const r = streamFromRegistry(read(path.resolve(o.registry)) || '', o.head);
      out(r.stream ? `LAUNCH-PREFLIGHT OK stream ${r.stream}` : `LAUNCH-PREFLIGHT REFUSED stream-unknown ${r.reason}: pass --packet-stream or give the head one active candidate row`);
      return r.stream ? 0 : 1;
    }
    if (cmd === 'rows') {
      const o = flags(rest, { '--repo': 'repo', '--registry': 'registry', '--remote': 'remote', '--date': 'date' }, ['--retire']);
      const file = path.resolve(o.registry), text = read(file);
      if (text === null) throw Error('USAGE');
      const repo = path.resolve(o.repo), remote = o.remote || 'origin';
      const exists = gitExists(repo, remote);
      const rows = deletedBranchRows(text, exists);
      for (const r of rows) out(`LAUNCH-PREFLIGHT WARN deleted-branch-row stream=${r.stream} branch=${r.branch} status=${r.status}; retire it with: rows --retire --date YYYY-MM-DD`);
      if (o.retire && rows.length) {
        if (!remoteFetched(repo, remote)) { out(`LAUNCH-PREFLIGHT REFUSED remote-not-fetched ${remote}: it holds no fetched branch, so no row is shown to be of a deleted branch; fetch it first`); return 1; }
        out(`LAUNCH-PREFLIGHT OK retired ${retireInFile(file, exists, o.date, deps.beforeReplace)} row(s)`);
      } else out(rows.length ? `LAUNCH-PREFLIGHT WARN ${rows.length} candidate row(s) of deleted branches` : 'LAUNCH-PREFLIGHT OK rows');
      return 0;
    }
    throw Error('USAGE');
  } catch (e) {
    out(`LAUNCH-PREFLIGHT INPUT-REFUSED ${/^[A-Z-]+$/.test(e.message) ? e.message : 'INPUT'}`);
    return 2;
  }
}
module.exports = { familyOf, familiesOf, authorLineage, certifierFamily, lineageProblem, streamFromRegistry, registryStreams, deletedBranchRows, retireRows, retireInFile, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

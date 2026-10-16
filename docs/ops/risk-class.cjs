#!/usr/bin/env node
'use strict';
// risk-class.cjs - two-stage risk classification PRE_CLASS / POST_CLASS by blocking power (PROTO-DEC-0136 item 4,
// PROTO-DEC-0169 items 1-2; advisory classification). Deterministic, model-free, READ-ONLY, ADVISORY: it prints
// a class and the rule that decided it; it writes nothing and gates nothing (wiring is a proposal, ).
//
//   node docs/ops/risk-class.cjs pre  [--repo DIR] (--path P ... | --paths-file F | --launch-file F) [--kind K ...] [--json]
//   node docs/ops/risk-class.cjs post [--repo DIR] --base SHA [--head SHA] [--json]
//   node docs/ops/risk-class.cjs post [--repo DIR] --diff-file F [--json]   (lines of `git diff --raw`, `--name-status` or plain paths)
//   node docs/ops/risk-class.cjs effective --pre A|B [--repo DIR] (--base SHA [--head SHA] | --diff-file F) [--json]
//   node docs/ops/risk-class.cjs --table
// Exit: pre/post 0 when a class was computed (A or B); effective 0 when EFFECTIVE equals PRE, 1 when POST raised the
// class (B -> A: stop before the merge and complete the Class A steps, 0136 item 4); 2 bad invocation or unreadable input.
//
// The path table is CLOSED and POSITIVE: rows are tried in order, the first match decides; a path that matches no row is
// class A with reason `unknown-path` (doubt means Class A, 0136 item 4). Class C (0136 item 3) is never computed: a path
// cannot show that a change is mechanically derived accounting, so the strictest class a path allows is reported.

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const textSafe = require('../../.ai/bin/lib/text-safe.cjs');
const pathSafe = require('../../.ai/bin/lib/path-safe.cjs');
const { guardInput } = require('./injection-scan.cjs');

function readText(file) {
  const g = guardInput(file);
  if (!g.ok || !g.exists || g.type !== 'file') throw new Error(`input-path:${g.reason || 'not-file'}`);
  return decodeText(fs.readFileSync(file));
}
function decodeText(bytes) {
  const d = textSafe.decode(bytes, { bom: 'strip', crlf: 'normalise', invisible: 'refuse' });
  if (!d.ok) throw new Error(`input-text:${d.problems[0].code}`);
  return d.text;
}

// JSON.parse validates syntax first; tokenize complete strings so braces/colons
// inside string values never act as structure. Duplicate decoded keys are doubt.
function duplicateJsonKeys(text) {
  const tokens = text.match(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g) || [];
  const stack = [];
  for (let i=0; i<tokens.length; i++) {
    const token=tokens[i];
    if (token === '{') stack.push(new Set());
    else if (token === '[') stack.push(null);
    else if (token === '}' || token === ']') stack.pop();
    else if (token.startsWith('"') && tokens[i+1] === ':') {
      const keys=stack[stack.length-1]; const k=JSON.parse(token);
      if (keys.has(k)) return true;
      keys.add(k);
    }
  }
  return false;
}

const EXEC_EXT = ['.cjs', '.js', '.mjs', '.ts', '.ps1', '.psm1', '.sh', '.bat', '.cmd', '.py'];
const DOC_EXT = ['.md', '.txt', '.rst'];
const DATA_EXT = ['.json', '.jsonl', '.csv', '.tsv', '.log', '.yml', '.yaml', '.xml', '.png', '.jpg', '.jpeg', '.gif',
  '.svg', '.html', '.gitkeep', '.sha256', '.toml'];
const PATCH_EXT = ['.patch', '.diff'];

// Advisory tools of docs/ops: each one is shown advisory or read-only by the source named here. Only these (and their
// own `<name>.test.cjs`) leave the default Class A of docs/ops code. A tool wired into a gate or a launch leaves this list.
const ADVISORY_OPS = [
  ['docs/ops/injection-scan.cjs', 'PROTO-DEC-0132 item 4 (signal, not a defence); read-only'],
  ['docs/ops/risk-class.cjs', 'this tool: advisory until a wiring is approved'],
  ['docs/ops/state-brief.cjs', 'advisory read-only overview'],
  ['docs/ops/resolver-shadow.cjs', 'PROTO-DEC-0143 item 3: shadow, advises only'],
  ['docs/ops/mcp-recommender.cjs', 'P-66: read-only, installs and starts nothing'],
  ['docs/ops/mcp-schema-budget.cjs', 'P-65: measurement only'],
];

// Paths of docs/ops whose data a gate, a launcher or the owner channel reads.
const OPS_CONTROL_DATA = ['docs/ops/model-ladder.json', 'docs/ops/cert-ready.config.json', 'docs/ops/fleet/projects.json',
  'docs/ops/owner-channel/', 'docs/ops/outbound-reviewed/', 'docs/ops/b4-fixtures/'];

const ROOT_CONTRACT = ['agents.md', 'claude.md', 'protocol-manifest.json', 'validate-protocol.ps1', 'test-protocol.ps1',
  'setup-ai-protocol.ps1'];

const lower = s => s.toLowerCase();
const ext = p => { const b = p.slice(p.lastIndexOf('/') + 1); const i = b.lastIndexOf('.'); return i > 0 ? lower(b.slice(i)) : ''; };
const under = (p, prefix) => lower(p).startsWith(lower(prefix));
const isExec = p => EXEC_EXT.includes(ext(p));

function advisoryEntry(p) {
  const lp = lower(p);
  for (const [entry, why] of ADVISORY_OPS) {
    const le = lower(entry);
    if (le.endsWith('/') ? lp.startsWith(le) : lp === le || lp === le.replace(/\.cjs$/, '.test.cjs')) return why;
  }
  return null;
}

// The table. `test(p, ctx)` receives a normalised repository-relative path (forward slashes, no `.`/`..` segments).
const TABLE = [
  { id: 'RC-A01-protocol-code', cls: 'A', source: 'PROTO-DEC-0136 item 1 (.ai/bin incl. hooks); 0038 item 1; 0169 item 1 (gate, hook, validator)', test: p => under(p, '.ai/bin/') },
  { id: 'RC-A02-kernel-layers', cls: 'A', source: 'PROTO-DEC-0136 item 1 (.ai/core/)', test: p => under(p, '.ai/core/') },
  { id: 'RC-A03-history-and-decisions', cls: 'A', source: 'PROTO-DEC-0136 item 1 (.ai/DECISIONS.md, docs/decisions/REGISTRY.md); 0169 item 1 (writes into history: .ai/ARCHIVE.md, registries)', test: p => ['.ai/DECISIONS.md', '.ai/ARCHIVE.md'].map(lower).includes(lower(p)) || under(p, 'docs/decisions/') },
  { id: 'RC-A04-root-contract', cls: 'A', source: 'PROTO-DEC-0136 item 1 (AGENTS.md, CLAUDE.md, protocol-manifest.json, the three .ps1 entry points)', test: p => ROOT_CONTRACT.includes(lower(p)) },
  { id: 'RC-A05-git-attributes-and-ignore', cls: 'A', source: 'PROTO-DEC-0136 item 1 (.gitattributes; secrets, data loss and history: what enters Git); validator CM-41', test: p => ['.gitattributes', '.gitignore'].includes(lower(p.slice(p.lastIndexOf('/') + 1))) },
  { id: 'RC-A06-client-hooks-and-operator-rules', cls: 'A', source: 'PROTO-DEC-0136 item 1 (.claude/); validator protected list .ai/bin/validator/gate-structure.cjs:344 (.github/, .codex/); .kilo operator rules (0136 item 1: a mechanism able to weaken a Class A control)', test: p => ['.claude/', '.codex/', '.github/', '.kilo/'].some(x => under(p, x)) },
  { id: 'RC-A07-tests', cls: 'A', source: 'PROTO-DEC-0136 item 1 (tests that check these mechanisms); validator protected list (tests/)', test: p => under(p, 'tests/') },
  { id: 'RC-A08-templates', cls: 'A', source: 'validator protected list (templates/); installed into every project', test: p => under(p, 'templates/') },
  { id: 'RC-B01-session-record', cls: 'B', source: 'the gate excludes a session\'s own records from the changed set (.ai/bin/validator/gate-structure.cjs:337-339); interpretation: a journal entry is not a change of a mechanism', test: p => lower(p) === lower('.ai/TASK.md') || /^\.ai\/worklog\/[^/]+\.md$/i.test(p) },
  { id: 'RC-A09-manifest-owned', cls: 'A', source: 'protocol-manifest.json is the definition of what the protocol owns (DEC-0013); 0136 item 1', test: (p, ctx) => ctx.manifest.has(lower(p)) },
  { id: 'RC-A10-protocol-state', cls: 'A', source: 'PROTO-DEC-0038 item 1 (anything under .ai/)', test: p => under(p, '.ai/') },
  { id: 'RC-A11-kernel-specs', cls: 'A', source: 'kernel schemas shipped by the manifest (docs/specs/)', test: p => under(p, 'docs/specs/') },
  { id: 'RC-A12-launch-and-channel-data', cls: 'A', source: 'PROTO-DEC-0169 item 1 (controls a launch: ladder, cert-ready config, fleet registry; owner channel; dispatch fixtures)', test: p => OPS_CONTROL_DATA.some(x => (x.endsWith('/') ? under(p, x) : lower(p) === x)) },
  { id: 'RC-A13-patch-to-apply', cls: 'A', source: 'a patch file is a future change of whatever it patches; doubt means Class A (0136 item 4)', test: p => PATCH_EXT.includes(ext(p)) },
  { id: 'RC-B02-advisory-ops-tool', cls: 'B', source: 'PROTO-DEC-0169 item 2 (advisory WARN-class check: Class B); the evidence per tool is in ADVISORY_OPS', test: p => advisoryEntry(p) !== null, why: p => advisoryEntry(p) },
  { id: 'RC-B03-research-tool', cls: 'B', source: 'PROTO-DEC-0136 item 2 (research tools)', test: p => under(p, 'docs/product/') && /\/tools\//i.test(p) },
  { id: 'RC-A14-ops-tool', cls: 'A', source: 'PROTO-DEC-0169 item 1: docs/ops code holds launchers, gates, the owner channel, keys and archive writers; not shown advisory, doubt means Class A (0136 item 4)', test: p => under(p, 'docs/ops/') && isExec(p) },
  { id: 'RC-A15-root-tools', cls: 'A', source: 'tools/ holds the cleanup movers and the .ai/bin patch applier (P-68..P-72): data and history; 0169 item 1', test: p => under(p, 'tools/') },
  { id: 'RC-A16-executable', cls: 'A', source: 'validator light path: executable extensions are protected (.ai/bin/validator/gate-structure.cjs:346)', test: p => isExec(p) },
  { id: 'RC-B04-document', cls: 'B', source: 'PROTO-DEC-0136 item 2 (documents, reports, CORE-ARCH drafts, research)', test: p => DOC_EXT.includes(ext(p)) || lower(p) === 'license' },
  { id: 'RC-B05-docs-data', cls: 'B', source: 'PROTO-DEC-0136 items 2-3 (records and data under docs/)', test: p => under(p, 'docs/') && DATA_EXT.includes(ext(p)) },
  { id: 'RC-B06-editor-config', cls: 'B', source: 'validator light path config allow-list (.editorconfig)', test: p => lower(p) === '.editorconfig' },
];

// Change kinds of a PRE declaration (closed). A-kinds are the categories of 0136 item 1 (second bullet) and 0169 item 1.
const KINDS = {
  docs: 'B', report: 'B', research: 'B', implementation: 'B', advisory: 'B',
  gate: 'A', hook: 'A', validator: 'A', 'history-writer': 'A', 'launch-control': 'A', security: 'A', secrets: 'A',
  'merge-rights': 'A', 'data-loss': 'A', authority: 'A', 'approval-meaning': 'A', 'canonical-rule': 'A',
  'weakens-control': 'A', 'advisory-to-blocking': 'A',
};

// A repository-relative path that the table can read: forward slashes, no empty, `.` or `..` segment, no drive or
// root, no NUL/control, no Windows alias form (trailing dot or space, ADS colon, 8.3 tilde-digit). Anything else is
// `invalid-path` (class A): such a string names a file the table cannot place.
function normalisePath(input) {
  if (typeof input !== 'string') return { ok: false, reason: 'invalid-path:not-a-string' };
  if (/[\p{Cs}\p{Cf}]/u.test(input)) return {ok:false,reason:'invalid-path:unicode-identity'};
  let p = input.replace(/\\/g, '/');
  while (p.startsWith('./')) p = p.slice(2);
  if (p === '' || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return { ok: false, reason: 'invalid-path:absolute-or-empty' };
  if (/[\u0000-\u001f\u007f]/.test(p)) return { ok: false, reason: 'invalid-path:control-character' };
  const segments = p.split('/');
  for (const s of segments) {
    if (s === '' || s === '.' || s === '..') return { ok: false, reason: 'invalid-path:dot-or-empty-segment' };
    if (/[. ]$/.test(s)) return { ok: false, reason: 'invalid-path:trailing-dot-or-space' };
    if (s.includes(':')) return { ok: false, reason: 'invalid-path:colon' };
    if (/~\d/.test(s)) return { ok: false, reason: 'invalid-path:short-name-form' };
    const problem = pathSafe.segmentProblem(s);
    if (problem) return {ok:false,reason:`invalid-path:${problem[0]}`};
  }
  return { ok: true, path: segments.join('/') };
}

function classifyPath(input, ctx) {
  if (ctx.manifestError) return { path: String(input), cls: 'A', rule: 'RC-A00-manifest-error', reason: ctx.manifestError };
  const n = normalisePath(input);
  if (!n.ok) return { path: String(input), cls: 'A', rule: 'RC-A00-invalid-path', reason: n.reason };
  for (const row of TABLE) {
    if (row.test(n.path, ctx)) return { path: n.path, cls: row.cls, rule: row.id, reason: row.why ? row.why(n.path) : row.source };
  }
  return { path: n.path, cls: 'A', rule: 'RC-A99-unknown-path', reason: 'unknown-path' };
}

// A wildcard B is proved by a closed subset grammar, never by finite probes.
// Domain: valid repository paths. B patterns have a fixed directory, one name
// segment (star/question only), and a fixed B extension. All other languages A.
const A_PREFIXES = ['.ai/', '.claude/', '.codex/', '.github/', '.kilo/', 'tests/', 'templates/', 'tools/',
  'docs/decisions/', 'docs/specs/', ...OPS_CONTROL_DATA.filter(p => p.endsWith('/'))];
const A_FILES = [...ROOT_CONTRACT, ...OPS_CONTROL_DATA.filter(p => !p.endsWith('/')), '.gitignore', '.gitattributes'];
const GLOB_CHARS = /[*?[\]{}]/;
function globRegex(entry) {
  let re = '';
  for (let i = 0; i < entry.length; i++) {
    const c = entry[i];
    if (c === '*' && entry[i + 1] === '*') { re += entry[i + 2] === '/' ? '(?:.*/)?' : '.*'; i += entry[i + 2] === '/' ? 2 : 1; }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + re + '$', 'i');
}
function classifyGlob(entry, ctx) {
  const shape = entry.replace(/\\/g, '/').replace(/^\.\//, '');
  const re = globRegex(shape);
  const a = reason => ({ path: entry, cls: 'A', rule: 'RC-A00-wildcard-unproved', reason });
  if (re.test('docs/decisions/REGISTRY.md')) return a('wildcard can cover docs/decisions/REGISTRY.md');
  // Exact protected names and owned paths are actual witnesses, not a proof of B.
  for (const f of [...A_FILES, ...ctx.manifest]) if (re.test(f) && classifyPath(f, ctx).cls === 'A') return a('wildcard can cover ' + f);
  const slash = shape.lastIndexOf('/');
  const dir = shape.slice(0, slash + 1); const name = shape.slice(slash + 1);
  if (/[*?]/.test(dir) || shape.includes('**')) return a('unproved directory wildcard (may cover docs/decisions/ or another A region)');
  if (/[[\]{}]/.test(shape) || !/^[a-z0-9_.?* -]+$/i.test(name)) return a('outside closed wildcard grammar');
  const n = normalisePath(shape.replace(/[*?]/g, 'x'));
  if (!n.ok) return a(n.reason);
  const suffix = ext(name);
  if (!DOC_EXT.includes(suffix) && !(under(dir, 'docs/') && DATA_EXT.includes(suffix))) return a('no fixed B extension');
  // A fixed extension excludes executable/patch files and git control basenames.
  // Fixed directory excludes every protected prefix, except the bounded journal grammar.
  const journal = lower(dir) === '.ai/worklog/' && suffix === '.md';
  if (!journal && A_PREFIXES.some(pre => under(dir, pre))) return a('fixed directory is an A region');
  const r = classifyPath(n.path, ctx);
  if (r.cls !== 'B') return a('fixed region is not B');
  return { path: entry, cls: 'B', rule: r.rule, reason: 'closed B language: fixed directory and extension, single name segment, no protected/owned intersection' };
}

function classifyEntry(entry, ctx) {
  return GLOB_CHARS.test(entry) ? classifyGlob(entry, ctx) : classifyPath(entry, ctx);
}

// Diff input lines (closed set of forms): `git diff --raw` (`:<mode> <mode> <sha> <sha> <status>\t<path>[\t<path>]`),
// `git diff --name-status` (`<status>\t<path>[\t<path>]`) or a plain path. A rename or copy contributes BOTH paths;
// a symbolic link (mode 120000) or a submodule (160000) on either side is class A.
function parseDiffLines(text) {
  const out = [];
  for (const raw of text.split(/\r?\n/)) {
    if (raw.trim() === '') continue;
    let m = /^:(\d{6}) (\d{6}) [0-9a-f]+\.{0,3} [0-9a-f]+\.{0,3} ([ACDMRTUX])\d{0,3}\t([^\t]+)(?:\t([^\t]+))?$/.exec(raw);
    if (m) {
      const special = [m[1], m[2]].some(mode => mode === '120000' || mode === '160000');
      for (const p of [m[4], m[5]].filter(Boolean)) out.push({ path: p, special });
      continue;
    }
    m = /^([ACDMRTUX])\d{0,3}\t([^\t]+)(?:\t([^\t]+))?$/.exec(raw);
    if (m) { for (const p of [m[2], m[3]].filter(Boolean)) out.push({ path: p, special: false }); continue; }
    if (raw.includes('\t')) out.push({ path: raw, special: false, malformed: true }); else out.push({ path: raw, special: false });
  }
  return out;
}

function classifyDiffItems(items, ctx) {
  return items.map(it => {
    if (it.malformed) return { path: it.path, cls: 'A', rule: 'RC-A00-invalid-path', reason: 'invalid-path:unparsed-diff-line' };
    const r = classifyPath(it.path, ctx);
    if (it.special) return { ...r, cls: 'A', rule: 'RC-A00-link-or-submodule', reason: 'symbolic link or submodule in the diff' };
    return r;
  });
}

const maxClass = classes => (classes.includes('A') ? 'A' : 'B');

function summarise(stage, entries, kinds = []) {
  const kindResults = kinds.map(k => (Object.prototype.hasOwnProperty.call(KINDS, k)
    ? { kind: k, cls: KINDS[k], rule: `KIND-${k}` } : { kind: k, cls: 'A', rule: 'KIND-unknown', reason: 'unknown-kind' }));
  let cls;
  let decidedBy;
  if (entries.length === 0) {
    cls = 'A';
    decidedBy = { rule: 'RC-A98-empty', reason: stage === 'PRE' ? 'no-declared-write-set' : 'no-changed-path' };
  } else {
    cls = maxClass([...entries.map(e => e.cls), ...kindResults.map(k => k.cls)]);
    const first = entries.find(e => e.cls === cls) || kindResults.find(k => k.cls === cls);
    decidedBy = first ? { rule: first.rule, path: first.path, kind: first.kind, reason: first.reason } : null;
  }
  return { schema: 'risk-class/1', stage, cls, decidedBy, counts: { paths: entries.length, a: entries.filter(e => e.cls === 'A').length, b: entries.filter(e => e.cls === 'B').length }, kinds: kindResults, paths: entries };
}

function loadManifest(repo, rev) {
  const set = new Set();
  const failed = reason => ({ set, source: 'unknown', error: reason });
  let text;
  if (rev) {
    // A valid revision with no manifest is distinct from an unknown revision.
    if (gitLines(repo, ['rev-parse', '--verify', `${rev}^{commit}`]) === null) return failed('manifest-revision-unreadable');
    const names = gitLines(repo, ['ls-tree', '--name-only', rev, '--', 'protocol-manifest.json']);
    if (names === null) return failed('manifest-tree-unreadable');
    if (names.trim() === '') return { set, source: 'absent' };
    text = gitLines(repo, ['show', `${rev}:protocol-manifest.json`]);
    if (text === null) return failed('manifest-unreadable');
  } else {
    const file = path.join(path.resolve(repo), 'protocol-manifest.json');
    const g = guardInput(file);
    if (!g.ok) return failed(`manifest-path:${g.reason}`);
    if (!g.exists) return { set, source: 'absent' };
    try { text = readText(file); } catch (e) { return failed(`manifest-unreadable:${e.code || e.message}`); }
  }
  let m;
  try { m = JSON.parse(text); } catch { return failed('manifest-unparsable'); }
  if (duplicateJsonKeys(text)) return failed('manifest-duplicate-key');
  if (!m || typeof m !== 'object' || Array.isArray(m)) return failed('manifest-not-object');
  for (const key of ['managed', 'source', 'tests', 'integration', 'state']) {
    if (m[key] === undefined) continue;
    if (!Array.isArray(m[key])) return failed(`manifest-invalid-list:${key}`);
    for (const p of m[key]) {
      const n = normalisePath(p);
      if (!n.ok) return failed(`manifest-invalid-path:${key}`);
      set.add(lower(key === 'state' ? `.ai/${n.path}` : n.path));
    }
  }
  return { set, source: rev ? `${rev}:protocol-manifest.json` : 'protocol-manifest.json' };
}

// A launch file declares its write-set on a line `Write-set:` followed by backtick-quoted entries, continued on the
// next non-empty lines until an empty line. No such line: the write-set is unknown (class A, no-declared-write-set).
function parseLaunchWriteSet(text) {
  const lines = text.split(/\r?\n/);
  const mask = textSafe.maskMarkdown(text).lines;
  const starts = lines.flatMap((l,i) => !mask[i]?.masked && /^\s*(?:[-*]\s*)?\**write-set\**\s*:/i.test(l) ? [i] : []);
  const start = starts.length === 1 ? starts[0] : -1;
  if (start < 0) return [];
  const entries = [];
  for (let i = start; i < lines.length; i += 1) {
    if (i > start && lines[i].trim() === '') break;
    if (mask[i].masked) return [];
    for (const m of lines[i].matchAll(/`([^`]+)`/g)) entries.push(m[1].trim());
  }
  return entries;
}

function gitLines(repo, args) {
  const r = spawnSync('git', ['-C', repo, '-c', 'core.quotepath=off', ...args], { windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) return null;
  try { return decodeText(r.stdout); } catch { return null; }
}

function postFromGit(repo, base, head) {
  if (!/^[0-9a-f]{40}$/i.test(base) || (head && !/^[0-9a-f]{40}$/i.test(head))) return { error: 'base and head must be full 40-hex commit ids' };
  for (const rev of [base, head].filter(Boolean)) if (gitLines(repo, ['rev-parse', '--verify', `${rev}^{commit}`]) === null) return { error: `unknown commit ${rev}` };
  const diff = gitLines(repo, ['diff', '--raw', '-M', '--no-abbrev', base, ...(head ? [head] : [])]);
  if (diff === null) return { error: 'git diff failed' };
  const items = parseDiffLines(diff);
  if (!head) {
    // Directory enumeration lists junctions as entries without descending them,
    // including empty junctions which Git's file enumeration otherwise omits.
    const links = []; const plain = [];
    const walk = dir => {
      for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
        if (ent.name === '.git') continue;
        const p = path.join(dir, ent.name); const rel = path.relative(repo,p).split(path.sep).join('/');
        const g = pathSafe.realInside(path.resolve(repo), p, { refuseHardlinks:true });
        if (!g.ok) { links.push({path:rel,special:true}); continue; }
        if (ent.isDirectory()) walk(p);
        else if (ent.isFile()) plain.push(rel);
      }
    };
    try { walk(path.resolve(repo)); } catch { return {error:'unreadable working tree'}; }
    items.push(...links);
    // Read only the index; Git must never enumerate a junction on our behalf.
    const trackedText = gitLines(repo, ['ls-files', '--cached']);
    if (trackedText === null) return {error:'unreadable Git index'};
    const tracked = new Set(trackedText.split('\n').filter(Boolean));
    const candidates = plain.filter(p => !tracked.has(p));
    // The ignore matcher consumes guarded path names, without filesystem traversal.
    if (candidates.length) {
      const ig = spawnSync('git',['-C',repo,'-c','core.quotepath=off','check-ignore','--stdin'],
        {input:Buffer.from(candidates.join('\n')+'\n'),windowsHide:true,maxBuffer:64*1024*1024});
      if (![0,1].includes(ig.status)) return {error:'unreadable ignore rules'};
      let ignored;
      try { ignored = new Set(decodeText(ig.stdout).split('\n').filter(Boolean)); } catch { return {error:'invalid ignore result'}; }
      for (const p of candidates) if (!ignored.has(p)) items.push({path:p,special:false});
    }
    for (const it of items) {
      const g = pathSafe.realInside(path.resolve(repo),it.path,{refuseHardlinks:true});
      if (!g.ok) it.special = true;
    }
  }
  return { items };
}

function parseArgs(argv) {
  const o = { cmd: argv[0], paths: [], kinds: [], repo: process.cwd(), json: false };
  for (let i = 1; i < argv.length; i += 1) {
    const a = argv[i];
    const need = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); i += 1; return argv[i]; };
    if (a === '--path') o.paths.push(need());
    else if (a === '--paths-file') o.pathsFile = need();
    else if (a === '--launch-file') o.launchFile = need();
    else if (a === '--kind') o.kinds.push(need());
    else if (a === '--repo') o.repo = need();
    else if (a === '--base') o.base = need();
    else if (a === '--head') o.head = need();
    else if (a === '--diff-file') o.diffFile = need();
    else if (a === '--manifest-rev') o.manifestRev = need();
    else if (a === '--pre') o.pre = need();
    else if (a === '--json') o.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

function print(result, json) {
  if (json) { process.stdout.write(`${JSON.stringify(result)}\n`); return; }
  for (const k of result.kinds || []) process.stdout.write(`KIND ${k.cls} ${k.rule} ${k.kind}\n`);
  for (const e of result.paths) process.stdout.write(`PATH ${e.cls} ${e.rule} ${e.path}\n`);
  const by = result.decidedBy ? ` decided-by=${result.decidedBy.rule}${result.decidedBy.path ? `:${result.decidedBy.path}` : ''}${result.decidedBy.reason ? `:${result.decidedBy.reason}` : ''}` : '';
  process.stdout.write(`CLASS ${result.stage} ${result.cls} paths=${result.counts.paths} a=${result.counts.a} b=${result.counts.b}${by}\n`);
}

function main(argv) {
  if (argv.length === 1 && argv[0] === '--table') {
    for (const r of TABLE) process.stdout.write(`${r.id}\t${r.cls}\t${r.source}\n`);
    process.stdout.write('RC-A99-unknown-path\tA\tno row matched: doubt means Class A (0136 item 4)\n');
    for (const [k, c] of Object.entries(KINDS)) process.stdout.write(`KIND-${k}\t${c}\n`);
    return 0;
  }
  let o;
  try { o = parseArgs(argv); } catch (error) { process.stderr.write(`risk-class: ${error.message}\n`); return 2; }
  if (!['pre', 'post', 'effective'].includes(o.cmd)) {
    process.stderr.write('usage: risk-class.cjs pre|post|effective ... | --table (see the header of docs/ops/risk-class.cjs)\n');
    return 2;
  }
  const manifest = loadManifest(o.repo, o.manifestRev);
  const ctx = { manifest: manifest.set, manifestError: manifest.error };
  const unknown = reason => {
    const result = summarise(o.cmd === 'pre' ? 'PRE' : o.cmd === 'effective' ? 'EFFECTIVE' : 'POST',
      [{path:'input',cls:'A',rule:'RC-A00-unreadable',reason}]);
    result.unknown = true; result.manifest = manifest.source;
    print(result,o.json); return 2;
  };
  if (manifest.error) return unknown(manifest.error);
  if (o.cmd === 'pre') {
    let entries = [...o.paths];
    try {
      if (o.pathsFile) entries.push(...readText(o.pathsFile).split(/\r?\n/).map(s => s.trim()).filter(Boolean));
      if (o.launchFile) entries.push(...parseLaunchWriteSet(readText(o.launchFile)));
    } catch (error) { return unknown(error.code || error.message); }
    if (!o.pathsFile && !o.launchFile && o.paths.length === 0) { process.stderr.write('risk-class: pre needs --path, --paths-file or --launch-file\n'); return 2; }
    entries = [...new Set(entries)];
    const result = summarise('PRE', entries.map(e => classifyEntry(e, ctx)), o.kinds);
    result.manifest = manifest.source;
    print(result, o.json);
    return 0;
  }
  let items;
  if (o.diffFile) {
    try { items = parseDiffLines(readText(o.diffFile)); } catch (error) { return unknown(error.code || error.message); }
  } else if (o.base) {
    const g = postFromGit(o.repo, o.base, o.head);
    if (g.error) return unknown(g.error);
    items = g.items;
  } else { process.stderr.write('risk-class: post needs --base or --diff-file\n'); return 2; }
  const post = summarise('POST', classifyDiffItems(items, ctx));
  post.manifest = manifest.source;
  if (o.cmd === 'post') { print(post, o.json); return 0; }
  if (o.pre !== 'A' && o.pre !== 'B') { process.stderr.write('risk-class: effective needs --pre A or --pre B\n'); return 2; }
  const effective = maxClass([o.pre, post.cls]);
  const raised = o.pre === 'B' && post.cls === 'A';
  const result = { schema: 'risk-class/1', stage: 'EFFECTIVE', pre: o.pre, post: post.cls, cls: effective, raised, action: raised ? 'stop before the merge: complete the Class A steps (PROTO-DEC-0136 item 4)' : 'none', decidedBy: post.decidedBy, counts: post.counts, paths: post.paths, kinds: [] };
  if (o.json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else {
    print({ ...post, stage: 'POST' }, false);
    process.stdout.write(`EFFECTIVE ${effective} pre=${o.pre} post=${post.cls} raised=${raised}${raised ? ' STOP-BEFORE-MERGE' : ''}\n`);
  }
  return raised ? 1 : 0;
}

module.exports = { TABLE, KINDS, ADVISORY_OPS, normalisePath, classifyPath, classifyGlob, classifyEntry, parseDiffLines, classifyDiffItems, summarise, loadManifest, parseLaunchWriteSet };

if (require.main === module) process.exitCode = main(process.argv.slice(2));

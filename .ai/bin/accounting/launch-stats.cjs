'use strict';
// launch-stats: per-model statistics from the launch-record/1 journal (PROTO-DEC-0143 item 3: advisory only; never
// Evidence, never a gate input, never writes into .ai/ or docs/ops/model-ladder.json). Honesty rules of
// docs/product/launch-records/launches/LAUNCH-RECORD-EXT.md: a field that is unknown, null or absent is skipped, never imputed; a backfilled record counts
// only for fields whose confidence is exact or derived; a group below --min-n gets no median.
//   node .ai/bin/accounting/launch-stats.cjs report [--journal f] [--include-pending | --pending DIR] [--by client|tuple|role|variant|packet]
//        [--min-n 5] [--out file] [--now ISO]
//   node .ai/bin/accounting/launch-stats.cjs compare --by packet [the same input/output options]
//   node .ai/bin/accounting/launch-stats.cjs due [--journal f] [--include-pending] [--stats-dir d] [--every-records 30]
//        [--every-days 7] [--now ISO]
// Exit: 0 ok (due always exits 0: the signal is the text), 2 usage or unreadable input.
const fs = require('node:fs');
const path = require('node:path');
const pathSafe = require('../lib/path-safe.cjs');

const BASE = path.resolve(__dirname, '..', '..', '..', 'docs', 'product', 'launch-records', 'launches');
const DEFAULT_JOURNAL = path.join(BASE, 'LAUNCHES.jsonl');
const DEFAULT_PENDING = path.join(BASE, 'pending');
const DEFAULT_STATS_DIR = path.join(BASE, 'stats');
const EVERY_RECORDS = 30;
const EVERY_DAYS = 7;
const MARKER = /<!-- stats-report launches=(\d+) generated=(\S+) -->/;
const USABLE = new Set(['exact', 'derived']);
const FORBIDDEN_OUT = [/[\\/]\.ai[\\/]/, /model-ladder\.json$/i];

// The output path is judged on the paths it really names, never on its spelling. A relative path is resolved against the
// current directory AND against the main root, each base on its own; a path that is protected under either base (an .ai segment, the ladder file, or a
// real location inside <main root>/.ai after links are followed) is refused, so a path that is harmless from one base and protected from the other is
// never written. The report is written where the current directory puts it. An absolute path has only its own resolution.
const LADDER_FILE = /model-ladder\.json$/i;
function realOfExisting(abs) {
  // the real path of the nearest existing ancestor, plus the part that does not exist yet (a link inside the path is followed)
  let probe = abs; const rest = [];
  for (;;) {
    try { return path.join(fs.realpathSync.native(probe), ...rest.reverse()); } catch { /* not there yet */ }
    const up = path.dirname(probe);
    if (up === probe) return abs;
    rest.push(path.basename(probe)); probe = up;
  }
}
const lowerPath = p => path.resolve(p).replace(/\\/g, '/').toLowerCase();
// A colon after the drive prefix names an NTFS alternate data stream (model-ladder.json::$DATA, file:report) that opens the file it hangs on: refused on every platform.
const hasStreamName = abs => path.resolve(abs).replace(/^[A-Za-z]:/, '').includes(':');
function protectedReason(abs, aiRoot) {
  for (const candidate of [abs, realOfExisting(abs)]) {
    const norm = lowerPath(candidate);
    if (norm.split('/').includes('.ai')) return 'an .ai directory';
    if (LADDER_FILE.test(norm)) return 'model-ladder.json';
    if (aiRoot && (norm === aiRoot || norm.startsWith(`${aiRoot}/`))) return 'the .ai directory of the main root';
  }
  return null;
}
// The names of the target itself, judged by the shared path guard (never by a private check): from the nearest existing directory down, no link, no hard link
// (an existing target with other names could be one of them: a file of .ai or the ladder under another name), no stream name, no reserved name, no 8.3 alias.
// -> null, or the reason text. The report is then written by writeAtomicGuarded (the name is replaced, never written through).
function guardAncestor(abs) {
  let probe = path.resolve(abs);
  for (;;) {
    const up = path.dirname(probe);
    if (up === probe) return null;
    probe = up;
    try { if (fs.statSync(probe).isDirectory()) return { spelled: probe, real: fs.realpathSync.native(probe) }; } catch { /* look higher */ }
  }
}
const guardRoot = abs => { const a = guardAncestor(abs); return a ? a.real : null; };
function guardReason(abs) {
  const root = guardRoot(abs);
  if (!root) return 'the output has no existing parent directory to be judged against';
  const g = pathSafe.realInside(root, path.resolve(abs), { refuseHardlinks: true });
  return g.ok ? null : `the shared path guard refused it (${g.reason}: ${g.detail})`;
}
// -> null when the path may be written, else the reason text (the caller refuses with exit 2)
function outPathProblem(out, ctx = {}) {
  if (typeof out !== 'string' || !out.trim() || out.includes('\0')) return 'the output path is empty or malformed';
  // Network-share (two leading separators and a host), device (two leading separators, then ? or .) and drive-relative (a drive letter with no separator after
  // it, or one leading separator) spellings are refused before the file system is touched: a network share is not a
  // supported destination for a local advisory report (the owner would have to decide it), and a drive-relative path depends on the current drive.
  const lexical = pathSafe.lexicalProblem(out);
  if (lexical) return `the shared path guard refuses the spelling (${lexical[0]}: ${lexical[1]})`;
  if (hasStreamName(out)) return 'its name holds a colon after the drive (an alternate data stream)';
  const cwd = path.resolve(ctx.cwd || process.cwd());
  let root = null;
  try { root = path.resolve(ctx.mainRoot || require('../repo-paths.cjs').mainRoot()); } catch { /* the current directory is the only base */ }
  const aiRoot = root ? lowerPath(realOfExisting(path.join(root, '.ai'))) : null;
  const bases = [['the current directory', cwd]];
  if (root && !path.isAbsolute(out) && lowerPath(root) !== lowerPath(cwd)) bases.push(['the main root', root]);
  for (const [name, base] of bases) {
    const why = protectedReason(path.resolve(base, out), aiRoot);
    if (why) return `${path.isAbsolute(out) ? 'it' : `resolved against ${name}, it`} is inside ${why}${bases.length > 1 ? ` (relative paths are checked against ${bases.map(b => b[0]).join(' and ')})` : ''}`;
  }
  // the path that will be written is the one the current directory gives; its own names are judged by the shared guard
  return guardReason(path.resolve(cwd, out));
}

// The one plan of a report: the spelled path is judged ONCE and the answer is pinned: the root below which everything is written is the REAL path of the nearest
// existing directory at the time of the judgement (a path string that is resolved again later could by then lead somewhere else), and the protected
// location is the real path of <main root>/.ai of that time. -> { problem } or { target, root, missing, aiRoot }
function mainRootOf(ctx = {}) {
  try { return path.resolve(ctx.mainRoot || require('../repo-paths.cjs').mainRoot()); } catch { return null; }
}
const aiRootAt = root => (root ? lowerPath(realOfExisting(path.join(root, '.ai'))) : null);
const aiRootOf = ctx => aiRootAt(mainRootOf(ctx));
// The protected locations NOW: the real .ai directory of the main root as of the judgement AND as of this moment (a link put at .ai after the judgement
// makes the old real path stale: .ai swapped for a junction to the output directory). Judged again at every step that creates something.
function protectedNow(abs, plan) {
  const roots = [plan.aiRoot, aiRootAt(plan.mainRoot)].filter(Boolean);
  for (const aiRoot of roots) { const why = protectedReason(abs, aiRoot); if (why) return why; }
  return protectedReason(abs, null);
}
function outPlan(out, ctx = {}) {
  const problem = outPathProblem(out, ctx);
  if (problem) return { problem };
  const target = path.resolve(ctx.cwd || process.cwd(), out); // the same base outPathProblem judged
  const anc = guardAncestor(target);
  if (!anc) return { problem: 'the output has no existing parent directory to be judged against' };
  const missing = path.relative(anc.spelled, path.dirname(target)).split(path.sep).filter(Boolean);
  const mainRoot = mainRootOf(ctx);
  return { target, root: anc.real, missing, mainRoot, aiRoot: aiRootAt(mainRoot) };
}
// Writes the report through the shared guarded writer only (path-safe mkdirGuarded and writeAtomicGuarded: no private second guard). The output path is judged again, with
// the protected location read afresh each time (protectedNow), at every step that creates something: before each missing directory (mkdirGuarded: no link at
// any level below the pinned root, a directory that was swapped in is refused) and, last, on the REAL target by the shared writer's onTempWritten seam, the
// last step before the temp file is renamed onto the target, and once more on the real target after the rename (a refusal there is reported, never ok).
// The remaining window is exactly the documented limit of the shared writer (what writeAtomicGuarded does not guarantee): between the last judgement and the
// rename. The open temp file pins the target's own directory chain on NTFS (measured there only), on POSIX the window is narrowed, not closed; and the pin
// protects the directory written to, NOT the .ai directory of the main root: a link put at .ai in that instant is caught by the judgement after the rename,
// which then reports the file as reached into .ai (ok: false, no silent success), it is not prevented.
// -> { ok: true } or { ok: false, reason }
function writeGuarded(plan, bytes) {
  const { root, missing } = plan;
  let dir = root;
  for (const seg of missing) {
    dir = path.join(dir, seg);
    const why = protectedNow(dir, plan);
    if (why) return { ok: false, reason: `the directory to create is inside ${why}` };
    const made = pathSafe.mkdirGuarded(root, dir);
    if (!made.ok) return { ok: false, reason: `${made.reason}: ${made.detail}` };
  }
  const real = path.join(dir, path.basename(plan.target));
  let blocked = null;
  const written = pathSafe.writeAtomicGuarded(real, bytes, {
    root,
    onTempWritten: ({ target }) => { const why = protectedNow(target, plan); if (why) { blocked = `the real target is inside ${why}`; throw new Error(blocked); } },
  });
  if (blocked) return { ok: false, reason: blocked };
  if (!written.ok) return { ok: false, reason: `${written.reason}: ${written.detail}` };
  const after = protectedNow(real, plan);
  if (after) return { ok: false, reason: `the report reached ${after} after the last judgement (a link was put into the path in that instant); it is reported, not undone` };
  return { ok: true };
}

function usage(msg) { process.stderr.write(`${msg}\n`); return 2; }

// The report is never written over one of its own inputs: the journal (--journal) or anything below the pending directory (--pending / --include-pending). The
// comparison is made on the real paths (links, hard links, letter case and the spelling of the directory do not matter) before anything is written; a path that
// cannot be judged counts as the input. -> the name of the input it hits, or null
function inputHit(out, o, deps = {}) {
  const cwd = path.resolve(deps.cwd || process.cwd());
  const target = path.resolve(cwd, out);
  const inputs = [['--journal', o.journal]];
  if (o.includePending) inputs.push(['--pending', o.pendingDir || DEFAULT_PENDING]);
  for (const [name, input] of inputs) if (pathSafe.sameFileOrNested(target, path.resolve(cwd, input))) return name;
  return null;
}

function readJsonl(file) {
  const out = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    try { out.push(JSON.parse(line)); } catch (e) { throw new Error(`${path.basename(file)}:${i + 1} invalid JSON`); }
  });
  return out;
}
function load(journal, includePending, pendingDir = DEFAULT_PENDING) {
  let recs = readJsonl(journal);
  if (includePending && fs.existsSync(pendingDir)) {
    for (const f of fs.readdirSync(pendingDir).filter(n => n.endsWith('.jsonl')).sort()) recs = recs.concat(readJsonl(path.join(pendingDir, f)));
  }
  return recs;
}

// A field of a record is usable when the record is not backfilled, or when its confidence for that field is exact/derived.
const usable = (rec, field) => rec.backfilled !== true || USABLE.has(rec.confidence && rec.confidence[field]);
const value = (rec, field, v) => (v === undefined || v === null || v === '' || !usable(rec, field) ? null : v);

// One launch = the launchId's full or started record, joined with its finished and review events.
function launches(recs) {
  const by = new Map();
  for (const r of recs) {
    if (!r || !r.launchId) continue;
    const l = by.get(r.launchId) || { id: r.launchId, reviews: [] };
    if (r.event === 'review') l.reviews.push(r);
    else if (r.event === 'finished') {
      // every finished line is kept (a usage backfill line must not hide the finished line that carries the exit code); the one with an exit code is THE fin
      (l.fins || (l.fins = [])).push(r);
      if (!l.fin || Object.hasOwn(r, 'exitCode')) l.fin = r;
    }
    else { l.start = r; }
    by.set(r.launchId, l);
  }
  return [...by.values()].filter(l => l.start);
}

function wallOf(l) {
  const s = l.start; const f = l.fin || {};
  if (typeof s.wallSeconds === 'number' && usable(s, 'wallSeconds')) return s.wallSeconds;
  if (typeof f.wallSeconds === 'number') return f.wallSeconds;
  // derive from times only when both are written exactly: a time with a *Note is approximate and is not used
  const end = f.endedAt || s.endedAt; const endNote = f.endedAtNote || s.endedAtNote;
  if (!s.startedAt || !end || s.startedAtNote || endNote || s.backfilled === true) return null;
  const sec = (Date.parse(end) - Date.parse(s.startedAt)) / 1000;
  return Number.isFinite(sec) && sec > 0 ? sec : null;
}
// The failure class of a launch: the first class that is present AND usable (confidence exact/derived on a backfilled record).
// An inferred, unknown or unrated class is skipped, so it neither defines "infra" nor hides a usable class from the other event record.
function failureClassOf(l) {
  for (const rec of [l.start, l.fin]) {
    if (!rec) continue;
    const c = value(rec, 'failureClass', rec.failureClass);
    if (c) return c;
  }
  return null;
}
function exitOf(l) {
  const s = l.start; const f = l.fin || {};
  for (const [rec, v] of [[f, f.exitCode], [s, s.exitCode]]) {
    if (typeof v === 'number' && usable(rec, 'exitCode')) return v;
  }
  return null;
}

function numberFromTokens(tokens) {
  if (typeof tokens === 'number' && tokens >= 0) return tokens;
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens)) return null;
  if (typeof tokens.source === 'string') return Number.isSafeInteger(tokens.total) && tokens.total >= 0 ? tokens.total : null;
  for (const key of ['total', 'totalTokens', 'total_tokens']) if (typeof tokens[key] === 'number' && tokens[key] >= 0) return tokens[key];
  const parts = ['input', 'output', 'inputTokens', 'outputTokens', 'input_tokens', 'output_tokens'].filter(k => typeof tokens[k] === 'number' && tokens[k] >= 0);
  if (!parts.length) return null;
  return parts.reduce((sum, key) => sum + tokens[key], 0);
}
function tokensOf(l) {
  for (const rec of [l.fin, ...(l.fins || []), l.start]) {
    if (!rec || !usable(rec, 'tokens')) continue;
    const n = numberFromTokens(rec.tokens);
    if (n !== null) return n;
  }
  return null;
}
// ---- tokens and cost (cost-record) ----
// A launch counts as "tokens known" when a usable record carries a number of tokens (the total the client stated, else the parts); as "cost known" when a usable
// record carries a priced or a flat-fee (subscription) cost; anything else is "cost unknown" (never imputed, never zero). A backfilled line counts only for the
// fields whose confidence is exact or derived (an unknown cost of the backfill is therefore unknown here as well).
function usageRecs(l) { return [l.fin, ...(l.fins || []), l.start].filter(Boolean); }
function costOf(l) {
  let reported = null;
  for (const rec of usageRecs(l)) {
    const c = rec.cost;
    if (c && typeof c === 'object' && typeof c.clientReportedUsd === 'number' && reported === null) reported = c.clientReportedUsd;
    if (!usable(rec, 'cost')) continue;
    if (typeof c === 'number' && c >= 0) return { basis: 'priced', usd: c, reported };
    if (c && typeof c === 'object' && c.basis === 'priced' && typeof c.usd === 'number') return { basis: 'priced', usd: c.usd, reported };
    if (c && typeof c === 'object' && c.basis === 'subscription') return { basis: 'subscription', usd: null, reported };
  }
  return { basis: null, usd: null, reported };
}
function usageStats(group) {
  const u = { launches: group.length, tokensKnown: 0, tokensSum: 0, priced: 0, subscription: 0, costUnknown: 0, pricedUsd: 0, reportedUsd: 0 };
  for (const l of group) {
    const t = tokensOf(l);
    if (t !== null) { u.tokensKnown++; u.tokensSum += t; }
    const c = costOf(l);
    if (c.basis === 'priced') { u.priced++; u.pricedUsd += c.usd; } else if (c.basis === 'subscription') u.subscription++; else u.costUnknown++;
    if (c.reported !== null && c.basis !== 'priced') u.reportedUsd += c.reported;
  }
  return u;
}
const usd = x => (Math.round(x * 1e6) / 1e6).toString();
function findingsOf(l) {
  for (const rec of [...l.reviews].reverse().concat([l.fin, l.start])) {
    if (rec && Number.isInteger(rec.findingsCount) && rec.findingsCount >= 0 && usable(rec, 'findingsCount')) return rec.findingsCount;
  }
  return null;
}

const KEYS = {
  client: l => [value(l.start, 'client', l.start.tuple && l.start.tuple.client)],
  tuple: l => ['client', 'model', 'effort'].map(k => value(l.start, k, l.start.tuple && l.start.tuple[k])),
  role: l => [value(l.start, 'role', l.start.role)],
  variant: l => [value(l.start, 'variant', l.start.variant)],
  packet: l => [value(l.start, 'packetHash', l.start.packetHash), value(l.start, 'role', l.start.role), value(l.start, 'stage', l.start.stage), value(l.start, 'packetProfile', l.start.packetProfile)],
};
const KEYS_WIDTH = { client: 1, tuple: 3, role: 1, variant: 1, packet: 4 };
const INFRA = new Set(['INTERRUPTED', 'TRANSPORT', 'QUOTA', 'AUTH']);
const INTERRUPTED_CODES = new Set([3221225786, 137, 143, -1073741510, 130]);
const label = parts => parts.map(p => p === null ? '(unknown)' : p).join(' | ');

const pct = (a, b) => b === 0 ? 'n/a' : `${(100 * a / b).toFixed(0)}%`;
function median(xs) { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; }
function p90(xs) { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.ceil(0.9 * s.length) - 1)]; }
const num = x => (Math.round(x * 10) / 10).toString();

function summarize(group, minN) {
  const exits = group.map(exitOf).filter(x => x !== null);
  const ok = exits.filter(x => x === 0).length;
  const walls = group.filter(l => exitOf(l) === 0).map(wallOf).filter(x => x !== null);
  const fails = {};
  for (const l of group) { const c = failureClassOf(l); if (c && exitOf(l) !== 0) fails[c] = (fails[c] || 0) + 1; }
  const outcomes = {}; const rounds = [];
  for (const l of group) for (const r of l.reviews) {
    if (r.reviewOutcome) outcomes[r.reviewOutcome] = (outcomes[r.reviewOutcome] || 0) + 1;
    if (typeof r.reviewRounds === 'number') rounds.push(r.reviewRounds);
  }
  // Infrastructure failures (the process was killed, the transport or the quota or the credentials failed) say nothing about the MODEL.
  // They stay in "success" (every launch counts) and are removed from "success excl. infra" (the model's own record), so a killed run is not read as a bad model.
  let infra = 0;
  for (const l of group) {
    const x = exitOf(l);
    if (x === null || x === 0) continue;
    const c = failureClassOf(l);
    if (INFRA.has(c) || (!c && INTERRUPTED_CODES.has(x))) infra++;
  }
  const enough = walls.length >= minN;
  return {
    launches: group.length, exitKnown: exits.length, success: pct(ok, exits.length), infra, successExInfra: pct(ok, exits.length - infra),
    wallN: walls.length, wallMedian: enough ? num(median(walls)) : `n<${minN}`, wallP90: enough ? num(p90(walls)) : `n<${minN}`,
    fails: Object.entries(fails).sort().map(([k, v]) => `${k}:${v}`).join(' ') || '-',
    outcomes: Object.entries(outcomes).sort().map(([k, v]) => `${k}:${v}`).join(' ') || '-',
    rounds: rounds.length ? num(rounds.reduce((a, b) => a + b, 0) / rounds.length) : '-',
  };
}

function report(all, by, minN, nowIso, scope) {
  const rows = new Map();
  for (const l of all) { const k = label(KEYS[by](l)); (rows.get(k) || rows.set(k, []).get(k)).push(l); }
  const head = by === 'tuple' ? 'client | model | effort' : by === 'packet' ? 'packetHash | role | stage | profile' : by;
  const lines = [
    `<!-- stats-report launches=${all.length} generated=${nowIso} -->`,
    '# Launch statistics (advisory)', '',
    `Generated: ${nowIso} | launches: ${all.length} | scope: ${scope} | grouped by: ${by} | min n for a median: ${minN}`,
    'Advisory only (PROTO-DEC-0143 item 3): not Evidence, not a gate input. Unknown or null fields are skipped, never imputed;',
    'a backfilled record counts only for fields with confidence exact or derived (docs/product/launch-records/launches/LAUNCH-RECORD-EXT.md). "(unknown)" is a',
    'real bucket: it holds the launches whose field could not be read exactly.',
    `Next due: when launches >= ${all.length + EVERY_RECORDS} (${EVERY_RECORDS} more), or ${EVERY_DAYS} days after the generated time if at least one new launch exists`,
    'or before any decision that relies on these numbers. Check any time: node .ai/bin/accounting/launch-stats.cjs due', '',
    `| ${head} | launches | exit known | success | infra failures | success excl. infra | wall n | wall median s | wall p90 s | failures | review outcomes | avg review rounds | tokens known | tokens sum | cost known | priced USD | cost unknown |`,
    `|${'---|'.repeat(16 + KEYS_WIDTH[by])}`,
  ];
  for (const [k, g] of [...rows].sort((a, b) => a[0].localeCompare(b[0]))) {
    const s = summarize(g, minN);
    const u = usageStats(g);
    lines.push(`| ${k} | ${s.launches} | ${s.exitKnown} | ${s.success} | ${s.infra} | ${s.successExInfra} | ${s.wallN} | ${s.wallMedian} | ${s.wallP90} | ${s.fails} | ${s.outcomes} | ${s.rounds} | ${u.tokensKnown}/${u.launches} (${pct(u.tokensKnown, u.launches)}) | ${u.tokensKnown ? u.tokensSum : '-'} | ${u.priced + u.subscription}/${u.launches} (${pct(u.priced + u.subscription, u.launches)}) | ${u.priced ? usd(u.pricedUsd) : '-'} | ${u.costUnknown} |`);
  }
  lines.push(...usageBlock(all));
  return lines.join('\n') + '\n';
}

// Tokens and cost, always one line per client whatever the grouping above is (PROTO-DEC-0144/0145): coverage first, then the numbers.
function usageBlock(all) {
  const t = usageStats(all);
  const by = new Map();
  for (const l of all) { const k = label(KEYS.client(l)); (by.get(k) || by.set(k, []).get(k)).push(l); }
  const lines = ['', '## Tokens and cost by client', '',
    `Usage coverage: tokens known ${t.tokensKnown}/${t.launches} (${pct(t.tokensKnown, t.launches)}); cost known (priced or flat-fee subscription) ${t.priced + t.subscription}/${t.launches} (${pct(t.priced + t.subscription, t.launches)}); cost unknown ${t.costUnknown}.`,
    'priced = tokens x the price of the nearest price snapshot (an estimate at list price, not an invoice); subscription = a flat-fee client (no per-launch charge, USD not stated);',
    'unknown = no usable tokens or no price (never counted as 0). "client-reported" is the client\'s own cost number of launches that could not be priced (information only).', '',
    '| client | launches | tokens known | tokens coverage | tokens sum (incl. cached) | priced | subscription | cost unknown | priced USD | client-reported USD (unpriced) |', '|---|---|---|---|---|---|---|---|---|---|'];
  for (const [k, g] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) {
    const u = usageStats(g);
    lines.push(`| ${k} | ${u.launches} | ${u.tokensKnown} | ${pct(u.tokensKnown, u.launches)} | ${u.tokensKnown ? u.tokensSum : '-'} | ${u.priced} | ${u.subscription} | ${u.costUnknown} | ${u.priced ? usd(u.pricedUsd) : '-'} | ${u.reportedUsd ? usd(u.reportedUsd) : '-'} |`);
  }
  return lines;
}

function compare(all, by, nowIso, scope) {
  const rows = new Map();
  for (const launch of all) { const key = label(KEYS[by](launch)); (rows.get(key) || rows.set(key, []).get(key)).push(launch); }
  const head = by === 'packet' ? 'packetHash | role | stage | profile' : by;
  const lines = [
    `<!-- stats-compare launches=${all.length} generated=${nowIso} -->`,
    '# Launch comparison (advisory)', '',
    `Generated: ${nowIso} | launches: ${all.length} | scope: ${scope} | compared by: ${by}`,
    'Advisory only. Unknown tokens and findings are skipped, never imputed; success uses only known exit codes.', '',
    `| ${head} | launches | exit known | success rate | token n | avg tokens | findings n | avg findings |`,
    `|${'---|'.repeat(7 + KEYS_WIDTH[by])}`,
  ];
  for (const [key, group] of [...rows].sort((a, b) => a[0].localeCompare(b[0]))) {
    const exits = group.map(exitOf).filter(x => x !== null);
    const success = exits.filter(x => x === 0).length;
    const tokens = group.map(tokensOf).filter(x => x !== null);
    const findings = group.map(findingsOf).filter(x => x !== null);
    const average = xs => xs.length ? num(xs.reduce((a, b) => a + b, 0) / xs.length) : '-';
    lines.push(`| ${key} | ${group.length} | ${exits.length} | ${pct(success, exits.length)} | ${tokens.length} | ${average(tokens)} | ${findings.length} | ${average(findings)} |`);
  }
  return `${lines.join('\n')}\n`;
}

// The latest report is chosen by the generated time inside the marker, never by the file name:
// PROTO-DEC-0167 item 4 names the file, but names are not one sortable date format, so a plain
// lexicographic sort can rank an older report after a newer one. A file whose marker is missing or
// whose generated time does not parse is ignored with a warning; the file name is only a tie-breaker.
// Only a plain file counts as a report: a directory, a link or an unreadable entry is skipped with one warning, so one
// odd entry cannot break the `due` exit contract. A stats dir that exists but is not a readable directory throws an
// error carrying `usage = true`; main() turns it into exit 2.
function lastReport(dir) {
  if (!fs.existsSync(dir)) return null;
  let names;
  try {
    if (!fs.statSync(dir).isDirectory()) throw new Error(`stats dir is not a directory: ${dir}`);
    // sort() only makes the scan order stable; the winner is decided by the marker, never by the name order.
    names = fs.readdirSync(dir).filter(n => /^STATS-.*\.md$/.test(n)).sort();
  } catch (e) {
    const err = new Error(e.message.startsWith('stats dir is not') ? e.message : `stats dir unreadable: ${dir} (${e.code || 'error'})`);
    err.usage = true;
    throw err;
  }
  let best = null;
  for (const name of names) {
    let text;
    try {
      if (!fs.lstatSync(path.join(dir, name)).isFile()) { process.stderr.write(`[WARN] stats report ${name} is not a plain file (directory or link); ignored\n`); continue; }
      text = fs.readFileSync(path.join(dir, name), 'utf8');
    } catch (e) { process.stderr.write(`[WARN] stats report ${name} is unreadable (${e.code || 'error'}); ignored\n`); continue; }
    const m = MARKER.exec(text);
    if (!m) { process.stderr.write(`[WARN] stats report ${name} has no stats-report marker; ignored\n`); continue; }
    const generated = m[2];
    const ts = Date.parse(generated);
    if (!Number.isFinite(ts)) { process.stderr.write(`[WARN] stats report ${name} has an unparsable generated time; ignored\n`); continue; }
    if (!best || ts > best.ts || (ts === best.ts && name > best.file)) best = { file: name, launches: Number(m[1]), generated, ts };
  }
  return best ? { file: best.file, launches: best.launches, generated: best.generated } : null;
}

function parseArgs(argv) {
  const o = { journal: DEFAULT_JOURNAL, by: 'client', minN: 5, everyRecords: EVERY_RECORDS, everyDays: EVERY_DAYS, statsDir: DEFAULT_STATS_DIR, includePending: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const next = () => argv[++i];
    if (a === '--journal') o.journal = next();
    else if (a === '--include-pending') o.includePending = true;
    else if (a === '--pending') { o.includePending = true; o.pendingDir = next(); }
    else if (a === '--by') o.by = next();
    else if (a === '--min-n') o.minN = Number(next());
    else if (a === '--out') o.out = next();
    else if (a === '--now') o.now = next();
    else if (a === '--stats-dir') o.statsDir = next();
    else if (a === '--every-records') o.everyRecords = Number(next());
    else if (a === '--every-days') o.everyDays = Number(next());
    else return { error: `unknown argument ${a}` };
  }
  if (!KEYS[o.by]) return { error: `--by must be one of ${Object.keys(KEYS).join(', ')}` };
  if (![o.minN, o.everyRecords, o.everyDays].every(n => Number.isFinite(n) && n >= 1)) return { error: 'numeric options must be >= 1' };
  if (o.now && Number.isNaN(Date.parse(o.now))) return { error: '--now must be an ISO time' };
  return o;
}

function main(argv, deps = {}) {
  const cmd = argv[0];
  if (!['report', 'compare', 'due'].includes(cmd)) return usage('usage: launch-stats.cjs report|compare|due [options]');
  const o = parseArgs(argv.slice(1));
  if (o.error) return usage(o.error);
  if (!fs.existsSync(o.journal)) return usage(`journal not found: ${o.journal}`);
  let all;
  try { all = launches(load(o.journal, o.includePending, o.pendingDir)); } catch (e) { return usage(e.message); }
  const nowIso = new Date(o.now || Date.now()).toISOString();
  const scope = o.includePending ? 'journal + pending buffer' : 'journal';
  if (cmd === 'report' || cmd === 'compare') {
    if (cmd === 'compare' && o.by !== 'packet') return usage('compare currently requires --by packet');
    const text = cmd === 'compare' ? compare(all, o.by, nowIso, scope) : report(all, o.by, o.minN, nowIso, scope);
    if (!o.out) { process.stdout.write(text); return 0; }
    const plan = FORBIDDEN_OUT.some(re => re.test(o.out)) ? { problem: 'its spelling names it' } : outPlan(o.out, deps);
    if (plan.problem) return usage(`refusing to write into .ai/ or model-ladder.json (PROTO-DEC-0143 item 3): ${plan.problem}`);
    const hit = typeof o.out === 'string' && o.out.trim() ? inputHit(o.out, o, deps) : null;
    if (hit) return usage(`refusing to write the report over its own input (${hit}): the output names, or resolves to, the file or directory the report was read from; nothing was written`);
    const written = writeGuarded(plan, Buffer.from(text, 'utf8'));
    if (!written.ok) return usage(`refusing to write into .ai/ or model-ladder.json, or the shared path guard refused the write (PROTO-DEC-0143 item 3): ${written.reason}`);
    process.stdout.write(`wrote ${o.out} launches=${all.length}\n`);
    return 0;
  }
  let last;
  try { last = lastReport(o.statsDir); } catch (e) { if (e.usage) return usage(e.message); throw e; }
  if (!last) { process.stdout.write(`stats-due: YES (no report yet; ${all.length} launches). Run: node .ai/bin/accounting/launch-stats.cjs report --out docs/product/launch-records/launches/stats/STATS-<date>.md\n`); return 0; }
  const fresh = all.length - last.launches;
  const days = (Date.parse(nowIso) - Date.parse(last.generated)) / 86400000;
  const byCount = fresh >= o.everyRecords; const byTime = days >= o.everyDays && fresh >= 1;
  const why = [byCount ? `${fresh} new launches >= ${o.everyRecords}` : null, byTime ? `${num(days)} days >= ${o.everyDays}` : null].filter(Boolean).join('; ');
  process.stdout.write(`stats-due: ${why ? `YES (${why})` : 'no'} | last report ${last.file} (${last.generated}), ${fresh} new launches, ${num(days)} days ago\n`);
  return 0;
}

module.exports = { launches, load, readJsonl, summarize, report, compare, costOf, usageStats, usageBlock, lastReport, outPathProblem, outPlan, inputHit, writeGuarded, wallOf, exitOf, failureClassOf, tokensOf, findingsOf, usable, main };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

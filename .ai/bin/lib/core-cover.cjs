'use strict';
// Port of K2-THINAGENTS-COVER.cjs: map rows, substantive lines, anchor resolution,
// and conservative all-owners accounting. Semantic replay is explicitly advisory.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const textSafe = require('./text-safe.cjs');
const { readFileGuarded, realInside } = require('./path-safe.cjs');
const records = require('./records.cjs');
const { secretIn } = require('./secrets.cjs');
const HEADER = '| Id | Lines | Rule (short) | Home | Layer | Class | Note |';
const sha = text => crypto.createHash('sha256').update(text).digest('hex');
const substantive = text => text.split('\n').flatMap((line, i) => line.trim() && !/^#{1,6} /.test(line) && line !== '---' ? [i + 1] : []);
const references = home => [...home.matchAll(/\b(?:P-L\d-\d{3}|R-L\d-(?:\d{2,3}|[a-z-]+)(?:\.\d+)*|ROLE-[a-z-]+|SCHEMA-[a-z-]+|TOOL-[a-z-]+|S-\d{3})\b/g)].map(m => m[0]);
function read(root, rel) {
  if (typeof rel !== 'string' || path.isAbsolute(rel)) throw new Error('INPUT_UNREADABLE');
  const r = readFileGuarded(root, rel);
  if (!r.ok) throw new Error('INPUT_UNREADABLE');
  const d = textSafe.decode(r.bytes, { bom: 'refuse', crlf: 'normalise', invisible: 'refuse', finalNewline: 'refuse' });
  if (!d.ok || secretIn(d.text)) throw new Error('INPUT_UNREADABLE');
  return d.text;
}
function corpusFiles(root) {
  const out = [];
  function walk(rel) {
    const g = realInside(root, rel, { refuseHardlinks: true });
    if (!g.ok || g.type !== 'dir') throw new Error('INPUT_UNREADABLE');
    for (const e of fs.readdirSync(g.real, { withFileTypes: true }).sort((a, b) => records.cmp(a.name, b.name))) {
      const next = `${rel}/${e.name}`;
      if (e.isSymbolicLink()) throw new Error('INPUT_UNREADABLE');
      if (e.isDirectory()) walk(next);
      else if (/\.md$/i.test(e.name)) out.push(next);
    }
  }
  walk('.ai/core');
  return out;
}
function mapRows(text) {
  const lines = text.split('\n');
  const visible = textSafe.maskMarkdown(text).lines;
  const isMap = l => l && l.kinds.every(k => ['table', 'code-span'].includes(k));
  const hits = lines.flatMap((l, i) => l === HEADER && isMap(visible[i]) ? [i] : []);
  if (hits.length !== 1) return { rows: [], issue: 'MAP_HEADER_UNKNOWN' };
  const rows = [];
  const start = hits[0] + 2;
  if (!/^\|(?:[-: ]+\|){7}$/.test(lines[start - 1])) return { rows: [], issue: 'MAP_SEPARATOR_UNKNOWN' };
  for (let i = start; lines[i] && lines[i].startsWith('|'); i++) {
    const c = lines[i].split('|').map(s => s.trim());
    if (c.length !== 9 || !/^AR-\d{3}$/.test(c[1]) || !/^\d+(?:-\d+)?$/.test(c[2]) || !isMap(visible[i])) return { rows: [], issue: 'MAP_ROW_UNKNOWN' };
    const bounds = c[2].split('-').map(Number);
    if (bounds.length === 1) bounds.push(bounds[0]);
    if (!bounds.every(Number.isSafeInteger) || bounds[0] < 1 || bounds[1] < bounds[0]) return { rows: [], issue: 'MAP_RANGE_UNKNOWN' };
    rows.push({ id: c[1], lines: bounds, rule: c[3], home: c[4], line: i + 1, textSha: sha(lines[i]) });
  }
  if (!rows.length || new Set(rows.map(r => r.id)).size !== rows.length) return { rows: [], issue: 'MAP_DUPLICATE_OR_EMPTY' };
  return { rows, issue: null };
}
// Exclude record metadata and historical change log, but pin all other body text.
function obligationBody(rec) {
  const stop = rec.lines.findIndex((l, i) => i >= rec.bodyStart && l === '## Change log');
  return rec.lines.slice(rec.bodyStart, stop < 0 ? rec.lines.length : stop).join('\n');
}
function indexRecords(sources) {
  const ids = new Map();
  const duplicates = new Set();
  const add = (id, value) => { if (ids.has(id)) { duplicates.add(id); ids.delete(id); } else if (!duplicates.has(id)) ids.set(id, value); };
  for (const [rel, text] of Object.entries(sources).sort(([a], [b]) => records.cmp(a, b))) {
    const rec = records.parseRecord(rel, text);
    if (!rec.fm || rec.findings.length || typeof rec.fm.id !== 'string') continue;
    const visible = textSafe.maskMarkdown(text).lines;
    const bodySha = sha(obligationBody(rec));
    const isOwn = l => l && !l.masked && l.kinds.every(k => ['list-item', 'code-span'].includes(k));
    const structure = records.bodyStructure(rec);
    const ownSections = structure.headings.filter(h => h.name === 'Rules' && !visible[h.line - 1].masked && !visible[h.line - 1].partial && visible[h.line - 1].kinds.every(k => k === 'heading'));
    const own = ownSections.length === 1 ? structure.rules.filter(r => isOwn(visible[r.line - 1])) : [];
    const rules = own.map((r, i) => {
      // Continuations belong to this rule until the next rule, heading, or blank line.
      const from = r.line - 1;
      let end = from + 1;
      while (end < rec.lines.length && rec.lines[end].trim() && !/^##? |^(?:- )?R-L/.test(rec.lines[end]) && isOwn(visible[end])) end++;
      return { id: r.id, line: r.line, text: [records.ruleText(rec.lines[from]), ...rec.lines.slice(from + 1, end)].join('\n') };
    });
    const recordValue = { path: rel, line: rules[0]?.line || rec.bodyStart + 1, recordId: rec.fm.id, bodySha, rules };
    add(rec.fm.id, recordValue);
    for (const r of rules) add(r.id, { ...recordValue, line: r.line, rules: [r] });
  }
  return { ids, duplicates: [...duplicates].sort(records.cmp) };
}
const normal = text => text.trim().replace(/^(?:- |\d+\. )/, '').replace(/\s+/g, ' ');
function literal(text, refs, ids) {
  const value = normal(text);
  const candidates = refs.flatMap(id => ids.has(id) ? ids.get(id).rules.map(r => ({ id: r.id, path: ids.get(id).path, line: r.line, text: normal(r.text) })) : []);
  const full = candidates.filter(r => r.text === value);
  if (full.length) return { state: 'FULL', method: 'literal-obligation', anchors: full.map(({ text: ignored, ...r }) => r), reason: null };
  const clauses = value.split(/;\s+/);
  const some = clauses.length > 1 ? candidates.filter(r => clauses.includes(r.text)) : [];
  return { state: some.length ? 'PARTIAL' : 'NONE', method: 'literal-obligation', anchors: some.map(({ text: ignored, ...r }) => r), reason: some.length ? 'CLAUSES_WITHOUT_HOME' : 'NO_PROVEN_EQUIVALENT' };
}
function analyse({ agents, map, sources, assessment }) {
  const parsed = mapRows(map);
  const { ids, duplicates } = indexRecords(sources);
  const lines = agents.split('\n');
  const meaningful = substantive(agents);
  const visible = textSafe.maskMarkdown(agents).lines;
  const prior = new Map((assessment?.groups || []).map(g => [g.id, g]));
  const groups = [];
  const owners = new Map();
  for (const row of parsed.rows) {
    const g = prior.get(row.id);
    const sameMap = g && row.textSha === g.mapSha;
    const bounds = sameMap ? g.lines : row.lines;
    const slice = meaningful.filter(n => n >= bounds[0] && n <= bounds[1]);
    if (!slice.length || bounds[1] > lines.length - 1) continue;
    const sourceSame = sameMap && sha(lines.slice(bounds[0] - 1, bounds[1]).join('\n')) === g.sourceSha;
    const anchorsSame = sourceSame && g.anchors.every(a => ids.has(a.id) && ids.get(a.id).bodySha === a.bodySha && ids.get(a.id).recordId === a.recordId);
    let result;
    if (anchorsSame) {
      result = { state: g.state === 'covered' ? 'FULL' : g.state === 'missing' ? 'NONE' : 'PARTIAL', method: 'pinned-author-assessment', reason: g.state === 'changed' ? 'CHANGED_NOT_EQUIVALENT' : g.note,
        anchors: g.anchors.map(a => ({ id: a.id, path: ids.get(a.id).path, line: ids.get(a.id).line })) };
    } else {
      const ownText = slice.every(n => !visible[n - 1].masked && visible[n - 1].kinds.every(k => ['list-item', 'code-span'].includes(k)));
      result = ownText ? literal(slice.map(n => lines[n - 1]).join('\n'), references(row.home), ids) : { state: 'NONE', method: 'unknown', anchors: [], reason: 'NON_OWN_SOURCE' };
      if (sourceSame && !anchorsSame) result.reason = 'ANCHOR_DRIFT_OR_MISSING';
    }
    groups.push({ id: row.id, lines: bounds, mapLine: row.line, home: row.home, originalState: sourceSame ? g.state : null, ...result });
    for (const n of slice) owners.set(n, [...(owners.get(n) || []), groups[groups.length - 1]]);
  }
  // Seven author extensions exist outside the historical RULE-MAP. Use only against
  // the exact map identity; never invent extensions on a custom or malformed map.
  if (!parsed.issue && assessment && sha(map) === assessment.mapSha) {
    for (const g of assessment.groups.filter(g => g.mapSha === null)) {
      const slice = meaningful.filter(n => n >= g.lines[0] && n <= g.lines[1]);
      const same = sha(lines.slice(g.lines[0] - 1, g.lines[1]).join('\n')) === g.sourceSha && g.anchors.every(a => ids.has(a.id) && ids.get(a.id).bodySha === a.bodySha && ids.get(a.id).recordId === a.recordId);
      if (!same) continue;
      const group = { id: g.id, lines: g.lines, mapLine: null, home: null, originalState: g.state,
        state: g.state === 'covered' ? 'FULL' : g.state === 'missing' ? 'NONE' : 'PARTIAL', method: 'pinned-author-extension', reason: g.note,
        anchors: g.anchors.map(a => ({ id: a.id, path: ids.get(a.id).path, line: ids.get(a.id).line })) };
      groups.push(group);
      for (const n of slice) owners.set(n, [...(owners.get(n) || []), group]);
    }
  }
  const rows = meaningful.map(n => {
    const all = owners.get(n) || [];
    const state = !all.length || all.some(g => g.state === 'NONE') ? 'NONE' : all.every(g => g.state === 'FULL') ? 'FULL' : 'PARTIAL';
    const anchors = all.flatMap(g => g.anchors);
    return { line: n, state, groups: all.map(g => g.id), methods: [...new Set(all.map(g => g.method))],
      reason: all.length ? all.map(g => g.reason).filter(Boolean).join('; ') || null : parsed.issue || 'UNMAPPED_LINE',
      anchors: anchors.filter((a, i) => anchors.findIndex(b => b.id === a.id && b.path === a.path && b.line === a.line) === i) };
  });
  const totals = Object.fromEntries(['FULL', 'PARTIAL', 'NONE'].map(s => [s, rows.filter(r => r.state === s).length]));
  return { schema: 'core-cover/1', advisory: true, semanticCheck: 'pinned author judgement or exact literal obligation; unknown has no proven home',
    sourceSha: sha(agents), mapSha: sha(map), contentLines: meaningful.length, accountedLines: owners.size, totals,
    fullPercent: meaningful.length ? 100 * totals.FULL / meaningful.length : null,
    migrationReady: meaningful.length > 0 && totals.FULL === meaningful.length,
    mapIssue: parsed.issue, duplicateIds: duplicates, groups, rows };
}
function cover({ root, agents = 'AGENTS.md', map = '.ai/core/RULE-MAP.md' }) {
  const sources = Object.fromEntries(corpusFiles(root).map(rel => [rel, read(root, rel)]));
  // The shipped witness is an explicit author assessment, never a fresh implicit vote.
  const assessmentText = read(__dirname, 'core-cover-assessment.json');
  const assessment = textSafe.parseJsonUnique(assessmentText);
  if (sha(assessmentText) !== ASSESSMENT_SHA) throw new Error('INPUT_UNREADABLE');
  const result = analyse({ agents: read(root, agents), map: read(root, map), sources, assessment });
  if (secretIn(result)) throw new Error('INPUT_UNREADABLE');
  return result;
}
const ASSESSMENT_SHA = '43ee2361f38d45ee8be0688c33983f5d01d5d28eec20676d393dbc50a827a619';
function table(result) {
  const out = ['COVER advisory=true semantic=author-assessment-or-literal', '| Line | State | Groups | Record id and line |', '|---|---|---|---|'];
  for (const r of result.rows) out.push(`| ${r.line} | ${r.state} | ${r.groups.join(', ') || '-'} | ${r.anchors.map(a => `${a.id} (${a.path}:${a.line})`).join(', ') || '-'} |`);
  out.push(`TOTAL lines=${result.contentLines} FULL=${result.totals.FULL} PARTIAL=${result.totals.PARTIAL} NONE=${result.totals.NONE} fullPercent=${result.fullPercent === null ? 'unknown' : result.fullPercent} migrationReady=${result.migrationReady} exit=0`);
  if (result.mapIssue) out.push(`UNKNOWN reason=${result.mapIssue}`);
  return out.join('\n');
}
module.exports = { cover, analyse, mapRows, references, substantive, indexRecords, obligationBody, sha, table };
